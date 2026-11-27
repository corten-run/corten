use super::*;

/// A value only the layout shows is read for a full load, not for an answer the runtime swaps in.
#[tokio::test]
async fn a_layout_value_is_read_only_when_the_layout_renders() {
    use std::sync::atomic::{AtomicU32, Ordering};
    static READS: AtomicU32 = AtomicU32::new(0);
    let routes = Table::new().route(
        "/",
        get(|req: Req| async move {
            let count = if req.mode.swaps() { None } else { Some(READS.fetch_add(1, Ordering::Relaxed) + 7) };
            req.page::<()>(html! {
                <html>
                    <head>
                        <title>"Shop"</title>
                        <Corten />
                    </head>
                    <body>
                        <header>"Cart "{count.unwrap_or(0)}</header>
                        <main>"Items"</main>
                    </body>
                </html>
            })
        }),
    );
    let (_, _, body) = call_with(app(routes.clone(), None), "GET", "/", None, Some("text/html")).await;
    assert!(body.contains("Cart 7"), "{body}");
    for mode in ["nav", "action"] {
        let (_, _, body) = call_with(app(routes.clone(), None), "GET", "/", Some(mode), Some("text/html")).await;
        assert!(!body.contains("Cart") && body.contains("Items"), "{mode}: {body}");
    }
    assert_eq!(READS.load(Ordering::Relaxed), 1, "read once, for the full load");
    assert!(
        [Mode::Navigation, Mode::Action].iter().all(|m| m.swaps()) && ![Mode::Document, Mode::Data].iter().any(|m| m.swaps())
    );
}

/// Layout reads (`App::layout_read`): a value only the layout shows, read beside the page's own.
mod layout_reads {
    use super::*;
    use crate::{later, Caller, LayoutRead};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    /// The header's cart count: 3 after `delay`, counting the reads started and finished.
    #[derive(Clone, Default)]
    struct CartCount {
        delay: Duration,
        started: Arc<AtomicUsize>,
        finished: Arc<AtomicUsize>,
    }

    impl LayoutRead for CartCount {
        type Value = u32;

        fn start(&self, _: &http::request::Parts) -> Option<impl std::future::Future<Output = u32> + Send + 'static> {
            self.started.fetch_add(1, Ordering::SeqCst);
            let (delay, finished) = (self.delay, self.finished.clone());
            Some(async move {
                tokio::time::sleep(delay).await;
                finished.fetch_add(1, Ordering::SeqCst);
                3
            })
        }

