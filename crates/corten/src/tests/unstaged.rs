use super::caller::docs_url;
use super::*;

/// A route served outside every stage beside one served through all of them.
#[crate::routes]
pub(super) mod unstaged_url {
    #[route("/ping", get = unstaged_ping, unstaged)]
    pub struct Ping;

    #[route("/raw/{id}", get = unstaged_raw, unstaged)]
    pub struct Raw {
        pub id: u32,
    }

    #[route("/page", get = unstaged_page)]
    pub struct Page;

    #[route("/serves", get = unstaged_serves)]
    pub struct Serves;

    #[route("/where/{id}", get = unstaged_where, unstaged)]
    pub struct Where {
        pub id: u32,
    }

    #[route("/picture", get = unstaged_picture, unstaged)]
    pub struct Picture;

    #[route("/framed", get = unstaged_framed, unstaged)]
    pub struct Framed;

    #[route("/sitemap.xml", get = unstaged_sitemap, unstaged)]
    pub struct Sitemap;

    #[route("/cookie", get = unstaged_cookie, unstaged)]
    pub struct Cookie;

    #[route("/listed", get = unstaged_listed, unstaged)]
    pub struct Listed;

    #[route("/boom", get = unstaged_boom, unstaged)]
    pub struct Boom;

    #[route("/shared-cookie", get = unstaged_shared_cookie, unstaged)]
    pub struct SharedCookie;

    #[route("/private-cookie", get = unstaged_private_cookie, unstaged)]
    pub struct PrivateCookie;

    #[route("/no-store", get = unstaged_no_store, unstaged)]
    pub struct NoStored;

    #[route("/relayed-no-store", get = unstaged_relayed_no_store, unstaged)]
    pub struct RelayedNoStore;

    #[route("/feeds/{name}.xml", get = unstaged_feed, unstaged)]
    pub struct Feed<'a> {
        pub name: &'a str,
    }
}

async fn unstaged_ping() -> &'static str {
    "pong"
}

/// The raw request in and a raw response out, its headers the handler's alone.
async fn unstaged_raw(at: crate::Params<unstaged_url::Raw>, method: http::Method) -> crate::response::Response {
    crate::response::Response::builder()
        .status(StatusCode::IM_A_TEAPOT)
        .header("x-raw", format!("{method} {}", at.id))
        .body(Body::from("raw"))
        .unwrap()
}

async fn unstaged_feed(feed: crate::Params<unstaged_url::Feed<'_>>) -> String {
    format!("feed {}", feed.name)
}

/// The rest of what an unstaged handler may take: the request's `Uri` and the app's state.
async fn unstaged_where(at: crate::Params<unstaged_url::Where>, uri: http::Uri, _: crate::extract::State<()>) -> String {
    format!("{} {uri}", at.id)
}

/// A document with headers of its own, which the ones an unstaged route adds do not replace.
async fn unstaged_framed() -> crate::response::Response {
    crate::response::Response::builder()
        .header("content-type", "text/html")
        .header("content-security-policy", "frame-ancestors 'none'")
        .header("x-content-type-options", "nosniff")
        .body(Body::from("<p>framed</p>"))
        .unwrap()
}

/// A cookie set with nothing said of caching.
async fn unstaged_cookie() -> crate::response::Response {
    crate::response::Response::builder().header("set-cookie", "seen=1").body(Body::from("seen")).unwrap()
}

/// A type a browser may read as the last of a list, HTML.
async fn unstaged_listed() -> crate::response::Response {
    crate::response::Response::builder()
        .header("content-type", "text/plain, text/html")
        .body(Body::from("<p>listed</p>"))
        .unwrap()
}

/// An unstaged handler for any route with a parameter.
async fn unstaged_at<R: crate::route::FromUrl>(_: crate::Params<R>) -> &'static str {
    "at"
}

/// A handler that panics, which an unstaged route answers 500 rather than dropping the connection.
async fn unstaged_boom() -> &'static str {
    if true {
        panic!("unstaged and broken")
    } else {
        "never"
    }
}

/// A cookie set on an answer that says it is private, with a CDN's header that says otherwise.
async fn unstaged_private_cookie() -> crate::response::Response {
    crate::response::Response::builder()
        .header("set-cookie", "id=fresh")
        .header("cache-control", "private=\"x-id\", no-store")
        .header("cdn-cache-control", "max-age=600")
        .body(Body::from("id"))
        .unwrap()
}

/// An answer nothing may keep, with no cookie: a code in the link it answers.
async fn unstaged_no_store() -> NoStore<&'static str> {
    NoStore("code")
}

/// An upstream's answer nothing may keep, with no cookie (a download that works once), whose
/// upstream says a CDN may keep it.
async fn unstaged_relayed_no_store() -> NoStore<crate::Relay> {
    let mut headers = http::HeaderMap::new();
    for (name, value) in [
        ("cache-control", "public, max-age=600"),
        ("cdn-cache-control", "max-age=600"),
        ("cloudflare-cdn-cache-control", "max-age=600"),
        ("vercel-cdn-cache-control", "max-age=600"),
        ("surrogate-control", "max-age=600"),
        ("edge-control", "max-age=600"),
        ("x-accel-expires", "600"),
        ("foo-cache-control", "max-age=600"),
        ("surrogate-key", "ids"),
    ] {
        headers.insert(http::HeaderName::from_static(name), http::HeaderValue::from_static(value));
    }
    NoStore(crate::Relay::new(StatusCode::OK, headers, Body::from("once")))
}

/// A cookie set on an answer that says a shared cache may keep it.
async fn unstaged_shared_cookie() -> crate::response::Response {
    crate::response::Response::builder()
        .header("set-cookie", "id=fresh")
        .header("cache-control", "public, max-age=60")
        .header("cdn-cache-control", "max-age=600")
        .header("vercel-cdn-cache-control", "max-age=600")
        .header("surrogate-control", "max-age=600")
        .header("edge-control", "max-age=600")
        .header("x-accel-expires", "600")
        .header("foo-cache-control", "max-age=60")
        .header("surrogate-key", "ids")
        .body(Body::from("id"))
        .unwrap()
}

