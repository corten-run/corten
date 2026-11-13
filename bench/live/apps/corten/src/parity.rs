//! Native Feed with a transparent, bounded fault/observation body. No alternate feed engine.
use crate::{parity_row::ParityRow, parity_screen::ParityScreen};
use bytes::Bytes;
use corten::{
    feed::{BACKLOG, Feed, FeedBody, FeedResponse, REPLAY, Row, Since},
    http::{Response, StatusCode},
    prelude::*,
};
use http_body::{Body, Frame};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    convert::Infallible,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};

#[derive(Clone, Serialize, Deserialize, Row, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    #[row(id)]
    pub id: String,
    pub version: u64,
    pub price_cents: u64,
    pub quantity: u64,
}

#[derive(Clone)]
pub struct Shared(Arc<Mutex<Probe>>);

struct Probe {
    feed: Feed<Listing>,
    held: bool,
    blocked: bool,
    close: u64,
    readers: HashMap<u64, Reader>,
    next_reader: u64,
    queue_peak: usize,
    history_peak: usize,
    reads: u64,
    drop_seq: Option<u64>,
}

struct Reader {
    delivered: u64,
    duplicate: Option<Bytes>,
    last_frame: Option<Bytes>,
    waker: Option<Waker>,
}

impl Probe {
    fn new(rows: Vec<Listing>) -> Self {
        Self {
            feed: Feed::new(rows),
            held: false,
            blocked: false,
            close: 0,
            readers: HashMap::new(),
            next_reader: 0,
            queue_peak: 0,
            history_peak: 0,
            reads: 0,
            drop_seq: None,
        }
    }
    fn queue(&self) -> usize {
        self.readers.values().map(|r| (self.feed.seq().saturating_sub(r.delivered) as usize).min(BACKLOG)).sum()
    }
    fn resources(&self) -> Value {
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let kb = |key: &str| {
            status
                .lines()
                .find_map(|l| l.strip_prefix(key).and_then(|v| v.split_whitespace().next()?.parse::<u64>().ok()))
                .unwrap_or(0)
                * 1024
        };
        let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
        let fields: Vec<_> = stat.rsplit_once(") ").map(|(_, tail)| tail.split_whitespace().collect()).unwrap_or_default();
        json!({"subscriptions":self.feed.subscribers(),"connections":self.readers.len(),"pendingTasks":self.readers.len(),
            "queueLimit":BACKLOG,"queueEvents":self.queue(),"queuePeak":self.queue_peak,
            "historyLimit":REPLAY+1,"historyEvents":self.feed.seq().min(REPLAY as u64),"historyPeak":self.history_peak,
            "snapshotReads":self.reads,
            "process":{"rssBytes":kb("VmRSS:"),"peakRssBytes":kb("VmHWM:"),
                "userTicks":fields.get(11).and_then(|v|v.parse::<u64>().ok()),"systemTicks":fields.get(12).and_then(|v|v.parse::<u64>().ok())},
            "inventory":{"engine":"corten_feed::Feed","accounting":"accepted writes minus body-emitted patches; fixed native ring/replay policies",
                "nativeReplayBytesLimit":8388608,"nativeReplayTransientEntriesLimit":REPLAY+1,
                "coalescedBatchEntriesLimit":65,"faultDuplicateSlots":self.readers.values().filter(|r|r.duplicate.is_some()).count(),
                "faultLastFrameSlots":self.readers.values().filter(|r|r.last_frame.is_some()).count(),"spawnedWriterTasks":0,"held":self.held}})
    }
}

pub async fn serve() -> std::io::Result<()> {
    let state = Shared(Arc::new(Mutex::new(Probe::new(Vec::new()))));
    corten::serve(App::new(url::router(state.clone())).components(&[ParityScreen, ParityRow]).api(|api| control::api(api, state)))
        .await
}

#[corten::routes(state = Shared)]
pub mod url {
    #[route("/", get = home)]
    pub struct Home;
    #[route("/parity/snapshot", get = snapshot, rows = Listing)]
    pub struct Snapshot;
    #[route("/parity/snapshot/live", get = live)]
    pub struct Live;
}

