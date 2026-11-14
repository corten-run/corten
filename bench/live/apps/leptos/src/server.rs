use crate::{Change, Listing, Snapshot, Work, shell};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{StatusCode, header},
    response::sse::{Event, Sse},
    routing::{get, post},
};
use futures::Stream;
use leptos::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};
use tokio::sync::mpsc;

#[derive(Clone, Default)]
pub struct Shared(pub Arc<Mutex<Store>>);

pub struct Store {
    rows: Vec<Listing>,
    through: u64,
    history: VecDeque<Change>,
    readers: HashMap<u64, Reader>,
    next_reader: u64,
    queue_limit: usize,
    history_limit: usize,
    queue_peak: usize,
    history_peak: usize,
    reads: u64,
    bytes: u64,
    held: bool,
    drop_seq: Option<u64>,
}

struct Reader {
    tx: mpsc::Sender<Change>,
    rx: mpsc::Receiver<Change>,
    replay: VecDeque<Change>,
    ready: Option<Value>,
    overflow: Option<Value>,
    waker: Option<Waker>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            rows: vec![],
            through: 0,
            history: VecDeque::new(),
            readers: HashMap::new(),
            next_reader: 0,
            queue_limit: 2,
            history_limit: 4,
            queue_peak: 0,
            history_peak: 0,
            reads: 0,
            bytes: 0,
            held: false,
            drop_seq: None,
        }
    }
}

fn bad() -> StatusCode {
    StatusCode::BAD_REQUEST
}
fn text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}
const MAX_SAFE: u64 = 9_007_199_254_740_991;
fn valid_row(row: &Listing) -> bool {
    text(&row.id) && row.version <= MAX_SAFE && row.price_cents <= MAX_SAFE && row.quantity <= MAX_SAFE
}

impl Store {
    fn resources(&self) -> Value {
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let kb = |key: &str| {
            status
                .lines()
                .find_map(|line| line.strip_prefix(key)?.split_whitespace().next()?.parse::<u64>().ok())
                .map(|n| n * 1024)
        };
        let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
        let fields: Vec<_> = stat.rsplit_once(") ").map(|(_, tail)| tail.split_whitespace().collect()).unwrap_or_default();
        json!({"subscriptions":self.readers.len(),"connections":self.readers.len(),"pendingTasks":self.readers.len(),
            "queueLimit":self.queue_limit,"queueEvents":self.readers.values().map(|r|r.rx.len()).sum::<usize>(),"queuePeak":self.queue_peak,
            "historyLimit":self.history_limit,"historyEvents":self.history.len(),"historyPeak":self.history_peak,
            "process":{"pid":std::process::id(),"rssBytes":kb("VmRSS:"),"peakRssBytes":kb("VmHWM:"),
                "userTicks":fields.get(11).and_then(|v|v.parse::<u64>().ok()),"systemTicks":fields.get(12).and_then(|v|v.parse::<u64>().ok())},
            "inventory":{"engine":"Leptos 0.8.22 / Axum SSE / Tokio bounded mpsc", "sourceRows":self.rows.len(),
                "snapshotReads":self.reads,"transportPayloadBytes":self.bytes,"applicationQueues":self.readers.len(),
                "replayEvents":self.readers.values().map(|r|r.replay.len()).sum::<usize>(),"replayLimitPerReader":self.history_limit,
                "overflowSlots":self.readers.values().filter(|r|r.overflow.is_some()).count(),"overflowSlotsLimitPerReader":1,
                "writerFramesLimitPerReader":1,"kernelSocketBytes":null,"nativeTransportBufferBytes":null,
                "spawnedWriterTasks":0,"backgroundPublishers":0,"timers":0,"held":self.held}})
    }

    pub fn snapshot(&mut self) -> Snapshot {
        self.reads += 1;
        Snapshot { through: self.through, rows: self.rows.clone(), work: Work { reads: 1, rows: self.rows.len() } }
    }

