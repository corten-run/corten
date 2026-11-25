use super::*;

/// An area or an API with a deadline of its own: its routes get it, and every other page keeps
/// the app's. In nested areas the innermost that sets one decides; one that sets none takes its
/// parent's.
#[tokio::test]
async fn an_area_or_an_api_sets_its_own_deadline() {
    let slow = || {
        crate::Methods::reads(get(|| async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            "done"
        }))
    };
    let router = App::new(Routes::from(Table::new().route("/slow", slow().0)))
        .error_page(test_error_page, ())
        .deadline(Duration::from_millis(50))
        .area::<Admin>(|admin| admin.route::<AdminSlow>(slow()).deadline(Duration::from_secs(10)))
        .area::<AdminQuick>(|quick| quick.route::<AdminQuickSlow>(slow()).deadline(Duration::from_millis(20)))
        .area::<AdminOther>(|other| other.route::<AdminOtherSlow>(slow()))
        .api::<ApiRoot>(|api| api.route::<ApiSlow>(slow()).deadline(None))
        .router();
    let status = |uri| {
        let router = router.clone();
        async move { call_with(router, "GET", uri, None, Some("text/html")).await.0 }
    };
    assert_eq!(status("/slow").await, StatusCode::SERVICE_UNAVAILABLE, "a page keeps the app's deadline");
    assert_eq!(status("/admin/slow").await, StatusCode::OK, "the area's own");
    assert_eq!(status("/admin/other/slow").await, StatusCode::OK, "a nested area without one takes its parent's");
    assert_eq!(status("/admin/quick/slow").await, StatusCode::SERVICE_UNAVAILABLE, "the innermost decides");
    assert_eq!(status("/api/slow").await, StatusCode::OK, "None removes it for the API");
}

paths! {
    AdminApi = "/admin/api",
    AdminApiTake = "/admin/api/take",
    AdminSmall = "/admin/small",
    AdminSmallTake = "/admin/small/take",
    ApiInner = "/api/inner",
    ApiInnerTake = "/api/inner/take",
}

