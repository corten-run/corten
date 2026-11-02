//! The feeds this instance serves. A feed is loaded from Postgres on first use and then follows
//! the JetStream subject the relay publishes it to.
//!
//! No patch is missed between the load and the stream: this instance's consumer starts (at "new
//! messages only") before any feed loads. A patch published before a load began was committed
//! before it, so the load's rows include it; a patch that arrives while a load runs is buffered and
//! applied after it, and `Feed::apply` drops the ones the load already had. A gap (a lost message,
//! a consumer restart) reloads the feed and tells its live clients to resync.
//!
//! A load also reads the feed's last `REPLAY` patches from the outbox into the replay log, so an
//! instance that loads a feed late (it just restarted, and its peer died) still resumes the cursors
//! clients bring from that peer instead of sending all of them back for a snapshot.
//!
//! A feed nobody has read for `Options::idle_unload` (no live stream open, no snapshot asked
//! for) is dropped, so one feed per entity (an item's live price, an order's status) does not
//! keep every entity ever viewed in memory. The next request loads it again, replay log included.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use async_nats::jetstream::{
    self,
    consumer::{pull::OrderedConfig, DeliverPolicy},
    stream,
};
use corten::feed::{ApplyError, Feed, REPLAY};
use futures_util::StreamExt;
use sqlx::PgPool;
use tokio::sync::watch;

use crate::{store, Error, Options, Source};

struct Message {
    generation: String,
    json: String,
}

enum Slot<T: corten::feed::Row> {
    /// Loading from Postgres. Patches that arrive meanwhile wait in `buffer`. `current` is the
    /// feed being reloaded, if any; requests keep using it until the reload resets it.
    Loading {
        buffer: Vec<Message>,
        done: watch::Sender<bool>,
        current: Option<Feed<T>>,
    },
    Ready(Feed<T>),
}

pub(crate) struct Hub<S: Source> {
    pool: PgPool,
    source: S,
    options: Arc<Options>,
    slots: Mutex<HashMap<String, Slot<S::Row>>>,
    /// Ready feeds with no subscribers, and since when. Locked after `slots`.
    idle: Mutex<HashMap<String, Instant>>,
}

impl<S: Source> Hub<S> {
    pub fn new(pool: PgPool, source: S, options: Arc<Options>) -> Arc<Self> {
        Arc::new(Hub { pool, source, options, slots: Mutex::new(HashMap::new()), idle: Mutex::new(HashMap::new()) })
    }

    fn slots(&self) -> MutexGuard<'_, HashMap<String, Slot<S::Row>>> {
        self.slots.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The feed for `key`, loading it on first use.
    pub async fn feed(self: &Arc<Self>, key: &str) -> Result<Option<Feed<S::Row>>, Error> {
        loop {
            enum Next {
                Wait(watch::Receiver<bool>),
                Load,
            }
            let next = {
                let mut slots = self.slots();
                match slots.get(key) {
                    Some(Slot::Ready(feed)) | Some(Slot::Loading { current: Some(feed), .. }) => {
                        self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
                        return Ok(Some(feed.clone()));
                    }
                    Some(Slot::Loading { done, .. }) => Next::Wait(done.subscribe()),
                    None => {
                        let (done, _) = watch::channel(false);
                        slots.insert(key.to_string(), Slot::Loading { buffer: Vec::new(), done, current: None });
                        Next::Load
                    }
                }
            };
            match next {
                // Its own task, so the load finishes (and its waiters get the feed) even if this
                // request goes away first.
                Next::Load => {
                    let (hub, key) = (self.clone(), key.to_string());
                    return match tokio::spawn(async move { hub.load(key).await }).await {
                        Ok(loaded) => loaded,
                        Err(e) if e.is_panic() => Err("loading the feed panicked".into()),
                        Err(e) => Err(e.into()),
                    };
                }
                // Loaded, or the load failed and the slot is gone; either way look again.
                Next::Wait(mut wait) => {
                    let _ = wait.wait_for(|loaded| *loaded).await;
                }
            }
        }
    }

