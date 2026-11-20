use super::security::policy_url;
use super::url::leading_url;
use super::*;

#[tokio::test]
async fn runtime_is_served_at_a_versioned_immutable_url() {
    assert!(runtime_path().starts_with(&format!("/corten/{}/", runtime_version())));
    let res = app(routes(), None).oneshot(Request::get(runtime_path()).body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["cache-control"], "public, max-age=31536000, immutable");
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
crate::assets::embed!(struct SvgIconStatic = "src/assets/favicon-svg");

#[crate::routes]
mod favicon_url {
    #[route("/favicon.ico", get = own_icon)]
    pub struct OwnIcon;
}

#[crate::routes(api = RootApi)]
mod root_api {
    #[route("/")]
    pub struct RootApi;

    #[route("/v1/ping", get = root_ping)]
    pub struct RootPing;
}

async fn root_ping() -> &'static str {
    "pong"
}

#[crate::routes(api = IconApiRoot)]
mod icon_api {
    #[route("/")]
    pub struct IconApiRoot;

    #[route("/favicon.ico", get = own_icon)]
    pub struct ApiIcon;
}

async fn own_icon() -> &'static str {
    "the app's own"
}

/// `/favicon.ico`, which browsers ask for on their own, is the static directory's icon at a fixed
/// path: its `favicon.ico` when it has one, else its `favicon.svg`, each as its type with a
/// day's cache and its ETag, and a 304 for a cache that has it. No page is drawn (#1056).
#[tokio::test]
async fn the_favicon_path_is_the_static_directory_s_icon() {
    let ico = App::new(policy_url::router()).assets(IconStatic).router();
    let svg = App::new(policy_url::router()).assets(SvgIconStatic).router();
    for (router, kind, bytes) in [
        (ico, "image/x-icon", &include_bytes!("../assets/favicon-ico/favicon.ico")[..]),
        (svg, "image/svg+xml", &include_bytes!("../assets/favicon-svg/favicon.svg")[..]),
    ] {
        let res = router.clone().oneshot(Request::get("/favicon.ico").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{kind}");
        assert_eq!(res.headers()[header::CONTENT_TYPE], kind);
        assert_eq!(res.headers()[header::CACHE_CONTROL], "public, max-age=86400", "{kind}");
        let etag = res.headers()[header::ETAG].clone();
        assert_eq!(&res.into_body().collect().await.unwrap().to_bytes()[..], bytes, "{kind}");
        // Compared weakly: the tag as sent, marked weak by a proxy, in a list, or `*`.
        let tag = etag.to_str().unwrap();
        let strong = tag.strip_prefix("W/").unwrap_or(tag);
        let weak = format!("W/{strong}");
        let listed = format!(r#""other", {}"#, etag.to_str().unwrap());
        for tag in [tag, strong, &weak, &listed, "*"] {
            let again = Request::get("/favicon.ico").header(header::IF_NONE_MATCH, tag).body(Body::empty()).unwrap();
            assert_eq!(router.clone().oneshot(again).await.unwrap().status(), StatusCode::NOT_MODIFIED, "{kind}: {tag}");
        }
        let head = router.oneshot(Request::head("/favicon.ico").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(
            (head.status(), &head.headers()[header::CONTENT_TYPE]),
            (StatusCode::OK, &kind.parse::<header::HeaderValue>().unwrap())
        );
        assert!(head.into_body().collect().await.unwrap().to_bytes().is_empty(), "{kind}: HEAD has no body");
    }
}

/// Through the app, a range of a static file's versioned URL is the bytes asked for and a range
/// past its end is a bare 416 naming the file's length, not the app's error page, whatever the
/// client accepts; the favicon's URL, which may name other bytes after a deploy, is sent whole
/// (#1133).
#[tokio::test]
async fn a_range_through_the_app_is_answered_as_the_file_server_answers_it() {
    let router = App::new(policy_url::router()).assets(RefusedStatic).error_page(asset_error_page, ()).router();
    let bytes = &include_bytes!("../assets/fixture/style.css")[..];
    // The stylesheet's versioned URL, from the error page its layout draws.
    let refused = Request::post("/")
        .header("origin", "https://evil.example")
        .header("sec-fetch-site", "cross-site")
        .header("accept", "text/html")
        .body(Body::empty())
        .unwrap();
    let page = router.clone().oneshot(refused).await.unwrap().into_body().collect().await.unwrap().to_bytes();
    let page = String::from_utf8(page.to_vec()).unwrap();
    let href = page.split(r#"<link rel="stylesheet" href=""#).nth(1).and_then(|rest| rest.split('"').next()).unwrap();
    let ranged = |url: &str, range: &'static str| {
        let req = Request::get(url).header(header::RANGE, range).header(header::ACCEPT, "text/html");
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };
    let part = ranged(href, "bytes=2-3").await.unwrap();
    assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(part.headers()[header::CONTENT_RANGE], format!("bytes 2-3/{}", bytes.len()));
    assert_eq!(&part.into_body().collect().await.unwrap().to_bytes()[..], &bytes[2..4]);
    let past = ranged(href, "bytes=100-").await.unwrap();
    assert_eq!(past.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(past.headers()[header::CONTENT_RANGE], format!("bytes */{}", bytes.len()));
    assert!(past.into_body().collect().await.unwrap().to_bytes().is_empty(), "no error page");
    let icon = App::new(policy_url::router()).assets(IconStatic).router();
    let req = Request::get("/favicon.ico").header(header::RANGE, "bytes=2-3").body(Body::empty()).unwrap();
    let whole = icon.oneshot(req).await.unwrap();
    assert_eq!(whole.status(), StatusCode::OK, "the favicon's URL is sent whole");
    let icon_bytes = &include_bytes!("../assets/favicon-ico/favicon.ico")[..];
    assert_eq!(whole.into_body().collect().await.unwrap().to_bytes().len(), icon_bytes.len());
}

/// An API at `/` leaves `/favicon.ico` to Corten, the icon or the empty 404 whatever the client
/// accepts, unless the API has a route there (#1056).
#[tokio::test]
async fn an_api_at_the_root_leaves_the_favicon_path_to_corten_unless_it_has_a_route_there() {
    let icon = App::new(Routes::new()).assets(IconStatic).api(root_api::api).router();
    let (status, headers, _) = call_with(icon, "GET", "/favicon.ico", None, Some("application/json")).await;
    assert_eq!(
        (status, &headers[header::CONTENT_TYPE]),
        (StatusCode::OK, &"image/x-icon".parse::<header::HeaderValue>().unwrap())
    );
    for accept in ["text/html", "application/json"] {
        // The API's own settings (its middleware here) are not Corten's route's, as for the
        // health checks.
        let none = App::new(Routes::new()).api(|routes| root_api::api(routes).middleware(Stamp)).router();
        let (status, headers, body) = call_with(none.clone(), "GET", "/favicon.ico", None, Some(accept)).await;
        assert_eq!((status, body.as_str()), (StatusCode::NOT_FOUND, ""), "{accept}");
        assert!(!headers.contains_key(header::CONTENT_TYPE), "{accept}: not the API's problem document");
        assert!(!headers.contains_key("x-request-id"), "{accept}: the API's middleware does not run");
        let (_, headers, _) = call_with(none, "GET", "/v1/ping", None, Some(accept)).await;
        assert_eq!(headers["x-request-id"], "r-1", "{accept}: it does for the API's routes");
    }
    let (_, _, body) = call_with(App::new(Routes::new()).api(root_api::api).router(), "GET", "/nope", None, None).await;
    assert!(body.starts_with('{'), "another unknown URL is the API's: {body}");
    let own = App::new(Routes::new()).assets(IconStatic).api(icon_api::api).router();
    let (status, _, body) = call_with(own, "GET", "/favicon.ico", None, None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "the app's own"));
}

/// A route of the app's that matches `/favicon.ico` by a parameter or a catch-all takes it too,
/// as the router would pick it with no route of Corten's there (#1056).
#[tokio::test]
async fn a_catch_all_route_keeps_the_favicon_path() {
    let router = App::new(leading_url::router()).assets(IconStatic).router();
    let (status, _, body) = call_with(router, "GET", "/favicon.ico", None, None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "favicon.ico"));
}

/// A route of the app's at `/favicon.ico` answers it, not Corten's (#1056).
#[tokio::test]
async fn an_app_route_at_the_favicon_path_takes_it() {
    let router = App::new(favicon_url::router()).assets(IconStatic).router();
    let (status, _, body) = call_with(router, "GET", "/favicon.ico", None, None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "the app's own"));
}

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
