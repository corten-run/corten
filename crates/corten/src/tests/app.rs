#[cfg(feature = "log")]
use super::caller::docs_url;
#[cfg(feature = "log")]
use super::views::meters_app;
use super::*;

#[tokio::test]
async fn health_reports_liveness_and_readiness() {
    let router = App::new(Routes::new()).ready(|| async { false }).router();
    let get = |uri: &'static str| router.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap());
    assert_eq!(get("/health/live").await.unwrap().status(), StatusCode::OK);
    let ready = get("/health/ready").await.unwrap();
    assert_eq!(ready.status(), StatusCode::SERVICE_UNAVAILABLE);
    // Corten's own failure: never shared, and still kept out of every cache.
    assert_eq!(ready.headers()["cache-control"], "private, no-store");
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

/// An app with a stylesheet (its components', an area's or a static file) and no error page is told
/// so once, while it is developed, and a release build says nothing; one with an error page, or
/// with no stylesheet, is not told.
#[cfg(feature = "log")]
#[test]
fn an_app_with_a_stylesheet_and_no_error_page_is_told_once() {
    use std::sync::Mutex;
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
    let told = |app: fn() -> Router| {
        let lines = Lines(Arc::default());
        let writer = lines.clone();
        let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
        tracing::subscriber::with_default(subscriber, || drop(app()));
        let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
        text.matches("no App::error_page").count()
    };
    let once = usize::from(cfg!(debug_assertions));
    assert_eq!(
        told(|| App::new(Routes::from(meters())).components(&[TestMeter]).router()),
        once,
        "components' stylesheet, no error page"
    );
    assert_eq!(
        told(|| App::new(Routes::new()).area(|area| docs_url::area(area).components(&[TestMeter])).router()),
        once,
        "an area's"
    );
    assert_eq!(told(|| App::new(Routes::new()).assets(RefusedStatic).router()), once, "a static stylesheet");
    assert_eq!(told(meters_app), 0, "an error page of its own");
    assert_eq!(told(|| App::new(Routes::from(meters())).router()), 0, "no stylesheet: the plain document is the app's");
}

/// A layout's read started ahead by an extractor (`crate::Ahead`): under a path ending `/panics`
/// it panics, and `AHEAD_FINISHED` counts the reads that ran to their end.
struct StartedAhead(crate::Ahead<u32>);

static AHEAD_FINISHED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

impl<S: Sync> crate::extract::FromRequestParts<S> for StartedAhead {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut http::request::Parts, _: &S) -> Result<Self, Self::Rejection> {
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
        App::new(Routes::from(Table::new().route("/ahead/panics", awaited().0).route("/ahead/slow", awaited().0)))
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

/// An area's or an API's middleware runs for its own routes only (and a nested area's), after
/// the app's, outermost first and each in the order given; a refusal from one is answered in the
/// request's mode, as a caller's is.
#[tokio::test]
async fn an_area_or_an_api_has_middleware_of_its_own() {
    let steps = || {
        crate::Methods::reads(get(|headers: http::HeaderMap| async move {
            headers.get("x-steps").map_or(String::new(), |v| v.to_str().unwrap().to_string())
        }))
    };
    let router = App::new(Routes::from(Table::new().route("/slow", steps().0)))
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
    assert_eq!((status, &headers["retry-after"]), (StatusCode::TOO_MANY_REQUESTS, &"8".parse::<http::HeaderValue>().unwrap()));
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"), "a browser gets the error page: {headers:?}");
    let (status, headers, body2) = flood("/api/slow", "text/html").await;
    assert_eq!((status, &headers["retry-after"]), (StatusCode::TOO_MANY_REQUESTS, &"8".parse::<http::HeaderValue>().unwrap()));
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

/// Adds its name to the answer's `x-met`, so a test reads the middleware a request met, the
/// innermost first, a `404`'s too.
struct Met(&'static str);

impl crate::Middleware for Met {
    async fn call(&self, req: Request<Body>, next: impl crate::Next) -> crate::response::Response {
        let mut res = next.run(req).await;
        res.headers_mut().append("x-met", http::HeaderValue::from_static(self.0));
        res
    }
}

/// A parameter route of the area `/shop`, which can match the prefix of the area inside it.
#[derive(crate::Route)]
#[route("/shop/{id}")]
struct ShopAny<'a> {
    id: &'a str,
}

/// A parameter route of the area `/shop/desk`, which no other prefix holds a path of.
#[derive(crate::Route)]
#[route("/shop/desk/{id}")]
struct ShopDeskAny<'a> {
    id: &'a str,
}

/// An app whose area `/shop`, and `/shop/desk` inside it, each set a CSP source and middleware,
/// the outer one a deadline and both a body limit, over the app's shorter deadline and smaller
/// limit; with `catch_all`, the app's `/{*rest}` answers every path no other route does, and with
/// `shop_any`, the outer area's `/shop/{id}` every segment under `/shop`, `/shop/desk` among them,
/// and the inner area's `/shop/desk/{id}` every segment under `/shop/desk`.
/// Each route waits 200 ms for a `GET` with `x-slow`, and answers a `POST` with the length of
/// its body.
fn shop_app(catch_all: bool, shop_any: bool) -> Router {
    let answer = || {
        get(|headers: http::HeaderMap| async move {
            if headers.contains_key("x-slow") {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            "done"
        })
        .post(|body: crate::http::Bytes| async move { body.len().to_string() })
    };
    let routes = if catch_all { Table::new().route("/{*rest}", answer()) } else { Table::new() };
    App::new(Routes::from(routes))
        .error_page(test_error_page, ())
        .deadline(Duration::from_millis(50))
        .body_limit(1 << 10)
        .middleware(Met("app"))
        .area::<Shop>(|shop| {
            let shop = if shop_any { shop.route::<ShopAny>(crate::Methods::reads(answer())) } else { shop };
            shop.route::<ShopItem>(crate::Methods::reads(answer()))
                .deadline(Duration::from_secs(10))
                .body_limit(4 << 10)
                .policy(|p| p.img_src("https://img.example"))
                .middleware(Met("shop"))
        })
        .area::<ShopDesk>(|desk| {
            let desk = if shop_any { desk.route::<ShopDeskAny>(crate::Methods::reads(answer())) } else { desk };
            desk.route::<ShopDeskItem>(crate::Methods::reads(answer()))
                .body_limit(8 << 10)
                .policy(|p| p.script_src("https://js.example"))
                .middleware(Met("desk"))
        })
        .router()
}

/// A request to `shop_app`, from the app's own page: its status, the middleware it met (the
/// innermost first, between spaces), its CSP and its body.
async fn shop_call(router: &Router, method: &str, path: &str, slow: bool, body: usize) -> (StatusCode, String, String, String) {
    let mut req = Request::builder().method(method).uri(path).header("sec-fetch-site", "same-origin");
    if slow {
        req = req.header("x-slow", "1");
    }
    let res = router.clone().oneshot(req.body(Body::from(vec![b'a'; body])).unwrap()).await.unwrap();
    let (parts, body) = res.into_parts();
    let met = parts.headers.get_all("x-met").iter().map(|v| v.to_str().unwrap()).collect::<Vec<_>>().join(" ");
    let csp = parts.headers.get(http::header::CONTENT_SECURITY_POLICY).map_or("", |v| v.to_str().unwrap()).to_string();
    (parts.status, met, csp, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
}

/// A route in an area meets its area's deadline, body limit, CSP and middleware, and in an area
/// inside another those of both, the inner one's limit over the outer's and the outer's deadline
/// where the inner sets none; read from the route the router matched (#1213).
#[tokio::test]
async fn a_route_in_an_area_meets_its_areas_deadline_body_limit_csp_and_middleware() {
    let router = shop_app(false, false);
    let (status, met, csp, body) = shop_call(&router, "GET", "/shop/desk/item", true, 0).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "done"), "the outer area's deadline, not the app's 50 ms");
    assert_eq!(met, "desk shop app", "the app's middleware, then the outer area's, then the inner one's");
    assert!(csp.contains("https://js.example") && csp.contains("https://img.example"), "both areas' sources: {csp}");
    assert_eq!(shop_call(&router, "POST", "/shop/desk/item", false, 6 << 10).await.3, "6144", "the inner area's limit");
    assert_eq!(shop_call(&router, "POST", "/shop/desk/item", false, 9 << 10).await.0, StatusCode::PAYLOAD_TOO_LARGE);
    let (status, met, csp, body) = shop_call(&router, "GET", "/shop/item", true, 0).await;
    assert_eq!((status, &body[..], &met[..]), (StatusCode::OK, "done", "shop app"));
    assert!(csp.contains("https://img.example") && !csp.contains("https://js.example"), "the outer area's alone: {csp}");
    assert_eq!(shop_call(&router, "POST", "/shop/item", false, 3 << 10).await.3, "3072", "the outer area's limit");
    assert_eq!(shop_call(&router, "POST", "/shop/item", false, 5 << 10).await.0, StatusCode::PAYLOAD_TOO_LARGE);
}

/// An unknown URL's `404` belongs to the area its path is under: it meets that area's middleware
/// and has its CSP, and one outside every area the app's alone (#1213).
#[tokio::test]
async fn an_unknown_url_under_an_areas_prefix_is_answered_with_the_areas_settings() {
    let router = shop_app(false, false);
    let (status, met, csp, _) = shop_call(&router, "GET", "/shop/desk/nope", false, 0).await;
    assert_eq!((status, &met[..]), (StatusCode::NOT_FOUND, "desk shop app"));
    assert!(csp.contains("https://js.example") && csp.contains("https://img.example"), "{csp}");
    let (status, met, csp, _) = shop_call(&router, "GET", "/shop/nope", false, 0).await;
    assert_eq!((status, &met[..]), (StatusCode::NOT_FOUND, "shop app"));
    assert!(csp.contains("https://img.example") && !csp.contains("https://js.example"), "{csp}");
    let (status, met, csp, _) = shop_call(&router, "GET", "/nope", false, 0).await;
    assert_eq!((status, &met[..]), (StatusCode::NOT_FOUND, "app"));
    assert!(!csp.contains("https://img.example") && !csp.contains("https://js.example"), "{csp}");
}

/// A catch-all of the app's that matches a path under an area answers it with that area's
/// settings, its deadline, body limit, CSP and middleware, and every other path with the app's:
/// a route that can reach under another prefix is read by the request's path (#1213).
#[tokio::test]
async fn a_catch_all_outside_an_area_answers_under_it_with_the_areas_settings() {
    let router = shop_app(true, false);
    let (status, met, csp, body) = shop_call(&router, "GET", "/shop/desk/other", true, 0).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "done"), "the outer area's deadline");
    assert_eq!(met, "desk shop app");
    assert!(csp.contains("https://js.example") && csp.contains("https://img.example"), "{csp}");
    assert_eq!(shop_call(&router, "POST", "/shop/other", false, 3 << 10).await.3, "3072", "the area's limit");
    let (status, met, csp, body) = shop_call(&router, "GET", "/other", false, 0).await;
    assert_eq!((status, &body[..], &met[..]), (StatusCode::OK, "done", "app"), "the app's alone outside the areas");
    assert!(!csp.contains("https://img.example") && !csp.contains("https://js.example"), "{csp}");
    assert_eq!(shop_call(&router, "GET", "/other", true, 0).await.0, StatusCode::SERVICE_UNAVAILABLE, "the app's deadline");
    assert_eq!(shop_call(&router, "POST", "/other", false, 3 << 10).await.0, StatusCode::PAYLOAD_TOO_LARGE, "the app's limit");
}

