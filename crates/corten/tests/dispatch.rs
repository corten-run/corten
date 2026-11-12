//! How a request finds its route, as the wire shows it: raw HTTP/1.1 sent to `corten::serve_on`
//! and the answer read back as bytes. No type of the router under Corten is named here, so the
//! same cases hold whichever router dispatches (docs/design.md#choice-axum-router): matching,
//! `HEAD`, `405` with `Allow`, percent-decoding, catch-alls, a suffix after a parameter,
//! areas, an API's failures and an unstaged route.

use std::net::SocketAddr;

use corten::{App, Params};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::OnceCell,
};

#[corten::routes]
mod url {
    #[route("/", get = crate::home)]
    pub struct Home;

    #[route("/items/{id}", get = crate::item, post = crate::item)]
    pub struct Item {
        pub id: u32,
    }

    #[route("/items/new", get = crate::new_item)]
    pub struct NewItem;

    #[route("/names/{name}", get = crate::name)]
    pub struct Name<'a> {
        pub name: std::borrow::Cow<'a, str>,
    }

    #[route("/notes/{title}/edit", get = crate::edit_note)]
    pub struct EditNote<'a> {
        pub title: &'a str,
    }

    #[route("/files/{*rest}", get = crate::file)]
    pub struct File<'a> {
        pub rest: std::borrow::Cow<'a, str>,
    }

    #[route("/feeds/{name}.xml", get = crate::feed)]
    pub struct Feed<'a> {
        pub name: &'a str,
    }

    #[route("/ping", get = crate::ping, unstaged)]
    pub struct Ping;

    #[route("/pay/{step}", get = crate::pay_step)]
    pub struct PayStep<'a> {
        pub step: &'a str,
    }
}

#[corten::routes(api = PayApi)]
mod pay {
    #[route("/pay/api")]
    pub struct PayApi;

    #[route("/pay/api/go", get = crate::go)]
    pub struct Go;
}

#[corten::routes(area = Shop)]
mod shop {
    #[route("/shop")]
    pub struct Shop;

    #[route("/shop/cart", get = crate::cart)]
    pub struct Cart;
}

#[corten::routes(api = V1)]
mod v1 {
    #[route("/v1")]
    pub struct V1;

    #[route("/v1/things/{id}", get = crate::thing)]
    pub struct Thing {
        pub id: u32,
    }

    #[route("/v1/count/{n}", get = crate::count, unstaged)]
    pub struct Count {
        pub n: u32,
    }

    #[route("/v1/export/{name}.csv", get = crate::export, unstaged)]
    pub struct Export<'a> {
        pub name: &'a str,
    }
}

async fn home() -> &'static str {
    "home"
}

async fn item(at: Params<url::Item>) -> String {
    format!("item {}", at.id)
}

async fn new_item() -> &'static str {
    "new"
}

async fn name(at: Params<url::Name<'_>>) -> String {
    at.name.to_string()
}

async fn edit_note(at: Params<url::EditNote<'_>>) -> String {
    format!("edit {}", at.title)
}

async fn file(at: Params<url::File<'_>>) -> String {
    at.rest.to_string()
}

async fn feed(at: Params<url::Feed<'_>>) -> String {
    at.name.to_string()
}

async fn ping() -> &'static str {
    "pong"
}

async fn cart() -> &'static str {
    "cart"
}

async fn thing(at: Params<v1::Thing>) -> String {
    format!("thing {}", at.id)
}

async fn pay_step(at: Params<url::PayStep<'_>>) -> String {
    format!("step {}", at.step)
}

async fn go() -> &'static str {
    "go"
}

async fn count(at: Params<v1::Count>) -> Result<String, corten::http::StatusCode> {
    match at.n {
        0 => Err(corten::http::StatusCode::NOT_FOUND),
        n => Ok(format!("count {n}")),
    }
}

async fn export(at: Params<v1::Export<'_>>) -> String {
    format!("export {}", at.name)
}