    /// Loads (or reloads) `key` into its `Loading` slot, then applies what arrived meanwhile.
    ///
    /// The hub's lock is held only to read and change the slot map. Building the feed from its rows
    /// and backfilling its replay log take time in proportion to the feed, so they run on a
    /// blocking thread, outside that lock (every request on the instance takes it to find its
    /// feed) and off the worker threads requests run on. The slot stays `Loading` until the buffer
    /// is empty under the lock, so a patch that arrives while the buffer is drained is buffered too,
    /// and the patches are applied in the order they came. If the load does not finish (reading
    /// the rows failed, or building the feed panicked), [`Unfinished`] puts the slot back.
    async fn load(self: &Arc<Self>, key: String) -> Result<Option<Feed<S::Row>>, Error> {
        let mut unfinished = Unfinished { hub: self.clone(), key: Some(key.clone()), retry: false };
        let loaded = store::load(&self.pool, &self.source, &key, REPLAY).await;
        let (loaded, current) = {
            let mut slots = self.slots();
            match loaded {
                Ok(Some(loaded)) => {
                    let Some(Slot::Loading { current, .. }) = slots.get(&key) else {
                        unreachable!("only load() leaves the Loading state")
                    };
                    (loaded, current.clone())
                }
                Ok(None) => {
                    unfinished.key = None;
                    let Some(Slot::Loading { done, current, .. }) = slots.remove(&key) else {
                        unreachable!("only load() leaves the Loading state")
                    };
                    drop(slots);
                    let _ = done.send(true);
                    if let Some(old) = current {
                        // The feed was deleted; its clients resync and get 404. Its rows are freed
                        // off the workers.
                        tokio::task::spawn_blocking(move || old.reset(0, []));
                    }
                    return Ok(None);
                }
                Err(e) => {
                    drop(slots);
                    // Keeps serving the old rows, if any, and tries again shortly.
                    unfinished.retry = true;
                    drop(unfinished);
                    return Err(e);
                }
            }
        };
        // A feed of another generation replaces `current`, which is reset once the new one is in
        // its slot, so no request is handed the old one emptied.
        let instance = self.options.instance.clone();
        let log_key = key.clone();
        let built = tokio::task::spawn_blocking(move || {
            let (feed, replaced) = match current {
                Some(feed) if feed.generation() == loaded.generation => {
                    feed.reset(loaded.seq, loaded.rows);
                    (feed, None)
                }
                other => (Feed::follow(loaded.generation, loaded.seq, loaded.rows), other),
            };
            if let Err(e) = feed.backfill(loaded.recent) {
                eprintln!("hub {instance}: {log_key}: no replay log from the outbox: {e}");
            }
            (feed, replaced)
        })
        .await;
        // A panic while building; `unfinished` puts the slot back as it was.
        let (feed, replaced) = match built {
            Ok(built) => built,
            Err(e) if e.is_panic() => return Err(format!("building feed {key} panicked").into()),
            Err(e) => return Err(e.into()),
        };
        let mut gap = false;
        let done = loop {
            let buffered = {
                let mut slots = self.slots();
                let Some(Slot::Loading { buffer, .. }) = slots.get_mut(&key) else {
                    unreachable!("only load() leaves the Loading state")
                };
                if buffer.is_empty() {
                    unfinished.key = None;
                    let Some(Slot::Loading { done, .. }) = slots.insert(key.clone(), Slot::Ready(feed.clone())) else {
                        unreachable!("only load() leaves the Loading state")
                    };
                    break done;
                }
                std::mem::take(buffer)
            };
            for message in buffered {
                gap |= !self.apply(&feed, &key, &message);
            }
        };
        let _ = done.send(true);
        if let Some(old) = replaced {
            // Its clients resync onto the new generation; its rows are freed off the workers.
            tokio::task::spawn_blocking(move || old.reset(0, []));
        }
        if gap {
            self.clone().reload_later(key);
        }
        Ok(Some(feed))
    }

    /// A patch from JetStream for feed `key`. It is applied outside the hub's lock (parsing and
    /// applying it take time in proportion to the patch); one consumer task delivers the messages
    /// one at a time, so they are still applied in order.
    fn on_message(self: &Arc<Self>, key: &str, message: Message) {
        let feed = match self.slots().get_mut(key) {
            None => return, // not loaded here; a later load reads it from Postgres
            Some(Slot::Loading { buffer, .. }) => return buffer.push(message),
            Some(Slot::Ready(feed)) => feed.clone(),
        };
        if self.apply(&feed, key, &message) {
            return;
        }
        // Only the feed the patch did not fit: meanwhile a reload (or an unload and a new load) may
        // have put another in the slot, which has its own rows.
        let mut slots = self.slots();
        if matches!(slots.get(key), Some(Slot::Ready(now)) if same(now, &feed)) {
            self.start_reload(&mut slots, key);
        }
    }

