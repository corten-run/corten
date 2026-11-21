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
/// when its `Cache-Control` already keeps it private or out of every cache. Other headers a CDN
/// reads stay, and a page with no key keeps what the middleware wrote.
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
        ("/keyed-private", "private, max-age=60"),
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

/// A refused cross-site write gets the app's error page, which goes out before the cache rules
/// run. One that draws a submit key goes out as any page that draws one does: a `no-store` it
/// says as `private, no-store`, and none of the CDN caching headers it wrote. One that draws none
/// is sent `private, no-cache`, whatever it said, as before.
#[tokio::test]
async fn a_refusal_page_that_draws_a_submit_key_is_not_shared() {
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
        (false, "no-store", "private, no-cache"),
        (false, "public, max-age=60", "private, no-cache"),
    ] {
        let headers = refused(keyed, cache).await;
        assert_eq!(headers[header::CACHE_CONTROL], sent, "keyed {keyed}, {cache}");
        for name in CDN_OVERRIDES {
            if keyed {
                assert!(!headers.contains_key(name), "a keyed refusal sends no {name} ({cache})");
            } else {
                assert_eq!(headers[name], "max-age=60", "a refusal with no key keeps its {name} ({cache})");
            }
        }
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

/// What a write's handler finds: whether the app has a store of kept pages, and whether the
/// write is counted for its path.
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
    let dev = App::new(Routes::from(edit().merge(kept_routes(&runs)))).dev(true).router();
    assert_eq!(write(dev).await, "store=false counted=false", "under corten dev");
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
        let (first, wait) = (counted.count() == 1, wait.clone());
        async move {
            if first {
                wait.notified().await;
            }
            Public::new(Duration::from_secs(60), req.test_page_for("Slow", html! { <p>"slow"</p> }))
        }
    };
    let routes = Table::new().route("/", crate::route::get(page).0.post(|| async { StatusCode::NO_CONTENT }));
    let router = App::new(Routes::from(routes)).router();
    let reading = tokio::spawn({
        let router = router.clone();
        async move { fetch(&router, "GET", "/", &[]).await }
    });
    while runs.count() == 0 {
        tokio::task::yield_now().await;
    }
    let (status, _, _) = fetch(&router, "POST", "/", &[("sec-fetch-site", "same-origin")]).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    written.notify_one();
    let (status, headers, _) = reading.await.unwrap();
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE));
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert!(runs.count() == 2 && !headers.contains_key(header::AGE), "made again after the write: {headers:?}");
    let (_, headers, _) = fetch(&router, "GET", "/", &[]).await;
    assert!(runs.count() == 2 && headers.contains_key(header::AGE), "and that one is kept");
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

// ---- Requests that miss a kept page together ----

/// Holds a page's handlers where they are, as a slow source would, until it is opened or lets
/// one through: each handler that passes takes a permit.
#[derive(Clone)]
struct Gate(std::sync::Arc<tokio::sync::Semaphore>);

impl Gate {
    const OPEN: usize = 1 << 20;

    fn new() -> Self {
        Gate(std::sync::Arc::new(tokio::sync::Semaphore::new(Self::OPEN)))
    }

    fn hold(&self) {
        self.0.forget_permits(self.0.available_permits());
    }

    fn open(&self) {
        self.0.add_permits(Self::OPEN);
    }

    /// Lets the handler that has waited longest through.
    fn one(&self) {
        self.0.add_permits(1);
    }

    fn pass(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let gate = self.0.clone();
        async move {
            gate.acquire().await.expect("never closed").forget();
        }
    }
}

/// One request sent on a task of its own.
fn sent(
    router: &Router,
    method: &'static str,
    uri: &'static str,
    headers: &'static [(&'static str, &'static str)],
) -> tokio::task::JoinHandle<(StatusCode, HeaderMap, bytes::Bytes)> {
    let router = router.clone();
    tokio::spawn(async move { fetch(&router, method, uri, headers).await })
}

/// Sees the app's kept pages from the requests it meets, so a test can tell when a request has
/// begun to wait for another's page.
#[derive(Clone, Default)]
struct Watch(std::sync::Arc<std::sync::OnceLock<std::sync::Arc<crate::page::Shared>>>);

impl crate::Middleware for Watch {
    async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
        if let Some(shared) = req.extensions().get::<crate::Signal>().and_then(crate::Signal::shared) {
            let _ = self.0.set(shared.clone());
        }
        next.run(req).await
    }
}

impl Watch {
    /// The app's kept pages, once a request has met this middleware.
    fn answers(&self) -> &crate::kept::Answers {
        self.0.get().and_then(|shared| shared.kept.as_ref()).expect("a request met the app with pages kept")
    }

    /// The requests that have waited for another's page.
    fn joined(&self) -> usize {
        self.0.get().and_then(|shared| shared.kept.as_ref()).map_or(0, crate::kept::Answers::joined)
    }

    /// Waits until `count` requests in all have begun to wait for another's page.
    async fn admitted(&self, count: usize) {
        let reached = async {
            while self.joined() < count {
                tokio::task::yield_now().await;
            }
        };
        tokio::time::timeout(Duration::from_secs(10), reached)
            .await
            .unwrap_or_else(|_| panic!("{} requests waited, of {count}", self.joined()));
    }
}

/// Waits until a handler has run `count` times in all.
async fn ran(runs: &Runs, count: usize) {
    let reached = async {
        while runs.count() < count {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), reached).await.unwrap_or_else(|_| panic!("{} runs of {count}", runs.count()));
}

type Once = std::sync::Arc<std::sync::atomic::AtomicBool>;

