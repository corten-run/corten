use super::*;
use crate::answer::ForOne;
use crate::cache::Cache;
use crate::security::cookie::SetCookie;
use crate::view::{html, Render};
use axum::{body::Body, http::Request, routing::get, Router};
use http_body_util::BodyExt;
use std::time::Duration;
use tower::ServiceExt;

fn demo(text: &str) -> impl Render + '_ {
    html! {
        <p>{text}</p>
        <sort-table><b>"x"</b></sort-table>
        <corten-live src="/x"></corten-live>
    }
}

/// A path of the test's own under the system's temp directory (`corten-{name}-{pid}`): any
/// leftover there is removed when it is made, the test creates what it writes, and the directory
/// is removed when dropped, a failing test's included, so a test run leaves nothing behind. Each
/// test uses a name no other test does.
pub(crate) struct Scratch(std::path::PathBuf);

impl Scratch {
    pub(crate) fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("corten-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        Scratch(path)
    }
}

impl std::ops::Deref for Scratch {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        &self.0
    }
}

impl AsRef<std::path::Path> for Scratch {
    fn as_ref(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Typed routes with no parameters, for the tests' areas and APIs: `paths! { Api = "/api" }`.
macro_rules! paths {
    ($($name:ident = $path:tt),* $(,)?) => {$(
        #[derive(crate::Route)]
        #[route($path)]
        struct $name;
    )*};
}

paths! {
    ApiRoot = "/api",
    ApiMissing = "/api/missing",
    ApiDown = "/api/down",
    ApiTeapot = "/api/teapot",
    ApiSlow = "/api/slow",
    ApiPost = "/api/post",
    ApiRates = "/api/rates",
    ApiSignUp = "/api/sign-up",
    ApiItems = "/api/items",
    PayApi = "/pay/api",
    PayApiGo = "/pay/api/go",
    Items = "/items",
    Admin = "/admin",
    AdminSlow = "/admin/slow",
    AdminQuick = "/admin/quick",
    AdminQuickSlow = "/admin/quick/slow",
    AdminOther = "/admin/other",
    AdminOtherSlow = "/admin/other/slow",
    AdminHooks = "/admin/hooks",
    AdminHooksPing = "/admin/hooks/ping",
}

std::thread_local! {
    /// How many times this test's thread looked up a [`Viewer`] (each `#[tokio::test]` runs on
    /// its own thread).
    static LOOKUPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The signed-in user, found by the `viewer` header or, as an app finds its session, the
/// `viewer` cookie.
#[derive(Clone, Hash, PartialEq, Debug)]
struct Viewer(&'static str);

impl<S: Sync> crate::Identify<S> for Viewer {
    async fn identify(parts: &axum::http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
        LOOKUPS.with(|n| n.set(n.get() + 1));
        let header = parts.headers.get("viewer").and_then(|v| v.to_str().ok());
        match header.or_else(|| crate::security::cookie::get(&parts.headers, "viewer")) {
            None => Err(crate::Refused::sign_in(&caller_url::SignIn)),
            Some("down") => Err(crate::Refused::unavailable("the session store is down")),
            Some(name) => Ok(Viewer(name.to_owned().leak())),
        }
    }
}

/// Sends every request as `viewer`, by the header [`Viewer`] reads.
struct AsViewer(Option<&'static str>);

impl crate::Middleware for AsViewer {
    async fn call(&self, mut req: axum::extract::Request, next: impl crate::Next) -> Response {
        if let Some(name) = self.0 {
            req.headers_mut().insert("viewer", axum::http::HeaderValue::from_static(name));
        }
        next.run(req).await
    }
}

/// Stamps every answer with a request id and two `Server-Timing` values, and answers 429 with
/// `Retry-After` itself when asked to by `x-flood`.
struct Stamp;

impl crate::Middleware for Stamp {
    async fn call(&self, req: axum::extract::Request, next: impl crate::Next) -> Response {
        use axum::http::{header, HeaderValue};
        let mut res = if req.headers().contains_key("x-flood") {
            let mut res = crate::Error::status(StatusCode::TOO_MANY_REQUESTS).into_response();
            res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("7"));
            res
        } else {
            next.run(req).await
        };
        let headers = res.headers_mut();
        headers.insert("x-request-id", HeaderValue::from_static("r-1"));
        headers.append("server-timing", HeaderValue::from_static("app;dur=1"));
        headers.append("server-timing", HeaderValue::from_static("db;dur=2"));
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=600"));
        res
    }
}

/// A failure that becomes the error page keeps what the handler and the middleware said besides
/// the body (a request id, `Retry-After`, every `Server-Timing` value), in every mode; the error
/// page's own type and `Cache-Control` win.
#[tokio::test]
async fn the_error_page_keeps_the_headers_of_the_failure_it_replaces() {
    use axum::http::header;
    let routes = Router::new().route(
        "/busy",
        get(|| async { (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "30"), (header::CONTENT_TYPE, "text/x-old")]) }),
    );
    let router = App::new(Routes::from(routes)).error_page(test_error_page, ()).middleware(Stamp).router();
    for mode in [None, Some("nav")] {
        for (uri, flood, status, retry) in
            [("/nope", false, 404, None), ("/busy", false, 429, Some("30")), ("/nope", true, 429, Some("7"))]
        {
            let mut req = Request::get(uri).header("accept", "text/html");
            if let Some(mode) = mode {
                req = req.header("corten", mode);
            }
            if flood {
                req = req.header("x-flood", "1");
            }
            let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let at = format!("{mode:?} {uri} flood={flood}");
            assert_eq!(res.status().as_u16(), status, "{at}");
            let headers = res.headers();
            assert_eq!(headers["x-request-id"], "r-1", "{at}");
            let timing: Vec<_> = headers.get_all("server-timing").iter().collect();
            assert_eq!(timing, ["app;dur=1", "db;dur=2"], "{at}");
            assert_eq!(headers.get(header::RETRY_AFTER).map(|v| v.to_str().unwrap()), retry, "{at}");
            assert!(headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/html"), "{at}: {headers:?}");
            assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache", "{at}: an error page is never shared");
            let body = res.into_body().collect().await.unwrap().to_bytes();
            assert!(String::from_utf8_lossy(&body).contains("<h1>"), "{at}: the error page");
        }
    }
}

/// The tests' layout: the page's title and head tags, and a header that marks the current page.
#[crate::component]
pub(crate) fn Shell(req: &Req, title: &str, head: impl Render, children: impl Render) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()}>
            <head>
                <meta charset="utf-8">
                <title>{title}</title>
                {head}
                <Corten />
            </head>
            <body>
                <header><a {..req.nav(&Root)}>"home"</a></header>
                <main>{children}</main>
            </body>
        </html>
    }
}

/// `req.page` in the tests' layout with no head tags of the page's own.
pub(crate) trait TestPage {
    fn test_page(&self, title: &str, main: impl Render) -> HtmlResult {
        self.test_page_for(title, main)
    }

    /// The page for whoever its handler answers: inside a `Public`, everyone.
    fn test_page_for<For>(&self, title: &str, main: impl Render) -> crate::Result<HtmlResponse<For>>;
}

impl TestPage for Req {
    fn test_page_for<For>(&self, title: &str, main: impl Render) -> crate::Result<HtmlResponse<For>> {
        self.page(Shell { req: self, title, head: "", children: main })
    }
}

/// The tests' error page, in their layout, for who is asking, with the error under `corten dev`.
async fn test_error_page(failure: Failure, req: Req, viewer: Option<crate::Caller<Viewer>>) -> HtmlResult {
    let viewer = viewer.map(|crate::Caller(Viewer(name))| name);
    req.page(test_error_document(&req, failure, viewer))
}

fn test_error_document<'a>(req: &'a Req, failure: Failure, viewer: Option<&'static str>) -> impl Document + 'a {
    let title = match (&failure, failure.status()) {
        (Failure::Unidentified { .. }, _) => "Who you are cannot be checked",
        (_, StatusCode::NOT_FOUND) => "Not found",
        (_, StatusCode::FORBIDDEN) => "Not allowed",
        _ => "Something went wrong",
    };
    let detail = failure.detail().map(str::to_owned);
    Shell {
        req,
        title,
        head: "",
        children: html! {
            <h1>{title}</h1>
            if let Some(viewer) = viewer {
                <p>"Signed in as "{viewer}</p>
            }
            if let Some(detail) = &detail {
                <pre>{detail}</pre>
            }
        },
    }
}

#[derive(crate::Route)]
#[route("/")]
struct Root;

#[derive(crate::Route)]
#[route("/done")]
struct Done;

fn meta_content<'a>(html: &'a str, name: &str) -> &'a str {
    let prefix = format!(r#"<meta name="{name}" content=""#);
    let start = html.find(&prefix).expect("meta tag") + prefix.len();
    &html[start..start + html[start..].find('"').unwrap()]
}

async fn call(router: Router, method: &str, mode: Option<&str>) -> (StatusCode, axum::http::HeaderMap, String) {
    call_with(router, method, "/", mode, None).await
}

async fn call_with(
    router: Router,
    method: &str,
    uri: &str,
    mode: Option<&str>,
    accept: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, String) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(mode) = mode {
        req = req.header("corten", mode);
    }
    if let Some(accept) = accept {
        req = req.header("accept", accept);
    }
    let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (parts.status, parts.headers, String::from_utf8(bytes.to_vec()).unwrap())
}

fn routes() -> Router {
    Router::new().route(
        "/",
        get(|req: Req| async move {
            let head = html! { <meta name="description" content="About A"> };
            req.page::<ForOne>(Shell { req: &req, title: "A & B", head, children: demo("<script>") })
        })
        .post(|req: Req| async move {
            req.patch_or(html! { <p id={MsgId}>"saved"</p> }, || async { req.redirect::<ForOne>(&Done) }).await
        }),
    )
}

/// The app as `App` assembles it, with the tests' error page, every request sent as `viewer`.
fn app(routes: Router, viewer: Option<&'static str>) -> Router {
    App::new(Routes::from(routes)).error_page(test_error_page, ()).middleware(AsViewer(viewer)).router()
}

/// The status and body of `GET uri` with `Host: host` (none when empty), plus `extra` headers.
async fn for_host(router: &Router, uri: &str, host: &str, extra: &[(&str, &str)]) -> (StatusCode, String) {
    let mut req = Request::get(uri);
    if !host.is_empty() {
        req = req.header("host", host);
    }
    for (name, value) in extra {
        req = req.header(*name, *value);
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let status = res.status();
    (status, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
}

/// A DNS-rebound page names a host the app is not: every route, in every mode, answers 421 and
/// runs nothing of the app's, not even its error page.
#[tokio::test]
async fn a_request_for_another_host_is_misdirected_in_every_mode() {
    let routes = Router::new().route("/", get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) }));
    let router = App::new(Routes::from(routes))
        .error_page(test_error_page, ())
        .api::<ApiRoot>(|api| api.route::<ApiRates>(crate::Methods::reads(get(|| async { "rates" }))))
        .router();
    let rebound = "rebound.attacker.example:3917";
    for (uri, extra) in [
        ("/", &[][..]),
        ("/", &[("corten", "nav")][..]),
        ("/", &[("accept", "application/json")][..]),
        ("/missing", &[("accept", "text/html")][..]),
        ("/api/rates", &[][..]),
        ("/health/live", &[][..]),
    ] {
        let (status, body) = for_host(&router, uri, rebound, extra).await;
        assert_eq!((status, body.as_str()), (StatusCode::MISDIRECTED_REQUEST, "Misdirected request."), "{uri} {extra:?}");
    }
    for host in ["localhost:3917", "127.0.0.1:3917", "[::1]:3917", ""] {
        assert_eq!(for_host(&router, "/", host, &[]).await.0, StatusCode::OK, "{host:?}");
    }
    let named = App::new(Routes::from(Router::new().route("/", get(|| async { "home" }))))
        .policy(crate::security::Policy::new().host("shop.example"))
        .router();
    assert_eq!(for_host(&named, "/", "shop.example", &[]).await.0, StatusCode::OK);
    assert_eq!(for_host(&named, "/", "www.shop.example", &[]).await.0, StatusCode::MISDIRECTED_REQUEST);
    let any = App::new(Routes::from(Router::new().route("/", get(|| async { "home" }))))
        .policy(crate::security::Policy::new().any_host())
        .router();
    assert_eq!(for_host(&any, "/", rebound, &[]).await.0, StatusCode::OK);
}

#[tokio::test]
async fn a_live_stream_that_finishes_tells_the_element_to_stop() {
    let router = Router::new()
        .route("/", get(|| async { crate::live(futures_util::stream::iter([String::from(r#"<p id="late">Ready</p>"#)])) }));
    let (status, headers, body) = call(router, "GET", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "text/event-stream");
    assert_eq!(headers["x-accel-buffering"], "no", "nginx passes each patch on as it is written");
    assert_eq!(body, "event: patch\ndata: <p id=\"late\">Ready</p>\n\nevent: end\ndata: end\n\n");
}

/// `live_watch` sends the current value only to a page that is behind, then each change, and
/// ends when the value's sender goes.
#[tokio::test]
async fn a_live_watch_sends_the_latest_value_from_where_the_page_is() {
    use crate::LiveSince;
    let (tx, rx) = tokio::sync::watch::channel(7u64);
    let stream = |since: Option<&str>| {
        let since = LiveSince(since.map(str::to_string));
        crate::live_watch(rx.clone(), since, |n| n.to_string(), |n| format!(r#"<p id="n">{n}</p>"#))
    };
    let (behind, current) = (stream(Some("6")), stream(Some("7")));
    let first = stream(None);
    tx.send_replace(8);
    tx.send_replace(9); // the browser only needs the latest: 8 is skipped
    drop(tx);
    let body = |res: LiveResponse| async move {
        String::from_utf8(res.into_response().into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
    };
    let nine = "event: patch\nid: 9\ndata: <p id=\"n\">9</p>\n\nevent: end\ndata: end\n\n";
    assert_eq!(body(current).await, nine, "a page showing 7 gets the next change");
    assert_eq!(body(behind).await, nine, "a page behind gets the latest");
    assert_eq!(body(first).await, nine);
    let (tx, rx) = tokio::sync::watch::channel(7u64);
    let behind = crate::live_watch(rx, LiveSince(Some("6".into())), |n| n.to_string(), |n| format!(r#"<p id="n">{n}</p>"#));
    let read = tokio::spawn(body(behind));
    tokio::task::yield_now().await;
    drop(tx);
    assert_eq!(
        read.await.unwrap(),
        "event: patch\nid: 7\ndata: <p id=\"n\">7</p>\n\nevent: end\ndata: end\n\n",
        "the current one first"
    );

    // A receiver kept in the app's state never reads, so a clone of it has not seen 8: a page
    // showing 8 still gets nothing until the next change.
    let (tx, kept) = tokio::sync::watch::channel(7u64);
    tx.send_replace(8);
    let current = crate::live_watch(kept.clone(), LiveSince(Some("8".into())), |n| *n, |n| format!(r#"<p id="n">{n}</p>"#));
    drop(tx);
    assert_eq!(body(current).await, "event: end\ndata: end\n\n", "nothing to send");
}

/// What a change costs `live_watch` with many pages open: `WATCH_STREAMS` (300) streams of a
/// table of 50 rows (3,132 bytes) and `WATCH_CHANGES` (200) changes, each sent once every stream
/// has the one before. The channel holds what the live data guide advises, the cursor, the rows in
/// an `Arc` and their HTML, and each page's view renders the rows or copies the HTML out. Prints
/// the median and slowest time from a change to the last stream having it. `WATCH_ROUNDS` (3)
/// rounds of `WATCH_MODE` (`per-stream`, `once`, or both when unset); counting one mode at two
/// numbers of changes under callgrind gives its instructions per change. Run in release:
/// `cargo test --release -p corten --lib -- --ignored --nocapture what_a_change_costs_live_watch`
#[test]
#[ignore]
fn what_a_change_costs_live_watch() {
    use crate::LiveSince;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    struct Row {
        name: String,
        price: u64,
        change: i64,
    }
    fn rows(version: u64) -> Vec<Row> {
        (0..50)
            .map(|n| Row { name: format!("Stock {n}"), price: 1_000 + version * 7 + n, change: (version as i64 % 9) - 4 })
            .collect()
    }
    fn table(rows: &[Row]) -> String {
        html! {
            <table id="quotes">
                <tbody>
                    for row in rows {
                        <tr>
                            <th scope="row">{&row.name}</th>
                            <td>{row.price}</td>
                            <td>{row.change}</td>
                        </tr>
                    }
                </tbody>
            </table>
        }
        .to_html()
    }
    type Quotes = (u64, Arc<Vec<Row>>, Arc<str>);
    let var = |name: &str, or: usize| std::env::var(name).ok().and_then(|n| n.parse().ok()).unwrap_or(or);
    let (streams, changes) = (var("WATCH_STREAMS", 300), var("WATCH_CHANGES", 200));
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let mode = std::env::var("WATCH_MODE").unwrap_or_default();
    let modes: Vec<bool> = [false, true].into_iter().filter(|once| mode.is_empty() || (mode == "once") == *once).collect();
    for round in 1..=var("WATCH_ROUNDS", 3) {
        for once in modes.iter().copied() {
            let (times, renders) = runtime.block_on(async {
                let renders = Arc::new(AtomicUsize::new(0));
                // The task that changes the quotes; rendered once, it renders them too.
                let quotes = |version: u64| -> Quotes {
                    let rows = Arc::new(rows(version));
                    let html = if once { Arc::from(table(&rows)) } else { Arc::from("") };
                    (version, rows, html)
                };
                let (tx, rx) = tokio::sync::watch::channel(quotes(0));
                // Each stream says when it has a change, so waiting for them costs nothing.
                let (got, mut arrived) = tokio::sync::mpsc::unbounded_channel::<()>();
                let mut readers = Vec::new();
                for _ in 0..streams {
                    let renders = renders.clone();
                    let since = LiveSince(Some("0".into()));
                    let res = if once {
                        crate::live_watch(rx.clone(), since, |(v, _, _): &Quotes| *v, |(_, _, html): &Quotes| html.to_string())
                    } else {
                        crate::live_watch(
                            rx.clone(),
                            since,
                            |(v, _, _): &Quotes| *v,
                            move |(_, rows, _): &Quotes| {
                                renders.fetch_add(1, Ordering::Relaxed);
                                table(rows)
                            },
                        )
                    };
                    let got = got.clone();
                    readers.push(tokio::spawn(async move {
                        let mut body = res.into_response().into_body();
                        while let Some(Ok(frame)) = body.frame().await {
                            // One event a frame: its first bytes say which.
                            if frame.data_ref().is_some_and(|data| data.starts_with(b"event: patch")) {
                                let _ = got.send(());
                            }
                        }
                    }));
                }
                let mut times = Vec::with_capacity(changes);
                for version in 1..=changes as u64 {
                    let started = std::time::Instant::now();
                    tx.send_replace(quotes(version));
                    for _ in 0..streams {
                        arrived.recv().await.unwrap();
                    }
                    times.push(started.elapsed());
                }
                drop((tx, got));
                for reader in readers {
                    reader.await.unwrap();
                }
                times.sort();
                (times, renders.load(Ordering::Relaxed))
            });
            // Rendered once: the first and one a change, by the task.
            let renders = if once { changes + 1 } else { renders };
            println!(
                "round {round}, {}: {streams} streams, {changes} changes, {renders} renders: a change reached every stream in {:?} at the median, {:?} at the slowest",
                if once { "rendered once" } else { "rendered per stream" },
                times[times.len() / 2],
                times[times.len() - 1]
            );
        }
    }
}

/// Named events of the app's own JSON, each with its cursor when it has one; a line break in the
/// JSON is split into data lines, which a client joins back.
#[cfg(feature = "json")]
#[tokio::test]
async fn an_event_stream_sends_named_json_with_its_cursor() {
    use crate::StreamEvent;
    #[derive(crate::ToJson)]
    struct Batch {
        done: u32,
        note: &'static str,
    }
    let messages = || {
        futures_util::stream::iter([
            StreamEvent::new("batch", &Batch { done: 3, note: "a" }).cursor("v3"),
            StreamEvent::new("error", "no such batch"),
            StreamEvent::new("raw", &crate::json::Raw::new(b"{\n\"a\": 1}".to_vec()).unwrap()),
        ])
    };
    let router = Router::new().route("/", get(move || async move { crate::event_stream(messages()) }));
    let (status, headers, body) = call(router, "GET", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "text/event-stream");
    assert_eq!(headers["x-accel-buffering"], "no");
    assert_eq!(
        body,
        "event: batch\nid: v3\ndata: {\"done\":3,\"note\":\"a\"}\n\nevent: error\ndata: \"no such batch\"\n\nevent: raw\ndata: {\ndata: \"a\": 1}\n\n",
        "no end event of Corten's: the app's script reads only its own"
    );
}

#[cfg(all(feature = "json", debug_assertions))]
#[test]
#[should_panic(expected = "one line of text that is not empty")]
fn an_event_name_is_one_line() {
    let _ = crate::StreamEvent::new("batch\nevent: other", &1);
}

#[cfg(all(feature = "json", debug_assertions))]
#[test]
#[should_panic(expected = "one line of text that is not empty")]
fn an_event_name_is_not_empty() {
    let _ = crate::StreamEvent::new("", &1);
}

/// In release, an event whose name would break the stream is not sent; the others are.
#[cfg(all(feature = "json", not(debug_assertions)))]
#[tokio::test]
async fn an_event_with_a_broken_name_is_not_sent() {
    use crate::StreamEvent;
    let events = || {
        futures_util::stream::iter([
            StreamEvent::new("batch\nevent: other", &1),
            StreamEvent::new("", &2),
            StreamEvent::new("kept", &3),
        ])
    };
    let router = Router::new().route("/", get(move || async move { crate::event_stream(events()) }));
    let (_, _, body) = call(router, "GET", None).await;
    assert_eq!(body, "event: kept\ndata: 3\n\n");
}

/// An event stream in a routes module: a failure before it starts is JSON, as on any JSON route,
/// and a stream that is over answers a reconnect `204`, which an `EventSource` does not retry.
#[cfg(feature = "json")]
#[tokio::test]
async fn an_event_stream_route_fails_as_json_and_ends_with_204() {
    let router = App::new(event_stream_url::router()).router();
    let (status, headers, body) = call_with(router.clone(), "GET", "/jobs/7/progress", None, Some("text/html")).await;
    assert_eq!(
        (status, headers["content-type"].to_str().unwrap()),
        (StatusCode::NOT_FOUND, "application/problem+json"),
        "{body}"
    );
    let (status, _, body) = call_with(router.clone(), "GET", "/jobs/1/progress", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "event: progress\nid: 3\ndata: 3\n\n"));
    let res =
        router.oneshot(Request::get("/jobs/1/progress").header("last-event-id", "3").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
}

#[cfg(feature = "json")]
#[crate::routes]
mod event_stream_url {
    #[route("/jobs/{job}/progress", get = job_progress)]
    pub struct JobProgress {
        pub job: u32,
    }
}

#[cfg(feature = "json")]
async fn job_progress(
    crate::Params(at): crate::Params<event_stream_url::JobProgress>,
    since: crate::LiveSince,
) -> Result<crate::EventStreamResponse, JsonError> {
    if at.job != 1 {
        return Err(Error::status(StatusCode::NOT_FOUND).into());
    }
    if since.0.as_deref() == Some("3") {
        return Ok(crate::EventStreamResponse::ended());
    }
    Ok(crate::event_stream(futures_util::stream::iter([crate::StreamEvent::new("progress", &3).cursor("3")])))
}

#[tokio::test]
async fn a_live_fragment_carries_its_cursor_and_a_reconnect_reads_it_back() {
    use crate::{Fragment, LiveSince};
    let fragments = || {
        futures_util::stream::iter([
            Fragment::new(r#"<p id="n">7</p>"#.into()).cursor("v7"),
            Fragment::new(r#"<p id="n">8</p>"#.into()),
        ])
    };
    let router = Router::new().route("/", get(move || async move { crate::live(fragments()) }));
    let (_, _, body) = call(router, "GET", None).await;
    // The id carries over in the browser to a fragment that has none, as SSE defines.
    assert_eq!(
        body,
        "event: patch\nid: v7\ndata: <p id=\"n\">7</p>\n\nevent: patch\ndata: <p id=\"n\">8</p>\n\nevent: end\ndata: end\n\n"
    );

    let since = |uri: &str, header: Option<&str>| {
        let mut req = Request::builder().uri(uri);
        if let Some(header) = header {
            req = req.header("last-event-id", header);
        }
        let (mut parts, ()) = req.body(()).unwrap().into_parts();
        async move { <LiveSince as axum::extract::FromRequestParts<()>>::from_request_parts(&mut parts, &()).await.unwrap().0 }
    };
    assert_eq!(since("/live", None).await, None, "a first connection without since");
    assert_eq!(since("/live?since=a%20b&x=1", None).await.as_deref(), Some("a b"), "the page's cursor");
    assert_eq!(since("/live?since=page", Some("v9")).await.as_deref(), Some("v9"), "a reconnect's cursor wins");
    assert_eq!(since("/live?since=page", Some("")).await.as_deref(), Some("page"), "an empty Last-Event-ID is none");
}

#[test]
#[cfg(debug_assertions)]
#[should_panic(expected = "line break")]
fn a_cursor_cannot_end_its_event() {
    let _ = crate::Fragment::new(String::new()).cursor("a\nevent: patch");
}

#[test]
#[cfg(not(debug_assertions))]
fn a_cursor_that_would_end_its_event_is_left_off_in_release() {
    assert_eq!(crate::Fragment::new(String::new()).cursor("a\nevent: patch").cursor, None);
}

#[tokio::test]
async fn a_bare_router_renders_the_page_s_document_without_a_policy() {
    let (status, headers, body) = call(routes(), "GET", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["vary"], "corten, accept");
    assert!(body.starts_with(r#"<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">"#), "{body}");
    assert!(body.contains(r#"<title>A &amp; B</title><meta name="description" content="About A" data-corten-head>"#));
    assert!(body.contains(&format!(r#"<script type="module" src="{}"></script>"#, runtime_path())));
    assert!(!body.contains("modulepreload"), "a page without handlers preloads no scripts");
    assert!(body.contains("<p>&lt;script&gt;</p>"), "page text is escaped");
    assert!(!body.contains("nonce"), "no policy, no nonce");
}

#[tokio::test]
async fn navigation_returns_title_head_tags_and_page_only() {
    let (_, headers, body) = call(app(routes(), None), "GET", Some("nav")).await;
    assert_eq!(headers["corten-page"], "1");
    assert!(body.starts_with(r#"<title>A &amp; B</title><meta name="description" content="About A" data-corten-head><p>"#));
    assert!(!body.contains("<html"), "{body}");
}

#[tokio::test]
async fn action_returns_patch_and_plain_post_redirects() {
    let (_, headers, body) = call(app(routes(), None), "POST", Some("action")).await;
    assert_eq!(headers["corten-patch"], "1");
    assert_eq!(body, r#"<p id="msg">saved</p>"#);
    let (status, headers, _) = call(app(routes(), None), "POST", None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers["location"], "/done");
}

/// `patch_or`'s page is built only for a submit without JavaScript, so a patch never loads what
/// only the page shows.
#[tokio::test]
async fn patch_or_builds_the_page_only_without_javascript() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static PAGES: AtomicUsize = AtomicUsize::new(0);
    let routes = || {
        Router::new().route(
            "/",
            axum::routing::post(|req: Req| async move {
                let page = || async {
                    PAGES.fetch_add(1, Ordering::Relaxed);
                    req.redirect::<ForOne>(&Done)
                };
                req.patch_or(html! { <p id={MsgId}>"saved"</p> }, page).await
            }),
        )
    };
    let (_, headers, _) = call(app(routes(), None), "POST", Some("action")).await;
    assert_eq!((headers["corten-patch"].to_str().unwrap(), PAGES.load(Ordering::Relaxed)), ("1", 0));
    let (status, _, _) = call(app(routes(), None), "POST", None).await;
    assert_eq!((status, PAGES.load(Ordering::Relaxed)), (StatusCode::SEE_OTHER, 1));
    // A data client gets the page's answer too, not a JSON error as from `invalid`.
    let (status, _, _) = call_with(app(routes(), None), "POST", "/", None, Some("application/json")).await;
    assert_eq!((status, PAGES.load(Ordering::Relaxed)), (StatusCode::SEE_OTHER, 2));
}

/// A view of references that are not `Sync` (`&Cell`) keeps the handler's future `Send`: the
/// patch is rendered before `patch_or`'s future holds anything.
#[tokio::test]
async fn patch_or_keeps_a_handler_send_with_a_view_of_cells() {
    let routes = Router::new().route(
        "/",
        axum::routing::post(|req: Req| async move {
            let count = std::cell::Cell::new(1);
            let count = &count;
            req.patch_or(html! { <p id={MsgId}>{count.get()}</p> }, || async { req.redirect::<ForOne>(&Done) }).await
        }),
    );
    let (_, _, body) = call(app(routes, None), "POST", Some("action")).await;
    assert_eq!(body, r#"<p id="msg">1</p>"#);
}

#[cfg(feature = "json")]
#[derive(crate::json::ToJson)]
struct Data {
    text: &'static str,
}

#[cfg(feature = "json")]
#[tokio::test]
async fn screen_is_html_for_browsers_and_json_for_data_clients() {
    let router = app(
        Router::new().route(
            "/",
            get(|req: Req| async move {
                let data = Data { text: "<b>" };
                req.screen::<ForOne, _>(&data, Shell { req: &req, title: "A & B", head: "", children: demo(data.text) })
            }),
        ),
        None,
    );
    let browser = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    let (_, headers, body) = call_with(router.clone(), "GET", "/", None, Some(browser)).await;
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(body.starts_with("<!DOCTYPE html>"));
    let (_, headers, body) = call_with(router.clone(), "GET", "/", Some("nav"), Some("application/json")).await;
    assert_eq!(headers["corten-page"], "1", "the runtime's mode header wins over Accept");
    assert!(body.starts_with("<title>"));
    let (status, headers, body) = call_with(router, "GET", "/", None, Some("application/json; charset=utf-8")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(headers["vary"], "corten, accept");
    assert_eq!(body, r#"{"title":"A & B","data":{"text":"<b>"}}"#);
}

#[tokio::test]
async fn page_answers_data_requests_with_the_document() {
    let (_, headers, body) = call_with(app(routes(), None), "GET", "/", None, Some("application/json")).await;
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(body.starts_with("<!DOCTYPE html>"));
}

#[tokio::test]
async fn runtime_is_served_at_a_versioned_immutable_url() {
    assert!(runtime_path().starts_with(&format!("/corten/{}/", runtime_version())));
    let res = app(routes(), None).oneshot(Request::get(runtime_path()).body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["cache-control"], "public, max-age=31536000, immutable");
}

/// A layout with an inline script of its own, which takes the request's nonce.
#[crate::component]
fn Inline<'a>(req: &'a Req) -> impl Document + 'a {
    html! {
        <html>
            <head>
                <title>"Inline"</title>
                <Corten />
                <script nonce={req.nonce()}>"1"</script>
            </head>
            <body><main></main></body>
        </html>
    }
}

/// A page in the `Inline` layout, marked for shared caches.
async fn inline_page(req: Req) -> Public<HtmlResult> {
    Public::new(std::time::Duration::from_secs(60), req.page(Inline { req: &req }))
}

#[tokio::test]
async fn the_csp_allows_the_import_map_by_hash_and_a_nonce_only_when_the_shell_asks() {
    let (_, headers, body) = call(app(routes(), None), "GET", None).await;
    let csp = headers["content-security-policy"].to_str().unwrap();
    let import_map = security::hash_source(&crate::import_map(None, None, None));
    assert!(csp.contains(&format!("script-src 'self' {import_map};")) && !csp.contains("nonce"), "{csp}");
    assert!(body.contains(&format!(r#"<script type="importmap">{}</script>"#, crate::import_map(None, None, None))));
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["cross-origin-opener-policy"], "same-origin");
    let (_, again, same) = call(app(routes(), None), "GET", None).await;
    assert_eq!(
        (again["content-security-policy"].clone(), same),
        (headers["content-security-policy"].clone(), body),
        "the same bytes"
    );

    let inline = || App::new(Routes::from(Router::new().route("/", get(inline_page)))).router();
    let (_, headers, body) = call(inline(), "GET", None).await;
    let csp = headers["content-security-policy"].to_str().unwrap();
    let nonce = csp.split("'nonce-").nth(1).unwrap().split('\'').next().unwrap();
    assert!(body.contains(&format!(r#"<script nonce="{nonce}">1</script>"#)), "{body}");
    let (_, again, _) = call(inline(), "GET", None).await;
    assert_ne!(again["content-security-policy"], headers["content-security-policy"], "a fresh nonce per request");
    let popups = App::new(Routes::from(routes())).policy(security::Policy::new().allow_popups()).router();
    let (_, popups, _) = call(popups, "GET", None).await;
    assert_eq!(popups["cross-origin-opener-policy"], "same-origin-allow-popups");
}

/// A meter whose fill comes from data (`meter.css` registers `--fill`).
#[crate::component(css)]
fn Meter(used: f64) -> impl Render {
    html! { <div class={Meter} style={FILL.pct(used)}></div> }
}

/// The meters' page, with `Meter` listed, as a debug build requires of a page that renders it.
fn meters_app() -> Router {
    App::new(Routes::from(meters())).error_page(test_error_page, ()).components(&[Meter]).router()
}

fn meters() -> Router {
    Router::new().route(
        "/",
        get(|req: Req| async move {
            let meters = html! {
                <Meter used={42.5} />
                <Meter used={7.0} />
                <Meter used={42.5} />
                <Meter used={f64::NAN} />
            };
            req.test_page("Meters", meters)
        }),
    )
}

/// A full page's custom properties are one style block at `<Corten />`, allowed by its hash in
/// that response's CSP; a navigation's are left to the runtime, under the document's policy.
#[tokio::test]
async fn a_page_s_custom_properties_are_one_style_block_its_csp_allows_by_hash() {
    let (_, headers, body) = call(meters_app(), "GET", None).await;
    let rules = r#"[data-vars="--meter__fill:42.5%"]{--meter__fill:42.5%!important}[data-vars="--meter__fill:7%"]{--meter__fill:7%!important}"#;
    assert!(body.contains(&format!("<style>{rules}</style></head>")), "each value once, after the page's stylesheets: {body}");
    assert!(body.contains(r#"<div class="meter__meter" data-vars="--meter__fill:7%"></div><div class="meter__meter" data-vars="--meter__fill:42.5%"></div><div class="meter__meter"></div>"#), "a value that is not finite sets nothing: {body}");
    let csp = headers["content-security-policy"].to_str().unwrap();
    assert!(csp.contains(&format!("style-src 'self' {};", security::hash_source(rules))), "{csp}");
    assert!(!csp.contains("style-src-attr") && !csp.contains("unsafe"), "{csp}");
    let (_, again, same) = call(meters_app(), "GET", None).await;
    assert_eq!(
        (&again["content-security-policy"], &same),
        (&headers["content-security-policy"], &body),
        "the same bytes, so a cache can keep it"
    );

    let (_, headers, body) = call(meters_app(), "GET", Some("nav")).await;
    assert!(body.contains(r#"data-vars="--meter__fill:42.5%""#) && !body.contains("<style>"), "{body}");
    let csp = headers["content-security-policy"].to_str().unwrap();
    assert!(csp.contains("style-src 'self';"), "{csp}");
    let (_, headers, _) = call(app(routes(), None), "GET", None).await;
    assert!(headers["content-security-policy"].to_str().unwrap().contains("style-src 'self';"), "a page with none is as before");
}

/// Meters rendered ahead, placed with `place`, on a page served under `corten dev` or not.
fn placed_meters(dev: bool, place: fn(crate::Rendered) -> Box<dyn crate::Render>) -> Router {
    placed_meters_listing(dev, place, &[Meter])
}

/// `placed_meters`, with the app listing `components`.
fn placed_meters_listing(
    dev: bool,
    place: fn(crate::Rendered) -> Box<dyn crate::Render>,
    components: &'static [crate::Component],
) -> Router {
    let page = move |req: Req| async move {
        let body = req.rendered(html! {
            <Meter used={42.5} />
            <Meter used={7.0} />
        });
        req.test_page("Meters", place(body))
    };
    App::new(Routes::from(Router::new().route("/", get(page))))
        .dev(dev)
        .error_page(test_error_page, ())
        .components(components)
        .router()
}

/// Markup rendered ahead into a `Rendered` keeps its values, so its page's style block has their
/// rules; the same markup placed with `raw` has none, which `corten dev` reports.
#[tokio::test]
async fn markup_rendered_ahead_keeps_its_custom_properties_and_raw_markup_is_reported() {
    let rules = r#"[data-vars="--meter__fill:42.5%"]{--meter__fill:42.5%!important}[data-vars="--meter__fill:7%"]{--meter__fill:7%!important}"#;
    for dev in [false, true] {
        let (status, _, body) = call(placed_meters(dev, |body| Box::new(body)), "GET", None).await;
        assert_eq!(status, 200, "{body}");
        assert!(body.contains(&format!("<style>{rules}</style></head>")), "{body}");
    }
    let (status, _, body) = call(placed_meters(false, |body| Box::new(crate::raw(body.as_str().to_string()))), "GET", None).await;
    assert!(status == 200 && !body.contains("<style>"), "raw markup's values are not noted: {body}");
    let (status, _, body) = call(placed_meters(true, |body| Box::new(crate::raw(body.as_str().to_string()))), "GET", None).await;
    assert_eq!(status, 500, "{body}");
    assert!(body.contains("data-vars=&quot;--meter__fill:42.5%&quot; and no rule for it"), "{body}");
    // In a debug build, a component rendered ahead counts as rendered where it is placed. A
    // release build does not note a view's components, so only a debug build reports it.
    if cfg!(debug_assertions) {
        let (status, _, body) = call(placed_meters_listing(true, |body| Box::new(body), &[]), "GET", None).await;
        assert_eq!(status, 500, "{body}");
        assert!(body.contains("renders Meter, which the app does not list"), "{body}");
    }
}

#[derive(crate::view::Id)]
struct QtyId;

/// A page with a field's hint, drawn and named as `case` says, under `corten dev`.
fn hinted(case: &'static str) -> Router {
    use crate::form::HintId;
    let page = move |req: Req| async move {
        let f = SignUp::FIELDS;
        let errors = Errors::new();
        let e = &errors.within(SignUpId);
        let id = e.id(f.email);
        let body: Box<dyn Render + '_> = match case {
            "named" => Box::new(html! {
                <input id={QtyId} aria-describedby={HintId(&QtyId)}>
                <p id={HintId(&QtyId)}>"From 1 to 5."</p>
            }),
            "control" => Box::new(html! {
                <input {..e.control(f.email).hint()}>
                <p id={HintId(&id)}>"Where we send the receipt."</p>
            }),
            "empty" => Box::new(html! {
                <input id={QtyId}>
                <p id={HintId(&QtyId)}></p>
            }),
            "empty, named" => Box::new(html! {
                <input {..e.control(f.email).hint()}>
                <p id={HintId(&id)}></p>
            }),
            "markup" => Box::new(html! {
                <input id={QtyId}>
                <p id={HintId(&QtyId)}><em>"From 1 to 5."</em></p>
            }),
            "aria" => Box::new(html! {
                <input id={id} {..e.aria(f.email).hint(&HintId(&id))}>
                <p id={HintId(&id)}>"Where we send the receipt."</p>
            }),
            "white space" => Box::new(html! {
                <input id={QtyId}>
                <p id={HintId(&QtyId)}>" "</p>
            }),
            "empty element" => Box::new(html! {
                <input id={QtyId}>
                <p id={HintId(&QtyId)}><span></span></p>
            }),
            "no control" => Box::new(html! {
                <fieldset>
                    <legend>"Size"</legend>
                    <p id={HintId(&QtyId)}>"Pick one."</p>
                </fieldset>
            }),
            "rendered" => Box::new(req.rendered(html! {
                <input id={QtyId}>
                <p id={HintId(&QtyId)}>"From 1 to 5."</p>
            })),
            _ => Box::new(html! {
                <input {..e.control(f.email)}>
                <p id={HintId(&id)}>"Where we send the receipt."</p>
            }),
        };
        req.test_page("Hints", body)
    };
    // A patch that redraws a hint alone, its control on the page; a row with both, unnamed.
    let patch = move |req: Req| async move {
        let answer: HtmlResult = if case == "hint alone" {
            req.patch(html! { <p id={HintId(&QtyId)}>"3 left."</p> })
        } else {
            req.patch(html! {
                <div id={QtyRowId}>
                    <input id={QtyId}>
                    <p id={HintId(&QtyId)}>"From 1 to 5."</p>
                </div>
            })
        };
        answer
    };
    App::new(Routes::from(Router::new().route("/", get(page)).route("/patch", get(patch))))
        .dev(true)
        .error_page(test_error_page, ())
        .router()
}

#[derive(crate::view::Id)]
struct QtyRowId;

/// A hint with text that the control it describes does not name is never read by a screen reader:
/// a debug build's page or patch says so, also for a hint drawn ahead (`req.rendered`). A hint
/// with no text describes nothing, named or not. A page that draws no element for a hint (a radio
/// group with no id) is an error too; a patch of the hint alone, its control on the page, is not.
#[tokio::test]
async fn a_hint_with_text_that_no_control_names_is_an_error_in_a_debug_build() {
    for case in ["named", "control", "empty", "empty, named", "aria", "white space", "empty element"] {
        let (status, _, body) = call(hinted(case), "GET", None).await;
        assert_eq!(status, 200, "{case}: {body}");
    }
    // Its control is on the page already, which the patch does not hold.
    let (status, _, body) = call_with(hinted("hint alone"), "GET", "/patch", Some("action"), None).await;
    assert_eq!(status, 200, "hint alone: {body}");
    for (case, path) in [("unnamed", "/"), ("markup", "/"), ("rendered", "/"), ("no control", "/"), ("row", "/patch")] {
        let mode = (path == "/patch").then_some("action");
        let (status, _, body) = call_with(hinted(case), "GET", path, mode, None).await;
        if cfg!(debug_assertions) {
            assert_eq!(status, 500, "{case}: {body}");
            assert!(body.contains("which has text, and the element it describes does not name it"), "{case}: {body}");
        } else {
            assert_eq!(status, 200, "{case}: {body}");
        }
    }
}

/// What a view rendered ahead noted reaches the render it is placed in: its values beside those
/// the outer render wrote before and after it was made, its script modules and its components.
#[test]
fn a_rendered_view_brings_what_its_render_noted() {
    struct Handled;
    impl crate::Render for Handled {
        fn render(&self, out: &mut String) {
            out.push_str("<button></button>");
            crate::script::uses("stock_grid");
        }
    }
    let ((((html, inner), components), modules), block) = crate::style::capture_vars(|| {
        crate::script::collect(|| {
            crate::style::collect(|| {
                let mut out = Meter { used: 42.5 }.to_html();
                let inner = crate::Rendered::new(html! {
                    <Meter used={7.0} />
                    {Handled}
                });
                Meter { used: 1.0 }.render(&mut out);
                inner.render(&mut out);
                (out, inner)
            })
        })
    });
    assert!(html.ends_with("<button></button>"), "{html}");
    assert_eq!(modules, ["stock_grid"]);
    if cfg!(debug_assertions) {
        assert_eq!(components.iter().map(|c| c.name).collect::<Vec<_>>(), ["Meter"]);
        // Placed alone, it reports the component it rendered.
        let ((), alone) = crate::style::collect(|| inner.render(&mut String::new()));
        assert_eq!(alone.iter().map(|c| c.name).collect::<Vec<_>>(), ["Meter"], "replayed where it is placed");
    }
    let ((), rules) = crate::style::collect_vars(|| crate::style::replay_vars(&block));
    for value in ["42.5%", "7%", "1%"] {
        assert!(rules.contains(&format!("{{--meter__fill:{value}!important}}")), "{value}: {rules}");
    }
}

/// A view rendered ahead keeps a submit key the outer render drew before it was made, and says
/// whether it drew one itself where it is placed, so the answer holding either is not tagged.
#[test]
fn a_rendered_view_keeps_the_outer_render_s_submit_key_and_brings_its_own() {
    struct Draws;
    impl crate::Render for Draws {
        fn render(&self, _: &mut String) {
            crate::form::DREW_KEY.set(true);
        }
    }
    struct Plain;
    impl crate::Render for Plain {
        fn render(&self, out: &mut String) {
            out.push_str("<p></p>");
        }
    }
    crate::form::DREW_KEY.set(true);
    let plain = crate::Rendered::new(Plain);
    assert!(crate::form::DREW_KEY.get(), "the key the outer render drew is kept");
    crate::form::DREW_KEY.set(false);
    let keyed = crate::Rendered::new(Draws);
    assert!(crate::form::DREW_KEY.get(), "a key drawn while made counts where it was made");
    crate::form::DREW_KEY.set(false);
    plain.render(&mut String::new());
    assert!(!crate::form::DREW_KEY.get(), "placing a view with no key leaves the flag");
    keyed.render(&mut String::new());
    assert!(crate::form::DREW_KEY.get(), "placing a view with a key sets it");
    crate::form::DREW_KEY.set(false);
}

/// A render that panics inside another puts back what the outer one was gathering, so it keeps
/// what it noted before and goes on noting after: a handler's panic is caught and the thread
/// renders on.
#[test]
fn a_panicking_render_puts_back_what_was_gathering() {
    let panics = || panic!("a handler");
    let ((), modules) = crate::script::collect(|| {
        crate::script::uses("before");
        assert!(std::panic::catch_unwind(|| crate::script::collect::<()>(panics)).is_err());
        crate::script::uses("after");
    });
    assert_eq!(modules, ["before", "after"]);
    let ((), rules) = crate::style::collect_vars(|| {
        Meter { used: 1.0 }.to_html();
        assert!(std::panic::catch_unwind(|| crate::style::collect_vars::<()>(panics)).is_err());
        Meter { used: 2.0 }.to_html();
    });
    assert!(rules.contains("--meter__fill:1%!important") && rules.contains("--meter__fill:2%!important"), "{rules}");
    let ((), block) = crate::style::capture_vars(|| {
        Meter { used: 3.0 }.to_html();
        assert!(std::panic::catch_unwind(|| crate::style::capture_vars::<()>(panics)).is_err());
        Meter { used: 4.0 }.to_html();
    });
    let ((), rules) = crate::style::collect_vars(|| crate::style::replay_vars(&block));
    assert!(rules.contains("--meter__fill:3%!important") && rules.contains("--meter__fill:4%!important"), "{rules}");
    if cfg!(debug_assertions) {
        const OTHER: crate::Component = crate::Component { name: "Other", ..Meter };
        let ((), used) = crate::style::collect(|| {
            crate::style::__private::rendered(&Meter);
            assert!(std::panic::catch_unwind(|| crate::style::collect::<()>(panics)).is_err());
            crate::style::__private::rendered(&OTHER);
        });
        assert_eq!(used.iter().map(|c| c.name).collect::<Vec<_>>(), ["Meter", "Other"]);
    }
}

#[tokio::test]
async fn the_app_refuses_cross_site_writes() {
    let router = app(routes(), None);
    let req = |site: &'static str| {
        Request::post("/").header("sec-fetch-site", site).header("corten", "action").body(Body::empty()).unwrap()
    };
    assert_eq!(router.clone().oneshot(req("cross-site")).await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_eq!(router.oneshot(req("same-origin")).await.unwrap().status(), StatusCode::OK);
}

fn failing() -> Router {
    Router::new()
        .route("/", get(|| async { Err::<Response, _>(Error::new("database is down")) }))
        .route("/missing", get(|| async { Err::<Response, _>(Error::status(StatusCode::NOT_FOUND)) }))
        .route("/forbidden", get(|| async { Err::<Response, _>(Error::status(StatusCode::FORBIDDEN)) }))
}

#[tokio::test]
async fn errors_render_in_the_shell_for_each_mode_without_leaking_the_message() {
    let (status, headers, body) = call(app(failing(), None), "GET", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(body.contains("<title>Something went wrong</title>"), "{body}");
    assert_eq!(headers["x-robots-tag"], "noindex", "search engines skip every error page");
    assert!(!body.contains("database"), "the error message stays in the log");
    let (_, headers, body) = call(app(failing(), None), "GET", Some("nav")).await;
    assert_eq!(headers["corten-page"], "1");
    assert!(body.starts_with("<title>Something went wrong</title>"));
    let (_, headers, body) = call_with(app(failing(), None), "GET", "/", None, Some("application/json")).await;
    assert_eq!(headers["content-type"], "application/problem+json");
    assert_eq!(body, r#"{"title":"Internal Server Error","status":500}"#, "the message stays in the log");
    let (status, _, body) = call_with(app(failing(), None), "GET", "/missing", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body.contains("<title>Not found</title>"));
}

#[tokio::test]
async fn an_extractor_rejection_gets_the_error_page_in_a_browser_and_its_text_in_dev() {
    let routes =
        || Router::new().route("/n/{n}", get(|axum::extract::Path(n): axum::extract::Path<u32>| async move { n.to_string() }));
    let html = Some("text/html,application/xhtml+xml");
    let (status, headers, body) = call_with(app(routes(), None), "GET", "/n/abc", None, html).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(body.contains("<title>Something went wrong</title>") && !body.contains("parse"), "{body}");
    let (_, headers, body) = call_with(app(routes(), None), "GET", "/n/abc", Some("nav"), None).await;
    assert_eq!(headers["corten-page"], "1", "a navigation swaps the error page in: {body}");
    let (_, _, body) = call_with(App::new(Routes::from(routes())).dev(true).router(), "GET", "/n/abc", None, html).await;
    assert!(body.contains("<pre>Invalid URL"), "the default error page shows it: {body}");
    let (status, headers, body) = call_with(app(routes(), None), "GET", "/n/abc", None, Some("application/json")).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::BAD_REQUEST, "application/problem+json"));
    assert!(
        body.starts_with(r#"{"title":"Bad Request","status":400,"detail":"Invalid URL"#),
        "a data client gets the text as JSON: {body}"
    );
    let (_, _, body) = call_with(app(routes(), None), "GET", "/n/abc", None, None).await;
    assert!(body.starts_with("Invalid URL"), "so does a client that does not ask for HTML: {body}");
    let (_, _, body) = call_with(app(routes(), None), "GET", "/n/7", None, None).await;
    assert_eq!(body, "7", "a plain-text success is left alone");
}

#[tokio::test]
async fn dev_mode_shows_errors_and_reloads_pages_when_the_server_restarts() {
    let dev = || {
        App::new(Routes::from(failing().route("/ok", get(|req: Req| async move { req.test_page("ok", html! { "ok" }) }))))
            .dev(true)
    };
    let (_, _, body) = call(dev().router(), "GET", None).await;
    assert!(body.contains("<pre>database is down</pre>"), "{body}");

    let router = dev().router();
    let (_, _, page) = call_with(router.clone(), "GET", "/ok", None, None).await;
    let boot = meta_content(&page, "corten-dev").to_string();
    let res = router.clone().oneshot(Request::get("/corten/dev").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.headers()["content-type"], "text/event-stream");
    let mut body = res.into_body();
    let mut events = String::new();
    while !events.contains("\n\n") {
        events.push_str(std::str::from_utf8(&body.frame().await.unwrap().unwrap().into_data().unwrap()).unwrap());
    }
    // Each server start has its own boot id; the page compares it to the one it was served with.
    assert!(!boot.is_empty() && events.contains(&format!("data: {boot}\n")), "{events}");
    // The checks a developer needs, which a production page never loads.
    let (status, headers, script) = call_with(router, "GET", "/corten/dev.js", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "text/javascript; charset=utf-8");
    assert_eq!(headers["cache-control"], "no-store");
    assert!(script.contains(r#"import { ready } from "corten";"#), "{script}");

    let prod = App::new(Routes::from(failing())).dev(false).router();
    let (_, _, body) = call(prod.clone(), "GET", None).await;
    assert!(!body.contains("database") && !body.contains("corten-dev"));
    for path in ["/corten/dev", "/corten/dev.js"] {
        let (status, _, _) = call_with(prod.clone(), "GET", path, None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn unknown_urls_and_methods_get_the_error_page_and_the_app_can_replace_it() {
    let (status, _, body) = call_with(app(routes(), Some("ada")), "GET", "/nope", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body.contains("<title>Not found</title>") && body.contains(">home</a>"), "in the shell: {body}");
    let (status, headers, body) = call_with(app(routes(), None), "DELETE", "/", None, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert!(headers.contains_key("allow") && body.contains("Something went wrong"));
    let custom = App::new(Routes::from(routes())).error_page(oops, ()).router();
    let (_, _, body) = call_with(custom, "GET", "/nope", None, None).await;
    assert!(body.contains("<title>Oops 404</title>") && body.contains("<h1>Lost?</h1>"));
}

/// An error page of the app's own, with no arguments but the failure and the request.
async fn oops(failure: Failure, req: Req) -> HtmlResult {
    let code = failure.status().as_u16();
    req.page(html! {
        <html>
            <head>
                <title>"Oops "{code}</title>
                <Corten />
            </head>
            <body><main><h1>"Lost?"</h1></main></body>
        </html>
    })
}

#[tokio::test]
async fn a_handler_that_panics_gets_the_error_page_and_the_server_keeps_serving() {
    let routes = Router::new().route("/", get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) })).route(
        "/panic",
        get(|| async {
            if true {
                panic!("index out of bounds")
            } else {
                "never"
            }
        }),
    );
    let router = app(routes, None);
    let (status, headers, body) = call_with(router.clone(), "GET", "/panic", None, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(body.contains("<title>Something went wrong</title>") && !body.contains("bounds"), "{body}");
    let (_, headers, body) = call_with(router.clone(), "GET", "/panic", Some("nav"), None).await;
    assert_eq!(headers["corten-page"], "1", "a navigation swaps the error page in: {body}");
    let (status, _, body) = call_with(router.clone(), "GET", "/panic", None, Some("application/json")).await;
    assert_eq!((status, &body[..]), (StatusCode::INTERNAL_SERVER_ERROR, r#"{"title":"Internal Server Error","status":500}"#));
    let (status, _, _) = call(router, "GET", None).await;
    assert_eq!(status, StatusCode::OK, "the next request is served");
    let (_, _, body) = call_with(
        App::new(Routes::from(Router::new().route(
            "/",
            get(|| async {
                if true {
                    panic!("index out of bounds")
                } else {
                    "never"
                }
            }),
        )))
        .dev(true)
        .router(),
        "GET",
        "/",
        None,
        None,
    )
    .await;
    assert!(body.contains("index out of bounds"), "under corten dev the page shows the panic: {body}");
}

/// A second layout, as a marketing page and an account page might have.
#[crate::component]
fn Plain(req: &Req, title: &str, children: impl Render) -> impl Document {
    html! {
        <html lang={req.lang()}>
            <head>
                <title>{title}</title>
                <Corten />
            </head>
            <body>
                <header>"Plain"</header>
                <main>{children}</main>
            </body>
        </html>
    }
}

/// The shell key names the layout that rendered the page: pages in one layout share it, so a
/// navigation between them swaps `<main>`; a page in another layout (or the default error
/// document) has another, so the runtime loads it in full rather than keep the first layout.
#[tokio::test]
async fn a_page_in_another_layout_has_another_shell_key() {
    let routes = Router::new()
        .route("/", get(|req: Req| async move { req.page::<ForOne>(Shell { req: &req, title: "A", head: "", children: "a" }) }))
        .route("/b", get(|req: Req| async move { req.page::<ForOne>(Shell { req: &req, title: "B", head: "", children: "b" }) }))
        .route("/plain", get(|req: Req| async move { req.page::<ForOne>(Plain { req: &req, title: "P", children: "p" }) }));
    let router = app(routes.clone(), None);
    let key = |uri: &'static str, mode: Option<&'static str>| {
        let router = router.clone();
        async move {
            let (status, headers, body) = call_with(router, "GET", uri, mode, None).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            let key = headers["corten-shell"].to_str().unwrap().to_string();
            if mode.is_none() {
                assert_eq!(meta_content(&body, "corten-shell"), key, "{uri}: the document and its header agree");
            }
            key
        }
    };
    let home = key("/", None).await;
    assert_eq!(key("/b", Some("nav")).await, home, "the same layout swaps in");
    let plain = key("/plain", Some("nav")).await;
    assert_ne!(plain, home, "another layout loads in full");
    assert_eq!(key("/plain", None).await, plain, "a layout's key is the same in every mode");

    // An app without an error page: an unknown URL is Corten's plain document, not the layout.
    let bare = App::new(Routes::from(routes)).router();
    let (_, nope, _) = call_with(bare.clone(), "GET", "/nope", Some("nav"), None).await;
    let (_, page, _) = call_with(bare, "GET", "/", Some("nav"), None).await;
    assert_ne!(nope["corten-shell"], page["corten-shell"], "the default error document is another layout");
}

#[tokio::test]
async fn health_reports_liveness_and_readiness() {
    let router = App::new(Routes::new()).ready(|| async { false }).router();
    let get = |uri: &'static str| router.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap());
    assert_eq!(get("/health/live").await.unwrap().status(), StatusCode::OK);
    let ready = get("/health/ready").await.unwrap();
    assert_eq!(ready.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(ready.headers()["cache-control"], "no-store");
}

#[tokio::test(start_paused = true)]
async fn a_ready_check_past_its_limit_is_unavailable() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let ask = |router: Router| async move {
        let started = tokio::time::Instant::now();
        let res = router.oneshot(Request::get("/health/ready").body(Body::empty()).unwrap()).await.unwrap();
        (res.status(), started.elapsed())
    };
    // A check that never answers is dropped at the limit, 800 ms unless set.
    struct Counted(Arc<AtomicUsize>);
    impl Drop for Counted {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }
    let dropped = Arc::new(AtomicUsize::new(0));
    let hung = App::new(Routes::new()).ready({
        let dropped = dropped.clone();
        move || {
            let counted = Counted(dropped.clone());
            async move {
                let _counted = counted;
                std::future::pending::<bool>().await
            }
        }
    });
    let router = hung.router();
    for _ in 0..3 {
        let (status, took) = ask(router.clone()).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(took, Duration::from_millis(800));
    }
    assert_eq!(dropped.load(Ordering::Relaxed), 3, "each check past its limit is dropped");
    let taking = |ms| {
        App::new(Routes::new()).ready(move || async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            true
        })
    };
    assert_eq!(ask(taking(700).router()).await.0, StatusCode::OK, "inside the default limit");
    assert_eq!(ask(taking(900).router()).await.0, StatusCode::SERVICE_UNAVAILABLE, "past the default limit");
    let set = taking(30).ready_within(Duration::from_millis(20));
    assert_eq!(ask(set.router()).await, (StatusCode::SERVICE_UNAVAILABLE, Duration::from_millis(20)));
}

/// A check that keeps hanging is logged once, and again only after it has answered in time.
#[cfg(feature = "log")]
#[test]
fn a_hung_ready_check_is_logged_once_until_it_answers() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };
    #[derive(Clone)]
    struct Lines(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Lines {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let lines = Lines(Arc::default());
    let writer = lines.clone();
    let warnings = || String::from_utf8(lines.0.lock().unwrap().clone()).unwrap().matches("did not answer in time").count();
    let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
    let hung = Arc::new(AtomicBool::new(true));
    let router = App::new(Routes::new())
        .ready({
            let hung = hung.clone();
            move || {
                let hung = hung.load(Ordering::Relaxed);
                async move {
                    if hung {
                        std::future::pending::<()>().await;
                    }
                    true
                }
            }
        })
        .router();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_time().start_paused(true).build().unwrap();
    let mut counts = Vec::new();
    tracing::subscriber::with_default(subscriber, || {
        runtime.block_on(async {
            let ask = || async {
                router.clone().oneshot(Request::get("/health/ready").body(Body::empty()).unwrap()).await.unwrap().status()
            };
            for _ in 0..3 {
                assert_eq!(ask().await, StatusCode::SERVICE_UNAVAILABLE);
            }
            counts.push(warnings());
            hung.store(false, Ordering::Relaxed);
            assert_eq!(ask().await, StatusCode::OK);
            hung.store(true, Ordering::Relaxed);
            assert_eq!(ask().await, StatusCode::SERVICE_UNAVAILABLE);
            counts.push(warnings());
        });
    });
    assert_eq!(counts, [1, 2], "one warning per hang, not one per probe");
}

/// A page that shows who is asking, or that no one is.
fn who_routes() -> Router {
    Router::new().route(
        "/",
        get(|req: Req, viewer: Option<Caller<Viewer>>| async move {
            let who = viewer.map_or("guest", |Caller(v)| v.0);
            req.test_page("Who", html! { <p>{who}</p> })
        }),
    )
}

#[tokio::test]
async fn the_page_key_follows_the_caller_the_handler_read() {
    let (_, headers, guest) = call(app(who_routes(), None), "GET", None).await;
    assert!(guest.contains("<p>guest</p>"), "{guest}");
    let key = meta_content(&guest, "corten-shell");
    assert_eq!(headers["corten-shell"], key, "the document and its header agree");

    let (_, _, ada) = call(app(who_routes(), Some("ada")), "GET", None).await;
    assert!(ada.contains("<p>ada</p>"));
    assert_ne!(meta_content(&ada, "corten-shell"), key, "signing in changes the key");
    let (_, _, bob) = call(app(who_routes(), Some("bob")), "GET", None).await;
    assert_ne!(meta_content(&bob, "corten-shell"), meta_content(&ada, "corten-shell"), "so does someone else");

    let (_, nav, body) = call(app(who_routes(), Some("ada")), "GET", Some("nav")).await;
    assert_eq!(nav["corten-shell"], meta_content(&ada, "corten-shell"), "navigations carry the key");
    assert_eq!(body, "<title>Who</title><p>ada</p>", "a navigation sends only the page");

    let (_, _, anonymous) = call(app(routes(), Some("ada")), "GET", None).await;
    assert_ne!(meta_content(&anonymous, "corten-shell"), meta_content(&ada, "corten-shell"), "a page that reads no caller");
}

/// A rule over [`Viewer`]: one who may sell.
#[derive(Clone, Hash)]
struct Seller(Viewer);

impl<S: Sync> crate::Identify<S> for Seller {
    async fn identify(parts: &axum::http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        let Caller(viewer) = Caller::<Viewer>::find(parts, state).await?;
        if viewer.0 == "bob" {
            return Err(crate::Refused::forbidden());
        }
        Ok(Seller(viewer))
    }
}

/// A rule over [`Seller`].
#[derive(Clone, Hash)]
struct Owner(Seller);

impl<S: Sync> crate::Identify<S> for Owner {
    async fn identify(parts: &axum::http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        Ok(Owner(Caller::<Seller>::find(parts, state).await?.0))
    }
}

/// A rule per permission over [`Viewer`], as an admin app's `Staff<IntakeAccess>` is.
#[derive(Clone, Hash)]
struct Permit<R>(Viewer, std::marker::PhantomData<R>);

#[derive(Clone, Hash)]
struct Intake;
#[derive(Clone, Hash)]
struct Returns;

impl<S: Sync, R: Clone + std::hash::Hash + Send + Sync + 'static> crate::Identify<S> for Permit<R> {
    async fn identify(parts: &axum::http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        Ok(Permit(Caller::<Viewer>::find(parts, state).await?.0, std::marker::PhantomData))
    }
}

/// A rule over [`Viewer`] that holds data of its own: the org it acts for, from a header here
/// (a path or the store in an app).
#[derive(Clone, Hash)]
struct Member(Viewer, &'static str);

impl<S: Sync> crate::Identify<S> for Member {
    async fn identify(parts: &axum::http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        let Caller(viewer) = Caller::<Viewer>::find(parts, state).await?;
        let org = parts.headers.get("org").and_then(|v| v.to_str().ok()).unwrap_or("none");
        Ok(Member(viewer, org.to_owned().leak()))
    }
}

/// The same for everyone (a rate-limit bucket), read by [`Person`]'s lookup first.
#[derive(Clone, Hash)]
struct Bucket;

impl<S: Sync> crate::Identify<S> for Bucket {
    async fn identify(_: &axum::http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
        tokio::task::yield_now().await;
        Ok(Bucket)
    }
}

/// A caller whose lookup reads another caller ([`Bucket`]) that is not who is asking.
#[derive(Clone, Hash)]
struct Person(Viewer);

impl<S: Sync> crate::Identify<S> for Person {
    async fn identify(parts: &axum::http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        Caller::<Bucket>::find(parts, state).await?;
        Ok(Person(<Viewer as crate::Identify<S>>::identify(parts, state).await?))
    }
}

/// Reads [`Seller`] and [`Bucket`] joined, as a middleware's extractor might.
struct Joined;

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for Joined {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut axum::http::request::Parts, state: &S) -> std::result::Result<Self, Response> {
        let (seller, bucket) = tokio::join!(Caller::<Seller>::find(parts, state), Caller::<Bucket>::find(parts, state));
        seller.and(bucket).map(|_| Joined).map_err(IntoResponse::into_response)
    }
}

/// A role [`Granted`] checks for, named in the request's `roles` header.
trait Role {
    const NAME: &'static str;
}
impl Role for Intake {
    const NAME: &'static str = "intake";
}
impl Role for Returns {
    const NAME: &'static str = "returns";
}

/// A rule per role over [`Viewer`] that refuses a viewer without the role.
#[derive(Clone, Hash)]
struct Granted<R>(Viewer, std::marker::PhantomData<R>);

impl<S: Sync, R: Role + Clone + std::hash::Hash + Send + Sync + 'static> crate::Identify<S> for Granted<R> {
    async fn identify(parts: &axum::http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        let Caller(viewer) = Caller::<Viewer>::find(parts, state).await?;
        let roles = parts.headers.get("roles").and_then(|v| v.to_str().ok()).unwrap_or("");
        if !roles.split(',').any(|role| role == R::NAME) {
            return Err(crate::Refused::forbidden());
        }
        Ok(Granted(viewer, std::marker::PhantomData))
    }
}

/// Pages for one person behind different rules share the key, so a navigation between them swaps
/// `<main>`; another person, no one, or a rule's own data (an org) still changes it (#709).
#[tokio::test]
async fn pages_behind_rules_over_one_caller_share_its_key() {
    let routes = || {
        who_routes()
            .route(
                "/sell",
                get(|req: Req, Caller(seller): Caller<Seller>| async move {
                    req.test_page(
                        "Sell",
                        html! {
                            <p>{seller.0 .0}</p>
                        },
                    )
                }),
            )
            .route(
                "/own",
                get(|req: Req, Caller(owner): Caller<Owner>| async move {
                    req.test_page(
                        "Own",
                        html! {
                            <p>{owner.0 .0 .0}</p>
                        },
                    )
                }),
            )
            // A handler that takes two rules over the one viewer.
            .route(
                "/both",
                get(|req: Req, Caller(_): Caller<Seller>, Caller(_): Caller<Owner>| async move {
                    req.test_page(
                        "Both",
                        html! {
                            <p>"both"</p>
                        },
                    )
                }),
            )
            .route(
                "/intake",
                get(|req: Req, _: Caller<Permit<Intake>>| async move {
                    req.test_page(
                        "Intake",
                        html! {
                            <p>"intake"</p>
                        },
                    )
                }),
            )
            .route(
                "/returns",
                get(|req: Req, _: Caller<Permit<Returns>>| async move {
                    req.test_page(
                        "Returns",
                        html! {
                            <p>"returns"</p>
                        },
                    )
                }),
            )
            .route("/org", get(|req: Req, Caller(m): Caller<Member>| async move { req.test_page("Org", html! { <p>{m.1}</p> }) }))
            .route("/joined", get(|req: Req, _: Joined| async move { req.test_page("Joined", html! { <p>"joined"</p> }) }))
            .route(
                "/apart",
                get(|req: Req, _: Caller<Seller>, _: Caller<Bucket>| async move {
                    req.test_page(
                        "Apart",
                        html! {
                            <p>"apart"</p>
                        },
                    )
                }),
            )
            .route(
                "/person",
                get(|req: Req, Caller(p): Caller<Person>| async move {
                    req.test_page(
                        "Person",
                        html! {
                            <p>{p.0 .0}</p>
                        },
                    )
                }),
            )
    };
    let key = |viewer: Option<&'static str>, uri: &'static str, org: &'static str| {
        let router = app(routes(), viewer);
        async move {
            let req = Request::get(uri).header("corten", "nav").header("org", org).body(Body::empty()).unwrap();
            let res = router.oneshot(req).await.unwrap();
            (res.status(), res.headers()["corten-shell"].to_str().unwrap().to_string())
        }
    };
    let (_, viewer) = key(Some("ada"), "/", "").await;
    for uri in ["/sell", "/own", "/both", "/intake", "/returns"] {
        let (status, rule) = key(Some("ada"), uri, "").await;
        assert_eq!((status, &rule), (StatusCode::OK, &viewer), "{uri}: the same person, so the same key");
    }
    let (_, cy) = key(Some("cy"), "/", "").await;
    assert_eq!(key(Some("cy"), "/sell", "").await.1, cy, "cy's rule page has cy's key");
    assert_ne!(cy, viewer, "another person behind the same rule has another key");
    let (_, guest) = key(None, "/", "").await;
    assert_ne!(guest, viewer, "signing out still changes it");

    // A rule's own data is in the key: a layout that draws the org is not kept across orgs.
    let (_, acme) = key(Some("ada"), "/org", "acme").await;
    assert_ne!(acme, viewer, "a member is keyed by its org too");
    assert_ne!(key(Some("ada"), "/org", "globex").await.1, acme, "another org, another key");
    assert_eq!(key(Some("ada"), "/org", "acme").await.1, acme);

    // A caller read joined with a rule, or after it, keys the page alike.
    let (_, apart) = key(Some("ada"), "/apart", "").await;
    assert_eq!(key(Some("ada"), "/joined", "").await.1, apart);
    // A lookup that reads another caller first (a bucket) is still keyed by who is asking.
    let (_, ada) = key(Some("ada"), "/person", "").await;
    let (_, bob) = key(Some("bob"), "/person", "").await;
    assert_ne!(ada, bob, "a lookup that reads a bucket first still tells people apart");

    // A refused rule's page is keyed apart from the one it refused.
    let (status, refused) = key(Some("bob"), "/sell", "").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_ne!(refused, key(Some("bob"), "/", "").await.1);
}

/// A layout that draws a link per role reads each rule as an `Option`: which ones passed is in
/// the key, so a navigation after a role changes does not keep the old links (#709).
#[tokio::test]
async fn which_optional_rules_passed_is_in_the_key() {
    let routes = || {
        who_routes().route(
            "/desk",
            get(|req: Req, _: Caller<Viewer>, _: Option<Caller<Granted<Intake>>>, _: Option<Caller<Granted<Returns>>>| async move {
                req.test_page("Desk", html! { <p>"desk"</p> })
            }),
        )
    };
    let key = |roles: &'static str| {
        let router = app(routes(), Some("ada"));
        async move {
            let req = Request::get("/desk").header("corten", "nav").header("roles", roles).body(Body::empty()).unwrap();
            router.oneshot(req).await.unwrap().headers()["corten-shell"].to_str().unwrap().to_string()
        }
    };
    let keys = [key("intake").await, key("returns").await, key("").await, key("intake,returns").await];
    for (i, a) in keys.iter().enumerate() {
        for b in &keys[i + 1..] {
            assert_ne!(a, b, "each set of roles has its own key: {keys:?}");
        }
    }
    let (_, viewer, _) = call_with(app(routes(), Some("ada")), "GET", "/", Some("nav"), None).await;
    assert_eq!(keys[3], viewer["corten-shell"], "every rule passed: keyed as the viewer alone");
}

/// An error page that reads `ClientIp` again keys its answer as the handler's one read does: a
/// caller marked twice in a request is mixed in once (#709). Over a connection, which is where
/// the error page has the peer too.
#[tokio::test]
async fn an_error_page_that_reads_the_client_ip_again_keys_it_once() {
    async fn ip_error_page(_: Failure, req: Req, ip: Option<crate::ClientIp>) -> HtmlResult {
        let ip = ip.map_or("none".to_string(), |crate::ClientIp(ip)| ip.to_string());
        req.page(Shell { req: &req, title: "Failed", head: "", children: html! { <p>{ip}</p> } })
    }
    let routes = Router::new()
        .route(
            "/ok",
            get(|req: Req, crate::ClientIp(ip): crate::ClientIp| async move {
                req.test_page("Ok", html! { <p>{ip.to_string()}</p> })
            }),
        )
        .route("/fail", get(|crate::ClientIp(_): crate::ClientIp| async { crate::Result::<String>::Err(Error::not_found()) }));
    let app = App::new(Routes::from(routes)).error_page(ip_error_page, ());
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let shell = |answer: &str| {
        let line = answer.lines().find(|line| line.to_ascii_lowercase().starts_with("corten-shell:")).expect(answer);
        line.split_once(':').unwrap().1.trim().to_string()
    };
    let ok = raw_get(addr, "/ok", "corten: nav\r\n").await;
    let failed = raw_get(addr, "/fail", "corten: nav\r\n").await;
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
    assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
    assert!(failed.starts_with("HTTP/1.1 404") && failed.contains("<p>127.0.0.1</p>"), "{failed}");
    assert_eq!(shell(&failed), shell(&ok));
}

/// A rule read first by a layer outside the app's (`App::layer`) keys the page as when the
/// handler reads it (#709).
#[tokio::test]
async fn a_rule_read_by_an_outer_layer_keys_the_page_as_its_base() {
    let routes = || {
        who_routes().route(
            "/sell",
            get(|req: Req, Caller(s): Caller<Seller>| async move { req.test_page("Sell", html! { <p>{s.0 .0}</p> }) }),
        )
    };
    let outer = App::new(Routes::from(routes()))
        .error_page(test_error_page, ())
        .middleware(AsViewer(Some("ada")))
        .layer(axum::middleware::from_fn(|req: axum::extract::Request, next: axum::middleware::Next| async move {
            let (mut parts, body) = req.into_parts();
            parts.headers.insert("viewer", axum::http::HeaderValue::from_static("ada"));
            let _ = <Caller<Seller> as axum::extract::FromRequestParts<()>>::from_request_parts(&mut parts, &()).await;
            next.run(axum::extract::Request::from_parts(parts, body)).await
        }))
        .router();
    let (_, viewer, _) = call_with(app(routes(), Some("ada")), "GET", "/", Some("nav"), None).await;
    let (status, sell, _) = call_with(outer, "GET", "/sell", Some("nav"), None).await;
    assert_eq!((status, &sell["corten-shell"]), (StatusCode::OK, &viewer["corten-shell"]));
}

#[test]
fn a_nav_link_writes_its_route_once_and_says_when_it_is_the_page() {
    use crate::{page::Nav, view::Attrs};
    #[derive(crate::Route)]
    #[route("/sell")]
    struct Sell;
    #[derive(crate::Route)]
    #[route("/items/{id}")]
    struct Item<'a> {
        id: &'a str,
        tab: Option<&'a str>,
    }
    fn attrs<R: crate::Route>(nav: Nav<'_, R>) -> String {
        let mut out = String::new();
        nav.render_attrs(&mut out);
        out
    }
    assert_eq!(attrs(Nav { path: "/sell", to: &Sell, section: false }), r#" href="/sell" data-nav aria-current="page""#);
    assert_eq!(attrs(Nav { path: "/sell/listings", to: &Sell, section: false }), r#" href="/sell" data-nav"#);
    assert_eq!(
        attrs(Nav { path: "/sell/listings", to: &Sell, section: true }),
        r#" href="/sell" data-nav="section" aria-current="page""#
    );
    // A sibling that starts with the same text is not under the section.
    assert_eq!(attrs(Nav { path: "/seller", to: &Sell, section: true }), r#" href="/sell" data-nav="section""#);
    // A section written with a trailing slash holds the pages under it, and itself.
    #[derive(crate::Route)]
    #[route("/shop/")]
    struct Shop;
    assert_eq!(
        attrs(Nav { path: "/shop/boots", to: &Shop, section: true }),
        r#" href="/shop/" data-nav="section" aria-current="page""#
    );
    assert_eq!(
        attrs(Nav { path: "/shop/", to: &Shop, section: true }),
        r#" href="/shop/" data-nav="section" aria-current="page""#
    );
    // The path is percent-encoded, and the query is left out of the comparison.
    let item = Item { id: "a b", tab: Some("x&y") };
    assert_eq!(
        attrs(Nav { path: "/items/a%20b", to: &item, section: false }),
        r#" href="/items/a%20b?tab=x%26y" data-nav aria-current="page""#
    );
    // A route written by hand may write a path that escaping for the attribute changes; it is
    // compared unescaped.
    struct Terms;
    impl crate::Route for Terms {
        const PATH: &'static str = "/terms&privacy";
        fn write_href(&self, out: &mut String, html: bool) {
            out.push_str(if html { "/terms&amp;privacy" } else { "/terms&privacy" });
        }
    }
    assert_eq!(
        attrs(Nav { path: "/terms&privacy", to: &Terms, section: false }),
        r#" href="/terms&amp;privacy" data-nav aria-current="page""#
    );
}

/// A whole nav's links: of the entries that hold the page, only the deepest is current, as the
/// runtime judges a `<nav>` after a client navigation (#341).
#[test]
fn a_nav_marks_the_deepest_entry_that_holds_the_page() {
    use crate::{
        page::{nav_links, NavTo},
        view::Attrs,
        Local,
    };
    #[derive(crate::Route)]
    #[route("/")]
    struct Home;
    #[derive(crate::Route)]
    #[route("/account/desk")]
    struct Desk;
    #[derive(crate::Route)]
    #[route("/account/desk/money")]
    struct Money;
    let help = Local::parse("/help?topic=a&b").unwrap();
    let written = |nav: crate::page::NavLinks<()>| {
        nav.links()
            .map(|(link, ())| {
                let mut out = String::new();
                link.render_attrs(&mut out);
                out
            })
            .collect::<Vec<_>>()
    };
    let group = |links: &[String]| {
        let groups: Vec<_> =
            links.iter().map(|link| link.split(r#" data-nav-group=""#).nth(1).unwrap()[..8].to_string()).collect();
        assert!(groups.iter().all(|g| *g == groups[0] && g.bytes().all(|b| b.is_ascii_hexdigit())), "{groups:?}");
        groups[0].clone()
    };
    let marked = |path: &str| {
        let links = written(nav_links(
            path,
            [NavTo::page(&Home), NavTo::section(&Desk), NavTo::section(&Money), NavTo::page(&help)].map(|e| (e, ())),
        ));
        let g = format!(r#" data-nav-group="{}""#, group(&links));
        links.into_iter().map(|link| link.replace(&g, "")).collect::<Vec<_>>()
    };
    assert_eq!(
        marked("/account/desk/repricing"),
        [
            r#" href="/" data-nav"#,
            r#" href="/account/desk" data-nav="section" aria-current="page""#,
            r#" href="/account/desk/money" data-nav="section""#,
            r#" href="/help?topic=a&amp;b" data-nav"#,
        ]
    );
    let money = marked("/account/desk/money/payouts");
    assert!(!money[1].contains("aria-current") && money[2].ends_with(r#" aria-current="page""#), "{money:?}");
    assert!(marked("/")
        .iter()
        .filter(|link| link.contains("aria-current"))
        .eq([&r#" href="/" data-nav aria-current="page""#.to_string()]));
    assert!(marked("/help").last().unwrap().ends_with(r#" aria-current="page""#), "an entry from data takes part");
    assert!(marked("/elsewhere").iter().all(|link| !link.contains("aria-current")));

    // The group names the entries: the same nav twice is one group, another nav is another.
    let of = |path: &str, entries: [NavTo; 2]| written(nav_links(path, entries.map(|e| (e, ()))));
    let desk = of("/", [NavTo::section(&Desk), NavTo::page(&Money)]);
    assert_eq!(group(&desk), group(&of("/account", [NavTo::section(&Desk), NavTo::page(&Money)])));
    assert_ne!(group(&desk), group(&of("/", [NavTo::page(&Desk), NavTo::page(&Money)])));
    assert_ne!(group(&desk), group(&of("/", [NavTo::section(&Money), NavTo::page(&Desk)])));

    // Each link comes with its entry's item.
    let labels: Vec<_> =
        nav_links("/", [(NavTo::page(&Home), "Home"), (NavTo::section(&Desk), "Desk")]).links().map(|(_, l)| *l).collect();
    assert_eq!(labels, ["Home", "Desk"]);

    // A path from data is written as the browser asks for it, so the server compares what it is
    // sent: `"` and `|` are percent-encoded in the path (not in the query).
    let odd = Local::parse(r#"/a"b|c?q="|""#).unwrap();
    let links = written(nav_links("/a%22b%7Cc", [(NavTo::page(&odd), ())]));
    assert!(links[0].starts_with(r#" href="/a%22b%7Cc?q=&quot;|&quot;" data-nav data-nav-group=""#), "{links:?}");
    assert!(links[0].ends_with(r#" aria-current="page""#), "{links:?}");

    // A route that says `prefetch = false` keeps saying so in a nav, as in `href={..}`.
    #[derive(crate::Route)]
    #[route("/reports/suggested", prefetch = false)]
    struct Suggested;
    let links = written(nav_links("/", [(NavTo::page(&Suggested), ()), (NavTo::page(&Home), ())]));
    assert!(links[0].ends_with(" data-no-prefetch") && !links[1].contains("data-no-prefetch"), "{links:?}");
    let mut one = String::new();
    crate::page::Nav { path: "/reports/suggested", to: &Suggested, section: false }.render_attrs(&mut one);
    assert_eq!(one, r#" href="/reports/suggested" data-nav aria-current="page" data-no-prefetch"#);

    // One costly only for some URLs says which, in a nav as in `href={..}`.
    #[derive(crate::Route)]
    #[route("/export", prefetch = cheap_step)]
    struct Export<'a> {
        step: Option<&'a str>,
    }
    fn cheap_step(at: &Export<'_>) -> bool {
        at.step != Some("pull-sheet")
    }
    let (pull, print) = (Export { step: Some("pull-sheet") }, Export { step: Some("print") });
    let links = written(nav_links("/", [(NavTo::page(&pull), ()), (NavTo::page(&print), ())]));
    assert!(links[0].ends_with(" data-no-prefetch") && !links[1].contains("data-no-prefetch"), "{links:?}");
    let held = &pull;
    assert_eq!(html! { <a href={held}>"Pull"</a> }.to_html(), r#"<a href="/export?step=pull-sheet" data-no-prefetch>Pull</a>"#);

    // In a routes module, named from where the module is, as a handler is: a function body
    // included (this test's).
    assert!(!crate::Route::may_prefetch(&url_steps::Steps { step: Some("pack") }));
    assert!(crate::Route::may_prefetch(&url_steps::Steps { step: None }));
    async fn local() -> &'static str {
        "local"
    }
    fn not_slow(at: &url_local::Local<'_>) -> bool {
        at.speed != Some("slow")
    }
    #[crate::routes]
    mod url_local {
        #[route("/local", get = local, prefetch = not_slow)]
        pub struct Local<'a> {
            pub speed: Option<&'a str>,
        }
    }
    assert!(!crate::Route::may_prefetch(&url_local::Local { speed: Some("slow") }));

    // A route held by reference says the same: an enum of links holding one, and `&&route`.
    #[derive(crate::Href)]
    enum Link<'a> {
        Pull(&'a Export<'a>),
        Report(&'a Suggested),
    }
    let (link, report) = (Link::Pull(&pull), Link::Report(&Suggested));
    assert_eq!(html! { <a href={link}>"Pull"</a> }.to_html(), r#"<a href="/export?step=pull-sheet" data-no-prefetch>Pull</a>"#);
    assert!(html! { <a href={report}>"R"</a> }.to_html().contains("data-no-prefetch"));
    let twice = &&pull;
    let to: &dyn crate::Href = &twice;
    assert!(!to.prefetch());

    // A link to a place on the page says what its route says, written or held as a `dyn Href`.
    let at = crate::Route::at(&pull, QtyId);
    let written = html! { <a href={at}>"Pull"</a> }.to_html();
    assert!(written.contains("/export?step=pull-sheet#") && written.ends_with(" data-no-prefetch>Pull</a>"), "{written}");
    let to: &dyn crate::Href = &crate::Route::at(&pull, QtyId);
    assert!(!to.prefetch());
    assert!(<dyn crate::Href>::prefetch(&crate::Route::at(&print, QtyId)));
}

async fn steps() -> &'static str {
    "steps"
}

/// For a routes module's route: every step but packing may be fetched on a hover.
fn not_pack(at: &url_steps::Steps<'_>) -> bool {
    at.step != Some("pack")
}

#[crate::routes]
mod url_steps {
    #[route("/steps", get = steps, prefetch = not_pack)]
    pub struct Steps<'a> {
        pub step: Option<&'a str>,
    }
}

#[test]
fn current_links_match_the_page_or_its_section() {
    use crate::page::is_current_for_tests as is_current;
    assert!(is_current("/sell", "/sell", false));
    assert!(is_current("/sell", "/sell?tab=2", false));
    assert!(!is_current("/sell/listings", "/sell", false));
    assert!(is_current("/sell/listings", "/sell", true));
    assert!(is_current("/sell/listings", "/sell/", true));
    assert!(!is_current("/seller", "/sell", true));
}

#[derive(crate::view::Id)]
struct SignUpId;

#[derive(crate::view::Id)]
struct LookUpFormId;

/// A form with no `Errors`, its `e` made before `html!` and borrowed by the view it returns.
#[crate::component]
fn LookUpForm() -> impl crate::Patch {
    let f = SignUp::FIELDS;
    let e = Within::none(LookUpFormId);
    html! {
        <form id={LookUpFormId}>
            <label for={e.id(f.email)}>"Email"</label>
            <input required {..e.control(f.email)}>
            {e.message(f.email)}
        </form>
    }
}

#[test]
fn a_form_with_no_errors_names_its_fields_from_its_id() {
    assert_eq!(
        LookUpForm {}.to_html(),
        r#"<form id="look-up-form"><label for="look-up-form-email">Email</label><input required id="look-up-form-email" name="email"></form>"#
    );
}

#[derive(crate::view::Id)]
struct MsgId;

fn alert_form(errors: &Errors) -> impl crate::Patch + '_ {
    let f = SignUp::FIELDS;
    let e = errors.within(SignUpId);
    html! { <form id={SignUpId}><input name={f.email} {..e.aria(f.email)}>{e.message(f.email)}</form> }
}

fn invalid_routes() -> Router {
    Router::new().route(
        "/",
        get(|req: Req| async move {
            let mut errors = Errors::new();
            errors.add(SignUp::FIELDS.email, "Enter an email address.");
            let page = || async { req.test_page("Alert", html! { <p>"page with errors"</p> }) };
            req.invalid(&errors, alert_form(&errors), page).await
        }),
    )
}

fn sheet_form(errors: &Errors) -> impl crate::Patch + '_ {
    html! { <form id={SignUpId}>{errors.form_message()}</form> }
}

fn refused_routes() -> Router {
    refused_by(crate::Refusal::Conflict, "Someone saved first.")
}

fn refused_by(why: crate::Refusal, message: &'static str) -> Router {
    Router::new().route(
        "/",
        get(move |req: Req| async move {
            let mut errors = Errors::new();
            errors.refuse(why, message);
            let page = || async { req.test_page("Sheet", html! { <p>"page with the refusal"</p> }) };
            req.invalid(&errors, sheet_form(&errors), page).await
        }),
    )
}

#[tokio::test]
async fn a_stale_submit_answers_409_with_the_form_message_in_each_mode() {
    let (status, headers, body) = call(app(refused_routes(), None), "GET", Some("action")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(headers["corten-patch"], "1");
    assert_eq!(body, r#"<form id="sign-up"><p class="form-error" role="alert">Someone saved first.</p></form>"#);

    let (status, _, body) = call(app(refused_routes(), None), "GET", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.contains("<p>page with the refusal</p>") && body.contains("<html"), "no JavaScript: the whole page");

    #[cfg(feature = "json")]
    {
        let (status, _, body) = call_with(app(refused_routes(), None), "GET", "/", None, Some("application/json")).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body,
            r#"{"title":"Conflict","status":409,"detail":"Someone saved first.","form":"Someone saved first.","fields":{}}"#
        );
    }
}

#[tokio::test]
async fn a_failed_service_answers_502_with_the_form_message_in_each_mode() {
    let routes = || refused_by(crate::Refusal::Upstream, "The carrier did not answer. Try again.");
    let (status, headers, body) = call(app(routes(), None), "GET", Some("action")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(headers["corten-patch"], "1", "the form, not the error page");
    assert_eq!(
        body,
        r#"<form id="sign-up"><p class="form-error" role="alert">The carrier did not answer. Try again.</p></form>"#
    );

    let (status, _, body) = call(app(routes(), None), "GET", None).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(
        body.contains("<p>page with the refusal</p>") && body.contains("<html"),
        "no JavaScript: the whole page, not the error page: {body}"
    );

    #[cfg(feature = "json")]
    {
        let (status, headers, body) = call_with(app(routes(), None), "GET", "/", None, Some("application/json")).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(headers["content-type"], "application/problem+json");
        assert_eq!(
            body,
            r#"{"title":"Bad Gateway","status":502,"detail":"The carrier did not answer. Try again.","form":"The carrier did not answer. Try again.","fields":{}}"#
        );
    }
}

/// A refusal whose form needs a read, drawn per mode: `reads` counts the form side's reads and
/// `pages` the page side's runs.
fn lazily_refused_routes(
    reads: std::sync::Arc<std::sync::atomic::AtomicU32>,
    pages: std::sync::Arc<std::sync::atomic::AtomicU32>,
) -> Router {
    Router::new().route(
        "/",
        get(move |req: Req| async move {
            let mut errors = Errors::new();
            errors.refuse(crate::Refusal::Conflict, "Someone saved first.");
            let page = || async {
                pages.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                req.test_page("Sheet", html! { <p>"page with the refusal"</p> })
            };
            // Written in the call, as an app does: the closure's type comes from `invalid_with`.
            let shown = &errors;
            req.invalid_with(
                &errors,
                |form| async {
                    reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    form.draw(html! { <form id={SignUpId}>{shown.form_message()}"read now"</form> })
                },
                page,
            )
            .await
        }),
    )
}

#[tokio::test]
async fn a_refusal_whose_form_needs_a_read_reads_only_for_the_patch() {
    use std::sync::atomic::Ordering::Relaxed;
    use std::sync::{atomic::AtomicU32, Arc};
    let (reads, pages) = (Arc::new(AtomicU32::new(0)), Arc::new(AtomicU32::new(0)));
    let routes = || lazily_refused_routes(reads.clone(), pages.clone());
    let (status, headers, body) = call(app(routes(), None), "GET", Some("action")).await;
    assert_eq!((status, &headers["corten-patch"]), (StatusCode::CONFLICT, &"1".parse().unwrap()));
    assert!(
        body.starts_with(r#"<form id="sign-up">"#) && body.contains("Someone saved first.") && body.ends_with("read now</form>"),
        "{body}"
    );
    assert_eq!((reads.load(Relaxed), pages.load(Relaxed)), (1, 0), "an action draws only the patch");

    let (status, _, body) = call(app(routes(), None), "GET", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.contains("<p>page with the refusal</p>"), "no JavaScript: the whole page");
    assert_eq!((reads.load(Relaxed), pages.load(Relaxed)), (1, 1), "the page reads nothing for the patch");

    let (status, _, _) = call(app(routes(), None), "GET", Some("nav")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!((reads.load(Relaxed), pages.load(Relaxed)), (1, 2), "a navigation gets the page");

    #[cfg(feature = "json")]
    {
        let (status, _, body) = call_with(app(routes(), None), "GET", "/", None, Some("application/json")).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body.contains(r#""status":409"#), "{body}");
        assert_eq!((reads.load(Relaxed), pages.load(Relaxed)), (1, 2), "a data client runs neither side");
    }
}
#[tokio::test]
async fn invalid_input_answers_422_in_each_mode() {
    let (status, headers, body) = call(app(invalid_routes(), None), "GET", Some("action")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(headers["corten-patch"], "1");
    assert_eq!(
        body,
        r#"<form id="sign-up"><input name="email" aria-invalid="true" aria-describedby="sign-up-email-error"><p class="field-error" id="sign-up-email-error">Enter an email address.</p></form>"#
    );

    let (status, _, body) = call(app(invalid_routes(), None), "GET", None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body.contains("<p>page with errors</p>") && body.contains("<html"), "no JavaScript: the whole page");

    #[cfg(feature = "json")]
    {
        let (status, _, body) = call_with(app(invalid_routes(), None), "GET", "/", None, Some("application/json")).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body,
            r#"{"title":"Unprocessable Entity","status":422,"detail":"email: Enter an email address.","fields":{"email":"Enter an email address."}}"#
        );
    }
}

#[tokio::test]
async fn a_page_that_reads_again_says_so_in_its_head_on_every_surface() {
    use std::time::Duration;
    let routes = Router::new().route(
        "/",
        get(|req: Req| async move {
            req.page::<ForOne>(Shell {
                req: &req,
                title: "Saving",
                head: ReadAgain { after: Duration::from_secs(2) },
                children: html! { <p>"Saving"</p> },
            })
        }),
    );
    let tag = r#"<noscript data-corten-read-again="2" data-corten-head><meta http-equiv="refresh" content="2"></noscript>"#;
    let (_, headers, document) = call(app(routes.clone(), None), "GET", None).await;
    assert!(
        document.contains(&format!("<title>Saving</title>{tag}")),
        "in <head>, where the browser reads it without JavaScript: {document}"
    );
    assert!(!headers.contains_key("refresh"), "not the header, which outlives the runtime's navigations");
    let (_, _, swap) = call(app(routes, None), "GET", Some("nav")).await;
    assert!(swap.starts_with(&format!("<title>Saving</title>{tag}<p>")), "a navigation's head tags: {swap}");
}

/// `ReadAgain::without_javascript` in the head (#319): the same refresh, without the mark the
/// runtime reads, on a full load and in a navigation's head tags.
#[tokio::test]
async fn a_page_that_reads_again_only_without_javascript_has_no_mark_in_its_head() {
    use std::time::Duration;
    let routes = Router::new().route(
        "/",
        get(|req: Req| async move {
            req.page::<ForOne>(Shell {
                req: &req,
                title: "Saving",
                head: ReadAgain { after: Duration::from_secs(2) }.without_javascript(),
                children: html! { <p>"Saving"</p> },
            })
        }),
    );
    let tag = r#"<noscript data-corten-head><meta http-equiv="refresh" content="2"></noscript>"#;
    let (_, headers, document) = call(app(routes.clone(), None), "GET", None).await;
    assert!(document.contains(&format!("<title>Saving</title>{tag}")), "{document}");
    assert!(!document.contains("data-corten-read-again"), "the runtime finds nothing to read again: {document}");
    assert!(!headers.contains_key("refresh"));
    let (_, _, swap) = call(app(routes, None), "GET", Some("nav")).await;
    assert!(swap.starts_with(&format!("<title>Saving</title>{tag}<p>")), "a navigation's head tags: {swap}");
}

#[test]
fn read_again_is_whole_seconds_and_works_without_javascript() {
    use std::time::Duration;
    let tag = |after| ReadAgain { after }.to_html();
    assert_eq!(
        tag(Duration::from_secs(2)),
        r#"<noscript data-corten-read-again="2"><meta http-equiv="refresh" content="2"></noscript>"#
    );
    assert!(tag(Duration::from_millis(1500)).contains(r#"read-again="2""#), "rounded up");
    assert!(tag(Duration::ZERO).contains(r#"read-again="1""#), "never sooner than a second");
}

/// Browsers keep a full load's `Refresh` after the runtime navigates away, then load it again.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_page_with_a_refresh_header_is_an_error_in_debug_builds() {
    let routes = Router::new().route(
        "/",
        get(|req: Req| async move {
            let mut res = req.test_page("Saving", html! { <p>"Saving"</p> })?;
            res.headers_mut().insert("refresh", axum::http::HeaderValue::from_static("2"));
            Ok::<_, crate::Error>(res)
        }),
    );
    for mode in [None, Some("nav")] {
        let res = app(routes.clone(), None).oneshot(request_in(mode)).await.unwrap();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR, "{mode:?}");
        assert!(!res.headers().contains_key("refresh"), "{mode:?}");
    }
    let api = Router::new().route("/", get(|| async { ([("refresh", "2")], "ok") }));
    assert_eq!(call(app(api, None), "GET", None).await.0, StatusCode::OK, "only pages are checked");
}

/// A write redirected to an origin the form's page does not allow in `form-action` is an error in
/// a debug build, as the browser stops it there; one the policy allows, a path, a page's own
/// host and a `GET` are not, and an area's policy or the sending page's counts.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_write_redirected_outside_form_action_is_an_error_in_debug_builds() {
    use crate::security::Policy;
    let to = |uri: &'static str| {
        axum::routing::post(move |req: Req| async move {
            let uri: axum::http::Uri = uri.parse().unwrap();
            req.redirect::<()>(&uri)
        })
    };
    let routes = Router::new()
        .route("/sibling", to("http://localhost:9999/account"))
        .route("/pay", to("https://pay.example/checkout?o=1"))
        .route("/sub", to("https://id.shop.example/login"))
        .route("/own", to("http://app.localhost/done"))
        .route("/path", to("/done"))
        .route("/public", to("https://app.localhost/done"))
        .route("/else", to("https://else.example/x"))
        .route(
            "/relay",
            axum::routing::post(|| async {
                let mut headers = axum::http::HeaderMap::new();
                headers.insert(axum::http::header::LOCATION, axum::http::HeaderValue::from_static("https://upstream.example/x"));
                crate::Relay::new(StatusCode::FOUND, headers, Body::empty())
            }),
        )
        .route(
            "/read",
            get(|req: Req| async move { req.redirect::<()>(&"https://else.example/".parse::<axum::http::Uri>().unwrap()) }),
        );
    let policy = Policy::new()
        .form_action("https://pay.example")
        .form_action("https://*.shop.example")
        .allow_origin("https://idp.example");
    let router = App::new(Routes::from(routes))
        .policy(policy)
        .area(|area| checkout_url::area(area).policy(|p| p.form_action("http://localhost:9999")))
        .router();
    let send = |path: &'static str, method: &'static str, headers: &'static [(&'static str, &'static str)]| {
        let router = router.clone();
        async move {
            let mut req = Request::builder().method(method).uri(path).header("accept", "text/html");
            for (name, value) in headers {
                req = req.header(*name, *value);
            }
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let status = res.status();
            let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
            (status, String::from_utf8(body.to_vec()).unwrap())
        }
    };
    for mode in [&[][..], &[("corten", "action")][..], &[("corten", "action"), ("sec-fetch-mode", "cors")][..]] {
        let (status, _) = send("/else", "POST", mode).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{mode:?}");
    }
    // Without a Referer the form may be on any of the app's pages: the checkout area allows this.
    let (status, _) = send("/sibling", "POST", &[]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "some page of the app allows it");
    // A script's own fetch is held to connect-src, not form-action.
    let (status, _) = send("/sibling", "POST", &[("sec-fetch-mode", "cors"), ("sec-fetch-site", "same-origin")]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "a fetch");
    // A relayed answer is passed on as it came.
    let (status, _) = send("/relay", "POST", &[]).await;
    assert_eq!(status, StatusCode::FOUND, "a relay");
    // Behind a proxy that rewrites Host, the page's origin is the browser's Origin.
    const PROXIED: &[(&str, &str)] =
        &[("host", "127.0.0.1:3000"), ("origin", "https://app.localhost"), ("sec-fetch-site", "same-origin")];
    let (status, _) = send("/public", "POST", PROXIED).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "the page's own origin");
    const PLAIN: &[(&str, &str)] =
        &[("host", "app.localhost"), ("origin", "http://app.localhost"), ("sec-fetch-site", "same-origin")];
    let (status, _) = send("/public", "POST", PLAIN).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "an http page may go to its https origin");
    const SECURE: &[(&str, &str)] =
        &[("host", "app.localhost"), ("origin", "https://app.localhost"), ("sec-fetch-site", "same-origin")];
    let (status, _) = send("/own", "POST", SECURE).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "an https page's form may not go to http");
    for path in ["/pay", "/sub", "/path"] {
        let (status, _) = send(path, "POST", &[]).await;
        assert!(status == StatusCode::SEE_OTHER, "{path}: {status}");
    }
    let (status, _) = send("/own", "POST", &[("host", "app.localhost")]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "the request's own host is 'self'");
    let (status, _) = send("/own", "POST", &[]).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "with no Host, an address is another origin");
    let (status, _) = send("/read", "GET", &[]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "a GET is not held to form-action");
    // An area's policy holds a write at its path, and the page the form was on counts too.
    let (status, _) = send("/checkout/go", "POST", &[]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "the area allows it");
    const FROM_AREA: &[(&str, &str)] = &[("host", "app.localhost"), ("referer", "http://app.localhost/checkout?step=2")];
    let (status, _) = send("/sibling", "POST", FROM_AREA).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "the form's page, in the area, allows it");
    // A post from another site's page (an identity provider's form_post) is that page's policy's.
    const IDP: &[(&str, &str)] =
        &[("host", "app.localhost"), ("origin", "https://idp.example"), ("sec-fetch-site", "cross-site")];
    assert_eq!(send("/else", "POST", IDP).await.0, StatusCode::SEE_OTHER, "cross-site");
    const IDP_OLD: &[(&str, &str)] = &[("host", "app.localhost"), ("origin", "https://idp.example")];
    assert_eq!(send("/else", "POST", IDP_OLD).await.0, StatusCode::SEE_OTHER, "another origin, no Sec-Fetch-Site");
    // A test that names no host and sends the form's page is held to that page's policy.
    let (status, _) = send("/sibling", "POST", &[("referer", "http://app.localhost/news")]).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "the Referer alone says the page");
    const FROM_NEWS: &[(&str, &str)] = &[("host", "app.localhost"), ("referer", "http://app.localhost/news")];
    let (status, _) = send("/sibling", "POST", FROM_NEWS).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "the news page does not allow it");
    // A Referer of `/` is what any page under a referrer policy that sends only the origin sends
    // (one the page set itself included): it names no page.
    const ROOT: &[(&str, &str)] = &[("host", "app.localhost"), ("referer", "http://app.localhost/")];
    let (status, _) = send("/sibling", "POST", ROOT).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "a Referer of / may be any page");
    // Other ways a browser says the page is not one of the app's, and the bodies a form sends.
    for site in ["same-site", "none"] {
        let headers: &'static [(&'static str, &'static str)] = match site {
            // Allowed by `allow_origin`, else the write is refused before the check.
            "same-site" => &[("host", "app.localhost"), ("origin", "https://idp.example"), ("sec-fetch-site", "same-site")],
            _ => &[("host", "app.localhost"), ("origin", "http://app.localhost"), ("sec-fetch-site", "none")],
        };
        assert_eq!(send("/else", "POST", headers).await.0, StatusCode::SEE_OTHER, "{site}");
    }
    for body in ["multipart/form-data; boundary=x", "text/plain"] {
        let headers: &'static [(&'static str, &'static str)] = match body {
            "text/plain" => &[("content-type", "text/plain")],
            _ => &[("content-type", "multipart/form-data; boundary=x")],
        };
        assert_eq!(send("/else", "POST", headers).await.0, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    }
    // An https page's Origin and a Host that writes its default port are the same origin.
    const PORT: &[(&str, &str)] =
        &[("host", "app.localhost:443"), ("origin", "https://app.localhost"), ("sec-fetch-site", "same-origin")];
    assert_eq!(send("/public", "POST", PORT).await.0, StatusCode::SEE_OTHER, "Host with :443");
    // A browser that does not say the page's origin is not checked.
    const NULL: &[(&str, &str)] = &[("host", "127.0.0.1:3000"), ("origin", "null"), ("sec-fetch-site", "same-origin")];
    let (status, _) = send("/else", "POST", NULL).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "Origin: null");
    // A Host with its scheme's default port is the same host.
    let (status, _) = send("/own", "POST", &[("host", "app.localhost:80")]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "Host with :80");
    // Only the form's page's policy counts, not the one at the path it posts to.
    const FROM_HOME: &[(&str, &str)] = &[
        ("host", "app.localhost"),
        ("origin", "http://app.localhost"),
        ("sec-fetch-site", "same-origin"),
        ("referer", "http://app.localhost/news"),
    ];
    let (status, _) = send("/checkout/go", "POST", FROM_HOME).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "the news page does not allow it");
    // A browser that sends no page (no-referrer) may be on any of the app's pages.
    const NO_PAGE: &[(&str, &str)] =
        &[("host", "app.localhost"), ("origin", "http://app.localhost"), ("sec-fetch-site", "same-origin")];
    let (status, _) = send("/sibling", "POST", NO_PAGE).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "some page of the app allows it");
    let (status, _) = send("/pay", "POST", NO_PAGE).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
}

/// The 500 says which origin and what allows it, under `corten dev`; a sign-in on another origin
/// is checked as a redirect is.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_redirect_outside_form_action_names_the_origin_and_a_sign_in_is_checked() {
    let routes = Router::new()
        .route(
            "/go",
            axum::routing::post(|req: Req| async move {
                req.redirect::<()>(&"https://else.example/x?y=1".parse::<axum::http::Uri>().unwrap())
            }),
        )
        .route("/account", axum::routing::post(|_: Caller<Elsewhere>| async { "saved" }))
        .route(
            "/cookie",
            axum::routing::post(|| async {
                use axum::{
                    http::{header, HeaderValue},
                    response::IntoResponse,
                };
                let mut res = StatusCode::SEE_OTHER.into_response();
                let headers = res.headers_mut();
                headers.insert(header::LOCATION, HeaderValue::from_static("//user:pw@else.example/secret?token=abc"));
                headers.append(header::SET_COOKIE, HeaderValue::from_static("a=1"));
                headers.append(header::SET_COOKIE, HeaderValue::from_static("b=2"));
                res
            }),
        );
    let dev = App::new(Routes::from(routes.clone())).dev(true).router();
    let (status, _, body) = call_with(dev.clone(), "POST", "/go", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body.contains("https://else.example") && body.contains("Policy::form_action"), "{body}");
    assert!(!body.contains("/x?y=1"), "the origin alone: {body}");
    assert!(body.contains("send a Host in the test"), "no host is known: {body}");
    let (status, headers, body) = call_with(dev.clone(), "POST", "/cookie", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let cookies: Vec<_> = headers.get_all("set-cookie").iter().collect();
    assert_eq!(cookies, ["a=1", "b=2"], "the handler's cookies are kept");
    assert!(!headers.contains_key("location"));
    assert!(body.contains("else.example") && !body.contains("token") && !body.contains("pw@"), "the origin alone: {body}");
    let (status, _, body) = call_with(dev, "POST", "/account", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(body.contains("https://id.example") && body.contains("Policy::form_action"), "{body}");
    let allowed = App::new(Routes::from(routes.clone())).policy(crate::security::Policy::new().form_action("https://id.example"));
    let (status, ..) = call_with(allowed.router(), "POST", "/account", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "allowed, it is the sign-in redirect");
    let (status, _, body) =
        call_with(App::new(Routes::from(routes.clone())).router(), "POST", "/go", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!body.contains("else.example"), "outside dev the page does not say: {body}");
    // A report-only policy stops nothing.
    let watching = App::new(Routes::from(routes)).policy(crate::security::Policy::new().report_only());
    let (status, ..) = call_with(watching.router(), "POST", "/go", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "report-only");
}

/// `resend_to` answers a write with a 307 to a page of the app in every mode, so the browser (or a
/// `data-patch` form's fetch, which follows it) sends the same form there with the cookie set
/// beside it; on a `GET` it is an error that says to redirect (#717).
#[tokio::test]
async fn a_write_resends_its_form_with_a_307_in_every_mode() {
    #[derive(crate::Route)]
    #[route("/items/{id}")]
    struct Item<'a> {
        id: &'a str,
    }
    async fn start(req: Req) -> HtmlResult {
        let to = crate::Local::parse("/start/again?x=1").unwrap();
        Ok(req.resend_to(&to)?.with_cookie(crate::security::cookie::SetCookie::new("guest", "g1")))
    }
    let routes = Router::new()
        .route("/start", get(start).post(start))
        .route("/item", axum::routing::post(|req: Req| async move { req.resend_to::<()>(&Item { id: "7" }) }));
    let router = App::new(Routes::from(routes)).router();
    for mode in [None, Some("action")] {
        let (status, headers, _) = call_with(router.clone(), "POST", "/start", mode, None).await;
        assert_eq!(
            (status, &headers["location"]),
            (StatusCode::TEMPORARY_REDIRECT, &"/start/again?x=1".parse().unwrap()),
            "{mode:?}"
        );
        assert!(headers["set-cookie"].to_str().unwrap().starts_with("guest=g1;"), "{mode:?}");
        assert!(!headers.contains_key("corten-location"), "a fetch follows a 307 itself: {mode:?}");
        let (status, headers, _) = call_with(router.clone(), "POST", "/item", mode, None).await;
        assert_eq!(
            (status, &headers["location"]),
            (StatusCode::TEMPORARY_REDIRECT, &"/items/7".parse().unwrap()),
            "a typed route: {mode:?}"
        );
    }
    for mode in [None, Some("nav")] {
        let (status, headers, _) = call_with(router.clone(), "GET", "/start", mode, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "a GET is redirected, not resent: {mode:?}");
        assert!(!headers.contains_key("location") && !headers.contains_key("set-cookie"), "{mode:?}");
    }
    // A catch-all value that begins with `/` stays a path on this site (`/%2F..`, #727), so the
    // form goes there. A PUT, which the debug build's form-action check does not read. An address
    // a hand-written Route writes off the site is refused: a_path_that_starts_with_a_parameter_...
    #[derive(crate::Route)]
    #[route("/{*rest}")]
    struct Rest<'a> {
        rest: &'a str,
    }
    let off = Router::new()
        .route("/off", axum::routing::put(|req: Req| async move { req.resend_to::<()>(&Rest { rest: "/evil.example/x" }) }));
    let (status, headers, _) = call_with(App::new(Routes::from(off)).router(), "PUT", "/off", None, None).await;
    assert_eq!((status, &headers["location"]), (StatusCode::TEMPORARY_REDIRECT, &"/%2Fevil.example/x".parse().unwrap()));
}

/// Only a form's post is checked (a form sends nothing else), a test's request is on the app's
/// own names, and a page whose policy sends only its origin as `Referer` may be any page.
#[cfg(debug_assertions)]
#[tokio::test]
async fn only_a_form_post_is_checked_against_form_action() {
    use crate::security::{Policy, Referrer};
    let to = |uri: &'static str| {
        move |req: Req| async move {
            let uri: axum::http::Uri = uri.parse().unwrap();
            req.redirect::<()>(&uri)
        }
    };
    let routes = Router::new()
        .route("/else", axum::routing::post(to("https://else.example/x")).put(to("https://else.example/x")))
        .route("/canonical", axum::routing::post(to("https://app.example/done")))
        .route("/sibling", axum::routing::post(to("http://localhost:9999/account")));
    let router = App::new(Routes::from(routes))
        .policy(Policy::new().host("app.example").referrer(Referrer::StrictOrigin))
        .area(|area| checkout_url::area(area).policy(|p| p.form_action("http://localhost:9999")))
        .router();
    let send = |method: &'static str, path: &'static str, headers: &'static [(&'static str, &'static str)]| {
        let router = router.clone();
        async move {
            let mut req = Request::builder().method(method).uri(path).header("accept", "text/html");
            for (name, value) in headers {
                req = req.header(*name, *value);
            }
            router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().status()
        }
    };
    assert_eq!(send("POST", "/else", &[]).await, StatusCode::INTERNAL_SERVER_ERROR, "a form's post");
    const FORM: &[(&str, &str)] = &[("content-type", "application/x-www-form-urlencoded; charset=utf-8")];
    assert_eq!(send("POST", "/else", FORM).await, StatusCode::INTERNAL_SERVER_ERROR, "a form's body");
    assert_eq!(send("PUT", "/else", &[]).await, StatusCode::SEE_OTHER, "no form sends a PUT");
    const JSON: &[(&str, &str)] = &[("content-type", "application/json")];
    assert_eq!(send("POST", "/else", JSON).await, StatusCode::SEE_OTHER, "no form sends JSON");
    assert_eq!(send("POST", "/canonical", &[]).await, StatusCode::SEE_OTHER, "the app's own name, with no Host");
    // Under strict-origin every page's Referer is `/`: the form may be on the checkout page.
    const ROOT: &[(&str, &str)] = &[
        ("host", "app.example"),
        ("origin", "https://app.example"),
        ("sec-fetch-site", "same-origin"),
        ("referer", "https://app.example/"),
    ];
    assert_eq!(send("POST", "/sibling", ROOT).await, StatusCode::SEE_OTHER, "a Referer of / is not the page");
}

/// Someone signed in on another origin's sign-in page.
#[cfg(debug_assertions)]
#[derive(Clone, Hash)]
struct Elsewhere;

#[cfg(debug_assertions)]
impl<S: Sync> crate::Identify<S> for Elsewhere {
    async fn identify(_: &axum::http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
        Err(crate::Refused::sign_in(&"https://id.example/sign-in".parse::<axum::http::Uri>().unwrap()))
    }
}

#[cfg(debug_assertions)]
#[crate::routes(area = Checkout)]
mod checkout_url {
    #[route("/checkout")]
    pub struct Checkout;

    #[route("/checkout/go", post = checkout_go)]
    pub struct Go;
}

#[cfg(debug_assertions)]
async fn checkout_go(req: Req) -> HtmlResult {
    req.redirect(&"http://localhost:9999/paid".parse::<axum::http::Uri>().unwrap())
}

/// A value only the layout shows is read for a full load, not for an answer the runtime swaps in.
#[tokio::test]
async fn a_layout_value_is_read_only_when_the_layout_renders() {
    use std::sync::atomic::{AtomicU32, Ordering};
    static READS: AtomicU32 = AtomicU32::new(0);
    let routes = Router::new().route(
        "/",
        get(|req: Req| async move {
            let count = if req.mode.swaps() { None } else { Some(READS.fetch_add(1, Ordering::Relaxed) + 7) };
            req.page::<()>(html! {
                <html>
                    <head>
                        <title>"Shop"</title>
                        <Corten />
                    </head>
                    <body>
                        <header>"Cart "{count.unwrap_or(0)}</header>
                        <main>"Items"</main>
                    </body>
                </html>
            })
        }),
    );
    let (_, _, body) = call_with(app(routes.clone(), None), "GET", "/", None, Some("text/html")).await;
    assert!(body.contains("Cart 7"), "{body}");
    for mode in ["nav", "action"] {
        let (_, _, body) = call_with(app(routes.clone(), None), "GET", "/", Some(mode), Some("text/html")).await;
        assert!(!body.contains("Cart") && body.contains("Items"), "{mode}: {body}");
    }
    assert_eq!(READS.load(Ordering::Relaxed), 1, "read once, for the full load");
    assert!(
        [Mode::Navigation, Mode::Action].iter().all(|m| m.swaps()) && ![Mode::Document, Mode::Data].iter().any(|m| m.swaps())
    );
}

/// Only the debug-build test above sends one.
#[cfg(debug_assertions)]
fn request_in(mode: Option<&str>) -> Request<Body> {
    let req = Request::builder().uri("/").header("accept", "text/html");
    match mode {
        Some(mode) => req.header("corten", mode),
        None => req,
    }
    .body(Body::empty())
    .unwrap()
}

#[tokio::test]
async fn a_page_that_moved_answers_301_in_every_mode_and_a_form_navigates() {
    #[derive(crate::Route)]
    #[route("/items/{slug}")]
    struct Item<'a> {
        slug: &'a str,
    }
    let routes = Router::new().route("/", get(|req: Req| async move { req.moved::<ForOne>(&Item { slug: "pika chu" }) }));
    for (mode, accept) in [(None, Some("text/html")), (Some("nav"), None), (None, Some("application/json"))] {
        let (status, headers, _) = call_with(app(routes.clone(), None), "GET", "/", mode, accept).await;
        assert_eq!(status, StatusCode::MOVED_PERMANENTLY, "{mode:?} {accept:?}");
        assert_eq!(headers["location"], "/items/pika%20chu");
        assert_eq!(headers["cache-control"], "private, max-age=86400", "the browser keeps it, no shared cache");
    }
    let (status, headers, _) = call(app(routes, None), "GET", Some("action")).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "a data-patch form is sent on, as by redirect");
    assert_eq!(headers["corten-location"], "/items/pika%20chu");
}

#[tokio::test]
async fn a_redirect_to_a_place_keeps_its_fragment_in_every_mode() {
    #[derive(crate::Route)]
    #[route("/items/{slug}")]
    struct Item<'a> {
        slug: &'a str,
    }
    #[derive(crate::view::Id)]
    struct PlaceId<'a>(&'a str);
    let routes = Router::new()
        .route("/", get(|req: Req| async move { req.redirect::<ForOne>(&Item { slug: "pika chu" }.at(PlaceId("7 & 8"))) }))
        .route("/old", get(|req: Req| async move { req.moved::<ForOne>(&Item { slug: "pika" }.at(PlaceId("7"))) }));
    let place = "/items/pika%20chu#place-7%20%26%208";
    let (status, headers, _) = call(app(routes.clone(), None), "GET", None).await;
    assert_eq!((status, &headers["location"]), (StatusCode::SEE_OTHER, &place.parse().unwrap()), "a full load follows it");
    // fetch would follow a 303 and drop the fragment, so the runtime is told where to go.
    for mode in ["nav", "action"] {
        let (status, headers, _) = call(app(routes.clone(), None), "GET", Some(mode)).await;
        assert_eq!((status, &headers["corten-location"]), (StatusCode::NO_CONTENT, &place.parse().unwrap()), "{mode}");
    }
    let (status, headers, _) = call_with(app(routes.clone(), None), "GET", "/old", Some("nav"), None).await;
    assert_eq!((status, &headers["corten-location"]), (StatusCode::NO_CONTENT, &"/items/pika#place-7".parse().unwrap()));
    let (status, headers, _) = call_with(app(routes, None), "GET", "/old", None, Some("text/html")).await;
    assert_eq!((status, &headers["location"]), (StatusCode::MOVED_PERMANENTLY, &"/items/pika#place-7".parse().unwrap()));
}

/// A client navigation's `fetch` cannot follow a redirect to another origin (the CSP's
/// `connect-src`, else CORS), so it is told where to go and the browser goes there itself; a full
/// load still gets the 303 or 301.
#[tokio::test]
async fn a_redirect_to_another_origin_is_named_to_a_client_navigation() {
    use axum::http::Uri;
    let routes = Router::new()
        .route(
            "/away",
            get(|req: Req| async move { req.redirect::<ForOne>(&"https://shop.example/sales?x=1".parse::<Uri>().unwrap()) }),
        )
        .route("/moved", get(|req: Req| async move { req.moved::<ForOne>(&"//shop.example/sales".parse::<Uri>().unwrap()) }))
        .route("/here", get(|req: Req| async move { req.redirect::<ForOne>(&Done) }));
    for (uri, to, full) in [
        ("/away", "https://shop.example/sales?x=1", StatusCode::SEE_OTHER),
        ("/moved", "//shop.example/sales", StatusCode::MOVED_PERMANENTLY),
    ] {
        for mode in ["nav", "action"] {
            let (status, headers, _) = call_with(app(routes.clone(), None), "GET", uri, Some(mode), None).await;
            assert_eq!((status, &headers["corten-location"]), (StatusCode::NO_CONTENT, &to.parse().unwrap()), "{uri} {mode}");
            assert!(!headers.contains_key("location"), "{uri} {mode}: nothing for fetch to follow");
        }
        let (status, headers, _) = call_with(app(routes.clone(), None), "GET", uri, None, Some("text/html")).await;
        assert_eq!((status, &headers["location"]), (full, &to.parse().unwrap()), "{uri}: a full load follows it");
    }
    // A path on this origin is still a redirect fetch follows, in one round trip.
    let (status, headers, _) = call_with(app(routes, None), "GET", "/here", Some("nav"), None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(!headers.contains_key("corten-location"));
}

/// A place on a page outside the app keeps its `#fragment` through `moved` and `redirect`, which
/// a `corten::http::Uri` alone drops.
#[tokio::test]
async fn a_redirect_to_a_place_elsewhere_keeps_its_fragment() {
    use crate::route::Elsewhere;
    use axum::http::Uri;
    static COMPARE: std::sync::LazyLock<Uri> = std::sync::LazyLock::new(|| Uri::from_static("https://example.com/compare?x=1"));
    let routes = Router::new()
        .route("/old", get(|req: Req| async move { req.moved::<ForOne>(&Elsewhere::at(&COMPARE, "fee-calculator")) }))
        .route("/go", get(|req: Req| async move { req.redirect::<ForOne>(&Elsewhere::at(&COMPARE, "fees & taxes")) }));
    let place = "https://example.com/compare?x=1#fee-calculator";
    let (status, headers, _) = call_with(app(routes.clone(), None), "GET", "/old", None, Some("text/html")).await;
    assert_eq!((status, &headers["location"]), (StatusCode::MOVED_PERMANENTLY, &place.parse().unwrap()), "a full load");
    let (status, headers, _) = call_with(app(routes.clone(), None), "GET", "/old", Some("nav"), None).await;
    assert_eq!((status, &headers["corten-location"]), (StatusCode::NO_CONTENT, &place.parse().unwrap()), "a client navigation");
    let (status, headers, _) = call_with(app(routes, None), "GET", "/go", None, Some("text/html")).await;
    let to = "https://example.com/compare?x=1#fees%20&%20taxes";
    assert_eq!((status, &headers["location"]), (StatusCode::SEE_OTHER, &to.parse().unwrap()));
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "Elsewhere::at takes a full URL outside the app")]
fn a_place_elsewhere_on_a_path_panics_in_debug_builds() {
    let path = axum::http::Uri::from_static("/items/pika");
    let _ = crate::route::Elsewhere::at(&path, "place-7");
}

#[cfg(debug_assertions)]
#[tokio::test]
#[should_panic(expected = "top-level text \"saved\" outside an element")]
async fn a_live_fragment_the_browser_would_drop_panics_in_debug_builds() {
    let router = Router::new().route("/", get(|| async { crate::live(futures_util::stream::iter([String::from("saved")])) }));
    let _ = call(router, "GET", None).await;
}

#[derive(Fields)]
#[allow(dead_code)]
struct SignUp {
    email: String,
    #[serde(rename = "pw")]
    password: String,
    #[serde(skip)]
    internal: u8,
}

#[derive(Fields)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
pub(crate) struct Shipping {
    pub street_line: String,
    postal_code: Option<Vec<(u8, String)>>,
    r#type: std::collections::HashMap<String, fn(u8) -> u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Deserialize, crate::UrlValue)]
#[serde(rename_all = "kebab-case")]
enum Domain {
    SellerPortal,
    Catalog,
}

#[derive(Debug, PartialEq, serde::Deserialize, Fields)]
struct Address {
    street: String,
    zip: Option<u32>,
}

#[derive(Debug, PartialEq, serde::Deserialize, Fields)]
struct DomainLimits {
    max_concurrent: u32,
    #[serde(default)]
    adaptive: bool,
    #[fields(group)]
    contact: Address,
}

#[derive(Debug, PartialEq, serde::Deserialize, Fields)]
struct Limits {
    name: String,
    #[fields(group)]
    ship_from: Address,
    #[fields(group)]
    ship_to: Address,
    #[fields(rows)]
    #[serde(default)]
    domains: std::collections::BTreeMap<Domain, DomainLimits>,
}

#[derive(crate::view::Id)]
struct LimitsFormId;

/// A group's fields are named under it and a row's under its key, so two groups of one type
/// and every row read into their own values, and each row's field has its own message.
#[test]
fn groups_and_rows_name_each_field_and_read_back_by_key() {
    let f = Limits::FIELDS;
    assert_eq!(f.name.to_string(), "name");
    assert_eq!(f.ship_to.street.to_string(), "ship_to.street");
    let portal = f.domains.at(&Domain::SellerPortal);
    assert_eq!(portal.max_concurrent.to_string(), "domains[seller-portal].max_concurrent");
    assert_eq!(portal.contact.zip.to_string(), "domains[seller-portal].contact.zip");
    let keyed = Limits2::FIELDS.lines.at(&"a b]\"c".to_string()).qty.to_string();
    assert_eq!(keyed, "lines[a%20b%5D%22c].qty");

    // Out of order, a row with its checkbox unchecked, the catalog row's zip blank.
    let body = "domains%5Bcatalog%5D.max_concurrent=4&ship_to.street=2+Elm&name=Main\
        &domains%5Bseller-portal%5D.adaptive=on&domains%5Bseller-portal%5D.contact.street=1+Oak\
        &ship_from.street=9+Ash&domains%5Bcatalog%5D.contact.street=3+Pine&ship_from.zip=55401\
        &domains%5Bseller-portal%5D.max_concurrent=2&domains%5Bcatalog%5D.contact.zip=&ship_to.zip=";
    let form: Limits = crate::form::from_bytes(body.as_bytes()).expect("reads");
    assert_eq!(form.name, "Main");
    assert_eq!(form.ship_from, Address { street: "9 Ash".into(), zip: Some(55401) });
    assert_eq!(form.ship_to, Address { street: "2 Elm".into(), zip: None });
    assert_eq!(
        form.domains[&Domain::SellerPortal],
        DomainLimits { max_concurrent: 2, adaptive: true, contact: Address { street: "1 Oak".into(), zip: None } }
    );
    assert_eq!(
        form.domains[&Domain::Catalog],
        DomainLimits { max_concurrent: 4, adaptive: false, contact: Address { street: "3 Pine".into(), zip: None } }
    );
    let keyed: Limits2 = crate::form::from_bytes(b"lines%5Ba%2520b%255D%2522c%5D.qty=3").expect("reads");
    assert_eq!(keyed.lines["a b]\"c"].qty, 3);

    // A row left out reads no row; nothing shifts.
    let one: Limits = crate::form::from_bytes(
        b"name=x&ship_from.street=a&ship_to.street=b&domains%5Bcatalog%5D.max_concurrent=1&domains%5Bcatalog%5D.contact.street=c",
    )
    .expect("reads");
    assert_eq!(one.domains.keys().collect::<Vec<_>>(), [&Domain::Catalog]);

    // Mistakes name the field as posted.
    let err = |body: &str| crate::form::from_bytes::<Limits>(body.as_bytes()).unwrap_err().to_string();
    let base = "name=x&ship_from.street=a&ship_to.street=b";
    assert_eq!(err("name=x&ship_to.street=b"), "missing field `ship_from`");
    assert_eq!(err("name=x&ship_from.zip=1&ship_to.street=b"), "ship_from: missing field `street`");
    assert!(
        err(&format!("{base}&domains%5Bcatalog%5D.max_concurrent=x&domains%5Bcatalog%5D.contact.street=c"))
            .starts_with("domains[catalog].max_concurrent: invalid"),
        "{}",
        err(&format!("{base}&domains%5Bcatalog%5D.max_concurrent=x&domains%5Bcatalog%5D.contact.street=c"))
    );
    assert!(
        err(&format!("{base}&domains%5Bnope%5D.max_concurrent=1")).starts_with("domains[nope]: key: unknown variant `nope`"),
        "{}",
        err(&format!("{base}&domains%5Bnope%5D.max_concurrent=1"))
    );

    // An error on one row marks that row's input only, with its own message id.
    let mut errors = Errors::new();
    errors.add(f.domains.at(&Domain::SellerPortal).max_concurrent, "At least 1.");
    errors.add(f.domains.at(&Domain::SellerPortal).max_concurrent, "dropped: the field has one");
    errors.add(f.domains.at(&Domain::Catalog).max_concurrent, "At most 8.");
    let e = &errors.within(LimitsFormId);
    let row = |d: Domain| {
        let field = f.domains.at(&d).max_concurrent;
        html! { <input name={field} {..e.aria(field)}>{e.message(field)} }.to_html()
    };
    assert_eq!(
        row(Domain::SellerPortal),
        r#"<input name="domains[seller-portal].max_concurrent" aria-invalid="true" aria-describedby="limits-form-domains[seller-portal].max_concurrent-error"><p class="field-error" id="limits-form-domains[seller-portal].max_concurrent-error">At least 1.</p>"#
    );
    assert!(row(Domain::Catalog).contains("At most 8."));
    assert!(!errors.has(f.domains.at(&Domain::SellerPortal).contact.street));
    assert_eq!(
        errors.to_string(),
        "domains[seller-portal].max_concurrent: At least 1.; domains[catalog].max_concurrent: At most 8."
    );
}

#[derive(Debug, serde::Deserialize, Fields)]
struct Line {
    qty: u32,
}

#[derive(Debug, serde::Deserialize, Fields)]
struct Limits2 {
    #[fields(rows)]
    #[serde(default)]
    lines: std::collections::BTreeMap<String, Line>,
}

#[derive(Debug, serde::Deserialize, Fields)]
struct Numbered {
    #[fields(rows)]
    #[serde(default)]
    lines: std::collections::BTreeMap<u32, Line>,
}

#[derive(Debug, serde::Deserialize, Fields)]
struct Counts {
    note: String,
    #[fields(map)]
    #[serde(default)]
    counts: std::collections::BTreeMap<u32, u32>,
}

/// One plain value per key (a count per SKU) is `map[key]`, read back by key, each with its own
/// error.
#[test]
fn a_map_names_each_keys_value() {
    let f = Counts::FIELDS;
    assert_eq!(f.counts.at(&7).to_string(), "counts[7]");
    let read: Counts = crate::form::from_bytes(b"counts%5B7%5D=3&note=x&counts%5B12%5D=0").expect("reads");
    assert_eq!(read.counts.into_iter().collect::<Vec<_>>(), [(7, 3), (12, 0)]);
    let err = crate::form::from_bytes::<Counts>(b"note=x&counts%5B7%5D=many").unwrap_err().to_string();
    assert!(err.starts_with("counts[7]: invalid value"), "{err}");
    let none: Counts = crate::form::from_bytes(b"note=x").expect("no keys: an empty map");
    assert!(none.counts.is_empty() && none.note == "x");

    let mut errors = Errors::new();
    errors.add(f.counts.at(&7), "Not that many.");
    let e = errors.within(LimitsFormId);
    let field = f.counts.at(&7);
    assert_eq!(
        html! { <input name={field} {..e.aria(field)}> }.to_html(),
        r#"<input name="counts[7]" aria-invalid="true" aria-describedby="limits-form-counts[7]-error">"#
    );
    assert!(!errors.has(f.counts.at(&12)));
}

#[derive(Debug, serde::Deserialize, Fields)]
struct Search {
    q: String,
    go: Option<String>,
}

#[derive(Debug, serde::Deserialize, Fields)]
struct Moded {
    q: String,
    #[serde(rename = "q-mode")]
    mode: String,
}

/// What a client sends is not trusted: a key sent another way than the form writes it is
/// refused, stray `x.y` keys beside a field sent as `x` are left alone, and many rows' errors
/// cost each row its own lookup.
#[test]
fn rows_read_only_their_own_keys_and_scale_with_their_count() {
    // `a` as `%61`, lowercase hex, a character the form would encode: each refused.
    for key in ["%2561", "a%252cb", "a.b"] {
        let body = format!("lines%5B{key}%5D.qty=1");
        let err = crate::form::from_bytes::<Limits2>(body.as_bytes()).unwrap_err().to_string();
        assert!(err.contains("the row's key is not"), "{key}: {err}");
    }
    let read: Limits2 = crate::form::from_bytes(b"lines%5Ba%252Cb%5D.qty=1").expect("the form's own encoding");
    assert_eq!(read.lines["a,b"].qty, 1);

    // An image button (`go.x`, `go.y`) and a stray `q.x` beside `q`: read as a plain form was.
    let search: Search = crate::form::from_bytes(b"q=cards&q.x=1&go.x=3&go.y=4").expect("reads");
    assert_eq!((search.q.as_str(), search.go), ("cards", None));
    // A key between `q` and `q.x` (`q-mode`) does not make `q.x` a group.
    let moded: Moded = crate::form::from_bytes(b"q=a&q-mode=b&q.x=1").expect("q is sent as itself");
    assert_eq!((moded.q.as_str(), moded.mode.as_str()), ("a", "b"));

    // An integer key is read only as it is written, so one row cannot be sent two ways.
    for key in ["07", "%2B7", "-0"] {
        let body = format!("lines%5B{key}%5D.qty=1");
        let err = crate::form::from_bytes::<Numbered>(body.as_bytes()).unwrap_err().to_string();
        assert!(err.contains("as the form writes it") || err.contains("the way the form writes it"), "{key}: {err}");
    }

    // Integer keys, written without allocating, and each row's errors found by its key.
    let f = Numbered::FIELDS;
    assert_eq!(f.lines.at(&7).qty.to_string(), "lines[7].qty");
    let read: Numbered = crate::form::from_bytes(b"lines%5B7%5D.qty=2&lines%5B12%5D.qty=5").expect("reads");
    assert_eq!((read.lines[&7].qty, read.lines[&12].qty), (2, 5));
    let mut errors = Errors::new();
    for row in 0..20_000u32 {
        errors.add(f.lines.at(&row).qty, "Too many.");
        errors.add(f.lines.at(&row).qty, "dropped: the row has one");
    }
    assert_eq!(errors.len(), 20_000);
    assert_eq!(errors.get(f.lines.at(&19_999).qty), Some("Too many."));
    assert!(!errors.has(f.lines.at(&20_000).qty));
    assert!(errors.iter().next().is_some_and(|(name, _)| name == "lines[0].qty"));

    // A group in a row: its own message id, and its key in the JSON clients get.
    let mut errors = Errors::new();
    let zip = Limits::FIELDS.domains.at(&Domain::SellerPortal).contact.zip;
    errors.add(zip, "Five digits.");
    let e = errors.within(LimitsFormId);
    assert_eq!(
        html! { {e.message(zip)} }.to_html(),
        r#"<p class="field-error" id="limits-form-domains[seller-portal].contact.zip-error">Five digits.</p>"#
    );
    #[cfg(feature = "json")]
    assert_eq!(serde_json::to_string(&errors).unwrap(), r#"{"domains[seller-portal].contact.zip":"Five digits."}"#);
}

#[test]
fn field_names_follow_serde_and_reach_markup() {
    assert_eq!((SignUp::FIELDS.email.as_str(), SignUp::FIELDS.password.as_str()), ("email", "pw"));
    let f = Shipping::FIELDS;
    assert_eq!((f.street_line.as_str(), f.postal_code.as_str(), f.r#type.as_str()), ("streetLine", "postalCode", "type"));
    let mut errors = Errors::new();
    errors.add(SignUp::FIELDS.email, "Enter an email address.");
    let f = SignUp::FIELDS;
    let e = errors.within(SignUpId);
    let html = html! { <input name={f.email} {..e.aria(f.email)}> }.to_html();
    assert_eq!(html, r#"<input name="email" aria-invalid="true" aria-describedby="sign-up-email-error">"#);
    // A hint of its own: one aria-describedby naming the hint, then the error. The hint's id is a
    // temporary, which lives as long as the spread renders.
    let field = String::from("email");
    let e = errors.within(SignUpId);
    let html = html! { <input name={f.email} {..e.aria(f.email).hint(&FieldHintId(&field))}> }.to_html();
    assert_eq!(html, r#"<input name="email" aria-invalid="true" aria-describedby="field-hint-email sign-up-email-error">"#);
}

#[derive(crate::view::Id)]
struct FieldHintId<'a>(&'a str);

#[tokio::test]
async fn error_pages_render_in_the_shell() {
    let (status, _, body) = call_with(app(failing(), Some("ada")), "GET", "/forbidden", None, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains(">home</a>") && body.contains("Not allowed"));
}

#[tokio::test]
async fn the_pwa_links_its_manifest_and_corten_answers_offline() {
    let pwa = crate::pwa::Pwa::new(crate::pwa::Manifest::new("A", "A").theme_color("#123"));
    let router = App::new(Routes::from(routes())).pwa(pwa).router();
    let (_, _, body) = call(router.clone(), "GET", None).await;
    assert!(body.contains(r##"<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#123">"##));
    assert!(body.contains(r#"<meta name="corten-sw" content="/service-worker.js">"#));
    let (status, headers, body) = call_with(router.clone(), "GET", "/offline", None, None).await;
    assert_eq!((status, &headers["x-robots-tag"]), (StatusCode::OK, &"noindex".parse().unwrap()));
    assert!(body.contains("Check your connection"), "{body}");
    let (status, _, _) = call_with(router.clone(), "GET", "/manifest.webmanifest", None, None).await;
    assert_eq!(status, StatusCode::OK);
    // The worker runs under the pages' CSP, Trusted Types included, so its imports go through a
    // policy of its own.
    let (status, headers, _) = call_with(router, "GET", "/service-worker.js", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let csp = headers["content-security-policy"].to_str().unwrap();
    assert!(csp.ends_with("; require-trusted-types-for 'script'; trusted-types corten"), "{csp}");
}

// ---- App::api: routes that answer only JSON ----

#[derive(crate::Route)]
#[route("/api/items/{id}")]
struct ApiItem<'a> {
    id: &'a str,
}

/// A page, and API routes for each way an API request can fail; `settings` adds the API's.
fn api_app(settings: impl FnOnce(crate::Api<ApiRoot>) -> crate::Api<ApiRoot>) -> Router {
    App::new(Routes::from(
        Router::new().route("/", get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) })),
    ))
    .error_page(test_error_page, ())
    .deadline(std::time::Duration::from_millis(50))
    .api::<ApiRoot>(|api| {
        let api = api
            .route::<ApiItem>(crate::Methods::reads(get(|axum::extract::Path(id): axum::extract::Path<u32>| async move {
                format!("item {id}")
            })))
            .route::<ApiMissing>(crate::Methods::reads(get(|| async {
                Err::<Response, _>(Error::new("no item 7").with_status(StatusCode::NOT_FOUND))
            })))
            .route::<ApiDown>(crate::Methods::reads(get(|| async { Err::<Response, _>(Error::new("database password wrong")) })))
            .route::<ApiTeapot>(crate::Methods::reads(get(|| async {
                (StatusCode::IM_A_TEAPOT, [("content-type", "application/json")], r#"{"mine":1}"#)
            })))
            .route::<ApiSlow>(crate::Methods::reads(get(std::future::pending::<&'static str>)))
            .route::<ApiPost>(crate::Methods::writes(axum::routing::post(|| async { "posted" })));
        settings(api)
    })
    .router()
}

/// An area or an API with a deadline of its own: its routes get it, and every other page keeps
/// the app's. In nested areas the innermost that sets one decides; one that sets none takes its
/// parent's.
#[tokio::test]
async fn an_area_or_an_api_sets_its_own_deadline() {
    let slow = || {
        crate::Methods::reads(get(|| async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            "done"
        }))
    };
    let router = App::new(Routes::from(Router::new().route("/slow", slow().0)))
        .error_page(test_error_page, ())
        .deadline(Duration::from_millis(50))
        .area::<Admin>(|admin| admin.route::<AdminSlow>(slow()).deadline(Duration::from_secs(10)))
        .area::<AdminQuick>(|quick| quick.route::<AdminQuickSlow>(slow()).deadline(Duration::from_millis(20)))
        .area::<AdminOther>(|other| other.route::<AdminOtherSlow>(slow()))
        .api::<ApiRoot>(|api| api.route::<ApiSlow>(slow()).deadline(None))
        .router();
    let status = |uri| {
        let router = router.clone();
        async move { call_with(router, "GET", uri, None, Some("text/html")).await.0 }
    };
    assert_eq!(status("/slow").await, StatusCode::SERVICE_UNAVAILABLE, "a page keeps the app's deadline");
    assert_eq!(status("/admin/slow").await, StatusCode::OK, "the area's own");
    assert_eq!(status("/admin/other/slow").await, StatusCode::OK, "a nested area without one takes its parent's");
    assert_eq!(status("/admin/quick/slow").await, StatusCode::SERVICE_UNAVAILABLE, "the innermost decides");
    assert_eq!(status("/api/slow").await, StatusCode::OK, "None removes it for the API");
}

#[cfg(feature = "json")]
paths! {
    Zone = "/zone",
    ZoneApi = "/zone/api",
    ZoneApiPing = "/zone/api/ping",
    ZoneMid = "/zone/api/mid",
    ZoneMidPost = "/zone/api/mid/post",
    ZoneIn = "/zone/api/mid/in",
    ZoneInPing = "/zone/api/mid/in/ping",
    Everything = "/",
    EverythingPing = "/ping",
}

#[cfg(feature = "json")]
#[derive(crate::Route)]
#[route("/{*rest}")]
struct EverythingRest<'a> {
    rest: &'a str,
}

/// A request with one more header, or several.
#[cfg(feature = "json")]
async fn call_with_header(
    router: Router,
    method: &str,
    path: &str,
    header: (&str, &str),
) -> (StatusCode, axum::http::HeaderMap, String) {
    call_with_headers(router, method, path, &[header]).await
}

#[cfg(feature = "json")]
async fn call_with_headers(
    router: Router,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, axum::http::HeaderMap, String) {
    let mut req = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let (parts, body) = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
    (parts.status, parts.headers, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
}

/// Three APIs nested in an area, each taking what it leaves unset from the nearest around it and
/// keeping what it sets; their middleware runs area, outer, middle, inner (#539).
#[cfg(feature = "json")]
#[tokio::test]
async fn nested_apis_take_what_they_leave_unset_from_the_nearest() {
    let steps = || {
        crate::Methods::reads(get(|headers: axum::http::HeaderMap| async move {
            tokio::time::sleep(Duration::from_millis(if headers.contains_key("x-slow") { 200 } else { 0 })).await;
            headers.get("x-steps").map_or(String::new(), |v| v.to_str().unwrap().to_string())
        }))
    };
    let shape = |status: StatusCode, message: &str| ShapedError {
        r#type: "error",
        error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
    };
    let shaped = |code: u16, message: &str| format!(r#"{{"type":"error","error":{{"code":{code},"message":{message:?}}}}}"#);
    let router = App::new(Routes::new())
        .middleware(Step("app", false))
        .api::<ZoneIn>(|inner| inner.route::<ZoneInPing>(steps()).middleware(Step("in", false)))
        .area::<Zone>(|zone| zone.middleware(Step("zone", false)).deadline(Duration::from_millis(50)))
        .api::<ZoneMid>(|mid| {
            mid.route::<ZoneMidPost>(crate::Methods::writes(axum::routing::post(|| async { "posted" })))
                .middleware(Step("mid", false))
                .allow_origin("https://mid.example")
        })
        .api::<ZoneApi>(|api| {
            api.route::<ZoneApiPing>(steps()).middleware(Step("api", false)).errors(shape).allow_origin("https://outer.example")
        })
        .router();
    let send = |method: &'static str, path: &'static str, headers: &'static [(&'static str, &'static str)]| {
        let router = router.clone();
        async move {
            let mut req = Request::builder().method(method).uri(path);
            for (name, value) in headers {
                req = req.header(*name, *value);
            }
            let (parts, body) = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
            (parts.status, parts.headers, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
        }
    };
    assert_eq!(send("GET", "/zone/api/mid/in/ping", &[]).await.2, "app zone api mid in", "area, then outermost API first");
    assert_eq!(send("GET", "/zone/api/ping", &[]).await.2, "app zone api");
    let (status, _, body) = send("GET", "/zone/api/mid/in/ping", &[("x-slow", "1")]).await;
    assert_eq!((status.as_u16(), body), (503, shaped(503, "Service Unavailable")), "the area's deadline, the outer API's shape");
    let (status, _, body) = send("GET", "/zone/api/mid/in/nope", &[]).await;
    assert_eq!((status.as_u16(), body), (404, shaped(404, "Not Found")), "an unknown URL under the inner prefix");
    let preflight = |origin: &'static str| -> &'static [(&'static str, &'static str)] {
        match origin {
            "mid" => &[("origin", "https://mid.example"), ("access-control-request-method", "GET")],
            _ => &[("origin", "https://outer.example"), ("access-control-request-method", "GET")],
        }
    };
    // Origins are each API's own: the inner API names none, so neither the middle's nor the outer's
    // partner may call it, and the middle's list is not the outer's.
    for (path, origin) in [("/zone/api/mid/in/ping", "mid"), ("/zone/api/mid/in/ping", "outer"), ("/zone/api/mid/post", "outer")]
    {
        let (_, headers, _) = send("OPTIONS", path, preflight(origin)).await;
        assert!(!headers.contains_key("access-control-allow-origin"), "{path} from {origin}");
    }
    let (status, headers, _) = send("OPTIONS", "/zone/api/mid/post", preflight("mid")).await;
    assert_eq!(
        (status, headers.get("access-control-allow-origin").map(|v| v.to_str().unwrap())),
        (StatusCode::NO_CONTENT, Some("https://mid.example")),
        "an API's own origin"
    );
    let inner_cross: &[(&str, &str)] = &[("origin", "https://mid.example"), ("sec-fetch-site", "cross-site")];
    assert_eq!(
        send("POST", "/zone/api/mid/in/ping", inner_cross).await.0,
        StatusCode::FORBIDDEN,
        "nor its writes under the inner prefix"
    );
    let cross: &[(&str, &str)] = &[("origin", "https://mid.example"), ("sec-fetch-site", "cross-site")];
    assert_eq!(send("POST", "/zone/api/mid/post", cross).await.2, "posted", "a write from its own origin");
    let evil: &[(&str, &str)] = &[("origin", "https://outer.example"), ("sec-fetch-site", "cross-site")];
    let (status, _, body) = send("POST", "/zone/api/mid/post", evil).await;
    assert_eq!(
        (status.as_u16(), body),
        (403, shaped(403, "Cross-site request refused.")),
        "the outer's origin is not the middle's"
    );

    // A "/" API around another: the inner one's routes meet the outer's middleware first.
    let router = App::new(Routes::new())
        .api::<Everything>(|all| all.route::<EverythingPing>(steps()).middleware(Step("all", false)))
        .api::<ApiRoot>(|api| api.route::<ApiSlow>(steps()).middleware(Step("api", false)))
        .router();
    assert_eq!(call_with(router.clone(), "GET", "/api/slow", None, None).await.2, "all api");
    assert_eq!(call_with(router, "GET", "/ping", None, None).await.2, "all");
    // A "/" API's catch-all does not answer under another API's prefix.
    let router = App::new(Routes::new())
        .api::<Everything>(|all| all.route::<EverythingRest>(steps()))
        .api::<ApiRoot>(|api| api.route::<ApiSlow>(steps()))
        .router();
    assert_eq!(call_with(router.clone(), "GET", "/elsewhere", None, None).await.0, StatusCode::OK);
    assert_eq!(call_with(router, "GET", "/api/elsewhere", None, None).await.0, StatusCode::NOT_FOUND);
}

#[cfg(feature = "json")]
paths! {
    Outer = "/outer",
    OuterIn = "/outer/in",
    OuterInSlow = "/outer/in/slow",
    OuterInNone = "/outer/none",
    OuterInNoneSlow = "/outer/none/slow",
    Walled = "/walled",
    WalledApi = "/walled/api",
    WalledApiIn = "/walled/api/in",
    WalledApiInSlow = "/walled/api/in/slow",
}

#[cfg(feature = "json")]
#[derive(crate::Route)]
#[route("/outer/{id}")]
struct OuterAny<'a> {
    id: &'a str,
}

/// What an inner API sets is its own over the outer's (its error shape, its deadline, `None`
/// included), an outer API's deadline over an area's around both, and an outer parameter route
/// never answers a path under the inner prefix (#539).
#[cfg(feature = "json")]
#[tokio::test]
async fn an_inner_apis_settings_are_its_own() {
    let slow = || {
        crate::Methods::reads(get(|| async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            "done"
        }))
    };
    let outer_shape = |status: StatusCode, message: &str| ShapedError {
        r#type: "outer",
        error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
    };
    let inner_shape = |status: StatusCode, message: &str| ShapedError {
        r#type: "inner",
        error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
    };
    let page = Router::new().route("/{*rest}", get(|| async { "page" }));
    let router = App::new(Routes::from(page))
        .deadline(Duration::from_millis(50))
        .api::<Outer>(|outer| outer.route::<OuterAny>(crate::Methods::reads(get(|| async { "outer" }))).errors(outer_shape))
        .api::<OuterIn>(|inner| inner.route::<OuterInSlow>(slow()).errors(inner_shape).deadline(Duration::from_secs(10)))
        .api::<OuterInNone>(|none| none.route::<OuterInNoneSlow>(slow()).deadline(None))
        .area::<Walled>(|walled| walled.deadline(Duration::from_millis(20)))
        .api::<WalledApi>(|api| api.deadline(Duration::from_secs(10)))
        .api::<WalledApiIn>(|inner| inner.route::<WalledApiInSlow>(slow()))
        .router();
    let call = |path: &'static str| {
        let router = router.clone();
        async move {
            let (status, _, body) = call_with(router, "GET", path, None, None).await;
            (status.as_u16(), body)
        }
    };
    assert_eq!(call("/outer/7").await, (200, "outer".to_string()), "the outer parameter route outside the inner prefixes");
    let inner_404 = (404, r#"{"type":"inner","error":{"code":404,"message":"Not Found"}}"#.to_string());
    assert_eq!(call("/outer/in").await, inner_404, "not the outer /outer/{{id}}: the inner API's 404, in its shape");
    assert_eq!(call("/outer/in/other").await, inner_404);
    assert_eq!(call("/elsewhere").await, (200, "page".to_string()), "the app's catch-all page outside the APIs");
    assert_eq!(call("/outer/in/a/b").await, inner_404, "not the app's catch-all page either");
    assert_eq!(call("/outer/in/slow").await, (200, "done".to_string()), "the inner API's longer deadline");
    assert_eq!(call("/outer/none/slow").await, (200, "done".to_string()), "an inner None removes the outer's");
    let (status, body) = call("/outer/none/x").await;
    assert_eq!(
        (status, &body[..]),
        (404, r#"{"type":"outer","error":{"code":404,"message":"Not Found"}}"#),
        "the shape it left unset"
    );
    assert_eq!(call("/walled/api/in/slow").await, (200, "done".to_string()), "the nearest API's deadline over the area's");
}

#[cfg(feature = "json")]
paths! {
    Apis = "/apis",
    ApisPing = "/apis/ping",
    WalledOwn = "/walled/own",
    WalledOwnSlow = "/walled/own/slow",
}

/// `/apis` is beside `/api`, not in it: it takes nothing from it and its routes are its own; and
/// an API in an area that sets a deadline, in no API, takes the area's (#539).
#[cfg(feature = "json")]
#[tokio::test]
async fn an_api_beside_another_takes_nothing_from_it() {
    let slow = || {
        crate::Methods::reads(get(|| async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            "done"
        }))
    };
    let shape = |status: StatusCode, message: &str| ShapedError {
        r#type: "error",
        error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
    };
    let router = App::new(Routes::new())
        .api::<ApiRoot>(|api| api.route::<ApiRest>(crate::Methods::reads(get(|| async { "api" }))).errors(shape))
        .api::<Apis>(|apis| apis.route::<ApisPing>(crate::Methods::reads(get(|| async { "apis" }))))
        .area::<Walled>(|walled| walled.deadline(Duration::from_millis(20)))
        .api::<WalledOwn>(|own| own.route::<WalledOwnSlow>(slow()))
        .router();
    let call = |path: &'static str| {
        let router = router.clone();
        async move {
            let (status, _, body) = call_with(router, "GET", path, None, None).await;
            (status.as_u16(), body)
        }
    };
    assert_eq!(call("/apis/ping").await, (200, "apis".to_string()));
    let (status, body) = call("/apis/nope").await;
    assert_eq!(status, 404);
    assert!(body.contains(r#""title":"Not Found""#), "its own Problem Details, not /api's shape: {body}");
    assert_eq!(call("/api/x").await, (200, "api".to_string()));
    assert_eq!(call("/walled/own/slow").await.0, 503, "the area's deadline");
}

/// Under a nested API, a WebSocket handshake from another site is held to that API's origins,
/// not the outer one's.
#[cfg(feature = "json")]
#[tokio::test]
async fn an_upgrade_under_a_nested_api_takes_its_origins() {
    use crate::upgrade::Upgrade;
    async fn nothing(_: crate::upgrade::Stream, _: crate::Signal) {}
    let router = App::new(Routes::new())
        .api::<ApiRoot>(|api| api.allow_origin("https://outer.example"))
        .api::<ApiItems>(|items| {
            items
                .route::<ApiItem>(crate::Methods::reads(get(|upgrade: Upgrade| async move { upgrade.websocket(nothing) })))
                .allow_origin("https://inner.example")
        })
        .router();
    let status = |origin: &'static str| {
        let router = router.clone();
        async move {
            let req = Request::get("/api/items/7")
                .header("origin", origin)
                .header("sec-fetch-site", "cross-site")
                .header("connection", "upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-version", "13")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .body(Body::empty())
                .unwrap();
            router.oneshot(req).await.unwrap().status()
        }
    };
    assert_eq!(status("https://inner.example").await, StatusCode::UPGRADE_REQUIRED, "allowed: a oneshot cannot switch");
    assert_eq!(status("https://outer.example").await, StatusCode::FORBIDDEN, "the outer API's origin is not the inner's");
    // An inner API that allows no site: the outer's partner may not switch under it either.
    let router = App::new(Routes::new())
        .api::<ApiRoot>(|api| api.allow_origin("https://outer.example"))
        .api::<ApiItems>(|items| {
            items.route::<ApiItem>(crate::Methods::reads(get(|upgrade: Upgrade| async move { upgrade.websocket(nothing) })))
        })
        .router();
    let req = Request::get("/api/items/7")
        .header("origin", "https://outer.example")
        .header("sec-fetch-site", "cross-site")
        .header("connection", "upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(Body::empty())
        .unwrap();
    assert_eq!(router.oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
}

/// A route an outer API writes under an inner API's prefix would answer with the inner one's
/// settings: the app does not start.
#[test]
#[should_panic(expected = "move it to that API")]
fn an_outer_apis_route_under_an_inner_prefix_does_not_start() {
    let reads = || crate::Methods::reads(get(|| async { "x" }));
    let _ = App::new(Routes::new()).api::<ApiRoot>(|api| api.route::<ApiItem>(reads())).api::<ApiItems>(|items| items).router();
}

/// Three deep, the message names the innermost API that holds the route.
#[cfg(feature = "json")]
#[test]
#[should_panic(expected = r#"is under App::api("/zone/api/mid/in")"#)]
fn the_route_is_named_with_the_innermost_api_that_holds_it() {
    let reads = || crate::Methods::reads(get(|| async { "x" }));
    let _ = App::new(Routes::new())
        .api::<ZoneApi>(|api| api.route::<ZoneInPing>(reads()))
        .api::<ZoneMid>(|mid| mid)
        .api::<ZoneIn>(|inner| inner)
        .router();
}

#[cfg(feature = "json")]
#[derive(crate::Route)]
#[route("/api/{*rest}")]
struct ApiRest<'a> {
    rest: &'a str,
}

/// An API inside another (a feature's `/api/items` in the app's `/api`, which relays the rest)
/// keeps its own routes, takes the settings it leaves unset from the outer one, and meets the
/// outer one's middleware first; a request under its prefix is its own, whichever route answers
/// it (#539).
#[cfg(feature = "json")]
#[tokio::test]
async fn an_api_nests_in_another() {
    let steps = || {
        crate::Methods::reads(get(|headers: axum::http::HeaderMap| async move {
            tokio::time::sleep(Duration::from_millis(if headers.contains_key("x-slow") { 200 } else { 0 })).await;
            headers.get("x-steps").map_or(String::new(), |v| v.to_str().unwrap().to_string())
        }))
    };
    let shape = |status: StatusCode, message: &str| ShapedError {
        r#type: "error",
        error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
    };
    // Given inner first: the order they are given in does not matter.
    let router = App::new(Routes::new())
        .middleware(Step("app", false))
        .api::<ApiItems>(|items| items.route::<ApiItem>(steps()).middleware(Step("items", true)).middleware(Saw))
        .api::<ApiRoot>(|api| {
            api.route::<ApiRest>(steps())
                .route::<ApiSlow>(steps())
                .middleware(Step("api", false))
                .deadline(Duration::from_millis(50))
                .errors(shape)
                .allow_origin("https://partner.example")
        })
        .router();
    let get_with = |path: &'static str, header: Option<(&'static str, &'static str)>| {
        let router = router.clone();
        async move {
            let mut req = Request::get(path);
            if let Some((name, value)) = header {
                req = req.header(name, value);
            }
            let (parts, body) = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
            (parts.status, parts.headers, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
        }
    };
    assert_eq!(get_with("/api/items/7", None).await.2, "app api items", "the outer API's middleware, then the inner's");
    assert_eq!(get_with("/api/slow", None).await.2, "app api", "the outer API's own routes meet its own alone");
    assert_eq!(get_with("/api/other/thing", None).await.2, "app api", "and its catch-all, outside the inner prefix");
    for path in ["/api/items/7/more", "/api/items"] {
        let (status, _, body) = get_with(path, None).await;
        assert_eq!(
            (status.as_u16(), &body[..]),
            (404, r#"{"type":"error","error":{"code":404,"message":"Not Found"}}"#),
            "{path}: a path under the inner prefix is the inner API's, never the outer catch-all's"
        );
        let (status, _, _) = get_with(path, Some(("x-flood", "1"))).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{path}: and meets the inner API's middleware first");
    }
    assert_eq!(get_with("/api/items/7", Some(("x-flood", "1"))).await.0, StatusCode::TOO_MANY_REQUESTS);
    // Every step runs for it, the app's first, and none is told a route matched it.
    let (_, headers, _) = get_with("/api/items/7/more", None).await;
    assert_eq!(
        (&headers["x-saw-steps"], headers.get("x-saw-route")),
        (&"app api items".parse::<axum::http::HeaderValue>().unwrap(), None)
    );
    let (_, headers, _) = get_with("/api/items/7", None).await;
    assert_eq!(headers.get("x-saw-route").map(|v| v.to_str().unwrap()), Some("/api/items/{id}"), "a route of its own is named");
    // A method the outer catch-all lacks (a 405 of the outer route's, before) is a 404 too, and
    // whatever answers it says no method is allowed: the inner middleware's 429 as well.
    let (status, headers, _) = call_with_header(router.clone(), "POST", "/api/items/7/more", ("x-flood", "1")).await;
    assert_eq!((status, headers.get("allow").map(|v| v.to_str().unwrap())), (StatusCode::TOO_MANY_REQUESTS, Some("")));
    // A preflight there is the inner API's, which allows no other site: the outer's partner is
    // not let in under the inner prefix, nor on the inner API's routes.
    for path in ["/api/items/7/more", "/api/items/7"] {
        let (_, headers, _) = call_with_headers(
            router.clone(),
            "OPTIONS",
            path,
            &[("origin", "https://partner.example"), ("access-control-request-method", "GET")],
        )
        .await;
        assert!(!headers.contains_key("access-control-allow-origin"), "{path}");
    }
    let (_, headers, _) = call_with_headers(
        router.clone(),
        "OPTIONS",
        "/api/other",
        &[("origin", "https://partner.example"), ("access-control-request-method", "GET")],
    )
    .await;
    assert_eq!(
        headers.get("access-control-allow-origin").map(|v| v.to_str().unwrap()),
        Some("https://partner.example"),
        "the outer API's own"
    );
    // And a HEAD: the inner API's 404, with no method allowed.
    for method in ["POST", "HEAD"] {
        let (status, headers, _) = call_with(router.clone(), method, "/api/items/7/more", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method}");
        assert_eq!(headers.get("allow").map(|v| v.to_str().unwrap()), Some(""), "{method}: not the outer route's methods");
    }
    let (status, headers, body) = get_with("/api/items/7", Some(("x-slow", "1"))).await;
    assert_eq!(
        (status, &body[..]),
        (StatusCode::SERVICE_UNAVAILABLE, r#"{"type":"error","error":{"code":503,"message":"Service Unavailable"}}"#),
        "the outer API's deadline and error shape"
    );
    assert_eq!(headers["content-type"], "application/json");
    let (status, headers, _) = get_with("/api/items/7", Some(("origin", "https://partner.example"))).await;
    assert_eq!((status, headers.get("access-control-allow-origin")), (StatusCode::OK, None), "no partner of the outer's");
}

/// A layout's read started ahead by an extractor (`crate::Ahead`): under a path ending `/panics`
/// it panics, and `AHEAD_FINISHED` counts the reads that ran to their end.
struct StartedAhead(crate::Ahead<u32>);

static AHEAD_FINISHED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

impl<S: Sync> axum::extract::FromRequestParts<S> for StartedAhead {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut axum::http::request::Parts, _: &S) -> Result<Self, Self::Rejection> {
        let panics = parts.uri.path().ends_with("/panics");
        Ok(StartedAhead(crate::Ahead::start(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if panics {
                panic!("the cart store");
            }
            AHEAD_FINISHED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            3
        })))
    }
}

/// A read started ahead fails the request where it is awaited, as the handler's own panic does,
/// and is stopped with the handler when the deadline passes.
#[tokio::test]
async fn a_read_started_ahead_is_the_requests() {
    let awaited = || {
        crate::Methods::reads(get(|ahead: StartedAhead| async move {
            ahead.0.await;
            "drawn"
        }))
    };
    let app = |deadline: Duration| {
        App::new(Routes::from(Router::new().route("/ahead/panics", awaited().0).route("/ahead/slow", awaited().0)))
            .error_page(test_error_page, ())
            .deadline(deadline)
            .router()
    };
    let (status, _, body) = call_with(app(Duration::from_secs(5)), "GET", "/ahead/panics", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    let before = AHEAD_FINISHED.load(std::sync::atomic::Ordering::SeqCst);
    let (status, _, _) = call_with(app(Duration::from_millis(50)), "GET", "/ahead/slow", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(AHEAD_FINISHED.load(std::sync::atomic::Ordering::SeqCst), before, "the deadline stopped the read");
}

/// Which routes outside an API can match a path under it, so only those APIs check per request.
#[test]
fn a_route_reaches_an_api_through_a_parameter_before_it() {
    use crate::api::reaches;
    for route in ["/{*rest}", "/{id}", "/api/{id}", "/api/{*rest}"] {
        assert!(reaches(route, "/api/items"), "{route}");
    }
    for route in ["/page", "/api/ping", "/v2/items/{id}", "/apis/{id}", "/api/items/{id}", "/api/items"] {
        assert!(!reaches(route, "/api/items"), "{route}");
    }
    assert!(!reaches("/{*rest}", "/"), "nothing is outside the root");
}

/// A top-level API owns its prefix too: a page's catch-all does not answer a path under it (#539).
#[cfg(feature = "json")]
#[tokio::test]
async fn a_page_catch_all_does_not_answer_under_an_api() {
    let everything = Routes::new().__route::<EverythingRest>(crate::Methods::reads(get(|| async { "page" })));
    let router = App::new(everything)
        .api::<ApiItems>(|items| items.route::<ApiItem>(crate::Methods::reads(get(|| async { "item" }))))
        .router();
    assert_eq!(call_with(router.clone(), "GET", "/elsewhere", None, None).await.2, "page");
    let (status, headers, body) = call_with(router.clone(), "GET", "/api/items/7/more", None, None).await;
    assert_eq!(
        (status, &headers["content-type"]),
        (StatusCode::NOT_FOUND, &"application/problem+json".parse::<axum::http::HeaderValue>().unwrap()),
        "{body}"
    );
    assert_eq!(call_with(router, "GET", "/api/items/7", None, None).await.2, "item");
}

/// Served under another router's `Router::nest`, an API's routes are still its own, and a path
/// outside them still gets its 404.
#[cfg(feature = "json")]
#[tokio::test]
async fn an_api_answers_under_router_nest() {
    let everything = Routes::new().__route::<EverythingRest>(crate::Methods::reads(get(|| async { "page" })));
    let app = App::new(everything)
        .api::<ApiRoot>(|api| api.route::<ApiRest>(crate::Methods::reads(get(|| async { "rest" }))))
        .api::<ApiItems>(|items| items.route::<ApiItem>(crate::Methods::reads(get(|| async { "item" }))))
        .router();
    let router = Router::new().nest("/outer", app);
    assert_eq!(call_with(router.clone(), "GET", "/outer/api/items/7", None, None).await.2, "item");
    assert_eq!(call_with(router.clone(), "GET", "/outer/api/other", None, None).await.2, "rest");
    assert_eq!(call_with(router, "GET", "/outer/api/items/7/more", None, None).await.0, StatusCode::NOT_FOUND);
    // Nested at a path that is also an API's prefix: the nest's part is taken off before the
    // matched route is compared, so a catch-all outside the API still does not answer under it.
    let app = App::new(Routes::new())
        .api::<Everything>(|root| root.route::<EverythingRest>(crate::Methods::reads(get(|| async { "root" }))))
        .api::<ApiRoot>(|api| api)
        .router();
    let router = Router::new().nest("/api", app);
    assert_eq!(call_with(router.clone(), "GET", "/api/elsewhere", None, None).await.2, "root");
    assert_eq!(call_with(router, "GET", "/api/api/other", None, None).await.0, StatusCode::NOT_FOUND);
}

/// Copies the steps the request met and the route axum matched (`MatchedPath`) onto the answer.
struct Saw;

impl crate::Middleware for Saw {
    async fn call(&self, req: Request<Body>, next: impl crate::Next) -> axum::response::Response {
        let steps = req.headers().get("x-steps").cloned();
        let route =
            req.extensions().get::<axum::extract::MatchedPath>().map(|m| m.as_str().parse::<axum::http::HeaderValue>().unwrap());
        let mut res = next.run(req).await;
        if let Some(steps) = steps {
            res.headers_mut().insert("x-saw-steps", steps);
        }
        if let Some(route) = route {
            res.headers_mut().insert("x-saw-route", route);
        }
        res
    }
}

/// Writes its name into `x-steps` on the way in, so a test reads the order middleware ran in;
/// with `refuse`, a request with `x-flood` is turned away with a 429.
struct Step(&'static str, bool);

impl crate::Middleware for Step {
    async fn call(&self, mut req: Request<Body>, next: impl crate::Next) -> axum::response::Response {
        use axum::response::IntoResponse;
        let steps = req.headers().get("x-steps").map(|v| format!("{} {}", v.to_str().unwrap(), self.0));
        let steps = steps.unwrap_or_else(|| self.0.to_string());
        req.headers_mut().insert("x-steps", steps.parse().unwrap());
        if self.1 && req.headers().contains_key("x-flood") {
            return crate::Refused::too_many(Duration::from_millis(7_500)).into_response();
        }
        next.run(req).await
    }
}

/// An area's or an API's middleware runs for its own routes only (and a nested area's), after
/// the app's, outermost first and each in the order given; a refusal from one is answered in the
/// request's mode, as a caller's is.
#[tokio::test]
async fn an_area_or_an_api_has_middleware_of_its_own() {
    let steps = || {
        crate::Methods::reads(get(|headers: axum::http::HeaderMap| async move {
            headers.get("x-steps").map_or(String::new(), |v| v.to_str().unwrap().to_string())
        }))
    };
    let router = App::new(Routes::from(Router::new().route("/slow", steps().0)))
        .error_page(test_error_page, ())
        .middleware(Step("app", false))
        .area::<AdminQuick>(|quick| quick.route::<AdminQuickSlow>(steps()).middleware(Step("quick", false)))
        .area::<Admin>(|admin| {
            admin
                .middleware((Step("admin", false), Step("limit", true)))
                .route::<AdminSlow>(steps())
                .middleware(Step("last", false))
        })
        .area::<AdminOther>(|other| other.route::<AdminOtherSlow>(steps()))
        .api::<ApiRoot>(|api| api.route::<ApiSlow>(steps()).middleware(Step("api", true)))
        .api::<AdminHooks>(|hooks| hooks.route::<AdminHooksPing>(steps()).middleware(Step("hooks", false)))
        .router();
    let body = |uri| {
        let router = router.clone();
        async move { call_with(router, "GET", uri, None, Some("text/html")).await.2 }
    };
    assert_eq!(body("/slow").await, "app", "a route outside every area meets the app's only");
    assert_eq!(
        body("/admin/slow").await,
        "app admin limit last",
        "the area's, in the order given, given before or after its routes"
    );
    assert_eq!(body("/admin/quick/slow").await, "app admin limit last quick", "an outer area's, then the inner one's");
    assert_eq!(body("/admin/other/slow").await, "app admin limit last", "a nested area without any has its parent's");
    assert_eq!(body("/api/slow").await, "app api");
    assert_eq!(body("/admin/hooks/ping").await, "app admin limit last hooks", "an API under the area meets the area's first");
    assert!(body("/admin/nope").await.contains("Not found"), "an unknown URL under the area is the app's 404");

    let flood = |uri: &'static str, accept: &'static str| {
        let router = router.clone();
        async move {
            let req = Request::get(uri).header("accept", accept).header("x-flood", "1").body(Body::empty()).unwrap();
            let (parts, body) = router.oneshot(req).await.unwrap().into_parts();
            (parts.status, parts.headers, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
        }
    };
    let (status, headers, body) = flood("/admin/slow", "text/html").await;
    assert_eq!(
        (status, &headers["retry-after"]),
        (StatusCode::TOO_MANY_REQUESTS, &"8".parse::<axum::http::HeaderValue>().unwrap())
    );
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"), "a browser gets the error page: {headers:?}");
    let (status, headers, body2) = flood("/api/slow", "text/html").await;
    assert_eq!(
        (status, &headers["retry-after"]),
        (StatusCode::TOO_MANY_REQUESTS, &"8".parse::<axum::http::HeaderValue>().unwrap())
    );
    assert_eq!(body2, r#"{"title":"Too Many Requests","status":429}"#, "JSON under an API");
    let (status, _, _) = flood("/admin/nope", "text/html").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "an unknown URL under the area meets its middleware");
    let (status, _, body3) = flood("/admin/hooks/ping", "text/html").await;
    assert_eq!(
        (status, &body3[..]),
        (StatusCode::TOO_MANY_REQUESTS, r#"{"title":"Too Many Requests","status":429}"#),
        "and an API under it, in JSON"
    );
    let (status, _, _) = flood("/slow", "text/html").await;
    assert_eq!(status, StatusCode::OK, "the app's other routes never meet the limit");
    assert!(!body.is_empty());
}

/// A middleware reads the client's address as a handler would, and the answer is then private.
#[tokio::test]
async fn a_middleware_reads_the_client_address() {
    struct Seen;
    impl crate::Middleware for Seen {
        async fn call(&self, mut req: Request<Body>, next: impl crate::Next) -> axum::response::Response {
            let ip = crate::ClientIp::of(&mut req).map_or("none".to_string(), |crate::ClientIp(ip)| ip.to_string());
            req.headers_mut().insert("x-ip", ip.parse().unwrap());
            next.run(req).await
        }
    }
    let routes = Router::new().route(
        "/",
        get(|headers: axum::http::HeaderMap, ip: Option<crate::ClientIp>| async move {
            format!(
                "{} {}",
                headers["x-ip"].to_str().unwrap(),
                ip.map_or("none".to_string(), |crate::ClientIp(ip)| ip.to_string())
            )
        }),
    );
    let router = App::new(Routes::from(routes))
        .middleware(Seen)
        .router()
        .layer(axum::extract::connect_info::MockConnectInfo(std::net::SocketAddr::from(([203, 0, 113, 8], 1))));
    let (status, headers, body) = call_with(router, "GET", "/", None, Some("text/html")).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "203.0.113.8 203.0.113.8"), "the same address both ways");
    assert_eq!(headers["cache-control"], "private, no-cache", "an answer for one address is private");
}

/// What most HTTP clients send: `*/*`, or no `Accept` at all, or a browser's own.
const ACCEPTS: [Option<&str>; 4] = [Some("*/*"), None, Some("text/html,application/xhtml+xml"), Some("application/json")];

#[tokio::test]
async fn api_routes_answer_every_failure_as_json_whatever_the_client_accepts() {
    let router = api_app(|api| api);
    for accept in ACCEPTS {
        let get = |uri: &'static str| call_with(router.clone(), "GET", uri, None, accept);
        let (status, headers, body) = get("/api/nope").await;
        assert_eq!((status, &body[..]), (StatusCode::NOT_FOUND, r#"{"title":"Not Found","status":404}"#), "{accept:?}");
        assert_eq!(headers["content-type"], "application/problem+json");
        assert!(!headers.contains_key("corten-page") && !headers.contains_key("corten-shell"), "no shell: {headers:?}");
        let (_, _, body) = get("/api/missing").await;
        assert_eq!(body, r#"{"title":"Not Found","status":404,"detail":"no item 7"}"#, "a 4xx error's message is for the client");
        let (status, _, body) = get("/api/down").await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, r#"{"title":"Internal Server Error","status":500}"#, "a 5xx message stays in the log");
        let (status, _, body) = get("/api/items/abc").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body.starts_with(r#"{"title":"Bad Request","status":400,"detail":"Invalid URL"#),
            "an extractor's rejection: {body}"
        );
        let (status, headers, body) = call_with(router.clone(), "DELETE", "/api/post", None, accept).await;
        assert_eq!((status, &headers["allow"]), (StatusCode::METHOD_NOT_ALLOWED, &"POST".parse().unwrap()));
        assert_eq!(body, r#"{"title":"Method Not Allowed","status":405}"#);
        let (status, _, body) = get("/api/slow").await;
        assert_eq!((status, &body[..]), (StatusCode::SERVICE_UNAVAILABLE, r#"{"title":"Service Unavailable","status":503}"#));
        let (status, _, body) = get("/api/teapot").await;
        assert_eq!((status, &body[..]), (StatusCode::IM_A_TEAPOT, r#"{"mine":1}"#), "the handler's own JSON passes through");
        let (status, _, body) = get("/api/items/7").await;
        assert_eq!((status, &body[..]), (StatusCode::OK, "item 7"), "a success is the handler's");
    }
    let (_, headers, body) = call_with(router, "GET", "/nope", None, Some("*/*")).await;
    assert!(
        headers["content-type"].to_str().unwrap().starts_with("text/html") && body.contains("Not found"),
        "pages keep the page"
    );
}

#[tokio::test]
async fn api_routes_have_their_own_csp_and_pages_get_a_nonce_only_when_they_use_one() {
    let router = api_app(|api| api);
    let (_, headers, _) = call_with(router.clone(), "GET", "/api/items/1", None, None).await;
    assert_eq!(headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    let (_, headers, _) = call_with(router.clone(), "GET", "/", None, None).await;
    assert!(!headers["content-security-policy"].to_str().unwrap().contains("nonce"), "a document needs none");
    let (_, headers, _) = call_with(router.clone(), "GET", "/", Some("nav"), None).await;
    let csp = headers["content-security-policy"].to_str().unwrap();
    assert!(csp.starts_with("default-src 'self'; script-src 'self' 'sha256-") && !csp.contains("nonce"), "{csp}");
    let (_, headers, _) = call_with(router, "GET", runtime_path(), None, None).await;
    assert!(!headers["content-security-policy"].to_str().unwrap().contains("nonce"), "nor does a static file");
}

#[tokio::test]
async fn a_handler_that_takes_the_nonce_gets_the_one_in_the_csp() {
    let routes = Router::new().route(
        "/raw",
        get(|nonce: security::Nonce| async move { axum::response::Html(format!(r#"<script nonce="{}">1</script>"#, nonce.0)) }),
    );
    let (_, headers, body) = call_with(App::new(Routes::from(routes)).router(), "GET", "/raw", None, None).await;
    let nonce = body.split(r#"nonce=""#).nth(1).unwrap().split('"').next().unwrap();
    assert!(headers["content-security-policy"].to_str().unwrap().contains(&format!("'nonce-{nonce}'")));
}

#[tokio::test]
async fn a_caller_is_looked_up_only_by_the_handlers_that_read_it_and_once() {
    let routes = Router::new().route("/", get(|| async { "page" })).route(
        "/twice",
        get(|_: Caller<Viewer>, again: Option<Caller<Viewer>>| async move { again.map_or("", |Caller(v)| v.0) }),
    );
    let router = app(routes, Some("ada"));
    LOOKUPS.with(|n| n.set(0));
    for uri in ["/", runtime_path(), "/health/live"] {
        call_with(router.clone(), "GET", uri, None, None).await;
    }
    assert_eq!(LOOKUPS.with(|n| n.get()), 0, "a route that does not read who is asking never looks");
    let (_, _, body) = call_with(router, "GET", "/twice", None, None).await;
    assert_eq!((body.as_str(), LOOKUPS.with(|n| n.get())), ("ada", 1), "two readers, one lookup");
}

/// A caller whose lookup waits (a session store's round trip).
#[derive(Clone, Hash)]
struct Slow(&'static str);

impl<S: Sync> crate::Identify<S> for Slow {
    async fn identify(_: &axum::http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
        LOOKUPS.with(|n| n.set(n.get() + 1));
        tokio::task::yield_now().await;
        Ok(Slow("ada"))
    }
}

/// Reads `Slow` twice at once, as a type over two others that share it would.
struct TwoAtOnce;

impl<S: Sync + Send> axum::extract::FromRequestParts<S> for TwoAtOnce {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut axum::http::request::Parts, state: &S) -> std::result::Result<Self, Response> {
        let (a, b) = tokio::join!(Caller::<Slow>::find(parts, state), Caller::<Slow>::find(parts, state));
        a.and(b).map(|_| TwoAtOnce).map_err(IntoResponse::into_response)
    }
}

/// Readers of one caller type at the same time wait for the one lookup, and the page's key has
/// the caller in it as when it is read once (two marks would take it out again).
#[tokio::test]
async fn readers_of_a_caller_at_the_same_time_share_one_lookup_and_one_key() {
    let routes = Router::new()
        .route("/once", get(|req: Req, _: Caller<Slow>| async move { req.test_page("Who", "ada") }))
        .route("/joined", get(|req: Req, _: TwoAtOnce| async move { req.test_page("Who", "ada") }))
        .route("/nobody", get(|req: Req| async move { req.test_page("Who", "ada") }));
    let router = app(routes, None);
    let mut keys = Vec::new();
    for uri in ["/once", "/joined", "/nobody"] {
        LOOKUPS.with(|n| n.set(0));
        let (status, headers, _) = call_with(router.clone(), "GET", uri, None, None).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        keys.push((headers["corten-shell"].to_str().unwrap().to_string(), LOOKUPS.with(|n| n.get())));
    }
    assert_eq!(keys[1], keys[0], "joined: one lookup, the same key as one reader");
    assert_eq!(keys[0].1, 1);
    assert_ne!(keys[0].0, keys[2].0, "the key has the caller in it");
}

/// A layer outside the app's (`App::layer`) that reads the caller before the request has its
/// signal shares the lookup with the handler.
#[tokio::test]
async fn a_layer_outside_the_app_shares_the_lookup_with_the_handler() {
    let routes = Router::new().route("/", get(|Caller(v): Caller<Viewer>| async move { v.0 }));
    let router = App::new(Routes::from(routes))
        .middleware(AsViewer(Some("ada")))
        .layer(axum::middleware::from_fn(|req: axum::extract::Request, next: axum::middleware::Next| async move {
            let (mut parts, body) = req.into_parts();
            parts.headers.insert("viewer", axum::http::HeaderValue::from_static("ada"));
            let _ = <Caller<Viewer> as axum::extract::FromRequestParts<()>>::from_request_parts(&mut parts, &()).await;
            next.run(axum::extract::Request::from_parts(parts, body)).await
        }))
        .router();
    LOOKUPS.with(|n| n.set(0));
    let (_, _, body) = call_with(router, "GET", "/", None, None).await;
    assert_eq!((body.as_str(), LOOKUPS.with(|n| n.get())), ("ada", 1));
}

/// The app's own middleware that reads the caller before the handler (a request log naming who
/// asked) shares the lookup with the handler and with the error page of a refusal after it.
#[tokio::test]
async fn a_middleware_that_reads_the_caller_shares_the_lookup() {
    struct Logs;
    impl crate::Middleware for Logs {
        async fn call(&self, req: axum::extract::Request, next: impl crate::Next) -> Response {
            let (mut parts, body) = req.into_parts();
            parts.headers.insert("viewer", axum::http::HeaderValue::from_static("ada"));
            let who = Caller::<Viewer>::find(&parts, &()).await.map(|Caller(v)| v.0).unwrap_or("no one");
            let mut res = next.run(axum::extract::Request::from_parts(parts, body)).await;
            res.headers_mut().insert("x-who", axum::http::HeaderValue::from_static(who));
            res
        }
    }
    let routes = Router::new()
        .route("/", get(|Caller(v): Caller<Viewer>| async move { v.0 }))
        .route("/refused", get(|Caller(_): Caller<Viewer>| async move { Err::<&str, _>(Error::status(StatusCode::FORBIDDEN)) }));
    let router = App::new(Routes::from(routes)).error_page(test_error_page, ()).middleware(Logs).router();
    for (uri, status) in [("/", StatusCode::OK), ("/refused", StatusCode::FORBIDDEN)] {
        LOOKUPS.with(|n| n.set(0));
        let (got, headers, _) = call_with(router.clone(), "GET", uri, None, None).await;
        assert_eq!((got, headers["x-who"].to_str().unwrap(), LOOKUPS.with(|n| n.get())), (status, "ada", 1), "{uri}");
    }
}

/// A caller type that is a rule over another (`Staff` reads `Viewer` with `Caller::find`)
/// shares its lookup, in whichever order the handler takes them.
#[tokio::test]
async fn a_caller_type_over_another_shares_its_lookup() {
    let routes =
        Router::new()
            .route(
                "/staff-first",
                get(|Caller(Staff(_)): Caller<Staff>, viewer: Option<Caller<Viewer>>| async move {
                    viewer.map_or("", |Caller(v)| v.0)
                }),
            )
            .route(
                "/viewer-first",
                get(|viewer: Option<Caller<Viewer>>, Caller(Staff(_)): Caller<Staff>| async move {
                    viewer.map_or("", |Caller(v)| v.0)
                }),
            );
    let router = app(routes, Some("ada"));
    for uri in ["/staff-first", "/viewer-first"] {
        LOOKUPS.with(|n| n.set(0));
        let (_, _, body) = call_with(router.clone(), "GET", uri, None, None).await;
        assert_eq!((body.as_str(), LOOKUPS.with(|n| n.get())), ("ada", 1), "{uri}: one lookup for both types");
    }
}

#[cfg(feature = "json")]
#[derive(crate::ToJson)]
struct ShapedError {
    r#type: &'static str,
    error: ShapedDetail,
}

#[cfg(feature = "json")]
#[derive(crate::ToJson)]
struct ShapedDetail {
    code: u16,
    message: String,
}

/// `Api::errors` writes every failure Corten answers under the prefix in the API's own shape.
#[cfg(feature = "json")]
#[tokio::test]
async fn an_api_writes_the_failures_corten_answers_in_its_own_shape() {
    let router = api_app(|api| {
        api.errors(|status, message| ShapedError {
            r#type: "error",
            error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
        })
    });
    let shaped = |code: u16, message: &str| format!(r#"{{"type":"error","error":{{"code":{code},"message":{message:?}}}}}"#);
    for (method, path, status, message) in [
        ("GET", "/api/nope", 404, "Not Found"),
        ("GET", "/api/post", 405, "Method Not Allowed"),
        ("GET", "/api/missing", 404, "no item 7"),
        ("GET", "/api/down", 500, "Internal Server Error"),
        ("GET", "/api/items/x", 400, "Invalid URL: Cannot parse `x` to a `u32`"),
        ("GET", "/api/slow", 503, "Service Unavailable"),
    ] {
        let (got, headers, body) = call_with(router.clone(), method, path, None, None).await;
        assert_eq!((got.as_u16(), &body[..]), (status, &shaped(status, message)[..]), "{method} {path}");
        assert_eq!(headers["content-type"], "application/json");
    }
    let (_, headers, _) = call_with(router.clone(), "GET", "/api/post", None, None).await;
    assert_eq!(headers["allow"], "POST", "what the failure says besides its body stays");
    let cross = Request::post("/api/post").header("origin", "https://evil.example").header("sec-fetch-site", "cross-site");
    let res = router.clone().oneshot(cross.body(Body::empty()).unwrap()).await.unwrap();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body, shaped(403, "Cross-site request refused."));
    let (_, _, body) = call_with(router, "GET", "/api/teapot", None, None).await;
    assert_eq!(body, r#"{"mine":1}"#, "a handler's own JSON failure passes through");
}

/// A key check that says why it refused, and locks out a client with too many failed attempts.
#[derive(Clone, Hash, Debug)]
struct Keyed;

impl<S: Sync> crate::Identify<S> for Keyed {
    async fn identify(parts: &axum::http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
        match parts.headers.get("x-api-key").map(|v| v.as_bytes()) {
            Some(b"k1") => Ok(Keyed),
            Some(b"locked") => Err(crate::Refused::too_many(std::time::Duration::from_millis(1500))
                .message("Too many failed attempts; try again later")),
            _ => Err(crate::Refused::unauthorized().message("Invalid API key")),
        }
    }
}

#[derive(crate::Route)]
#[route("/api/keyed")]
struct ApiKeyed;

/// A refusal says why, in the API's own shape, and a lockout is a 429 that says when to try again.
#[cfg(feature = "json")]
#[tokio::test]
async fn a_refusal_tells_the_client_why_and_when_to_try_again() {
    let router = api_app(|api| {
        api.route::<ApiKeyed>(crate::Methods::reads(get(|_: Caller<Keyed>| async { "ok" }))).errors(|status, message| {
            ShapedError { r#type: "error", error: ShapedDetail { code: status.as_u16(), message: message.to_string() } }
        })
    });
    let keyed = |key: Option<&'static str>| {
        let mut req = Request::get("/api/keyed");
        if let Some(key) = key {
            req = req.header("x-api-key", key);
        }
        let router = router.clone();
        async move {
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let (status, retry) = (res.status().as_u16(), res.headers().get("retry-after").cloned());
            (status, retry, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
        }
    };
    assert_eq!(keyed(Some("k1")).await, (200, None, "ok".to_string()));
    assert_eq!(
        keyed(None).await,
        (401, None, r#"{"type":"error","error":{"code":401,"message":"Invalid API key"}}"#.to_string())
    );
    let (status, retry, body) = keyed(Some("locked")).await;
    assert_eq!((status, retry.as_ref().map(|v| v.to_str().unwrap())), (429, Some("2")), "whole seconds, rounded up");
    assert_eq!(body, r#"{"type":"error","error":{"code":429,"message":"Too many failed attempts; try again later"}}"#);
}

#[tokio::test]
async fn an_allowed_origin_may_call_the_api_from_the_browser_but_not_post_the_pages() {
    let router = api_app(|api| api.allow_origin("https://partner.example/"));
    let cross = |uri: &str, origin: &str| {
        Request::post(uri).header("origin", origin).header("sec-fetch-site", "cross-site").body(Body::empty()).unwrap()
    };
    let res = router.clone().oneshot(cross("/api/post", "https://partner.example")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["access-control-allow-origin"], "https://partner.example");
    assert!(res.headers().get_all("vary").iter().any(|v| v == "origin"));
    assert!(!res.headers().contains_key("access-control-allow-credentials"), "no cookies cross over");

    let res = router.clone().oneshot(cross("/api/post", "https://evil.example")).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(!res.headers().contains_key("access-control-allow-origin"));
    let body = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body, r#"{"title":"Forbidden","status":403,"detail":"Cross-site request refused."}"#);
    let res = router.clone().oneshot(cross("/", "https://partner.example")).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN, "the pages still refuse the partner's writes");
    let mut with_cookie = cross("/api/post", "https://partner.example");
    with_cookie.headers_mut().insert("cookie", "session=abc".parse().unwrap());
    let res = router.clone().oneshot(with_cookie).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN, "a partner's write never rides on the user's cookies");

    let preflight = |origin: &str| {
        Request::builder()
            .method("OPTIONS")
            .uri("/api/post")
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", "authorization, content-type")
            .body(Body::empty())
            .unwrap()
    };
    let res = router.clone().oneshot(preflight("https://partner.example")).await.unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert_eq!(res.headers()["access-control-allow-origin"], "https://partner.example");
    assert_eq!(res.headers()["access-control-allow-methods"], "POST");
    assert_eq!(res.headers()["access-control-allow-headers"], "authorization, content-type");
    let res = router.oneshot(preflight("https://evil.example")).await.unwrap();
    assert!(!res.headers().contains_key("access-control-allow-origin"), "another origin's preflight fails");
    assert_eq!(res.headers()["content-type"], "application/problem+json");
}

#[tokio::test]
async fn an_api_at_the_root_makes_the_whole_app_json() {
    let router =
        App::new(Routes::new()).api::<Root>(|api| api.route::<Items>(crate::Methods::reads(get(|| async { "items" })))).router();
    let (status, headers, body) = call_with(router.clone(), "GET", "/nope", None, Some("text/html")).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::NOT_FOUND, "application/problem+json"));
    assert_eq!(body, r#"{"title":"Not Found","status":404}"#);
    let (status, _, body) = call_with(router, "GET", "/health/ready", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "ok"), "Corten's own routes keep their behavior");
}

/// Query parameters a route carries as a set (`#[route(query)]`).
#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize, crate::Route)]
#[route(query)]
pub struct ParamsPaging {
    pub page: Option<u32>,
}

/// A set with each kind of parameter a route has: renamed, a list with no `#[serde(default)]`,
/// a prefix and a set of its own. It derives no `Deserialize`: `Params` reads it by its keys.
#[derive(Clone, Debug, Default, PartialEq, crate::Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct SetProbe {
    pub sort_by: Option<String>,
    pub tags: Vec<String>,
    #[route(prefix = "dimension.")]
    pub dims: Vec<(String, String)>,
    #[route(query)]
    pub paging: ParamsPaging,
}

#[derive(crate::Route)]
#[route("/probe")]
pub struct SetRoute {
    pub q: Option<String>,
    #[route(query)]
    pub set: SetProbe,
}

/// A set's fields with defaults of their own: a parameter the query leaves out is the field's.
#[derive(Debug, PartialEq, crate::Route)]
#[route(query)]
pub struct DefaultedSet {
    #[serde(default = "first_page")]
    pub page: u32,
    #[serde(default)]
    pub size: u32,
    #[route(prefix = "f.")]
    pub facets: std::collections::BTreeMap<String, String>,
}

fn first_page() -> u32 {
    1
}

/// A set with a type parameter.
#[derive(Debug, PartialEq, crate::Route)]
#[route(query)]
pub struct PickSet<T: std::fmt::Display> {
    pub pick: Option<T>,
}

#[derive(crate::Route)]
#[route("/defaulted")]
pub struct DefaultedRoute {
    #[route(query)]
    pub set: DefaultedSet,
    #[route(query)]
    pub pick: PickSet<u32>,
}

/// A set only links use: its field needs only `Display`.
#[derive(crate::Route)]
#[route(query)]
pub struct ShownSet {
    pub tab: Option<Shown>,
}

#[derive(crate::Route)]
#[route("/shown-set")]
struct ShownSetLink {
    #[route(query)]
    set: ShownSet,
}

/// A set over any other set, whose names it carries without naming a hidden trait.
#[derive(crate::Route)]
#[route(query)]
pub struct AroundSet<S: crate::route::QueryParams> {
    pub page: Option<u32>,
    #[route(query)]
    pub set: S,
}

#[derive(crate::Route)]
#[route("/around")]
struct AroundLink {
    #[route(query)]
    around: AroundSet<ShownSet>,
}

#[derive(crate::Route)]
#[route("/around-read")]
struct AroundRead {
    #[route(query)]
    around: AroundSet<PickSet<u32>>,
}

#[test]
fn a_query_set_reads_back_what_its_links_write() {
    use crate::route::FromUrl;
    let set = SetProbe {
        sort_by: Some("price".into()),
        tags: vec!["a".into(), "b&c".into()],
        dims: vec![("form".into(), "graded".into()), ("grade".into(), "PSA 8".into())],
        paging: ParamsPaging { page: Some(3) },
    };
    let href = SetRoute { q: Some("x".into()), set: set.clone() }.href();
    assert_eq!(href, "/probe?q=x&sortBy=price&tags=a&tags=b%26c&dimension.form=graded&dimension.grade=PSA%208&page=3");
    let read = <SetRoute as FromUrl>::__read((), href.split_once('?').unwrap().1).unwrap();
    assert_eq!((read.q.as_deref(), &read.set), (Some("x"), &set), "the prefix field is read back, not left empty");
    let read = <SetRoute as FromUrl>::__read((), "").unwrap();
    assert_eq!(read.set, SetProbe::default(), "a missing list is empty, as on a route");
    for query in ["page=x", "sortBy=a&sortBy=b"] {
        assert!(<SetRoute as FromUrl>::__read((), query).is_err(), "{query}");
    }
    let read = <DefaultedRoute as FromUrl>::__read((), "size=5&f.kind=graded&pick=7").unwrap();
    let facets = std::collections::BTreeMap::from([("kind".to_string(), "graded".to_string())]);
    assert_eq!((&read.set, &read.pick), (&DefaultedSet { page: 1, size: 5, facets }, &PickSet { pick: Some(7) }));
    let empty = <DefaultedRoute as FromUrl>::__read((), "").unwrap().set;
    assert_eq!(empty, DefaultedSet { page: 1, size: 0, facets: Default::default() });
    let link = ShownSetLink { set: ShownSet { tab: Some(Shown("a b".into())) } };
    assert_eq!(link.href(), "/shown-set?tab=a%20b");
    let around = AroundLink { around: AroundSet { page: Some(2), set: ShownSet { tab: Some(Shown("b".into())) } } };
    assert_eq!(around.href(), "/around?page=2&tab=b", "a generic set's nested set is written");
    let read = <AroundRead as FromUrl>::__read((), "page=2&pick=7").unwrap();
    assert_eq!((read.around.page, &read.around.set), (Some(2), &PickSet { pick: Some(7) }), "and read back");
}

/// A set whose value is a rule over what was sent (`FromQuery`): a listing only when every one
/// sent agrees, and whether any option has a value.
#[derive(Debug, Default, PartialEq)]
pub struct Chosen {
    pub listing: Option<String>,
    pub options: Vec<(String, String)>,
}

impl Chosen {
    /// Any option has a value: a rule across keys.
    fn filtered(&self) -> bool {
        self.options.iter().any(|(_, v)| !v.is_empty())
    }
}

#[derive(crate::Route)]
#[route(query)]
pub struct ChosenLink<'a> {
    pub listing: Option<&'a str>,
    #[route(prefix = "dimension.")]
    pub options: &'a [(String, String)],
}

#[derive(crate::Route)]
#[route(query)]
pub struct ChosenRead {
    pub listing: Vec<String>,
    #[route(prefix = "dimension.")]
    pub options: Vec<(String, String)>,
}

impl crate::route::FromQuery for Chosen {
    type Link<'a> = ChosenLink<'a>;
    type Read = ChosenRead;

    fn link(&self) -> ChosenLink<'_> {
        ChosenLink { listing: self.listing.as_deref(), options: &self.options }
    }

    fn from_query(read: ChosenRead) -> Result<Self, crate::form::FormError> {
        let mut listings = read.listing.into_iter().filter(|l| !l.is_empty());
        let first = listings.next();
        if first.as_deref() == Some("refuse") {
            return Err(serde::de::Error::custom("listing: refused"));
        }
        let listing = if listings.all(|l| Some(&l) == first.as_ref()) { first } else { None };
        Ok(Chosen { listing, options: read.options })
    }
}

#[derive(crate::Route)]
#[route("/chosen")]
pub struct ChosenRoute {
    pub q: Option<String>,
    #[route(query)]
    pub chosen: Chosen,
}

#[test]
fn a_query_set_can_be_a_rule_over_what_was_sent() {
    use crate::route::FromUrl;
    let chosen = Chosen { listing: Some("l 1".into()), options: vec![("form".into(), "graded".into())] };
    let href = ChosenRoute { q: Some("x".into()), chosen }.href();
    assert_eq!(href, "/chosen?q=x&listing=l%201&dimension.form=graded");
    let read = <ChosenRoute as FromUrl>::__read((), href.split_once('?').unwrap().1).unwrap();
    assert_eq!(
        (read.q.as_deref(), &read.chosen),
        (Some("x"), &Chosen { listing: Some("l 1".into()), options: vec![("form".into(), "graded".into())] }),
        "a link reads back as itself"
    );
    assert!(read.chosen.filtered());
    let read = <ChosenRoute as FromUrl>::__read((), "listing=l1&listing=l1&zz=1").unwrap();
    assert_eq!(read.chosen.listing.as_deref(), Some("l1"), "a value sent twice is the set's to judge");
    let read = <ChosenRoute as FromUrl>::__read((), "listing=l1&listing=l2&dimension.form=").unwrap();
    assert_eq!((read.chosen.listing.as_deref(), read.chosen.filtered()), (None, false), "two listings are no choice");
    let err = <ChosenRoute as FromUrl>::__read((), "listing=refuse").err().expect("the set's failure refuses the page");
    assert!(err.to_string().contains("refused"), "{err}");
    assert!(<ChosenRoute as FromUrl>::__read((), "q=a&q=b").is_err(), "the route's own parameters are read as before");
}

/// A route reads past a query key it does not name, so a page part's route reads the address
/// `rows::sort` gave its `ReadAgain::from`, which may carry a key only the page's route has (#885).
#[test]
fn a_route_reads_past_a_query_key_it_does_not_name() {
    use crate::route::FromUrl;
    #[derive(crate::Route)]
    #[route("/part")]
    struct PartRoute {
        after: Option<String>,
    }
    let read = <PartRoute as FromUrl>::__read((), "sold=price&after=r2").expect("an unnamed key is no error");
    assert_eq!(read.after.as_deref(), Some("r2"));
}

/// A `FromQuery` set whose `Read` names its fields in another order than its `Link`, both
/// including a derived set: the names, not their order, must match.
#[derive(Debug, PartialEq)]
pub struct Reordered {
    pub listing: Option<String>,
    pub page: Option<u32>,
}

#[derive(crate::Route)]
#[route(query)]
pub struct ReorderedLink<'a> {
    pub listing: Option<&'a str>,
    #[route(query)]
    pub paging: ParamsPaging,
}

#[derive(crate::Route)]
#[route(query)]
pub struct ReorderedRead {
    #[route(query)]
    pub paging: ParamsPaging,
    pub listing: Vec<String>,
}

impl crate::route::FromQuery for Reordered {
    type Link<'a> = ReorderedLink<'a>;
    type Read = ReorderedRead;

    fn link(&self) -> ReorderedLink<'_> {
        ReorderedLink { listing: self.listing.as_deref(), paging: ParamsPaging { page: self.page } }
    }

    fn from_query(read: ReorderedRead) -> Result<Self, crate::form::FormError> {
        Ok(Reordered { listing: read.listing.into_iter().next(), page: read.paging.page })
    }
}

#[derive(crate::Route)]
#[route("/reordered")]
pub struct ReorderedRoute {
    #[route(query)]
    pub set: Reordered,
}

#[test]
fn a_query_set_that_is_a_rule_matches_names_not_their_order() {
    use crate::route::FromUrl;
    let set = Reordered { listing: Some("l1".into()), page: Some(3) };
    let href = ReorderedRoute { set }.href();
    assert_eq!(href, "/reordered?listing=l1&page=3");
    let read = <ReorderedRoute as FromUrl>::__read((), href.split_once('?').unwrap().1).unwrap();
    assert_eq!(read.set, Reordered { listing: Some("l1".into()), page: Some(3) });
}

/// Search words read from `q`, or from the older `search` an address shared before the rename
/// has (`#[route(read_only)]`); links write only `q` (#577).
#[derive(Debug, PartialEq)]
pub struct Terms(pub Option<String>);

#[derive(crate::Route)]
#[route(query)]
pub struct TermsLink<'a> {
    pub q: Option<&'a str>,
}

#[derive(crate::Route)]
#[route(query)]
pub struct TermsRead {
    pub q: Vec<String>,
    #[route(read_only)]
    pub search: Vec<String>,
}

impl crate::route::FromQuery for Terms {
    type Link<'a> = TermsLink<'a>;
    type Read = TermsRead;

    fn link(&self) -> TermsLink<'_> {
        TermsLink { q: self.0.as_deref() }
    }

    fn from_query(read: TermsRead) -> Result<Self, crate::form::FormError> {
        Ok(Terms(read.q.into_iter().chain(read.search).find(|t| !t.is_empty())))
    }
}

#[derive(crate::Route)]
#[route("/search")]
pub struct SearchRoute {
    #[route(query)]
    pub terms: Terms,
    pub page: Option<u32>,
}

#[test]
fn an_older_name_is_read_and_never_written() {
    use crate::route::FromUrl;
    assert_eq!(SearchRoute { terms: Terms(Some("pika".into())), page: None }.href(), "/search?q=pika");
    for (query, words) in [("search=pika", Some("pika")), ("q=mew&search=pika", Some("mew")), ("page=2", None)] {
        let read = <SearchRoute as FromUrl>::__read((), query).unwrap();
        assert_eq!(read.terms, Terms(words.map(str::to_owned)), "{query}");
    }
    // The route counts the older name with its own, though no link writes it.
    use crate::route::__private::{Key, ReadKeys};
    assert!(<Terms as ReadKeys>::__KEYS.iter().any(|k| matches!(k, Key::ReadOnly("search"))));
}

/// A `FromQuery` set inside a derived one, beside the outer set's own names.
#[derive(crate::Route)]
#[route(query)]
pub struct ChosenOuter {
    pub sort: Option<String>,
    #[route(query)]
    pub chosen: Chosen,
}

#[derive(crate::Route)]
#[route("/chosen-outer")]
pub struct ChosenOuterRoute {
    #[route(query)]
    pub outer: ChosenOuter,
}

#[test]
fn a_query_set_that_is_a_rule_reads_inside_another() {
    use crate::route::FromUrl;
    let read = <ChosenOuterRoute as FromUrl>::__read((), "sort=price&listing=l1&dimension.form=graded").unwrap();
    assert_eq!(read.outer.sort.as_deref(), Some("price"));
    assert_eq!(read.outer.chosen, Chosen { listing: Some("l1".into()), options: vec![("form".into(), "graded".into())] });
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, serde::Deserialize, crate::UrlValue)]
#[serde(rename_all = "snake_case")]
pub enum Filter {
    #[default]
    All,
    Due,
}

#[derive(Debug, PartialEq, serde::Deserialize, crate::Route)]
#[route(query)]
pub struct FilterSet {
    pub state: Option<Filter>,
}

#[derive(crate::Route)]
#[route("/filtered")]
pub struct Filtered {
    pub sort: Option<Filter>,
    #[serde(default)]
    pub shown: Filter,
    #[route(query)]
    pub set: FilterSet,
}

#[test]
fn a_query_word_the_app_no_longer_has_reads_as_missing() {
    use crate::route::FromUrl;
    let read = <Filtered as FromUrl>::__read((), "sort=due_now&shown=gone&state=old").unwrap();
    assert_eq!((read.sort, read.shown, read.set.state), (None, Filter::All, None));
    let read = <Filtered as FromUrl>::__read((), "sort=due&shown=due&state=due").unwrap();
    assert_eq!((read.sort, read.shown, read.set.state), (Some(Filter::Due), Filter::Due, Some(Filter::Due)));
    assert!(<Filtered as FromUrl>::__read((), "sort=due&sort=all").is_err(), "sent twice is still refused");
}

#[derive(crate::Route)]
#[route("/faceted")]
pub struct Faceted {
    #[route(prefix = "f.")]
    pub facets: std::collections::BTreeMap<Filter, Filter>,
    #[route(prefix = "n.")]
    pub counts: Vec<(Filter, u32)>,
}

#[test]
fn a_prefixed_entry_the_app_no_longer_has_is_left_out() {
    use crate::route::FromUrl;
    let read = <Faceted as FromUrl>::__read((), "f.due=all&f.gone=due&f.all=gone&n.due=2&n.old=3").unwrap();
    assert_eq!(read.facets, std::collections::BTreeMap::from([(Filter::Due, Filter::All)]));
    assert_eq!(read.counts, vec![(Filter::Due, 2)]);
    let err = <Faceted as FromUrl>::__read((), "n.due=two").err().expect("a value that is not a word is refused");
    assert!(err.to_string().contains("n.due: "), "the error names the parameter: {err}");
}

/// Every kind of parameter a route has, which its handler reads back as the link wrote it.
#[crate::routes]
mod params_url {
    #[route("/flags/{on}.txt", get = params_flag)]
    pub struct Flag {
        pub on: bool,
    }

    #[route("/shops/{shop}/items/{id}", get = params_item)]
    #[serde(rename_all = "camelCase")]
    pub struct Item<'a> {
        pub shop: &'a str,
        pub id: u32,
        pub sort_by: Option<&'a str>,
        pub tags: &'a [&'a str],
        #[serde(default)]
        pub mine: bool,
        #[route(query)]
        pub paging: super::ParamsPaging,
        #[route(prefix = "dim.")]
        pub dims: &'a std::collections::BTreeMap<String, String>,
    }

    #[route("/files/{*rest}", get = params_file)]
    pub struct File<'a> {
        pub rest: std::borrow::Cow<'a, str>,
    }

    /// A parameter followed by text in its segment: a sitemap's pages.
    #[route("/sitemap/{kind}/{page}.xml", get = params_sitemap)]
    pub struct SitemapPage<'a> {
        pub kind: &'a str,
        pub page: u32,
        pub gz: Option<bool>,
    }
}

paths! { Feeds = "/feeds" }

/// A route of an area with the same, added by hand (no `Params` in its handler).
#[derive(crate::Route)]
#[route("/feeds/{name}.rss")]
struct Rss<'a> {
    name: &'a str,
}

/// A value a link prints but nothing reads back: neither `Clone`, `Send` nor `Deserialize`.
pub struct Shown(std::rc::Rc<str>);

impl std::fmt::Display for Shown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A route used only for links still needs only `Display` of its fields.
#[derive(crate::Route)]
#[route("/shown/{value}")]
#[serde(deny_unknown_fields)]
struct LinkOnly<'a> {
    value: &'a Shown,
    #[serde(alias = "t")]
    tab: Option<&'a Shown>,
}

/// The same fields with no serde key: its hidden owned twin is written, and asks nothing of
/// `Shown` until a handler reads the route's `Params`.
#[derive(crate::Route)]
#[route("/shown-twin/{value}")]
struct LinkTwin<'a> {
    value: &'a Shown,
    tab: Option<&'a Shown>,
}

/// The same with text after the parameter: still only `Display` for a link.
#[derive(crate::Route)]
#[route("/shown-file/{value}.xml")]
struct LinkFile<'a> {
    value: &'a Shown,
}

async fn params_item(item: crate::Params<params_url::Item<'_>>) -> String {
    let (shop, id, sort, tags, mine, page, dims) =
        (&item.shop, item.id, &item.sort_by, &item.tags, item.mine, item.paging.page, &item.dims);
    format!("{shop}|{id}|{sort:?}|{tags:?}|{mine}|{page:?}|{dims:?}")
}

async fn params_file(file: crate::Params<params_url::File<'_>>) -> String {
    file.rest.clone()
}

/// Routes whose path starts with a parameter, where a value starting with `/` could make the
/// href `//host/..`.
#[crate::routes]
mod leading_url {
    #[route("/{*rest}", get = leading_rest)]
    pub struct Rest<'a> {
        pub rest: &'a str,
    }
}

async fn leading_rest(rest: crate::Params<leading_url::Rest<'_>>) -> String {
    rest.rest.clone()
}

#[derive(crate::Route)]
#[route("/{user}/posts")]
struct UserPosts<'a> {
    user: &'a str,
}

#[tokio::test]
async fn a_path_that_starts_with_a_parameter_stays_on_this_site_and_reads_back() {
    let router = App::new(leading_url::router()).router();
    for (value, href) in [
        ("/evil.example/x", "/%2Fevil.example/x"),
        ("//evil.example", "/%2F/evil.example"),
        ("docs/a b.txt", "/docs/a%20b.txt"),
        ("a//b", "/a//b"),
    ] {
        let link = leading_url::Rest { rest: value };
        assert_eq!(link.href(), href, "{value:?}");
        assert_eq!(link.to_html(), href, "{value:?}");
        assert!(crate::Local::parse(&link.href()).is_some(), "{value:?} is a path on this site");
        let (status, _, body) = call_with(router.clone(), "GET", &link.href(), None, None).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, value), "{href} reads back as the value");
    }
    // An empty first segment stays a path on this site; it is not the user's page (a `/{slug}`
    // route would read it as the slug `/posts`), so an app does not link an empty value.
    assert_eq!(UserPosts { user: "" }.href(), "/%2Fposts");
    assert_eq!(UserPosts { user: "/x" }.href(), "/%2Fx/posts");
    assert_eq!(UserPosts { user: "ann" }.href(), "/ann/posts");
    // A hand-written Route is OnSite too, so redirect_with_notice and resend_to check what it
    // writes, as a browser reads it: `\` is `/` to it, and it drops a tab.
    struct Evil(&'static str);
    impl crate::Route for Evil {
        const PATH: &'static str = "/evil";
        fn write_href(&self, out: &mut String, _: bool) {
            out.push_str(self.0);
        }
    }
    for to in ["//evil.example/x", "/\\evil.example/x", "/\t/evil.example/x", "https://evil.example/x", "http:evil.example"] {
        let off = Router::new()
            .route("/", get(move |req: Req| async move { req.redirect_with_notice(&Evil(to), "Saved.") }))
            .route("/", axum::routing::put(move |req: Req| async move { req.resend_to::<()>(&Evil(to)) }));
        let router = App::new(Routes::from(off)).router();
        for method in ["GET", "PUT"] {
            let (status, headers, _) = call_with(router.clone(), method, "/", None, None).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{method} {to:?}: {headers:?}");
            assert!(!headers.contains_key("location"), "{method} {to:?}");
        }
    }
}

async fn params_sitemap(page: crate::Params<params_url::SitemapPage<'_>>) -> String {
    format!("{}|{}|{:?}", page.kind, page.page, page.gz)
}

#[tokio::test]
async fn a_parameter_followed_by_text_is_read_without_it() {
    use crate::route::Route as _;
    assert_eq!(<params_url::SitemapPage<'_> as crate::Route>::PATH, "/sitemap/{kind}/{page}", "axum matches the segment");
    let link = params_url::SitemapPage { kind: "items", page: 3, gz: None };
    assert_eq!(link.href(), "/sitemap/items/3.xml");
    let router = App::new(params_url::router()).router();
    let (status, _, body) = call_with(router.clone(), "GET", &link.href(), None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "items|3|None"));
    let (_, _, body) = call_with(router.clone(), "GET", "/sitemap/items/12.xml?gz=true", None, None).await;
    assert_eq!(body, "items|12|Some(true)", "with a query");
    // The text is the route's: without it, or with nothing before it, no route matches.
    for path in ["/sitemap/items/3", "/sitemap/items/3.json", "/sitemap/items/.xml", "/sitemap/items/3.xml.bak"] {
        for method in ["GET", "DELETE"] {
            let (status, _, _) = call_with(router.clone(), method, path, None, None).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
        }
    }
    let (status, _, _) = call_with(router.clone(), "DELETE", "/sitemap/items/3.xml", None, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "a path the route serves, by another method");
    // A value that is not the parameter's type is refused as any path parameter is.
    let (status, _, body) = call_with(router.clone(), "GET", "/sitemap/items/x.xml", None, Some("text/plain")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.starts_with("Invalid URL: Cannot parse `x` to a `u32`"), "{body}");
    // A number as a path reads one, not as a number input sends it: `3.0` is no page's link.
    let (status, _, _) = call_with(router.clone(), "GET", "/sitemap/items/3.0.xml", None, Some("text/plain")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "3.0");

    // A route added to an area by hand is checked the same, with no `Params` to do it.
    let rss = crate::Methods::reads(get(|| async { "rss" }));
    let area = App::new(Routes::new()).area::<Feeds>(|feeds| feeds.route::<Rss>(rss));
    let router = area.router();
    let (status, _, body) = call_with(router.clone(), "GET", &Rss { name: "news" }.href(), None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "rss"));
    let (status, _, _) = call_with(router, "GET", "/feeds/news.atom", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // And one of an API, whose failures are JSON.
    let json = crate::Methods::reads(get(|| async { "json" }));
    let router = App::new(Routes::new()).api::<ApiRoot>(|api| api.route::<ApiFile>(json)).router();
    let (status, _, body) = call_with(router.clone(), "GET", &ApiFile { name: "rates" }.href(), None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "json"));
    let (status, headers, _) = call_with(router, "GET", "/api/files/rates.csv", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(headers[header::CONTENT_TYPE], "application/problem+json", "an API's 404");
}

#[derive(crate::Route)]
#[route("/api/files/{name}.json")]
struct ApiFile<'a> {
    name: &'a str,
}

#[derive(crate::Route)]
#[route("/feeds/{name}.atom")]
struct Atom<'a> {
    name: &'a str,
}

/// Two routes that differ only in the text after a parameter, in different places (the app's
/// routes and an area): axum would match them as one path, so the app does not start.
#[test]
#[should_panic(expected = "differ only in the text after a parameter")]
fn routes_that_differ_only_in_the_text_after_a_parameter_do_not_start() {
    let rss = crate::Methods::reads(get(|| async { "rss" }));
    let atom = crate::Methods::reads(axum::routing::post(|| async { "atom" }));
    let _ = App::new(Routes::new().__route::<Rss>(rss)).area::<Feeds>(|feeds| feeds.route::<Atom>(atom)).router();
}

async fn params_flag(at: crate::Params<params_url::Flag>) -> String {
    at.on.to_string()
}

/// A value before text reads as a path parameter does: a `bool` is `true` or `false`, not a
/// checkbox's `on`.
#[tokio::test]
async fn a_value_before_text_reads_as_a_path_parameter() {
    let router = App::new(params_url::router()).router();
    let (status, _, body) = call_with(router.clone(), "GET", "/flags/true.txt", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "true"));
    let (status, _, _) = call_with(router, "GET", "/flags/on.txt", None, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[derive(crate::Route)]
#[route("/feeds/{kind}.json")]
struct FeedJson<'a> {
    kind: &'a str,
}

#[derive(crate::Route)]
#[route("/api/files/{name}.csv")]
struct ApiCsv<'a> {
    name: &'a str,
}

/// Two routes of one API that differ only in the text after a parameter.
#[test]
#[should_panic(expected = "differ only in the text after a parameter")]
fn routes_of_an_api_that_differ_only_in_the_text_after_a_parameter_do_not_start() {
    let json = crate::Methods::reads(get(|| async { "json" }));
    let csv = crate::Methods::reads(axum::routing::post(|| async { "csv" }));
    let _ = App::new(Routes::new()).api::<ApiRoot>(|api| api.route::<ApiFile>(json).route::<ApiCsv>(csv));
}

/// A page and an API route that differ only in the text after a parameter.
#[test]
#[should_panic(expected = "differ only in the text after a parameter")]
fn a_page_and_an_api_route_that_differ_only_in_the_text_after_a_parameter_do_not_start() {
    let json = crate::Methods::reads(get(|| async { "json" }));
    let csv = crate::Methods::reads(axum::routing::post(|| async { "csv" }));
    let _ = App::new(Routes::new().__route::<ApiCsv>(csv)).api::<ApiRoot>(|api| api.route::<ApiFile>(json)).router();
}

/// The same in one area, with other parameter names: refused by Corten before the router (which
/// would merge the two methods into one path, or refuse the names with a message about neither).
#[test]
#[should_panic(expected = "differ only in the text after a parameter")]
fn routes_of_an_area_that_differ_only_in_the_text_after_a_parameter_do_not_start() {
    let rss = crate::Methods::reads(get(|| async { "rss" }));
    let json = crate::Methods::reads(axum::routing::post(|| async { "json" }));
    let _ = App::new(Routes::new()).area::<Feeds>(|feeds| feeds.route::<Rss>(rss).route::<FeedJson>(json));
}

#[derive(crate::Route)]
#[route("/feeds/{*rest}")]
struct FeedsRest<'a> {
    rest: &'a str,
}

/// A route with text after a parameter where another, in another module or an area, has its
/// catch-all: the router cannot hold the two, and Corten names both as written (axum would name
/// `/feeds/{name}`), in either order.
#[test]
#[should_panic(expected = "have a parameter where the other has its catch-all")]
fn a_route_with_text_beside_a_catch_all_does_not_start() {
    let rest = crate::Methods::reads(get(|| async { "rest" }));
    let rss = crate::Methods::reads(get(|| async { "rss" }));
    let _ = App::new(Routes::new().__route::<FeedsRest>(rest)).area::<Feeds>(|feeds| feeds.route::<Rss>(rss)).router();
}

#[test]
#[should_panic(expected = "have a parameter where the other has its catch-all")]
fn a_catch_all_beside_a_route_with_text_in_an_area_does_not_start() {
    let rest = crate::Methods::reads(get(|| async { "rest" }));
    let rss = crate::Methods::reads(get(|| async { "rss" }));
    let _ = App::new(Routes::new()).area::<Feeds>(|feeds| feeds.route::<Rss>(rss).route::<FeedsRest>(rest));
}

#[derive(crate::Route)]
#[route("/api/files/{*rest}")]
struct ApiFilesRest<'a> {
    rest: &'a str,
}

#[test]
#[should_panic(expected = "have a parameter where the other has its catch-all")]
fn a_route_with_text_beside_a_catch_all_in_an_api_does_not_start() {
    let json = crate::Methods::reads(get(|| async { "json" }));
    let rest = crate::Methods::reads(get(|| async { "rest" }));
    let _ = App::new(Routes::new()).api::<ApiRoot>(|api| api.route::<ApiFile>(json).route::<ApiFilesRest>(rest));
}

#[tokio::test]
async fn a_handler_reads_its_routes_parameters_as_the_link_wrote_them() {
    let router = App::new(params_url::router()).router();
    let dims = std::collections::BTreeMap::from([
        ("form".to_string(), "graded".to_string()),
        ("grade".to_string(), "PSA 8".to_string()),
    ]);
    let link = params_url::Item {
        shop: "a b/c",
        id: 7,
        sort_by: Some("price"),
        tags: &["x", "y&z"],
        mine: true,
        paging: ParamsPaging { page: Some(2) },
        dims: &dims,
    };
    assert_eq!(
        link.href(),
        "/shops/a%20b%2Fc/items/7?sortBy=price&tags=x&tags=y%26z&mine=true&page=2&dim.form=graded&dim.grade=PSA%208"
    );
    let (status, _, body) = call_with(router.clone(), "GET", &link.href(), None, None).await;
    assert_eq!(
        (status, &body[..]),
        (StatusCode::OK, r#"a b/c|7|Some("price")|["x", "y&z"]|true|Some(2)|{"form": "graded", "grade": "PSA 8"}"#)
    );
    let empty = std::collections::BTreeMap::new();
    let plain = params_url::Item {
        shop: "s",
        id: 1,
        sort_by: None,
        tags: &[],
        mine: false,
        paging: ParamsPaging::default(),
        dims: &empty,
    };
    let (status, _, body) = call_with(router.clone(), "GET", "/shops/s/items/1", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "s|1|None|[]|false|None|{}"), "{}", plain.href());
    let (_, _, body) = call_with(router.clone(), "GET", "/shops/s/items/1?sortBy=&other=1", None, None).await;
    assert_eq!(body, "s|1|None|[]|false|None|{}", "a blank value is none, and a parameter the route does not have is ignored");
    for uri in
        ["/shops/s/items/seven", "/shops/s/items/1?mine=maybe", "/shops/s/items/1?page=x", "/shops/s/items/1?sortBy=a&sortBy=b"]
    {
        let (status, _, _) = call_with(router.clone(), "GET", uri, None, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
    }
    let shown = Shown("x y".into());
    assert_eq!(LinkOnly { value: &shown, tab: Some(&shown) }.href(), "/shown/x%20y?tab=x%20y");
    assert_eq!(LinkTwin { value: &shown, tab: None }.href(), "/shown-twin/x%20y");
    assert_eq!(LinkFile { value: &shown }.href(), "/shown-file/x%20y.xml");
    let file = params_url::File { rest: "docs/a b.txt".into() };
    let (_, _, body) = call_with(router, "GET", &file.href(), None, None).await;
    assert_eq!(body, "docs/a b.txt", "{}", file.href());
}

/// An API's routes in a module of their own, sharing the module's state; its prefix route names
/// no handler.
#[crate::routes(api = ModRoot, state = u32)]
mod api_module {
    #[route("/v1")]
    pub struct ModRoot;

    #[route("/v1/items/{id}", get = module_item)]
    pub struct ModItem {
        pub id: u32,
    }
}

async fn module_item(axum::extract::State(base): axum::extract::State<u32>, item: crate::Params<api_module::ModItem>) -> String {
    format!("item {}", base + item.id)
}

#[tokio::test]
async fn an_api_module_serves_its_routes_and_answers_its_failures_as_json() {
    let router = App::new(Routes::new()).api(|routes| api_module::api(routes, 100)).router();
    let (status, _, body) = call_with(router.clone(), "GET", "/v1/items/7", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "item 107"), "the handler gets the module's state");
    for (uri, status) in
        [("/v1/items/seven", StatusCode::BAD_REQUEST), ("/v1", StatusCode::NOT_FOUND), ("/v1/nope", StatusCode::NOT_FOUND)]
    {
        let (got, headers, body) = call_with(router.clone(), "GET", uri, None, Some("text/html")).await;
        assert_eq!((got, headers["content-type"].to_str().unwrap()), (status, "application/problem+json"), "{uri}");
        assert!(body.starts_with('{') && body.contains(&format!(r#""status":{}"#, status.as_u16())), "{uri}: {body}");
    }
    assert_eq!(api_module::ModItem { id: 7 }.to_string(), "/v1/items/7", "the structs still build links");
}

#[cfg(feature = "json")]
#[tokio::test]
async fn validation_errors_are_the_json_error_with_fields() {
    let router = App::new(Routes::new())
        .api::<ApiRoot>(|api| {
            api.route::<ApiSignUp>(crate::Methods::writes(axum::routing::post(|| async {
                let mut errors = Errors::new();
                errors.add(SignUp::FIELDS.email, "Enter an email address.");
                Err::<&str, _>(errors)
            })))
        })
        .router();
    let (status, _, body) = call_with(router, "POST", "/api/sign-up", None, None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body,
        r#"{"title":"Unprocessable Entity","status":422,"detail":"email: Enter an email address.","fields":{"email":"Enter an email address."}}"#
    );
}

/// A JSON route that checks its input and loads a record, each with `?`.
#[cfg(feature = "json")]
#[crate::routes(api = CheckedRoot)]
mod checked_api {
    #[route("/checked")]
    pub struct CheckedRoot;

    #[route("/checked/{n}", post = checked)]
    pub struct Checked {
        pub n: u32,
    }
}

#[cfg(feature = "json")]
async fn checked(checked: crate::Params<checked_api::Checked>) -> crate::JsonResult<u32> {
    let n = checked.n;
    let mut errors = Errors::new();
    if n == 0 {
        errors.add(SignUp::FIELDS.email, "Enter a number above zero.");
    }
    let n = errors.into_result(n)?;
    // A load that fails, next to the check.
    let n = n.checked_mul(1000).ok_or_else(|| Error::new("too large to load"))?;
    Ok(crate::Json(n))
}

/// JSON answers with a status or a cookie of their own, in a routes module and under an API.
#[cfg(feature = "json")]
#[crate::routes]
mod own_json_url {
    #[route("/started", post = own_started)]
    pub struct Started;

    #[route("/forecast", get = own_forecast)]
    pub struct Forecast;

    #[route("/session", post = own_session)]
    pub struct Session;

    #[route("/held", get = own_held)]
    pub struct Held;

    #[route("/batches/{request}", post = own_created)]
    pub struct Created {
        pub request: String,
    }

    #[route("/secret/{request}", post = own_secret)]
    pub struct Secret {
        pub request: String,
    }
}

#[cfg(feature = "json")]
#[crate::routes(api = OwnApiRoot)]
mod own_json_api {
    #[route("/v1")]
    pub struct OwnApiRoot;

    #[route("/v1/forecast", get = own_forecast)]
    pub struct ApiForecast;

    #[route("/v1/batches/{request}", post = own_api_created)]
    pub struct ApiCreated {
        pub request: String,
    }
}

#[cfg(feature = "json")]
#[derive(serde::Serialize, crate::ToJson)]
struct OwnStarted {
    ok: bool,
}

#[cfg(feature = "json")]
async fn own_started() -> Result<crate::JsonResponse, JsonError> {
    Ok(crate::Json(OwnStarted { ok: true }).with_status(StatusCode::ACCEPTED))
}

#[cfg(feature = "json")]
async fn own_forecast() -> Result<crate::JsonResponse, JsonError> {
    let problem = crate::json::Raw::new(r#"{"error":"No capacity forecast yet"}"#)?;
    Err(crate::Json(problem).with_status(StatusCode::SERVICE_UNAVAILABLE).into())
}

#[cfg(feature = "json")]
async fn own_session() -> Result<crate::JsonResponse, JsonError> {
    let token = SetCookie::try_new("session", "abc")?;
    Ok(crate::Json(OwnStarted { ok: true }).with_cookie(token).with_cookie(SetCookie::remove("old")))
}

/// A refusal in the app's own shape, taken with `?` from a helper (#584).
#[cfg(feature = "json")]
fn own_batch(request: &str) -> Result<crate::JsonResponse, JsonError> {
    let refused =
        |status, error| crate::json::Raw::new(format!(r#"{{"error":"{error}"}}"#)).map(|e| crate::Json(e).with_status(status));
    if request.trim() == "-" {
        Err(refused(StatusCode::BAD_REQUEST, "requestId is required")?)?;
    }
    if request == "boom" {
        return Err(Error::new("the store is down").into());
    }
    if request == "gone" {
        Err(refused(StatusCode::GONE, "batch is closed")?.with_cookie(SetCookie::remove("batch")))?;
    }
    Ok(crate::Json(OwnStarted { ok: true }).with_status(StatusCode::CREATED))
}

#[cfg(feature = "json")]
async fn own_created(crate::Params(at): crate::Params<own_json_url::Created>) -> Result<crate::JsonResponse, JsonError> {
    own_batch(&at.request)
}

#[cfg(feature = "json")]
async fn own_secret(crate::Params(at): crate::Params<own_json_url::Secret>) -> NoStore<Result<crate::JsonResponse, JsonError>> {
    NoStore(own_batch(&at.request))
}

/// An API's own error shape, which Corten's failures take and the app's refusals do not.
#[cfg(feature = "json")]
#[derive(crate::ToJson)]
struct OwnShape {
    error: String,
}

#[cfg(feature = "json")]
async fn own_api_created(crate::Params(at): crate::Params<own_json_api::ApiCreated>) -> Result<crate::JsonResponse, JsonError> {
    own_batch(&at.request)
}

#[cfg(feature = "json")]
async fn own_held() -> crate::JsonResult<crate::json::Raw> {
    Ok(crate::Json(crate::json::Raw::new(r#"{"rows":[1,2]}"#)?))
}

#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_answer_has_a_status_and_cookies_of_its_own() {
    let router = App::new(own_json_url::router())
        .api(|routes| own_json_api::api(routes).errors(|_, message| OwnShape { error: format!("shaped: {message}") }))
        .router();
    let (status, headers, body) = call_with(router.clone(), "POST", "/started", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::ACCEPTED, r#"{"ok":true}"#));
    assert_eq!(headers["content-type"], "application/json");
    // The app's own 503 reaches the client as written, in a routes module and under an API.
    for uri in ["/forecast", "/v1/forecast"] {
        let (status, headers, body) = call_with(router.clone(), "GET", uri, None, Some("text/html")).await;
        assert_eq!((status, &body[..]), (StatusCode::SERVICE_UNAVAILABLE, r#"{"error":"No capacity forecast yet"}"#), "{uri}");
        assert_eq!(headers["content-type"], "application/json");
    }
    let (status, headers, body) = call_with(router.clone(), "POST", "/session", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, r#"{"ok":true}"#));
    let cookies: Vec<_> = headers.get_all("set-cookie").iter().map(|v| v.to_str().unwrap()).collect();
    assert_eq!(
        cookies,
        ["session=abc; Path=/; SameSite=Lax; HttpOnly; Secure", "old=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure"]
    );
    assert!(headers["cache-control"].to_str().unwrap().contains("private"));
    let (status, _, body) = call_with(router.clone(), "GET", "/held", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, r#"{"rows":[1,2]}"#));
    // A refusal in the app's own shape, `Err(answer)?`, reaches the client as written: not
    // Problem Details, and with what the answer set.
    for prefix in ["", "/v1"] {
        let (status, _, body) = call_with(router.clone(), "POST", &format!("{prefix}/batches/b7"), None, None).await;
        assert_eq!((status, &body[..]), (StatusCode::CREATED, r#"{"ok":true}"#), "{prefix}");
        let (status, headers, body) =
            call_with(router.clone(), "POST", &format!("{prefix}/batches/-"), None, Some("text/html")).await;
        assert_eq!((status, &body[..]), (StatusCode::BAD_REQUEST, r#"{"error":"requestId is required"}"#), "{prefix}");
        assert_eq!(headers["content-type"], "application/json");
        let (status, headers, body) = call_with(router.clone(), "POST", &format!("{prefix}/batches/gone"), None, None).await;
        assert_eq!((status, &body[..]), (StatusCode::GONE, r#"{"error":"batch is closed"}"#), "{prefix}");
        assert_eq!(headers["set-cookie"], "batch=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure");
    }
    // Corten's failure takes the API's shape; the app's refusal beside it does not.
    let (status, _, body) = call_with(router.clone(), "POST", "/v1/batches/boom", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::INTERNAL_SERVER_ERROR, r#"{"error":"shaped: Internal Server Error"}"#));
    let (status, _, body) = call_with(router.clone(), "POST", "/v1/batches/-", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::BAD_REQUEST, r#"{"error":"requestId is required"}"#));
    // NoStore holds for the app's refusal too.
    let (status, headers, body) = call_with(router, "POST", "/secret/-", None, None).await;
    assert_eq!(
        (status, &body[..], headers["cache-control"].to_str().unwrap()),
        (StatusCode::BAD_REQUEST, r#"{"error":"requestId is required"}"#, "no-store")
    );
}

#[cfg(feature = "json")]
#[test]
fn a_json_answer_keeps_its_cookies_out_of_debug() {
    let answer = crate::Json(OwnStarted { ok: true }).with_cookie(SetCookie::new("session", "s3cret"));
    let shown = format!("{:?}", JsonError::from(answer.with_status(StatusCode::UNAUTHORIZED)));
    assert!(shown.contains("401") && !shown.contains("s3cret"), "{shown}");
}

#[cfg(feature = "json")]
#[test]
fn a_json_error_stays_under_clippys_large_error_limit() {
    // clippy's `result_large_err` refuses an `Err` of 128 bytes or more by default.
    assert!(std::mem::size_of::<JsonError>() < 128, "{}", std::mem::size_of::<JsonError>());
}

#[cfg(feature = "json")]
#[test]
fn a_json_refusal_is_an_error_status() {
    let accepted = || crate::Json(OwnStarted { ok: true }).with_status(StatusCode::ACCEPTED);
    // A debug build panics; a release build answers a failure, never a 2xx as written.
    let panicked = std::panic::catch_unwind(|| JsonError::refusal(accepted(), true)).unwrap_err();
    assert!(panicked.downcast_ref::<String>().is_some_and(|m| m.contains("refuses with a 4xx or 5xx")));
    assert_eq!(JsonError::refusal(accepted(), false).into_response().status(), StatusCode::INTERNAL_SERVER_ERROR);
    let refused = crate::Json(OwnStarted { ok: false }).with_status(StatusCode::CONFLICT);
    assert_eq!(JsonError::refusal(refused, true).into_response().status(), StatusCode::CONFLICT);
}

#[cfg(feature = "json")]
#[test]
fn a_held_document_is_written_as_it_is_inside_another_value() {
    use crate::json::ToJson;
    #[derive(crate::ToJson)]
    struct Page {
        id: u32,
        rows: crate::json::Raw,
    }
    let doc = crate::json::Raw::new(r#"{"rows":[1,2]}"#).unwrap();
    assert_eq!(vec![doc.clone(), doc.clone()].to_json(), r#"[{"rows":[1,2]},{"rows":[1,2]}]"#);
    assert_eq!(Page { id: 7, rows: doc }.to_json(), r#"{"id":7,"rows":{"rows":[1,2]}}"#);
}

#[cfg(feature = "json")]
#[test]
fn a_held_document_that_is_not_one_json_value_is_an_error() {
    use crate::json::Raw;
    for text in ["{\"rows\": [1,", "", "{} {}", "nul", "\u{feff}{}"] {
        let error = Raw::new(text).unwrap_err();
        assert!(error.to_string().starts_with("not one JSON value: "), "{text:?}: {error}");
    }
    // A string in another encoding (Windows-1252's é) is not JSON, though the parser skips it.
    let error = Raw::new(&b"{\"name\":\"caf\xE9\"}"[..]).unwrap_err();
    assert!(error.to_string().starts_with("not one JSON value: not UTF-8"), "{error}");
    assert_eq!(Raw::new(" [1] ").unwrap().as_bytes(), b" [1] ");
}

#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_handler_question_marks_field_errors_into_a_422_with_the_fields() {
    let router = App::new(Routes::new()).api(checked_api::api).router();
    let (status, _, body) = call_with(router.clone(), "POST", "/checked/2", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "2000"));
    let (status, headers, body) = call_with(router.clone(), "POST", "/checked/0", None, Some("text/html")).await;
    assert_eq!(
        (status, headers["content-type"].to_str().unwrap()),
        (StatusCode::UNPROCESSABLE_ENTITY, "application/problem+json")
    );
    assert_eq!(
        body,
        r#"{"title":"Unprocessable Entity","status":422,"detail":"email: Enter a number above zero.","fields":{"email":"Enter a number above zero."}}"#
    );
    // Any other error is still a 500, whose message a client does not see.
    let (status, _, body) = call_with(router, "POST", "/checked/4294968", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::INTERNAL_SERVER_ERROR, r#"{"title":"Internal Server Error","status":500}"#));
    // An API with its own error shape writes the 500 in it; the fields keep Corten's shape.
    let shaped = App::new(Routes::new())
        .api(|api| {
            checked_api::api(api).errors(|status, message| ShapedError {
                r#type: "error",
                error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
            })
        })
        .router();
    let (_, _, body) = call_with(shaped.clone(), "POST", "/checked/4294968", None, None).await;
    assert_eq!(body, r#"{"type":"error","error":{"code":500,"message":"Internal Server Error"}}"#);
    let (status, _, body) = call_with(shaped, "POST", "/checked/0", None, None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body.ends_with(r#""fields":{"email":"Enter a number above zero."}}"#), "{body}");
}

#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_body_that_does_not_parse_is_a_json_400() {
    let router = App::new(Routes::new())
        .api::<ApiRoot>(|api| {
            api.route::<ApiItems>(crate::Methods::writes(axum::routing::post(
                |axum::Json(v): axum::Json<serde_json::Value>| async move { v.to_string() },
            )))
        })
        .router();
    let req = Request::post("/api/items").header("content-type", "application/json").body(Body::from("{nope")).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(
        body.starts_with(r#"{"title":"Bad Request","status":400,"detail":"Failed to parse the request body as JSON"#),
        "{body}"
    );
}

/// Pages marked for shared caches, one that sets a cookie, one that must never be stored, and one
/// that says nothing.
fn cached_routes() -> Router {
    let minute = std::time::Duration::from_secs(60);
    let home = || html! { <p>"home"</p> };
    Router::new()
        .route("/", get(move |req: Req| async move { Public::new(minute, req.test_page_for("Home", home())) }))
        .route(
            "/cookie",
            get(move |req: Req| async move {
                Ok::<_, Error>((Cache::public(minute), [(header::SET_COOKIE, "seen=1")], req.test_page("Home", home())?))
            }),
        )
        .route(
            "/catalog",
            get(move |req: Req| async move {
                Public::new(minute, req.test_page_for("Catalog", home())).shared(std::time::Duration::from_secs(86_400))
            }),
        )
        .route(
            "/archive",
            get(move |req: Req| async move {
                Public::new(minute, req.test_page_for("Archive", home())).stale_if_error(std::time::Duration::from_secs(86_400))
            }),
        )
        .route("/statement", get(move |req: Req| async move { NoStore(req.test_page("Statement", home())) }))
        // A one-time code that has expired, and a statement that is someone else's.
        .route(
            "/code",
            get(|| async { NoStore(Err::<StatusCode, Error>(Error::status(StatusCode::BAD_REQUEST))) })
                .post(|| async { NoStore(Err::<StatusCode, Error>(Error::status(StatusCode::BAD_REQUEST))) }),
        )
        // Two lines, as HTTP allows; the second says no-store.
        .route(
            "/lines",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "max-age=60"), (header::CACHE_CONTROL, "no-store")];
                (StatusCode::BAD_REQUEST, axum::response::AppendHeaders(lines), "")
            }),
        )
        .route("/statement/other", get(|| async { NoStore(Err::<StatusCode, Error>(Error::not_found())) }))
        // A no-store line with a byte that is not text.
        .route(
            "/odd",
            get(|| async {
                let line = HeaderValue::from_bytes(b"no-store, x=\"\xE9\"").unwrap();
                (StatusCode::BAD_REQUEST, [(header::CACHE_CONTROL, line)], "")
            }),
        )
        // Shared, with a limited private that still lets a shared cache keep the rest.
        .route(
            "/limited",
            get(|| async {
                let lines = [
                    (header::CACHE_CONTROL, "public, max-age=600"),
                    (header::CACHE_CONTROL, "private=\"set-cookie\""),
                    (header::SET_COOKIE, "seen=1"),
                ];
                (axum::response::AppendHeaders(lines), "limited")
            }),
        )
        .route(
            "/cookies",
            // `with_cookie` on a `Public` answer does not compile; a header written by hand still
            // makes it private when it is sent.
            get(move |req: Req| async move {
                let page = req.test_page_for("Home", home()).map(|mut page| {
                    page.headers_mut().append(header::SET_COOKIE, SetCookie::new("a", "1").header());
                    page
                });
                Public::new(minute, page)
            }),
        )
        .route("/plain", get(|req: Req| async move { req.test_page("Plain", html! { <p>"plain"</p> }) }))
        // A closure has no return type to read: `Public::new` finds its type from the answer.
        .route("/text", get(move || async move { Public::new(minute, "text") }))
        .route("/page", get(move |req: Req| async move { Public::new(minute, req.test_page_for("Page", home())) }))
}

async fn cache_control(router: &Router, uri: &str, extra: &[(&'static str, &'static str)]) -> String {
    let mut req = Request::get(uri);
    for (name, value) in extra {
        req = req.header(*name, *value);
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    res.headers()[header::CACHE_CONTROL].to_str().unwrap().to_string()
}

/// Each `with_cookie` adds one `Set-Cookie`, in order, with the safe flags.
#[tokio::test]
async fn with_cookie_sets_each_cookie_in_order() {
    let routes = Router::new().route(
        "/",
        get(|req: Req| async move {
            Ok::<_, Error>(
                req.redirect::<ForOne>(&Done)?.with_cookie(SetCookie::new("a", "1")).with_cookie(SetCookie::remove("b")),
            )
        }),
    );
    let res = app(routes, None).oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    let cookies: Vec<_> = res.headers().get_all(header::SET_COOKIE).iter().map(|c| c.to_str().unwrap()).collect();
    assert_eq!(cookies, ["a=1; Path=/; SameSite=Lax; HttpOnly; Secure", "b=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure"]);
}

/// A redirect's notice rides in a cookie for the page it goes to: that page reads it once (the
/// answer removes it, and is private), a navigation's page that did not draw it hands it to the
/// runtime in `corten-notice`, and another page neither sees nor removes it.
#[tokio::test]
async fn a_redirect_notice_is_read_once_by_the_page_it_was_for() {
    let routes = Router::new()
        .route("/", get(|req: Req| async move { req.redirect_with_notice(&Done.at(MsgId), "Batch 3517 deleted; 2 left.") }))
        .route("/long", get(|req: Req| async move { req.redirect_with_notice(&Done, "é".repeat(400)) }))
        .route(
            "/done",
            get(|req: Req| async move {
                let notice = req.notice();
                req.test_page("Done", html! { <p>{notice}</p> })
            }),
        )
        .route("/other", get(|req: Req| async move { req.test_page("Other", "nothing") }));
    let router = app(routes, None);
    let set = |res: &Response| {
        res.headers().get_all(header::SET_COOKIE).iter().map(|c| c.to_str().unwrap().to_string()).collect::<Vec<_>>()
    };
    let res = router.clone().oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    assert_eq!(res.headers()[header::LOCATION], "/done#msg");
    let key = |path: &str| crate::page::path_key(path);
    let cookie = &format!("__Host-corten-notice=p={}&m=Batch+3517+deleted%3B+2+left.", key("/done"));
    assert_eq!(set(&res), [format!("{cookie}; Path=/; SameSite=Lax; Max-Age=60; HttpOnly; Secure")]);
    // The page's path, escapes decoded: the link's `%20` and the browser's `%7B` for a `{` name
    // the same page as the characters.
    assert_eq!(key("/items/a%20b"), key("/items/a b"));
    assert_eq!(key("/a%7Bb%7d"), key("/a{b}"));
    assert_ne!(key("/done"), key("/done/"));
    // An escaped `/` is part of one segment, not a second one.
    assert_ne!(key("/a%2Fb"), key("/a/b"));
    // A broken escape is its bytes as they are.
    assert_ne!(key("/bad%zz"), key("/bad"));
    assert_ne!(key("/bad%4"), key("/bad"));
    let fetch = |uri: &str, mode: Option<&str>| {
        let mut req = Request::get(uri).header(header::COOKIE, format!("a=1; {cookie}"));
        if let Some(mode) = mode {
            req = req.header("corten", mode);
        }
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };
    let gone = "__Host-corten-notice=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure";
    for mode in [None, Some("nav")] {
        let res = fetch("/done", mode).await.unwrap();
        assert_eq!(set(&res), [gone], "{mode:?}");
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache");
        // The page drew it: the answer says so (`&d`), so the runtime keeps it only for a full load
        // in its place. A whole document says it too, for the runtime that fetched it after a write.
        let header = res.headers().get("corten-notice").map(|v| v.to_str().unwrap().to_string());
        assert_eq!(header.as_deref(), Some("m=Batch+3517+deleted%3B+2+left.&d"), "{mode:?}");
        let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        assert!(body.contains("<p>Batch 3517 deleted; 2 left.</p>"), "{body}");
    }
    let res = fetch("/other", Some("nav")).await.unwrap();
    assert!(set(&res).is_empty() && res.headers().get("corten-notice").is_none(), "another page leaves it");
    // A HEAD request (a link preview) leaves it for the page's GET.
    let req = Request::head("/done").header(header::COOKIE, cookie.as_str()).body(Body::empty()).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert!(set(&res).is_empty(), "HEAD leaves it");
    // Also when it ends on the error page.
    let missing = cookie.replace(&key("/done"), &key("/missing"));
    let req = Request::head("/missing").header(header::COOKIE, missing).body(Body::empty()).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert!(set(&res).is_empty(), "HEAD to the error page leaves it");
    let req = Request::get("/missing")
        .header(header::COOKIE, cookie.replace(&key("/done"), &key("/missing")))
        .body(Body::empty())
        .unwrap();
    assert_eq!(set(&router.clone().oneshot(req).await.unwrap()), [gone], "the error page's GET reads it");
    // A navigation's page that does not draw it, or holds it in the layout around `<main>`, which
    // a navigation does not run: the runtime gets it. A full load draws it in the layout.
    let routes = Router::new().route("/done", get(|req: Req| async move { req.test_page("Done", "done") })).route(
        "/done/in-layout",
        get(|req: Req| async move {
            let notice = req.notice();
            req.page::<ForOne>(html! {
                <html>
                    <head>
                        <title>"Done"</title>
                        <Corten />
                    </head>
                    <body>
                        <p id="toast">{notice}</p>
                        <main>"done"</main>
                    </body>
                </html>
            })
        }),
    );
    let layouts = app(routes, None);
    for (path, mode) in [("/done", Some("nav")), ("/done/in-layout", Some("nav")), ("/done/in-layout", None)] {
        let cookie = cookie.replace(&key("/done"), &key(path));
        let mut req = Request::get(path).header(header::COOKIE, cookie);
        if let Some(mode) = mode {
            req = req.header("corten", mode);
        }
        let res = layouts.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(set(&res), [gone], "{path} {mode:?}");
        let header = res.headers().get("corten-notice").map(|v| v.to_str().unwrap().to_string());
        let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        if mode.is_some() {
            assert_eq!(header.as_deref(), Some("m=Batch+3517+deleted%3B+2+left."), "{path}");
            assert!(!body.contains("Batch 3517"), "{body}");
        } else {
            assert_eq!(header.as_deref(), Some("m=Batch+3517+deleted%3B+2+left.&d"), "drawn in the layout");
            assert!(body.contains(r#"<p id="toast">Batch 3517 deleted; 2 left.</p>"#), "{body}");
        }
    }
    // Cut at 500 bytes, at a character's end.
    let res = router.clone().oneshot(Request::get("/long").body(Body::empty()).unwrap()).await.unwrap();
    let value = set(&res)[0].clone();
    let value = value.split_once('=').unwrap().1.split(';').next().unwrap();
    let text: String = form_urlencoded::parse(value.as_bytes()).find(|(k, _)| k == "m").unwrap().1.into_owned();
    assert_eq!(text, "é".repeat(250));
}

/// The notice a page drew, sent back by the runtime as that page reads itself again: `req.notice()`
/// answers it for that `GET` from the page's own origin (so the read draws the page as it was),
/// the answer removes no cookie, says it drew it, and varies by it. Another site's request and a
/// text past the longest notice are not taken for it, and a notice cookie for the page wins.
#[tokio::test]
async fn a_notice_sent_back_on_a_read_again_is_drawn_again() {
    let page = |req: Req| async move {
        let notice = req.notice();
        req.test_page("Done", html! { <p>{notice}</p> })
    };
    let routes = Router::new().route("/done", get(page).post(page)).route("/other", get(page));
    let router = app(routes, None);
    let at = |method: &str, path: &str, notice: &str, site: Option<&'static str>, cookie: Option<String>| {
        let mut req = Request::builder().method(method).uri(path).header("corten-notice", notice);
        if let Some(site) = site {
            req = req.header("sec-fetch-site", site);
        }
        if let Some(cookie) = cookie {
            req = req.header(header::COOKIE, cookie);
        }
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };
    let read = |notice: &str, site, cookie| at("GET", "/done", notice, site, cookie);
    let body =
        |res: Response| async move { String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap() };
    for site in [Some("same-origin"), None] {
        let res = read("p=%2Fdone&m=Saved+%3Cb%3E", site, None).await.unwrap();
        assert!(res.headers().get_all(header::SET_COOKIE).iter().next().is_none(), "{site:?}");
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache");
        assert_eq!(res.headers()[header::VARY], "corten, accept, corten-notice");
        assert_eq!(res.headers()["corten-notice"], "m=Saved+%3Cb%3E&d");
        assert!(body(res).await.contains("<p>Saved &lt;b&gt;</p>"), "{site:?}");
    }
    for site in ["cross-site", "same-site", "none"] {
        let res = read("p=%2Fdone&m=Saved", Some(site), None).await.unwrap();
        assert!(res.headers().get("corten-notice").is_none(), "{site}");
        assert!(body(res).await.contains("<p></p>"), "{site}");
    }
    let long = format!("p=%2Fdone&m={}", "a".repeat(501));
    let res = read(&long, Some("same-origin"), None).await.unwrap();
    assert!(res.headers().get("corten-notice").is_none(), "past the longest notice");
    // For another page (a read again the server redirected there, `fetch` keeping the header), with
    // no path, or on a request that is not a `GET`, it is not the page's.
    for (method, path, notice) in [
        ("GET", "/other", "p=%2Fdone&m=Saved"),
        ("GET", "/done", "m=Saved"),
        ("POST", "/done", "p=%2Fdone&m=Saved"),
        ("HEAD", "/done", "p=%2Fdone&m=Saved"),
    ] {
        let res = at(method, path, notice, Some("same-origin"), None).await.unwrap();
        assert!(res.headers().get("corten-notice").is_none(), "{method} {path} {notice}");
        assert_eq!(res.headers()[header::VARY], "corten, accept", "{method} {path} {notice}");
    }
    // The path as the browser escapes it names the same page.
    let routes = Router::new().route("/items/{id}", get(page));
    let res = app(routes, None)
        .oneshot(
            Request::get("/items/a%20b")
                .header("corten-notice", "p=%2Fitems%2Fa%2520b&m=Saved")
                .header("sec-fetch-site", "same-origin")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.headers()["corten-notice"], "m=Saved&d");
    // The page's own cookie wins, and is removed as it is read.
    let cookie = format!("__Host-corten-notice=p={}&m=Deleted.", crate::page::path_key("/done"));
    let res = read("p=%2Fdone&m=Saved", Some("same-origin"), Some(cookie)).await.unwrap();
    assert_eq!(res.headers()["corten-notice"], "m=Deleted.&d");
    assert_eq!(res.headers()[header::VARY], "corten, accept");
    assert_eq!(res.headers().get_all(header::SET_COOKIE).iter().count(), 1);
}

/// Which origins a browser refuses a `Secure` cookie from: plain `http://` but for loopback.
#[test]
fn a_plain_origin_is_http_off_loopback() {
    let with = |origin: &str, host: &str, fetch_site: Option<&'static str>| {
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(site) = fetch_site {
            headers.insert("sec-fetch-site", HeaderValue::from_static(site));
        }
        crate::page::plain_origin(&headers)
    };
    let plain = |origin: &str| with(origin, origin.split_once("://").map_or("", |(_, host)| host), None);
    for origin in
        ["http://automation.lan:3001", "http://192.168.1.5", "http://localhost.lan", "http://[fe80::1]:80", "http://10.0.0.127"]
    {
        assert!(plain(origin), "{origin}");
    }
    for origin in [
        "https://automation.lan",
        "http://localhost",
        "http://localhost.:3000",
        "http://LOCALHOST:3000",
        "http://app.localhost:3000",
        "http://127.0.0.2:8080",
        "http://[::1]:3000",
        "http://[::1]",
        "null",
    ] {
        assert!(!plain(origin), "{origin}");
    }
    assert!(!crate::page::plain_origin(&HeaderMap::new()), "no Origin: not a browser's write");
    // A browser that counts the origin as secure (a policy for an internal tool) sends
    // `Sec-Fetch-Site`, takes a `Secure` cookie and is not read the plain one.
    assert!(!with("http://automation.lan:3001", "automation.lan:3001", Some("same-origin")));
    // Another origin's write (`Policy::allow_origin`): the response is this host's, not that one's.
    assert!(!with("http://admin.lan", "automation.lan:3001", None));
}

/// A write from a plain `http://` origin on the LAN, which a browser does not count as secure and so
/// refuses a `Secure` (and `__Host-`) cookie from, gets its notice in a plain `corten-notice`
/// cookie; the page reads that one only from a request without `Sec-Fetch-Site` (which a browser
/// sends to every secure origin, so on HTTPS another site on the domain cannot plant one) and
/// removes it as it was set.
#[tokio::test]
async fn a_notice_written_over_plain_http_on_the_lan_reaches_its_page() {
    let routes =
        Router::new().route("/", axum::routing::post(|req: Req| async move { req.redirect_with_notice(&Done, "Saved.") })).route(
            "/done",
            get(|req: Req| async move {
                let notice = req.notice();
                req.test_page("Done", html! { <p>{notice}</p> })
            }),
        );
    let router = app(routes, None);
    let set = |res: &Response| {
        res.headers().get_all(header::SET_COOKIE).iter().map(|c| c.to_str().unwrap().to_string()).collect::<Vec<_>>()
    };
    let value = format!("p={}&m=Saved.", crate::page::path_key("/done"));
    let write = |origin: &str, host: &str| {
        let req = Request::post("/").header("origin", origin).header("host", host);
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };
    let res = write("http://192.168.1.5:3001", "192.168.1.5:3001").await.unwrap();
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    assert_eq!(set(&res), [format!("corten-notice={value}; Path=/; SameSite=Lax; Max-Age=60; HttpOnly")]);
    // A secure origin, loopback over plain `http://` included, keeps the `__Host-` cookie.
    for (origin, host) in [
        ("https://192.168.1.5", "192.168.1.5"),
        ("http://localhost:3000", "localhost:3000"),
        ("http://127.0.0.1:3000", "127.0.0.1:3000"),
    ] {
        let res = write(origin, host).await.unwrap();
        assert_eq!(
            set(&res),
            [format!("__Host-corten-notice={value}; Path=/; SameSite=Lax; Max-Age=60; HttpOnly; Secure")],
            "{origin}"
        );
    }
    let read = |cookie: &str, secure: bool| {
        let mut req = Request::get("/done").header(header::COOKIE, cookie);
        if secure {
            req = req.header("sec-fetch-site", "same-origin");
        }
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };
    let plain = format!("a=1; corten-notice={value}");
    let res = read(&plain, false).await.unwrap();
    assert_eq!(set(&res), ["corten-notice=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly"]);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache");
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(body.contains("<p>Saved.</p>"), "{body}");
    // From a secure origin the plain cookie is not the app's: another site on the domain could
    // have set it. It is neither shown nor removed.
    let res = read(&plain, true).await.unwrap();
    assert!(set(&res).is_empty());
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(body.contains("<p></p>"), "{body}");
    // With both, the `__Host-` one is the notice, and both go.
    let both = format!("corten-notice=p={}&m=Planted.; __Host-corten-notice={value}", crate::page::path_key("/done"));
    let res = read(&both, false).await.unwrap();
    assert_eq!(
        set(&res),
        [
            "__Host-corten-notice=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure",
            "corten-notice=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly"
        ]
    );
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(body.contains("<p>Saved.</p>"), "{body}");
    // A HEAD request leaves it for the GET.
    let req = Request::head("/done").header(header::COOKIE, plain.as_str()).body(Body::empty()).unwrap();
    assert!(set(&router.clone().oneshot(req).await.unwrap()).is_empty(), "HEAD leaves it");
    // A write that `Sec-Fetch-Site` says comes from a secure page keeps `__Host-`.
    let req = Request::post("/")
        .header("origin", "http://192.168.1.5")
        .header("host", "192.168.1.5")
        .header("sec-fetch-site", "same-origin");
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    assert!(set(&res)[0].starts_with("__Host-corten-notice="), "{:?}", set(&res));
    // An app that says it is HTTPS only (`Policy::hsts`) never sets nor reads the plain one.
    let routes =
        Router::new().route("/", axum::routing::post(|req: Req| async move { req.redirect_with_notice(&Done, "Saved.") })).route(
            "/done",
            get(|req: Req| async move {
                let notice = req.notice();
                req.test_page("Done", html! { <p>{notice}</p> })
            }),
        );
    let https = App::new(Routes::from(routes)).policy(crate::security::Policy::new().hsts()).router();
    let req = Request::post("/").header("origin", "http://192.168.1.5").header("host", "192.168.1.5");
    let res = https.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    assert!(set(&res)[0].starts_with("__Host-corten-notice="), "{:?}", set(&res));
    let req = Request::get("/done").header(header::COOKIE, plain.as_str()).body(Body::empty()).unwrap();
    let res = https.clone().oneshot(req).await.unwrap();
    assert!(set(&res).is_empty(), "{:?}", set(&res));
}

/// A `Public` page that reads a notice from the plain cookie is sent private, as for the
/// `__Host-` one: the removal is Corten's, not a cookie the app set by mistake.
#[tokio::test]
async fn a_public_page_reading_a_plain_notice_is_private() {
    let minute = std::time::Duration::from_secs(60);
    let routes = Router::new().route(
        "/done",
        get(move |req: Req| async move {
            let notice = req.notice();
            Public::new(minute, req.test_page_for("Done", html! { <p>{notice}</p> }))
        }),
    );
    let router = app(routes, None);
    for cookie in ["corten-notice", "__Host-corten-notice"] {
        let value = format!("{cookie}=p={}&m=Saved.", crate::page::path_key("/done"));
        let req = Request::get("/done").header(header::COOKIE, value).body(Body::empty()).unwrap();
        let res = router.clone().oneshot(req).await.unwrap();
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache", "{cookie}");
        assert_eq!(res.headers().get_all(header::SET_COOKIE).iter().count(), 1, "{cookie}");
    }
}

/// Bytes as the app names their type: private by default, and a year in any cache when the URL
/// names the content (`Public::immutable`), cookies or not, unless a caller was read.
#[tokio::test]
async fn media_is_sent_as_its_type_and_kept_only_when_its_url_names_its_content() {
    let png: &'static [u8] = b"\x89PNG\r\n\x1a\n";
    let routes = Router::new()
        .route("/fresh", get(move || async move { crate::Media::new("image/png", png) }))
        .route("/kept", get(move || async move { Public::immutable(crate::Media::new("image/png", png)) }))
        .route("/gone", get(|| async { Public::immutable(Err::<crate::Media, _>(Error::not_found())) }));
    let router = app(routes, None);
    let res = router.clone().oneshot(Request::get("/kept").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    assert_eq!(res.into_body().collect().await.unwrap().to_bytes(), png);
    assert_eq!(cache_control(&router, "/fresh", &[]).await, "private, no-cache");
    assert_eq!(cache_control(&router, "/kept", &[]).await, "public, max-age=31536000, immutable");
    let res =
        router.clone().oneshot(Request::get("/kept").header("cookie", "session=1").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
    assert!(
        res.headers().get(header::VARY).is_none_or(|vary| !vary.to_str().unwrap().contains("cookie")),
        "the URL alone says what it is"
    );
    assert_eq!(cache_control(&router, "/gone", &[]).await, "private, no-cache", "a failure is never kept");
}

/// A download names its file on a private answer, and is compressed as any text is; a public
/// one keeps the name too.
#[tokio::test]
async fn a_download_names_its_file_and_stays_private() {
    let csv = "id,name\n7,Pikachu\n".repeat(200);
    let routes = Router::new()
        .route("/export", get(move || async move { crate::Media::new("text/csv", csv).attachment("Pokémon.csv") }))
        .route(
            "/slip",
            get(move || async move {
                Public::immutable(crate::Media::new("application/pdf", &b"%PDF-1.7"[..]).attachment("x").inline("slip.pdf"))
            }),
        );
    let router = app(routes, None);
    let res = router
        .clone()
        .oneshot(Request::get("/export").header("accept-encoding", "gzip").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        res.headers()[header::CONTENT_DISPOSITION],
        "attachment; filename=\"Pok_mon.csv\"; filename*=UTF-8''Pok%C3%A9mon.csv"
    );
    assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache");
    #[cfg(feature = "compress")]
    assert_eq!(res.headers()[header::CONTENT_ENCODING], "gzip");
    let res = router.oneshot(Request::get("/slip").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.headers()[header::CONTENT_DISPOSITION], "inline; filename=\"slip.pdf\"", "the last one given");
    assert_eq!(res.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
}

#[tokio::test]
async fn what_the_app_renders_is_private_unless_it_says_otherwise() {
    let router = app(cached_routes(), None);
    assert_eq!(cache_control(&router, "/plain", &[]).await, "private, no-cache");
    assert_eq!(cache_control(&router, "/plain", &[("corten", "nav")]).await, "private, no-cache");
    assert_eq!(cache_control(&router, "/missing", &[]).await, "private, no-cache", "error pages too");
    assert_eq!(cache_control(&router, "/missing", &[("accept", "application/json")]).await, "private, no-cache");
    assert_eq!(cache_control(&router, runtime_path(), &[]).await, "public, max-age=31536000, immutable");
    assert_eq!(cache_control(&router, "/health/ready", &[]).await, "no-store", "Corten's own routes keep theirs");
    assert_eq!(cache_control(&router, "/statement", &[("cookie", "s=1")]).await, "no-store");
}

/// `NoStore` holds for a failure too: the error page that replaces it is not kept either.
#[tokio::test]
async fn a_failure_under_no_store_is_not_stored() {
    let router = app(cached_routes(), None);
    for (path, status) in [("/code", StatusCode::BAD_REQUEST), ("/statement/other", StatusCode::NOT_FOUND)] {
        for extra in [&[][..], &[("accept", "text/html")], &[("corten", "nav")], &[("accept", "application/json")]] {
            let mut req = Request::get(path);
            for (name, value) in extra {
                req = req.header(*name, *value);
            }
            let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(res.status(), status, "{path} {extra:?}");
            assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store", "{path} {extra:?}");
        }
    }
    // A form sent to the expired code: the runtime's action, answered with the error page.
    let req = Request::post("/code").header("sec-fetch-site", "same-origin").header("corten", "action");
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store", "an action");
    // A header written by hand counts on any of its lines; the error page is `no-store` alone,
    // since the failure's other directives described its own answer.
    let res =
        router.clone().oneshot(Request::get("/lines").header("accept", "text/html").body(Body::empty()).unwrap()).await.unwrap();
    let lines: Vec<_> = res.headers().get_all(header::CACHE_CONTROL).iter().map(|v| v.to_str().unwrap().to_string()).collect();
    assert_eq!(lines, ["no-store"]);
    // Also when the error page read a caller.
    let res = app(cached_routes(), Some("ann"))
        .oneshot(Request::get("/lines").header("accept", "text/html").header("cookie", "s=1").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let lines: Vec<_> = res.headers().get_all(header::CACHE_CONTROL).iter().map(|v| v.to_str().unwrap().to_string()).collect();
    assert_eq!(lines, ["no-store"], "with a caller");
    // A line that is not text still counts.
    let res =
        router.clone().oneshot(Request::get("/odd").header("accept", "text/html").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
}

async fn slips(crate::Params(at): crate::Params<no_store_url::Slips<'_>>) -> HtmlResult {
    let kept = at.id.parse::<u32>().map_err(|_| Error::status(StatusCode::BAD_REQUEST))?;
    Ok(crate::answer::HtmlResponse::new(axum::response::IntoResponse::into_response(format!("slips {kept}"))))
}

async fn my_slips(Caller(viewer): Caller<Viewer>) -> HtmlResult {
    Ok(crate::answer::HtmlResponse::new(axum::response::IntoResponse::into_response(format!("slips of {}", viewer.0))))
}

async fn void_slip(Caller(_): Caller<Viewer>) -> HtmlResult {
    Err(Error::status(StatusCode::CONFLICT))
}

#[cfg(feature = "json")]
async fn slip_due(crate::Params(at): crate::Params<no_store_json_url::Due>) -> JsonResult<u32> {
    Ok(Json(at.id))
}

/// A JSON route that says `no_store`: its failures go through the API's `problem+json`.
#[cfg(feature = "json")]
#[crate::routes]
mod no_store_json_url {
    #[route("/slips/{id}/due", get = slip_due, no_store)]
    pub struct Due {
        pub id: u32,
    }
}

/// A JSON route that says `no_store` keeps its answer and a request a path refuses out of caches.
#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_route_that_says_no_store_keeps_its_refusals_out_of_caches() {
    let router = App::new(no_store_json_url::router()).router();
    for (path, status, kind) in [
        ("/slips/7/due", StatusCode::OK, "application/json"),
        ("/slips/x/due", StatusCode::BAD_REQUEST, "application/problem+json"),
    ] {
        let res = router.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), status, "{path}");
        assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store", "{path}");
        assert!(res.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with(kind), "{path}: {:?}", res.headers());
    }
}

async fn slip_total(crate::Params(at): crate::Params<no_store_url::Total>) -> HtmlResult {
    Ok(crate::answer::HtmlResponse::new(axum::response::IntoResponse::into_response(format!("total {}", at.id))))
}

#[crate::routes]
mod no_store_url {
    #[route("/slips/{id}", get = slips, no_store)]
    pub struct Slips<'a> {
        pub id: &'a str,
    }

    #[route("/my/slips", get = my_slips, post = void_slip, no_store)]
    pub struct MySlips;

    #[route("/slips/{id}/total", get = slip_total, no_store)]
    pub struct Total {
        pub id: u32,
    }

    #[route("/my/key", get = my_slips, post = rotate_key, no_store(post))]
    pub struct MyKey;
}

async fn rotate_key(Caller(viewer): Caller<Viewer>) -> HtmlResult {
    Ok(crate::answer::HtmlResponse::new(axum::response::IntoResponse::into_response(format!("new key of {}", viewer.0))))
}

/// `no_store(post)`: only the write's answer, and a write its extractors refuse, are `no-store`; the
/// page is as any page that reads a caller (#844).
#[tokio::test]
async fn no_store_on_one_method_covers_only_that_handler() {
    let router = App::new(no_store_url::router()).router();
    // A refusal on the method not named keeps the default too: the store down, no one signed in.
    for (method, viewer, status, kept) in [
        ("GET", Some("ann"), StatusCode::OK, false),
        ("GET", Some("down"), StatusCode::SERVICE_UNAVAILABLE, false),
        ("GET", None, StatusCode::SEE_OTHER, false),
        ("HEAD", Some("ann"), StatusCode::OK, false),
        ("POST", Some("ann"), StatusCode::OK, true),
        ("POST", Some("down"), StatusCode::SERVICE_UNAVAILABLE, true),
    ] {
        let mut req = Request::builder().method(method).uri("/my/key").header("accept", "text/html");
        if method == "POST" {
            req = req.header("sec-fetch-site", "same-origin").header("corten", "action");
        }
        if let Some(viewer) = viewer {
            req = req.header("viewer", viewer);
        }
        let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), status, "{method} {viewer:?}");
        let cache = res.headers()[header::CACHE_CONTROL].to_str().unwrap().to_owned();
        if kept {
            assert_eq!(cache, "no-store", "{method} {viewer:?}");
        } else {
            assert_eq!(cache, "private, no-cache", "{method} {viewer:?}");
        }
    }
}

/// `no_store` on a route: the handler keeps its `?`, and its page, its failure and a request its
/// extractors refuse are `no-store`, in every mode.
#[tokio::test]
async fn a_route_that_says_no_store_keeps_its_answers_and_failures_out_of_caches() {
    let router = App::new(no_store_url::router()).router();
    for (path, status) in [("/slips/7", StatusCode::OK), ("/slips/x", StatusCode::BAD_REQUEST)] {
        for extra in [&[][..], &[("accept", "text/html")], &[("corten", "nav")]] {
            let mut req = Request::get(path);
            for (name, value) in extra {
                req = req.header(*name, *value);
            }
            let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(res.status(), status, "{path} {extra:?}");
            assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store", "{path} {extra:?}");
        }
    }
    // A request its extractors refuse is `no-store` too, which `NoStore<..>` cannot reach: a caller
    // who is not signed in, a session store that is down, a path that does not parse.
    let cases: [(&str, &str, Option<&str>); 7] = [
        ("GET", "/my/slips", Some("ann")),
        ("GET", "/my/slips", Some("down")),
        ("GET", "/my/slips", None),
        ("POST", "/my/slips", Some("ann")),
        ("POST", "/my/slips", Some("down")),
        ("GET", "/slips/7/total", None),
        ("GET", "/slips/x/total", None),
    ];
    for (method, path, viewer) in cases {
        for extra in [&[][..], &[("accept", "text/html")], &[("corten", "nav")], &[("accept", "application/json")]] {
            // A write is the runtime's action, not a navigation.
            if method == "POST" && extra.iter().any(|(name, _)| *name == "corten") {
                continue;
            }
            let mut req = Request::builder().method(method).uri(path);
            for (name, value) in extra {
                req = req.header(*name, *value);
            }
            if method == "POST" {
                req = req.header("sec-fetch-site", "same-origin").header("corten", "action");
            }
            if let Some(viewer) = viewer {
                req = req.header("viewer", viewer);
            }
            let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let status = res.status();
            let expected = match (path, viewer) {
                ("/slips/x/total", _) => status == StatusCode::BAD_REQUEST,
                (_, Some("down")) => status == StatusCode::SERVICE_UNAVAILABLE,
                (_, None) if path == "/my/slips" => status.is_redirection() || status == StatusCode::UNAUTHORIZED,
                _ if method == "POST" => status == StatusCode::CONFLICT,
                _ => status == StatusCode::OK,
            };
            assert!(expected, "{method} {path} {viewer:?} {extra:?}: {status}");
            assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store", "{method} {path} {viewer:?} {extra:?}");
        }
    }
}

/// A `Cache-Control` whose `private` or `no-store` is not a plain directive (in a quoted value, a
/// line that is not text, `no-store=1`, with `must-understand`) is not trusted: an answer that sets
/// a cookie or read a caller goes out `private, no-cache`, or `no-store` when any reader could find
/// one in its header. A plain `no-store` or `private` is trusted as written only on one line of
/// plain text with no quoted value: otherwise a `no-store` goes out on one line (`no-store` alone
/// beside a quoted value or a byte that is not text), so a cache that reads only one line, or a
/// value another way, is told the same. `must-understand, no-store` on an answer nothing makes
/// personal is left as written, and a `private` beside them is not trusted.
#[tokio::test]
async fn a_cache_control_counts_only_for_what_it_plainly_says() {
    let router = Router::new()
        .route(
            "/valued",
            get(|| async {
                let line = [(header::CACHE_CONTROL, "public, max-age=600, no-store=1")];
                (StatusCode::BAD_REQUEST, line, "")
            }),
        )
        .route(
            "/second-line",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "public, max-age=600"), (header::CACHE_CONTROL, "no-store")];
                (axum::response::AppendHeaders(lines), "second")
            }),
        )
        .route(
            "/odd-line",
            get(|| async {
                let odd = HeaderValue::from_bytes(b"x=\"\xE9\"").unwrap();
                let lines = [
                    (header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=600")),
                    (header::CACHE_CONTROL, odd),
                    (header::SET_COOKIE, HeaderValue::from_static("seen=1")),
                ];
                (axum::response::AppendHeaders(lines), "odd")
            }),
        )
        .route(
            "/quoted",
            get(|| async {
                let lines =
                    [(header::CACHE_CONTROL, "public, max-age=600, no-cache=\"a, no-store, b\""), (header::SET_COOKIE, "seen=1")];
                (axum::response::AppendHeaders(lines), "quoted")
            }),
        )
        .route(
            "/quoted-failure",
            get(|| async {
                let line = [(header::CACHE_CONTROL, "public, max-age=600, no-cache=\"a, no-store, b\"")];
                (StatusCode::BAD_REQUEST, line, "")
            }),
        )
        .route(
            "/escaped",
            get(|| async {
                let lines = [
                    (header::CACHE_CONTROL, "public, max-age=600, no-cache=\"a\\\", no-store, b\""),
                    (header::SET_COOKIE, "seen=1"),
                ];
                (axum::response::AppendHeaders(lines), "escaped")
            }),
        )
        .route(
            "/private-then-no-store",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "private, max-age=600"), (header::CACHE_CONTROL, "no-store")];
                (axum::response::AppendHeaders(lines), "both")
            }),
        )
        .route(
            "/later-private",
            get(|| async {
                let lines = [
                    (header::CACHE_CONTROL, "public, max-age=600"),
                    (header::CACHE_CONTROL, "private"),
                    (header::SET_COOKIE, "seen=1"),
                ];
                (axum::response::AppendHeaders(lines), "later")
            }),
        )
        .route(
            "/private-then-public",
            get(|| async {
                let lines = [
                    (header::CACHE_CONTROL, "private, max-age=600"),
                    (header::CACHE_CONTROL, "public, s-maxage=600"),
                    (header::SET_COOKIE, "seen=1"),
                ];
                (axum::response::AppendHeaders(lines), "both")
            }),
        )
        .route(
            "/no-store-and-more",
            get(|| async {
                let line = [(header::CACHE_CONTROL, "public, s-maxage=600, x=\"\\\"\", no-store")];
                (axum::response::AppendHeaders(line), "more")
            }),
        )
        .route(
            "/private-and-quoted",
            get(|| async {
                let lines =
                    [(header::CACHE_CONTROL, "public, s-maxage=600, x=\"\\\"\", private"), (header::SET_COOKIE, "seen=1")];
                (axum::response::AppendHeaders(lines), "quoted")
            }),
        )
        .route(
            "/must-understand",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "must-understand, no-store"), (header::SET_COOKIE, "seen=1")];
                (axum::response::AppendHeaders(lines), "kept by a cache that knows a 200")
            }),
        )
        .route(
            "/must-understand-shared",
            get(|| async {
                let line = [(header::CACHE_CONTROL, "max-age=60, must-understand, no-store")];
                (axum::response::AppendHeaders(line), "kept only by a cache that knows a 200")
            }),
        )
        .route(
            "/must-understand-valued",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "no-store, must-understand=1, max-age=600"), (header::SET_COOKIE, "seen=1")];
                (axum::response::AppendHeaders(lines), "valued")
            }),
        )
        .route(
            "/private-must-understand",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "private, no-store, must-understand"), (header::SET_COOKIE, "seen=1")];
                (axum::response::AppendHeaders(lines), "private")
            }),
        )
        .route(
            "/private-valued-must-understand",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "private, no-store=1, must-understand"), (header::SET_COOKIE, "seen=1")];
                (axum::response::AppendHeaders(lines), "private")
            }),
        )
        .route(
            "/upper-valued",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "public, max-age=600, No-Store=1"), (header::SET_COOKIE, "seen=1")];
                (axum::response::AppendHeaders(lines), "upper")
            }),
        )
        .route(
            "/must-understand-failure",
            get(|| async {
                let line = [(header::CACHE_CONTROL, "must-understand, no-store")];
                (StatusCode::BAD_REQUEST, line, "")
            }),
        )
        .route(
            "/not-text-no-store",
            get(|| async {
                let odd = HeaderValue::from_bytes(b"public, max-age=600, no-store, x=\xE9").unwrap();
                let lines = [(header::CACHE_CONTROL, odd), (header::SET_COOKIE, HeaderValue::from_static("seen=1"))];
                (axum::response::AppendHeaders(lines), "odd")
            }),
        )
        .route(
            "/not-text-private",
            get(|| async {
                let odd = HeaderValue::from_bytes(b"public, s-maxage=600, private, x=\xE9").unwrap();
                let lines = [(header::CACHE_CONTROL, odd), (header::SET_COOKIE, HeaderValue::from_static("seen=1"))];
                (axum::response::AppendHeaders(lines), "odd")
            }),
        )
        .route(
            "/unquoted-limited",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "public, max-age=600, private=set-cookie"), (header::SET_COOKIE, "seen=1")];
                (axum::response::AppendHeaders(lines), "limited")
            }),
        )
        .route(
            "/no-transform",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "no-transform"), (header::CACHE_CONTROL, "no-store")];
                (axum::response::AppendHeaders(lines), "both")
            }),
        )
        .route(
            "/limited-first",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "private=\"set-cookie\", max-age=600"), (header::SET_COOKIE, "seen=1")];
                (axum::response::AppendHeaders(lines), "limited")
            }),
        );
    let router = app(router, Some("ann"));
    for (path, want) in [
        ("/odd-line", "private, no-cache"),
        ("/quoted", "no-store"),
        ("/quoted-failure", "no-store"),
        ("/valued", "no-store"),
        ("/second-line", "public, max-age=600, no-store"),
        ("/escaped", "no-store"),
        ("/must-understand-shared", "max-age=60, must-understand, no-store"),
        ("/must-understand-valued", "no-store"),
        ("/private-must-understand", "no-store"),
        ("/private-valued-must-understand", "no-store"),
        ("/upper-valued", "no-store"),
        ("/private-then-no-store", "private, max-age=600, no-store"),
        ("/must-understand", "no-store"),
        ("/must-understand-failure", "no-store"),
        ("/not-text-no-store", "no-store"),
        ("/not-text-private", "private, no-cache"),
        ("/unquoted-limited", "private, no-cache"),
        ("/no-transform", "no-transform, no-store"),
        ("/later-private", "private, no-cache"),
        ("/private-then-public", "private, no-cache"),
        ("/no-store-and-more", "no-store"),
        ("/private-and-quoted", "private, no-cache"),
        ("/limited-first", "private, no-cache"),
    ] {
        let req = Request::get(path).header("accept", "text/html").header("cookie", "s=1");
        let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let lines: Vec<_> = res.headers().get_all(header::CACHE_CONTROL).iter().map(|v| v.as_bytes().to_vec()).collect();
        assert_eq!(lines, [want.as_bytes().to_vec()], "{path}");
    }
}

/// `private="set-cookie"` limits only that header: a shared cache may still keep the rest, so it
/// does not stand for a plain `private` on an answer that sets a cookie.
#[tokio::test]
async fn a_limited_private_is_not_private() {
    let res = app(cached_routes(), None).oneshot(Request::get("/limited").body(Body::empty()).unwrap()).await.unwrap();
    let lines: Vec<_> = res.headers().get_all(header::CACHE_CONTROL).iter().map(|v| v.to_str().unwrap().to_string()).collect();
    assert_eq!(lines, ["private, no-cache"]);
}

#[tokio::test]
async fn a_public_page_is_shared_only_when_nothing_makes_it_personal() {
    let router = app(cached_routes(), None);
    assert_eq!(cache_control(&router, "/", &[]).await, "public, max-age=60");
    assert_eq!(cache_control(&router, "/", &[("accept", "text/html,*/*")]).await, "public, max-age=60");
    for personal in [("cookie", "session=abc"), ("authorization", "Bearer t")] {
        assert_eq!(cache_control(&router, "/", &[personal]).await, "private, no-cache", "{personal:?}");
    }
    for partial in [("corten", "nav"), ("corten", "action"), ("accept", "application/json")] {
        assert_eq!(cache_control(&router, "/", &[partial]).await, "private, max-age=60", "only the document: {partial:?}");
    }
    assert_eq!(cache_control(&router, "/cookie", &[]).await, "private, no-cache", "it sets a cookie");
    assert_eq!(cache_control(&router, "/cookies", &[]).await, "private, no-cache", "it sets cookies");
    assert_eq!(cache_control(&router, "/text", &[]).await, "public, max-age=60", "a closure's Public");
    assert_eq!(cache_control(&router, "/page", &[]).await, "public, max-age=60", "a closure's Public page");
    assert_eq!(cache_control(&router, "/catalog", &[]).await, "public, max-age=60, s-maxage=86400");
    assert_eq!(cache_control(&router, "/catalog", &[("corten", "nav")]).await, "private, max-age=60", "the browser's lifetime");
    assert_eq!(cache_control(&router, "/catalog", &[("cookie", "session=abc")]).await, "private, no-cache");
    assert_eq!(cache_control(&router, "/archive", &[]).await, "public, max-age=60, stale-if-error=86400");
    assert_eq!(cache_control(&router, "/archive", &[("corten", "nav")]).await, "private, max-age=60, stale-if-error=86400");
    // App::client_zone's cookie says where the visitor is, not who: alone, it shares as before.
    assert_eq!(cache_control(&router, "/", &[("cookie", "corten-zone=America/Chicago")]).await, "public, max-age=60");
    assert_eq!(cache_control(&router, "/", &[("cookie", "corten-zone=America/Chicago; session=abc")]).await, "private, no-cache");
    let inline = App::new(Routes::from(Router::new().route("/", get(inline_page)))).router();
    assert_eq!(cache_control(&inline, "/", &[]).await, "private, no-cache", "the layout took the nonce");

    let minute = std::time::Duration::from_secs(60);
    let api = App::new(Routes::new())
        .api::<ApiRoot>(|api| {
            api.route::<ApiRates>(crate::Methods::reads(get(move || async move { (Cache::public(minute), "rates") })))
        })
        .router();
    assert_eq!(cache_control(&api, "/api/rates", &[("accept", "application/json")]).await, "public, max-age=60");
    assert_eq!(cache_control(&api, "/api/rates", &[("authorization", "Bearer t")]).await, "private, no-cache");
}

/// `App::client_zone` asks the runtime for the browser's time zone, and `Option<ClientZone>` reads
/// it: a name the browser could write, otherwise `None`. Taking it without the setting is a 500 in
/// a debug build.
#[tokio::test]
async fn a_handler_reads_the_visitors_time_zone_once_the_app_asks_for_it() {
    use crate::ClientZone;
    let routes = || {
        Routes::from(
            Router::new().route("/", get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) })).route(
                "/zone",
                get(|zone: Option<ClientZone>| async move { zone.map_or_else(|| "none".to_string(), |ClientZone(zone)| zone) }),
            )
            .route(
                "/zone-page",
                get(|req: Req, zone: Option<ClientZone>| async move { req.test_page("Zone", html! {
                    <p>{format!("{zone:?}")}</p>
                }) }),
            ),
        )
    };
    let get_with = |router: Router, uri: &'static str, cookie: Option<&'static str>| async move {
        let mut req = Request::get(uri);
        if let Some(cookie) = cookie {
            req = req.header("cookie", cookie);
        }
        let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let status = res.status();
        (status, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
    };
    let router = App::new(routes()).client_zone().router();
    // Reading the zone keeps the answer private but not out of the layout: the page around
    // `<main>` is the same, so the runtime swaps it in rather than loading it in full.
    let shell = |uri: &'static str| {
        let router = router.clone();
        async move {
            let req = Request::get(uri).header("corten", "nav").header("cookie", "corten-zone=America/Chicago");
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            (res.headers().get("corten-shell").cloned(), res.headers().get("cache-control").cloned())
        }
    };
    let (home, zoned) = (shell("/").await, shell("/zone-page").await);
    assert!(home.0.is_some() && home.0 == zoned.0, "same layout: {home:?} {zoned:?}");
    assert!(zoned.1.as_ref().is_some_and(|v| v.to_str().unwrap().contains("private")), "{zoned:?}");
    let (_, page) = get_with(router.clone(), "/", None).await;
    assert!(page.contains(r#"<meta name="corten-zone">"#), "the runtime is asked to keep it: {page}");
    assert_eq!(get_with(router.clone(), "/zone", None).await.1, "none", "before the runtime has run");
    for (cookie, zone) in [
        ("corten-zone=America/Chicago", "America/Chicago"),
        ("session=abc; corten-zone=Etc/GMT+5", "Etc/GMT+5"),
        ("corten-zone=America/Argentina/Buenos_Aires", "America/Argentina/Buenos_Aires"),
        ("corten-zone=<script>", "none"),
        ("corten-zone=../../etc/passwd", "none"),
        ("corten-zone=", "none"),
    ] {
        assert_eq!(get_with(router.clone(), "/zone", Some(cookie)).await.1, zone, "{cookie}");
    }

    let without = App::new(routes()).router();
    let (_, page) = get_with(without.clone(), "/", None).await;
    assert!(!page.contains("corten-zone"), "no cookie unless the app asks");
    let (status, body) = get_with(without, "/zone", Some("corten-zone=America/Chicago")).await;
    if cfg!(debug_assertions) {
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "a debug build names the missing App::client_zone()");
    } else {
        assert_eq!((status, body.as_str()), (StatusCode::OK, "none"), "a release build logs it and reads none");
    }
}

/// With the `zones` feature and `App::zoned_dates`, a date is written in the visitor's zone while
/// Corten renders the request's answer, which is then private; the first page, before the browser has reported its
/// zone, is in UTC and says so (`zone_unknown`); `.zone(..)` still chooses. `req.zone()` is the
/// zone with its rules.
#[cfg(feature = "zones")]
#[tokio::test]
async fn dates_are_written_in_the_visitors_zone_while_corten_renders_the_answer() {
    use crate::i18n::{DateStyle, Messages as _, TimeStyle, Utc, Zone as _};
    use std::time::{Duration, UNIX_EPOCH};
    crate::i18n::messages! { struct ZoneMsg { "en" => "src/i18n/en.json" } }
    // 2026-03-22T15:04:05Z: Chicago is on daylight time (UTC-5) since March 8.
    let at = UNIX_EPOCH + Duration::from_secs(1_774_191_845);
    let routes = move || {
        Routes::from(
            Router::new()
                .route(
                    "/",
                    get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let when = t.date_time(at, DateStyle::Medium, TimeStyle::Short);
                        // Asked while the answer renders, as LocalTime asks it.
                        req.test_page(
                            "Zone",
                            html! {
                                <p>{when}</p>
                                <p>{if when.zone_unknown() { "unknown" } else { "known" }}</p>
                                <p>{when.zone(Utc)}</p>
                            },
                        )
                    }),
                )
                // Rendered ahead, in the handler, before the answer renders.
                .route(
                    "/ahead",
                    get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let part = req.rendered(html! { <p>{t.date_time(at, DateStyle::Medium, TimeStyle::Short)}</p> });
                        let placed = &part;
                        req.test_page("Ahead", html! { {placed} })
                    }),
                )
                .route("/offset", get(move |req: Req| async move { req.zone().offset(at).to_string() }))
                // A calendar day: the same day in every zone (#502).
                .route(
                    "/day",
                    get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let day = crate::i18n::Day::new(2026, 3, 22).unwrap();
                        req.test_page("Day", html! { <p>{t.date(day, DateStyle::Medium)}</p> })
                    }),
                )
                // Shared by its own header: a date written for one visitor would make it private.
                .route(
                    "/shared",
                    get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let page =
                            req.test_page("Shared", html! { <p>{t.date_time(at, DateStyle::Medium, TimeStyle::Short)}</p> })?;
                        Ok::<_, Error>(([(axum::http::header::CACHE_CONTROL, "public, max-age=60")], page))
                    }),
                )
                // Through Corten's handler check, which knows the answer is `Public`.
                .route(
                    "/public",
                    crate::route::get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let when = t.date_time(at, DateStyle::Medium, TimeStyle::Short);
                        let offset = req.zone().offset(at);
                        let page = req.test_page_for(
                            "Shared",
                            html! {
                                <p>{when}</p>
                                <p>{if when.zone_unknown() { "unknown" } else { "known" }}</p>
                                <p>{offset}</p>
                            },
                        );
                        Public::new(std::time::Duration::from_secs(60), page)
                    })
                    .0,
                )
                .route(
                    "/public-live",
                    crate::route::get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let live = crate::live(futures_util::StreamExt::map(futures_util::stream::iter([()]), move |()| {
                            let when = t.date_time(at, DateStyle::Medium, TimeStyle::Short);
                            crate::Fragment::new(format!(r#"<p id="n">{when}</p>"#))
                        }));
                        Public::new(std::time::Duration::from_secs(60), live)
                    })
                    .0,
                )
                .route(
                    "/live",
                    get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        // Rendered as the stream is read, after the handler returned.
                        crate::live(futures_util::StreamExt::map(futures_util::stream::iter([()]), move |()| {
                            let when = t.date_time(at, DateStyle::Medium, TimeStyle::Short);
                            crate::Fragment::new(format!(r#"<p id="n">{when}</p>"#))
                        }))
                    }),
                ),
        )
    };
    let get_with = |router: Router, uri: &'static str, cookie: Option<&'static str>| async move {
        let mut req = Request::get(uri);
        if let Some(cookie) = cookie {
            req = req.header("cookie", cookie);
        }
        let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let cache = res.headers().get("cache-control").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
        (cache, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
    };
    let utc = "<p>Mar 22, 2026, 3:04 PM UTC</p>";
    let zoned = App::new(routes()).zoned_dates().router();
    let (cache, page) = get_with(zoned.clone(), "/", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains(&format!("<p>Mar 22, 2026, 10:04 AM GMT-5</p><p>known</p>{utc}")), "{page}");
    assert!(cache.contains("private"), "written for this visitor: {cache}");
    let (cache, page) = get_with(zoned.clone(), "/ahead", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains("<p>Mar 22, 2026, 10:04 AM GMT-5</p>") && cache.contains("private"), "rendered ahead: {cache} {page}");
    for cookie in [None, Some("corten-zone=Mars/Olympus")] {
        let (_, page) = get_with(zoned.clone(), "/", cookie).await;
        assert!(page.contains(&format!("{utc}<p>unknown</p>{utc}")), "{cookie:?}: {page}");
    }
    assert_eq!(get_with(zoned.clone(), "/offset", Some("corten-zone=America/Chicago")).await.1, "-18000");
    assert_eq!(get_with(zoned.clone(), "/offset", None).await.1, "0");
    for zone in ["corten-zone=America/Chicago", "corten-zone=Pacific/Kiritimati", "corten-zone=Pacific/Pago_Pago"] {
        let (_, page) = get_with(zoned.clone(), "/day", Some(zone)).await;
        assert!(page.contains("<p>Mar 22, 2026</p>"), "{zone}: {page}");
    }
    // A `Public` answer is the same for everyone: written as for a visitor whose zone is not
    // known (UTC, its LocalTimes written again in the browser), and it stays shared.
    let (cache, page) = get_with(zoned.clone(), "/public", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains(&format!("{utc}<p>unknown</p><p>0</p>")), "{page}");
    assert!(cache.starts_with("public"), "{cache}");
    // Its live part's fragments too, as the stream is read after the handler returned.
    let (cache, live) = get_with(zoned.clone(), "/public-live", Some("corten-zone=America/Chicago")).await;
    assert!(live.contains("3:04 PM UTC") && cache.starts_with("public"), "{cache}: {live}");
    // A middleware that builds a response of its own around the answer (no extensions kept)
    // cannot lose that it is `Public`: the request's signal holds it.
    struct Rebuild;
    impl crate::Middleware for Rebuild {
        async fn call(&self, req: axum::extract::Request, next: impl crate::Next) -> Response {
            let (parts, body) = next.run(req).await.into_parts();
            let mut res = Response::new(body);
            *res.status_mut() = parts.status;
            *res.headers_mut() = parts.headers;
            res
        }
    }
    let rebuilt = App::new(routes()).zoned_dates().middleware(Rebuild).router();
    for uri in ["/public", "/public-live"] {
        let (cache, page) = get_with(rebuilt.clone(), uri, Some("corten-zone=America/Chicago")).await;
        assert!(page.contains("3:04 PM UTC") && cache.starts_with("public"), "{uri}: {cache}: {page}");
    }
    // A live part's fragments are written in the zone, as its page was.
    let (_, live) = get_with(zoned, "/live", Some("corten-zone=America/Chicago")).await;
    assert!(live.contains("10:04 AM GMT-5"), "{live}");
    // A `Public` route's error page is not the same for everyone: written in the zone.
    async fn dated_error(_: Failure, req: Req) -> HtmlResult {
        let t: ZoneMsg = req.t();
        let at = UNIX_EPOCH + Duration::from_secs(1_774_191_845);
        req.test_page("Failed", html! { <p>{t.date_time(at, DateStyle::Medium, TimeStyle::Short)}</p> })
    }
    let failing = Routes::from(
        Router::new().route(
            "/public-fails",
            crate::route::get(|| async {
                Public::new(std::time::Duration::from_secs(60), Err::<&'static str, _>(Error::not_found()))
            })
            .0,
        ),
    );
    let failing = App::new(failing).zoned_dates().error_page(dated_error, ()).router();
    let (cache, page) = get_with(failing, "/public-fails", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains("10:04 AM GMT-5") && cache.contains("private"), "{cache}: {page}");
    // An app that does not learn zones writes UTC and knows it is meant to.
    let (plain, page) = get_with(App::new(routes()).router(), "/", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains(&format!("{utc}<p>known</p>{utc}")), "{page}");
    // Nor does one that learns them for `ClientZone` and `req.zone()` alone: the feature, which
    // another crate may turn on, does not change an app's dates; `zoned_dates` does.
    let learns = App::new(routes()).client_zone().router();
    let (cache, page) = get_with(learns.clone(), "/", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains(&format!("{utc}<p>known</p>{utc}")), "{page}");
    assert_eq!(cache, plain, "answered as the app that does not learn zones");
    let (_, page) = get_with(learns.clone(), "/", None).await;
    assert!(page.contains(&format!("{utc}<p>known</p>{utc}")), "no LocalTime script before the cookie: {page}");
    let (cache, page) = get_with(learns.clone(), "/shared", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains(utc) && cache.starts_with("public"), "{cache}: {page}");
    let (cache, page) = get_with(App::new(routes()).zoned_dates().router(), "/shared", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains("10:04 AM GMT-5") && cache.contains("private"), "{cache}: {page}");
    assert_eq!(get_with(learns, "/offset", Some("corten-zone=America/Chicago")).await.1, "-18000");
    // Outside a request's render: UTC.
    assert_eq!(
        ZoneMsg::for_locale("en").date_time(at, DateStyle::Medium, TimeStyle::Short).to_string(),
        "Mar 22, 2026, 3:04 PM UTC"
    );
}

#[tokio::test]
async fn only_a_swap_says_it_is_a_page_swap() {
    let (_, headers, _) = call(app(routes(), None), "GET", None).await;
    assert!(!headers.contains_key("corten-page"), "a document a cache hands to a navigation makes the runtime reload");
    let (_, headers, _) = call(app(routes(), None), "GET", Some("nav")).await;
    assert_eq!(headers["corten-page"], "1");
}

// ---- Callers: who is asking, read by the handlers that need it ----

std::thread_local! {
    /// How many handlers that write ran on this test's thread.
    static WROTE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Staff: someone signed in who may use the admin area.
#[derive(Clone, Hash, Debug)]
struct Staff(&'static str);

impl<S: Sync> crate::Identify<S> for Staff {
    async fn identify(parts: &axum::http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        let Caller(Viewer(name)) = Caller::<Viewer>::find(parts, state).await?;
        match name {
            "ada" | "bob" => Ok(Staff(name)),
            _ => Err(crate::Refused::forbidden()),
        }
    }
}

/// A partner, by its API key: there is nowhere to sign in.
#[derive(Clone, Hash, Debug)]
struct Partner(&'static str);

impl<S: Sync> crate::Identify<S> for Partner {
    async fn identify(parts: &axum::http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
        match parts.headers.get("x-api-key").map(|v| v.as_bytes()) {
            Some(b"k1") => Ok(Partner("acme")),
            _ => Err(crate::Refused::unauthorized()),
        }
    }
}

#[crate::routes]
mod caller_url {
    #[route("/", get = caller_home)]
    pub struct Home;

    #[route("/account", get = account, post = save_account)]
    pub struct Account;

    #[route("/sign-in", get = sign_in)]
    pub struct SignIn;

    #[route("/catalog/{id}", get = catalog)]
    pub struct Catalog {
        pub id: u32,
    }
}

/// Every route here takes `Caller<Staff>`, or the crate does not compile.
#[crate::routes(area = Admin, caller = Staff)]
mod admin_url {
    #[route("/admin", get = admin_home, post = admin_save)]
    pub struct Admin;

    #[route("/admin/users/{id}", get = admin_user)]
    pub struct User {
        pub id: u32,
    }
}

/// An area with no page at its prefix: `Docs` is only the prefix, with no `href`.
#[crate::routes(area = Docs)]
mod docs_url {
    #[route("/docs")]
    pub struct Docs;

    #[route("/docs/{page}", get = doc_page)]
    pub struct DocPage<'a> {
        pub page: &'a str,
    }
}

async fn doc_page(doc: crate::Params<docs_url::DocPage<'_>>) -> String {
    format!("doc {}", doc.page)
}

#[tokio::test]
async fn an_area_may_have_no_page_at_its_prefix() {
    use crate::Prefix;
    assert_eq!(docs_url::Docs::PREFIX, "/docs");
    let router = App::new(Routes::new()).area(docs_url::area).router();
    let (status, _, body) = call_with(router.clone(), "GET", &docs_url::DocPage { page: "intro" }.href(), None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "doc intro"));
    let (status, _, _) = call_with(router, "GET", "/docs", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "nothing is served at the prefix, and the app's 404 answers it");
}

async fn caller_home(req: Req) -> HtmlResult {
    req.test_page("Home", html! { <p>"home"</p> })
}

async fn account(req: Req, Caller(viewer): Caller<Viewer>) -> HtmlResult {
    req.test_page("Account", html! { <p>{viewer.0}</p> })
}

type Fields = crate::Form<std::collections::HashMap<String, String>>;

async fn save_account(Caller(_): Caller<Viewer>, crate::Form(_): Fields) -> &'static str {
    WROTE.with(|n| n.set(n.get() + 1));
    "saved"
}

async fn sign_in(req: Req) -> HtmlResult {
    req.test_page("Sign in", html! { <p>"sign in"</p> })
}

/// The same for everyone: it may read only what cannot tell who is asking.
async fn catalog(item: crate::Params<caller_url::Catalog>) -> Public<String> {
    Public::new(std::time::Duration::from_secs(60), format!("item {}", item.id))
}

async fn admin_home(req: Req, Caller(staff): Caller<Staff>) -> HtmlResult {
    req.test_page("Admin", html! { <p>"admin "{staff.0}</p> })
}

async fn admin_save(Caller(_): Caller<Staff>, crate::Form(_): Fields) -> &'static str {
    WROTE.with(|n| n.set(n.get() + 1));
    "saved"
}

async fn admin_user(user: crate::Params<admin_url::User>, Caller(_): Caller<Staff>) -> String {
    format!("user {}", user.id)
}

fn caller_app() -> Router {
    App::new(caller_url::router()).error_page(test_error_page, ()).area::<admin_url::Admin>(admin_url::area).router()
}

/// An auditor: another permission than the staff's, for one page in the admin area.
#[derive(Clone, Hash, Debug)]
struct Auditor;

impl<S: Sync> crate::Identify<S> for Auditor {
    async fn identify(parts: &axum::http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        let Viewer(name) = <Viewer as crate::Identify<S>>::identify(parts, state).await?;
        match name {
            "ada" | "carol" => Ok(Auditor),
            _ => Err(crate::Refused::forbidden()),
        }
    }
}

/// A page in the admin area that its own caller may use: a second module in the same area.
#[crate::routes(area = super::admin_url::Admin, caller = Auditor)]
mod audit_url {
    #[route("/admin/users/{id}/audit", get = user_audit)]
    pub struct UserAudit {
        pub id: u32,
    }
}

async fn user_audit(crate::Params(at): crate::Params<audit_url::UserAudit>, Caller(_): Caller<Auditor>) -> String {
    format!("audit {}", at.id)
}

/// Two modules in one area, each holding its handlers to its own caller: a staff member who is
/// not an auditor reads the user and not the audit, and an auditor who is not staff the other
/// way round.
#[tokio::test]
async fn an_area_takes_modules_with_callers_of_their_own() {
    let router = App::new(caller_url::router())
        .error_page(test_error_page, ())
        .area(|area| audit_url::area(admin_url::area(area)))
        .router();
    for (uri, viewer, want) in [
        ("/admin/users/7", "bob", StatusCode::OK),
        ("/admin/users/7/audit", "bob", StatusCode::FORBIDDEN),
        ("/admin/users/7", "carol", StatusCode::FORBIDDEN),
        ("/admin/users/7/audit", "carol", StatusCode::OK),
        ("/admin/users/7/audit", "ada", StatusCode::OK),
    ] {
        let (status, _, body) = guarded(&router, "GET", uri, Some(viewer), &[]).await;
        assert_eq!(status, want, "{uri} as {viewer}: {body}");
    }
}

async fn guarded(
    router: &Router,
    method: &str,
    uri: &str,
    viewer: Option<&str>,
    headers: &[(&str, &str)],
) -> (StatusCode, axum::http::HeaderMap, String) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(viewer) = viewer {
        req = req.header("viewer", viewer);
    }
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let body = if method == "POST" { Body::from("field=1") } else { Body::empty() };
    let req = req.header("content-type", "application/x-www-form-urlencoded").body(body).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (parts.status, parts.headers, String::from_utf8(bytes.to_vec()).unwrap())
}

#[tokio::test]
async fn a_missing_caller_sends_a_browser_to_sign_in_in_its_mode() {
    let router = caller_app();
    WROTE.with(|n| n.set(0));
    for (method, uri, headers) in [
        ("GET", "/account", &[][..]),
        ("GET", "/account", &[("corten", "nav")][..]),
        ("POST", "/account", &[][..]),
        ("GET", "/admin", &[][..]),
        ("POST", "/admin", &[][..]),
        ("GET", "/admin/users/7", &[][..]),
    ] {
        let (status, res, _) = guarded(&router, method, uri, None, headers).await;
        assert_eq!(
            (status, &res["location"]),
            (StatusCode::SEE_OTHER, &"/sign-in".parse().unwrap()),
            "{method} {uri} {headers:?}"
        );
        assert_eq!(res["cache-control"], "private, no-cache");
    }
    let (status, res, _) = guarded(&router, "POST", "/account", None, &[("corten", "action")]).await;
    assert_eq!((status, &res["corten-location"]), (StatusCode::NO_CONTENT, &"/sign-in".parse().unwrap()));
    let (status, res, body) = guarded(&router, "GET", "/account", None, &[("accept", "application/json")]).await;
    assert_eq!((status, &body[..]), (StatusCode::UNAUTHORIZED, r#"{"title":"Unauthorized","status":401}"#), "a data client");
    assert_eq!(res["content-type"], "application/problem+json");
    assert_eq!(WROTE.with(|n| n.get()), 0, "no handler ran, and no form was read");
    for uri in ["/", "/sign-in"] {
        let (status, _, _) = guarded(&router, "GET", uri, None, &[]).await;
        assert_eq!(status, StatusCode::OK, "{uri} reads no caller");
    }
}

#[tokio::test]
async fn a_refused_caller_gets_the_error_page_in_its_mode() {
    let router = caller_app();
    WROTE.with(|n| n.set(0));
    let (status, res, body) = guarded(&router, "GET", "/admin", Some("eve"), &[("accept", "text/html")]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(res["content-type"].to_str().unwrap().starts_with("text/html") && body.contains("Not allowed"), "{body}");
    let (status, res, _) = guarded(&router, "POST", "/admin", Some("eve"), &[("corten", "action")]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(res.contains_key("corten-page"), "a form patch gets the error page to swap in");
    let (status, _, body) = guarded(&router, "GET", "/admin", Some("eve"), &[("accept", "application/json")]).await;
    assert_eq!((status, &body[..]), (StatusCode::FORBIDDEN, r#"{"title":"Forbidden","status":403}"#));
    let (status, _, body) = guarded(&router, "GET", "/admin", Some("down"), &[("accept", "text/html")]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "who they are cannot be known now");
    assert!(!body.contains("session store"), "the message stays in the log: {body}");
    assert!(body.contains("Who you are cannot be checked"), "Failure::Unidentified, not a handler's 503: {body}");
    assert_eq!(WROTE.with(|n| n.get()), 0);
}

#[tokio::test]
async fn the_error_page_shows_who_is_asking() {
    let router = caller_app();
    let html = [("accept", "text/html")];
    LOOKUPS.with(|n| n.set(0));
    let (status, _, body) = guarded(&router, "GET", "/nope", None, &[("cookie", "viewer=ada"), html[0]]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body.contains("Signed in as ada"), "an unknown URL, drawn for who is asking: {body}");
    assert_eq!(LOOKUPS.with(|n| n.get()), 1, "looked up once, by the error page");
    let (status, _, body) = guarded(&router, "GET", "/nope", None, &[html[0]]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!body.contains("Signed in"), "no one: {body}");
    LOOKUPS.with(|n| n.set(0));
    let (status, _, body) = guarded(&router, "GET", "/admin", Some("eve"), &[("cookie", "viewer=eve"), html[0]]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains("Not allowed") && body.contains("Signed in as eve"), "a refusal, for who was refused: {body}");
    assert_eq!(LOOKUPS.with(|n| n.get()), 1, "the error page reads the viewer the refused handler's Staff found");
    // A lookup that failed (the store is down) is not tried again for the error page.
    LOOKUPS.with(|n| n.set(0));
    let (status, _, body) = guarded(&router, "GET", "/admin", Some("down"), &[("cookie", "viewer=down"), html[0]]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(!body.contains("Signed in"), "{body}");
    assert_eq!(LOOKUPS.with(|n| n.get()), 1, "one lookup, which failed");
    let (status, _, body) = guarded(&router, "GET", "/nope", None, &[("cookie", "viewer=down"), html[0]]).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "a lookup that fails draws the page signed out: {body}");
    assert!(body.contains("Not found") && !body.contains("Signed in"), "{body}");
    let (status, res, _) = guarded(&router, "GET", "/nope", None, &[("cookie", "viewer=ada"), ("corten", "nav")]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(res["x-robots-tag"], "noindex");
    assert!(res.contains_key("corten-page"), "in the request's mode");
}

#[tokio::test]
async fn the_error_page_after_a_handler_that_read_the_caller_keeps_the_pages_key() {
    let routes = Router::new()
        .route("/", get(|req: Req, _: Option<crate::Caller<Viewer>>| async move { req.test_page("Home", "") }))
        .route("/fail", get(|_: Option<crate::Caller<Viewer>>| async { Err::<Response, _>(Error::new("down")) }));
    let ada = [("cookie", "viewer=ada"), ("corten", "nav")];
    let (_, page, _) = guarded(&app(routes.clone(), None), "GET", "/", None, &ada).await;
    LOOKUPS.with(|n| n.set(0));
    let (status, failed, body) = guarded(&app(routes, None), "GET", "/fail", None, &ada).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body.contains("Signed in as ada"), "{body}");
    assert_eq!(LOOKUPS.with(|n| n.get()), 1, "the error page reads the caller the handler found");
    // Marked by the handler and the error page alike, the caller would cancel out of the key.
    assert_eq!(failed["corten-shell"], page["corten-shell"], "the same shell, so the runtime swaps it in");
}

#[tokio::test]
async fn a_handlers_own_503_is_not_an_unknown_caller() {
    let routes = Router::new().route("/", get(|| async { Err::<Response, _>(Error::status(StatusCode::SERVICE_UNAVAILABLE)) }));
    let (status, _, body) = call(app(routes, None), "GET", None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("Something went wrong") && !body.contains("cannot be checked"), "Failure::Failed: {body}");
}

#[tokio::test]
async fn a_found_caller_reaches_the_handler() {
    let router = caller_app();
    let (status, _, body) = guarded(&router, "GET", "/admin", Some("bob"), &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("<p>admin bob</p>"), "{body}");
    let (status, _, body) = guarded(&router, "POST", "/admin", Some("bob"), &[]).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "saved"));
    let (_, _, body) = guarded(&router, "GET", "/admin/users/7", Some("ada"), &[]).await;
    assert_eq!(body, "user 7");
    let (_, _, body) = guarded(&router, "GET", "/account", Some("eve"), &[]).await;
    assert!(body.contains("<p>eve</p>"), "anyone signed in has an account: {body}");
}

#[tokio::test]
async fn reading_a_caller_makes_the_answer_private_and_a_public_one_is_shared() {
    let router = caller_app();
    assert_eq!(cache_control(&router, "/catalog/1", &[]).await, "public, max-age=60");
    assert_eq!(cache_control(&router, "/catalog/1", &[("x-api-key", "k1")]).await, "public, max-age=60");
    assert_eq!(cache_control(&router, "/catalog/1", &[("cookie", "session=abc")]).await, "private, no-cache");
    assert_eq!(cache_control(&router, "/catalog/nope", &[]).await, "private, no-cache", "a failure is never shared");
    // A handler that reads a caller cannot return `Public` (that does not compile). A response that
    // says public anyway, by `Cache` or by a header written by hand (`HtmlResponse` derefs to the
    // response), is still private: the key could be anyone's.
    let minute = std::time::Duration::from_secs(60);
    let leaky = App::new(Routes::from(
        Router::new().route("/rates", get(move |Caller(p): Caller<Partner>| async move { (Cache::public(minute), p.0) })).route(
            "/by-hand",
            get(|Caller(p): Caller<Partner>| async move { ([(header::CACHE_CONTROL, "public, max-age=60")], p.0) }),
        ),
    ))
    .router();
    assert_eq!(cache_control(&leaky, "/rates", &[("x-api-key", "k1")]).await, "private, no-cache");
    assert_eq!(cache_control(&leaky, "/by-hand", &[("x-api-key", "k1")]).await, "private, no-cache");
}

#[tokio::test]
async fn a_caller_with_nowhere_to_sign_in_is_a_401_page() {
    let router = App::new(Routes::from(Router::new().route("/partner", get(|Caller(p): Caller<Partner>| async move { p.0 }))))
        .error_page(test_error_page, ())
        .router();
    let (status, res, body) = guarded(&router, "GET", "/partner", None, &[("accept", "text/html")]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(!res.contains_key("location") && body.contains("Something went wrong"), "{body}");
    let (status, _, body) = guarded(&router, "GET", "/partner", None, &[("x-api-key", "k1")]).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "acme"));
}

#[tokio::test]
async fn a_sign_in_page_that_needs_a_caller_is_an_error_not_a_loop() {
    let router =
        App::new(Routes::from(Router::new().route("/sign-in", get(|Caller(v): Caller<Viewer>| async move { v.0 })))).router();
    let (status, res, body) = guarded(&router, "GET", "/sign-in", None, &[("accept", "text/html")]).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "not a redirect the browser follows forever");
    assert!(!res.contains_key("location") && !body.contains("itself"), "the message stays in the log: {body}");
}

#[cfg(feature = "json")]
#[crate::routes]
mod json_url {
    #[route("/api/price/{id}", get = price)]
    pub struct Price {
        pub id: u32,
    }
}

#[cfg(feature = "json")]
#[derive(crate::ToJson)]
struct Quote {
    id: u32,
    partner: &'static str,
}

#[cfg(feature = "json")]
async fn price(price: crate::Params<json_url::Price>, Caller(partner): Caller<Partner>) -> JsonResult<Quote> {
    Ok(Json(Quote { id: price.id, partner: partner.0 }))
}

#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_route_answers_every_failure_as_json_whatever_the_client_accepts() {
    let router = App::new(json_url::router()).error_page(test_error_page, ()).router();
    for accept in ACCEPTS {
        let headers: &[(&str, &str)] = match accept {
            Some(accept) => &[("accept", accept)],
            None => &[],
        };
        let (status, res, body) = guarded(&router, "GET", "/api/price/7", None, headers).await;
        assert_eq!((status, &body[..]), (StatusCode::UNAUTHORIZED, r#"{"title":"Unauthorized","status":401}"#), "{accept:?}");
        assert_eq!(res["content-type"], "application/problem+json");
        let (status, _, body) = guarded(&router, "GET", "/api/price/abc", None, headers).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{accept:?}");
        assert!(body.starts_with(r#"{"title":"Bad Request","status":400,"#), "a path that does not parse: {body}");
    }
    let (status, res, body) = guarded(&router, "GET", "/api/price/7", None, &[("x-api-key", "k1")]).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, r#"{"id":7,"partner":"acme"}"#));
    assert_eq!(res["cache-control"], "private, no-cache");
}

paths! { ApiAdmin = "/api/admin" }

#[test]
#[should_panic(expected = "the area \"/api/admin\" is under App::api(\"/api\")")]
fn an_area_under_an_api_prefix_fails_at_startup() {
    let _ = App::new(Routes::new()).api::<ApiRoot>(|api| api).area::<ApiAdmin>(|admin| admin).router();
}

#[tokio::test]
async fn the_app_answers_unknown_urls_under_an_area_or_api() {
    let fallback = || async { "the app's fallback" };
    let router = App::new(Routes::from(Router::new().route("/", get(|| async { "home" })).fallback(fallback)))
        .area::<Admin>(|admin| admin.route::<Admin>(crate::Methods::reads(get(|| async { "admin" }))))
        .router();
    for uri in ["/nope", "/admin/nope"] {
        let (status, _, body) = call_with(router.clone(), "GET", uri, None, None).await;
        assert_eq!((status, &body[..]), (StatusCode::OK, "the app's fallback"), "{uri}");
    }
}

/// Whether this system has an IPv6 loopback address to listen on.
fn has_ipv6_loopback() -> bool {
    std::net::TcpListener::bind("[::1]:0").is_ok()
}

/// Without `HOST`, `localhost` is both loopback addresses on one port, so a browser that tries
/// `::1` first is answered at once, not after a fallback; stopping ends both.
#[tokio::test]
async fn without_a_host_the_app_listens_on_both_loopback_addresses() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listeners = crate::app::bind(None, 0).await.unwrap();
    let addrs: Vec<_> = listeners.iter().map(|l| l.local_addr().unwrap()).collect();
    assert!(addrs[0].is_ipv4() && addrs[0].ip().is_loopback(), "{addrs:?}");
    assert_eq!(addrs.len(), if has_ipv6_loopback() { 2 } else { 1 }, "{addrs:?}");
    assert!(addrs.iter().all(|a| a.ip().is_loopback() && a.port() == addrs[0].port()), "{addrs:?}");

    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let routes = Router::new().route("/", get(|| async { "hi" }));
    let server = tokio::spawn(crate::app::serve_router(listeners, crate::app::plain, routes, Default::default(), async {
        let _ = stopped.await;
    }));
    for addr in &addrs {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        assert!(answer.starts_with("HTTP/1.1 200") && answer.ends_with("hi"), "{addr}: {answer}");
    }
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// A server for `app` on a free port of `127.0.0.1` until `stop` is sent.
async fn served<M: crate::Middleware>(
    app: App<M>,
) -> (tokio::sync::oneshot::Sender<()>, tokio::task::JoinHandle<std::io::Result<()>>) {
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    (stop, server)
}

/// One request on a fresh connection to `addr`, with `headers` (lines ending in `\r\n`); the
/// answer as text.
async fn raw_get(addr: std::net::SocketAddr, path: &str, headers: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n{headers}\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    answer
}

/// `App::header_timeout` closes a connection that never finishes its request head, and
/// `App::max_connections` accepts no more connections than it allows until one closes.
#[tokio::test]
async fn a_connection_is_held_only_as_long_and_as_many_as_the_app_allows() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let serve = |app: App| async move {
        let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
        let addr = listeners[0].local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
            let _ = stopped.await;
        }));
        (addr, stop, server)
    };
    let routes = || {
        Routes::from(Router::new().route("/", get(|| async { "hi" })).route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(700)).await;
                "slow"
            }),
        ))
    };

    let (addr, stop, server) = serve(App::new(routes()).header_timeout(Duration::from_millis(300))).await;
    let mut slow = tokio::net::TcpStream::connect(addr).await.unwrap();
    slow.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\n").await.unwrap();
    let mut rest = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), slow.read_to_end(&mut rest)).await;
    assert!(closed.is_ok(), "an unfinished head is not held past the timeout");
    assert!(raw_get(addr, "/", "").await.ends_with("hi"), "a request that finishes its head is answered");
    assert!(raw_get(addr, "/slow", "").await.ends_with("slow"), "a handler may take longer than the head's timeout");
    let mut idle = tokio::net::TcpStream::connect(addr).await.unwrap();
    idle.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    let mut answered = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), idle.read_to_end(&mut answered)).await;
    assert!(closed.is_ok(), "an idle keep-alive connection is closed after the timeout");
    assert!(String::from_utf8_lossy(&answered).ends_with("hi"), "after its answer");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    let (addr, stop, server) = serve(App::new(routes()).header_timeout(None).max_connections(1)).await;
    let mut held = tokio::net::TcpStream::connect(addr).await.unwrap();
    held.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    let mut first = [0u8; 12];
    held.read_exact(&mut first).await.unwrap();
    assert_eq!(&first, b"HTTP/1.1 200");
    let second = tokio::spawn(raw_get(addr, "/", ""));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!second.is_finished(), "a second connection waits while the first is open");
    drop(held);
    let answer = tokio::time::timeout(Duration::from_secs(3), second).await.expect("answered once the first closes").unwrap();
    assert!(answer.ends_with("hi"), "{answer}");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// `App::max_request_head`: a head that reaches it is answered 431 and its connection closed,
/// without waiting for the rest of it; one within it is answered; the app can raise it, past
/// hyper's own read buffer too.
#[tokio::test]
async fn a_request_head_is_held_only_as_large_as_the_app_allows() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let serve = |app: App| async move {
        let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
        let addr = listeners[0].local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
            let _ = stopped.await;
        }));
        (addr, stop, server)
    };
    let routes = || Routes::from(Router::new().route("/", get(|| async { "hi" })));
    // A finished head with a cookie of `bytes`, or an unfinished head of exactly `bytes` (so the
    // server, refusing it, leaves nothing unread and closes without a reset); the answer as text.
    let send = |addr, bytes: usize, finish: bool| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let start = "GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\ncookie: c=";
        let head = if finish {
            format!("{start}{}\r\n\r\n", "x".repeat(bytes))
        } else {
            format!("{start}{}", "x".repeat(bytes - start.len()))
        };
        stream.write_all(head.as_bytes()).await.unwrap();
        let mut answer = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut answer)).await;
        assert!(read.is_ok(), "the connection closes, well before the header timeout");
        String::from_utf8_lossy(&answer).into_owned()
    };

    let (addr, stop, server) = serve(App::new(routes())).await;
    let answer = send(addr, 30 * 1024, true).await;
    assert!(answer.starts_with("HTTP/1.1 200") && answer.ends_with("hi"), "a 30 KiB head is answered: {answer}");
    assert!(answer.contains("x-content-type-options: nosniff"), "by the app: {answer}");
    // One the client never finishes is answered once it reaches the limit.
    let answer = send(addr, 32 * 1024, false).await;
    assert!(answer.starts_with("HTTP/1.1 431 "), "{answer}");
    assert!(!answer.contains("x-content-type-options"), "the server's answer, not the app's: {answer}");
    assert!(send(addr, 0, true).await.ends_with("hi"), "the server still answers");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    let (addr, stop, server) = serve(App::new(routes()).max_request_head(512 * 1024)).await;
    assert!(send(addr, 40 * 1024, true).await.ends_with("hi"), "a raised limit holds a 40 KiB head");
    // Past hyper's own 408 KiB buffer, which would refuse it there unless raised: a head held
    // unfinished at 450 KiB gets no answer until it is finished, then the page.
    let mut held = tokio::net::TcpStream::connect(addr).await.unwrap();
    let start = "GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\ncookie: c=";
    held.write_all(format!("{start}{}", "x".repeat(450 * 1024)).as_bytes()).await.unwrap();
    let mut first = [0u8; 1];
    let early = tokio::time::timeout(Duration::from_millis(500), held.read(&mut first)).await;
    assert!(early.is_err(), "no answer to an unfinished 450 KiB head: {early:?}");
    held.write_all(b"\r\n\r\n").await.unwrap();
    let mut answer = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), held.read_to_end(&mut answer)).await.expect("answered").unwrap();
    assert!(String::from_utf8_lossy(&answer).ends_with("hi"), "answered once finished");
    assert!(send(addr, 512 * 1024, false).await.starts_with("HTTP/1.1 431 "), "and refuses one at it");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// `App::send_timeout`: a client that stops reading an answer has its connection closed once a
/// write has waited that long, an endless stream included; a stream that waits between its own
/// chunks while the client reads is not cut, and `None` holds the stalled connection.
#[tokio::test]
async fn an_answer_waits_for_its_client_only_as_long_as_the_app_allows() {
    use axum::body::{Body, Bytes};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let serve = |app: App| async move {
        let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
        let addr = listeners[0].local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
            let _ = stopped.await;
        }));
        (addr, stop, server)
    };
    let routes = || {
        Routes::from(
            Router::new()
                // An answer with no end: only the client stopping, or the server closing, ends it.
                .route(
                    "/endless",
                    get(|| async {
                        let chunk = Bytes::from(vec![b'x'; 64 * 1024]);
                        Body::from_stream(futures_util::stream::repeat_with(move || Ok::<_, std::io::Error>(chunk.clone())))
                    }),
                )
                // 32 MiB, more than the socket buffers hold, so its writes wait on the reader.
                .route("/big", get(|| async { vec![b'x'; 32 << 20] }))
                // Three chunks 400 ms apart, longer than the send timeout below.
                .route(
                    "/paced",
                    get(|| async {
                        Body::from_stream(futures_util::stream::unfold(0, |sent| async move {
                            if sent == 3 {
                                return None;
                            }
                            tokio::time::sleep(Duration::from_millis(400)).await;
                            Some((Ok::<_, std::io::Error>(Bytes::from_static(b"tick")), sent + 1))
                        }))
                    }),
                ),
        )
    };
    let endless = |addr| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(b"GET /endless HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
        stream
    };
    // Reads what is left; Ok once the server has closed, Err while it still sends after 3 s.
    let drain = |mut stream: tokio::net::TcpStream| async move {
        let mut buf = vec![0u8; 256 * 1024];
        tokio::time::timeout(Duration::from_secs(3), async move {
            while let Ok(read) = stream.read(&mut buf).await {
                if read == 0 {
                    break;
                }
            }
        })
        .await
    };

    let (addr, stop, server) = serve(App::new(routes()).send_timeout(Duration::from_millis(300))).await;
    let stalled = endless(addr).await;
    // Long enough for the socket's buffers to fill and the timeout to pass, with room for a
    // slow machine: the connection is closed by then, so what is left ends.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(drain(stalled).await.is_ok(), "a client that stops reading is closed");
    let mut paced = tokio::net::TcpStream::connect(addr).await.unwrap();
    paced.write_all(b"GET /paced HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    let mut answer = Vec::new();
    paced.read_to_end(&mut answer).await.unwrap();
    let ticks = answer.windows(4).filter(|w| w == b"tick").count();
    assert_eq!(ticks, 3, "a stream that waits between chunks is not cut: {}", String::from_utf8_lossy(&answer));
    // A reader that pauses 10 ms between reads takes longer than the timeout in all, and its
    // writes wait each time the buffers fill, but each wait ends in time: it gets everything.
    let mut slow = tokio::net::TcpStream::connect(addr).await.unwrap();
    slow.write_all(b"GET /big HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    let started = std::time::Instant::now();
    let (mut got, mut buf) = (0, vec![0u8; 256 * 1024]);
    loop {
        let read = tokio::time::timeout(Duration::from_secs(5), slow.read(&mut buf)).await.expect("reads").unwrap_or(0);
        if read == 0 {
            break;
        }
        got += read;
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(got > 32 << 20, "a reader that keeps reading gets the whole answer: {got} bytes");
    assert!(started.elapsed() > Duration::from_millis(300), "over longer than the timeout");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    let (addr, stop, server) = serve(App::new(routes()).send_timeout(None)).await;
    let stalled = endless(addr).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(drain(stalled).await.is_err(), "without the timeout it is held, and still sending");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// Shutdown gives connections the longer of the grace and the longest deadline: a request in
/// progress past the grace, within its deadline, is answered in full, and an answer its client has
/// stopped reading is closed then, with no send timeout to close it before (#858).
#[tokio::test]
async fn shutdown_closes_connections_still_answering_once_the_grace_and_deadline_have_passed() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let started = std::sync::Arc::new(tokio::sync::Notify::new());
    let routes = Router::new()
        // 32 MiB, more than the socket buffers hold, so its writes wait on the reader.
        .route("/big", get(|| async { vec![b'x'; 32 << 20] }))
        // Longer than the grace, within the deadline.
        .route(
            "/slow",
            get({
                let started = started.clone();
                move || async move {
                    started.notify_one();
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    "done"
                }
            }),
        );
    let app = App::new(Routes::from(routes))
        .send_timeout(None)
        .shutdown_grace(Duration::from_millis(200))
        .deadline(Duration::from_secs(1));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));

    let mut stalled = tokio::net::TcpStream::connect(addr).await.unwrap();
    stalled.write_all(b"GET /big HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    // The answer has started; from here the client reads no more.
    let mut head = [0u8; 12];
    stalled.read_exact(&mut head).await.unwrap();
    assert_eq!(&head, b"HTTP/1.1 200");
    let mut slow = tokio::net::TcpStream::connect(addr).await.unwrap();
    slow.write_all(b"GET /slow HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    started.notified().await;
    let began = std::time::Instant::now();
    stop.send(()).unwrap();

    let mut answer = String::new();
    slow.read_to_string(&mut answer).await.unwrap();
    assert!(answer.ends_with("done"), "a request in progress has its deadline: {answer}");
    // Without the drain's bound this waits for the client, which never reads.
    tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
    assert!(began.elapsed() >= Duration::from_secs(1), "held for the deadline, the longer: {:?}", began.elapsed());
    let mut rest = vec![0u8; 256 * 1024];
    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        while let Ok(read) = stalled.read(&mut rest).await {
            if read == 0 {
                break;
            }
        }
    });
    assert!(closed.await.is_ok(), "the stalled connection was closed");
}

/// Shutdown gives each connection its own request's deadline, not the longest in the app: a page
/// whose client stopped reading is closed at the page's, while a request to an area with an
/// hour's deadline, in progress past the page's, is answered in full (#887).
#[tokio::test]
async fn shutdown_holds_a_connection_to_its_own_requests_deadline() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // 32 MiB, more than the socket buffers hold, so its writes wait on the reader.
    const BIG: usize = 32 << 20;
    let started = std::sync::Arc::new(tokio::sync::Notify::new());
    let serve = || async {
        let routes = Router::new().route("/big", get(|| async { vec![b'x'; BIG] }));
        let job = get({
            let started = started.clone();
            move || async move {
                started.notify_one();
                tokio::time::sleep(Duration::from_secs(2)).await;
                "done"
            }
        });
        let app = App::new(Routes::from(routes))
            .send_timeout(None)
            .shutdown_grace(Duration::from_millis(100))
            .deadline(Duration::from_millis(600))
            .area::<Admin>(|admin| admin.route::<AdminSlow>(crate::Methods::reads(job)).deadline(Duration::from_secs(3600)));
        let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
        let addr = listeners[0].local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
            let _ = stopped.await;
        }));
        // A client that reads the answer's first bytes, then no more.
        let mut stalled = tokio::net::TcpStream::connect(addr).await.unwrap();
        stalled.write_all(b"GET /big HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
        let mut head = [0u8; 12];
        stalled.read_exact(&mut head).await.unwrap();
        assert_eq!(&head, b"HTTP/1.1 200");
        (addr, stop, server, stalled)
    };
    // How much of the answer the client gets when it reads again: all of it if its connection was
    // still open, so its writes went on.
    let rest = |mut stalled: tokio::net::TcpStream| async move {
        let mut buf = vec![0u8; 256 * 1024];
        let mut total = 0;
        while let Ok(read) = stalled.read(&mut buf).await {
            if read == 0 {
                break;
            }
            total += read;
        }
        total
    };

    // The page's client alone: shutdown ends at the page's deadline, not the grace or the hour.
    let (_, stop, server, stalled) = serve().await;
    stop.send(()).unwrap();
    let began = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
    let took = began.elapsed();
    assert!(took >= Duration::from_millis(600), "not before the page's deadline: {took:?}");
    let read = tokio::time::timeout(Duration::from_secs(5), rest(stalled)).await.expect("closed");
    assert!(read < BIG, "the stalled connection was closed, not sent the rest: {read}");

    // With the area's request in progress: it is answered past the page's deadline, and the page's
    // connection was closed before it.
    let (addr, stop, server, stalled) = serve().await;
    let mut job = tokio::net::TcpStream::connect(addr).await.unwrap();
    job.write_all(b"GET /admin/slow HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    started.notified().await;
    stop.send(()).unwrap();
    let mut answer = String::new();
    job.read_to_string(&mut answer).await.unwrap();
    assert!(answer.ends_with("done"), "the area's request in progress has its hour: {answer}");
    let read = tokio::time::timeout(Duration::from_secs(5), rest(stalled)).await.expect("closed");
    assert!(read < BIG, "the page's connection was closed before the job's answer: {read}");
    tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
}

/// At shutdown a connection whose request's head was still arriving has the grace, and the
/// deadline of the request once it has arrived: one never finished is closed after the grace,
/// one that finishes as a request to an area with an hour's deadline is answered (#887).
#[tokio::test]
async fn a_request_still_arriving_at_shutdown_has_its_own_deadline() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let job = get(|| async {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        "done"
    });
    let app = App::new(Routes::from(Router::new().route("/", get(|| async { "home" }))))
        .header_timeout(None)
        .shutdown_grace(Duration::from_millis(300))
        .deadline(Duration::from_millis(300))
        .area::<Admin>(|admin| admin.route::<AdminSlow>(crate::Methods::reads(job)).deadline(Duration::from_secs(3600)));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    // Both send part of a head.
    let mut never = tokio::net::TcpStream::connect(addr).await.unwrap();
    never.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
    let mut late = tokio::net::TcpStream::connect(addr).await.unwrap();
    late.write_all(b"GET /admin/slow HTTP/1.1\r\n").await.unwrap();
    // A connection made after them answered, so the server has taken theirs: it takes them in
    // the order they came.
    let mut after = tokio::net::TcpStream::connect(addr).await.unwrap();
    after.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    let mut answer = String::new();
    after.read_to_string(&mut answer).await.unwrap();
    assert!(answer.ends_with("home"), "{answer}");
    stop.send(()).unwrap();
    let began = std::time::Instant::now();
    // The rest of the head once shutdown has begun, which closes the listener: the connection
    // read no deadline when it began.
    while tokio::net::TcpStream::connect(addr).await.is_ok() {
        tokio::task::yield_now().await;
    }
    late.write_all(b"host: localhost\r\nconnection: close\r\n\r\n").await.unwrap();

    let mut answer = String::new();
    late.read_to_string(&mut answer).await.unwrap();
    assert!(answer.ends_with("done"), "the request that arrived has the area's hour: {answer}");
    let mut rest = Vec::new();
    let _ =
        tokio::time::timeout(Duration::from_secs(3), never.read_to_end(&mut rest)).await.expect("the unfinished head is closed");
    // Held for the hour, the unfinished head would keep shutdown waiting.
    tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
    assert!(began.elapsed() >= Duration::from_millis(1400), "the job was waited for: {:?}", began.elapsed());
}

/// A server dropped without a shutdown (its future aborted) closes a connection still answering at
/// once, an hour-long area's included (#887 review).
#[tokio::test]
async fn a_server_dropped_without_a_shutdown_closes_its_connections() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (started, mut running) = tokio::sync::mpsc::channel::<()>(1);
    let job = get(move || {
        let started = started.clone();
        async move {
            let _ = started.send(()).await;
            std::future::pending::<&'static str>().await
        }
    });
    let app = App::new(Routes::from(Router::new().route("/", get(|| async { "home" }))))
        .area::<Admin>(|admin| admin.route::<AdminSlow>(crate::Methods::reads(job)).deadline(Duration::from_secs(3600)));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (_stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    conn.write_all(b"GET /admin/slow HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    running.recv().await.expect("the job runs");
    server.abort();
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), conn.read_to_end(&mut rest)).await.expect("closed at once").ok();
}

/// `App::send_timeout` holds on a switched connection too: a socket whose client stops reading
/// has its route's write fail with `TimedOut`.
#[tokio::test]
async fn a_switched_connection_is_held_to_the_send_timeout() {
    use crate::upgrade::Upgrade;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (failed, failure) = tokio::sync::mpsc::channel::<std::io::ErrorKind>(1);
    let routes = Router::new().route(
        "/ws",
        get(move |upgrade: Upgrade| {
            let failed = failed.clone();
            async move {
                upgrade.websocket(move |mut stream: crate::upgrade::Stream, _: crate::Signal| async move {
                    let chunk = vec![b'x'; 64 * 1024];
                    loop {
                        if let Err(error) = stream.write_all(&chunk).await {
                            let _ = failed.send(error.kind()).await;
                            return;
                        }
                    }
                })
            }
        }),
    );
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(routes)).send_timeout(Duration::from_millis(300));
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"GET /ws HTTP/1.1\r\nhost: localhost\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
        .await
        .unwrap();
    let mut first = [0u8; 12];
    stream.read_exact(&mut first).await.unwrap();
    assert_eq!(&first, b"HTTP/1.1 101");
    // Reads nothing more.
    let mut failure = failure;
    let kind = tokio::time::timeout(Duration::from_secs(5), failure.recv()).await.expect("the route's write fails");
    assert_eq!(kind, Some(std::io::ErrorKind::TimedOut));
    drop(stream);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// `corten::serve_wrapped`: the app's step on each connection before HTTP (a TLS handshake) runs
/// in the connection's own task, counts against `App::max_connections` and is closed at
/// `App::header_timeout` when it stalls; a step that fails closes the connection.
#[tokio::test]
async fn a_step_before_http_is_counted_and_timed_as_the_connection() {
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // A stand-in for a handshake: the client sends "hello\n" first, anything else fails it.
    async fn hello(mut tcp: tokio::net::TcpStream) -> std::io::Result<tokio::net::TcpStream> {
        let mut greeting = [0u8; 6];
        tcp.read_exact(&mut greeting).await?;
        match &greeting {
            b"hello\n" => Ok(tcp),
            _ => Err(std::io::Error::other("not a greeting")),
        }
    }
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let routes = Routes::from(Router::new().route("/", get(|| async { "hi" })));
    // Long enough that the two clocks below differ by far more than a loaded machine's delay.
    let app = App::new(routes).header_timeout(Duration::from_millis(600)).max_connections(1);
    let server = tokio::spawn(crate::app::run(listeners, hello, app, async {
        let _ = stopped.await;
    }));
    let request = |greeting: &'static [u8]| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut sent = greeting.to_vec();
        sent.extend_from_slice(b"GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n");
        // A failed step may close the connection before all of it is read.
        let _ = stream.write_all(&sent).await;
        let mut answer = String::new();
        let _ = stream.read_to_string(&mut answer).await;
        answer
    };
    assert!(request(b"hello\n").await.ends_with("hi"), "after its step, the connection is HTTP");
    assert_eq!(request(b"howdy\n").await, "", "a step that fails closes the connection");

    // A client that opens a connection and never finishes its step holds the only slot, until
    // the header timeout closes it.
    let started = Instant::now();
    let mut stalled = tokio::net::TcpStream::connect(addr).await.unwrap();
    stalled.write_all(b"hel").await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let next = tokio::spawn(request(b"hello\n"));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!next.is_finished(), "a connection in its step counts against max_connections");
    let mut rest = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), stalled.read_to_end(&mut rest)).await;
    assert!(closed.is_ok(), "a stalled step is not held past the header timeout");
    // The clock closes it within a tick (a tenth of the timeout, 60 ms) of 600 ms from the accept,
    // either way, and earlier by as much as the clock's thread ran late on a loaded machine, as
    // idle time is counted from its last tick: 400 ms leaves 140 ms for that, well after the
    // check at 200 ms.
    assert!(started.elapsed() >= Duration::from_millis(400), "{:?}", started.elapsed());
    let answer = tokio::time::timeout(Duration::from_secs(3), next).await.expect("answered once it closes").unwrap();
    assert!(answer.ends_with("hi"), "{answer}");

    // A step that takes half the timeout leaves the rest for the head: the timeout counts from
    // the accept, not from earlier.
    let mut half = tokio::net::TcpStream::connect(addr).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    half.write_all(b"hello\nGET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    let mut answer = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), half.read_to_string(&mut answer)).await;
    assert!(answer.ends_with("hi"), "a head sent after a step is answered: {answer:?}");

    // One clock from the accept to the head: a step that takes most of the timeout leaves the
    // rest for the head, not the whole timeout again. It closes within a tick (60 ms) of 600 ms
    // from the accept; a second clock would close it within a tick of 1,000 ms. The bound leaves
    // about 190 ms after the first and 90 ms before the second, so a loaded machine's delay does
    // not fail it (#594).
    let started = Instant::now();
    let mut slow = tokio::net::TcpStream::connect(addr).await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    slow.write_all(b"hello\n").await.unwrap();
    let mut rest = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), slow.read_to_end(&mut rest)).await;
    assert!(closed.is_ok(), "a connection with no head after its step is closed");
    assert!(started.elapsed() < Duration::from_millis(850), "at the header timeout from the accept: {:?}", started.elapsed());

    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    // Shutdown ends a step in progress, with no header timeout to end it otherwise.
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let routes = Routes::from(Router::new().route("/", get(|| async { "hi" })));
    let server = tokio::spawn(crate::app::run(listeners, hello, App::new(routes).header_timeout(None), async {
        let _ = stopped.await;
    }));
    let mut stalled = tokio::net::TcpStream::connect(addr).await.unwrap();
    stalled.write_all(b"hel").await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), server).await.expect("shutdown does not wait for a step").unwrap().unwrap();
    let mut rest = Vec::new();
    assert_eq!(stalled.read_to_end(&mut rest).await.map(|_| rest.len()).unwrap_or(0), 0, "and closes it");
}

/// A route that takes `Upgrade` switches the connection: a WebSocket handshake from the page's own
/// origin or from a client that is not a browser gets its 101 and then the bytes, one from another
/// site is refused as a cross-site write is, and a request that does not ask to switch is a 426,
/// or, where the route takes `Option<Upgrade>`, its other answer.
#[tokio::test]
async fn an_upgrade_route_switches_for_its_own_origin_and_refuses_other_sites() {
    use crate::upgrade::{Switch, SwitchOr, Upgrade};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn echo(mut stream: crate::upgrade::Stream, _: crate::Signal) {
        let mut buf = [0u8; 64];
        while let Ok(n @ 1..) = stream.read(&mut buf).await {
            if stream.write_all(&buf[..n]).await.is_err() {
                break;
            }
        }
    }
    let routes = Router::new()
        .route("/ws", get(|upgrade: Upgrade| async move { upgrade.websocket(echo) }))
        .route(
            "/tunnel",
            get(|upgrade: Upgrade| async move {
                let mut headers = axum::http::HeaderMap::new();
                headers.insert("x-upstream", "yes".parse().unwrap());
                Ok::<Switch, crate::Error>(upgrade.switch(headers, echo))
            }),
        )
        .route(
            "/either",
            get(|upgrade: Option<Upgrade>| async move {
                match upgrade {
                    Some(upgrade) => Ok::<_, crate::Error>(upgrade.websocket(echo)?.into()),
                    None => Ok(SwitchOr::Answer("not a socket")),
                }
            }),
        );
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(routes)).api::<ApiRoot>(|api| {
        api.route::<ApiWs>(crate::Methods::reads(get(|upgrade: Upgrade| async move { upgrade.websocket(echo) })))
            .allow_origin("https://partner.example")
    });
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    // The answer's head, and the connection for what follows it.
    let handshake = |path: &'static str, protocol: &'static str, extra: &'static str| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "GET {path} HTTP/1.1\r\nhost: localhost\r\nconnection: keep-alive, Upgrade\r\nupgrade: {protocol}\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n{extra}\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0u8; 1];
            if stream.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            head.push(byte[0]);
        }
        (String::from_utf8(head).unwrap().to_ascii_lowercase(), stream)
    };
    let echoes = |mut stream: tokio::net::TcpStream| async move {
        stream.write_all(b"ping").await.unwrap();
        let mut back = [0u8; 4];
        stream.read_exact(&mut back).await.unwrap();
        &back == b"ping"
    };

    let (head, stream) = handshake("/ws", "websocket", "origin: http://localhost\r\nsec-fetch-site: same-origin\r\n").await;
    assert!(head.starts_with("http/1.1 101"), "{head}");
    assert!(head.contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo="), "{head}");
    assert!(echoes(stream).await, "the switched connection carries bytes both ways");

    let (head, stream) = handshake("/ws", "websocket", "").await;
    assert!(head.starts_with("http/1.1 101"), "a client that is not a browser switches: {head}");
    assert!(echoes(stream).await);

    let (head, _) = handshake("/ws", "websocket", "origin: https://evil.example\r\nsec-fetch-site: cross-site\r\n").await;
    assert!(head.starts_with("http/1.1 403"), "another site's page cannot open it with the user's cookies: {head}");
    let (head, _) = handshake("/ws", "websocket", "origin: https://evil.example\r\n").await;
    assert!(head.starts_with("http/1.1 403"), "nor an older browser's, by its Origin alone: {head}");

    let (head, _) = handshake("/ws", "chat", "").await;
    assert!(head.starts_with("http/1.1 400"), "only a WebSocket handshake is accepted as one: {head}");

    let plain = raw_get(addr, "/ws", "").await;
    assert!(plain.starts_with("HTTP/1.1 426"), "{plain}");

    let (head, stream) = handshake("/either", "websocket", "").await;
    assert!(head.starts_with("http/1.1 101"), "{head}");
    assert!(echoes(stream).await);
    let plain = raw_get(addr, "/either", "").await;
    assert!(plain.starts_with("HTTP/1.1 200") && plain.ends_with("not a socket"), "{plain}");
    let (head, _) = handshake("/either", "websocket", "origin: https://evil.example\r\nsec-fetch-site: cross-site\r\n").await;
    assert!(head.starts_with("http/1.1 403"), "a switch it asks for is held to what Upgrade is: {head}");

    // An API's allowed site may open its sockets, as it may write to it, but not with cookies.
    let partner = "origin: https://partner.example\r\nsec-fetch-site: cross-site\r\n";
    let (head, stream) = handshake("/api/ws", "websocket", partner).await;
    assert!(head.starts_with("http/1.1 101"), "{head}");
    assert!(echoes(stream).await);
    let (head, _) = handshake(
        "/api/ws",
        "websocket",
        "origin: https://partner.example\r\nsec-fetch-site: cross-site\r\ncookie: session=abc\r\n",
    )
    .await;
    assert!(head.starts_with("http/1.1 403"), "{head}");
    let (head, _) = handshake("/ws", "websocket", partner).await;
    assert!(head.starts_with("http/1.1 403"), "the pages' sockets still refuse the partner: {head}");

    let (head, stream) = handshake("/tunnel", "remote", "").await;
    assert!(head.starts_with("http/1.1 101") && head.contains("x-upstream: yes") && head.contains("upgrade: remote"), "{head}");
    assert!(echoes(stream).await);

    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

#[derive(crate::Route)]
#[route("/api/ws")]
struct ApiWs;

/// A relayed answer goes through the whole app uncompressed, a page-sized body and an event stream
/// alike, so a long model stream holds no compression context (#205).
#[cfg(feature = "compress")]
#[tokio::test]
async fn a_relay_is_not_compressed_by_the_app() {
    fn upstream(content_type: &'static str, body: Body) -> crate::Relay {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("content-type", content_type.parse().unwrap());
        crate::Relay::new(StatusCode::OK, headers, body)
    }
    let page = "<p>relayed</p>".repeat(300);
    let events = "event: delta\ndata: {\"text\":\"hello\"}\n\n".repeat(100);
    let (p, e, own) = (page.clone(), events.clone(), page.clone());
    let router = App::new(Routes::from(
        Router::new()
            .route("/own", get(move || async move { axum::response::Html(own) }))
            .route("/page", get(move || async move { upstream("text/html; charset=utf-8", Body::from(p)) }))
            .route(
                "/stream",
                get(move || async move {
                    let chunk = Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(e));
                    upstream("text/event-stream", Body::from_stream(futures_util::stream::iter([chunk])))
                }),
            ),
    ))
    .router();
    for (path, sent) in [("/page", &page), ("/stream", &events)] {
        let req = Request::get(path).header("accept-encoding", "zstd, br, gzip").body(Body::empty()).unwrap();
        let res = router.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{path}");
        assert!(
            !res.headers().contains_key("content-encoding") && !res.headers().contains_key("vary"),
            "{path}: {:?}",
            res.headers()
        );
        let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], sent.as_bytes(), "{path}");
    }
    // The same body as the app's own answer is compressed, so the app does compress.
    let req = Request::get("/own").header("accept-encoding", "zstd, br, gzip").body(Body::empty()).unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.headers()["content-encoding"], "zstd");
}

#[cfg(feature = "json")]
#[crate::routes]
mod half_url {
    #[route("/half/{status}", get = half)]
    pub struct Half {
        pub status: u16,
    }
}

/// A JSON route that answers `200` itself and passes anything else on, as a route moved off
/// another service a part at a time does.
#[cfg(feature = "json")]
async fn half(crate::Params(at): crate::Params<half_url::Half>) -> Result<crate::JsonResponse, crate::JsonError> {
    if at.status == 200 {
        return Ok(Json(Quote { id: 7, partner: "own" }).into());
    }
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    headers.insert("content-security-policy", "default-src 'self'".parse().unwrap());
    let body = format!(r#"{{"from":"upstream","pad":"{}"}}"#, "x".repeat(4000));
    let status = StatusCode::from_u16(at.status).unwrap();
    Ok(crate::Relay::new(status, headers, Body::from(body)).into())
}

/// A JSON route that passes some requests on answers the relay as a `JsonResponse`, and it stays
/// the upstream's answer whatever the client accepts: its failure body (never the JSON error or
/// the error page), its CSP, and not compressed; the route's own answer is still the app's (#541).
#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_route_passes_a_relay_on_as_the_upstream_gave_it() {
    let router = App::new(half_url::router()).error_page(test_error_page, ()).router();
    for accept in ACCEPTS {
        for status in [StatusCode::BAD_REQUEST, StatusCode::BAD_GATEWAY] {
            let mut req = Request::get(format!("/half/{}", status.as_u16())).header("accept-encoding", "zstd, br, gzip");
            if let Some(accept) = accept {
                req = req.header("accept", accept);
            }
            let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(res.status(), status, "{accept:?}");
            assert_eq!(res.headers()["content-type"], "application/json", "{accept:?}");
            assert_eq!(res.headers()["content-security-policy"], "default-src 'self'", "{accept:?}");
            assert!(!res.headers().contains_key("content-encoding"), "{accept:?}: {:?}", res.headers());
            let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
            assert!(body.starts_with(br#"{"from":"upstream""#), "{accept:?} {status}");
        }
    }
    let (status, _, body) = call_with(router, "GET", "/half/200", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, r#"{"id":7,"partner":"own"}"#));
}

/// A relayed answer is passed on as the upstream gave it: its failure status and body, never the
/// error page or the JSON error, without the hop-by-hop headers.
#[tokio::test]
async fn a_relay_passes_the_upstreams_answer_on() {
    fn upstream(status: StatusCode) -> crate::Relay {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("content-type", "text/plain".parse().unwrap());
        headers.insert("connection", "keep-alive, x-hop".parse().unwrap());
        headers.insert("x-hop", "1".parse().unwrap());
        headers.insert("keep-alive", "timeout=5".parse().unwrap());
        headers.insert("transfer-encoding", "chunked".parse().unwrap());
        headers.insert("x-upstream", "kept".parse().unwrap());
        crate::Relay::new(status, headers, Body::from("upstream says no"))
    }
    let router = App::new(Routes::from(Router::new().route("/relay", get(|| async { upstream(StatusCode::BAD_REQUEST) }))))
        .error_page(test_error_page, ())
        .api::<ApiRoot>(|api| api.route::<ApiItem>(crate::Methods::reads(get(|| async { upstream(StatusCode::BAD_GATEWAY) }))))
        .router();
    for (path, status, accept) in [
        ("/relay", StatusCode::BAD_REQUEST, Some("text/html")),
        ("/relay", StatusCode::BAD_REQUEST, Some("application/json")),
        ("/api/items/7", StatusCode::BAD_GATEWAY, None),
    ] {
        let (got, headers, body) = call_with(router.clone(), "GET", path, None, accept).await;
        assert_eq!((got, &body[..]), (status, "upstream says no"), "{path} {accept:?}");
        assert_eq!(headers["x-upstream"], "kept");
        for hop in ["connection", "x-hop", "keep-alive", "transfer-encoding"] {
            assert!(!headers.contains_key(hop), "{path}: {hop} is the upstream connection's, not ours");
        }
        assert!(headers.contains_key("x-content-type-options"), "the app's security headers still apply");
    }

    // A relayed page keeps the upstream's own CSP, which its scripts were written for; without one
    // the app's applies.
    let page = |csp: Option<&'static str>| {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("content-type", "text/html".parse().unwrap());
        if let Some(csp) = csp {
            headers.insert("content-security-policy", csp.parse().unwrap());
        }
        crate::Relay::new(StatusCode::OK, headers, Body::from("<script nonce=upstream></script>"))
    };
    let router = App::new(Routes::from(
        Router::new()
            .route("/own", get(move || async move { page(Some("script-src 'nonce-upstream'")) }))
            .route("/none", get(move || async move { page(None) })),
    ))
    .router();
    let (_, headers, _) = call_with(router.clone(), "GET", "/own", None, Some("text/html")).await;
    assert_eq!(headers["content-security-policy"], "script-src 'nonce-upstream'");
    assert_eq!(headers["x-frame-options"], "DENY", "the app's other headers still apply");
    let (_, headers, _) = call_with(router, "GET", "/none", None, Some("text/html")).await;
    assert!(headers["content-security-policy"].to_str().unwrap().starts_with("default-src 'self'"));

    // An upstream's event stream reaches the client a piece at a time, not when it ends.
    let (send, receive) = tokio::sync::mpsc::channel::<Result<&'static str, std::io::Error>>(1);
    let stream = std::sync::Arc::new(std::sync::Mutex::new(Some(tokio_stream_of(receive))));
    let router = App::new(Routes::from(Router::new().route(
        "/events",
        get(move || {
            let body = Body::from_stream(stream.lock().unwrap().take().unwrap());
            async move {
                let mut headers = axum::http::HeaderMap::new();
                headers.insert("content-type", "text/event-stream".parse().unwrap());
                crate::Relay::new(StatusCode::OK, headers, body)
            }
        }),
    )))
    .router();
    let res = router.oneshot(Request::get("/events").body(Body::empty()).unwrap()).await.unwrap();
    let mut body = res.into_body();
    send.send(Ok("data: one\n\n")).await.unwrap();
    let first = tokio::time::timeout(std::time::Duration::from_secs(2), body.frame()).await;
    let first = first.expect("the first event arrives while the stream is open").unwrap().unwrap();
    assert_eq!(first.into_data().unwrap(), "data: one\n\n");
    drop(send);
}

/// A stream of the pieces `receive` gets, until its sender is dropped.
fn tokio_stream_of<T>(receive: tokio::sync::mpsc::Receiver<T>) -> impl futures_util::Stream<Item = T> {
    futures_util::stream::unfold(receive, |mut receive| async move { receive.recv().await.map(|item| (item, receive)) })
}

/// `corten::serve` gives each request its connection's peer, which `ClientIp` reads. A proxy's `X-Forwarded-For` is followed only when the
/// app trusts the peer, and the answer is private to the address.
#[tokio::test]
async fn the_client_ip_is_the_peer_or_what_a_trusted_proxy_forwards() {
    let app = |policy: crate::security::Policy| {
        let routes = Router::new().route("/ip", get(|crate::ClientIp(ip): crate::ClientIp| async move { ip.to_string() }));
        App::new(Routes::from(routes)).policy(policy)
    };
    let body = |answer: &str| answer.rsplit("\r\n").next().unwrap().to_string();
    let forwarded = "x-forwarded-for: 1.1.1.1, 198.51.100.7\r\n";

    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app(crate::security::Policy::new()), async {
        let _ = stopped.await;
    }));
    let answer = raw_get(addr, "/ip", forwarded).await;
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    assert_eq!(body(&answer), "127.0.0.1", "without a trusted proxy the header is anyone's");
    assert!(answer.to_ascii_lowercase().contains("cache-control: private"), "{answer}");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let behind = app(crate::security::Policy::new().proxy("127.0.0.0/8"));
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, behind, async {
        let _ = stopped.await;
    }));
    assert_eq!(body(&raw_get(addr, "/ip", forwarded).await), "198.51.100.7");
    assert_eq!(body(&raw_get(addr, "/ip", "").await), "127.0.0.1");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// Without a connection (a test's `oneshot`), `ClientIp` is a 500 that says why and
/// `Option<ClientIp>` is `None`; axum's `MockConnectInfo` gives it one.
#[tokio::test]
async fn without_a_connection_there_is_no_client_ip() {
    use axum::extract::connect_info::MockConnectInfo;
    let routes = || {
        Router::new()
            .route("/ip", get(|crate::ClientIp(ip): crate::ClientIp| async move { ip.to_string() }))
            .route("/maybe", get(|ip: Option<crate::ClientIp>| async move { format!("{ip:?}") }))
    };
    let router = App::new(Routes::from(routes())).router();
    let (status, _, _) = call_with(router.clone(), "GET", "/ip", None, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let (status, _, body) = call_with(router, "GET", "/maybe", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "None"));
    let mocked =
        App::new(Routes::from(routes())).router().layer(MockConnectInfo(std::net::SocketAddr::from(([203, 0, 113, 9], 4711))));
    let (status, _, body) = call_with(mocked, "GET", "/ip", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "203.0.113.9"));
}

/// A task of the app's is told when shutdown begins, and `serve` waits for it to finish what it
/// was writing before it returns.
#[tokio::test]
async fn shutdown_tells_the_tasks_and_waits_for_them() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let written = Arc::new(AtomicBool::new(false));
    let (reason_tx, reason) = tokio::sync::oneshot::channel();
    let journal = written.clone();
    let app = App::new(Routes::new()).task("journal", move |signal: Signal| async move {
        let why = signal.aborted().await;
        // The write in progress when the signal came.
        tokio::time::sleep(Duration::from_millis(100)).await;
        journal.store(true, Ordering::SeqCst);
        let _ = reason_tx.send(why);
    });
    let (stop, server) = served(app).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!server.is_finished() && !written.load(Ordering::SeqCst));
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
    assert!(written.load(Ordering::SeqCst), "serve returned before the task finished");
    assert_eq!(reason.await.unwrap(), crate::Abort::Shutdown);
}

/// A task that ignores the signal is ended at the grace, so it cannot hold the process; one that
/// panics ends alone, and the app keeps serving.
#[tokio::test]
async fn a_task_past_the_grace_is_ended_and_one_that_panics_ends_alone() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let dropped = Arc::new(AtomicBool::new(false));
    let guard = Dropped(dropped.clone());
    let routes = Routes::from(Router::new().route("/", get(|| async { "hi" })));
    let app = App::new(routes)
        .shutdown_grace(Duration::from_millis(50))
        .task("stuck", move |_signal: Signal| async move {
            let _guard = guard;
            std::future::pending::<()>().await
        })
        .task("broken", |_signal: Signal| async move { panic!("the task failed") });
    let (stop, server) = served(app).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!server.is_finished(), "a task that panicked took the server with it");
    let started = std::time::Instant::now();
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), server).await.expect("a stuck task held serve").unwrap().unwrap();
    assert!(started.elapsed() >= Duration::from_millis(50), "serve did not wait the grace");
    tokio::time::timeout(Duration::from_secs(1), async {
        while !dropped.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the stuck task was left running");
}

/// A `[::1]` port another process holds is an error, not a server only `127.0.0.1` reaches:
/// `http://localhost` would get the other process.
#[tokio::test]
async fn a_taken_ipv6_loopback_port_is_an_error() {
    if !has_ipv6_loopback() {
        return;
    }
    let taken = std::net::TcpListener::bind("[::1]:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    let error = crate::app::bind(None, port).await.expect_err("the port is taken on ::1");
    assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
    assert_eq!(crate::app::bind(Some("127.0.0.1"), port).await.unwrap().len(), 1, "HOST names one address");
}

#[crate::routes]
mod serves_url {
    #[route("/check", get = serves_check)]
    pub struct Check;

    #[route("/items/{id}", get = serves_item)]
    pub struct Item {
        pub id: u32,
    }

    #[route("/files/{*rest}", get = serves_files)]
    pub struct Files {
        pub rest: String,
    }

    #[route("/cart/add", post = serves_check)]
    pub struct AddToCart;

    #[route("/cart/{id}", get = serves_cart_line)]
    pub struct CartLine {
        pub id: u32,
    }

    #[route("/both", post = serves_check, get = serves_check)]
    pub struct Both;

    #[route("/go", get = serves_go)]
    pub struct Go;
}

/// Every GET is a page here, but an API, Corten's own paths and its health checks are not.
#[crate::routes]
mod serves_catch_url {
    #[route("/{*page}", get = serves_any)]
    pub struct Page {
        pub page: String,
    }
}

#[tokio::test]
async fn a_catch_all_page_does_not_serve_an_api_or_cortens_own_paths() {
    let pwa = crate::pwa::Pwa::new(crate::pwa::Manifest::new("A", "A"));
    let router = App::new(serves_catch_url::router())
        .api::<ApiRoot>(|api| api.route::<ApiRates>(crate::Methods::reads(get(|| async { "rates" }))))
        .pwa(pwa)
        .router();
    for (p, want) in [
        ("/about/team", "local served"),
        ("/api/rates", "local elsewhere"),
        ("/api", "local elsewhere"),
        ("/health/live", "local elsewhere"),
        ("/corten/anything", "local elsewhere"),
        ("/manifest.webmanifest", "local elsewhere"),
        ("/service-worker.js", "local elsewhere"),
        ("/apis", "local served"),
    ] {
        let uri = format!("/check?p={}", form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>());
        let (status, _, body) = call_with(router.clone(), "GET", &uri, None, None).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, want), "{p:?}");
    }
}

/// Paths where matching by hand is easy to get wrong: an empty segment, a POST-only route the
/// router picks over a catch-all page, and a path routed by both the app and an area.
#[crate::routes]
mod serves_router_url {
    #[route("/check", get = serves_check)]
    pub struct Check;

    #[route("/items/{id}/edit", get = serves_edit)]
    pub struct Edit {
        pub id: String,
    }

    #[route("/x/{a}/y", post = serves_write)]
    pub struct Write {
        pub a: String,
    }

    #[route("/shop/cart", get = serves_page)]
    pub struct CartPage;

    #[route("/sitemap/{page}.xml", get = serves_sitemap)]
    pub struct Sitemap {
        pub page: u32,
    }

    #[route("/{*page}", get = serves_router_page)]
    pub struct Page {
        pub page: String,
    }
}

#[crate::routes(area = Shop)]
mod serves_shop_url {
    #[route("/shop")]
    pub struct Shop;

    #[route("/shop/cart", post = serves_page)]
    pub struct Cart;
}

#[derive(crate::Route)]
#[route("/shop/list")]
struct ShopList;

async fn serves_page() -> &'static str {
    "page"
}

// The routes above with a parameter in their path, each read by a handler that takes its `Params`.
async fn serves_edit(_: crate::Params<serves_router_url::Edit>) -> &'static str {
    serves_page().await
}

async fn serves_write(_: crate::Params<serves_router_url::Write>) -> &'static str {
    serves_page().await
}

async fn serves_sitemap(_: crate::Params<serves_router_url::Sitemap>) -> &'static str {
    serves_page().await
}

async fn serves_router_page(_: crate::Params<serves_router_url::Page>) -> &'static str {
    serves_page().await
}

async fn serves_item(_: crate::Params<serves_url::Item>, req: Req, uri: axum::http::Uri) -> String {
    serves_check(req, uri).await
}

async fn serves_files(_: crate::Params<serves_url::Files>, req: Req, uri: axum::http::Uri) -> String {
    serves_check(req, uri).await
}

async fn serves_cart_line(_: crate::Params<serves_url::CartLine>, req: Req, uri: axum::http::Uri) -> String {
    serves_check(req, uri).await
}

async fn serves_any(_: crate::Params<serves_catch_url::Page>, req: Req, uri: axum::http::Uri) -> String {
    serves_check(req, uri).await
}

/// `req.serves` says a path is served exactly when a GET to it reaches a page.
#[tokio::test]
async fn serves_agrees_with_the_router() {
    let router = App::new(serves_router_url::router())
        .area(|shop| serves_shop_url::area(shop).route::<ShopList>(crate::route::post(serves_page).get(serves_page)))
        .router();
    for (p, want) in [
        ("/items/7/edit", true),
        ("/items//edit", true),
        ("/items/7/", true),
        ("/x/1/y", false),
        ("/x//y", false),
        ("/x/1/z", true),
        ("/shop/cart", true),
        ("/shop/list", true),
        ("/about", true),
        ("/health/live", false),
        // The sitemap's route takes every path of its shape; one without its text is a 404.
        ("/sitemap/3.xml", true),
        ("/sitemap/about", false),
        ("/sitemap/.xml", false),
        ("/sitemap/3.xml/x", true),
    ] {
        let (status, _, body) = call_with(router.clone(), "GET", p, None, None).await;
        let routed = status == StatusCode::OK && body == "page";
        let uri = format!("/check?p={}", form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>());
        let (_, _, says) = call_with(router.clone(), "GET", &uri, None, None).await;
        assert_eq!((routed, says == "local served"), (want, want), "{p:?}: {status} {body:?}, serves says {says:?}");
    }
}

/// A redirect to the return address in `?p=`, or to `/check` when it is not on this site.
async fn serves_go(req: Req, uri: axum::http::Uri) -> HtmlResult {
    let p = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).find(|(k, _)| k == "p").map(|(_, v)| v.into_owned());
    match p.as_deref().and_then(crate::Local::parse) {
        Some(local) => req.redirect(&local),
        None => req.redirect(&serves_url::Check),
    }
}

/// Whether the app serves the path in `?p=`: "local served", "local elsewhere" or "not local".
async fn serves_check(req: Req, uri: axum::http::Uri) -> String {
    let p = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).find(|(k, _)| k == "p").map(|(_, v)| v.into_owned());
    match p.as_deref().and_then(crate::route::Local::parse) {
        Some(local) if req.serves(&local) => "local served".into(),
        Some(_) => "local elsewhere".into(),
        None => "not local".into(),
    }
}

/// A return address the app serves is one of its pages, its areas' included; an API route, a
/// static file or Corten's own routes are not; and nothing that leads off the site is a `Local`.
#[tokio::test]
async fn an_app_says_whether_it_serves_a_return_address() {
    let router = App::new(serves_url::router())
        .area::<admin_url::Admin>(admin_url::area)
        .api::<ApiRoot>(|api| api.route::<ApiRates>(crate::Methods::reads(get(|| async { "rates" }))))
        .router();
    for (p, want) in [
        ("/check", "local served"),
        ("/check?x=1#top", "local served"),
        ("/items/7", "local served"),
        ("/items/anything", "local served"),
        ("/files/a/b/c.txt", "local served"),
        ("/admin", "local served"),
        ("/admin/users/3", "local served"),
        ("/items", "local elsewhere"),
        ("/items/", "local elsewhere"),
        ("/items/7/edit", "local elsewhere"),
        ("/files/", "local elsewhere"),
        ("/check/", "local elsewhere"),
        ("/api/rates", "local elsewhere"),
        ("/health/live", "local elsewhere"),
        ("/admin/users", "local elsewhere"),
        ("/market/cart", "local elsewhere"),
        ("/cart/add", "local elsewhere"),
        ("/cart/7", "local served"),
        ("/cart/%61dd", "not local"),
        ("/both", "local served"),
        ("/items/..", "not local"),
        ("/check/../admin", "not local"),
        ("//evil.example/check", "not local"),
        ("/\\evil.example", "not local"),
        ("/\t/evil.example", "not local"),
        ("https://evil.example/check", "not local"),
        ("check", "not local"),
    ] {
        let uri = format!("/check?p={}", form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>());
        let (status, _, body) = call_with(router.clone(), "GET", &uri, None, None).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, want), "{p:?}");
    }
    for (p, location) in [("/items/7?tab=reviews", "/items/7?tab=reviews"), ("//evil.example", "/check")] {
        let uri = format!("/go?p={}", form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>());
        let (status, headers, _) = call_with(router.clone(), "GET", &uri, None, None).await;
        assert_eq!((status, headers["location"].to_str().unwrap()), (StatusCode::SEE_OTHER, location), "{p:?}");
    }
}

/// A `Public` answer with a header of the app's keeps it, and is compressed and shared as one
/// without it; a failure does not get it.
#[tokio::test]
async fn a_public_answer_takes_a_header_and_is_still_compressed() {
    use crate::answer::{Link, XRobotsTag};
    use axum::http::HeaderValue;
    let text = "# Example\n".repeat(400);
    let body = text.clone();
    let router = App::new(Routes::from(
        Router::new()
            .route(
                "/llms.txt",
                get(move || async move {
                    Public::new(Duration::from_secs(60), body)
                        .header::<XRobotsTag>(HeaderValue::from_static("noindex, nofollow"))
                        .header::<Link>(HeaderValue::from_static("</a>; rel=\"a\""))
                        .header::<Link>(HeaderValue::from_static("</b>; rel=\"b\""))
                }),
            )
            .route(
                "/gone",
                get(|| async {
                    Public::new(Duration::from_secs(60), crate::Result::<String>::Err(crate::Error::not_found()))
                        .header::<Link>(HeaderValue::from_static("</gone>; rel=\"gone\""))
                }),
            )
            .route(
                "/old",
                get(|req: Req| async move {
                    Public::new(Duration::from_secs(60), req.moved(&serves_url::Check))
                        .header::<Link>(HeaderValue::from_static("</check>; rel=\"canonical\""))
                }),
            ),
    ))
    .router();
    let req = Request::get("/llms.txt").header("accept-encoding", "zstd, br, gzip").body(Body::empty()).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let headers = res.headers();
    assert_eq!(headers["x-robots-tag"], "noindex, nofollow");
    assert_eq!(headers.get_all("link").iter().count(), 2, "{headers:?}");
    #[cfg(feature = "compress")]
    assert_eq!(headers["content-encoding"], "zstd", "{headers:?}");
    assert_eq!(headers["cache-control"], "public, max-age=60", "{headers:?}");
    // An error is the error page, without the answer's headers.
    let res = router.clone().oneshot(Request::get("/gone").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert!(res.headers().get("link").is_none(), "{:?}", res.headers());
    // A redirect keeps them.
    let res = router.oneshot(Request::get("/old").body(Body::empty()).unwrap()).await.unwrap();
    assert!(res.status().is_redirection(), "{}", res.status());
    assert_eq!(res.headers()["link"], "</check>; rel=\"canonical\"");
}

#[crate::routes]
mod policy_url {
    #[route("/", get = policy_page)]
    pub struct Home;

    #[route("/csp-reports", post = policy_reports)]
    pub struct CspReports;
}

/// Where the tests' pages send what their CSP blocks.
async fn policy_reports(_: axum::body::Bytes) -> StatusCode {
    StatusCode::NO_CONTENT
}

#[crate::routes(area = Pay)]
mod pay_url {
    #[route("/pay")]
    pub struct Pay;

    #[route("/pay/card", get = policy_page)]
    pub struct Card;
}

/// An area inside `/pay` that adds to it.
#[crate::routes(area = Charts)]
mod charts_url {
    #[route("/pay/charts")]
    pub struct Charts;

    #[route("/pay/charts/week", get = policy_page)]
    pub struct Week;
}

async fn policy_page(req: Req) -> HtmlResult {
    req.test_page("Page", html! { <p>"page"</p> })
}

fn policy_app() -> Router {
    App::new(policy_url::router())
        .policy(crate::security::Policy::new().img_src("https://img.example"))
        .area(|area| pay_url::area(area).policy(|p| p.script_src("https://js.stripe.com").frame_src("https://js.stripe.com")))
        .area(|area| charts_url::area(area).policy(|p| p.allow_style_attributes().script_src("https://js.stripe.com")))
        .router()
}

/// What a page answers: its CSP and its shell key.
async fn csp_and_shell(router: &Router, path: &str) -> (StatusCode, String, String) {
    let res = router.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
    let status = res.status();
    let csp = res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_string();
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    let shell = body.split(r#"name="corten-shell" content=""#).nth(1).map_or("", |rest| &rest[..16]).to_string();
    (status, csp, shell)
}

/// An area's policy adds to the app's on its pages only, nested areas add up, and a page whose
/// policy differs has another shell key, so a client navigation to it loads the document in full.
#[tokio::test]
async fn an_area_adds_to_the_policy_of_its_pages_only() {
    let router = policy_app();
    let (status, home, home_shell) = csp_and_shell(&router, "/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(home.contains("img-src 'self' data: https: https://img.example;") && home.contains("frame-src 'none';"), "{home}");
    assert!(!home.contains("stripe") && !home.contains("style-src-attr"), "{home}");
    let (_, card, card_shell) = csp_and_shell(&router, "/pay/card").await;
    assert!(card.contains(" https://js.stripe.com; style-src") && card.contains("frame-src https://js.stripe.com;"), "{card}");
    assert!(card.contains("https://img.example") && !card.contains("style-src-attr"), "the app's sources stay: {card}");
    let (_, week, week_shell) = csp_and_shell(&router, "/pay/charts/week").await;
    assert!(week.contains("frame-src https://js.stripe.com;") && week.ends_with("; style-src-attr 'unsafe-inline'"), "{week}");
    assert_eq!(week.matches("https://js.stripe.com").count(), 2, "a source both areas add is listed once: {week}");
    assert!(
        home_shell != card_shell && card_shell != week_shell && home_shell != week_shell,
        "{home_shell} {card_shell} {week_shell}"
    );
    // An unknown URL in the area is answered under its policy, as its pages are.
    let res = router.clone().oneshot(Request::get("/pay/nothing").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap(), card);
    // A write another site sent to the area is refused under the area's policy too.
    let cross = Request::post("/pay/card").header("sec-fetch-site", "cross-site").body(Body::empty()).unwrap();
    let res = router.clone().oneshot(cross).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap(), card);
    // A page outside every area that adds keeps the shell key it had without any.
    let img = || crate::security::Policy::new().img_src("https://img.example");
    let plain = App::new(policy_url::router()).policy(img()).router();
    assert_eq!(csp_and_shell(&plain, "/").await, (StatusCode::OK, home.clone(), home_shell.clone()));
    // An area that adds only what the app has keeps the app's policy and shell key: a navigation
    // into it is not a full load.
    let same = App::new(policy_url::router())
        .policy(img())
        .area(|area| pay_url::area(area).policy(|p| p.img_src("https://img.example")))
        .router();
    assert_eq!(csp_and_shell(&same, "/pay/card").await, (StatusCode::OK, home, home_shell));
}

/// An area that lets a script make its own Trusted Types policy names it on its pages only, which
/// therefore have another shell key; every page requires Trusted Types and allows the runtime's.
#[tokio::test]
async fn an_area_allows_a_trusted_types_policy_on_its_pages_only() {
    let router =
        App::new(policy_url::router()).area(|area| pay_url::area(area).policy(|p| p.trusted_types_policy("stripe"))).router();
    let (_, home, home_shell) = csp_and_shell(&router, "/").await;
    assert!(home.ends_with("; require-trusted-types-for 'script'; trusted-types corten"), "{home}");
    let (_, card, card_shell) = csp_and_shell(&router, "/pay/card").await;
    assert!(card.ends_with("; require-trusted-types-for 'script'; trusted-types corten stripe"), "{card}");
    assert_ne!(home_shell, card_shell);
}

/// Every denied feature, as the app sends them on a full document.
const DENIED: &str = "accelerometer=(), bluetooth=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), \
     hid=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), \
     window-management=()";

/// The `Permissions-Policy` of `GET path`, sent in `mode` (`corten: nav`, or `accept` JSON for
/// data).
async fn features(router: &Router, path: &str, mode: Option<&str>) -> Option<String> {
    let mut req = Request::get(path);
    match mode {
        Some("data") => req = req.header("accept", "application/json"),
        Some(mode) => req = req.header("corten", mode),
        None => {}
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    res.headers().get("permissions-policy").map(|value| value.to_str().unwrap().to_string())
}

/// A relayed page that brings a `Permissions-Policy` of its own.
async fn relayed_page() -> crate::Relay {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, axum::http::HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert("permissions-policy", axum::http::HeaderValue::from_static("camera=(self)"));
    crate::Relay::new(StatusCode::OK, headers, Body::from("<!doctype html><title>Relayed</title>"))
}

/// A relayed page with none, its type written in capitals.
async fn relayed_bare() -> crate::Relay {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, axum::http::HeaderValue::from_static("Text/HTML"));
    crate::Relay::new(StatusCode::OK, headers, Body::from("<!doctype html><title>Relayed</title>"))
}

/// `Policy::report_to`: every page's CSP names the endpoint, an area's too, and a full document
/// and the service worker's script say where it is, beside the app's own endpoints; an answer
/// drawn into a page, plain text, a relayed page and an API do not get it, and an API's CSP,
/// which allows nothing, names none.
#[tokio::test]
async fn a_report_endpoint_is_named_by_every_page_s_csp_and_sent_with_a_document() {
    use crate::security::{Feature, Policy};
    let extra = Router::new()
        .route("/text", get(|| async { "plain" }))
        .route("/relayed", get(relayed_page))
        .route(
            "/own",
            get(|req: Req| async move {
                let mut res = req.test_page("Own", html! { <p>"own"</p> }).into_response();
                res.headers_mut().append("reporting-endpoints", axum::http::HeaderValue::from_static(r#"default="/r""#));
                res
            }),
        )
        .route(
            "/own-csp",
            get(|req: Req| async move {
                let mut res = req.test_page("Own", html! { <p>"own"</p> }).into_response();
                res.headers_mut().append("reporting-endpoints", axum::http::HeaderValue::from_static(r#"csp="/elsewhere""#));
                res
            }),
        );
    let mut routes = policy_url::router();
    routes.0 = routes.0.merge(extra);
    let router = App::new(routes)
        .policy(Policy::new().report_to(&policy_url::CspReports))
        .area(|area| pay_url::area(area).policy(|p| p.allow_feature(Feature::Payment)))
        .api(|routes| api_module::api(routes, 100))
        .pwa(crate::pwa::Pwa::new(crate::pwa::Manifest::new("A", "A")))
        .router();
    let ours = r#"csp="/csp-reports""#;
    let get_with = |path: &'static str, mode: Option<&'static str>| {
        let router = router.clone();
        async move {
            let mut req = Request::get(path);
            if let Some(mode) = mode {
                req = req.header("corten", mode);
            }
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let csp = res.headers().get(header::CONTENT_SECURITY_POLICY).map(|v| v.to_str().unwrap().to_string());
            let sent: Vec<String> =
                res.headers().get_all("reporting-endpoints").iter().map(|v| v.to_str().unwrap().to_string()).collect();
            (csp.unwrap_or_default(), sent)
        }
    };
    for path in ["/", "/pay/card", "/nothing", "/service-worker.js"] {
        let (csp, sent) = get_with(path, None).await;
        assert!(csp.ends_with("; report-to csp"), "{path}: {csp}");
        assert_eq!(sent, [ours], "{path}");
    }
    for (path, mode) in [("/", Some("nav")), ("/", Some("action")), ("/text", None)] {
        let (csp, sent) = get_with(path, mode).await;
        assert!(csp.ends_with("; report-to csp") && sent.is_empty(), "{path} {mode:?} keeps the page's: {sent:?}");
    }
    let (csp, sent) = get_with("/relayed", None).await;
    assert!(sent.is_empty(), "a relayed page keeps its own: {csp} {sent:?}");
    let (csp, sent) = get_with("/v1/items/7", None).await;
    assert!(!csp.contains("report-to") && sent.is_empty(), "an API: {csp} {sent:?}");
    let (_, sent) = get_with("/own", None).await;
    assert_eq!(sent, [r#"default="/r""#, ours], "beside the app's own");
    let (_, sent) = get_with("/own-csp", None).await;
    assert_eq!(sent, [r#"csp="/elsewhere""#], "an answer that names its own csp endpoint keeps it");
    // Under `report_only`, the policy tried names the endpoint, which is what a trial is for.
    let trial = App::new(policy_url::router()).policy(Policy::new().report_only().report_to(&policy_url::CspReports)).router();
    let res = trial.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    let tried = res.headers()[header::CONTENT_SECURITY_POLICY_REPORT_ONLY].to_str().unwrap();
    assert!(tried.ends_with("; report-to csp") && !res.headers().contains_key(header::CONTENT_SECURITY_POLICY), "{tried}");
    assert_eq!(res.headers().get_all("reporting-endpoints").iter().collect::<Vec<_>>(), [ours]);
    // Without it, nothing is named and nothing sent.
    let plain = App::new(policy_url::router()).router();
    let res = plain.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    assert!(!res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("report-to"));
    assert!(!res.headers().contains_key("reporting-endpoints"));
}

/// A URL a browser would send no report to is refused at startup; the app's own route is taken
/// (a route without a `post` does not compile: `Policy::report_to`'s doctest).
#[test]
fn a_report_endpoint_a_browser_would_not_use_is_refused() {
    use crate::security::Policy;
    let takes = |url: &'static str| {
        let uri: axum::http::Uri = url.parse().expect("a URI");
        std::panic::catch_unwind(|| Policy::new().report_to(&uri)).is_ok()
    };
    assert!(std::panic::catch_unwind(|| Policy::new().report_to(&policy_url::CspReports)).is_ok());
    for url in [
        "https://reports.example.com/csp?app=1",
        "http://localhost:3000/r",
        "http://app.localhost/r",
        "http://127.0.0.1/r",
        "http://127.8.0.1/r",
        "http://[::1]:8080/r",
    ] {
        assert!(takes(url), "{url}");
    }
    for url in [
        // A path is the app's route, which is checked as one.
        "/csp-reports",
        "http://reports.example.com/csp",
        "http://127.0.0.1@evil.example/r",
        "http://127.evil.example/r",
        "https://user:pw@reports.example.com/r",
        "http://10.0.0.1/r",
        "ftp://reports.example.com/r",
        "//reports.example.com",
        // A port with no host parses, with an empty host.
        "https://:443/r",
        "csp-reports",
        // A path a Uri holds that the header's quoted string cannot.
        "https://c.example/r\"x",
        "https://c.example/a\\b",
        "https://c.example/é",
    ] {
        assert!(!takes(url), "{url}");
    }
}

/// A full document denies the powerful features, an area allows one on its pages only (with its
/// own shell key, since a document keeps the policy it loaded with), and an answer drawn into a
/// page, plain text or a relayed page's own policy is left alone.
#[tokio::test]
async fn a_full_document_denies_powerful_features_and_an_area_allows_one() {
    use crate::security::Feature;
    let router =
        App::new(policy_url::router()).area(|area| pay_url::area(area).policy(|p| p.allow_feature(Feature::Payment))).router();
    assert_eq!(features(&router, "/", None).await.as_deref(), Some(DENIED));
    assert_eq!(features(&router, "/nothing", None).await.as_deref(), Some(DENIED), "the error page is a document too");
    assert_eq!(features(&router, "/", Some("nav")).await, None, "a navigation is drawn into a page that has its own");
    assert_eq!(features(&router, "/", Some("action")).await, None, "so is a patch");
    assert_eq!(
        features(&router, "/", Some("data")).await.as_deref(),
        Some(DENIED),
        "a data client asked a page, which answers the document"
    );
    let pay = DENIED.replace("payment=(), ", "");
    assert_eq!(features(&router, "/pay/card", None).await, Some(pay.clone()));
    assert_eq!(features(&router, "/pay/nothing", None).await, Some(pay), "an unknown URL in the area");
    assert_ne!(csp_and_shell(&router, "/").await.2, csp_and_shell(&router, "/pay/card").await.2);
    // An area that allows only what the app allows keeps the app's policy and shell key.
    let same = App::new(policy_url::router())
        .policy(crate::security::Policy::new().allow_feature(Feature::Payment))
        .area(|area| pay_url::area(area).policy(|p| p.allow_feature(Feature::Payment)))
        .router();
    assert_eq!(csp_and_shell(&same, "/").await.2, csp_and_shell(&same, "/pay/card").await.2);
    assert_eq!(features(&same, "/", None).await, features(&same, "/pay/card", None).await);

    let other = App::new(Routes::from(
        Router::new()
            .route("/text", get(|| async { "plain" }))
            .route("/relayed", get(relayed_page))
            .route("/bare", get(relayed_bare))
            .route("/file.html", get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<!doctype html><title>F</title>") }))
            .route("/icon.svg", get(|| async { ([(header::CONTENT_TYPE, "image/svg+xml")], "<svg/>") }))
            .route("/feed.xml", get(|| async { ([(header::CONTENT_TYPE, "application/atom+xml")], "<feed/>") }))
            .route("/data.xml", get(|| async { ([(header::CONTENT_TYPE, "Text/XML; charset=utf-8")], "<a/>") }))
            .route("/says-swap", get(|| async { ([("content-type", "text/html"), ("corten-page", "1")], "<p>x</p>") }))
            .route(
                "/patch",
                get(|req: Req| async move {
                    let answer: HtmlResult = req.patch(html! { <p id={QtyId}>"3 left."</p> });
                    answer
                }),
            ),
    ))
    .router();
    assert_eq!(features(&other, "/text", None).await, None, "only a document has features to deny");
    assert_eq!(features(&other, "/relayed", None).await.as_deref(), Some("camera=(self)"), "a relayed page keeps its own");
    assert_eq!(features(&other, "/bare", None).await.as_deref(), Some(DENIED), "the type is read without case");
    assert_eq!(features(&other, "/file.html", None).await.as_deref(), Some(DENIED), "an HTML file the app serves");
    assert_eq!(features(&other, "/icon.svg", None).await.as_deref(), Some(DENIED), "an SVG opened on its own runs scripts");
    assert_eq!(features(&other, "/feed.xml", None).await.as_deref(), Some(DENIED), "a +xml type the browser may draw as XML");
    assert_eq!(features(&other, "/data.xml", None).await.as_deref(), Some(DENIED), "so can text/xml");
    assert_eq!(
        features(&other, "/file.html", Some("nav")).await.as_deref(),
        Some(DENIED),
        "decided by the answer: a navigation fetched an HTML file the browser may load from its cache as the page"
    );
    assert_eq!(features(&other, "/says-swap", Some("nav")).await, None, "the runtime draws it into its page");
    assert_eq!(features(&other, "/patch", Some("action")).await, None, "a patch is drawn into the page too");
    assert_eq!(features(&other, "/patch", None).await.as_deref(), Some(DENIED), "unless a browser loaded it as the page");
    assert_eq!(
        features(&other, "/says-swap", None).await.as_deref(),
        Some(DENIED),
        "a browser's own request loads whatever comes back as the page"
    );

    // Two areas whose policies differ only in a feature have different shell keys.
    let nested = App::new(policy_url::router())
        .area(|area| pay_url::area(area).policy(|p| p.allow_feature(Feature::Payment)))
        .area(|area| charts_url::area(area).policy(|p| p.allow_feature(Feature::Camera)))
        .router();
    let (_, pay_csp, pay_shell) = csp_and_shell(&nested, "/pay/card").await;
    let (_, charts_csp, charts_shell) = csp_and_shell(&nested, "/pay/charts/week").await;
    assert_eq!(pay_csp, charts_csp);
    assert_ne!(pay_shell, charts_shell);
    assert_eq!(
        features(&nested, "/pay/charts/week", None).await,
        Some(DENIED.replace("camera=(), ", "").replace("payment=(), ", ""))
    );
}

/// A header of the app's own middleware is kept, every line of it, after Corten's: it denies more
/// than `Feature` names, and the browser reads a feature's last entry.
struct DenyMore;

impl crate::Middleware for DenyMore {
    async fn call(&self, req: axum::extract::Request, next: impl crate::Next) -> axum::response::Response {
        let mut res = next.run(req).await;
        res.headers_mut().append("permissions-policy", axum::http::HeaderValue::from_static("fullscreen=()"));
        res.headers_mut().append("permissions-policy", axum::http::HeaderValue::from_static("camera=()"));
        res
    }
}

crate::assets::embed!(struct RefusedStatic = "src/assets/fixture");

/// An error page whose layout names a static file, as an app's does.
async fn asset_error_page(failure: Failure, req: Req) -> HtmlResult {
    let status = failure.status();
    let style = req.asset(RefusedStatic::STYLE_CSS).to_string();
    req.page(html! {
        <html>
            <head>
                <title>"Error"</title>
                <link rel="stylesheet" href={style}>
                <Corten />
            </head>
            <body><main>{status.as_str()}</main></body>
        </html>
    })
}

/// A cross-site write is refused before the handler's request is set up, and its error page is
/// still drawn with the app's state: the static files its layout names, not a panic.
#[tokio::test]
async fn a_refused_write_s_error_page_names_the_app_s_static_files() {
    let router = App::new(policy_url::router()).assets(RefusedStatic).error_page(asset_error_page, ()).router();
    let req = Request::post("/")
        .header("origin", "https://evil.example")
        .header("sec-fetch-site", "cross-site")
        .header("accept", "text/html")
        .body(Body::empty())
        .unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let page = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    // The versioned URL the app's static directory gives: `/assets/{12 hex digits}/style.css`.
    let href = page.split(r#"<link rel="stylesheet" href=""#).nth(1).and_then(|rest| rest.split('"').next()).unwrap_or("");
    let version = href.strip_prefix("/assets/").and_then(|rest| rest.strip_suffix("/style.css")).unwrap_or("");
    assert!(version.len() == 12 && version.bytes().all(|b| b.is_ascii_hexdigit()), "{href}: {page}");
    assert!(page.contains("<main>403</main>"), "{page}");
}

/// A refused write's error page, saying `text`.
fn refused_page(req: &Req, text: String) -> HtmlResult {
    req.page(html! {
        <html>
            <head>
                <title>"Error"</title>
                <Corten />
            </head>
            <body><main>{text}</main></body>
        </html>
    })
}

/// A refused write's request ends as every other request's does: its signal aborts once the
/// error page is sent, so work its page started cannot outlive it; and under `App::client_zone`
/// the page reads the visitor's zone.
#[tokio::test]
async fn a_refused_write_s_signal_ends_with_its_page_and_holds_the_visitor_s_zone() {
    let (sent, ended) = tokio::sync::oneshot::channel();
    let sent = std::sync::Arc::new(std::sync::Mutex::new(Some(sent)));
    let router = App::new(policy_url::router())
        .error_page(
            move |failure: Failure, req: Req| {
                let sent = sent.clone();
                async move {
                    if let Some(sent) = sent.lock().unwrap().take() {
                        let signal = req.signal().clone();
                        tokio::spawn(async move {
                            let _ = sent.send(signal.aborted().await);
                        });
                    }
                    refused_page(&req, failure.status().as_str().to_string())
                }
            },
            (),
        )
        .router();
    let refused = || {
        Request::post("/")
            .header("origin", "https://evil.example")
            .header("sec-fetch-site", "cross-site")
            .header("accept", "text/html")
            .body(Body::empty())
            .unwrap()
    };
    let res = router.oneshot(refused()).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let _ = res.into_body().collect().await.unwrap();
    let why = tokio::time::timeout(Duration::from_secs(5), ended).await.expect("the signal ended").unwrap();
    assert_eq!(why, crate::Abort::Responded);

    #[cfg(feature = "zones")]
    {
        use crate::i18n::Zone as _;
        // 2026-03-22T15:04:05Z: Chicago is on daylight time (UTC-5) since March 8.
        let at = std::time::UNIX_EPOCH + Duration::from_secs(1_774_191_845);
        let router = App::new(policy_url::router())
            .client_zone()
            .error_page(
                move |_: Failure, req: Req| async move {
                    let offset = req.zone().offset(at).to_string();
                    refused_page(&req, offset)
                },
                (),
            )
            .router();
        let mut req = refused();
        req.headers_mut().insert("cookie", axum::http::HeaderValue::from_static("corten-zone=America/Chicago"));
        let res = router.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        assert!(body.contains("<main>-18000</main>"), "{body}");
    }
}

/// A cross-site write a browser sent is refused with the error page, a full document; a router
/// under `Policy::apply` sends the header on its documents too; and an app's own header is kept.
#[tokio::test]
async fn a_refused_write_policy_apply_and_the_app_s_own_header_send_permissions_policy() {
    let router = App::new(policy_url::router()).router();
    let req = Request::post("/")
        .header("origin", "https://evil.example")
        .header("sec-fetch-site", "cross-site")
        .header("accept", "text/html")
        .body(Body::empty())
        .unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(res.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/html"));
    assert_eq!(res.headers()["permissions-policy"], DENIED);
    // The runtime's refused patch is drawn into its page: none.
    let req = Request::post("/")
        .header("origin", "https://evil.example")
        .header("sec-fetch-site", "cross-site")
        .header("corten", "action")
        .body(Body::empty())
        .unwrap();
    let res = App::new(policy_url::router()).router().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(res.headers().get("permissions-policy"), None, "a refused patch");

    let applied = crate::security::Policy::new().apply(
        Router::new()
            .route("/", get(|| async { axum::response::Html("<!doctype html><title>A</title>") }))
            .route("/says-swap", get(|| async { ([("content-type", "text/html"), ("corten-page", "1")], "<p>x</p>") })),
    );
    assert_eq!(features(&applied, "/", None).await.as_deref(), Some(DENIED));
    assert_eq!(
        features(&applied, "/", Some("nav")).await.as_deref(),
        Some(DENIED),
        "an answer that is not a corten-page swap is a document, whatever the request"
    );
    assert_eq!(features(&applied, "/says-swap", Some("nav")).await, None);
    assert_eq!(features(&applied, "/says-swap", None).await.as_deref(), Some(DENIED), "the request was the browser's own");

    let own = App::new(policy_url::router()).middleware(DenyMore).router();
    let res = own.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    let lines: Vec<_> = res.headers().get_all("permissions-policy").iter().map(|v| v.to_str().unwrap().to_string()).collect();
    assert_eq!(lines, [DENIED, "fullscreen=()", "camera=()"]);

    // A relayed page that brought no header gets Corten's first too; one that brought its own keeps it.
    let relayed = App::new(Routes::from(Router::new().route("/bare", get(relayed_bare)).route("/relayed", get(relayed_page))))
        .middleware(DenyMore)
        .router();
    for (path, first) in [("/bare", DENIED), ("/relayed", "camera=(self)")] {
        let res = relayed.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let lines: Vec<_> = res.headers().get_all("permissions-policy").iter().map(|v| v.to_str().unwrap().to_string()).collect();
        assert_eq!(lines, [first, "fullscreen=()", "camera=()"], "{path}");
    }
}

/// A form whose writes carry a submit key.
#[derive(serde::Deserialize, Fields)]
#[allow(dead_code)]
struct KeyedWrite {
    submit: crate::SubmitKey,
}

/// A page's `GET` and `HEAD` carry a weak tag of the body it rendered and its `corten-*`
/// headers, and one the client names in `If-None-Match` is answered `304` with no body (and is
/// not compressed): the same tag whether the body is compressed or not, another for another mode
/// or another `corten-*` header; a `304` still sets the page's cookie and varies as its `200`.
/// With `compress`, a client that accepts no compression is tagged only when it names a tag. A
/// file compression sends as it is is tagged too. Nothing else is
/// tagged: a body with this request's nonce or a submit key drawn for it, an answer nothing may
/// keep or that is immutable, one with a tag or an encoding of its own, a stream, a relayed page,
/// an error, a write, an API's answer, the runtime.
#[tokio::test]
async fn a_page_s_get_is_tagged_and_a_tag_the_client_has_is_answered_not_modified() {
    async fn send(
        router: Router,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        // As a browser asks, unless the case says otherwise.
        let mut req = Request::builder().method(method).uri(uri);
        if !headers.iter().any(|(name, _)| *name == "accept-encoding") {
            req = req.header("accept-encoding", "gzip");
        }
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        let (parts, body) = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
        (parts.status, parts.headers, body.collect().await.unwrap().to_bytes().to_vec())
    }
    async fn cookie_page(req: Req) -> crate::Result<HtmlResponse> {
        Ok(req.test_page("Cookie", html! { <p>"hi"</p> })?.with_cookie(SetCookie::new("seen", "1")))
    }
    async fn kept_page(req: Req) -> NoStore<HtmlResult> {
        NoStore(req.test_page("Kept", html! { <p>"hi"</p> }))
    }
    async fn keyed_page(req: Req) -> HtmlResult {
        req.test_page("Keyed", html! { <form method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> })
    }
    async fn keyed_patch(req: Req) -> HtmlResult {
        req.patch(html! { <form id={MsgId} method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> })
    }
    async fn keyed_rendered(req: Req) -> HtmlResult {
        let form = req.rendered(html! { <form method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> });
        let placed = &form;
        req.test_page("Keyed", html! { {placed} })
    }
    async fn plain_patch(req: Req) -> HtmlResult {
        req.patch(html! { <p id={MsgId}>"read again"</p> })
    }
    fn html(extra: &[(&'static str, &'static str)]) -> axum::response::Response {
        use axum::response::IntoResponse;
        let mut res = axum::response::Html("<p>same</p>").into_response();
        for (name, value) in extra {
            res.headers_mut().insert(*name, axum::http::HeaderValue::from_static(value));
        }
        res
    }
    let png: &'static [u8] = b"\x89PNG\r\n\x1a\n";
    let routes = Router::new()
        .route("/big", get(big_policy_page))
        .route("/inline", get(inline_page))
        .route("/cookie", get(cookie_page))
        .route("/kept", get(kept_page))
        .route("/keyed", get(keyed_page))
        .route("/keyed-patch", get(keyed_patch))
        .route("/keyed-rendered", get(keyed_rendered))
        .route("/plain-patch", get(plain_patch))
        .route("/same", get(|| async { html(&[]) }))
        .route("/noticed", get(|| async { html(&[("corten-notice", "m=Saved")]) }))
        .route("/own-tag", get(|| async { html(&[("etag", "\"own\"")]) }))
        .route("/encoded", get(|| async { html(&[("content-encoding", "gzip")]) }))
        .route("/whole", get(|| async { html(&[("cache-control", "no-transform")]) }))
        .route("/immutable", get(move || async move { Public::immutable(crate::Media::new("image/png", png)) }))
        .route("/picture", get(move || async move { crate::Media::new("image/png", png) }))
        .route("/export", get(|| async { crate::Media::new("text/csv", "id\n7\n") }))
        .route("/relayed", get(relayed_page))
        .route(
            "/stream",
            get(|| async {
                let chunk = Ok::<_, std::convert::Infallible>(axum::body::Bytes::from_static(b"<p>streamed</p>"));
                ([(header::CONTENT_TYPE, "text/html")], Body::from_stream(futures_util::stream::iter([chunk])))
            }),
        );
    let router = || {
        App::new(Routes::from(routes.clone().merge(self::routes())))
            .error_page(test_error_page, ())
            .middleware(AsViewer(None))
            .api(|routes| api_module::api(routes, 100))
            .router()
    };
    let tag_of = |headers: &axum::http::HeaderMap| headers.get("etag").map(|v| v.to_str().unwrap().to_string());

    let (status, headers, body) = send(router(), "GET", "/", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let tag = tag_of(&headers).expect("a page is tagged");
    assert!(tag.len() == 20 && tag.starts_with("W/\"") && tag.ends_with('"'), "{tag}");
    let (_, again, same) = send(router(), "GET", "/", &[]).await;
    assert_eq!((tag_of(&again).as_deref(), same), (Some(tag.as_str()), body), "the same body, the same tag");

    for has in [tag.clone(), tag[2..].to_string(), format!("\"other\", {tag}"), format!("W/\"a\",{}", &tag[2..]), "*".to_string()]
    {
        let (status, headers, body) = send(router(), "GET", "/", &[("if-none-match", &has)]).await;
        assert_eq!((status, body.len()), (StatusCode::NOT_MODIFIED, 0), "{has}");
        assert_eq!(tag_of(&headers).as_deref(), Some(tag.as_str()), "{has}");
        assert!(!headers.contains_key("content-type") && !headers.contains_key("content-length"), "{headers:?}");
        assert_eq!(headers["cache-control"], "private, no-cache");
        assert!(headers.contains_key("content-security-policy") && headers.contains_key("corten-shell"), "{headers:?}");
    }
    // Each `If-None-Match` line counts, as one list.
    let (status, ..) = send(router(), "GET", "/", &[("if-none-match", "\"other\""), ("if-none-match", &tag)]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    for has in ["\"other\"", "", "garbage", &format!("{tag}x"), &tag[..tag.len() - 1]] {
        let (status, headers, _) = send(router(), "GET", "/", &[("if-none-match", has)]).await;
        assert_eq!((status, tag_of(&headers).as_deref()), (StatusCode::OK, Some(tag.as_str())), "{has}");
    }

    // A client that accepts no compression and names no tag (a benchmark, `curl`) is not sent one;
    // one that names a tag is answered as a browser is.
    let identity = ("accept-encoding", "identity");
    let (_, headers, _) = send(router(), "GET", "/", &[identity]).await;
    assert_eq!(headers.contains_key("etag"), !cfg!(feature = "compress"), "without compression every client: {headers:?}");
    let (status, ..) = send(router(), "GET", "/", &[identity, ("if-none-match", &tag)]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);

    let (_, first, _) = send(router(), "GET", "/cookie", &[]).await;
    let (status, headers, _) = send(router(), "GET", "/cookie", &[("if-none-match", &tag_of(&first).unwrap())]).await;
    assert_eq!((status, &headers["set-cookie"]), (StatusCode::NOT_MODIFIED, &first["set-cookie"]));

    // A navigation is another body, so another tag; the document's does not match it.
    let (_, nav, _) = send(router(), "GET", "/", &[("corten", "nav")]).await;
    let nav_tag = tag_of(&nav).expect("a navigation is tagged");
    assert_ne!(nav_tag, tag);
    let (status, ..) = send(router(), "GET", "/", &[("corten", "nav"), ("if-none-match", &tag)]).await;
    assert_eq!(status, StatusCode::OK);
    let (status, ..) = send(router(), "GET", "/", &[("corten", "nav"), ("if-none-match", &nav_tag)]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);

    // Compressed or not, one weak tag; a 304 skips compression and still varies on the coding.
    let (_, plain, _) = send(router(), "GET", "/big", &[]).await;
    let big = tag_of(&plain).unwrap();
    let (_, zipped, _) = send(router(), "GET", "/big", &[("accept-encoding", "br")]).await;
    assert_eq!(tag_of(&zipped).as_deref(), Some(big.as_str()));
    assert_eq!(zipped.get("content-encoding").is_some(), cfg!(feature = "compress"));
    let (status, headers, body) = send(router(), "GET", "/big", &[("accept-encoding", "br"), ("if-none-match", &big)]).await;
    assert_eq!((status, body.len()), (StatusCode::NOT_MODIFIED, 0));
    assert!(!headers.contains_key("content-encoding"));
    let vary: Vec<_> = headers.get_all("vary").iter().map(|v| v.to_str().unwrap().to_string()).collect();
    let zipped_vary: Vec<_> = zipped.get_all("vary").iter().map(|v| v.to_str().unwrap().to_string()).collect();
    assert_eq!(vary, zipped_vary, "a 304 has the 200's Vary");

    // An answer compression sends as it is (an image, `no-transform`) is tagged too, its 304 saving
    // the body, and a 304 that does not vary on the coding is not made to.
    let vary = |h: &axum::http::HeaderMap| h.get_all("vary").iter().map(|v| v.to_str().unwrap().to_string()).collect::<Vec<_>>();
    for uri in ["/picture", "/whole", "/export"] {
        let (_, first, _) = send(router(), "GET", uri, &[]).await;
        let (status, headers, body) = send(router(), "GET", uri, &[("if-none-match", &tag_of(&first).expect(uri))]).await;
        assert_eq!((status, body.len()), (StatusCode::NOT_MODIFIED, 0), "{uri}");
        assert_eq!(vary(&headers), vary(&first), "{uri}: a 304 has the 200's Vary");
    }
    let (_, picture, _) = send(router(), "GET", "/picture", &[]).await;
    assert!(!vary(&picture).iter().any(|v| v.contains("accept-encoding")), "an image does not vary on the coding");

    // A HEAD is the GET's answer without its body: the same tag, and a 304 for it.
    let (status, headers, body) = send(router(), "HEAD", "/", &[]).await;
    assert_eq!((status, tag_of(&headers).as_deref(), body.len()), (StatusCode::OK, Some(tag.as_str()), 0));
    let (status, ..) = send(router(), "HEAD", "/", &[("if-none-match", "*")]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);

    // The same body with a notice is another answer: a copy without one is not reused for it, and a
    // copy with one is not reused for a page without (a cache would keep the stored notice).
    let (_, same, _) = send(router(), "GET", "/same", &[]).await;
    let (_, noticed, _) = send(router(), "GET", "/noticed", &[]).await;
    let (same, noticed) = (tag_of(&same).unwrap(), tag_of(&noticed).unwrap());
    assert_ne!(same, noticed);
    let (status, ..) = send(router(), "GET", "/same", &[("if-none-match", &noticed)]).await;
    assert_eq!(status, StatusCode::OK);

    // A tag of the answer's own is left as it is, and Corten does not answer it.
    let (status, headers, _) = send(router(), "GET", "/own-tag", &[("if-none-match", "\"own\"")]).await;
    assert_eq!((status, headers["etag"].to_str().unwrap()), (StatusCode::OK, "\"own\""));

    // A patch read again is tagged, and answered 304 for its tag.
    let action = ("corten", "action");
    let (status, headers, _) = send(router(), "GET", "/plain-patch", &[action]).await;
    let patch_tag = tag_of(&headers).expect("a patch read again is tagged");
    assert_eq!(status, StatusCode::OK);
    let (status, ..) = send(router(), "GET", "/plain-patch", &[action, ("if-none-match", &patch_tag)]).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);

    // Each answers as it would untagged (a 200, or the error), with no tag and no 304.
    for (method, uri, extra, answer, why) in [
        ("GET", "/inline", None, StatusCode::OK, "this request's nonce"),
        ("GET", "/keyed", None, StatusCode::OK, "a submit key drawn for this request"),
        ("GET", "/keyed-patch", Some(("corten", "action")), StatusCode::OK, "a patch with a submit key drawn for this request"),
        ("GET", "/keyed-rendered", None, StatusCode::OK, "a submit key drawn into a Rendered placed in the page"),
        ("GET", "/kept", None, StatusCode::OK, "no-store"),
        ("GET", "/immutable", None, StatusCode::OK, "immutable"),
        ("GET", "/encoded", None, StatusCode::OK, "an encoding of its own"),
        ("GET", "/stream", None, StatusCode::OK, "a stream"),
        ("GET", "/relayed", None, StatusCode::OK, "a relayed page"),
        ("GET", "/nothing", None, StatusCode::NOT_FOUND, "an error"),
        ("POST", "/", Some(("corten", "action")), StatusCode::OK, "a write (its patch)"),
        ("GET", "/v1/items/7", None, StatusCode::OK, "an API's answer"),
    ] {
        let mut asked = vec![("if-none-match", "*")];
        asked.extend(extra);
        if method == "POST" {
            asked.push(("sec-fetch-site", "same-origin"));
        }
        let (status, headers, _) = send(router(), method, uri, &asked).await;
        assert!(status == answer && !headers.contains_key("etag"), "{why}: {status} {headers:?}");
    }
    let (status, headers, _) = send(router(), "GET", runtime_path(), &[("if-none-match", "*")]).await;
    assert!(
        status == StatusCode::OK && headers.get("etag").is_none_or(|t| !t.to_str().unwrap().starts_with("W/")),
        "the runtime: {headers:?}"
    );
}

/// A page large enough to compress.
async fn big_policy_page(req: Req) -> HtmlResult {
    let text = "x".repeat(2048);
    req.test_page("Page", html! { <p>{text}</p> })
}

/// A header of the app's own, as a request id is.
struct AddRequestId;

impl crate::Middleware for AddRequestId {
    async fn call(&self, req: axum::extract::Request, next: impl crate::Next) -> axum::response::Response {
        let mut res = next.run(req).await;
        res.headers_mut().insert("x-request-id", axum::http::HeaderValue::from_static("0123456789abcdef"));
        res
    }
}

/// An error page large enough to compress.
async fn big_error_page(_: Failure, req: Req) -> HtmlResult {
    let text = "x".repeat(2048);
    req.test_page("Error", html! { <p>{text}</p> })
}

/// A page's header map starts at the capacity 13 slots give (24), and with HSTS and compression the
/// headers each case sends need no more: a compressed page (14 headers, with its `ETag`), the
/// default error page (12, uncompressed), a compressed app error page (13, with `X-Robots-Tag`)
/// and a page with a header of the app's own (15). A map of 12 that grew once also ends at 24, so the starting
/// capacity is what tells them apart.
#[tokio::test]
async fn a_page_s_header_map_holds_permissions_policy_without_growing() {
    use crate::security::{Feature, Policy};
    async fn capacity(policy: Policy, path: &str, own: bool, big_error: bool) -> (usize, bool, usize, bool) {
        let routes = Routes::from(Router::new().route("/", get(big_policy_page)));
        let mut app = App::new(routes).policy(policy.hsts());
        if big_error {
            app = app.error_page(big_error_page, ());
        }
        let router = if own { app.middleware(AddRequestId).router() } else { app.router() };
        let req = Request::get(path).header("accept-encoding", "br").body(Body::empty()).unwrap();
        let res = router.oneshot(req).await.unwrap();
        let headers = res.headers();
        (
            headers.capacity(),
            headers.contains_key("permissions-policy"),
            headers.keys_len(),
            headers.contains_key("content-encoding"),
        )
    }
    let every = [
        Feature::Accelerometer,
        Feature::Bluetooth,
        Feature::Camera,
        Feature::DisplayCapture,
        Feature::Geolocation,
        Feature::Gyroscope,
        Feature::Hid,
        Feature::IdleDetection,
        Feature::LocalFonts,
        Feature::Magnetometer,
        Feature::Microphone,
        Feature::Midi,
        Feature::Payment,
        Feature::Serial,
        Feature::Usb,
        Feature::WindowManagement,
    ];
    let none = || every.into_iter().fold(Policy::new(), Policy::allow_feature);
    let reserved = axum::http::HeaderMap::<axum::http::HeaderValue>::with_capacity(13).capacity();
    // A page starts with this capacity, so ending with it means the map never grew (12 slots grown
    // once end at the same size).
    let start = crate::page::html_response(StatusCode::OK, String::new(), None);
    assert_eq!(start.headers().capacity(), reserved);
    // Without `compress` nothing is compressed and each sends one header fewer.
    let zipped = cfg!(feature = "compress");
    let less = usize::from(!zipped);
    for (case, path, own, big_error, names, compressed) in [
        ("a compressed page", "/", false, false, 14 - less, zipped),
        ("the default error page", "/nothing", false, false, 12, false),
        ("a compressed app error page", "/nothing", false, true, 13 - less, zipped),
        ("a page with the app's own header", "/", true, false, 15 - less, zipped),
    ] {
        let (with, sent, count, encoded) = capacity(Policy::new(), path, own, big_error).await;
        let (without, not_sent, ..) = capacity(none(), path, own, big_error).await;
        assert!(sent && !not_sent, "{case}");
        assert_eq!(count, names, "{case}");
        assert_eq!(encoded, compressed, "{case} compressed");
        assert_eq!((with, without), (reserved, reserved), "{case}");
    }
}

/// A page whose policy lets scripts load from another host allows the `default` Trusted Types
/// policy and makes it in a script at `<Corten />`, allowed by its hash, so a script can set such
/// a URL (an SDK's loader, and the SDK loading its parts); a page whose app makes `default`
/// itself, or that loads only from its own origin, a keyword or a scheme, does not. A page that
/// makes it and one that does not never share a shell key, as a document keeps the policy it
/// loaded with.
#[tokio::test]
async fn a_page_that_loads_scripts_from_another_host_makes_the_default_policy() {
    let tag = format!("<script>{}</script>", crate::security::SCRIPT_LOADS);
    let hash = crate::security::hash_source(crate::security::SCRIPT_LOADS);
    let page = |router: Router, path: &'static str| {
        let tag = tag.clone();
        async move {
            let res = router.oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
            let csp = res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_string();
            let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
            let shell = body.split(r#"name="corten-shell" content=""#).nth(1).map_or("", |rest| &rest[..16]).to_string();
            (csp, body.contains(&tag), shell)
        }
    };
    let router = policy_app();
    let (home, home_makes, home_shell) = page(router.clone(), "/").await;
    assert!(home.ends_with("trusted-types corten") && !home.contains(&hash) && !home_makes, "{home}");
    let (card, card_makes, card_shell) = page(router.clone(), "/pay/card").await;
    assert!(card.ends_with("trusted-types corten default") && card.contains(&hash) && card_makes, "{card}");
    assert_ne!(home_shell, card_shell);
    // A keyword, a nonce, a hash or a scheme alone names no host.
    for source in ["'wasm-unsafe-eval'", "data:", "https:"] {
        let router = App::new(policy_url::router()).policy(crate::security::Policy::new().script_src(source)).router();
        let (csp, makes, _) = page(router, "/").await;
        assert!(csp.ends_with("trusted-types corten") && !csp.contains(&hash) && !makes, "{source}: {csp}");
    }
    // Under 'strict-dynamic' the browser ignores the hosts listed, so nothing would hold the load.
    for keyword in ["'strict-dynamic'", "'Strict-Dynamic'"] {
        let dynamic = crate::security::Policy::new().script_src("https://js.stripe.com").script_src(keyword);
        let (csp, makes, _) = page(App::new(policy_url::router()).policy(dynamic).router(), "/").await;
        assert!(csp.ends_with("trusted-types corten") && !csp.contains(&hash) && !makes, "{keyword}: {csp}");
    }
    // An app that allows `default` by name makes it: no page of its makes it too.
    let stripe = || crate::security::Policy::new().script_src("https://js.stripe.com");
    let own = App::new(policy_url::router())
        .area(|area| pay_url::area(area).policy(|p| p.script_src("https://js.stripe.com").trusted_types_policy("default")))
        .router();
    let (csp, makes, _) = page(own, "/pay/card").await;
    assert!(csp.ends_with("trusted-types corten default") && !csp.contains(&hash) && !makes, "{csp}");
    // App-wide, every page; an area of it that makes its own has another policy and shell key.
    let app = App::new(policy_url::router())
        .policy(stripe())
        .area(|area| pay_url::area(area).policy(|p| p.trusted_types_policy("default")))
        .router();
    let (csp, makes, app_shell) = page(app.clone(), "/").await;
    assert!(csp.ends_with("trusted-types corten default") && csp.contains(&hash) && makes, "{csp}");
    let (csp, makes, own_shell) = page(app, "/pay/card").await;
    assert!(!csp.contains(&hash) && !makes && own_shell != app_shell, "{csp}");
    // And so does an inner area that makes its own, under one whose pages the runtime's covers.
    let nested = App::new(policy_url::router())
        .area(|area| pay_url::area(area).policy(|p| p.script_src("https://js.stripe.com")))
        .area(|area| charts_url::area(area).policy(|p| p.trusted_types_policy("default")))
        .router();
    let (_, outer_makes, outer_shell) = page(nested.clone(), "/pay/card").await;
    let (_, inner_makes, inner_shell) = page(nested, "/pay/charts/week").await;
    assert!(outer_makes && !inner_makes && outer_shell != inner_shell, "{outer_shell} {inner_shell}");
}

/// An area relaxes the opener policy on its pages only (Stripe's Connect embedded components
/// sign in through a popup that needs `unsafe-none`), and a page under another one has another
/// shell key, since a document keeps the opener policy it loaded with.
#[tokio::test]
async fn an_area_relaxes_the_opener_policy_of_its_pages_only() {
    async fn opener(router: &Router, path: &str) -> (StatusCode, String, String) {
        let res = router.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let opener = res.headers()["cross-origin-opener-policy"].to_str().unwrap().to_string();
        let (status, _, shell) = csp_and_shell(router, path).await;
        (status, opener, shell)
    }
    let router =
        App::new(policy_url::router()).area(|area| pay_url::area(area).policy(|p| p.allow_cross_origin_opener())).router();
    let (_, home, home_shell) = opener(&router, "/").await;
    assert_eq!(home, "same-origin");
    let (_, card, card_shell) = opener(&router, "/pay/card").await;
    assert_eq!(card, "unsafe-none");
    assert_ne!(home_shell, card_shell, "a navigation into the area loads the document in full");
    assert_eq!(csp_and_shell(&router, "/").await.1, csp_and_shell(&router, "/pay/card").await.1, "the CSP is the app's");
    // An unknown URL in the area is answered under its policy, as its pages are.
    assert_eq!(opener(&router, "/pay/nothing").await.1, "unsafe-none");
    // Only relaxing: an area's allow_popups under an app that allows any opener changes nothing,
    // and one the app already has keeps the app's shell key.
    let open = App::new(policy_url::router())
        .policy(crate::security::Policy::new().allow_cross_origin_opener())
        .area(|area| pay_url::area(area).policy(|p| p.allow_popups()))
        .router();
    let (_, open_home, open_shell) = opener(&open, "/").await;
    assert_eq!(
        (open_home.as_str(), opener(&open, "/pay/card").await),
        ("unsafe-none", (StatusCode::OK, "unsafe-none".into(), open_shell))
    );
    // Nested areas add up: one inside an area that loosens it keeps the looser value, and a
    // write another site sent there is refused under it too.
    let nested = App::new(policy_url::router())
        .area(|area| pay_url::area(area).policy(|p| p.allow_cross_origin_opener()))
        .area(|area| charts_url::area(area).policy(|p| p.allow_popups().script_src("https://js.stripe.com")))
        .router();
    assert_eq!(opener(&nested, "/pay/charts/week").await.1, "unsafe-none");
    let cross = Request::post("/pay/charts/week").header("sec-fetch-site", "cross-site").body(Body::empty()).unwrap();
    let refused = nested.clone().oneshot(cross).await.unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(refused.headers()["cross-origin-opener-policy"], "unsafe-none");
    let popups = App::new(policy_url::router())
        .policy(crate::security::Policy::new().allow_popups())
        .area(|area| pay_url::area(area).policy(|p| p.allow_popups()))
        .router();
    let (_, popups_home, popups_shell) = opener(&popups, "/").await;
    assert_eq!(popups_home, "same-origin-allow-popups");
    assert_eq!(opener(&popups, "/pay/card").await.2, popups_shell);
}

/// Work a handler finishes (`Signal::finish`) runs past the handler being dropped: its slow step
/// sees why it should stop, and what follows it (a release) runs, whether the client left, the
/// deadline passed or the server is shutting down, which waits for it.
#[tokio::test]
async fn finished_work_releases_what_it_holds_when_the_handler_is_dropped() {
    use std::{sync::Mutex, time::Duration};
    use tokio::io::AsyncWriteExt;
    let released: Arc<Mutex<Vec<(&'static str, crate::Abort)>>> = Arc::default();
    let routes = {
        let released = released.clone();
        Routes::from(Router::new().route(
            "/{name}",
            get(move |signal: crate::Signal, axum::extract::Path(name): axum::extract::Path<String>| {
                let released = released.clone();
                async move {
                    let name: &'static str = Box::leak(name.into_boxed_str());
                    signal
                        .finish(move |signal| async move {
                            // The slow call, which only the signal ends.
                            let reason = signal.aborted().await;
                            // A release that outlasts the connection: `/slow-release` takes 500 ms.
                            let release = if name == "gone" { 500 } else { 30 };
                            tokio::time::sleep(Duration::from_millis(release)).await;
                            released.lock().unwrap().push((name, reason));
                            "done"
                        })
                        .await
                }
            }),
        ))
    };
    // Long enough that only `/late` meets it on a loaded machine.
    let app = App::new(routes).deadline(Some(Duration::from_secs(1))).shutdown_grace(Duration::from_secs(2));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let wait_for = |name: &'static str| {
        let released = released.clone();
        async move {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Some((_, reason)) = released.lock().unwrap().iter().find(|(n, _)| *n == name) {
                        return *reason;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("{name}: the release never ran"))
        }
    };

    // The client leaves mid-call.
    let mut left = tokio::net::TcpStream::connect(addr).await.unwrap();
    left.write_all(b"GET /left HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(left);
    assert_eq!(wait_for("left").await, crate::Abort::Disconnected);

    // The deadline passes: the client gets 503 and the work still releases.
    let answer = raw_get(addr, "/late", "").await;
    assert!(answer.starts_with("HTTP/1.1 503"), "{answer}");
    assert_eq!(wait_for("late").await, crate::Abort::Deadline);

    // Shutdown during two calls: one whose client is still there is told (`Shutdown`) and
    // answers; one whose client left is still releasing, and serve waits for it.
    let kept = tokio::spawn(raw_get(addr, "/kept", ""));
    let mut gone = tokio::net::TcpStream::connect(addr).await.unwrap();
    gone.write_all(b"GET /gone HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(gone);
    let began = std::time::Instant::now();
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), server).await.expect("serve returned").unwrap().unwrap();
    assert!(began.elapsed() >= Duration::from_millis(400), "serve did not wait for the release: {:?}", began.elapsed());
    let done: Vec<_> = released.lock().unwrap().clone();
    // Its client left as shutdown began: either is the first reason, and either way it released.
    assert!(done.iter().any(|(name, _)| *name == "gone"), "serve returned before the work it had to finish: {done:?}");
    assert!(done.contains(&("kept", crate::Abort::Shutdown)), "{done:?}");
    assert!(kept.await.unwrap().ends_with("done"), "the client that stayed got its answer");
}

/// A panic in work a handler finishes is the handler's: the request answers 500 and the server
/// goes on.
#[tokio::test]
async fn a_panic_in_finished_work_is_the_handlers() {
    let router = App::new(Routes::from(Router::new().route(
        "/",
        get(|signal: crate::Signal| async move {
            signal.finish(|_signal| async move { panic!("the release failed") }).await;
            "never"
        }),
    )))
    .router();
    let (status, _, _) = call(router.clone(), "GET", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let (status, _, _) = call(router, "GET", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "the server goes on after it");
}

#[crate::routes]
mod referrer_url {
    #[route("/relayed/{policy}", get = relayed)]
    pub struct Relayed<'a> {
        pub policy: &'a str,
    }
}

/// An answer that brings a policy of its own, as a relayed service's does.
async fn relayed(Params(at): Params<referrer_url::Relayed<'_>>) -> crate::Result<crate::Relay> {
    let mut headers = axum::http::HeaderMap::new();
    // `|` between lines of their own.
    for line in at.policy.split('|') {
        headers.append(header::REFERRER_POLICY, axum::http::HeaderValue::from_str(line).unwrap());
    }
    headers.insert(header::LOCATION, axum::http::HeaderValue::from_static("https://elsewhere.example/cb?code=1"));
    Ok(crate::Relay::new(StatusCode::FOUND, headers, Body::empty()))
}

/// An area or the app makes `Referrer-Policy` stricter, never looser; an area that changes it has
/// its own shell key (a document keeps the policy it loaded with); and an answer that brings a
/// stricter one keeps it, while a looser one is replaced.
#[tokio::test]
async fn an_area_or_an_answer_makes_the_referrer_policy_stricter_only() {
    use crate::security::{Policy, Referrer};
    async fn referrer(router: &Router, path: &str) -> String {
        let res = router.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        res.headers()[header::REFERRER_POLICY].to_str().unwrap().to_string()
    }
    let router =
        App::new(policy_url::router()).area(|area| pay_url::area(area).policy(|p| p.referrer(Referrer::NoReferrer))).router();
    assert_eq!(referrer(&router, "/").await, "strict-origin-when-cross-origin");
    assert_eq!(referrer(&router, "/pay/card").await, "no-referrer");
    assert_eq!(referrer(&router, "/pay/nothing").await, "no-referrer", "an unknown URL in the area too");
    assert_ne!(csp_and_shell(&router, "/").await.2, csp_and_shell(&router, "/pay/card").await.2);
    // An API inside the area keeps its own CSP and sends the area's referrer policy, an unknown URL
    // in it too.
    let api = App::new(policy_url::router())
        .area(|area| pay_url::area(area).policy(|p| p.referrer(Referrer::NoReferrer)))
        .api::<PayApi>(|api| api.route::<PayApiGo>(crate::Methods::reads(get(|| async { "go" }))))
        .router();
    assert_eq!(referrer(&api, "/pay/api/go").await, "no-referrer");
    assert_eq!(referrer(&api, "/pay/api/nope").await, "no-referrer");
    assert_eq!(referrer(&api, "/").await, "strict-origin-when-cross-origin");
    // Two that each send less somewhere send the least of both: strict-origin to this site and
    // nothing to others has no name, so it is nothing.
    let nested = App::new(policy_url::router())
        .policy(Policy::new().referrer(Referrer::StrictOrigin))
        .area(|area| pay_url::area(area).policy(|p| p.referrer(Referrer::SameOrigin)))
        .router();
    assert_eq!(referrer(&nested, "/").await, "strict-origin");
    assert_eq!(referrer(&nested, "/pay/card").await, "no-referrer");
    // Two policies that both send nothing are one: the area keeps the app's shell key.
    let nothing = App::new(policy_url::router())
        .policy(Policy::new().referrer(Referrer::StrictOrigin).referrer(Referrer::SameOrigin))
        .area(|area| pay_url::area(area).policy(|p| p.referrer(Referrer::NoReferrer)))
        .router();
    assert_eq!(referrer(&nothing, "/").await, "no-referrer");
    assert_eq!(csp_and_shell(&nothing, "/").await.2, csp_and_shell(&nothing, "/pay/card").await.2);
    // The same value the app has is no change, and keeps the app's shell key.
    let same = App::new(policy_url::router())
        .policy(Policy::new().referrer(Referrer::SameOrigin))
        .area(|area| pay_url::area(area).policy(|p| p.referrer(Referrer::SameOrigin)))
        .router();
    assert_eq!(csp_and_shell(&same, "/").await.2, csp_and_shell(&same, "/pay/card").await.2);
    // An answer's own policy is kept when it is stricter, and the stricter of both otherwise.
    let relay = App::new(referrer_url::router()).router();
    for (brought, sent) in [
        ("no-referrer", "no-referrer"),
        ("same-origin", "same-origin"),
        ("unsafe-url", "strict-origin-when-cross-origin"),
        ("x-unknown", "strict-origin-when-cross-origin"),
        // `origin` sends only the origin to this site too.
        ("origin", "strict-origin"),
        ("unsafe-url, strict-origin", "strict-origin"),
        // The browser skips a token it does not know and uses the last one it does.
        ("no-referrer, x-future-policy", "no-referrer"),
        // Several lines are one list.
        ("unsafe-url|no-referrer", "no-referrer"),
        ("same-origin|unsafe-url", "strict-origin-when-cross-origin"),
    ] {
        let path = referrer_url::Relayed { policy: brought }.href();
        assert_eq!(referrer(&relay, &path).await, sent, "{brought}");
    }
    let strict = App::new(referrer_url::router()).policy(Policy::new().referrer(Referrer::StrictOrigin)).router();
    let path = referrer_url::Relayed { policy: "same-origin" }.href();
    assert_eq!(referrer(&strict, &path).await, "no-referrer", "the least of the app's and the answer's");
}

#[crate::routes]
mod page_or_url {
    #[route("/runs/{id}", get = page_or_run)]
    pub struct Run<'a> {
        pub id: &'a str,
        pub said: Option<&'a str>,
    }

    #[route("/runs/{id}/download", post = page_or_download)]
    pub struct Download<'a> {
        pub id: &'a str,
    }
}

async fn page_or_run(_: Params<page_or_url::Run<'_>>) -> &'static str {
    "run"
}

/// The file for run 7, the run's page saying why for any other.
async fn page_or_download(req: Req, Params(at): Params<page_or_url::Download<'_>>) -> crate::Result<crate::PageOr<crate::Media>> {
    if at.id != "7" {
        return Ok(req.redirect(&page_or_url::Run { id: &at.id, said: Some("stale") })?.into());
    }
    Ok(crate::Media::new("text/csv", "sku,qty\n").into())
}

/// A route that sends a file answers a redirect or a page instead when it refuses, as a page is:
/// private, with the app's headers.
#[tokio::test]
async fn a_file_route_answers_a_page_when_it_refuses() {
    let router = App::new(page_or_url::router()).router();
    let (status, headers, body) = call_with(router.clone(), "POST", "/runs/7/download", None, None).await;
    assert_eq!(
        (status, headers[header::CONTENT_TYPE].to_str().unwrap(), body.as_str()),
        (StatusCode::OK, "text/csv", "sku,qty\n")
    );
    let (status, headers, _) = call_with(router, "POST", "/runs/8/download", None, None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "/runs/8?said=stale");
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache");
    assert!(headers.contains_key(header::CONTENT_SECURITY_POLICY));
}

#[derive(Default, crate::Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct KeptPaging {
    pub sort_by: Option<String>,
    pub page_no: Option<u32>,
}

#[derive(crate::Route)]
#[route("/kept")]
pub struct Kept {
    pub q: Option<String>,
    pub tags: Vec<String>,
    #[route(prefix = "dim.")]
    pub dims: std::collections::BTreeMap<String, String>,
    #[route(query)]
    pub paging: KeptPaging,
}

#[test]
fn keep_query_keeps_every_key_the_controls_do_not_name() {
    use crate::form::keep_query;
    let at = Kept {
        q: Some("a \"b\" <c>".into()),
        tags: vec!["x".into(), "y".into()],
        dims: [("color".to_string(), "red".to_string()), ("size".to_string(), "9".to_string())].into(),
        paging: KeptPaging { sort_by: Some("price".into()), page_no: Some(3) },
    };
    // A set's field, a prefixed entry and a list, each named by a control: none is kept.
    let html = keep_query(
        &at,
        html! {
            <select name="sortBy"><option>"price"</option></select>
            <input name="dim.color" value="blue">
            for tag in ["x", "z"] { <input type="checkbox" name="tags" value={tag}> }
        },
    )
    .to_html();
    assert!(!html.contains(r#"type="hidden" name="sortBy""#) && !html.contains(r#"type="hidden" name="tags""#), "{html}");
    assert!(!html.contains(r#"type="hidden" name="dim.color""#), "{html}");
    assert!(
        html.ends_with(concat!(
            r#"<input type="hidden" name="q" value="a &quot;b&quot; &lt;c&gt;">"#,
            r#"<input type="hidden" name="dim.size" value="9">"#,
            r#"<input type="hidden" name="pageNo" value="3">"#,
        )),
        "the rest, escaped, in the route's order: {html}"
    );
    // Text that only looks like a name is not one.
    let html = keep_query(&at, html! { <p>" name=\"q\""</p> }).to_html();
    assert!(html.contains(r#"type="hidden" name="q""#), "{html}");
    // A link given as `&dyn Href` (a form several pages share) works the same.
    let shared: &dyn crate::Href = &at;
    assert!(keep_query(shared, "").to_html().contains(r#"name="pageNo" value="3""#));
    // A route with no query keeps nothing.
    assert_eq!(
        keep_query(&Kept { q: None, tags: vec![], dims: Default::default(), paging: KeptPaging::default() }, "x").to_html(),
        "x"
    );
}

/// Layout reads (`App::layout_read`): a value only the layout shows, read beside the page's own.
mod layout_reads {
    use super::*;
    use crate::{later, Caller, LayoutRead};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    /// The header's cart count: 3 after `delay`, counting the reads started and finished.
    #[derive(Clone, Default)]
    struct CartCount {
        delay: Duration,
        started: Arc<AtomicUsize>,
        finished: Arc<AtomicUsize>,
    }

    impl LayoutRead for CartCount {
        type Value = u32;

        fn start(&self, _: &axum::http::request::Parts) -> Option<impl std::future::Future<Output = u32> + Send + 'static> {
            self.started.fetch_add(1, Ordering::SeqCst);
            let (delay, finished) = (self.delay, self.finished.clone());
            Some(async move {
                tokio::time::sleep(delay).await;
                finished.fetch_add(1, Ordering::SeqCst);
                3
            })
        }

        fn view(count: &u32) -> impl Render + '_ {
            html! { <span class="count">{*count}</span> }
        }
    }

    /// Who the layout says is signed in, from the request's one lookup of the caller.
    struct SignedIn;

    impl LayoutRead for SignedIn {
        type Value = Option<&'static str>;

        fn start(
            &self,
            parts: &axum::http::request::Parts,
        ) -> Option<impl std::future::Future<Output = Option<&'static str>> + Send + 'static> {
            let parts = parts.clone();
            Some(async move { Caller::<Viewer>::find(&parts, &()).await.ok().map(|Caller(Viewer(name))| name) })
        }

        fn view(name: &Self::Value) -> impl Render + '_ {
            html! { <b>{name.unwrap_or("guest")}</b> }
        }
    }

    /// A read no app starts here.
    struct Unread;

    impl LayoutRead for Unread {
        type Value = ();

        fn start(&self, _: &axum::http::request::Parts) -> Option<impl std::future::Future<Output = ()> + Send + 'static> {
            Some(async {})
        }

        fn view((): &()) -> impl Render + '_ {
            html! { "never" }
        }
    }

    /// The tests' layout with the count in its header.
    #[crate::component]
    fn Layout(req: &Req, children: impl Render) -> impl Document {
        html! {
            <!DOCTYPE html>
            <html lang={req.lang()}>
                <head>
                    <meta charset="utf-8">
                    <title>"Shop"</title>
                    <Corten />
                </head>
                <body>
                    <header>"Cart "{later::<CartCount>()}{later::<SignedIn>()}</header>
                    <main>{children}</main>
                    <footer>{later::<CartCount>()}</footer>
                </body>
            </html>
        }
    }

    /// A refused form is drawn again by a helper, from two branches and a closure: none of them
    /// takes the count.
    fn refused(req: &Req, why: &str) -> HtmlResult {
        req.page::<ForOne>(Layout { req, children: html! { <p>{why}</p> } })
    }

    /// A page for everyone.
    async fn for_all(req: Req) -> Public<HtmlResult> {
        Public::new(Duration::from_secs(60), req.page(Layout { req: &req, children: html! { <p>"for all"</p> } }))
    }

    /// A route that answers text, not a page, and takes `Req`.
    async fn as_text(_req: Req) -> &'static str {
        "text"
    }

    /// A page named in a routes module, which says it answers a page.
    async fn typed(req: Req) -> HtmlResult {
        req.page(Layout { req: &req, children: html! { <p>"typed"</p> } })
    }

    /// A page or a file, named in a routes module: a page when it draws one.
    async fn page_or_file(req: Req) -> crate::Result<crate::PageOr<crate::Media>> {
        Ok(req.page::<ForOne>(Layout { req: &req, children: html! { <p>"page or file"</p> } })?.into())
    }

    /// The shop's routes `#[corten::routes]` makes, which say what they answer.
    #[crate::routes]
    mod shop_url {
        #[route("/public", get = for_all)]
        pub struct ForAll;

        #[route("/text", get = as_text)]
        pub struct AsText;

        #[route("/typed", get = typed)]
        pub struct Typed;

        #[route("/page-or-file", get = page_or_file)]
        pub struct PageOrFile;
    }

    fn shop(count: CartCount, page_delay: Duration) -> Router {
        let routes =
            Router::new()
                .route(
                    "/",
                    get(move |req: Req| async move {
                        tokio::time::sleep(page_delay).await; // the page's own reads
                        req.page::<ForOne>(Layout { req: &req, children: html! { <p>"home"</p> } })
                    })
                    .post(|req: Req| async move { req.redirect::<ForOne>(&Done) }),
                )
                .route(
                    "/form",
                    get(|req: Req| async move {
                        let short = req.path().len() < 3;
                        let draw = |why: &str| refused(&req, why);
                        if short {
                            return refused(&req, "too short");
                        }
                        if req.mode.swaps() {
                            return refused(&req, "again");
                        }
                        draw("closure")
                    }),
                )
                .route(
                    "/cart",
                    get(|req: Req| async move {
                        req.page::<ForOne>(Layout { req: &req, children: html! { <p>"cart"</p> } })
                            .map(|page| page.give::<CartCount>(7))
                    }),
                )
                .route(
                    "/fails",
                    get(|_req: Req| async move {
                        tokio::time::sleep(Duration::from_millis(10)).await; // the page's own reads, which fail
                        Err::<HtmlResponse, _>(Error::new("the store is down"))
                    }),
                )
                .route("/refused", get(|_req: Req| async move { crate::Refused::forbidden().into_response() }))
                .route(
                    "/slow-down",
                    get(|_req: Req| async move { crate::Refused::too_many(Duration::from_secs(1)).into_response() }),
                )
                .route("/conflict", get(|_req: Req| async move { Err::<HtmlResponse, _>(Error::status(StatusCode::CONFLICT)) }))
                .route("/down", get(|_req: Req| async move { (StatusCode::SERVICE_UNAVAILABLE, "down for maintenance") }))
                .route("/gone", get(|_req: Req| async move { Err::<HtmlResponse, _>(Error::not_found()) }))
                .route(
                    "/refuse-write",
                    axum::routing::post(|_req: Req| async move { crate::Refused::forbidden().into_response() }),
                )
                .route(
                    "/not-yours",
                    get(|_req: Req| async move {
                        tokio::time::sleep(Duration::from_millis(5)).await; // the handler's own check
                        Err::<HtmlResponse, Error>(crate::Refused::forbidden().into())
                    }),
                )
                .route(
                    "/handler-slows",
                    get(|_req: Req| async move {
                        Err::<HtmlResponse, Error>(crate::Refused::too_many(Duration::from_secs(2)).into())
                    }),
                )
                .route(
                    "/who",
                    get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! { <p>"who"</p> } }) }),
                )
                .route(
                    "/unread",
                    get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: later::<Unread>() }) }),
                )
                .route(
                    "/mine",
                    get(|req: Req, Caller(Viewer(name)): Caller<Viewer>| async move {
                        req.page::<ForOne>(Layout { req: &req, children: html! { <p>{name}</p> } })
                    }),
                )
                .route(
                    "/inside",
                    get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: later::<CartCount>() }) }),
                );
        let typed = shop_url::router();
        App::new(Routes(typed.0.merge(routes), typed.1))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(count)
            .layout_read(SignedIn)
            .middleware(AsViewer(Some("ada")))
            .router()
    }

    #[tokio::test]
    async fn the_layout_draws_its_read_where_it_put_later_and_no_handler_passes_it() {
        let count = CartCount::default();
        let (status, _, body) = call(shop(count.clone(), Duration::ZERO), "GET", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#), "{body}");
        assert!(body.contains(r#"<footer><span class="count">3</span></footer>"#), "drawn in each place: {body}");
        assert!(!body.contains("corten-later"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "read once for both places");

        let (_, _, form) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/form", None, None).await;
        assert!(form.contains(r#"Cart <span class="count">3</span>"#) && form.contains("<p>closure</p>"), "{form}");
    }

    /// A page route named in a routes module starts the read when the request arrives, as one that
    /// takes `Req` does, whether it answers a page alone or a page or a file.
    #[tokio::test]
    async fn a_routes_module_page_draws_the_read_once() {
        for path in ["/typed", "/page-or-file"] {
            let count = CartCount::default();
            let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", path, None, None).await;
            assert_eq!(status, StatusCode::OK, "{path}");
            assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#), "{path}: {body}");
            assert_eq!(count.started.load(Ordering::SeqCst), 1, "{path}");
        }
    }

    #[tokio::test]
    async fn a_navigation_keeps_its_layout_so_the_read_is_not_started() {
        let count = CartCount::default();
        let (_, _, body) = call(shop(count.clone(), Duration::ZERO), "GET", Some("nav")).await;
        assert_eq!(body, "<title>Shop</title><p>home</p>");
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn the_read_runs_beside_the_page_s_own_reads() {
        let count = CartCount { delay: Duration::from_millis(60), ..CartCount::default() };
        let at = tokio::time::Instant::now();
        let (_, _, body) = call(shop(count, Duration::from_millis(56)), "GET", None).await;
        assert!(body.contains(r#"<span class="count">3</span>"#), "{body}");
        assert_eq!(at.elapsed(), Duration::from_millis(60), "the longer of the two, not their sum");
    }

    #[tokio::test(start_paused = true)]
    async fn a_page_that_gives_the_value_does_not_wait_and_a_redirect_cancels_the_read() {
        let count = CartCount { delay: Duration::from_millis(60), ..CartCount::default() };
        let at = tokio::time::Instant::now();
        let (_, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/cart", None, None).await;
        assert!(body.contains(r#"Cart <span class="count">7</span>"#), "{body}");
        assert_eq!(at.elapsed(), Duration::ZERO, "the page's value, not the read's");

        let (status, _, _) = call(shop(count.clone(), Duration::ZERO), "POST", None).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(count.finished.load(Ordering::SeqCst), 0, "neither read ran to its end");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "a write that redirects starts none");
    }

    #[tokio::test]
    async fn the_error_page_for_a_5xx_draws_a_read_that_is_in_and_starts_or_waits_for_none() {
        // The page's own reads failed after the count was in: drawn.
        let (status, _, body) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/fails", None, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#) && body.contains("<p>500</p>"),
            "{body}"
        );
        // A read still running (the store the page failed on is down): drawn without it, at once.
        let at = std::time::Instant::now();
        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let (status, _, body) = call_with(shop(slow, Duration::ZERO), "GET", "/fails", None, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(body.contains("<header>Cart <b>ada</b></header>") && body.contains("<p>500</p>"), "{body}");
        assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
        // A 429 (a client being slowed down) waits for none either.
        let at = std::time::Instant::now();
        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let (status, _, body) = call_with(shop(slow, Duration::ZERO), "GET", "/slow-down", None, None).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert!(!body.contains("count") && body.contains("<p>429</p>"), "{body}");
        assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
    }

    #[tokio::test]
    async fn the_error_page_for_a_4xx_starts_the_reads_and_waits_for_them() {
        // An unknown address, which no route called: started for the error page, with its head,
        // and drawn.
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/nowhere", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains(r#"<header>Cart <span class="count">3</span>"#) && body.contains("<p>404</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "started once, for the error page");
        // A refusal after the route started them: the read still running is waited for.
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/refused", None, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>403</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "not started again for the error page");
        // A wrong method, which no handler answered.
        let count = CartCount::default();
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "DELETE", "/", None, None).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>405</p>"), "{body}");
        // A `HEAD` has no body, so it starts none.
        let count = CartCount::default();
        let (status, _, _) = call_with(shop(count.clone(), Duration::ZERO), "HEAD", "/nowhere", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn the_error_page_for_a_4xx_waits_no_later_than_the_deadline() {
        let count = CartCount { delay: Duration::from_secs(60), ..CartCount::default() };
        let router = App::new(Routes::from(Router::new()))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .deadline(Duration::from_secs(2))
            .router();
        let (status, _, body) = call_with(router, "GET", "/nowhere", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "sent in time, without the count: {body}");
        assert!(body.contains("<header>Cart <b>guest</b></header>") && body.contains("<p>404</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "started for the error page");
        assert_eq!(count.finished.load(Ordering::SeqCst), 0);
    }

    /// A handler's own refusal (`Err(Refused::forbidden())?`) is the request's fault, as an
    /// extractor's is: its error page waits for the reads and draws them (#890). A 429 from it
    /// keeps its `Retry-After` and, as an extractor's 429, waits for none.
    #[tokio::test]
    async fn a_handlers_refusal_is_answered_as_an_extractors() {
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/not-yours", None, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>403</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "started once, by the route");

        let at = std::time::Instant::now();
        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let res = shop(slow, Duration::ZERO)
            .oneshot(Request::get("/handler-slows").header("accept", "text/html").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(res.headers().get("retry-after").and_then(|v| v.to_str().ok()), Some("2"));
        assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
    }

    #[tokio::test]
    async fn the_error_page_for_a_handlers_own_4xx_waits_for_none() {
        // A handler may answer a store that is down with a 4xx (a 424): what failed is likely what
        // the read needs, so the error page is not held up for it, as for a 5xx.
        let at = std::time::Instant::now();
        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let (status, _, body) = call_with(shop(slow, Duration::ZERO), "GET", "/conflict", None, None).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(!body.contains("count") && body.contains("<p>409</p>"), "{body}");
        assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
        // Plain text at a 5xx (a maintenance middleware's) is not the request's fault either.
        let at = std::time::Instant::now();
        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let (status, _, body) = call_with(shop(slow, Duration::ZERO), "GET", "/down", None, Some("text/html")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(!body.contains("count") && body.contains("<p>503</p>"), "{body}");
        assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
    }

    #[tokio::test]
    async fn the_error_page_for_a_handlers_404_or_a_refused_write_waits_for_the_reads() {
        // A handler that found nothing: an unknown address like any other.
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/gone", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>404</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
        // A write the handler refused: the reads start once, with the error page's head.
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "POST", "/refuse-write", None, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>403</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
    }

    /// A read whose `start` panics (it expects what a middleware puts on the head).
    struct PanicsAtStart;

    impl LayoutRead for PanicsAtStart {
        type Value = u32;

        fn start(&self, _: &axum::http::request::Parts) -> Option<impl std::future::Future<Output = u32> + Send + 'static> {
            panic!("no tenant on the head");
            #[allow(unreachable_code)]
            Some(async { 0 })
        }

        fn view(count: &u32) -> impl Render + '_ {
            html! { <span class="tenant">{*count}</span> }
        }
    }

    #[tokio::test]
    async fn a_read_that_panics_as_it_starts_draws_nothing_on_a_page_or_an_error_page() {
        for (path, status) in [("/", StatusCode::OK), ("/nowhere", StatusCode::NOT_FOUND)] {
            let count = CartCount::default();
            let router = App::new(Routes::from(Router::new().route(
                "/",
                get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! { <p>"home"</p> } }) }),
            )))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(PanicsAtStart)
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .router();
            let (got, _, body) = call_with(router, "GET", path, None, None).await;
            assert_eq!(got, status, "{path}: {body}");
            assert!(body.contains(r#"<span class="count">3</span>"#) && !body.contains("tenant"), "{path}: {body}");
        }
    }

    #[tokio::test]
    async fn a_read_that_takes_req_does_not_lock_the_request() {
        let routes = Router::new().route(
            "/",
            get(|req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <header>{later::<Lang>()}</header>
                            <main></main>
                        </body>
                    </html>
                })
            }),
        );
        let router = App::new(Routes::from(routes)).layout_read(Lang).router();
        let (_, _, body) = tokio::time::timeout(Duration::from_secs(5), call(router, "GET", None)).await.expect("answered");
        assert!(body.contains("<i>en</i>"), "{body}");
    }

    /// The page's language, read through `Req`.
    struct Lang;

    impl LayoutRead for Lang {
        type Value = &'static str;

        fn start(
            &self,
            parts: &axum::http::request::Parts,
        ) -> Option<impl std::future::Future<Output = &'static str> + Send + 'static> {
            let mut parts = parts.clone();
            Some(async move {
                use axum::extract::FromRequestParts;
                let req = Req::from_request_parts(&mut parts, &()).await.unwrap();
                req.lang()
            })
        }

        fn view<'a>(lang: &'a &'static str) -> impl Render + 'a {
            html! { <i>{*lang}</i> }
        }
    }

    /// A sign-out form in the header, with this request's submit key.
    struct SignOut;

    impl LayoutRead for SignOut {
        type Value = ();

        fn start(&self, _: &axum::http::request::Parts) -> Option<impl std::future::Future<Output = ()> + Send + 'static> {
            Some(async {})
        }

        fn view(_: &()) -> impl Render + '_ {
            html! { <form method="post">{crate::SubmitKey::field(super::KeyedWrite::FIELDS.submit)}</form> }
        }
    }

    #[tokio::test]
    async fn a_view_that_draws_a_submit_key_leaves_the_page_untagged() {
        let page = |req: Req, read: bool| async move {
            req.page::<ForOne>(html! {
                <html>
                    <head>
                        <title>"Shop"</title>
                        <Corten />
                    </head>
                    <body>
                        <header>if read { {later::<SignOut>()} }</header>
                        <main></main>
                    </body>
                </html>
            })
        };
        let routes =
            Router::new().route("/", get(move |req: Req| page(req, true))).route("/plain", get(move |req: Req| page(req, false)));
        let router = App::new(Routes::from(routes)).layout_read(SignOut).router();
        // A browser's request, which names a tag it has, so it is answered with one.
        let get = |router: Router, uri: &'static str| async move {
            let req = Request::get(uri).header("accept", "text/html").header("if-none-match", "\"other\"");
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let (parts, body) = res.into_parts();
            (parts.status, parts.headers, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
        };
        let (status, headers, body) = get(router.clone(), "/").await;
        assert!(status == StatusCode::OK && body.contains("name=\"submit\""), "{body}");
        assert!(!headers.contains_key("etag"), "a key drawn by the layout makes the page unrepeatable: {headers:?}");
        let (_, headers, _) = get(router, "/plain").await;
        assert!(headers.contains_key("etag"), "{headers:?}");
    }

    /// Middleware that puts a value on the request, as a pool's connection would be.
    #[derive(Clone)]
    struct Holds(Arc<()>);

    impl crate::Middleware for Holds {
        async fn call(&self, mut req: axum::extract::Request, next: impl crate::Next) -> Response {
            req.extensions_mut().insert(self.0.clone());
            next.run(req).await
        }
    }

    #[tokio::test]
    async fn a_write_lets_go_of_the_request_whatever_it_answers() {
        let held = Arc::new(());
        let routes = Router::new()
            .route("/", get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! {} }) }))
            .route("/done", get(|| async { "done" }))
            .route(
                "/write",
                axum::routing::post(|req: Req| async move { req.redirect::<ForOne>(&Done) })
                    .put(|_req: Req| async move { Err::<HtmlResponse, _>(Error::new("down")) }),
            );
        let router = App::new(Routes::from(routes))
            .layout_read(CartCount::default())
            .layout_read(SignedIn)
            .middleware(Holds(held.clone()))
            .router();
        // The middleware and this test hold it; the request must not, once answered.
        let before = Arc::strong_count(&held);
        for method in ["POST", "PUT"] {
            let (status, ..) = call_with(router.clone(), method, "/write", None, Some("text/html")).await;
            assert!(status.is_redirection() || status.is_server_error(), "{method}: {status}");
            assert_eq!(Arc::strong_count(&held), before, "{method}: the request's head is not kept after it");
        }
    }

    /// A write another site sent is refused before anything of the app's runs, so its error page
    /// draws the layout without the reads: none is started (one may look up who is asking).
    #[tokio::test]
    async fn a_cross_site_write_s_error_page_draws_the_layout_without_its_reads() {
        let count = CartCount::default();
        let req = Request::post("/")
            .header("origin", "https://evil.example")
            .header("sec-fetch-site", "cross-site")
            .header("accept", "text/html")
            .body(Body::empty())
            .unwrap();
        let res = shop(count.clone(), Duration::ZERO).oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        assert!(body.contains("<p>403</p>") && !body.contains("count") && !body.contains("corten-later"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_refused_write_draws_the_reads_and_a_slow_one_is_left_out_at_the_deadline() {
        let routes = Router::new().route(
            "/form",
            axum::routing::post(|req: Req| async move { refused(&req, "too short") })
                .get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! {} }) }),
        );
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).layout_read(SignedIn).router();
        let (status, headers, body) = call_with(router, "POST", "/form", None, Some("text/html")).await;
        assert!(status.is_success() && body.contains(r#"<span class="count">3</span>"#), "{status} {body}");
        assert_eq!(headers[axum::http::header::CACHE_CONTROL], "private, no-cache");

        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let routes =
            Router::new().route("/", get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! {} }) }));
        let router =
            App::new(Routes::from(routes)).deadline(Duration::from_millis(200)).layout_read(slow).layout_read(SignedIn).router();
        let began = std::time::Instant::now();
        let (status, _, body) = call(router, "GET", None).await;
        assert!(status.is_success() && !body.contains("count") && !body.contains("corten-later"), "{status} {body}");
        assert!(began.elapsed() < Duration::from_secs(2), "{:?}", began.elapsed());
    }

    #[tokio::test]
    async fn a_public_answer_draws_no_ones_value_whatever_started_the_read() {
        // A plain axum handler takes `Req`, which starts the reads before its answer is known.
        let routes = Router::new().route("/", get(for_all));
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).layout_read(SignedIn).router();
        let (status, headers, body) = call(router, "GET", None).await;
        assert!(status.is_success() && !body.contains("count") && !body.contains("corten-later"), "{body}");
        assert!(headers[axum::http::header::CACHE_CONTROL].to_str().unwrap().starts_with("public"), "{headers:?}");
    }

    /// A count whose view panics.
    struct BrokenView;

    /// What [`BrokenView`] draws: it panics as it renders, counted in [`EXPLODED`].
    struct Explodes;

    static EXPLODED: AtomicUsize = AtomicUsize::new(0);

    impl Render for Explodes {
        fn render(&self, _: &mut String) {
            EXPLODED.fetch_add(1, Ordering::SeqCst);
            panic!("the view broke")
        }
    }

    impl LayoutRead for BrokenView {
        type Value = u32;

        fn start(&self, _: &axum::http::request::Parts) -> Option<impl std::future::Future<Output = u32> + Send + 'static> {
            Some(async { 1 })
        }

        fn view(_: &u32) -> impl Render + '_ {
            Explodes
        }
    }

    #[tokio::test]
    async fn a_view_that_panics_draws_nothing_on_the_error_page_too() {
        let page = |req: &Req, children: &'static str| {
            req.page::<ForOne>(html! {
                <html>
                    <head>
                        <title>"Shop"</title>
                        <Corten />
                    </head>
                    <body>
                        <header>{later::<BrokenView>()}</header>
                        <main>{children}</main>
                    </body>
                </html>
            })
        };
        let routes = Router::new()
            .route("/", get(move |req: Req| async move { page(&req, "home") }))
            // Takes `Req`, so the read starts and is in by the time the error page draws it.
            .route("/fails", get(|_req: Req| async { Err::<HtmlResponse, _>(Error::new("down")) }));
        let router = App::new(Routes::from(routes))
            .error_page(move |_: Failure, req: Req| async move { page(&req, "failed") }, ())
            .layout_read(BrokenView)
            .router();
        let (status, _, body) = call(router.clone(), "GET", None).await;
        assert!(status.is_success() && body.contains("<header></header>"), "{status} {body}");
        assert_eq!(EXPLODED.load(Ordering::SeqCst), 1);
        let (status, _, body) = call_with(router, "GET", "/fails", None, Some("text/html")).await;
        assert_eq!(EXPLODED.load(Ordering::SeqCst), 2, "the error page drew the view: {body}");
        assert!(status.is_server_error() && body.contains("failed") && body.contains("<header></header>"), "{status} {body}");
    }

    /// A badge that renders its count through a string of its own.
    #[crate::component]
    fn Badge() -> impl Render {
        crate::raw(later::<CartCount>().to_html())
    }

    #[tokio::test]
    async fn a_place_rendered_through_a_string_of_its_own_is_filled_where_it_is() {
        let routes = Router::new().route(
            "/",
            get(|req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <nav>{crate::raw("<!--corten-later-0-->")}</nav>
                            <header><Badge /></header>
                            <main></main>
                        </body>
                    </html>
                })
            }),
        );
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).router();
        let (status, _, body) = call(router, "GET", None).await;
        assert!(status.is_success(), "{status} {body}");
        assert!(body.contains(r#"<header><span class="count">3</span></header>"#), "{body}");
        assert!(body.contains("<nav><!--corten-later-0--></nav>"), "text the page wrote is left alone: {body}");
    }

    /// A badge that writes its place's string twice.
    #[crate::component]
    fn TwoBadges() -> impl Render {
        let place = later::<CartCount>().to_html();
        crate::raw(format!("{place}|{place}"))
    }

    /// A badge that writes its place's string as text, escaped.
    #[crate::component]
    fn TextBadge() -> impl Render {
        later::<CartCount>().to_html()
    }

    /// In a debug build, a place written twice or as text is an error naming it, rather than one
    /// copy drawn and the other sent (holding the page's token).
    // A debug build's check.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_place_written_twice_or_as_text_is_an_error() {
        let page = |req: Req, twice: bool| async move {
            req.page::<ForOne>(html! {
                <html>
                    <head>
                        <title>"Shop"</title>
                        <Corten />
                    </head>
                    <body>
                        <header>
                            if twice {
                                <TwoBadges />
                            } else {
                                <TextBadge />
                            }
                        </header>
                        <main></main>
                    </body>
                </html>
            })
        };
        let routes = Router::new()
            .route("/twice", get(move |req: Req| page(req, true)))
            .route("/text", get(move |req: Req| page(req, false)));
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).router();
        // The log names the read and says which (`more than once`, `as text`).
        for path in ["/twice", "/text"] {
            let (status, _, body) = call_with(router.clone(), "GET", path, None, None).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{path}: {body}");
            assert!(!body.contains("corten-later"), "{path}: {body}");
        }
    }

    // A debug build's check.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_place_in_the_head_is_an_error() {
        let routes = Router::new().route(
            "/",
            get(|req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop "{later::<CartCount>()}</title>
                            <Corten />
                        </head>
                        <body><main></main></body>
                    </html>
                })
            }),
        );
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).router();
        let (status, _, body) = call(router, "GET", None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    }

    #[tokio::test]
    async fn a_read_that_looks_up_the_caller_makes_the_page_private_and_keeps_the_key_a_navigation_gets() {
        let (_, headers, ada) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/who", None, None).await;
        assert!(ada.contains("<b>ada</b>"), "{ada}");
        assert_eq!(headers["corten-shell"], meta_content(&ada, "corten-shell"), "the header and the document agree");
        assert_eq!(headers[axum::http::header::CACHE_CONTROL], "private, no-cache");
        // A navigation does not start the read, so the read's caller is not in the key: the same
        // key, so the runtime swaps the next page in rather than loading it in full.
        let (_, nav, _) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/who", Some("nav"), None).await;
        assert_eq!(nav["corten-shell"], headers["corten-shell"]);
        // A handler that takes the caller keys both by it, whoever looked it up first.
        let (_, doc, _) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/mine", None, None).await;
        let (_, nav, _) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/mine", Some("nav"), None).await;
        assert_eq!(doc["corten-shell"], nav["corten-shell"]);
        assert_ne!(doc["corten-shell"], headers["corten-shell"], "keyed by the caller the handler read");
    }

    #[tokio::test]
    async fn only_a_page_route_s_get_starts_the_reads() {
        let count = CartCount::default();
        for (method, uri) in [("POST", "/"), ("GET", "/health/live"), ("HEAD", "/"), ("GET", "/public"), ("GET", "/text")] {
            let (status, headers, body) = call_with(shop(count.clone(), Duration::ZERO), method, uri, None, None).await;
            assert!(status.is_success() || status.is_redirection(), "{method} {uri}: {status} {body}");
            assert!(!body.contains("corten-later"), "{method} {uri}: {body}");
            if uri == "/public" {
                assert!(body.contains("<header>Cart </header>"), "a Public page draws no one's count: {body}");
                assert!(headers[axum::http::header::CACHE_CONTROL].to_str().unwrap().starts_with("public"), "{headers:?}");
            }
        }
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn the_page_is_filled_before_the_app_s_middleware_sees_it() {
        let routes = Router::new().route(
            "/",
            get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! { <p>"home"</p> } }) }),
        );
        let router = App::new(Routes::from(routes))
            .layout_read(CartCount::default())
            .layout_read(SignedIn)
            .middleware((AsViewer(Some("ada")), Rebuild))
            .router();
        let (_, _, body) = call(router, "GET", None).await;
        assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#), "{body}");
    }

    /// Answers with a copy of the response, as a middleware that rewrites the body does.
    struct Rebuild;

    impl crate::Middleware for Rebuild {
        async fn call(&self, req: axum::extract::Request, next: impl crate::Next) -> Response {
            let (head, body) = next.run(req).await.into_parts();
            let bytes = body.collect().await.unwrap().to_bytes();
            let mut res = Response::new(Body::from(bytes));
            *res.status_mut() = head.status;
            *res.headers_mut() = head.headers;
            res
        }
    }

    /// A share of the cart's limit, as a meter: a view with a `style={..}` value.
    struct CartFill;

    impl LayoutRead for CartFill {
        type Value = f64;

        fn start(&self, _: &axum::http::request::Parts) -> Option<impl std::future::Future<Output = f64> + Send + 'static> {
            Some(async { 40.0 })
        }

        fn view(used: &f64) -> impl Render + '_ {
            html! { <super::Meter used={*used} /> }
        }
    }

    #[tokio::test]
    async fn a_view_that_needs_the_page_s_head_draws_nothing() {
        let routes = Router::new().route(
            "/",
            get(|req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <header>"Cart "{later::<CartFill>()}</header>
                            <main></main>
                        </body>
                    </html>
                })
            }),
        );
        let router = App::new(Routes::from(routes)).components(&[super::Meter]).layout_read(CartFill).router();
        let (status, _, body) = call(router, "GET", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("<header>Cart </header>") && !body.contains("meter__fill"), "{body}");
    }

    #[tokio::test]
    async fn a_mark_the_page_wrote_as_text_is_left_alone() {
        let routes = Router::new().route(
            "/",
            get(
                |req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: crate::raw("<!--corten-later-0-->") }) },
            ),
        );
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).layout_read(SignedIn).router();
        let (_, _, body) = call(router, "GET", None).await;
        assert!(body.contains("<main><!--corten-later-0--></main>"), "{body}");
        assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>guest</b></header>"#), "{body}");
    }

    /// A cart count whose store fails.
    struct Broken;

    impl LayoutRead for Broken {
        type Value = u32;

        fn start(&self, _: &axum::http::request::Parts) -> Option<impl std::future::Future<Output = u32> + Send + 'static> {
            Some(async { panic!("the cart store") })
        }

        fn view(count: &u32) -> impl Render + '_ {
            html! { <span class="count">{*count}</span> }
        }
    }

    #[tokio::test]
    async fn a_read_that_panics_draws_nothing_and_the_page_is_sent() {
        let routes = Router::new().route(
            "/",
            get(|req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <header>"Cart "{later::<Broken>()}</header>
                            <main><p>"home"</p></main>
                        </body>
                    </html>
                })
            }),
        );
        let router = App::new(Routes::from(routes)).layout_read(Broken).router();
        let (status, _, body) = call(router, "GET", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("<header>Cart </header>") && body.contains("<p>home</p>"), "{body}");
    }

    // A debug build's check.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_place_for_a_read_the_app_does_not_start_or_inside_main_is_an_error() {
        let (status, _, body) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/unread", None, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        // Inside `<main>`: a navigation sends it, and so does a full load, where it would be drawn.
        for mode in [Some("nav"), None] {
            let (status, _, body) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/inside", mode, None).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{mode:?}: {body}");
        }
        // A custom element named `main-..` before it is not `<main>`, and a place after markup of
        // the page's own that has a `<main>` (written raw) is not inside it. (The check takes the
        // first `<main>` tag in the text, so raw markup with one can mislead it on a full load; a
        // navigation's check, where every place is inside `<main>`, still says so.)
        let page = |before: &'static str, in_header: bool| {
            get(move |req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <header>
                                {crate::raw(before)}
                                if in_header {
                                    {later::<CartCount>()}
                                }
                            </header>
                            <main>
                                if !in_header {
                                    {later::<CartCount>()}
                                }
                            </main>
                        </body>
                    </html>
                })
            })
        };
        let routes = Router::new()
            .route("/menu", page("<main-menu></main-menu>", false))
            .route("/raw", page("<main hidden></main>", true));
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).router();
        let (status, _, body) = call_with(router.clone(), "GET", "/menu", None, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        let (status, _, body) = call_with(router, "GET", "/raw", None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    /// An answer type of the app's own that wraps a page and does not say it is one.
    struct Wrapped(HtmlResponse);

    impl axum::response::IntoResponse for Wrapped {
        fn into_response(self) -> axum::response::Response {
            self.0.into_response()
        }
    }

    impl crate::Answer for Wrapped {
        const FORMAT: crate::answer::Format = crate::answer::Format::Html;
        type Inputs = crate::answer::AnyInputs;
        type Rows = crate::answer::NotAFeed;
    }

    async fn wrapped(req: Req) -> Wrapped {
        Wrapped(req.page(Layout { req: &req, children: html! { <p>"wrapped"</p> } }).unwrap())
    }

    #[crate::routes]
    mod wrapped_url {
        #[route("/wrapped", get = wrapped)]
        pub struct Wrapped;
    }

    /// A page from an answer type that does not say it is one starts no read: a debug build says
    /// why rather than draw the layout without its values.
    // A debug build's check.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_page_whose_answer_type_is_not_a_page_is_an_error() {
        let count = CartCount::default();
        let router = App::new(wrapped_url::router()).layout_read(count.clone()).router();
        let (status, _, body) = call_with(router, "GET", "/wrapped", None, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    #[cfg(debug_assertions)]
    #[derive(crate::view::Id)]
    struct BadgeId;

    /// The header's badge, as a patch would send it.
    #[cfg(debug_assertions)]
    #[crate::component]
    fn PatchBadge() -> impl crate::view::Patch {
        html! { <span id={BadgeId}>{later::<CartCount>()}</span> }
    }

    /// A badge that renders its place into a string and drops it.
    #[crate::component]
    fn DroppedBadge() -> impl Render {
        let _dropped = later::<CartCount>().to_html();
        html! { <span>"badge"</span> }
    }

    /// A patch is not a page, so a place in it would draw nothing: a debug build says so. A place
    /// rendered into a string the page never writes draws nothing and is no error.
    // A debug build's check.
    #[cfg(debug_assertions)]
    #[tokio::test(start_paused = true)]
    async fn a_place_in_a_patch_is_an_error_and_one_never_written_draws_nothing() {
        let routes = Router::new().route("/patch", get(|req: Req| async move { req.patch::<ForOne>(PatchBadge {}) })).route(
            "/dropped",
            get(|req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <header><DroppedBadge /></header>
                            <main></main>
                        </body>
                    </html>
                })
            }),
        );
        let count = CartCount { delay: Duration::from_millis(400), ..CartCount::default() };
        let router = App::new(Routes::from(routes)).layout_read(count.clone()).router();
        let (status, _, body) = call_with(router.clone(), "GET", "/patch", None, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        let started = tokio::time::Instant::now();
        let (status, _, body) = call_with(router, "GET", "/dropped", None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains("<header><span>badge</span></header>") && !body.contains("corten-later"), "{body}");
        assert!(started.elapsed() < Duration::from_millis(400), "a place never written does not wait for its read");
        assert_eq!(count.finished.load(Ordering::SeqCst), 0, "a read no place draws is dropped");
    }

    /// The app's middleware, slow after the route answers.
    struct SlowAfter;

    impl crate::Middleware for SlowAfter {
        async fn call(&self, req: axum::extract::Request, next: impl crate::middleware::Next) -> axum::response::Response {
            let res = next.run(req).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            res
        }
    }

    /// The app's middleware, refusing what the route answered.
    struct RefuseAfter;

    impl crate::Middleware for RefuseAfter {
        async fn call(&self, req: axum::extract::Request, next: impl crate::middleware::Next) -> axum::response::Response {
            let _ = next.run(req).await;
            axum::response::IntoResponse::into_response(StatusCode::FORBIDDEN)
        }
    }

    /// A read in by the time the route answers with no page stays for the error page the app's
    /// middleware turns the answer into.
    #[tokio::test]
    async fn the_error_page_middleware_makes_draws_a_read_in_before_the_route_answered() {
        let routes = Router::new().route(
            "/away",
            get(|req: Req| async move {
                // The page's own reads, longer than the count's.
                tokio::time::sleep(Duration::from_millis(20)).await;
                let _ = &req;
                axum::response::Redirect::to("/")
            }),
        );
        let router = App::new(Routes::from(routes))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(CartCount::default())
            .layout_read(SignedIn)
            .middleware((AsViewer(Some("ada")), RefuseAfter))
            .router();
        let (status, _, body) = call_with(router, "GET", "/away", None, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>403</p>"), "{body}");
    }

    /// A read that finishes on the same tick the route answers is in by the time it answered: the
    /// reads are polled once more before those still running are dropped.
    #[tokio::test(start_paused = true)]
    async fn a_read_done_on_the_tick_the_route_answers_is_drawn_by_the_error_page() {
        let routes = Router::new().route(
            "/away",
            get(|req: Req| async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                let _ = &req;
                axum::response::Redirect::to("/")
            }),
        );
        let count = CartCount { delay: Duration::from_millis(20), ..CartCount::default() };
        let router = App::new(Routes::from(routes))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .middleware((AsViewer(Some("ada")), RefuseAfter))
            .router();
        let (status, _, body) = call_with(router, "GET", "/away", None, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>403</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
    }

    /// A read no place draws is dropped as the route answers, not polled while the app's
    /// middleware runs after it: a redirect, a page that draws none, and one whose only place is
    /// never written.
    #[tokio::test(start_paused = true)]
    async fn a_read_nothing_draws_stops_when_the_route_answers() {
        let shell = |header: bool| {
            get(move |req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <header>
                                if header {
                                    <DroppedBadge />
                                }
                            </header>
                            <main></main>
                        </body>
                    </html>
                })
            })
        };
        let routes = Router::new()
            .route(
                "/away",
                get(|req: Req| async move {
                    let _ = &req;
                    axum::response::Redirect::to("/")
                }),
            )
            .route("/none", shell(false))
            .route("/unwritten", shell(true));
        for path in ["/away", "/none", "/unwritten"] {
            let count = CartCount { delay: Duration::from_millis(100), ..CartCount::default() };
            let router = App::new(Routes::from(routes.clone())).layout_read(count.clone()).middleware(SlowAfter).router();
            let (status, _, body) = call_with(router, "GET", path, None, None).await;
            assert!(status == StatusCode::OK || status == StatusCode::SEE_OTHER, "{path}: {status} {body}");
            assert_eq!(count.started.load(Ordering::SeqCst), 1, "{path}");
            assert_eq!(count.finished.load(Ordering::SeqCst), 0, "{path}: the read was dropped");
        }
    }
}

/// Log lines written to memory, for a test that reads what was logged.
#[cfg(all(debug_assertions, feature = "log"))]
#[derive(Clone)]
struct Lines(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

#[cfg(all(debug_assertions, feature = "log"))]
impl std::io::Write for Lines {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Through an app: a prefetch of a slow page is logged when it is drawn or given up on, and the
/// same page asked for by a click is not.
#[cfg(all(debug_assertions, feature = "log"))]
#[tokio::test]
async fn an_app_logs_a_slow_prefetch_and_not_a_slow_click() {
    use std::sync::Arc;
    let routes = Router::new().route(
        "/slow",
        get(|req: Req| async move {
            tokio::time::sleep(Duration::from_millis(650)).await;
            req.page::<ForOne>(html! {
                <html>
                    <head>
                        <title>"Slow"</title>
                        <Corten />
                    </head>
                    <body><main></main></body>
                </html>
            })
        }),
    );
    let router = App::new(Routes::from(routes)).router();
    let ask = |purpose: bool| {
        let mut req = Request::get("/slow").header("corten", "nav");
        if purpose {
            req = req.header("purpose", "prefetch");
        }
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };
    let lines = Lines(Arc::default());
    let writer = lines.clone();
    let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
    let _logging = tracing::subscriber::set_default(subscriber);
    let text = || String::from_utf8(std::mem::take(&mut *lines.0.lock().unwrap())).unwrap();
    assert!(ask(false).await.unwrap().status().is_success());
    assert!(!text().contains("ahead of a click"));
    assert!(ask(true).await.unwrap().status().is_success());
    let drawn = text();
    assert!(drawn.contains("/slow drew the page ahead of a click"), "{drawn}");
    assert!(tokio::time::timeout(Duration::from_millis(550), ask(true)).await.is_err());
    let dropped = text();
    assert!(dropped.contains("/slow started the page ahead of a click, given up on after"), "{dropped}");
}

/// A debug build names a hover prefetch that took over half a second, drawn or given up on, and
/// no other.
#[cfg(all(debug_assertions, feature = "log"))]
#[test]
fn a_slow_hover_prefetch_is_logged_in_a_debug_build() {
    use std::sync::Arc;
    let logged = |took: u64, answered: bool| {
        let lines = Lines(Arc::default());
        let writer = lines.clone();
        let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
        tracing::subscriber::with_default(subscriber, || {
            let mut prefetched = crate::page::Prefetched::new(&"/export?step=pull".parse().unwrap());
            prefetched.began -= Duration::from_millis(took);
            prefetched.answered = answered;
        });
        let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
        text
    };
    let drawn = logged(600, true);
    assert!(drawn.contains("/export?step=pull drew the page ahead of a click"), "{drawn}");
    let dropped = logged(600, false);
    assert!(dropped.contains("given up on after"), "{dropped}");
    assert_eq!(logged(100, true), "");
    assert!(crate::page::is_prefetch(
        &[(axum::http::HeaderName::from_static("purpose"), axum::http::HeaderValue::from_static("prefetch"))]
            .into_iter()
            .collect()
    ));
    assert!(!crate::page::is_prefetch(&axum::http::HeaderMap::new()));
}
