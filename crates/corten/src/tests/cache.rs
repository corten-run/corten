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

/// A `Public` page's whole document is kept from the second time its URL is asked for: the
/// next request that shows nothing about who asks gets the same answer with its age, and the
/// handler does not run. A request the page could differ for is the handler's, and does not take
/// the kept one's place.
#[tokio::test]
async fn a_public_page_is_kept_and_given_again_in_its_handler_s_place() {
    let runs = Runs::default();
    let router = App::new(Routes::from(kept_routes(&runs))).router();
    let (status, once, unkept) = fetch(&router, "GET", "/", &[]).await;
    assert_eq!((status, runs.count()), (StatusCode::OK, 1));
    let (status, first, body) = fetch(&router, "GET", "/", &[]).await;
    assert_eq!((status, runs.count()), (StatusCode::OK, 2), "a URL asked for once is made again, and kept then");
    assert!(!first.contains_key(header::AGE), "the handler's own answer: {first:?}");
    assert_eq!(first[header::CACHE_CONTROL], "public, max-age=60");
    assert!(once == first && unkept == body, "the answer that was not kept is the one that was, line for line");

    let (status, mut again, same) = fetch(&router, "GET", "/", &[]).await;
    assert_eq!((status, runs.count()), (StatusCode::OK, 2), "the kept page, not the handler");
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
    let mut ran = 2;
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
    // Another query is another page, which is asked for twice before it is kept.
    for _ in 0..3 {
        fetch(&router, "GET", "/?page=2", &[]).await;
    }
    assert_eq!(runs.count(), ran + 2);
}

/// A page is kept from the second time its URL is asked for, by requests a kept page could
/// answer: one it could not is not an ask. A page that was given to a request and then went from
/// the store (a write here) is kept again the next time it is asked for.
#[tokio::test]
async fn a_page_is_kept_from_the_second_time_its_url_is_asked_for() {
    let runs = Runs::default();
    let router = App::new(Routes::from(kept_routes(&runs))).router();
    let kept = |router: Router, asked: &'static [(&'static str, &'static str)]| async move {
        fetch(&router, "GET", "/", asked).await.1.contains_key(header::AGE)
    };
    // Requests the page could differ for are the handler's however often they come.
    for _ in 0..3 {
        assert!(!kept(router.clone(), &[("cookie", "session=abc")]).await);
        assert!(!kept(router.clone(), &[("corten", "nav")]).await);
    }
    assert_eq!(runs.count(), 6);
    assert!(!kept(router.clone(), &[]).await, "the first ask: none of those was one");
    assert!(!kept(router.clone(), &[]).await, "the second, whose answer is kept");
    assert!(kept(router.clone(), &[]).await && runs.count() == 8, "the third is given it");
    // The same URL for another host is asked for twice too: what one host's visitors asked for
    // says nothing to another's.
    assert!(!kept(router.clone(), &[("host", "127.0.0.1")]).await && !kept(router.clone(), &[("host", "127.0.0.1")]).await);
    assert!(kept(router.clone(), &[("host", "127.0.0.1")]).await && runs.count() == 10);
    // After a write the page is made once more, not twice: its URL was asked for before.
    let (status, _, _) = fetch(&router, "POST", "/", &[("sec-fetch-site", "same-origin")]).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(!kept(router.clone(), &[]).await);
    assert!(kept(router.clone(), &[]).await && runs.count() == 11);
    // A write between a URL's first two asks: the second answer is made after it, and is kept.
    let written = App::new(Routes::from(kept_routes(&runs))).router();
    assert!(!kept(written.clone(), &[]).await);
    let (status, _, _) = fetch(&written, "POST", "/", &[("sec-fetch-site", "same-origin")]).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(!kept(written.clone(), &[]).await);
    assert!(kept(written.clone(), &[]).await && runs.count() == 13);
    // An app that keeps none makes every one.
    let none = App::new(Routes::from(kept_routes(&runs))).kept_answers(0).router();
    for _ in 0..3 {
        assert!(!kept(none.clone(), &[]).await);
    }
    assert_eq!(runs.count(), 16);
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
    // Asked for once, so the next answer is the one kept.
    fetch(&router, "GET", "/", &coded).await;
    let (_, first, body) = fetch(&router, "GET", "/", &coded).await;
    let (_, second, same) = fetch(&router, "GET", "/", &coded).await;
    assert_eq!((runs.count(), requests.count()), (2, 3), "one render kept, each request through the middleware");
    assert_eq!((first["x-request"].to_str().unwrap(), second["x-request"].to_str().unwrap()), ("2", "3"));
    assert!(second.contains_key(header::AGE) && same == body);
    let (status, _, _) = fetch(&router, "GET", "/", &[("x-flood", "1")]).await;
    assert_eq!((status, runs.count()), (StatusCode::TOO_MANY_REQUESTS, 2), "a refusal is not passed by");
    let tag = first[header::ETAG].to_str().unwrap();
    assert_eq!(second[header::ETAG], tag, "the kept page has the handler's tag");
    let (status, headers, none) = fetch(&router, "GET", "/", &[("if-none-match", tag)]).await;
    assert_eq!((status, runs.count(), requests.count()), (StatusCode::NOT_MODIFIED, 2, 4));
    assert!(none.is_empty() && headers["x-request"] == "4", "{headers:?}");
}

