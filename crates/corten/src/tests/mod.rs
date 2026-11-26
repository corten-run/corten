use self::caller::caller_url;
use super::*;
use crate::answer::{AnyAnswer, ForOne};
use crate::body::Body;
use crate::cache::Cache;
use crate::http::{self, Request};
use crate::router::{get, Table};
use crate::security::cookie::SetCookie;
use crate::view::{html, Render};
use http_body_util::BodyExt;
use std::time::Duration;
use tower::ServiceExt;

fn demo(text: &str) -> impl Render + '_ {
    html! {
        <p>{text}</p>
        <sort-table><b>"x"</b></sort-table>
        <corten-live src={DemoLive}></corten-live>
    }
}

/// Where `demo`'s `<corten-live>` streams from.
#[derive(crate::Route)]
#[route("/x")]
struct DemoLive;

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

/// A tower layer of the test's own around the app ([`App::layer`]), as an app's own would be:
/// `f(request, the app inside it)` answers.
#[derive(Clone)]
struct OuterFn<F>(F);

#[derive(Clone)]
struct OuterFnService<F> {
    f: F,
    inner: crate::Router,
}

impl<F: Clone> tower::Layer<crate::Router> for OuterFn<F> {
    type Service = OuterFnService<F>;

    fn layer(&self, inner: crate::Router) -> Self::Service {
        OuterFnService { f: self.0.clone(), inner }
    }
}

impl<F, Fut> tower::Service<crate::http::Request> for OuterFnService<F>
where
    F: Fn(crate::http::Request, crate::Router) -> Fut,
    Fut: std::future::Future<Output = crate::response::Response> + Send + 'static,
{
    type Response = crate::response::Response;
    type Error = std::convert::Infallible;
    type Future = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: crate::http::Request) -> Self::Future {
        let answer = (self.f)(req, self.inner.clone());
        Box::pin(async move { Ok(answer.await) })
    }
}

/// A layer that gives each request the peer address a server would ([`crate::testing::Call::peer`]).
fn peer(
    at: std::net::SocketAddr,
) -> tower::util::MapRequestLayer<impl Fn(crate::http::Request) -> crate::http::Request + Clone + Send + Sync> {
    tower::util::MapRequestLayer::new(move |mut req: crate::http::Request| {
        req.extensions_mut().insert(crate::PeerAddr(at));
        req
    })
}

/// Header lines sent as written, a name repeated as HTTP allows: each line appended, none replaced.
fn appended<V, const N: usize>(lines: [(http::HeaderName, V); N]) -> http::HeaderMap
where
    V: TryInto<HeaderValue>,
    V::Error: std::fmt::Debug,
{
    let mut headers = http::HeaderMap::new();
    for (name, value) in lines {
        headers.append(name, value.try_into().unwrap());
    }
    headers
}

/// Typed routes with no parameters, for the tests' areas and APIs: `paths! { Api = "/api" }`.
macro_rules! paths {
    ($($name:ident = $path:tt),* $(,)?) => {$(
        #[derive(crate::Route)]
        #[route($path)]
        struct $name;
    )*};
}

/// A hand-built route's one path parameter, read as `Params` reads one: the tests' stand-in for a
/// route struct of its own.
struct Num<T>(T);

impl<S: Send + Sync, T: serde::de::DeserializeOwned + Send> crate::extract::FromRequestParts<S> for Num<T> {
    type Rejection = crate::ParamsRejection;

    async fn from_request_parts(parts: &mut http::request::Parts, _: &S) -> Result<Self, Self::Rejection> {
        crate::route::read_path::<(T,)>(parts).map(|(value,)| Num(value))
    }
}

// The JSON validation test's route.
#[cfg(feature = "json")]
paths! {
    ApiSignUp = "/api/sign-up",
}

