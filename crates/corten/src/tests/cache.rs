use super::api::api_module;
use super::security::{big_policy_page, inline_page, relayed_page};
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
        assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store", "{path}");
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
        ("/quoted", "no-store"),
        ("/quoted-failure", "no-store"),
        ("/valued", "no-store"),
        ("/second-line", "public, max-age=600, no-store"),
        ("/second-line-valued", "no-store"),
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
    assert_eq!(head.headers[header::CONTENT_LENGTH], stored.headers[header::CONTENT_LENGTH]);
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