/// An area or an API with a body limit of its own: its routes' readers take it, and every other
/// route keeps the app's. In nested areas the innermost that sets one decides; an area or an API
/// that sets none takes the one around it.
#[tokio::test]
async fn an_area_or_an_api_sets_its_own_body_limit() {
    let take = || crate::Methods::writes(crate::router::post(|body: crate::http::Bytes| async move { body.len().to_string() }));
    let router = App::new(Routes::from(Table::new().route("/take", take().0)))
        .body_limit(1 << 10)
        .area::<Admin>(|admin| admin.route::<AdminSlow>(take()).body_limit(4 << 10))
        .area::<AdminQuick>(|quick| quick.route::<AdminQuickSlow>(take()).body_limit(512))
        .area::<AdminOther>(|other| other.route::<AdminOtherSlow>(take()))
        .api::<AdminApi>(|api| api.route::<AdminApiTake>(take()))
        .api::<AdminSmall>(|api| api.route::<AdminSmallTake>(take()).body_limit(512))
        .api::<ApiRoot>(|api| api.route::<ApiSlow>(take()).body_limit(8 << 10))
        .api::<ApiInner>(|api| api.route::<ApiInnerTake>(take()))
        .router();
    let post = |path: &'static str, len: usize| {
        let router = router.clone();
        async move {
            let req = Request::builder()
                .method("POST")
                .uri(path)
                .header("sec-fetch-site", "same-origin")
                .body(Body::from(vec![b'a'; len]))
                .unwrap();
            router.oneshot(req).await.unwrap().status()
        }
    };
    assert_eq!(post("/take", 1 << 10).await, StatusCode::OK, "the app's limit is the readers'");
    assert_eq!(post("/take", 2 << 10).await, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(post("/admin/slow", 3 << 10).await, StatusCode::OK, "the area's own");
    assert_eq!(post("/admin/slow", 5 << 10).await, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(post("/admin/other/slow", 3 << 10).await, StatusCode::OK, "a nested area without one takes its parent's");
    assert_eq!(post("/admin/quick/slow", 1 << 10).await, StatusCode::PAYLOAD_TOO_LARGE, "the innermost decides");
    assert_eq!(post("/admin/api/take", 3 << 10).await, StatusCode::OK, "an API in an area takes the area's");
    assert_eq!(post("/api/slow", 6 << 10).await, StatusCode::OK, "the API's own");
    assert_eq!(post("/api/slow", 9 << 10).await, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(post("/admin/small/take", 1 << 10).await, StatusCode::PAYLOAD_TOO_LARGE, "an API's own over its area's");
    assert_eq!(post("/api/inner/take", 6 << 10).await, StatusCode::OK, "an inner API takes the outer API's");
    assert_eq!(post("/api/inner/take", 9 << 10).await, StatusCode::PAYLOAD_TOO_LARGE);
    let default = App::new(Routes::from(Table::new().route("/take", take().0))).router();
    let req = |len: usize| {
        Request::builder()
            .method("POST")
            .uri("/take")
            .header("sec-fetch-site", "same-origin")
            .body(Body::from(vec![b'a'; len]))
            .unwrap()
    };
    assert_eq!(default.clone().oneshot(req(2 << 20)).await.unwrap().status(), StatusCode::OK, "2 MiB unless set");
    assert_eq!(default.oneshot(req((2 << 20) + 1)).await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
    let none = App::new(Routes::from(Table::new().route("/take", take().0))).body_limit(0).router();
    assert_eq!(none.clone().oneshot(req(0)).await.unwrap().status(), StatusCode::OK, "an empty body fits");
    assert_eq!(none.oneshot(req(1)).await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE, "0 is 0, not the default");
}

#[cfg(feature = "json")]
paths! {
    Zone = "/zone",
    ZoneApi = "/zone/api",
    ZoneApiPing = "/zone/api/ping",
    ZoneMid = "/zone/api/mid",
    ZoneMidPost = "/zone/api/mid/post",
    ZoneIn = "/zone/api/mid/in",
    ZoneInPing = "/zone/api/mid/in/ping",
    Everything = "/",
    EverythingPing = "/ping",
}

#[cfg(feature = "json")]
#[derive(crate::Route)]
#[route("/{*rest}")]
struct EverythingRest<'a> {
    rest: &'a str,
}

/// Three APIs nested in an area, each taking what it leaves unset from the nearest around it and
/// keeping what it sets; their middleware runs area, outer, middle, inner (#539).
#[cfg(feature = "json")]
#[tokio::test]
async fn nested_apis_take_what_they_leave_unset_from_the_nearest() {
    let steps = || {
        crate::Methods::reads(get(|headers: http::HeaderMap| async move {
            tokio::time::sleep(Duration::from_millis(if headers.contains_key("x-slow") { 200 } else { 0 })).await;
            headers.get("x-steps").map_or(String::new(), |v| v.to_str().unwrap().to_string())
        }))
    };
    let shape = |status: StatusCode, message: &str| ShapedError {
        r#type: "error",
        error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
    };
    let shaped = |code: u16, message: &str| format!(r#"{{"type":"error","error":{{"code":{code},"message":{message:?}}}}}"#);
    let router = App::new(Routes::new())
        .middleware(Step("app", false))
        .api::<ZoneIn>(|inner| inner.route::<ZoneInPing>(steps()).middleware(Step("in", false)))
        .area::<Zone>(|zone| zone.middleware(Step("zone", false)).deadline(Duration::from_millis(50)))
        .api::<ZoneMid>(|mid| {
            mid.route::<ZoneMidPost>(crate::Methods::writes(crate::router::post(|| async { "posted" })))
                .middleware(Step("mid", false))
                .allow_origin("https://mid.example")
        })
        .api::<ZoneApi>(|api| {
            api.route::<ZoneApiPing>(steps()).middleware(Step("api", false)).errors(shape).allow_origin("https://outer.example")
        })
        .router();
    let send = |method: &'static str, path: &'static str, headers: &'static [(&'static str, &'static str)]| {
        let router = router.clone();
        async move {
            let mut req = Request::builder().method(method).uri(path);
            for (name, value) in headers {
                req = req.header(*name, *value);
            }
            let (parts, body) = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
            (parts.status, parts.headers, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
        }
    };
    assert_eq!(send("GET", "/zone/api/mid/in/ping", &[]).await.2, "app zone api mid in", "area, then outermost API first");
    assert_eq!(send("GET", "/zone/api/ping", &[]).await.2, "app zone api");
    let (status, _, body) = send("GET", "/zone/api/mid/in/ping", &[("x-slow", "1")]).await;
    assert_eq!((status.as_u16(), body), (503, shaped(503, "Service Unavailable")), "the area's deadline, the outer API's shape");
    let (status, _, body) = send("GET", "/zone/api/mid/in/nope", &[]).await;
    assert_eq!((status.as_u16(), body), (404, shaped(404, "Not Found")), "an unknown URL under the inner prefix");
    let preflight = |origin: &'static str| -> &'static [(&'static str, &'static str)] {
        match origin {
            "mid" => &[("origin", "https://mid.example"), ("access-control-request-method", "GET")],
            _ => &[("origin", "https://outer.example"), ("access-control-request-method", "GET")],
        }
    };
    // Origins are each API's own: the inner API names none, so neither the middle's nor the outer's
    // partner may call it, and the middle's list is not the outer's.
    for (path, origin) in [("/zone/api/mid/in/ping", "mid"), ("/zone/api/mid/in/ping", "outer"), ("/zone/api/mid/post", "outer")]
    {
        let (_, headers, _) = send("OPTIONS", path, preflight(origin)).await;
        assert!(!headers.contains_key("access-control-allow-origin"), "{path} from {origin}");
    }
    let (status, headers, _) = send("OPTIONS", "/zone/api/mid/post", preflight("mid")).await;
    assert_eq!(
        (status, headers.get("access-control-allow-origin").map(|v| v.to_str().unwrap())),
        (StatusCode::NO_CONTENT, Some("https://mid.example")),
        "an API's own origin"
    );
    let inner_cross: &[(&str, &str)] = &[("origin", "https://mid.example"), ("sec-fetch-site", "cross-site")];
    assert_eq!(
        send("POST", "/zone/api/mid/in/ping", inner_cross).await.0,
        StatusCode::FORBIDDEN,
        "nor its writes under the inner prefix"
    );
    let cross: &[(&str, &str)] = &[("origin", "https://mid.example"), ("sec-fetch-site", "cross-site")];
    assert_eq!(send("POST", "/zone/api/mid/post", cross).await.2, "posted", "a write from its own origin");
    let evil: &[(&str, &str)] = &[("origin", "https://outer.example"), ("sec-fetch-site", "cross-site")];
    let (status, _, body) = send("POST", "/zone/api/mid/post", evil).await;
    assert_eq!(
        (status.as_u16(), body),
        (403, shaped(403, "Cross-site request refused.")),
        "the outer's origin is not the middle's"
    );

    // A "/" API around another: the inner one's routes meet the outer's middleware first.
    let router = App::new(Routes::new())
        .api::<Everything>(|all| all.route::<EverythingPing>(steps()).middleware(Step("all", false)))
        .api::<ApiRoot>(|api| api.route::<ApiSlow>(steps()).middleware(Step("api", false)))
        .router();
    assert_eq!(call_with(router.clone(), "GET", "/api/slow", None, None).await.2, "all api");
    assert_eq!(call_with(router, "GET", "/ping", None, None).await.2, "all");
    // A "/" API's catch-all does not answer under another API's prefix.
    let router = App::new(Routes::new())
        .api::<Everything>(|all| all.route::<EverythingRest>(steps()))
        .api::<ApiRoot>(|api| api.route::<ApiSlow>(steps()))
        .router();
    assert_eq!(call_with(router.clone(), "GET", "/elsewhere", None, None).await.0, StatusCode::OK);
    assert_eq!(call_with(router, "GET", "/api/elsewhere", None, None).await.0, StatusCode::NOT_FOUND);
}

#[cfg(feature = "json")]
paths! {
    Outer = "/outer",
    OuterIn = "/outer/in",
    OuterInSlow = "/outer/in/slow",
    OuterInNone = "/outer/none",
    OuterInNoneSlow = "/outer/none/slow",
    Walled = "/walled",
    WalledApi = "/walled/api",
    WalledApiIn = "/walled/api/in",
    WalledApiInSlow = "/walled/api/in/slow",
}

#[cfg(feature = "json")]
#[derive(crate::Route)]
#[route("/outer/{id}")]
struct OuterAny<'a> {
    id: &'a str,
}

/// What an inner API sets is its own over the outer's (its error shape, its deadline, `None`
/// included), an outer API's deadline over an area's around both, and an outer parameter route
/// never answers a path under the inner prefix (#539).
#[cfg(feature = "json")]
#[tokio::test]
async fn an_inner_apis_settings_are_its_own() {
    let slow = || {
        crate::Methods::reads(get(|| async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            "done"
        }))
    };
    let outer_shape = |status: StatusCode, message: &str| ShapedError {
        r#type: "outer",
        error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
    };
    let inner_shape = |status: StatusCode, message: &str| ShapedError {
        r#type: "inner",
        error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
    };
    let page = Table::new().route("/{*rest}", get(|| async { "page" }));
    let router = App::new(Routes::from(page))
        .deadline(Duration::from_millis(50))
        .api::<Outer>(|outer| outer.route::<OuterAny>(crate::Methods::reads(get(|| async { "outer" }))).errors(outer_shape))
        .api::<OuterIn>(|inner| inner.route::<OuterInSlow>(slow()).errors(inner_shape).deadline(Duration::from_secs(10)))
        .api::<OuterInNone>(|none| none.route::<OuterInNoneSlow>(slow()).deadline(None))
        .area::<Walled>(|walled| walled.deadline(Duration::from_millis(20)))
        .api::<WalledApi>(|api| api.deadline(Duration::from_secs(10)))
        .api::<WalledApiIn>(|inner| inner.route::<WalledApiInSlow>(slow()))
        .router();
    let call = |path: &'static str| {
        let router = router.clone();
        async move {
            let (status, _, body) = call_with(router, "GET", path, None, None).await;
            (status.as_u16(), body)
        }
    };
    assert_eq!(call("/outer/7").await, (200, "outer".to_string()), "the outer parameter route outside the inner prefixes");
    let inner_404 = (404, r#"{"type":"inner","error":{"code":404,"message":"Not Found"}}"#.to_string());
    assert_eq!(call("/outer/in").await, inner_404, "not the outer /outer/{{id}}: the inner API's 404, in its shape");
    assert_eq!(call("/outer/in/other").await, inner_404);
    assert_eq!(call("/elsewhere").await, (200, "page".to_string()), "the app's catch-all page outside the APIs");
    assert_eq!(call("/outer/in/a/b").await, inner_404, "not the app's catch-all page either");
    assert_eq!(call("/outer/in/slow").await, (200, "done".to_string()), "the inner API's longer deadline");
    assert_eq!(call("/outer/none/slow").await, (200, "done".to_string()), "an inner None removes the outer's");
    let (status, body) = call("/outer/none/x").await;
    assert_eq!(
        (status, &body[..]),
        (404, r#"{"type":"outer","error":{"code":404,"message":"Not Found"}}"#),
        "the shape it left unset"
    );
    assert_eq!(call("/walled/api/in/slow").await, (200, "done".to_string()), "the nearest API's deadline over the area's");
}

#[cfg(feature = "json")]
paths! {
    Apis = "/apis",
    ApisPing = "/apis/ping",
    WalledOwn = "/walled/own",
    WalledOwnSlow = "/walled/own/slow",
}

/// `/apis` is beside `/api`, not in it: it takes nothing from it and its routes are its own; and
/// an API in an area that sets a deadline, in no API, takes the area's (#539).
#[cfg(feature = "json")]
#[tokio::test]
async fn an_api_beside_another_takes_nothing_from_it() {
    let slow = || {
        crate::Methods::reads(get(|| async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            "done"
        }))
    };
    let shape = |status: StatusCode, message: &str| ShapedError {
        r#type: "error",
        error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
    };
    let router = App::new(Routes::new())
        .api::<ApiRoot>(|api| api.route::<ApiRest>(crate::Methods::reads(get(|| async { "api" }))).errors(shape))
        .api::<Apis>(|apis| apis.route::<ApisPing>(crate::Methods::reads(get(|| async { "apis" }))))
        .area::<Walled>(|walled| walled.deadline(Duration::from_millis(20)))
        .api::<WalledOwn>(|own| own.route::<WalledOwnSlow>(slow()))
        .router();
    let call = |path: &'static str| {
        let router = router.clone();
        async move {
            let (status, _, body) = call_with(router, "GET", path, None, None).await;
            (status.as_u16(), body)
        }
    };
    assert_eq!(call("/apis/ping").await, (200, "apis".to_string()));
    let (status, body) = call("/apis/nope").await;
    assert_eq!(status, 404);
    assert!(body.contains(r#""title":"Not Found""#), "its own Problem Details, not /api's shape: {body}");
    assert_eq!(call("/api/x").await, (200, "api".to_string()));
    assert_eq!(call("/walled/own/slow").await.0, 503, "the area's deadline");
}

/// Under a nested API, a WebSocket handshake from another site is held to that API's origins,
/// not the outer one's.
#[cfg(feature = "json")]
#[tokio::test]
async fn an_upgrade_under_a_nested_api_takes_its_origins() {
    use crate::upgrade::Upgrade;
    async fn nothing(_: crate::upgrade::Stream, _: crate::Signal) {}
    let router = App::new(Routes::new())
        .api::<ApiRoot>(|api| api.allow_origin("https://outer.example"))
        .api::<ApiItems>(|items| {
            items
                .route::<ApiItem>(crate::Methods::reads(get(|upgrade: Upgrade| async move { upgrade.websocket(nothing) })))
                .allow_origin("https://inner.example")
        })
        .router();
    let status = |origin: &'static str| {
        let router = router.clone();
        async move {
            let req = Request::get("/api/items/7")
                .header("origin", origin)
                .header("sec-fetch-site", "cross-site")
                .header("connection", "upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-version", "13")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .body(Body::empty())
                .unwrap();
            router.oneshot(req).await.unwrap().status()
        }
    };
    assert_eq!(status("https://inner.example").await, StatusCode::BAD_REQUEST, "allowed: a oneshot cannot switch");
    assert_eq!(status("https://outer.example").await, StatusCode::FORBIDDEN, "the outer API's origin is not the inner's");
    // An inner API that allows no site: the outer's partner may not switch under it either.
    let router = App::new(Routes::new())
        .api::<ApiRoot>(|api| api.allow_origin("https://outer.example"))
        .api::<ApiItems>(|items| {
            items.route::<ApiItem>(crate::Methods::reads(get(|upgrade: Upgrade| async move { upgrade.websocket(nothing) })))
        })
        .router();
    let req = Request::get("/api/items/7")
        .header("origin", "https://outer.example")
        .header("sec-fetch-site", "cross-site")
        .header("connection", "upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(Body::empty())
        .unwrap();
    assert_eq!(router.oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
}

/// A route an outer API writes under an inner API's prefix would answer with the inner one's
/// settings: the app does not start.
#[test]
#[should_panic(expected = "move it to that API")]
fn an_outer_apis_route_under_an_inner_prefix_does_not_start() {
    let reads = || crate::Methods::reads(get(|| async { "x" }));
    let _ = App::new(Routes::new()).api::<ApiRoot>(|api| api.route::<ApiItem>(reads())).api::<ApiItems>(|items| items).router();
}

/// Three deep, the message names the innermost API that holds the route.
#[cfg(feature = "json")]
#[test]
#[should_panic(expected = r#"is under App::api("/zone/api/mid/in")"#)]
fn the_route_is_named_with_the_innermost_api_that_holds_it() {
    let reads = || crate::Methods::reads(get(|| async { "x" }));
    let _ = App::new(Routes::new())
        .api::<ZoneApi>(|api| api.route::<ZoneInPing>(reads()))
        .api::<ZoneMid>(|mid| mid)
        .api::<ZoneIn>(|inner| inner)
        .router();
}

#[cfg(feature = "json")]
#[derive(crate::Route)]
#[route("/api/{*rest}")]
struct ApiRest<'a> {
    rest: &'a str,
}

/// An API inside another (a feature's `/api/items` in the app's `/api`, which relays the rest)
/// keeps its own routes, takes the settings it leaves unset from the outer one, and meets the
/// outer one's middleware first; a request under its prefix is its own, whichever route answers
/// it (#539).
#[cfg(feature = "json")]
#[tokio::test]
async fn an_api_nests_in_another() {
    let steps = || {
        crate::Methods::reads(get(|headers: http::HeaderMap| async move {
            tokio::time::sleep(Duration::from_millis(if headers.contains_key("x-slow") { 200 } else { 0 })).await;
            headers.get("x-steps").map_or(String::new(), |v| v.to_str().unwrap().to_string())
        }))
    };
    let shape = |status: StatusCode, message: &str| ShapedError {
        r#type: "error",
        error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
    };
    // Given inner first: the order they are given in does not matter.
    let router = App::new(Routes::new())
        .middleware(Step("app", false))
        .api::<ApiItems>(|items| items.route::<ApiItem>(steps()).middleware(Step("items", true)).middleware(Saw))
        .api::<ApiRoot>(|api| {
            api.route::<ApiRest>(steps())
                .route::<ApiSlow>(steps())
                .middleware(Step("api", false))
                .deadline(Duration::from_millis(50))
                .errors(shape)
                .allow_origin("https://partner.example")
        })
        .router();
    let get_with = |path: &'static str, header: Option<(&'static str, &'static str)>| {
        let router = router.clone();
        async move {
            let mut req = Request::get(path);
            if let Some((name, value)) = header {
                req = req.header(name, value);
            }
            let (parts, body) = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().into_parts();
            (parts.status, parts.headers, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
        }
    };
    assert_eq!(get_with("/api/items/7", None).await.2, "app api items", "the outer API's middleware, then the inner's");
    assert_eq!(get_with("/api/slow", None).await.2, "app api", "the outer API's own routes meet its own alone");
    assert_eq!(get_with("/api/other/thing", None).await.2, "app api", "and its catch-all, outside the inner prefix");
    for path in ["/api/items/7/more", "/api/items"] {
        let (status, _, body) = get_with(path, None).await;
        assert_eq!(
            (status.as_u16(), &body[..]),
            (404, r#"{"type":"error","error":{"code":404,"message":"Not Found"}}"#),
            "{path}: a path under the inner prefix is the inner API's, never the outer catch-all's"
        );
        let (status, _, _) = get_with(path, Some(("x-flood", "1"))).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{path}: and meets the inner API's middleware first");
    }
    assert_eq!(get_with("/api/items/7", Some(("x-flood", "1"))).await.0, StatusCode::TOO_MANY_REQUESTS);
    // Every step runs for it, the app's first, and none is told a route matched it.
    let (_, headers, _) = get_with("/api/items/7/more", None).await;
    assert_eq!(
        (&headers["x-saw-steps"], headers.get("x-saw-route")),
        (&"app api items".parse::<http::HeaderValue>().unwrap(), None)
    );
    let (_, headers, _) = get_with("/api/items/7", None).await;
    assert_eq!(headers.get("x-saw-route").map(|v| v.to_str().unwrap()), Some("/api/items/{id}"), "a route of its own is named");
    // A method the outer catch-all lacks (a 405 of the outer route's, before) is a 404 too, and
    // whatever answers it says no method is allowed: the inner middleware's 429 as well.
    let (status, headers, _) = call_with_header(router.clone(), "POST", "/api/items/7/more", ("x-flood", "1")).await;
    assert_eq!((status, headers.get("allow").map(|v| v.to_str().unwrap())), (StatusCode::TOO_MANY_REQUESTS, Some("")));
    // A preflight there is the inner API's, which allows no other site: the outer's partner is
    // not let in under the inner prefix, nor on the inner API's routes.
    for path in ["/api/items/7/more", "/api/items/7"] {
        let (_, headers, _) = call_with_headers(
            router.clone(),
            "OPTIONS",
            path,
            &[("origin", "https://partner.example"), ("access-control-request-method", "GET")],
        )
        .await;
        assert!(!headers.contains_key("access-control-allow-origin"), "{path}");
    }
    let (_, headers, _) = call_with_headers(
        router.clone(),
        "OPTIONS",
        "/api/other",
        &[("origin", "https://partner.example"), ("access-control-request-method", "GET")],
    )
    .await;
    assert_eq!(
        headers.get("access-control-allow-origin").map(|v| v.to_str().unwrap()),
        Some("https://partner.example"),
        "the outer API's own"
    );
    // And a HEAD: the inner API's 404, with no method allowed.
    for method in ["POST", "HEAD"] {
        let (status, headers, _) = call_with(router.clone(), method, "/api/items/7/more", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method}");
        assert_eq!(headers.get("allow").map(|v| v.to_str().unwrap()), Some(""), "{method}: not the outer route's methods");
    }
    let (status, headers, body) = get_with("/api/items/7", Some(("x-slow", "1"))).await;
    assert_eq!(
        (status, &body[..]),
        (StatusCode::SERVICE_UNAVAILABLE, r#"{"type":"error","error":{"code":503,"message":"Service Unavailable"}}"#),
        "the outer API's deadline and error shape"
    );
    assert_eq!(headers["content-type"], "application/json");
    let (status, headers, _) = get_with("/api/items/7", Some(("origin", "https://partner.example"))).await;
    assert_eq!((status, headers.get("access-control-allow-origin")), (StatusCode::OK, None), "no partner of the outer's");
}

/// A top-level API owns its prefix too: a page's catch-all does not answer a path under it (#539).
#[cfg(feature = "json")]
#[tokio::test]
async fn a_page_catch_all_does_not_answer_under_an_api() {
    let everything = Routes::new().__route::<EverythingRest>(crate::Methods::reads(get(|| async { "page" })));
    let router = App::new(everything)
        .api::<ApiItems>(|items| items.route::<ApiItem>(crate::Methods::reads(get(|| async { "item" }))))
        .router();
    assert_eq!(call_with(router.clone(), "GET", "/elsewhere", None, None).await.2, "page");
    let (status, headers, body) = call_with(router.clone(), "GET", "/api/items/7/more", None, None).await;
    assert_eq!(
        (status, &headers["content-type"]),
        (StatusCode::NOT_FOUND, &"application/problem+json".parse::<http::HeaderValue>().unwrap()),
        "{body}"
    );
    assert_eq!(call_with(router, "GET", "/api/items/7", None, None).await.2, "item");
}

/// Served under another router's prefix by one that takes the prefix off the path (as axum's
/// `Router::nest_service` does), an API's routes are still its own, and a path outside them still
/// gets its 404.
#[cfg(feature = "json")]
#[tokio::test]
async fn an_api_answers_under_router_nest() {
    let nest = |prefix: &'static str, app: crate::Router| {
        app.layer(tower::util::MapRequestLayer::new(move |mut req: crate::http::Request| {
            let inner = req.uri().path().strip_prefix(prefix).expect("under the prefix").to_string();
            *req.uri_mut() = inner.parse().unwrap();
            req
        }))
    };
    let call = |router: crate::Router, uri: &'static str| async move {
        let res = router.oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        let status = res.status();
        (status, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
    };
    let everything = Routes::new().__route::<EverythingRest>(crate::Methods::reads(get(|| async { "page" })));
    let app = App::new(everything)
        .api::<ApiRoot>(|api| api.route::<ApiRest>(crate::Methods::reads(get(|| async { "rest" }))))
        .api::<ApiItems>(|items| items.route::<ApiItem>(crate::Methods::reads(get(|| async { "item" }))))
        .router();
    let router = nest("/outer", app);
    assert_eq!(call(router.clone(), "/outer/api/items/7").await.1, "item");
    assert_eq!(call(router.clone(), "/outer/api/other").await.1, "rest");
    assert_eq!(call(router, "/outer/api/items/7/more").await.0, StatusCode::NOT_FOUND);
    // Nested at a path that is also an API's prefix: the router matches the path without the
    // nest's part, so a catch-all outside the API still does not answer under it.
    let app = App::new(Routes::new())
        .api::<Everything>(|root| root.route::<EverythingRest>(crate::Methods::reads(get(|| async { "root" }))))
        .api::<ApiRoot>(|api| api)
        .router();
    let router = nest("/api", app);
    assert_eq!(call(router.clone(), "/api/elsewhere").await.1, "root");
    assert_eq!(call(router, "/api/api/other").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn api_routes_answer_every_failure_as_json_whatever_the_client_accepts() {
    let router = api_app(|api| api);
    for accept in ACCEPTS {
        let get = |uri: &'static str| call_with(router.clone(), "GET", uri, None, accept);
        let (status, headers, body) = get("/api/nope").await;
        assert_eq!((status, &body[..]), (StatusCode::NOT_FOUND, r#"{"title":"Not Found","status":404}"#), "{accept:?}");
        assert_eq!(headers["content-type"], "application/problem+json");
        assert!(!headers.contains_key("corten-page") && !headers.contains_key("corten-shell"), "no shell: {headers:?}");
        let (_, _, body) = get("/api/missing").await;
        assert_eq!(body, r#"{"title":"Not Found","status":404,"detail":"no item 7"}"#, "a 4xx error's message is for the client");
        let (status, _, body) = get("/api/down").await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, r#"{"title":"Internal Server Error","status":500}"#, "a 5xx message stays in the log");
        let (status, _, body) = get("/api/items/abc").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body.starts_with(r#"{"title":"Bad Request","status":400,"detail":"Invalid URL"#),
            "an extractor's rejection: {body}"
        );
        let (status, headers, body) = call_with(router.clone(), "GET", "/api/post", None, accept).await;
        assert_eq!((status, &headers["allow"]), (StatusCode::METHOD_NOT_ALLOWED, &"POST".parse().unwrap()));
        assert_eq!(body, r#"{"title":"Method Not Allowed","status":405}"#);
        // No route has a `DELETE`: the server implements it for no resource.
        let (status, headers, body) = call_with(router.clone(), "DELETE", "/api/post", None, accept).await;
        assert_eq!((status, headers.get("allow")), (StatusCode::NOT_IMPLEMENTED, None));
        assert_eq!(body, r#"{"title":"Not Implemented","status":501}"#);
        let (status, _, body) = get("/api/slow").await;
        assert_eq!((status, &body[..]), (StatusCode::SERVICE_UNAVAILABLE, r#"{"title":"Service Unavailable","status":503}"#));
        let (status, _, body) = get("/api/teapot").await;
        assert_eq!((status, &body[..]), (StatusCode::IM_A_TEAPOT, r#"{"mine":1}"#), "the handler's own JSON passes through");
        let (status, _, body) = get("/api/items/7").await;
        assert_eq!((status, &body[..]), (StatusCode::OK, "item 7"), "a success is the handler's");
    }
    let (_, headers, body) = call_with(router, "GET", "/nope", None, Some("*/*")).await;
    assert!(
        headers["content-type"].to_str().unwrap().starts_with("text/html") && body.contains("Not found"),
        "pages keep the page"
    );
}

#[tokio::test]
async fn api_routes_have_their_own_csp_and_pages_get_a_nonce_only_when_they_use_one() {
    let router = api_app(|api| api);
    let (_, headers, _) = call_with(router.clone(), "GET", "/api/items/1", None, None).await;
    assert_eq!(headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    let (_, headers, _) = call_with(router.clone(), "GET", "/", None, None).await;
    assert!(!headers["content-security-policy"].to_str().unwrap().contains("nonce"), "a document needs none");
    let (_, headers, _) = call_with(router.clone(), "GET", "/", Some("nav"), None).await;
    let csp = headers["content-security-policy"].to_str().unwrap();
    assert!(csp.starts_with("default-src 'self'; script-src 'self' 'sha256-") && !csp.contains("nonce"), "{csp}");
    let (_, headers, _) = call_with(router, "GET", runtime_path(), None, None).await;
    assert!(!headers["content-security-policy"].to_str().unwrap().contains("nonce"), "nor does a static file");
}

/// `Api::errors` writes every failure Corten answers under the prefix in the API's own shape.
#[cfg(feature = "json")]
#[tokio::test]
async fn an_api_writes_the_failures_corten_answers_in_its_own_shape() {
    let router = api_app(|api| {
        api.errors(|status, message| ShapedError {
            r#type: "error",
            error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
        })
    });
    let shaped = |code: u16, message: &str| format!(r#"{{"type":"error","error":{{"code":{code},"message":{message:?}}}}}"#);
    for (method, path, status, message) in [
        ("GET", "/api/nope", 404, "Not Found"),
        ("GET", "/api/post", 405, "Method Not Allowed"),
        ("GET", "/api/missing", 404, "no item 7"),
        ("GET", "/api/down", 500, "Internal Server Error"),
        ("GET", "/api/items/x", 400, "Invalid URL: Cannot parse `x` to a `u32`"),
        ("GET", "/api/slow", 503, "Service Unavailable"),
    ] {
        let (got, headers, body) = call_with(router.clone(), method, path, None, None).await;
        assert_eq!((got.as_u16(), &body[..]), (status, &shaped(status, message)[..]), "{method} {path}");
        assert_eq!(headers["content-type"], "application/json");
    }
    let (_, headers, _) = call_with(router.clone(), "GET", "/api/post", None, None).await;
    assert_eq!(headers["allow"], "POST", "what the failure says besides its body stays");
    let cross = Request::post("/api/post").header("origin", "https://evil.example").header("sec-fetch-site", "cross-site");
    let res = router.clone().oneshot(cross.body(Body::empty()).unwrap()).await.unwrap();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body, shaped(403, "Cross-site request refused."));
    let (_, _, body) = call_with(router, "GET", "/api/teapot", None, None).await;
    assert_eq!(body, r#"{"mine":1}"#, "a handler's own JSON failure passes through");
}

#[tokio::test]
async fn an_allowed_origin_may_call_the_api_from_the_browser_but_not_post_the_pages() {
    let router = api_app(|api| api.allow_origin("https://partner.example/"));
    let cross = |uri: &str, origin: &str| {
        Request::post(uri).header("origin", origin).header("sec-fetch-site", "cross-site").body(Body::empty()).unwrap()
    };
    let res = router.clone().oneshot(cross("/api/post", "https://partner.example")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["access-control-allow-origin"], "https://partner.example");
    assert!(res.headers().get_all("vary").iter().any(|v| v == "origin"));
    assert!(!res.headers().contains_key("access-control-allow-credentials"), "no cookies cross over");

    let res = router.clone().oneshot(cross("/api/post", "https://evil.example")).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(!res.headers().contains_key("access-control-allow-origin"));
    let body = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body, r#"{"title":"Forbidden","status":403,"detail":"Cross-site request refused."}"#);
    let res = router.clone().oneshot(cross("/", "https://partner.example")).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN, "the pages still refuse the partner's writes");
    let mut with_cookie = cross("/api/post", "https://partner.example");
    with_cookie.headers_mut().insert("cookie", "session=abc".parse().unwrap());
    let res = router.clone().oneshot(with_cookie).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN, "a partner's write never rides on the user's cookies");

    let preflight = |origin: &str| {
        Request::builder()
            .method("OPTIONS")
            .uri("/api/post")
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", "authorization, content-type")
            .body(Body::empty())
            .unwrap()
    };
    let res = router.clone().oneshot(preflight("https://partner.example")).await.unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert_eq!(res.headers()["access-control-allow-origin"], "https://partner.example");
    assert_eq!(res.headers()["access-control-allow-methods"], "POST");
    assert_eq!(res.headers()["access-control-allow-headers"], "authorization, content-type");
    let res = router.oneshot(preflight("https://evil.example")).await.unwrap();
    assert!(!res.headers().contains_key("access-control-allow-origin"), "another origin's preflight fails");
    assert_eq!(res.headers()["content-type"], "application/problem+json");
}

/// `Api::allow_origin` keeps an origin as a browser writes it in `Origin`, so one written with
/// its default port still lets that site's writes and preflights through.
#[tokio::test]
async fn an_allowed_origin_written_with_its_default_port_matches_the_browsers_origin() {
    let router = api_app(|api| api.allow_origin("https://partner.example:443"));
    let res = router
        .clone()
        .oneshot(
            Request::post("/api/post")
                .header("origin", "https://partner.example")
                .header("sec-fetch-site", "cross-site")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["access-control-allow-origin"], "https://partner.example");
    let preflight = Request::builder()
        .method("OPTIONS")
        .uri("/api/post")
        .header("origin", "https://partner.example")
        .header("access-control-request-method", "POST")
        .body(Body::empty())
        .unwrap();
    let res = router.oneshot(preflight).await.unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert_eq!(res.headers()["access-control-allow-origin"], "https://partner.example");
}

/// An app's webview sends its own scheme in `Origin` (Capacitor on iOS: `capacitor://localhost`);
/// allowed, its token-authenticated writes and preflights go through like a site's, and another
/// app's scheme does not.
#[tokio::test]
async fn an_allowed_origin_may_be_an_apps_webview() {
    let router = api_app(|api| api.allow_origin("capacitor://localhost"));
    let write = |origin: &str, site: Option<&str>| {
        let mut req = Request::post("/api/post").header("origin", origin);
        if let Some(site) = site {
            req = req.header("sec-fetch-site", site);
        }
        req.body(Body::empty()).unwrap()
    };
    for site in [Some("cross-site"), None] {
        let res = router.clone().oneshot(write("capacitor://localhost", site)).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{site:?}");
        assert_eq!(res.headers()["access-control-allow-origin"], "capacitor://localhost");
    }
    let res = router.clone().oneshot(write("tauri://localhost", Some("cross-site"))).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(!res.headers().contains_key("access-control-allow-origin"));

    let preflight = |origin: &str| {
        Request::builder()
            .method("OPTIONS")
            .uri("/api/post")
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", "authorization")
            .body(Body::empty())
            .unwrap()
    };
    let res = router.clone().oneshot(preflight("capacitor://localhost")).await.unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert_eq!(res.headers()["access-control-allow-origin"], "capacitor://localhost");
    assert_eq!(res.headers()["access-control-allow-methods"], "POST");
    let res = router.oneshot(preflight("tauri://localhost")).await.unwrap();
    assert!(!res.headers().contains_key("access-control-allow-origin"), "another app's preflight fails");
}

#[tokio::test]
async fn an_api_at_the_root_makes_the_whole_app_json() {
    let router =
        App::new(Routes::new()).api::<Root>(|api| api.route::<Items>(crate::Methods::reads(get(|| async { "items" })))).router();
    let (status, headers, body) = call_with(router.clone(), "GET", "/nope", None, Some("text/html")).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::NOT_FOUND, "application/problem+json"));
    assert_eq!(body, r#"{"title":"Not Found","status":404}"#);
    let (status, _, body) = call_with(router, "GET", "/health/ready", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "ok"), "Corten's own routes keep their behavior");
}

/// A request under an API is answered the same whatever mode its `corten` and `Accept` headers
/// name: the stages do not look the two up there (`RequestPage::read`), and the handler's `Req`
/// still reads them.
#[tokio::test]
async fn an_api_answers_the_same_whatever_mode_the_request_names() {
    let router = App::new(Routes::new())
        .api::<Root>(|api| api.route::<Items>(crate::Methods::reads(get(|req: Req| async move { format!("{:?}", req.mode) }))))
        .router();
    let said = |headers: &http::HeaderMap| {
        ["content-type", "cache-control", "vary"].map(|name| headers.get(name).map(|value| value.to_str().unwrap().to_owned()))
    };
    let asked = [
        (None, None, "Document"),
        (Some("nav"), Some("application/json"), "Navigation"),
        (Some("action"), Some("text/html"), "Action"),
        (Some("page"), None, "Document"),
        (None, Some("application/json"), "Data"),
        (None, Some("text/html,application/xhtml+xml,*/*;q=0.8"), "Document"),
    ];
    let mut answers = Vec::new();
    for (mode, accept, read) in asked {
        let (status, headers, body) = call_with(router.clone(), "GET", "/items", mode, accept).await;
        assert_eq!((status, &body[..]), (StatusCode::OK, read), "the handler's Req reads the two headers: {mode:?} {accept:?}");
        let (missing, missing_headers, problem) = call_with(router.clone(), "GET", "/nope", mode, accept).await;
        assert_eq!(
            (missing, &problem[..]),
            (StatusCode::NOT_FOUND, r#"{"title":"Not Found","status":404}"#),
            "{mode:?} {accept:?}"
        );
        answers.push((said(&headers), said(&missing_headers)));
    }
    assert_eq!(answers[0].1[0].as_deref(), Some("application/problem+json"));
    assert!(answers.iter().all(|answer| *answer == answers[0]), "one set of headers whatever the request names: {answers:?}");
}

/// An API's routes in a module of their own, sharing the module's state; its prefix route names
/// no handler.
#[crate::routes(api = ModRoot, state = u32)]
pub(super) mod api_module {
    #[route("/v1")]
    pub struct ModRoot;

    #[route("/v1/items/{id}", get = module_item)]
    pub struct ModItem {
        pub id: u32,
    }
}

async fn module_item(
    crate::extract::State(base): crate::extract::State<u32>,
    item: crate::Params<api_module::ModItem>,
) -> String {
    format!("item {}", base + item.id)
}

#[tokio::test]
async fn an_api_module_serves_its_routes_and_answers_its_failures_as_json() {
    let router = App::new(Routes::new()).api(|routes| api_module::api(routes, 100)).router();
    let (status, _, body) = call_with(router.clone(), "GET", "/v1/items/7", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "item 107"), "the handler gets the module's state");
    for (uri, status) in
        [("/v1/items/seven", StatusCode::BAD_REQUEST), ("/v1", StatusCode::NOT_FOUND), ("/v1/nope", StatusCode::NOT_FOUND)]
    {
        let (got, headers, body) = call_with(router.clone(), "GET", uri, None, Some("text/html")).await;
        assert_eq!((got, headers["content-type"].to_str().unwrap()), (status, "application/problem+json"), "{uri}");
        assert!(body.starts_with('{') && body.contains(&format!(r#""status":{}"#, status.as_u16())), "{uri}: {body}");
    }
    assert_eq!(api_module::ModItem { id: 7 }.to_string(), "/v1/items/7", "the structs still build links");
}

#[cfg(feature = "json")]
#[tokio::test]
async fn validation_errors_are_the_json_error_with_fields() {
    let router = App::new(Routes::new())
        .api::<ApiRoot>(|api| {
            api.route::<ApiSignUp>(crate::Methods::writes(crate::router::post(|| async {
                let mut errors = Errors::new();
                errors.add(SignUp::FIELDS.email, "Enter an email address.");
                Err::<&str, _>(errors)
            })))
        })
        .router();
    let (status, _, body) = call_with(router, "POST", "/api/sign-up", None, None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body,
        r#"{"title":"Unprocessable Entity","status":422,"detail":"email: Enter an email address.","fields":{"email":"Enter an email address."}}"#
    );
}

/// A JSON route that checks its input and loads a record, each with `?`.
#[cfg(feature = "json")]
#[crate::routes(api = CheckedRoot)]
pub(super) mod checked_api {
    #[route("/checked")]
    pub struct CheckedRoot;

    #[route("/checked/{n}", post = checked)]
    pub struct Checked {
        pub n: u32,
    }
}

#[cfg(feature = "json")]
async fn checked(checked: crate::Params<checked_api::Checked>) -> crate::JsonResult<u32> {
    let n = checked.n;
    let mut errors = Errors::new();
    if n == 0 {
        errors.add(SignUp::FIELDS.email, "Enter a number above zero.");
    }
    let n = errors.into_result(n)?;
    // A load that fails, next to the check.
    let n = n.checked_mul(1000).ok_or_else(|| Error::new("too large to load"))?;
    Ok(crate::Json(n))
}

paths! { ApiAdmin = "/api/admin" }

#[test]
#[should_panic(expected = "the area \"/api/admin\" is under App::api(\"/api\")")]
fn an_area_under_an_api_prefix_fails_at_startup() {
    let _ = App::new(Routes::new()).api::<ApiRoot>(|api| api).area::<ApiAdmin>(|admin| admin).router();
}