/// A page for everyone for a minute at `/`, made behind `gate`, with a write to it. Its handler
/// fails (a `404`) when `fails` is set and panics when `panics` is, each once.
fn gated_routes(runs: &Runs, gate: &Gate, fails: &Once, panics: &Once) -> Table {
    use std::sync::atomic::Ordering::Relaxed;
    let (runs, gate, fails, panics) = (runs.clone(), gate.clone(), fails.clone(), panics.clone());
    let page = move |req: Req| {
        runs.ran();
        let (pass, fails, panics) = (gate.pass(), fails.swap(false, Relaxed), panics.swap(false, Relaxed));
        async move {
            pass.await;
            assert!(!panics, "a handler that panics");
            let page = req.test_page_for("Gated", html! { <p>"gated"</p> });
            Public::new(Duration::from_secs(60), if fails { Err(Error::not_found()) } else { page })
        }
    };
    Table::new().route("/", crate::route::get(page).0.post(|| async { StatusCode::NO_CONTENT }))
}

const SAME_ORIGIN: &[(&str, &str)] = &[("sec-fetch-site", "same-origin")];

/// Keeps the page at `/`, then writes to its path, so the copy kept no longer stands.
async fn kept_then_written(router: &Router) {
    assert!(!fetch(router, "GET", "/", &[]).await.1.contains_key(header::AGE));
    assert!(fetch(router, "GET", "/", &[]).await.1.contains_key(header::AGE));
    assert_eq!(fetch(router, "POST", "/", SAME_ORIGIN).await.0, StatusCode::NO_CONTENT);
}

/// Requests that miss a page kept before together run its handler once: the others wait for its
/// answer, and each is given the page it kept.
#[tokio::test]
async fn requests_that_miss_a_page_kept_before_together_run_its_handler_once() {
    let (runs, gate, fails, panics, watch) = (Runs::default(), Gate::new(), Once::default(), Once::default(), Watch::default());
    let router = App::new(Routes::from(gated_routes(&runs, &gate, &fails, &panics))).middleware(watch.clone()).router();
    kept_then_written(&router).await;
    assert_eq!(runs.count(), 1);
    gate.hold();
    let first = sent(&router, "GET", "/", &[]);
    ran(&runs, 2).await;
    let others: Vec<_> = (0..7).map(|_| sent(&router, "GET", "/", &[])).collect();
    watch.admitted(7).await;
    assert_eq!(runs.count(), 2, "one handler runs, and the others wait for it");
    gate.open();
    let (status, made, body) = first.await.unwrap();
    assert!(status == StatusCode::OK && !made.contains_key(header::AGE), "{made:?}");
    for other in others {
        let (status, headers, same) = other.await.unwrap();
        assert!(status == StatusCode::OK && headers.contains_key(header::AGE), "the page it kept: {headers:?}");
        assert_eq!(same, body);
    }
    assert_eq!(runs.count(), 2);
}

/// When the request that went first makes no page that is kept (it failed), the others run their
/// own handlers, all at once, and the next requests that miss do not wait.
#[tokio::test]
async fn when_the_first_request_s_page_is_not_kept_the_others_make_their_own() {
    use std::sync::atomic::Ordering::Relaxed;
    let (runs, gate, fails, panics, watch) = (Runs::default(), Gate::new(), Once::default(), Once::default(), Watch::default());
    let router = App::new(Routes::from(gated_routes(&runs, &gate, &fails, &panics))).middleware(watch.clone()).router();
    kept_then_written(&router).await;
    gate.hold();
    fails.store(true, Relaxed);
    let first = sent(&router, "GET", "/", &[]);
    ran(&runs, 2).await;
    let others: Vec<_> = (0..7).map(|_| sent(&router, "GET", "/", &[])).collect();
    watch.admitted(7).await;
    assert_eq!(runs.count(), 2, "the others wait");
    gate.one();
    assert_eq!(first.await.unwrap().0, StatusCode::NOT_FOUND);
    // Each of the others runs its own, at once: all are held at the gate together.
    ran(&runs, 9).await;
    gate.open();
    for other in others {
        let (status, headers, _) = other.await.unwrap();
        assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "its own page: {headers:?}");
    }
    assert!(fetch(&router, "GET", "/", &[]).await.1.contains_key(header::AGE), "and one of them is kept");

    // A page that failed again: what was kept before is no longer a reason to wait.
    assert_eq!(fetch(&router, "POST", "/", SAME_ORIGIN).await.0, StatusCode::NO_CONTENT);
    fails.store(true, Relaxed);
    assert_eq!(fetch(&router, "GET", "/", &[]).await.0, StatusCode::NOT_FOUND);
    gate.hold();
    let together: Vec<_> = (0..4).map(|_| sent(&router, "GET", "/", &[])).collect();
    ran(&runs, 14).await;
    gate.open();
    for request in together {
        assert_eq!(request.await.unwrap().0, StatusCode::OK);
    }
    assert_eq!(watch.joined(), 7, "none of those waited");
}