/// A kept page's tag and its bytes in every coding are those the handler's own answer has in an
/// app that keeps none: only who makes them, and how often, differs.
#[tokio::test]
async fn a_kept_page_has_the_tag_and_the_coded_bytes_of_the_handler_s_answer() {
    let (runs, each) = (Runs::default(), Runs::default());
    let kept = App::new(Routes::from(kept_routes(&runs))).router();
    let none = App::new(Routes::from(kept_routes(&each))).kept_answers(0).router();
    // Asked for once, so the first answer below is the one kept.
    fetch(&kept, "GET", "/", &[]).await;
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
    assert_eq!((runs.count(), each.count()), (2, 14), "one render kept for all of them");
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
    // Asked for once, so the page is kept from the next.
    fetch(&router, "GET", "/", &[]).await;
    reads(router.clone()).await;
    assert_eq!(runs.count(), 2);
    // A write another site sent is refused before the app's middleware and is not counted, or
    // any site could have the app's pages made again through its visitors' browsers.
    let cross = [("origin", "https://other.example"), ("sec-fetch-site", "cross-site")];
    let (status, _, _) = fetch(&router, "POST", "/", &cross).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    reads(router.clone()).await;
    assert_eq!(runs.count(), 2, "a write another site sent");
    // The router's own answers: the route has no `POST` (405), and no route has a `DELETE` (501).
    // A middleware may have met either, so each counts as any write does.
    fetch(&router, "GET", "/read", &[]).await;
    assert!(!fetch(&router, "GET", "/read", &[]).await.1.contains_key(header::AGE));
    assert!(fetch(&router, "GET", "/read", &[]).await.1.contains_key(header::AGE));
    let (status, _, _) = fetch(&router, "POST", "/read", &same_origin).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert!(!fetch(&router, "GET", "/read", &[]).await.1.contains_key(header::AGE));
    assert!(fetch(&router, "GET", "/", &[]).await.1.contains_key(header::AGE), "and that path alone");
    assert_eq!((runs.count(), read.count()), (2, 3), "a write to a path with no handler for it");
    let (status, _, _) = fetch(&router, "DELETE", "/", &same_origin).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    reads(router.clone()).await;
    assert_eq!(runs.count(), 3, "a write in a method no route has");
    let (status, _, _) = fetch(&router, "PUT", "/", &same_origin).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    reads(router.clone()).await;
    assert_eq!(runs.count(), 4, "a write its handler refused, which may have saved first");
    let (status, _, _) = fetch(&router, "POST", "/", &same_origin).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    reads(router.clone()).await;
    assert_eq!(runs.count(), 5, "a write to the page's URL");
    let (status, headers, _) = fetch(&router, "POST", "/saved", &same_origin).await;
    assert_eq!((status, headers[header::LOCATION].to_str().unwrap()), (StatusCode::SEE_OTHER, "/"));
    reads(router.clone()).await;
    assert_eq!(runs.count(), 6, "a write that redirects to it");
    // As the runtime's form submit is answered: the place is in `corten-location`.
    let (_, headers, _) = fetch(&router, "POST", "/saved", &[("sec-fetch-site", "same-origin"), ("corten", "action")]).await;
    assert_eq!(headers["corten-location"], "/", "{headers:?}");
    reads(router.clone()).await;
    assert_eq!(runs.count(), 7);
    // Every page at the path: a named post is `?do=name` there, and the page has other queries.
    fetch(&router, "GET", "/?page=2", &[]).await;
    fetch(&router, "GET", "/?page=2", &[]).await;
    assert!(fetch(&router, "GET", "/?page=2", &[]).await.1.contains_key(header::AGE));
    assert_eq!(runs.count(), 9);
    let (status, _, _) = fetch(&router, "POST", "/?do=save", &same_origin).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    fetch(&router, "GET", "/?page=2", &[]).await;
    reads(router.clone()).await;
    assert_eq!(runs.count(), 11, "the page and its other query, both made again");
    assert!(fetch(&router, "GET", "/read", &[]).await.1.contains_key(header::AGE), "and no other path's page");
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
    // Kept from the second time it is asked for.
    assert!(!kept(router.clone()).await && !kept(router.clone()).await && kept(router.clone()).await);

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
    assert_eq!(runs.count(), 5);
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
    assert!(keyed::<()>() && keyed::<(Req,)>() && keyed::<(Option<Req>,)>());
    assert!(keyed::<(
        crate::Params<caller_url::Catalog>,
        crate::Form<()>,
        crate::extract::State<()>,
        crate::Signal,
        http::Method,
        http::Uri,
        Req
    )>());
    assert!(!keyed::<(Req, Device)>() && !keyed::<(Option<Device>,)>(), "an input of the app's own");
    assert!(!keyed::<(crate::Upload<()>, Req)>() && !keyed::<(crate::LiveSince,)>() && !keyed::<(Req, crate::LiveSince)>());
    #[cfg(feature = "json")]
    assert!(!keyed::<(crate::Json<()>,)>());
    #[cfg(feature = "feed")]
    assert!(!keyed::<(corten_feed::Since,)>());
}