/// The app, served once for every test in this file.
async fn server() -> SocketAddr {
    static SERVER: OnceCell<SocketAddr> = OnceCell::const_new();
    // `HOSTS` adds to the hosts the app answers to, which the 421 cases fix.
    assert!(std::env::var_os("HOSTS").is_none(), "unset HOSTS to run the dispatch suite");
    *SERVER
        .get_or_init(|| async {
            // Bound here, served on a runtime of its own, which outlives each test's.
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let addr = listener.local_addr().unwrap();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                runtime.block_on(async {
                    let app = App::new(url::router()).area(shop::area).api(v1::api).api(pay::api);
                    corten::serve_on(vec![TcpListener::from_std(listener).unwrap()], app).await.unwrap();
                });
            });
            addr
        })
        .await
}

/// An answer as the wire carried it.
struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

/// Sends `method target` with `headers` on a connection of its own and reads the whole answer.
async fn send(method: &str, target: &str, headers: &[(&str, &str)]) -> Answer {
    send_to("localhost", method, target, headers).await
}

/// [`send`] naming `host`.
async fn send_to(host: &str, method: &str, target: &str, headers: &[(&str, &str)]) -> Answer {
    let mut stream = TcpStream::connect(server().await).await.unwrap();
    let mut request = format!("{method} {target} HTTP/1.1\r\nhost: {host}\r\nconnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("an answer's head") + 4;
    let head = String::from_utf8(raw[..end].to_vec()).unwrap();
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    let headers: Vec<(String, String)> = lines
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_ascii_lowercase(), value.trim().to_string())
        })
        .collect();
    let mut body = raw[end..].to_vec();
    if method != "HEAD" && headers.iter().any(|(n, v)| n == "transfer-encoding" && v == "chunked") {
        body = unchunk(&body);
    }
    Answer { status, headers, body: String::from_utf8_lossy(&body).into_owned() }
}

fn unchunk(mut raw: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    loop {
        let line = raw.windows(2).position(|w| w == b"\r\n").unwrap();
        let size = usize::from_str_radix(std::str::from_utf8(&raw[..line]).unwrap().trim(), 16).unwrap();
        if size == 0 {
            return body;
        }
        body.extend_from_slice(&raw[line + 2..line + 2 + size]);
        raw = &raw[line + 4 + size..];
    }
}

async fn get(target: &str) -> Answer {
    send("GET", target, &[]).await
}

fn methods(allow: Option<&str>) -> Vec<String> {
    let mut methods: Vec<String> = allow.unwrap_or("").split(',').map(|m| m.trim().to_string()).collect();
    methods.sort();
    methods
}

#[tokio::test]
async fn a_path_finds_its_route_and_nothing_else() {
    assert_eq!((get("/").await.status, get("/").await.body), (200, "home".to_string()));
    let item = get("/items/7").await;
    assert_eq!((item.status, item.body.as_str()), (200, "item 7"));
    // A segment of text is chosen over a parameter in the same place.
    assert_eq!(get("/items/new").await.body, "new");
    // The query is not part of the path.
    assert_eq!(get("/items/7?sort=price").await.body, "item 7");
    // A target in absolute form is matched by its path.
    assert_eq!(get("http://localhost/items/7").await.body, "item 7");
    // Paths are matched as sent: case, a trailing slash, an empty segment and dot segments count.
    for path in ["/Items/7", "/items/7/", "//items/7", "/items/../items/7", "/nowhere"] {
        assert_eq!(get(path).await.status, 404, "{path}");
    }
    // An empty segment stands for a parameter, as the empty text, before another segment, and not
    // at the end of the path.
    assert_eq!(get("/notes/plan/edit").await.body, "edit plan");
    let empty = get("/notes//edit").await;
    assert_eq!((empty.status, empty.body.as_str()), (200, "edit "));
    assert_eq!(get("/names/").await.status, 404);
}

#[tokio::test]
async fn a_parameter_that_does_not_parse_is_a_400() {
    assert_eq!(get("/items/seven").await.status, 400);
    assert_eq!(get("/items/99999999999").await.status, 400);
}

#[tokio::test]
async fn a_parameter_is_percent_decoded_after_the_path_is_matched() {
    assert_eq!(get("/names/caf%C3%A9").await.body, "caf\u{e9}");
    // An encoded slash stays inside its segment.
    assert_eq!(get("/names/a%2Fb").await.body, "a/b");
    assert_eq!(get("/names/a%20b").await.body, "a b");
    // Bytes that are not UTF-8 are refused.
    assert_eq!(get("/names/%FF").await.status, 400);
}