/// A request that went first and was dropped (its client left) or panicked leaves the others
/// to run their own handlers, which they do.
#[tokio::test]
async fn when_the_first_request_is_dropped_or_panics_the_others_make_their_own() {
    let (runs, gate, fails, panics, watch) = (Runs::default(), Gate::new(), Once::default(), Once::default(), Watch::default());
    let router = App::new(Routes::from(gated_routes(&runs, &gate, &fails, &panics))).middleware(watch.clone()).router();
    kept_then_written(&router).await;
    gate.hold();
    let first = sent(&router, "GET", "/", &[]);
    ran(&runs, 2).await;
    let others: Vec<_> = (0..3).map(|_| sent(&router, "GET", "/", &[])).collect();
    watch.admitted(3).await;
    assert_eq!(runs.count(), 2, "the others wait");
    first.abort();
    assert!(first.await.is_err_and(|ended| ended.is_cancelled()));
    ran(&runs, 5).await;
    gate.open();
    for other in others {
        assert_eq!(other.await.unwrap().0, StatusCode::OK);
    }
    assert_eq!(runs.count(), 5, "each of the others ran its own");

    assert_eq!(fetch(&router, "POST", "/", SAME_ORIGIN).await.0, StatusCode::NO_CONTENT);
    gate.hold();
    panics.store(true, std::sync::atomic::Ordering::Relaxed);
    let first = sent(&router, "GET", "/", &[]);
    ran(&runs, 6).await;
    let others: Vec<_> = (0..3).map(|_| sent(&router, "GET", "/", &[])).collect();
    watch.admitted(6).await;
    assert_eq!(runs.count(), 6, "the others wait");
    gate.one();
    assert_eq!(first.await.unwrap().0, StatusCode::INTERNAL_SERVER_ERROR, "the handler panicked");
    ran(&runs, 9).await;
    gate.open();
    for other in others {
        let (status, headers, _) = other.await.unwrap();
        assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "its own page: {headers:?}");
    }
    assert_eq!(runs.count(), 9);
}

/// A request waiting for another's page waits no longer than its own deadline.
#[tokio::test(start_paused = true)]
async fn a_request_waits_for_another_s_page_no_longer_than_its_deadline() {
    /// Holds a request that asks for it before it goes on, and says when one is held.
    #[derive(Clone, Default)]
    struct Late(Once);

    impl crate::Middleware for Late {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            if req.headers().contains_key("x-late") {
                self.0.store(true, std::sync::atomic::Ordering::Release);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            next.run(req).await
        }
    }

    let (runs, gate, fails, panics, watch) = (Runs::default(), Gate::new(), Once::default(), Once::default(), Watch::default());
    let late = Late::default();
    let router = App::new(Routes::from(gated_routes(&runs, &gate, &fails, &panics)))
        .middleware((late.clone(), watch.clone()))
        .deadline(Duration::from_millis(200))
        .router();
    kept_then_written(&router).await;
    gate.hold();
    // Its deadline starts first, and it reaches the page after the one that makes it.
    let waiting = sent(&router, "GET", "/", &[("x-late", "1")]);
    while !late.0.load(std::sync::atomic::Ordering::Acquire) {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_millis(50)).await;
    let first = sent(&router, "GET", "/", &[]);
    ran(&runs, 2).await;
    let (status, _, _) = waiting.await.unwrap();
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "its deadline passed while it waited");
    assert_eq!(watch.joined(), 1, "for the page another request was making");
    assert!(!first.is_finished(), "while the one it waited for was still at work");
    assert_eq!(runs.count(), 2, "and it ran no handler of its own");
    gate.open();
    let (status, _, _) = first.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(fetch(&router, "GET", "/", &[]).await.1.contains_key(header::AGE));
}

/// Only requests for one copy wait for each other: another query, or another language the page
/// is made in, is made at once.
#[tokio::test]
async fn requests_for_another_copy_do_not_wait() {
    crate::i18n::messages! { struct GatedMsg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
    const FR: &[(&str, &str)] = &[("accept-language", "fr")];
    const EN: &[(&str, &str)] = &[("accept-language", "en")];
    let (runs, gate) = (Runs::default(), Gate::new());
    let (counted, held) = (runs.clone(), gate.clone());
    let page = move |req: Req| {
        counted.ran();
        let pass = held.pass();
        async move {
            pass.await;
            let lang = req.lang();
            Public::new(Duration::from_secs(60), req.test_page_for("Lang", html! { <p>"in "{lang}</p> }))
        }
    };
    let routes = Table::new().route("/", crate::route::get(page).0.post(|| async { StatusCode::NO_CONTENT }));
    let watch = Watch::default();
    let router = App::new(Routes::from(routes)).messages::<GatedMsg>().middleware(watch.clone()).router();
    for (uri, asked) in [("/", FR), ("/", EN), ("/?page=2", FR)] {
        fetch(&router, "GET", uri, asked).await;
        assert!(fetch(&router, "GET", uri, asked).await.1.contains_key(header::AGE), "{uri} {asked:?}");
    }
    assert_eq!(fetch(&router, "POST", "/", SAME_ORIGIN).await.0, StatusCode::NO_CONTENT);
    assert_eq!(runs.count(), 3);
    gate.hold();
    let first = sent(&router, "GET", "/", FR);
    ran(&runs, 4).await;
    let waits = sent(&router, "GET", "/", FR);
    let others = [sent(&router, "GET", "/", EN), sent(&router, "GET", "/?page=2", FR)];
    ran(&runs, 6).await;
    // And a page not asked for before, which no other request is making.
    let new = sent(&router, "GET", "/?new", &[]);
    ran(&runs, 7).await;
    watch.admitted(1).await;
    assert_eq!(runs.count(), 7, "the second request for the French page waits");
    gate.open();
    let (_, _, body) = first.await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("<p>in fr</p>"));
    let (status, headers, same) = waits.await.unwrap();
    assert!(status == StatusCode::OK && headers.contains_key(header::AGE) && same == body, "{headers:?}");
    for other in others.into_iter().chain([new]) {
        let (status, headers, _) = other.await.unwrap();
        assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "{headers:?}");
    }
    assert_eq!((runs.count(), watch.joined()), (7, 1));
}

/// Holds the handlers of the requests it is told to, as a slow source would, until they are let
/// through; the others pass at once.
#[derive(Clone)]
struct Hold {
    next: std::sync::Arc<std::sync::Mutex<usize>>,
    gate: std::sync::Arc<tokio::sync::Semaphore>,
}

impl Default for Hold {
    fn default() -> Self {
        Hold { next: Default::default(), gate: std::sync::Arc::new(tokio::sync::Semaphore::new(0)) }
    }
}

