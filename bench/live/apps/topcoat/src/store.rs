use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use topcoat::router::StatusCode;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Listing {
    pub id: String,
    pub version: u64,
    pub price_cents: u64,
    pub quantity: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub seq: u64,
    pub effect_id: String,
    pub key: String,
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<Listing>,
}
#[derive(Clone, Default)]
pub struct Shared(pub Arc<Mutex<Store>>);
#[derive(Clone)]
pub struct Client {
    pub rows: Vec<Listing>,
    pub through: u64,
    pub count: u64,
    initialized: bool,
    needs_snapshot: bool,
    pub serial: u64,
}
pub struct Delivery {
    pub state: Client,
    pub message: Value,
}
struct Session {
    state: Client,
    next_serial: u64,
    pending: Option<Client>,
    inactive_since: Option<Instant>,
}
pub const RECONNECT_GRACE: Duration = Duration::from_secs(30);
struct Reader {
    client: String,
    tx: mpsc::Sender<Change>,
    rx: mpsc::Receiver<Change>,
    replay: VecDeque<Change>,
    ready: Option<Value>,
    priority: Option<Value>,
    overflow: Option<Value>,
    inflight: Option<u64>,
    waker: Option<Waker>,
}
pub struct Store {
    rows: Vec<Listing>,
    through: u64,
    publisher_ack_through: u64,
    history: VecDeque<Change>,
    readers: HashMap<u64, Reader>,
    clients: HashMap<String, Session>,
    next_reader: u64,
    next_client: u64,
    queue_limit: usize,
    history_limit: usize,
    queue_peak: usize,
    history_peak: usize,
    reads: u64,
    held: bool,
    drop_seq: Option<u64>,
    emitted_payload_bytes: u64,
    pub reaper_running: bool,
    expired_clients: u64,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            rows: vec![],
            through: 0,
            publisher_ack_through: 0,
            history: VecDeque::new(),
            readers: HashMap::new(),
            clients: HashMap::new(),
            next_reader: 0,
            next_client: 0,
            queue_limit: 2,
            history_limit: 4,
            queue_peak: 0,
            history_peak: 0,
            reads: 0,
            held: false,
            drop_seq: None,
            emitted_payload_bytes: 0,
            reaper_running: false,
            expired_clients: 0,
        }
    }
}
type Result<T> = std::result::Result<T, StatusCode>;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
fn valid_text(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control)
}
fn valid_row(r: &Listing) -> bool {
    valid_text(&r.id) && r.version <= MAX_SAFE && r.price_cents <= MAX_SAFE && r.quantity <= MAX_SAFE
}
fn apply(rows: &mut Vec<Listing>, e: &Change) {
    if e.op == "remove" {
        rows.retain(|r| r.id != e.key);
    } else if let Some(row) = &e.row {
        if let Some(old) = rows.iter_mut().find(|r| r.id == e.key) {
            *old = row.clone();
        } else {
            rows.push(row.clone());
        }
    }
}
impl Store {
    pub fn resources(&self) -> Value {
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let kb = |key: &str| {
            status.lines().find_map(|l| l.strip_prefix(key)?.split_whitespace().next()?.parse::<u64>().ok()).map(|n| n * 1024)
        };
        let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
        let fields: Vec<_> = stat.rsplit_once(") ").map(|(_, tail)| tail.split_whitespace().collect()).unwrap_or_default();
        json!({"subscriptions":self.readers.len(),"connections":self.readers.len(),"pendingTasks":self.readers.len(),
            "queueLimit":self.queue_limit,"queueEvents":self.readers.values().map(|r|r.rx.len()).sum::<usize>(),"queuePeak":self.queue_peak,
            "historyLimit":self.history_limit,"historyEvents":self.history.len(),"historyPeak":self.history_peak,
            "process":{"pid":std::process::id(),"rssBytes":kb("VmRSS:"),"peakRssBytes":kb("VmHWM:"),
                "userTicks":fields.get(11).and_then(|v|v.parse::<u64>().ok()),"systemTicks":fields.get(12).and_then(|v|v.parse::<u64>().ok())},
            "inventory":{"engine":"Topcoat 0.12.1 live!/emit! / native runtime WebSocket", "sourceRows":self.rows.len(),
                "clients":self.clients.len(),"clientLimit":16,"clientRows":self.clients.values().map(|c|c.state.rows.len()).sum::<usize>(),
                "pendingClientRows":self.clients.values().filter_map(|c|c.pending.as_ref()).map(|c|c.rows.len()).sum::<usize>(),
                "pendingClientStatesLimitPerClient":1,"reconnectGraceMs":RECONNECT_GRACE.as_millis(),"expiredClients":self.expired_clients,
                "retentionSweepTasks":usize::from(self.reaper_running),
                "snapshotReads":self.reads,"publisherAckThrough":self.publisher_ack_through,"emittedDiagnosticPayloadBytes":self.emitted_payload_bytes,
                "applicationQueues":self.readers.len(),"replayEvents":self.readers.values().map(|r|r.replay.len()).sum::<usize>(),
                "replayLimitPerReader":self.history_limit,"inFlight":self.readers.values().filter(|r|r.inflight.is_some()).count(),"inFlightLimitPerReader":1,
                "overflowSlots":self.readers.values().filter(|r|r.overflow.is_some()).count(),"overflowSlotsLimitPerReader":1,
                "prioritySlotsLimitPerReader":1,"nativeRuntimeOutputQueueLimitPerConnection":16,"nativeRuntimeWriterFramesLimitPerConnection":1,
                "kernelSocketBytes":null,"nativeTransportBufferBytes":null,"backgroundPublishers":0,"timers":usize::from(self.reaper_running),"held":self.held}})
    }
    pub fn configure(&mut self, input: Value) -> Result<Value> {
        if !self.readers.is_empty() {
            return Err(StatusCode::CONFLICT);
        }
        let (q, h) = (input["queueLimit"].as_u64(), input["historyLimit"].as_u64());
        if !matches!((q, h), (Some(2), Some(4)) | (Some(1024), Some(1025))) {
            return Err(StatusCode::BAD_REQUEST);
        }
        let rows: Vec<Listing> = serde_json::from_value(input["initial"].clone()).map_err(|_| StatusCode::BAD_REQUEST)?;
        let mut keys = std::collections::HashSet::new();
        if rows.len() > 1000 || rows.iter().any(|r| !valid_row(r) || !keys.insert(&r.id)) {
            return Err(StatusCode::BAD_REQUEST);
        }
        *self = Self {
            rows,
            queue_limit: q.unwrap() as usize,
            history_limit: h.unwrap() as usize,
            next_client: self.next_client,
            reaper_running: self.reaper_running,
            ..Self::default()
        };
        Ok(json!({"configured":true,"framework":"topcoat","version":"0.12.1"}))
    }
    pub fn new_client(&mut self) -> Result<String> {
        if self.readers.len() >= 16 {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        self.next_client += 1;
        // Issuing a page identity retains no rows/session. Only live attach allocates.
        Ok(format!("client-{}", self.next_client))
    }
    fn initial_client(&self) -> Client {
        Client { rows: self.rows.clone(), through: self.through, count: 0, initialized: false, needs_snapshot: true, serial: 0 }
    }
    fn issued(&self, id: &str) -> bool {
        id.strip_prefix("client-").and_then(|s| s.parse::<u64>().ok()).is_some_and(|n| n > 0 && n <= self.next_client)
    }
    fn register(&mut self, id: &str) -> Result<()> {
        self.expire_clients(Instant::now());
        if self.clients.contains_key(id) {
            return Ok(());
        }
        if !self.issued(id) {
            return Err(StatusCode::BAD_REQUEST);
        }
        if self.clients.len() >= 16 {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        self.clients.insert(
            id.into(),
            Session { state: self.initial_client(), next_serial: 0, pending: None, inactive_since: Some(Instant::now()) },
        );
        Ok(())
    }
    pub fn expire_clients(&mut self, now: Instant) {
        let before = self.clients.len();
        self.clients.retain(|_, c| c.inactive_since.is_none_or(|since| now.duration_since(since) < RECONNECT_GRACE));
        self.expired_clients += (before - self.clients.len()) as u64;
    }
    pub fn client(&self, id: &str) -> Result<Client> {
        if let Some(c) = self.clients.get(id) {
            return Ok(c.state.clone());
        }
        if !self.issued(id) {
            return Err(StatusCode::BAD_REQUEST);
        }
        Ok(self.initial_client())
    }
    pub fn reader(&self, client: &str) -> Value {
        json!({"active":self.readers.values().any(|r|r.client == client),
            "registered":self.clients.contains_key(client),"resources":self.resources()})
    }
    pub fn publisher_ack(&mut self, through: u64) -> Result<Value> {
        if through < self.publisher_ack_through || through > self.through {
            return Err(StatusCode::BAD_REQUEST);
        }
        self.publisher_ack_through = through;
        for r in self.readers.values_mut() {
            if let Some(w) = r.waker.take() {
                w.wake();
            }
        }
        Ok(json!({"publisherAckThrough":through}))
    }
    pub fn snapshot(&mut self, client: Option<&str>) -> Result<Value> {
        let reader = if let Some(client) = client {
            Some(self.readers.iter().find(|(_, r)| r.client == client).map(|(id, _)| *id).ok_or(StatusCode::CONFLICT)?)
        } else {
            None
        };
        self.reads += 1;
        let snapshot = json!({"through":self.through,"rows":self.rows,"work":{"reads":1,"rows":self.rows.len()}});
        if let Some(id) = reader {
            let r = self.readers.get_mut(&id).unwrap();
            while r.rx.try_recv().is_ok() {}
            r.replay.clear();
            r.overflow = None;
            r.priority = Some(json!({"kind":"snapshot","snapshot":snapshot}));
            if let Some(w) = r.waker.take() {
                w.wake();
            }
        }
        Ok(snapshot)
    }
    fn enqueue(&mut self, e: &Change) {
        let ids: Vec<_> = self.readers.keys().copied().collect();
        for id in ids {
            let r = self.readers.get_mut(&id).unwrap();
            if r.overflow.is_some() {
                continue;
            }
            if r.tx.try_send(e.clone()).is_err() {
                let saturated = self.resources();
                let r = self.readers.get_mut(&id).unwrap();
                while r.rx.try_recv().is_ok() {}
                r.replay.clear();
                r.overflow = Some(json!({"kind":"overflow","outcome":"resnapshot","resources":saturated}));
                self.held = false;
            }
            let r = self.readers.get_mut(&id).unwrap();
            self.queue_peak = self.queue_peak.max(r.rx.len());
            if let Some(w) = r.waker.take() {
                w.wake();
            }
        }
    }
    pub fn publish(&mut self, input: Value) -> Result<Value> {
        let batch = input.get("events").is_some();
        let values = match (input.get("event"), input.get("events")) {
            (Some(e), None) => vec![e.clone()],
            (None, Some(Value::Array(events))) if self.queue_limit == 1024 && !events.is_empty() && events.len() <= 1044 => {
                events.clone()
            }
            _ => return Err(StatusCode::BAD_REQUEST),
        };
        let mut projected = self.rows.clone();
        let events: Vec<Change> = values
            .into_iter()
            .enumerate()
            .map(|(i, value)| {
                let e: Change = serde_json::from_value(value).map_err(|_| StatusCode::BAD_REQUEST)?;
                if e.seq != self.through + i as u64 + 1
                    || e.seq > MAX_SAFE
                    || !valid_text(&e.key)
                    || !valid_text(&e.effect_id)
                    || !matches!(e.op.as_str(), "upsert" | "remove")
                    || e.op == "upsert" && !e.row.as_ref().is_some_and(|r| r.id == e.key && valid_row(r))
                    || e.op == "remove" && e.row.is_some()
                {
                    return Err(StatusCode::BAD_REQUEST);
                }
                apply(&mut projected, &e);
                if projected.len() > 1000 {
                    return Err(StatusCode::BAD_REQUEST);
                }
                Ok(e)
            })
            .collect::<Result<_>>()?;
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
    pub fn control(&mut self, input: Value) -> Result<Value> {
        match input["action"].as_str() {
            Some("hold") => self.held = true,
            Some("drop") => {
                self.drop_seq =
                    Some(input["seq"].as_u64().filter(|s| *s > self.through && *s <= MAX_SAFE).ok_or(StatusCode::BAD_REQUEST)?)
            }
            Some("duplicate") => {
                let e = self.history.back().cloned().ok_or(StatusCode::BAD_REQUEST)?;
                self.enqueue(&e);
            }
            _ => return Err(StatusCode::BAD_REQUEST),
        }
        Ok(json!({"resources":self.resources()}))
    }
    fn subscribe(&mut self, client: &str) -> Result<u64> {
        if self.readers.len() >= 16 {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        if self.readers.values().any(|r| r.client == client) {
            return Err(StatusCode::CONFLICT);
        }
        self.register(client)?;
        let session = self.clients.get_mut(client).unwrap();
        session.inactive_since = None;
        // A canceled, unobserved emission is not a confirmed resume cursor.
        session.pending = None;
        let c = &mut session.state;
        let from = c.through;
        let expired =
            c.needs_snapshot || !c.initialized || from < self.through && self.history.front().is_none_or(|e| from < e.seq - 1);
        if expired {
            c.needs_snapshot = true;
        }
        let replay = if expired { VecDeque::new() } else { self.history.iter().filter(|e| e.seq >= from).cloned().collect() };
        let (tx, rx) = mpsc::channel(self.queue_limit);
        self.next_reader += 1;
        let id = self.next_reader;
        self.readers.insert(
            id,
            Reader {
                client: client.into(),
                tx,
                rx,
                replay,
                ready: None,
                priority: None,
                overflow: None,
                inflight: None,
                waker: None,
            },
        );
        let ready =
            json!({"kind":"ready","from":from,"status":if expired {"expired"} else {"accepted"},"resources":self.resources()});
        self.readers.get_mut(&id).unwrap().ready = Some(ready);
        Ok(id)
    }
    fn poll(&mut self, id: u64, cx: &mut Context<'_>) -> Poll<Delivery> {
        let r = self.readers.get_mut(&id).unwrap();
        r.waker = Some(cx.waker().clone());
        // Native frames mutate the DOM before an observer runs. Gate emission itself
        // until the publisher has consumed the real HTTP write acknowledgement.
        if r.inflight.is_some() || self.publisher_ack_through < self.through {
            return Poll::Pending;
        }
        let session = self.clients.get_mut(&r.client).unwrap();
        let mut c = session.state.clone();
        let mut message = if let Some(message) = r.ready.take().or_else(|| r.priority.take()).or_else(|| r.overflow.take()) {
            message
        } else if !self.held && c.initialized && !c.needs_snapshot {
            let Some(e) = r.replay.pop_front().or_else(|| r.rx.try_recv().ok()) else {
                return Poll::Pending;
            };
            let disposition = if e.seq <= c.through {
                "duplicate"
            } else if e.seq > c.through + 1 {
                "gap"
            } else {
                "applied"
            };
            if disposition == "applied" {
                apply(&mut c.rows, &e);
                c.through = e.seq;
                c.count += 1;
            } else if disposition == "gap" {
                c.needs_snapshot = true;
            }
            json!({"kind":"event","event":e,"disposition":disposition})
        } else {
            return Poll::Pending;
        };
        if message["kind"] == "overflow" {
            c.needs_snapshot = true;
        }
        if message["kind"] == "snapshot" {
            c.rows = serde_json::from_value(message["snapshot"]["rows"].clone()).unwrap();
            c.through = message["snapshot"]["through"].as_u64().unwrap();
            c.initialized = true;
            c.needs_snapshot = false;
        }
        session.next_serial += 1;
        c.serial = session.next_serial;
        message["serial"] = json!(c.serial);
        r.inflight = Some(c.serial);
        session.pending = Some(c.clone());
        self.emitted_payload_bytes += serde_json::to_vec(&message).unwrap().len() as u64;
        Poll::Ready(Delivery { state: c.clone(), message })
    }
    pub fn acknowledge(&mut self, client: &str, serial: u64) -> Result<Value> {
        self.expire_clients(Instant::now());
        if serial == 0 {
            self.register(client)?;
        }
        let session = self.clients.get_mut(client).ok_or(StatusCode::GONE)?;
        // The browser reconciles its last actually observed serial before reconnect.
        // ACK response loss is idempotent; an unobserved pending frame cannot advance it.
        if serial <= session.state.serial {
            return Ok(json!({"acknowledged":serial}));
        }
        if !session.pending.as_ref().is_some_and(|c| c.serial == serial) {
            return Err(StatusCode::BAD_REQUEST);
        }
        session.state = session.pending.take().unwrap();
        if let Some(r) = self.readers.values_mut().find(|r| r.client == client) {
            r.inflight = None;
            if let Some(w) = r.waker.take() {
                w.wake();
            }
        }
        Ok(json!({"acknowledged":serial}))
    }
    pub fn finish(&mut self, client: &str) -> Result<Value> {
        if self.readers.values().any(|r| r.client == client) {
            return Err(StatusCode::CONFLICT);
        }
        if self.clients.remove(client).is_none() {
            return Err(StatusCode::BAD_REQUEST);
        }
        Ok(json!({"finished":true}))
    }
}

pub struct Subscription {
    shared: Shared,
    id: u64,
}
impl Subscription {
    pub fn new(shared: Shared, client: &str) -> Result<Self> {
        let id = shared.0.lock().unwrap().subscribe(client)?;
        Ok(Self { shared, id })
    }
    pub async fn next(&self) -> Delivery {
        futures_util::future::poll_fn(|cx| self.shared.0.lock().unwrap().poll(self.id, cx)).await
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        let mut store = self.shared.0.lock().unwrap();
        if let Some(reader) = store.readers.remove(&self.id)
            && let Some(c) = store.clients.get_mut(&reader.client)
        {
            c.inactive_since = Some(Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(seq: u64) -> Value {
        json!({"seq":seq,"effectId":format!("e-{seq}"),"key":"a","op":"upsert","row":{"id":"a","version":seq,"priceCents":12,"quantity":2}})
    }
    fn shared(q: usize, h: usize) -> Shared {
        let s = Shared::default();
        s.0.lock().unwrap().configure(json!({"initial":[],"queueLimit":q,"historyLimit":h})).unwrap();
        s
    }
    #[test]
    fn batch_rejections_are_atomic_and_history_is_finite() {
        let s = shared(1024, 1025);
        let mut s = s.0.lock().unwrap();
        for input in [
            json!({"event":event(2)}),
            json!({"events":[]}),
            json!({"events":[event(1),event(3)]}),
            json!({"event":event(1),"events":[event(1)]}),
        ] {
            assert_eq!(s.publish(input), Err(StatusCode::BAD_REQUEST));
            assert_eq!(s.through, 0);
            assert!(s.rows.is_empty());
        }
        let r = s.publish(json!({"events":(1..=1044).map(event).collect::<Vec<_>>()})).unwrap();
        assert_eq!(r["acks"].as_array().unwrap().len(), 1044);
        assert_eq!(s.history.len(), 1025);
        assert_eq!(s.history_peak, 1025);
    }
    #[tokio::test]
    async fn native_consumer_holds_saturates_overflows_and_releases() {
        let s = shared(2, 4);
        let client = s.0.lock().unwrap().new_client().unwrap();
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        s.0.lock().unwrap().acknowledge(&client, ready.message["serial"].as_u64().unwrap()).unwrap();
        s.0.lock().unwrap().snapshot(Some(&client)).unwrap();
        let snap = sub.next().await;
        s.0.lock().unwrap().acknowledge(&client, snap.message["serial"].as_u64().unwrap()).unwrap();
        s.0.lock().unwrap().control(json!({"action":"hold"})).unwrap();
        for seq in 1..=3 {
            s.0.lock().unwrap().publish(json!({"event":event(seq)})).unwrap();
        }
        s.0.lock().unwrap().publisher_ack(3).unwrap();
        let over = sub.next().await;
        assert_eq!(over.message["kind"], "overflow");
        assert_eq!(over.message["resources"]["queueEvents"], 2);
        assert_eq!(s.0.lock().unwrap().queue_peak, 2);
        assert_eq!(over.state.count, 0);
        drop(sub);
        assert_eq!(s.0.lock().unwrap().resources()["subscriptions"], 0);
        s.0.lock().unwrap().finish(&client).unwrap();
        assert!(s.0.lock().unwrap().clients.is_empty());
    }
    #[tokio::test]
    async fn actual_client_guard_rejects_duplicates_and_replays_boundary() {
        let s = shared(2, 4);
        let client = s.0.lock().unwrap().new_client().unwrap();
        let sub = Subscription::new(s.clone(), &client).unwrap();
        for n in 0..2 {
            let d = sub.next().await;
            s.0.lock().unwrap().acknowledge(&client, d.message["serial"].as_u64().unwrap()).unwrap();
            if n == 0 {
                s.0.lock().unwrap().snapshot(Some(&client)).unwrap();
            }
        }
        s.0.lock().unwrap().publish(json!({"event":event(1)})).unwrap();
        s.0.lock().unwrap().publisher_ack(1).unwrap();
        let d = sub.next().await;
        assert_eq!(d.message["disposition"], "applied");
        assert_eq!(d.state.count, 1);
        s.0.lock().unwrap().acknowledge(&client, d.message["serial"].as_u64().unwrap()).unwrap();
        s.0.lock().unwrap().control(json!({"action":"duplicate"})).unwrap();
        let d = sub.next().await;
        assert_eq!(d.message["disposition"], "duplicate");
        assert_eq!(d.state.count, 1);
        s.0.lock().unwrap().acknowledge(&client, d.message["serial"].as_u64().unwrap()).unwrap();
        drop(sub);
        s.0.lock().unwrap().publish(json!({"event":event(2)})).unwrap();
        s.0.lock().unwrap().publisher_ack(2).unwrap();
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let d = sub.next().await;
        assert_eq!(d.message["status"], "accepted");
        s.0.lock().unwrap().acknowledge(&client, d.message["serial"].as_u64().unwrap()).unwrap();
        let d = sub.next().await;
        assert_eq!(d.message["event"]["seq"], 1);
        assert_eq!(d.message["disposition"], "duplicate");
    }
    #[tokio::test]
    async fn gap_and_expired_cursor_require_authoritative_snapshot_without_effects() {
        let s = shared(2, 4);
        let client = s.0.lock().unwrap().new_client().unwrap();
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ack = |d: &Delivery| s.0.lock().unwrap().acknowledge(&client, d.message["serial"].as_u64().unwrap()).unwrap();
        ack(&sub.next().await);
        s.0.lock().unwrap().snapshot(Some(&client)).unwrap();
        ack(&sub.next().await);
        s.0.lock().unwrap().control(json!({"action":"drop","seq":1})).unwrap();
        for seq in 1..=2 {
            s.0.lock().unwrap().publish(json!({"event":event(seq)})).unwrap();
        }
        s.0.lock().unwrap().publisher_ack(2).unwrap();
        let gap = sub.next().await;
        assert_eq!(gap.message["disposition"], "gap");
        assert_eq!(gap.state.count, 0);
        assert_eq!(gap.state.through, 0);
        ack(&gap);
        assert_eq!(s.0.lock().unwrap().acknowledge(&client, 999), Err(StatusCode::BAD_REQUEST));
        s.0.lock().unwrap().snapshot(Some(&client)).unwrap();
        let snap = sub.next().await;
        assert_eq!(snap.state.rows[0].version, 2);
        assert_eq!(snap.state.through, 2);
        assert_eq!(snap.state.count, 0);
        ack(&snap);
        drop(sub);
        for seq in 3..=8 {
            s.0.lock().unwrap().publish(json!({"event":event(seq)})).unwrap();
        }
        s.0.lock().unwrap().publisher_ack(8).unwrap();
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        assert_eq!(ready.message["status"], "expired");
        ack(&ready);
        s.0.lock().unwrap().snapshot(Some(&client)).unwrap();
        let snap = sub.next().await;
        assert_eq!(snap.state.rows[0].version, 8);
        assert_eq!(snap.state.through, 8);
        assert_eq!(snap.state.count, 0);
    }
    #[test]
    fn keyed_upsert_remove_and_reinsert_preserve_visible_order() {
        let s = shared(2, 4);
        let mut s = s.0.lock().unwrap();
        for (seq, key, op) in [(1, "a", "upsert"), (2, "b", "upsert"), (3, "a", "upsert"), (4, "a", "remove"), (5, "a", "upsert")]
        {
            let mut e = event(seq);
            e["key"] = json!(key);
            if op == "remove" {
                e["op"] = json!(op);
                e.as_object_mut().unwrap().remove("row");
            } else {
                e["row"]["id"] = json!(key);
            }
            s.publish(json!({"event":e})).unwrap();
            let expected = match seq {
                1 => vec!["a"],
                2 | 3 => vec!["a", "b"],
                4 => vec!["b"],
                _ => vec!["b", "a"],
            };
            assert_eq!(s.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), expected);
        }
    }
    #[tokio::test]
    async fn native_emission_waits_for_all_real_publisher_acknowledgements() {
        use futures_util::FutureExt;
        let s = shared(2, 4);
        let client = s.0.lock().unwrap().new_client().unwrap();
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        s.0.lock().unwrap().acknowledge(&client, ready.message["serial"].as_u64().unwrap()).unwrap();
        s.0.lock().unwrap().snapshot(Some(&client)).unwrap();
        let snap = sub.next().await;
        s.0.lock().unwrap().acknowledge(&client, snap.message["serial"].as_u64().unwrap()).unwrap();
        for seq in 1..=2 {
            s.0.lock().unwrap().publish(json!({"event":event(seq)})).unwrap();
        }
        assert!(sub.next().now_or_never().is_none());
        assert_eq!(s.0.lock().unwrap().client(&client).unwrap().count, 0);
        s.0.lock().unwrap().publisher_ack(1).unwrap();
        assert!(sub.next().now_or_never().is_none());
        assert_eq!(s.0.lock().unwrap().publisher_ack(3), Err(StatusCode::BAD_REQUEST));
        s.0.lock().unwrap().publisher_ack(2).unwrap();
        let first = sub.next().await;
        assert_eq!(first.state.count, 1);
        assert_eq!(first.message["event"]["seq"], 1);
        assert_eq!(s.0.lock().unwrap().publisher_ack(1), Err(StatusCode::BAD_REQUEST));
        assert_eq!(s.0.lock().unwrap().reader(&client)["active"], true);
        drop(sub);
        assert_eq!(s.0.lock().unwrap().reader(&client)["active"], false);
    }
    #[test]
    fn sixteen_native_leases_and_clients_are_bounded() {
        let s = shared(2, 4);
        let mut leases = Vec::new();
        for _ in 0..16 {
            let id = s.0.lock().unwrap().new_client().unwrap();
            leases.push(Subscription::new(s.clone(), &id).unwrap());
        }
        assert_eq!(s.0.lock().unwrap().new_client(), Err(StatusCode::TOO_MANY_REQUESTS));
        assert_eq!(s.0.lock().unwrap().configure(json!({})), Err(StatusCode::CONFLICT));
        drop(leases);
        for name in ["subscriptions", "connections", "pendingTasks", "queueEvents"] {
            assert_eq!(s.0.lock().unwrap().resources()[name], 0);
        }
    }
    #[tokio::test]
    async fn canceled_emission_does_not_commit_rows_cursor_or_effects() {
        let s = shared(2, 4);
        let client = s.0.lock().unwrap().new_client().unwrap();
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        s.0.lock().unwrap().acknowledge(&client, ready.state.serial).unwrap();
        s.0.lock().unwrap().snapshot(Some(&client)).unwrap();
        let snap = sub.next().await;
        assert!(!s.0.lock().unwrap().client(&client).unwrap().initialized);
        s.0.lock().unwrap().acknowledge(&client, snap.state.serial).unwrap();
        s.0.lock().unwrap().publish(json!({"event":event(1)})).unwrap();
        s.0.lock().unwrap().publisher_ack(1).unwrap();
        let withheld = sub.next().await;
        assert_eq!(withheld.state.count, 1);
        drop(sub);
        let confirmed = s.0.lock().unwrap().client(&client).unwrap();
        assert_eq!((confirmed.through, confirmed.count), (0, 0));
        assert!(confirmed.rows.is_empty());
        s.0.lock().unwrap().acknowledge(&client, snap.state.serial).unwrap();
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        assert_eq!(ready.message["from"], 0);
        s.0.lock().unwrap().acknowledge(&client, ready.state.serial).unwrap();
        let replayed = sub.next().await;
        assert_eq!(replayed.message["disposition"], "applied");
        assert_eq!(replayed.state.count, 1);
        assert!(replayed.state.serial > withheld.state.serial);
        s.0.lock().unwrap().acknowledge(&client, replayed.state.serial).unwrap();
        assert_eq!(s.0.lock().unwrap().client(&client).unwrap().count, 1);
    }
    #[tokio::test]
    async fn observed_ack_after_cancellation_reconciles_and_snapshot_is_pending_until_ack() {
        let s = shared(2, 4);
        let client = s.0.lock().unwrap().new_client().unwrap();
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        s.0.lock().unwrap().acknowledge(&client, ready.state.serial).unwrap();
        s.0.lock().unwrap().snapshot(Some(&client)).unwrap();
        let snap = sub.next().await;
        drop(sub);
        assert!(!s.0.lock().unwrap().client(&client).unwrap().initialized);
        // This models the real browser having observed the original frame before
        // cancellation, but its original ACK request reaching the server afterwards.
        s.0.lock().unwrap().acknowledge(&client, snap.state.serial).unwrap();
        s.0.lock().unwrap().acknowledge(&client, snap.state.serial).unwrap();
        assert!(s.0.lock().unwrap().client(&client).unwrap().initialized);
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        s.0.lock().unwrap().acknowledge(&client, ready.state.serial).unwrap();
        s.0.lock().unwrap().publish(json!({"event":event(1)})).unwrap();
        s.0.lock().unwrap().publisher_ack(1).unwrap();
        let applied = sub.next().await;
        drop(sub);
        s.0.lock().unwrap().acknowledge(&client, applied.state.serial).unwrap();
        assert_eq!(s.0.lock().unwrap().client(&client).unwrap().count, 1);
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        assert_eq!(ready.message["from"], 1);
        s.0.lock().unwrap().acknowledge(&client, ready.state.serial).unwrap();
        let boundary = sub.next().await;
        assert_eq!(boundary.message["disposition"], "duplicate");
        assert_eq!(boundary.state.count, 1);
    }
    #[tokio::test]
    async fn native_rerender_reconciles_observation_before_subscribe_and_late_ack_does_not_release_new_ready() {
        let s = shared(2, 4);
        let client = s.0.lock().unwrap().new_client().unwrap();
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        s.0.lock().unwrap().acknowledge(&client, ready.state.serial).unwrap();
        s.0.lock().unwrap().snapshot(Some(&client)).unwrap();
        let snap = sub.next().await;
        s.0.lock().unwrap().acknowledge(&client, snap.state.serial).unwrap();
        s.0.lock().unwrap().publish(json!({"event":event(1)})).unwrap();
        s.0.lock().unwrap().publisher_ack(1).unwrap();
        let observed = sub.next().await;
        drop(sub);
        // The native rerun carries the serial on the actual screen, independently
        // of the still-inbound HTTP acknowledgement of this same emission.
        s.0.lock().unwrap().acknowledge(&client, observed.state.serial).unwrap();
        assert_eq!(s.0.lock().unwrap().client(&client).unwrap().count, 1);
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        assert_eq!(ready.message["from"], 1);
        assert_eq!((ready.state.through, ready.state.count), (1, 1));
        s.0.lock().unwrap().acknowledge(&client, observed.state.serial).unwrap();
        assert_eq!(s.0.lock().unwrap().readers[&sub.id].inflight, Some(ready.state.serial));
        s.0.lock().unwrap().acknowledge(&client, ready.state.serial).unwrap();
        let boundary = sub.next().await;
        assert_eq!(boundary.message["disposition"], "duplicate");
        assert_eq!(boundary.state.count, 1);
        s.0.lock().unwrap().acknowledge(&client, boundary.state.serial).unwrap();
    }
    #[tokio::test]
    async fn unobserved_initial_snapshot_requires_resnapshot_on_reconnect() {
        let s = shared(2, 4);
        let client = s.0.lock().unwrap().new_client().unwrap();
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        s.0.lock().unwrap().acknowledge(&client, ready.state.serial).unwrap();
        s.0.lock().unwrap().snapshot(Some(&client)).unwrap();
        let _withheld = sub.next().await;
        drop(sub);
        let sub = Subscription::new(s.clone(), &client).unwrap();
        let ready = sub.next().await;
        assert_eq!(ready.message["status"], "expired");
        assert_eq!(ready.state.count, 0);
        s.0.lock().unwrap().acknowledge(&client, ready.state.serial).unwrap();
        s.0.lock().unwrap().snapshot(Some(&client)).unwrap();
        let snapshot = sub.next().await;
        s.0.lock().unwrap().acknowledge(&client, snapshot.state.serial).unwrap();
        assert!(s.0.lock().unwrap().client(&client).unwrap().initialized);
    }
    #[test]
    fn ordinary_pages_retain_nothing_and_only_inactive_sessions_expire() {
        let s = shared(2, 4);
        for _ in 0..32 {
            s.0.lock().unwrap().new_client().unwrap();
        }
        assert!(s.0.lock().unwrap().clients.is_empty());
        let active = s.0.lock().unwrap().new_client().unwrap();
        let sub = Subscription::new(s.clone(), &active).unwrap();
        let abandoned = s.0.lock().unwrap().new_client().unwrap();
        s.0.lock().unwrap().acknowledge(&abandoned, 0).unwrap();
        let now = Instant::now();
        s.0.lock().unwrap().expire_clients(now + RECONNECT_GRACE - Duration::from_secs(1));
        assert_eq!(s.0.lock().unwrap().clients.len(), 2);
        s.0.lock().unwrap().expire_clients(now + RECONNECT_GRACE);
        assert_eq!(s.0.lock().unwrap().clients.len(), 1);
        assert_eq!(s.0.lock().unwrap().acknowledge(&abandoned, 1), Err(StatusCode::GONE));
        drop(sub);
        s.0.lock().unwrap().expire_clients(Instant::now() + RECONNECT_GRACE);
        assert!(s.0.lock().unwrap().clients.is_empty());
        assert_eq!(s.0.lock().unwrap().resources()["inventory"]["expiredClients"], 2);
    }
}
