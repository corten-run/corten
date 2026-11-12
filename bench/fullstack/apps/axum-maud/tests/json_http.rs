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
        atomic::{AtomicUsize, Ordering},
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
            .env("PROFILE", "default")
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