impl Hold {
    /// Holds the handlers of the next `count` requests that reach theirs.
    fn next(&self, count: usize) {
        *self.next.lock().unwrap() = count;
    }

    /// Lets `count` held handlers through, the one held longest first.
    fn release(&self, count: usize) {
        self.gate.add_permits(count);
    }

    fn pass(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let held = {
            let mut next = self.next.lock().unwrap();
            let held = *next > 0;
            *next = next.saturating_sub(1);
            held
        };
        let gate = self.gate.clone();
        async move {
            if held {
                gate.acquire().await.expect("never closed").forget();
            }
        }
    }
}

/// What the pages of [`held_routes`] read: how often their handlers ran, the requests held, the
/// writes made, whether the page says it varies on `Accept-Language`, and whether the next
/// handler fails (a `404`).
#[derive(Clone, Default)]
struct Held {
    runs: Runs,
    hold: Hold,
    writes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    localized: Once,
    fails: Once,
}

/// A page for everyone at `/`, in the language asked for and showing the writes made to it, each
/// handler held as `held.hold` says; a write to it (`POST`) counts one. The page says it varies on
/// `Accept-Language` while `held.localized` is set. `/cookie` is the page with a cookie, so it is
/// never kept, and `/brief` the page kept for a second.
fn held_routes(held: &Held) -> Table {
    use std::sync::atomic::Ordering::Relaxed;
    let page = |held: &Held, cookie: bool, lifetime: u64| {
        let held = held.clone();
        move |req: Req| {
            held.runs.ran();
            let (writes, localized, pass) = (held.writes.load(Relaxed), held.localized.load(Relaxed), held.hold.pass());
            let fails = held.fails.swap(false, Relaxed);
            async move {
                pass.await;
                let lang = req.lang();
                let page = req.test_page_for("Held", html! { <p>"write "{writes}" in "{lang}</p> }).map(|mut page| {
                    if localized {
                        page.headers_mut().append(header::VARY, HeaderValue::from_static("accept-language"));
                    }
                    if cookie {
                        page.headers_mut().append(header::SET_COOKIE, SetCookie::new("a", "1").header());
                    }
                    page
                });
                let page = if fails { Err(Error::not_found()) } else { page };
                Public::new(Duration::from_secs(60), page).shared(Duration::from_secs(lifetime))
            }
        }
    };
    let write = |held: &Held| {
        let writes = held.writes.clone();
        move || {
            writes.fetch_add(1, Relaxed);
            async { StatusCode::NO_CONTENT }
        }
    };
    Table::new()
        .route("/", crate::route::get(page(held, false, 60)).0.post(write(held)))
        .route("/cookie", crate::route::get(page(held, true, 60)).0.post(write(held)))
        .route("/brief", crate::route::get(page(held, false, 1)).0)
}

/// `fetch`, which must be answered without waiting for a handler that is held.
async fn at_once(
    router: &Router,
    method: &str,
    uri: &str,
    headers: &[(&'static str, &str)],
) -> (StatusCode, HeaderMap, bytes::Bytes) {
    tokio::time::timeout(Duration::from_secs(10), fetch(router, method, uri, headers))
        .await
        .unwrap_or_else(|_| panic!("{method} {uri} {headers:?} waited for a handler that is held"))
}

fn text(body: &bytes::Bytes) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(body)
}

/// A request made after a write does not wait for a page whose handler read before it: it makes
/// the page again, and the request that waited for the earlier one is given that page, never the
/// one read before the write.
#[tokio::test]
async fn a_request_after_another_write_makes_the_page_again_without_waiting() {
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware(watch.clone()).router();
    kept_then_written(&router).await;
    held.hold.next(1);
    let first = sent(&router, "GET", "/", &[]);
    ran(&held.runs, 2).await;
    let waiting = sent(&router, "GET", "/", &[]);
    watch.admitted(1).await;
    // Another write while the first request's handler holds what it read before.
    assert_eq!(fetch(&router, "POST", "/", SAME_ORIGIN).await.0, StatusCode::NO_CONTENT);
    let (status, headers, after) = at_once(&router, "GET", "/", &[]).await;
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "made again: {headers:?}");
    assert!(text(&after).contains("<p>write 2 in en</p>"), "{}", text(&after));
    assert_eq!(watch.joined(), 1, "it did not wait for the page read before the write");
    let (_, headers, again) = fetch(&router, "GET", "/", &[]).await;
    assert!(headers.contains_key(header::AGE) && again == after, "and kept: {headers:?}");
    held.hold.release(1);
    let (status, headers, before) = first.await.unwrap();
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "{headers:?}");
    assert!(text(&before).contains("<p>write 1 in en</p>"), "the first request's own page: {}", text(&before));
    let (status, headers, given) = waiting.await.unwrap();
    assert!(status == StatusCode::OK && headers.contains_key(header::AGE), "{headers:?}");
    assert_eq!(given, after, "the page made after the write, never the one read before it");
    assert_eq!(fetch(&router, "GET", "/", &[]).await.2, after, "which is still the one kept");
    assert_eq!(held.runs.count(), 3);
}