/// An outer area's parameter route that matches the prefix of an area inside it (`/shop/{id}` at
/// `/shop/desk`) answers it with the inner area's settings, as every request under that prefix
/// meets: its middleware, CSP and body limit, and the outer area's deadline where it sets none.
/// Another segment keeps the outer area's alone (#1213).
#[tokio::test]
async fn an_outer_areas_parameter_route_at_an_inner_areas_prefix_meets_the_inner_areas_settings() {
    let router = shop_app(false, true);
    let (status, met, csp, body) = shop_call(&router, "GET", "/shop/desk", true, 0).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "done"), "the outer area's deadline, not the app's 50 ms");
    assert_eq!(met, "desk shop app", "the inner area's middleware too");
    assert!(csp.contains("https://js.example") && csp.contains("https://img.example"), "both areas' sources: {csp}");
    assert_eq!(shop_call(&router, "POST", "/shop/desk", false, 6 << 10).await.3, "6144", "the inner area's limit");
    assert_eq!(shop_call(&router, "POST", "/shop/desk", false, 9 << 10).await.0, StatusCode::PAYLOAD_TOO_LARGE);
    let (status, met, csp, body) = shop_call(&router, "GET", "/shop/other", true, 0).await;
    assert_eq!((status, &body[..], &met[..]), (StatusCode::OK, "done", "shop app"));
    assert!(csp.contains("https://img.example") && !csp.contains("https://js.example"), "the outer area's alone: {csp}");
    assert_eq!(shop_call(&router, "POST", "/shop/other", false, 6 << 10).await.0, StatusCode::PAYLOAD_TOO_LARGE);
    // The inner area's own parameter route, which has its scope from when the router is built.
    let (status, met, csp, body) = shop_call(&router, "GET", "/shop/desk/other", true, 0).await;
    assert_eq!((status, &body[..], &met[..]), (StatusCode::OK, "done", "desk shop app"), "the outer area's deadline too");
    assert!(csp.contains("https://js.example") && csp.contains("https://img.example"), "both areas' sources: {csp}");
    assert_eq!(shop_call(&router, "POST", "/shop/desk/other", false, 6 << 10).await.3, "6144", "the inner area's limit");
    assert_eq!(shop_call(&router, "POST", "/shop/desk/other", false, 9 << 10).await.0, StatusCode::PAYLOAD_TOO_LARGE);
}