/// A picture that can run script, as an uploaded SVG can.
async fn unstaged_picture() -> crate::Media {
    crate::Media::new("image/svg+xml", r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#)
}

/// How many times the sitemap was written.
static SITEMAPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A sitemap for everyone, of a size the app keeps from a route with stages.
async fn unstaged_sitemap() -> crate::Public<crate::seo::File> {
    SITEMAPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    crate::seo::sitemap((0..40).map(|_| crate::seo::SitemapUrl { loc: "https://example.com/cards/7", lastmod: None }))
}

async fn unstaged_page(req: Req) -> HtmlResult {
    req.test_page("Page", html! { <p>"page"</p> })
}

/// Whether `?next=` may send the visitor to the unstaged route and to the page.
async fn unstaged_serves(req: Req) -> String {
    let serves = |path: &str| req.serves(&crate::Local::parse(path).unwrap());
    format!("{} {}", serves("/ping"), serves("/page"))
}

/// `unstaged` sends the handler's answer as it made it, with `nosniff` and
/// `Content-Security-Policy: sandbox` always added, after the host check: no other security headers,
/// `Cache-Control` (unless it sets a cookie), error page or tag. It answers reads only. The route
/// beside it, and an unknown URL, still go through every stage.
#[tokio::test]
async fn an_unstaged_route_meets_no_stage_and_the_routes_beside_it_meet_all() {
    let router = App::new(unstaged_url::router()).error_page(test_error_page, ()).router();
    let (status, headers, body) = call_with(router.clone(), "GET", "/ping", None, Some("text/html")).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "pong"));
    for name in ["cache-control", "etag", "referrer-policy", "x-frame-options"] {
        assert!(!headers.contains_key(name), "an unstaged route has no {name}: {headers:?}");
    }
    assert_eq!(headers["x-content-type-options"], "nosniff", "no page of the app's can load it as a script");
    assert_eq!(headers["content-security-policy"], "sandbox", "a document it sends runs no script on the app's origin");
    // A `get` answers `HEAD` too, with no body, as axum's own routes do.
    let (status, _, body) = call_with_any(router.clone(), "HEAD", "/ping", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, ""));
    let (status, headers, body) = call_with(router.clone(), "GET", "/raw/7", None, None).await;
    assert_eq!((status, body.as_str()), (StatusCode::IM_A_TEAPOT, "raw"), "a 4xx is sent as it is, not as the error page");
    assert_eq!(headers.get("x-raw").unwrap(), "GET 7");
    assert!(!headers.contains_key("cache-control") && headers["x-content-type-options"] == "nosniff", "{headers:?}");
    // It answers no write, so another site's is the router's plain answer, not the stages' 403: a
    // 501, since no route in this app takes a `POST`; another host's read is the 421 every route
    // gives it, with the headers an unstaged answer gets.
    let (status, _, body) = call_with_any(
        router.clone(),
        "POST",
        "/raw/7",
        &[("origin", "https://attacker.example"), ("sec-fetch-site", "cross-site")],
    )
    .await;
    assert_eq!((status, body.as_str()), (StatusCode::NOT_IMPLEMENTED, ""));
    let (status, headers, body) =
        call_with_any(router.clone(), "GET", "/ping", &[("host", "rebound.attacker.example:3917")]).await;
    assert_eq!((status, body.as_str()), (StatusCode::MISDIRECTED_REQUEST, "Misdirected request."));
    assert_eq!(
        (&headers["content-security-policy"], &headers["cache-control"]),
        (&"sandbox".parse().unwrap(), &"private, no-cache".parse().unwrap())
    );
    let (status, _, body) = call_with_any(router.clone(), "GET", "/ping", &[("host", "localhost:3000")]).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "pong"), "the app's own name is answered");
    let (status, _, body) = call_with(router.clone(), "GET", "/where/7?x=1", None, None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "7 /where/7?x=1"));
    // `Media` keeps a file that can run script from running it, with no stage to do so.
    let (status, headers, _) = call_with(router.clone(), "GET", "/picture", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["content-security-policy"], "sandbox");
    // A handler's own policy is kept, with the sandbox beside it, and `nosniff` is sent once; a
    // cookie is never shared.
    let (_, headers, _) = call_with(router.clone(), "GET", "/framed", None, None).await;
    assert_eq!(headers.get_all("content-security-policy").iter().collect::<Vec<_>>(), ["frame-ancestors 'none'", "sandbox"]);
    assert_eq!(headers.get_all("x-content-type-options").iter().count(), 1);
    let (_, headers, _) = call_with(router.clone(), "GET", "/cookie", None, None).await;
    assert_eq!(headers["cache-control"], "private, no-cache");
    // Whatever caching it says, a CDN's own header too, and `no-store` where it says one.
    let (_, headers, _) = call_with(router.clone(), "GET", "/shared-cookie", None, None).await;
    assert_eq!(headers["cache-control"], "private, no-cache");
    // Any `*cache-control`, as before, besides the names Corten lists that do not end so.
    for cdn in [
        "cdn-cache-control",
        "vercel-cdn-cache-control",
        "surrogate-control",
        "edge-control",
        "x-accel-expires",
        "foo-cache-control",
    ] {
        assert!(!headers.contains_key(cdn), "{headers:?}");
    }
    assert_eq!(headers["surrogate-key"], "ids", "a CDN's header that keeps nothing stays");
    let (_, headers, _) = call_with(router.clone(), "GET", "/private-cookie", None, None).await;
    assert_eq!(headers["cache-control"], "private, no-store", "personal, so `private` too");
    assert!(!headers.contains_key("cdn-cache-control"), "{headers:?}");
    // `NoStore` says `private` too, with no stage to add it, for a CDN that ignores a bare `no-store`.
    let (_, headers, _) = call_with(router.clone(), "GET", "/no-store", None, None).await;
    assert_eq!(headers["cache-control"], "private, no-store");
    // An upstream's `NoStore` answer, with no cookie, keeps none of the caching headers a CDN reads
    // first that the upstream sent (any `*cache-control` too): a CDN would obey them over it.
    let (status, headers, body) = call_with(router.clone(), "GET", "/relayed-no-store", None, None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "once"));
    assert_eq!(headers["cache-control"], "private, no-store");
    for cdn in [
        "cdn-cache-control",
        "cloudflare-cdn-cache-control",
        "vercel-cdn-cache-control",
        "surrogate-control",
        "edge-control",
        "x-accel-expires",
        "foo-cache-control",
    ] {
        assert!(!headers.contains_key(cdn), "{cdn}: {headers:?}");
    }
    assert_eq!(headers["surrogate-key"], "ids", "a CDN's header that keeps nothing stays");
    // Whatever type it says: a list a browser takes the last of too.
    let (_, headers, _) = call_with(router.clone(), "GET", "/listed", None, None).await;
    assert_eq!(headers["content-security-policy"], "sandbox");
    // A link to it is not fetched ahead of a click.
    assert_eq!(html! { <a href={unstaged_url::Picture}>"P"</a> }.to_html(), r#"<a href="/picture" data-no-prefetch>P</a>"#);
    // A panic is a plain 500, and the next request is served.
    let (status, headers, body) = call_with(router.clone(), "GET", "/boom", None, Some("text/html")).await;
    assert_eq!((status, body.as_str()), (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"));
    assert_eq!(headers["x-content-type-options"], "nosniff");
    let (status, _, _) = call_with(router.clone(), "GET", "/ping", None, None).await;
    assert_eq!(status, StatusCode::OK);
    // A path that does not parse is the extractor's own rejection, not the error page.
    let (status, headers, _) = call_with(router.clone(), "GET", "/raw/seven", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(headers.get_all("content-security-policy").iter().collect::<Vec<_>>(), ["sandbox"], "not the error page's policy");
    // A method it has no handler for is a plain 405 with the router's `Allow` and the headers
    // every unstaged answer gets, not the error page; one no route in the app has (`PUT` here) a
    // plain 501 with no `Allow`, the same way.
    let (status, headers, body) = call_with(router.clone(), "OPTIONS", "/ping", None, Some("text/html")).await;
    assert_eq!((status, headers["allow"].to_str().unwrap()), (StatusCode::METHOD_NOT_ALLOWED, "GET,HEAD"));
    assert_eq!(headers.get_all("content-security-policy").iter().collect::<Vec<_>>(), ["sandbox"], "{headers:?}");
    assert!(!body.contains("<html"), "{body}");
    let (status, headers, body) = call_with(router.clone(), "PUT", "/ping", None, Some("text/html")).await;
    assert_eq!((status, headers.get("allow")), (StatusCode::NOT_IMPLEMENTED, None));
    assert_eq!(headers.get_all("content-security-policy").iter().collect::<Vec<_>>(), ["sandbox"], "{headers:?}");
    assert!(!body.contains("<html"), "{body}");
    // A segment without the route's suffix is a plain 404, not the error page.
    let (status, _, body) = call_with(router.clone(), "GET", "/feeds/new.xml", None, None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "feed new"));
    let (status, headers, body) = call_with(router.clone(), "GET", "/feeds/new", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(headers.get_all("content-security-policy").iter().collect::<Vec<_>>(), ["sandbox"], "{headers:?}");
    assert!(!body.contains("<html"), "{body}");
    // Another host's request is the 421 first, at a method or a segment the route lacks too: the
    // router's own 405 and 404 go through the route's lane.
    let rebound = [("host", "rebound.attacker.example:3917")];
    for (method, uri) in [("PUT", "/ping"), ("GET", "/feeds/new")] {
        let (status, headers, _) = call_with_any(router.clone(), method, uri, &rebound).await;
        assert_eq!(status, StatusCode::MISDIRECTED_REQUEST, "{method} {uri}");
        assert_eq!(headers["x-content-type-options"], "nosniff", "{method} {uri}");
    }

    let (status, headers, _) = call_with(router.clone(), "GET", "/page", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::OK);
    for name in ["content-security-policy", "x-content-type-options", "cache-control"] {
        assert!(headers.contains_key(name), "the page beside it has {name}: {headers:?}");
    }
    let (status, body) = for_host(&router, "/page", "rebound.attacker.example:3917", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::MISDIRECTED_REQUEST, "Misdirected request."));
    // An unstaged route is not a page: no stage gives its answer the app's layout.
    let (_, _, body) = call_with(router.clone(), "GET", "/serves", None, None).await;
    assert_eq!(body, "false true");
    let (status, headers, body) = call_with(router, "GET", "/missing", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(headers.contains_key("content-security-policy"), "an unknown URL is still answered inside the stages");
    assert!(body.contains("<html"), "with the error page: {body}");
}

/// An unstaged route meets no stage, and the app keeps nothing for it: a file for everyone there,
/// which a route with stages would have kept, is its handler's for every request.
#[tokio::test]
async fn an_unstaged_route_s_file_is_not_kept() {
    use std::sync::atomic::Ordering;
    let router = App::new(unstaged_url::router()).router();
    let before = SITEMAPS.load(Ordering::Relaxed);
    for _ in 0..2 {
        let (status, headers, body) = call_with(router.clone(), "GET", "/sitemap.xml", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.len() >= 1024 && !headers.contains_key("age"), "{headers:?}");
        assert_eq!(headers["cache-control"], "public, max-age=3600");
        assert_eq!(headers["content-security-policy"], "sandbox");
    }
    assert_eq!(SITEMAPS.load(Ordering::Relaxed) - before, 2);
}

/// Beside an unstaged route every other route keeps its stages: an area's pages and its unknown URLs,
/// and another site's write to a staged route.
#[tokio::test]
async fn the_stages_hold_beside_an_unstaged_route() {
    let router = App::new(unstaged_url::router()).area(docs_url::area).error_page(test_error_page, ()).router();
    let (status, _, body) = call_with(router.clone(), "GET", "/docs/intro", None, None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "doc intro"));
    let (status, headers, body) = call_with(router.clone(), "GET", "/docs/intro/deeper", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(headers.contains_key("content-security-policy") && body.contains("<html"), "{headers:?} {body}");
    let cross = [("origin", "https://attacker.example"), ("sec-fetch-site", "cross-site")];
    let (status, _, _) = call_with_any(router.clone(), "POST", "/page", &cross).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "the staged route beside it still refuses another site's write");
    let (status, _, _) = call_with_any(router, "POST", "/raw/7", &cross).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "the unstaged one answers no write, and no route here takes one");
}

/// An unstaged JSON route's failure outside an API's prefix is sent as its handler made it: plain
/// text, not Problem Details, since no stage shapes it.
#[cfg(feature = "json")]
#[tokio::test]
async fn an_unstaged_route_s_failure_is_plain_text() {
    let router = App::new(unstaged_json_url::router()).router();
    let (status, headers, body) = call_with(router, "GET", "/figure", None, Some("application/json")).await;
    assert_eq!(
        (status, body.as_str()),
        (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
        "the cause stays in the log"
    );
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/plain"), "{headers:?}");
}

#[cfg(feature = "json")]
#[crate::routes]
mod unstaged_json_url {
    #[route("/figure", get = unstaged_figure, unstaged)]
    pub struct Figure;
}

#[cfg(feature = "json")]
async fn unstaged_figure() -> crate::JsonResult<u32> {
    Err(Error::new("the store is down").into())
}

/// A tower layer around the whole app still goes around an unstaged route.
#[tokio::test]
async fn a_layer_around_the_app_goes_around_an_unstaged_route() {
    let router = App::new(unstaged_url::router())
        .layer(OuterFn(|req: crate::http::Request, next: crate::Router| async move {
            let mut res = next.oneshot(req).await.unwrap();
            res.headers_mut().insert("x-outer", http::HeaderValue::from_static("1"));
            res
        }))
        .router();
    let (status, headers, _) = call_with_any(router, "GET", "/ping", &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers.get("x-outer").unwrap(), "1");
}

async fn call_with_any(
    router: Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, http::HeaderMap, String) {
    let mut req = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let (parts, body) = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
    (parts.status, parts.headers, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
}

/// An unstaged route in an area's module meets none of the area's middleware or error page; the
/// area's other routes and its unknown URLs meet all of them.
#[tokio::test]
async fn an_unstaged_route_in_an_area_meets_none_of_its_stages() {
    let router = App::new(Routes::new())
        .area(|area| unstaged_area::area(area).middleware(Step("area", true)))
        .error_page(test_error_page, ())
        .router();
    let flood = [("x-flood", "1")];
    let (status, headers, body) = call_with_any(router.clone(), "GET", "/quiet/ping", &flood).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "pong"), "the area's limit does not cover it");
    assert_eq!(headers["content-security-policy"], "sandbox");
    let (status, _, _) = call_with_any(router.clone(), "GET", "/quiet/page", &flood).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "the area's route beside it meets the limit");
    // Its own failure is plain, not the area's error page.
    let (status, headers, body) = call_with(router.clone(), "GET", "/quiet/fails", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(headers["content-security-policy"], "sandbox");
    assert!(!body.contains("<html"), "{body}");
    // An unknown URL there is still the area's.
    let (status, headers, body) = call_with(router, "GET", "/quiet/missing", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(headers["content-security-policy"] != "sandbox" && body.contains("<html"), "{headers:?} {body}");
}

#[crate::routes(area = Quiet)]
mod unstaged_area {
    #[route("/quiet")]
    pub struct Quiet;

    #[route("/quiet/ping", get = unstaged_ping, unstaged)]
    pub struct Ping;

    #[route("/quiet/page", get = unstaged_area_page)]
    pub struct Page;

    #[route("/quiet/fails", get = unstaged_area_fails, unstaged)]
    pub struct Fails;
}

async fn unstaged_area_fails() -> StatusCode {
    StatusCode::NOT_FOUND
}

/// Nor is its path routed again in another module, where its other methods would meet no stage.
#[test]
#[should_panic(expected = "says unstaged and its path is routed again in another module")]
fn an_unstaged_path_routed_again_elsewhere_is_refused_at_startup() {
    #[crate::routes]
    mod again {
        #[route("/quiet/ping", post = unstaged_area_page)]
        pub struct Ping;
    }
    let _ = App::new(again::router()).area(unstaged_area::area).router();
}

/// As the router matches it: a parameter's name and the text after it do not make a path apart.
#[test]
#[should_panic(expected = "says unstaged and its path is routed again in another module")]
fn an_unstaged_path_routed_again_with_another_suffix_is_refused_at_startup() {
    let _ = App::new(shelf_again::router()).area(shelf::area).router();
}

#[crate::routes(area = Shelf)]
mod shelf {
    #[route("/shelf")]
    pub struct Shelf;

    #[route("/shelf/{n}.xml", get = shelf_feed, unstaged)]
    pub struct Feed {
        pub n: u32,
    }
}

#[crate::routes]
mod shelf_again {
    #[route("/shelf/{id}.json", post = shelf_json)]
    pub struct Json {
        pub id: u32,
    }
}

async fn shelf_feed(at: crate::Params<shelf::Feed>) -> String {
    format!("feed {}", at.n)
}

async fn shelf_json(at: crate::Params<shelf_again::Json>) -> String {
    format!("json {}", at.id)
}

/// An unstaged route in an outer area's module whose path is under a nested area belongs to the
/// nested one's module.
#[test]
#[should_panic(expected = "is declared in the module of \"/quiet\", but its path is under the module of \"/quiet/inner\"")]
fn an_unstaged_route_under_a_nested_area_is_declared_in_its_module() {
    #[crate::routes(area = Outer)]
    mod outer {
        #[route("/quiet")]
        pub struct Outer;

        #[route("/quiet/inner/ping", get = unstaged_ping, unstaged)]
        pub struct InnerPing;
    }
    paths! { InnerArea = "/quiet/inner", InnerPage = "/quiet/inner/page" }
    let _ = App::new(Routes::new())
        .area(outer::area)
        .area::<InnerArea>(|area| area.route::<InnerPage>(crate::Methods::reads(get(|| async { "page" }))))
        .router();
}

/// Nor can its parameter reach an area's prefix.
#[test]
#[should_panic(expected = "says unstaged and can answer under \"/admin/quick\"")]
fn an_unstaged_parameter_that_reaches_an_area_s_prefix_is_refused_at_startup() {
    #[crate::routes(area = Admin)]
    mod admin {
        #[route("/admin")]
        pub struct Admin;

        #[route("/admin/{page}", get = unstaged_at, unstaged)]
        pub struct AdminPage<'a> {
            pub page: &'a str,
        }
    }
    let _ = App::new(Routes::new())
        .area(admin::area)
        .area::<AdminQuick>(|quick| quick.route::<AdminQuickSlow>(crate::Methods::reads(get(|| async { "slow" }))))
        .router();
}

async fn unstaged_area_page() -> &'static str {
    "page"
}