/// A page kept in one language does not end the wait for the page being made in another: a
/// request for that one that comes after still waits for it.
#[tokio::test]
async fn keeping_a_page_in_one_language_leaves_the_other_s_being_made_to_wait_for() {
    crate::i18n::messages! { struct HeldMsg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
    const FR: &[(&str, &str)] = &[("accept-language", "fr")];
    const EN: &[(&str, &str)] = &[("accept-language", "en")];
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).messages::<HeldMsg>().middleware(watch.clone()).router();
    for asked in [FR, EN] {
        fetch(&router, "GET", "/", asked).await;
        assert!(fetch(&router, "GET", "/", asked).await.1.contains_key(header::AGE), "{asked:?}");
    }
    assert_eq!(fetch(&router, "POST", "/", SAME_ORIGIN).await.0, StatusCode::NO_CONTENT);
    held.hold.next(2);
    let english = sent(&router, "GET", "/", EN);
    ran(&held.runs, 3).await;
    let french = sent(&router, "GET", "/", FR);
    ran(&held.runs, 4).await;
    // The English page is made and kept first.
    held.hold.release(1);
    let (_, headers, body) = english.await.unwrap();
    assert!(!headers.contains_key(header::AGE) && text(&body).contains("<p>write 1 in en</p>"), "{headers:?}");
    assert!(fetch(&router, "GET", "/", EN).await.1.contains_key(header::AGE));
    let again = sent(&router, "GET", "/", FR);
    watch.admitted(1).await;
    assert_eq!(held.runs.count(), 4, "the second French request waits for the first");
    held.hold.release(1);
    let (_, headers, made) = french.await.unwrap();
    assert!(!headers.contains_key(header::AGE) && text(&made).contains("<p>write 1 in fr</p>"), "{headers:?}");
    let (status, headers, given) = again.await.unwrap();
    assert!(status == StatusCode::OK && headers.contains_key(header::AGE) && given == made, "{headers:?}");
    assert_eq!(held.runs.count(), 4);
}

/// Requests that ask in other languages do not wait for each other, even where the page kept
/// before was the same in every language: the page made again may not be.
#[tokio::test]
async fn requests_in_other_languages_do_not_wait_for_each_other() {
    const FR: &[(&str, &str)] = &[("accept-language", "fr")];
    const EN: &[(&str, &str)] = &[("accept-language", "en")];
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware(watch.clone()).router();
    fetch(&router, "GET", "/", EN).await;
    assert!(fetch(&router, "GET", "/", FR).await.1.contains_key(header::AGE), "one page for every language");
    // From the next write on, the page varies on the language asked for.
    held.localized.store(true, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(fetch(&router, "POST", "/", SAME_ORIGIN).await.0, StatusCode::NO_CONTENT);
    held.hold.next(1);
    let french = sent(&router, "GET", "/", FR);
    ran(&held.runs, 2).await;
    let (status, headers, _) = at_once(&router, "GET", "/", EN).await;
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "{headers:?}");
    held.hold.release(1);
    assert!(!french.await.unwrap().1.contains_key(header::AGE));
    for asked in [FR, EN] {
        let (_, headers, _) = fetch(&router, "GET", "/", asked).await;
        let localized = headers.get_all(header::VARY).iter().any(|vary| vary == "accept-language");
        assert!(headers.contains_key(header::AGE) && localized, "a copy for each language: {asked:?} {headers:?}");
    }
    assert_eq!((held.runs.count(), watch.joined()), (3, 0));
}

/// Requests that miss a page with no copy kept (the first after a start) together run its
/// handler once too.
#[tokio::test]
async fn requests_that_miss_a_page_with_no_copy_together_run_its_handler_once() {
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware(watch.clone()).router();
    held.hold.next(1);
    let first = sent(&router, "GET", "/", &[]);
    ran(&held.runs, 1).await;
    let others: Vec<_> = (0..7).map(|_| sent(&router, "GET", "/", &[])).collect();
    watch.admitted(7).await;
    assert_eq!(held.runs.count(), 1, "one handler runs, and the others wait for it");
    held.hold.release(1);
    let (status, headers, body) = first.await.unwrap();
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "{headers:?}");
    for other in others {
        let (status, headers, same) = other.await.unwrap();
        assert!(status == StatusCode::OK && headers.contains_key(header::AGE) && same == body, "{headers:?}");
    }
    assert_eq!(held.runs.count(), 1);
}

/// When a page is made and not kept, requests that meet do not wait for each other again until a
/// write to its path, after which the page may be kept.
#[tokio::test]
async fn a_page_that_was_not_kept_is_not_waited_for_until_a_write() {
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware(watch.clone()).router();
    // The first requests for it wait, since nothing says yet that it is not kept.
    held.hold.next(1);
    let first = sent(&router, "GET", "/cookie", &[]);
    ran(&held.runs, 1).await;
    let others: Vec<_> = (0..3).map(|_| sent(&router, "GET", "/cookie", &[])).collect();
    watch.admitted(3).await;
    assert_eq!(held.runs.count(), 1);
    held.hold.release(1);
    for request in [first].into_iter().chain(others) {
        let (status, headers, _) = request.await.unwrap();
        assert!(status == StatusCode::OK && !headers.contains_key(header::AGE) && headers.contains_key(header::SET_COOKIE));
    }
    assert_eq!(held.runs.count(), 4, "each made its own once the first's was not kept");
    // Then those that meet are each made at once.
    held.hold.next(1);
    let first = sent(&router, "GET", "/cookie", &[]);
    ran(&held.runs, 5).await;
    for _ in 0..3 {
        assert_eq!(at_once(&router, "GET", "/cookie", &[]).await.0, StatusCode::OK);
    }
    held.hold.release(1);
    assert_eq!(first.await.unwrap().0, StatusCode::OK);
    assert_eq!((held.runs.count(), watch.joined()), (8, 3));
    // A write to its path: the page may be kept now, so requests that meet wait again.
    assert_eq!(fetch(&router, "POST", "/cookie", SAME_ORIGIN).await.0, StatusCode::NO_CONTENT);
    held.hold.next(1);
    let first = sent(&router, "GET", "/cookie", &[]);
    ran(&held.runs, 9).await;
    let other = sent(&router, "GET", "/cookie", &[]);
    watch.admitted(4).await;
    held.hold.release(1);
    assert_eq!(first.await.unwrap().0, StatusCode::OK);
    assert_eq!(other.await.unwrap().0, StatusCode::OK);
    assert_eq!(held.runs.count(), 10);
}