#[tokio::test]
async fn a_catch_all_takes_the_rest_of_the_path_and_not_nothing() {
    assert_eq!(get("/files/a/b/c.txt").await.body, "a/b/c.txt");
    assert_eq!(get("/files/a").await.body, "a");
    assert_eq!(get("/files/").await.status, 404);
    assert_eq!(get("/files").await.status, 404);
}

/// What a release build writes for a value no link carries (docs/design.md#limit-path-values),
/// `%FF` after it, is a 400 wherever the parameter sits: no browser resolves it away, and no
/// parameter reads a value that is not UTF-8. A value that only contains dots reads back.
#[tokio::test]
async fn a_value_no_link_carries_is_a_400() {
    for path in [
        "/names/..%FF",
        "/names/.%FF",
        "/names/%FF",
        "/notes/..%FF/edit",
        "/files/public/..%FF/private/report.pdf",
        "/files/..%FF/..%FF/x",
        "/files/%FF",
        "/feeds/%FF.xml",
    ] {
        assert_eq!(get(path).await.status, 400, "{path}");
    }
    for (path, value) in [
        ("/names/a.b", "a.b"),
        ("/names/...", "..."),
        ("/names/.hidden", ".hidden"),
        ("/feeds/..xml", "."),
        ("/files/a/.../b", "a/.../b"),
        ("/files//a", "/a"),
    ] {
        let answer = get(path).await;
        assert_eq!((answer.status, answer.body.as_str()), (200, value), "{path}");
    }
}

#[tokio::test]
async fn text_after_a_parameter_is_part_of_the_match() {
    assert_eq!(get("/feeds/news.xml").await.body, "news");
    assert_eq!(get("/feeds/news").await.status, 404);
    assert_eq!(get("/feeds/news.rss").await.status, 404);
}

#[tokio::test]
async fn head_is_get_without_the_body() {
    for path in ["/items/7", "/ping"] {
        let got = get(path).await;
        let head = send("HEAD", path, &[]).await;
        assert_eq!(head.status, 200, "{path}");
        assert_eq!(head.body, "", "{path}");
        assert!(got.header("content-length").is_some(), "{path}: {:?}", got.headers);
        assert_eq!(head.header("content-length"), got.header("content-length"), "{path}");
        assert_eq!(head.header("content-type"), got.header("content-type"), "{path}");
    }
    let missing = send("HEAD", "/nowhere", &[("accept", "text/html")]).await;
    assert_eq!((missing.status, missing.body.as_str()), (404, ""));
}

#[tokio::test]
async fn a_method_the_route_has_no_handler_for_is_a_405_that_says_which_it_has() {
    for method in ["PUT", "DELETE", "PATCH"] {
        let refused = send(method, "/items/7", &[]).await;
        assert_eq!(refused.status, 405, "{method}");
        assert_eq!(methods(refused.header("allow")), ["GET", "HEAD", "POST"], "{method}");
    }
    let refused = send("POST", "/", &[]).await;
    assert_eq!((refused.status, methods(refused.header("allow"))), (405, vec!["GET".into(), "HEAD".into()]));
    let refused = send("PUT", "/ping", &[]).await;
    assert_eq!((refused.status, methods(refused.header("allow"))), (405, vec!["GET".into(), "HEAD".into()]));
    assert_eq!(refused.header("content-security-policy"), Some("sandbox"));
    // OPTIONS and a method HTTP does not name are methods like any other.
    for method in ["OPTIONS", "PROPFIND"] {
        let refused = send(method, "/items/7", &[]).await;
        assert_eq!(
            (refused.status, methods(refused.header("allow"))),
            (405, vec!["GET".into(), "HEAD".into(), "POST".into()]),
            "{method}"
        );
    }
    // The path is matched before the method: `/items/new` has no POST, and `/items/{id}`'s is
    // not tried in its place.
    let refused = send("POST", "/items/new", &[]).await;
    assert_eq!((refused.status, methods(refused.header("allow"))), (405, vec!["GET".into(), "HEAD".into()]));
}