/// A page whose handler was reading while a write to its path went through may show what was
/// there before: it is sent, and not kept.
#[tokio::test]
async fn a_page_made_while_a_write_went_through_is_not_kept() {
    let (runs, written) = (Runs::default(), std::sync::Arc::new(tokio::sync::Notify::new()));
    let (counted, wait) = (runs.clone(), written.clone());
    let page = move |req: Req| {
        counted.ran();
        // The second time it is asked for, which is the answer that would be kept.
        let (second, wait) = (counted.count() == 2, wait.clone());
        async move {
            if second {
                wait.notified().await;
            }
            Public::new(Duration::from_secs(60), req.test_page_for("Slow", html! { <p>"slow"</p> }))
        }
    };
    let routes = Table::new().route("/", crate::route::get(page).0.post(|| async { StatusCode::NO_CONTENT }));
    let router = App::new(Routes::from(routes)).router();
    fetch(&router, "GET", "/", &[]).await;
    let reading = tokio::spawn({
        let router = router.clone();
        async move { fetch(&router, "GET", "/", &[]).await }
    });
    while runs.count() == 1 {
        tokio::task::yield_now().await;
    }
    let (status, _, _) = fetch(&router, "POST", "/", &[("sec-fetch-site", "same-origin")]).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    written.notify_one();
    let (status, headers, _) = reading.await.unwrap();
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE));
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert!(runs.count() == 3 && !headers.contains_key(header::AGE), "made again after the write: {headers:?}");
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert!(runs.count() == 3 && headers.contains_key(header::AGE), "and that one is kept");
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
    // Asked for once, so the next answer is the one kept.
    fetch(&router, "GET", "/shelf/books", &[]).await;
    let (status, first, body) = fetch(&router, "GET", "/shelf/books", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let (_, mut again, same) = fetch(&router, "GET", "/shelf/books", &[]).await;
    assert_eq!(SHELF_RUNS.load(std::sync::atomic::Ordering::Relaxed), 2);
    assert!(again.remove(header::AGE).is_some() && again == first && same == body, "{again:?}");
    assert!(first[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("https://pay.example"), "{first:?}");
    let (status, _, _) = fetch(&router, "GET", "/shelf/books", &[("x-flood", "1")]).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "the area's middleware still answers first");
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
/// nonce, failed, is not a page, has no lifetime or is too large for the bound; one whose handler
/// takes an input of the app's own; and nothing in an app that keeps none, or under `corten dev`.
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
    };
    let router = App::new(Routes::from(routes())).router();
    // Three times: an answer is kept from the second time its URL is asked for.
    let kept = |router: Router, uri: &'static str| async move {
        fetch(&router, "GET", uri, &[]).await;
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
        ("/text", "not a page"),
        ("/keyed", "a submit key drawn for this request"),
        ("/device", "an input of the app's own, which may read a header no key covers"),
        ("/missing", "no route"),
    ] {
        assert!(!kept(router.clone(), uri).await, "{uri}: {why}");
    }
    for uri in ["/", "/catalog", "/inputs"] {
        assert!(kept(router.clone(), uri).await, "{uri}");
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
        // Three times: were either kept, it would be from the second and given to the third.
        fetch(&router, "GET", "/", &[asked]).await;
        fetch(&router, "GET", "/", &[asked]).await;
        let (status, headers, _) = fetch(&router, "GET", "/", &[asked]).await;
        assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "{asked:?}: {headers:?}");
    }
    assert!(fetch(&router, "GET", "/", &[]).await.1.contains_key(header::AGE), "and neither took the kept page's place");
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
            Public::new(Duration::from_secs(600), page).shared(Duration::from_secs(2))
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
    // Each asked for once, so the next answer is the one kept.
    fetch(&router, "GET", "/", &[]).await;
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=600, s-maxage=2");
    assert!(fetch(&router, "GET", "/", &[]).await.1.contains_key(header::AGE) && runs.count() == 2, "kept for now");
    fetch(&router, "GET", "/long", &[]).await;
    fetch(&router, "GET", "/long", &[]).await;
    let making = tokio::spawn({
        let router = router.clone();
        async move {
            fetch(&router, "GET", "/slow", &[]).await;
            fetch(&router, "GET", "/slow", &[]).await
        }
    });
    // Past the brief page's two seconds, and well after the slow page was asked for again
    // (at 1.1 seconds), so nothing below is asked for between that page's two requests.
    tokio::time::sleep(Duration::from_millis(2300)).await;
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert!(runs.count() == 3 && !headers.contains_key(header::AGE), "past the shared lifetime: {headers:?}");
    // Its URL was asked for before, however long ago, so the page made now is kept without a second ask.
    assert!(fetch(&router, "GET", "/", &[]).await.1.contains_key(header::AGE) && runs.count() == 3, "kept again at once");
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