#[corten::routes(api = Root, state = Shared)]
mod control {
    #[route("/parity")]
    pub struct Root;
    #[route("/parity/configure", post = configure)]
    pub struct Configure;
    #[route("/parity/resources", get = resources)]
    pub struct Resources;
    #[route("/parity/publish", post = publish)]
    pub struct Publish;
    #[route("/parity/control", post = fault)]
    pub struct Control;
}

async fn home(req: Req, State(shared): State<Shared>) -> HtmlResult {
    let initial = shared.0.lock().unwrap().feed.read(|rows| rows.values().cloned().collect::<Vec<_>>());
    req.page(html! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <title>"Native feed parity"</title>
                <Corten />
            </head>
            <body><main><ParityScreen initial={&initial} /></main></body>
        </html>
    })
}

async fn snapshot(State(shared): State<Shared>) -> FeedResponse<Listing> {
    let mut p = shared.0.lock().unwrap();
    p.reads += 1;
    p.feed.snapshot()
}

async fn resources(State(shared): State<Shared>) -> Json<Value> {
    Json(shared.0.lock().unwrap().resources())
}

fn bad() -> corten::Error {
    corten::Error::status(StatusCode::BAD_REQUEST)
}

async fn configure(State(shared): State<Shared>, Json(input): Json<Value>) -> corten::Result<Json<Value>> {
    if input["queueLimit"] != BACKLOG || input["historyLimit"] != REPLAY + 1 {
        return Err(bad());
    }
    let rows = serde_json::from_value(input["initial"].clone()).map_err(|_| bad())?;
    let mut p = shared.0.lock().unwrap();
    if !p.readers.is_empty() || p.feed.subscribers() != 0 {
        return Err(corten::Error::status(StatusCode::CONFLICT));
    }
    *p = Probe::new(rows);
    Ok(Json(
        json!({"configured":true,"framework":"corten","version":env!("CARGO_PKG_VERSION"),"nativeBacklog":BACKLOG,"nativeReplay":REPLAY}),
    ))
}

async fn publish(State(shared): State<Shared>, Json(input): Json<Value>) -> corten::Result<Json<Value>> {
    let batch = input.get("events");
    let events = match (input.get("event"), batch) {
        (Some(event), None) => vec![event],
        (None, Some(Value::Array(events))) if !events.is_empty() && events.len() <= 1044 => events.iter().collect(),
        _ => return Err(bad()),
    };
    let mut p = shared.0.lock().unwrap();
    let patches: Vec<_> =
        events.iter().enumerate().map(|(i, event)| prepare(event, p.feed.seq() + i as u64 + 1)).collect::<corten::Result<_>>()?;
    let mut acks = Vec::with_capacity(patches.len());
    for (seq, patch) in patches {
        p.feed.apply(&patch).map_err(|_| bad())?;
        let reader_peak = p.readers.values().map(|r| (seq.saturating_sub(r.delivered) as usize).min(BACKLOG)).max().unwrap_or(0);
        p.queue_peak = p.queue_peak.max(reader_peak);
        // Native replay inserts before evicting, including its transient entry.
        p.history_peak = p.history_peak.max(seq.min(REPLAY as u64 + 1) as usize);
        if p.held && p.readers.values().any(|r| seq.saturating_sub(r.delivered) > BACKLOG as u64) {
            p.held = false;
        }
        for reader in p.readers.values_mut() {
            if let Some(waker) = reader.waker.take() {
                waker.wake();
            }
        }
        acks.push(json!({"seq":seq,"resources":p.resources()}));
    }
    Ok(Json(if batch.is_some() { json!({"acks":acks}) } else { acks.pop().unwrap() }))
}

fn prepare(event: &Value, expected: u64) -> corten::Result<(u64, String)> {
    let seq = event["seq"].as_u64().ok_or_else(bad)?;
    let key = event["key"].as_str().ok_or_else(bad)?;
    if event["effectId"].as_str().is_none() {
        return Err(bad());
    }
    let change = match event["op"].as_str() {
        Some("remove") => json!({"op":"remove","id":key}),
        Some("upsert") => {
            let row: Listing = serde_json::from_value(event["row"].clone()).map_err(|_| bad())?;
            if row.id != key {
                return Err(bad());
            }
            json!({"op":"upsert","id":key,"value":row})
        }
        _ => return Err(bad()),
    };
    if seq != expected {
        return Err(bad());
    }
    let patch = json!({"seq":seq,"changes":[change],"event":event}).to_string();
    Ok((seq, patch))
}

