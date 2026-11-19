//! Outbox relay: sends committed patches to JetStream in order within each feed, but a broker
//! disconnect mid-batch can let queued publishes overtake a failed one. Every instance runs a
//! candidate; the one holding the lease (store::lease) publishes. Delivered patches are marked done
//! after JetStream acknowledges them. A relay that dies or loses its lease in between leaves them to
//! the next one, which republishes them. JetStream drops copies by message ID within its
//! configured deduplication window.
//!
//! Rows with invalid feed keys are logged and marked done without publishing. On a per-publish
//! size refusal the relay publishes a reload marker and waits for its acknowledgement before
//! marking the row done. If the marker fails, the row stays pending without holding up the
//! other acknowledged rows. Patch bodies stay in Postgres until ordinary pruning.

use std::{
    collections::VecDeque,
    future::{poll_fn, Future},
    pin::pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::Poll,
    time::{Duration, Instant},
};

use async_nats::{
    jetstream::{
        self,
        context::{PublishError, PublishErrorKind},
        publish::PublishAck,
        response::Response,
    },
    Client, HeaderMap, Message, StatusCode, Subscriber,
};
use futures_util::{stream::SelectAll, StreamExt};
use sqlx::{postgres::PgListener, PgConnection, PgPool};

use crate::{store, valid_key, Error, Options, RELOAD_HEADER};

/// Outbox rows published per round trip.
const BATCH: i64 = 256;
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn subject(options: &Options, feed: &str) -> String {
    format!("{}.{feed}", options.subject_prefix)
}