/// A page is kept for the `Host` it was asked with, and for the `Accept-Language` when the app
/// has more than one language (its `Vary` names the header then).
#[tokio::test]
async fn a_kept_page_is_for_the_host_and_the_language_it_was_asked_in() {
    crate::i18n::messages! { struct KeptMsg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
    let runs = Runs::default();
    let one = App::new(Routes::from(kept_routes(&runs))).router();
    // Each host's page is asked for twice before it is kept, and so is the page asked for with
    // no host.
    for (asked, ran) in [
        (("host", "localhost"), 1),
        (("host", "localhost"), 2),
        (("host", "127.0.0.1"), 3),
        (("host", "127.0.0.1"), 4),
        (("host", "localhost"), 4),
        (("host", "127.0.0.1"), 4),
        (("accept-language", "fr"), 5),
        (("accept-language", "de"), 6),
        (("accept-language", "fr"), 6),
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
    let asked =
        [("fr", "fr", 1), ("fr", "fr", 2), ("en", "en", 3), ("fr", "fr", 3), ("en", "en", 3), ("fr-CA, en;q=0.5", "fr", 4)];
    for (asked, lang, ran) in asked {
        let (_, headers, body) = fetch(&two, "GET", "/", &[("accept-language", asked)]).await;
        assert_eq!(headers[header::VARY], "corten, accept, accept-language");
        assert!(String::from_utf8_lossy(&body).contains(&format!("<p>in {lang}</p>")), "{asked}");
        assert_eq!(runs.count(), ran, "{asked}");
    }
    let (_, _, body) = fetch(&two, "GET", "/", &[]).await;
    assert!(String::from_utf8_lossy(&body).contains("<p>in en</p>") && runs.count() == 5, "none asked for is its own");
    // More ways of asking than a URL has copies for: each new one takes the oldest's place.
    let asked = |n: usize| format!("en, x-{n};q=0.1");
    for n in 0..=8 {
        fetch(&two, "GET", "/", &[("accept-language", &asked(n))]).await;
    }
    assert_eq!(runs.count(), 14);
    fetch(&two, "GET", "/", &[("accept-language", &asked(8))]).await;
    assert_eq!(runs.count(), 14, "the newest is kept");
    fetch(&two, "GET", "/", &[("accept-language", &asked(0))]).await;
    assert_eq!(runs.count(), 15, "the oldest went");

    // Messages read with no `App::messages`: no answer says it varies on the header, and the
    // page is still in the language asked for, so it is kept for each.
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
    let asked =
        [("fr", "Annonces", 1), ("fr", "Annonces", 2), ("en", "Listings", 3), ("fr", "Annonces", 3), ("en", "Listings", 3)];
    for (asked, word, ran) in asked {
        let (_, _, body) = fetch(&bare, "GET", "/", &[("accept-language", asked)]).await;
        assert!(String::from_utf8_lossy(&body).contains(word), "{asked}");
        assert_eq!(runs.count(), ran, "{asked}");
    }
}

/// A page whose styles come from data has a style block its `Content-Security-Policy` allows by
/// hash: the kept page is sent with the same policy, so the block still applies.
#[tokio::test]
async fn a_kept_page_keeps_the_hash_its_policy_allows_its_style_block_by() {
    let page = |req: Req| async move {
        Public::new(Duration::from_secs(60), req.test_page_for("Meters", html! { <TestMeter used={42.5} /> }))
    };
    let router = App::new(Routes::from(Table::new().route("/", crate::route::get(page).0))).components(&[TestMeter]).router();
    // Asked for once, so the next answer is the one kept.
    fetch(&router, "GET", "/", &[]).await;
    let (_, first, body) = fetch(&router, "GET", "/", &[]).await;
    let (_, again, same) = fetch(&router, "GET", "/", &[]).await;
    let policy = first[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    let styles = policy.split(';').find(|part| part.trim_start().starts_with("style-src")).expect("style-src");
    assert!(styles.contains("'sha256-"), "the block's hash: {policy}");
    assert!(again.contains_key(header::AGE) && same == body, "the kept page");
    assert_eq!(again[header::CONTENT_SECURITY_POLICY], policy);
}