/// An unstaged route in an API's module meets none of the API's middleware or allowed origins,
/// and answers a failure as every failure under the prefix is answered: JSON, in the API's shape
/// when it gives one, with the headers an unstaged answer gets. The host check holds there too.
#[cfg(feature = "json")]
#[tokio::test]
async fn an_unstaged_route_in_an_api_answers_its_failures_as_the_api_does() {
    let router = App::new(Routes::new())
        .api(|api| unstaged_api::api(api).middleware(Step("api", true)).allow_origin("https://partner.example"))
        .router();
    let flood = [("x-flood", "1"), ("origin", "https://partner.example")];
    let (status, headers, body) = call_with_any(router.clone(), "GET", "/lane/items/7", &flood).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "7"), "the API's limit does not cover it");
    assert!(!headers.contains_key("access-control-allow-origin"), "nor its allowed origins: {headers:?}");
    assert_eq!(headers["content-security-policy"], "sandbox");
    let (status, _, _) = call_with_any(router.clone(), "GET", "/lane/staged", &flood).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "the API's route beside it meets the limit");
    // The handler's failure, a path that does not parse, and a method it has no handler for.
    let problem = "application/problem+json";
    let (status, headers, body) = call_with_any(router.clone(), "GET", "/lane/items/0", &[]).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::NOT_FOUND, problem));
    assert!(body.contains(r#""status":404"#), "{body}");
    assert_eq!(headers["content-security-policy"], "sandbox", "with the headers an unstaged answer gets");
    // `HEAD` meets the same failure, without its body.
    let (status, headers, body) = call_with_any(router.clone(), "HEAD", "/lane/items/0", &[]).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap(), body.as_str()), (StatusCode::NOT_FOUND, problem, ""));
    assert_eq!(headers["content-security-policy"], "sandbox");
    let (status, headers, _) = call_with_any(router.clone(), "GET", "/lane/items/seven", &[]).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::BAD_REQUEST, problem));
    let (status, headers, _) = call_with_any(router.clone(), "OPTIONS", "/lane/items/7", &[]).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::METHOD_NOT_ALLOWED, problem));
    assert_eq!(headers["allow"], "GET,HEAD");
    // One no route in the app has, with no `Allow`.
    let (status, headers, _) = call_with_any(router.clone(), "PUT", "/lane/items/7", &[]).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::NOT_IMPLEMENTED, problem));
    assert!(!headers.contains_key("allow") && headers["content-security-policy"] == "sandbox", "{headers:?}");
    // A segment without the route's suffix.
    let (status, _, body) = call_with_any(router.clone(), "GET", "/lane/files/a.txt", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "a"));
    let (status, headers, _) = call_with_any(router.clone(), "GET", "/lane/files/a", &[]).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::NOT_FOUND, problem));
    // A 5xx tells the client its reason, and the cause stays in the log.
    let (status, headers, body) = call_with_any(router.clone(), "GET", "/lane/figure", &[]).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::INTERNAL_SERVER_ERROR, problem));
    assert!(!body.contains("store is down"), "{body}");
    let (status, _, _) = call_with_any(router.clone(), "GET", "/lane/items/7", &[("host", "rebound.attacker.example")]).await;
    assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);
    // At a method or a segment the route lacks, it is the 421 too, not the API's JSON.
    for (method, uri) in [("PUT", "/lane/items/7"), ("GET", "/lane/files/a")] {
        let (status, headers, _) = call_with_any(router.clone(), method, uri, &[("host", "rebound.attacker.example")]).await;
        assert_eq!(status, StatusCode::MISDIRECTED_REQUEST, "{method} {uri}");
        assert!(!headers["content-type"].to_str().unwrap().contains("json"), "{method} {uri}: {headers:?}");
    }

    // A name the app's policy gives is answered, and only that one.
    let named =
        App::new(Routes::new()).api(unstaged_api::api).policy(crate::security::Policy::new().host("shop.example")).router();
    let (status, _, _) = call_with_any(named.clone(), "GET", "/lane/items/7", &[("host", "shop.example")]).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = call_with_any(named, "GET", "/lane/items/7", &[("host", "other.example")]).await;
    assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);

    let shaped = App::new(Routes::new())
        .api(|api| {
            unstaged_api::api(api).errors(|status, message| ShapedError {
                r#type: "error",
                error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
            })
        })
        .router();
    let (status, headers, body) = call_with_any(shaped.clone(), "GET", "/lane/items/0", &[]).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::NOT_FOUND, "application/json"));
    assert_eq!(body, r#"{"type":"error","error":{"code":404,"message":"Not Found"}}"#);
    // The router's 501, for a method no route in the app has, is in the API's shape too.
    let (status, headers, body) = call_with_any(shaped, "PUT", "/lane/items/7", &[]).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::NOT_IMPLEMENTED, "application/json"));
    assert_eq!(body, r#"{"type":"error","error":{"code":501,"message":"Not Implemented"}}"#);
    assert!(!headers.contains_key("allow"), "{headers:?}");

    // A panic there is the API's 500.
    let router = App::new(Routes::new()).api(unstaged_api::api).router();
    let (status, headers, body) = call_with_any(router, "GET", "/lane/boom", &[]).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::INTERNAL_SERVER_ERROR, problem));
    assert!(!body.contains("broken"), "{body}");

    // In an API inside another, the innermost's shape.
    let nested = App::new(Routes::new())
        .api(unstaged_api::api)
        .api(|api| {
            unstaged_inner::api(api).errors(|status, message| ShapedError {
                r#type: "inner",
                error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
            })
        })
        .router();
    let (status, headers, body) = call_with_any(nested.clone(), "GET", "/lane/inner/missing", &[]).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::NOT_FOUND, "application/json"));
    assert!(body.contains(r#""type":"inner""#), "{body}");
    let (_, headers, _) = call_with_any(nested, "GET", "/lane/items/0", &[]).await;
    assert_eq!(headers["content-type"], problem, "the outer API's own route keeps the outer's");
}

#[cfg(feature = "json")]
#[crate::routes(api = Inner)]
mod unstaged_inner {
    #[route("/lane/inner")]
    pub struct Inner;

    #[route("/lane/inner/missing", get = unstaged_missing, unstaged)]
    pub struct Missing;
}

#[cfg(feature = "json")]
async fn unstaged_missing() -> crate::JsonResult<u32> {
    Err(Error::not_found().into())
}

#[cfg(feature = "json")]
#[crate::routes(api = Lane)]
mod unstaged_api {
    #[route("/lane")]
    pub struct Lane;

    #[route("/lane/items/{id}", get = unstaged_item, unstaged)]
    pub struct Item {
        pub id: u32,
    }

    #[route("/lane/figure", get = unstaged_figure, unstaged)]
    pub struct Figure;

    #[route("/lane/staged", get = staged_item)]
    pub struct Staged;

    #[route("/lane/boom", get = unstaged_boom, unstaged)]
    pub struct Boom;

    #[route("/lane/files/{name}.txt", get = unstaged_file, unstaged)]
    pub struct File {
        pub name: String,
    }
}

#[cfg(feature = "json")]
async fn unstaged_file(at: crate::Params<unstaged_api::File>) -> String {
    at.name.clone()
}

#[cfg(feature = "json")]
async fn unstaged_item(at: crate::Params<unstaged_api::Item>) -> crate::JsonResult<u32> {
    match at.id {
        0 => Err(Error::not_found().into()),
        id => Ok(crate::Json(id)),
    }
}

#[cfg(feature = "json")]
async fn staged_item() -> crate::JsonResult<u32> {
    Ok(crate::Json(1))
}

/// An unstaged route in the app's routes under an area's prefix would skip what the area says
/// covers every request there, unseen by a reader of the area's module.
#[test]
#[should_panic(expected = "says unstaged and is declared in the app's routes, but its path is under the module of \"/docs\"")]
fn an_unstaged_route_under_an_area_is_declared_in_the_area_s_module() {
    #[crate::routes]
    mod under_area {
        #[route("/docs/ping", get = unstaged_ping, unstaged)]
        pub struct DocsPing;
    }
    let _ = App::new(under_area::router()).area(docs_url::area).router();
}

/// Nor can its parameter reach an API's prefix, where a staged route is turned away per request.
#[test]
#[should_panic(expected = "says unstaged and can answer under \"/pay/api\"")]
fn an_unstaged_parameter_that_reaches_an_api_s_prefix_is_refused_at_startup() {
    #[crate::routes]
    mod reaching {
        #[route("/pay/{step}", get = unstaged_at, unstaged)]
        pub struct PayStep<'a> {
            pub step: &'a str,
        }
    }
    let _ = App::new(reaching::router())
        .api::<PayApi>(|api| api.route::<PayApiGo>(crate::Methods::reads(get(|| async { "go" }))))
        .router();
}