        fn view(count: &u32) -> impl Render + '_ {
            html! { <span class="count">{*count}</span> }
        }
    }

    /// Who the layout says is signed in, from the request's one lookup of the caller.
    struct SignedIn;

    impl LayoutRead for SignedIn {
        type Value = Option<&'static str>;

        fn start(
            &self,
            parts: &http::request::Parts,
        ) -> Option<impl std::future::Future<Output = Option<&'static str>> + Send + 'static> {
            let parts = parts.clone();
            Some(async move { Caller::<Viewer>::find(&parts, &()).await.ok().map(|Caller(Viewer(name))| name) })
        }

        fn view(name: &Self::Value) -> impl Render + '_ {
            html! { <b>{name.unwrap_or("guest")}</b> }
        }
    }

    /// A read no app starts here.
    struct Unread;

    impl LayoutRead for Unread {
        type Value = ();

        fn start(&self, _: &http::request::Parts) -> Option<impl std::future::Future<Output = ()> + Send + 'static> {
            Some(async {})
        }

        fn view((): &()) -> impl Render + '_ {
            html! { "never" }
        }
    }

    /// The tests' layout with the count in its header.
    #[crate::component]
    fn Layout(req: &Req, children: impl Render) -> impl Document {
        html! {
            <!DOCTYPE html>
            <html lang={req.lang()}>
                <head>
                    <meta charset="utf-8">
                    <title>"Shop"</title>
                    <Corten />
                </head>
                <body>
                    <header>"Cart "{later::<CartCount>()}{later::<SignedIn>()}</header>
                    <main>{children}</main>
                    <footer>{later::<CartCount>()}</footer>
                </body>
            </html>
        }
    }

    /// A refused form is drawn again by a helper, from two branches and a closure: none of them
    /// takes the count.
    fn refused(req: &Req, why: &str) -> HtmlResult {
        req.page::<ForOne>(Layout { req, children: html! { <p>{why}</p> } })
    }

    /// A page for everyone.
    async fn for_all(req: Req) -> Public<HtmlResult> {
        Public::new(Duration::from_secs(60), req.page(Layout { req: &req, children: html! { <p>"for all"</p> } }))
    }

    /// A route that answers text, not a page, and takes `Req`.
    async fn as_text(_req: Req) -> &'static str {
        "text"
    }

    /// A page named in a routes module, which says it answers a page.
    async fn typed(req: Req) -> HtmlResult {
        req.page(Layout { req: &req, children: html! { <p>"typed"</p> } })
    }

    /// A page or a file, named in a routes module: a page when it draws one.
    async fn page_or_file(req: Req) -> crate::Result<crate::PageOr<crate::Media>> {
        Ok(req.page::<ForOne>(Layout { req: &req, children: html! { <p>"page or file"</p> } })?.into())
    }

    /// A cart page whose route says it gives the count (`gives(CartCount)`), and does.
    async fn gives_count(req: Req) -> HtmlResult {
        Ok(req.page::<ForOne>(Layout { req: &req, children: html! { <p>"cart"</p> } })?.give::<CartCount>(7))
    }

    /// A page whose route says it gives the count, and does not.
    async fn forgets_count(req: Req) -> HtmlResult {
        req.page(Layout { req: &req, children: html! { <p>"forgot"</p> } })
    }

    /// A page whose route says it gives the count, which finds nothing.
    async fn gives_but_gone(_req: Req) -> HtmlResult {
        Err(Error::not_found())
    }

    /// A page whose body fails as it is read.
    async fn breaks_secret(req: Req) -> crate::response::Response {
        let (head, _) = refused(&req, "secret").into_response().into_parts();
        let body = Body::from_stream(futures_util::stream::iter([Err::<bytes::Bytes, _>(std::io::Error::other("cut off"))]));
        crate::response::Response::from_parts(head, body)
    }

    /// The shop's routes `#[corten::routes]` makes, which say what they answer.
    #[crate::routes]
    mod shop_url {
        #[route("/given", get = gives_count, post = forgets_count, gives(CartCount))]
        pub struct Given;

        #[route("/forgot-plain", get = forgets_count)]
        pub struct ForgotPlain;

        #[route("/given-any", any = gives_count, gives(CartCount))]
        pub struct GivenAny;

        #[route("/forgot", get = forgets_count, gives(CartCount, SignedIn))]
        pub struct Forgot;

        #[route("/forgot-secret", get = forgets_count, gives(CartCount, SignedIn), no_store)]
        pub struct ForgotSecret;

        #[route("/given-gone", get = gives_but_gone, gives(CartCount))]
        pub struct GivenGone;

        #[route("/public", get = for_all)]
        pub struct ForAll;

        #[route("/text", get = as_text)]
        pub struct AsText;

        #[route("/typed", get = typed)]
        pub struct Typed;

        #[route("/page-or-file", get = page_or_file)]
        pub struct PageOrFile;

        #[route("/typed-write", post = typed_write)]
        pub struct TypedWrite;

        #[route("/document-write", post = document_write)]
        pub struct DocumentWrite;

        #[route("/patches-only", post = patches_only)]
        pub struct PatchesOnly;

        #[route("/named-patches", get = typed, post = patches_only, post(save) = patches_only, post(remove) = patches_only)]
        pub struct NamedPatches;

        #[route("/any-patch", post = any_patch)]
        pub struct AnyPatch;
    }

    /// A write named in a routes module that answers a patch, from a handler whose answer type
    /// (`HtmlResult`) may be a page too.
    async fn any_patch(req: Req) -> HtmlResult {
        req.action().ok_or_else(Error::not_found)?.patch(html! { <p id={MsgId}>"too short"</p> })
    }

    /// A write named in a routes module whose answer can be a page: drawn again with what it refused.
    async fn typed_write(req: Req) -> HtmlResult {
        refused(&req, "typed write")
    }

    async fn document_write(mut req: Req) -> HtmlResult {
        assert_eq!(req.mode, Mode::Action);
        assert!(!req.whole_action);
        req.mode = Mode::Document;
        refused(&req, "document write")
    }

    /// A write named in a routes module that answers patches alone.
    async fn patches_only(req: Req) -> HtmlResult<crate::Patches> {
        let mut patch = req.action().ok_or_else(Error::not_found)?.patch(html! { <p id={MsgId}>"patched"</p> })?;
        if req.whole_action {
            patch.headers_mut().insert("x-draws-whole", http::HeaderValue::from_static("yes"));
        }
        Ok(patch)
    }

    /// A handler's own check refuses the request (#890).
    async fn not_yours() -> crate::Result<HtmlResponse> {
        tokio::time::sleep(Duration::from_millis(5)).await;
        Err(crate::Refused::forbidden().into())
    }

    async fn handler_slows() -> crate::Result<HtmlResponse> {
        Err(crate::Refused::too_many(Duration::from_secs(2)).into())
    }

    fn shop(count: CartCount, page_delay: Duration) -> Router {
        let routes = Table::new()
            .route(
                "/",
                get(move |req: Req| async move {
                    tokio::time::sleep(page_delay).await; // the page's own reads
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>"home"</p> } })
                })
                .post(|req: Req| async move { req.redirect::<ForOne>(&Done) }),
            )
            .route(
                "/form",
                get(|req: Req| async move {
                    let short = req.path().len() < 3;
                    let draw = |why: &str| refused(&req, why);
                    if short {
                        return refused(&req, "too short");
                    }
                    if req.mode.swaps() {
                        return refused(&req, "again");
                    }
                    draw("closure")
                }),
            )
            .route(
                "/cart",
                get(|req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>"cart"</p> } })
                        .map(|page| page.give::<CartCount>(7))
                }),
            )
            .route(
                "/fails",
                get(|_req: Req| async move {
                    tokio::time::sleep(Duration::from_millis(10)).await; // the page's own reads, which fail
                    Err::<HtmlResponse, _>(Error::new("the store is down"))
                }),
            )
            .route("/refused", get(|_req: Req| async move { crate::Refused::forbidden().into_response() }))
            .route("/slow-down", get(|_req: Req| async move { crate::Refused::too_many(Duration::from_secs(1)).into_response() }))
            .route("/conflict", get(|_req: Req| async move { Err::<HtmlResponse, _>(Error::status(StatusCode::CONFLICT)) }))
            .route("/down", get(|_req: Req| async move { (StatusCode::SERVICE_UNAVAILABLE, "down for maintenance") }))
            .route("/gone", get(|_req: Req| async move { Err::<HtmlResponse, _>(Error::not_found()) }))
            .route("/refuse-write", crate::router::post(|_req: Req| async move { crate::Refused::forbidden().into_response() }))
            .route("/not-yours", get(not_yours))
            .route("/handler-slows", get(handler_slows))
            .route(
                "/who",
                get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! { <p>"who"</p> } }) }),
            )
            .route(
                "/unread",
                get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: later::<Unread>() }) }),
            )
            .route(
                "/mine",
                get(|req: Req, Caller(Viewer(name)): Caller<Viewer>| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{name}</p> } })
                }),
            )
            .route(
                "/inside",
                get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: later::<CartCount>() }) }),
            );
        let typed = shop_url::router();
        App::new(Routes(typed.0.merge(routes), typed.1, typed.2))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(count)
            .layout_read(SignedIn)
            .middleware(AsViewer(Some("ada")))
            .router()
    }

    /// With no icon in the static directory, `/favicon.ico` is a 404 with no body that starts no
    /// layout read and draws no page, where any other unknown URL is the error page in the layout
    /// with its reads (#1056).
    #[tokio::test]
    async fn the_favicon_path_without_an_icon_is_a_404_that_reads_nothing() {
        let count = CartCount::default();
        let req = Request::get("/favicon.ico").header("accept", "image/avif,image/webp,*/*").body(Body::empty()).unwrap();
        let res = shop(count.clone(), Duration::ZERO).oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(res.headers()[header::CACHE_CONTROL], "public, max-age=3600", "an hour, so an icon added is seen soon");
        assert!(res.into_body().collect().await.unwrap().to_bytes().is_empty(), "no page");
        assert_eq!(count.started.load(Ordering::SeqCst), 0, "no layout read");
        // The icon, in an app with the same reads.
        let icon = App::new(Routes::new()).assets(IconStatic).layout_read(count.clone()).router();
        let (status, headers, _) = call_with(icon, "GET", "/favicon.ico", None, None).await;
        assert_eq!(
            (status, &headers[header::CONTENT_TYPE]),
            (StatusCode::OK, &"image/x-icon".parse::<header::HeaderValue>().unwrap())
        );
        assert_eq!(count.started.load(Ordering::SeqCst), 0, "no layout read for the icon");
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/no-such-page", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains("<p>404</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "another unknown URL reads the layout's values");
    }

    #[tokio::test]
    async fn the_layout_draws_its_read_where_it_put_later_and_no_handler_passes_it() {
        let count = CartCount::default();
        let (status, _, body) = call(shop(count.clone(), Duration::ZERO), "GET", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#), "{body}");
        assert!(body.contains(r#"<footer><span class="count">3</span></footer>"#), "drawn in each place: {body}");
        assert!(!body.contains("corten-later"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "read once for both places");

        let (_, _, form) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/form", None, None).await;
        assert!(form.contains(r#"Cart <span class="count">3</span>"#) && form.contains("<p>closure</p>"), "{form}");
    }

    /// A page route named in a routes module starts the read when the request arrives, as one that
    /// takes `Req` does, whether it answers a page alone or a page or a file.
    #[tokio::test]
    async fn a_routes_module_page_draws_the_read_once() {
        for path in ["/typed", "/page-or-file"] {
            let count = CartCount::default();
            let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", path, None, None).await;
            assert_eq!(status, StatusCode::OK, "{path}");
            assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#), "{path}: {body}");
            assert_eq!(count.started.load(Ordering::SeqCst), 1, "{path}");
        }
    }

    #[tokio::test]
    async fn a_navigation_keeps_its_layout_so_the_read_is_not_started() {
        let count = CartCount::default();
        let (_, _, body) = call(shop(count.clone(), Duration::ZERO), "GET", Some("nav")).await;
        assert_eq!(body, "<title>Shop</title><p>home</p>");
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn the_read_runs_beside_the_page_s_own_reads() {
        let count = CartCount { delay: Duration::from_millis(60), ..CartCount::default() };
        let at = tokio::time::Instant::now();
        let (_, _, body) = call(shop(count, Duration::from_millis(56)), "GET", None).await;
        assert!(body.contains(r#"<span class="count">3</span>"#), "{body}");
        assert_eq!(at.elapsed(), Duration::from_millis(60), "the longer of the two, not their sum");
    }

    #[tokio::test(start_paused = true)]
    async fn a_page_that_gives_the_value_does_not_wait_and_a_redirect_cancels_the_read() {
        let count = CartCount { delay: Duration::from_millis(60), ..CartCount::default() };
        let at = tokio::time::Instant::now();
        let (_, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/cart", None, None).await;
        assert!(body.contains(r#"Cart <span class="count">7</span>"#), "{body}");
        assert_eq!(at.elapsed(), Duration::ZERO, "the page's value, not the read's");

        let (status, _, _) = call(shop(count.clone(), Duration::ZERO), "POST", None).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(count.finished.load(Ordering::SeqCst), 0, "neither read ran to its end");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "a write that redirects starts none");
    }

    /// `gives(CartCount)`: the route's page gives the count, so the read is never started (#869),
    /// and the other reads are.
    #[tokio::test]
    async fn a_route_that_gives_a_read_does_not_start_it() {
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/given", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains(r#"<header>Cart <span class="count">7</span><b>ada</b></header>"#), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 0, "never started");
        // Its error page is not the page that gives it: started there, and drawn.
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/given-gone", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>404</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "started for the error page");
        // An `any = ..` route serves `GET` too.
        let count = CartCount::default();
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/given-any", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains(r#"<span class="count">7</span>"#), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
        // `gives` is about its `GET`: a write that draws a page starts the reads it draws, and a
        // `HEAD` starts none.
        let count = CartCount::default();
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "POST", "/given", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>forgot</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
        let count = CartCount::default();
        let (status, _, _) = call_with(shop(count.clone(), Duration::ZERO), "HEAD", "/given", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    /// A route that says it gives a read whose page does not: a debug build refuses the page; a
    /// release build draws nothing there.
    #[tokio::test]
    async fn a_route_that_says_it_gives_a_read_and_does_not_is_refused_in_debug() {
        // The same page from a route that does not say so draws the read.
        let (status, _, body) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/forgot-plain", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains(r#"<span class="count">3</span>"#), "{body}");
        let count = CartCount::default();
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/forgot", None, None).await;
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
        if cfg!(debug_assertions) {
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
            // Named where a router test, with no logger and outside `corten dev`, sees it: on the
            // default error page, which draws the failure's detail, behind the app's middleware.
            let router = App::new(shop_url::router())
                .layout_read(CartCount::default())
                .layout_read(SignedIn)
                .middleware(AsViewer(Some("ada")))
                .dev(false)
                .router();
            let (status, _, body) = call_with(router, "GET", "/forgot", None, None).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
            assert!(body.contains("layout_reads::CartCount) off the route") && body.contains("did not give it"), "{body}");
        } else {
            assert_eq!(status, StatusCode::OK);
            assert!(body.contains("<header>Cart </header>") && body.contains("<p>forgot</p>"), "{body}");
        }
        // A `no_store` route's: what is sent in its page's place is kept by no cache either, whatever
        // the app's middleware makes of its caching headers. A debug build's refusal of a route
        // with no mark is Corten's answer, not the handler's, so no shared cache keeps it, also
        // when the error page drawn for it greets the visitor its cookie names.
        let html = [("accept", "text/html")];
        for cache in [None, Some("public, max-age=60"), Some("private, max-age=60")] {
            let router = App::new(shop_url::router())
                .layout_read(CartCount::default())
                .layout_read(SignedIn)
                .middleware(crate::tests::cache::CdnRecaches(cache))
                .error_page(crate::tests::cache::greeting_error_page, ())
                .dev(false)
                .router();
            let (status, headers, body) = call_with(router.clone(), "GET", "/forgot-secret", None, None).await;
            let sent = if cfg!(debug_assertions) { StatusCode::INTERNAL_SERVER_ERROR } else { StatusCode::OK };
            assert_eq!(status, sent, "{cache:?}: {body}");
            let wrong = crate::tests::cache::kept_from_cdns(&headers, "private, no-store");
            assert!(wrong.is_empty(), "{cache:?}: a no_store page's replacement, open to a cache: {wrong:?}");
            let (status, headers, body) = crate::tests::cache::from_ann(&router, "GET", "/forgot", &html).await;
            assert_eq!(status, sent, "{cache:?}: {body}");
            if cfg!(debug_assertions) {
                assert!(body.contains("Sorry, ann."), "{cache:?}: the error page in the refused page's place: {body}");
                let wrong = crate::tests::cache::kept_from_cdns(&headers, "private, no-cache");
                assert!(wrong.is_empty(), "{cache:?}: a refused page's replacement, open to a CDN: {wrong:?}");
            }
        }
    }

    /// A page whose body fails as it is read to be filled: the failure sent in its place is Corten's,
    /// not the handler's, so no shared cache keeps it, whatever the app's middleware makes of its
    /// caching headers, also when the page had no mark and the error page drawn for it greets the
    /// visitor its cookie names. A `NoStore` page's is kept by no cache.
    #[tokio::test]
    async fn a_page_that_cannot_be_read_to_be_filled_keeps_its_marks() {
        let html = [("accept", "text/html")];
        for cache in [None, Some("public, max-age=60"), Some("private, max-age=60")] {
            let routes = Table::new()
                .route("/broken", get(breaks_secret))
                .route("/broken-secret", get(|req: Req| async move { NoStore(breaks_secret(req).await) }))
                .route("/broken-refusal", get(|req: Req| async move { crate::cache::unshared(breaks_secret(req).await) }));
            let router = App::new(Routes::from(routes))
                .layout_read(CartCount::default())
                .layout_read(SignedIn)
                .middleware(crate::tests::cache::CdnRecaches(cache))
                .error_page(crate::tests::cache::greeting_error_page, ())
                .router();
            for (path, sent) in [
                ("/broken", "private, no-cache"),
                ("/broken-secret", "private, no-store"),
                ("/broken-refusal", "private, no-cache"),
            ] {
                let (status, headers, body) = crate::tests::cache::from_ann(&router, "GET", path, &html).await;
                assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{path} {cache:?}: {body}");
                assert!(body.contains("Sorry, ann."), "{path} {cache:?}: the error page in the page's place: {body}");
                let wrong = crate::tests::cache::kept_from_cdns(&headers, sent);
                assert!(wrong.is_empty(), "{path} {cache:?}: the failure in the page's place, open to a cache: {wrong:?}");
            }
        }
    }

    #[tokio::test]
    async fn the_error_page_for_a_5xx_draws_a_read_that_is_in_and_starts_or_waits_for_none() {
        // The page's own reads failed after the count was in: drawn.
        let (status, _, body) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/fails", None, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#) && body.contains("<p>500</p>"),
            "{body}"
        );
        // A read still running (the store the page failed on is down): drawn without it, at once.
        let at = std::time::Instant::now();
        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let (status, _, body) = call_with(shop(slow, Duration::ZERO), "GET", "/fails", None, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(body.contains("<header>Cart <b>ada</b></header>") && body.contains("<p>500</p>"), "{body}");
        assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
        // A 429 (a client being slowed down) waits for none either.
        let at = std::time::Instant::now();
        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let (status, _, body) = call_with(shop(slow, Duration::ZERO), "GET", "/slow-down", None, None).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert!(!body.contains("count") && body.contains("<p>429</p>"), "{body}");
        assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
    }

    #[tokio::test]
    async fn the_error_page_for_a_4xx_starts_the_reads_and_waits_for_them() {
        // An unknown address, which no route called: started for the error page, with its head,
        // and drawn.
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/nowhere", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains(r#"<header>Cart <span class="count">3</span>"#) && body.contains("<p>404</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "started once, for the error page");
        // A refusal after the route started them: the read still running is waited for.
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/refused", None, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>403</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "not started again for the error page");
        // A wrong method, which no handler answered.
        let count = CartCount::default();
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "DELETE", "/", None, None).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>405</p>"), "{body}");
        // A `HEAD` has no body, so it starts none.
        let count = CartCount::default();
        let (status, _, _) = call_with(shop(count.clone(), Duration::ZERO), "HEAD", "/nowhere", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    /// A middleware that answers `/soon` itself with a bare `501`, as one for a part of the app not
    /// built yet would, and rewrites a `501` when the query asks: `?to=418` changes only the
    /// status, `?to=418-page` gives it a page of its own too, and `?to=501-page` keeps the `501`
    /// and gives it a page of its own.
    struct NotBuilt;

    impl crate::Middleware for NotBuilt {
        async fn call(&self, req: crate::http::Request, next: impl crate::Next) -> crate::response::Response {
            if req.uri().path() == "/soon" {
                return crate::response::IntoResponse::into_response(StatusCode::NOT_IMPLEMENTED);
            }
            let to = req.uri().query().map(str::to_owned);
            let mut res = next.run(req).await;
            if res.status() == StatusCode::NOT_IMPLEMENTED {
                match to.as_deref() {
                    Some("to=418") => *res.status_mut() = StatusCode::IM_A_TEAPOT,
                    Some("to=418-page") => {
                        *res.status_mut() = StatusCode::IM_A_TEAPOT;
                        res.headers_mut()
                            .insert(http::header::CONTENT_TYPE, http::HeaderValue::from_static("text/html; charset=utf-8"));
                        *res.body_mut() = Body::from("<p>teapot</p>");
                    }
                    Some("to=501-page") => {
                        res.headers_mut()
                            .insert(http::header::CONTENT_TYPE, http::HeaderValue::from_static("text/html; charset=utf-8"));
                        *res.body_mut() = Body::from("<p>not here yet</p>");
                    }
                    _ => {}
                }
            }
            res
        }
    }

    /// An app with no `any` route, so `PROPFIND` is a method no route has, and with `501`s of its
    /// own: a handler's `Error::status` (`/said`), a handler's bare status (`/bare`) and a
    /// middleware's (`/soon`). Its error page names the failure it got.
    fn not_built(count: CartCount) -> Router {
        let routes = Table::new()
            .route(
                "/",
                get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! { <p>"home"</p> } }) }),
            )
            .route("/said", get(|_req: Req| async move { Err::<HtmlResponse, _>(Error::status(StatusCode::NOT_IMPLEMENTED)) }))
            .route("/bare", get(|_req: Req| async move { StatusCode::NOT_IMPLEMENTED }));
        App::new(Routes::from(routes))
            .error_page(
                |failure: Failure, req: Req| async move {
                    let kind = match &failure {
                        Failure::UnknownMethod => "unknown method",
                        Failure::Failed { .. } => "failed",
                        _ => "other",
                    };
                    req.page::<ForOne>(Layout {
                        req: &req,
                        children: html! {
                            <p>{failure.status().as_u16()}</p>
                            <p>{kind}</p>
                        },
                    })
                },
                (),
            )
            .layout_read(count)
            .layout_read(SignedIn)
            .middleware((AsViewer(Some("ada")), NotBuilt))
            .router()
    }

    #[tokio::test]
    async fn the_error_page_for_the_routers_501_starts_the_reads_and_waits_for_them() {
        // A method no route in the app has: the request's fault, as a 405 is.
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, headers, body) = call_with(not_built(count.clone()), "PROPFIND", "/", None, None).await;
        assert_eq!((status, headers.get("allow")), (StatusCode::NOT_IMPLEMENTED, None));
        assert!(body.contains(r#"<header>Cart <span class="count">3</span>"#) && body.contains("<p>501</p>"), "{body}");
        assert!(body.contains("<p>unknown method</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "started once, for the error page");
    }

    #[tokio::test]
    async fn the_error_page_for_a_501_the_app_answers_is_failed_and_waits_for_none() {
        // A part of the app not built yet, not a method no route has: `Failure::Failed`, as any
        // 5xx, whether the handler said so with `Error::status`, with the bare status, or a
        // middleware answered it.
        for path in ["/said", "/bare", "/soon"] {
            let at = std::time::Instant::now();
            let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
            let (status, _, body) = call_with(not_built(slow), "GET", path, None, None).await;
            assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{path}");
            assert!(!body.contains("count") && body.contains("<p>501</p>") && body.contains("<p>failed</p>"), "{path}: {body}");
            assert!(at.elapsed() < Duration::from_secs(1), "{path}: {:?}", at.elapsed());
        }
    }

    #[tokio::test]
    async fn a_middleware_that_turns_the_routers_501_into_another_status_keeps_it() {
        // Only the status changed: the error page for that status, not for a method no route has.
        let (status, _, body) = call_with(not_built(CartCount::default()), "PROPFIND", "/?to=418", None, None).await;
        assert_eq!(status, StatusCode::IM_A_TEAPOT, "{body}");
        assert!(body.contains("<p>418</p>") && body.contains("<p>failed</p>"), "{body}");
        // With a page of its own, which goes out as it wrote it.
        let (status, _, body) = call_with(not_built(CartCount::default()), "PROPFIND", "/?to=418-page", None, None).await;
        assert_eq!((status, body.as_str()), (StatusCode::IM_A_TEAPOT, "<p>teapot</p>"));
    }

    #[tokio::test]
    async fn a_middleware_that_gives_the_routers_501_a_body_keeps_it() {
        // Still a 501, now with the middleware's own page: sent as it wrote it, not replaced by the
        // error page for a method no route has.
        let (status, _, body) = call_with(not_built(CartCount::default()), "PROPFIND", "/?to=501-page", None, None).await;
        assert_eq!((status, body.as_str()), (StatusCode::NOT_IMPLEMENTED, "<p>not here yet</p>"));
    }

    /// Corten logs an `Error` a handler returns, not a status: the router's `501` (a refusal, as
    /// its `405` is) logs nothing as an error, nor does a handler's bare `501`, which the error
    /// page counts as a failure all the same; a handler's `Error::status(NOT_IMPLEMENTED)` is
    /// logged.
    #[cfg(feature = "log")]
    #[tokio::test]
    async fn a_501_status_alone_is_not_logged_as_an_error() {
        let lines = Lines(Arc::default());
        let writer = lines.clone();
        let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
        let _logging = tracing::subscriber::set_default(subscriber);
        let text = || String::from_utf8(std::mem::take(&mut *lines.0.lock().unwrap())).unwrap();
        for accept in [None, Some("application/json")] {
            let (status, _, _) = call_with(not_built(CartCount::default()), "PROPFIND", "/", None, accept).await;
            assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
            let logged = text();
            assert!(!logged.contains("ERROR") && !logged.contains("WARN"), "{accept:?}: {logged}");
        }
        let (status, _, _) = call_with(not_built(CartCount::default()), "GET", "/bare", None, None).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
        let logged = text();
        assert!(!logged.contains("ERROR") && !logged.contains("WARN"), "/bare: {logged}");
        let (status, _, _) = call_with(not_built(CartCount::default()), "GET", "/said", None, None).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
        let logged = text();
        assert!(logged.contains("ERROR") && logged.contains("corten: request failed"), "{logged}");
    }

    #[tokio::test(start_paused = true)]
    async fn the_error_page_for_a_4xx_waits_no_later_than_the_deadline() {
        let count = CartCount { delay: Duration::from_secs(60), ..CartCount::default() };
        let router = App::new(Routes::from(Table::new()))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .deadline(Duration::from_secs(2))
            .router();
        let (status, _, body) = call_with(router, "GET", "/nowhere", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "sent in time, without the count: {body}");
        assert!(body.contains("<header>Cart <b>guest</b></header>") && body.contains("<p>404</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "started for the error page");
        assert_eq!(count.finished.load(Ordering::SeqCst), 0);
    }

    /// A handler's own refusal (`Err(Refused::forbidden())?`) is the request's fault, as an
    /// extractor's is: its error page waits for the reads and draws them (#890). A 429 from it
    /// keeps its `Retry-After` and, as an extractor's 429, waits for none.
    #[tokio::test]
    async fn a_handlers_refusal_is_answered_as_an_extractors() {
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/not-yours", None, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>403</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "started once, by the route");

        let at = std::time::Instant::now();
        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let res = shop(slow, Duration::ZERO)
            .oneshot(Request::get("/handler-slows").header("accept", "text/html").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(res.headers().get("retry-after").and_then(|v| v.to_str().ok()), Some("2"));
        assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
    }

    #[tokio::test]
    async fn the_error_page_for_a_handlers_own_4xx_waits_for_none() {
        // A handler may answer a store that is down with a 4xx (a 424): what failed is likely what
        // the read needs, so the error page is not held up for it, as for a 5xx.
        let at = std::time::Instant::now();
        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let (status, _, body) = call_with(shop(slow, Duration::ZERO), "GET", "/conflict", None, None).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(!body.contains("count") && body.contains("<p>409</p>"), "{body}");
        assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
        // Plain text at a 5xx (a maintenance middleware's) is not the request's fault either.
        let at = std::time::Instant::now();
        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let (status, _, body) = call_with(shop(slow, Duration::ZERO), "GET", "/down", None, Some("text/html")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(!body.contains("count") && body.contains("<p>503</p>"), "{body}");
        assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
    }

    #[tokio::test]
    async fn the_error_page_for_a_handlers_404_or_a_refused_write_waits_for_the_reads() {
        // A handler that found nothing: an unknown address like any other.
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "GET", "/gone", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>404</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
        // A write the handler refused: the reads start once, with the error page's head.
        let count = CartCount { delay: Duration::from_millis(30), ..CartCount::default() };
        let (status, _, body) = call_with(shop(count.clone(), Duration::ZERO), "POST", "/refuse-write", None, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>403</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
    }

    /// A read whose `start` panics (it expects what a middleware puts on the head).
    struct PanicsAtStart;

    impl LayoutRead for PanicsAtStart {
        type Value = u32;

        fn start(&self, _: &http::request::Parts) -> Option<impl std::future::Future<Output = u32> + Send + 'static> {
            panic!("no tenant on the head");
            #[allow(unreachable_code)]
            Some(async { 0 })
        }

        fn view(count: &u32) -> impl Render + '_ {
            html! { <span class="tenant">{*count}</span> }
        }
    }

    #[tokio::test]
    async fn a_read_that_panics_as_it_starts_draws_nothing_on_a_page_or_an_error_page() {
        for (path, status) in [("/", StatusCode::OK), ("/nowhere", StatusCode::NOT_FOUND)] {
            let count = CartCount::default();
            let router = App::new(Routes::from(Table::new().route(
                "/",
                get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! { <p>"home"</p> } }) }),
            )))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(PanicsAtStart)
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .router();
            let (got, _, body) = call_with(router, "GET", path, None, None).await;
            assert_eq!(got, status, "{path}: {body}");
            assert!(body.contains(r#"<span class="count">3</span>"#) && !body.contains("tenant"), "{path}: {body}");
        }
    }

    #[tokio::test]
    async fn a_read_that_takes_req_does_not_lock_the_request() {
        let routes = Table::new().route(
            "/",
            get(|req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <header>{later::<Lang>()}</header>
                            <main></main>
                        </body>
                    </html>
                })
            }),
        );
        let router = App::new(Routes::from(routes)).layout_read(Lang).router();
        let (_, _, body) = tokio::time::timeout(Duration::from_secs(5), call(router, "GET", None)).await.expect("answered");
        assert!(body.contains("<i>en</i>"), "{body}");
    }

    /// The page's language, read through `Req`.
    struct Lang;

    impl LayoutRead for Lang {
        type Value = &'static str;

        fn start(
            &self,
            parts: &http::request::Parts,
        ) -> Option<impl std::future::Future<Output = &'static str> + Send + 'static> {
            let mut parts = parts.clone();
            Some(async move {
                use crate::extract::FromRequestParts;
                let req = Req::from_request_parts(&mut parts, &()).await.unwrap();
                req.lang()
            })
        }

        fn view<'a>(lang: &'a &'static str) -> impl Render + 'a {
            html! { <i>{*lang}</i> }
        }
    }

    /// A sign-out form in the header, with this request's submit key.
    struct SignOut;

    impl LayoutRead for SignOut {
        type Value = ();

        fn start(&self, _: &http::request::Parts) -> Option<impl std::future::Future<Output = ()> + Send + 'static> {
            Some(async {})
        }

        fn view(_: &()) -> impl Render + '_ {
            html! { <form method="post">{crate::SubmitKey::field(super::KeyedWrite::FIELDS.submit)}</form> }
        }
    }

    #[tokio::test]
    async fn a_view_that_draws_a_submit_key_leaves_the_page_untagged() {
        let page = |req: Req, read: bool| async move {
            req.page::<ForOne>(html! {
                <html>
                    <head>
                        <title>"Shop"</title>
                        <Corten />
                    </head>
                    <body>
                        <header>if read { {later::<SignOut>()} }</header>
                        <main></main>
                    </body>
                </html>
            })
        };
        // Marked for shared caches by hand: the key the layout draws keeps the page private.
        let public = move |req: Req, read: bool| async move {
            Ok::<_, crate::Error>((crate::cache::Cache::public(std::time::Duration::from_secs(60)), page(req, read).await?))
        };
        let routes = Table::new()
            .route("/", get(move |req: Req| page(req, true)))
            .route("/plain", get(move |req: Req| page(req, false)))
            .route("/public", get(move |req: Req| public(req, true)))
            .route("/public-plain", get(move |req: Req| public(req, false)));
        let router = App::new(Routes::from(routes)).layout_read(SignOut).router();
        // A browser's request, which names a tag it has, so it is answered with one.
        let get = |router: Router, uri: &'static str| async move {
            let req = Request::get(uri).header("accept", "text/html").header("if-none-match", "\"other\"");
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let (parts, body) = res.into_parts();
            (parts.status, parts.headers, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
        };
        let (status, headers, body) = get(router.clone(), "/").await;
        assert!(status == StatusCode::OK && body.contains("name=\"submit\""), "{body}");
        assert!(!headers.contains_key("etag"), "a key drawn by the layout makes the page unrepeatable: {headers:?}");
        let (_, headers, _) = get(router.clone(), "/plain").await;
        assert!(headers.contains_key("etag"), "{headers:?}");
        let (status, headers, body) = get(router.clone(), "/public").await;
        assert!(status == StatusCode::OK && body.contains("name=\"submit\""), "{body}");
        assert_eq!(headers["cache-control"], "private, no-cache", "a key drawn by the layout keeps the page private");
        let (_, headers, _) = get(router, "/public-plain").await;
        assert_eq!(headers["cache-control"], "public, max-age=60", "{headers:?}");
    }

    /// Middleware that puts a value on the request, as a pool's connection would be.
    #[derive(Clone)]
    struct Holds(Arc<()>);

    impl crate::Middleware for Holds {
        async fn call(&self, mut req: crate::http::Request, next: impl crate::Next) -> Response {
            req.extensions_mut().insert(self.0.clone());
            next.run(req).await
        }
    }

    #[tokio::test]
    async fn a_write_lets_go_of_the_request_whatever_it_answers() {
        let held = Arc::new(());
        let routes = Table::new()
            .route("/", get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! {} }) }))
            .route("/done", get(|| async { "done" }))
            .route(
                "/write",
                crate::router::post(|req: Req| async move { req.redirect::<ForOne>(&Done) })
                    .put(|_req: Req| async move { Err::<HtmlResponse, _>(Error::new("down")) }),
            );
        let router = App::new(Routes::from(routes))
            .layout_read(CartCount::default())
            .layout_read(SignedIn)
            .middleware(Holds(held.clone()))
            .router();
        // The middleware and this test hold it; the request must not, once answered.
        let before = Arc::strong_count(&held);
        for method in ["POST", "PUT"] {
            let (status, ..) = call_with(router.clone(), method, "/write", None, Some("text/html")).await;
            assert!(status.is_redirection() || status.is_server_error(), "{method}: {status}");
            assert_eq!(Arc::strong_count(&held), before, "{method}: the request's head is not kept after it");
        }
    }

    /// A write another site sent is refused before anything of the app's runs, so its error page
    /// draws the layout without the reads: none is started (one may look up who is asking).
    #[tokio::test]
    async fn a_cross_site_write_s_error_page_draws_the_layout_without_its_reads() {
        let count = CartCount::default();
        let req = Request::post("/")
            .header("origin", "https://evil.example")
            .header("sec-fetch-site", "cross-site")
            .header("accept", "text/html")
            .body(Body::empty())
            .unwrap();
        let res = shop(count.clone(), Duration::ZERO).oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        assert!(body.contains("<p>403</p>") && !body.contains("count") && !body.contains("corten-later"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_refused_write_draws_the_reads_and_a_slow_one_is_left_out_at_the_deadline() {
        let routes = Table::new().route(
            "/form",
            crate::router::post(|req: Req| async move { refused(&req, "too short") })
                .get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! {} }) }),
        );
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).layout_read(SignedIn).router();
        let (status, headers, body) = call_with(router, "POST", "/form", None, Some("text/html")).await;
        assert!(status.is_success() && body.contains(r#"<span class="count">3</span>"#), "{status} {body}");
        assert_eq!(headers[http::header::CACHE_CONTROL], "private, no-cache");

        let slow = CartCount { delay: Duration::from_secs(5), ..CartCount::default() };
        let routes =
            Table::new().route("/", get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! {} }) }));
        let router =
            App::new(Routes::from(routes)).deadline(Duration::from_millis(200)).layout_read(slow).layout_read(SignedIn).router();
        let began = std::time::Instant::now();
        let (status, _, body) = call(router, "GET", None).await;
        assert!(status.is_success() && !body.contains("count") && !body.contains("corten-later"), "{status} {body}");
        assert!(began.elapsed() < Duration::from_secs(2), "{:?}", began.elapsed());
    }

    /// A write the runtime sent (`corten: action`) that answers its own page answers it whole, with
    /// the layout reads its page draws and the value it gives, as it does without JavaScript, so the
    /// runtime can draw what the write changed around `<main>` (#1370). A `GET` form's page, a
    /// patch, a redirect and a refused write's error page are as they were, and start no read.
    #[tokio::test]
    async fn a_writes_own_page_in_an_action_is_whole_with_its_layout_reads() {
        let count = CartCount::default();
        let routes = Table::new()
            .route(
                "/form",
                crate::router::post(|req: Req| async move { refused(&req, "too short") })
                    .put(|req: Req| async move {
                        req.page::<ForOne>(Layout { req: &req, children: html! { <p>"given"</p> } })
                            .map(|page| page.give::<CartCount>(9))
                    })
                    .get(|req: Req| async move { refused(&req, "searched") }),
            )
            .route(
                "/patch",
                crate::router::post(|req: Req| async move {
                    req.action().ok_or_else(Error::not_found)?.patch::<ForOne, AnyAnswer>(html! { <p id={MsgId}>"saved"</p> })
                }),
            )
            .route("/away", crate::router::post(|req: Req| async move { req.redirect::<ForOne>(&Done) }))
            .route("/refused", crate::router::post(|_req: Req| async move { crate::Refused::forbidden().into_response() }));
        let router = App::new(Routes::from(routes))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .middleware(AsViewer(Some("ada")))
            .router();
        // The page, whole: the layout with the count in both its places, and no swap's header.
        let (status, headers, body) = call_with(router.clone(), "POST", "/form", Some("action"), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(!headers.contains_key("corten-page") && headers.contains_key("corten-shell"), "{headers:?}");
        assert!(body.starts_with("<!DOCTYPE html>") && body.contains("<main><p>too short</p></main>"), "{body}");
        assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#), "{body}");
        assert!(body.contains(r#"<footer><span class="count">3</span></footer>"#), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
        // A value the page gives is drawn, and its read is not started.
        let (_, _, body) = call_with(router.clone(), "PUT", "/form", Some("action"), None).await;
        assert!(body.contains(r#"<footer><span class="count">9</span></footer>"#), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
        // A `GET` form's page is a swap, as a navigation's is: a `GET` changes nothing the layout shows.
        let (_, headers, body) = call_with(router.clone(), "GET", "/form", Some("action"), None).await;
        assert!(headers.contains_key("corten-page") && !body.contains("<header>") && body.contains("<p>searched</p>"), "{body}");
        // A patch, a redirect and a refused write's error page.
        let (_, headers, _) = call_with(router.clone(), "POST", "/patch", Some("action"), None).await;
        assert!(headers.contains_key("corten-patch"), "{headers:?}");
        let (status, headers, _) = call_with(router.clone(), "POST", "/away", Some("action"), None).await;
        assert!(status == StatusCode::NO_CONTENT && headers.contains_key("corten-location"), "{status} {headers:?}");
        let (status, headers, body) = call_with(router.clone(), "POST", "/refused", Some("action"), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(headers.contains_key("corten-page") && body.contains("<p>403</p>") && !body.contains("count"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
        // A runtime that does not say it draws a write's own page whole (one from before this, in
        // a tab open across a deploy) gets `<main>` alone, as it always did, which it swaps in;
        // a whole page it would take for an answer it cannot draw. No read starts for it. Nor for
        // another value of the preference, a later one than the first, or one in another's quotes.
        for draws in [
            None,
            Some("corten-draws=main"),
            Some("corten-draws=main, corten-draws=whole"),
            Some(r#"x="corten-draws=whole""#),
            Some("corten-draws=WHOLE"),
        ] {
            let mut req = Request::builder().method("POST").uri("/form").header("corten", "action");
            if let Some(draws) = draws {
                req = req.header("prefer", draws);
            }
            let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let (parts, body) = res.into_parts();
            let body = String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap();
            assert_eq!(parts.status, StatusCode::OK, "{draws:?} {body}");
            assert!(parts.headers.contains_key("corten-page"), "{draws:?} {:?}", parts.headers);
            assert!(!body.contains("<!DOCTYPE") && !body.contains("<header>") && body.contains("<p>too short</p>"), "{body}");
            assert_eq!(count.started.load(Ordering::SeqCst), 1, "{draws:?}");
        }
    }

    /// A write the runtime sent to a route of a routes module: one whose answer type can be a page
    /// answers its own page whole, filled after the handler as the route answers, before the app's
    /// middleware sees it; one that answers patches alone (`HtmlResult<Patches>`) keeps no head
    /// (no copy of the request's extensions is made) and starts no read (#1370).
    #[tokio::test]
    async fn a_routes_module_write_fills_its_own_page_and_a_patches_route_keeps_nothing() {
        let count = CartCount::default();
        let copies = Arc::new(AtomicUsize::new(0));
        let router = App::new(shop_url::router())
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .middleware((AsViewer(Some("ada")), CountsCopies(copies.clone()), SeesFilled))
            .router();
        let (status, headers, body) = call_with(router.clone(), "POST", "/typed-write", Some("action"), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(!headers.contains_key("corten-page") && headers["x-filled"] == "yes", "{headers:?}");
        assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#), "{body}");
        assert!(body.contains("<main><p>typed write</p></main>") && !body.contains("corten-later"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
        assert!(copies.swap(0, Ordering::SeqCst) > 0, "a route whose answer can be a page keeps the head");
        let (status, headers, body) = call_with(router, "POST", "/patches-only", Some("action"), None).await;
        assert!(
            status == StatusCode::OK && headers.contains_key("corten-patch") && body.contains("patched"),
            "{headers:?} {body}"
        );
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "a patch starts no read");
        assert_eq!(copies.load(Ordering::SeqCst), 0, "a route that answers patches alone keeps no head");
    }

    struct Draws(Option<&'static str>, Option<&'static str>);

    impl crate::Middleware for Draws {
        async fn call(&self, mut req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let headers = req.headers_mut();
            if let Some(mode) = self.0 {
                headers.insert("corten", http::HeaderValue::from_static(mode));
            }
            if let Some(prefer) = self.1 {
                headers.insert("prefer", http::HeaderValue::from_static(prefer));
            } else {
                headers.remove("prefer");
            }
            next.run(req).await
        }
    }

    #[tokio::test]
    async fn a_writes_page_honors_the_mode_and_preference_left_by_middleware() {
        async fn page(req: Req) -> HtmlResult {
            req.page(Shell { req: &req, title: "Write", head: (), children: html! { <p>"write answer"</p> } })
        }

        for (mode, prefer) in [(None, None), (None, Some("corten-draws=main")), (Some("nav"), Some("corten-draws=whole"))] {
            let routes = Table::new().route("/", crate::router::post(page));
            let router = App::new(Routes::from(routes)).middleware(Draws(mode, prefer)).router();
            let (status, headers, body) = call(router, "POST", Some("action")).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert!(headers.contains_key("corten-page"), "{mode:?} {prefer:?} {headers:?}");
            assert!(!body.contains("<!DOCTYPE") && body.contains("<p>write answer</p>"), "{body}");
        }

        let count = CartCount::default();
        let router =
            App::new(shop_url::router()).layout_read(count.clone()).layout_read(SignedIn).middleware(Draws(None, None)).router();
        let (status, headers, body) = call_with(router, "POST", "/typed-write", Some("action"), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            headers.contains_key("corten-page") && !body.contains("<header>") && body.contains("<p>typed write</p>"),
            "{headers:?} {body}"
        );
        assert_eq!(count.started.load(Ordering::SeqCst), 0);

        let router = App::new(shop_url::router())
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .middleware((Draws(None, Some("corten-draws=whole")), SeesFilled))
            .router();
        let req = Request::post("/typed-write").header("corten", "action").body(Body::empty()).unwrap();
        let res = router.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(!res.headers().contains_key("corten-page") && res.headers()["x-filled"] == "yes");
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = std::str::from_utf8(&bytes).unwrap();
        assert!(body.contains(r#"<footer><span class="count">3</span></footer>"#), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);

        let router = App::new(shop_url::router())
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .middleware(Draws(Some("page"), None))
            .router();
        let (status, headers, body) = call_with(router, "POST", "/typed-write", Some("action"), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(!headers.contains_key("corten-page") && body.contains(r#"<footer><span class="count">3</span></footer>"#));
        assert_eq!(count.started.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_writes_document_override_fills_the_layout_after_middleware_removes_the_preference() {
        let table = Table::new().route("/document-write", crate::router::post(document_write));
        for routes in [shop_url::router(), Routes::from(table)] {
            let count = CartCount::default();
            let router = App::new(routes).layout_read(count.clone()).layout_read(SignedIn).middleware(Draws(None, None)).router();
            let (status, headers, body) = call_with(router, "POST", "/document-write", Some("action"), None).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert!(!headers.contains_key("corten-page") && body.starts_with("<!DOCTYPE html>"), "{headers:?} {body}");
            assert!(body.contains("<main><p>document write</p></main>"), "{body}");
            assert!(body.contains(r#"<footer><span class="count">3</span></footer>"#), "{body}");
            assert_eq!(count.started.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn middleware_replaces_a_generic_patch_with_a_whole_page() {
        middleware_replaces_a_patch("/any-patch").await;
    }

    #[tokio::test]
    async fn middleware_replaces_a_typed_patch_with_a_whole_page() {
        middleware_replaces_a_patch("/patches-only").await;
    }

    async fn middleware_replaces_a_patch(uri: &str) {
        struct ReplacesPatch;

        impl crate::Middleware for ReplacesPatch {
            async fn call(&self, req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
                use crate::extract::FromRequestParts;
                let (mut original, body) = req.into_parts();
                let mut forwarded = original.clone();
                forwarded.headers.remove("prefer");
                let patch = next.run(Request::from_parts(forwarded, body)).await;
                assert_eq!(patch.status(), StatusCode::OK);
                assert!(patch.headers().contains_key("corten-patch") && !patch.headers().contains_key("x-draws-whole"));
                let req = Req::from_request_parts(&mut original, &()).await.unwrap();
                refused(&req, "replacement").into_response()
            }
        }

        let count = CartCount::default();
        let router = App::new(shop_url::router())
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .middleware((AsViewer(Some("ada")), ReplacesPatch))
            .router();
        let (status, headers, body) = call_with(router, "POST", uri, Some("action"), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(!headers.contains_key("corten-page") && !headers.contains_key("corten-patch"), "{headers:?}");
        assert!(body.contains("<main><p>replacement</p></main>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "{body}");
        assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#), "{body}");
    }

    #[tokio::test]
    async fn a_write_forwarded_to_another_router_fills_its_layout_once() {
        #[crate::routes(state = crate::Router)]
        mod forward_url {
            #[route("/typed-write", post = forward)]
            pub struct Forward;
        }

        #[crate::routes]
        mod destination_url {
            #[route("/typed-write", post = page)]
            pub struct Destination;
        }

        async fn forward(crate::extract::State(inner): crate::extract::State<Router>, req: crate::http::Request) -> crate::Relay {
            let (parts, body) = inner.oneshot(req).await.unwrap().into_parts();
            crate::Relay::new(parts.status, parts.headers, body)
        }

        async fn page(req: Req) -> HtmlResult {
            req.page(html! {
                <html>
                    <head>
                        <title>"Shop"</title>
                        <Corten />
                    </head>
                    <body>
                        <header>{later::<CartCount>()}</header>
                        <main>"typed write"</main>
                    </body>
                </html>
            })
        }

        for deadline in [None, Some(Duration::from_secs(2))] {
            let outer_count = CartCount::default();
            let inner_count = CartCount::default();
            let inner = App::new(destination_url::router()).layout_read(inner_count.clone()).deadline(deadline).router();
            let outer =
                App::new(forward_url::router(inner)).layout_read(outer_count.clone()).middleware(AsViewer(Some("ada"))).router();
            let (status, headers, body) = call_with(outer, "POST", "/typed-write", Some("action"), None).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert!(!headers.contains_key("corten-page") && headers.contains_key("corten-shell"), "{headers:?}");
            assert!(body.contains(r#"<header><span class="count">3</span></header>"#), "{body}");
            assert_eq!(inner_count.started.load(Ordering::SeqCst), 1);
            assert_eq!(outer_count.started.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_write_forwarded_to_a_fallback_without_a_deadline_can_time_out_in_the_outer_app() {
        for outer_reads in [false, true] {
            let (status, _, body) = forward_slow_write(outer_reads, Duration::from_secs(1), None).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
            assert!(body.contains("Not available"), "{body}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_write_forwarded_to_a_fallback_uses_an_earlier_inner_layout_deadline() {
        let (status, headers, body) = forward_slow_write(true, Duration::from_secs(3), Some(Duration::from_secs(1))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(!headers.contains_key("corten-page") && headers.contains_key("corten-shell"), "{headers:?}");
        assert!(body.contains("<main><p>typed write</p></main>") && body.contains("<footer></footer>"), "{body}");
        assert!(body.contains("<header>Cart <b>guest</b></header>"), "{body}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_forwarded_write_uses_the_inner_layout_deadline_for_a_page_from_middleware() {
        let count = CartCount { delay: Duration::from_secs(2), ..CartCount::default() };
        let inner = App::new(early_middleware_url::router())
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .middleware(AnswersEarly)
            .deadline(Duration::from_secs(1))
            .router();
        let outer = App::new(Routes::from(Table::new())).middleware(Fallback(inner)).deadline(Duration::from_secs(3)).router();
        let (status, _, body) = call_with(outer, "POST", "/early", Some("action"), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains("<main><p>early</p></main>") && body.contains("<footer></footer>"), "{body}");
        assert!(body.contains("<header>Cart <b>guest</b></header>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
        assert_eq!(count.finished.load(Ordering::SeqCst), 0);
    }

    struct Fallback(Router);

    impl crate::Middleware for Fallback {
        async fn call(&self, req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let (head, body) = req.into_parts();
            let res = next.run(Request::from_parts(head.clone(), Body::empty())).await;
            assert_eq!(res.status(), StatusCode::NOT_FOUND);
            self.0.clone().oneshot(Request::from_parts(head, body)).await.unwrap()
        }
    }

    async fn forward_slow_write(
        outer_reads: bool,
        outer_deadline: Duration,
        inner_deadline: Option<Duration>,
    ) -> (StatusCode, http::HeaderMap, String) {
        let outer_count = CartCount::default();
        let inner_count = CartCount { delay: Duration::from_secs(2), ..CartCount::default() };
        let inner =
            App::new(shop_url::router()).layout_read(inner_count.clone()).layout_read(SignedIn).deadline(inner_deadline).router();
        let outer = App::new(Routes::from(Table::new()));
        let outer = if outer_reads { outer.layout_read(outer_count.clone()) } else { outer };
        let outer = outer.middleware(Fallback(inner)).deadline(outer_deadline).router();
        let (status, headers, body) = call_with(outer, "POST", "/typed-write", Some("action"), None).await;
        assert_eq!(inner_count.started.load(Ordering::SeqCst), 1);
        assert_eq!(inner_count.finished.load(Ordering::SeqCst), 0);
        assert_eq!(outer_count.started.load(Ordering::SeqCst), 0);
        (status, headers, body)
    }

    #[tokio::test(start_paused = true)]
    async fn copied_extensions_do_not_cap_an_independent_writes_layout_deadline() {
        writes_with_retained_heads(false).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_replayed_head_does_not_inherit_a_finished_writes_layout_state() {
        writes_with_retained_heads(true).await;
    }

    async fn writes_with_retained_heads(replay: bool) {
        type SendHead = tokio::sync::oneshot::Sender<http::request::Parts>;
        type Retain = Arc<std::sync::Mutex<Option<SendHead>>>;

        #[crate::routes(state = Retain)]
        mod retain_url {
            #[route("/typed-write", post = retain)]
            pub struct RetainsHead;
        }

        async fn retain(crate::extract::State(send): crate::extract::State<Retain>, req: crate::http::Request) -> HtmlResult {
            send.lock().unwrap().take().unwrap().send(req.into_parts().0).unwrap();
            tokio::time::sleep(Duration::from_millis(500)).await;
            Err(crate::Error::not_found())
        }

        let (send, head) = tokio::sync::oneshot::channel();
        let original = App::new(retain_url::router(Arc::new(std::sync::Mutex::new(Some(send)))))
            .layout_read(CartCount::default())
            .deadline(Duration::from_secs(1))
            .router();
        let original = tokio::spawn(call_with(original, "POST", "/typed-write", Some("action"), None));
        let head = head.await.unwrap();
        assert!(crate::layout::LateWrite::reached(&head.extensions));

        let count = CartCount { delay: Duration::from_secs(2), ..CartCount::default() };
        let router = App::new(shop_url::router())
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .deadline(if replay { None } else { Some(Duration::from_secs(3)) })
            .router();
        let res = if replay {
            assert_eq!(original.await.unwrap().0, StatusCode::NOT_FOUND);
            router.oneshot(Request::from_parts(head, Body::empty())).await.unwrap()
        } else {
            let mut req = Request::post("/typed-write")
                .header("corten", "action")
                .header("prefer", "corten-draws=whole")
                .body(Body::empty())
                .unwrap();
            *req.extensions_mut() = head.extensions.clone();
            let independent = tokio::spawn(router.oneshot(req));
            assert_eq!(original.await.unwrap().0, StatusCode::NOT_FOUND);
            assert_eq!(count.started.load(Ordering::SeqCst), 1);
            assert_eq!(count.finished.load(Ordering::SeqCst), 0);
            independent.await.unwrap().unwrap()
        };
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = std::str::from_utf8(&bytes).unwrap();
        assert!(body.contains(r#"<footer><span class="count">3</span></footer>"#), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
        assert_eq!(count.finished.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_patch_only_write_without_middleware_does_not_negotiate_a_whole_answer() {
        let count = CartCount::default();
        let app = App::new(shop_url::router());
        for router in [app.router(), App::new(shop_url::router()).layout_read(count.clone()).router()] {
            for uri in ["/patches-only", "/named-patches", "/named-patches?do=save", "/named-patches?do=remove"] {
                let (status, headers, body) = call_with(router.clone(), "POST", uri, Some("action"), None).await;
                assert_eq!(status, StatusCode::OK, "{uri}: {body}");
                assert!(headers.contains_key("corten-patch") && !headers.contains_key("x-draws-whole"), "{uri}: {headers:?}");
            }
        }
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    /// An extension that counts its copies: a request's head kept with its extensions copies it.
    struct Copied(Arc<AtomicUsize>);

    impl Clone for Copied {
        fn clone(&self) -> Self {
            self.0.fetch_add(1, Ordering::SeqCst);
            Copied(self.0.clone())
        }
    }

    /// The app's middleware, putting [`Copied`] in each request.
    struct CountsCopies(Arc<AtomicUsize>);

    impl crate::Middleware for CountsCopies {
        async fn call(&self, mut req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
            req.extensions_mut().insert(Copied(self.0.clone()));
            next.run(req).await
        }
    }

    /// The app's middleware, saying whether the page the route answered was filled by the time it
    /// sees it (`x-filled`): no place for a layout read is left in it.
    struct SeesFilled;

    impl crate::Middleware for SeesFilled {
        async fn call(&self, req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let (mut head, body) = next.run(req).await.into_parts();
            let bytes = body.collect().await.unwrap().to_bytes();
            let filled = !String::from_utf8_lossy(&bytes).contains("corten-later");
            head.headers.insert("x-filled", http::HeaderValue::from_static(if filled { "yes" } else { "no" }));
            crate::response::Response::from_parts(head, Body::from(bytes))
        }
    }

    /// The app's middleware, answering `/early` with a page of its own made with `Req`, before the
    /// route (a sign-in page in the route's place).
    struct AnswersEarly;

    impl crate::Middleware for AnswersEarly {
        async fn call(&self, req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
            if req.uri().path() != "/early" {
                return next.run(req).await;
            }
            use crate::extract::FromRequestParts;
            let (mut parts, _) = req.into_parts();
            let req = Req::from_request_parts(&mut parts, &()).await.unwrap();
            refused(&req, "early").into_response()
        }
    }

    #[crate::routes]
    mod early_middleware_url {
        #[route("/early", post = patches_only)]
        pub struct Early;

        #[route("/patch", post = patches_only)]
        pub struct Patch;
    }

    /// A page the app's middleware makes with `Req` before a write's route draws the layout's
    /// values, from the head the middleware had (the viewer it added), with JavaScript as without
    /// (#1370); a patch in the same app starts no read.
    #[tokio::test]
    async fn a_page_middleware_makes_for_a_write_draws_its_layout_reads() {
        let count = CartCount::default();
        let router = App::new(early_middleware_url::router())
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .middleware((AsViewer(Some("ada")), AnswersEarly))
            .router();
        for (n, mode) in [None, Some("action")].into_iter().enumerate() {
            let (status, headers, body) = call_with(router.clone(), "POST", "/early", mode, None).await;
            assert_eq!(status, StatusCode::OK, "{mode:?} {body}");
            assert!(!headers.contains_key("corten-page"), "{mode:?} {headers:?}");
            assert!(body.contains("<main><p>early</p></main>"), "{mode:?} {body}");
            assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#), "{mode:?} {body}");
            assert!(
                body.contains(r#"<footer><span class="count">3</span></footer>"#) && !body.contains("corten-later"),
                "{mode:?} {body}"
            );
            assert_eq!(count.started.load(Ordering::SeqCst), n + 1, "{mode:?}");
        }
        let (_, headers, body) = call_with(router, "POST", "/patch", Some("action"), None).await;
        assert!(headers.contains_key("corten-patch") && body.contains("patched"), "{headers:?} {body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 2, "a patch starts no read");
    }

    /// Counts a request as dropped only after every copy of its head is gone.
    struct TrackedRequest(Arc<AtomicUsize>);

    impl Drop for TrackedRequest {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[derive(Clone)]
    struct Alive {
        _held: Arc<TrackedRequest>,
    }

    struct Tracks {
        dropped: Arc<AtomicUsize>,
        parked: Arc<tokio::sync::Notify>,
    }

    impl crate::Middleware for Tracks {
        async fn call(&self, mut req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
            req.extensions_mut().insert(Alive { _held: Arc::new(TrackedRequest(self.dropped.clone())) });
            if req.uri().path() == "/early" {
                return next.run(req).await;
            }
            use crate::extract::FromRequestParts;
            let (mut parts, body) = req.into_parts();
            let taken = Req::from_request_parts(&mut parts, &()).await.unwrap();
            drop(taken);
            match parts.uri.path() {
                "/panic" => panic!("middleware panicked after taking Req"),
                "/parked" => {
                    self.parked.notify_one();
                    std::future::pending::<()>().await;
                }
                _ => {}
            }
            next.run(crate::http::Request::from_parts(parts, body)).await
        }
    }

    /// The head a `Req` taken before a write's route keeps for a page made with it is let go
    /// when the request is answered, or dropped unanswered: nothing of the request outlives it,
    /// whether the middleware made the page, passed on to a patch, or the request was cut off
    /// (#1370).
    #[tokio::test]
    async fn the_head_a_req_keeps_before_a_writes_route_goes_with_the_request() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let parked = Arc::new(tokio::sync::Notify::new());
        let drops = || dropped.load(Ordering::SeqCst);
        let routes = Table::new()
            .route("/early", crate::router::post(|req: Req| async move { refused(&req, "the route") }))
            .route(
                "/passes",
                crate::router::post(|req: Req| async move {
                    req.action().ok_or_else(Error::not_found)?.patch::<ForOne, AnyAnswer>(html! { <p id={MsgId}>"saved"</p> })
                }),
            )
            .route("/panic", crate::router::post(|| async { StatusCode::OK }))
            .route("/parked", crate::router::post(|| async { StatusCode::OK }));
        let router = App::new(Routes::from(routes))
            .layout_read(CartCount::default())
            .layout_read(SignedIn)
            .middleware((Tracks { dropped: dropped.clone(), parked: parked.clone() }, AnswersEarly))
            .router();
        let (status, _, body) = call_with(router.clone(), "POST", "/early", Some("action"), None).await;
        assert!(status.is_success() && body.contains("<p>early</p>") && body.contains("count"), "{body}");
        assert_eq!(drops(), 1, "middleware answered with its own page");
        let (_, headers, body) = call_with(router.clone(), "POST", "/passes", Some("action"), None).await;
        assert!(headers.contains_key("corten-patch") && body.contains("saved"), "{headers:?} {body}");
        assert_eq!(drops(), 2, "middleware passed on to the patch route");
        let (status, _, _) = call_with(router.clone(), "POST", "/panic", Some("action"), None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(drops(), 3, "middleware panicked, caught by the app");
        {
            let mut cut = std::pin::pin!(call_with(router.clone(), "POST", "/parked", Some("action"), None));
            tokio::select! {
                _ = &mut cut => panic!("answered before getting parked in middleware"),
                reached = tokio::time::timeout(Duration::from_secs(5), parked.notified()) => reached.unwrap(),
            }
            assert_eq!(drops(), 3, "still parked in middleware");
        }
        assert_eq!(drops(), 4, "dropped while parked in middleware");
    }

    /// A detached extractor can see the early mark, then be parked in an extension's clone
    /// until the request has closed its slot and released the heads.
    #[tokio::test]
    async fn a_detached_req_cannot_publish_an_early_head_after_its_request_ends() {
        use crate::extract::FromRequestParts;
        use std::sync::mpsc;
        use tokio::sync::oneshot;

        struct ParkClone {
            reached: Arc<tokio::sync::Notify>,
            resume: Arc<std::sync::Mutex<Option<mpsc::Receiver<()>>>>,
        }

        impl Clone for ParkClone {
            fn clone(&self) -> Self {
                let resume = self.resume.lock().unwrap().take();
                if let Some(resume) = resume {
                    self.reached.notify_one();
                    resume.recv().unwrap();
                }
                Self { reached: self.reached.clone(), resume: self.resume.clone() }
            }
        }

        struct Detaches {
            dropped: Arc<AtomicUsize>,
            resume: Arc<std::sync::Mutex<Option<mpsc::Receiver<()>>>>,
            task: std::sync::Mutex<Option<oneshot::Sender<tokio::task::JoinHandle<()>>>>,
        }

        impl crate::Middleware for Detaches {
            async fn call(&self, req: crate::http::Request, _: impl crate::middleware::Next) -> crate::response::Response {
                let (mut parts, _) = req.into_parts();
                let reached = Arc::new(tokio::sync::Notify::new());
                parts.extensions.insert(Alive { _held: Arc::new(TrackedRequest(self.dropped.clone())) });
                parts.extensions.insert(ParkClone { reached: reached.clone(), resume: self.resume.clone() });
                let runtime = tokio::runtime::Handle::current();
                let task = tokio::task::spawn_blocking(move || {
                    runtime.block_on(Req::from_request_parts(&mut parts, &())).unwrap();
                });
                self.task.lock().unwrap().take().unwrap().send(task).unwrap();
                tokio::time::timeout(Duration::from_secs(5), reached.notified()).await.unwrap();
                StatusCode::NO_CONTENT.into_response()
            }
        }

        let dropped = Arc::new(AtomicUsize::new(0));
        let (resume, waiting) = mpsc::channel();
        let (task, running) = oneshot::channel();
        let routes = Table::new().route("/", crate::router::post(|| async { StatusCode::OK }));
        let router = App::new(Routes::from(routes))
            .layout_read(CartCount::default())
            .middleware(Detaches {
                dropped: dropped.clone(),
                resume: Arc::new(std::sync::Mutex::new(Some(waiting))),
                task: std::sync::Mutex::new(Some(task)),
            })
            .router();
        let (status, _, _) = call_with(router, "POST", "/", Some("action"), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(dropped.load(Ordering::SeqCst), 0, "detached extraction still owns the head");
        resume.send(()).unwrap();
        running.await.unwrap().await.unwrap();
        assert_eq!(dropped.load(Ordering::SeqCst), 1, "no head was published after cleanup");
    }

    /// [`AnswersEarly`]'s page with a body that never ends, or one that fails as it is read.
    struct AnswersEarlyBroken {
        fails: bool,
    }

    impl crate::Middleware for AnswersEarlyBroken {
        async fn call(&self, req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
            if req.uri().path() != "/early" {
                return next.run(req).await;
            }
            use crate::extract::FromRequestParts;
            let (mut parts, _) = req.into_parts();
            let req = Req::from_request_parts(&mut parts, &()).await.unwrap();
            let (head, _) = refused(&req, "early").into_response().into_parts();
            let body = if self.fails {
                Body::from_stream(futures_util::stream::iter([Err::<bytes::Bytes, _>(std::io::Error::other("cut off"))]))
            } else {
                Body::from_stream(futures_util::stream::pending::<Result<bytes::Bytes, std::io::Error>>())
            };
            crate::response::Response::from_parts(head, body)
        }
    }

    /// A page the app's middleware makes for a write the runtime sent is filled under the request's
    /// deadline, and a failure to fill it gets the app's error page, as the route's own page does
    /// (#1370).
    #[tokio::test]
    async fn a_page_middleware_makes_for_a_write_is_filled_within_the_deadline_and_its_failure_gets_the_error_page() {
        for fails in [false, true] {
            let routes = Table::new().route("/early", crate::router::post(|req: Req| async move { refused(&req, "the route") }));
            let router = App::new(Routes::from(routes))
                .deadline(Duration::from_millis(20))
                .error_page(
                    |failure: Failure, req: Req| async move {
                        req.page::<ForOne>(Layout { req: &req, children: html! { <p>"failed "{failure.status().as_u16()}</p> } })
                    },
                    (),
                )
                .layout_read(CartCount::default())
                .layout_read(SignedIn)
                .middleware((AsViewer(Some("ada")), AnswersEarlyBroken { fails }))
                .router();
            let answer = call_with(router, "POST", "/early", Some("action"), None);
            let Ok((status, _, body)) = tokio::time::timeout(Duration::from_secs(2), answer).await else {
                panic!("fails {fails}: not answered at the deadline");
            };
            let expected = if fails { 500 } else { 503 };
            assert_eq!(status.as_u16(), expected, "fails {fails}: {body}");
            assert!(body.contains(&format!("<p>failed {expected}</p>")), "fails {fails}: {body}");
        }
    }

    #[tokio::test]
    async fn a_public_answer_draws_no_ones_value_whatever_started_the_read() {
        // A route of Corten's own takes `Req`, which starts the reads before its answer is known.
        let routes = Table::new().route("/", get(for_all).post(for_all));
        let count = CartCount::default();
        let router = App::new(Routes::from(routes)).layout_read(count.clone()).layout_read(SignedIn).router();
        let (status, headers, body) = call(router.clone(), "GET", None).await;
        assert!(status.is_success() && !body.contains("count") && !body.contains("corten-later"), "{body}");
        assert!(headers[http::header::CACHE_CONTROL].to_str().unwrap().starts_with("public"), "{headers:?}");
        // A write's own page in an action, whose reads would start after the handler (#1370).
        let (status, _, body) = call_with(router, "POST", "/", Some("action"), None).await;
        assert!(status.is_success() && body.contains("<header>") && !body.contains("count"), "{body}");
        assert!(!body.contains("corten-later"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1, "only the GET's route of Corten's own started it");
    }

    /// A count whose view panics.
    struct BrokenView;

    /// What [`BrokenView`] draws: it panics as it renders, counted in [`EXPLODED`].
    struct Explodes;

    static EXPLODED: AtomicUsize = AtomicUsize::new(0);

    impl Render for Explodes {
        fn render(&self, _: &mut String) {
            EXPLODED.fetch_add(1, Ordering::SeqCst);
            panic!("the view broke")
        }
    }

    impl LayoutRead for BrokenView {
        type Value = u32;

        fn start(&self, _: &http::request::Parts) -> Option<impl std::future::Future<Output = u32> + Send + 'static> {
            Some(async { 1 })
        }

        fn view(_: &u32) -> impl Render + '_ {
            Explodes
        }
    }

    #[tokio::test]
    async fn a_view_that_panics_draws_nothing_on_the_error_page_too() {
        let page = |req: &Req, children: &'static str| {
            req.page::<ForOne>(html! {
                <html>
                    <head>
                        <title>"Shop"</title>
                        <Corten />
                    </head>
                    <body>
                        <header>{later::<BrokenView>()}</header>
                        <main>{children}</main>
                    </body>
                </html>
            })
        };
        let routes = Table::new()
            .route("/", get(move |req: Req| async move { page(&req, "home") }))
            // Takes `Req`, so the read starts and is in by the time the error page draws it.
            .route("/fails", get(|_req: Req| async { Err::<HtmlResponse, _>(Error::new("down")) }));
        let router = App::new(Routes::from(routes))
            .error_page(move |_: Failure, req: Req| async move { page(&req, "failed") }, ())
            .layout_read(BrokenView)
            .router();
        let (status, _, body) = call(router.clone(), "GET", None).await;
        assert!(status.is_success() && body.contains("<header></header>"), "{status} {body}");
        assert_eq!(EXPLODED.load(Ordering::SeqCst), 1);
        let (status, _, body) = call_with(router, "GET", "/fails", None, Some("text/html")).await;
        assert_eq!(EXPLODED.load(Ordering::SeqCst), 2, "the error page drew the view: {body}");
        assert!(status.is_server_error() && body.contains("failed") && body.contains("<header></header>"), "{status} {body}");
    }

    /// A badge that renders its count through a string of its own.
    #[crate::component]
    fn Badge() -> impl Render {
        crate::raw(later::<CartCount>().to_html())
    }

    #[tokio::test]
    async fn a_place_rendered_through_a_string_of_its_own_is_filled_where_it_is() {
        let routes = Table::new().route(
            "/",
            get(|req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <nav>{crate::raw("<!--corten-later-0-->")}</nav>
                            <header><Badge /></header>
                            <main></main>
                        </body>
                    </html>
                })
            }),
        );
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).router();
        let (status, _, body) = call(router, "GET", None).await;
        assert!(status.is_success(), "{status} {body}");
        assert!(body.contains(r#"<header><span class="count">3</span></header>"#), "{body}");
        assert!(body.contains("<nav><!--corten-later-0--></nav>"), "text the page wrote is left alone: {body}");
    }

    /// A badge that writes its place's string twice.
    #[crate::component]
    fn TwoBadges() -> impl Render {
        let place = later::<CartCount>().to_html();
        crate::raw(format!("{place}|{place}"))
    }

    /// A badge that writes its place's string as text, escaped.
    #[crate::component]
    fn TextBadge() -> impl Render {
        later::<CartCount>().to_html()
    }

    /// In a debug build, a place written twice or as text is an error naming it, rather than one
    /// copy drawn and the other sent (holding the page's token).
    // A debug build's check.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_place_written_twice_or_as_text_is_an_error() {
        let page = |req: Req, twice: bool| async move {
            req.page::<ForOne>(html! {
                <html>
                    <head>
                        <title>"Shop"</title>
                        <Corten />
                    </head>
                    <body>
                        <header>
                            if twice {
                                <TwoBadges />
                            } else {
                                <TextBadge />
                            }
                        </header>
                        <main></main>
                    </body>
                </html>
            })
        };
        let routes = Table::new()
            .route("/twice", get(move |req: Req| page(req, true)))
            .route("/text", get(move |req: Req| page(req, false)));
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).router();
        // The log names the read and says which (`more than once`, `as text`).
        for path in ["/twice", "/text"] {
            let (status, _, body) = call_with(router.clone(), "GET", path, None, None).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{path}: {body}");
            assert!(!body.contains("corten-later"), "{path}: {body}");
        }
    }

    // A debug build's check.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_place_in_the_head_is_an_error() {
        let routes = Table::new().route(
            "/",
            get(|req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop "{later::<CartCount>()}</title>
                            <Corten />
                        </head>
                        <body><main></main></body>
                    </html>
                })
            }),
        );
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).router();
        let (status, _, body) = call(router, "GET", None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    }

    #[tokio::test]
    async fn a_read_that_looks_up_the_caller_makes_the_page_private_and_keeps_the_key_a_navigation_gets() {
        let (_, headers, ada) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/who", None, None).await;
        assert!(ada.contains("<b>ada</b>"), "{ada}");
        assert_eq!(headers["corten-shell"], meta_content(&ada, "corten-shell"), "the header and the document agree");
        assert_eq!(headers[http::header::CACHE_CONTROL], "private, no-cache");
        // A navigation does not start the read, so the read's caller is not in the key: the same
        // key, so the runtime swaps the next page in rather than loading it in full.
        let (_, nav, _) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/who", Some("nav"), None).await;
        assert_eq!(nav["corten-shell"], headers["corten-shell"]);
        // A handler that takes the caller keys both by it, whoever looked it up first.
        let (_, doc, _) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/mine", None, None).await;
        let (_, nav, _) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/mine", Some("nav"), None).await;
        assert_eq!(doc["corten-shell"], nav["corten-shell"]);
        assert_ne!(doc["corten-shell"], headers["corten-shell"], "keyed by the caller the handler read");
    }

    #[tokio::test]
    async fn only_a_page_route_s_get_starts_the_reads() {
        let count = CartCount::default();
        for (method, uri) in [("POST", "/"), ("GET", "/health/live"), ("HEAD", "/"), ("GET", "/public"), ("GET", "/text")] {
            let (status, headers, body) = call_with(shop(count.clone(), Duration::ZERO), method, uri, None, None).await;
            assert!(status.is_success() || status.is_redirection(), "{method} {uri}: {status} {body}");
            assert!(!body.contains("corten-later"), "{method} {uri}: {body}");
            if uri == "/public" {
                assert!(body.contains("<header>Cart </header>"), "a Public page draws no one's count: {body}");
                assert!(headers[http::header::CACHE_CONTROL].to_str().unwrap().starts_with("public"), "{headers:?}");
            }
        }
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    /// A `Public` page in an app with layout reads is kept as it was filled: no one's values, and
    /// the next request gets it without a read started.
    #[tokio::test]
    async fn a_public_page_is_kept_filled_in_an_app_with_layout_reads() {
        let count = CartCount::default();
        let router = shop(count.clone(), Duration::ZERO);
        let (_, first, body) = call_with(router.clone(), "GET", "/public", None, None).await;
        let (_, again, same) = call_with(router, "GET", "/public", None, None).await;
        assert!(!first.contains_key(http::header::AGE) && again.contains_key(http::header::AGE), "{again:?}");
        assert!(same == body && body.contains("<header>Cart </header>") && !body.contains("corten-later"), "{same}");
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    /// A `Public` text answer in such an app has no places: it is kept as its handler gave it
    /// and starts no read.
    #[tokio::test]
    async fn a_public_body_is_kept_in_an_app_with_layout_reads() {
        let count = CartCount::default();
        let words = || async { crate::Public::new(Duration::from_secs(60), "plain words ".repeat(100)) };
        let routes = Table::new().route("/words", crate::route::get(words).0);
        let router = App::new(Routes::from(routes)).layout_read(count.clone()).router();
        let (_, first, body) = call_with(router.clone(), "GET", "/words", None, None).await;
        let (_, again, same) = call_with(router, "GET", "/words", None, None).await;
        assert!(!first.contains_key(http::header::AGE), "{first:?}");
        assert!(again.contains_key(http::header::AGE), "{again:?}");
        assert!(same == body && body == "plain words ".repeat(100), "{same}");
        assert_eq!(count.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn the_page_is_filled_before_the_app_s_middleware_sees_it() {
        let routes = Table::new().route(
            "/",
            get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! { <p>"home"</p> } }) }),
        );
        let router = App::new(Routes::from(routes))
            .layout_read(CartCount::default())
            .layout_read(SignedIn)
            .middleware((AsViewer(Some("ada")), Rebuild))
            .router();
        let (_, _, body) = call(router, "GET", None).await;
        assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>ada</b></header>"#), "{body}");
    }

    /// Answers with a copy of the response, as a middleware that rewrites the body does.
    struct Rebuild;

    impl crate::Middleware for Rebuild {
        async fn call(&self, req: crate::http::Request, next: impl crate::Next) -> Response {
            let (head, body) = next.run(req).await.into_parts();
            let bytes = body.collect().await.unwrap().to_bytes();
            let mut res = Response::new(Body::from(bytes));
            *res.status_mut() = head.status;
            *res.headers_mut() = head.headers;
            res
        }
    }

    /// A share of the cart's limit, as a meter: a view with a `style={..}` value.
    struct CartFill;

    impl LayoutRead for CartFill {
        type Value = f64;

        fn start(&self, _: &http::request::Parts) -> Option<impl std::future::Future<Output = f64> + Send + 'static> {
            Some(async { 40.0 })
        }

        fn view(used: &f64) -> impl Render + '_ {
            html! { <super::TestMeter used={*used} /> }
        }
    }

    #[tokio::test]
    async fn a_view_that_needs_the_page_s_head_draws_nothing() {
        let routes = Table::new().route(
            "/",
            get(|req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <header>"Cart "{later::<CartFill>()}</header>
                            <main></main>
                        </body>
                    </html>
                })
            }),
        );
        let router = App::new(Routes::from(routes)).components(&[super::TestMeter]).layout_read(CartFill).router();
        let (status, _, body) = call(router, "GET", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("<header>Cart </header>") && !body.contains("test-meter__fill"), "{body}");
    }

    #[tokio::test]
    async fn a_mark_the_page_wrote_as_text_is_left_alone() {
        let routes = Table::new().route(
            "/",
            get(
                |req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: crate::raw("<!--corten-later-0-->") }) },
            ),
        );
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).layout_read(SignedIn).router();
        let (_, _, body) = call(router, "GET", None).await;
        assert!(body.contains("<main><!--corten-later-0--></main>"), "{body}");
        assert!(body.contains(r#"<header>Cart <span class="count">3</span><b>guest</b></header>"#), "{body}");
    }

    /// A cart count whose store fails.
    struct Broken;

    impl LayoutRead for Broken {
        type Value = u32;

        fn start(&self, _: &http::request::Parts) -> Option<impl std::future::Future<Output = u32> + Send + 'static> {
            Some(async { panic!("the cart store") })
        }

        fn view(count: &u32) -> impl Render + '_ {
            html! { <span class="count">{*count}</span> }
        }
    }

    #[tokio::test]
    async fn a_read_that_panics_draws_nothing_and_the_page_is_sent() {
        let routes = Table::new().route(
            "/",
            get(|req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <header>"Cart "{later::<Broken>()}</header>
                            <main><p>"home"</p></main>
                        </body>
                    </html>
                })
            }),
        );
        let router = App::new(Routes::from(routes)).layout_read(Broken).router();
        let (status, _, body) = call(router, "GET", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("<header>Cart </header>") && body.contains("<p>home</p>"), "{body}");
    }

    // A debug build's check.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_place_for_a_read_the_app_does_not_start_or_inside_main_is_an_error() {
        let (status, _, body) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/unread", None, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        // Inside `<main>`: a navigation sends it, and so does a full load, where it would be drawn.
        for mode in [Some("nav"), None] {
            let (status, _, body) = call_with(shop(CartCount::default(), Duration::ZERO), "GET", "/inside", mode, None).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{mode:?}: {body}");
        }
        // A custom element named `main-..` before it is not `<main>`, and a place after markup of
        // the page's own that has a `<main>` (written raw) is not inside it. (The check takes the
        // first `<main>` tag in the text, so raw markup with one can mislead it on a full load; a
        // navigation's check, where every place is inside `<main>`, still says so.)
        let page = |before: &'static str, in_header: bool| {
            get(move |req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <header>
                                {crate::raw(before)}
                                if in_header {
                                    {later::<CartCount>()}
                                }
                            </header>
                            <main>
                                if !in_header {
                                    {later::<CartCount>()}
                                }
                            </main>
                        </body>
                    </html>
                })
            })
        };
        let routes =
            Table::new().route("/menu", page("<main-menu></main-menu>", false)).route("/raw", page("<main hidden></main>", true));
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).router();
        let (status, _, body) = call_with(router.clone(), "GET", "/menu", None, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        let (status, _, body) = call_with(router, "GET", "/raw", None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    #[derive(crate::view::Id)]
    struct PartNavId;

    /// An element of the layout marked `page` is sent with a navigation, as `<main>` is, so a place
    /// for a layout read in it is an error on a full load too; one beside it (a `<nav>` of the same
    /// name inside it included) is not.
    // A debug build's check.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_place_for_a_read_inside_an_element_marked_page_is_an_error() {
        let page = |in_part: bool| {
            get(move |req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <nav page id={PartNavId}>
                                <nav>"Sections"</nav>
                                if in_part {
                                    {later::<CartCount>()}
                                }
                            </nav>
                            <header>
                                if !in_part {
                                    {later::<CartCount>()}
                                }
                            </header>
                            <main>"Shop"</main>
                        </body>
                    </html>
                })
            })
        };
        let routes = Table::new().route("/part", page(true)).route("/beside", page(false));
        let router = App::new(Routes::from(routes)).layout_read(CartCount::default()).router();
        for mode in [Some("nav"), None] {
            let (status, _, body) = call_with(router.clone(), "GET", "/part", mode, None).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{mode:?}: {body}");
        }
        let (status, _, body) = call_with(router.clone(), "GET", "/beside", None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(r#"<nav data-corten-page id="part-nav"><nav>Sections</nav></nav>"#), "{body}");
        let (status, _, body) = call_with(router, "GET", "/beside", Some("nav"), None).await;
        assert_eq!(
            (status, body.as_str()),
            (StatusCode::OK, r#"<title>Shop</title><nav data-corten-page id="part-nav"><nav>Sections</nav></nav>Shop"#)
        );
    }

    /// An answer type of the app's own that wraps a page and does not say it is one.
    struct Wrapped(HtmlResponse);

    impl crate::response::IntoResponse for Wrapped {
        fn into_response(self) -> crate::response::Response {
            self.0.into_response()
        }
    }

    impl crate::Answer for Wrapped {
        const FORMAT: crate::answer::Format = crate::answer::Format::Html;
        type Inputs = crate::answer::AnyInputs;
        type Rows = crate::answer::NotAFeed;
        type Kind = crate::AnyAnswer;
    }

    async fn wrapped(req: Req) -> Wrapped {
        Wrapped(req.page(Layout { req: &req, children: html! { <p>"wrapped"</p> } }).unwrap())
    }

    #[crate::routes]
    mod wrapped_url {
        #[route("/wrapped", get = wrapped, post = wrapped)]
        pub struct Wrapped;

        #[route("/wrapped-secret", get = wrapped, no_store)]
        pub struct WrappedSecret;
    }

    /// A page from an answer type that does not say it is one starts no read: a debug build says
    /// why rather than draw the layout without its values. So does a write's own page from it, in
    /// an action too, whose reads start after the handler (#1370).
    // A debug build's check.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_page_whose_answer_type_is_not_a_page_is_an_error() {
        let count = CartCount::default();
        let router = App::new(wrapped_url::router()).layout_read(count.clone()).layout_read(SignedIn).dev(false).router();
        for (method, mode) in [("GET", None), ("POST", None), ("POST", Some("action"))] {
            let (status, _, body) = call_with(router.clone(), method, "/wrapped", mode, None).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{method} {mode:?}: {body}");
            // Named where a router test, with no logger and outside `corten dev`, sees it.
            assert!(body.contains("layout_reads::CartCount&gt;()") && body.contains("(Answer::PAGE)"), "{body}");
            assert_eq!(count.started.load(Ordering::SeqCst), 0, "{method} {mode:?}");
        }
        // A `no_store` route's: kept by no cache, whatever the app's middleware makes of it. One
        // with no mark: kept by no shared cache, also when the error page drawn in its place greets
        // the visitor its cookie names.
        let html = [("accept", "text/html")];
        for cache in [None, Some("public, max-age=60"), Some("private, max-age=60")] {
            let router = App::new(wrapped_url::router())
                .layout_read(CartCount::default())
                .layout_read(SignedIn)
                .middleware(crate::tests::cache::CdnRecaches(cache))
                .error_page(crate::tests::cache::greeting_error_page, ())
                .dev(false)
                .router();
            let (status, headers, body) = call_with(router.clone(), "GET", "/wrapped-secret", None, None).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{cache:?}: {body}");
            let wrong = crate::tests::cache::kept_from_cdns(&headers, "private, no-store");
            assert!(wrong.is_empty(), "{cache:?}: a no_store page's replacement, open to a cache: {wrong:?}");
            let (status, headers, body) = crate::tests::cache::from_ann(&router, "GET", "/wrapped", &html).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{cache:?}: {body}");
            assert!(body.contains("Sorry, ann."), "{cache:?}: the error page in the refused page's place: {body}");
            let wrong = crate::tests::cache::kept_from_cdns(&headers, "private, no-cache");
            assert!(wrong.is_empty(), "{cache:?}: a refused page's replacement, open to a CDN: {wrong:?}");
        }
    }

    #[cfg(debug_assertions)]
    #[derive(crate::view::Id)]
    struct BadgeId;

    /// The header's badge, as a patch would send it.
    #[cfg(debug_assertions)]
    #[crate::component]
    fn PatchBadge() -> impl crate::view::Patch {
        html! { <span id={BadgeId}>{later::<CartCount>()}</span> }
    }

    /// A badge that renders its place into a string and drops it.
    #[crate::component]
    fn DroppedBadge() -> impl Render {
        let _dropped = later::<CartCount>().to_html();
        html! { <span>"badge"</span> }
    }

    /// A patch is not a page, so a place in it would draw nothing: a debug build says so. A place
    /// rendered into a string the page never writes draws nothing and is no error.
    // A debug build's check.
    #[cfg(debug_assertions)]
    #[tokio::test(start_paused = true)]
    async fn a_place_in_a_patch_is_an_error_and_one_never_written_draws_nothing() {
        let routes = Table::new()
            .route(
                "/patch",
                get(|req: Req| async move {
                    req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(PatchBadge {})
                }),
            )
            .route(
                "/dropped",
                get(|req: Req| async move {
                    req.page::<ForOne>(html! {
                        <html>
                            <head>
                                <title>"Shop"</title>
                                <Corten />
                            </head>
                            <body>
                                <header><DroppedBadge /></header>
                                <main></main>
                            </body>
                        </html>
                    })
                }),
            );
        let count = CartCount { delay: Duration::from_millis(400), ..CartCount::default() };
        let router = App::new(Routes::from(routes)).layout_read(count.clone()).router();
        let (status, _, body) = call_with(router.clone(), "GET", "/patch", Some("action"), None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert!(body.contains("layout_reads::CartCount") && body.contains("which only a page fills"), "{body}");
        let started = tokio::time::Instant::now();
        let (status, _, body) = call_with(router, "GET", "/dropped", None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains("<header><span>badge</span></header>") && !body.contains("corten-later"), "{body}");
        assert!(started.elapsed() < Duration::from_millis(400), "a place never written does not wait for its read");
        assert_eq!(count.finished.load(Ordering::SeqCst), 0, "a read no place draws is dropped");
    }

    /// The app's middleware, slow after the route answers.
    struct SlowAfter;

    impl crate::Middleware for SlowAfter {
        async fn call(&self, req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let res = next.run(req).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            res
        }
    }

    /// The app's middleware, refusing what the route answered.
    struct RefuseAfter;

    impl crate::Middleware for RefuseAfter {
        async fn call(&self, req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let _ = next.run(req).await;
            crate::response::IntoResponse::into_response(StatusCode::FORBIDDEN)
        }
    }

    /// The app's middleware, refusing what the route answered as the request's fault (an error
    /// page that waits for its reads).
    struct ForbidAfter;

    impl crate::Middleware for ForbidAfter {
        async fn call(&self, req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
            let _ = next.run(req).await;
            crate::response::IntoResponse::into_response(crate::Refused::forbidden())
        }
    }

    /// The shop's pages behind middleware that refuses each after it was filled: `/page` draws its
    /// reads, `/cart` gives the count, and `/given` gives it and says so (`gives(CartCount)`).
    fn refused_after<M: crate::Middleware>(count: CartCount, refuse: M) -> Router {
        let typed = shop_url::router();
        let routes = Table::new()
            .route(
                "/page",
                get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! { <p>"page"</p> } }) }),
            )
            .route(
                "/cart",
                get(|req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>"cart"</p> } })
                        .map(|page| page.give::<CartCount>(7))
                }),
            );
        App::new(Routes(typed.0.merge(routes), typed.1, typed.2))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(count)
            .layout_read(SignedIn)
            .middleware((AsViewer(Some("ada")), refuse))
            .router()
    }

    /// A read in by the time the route answers with no page stays for the error page the app's
    /// middleware turns the answer into.
    #[tokio::test]
    async fn the_error_page_middleware_makes_draws_a_read_in_before_the_route_answered() {
        let routes = Table::new().route(
            "/away",
            get(|req: Req| async move {
                // The page's own reads, longer than the count's.
                tokio::time::sleep(Duration::from_millis(20)).await;
                let _ = &req;
                (StatusCode::SEE_OTHER, [(header::LOCATION, "/")])
            }),
        );
        let router = App::new(Routes::from(routes))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(CartCount::default())
            .layout_read(SignedIn)
            .middleware((AsViewer(Some("ada")), RefuseAfter))
            .router();
        let (status, _, body) = call_with(router, "GET", "/away", None, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>403</p>"), "{body}");
    }

    /// What a whole document that draws two layout reads costs: `READ_PAGES` (200) requests in
    /// process, one at a time; with `READ_MODE=nav`, a navigation's `<main>` in the same app, which
    /// draws none. Counting it under callgrind at two numbers of requests gives the instructions per
    /// request. Run in release:
    /// `READ_PAGES=200 cargo test --release -p corten-run --all-features --lib -- --ignored what_a_page_with_layout_reads_costs`
    #[test]
    #[ignore]
    fn what_a_page_with_layout_reads_costs() {
        let pages: usize = std::env::var("READ_PAGES").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
        // `READ_GIVES=1`: a page that gives the count itself (`give`), the other read drawn.
        let gives = std::env::var("READ_GIVES").is_ok_and(|v| v == "1");
        let routes = Table::new()
            .route(
                "/page",
                get(|req: Req| async move { req.page::<ForOne>(Layout { req: &req, children: html! { <p>"page"</p> } }) }),
            )
            .route(
                "/cart",
                get(|req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>"cart"</p> } })
                        .map(|page| page.give::<CartCount>(7))
                }),
            );
        let router = App::new(Routes::from(routes))
            .layout_read(CartCount::default())
            .layout_read(SignedIn)
            .middleware(AsViewer(Some("ada")))
            .router();
        let (path, count) = if gives { ("/cart", 7) } else { ("/page", 3) };
        let nav = std::env::var("READ_MODE").is_ok_and(|v| v == "nav");
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            for _ in 0..pages {
                if nav {
                    let (status, _, body) = call_with(router.clone(), "GET", path, Some("nav"), None).await;
                    assert!(status == StatusCode::OK && body.contains("<p>page</p>") && !body.contains("count"), "{body}");
                    continue;
                }
                let (status, _, body) = call_with(router.clone(), "GET", path, None, None).await;
                assert!(status == StatusCode::OK && body.contains(&format!(r#"<span class="count">{count}</span>"#)), "{body}");
            }
        });
    }

    /// What a write the runtime sent (`corten: action`) costs, to a route of a routes module, answered
    /// with its own page (a form drawn again, `/typed-write`) or, with `WRITE_ANSWER=patch`, a patch
    /// from a route whose answer type may be a page too (`HtmlResult`, `/any-patch`), or with
    /// `WRITE_ANSWER=patches`, a patch from a route that answers patches alone
    /// (`HtmlResult<Patches>`, `/patches-only`): `WRITE_REQUESTS` (200) requests in process, one at a
    /// time, in an app with two layout reads or, with `WRITE_READS=0`, none. With `WRITE_MODE=page`
    /// the same write comes from a browser without JavaScript (no `corten` header), whose page is the
    /// same whole document; with `WRITE_MODE=main` from a runtime that does not draw a write's own
    /// page whole (no `Prefer: corten-draws=whole`), which gets `<main>`. With
    /// `WRITE_MIDDLEWARE=req` the app's middleware takes `Req` before the route. Counting it under callgrind at two numbers of
    /// requests gives the instructions per request (#1370). Run in release:
    /// `WRITE_REQUESTS=200 cargo test --release -p corten-run --all-features --lib -- --ignored what_a_write_answering_in_an_action_costs`
    #[test]
    #[ignore]
    fn what_a_write_answering_in_an_action_costs() {
        let requests: usize = std::env::var("WRITE_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
        let answer = std::env::var("WRITE_ANSWER").unwrap_or_default();
        let path = match answer.as_str() {
            "patch" => "/any-patch",
            "patches" => "/patches-only",
            _ => "/typed-write",
        };
        let reads = !std::env::var("WRITE_READS").is_ok_and(|v| v == "0");
        let mode = std::env::var("WRITE_MODE").unwrap_or_default();
        let app = App::new(shop_url::router());
        let app = if reads { app.layout_read(CartCount::default()).layout_read(SignedIn) } else { app };
        let router = if std::env::var("WRITE_MIDDLEWARE").is_ok_and(|v| v == "req") {
            app.middleware((AsViewer(Some("ada")), TakesReq)).router()
        } else {
            app.middleware(AsViewer(Some("ada"))).router()
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            for _ in 0..requests {
                let mut req = Request::builder().method("POST").uri(path);
                match mode.as_str() {
                    "page" => {}
                    "main" => req = req.header("corten", "action"),
                    _ => req = req.header("corten", "action").header("prefer", "corten-draws=whole"),
                }
                let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
                let status = res.status();
                let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
                assert!(
                    status == StatusCode::OK
                        && (body.contains("too short") || body.contains("patched") || body.contains("typed write")),
                    "{status} {body}"
                );
            }
        });
    }

    /// What a write's own page costs at the user's end, in time and bytes, against the `<main>` a
    /// runtime that does not draw it whole gets (main's answer before #1370): `WRITE_TIMES` (25)
    /// writes of each, alternating, in an app whose count read takes `WRITE_READ_MS` (20) ms. The
    /// whole page waits for the read, which starts once the handler has answered; `<main>` starts
    /// none. Prints the median and range of each, and each answer's bytes. Run in release:
    /// `cargo test --release -p corten-run --all-features --lib -- --ignored --nocapture what_a_writes_own_page_costs_in_time_and_bytes`
    #[test]
    #[ignore]
    fn what_a_writes_own_page_costs_in_time_and_bytes() {
        let times: usize = std::env::var("WRITE_TIMES").ok().and_then(|n| n.parse().ok()).unwrap_or(25);
        let read: u64 = std::env::var("WRITE_READ_MS").ok().and_then(|n| n.parse().ok()).unwrap_or(20);
        let count = CartCount { delay: Duration::from_millis(read), ..CartCount::default() };
        let router =
            App::new(shop_url::router()).layout_read(count).layout_read(SignedIn).middleware(AsViewer(Some("ada"))).router();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (mut whole, mut main, mut sizes) = (Vec::new(), Vec::new(), (0, 0));
        runtime.block_on(async {
            for _ in 0..times {
                for draws in [true, false] {
                    let mut req = Request::builder().method("POST").uri("/typed-write").header("corten", "action");
                    if draws {
                        req = req.header("prefer", "corten-draws=whole");
                    }
                    let began = std::time::Instant::now();
                    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
                    let body = res.into_body().collect().await.unwrap().to_bytes();
                    let took = began.elapsed().as_secs_f64() * 1000.0;
                    if draws {
                        whole.push(took);
                        sizes.0 = body.len();
                    } else {
                        main.push(took);
                        sizes.1 = body.len();
                    }
                }
            }
        });
        let say = |name: &str, mut ms: Vec<f64>, bytes: usize| {
            ms.sort_by(f64::total_cmp);
            println!("{name}: median {:.2} ms [{:.2}-{:.2}], {bytes} bytes", ms[ms.len() / 2], ms[0], ms[ms.len() - 1]);
        };
        say("own page whole", whole, sizes.0);
        say("<main>", main, sizes.1);
    }

    /// The app's middleware, taking `Req` before the route (as one that may answer with a page in
    /// the route's place does) and passing the request on.
    struct TakesReq;

    impl crate::Middleware for TakesReq {
        async fn call(&self, req: crate::http::Request, next: impl crate::middleware::Next) -> crate::response::Response {
            use crate::extract::FromRequestParts;
            let (mut parts, body) = req.into_parts();
            let taken = Req::from_request_parts(&mut parts, &()).await.unwrap();
            drop(taken);
            next.run(crate::http::Request::from_parts(parts, body)).await
        }
    }

    /// A page the app's middleware throws away after it was filled, answering an error itself: the
    /// error page draws the values the page drew, its reads' and those it gave, without reading
    /// them again, whether the error page waits for its reads (a refusal, the request's fault) or
    /// not (a bare 403) (#911).
    #[tokio::test]
    async fn the_error_page_middleware_makes_of_a_filled_page_draws_its_values() {
        // The page's path, the count it drew, and how many times the count is read.
        for (path, drawn, reads) in [("/page", 3, 1), ("/cart", 7, 1), ("/given", 7, 0)] {
            for forbid in [false, true] {
                let count = CartCount::default();
                let router =
                    if forbid { refused_after(count.clone(), ForbidAfter) } else { refused_after(count.clone(), RefuseAfter) };
                let (status, _, body) = call_with(router, "GET", path, None, None).await;
                let case = format!("{path}, forbidden {forbid}: {body}");
                assert_eq!(status, StatusCode::FORBIDDEN, "{case}");
                assert!(!body.contains("<p>page</p>") && body.contains("<p>403</p>"), "{case}");
                let header = format!(r#"<header>Cart <span class="count">{drawn}</span><b>ada</b></header>"#);
                assert!(body.contains(&header), "{case}");
                assert!(body.contains(&format!(r#"<footer><span class="count">{drawn}</span></footer>"#)), "{case}");
                assert_eq!(count.started.load(Ordering::SeqCst), reads, "{case}");
            }
        }
    }

    /// A read that finishes on the same tick the route answers is in by the time it answered: the
    /// reads are polled once more before those still running are dropped.
    #[tokio::test(start_paused = true)]
    async fn a_read_done_on_the_tick_the_route_answers_is_drawn_by_the_error_page() {
        let routes = Table::new().route(
            "/away",
            get(|req: Req| async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                let _ = &req;
                (StatusCode::SEE_OTHER, [(header::LOCATION, "/")])
            }),
        );
        let count = CartCount { delay: Duration::from_millis(20), ..CartCount::default() };
        let router = App::new(Routes::from(routes))
            .error_page(
                |failure: Failure, req: Req| async move {
                    req.page::<ForOne>(Layout { req: &req, children: html! { <p>{failure.status().as_u16()}</p> } })
                },
                (),
            )
            .layout_read(count.clone())
            .layout_read(SignedIn)
            .middleware((AsViewer(Some("ada")), RefuseAfter))
            .router();
        let (status, _, body) = call_with(router, "GET", "/away", None, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains(r#"<span class="count">3</span>"#) && body.contains("<p>403</p>"), "{body}");
        assert_eq!(count.started.load(Ordering::SeqCst), 1);
    }

    /// A read no place draws is dropped as the route answers, not polled while the app's
    /// middleware runs after it: a redirect, a page that draws none, and one whose only place is
    /// never written.
    #[tokio::test(start_paused = true)]
    async fn a_read_nothing_draws_stops_when_the_route_answers() {
        let shell = |header: bool| {
            get(move |req: Req| async move {
                req.page::<ForOne>(html! {
                    <html>
                        <head>
                            <title>"Shop"</title>
                            <Corten />
                        </head>
                        <body>
                            <header>
                                if header {
                                    <DroppedBadge />
                                }
                            </header>
                            <main></main>
                        </body>
                    </html>
                })
            })
        };
        let routes = Table::new()
            .route(
                "/away",
                get(|req: Req| async move {
                    let _ = &req;
                    (StatusCode::SEE_OTHER, [(header::LOCATION, "/")])
                }),
            )
            .route("/none", shell(false))
            .route("/unwritten", shell(true));
        for path in ["/away", "/none", "/unwritten"] {
            let count = CartCount { delay: Duration::from_millis(100), ..CartCount::default() };
            let router = App::new(Routes::from(routes.clone())).layout_read(count.clone()).middleware(SlowAfter).router();
            let (status, _, body) = call_with(router, "GET", path, None, None).await;
            assert!(status == StatusCode::OK || status == StatusCode::SEE_OTHER, "{path}: {status} {body}");
            assert_eq!(count.started.load(Ordering::SeqCst), 1, "{path}");
            assert_eq!(count.finished.load(Ordering::SeqCst), 0, "{path}: the read was dropped");
        }
    }
}