    /// Applies one patch. False means the feed needs a reload (a gap or another generation).
    fn apply(&self, feed: &Feed<S::Row>, key: &str, message: &Message) -> bool {
        if message.generation != feed.generation() {
            return false;
        }
        match feed.apply(&message.json) {
            Ok(_) => true,
            Err(e @ ApplyError::Gap { .. }) => {
                eprintln!("hub {}: {key}: {e}", self.options.instance);
                false
            }
            Err(e) => {
                eprintln!("hub {}: {key}: dropping {e}", self.options.instance);
                true
            }
        }
    }

    /// Moves a ready feed to `Loading` and reloads it in the background.
    fn start_reload(self: &Arc<Self>, slots: &mut HashMap<String, Slot<S::Row>>, key: &str) {
        let Some(Slot::Ready(feed)) = slots.remove(key) else { return };
        let (done, _) = watch::channel(false);
        slots.insert(key.to_string(), Slot::Loading { buffer: Vec::new(), done, current: Some(feed) });
        let hub = self.clone();
        let key = key.to_string();
        tokio::spawn(async move {
            if let Err(e) = hub.load(key.clone()).await {
                eprintln!("hub {}: reloading {key} failed: {e}", hub.options.instance);
            }
        });
    }

    fn reload_later(self: Arc<Self>, key: String) {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let mut slots = self.slots();
            self.start_reload(&mut slots, &key);
        });
    }

    /// Reloads every ready feed (after the consumer restarted and may have missed patches).
    fn reload_all(self: &Arc<Self>) {
        let mut slots = self.slots();
        let keys: Vec<String> = slots.iter().filter(|(_, s)| matches!(s, Slot::Ready(_))).map(|(k, _)| k.clone()).collect();
        for key in keys {
            self.start_reload(&mut slots, &key);
        }
    }

    /// Drops ready feeds that have had no subscribers and no reads for `after`. A feed is marked
    /// idle on the first sweep that finds it unused and dropped on a later one, so it goes between
    /// `after` and `after` plus one sweep period after its last use.
    pub fn unload_idle(&self, after: Duration) -> usize {
        let now = Instant::now();
        let mut slots = self.slots();
        let mut idle = self.idle.lock().unwrap_or_else(|e| e.into_inner());
        idle.retain(|key, _| matches!(slots.get(key), Some(Slot::Ready(_))));
        let mut unload = Vec::new();
        for (key, slot) in slots.iter() {
            let Slot::Ready(feed) = slot else { continue };
            if feed.subscribers() > 0 {
                idle.remove(key);
            } else if idle.get(key).is_some_and(|since| now.duration_since(*since) >= after) {
                unload.push(key.clone());
            } else {
                idle.entry(key.clone()).or_insert(now);
            }
        }
        let mut unloaded = Vec::with_capacity(unload.len());
        for key in &unload {
            unloaded.extend(slots.remove(key));
            idle.remove(key);
        }
        // Freeing a large feed's rows takes a while: not under the locks, nor on a worker.
        drop((idle, slots));
        if !unloaded.is_empty() {
            match tokio::runtime::Handle::try_current() {
                Ok(runtime) => drop(runtime.spawn_blocking(move || drop(unloaded))),
                Err(_) => drop(unloaded),
            }
        }
        unload.len()
    }

    /// Reloads `key` as a gap would; the receiver turns true when the reload is done.
    #[cfg(test)]
    pub fn reload(self: &Arc<Self>, key: &str) -> Option<watch::Receiver<bool>> {
        let mut slots = self.slots();
        self.start_reload(&mut slots, key);
        match slots.get(key) {
            Some(Slot::Loading { done, .. }) => Some(done.subscribe()),
            _ => None,
        }
    }

    /// Patches waiting for `key`'s load to finish.
    #[cfg(test)]
    pub fn buffered(&self, key: &str) -> usize {
        match self.slots().get(key) {
            Some(Slot::Loading { buffer, .. }) => buffer.len(),
            _ => 0,
        }
    }

    pub fn stats(&self) -> Vec<(String, u64, usize)> {
        let slots = self.slots();
        let mut out: Vec<_> = slots
            .iter()
            .filter_map(|(k, s)| match s {
                Slot::Ready(f) => Some((k.clone(), f.seq(), f.subscribers())),
                Slot::Loading { .. } => None,
            })
            .collect();
        out.sort();
        out
    }
}