/// An app's catch-all that answers a path under Corten's own `/corten/` or the assets' prefix
/// answers it with the app's settings alone, beside an area: no area's middleware and no tag, as
/// Corten's own routes are answered; elsewhere a page is tagged, and under the area it meets the
/// area's middleware (#1213).
#[tokio::test]
async fn a_catch_all_at_cortens_own_prefixes_answers_with_the_apps_settings() {
    let router = App::new(Routes::from(Table::new().route("/{*rest}", get(|| async { "done" }))))
        .middleware(Met("app"))
        .assets(RefusedStatic)
        .area::<Shop>(|shop| shop.route::<ShopItem>(crate::Methods::reads(get(|| async { "item" }))).middleware(Met("shop")))
        .router();
    let call = |path: &'static str| {
        let req = Request::get(path).header("if-none-match", r#"W/"other""#).body(Body::empty()).unwrap();
        let router = router.clone();
        async move {
            let res = router.oneshot(req).await.unwrap();
            let met = res.headers().get_all("x-met").iter().map(|v| v.to_str().unwrap()).collect::<Vec<_>>().join(" ");
            (res.status(), met, res.headers().contains_key(http::header::ETAG))
        }
    };
    // (`/assets/{version}/{*path}` is the assets' own route, so the catch-all never sees a path
    // with two segments under it.)
    for path in ["/corten/nope", "/assets/nope"] {
        assert_eq!(call(path).await, (StatusCode::OK, "app".to_string(), false), "{path}: Corten's own, untagged");
    }
    assert_eq!(call("/other").await, (StatusCode::OK, "app".to_string(), true), "the app's page, tagged");
    assert_eq!(call("/shop/other").await, (StatusCode::OK, "shop app".to_string(), true), "the area's");
}

