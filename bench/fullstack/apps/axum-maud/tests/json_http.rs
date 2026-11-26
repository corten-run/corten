use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    convert::Infallible,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

static NEXT_APP: AtomicUsize = AtomicUsize::new(0);

struct App {
    child: Child,
    work: PathBuf,
    base: String,
    client: reqwest::Client,
}

impl App {
    async fn start(upstream: Option<&str>) -> Self {
        Self::start_with_profile(upstream, "default").await
    }

    async fn start_with_profile(upstream: Option<&str>, profile: &str) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let work = root.join("tests/work").join(format!("{}-{}", std::process::id(), NEXT_APP.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&work).unwrap();
        let marketplace: Value = serde_json::from_str(include_str!("marketplace.json")).unwrap();
        let fixture = work.join("marketplace.json");
        std::fs::write(&fixture, serde_json::to_vec(&json!({ "item_1": marketplace })).unwrap()).unwrap();
        let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let child = Command::new(env!("CARGO_BIN_EXE_item-page-axum-maud"))
            .current_dir(&root)
            .env("PORT", port.to_string())
            .env("PROFILE", profile)
            .env("CATALOG_SOURCE", if upstream.is_some() { "api" } else { "fixture" })
            .env("MARKETPLACE_SOURCE", if upstream.is_some() { "api" } else { "fixture" })
            .env("CATALOG_FIXTURE_PATH", root.join("tests/catalog.json"))
            .env("MARKETPLACE_FIXTURE_PATH", &fixture)
            .env("API_BASE", upstream.unwrap_or("http://127.0.0.1:1"))
            .env("ITEM_SOURCE", "api")
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut app = Self {
            child,
            work,
            base: format!("http://127.0.0.1:{port}"),
            client: reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(13)).build().unwrap(),
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if app.client.get(&app.base).send().await.is_ok() {
                return app;
            }
            assert!(app.child.try_wait().unwrap().is_none(), "app exited during startup");
            assert!(Instant::now() < deadline, "app did not start");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn request(&self, method: reqwest::Method, path: &str) -> reqwest::Response {
        self.client.request(method, format!("{}{path}", self.base)).send().await.unwrap()
    }
}

impl Drop for App {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        std::fs::remove_dir_all(&self.work).unwrap();
    }
}

fn expected(payload: &str) -> Value {
    if payload == "catalog" {
        serde_json::from_str::<Value>(include_str!("catalog.json")).unwrap()["record_1"].clone()
    } else {
        serde_json::from_str(include_str!("marketplace.json")).unwrap()
    }
}

async fn problem(response: reqwest::Response, status: StatusCode) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/problem+json");
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"title": status.canonical_reason().unwrap(), "status": status.as_u16()})
    );
}

