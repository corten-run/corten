use super::*;

#[tokio::test]
async fn a_refused_whole_page_fetch_gets_html_only_if_it_asks_for_it() {
    let router = app(routes(), None);
    for accept in ["text/html", "*/*"] {
        let headers = [("sec-fetch-site", "cross-site"), ("corten", "page"), ("accept", accept)];
        let (status, headers, body) = guarded(&router, "POST", "/", None, &headers).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        if accept == "text/html" {
            assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"), "{headers:?}");
            assert!(body.contains("<h1>Not allowed</h1>"), "{body}");
        } else {
            assert_eq!(body, "Cross-site request refused.");
        }
    }
}

/// A page that shows who is asking, or that no one is.
fn who_routes() -> Table {
    Table::new().route(
        "/",
        get(|req: Req, viewer: Option<Caller<Viewer>>| async move {
            let who = viewer.map_or("guest", |Caller(v)| v.0);
            req.test_page("Who", html! { <p>{who}</p> })
        }),
    )
}

#[tokio::test]
async fn the_page_key_follows_the_caller_the_handler_read() {
    let (_, headers, guest) = call(app(who_routes(), None), "GET", None).await;
    assert!(guest.contains("<p>guest</p>"), "{guest}");
    let key = meta_content(&guest, "corten-shell");
    assert_eq!(headers["corten-shell"], key, "the document and its header agree");

    let (_, _, ada) = call(app(who_routes(), Some("ada")), "GET", None).await;
    assert!(ada.contains("<p>ada</p>"));
    assert_ne!(meta_content(&ada, "corten-shell"), key, "signing in changes the key");
    let (_, _, bob) = call(app(who_routes(), Some("bob")), "GET", None).await;
    assert_ne!(meta_content(&bob, "corten-shell"), meta_content(&ada, "corten-shell"), "so does someone else");

    let (_, nav, body) = call(app(who_routes(), Some("ada")), "GET", Some("nav")).await;
    assert_eq!(nav["corten-shell"], meta_content(&ada, "corten-shell"), "navigations carry the key");
    assert_eq!(body, "<title>Who</title><p>ada</p>", "a navigation sends only the page");

    let (_, _, anonymous) = call(app(routes(), Some("ada")), "GET", None).await;
    assert_ne!(meta_content(&anonymous, "corten-shell"), meta_content(&ada, "corten-shell"), "a page that reads no caller");
}

/// A rule over [`Viewer`]: one who may sell.
#[derive(Clone, Hash)]
struct Seller(Viewer);

impl<S: Sync> crate::Identify<S> for Seller {
    async fn identify(parts: &http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        let Caller(viewer) = Caller::<Viewer>::find(parts, state).await?;
        if viewer.0 == "bob" {
            return Err(crate::Refused::forbidden());
        }
        Ok(Seller(viewer))
    }
}

/// A rule over [`Seller`].
#[derive(Clone, Hash)]
struct Owner(Seller);

impl<S: Sync> crate::Identify<S> for Owner {
    async fn identify(parts: &http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        Ok(Owner(Caller::<Seller>::find(parts, state).await?.0))
    }
}

/// A rule per permission over [`Viewer`], as an admin app's `Staff<IntakeAccess>` is.
#[derive(Clone, Hash)]
struct Permit<R>(Viewer, std::marker::PhantomData<R>);

#[derive(Clone, Hash)]
struct Intake;
#[derive(Clone, Hash)]
struct Returns;

impl<S: Sync, R: Clone + std::hash::Hash + Send + Sync + 'static> crate::Identify<S> for Permit<R> {
    async fn identify(parts: &http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        Ok(Permit(Caller::<Viewer>::find(parts, state).await?.0, std::marker::PhantomData))
    }
}

/// A rule over [`Viewer`] that holds data of its own: the org it acts for, from a header here
/// (a path or the store in an app).
#[derive(Clone, Hash)]
struct Member(Viewer, &'static str);

impl<S: Sync> crate::Identify<S> for Member {
    async fn identify(parts: &http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        let Caller(viewer) = Caller::<Viewer>::find(parts, state).await?;
        let org = parts.headers.get("org").and_then(|v| v.to_str().ok()).unwrap_or("none");
        Ok(Member(viewer, org.to_owned().leak()))
    }
}

/// The same for everyone (a rate-limit bucket), read by [`Person`]'s lookup first.
#[derive(Clone, Hash)]
struct Bucket;

impl<S: Sync> crate::Identify<S> for Bucket {
    async fn identify(_: &http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
        tokio::task::yield_now().await;
        Ok(Bucket)
    }
}

/// A caller whose lookup reads another caller ([`Bucket`]) that is not who is asking.
#[derive(Clone, Hash)]
struct Person(Viewer);

impl<S: Sync> crate::Identify<S> for Person {
    async fn identify(parts: &http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        Caller::<Bucket>::find(parts, state).await?;
        Ok(Person(<Viewer as crate::Identify<S>>::identify(parts, state).await?))
    }
}

/// Reads [`Seller`] and [`Bucket`] joined, as a middleware's extractor might.
struct Joined;

impl<S: Send + Sync> crate::extract::FromRequestParts<S> for Joined {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut http::request::Parts, state: &S) -> std::result::Result<Self, Response> {
        let (seller, bucket) = tokio::join!(Caller::<Seller>::find(parts, state), Caller::<Bucket>::find(parts, state));
        seller.and(bucket).map(|_| Joined).map_err(IntoResponse::into_response)
    }
}

/// A role [`Granted`] checks for, named in the request's `roles` header.
trait Role {
    const NAME: &'static str;
}
impl Role for Intake {
    const NAME: &'static str = "intake";
}
impl Role for Returns {
    const NAME: &'static str = "returns";
}

/// A rule per role over [`Viewer`] that refuses a viewer without the role.
#[derive(Clone, Hash)]
struct Granted<R>(Viewer, std::marker::PhantomData<R>);

impl<S: Sync, R: Role + Clone + std::hash::Hash + Send + Sync + 'static> crate::Identify<S> for Granted<R> {
    async fn identify(parts: &http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        let Caller(viewer) = Caller::<Viewer>::find(parts, state).await?;
        let roles = parts.headers.get("roles").and_then(|v| v.to_str().ok()).unwrap_or("");
        if !roles.split(',').any(|role| role == R::NAME) {
            return Err(crate::Refused::forbidden());
        }
        Ok(Granted(viewer, std::marker::PhantomData))
    }
}