/// A middleware reads the client's address as a handler would, and the answer is then private.
#[tokio::test]
async fn a_middleware_reads_the_client_address() {
    struct Seen;
    impl crate::Middleware for Seen {
        async fn call(&self, mut req: Request<Body>, next: impl crate::Next) -> crate::response::Response {
            let ip = crate::ClientIp::of(&mut req).map_or("none".to_string(), |crate::ClientIp(ip)| ip.to_string());
            req.headers_mut().insert("x-ip", ip.parse().unwrap());
            next.run(req).await
        }
    }
    let routes = Table::new().route(
        "/",
        get(|headers: http::HeaderMap, ip: Option<crate::ClientIp>| async move {
            format!(
                "{} {}",
                headers["x-ip"].to_str().unwrap(),
                ip.map_or("none".to_string(), |crate::ClientIp(ip)| ip.to_string())
            )
        }),
    );
    let router =
        App::new(Routes::from(routes)).middleware(Seen).router().layer(peer(std::net::SocketAddr::from(([203, 0, 113, 8], 1))));
    let (status, headers, body) = call_with(router, "GET", "/", None, Some("text/html")).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "203.0.113.8 203.0.113.8"), "the same address both ways");
    assert_eq!(headers["cache-control"], "private, no-cache", "an answer for one address is private");
}