/// Nor an outer API's, at an inner API's prefix.
#[test]
#[should_panic(expected = "says unstaged and can answer under \"/outer/inner\"")]
fn an_outer_api_s_unstaged_parameter_at_an_inner_api_s_prefix_is_refused_at_startup() {
    #[crate::routes(api = Outer)]
    mod outer {
        #[route("/outer")]
        pub struct Outer;

        #[route("/outer/{id}", get = unstaged_at, unstaged)]
        pub struct Thing<'a> {
            pub id: &'a str,
        }
    }
    paths! { Inner = "/outer/inner", InnerGo = "/outer/inner/go" }
    let _ = App::new(Routes::new())
        .api(outer::api)
        .api::<Inner>(|api| api.route::<InnerGo>(crate::Methods::reads(get(|| async { "go" }))))
        .router();
}

/// Nor at a path of Corten's own the app adds (the PWA's manifest), which would otherwise answer
/// there outside the stages.
#[test]
#[should_panic(expected = "says unstaged and can answer at \"/manifest.webmanifest\"")]
fn an_unstaged_route_at_a_path_of_corten_s_own_is_refused_at_startup() {
    #[crate::routes]
    mod at_manifest {
        #[route("/manifest.webmanifest", get = unstaged_ping, unstaged)]
        pub struct Manifest;
    }
    let _ = App::new(at_manifest::router()).pwa(crate::pwa::Pwa::new(crate::pwa::Manifest::new("A", "A"))).router();
}