#[tokio::test]
async fn a_static_segment_is_matched_as_sent_and_not_decoded() {
    assert_eq!(get("/%69tems/7").await.status, 404);
    // `/items/new` encoded is not that route: it is `/items/{id}` with an id that is not a number.
    assert_eq!(get("/items/%6Eew").await.status, 400);
    // Nor is the text after a parameter: `.xml` encoded is not the route's suffix.
    assert_eq!(get("/feeds/news%2Exml").await.status, 404);
}

#[tokio::test]
async fn a_host_the_app_does_not_answer_to_is_a_421_on_every_route() {
    for path in ["/items/7", "/ping", "/v1/count/3", "/nowhere"] {
        assert_eq!(send_to("rebound.attacker.example", "GET", path, &[]).await.status, 421, "{path}");
    }
    assert_eq!(send_to("localhost:3000", "GET", "/ping", &[]).await.status, 200);
}

#[tokio::test]
async fn an_unknown_path_is_the_app_s_error_page_and_an_api_s_is_its_json() {
    let page = send("GET", "/nowhere", &[("accept", "text/html")]).await;
    assert_eq!(page.status, 404);
    assert!(page.header("content-type").unwrap().starts_with("text/html"), "{:?}", page.headers);
    let under_area = send("GET", "/shop/nowhere", &[("accept", "text/html")]).await;
    assert_eq!(under_area.status, 404);
    assert!(under_area.header("content-type").unwrap().starts_with("text/html"));
    let under_api = get("/v1/nowhere").await;
    assert_eq!((under_api.status, under_api.header("content-type")), (404, Some("application/problem+json")));
    let refused = send("PUT", "/v1/things/3", &[]).await;
    assert_eq!((refused.status, refused.header("content-type")), (405, Some("application/problem+json")));
    assert_eq!(methods(refused.header("allow")), ["GET", "HEAD"]);
}

#[tokio::test]
async fn an_area_s_and_an_api_s_routes_are_found_under_their_prefix() {
    assert_eq!(get("/shop/cart").await.body, "cart");
    assert_eq!(get("/v1/things/3").await.body, "thing 3");
    assert_eq!(get("/v1/things/three").await.status, 400);
    // A prefix with no route of its own.
    assert_eq!(send("GET", "/shop", &[("accept", "text/html")]).await.status, 404);
    let v1 = get("/v1").await;
    assert_eq!((v1.status, v1.header("content-type")), (404, Some("application/problem+json")));
}

#[tokio::test]
async fn every_path_under_an_api_s_prefix_is_the_api_s_own() {
    assert_eq!(get("/pay/one").await.body, "step one");
    assert_eq!(get("/pay/api/go").await.body, "go");
    // `/pay/{step}` would match it, and the API answers it instead.
    let prefix = get("/pay/api").await;
    assert_eq!((prefix.status, prefix.header("content-type")), (404, Some("application/problem+json")));
}

#[tokio::test]
async fn an_unstaged_route_is_found_as_any_other() {
    let ping = get("/ping").await;
    assert_eq!((ping.status, ping.body.as_str()), (200, "pong"));
    assert_eq!(ping.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(get("/ping/").await.status, 404);
    assert_eq!(get("/v1/export/sales.csv").await.body, "export sales");
}

#[tokio::test]
async fn an_unstaged_route_under_an_api_fails_as_the_api_does() {
    assert_eq!(get("/v1/count/3").await.body, "count 3");
    let problem = Some("application/problem+json");
    for (method, target, status) in [
        ("GET", "/v1/count/0", 404),
        ("GET", "/v1/count/three", 400),
        ("PUT", "/v1/count/3", 405),
        ("GET", "/v1/export/sales", 404),
    ] {
        let failed = send(method, target, &[]).await;
        assert_eq!((failed.status, failed.header("content-type")), (status, problem), "{method} {target}");
        assert_eq!(failed.header("content-security-policy"), Some("sandbox"), "{method} {target}");
    }
    assert_eq!(methods(send("PUT", "/v1/count/3", &[]).await.header("allow")), ["GET", "HEAD"]);
}