/// Pages for one person behind different rules share the key, so a navigation between them swaps
/// `<main>`; another person, no one, or a rule's own data (an org) still changes it (#709).
#[tokio::test]
async fn pages_behind_rules_over_one_caller_share_its_key() {
    let routes = || {
        who_routes()
            .route(
                "/sell",
                get(|req: Req, Caller(seller): Caller<Seller>| async move {
                    req.test_page(
                        "Sell",
                        html! {
                            <p>{seller.0 .0}</p>
                        },
                    )
                }),
            )
            .route(
                "/own",
                get(|req: Req, Caller(owner): Caller<Owner>| async move {
                    req.test_page(
                        "Own",
                        html! {
                            <p>{owner.0 .0 .0}</p>
                        },
                    )
                }),
            )
            // A handler that takes two rules over the one viewer.
            .route(
                "/both",
                get(|req: Req, Caller(_): Caller<Seller>, Caller(_): Caller<Owner>| async move {
                    req.test_page(
                        "Both",
                        html! {
                            <p>"both"</p>
                        },
                    )
                }),
            )
            .route(
                "/intake",
                get(|req: Req, _: Caller<Permit<Intake>>| async move {
                    req.test_page(
                        "Intake",
                        html! {
                            <p>"intake"</p>
                        },
                    )
                }),
            )
            .route(
                "/returns",
                get(|req: Req, _: Caller<Permit<Returns>>| async move {
                    req.test_page(
                        "Returns",
                        html! {
                            <p>"returns"</p>
                        },
                    )
                }),
            )
            .route("/org", get(|req: Req, Caller(m): Caller<Member>| async move { req.test_page("Org", html! { <p>{m.1}</p> }) }))
            .route("/joined", get(|req: Req, _: Joined| async move { req.test_page("Joined", html! { <p>"joined"</p> }) }))
            .route(
                "/apart",
                get(|req: Req, _: Caller<Seller>, _: Caller<Bucket>| async move {
                    req.test_page(
                        "Apart",
                        html! {
                            <p>"apart"</p>
                        },
                    )
                }),
            )
            .route(
                "/person",
                get(|req: Req, Caller(p): Caller<Person>| async move {
                    req.test_page(
                        "Person",
                        html! {
                            <p>{p.0 .0}</p>
                        },
                    )
                }),
            )
    };
    let key = |viewer: Option<&'static str>, uri: &'static str, org: &'static str| {
        let router = app(routes(), viewer);
        async move {
            let req = Request::get(uri).header("corten", "nav").header("org", org).body(Body::empty()).unwrap();
            let res = router.oneshot(req).await.unwrap();
            (res.status(), res.headers()["corten-shell"].to_str().unwrap().to_string())
        }
    };
    let (_, viewer) = key(Some("ada"), "/", "").await;
    for uri in ["/sell", "/own", "/both", "/intake", "/returns"] {
        let (status, rule) = key(Some("ada"), uri, "").await;
        assert_eq!((status, &rule), (StatusCode::OK, &viewer), "{uri}: the same person, so the same key");
    }
    let (_, cy) = key(Some("cy"), "/", "").await;
    assert_eq!(key(Some("cy"), "/sell", "").await.1, cy, "cy's rule page has cy's key");
    assert_ne!(cy, viewer, "another person behind the same rule has another key");
    let (_, guest) = key(None, "/", "").await;
    assert_ne!(guest, viewer, "signing out still changes it");

    // A rule's own data is in the key: a layout that draws the org is not kept across orgs.
    let (_, acme) = key(Some("ada"), "/org", "acme").await;
    assert_ne!(acme, viewer, "a member is keyed by its org too");
    assert_ne!(key(Some("ada"), "/org", "globex").await.1, acme, "another org, another key");
    assert_eq!(key(Some("ada"), "/org", "acme").await.1, acme);

    // A caller read joined with a rule, or after it, keys the page alike.
    let (_, apart) = key(Some("ada"), "/apart", "").await;
    assert_eq!(key(Some("ada"), "/joined", "").await.1, apart);
    // A lookup that reads another caller first (a bucket) is still keyed by who is asking.
    let (_, ada) = key(Some("ada"), "/person", "").await;
    let (_, bob) = key(Some("bob"), "/person", "").await;
    assert_ne!(ada, bob, "a lookup that reads a bucket first still tells people apart");

    // A refused rule's page is keyed apart from the one it refused.
    let (status, refused) = key(Some("bob"), "/sell", "").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_ne!(refused, key(Some("bob"), "/", "").await.1);
}

/// A layout that draws a link per role reads each rule as an `Option`: which ones passed is in
/// the key, so a navigation after a role changes does not keep the old links (#709).
#[tokio::test]
async fn which_optional_rules_passed_is_in_the_key() {
    let routes = || {
        who_routes().route(
            "/desk",
            get(|req: Req, _: Caller<Viewer>, _: Option<Caller<Granted<Intake>>>, _: Option<Caller<Granted<Returns>>>| async move {
                req.test_page("Desk", html! { <p>"desk"</p> })
            }),
        )
    };
    let key = |roles: &'static str| {
        let router = app(routes(), Some("ada"));
        async move {
            let req = Request::get("/desk").header("corten", "nav").header("roles", roles).body(Body::empty()).unwrap();
            router.oneshot(req).await.unwrap().headers()["corten-shell"].to_str().unwrap().to_string()
        }
    };
    let keys = [key("intake").await, key("returns").await, key("").await, key("intake,returns").await];
    for (i, a) in keys.iter().enumerate() {
        for b in &keys[i + 1..] {
            assert_ne!(a, b, "each set of roles has its own key: {keys:?}");
        }
    }
    let (_, viewer, _) = call_with(app(routes(), Some("ada")), "GET", "/", Some("nav"), None).await;
    assert_eq!(keys[3], viewer["corten-shell"], "every rule passed: keyed as the viewer alone");
}

/// An error page that reads `ClientIp` again keys its answer as the handler's one read does: a
/// caller marked twice in a request is mixed in once (#709). Over a connection, which is where
/// the error page has the peer too.
#[tokio::test]
async fn an_error_page_that_reads_the_client_ip_again_keys_it_once() {
    async fn ip_error_page(_: Failure, req: Req, ip: Option<crate::ClientIp>) -> HtmlResult {
        let ip = ip.map_or("none".to_string(), |crate::ClientIp(ip)| ip.to_string());
        req.page(Shell { req: &req, title: "Failed", head: "", children: html! { <p>{ip}</p> } })
    }
    let routes = Table::new()
        .route(
            "/ok",
            get(|req: Req, crate::ClientIp(ip): crate::ClientIp| async move {
                req.test_page("Ok", html! { <p>{ip.to_string()}</p> })
            }),
        )
        .route("/fail", get(|crate::ClientIp(_): crate::ClientIp| async { crate::Result::<String>::Err(Error::not_found()) }));
    let app = App::new(Routes::from(routes)).error_page(ip_error_page, ());
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let shell = |answer: &str| {
        let line = answer.lines().find(|line| line.to_ascii_lowercase().starts_with("corten-shell:")).expect(answer);
        line.split_once(':').unwrap().1.trim().to_string()
    };
    let ok = raw_get(addr, "/ok", "corten: nav\r\n").await;
    let failed = raw_get(addr, "/fail", "corten: nav\r\n").await;
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
    assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
    assert!(failed.starts_with("HTTP/1.1 404") && failed.contains("<p>127.0.0.1</p>"), "{failed}");
    assert_eq!(shell(&failed), shell(&ok));
}

