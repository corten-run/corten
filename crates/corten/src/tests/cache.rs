use super::api::api_module;
use super::security::{big_policy_page, inline_default_page, inline_page, relayed_page};
use super::url::serves_url;
use super::*;

/// Pages marked for shared caches, one that sets a cookie, one that must never be stored, and one
/// that says nothing.
fn cached_routes() -> Table {
    let minute = std::time::Duration::from_secs(60);
    let home = || html! { <p>"home"</p> };
    Table::new()
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
                (StatusCode::BAD_REQUEST, appended(lines), "")
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
                (appended(lines), "limited")
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

#[tokio::test]
async fn what_the_app_renders_is_private_unless_it_says_otherwise() {
    let router = app(cached_routes(), None);
    assert_eq!(cache_control(&router, "/plain", &[]).await, "private, no-cache");
    assert_eq!(cache_control(&router, "/plain", &[("corten", "nav")]).await, "private, no-cache");
    assert_eq!(cache_control(&router, "/missing", &[]).await, "private, no-cache", "error pages too");
    assert_eq!(cache_control(&router, "/missing", &[("accept", "application/json")]).await, "private, no-cache");
    assert_eq!(cache_control(&router, runtime_path(), &[]).await, "public, max-age=31536000, immutable");
    assert_eq!(cache_control(&router, "/health/ready", &[]).await, "no-store", "Corten's own routes keep theirs");
    assert_eq!(cache_control(&router, "/statement", &[]).await, "private, no-store", "for a CDN that ignores a bare no-store");
    assert_eq!(
        cache_control(&router, "/statement", &[("cookie", "s=1")]).await,
        "private, no-store",
        "a request with credentials"
    );
}

/// `NoStore` holds for a failure too: the error page that replaces it is not kept either, and says
/// `private` too, as `NoStore` does, a data client's JSON included.
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
            assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-store", "{path} {extra:?}");
        }
    }
    // A form sent to the expired code: the runtime's action, answered with the error page.
    let req = Request::post("/code").header("sec-fetch-site", "same-origin").header("corten", "action");
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-store", "an action");
    // A header written by hand counts on any of its lines; the error page is `private, no-store`,
    // since the failure's other directives described its own answer.
    let res =
        router.clone().oneshot(Request::get("/lines").header("accept", "text/html").body(Body::empty()).unwrap()).await.unwrap();
    let lines: Vec<_> = res.headers().get_all(header::CACHE_CONTROL).iter().map(|v| v.to_str().unwrap().to_string()).collect();
    assert_eq!(lines, ["private, no-store"]);
    // Also when the error page read a caller.
    let res = app(cached_routes(), Some("ann"))
        .oneshot(Request::get("/lines").header("accept", "text/html").header("cookie", "s=1").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let lines: Vec<_> = res.headers().get_all(header::CACHE_CONTROL).iter().map(|v| v.to_str().unwrap().to_string()).collect();
    assert_eq!(lines, ["private, no-store"], "with a caller");
    // A line that is not text still counts.
    let res =
        router.clone().oneshot(Request::get("/odd").header("accept", "text/html").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-store");
}

async fn slips(crate::Params(at): crate::Params<no_store_url::Slips<'_>>) -> HtmlResult {
    let kept = at.id.parse::<u32>().map_err(|_| Error::status(StatusCode::BAD_REQUEST))?;
    Ok(crate::answer::HtmlResponse::new(crate::response::IntoResponse::into_response(format!("slips {kept}"))))
}

async fn my_slips(Caller(viewer): Caller<Viewer>) -> HtmlResult {
    Ok(crate::answer::HtmlResponse::new(crate::response::IntoResponse::into_response(format!("slips of {}", viewer.0))))
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
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-store", "{path}");
        assert!(res.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with(kind), "{path}: {:?}", res.headers());
    }
}

async fn slip_total(crate::Params(at): crate::Params<no_store_url::Total>) -> HtmlResult {
    Ok(crate::answer::HtmlResponse::new(crate::response::IntoResponse::into_response(format!("total {}", at.id))))
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
    Ok(crate::answer::HtmlResponse::new(crate::response::IntoResponse::into_response(format!("new key of {}", viewer.0))))
}

/// `no_store(post)`: only the write's answer, and a write its extractors refuse, are `no-store`
/// (`private` too, since they read a caller); the page is as any page that reads a caller (#844).
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
            assert_eq!(cache, "private, no-store", "{method} {viewer:?}");
        } else {
            assert_eq!(cache, "private, no-cache", "{method} {viewer:?}");
        }
    }
}

/// `no_store` on a route: the handler keeps its `?`, and its page, its failure and a request its
/// extractors refuse are `private, no-store`, in every mode.
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
            assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-store", "{path} {extra:?}");
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
            assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-store", "{method} {path} {viewer:?} {extra:?}");
        }
    }
}

/// A `Cache-Control` whose `private` or `no-store` is not a plain directive (in a quoted value, a
/// line that is not text, `no-store=1`, with `must-understand`) is not trusted: an answer that sets
/// a cookie or read a caller (here, the error page) goes out `private, no-cache`, or
/// `private, no-store` when any reader could find a `no-store` in its header. A plain `no-store` or `private` is trusted as written only on one line of
/// plain text with no quoted value: otherwise a `no-store` goes out on one line (`no-store` alone
/// beside a quoted value or a byte that is not text), so a cache that reads only one line, or a
/// value another way, is told the same. `must-understand, no-store` on an answer nothing makes
/// personal is left as written, and a `private` beside them is not trusted. Every line is read
/// for a `no-store`, not only the first.
#[tokio::test]
async fn a_cache_control_counts_only_for_what_it_plainly_says() {
    let router = Table::new()
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
                (appended(lines), "second")
            }),
        )
        .route(
            "/second-line-valued",
            get(|| async {
                let lines = [
                    (header::CACHE_CONTROL, "public, max-age=600"),
                    (header::CACHE_CONTROL, "no-store=1"),
                    (header::SET_COOKIE, "seen=1"),
                ];
                (appended(lines), "second")
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
                (appended(lines), "odd")
            }),
        )
        .route(
            "/quoted",
            get(|| async {
                let lines =
                    [(header::CACHE_CONTROL, "public, max-age=600, no-cache=\"a, no-store, b\""), (header::SET_COOKIE, "seen=1")];
                (appended(lines), "quoted")
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
                (appended(lines), "escaped")
            }),
        )
        .route(
            "/private-then-no-store",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "private, max-age=600"), (header::CACHE_CONTROL, "no-store")];
                (appended(lines), "both")
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
                (appended(lines), "later")
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
                (appended(lines), "both")
            }),
        )
        .route(
            "/no-store-and-more",
            get(|| async {
                let line = [(header::CACHE_CONTROL, "public, s-maxage=600, x=\"\\\"\", no-store")];
                (appended(line), "more")
            }),
        )
        .route(
            "/private-and-quoted",
            get(|| async {
                let lines =
                    [(header::CACHE_CONTROL, "public, s-maxage=600, x=\"\\\"\", private"), (header::SET_COOKIE, "seen=1")];
                (appended(lines), "quoted")
            }),
        )
        .route(
            "/must-understand",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "must-understand, no-store"), (header::SET_COOKIE, "seen=1")];
                (appended(lines), "kept by a cache that knows a 200")
            }),
        )
        .route(
            "/must-understand-shared",
            get(|| async {
                let line = [(header::CACHE_CONTROL, "max-age=60, must-understand, no-store")];
                (appended(line), "kept only by a cache that knows a 200")
            }),
        )
        .route(
            "/must-understand-valued",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "no-store, must-understand=1, max-age=600"), (header::SET_COOKIE, "seen=1")];
                (appended(lines), "valued")
            }),
        )
        .route(
            "/private-must-understand",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "private, no-store, must-understand"), (header::SET_COOKIE, "seen=1")];
                (appended(lines), "private")
            }),
        )
        .route(
            "/private-valued-must-understand",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "private, no-store=1, must-understand"), (header::SET_COOKIE, "seen=1")];
                (appended(lines), "private")
            }),
        )
        .route(
            "/upper-valued",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "public, max-age=600, No-Store=1"), (header::SET_COOKIE, "seen=1")];
                (appended(lines), "upper")
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
                (appended(lines), "odd")
            }),
        )
        .route(
            "/not-text-private",
            get(|| async {
                let odd = HeaderValue::from_bytes(b"public, s-maxage=600, private, x=\xE9").unwrap();
                let lines = [(header::CACHE_CONTROL, odd), (header::SET_COOKIE, HeaderValue::from_static("seen=1"))];
                (appended(lines), "odd")
            }),
        )
        .route(
            "/unquoted-limited",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "public, max-age=600, private=set-cookie"), (header::SET_COOKIE, "seen=1")];
                (appended(lines), "limited")
            }),
        )
        .route(
            "/no-transform",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "no-transform"), (header::CACHE_CONTROL, "no-store")];
                (appended(lines), "both")
            }),
        )
        .route(
            "/limited-first",
            get(|| async {
                let lines = [(header::CACHE_CONTROL, "private=\"set-cookie\", max-age=600"), (header::SET_COOKIE, "seen=1")];
                (appended(lines), "limited")
            }),
        );
    let router = app(router, Some("ann"));
    for (path, want) in [
        ("/odd-line", "private, no-cache"),
        ("/quoted", "private, no-store"),
        ("/quoted-failure", "private, no-store"),
        ("/valued", "private, no-store"),
        ("/second-line", "public, max-age=600, no-store"),
        ("/second-line-valued", "private, no-store"),
        ("/escaped", "private, no-store"),
        ("/must-understand-shared", "max-age=60, must-understand, no-store"),
        ("/must-understand-valued", "private, no-store"),
        ("/private-must-understand", "private, no-store"),
        ("/private-valued-must-understand", "private, no-store"),
        ("/upper-valued", "private, no-store"),
        ("/private-then-no-store", "private, max-age=600, no-store"),
        ("/must-understand", "private, no-store"),
        ("/must-understand-failure", "private, no-store"),
        ("/not-text-no-store", "private, no-store"),
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
    assert_eq!(
        cache_control(&router, "/", &[("cookie", "corten-zone=America/Chicago"), ("cookie", "session=abc")]).await,
        "private, no-cache"
    );
    let inline = App::new(Routes::from(Table::new().route("/", get(inline_page)))).router();
    assert_eq!(cache_control(&inline, "/", &[]).await, "private, no-cache", "the layout took the nonce");

    let minute = std::time::Duration::from_secs(60);
    let api = App::new(Routes::new())
        .api::<ApiRoot>(|api| {
            api.route::<ApiRates>(crate::Methods::reads(get(move || async move { (Cache::public(minute), "rates") })))
        })
        .router();
    assert_eq!(cache_control(&api, "/api/rates", &[("accept", "application/json")]).await, "public, max-age=60");
    assert_eq!(cache_control(&api, "/api/rates", &[("authorization", "Bearer t")]).await, "private, no-cache");
    assert_eq!(cache_control(&api, "/api/rates", &[("cookie", "session=abc")]).await, "private, no-cache");
}

/// A form's submit key is drawn for each render, so a `Public` page that draws one
/// (`SubmitKey::field`) differs between visitors: a cache that gave the first visitor's page to
/// the next would have the second visitor's submit taken for a repeat of the first. It goes out
/// `private, no-cache` whoever set the header, as a page with the request's nonce does, and the
/// browser asks again before reusing it, so a reload is not sent a key it already used. A page
/// whose only key field is a template's draws nothing and stays shared.
#[tokio::test]
async fn a_public_page_that_draws_a_submit_key_is_not_shared() {
    let minute = std::time::Duration::from_secs(60);
    let form = || html! { <form method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> };
    let routes = Table::new()
        .route("/keyed", get(move |req: Req| async move { Public::new(minute, req.test_page_for("Keyed", form())) }))
        .route(
            "/keyed-rendered",
            get(move |req: Req| async move {
                let form = req.rendered(form());
                let placed = &form;
                Public::new(minute, req.test_page_for("Keyed", html! { {placed} }))
            }),
        )
        .route(
            "/keyed-by-hand",
            get(move |req: Req| async move {
                Ok::<_, Error>((Cache::public(minute).shared(minute * 60), req.test_page("Keyed", form())?))
            }),
        )
        .route(
            "/template-keyed",
            get(move |req: Req| async move {
                let template = html! {
                    <template><form method="post">{crate::SubmitKey::template_field(KeyedWrite::FIELDS.submit)}</form></template>
                };
                Public::new(minute, req.test_page_for("Keyed", template))
            }),
        );
    let router = App::new(Routes::from(routes)).router();
    for uri in ["/keyed", "/keyed-rendered", "/keyed-by-hand"] {
        for asked in [&[][..], &[("corten", "nav")], &[("accept", "application/json")]] {
            assert_eq!(cache_control(&router, uri, asked).await, "private, no-cache", "{uri} {asked:?}");
        }
    }
    assert_eq!(cache_control(&router, "/template-keyed", &[]).await, "public, max-age=60", "a template's key draws nothing");
}

/// The caching headers a CDN or proxy reads before `Cache-Control`, as Corten names them. A name a
/// deployment configures for itself (RFC 9213 allows one) is the deployment's to keep off.
const CDN_OVERRIDES: [&str; 6] = [
    "cdn-cache-control",
    "cloudflare-cdn-cache-control",
    "vercel-cdn-cache-control",
    "surrogate-control",
    "edge-control",
    "x-accel-expires",
];

/// Headers a CDN reads that do not say how long to keep the answer.
const CDN_OTHERS: [&str; 3] = ["cache-status", "surrogate-key", "cache-tag"];

/// A CDN reads its own caching header before `Cache-Control`, so a page that draws a submit key
/// goes out with none of those Corten names, whoever wrote one (here staged middleware), and also
/// when its `Cache-Control` already keeps it private or out of every cache; a private lifetime
/// its handler gave it goes too, so the browser asks again. Other headers a CDN reads stay, and a
/// page with no key keeps what the middleware wrote.
#[tokio::test]
async fn a_page_that_draws_a_submit_key_keeps_no_cdn_caching_header() {
    assert_eq!(crate::cache::CDN_CACHING, CDN_OVERRIDES, "the list the guide names");
    struct CdnHeaders;

    impl crate::Middleware for CdnHeaders {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let mut res = next.run(req).await;
            let headers = res.headers_mut();
            for name in CDN_OVERRIDES {
                headers.insert(name, HeaderValue::from_static("max-age=60"));
            }
            for name in CDN_OTHERS {
                headers.insert(name, HeaderValue::from_static("x"));
            }
            res
        }
    }

    let minute = std::time::Duration::from_secs(60);
    let form = || html! { <form method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> };
    let routes = Table::new()
        .route("/keyed", get(move |req: Req| async move { Public::new(minute, req.test_page_for("Keyed", form())) }))
        .route("/keyed-default", get(move |req: Req| async move { req.test_page("Keyed", form()) }))
        .route(
            "/keyed-private",
            get(move |req: Req| async move {
                Ok::<_, Error>(([(header::CACHE_CONTROL, "private, max-age=60")], req.test_page("Keyed", form())?))
            }),
        )
        .route("/keyed-no-store", get(move |req: Req| async move { NoStore(req.test_page("Keyed", form())) }))
        .route(
            "/plain",
            get(move |req: Req| async move { Public::new(minute, req.test_page_for("Plain", html! { <p>"plain"</p> })) }),
        );
    let router = App::new(Routes::from(routes)).middleware(CdnHeaders).router();
    let get = |uri: &'static str| {
        let router = router.clone();
        async move { router.oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap().headers().clone() }
    };
    for (uri, cache) in [
        ("/keyed", "private, no-cache"),
        ("/keyed-default", "private, no-cache"),
        ("/keyed-private", "private, no-cache"),
        ("/keyed-no-store", "private, no-store"),
    ] {
        let headers = get(uri).await;
        assert_eq!(headers[header::CACHE_CONTROL], cache, "{uri}");
        for cdn in CDN_OVERRIDES {
            assert!(!headers.contains_key(cdn), "{uri}: {headers:?}");
        }
        for other in CDN_OTHERS {
            assert_eq!(headers[other], "x", "{uri}: {other}");
        }
    }
    let headers = get("/plain").await;
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60");
    for name in CDN_OVERRIDES {
        assert_eq!(headers[name], "max-age=60", "a page with no key keeps the middleware's {name}");
    }
    for other in CDN_OTHERS {
        assert_eq!(headers[other], "x", "{other}");
    }
}

/// A `Public` answer whose handler drew a form's new submit key is the browser's alone however
/// the handler rendered it: to a string in JSON or text, through `req.rendered` with a wait
/// after, or as markup placed in a page with `raw`, where the page's own render draws none. Each
/// goes out `private, no-cache` without the CDN caching headers a middleware wrote, as a page
/// whose render drew the key does, whatever the app's store does (the default, none kept, under
/// `corten dev`), so no shared cache gives one visitor's key to the next. A `Public` answer with
/// no key keeps its lifetime and the middleware's headers.
#[tokio::test]
async fn a_public_answer_whose_handler_drew_a_submit_key_is_the_browser_s_alone_however_rendered() {
    use crate::route::get as typed;
    struct CdnHeaders;

    impl crate::Middleware for CdnHeaders {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let mut res = next.run(req).await;
            for name in CDN_OVERRIDES {
                res.headers_mut().insert(name, HeaderValue::from_static("max-age=60"));
            }
            res
        }
    }

    let minute = Duration::from_secs(60);
    let field = || crate::SubmitKey::field(KeyedWrite::FIELDS.submit);
    // Each body of a size the app keeps, so the key is what keeps it out of the store too.
    let filler = || "keyed ".repeat(200);
    let routes = || {
        let routes = Table::new()
            .route("/text", typed(move || async move { Public::new(minute, format!("{}{}", field().to_html(), filler())) }).0)
            .route(
                "/placed",
                typed(move |req: Req| async move {
                    let form = html! { <form method="post">{field()}</form> }.to_html();
                    let main = html! {
                        <div>
                            {crate::view::raw(form)}
                            <p>{filler()}</p>
                        </div>
                    };
                    Public::new(minute, req.test_page_for("Placed", main))
                })
                .0,
            )
            // A file and a relay whose bytes the handler made before it returned.
            .route(
                "/media",
                typed(move || async move {
                    Public::new(minute, crate::Media::new("text/html", format!("{}{}", field().to_html(), filler())))
                })
                .0,
            )
            .route(
                "/relay",
                typed(move || async move {
                    let body = Body::from(format!("{}{}", field().to_html(), filler()));
                    Public::new(minute, crate::Relay::new(StatusCode::OK, HeaderMap::new(), body))
                })
                .0,
            )
            .route("/plain-text", typed(move || async move { Public::new(minute, filler()) }).0)
            .route(
                "/plain-page",
                typed(
                    move |req: Req| async move { Public::new(minute, req.test_page_for("Plain", html! { <p>{filler()}</p> })) },
                )
                .0,
            );
        #[cfg(feature = "json")]
        let routes = routes
            .route(
                "/json",
                typed(move || async move { Public::new(minute, Ok::<_, JsonError>(Json((field().to_html(), filler())))) }).0,
            )
            .route(
                "/waited",
                typed(move |req: Req| async move {
                    let field = req.rendered(field()).into_string();
                    tokio::task::yield_now().await;
                    Public::new(minute, Ok::<_, JsonError>(Json((field, filler()))))
                })
                .0,
            )
            .route("/plain-json", typed(move || async move { Public::new(minute, Ok::<_, JsonError>(Json(filler()))) }).0);
        Routes::from(routes)
    };
    let (keyed, plain): (&[&str], &[&str]) = if cfg!(feature = "json") {
        (&["/text", "/placed", "/media", "/relay", "/json", "/waited"], &["/plain-text", "/plain-page", "/plain-json"])
    } else {
        (&["/text", "/placed", "/media", "/relay"], &["/plain-text", "/plain-page"])
    };
    let apps = [
        ("the default store", App::new(routes()).middleware(CdnHeaders).router()),
        ("none kept", App::new(routes()).kept_answers(0).middleware(CdnHeaders).router()),
        ("corten dev", App::new(routes()).dev(true).middleware(CdnHeaders).router()),
    ];
    for (app, router) in &apps {
        for path in keyed {
            let (status, headers, body) = fetch(router, "GET", path, &[]).await;
            let (_, again, other) = fetch(router, "GET", path, &[]).await;
            assert_eq!(status, StatusCode::OK, "{app}: {path}");
            for headers in [&headers, &again] {
                assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache", "{app}: {path}: {headers:?}");
                for cdn in CDN_OVERRIDES {
                    assert!(!headers.contains_key(cdn), "{app}: {path}: {headers:?}");
                }
            }
            assert!(
                String::from_utf8_lossy(&body).contains("data-submit value=") && body != other,
                "{app}: {path}: a key for each"
            );
        }
        for path in plain {
            for _ in 0..2 {
                let (status, headers, _) = fetch(router, "GET", path, &[]).await;
                assert_eq!(status, StatusCode::OK, "{app}: {path}");
                assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60", "{app}: {path}");
                for cdn in CDN_OVERRIDES {
                    assert_eq!(headers[cdn], "max-age=60", "{app}: {path}: the middleware's {cdn}");
                }
            }
        }
    }
}

/// A `Public` JSON answer whose handler rendered a form's new submit key with `req.rendered` on
/// another thread (a blocking task) marks only the request's signal: the watch around the handler
/// polls nothing that drew it. The app's store reads that mark before it keeps the answer, so the
/// first answer is not kept to be given to the next visitor: both go out `private, no-cache`, as
/// the handler made them (no `Age`), each with its own key. Under `corten dev` the log says so
/// from the same mark (`Verdict::DrewKey`), not that a release build would keep it.
#[cfg(feature = "json")]
#[tokio::test]
async fn a_public_answer_with_a_key_rendered_on_another_thread_is_not_kept() {
    use crate::route::get as typed;

    let minute = Duration::from_secs(60);
    let field = || crate::SubmitKey::field(KeyedWrite::FIELDS.submit);
    // Of a size the app keeps, so the key is what keeps it out of the store.
    let filler = || "keyed ".repeat(200);
    let routes = || {
        Routes::from(
            Table::new().route(
                "/blocking",
                typed(move |req: Req| async move {
                    let field = tokio::task::spawn_blocking(move || req.rendered(field()).into_string()).await.unwrap();
                    Public::new(minute, Ok::<_, JsonError>(Json((field, filler()))))
                })
                .0,
            ),
        )
    };
    let router = App::new(routes()).router();
    let (status, first, body) = fetch(&router, "GET", "/blocking", &[]).await;
    let (_, again, other) = fetch(&router, "GET", "/blocking", &[]).await;
    assert_eq!(status, StatusCode::OK);
    for headers in [&first, &again] {
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache", "{headers:?}");
        assert!(!headers.contains_key(header::AGE), "a kept answer: {headers:?}");
    }
    assert!(String::from_utf8_lossy(&body).contains("data-submit value=") && body != other, "a key for each");

    // Under `corten dev`, which keeps nothing, the verdict is what tells: the answer's head alone
    // is the same whether or not dev reads the signal.
    #[cfg(feature = "log")]
    {
        let lines = Lines(std::sync::Arc::default());
        let _logging = log_to(&lines);
        let dev = App::new(routes()).dev(true).router();
        let (status, headers, _) = fetch(&dev, "GET", "/blocking", &[]).await;
        let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache", "{headers:?}");
        assert!(
            text.contains("WARN")
                && text.contains(
                    "corten: /blocking is Public, but a release build does not keep its answer: it draws a form's new submit key"
                ),
            "{text}"
        );
        assert!(!text.contains("a release build would keep its answer"), "{text}");
    }
}

/// An answer type of the app's own that is `Public` on one branch and the visitor's on the other,
/// as an app may write one (`Answer` and `IntoResponse` are open), says nothing of which it is, so
/// its handler is watched as a `Public` one's is: a branch that drew a form's new submit key goes
/// out `private, no-cache` without the CDN caching headers a middleware wrote, whichever branch it
/// was, and a `Public` branch with no key keeps its lifetime and those headers.
#[tokio::test]
async fn an_answer_of_the_app_s_own_that_holds_a_public_one_is_watched_for_a_submit_key() {
    use crate::answer::{AnyInputs, Format, NotAFeed};
    use crate::route::get as typed;

    enum Mixed {
        Mine(String),
        Shared(Public<String>),
    }

    impl crate::response::IntoResponse for Mixed {
        fn into_response(self) -> crate::response::Response {
            match self {
                Mixed::Mine(mine) => mine.into_response(),
                Mixed::Shared(shared) => shared.into_response(),
            }
        }
    }

    impl crate::Answer for Mixed {
        const FORMAT: Format = Format::Html;
        type Inputs = AnyInputs;
        type Rows = NotAFeed;
        type Kind = AnyAnswer;
    }

    struct CdnHeaders;

    impl crate::Middleware for CdnHeaders {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let mut res = next.run(req).await;
            for name in CDN_OVERRIDES {
                res.headers_mut().insert(name, HeaderValue::from_static("max-age=60"));
            }
            res
        }
    }

    let minute = Duration::from_secs(60);
    let field = || crate::SubmitKey::field(KeyedWrite::FIELDS.submit).to_html();
    let routes = || {
        Routes::from(
            Table::new()
                .route("/shared-keyed", typed(move || async move { Mixed::Shared(Public::new(minute, field())) }).0)
                .route("/mine-keyed", typed(move || async move { Mixed::Mine(field()) }).0)
                .route("/shared-plain", typed(move || async move { Mixed::Shared(Public::new(minute, "plain".to_string())) }).0),
        )
    };
    for (app, router) in [
        ("the default store", App::new(routes()).middleware(CdnHeaders).router()),
        ("corten dev", App::new(routes()).dev(true).middleware(CdnHeaders).router()),
    ] {
        for path in ["/shared-keyed", "/mine-keyed"] {
            let (status, headers, body) = fetch(&router, "GET", path, &[]).await;
            let (_, _, other) = fetch(&router, "GET", path, &[]).await;
            assert_eq!(status, StatusCode::OK, "{app}: {path}");
            assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache", "{app}: {path}: {headers:?}");
            for cdn in CDN_OVERRIDES {
                assert!(!headers.contains_key(cdn), "{app}: {path}: {headers:?}");
            }
            assert!(String::from_utf8_lossy(&body).contains("data-submit value=") && body != other, "{app}: {path}");
        }
        let (status, headers, _) = fetch(&router, "GET", "/shared-plain", &[]).await;
        assert_eq!(status, StatusCode::OK, "{app}");
        assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60", "{app}");
        for cdn in CDN_OVERRIDES {
            assert_eq!(headers[cdn], "max-age=60", "{app}: the middleware's {cdn}");
        }
    }
}

/// An answer erased behind a box, as a trait of the app's own over `IntoResponse` (whose being
/// one a `dyn IntoResponse` needs too), is an answer type of the app's own: its handler is
/// watched, so a box that holds a `Public` answer whose handler drew a form's new submit key goes
/// out `private, no-cache`, and one that drew none keeps its lifetime.
#[tokio::test]
async fn a_boxed_answer_of_the_app_s_own_is_watched_for_a_submit_key() {
    use crate::answer::{AnyInputs, Format, NotAFeed};
    use crate::response::IntoResponse;
    use crate::route::get as typed;

    trait Boxed: IntoResponse + Send {
        fn respond(self: Box<Self>) -> crate::response::Response;
    }

    impl<T: IntoResponse + Send> Boxed for T {
        fn respond(self: Box<Self>) -> crate::response::Response {
            (*self).into_response()
        }
    }

    impl IntoResponse for Box<dyn Boxed> {
        fn into_response(self) -> crate::response::Response {
            self.respond()
        }
    }

    impl crate::Answer for Box<dyn Boxed> {
        const FORMAT: Format = Format::Html;
        type Inputs = AnyInputs;
        type Rows = NotAFeed;
        type Kind = AnyAnswer;
    }

    // `dyn IntoResponse` is a type, as it was before the watch.
    let erased: Box<dyn IntoResponse + Send> = Box::new("erased");
    drop(erased);
    assert!(<Box<dyn Boxed> as IntoResponse>::may_share().0, "a box of the app's own may be `Public`");

    let minute = Duration::from_secs(60);
    let field = || crate::SubmitKey::field(KeyedWrite::FIELDS.submit).to_html();
    let boxed = |answer: Public<String>| -> Box<dyn Boxed> { Box::new(answer) };
    let routes = || {
        Routes::from(
            Table::new()
                .route("/keyed", typed(move || async move { boxed(Public::new(minute, field())) }).0)
                .route("/plain", typed(move || async move { boxed(Public::new(minute, "plain".to_string())) }).0),
        )
    };
    for (app, router) in [
        ("the default store", App::new(routes()).router()),
        ("none kept", App::new(routes()).kept_answers(0).router()),
        ("corten dev", App::new(routes()).dev(true).router()),
    ] {
        let (status, headers, body) = fetch(&router, "GET", "/keyed", &[]).await;
        let (_, _, other) = fetch(&router, "GET", "/keyed", &[]).await;
        assert_eq!(status, StatusCode::OK, "{app}");
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache", "{app}: {headers:?}");
        assert!(String::from_utf8_lossy(&body).contains("data-submit value=") && body != other, "{app}");
        let (status, headers, _) = fetch(&router, "GET", "/plain", &[]).await;
        assert_eq!(status, StatusCode::OK, "{app}");
        assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60", "{app}");
    }
}

/// A `Public` answer converted to a response and put in the place of a page's or a JSON
/// answer's through its `DerefMut` (`*answer = Public::new(..).into_response()`), in an
/// `App::api` route, a page route and a page route's file slot (`PageOr`), and in a JSON
/// refusal of the app's own that holds one (`JsonError::Own`): those answer types say nothing of
/// what their handler put in them, so the handler is watched as a `Public` one's is. One whose
/// handler rendered a form's new submit key to a string goes out `private, no-cache` without the
/// CDN caching headers a middleware wrote, whatever the app keeps; one with no key keeps its
/// lifetime and those headers.
#[tokio::test]
async fn a_public_answer_put_in_another_answer_s_place_is_watched_for_a_submit_key() {
    use crate::response::IntoResponse;
    use crate::route::get as typed;

    struct CdnHeaders;

    impl crate::Middleware for CdnHeaders {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let mut res = next.run(req).await;
            for name in CDN_OVERRIDES {
                res.headers_mut().insert(name, HeaderValue::from_static("max-age=60"));
            }
            res
        }
    }

    fn shared(keyed: bool) -> crate::response::Response {
        let key = if keyed { crate::SubmitKey::field(KeyedWrite::FIELDS.submit).to_html() } else { String::new() };
        Public::new(Duration::from_secs(60), format!("{key}{}", "kept ".repeat(200))).into_response()
    }
    async fn replaced_page(req: Req, keyed: bool) -> HtmlResult {
        let mut page = req.test_page("Replaced", html! { <p>"mine"</p> })?;
        *page = shared(keyed);
        Ok(page)
    }
    async fn replaced_file(req: Req) -> crate::Result<crate::PageOr<crate::Media>> {
        let mut page = req.test_page("Replaced", html! { <p>"mine"</p> })?;
        *page = shared(true);
        Ok(crate::PageOr::Page(page))
    }

    let routes = || {
        let routes = Table::new()
            .route("/keyed-page", typed(|req: Req| replaced_page(req, true)).0)
            .route("/keyed-file", typed(replaced_file).0)
            .route("/plain-page", typed(|req: Req| replaced_page(req, false)).0);
        Routes::from(routes)
    };
    #[cfg(feature = "json")]
    let app = |app: App| app.api(replaced_api::api);
    #[cfg(not(feature = "json"))]
    let app = |app: App| app;
    let (keyed, plain): (&[&str], &[&str]) = if cfg!(feature = "json") {
        (&["/keyed-page", "/keyed-file", "/v2/keyed", "/v2/refused"], &["/plain-page", "/v2/plain"])
    } else {
        (&["/keyed-page", "/keyed-file"], &["/plain-page"])
    };
    let mut wrong = Vec::new();
    for (label, router) in [
        ("the default store", app(App::new(routes())).middleware(CdnHeaders).router()),
        ("none kept", app(App::new(routes())).kept_answers(0).middleware(CdnHeaders).router()),
        ("corten dev", app(App::new(routes())).dev(true).middleware(CdnHeaders).router()),
    ] {
        for path in keyed {
            let (status, headers, body) = fetch(&router, "GET", path, &[]).await;
            let (_, again, other) = fetch(&router, "GET", path, &[]).await;
            let expected = if *path == "/v2/refused" { StatusCode::CONFLICT } else { StatusCode::OK };
            assert_eq!(status, expected, "{label}: {path}");
            assert!(String::from_utf8_lossy(&body).contains("data-submit value=") && body != other, "{label}: {path}");
            for headers in [&headers, &again] {
                let cdn = CDN_OVERRIDES.iter().filter(|cdn| headers.contains_key(**cdn)).count();
                if headers[header::CACHE_CONTROL] != "private, no-cache" || cdn > 0 {
                    wrong.push(format!("{label}: {path}: {:?} with {cdn} CDN headers", headers[header::CACHE_CONTROL]));
                }
            }
        }
        for path in plain {
            for _ in 0..2 {
                let (status, headers, _) = fetch(&router, "GET", path, &[]).await;
                assert_eq!(status, StatusCode::OK, "{label}: {path}");
                assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60", "{label}: {path}");
                for cdn in CDN_OVERRIDES {
                    assert_eq!(headers[cdn], "max-age=60", "{label}: {path}: the middleware's {cdn}");
                }
            }
        }
    }
    assert!(wrong.is_empty(), "sent where a shared cache keeps it:\n{}", wrong.join("\n"));
}

/// An API whose handlers put a `Public` answer in the place of their own
/// (`a_public_answer_put_in_another_answer_s_place_is_watched_for_a_submit_key`).
#[cfg(feature = "json")]
#[crate::routes(api = ReplacedRoot)]
mod replaced_api {
    #[route("/v2")]
    pub struct ReplacedRoot;

    #[route("/v2/keyed", get = replaced_keyed)]
    pub struct Keyed;

    #[route("/v2/refused", get = replaced_refused)]
    pub struct Refused;

    #[route("/v2/plain", get = replaced_plain)]
    pub struct Plain;
}

/// A JSON answer whose response is a `Public` one the handler converted, with a form's new submit
/// key rendered into it when `keyed`.
#[cfg(feature = "json")]
fn replaced_json(keyed: bool) -> crate::JsonResponse {
    use crate::response::IntoResponse;
    let key = if keyed { crate::SubmitKey::field(KeyedWrite::FIELDS.submit).to_html() } else { String::new() };
    let mut answer: crate::JsonResponse = Json(0u32).into();
    *answer = Public::new(Duration::from_secs(60), Ok::<_, JsonError>(Json((key, "kept ".repeat(200))))).into_response();
    answer
}

#[cfg(feature = "json")]
async fn replaced_keyed() -> Result<crate::JsonResponse, JsonError> {
    Ok(replaced_json(true))
}

/// A refusal that holds such a response, `409`, on a route whose success (`Json<T>`) is never
/// `Public`: only the refusal's `JsonError` says its handler is watched.
#[cfg(feature = "json")]
async fn replaced_refused() -> crate::JsonResult<u32> {
    let mut refusal = replaced_json(true);
    *refusal.status_mut() = StatusCode::CONFLICT;
    Err(JsonError::from(refusal))
}

#[cfg(feature = "json")]
async fn replaced_plain() -> Result<crate::JsonResponse, JsonError> {
    Ok(replaced_json(false))
}

/// An answer that drew a form's new submit key is asked about again before the browser shows it,
/// whatever lifetime a middleware gave it: a `private, max-age=60` goes out `private, no-cache`
/// (a `private, no-store` stays), without the CDN caching headers the middleware wrote. So does
/// one whose key a render made with `req.rendered` drew, placed in an answer no watch is around
/// (text, `Json<T>`): that render marks the request's answer as a page's render does. An answer
/// with no key keeps the middleware's lifetime and headers.
#[tokio::test]
async fn an_answer_that_drew_a_submit_key_is_asked_about_again_whatever_lifetime_a_middleware_gave_it() {
    use crate::route::get as typed;
    struct Lifetime(&'static str);

    impl crate::Middleware for Lifetime {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let mut res = next.run(req).await;
            res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(self.0));
            for name in CDN_OVERRIDES {
                res.headers_mut().insert(name, HeaderValue::from_static("max-age=60"));
            }
            res
        }
    }

    let field = || crate::SubmitKey::field(KeyedWrite::FIELDS.submit);
    let routes = || {
        let routes = Table::new()
            .route(
                "/page",
                typed(move |req: Req| async move { req.test_page("Keyed", html! { <form method="post">{field()}</form> }) }).0,
            )
            .route("/text", typed(move |req: Req| async move { req.rendered(field()).into_string() }).0)
            .route("/plain", typed(|req: Req| async move { req.test_page("Plain", html! { <p>"plain"</p> }) }).0);
        #[cfg(feature = "json")]
        let routes = routes.route("/json", typed(move |req: Req| async move { Json(req.rendered(field()).into_string()) }).0);
        Routes::from(routes)
    };
    let keyed: &[&str] = if cfg!(feature = "json") { &["/page", "/text", "/json"] } else { &["/page", "/text"] };
    let mut wrong = Vec::new();
    for (written, keyed_goes_out) in [("private, max-age=60", "private, no-cache"), ("private, no-store", "private, no-store")] {
        for (label, router) in [
            ("the default store", App::new(routes()).middleware(Lifetime(written)).router()),
            ("corten dev", App::new(routes()).dev(true).middleware(Lifetime(written)).router()),
        ] {
            for path in keyed {
                let (status, headers, body) = fetch(&router, "GET", path, &[]).await;
                assert_eq!(status, StatusCode::OK, "{label}: {path}");
                assert!(String::from_utf8_lossy(&body).contains("data-submit value="), "{label}: {path}");
                let cdn = CDN_OVERRIDES.iter().filter(|cdn| headers.contains_key(**cdn)).count();
                if headers[header::CACHE_CONTROL] != keyed_goes_out || cdn > 0 || headers.contains_key(header::ETAG) {
                    wrong.push(format!(
                        "{label}: {path} given {written:?}: {:?} with {cdn} CDN headers and tag {:?}",
                        headers[header::CACHE_CONTROL],
                        headers.get(header::ETAG)
                    ));
                }
            }
            let (status, headers, _) = fetch(&router, "GET", "/plain", &[]).await;
            assert_eq!(status, StatusCode::OK, "{label}");
            assert_eq!(headers[header::CACHE_CONTROL], written, "{label}: the middleware's own lifetime");
            for cdn in CDN_OVERRIDES {
                assert_eq!(headers[cdn], "max-age=60", "{label}: the middleware's {cdn}");
            }
        }
    }
    assert!(wrong.is_empty(), "reusable without asking:\n{}", wrong.join("\n"));
}

/// A middleware may rebuild both sides: give `next` a request made from the method, URI, version,
/// headers and body of the one it was given, with none of its extensions or with a signal of its
/// own ([`Rebuilds`]), and make a new response of the answer it gets back, without its extensions
/// either. The route then marks no signal the stages read, and the answer's own mark is gone, but
/// the stages hold their signal past the middleware, and the end of the chain carries the mark of
/// the signal the route's request had (the middleware's, or one made for it) as the answer comes
/// back: an answer whose handler or page drew a form's new submit key, or that holds one a
/// `req.rendered` render drew (text and `Json<T>`, which no watch is around), still goes out the
/// browser's alone, without the CDN caching headers the middleware wrote and without a tag,
/// whatever the app keeps. One with no key keeps its lifetime, those headers and its tag.
#[tokio::test]
async fn an_answer_a_middleware_rebuilt_from_a_rebuilt_request_keeps_its_submit_key_from_shared_caches() {
    let mut wrong = Vec::new();
    for how in [Rebuilds::Fresh, Rebuilds::Replaced] {
        wrong.extend(rebuilt_keyed_answers_open_to_a_cdn(&format!("{how:?}"), || (RebuiltAnswer, how)).await);
    }
    assert!(wrong.is_empty(), "a keyed answer behind a rebuilt request and response, open to a CDN: {wrong:#?}");
}

/// As [`an_answer_a_middleware_rebuilt_from_a_rebuilt_request_keeps_its_submit_key_from_shared_caches`],
/// with the rest of the chain run on a scoped thread of the middleware's own ([`OnAThread`]):
/// `next` called there, or called on the request's thread and its future only polled there. The
/// route's answer comes back on that thread and still marks the stages' signal, which they hold
/// past the middleware.
#[tokio::test]
async fn an_answer_a_middleware_rebuilt_on_a_thread_of_its_own_keeps_its_submit_key_from_shared_caches() {
    let mut wrong = Vec::new();
    for hop in [Hop::Called, Hop::Polled] {
        for how in [Rebuilds::Fresh, Rebuilds::Replaced] {
            let label = format!("{hop:?} {how:?}");
            wrong.extend(rebuilt_keyed_answers_open_to_a_cdn(&label, || (RebuiltAnswer, how, OnAThread(hop))).await);
        }
    }
    assert!(wrong.is_empty(), "a keyed answer that came back on a middleware's own thread, open to a CDN: {wrong:#?}");
}

/// A middleware that holds a keyed answer from `next`, then answers a request of its own in
/// process (with stages of its own) whose handler panics, then waits a turn and makes a new
/// response of the keyed answer, without its extensions: that answer still goes out the browser's
/// alone. The nested request's panic and the turn take no mark away, nor leave one behind: a
/// `Public` answer with no key, answered next on the same thread through the same middleware, keeps
/// its lifetime.
#[tokio::test]
async fn a_keyed_answer_held_across_a_nested_request_that_panics_and_a_wait_stays_private() {
    use crate::route::get as typed;

    /// Answers `/panics` from the same router, waits a turn, then rebuilds the answer `next` gave.
    struct Nests(Arc<std::sync::OnceLock<Router>>);

    impl crate::Middleware for Nests {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            if req.uri().path() == "/panics" {
                return next.run(req).await;
            }
            let answer = next.run(req).await;
            let router = self.0.get().expect("the router").clone();
            let nested = router.oneshot(Request::builder().uri("/panics").body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(nested.status(), StatusCode::INTERNAL_SERVER_ERROR, "the nested request's handler panicked");
            tokio::task::yield_now().await;
            let (parts, body) = answer.into_parts();
            let mut res = crate::response::Response::new(body);
            *res.status_mut() = parts.status;
            *res.headers_mut() = parts.headers;
            res
        }
    }

    let minute = Duration::from_secs(60);
    let field = || crate::SubmitKey::field(KeyedWrite::FIELDS.submit).to_html();
    let routes = || {
        Routes::from(
            Table::new()
                .route("/keyed", typed(move || async move { Public::new(minute, field()) }).0)
                .route("/plain", typed(move || async move { Public::new(minute, "plain".to_string()) }).0)
                .route(
                    "/panics",
                    typed(move || async move {
                        if minute > Duration::ZERO {
                            panic!("the nested request's handler");
                        }
                        Public::new(minute, "never".to_string())
                    })
                    .0,
                ),
        )
    };
    for (app, kept) in [("the default store", None), ("none kept", Some(0))] {
        let slot = Arc::new(std::sync::OnceLock::new());
        let mut built = App::new(routes()).middleware(Nests(slot.clone()));
        if let Some(kept) = kept {
            built = built.kept_answers(kept);
        }
        let router = built.router();
        assert!(slot.set(router.clone()).is_ok());
        let (status, headers, body) = fetch(&router, "GET", "/keyed", &[]).await;
        assert_eq!(status, StatusCode::OK, "{app}");
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache", "{app}: {headers:?}");
        assert!(String::from_utf8_lossy(&body).contains("data-submit value="), "{app}");
        let (status, headers, _) = fetch(&router, "GET", "/plain", &[]).await;
        assert_eq!(status, StatusCode::OK, "{app}");
        assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60", "{app}: {headers:?}");
    }
}

/// Staged middleware that makes a new response of the one `next` gave, with its status, headers
/// and body and none of its extensions, and writes every caching header a CDN reads first on it.
struct RebuiltAnswer;

impl crate::Middleware for RebuiltAnswer {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let (parts, body) = next.run(req).await.into_parts();
        let mut res = crate::response::Response::new(body);
        *res.status_mut() = parts.status;
        *res.headers_mut() = parts.headers;
        for name in CDN_OVERRIDES {
            res.headers_mut().insert(name, HeaderValue::from_static("max-age=60"));
        }
        res
    }
}

/// Where [`OnAThread`] makes the rest of the chain's future: on the request's thread, polled on
/// its own (`Polled`), or on its own thread too (`Called`).
#[derive(Clone, Copy, Debug)]
enum Hop {
    Called,
    Polled,
}

/// Staged middleware that runs the rest of the chain on a scoped thread of its own and waits for
/// it there: a `Next` and the future it gives are `Send`, and need not be `'static` for a scoped
/// thread.
struct OnAThread(Hop);

impl crate::Middleware for OnAThread {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let runtime = tokio::runtime::Handle::current();
        let thread = std::thread::current().id();
        let (res, ran) = match self.0 {
            Hop::Called => std::thread::scope(|scope| {
                scope.spawn(|| (runtime.block_on(next.run(req)), std::thread::current().id())).join().unwrap()
            }),
            Hop::Polled => {
                let answer = next.run(req);
                std::thread::scope(|scope| {
                    scope.spawn(|| (runtime.block_on(answer), std::thread::current().id())).join().unwrap()
                })
            }
        };
        assert_ne!(ran, thread, "the route's answer came back on the middleware's thread");
        res
    }
}

/// The keyed answers `steps()`'s middleware sends open to a CDN (`private, no-cache` is the only
/// right `Cache-Control`; no CDN caching header the middleware wrote, no tag), for `/text`, a
/// `Public` text whose handler drew a form's new submit key, `/page`, a `Public` page with such
/// a form, and `/rendered-text` and `/rendered-json`, text and `Json<T>`, which no watch is
/// around, with a key made with `req.rendered`, which marks the signal of the request the route
/// was given, with the default store and with none kept. `/plain`, with no key, must keep its
/// lifetime, those headers and its tag.
async fn rebuilt_keyed_answers_open_to_a_cdn<M: crate::Middleware>(label: &str, steps: impl Fn() -> M) -> Vec<String> {
    use crate::route::get as typed;

    let minute = Duration::from_secs(60);
    let field = || crate::SubmitKey::field(KeyedWrite::FIELDS.submit);
    let filler = || "keyed ".repeat(200);
    let routes = || {
        let routes = Table::new()
            .route("/text", typed(move || async move { Public::new(minute, format!("{}{}", field().to_html(), filler())) }).0)
            .route(
                "/page",
                typed(move |req: Req| async move {
                    let form = html! {
                        <form method="post">
                            {field()}
                            <p>{filler()}</p>
                        </form>
                    };
                    Public::new(minute, req.test_page_for("Keyed", form))
                })
                .0,
            )
            .route("/plain", typed(move || async move { Public::new(minute, filler()) }).0)
            .route(
                "/rendered-text",
                typed(move |req: Req| async move { format!("{}{}", req.rendered(field()).into_string(), filler()) }).0,
            );
        #[cfg(feature = "json")]
        let routes = routes.route(
            "/rendered-json",
            typed(move |req: Req| async move { Json(format!("{}{}", req.rendered(field()).into_string(), filler())) }).0,
        );
        Routes::from(routes)
    };
    let keyed: &[&str] = if cfg!(feature = "json") {
        &["/text", "/page", "/rendered-text", "/rendered-json"]
    } else {
        &["/text", "/page", "/rendered-text"]
    };
    // A tag is made for a request that names one.
    let asks = [("if-none-match", "\"other\"")];
    let mut wrong = Vec::new();
    for (app, router) in [
        ("the default store", App::new(routes()).middleware(steps()).router()),
        ("none kept", App::new(routes()).kept_answers(0).middleware(steps()).router()),
    ] {
        for path in keyed {
            let (status, headers, body) = fetch(&router, "GET", path, &asks).await;
            let (_, _, other) = fetch(&router, "GET", path, &asks).await;
            assert_eq!(status, StatusCode::OK, "{label} {app}: {path}");
            assert!(String::from_utf8_lossy(&body).contains("data-submit value=") && body != other, "{label} {app}: {path}");
            if headers[header::CACHE_CONTROL] != "private, no-cache" {
                wrong.push(format!("{label} {app}: {path}: Cache-Control {:?}", headers[header::CACHE_CONTROL]));
            }
            let kept: Vec<_> = CDN_OVERRIDES.into_iter().filter(|name| headers.contains_key(*name)).collect();
            if !kept.is_empty() {
                wrong.push(format!("{label} {app}: {path}: still sends {kept:?}"));
            }
            if headers.contains_key(header::ETAG) {
                wrong.push(format!("{label} {app}: {path}: still sends its tag"));
            }
        }
        let (status, headers, _) = fetch(&router, "GET", "/plain", &asks).await;
        assert_eq!(status, StatusCode::OK, "{label} {app}");
        assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60", "{label} {app}");
        assert!(headers.contains_key(header::ETAG), "{label} {app}: {headers:?}");
        for cdn in CDN_OVERRIDES {
            assert_eq!(headers[cdn], "max-age=60", "{label} {app}: the middleware's {cdn}");
        }
    }
    wrong
}

/// `NoStore` is watched as the answer it holds is: around an answer type of the app's own that
/// is `Public` on one branch, a relay that kept the upstream's `Surrogate-Control` drew a form's
/// new submit key, and goes out `private, no-store` without that header, which `no-store` does not
/// replace, rather than with the CDN still told to keep it, and without the upstream's tag. With no
/// key it goes out `private, no-store` without that header too, as every `NoStore` answer does, and
/// keeps its tag: only the watch takes the tag away.
#[tokio::test]
async fn a_no_store_answer_that_holds_a_public_one_whose_handler_drew_a_submit_key_keeps_no_cdn_header() {
    use crate::answer::{AnyInputs, Format, NotAFeed};
    use crate::route::get as typed;

    enum Mixed {
        Mine(String),
        Shared(Public<crate::Relay>),
    }

    impl crate::response::IntoResponse for Mixed {
        fn into_response(self) -> crate::response::Response {
            match self {
                Mixed::Mine(mine) => mine.into_response(),
                Mixed::Shared(shared) => shared.into_response(),
            }
        }
    }

    impl crate::Answer for Mixed {
        const FORMAT: Format = Format::Html;
        type Inputs = AnyInputs;
        type Rows = NotAFeed;
        type Kind = AnyAnswer;
    }

    let minute = Duration::from_secs(60);
    let relay = move |body: String| {
        let mut headers = HeaderMap::new();
        headers.insert("surrogate-control", HeaderValue::from_static("max-age=3600"));
        headers.insert(header::ETAG, HeaderValue::from_static("\"upstream\""));
        Public::new(minute, crate::Relay::new(StatusCode::OK, headers, Body::from(body)))
    };
    let field = || crate::SubmitKey::field(KeyedWrite::FIELDS.submit).to_html();
    let routes = || {
        Routes::from(
            Table::new()
                .route("/keyed", typed(move || async move { NoStore(Mixed::Shared(relay(field()))) }).0)
                .route("/plain", typed(move || async move { NoStore(Mixed::Shared(relay("plain".into()))) }).0)
                .route("/mine", typed(move || async move { NoStore(Mixed::Mine("mine".into())) }).0),
        )
    };
    for (app, router) in
        [("the default store", App::new(routes()).router()), ("corten dev", App::new(routes()).dev(true).router())]
    {
        let (status, headers, body) = fetch(&router, "GET", "/keyed", &[]).await;
        assert_eq!(status, StatusCode::OK, "{app}");
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-store", "{app}: {headers:?}");
        for cdn in CDN_OVERRIDES {
            assert!(!headers.contains_key(cdn), "{app}: {headers:?}");
        }
        assert!(!headers.contains_key(header::ETAG), "{app}: {headers:?}");
        assert!(String::from_utf8_lossy(&body).contains("data-submit value="), "{app}");
        for path in ["/plain", "/mine"] {
            let (status, headers, _) = fetch(&router, "GET", path, &[]).await;
            assert_eq!(
                (status, &headers[header::CACHE_CONTROL]),
                (StatusCode::OK, &HeaderValue::from_static("private, no-store")),
                "{app}: {path}"
            );
            for cdn in CDN_OVERRIDES {
                assert!(!headers.contains_key(cdn), "{app}: {path}: {headers:?}");
            }
        }
        let (_, headers, _) = fetch(&router, "GET", "/plain", &[]).await;
        assert_eq!(headers[header::ETAG], "\"upstream\"", "{app}: {headers:?}");
    }
}

/// An answer whose handler drew a form's new submit key goes out without a tag, not only without
/// the one Corten would make: one the app gave it (`Public::header`) or one a relayed upstream
/// sent names a body whose key a browser may already have sent. A `Public` answer without a key
/// keeps the tag it was given.
#[tokio::test]
async fn an_answer_whose_handler_drew_a_submit_key_keeps_no_tag_it_was_given() {
    use crate::route::get as typed;

    struct ETag;
    impl crate::answer::Header for ETag {
        const NAME: &'static str = "etag";
    }

    let minute = Duration::from_secs(60);
    let tagged = || HeaderValue::from_static("\"given\"");
    let relay = move |body: String| {
        let mut headers = HeaderMap::new();
        headers.insert(header::ETAG, tagged());
        Public::new(minute, crate::Relay::new(StatusCode::OK, headers, Body::from(body)))
    };
    let field = || crate::SubmitKey::field(KeyedWrite::FIELDS.submit).to_html();
    let routes = || {
        Routes::from(
            Table::new()
                .route("/text", typed(move || async move { Public::new(minute, field()).header::<ETag>(tagged()) }).0)
                .route("/relay", typed(move || async move { relay(field()) }).0)
                .route(
                    "/plain-text",
                    typed(move || async move { Public::new(minute, "plain".to_string()).header::<ETag>(tagged()) }).0,
                )
                .route("/plain-relay", typed(move || async move { relay("plain".into()) }).0),
        )
    };
    for (app, router) in
        [("the default store", App::new(routes()).router()), ("corten dev", App::new(routes()).dev(true).router())]
    {
        for path in ["/text", "/relay"] {
            // A browser revalidating the copy it was given asks with that copy's tag.
            for asked in [&[][..], &[("if-none-match", "\"given\"")][..]] {
                let (status, headers, body) = fetch(&router, "GET", path, asked).await;
                assert_eq!(status, StatusCode::OK, "{app}: {path}: {asked:?}");
                assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache", "{app}: {path}: {headers:?}");
                assert!(!headers.contains_key(header::ETAG), "{app}: {path}: {headers:?}");
                assert!(String::from_utf8_lossy(&body).contains("data-submit value="), "{app}: {path}");
            }
        }
        for path in ["/plain-text", "/plain-relay"] {
            let (status, headers, _) = fetch(&router, "GET", path, &[]).await;
            assert_eq!(status, StatusCode::OK, "{app}: {path}");
            assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60", "{app}: {path}");
            assert_eq!(headers[header::ETAG], "\"given\"", "{app}: {path}");
        }
    }
}

/// A middleware may make a new response of the one its `next` gave, with that one's status,
/// headers and body and nothing else (its extensions gone). That takes no mark away: an answer
/// whose handler or page drew a form's new submit key is still the browser's alone, without the
/// CDN caching headers the middleware wrote and without a tag, whatever the app keeps; one with no
/// key keeps its lifetime, those headers and its tag.
#[tokio::test]
async fn an_answer_a_middleware_rebuilt_keeps_a_submit_key_its_handler_drew_from_shared_caches() {
    use crate::route::get as typed;

    struct Rebuilt;

    impl crate::Middleware for Rebuilt {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let (parts, body) = next.run(req).await.into_parts();
            let mut res = crate::response::Response::new(body);
            *res.status_mut() = parts.status;
            *res.headers_mut() = parts.headers;
            for name in CDN_OVERRIDES {
                res.headers_mut().insert(name, HeaderValue::from_static("max-age=60"));
            }
            res
        }
    }

    let minute = Duration::from_secs(60);
    let field = || crate::SubmitKey::field(KeyedWrite::FIELDS.submit);
    let filler = || "keyed ".repeat(200);
    let routes = || {
        Routes::from(
            Table::new()
                .route("/text", typed(move || async move { Public::new(minute, format!("{}{}", field().to_html(), filler())) }).0)
                .route(
                    "/page",
                    typed(move |req: Req| async move {
                        let form = html! {
                            <form method="post">
                                {field()}
                                <p>{filler()}</p>
                            </form>
                        };
                        Public::new(minute, req.test_page_for("Keyed", form))
                    })
                    .0,
                )
                .route(
                    "/default-page",
                    typed(move |req: Req| async move { req.test_page("Keyed", html! { <form method="post">{field()}</form> }) })
                        .0,
                )
                .route("/plain", typed(move || async move { Public::new(minute, filler()) }).0),
        )
    };
    // A tag is made for a request that names one.
    let asks = [("if-none-match", "\"other\"")];
    for (app, router) in [
        ("the default store", App::new(routes()).middleware(Rebuilt).router()),
        ("none kept", App::new(routes()).kept_answers(0).middleware(Rebuilt).router()),
    ] {
        for path in ["/text", "/page", "/default-page"] {
            let (status, headers, body) = fetch(&router, "GET", path, &asks).await;
            let (_, _, other) = fetch(&router, "GET", path, &asks).await;
            assert_eq!(status, StatusCode::OK, "{app}: {path}");
            assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache", "{app}: {path}: {headers:?}");
            for cdn in CDN_OVERRIDES {
                assert!(!headers.contains_key(cdn), "{app}: {path}: {headers:?}");
            }
            assert!(!headers.contains_key(header::ETAG), "{app}: {path}: {headers:?}");
            assert!(String::from_utf8_lossy(&body).contains("data-submit value=") && body != other, "{app}: {path}");
        }
        let (status, headers, _) = fetch(&router, "GET", "/plain", &asks).await;
        assert_eq!(status, StatusCode::OK, "{app}");
        assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60", "{app}");
        assert!(headers.contains_key(header::ETAG), "{app}: {headers:?}");
        for cdn in CDN_OVERRIDES {
            assert_eq!(headers[cdn], "max-age=60", "{app}: the middleware's {cdn}");
        }
    }
}

/// Staged middleware that marks every answer for a CDN: each caching header a CDN reads before
/// `Cache-Control` says `public, max-age=60`, and the others a CDN reads say `x`. It reads the
/// caller when the request names one (`viewer`).
struct CdnWrites;

impl crate::Middleware for CdnWrites {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let (parts, body) = req.into_parts();
        if parts.headers.contains_key("viewer") {
            let _ = Caller::<Viewer>::find(&parts, &()).await;
        }
        let mut res = next.run(Request::from_parts(parts, body)).await;
        let headers = res.headers_mut();
        for name in CDN_OVERRIDES {
            headers.insert(name, HeaderValue::from_static("public, max-age=60"));
        }
        for name in CDN_OTHERS {
            headers.insert(name, HeaderValue::from_static("x"));
        }
        res
    }
}

/// `uri`'s answer through `router`, asked with `asked`: its headers, after checking it is a `200`.
async fn answered(router: &Router, uri: &str, asked: &[(&'static str, &'static str)]) -> http::HeaderMap {
    let mut req = Request::get(uri);
    for (name, value) in asked {
        req = req.header(*name, *value);
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK, "{uri} {asked:?}");
    res.headers().clone()
}

/// What is wrong with an answer Corten should have kept from every shared cache: a `Cache-Control`
/// other than `cache`, any caching header a CDN reads first, or a missing header a CDN reads for
/// something else.
pub(super) fn kept_from_cdns(headers: &http::HeaderMap, cache: &str) -> Vec<String> {
    let mut wrong = Vec::new();
    if headers[header::CACHE_CONTROL] != cache {
        wrong.push(format!("Cache-Control {:?}, not {cache:?}", headers[header::CACHE_CONTROL]));
    }
    let kept: Vec<_> = CDN_OVERRIDES.into_iter().filter(|name| headers.contains_key(*name)).collect();
    if !kept.is_empty() {
        wrong.push(format!("still sends {kept:?}"));
    }
    for other in CDN_OTHERS {
        if headers.get(other).is_none_or(|value| value != "x") {
            wrong.push(format!("lost {other}"));
        }
    }
    wrong
}

/// An answer Corten makes private because it is personal (it sets a cookie, carries the request's
/// nonce, or answers a request whose middleware read a caller or that carried credentials) also
/// loses the caching headers a CDN reads before `Cache-Control`, which staged middleware wrote:
/// a CDN that obeys them would otherwise keep one visitor's answer and give it to the next. Other
/// headers a CDN reads stay, and an answer that stays shared keeps what the middleware wrote.
#[tokio::test]
async fn a_personal_answer_made_private_keeps_no_cdn_caching_header() {
    let minute = std::time::Duration::from_secs(60);
    let home = || html! { <p>"home"</p> };
    let routes = Table::new()
        .route("/", get(move |req: Req| async move { Public::new(minute, req.test_page_for("Home", home())) }))
        .route(
            "/cookie",
            get(move |req: Req| async move {
                Ok::<_, Error>((Cache::public(minute), [(header::SET_COOKIE, "seen=1")], req.test_page("Home", home())?))
            }),
        )
        .route("/nonce", get(inline_page));
    let router = App::new(Routes::from(routes)).middleware(CdnWrites).router();
    let get = |uri: &'static str, asked: &'static [(&'static str, &'static str)]| {
        let router = router.clone();
        async move {
            let mut req = Request::get(uri);
            for (name, value) in asked {
                req = req.header(*name, *value);
            }
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(res.status(), StatusCode::OK, "{uri} {asked:?}");
            res.headers().clone()
        }
    };
    let mut left = Vec::new();
    for (uri, asked, why) in [
        ("/cookie", &[][..], "it sets a cookie"),
        ("/nonce", &[], "it carries the nonce"),
        ("/", &[("viewer", "ann")], "a middleware read a caller"),
        ("/", &[("cookie", "session=abc")], "a request with a cookie"),
        ("/", &[("authorization", "Bearer t")], "a request with credentials"),
    ] {
        let headers = get(uri, asked).await;
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache", "{why}");
        let kept: Vec<_> = CDN_OVERRIDES.into_iter().filter(|name| headers.contains_key(*name)).collect();
        if !kept.is_empty() {
            left.push(format!("{why}: {kept:?}"));
        }
        for other in CDN_OTHERS {
            assert_eq!(headers[other], "x", "{why}: {other}");
        }
    }
    assert!(left.is_empty(), "made private, and still sent to a CDN as shared: {left:#?}");
    let headers = get("/", &[]).await;
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60");
    for name in CDN_OVERRIDES {
        assert_eq!(headers[name], "public, max-age=60", "a shared answer keeps the middleware's {name}");
    }
}

/// An answer Corten knows is personal (it sets a cookie, carries the request's nonce, or answers a
/// request whose middleware read a caller), and one `NoStore` keeps out of every cache, loses the
/// caching headers a CDN reads before `Cache-Control` whatever its own `Cache-Control` says: none
/// (the default), a plain `private`, or `no-store`. A CDN that obeys `CDN-Cache-Control` over
/// `Cache-Control` (RFC 9213) would otherwise keep one visitor's answer for the next. The same
/// answers to an anonymous request, with no such mark, keep what the middleware wrote.
#[tokio::test]
async fn a_personal_answer_keeps_no_cdn_caching_header_whatever_its_cache_control() {
    const COOKIE: (header::HeaderName, &str) = (header::SET_COOKIE, "seen=1");
    const PRIVATE: (header::HeaderName, &str) = (header::CACHE_CONTROL, "private, max-age=60");
    let home = || html! { <p>"home"</p> };
    let routes = Table::new()
        .route("/default", get(move |req: Req| async move { req.test_page("Home", home()) }))
        .route("/private", get(move |req: Req| async move { Ok::<_, Error>(([PRIVATE], req.test_page("Home", home())?)) }))
        .route("/no-store", get(move |req: Req| async move { NoStore(req.test_page("Home", home())) }))
        .route("/cookie", get(move |req: Req| async move { Ok::<_, Error>(([COOKIE], req.test_page("Home", home())?)) }))
        .route(
            "/cookie-private",
            get(move |req: Req| async move { Ok::<_, Error>(([COOKIE, PRIVATE], req.test_page("Home", home())?)) }),
        )
        .route(
            "/cookie-no-store",
            get(move |req: Req| async move { NoStore(req.test_page("Home", home()).map(|page| ([COOKIE], page))) }),
        )
        .route("/nonce", get(inline_default_page))
        .route("/nonce-private", get(|req: Req| async move { Ok::<_, Error>(([PRIVATE], inline_default_page(req).await?)) }))
        .route("/nonce-no-store", get(|req: Req| async move { NoStore(inline_default_page(req).await) }));
    let router = App::new(Routes::from(routes)).middleware(CdnWrites).router();
    let viewer: &[(&str, &str)] = &[("viewer", "ann")];
    let mut wrong = Vec::new();
    for (uri, asked, cache, why) in [
        ("/default", viewer, "private, no-cache", "the default, and a caller read"),
        ("/private", viewer, "private, max-age=60", "a plain private, and a caller read"),
        ("/no-store", &[][..], "private, no-store", "NoStore"),
        ("/no-store", viewer, "private, no-store", "NoStore, and a caller read"),
        ("/cookie", &[], "private, no-cache", "the default, and a cookie set"),
        ("/cookie-private", &[], "private, max-age=60", "a plain private, and a cookie set"),
        ("/cookie-no-store", &[], "private, no-store", "NoStore, and a cookie set"),
        ("/nonce", &[], "private, no-cache", "the default, and the nonce"),
        ("/nonce-private", &[], "private, max-age=60", "a plain private, and the nonce"),
        ("/nonce-no-store", &[], "private, no-store", "NoStore, and the nonce"),
    ] {
        let headers = answered(&router, uri, asked).await;
        for what in kept_from_cdns(&headers, cache) {
            wrong.push(format!("{why} ({uri}): {what}"));
        }
    }
    assert!(wrong.is_empty(), "a personal answer, still open to a CDN: {wrong:#?}");
    for (uri, cache) in [("/default", "private, no-cache"), ("/private", "private, max-age=60")] {
        let headers = answered(&router, uri, &[]).await;
        assert_eq!(headers[header::CACHE_CONTROL], cache, "{uri}");
        for name in CDN_OVERRIDES {
            assert_eq!(headers[name], "public, max-age=60", "{uri}: nothing marks it personal, so it keeps {name}");
        }
    }
}

/// A personal answer that says `no-store` without setting a cookie (it carries the request's nonce
/// or read a caller) goes out `private, no-store` with none of the caching headers a CDN reads
/// first, as a page that draws a submit key does: some CDNs keep an answer that says only
/// `no-store`, and none keeps a `private` one. A `must-understand` beside it is no exception. The
/// same header on an anonymous answer is the app's own.
#[tokio::test]
async fn a_personal_no_store_answer_goes_out_private_no_store() {
    const NO_STORE: (header::HeaderName, &str) = (header::CACHE_CONTROL, "no-store");
    const MUST_UNDERSTAND: (header::HeaderName, &str) = (header::CACHE_CONTROL, "must-understand, no-store");
    let home = || html! { <p>"home"</p> };
    let routes = Table::new()
        .route("/no-store", get(move |req: Req| async move { Ok::<_, Error>(([NO_STORE], req.test_page("Home", home())?)) }))
        .route(
            "/must-understand",
            get(move |req: Req| async move { Ok::<_, Error>(([MUST_UNDERSTAND], req.test_page("Home", home())?)) }),
        )
        .route("/nonce-no-store", get(|req: Req| async move { Ok::<_, Error>(([NO_STORE], inline_default_page(req).await?)) }))
        .route(
            "/nonce-must-understand",
            get(|req: Req| async move { Ok::<_, Error>(([MUST_UNDERSTAND], inline_default_page(req).await?)) }),
        );
    let router = App::new(Routes::from(routes)).middleware(CdnWrites).router();
    let viewer: &[(&str, &str)] = &[("viewer", "ann")];
    let mut wrong = Vec::new();
    for (uri, asked) in
        [("/no-store", viewer), ("/must-understand", viewer), ("/nonce-no-store", &[]), ("/nonce-must-understand", &[])]
    {
        let headers = answered(&router, uri, asked).await;
        assert!(!headers.contains_key(header::SET_COOKIE), "{uri}");
        for what in kept_from_cdns(&headers, "private, no-store") {
            wrong.push(format!("{uri} {asked:?}: {what}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
    assert_eq!(answered(&router, "/no-store", &[]).await[header::CACHE_CONTROL], "no-store", "anonymous: as written");
}

/// A `Public` page asked for as anything but its full document (a client navigation, a form
/// answer, a data client's JSON, the runtime's fetch of the page) is the browser's alone, and goes
/// out with none of the caching headers a CDN reads first: a CDN that obeys them would keep the
/// form it was asked for at the page's URL. The full document keeps what the middleware wrote.
#[tokio::test]
async fn a_public_page_in_a_partial_mode_keeps_no_cdn_caching_header() {
    let minute = std::time::Duration::from_secs(60);
    let routes = Table::new()
        .route("/", get(move |req: Req| async move { Public::new(minute, req.test_page_for("Home", html! { <p>"home"</p> })) }));
    let router = App::new(Routes::from(routes)).middleware(CdnWrites).router();
    let mut wrong = Vec::new();
    for asked in [
        &[("corten", "nav")][..],
        &[("corten", "action")],
        &[("accept", "application/json")],
        &[("corten", "page"), ("accept", "text/html")],
    ] {
        let headers = answered(&router, "/", asked).await;
        for what in kept_from_cdns(&headers, "private, max-age=60") {
            wrong.push(format!("{asked:?}: {what}"));
        }
    }
    assert!(wrong.is_empty(), "the browser's alone, still open to a CDN: {wrong:#?}");
    let headers = answered(&router, "/", &[]).await;
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=60");
    for name in CDN_OVERRIDES {
        assert_eq!(headers[name], "public, max-age=60", "the full document keeps the middleware's {name}");
    }
}

/// Staged middleware that rewrites every answer's `Cache-Control` after the route made it (takes it
/// out for `None`) and marks the answer for a CDN, as [`CdnWrites`] does.
pub(super) struct CdnRecaches(pub(super) Option<&'static str>);

impl crate::Middleware for CdnRecaches {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let mut res = next.run(req).await;
        let headers = res.headers_mut();
        match self.0 {
            Some(cache) => {
                headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
            }
            None => {
                headers.remove(header::CACHE_CONTROL);
            }
        }
        for name in CDN_OVERRIDES {
            headers.insert(name, HeaderValue::from_static("public, max-age=60"));
        }
        for name in CDN_OTHERS {
            headers.insert(name, HeaderValue::from_static("x"));
        }
        res
    }
}

/// `uri`'s answer through `router`, asked with `asked`: its status and headers.
async fn asked_for(router: &Router, uri: &str, asked: &[(&'static str, &'static str)]) -> (StatusCode, http::HeaderMap) {
    let mut req = Request::get(uri);
    for (name, value) in asked {
        req = req.header(*name, *value);
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    (res.status(), res.headers().clone())
}

/// A failure a `NoStore` handler returns is answered by the error page, which keeps the handler's
/// word: it goes out `private, no-store` with none of the caching headers a CDN reads first that
/// staged middleware wrote, though neither the handler nor the error page read a caller, set a
/// cookie or drew the nonce, and also for a request with credentials. A CDN that obeys
/// `CDN-Cache-Control` over `Cache-Control` (RFC 9213) would otherwise keep the page.
#[tokio::test]
async fn a_no_store_failure_s_error_page_keeps_no_cdn_caching_header() {
    let routes =
        Table::new().route("/code", get(|| async { NoStore(Err::<StatusCode, Error>(Error::status(StatusCode::BAD_REQUEST))) }));
    // The default error page, which reads no caller.
    let router = App::new(Routes::from(routes)).middleware(CdnWrites).router();
    let mut wrong = Vec::new();
    for asked in [
        &[("accept", "text/html")][..],
        &[("accept", "text/html"), ("cookie", "session=abc")],
        &[("accept", "text/html"), ("authorization", "Bearer t")],
        &[("corten", "nav")],
        &[("accept", "application/json")],
    ] {
        let (status, headers) = asked_for(&router, "/code", asked).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{asked:?}");
        assert!(!headers.contains_key(header::SET_COOKIE), "{asked:?}");
        for what in kept_from_cdns(&headers, "private, no-store") {
            wrong.push(format!("{asked:?}: {what}"));
        }
    }
    assert!(wrong.is_empty(), "a NoStore failure, open to a CDN: {wrong:#?}");
}

/// A `NoStore` answer goes out `private, no-store` wherever the cache rules see it, whatever a staged
/// middleware made of its `Cache-Control` (left, taken out, replaced with a shared one, a bare
/// `no-store`, or one beside `must-understand`), and with none of the caching headers a CDN reads
/// first: `NoStore` may be the only sign an answer is someone's (a one-time code before sign-in),
/// and some CDNs keep one that says only `no-store`. A JSON route's and a data client's too.
#[tokio::test]
async fn a_no_store_answer_goes_out_private_no_store_whatever_a_middleware_made_of_it() {
    let home = || html! { <p>"home"</p> };
    let routes = || {
        Table::new()
            .route("/statement", get(move |req: Req| async move { NoStore(req.test_page("Statement", home())) }))
            .route("/code", get(|| async { NoStore(Err::<StatusCode, Error>(Error::status(StatusCode::BAD_REQUEST))) }))
    };
    let mut wrong = Vec::new();
    let check = |wrong: &mut Vec<String>, what: String, headers: &http::HeaderMap, cdn: bool| {
        if headers[header::CACHE_CONTROL] != "private, no-store" {
            wrong.push(format!("{what}: Cache-Control {:?}", headers[header::CACHE_CONTROL]));
        }
        if cdn {
            for name in kept_from_cdns(headers, "private, no-store") {
                if !name.starts_with("Cache-Control") {
                    wrong.push(format!("{what}: {name}"));
                }
            }
        }
    };
    let asks: [&[(&str, &str)]; 4] = [&[], &[("cookie", "session=abc")], &[("corten", "nav")], &[("accept", "application/json")]];
    // No middleware: the handler's own word.
    let router = App::new(Routes::from(routes())).router();
    for uri in ["/statement", "/code"] {
        for asked in asks {
            let (_, headers) = asked_for(&router, uri, asked).await;
            check(&mut wrong, format!("{uri} {asked:?}"), &headers, false);
        }
    }
    for cache in
        [None, Some("public, max-age=60"), Some("no-store"), Some("must-understand, no-store"), Some("private, max-age=60")]
    {
        let router = App::new(Routes::from(routes())).middleware(CdnRecaches(cache)).router();
        for uri in ["/statement", "/code"] {
            for asked in asks {
                let (_, headers) = asked_for(&router, uri, asked).await;
                check(&mut wrong, format!("{cache:?} {uri} {asked:?}"), &headers, true);
            }
        }
    }
    // A route that says `no_store`, and its refusal.
    let router = App::new(no_store_url::router()).router();
    for uri in ["/slips/7", "/slips/x"] {
        for asked in asks {
            let (_, headers) = asked_for(&router, uri, asked).await;
            check(&mut wrong, format!("no_store {uri} {asked:?}"), &headers, false);
        }
    }
    assert!(wrong.is_empty(), "NoStore, but not private, no-store: {wrong:#?}");
}

/// A typed NoStore policy is independent of the header it replaces, but it still has to carry
/// the marks an inline relay needs and remove an ETag from an answer with a fresh submit key.
#[test]
fn settling_typed_no_store_keeps_the_personal_and_submit_key_rules() {
    use crate::cache::{Personal, Seen, Typed, Unrepeatable};

    for (label, credentials, caller, nonce, cookie, marked, keyed, signal, personal) in [
        ("no personal input", false, false, false, None, false, false, false, false),
        ("credentials", true, false, false, None, false, false, false, true),
        ("caller read", false, true, false, None, false, false, false, true),
        ("nonce", false, false, true, None, false, false, false, true),
        ("sets a cookie", false, false, false, Some("viewer=ann"), false, false, false, true),
        ("clears a notice", false, false, false, Some("corten-notice=; Max-Age=0"), false, false, false, false),
        ("already personal", false, false, false, None, true, false, false, true),
        ("key on the answer", false, false, false, None, false, true, false, false),
        ("key from the request", false, true, false, None, false, false, true, true),
    ] {
        let mut res = Response::new(Body::empty());
        Cache::no_store().apply(&mut res);
        if marked {
            res.extensions_mut().insert(Personal);
        }
        if keyed {
            res.extensions_mut().insert(Unrepeatable);
        }
        let headers = res.headers_mut();
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=60"));
        headers.append(header::CACHE_CONTROL, HeaderValue::from_static("must-understand, no-store"));
        headers.insert(header::ETAG, HeaderValue::from_static("\"from-middleware\""));
        if let Some(cookie) = cookie {
            headers.insert(header::SET_COOKIE, HeaderValue::from_static(cookie));
        }
        for name in CDN_OVERRIDES {
            headers.append(name, HeaderValue::from_static("max-age=60"));
            headers.append(name, HeaderValue::from_static("max-age=120"));
        }

        let seen = Seen { credentials, caller, nonce, partial: true, dev: false };
        crate::cache::settle_drawn(&mut res, seen, "/statement", signal);
        let headers = res.headers();
        let mut policy = headers.get_all(header::CACHE_CONTROL).iter();
        assert_eq!(policy.next(), Some(&crate::cache::PRIVATE_NO_STORE), "{label}");
        assert!(policy.next().is_none(), "{label}: another cache policy survived");
        assert!(CDN_OVERRIDES.iter().all(|name| !headers.contains_key(*name)), "{label}");
        assert_eq!(headers.contains_key(header::ETAG), !(keyed || signal), "{label}");
        assert_eq!(res.extensions().get::<Personal>().is_some(), personal, "{label}");
        assert_eq!(res.extensions().get::<Unrepeatable>().is_some(), keyed, "{label}");
        assert!(Typed::is_no_store(&res), "{label}");
    }
}

/// A `Public` page asked for as anything but its full document is the browser's alone, and goes out
/// with none of the caching headers a CDN reads first also when a staged middleware already made
/// its `Cache-Control` `private` or `no-store`, or took it out. A `no-store` any reader could find
/// (beside `must-understand`, on a second line, `no-store=1`, also beside a plain `private`) goes
/// out `private, no-store`: some CDNs keep an answer that says only `no-store`, and a browser that
/// ignores `no-store=1` would keep a `private` one. The full document keeps what the middleware
/// wrote.
#[tokio::test]
async fn a_public_page_in_a_partial_mode_keeps_no_cdn_caching_header_whatever_a_middleware_says() {
    /// Staged middleware that writes these lines in place of the answer's `Cache-Control` (none
    /// takes it out) and marks the answer for a CDN, as [`CdnWrites`] does.
    struct Recached(&'static [&'static str]);

    impl crate::Middleware for Recached {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let mut res = next.run(req).await;
            let headers = res.headers_mut();
            headers.remove(header::CACHE_CONTROL);
            for line in self.0 {
                headers.append(header::CACHE_CONTROL, HeaderValue::from_static(line));
            }
            for name in CDN_OVERRIDES {
                headers.insert(name, HeaderValue::from_static("public, max-age=60"));
            }
            for name in CDN_OTHERS {
                headers.insert(name, HeaderValue::from_static("x"));
            }
            res
        }
    }

    let minute = std::time::Duration::from_secs(60);
    let routes = || {
        Table::new().route(
            "/",
            get(move |req: Req| async move { Public::new(minute, req.test_page_for("Home", html! { <p>"home"</p> })) }),
        )
    };
    let mut wrong = Vec::new();
    for (lines, partial, full) in [
        (&["private, max-age=60"][..], "private, max-age=60", "private, max-age=60"),
        (&["no-store"], "private, no-store", "no-store"),
        (&[], "private, no-cache", "private, no-cache"),
        (&["must-understand, no-store"], "private, no-store", "must-understand, no-store"),
        (&["public, max-age=60", "no-store"], "private, no-store", "public, max-age=60, no-store"),
        (&["public, max-age=60, no-store=1"], "private, no-store", "public, max-age=60, no-store=1"),
        // Already private, with a `no-store` a reader could find: a private cache that ignores the
        // malformed directive would keep the partial.
        (&["private, max-age=60, no-store=1"], "private, no-store", "private, max-age=60, no-store=1"),
    ] {
        let router = App::new(Routes::from(routes())).middleware(Recached(lines)).router();
        for asked in [
            &[("corten", "nav")][..],
            &[("corten", "action")],
            &[("accept", "application/json")],
            &[("corten", "page"), ("accept", "text/html")],
        ] {
            let (status, headers) = asked_for(&router, "/", asked).await;
            assert_eq!(status, StatusCode::OK, "{lines:?} {asked:?}");
            assert_eq!(headers.get_all(header::CACHE_CONTROL).iter().count(), 1, "{lines:?} {asked:?}: one line");
            for what in kept_from_cdns(&headers, partial) {
                wrong.push(format!("{lines:?} {asked:?}: {what}"));
            }
        }
        let (_, headers) = asked_for(&router, "/", &[]).await;
        assert_eq!(headers[header::CACHE_CONTROL], full, "{lines:?}: the full document");
        for name in CDN_OVERRIDES {
            assert_eq!(headers[name], "public, max-age=60", "{lines:?}: the full document keeps the middleware's {name}");
        }
    }
    assert!(wrong.is_empty(), "the browser's alone, still open to a CDN: {wrong:#?}");
}

/// The usual page, with no `Cache-Control` of its own, to which a staged middleware adds a cookie
/// and the caching headers a CDN reads first: the cookie makes it personal, so it loses them.
#[tokio::test]
async fn a_cookie_a_middleware_sets_on_the_usual_page_takes_its_cdn_caching_headers() {
    struct CookieAndCdn;

    impl crate::Middleware for CookieAndCdn {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let mut res = next.run(req).await;
            let headers = res.headers_mut();
            headers.append(header::SET_COOKIE, HeaderValue::from_static("seen=1"));
            for name in CDN_OVERRIDES {
                headers.insert(name, HeaderValue::from_static("public, max-age=60"));
            }
            for name in CDN_OTHERS {
                headers.insert(name, HeaderValue::from_static("x"));
            }
            res
        }
    }

    let routes = Table::new().route("/", get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) }));
    let router = App::new(Routes::from(routes)).middleware(CookieAndCdn).router();
    let headers = answered(&router, "/", &[]).await;
    assert_eq!(headers[header::SET_COOKIE], "seen=1");
    assert_eq!(kept_from_cdns(&headers, "private, no-cache"), Vec::<String>::new());
}

/// A refused cross-site write gets the app's error page, which goes out before the cache rules
/// run, private whatever it said, and with none of the CDN caching headers it wrote: the page may
/// show who is asking, and a CDN that read its own header would keep it for the next visitor. A
/// `no-store` it says goes out `private, no-store`, whether or not it draws a submit key; anything
/// else is sent `private, no-cache`. One that draws a submit key loses the tag it was given too, as
/// any answer that draws one does; one that draws none keeps it.
#[tokio::test]
async fn a_refused_write_s_page_is_not_shared() {
    let refused = |keyed: bool, cache: &'static str| {
        let router = App::new(Routes::from(Table::new().route("/", get(|| async { "home" }).post(|| async { "saved" }))))
            .error_page(
                move |_: Failure, req: Req| async move {
                    let form = html! {
                        <form method="post">if keyed { {crate::SubmitKey::field(KeyedWrite::FIELDS.submit)} }</form>
                    };
                    req.test_page("Not allowed", form).map(|mut page| {
                        let headers = page.headers_mut();
                        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
                        headers.insert(header::ETAG, HeaderValue::from_static("\"given\""));
                        for name in CDN_OVERRIDES {
                            headers.insert(name, HeaderValue::from_static("max-age=60"));
                        }
                        page
                    })
                },
                (),
            )
            .router();
        async move {
            let req = Request::post("/")
                .header("origin", "https://evil.example")
                .header("sec-fetch-site", "cross-site")
                .header("accept", "text/html")
                .body(Body::empty())
                .unwrap();
            let res = router.oneshot(req).await.unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN);
            res.headers().clone()
        }
    };
    for (keyed, cache, sent) in [
        (true, "no-store", "private, no-store"),
        (true, "public, max-age=60", "private, no-cache"),
        (false, "no-store", "private, no-store"),
        (false, "public, max-age=60", "private, no-cache"),
    ] {
        let headers = refused(keyed, cache).await;
        assert_eq!(headers[header::CACHE_CONTROL], sent, "keyed {keyed}, {cache}");
        if keyed {
            assert!(!headers.contains_key(header::ETAG), "a keyed refusal sends no tag ({cache}): {headers:?}");
        } else {
            assert_eq!(headers[header::ETAG], "\"given\"", "a refusal with no key keeps its tag ({cache})");
        }
        for name in CDN_OVERRIDES {
            assert!(!headers.contains_key(name), "a refusal sends no {name} (keyed {keyed}, {cache})");
        }
    }
}

#[crate::routes]
mod unanswered_url {
    #[route("/codes/{id}", get = code)]
    pub struct Code {
        pub id: u32,
    }
}

/// A one-time code's page, which nothing may keep.
async fn code(crate::Params(at): crate::Params<unanswered_url::Code>) -> NoStore<HtmlResult> {
    NoStore(Ok(crate::answer::HtmlResponse::new(crate::response::IntoResponse::into_response(format!("code {}", at.id)))))
}

async fn broken() -> &'static str {
    if true {
        panic!("broken")
    } else {
        "never"
    }
}

async fn late() -> &'static str {
    tokio::time::sleep(Duration::from_secs(5)).await;
    "late"
}

/// The app's error page in place of a failure no handler answered (a request an extractor refused
/// before the handler ran, a handler that panicked or passed its deadline) can read the request's
/// `Cookie` and `Authorization` without reading a caller, and the handler's `NoStore` never
/// reached it. It is never shared, as a refused write's page is not: `private` whatever a staged
/// middleware or the error page itself made of its `Cache-Control` (`private, no-store` where
/// either names `no-store`), and with none of the caching headers a CDN reads first, whoever wrote
/// them.
#[tokio::test]
async fn an_error_page_for_a_failure_no_handler_answered_is_not_shared() {
    let mut wrong = Vec::new();
    let asks: [&[(&str, &str)]; 3] =
        [&[("accept", "text/html")], &[("accept", "text/html"), ("cookie", "session=abc")], &[("corten", "nav")]];
    // A path that does not parse, under a middleware's shared lifetime.
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(unanswered_url::router()).middleware(CdnRecaches(cache)).router();
        for asked in asks {
            let (status, headers) = asked_for(&router, "/codes/x", asked).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{cache:?} {asked:?}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("refused, {cache:?} {asked:?}: {what}"));
            }
        }
        let (status, headers) = asked_for(&router, "/codes/7", &[("accept", "text/html")]).await;
        assert_eq!(status, StatusCode::OK, "{cache:?}");
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-store", "{cache:?}");
    }
    // A handler that panics and one past its deadline, whose error page writes its own.
    let error_page = |cache: Option<&'static str>| {
        move |_: Failure, req: Req| async move {
            req.test_page("Failed", html! { <p>"failed"</p> }).map(|mut page| {
                let headers = page.headers_mut();
                if let Some(cache) = cache {
                    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
                }
                for name in CDN_OVERRIDES {
                    headers.insert(name, HeaderValue::from_static("max-age=60"));
                }
                for name in CDN_OTHERS {
                    headers.insert(name, HeaderValue::from_static("x"));
                }
                page
            })
        }
    };
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let routes = Table::new().route("/broken", get(broken)).route("/late", get(late));
        let router =
            App::new(Routes::from(routes)).deadline(Duration::from_millis(50)).error_page(error_page(cache), ()).router();
        for (uri, status) in [("/broken", StatusCode::INTERNAL_SERVER_ERROR), ("/late", StatusCode::SERVICE_UNAVAILABLE)] {
            for asked in asks {
                let (got, headers) = asked_for(&router, uri, asked).await;
                assert_eq!(got, status, "{uri} {cache:?} {asked:?}");
                for what in kept_from_cdns(&headers, sent) {
                    wrong.push(format!("{uri}, {cache:?} {asked:?}: {what}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "an error page no handler answered, open to a CDN: {wrong:#?}");
}

/// Who is asking, by the request's `Cookie` (`name=ann`), read by an extractor of the app's own
/// with no caller: how an error page can show the visitor without marking the answer personal.
pub(super) struct CookieName(String);

impl<S: Send + Sync> crate::extract::FromRequestParts<S> for CookieName {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut http::request::Parts, _: &S) -> std::result::Result<Self, Response> {
        let cookie = parts.headers.get(header::COOKIE).and_then(|cookie| cookie.to_str().ok()).unwrap_or("");
        Ok(CookieName(cookie.strip_prefix("name=").unwrap_or("stranger").to_string()))
    }
}

/// An app's error page that greets the visitor its cookie names.
pub(super) async fn greeting_error_page(_: Failure, req: Req, name: CookieName) -> HtmlResult {
    req.test_page("Sorry", html! { <p>"Sorry, "{name.0}"."</p> })
}

/// `method` `uri` through `router` from Ann (`name=ann`), asked with `asked`: its status, headers
/// and body.
pub(super) async fn from_ann(
    router: &Router,
    method: &str,
    uri: &str,
    asked: &[(&'static str, &'static str)],
) -> (StatusCode, http::HeaderMap, String) {
    let mut req = Request::builder().method(method).uri(uri).header(header::COOKIE, "name=ann");
    for (name, value) in asked {
        req = req.header(*name, *value);
    }
    let (parts, body) = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
    let body = String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap();
    (parts.status, parts.headers, body)
}

/// The router's own answer for a request no route's handler takes (the `404` of an unknown URL, the
/// `405` of a method the route lacks, the `501` of one no route has, and the PWA's offline page in
/// place of its `404`) becomes the app's error page, which can greet Ann by her cookie without
/// reading a caller. No handler said what it is, so it is never shared, as for a failure no handler
/// answered: `private` whatever a staged middleware made of its `Cache-Control` (`private,
/// no-store` where it names `no-store`), and none of the caching headers a CDN reads first. A
/// handler's own `404` is the handler's answer, settled by the usual rules: it keeps them.
#[tokio::test]
async fn the_router_s_own_failure_page_is_not_shared() {
    let routes = || {
        Table::new()
            .route("/", get(|| async { "home" }))
            .route("/form", crate::router::post(|| async { "saved" }))
            .route("/gone", get(|| async { StatusCode::NOT_FOUND }))
    };
    let mut wrong = Vec::new();
    for (cache, sent, own) in [
        (None, "private, no-cache", "private, no-cache"),
        (Some("public, max-age=60"), "private, no-cache", "private, no-cache"),
        (Some("no-store"), "private, no-store", "no-store"),
    ] {
        let pwa = crate::pwa::Pwa::new(crate::pwa::Manifest::new("A", "A"));
        let router =
            App::new(Routes::from(routes())).middleware(CdnRecaches(cache)).error_page(greeting_error_page, ()).pwa(pwa).router();
        for (method, uri, status) in [
            ("GET", "/nowhere", StatusCode::NOT_FOUND),
            ("GET", "/form", StatusCode::METHOD_NOT_ALLOWED),
            ("PATCH", "/", StatusCode::NOT_IMPLEMENTED),
            ("GET", "/offline", StatusCode::OK),
        ] {
            let (got, headers, body) = from_ann(&router, method, uri, &[("accept", "text/html")]).await;
            assert_eq!(got, status, "{method} {uri} {cache:?}");
            assert!(body.contains("Sorry, ann."), "{method} {uri} {cache:?}: {body}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("{method} {uri}, {cache:?}: {what}"));
            }
        }
        let (status, headers) = asked_for(&router, "/gone", &[("accept", "text/html")]).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{cache:?}");
        assert_eq!(headers[header::CACHE_CONTROL], own, "{cache:?}: a handler's own 404");
        for name in CDN_OVERRIDES {
            assert_eq!(headers[name], "public, max-age=60", "{cache:?}: a handler's own 404 keeps {name}");
        }
    }
    assert!(wrong.is_empty(), "the router's own failure page, open to a CDN: {wrong:#?}");
}

/// A request for the app's static files that names no file (one the version being served lacks,
/// or a path that is not one, which Corten's route refuses as it reads it) is no handler's answer
/// either: the app's error page in its place can greet Ann by her cookie without reading a caller,
/// so it goes out `private` whatever a staged middleware made of its `Cache-Control` (`private,
/// no-store` where it names `no-store`), with none of the caching headers a CDN reads first. The
/// file itself is everyone's and keeps them.
#[tokio::test]
async fn a_static_file_miss_s_error_page_is_not_shared() {
    let routes = || Table::new().route("/style", get(|req: Req| async move { req.asset(RefusedStatic::STYLE_CSS).to_string() }));
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes()))
            .assets(RefusedStatic)
            .middleware(CdnRecaches(cache))
            .error_page(greeting_error_page, ())
            .router();
        // The stylesheet's URL at the version the app serves: `/assets/{version}/style.css`.
        let (_, _, href) = from_ann(&router, "GET", "/style", &[]).await;
        assert!(href.starts_with("/assets/") && href.ends_with("/style.css"), "{href}");
        let (status, headers, _) = from_ann(&router, "GET", &href, &[("accept", "text/html")]).await;
        assert_eq!(status, StatusCode::OK, "{cache:?}: the file");
        for name in CDN_OVERRIDES {
            assert_eq!(headers[name], "public, max-age=60", "{cache:?}: the file keeps {name}");
        }
        let old = href.replacen(&href["/assets/".len().."/assets/".len() + 12], "000000000000", 1);
        for (uri, status) in [
            (href.replace("style.css", "missing.css"), StatusCode::NOT_FOUND),
            (old.replace("style.css", "missing.css"), StatusCode::NOT_FOUND),
            (href.replace("style.css", "%FF.css"), StatusCode::BAD_REQUEST),
        ] {
            let (got, headers, body) = from_ann(&router, "GET", &uri, &[("accept", "text/html")]).await;
            assert_eq!(got, status, "{uri} {cache:?}");
            assert!(body.contains("Sorry, ann."), "{uri} {cache:?}: {body}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("{uri}, {cache:?}: {what}"));
            }
        }
    }
    assert!(wrong.is_empty(), "a static file miss's error page, open to a CDN: {wrong:#?}");
}

/// Staged middleware that passes the request on rebuilt from its method, URI, version, headers and
/// body, with extensions of its own: none (`Fresh`), or a signal of its own in place of the one
/// the request had (`Replaced`). `Next::run` takes any request.
#[derive(Clone, Copy, Debug)]
enum Rebuilds {
    Fresh,
    Replaced,
}

impl crate::Middleware for Rebuilds {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let (parts, body) = req.into_parts();
        let mut rebuilt = Request::new(body);
        *rebuilt.method_mut() = parts.method;
        *rebuilt.uri_mut() = parts.uri;
        *rebuilt.version_mut() = parts.version;
        *rebuilt.headers_mut() = parts.headers;
        if matches!(self, Rebuilds::Replaced) {
            rebuilt.extensions_mut().insert(crate::Signal::default());
        }
        next.run(rebuilt).await
    }
}

/// Staged middleware that answers `/short` itself with an empty `404`, never running the route.
struct AnswersShort;

impl crate::Middleware for AnswersShort {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        if req.uri().path() == "/short" {
            return StatusCode::NOT_FOUND.into_response();
        }
        next.run(req).await
    }
}

/// The router's own answer stays the router's when a staged middleware passes on a request rebuilt
/// without the extensions it had, or with a signal of its own: the stages give the route the
/// request's signal themselves, past the middleware, so the error page in its place is never
/// shared, as [`the_router_s_own_failure_page_is_not_shared`] has it. A handler's own `404` is
/// still its answer, and so is a middleware's own that never ran the route: both keep what the
/// middleware wrote.
#[tokio::test]
async fn the_router_s_own_failure_page_is_not_shared_when_a_middleware_rebuilds_the_request() {
    let routes = || {
        Table::new()
            .route("/", get(|| async { "home" }))
            .route("/form", crate::router::post(|| async { "saved" }))
            .route("/gone", get(|| async { StatusCode::NOT_FOUND }))
    };
    let mut wrong = Vec::new();
    for how in [Rebuilds::Fresh, Rebuilds::Replaced] {
        for (cache, sent, own) in [
            (None, "private, no-cache", "private, no-cache"),
            (Some("public, max-age=60"), "private, no-cache", "private, no-cache"),
            (Some("no-store"), "private, no-store", "no-store"),
        ] {
            let pwa = crate::pwa::Pwa::new(crate::pwa::Manifest::new("A", "A"));
            let steps = (CdnRecaches(cache), AnswersShort, how);
            let router = App::new(Routes::from(routes())).middleware(steps).error_page(greeting_error_page, ()).pwa(pwa).router();
            for (method, uri, status) in [
                ("GET", "/nowhere", StatusCode::NOT_FOUND),
                ("GET", "/form", StatusCode::METHOD_NOT_ALLOWED),
                ("PATCH", "/", StatusCode::NOT_IMPLEMENTED),
                ("GET", "/offline", StatusCode::OK),
            ] {
                let (got, headers, body) = from_ann(&router, method, uri, &[("accept", "text/html")]).await;
                assert_eq!(got, status, "{how:?} {method} {uri} {cache:?}");
                assert!(body.contains("Sorry, ann."), "{how:?} {method} {uri} {cache:?}: {body}");
                for what in kept_from_cdns(&headers, sent) {
                    wrong.push(format!("{how:?} {method} {uri}, {cache:?}: {what}"));
                }
            }
            for uri in ["/gone", "/short"] {
                let (status, headers) = asked_for(&router, uri, &[("accept", "text/html")]).await;
                assert_eq!(status, StatusCode::NOT_FOUND, "{how:?} {uri} {cache:?}");
                assert_eq!(headers[header::CACHE_CONTROL], own, "{how:?} {uri} {cache:?}: not the router's 404");
                for name in CDN_OVERRIDES {
                    assert_eq!(headers[name], "public, max-age=60", "{how:?} {uri} {cache:?}: not the router's 404 keeps {name}");
                }
            }
        }
    }
    assert!(wrong.is_empty(), "the router's own failure page behind a rebuilt request, open to a CDN: {wrong:#?}");
}

/// An extractor of the app's own that refuses Ann by her cookie, reading no caller: with no body at
/// `/refused`, with the reason as plain text at `/refused/text`.
struct RefusedByCookie;

impl<S: Send + Sync> crate::extract::FromRequestParts<S> for RefusedByCookie {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut http::request::Parts, _: &S) -> std::result::Result<Self, Response> {
        let cookie = parts.headers.get(header::COOKIE).and_then(|cookie| cookie.to_str().ok()).unwrap_or("");
        let name = cookie.strip_prefix("name=").unwrap_or("stranger");
        Err(match parts.uri.path() {
            "/refused/text" => (StatusCode::FORBIDDEN, format!("Not for {name}.")).into_response(),
            _ => StatusCode::FORBIDDEN.into_response(),
        })
    }
}

/// A request an extractor refused before its handler ran is never shared in any form it goes out
/// in, whatever a staged middleware wrote on it: the app's error page (for a refusal with no body
/// as well as one in plain text), the refusal as it is to a client that does not ask for HTML, and
/// JSON. Each goes out `private` (`private, no-store` where the middleware named `no-store`), with
/// none of the caching headers a CDN reads first.
#[tokio::test]
async fn a_refusal_before_the_handler_is_not_shared_in_any_form() {
    let routes = || {
        Table::new()
            .route("/refused", get(|_: RefusedByCookie| async { "never" }))
            .route("/refused/text", get(|_: RefusedByCookie| async { "never" }))
    };
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes())).middleware(CdnRecaches(cache)).error_page(greeting_error_page, ()).router();
        for (uri, asked, shows) in [
            ("/refused", &[("accept", "text/html")][..], "Sorry, ann."),
            ("/refused/text", &[("accept", "text/html")], "Sorry, ann."),
            ("/refused/text", &[("accept", "text/plain")], "Not for ann."),
            ("/refused/text", &[("accept", "application/json")], "Not for ann."),
            ("/refused", &[("accept", "application/json")], "Forbidden"),
        ] {
            let (status, headers, body) = from_ann(&router, "GET", uri, asked).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri} {asked:?} {cache:?}");
            assert!(body.contains(shows), "{uri} {asked:?} {cache:?}: {body}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("{uri} {asked:?}, {cache:?}: {what}"));
            }
        }
    }
    assert!(wrong.is_empty(), "a refusal before the handler, open to a CDN: {wrong:#?}");
}

/// An extractor of the app's own that refuses Ann by her cookie in a form other than a failure the
/// error page replaces, reading no caller: a redirect at `/refused/redirect`, a relayed failure at
/// `/refused/relayed`, and a sign-in at `/refused/sign-in`.
struct RefusedOtherwise;

impl<S: Send + Sync> crate::extract::FromRequestParts<S> for RefusedOtherwise {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut http::request::Parts, _: &S) -> std::result::Result<Self, Response> {
        let cookie = parts.headers.get(header::COOKIE).and_then(|cookie| cookie.to_str().ok()).unwrap_or("");
        let name = cookie.strip_prefix("name=").unwrap_or("stranger").to_string();
        Err(match parts.uri.path() {
            "/refused/redirect" => (StatusCode::SEE_OTHER, [(header::LOCATION, format!("/hello?for={name}"))]).into_response(),
            "/refused/relayed" => {
                let mut headers = http::HeaderMap::new();
                headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
                crate::Relay::new(StatusCode::FORBIDDEN, headers, Body::from(format!("Not for {name}."))).into_response()
            }
            _ => crate::Refused::sign_in(&super::caller::caller_url::SignIn).into_response(),
        })
    }
}

/// A request an extractor refused before its handler ran is never shared whatever the refusal is,
/// not only when the error page replaces it: a redirect, a relayed failure and a sign-in go out as
/// they were made (their status, `Location` and body), in every form a client asks for, but
/// `private` (`private, no-store` where a staged middleware named `no-store`), with none of the
/// caching headers a CDN reads first that the middleware wrote.
#[tokio::test]
async fn a_refusal_before_the_handler_is_not_shared_however_it_answers() {
    let routes = || {
        Table::new()
            .route("/refused/redirect", get(|_: RefusedOtherwise| async { "never" }))
            .route("/refused/relayed", get(|_: RefusedOtherwise| async { "never" }))
            .route("/refused/sign-in", get(|_: RefusedOtherwise| async { "never" }))
    };
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes())).middleware(CdnRecaches(cache)).error_page(greeting_error_page, ()).router();
        for asked in [[("accept", "text/html")], [("accept", "text/plain")], [("accept", "application/json")]] {
            let json = asked[0].1 == "application/json";
            let (status, headers, _) = from_ann(&router, "GET", "/refused/redirect", &asked).await;
            assert_eq!(status, StatusCode::SEE_OTHER, "redirect {asked:?} {cache:?}");
            assert_eq!(headers[header::LOCATION], "/hello?for=ann", "redirect {asked:?} {cache:?}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("redirect {asked:?}, {cache:?}: {what}"));
            }
            let (status, headers, body) = from_ann(&router, "GET", "/refused/relayed", &asked).await;
            assert!(status == StatusCode::FORBIDDEN && body == "Not for ann.", "relayed {asked:?} {cache:?}: {status} {body}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("relayed {asked:?}, {cache:?}: {what}"));
            }
            // A data client is told it is not signed in; any other is sent to sign in.
            let (status, headers, _) = from_ann(&router, "GET", "/refused/sign-in", &asked).await;
            if json {
                assert_eq!(status, StatusCode::UNAUTHORIZED, "sign-in {asked:?} {cache:?}");
            } else {
                assert!(status.is_redirection(), "sign-in {asked:?} {cache:?}: {status}");
                assert_eq!(headers[header::LOCATION], "/sign-in", "sign-in {asked:?} {cache:?}");
            }
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("sign-in {asked:?}, {cache:?}: {what}"));
            }
        }
    }
    assert!(wrong.is_empty(), "a refusal before the handler, open to a CDN: {wrong:#?}");
}

/// An extractor of the app's own whose rejection is a `200` greeting Ann by her cookie, reading no
/// caller: a rejection need only be an answer, whatever its status.
struct GreetsInstead;

impl<S: Send + Sync> crate::extract::FromRequestParts<S> for GreetsInstead {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut http::request::Parts, _: &S) -> std::result::Result<Self, Response> {
        let cookie = parts.headers.get(header::COOKIE).and_then(|cookie| cookie.to_str().ok()).unwrap_or("");
        let name = cookie.strip_prefix("name=").unwrap_or("stranger");
        Err((StatusCode::OK, format!("Hello, {name}.")).into_response())
    }
}

/// A request an extractor refused with a `200` is still refused before its handler ran: the answer
/// goes out as it was made (its status and body) to a browser and to a data client, but never
/// shared, whatever a staged middleware wrote on it. A `200` no refusal made (the handler's) keeps
/// what the middleware wrote.
#[tokio::test]
async fn a_refusal_before_the_handler_that_answers_200_is_not_shared() {
    let routes = || Table::new().route("/greet", get(|_: GreetsInstead| async { "never" })).route("/", get(|| async { "home" }));
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes())).middleware(CdnRecaches(cache)).router();
        for asked in [[("accept", "text/html")], [("accept", "application/json")]] {
            let (status, headers, body) = from_ann(&router, "GET", "/greet", &asked).await;
            assert!(status == StatusCode::OK && body == "Hello, ann.", "{asked:?} {cache:?}: {status} {body}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("{asked:?}, {cache:?}: {what}"));
            }
            let (status, headers, body) = from_ann(&router, "GET", "/", &asked).await;
            assert!(status == StatusCode::OK && body == "home", "{asked:?} {cache:?}: {status} {body}");
            for name in CDN_OVERRIDES {
                assert_eq!(headers[name], "public, max-age=60", "{asked:?} {cache:?}: the handler's 200 keeps {name}");
            }
        }
    }
    assert!(wrong.is_empty(), "a refusal that answers 200, open to a CDN: {wrong:#?}");
}

/// Staged middleware that turns Ann away by her cookie with the typed refusal middleware is given
/// ([`crate::Refused`]), reading no caller: too many attempts, with what she is told.
struct RefusesByCookie;

impl crate::Middleware for RefusesByCookie {
    async fn call(&self, req: Request, _: impl crate::middleware::Next) -> crate::response::Response {
        let cookie = req.headers().get(header::COOKIE).and_then(|cookie| cookie.to_str().ok()).unwrap_or("");
        let name = cookie.strip_prefix("name=").unwrap_or("stranger");
        crate::Refused::too_many(Duration::from_secs(30)).message(format!("Not for {name}.")).into_response()
    }
}

/// A middleware's typed refusal is never shared in any form it goes out in: the app's error page
/// for a browser, and JSON (with what the refusal tells the client) for a data client. Each keeps
/// the refusal's `Retry-After` and goes out `private` (`private, no-store` where another staged
/// middleware named `no-store`), with none of the caching headers a CDN reads first that it wrote.
#[tokio::test]
async fn a_middleware_s_refusal_is_not_shared_in_any_form() {
    let routes = || Table::new().route("/", get(|| async { "never" }));
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes()))
            .middleware((CdnRecaches(cache), RefusesByCookie))
            .error_page(greeting_error_page, ())
            .router();
        for (asked, shows) in [([("accept", "text/html")], "Sorry, ann."), ([("accept", "application/json")], "Not for ann.")] {
            let (status, headers, body) = from_ann(&router, "GET", "/", &asked).await;
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{asked:?} {cache:?}");
            assert!(body.contains(shows), "{asked:?} {cache:?}: {body}");
            assert_eq!(headers[header::RETRY_AFTER], "30", "{asked:?} {cache:?}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("{asked:?}, {cache:?}: {what}"));
            }
        }
    }
    assert!(wrong.is_empty(), "a middleware's refusal, open to a CDN: {wrong:#?}");
}

/// Staged middleware that changes a failure from inside it: by default its status to a redirect to
/// a page that says why (`303`, `Location: /slow-down`), with `x-turn: ok` its status to `200`,
/// and with `x-turn: own` an answer of its own in its place (the same redirect, made anew).
struct TurnsFailures;

impl crate::Middleware for TurnsFailures {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let turn = req.headers().get("x-turn").cloned();
        let mut res = next.run(req).await;
        if !res.status().is_client_error() {
            return res;
        }
        match turn.as_ref().map(HeaderValue::as_bytes) {
            Some(b"ok") => *res.status_mut() = StatusCode::OK,
            Some(b"own") => return (StatusCode::SEE_OTHER, [(header::LOCATION, "/slow-down")]).into_response(),
            _ => {
                *res.status_mut() = StatusCode::SEE_OTHER;
                res.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/slow-down"));
            }
        }
        res
    }
}

/// A middleware's typed refusal stays one whatever status another middleware gives it: turned into a
/// redirect or a `200`, it goes out with that status (and its `Location` and `Retry-After`), in
/// every form a client asks for, but never shared, whatever the outer middleware wrote. An answer
/// the middleware makes in its place is its own, and keeps what it wrote.
#[tokio::test]
async fn a_refusal_whose_status_a_middleware_changes_is_still_not_shared() {
    let routes = || Table::new().route("/", get(|| async { "never" }));
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes()))
            .middleware((CdnRecaches(cache), TurnsFailures, RefusesByCookie))
            .error_page(greeting_error_page, ())
            .router();
        for accept in ["text/html", "application/json"] {
            let (status, headers, _) = from_ann(&router, "GET", "/", &[("accept", accept)]).await;
            assert_eq!(status, StatusCode::SEE_OTHER, "redirect {accept} {cache:?}");
            assert_eq!(headers[header::LOCATION], "/slow-down", "redirect {accept} {cache:?}");
            assert_eq!(headers[header::RETRY_AFTER], "30", "redirect {accept} {cache:?}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("redirect {accept}, {cache:?}: {what}"));
            }
            let (status, headers, _) = from_ann(&router, "GET", "/", &[("accept", accept), ("x-turn", "ok")]).await;
            assert_eq!(status, StatusCode::OK, "200 {accept} {cache:?}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("200 {accept}, {cache:?}: {what}"));
            }
            let (status, headers, _) = from_ann(&router, "GET", "/", &[("accept", accept), ("x-turn", "own")]).await;
            assert_eq!(status, StatusCode::SEE_OTHER, "own {accept} {cache:?}");
            for name in CDN_OVERRIDES {
                assert_eq!(
                    headers[name], "public, max-age=60",
                    "own {accept} {cache:?}: the middleware's own answer keeps {name}"
                );
            }
        }
    }
    assert!(wrong.is_empty(), "a refusal another middleware turned, open to a CDN: {wrong:#?}");
}

/// Staged middleware that asks another Corten app for an answer inline, on the same poll, as one
/// that consults a second router of the app's own does. By default it makes a typed refusal first
/// and answers with it, turned into a `200`, once the other app has answered; with `x-relay` it
/// answers with the other app's refusal (an extractor's `200`, [`GreetsInstead`]); with `x-pass`
/// it passes the request on to the route.
struct AsksAnotherApp(Router);

impl crate::Middleware for AsksAnotherApp {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let (relay, pass) = (req.headers().contains_key("x-relay"), req.headers().contains_key("x-pass"));
        let refusal = (!relay && !pass).then(|| crate::Refused::too_many(Duration::from_secs(30)).into_response());
        let asked = Request::get(if relay { "/greet" } else { "/" }).header(header::COOKIE, "name=ann");
        let other = self.0.clone().oneshot(asked.body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(other.status(), StatusCode::OK, "the other app's answer");
        if relay {
            return other;
        }
        let Some(mut res) = refusal else { return next.run(req).await };
        *res.status_mut() = StatusCode::OK;
        res
    }
}

/// A refusal made while the request's stages ran is looked at however they ran: a middleware that
/// runs another Corten app's stages inside its own poll (asking it for an answer inline) hides
/// neither its own refusal, turned into a `200` after the other app answered, nor the other app's
/// refusal that it relays, in either mode. The route's own `200`, given after the other app
/// answered, keeps what the middleware wrote.
#[tokio::test]
async fn a_refusal_made_around_another_app_s_answer_is_still_not_shared() {
    let other = App::new(Routes::from(
        Table::new().route("/", get(|| async { "other" })).route("/greet", get(|_: GreetsInstead| async { "never" })),
    ))
    .router();
    let routes = || Table::new().route("/", get(|| async { "home" }));
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes())).middleware((CdnRecaches(cache), AsksAnotherApp(other.clone()))).router();
        for accept in ["text/html", "application/json"] {
            let (status, headers, _) = from_ann(&router, "GET", "/", &[("accept", accept)]).await;
            assert_eq!(status, StatusCode::OK, "own {accept} {cache:?}");
            assert_eq!(headers[header::RETRY_AFTER], "30", "own {accept} {cache:?}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("own {accept}, {cache:?}: {what}"));
            }
            let (status, headers, body) = from_ann(&router, "GET", "/", &[("accept", accept), ("x-relay", "1")]).await;
            assert!(status == StatusCode::OK && body == "Hello, ann.", "relayed {accept} {cache:?}: {status} {body}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("relayed {accept}, {cache:?}: {what}"));
            }
            let (status, headers, body) = from_ann(&router, "GET", "/", &[("accept", accept), ("x-pass", "1")]).await;
            assert!(status == StatusCode::OK && body == "home", "passed {accept} {cache:?}: {status} {body}");
            for name in CDN_OVERRIDES {
                assert_eq!(headers[name], "public, max-age=60", "passed {accept} {cache:?}: the route's 200 keeps {name}");
            }
        }
    }
    assert!(wrong.is_empty(), "a refusal made around another app's answer, open to a CDN: {wrong:#?}");
}

/// Staged middleware that answers with another Corten app's answer to the same request (its
/// method, URI and headers), asked inline on the same poll, as one that consults a second router of
/// the app's own does: as it is, turned into a `200` with `x-ok`, or discarded for the route's own
/// answer with `x-discard`.
pub(super) struct RelaysAnotherApp(pub(super) Router);

impl crate::Middleware for RelaysAnotherApp {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let (ok, discard) = (req.headers().contains_key("x-ok"), req.headers().contains_key("x-discard"));
        let mut asked = Request::builder().method(req.method().clone()).uri(req.uri().clone());
        for (name, value) in req.headers() {
            asked = asked.header(name, value);
        }
        let mut res = self.0.clone().oneshot(asked.body(Body::empty()).unwrap()).await.unwrap();
        if discard {
            return next.run(req).await;
        }
        if ok {
            *res.status_mut() = StatusCode::OK;
        }
        res
    }
}

/// Another Corten app's refusal or failure, relayed inline by a staged middleware, is settled by the
/// marks Corten put on what that app sent, whatever the relaying app's middleware wrote on it: the
/// error page it drew for a refusal (greeting Ann by her cookie), its sign-in redirect, and its JSON
/// for a handler that panicked or passed its deadline go out `private` (`private, no-store` where
/// the middleware named `no-store`), with none of the caching headers a CDN reads first, as they
/// came or turned into a `200`. The route's own answer, given after the middleware discarded the
/// other app's refusal, keeps what the middleware wrote.
#[tokio::test]
async fn another_app_s_refusal_relayed_inline_is_still_not_shared() {
    let other = App::new(Routes::from(
        Table::new()
            .route("/refused", get(|_: RefusedByCookie| async { "never" }))
            .route("/refused/sign-in", get(|_: RefusedOtherwise| async { "never" }))
            .route("/broken", get(broken))
            .route("/late", get(late)),
    ))
    .deadline(Duration::from_millis(50))
    .error_page(greeting_error_page, ())
    .router();
    let home = || get(|| async { "home" });
    let routes = || {
        Table::new().route("/refused", home()).route("/refused/sign-in", home()).route("/broken", home()).route("/late", home())
    };
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes())).middleware((CdnRecaches(cache), RelaysAnotherApp(other.clone()))).router();
        for turned in [&[][..], &[("x-ok", "1")]] {
            let html = [&[("accept", "text/html")][..], turned].concat();
            let (status, headers, body) = from_ann(&router, "GET", "/refused", &html).await;
            assert!(body.contains("Sorry, ann."), "error page {turned:?} {cache:?}: {status} {body}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("error page {turned:?}, {cache:?}: {what}"));
            }
            let (status, headers, _) = from_ann(&router, "GET", "/refused/sign-in", &html).await;
            assert!(status.is_redirection() || status == StatusCode::OK, "sign-in {turned:?} {cache:?}: {status}");
            assert_eq!(headers[header::LOCATION], "/sign-in", "sign-in {turned:?} {cache:?}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("sign-in {turned:?}, {cache:?}: {what}"));
            }
            let json = [&[("accept", "application/json")][..], turned].concat();
            for uri in ["/broken", "/late"] {
                let (status, headers, body) = from_ann(&router, "GET", uri, &json).await;
                assert_eq!(
                    headers[header::CONTENT_TYPE],
                    "application/problem+json",
                    "{uri} {turned:?} {cache:?}: {status} {body}"
                );
                for what in kept_from_cdns(&headers, sent) {
                    wrong.push(format!("{uri} {turned:?}, {cache:?}: {what}"));
                }
            }
        }
        let (status, headers, body) = from_ann(&router, "GET", "/refused", &[("accept", "text/html"), ("x-discard", "1")]).await;
        assert!(status == StatusCode::OK && body == "home", "discarded {cache:?}: {status} {body}");
        for name in CDN_OVERRIDES {
            assert_eq!(headers[name], "public, max-age=60", "discarded {cache:?}: the route's 200 keeps {name}");
        }
    }
    assert!(wrong.is_empty(), "another app's refusal relayed inline, open to a CDN: {wrong:#?}");
}

/// Another Corten app's answer that is one visitor's for a reason its headers do not show (it read
/// a caller, or has the request's nonce, a `Public` page's included), relayed inline by a staged
/// middleware, is that visitor's in the relaying app too, though that app's own request read no
/// caller: `private` whatever the middleware made of its `Cache-Control` (`private, no-store` where
/// it named `no-store`), with none of the caching headers a CDN reads first, as it came or turned
/// into a `200`. The other app's answers nothing made personal (a `Public` page, a plain one),
/// relayed the same way, and the relaying app's own answer given in a personal one's place keep
/// what the middleware wrote (the controls).
#[tokio::test]
async fn another_app_s_personal_answer_relayed_inline_is_still_not_shared() {
    let minute = Duration::from_secs(60);
    let other = App::new(Routes::from(
        Table::new()
            .route("/me", get(my_slips))
            .route("/nonce", get(inline_default_page))
            .route("/nonce-public", get(inline_page))
            .route(
                "/public",
                get(move |req: Req| async move { Public::new(minute, req.test_page_for("Home", html! { <p>"home"</p> })) }),
            )
            .route("/plain", get(|| async { "plain" })),
    ))
    .router();
    let home = || get(|| async { "home" });
    let routes = || {
        Table::new()
            .route("/me", home())
            .route("/nonce", home())
            .route("/nonce-public", home())
            .route("/public", home())
            .route("/plain", home())
    };
    let viewer: &[(&'static str, &'static str)] = &[("viewer", "ann")];
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes())).middleware((CdnRecaches(cache), RelaysAnotherApp(other.clone()))).router();
        for turned in [&[][..], &[("x-ok", "1")]] {
            for (uri, asked) in [("/me", viewer), ("/nonce", &[]), ("/nonce-public", &[])] {
                let asked = [asked, turned].concat();
                let (status, headers) = asked_for(&router, uri, &asked).await;
                assert_eq!(status, StatusCode::OK, "{uri} {asked:?} {cache:?}");
                for what in kept_from_cdns(&headers, sent) {
                    wrong.push(format!("{uri} {turned:?}, {cache:?}: {what}"));
                }
            }
        }
        for (uri, asked) in [("/public", &[][..]), ("/plain", &[]), ("/me", &[("viewer", "ann"), ("x-discard", "1")])] {
            let (status, headers) = asked_for(&router, uri, asked).await;
            assert_eq!(status, StatusCode::OK, "{uri} {asked:?} {cache:?}");
            for name in CDN_OVERRIDES {
                if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                    wrong.push(format!("{uri} {asked:?}, {cache:?}: nothing made it personal, and it lost {name}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "another app's personal answer relayed inline, open to a CDN: {wrong:#?}");
}

/// Staged middleware that takes every `Set-Cookie` off the answer it is given, keeping the rest of
/// it in place, or with `x-fresh` sends a new answer in its place with the same status, headers
/// (but the cookie) and body.
struct TakesTheCookieOff;

impl crate::Middleware for TakesTheCookieOff {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let fresh = req.headers().contains_key("x-fresh");
        let mut res = next.run(req).await;
        res.headers_mut().remove(header::SET_COOKIE);
        if !fresh {
            return res;
        }
        let (parts, body) = res.into_parts();
        let body = body.collect().await.unwrap().to_bytes();
        let mut made = crate::response::Response::new(Body::from(body));
        *made.status_mut() = parts.status;
        *made.headers_mut() = parts.headers;
        made
    }
}

/// Another Corten app's answer that sets a cookie is that visitor's, and stays so when a staged
/// middleware of the app that relays it inline takes the cookie off and keeps the rest in place:
/// with no `Cache-Control` of its own, with one the handler wrote, and with a `Cache` mark, it goes
/// out `private` whatever the outer middleware made of its `Cache-Control` (`private, no-store`
/// where it named `no-store`), with none of the caching headers a CDN reads first, and with the
/// same body. The same body sent in a fresh answer in its place, and another app's answer that set
/// no cookie relayed the same way, keep what the middleware wrote (the controls).
#[tokio::test]
async fn another_app_s_answer_that_sets_a_cookie_stays_personal_without_it() {
    let minute = Duration::from_secs(60);
    let other = App::new(Routes::from(
        Table::new()
            .route("/cookie", get(|| async { ([(header::SET_COOKIE, "session=ann")], "ann's") }))
            .route(
                "/cookie-said",
                get(|| async { ([(header::CACHE_CONTROL, "public, max-age=60"), (header::SET_COOKIE, "session=ann")], "ann's") }),
            )
            .route(
                "/cookie-typed",
                get(move || async move { (Cache::public(minute), [(header::SET_COOKIE, "session=ann")], "ann's") }),
            )
            .route("/plain", get(|| async { "ann's" })),
    ))
    .router();
    let home = || get(|| async { "home" });
    let routes = || {
        Table::new().route("/cookie", home()).route("/cookie-said", home()).route("/cookie-typed", home()).route("/plain", home())
    };
    // Without a `Cookie`, so that nothing but the answer's own cookie makes it personal.
    let asked = |router: &Router, uri: &'static str, fresh: bool| {
        let mut req = Request::get(uri);
        if fresh {
            req = req.header("x-fresh", "1");
        }
        let router = router.clone();
        async move {
            let (parts, body) = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
            (parts.status, parts.headers, String::from_utf8_lossy(&body.collect().await.unwrap().to_bytes()).into_owned())
        }
    };
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes()))
            .middleware((CdnRecaches(cache), TakesTheCookieOff, RelaysAnotherApp(other.clone())))
            .router();
        for (uri, fresh, personal) in [
            ("/cookie", false, true),
            ("/cookie-said", false, true),
            ("/cookie-typed", false, true),
            ("/cookie", true, false),
            ("/cookie-said", true, false),
            ("/cookie-typed", true, false),
            ("/plain", false, false),
        ] {
            let (status, headers, body) = asked(&router, uri, fresh).await;
            if status != StatusCode::OK || body != "ann's" || headers.contains_key(header::SET_COOKIE) {
                wrong.push(format!("{uri} fresh {fresh}, {cache:?}: {status} {body:?} {headers:?}"));
                continue;
            }
            if personal {
                wrong.extend(kept_from_cdns(&headers, sent).into_iter().map(|what| format!("{uri}, {cache:?}: {what}")));
            } else {
                for name in CDN_OVERRIDES {
                    if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                        wrong.push(format!("{uri} fresh {fresh}, {cache:?}: nothing made it personal, and it lost {name}"));
                    }
                }
            }
        }
    }
    assert!(wrong.is_empty(), "another app's cookie-setting answer relayed inline without its cookie, open to a CDN: {wrong:#?}");
}

/// The same for another Corten app's unstaged route: its answer that sets a cookie (with nothing said
/// of caching, with a shared `Cache-Control` and a CDN's lifetime, with a private one) stays that
/// visitor's when a staged middleware of the app that relays it inline takes the cookie off and
/// rewrites its caching headers: `private` whatever that middleware made of its `Cache-Control`
/// (`private, no-store` where it named `no-store`), with none of the caching headers a CDN reads
/// first, and with the same body. The same body sent in a fresh answer in its place, and the
/// unstaged answer that set no cookie relayed the same way, keep what the middleware wrote (the
/// controls).
#[tokio::test]
async fn another_app_s_unstaged_answer_that_sets_a_cookie_stays_personal_without_it() {
    let other = App::new(super::unstaged::unstaged_url::router()).router();
    let home = || get(|| async { "home" });
    let routes = || {
        Table::new()
            .route("/cookie", home())
            .route("/shared-cookie", home())
            .route("/private-cookie", home())
            .route("/ping", home())
    };
    // Without a `Cookie`, so that nothing but the answer's own cookie makes it personal.
    let asked = |router: &Router, uri: &'static str, fresh: bool| {
        let mut req = Request::get(uri);
        if fresh {
            req = req.header("x-fresh", "1");
        }
        let router = router.clone();
        async move {
            let (parts, body) = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
            (parts.status, parts.headers, String::from_utf8_lossy(&body.collect().await.unwrap().to_bytes()).into_owned())
        }
    };
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes()))
            .middleware((CdnRecaches(cache), TakesTheCookieOff, RelaysAnotherApp(other.clone())))
            .router();
        for (uri, said, fresh, personal) in [
            ("/cookie", "seen", false, true),
            ("/shared-cookie", "id", false, true),
            ("/private-cookie", "id", false, true),
            ("/cookie", "seen", true, false),
            ("/shared-cookie", "id", true, false),
            ("/private-cookie", "id", true, false),
            ("/ping", "pong", false, false),
        ] {
            let (status, headers, body) = asked(&router, uri, fresh).await;
            if status != StatusCode::OK || body != said || headers.contains_key(header::SET_COOKIE) {
                wrong.push(format!("{uri} fresh {fresh}, {cache:?}: {status} {body:?} {headers:?}"));
                continue;
            }
            if personal {
                wrong.extend(kept_from_cdns(&headers, sent).into_iter().map(|what| format!("{uri}, {cache:?}: {what}")));
            } else {
                for name in CDN_OVERRIDES {
                    if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                        wrong.push(format!("{uri} fresh {fresh}, {cache:?}: nothing made it personal, and it lost {name}"));
                    }
                }
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "another app's unstaged cookie-setting answer relayed inline without its cookie, open to a CDN: {wrong:#?}"
    );
}

/// Staged middleware that answers with a typed refusal turned into a `200`, made before the request's
/// stages ran (when the app was built, held here) or, with `x-spawned`, on another thread.
struct AnswersAMadeRefusal(std::sync::Mutex<Vec<crate::response::Response>>);

impl crate::Middleware for AnswersAMadeRefusal {
    async fn call(&self, req: Request, _: impl crate::middleware::Next) -> crate::response::Response {
        let mut res = if req.headers().contains_key("x-spawned") {
            tokio::task::spawn_blocking(|| crate::Refused::too_many(Duration::from_secs(30)).into_response()).await.unwrap()
        } else {
            self.0.lock().unwrap().pop().expect("a refusal made before the stages")
        };
        *res.status_mut() = StatusCode::OK;
        res
    }
}

/// A typed refusal is never shared wherever and whenever it was made: one a middleware made before
/// the request's stages ran, or on another thread, and answers with as a `200` goes out `private`
/// (`private, no-store` where another middleware named `no-store`), with none of the caching
/// headers a CDN reads first, in every form a client asks for.
#[tokio::test]
async fn a_refusal_made_outside_the_stages_is_still_not_shared() {
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let made = (0..2).map(|_| crate::Refused::too_many(Duration::from_secs(30)).into_response()).collect();
        let router = App::new(Routes::from(Table::new().route("/", get(|| async { "never" }))))
            .middleware((CdnRecaches(cache), AnswersAMadeRefusal(std::sync::Mutex::new(made))))
            .router();
        for spawned in [false, true] {
            for accept in ["text/html", "application/json"] {
                let spawned_by: &[(&'static str, &'static str)] = if spawned { &[("x-spawned", "1")] } else { &[] };
                let asked = [&[("accept", accept)][..], spawned_by].concat();
                let (status, headers, _) = from_ann(&router, "GET", "/", &asked).await;
                assert_eq!(status, StatusCode::OK, "spawned {spawned} {accept} {cache:?}");
                assert_eq!(headers[header::RETRY_AFTER], "30", "spawned {spawned} {accept} {cache:?}");
                for what in kept_from_cdns(&headers, sent) {
                    wrong.push(format!("spawned {spawned} {accept}, {cache:?}: {what}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "a refusal made outside the stages, open to a CDN: {wrong:#?}");
}

/// Staged middleware that, with `x-drop`, makes the route's future and drops it unpolled, then answers
/// with an empty `404` of its own.
struct DropsTheRoute;

impl crate::Middleware for DropsTheRoute {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        if req.headers().contains_key("x-drop") {
            drop(next.run(req));
            return StatusCode::NOT_FOUND.into_response();
        }
        next.run(req).await
    }
}

/// A middleware that makes the route's future and drops it before it answers has not let the
/// router answer, even where the router's own failure would have: its own empty `404`, and the
/// error page in its place, keep what a staged middleware wrote, as a handler's own `404` does, for
/// an unknown URL, a method the route lacks or no route has, a named post the page has none of, and
/// a path under an API's prefix that a route outside it matched.
#[tokio::test]
async fn a_route_a_middleware_drops_unpolled_has_not_answered() {
    let routes = || {
        Table::new()
            .route("/", get(|| async { "home" }).post(|| async { "saved" }).named("save"))
            .route("/form", crate::router::post(|| async { "saved" }))
    };
    let mut wrong = Vec::new();
    for (cache, own) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "no-store")]
    {
        let router = App::new(Routes::from(routes())).middleware((CdnRecaches(cache), DropsTheRoute)).router();
        for (method, uri) in [("GET", "/nowhere"), ("GET", "/form"), ("PATCH", "/"), ("POST", "/?do=sell")] {
            let asked = [("accept", "text/html"), ("sec-fetch-site", "same-origin"), ("x-drop", "1")];
            let (status, headers, _) = from_ann(&router, method, uri, &asked).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri} {cache:?}");
            if headers[header::CACHE_CONTROL] != own {
                wrong.push(format!("{method} {uri}, {cache:?}: Cache-Control {:?}", headers[header::CACHE_CONTROL]));
            }
            for name in CDN_OVERRIDES {
                if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                    wrong.push(format!("{method} {uri}, {cache:?}: lost {name}"));
                }
            }
        }
    }
    #[cfg(feature = "json")]
    for (cache, own) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "public, max-age=60"), (Some("no-store"), "no-store")]
    {
        let api = App::new(Routes::new().__route::<AnywhereRest>(crate::Methods::reads(get(|| async { "page" }))))
            .api::<ApiItems>(|items| items.route::<ApiItem>(crate::Methods::reads(get(|| async { "item" }))))
            .middleware((CdnRecaches(cache), DropsTheRoute))
            .router();
        let asked = [("accept", "application/json"), ("x-drop", "1")];
        let (status, headers, _) = from_ann(&api, "GET", "/api/items/7/more", &asked).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "api {cache:?}");
        if headers[header::CACHE_CONTROL] != own {
            wrong.push(format!("api, {cache:?}: Cache-Control {:?}", headers[header::CACHE_CONTROL]));
        }
        for name in CDN_OVERRIDES {
            if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                wrong.push(format!("api, {cache:?}: lost {name}"));
            }
        }
    }
    assert!(wrong.is_empty(), "a middleware's own 404 after it dropped the route unpolled: {wrong:#?}");
}

/// Staged middleware that runs the route and then changes its answer in place (`Greets`: a `200`
/// greeting the visitor its cookie names; `Redirects`: a `303` to a place the cookie names), or
/// drops it and answers with a `200` of its own that greets the visitor (`OwnAnswer`).
#[derive(Clone, Copy, Debug)]
enum TurnsTheAnswer {
    Greets,
    Redirects,
    OwnAnswer,
}

impl crate::Middleware for TurnsTheAnswer {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let cookie = req.headers().get(header::COOKIE).and_then(|cookie| cookie.to_str().ok()).unwrap_or("");
        let name = cookie.strip_prefix("name=").unwrap_or("stranger").to_owned();
        let mut res = next.run(req).await;
        match self {
            TurnsTheAnswer::Greets => {
                *res.status_mut() = StatusCode::OK;
                res.headers_mut().remove(header::CONTENT_TYPE);
                *res.body_mut() = Body::from(format!("Hello, {name}."));
            }
            TurnsTheAnswer::Redirects => {
                *res.status_mut() = StatusCode::SEE_OTHER;
                res.headers_mut().insert(header::LOCATION, HeaderValue::from_str(&format!("/welcome/{name}")).unwrap());
            }
            TurnsTheAnswer::OwnAnswer => {
                drop(res);
                return (StatusCode::OK, format!("Hello, {name}.")).into_response();
            }
        }
        res
    }
}

/// The router's own failure stays the router's when a staged middleware changes it in place: made
/// a `200` with the visitor's name in it, or a redirect to a place the cookie names, for an unknown
/// URL, a method the route lacks or no route has and a named post the page has none of, it goes
/// out `private` (`private, no-store` where a middleware named `no-store`) with none of the caching
/// headers a CDN reads first, to a browser and to a data client. A `200` the middleware made of
/// its own after running the route is its answer and keeps what it wrote, and so is a handler's
/// own `404` changed in place.
#[tokio::test]
async fn the_router_s_own_failure_a_middleware_changes_in_place_is_not_shared() {
    let routes = || {
        Table::new()
            .route("/", get(|| async { "home" }).post(|| async { "saved" }).named("save"))
            .route("/form", crate::router::post(|| async { "saved" }))
            .route("/gone", get(|| async { StatusCode::NOT_FOUND }))
    };
    let mut wrong = Vec::new();
    for (cache, sent, own) in [
        (None, "private, no-cache", "private, no-cache"),
        (Some("public, max-age=60"), "private, no-cache", "public, max-age=60"),
        (Some("no-store"), "private, no-store", "no-store"),
    ] {
        for how in [TurnsTheAnswer::Greets, TurnsTheAnswer::Redirects, TurnsTheAnswer::OwnAnswer] {
            let router = App::new(Routes::from(routes())).middleware((CdnRecaches(cache), how)).router();
            for (method, uri) in [("GET", "/nowhere"), ("GET", "/form"), ("PATCH", "/"), ("POST", "/?do=sell"), ("GET", "/gone")]
            {
                for accept in ["text/html", "application/json"] {
                    let asked = [("accept", accept), ("sec-fetch-site", "same-origin")];
                    let (status, headers, body) = from_ann(&router, method, uri, &asked).await;
                    let at = format!("{how:?} {method} {uri} {accept} {cache:?}");
                    if matches!(how, TurnsTheAnswer::Redirects) {
                        assert_eq!(status, StatusCode::SEE_OTHER, "{at}");
                        assert_eq!(headers[header::LOCATION], "/welcome/ann", "{at}");
                    } else {
                        assert!(status == StatusCode::OK && body == "Hello, ann.", "{at}: {status} {body}");
                    }
                    if matches!(how, TurnsTheAnswer::OwnAnswer) || uri == "/gone" {
                        if headers[header::CACHE_CONTROL] != own {
                            wrong.push(format!("{at}: its own answer, Cache-Control {:?}", headers[header::CACHE_CONTROL]));
                        }
                        for name in CDN_OVERRIDES {
                            if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                                wrong.push(format!("{at}: its own answer lost {name}"));
                            }
                        }
                    } else {
                        for what in kept_from_cdns(&headers, sent) {
                            wrong.push(format!("{at}: {what}"));
                        }
                    }
                }
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "the router's own failure changed in place, open to a CDN, or a middleware's own answer kept from one: {wrong:#?}"
    );
}

/// An extractor of an app's error page that refuses by the request's cookie: at `/gone-denied`, a
/// `403` in plain text naming the visitor (the error page then fails, and plain text goes out in
/// its place); anywhere else, a `303` to a place the cookie names.
struct WelcomesInstead;

impl<S: Send + Sync> crate::extract::FromRequestParts<S> for WelcomesInstead {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut http::request::Parts, _: &S) -> std::result::Result<Self, Response> {
        let cookie = parts.headers.get(header::COOKIE).and_then(|cookie| cookie.to_str().ok()).unwrap_or("");
        let name = cookie.strip_prefix("name=").unwrap_or("stranger");
        if parts.uri.path() == "/gone-denied" {
            return Err((StatusCode::FORBIDDEN, format!("Not for {name}.")).into_response());
        }
        let to = HeaderValue::from_str(&format!("/welcome/{name}")).unwrap();
        Err((StatusCode::SEE_OTHER, [(header::LOCATION, to)]).into_response())
    }
}

/// An app's error page whose extractor refuses ([`WelcomesInstead`]).
async fn welcoming_error_page(_: Failure, req: Req, _: WelcomesInstead) -> HtmlResult {
    req.test_page("Sorry", html! { <p>"Sorry."</p> })
}

/// An app's error page whose extractor refuses sends the refusal in the page's place, and it is
/// never shared, as a handler's extractor's refusal is not, also in place of a handler's own `404`,
/// whose error page otherwise keeps what a staged middleware wrote: a redirect to a place the
/// visitor's cookie names, and the plain text a failed error page is replaced with, go out
/// `private` (`private, no-store` where a middleware named `no-store`) with none of the caching
/// headers a CDN reads first. An error page that does not refuse keeps them, as before.
#[tokio::test]
async fn an_error_page_s_own_refusal_is_not_shared() {
    let routes = || {
        Table::new()
            .route("/gone", get(|| async { StatusCode::NOT_FOUND }))
            .route("/gone-denied", get(|| async { StatusCode::NOT_FOUND }))
    };
    let html = [("accept", "text/html")];
    let mut wrong = Vec::new();
    for (cache, sent, own) in [
        (None, "private, no-cache", "private, no-cache"),
        (Some("public, max-age=60"), "private, no-cache", "private, no-cache"),
        (Some("no-store"), "private, no-store", "no-store"),
    ] {
        let router =
            App::new(Routes::from(routes())).middleware(CdnRecaches(cache)).error_page(welcoming_error_page, ()).router();
        let (status, headers, _) = from_ann(&router, "GET", "/gone", &html).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{cache:?}");
        assert_eq!(headers[header::LOCATION], "/welcome/ann", "{cache:?}");
        for what in kept_from_cdns(&headers, sent) {
            wrong.push(format!("the error page's redirect, {cache:?}: {what}"));
        }
        let (status, headers, body) = from_ann(&router, "GET", "/gone-denied", &html).await;
        assert!(status == StatusCode::NOT_FOUND && body.contains("could not be shown"), "{cache:?}: {status} {body}");
        for what in kept_from_cdns(&headers, sent) {
            wrong.push(format!("the plain text for the failed error page, {cache:?}: {what}"));
        }
        let greeting =
            App::new(Routes::from(routes())).middleware(CdnRecaches(cache)).error_page(greeting_error_page, ()).router();
        let (status, headers, body) = from_ann(&greeting, "GET", "/gone", &html).await;
        assert!(status == StatusCode::NOT_FOUND && body.contains("Sorry, ann."), "{cache:?}: {status} {body}");
        assert_eq!(headers[header::CACHE_CONTROL], own, "{cache:?}: the error page for a handler's own 404");
        for name in CDN_OVERRIDES {
            assert_eq!(headers[name], "public, max-age=60", "{cache:?}: the error page for a handler's own 404 keeps {name}");
        }
    }
    assert!(wrong.is_empty(), "an error page's own refusal, open to a CDN: {wrong:#?}");
}

/// A handler's [`crate::Refused`] sent at another status (`Error::with_status`, a `404` in place of
/// a `403`, with and without a message for the client) drops the refusal's own form, not its
/// privacy: to a browser and to a data client it goes out `private` (`private, no-store` where a
/// middleware named `no-store`) with none of the caching headers a CDN reads first. A plain
/// `Error::not_found()` is the handler's own failure and keeps them.
#[tokio::test]
async fn a_refusal_sent_at_another_status_is_still_not_shared() {
    let hidden = |refused: crate::Refused| Err::<&'static str, Error>(Error::from(refused).with_status(StatusCode::NOT_FOUND));
    let routes = move || {
        Table::new()
            .route("/hidden", get(move || async move { hidden(crate::Refused::forbidden()) }))
            .route("/hidden-saying", get(move || async move { hidden(crate::Refused::forbidden().message("No such order")) }))
            .route("/missing", get(|| async { Err::<&'static str, Error>(Error::not_found()) }))
    };
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(Routes::from(routes())).middleware(CdnRecaches(cache)).router();
        for accept in ["text/html", "application/json"] {
            for uri in ["/hidden", "/hidden-saying"] {
                let (status, headers, body) = from_ann(&router, "GET", uri, &[("accept", accept)]).await;
                assert_eq!(status, StatusCode::NOT_FOUND, "{uri} {accept} {cache:?}");
                if accept == "application/json" {
                    let said = if uri == "/hidden" { "Not Found" } else { "No such order" };
                    assert!(body.contains(said) && !body.contains("Forbidden"), "{uri} {cache:?}: {body}");
                }
                for what in kept_from_cdns(&headers, sent) {
                    wrong.push(format!("{uri} {accept}, {cache:?}: {what}"));
                }
            }
            let (status, headers, _) = from_ann(&router, "GET", "/missing", &[("accept", accept)]).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{accept} {cache:?}");
            for name in CDN_OVERRIDES {
                assert_eq!(headers[name], "public, max-age=60", "{accept} {cache:?}: a handler's own 404 keeps {name}");
            }
        }
    }
    assert!(wrong.is_empty(), "a refusal sent at another status, open to a CDN: {wrong:#?}");
}

/// A debug build's error in place of a `NoStore` answer a browser would have shown wrongly (a page
/// with a `Refresh` header, a write redirected outside the form's `form-action`, a patch answering
/// a plain request) is `NoStore` too, whatever a staged middleware made of the answer's
/// `Cache-Control` (rewrote or took out): `private, no-store`, with none of the caching headers a
/// CDN reads first. (The middleware's other headers are the replaced answer's, which an error in
/// place of a page or a patch does not keep, so only these two are read.)
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_debug_build_s_error_in_place_of_a_no_store_answer_is_no_store() {
    #[derive(crate::view::Id)]
    struct SavedId;

    let routes = || {
        Table::new()
            .route(
                "/refresh",
                get(|req: Req| async move {
                    NoStore(req.test_page("Saving", html! { <p>"Saving"</p> }).map(|mut res| {
                        res.headers_mut().insert("refresh", HeaderValue::from_static("2"));
                        res
                    }))
                }),
            )
            .route(
                "/go",
                crate::router::post(|req: Req| async move {
                    NoStore(req.redirect::<()>(&"https://else.example/x".parse::<http::Uri>().unwrap()))
                }),
            )
            .route(
                "/patch",
                crate::router::post(|mut req: Req| async move {
                    req.mode = crate::Mode::Action; // Deliberate override: the debug guard checks the original request.
                    let patch: crate::answer::HtmlResult = req
                        .action()
                        .ok_or_else(crate::Error::not_found)
                        .and_then(|action| action.patch(html! { <p id={SavedId}>"saved"</p> }));
                    NoStore(patch)
                }),
            )
    };
    let mut wrong = Vec::new();
    for cache in [None, Some("public, max-age=60")] {
        let router = App::new(Routes::from(routes())).middleware(CdnRecaches(cache)).router();
        // No fetch metadata, as a router test sends: the write is taken for one of the app's
        // pages', so its redirect is held to that page's `form-action`.
        for (method, uri) in [("GET", "/refresh"), ("POST", "/go"), ("POST", "/patch")] {
            let (status, headers, body) = from_ann(&router, method, uri, &[("accept", "text/html")]).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{method} {uri} {cache:?}: {body}");
            if headers[header::CACHE_CONTROL] != "private, no-store" {
                wrong.push(format!("{method} {uri}, {cache:?}: Cache-Control {:?}", headers[header::CACHE_CONTROL]));
            }
            let kept: Vec<_> = CDN_OVERRIDES.into_iter().filter(|name| headers.contains_key(*name)).collect();
            if !kept.is_empty() {
                wrong.push(format!("{method} {uri}, {cache:?}: still sends {kept:?}"));
            }
        }
    }
    assert!(wrong.is_empty(), "a debug build's error in place of a NoStore answer, kept: {wrong:#?}");
}

/// A handler's own failure in plain text is its answer, as its own empty `404` is: the error page a
/// browser gets in its place keeps what a staged middleware wrote, from a route's handler and from
/// a named post's.
#[tokio::test]
async fn a_handler_s_own_plain_text_failure_page_keeps_what_a_middleware_wrote() {
    let routes = || {
        Table::new()
            .route("/check", get(|| async { (StatusCode::BAD_REQUEST, "Not checked.") }))
            .route("/", get(|| async { "home" }).post(|| async { (StatusCode::BAD_REQUEST, "Not checked.") }).named("check"))
    };
    let mut wrong = Vec::new();
    for (cache, own) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "no-store")]
    {
        let router = App::new(Routes::from(routes())).middleware(CdnRecaches(cache)).router();
        for (method, uri) in [("GET", "/check"), ("POST", "/?do=check")] {
            let asked = [("accept", "text/html"), ("sec-fetch-site", "same-origin")];
            let (status, headers, body) = from_ann(&router, method, uri, &asked).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {uri} {cache:?}: {body}");
            assert!(headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/html"), "{method} {uri}: the error page");
            if headers[header::CACHE_CONTROL] != own {
                wrong.push(format!("{method} {uri}, {cache:?}: Cache-Control {:?}", headers[header::CACHE_CONTROL]));
            }
            for name in CDN_OVERRIDES {
                if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                    wrong.push(format!("{method} {uri}, {cache:?}: lost {name}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "a handler's own plain-text failure page: {wrong:#?}");
}

/// Staged middleware that writes who is asking, by the request's cookie, as plain text on a failure
/// that has no body, reading no caller.
#[cfg(feature = "json")]
struct NamesTheFailure;

#[cfg(feature = "json")]
impl crate::Middleware for NamesTheFailure {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let cookie = req.headers().get(header::COOKIE).and_then(|cookie| cookie.to_str().ok()).unwrap_or("");
        let name = cookie.strip_prefix("name=").unwrap_or("stranger").to_string();
        let mut res = next.run(req).await;
        let failed = res.status().is_client_error() || res.status().is_server_error();
        if failed && http_body::Body::size_hint(res.body()).exact() == Some(0) {
            res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
            *res.body_mut() = Body::from(format!("Nothing here for {name}."));
        }
        res
    }
}

#[cfg(feature = "json")]
#[derive(crate::Route)]
#[route("/{*rest}")]
struct AnywhereRest<'a> {
    rest: &'a str,
}

/// The router's own failure is never shared as JSON either, also when a staged middleware wrote who
/// is asking into it: a data client's `404`, `405` and `501` from the router, and an API's `404`
/// for a path under its prefix that a route outside it matched, go out with what the middleware
/// wrote as their detail (a `4xx`'s), but `private` (`private, no-store` where it named `no-store`), with
/// none of the caching headers a CDN reads first. A handler's own `404` is its answer, under the
/// usual rules, whatever a middleware wrote on it.
#[cfg(feature = "json")]
#[tokio::test]
async fn the_router_s_own_failure_as_json_is_not_shared_whatever_a_middleware_writes_on_it() {
    let routes = || {
        Table::new()
            .route("/", get(|| async { "home" }))
            .route("/form", crate::router::post(|| async { "saved" }))
            .route("/gone", get(|| async { StatusCode::NOT_FOUND }))
    };
    let mut wrong = Vec::new();
    for (cache, sent, own) in [
        (None, "private, no-cache", "private, no-cache"),
        (Some("public, max-age=60"), "private, no-cache", "public, max-age=60"),
        (Some("no-store"), "private, no-store", "no-store"),
    ] {
        let steps = || (CdnRecaches(cache), NamesTheFailure);
        let router = App::new(Routes::from(routes())).middleware(steps()).router();
        let api = App::new(Routes::new().__route::<AnywhereRest>(crate::Methods::reads(get(|| async { "page" }))))
            .api::<ApiItems>(|items| items.route::<ApiItem>(crate::Methods::reads(get(|| async { "item" }))))
            .middleware(steps())
            .router();
        for (router, method, uri, status) in [
            (&router, "GET", "/nowhere", StatusCode::NOT_FOUND),
            (&router, "GET", "/form", StatusCode::METHOD_NOT_ALLOWED),
            (&router, "PATCH", "/", StatusCode::NOT_IMPLEMENTED),
            (&api, "GET", "/api/items/7/more", StatusCode::NOT_FOUND),
        ] {
            let (got, headers, body) = from_ann(router, method, uri, &[("accept", "application/json")]).await;
            assert_eq!(got, status, "{method} {uri} {cache:?}: {body}");
            // A 5xx's detail stays in the log.
            assert_eq!(body.contains("Nothing here for ann."), status.is_client_error(), "{method} {uri} {cache:?}: {body}");
            assert_eq!(headers[header::CONTENT_TYPE], "application/problem+json", "{method} {uri} {cache:?}");
            for what in kept_from_cdns(&headers, sent) {
                wrong.push(format!("{method} {uri}, {cache:?}: {what}"));
            }
        }
        let (status, headers, body) = from_ann(&router, "GET", "/gone", &[("accept", "application/json")]).await;
        assert!(status == StatusCode::NOT_FOUND && body.contains("Nothing here for ann."), "{cache:?}: {status} {body}");
        assert_eq!(headers[header::CACHE_CONTROL], own, "{cache:?}: a handler's own 404");
        for name in CDN_OVERRIDES {
            assert_eq!(headers[name], "public, max-age=60", "{cache:?}: a handler's own 404 keeps {name}");
        }
    }
    assert!(wrong.is_empty(), "the router's own failure as JSON, open to a CDN: {wrong:#?}");
}

/// The router's `400` for a named post none of the page's handlers is for (a `do` the page has no
/// post for, or one named twice) is no handler's answer either: sent as it is to a client that does
/// not ask for HTML, or as JSON, it is never shared, whatever a staged middleware wrote on it. A
/// named post whose handler answers `400` itself is that handler's answer, under the usual rules.
#[cfg(feature = "json")]
#[tokio::test]
async fn the_router_s_refusal_of_a_named_post_is_not_shared() {
    let routes = || {
        Table::new().route(
            "/",
            get(|| async { "home" })
                .post(|| async { "saved" })
                .named("save")
                .post(|| async { (StatusCode::BAD_REQUEST, "Not checked.") })
                .named("check"),
        )
    };
    let mut wrong = Vec::new();
    for (cache, sent, own) in [
        (None, "private, no-cache", "private, no-cache"),
        (Some("public, max-age=60"), "private, no-cache", "public, max-age=60"),
        (Some("no-store"), "private, no-store", "no-store"),
    ] {
        let router = App::new(Routes::from(routes())).middleware(CdnRecaches(cache)).router();
        for asked in
            [&[("sec-fetch-site", "same-origin")][..], &[("sec-fetch-site", "same-origin"), ("accept", "application/json")]]
        {
            for uri in ["/?do=sell", "/?do=save&do=save"] {
                let (status, headers, body) = from_ann(&router, "POST", uri, asked).await;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{uri} {asked:?} {cache:?}: {body}");
                for what in kept_from_cdns(&headers, sent) {
                    wrong.push(format!("{uri} {asked:?}, {cache:?}: {what}"));
                }
            }
            let (status, headers, body) = from_ann(&router, "POST", "/?do=check", asked).await;
            assert!(status == StatusCode::BAD_REQUEST && body.contains("Not checked."), "{asked:?} {cache:?}: {status} {body}");
            assert_eq!(headers[header::CACHE_CONTROL], own, "{asked:?} {cache:?}: a handler's own 400");
            for name in CDN_OVERRIDES {
                assert_eq!(headers[name], "public, max-age=60", "{asked:?} {cache:?}: a handler's own 400 keeps {name}");
            }
        }
    }
    assert!(wrong.is_empty(), "the router's refusal of a named post, open to a CDN: {wrong:#?}");
}

#[cfg(all(feature = "json", feature = "compress"))]
#[crate::routes]
mod kept_refused_url {
    #[route("/kept/{id}", get = kept_item)]
    pub struct Item {
        pub id: u32,
    }

    #[route("/kept/{id}/text", get = kept_text)]
    pub struct Text {
        pub id: u32,
    }
}

/// A `Public` JSON answer the app keeps as a whole body, long enough to be one it compresses.
#[cfg(all(feature = "json", feature = "compress"))]
async fn kept_item(crate::Params(at): crate::Params<kept_refused_url::Item>) -> Public<JsonResult<String>> {
    let item: JsonResult<String> = Ok(Json(format!("{} {}", at.id, "kept ".repeat(300))));
    Public::new(Duration::from_secs(60), item)
}

/// A `Public` text answer the app keeps as a whole body.
#[cfg(all(feature = "json", feature = "compress"))]
async fn kept_text(crate::Params(at): crate::Params<kept_refused_url::Text>) -> Public<String> {
    Public::new(Duration::from_secs(60), format!("{} {}", at.id, "kept ".repeat(300)))
}

/// A route whose `Public` JSON or text the app keeps answers a request its extractor refused, and
/// the router a method the route lacks (501), as for any route: never kept, and never shared,
/// whatever a staged middleware wrote, in any form, the router's JSON failure included. Asked
/// without a cookie, as a request the kept answer could take the place of is.
#[cfg(all(feature = "json", feature = "compress"))]
#[tokio::test]
async fn a_route_whose_body_is_kept_never_shares_a_refusal() {
    let mut wrong = Vec::new();
    for (cache, sent) in
        [(None, "private, no-cache"), (Some("public, max-age=60"), "private, no-cache"), (Some("no-store"), "private, no-store")]
    {
        let router = App::new(kept_refused_url::router()).middleware(CdnRecaches(cache)).router();
        // Each route's own answer is kept: the second is the kept one.
        for uri in ["/kept/7", "/kept/7/text"] {
            let (_, first) = asked_for(&router, uri, &[]).await;
            let (status, again) = asked_for(&router, uri, &[]).await;
            assert!(
                status == StatusCode::OK && !first.contains_key(header::AGE) && again.contains_key(header::AGE),
                "{uri}: {again:?}"
            );
        }
        for (method, uri, status) in [
            ("GET", "/kept/seven", StatusCode::BAD_REQUEST),
            ("GET", "/kept/seven/text", StatusCode::BAD_REQUEST),
            ("POST", "/kept/7", StatusCode::NOT_IMPLEMENTED),
        ] {
            for asked in [[("accept", "text/html")], [("accept", "text/plain")], [("accept", "application/json")]] {
                for _ in 0..2 {
                    let mut req = Request::builder().method(method).uri(uri);
                    if method == "POST" {
                        req = req.header("sec-fetch-site", "same-origin");
                    }
                    for (name, value) in asked {
                        req = req.header(name, value);
                    }
                    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
                    assert_eq!(res.status(), status, "{method} {uri} {asked:?} {cache:?}");
                    if res.headers().contains_key(header::AGE) {
                        wrong.push(format!("{method} {uri} {asked:?}, {cache:?}: kept"));
                    }
                    for what in kept_from_cdns(res.headers(), sent) {
                        wrong.push(format!("{method} {uri} {asked:?}, {cache:?}: {what}"));
                    }
                }
            }
        }
    }
    assert!(wrong.is_empty(), "a kept route's refusal, open to a CDN: {wrong:#?}");
}

/// A redirect's notice is removed by a `Set-Cookie` Corten writes on the page it was for, which
/// alone does not make the page personal; a real cookie after it still does, and the page loses the
/// caching headers a CDN reads first.
#[tokio::test]
async fn a_cookie_after_a_notice_s_removal_still_makes_the_page_personal() {
    const GONE: &str = "__Host-corten-notice=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax";
    let page = |cookies: &'static [&'static str]| {
        move |req: Req| async move {
            req.test_page("Home", html! { <p>"home"</p> }).map(|mut page| {
                for cookie in cookies {
                    page.headers_mut().append(header::SET_COOKIE, HeaderValue::from_static(cookie));
                }
                page
            })
        }
    };
    let routes = Table::new()
        .route("/gone", get(page(&[GONE])))
        .route("/gone-then-set", get(page(&[GONE, "session=abc; Path=/"])))
        .route("/set", get(page(&["session=abc; Path=/"])));
    let router = App::new(Routes::from(routes)).middleware(CdnWrites).router();
    for uri in ["/gone-then-set", "/set"] {
        assert_eq!(kept_from_cdns(&answered(&router, uri, &[]).await, "private, no-cache"), Vec::<String>::new(), "{uri}");
    }
    let headers = answered(&router, "/gone", &[]).await;
    for name in CDN_OVERRIDES {
        assert_eq!(headers[name], "public, max-age=60", "the notice's removal alone keeps {name}");
    }
}

#[tokio::test]
async fn cache_stages_keep_incoming_headers_while_the_handler_sees_middleware_edits() {
    struct Rewrite;

    impl crate::Middleware for Rewrite {
        async fn call(&self, mut req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let headers = req.headers_mut();
            headers.insert("corten", HeaderValue::from_static("nav"));
            headers.remove(header::COOKIE);
            headers.remove(header::IF_NONE_MATCH);
            let mut res = next.run(req).await;
            assert_eq!(res.status(), StatusCode::OK, "revalidation happens outside middleware");
            res.headers_mut().insert("x-saw-answer", HeaderValue::from_static("yes"));
            res
        }
    }

    let routes = Table::new().route(
        "/",
        get(|req: Req, headers: http::HeaderMap| async move {
            assert_eq!(req.mode, Mode::Navigation);
            assert!(!headers.contains_key(header::COOKIE));
            assert!(!headers.contains_key(header::IF_NONE_MATCH));
            (Cache::public(std::time::Duration::from_secs(60)), "answer")
        }),
    );
    let router = App::new(Routes::from(routes)).middleware(Rewrite).router();
    let send = |req: http::request::Builder| router.clone().oneshot(req.body(Body::empty()).unwrap());
    let first = send(Request::head("/")).await.unwrap();
    assert_eq!(first.headers()[header::CACHE_CONTROL], "public, max-age=60", "the incoming mode was a document");
    let tag = first.headers()[header::ETAG].clone();
    let cached = send(Request::get("/").header(header::COOKIE, "session=abc").header(header::IF_NONE_MATCH, tag)).await.unwrap();
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(cached.headers()[header::CACHE_CONTROL], "private, no-cache", "the incoming request carried a cookie");
    assert_eq!(cached.headers()["x-saw-answer"], "yes");
}

/// A `Public` answer with a header of the app's keeps it, and is compressed and shared as one
/// without it; a failure does not get it.
#[tokio::test]
async fn a_public_answer_takes_a_header_and_is_still_compressed() {
    use crate::answer::{Link, XRobotsTag};
    use crate::http::HeaderValue;
    let text = "# Example\n".repeat(400);
    let body = text.clone();
    let router = App::new(Routes::from(
        Table::new()
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

#[tokio::test]
async fn a_page_get_needs_an_explicit_coding_for_an_unrequested_tag() {
    let router = App::new(Routes::from(self::routes())).router();
    for (encoding, tagged) in [
        (Some("identity"), false),
        (None, false),
        (Some("identity;q=1, gzip;q=0"), false),
        (Some("gzip, br"), true),
        (Some("gzip;Q=0"), false),
        (Some("br;q=0.000"), false),
        (Some("*"), !cfg!(feature = "compress")),
        (Some("*;q=0"), false),
        (Some("*;q=0, gzip;q=0.001"), true),
        (Some("gzip;q=0, *;q=0.500"), !cfg!(feature = "compress")),
        (Some(""), false),
        (Some("gzip;q=bogus"), false),
        (Some("invalid coding"), false),
        (Some("deflate"), !cfg!(feature = "compress")),
    ] {
        let mut req = Request::builder().uri("/");
        if let Some(encoding) = encoding {
            req = req.header(header::ACCEPT_ENCODING, encoding);
        }
        let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!((res.status(), res.headers().contains_key(header::ETAG)), (StatusCode::OK, tagged), "{encoding:?}");
    }
}

#[tokio::test]
async fn a_page_head_has_a_validator_for_a_same_length_change() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let changed = Arc::new(AtomicBool::new(false));
    let price = changed.clone();
    let routes = Table::new().route(
        "/price",
        get(move || {
            let body = if price.load(Ordering::Relaxed) { "<p>$20</p>" } else { "<p>$10</p>" };
            async move { Public::new(Duration::from_secs(60), crate::Media::new("text/html", body)) }
        }),
    );
    let router = App::new(Routes::from(routes)).router();
    let ask = |method, tag: Option<&http::HeaderValue>| {
        let mut req = Request::builder().method(method).uri("/price").header(header::ACCEPT_ENCODING, "identity");
        if let Some(tag) = tag {
            req = req.header(header::IF_NONE_MATCH, tag);
        }
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };

    let (stored, body) = ask(http::Method::GET, None).await.unwrap().into_parts();
    assert_eq!(stored.status, StatusCode::OK);
    assert_eq!(stored.headers[header::CACHE_CONTROL], "public, max-age=60");
    assert_eq!(body.collect().await.unwrap().to_bytes(), "<p>$10</p>");
    assert!(!stored.headers.contains_key(header::ETAG));
    assert!(!stored.headers.contains_key(header::LAST_MODIFIED));
    let before = ask(http::Method::HEAD, None).await.unwrap();

    changed.store(true, Ordering::Relaxed);
    let (head, body) = ask(http::Method::HEAD, None).await.unwrap().into_parts();
    assert_eq!(head.status, StatusCode::OK);
    // The length the stored `GET` was sent with, which the server wrote from its body's size.
    assert_eq!(head.headers[header::CONTENT_LENGTH], "<p>$10</p>".len().to_string());
    assert!(body.collect().await.unwrap().to_bytes().is_empty());
    // RFC 9111 section 4.3.5: equal lengths cannot freshen the stored GET if HEAD has a tag it lacks.
    let tag = head.headers.get(header::ETAG).expect("an untagged HEAD could freshen the old body");
    assert!(tag.as_bytes().starts_with(b"W/"));
    assert_ne!(tag, &before.headers()[header::ETAG]);

    let (revalidated, body) = ask(http::Method::GET, Some(tag)).await.unwrap().into_parts();
    assert_eq!(revalidated.status, StatusCode::NOT_MODIFIED);
    assert_eq!(&revalidated.headers[header::ETAG], tag);
    assert!(body.collect().await.unwrap().to_bytes().is_empty());
}

/// A page's `GET` and `HEAD` carry a weak tag of the body it rendered and its `corten-*`
/// headers, and one the client names in `If-None-Match` is answered `304` with no body (and is
/// not compressed): the same tag whether the body is compressed or not, another for another mode
/// or another `corten-*` header; a `304` still sets the page's cookie and varies as its `200`.
/// A `GET` that does not explicitly accept a coding is tagged only when it sends
/// `If-None-Match`; `HEAD` does not need either. A file compression sends as it is is tagged too. Nothing else is
/// tagged: a body with this request's nonce or a submit key drawn for it, an answer nothing may
/// keep or that is immutable, one with a tag or an encoding of its own, a stream, a relayed page,
/// an error, a write, an API's answer, the runtime.
#[tokio::test]
async fn a_page_s_get_is_tagged_and_a_tag_the_client_has_is_answered_not_modified() {
    async fn send(router: Router, method: &str, uri: &str, headers: &[(&str, &str)]) -> (StatusCode, http::HeaderMap, Vec<u8>) {
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
        req.action()
            .ok_or_else(crate::Error::not_found)?
            .patch(html! { <form id={MsgId} method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> })
    }
    async fn keyed_rendered(req: Req) -> HtmlResult {
        let form = req.rendered(html! { <form method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> });
        let placed = &form;
        req.test_page("Keyed", html! { {placed} })
    }
    async fn template_keyed_page(req: Req) -> HtmlResult {
        req.test_page(
            "Keyed",
            html! {
                <template><form method="post">{crate::SubmitKey::template_field(KeyedWrite::FIELDS.submit)}</form></template>
            },
        )
    }
    async fn plain_patch(req: Req) -> HtmlResult {
        req.action().ok_or_else(crate::Error::not_found)?.patch(html! { <p id={MsgId}>"read again"</p> })
    }
    fn html(extra: &[(&'static str, &'static str)]) -> crate::response::Response {
        use crate::response::IntoResponse;
        let mut res = ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], "<p>same</p>").into_response();
        for (name, value) in extra {
            res.headers_mut().insert(*name, http::HeaderValue::from_static(value));
        }
        res
    }
    let png: &'static [u8] = b"\x89PNG\r\n\x1a\n";
    let routes = Table::new()
        .route("/big", get(big_policy_page))
        .route("/inline", get(inline_page))
        .route("/cookie", get(cookie_page))
        .route("/kept", get(kept_page))
        .route("/keyed", get(keyed_page))
        .route("/keyed-patch", get(keyed_patch))
        .route("/keyed-rendered", get(keyed_rendered))
        .route("/template-keyed", get(template_keyed_page))
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
                let chunk = Ok::<_, std::convert::Infallible>(bytes::Bytes::from_static(b"<p>streamed</p>"));
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
    let tag_of = |headers: &http::HeaderMap| headers.get("etag").map(|v| v.to_str().unwrap().to_string());

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
    assert!(!headers.contains_key("etag"), "{headers:?}");
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
    let vary = |h: &http::HeaderMap| h.get_all("vary").iter().map(|v| v.to_str().unwrap().to_string()).collect::<Vec<_>>();
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

    // A template's submit key field holds no key (the runtime gives a copy one when it is sent),
    // so nothing was drawn for this request and the page is tagged.
    let (status, headers, _) = send(router(), "GET", "/template-keyed", &[]).await;
    let template_tag = tag_of(&headers).expect("a page with only a template's key field is tagged");
    assert_eq!(status, StatusCode::OK);
    let (status, ..) = send(router(), "GET", "/template-keyed", &[("if-none-match", &template_tag)]).await;
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

// ---- The pages the app keeps (`crate::kept`) ----

/// One request's answer, whole.
async fn fetch(
    router: &Router,
    method: &str,
    uri: &str,
    headers: &[(&'static str, &str)],
) -> (StatusCode, HeaderMap, bytes::Bytes) {
    let mut req = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let (parts, body) = res.into_parts();
    (parts.status, parts.headers, body.collect().await.unwrap().to_bytes())
}

/// How many times a route's handler ran.
#[derive(Clone, Default)]
struct Runs(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Runs {
    fn ran(&self) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    fn count(&self) -> usize {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// A page for everyone for a minute at `/`, large enough to compress, whose handler counts its
/// runs; writes to it that go through (`POST`) and that fail (`PUT`), and one elsewhere that
/// redirects to it. The page's route is made as an app's are (`corten::get`), which is where an
/// answer is known to be `Public`.
fn kept_routes(runs: &Runs) -> Table {
    let minute = Duration::from_secs(60);
    let runs = runs.clone();
    let page = move |req: Req| {
        runs.ran();
        async move {
            let text = "kept ".repeat(400);
            Public::new(minute, req.test_page_for("Kept", html! { <p>{text}</p> }))
        }
    };
    Table::new()
        .route(
            "/",
            crate::route::get(page)
                .0
                .post(|| async { StatusCode::NO_CONTENT })
                .put(|| async { Err::<StatusCode, Error>(Error::status(StatusCode::BAD_REQUEST)) }),
        )
        .route("/saved", crate::router::post(|req: Req| async move { req.redirect::<ForOne>(&Root) }))
}

/// A `Public` page's whole document is made once for its lifetime: the next request that shows
/// nothing about who asks gets the same answer with its age, and the handler does not run. A
/// request the page could differ for is the handler's, and does not take the kept one's place.
#[tokio::test]
async fn a_public_page_is_kept_and_given_again_in_its_handler_s_place() {
    let runs = Runs::default();
    let router = App::new(Routes::from(kept_routes(&runs))).router();
    let (status, first, body) = fetch(&router, "GET", "/", &[]).await;
    assert_eq!((status, runs.count()), (StatusCode::OK, 1));
    assert!(!first.contains_key(header::AGE), "the handler's own answer: {first:?}");
    assert_eq!(first[header::CACHE_CONTROL], "public, max-age=60");

    let (status, mut again, same) = fetch(&router, "GET", "/", &[]).await;
    assert_eq!((status, runs.count()), (StatusCode::OK, 1), "the kept page, not the handler");
    // Line for line, in the order the handler's answer was written in.
    let lines = |headers: &http::HeaderMap| {
        headers
            .iter()
            .filter(|(name, _)| *name != header::AGE)
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(lines(&again), lines(&first));
    assert_eq!(again.remove(header::AGE).expect("a kept answer says how old it is"), "0");
    assert_eq!(again, first, "every other header as the handler's answer had it");
    assert_eq!(same, body);

    // What the page could differ for, or is not the whole document: the handler answers.
    let mut ran = 1;
    for asked in [
        ("cookie", "session=abc"),
        ("cookie", "corten-zone=America/Chicago; session=abc"),
        ("authorization", "Bearer t"),
        ("corten", "nav"),
        ("accept", "application/json"),
        ("corten-notice", "saved"),
        ("last-event-id", "4"),
        ("content-length", "0"),
        ("transfer-encoding", "chunked"),
    ] {
        let (_, headers, _) = fetch(&router, "GET", "/", &[asked]).await;
        ran += 1;
        assert_eq!(runs.count(), ran, "{asked:?}");
        assert!(!headers.contains_key(header::AGE), "{asked:?}");
    }
    let (_, headers, _) = fetch(&router, "HEAD", "/", &[]).await;
    assert!(runs.count() == ran + 1 && !headers.contains_key(header::AGE), "a HEAD is the handler's");
    ran += 1;
    for _ in 0..2 {
        let (status, headers, _) = fetch(&router, "GET", "http://localhost/", &[]).await;
        ran += 1;
        assert!(status == StatusCode::OK && runs.count() == ran, "a URL that names its host is a proxy's");
        assert!(!headers.contains_key(header::AGE), "{headers:?}");
    }
    // None of them took the kept page's place. A cookie that says only where the visitor is does
    // not make the request someone's (a `Public` page is written in UTC), and a request's own
    // `Cache-Control` does not make the app render again.
    for asked in [
        &[][..],
        &[("cookie", "corten-zone=America/Chicago")],
        &[("accept", "text/html,*/*;q=0.8")],
        &[("cache-control", "no-cache")],
    ] {
        let (_, headers, same) = fetch(&router, "GET", "/", asked).await;
        assert_eq!(runs.count(), ran, "{asked:?}");
        assert!(headers.contains_key(header::AGE) && same == body, "{asked:?}");
    }
    // Another query is another page.
    fetch(&router, "GET", "/?page=2", &[]).await;
    fetch(&router, "GET", "/?page=2", &[]).await;
    assert_eq!(runs.count(), ran + 1);
}

/// A `Public` body whose head has `names` names: `Public`'s own and as many of `x-0`, `x-1`, ..
/// as make up the rest. An app's handler cannot name that many (`Public::header` takes a name a
/// type gives), so the route is made by hand as a `Public` body's is.
#[derive(Clone)]
struct Named {
    names: usize,
    runs: Runs,
}

impl crate::handler::Handler<(), ()> for Named {
    fn keeps(&self) -> Option<crate::kept::Shape> {
        Some(crate::kept::Shape::Body)
    }

    fn call(self, _: Request, _: ()) -> impl std::future::Future<Output = crate::response::Response> + Send + 'static {
        self.runs.ran();
        async move {
            let mut res = Public::new(Duration::from_secs(60), "named ".repeat(300)).into_response();
            let headers = res.headers_mut();
            for n in 0.. {
                if headers.keys_len() >= self.names {
                    break;
                }
                headers.append(header::HeaderName::from_bytes(format!("x-{n}").as_bytes()).unwrap(), HeaderValue::from(n));
            }
            res
        }
    }
}

/// Asks for a `Named` route of `names` names three times, with a middleware that takes 64 of
/// them off after the handler when `thin` (as an app's may), checking each answer; returns
/// whether the answer was kept, which says how the second and third were checked.
async fn named_three_times(names: usize, thin: bool) -> bool {
    /// Takes 64 of the names off after the handler.
    struct Thin;

    impl crate::Middleware for Thin {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let mut res = next.run(req).await;
            for n in 0..64 {
                res.headers_mut().remove(format!("x-{n}").as_str());
            }
            res
        }
    }
    let runs = Runs::default();
    let routes = Table::new().route("/", crate::router::get(Named { names, runs: runs.clone() })).route(
        "/held",
        crate::router::get(|signal: crate::Signal| async move {
            signal.shared().and_then(|shared| shared.kept.as_ref()).map_or(0, |kept| kept.bytes()).to_string()
        }),
    );
    let app = App::new(Routes::from(routes)).kept_answers(1 << 30);
    let router = if thin { app.middleware(Thin).router() } else { app.router() };
    let held = || async { String::from_utf8(fetch(&router, "GET", "/held", &[]).await.2.to_vec()).unwrap() != "0" };
    let lines = |headers: &HeaderMap| {
        headers.iter().filter(|(name, _)| *name != header::AGE).map(|(n, v)| (n.clone(), v.clone())).collect::<Vec<_>>()
    };
    let (status, first, body) = fetch(&router, "GET", "/", &[]).await;
    assert!(status == StatusCode::OK && runs.count() == 1, "{names}: {status}");
    let kept = held().await;
    for again in 2..=3 {
        let (status, headers, same) = fetch(&router, "GET", "/", &[]).await;
        assert_eq!((status, &same), (StatusCode::OK, &body), "{names}");
        // Every line but `Age` as the first answer had it, in its order.
        assert!(lines(&headers) == lines(&first), "{names}");
        if kept {
            assert!(headers.contains_key(header::AGE) && runs.count() == 1, "{names}: given again");
        } else {
            assert!(!headers.contains_key(header::AGE) && runs.count() == again, "{names}: the handler's");
        }
        assert_eq!(held().await, kept, "{names}: kept as it was");
    }
    kept
}

/// The most names a map holds: `http` grows one no further, and its `reserve` and `insert`
/// panic past them.
fn most_names() -> usize {
    let name = |n: usize| header::HeaderName::from_bytes(format!("x-{n}").as_bytes()).unwrap();
    let mut map = HeaderMap::new();
    while map.try_append(name(map.len()), HeaderValue::from(0)).is_ok() {}
    map.keys_len()
}

/// A head of the most names a kept answer has (`crate::kept::NAMES`) is kept and given again as
/// it was made; one of more is its handler's for every request.
#[tokio::test]
async fn a_kept_answers_head_has_at_most_its_names() {
    assert!(named_three_times(crate::kept::NAMES, false).await);
    assert!(!named_three_times(crate::kept::NAMES + 1, false).await);
}

/// A head of as many names as the security headers (seven, with no `Vary` and no HSTS) have room
/// beside on the handler's answer is the handler's for every request: given again, its `Age`
/// took the room they need, and the request panicked.
#[tokio::test]
async fn a_head_near_the_most_names_a_map_holds_is_not_given_again_without_room_for_the_stages() {
    assert!(!named_three_times(most_names() - 7, false).await);
}

/// A head of the most names a map holds, which no answer given again has room beside for its
/// `Age`, is not kept (a middleware of the app's makes room for the stages after it): it was
/// kept again by every request that could not be given it.
#[tokio::test]
async fn a_head_that_could_not_be_given_again_is_not_kept_again_by_every_request() {
    assert!(!named_three_times(most_names(), true).await);
}

/// While the store has room a page is kept the first time it is made. Once it is full, keeping
/// one drops another, so a page is kept from the second time its URL is asked for and a URL
/// asked for once takes no page's room.
#[tokio::test]
async fn a_full_store_keeps_a_page_from_the_second_time_its_url_is_asked_for() {
    let runs = Runs::default();
    let router = App::new(Routes::from(kept_routes(&runs))).kept_answers(64 << 10).router();
    let kept = |uri: String| {
        let router = router.clone();
        async move { fetch(&router, "GET", &uri, &[]).await.1.contains_key(header::AGE) }
    };
    // With room, the second request for each URL is given the page the first one made.
    let mut room = 0;
    while kept(format!("/?n={room}")).await || kept(format!("/?n={room}")).await {
        room += 1;
        assert!(room < 100, "the store never filled");
    }
    assert!(room > 5, "{room} pages were kept the first time");
    // The store is full: the URL just asked for twice was made twice, and is kept now.
    assert_eq!(runs.count(), room + 2);
    assert!(kept(format!("/?n={room}")).await && runs.count() == room + 2, "kept from its second ask");
    // URLs asked for once are made and not kept, but for one whose mark is another's: twice as
    // many as the store holds, which kept one by one would drop every page, drop next to none.
    for once in 0..room * 2 {
        kept(format!("/?once={once}")).await;
    }
    assert_eq!(runs.count(), room * 3 + 2);
    let mut still = 0;
    for n in 0..=room {
        still += usize::from(kept(format!("/?n={n}")).await);
    }
    assert!(still + 2 > room, "{still} of {} pages are kept after a walk over new URLs", room + 1);
    // And a new URL is kept by its second request: the third is given the page.
    let made = runs.count();
    for again in 0..8 {
        let uri = format!("/?again={again}");
        kept(uri.clone()).await;
        kept(uri.clone()).await;
        assert!(kept(uri).await, "kept by its second request at the latest");
    }
    let twice = runs.count() - made - 8;
    assert!(twice >= 6, "{twice} of 8 new URLs were made twice");
}

/// A kept page stands where the handler does: every middleware runs for the request it answers,
/// one that refuses still refuses, and each sees the `200` with the whole body, also when the
/// client gets the `304`.
#[tokio::test]
async fn a_kept_page_still_passes_every_middleware() {
    struct Numbered(Runs);

    impl crate::Middleware for Numbered {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            self.0.ran();
            let mut res = next.run(req).await;
            assert_eq!(res.status(), StatusCode::OK, "revalidation happens outside middleware");
            assert!(http_body::Body::size_hint(res.body()).exact().is_some_and(|size| size > 2000), "the whole body");
            res.headers_mut().insert("x-request", HeaderValue::from(self.0.count()));
            res
        }
    }

    let (runs, requests) = (Runs::default(), Runs::default());
    let router =
        App::new(Routes::from(kept_routes(&runs))).middleware((Step("limit", true), Numbered(requests.clone()))).router();
    // A coding asked for, so the page is tagged (`request_tags`).
    let coded = [("accept-encoding", "gzip")];
    let (_, first, body) = fetch(&router, "GET", "/", &coded).await;
    let (_, second, same) = fetch(&router, "GET", "/", &coded).await;
    assert_eq!((runs.count(), requests.count()), (1, 2), "one render, two requests through the middleware");
    assert_eq!((first["x-request"].to_str().unwrap(), second["x-request"].to_str().unwrap()), ("1", "2"));
    assert!(second.contains_key(header::AGE) && same == body);
    let (status, _, _) = fetch(&router, "GET", "/", &[("x-flood", "1")]).await;
    assert_eq!((status, runs.count()), (StatusCode::TOO_MANY_REQUESTS, 1), "a refusal is not passed by");
    let tag = first[header::ETAG].to_str().unwrap();
    assert_eq!(second[header::ETAG], tag, "the kept page has the handler's tag");
    let (status, headers, none) = fetch(&router, "GET", "/", &[("if-none-match", tag)]).await;
    assert_eq!((status, runs.count(), requests.count()), (StatusCode::NOT_MODIFIED, 1, 3));
    assert!(none.is_empty() && headers["x-request"] == "3", "{headers:?}");
}

/// A kept page's tag and its bytes in every coding are those the handler's own answer has in an
/// app that keeps none: only who makes them, and how often, differs.
#[tokio::test]
async fn a_kept_page_has_the_tag_and_the_coded_bytes_of_the_handler_s_answer() {
    let (runs, each) = (Runs::default(), Runs::default());
    let kept = App::new(Routes::from(kept_routes(&runs))).router();
    let none = App::new(Routes::from(kept_routes(&each))).kept_answers(0).router();
    for coding in ["zstd", "br", "gzip", "identity", "br", "zstd", "gzip"] {
        let asked = [("accept-encoding", coding)];
        let (_, made, body) = fetch(&none, "GET", "/", &asked).await;
        let (_, mut given, same) = fetch(&kept, "GET", "/", &asked).await;
        given.remove(header::AGE);
        assert_eq!(given, made, "{coding}");
        assert!(same == body, "{coding}: the same bytes");
        // Not made again for the next request: the very bytes the first one was sent, which is
        // how the stages after the handler know the kept page's hash and coded forms are theirs.
        let (_, _, again) = fetch(&kept, "GET", "/", &asked).await;
        assert_eq!(again.as_ptr(), same.as_ptr(), "{coding}: the bytes made once");
        let (_, _, each) = fetch(&none, "GET", "/", &asked).await;
        assert_ne!(each.as_ptr(), body.as_ptr(), "{coding}: an app that keeps none makes them each time");
        #[cfg(feature = "compress")]
        assert_eq!(given.get(header::CONTENT_ENCODING).map(|v| v.to_str().unwrap()), (coding != "identity").then_some(coding));
        // A request that asks for no coding and names no tag gets none (`request_tags`).
        assert_eq!(given.contains_key(header::ETAG), coding != "identity", "{coding}");
        if let Some(tag) = given.get(header::ETAG) {
            let asked = [("accept-encoding", coding), ("if-none-match", tag.to_str().unwrap())];
            assert_eq!(fetch(&kept, "GET", "/", &asked).await.0, StatusCode::NOT_MODIFIED, "{coding}");
        }
    }
    assert_eq!((runs.count(), each.count()), (1, 14), "one render for all of them");
}

/// A write drops what is kept at its path, whatever the query and whatever it is answered (the
/// router's own answer for a method the path has no handler for included), and one that goes
/// through drops the place it redirects to. No other path's page is dropped.
#[tokio::test]
async fn a_write_drops_the_pages_kept_at_its_path() {
    let (runs, read) = (Runs::default(), Runs::default());
    let counted = read.clone();
    // A page with no write of its own, in an app that has a `POST` elsewhere.
    let only_read = move |req: Req| {
        counted.ran();
        async move { Public::new(Duration::from_secs(60), req.test_page_for("Read", html! { <p>"read"</p> })) }
    };
    let routes = kept_routes(&runs).route("/read", crate::route::get(only_read).0);
    let router = App::new(Routes::from(routes)).router();
    let same_origin = [("sec-fetch-site", "same-origin")];
    let reads = |router: Router| async move {
        fetch(&router, "GET", "/", &[]).await;
        fetch(&router, "GET", "/", &[]).await;
    };
    reads(router.clone()).await;
    assert_eq!(runs.count(), 1);
    // A write another site sent is refused before the app's middleware and is not counted, or
    // any site could have the app's pages made again through its visitors' browsers.
    let cross = [("origin", "https://other.example"), ("sec-fetch-site", "cross-site")];
    let (status, _, _) = fetch(&router, "POST", "/", &cross).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    reads(router.clone()).await;
    assert_eq!(runs.count(), 1, "a write another site sent");
    // The router's own answers: the route has no `POST` (405), and no route has a `DELETE` (501).
    // A middleware may have met either, so each counts as any write does.
    assert!(!fetch(&router, "GET", "/read", &[]).await.1.contains_key(header::AGE));
    assert!(fetch(&router, "GET", "/read", &[]).await.1.contains_key(header::AGE));
    let (status, _, _) = fetch(&router, "POST", "/read", &same_origin).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert!(!fetch(&router, "GET", "/read", &[]).await.1.contains_key(header::AGE));
    assert!(fetch(&router, "GET", "/", &[]).await.1.contains_key(header::AGE), "and that path alone");
    assert_eq!((runs.count(), read.count()), (1, 2), "a write to a path with no handler for it");
    let (status, _, _) = fetch(&router, "DELETE", "/", &same_origin).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    reads(router.clone()).await;
    assert_eq!(runs.count(), 2, "a write in a method no route has");
    let (status, _, _) = fetch(&router, "PUT", "/", &same_origin).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    reads(router.clone()).await;
    assert_eq!(runs.count(), 3, "a write its handler refused, which may have saved first");
    let (status, _, _) = fetch(&router, "POST", "/", &same_origin).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    reads(router.clone()).await;
    assert_eq!(runs.count(), 4, "a write to the page's URL");
    let (status, headers, _) = fetch(&router, "POST", "/saved", &same_origin).await;
    assert_eq!((status, headers[header::LOCATION].to_str().unwrap()), (StatusCode::SEE_OTHER, "/"));
    reads(router.clone()).await;
    assert_eq!(runs.count(), 5, "a write that redirects to it");
    // As the runtime's form submit is answered: the place is in `corten-location`.
    let (_, headers, _) = fetch(&router, "POST", "/saved", &[("sec-fetch-site", "same-origin"), ("corten", "action")]).await;
    assert_eq!(headers["corten-location"], "/", "{headers:?}");
    reads(router.clone()).await;
    assert_eq!(runs.count(), 6);
    // Every page at the path: a named post is `?do=name` there, and the page has other queries.
    fetch(&router, "GET", "/?page=2", &[]).await;
    assert_eq!(runs.count(), 7);
    let (status, _, _) = fetch(&router, "POST", "/?do=save", &same_origin).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    fetch(&router, "GET", "/?page=2", &[]).await;
    reads(router.clone()).await;
    assert_eq!(runs.count(), 9, "the page and its other query, both made again");
    assert!(fetch(&router, "GET", "/read", &[]).await.1.contains_key(header::AGE), "and no other path's page");
}

#[tokio::test]
async fn an_absolute_form_write_drops_the_page_named_by_a_matching_location() {
    let runs = Runs::default();
    let location =
        |url: &'static str| crate::router::post(move || async move { (StatusCode::SEE_OTHER, [(header::LOCATION, url)]) });
    let routes = kept_routes(&runs)
        .route("/update", location("https://catalog.example/"))
        .route("/elsewhere", location("https://proxy.example/"));
    let router = App::new(Routes::from(routes)).policy(crate::security::Policy::new().host("catalog.example")).router();
    let host = [("host", "catalog.example")];
    assert_eq!(fetch(&router, "GET", "/", &host).await.0, StatusCode::OK);
    assert!(fetch(&router, "GET", "/", &host).await.1.contains_key(header::AGE));
    let headers = [("host", "proxy.example"), ("content-type", "application/json")];
    let (status, _, _) = fetch(&router, "POST", "https://catalog.example/update", &headers).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(fetch(&router, "GET", "/", &host).await.0, StatusCode::OK);
    assert_eq!(runs.count(), 2, "the write's Location names the target authority, so the page is made again");
    assert_eq!(fetch(&router, "POST", "https://catalog.example/elsewhere", &headers).await.0, StatusCode::SEE_OTHER);
    assert!(fetch(&router, "GET", "/", &host).await.1.contains_key(header::AGE));
    assert_eq!(runs.count(), 2, "a Location on the Host line's authority alone does not drop this page");
}

/// What a write's handler finds: whether the app has a store of kept pages, and whether the
/// write is counted, for its path or with the writes from before the app counts by path.
async fn store_and_count(signal: crate::Signal) -> String {
    let store = signal.shared().is_some_and(|shared| shared.kept.is_some());
    format!("store={store} counted={}", signal.counts_a_write())
}

/// Whether an app keeps pages is known when its router is made: one with no `Public` page has no
/// store, so its writes are not counted, while one with a `Public` page in its own routes or in an
/// area counts every write and still drops the page a write goes to.
#[tokio::test]
async fn only_an_app_with_a_public_page_counts_its_writes() {
    let same_origin = [("sec-fetch-site", "same-origin")];
    let edit = || Table::new().route("/items/{id}/edit", crate::router::get(|| async { "edit" }).post(store_and_count));
    let write = |router: Router| async move {
        let (status, _, body) = fetch(&router, "POST", "/items/7/edit", &same_origin).await;
        assert_eq!(status, StatusCode::OK);
        String::from_utf8(body.to_vec()).unwrap()
    };
    let none = App::new(Routes::from(edit())).router();
    assert_eq!(write(none).await, "store=false counted=false", "no Public page");

    let runs = Runs::default();
    let router = App::new(Routes::from(edit().merge(kept_routes(&runs)))).router();
    assert_eq!(write(router.clone()).await, "store=true counted=true", "a Public page in the app's routes");
    fetch(&router, "GET", "/", &[]).await;
    assert!(fetch(&router, "GET", "/", &[]).await.1.contains_key(header::AGE));
    assert_eq!(fetch(&router, "POST", "/", &same_origin).await.0, StatusCode::NO_CONTENT);
    assert!(!fetch(&router, "GET", "/", &[]).await.1.contains_key(header::AGE), "the write dropped it");
    assert_eq!(runs.count(), 2);

    let area = App::new(Routes::from(edit())).area(shelf_url::area).router();
    assert_eq!(write(area).await, "store=true counted=true", "a Public page in an area");
    let off = App::new(Routes::from(edit().merge(kept_routes(&runs)))).kept_answers(0).router();
    assert_eq!(write(off).await, "store=false counted=false", "an app that keeps none");
    // Under `corten dev` the store stands, keeping nothing, so what decides a release build's
    // keeping runs as it does there (a page a write is made under says so).
    let dev = App::new(Routes::from(edit().merge(kept_routes(&runs)))).dev(true).router();
    assert_eq!(write(dev.clone()).await, "store=true counted=true", "under corten dev");
    fetch(&dev, "GET", "/", &[]).await;
    assert!(!fetch(&dev, "GET", "/", &[]).await.1.contains_key(header::AGE), "and nothing is kept under corten dev");

    // A `Public` whole body is kept from a size, in every build: an app whose only `Public`
    // route answers one has a store, whether or not the body turns out large enough.
    let words = || async { Public::new(Duration::from_secs(60), "words") };
    let body = App::new(Routes::from(edit().route("/words", crate::route::get(words).0))).router();
    assert_eq!(write(body).await, "store=true counted=true", "a Public body alone");
    // A file is a whole body too, kept or not: which is known only as each is made.
    let file = || async { Public::new(Duration::from_secs(60), crate::Media::new("image/png", &[0x89u8; 4][..])) };
    let filed = App::new(Routes::from(edit().route("/mark.png", crate::route::get(file).0))).router();
    assert_eq!(write(filed).await, "store=true counted=true", "a Public file alone");
}

static COUNTER_RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A layout read the counter's route says its page gives, so none is started for it.
struct CounterCount;

impl crate::LayoutRead for CounterCount {
    type Value = u32;

    fn start(&self, _: &http::request::Parts) -> Option<impl std::future::Future<Output = u32> + Send + 'static> {
        None::<std::future::Ready<u32>>
    }

    fn view(count: &u32) -> impl Render + '_ {
        html! { {*count} }
    }
}

#[crate::routes]
mod counter_url {
    #[route("/counter", any = counter_page, gives(CounterCount))]
    pub struct Counter;
}

async fn counter_page(req: Req) -> Public<HtmlResult> {
    COUNTER_RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Public::new(Duration::from_secs(60), req.test_page_for("Counter", html! { <p>"counter"</p> }))
}

/// The only page an app keeps can be one an `any = ..` route that gives a layout read answers,
/// at the path of a write that keeps none: the two are one route, which still keeps the page
/// (`GET` reaches the `any` handler) and counts the write, which drops it.
#[tokio::test]
async fn a_kept_page_from_any_with_gives_merged_beside_a_write_is_kept_and_dropped() {
    use std::sync::atomic::Ordering;
    let typed = counter_url::router();
    // The write on the left and the kept page's route on the right, as `Table::merge` places them.
    let table = Table::new().route("/counter", crate::router::post(store_and_count)).merge(typed.0);
    let router = App::new(Routes(table, typed.1, typed.2)).router();
    fetch(&router, "GET", "/counter", &[]).await;
    let (status, headers, _) = fetch(&router, "GET", "/counter", &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.contains_key(header::AGE), "kept: {headers:?}");
    assert_eq!(COUNTER_RUNS.load(Ordering::Relaxed), 1);
    let (status, _, body) = fetch(&router, "POST", "/counter", &[("sec-fetch-site", "same-origin")]).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, &b"store=true counted=true"[..]));
    let (_, headers, _) = fetch(&router, "GET", "/counter", &[]).await;
    assert!(!headers.contains_key(header::AGE), "the write dropped it: {headers:?}");
    assert_eq!(COUNTER_RUNS.load(Ordering::Relaxed), 2, "made again");
}

/// A write counts for its path however it ends: one that
/// failed after it may have written, one whose client left, and work that outlived its request.
/// The path is the same page's however it is escaped.
#[tokio::test]
async fn a_write_that_does_not_end_with_its_answer_still_drops_its_page() {
    let (runs, writes, release) = (Runs::default(), Runs::default(), std::sync::Arc::new(tokio::sync::Notify::new()));
    let counted = runs.clone();
    let page = move |req: Req| {
        counted.ran();
        async move { Public::new(Duration::from_secs(60), req.test_page_for("Notes", html! { <p>"notes"</p> })) }
    };
    let (began, wait) = (writes.clone(), release.clone());
    // Writes, and is still at work when its client leaves.
    let slow = move |signal: crate::Signal| {
        let (began, wait) = (began.clone(), wait.clone());
        async move {
            let work = move |_| async move {
                began.ran();
                wait.notified().await;
            };
            signal.finish(work).await;
            StatusCode::NO_CONTENT
        }
    };
    let failed = || async { Err::<StatusCode, Error>(Error::status(StatusCode::INTERNAL_SERVER_ERROR)) };
    let routes = Table::new().route("/notes/{id}", crate::route::get(page).0.post(slow).put(failed));
    let router = App::new(Routes::from(routes)).router();
    let kept = |router: Router| async move { fetch(&router, "GET", "/notes/a%7Eb", &[]).await.1.contains_key(header::AGE) };
    assert!(!kept(router.clone()).await && kept(router.clone()).await);

    // The path as a form's action may write it: the same page's.
    let (status, _, _) = fetch(&router, "PUT", "/notes/a~b", &[("sec-fetch-site", "same-origin")]).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!kept(router.clone()).await, "a handler that failed may have written first");
    assert!(kept(router.clone()).await);

    let writing = tokio::spawn({
        let router = router.clone();
        async move { fetch(&router, "POST", "/notes/a~b", &[("sec-fetch-site", "same-origin")]).await }
    });
    while writes.count() == 0 {
        tokio::task::yield_now().await;
    }
    writing.abort();
    assert!(writing.await.is_err_and(|ended| ended.is_cancelled()));
    assert!(!kept(router.clone()).await, "the client left: what the handler wrote by then is written");
    assert!(kept(router.clone()).await);
    // Its work runs to its end, and what it wrote since then counts too.
    release.notify_one();
    let dropped = async {
        while kept(router.clone()).await {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), dropped).await.expect("the work's end drops the page");
    assert!(kept(router.clone()).await, "and the page made after it is kept");
    assert_eq!(runs.count(), 4);
}

/// Which inputs a kept page's handler may take is known when the app compiles: each of Corten's
/// own that reads only what the key covers, and not one that reads a body or where a stream
/// stopped, nor one of the app's own (which cannot say otherwise: `Anonymous::KEYED`).
#[test]
fn a_handler_s_inputs_say_whether_its_page_can_be_kept() {
    use crate::answer::{Accepts, AnonymousInputs};
    fn keyed<Args>() -> bool
    where
        AnonymousInputs: Accepts<Args>,
    {
        <AnonymousInputs as Accepts<Args>>::KEYED
    }
    assert!(keyed::<()>() && keyed::<(Req,)>());
    // Corten fills none of its keyed inputs as an `Option`, so an `Option` of one is the app's (#1803).
    assert!(!keyed::<(Option<Req>,)>() && !keyed::<(Option<crate::Params<caller_url::Catalog>>,)>());
    // Corten reads a `Form` only as the last argument: one before it is the app's own (#1803).
    assert!(keyed::<(Req, crate::Form<()>)>() && !keyed::<(crate::Form<()>, Req)>());
    assert!(keyed::<(
        crate::Params<caller_url::Catalog>,
        crate::extract::State<()>,
        crate::Signal,
        http::Method,
        http::Uri,
        Req,
        crate::Form<()>
    )>());
    assert!(!keyed::<(Req, Device)>() && !keyed::<(Option<Device>,)>(), "an input of the app's own");
    assert!(!keyed::<(crate::Upload<()>, Req)>() && !keyed::<(crate::LiveSince,)>() && !keyed::<(Req, crate::LiveSince)>());
    #[cfg(feature = "json")]
    assert!(!keyed::<(crate::Json<()>,)>());
    #[cfg(feature = "feed")]
    assert!(!keyed::<(corten_feed::Since,)>());
}

/// A page whose handler was reading while a write to its path went through may show what was
/// there before: it is sent, and not kept. The write here is counted by its path, another page
/// having been kept before it.
#[tokio::test]
async fn a_page_made_while_a_write_went_through_is_not_kept() {
    let (runs, written) = (Runs::default(), std::sync::Arc::new(tokio::sync::Notify::new()));
    let (counted, wait) = (runs.clone(), written.clone());
    let page = move |req: Req| {
        counted.ran();
        let (first, wait) = (counted.count() == 1, wait.clone());
        async move {
            if first {
                wait.notified().await;
            }
            Public::new(Duration::from_secs(60), req.test_page_for("Slow", html! { <p>"slow"</p> }))
        }
    };
    let other =
        |req: Req| async move { Public::new(Duration::from_secs(60), req.test_page_for("Other", html! { <p>"other"</p> })) };
    let how = |signal: crate::Signal| async move { signal.counted_as() };
    let routes = Table::new().route("/", crate::route::get(page).0.post(how)).route("/other", crate::route::get(other).0);
    let router = App::new(Routes::from(routes)).router();
    fetch(&router, "GET", "/other", &[]).await;
    let reading = tokio::spawn({
        let router = router.clone();
        async move { fetch(&router, "GET", "/", &[]).await }
    });
    while runs.count() == 0 {
        tokio::task::yield_now().await;
    }
    let (status, _, counted) = fetch(&router, "POST", "/", &[("sec-fetch-site", "same-origin")]).await;
    assert_eq!((status, &counted[..]), (StatusCode::OK, &b"path"[..]));
    written.notify_one();
    let (status, headers, _) = reading.await.unwrap();
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE));
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert!(runs.count() == 2 && !headers.contains_key(header::AGE), "made again after the write: {headers:?}");
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert!(runs.count() == 2 && headers.contains_key(header::AGE), "and that one is kept");
}

/// An app counts its writes by path once it has made an answer it may keep. Until then a write
/// reads nothing of its path and is counted with the others like it: an answer the app does not
/// keep makes no counts, however often it is asked for, and a page whose handler read while such
/// a write went through, at any path, is sent and not kept. Once the counts are there a write
/// drops only what is kept at its own path.
#[tokio::test]
async fn a_write_is_counted_by_path_once_an_answer_may_be_kept() {
    let same_origin = [("sec-fetch-site", "same-origin")];
    let (runs, written) = (Runs::default(), std::sync::Arc::new(tokio::sync::Notify::new()));
    let (counted, wait) = (runs.clone(), written.clone());
    let page = move |req: Req| {
        counted.ran();
        let (first, wait) = (counted.count() == 1, wait.clone());
        async move {
            if first {
                wait.notified().await;
            }
            Public::new(Duration::from_secs(60), req.test_page_for("Slow", html! { <p>"slow"</p> }))
        }
    };
    // A body too small for any build to keep.
    let words = || async { Public::new(Duration::from_secs(60), "words") };
    let how = |signal: crate::Signal| async move { signal.counted_as() };
    let routes = Table::new()
        .route("/", crate::route::get(page).0)
        .route("/words", crate::route::get(words).0)
        .route("/items/{id}/edit", crate::router::post(how));
    let router = App::new(Routes::from(routes)).router();
    let write = |router: Router| async move {
        let (status, _, body) = fetch(&router, "POST", "/items/7/edit", &same_origin).await;
        assert_eq!(status, StatusCode::OK);
        String::from_utf8(body.to_vec()).unwrap()
    };
    assert_eq!(write(router.clone()).await, "early", "nothing asked for yet");
    for _ in 0..3 {
        assert!(!fetch(&router, "GET", "/words", &[]).await.1.contains_key(header::AGE));
    }
    assert_eq!(write(router.clone()).await, "early", "an answer the app does not keep makes no counts");

    let reading = tokio::spawn({
        let router = router.clone();
        async move { fetch(&router, "GET", "/", &[]).await }
    });
    while runs.count() == 0 {
        tokio::task::yield_now().await;
    }
    assert_eq!(write(router.clone()).await, "early", "a page asked for and not yet made makes none either");
    written.notify_one();
    let (status, headers, _) = reading.await.unwrap();
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE));
    // The page was not kept, and it made the counts all the same: an app whose writes never
    // pause would otherwise never come to count them by path.
    assert_eq!(write(router.clone()).await, "path", "an answer that may be kept was made");
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert!(runs.count() == 2 && !headers.contains_key(header::AGE), "its handler read across a write: {headers:?}");
    assert_eq!(write(router.clone()).await, "path");
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert!(runs.count() == 2 && headers.contains_key(header::AGE), "a write at another path leaves it: {headers:?}");

    // An answer too large for the store makes no counts: none is made for what cannot be kept.
    let small = kept_routes(&Runs::default()).route("/items/{id}/edit", crate::router::post(how));
    let small = App::new(Routes::from(small)).kept_answers(4096).router();
    fetch(&small, "GET", "/", &[]).await;
    assert!(!fetch(&small, "GET", "/", &[]).await.1.contains_key(header::AGE), "larger than an eighth of the bound");
    assert_eq!(write(small).await, "early");
}

/// A write that began before the app counted writes by path read nothing of its path, so its
/// answer drops every page kept since it began, at whatever path. One that begins after is
/// counted by its path and drops no other's.
#[tokio::test]
async fn a_write_from_before_the_counts_drops_every_page_kept_since() {
    let (runs, writes, release) = (Runs::default(), Runs::default(), std::sync::Arc::new(tokio::sync::Notify::new()));
    let counted = runs.clone();
    let page = move |req: Req| {
        counted.ran();
        async move { Public::new(Duration::from_secs(60), req.test_page_for("Notes", html! { <p>"notes"</p> })) }
    };
    let (began, wait) = (writes.clone(), release.clone());
    let slow = move || {
        let (began, wait) = (began.clone(), wait.clone());
        async move {
            began.ran();
            wait.notified().await;
            StatusCode::NO_CONTENT
        }
    };
    let routes = Table::new()
        .route("/notes", crate::route::get(page.clone()).0)
        .route("/list", crate::route::get(page).0)
        .route("/save", crate::router::post(slow));
    let router = App::new(Routes::from(routes)).router();
    let kept = |path: &'static str| {
        let router = router.clone();
        async move { fetch(&router, "GET", path, &[]).await.1.contains_key(header::AGE) }
    };
    let save = || {
        let router = router.clone();
        async move { fetch(&router, "POST", "/save", &[("sec-fetch-site", "same-origin")]).await.0 }
    };
    let writing = tokio::spawn(save());
    while writes.count() == 0 {
        tokio::task::yield_now().await;
    }
    assert!(!kept("/notes").await && kept("/notes").await && !kept("/list").await && kept("/list").await);
    assert_eq!(runs.count(), 2);
    release.notify_one();
    assert_eq!(writing.await.unwrap(), StatusCode::NO_CONTENT);
    assert!(!kept("/notes").await && !kept("/list").await, "what its handler may have changed is not known by path");
    assert!(kept("/notes").await && kept("/list").await);
    assert_eq!(runs.count(), 4);
    // The next write to that path finds the counts.
    release.notify_one();
    assert_eq!(save().await, StatusCode::NO_CONTENT);
    assert!(kept("/notes").await && kept("/list").await, "a write at another path");
    assert_eq!(runs.count(), 4);
}

/// Work a write left behind (`signal.finish`) counts as the write was counted. One that began
/// before the app counted writes by path, whose client then left, drops what was kept by the
/// time its work ends, at whatever path.
#[tokio::test]
async fn work_left_by_a_write_from_before_the_counts_drops_what_was_kept_since() {
    let (runs, writes, release) = (Runs::default(), Runs::default(), std::sync::Arc::new(tokio::sync::Notify::new()));
    let counted = runs.clone();
    let page = move |req: Req| {
        counted.ran();
        async move { Public::new(Duration::from_secs(60), req.test_page_for("Notes", html! { <p>"notes"</p> })) }
    };
    let (began, wait) = (writes.clone(), release.clone());
    let slow = move |signal: crate::Signal| {
        let (began, wait) = (began.clone(), wait.clone());
        async move {
            let work = move |_| async move {
                began.ran();
                wait.notified().await;
            };
            signal.finish(work).await;
            StatusCode::NO_CONTENT
        }
    };
    let routes = Table::new().route("/notes", crate::route::get(page).0).route("/save", crate::router::post(slow));
    let router = App::new(Routes::from(routes)).router();
    let kept = |router: Router| async move { fetch(&router, "GET", "/notes", &[]).await.1.contains_key(header::AGE) };

    // The write begins before anything is asked for, and its client leaves.
    let writing = tokio::spawn({
        let router = router.clone();
        async move { fetch(&router, "POST", "/save", &[("sec-fetch-site", "same-origin")]).await }
    });
    while writes.count() == 0 {
        tokio::task::yield_now().await;
    }
    writing.abort();
    assert!(writing.await.is_err_and(|ended| ended.is_cancelled()));
    assert!(!kept(router.clone()).await && kept(router.clone()).await, "a page made after the client left is kept");
    assert_eq!(runs.count(), 1);
    // Its work runs to its end, and what it wrote since then counts.
    release.notify_one();
    let dropped = async {
        while kept(router.clone()).await {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), dropped).await.expect("the work's end drops the page");
    assert!(kept(router.clone()).await, "and the page made after it is kept");
    assert_eq!(runs.count(), 2);
}

static SHELF_RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[crate::routes(area = Shelf)]
mod shelf_url {
    #[route("/shelf")]
    pub struct Shelf;

    #[route("/shelf/books", get = shelf_books)]
    pub struct Books;
}

async fn shelf_books(req: Req) -> Public<HtmlResult> {
    SHELF_RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Public::new(Duration::from_secs(60), req.test_page_for("Books", html! { <p>"books"</p> }))
}

/// A page in an area is kept like any other, behind the area's own middleware and with the
/// area's own policy, which is written for every request.
#[tokio::test]
async fn a_kept_page_in_an_area_passes_the_area_s_middleware_and_has_its_policy() {
    let router = App::new(Routes::new())
        .area(|area| shelf_url::area(area).middleware(Step("limit", true)).policy(|p| p.form_action("https://pay.example")))
        .router();
    let (status, first, body) = fetch(&router, "GET", "/shelf/books", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let (_, mut again, same) = fetch(&router, "GET", "/shelf/books", &[]).await;
    assert_eq!(SHELF_RUNS.load(std::sync::atomic::Ordering::Relaxed), 1);
    assert!(again.remove(header::AGE).is_some() && again == first && same == body, "{again:?}");
    assert!(first[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("https://pay.example"), "{first:?}");
    let (status, _, _) = fetch(&router, "GET", "/shelf/books", &[("x-flood", "1")]).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "the area's middleware still answers first");
}

static FIND_RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[crate::routes]
mod find_url {
    #[route("/find", get = find_terms)]
    pub struct Find {
        #[route(query)]
        pub terms: crate::tests::url::Terms,
    }
}

async fn find_terms(crate::Params(at): crate::Params<find_url::Find>, req: Req) -> Public<HtmlResult> {
    FIND_RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let words = at.terms.0.unwrap_or_default();
    Public::new(Duration::from_secs(60), req.test_page_for("Find", html! { <p>{words}</p> }))
}

/// A value the URL alone gives, read through `Params` by a `FromQuery` type of the app's own
/// (a rule over the whole query, here an older parameter name), keeps its page by the URL it was
/// asked with, where an extractor of the app's own would not (#1799).
#[tokio::test]
async fn a_page_whose_value_a_from_query_type_reads_is_kept_by_its_url() {
    use std::sync::atomic::Ordering::Relaxed;
    let router = App::new(find_url::router()).router();
    for (uri, words, runs, kept) in [
        ("/find?q=pika", "pika", 1, false),
        ("/find?q=pika", "pika", 1, true),
        ("/find?search=pika", "pika", 2, false),
        ("/find?search=pika", "pika", 2, true),
        ("/find?q=mew", "mew", 3, false),
    ] {
        let (status, headers, body) = fetch(&router, "GET", uri, &[]).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert_eq!(FIND_RUNS.load(Relaxed), runs, "{uri}");
        assert_eq!(headers.contains_key(header::AGE), kept, "{uri}: {headers:?}");
        assert!(String::from_utf8_lossy(&body).contains(&format!("<p>{words}</p>")), "{uri}");
    }
}

/// An extractor of the app's own that cannot tell who asks, and reads what no kept page's key
/// covers.
struct Device(bool);

impl<S: Send + Sync> crate::extract::FromRequestParts<S> for Device {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut http::request::Parts, _: &S) -> std::result::Result<Self, Response> {
        Ok(Device(parts.headers.get(header::USER_AGENT).is_some_and(|agent| agent.as_bytes().starts_with(b"Phone"))))
    }
}

impl crate::answer::Anonymous for Device {}

/// What is not kept: an answer that is not for everyone, sets a cookie, drew this request's
/// nonce, failed, is not a page or a whole body (a status alone), is a body the app does not
/// compress (a picture, a short text), has no lifetime or is
/// too large for the bound; one whose handler takes an input of the app's own; and nothing in an
/// app that keeps none, or under `corten dev`.
#[tokio::test]
async fn an_answer_is_kept_only_when_it_is_the_same_for_everyone_for_a_while() {
    use crate::route::get as typed;
    let (minute, day) = (Duration::from_secs(60), Duration::from_secs(86_400));
    let home = || html! { <p>"home"</p> };
    let routes = move || {
        Table::new()
            .route("/", typed(move |req: Req| async move { Public::new(minute, req.test_page_for("Home", home())) }).0)
            .route(
                "/catalog",
                typed(move |req: Req| async move { Public::new(minute, req.test_page_for("Catalog", home())).shared(day) }).0,
            )
            .route("/plain", typed(move |req: Req| async move { req.test_page("Plain", home()) }).0)
            .route("/statement", typed(move |req: Req| async move { NoStore(req.test_page("Statement", home())) }).0)
            .route(
                "/cookies",
                typed(move |req: Req| async move {
                    let page = req.test_page_for("Home", home()).map(|mut page| {
                        page.headers_mut().append(header::SET_COOKIE, SetCookie::new("a", "1").header());
                        page
                    });
                    Public::new(minute, page)
                })
                .0,
            )
            .route(
                "/tenant",
                typed(move |req: Req| async move {
                    let page = req.test_page_for("Home", home()).map(|mut page| {
                        page.headers_mut().append(header::VARY, HeaderValue::from_static("x-tenant"));
                        page
                    });
                    Public::new(minute, page)
                })
                .0,
            )
            .route(
                "/inputs",
                typed(move |_: http::Method, _: http::Uri, _: crate::Signal, req: Req| async move {
                    Public::new(minute, req.test_page_for("Inputs", home()))
                })
                .0,
            )
            .route("/inline", typed(inline_page).0)
            .route(
                "/gone",
                typed(move |req: Req| async move {
                    let page = req.test_page_for("Gone", home());
                    Public::new(minute, page.and_then(|page| Err::<(), Error>(Error::not_found()).map(|()| page)))
                })
                .0,
            )
            .route("/now", typed(move |req: Req| async move { Public::new(Duration::ZERO, req.test_page_for("Now", home())) }).0)
            .route("/moved", typed(move |req: Req| async move { Public::new(minute, req.redirect(&Root)) }).0)
            .route("/text", typed(move || async move { Public::new(minute, "text") }).0)
            .route("/long", typed(move || async move { Public::new(minute, "text ".repeat(300)) }).0)
            .route(
                "/file",
                typed(move || async move { Public::new(minute, Ok::<_, Error>(Media::new("image/png", &[0x89u8; 2048][..]))) }).0,
            )
            .route("/status", typed(move || async move { Public::new(minute, StatusCode::OK) }).0)
            .route(
                "/device",
                typed(move |device: Device, req: Req| async move {
                    let kind = if device.0 { "phone" } else { "desk" };
                    Public::new(minute, req.test_page_for("Device", html! { <p>{kind}</p> }))
                })
                .0,
            )
            .route(
                "/keyed",
                typed(move |req: Req| async move {
                    let form = html! { <form method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> };
                    Public::new(minute, req.test_page_for("Keyed", form))
                })
                .0,
            )
            .route(
                "/placed",
                typed(move |req: Req| async move {
                    // Rendered to a string first, so the page's own render draws no key.
                    let form =
                        html! { <form method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> }.to_html();
                    Public::new(minute, req.test_page_for("Placed", html! { <div>{crate::view::raw(form)}</div> }))
                })
                .0,
            )
            .route(
                "/recovered",
                typed(move |req: Req| async move {
                    // The same, with a page that fails rendered between the key and the page given.
                    let form =
                        html! { <form method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> }.to_html();
                    let page = req
                        .page(Headless)
                        .or_else(|_| req.test_page_for("Recovered", html! { <div>{crate::view::raw(form)}</div> }));
                    Public::new(minute, page)
                })
                .0,
            )
    };
    let router = App::new(Routes::from(routes())).router();
    let kept = |router: Router, uri: &'static str| async move {
        fetch(&router, "GET", uri, &[]).await;
        fetch(&router, "GET", uri, &[]).await.1.contains_key(header::AGE)
    };
    for (uri, why) in [
        ("/plain", "not Public"),
        ("/statement", "no-store"),
        ("/cookies", "a Public page with a cookie written by hand"),
        ("/tenant", "a page that varies on a header of the app's"),
        ("/inline", "this request's nonce"),
        ("/gone", "an error page"),
        ("/now", "no lifetime"),
        ("/moved", "a redirect"),
        ("/text", "a whole body too small to keep"),
        ("/status", "a status alone has no body to keep"),
        ("/keyed", "a submit key drawn for this request"),
        ("/placed", "a submit key drawn before the page's render and placed in it as markup"),
        ("/recovered", "a submit key drawn before a page whose render failed, placed in the page given instead"),
        ("/device", "an input of the app's own, which may read a header no key covers"),
        ("/missing", "no route"),
    ] {
        assert!(!kept(router.clone(), uri).await, "{uri}: {why}");
    }
    for uri in ["/", "/catalog", "/inputs"] {
        assert!(kept(router.clone(), uri).await, "{uri}");
    }
    // A whole body of a size worth keeping, whatever its type: text the app compresses where
    // the build does, and a picture no build compresses.
    for uri in ["/long", "/file"] {
        assert!(kept(router.clone(), uri).await, "{uri}");
    }
    // The page that failed did fail, and each request's page has its own key.
    let recovered =
        |router: Router| async move { String::from_utf8(fetch(&router, "GET", "/recovered", &[]).await.2.to_vec()).unwrap() };
    let (first, second) = (recovered(router.clone()).await, recovered(router.clone()).await);
    assert!(first.contains("Recovered") && first.contains("<form") && first != second, "{first}\n{second}");

    /// A document whose head has no `<Corten />`, which `html!` does not build: a page of it fails.
    struct Headless;

    impl Render for Headless {
        fn render(&self, out: &mut String) {
            out.push_str("<!DOCTYPE html><html><head><title>None</title></head><body><main></main></body></html>");
        }
    }

    impl crate::view::Document for Headless {
        fn render_part(&self, out: &mut String, _: crate::view::Part) {
            self.render(out);
        }
    }
    assert!(!kept(App::new(Routes::from(routes())).kept_answers(0).router(), "/").await, "an app that keeps none");
    assert!(!kept(App::new(Routes::from(routes())).dev(true).router(), "/").await, "under corten dev");
    assert!(!kept(App::new(Routes::from(routes())).kept_answers(2048).router(), "/").await, "larger than its share of the bound");

    // What a middleware did before the handler counts: a caller it read makes the answer that
    // caller's, and a URI it changed is no longer the one the router matched the page by.
    struct Reads;

    impl crate::Middleware for Reads {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let (mut parts, body) = req.into_parts();
            if parts.headers.contains_key("viewer") {
                let _ = Caller::<Viewer>::find(&parts, &()).await;
            }
            if parts.headers.contains_key("x-rewrite") {
                parts.uri = "/?seen=1".parse().unwrap();
            }
            next.run(Request::from_parts(parts, body)).await
        }
    }

    let router = App::new(Routes::from(routes())).middleware(Reads).router();
    // With the page kept, so each is a request the kept page would have answered.
    assert!(kept(router.clone(), "/").await);
    for asked in [("viewer", "ada"), ("x-rewrite", "1")] {
        fetch(&router, "GET", "/", &[asked]).await;
        let (status, headers, _) = fetch(&router, "GET", "/", &[asked]).await;
        assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "{asked:?}: {headers:?}");
    }
    assert!(fetch(&router, "GET", "/", &[]).await.1.contains_key(header::AGE), "and neither took the kept page's place");
}

/// Under `corten dev` nothing is kept, and the log says instead, for a `GET` that shows nothing
/// about who asks, whether a release build would keep a `Public` route's answer while its store
/// has room, and if not the first reason, as the code that decides it found it: once for each
/// route and verdict. Without dev, nothing of it is logged.
#[cfg(feature = "log")]
#[tokio::test]
async fn corten_dev_says_whether_a_public_answer_is_kept_and_why_not() {
    use crate::route::get as typed;
    let minute = Duration::from_secs(60);
    let home = || html! { <p>"home"</p> };
    let routes = move || {
        Table::new()
            .route("/", typed(move |req: Req| async move { Public::new(minute, req.test_page_for("Home", home())) }).0)
            .route(
                "/flip",
                typed(move |req: Req, uri: http::Uri| async move {
                    let cookie = uri.query() == Some("cookie");
                    let page = req.test_page_for("Flip", home()).map(|mut page| {
                        if cookie {
                            page.headers_mut().append(header::SET_COOKIE, SetCookie::new("a", "1").header());
                        }
                        page
                    });
                    Public::new(minute, page)
                })
                .0,
            )
            // Two reasons: the first a release build's checks come to is the one said.
            .route(
                "/both",
                typed(move |req: Req| async move {
                    let page = req.test_page_for("Both", home()).map(|mut page| {
                        page.headers_mut().insert(header::ETAG, HeaderValue::from_static("\"own\""));
                        page.headers_mut().append(header::SET_COOKIE, SetCookie::new("a", "1").header());
                        page
                    });
                    Public::new(minute, page)
                })
                .0,
            )
            .route(
                "/device",
                typed(move |device: Device, req: Req| async move {
                    let kind = if device.0 { "phone" } else { "desk" };
                    Public::new(minute, req.test_page_for("Device", html! { <p>{kind}</p> }))
                })
                .0,
            )
            .route(
                "/keyed",
                typed(move |req: Req| async move {
                    let form = html! { <form method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> };
                    Public::new(minute, req.test_page_for("Keyed", form))
                })
                .0,
            )
            .route("/inline", typed(inline_page).0)
            .route("/now", typed(move |req: Req| async move { Public::new(Duration::ZERO, req.test_page_for("Now", home())) }).0)
            .route("/text", typed(move || async move { Public::new(minute, "text") }).0)
            .route("/status", typed(move || async move { Public::new(minute, StatusCode::OK) }).0)
            .route("/plain", typed(move |req: Req| async move { req.test_page("Plain", home()) }).0)
    };
    let lines = Lines(std::sync::Arc::default());
    let _logging = log_to(&lines);
    // What one request logged.
    let logged = |router: Router, uri: &'static str, headers: &'static [(&'static str, &'static str)]| {
        let lines = lines.clone();
        async move {
            lines.0.lock().unwrap().clear();
            let (status, answer, _) = fetch(&router, "GET", uri, headers).await;
            assert!(!answer.contains_key(header::AGE), "{uri}: nothing is given from the store");
            let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
            (status, text)
        }
    };
    let dev = App::new(Routes::from(routes())).dev(true).router();
    let kept = "is Public, and a release build would keep its answer for 60 s while its store has room";
    let not = "is Public, but a release build does not keep its answer: ";
    let (_, text) = logged(dev.clone(), "/", &[]).await;
    assert!(text.contains("INFO") && text.contains(&format!("corten: / {kept}")), "{text}");
    // Said once for the route: the same verdict again says nothing.
    assert!(logged(dev.clone(), "/", &[]).await.1.is_empty());
    // Nor does a request a kept page would not answer (a cookie, a navigation): each asked of an
    // app of its own, whose route has said nothing yet, and says what it says next.
    for headers in [&[("cookie", "session=1")][..], &[("corten", "page")]] {
        let fresh = App::new(Routes::from(routes())).dev(true).router();
        let (_, text) = logged(fresh.clone(), "/", headers).await;
        assert!(text.is_empty(), "{headers:?}: {text}");
        let (_, text) = logged(fresh, "/", &[]).await;
        assert!(text.contains(&format!("corten: / {kept}")), "{headers:?}, then none: {text}");
    }
    // An app that keeps no answers says so, whatever the route, of a request a kept answer could
    // stand for: not of one signed in or a navigation, each asked of a route that has said
    // nothing yet.
    let off = || App::new(Routes::from(routes())).kept_answers(0).dev(true).router();
    for headers in [&[("cookie", "session=1")][..], &[("corten", "page")]] {
        let fresh = off();
        let (_, text) = logged(fresh.clone(), "/", headers).await;
        assert!(text.is_empty(), "kept_answers(0), {headers:?}: {text}");
        let (_, text) = logged(fresh, "/", &[]).await;
        assert!(
            text.contains(&format!("corten: / {not}the app keeps no answers, since its bound is 0")),
            "{headers:?}, then none: {text}"
        );
    }
    for (uri, reason) in [
        ("/both", "it sets a cookie"),
        ("/device", "its handler takes an input the kept answer's key does not cover"),
        ("/keyed", "it draws a form's new submit key (SubmitKey::field)"),
        ("/inline", "its HTML has this request's CSP nonce"),
        ("/now", "it has no lifetime a shared cache keeps it for"),
        ("/text", "its body is 4 bytes, and a whole body is kept from 1024"),
        ("/status", "its answer is neither a page nor a whole body"),
    ] {
        let (status, text) = logged(dev.clone(), uri, &[]).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert!(text.contains("WARN") && text.contains(&format!("corten: {uri} {not}{reason}")), "{uri}: {text}");
        // The first reason alone. A page sent private for one also says so as it leaves (`settle`).
        assert_eq!(text.matches("is Public").count(), 1, "{uri}: {text}");
        let (_, text) = logged(dev.clone(), uri, &[]).await;
        assert!(!text.contains("is Public"), "{uri}: said once: {text}");
    }
    // An answer that is not `Public` says nothing.
    assert!(logged(dev.clone(), "/plain", &[]).await.1.is_empty());
    // What a middleware did before the handler, as the route reads it: a caller it read for the
    // request, a URL it changed. A request with a session's cookie is left to its handler anyway.
    struct Reads;

    impl crate::Middleware for Reads {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let (mut parts, body) = req.into_parts();
            if parts.headers.contains_key("viewer") {
                let _ = Caller::<Viewer>::find(&parts, &()).await;
            }
            if parts.headers.contains_key("x-rewrite") {
                parts.uri = "/?seen=1".parse().unwrap();
            }
            next.run(Request::from_parts(parts, body)).await
        }
    }
    let read = App::new(Routes::from(routes())).middleware(Reads).dev(true).router();
    let (_, text) = logged(read.clone(), "/", &[("viewer", "ada"), ("cookie", "session=1")]).await;
    assert!(!text.contains("is Public"), "{text}");
    let (_, text) = logged(read.clone(), "/", &[("viewer", "ada")]).await;
    assert!(text.contains(&format!("corten: / {not}something read a Caller for the request")), "{text}");
    let (_, text) = logged(read.clone(), "/", &[("x-rewrite", "1")]).await;
    assert!(text.contains(&format!("{not}a middleware changed its URL after the router matched it")), "{text}");
    let (_, text) = logged(read, "/", &[]).await;
    assert!(text.contains(&format!("corten: / {kept}")), "{text}");
    // Each verdict once for a route: a route that answers another way says the new one, and
    // nothing when it answers a way it has said before.
    let (_, text) = logged(dev.clone(), "/flip", &[]).await;
    assert!(text.contains(&format!("corten: /flip {kept}")), "{text}");
    let (_, text) = logged(dev.clone(), "/flip?cookie", &[]).await;
    assert!(text.contains(&format!("corten: /flip {not}it sets a cookie")), "{text}");
    for uri in ["/flip", "/flip?cookie"] {
        let (_, text) = logged(dev.clone(), uri, &[]).await;
        assert!(!text.contains("is Public"), "{uri}: {text}");
    }
    // Another app is another process's worth of routes, and says each again.
    let again = App::new(Routes::from(routes())).dev(true).router();
    assert!(logged(again, "/", &[]).await.1.contains(&format!("corten: / {kept}")));

    // Without dev, the same requests log nothing (and the page is kept).
    let release = App::new(Routes::from(routes())).dev(false).router();
    for uri in ["/both", "/device", "/keyed", "/inline", "/now", "/text", "/status", "/flip?cookie", "/"] {
        lines.0.lock().unwrap().clear();
        fetch(&release, "GET", uri, &[]).await;
        assert!(lines.0.lock().unwrap().is_empty(), "{uri}");
    }
    assert!(fetch(&release, "GET", "/", &[]).await.1.contains_key(header::AGE));
}

/// A body of a known size that fails when read.
struct Failing(u64);

impl http_body::Body for Failing {
    type Data = bytes::Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<bytes::Bytes>, Self::Error>>> {
        std::task::Poll::Ready(Some(Err(std::io::Error::other("the body broke"))))
    }

    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(self.0)
    }
}

/// A `Public` page whose body, of a known size, fails when read is answered `500` by a release
/// build, which reads it to keep it, and kept by none. Under `corten dev` the log says the body
/// failed as it read it, and not that it is kept, nor what a release build answers, which reads it
/// before the answer leaves; the answer leaves as it does with no store (`kept_answers(0)`), its
/// body failing as it did.
#[cfg(feature = "log")]
#[tokio::test]
async fn corten_dev_says_a_body_that_cannot_be_read_is_not_kept() {
    use crate::route::get as typed;
    let routes = || {
        Table::new().route(
            "/",
            typed(|req: Req| async move {
                let page = req.test_page_for("Broken", html! { <p>"broken"</p> }).map(|mut page| {
                    *page.0.body_mut() = Body::new(Failing(64));
                    page
                });
                Public::new(Duration::from_secs(60), page)
            })
            .0,
        )
    };
    // Its status and headers, and whether its body could be read.
    let answer = |router: Router| async move {
        let res = router.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
        let (mut parts, body) = res.into_parts();
        // Each app's shell has a hash of its own under `corten dev`.
        parts.headers.remove("corten-shell");
        (parts.status, parts.headers, body.collect().await.is_ok())
    };
    let lines = Lines(std::sync::Arc::default());
    let _logging = log_to(&lines);
    let dev = App::new(Routes::from(routes())).dev(true).router();
    let (status, headers, read) = answer(dev).await;
    let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
    assert!(text.contains(&format!("corten: / {UNREAD}")), "{text}");
    assert!(!text.contains("would keep") && !text.contains("does not keep") && !text.contains("500"), "{text}");
    let unkept = App::new(Routes::from(routes())).kept_answers(0).dev(true).router();
    assert_eq!((status, headers, read), answer(unkept).await, "as with no store");
    let release = App::new(Routes::from(routes())).dev(false).router();
    for _ in 0..2 {
        let (status, headers, _) = answer(release.clone()).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!headers.contains_key(header::AGE));
    }
}

/// A body of a known size whose frames come in turn: the last waits for `gate`, if it has one,
/// and the first draws a form's new submit key as it is read, if `draws`.
struct Frames {
    frames: std::collections::VecDeque<Result<http_body::Frame<bytes::Bytes>, std::io::Error>>,
    length: u64,
    gate: Option<tokio::sync::oneshot::Receiver<()>>,
    draws: bool,
}

impl Frames {
    /// `pieces` of data, then trailers (`Ok`) or a failure (`Err`), if any.
    fn new(pieces: &[&'static str], end: Option<Result<HeaderMap, ()>>) -> Self {
        let mut frames: std::collections::VecDeque<_> =
            pieces.iter().map(|piece| Ok(http_body::Frame::data(bytes::Bytes::from_static(piece.as_bytes())))).collect();
        match end {
            Some(Ok(trailers)) => frames.push_back(Ok(http_body::Frame::trailers(trailers))),
            Some(Err(())) => frames.push_back(Err(std::io::Error::other("the body broke"))),
            None => {}
        }
        let length = pieces.iter().map(|piece| piece.len() as u64).sum();
        Frames { frames, length, gate: None, draws: false }
    }
}

impl http_body::Body for Frames {
    type Data = bytes::Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<bytes::Bytes>, Self::Error>>> {
        let this = self.get_mut();
        if std::mem::take(&mut this.draws) {
            crate::SubmitKey::field(KeyedWrite::FIELDS.submit).render(&mut String::new());
        }
        if this.frames.len() == 1 {
            if let Some(gate) = &mut this.gate {
                let _ = std::task::ready!(std::future::Future::poll(std::pin::Pin::new(gate), cx));
                this.gate = None;
            }
        }
        std::task::Poll::Ready(this.frames.pop_front())
    }

    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(self.length)
    }
}

/// A body's data, its trailers and whether it failed, read frame by frame.
async fn frames_of(mut body: Body) -> (Vec<bytes::Bytes>, Option<HeaderMap>, bool) {
    let (mut data, mut trailers) = (Vec::new(), None);
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else { return (data, trailers, true) };
        match frame.into_data() {
            Ok(piece) => data.push(piece),
            Err(frame) => trailers = frame.into_trailers().ok(),
        }
    }
    (data, trailers, false)
}

/// Under `corten dev` the body of a `Public` answer a release build would keep is not read to
/// tell: its frames, trailers and failure reach the app's middleware and the client as they do
/// with no store, as they come, and what a release build does with it is said as it ends. A key a
/// body draws as it is read is not one a release build's watch sees (it reads the body after its
/// handler), so neither is it said under `corten dev`.
#[cfg(feature = "log")]
#[tokio::test]
async fn corten_dev_says_what_it_would_keep_as_the_body_is_read() {
    use crate::route::get as typed;
    let piece: &'static str = Box::leak("p".repeat(600).into_boxed_str());
    // A page of `count` pieces of data, then `end`, drawing a key as it is read if `draws`.
    let body = move |count: usize, end: Option<Result<HeaderMap, ()>>, draws: bool| {
        move |req: Req| {
            let frames = Frames { draws, ..Frames::new(&vec![piece; count], end.clone()) };
            async move {
                let page = req.test_page_for("Frames", html! { <p>"frames"</p> }).map(|mut page| {
                    *page.0.body_mut() = Body::new(frames);
                    page
                });
                Public::new(Duration::from_secs(60), page)
            }
        }
    };
    let mut trailers = HeaderMap::new();
    trailers.insert("checksum", HeaderValue::from_static("abc"));
    let routes = move || {
        Table::new()
            .route("/fails", typed(body(3, Some(Err(())), false)).0)
            .route("/trailers", typed(body(2, Some(Ok(trailers.clone())), false)).0)
            .route("/draws", typed(body(2, None, true)).0)
    };
    let lines = Lines(std::sync::Arc::default());
    let _logging = log_to(&lines);
    let text = || String::from_utf8(std::mem::take(&mut *lines.0.lock().unwrap())).unwrap();
    // Its status and headers, said before its body is read, then its frames, and what was said
    // once they were read.
    let answer = |router: Router, uri: &'static str| async move {
        let res = router.oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        let before = text();
        let (mut parts, body) = res.into_parts();
        // Each app's shell has a hash of its own under `corten dev`.
        parts.headers.remove("corten-shell");
        let frames = frames_of(body).await;
        (parts.status, parts.headers, frames, before, text())
    };
    for (uri, said) in [("/fails", UNREAD), ("/trailers", KEPT_IF_READ), ("/draws", KEPT_IF_READ)] {
        let dev = App::new(Routes::from(routes())).dev(true).router();
        let (status, headers, frames, before, after) = answer(dev, uri).await;
        assert!(!before.contains("is Public"), "{uri}: nothing said before the body is read: {before}");
        assert!(after.contains(&format!("corten: {uri} {said}")), "{uri}: {after}");
        assert_eq!(after.matches("is Public").count(), 1, "{uri}: {after}");
        let unkept = App::new(Routes::from(routes())).kept_answers(0).dev(true).router();
        let (no_status, no_headers, no_frames, _, _) = answer(unkept, uri).await;
        assert_eq!((status, headers, &frames), (no_status, no_headers, &no_frames), "{uri}: as with no store");
        let pieces = if uri == "/fails" { 3 } else { 2 };
        assert_eq!(frames.0.len(), pieces, "{uri}: each frame as it came: {frames:?}");
        assert_eq!(frames.2, uri == "/fails", "{uri}: failing where it failed");
        assert_eq!(frames.1.is_some(), uri == "/trailers", "{uri}: its trailers kept: {frames:?}");
    }
    // A release build reads the body after its handler's watch: a key drawn as it is read is not
    // seen, and the answer is kept, as `corten dev` said.
    let release = App::new(Routes::from(routes())).dev(false).router();
    fetch(&release, "GET", "/draws", &[]).await;
    assert!(fetch(&release, "GET", "/draws", &[]).await.1.contains_key(header::AGE), "a release build keeps it");
    // A key the handler drew is seen by the same watch in both builds.
    let keyed = || {
        Table::new().route(
            "/keyed",
            typed(|req: Req| async move {
                let form = html! { <form method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> };
                Public::new(Duration::from_secs(60), req.test_page_for("Keyed", form))
            })
            .0,
        )
    };
    // A refusal is said as the answer leaves the route, before its body is read.
    let (_, _, _, before, _) = answer(App::new(Routes::from(keyed())).dev(true).router(), "/keyed").await;
    assert!(
        before
            .contains("corten: /keyed is Public, but a release build does not keep its answer: it draws a form's new submit key"),
        "{before}"
    );
    let release = App::new(Routes::from(keyed())).dev(false).router();
    fetch(&release, "GET", "/keyed", &[]).await;
    assert!(!fetch(&release, "GET", "/keyed", &[]).await.1.contains_key(header::AGE), "nor does a release build keep it");
}

/// Under `corten dev` a slow body is not waited for: the answer and its first frame leave before
/// its last is made, and that a release build would keep it is said once the last is read.
#[cfg(feature = "log")]
#[tokio::test]
async fn corten_dev_does_not_hold_a_slow_body() {
    use crate::route::get as typed;
    let piece: &'static str = Box::leak("s".repeat(600).into_boxed_str());
    let (open, gate) = tokio::sync::oneshot::channel();
    let gate = std::sync::Arc::new(std::sync::Mutex::new(Some(gate)));
    let route = typed(move |req: Req| {
        let gate = gate.lock().unwrap().take();
        async move {
            let page = req.test_page_for("Slow", html! { <p>"slow"</p> }).map(|mut page| {
                *page.0.body_mut() = Body::new(Frames { gate, ..Frames::new(&[piece, piece], None) });
                page
            });
            Public::new(Duration::from_secs(60), page)
        }
    });
    let lines = Lines(std::sync::Arc::default());
    let _logging = log_to(&lines);
    let text = || String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
    let dev = App::new(Routes::from(Table::new().route("/slow", route.0))).dev(true).router();
    let wait = Duration::from_secs(10);
    let request = Request::get("/slow").body(Body::empty()).unwrap();
    let res = tokio::time::timeout(wait, dev.oneshot(request)).await.expect("the answer leaves before its body ends").unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let mut body = res.into_body();
    let first = tokio::time::timeout(wait, body.frame()).await.expect("and its first frame");
    assert_eq!(first.unwrap().unwrap().into_data().unwrap().len(), 600);
    assert!(!text().contains("is Public"), "nothing said before the body ends: {}", text());
    open.send(()).unwrap();
    let (rest, _, failed) = frames_of(body).await;
    assert!(rest.len() == 1 && !failed, "{rest:?}");
    assert!(text().contains(&format!("corten: /slow {KEPT_IF_READ}")), "{}", text());
}

/// A route whose answer is held whole for one request and sent as it is read for another says
/// each once: a release build keeps the second only if it reads the body within the route's
/// deadline, so that caveat is not hidden by the first having been said, nor the first by the
/// second.
#[cfg(feature = "log")]
#[tokio::test]
async fn corten_dev_says_a_held_and_a_sent_body_each_once_for_a_route() {
    use crate::route::get as typed;
    let piece: &'static str = Box::leak("w".repeat(600).into_boxed_str());
    let routes = move || {
        let route = typed(move |req: Req, uri: http::Uri| async move {
            let sent = uri.query() == Some("sent");
            let page = req.test_page_for("Switch", html! { <p>"switch"</p> }).map(|mut page| {
                if sent {
                    *page.0.body_mut() = Body::new(Frames::new(&[piece, piece], None));
                }
                page
            });
            Public::new(Duration::from_secs(60), page)
        });
        Table::new().route("/switch", route.0)
    };
    let lines = Lines(std::sync::Arc::default());
    let _logging = log_to(&lines);
    let dev = App::new(Routes::from(routes())).dev(true).router();
    let held = "corten: /switch is Public, and a release build would keep its answer for 60 s while its store has room, given";
    let sent = format!("corten: /switch {KEPT_IF_READ}");
    // What one request logged, its body read to its end.
    let logged = |uri: &'static str| {
        let (dev, lines) = (dev.clone(), lines.clone());
        async move {
            lines.0.lock().unwrap().clear();
            fetch(&dev, "GET", uri, &[]).await;
            String::from_utf8(std::mem::take(&mut *lines.0.lock().unwrap())).unwrap()
        }
    };
    for (uri, said) in [("/switch", held), ("/switch?sent", sent.as_str())] {
        let text = logged(uri).await;
        assert!(text.contains(said) && text.matches("is Public").count() == 1, "{uri}: {text}");
    }
    // Each said once: neither again, in either order.
    for uri in ["/switch", "/switch?sent", "/switch?sent", "/switch"] {
        let text = logged(uri).await;
        assert!(!text.contains("is Public"), "{uri}: said once: {text}");
    }
    // The other order, in an app of its own: the held body is said after the sent one.
    let dev = App::new(Routes::from(routes())).dev(true).router();
    lines.0.lock().unwrap().clear();
    fetch(&dev, "GET", "/switch?sent", &[]).await;
    fetch(&dev, "GET", "/switch", &[]).await;
    let text = String::from_utf8(std::mem::take(&mut *lines.0.lock().unwrap())).unwrap();
    assert!(text.contains(&sent) && text.contains(held) && text.matches("is Public").count() == 2, "{text}");
}

/// What `corten dev` says of a body it read as it was sent and that read whole.
#[cfg(feature = "log")]
const KEPT_IF_READ: &str =
    "is Public, and a release build would keep its answer for 60 s while its store has room if it reads the body whole within the route's deadline";

/// What `corten dev` says of a body that failed as it read it.
#[cfg(feature = "log")]
const UNREAD: &str = "is Public, and its body, of a known size, failed as corten dev read it, after the route answered: a release build reads it before the answer leaves, within the route's deadline, and keeps the answer only if the body reads whole there";

/// A body of a known size: `piece`, then `piece` again once `wait` ends, or, if `signal` is
/// given, `piece` while it has not ended and a failure once it has.
struct Late {
    piece: Option<bytes::Bytes>,
    rest: u8,
    wait: std::pin::Pin<Box<tokio::time::Sleep>>,
    signal: Option<crate::Signal>,
}

impl http_body::Body for Late {
    type Data = bytes::Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<bytes::Bytes>, Self::Error>>> {
        let this = self.get_mut();
        if this.signal.as_ref().is_some_and(crate::Signal::is_aborted) {
            return std::task::Poll::Ready(Some(Err(std::io::Error::other("the request's signal ended"))));
        }
        if this.rest == 0 {
            return std::task::Poll::Ready(None);
        }
        if this.rest == 1 {
            std::task::ready!(std::future::Future::poll(this.wait.as_mut(), cx));
        }
        this.rest -= 1;
        std::task::Poll::Ready(this.piece.clone().map(|piece| Ok(http_body::Frame::data(piece))))
    }

    fn size_hint(&self) -> http_body::SizeHint {
        let length = self.piece.as_ref().map_or(0, |piece| piece.len() as u64);
        http_body::SizeHint::with_exact(length * u64::from(self.rest))
    }
}

/// Under `corten dev` a body read as it is sent, after its route answered, is said as `corten dev`
/// saw it, not as a release build fares with it, which reads it before the answer leaves. A body
/// slower than the route's deadline is answered `503` by a release build and not kept, and
/// `corten dev`, which read it whole, says it is kept only if that build reads it within the
/// deadline. A body that fails once the request's signal has ended (it ends as an answer of a
/// known size leaves) reads whole in a release build, which keeps it, and `corten dev`, where it
/// failed, says so without saying what that build answers.
#[cfg(feature = "log")]
// The clock is paused, and moves only when every task waits on a timer: the deadline (50 ms)
// always ends before the slow body's wait (300 ms), however busy the machine.
#[tokio::test(start_paused = true)]
async fn corten_dev_says_of_a_body_it_reads_only_what_it_saw() {
    use crate::route::get as typed;
    let piece = bytes::Bytes::from("l".repeat(600));
    let routes = move || {
        let (slow, ended) = (piece.clone(), piece.clone());
        Table::new()
            .route(
                "/slow",
                typed(move |req: Req| {
                    let wait = Box::pin(tokio::time::sleep(Duration::from_millis(300)));
                    let body = Late { piece: Some(slow.clone()), rest: 2, wait, signal: None };
                    async move {
                        let page = req.test_page_for("Slow", html! { <p>"slow"</p> }).map(|mut page| {
                            *page.0.body_mut() = Body::new(body);
                            page
                        });
                        Public::new(Duration::from_secs(60), page)
                    }
                })
                .0,
            )
            .route(
                "/ended",
                typed(move |req: Req| {
                    let wait = Box::pin(tokio::time::sleep(Duration::ZERO));
                    let body = Late { piece: Some(ended.clone()), rest: 2, wait, signal: Some(req.signal().clone()) };
                    async move {
                        let page = req.test_page_for("Ended", html! { <p>"ended"</p> }).map(|mut page| {
                            *page.0.body_mut() = Body::new(body);
                            page
                        });
                        Public::new(Duration::from_secs(60), page)
                    }
                })
                .0,
            )
    };
    let deadline = Duration::from_millis(50);
    let lines = Lines(std::sync::Arc::default());
    let _logging = log_to(&lines);
    let text = || String::from_utf8(std::mem::take(&mut *lines.0.lock().unwrap())).unwrap();
    // Its status, whether its body read whole, and what was said once it was read.
    let answer = |router: Router, uri: &'static str| async move {
        let res = router.oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        let (status, (_, _, failed)) = (res.status(), frames_of(res.into_body()).await);
        (status, !failed, text())
    };
    let dev = App::new(Routes::from(routes())).deadline(deadline).dev(true).router();
    let (status, whole, said) = answer(dev.clone(), "/slow").await;
    assert!(status == StatusCode::OK && whole, "under corten dev the body is read after the deadline's wait");
    assert!(said.contains(&format!("corten: /slow {KEPT_IF_READ}")), "{said}");
    let (status, whole, said) = answer(dev, "/ended").await;
    assert!(status == StatusCode::OK && !whole, "under corten dev the signal ended before the body was read");
    assert!(said.contains(&format!("corten: /ended {UNREAD}")), "{said}");
    assert!(!said.contains("does not keep") && !said.contains("500"), "no status a release build answers: {said}");
    // A release build reads each before the answer leaves: the slow one past its deadline, the
    // other whole, while the signal stands.
    let release = App::new(Routes::from(routes())).deadline(deadline).dev(false).router();
    for _ in 0..2 {
        let (status, headers, _) = fetch(&release, "GET", "/slow", &[]).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(!headers.contains_key(header::AGE));
    }
    let (status, _, _) = fetch(&release, "GET", "/ended", &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(fetch(&release, "GET", "/ended", &[]).await.1.contains_key(header::AGE), "a release build keeps it");
}

/// Under `corten dev` the answer the app's middleware sees after its handler is the one it saw
/// with no store: a `Public` page that read its messages after it was built is named as varying
/// on the language as it leaves the app, not before. A release build names it where it keeps the
/// page, before the middleware sees it, as before.
#[tokio::test]
async fn corten_dev_leaves_the_head_a_middleware_sees_as_it_was() {
    #[derive(Clone, Default)]
    struct Seen(std::sync::Arc<std::sync::Mutex<Option<HeaderMap>>>);

    impl crate::Middleware for Seen {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let res = next.run(req).await;
            *self.0.lock().unwrap() = Some(res.headers().clone());
            res
        }
    }
    let routes = || {
        let page = |req: Req| async move { Public::new(Duration::from_secs(60), late_words(&req)) };
        Table::new().route("/", crate::route::get(page).0)
    };
    // The head the middleware saw after the handler, and the one the app sent.
    let seen = |router: Router, seen: Seen| async move {
        let (status, sent, body) = fetch(&router, "GET", "/", &[("accept-language", "fr")]).await;
        assert!(status == StatusCode::OK && String::from_utf8_lossy(&body).contains("Annonces"), "{sent:?}");
        names_once(&sent, &["accept-language"], "as sent");
        let mut at = seen.0.lock().unwrap().take().expect("the middleware ran");
        // Each app's shell has a hash of its own under `corten dev`.
        at.remove("corten-shell");
        (vary_names(&at).contains(&"accept-language".to_string()), at)
    };
    let app = |seen: &Seen| App::new(Routes::from(routes())).middleware(seen.clone());
    let (dev, none) = (Seen::default(), Seen::default());
    let (named, head) = seen(app(&dev).dev(true).router(), dev).await;
    assert!(!named, "under corten dev the middleware sees no language named yet: {head:?}");
    assert_eq!((named, head), seen(app(&none).kept_answers(0).dev(true).router(), none).await, "as with no store");
    let release = Seen::default();
    assert!(seen(app(&release).dev(false).router(), release).await.0, "a release build names it where it keeps the page");
}

/// A kept page is given until its lifetime ends, which `.shared(..)` sets for a shared cache and
/// so for the app; then the handler runs again.
#[tokio::test]
async fn a_kept_page_lasts_its_lifetime() {
    let runs = Runs::default();
    let counted = runs.clone();
    let brief = move |req: Req| {
        counted.ran();
        async move {
            let page = req.test_page_for("Brief", html! { <p>"brief"</p> });
            Public::new(Duration::from_secs(600), page).shared(Duration::from_secs(1))
        }
    };
    let long = |req: Req| async move { Public::new(Duration::from_secs(60), req.test_page_for("Long", html! { <p>"long"</p> })) };
    let slow = |req: Req| async move {
        tokio::time::sleep(Duration::from_millis(1100)).await;
        Public::new(Duration::from_secs(60), req.test_page_for("Slow", html! { <p>"slow"</p> }))
    };
    let routes = Table::new()
        .route("/", crate::route::get(brief).0)
        .route("/long", crate::route::get(long).0)
        .route("/slow", crate::route::get(slow).0);
    let router = App::new(Routes::from(routes)).router();
    let making = tokio::spawn({
        let router = router.clone();
        async move { fetch(&router, "GET", "/slow", &[]).await }
    });
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=600, s-maxage=1");
    fetch(&router, "GET", "/long", &[]).await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert!(runs.count() == 2 && !headers.contains_key(header::AGE), "past the shared lifetime: {headers:?}");
    // One still within its lifetime says how long ago its handler was asked.
    let (_, headers, _) = fetch(&router, "GET", "/long", &[]).await;
    let age: u64 = headers[header::AGE].to_str().unwrap().parse().unwrap();
    assert!((1..60).contains(&age), "{age}");
    // And the time its handler took is part of its age: the page is as old as what was read.
    assert!(!making.await.unwrap().1.contains_key(header::AGE));
    let (_, headers, _) = fetch(&router, "GET", "/slow", &[]).await;
    let age: u64 = headers[header::AGE].to_str().unwrap().parse().unwrap();
    assert!((1..60).contains(&age), "counted from before its handler ran: {age}");
}

/// A page is kept for the `Host` it was asked with, and for the `Accept-Language` when its
/// language follows the header (its `Vary` names the header then).
#[tokio::test]
async fn a_kept_page_is_for_the_host_and_the_language_it_was_asked_in() {
    crate::i18n::messages! { struct KeptMsg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
    let runs = Runs::default();
    let one = App::new(Routes::from(kept_routes(&runs))).router();
    for (asked, ran) in [
        (("host", "localhost"), 1),
        (("host", "127.0.0.1"), 2),
        (("host", "localhost"), 2),
        (("accept-language", "fr"), 3),
        (("accept-language", "de"), 3),
    ] {
        fetch(&one, "GET", "/", &[asked]).await;
        assert_eq!(runs.count(), ran, "{asked:?}: one language, so the header is not read");
    }

    let runs = Runs::default();
    let counted = runs.clone();
    let page = move |req: Req| {
        counted.ran();
        async move {
            let lang = req.lang();
            Public::new(Duration::from_secs(60), req.test_page_for("Lang", html! { <p>"in "{lang}</p> }))
        }
    };
    let two = App::new(Routes::from(Table::new().route("/", crate::route::get(page).0))).messages::<KeptMsg>().router();
    for (asked, lang, ran) in [("fr", "fr", 1), ("en", "en", 2), ("fr", "fr", 2), ("en", "en", 2), ("fr-CA, en;q=0.5", "fr", 3)] {
        let (_, headers, body) = fetch(&two, "GET", "/", &[("accept-language", asked)]).await;
        assert_eq!(headers[header::VARY], "corten, accept, accept-language");
        assert!(String::from_utf8_lossy(&body).contains(&format!("<p>in {lang}</p>")), "{asked}");
        assert_eq!(runs.count(), ran, "{asked}");
    }
    let (_, _, body) = fetch(&two, "GET", "/", &[]).await;
    assert!(String::from_utf8_lossy(&body).contains("<p>in en</p>") && runs.count() == 4, "none asked for is its own");
    // More ways of asking than a URL has copies for: each new one takes the oldest's place.
    let asked = |n: usize| format!("en, x-{n};q=0.1");
    for n in 0..=8 {
        fetch(&two, "GET", "/", &[("accept-language", &asked(n))]).await;
    }
    assert_eq!(runs.count(), 13);
    fetch(&two, "GET", "/", &[("accept-language", &asked(8))]).await;
    assert_eq!(runs.count(), 13, "the newest is kept");
    fetch(&two, "GET", "/", &[("accept-language", &asked(0))]).await;
    assert_eq!(runs.count(), 14, "the oldest went");

    // Messages read with no `App::messages`: the page is in the language asked for, and its
    // `Vary` says so, so it is kept for each.
    let runs = Runs::default();
    let counted = runs.clone();
    let page = move |req: Req| {
        counted.ran();
        async move {
            let t: KeptMsg = req.t();
            let listings = t.item_listings().to_string();
            Public::new(Duration::from_secs(60), req.test_page_for("Words", html! { <p>{listings}</p> }))
        }
    };
    let bare = App::new(Routes::from(Table::new().route("/", crate::route::get(page).0))).router();
    for (asked, word, ran) in [("fr", "Annonces", 1), ("en", "Listings", 2), ("fr", "Annonces", 2), ("en", "Listings", 2)] {
        let (_, _, body) = fetch(&bare, "GET", "/", &[("accept-language", asked)]).await;
        assert!(String::from_utf8_lossy(&body).contains(word), "{asked}");
        assert_eq!(runs.count(), ran, "{asked}");
    }
}

/// An `Accept-Language` a page does not vary on is neither held with it nor counted against its
/// share of the bound, however long: with the least bound whose share holds the page asked for
/// with none, it is kept when asked for with a long one too. A page that varies on the header is
/// kept for it, and there the header counts: the long one takes it over that share.
#[tokio::test]
async fn an_accept_language_a_page_does_not_vary_on_does_not_count_against_it() {
    crate::i18n::messages! { struct LongMsg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
    /// Whether the page at `/` is kept, asked for twice with `language` (none when empty).
    async fn kept(router: Router, language: &str) -> bool {
        let asked: &[(&'static str, &str)] = if language.is_empty() { &[] } else { &[("accept-language", language)] };
        fetch(&router, "GET", "/", asked).await;
        fetch(&router, "GET", "/", asked).await.1.contains_key(header::AGE)
    }
    /// The least bound whose share (an eighth) holds the page asked for with no `Accept-Language`.
    async fn least(app: impl Fn(usize) -> Router) -> usize {
        let (mut low, mut high) = (0, 1 << 16);
        assert!(kept(app(high * 8), "").await, "kept under a bound of {}", high * 8);
        while low + 1 < high {
            let mid = (low + high) / 2;
            if kept(app(mid * 8), "").await {
                high = mid;
            } else {
                low = mid;
            }
        }
        high * 8
    }
    // A browser's list is short; one this long is what a client can send.
    let long = format!("en, {}", (0..80).map(|n| format!("x-{n:02};q=0.1")).collect::<Vec<_>>().join(", "));
    let one = |bound| App::new(Routes::from(kept_routes(&Runs::default()))).kept_answers(bound).router();
    let bound = least(one).await;
    assert!(kept(one(bound), &long).await, "a page that does not vary on the header, under a bound of {bound}");

    let page = |req: Req| async move {
        let lang = req.lang();
        Public::new(Duration::from_secs(60), req.test_page_for("Lang", html! { <p>"in "{lang}</p> }))
    };
    let two = |bound| {
        App::new(Routes::from(Table::new().route("/", crate::route::get(page).0)))
            .messages::<LongMsg>()
            .kept_answers(bound)
            .router()
    };
    let bound = least(two).await;
    assert!(!kept(two(bound), &long).await, "a page that varies on the header is kept with it, and it counts");
    assert!(kept(two(bound + long.len() * 8), &long).await, "and kept with the room for it");
}

/// A kept copy's URL counts once against its share of the bound: for the same page asked for at
/// two URLs whose queries differ by `n` bytes, the least bound that keeps it differs by `n` bytes
/// of its share (an eighth), `8 * n`. A URL counted twice, by the entry and by the table, would
/// make it `16 * n`.
#[tokio::test]
async fn a_kept_url_counts_once_against_its_share_of_the_bound() {
    /// Whether the page at `at` is kept under `bound`, asked for twice.
    async fn kept(bound: usize, at: &str) -> bool {
        let router = App::new(Routes::from(kept_routes(&Runs::default()))).kept_answers(bound).router();
        fetch(&router, "GET", at, &[]).await;
        fetch(&router, "GET", at, &[]).await.1.contains_key(header::AGE)
    }
    /// The least bound, a multiple of its share's eight, that keeps the page at `at`.
    async fn least(at: &str) -> usize {
        let (mut low, mut high) = (0, 1 << 16);
        assert!(kept(high * 8, at).await, "kept at {at} under a bound of {}", high * 8);
        while low + 1 < high {
            let mid = (low + high) / 2;
            if kept(mid * 8, at).await {
                high = mid;
            } else {
                low = mid;
            }
        }
        high * 8
    }
    let short = least("/?q=a").await;
    for n in [1, 37, 300] {
        let at = format!("/?q=a{}", "b".repeat(n));
        assert_eq!(least(&at).await - short, 8 * n, "a query {n} bytes longer");
    }
}

/// Messages read with no `App::messages` are in the language `Accept-Language` asks for, so the
/// answer's `Vary` names the header, for a cache in front as for the app's own: in the document
/// and in a navigation's swap, and on the kept copy. A page of the same app that reads none does
/// not vary on it.
#[tokio::test]
async fn a_page_that_draws_messages_without_app_messages_varies_on_accept_language() {
    let minute = Duration::from_secs(60);
    let words = move |req: Req| async move {
        let t: WordsMsg = req.t();
        let listings = t.item_listings().to_string();
        Public::new(minute, req.test_page_for("Words", html! { <p>{listings}</p> }))
    };
    let plain = move |req: Req| async move { Public::new(minute, req.test_page_for("Plain", html! { <p>"plain"</p> })) };
    let routes = Table::new().route("/words", crate::route::get(words).0).route("/plain", crate::route::get(plain).0);
    let router = App::new(Routes::from(routes)).router();
    for mode in [None, Some("nav")] {
        for (asked, word) in [("fr", "Annonces"), ("en", "Listings"), ("fr", "Annonces")] {
            let mut sent = vec![("accept-language", asked)];
            sent.extend(mode.map(|mode| ("corten", mode)));
            let (status, headers, body) = fetch(&router, "GET", "/words", &sent).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(headers.contains_key("corten-page"), mode.is_some(), "{mode:?}: swapped in by the runtime");
            assert!(String::from_utf8_lossy(&body).contains(word), "{mode:?} {asked}");
            let vary = vary_names(&headers);
            assert!(vary.iter().any(|name| name == "accept-language"), "{mode:?} {asked}: {vary:?}");
        }
        let mut sent = vec![("accept-language", "fr")];
        sent.extend(mode.map(|mode| ("corten", mode)));
        let (_, headers, _) = fetch(&router, "GET", "/plain", &sent).await;
        let vary = vary_names(&headers);
        assert!(!vary.iter().any(|name| name == "accept-language"), "{mode:?}: {vary:?}");
    }
    let (_, kept, _) = fetch(&router, "GET", "/words", &[("accept-language", "fr")]).await;
    assert!(kept.contains_key(header::AGE), "the kept copy");
    assert!(vary_names(&kept).iter().any(|name| name == "accept-language"), "{kept:?}");
}

/// A handler that reads its messages after it built its page (here, to choose which of two to
/// give) still answers in the language asked for: the dependency is settled when its answer is
/// finished, so the kept copy is keyed on `Accept-Language` and its `Vary` names it on the wire.
#[tokio::test]
async fn a_late_message_read_is_kept_and_sent_for_its_language() {
    let runs = Runs::default();
    let counted = runs.clone();
    let page = move |req: Req| {
        counted.ran();
        async move {
            let english = req.test_page_for("Words", html! { <p>"Listings"</p> });
            let french = req.test_page_for("Words", html! { <p>"Annonces"</p> });
            // Negotiated only now, after both pages set their headers.
            let t: WordsMsg = req.t();
            let page = if t.item_listings() == "Annonces" { french } else { english };
            Public::new(Duration::from_secs(60), page)
        }
    };
    let router = App::new(Routes::from(Table::new().route("/", crate::route::get(page).0))).router();
    let mut sent = Vec::new();
    for (asked, word, ran) in [("fr", "Annonces", 1), ("en", "Listings", 2), ("fr", "Annonces", 2), ("en", "Listings", 2)] {
        let (status, headers, body) = fetch(&router, "GET", "/", &[("accept-language", asked)]).await;
        assert_eq!(status, StatusCode::OK);
        assert!(String::from_utf8_lossy(&body).contains(word), "{asked}: {}", String::from_utf8_lossy(&body));
        assert_eq!(runs.count(), ran, "{asked}");
        sent.push(headers);
    }
    // And a cache in front is told, on the answer made and on the kept copy given, beside the
    // fields the page named itself.
    for headers in sent {
        let vary = vary_names(&headers);
        for name in ["corten", "accept", "accept-language"] {
            assert!(vary.iter().any(|named| named == name), "{name}: {vary:?}");
        }
    }
}

/// A middleware that puts its own `Vary` on the answer after `next`, without reading messages,
/// does not take the language away from a kept page: the kept copy says it was made for its
/// `Accept-Language`, so the last stage names the header again, on the hit as on the miss. A
/// language not kept yet is made for itself.
#[tokio::test]
async fn a_kept_page_names_its_language_after_a_middleware_replaced_vary() {
    struct Replaces;

    impl crate::Middleware for Replaces {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let mut res = next.run(req).await;
            res.headers_mut().insert(header::VARY, HeaderValue::from_static("corten, accept"));
            res
        }
    }

    let runs = Runs::default();
    let counted = runs.clone();
    let page = move |req: Req| {
        counted.ran();
        async move {
            let t: WordsMsg = req.t();
            let listings = t.item_listings().to_string();
            Public::new(Duration::from_secs(60), req.test_page_for("Words", html! { <p>{listings}</p> }))
        }
    };
    let router = App::new(Routes::from(Table::new().route("/", crate::route::get(page).0))).middleware(Replaces).router();
    for (asked, word, ran, hit) in [("fr", "Annonces", 1, false), ("fr", "Annonces", 1, true), ("en", "Listings", 2, false)] {
        let (status, headers, body) = fetch(&router, "GET", "/", &[("accept-language", asked)]).await;
        assert_eq!(status, StatusCode::OK);
        assert!(String::from_utf8_lossy(&body).contains(word), "{asked}: {}", String::from_utf8_lossy(&body));
        assert_eq!((runs.count(), headers.contains_key(header::AGE)), (ran, hit), "{asked}: {headers:?}");
        names_once(&headers, &["corten", "accept", "accept-language"], &format!("{asked}, kept {hit}"));
    }
}

/// A middleware that reads messages after `next` makes the answer depend on the language, on the
/// kept page given in the handler's place as on the one made, though the page itself is one for
/// every language: its `Vary` names `Accept-Language` once, beside the page's own fields.
#[tokio::test]
async fn a_middleware_that_reads_messages_after_next_names_the_language_on_a_kept_page() {
    struct Labels;

    impl crate::Middleware for Labels {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            use crate::extract::FromRequestParts;
            let (mut parts, body) = req.into_parts();
            let words = Req::from_request_parts(&mut parts, &()).await.unwrap();
            let mut res = next.run(Request::from_parts(parts, body)).await;
            let t: WordsMsg = words.t();
            res.headers_mut().insert("x-listings", HeaderValue::from_str(t.item_listings()).unwrap());
            res
        }
    }

    let runs = Runs::default();
    let counted = runs.clone();
    let page = move |req: Req| {
        counted.ran();
        async move { Public::new(Duration::from_secs(60), req.test_page_for("Plain", html! { <p>"plain"</p> })) }
    };
    let router = App::new(Routes::from(Table::new().route("/", crate::route::get(page).0))).middleware(Labels).router();
    for (asked, word, hit) in [("fr", "Annonces", false), ("fr", "Annonces", true), ("en", "Listings", true)] {
        let (status, headers, _) = fetch(&router, "GET", "/", &[("accept-language", asked)]).await;
        assert_eq!((status, runs.count(), headers.contains_key(header::AGE)), (StatusCode::OK, 1, hit), "{asked}: {headers:?}");
        assert_eq!(headers["x-listings"], word);
        names_once(&headers, &["corten", "accept", "accept-language"], &format!("{asked}, kept {hit}"));
    }
}

/// A page that read its messages after it was built, asked for with `HEAD` and revalidated with
/// the tag it was given (here from its kept copy), names `Accept-Language` on each: a `HEAD`
/// has its `GET`'s headers and a `304` varies as its `200`.
#[tokio::test]
async fn a_localized_head_and_its_304_name_accept_language() {
    let page = |req: Req| async move { Public::new(Duration::from_secs(60), late_words(&req)) };
    let router = App::new(Routes::from(Table::new().route("/", crate::route::get(page).0))).router();
    let french = ("accept-language", "fr");
    // A tag the page does not have, so the answer is tagged without being compressed.
    let (status, got, body) = fetch(&router, "GET", "/", &[french, ("if-none-match", "\"other\"")]).await;
    assert!(status == StatusCode::OK && String::from_utf8_lossy(&body).contains("Annonces"), "{got:?}");
    let tag = got[header::ETAG].to_str().unwrap().to_string();
    let (status, head, body) = fetch(&router, "HEAD", "/", &[french]).await;
    assert_eq!((status, body.len()), (StatusCode::OK, 0), "{head:?}");
    let (status, revalidated, body) = fetch(&router, "GET", "/", &[french, ("if-none-match", &tag)]).await;
    assert_eq!((status, body.len()), (StatusCode::NOT_MODIFIED, 0), "{revalidated:?}");
    assert!(revalidated.contains_key(header::AGE), "revalidated against the kept copy: {revalidated:?}");
    for (case, headers) in [("GET", &got), ("HEAD", &head), ("304", &revalidated)] {
        names_once(headers, &["corten", "accept", "accept-language"], case);
    }
}

/// `accept-language` is added once, on a line of its own, beside the `Vary` lines the answer
/// already has, and not at all when one of them names it in another case or padded with spaces
/// and tabs among other names. A `Vary: *` is left as it is. A patch and a streamed answer that
/// negotiated their messages before answering name it too.
#[tokio::test]
async fn the_language_is_named_once_beside_the_answer_s_own_vary() {
    let with = |extra: &'static str| {
        move |req: Req| async move {
            let page: HtmlResult = late_words(&req).map(|mut page| {
                page.headers_mut().append(header::VARY, HeaderValue::from_static(extra));
                page
            });
            page
        }
    };
    let patch = |req: Req| async move {
        let t: WordsMsg = req.t();
        let listings = t.item_listings().to_string();
        let patched: HtmlResult = req.action().ok_or_else(crate::Error::not_found)?.patch(html! { <p id={MsgId}>{listings}</p> });
        patched
    };
    let stream = |req: Req| async move {
        let t: WordsMsg = req.t();
        let chunk = Ok::<_, std::convert::Infallible>(bytes::Bytes::from(format!("<p>{}</p>", t.item_listings())));
        ([(header::CONTENT_TYPE, "text/html")], Body::from_stream(futures_util::stream::iter([chunk])))
    };
    let star = |req: Req| async move {
        let page: HtmlResult = late_words(&req).map(|mut page| {
            page.headers_mut().insert(header::VARY, HeaderValue::from_static("*"));
            page
        });
        page
    };
    let routes = Table::new()
        .route("/tenant", crate::route::get(with("X-Tenant")).0)
        .route("/mixed", crate::route::get(with("Accept-Language")).0)
        .route("/padded", crate::route::get(with("X-Tenant , \tAccept-LANGUAGE\t ")).0)
        .route("/star", get(star))
        .route("/patch", get(patch))
        .route("/stream", get(stream));
    let router = App::new(Routes::from(routes)).router();
    for (uri, mode, lines) in [
        ("/tenant", None, &["corten, accept", "X-Tenant", "accept-language"][..]),
        ("/mixed", None, &["corten, accept", "Accept-Language"][..]),
        ("/padded", None, &["corten, accept", "X-Tenant , \tAccept-LANGUAGE\t "][..]),
        ("/patch", Some("action"), &[][..]),
        ("/stream", None, &[][..]),
    ] {
        let mut sent = vec![("accept-language", "fr")];
        sent.extend(mode.map(|mode| ("corten", mode)));
        let (status, headers, body) = fetch(&router, "GET", uri, &sent).await;
        assert!(status == StatusCode::OK && String::from_utf8_lossy(&body).contains("Annonces"), "{uri}: {headers:?}");
        let had: Vec<_> = headers.get_all(header::VARY).iter().map(|line| line.to_str().unwrap()).collect();
        assert_eq!(&had[..lines.len()], lines, "{uri}");
        names_once(&headers, &["accept-language"], uri);
    }
    // A negotiated answer that varies on everything says nothing more.
    let (status, headers, body) = fetch(&router, "GET", "/star", &[("accept-language", "fr")]).await;
    assert!(status == StatusCode::OK && String::from_utf8_lossy(&body).contains("Annonces"), "{headers:?}");
    let had: Vec<_> = headers.get_all(header::VARY).iter().map(|line| line.to_str().unwrap()).collect();
    assert_eq!(had, ["*"]);
}

/// A `Public` page that read its messages before it was built names the language on its own first
/// line, which is left as it is; a line the page added after it (`X-Tenant`) still reaches the
/// wire, and keeps the page from being kept, since its key does not cover the app's header.
#[tokio::test]
async fn a_later_vary_line_after_the_page_s_own_survives_and_is_not_kept() {
    let runs = Runs::default();
    let counted = runs.clone();
    let page = move |req: Req| {
        counted.ran();
        async move {
            let t: WordsMsg = req.t();
            let listings = t.item_listings().to_string();
            let page = req.test_page_for("Words", html! { <p>{listings}</p> }).map(|mut page| {
                page.headers_mut().append(header::VARY, HeaderValue::from_static("X-Tenant"));
                page
            });
            Public::new(Duration::from_secs(60), page)
        }
    };
    let router = App::new(Routes::from(Table::new().route("/", crate::route::get(page).0))).router();
    for ran in [1, 2] {
        let (status, headers, body) = fetch(&router, "GET", "/", &[("accept-language", "fr")]).await;
        assert!(status == StatusCode::OK && String::from_utf8_lossy(&body).contains("Annonces"), "{headers:?}");
        assert_eq!((runs.count(), headers.contains_key(header::AGE)), (ran, false), "{headers:?}");
        let had: Vec<_> = headers.get_all(header::VARY).iter().map(|line| line.to_str().unwrap()).collect();
        assert_eq!(&had[..2], ["corten, accept, accept-language", "X-Tenant"], "run {ran}");
        names_once(&headers, &["corten", "accept", "accept-language", "x-tenant"], &format!("run {ran}"));
    }
}

/// The same constant error page with and without a caller extractor. Neither puts visitor data
/// in the answer; only one reads who the page is for.
fn denied_page_app(read_caller: bool) -> Router {
    let routes = Table::new().route("/", get(|| async { "home" }).post(|| async { "saved" }));
    let app = App::new(Routes::from(routes)).api(|routes| api_module::api(routes, 100));
    let page = |req: Req| req.test_page("Denied", html! { <p>"Write declined."</p> });
    if read_caller {
        app.error_page(move |_: Failure, req: Req, _: Option<crate::Caller<Viewer>>| async move { page(req) }, ()).router()
    } else {
        app.error_page(move |_: Failure, req: Req| async move { page(req) }, ()).router()
    }
}

async fn denied_write(router: &Router, path: &str, accept: &'static str) -> Response {
    let req = Request::post(path).header("sec-fetch-site", "cross-site").header(header::ACCEPT, accept);
    router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap()
}

#[tokio::test]
async fn a_refused_write_marks_only_the_error_page_that_read_the_caller() {
    for read_caller in [false, true] {
        let router = denied_page_app(read_caller);
        for (path, accept, html) in
            [("/", "text/html", true), ("/", "application/json", false), ("/v1/items/7", "text/html", false)]
        {
            let (parts, body) = denied_write(&router, path, accept).await.into_parts();
            let body = body.collect().await.unwrap().to_bytes();
            assert_eq!(parts.status, StatusCode::FORBIDDEN);
            assert_eq!(String::from_utf8_lossy(&body).contains("Write declined."), html);
            assert_eq!(parts.headers[header::CACHE_CONTROL], "private, no-cache");
            assert!(CDN_OVERRIDES.iter().all(|name| !parts.headers.contains_key(*name)));
            assert!(parts.extensions.get::<crate::cache::Unshared>().is_some());
            assert_eq!(parts.extensions.get::<crate::cache::Personal>().is_some(), read_caller && html, "{path} {accept}");
        }
    }
}

/// A cross-site write refused with the app's error page, which reads its messages after it built
/// its page, names `Accept-Language` as any other answer does.
#[tokio::test]
async fn a_refused_write_s_error_page_names_the_language_it_read_late() {
    async fn late_error_page(_: Failure, req: Req) -> HtmlResult {
        late_words(&req)
    }
    let routes = Table::new().route(
        "/",
        get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) }).post(|| async { StatusCode::OK }),
    );
    let router = App::new(Routes::from(routes)).error_page(late_error_page, ()).router();
    for (asked, word) in [("fr", "Annonces"), ("en", "Listings")] {
        let sent = [
            ("origin", "https://evil.example"),
            ("sec-fetch-site", "cross-site"),
            ("accept", "text/html"),
            ("accept-language", asked),
        ];
        let (status, headers, body) = fetch(&router, "POST", "/", &sent).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(String::from_utf8_lossy(&body).contains(word), "{asked}: {}", String::from_utf8_lossy(&body));
        names_once(&headers, &["corten", "accept", "accept-language"], asked);
    }
}

/// Both pages built before the messages are read, then the one in the language asked for.
fn late_words<For>(req: &Req) -> crate::Result<HtmlResponse<For>> {
    let english = req.test_page_for("Words", html! { <p>"Listings"</p> });
    let french = req.test_page_for("Words", html! { <p>"Annonces"</p> });
    let t: WordsMsg = req.t();
    if t.item_listings() == "Annonces" {
        french
    } else {
        english
    }
}

/// Each of `names` is on the answer's `Vary` exactly once, in any case, over all its lines.
fn names_once(headers: &HeaderMap, names: &[&str], case: &str) {
    let vary = vary_names(headers);
    for name in names {
        assert_eq!(vary.iter().filter(|named| named.as_str() == *name).count(), 1, "{case} {name}: {vary:?}");
    }
}

/// Answers other than a `Public` page that negotiate their messages from `Accept-Language` in an
/// app without `App::messages` say so too: the error page, a page drawn with a notice it was sent
/// back, and a redirect chosen by the language (which says so with `App::messages` as well).
#[tokio::test]
async fn other_answers_that_negotiate_messages_vary_on_accept_language() {
    let noticed = |req: Req| async move {
        let notice = req.notice();
        let t: WordsMsg = req.t();
        let listings = t.item_listings().to_string();
        req.test_page("Done", html! { <p>{notice}" "{listings}</p> })
    };
    let go = |req: Req| async move {
        let t: WordsMsg = req.t();
        let moved: HtmlResult = if t.item_listings() == "Annonces" { req.moved(&FrenchWords) } else { req.moved(&EnglishWords) };
        moved
    };
    let routes = Table::new().route("/done", get(noticed)).route("/go", get(go));
    let router = App::new(Routes::from(routes)).error_page(words_error_page, ()).router();

    let (status, headers, body) = fetch(&router, "GET", "/nope", &[("accept-language", "fr")]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(String::from_utf8_lossy(&body).contains("Annonces"), "the error page in French");
    assert!(vary_names(&headers).iter().any(|name| name == "accept-language"), "{headers:?}");

    let sent = [("accept-language", "fr"), ("corten-notice", "p=%2Fdone&m=Saved"), ("sec-fetch-site", "same-origin")];
    let (_, headers, body) = fetch(&router, "GET", "/done", &sent).await;
    assert!(String::from_utf8_lossy(&body).contains("<p>Saved Annonces</p>"), "{}", String::from_utf8_lossy(&body));
    let vary = vary_names(&headers);
    for name in ["corten", "accept", "accept-language", "corten-notice"] {
        assert!(vary.iter().any(|named| named == name), "{name}: {vary:?}");
    }

    // With `App::messages` as without: a redirect is not a page, so nothing else names it.
    let with = App::new(Routes::from(Table::new().route("/go", get(go)))).messages::<WordsMsg>().router();
    for router in [&router, &with] {
        for (asked, to) in [("fr", "/fr/words"), ("en", "/en/words")] {
            let (status, headers, _) = fetch(router, "GET", "/go", &[("accept-language", asked)]).await;
            assert_eq!((status, headers[header::LOCATION].to_str().unwrap()), (StatusCode::MOVED_PERMANENTLY, to));
            let vary = vary_names(&headers);
            assert!(vary.iter().any(|name| name == "corten") && vary.iter().any(|name| name == "accept-language"), "{vary:?}");
        }
    }
}

/// A screen's JSON for a data client, and a `Public` JSON answer of an `App::api` mount, name
/// `Accept-Language` when they read messages in its language, with `App::messages` or without.
#[cfg(feature = "json")]
#[tokio::test]
async fn json_that_negotiates_messages_varies_on_accept_language() {
    let routes = || Table::new().route("/screen", get(words_screen));
    let bare = App::new(Routes::from(routes())).api(words_api::api).router();
    let with = App::new(Routes::from(routes())).messages::<WordsMsg>().api(words_api::api).router();
    for router in [&bare, &with] {
        for (asked, word) in [("fr", "Annonces"), ("en", "Listings")] {
            let sent = [("accept-language", asked), ("accept", "application/json")];
            let (status, headers, body) = fetch(router, "GET", "/screen", &sent).await;
            assert_eq!((status, headers[header::CONTENT_TYPE].to_str().unwrap()), (StatusCode::OK, "application/json"));
            assert_eq!(body, format!(r#"{{"title":"Words","data":{{"listings":"{word}"}}}}"#));
            assert!(vary_names(&headers).iter().any(|name| name == "accept-language"), "{headers:?}");

            let (status, headers, body) = fetch(router, "GET", "/words-api/listings", &[("accept-language", asked)]).await;
            assert_eq!((status, body), (StatusCode::OK, bytes::Bytes::from(format!(r#""{word}""#))));
            assert!(headers[header::CACHE_CONTROL].to_str().unwrap().starts_with("public"), "{headers:?}");
            assert!(vary_names(&headers).iter().any(|name| name == "accept-language"), "{asked}: {headers:?}");
        }
    }
}

/// The names an answer's `Vary` lines list, lowercased.
fn vary_names(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(header::VARY)
        .iter()
        .flat_map(|line| line.to_str().unwrap().split(',').map(|name| name.trim().to_ascii_lowercase()).collect::<Vec<_>>())
        .collect()
}

crate::i18n::messages! { struct WordsMsg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }

/// Where a redirect chosen by the language goes.
#[derive(crate::Route)]
#[route("/fr/words")]
struct FrenchWords;

#[derive(crate::Route)]
#[route("/en/words")]
struct EnglishWords;

/// An error page in the language asked for.
async fn words_error_page(_: Failure, req: Req) -> HtmlResult {
    let t: WordsMsg = req.t();
    let listings = t.item_listings().to_string();
    req.test_page("Missing", html! { <p>{listings}</p> })
}

#[cfg(feature = "json")]
#[derive(crate::json::ToJson)]
struct ShownWords {
    listings: String,
}

/// A screen whose data is in the language asked for.
#[cfg(feature = "json")]
async fn words_screen(req: Req) -> HtmlResult<crate::Screen<ShownWords>> {
    let t: WordsMsg = req.t();
    let shown = ShownWords { listings: t.item_listings().to_string() };
    let main = shown.listings.clone();
    let doc = html! {
        <html>
            <head>
                <title>"Words"</title>
                <Corten />
            </head>
            <body><main>{main}</main></body>
        </html>
    };
    req.screen(&shown, doc)
}

/// A `Public` JSON answer in the language asked for.
#[cfg(feature = "json")]
#[crate::routes(api = WordsApi)]
mod words_api {
    #[route("/words-api")]
    pub struct WordsApi;

    #[route("/words-api/listings", get = api_listings)]
    pub struct ApiListings;
}

#[cfg(feature = "json")]
async fn api_listings(req: Req) -> Public<crate::JsonResult<String>> {
    let t: WordsMsg = req.t();
    let listings: crate::JsonResult<String> = Ok(crate::Json(t.item_listings().to_string()));
    Public::new(Duration::from_secs(60), listings)
}
/// A page whose styles come from data has a style block its `Content-Security-Policy` allows by
/// hash: the kept page is sent with the same policy, so the block still applies.
#[tokio::test]
async fn a_kept_page_keeps_the_hash_its_policy_allows_its_style_block_by() {
    let page = |req: Req| async move {
        Public::new(Duration::from_secs(60), req.test_page_for("Meters", html! { <TestMeter used={42.5} /> }))
    };
    let router = App::new(Routes::from(Table::new().route("/", crate::route::get(page).0))).components(&[TestMeter]).router();
    let (_, first, body) = fetch(&router, "GET", "/", &[]).await;
    let (_, again, same) = fetch(&router, "GET", "/", &[]).await;
    let policy = first[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    let styles = policy.split(';').find(|part| part.trim_start().starts_with("style-src")).expect("style-src");
    assert!(styles.contains("'sha256-"), "the block's hash: {policy}");
    assert!(again.contains_key(header::AGE) && same == body, "the kept page");
    assert_eq!(again[header::CONTENT_SECURITY_POLICY], policy);
}

// ---- The whole bodies the app keeps: JSON, text and files ----

/// Which answers may be kept as a whole body is known when the app compiles: JSON, text and a
/// file, in a `Result` or not. A page is kept as a page, and a relay or a status is its
/// handler's for every request.
#[test]
fn an_answer_s_type_says_whether_its_body_is_kept() {
    use crate::answer::Answer;
    fn whole<A: Answer>() -> bool {
        A::WHOLE.0
    }
    assert!(whole::<String>() && whole::<&'static str>() && whole::<crate::Result<String>>());
    assert!(whole::<Public<String>>() && whole::<Public<crate::Result<&'static str>>>());
    #[cfg(feature = "json")]
    assert!(whole::<Json<u32>>() && whole::<JsonResult<u32>>() && whole::<Public<JsonResult<u32>>>());
    assert!(whole::<Media>() && whole::<crate::Result<Media>>() && whole::<Public<crate::Result<Media>>>());
    assert!(
        whole::<crate::seo::File>() && whole::<Public<crate::seo::File>>() && whole::<crate::Result<Public<crate::seo::File>>>()
    );
    assert!(!whole::<StatusCode>() && !whole::<NoStore<Media>>());
    assert!(!whole::<crate::Relay>() && !whole::<HtmlResult>() && !whole::<Public<HtmlResult>>());
    assert!(!whole::<NoStore<String>>(), "an answer no cache may store");
    // Bytes the app holds keep their own compressed forms where the build compresses, and are
    // left to their handler in every build.
    #[cfg(feature = "json")]
    assert!(!whole::<Json<crate::json::Raw>>());
}

/// A `Public` JSON answer and a `Public` text answer are made once for their lifetime, as a
/// page is: the next request that shows nothing about who asks gets the same bytes with their
/// age, with the tag and the coded bytes made once, and a write to the path drops them. A
/// request that asks for JSON first is kept too, apart: its handler can read which client asked.
/// Each body here is 1,024 bytes or more, which is what is kept.
#[cfg(feature = "json")]
#[tokio::test]
async fn a_public_json_or_text_answer_is_kept_and_given_again() {
    let minute = Duration::from_secs(60);
    let (runs, texts, modes) = (Runs::default(), Runs::default(), Runs::default());
    let (ran, text_ran, mode_ran) = (runs.clone(), texts.clone(), modes.clone());
    let items = move || {
        ran.ran();
        async move { Public::new(minute, Ok::<_, JsonError>(Json(vec!["kept".repeat(300)]))) }
    };
    let text = move || {
        text_ran.ran();
        async move { Public::new(minute, "kept ".repeat(400)) }
    };
    // Says which client asked, as a handler that takes `Req` can.
    let mode = move |req: Req| {
        mode_ran.ran();
        async move { Public::new(minute, Ok::<_, JsonError>(Json((req.mode == crate::Mode::Data, "mode ".repeat(300))))) }
    };
    let routes = Table::new()
        .route("/items", crate::route::get(items).0.post(|| async { StatusCode::NO_CONTENT }))
        .route("/text", crate::route::get(text).0)
        .route("/mode", crate::route::get(mode).0);
    let router = App::new(Routes::from(routes)).router();

    let (status, first, body) = fetch(&router, "GET", "/items", &[]).await;
    assert_eq!((status, runs.count()), (StatusCode::OK, 1));
    assert_eq!(first[header::CONTENT_TYPE], "application/json");
    assert_eq!(first[header::CACHE_CONTROL], "public, max-age=60");
    assert!(!first.contains_key(header::AGE), "the handler's own answer: {first:?}");
    let (status, mut again, same) = fetch(&router, "GET", "/items", &[]).await;
    assert_eq!((status, runs.count()), (StatusCode::OK, 1), "the kept answer, not the handler");
    assert_eq!(again.remove(header::AGE).expect("a kept answer says how old it is"), "0");
    assert_eq!(again, first, "every other header as the handler's answer had it");
    assert_eq!(same, body);

    // A data client's request is another way of asking: kept, and apart.
    let data = [("accept", "application/json")];
    let (_, asked, same) = fetch(&router, "GET", "/items", &data).await;
    assert!(runs.count() == 2 && !asked.contains_key(header::AGE) && same == body, "{asked:?}");
    let (_, asked, same) = fetch(&router, "GET", "/items", &data).await;
    assert!(runs.count() == 2 && asked.contains_key(header::AGE) && same == body, "{asked:?}");
    // Outside an API the stages take a request for JSON first for one form of a page's URL, which
    // they send for the browser alone. What is kept is the handler's answer, whose key knows the form.
    assert_eq!(asked[header::CACHE_CONTROL], "private, max-age=60");
    for _ in 0..2 {
        let (_, _, plain) = fetch(&router, "GET", "/mode", &[]).await;
        let (_, _, asked) = fetch(&router, "GET", "/mode", &data).await;
        assert!(plain.starts_with(b"[false,") && asked.starts_with(b"[true,"), "each as its handler answered that client");
    }
    assert_eq!(modes.count(), 2, "one run for each way of asking");

    // What the answer could differ for is the handler's, and takes no kept answer's place.
    let mut ran = runs.count();
    for asked in [
        ("cookie", "session=abc"),
        ("authorization", "Bearer t"),
        ("corten", "page"),
        ("corten-notice", "saved"),
        ("last-event-id", "4"),
        ("content-length", "0"),
    ] {
        let (_, headers, _) = fetch(&router, "GET", "/items", &[asked]).await;
        ran += 1;
        assert!(runs.count() == ran && !headers.contains_key(header::AGE), "{asked:?}");
    }
    let (_, headers, _) = fetch(&router, "HEAD", "/items", &[]).await;
    assert!(runs.count() == ran + 1 && !headers.contains_key(header::AGE), "a HEAD is the handler's");
    assert!(fetch(&router, "GET", "/items", &[]).await.1.contains_key(header::AGE));
    // The time zone's cookie says where the visitor is, not who, and a `Public` answer is in UTC.
    let zone = [("cookie", "corten-zone=America/Chicago")];
    assert!(fetch(&router, "GET", "/items", &zone).await.1.contains_key(header::AGE) && runs.count() == ran + 1);
    assert!(fetch(&router, "GET", "/items?page=2", &[]).await.1.get(header::AGE).is_none(), "another query is another answer");

    // A write to the path drops every copy kept there.
    let (status, _, _) = fetch(&router, "POST", "/items", &[("sec-fetch-site", "same-origin")]).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    for asked in [&[][..], &data[..]] {
        assert!(!fetch(&router, "GET", "/items", asked).await.1.contains_key(header::AGE), "{asked:?}");
        assert!(fetch(&router, "GET", "/items", asked).await.1.contains_key(header::AGE), "{asked:?}");
    }

    // Text, with the tag and the coded bytes made once (a coding asked for, so it is tagged).
    let coded = [("accept-encoding", "gzip")];
    let (_, first, body) = fetch(&router, "GET", "/text", &coded).await;
    assert!(first[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/plain"), "{first:?}");
    let (_, mut again, same) = fetch(&router, "GET", "/text", &coded).await;
    assert_eq!(texts.count(), 1);
    assert_eq!(again.remove(header::AGE).expect("kept"), "0");
    assert!(again == first && same == body, "{again:?}");
    let (_, _, third) = fetch(&router, "GET", "/text", &coded).await;
    assert_eq!(third.as_ptr(), same.as_ptr(), "the bytes sent made once");
    // Coded where the build compresses; as they are where it does not, and tagged either way.
    assert_eq!(
        first.get(header::CONTENT_ENCODING).map(HeaderValue::as_bytes),
        cfg!(feature = "compress").then_some(&b"gzip"[..])
    );
    let tag = first[header::ETAG].to_str().unwrap();
    let (status, _, none) = fetch(&router, "GET", "/text", &[("accept-encoding", "gzip"), ("if-none-match", tag)]).await;
    assert!(status == StatusCode::NOT_MODIFIED && none.is_empty() && texts.count() == 1);
}

/// A whole body is kept from 1,024 bytes, in every build. One byte under, the route is its
/// handler's for every request. A kept body is given to a request that accepts no coding too.
#[tokio::test]
async fn a_whole_body_is_kept_from_1024_bytes() {
    let minute = Duration::from_secs(60);
    let runs = Runs::default();
    let (under, at) = (runs.clone(), runs.clone());
    let under = move || {
        under.ran();
        async move { Public::new(minute, "a".repeat(1023)) }
    };
    let at = move || {
        at.ran();
        async move { Public::new(minute, "a".repeat(1024)) }
    };
    let routes = Table::new().route("/under", crate::route::get(under).0).route("/at", crate::route::get(at).0);
    let router = App::new(Routes::from(routes)).router();
    for (path, kept) in [("/under", false), ("/at", true)] {
        for asked in [&[][..], &[("accept-encoding", "gzip")][..]] {
            let before = runs.count();
            let (_, first, body) = fetch(&router, "GET", path, asked).await;
            let (_, again, same) = fetch(&router, "GET", path, asked).await;
            // The first request of all is the handler's; where the body is kept, every one after.
            assert_eq!(first.contains_key(header::AGE), kept && !asked.is_empty(), "{path} {asked:?}: {first:?}");
            assert_eq!(again.contains_key(header::AGE), kept, "{path} {asked:?}: {again:?}");
            assert_eq!(body, same, "{path} {asked:?}");
            // One copy for both ways of asking: the second pair runs no handler where it is kept.
            let ran = if !kept { 2 } else { usize::from(asked.is_empty()) };
            assert_eq!(runs.count() - before, ran, "{path} {asked:?}");
            #[cfg(feature = "compress")]
            assert_eq!(again.contains_key(header::CONTENT_ENCODING), path == "/at" && !asked.is_empty(), "{path}: {again:?}");
        }
    }
}

/// A file is a whole body too. A sitemap and a `Media` are kept from 1,024 bytes, whatever
/// the type (a CSV the app compresses, a picture no build does), and the kept one is sent with
/// what its handler said of it: its type, its file name, how long caches keep it. A file under
/// that size, one with a tag of its handler's own, one sent as a stream, which has no body to
/// hold, and one at a URL that names its content (`Public::immutable`), which has no lifetime
/// to keep it for, are their handlers' for every request.
#[tokio::test]
async fn a_file_is_kept_from_1024_bytes() {
    use crate::seo;
    let minute = Duration::from_secs(60);
    let runs = Runs::default();
    let csv = || "sku,qty\n".repeat(200);
    let (sitemap, robots, cards, mark, picture, export) =
        (runs.clone(), runs.clone(), runs.clone(), runs.clone(), runs.clone(), runs.clone());
    let (paged, chart, tagged, crawlers, flaky) = (runs.clone(), runs.clone(), runs.clone(), runs.clone(), runs.clone());
    let svg = || format!("<svg>{}</svg>", "<g/>".repeat(300));
    // A file with a tag of its handler's own, which the app leaves as it is and does not keep.
    struct ETag;
    impl crate::answer::Header for ETag {
        const NAME: &'static str = "etag";
    }
    let tagged = move || {
        tagged.ran();
        let file = crate::Media::new("text/csv", csv());
        async move { Public::new(minute, file).header::<ETag>(HeaderValue::from_static("\"v1\"")) }
    };
    // A `robots.txt` large enough to keep.
    let crawlers = move || {
        crawlers.ran();
        async move { seo::robots(&["/account/"; 120], None) }
    };
    // A file whose handler fails the first time it is asked.
    let asked = Runs::default();
    let flaky = move || {
        flaky.ran();
        asked.ran();
        let failed = asked.count() == 1;
        let file = if failed { Err(Error::not_found()) } else { Ok(crate::Media::new("text/csv", csv())) };
        async move { Public::new(minute, file) }
    };
    // A sitemap's page, which may not be there: the answer `seo`'s own example gives.
    let paged = move || {
        paged.ran();
        let urls = (0..40).map(|_| seo::SitemapUrl { loc: "https://example.com/cards/7", lastmod: None });
        async move { Ok::<_, Error>(seo::sitemap(urls)) }
    };
    let chart = move || {
        chart.ran();
        async move { Public::new(minute, crate::Media::new("image/svg+xml", svg())) }
    };
    let sitemap = move || {
        sitemap.ran();
        async move { seo::sitemap((0..40).map(|_| seo::SitemapUrl { loc: "https://example.com/cards/7", lastmod: None })) }
    };
    let robots = move || {
        robots.ran();
        async move { seo::robots(&["/account/"], None) }
    };
    let cards = move || {
        cards.ran();
        async move { Public::new(minute, crate::Media::new("text/csv", csv()).attachment("cards.csv")) }
    };
    let mark = move || {
        mark.ran();
        async move { Public::immutable(crate::Media::new("image/svg+xml", svg())) }
    };
    let picture = move || {
        picture.ran();
        async move { Public::new(minute, crate::Media::new("image/png", vec![0x89; 4096])) }
    };
    // A picture one byte under the size a body is kept from.
    let dot = runs.clone();
    let dot = move || {
        dot.ran();
        async move { Public::new(minute, crate::Media::new("image/png", vec![0x89; 1023])) }
    };
    let export = move || {
        export.ran();
        let chunks = futures_util::stream::iter([Ok::<_, std::io::Error>(bytes::Bytes::from(csv()))]);
        async move { Public::new(minute, crate::Media::stream_sized("text/csv", csv().len() as u64, chunks)) }
    };
    let routes = Table::new()
        .route("/sitemap.xml", crate::route::get(sitemap).0)
        .route("/robots.txt", crate::route::get(robots).0)
        .route("/sitemap/2.xml", crate::route::get(paged).0)
        .route("/cards.csv", crate::route::get(cards).0.post(|| async { StatusCode::NO_CONTENT }))
        .route("/chart.svg", crate::route::get(chart).0)
        .route("/tagged.csv", crate::route::get(tagged).0)
        .route("/crawlers/robots.txt", crate::route::get(crawlers).0)
        .route("/flaky.csv", crate::route::get(flaky).0)
        .route("/mark.svg", crate::route::get(mark).0)
        .route("/picture.png", crate::route::get(picture).0)
        .route("/dot.png", crate::route::get(dot).0)
        .route("/export.csv", crate::route::get(export).0);
    let router = App::new(Routes::from(routes)).router();
    for (path, kept) in [
        ("/sitemap.xml", true),
        ("/robots.txt", false),
        ("/sitemap/2.xml", true),
        ("/cards.csv", true),
        ("/chart.svg", true),
        ("/tagged.csv", false),
        ("/crawlers/robots.txt", true),
        ("/mark.svg", false),
        ("/picture.png", true),
        ("/dot.png", false),
        ("/export.csv", false),
    ] {
        let before = runs.count();
        let (status, first, body) = fetch(&router, "GET", path, &[]).await;
        let (_, again, same) = fetch(&router, "GET", path, &[]).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(again.contains_key(header::AGE), kept, "{path}: {again:?}");
        assert_eq!(runs.count() - before, if kept { 1 } else { 2 }, "{path}");
        assert_eq!(body, same, "{path}");
        // Every header of the answer its handler made is on the kept one.
        for (name, value) in first.iter().filter(|(name, _)| *name != header::DATE) {
            assert!(again.get_all(name).iter().any(|sent| sent == value), "{path}: {name}: {value:?} in {again:?}");
        }
    }
    let (_, cards, _) = fetch(&router, "GET", "/cards.csv", &[("accept-encoding", "gzip")]).await;
    assert_eq!(cards[header::CONTENT_TYPE], "text/csv");
    assert_eq!(cards[header::CONTENT_DISPOSITION], "attachment; filename=\"cards.csv\"");
    assert_eq!(cards[header::CACHE_CONTROL], "public, max-age=60");
    assert!(cards.contains_key(header::AGE), "{cards:?}");
    #[cfg(feature = "compress")]
    assert_eq!(cards[header::CONTENT_ENCODING], "gzip");
    // A kept picture is given to a request that names a coding as it is, with a tag, and the
    // tag answers `304` with no handler run: what keeping one is for, since its tag's hash is
    // made for the kept copy and not for each such request.
    let before = runs.count();
    let (_, picture, _) = fetch(&router, "GET", "/picture.png", &[("accept-encoding", "gzip")]).await;
    assert!(picture.contains_key(header::AGE) && !picture.contains_key(header::CONTENT_ENCODING), "{picture:?}");
    let named = [("accept-encoding", "gzip"), ("if-none-match", picture[header::ETAG].to_str().unwrap())];
    let (status, unchanged, none) = fetch(&router, "GET", "/picture.png", &named).await;
    assert_eq!((status, none.len(), runs.count() - before), (StatusCode::NOT_MODIFIED, 0, 0));
    // No coding makes a picture smaller, so neither answer varies on the codings asked for.
    for headers in [&picture, &unchanged] {
        let named =
            headers.get_all(header::VARY).iter().any(|value| value.as_bytes().windows(15).any(|w| w == b"accept-encoding"));
        assert!(!named, "{headers:?}");
    }
    // A file's key is its URL with its query, and a request with a cookie is its handler's.
    let before = runs.count();
    let (_, other, _) = fetch(&router, "GET", "/cards.csv?page=2", &[]).await;
    let (_, again, _) = fetch(&router, "GET", "/cards.csv?page=2", &[]).await;
    let (_, known, _) = fetch(&router, "GET", "/cards.csv", &[("cookie", "sid=1")]).await;
    assert_eq!((other.contains_key(header::AGE), known.contains_key(header::AGE)), (false, false));
    assert!(again.contains_key(header::AGE), "{again:?}");
    assert_eq!(runs.count() - before, 2);
    // A handler that failed is asked again, and what it then makes is kept.
    let before = runs.count();
    let (failed, first, _) = fetch(&router, "GET", "/flaky.csv", &[]).await;
    let (made, second, _) = fetch(&router, "GET", "/flaky.csv", &[]).await;
    let (_, third, _) = fetch(&router, "GET", "/flaky.csv", &[]).await;
    assert_eq!((failed, made), (StatusCode::NOT_FOUND, StatusCode::OK));
    assert_eq!((first.contains_key(header::AGE), second.contains_key(header::AGE)), (false, false));
    assert!(third.contains_key(header::AGE), "{third:?}");
    assert_eq!(runs.count() - before, 2);
    let (_, mark, _) = fetch(&router, "GET", "/mark.svg", &[]).await;
    assert_eq!(mark[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
    assert_eq!(mark[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    // A file larger than an eighth of what the app keeps is its handler's, as a page that large
    // is: a picture of 8,192 bytes where the app keeps 64 KiB (its headers count toward its size
    // too, so it is over the eighth and under a quarter), beside one of 4,096 that is kept.
    let sized = |length: usize| move || async move { Public::new(minute, crate::Media::new("image/png", vec![0x89; length])) };
    let bounded =
        Table::new().route("/large.png", crate::route::get(sized(8192)).0).route("/small.png", crate::route::get(sized(4096)).0);
    let bounded = App::new(Routes::from(bounded)).kept_answers(64 * 1024).router();
    for (path, kept) in [("/large.png", false), ("/small.png", true)] {
        fetch(&bounded, "GET", path, &[]).await;
        assert_eq!(fetch(&bounded, "GET", path, &[]).await.1.contains_key(header::AGE), kept, "{path}");
    }
    // A kept file is a kept answer in every other way: its tag answers `304`, a `HEAD` is its
    // handler's, and a write to its path drops it.
    {
        let named = [("accept-encoding", "gzip"), ("if-none-match", cards[header::ETAG].to_str().unwrap())];
        let before = runs.count();
        let (status, unchanged, body) = fetch(&router, "GET", "/cards.csv", &named).await;
        assert_eq!((status, body.len(), runs.count() - before), (StatusCode::NOT_MODIFIED, 0, 0), "{unchanged:?}");
        let (status, head, _) = fetch(&router, "HEAD", "/cards.csv", &[]).await;
        assert_eq!((status, head.contains_key(header::AGE), runs.count() - before), (StatusCode::OK, false, 1));
        let (status, ..) = fetch(&router, "POST", "/cards.csv", &[("sec-fetch-site", "same-origin")]).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, made, _) = fetch(&router, "GET", "/cards.csv", &[]).await;
        assert_eq!((made.contains_key(header::AGE), runs.count() - before), (false, 2), "made again after the write");
        let (_, kept, _) = fetch(&router, "GET", "/cards.csv", &[]).await;
        assert_eq!((kept.contains_key(header::AGE), runs.count() - before), (true, 2), "and kept again");
    }
}

/// A route whose bodies are all too small to keep stops asking the store after 64 in a row, and
/// is its handler's as it was before the app kept bodies, but for about one request in 256,
/// which asks as before: so a route whose bodies grew is found out, and kept again. A
/// body large enough ends a run and so does one given from the store, so a route that answers
/// both sizes keeps asking while one of those comes within each 64, also once its large bodies
/// are all kept and only the small are made.
#[tokio::test]
async fn a_route_of_small_bodies_leaves_the_store_out_until_one_is_large_enough() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let minute = Duration::from_secs(60);
    let size = std::sync::Arc::new(AtomicUsize::new(8));
    let runs = Runs::default();
    let (ran, sized) = (runs.clone(), size.clone());
    let body = move || {
        ran.ran();
        let size = sized.load(Ordering::Relaxed);
        async move { Public::new(minute, "a".repeat(size)) }
    };
    let routes = Table::new().route("/body", crate::route::get(body).0);
    let router = App::new(Routes::from(routes)).router();
    let asked = |router: Router| async move { fetch(&router, "GET", "/body", &[]).await.1.contains_key(header::AGE) };
    let other = |router: Router, n: usize| async move {
        fetch(&router, "GET", &format!("/body?n={n}"), &[]).await.1.contains_key(header::AGE)
    };
    // This thread leaves 255 requests to their handlers before one asks, whatever it drew before.
    crate::kept::Unkept::leaves_next(255);

    // 63 small bodies and a large one: the run ended, and the large one is kept and given.
    for _ in 0..63 {
        assert!(!asked(router.clone()).await);
    }
    size.store(2048, Ordering::Relaxed);
    assert!(!asked(router.clone()).await && asked(router.clone()).await, "kept, after 63 small bodies");
    assert_eq!(runs.count(), 64);
    // The large one ended the run: 63 more small bodies, at other URLs of the route so the kept
    // body stands. The kept body given ends that run too, so after 63 more the route still
    // asks, and a large body is kept.
    size.store(8, Ordering::Relaxed);
    for n in 0..63 {
        assert!(!other(router.clone(), n).await);
    }
    assert!(asked(router.clone()).await, "the kept body, between two runs of small ones");
    for n in 100..163 {
        assert!(!other(router.clone(), n).await);
    }
    size.store(2048, Ordering::Relaxed);
    assert!(!other(router.clone(), 50).await && other(router.clone(), 50).await, "the route still asks");
    // 64 small bodies in a row follow.
    size.store(8, Ordering::Relaxed);
    for n in 200..264 {
        assert!(!other(router.clone(), n).await);
    }
    // From here the store is left out: a large body is made for each request and not kept, and
    // the one kept before is not given.
    size.store(2048, Ordering::Relaxed);
    let before = runs.count();
    assert!(!other(router.clone(), 99).await && !other(router.clone(), 99).await, "the store is not asked");
    assert!(!asked(router.clone()).await, "nor is the body kept before given");
    assert_eq!(runs.count() - before, 3);
    // Until the request this thread asks for: three were left above, so the 253rd from here
    // asks, finds nothing, and its body is kept, which ends the run.
    for left in 3..255 {
        assert!(!other(router.clone(), 99).await, "left to the handler: request {left}");
    }
    assert!(!other(router.clone(), 99).await, "the one that asks: made by its handler, and kept");
    assert!(other(router.clone(), 99).await, "given from here on");
    assert!(asked(router.clone()).await, "as is the body kept before");

    // The one that asks may find a body kept: that ends the run as well. 64 small bodies, 255
    // requests left to the handler, and the next is given the kept body, as are those after it.
    size.store(8, Ordering::Relaxed);
    crate::kept::Unkept::leaves_next(255);
    for n in 300..364 {
        assert!(!other(router.clone(), n).await);
    }
    for left in 0..255 {
        assert!(!asked(router.clone()).await, "left to the handler: request {left}");
    }
    assert!(asked(router.clone()).await, "the one that asks is given the kept body");
    assert!(other(router.clone(), 50).await && asked(router.clone()).await, "and the route asks again");
}

/// An answer left out for another reason counts toward a route's run as one too small does: a
/// route whose every body draws a form's submit key stops asking the store too, and one kept
/// between ends that run as well.
#[tokio::test]
async fn a_route_none_of_whose_answers_is_kept_leaves_the_store_out_whatever_the_reason() {
    use std::sync::atomic::{AtomicBool, Ordering};
    const SUBMIT: crate::form::FieldName<crate::form::SubmitKey> = crate::form::FieldName::__new("submit");
    let keyed = std::sync::Arc::new(AtomicBool::new(true));
    let draws = keyed.clone();
    let body = move || {
        let keyed = draws.load(Ordering::Relaxed);
        async move {
            let field = if keyed { crate::form::SubmitKey::field(SUBMIT).to_html() } else { String::new() };
            Public::new(Duration::from_secs(60), format!("{field}{}", "a".repeat(2048)))
        }
    };
    let router = App::new(Routes::from(Table::new().route("/body", crate::route::get(body).0))).router();
    let asked = |router: Router, n: usize| async move {
        fetch(&router, "GET", &format!("/body?n={n}"), &[]).await.1.contains_key(header::AGE)
    };
    crate::kept::Unkept::leaves_next(255);
    // 63 bodies with a key, each of a size the app keeps and none kept, and one without, which
    // is: the route still asked.
    for n in 0..63 {
        assert!(!asked(router.clone(), n).await);
    }
    keyed.store(false, Ordering::Relaxed);
    assert!(!asked(router.clone(), 100).await && asked(router.clone(), 100).await, "kept, after 63 with a key");
    // 64 with a key in a row: the route leaves the store out, so a body it could keep is not.
    keyed.store(true, Ordering::Relaxed);
    for n in 200..264 {
        assert!(!asked(router.clone(), n).await);
    }
    keyed.store(false, Ordering::Relaxed);
    assert!(!asked(router.clone(), 300).await && !asked(router.clone(), 300).await, "the store is not asked");
    assert!(!asked(router.clone(), 100).await, "nor is the body kept before given");
}

/// A kept answer in an API is the handler's part alone: what the API adds for the site that asks
/// (`Access-Control-Allow-Origin`) is written for each request, so no site is sent another's.
#[cfg(feature = "json")]
#[tokio::test]
async fn a_kept_api_answer_is_sent_with_each_request_s_own_cors() {
    let runs = Runs::default();
    let ran = runs.clone();
    let rates = move || {
        ran.ran();
        // Of a size the app keeps.
        async move { Public::new(Duration::from_secs(60), Ok::<_, JsonError>(Json(vec![1.5_f64; 400]))) }
    };
    struct Counted(Runs);

    impl crate::Middleware for Counted {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            self.0.ran();
            next.run(req).await
        }
    }

    let requests = Runs::default();
    let router = App::new(Routes::new())
        .api::<ApiRoot>(|api| {
            api.route::<ApiRates>(crate::route::get(rates).post(|| async { StatusCode::NO_CONTENT }))
                .allow_origin("https://partner.example")
                .middleware(Counted(requests.clone()))
        })
        .router();
    let partner = [("origin", "https://partner.example")];
    let allowed = |headers: &HeaderMap| headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).map(|v| v.to_str().unwrap().to_string());
    let (status, first, body) = fetch(&router, "GET", "/api/rates", &partner).await;
    let rates = format!("[{}]", vec!["1.5"; 400].join(","));
    assert_eq!(
        (status, &body[..], allowed(&first).as_deref()),
        (StatusCode::OK, rates.as_bytes(), Some("https://partner.example"))
    );
    let (_, plain, same) = fetch(&router, "GET", "/api/rates", &[]).await;
    assert!(plain.contains_key(header::AGE) && same == body, "{plain:?}");
    assert_eq!(allowed(&plain), None, "not the first asker's");
    let (_, other, _) = fetch(&router, "GET", "/api/rates", &[("origin", "https://other.example")]).await;
    assert!(other.contains_key(header::AGE) && allowed(&other).is_none(), "{other:?}");
    let (_, again, _) = fetch(&router, "GET", "/api/rates", &partner).await;
    assert!(again.contains_key(header::AGE) && allowed(&again).as_deref() == Some("https://partner.example"), "{again:?}");
    assert_eq!((runs.count(), requests.count()), (1, 4), "one run for all four, and the API's middleware met each");

    // A data client, as an API's usually is: kept as its own way of asking, and for every cache.
    let data = [("accept", "application/json"), ("origin", "https://partner.example")];
    let (_, asked, same) = fetch(&router, "GET", "/api/rates", &data).await;
    assert!(runs.count() == 2 && !asked.contains_key(header::AGE) && same == body, "{asked:?}");
    let (_, asked, same) = fetch(&router, "GET", "/api/rates", &data).await;
    assert!(runs.count() == 2 && asked.contains_key(header::AGE) && same == body, "{asked:?}");
    assert_eq!(asked[header::CACHE_CONTROL], "public, max-age=60");
    assert_eq!(allowed(&asked).as_deref(), Some("https://partner.example"));

    // A write in the API drops what is kept at its path, both ways of asking.
    let (status, _, _) = fetch(&router, "POST", "/api/rates", &[("sec-fetch-site", "same-origin")]).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(!fetch(&router, "GET", "/api/rates", &[]).await.1.contains_key(header::AGE));
    assert!(!fetch(&router, "GET", "/api/rates", &data).await.1.contains_key(header::AGE));
    assert_eq!(runs.count(), 4);
}

/// A page route may answer a file in its page's place (`PageOr`), and a file of a known size is
/// kept as the page would be. Markup in one that holds a form's new submit key was rendered with
/// no page to mark it, so the handler is watched for the key being drawn, and it is not kept.
#[tokio::test]
async fn a_file_in_a_page_s_place_is_kept_as_the_page_unless_it_drew_a_submit_key() {
    const SUBMIT: crate::form::FieldName<crate::form::SubmitKey> = crate::form::FieldName::__new("submit");
    type FileOrPage = crate::PageOr<Media, crate::answer::ForAll>;
    let minute = Duration::from_secs(60);
    let runs = Runs::default();
    let (file, keyed) = (runs.clone(), runs.clone());
    let file = move || {
        file.ran();
        async move { Public::new(minute, Ok::<FileOrPage, Error>(Media::new("text/csv", "sku,qty\n").into())) }
    };
    let keyed = move || {
        keyed.ran();
        let form = html! { <form method="post">{crate::form::SubmitKey::field(SUBMIT)}</form> }.to_html();
        async move { Public::new(minute, Ok::<FileOrPage, Error>(Media::new("text/html", form).into())) }
    };
    let routes = Table::new().route("/file", crate::route::get(file).0).route("/keyed", crate::route::get(keyed).0);
    let router = App::new(Routes::from(routes)).router();
    // A mark an earlier request left on the thread is no one's: the file is kept all the same.
    let _ = crate::form::SubmitKey::field(SUBMIT).to_html();
    for (path, kept) in [("/file", true), ("/keyed", false)] {
        let before = runs.count();
        let (status, _, body) = fetch(&router, "GET", path, &[]).await;
        let (_, headers, again) = fetch(&router, "GET", path, &[]).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(headers.contains_key(header::AGE), kept, "{path}: {headers:?}");
        assert_eq!(runs.count() - before, if kept { 1 } else { 2 }, "{path}");
        assert_eq!(body == again, kept, "{path}: one key for each request");
    }
}

/// A handler that waits moves between the runtime's threads, and a key it drew is seen on
/// whichever thread ran that poll: no body with one is kept, and no two requests share a key.
#[cfg(feature = "json")]
#[test]
fn a_submit_key_is_seen_wherever_the_handler_s_poll_ran() {
    const SUBMIT: crate::form::FieldName<crate::form::SubmitKey> = crate::form::FieldName::__new("submit");
    let runs = Runs::default();
    let ran = runs.clone();
    let keyed = move || {
        ran.ran();
        async move {
            for _ in 0..8 {
                tokio::task::yield_now().await;
            }
            let field = crate::form::SubmitKey::field(SUBMIT).to_html();
            for _ in 0..8 {
                tokio::task::yield_now().await;
            }
            // Of a size the app keeps, so the key is what keeps it out.
            Public::new(Duration::from_secs(60), Ok::<_, JsonError>(Json((field, "keyed ".repeat(200)))))
        }
    };
    let plain = || async { Public::new(Duration::from_secs(60), Ok::<_, JsonError>(Json("plain".repeat(300)))) };
    // Four routes for the keyed bodies, 40 requests each: a route that made 64 answers in a row
    // with none kept would leave the store out, and its handler would no longer be watched.
    let routes = (0..4).fold(Table::new().route("/plain", crate::route::get(plain).0), |routes, n| {
        routes.route(["/keyed/0", "/keyed/1", "/keyed/2", "/keyed/3"][n], crate::route::get(keyed.clone()).0)
    });
    let router = App::new(Routes::from(routes)).router();
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap();
    runtime.block_on(async {
        let mut bodies = std::collections::HashSet::new();
        for _ in 0..40 {
            let asked: Vec<_> = (0..8)
                .map(|n| {
                    let router = router.clone();
                    let path = ["/keyed/0", "/plain", "/keyed/1", "/plain", "/keyed/2", "/plain", "/keyed/3", "/plain"][n];
                    tokio::spawn(async move { fetch(&router, "GET", path, &[]).await })
                })
                .collect();
            for (n, asked) in asked.into_iter().enumerate() {
                let (_, headers, body) = asked.await.unwrap();
                if n % 2 == 0 {
                    assert!(!headers.contains_key(header::AGE), "a body with a key is not kept: {headers:?}");
                    assert!(bodies.insert(body), "a key for each request");
                }
            }
        }
        assert_eq!(runs.count(), 160, "every request's own");
    });
}

/// A kept body is for the language its handler read: the header is part of its key once the
/// handler reads it (`req.t()`, `req.lang()`), in an app with messages, with a messages type
/// that is not the app's, and with none. A body whose handler does not read it is one copy for
/// every language.
#[cfg(feature = "json")]
#[tokio::test]
async fn a_kept_body_is_for_the_language_its_handler_read() {
    crate::i18n::messages! { struct BodyMsg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
    crate::i18n::messages! { struct OtherMsg { "fr" => "src/i18n/fr.json", "en" => "src/i18n/en.json" } }
    /// Each body is its word this many times: of a size the app keeps.
    const REPEATED: usize = 600;
    let minute = Duration::from_secs(60);
    let runs = Runs::default();
    let routes = || {
        let (words, lang, other, same) = (runs.clone(), runs.clone(), runs.clone(), runs.clone());
        let words = move |req: Req| {
            words.ran();
            async move {
                let t: BodyMsg = req.t();
                Public::new(minute, t.item_listings().to_string().repeat(REPEATED))
            }
        };
        let lang = move |req: Req| {
            lang.ran();
            async move { Public::new(minute, Ok::<_, JsonError>(Json(req.lang().repeat(REPEATED)))) }
        };
        let other = move |req: Req| {
            other.ran();
            async move {
                let t: OtherMsg = req.t();
                Public::new(minute, t.item_listings().to_string().repeat(REPEATED))
            }
        };
        let same = move || {
            same.ran();
            async move { Public::new(minute, "same".repeat(REPEATED)) }
        };
        Table::new()
            .route("/words", crate::route::get(words).0)
            .route("/lang", crate::route::get(lang).0)
            .route("/other", crate::route::get(other).0)
            .route("/same", crate::route::get(same).0)
    };
    let with = App::new(Routes::from(routes())).messages::<BodyMsg>().router();
    let bare = App::new(Routes::from(routes())).router();
    // Without `App::messages` the request's locale is "en" and no header is read for it.
    for (app, paths) in [(&with, &["/words", "/lang", "/other"][..]), (&bare, &["/words", "/other"][..])] {
        for path in paths {
            let before = runs.count();
            for (asked, word, ran) in [("fr", "Annonces", 1), ("en", "Listings", 2), ("fr", "Annonces", 2), ("en", "Listings", 2)]
            {
                let (_, headers, body) = fetch(app, "GET", path, &[("accept-language", asked)]).await;
                let said = if *path == "/lang" { format!("\"{}\"", asked.repeat(REPEATED)) } else { word.repeat(REPEATED) };
                assert_eq!(String::from_utf8_lossy(&body), said, "{path} asked in {asked}");
                assert_eq!(runs.count() - before, ran, "{path} asked in {asked}");
                // Made or given again, the answer says which header chose it.
                let vary: Vec<_> = headers.get_all(header::VARY).iter().filter_map(|value| value.to_str().ok()).collect();
                assert!(vary.iter().any(|value| value.contains("accept-language")), "{path} asked in {asked}: {vary:?}");
            }
        }
        let before = runs.count();
        for asked in ["fr", "en", "de"] {
            let (_, headers, body) = fetch(app, "GET", "/same", &[("accept-language", asked)]).await;
            assert_eq!(body.len(), 4 * REPEATED);
            let named =
                headers.get_all(header::VARY).iter().any(|value| value.as_bytes().windows(15).any(|w| w == b"accept-language"));
            assert!(!named, "a body whose handler read no language names none");
        }
        assert_eq!(runs.count() - before, 1, "the header is not read, so one copy");
    }
}

/// What is not kept of a route that answers JSON for everyone, each of a size the app keeps: a
/// failure, JSON the app holds as bytes (it carries its own coded forms, a mark the store does
/// not replay), and a body with a form's new submit key in markup its handler rendered, also
/// where the handler waited after rendering it.
#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_answer_that_failed_or_is_one_request_s_alone_is_not_kept() {
    const SUBMIT: crate::form::FieldName<crate::form::SubmitKey> = crate::form::FieldName::__new("submit");
    let minute = Duration::from_secs(60);
    let runs = Runs::default();
    let (missing, raw, keyed, waited) = (runs.clone(), runs.clone(), runs.clone(), runs.clone());
    let missing = move || {
        missing.ran();
        async move { Public::new(minute, Err::<Json<u32>, JsonError>(crate::Error::not_found().into())) }
    };
    let raw = move || {
        raw.ran();
        let held = crate::json::Raw::new(format!(r#"{{"ladders":"{}"}}"#, "rung ".repeat(300))).expect("JSON");
        async move { Public::new(minute, Ok::<_, JsonError>(Json(held))) }
    };
    let keyed = move || {
        keyed.ran();
        async move {
            Public::new(minute, Ok::<_, JsonError>(Json((crate::form::SubmitKey::field(SUBMIT).to_html(), "keyed ".repeat(200)))))
        }
    };
    let waited = move |req: Req| {
        waited.ran();
        async move {
            let field = req.rendered(crate::form::SubmitKey::field(SUBMIT)).into_string();
            tokio::task::yield_now().await;
            Public::new(minute, Ok::<_, JsonError>(Json((field, "keyed ".repeat(200)))))
        }
    };
    let routes = Table::new()
        .route("/missing", crate::route::get(missing).0)
        .route("/raw", crate::route::get(raw).0)
        .route("/keyed", crate::route::get(keyed).0)
        .route("/waited", crate::route::get(waited).0);
    let router = App::new(Routes::from(routes)).router();
    for (path, status, kept) in [
        ("/missing", StatusCode::NOT_FOUND, false),
        ("/raw", StatusCode::OK, false),
        ("/keyed", StatusCode::OK, false),
        ("/waited", StatusCode::OK, false),
    ] {
        let before = runs.count();
        let (first, _, body) = fetch(&router, "GET", path, &[]).await;
        let (_, headers, again) = fetch(&router, "GET", path, &[]).await;
        assert_eq!(first, status, "{path}");
        assert_eq!(headers.contains_key(header::AGE), kept, "{path}: {headers:?}");
        assert_eq!(runs.count() - before, if kept { 1 } else { 2 }, "{path}");
        if path == "/keyed" || path == "/waited" {
            assert!(body.len() > 60 && body != again, "{path}: a key for each request");
        }
    }
}

/// The unstaged routes of `what_settling_a_page_costs`: a `Public` answer, which is watched for
/// a submit key, and text, which is not.
#[crate::routes]
mod settle_unstaged_url {
    #[route("/", get = settle_unstaged_public, unstaged)]
    pub struct SharedText;
}

#[crate::routes]
mod settle_unstaged_private_url {
    #[route("/", get = settle_unstaged_private, unstaged)]
    pub struct PlainText;
}

async fn settle_unstaged_public() -> Public<String> {
    Public::new(Duration::from_secs(60), "<form method=\"post\">".repeat(80))
}

async fn settle_unstaged_private() -> String {
    "<form method=\"post\">".repeat(80)
}

/// What settling a page's caching costs a request: `SETTLE_REQUESTS` (200) `GET`s in process, one
/// at a time. `SETTLE_CASE` is the page: `keyed`, a `Public` page that draws a submit key (sent
/// `private, no-cache`); `public` (the default), the same page without the key, which the app
/// keeps; `partial`, that page asked for as a client navigation (sent `private, max-age=60`);
/// `private`, the page with the key and no `Public`; `plain`, the page with neither (the default
/// caching, the usual page); `caller`, the plain page to a request whose staged middleware read a
/// caller; `cookie`, the page with neither, marked `public, max-age=60` and setting a cookie (sent
/// `private, no-cache`); `credentials`, the `Public` page requested with a cookie; `data`, the
/// plain page asked for as JSON; `missing`, an unknown URL in the plain page's app (the router's
/// `404` and the error page in its place); `custom`, the same in an
/// app with an error page of its own ([`settle_error_page`]); `refused`, a staged middleware's
/// typed refusal ([`crate::Refused`]) asked for as JSON; `rejected`, an extractor's refusal that
/// answers `200` ([`GreetsInstead`]); `unnamed`, a same-origin post naming a post the page has
/// none of (`do=sell`), the router's plain-text `400`, sent as it is; `turned`, the staged
/// middleware's typed refusal turned into a `200` it sends as it is (the refusal's mark on an answer
/// that is not a failure); `nostore`, the plain page as `NoStore`. `unstaged` is an unstaged
/// route's JSON (`Media`), and `control` the same JSON from a service of no framework (tower's
/// `service_fn`), the control `docs/design.md`'s Choice counts an unstaged route against. With
/// `asset`, a stylesheet no version of the app's static files has (`RefusedStatic`, an old
/// version's URL) asked for as HTML: the static files' `404` with the error page in its place;
/// `fill`, a page with a layout read's place ([`SettleCount`]) whose body fails as it is read to be
/// filled, asked for as HTML: Corten's `500` with the error page in its place. `cut` is a `Public`
/// page whose body fails when the app tries to keep it: a `500`, which needs keeping enabled
/// even if `SETTLE_KEPT=0` is set for a comparison. `json` is a `Public`
/// JSON body with no key, and `json-private` the same body as a plain `JsonResult<T>`, whose handler
/// is watched since its `JsonError` may hold a `JsonResponse`; `unstaged-public` a `Public` text body from a route that says `unstaged`,
/// with no key, which is watched for one; `unstaged-private` text from such a route, which says no
/// caching. The pages are made as an app's routes are (`corten::get`), where an answer is known to
/// be `Public`. `SETTLE_KEPT=0` keeps none (`App::kept_answers(0)`), so a `Public` answer's handler
/// runs, and is watched for a key, on every request. With
/// `SETTLE_CDN` set, a staged middleware writes the six caching headers
/// a CDN reads first on every answer, and each answer is checked to keep them (`kept`) or not
/// (`dropped`), so the count includes their removal. `denied-html` and `denied-caller` count an
/// early refused write's constant HTML error page without and with a caller read, respectively.
/// Counting it under callgrind at two numbers of
/// requests gives the instructions per request. Run in release:
/// `cargo test --release -p corten-run --all-features --lib --no-run`, then
/// `SETTLE_REQUESTS=1200 LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 valgrind --tool=callgrind <that binary> --ignored --exact tests::cache::what_settling_a_page_costs`
/// (Debian's `libjemalloc2`) and again at 200.
#[test]
#[ignore]
fn what_settling_a_page_costs() {
    struct Staged {
        caller: bool,
        cdn: bool,
        refuse: bool,
        turn: bool,
    }

    impl crate::Middleware for Staged {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let (parts, body) = req.into_parts();
            if self.caller {
                let _ = Caller::<Viewer>::find(&parts, &()).await;
            }
            let mut res = if self.refuse {
                crate::Refused::forbidden().message("Not for you.").into_response()
            } else {
                next.run(Request::from_parts(parts, body)).await
            };
            if self.turn {
                *res.status_mut() = StatusCode::OK;
            }
            if self.cdn {
                for name in CDN_OVERRIDES {
                    res.headers_mut().insert(name, HeaderValue::from_static("public, max-age=60"));
                }
            }
            res
        }
    }

    let requests: usize = std::env::var("SETTLE_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let case = std::env::var("SETTLE_CASE").unwrap_or_else(|_| "public".to_string());
    let cdn = std::env::var("SETTLE_CDN").ok();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    if case == "denied-html" || case == "denied-caller" {
        let router = denied_page_app(case == "denied-caller");
        runtime.block_on(async {
            for _ in 0..requests {
                let (parts, body) = denied_write(&router, "/", "text/html").await.into_parts();
                assert_eq!(parts.status, StatusCode::FORBIDDEN);
                assert_eq!(parts.headers[header::CACHE_CONTROL], "private, no-cache");
                assert!(String::from_utf8_lossy(&body.collect().await.unwrap().to_bytes()).contains("Write declined."));
            }
        });
        return;
    }
    if case == "unstaged" || case == "control" {
        let router = App::new(settle_unstaged::router()).router();
        let control = tower::service_fn(|req: Request| async move {
            let id: u32 = req.uri().path().strip_prefix("/items/").and_then(|id| id.parse().ok()).unwrap_or(0);
            let res = crate::response::Response::builder()
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!("{{\"id\":{id}}}")))
                .unwrap();
            Ok::<_, std::convert::Infallible>(res)
        });
        runtime.block_on(async {
            for _ in 0..requests {
                let req = Request::get("/items/7").body(Body::empty()).unwrap();
                let res = if case == "control" {
                    control.oneshot(req).await.unwrap()
                } else {
                    router.clone().oneshot(req).await.unwrap()
                };
                let (parts, body) = res.into_parts();
                let body = body.collect().await.unwrap().to_bytes();
                assert!(parts.status == StatusCode::OK && body == "{\"id\":7}", "{}: {body:?}", parts.status);
                assert_eq!(parts.headers[header::CONTENT_TYPE], "application/json");
                if case == "unstaged" {
                    assert_eq!(parts.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
                    assert!(!parts.headers.contains_key(header::CACHE_CONTROL), "{:?}", parts.headers);
                }
            }
        });
        return;
    }
    let minute = Duration::from_secs(60);
    let keyed = case == "keyed" || case == "private";
    let form = move || html! { <form method="post">if keyed { {crate::SubmitKey::field(KeyedWrite::FIELDS.submit)} }</form> };
    // Made as an app's routes are (`corten::get`), where an answer is known to be `Public`.
    #[allow(unused_mut)]
    let mut routes =
        if ["private", "plain", "caller", "data", "missing", "custom", "refused", "turned", "asset"].contains(&case.as_str()) {
            Table::new().route("/", get(move |req: Req| async move { req.test_page("Form", form()) }))
        } else if case == "fill" {
            Table::new().route("/", get(settle_fill_fails))
        } else if case == "cut" {
            Table::new().route("/", crate::route::get(kept_cut).0)
        } else if case == "rejected" {
            Table::new().route("/", get(|_: GreetsInstead| async { "never" }))
        } else if case == "nostore" {
            Table::new().route("/", get(move |req: Req| async move { NoStore(req.test_page("Form", form())) }))
        } else if case == "unnamed" {
            Table::new().route(
                "/",
                get(move |req: Req| async move { req.test_page("Form", form()) }).post(|| async { "saved" }).named("save"),
            )
        } else if case == "cookie" {
            Table::new().route(
                "/",
                get(move |req: Req| async move {
                    Ok::<_, Error>((Cache::public(minute), [(header::SET_COOKIE, "seen=1")], req.test_page("Form", form())?))
                }),
            )
        } else {
            Table::new().route(
                "/",
                crate::route::get(move |req: Req| async move { Public::new(minute, req.test_page_for("Form", form())) }).0,
            )
        };
    #[cfg(feature = "json")]
    if case == "json" {
        let body = move || async move { Public::new(minute, Ok::<_, JsonError>(Json("<form method=\"post\">".repeat(80)))) };
        routes = Table::new().route("/", crate::route::get(body).0);
    }
    #[cfg(feature = "json")]
    if case == "json-private" {
        let body = || async { Ok::<_, JsonError>(Json("<form method=\"post\">".repeat(80))) };
        routes = Table::new().route("/", crate::route::get(body).0);
    }
    let app = match case.as_str() {
        "unstaged-public" => App::new(settle_unstaged_url::router()),
        "unstaged-private" => App::new(settle_unstaged_private_url::router()),
        _ => App::new(Routes::from(routes)),
    };
    let app = if case != "cut" && std::env::var("SETTLE_KEPT").is_ok_and(|kept| kept == "0") { app.kept_answers(0) } else { app };
    let app = if case == "custom" { app.error_page(settle_error_page, ()) } else { app };
    let app = if case == "asset" { app.assets(super::RefusedStatic) } else { app };
    let app = if case == "fill" { app.layout_read(SettleCount) } else { app };
    let router = if ["caller", "refused", "turned"].contains(&case.as_str()) || cdn.is_some() {
        let refuse = case == "refused" || case == "turned";
        app.middleware(Staged { caller: case == "caller", cdn: cdn.is_some(), refuse, turn: case == "turned" }).router()
    } else {
        app.router()
    };
    let expected = match case.as_str() {
        "public" | "json" | "unstaged-public" => "public, max-age=60",
        "partial" => "private, max-age=60",
        _ => "private, no-cache",
    };
    let kept = cdn.as_deref().map(|cdn| match cdn {
        "kept" => true,
        "dropped" => false,
        other => panic!("SETTLE_CDN is kept or dropped, not {other:?}"),
    });
    runtime.block_on(async {
        for _ in 0..requests {
            let mut req = Request::get(match case.as_str() {
                "missing" | "custom" => "/nowhere",
                "asset" => "/assets/000000000000/missing.css",
                _ => "/",
            });
            if case == "caller" {
                req = req.header("viewer", "ann");
            } else if case == "credentials" {
                req = req.header(header::COOKIE, "viewer=ann");
            } else if case == "partial" {
                req = req.header("corten", "nav");
            } else if case == "data" || case == "refused" {
                req = req.header("accept", "application/json");
            } else if case == "unnamed" {
                req = req.method("POST").uri("/?do=sell").header("sec-fetch-site", "same-origin");
            } else if ["asset", "fill", "cut"].contains(&case.as_str()) {
                req = req.header("accept", "text/html");
            }
            let (parts, body) = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
            let body = String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap();
            match case.as_str() {
                "missing" => assert_eq!(parts.status, StatusCode::NOT_FOUND, "{body}"),
                "asset" => assert!(parts.status == StatusCode::NOT_FOUND && body.contains("<html"), "{}: {body}", parts.status),
                "fill" | "cut" => {
                    assert!(
                        parts.status == StatusCode::INTERNAL_SERVER_ERROR && body.contains("<html"),
                        "{}: {body}",
                        parts.status
                    )
                }
                "custom" => {
                    assert!(parts.status == StatusCode::NOT_FOUND && body.contains("Nothing here."), "{}: {body}", parts.status)
                }
                "refused" => {
                    assert!(parts.status == StatusCode::FORBIDDEN && body.contains("Not for you."), "{}: {body}", parts.status)
                }
                "data" | "turned" => assert_eq!(parts.status, StatusCode::OK, "{body}"),
                "rejected" => assert!(parts.status == StatusCode::OK && body == "Hello, stranger.", "{}: {body}", parts.status),
                "unnamed" => {
                    assert!(parts.status == StatusCode::BAD_REQUEST && body.contains("no post named"), "{}: {body}", parts.status)
                }
                // JSON writes the markup's quotes escaped.
                "json" | "json-private" => {
                    assert!(parts.status == StatusCode::OK && body.contains("<form method="), "{}: {body}", parts.status)
                }
                _ => {
                    assert!(parts.status == StatusCode::OK && body.contains("<form method=\"post\">"), "{}: {body}", parts.status)
                }
            }
            // The router's `400`, the static files' `404` and the failed fill's `500` go out with
            // what the build settles such a failure with, and `NoStore` as the build writes it
            // (`private, no-store`, or a bare `no-store`).
            if case == "nostore" {
                assert!(parts.headers[header::CACHE_CONTROL].to_str().unwrap().ends_with("no-store"), "{:?}", parts.headers);
            } else if case == "unstaged-private" {
                assert!(!parts.headers.contains_key(header::CACHE_CONTROL), "{:?}", parts.headers);
            } else if !["unnamed", "asset", "fill"].contains(&case.as_str()) {
                assert_eq!(parts.headers[header::CACHE_CONTROL], expected);
            }
            assert_eq!(parts.headers.contains_key(header::SET_COOKIE), case == "cookie");
            if let Some(kept) = kept {
                for name in CDN_OVERRIDES {
                    assert_eq!(parts.headers.contains_key(name), kept, "{name}");
                }
            }
        }
    });
}

#[crate::routes]
mod settle_unstaged {
    #[route("/items/{id}", get = settle_unstaged_item, unstaged)]
    pub struct Item {
        pub id: u32,
    }
}

/// The unstaged route [`what_settling_a_page_costs`] counts: the JSON its control answers.
async fn settle_unstaged_item(at: crate::Params<settle_unstaged::Item>) -> crate::Media {
    crate::Media::new("application/json", format!("{{\"id\":{}}}", at.id))
}

/// The MCP endpoint's route in [`what_an_mcp_call_costs`].
#[cfg(feature = "agent")]
#[derive(crate::Route)]
#[route("/mcp")]
struct CostMcp;

/// The tool's input in [`what_an_mcp_call_costs`].
#[cfg(feature = "agent")]
#[derive(crate::json::FromJson)]
struct CostItem {
    id: String,
}

/// The tool's output in [`what_an_mcp_call_costs`].
#[cfg(feature = "agent")]
#[derive(crate::json::ToJson)]
struct CostFound {
    id: String,
}

/// What an MCP tool call costs a request: `MCP_REQUESTS` (200) `POST`s to an app's MCP endpoint
/// (`App::api` with `Tools::route`, one read tool), in process, one at a time. `MCP_CASE` is the
/// message: `call` (the default), a call the tool answers (its result, the tool's own answer);
/// `unfit`, a call whose arguments do not fit the tool's input (the `isError` result Corten makes in
/// the tool's place); `unknown`, a call to a tool the endpoint does not have (Corten's JSON-RPC
/// error, `-32602`, at `200`); `checked`, the call `call` makes to an endpoint whose `Tools::auth` finds the
/// caller in the request's bearer token (the tool's answer is that caller's, never shared). With
/// `MCP_CDN` set, a staged middleware writes the six caching
/// headers a CDN reads first on every answer, and each answer is checked to keep them (`kept`) or
/// not (`dropped`). Counted under callgrind at two numbers of requests, as
/// [`what_settling_a_page_costs`] is: `MCP_REQUESTS=1200 LD_PRELOAD=.. valgrind --tool=callgrind
/// <the release test binary> --ignored --exact tests::cache::what_an_mcp_call_costs`, and again at 200.
#[cfg(feature = "agent")]
#[test]
#[ignore]
fn what_an_mcp_call_costs() {
    use crate::agent::{ToolError, Tools};

    struct Cdn;

    impl crate::Middleware for Cdn {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let mut res = next.run(req).await;
            for name in CDN_OVERRIDES {
                res.headers_mut().insert(name, HeaderValue::from_static("public, max-age=60"));
            }
            res
        }
    }

    let requests: usize = std::env::var("MCP_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let case = std::env::var("MCP_CASE").unwrap_or_else(|_| "call".to_string());
    let kept = std::env::var("MCP_CDN").ok().map(|cdn| match cdn.as_str() {
        "kept" => true,
        "dropped" => false,
        other => panic!("MCP_CDN is kept or dropped, not {other:?}"),
    });
    let message = match case.as_str() {
        "call" | "checked" => r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"find","arguments":{"id":"7"}}}"#,
        "unfit" => r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"find","arguments":{}}}"#,
        "unknown" => r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lost","arguments":{}}}"#,
        other => panic!("MCP_CASE is call, checked, unfit or unknown, not {other:?}"),
    };
    let checked = case == "checked";
    let route = if checked {
        Tools::new("cost", "1.0")
            .auth(|headers| {
                let token = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok());
                token.and_then(|token| token.strip_prefix("Bearer ")).map(str::to_owned).ok_or(ToolError::Unauthorized)
            })
            .read_tool("find", "Finds an item", |caller: String, item: CostItem| async move {
                Ok(CostFound { id: format!("{caller}:{}", item.id) })
            })
            .route()
    } else {
        Tools::new("cost", "1.0")
            .read_tool("find", "Finds an item", |(), item: CostItem| async move { Ok(CostFound { id: item.id }) })
            .route()
    };
    let app = App::new(Routes::new()).api::<CostMcp>(|api| api.route::<CostMcp>(route));
    let router = if kept.is_some() { app.middleware(Cdn).router() } else { app.router() };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        for _ in 0..requests {
            let mut req = Request::post("/mcp")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "application/json, text/event-stream")
                .body(Body::from(message))
                .unwrap();
            if checked {
                req.headers_mut().insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer ann"));
            }
            let (parts, body) = router.clone().oneshot(req).await.unwrap().into_parts();
            let body = String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap();
            assert_eq!(parts.status, StatusCode::OK, "{body}");
            match case.as_str() {
                "call" => assert!(body.contains(r#""isError":false"#) && body.contains(r#"\"id\":\"7\""#), "{body}"),
                "checked" => assert!(body.contains(r#""isError":false"#) && body.contains(r#"\"id\":\"ann:7\""#), "{body}"),
                "unfit" => assert!(body.contains(r#""isError":true"#), "{body}"),
                _ => assert!(body.contains(r#""code":-32602"#), "{body}"),
            }
            if let Some(kept) = kept {
                for name in CDN_OVERRIDES {
                    assert_eq!(parts.headers.contains_key(name), kept, "{name}: {body}");
                }
            }
        }
    });
}

/// The error page of its own an app has in [`what_settling_a_page_costs`]'s `custom` case.
async fn settle_error_page(_: Failure, req: Req) -> HtmlResult {
    req.test_page("Missing", html! { <p>"Nothing here."</p> })
}

/// The layout read of [`what_settling_a_page_costs`]'s `fill` case: a count, in at once.
struct SettleCount;

impl crate::LayoutRead for SettleCount {
    type Value = u32;

    fn start(&self, _: &http::request::Parts) -> Option<impl std::future::Future<Output = u32> + Send + 'static> {
        Some(async { 3 })
    }

    fn view(count: &u32) -> impl Render + '_ {
        html! { <span>{*count}</span> }
    }
}

/// The page of [`what_settling_a_page_costs`]'s `fill` case: an ordinary page with the count's
/// place, whose body fails as it is read to be filled.
async fn settle_fill_fails(req: Req) -> Response {
    let page = req.page::<crate::ForOne>(html! {
        <html>
            <head>
                <title>"Fill"</title>
                <Corten />
            </head>
            <body>
                <header>"Count "{crate::later::<SettleCount>()}</header>
                <main><p>"fill"</p></main>
            </body>
        </html>
    });
    let (head, _) = page.into_response().into_parts();
    let body = Body::from_stream(futures_util::stream::iter([Err::<bytes::Bytes, _>(std::io::Error::other("cut off"))]));
    Response::from_parts(head, body)
}

/// A body that says it is 4 KiB long and fails as it is read: a page Corten cannot send.
struct CutOff;

impl http_body::Body for CutOff {
    type Data = bytes::Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<std::result::Result<http_body::Frame<bytes::Bytes>, std::io::Error>>> {
        std::task::Poll::Ready(Some(Err(std::io::Error::other("cut off"))))
    }

    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(4096)
    }
}

/// A page eligible for keeping, but whose exact-size body cannot be read when kept.
async fn kept_cut(req: Req) -> Public<HtmlResult> {
    Public::new(
        Duration::from_secs(60),
        req.test_page_for("Kept", html! { <p>"kept"</p> }).map(|mut page| {
            *page.body_mut() = Body::new(CutOff);
            page
        }),
    )
}

/// An exact-size answer whose body fails as Corten reads it after the cache rules ran, to tag it
/// for an `If-None-Match` or to compress it, goes out empty in its place. That empty answer is
/// Corten's, not the handler's, so no cache keeps it: `private, no-store`, with none of the caching
/// headers a CDN reads first that a staged middleware wrote, no validator and no stated length,
/// though the handler's answer was one a CDN could keep. Asked for with a tag (a page), and as an
/// API answer worth compressing (it has a tag of its own, so it is not tagged first), directly and
/// from another app whose staged middleware relays it inline and rewrites its `Cache-Control`,
/// which still sends it `private, no-store`: it is a `NoStore` answer, not one that only says so.
#[tokio::test]
async fn an_answer_whose_body_fails_after_the_cache_rules_is_never_kept() {
    let cut = |kind: &'static str, tag: Option<&'static str>| {
        move || async move {
            let mut res = crate::response::Response::builder().header(header::CONTENT_TYPE, kind);
            if let Some(tag) = tag {
                res = res.header(header::ETAG, tag);
            }
            res.body(Body::new(CutOff)).unwrap()
        }
    };
    let router = App::new(Routes::from(Table::new().route("/page", get(cut("text/html; charset=utf-8", None)))))
        .api::<ApiItems>(|items| items.route::<ApiItem>(crate::Methods::reads(get(cut("application/json", Some("\"v1\""))))))
        .middleware(CdnRecaches(Some("public, max-age=60")))
        .router();
    // The same answers asked for inline by another app, whose middleware rewrites the empty
    // answer's `Cache-Control`: still `private, no-store`, by its mark.
    let other = App::new(Routes::from(Table::new().route("/page", get(cut("text/html; charset=utf-8", None)))))
        .api::<ApiItems>(|items| items.route::<ApiItem>(crate::Methods::reads(get(cut("application/json", Some("\"v1\""))))))
        .router();
    let relaying = App::new(Routes::from(Table::new().route("/page", get(|| async { "home" }))))
        .api::<ApiItems>(|items| items.route::<ApiItem>(crate::Methods::reads(get(|| async { "item" }))))
        .middleware((CdnRecaches(Some("public, max-age=60")), RelaysAnotherApp(other)))
        .router();
    #[cfg_attr(not(feature = "compress"), allow(unused_mut))]
    let mut cases = vec![("tagged", "/page", &[("if-none-match", "W/\"0000000000000000\"")][..])];
    #[cfg(feature = "compress")]
    cases.push(("compressed", "/api/items/7", &[("accept-encoding", "gzip"), ("accept", "application/json")][..]));
    let mut wrong = Vec::new();
    for (router, how) in [(&router, "direct"), (&relaying, "relayed inline")] {
        for &(item, uri, asked) in &cases {
            let item = format!("{item}, {how}");
            let (status, headers, body) = sent_by_ann(router, "GET", uri, asked, b"").await;
            if status != StatusCode::OK || !body.is_empty() {
                wrong.push(format!("{item}: {status}, {body:?}"));
            }
            wrong.extend(kept_from_cdns(&headers, "private, no-store").into_iter().map(|what| format!("{item}: {what}")));
            for name in [header::ETAG, header::CONTENT_LENGTH, header::CONTENT_ENCODING] {
                if let Some(value) = headers.get(&name) {
                    if !(name == header::CONTENT_LENGTH && value == "0") {
                        wrong.push(format!("{item}: {name} {value:?}"));
                    }
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Staged middleware that takes the `Cookie` off the request before the route sees it (as one that
/// keeps a session of its own may), then marks the answer for a CDN as [`CdnRecaches`] does: the
/// route's answer may be kept, and the app's error page still reads the cookie the request came
/// with.
struct HidesTheCookie;

impl crate::Middleware for HidesTheCookie {
    async fn call(&self, mut req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        req.headers_mut().remove(header::COOKIE);
        crate::Middleware::call(&CdnRecaches(Some("public, max-age=60")), req, next).await
    }
}

/// A document whose head has no `<Corten />`, which `html!` does not build: a page of it fails.
struct NoCortenHead;

impl Render for NoCortenHead {
    fn render(&self, out: &mut String) {
        out.push_str("<!DOCTYPE html><html><head><title>None</title></head><body><main></main></body></html>");
    }
}

impl crate::view::Document for NoCortenHead {
    fn render_part(&self, out: &mut String, _: crate::view::Part) {
        self.render(out);
    }
}

/// `res`'s status, headers and body, and whether it carries the mark of an answer no shared cache
/// keeps.
async fn read_marked(res: Response) -> (StatusCode, http::HeaderMap, String, bool) {
    let marked = res.extensions().get::<crate::cache::Unshared>().is_some();
    let (parts, body) = res.into_parts();
    let body = String::from_utf8_lossy(&body.collect().await.unwrap().to_bytes()).into_owned();
    (parts.status, parts.headers, body, marked)
}

/// Every failure Corten makes itself, rather than one a handler chose to answer with, as the audit
/// of #1890 lists them: no shared cache keeps it, in any form it goes out in. Behind a staged
/// middleware that marks every answer for a CDN, the app's error page drawn in its place greets Ann
/// by her cookie without reading a caller, and still goes out `private` (`private, no-store` in a
/// `NoStore` answer's place) with none of the caching headers a CDN reads first. The ones the
/// stages never meet, or that go out as they are, carry the same mark for an app that relays them
/// inline. A handler's own failure is the handler's answer and keeps them (the control).
#[tokio::test]
async fn every_failure_corten_makes_is_never_shared() {
    let routes = Table::new()
        .route("/", get(|| async { "home" }).post(|| async { "saved" }).named("save"))
        .route("/form", crate::router::post(|| async { "saved" }))
        .route("/style", get(|req: Req| async move { req.asset(RefusedStatic::STYLE_CSS).to_string() }))
        .route("/own", get(|| async { Err::<&'static str, Error>(Error::new("the store is down")) }))
        .route("/refused", get(|| async { Err::<&'static str, Error>(Refused::forbidden().into()) }))
        .route(
            "/hidden",
            get(|| async { Err::<&'static str, Error>(Error::from(Refused::forbidden()).with_status(StatusCode::NOT_FOUND)) }),
        )
        .route("/unidentified", get(|| async { Err::<&'static str, Error>(Refused::unavailable("down").into()) }))
        .route(
            "/panics",
            get(|| async {
                if true {
                    panic!("broken")
                } else {
                    "never"
                }
            }),
        )
        .route(
            "/late",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                "late"
            }),
        )
        .route("/ip", get(|crate::ClientIp(ip): crate::ClientIp| async move { ip.to_string() }))
        .route("/ws", get(|upgrade: crate::upgrade::Upgrade| async move { upgrade.websocket(|_, _| async {}) }))
        .route("/upload", crate::router::post(|_: crate::Upload<()>| async { "uploaded" }))
        .route(
            "/sign-in",
            get(|| async {
                Err::<&'static str, Error>(Refused::sign_in(&"https://id.example/sign-in".parse::<http::Uri>().unwrap()).into())
            }),
        )
        .route(
            "/key",
            get(|| async { Err::<&'static str, Error>(Refused::unauthorized(crate::Challenge::bearer("keys")).into()) }),
        )
        .route("/slow-down", get(|| async { Err::<&'static str, Error>(Refused::too_many(Duration::from_secs(30)).into()) }))
        .route("/text", crate::router::post(|text: String| async move { text }))
        .route(
            "/fields",
            get(|crate::Form(_): crate::Form<std::collections::HashMap<String, u32>>| async { "read" })
                .post(|crate::Form(_): crate::Form<std::collections::HashMap<String, u32>>| async { "read" }),
        )
        .route("/connection", get(|_: crate::ConnectionInfo<&'static str>| async { "connection" }))
        .route("/zone", get(|_: Option<crate::ClientZone>| async { "zone" }))
        .route("/bad-header", get(|| async { (StatusCode::OK, [("bad name", "1")], "body") }))
        .route("/no-head", get(|req: Req| async move { req.page::<ForOne>(NoCortenHead) }))
        .route("/resend", get(|req: Req| async move { req.resend_to::<ForOne>(&crate::Local::parse("/").unwrap()) }))
        // Made as an app's routes are (`corten::get`), which is where an answer is known to be `Public`.
        .route("/kept-cut", crate::route::get(kept_cut).0)
        .route(
            "/hint",
            get(|req: Req| async move { req.test_page("Hint", html! { <p id={crate::form::HintId(&QtyId)}>"Pick one."</p> }) }),
        )
        .route(
            "/refresh",
            get(|req: Req| async move {
                req.test_page("Refresh", html! { <p>"again"</p> }).map(|mut page| {
                    page.headers_mut().insert("refresh", HeaderValue::from_static("5"));
                    page
                })
            }),
        )
        .route(
            "/refresh-secret",
            get(|req: Req| async move {
                NoStore(req.test_page("Refresh", html! { <p>"again"</p> }).map(|mut page| {
                    page.headers_mut().insert("refresh", HeaderValue::from_static("5"));
                    page
                }))
            }),
        )
        .route("/patch", get(|| async { ([("corten-patch", "1")], "<p>part</p>") }))
        .route(
            "/go",
            crate::router::post(
                |req: Req| async move { req.redirect::<()>(&"https://else.example/x".parse::<http::Uri>().unwrap()) },
            ),
        );
    #[cfg(feature = "json")]
    let routes = routes
        .route("/json", crate::router::post(|crate::Json(n): crate::Json<u32>| async move { n.to_string() }))
        .route("/reports", crate::router::post(|_: crate::security::Violations| async { "read" }));
    let app = || {
        App::new(Routes::from(routes.clone()))
            .assets(RefusedStatic)
            .deadline(Duration::from_millis(50))
            .body_limit(64)
            .ready(|| async { false })
            .error_page(greeting_error_page, ())
    };
    let router = app().middleware(CdnRecaches(Some("public, max-age=60"))).router();
    let hides = app().middleware(HidesTheCookie).router();
    // An error page whose own extractor refuses the request: its refusal is Corten's too.
    let page_refuses = App::new(Routes::from(routes.clone()))
        .middleware(CdnRecaches(Some("public, max-age=60")))
        .error_page(
            |_: Failure, crate::ClientIp(_): crate::ClientIp| async { Err::<HtmlResponse, Error>(Error::new("never drawn")) },
            (),
        )
        .router();
    // The stylesheet's URL at the version the app serves: `/assets/{version}/style.css`.
    let (_, _, href) = from_ann(&router, "GET", "/style", &[]).await;
    let missing = href.replace("style.css", "missing.css");
    let not_a_path = href.replace("style.css", "%FF.css");
    let html = &[("accept", "text/html")][..];
    let range = &[("accept", "text/html"), ("range", "bytes=100000-")][..];
    let same_site = &[("accept", "text/html"), ("sec-fetch-site", "same-origin")][..];
    let switch = &[("accept", "text/html"), ("connection", "upgrade"), ("upgrade", "websocket")][..];
    let cross_switch = &[
        ("connection", "upgrade"),
        ("upgrade", "websocket"),
        ("origin", "https://evil.example"),
        ("sec-fetch-site", "cross-site"),
    ][..];
    let no_boundary = &[("accept", "text/html"), ("sec-fetch-site", "same-origin"), ("content-type", "multipart/form-data")][..];
    #[cfg(feature = "json")]
    let plain_reports = &[("accept", "text/html"), ("sec-fetch-site", "same-origin"), ("content-type", "text/plain")][..];
    let empty: &[u8] = b"";
    let long = [b'a'; 100];
    // What each item is, its request (its headers and body), its status, whether the error page drew,
    // and what the answer's `Cache-Control` is.
    let debug = cfg!(debug_assertions);
    type Case<'a> =
        (&'a str, &'a Router, &'a str, &'a str, &'a [(&'static str, &'static str)], &'a [u8], StatusCode, bool, &'a str);
    let mut cases: Vec<Case> = vec![
        ("router 404", &router, "GET", "/nowhere", html, empty, StatusCode::NOT_FOUND, true, "private, no-cache"),
        ("router 405", &router, "GET", "/form", html, empty, StatusCode::METHOD_NOT_ALLOWED, true, "private, no-cache"),
        ("router 501", &router, "PATCH", "/", html, empty, StatusCode::NOT_IMPLEMENTED, true, "private, no-cache"),
        ("static file miss", &router, "GET", &missing, html, empty, StatusCode::NOT_FOUND, true, "private, no-cache"),
        ("static path refused", &router, "GET", &not_a_path, html, empty, StatusCode::BAD_REQUEST, true, "private, no-cache"),
        (
            "static range past the end",
            &router,
            "GET",
            &href,
            range,
            empty,
            StatusCode::RANGE_NOT_SATISFIABLE,
            false,
            "private, no-cache",
        ),
        ("handler's refusal", &router, "GET", "/refused", html, empty, StatusCode::FORBIDDEN, true, "private, no-cache"),
        ("refusal at another status", &router, "GET", "/hidden", html, empty, StatusCode::NOT_FOUND, true, "private, no-cache"),
        (
            "caller unavailable",
            &router,
            "GET",
            "/unidentified",
            html,
            empty,
            StatusCode::SERVICE_UNAVAILABLE,
            true,
            "private, no-cache",
        ),
        ("panic", &router, "GET", "/panics", html, empty, StatusCode::INTERNAL_SERVER_ERROR, true, "private, no-cache"),
        ("deadline", &router, "GET", "/late", html, empty, StatusCode::SERVICE_UNAVAILABLE, true, "private, no-cache"),
        (
            "extractor: no client address",
            &router,
            "GET",
            "/ip",
            html,
            empty,
            StatusCode::INTERNAL_SERVER_ERROR,
            true,
            "private, no-cache",
        ),
        ("extractor: no switch asked", &router, "GET", "/ws", html, empty, StatusCode::BAD_REQUEST, true, "private, no-cache"),
        (
            "extractor: not multipart",
            &router,
            "POST",
            "/upload",
            html,
            empty,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            true,
            "private, no-cache",
        ),
        (
            "header that is not one",
            &router,
            "GET",
            "/bad-header",
            html,
            empty,
            StatusCode::INTERNAL_SERVER_ERROR,
            true,
            "private, no-cache",
        ),
        (
            "document without <Corten />",
            &router,
            "GET",
            "/no-head",
            html,
            empty,
            StatusCode::INTERNAL_SERVER_ERROR,
            true,
            "private, no-cache",
        ),
        (
            "resend_to on a GET",
            &router,
            "GET",
            "/resend",
            html,
            empty,
            StatusCode::INTERNAL_SERVER_ERROR,
            true,
            "private, no-cache",
        ),
        ("not ready", &router, "GET", "/health/ready", html, empty, StatusCode::SERVICE_UNAVAILABLE, true, "private, no-store"),
        (
            "kept answer that cannot be read",
            &hides,
            "GET",
            "/kept-cut",
            html,
            empty,
            StatusCode::INTERNAL_SERVER_ERROR,
            true,
            "private, no-cache",
        ),
        (
            "chooser: a post the page has none of",
            &router,
            "POST",
            "/?do=sell",
            same_site,
            empty,
            StatusCode::BAD_REQUEST,
            true,
            "private, no-cache",
        ),
        ("refusal: sign in", &router, "GET", "/sign-in", html, empty, StatusCode::SEE_OTHER, false, "private, no-cache"),
        ("refusal: 401", &router, "GET", "/key", html, empty, StatusCode::UNAUTHORIZED, true, "private, no-cache"),
        ("refusal: 429", &router, "GET", "/slow-down", html, empty, StatusCode::TOO_MANY_REQUESTS, true, "private, no-cache"),
        (
            "extractor: body not UTF-8",
            &router,
            "POST",
            "/text",
            same_site,
            &b"\xff"[..],
            StatusCode::BAD_REQUEST,
            true,
            "private, no-cache",
        ),
        (
            "extractor: body over the limit",
            &router,
            "POST",
            "/text",
            same_site,
            &long[..],
            StatusCode::PAYLOAD_TOO_LARGE,
            true,
            "private, no-cache",
        ),
        (
            "extractor: form fields that do not fit",
            &router,
            "GET",
            "/fields?n=x",
            html,
            empty,
            StatusCode::BAD_REQUEST,
            true,
            "private, no-cache",
        ),
        (
            "extractor: form not urlencoded",
            &router,
            "POST",
            "/fields",
            same_site,
            empty,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            true,
            "private, no-cache",
        ),
        (
            "extractor: no connection value",
            &router,
            "GET",
            "/connection",
            html,
            empty,
            StatusCode::INTERNAL_SERVER_ERROR,
            true,
            "private, no-cache",
        ),
        (
            "extractor: a switch the connection cannot make",
            &router,
            "GET",
            "/ws",
            switch,
            empty,
            StatusCode::BAD_REQUEST,
            true,
            "private, no-cache",
        ),
        (
            "extractor: a switch from another site",
            &router,
            "GET",
            "/ws",
            cross_switch,
            empty,
            StatusCode::FORBIDDEN,
            true,
            "private, no-cache",
        ),
        (
            "extractor: multipart without a boundary",
            &router,
            "POST",
            "/upload",
            no_boundary,
            empty,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            true,
            "private, no-cache",
        ),
        (
            "error page's own extractor",
            &page_refuses,
            "GET",
            "/nowhere",
            html,
            empty,
            StatusCode::NOT_FOUND,
            false,
            "private, no-cache",
        ),
    ];
    #[cfg(feature = "json")]
    let api = App::new(Routes::new().__route::<AnywhereRest>(crate::Methods::reads(get(|| async { "page" }))))
        .api::<ApiItems>(|items| items.route::<ApiItem>(crate::Methods::reads(get(|| async { "item" }))))
        .middleware(CdnRecaches(Some("public, max-age=60")))
        .error_page(greeting_error_page, ())
        .router();
    #[cfg(feature = "json")]
    cases.extend([
        (
            "extractor: reports that are not JSON",
            &router,
            "POST",
            "/reports",
            plain_reports,
            empty,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            true,
            "private, no-cache",
        ),
        (
            "extractor: JSON without its type",
            &router,
            "POST",
            "/json",
            same_site,
            empty,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            true,
            "private, no-cache",
        ),
        (
            "API: a path a route outside it matched",
            &api,
            "GET",
            "/api/items/7/more",
            &[("accept", "application/json")][..],
            empty,
            StatusCode::NOT_FOUND,
            false,
            "private, no-cache",
        ),
    ]);
    if debug {
        cases.extend([
            (
                "debug: hint no control names",
                &router,
                "GET",
                "/hint",
                html,
                empty,
                StatusCode::INTERNAL_SERVER_ERROR,
                true,
                "private, no-cache",
            ),
            (
                "debug: Refresh header",
                &router,
                "GET",
                "/refresh",
                html,
                empty,
                StatusCode::INTERNAL_SERVER_ERROR,
                true,
                "private, no-cache",
            ),
            (
                "debug: Refresh, NoStore",
                &router,
                "GET",
                "/refresh-secret",
                html,
                empty,
                StatusCode::INTERNAL_SERVER_ERROR,
                true,
                "private, no-store",
            ),
            (
                "debug: patch to a plain GET",
                &router,
                "GET",
                "/patch",
                html,
                empty,
                StatusCode::INTERNAL_SERVER_ERROR,
                true,
                "private, no-cache",
            ),
            (
                "debug: redirect outside form-action",
                &router,
                "POST",
                "/go",
                html,
                empty,
                StatusCode::INTERNAL_SERVER_ERROR,
                true,
                "private, no-cache",
            ),
            (
                "debug: ClientZone without App::client_zone",
                &router,
                "GET",
                "/zone",
                html,
                empty,
                StatusCode::INTERNAL_SERVER_ERROR,
                true,
                "private, no-cache",
            ),
        ]);
    }
    let mut wrong = Vec::new();
    for (item, router, method, uri, asked, body, status, greets, sent) in cases {
        let mut req = Request::builder().method(method).uri(uri).header(header::COOKIE, "name=ann");
        for (name, value) in asked {
            req = req.header(*name, *value);
        }
        let res = router.clone().oneshot(req.body(Body::from(body.to_vec())).unwrap()).await.unwrap();
        let (got, headers, body, marked) = read_marked(res).await;
        if got != status {
            wrong.push(format!("{item}: {method} {uri} answered {got}, not {status}: {body}"));
            continue;
        }
        if greets != body.contains("Sorry, ann.") {
            wrong.push(format!("{item}: the error page {} drawn: {body}", if greets { "was not" } else { "was" }));
        }
        if !marked {
            wrong.push(format!("{item}: not marked as no handler's own"));
        }
        // What matters is the caching headers: the middleware's others are on the answer only
        // where it ran after the route (not past a panic or the deadline, nor on a debug build's
        // diagnostic, which keeps none of the answer's headers but its cookies).
        for what in kept_from_cdns(&headers, sent).into_iter().filter(|what| !what.starts_with("lost ")) {
            wrong.push(format!("{item}: {what}"));
        }
    }
    // The control: a handler's own failure is its answer, and the page in its place keeps what the
    // middleware wrote.
    let (status, headers, body) = from_ann(&router, "GET", "/own", html).await;
    assert!(status == StatusCode::INTERNAL_SERVER_ERROR && body.contains("Sorry, ann."), "{status}: {body}");
    for name in CDN_OVERRIDES {
        assert_eq!(headers[name], "public, max-age=60", "a handler's own failure keeps {name}");
    }
    // A failed error page: the plain text in its place is Corten's, whatever it replaced.
    let broken = App::new(Routes::from(routes.clone()))
        .middleware(CdnRecaches(Some("public, max-age=60")))
        .error_page(|_: Failure| async { Err::<HtmlResponse, Error>(Error::new("the error page broke")) }, ())
        .router();
    let (status, headers, body) = from_ann(&broken, "GET", "/own", html).await;
    assert!(status == StatusCode::INTERNAL_SERVER_ERROR && body.contains("could not be shown"), "{status}: {body}");
    for what in kept_from_cdns(&headers, "private, no-cache") {
        wrong.push(format!("failed error page: {what}"));
    }
    // Outside the stages, or past them: marked for an app that relays the answer inline.
    let outside = |req: http::request::Builder| async {
        let res = router.clone().oneshot(req.header(header::COOKIE, "name=ann").body(Body::empty()).unwrap()).await.unwrap();
        read_marked(res).await
    };
    for (item, req, status) in [
        ("another host", Request::get("/").header(header::HOST, "rebound.attacker.example"), StatusCode::MISDIRECTED_REQUEST),
        (
            "cross-site write",
            Request::post("/form").header("origin", "https://evil.example").header("sec-fetch-site", "cross-site"),
            StatusCode::FORBIDDEN,
        ),
    ] {
        let (got, _, body, marked) = outside(req).await;
        if got != status || !marked {
            wrong.push(format!("{item}: {got} (want {status}), marked {marked}: {body}"));
        }
    }
    let unstaged = App::new(super::unstaged::unstaged_url::router()).router();
    let (got, _, body, marked) =
        read_marked(unstaged.oneshot(Request::get("/boom").body(Body::empty()).unwrap()).await.unwrap()).await;
    if got != StatusCode::INTERNAL_SERVER_ERROR || !marked {
        wrong.push(format!("unstaged panic: {got}, marked {marked}: {body}"));
    }
    // The failures a handler meets as values and passes on with `?`: each is marked as it is made,
    // so the error page in its place is drawn as the router's own is (above).
    let unrouted = Request::get("/").body(()).unwrap().into_parts().0;
    #[allow(unused_mut)]
    let mut made = vec![
        ("body over its limit", Error::from(crate::extract::BodyError::TooLarge { limit: 1 }).into_response()),
        ("body stalled", Error::from(crate::extract::BodyError::Stalled).into_response()),
        ("body broken", Error::from(crate::extract::BodyError::Broken("reset".into())).into_response()),
        ("upload over its limit", Error::from(crate::UploadError::TooLarge { limit: 1 }).into_response()),
        ("upload malformed", Error::from(crate::UploadError::Malformed("no end".into())).into_response()),
        ("upload fields", Error::from(crate::UploadError::Fields("qty".into())).into_response()),
        ("upload stalled", Error::from(crate::UploadError::Stalled).into_response()),
        ("path parameters unread", crate::route::read_path::<(u32,)>(&unrouted).unwrap_err().into_response()),
    ];
    #[cfg(feature = "json")]
    made.push((
        "JSON route refusing with a 202",
        crate::JsonError::refusal(crate::Json(7u32).with_status(StatusCode::ACCEPTED), false).into_response(),
    ));
    for (item, res) in made {
        if res.extensions().get::<crate::cache::Unshared>().is_none() {
            wrong.push(format!("{item}: {} not marked as no handler's own", res.status()));
        }
    }
    assert!(wrong.is_empty(), "a failure Corten made, open to a CDN: {wrong:#?}");
}

/// `method` `uri` with `body` through `router` from Ann (`name=ann`), asked with `asked`: its
/// status, headers and body.
async fn sent_by_ann(
    router: &Router,
    method: &str,
    uri: &str,
    asked: &[(&'static str, &'static str)],
    body: &[u8],
) -> (StatusCode, http::HeaderMap, String) {
    let mut req = Request::builder().method(method).uri(uri).header(header::COOKIE, "name=ann");
    for (name, value) in asked {
        req = req.header(*name, *value);
    }
    let (parts, body) = router.clone().oneshot(req.body(Body::from(body.to_vec())).unwrap()).await.unwrap().into_parts();
    (parts.status, parts.headers, String::from_utf8_lossy(&body.collect().await.unwrap().to_bytes()).into_owned())
}

/// A typed rejection a handler meets as a value (it takes `Result<String, BodyRejection>` or
/// `Result<Form<T>, FormRejection>`, so it runs the extractor itself) and passes on with `?` stays
/// Corten's: the `500` it becomes, as any error passed on with `?` does, keeps the mark, so the
/// error page drawn in its place, which greets Ann by her cookie, is never shared. Wrapped by hand
/// (`Error::new`), it is the handler's own failure, as an error of the handler's own passed on with
/// `?` is, and the page in its place keeps what the middleware wrote (the controls). A refusal
/// wrapped with `Error::new` stays Corten's; inside an error of another type, it is the handler's.
#[tokio::test]
async fn a_rejection_passed_on_with_the_question_mark_stays_corten_s() {
    type Text = std::result::Result<String, crate::extract::BodyRejection>;
    type Fields = std::result::Result<crate::Form<std::collections::HashMap<String, u32>>, crate::form::FormRejection>;
    let routes = Table::new()
        .route(
            "/text",
            crate::router::post(|text: Text| async move {
                let text = text?;
                Ok::<_, Error>(text)
            }),
        )
        .route(
            "/fields",
            get(|fields: Fields| async move {
                let crate::Form(_) = fields?;
                Ok::<_, Error>("read")
            }),
        )
        .route(
            "/text-wrapped",
            crate::router::post(|text: Text| async move {
                let text = text.map_err(Error::new)?;
                Ok::<_, Error>(text)
            }),
        )
        .route(
            "/fields-wrapped",
            get(|fields: Fields| async move {
                let crate::Form(_) = fields.map_err(Error::new)?;
                Ok::<_, Error>("read")
            }),
        )
        .route(
            "/own",
            get(|| async {
                Err::<(), _>(std::io::Error::other("the store is down"))?;
                Ok::<_, Error>("never")
            }),
        )
        // A refusal wrapped with `Error::new` is still the refusal (`From<Error> for Box` hands
        // `Error::new` the refusal itself), sent as a plain 500; inside another error, it is not.
        .route("/refused-wrapped", get(|| async { Err::<&str, _>(Error::new(Error::from(crate::Refused::forbidden()))) }))
        .route(
            "/refused-in-another-error",
            get(|| async { Err::<&str, _>(Error::new(std::io::Error::other(Error::from(crate::Refused::forbidden())))) }),
        );
    let router = App::new(Routes::from(routes))
        .middleware(CdnRecaches(Some("public, max-age=60")))
        .error_page(greeting_error_page, ())
        .router();
    let html = &[("accept", "text/html")][..];
    let same_site = &[("accept", "text/html"), ("sec-fetch-site", "same-origin")][..];
    let mut wrong = Vec::new();
    // What each is, its request, and whether it is Corten's.
    for (item, method, uri, asked, body, corten) in [
        ("BodyRejection passed on with ?", "POST", "/text", same_site, &b"\xff"[..], true),
        ("FormRejection passed on with ?", "GET", "/fields?n=x", html, &b""[..], true),
        ("BodyRejection wrapped with Error::new", "POST", "/text-wrapped", same_site, &b"\xff"[..], false),
        ("FormRejection wrapped with Error::new", "GET", "/fields-wrapped?n=x", html, &b""[..], false),
        ("the handler's own error passed on with ?", "GET", "/own", html, &b""[..], false),
        ("a refusal wrapped with Error::new", "GET", "/refused-wrapped", html, &b""[..], true),
        ("a refusal inside another error", "GET", "/refused-in-another-error", html, &b""[..], false),
    ] {
        let (status, headers, body) = sent_by_ann(&router, method, uri, asked, body).await;
        // `?` makes a 500 of any error, Corten's or not, as it did.
        if status != StatusCode::INTERNAL_SERVER_ERROR || !body.contains("Sorry, ann.") {
            wrong.push(format!("{item}: {status}, not the error page's 500: {body}"));
            continue;
        }
        if corten {
            wrong.extend(kept_from_cdns(&headers, "private, no-cache").into_iter().map(|what| format!("{item}: {what}")));
        } else {
            for name in CDN_OVERRIDES {
                if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                    wrong.push(format!("{item}: the handler's own failure lost {name}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// A `FormRejection` the app made itself (`FormRejection::new`, for a form it read and found
/// wanting) is the handler's answer, not Corten's refusal: passed on with `?` (the error page's
/// `500` in its place) or answered as it is (its `422`), it keeps what a middleware wrote, as a
/// handler's own error does. The extractor's own, answered as it is, stays Corten's: `private,
/// no-cache` with none of the CDN headers (passed on with `?`, it is checked by
/// `a_rejection_passed_on_with_the_question_mark_stays_corten_s`).
#[tokio::test]
async fn a_form_rejection_the_app_made_is_the_handler_s() {
    type Fields = std::result::Result<crate::Form<std::collections::HashMap<String, u32>>, crate::form::FormRejection>;
    let own = || crate::form::FormRejection::new(StatusCode::UNPROCESSABLE_ENTITY, "pick a size");
    assert!(own().into_response().extensions().get::<crate::cache::Unshared>().is_none(), "the app's own, as a response");
    assert!(Error::from(own()).into_response().extensions().get::<crate::cache::Unshared>().is_none(), "the app's own, with ?");
    let routes = Table::new()
        .route(
            "/own-passed",
            get(move || async move {
                Err::<(), _>(own())?;
                Ok::<_, Error>("never")
            }),
        )
        .route("/own-answered", get(move || async move { own() }))
        .route(
            "/extractor-answered",
            get(|fields: Fields| async move {
                match fields {
                    Ok(_) => "read".into_response(),
                    Err(rejection) => rejection.into_response(),
                }
            }),
        );
    let router = App::new(Routes::from(routes))
        .middleware(CdnRecaches(Some("public, max-age=60")))
        .error_page(greeting_error_page, ())
        .router();
    let html = &[("accept", "text/html")][..];
    let mut wrong = Vec::new();
    for (uri, status_sent, corten) in [
        ("/own-passed", StatusCode::INTERNAL_SERVER_ERROR, false),
        ("/own-answered", StatusCode::UNPROCESSABLE_ENTITY, false),
        ("/extractor-answered?n=x", StatusCode::BAD_REQUEST, true),
    ] {
        let (status, headers, body) = sent_by_ann(&router, "GET", uri, html, b"").await;
        if status != status_sent || !body.contains("Sorry, ann.") {
            wrong.push(format!("{uri}: {status}, not the error page's {status_sent}: {body}"));
            continue;
        }
        if corten {
            wrong.extend(kept_from_cdns(&headers, "private, no-cache").into_iter().map(|what| format!("{uri}: {what}")));
        } else {
            for name in CDN_OVERRIDES {
                if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                    wrong.push(format!("{uri}: the handler's own rejection lost {name}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Staged middleware that applies a header part that is not one (a name with a space) to the
/// answer it was given, as `([(name, value)], res)`: Corten's `500` replaces that answer.
struct BreaksTheHeader;

impl crate::Middleware for BreaksTheHeader {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        let res = next.run(req).await;
        ([("bad name", "1")], res).into_response()
    }
}

/// The `500` Corten sends in place of an answer given a header that is not one (a name or a
/// value) is Corten's, and keeps that answer's `NoStore`: `private, no-store` and none of a CDN's
/// caching headers, whatever a middleware then writes, with the error page in its place too.
#[tokio::test]
async fn a_header_that_is_not_one_keeps_the_no_store_of_the_answer_it_replaces() {
    let answer = |no_store: bool| {
        let mut res = "secret".into_response();
        if no_store {
            Cache::no_store().apply(&mut res);
        }
        res
    };
    for (item, failed, no_store) in [
        ("a name that is not one, NoStore", ([("bad name", "1")], answer(true)).into_response(), true),
        ("a value that is not one, NoStore", ([("x-note", "one\nline")], answer(true)).into_response(), true),
        ("a name that is not one", ([("bad name", "1")], answer(false)).into_response(), false),
    ] {
        assert_eq!(failed.status(), StatusCode::INTERNAL_SERVER_ERROR, "{item}");
        assert!(failed.extensions().get::<crate::cache::Unshared>().is_some(), "{item}: not marked as Corten's");
        assert_eq!(crate::cache::Typed::is_no_store(&failed), no_store, "{item}: NoStore");
    }
    let routes = Table::new()
        .route("/statement", get(|req: Req| async move { NoStore(req.test_page("Statement", html! { <p>"yours"</p> })) }))
        .route("/plain", get(|req: Req| async move { req.test_page("Plain", html! { <p>"plain"</p> }) }));
    let router = App::new(Routes::from(routes))
        .middleware((CdnRecaches(Some("public, max-age=60")), BreaksTheHeader))
        .error_page(greeting_error_page, ())
        .router();
    let html = &[("accept", "text/html")][..];
    for (uri, sent) in [("/statement", "private, no-store"), ("/plain", "private, no-cache")] {
        let (status, headers, body) = from_ann(&router, "GET", uri, html).await;
        assert!(status == StatusCode::INTERNAL_SERVER_ERROR && body.contains("Sorry, ann."), "{uri}: {status}: {body}");
        let wrong = kept_from_cdns(&headers, sent);
        assert!(wrong.is_empty(), "{uri}: {wrong:#?}");
    }
}

/// A tuple with a header part that is not one and a `Cache::no_store()` part keeps its `500` out of
/// every cache whichever part comes first: the policy a part after the failed one would have set is
/// still read. With and without a status, made directly, and as a handler's answer through the
/// app, behind a middleware that writes the CDN headers, where the error page in its place goes
/// out `private, no-store` with none of them. A tuple without `NoStore` stays `private, no-cache`
/// (the control).
#[tokio::test]
async fn a_failed_header_part_keeps_no_store_whatever_order_the_parts_are_in() {
    let bad = || [("bad name", "1")];
    for (item, failed, no_store) in [
        ("NoStore first", (Cache::no_store(), bad(), "secret").into_response(), true),
        ("NoStore after", (bad(), Cache::no_store(), "secret").into_response(), true),
        ("status, NoStore first", (StatusCode::OK, Cache::no_store(), bad(), "secret").into_response(), true),
        ("status, NoStore after", (StatusCode::OK, bad(), Cache::no_store(), "secret").into_response(), true),
        (
            "status, NoStore last of three",
            (StatusCode::OK, bad(), [("x-note", "1")], Cache::no_store(), "secret").into_response(),
            true,
        ),
        ("no NoStore", (StatusCode::OK, bad(), [("x-note", "1")], "secret").into_response(), false),
    ] {
        assert_eq!(failed.status(), StatusCode::INTERNAL_SERVER_ERROR, "{item}");
        assert!(failed.extensions().get::<crate::cache::Unshared>().is_some(), "{item}: not marked as Corten's");
        assert_eq!(crate::cache::Typed::is_no_store(&failed), no_store, "{item}: NoStore");
    }
    let routes = Table::new()
        .route("/first", get(|| async { (StatusCode::OK, Cache::no_store(), [("bad name", "1")], "secret") }))
        .route("/after", get(|| async { (StatusCode::OK, [("bad name", "1")], Cache::no_store(), "secret") }))
        .route("/neither", get(|| async { (StatusCode::OK, [("bad name", "1")], "secret") }));
    let router = App::new(Routes::from(routes))
        .middleware(CdnRecaches(Some("public, max-age=60")))
        .error_page(greeting_error_page, ())
        .router();
    let html = &[("accept", "text/html")][..];
    let mut wrong = Vec::new();
    for (uri, sent) in [("/first", "private, no-store"), ("/after", "private, no-store"), ("/neither", "private, no-cache")] {
        let (status, headers, body) = from_ann(&router, "GET", uri, html).await;
        if status != StatusCode::INTERNAL_SERVER_ERROR || !body.contains("Sorry, ann.") {
            wrong.push(format!("{uri}: {status}: {body}"));
        }
        wrong.extend(kept_from_cdns(&headers, sent).into_iter().map(|what| format!("{uri}: {what}")));
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// The MCP endpoint's route, for [`the_mcp_endpoint_s_own_errors_are_never_shared`].
#[cfg(feature = "agent")]
#[derive(crate::Route)]
#[route("/mcp")]
struct McpAt;

/// A tool's input, for [`the_mcp_endpoint_s_own_errors_are_never_shared`].
#[cfg(feature = "agent")]
#[derive(crate::json::FromJson)]
struct McpItem {
    id: String,
}

/// A tool's output, for [`the_mcp_endpoint_s_own_errors_are_never_shared`].
#[cfg(feature = "agent")]
#[derive(crate::json::ToJson)]
struct McpFound {
    id: String,
}

/// The MCP endpoint's own answers to a message it cannot serve are Corten's, not a tool's, at the
/// status and in the envelope the protocol gives them: a JSON-RPC error at `200` for a message
/// that is not JSON or not one request, an invalid request, a method it does not have, or a tool
/// call without a tool, with an unknown one or arguments that are not an object, and a result with
/// `isError` for arguments that do not fit the tool's input or a caller [`Tools::auth`] turned away
/// before any tool ran (without an `Authorization`, whose metadata would make that a `403`). Behind
/// a staged middleware that marks every answer for a CDN, each goes out `private, no-cache` with none
/// of the caching headers a CDN reads first. What a tool of an endpoint without `auth` answers,
/// its own `isError` result included, and what the endpoint answers to a message it serves keep
/// what the middleware wrote (the controls).
///
/// [`Tools::auth`]: crate::agent::Tools::auth
#[cfg(feature = "agent")]
#[tokio::test]
async fn the_mcp_endpoint_s_own_errors_are_never_shared() {
    use crate::agent::{ToolError, Tools};
    let find = |(), item: McpItem| async move {
        if item.id == "locked" {
            return Err(ToolError::Forbidden("that item is locked".into()));
        }
        Ok(McpFound { id: item.id })
    };
    let checked = Tools::new("test", "1.0")
        .auth(|headers| match headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()) {
            Some("Bearer banned") => Err(ToolError::Forbidden("suspended".into())),
            _ => Ok(()),
        })
        .read_tool("find", "Finds an item", find);
    let router = App::new(Routes::new())
        .api::<McpAt>(|api| api.route::<McpAt>(checked.route()))
        .middleware(CdnRecaches(Some("public, max-age=60")))
        .router();
    // Without `auth`, a tool's answer is for anyone (with it, for the caller it found: the next test).
    let open = App::new(Routes::new())
        .api::<McpAt>(|api| api.route::<McpAt>(Tools::new("test", "1.0").read_tool("find", "Finds an item", find).route()))
        .middleware(CdnRecaches(Some("public, max-age=60")))
        .router();
    let call = |arguments: &str| {
        format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"find","arguments":{arguments}}}}}"#)
    };
    let json = &[("content-type", "application/json")][..];
    let banned = &[("content-type", "application/json"), ("authorization", "Bearer banned")][..];
    // What each is, its message and headers, what the answer must say (a JSON-RPC error's code, or
    // `isError`), and whether it is Corten's.
    type Case<'a> = (&'a str, String, &'a [(&'static str, &'static str)], serde_json::Value, bool);
    let cases: Vec<Case> = vec![
        ("not JSON", "{".into(), json, serde_json::json!(-32700), true),
        ("not one message", "[]".into(), json, serde_json::json!(-32600), true),
        ("an invalid request", r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#.into(), json, serde_json::json!(-32600), true),
        (
            "a method it does not have",
            r#"{"jsonrpc":"2.0","id":1,"method":"nope"}"#.into(),
            json,
            serde_json::json!(-32601),
            true,
        ),
        (
            "a tool call without a tool",
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}"#.into(),
            json,
            serde_json::json!(-32602),
            true,
        ),
        (
            "an unknown tool",
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lost"}}"#.into(),
            json,
            serde_json::json!(-32602),
            true,
        ),
        ("arguments that are not an object", call("[]"), json, serde_json::json!(-32602), true),
        ("arguments that do not fit", call("{}"), json, serde_json::json!(true), true),
        ("a caller the check turned away", call(r#"{"id":"7"}"#), banned, serde_json::json!(true), true),
        ("the tool's own refusal", call(r#"{"id":"locked"}"#), json, serde_json::json!(true), false),
        ("the tool's answer", call(r#"{"id":"7"}"#), json, serde_json::json!(false), false),
        ("the tools' list", r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.into(), json, serde_json::Value::Null, false),
    ];
    let mut wrong = Vec::new();
    for (item, message, asked, says, corten) in cases {
        let router = if corten { &router } else { &open };
        let (status, headers, body) = sent_by_ann(router, "POST", "/mcp", asked, message.as_bytes()).await;
        let body: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
        // The protocol's status and envelope, as before.
        let said = match &says {
            serde_json::Value::Bool(_) => body["result"]["isError"].clone(),
            serde_json::Value::Number(_) => body["error"]["code"].clone(),
            _ => serde_json::Value::Null,
        };
        if status != StatusCode::OK || said != says || body["jsonrpc"] != "2.0" {
            wrong.push(format!("{item}: {status}, {body}"));
            continue;
        }
        if corten {
            wrong.extend(kept_from_cdns(&headers, "private, no-cache").into_iter().map(|what| format!("{item}: {what}")));
        } else {
            for name in CDN_OVERRIDES {
                if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                    wrong.push(format!("{item}: what the endpoint served lost {name}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Staged middleware that answers with another Corten app's answer to the whole request (its
/// method, URI, headers and body), asked inline on the same poll.
#[cfg(feature = "agent")]
struct RelaysTheWholeRequest(Router);

#[cfg(feature = "agent")]
impl crate::Middleware for RelaysTheWholeRequest {
    async fn call(&self, req: Request, _: impl crate::middleware::Next) -> crate::response::Response {
        let (parts, body) = req.into_parts();
        let mut asked = Request::builder().method(parts.method).uri(parts.uri);
        for (name, value) in &parts.headers {
            asked = asked.header(name, value);
        }
        self.0.clone().oneshot(asked.body(body).unwrap()).await.unwrap()
    }
}

/// A tool's answer from an endpoint whose [`Tools::auth`] found its caller is that caller's, as an
/// answer that reads a [`Caller`] is (a shared copy would also answer a request the check turns
/// away): behind a staged middleware that marks every answer for a CDN, the tool's result (naming
/// its caller here) and its own `isError` refusal go out `private, no-cache` with none of the
/// caching headers a CDN reads first, and so they do when another Corten app's staged middleware
/// relays the endpoint's answer inline. With a [`Tools::authorization`] too, the check runs on every
/// request, and every answer it lets through is that caller's in the same way: the list of tools,
/// `initialize` and `ping`, as they are and relayed inline. The same tool on an endpoint without
/// `auth`, for anyone, and the list of tools of an endpoint whose `auth` checks tool calls alone
/// keep what the middleware wrote (the controls).
///
/// [`Tools::auth`]: crate::agent::Tools::auth
/// [`Tools::authorization`]: crate::agent::Tools::authorization
#[cfg(feature = "agent")]
#[tokio::test]
async fn an_mcp_tool_s_answer_for_the_caller_its_check_found_is_not_shared() {
    use crate::agent::{Authorization, ToolError, Tools};
    let bearer = |headers: &http::HeaderMap| {
        let token = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok());
        token.and_then(|token| token.strip_prefix("Bearer ")).map(str::to_owned).ok_or(ToolError::Unauthorized)
    };
    let whoami = |caller: String, item: McpItem| async move {
        if item.id == "locked" {
            return Err(ToolError::Forbidden("that item is locked".into()));
        }
        Ok(McpFound { id: format!("{caller}:{}", item.id) })
    };
    let checked = Tools::new("test", "1.0").auth(bearer).read_tool("whoami", "Says who asks", whoami);
    // Every request checked, not only a tool call.
    let protected = Tools::new("test", "1.0")
        .authorization(Authorization::new::<McpAt>("https://cards.example", "https://auth.example"))
        .auth(bearer)
        .read_tool("whoami", "Says who asks", whoami);
    let open = Tools::new("test", "1.0").read_tool("whoami", "Says who asks", |(), item: McpItem| async move {
        if item.id == "locked" {
            return Err(ToolError::Forbidden("that item is locked".into()));
        }
        Ok(McpFound { id: format!("anyone:{}", item.id) })
    });
    let cdn = || CdnRecaches(Some("public, max-age=60"));
    let checked_app =
        App::new(Routes::new()).api::<McpAt>(|api| api.route::<McpAt>(checked.clone().route())).middleware(cdn()).router();
    let protected_app =
        App::new(Routes::new()).api::<McpAt>(|api| api.route::<McpAt>(protected.clone().route())).middleware(cdn()).router();
    let open_app = App::new(Routes::new()).api::<McpAt>(|api| api.route::<McpAt>(open.route())).middleware(cdn()).router();
    // The endpoint with no middleware of its own, asked inline by another app's.
    let relaying = |inner: Router| {
        App::new(Routes::new())
            .api::<McpAt>(|api| api.route::<McpAt>(crate::Methods::writes(crate::router::post(|| async { "home" }))))
            .middleware((cdn(), RelaysTheWholeRequest(inner)))
            .router()
    };
    let relaying_checked = relaying(App::new(Routes::new()).api::<McpAt>(|api| api.route::<McpAt>(checked.route())).router());
    let relaying_protected = relaying(App::new(Routes::new()).api::<McpAt>(|api| api.route::<McpAt>(protected.route())).router());
    let call = |id: &str| {
        format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"whoami","arguments":{{"id":"{id}"}}}}}}"#)
    };
    let list = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_string();
    let initialize = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#.to_string();
    let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.to_string();
    let asked = &[("content-type", "application/json"), ("authorization", "Bearer ann")][..];
    let mut wrong = Vec::new();
    // What each is, the app, the message, what its result must say, and whether it is the caller's.
    for (item, router, message, says, personal) in [
        ("the tool's answer", &checked_app, call("7"), Some("ann:7"), true),
        ("the tool's own refusal", &checked_app, call("locked"), None, true),
        ("the tool's answer relayed inline", &relaying_checked, call("7"), Some("ann:7"), true),
        ("the tool's own refusal relayed inline", &relaying_checked, call("locked"), None, true),
        ("a protected endpoint's tool's answer", &protected_app, call("7"), Some("ann:7"), true),
        ("a protected endpoint's list", &protected_app, list.clone(), None, true),
        ("a protected endpoint's initialize", &protected_app, initialize.clone(), None, true),
        ("a protected endpoint's ping", &protected_app, ping.clone(), None, true),
        ("a protected endpoint's list relayed inline", &relaying_protected, list.clone(), None, true),
        ("a protected endpoint's initialize relayed inline", &relaying_protected, initialize.clone(), None, true),
        ("the tools' list where only calls are checked", &checked_app, list.clone(), None, false),
        ("initialize where only calls are checked", &checked_app, initialize.clone(), None, false),
        ("an open endpoint's answer", &open_app, call("7"), Some("anyone:7"), false),
        ("an open endpoint's tool's refusal", &open_app, call("locked"), None, false),
    ] {
        let (status, headers, body) = sent_by_ann(router, "POST", "/mcp", asked, message.as_bytes()).await;
        let body: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
        let answered = match says {
            Some(id) => body["result"]["structuredContent"]["id"] == id,
            None if message == list => body["result"]["tools"].is_array(),
            None if message == initialize => body["result"]["protocolVersion"] == "2025-06-18",
            None if message == ping => body["result"] == serde_json::json!({}),
            None => body["result"]["isError"] == true,
        };
        if status != StatusCode::OK || !answered {
            wrong.push(format!("{item}: {status}, {body}"));
            continue;
        }
        if personal {
            wrong.extend(kept_from_cdns(&headers, "private, no-cache").into_iter().map(|what| format!("{item}: {what}")));
        } else {
            for name in CDN_OVERRIDES {
                if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                    wrong.push(format!("{item}: for anyone, and it lost {name}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// A body that fails as the handler reads it ([`crate::extract::pieces_up_to`], here over its
/// limit), passed on with `?`, is the request's refusal: behind a staged middleware that marks every
/// answer for a CDN, the failure goes out `private, no-cache` with none of the caching headers a CDN
/// reads first. A `BodyError` or `UploadError` the handler builds itself is the same, by its type:
/// building one opts in to a refusal's caching, which can only keep an answer from a shared cache,
/// never give it to one. The handler's own failure (`Error::status`) keeps what the middleware
/// wrote (the control).
#[tokio::test]
async fn a_body_error_is_the_request_s_refusal_whoever_made_it() {
    let read = |request: Request| async move {
        match request.headers().get("x-made").and_then(|value| value.to_str().ok()) {
            Some("body") => Err(Error::from(crate::extract::BodyError::Broken("the app's own".into()))),
            Some("upload") => Err(Error::from(crate::UploadError::Fields("the app's own check".into()))),
            Some("own") => Err(Error::status(StatusCode::UNPROCESSABLE_ENTITY)),
            _ => {
                let mut pieces = crate::extract::pieces_up_to(request.into_body(), 4);
                while pieces.chunk().await?.is_some() {}
                Ok::<_, Error>("read")
            }
        }
    };
    let router = App::new(Routes::new())
        .api::<ApiItems>(|items| items.route::<ApiItem>(crate::Methods::writes(crate::router::post(read))))
        .middleware(CdnRecaches(Some("public, max-age=60")))
        .router();
    let mut wrong = Vec::new();
    for (item, made, status, corten) in [
        ("read over its limit", None, StatusCode::PAYLOAD_TOO_LARGE, true),
        ("a BodyError the handler made", Some("body"), StatusCode::BAD_REQUEST, true),
        ("an UploadError the handler made", Some("upload"), StatusCode::UNPROCESSABLE_ENTITY, true),
        ("the handler's own failure", Some("own"), StatusCode::UNPROCESSABLE_ENTITY, false),
    ] {
        let asked: Vec<(&'static str, &'static str)> = made.map(|made| ("x-made", made)).into_iter().collect();
        let (got, headers, body) = sent_by_ann(&router, "POST", "/api/items/7", &asked, b"more than four bytes").await;
        if got != status {
            wrong.push(format!("{item}: {got} (want {status}): {body}"));
            continue;
        }
        if corten {
            wrong.extend(kept_from_cdns(&headers, "private, no-cache").into_iter().map(|what| format!("{item}: {what}")));
        } else {
            for name in CDN_OVERRIDES {
                if headers.get(name).is_none_or(|value| value != "public, max-age=60") {
                    wrong.push(format!("{item}: the handler's own, and it lost {name}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// The crate's source makes each failure of its own through the constructors that mark it
/// ([`crate::cache::Unshared`]): `Error::corten`, `cache::unshared`, `cache::unshared_in_place_of`,
/// or a value that marks itself as it becomes a response (`BodyRejection`, `FormRejection`, a
/// refusal). Each failure the source makes, outside the tests, is checked on its own: a 4xx or 5xx
/// status named to answer with, an `Error` made another way (`Error::new` called or passed as a
/// function), and a JSON-RPC error code. The statement (or match arm) that makes it must hold one
/// of the marks, or the failure must be marked where it goes next: a status set on a response
/// (`*res.status_mut() = ..`) where that response was made, a value bound to a name at every
/// statement of the rest of its block that uses the name (each use may be an exit of its own, so
/// one marked `return` does not vouch for an unmarked final expression; a binding nothing uses is
/// refused). A function of the file listed in
/// [`failure_check::HELPERS`], and a closure of the same function that holds a mark, counts as one.
/// Anything else is refused unless listed below with why it may (a stale entry fails too), so a new
/// exit is marked as it is written or named where review sees it.
///
/// It reads tokens, not Rust (`failure_check`), so it has limits, which the behavior tests cover
/// (`every_failure_corten_makes_is_never_shared` and the tests after it): a status or an `Error`
/// it cannot see made (a status number, `StatusCode::from_u16(500)`; an alias, `use
/// http::StatusCode as S` or a `const` holding a failing status; one passed in from another
/// function or made by a macro), a failure with no status in it (an MCP result with `isError`,
/// whose producers are checked by `the_mcp_endpoint_s_own_errors_are_never_shared`), a mark in the
/// statement that is not applied to the failure (`let _ = cache::unshared(other)` beside it, or a
/// use of a bound name inside a marked statement that hands the value elsewhere unmarked), a
/// value that leaves the rest of its block another way (stored, then answered elsewhere), a later
/// `let` of the same name, read as the same binding, a closure or helper that marks on some paths only, and a value in [`failure_check::MARKS`] taken
/// at its word that it is answered marked. Because every use of a binding must be marked, a
/// binding that is only compared or logged after it is made is refused too, and is marked where it
/// is made. Strings and comments are blanked first, so the name of
/// a mark in either does not count. (Skipped outside the repository.)
#[test]
fn corten_makes_its_failures_through_the_constructors_that_mark_them() {
    // The file, what the line holds, how many lines hold it, and why each may.
    const OWN: &[(&str, &str, usize, &str)] = &[
        ("assets.rs", "NO_FAVICON_CACHE)]).into_response()", 1, "no icon: one 404 for everyone, public for an hour"),
        ("lib.rs", "source: error.into(), corten: false }", 1, "Error::new: a handler's own failure"),
        ("lib.rs", "source: status.canonical_reason()", 1, "Error::status: a handler's own failure"),
        ("lib.rs", "Error::status(StatusCode::NOT_FOUND)", 1, "Error::not_found: a handler's own failure"),
        (
            "lib.rs",
            "Error { corten: corten_s(&error), ..Error::new(error) }",
            1,
            "an error passed on with `?`: the handler's own, but for a rejection Corten's extractor made (`corten_s`), which it marks",
        ),
        ("lib.rs", "source: Box::new(caller::AsError(refused))", 1, "a refusal, answered as the refusal, which marks itself"),
        (
            "page.rs",
            "let failure = Failure::Failed { status: StatusCode::INTERNAL_SERVER_ERROR, detail: Some(Arc::from(message)) };",
            2,
            "the sign-in's 500s, sent through `carried` with `marks`, which says `unshared: true` above them",
        ),
        ("router.rs", "Status(StatusCode::NOT_FOUND)", 1, "the router's 404, which `Status` marks as it answers"),
        ("router.rs", "Status(StatusCode::METHOD_NOT_ALLOWED)", 1, "the router's 405, which `Status` marks as it answers"),
        ("security/violations.rs", "StatusCode::UNSUPPORTED_MEDIA_TYPE,", 1, "a reason, which the extractor marks as it answers"),
        ("security/violations.rs", "let refused = |_| (StatusCode::BAD_REQUEST", 1, "a reason, which the extractor marks"),
        ("security/violations.rs", "_ => Err((StatusCode::BAD_REQUEST", 1, "a reason, which the extractor marks"),
    ];
    let Some(sources) = failure_check::sources() else { return };
    let mut unmarked = Vec::new();
    for (file, text) in &sources {
        for (line, holds) in failure_check::unmarked(file, text) {
            unmarked.push((file.clone(), line, holds));
        }
    }
    let mut wrong = Vec::new();
    for (file, line, text) in &unmarked {
        if !OWN.iter().any(|(own, holds, _, _)| own == file && text.contains(holds)) {
            wrong.push(format!("{file}:{line}: {text}"));
        }
    }
    for (file, holds, lines, why) in OWN {
        let mut found: Vec<usize> =
            unmarked.iter().filter(|(at, _, text)| at == file && text.contains(holds)).map(|(_, line, _)| *line).collect();
        found.dedup();
        if found.len() != *lines {
            wrong.push(format!("{file}: {} lines hold {holds:?}, not {lines} ({why}): change the list", found.len()));
        }
    }
    assert!(
        wrong.is_empty(),
        "a failure made without Error::corten, cache::unshared or cache::unshared_in_place_of; mark it, add it to \
         every_failure_corten_makes_is_never_shared, or list it here with why it may: {wrong:#?}"
    );
}
/// The source check refuses each failure on its own, not the function it is in: a failure whose
/// mark was taken off is found though its function makes another failure marked, a mark's name in
/// a string or a comment does not count, and an `Error` made with `Error::new` passed as a function
/// counts as one, and a binding is checked at each use (review round 14 of #1890: a marked early
/// return beside an unmarked final expression of the same binding). Review round 13 found three
/// changes the check it replaced let through: they are the first three cases on the repository's
/// own source.
#[test]
fn the_source_check_finds_each_failure_on_its_own() {
    let found =
        |file: &str, text: &str| failure_check::unmarked(file, text).into_iter().map(|(_, holds)| holds).collect::<Vec<_>>();
    // Small sources of their own, so this half runs anywhere.
    let unmarked = [
        // A function that marks one failure and not the other.
        (
            "fn f(x: bool) -> Response {\n    if x {\n        return crate::cache::unshared(StatusCode::NOT_FOUND.into_response());\n    }\n    StatusCode::SERVICE_UNAVAILABLE.into_response()\n}\n",
            "StatusCode::SERVICE_UNAVAILABLE.into_response()",
        ),
        // A mark's name in a string or a comment.
        (
            "fn f() -> Response {\n    let res = StatusCode::BAD_REQUEST.into_response(); // crate::cache::unshared(res)\n    let _ = \"crate::cache::unshared(res)\";\n    res\n}\n",
            "let res = StatusCode::BAD_REQUEST.into_response();",
        ),
        // `Error::new` passed as a function.
        (
            "fn f(to: &str) -> Result<HeaderValue, Error> {\n    let value = HeaderValue::try_from(to).map_err(Error::new)?;\n    Ok(value)\n}\n",
            "map_err(Error::new)",
        ),
        // A status set on a response that was not marked where it was made.
        (
            "fn f() -> Response {\n    let mut res = \"no\".into_response();\n    *res.status_mut() = StatusCode::FORBIDDEN;\n    res\n}\n",
            "*res.status_mut() = StatusCode::FORBIDDEN;",
        ),
        // A JSON-RPC error made without a mark.
        ("fn f(id: Value) -> Response {\n    reply(id, Err((-32601, \"method not found\".into())))\n}\n", "reply(id, Err((-32601,"),
        // One binding, a marked early return and an unmarked final expression (review round 14).
        (
            "fn f(condition: bool) -> Response {\n    let status = StatusCode::FORBIDDEN;\n    if condition {\n        return crate::cache::unshared(status.into_response());\n    }\n    status.into_response()\n}\n",
            "let status = StatusCode::FORBIDDEN;",
        ),
        // The same with the unmarked use first.
        (
            "fn f(condition: bool) -> Response {\n    let status = StatusCode::FORBIDDEN;\n    if condition {\n        return status.into_response();\n    }\n    crate::cache::unshared(status.into_response())\n}\n",
            "let status = StatusCode::FORBIDDEN;",
        ),
    ];
    for (source, holds) in unmarked {
        let got = found("x.rs", source);
        assert!(got.iter().any(|line| line.contains(holds)), "not found: {holds}, in {got:?}\n{source}");
    }
    let marked = [
        "fn f() -> Response {\n    crate::cache::unshared(StatusCode::NOT_FOUND.into_response())\n}\n",
        "fn f(to: &str) -> Result<HeaderValue, Error> {\n    HeaderValue::try_from(to).map_err(Error::corten)\n}\n",
        "fn f() -> Response {\n    let mut res = crate::cache::unshared(\"no\".into_response());\n    *res.status_mut() = StatusCode::FORBIDDEN;\n    res\n}\n",
        "fn f(ok: bool) -> Response {\n    let status = if ok { StatusCode::OK } else { StatusCode::BAD_REQUEST };\n    crate::cache::unshared(status.into_response())\n}\n",
        "fn f() -> Response {\n    let refused = |status: StatusCode| crate::cache::unshared(status.into_response());\n    refused(StatusCode::GONE)\n}\n",
        "fn f(status: StatusCode) -> bool {\n    status == StatusCode::NOT_FOUND || matches!(status, StatusCode::GONE)\n}\n",
        // One binding, every exit marked.
        "fn f(condition: bool) -> Response {\n    let status = StatusCode::FORBIDDEN;\n    if condition {\n        return crate::cache::unshared(status.into_response());\n    }\n    crate::cache::unshared(status.into_response())\n}\n",
    ];
    for source in marked {
        let got = found("x.rs", source);
        assert!(got.is_empty(), "{got:?}\n{source}");
    }
    // The three changes review round 13 found the previous check let through, and a fourth on the
    // MCP endpoint's own helper, each made to the repository's source.
    let Some(sources) = failure_check::sources() else { return };
    let source = |file: &str| sources.iter().find(|(name, _)| name == file).map(|(_, text)| text.clone()).unwrap();
    for (file, from, to, holds) in [
        // The deadline's 503 without its wrapper, in a function that makes other failures marked.
        (
            "page.rs",
            "crate::cache::unshared(StatusCode::SERVICE_UNAVAILABLE.into_response())",
            "StatusCode::SERVICE_UNAVAILABLE.into_response()",
            "let mut res = StatusCode::SERVICE_UNAVAILABLE.into_response();",
        ),
        // The MCP endpoint's mark replaced by an unused string that names it.
        (
            "agent.rs",
            "let mut res = crate::cache::unshared(json_response(",
            "let _ = \"crate::cache::unshared\";\n    let mut res = (json_response(",
            "*res.status_mut() = StatusCode::BAD_REQUEST;",
        ),
        // `map_err(Error::corten)` made `map_err(Error::new)`.
        ("page.rs", "map_err(Error::corten)", "map_err(Error::new)", "map_err(Error::new)"),
        // The helper every other JSON-RPC error goes through, without its mark.
        (
            "agent.rs",
            "let mut res = crate::cache::unshared(reply(id, Err((code, message))));",
            "let mut res = reply(id, Err((code, message)));\n    let _ = \"unshared\";",
            "helper rpc_error",
        ),
    ] {
        let text = source(file);
        assert!(text.contains(from), "{file} no longer holds {from:?}: change this case to what it holds now");
        let before = found(file, &text);
        let after = found(file, &text.replacen(from, to, 1));
        let new: Vec<_> = after.iter().filter(|line| !before.contains(line)).collect();
        assert!(new.iter().any(|line| line.contains(holds)), "{file}: {from:?} made {to:?} was not found: {new:?}");
    }
}

/// The source check's reading of Rust: tokens, not a parse (see
/// `corten_makes_its_failures_through_the_constructors_that_mark_them` for what that leaves out).
mod failure_check {
    /// The failing statuses, by `http::StatusCode`'s names.
    const FAILING: &[&str] = &[
        "BAD_REQUEST",
        "UNAUTHORIZED",
        "PAYMENT_REQUIRED",
        "FORBIDDEN",
        "NOT_FOUND",
        "METHOD_NOT_ALLOWED",
        "NOT_ACCEPTABLE",
        "PROXY_AUTHENTICATION_REQUIRED",
        "REQUEST_TIMEOUT",
        "CONFLICT",
        "GONE",
        "LENGTH_REQUIRED",
        "PRECONDITION_FAILED",
        "PAYLOAD_TOO_LARGE",
        "URI_TOO_LONG",
        "UNSUPPORTED_MEDIA_TYPE",
        "RANGE_NOT_SATISFIABLE",
        "EXPECTATION_FAILED",
        "IM_A_TEAPOT",
        "MISDIRECTED_REQUEST",
        "UNPROCESSABLE_ENTITY",
        "LOCKED",
        "FAILED_DEPENDENCY",
        "TOO_EARLY",
        "UPGRADE_REQUIRED",
        "PRECONDITION_REQUIRED",
        "TOO_MANY_REQUESTS",
        "REQUEST_HEADER_FIELDS_TOO_LARGE",
        "UNAVAILABLE_FOR_LEGAL_REASONS",
        "INTERNAL_SERVER_ERROR",
        "NOT_IMPLEMENTED",
        "BAD_GATEWAY",
        "SERVICE_UNAVAILABLE",
        "GATEWAY_TIMEOUT",
        "HTTP_VERSION_NOT_SUPPORTED",
        "VARIANT_ALSO_NEGOTIATES",
        "INSUFFICIENT_STORAGE",
        "LOOP_DETECTED",
        "NOT_EXTENDED",
        "NETWORK_AUTHENTICATION_REQUIRED",
    ];

    /// The marks, each read as a token (not after a letter, a digit or `_`): a constructor that
    /// marks the failure it makes, or a value answered only marked, taken at its word.
    pub(super) const MARKS: &[&str] = &[
        "Error::corten",
        "unshared(",
        "unshared_in_place_of(",
        // Either passed as a function: `.map(cache::unshared)`.
        "unshared)",
        "corten: true",
        "corten: self.corten",
        // Mark themselves as they become a response.
        "BodyRejection::new(",
        "FormRejection::invalid(",
        "Why::Refusal",
        // agent.rs: answered by `rpc_error` alone.
        "CallError::Rpc(",
    ];

    /// A file's functions that mark what they make, each checked to hold one of [`MARKS`].
    pub(super) const HELPERS: &[(&str, &str)] = &[("agent.rs", "rpc_error"), ("response.rs", "invalid_header")];

    /// The crate's source files outside the tests, by their path under `src/`, or `None` outside
    /// the repository.
    pub(super) fn sources() -> Option<Vec<(String, String)>> {
        fn files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap().map(Result::unwrap) {
                let path = entry.path();
                let name = entry.file_name().into_string().unwrap();
                if path.is_dir() {
                    if name != "tests" && name != "type_tests" {
                        files(&path, out);
                    }
                } else if name.ends_with(".rs") && name != "tests.rs" {
                    out.push(path);
                }
            }
        }
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        if !src.join("cache.rs").is_file() {
            return None;
        }
        let mut paths = Vec::new();
        files(&src, &mut paths);
        paths.sort();
        Some(
            paths
                .into_iter()
                .map(|path| {
                    let file = path.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
                    (file, std::fs::read_to_string(&path).unwrap())
                })
                .collect(),
        )
    }

    /// The source's failures with none of [`MARKS`] where they are made or go next, by line (`0`
    /// for a helper of [`HELPERS`] that holds none) and what that line holds.
    pub(super) fn unmarked(file: &str, text: &str) -> Vec<(usize, String)> {
        let cleaned = clean(text);
        let t = &cleaned[..];
        let helpers: Vec<&[u8]> = HELPERS.iter().filter(|(at, _)| *at == file).map(|(_, name)| name.as_bytes()).collect();
        let mut found = Vec::new();
        for name in &helpers {
            let body = fn_named(t, name).map(|start| {
                let open = find(t, start, b"{").map_or(t.len(), |i| i + 1);
                &t[start..block_end(t, open)]
            });
            if !body.is_some_and(|body| marked(body, &[])) {
                found.push((0, format!("helper {} marks nothing", String::from_utf8_lossy(name))));
            }
        }
        for p in producers(t) {
            let f = function(t, p);
            // The helpers, and the closures of the same function made before it that mark.
            let mut names = helpers.clone();
            let mut from = f;
            while let Some(i) = find(&t[..p], from, b"let") {
                from = i + 3;
                let Some((start, end)) = let_at(t, i, false) else { continue };
                let eq = skip_space(t, end);
                if at(t, eq) != b'=' {
                    continue;
                }
                let mut body = skip_space(t, eq + 1);
                if t[body..].starts_with(b"move") && at(t, body + 4).is_ascii_whitespace() {
                    body = skip_space(t, body + 4);
                }
                if at(t, body) == b'|' {
                    let (s, e) = scope(t, body + 1);
                    if marked(&t[s..e], &helpers) {
                        names.push(&t[start..end]);
                    }
                }
            }
            let (s, e) = scope(t, p);
            let mut ok = marked(&t[s..e], &names);
            let head = trim(&t[s..e]);
            // A status set on a response: marked where the response was bound.
            if !ok && head.starts_with(b"*") {
                let v = skip_space(head, 1);
                let v_end = ident(head, v);
                if v_end > v && head[v_end..].starts_with(b".status_mut()") && at(head, skip_space(head, v_end + 13)) == b'=' {
                    if let Some(made) = bound(t, f, s, &head[v..v_end]) {
                        let (bs, be) = scope(t, made);
                        ok = marked(&t[bs..be], &names);
                    }
                }
            }
            // A value bound to a name: marked where the name is used, in the rest of its block, at
            // every use, since each may be an exit of its own (a marked early return does not mark
            // the unmarked final expression after it). A binding no statement uses is unmarked.
            if !ok {
                if let Some((v, v_end)) = let_at(head, 0, true) {
                    let name = &head[v..v_end];
                    let end = block_end(t, e);
                    let mut from = e;
                    let mut uses = 0;
                    let mut every = true;
                    while let Some(i) = find(&t[..end], from, name) {
                        from = i + 1;
                        if word(before(t, i)) || word(at(t, i + name.len())) {
                            continue;
                        }
                        uses += 1;
                        let (us, ue) = scope(t, i);
                        if !marked(&t[us..ue], &names) {
                            every = false;
                            break;
                        }
                    }
                    ok = uses > 0 && every;
                }
            }
            if !ok {
                let line = t[..p].iter().filter(|&&c| c == b'\n').count() + 1;
                found.push((line, text.lines().nth(line - 1).unwrap_or("").trim().to_owned()));
            }
        }
        found
    }

    /// Where the last binding of `name` in `t[from..to]` (`let name =`, `let mut name =` or a
    /// statement `name = ..`) gives it its value.
    fn bound(t: &[u8], from: usize, to: usize, name: &[u8]) -> Option<usize> {
        let mut last = None;
        let mut k = from;
        while let Some(i) = find(&t[..to], k, name) {
            k = i + 1;
            if word(before(t, i)) || word(at(t, i + name.len())) {
                continue;
            }
            let eq = skip_space(t, i + name.len());
            if at(t, eq) != b'=' || at(t, eq + 1) == b'=' {
                continue;
            }
            let lead = trim_end(&t[from..i]);
            let declared = ends_with_word(lead, "let")
                || (ends_with_word(lead, "mut") && ends_with_word(trim_end(&lead[..lead.len() - 3]), "let"))
                || lead.last().is_some_and(|c| b";{}".contains(c));
            if declared {
                last = Some(eq + 1);
            }
        }
        last
    }

    /// Whether `x` holds one of [`MARKS`], or calls one of `names` (a helper or a closure that
    /// marks).
    fn marked(x: &[u8], names: &[&[u8]]) -> bool {
        MARKS.iter().any(|mark| holds(x, mark.as_bytes(), false)) || names.iter().any(|name| holds(x, name, true))
    }

    /// Where the source makes a failure: a failing status named to answer with (not one compared,
    /// matched or mapped from), an `Error` made with `Error::new`, `Error::status`,
    /// `Error::not_found` or `Error { status, .. }`, and a JSON-RPC error code.
    fn producers(t: &[u8]) -> Vec<usize> {
        let mut out = Vec::new();
        let mut from = 0;
        while let Some(i) = find(t, from, b"StatusCode::") {
            from = i + 1;
            let name = i + "StatusCode::".len();
            let mut end = name;
            while end < t.len() && (t[end].is_ascii_uppercase() || t[end] == b'_') {
                end += 1;
            }
            if !FAILING.iter().any(|failing| failing.as_bytes() == &t[name..end]) || word(at(t, end)) {
                continue;
            }
            let line = t[..i].iter().rposition(|&c| c == b'\n').map_or(0, |k| k + 1);
            let line_end = find(t, i, b"\n").unwrap_or(t.len());
            let mut lead = &t[line..i];
            for path in [&b"::http::"[..], b"http::", b"crate::"] {
                if let Some(rest) = lead.strip_suffix(path) {
                    lead = rest;
                    break;
                }
            }
            let lead = trim_end(lead);
            let rest = trim(&t[end..line_end]);
            let compared = lead.ends_with(b"==") || lead.ends_with(b"!=") || lead.ends_with(b"|");
            let pattern = rest.starts_with(b"|") || rest.starts_with(b"=>");
            let mapped = lead.ends_with(b"=>") && (rest.is_empty() || rest == b",");
            if !(compared || pattern || mapped || find(&t[line..line_end], 0, b"matches!(").is_some()) {
                out.push(i);
            }
        }
        let mut from = 0;
        while let Some(i) = find(t, from, b"Error") {
            from = i + 1;
            let rest = &t[i + "Error".len()..];
            let made =
                [&b"::new"[..], b"::status", b"::not_found"].iter().any(|k| rest.starts_with(k) && !word(at(rest, k.len())))
                    || rest.starts_with(b" { status");
            let p = if t[..i].ends_with(b"crate::") { i - "crate::".len() } else { i };
            if made && !(word(before(t, p)) || before(t, p) == b':') {
                out.push(p);
            }
        }
        let mut from = 0;
        while let Some(i) = find(t, from, b"-32") {
            from = i + 1;
            let digit = |k: usize| at(t, i + k).is_ascii_digit();
            let code = (at(t, i + 3) == b'0' && digit(4) && digit(5))
                || (matches!(at(t, i + 3), b'6' | b'7') && at(t, i + 4) == b'0' && digit(5));
            if code && !word(at(t, i + 6)) {
                out.push(i);
            }
        }
        out.sort_unstable();
        out
    }

    /// The statement, or the match arm, the offset `p` is in: through the struct literals, macro
    /// bodies and `if`/`else` blocks around it, which are part of one expression.
    fn scope(t: &[u8], p: usize) -> (usize, usize) {
        let (mut depth, mut start, mut arm, mut through) = (0i32, 0, false, 0usize);
        for i in (0..p).rev() {
            match t[i] {
                // A block with no `;` after it (an `if`, a `match`, a macro's body) ends its
                // statement where the next one starts with a word.
                b'}' if depth == 0 && starts_statement(t, i + 1) => {
                    start = i + 1;
                    break;
                }
                b')' | b']' | b'}' => depth += 1,
                b'(' | b'[' => depth -= 1,
                b'{' if depth > 0 => depth -= 1,
                b'{' if group(t, i) || valued(t, i) => through += 1,
                b'{' | b';' if t[i] == b'{' || depth <= 0 => {
                    start = i + 1;
                    break;
                }
                b'>' if before(t, i) == b'=' && depth <= 0 => {
                    start = i + 1;
                    arm = true;
                    break;
                }
                _ => {}
            }
        }
        let (mut depth, mut braces, mut end) = (0i32, 0usize, t.len());
        for (i, &c) in t.iter().enumerate().skip(p) {
            match c {
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                b'{' => braces += 1,
                b'}' if braces > 0 => braces -= 1,
                b'}' if through > 0 => through -= 1,
                b'}' => {
                    end = i;
                    break;
                }
                b';' | b',' if depth <= 0 && braces == 0 && (c == b';' || arm) => {
                    end = i;
                    break;
                }
                _ => {}
            }
        }
        (start, end)
    }

    /// Whether what follows a `}` at `i` is a statement of its own: a word that is not `else` or
    /// `as`.
    fn starts_statement(t: &[u8], i: usize) -> bool {
        let k = skip_space(t, i);
        let mut end = k;
        while word(at(t, end)) {
            end += 1;
        }
        end > k && !at(t, k).is_ascii_digit() && !matches!(&t[k..end], b"else" | b"as")
    }

    /// Whether the `{` at `i` opens a struct literal or a macro's body rather than a block.
    fn group(t: &[u8], i: usize) -> bool {
        let Some(k) = t[..i].iter().rposition(|c| !c.is_ascii_whitespace()) else { return false };
        if b"([,!".contains(&t[k]) {
            return true;
        }
        let mut start = k + 1;
        while start > 0 && word(t[start - 1]) {
            start -= 1;
        }
        let id = &t[start..=k];
        if !id.first().is_some_and(u8::is_ascii_uppercase) || !id.iter().any(u8::is_ascii_lowercase) {
            return false;
        }
        while start >= 2 && t[start - 1] == b':' && t[start - 2] == b':' {
            start -= 2;
            while start > 0 && word(t[start - 1]) {
                start -= 1;
            }
        }
        let lead = trim_end(&t[..start]);
        !(lead.ends_with(b"->")
            || lead.ends_with(b":")
            || lead.ends_with(b"<")
            || lead.ends_with(b"+")
            || ["impl", "for", "struct", "enum", "trait", "dyn"].iter().any(|w| ends_with_word(lead, w)))
    }

    /// Whether the `{` at `i` opens a block whose value is the expression's: an `if`'s or an
    /// `else`'s.
    fn valued(t: &[u8], i: usize) -> bool {
        let lead = trim_end(&t[..i]);
        if ends_with_word(lead, "else") {
            return true;
        }
        let mut depth = 0;
        let mut start = 0;
        for k in (0..lead.len()).rev() {
            match lead[k] {
                b')' | b']' | b'}' => depth += 1,
                b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
                b'(' | b'[' | b'{' | b';' if lead[k] != b';' || depth == 0 => {
                    start = k + 1;
                    break;
                }
                _ => {}
            }
        }
        let head = &lead[start..];
        let has_if = (0..head.len()).any(|k| {
            head[k..].starts_with(b"if") && (k == 0 || !word(head[k - 1])) && head.get(k + 2).is_some_and(u8::is_ascii_whitespace)
        });
        has_if && !holds(head, b"fn", true)
    }

    /// The end of the block the offset `p` is in: its unmatched `}`.
    fn block_end(t: &[u8], p: usize) -> usize {
        let mut depth = 0;
        for (i, &c) in t.iter().enumerate().skip(p) {
            if c == b'{' {
                depth += 1;
            } else if c == b'}' {
                if depth == 0 {
                    return i;
                }
                depth -= 1;
            }
        }
        t.len()
    }

    /// Where the last `fn` before `p` starts: the function `p` is in, as far as tokens tell.
    fn function(t: &[u8], p: usize) -> usize {
        let mut last = 0;
        let mut from = 0;
        while let Some(i) = find(&t[..p], from, b"fn") {
            from = i + 2;
            let name = skip_space(t, i + 2);
            if !word(before(t, i)) && at(t, i + 2).is_ascii_whitespace() && ident(t, name) > name {
                last = i;
            }
        }
        last
    }

    /// Where `fn name` starts.
    fn fn_named(t: &[u8], name: &[u8]) -> Option<usize> {
        let mut from = 0;
        while let Some(i) = find(t, from, b"fn ") {
            from = i + 1;
            if !word(before(t, i)) && t[i + 3..].starts_with(name) && !word(at(t, i + 3 + name.len())) {
                return Some(i);
            }
        }
        None
    }

    /// `let` at `i`, then a name (after `mut` if `mutable`): where the name starts and ends.
    fn let_at(t: &[u8], i: usize, mutable: bool) -> Option<(usize, usize)> {
        if !t[i..].starts_with(b"let") || word(before(t, i)) || !at(t, i + 3).is_ascii_whitespace() {
            return None;
        }
        let mut name = skip_space(t, i + 3);
        if mutable && t[name..].starts_with(b"mut") && at(t, name + 3).is_ascii_whitespace() {
            name = skip_space(t, name + 3);
        }
        let end = ident(t, name);
        (end > name && !word(at(t, end))).then_some((name, end))
    }

    /// The end of a lowercase name starting at `i` (`i` if there is none).
    fn ident(t: &[u8], i: usize) -> usize {
        if !(at(t, i).is_ascii_lowercase() || at(t, i) == b'_') {
            return i;
        }
        let mut end = i;
        while at(t, end).is_ascii_lowercase() || at(t, end).is_ascii_digit() || at(t, end) == b'_' {
            end += 1;
        }
        end
    }

    /// The source without its test modules, with its comments and the insides of its string and
    /// character literals blanked: the same lines, so a line number is the source's.
    fn clean(text: &str) -> Vec<u8> {
        let kept = without_tests(text);
        let t = kept.as_bytes();
        let n = t.len();
        let mut out = t.to_vec();
        let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
            for c in out.iter_mut().take(to.min(n)).skip(from) {
                if *c != b'\n' {
                    *c = b' ';
                }
            }
        };
        let mut i = 0;
        while i < n {
            let c = t[i];
            if c == b'/' && at(t, i + 1) == b'/' {
                let end = find(t, i, b"\n").unwrap_or(n);
                blank(&mut out, i, end);
                i = end;
                continue;
            }
            if c == b'/' && at(t, i + 1) == b'*' {
                let (mut depth, mut k) = (1, i + 2);
                while k < n && depth > 0 {
                    if t[k] == b'/' && at(t, k + 1) == b'*' {
                        depth += 1;
                        k += 2;
                    } else if t[k] == b'*' && at(t, k + 1) == b'/' {
                        depth -= 1;
                        k += 2;
                    } else {
                        k += 1;
                    }
                }
                blank(&mut out, i, k);
                i = k;
                continue;
            }
            if (c == b'r' || (c == b'b' && at(t, i + 1) == b'r')) && !word(before(t, i)) {
                let mut k = if c == b'b' { i + 2 } else { i + 1 };
                let mut hashes = 0;
                while at(t, k) == b'#' {
                    hashes += 1;
                    k += 1;
                }
                if at(t, k) == b'"' {
                    let close: Vec<u8> = std::iter::once(b'"').chain(std::iter::repeat_n(b'#', hashes)).collect();
                    let end = find(t, k + 1, &close).unwrap_or(n);
                    blank(&mut out, k + 1, end);
                    i = end + close.len();
                    continue;
                }
            }
            if c == b'"' {
                let mut k = i + 1;
                while k < n && t[k] != b'"' {
                    if t[k] == b'\\' {
                        k += 1;
                    }
                    k += 1;
                }
                blank(&mut out, i + 1, k);
                i = k + 1;
                continue;
            }
            if c == b'\'' {
                if at(t, i + 1) == b'\\' {
                    let end = find(t, i + 3, b"'").unwrap_or(n);
                    blank(&mut out, i + 1, end);
                    i = end + 1;
                    continue;
                }
                if at(t, i + 2) == b'\'' {
                    blank(&mut out, i + 1, i + 2);
                    i += 3;
                    continue;
                }
            }
            i += 1;
        }
        out
    }

    /// The source with each `#[cfg(test)]` module's lines emptied.
    fn without_tests(text: &str) -> String {
        let mut lines: Vec<&str> = text.split('\n').collect();
        let mut at = 0;
        while at < lines.len() {
            if lines[at].trim() == "#[cfg(test)]" {
                let mut item = at + 1;
                while item < lines.len() && lines[item].trim().starts_with("#[") {
                    item += 1;
                }
                if let Some(line) = lines.get(item).filter(|line| line.trim_end().ends_with('{') && line.contains("mod ")) {
                    let close = format!("{}}}", &line[..line.len() - line.trim_start().len()]);
                    let end = (item + 1..lines.len()).find(|&k| lines[k].trim_end() == close).unwrap_or(lines.len() - 1);
                    for line in &mut lines[at..=end] {
                        *line = "";
                    }
                    at = end;
                }
            }
            at += 1;
        }
        lines.join("\n")
    }

    fn word(c: u8) -> bool {
        c.is_ascii_alphanumeric() || c == b'_'
    }

    /// The byte at `i`, or `0` past the end.
    fn at(t: &[u8], i: usize) -> u8 {
        t.get(i).copied().unwrap_or(0)
    }

    /// The byte before `i`, or `0` at the start.
    fn before(t: &[u8], i: usize) -> u8 {
        i.checked_sub(1).map_or(0, |i| t[i])
    }

    fn skip_space(t: &[u8], mut i: usize) -> usize {
        while at(t, i).is_ascii_whitespace() {
            i += 1;
        }
        i
    }

    fn find(t: &[u8], from: usize, what: &[u8]) -> Option<usize> {
        t.get(from..)?.windows(what.len()).position(|window| window == what).map(|i| from + i)
    }

    fn trim_end(t: &[u8]) -> &[u8] {
        &t[..t.iter().rposition(|c| !c.is_ascii_whitespace()).map_or(0, |i| i + 1)]
    }

    fn trim(t: &[u8]) -> &[u8] {
        let t = trim_end(t);
        &t[t.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(t.len())..]
    }

    /// Whether `t` ends with the word `w`.
    fn ends_with_word(t: &[u8], w: &str) -> bool {
        t.ends_with(w.as_bytes()) && !word(before(t, t.len() - w.len()))
    }

    /// Whether `t` holds `what` with no letter, digit or `_` before it, nor after it if `whole`.
    fn holds(t: &[u8], what: &[u8], whole: bool) -> bool {
        let mut from = 0;
        while let Some(i) = find(t, from, what) {
            from = i + 1;
            if !word(before(t, i)) && !(whole && word(at(t, i + what.len()))) {
                return true;
            }
        }
        false
    }
}

/// The mark of a failure Corten made (`Error::corten`) is a flag in what was the padding of
/// `Error`: it takes no room in a handler's `Result`.
#[test]
fn the_mark_of_corten_s_failure_takes_no_room_in_an_error() {
    assert_eq!(std::mem::size_of::<Error>(), std::mem::size_of::<(StatusCode, Box<dyn std::error::Error + Send + Sync>)>());
}