paths! {
    ApiRoot = "/api",
    ApiMissing = "/api/missing",
    ApiDown = "/api/down",
    ApiTeapot = "/api/teapot",
    ApiSlow = "/api/slow",
    ApiPost = "/api/post",
    ApiRates = "/api/rates",
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
    async fn identify(parts: &http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
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
    async fn call(&self, mut req: crate::http::Request, next: impl crate::Next) -> Response {
        if let Some(name) = self.0 {
            req.headers_mut().insert("viewer", http::HeaderValue::from_static(name));
        }
        next.run(req).await
    }
}

/// Stamps every answer with a request id, two `Server-Timing` values and `Vary: origin`, and
/// answers 429 with `Retry-After` itself when asked to by `x-flood`.
struct Stamp;

impl crate::Middleware for Stamp {
    async fn call(&self, req: crate::http::Request, next: impl crate::Next) -> Response {
        use http::header;
        use http::HeaderValue;
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
        headers.append(header::VARY, HeaderValue::from_static("origin"));
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=600"));
        res
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

async fn call(router: impl Into<Router>, method: &str, mode: Option<&str>) -> (StatusCode, http::HeaderMap, String) {
    call_with(router, method, "/", mode, None).await
}

async fn call_with(
    router: impl Into<Router>,
    method: &str,
    uri: &str,
    mode: Option<&str>,
    accept: Option<&str>,
) -> (StatusCode, http::HeaderMap, String) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(mode) = mode {
        req = req.header("corten", mode);
        // A form submit, as the runtime sends one: it draws a write's own page whole (#1370).
        if mode == "action" {
            req = req.header("prefer", "corten-draws=whole");
        }
    }
    if let Some(accept) = accept {
        req = req.header("accept", accept);
    }
    let res = router.into().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (parts.status, parts.headers, String::from_utf8(bytes.to_vec()).unwrap())
}

fn routes() -> Table {
    Table::new().route(
        "/",
        get(|req: Req| async move {
            let head = html! { <meta name="description" content="About A"> };
            req.page::<ForOne>(Shell { req: &req, title: "A & B", head, children: demo("<script>") })
        })
        .post(|req: Req| async move {
            req.patch_or::<ForOne, AnyAnswer, _, _>(html! { <p id={MsgId}>"saved"</p> }, || async { req.redirect(&Done) }).await
        }),
    )
}

/// The app as `App` assembles it, with the tests' error page, every request sent as `viewer`.
fn app(routes: Table, viewer: Option<&'static str>) -> Router {
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

/// A meter whose fill comes from data (`test_meter.css` registers `--fill`).
#[crate::component(css)]
fn TestMeter(used: f64) -> impl Render {
    html! { <div class={Meter} style={FILL.pct(used)}></div> }
}

fn meters() -> Table {
    Table::new().route(
        "/",
        get(|req: Req| async move {
            let meters = html! {
                <TestMeter used={42.5} />
                <TestMeter used={7.0} />
                <TestMeter used={42.5} />
                <TestMeter used={f64::NAN} />
            };
            req.test_page("Meters", meters)
        }),
    )
}

#[derive(crate::view::Id)]
struct QtyId;

#[derive(crate::view::Id)]
struct MsgId;

async fn post_page_send(
    router: &crate::Router,
    path: &str,
    headers: &[(&'static str, &'static str)],
) -> (StatusCode, HeaderMap, String) {
    let mut req = Request::builder().method("POST").uri(path);
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let body = crate::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, headers, String::from_utf8(body.to_vec()).unwrap())
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

#[derive(Fields)]
#[allow(dead_code)]
struct SignUp {
    email: String,
    #[serde(rename = "pw")]
    password: String,
    #[serde(skip)]
    internal: u8,
}

// ---- App::api: routes that answer only JSON ----

#[derive(crate::Route)]
#[route("/api/items/{id}")]
struct ApiItem<'a> {
    id: &'a str,
}

/// A page, and API routes for each way an API request can fail; `settings` adds the API's.
fn api_app(settings: impl FnOnce(crate::Api<ApiRoot>) -> crate::Api<ApiRoot>) -> Router {
    App::new(Routes::from(Table::new().route("/", get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) }))))
        .error_page(test_error_page, ())
        .deadline(std::time::Duration::from_millis(50))
        .api::<ApiRoot>(|api| {
            let api = api
                .route::<ApiItem>(crate::Methods::reads(get(|Num(id): Num<u32>| async move { format!("item {id}") })))
                .route::<ApiMissing>(crate::Methods::reads(get(|| async {
                    Err::<Response, _>(Error::new("no item 7").with_status(StatusCode::NOT_FOUND))
                })))
                .route::<ApiDown>(crate::Methods::reads(get(|| async {
                    Err::<Response, _>(Error::new("database password wrong"))
                })))
                .route::<ApiTeapot>(crate::Methods::reads(get(|| async {
                    (StatusCode::IM_A_TEAPOT, [("content-type", "application/json")], r#"{"mine":1}"#)
                })))
                .route::<ApiSlow>(crate::Methods::reads(get(std::future::pending::<&'static str>)))
                .route::<ApiPost>(crate::Methods::writes(crate::router::post(|| async { "posted" })));
            settings(api)
        })
        .router()
}

/// A request with one more header, or several.
#[cfg(feature = "json")]
async fn call_with_header(
    router: Router,
    method: &str,
    path: &str,
    header: (&str, &str),
) -> (StatusCode, http::HeaderMap, String) {
    call_with_headers(router, method, path, &[header]).await
}

#[cfg(feature = "json")]
async fn call_with_headers(
    router: Router,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, http::HeaderMap, String) {
    let mut req = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let (parts, body) = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
    (parts.status, parts.headers, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
}

/// Copies the steps the request met and the route the router matched (`MatchedPath`) onto the answer.
struct Saw;

impl crate::Middleware for Saw {
    async fn call(&self, req: Request<Body>, next: impl crate::Next) -> crate::response::Response {
        let steps = req.headers().get("x-steps").cloned();
        let route =
            req.extensions().get::<crate::middleware::MatchedPath>().map(|m| m.as_str().parse::<http::HeaderValue>().unwrap());
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
    async fn call(&self, mut req: Request<Body>, next: impl crate::Next) -> crate::response::Response {
        use crate::response::IntoResponse;
        let steps = req.headers().get("x-steps").map(|v| format!("{} {}", v.to_str().unwrap(), self.0));
        let steps = steps.unwrap_or_else(|| self.0.to_string());
        req.headers_mut().insert("x-steps", steps.parse().unwrap());
        if self.1 && req.headers().contains_key("x-flood") {
            return crate::Refused::too_many(Duration::from_millis(7_500)).into_response();
        }
        next.run(req).await
    }
}

paths! {
    Shop = "/shop",
    ShopItem = "/shop/item",
    ShopDesk = "/shop/desk",
    ShopDeskItem = "/shop/desk/item",
}

#[cfg(feature = "json")]
paths! { ApiQuote = "/api/quote" }

/// What most HTTP clients send: `*/*`, or no `Accept` at all, or a browser's own.
const ACCEPTS: [Option<&str>; 4] = [Some("*/*"), None, Some("text/html,application/xhtml+xml"), Some("application/json")];

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

async fn cache_control(router: &Router, uri: &str, extra: &[(&'static str, &'static str)]) -> String {
    let mut req = Request::get(uri);
    for (name, value) in extra {
        req = req.header(*name, *value);
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    res.headers()[header::CACHE_CONTROL].to_str().unwrap().to_string()
}

#[cfg(feature = "json")]
#[derive(crate::ToJson)]
struct Quote {
    id: u32,
    partner: &'static str,
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

crate::assets::embed!(struct RefusedStatic = "src/assets/fixture");
crate::assets::embed!(struct IconStatic = "src/assets/favicon-ico");

/// A form whose writes carry a submit key.
#[derive(Fields)]
#[allow(dead_code)]
struct KeyedWrite {
    submit: crate::SubmitKey,
}

/// Log lines written to memory, for a test that reads what was logged.
#[cfg(feature = "log")]
#[derive(Clone)]
struct Lines(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

#[cfg(feature = "log")]
impl std::io::Write for Lines {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// What a test logs to [`Lines`] while it is held: the lines logged on this thread.
#[cfg(feature = "log")]
struct Logging {
    _logging: tracing::subscriber::DefaultGuard,
    _beside: tracing::Dispatch,
}

/// Logs what this thread logs to `lines`, without the time, until the [`Logging`] is dropped: a
/// test matches what a line says, and a time's digits would match by chance. A second subscriber,
/// which logs nothing, stays registered beside it for as long: while one subscriber alone is
/// registered, `tracing` decides once for the whole process whether a log line is wanted, by the
/// subscriber of the first thread to reach it, so a test running beside this one with none would
/// have this one's lines dropped (`tracing_core::callsite`, 0.1.36). With two, it decides per
/// line, by the subscriber of the thread that logs it.
#[cfg(feature = "log")]
fn log_to(lines: &Lines) -> Logging {
    let _beside = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
    let writer = lines.clone();
    let subscriber = tracing_subscriber::fmt().with_ansi(false).without_time().with_writer(move || writer.clone()).finish();
    Logging { _logging: tracing::subscriber::set_default(subscriber), _beside }
}

mod actions;
mod api;
mod app;
mod assets;
mod bodies;
mod cache;
mod caller;
mod forms;
mod h1;
mod h1_fuzz;
#[cfg(feature = "json")]
mod json_answers;
mod layout;
mod live;
#[cfg(feature = "log")]
mod logging;
mod pages;
mod patches;
mod security;
mod server;
mod unstaged;
mod url;
mod views;