/// The pages of [`held_routes`] with a store of 64 KiB, filled: new URLs are asked for twice each
/// until the second request is no longer given the page the first made.
async fn filled(held: &Held, watch: &Watch) -> Router {
    let router = App::new(Routes::from(held_routes(held))).kept_answers(64 << 10).middleware(watch.clone()).router();
    let kept = |uri: String| {
        let router = router.clone();
        async move { fetch(&router, "GET", &uri, &[]).await.1.contains_key(header::AGE) }
    };
    let mut room = 0;
    while kept(format!("/?fill={room}")).await || kept(format!("/?fill={room}")).await {
        room += 1;
        assert!(room < 100, "the store never filled");
    }
    assert!(room > 5, "{room} pages were kept the first time");
    router
}

/// In a full store a page is kept from the second request for its URL. The first, which the store
/// alone did not keep, does not have the page remembered as not kept: the requests that miss it
/// together next wait for one handler and are given its page.
#[tokio::test]
async fn a_page_a_full_store_did_not_keep_the_first_time_is_waited_for_the_next() {
    let (held, watch) = (Held::default(), Watch::default());
    let router = filled(&held, &watch).await;
    let (status, headers, _) = fetch(&router, "GET", "/?n=new", &[]).await;
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "{headers:?}");
    let runs = held.runs.count();
    held.hold.next(1);
    let first = sent(&router, "GET", "/?n=new", &[]);
    ran(&held.runs, runs + 1).await;
    let others: Vec<_> = (0..3).map(|_| sent(&router, "GET", "/?n=new", &[])).collect();
    watch.admitted(3).await;
    assert_eq!(held.runs.count(), runs + 1, "one handler runs, and the others wait for it");
    held.hold.release(1);
    let (status, headers, body) = first.await.unwrap();
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "{headers:?}");
    for other in others {
        let (status, headers, same) = other.await.unwrap();
        assert!(status == StatusCode::OK && headers.contains_key(header::AGE) && same == body, "{headers:?}");
    }
    assert_eq!(held.runs.count(), runs + 1);
}

/// In a full store, requests that miss a URL not asked for before together run its handler once:
/// those that come to wait while it is made are its second request, so the page is kept and given
/// to them.
#[tokio::test]
async fn requests_that_miss_a_new_url_in_a_full_store_together_run_its_handler_once() {
    let (held, watch) = (Held::default(), Watch::default());
    let router = filled(&held, &watch).await;
    let runs = held.runs.count();
    held.hold.next(1);
    let first = sent(&router, "GET", "/?n=together", &[]);
    ran(&held.runs, runs + 1).await;
    let others: Vec<_> = (0..3).map(|_| sent(&router, "GET", "/?n=together", &[])).collect();
    watch.admitted(3).await;
    assert_eq!(held.runs.count(), runs + 1, "one handler runs, and the others wait for it");
    held.hold.release(1);
    let (status, headers, body) = first.await.unwrap();
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "{headers:?}");
    for other in others {
        let (status, headers, same) = other.await.unwrap();
        assert!(status == StatusCode::OK && headers.contains_key(header::AGE) && same == body, "{headers:?}");
    }
    let (_, headers, again) = fetch(&router, "GET", "/?n=together", &[]).await;
    assert!(headers.contains_key(header::AGE) && again == body, "and kept: {headers:?}");
    assert_eq!(held.runs.count(), runs + 1);
}

/// In a full store, the requests for a new URL that come once its first request's page was
/// refused, none having waited for it, do not wait for that page: the first of them makes the
/// page, as the URL's second request, which is kept, and the others wait for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requests_that_come_once_a_full_store_refused_a_new_url_s_page_wait_for_the_next() {
    let (held, watch) = (Held::default(), Watch::default());
    let router = filled(&held, &watch).await;
    let (runs, joined) = (held.runs.count(), watch.joined());
    let mut stopped = watch.answers().stop_at(crate::kept::Stop::Refused);
    let first = sent(&router, "GET", "/?n=late", &[]);
    stopped.reached().await;
    held.hold.next(1);
    let others: Vec<_> = (0..2).map(|_| sent(&router, "GET", "/?n=late", &[])).collect();
    // Each has run its handler or waits for another's.
    let settled = async {
        while watch.joined() - joined + held.runs.count() - runs < 3 {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), settled).await.expect("the requests came to their handlers");
    stopped.go();
    let (status, headers, body) = first.await.unwrap();
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "{headers:?}");
    held.hold.release(1);
    let mut given = 0;
    for other in others {
        let (status, headers, same) = other.await.unwrap();
        assert!(status == StatusCode::OK && same == body, "{headers:?}");
        given += usize::from(headers.contains_key(header::AGE));
    }
    assert_eq!((held.runs.count() - runs, given), (2, 1), "one made the page again, and the other was given it");
    let (_, headers, again) = fetch(&router, "GET", "/?n=late", &[]).await;
    assert!(headers.contains_key(header::AGE) && again == body, "and kept: {headers:?}");
}

/// Requests that miss a page whose lifetime ended together run its handler once.
#[tokio::test]
async fn requests_that_miss_a_page_past_its_lifetime_together_run_its_handler_once() {
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware(watch.clone()).router();
    fetch(&router, "GET", "/brief", &[]).await;
    assert!(fetch(&router, "GET", "/brief", &[]).await.1.contains_key(header::AGE));
    tokio::time::sleep(Duration::from_millis(1100)).await;
    held.hold.next(1);
    let first = sent(&router, "GET", "/brief", &[]);
    ran(&held.runs, 2).await;
    let others: Vec<_> = (0..3).map(|_| sent(&router, "GET", "/brief", &[])).collect();
    watch.admitted(3).await;
    assert_eq!(held.runs.count(), 2);
    held.hold.release(1);
    let (_, headers, body) = first.await.unwrap();
    assert!(!headers.contains_key(header::AGE));
    for other in others {
        let (status, headers, same) = other.await.unwrap();
        assert!(status == StatusCode::OK && headers.contains_key(header::AGE) && same == body, "{headers:?}");
    }
    assert_eq!(held.runs.count(), 2);
}