/// A rule read first by a layer outside the app's (`App::layer`) keys the page as when the
/// handler reads it (#709).
#[tokio::test]
async fn a_rule_read_by_an_outer_layer_keys_the_page_as_its_base() {
    let routes = || {
        who_routes().route(
            "/sell",
            get(|req: Req, Caller(s): Caller<Seller>| async move { req.test_page("Sell", html! { <p>{s.0 .0}</p> }) }),
        )
    };
    let outer = App::new(Routes::from(routes()))
        .error_page(test_error_page, ())
        .middleware(AsViewer(Some("ada")))
        .layer(OuterFn(|req: crate::http::Request, next: crate::Router| async move {
            let (mut parts, body) = req.into_parts();
            parts.headers.insert("viewer", http::HeaderValue::from_static("ada"));
            let _ = <Caller<Seller> as crate::extract::FromRequestParts<()>>::from_request_parts(&mut parts, &()).await;
            next.oneshot(crate::http::Request::from_parts(parts, body)).await.unwrap()
        }))
        .router();
    let (_, viewer, _) = call_with(app(routes(), Some("ada")), "GET", "/", Some("nav"), None).await;
    let (status, sell, _) = call_with(outer, "GET", "/sell", Some("nav"), None).await;
    assert_eq!((status, &sell["corten-shell"]), (StatusCode::OK, &viewer["corten-shell"]));
}

#[tokio::test]
async fn a_caller_is_looked_up_only_by_the_handlers_that_read_it_and_once() {
    let routes = Table::new().route("/", get(|| async { "page" })).route(
        "/twice",
        get(|_: Caller<Viewer>, again: Option<Caller<Viewer>>| async move { again.map_or("", |Caller(v)| v.0) }),
    );
    let router = app(routes, Some("ada"));
    LOOKUPS.with(|n| n.set(0));
    for uri in ["/", runtime_path(), "/health/live"] {
        call_with(router.clone(), "GET", uri, None, None).await;
    }
    assert_eq!(LOOKUPS.with(|n| n.get()), 0, "a route that does not read who is asking never looks");
    let (_, _, body) = call_with(router, "GET", "/twice", None, None).await;
    assert_eq!((body.as_str(), LOOKUPS.with(|n| n.get())), ("ada", 1), "two readers, one lookup");
}

/// A caller whose lookup waits (a session store's round trip).
#[derive(Clone, Hash)]
struct Slow(&'static str);

impl<S: Sync> crate::Identify<S> for Slow {
    async fn identify(_: &http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
        LOOKUPS.with(|n| n.set(n.get() + 1));
        tokio::task::yield_now().await;
        Ok(Slow("ada"))
    }
}

/// Reads `Slow` twice at once, as a type over two others that share it would.
struct TwoAtOnce;

impl<S: Sync + Send> crate::extract::FromRequestParts<S> for TwoAtOnce {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut http::request::Parts, state: &S) -> std::result::Result<Self, Response> {
        let (a, b) = tokio::join!(Caller::<Slow>::find(parts, state), Caller::<Slow>::find(parts, state));
        a.and(b).map(|_| TwoAtOnce).map_err(IntoResponse::into_response)
    }
}

/// Readers of one caller type at the same time wait for the one lookup, and the page's key has
/// the caller in it as when it is read once (two marks would take it out again).
#[tokio::test]
async fn readers_of_a_caller_at_the_same_time_share_one_lookup_and_one_key() {
    let routes = Table::new()
        .route("/once", get(|req: Req, _: Caller<Slow>| async move { req.test_page("Who", "ada") }))
        .route("/joined", get(|req: Req, _: TwoAtOnce| async move { req.test_page("Who", "ada") }))
        .route("/nobody", get(|req: Req| async move { req.test_page("Who", "ada") }));
    let router = app(routes, None);
    let mut keys = Vec::new();
    for uri in ["/once", "/joined", "/nobody"] {
        LOOKUPS.with(|n| n.set(0));
        let (status, headers, _) = call_with(router.clone(), "GET", uri, None, None).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        keys.push((headers["corten-shell"].to_str().unwrap().to_string(), LOOKUPS.with(|n| n.get())));
    }
    assert_eq!(keys[1], keys[0], "joined: one lookup, the same key as one reader");
    assert_eq!(keys[0].1, 1);
    assert_ne!(keys[0].0, keys[2].0, "the key has the caller in it");
}

/// A layer outside the app's (`App::layer`) that reads the caller before the request has its
/// signal shares the lookup with the handler.
#[tokio::test]
async fn a_layer_outside_the_app_shares_the_lookup_with_the_handler() {
    let routes = Table::new().route("/", get(|Caller(v): Caller<Viewer>| async move { v.0 }));
    let router = App::new(Routes::from(routes))
        .middleware(AsViewer(Some("ada")))
        .layer(OuterFn(|req: crate::http::Request, next: crate::Router| async move {
            let (mut parts, body) = req.into_parts();
            parts.headers.insert("viewer", http::HeaderValue::from_static("ada"));
            let _ = <Caller<Viewer> as crate::extract::FromRequestParts<()>>::from_request_parts(&mut parts, &()).await;
            next.oneshot(crate::http::Request::from_parts(parts, body)).await.unwrap()
        }))
        .router();
    LOOKUPS.with(|n| n.set(0));
    let (_, _, body) = call_with(router, "GET", "/", None, None).await;
    assert_eq!((body.as_str(), LOOKUPS.with(|n| n.get())), ("ada", 1));
}

/// The app's own middleware that reads the caller before the handler (a request log naming who
/// asked) shares the lookup with the handler and with the error page of a refusal after it.
#[tokio::test]
async fn a_middleware_that_reads_the_caller_shares_the_lookup() {
    struct Logs;
    impl crate::Middleware for Logs {
        async fn call(&self, req: crate::http::Request, next: impl crate::Next) -> Response {
            let (mut parts, body) = req.into_parts();
            parts.headers.insert("viewer", http::HeaderValue::from_static("ada"));
            let who = Caller::<Viewer>::find(&parts, &()).await.map(|Caller(v)| v.0).unwrap_or("no one");
            let mut res = next.run(crate::http::Request::from_parts(parts, body)).await;
            res.headers_mut().insert("x-who", http::HeaderValue::from_static(who));
            res
        }
    }
    let routes = Table::new()
        .route("/", get(|Caller(v): Caller<Viewer>| async move { v.0 }))
        .route("/refused", get(|Caller(_): Caller<Viewer>| async move { Err::<&str, _>(Error::status(StatusCode::FORBIDDEN)) }));
    let router = App::new(Routes::from(routes)).error_page(test_error_page, ()).middleware(Logs).router();
    for (uri, status) in [("/", StatusCode::OK), ("/refused", StatusCode::FORBIDDEN)] {
        LOOKUPS.with(|n| n.set(0));
        let (got, headers, _) = call_with(router.clone(), "GET", uri, None, None).await;
        assert_eq!((got, headers["x-who"].to_str().unwrap(), LOOKUPS.with(|n| n.get())), (status, "ada", 1), "{uri}");
    }
}