/// `App::layer` is made once, around the whole app; it sees the request before its route is
/// matched, and may change the answer's body: after the layer the router empties a `HEAD`'s and
/// gives it that body's length, and leaves any other answer's length to the server, which writes
/// it from the body it is handed.
#[tokio::test]
async fn an_app_layer_is_made_once_outside_the_router() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    #[derive(Clone)]
    struct Count(Arc<AtomicUsize>);
    impl<S> tower_layer::Layer<S> for Count {
        type Service = S;
        fn layer(&self, inner: S) -> S {
            self.0.fetch_add(1, Ordering::Relaxed);
            inner
        }
    }
    let made = Arc::new(AtomicUsize::new(0));
    let matched = Arc::new(AtomicBool::new(false));
    let saw = matched.clone();
    let routes =
        Table::new().route("/", get(|| async { "hi" })).route("/other", get(|| async { "other" }).post(|| async { "posted" }));
    let router = App::new(Routes::from(routes))
        .layer(tower::util::MapResponseLayer::new(|res: crate::response::Response| {
            res.map(|_| Body::from("changed by the layer"))
        }))
        .layer(tower::util::MapRequestLayer::new(move |req: Request<Body>| {
            saw.fetch_or(req.extensions().get::<crate::middleware::MatchedPath>().is_some(), Ordering::Relaxed);
            req
        }))
        .layer(Count(made.clone()))
        .router();
    assert_eq!(made.load(Ordering::Relaxed), 1);
    let (status, headers, body) = call(router.clone(), "GET", None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "changed by the layer"));
    assert!(!headers.contains_key("content-length"), "no length from inside the layer: {headers:?}");
    let (status, headers, body) = call(router, "HEAD", None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, ""));
    assert_eq!(headers["content-length"], "20");
    assert!(!matched.load(Ordering::Relaxed), "a layer runs before the route is matched");
}

/// A `HEAD` is given no length where its `GET` has none. A `101` is among them, which a test over
/// a socket cannot ask for: hyper hands the connection on after one.
#[tokio::test]
async fn a_head_says_no_length_where_its_get_has_none() {
    let routes = Table::new()
        .route("/", get(|| async { "hi" }))
        .route("/switch", get(|| async { (StatusCode::SWITCHING_PROTOCOLS, "to") }))
        .route("/done", get(|| async { (StatusCode::NO_CONTENT, "said") }))
        .route("/same", get(|| async { StatusCode::NOT_MODIFIED }))
        .route("/chunked", get(|| async { ([(header::TRANSFER_ENCODING, "chunked")], "in chunks") }));
    let router = App::new(Routes::from(routes)).router();
    let (_, headers, body) = call_with(router.clone(), "HEAD", "/", None, None).await;
    assert_eq!((&headers["content-length"], body.as_str()), (&http::HeaderValue::from_static("2"), ""));
    for (path, status) in [
        ("/switch", StatusCode::SWITCHING_PROTOCOLS),
        ("/done", StatusCode::NO_CONTENT),
        ("/same", StatusCode::NOT_MODIFIED),
        ("/chunked", StatusCode::OK),
    ] {
        let (answered, headers, body) = call_with(router.clone(), "HEAD", path, None, None).await;
        assert_eq!(answered, status, "{path}");
        assert!(!headers.contains_key("content-length") && body.is_empty(), "{path}: {headers:?}");
    }
}