async fn fault(State(shared): State<Shared>, Json(input): Json<Value>) -> corten::Result<Json<Value>> {
    let mut p = shared.0.lock().unwrap();
    match input["action"].as_str() {
        Some("hold") => p.held = true,
        Some("drop") => p.drop_seq = Some(input["seq"].as_u64().ok_or_else(bad)?),
        Some("duplicate") => {
            for reader in p.readers.values_mut() {
                reader.duplicate = reader.last_frame.clone();
            }
        }
        Some("disconnect") => {
            p.blocked = true;
            p.close += 1;
        }
        Some("reconnect") => p.blocked = false,
        _ => return Err(bad()),
    }
    for reader in p.readers.values_mut() {
        if let Some(waker) = reader.waker.take() {
            waker.wake();
        }
    }
    Ok(Json(json!({"ok":true})))
}

async fn live(State(shared): State<Shared>, since: Since) -> corten::Result<corten::Relay> {
    let (parts, body) = observed(shared, since)?.into_parts();
    Ok(corten::Relay::new(parts.status, parts.headers, corten::http::Body::new(body)))
}

fn observed(shared: Shared, since: Since) -> corten::Result<Response<Observed>> {
    let mut p = shared.0.lock().unwrap();
    if p.blocked || p.readers.len() >= 16 {
        return Err(corten::Error::status(StatusCode::SERVICE_UNAVAILABLE));
    }
    let from = since.0.as_ref().map_or(0, |c| c.seq);
    let body = p.feed.live(since).into_http();
    let delivered = p.feed.seq();
    let id = p.next_reader;
    p.next_reader += 1;
    p.readers.insert(id, Reader { delivered, duplicate: None, last_frame: None, waker: None });
    let close = p.close;
    let (parts, body) = body.into_parts();
    Ok(Response::from_parts(parts, Observed { body, shared: shared.clone(), close, first: true, from, id }))
}