/// A caller type that is a rule over another (`Staff` reads `Viewer` with `Caller::find`)
/// shares its lookup, in whichever order the handler takes them.
#[tokio::test]
async fn a_caller_type_over_another_shares_its_lookup() {
    let routes =
        Table::new()
            .route(
                "/staff-first",
                get(|Caller(Staff(_)): Caller<Staff>, viewer: Option<Caller<Viewer>>| async move {
                    viewer.map_or("", |Caller(v)| v.0)
                }),
            )
            .route(
                "/viewer-first",
                get(|viewer: Option<Caller<Viewer>>, Caller(Staff(_)): Caller<Staff>| async move {
                    viewer.map_or("", |Caller(v)| v.0)
                }),
            );
    let router = app(routes, Some("ada"));
    for uri in ["/staff-first", "/viewer-first"] {
        LOOKUPS.with(|n| n.set(0));
        let (_, _, body) = call_with(router.clone(), "GET", uri, None, None).await;
        assert_eq!((body.as_str(), LOOKUPS.with(|n| n.get())), ("ada", 1), "{uri}: one lookup for both types");
    }
}

/// A key check that says why it refused, and locks out a client with too many failed attempts.
#[derive(Clone, Hash, Debug)]
struct Keyed;

impl<S: Sync> crate::Identify<S> for Keyed {
    async fn identify(parts: &http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
        match parts.headers.get("authorization").map(|v| v.as_bytes()) {
            Some(b"Bearer k1") => Ok(Keyed),
            Some(b"Bearer locked") => Err(crate::Refused::too_many(std::time::Duration::from_millis(1500))
                .message("Too many failed attempts; try again later")),
            _ => Err(crate::Refused::unauthorized(crate::Challenge::bearer("keys")).message("Invalid API key")),
        }
    }
}

#[derive(crate::Route)]
#[route("/api/keyed")]
struct ApiKeyed;