/// The server writes an answer's length from the body it is handed
/// (docs/design.md#choice-axum-router): the body an app layer left, `content-length: 0` for an
/// empty one, and none for a `204`, even one given a body. A `HEAD` carries the length its `GET`
/// does, from the router, so none for a `204` or a `304` either. An answer that says
/// `Transfer-Encoding` itself is sent chunked, with no length beside it or in its `HEAD`.
#[tokio::test]
async fn the_server_writes_an_answer_s_length_from_its_body() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let routes = Table::new()
        .route("/", get(|| async { "hi" }))
        .route("/empty", get(|| async { "" }))
        .route("/done", get(|| async { StatusCode::NO_CONTENT }))
        .route("/done/said", get(|| async { (StatusCode::NO_CONTENT, "said") }))
        .route("/same", get(|| async { StatusCode::NOT_MODIFIED }))
        .route("/chunked", get(|| async { ([(header::TRANSFER_ENCODING, "chunked")], "in chunks") }));
    let app = App::new(Routes::from(routes)).layer(tower::util::MapResponseLayer::new(|res: crate::response::Response| {
        use http_body::Body as _;
        match res.body().size_hint().exact() {
            Some(2) => res.map(|_| Body::from("changed by the layer")),
            _ => res,
        }
    }));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let send = |request: String| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        answer.to_ascii_lowercase()
    };
    let ask = |method: &'static str, path: &'static str| {
        send(format!("{method} {path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n"))
    };
    let lengths = |answer: &str| -> Vec<String> {
        answer.split("\r\n").filter_map(|line| line.strip_prefix("content-length: ")).map(str::to_owned).collect()
    };
    let (got, head) = (ask("GET", "/").await, ask("HEAD", "/").await);
    let (empty, empty_head) = (ask("GET", "/empty").await, ask("HEAD", "/empty").await);
    let (done, done_head) = (ask("GET", "/done").await, ask("HEAD", "/done").await);
    let (said, said_head) = (ask("GET", "/done/said").await, ask("HEAD", "/done/said").await);
    let (same, same_head) = (ask("GET", "/same").await, ask("HEAD", "/same").await);
    let (chunked, chunked_head) = (ask("GET", "/chunked").await, ask("HEAD", "/chunked").await);
    let older = send("GET / HTTP/1.0\r\nhost: localhost\r\n\r\n".to_owned()).await;
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    assert!(got.starts_with("http/1.1 200") && got.ends_with("\r\n\r\nchanged by the layer"), "{got}");
    assert_eq!(lengths(&got), ["20"], "{got}");
    assert!(head.starts_with("http/1.1 200") && head.ends_with("\r\n\r\n"), "{head}");
    assert_eq!(lengths(&head), ["20"], "{head}");
    assert!(empty.starts_with("http/1.1 200") && empty.ends_with("\r\n\r\n"), "{empty}");
    assert_eq!(lengths(&empty), ["0"], "{empty}");
    assert_eq!(lengths(&empty_head), ["0"], "{empty_head}");
    // RFC 9110 section 8.6: no `Content-Length` in a `204`, whatever body it was given, nor in
    // its `HEAD`.
    for answer in [&done, &done_head, &said, &said_head] {
        assert!(answer.starts_with("http/1.1 204") && answer.ends_with("\r\n\r\n"), "{answer}");
        assert!(lengths(answer).is_empty(), "{answer}");
    }
    // Nor a length of zero in a `304`, whose length may only be its `200`'s.
    for answer in [&same, &same_head] {
        assert!(answer.starts_with("http/1.1 304") && answer.ends_with("\r\n\r\n"), "{answer}");
        assert!(lengths(answer).is_empty(), "{answer}");
    }
    for answer in [&got, &head, &empty, &empty_head, &done, &done_head, &said, &said_head, &same, &same_head] {
        assert!(!answer.contains("transfer-encoding"), "{answer}");
    }
    // RFC 9112 section 6.2: no `Content-Length` beside a `Transfer-Encoding`.
    assert!(chunked.starts_with("http/1.1 200") && chunked.ends_with("\r\n\r\n9\r\nin chunks\r\n0\r\n\r\n"), "{chunked}");
    assert!(chunked.contains("\r\ntransfer-encoding: chunked\r\n") && lengths(&chunked).is_empty(), "{chunked}");
    assert!(chunked_head.starts_with("http/1.1 200") && chunked_head.ends_with("\r\n\r\n"), "{chunked_head}");
    assert!(lengths(&chunked_head).is_empty(), "{chunked_head}");
    // An HTTP/1.0 client, which reads no chunks, is told the length too.
    assert!(older.contains(" 200 ") && older.ends_with("\r\n\r\nchanged by the layer"), "{older}");
    assert_eq!(lengths(&older), ["20"], "{older}");
}