pub struct Observed {
    body: FeedBody,
    shared: Shared,
    close: u64,
    first: bool,
    from: u64,
    id: u64,
}
impl Drop for Observed {
    fn drop(&mut self) {
        let mut p = self.shared.0.lock().unwrap();
        p.readers.remove(&self.id);
    }
}
impl Body for Observed {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        let shared = self.shared.clone();
        let mut p = shared.0.lock().unwrap();
        p.readers.get_mut(&self.id).unwrap().waker = Some(cx.waker().clone());
        if p.close != self.close {
            return Poll::Ready(None);
        }
        if p.held {
            return Poll::Pending;
        }
        if let Some(bytes) = p.readers.get_mut(&self.id).unwrap().duplicate.take() {
            return Poll::Ready(Some(Ok(Frame::data(bytes))));
        }
        match Pin::new(&mut self.body).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                let Ok(bytes) = frame.into_data() else {
                    return Poll::Pending;
                };
                let text = std::str::from_utf8(&bytes).unwrap();
                let mut passed = String::new();
                if self.first {
                    self.first = false;
                    let status = if text.contains("cursor-expired") { "expired" } else { "accepted" };
                    let ready = json!({"from":self.from,"status":status,"resources":p.resources()});
                    passed.push_str(&format!("event: parity-ready\ndata: {ready}\n\n"));
                }
                for frame in text.split_inclusive("\n\n") {
                    let patch =
                        frame.lines().find_map(|l| l.strip_prefix("data: ").and_then(|s| serde_json::from_str::<Value>(s).ok()));
                    if let Some(seq) = patch.as_ref().and_then(|v| v["seq"].as_u64()) {
                        let reader = p.readers.get_mut(&self.id).unwrap();
                        reader.delivered = reader.delivered.max(seq);
                        if p.drop_seq == Some(seq) {
                            p.drop_seq = None;
                            continue;
                        }
                        p.readers.get_mut(&self.id).unwrap().last_frame = Some(Bytes::copy_from_slice(frame.as_bytes()));
                    }
                    passed.push_str(frame);
                }
                if passed.is_empty() {
                    cx.waker().wake_by_ref();
                    return Poll::Pending;
                }
                Poll::Ready(Some(Ok(Frame::data(Bytes::from(passed)))))
            }
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_routes_and_components_pass_startup_validation() {
        let state = Shared(Arc::new(Mutex::new(Probe::new(Vec::new()))));
        let _ = App::new(url::router(state.clone()))
            .components(&[ParityScreen, ParityRow])
            .api(|api| control::api(api, state))
            .router();
    }
    #[tokio::test]
    async fn native_publication_rejects_gaps_and_releases_subscriber() {
        let shared = Shared(Arc::new(Mutex::new(Probe::new(Vec::new()))));
        let event = json!({"seq":2,"effectId":"e","key":"x","op":"remove"});
        assert!(publish(State(shared.clone()), Json(json!({"event":event}))).await.is_err());
        assert_eq!(shared.0.lock().unwrap().feed.seq(), 0);
        let feed = shared.0.lock().unwrap().feed.clone();
        let response = feed.live(Since(None));
        assert_eq!(feed.subscribers(), 1);
        drop(response);
        assert_eq!(feed.subscribers(), 0);
    }

    #[tokio::test]
    async fn native_batch_prevalidates_every_write_and_returns_each_actual_ack() {
        let shared = Shared(Arc::new(Mutex::new(Probe::new(Vec::new()))));
        let event = |seq| json!({"seq":seq,"effectId":format!("e{seq}"),"key":"x","op":"remove"});
        for input in [json!({"events":[]}), json!({"events":[event(1),event(3)]}), json!({"event":event(1),"events":[event(1)]})]
        {
            assert!(publish(State(shared.clone()), Json(input)).await.is_err());
            assert_eq!(shared.0.lock().unwrap().feed.seq(), 0);
        }
        let Json(result) = publish(State(shared.clone()), Json(json!({"events":[event(1),event(2)]}))).await.unwrap();
        assert_eq!(result["acks"][0]["seq"], 1);
        assert_eq!(result["acks"][1]["seq"], 2);
        assert_eq!(result["acks"][0]["resources"]["historyEvents"], 1);
        assert_eq!(result["acks"][1]["resources"]["historyEvents"], 2);
    }

    #[tokio::test]
    async fn held_real_native_body_lags_and_expired_cursor_uses_native_sync() {
        let shared = Shared(Arc::new(Mutex::new(Probe::new(Vec::new()))));
        let feed = shared.0.lock().unwrap().feed.clone();
        let cursor = || Since(Some(corten::feed::Cursor { epoch: feed.generation().to_string(), seq: 0 }));
        let mut body = observed(shared.clone(), cursor()).unwrap().into_body();
        let _ = std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await;
        let _ = fault(State(shared.clone()), Json(json!({"action":"hold"}))).await.unwrap();
        for seq in 1..=BACKLOG + 1 {
            let _ = publish(
                State(shared.clone()),
                Json(json!({"event":{"seq":seq,"effectId":format!("e{seq}"),"key":"x","op":"remove"}})),
            )
            .await
            .unwrap();
        }
        {
            let p = shared.0.lock().unwrap();
            assert_eq!(p.queue_peak, BACKLOG);
            assert_eq!(p.history_peak, REPLAY + 1);
            assert_eq!(feed.subscribers(), 1);
        }
        let frame = std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await.unwrap().unwrap().into_data().unwrap();
        assert!(std::str::from_utf8(&frame).unwrap().contains("replay-backpressure"));
        drop(body);
        assert_eq!(feed.subscribers(), 0);
        assert!(shared.0.lock().unwrap().readers.is_empty());
        let mut expired = observed(shared.clone(), cursor()).unwrap().into_body();
        let frame = std::future::poll_fn(|cx| Pin::new(&mut expired).poll_frame(cx)).await.unwrap().unwrap().into_data().unwrap();
        assert!(std::str::from_utf8(&frame).unwrap().contains("cursor-expired"));
        drop(expired);
        assert_eq!(feed.subscribers(), 0);
    }
}