/// Nor at the PWA's offline page, which the service worker would show for every navigation made
/// offline.
#[test]
#[should_panic(expected = "says unstaged and can answer at \"/offline\"")]
fn an_unstaged_route_at_the_offline_page_is_refused_at_startup() {
    #[crate::routes]
    mod at_offline {
        #[route("/offline", get = unstaged_ping, unstaged)]
        pub struct Offline;
    }
    let _ = App::new(at_offline::router()).pwa(crate::pwa::Pwa::new(crate::pwa::Manifest::new("A", "A"))).router();
}

/// Nor one whose parameter stands under a prefix of Corten's the app adds when it starts (the
/// assets'), which the routes macro cannot see: the parameters it can see, a first segment or
/// `/health/{..}`, do not compile (`compile_fail` doctests in `route.rs`).
#[test]
#[should_panic(expected = "says unstaged and can answer at \"/assets\"")]
fn an_unstaged_parameter_under_the_assets_is_refused_at_startup() {
    let _ = App::new(unstaged_assets_url::router()).assets(IconStatic).router();
}

#[crate::routes]
mod unstaged_assets_url {
    #[route("/assets/{file}", get = unstaged_asset_ping, unstaged)]
    pub struct File<'a> {
        pub file: &'a str,
    }
}

async fn unstaged_asset_ping(_: crate::Params<unstaged_assets_url::File<'_>>) -> &'static str {
    "pong"
}

/// Unstaged routes whose answers are `Public`, or an answer type of the app's own that may hold one.
#[crate::routes]
pub(super) mod unstaged_shared_url {
    #[route("/shared-keyed", get = unstaged_shared_keyed, unstaged)]
    pub struct SharedKeyed;

    #[route("/shared-plain", get = unstaged_shared_plain, unstaged)]
    pub struct SharedPlain;

    #[route("/mixed-keyed", get = unstaged_mixed_keyed, unstaged)]
    pub struct MixedKeyed;

    #[route("/boxed-keyed", get = unstaged_boxed_keyed, unstaged)]
    pub struct BoxedKeyed;

    #[route("/part-keyed", get = unstaged_part_keyed, unstaged)]
    pub struct PartKeyed;

    #[route("/status-part-keyed", get = unstaged_status_part_keyed, unstaged)]
    pub struct StatusPartKeyed;

    #[route("/no-store-relay-keyed", get = unstaged_no_store_relay_keyed, unstaged)]
    pub struct NoStoreRelayKeyed;

    #[route("/no-store-relay-plain", get = unstaged_no_store_relay_plain, unstaged)]
    pub struct NoStoreRelayPlain;

    #[route("/relay-keyed", get = unstaged_relay_keyed, unstaged)]
    pub struct RelayKeyed;

    #[route("/relay-plain", get = unstaged_relay_plain, unstaged)]
    pub struct RelayPlain;

    #[route("/cookie-keyed", get = unstaged_cookie_keyed, unstaged)]
    pub struct CookieKeyed;
}

/// A form's submit key rendered to a string, in an answer that says any cache may keep it.
async fn unstaged_shared_keyed() -> crate::Public<String> {
    let field = crate::SubmitKey::field(KeyedWrite::FIELDS.submit).to_html();
    crate::Public::new(Duration::from_secs(60), field)
}

async fn unstaged_shared_plain() -> crate::Public<String> {
    crate::Public::new(Duration::from_secs(60), "plain".to_string())
}

/// An answer type of the app's own, which says nothing of what it holds: here a `Public` answer.
struct Wrapped(crate::Public<String>);

impl crate::response::IntoResponse for Wrapped {
    fn into_response(self) -> crate::response::Response {
        self.0.into_response()
    }
}

async fn unstaged_mixed_keyed() -> Wrapped {
    Wrapped(unstaged_shared_keyed().await)
}

/// An answer erased behind a trait of the app's own over `IntoResponse`, as `dyn IntoResponse`
/// can be: Corten does not see what the box holds, here a `Public` answer.
trait Boxed: crate::response::IntoResponse + Send {
    fn respond(self: Box<Self>) -> crate::response::Response;
}

impl<T: crate::response::IntoResponse + Send> Boxed for T {
    fn respond(self: Box<Self>) -> crate::response::Response {
        (*self).into_response()
    }
}

impl crate::response::IntoResponse for Box<dyn Boxed> {
    fn into_response(self) -> crate::response::Response {
        self.respond()
    }
}

async fn unstaged_boxed_keyed() -> Box<dyn Boxed> {
    Box::new(unstaged_shared_keyed().await)
}

/// An unstaged route has no stage to settle its caching, so one whose answer may be `Public` is
/// watched for a submit key its handler draws, as a staged one is: an answer that holds one goes
/// out `private, no-cache`, a new key for each request, and one without keeps its lifetime.
#[tokio::test]
async fn an_unstaged_public_answer_whose_handler_drew_a_submit_key_is_the_browser_s_alone() {
    let router = App::new(unstaged_shared_url::router()).router();
    for path in ["/shared-keyed", "/mixed-keyed", "/boxed-keyed"] {
        let (status, headers, body) = call_with(router.clone(), "GET", path, None, None).await;
        let (_, again, other) = call_with(router.clone(), "GET", path, None, None).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        for headers in [&headers, &again] {
            assert_eq!(headers["cache-control"], "private, no-cache", "{path}: {headers:?}");
            assert_eq!(headers["content-security-policy"], "sandbox", "{path}");
        }
        assert!(body.contains("data-submit value=") && body != other, "{path}: a key for each");
    }
    let (status, headers, _) = call_with(router.clone(), "GET", "/shared-plain", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "public, max-age=60");
}

/// A header part of the app's own whose refusal is the whole answer: here a `Public` one.
struct Refusing(crate::Public<String>);

impl crate::response::IntoResponseParts for Refusing {
    type Error = crate::Public<String>;

    fn into_response_parts(
        self,
        _: crate::response::ResponseParts,
    ) -> Result<crate::response::ResponseParts, crate::Public<String>> {
        Err(self.0)
    }
}

async fn unstaged_part_keyed() -> (Refusing, ()) {
    (Refusing(unstaged_shared_keyed().await), ())
}

async fn unstaged_status_part_keyed() -> (StatusCode, Option<Refusing>, ()) {
    (StatusCode::NO_CONTENT, Some(Refusing(unstaged_shared_keyed().await)), ())
}

/// A relayed body with the upstream's own caching header for CDNs and its tag.
fn upstream(body: String) -> crate::Public<crate::Relay> {
    let mut headers = http::HeaderMap::new();
    headers.insert("surrogate-control", http::HeaderValue::from_static("max-age=3600"));
    headers.insert(http::header::ETAG, http::HeaderValue::from_static("\"upstream\""));
    crate::Public::new(Duration::from_secs(60), crate::Relay::new(StatusCode::OK, headers, Body::from(body)))
}

fn keyed_field() -> String {
    crate::SubmitKey::field(KeyedWrite::FIELDS.submit).to_html()
}

async fn unstaged_no_store_relay_keyed() -> crate::NoStore<crate::Public<crate::Relay>> {
    crate::NoStore(upstream(keyed_field()))
}

async fn unstaged_no_store_relay_plain() -> crate::NoStore<crate::Public<crate::Relay>> {
    crate::NoStore(upstream("plain".into()))
}

async fn unstaged_relay_keyed() -> crate::Public<crate::Relay> {
    upstream(keyed_field())
}

async fn unstaged_relay_plain() -> crate::Public<crate::Relay> {
    upstream("plain".into())
}

/// A keyed `Public` body that sets a cookie and says `no-store` with the headers before it.
async fn unstaged_cookie_keyed() -> ([(http::HeaderName, &'static str); 2], crate::Public<String>) {
    ([(http::header::CACHE_CONTROL, "no-store"), (http::header::SET_COOKIE, "seen=1")], unstaged_shared_keyed().await)
}

/// A tuple's part answers in the body's place when it refuses, so a part of the app's own whose
/// refusal is a `Public` answer is watched as that answer is, with or without a status first: a
/// handler that drew a key goes out `private, no-cache` with the refusal's body, not with its
/// lifetime.
#[tokio::test]
async fn an_unstaged_tuple_whose_part_refuses_with_a_keyed_public_answer_is_the_browser_s_alone() {
    let router = App::new(unstaged_shared_url::router()).router();
    for path in ["/part-keyed", "/status-part-keyed"] {
        let (status, headers, body) = call_with(router.clone(), "GET", path, None, None).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(headers["cache-control"], "private, no-cache", "{path}: {headers:?}");
        assert!(body.contains("data-submit value="), "{path}");
    }
}

/// `NoStore` around a `Public` relay is watched as the relay is: one whose handler drew a key goes
/// out `private, no-store` without the upstream's `Surrogate-Control`, which `no-store` does not
/// replace, and without its tag; one without a key goes out `private, no-store` without that
/// header too, as every unstaged `NoStore` answer does, and keeps its tag.
#[tokio::test]
async fn an_unstaged_no_store_answer_around_a_keyed_public_relay_keeps_no_cdn_header() {
    let router = App::new(unstaged_shared_url::router()).router();
    let (status, headers, body) = call_with(router.clone(), "GET", "/no-store-relay-keyed", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "private, no-store", "{headers:?}");
    assert!(!headers.contains_key("surrogate-control") && !headers.contains_key("etag"), "{headers:?}");
    assert!(body.contains("data-submit value="));
    let (_, headers, _) = call_with(router.clone(), "GET", "/no-store-relay-plain", None, None).await;
    assert_eq!(headers["cache-control"], "private, no-store", "{headers:?}");
    assert!(!headers.contains_key("surrogate-control") && headers["etag"] == "\"upstream\"", "{headers:?}");
}

/// An unstaged answer whose handler drew a key goes out without a tag it was given, an upstream's
/// here; a `Public` relay without one keeps the upstream's tag and caching header.
#[tokio::test]
async fn an_unstaged_answer_whose_handler_drew_a_submit_key_keeps_no_tag_it_was_given() {
    let router = App::new(unstaged_shared_url::router()).router();
    let (status, headers, _) = call_with(router.clone(), "GET", "/relay-keyed", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "private, no-cache", "{headers:?}");
    assert!(!headers.contains_key("etag") && !headers.contains_key("surrogate-control"), "{headers:?}");
    let (_, headers, _) = call_with(router.clone(), "GET", "/relay-plain", None, None).await;
    assert_eq!(headers["cache-control"], "public, max-age=60", "{headers:?}");
    assert_eq!(headers["etag"], "\"upstream\"", "{headers:?}");
    assert_eq!(headers["surrogate-control"], "max-age=3600", "{headers:?}");
}

/// The unstaged lane's pass over an answer that sets a cookie keeps the `private` beside the
/// `no-store` the watch wrote on a keyed answer, for a CDN that ignores a bare `no-store`.
#[tokio::test]
async fn an_unstaged_keyed_answer_that_sets_a_cookie_stays_private_no_store() {
    let router = App::new(unstaged_shared_url::router()).router();
    let (status, headers, body) = call_with(router.clone(), "GET", "/cookie-keyed", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "private, no-store", "{headers:?}");
    assert_eq!(headers["set-cookie"], "seen=1");
    assert!(body.contains("data-submit value="));
}

/// An unstaged answer whose handler drew a submit key carries that with it, as one that sets a
/// cookie does: another app of Corten's whose staged middleware relays it inline and writes a
/// CDN's lifetime on it still sends it `private` (`private, no-store` where the middleware named
/// `no-store`), with none of the caching headers a CDN reads first, as a staged keyed answer
/// relayed that way goes out. A `Public` answer with no key, relayed the same way, keeps what the
/// middleware wrote (the control).
#[tokio::test]
async fn an_unstaged_keyed_answer_relayed_inline_by_another_app_is_still_not_shared() {
    use super::cache::{kept_from_cdns, CdnRecaches, RelaysAnotherApp};
    let other = App::new(unstaged_shared_url::router()).router();
    let home = || get(|| async { "home" });
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(Table::new().route("/shared-keyed", home()).route("/shared-plain", home())))
            .middleware((CdnRecaches(cache), RelaysAnotherApp(other.clone())))
            .router();
        let (status, headers, body) = call_with(router.clone(), "GET", "/shared-keyed", None, None).await;
        assert_eq!(status, StatusCode::OK, "{cache:?}");
        assert!(body.contains("data-submit value="), "{cache:?}: the other app's answer: {body}");
        for what in kept_from_cdns(&headers, sent) {
            wrong.push(format!("{cache:?}: {what}"));
        }
        let (status, headers, body) = call_with(router.clone(), "GET", "/shared-plain", None, None).await;
        assert!(status == StatusCode::OK && body == "plain", "{cache:?}: {status} {body}");
        assert_eq!(headers["surrogate-control"], "public, max-age=60", "{cache:?}: nothing made it personal");
    }
    assert!(wrong.is_empty(), "another app's unstaged keyed answer relayed inline, open to a CDN: {wrong:#?}");
}