    fn configure(&mut self, input: Value) -> Result<Value, StatusCode> {
        if !self.readers.is_empty() {
            return Err(StatusCode::CONFLICT);
        }
        let (q, h) = (input["queueLimit"].as_u64(), input["historyLimit"].as_u64());
        if !matches!((q, h), (Some(2), Some(4)) | (Some(1024), Some(1025))) {
            return Err(bad());
        }
        let rows: Vec<Listing> = serde_json::from_value(input["initial"].clone()).map_err(|_| bad())?;
        let mut keys = std::collections::HashSet::new();
        if rows.len() > 1000 || rows.iter().any(|r| !valid_row(r) || !keys.insert(&r.id)) {
            return Err(bad());
        }
        *self = Store { rows, queue_limit: q.unwrap() as usize, history_limit: h.unwrap() as usize, ..Self::default() };
        Ok(json!({"configured":true,"framework":"leptos","version":"0.8.22"}))
    }

    fn enqueue(&mut self, event: &Change) {
        let ids: Vec<_> = self.readers.keys().copied().collect();
        for id in ids {
            let reader = self.readers.get_mut(&id).unwrap();
            // An outstanding overflow supersedes later queued events until the client resnapshots.
            if reader.overflow.is_some() {
                continue;
            }
            if reader.tx.try_send(event.clone()).is_err() {
                let saturated = self.resources();
                let reader = self.readers.get_mut(&id).unwrap();
                while reader.rx.try_recv().is_ok() {}
                reader.replay.clear();
                reader.overflow = Some(json!({"outcome":"resnapshot","resources":saturated}));
                self.held = false;
            }
            let reader = self.readers.get_mut(&id).unwrap();
            self.queue_peak = self.queue_peak.max(reader.rx.len());
            if let Some(waker) = reader.waker.take() {
                waker.wake();
            }
        }
    }

    fn publish(&mut self, input: Value) -> Result<Value, StatusCode> {
        let batch = input.get("events").is_some();
        let values = match (input.get("event"), input.get("events")) {
            (Some(event), None) => vec![event.clone()],
            (None, Some(Value::Array(events))) if self.queue_limit == 1024 && !events.is_empty() && events.len() <= 1044 => {
                events.clone()
            }
            _ => return Err(bad()),
        };
        let mut projected = self.rows.clone();
        let events: Vec<Change> = values
            .into_iter()
            .enumerate()
            .map(|(i, value)| {
                let e: Change = serde_json::from_value(value).map_err(|_| bad())?;
                if e.seq != self.through + i as u64 + 1
                    || e.seq > MAX_SAFE
                    || !text(&e.key)
                    || !text(&e.effect_id)
                    || !matches!(e.op.as_str(), "upsert" | "remove")
                    || (e.op == "upsert" && !e.row.as_ref().is_some_and(|r| r.id == e.key && valid_row(r)))
                    || (e.op == "remove" && e.row.is_some())
                {
                    return Err(bad());
                }
                apply(&mut projected, &e);
                if projected.len() > 1000 {
                    return Err(bad());
                }
                Ok(e)
            })
            .collect::<Result<_, _>>()?;
        let mut acks = Vec::with_capacity(events.len());
        for e in events {
            apply(&mut self.rows, &e);
            self.through = e.seq;
            if self.history.len() == self.history_limit {
                self.history.pop_front();
            }
            self.history.push_back(e.clone());
            self.history_peak = self.history_peak.max(self.history.len());
            if self.drop_seq != Some(e.seq) {
                self.enqueue(&e);
            }
            acks.push(json!({"seq":e.seq,"resources":self.resources()}));
        }
        Ok(if batch { json!({"acks":acks}) } else { acks.remove(0) })
    }

    fn control(&mut self, input: Value) -> Result<Value, StatusCode> {
        match input["action"].as_str() {
            Some("hold") => self.held = true,
            Some("drop") => {
                let seq = input["seq"].as_u64().filter(|seq| *seq > self.through && *seq <= MAX_SAFE).ok_or_else(bad)?;
                self.drop_seq = Some(seq);
            }
            Some("duplicate") => {
                let event = self.history.back().cloned().ok_or_else(bad)?;
                self.enqueue(&event);
            }
            _ => return Err(bad()),
        }
        Ok(json!({"resources":self.resources()}))
    }

