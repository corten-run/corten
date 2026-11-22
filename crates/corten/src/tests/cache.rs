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

/// A kept page's tag and its bytes in every coding but brotli are those the handler's own answer
/// has in an app that keeps none: only who makes them, and how often, differs. (Its brotli is
/// those bytes for two answers, then made again: below.)
#[tokio::test]
async fn a_kept_page_has_the_tag_and_the_coded_bytes_of_the_handler_s_answer() {
    let (runs, each) = (Runs::default(), Runs::default());
    let kept = App::new(Routes::from(kept_routes(&runs))).router();
    let none = App::new(Routes::from(kept_routes(&each))).kept_answers(0).router();
    for coding in ["zstd", "gzip", "identity", "zstd", "gzip"] {
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
    assert_eq!((runs.count(), each.count()), (1, 10), "one render for all of them");
}

/// A kept page's brotli is the handler's answer's for its first two answers to a client that
/// takes brotli, and is made once more at `Level::Kept` after the second, by no request: from
/// then on a client that ranks brotli as high as any coding (a browser, which takes zstd too)
/// gets those fewer bytes with the same tag, and one that prefers zstd, or takes only gzip, gets
/// what was made for its coding.
#[cfg(feature = "compress")]
#[tokio::test]
async fn a_kept_page_is_given_in_brotli_made_after_its_second_answer() {
    use crate::compress::{encode, Coding, Level};
    let (runs, each) = (Runs::default(), Runs::default());
    let kept = App::new(Routes::from(kept_routes(&runs))).router();
    let none = App::new(Routes::from(kept_routes(&each))).kept_answers(0).router();
    let br = [("accept-encoding", "br")];
    let (_, made, fast) = fetch(&none, "GET", "/", &br).await;
    let (_, mut first, body) = fetch(&kept, "GET", "/", &br).await;
    let (_, _, again) = fetch(&kept, "GET", "/", &br).await;
    assert!(body == fast && again.as_ptr() == body.as_ptr(), "the handler's bytes, made once, for two answers");
    first.remove(header::AGE);
    assert_eq!(first, made);
    let (_, _, identity) = fetch(&kept, "GET", "/", &[("accept-encoding", "identity")]).await;
    let better = encode(Coding::Brotli, &identity, Level::Kept);
    assert!(better.len() < fast.len(), "{} of {}", better.len(), fast.len());
    // Made after those answers: a browser gets zstd until it is there.
    let browser = [("accept-encoding", "gzip, deflate, br, zstd")];
    let started = std::time::Instant::now();
    let (headers, given) = loop {
        let (_, headers, given) = fetch(&kept, "GET", "/", &browser).await;
        if headers[header::CONTENT_ENCODING] == "br" {
            break (headers, given);
        }
        assert_eq!(headers[header::CONTENT_ENCODING], "zstd");
        assert!(started.elapsed() < Duration::from_secs(10), "brotli was not made");
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    assert_eq!(given, better);
    assert!(headers.contains_key(header::AGE), "{headers:?}");
    assert!(headers.get_all(header::VARY).iter().any(|v| v == "accept-encoding"), "{headers:?}");
    assert_eq!(headers[header::ETAG], made[header::ETAG], "the tag is the page's, whatever its coding");
    let (_, _, same) = fetch(&kept, "GET", "/", &br).await;
    assert_eq!(same.as_ptr(), given.as_ptr(), "made once, for every client that takes it");
    let (_, headers, _) = fetch(&kept, "GET", "/", &[("accept-encoding", "zstd, br;q=0.5")]).await;
    assert_eq!(headers[header::CONTENT_ENCODING], "zstd");
    let (_, headers, gzip) = fetch(&kept, "GET", "/", &[("accept-encoding", "gzip")]).await;
    assert_eq!(headers[header::CONTENT_ENCODING], "gzip");
    assert_eq!(gzip, fetch(&none, "GET", "/", &[("accept-encoding", "gzip")]).await.2);
    assert_eq!(runs.count(), 1, "one render for all of them");
}

/// Only answers a store kept count toward a page's brotli at `Level::Kept`: in a full store the
/// first request for a new URL is answered by the handler and not kept, and queues nothing, so
/// the page kept from the second request is given zstd on its first answer after that too, and
/// its brotli is queued on its second. The compression thread is waited for after each request.
#[cfg(feature = "compress")]
#[tokio::test]
async fn an_answer_a_full_store_did_not_keep_does_not_count_toward_its_brotli() {
    let runs = Runs::default();
    let router = App::new(Routes::from(kept_routes(&runs))).kept_answers(64 << 10).router();
    // Filled uncompressed, so no page of the fill queues a brotli of its own.
    let kept = |uri: String| {
        let router = router.clone();
        async move { fetch(&router, "GET", &uri, &[]).await.1.contains_key(header::AGE) }
    };
    let mut room = 0;
    while kept(format!("/?n={room}")).await || kept(format!("/?n={room}")).await {
        room += 1;
        assert!(room < 100, "the store never filled");
    }
    // Everything queued on the compression thread before is done: this waits in the kept pages'
    // queue, after the jobs there and any held value's.
    let drained = || {
        let (done, heard) = std::sync::mpsc::channel();
        let job = Box::new(move || {
            done.send(()).ok();
        });
        assert!(crate::compress::later(crate::compress::Turn::Kept, job), "the thread took the job");
        heard.recv_timeout(Duration::from_secs(10)).expect("the thread is done");
    };
    let browser = [("accept-encoding", "gzip, deflate, br, zstd")];
    let mut given = Vec::new();
    for _ in 0..4 {
        let (status, headers, _) = fetch(&router, "GET", "/?new", &browser).await;
        assert_eq!(status, StatusCode::OK);
        given.push((headers.contains_key(header::AGE), headers[header::CONTENT_ENCODING].to_str().unwrap().to_owned()));
        drained();
    }
    let given: Vec<(bool, &str)> = given.iter().map(|(age, coding)| (*age, coding.as_str())).collect();
    assert_eq!(
        given,
        [(false, "zstd"), (false, "zstd"), (true, "zstd"), (true, "br")],
        "not kept, then made and kept, then given twice: brotli after the kept page's second answer"
    );
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
    let dev = App::new(Routes::from(edit().merge(kept_routes(&runs)))).dev(true).router();
    assert_eq!(write(dev).await, "store=false counted=false", "under corten dev");

    // A `Public` whole body is kept where the build compresses: an app whose only `Public` route
    // answers one has a store there, and in a build that keeps no body its route asks nothing.
    let words = || async { Public::new(Duration::from_secs(60), "words") };
    let body = App::new(Routes::from(edit().route("/words", crate::route::get(words).0))).router();
    let kept = cfg!(feature = "compress");
    assert_eq!(write(body).await, format!("store={kept} counted={kept}"), "a Public body alone");
    // A file is a whole body too, kept or not: which is known only as each is made.
    let file = || async { Public::new(Duration::from_secs(60), crate::Media::new("image/png", &[0x89u8; 4][..])) };
    let filed = App::new(Routes::from(edit().route("/mark.png", crate::route::get(file).0))).router();
    assert_eq!(write(filed).await, format!("store={kept} counted={kept}"), "a Public file alone");
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
        ("/text", "a whole body too small for the app to compress"),
        ("/file", "a file of a type the app does not compress"),
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
    // A whole body, where the app compresses it: in a build that does not, it is its handler's.
    assert_eq!(kept(router.clone(), "/long").await, cfg!(feature = "compress"));
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
    // Bytes the app holds keep their own compressed forms where the build compresses, which is
    // where a body is kept at all.
    #[cfg(feature = "json")]
    assert!(!whole::<Json<crate::json::Raw>>());
}

/// A `Public` JSON answer and a `Public` text answer are made once for their lifetime, as a
/// page is: the next request that shows nothing about who asks gets the same bytes with their
/// age, with the tag and the coded bytes made once, and a write to the path drops them. A
/// request that asks for JSON first is kept too, apart: its handler can read which client asked.
/// Each body here is one the app compresses (1,024 bytes or more), which is what is kept.
#[cfg(all(feature = "json", feature = "compress"))]
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
    assert_eq!(third.as_ptr(), same.as_ptr(), "the coded bytes made once");
    assert_eq!(first[header::CONTENT_ENCODING], "gzip");
    let tag = first[header::ETAG].to_str().unwrap();
    let (status, _, none) = fetch(&router, "GET", "/text", &[("accept-encoding", "gzip"), ("if-none-match", tag)]).await;
    assert!(status == StatusCode::NOT_MODIFIED && none.is_empty() && texts.count() == 1);
}

/// A kept JSON, text or file body's compressed forms are a kept page's: given brotli made at
/// `Level::Kept` after its second answer to a client that takes brotli, by no request, so a
/// browser gets it once it is made with the same tag, and one that takes only gzip gets what was
/// made for gzip. Its brotli is queued on that second answer exactly: not on the handler's, which
/// is the first, nor on an answer in no coding between them, and once. A data client's copy
/// (`Accept: application/json` first) is kept apart, so it counts its own answers toward its own
/// brotli. The brotli is sent with its handler's type, file name and `Vary`; a picture of a type
/// the app does not compress is not kept, so it queues none however often a browser asks.
#[cfg(all(feature = "json", feature = "compress"))]
#[tokio::test]
async fn a_kept_body_is_given_in_brotli_made_after_its_second_answer() {
    use crate::compress::{encode, Coding, Level, Turn};
    let minute = Duration::from_secs(60);
    let runs = Runs::default();
    let (json_ran, text_ran) = (runs.clone(), runs.clone());
    let items = move || {
        json_ran.ran();
        let rows: Vec<String> = (0..40).map(|n| format!("record {n} of the catalog, kept for a minute")).collect();
        async move { Public::new(minute, Ok::<_, JsonError>(Json(rows))) }
    };
    let text = move || {
        text_ran.ran();
        async move { Public::new(minute, (0..60).map(|n| format!("line {n} of the kept text\n")).collect::<String>()) }
    };
    let file_ran = runs.clone();
    let file = move || {
        file_ran.ran();
        let rows: String = (0..120u32).map(|n| format!("card {n},{}\n", n * 7919 % 1000)).collect();
        async move { Public::new(minute, crate::Media::new("text/csv", rows).attachment("cards.csv")) }
    };
    let picture_ran = runs.clone();
    let picture = move || {
        picture_ran.ran();
        async move { Public::new(minute, crate::Media::new("image/png", vec![0x89; 4096])) }
    };
    let routes = Table::new()
        .route("/items", crate::route::get(items).0)
        .route("/text", crate::route::get(text).0)
        .route("/cards.csv", crate::route::get(file).0)
        .route("/picture.png", crate::route::get(picture).0);
    let router = App::new(Routes::from(routes)).router();
    let browser = [("accept-encoding", "gzip, deflate, br, zstd")];
    let data = [("accept-encoding", "gzip, deflate, br, zstd"), ("accept", "application/json")];
    // The kept answers' brotli jobs asked of the compression thread's queue on this thread, each
    // given to it.
    let queued = std::rc::Rc::new(std::cell::Cell::new(0));
    let count = queued.clone();
    crate::compress::QUEUEING.set(Some(Box::new(move |turn| {
        if turn == Turn::Kept {
            count.set(count.get() + 1);
        }
        true
    })));
    let asked = [("/items", &browser[..]), ("/text", &browser[..]), ("/cards.csv", &browser[..]), ("/items", &data[..])];
    for (path, asked) in asked {
        let ran = runs.count();
        let before = queued.get();
        let (_, first, fast) = fetch(&router, "GET", path, asked).await;
        assert_eq!(first[header::CONTENT_ENCODING], "zstd", "{path} {asked:?}: the handler's answer");
        assert_eq!(queued.get(), before, "{path} {asked:?}: not queued on the first answer");
        let identity: Vec<_> = asked
            .iter()
            .copied()
            .filter(|(name, _)| *name != "accept-encoding")
            .chain([("accept-encoding", "identity")])
            .collect();
        let (_, _, plain) = fetch(&router, "GET", path, &identity).await;
        assert_eq!(queued.get(), before, "{path} {asked:?}: an answer in no coding does not count");
        let better = encode(Coding::Brotli, &plain, Level::Kept);
        assert!(better.len() < fast.len(), "{path}: {} of {}", better.len(), fast.len());
        let (_, second, again) = fetch(&router, "GET", path, asked).await;
        assert!(second.contains_key(header::AGE), "{path} {asked:?}: kept {second:?}");
        assert_eq!(second[header::CONTENT_ENCODING], "zstd", "{path} {asked:?}: made by no request");
        assert_eq!(again.as_ptr(), fast.as_ptr(), "{path} {asked:?}: the handler's answer's bytes");
        assert_eq!(queued.get(), before + 1, "{path} {asked:?}: queued on the second answer");
        let started = std::time::Instant::now();
        let (headers, given) = loop {
            let (_, headers, given) = fetch(&router, "GET", path, asked).await;
            assert!(headers.contains_key(header::AGE), "{path} {asked:?}: kept {headers:?}");
            if headers[header::CONTENT_ENCODING] == "br" {
                break (headers, given);
            }
            assert_eq!(headers[header::CONTENT_ENCODING], "zstd", "{path} {asked:?}");
            assert!(started.elapsed() < Duration::from_secs(10), "{path} {asked:?}: brotli was not made");
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert_eq!(given, better, "{path} {asked:?}");
        // The brotli copy is sent with the head its handler gave: its type, its name as a file,
        // and the `Vary` it had, with `accept-encoding` added once and nothing replaced.
        for name in [header::CONTENT_TYPE, header::CONTENT_DISPOSITION] {
            assert_eq!(headers.get(&name), first.get(&name), "{path} {asked:?}: {name}");
        }
        let vary = |headers: &HeaderMap| {
            let mut names: Vec<String> = headers
                .get_all(header::VARY)
                .iter()
                .flat_map(|line| line.to_str().unwrap().split(','))
                .map(|name| name.trim().to_ascii_lowercase())
                .collect();
            names.sort();
            names
        };
        assert_eq!(vary(&headers), vary(&first), "{path} {asked:?}: {headers:?}");
        assert_eq!(vary(&headers), ["accept-encoding", "cookie"], "{path} {asked:?}: {headers:?}");
        if path == "/cards.csv" {
            assert_eq!(headers[header::CONTENT_TYPE], "text/csv");
            assert_eq!(headers[header::CONTENT_DISPOSITION], "attachment; filename=\"cards.csv\"");
        }
        assert_eq!(headers.get(header::ETAG), first.get(header::ETAG), "{path}: the tag is the body's, whatever its coding");
        let (_, _, same) = fetch(&router, "GET", path, asked).await;
        assert_eq!(same.as_ptr(), given.as_ptr(), "{path} {asked:?}: made once");
        let gzip: Vec<_> =
            asked.iter().copied().filter(|(name, _)| *name != "accept-encoding").chain([("accept-encoding", "gzip")]).collect();
        let (_, headers, _) = fetch(&router, "GET", path, &gzip).await;
        assert_eq!(headers[header::CONTENT_ENCODING], "gzip", "{path} {asked:?}");
        assert_eq!(queued.get(), before + 1, "{path} {asked:?}: queued once");
        assert_eq!(runs.count() - ran, 1, "{path} {asked:?}: one run for all of them");
    }
    // A picture of a type the app does not compress is not kept, whatever its size, so no answer
    // to a browser queues a brotli for it.
    let (ran, before) = (runs.count(), queued.get());
    for n in 0..4 {
        let (status, headers, body) = fetch(&router, "GET", "/picture.png", &browser).await;
        assert_eq!((status, body.len()), (StatusCode::OK, 4096), "answer {n}");
        assert!(!headers.contains_key(header::AGE) && !headers.contains_key(header::CONTENT_ENCODING), "answer {n}: {headers:?}");
        assert_eq!(headers[header::CONTENT_TYPE], "image/png", "answer {n}");
    }
    assert_eq!((queued.get(), runs.count() - ran), (before, 4), "no brotli queued, its handler's every time");
    crate::compress::QUEUEING.take();
}

/// A kept body past `BROTLI_MAX` (32,768 bytes, as it is written here and not read from the
/// constant) is never given a brotli at `Level::Kept`, since a held value queued while it is made
/// would wait for all of it: no answer queues one, and a browser gets the form made for its coding
/// every time. The bound is the body's own length, not its compressed form's. One at the bound is
/// queued on its second answer as before, and not on its first.
#[cfg(feature = "compress")]
#[tokio::test]
async fn a_kept_body_past_the_brotli_bound_keeps_the_form_made_for_its_coding() {
    use crate::compress::Turn;
    use crate::kept::BROTLI_MAX;
    assert_eq!(BROTLI_MAX, 32 * 1024, "the bound Choice 70 and the guide give");
    let minute = Duration::from_secs(60);
    let runs = Runs::default();
    let text = |length: usize, runs: Runs| {
        move || {
            runs.ran();
            let mut text: String = (0..length / 10).map(|n| format!("line {n} of the kept text\n")).collect();
            text.truncate(length);
            assert_eq!(text.len(), length);
            async move { Public::new(minute, text) }
        }
    };
    let routes = Table::new()
        .route("/at", crate::route::get(text(32_768, runs.clone())).0)
        .route("/past", crate::route::get(text(32_769, runs.clone())).0);
    let router = App::new(Routes::from(routes)).router();
    let browser = [("accept-encoding", "gzip, deflate, br, zstd")];
    let queued = std::rc::Rc::new(std::cell::Cell::new(0));
    let count = queued.clone();
    crate::compress::QUEUEING.set(Some(Box::new(move |turn| {
        if turn == Turn::Kept {
            count.set(count.get() + 1);
        }
        true
    })));
    let (_, first, made) = fetch(&router, "GET", "/past", &browser).await;
    assert!(!first.contains_key(header::AGE) && first[header::CONTENT_ENCODING] == "zstd", "the handler's answer: {first:?}");
    assert!(made.len() < 32_768, "its zstd ({} bytes) is within the bound, its body is not", made.len());
    for n in 1..6 {
        let (_, headers, again) = fetch(&router, "GET", "/past", &browser).await;
        assert!(headers.contains_key(header::AGE), "answer {n}: kept {headers:?}");
        assert_eq!(headers[header::CONTENT_ENCODING], "zstd", "answer {n}");
        assert_eq!(again.as_ptr(), made.as_ptr(), "answer {n}: the form made for zstd");
    }
    assert_eq!((queued.get(), runs.count()), (0, 1), "no brotli queued past the bound, one run");
    for (n, queued_by_then) in [(0, 0), (1, 1)] {
        assert_eq!(fetch(&router, "GET", "/at", &browser).await.1[header::CONTENT_ENCODING], "zstd", "answer {n}");
        assert_eq!(queued.get(), queued_by_then, "answer {n}: at the bound, queued on its second answer and not its first");
    }
    assert_eq!(runs.count(), 2, "one run a URL");
    crate::compress::QUEUEING.take();
}

/// A whole body is kept where the app compresses it: from 1,024 bytes, in a build that
/// compresses. One byte under, and in a build that does not, the route is its handler's for
/// every request. A kept body is given to a request that accepts no coding too.
#[tokio::test]
async fn a_whole_body_is_kept_from_the_size_the_app_compresses() {
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
    for (path, kept) in [("/under", false), ("/at", cfg!(feature = "compress"))] {
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

/// A file is a whole body too. A sitemap, and a `Media` of a type the app compresses, are kept
/// from the size it compresses, and the kept one is sent with what its handler said of it: its
/// type, its file name, how long caches keep it. A picture of a type the app does not compress,
/// a `robots.txt` under that size, a file sent as a stream, which has no body to hold, and a
/// file at a URL that names its content (`Public::immutable`), which has no lifetime to keep it
/// for, are their handlers' for every request, and so is every file in a build that does not
/// compress.
#[tokio::test]
async fn a_file_is_kept_where_the_app_compresses_it() {
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
    // A `robots.txt` large enough to compress.
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
        ("/picture.png", false),
        ("/export.csv", false),
    ] {
        let kept = kept && cfg!(feature = "compress");
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
    #[cfg(feature = "compress")]
    assert_eq!((cards.contains_key(header::AGE), &cards[header::CONTENT_ENCODING]), (true, &HeaderValue::from_static("gzip")));
    // A file's key is its URL with its query, and a request with a cookie is its handler's.
    let before = runs.count();
    let (_, other, _) = fetch(&router, "GET", "/cards.csv?page=2", &[]).await;
    let (_, again, _) = fetch(&router, "GET", "/cards.csv?page=2", &[]).await;
    let (_, known, _) = fetch(&router, "GET", "/cards.csv", &[("cookie", "sid=1")]).await;
    assert_eq!((other.contains_key(header::AGE), known.contains_key(header::AGE)), (false, false));
    assert_eq!(again.contains_key(header::AGE), cfg!(feature = "compress"));
    assert_eq!(runs.count() - before, if cfg!(feature = "compress") { 2 } else { 3 });
    // A handler that failed is asked again, and what it then makes is kept.
    let before = runs.count();
    let (failed, first, _) = fetch(&router, "GET", "/flaky.csv", &[]).await;
    let (made, second, _) = fetch(&router, "GET", "/flaky.csv", &[]).await;
    let (_, third, _) = fetch(&router, "GET", "/flaky.csv", &[]).await;
    assert_eq!((failed, made), (StatusCode::NOT_FOUND, StatusCode::OK));
    assert_eq!((first.contains_key(header::AGE), second.contains_key(header::AGE)), (false, false));
    assert_eq!(third.contains_key(header::AGE), cfg!(feature = "compress"));
    assert_eq!(runs.count() - before, if cfg!(feature = "compress") { 2 } else { 3 });
    let (_, mark, _) = fetch(&router, "GET", "/mark.svg", &[]).await;
    assert_eq!(mark[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
    assert_eq!(mark[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    // A kept file is a kept answer in every other way: its tag answers `304`, a `HEAD` is its
    // handler's, and a write to its path drops it.
    #[cfg(feature = "compress")]
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
#[cfg(feature = "compress")]
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
#[cfg(feature = "compress")]
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
#[cfg(all(feature = "json", feature = "compress"))]
#[tokio::test]
async fn a_kept_api_answer_is_sent_with_each_request_s_own_cors() {
    let runs = Runs::default();
    let ran = runs.clone();
    let rates = move || {
        ran.ran();
        // Of a size the app compresses, which is what it keeps.
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
#[cfg(all(feature = "json", feature = "compress"))]
#[tokio::test]
async fn a_kept_body_is_for_the_language_its_handler_read() {
    crate::i18n::messages! { struct BodyMsg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
    crate::i18n::messages! { struct OtherMsg { "fr" => "src/i18n/fr.json", "en" => "src/i18n/en.json" } }
    /// Each body is its word this many times: of a size the app compresses, which is what it keeps.
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
/// where the handler waited after rendering it. In a build that compresses, where one is kept.
#[cfg(all(feature = "json", feature = "compress"))]
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