#[tokio::test]
async fn fixture_json_preserves_complete_records_and_head() {
    let app = App::start(None).await;
    for (payload, id) in [("catalog", "record_1"), ("marketplace", "item_1")] {
        let path = format!("/api/{payload}/{id}");
        let response = app.request(reqwest::Method::GET, &path).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        let length = response.headers()[header::CONTENT_LENGTH].clone();
        assert_eq!(response.json::<Value>().await.unwrap(), expected(payload));
        let head = app.request(reqwest::Method::HEAD, &path).await;
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(head.headers()[header::CONTENT_LENGTH], length);
        assert!(head.bytes().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn fixture_pages_keep_native_templates_and_localization() {
    let app = App::start(None).await;
    let response = app.request(reqwest::Method::GET, "/catalog/record_1").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
    assert!(response.text().await.unwrap().contains("Ridge &lt;trail&gt; &amp;"));
    let labels: Value = serde_json::from_str(include_str!("../src/marketplace-labels.json")).unwrap();
    for tag in ["en-US", "fr-FR", "de-DE"] {
        let response = app.request(reqwest::Method::GET, &format!("/marketplace/{tag}/item_1")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let html = response.text().await.unwrap();
        assert!(html.contains(&format!("lang=\"{tag}\"")));
        assert!(html.contains(labels[tag]["listings"].as_str().unwrap()));
        assert_eq!(html.matches("data-listing-id=").count(), 4);
        assert_eq!(html.matches("data-offer-id=").count(), 5);
        let response = app
            .client
            .post(format!("{}/marketplace/{tag}/item_1", app.base))
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body("email=&target_price=")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.text().await.unwrap().contains(labels[tag]["invalid_email"].as_str().unwrap()));
    }
}

#[tokio::test]
async fn document_headers_are_only_on_successful_catalog_lean_pages() {
    let baseline = [
        ("content-security-policy", ""),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "strict-origin-when-cross-origin"),
        ("x-frame-options", "DENY"),
        ("cross-origin-opener-policy", "same-origin"),
        ("permissions-policy", ""),
        ("cache-control", "private, no-cache"),
    ];
    for profile in ["catalog-lean", "catalog-lean-extra"] {
        let app = App::start_with_profile(None, profile).await;
        for (path, status) in [
            ("/catalog/record_1?field=Ac", StatusCode::OK),
            ("/catalog/missing", StatusCode::NOT_FOUND),
            ("/api/catalog/record_1", StatusCode::OK),
            ("/static/catalog.css", StatusCode::OK),
            ("/", StatusCode::OK),
        ] {
            let response = app.request(reqwest::Method::GET, path).await;
            assert_eq!(response.status(), status, "{profile} {path}");
            let headers = response.headers();
            if profile == "catalog-lean" && path == "/catalog/record_1?field=Ac" {
                assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
                for (name, value) in baseline.into_iter().filter(|(_, value)| !value.is_empty()) {
                    assert_eq!(headers[name], value, "{name}");
                }
                let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
                assert!(csp.contains("script-src 'self'"));
                assert!(csp.contains("frame-ancestors 'none'"));
                assert!(!csp.contains("'unsafe-inline'"));
                assert!(headers["permissions-policy"].to_str().unwrap().starts_with("accelerometer=(), camera=()"));
            } else {
                for (name, _) in baseline {
                    assert!(!headers.contains_key(name), "{profile} {path}: unexpected {name}");
                }
            }
        }
    }
}

#[tokio::test]
async fn fixture_json_errors_and_methods_are_json() {
    let app = App::start(None).await;
    for payload in ["catalog", "marketplace"] {
        problem(app.request(reqwest::Method::GET, &format!("/api/{payload}/missing")).await, StatusCode::NOT_FOUND).await;
        let head = app.request(reqwest::Method::HEAD, &format!("/api/{payload}/missing")).await;
        assert_eq!(head.status(), StatusCode::NOT_FOUND);
        assert_eq!(head.headers()[header::CONTENT_TYPE], "application/problem+json");
        assert!(head.bytes().await.unwrap().is_empty());
        for method in [
            reqwest::Method::POST,
            reqwest::Method::PUT,
            reqwest::Method::PATCH,
            reqwest::Method::DELETE,
            reqwest::Method::OPTIONS,
        ] {
            let response = app.request(method, &format!("/api/{payload}/missing")).await;
            let allow = response.headers()[header::ALLOW].to_str().unwrap();
            let mut methods: Vec<_> = allow.split(',').map(str::trim).collect();
            methods.sort_unstable();
            assert_eq!(methods, ["GET", "HEAD"]);
            problem(response, StatusCode::METHOD_NOT_ALLOWED).await;
        }
        problem(app.request(reqwest::Method::GET, &format!("/api/{payload}/%FF")).await, StatusCode::BAD_REQUEST).await;
    }
}

#[derive(Clone, Default)]
struct Upstream {
    reads: Arc<Mutex<HashMap<String, usize>>>,
    cancelled: Arc<AtomicUsize>,
}

impl Upstream {
    fn reads(&self, payload: &str, id: &str) -> usize {
        *self.reads.lock().unwrap().get(&format!("{payload}/{id}")).unwrap_or(&0)
    }
}

struct SlowRead(Arc<AtomicUsize>);
impl Drop for SlowRead {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

async fn upstream(State(state): State<Upstream>, Path((payload, id)): Path<(String, String)>) -> Response {
    let read = {
        let mut reads = state.reads.lock().unwrap();
        let count = reads.entry(format!("{payload}/{id}")).or_default();
        *count += 1;
        *count
    };
    match id.as_str() {
        "missing" => StatusCode::NOT_FOUND.into_response(),
        "failed" => (StatusCode::SERVICE_UNAVAILABLE, "private upstream error").into_response(),
        "redirect" => (StatusCode::FOUND, [(header::LOCATION, format!("/{payload}/records/redirect-target"))]).into_response(),
        "invalid" => "{ malformed".into_response(),
        "incomplete" => axum::Json(json!({"title":"incomplete"})).into_response(),
        "wrong-type" => {
            let mut value = expected(&payload);
            value["tags"] = json!(42);
            axum::Json(value).into_response()
        }
        "slow" => {
            let read = SlowRead(state.cancelled);
            let body = stream::once(async { Ok::<_, Infallible>("{\"title\":") })
                .chain(stream::pending::<Result<&'static str, Infallible>>())
                .map(move |chunk| {
                    let _ = &read;
                    chunk
                });
            ([(header::CONTENT_TYPE, "application/json")], Body::from_stream(body)).into_response()
        }
        _ => {
            let mut value = expected(&payload);
            value["title"] = json!(format!("Fresh {read}"));
            value["unused_upstream_field"] = json!("must not pass through");
            ([(header::CONTENT_TYPE, "application/json")], serde_json::to_string_pretty(&value).unwrap()).into_response()
        }
    }
}

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn api_app() -> (App, Upstream, Server) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let state = Upstream::default();
    let router = Router::new().route("/{payload}/records/{id}", get(upstream)).with_state(state.clone());
    let server = Server(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    (App::start(Some(&base)).await, state, server)
}

#[tokio::test]
async fn api_json_fetches_parses_and_reserializes_once_per_get_and_head() {
    let (app, state, _server) = api_app().await;
    for payload in ["catalog", "marketplace"] {
        for read in 1..=2 {
            let response = app.request(reqwest::Method::GET, &format!("/api/{payload}/id%20%2F%3F")).await;
            assert_eq!(response.status(), StatusCode::OK);
            let mut value = expected(payload);
            value["title"] = json!(format!("Fresh {read}"));
            assert_eq!(response.json::<Value>().await.unwrap(), value);
            assert_eq!(state.reads(payload, "id /?"), read);
        }
        let response = app.request(reqwest::Method::HEAD, &format!("/api/{payload}/head")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert!(response.bytes().await.unwrap().is_empty());
        assert_eq!(state.reads(payload, "head"), 1);
    }
}

#[tokio::test]
async fn api_json_errors_are_json_and_redirects_are_not_followed() {
    let (app, state, _server) = api_app().await;
    for payload in ["catalog", "marketplace"] {
        for (id, status) in [
            ("missing", StatusCode::NOT_FOUND),
            ("failed", StatusCode::BAD_GATEWAY),
            ("invalid", StatusCode::BAD_GATEWAY),
            ("incomplete", StatusCode::BAD_GATEWAY),
            ("wrong-type", StatusCode::BAD_GATEWAY),
            ("redirect", StatusCode::BAD_GATEWAY),
        ] {
            problem(app.request(reqwest::Method::GET, &format!("/api/{payload}/{id}")).await, status).await;
            assert_eq!(state.reads(payload, id), 1);
        }
        assert_eq!(state.reads(payload, "redirect-target"), 0);
        let response = app.request(reqwest::Method::HEAD, &format!("/api/{payload}/failed")).await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/problem+json");
        assert!(response.bytes().await.unwrap().is_empty());
        assert_eq!(state.reads(payload, "failed"), 2);
        problem(app.request(reqwest::Method::POST, &format!("/api/{payload}/not-read")).await, StatusCode::METHOD_NOT_ALLOWED)
            .await;
        assert_eq!(state.reads(payload, "not-read"), 0);
    }
}

#[tokio::test]
async fn api_json_refuses_redirects_before_an_extra_read() {
    let (app, state, _server) = api_app().await;
    for payload in ["catalog", "marketplace"] {
        let response = app.request(reqwest::Method::GET, &format!("/api/{payload}/redirect")).await;
        assert_eq!(state.reads(payload, "redirect-target"), 0, "{payload}: redirect was followed");
        assert_eq!(state.reads(payload, "redirect"), 1);
        problem(response, StatusCode::BAD_GATEWAY).await;
    }
}

#[tokio::test]
async fn api_json_deadline_covers_the_full_body_read() {
    let (app, state, _server) = api_app().await;
    for (index, payload) in ["catalog", "marketplace"].into_iter().enumerate() {
        let start = Instant::now();
        problem(app.request(reqwest::Method::GET, &format!("/api/{payload}/slow")).await, StatusCode::BAD_GATEWAY).await;
        assert!(start.elapsed() < Duration::from_secs(12), "full-body deadline");
        assert_eq!(state.reads(payload, "slow"), 1);
        let deadline = Instant::now() + Duration::from_secs(2);
        while state.cancelled.load(Ordering::Relaxed) != index + 1 {
            assert!(Instant::now() < deadline, "deadline must cancel the upstream read");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let response = app.request(reqwest::Method::GET, &format!("/api/{payload}/recovery")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut value = expected(payload);
        value["title"] = json!("Fresh 1");
        assert_eq!(response.json::<Value>().await.unwrap(), value);
        assert_eq!(state.reads(payload, "recovery"), 1);
    }
}

/// How long the catalog and marketplace fixtures (`bench/catalog/upstream.mjs`,
/// `bench/marketplace/upstream.mjs`, Node's HTTP server) say they keep an idle connection open:
/// they answer with `Keep-Alive: timeout=5`.
const FIXTURE_KEEP_ALIVE: Duration = Duration::from_secs(5);

/// What the upstream did, in milliseconds from its start, on which of its connections.
#[derive(Clone, Debug, PartialEq)]
enum Seen {
    Accepted,
    Answered(String),
    /// A request arrived on a connection idle this long, and the connection closed unanswered.
    ClosedIdle(u128),
    ClosedByClient,
}

type Log = Arc<Mutex<Vec<(u128, usize, Seen)>>>;

/// The fixtures' idle close, made deterministic. A fixture closes a connection that has been idle
/// for its keep-alive timeout; a request written to it in that instant never reaches its handler.
/// Here every request that arrives on a connection idle for at least `keep_alive` meets that close:
/// the connection is dropped with the request unread, which resets it, and nothing answers. A
/// request on a fresh or recently used connection is answered with the body of the first
/// `(path prefix, body)` its path starts with, and the connection kept open. Each answer is logged
/// before it is written, and [`ClosingUpstream::stop`] joins every thread before the log is read,
/// so the log is complete when the test inspects it. Dropping it (also when a test fails early)
/// stops and joins every thread as well.
struct ClosingUpstream {
    at: String,
    started: Instant,
    stopping: Arc<AtomicBool>,
    accepting: Option<std::thread::JoinHandle<()>>,
    seen: Log,
}

impl ClosingUpstream {
    fn start(bodies: Vec<(&'static str, String)>, keep_alive: Duration) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let at = format!("http://{}", listener.local_addr().unwrap());
        let (started, seen, bodies, stopping) = (Instant::now(), Log::default(), Arc::new(bodies), Arc::<AtomicBool>::default());
        let (log, stop) = (seen.clone(), stopping.clone());
        let accepting = std::thread::spawn(move || {
            let (mut connections, mut failure) = (Vec::new(), None);
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        let (log, bodies, stop, connection) = (log.clone(), bodies.clone(), stop.clone(), connections.len());
                        connections.push(std::thread::spawn(move || {
                            serve_until_idle(socket, connection, &bodies, keep_alive, started, &log, &stop)
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
                    Err(error) => {
                        failure = Some(format!("accept: {error}"));
                        stop.store(true, Ordering::SeqCst);
                    }
                }
            }
            let panicked = connections.into_iter().map(std::thread::JoinHandle::join).filter(Result::is_err).count();
            assert!(failure.is_none() && panicked == 0, "{failure:?}; {panicked} connection threads panicked");
        });
        Self { at, started, stopping, accepting: Some(accepting), seen }
    }

    fn now(&self) -> u128 {
        self.started.elapsed().as_millis()
    }

    /// Stops accepting and waits for every thread to end: each connection's thread checks within
    /// [`POLL`] while it waits for a request, and a write gives up after [`WRITE`].
    fn halt(&mut self) -> std::thread::Result<()> {
        self.stopping.store(true, Ordering::SeqCst);
        self.accepting.take().map_or(Ok(()), std::thread::JoinHandle::join)
    }

    /// Stops, then returns everything the upstream did.
    fn stop(mut self) -> Vec<(u128, usize, Seen)> {
        self.halt().expect("an upstream thread panicked");
        self.seen.lock().unwrap().clone()
    }
}

impl Drop for ClosingUpstream {
    fn drop(&mut self) {
        // A panic here while a failed test unwinds would abort; that failure is already reported.
        if self.halt().is_err() && !std::thread::panicking() {
            panic!("an upstream thread panicked");
        }
    }
}

/// How often a connection's thread, waiting for a request, checks whether the upstream is stopping.
const POLL: Duration = Duration::from_millis(20);
/// How long a connection's thread waits to write an answer before it gives up.
const WRITE: Duration = Duration::from_secs(2);

/// The connections that answered a `line` request.
fn connections(seen: &[(u128, usize, Seen)], line: &str) -> Vec<usize> {
    let answered = Seen::Answered(line.into());
    let mut found: Vec<usize> = seen.iter().filter_map(|(_, c, s)| (*s == answered).then_some(*c)).collect();
    found.sort_unstable();
    found.dedup();
    found
}

/// The idle closes logged at or after `from` ms.
fn closed_since(seen: &[(u128, usize, Seen)], from: u128) -> usize {
    seen.iter().filter(|(at, _, s)| matches!(s, Seen::ClosedIdle(_)) && *at >= from).count()
}

fn serve_until_idle(
    mut socket: std::net::TcpStream,
    connection: usize,
    bodies: &[(&str, String)],
    keep_alive: Duration,
    started: Instant,
    log: &Log,
    stopping: &AtomicBool,
) {
    use std::io::{ErrorKind, Read, Write};
    let record = |seen| log.lock().unwrap().push((started.elapsed().as_millis(), connection, seen));
    let waiting = |error: &std::io::Error| matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut);
    let stopped = || stopping.load(Ordering::SeqCst);
    record(Seen::Accepted);
    socket.set_nonblocking(false).unwrap();
    socket.set_read_timeout(Some(POLL)).unwrap();
    socket.set_write_timeout(Some(WRITE)).unwrap();
    let mut answered: Option<Instant> = None;
    loop {
        match socket.peek(&mut [0]) {
            Ok(1) => {}
            Err(error) if waiting(&error) && !stopped() => continue,
            Err(error) if waiting(&error) => return,
            _ => return record(Seen::ClosedByClient),
        }
        if let Some(idle) = answered.map(|at| at.elapsed()).filter(|idle| *idle >= keep_alive) {
            return record(Seen::ClosedIdle(idle.as_millis()));
        }
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            match socket.read(&mut byte) {
                Ok(1) => head.push(byte[0]),
                Err(error) if waiting(&error) && !stopped() => {}
                Err(error) if waiting(&error) => return,
                other => panic!("the request head ended early: {other:?}"),
            }
        }
        let line = String::from_utf8(head).unwrap().lines().next().unwrap().to_string();
        let path = line.split(' ').nth(1).unwrap();
        let body = &bodies.iter().find(|(prefix, _)| path.starts_with(prefix)).unwrap().1;
        let length = body.len();
        record(Seen::Answered(line));
        write!(
            socket,
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {length}\r\nkeep-alive: timeout=5\r\n\r\n{body}"
        )
        .unwrap();
        answered = Some(Instant::now());
    }
}

/// A catalog page, a marketplace item and an item page whose upstream connections sat idle past
/// the upstreams' keep-alive are answered from new connections with one upstream request each, not
/// failed with a 502 (#1570). The item API (`bench/fullstack/item-api/server.mjs`) is Node's HTTP
/// server too, with the same 5 s. The control runs the same binary, handlers and clients against
/// an upstream that closes at 3 s, under the app's 4 s bound, and sends after 3.5 s idle: the pool
/// policy then outlasts the upstream's close, as reqwest's default 90 s did against the fixtures'
/// 5 s, and the reads on reused connections fail. (The app is a separate process, so the test
/// cannot give it the old policy without a setting the benchmark app does not have.)
#[tokio::test]
async fn api_reads_after_the_upstream_s_keep_alive_do_not_reuse_its_closed_connections() {
    const SHORT_KEEP_ALIVE: Duration = Duration::from_secs(3);
    let bodies = || {
        vec![
            ("/catalog/", expected("catalog").to_string()),
            ("/marketplace/", expected("marketplace").to_string()),
            ("/api/discovery/items/", r#"{"catalog_item_id":"item_1","title":"Item one","description":"An item"}"#.to_string()),
        ]
    };
    assert!(record_http_bound() < FIXTURE_KEEP_ALIVE && SHORT_KEEP_ALIVE + Duration::from_millis(500) < record_http_bound());
    let (upstream, short) =
        (ClosingUpstream::start(bodies(), FIXTURE_KEEP_ALIVE), ClosingUpstream::start(bodies(), SHORT_KEEP_ALIVE));
    let (app, unsafe_app) = (App::start(Some(&upstream.at)).await, App::start(Some(&short.at)).await);
    let reads = [
        ("/catalog/record_1", "GET /catalog/records/record_1 HTTP/1.1"),
        ("/api/marketplace/item_1", "GET /marketplace/records/item_1 HTTP/1.1"),
        ("/items/item_1", "GET /api/discovery/items/item_1 HTTP/1.1"),
    ];
    let read_all = async |app: &App| {
        let mut statuses = Vec::new();
        for (path, _) in reads {
            statuses.push(app.request(reqwest::Method::GET, path).await.status());
        }
        statuses
    };
    assert_eq!(read_all(&app).await, [StatusCode::OK; 3]);
    let warmed = Instant::now();
    assert_eq!(read_all(&unsafe_app).await, [StatusCode::OK; 3]);
    tokio::time::sleep(SHORT_KEEP_ALIVE + Duration::from_millis(500)).await;
    let short_sent = short.now();
    let failed = read_all(&unsafe_app).await;
    tokio::time::sleep((warmed + FIXTURE_KEEP_ALIVE + Duration::from_millis(250)).saturating_duration_since(Instant::now()))
        .await;
    let sent = upstream.now();
    let statuses = read_all(&app).await;
    let (seen, short_seen) = (upstream.stop(), short.stop());
    // The control: every read that met the close failed with a 502, and at least one did.
    let lost = failed.iter().filter(|status| **status == StatusCode::BAD_GATEWAY).count();
    assert!(failed.iter().all(|status| [StatusCode::OK, StatusCode::BAD_GATEWAY].contains(status)), "{failed:?}");
    assert!(lost > 0 && closed_since(&short_seen, short_sent) == lost, "{failed:?}, sent at {short_sent} ms: {short_seen:?}");
    assert_eq!(statuses, [StatusCode::OK; 3], "sent at {sent} ms; upstream: {seen:?}");
    for (path, line) in reads {
        assert_eq!(closed_since(&seen, sent), 0, "{path}: {seen:?}");
        let answers = seen.iter().filter(|(_, _, s)| *s == Seen::Answered(line.into())).count();
        assert_eq!(
            (answers, connections(&seen, line).len()),
            (2, 2),
            "{path}: one upstream request each, on a new connection: {seen:?}"
        );
    }
}

/// The app's pool bound (`UPSTREAM_IDLE` in `src/record_http.rs`, also used by `src/items.rs`),
/// which this integration test cannot import from the binary.
fn record_http_bound() -> Duration {
    let source = include_str!("../src/record_http.rs");
    let line = source.lines().find(|line| line.starts_with("pub const UPSTREAM_IDLE")).expect("UPSTREAM_IDLE");
    assert!(line.ends_with("Duration::from_secs(4);"), "{line}");
    Duration::from_secs(4)
}