    fn subscribe(&mut self, from: u64) -> Result<u64, StatusCode> {
        if from > self.through {
            return Err(bad());
        }
        if self.readers.len() >= 16 {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let expired = from < self.through && self.history.front().is_none_or(|e| from < e.seq - 1);
        let replay = if expired { VecDeque::new() } else { self.history.iter().filter(|e| e.seq >= from).cloned().collect() };
        let (tx, rx) = mpsc::channel(self.queue_limit);
        self.next_reader += 1;
        let id = self.next_reader;
        self.readers.insert(id, Reader { tx, rx, replay, ready: None, overflow: None, waker: None });
        let ready = json!({"from":from,"status":if expired {"expired"} else {"accepted"},"resources":self.resources()});
        self.readers.get_mut(&id).unwrap().ready = Some(ready);
        Ok(id)
    }
}

fn apply(rows: &mut Vec<Listing>, event: &Change) {
    if event.op == "remove" {
        rows.retain(|r| r.id != event.key);
    } else if let Some(row) = &event.row {
        if let Some(old) = rows.iter_mut().find(|r| r.id == event.key) {
            *old = row.clone();
        } else {
            rows.push(row.clone());
        }
    }
}

struct NativeStream {
    shared: Shared,
    id: u64,
}
impl Stream for NativeStream {
    type Item = Result<Event, Infallible>;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let mut store = self.shared.0.lock().unwrap();
        let held = store.held;
        let Some(reader) = store.readers.get_mut(&self.id) else {
            return Poll::Ready(None);
        };
        let next = if let Some(ready) = reader.ready.take() {
            Some(("ready", ready))
        } else if let Some(overflow) = reader.overflow.take() {
            Some(("overflow", overflow))
        } else if !held {
            reader.replay.pop_front().or_else(|| reader.rx.try_recv().ok()).map(|e| ("update", serde_json::to_value(e).unwrap()))
        } else {
            None
        };
        if let Some((kind, payload)) = next {
            let encoded = serde_json::to_string(&payload).unwrap();
            store.bytes += encoded.len() as u64;
            Poll::Ready(Some(Ok(Event::default().event(kind).data(encoded))))
        } else {
            reader.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}
impl Drop for NativeStream {
    fn drop(&mut self) {
        self.shared.0.lock().unwrap().readers.remove(&self.id);
    }
}

#[derive(Deserialize)]
struct Cursor {
    from: u64,
}
async fn events(State(shared): State<Shared>, Query(cursor): Query<Cursor>) -> Result<Sse<NativeStream>, StatusCode> {
    let id = shared.0.lock().unwrap().subscribe(cursor.from)?;
    Ok(Sse::new(NativeStream { shared, id }))
}
async fn configure(State(shared): State<Shared>, Json(input): Json<Value>) -> Result<Json<Value>, StatusCode> {
    shared.0.lock().unwrap().configure(input).map(Json)
}
async fn publish(State(shared): State<Shared>, Json(input): Json<Value>) -> Result<Json<Value>, StatusCode> {
    shared.0.lock().unwrap().publish(input).map(Json)
}
async fn control(State(shared): State<Shared>, Json(input): Json<Value>) -> Result<Json<Value>, StatusCode> {
    shared.0.lock().unwrap().control(input).map(Json)
}
async fn snapshot(State(shared): State<Shared>) -> Json<Snapshot> {
    Json(shared.0.lock().unwrap().snapshot())
}
async fn resources(State(shared): State<Shared>) -> Json<Value> {
    Json(shared.0.lock().unwrap().resources())
}

pub async fn serve() {
    // Direct render handlers, unlike LeptosRoutes, do not initialize the executor.
    any_spawner::Executor::init_tokio().expect("Leptos Tokio executor");
    let shared = Shared::default();
    let options = get_configuration(None).unwrap().leptos_options;
    let ssr_state = shared.clone();
    let ssr_options = options.clone();
    let fns_state = shared.clone();
    let app = Router::new()
        .route(
            "/",
            get(leptos_axum::render_app_async_with_context(
                move || provide_context(ssr_state.clone()),
                move || shell(ssr_options.clone()),
            )),
        )
        .route(
            "/api/{*fn_name}",
            post(move |req| {
                let state = fns_state.clone();
                leptos_axum::handle_server_fns_with_context(move || provide_context(state.clone()), req)
            }),
        )
        .route("/parity/configure", post(configure))
        .route("/parity/publish", post(publish))
        .route("/parity/control", post(control))
        .route("/parity/snapshot", get(snapshot))
        .route("/parity/resources", get(resources))
        .route("/parity/events", get(events))
        .route("/bridge.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript")], include_str!("../public/bridge.js")) }))
        .with_state(shared)
        .fallback(leptos_axum::file_and_error_handler(shell))
        .with_state(options.clone());
    let listener = tokio::net::TcpListener::bind(options.site_addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(seq: u64) -> Value {
        json!({"seq":seq,"effectId":format!("effect-{seq}"),"key":"one","op":"upsert","row":{"id":"one","version":seq,"priceCents":100,"quantity":1}})
    }
    fn configured(q: usize, h: usize) -> Store {
        let mut s = Store::default();
        s.configure(json!({"initial":[],"queueLimit":q,"historyLimit":h})).unwrap();
        s
    }
    #[test]
    fn validates_complete_batch_before_native_writes() {
        let mut s = configured(1024, 1025);
        for value in [
            json!({"event":event(2)}),
            json!({"events":[]}),
            json!({"events":[event(1),event(3)]}),
            json!({"event":event(1),"events":[event(1)]}),
        ] {
            assert_eq!(s.publish(value), Err(StatusCode::BAD_REQUEST));
            assert_eq!(s.through, 0);
            assert!(s.history.is_empty());
        }
        let acks = s.publish(json!({"events":(1..=1044).map(event).collect::<Vec<_>>()})).unwrap();
        assert_eq!(acks["acks"].as_array().unwrap().len(), 1044);
        assert_eq!(s.history.len(), 1025);
        assert_eq!(s.history_peak, 1025);
        assert_eq!(s.snapshot().rows[0].version, 1044);
    }
    #[test]
    fn keyed_mutations_overflow_and_replay_are_bounded() {
        let mut s = configured(2, 4);
        let id = s.subscribe(0).unwrap();
        s.control(json!({"action":"hold"})).unwrap();
        s.publish(json!({"event":event(1)})).unwrap();
        let ack = s.publish(json!({"event":event(2)})).unwrap();
        assert_eq!(ack["resources"]["queueEvents"], 2);
        s.publish(json!({"event":event(3)})).unwrap();
        assert_eq!(s.readers[&id].overflow.as_ref().unwrap()["resources"]["queueEvents"], 2);
        assert_eq!(s.queue_peak, 2);
        assert_eq!(s.readers[&id].rx.len(), 0);
        s.readers.remove(&id);
        s.publish(json!({"event":{"seq":4,"effectId":"remove","key":"one","op":"remove"}})).unwrap();
        assert!(s.rows.is_empty());
        s.publish(json!({"event":event(5)})).unwrap();
        assert_eq!(s.rows.len(), 1);
        let id = s.subscribe(3).unwrap();
        assert_eq!(s.readers[&id].replay.front().unwrap().seq, 3);
        s.readers.remove(&id);
        let id = s.subscribe(0).unwrap();
        assert_eq!(s.readers[&id].ready.as_ref().unwrap()["status"], "expired");
        assert!(s.readers[&id].replay.is_empty());
    }
    #[test]
    fn saturation_and_native_drop_release_every_reader() {
        let shared = Shared(Arc::new(Mutex::new(configured(2, 4))));
        let mut streams = Vec::new();
        for _ in 0..16 {
            let id = shared.0.lock().unwrap().subscribe(0).unwrap();
            streams.push(NativeStream { shared: shared.clone(), id });
        }
        assert_eq!(shared.0.lock().unwrap().subscribe(0), Err(StatusCode::TOO_MANY_REQUESTS));
        assert_eq!(shared.0.lock().unwrap().configure(json!({})), Err(StatusCode::CONFLICT));
        drop(streams);
        let r = shared.0.lock().unwrap().resources();
        for name in ["connections", "subscriptions", "pendingTasks", "queueEvents"] {
            assert_eq!(r[name], 0);
        }
    }
}