/// Runs forever: wait for the lease, publish while holding it, then start over.
pub(crate) async fn run(pool: PgPool, publisher: Publisher, options: Arc<Options>, active: Arc<AtomicBool>) {
    loop {
        if let Err(e) = lead(&pool, &publisher, &options, &active).await {
            let error: &(dyn std::error::Error + 'static) = &*e;
            tracing::warn!(target: "corten::feed", instance = %options.instance, error, "relay standing by");
        }
        active.store(false, Ordering::Relaxed);
        tokio::time::sleep(options.lease / 4).await;
    }
}

/// The lease as held: renewed at `renewed`, which must stay within `stale` to keep publishing.
struct Held {
    conn: PgConnection,
    renewed: Instant,
    stale: Duration,
}

impl Held {
    /// Renews the lease; an error means another instance may now hold it.
    async fn renew(&mut self, options: &Options) -> Result<(), Error> {
        let started = Instant::now();
        let renewed = tokio::time::timeout(self.stale, store::lease(&mut self.conn, &options.instance, options.lease)).await;
        match renewed {
            Ok(Ok(true)) => {
                self.renewed = started;
                Ok(())
            }
            Ok(Ok(false)) => Err("lost the relay lease".into()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("renewing the relay lease timed out".into()),
        }
    }

    fn check(&self) -> Result<(), Error> {
        if self.renewed.elapsed() > self.stale {
            return Err("relay lease is stale".into());
        }
        Ok(())
    }
}

async fn lead(pool: &PgPool, publisher: &Publisher, options: &Options, active: &AtomicBool) -> Result<(), Error> {
    // A dedicated connection outside the pool: the lease names its backend pid.
    let mut conn = pool.acquire().await?.detach();
    while !store::lease(&mut conn, &options.instance, options.lease).await? {
        tokio::time::sleep(options.lease / 4).await;
    }
    let mut held = Held { conn, renewed: Instant::now(), stale: options.lease * 3 / 4 };
    active.store(true, Ordering::Relaxed);
    tracing::info!(target: "corten::feed", instance = %options.instance, "relay active");
    let result = publish(pool, publisher, options, &mut held).await;
    active.store(false, Ordering::Relaxed);
    let _ = store::release(&mut held.conn).await;
    result
}

async fn publish(pool: &PgPool, publisher: &Publisher, options: &Options, held: &mut Held) -> Result<(), Error> {
    let mut wake = PgListener::connect_with(pool).await?;
    wake.listen("corten_outbox").await?;
    loop {
        drain(pool, publisher, options, held).await?;
        tokio::select! {
            n = wake.recv() => { n?; }
            // Renew on time even when idle; also a safety net for a lost notification.
            _ = tokio::time::sleep(options.lease / 4) => {}
        }
        if held.renewed.elapsed() >= options.lease / 4 {
            held.renew(options).await?;
        }
    }
}

/// Publishes pending rows oldest first, pipelining up to `BATCH` acknowledgements.
async fn drain(pool: &PgPool, publisher: &Publisher, options: &Options, held: &mut Held) -> Result<(), Error> {
    loop {
        if held.renewed.elapsed() >= options.lease / 4 {
            held.renew(options).await?;
        }
        let rows = store::pending(pool, BATCH).await?;
        if rows.is_empty() {
            return Ok(());
        }
        held.check()?;
        let mut replies = Replies::new(publisher);
        let mut awaiting = Vec::with_capacity(rows.len());
        let mut sent = Vec::with_capacity(rows.len());
        let mut refused = Vec::new();
        for row in &rows {
            if !valid_key(&row.feed) {
                refused.push((row, Refusal::InvalidKey));
                continue;
            }
            let slot = awaiting.len();
            awaiting.push(None);
            match replies.send(options, row, false, slot).await {
                Ok(()) => awaiting[slot] = Some(row),
                Err(error) if error.kind() == PublishErrorKind::MaxPayloadExceeded => {
                    refused.push((row, Refusal::Cached(error)));
                }
                Err(error) => return Err(error.into()),
            }
        }
        let deadline = tokio::time::Instant::now() + publisher.timeout;
        for _ in 0..awaiting.iter().flatten().count() {
            let (row, ack) = replies.recv(&mut awaiting, deadline).await?;
            match ack {
                Ok(_) => sent.push(row.id),
                Err(error) if stream_size_refusal(&error) => refused.push((row, Refusal::Stream)),
                Err(error) => return Err(error.into()),
            }
        }
        drop(replies);
        if refused.is_empty() {
            store::mark_published(pool, &sent).await?;
        } else {
            finish_refusals(pool, publisher, options, held, &mut sent, refused).await?;
        }
        if (rows.len() as i64) < BATCH || sent.is_empty() {
            // A full batch with nothing retired would only select the same rows again.
            return Ok(());
        }
    }
}

pub(crate) struct Publisher {
    js: jetstream::Context,
    client: Client,
    timeout: Duration,
    isolate_replies: AtomicBool,
    #[cfg(test)]
    pub(crate) pause_before: Vec<(i64, Arc<tokio::sync::Semaphore>)>,
}

impl Publisher {
    pub(crate) fn new(js: jetstream::Context) -> Self {
        Self {
            client: js.client(),
            js,
            timeout: PUBLISH_TIMEOUT,
            isolate_replies: AtomicBool::new(false),
            #[cfg(test)]
            pause_before: Vec::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

// async-nats 0.53 keeps unanswered publish requests in the connection's reply map. Use a
// fresh inbox per batch and let Subscriber::drop unsubscribe on every exit, including
// cancellation. A reply's slot identifies the publish even if replies arrive out of order.
struct Replies<'a> {
    publisher: &'a Publisher,
    inbox: String,
    subscriptions: ReplySubscriptions,
    buffered: VecDeque<Message>,
    had_reply: bool,
}

enum ReplySubscriptions {
    Shared(Option<Subscriber>),
    Isolated(SelectAll<Subscriber>),
}

impl ReplySubscriptions {
    async fn next(&mut self) -> Option<Message> {
        match self {
            Self::Shared(Some(subscription)) => subscription.next().await,
            Self::Shared(None) => None,
            Self::Isolated(subscriptions) => subscriptions.next().await,
        }
    }
}

impl<'a> Replies<'a> {
    fn new(publisher: &'a Publisher) -> Self {
        let subscriptions = if publisher.isolate_replies.load(Ordering::Relaxed) {
            ReplySubscriptions::Isolated(SelectAll::new())
        } else {
            ReplySubscriptions::Shared(None)
        };
        Self { publisher, inbox: publisher.client.new_inbox(), subscriptions, buffered: VecDeque::new(), had_reply: false }
    }

    async fn send(&mut self, options: &Options, row: &store::Pending, reload: bool, slot: usize) -> Result<(), PublishError> {
        let reply = format!("{}.{slot}", self.inbox);
        let publisher = self.publisher;
        let subject = match &self.subscriptions {
            ReplySubscriptions::Shared(None) => Some(format!("{}.*", self.inbox)),
            ReplySubscriptions::Shared(Some(_)) => None,
            ReplySubscriptions::Isolated(_) => Some(reply.clone()),
        };
        let deadline = tokio::time::Instant::now() + publisher.timeout;
        if let Some(subject) = subject {
            let subscription = tokio::time::timeout_at(deadline, publisher.client.subscribe(subject))
                .await
                .map_err(|error| PublishError::with_source(PublishErrorKind::TimedOut, error))?
                .map_err(|error| PublishError::with_source(PublishErrorKind::Other, error))?;
            match &mut self.subscriptions {
                ReplySubscriptions::Shared(shared) => *shared = Some(subscription),
                ReplySubscriptions::Isolated(subscriptions) => subscriptions.push(subscription),
            }
        }
        let mut send = pin!(async {
            #[cfg(test)]
            let (_permit, deadline) = match publisher.pause_before.iter().find(|(id, _)| *id == row.id) {
                Some((_, gate)) => (gate.acquire().await.ok(), tokio::time::Instant::now() + publisher.timeout),
                None => (None, deadline),
            };
            tokio::time::timeout_at(deadline, enqueue(publisher, options, row, reload, reply))
                .await
                .map_err(|error| PublishError::with_source(PublishErrorKind::TimedOut, error))?
        });
        let ReplySubscriptions::Shared(Some(subscription)) = &mut self.subscriptions else { return send.await };
        // Only the shared queue can overflow with one reply per publish.
        loop {
            tokio::select! {
                biased;
                Some(reply) = subscription.next(), if self.buffered.len() < BATCH as usize => {
                    self.buffered.push_back(reply);
                }
                result = &mut send => return result,
            }
        }
    }

    async fn recv<T>(
        &mut self,
        awaiting: &mut [Option<T>],
        deadline: tokio::time::Instant,
    ) -> Result<(T, Result<PublishAck, PublishError>), Error> {
        let result = tokio::time::timeout_at(deadline, async {
            while let Some(reply) = match self.buffered.pop_front() {
                Some(reply) => Some(reply),
                None => self.subscriptions.next().await,
            } {
                let slot = reply.subject.as_str().rsplit_once('.').and_then(|(_, slot)| slot.parse::<usize>().ok());
                if let Some(row) = slot.and_then(|slot| awaiting.get_mut(slot)).and_then(Option::take) {
                    return Ok((row, acknowledgement(reply)));
                }
            }
            Err(PublishError::new(PublishErrorKind::BrokenPipe).into())
        })
        .await;
        match result {
            Ok(reply) => {
                self.had_reply |= reply.is_ok();
                reply
            }
            Err(error) => {
                // Capacity is private to async-nats. Overflow on a fresh inbox lets at
                // least one reply through; don't let the same burst stall every retry.
                if self.had_reply {
                    self.publisher.isolate_replies.store(true, Ordering::Relaxed);
                }
                Err(error.into())
            }
        }
    }
}

async fn enqueue(
    publisher: &Publisher,
    options: &Options,
    row: &store::Pending,
    reload: bool,
    reply: String,
) -> Result<(), PublishError> {
    let mut headers = HeaderMap::new();
    headers.insert("Nats-Msg-Id", format!("{}:{}:{}", row.feed, row.generation, row.seq).as_str());
    headers.insert("Feed-Generation", row.generation.as_str());
    let body = if reload {
        headers.insert(RELOAD_HEADER, row.seq.to_string().as_str());
        Default::default()
    } else {
        row.body.clone().into()
    };
    publisher.client.publish_with_reply_and_headers(subject(options, &row.feed), reply, headers, body).await.map_err(|error| {
        let kind = if error.kind() == async_nats::client::PublishErrorKind::MaxPayloadExceeded {
            PublishErrorKind::MaxPayloadExceeded
        } else {
            PublishErrorKind::Other
        };
        PublishError::with_source(kind, error)
    })
}

fn acknowledgement(reply: Message) -> Result<PublishAck, PublishError> {
    if reply.status == Some(StatusCode::NO_RESPONDERS) {
        return Err(PublishError::new(PublishErrorKind::StreamNotFound));
    }
    match serde_json::from_slice(&reply.payload).map_err(|error| PublishError::with_source(PublishErrorKind::Other, error))? {
        Response::Ok(ack) => Ok(ack),
        Response::Err { error } => Err(PublishError::with_source(PublishErrorKind::Other, error)),
    }
}

fn stream_size_refusal(error: &PublishError) -> bool {
    std::error::Error::source(error)
        .and_then(|source| source.downcast_ref::<jetstream::Error>())
        .is_some_and(|source| source.error_code() == jetstream::ErrorCode::STREAM_MESSAGE_EXCEEDS_MAXIMUM)
}

enum Refusal {
    InvalidKey,
    Cached(PublishError),
    Stream,
}

fn marker_publish_failed(options: &Options, row: &store::Pending, error: impl std::fmt::Display) {
    tracing::warn!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?row.feed,
        %error, "reload marker publish failed; outbox row remains pending");
}

fn marker_size_refused(options: &Options, row: &store::Pending, stream_limit: Option<i32>, error: &PublishError) {
    // NATS header framing and names (including the two ID separators) use 65 bytes.
    // The generation and sequence occur twice each.
    let marker_bytes = row.feed.len() + 65 + 2 * (row.generation.len() + row.seq.to_string().len());
    tracing::error!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?row.feed,
        marker_bytes, stream = %options.stream, stream_max_message_size = stream_limit, %error,
        "reload marker refused for size; outbox row remains pending");
}

async fn poll_send_before<T>(deadline: tokio::time::Instant, send: impl Future<Output = T>) -> Option<T> {
    let mut send = pin!(send);
    // timeout_at polls its inner future first, even if the deadline has passed.
    tokio::time::timeout_at(
        deadline,
        poll_fn(|cx| {
            if tokio::time::Instant::now() >= deadline {
                return Poll::Ready(None);
            }
            send.as_mut().poll(cx).map(Some)
        }),
    )
    .await
    .ok()
    .flatten()
}

async fn finish_refusals(
    pool: &PgPool,
    publisher: &Publisher,
    options: &Options,
    held: &mut Held,
    sent: &mut Vec<i64>,
    refused: Vec<(&store::Pending, Refusal)>,
) -> Result<(), Error> {
    held.check()?;
    if held.renewed.elapsed() >= options.lease / 4 {
        held.renew(options).await?;
    }
    // Pipeline the markers too, but bound the whole attempt to leave time to retire
    // acknowledgements before the lease gets stale, even if a marker gets no reply.
    let deadline = (held.renewed + options.lease / 2).into();
    let mut replies = Replies::new(publisher);
    let mut markers = Vec::new();
    let mut completed = Vec::new();
    for (row, refusal) in refused {
        if matches!(refusal, Refusal::InvalidKey) {
            sent.push(row.id);
            completed.push((row, refusal, false));
            continue;
        }
        held.check()?;
        let slot = markers.len();
        markers.push(None);
        match poll_send_before(deadline, replies.send(options, row, true, slot)).await {
            Some(Ok(())) => markers[slot] = Some((row, refusal)),
            Some(Err(error)) if error.kind() == PublishErrorKind::MaxPayloadExceeded => {
                marker_size_refused(options, row, None, &error);
            }
            Some(Err(error)) => marker_publish_failed(options, row, error),
            None => marker_publish_failed(options, row, "deadline has elapsed"),
        }
    }
    let mut stream_failed_markers = Vec::new();
    for _ in 0..markers.iter().flatten().count() {
        // Unlike sends, an already-ready acknowledgement is useful even at the deadline.
        match replies.recv(&mut markers, deadline).await {
            Ok(((row, refusal), Ok(ack))) => {
                sent.push(row.id);
                completed.push((row, refusal, ack.duplicate));
            }
            Ok(((row, _), Err(error))) if stream_size_refusal(&error) => stream_failed_markers.push((row, error)),
            Ok(((row, _), Err(error))) => marker_publish_failed(options, row, error),
            Err(error) => {
                for (row, _) in markers.into_iter().flatten() {
                    marker_publish_failed(options, row, &error);
                }
                break;
            }
        }
    }
    drop(replies);
    // 10054 does not carry the limit. Look it up once for diagnostics only.
    let stream_limit =
        if !stream_failed_markers.is_empty() || completed.iter().any(|(_, refusal, _)| matches!(refusal, Refusal::Stream)) {
            let budget = (options.lease / 8).min(held.stale.saturating_sub(held.renewed.elapsed()));
            tokio::time::timeout(budget, publisher.js.get_stream(&options.stream))
                .await
                .ok()
                .and_then(Result::ok)
                .map(|stream| stream.cached_info().config.max_message_size)
        } else {
            None
        };
    for (row, error) in stream_failed_markers {
        marker_size_refused(options, row, stream_limit, &error);
    }
    if sent.is_empty() {
        return Ok(());
    }
    held.check()?;
    let mut retired = store::mark_published_returning(pool, sent).await?;
    retired.sort_unstable();
    for (row, refusal, duplicate) in completed {
        if retired.binary_search(&row.id).is_err() {
            continue;
        }
        let (reason, error) = match refusal {
            Refusal::InvalidKey => {
                tracing::error!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?row.feed,
                    "dropped outbox row with invalid feed key");
                continue;
            }
            Refusal::Cached(error) => ("refused by the connection's cached limit", Some(error)),
            Refusal::Stream => ("JetStream size refusal (10054)", None),
        };
        let outcome = if duplicate {
            "duplicate reload marker acknowledgement (already accepted notification, kind unknown)"
        } else {
            "published reload marker"
        };
        tracing::error!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?row.feed,
            patch_bytes = row.body.len(), stream = %options.stream, stream_max_message_size = stream_limit,
            error = error.as_ref().map(tracing::field::display), "{outcome}: {reason}; patch kept for inspection");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_expired_marker_deadline_does_not_attempt_a_publish() {
        let deadline = tokio::time::Instant::now() - Duration::from_millis(1);
        let mut publishes = 0;
        poll_send_before(deadline, async { publishes += 1 }).await;
        assert_eq!(publishes, 0);
    }
}