/// A `HEAD`, the runtime's navigation and a request with a session's cookie are never given a
/// kept page, and do not wait for one being made.
#[tokio::test]
async fn head_a_navigation_and_a_signed_in_request_do_not_wait_for_a_page_being_made() {
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware(watch.clone()).router();
    kept_then_written(&router).await;
    held.hold.next(1);
    let first = sent(&router, "GET", "/", &[]);
    ran(&held.runs, 2).await;
    let asked: [(&str, &[(&str, &str)]); 3] = [("HEAD", &[]), ("GET", &[("corten", "nav")]), ("GET", &[("cookie", "sid=1")])];
    for (method, headers) in asked {
        let (status, answer, _) = at_once(&router, method, "/", headers).await;
        assert!(status == StatusCode::OK && !answer.contains_key(header::AGE), "{method} {headers:?}: {answer:?}");
    }
    assert_eq!((held.runs.count(), watch.joined()), (5, 0));
    held.hold.release(1);
    assert_eq!(first.await.unwrap().0, StatusCode::OK);
}

/// A request given the page another made has its own middleware's headers and the page's age.
#[tokio::test]
async fn a_request_that_waited_has_its_own_middleware_s_headers_and_the_page_s_age() {
    /// Answers with the `x-id` its request was sent with.
    struct Stamp;

    impl crate::Middleware for Stamp {
        async fn call(&self, req: Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let id = req.headers().get("x-id").cloned();
            let mut res = next.run(req).await;
            if let Some(id) = id {
                res.headers_mut().insert("x-id", id);
            }
            res
        }
    }

    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware((Stamp, watch.clone())).router();
    kept_then_written(&router).await;
    held.hold.next(1);
    let first = sent(&router, "GET", "/", &[("x-id", "first")]);
    ran(&held.runs, 2).await;
    let others = [("a", sent(&router, "GET", "/", &[("x-id", "a")])), ("b", sent(&router, "GET", "/", &[("x-id", "b")]))];
    watch.admitted(2).await;
    held.hold.release(1);
    let (_, headers, body) = first.await.unwrap();
    assert!(headers["x-id"] == "first" && !headers.contains_key(header::AGE), "{headers:?}");
    for (id, other) in others {
        let (status, headers, same) = other.await.unwrap();
        assert!(status == StatusCode::OK && headers["x-id"] == id && same == body, "{headers:?}");
        let age: u64 = headers[header::AGE].to_str().unwrap().parse().unwrap();
        assert!(age <= 1, "made as it waited: {age}");
    }
    assert_eq!(held.runs.count(), 2);
}

/// A request that missed the page while another was making it, and comes to look for the page
/// being made only once that one has kept it, is given the page kept: it does not make it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_that_missed_a_page_kept_meanwhile_is_given_it() {
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware(watch.clone()).router();
    kept_then_written(&router).await;
    held.hold.next(1);
    let first = sent(&router, "GET", "/", &[]);
    ran(&held.runs, 2).await;
    let mut stopped = watch.answers().stop_at(crate::kept::Stop::Missed);
    let late = sent(&router, "GET", "/", &[]);
    // It found no page kept, and has yet to look for the one being made.
    stopped.reached().await;
    held.hold.release(1);
    let (_, headers, made) = first.await.unwrap();
    assert!(!headers.contains_key(header::AGE), "{headers:?}");
    stopped.go();
    let (status, headers, given) = late.await.unwrap();
    assert!(status == StatusCode::OK && headers.contains_key(header::AGE) && given == made, "the page kept: {headers:?}");
    assert_eq!(held.runs.count(), 2, "and no handler of its own");
}

/// A request that finds a page being made for its copy is given a copy kept for it meanwhile (a
/// page the same in every language, made for another) at once, rather than wait.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_that_finds_a_page_being_made_is_given_a_copy_kept_for_it_meanwhile() {
    const FR: &[(&str, &str)] = &[("accept-language", "fr")];
    const EN: &[(&str, &str)] = &[("accept-language", "en")];
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware(watch.clone()).router();
    kept_then_written(&router).await;
    held.hold.next(1);
    let french = sent(&router, "GET", "/", FR);
    ran(&held.runs, 2).await;
    let mut stopped = watch.answers().stop_at(crate::kept::Stop::Missed);
    let late = sent(&router, "GET", "/", FR);
    stopped.reached().await;
    // Made and kept for every language while the French one is made.
    let (_, headers, english) = at_once(&router, "GET", "/", EN).await;
    assert!(!headers.contains_key(header::AGE), "{headers:?}");
    stopped.go();
    let (status, headers, given) = tokio::time::timeout(Duration::from_secs(10), late)
        .await
        .expect("given the copy kept, not waiting for the French page")
        .unwrap();
    assert!(status == StatusCode::OK && headers.contains_key(header::AGE) && given == english, "{headers:?}");
    assert_eq!((held.runs.count(), watch.joined()), (3, 0));
    held.hold.release(1);
    assert_eq!(french.await.unwrap().0, StatusCode::OK);
}