/// Whether two handles are one feed. A feed's generation is a string it owns, so while both
/// handles live, the same address means the same feed. (Two feeds with an empty generation look
/// the same; the cost is one reload too many.)
fn same<T: corten::feed::Row>(a: &Feed<T>, b: &Feed<T>) -> bool {
    std::ptr::eq(a.generation(), b.generation())
}

/// A load that has not finished: dropped (reading the rows failed, building the feed panicked, or
/// the runtime is shutting down), it puts the slot back so the feed is not stuck `Loading`. A
/// reload goes back to the feed it was reloading, and tries again shortly when `retry` (a failed
/// read; a build that panicked would panic again, so the next gap tries); a first load's slot is
/// removed, so the next request loads it. Its waiters wake either way. `key` is `None` once the
/// load has put its own result in the slot.
struct Unfinished<S: Source> {
    hub: Arc<Hub<S>>,
    key: Option<String>,
    retry: bool,
}

impl<S: Source> Drop for Unfinished<S> {
    fn drop(&mut self) {
        let Some(key) = self.key.take() else { return };
        let mut slots = self.hub.slots();
        let Some(Slot::Loading { done, current, .. }) = slots.remove(&key) else { return };
        let reload = current.is_some() && self.retry;
        if let Some(feed) = current {
            slots.insert(key.clone(), Slot::Ready(feed));
        }
        drop(slots);
        let _ = done.send(true);
        if reload && tokio::runtime::Handle::try_current().is_ok() {
            self.hub.clone().reload_later(key);
        }
    }
}

/// Creates the stream if needed and starts this instance's consumer. Returns once the consumer
/// exists, so feeds loaded afterwards cannot miss a patch.
pub(crate) async fn start<S: Source>(hub: Arc<Hub<S>>, js: jetstream::Context) -> Result<(), Error> {
    let mut messages = subscribe(&js, &hub.options).await?;
    let prefix = format!("{}.", hub.options.subject_prefix);
    tokio::spawn(async move {
        loop {
            while let Some(next) = messages.next().await {
                match next {
                    Ok(msg) => {
                        let Some(key) = msg.subject.as_str().strip_prefix(prefix.as_str()) else { continue };
                        let generation = msg
                            .headers
                            .as_ref()
                            .and_then(|h| h.get("Feed-Generation"))
                            .map(|v| v.as_str().to_string())
                            .unwrap_or_default();
                        let Ok(json) = String::from_utf8(msg.payload.to_vec()) else { continue };
                        hub.on_message(key, Message { generation, json });
                    }
                    Err(e) => {
                        eprintln!("hub {}: consumer error: {e}", hub.options.instance);
                        break;
                    }
                }
            }
            // The ordered consumer gave up; start a new one and reload what it may have missed.
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                match subscribe(&js, &hub.options).await {
                    Ok(next) => {
                        messages = next;
                        hub.reload_all();
                        break;
                    }
                    Err(e) => eprintln!("hub {}: resubscribing: {e}", hub.options.instance),
                }
            }
        }
    });
    Ok(())
}

async fn subscribe(js: &jetstream::Context, options: &Options) -> Result<jetstream::consumer::pull::Ordered, Error> {
    let subjects = format!("{}.>", options.subject_prefix);
    let stream = js
        .get_or_create_stream(stream::Config {
            name: options.stream.clone(),
            subjects: vec![subjects.clone()],
            max_age: options.max_age,
            duplicate_window: options.duplicate_window,
            ..Default::default()
        })
        .await?;
    let consumer = stream
        .create_consumer(OrderedConfig { filter_subject: subjects, deliver_policy: DeliverPolicy::New, ..Default::default() })
        .await?;
    Ok(consumer.messages().await?)
}

/// Unloads idle feeds every half `after`, for as long as the process runs.
pub(crate) async fn unload_idle<S: Source>(hub: Arc<Hub<S>>, after: Duration) {
    let mut tick = tokio::time::interval((after / 2).max(Duration::from_millis(10)));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        hub.unload_idle(after);
    }
}