/// A refusal says why, in the API's own shape, a 401 says how to send credentials
/// (`WWW-Authenticate`, RFC 9110 15.5.2), and a lockout is a 429 that says when to try again.
#[cfg(feature = "json")]
#[tokio::test]
async fn a_refusal_tells_the_client_why_and_when_to_try_again() {
    let router = api_app(|api| {
        api.route::<ApiKeyed>(crate::Methods::reads(get(|_: Caller<Keyed>| async { "ok" }))).errors(|status, message| {
            ShapedError { r#type: "error", error: ShapedDetail { code: status.as_u16(), message: message.to_string() } }
        })
    });
    let keyed = |key: Option<&'static str>| {
        let mut req = Request::get("/api/keyed");
        if let Some(key) = key {
            req = req.header("authorization", format!("Bearer {key}"));
        }
        let router = router.clone();
        async move {
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let header = |name| res.headers().get(name).map(|v: &http::HeaderValue| v.to_str().unwrap().to_string());
            let (status, retry, challenge) = (res.status().as_u16(), header("retry-after"), header("www-authenticate"));
            (status, retry, challenge, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
        }
    };
    assert_eq!(keyed(Some("k1")).await, (200, None, None, "ok".to_string()));
    assert_eq!(
        keyed(None).await,
        (
            401,
            None,
            Some(r#"Bearer realm="keys""#.to_string()),
            r#"{"type":"error","error":{"code":401,"message":"Invalid API key"}}"#.to_string()
        )
    );
    let (status, retry, challenge, body) = keyed(Some("locked")).await;
    assert_eq!((status, retry.as_deref(), challenge), (429, Some("2"), None), "whole seconds, rounded up");
    assert_eq!(body, r#"{"type":"error","error":{"code":429,"message":"Too many failed attempts; try again later"}}"#);
}

#[derive(crate::Route)]
#[route("/api/refuses")]
struct ApiRefuses;

/// A handler's own refusal says why in the API's own shape, as an extractor's does (#890): its
/// message, a lockout's `Retry-After`, and a lookup that is down as a 503.
#[cfg(feature = "json")]
#[tokio::test]
async fn a_handlers_refusal_tells_an_api_client_why_as_an_extractors_does() {
    async fn refuses(headers: http::HeaderMap) -> crate::Result<&'static str> {
        let refused = match headers.get("x-case").map(|v| v.as_bytes()) {
            Some(b"forbid") => crate::Refused::forbidden().message("Not your item"),
            Some(b"lock") => crate::Refused::too_many(std::time::Duration::from_millis(1500)).message("Slow down"),
            Some(b"down") => crate::Refused::unavailable("the session store is down"),
            Some(b"key") => crate::Refused::unauthorized(crate::Challenge::basic("shop")).message("Bad key"),
            _ => return Ok("ok"),
        };
        Err(refused.into())
    }
    let router = api_app(|api| {
        api.route::<ApiRefuses>(crate::Methods::reads(get(refuses))).errors(|status, message| ShapedError {
            r#type: "error",
            error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
        })
    });
    for (case, status, retry, message) in [
        ("forbid", 403, None, "Not your item"),
        ("lock", 429, Some("2"), "Slow down"),
        ("down", 503, None, "Service Unavailable"),
        ("key", 401, None, "Bad key"),
    ] {
        let req = Request::get("/api/refuses").header("x-case", case).body(Body::empty()).unwrap();
        let res = router.clone().oneshot(req).await.unwrap();
        let got = (res.status().as_u16(), res.headers().get("retry-after").map(|v| v.to_str().unwrap().to_owned()));
        assert_eq!(got, (status, retry.map(str::to_owned)), "{case}");
        let challenge = res.headers().get("www-authenticate").map(|v| v.to_str().unwrap().to_owned());
        let want = (status == 401).then(|| r#"Basic realm="shop""#.to_owned());
        assert_eq!(challenge, want, "a handler's own 401 keeps its challenge: {case}");
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let want = format!(r#"{{"type":"error","error":{{"code":{status},"message":{message:?}}}}}"#);
        assert_eq!(String::from_utf8(body.to_vec()).unwrap(), want, "{case}");
    }
}

#[tokio::test]
async fn the_error_page_uses_incoming_headers_after_middleware_edits() {
    struct Rewrite;

    impl crate::Middleware for Rewrite {
        async fn call(&self, mut req: Request, next: impl crate::middleware::Next) -> Response {
            let headers = req.headers_mut();
            headers.insert("corten", HeaderValue::from_static("nav"));
            headers.insert(header::COOKIE, HeaderValue::from_static("viewer=grace"));
            next.run(req).await
        }
    }

    let routes = Table::new().route(
        "/",
        get(|req: Req, headers: http::HeaderMap| async move {
            assert_eq!(req.mode, Mode::Navigation);
            assert_eq!(headers[header::COOKIE], "viewer=grace");
            assert_eq!(LOOKUPS.with(|n| n.get()), 0, "the error page makes the first caller lookup");
            Err::<Response, _>(Error::status(StatusCode::NOT_FOUND))
        }),
    );
    let router = App::new(Routes::from(routes)).middleware(Rewrite).error_page(test_error_page, ()).router();
    LOOKUPS.with(|n| n.set(0));
    let (status, headers, body) = guarded(&router, "GET", "/", None, &[("accept", "text/html"), ("cookie", "viewer=ada")]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!headers.contains_key("corten-page") && body.contains("<html"), "the incoming mode was a document: {body}");
    assert!(body.contains("Signed in as ada"), "the error page uses the incoming cookie: {body}");
    assert_eq!(LOOKUPS.with(|n| n.get()), 1);
}

// ---- Callers: who is asking, read by the handlers that need it ----

std::thread_local! {
    /// How many handlers that write ran on this test's thread.
    static WROTE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Staff: someone signed in who may use the admin area.
#[derive(Clone, Hash, Debug)]
struct Staff(&'static str);

impl<S: Sync> crate::Identify<S> for Staff {
    async fn identify(parts: &http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        let Caller(Viewer(name)) = Caller::<Viewer>::find(parts, state).await?;
        match name {
            "ada" | "bob" => Ok(Staff(name)),
            _ => Err(crate::Refused::forbidden()),
        }
    }
}

/// A partner, by its API key: there is nowhere to sign in.
#[derive(Clone, Hash, Debug)]
struct Partner(&'static str);

impl<S: Sync> crate::Identify<S> for Partner {
    async fn identify(parts: &http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
        match parts.headers.get("authorization").map(|v| v.as_bytes()) {
            Some(b"Bearer k1") => Ok(Partner("acme")),
            _ => Err(crate::Refused::unauthorized(crate::Challenge::bearer("partners"))),
        }
    }
}

#[crate::routes]
pub(super) mod caller_url {
    #[route("/", get = caller_home)]
    pub struct Home;

    #[route("/account", get = account, post = save_account)]
    pub struct Account;

    #[route("/sign-in", get = sign_in)]
    pub struct SignIn;

    #[route("/catalog/{id}", get = catalog)]
    pub struct Catalog {
        pub id: u32,
    }
}

/// Every route here takes `Caller<Staff>`, or the crate does not compile.
#[crate::routes(area = Admin, caller = Staff)]
pub(super) mod admin_url {
    #[route("/admin", get = admin_home, post = admin_save)]
    pub struct Admin;

    #[route("/admin/users/{id}", get = admin_user)]
    pub struct User {
        pub id: u32,
    }
}

/// An area with no page at its prefix: `Docs` is only the prefix, with no `href`.
#[crate::routes(area = Docs)]
pub(super) mod docs_url {
    #[route("/docs")]
    pub struct Docs;

    #[route("/docs/{page}", get = doc_page)]
    pub struct DocPage<'a> {
        pub page: &'a str,
    }
}

async fn doc_page(doc: crate::Params<docs_url::DocPage<'_>>) -> String {
    format!("doc {}", doc.page)
}

#[tokio::test]
async fn an_area_may_have_no_page_at_its_prefix() {
    use crate::Prefix;
    assert_eq!(docs_url::Docs::PREFIX, "/docs");
    let router = App::new(Routes::new()).area(docs_url::area).router();
    let (status, _, body) = call_with(router.clone(), "GET", &docs_url::DocPage { page: "intro" }.href(), None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "doc intro"));
    let (status, _, _) = call_with(router, "GET", "/docs", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "nothing is served at the prefix, and the app's 404 answers it");
}

async fn caller_home(req: Req) -> HtmlResult {
    req.test_page("Home", html! { <p>"home"</p> })
}

async fn account(req: Req, Caller(viewer): Caller<Viewer>) -> HtmlResult {
    req.test_page("Account", html! { <p>{viewer.0}</p> })
}

type Fields = crate::Form<std::collections::HashMap<String, String>>;

async fn save_account(Caller(_): Caller<Viewer>, crate::Form(_): Fields) -> &'static str {
    WROTE.with(|n| n.set(n.get() + 1));
    "saved"
}

async fn sign_in(req: Req) -> HtmlResult {
    req.test_page("Sign in", html! { <p>"sign in"</p> })
}

/// The same for everyone: it may read only what cannot tell who is asking.
async fn catalog(item: crate::Params<caller_url::Catalog>) -> Public<String> {
    Public::new(std::time::Duration::from_secs(60), format!("item {}", item.id))
}

async fn admin_home(req: Req, Caller(staff): Caller<Staff>) -> HtmlResult {
    req.test_page("Admin", html! { <p>"admin "{staff.0}</p> })
}

async fn admin_save(Caller(_): Caller<Staff>, crate::Form(_): Fields) -> &'static str {
    WROTE.with(|n| n.set(n.get() + 1));
    "saved"
}

async fn admin_user(user: crate::Params<admin_url::User>, Caller(_): Caller<Staff>) -> String {
    format!("user {}", user.id)
}

fn caller_app() -> Router {
    App::new(caller_url::router()).error_page(test_error_page, ()).area::<admin_url::Admin>(admin_url::area).router()
}

/// An auditor: another permission than the staff's, for one page in the admin area.
#[derive(Clone, Hash, Debug)]
struct Auditor;

impl<S: Sync> crate::Identify<S> for Auditor {
    async fn identify(parts: &http::request::Parts, state: &S) -> std::result::Result<Self, crate::Refused> {
        let Viewer(name) = <Viewer as crate::Identify<S>>::identify(parts, state).await?;
        match name {
            "ada" | "carol" => Ok(Auditor),
            _ => Err(crate::Refused::forbidden()),
        }
    }
}

/// A page in the admin area that its own caller may use: a second module in the same area.
#[crate::routes(area = super::admin_url::Admin, caller = Auditor)]
mod audit_url {
    #[route("/admin/users/{id}/audit", get = user_audit)]
    pub struct UserAudit {
        pub id: u32,
    }
}

async fn user_audit(crate::Params(at): crate::Params<audit_url::UserAudit>, Caller(_): Caller<Auditor>) -> String {
    format!("audit {}", at.id)
}

/// Two modules in one area, each holding its handlers to its own caller: a staff member who is
/// not an auditor reads the user and not the audit, and an auditor who is not staff the other
/// way round.
#[tokio::test]
async fn an_area_takes_modules_with_callers_of_their_own() {
    let router = App::new(caller_url::router())
        .error_page(test_error_page, ())
        .area(|area| audit_url::area(admin_url::area(area)))
        .router();
    for (uri, viewer, want) in [
        ("/admin/users/7", "bob", StatusCode::OK),
        ("/admin/users/7/audit", "bob", StatusCode::FORBIDDEN),
        ("/admin/users/7", "carol", StatusCode::FORBIDDEN),
        ("/admin/users/7/audit", "carol", StatusCode::OK),
        ("/admin/users/7/audit", "ada", StatusCode::OK),
    ] {
        let (status, _, body) = guarded(&router, "GET", uri, Some(viewer), &[]).await;
        assert_eq!(status, want, "{uri} as {viewer}: {body}");
    }
}

/// A route's handlers may take sixteen arguments with the caller and the address last, in either
/// order (#933).
#[crate::routes(area = super::admin_url::Admin, caller = Staff)]
mod wide_url {
    #[route("/admin/wide/{id}", get = wide, post = wide_save, no_store(post))]
    pub struct Wide {
        pub id: u32,
    }
}

type M = http::Method;

#[allow(clippy::too_many_arguments)]
async fn wide(
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    at: crate::Params<wide_url::Wide>,
    Caller(staff): Caller<Staff>,
) -> String {
    format!("wide {} {}", at.id, staff.0)
}

#[allow(clippy::too_many_arguments)]
async fn wide_save(
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    _: M,
    Caller(staff): Caller<Staff>,
    at: crate::Params<wide_url::Wide>,
) -> String {
    format!("saved {} {}", at.id, staff.0)
}

#[tokio::test]
async fn a_sixteen_argument_handler_takes_its_caller_and_address_last() {
    let router = App::new(caller_url::router())
        .error_page(test_error_page, ())
        .area(|area| wide_url::area(admin_url::area(area)))
        .router();
    for (method, viewer, want) in
        [("GET", "bob", (StatusCode::OK, "wide 7 bob")), ("POST", "ada", (StatusCode::OK, "saved 7 ada"))]
    {
        let (status, _, body) = guarded(&router, method, "/admin/wide/7", Some(viewer), &[]).await;
        assert_eq!((status, &body[..]), want, "{method} as {viewer}");
    }
    let (status, _, _) = guarded(&router, "GET", "/admin/wide/7", Some("carol"), &[]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

/// What a handler's arguments read, in the order they read it.
#[derive(Clone, Default)]
struct Reads(std::sync::Arc<std::sync::Mutex<Vec<&'static str>>>);

impl Reads {
    fn add(&self, read: &'static str) {
        self.0.lock().unwrap().push(read);
    }

    fn take(&self) -> Vec<&'static str> {
        std::mem::take(&mut self.0.lock().unwrap())
    }
}

struct ReadsFirst;
struct Refuses;
struct ReadsSecond;

impl crate::extract::FromRequestParts<Reads> for ReadsFirst {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(_: &mut http::request::Parts, reads: &Reads) -> Result<Self, Self::Rejection> {
        reads.add("first");
        Ok(ReadsFirst)
    }
}

impl crate::extract::FromRequestParts<Reads> for Refuses {
    type Rejection = StatusCode;

    async fn from_request_parts(_: &mut http::request::Parts, reads: &Reads) -> Result<Self, StatusCode> {
        reads.add("refuses");
        Err(StatusCode::IM_A_TEAPOT)
    }
}

impl crate::extract::FromRequestParts<Reads> for ReadsSecond {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(_: &mut http::request::Parts, reads: &Reads) -> Result<Self, Self::Rejection> {
        reads.add("second");
        Ok(ReadsSecond)
    }
}

/// A handler's arguments are read in order, the head's first and the body last, and the first
/// refusal answers the request: nothing after it is read, the body included. An argument that
/// takes the refusal as a `Result` goes on to the next.
#[tokio::test]
async fn a_handlers_arguments_are_read_in_order_and_the_first_refusal_answers() {
    use crate::handler::Handler;
    let reads = Reads::default();
    let request = |reads: &Reads| {
        let reads = reads.clone();
        let body = futures_util::stream::once(async move {
            reads.add("body");
            Ok::<_, std::convert::Infallible>(bytes::Bytes::from_static(b"text"))
        });
        Request::new(Body::from_stream(body))
    };
    let answer = |response: crate::http::Response| async move {
        let (parts, body) = response.into_parts();
        (parts.status, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
    };

    let all = |_: ReadsFirst, _: ReadsSecond, text: String| async move { text };
    let response = Handler::call(all, request(&reads), reads.clone()).await;
    assert_eq!(answer(response).await, (StatusCode::OK, "text".to_string()));
    assert_eq!(reads.take(), ["first", "second", "body"]);

    let refused = |_: ReadsFirst, _: Refuses, _: ReadsSecond, text: String| async move { text };
    let response = Handler::call(refused, request(&reads), reads.clone()).await;
    assert_eq!(answer(response).await.0, StatusCode::IM_A_TEAPOT);
    assert_eq!(reads.take(), ["first", "refuses"], "nothing after the refusal is read, the body included");

    let taken = |_: ReadsFirst, refusal: Result<Refuses, StatusCode>, text: String| async move {
        format!("{} {text}", refusal.err().unwrap().as_u16())
    };
    let response = Handler::call(taken, request(&reads), reads.clone()).await;
    assert_eq!(answer(response).await, (StatusCode::OK, "418 text".to_string()));
    assert_eq!(reads.take(), ["first", "refuses", "body"]);

    let whole = |text: Result<String, crate::extract::BodyRejection>| async move {
        text.map_err(|refusal| refusal.status().as_u16().to_string()).unwrap_or_else(|code| code)
    };
    let response = Handler::call(whole, Request::new(Body::from(vec![0xff])), reads.clone()).await;
    assert_eq!(answer(response).await, (StatusCode::OK, "400".to_string()), "the last argument's refusal, taken");
    let response = Handler::call(whole, request(&reads), reads.clone()).await;
    assert_eq!(answer(response).await, (StatusCode::OK, "text".to_string()));
    reads.take();

    let raw = |body: Body| async move { body.collect().await.unwrap().to_bytes() };
    let response = Handler::call(raw, request(&reads), reads.clone()).await;
    assert_eq!(answer(response).await, (StatusCode::OK, "text".to_string()));
    assert_eq!(reads.take(), ["body"], "a `Body` is read by the handler, not before it");
}

async fn guarded(
    router: &Router,
    method: &str,
    uri: &str,
    viewer: Option<&str>,
    headers: &[(&str, &str)],
) -> (StatusCode, http::HeaderMap, String) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(viewer) = viewer {
        req = req.header("viewer", viewer);
    }
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let body = if method == "POST" { Body::from("field=1") } else { Body::empty() };
    let req = req.header("content-type", "application/x-www-form-urlencoded").body(body).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (parts.status, parts.headers, String::from_utf8(bytes.to_vec()).unwrap())
}

#[tokio::test]
async fn a_missing_caller_sends_a_browser_to_sign_in_in_its_mode() {
    let router = caller_app();
    WROTE.with(|n| n.set(0));
    for (method, uri, headers) in [
        ("GET", "/account", &[][..]),
        ("GET", "/account", &[("corten", "nav")][..]),
        ("POST", "/account", &[][..]),
        ("GET", "/admin", &[][..]),
        ("POST", "/admin", &[][..]),
        ("GET", "/admin/users/7", &[][..]),
    ] {
        let (status, res, _) = guarded(&router, method, uri, None, headers).await;
        assert_eq!(
            (status, &res["location"]),
            (StatusCode::SEE_OTHER, &"/sign-in".parse().unwrap()),
            "{method} {uri} {headers:?}"
        );
        assert_eq!(res["cache-control"], "private, no-cache");
    }
    let (status, res, _) = guarded(&router, "POST", "/account", None, &[("corten", "action")]).await;
    assert_eq!((status, &res["corten-location"]), (StatusCode::NO_CONTENT, &"/sign-in".parse().unwrap()));
    let (status, res, body) = guarded(&router, "GET", "/account", None, &[("accept", "application/json")]).await;
    assert_eq!((status, &body[..]), (StatusCode::UNAUTHORIZED, r#"{"title":"Unauthorized","status":401}"#), "a data client");
    assert_eq!(res["content-type"], "application/problem+json");
    assert_eq!(WROTE.with(|n| n.get()), 0, "no handler ran, and no form was read");
    for uri in ["/", "/sign-in"] {
        let (status, _, _) = guarded(&router, "GET", uri, None, &[]).await;
        assert_eq!(status, StatusCode::OK, "{uri} reads no caller");
    }
}

#[tokio::test]
async fn a_refused_caller_gets_the_error_page_in_its_mode() {
    let router = caller_app();
    WROTE.with(|n| n.set(0));
    let (status, res, body) = guarded(&router, "GET", "/admin", Some("eve"), &[("accept", "text/html")]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(res["content-type"].to_str().unwrap().starts_with("text/html") && body.contains("Not allowed"), "{body}");
    let (status, res, _) = guarded(&router, "POST", "/admin", Some("eve"), &[("corten", "action")]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(res.contains_key("corten-page"), "a form patch gets the error page to swap in");
    let (status, _, body) = guarded(&router, "GET", "/admin", Some("eve"), &[("accept", "application/json")]).await;
    assert_eq!((status, &body[..]), (StatusCode::FORBIDDEN, r#"{"title":"Forbidden","status":403}"#));
    let (status, _, body) = guarded(&router, "GET", "/admin", Some("down"), &[("accept", "text/html")]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "who they are cannot be known now");
    assert!(!body.contains("session store"), "the message stays in the log: {body}");
    assert!(body.contains("Who you are cannot be checked"), "Failure::Unidentified, not a handler's 503: {body}");
    assert_eq!(WROTE.with(|n| n.get()), 0);
}

#[tokio::test]
async fn the_error_page_shows_who_is_asking() {
    let router = caller_app();
    let html = [("accept", "text/html")];
    LOOKUPS.with(|n| n.set(0));
    let (status, _, body) = guarded(&router, "GET", "/nope", None, &[("cookie", "viewer=ada"), html[0]]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body.contains("Signed in as ada"), "an unknown URL, drawn for who is asking: {body}");
    assert_eq!(LOOKUPS.with(|n| n.get()), 1, "looked up once, by the error page");
    let (status, _, body) = guarded(&router, "GET", "/nope", None, &[html[0]]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!body.contains("Signed in"), "no one: {body}");
    LOOKUPS.with(|n| n.set(0));
    let (status, _, body) = guarded(&router, "GET", "/admin", Some("eve"), &[("cookie", "viewer=eve"), html[0]]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains("Not allowed") && body.contains("Signed in as eve"), "a refusal, for who was refused: {body}");
    assert_eq!(LOOKUPS.with(|n| n.get()), 1, "the error page reads the viewer the refused handler's Staff found");
    // A lookup that failed (the store is down) is not tried again for the error page.
    LOOKUPS.with(|n| n.set(0));
    let (status, _, body) = guarded(&router, "GET", "/admin", Some("down"), &[("cookie", "viewer=down"), html[0]]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(!body.contains("Signed in"), "{body}");
    assert_eq!(LOOKUPS.with(|n| n.get()), 1, "one lookup, which failed");
    let (status, _, body) = guarded(&router, "GET", "/nope", None, &[("cookie", "viewer=down"), html[0]]).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "a lookup that fails draws the page signed out: {body}");
    assert!(body.contains("Not found") && !body.contains("Signed in"), "{body}");
    let (status, res, _) = guarded(&router, "GET", "/nope", None, &[("cookie", "viewer=ada"), ("corten", "nav")]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(res["x-robots-tag"], "noindex");
    assert!(res.contains_key("corten-page"), "in the request's mode");
}

#[tokio::test]
async fn the_error_page_after_a_handler_that_read_the_caller_keeps_the_pages_key() {
    let routes = Table::new()
        .route("/", get(|req: Req, _: Option<crate::Caller<Viewer>>| async move { req.test_page("Home", "") }))
        .route("/fail", get(|_: Option<crate::Caller<Viewer>>| async { Err::<Response, _>(Error::new("down")) }));
    let ada = [("cookie", "viewer=ada"), ("corten", "nav")];
    let (_, page, _) = guarded(&app(routes.clone(), None), "GET", "/", None, &ada).await;
    LOOKUPS.with(|n| n.set(0));
    let (status, failed, body) = guarded(&app(routes, None), "GET", "/fail", None, &ada).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body.contains("Signed in as ada"), "{body}");
    assert_eq!(LOOKUPS.with(|n| n.get()), 1, "the error page reads the caller the handler found");
    // Marked by the handler and the error page alike, the caller would cancel out of the key.
    assert_eq!(failed["corten-shell"], page["corten-shell"], "the same shell, so the runtime swaps it in");
}

#[tokio::test]
async fn a_handlers_own_503_is_not_an_unknown_caller() {
    let routes = Table::new().route("/", get(|| async { Err::<Response, _>(Error::status(StatusCode::SERVICE_UNAVAILABLE)) }));
    let (status, _, body) = call(app(routes, None), "GET", None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("Something went wrong") && !body.contains("cannot be checked"), "Failure::Failed: {body}");
}

#[tokio::test]
async fn a_found_caller_reaches_the_handler() {
    let router = caller_app();
    let (status, _, body) = guarded(&router, "GET", "/admin", Some("bob"), &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("<p>admin bob</p>"), "{body}");
    let (status, _, body) = guarded(&router, "POST", "/admin", Some("bob"), &[]).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "saved"));
    let (_, _, body) = guarded(&router, "GET", "/admin/users/7", Some("ada"), &[]).await;
    assert_eq!(body, "user 7");
    let (_, _, body) = guarded(&router, "GET", "/account", Some("eve"), &[]).await;
    assert!(body.contains("<p>eve</p>"), "anyone signed in has an account: {body}");
}

#[tokio::test]
async fn reading_a_caller_makes_the_answer_private_and_a_public_one_is_shared() {
    let router = caller_app();
    assert_eq!(cache_control(&router, "/catalog/1", &[]).await, "public, max-age=60");
    assert_eq!(cache_control(&router, "/catalog/1", &[("x-request-id", "k1")]).await, "public, max-age=60");
    assert_eq!(cache_control(&router, "/catalog/1", &[("authorization", "Bearer k1")]).await, "private, no-cache");
    assert_eq!(cache_control(&router, "/catalog/1", &[("cookie", "session=abc")]).await, "private, no-cache");
    assert_eq!(cache_control(&router, "/catalog/nope", &[]).await, "private, no-cache", "a failure is never shared");
    // A handler that reads a caller cannot return `Public` (that does not compile). A response that
    // says public anyway, by `Cache` or by a header written by hand (`HtmlResponse` derefs to the
    // response), is still private: the key could be anyone's.
    let minute = std::time::Duration::from_secs(60);
    let leaky = App::new(Routes::from(
        Table::new().route("/rates", get(move |Caller(p): Caller<Partner>| async move { (Cache::public(minute), p.0) })).route(
            "/by-hand",
            get(|Caller(p): Caller<Partner>| async move { ([(header::CACHE_CONTROL, "public, max-age=60")], p.0) }),
        ),
    ))
    .router();
    assert_eq!(cache_control(&leaky, "/rates", &[("authorization", "Bearer k1")]).await, "private, no-cache");
    assert_eq!(cache_control(&leaky, "/by-hand", &[("authorization", "Bearer k1")]).await, "private, no-cache");
}

#[tokio::test]
async fn a_caller_with_nowhere_to_sign_in_is_a_401_page() {
    let router = App::new(Routes::from(Table::new().route("/partner", get(|Caller(p): Caller<Partner>| async move { p.0 }))))
        .error_page(test_error_page, ())
        .router();
    let (status, res, body) = guarded(&router, "GET", "/partner", None, &[("accept", "text/html")]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(!res.contains_key("location") && body.contains("Something went wrong"), "{body}");
    assert_eq!(res["www-authenticate"], r#"Bearer realm="partners""#, "the error page keeps the challenge every 401 sends");
    let (status, res, _) = guarded(&router, "GET", "/partner", None, &[("corten", "action")]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(res.contains_key("corten-page"), "a form patch gets the error page to swap in");
    assert_eq!(res["www-authenticate"], r#"Bearer realm="partners""#, "and so does the page swapped in");
    let (status, _, body) = guarded(&router, "GET", "/partner", None, &[("authorization", "Bearer k1")]).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "acme"));
}

#[tokio::test]
async fn a_sign_in_page_that_needs_a_caller_is_an_error_not_a_loop() {
    let router =
        App::new(Routes::from(Table::new().route("/sign-in", get(|Caller(v): Caller<Viewer>| async move { v.0 })))).router();
    let (status, res, body) = guarded(&router, "GET", "/sign-in", None, &[("accept", "text/html")]).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "not a redirect the browser follows forever");
    assert!(!res.contains_key("location") && !body.contains("itself"), "the message stays in the log: {body}");
}

/// A handler's own refusal is answered as an extractor's is (#890): a sign-in is a redirect for a
/// browser, a `corten-location` for the runtime's form and a 401 problem for a data client.
/// `with_status` makes it a plain failure at that status, which says the refusal's message.
#[tokio::test]
async fn a_handlers_refusal_signs_in_and_answers_a_data_client_as_an_extractors() {
    async fn must_sign_in() -> crate::Result<&'static str> {
        Err(crate::Refused::sign_in(&caller_url::SignIn))?;
        Ok("never")
    }
    async fn moved() -> crate::Result<&'static str> {
        Err(Error::from(crate::Refused::forbidden().message("not yours")).with_status(StatusCode::NOT_FOUND))
    }
    async fn hidden() -> crate::Result<&'static str> {
        Err(Error::from(crate::Refused::forbidden()).with_status(StatusCode::NOT_FOUND))
    }
    async fn gone() -> crate::Result<&'static str> {
        Err(Error::not_found())
    }
    let routes = Table::new()
        .route("/mine", get(must_sign_in).post(must_sign_in))
        .route("/moved", get(moved))
        .route("/hidden", get(hidden))
        .route("/gone", get(gone));
    let router = App::new(Routes::from(routes)).error_page(test_error_page, ()).router();
    for (method, headers) in [("GET", &[][..]), ("POST", &[][..]), ("GET", &[("corten", "nav")][..])] {
        let (status, res, _) = guarded(&router, method, "/mine", None, headers).await;
        assert_eq!((status, &res["location"]), (StatusCode::SEE_OTHER, &"/sign-in".parse().unwrap()), "{method} {headers:?}");
    }
    let (status, res, _) = guarded(&router, "POST", "/mine", None, &[("corten", "action")]).await;
    assert_eq!((status, &res["corten-location"]), (StatusCode::NO_CONTENT, &"/sign-in".parse().unwrap()));
    let (status, res, body) = guarded(&router, "GET", "/mine", None, &[("accept", "application/json")]).await;
    assert_eq!((status, &body[..]), (StatusCode::UNAUTHORIZED, r#"{"title":"Unauthorized","status":401}"#), "a data client");
    assert_eq!(res["content-type"], "application/problem+json");
    assert!(!res.contains_key("www-authenticate"), "a session cookie has no scheme to name");

    let (status, res, _) = guarded(&router, "GET", "/moved", None, &[("accept", "text/html")]).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "the status with_status gave");
    assert!(!res.contains_key("location"));
    let (status, _, body) = guarded(&router, "GET", "/moved", None, &[("accept", "application/json")]).await;
    assert_eq!((status, &body[..]), (StatusCode::NOT_FOUND, r#"{"title":"Not Found","status":404,"detail":"not yours"}"#));
    // Without a message of its own, a refusal moved to 404 says what any 404 does, not that it was a 403.
    let json = [("accept", "application/json")];
    let (hidden, gone) =
        (guarded(&router, "GET", "/hidden", None, &json).await, guarded(&router, "GET", "/gone", None, &json).await);
    assert_eq!((hidden.0, &hidden.2), (gone.0, &gone.2));
}

#[cfg(feature = "json")]
#[crate::routes]
mod json_url {
    #[route("/api/price/{id}", get = price)]
    pub struct Price {
        pub id: u32,
    }
}

#[cfg(feature = "json")]
async fn price(price: crate::Params<json_url::Price>, Caller(partner): Caller<Partner>) -> JsonResult<Quote> {
    Ok(Json(Quote { id: price.id, partner: partner.0 }))
}

#[cfg(feature = "json")]
#[tokio::test]
async fn a_json_route_answers_every_failure_as_json_whatever_the_client_accepts() {
    let router = App::new(json_url::router()).error_page(test_error_page, ()).router();
    for accept in ACCEPTS {
        let headers: &[(&str, &str)] = match accept {
            Some(accept) => &[("accept", accept)],
            None => &[],
        };
        let (status, res, body) = guarded(&router, "GET", "/api/price/7", None, headers).await;
        assert_eq!((status, &body[..]), (StatusCode::UNAUTHORIZED, r#"{"title":"Unauthorized","status":401}"#), "{accept:?}");
        assert_eq!(res["content-type"], "application/problem+json");
        assert_eq!(res["www-authenticate"], r#"Bearer realm="partners""#, "{accept:?}");
        let (status, _, body) = guarded(&router, "GET", "/api/price/abc", None, headers).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{accept:?}");
        assert!(body.starts_with(r#"{"title":"Bad Request","status":400,"#), "a path that does not parse: {body}");
    }
    let (status, res, body) = guarded(&router, "GET", "/api/price/7", None, &[("authorization", "Bearer k1")]).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, r#"{"id":7,"partner":"acme"}"#));
    assert_eq!(res["cache-control"], "private, no-cache");
}