/// A page read before a write, and kept only after the page read after it was, does not take that
/// one's place: the requests after the write are still given the page read after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_read_before_a_write_does_not_take_the_place_of_one_read_after() {
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware(watch.clone()).router();
    kept_then_written(&router).await;
    let mut stopped = watch.answers().stop_at(crate::kept::Stop::Keep);
    let first = sent(&router, "GET", "/", &[]);
    // Its page is made, read before the write below, and not kept yet.
    stopped.reached().await;
    assert_eq!(fetch(&router, "POST", "/", SAME_ORIGIN).await.0, StatusCode::NO_CONTENT);
    let (_, headers, after) = fetch(&router, "GET", "/", &[]).await;
    assert!(!headers.contains_key(header::AGE) && text(&after).contains("<p>write 2 in en</p>"), "{headers:?}");
    stopped.go();
    let (status, _, before) = first.await.unwrap();
    assert!(status == StatusCode::OK && text(&before).contains("<p>write 1 in en</p>"), "{}", text(&before));
    let (_, headers, given) = fetch(&router, "GET", "/", &[]).await;
    assert!(headers.contains_key(header::AGE) && given == after, "the page read after the write: {headers:?}");
    assert_eq!(held.runs.count(), 3);
}

/// One request sent on a task of its own, to a URL made for it.
fn sent_to(router: &Router, uri: String) -> tokio::task::JoinHandle<(StatusCode, HeaderMap, bytes::Bytes)> {
    let router = router.clone();
    tokio::spawn(async move { fetch(&router, "GET", &uri, &[]).await })
}

/// The pages being made at once are bounded (past the bound, a request makes its page without
/// another waiting for it), and each one's end, remembered as not kept, looks at no more of the
/// table than its own share.
#[tokio::test]
async fn the_pages_being_made_are_bounded_and_each_ends_without_a_search() {
    const MANY: usize = 1_100;
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware(watch.clone()).router();
    assert_eq!(fetch(&router, "GET", "/", &[]).await.0, StatusCode::OK);
    held.hold.next(MANY);
    // Pages never kept (each sets a cookie), each at a URL of its own.
    let requests: Vec<_> = (0..MANY).map(|n| sent_to(&router, format!("/cookie?n={n}"))).collect();
    ran(&held.runs, MANY + 1).await;
    let making = watch.answers().making();
    held.hold.release(MANY);
    for request in requests {
        assert_eq!(request.await.unwrap().0, StatusCode::OK);
    }
    let scanned = watch.answers().scanned();
    assert!(making <= 1_024 && scanned <= 2 * MANY, "{making} being made at once, {scanned} places looked at");
}

/// A page kept after one that was not (its first handler failed) is not remembered as not kept:
/// once its lifetime ends, requests that miss it together run its handler once.
#[tokio::test]
async fn a_page_kept_after_one_that_was_not_is_waited_for_when_it_is_made_again() {
    let (held, watch) = (Held::default(), Watch::default());
    let router = App::new(Routes::from(held_routes(&held))).middleware(watch.clone()).router();
    held.fails.store(true, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(fetch(&router, "GET", "/brief", &[]).await.0, StatusCode::NOT_FOUND);
    let (status, headers, _) = fetch(&router, "GET", "/brief", &[]).await;
    assert!(status == StatusCode::OK && !headers.contains_key(header::AGE), "{headers:?}");
    assert!(fetch(&router, "GET", "/brief", &[]).await.1.contains_key(header::AGE), "kept");
    // Its lifetime of a second ends.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    held.hold.next(1);
    let first = sent(&router, "GET", "/brief", &[]);
    ran(&held.runs, 3).await;
    let others: Vec<_> = (0..3).map(|_| sent(&router, "GET", "/brief", &[])).collect();
    watch.admitted(3).await;
    assert_eq!(held.runs.count(), 3, "the others wait");
    held.hold.release(1);
    let (_, _, body) = first.await.unwrap();
    for other in others {
        let (status, headers, same) = other.await.unwrap();
        assert!(status == StatusCode::OK && headers.contains_key(header::AGE) && same == body, "{headers:?}");
    }
    assert_eq!(held.runs.count(), 3);
}

/// What settling a page's caching costs a request: `SETTLE_REQUESTS` (200) full-document `GET`s
/// in process, one at a time. `SETTLE_CASE` is the page: `keyed`, a `Public` page that draws a
/// submit key (sent `private, no-cache`); `public` (the default), the same page without the key,
/// which the app keeps; `private`, the page with the key and no `Public`; `plain`, the page with
/// neither (the default caching, the usual page). Counting it under
/// callgrind at two numbers of requests gives the instructions per request. Run in release:
/// `cargo test --release -p corten-run --all-features --lib --no-run`, then
/// `SETTLE_REQUESTS=1200 LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 valgrind --tool=callgrind <that binary> --ignored --exact tests::cache::what_settling_a_page_costs`
/// (Debian's `libjemalloc2`) and again at 200.
#[test]
#[ignore]
fn what_settling_a_page_costs() {
    let requests: usize = std::env::var("SETTLE_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let case = std::env::var("SETTLE_CASE").unwrap_or_else(|_| "public".to_string());
    let minute = Duration::from_secs(60);
    let keyed = case == "keyed" || case == "private";
    let form = move || html! { <form method="post">if keyed { {crate::SubmitKey::field(KeyedWrite::FIELDS.submit)} }</form> };
    let routes = if case == "private" || case == "plain" {
        Table::new().route("/", get(move |req: Req| async move { req.test_page("Form", form()) }))
    } else {
        Table::new().route("/", get(move |req: Req| async move { Public::new(minute, req.test_page_for("Form", form())) }))
    };
    let router = App::new(Routes::from(routes)).router();
    let expected = if case == "public" { "public, max-age=60" } else { "private, no-cache" };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        for _ in 0..requests {
            let (status, headers, body) = call_with(router.clone(), "GET", "/", None, None).await;
            assert!(status == StatusCode::OK && body.contains("<form method=\"post\">"), "{status}: {body}");
            assert_eq!(headers[header::CACHE_CONTROL], expected);
        }
    });
}
