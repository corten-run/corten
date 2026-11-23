use super::*;

#[tokio::test]
async fn action_returns_patch_and_plain_post_redirects() {
    let (_, headers, body) = call(app(routes(), None), "POST", Some("action")).await;
    assert_eq!(headers["corten-patch"], "1");
    assert_eq!(body, r#"<p id="msg">saved</p>"#);
    let (status, headers, _) = call(app(routes(), None), "POST", None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers["location"], "/done");
}

/// `patch_or`'s page is built only for a submit without JavaScript, so a patch never loads what
/// only the page shows.
#[tokio::test]
async fn patch_or_builds_the_page_only_without_javascript() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static PAGES: AtomicUsize = AtomicUsize::new(0);
    let routes = || {
        Table::new().route(
            "/",
            crate::router::post(|req: Req| async move {
                let page = || async {
                    PAGES.fetch_add(1, Ordering::Relaxed);
                    req.redirect::<ForOne>(&Done)
                };
                req.patch_or::<ForOne, AnyAnswer, _, _>(html! { <p id={MsgId}>"saved"</p> }, page).await
            }),
        )
    };
    let (_, headers, _) = call(app(routes(), None), "POST", Some("action")).await;
    assert_eq!((headers["corten-patch"].to_str().unwrap(), PAGES.load(Ordering::Relaxed)), ("1", 0));
    let (status, _, _) = call(app(routes(), None), "POST", None).await;
    assert_eq!((status, PAGES.load(Ordering::Relaxed)), (StatusCode::SEE_OTHER, 1));
    // A data client gets the page's answer too, not a JSON error as from `invalid`.
    let (status, _, _) = call_with(app(routes(), None), "POST", "/", None, Some("application/json")).await;
    assert_eq!((status, PAGES.load(Ordering::Relaxed)), (StatusCode::SEE_OTHER, 2));
}

/// A view of references that are not `Sync` (`&Cell`) keeps the handler's future `Send`: the
/// patch is rendered before `patch_or`'s future holds anything.
#[tokio::test]
async fn patch_or_keeps_a_handler_send_with_a_view_of_cells() {
    let routes = Table::new().route(
        "/",
        crate::router::post(|req: Req| async move {
            let count = std::cell::Cell::new(1);
            let count = &count;
            req.patch_or::<ForOne, AnyAnswer, _, _>(html! { <p id={MsgId}>{count.get()}</p> }, || async { req.redirect(&Done) })
                .await
        }),
    );
    let (_, _, body) = call(app(routes, None), "POST", Some("action")).await;
    assert_eq!(body, r#"<p id="msg">1</p>"#);
}

/// `patch_or_with` runs one side: the part for the runtime's read (`Mode::Action`), the page for
/// every other mode (a first load, a navigation, a data client), so neither reads what only the
/// other draws; and the part varies on `corten`, so a cache keeps it apart from the page at the
/// same URL.
#[tokio::test]
async fn patch_or_with_runs_only_the_side_the_request_asks_for() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static PARTS: AtomicUsize = AtomicUsize::new(0);
    static PAGES: AtomicUsize = AtomicUsize::new(0);
    let routes = || {
        Table::new().route(
            "/",
            get(|req: Req| async move {
                req.patch_or_with::<ForOne, crate::Patches, _, _, _, _>(
                    |action| async move {
                        PARTS.fetch_add(1, Ordering::Relaxed);
                        tokio::task::yield_now().await;
                        action.patch_with_status(StatusCode::ACCEPTED, html! { <p id={MsgId}>"picks"</p> })
                    },
                    || async {
                        PAGES.fetch_add(1, Ordering::Relaxed);
                        req.test_page("Home", html! { <p>"home"</p> })
                    },
                )
                .await
            }),
        )
    };
    let count = || (PARTS.load(Ordering::Relaxed), PAGES.load(Ordering::Relaxed));
    let (status, headers, body) = call(app(routes(), None), "GET", Some("action")).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!((headers["corten-patch"].to_str().unwrap(), body.as_str(), count()), ("1", r#"<p id="msg">picks</p>"#, (1, 0)));
    assert!(headers["vary"].to_str().unwrap().split(", ").any(|name| name == "corten"), "{headers:?}");
    let (status, headers, body) = call(app(routes(), None), "GET", None).await;
    assert_eq!((status, headers.contains_key("corten-patch"), count()), (StatusCode::OK, false, (1, 1)));
    assert!(body.contains("<p>home</p>"), "{body}");
    call(app(routes(), None), "GET", Some("nav")).await;
    call_with(app(routes(), None), "GET", "/", None, Some("application/json")).await;
    assert_eq!(count(), (1, 3));
}

/// A route `ReadAgain::from` reads says `patches`, so its `get` handler returns
/// `HtmlResult<Patches>` (#1342).
#[crate::routes]
mod url_patches {
    #[route("/saved", get = saved_part, patches)]
    pub struct Saved {
        pub after: Option<u32>,
    }
}

async fn saved_part(req: Req, crate::Params(at): crate::Params<url_patches::Saved>) -> HtmlResult<crate::Patches> {
    use std::time::Duration;
    let from = url_patches::Saved { after: at.after };
    let again = at.after.map(|_| ReadAgain { after: Duration::from_secs(1) }.from(&from));
    let part = html! {
        <p id={MsgId}>"Saving"</p>
        {again}
    };
    req.patch_or(part, || async { req.redirect(&url_patches::Saved { after: None }) }).await
}

/// The runtime's read of such a route (`corten: action`) gets the patch, which may ask again; a
/// browser without JavaScript gets the other side of `patch_or`.
#[tokio::test]
async fn a_route_that_says_patches_answers_the_runtimes_read_with_a_patch() {
    let app = App::new(url_patches::router()).test();
    let read = app.get(&url_patches::Saved { after: Some(7) }).mode(crate::Mode::Action).await;
    assert!(read.headers().contains_key("corten-patch"), "a patch the runtime applies: {:?}", read.headers());
    assert_eq!(
        read.text(),
        r#"<p id="msg">Saving</p><template data-corten-read-again="1" data-from="/saved?after=7"></template>"#
    );
    let page = app.get(&url_patches::Saved { after: Some(7) }).mode(crate::Mode::Document).await;
    assert_eq!((page.status(), page.headers()["location"].to_str().unwrap()), (StatusCode::SEE_OTHER, "/saved"));
}

/// A page that draws a part waiting (`ReadAgain::now`, its tag inside the part) preloads the part
/// module with the runtime, and so does a navigation's answer, which the runtime moves into the
/// head; a page without one preloads nothing more. The module is served beside the runtime, which
/// imports it from there, versioned and cached with it (#1400).
#[tokio::test]
async fn a_page_that_waits_for_a_part_preloads_the_part_module() {
    fn page(req: &Req, waits: bool) -> HtmlResult {
        let now = waits.then(|| ReadAgain::now(url_patches::Saved { after: None }));
        req.test_page("Home", html! { <p id={MsgId}>"Finding" {now}</p> })
    }
    let routes = Table::new()
        .route("/", get(|req: Req| async move { page(&req, true) }))
        .route("/plain", get(|req: Req| async move { page(&req, false) }));
    let preload = format!(r#"<link rel="modulepreload" href="{}" data-corten-part>"#, crate::part_path());
    assert_eq!(crate::part_path(), format!("/corten/{}/part.js", crate::runtime_version()));
    for mode in [None, Some("nav")] {
        let (status, _, body) = call_with(app(routes.clone(), None), "GET", "/", mode, None).await;
        assert_eq!(status, StatusCode::OK, "{mode:?} {body}");
        assert!(body.contains(&preload), "{mode:?}: {body}");
        assert!(
            body.contains(r#"<p id="msg">Finding<template data-corten-read-now data-from="/saved"></template></p>"#),
            "{body}"
        );
        let (_, _, plain) = call_with(app(routes.clone(), None), "GET", "/plain", mode, None).await;
        assert!(!plain.contains("part.js"), "{mode:?}: {plain}");
    }
    let (status, headers, body) = call_with(app(routes, None), "GET", crate::part_path(), None, None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, crate::PART_JS));
    assert_eq!(headers["content-type"], "text/javascript; charset=utf-8");
    assert!(headers["cache-control"].to_str().unwrap().contains("immutable"), "{headers:?}");
}

/// A route that says `patches` mounted by hand (`Area::route`) with a `get` handler that answers
/// one, as its routes module would: the runtime's read of it still gets the patch. One that may
/// answer the page does not compile (`Methods`'s doctest).
#[tokio::test]
async fn a_route_that_says_patches_mounted_by_hand_with_a_patch_handler_answers_a_patch() {
    #[derive(crate::Route)]
    #[route("/saved")]
    struct SavedArea;
    async fn again(req: Req) -> HtmlResult<crate::Patches> {
        req.patch_or(html! { <p id={MsgId}>"Saved again"</p> }, || async { req.redirect(&url_patches::Saved { after: None }) })
            .await
    }
    let app = App::new(Routes::new()).area::<SavedArea>(|area| area.route::<url_patches::Saved>(crate::route::get(again))).test();
    let read = app.get(&url_patches::Saved { after: None }).mode(crate::Mode::Action).await;
    assert!(read.headers().contains_key("corten-patch"), "a patch the runtime applies: {:?}", read.headers());
    assert_eq!(read.text(), r#"<p id="msg">Saved again</p>"#);
}

/// The routes module's check and a mount's agree on a handler whose answer is opaque: an
/// `impl Answer<.., Kind = Patches>` is the `get` of a route that says `patches` both in its
/// routes module and mounted by hand, and the runtime's read gets the patch either way. An answer
/// of the app's own cannot say `Patches` (`PatchRoute`'s and `Answer::Kind`'s doctests).
#[tokio::test]
async fn an_opaque_patch_answer_is_the_get_of_a_patches_route_in_its_module_and_mounted_by_hand() {
    #[derive(crate::Route)]
    #[route("/opaque")]
    struct OpaqueArea;
    let module = App::new(url_opaque::router()).test();
    let by_hand =
        App::new(Routes::new()).area::<OpaqueArea>(|area| area.route::<url_opaque::Opaque>(crate::route::get(opaque))).test();
    for app in [module, by_hand] {
        let read = app.get(&url_opaque::Opaque).mode(crate::Mode::Action).await;
        assert!(read.headers().contains_key("corten-patch"), "a patch the runtime applies: {:?}", read.headers());
        assert_eq!(read.text(), r#"<p id="msg">Opaque</p>"#);
    }
}

#[crate::routes]
mod url_opaque {
    #[route("/opaque", get = opaque, patches)]
    pub struct Opaque;
}

// rustc warns that the `impl` does not prove `Kind`'s bound (`KindOf<Self>`, which only the
// hidden type's own impl proves), though the routes module and a mount take it alike.
#[allow(opaque_hidden_inferred_bound)]
async fn opaque(
    req: Req,
) -> impl crate::Answer<Inputs = crate::answer::AnyInputs, Rows = crate::answer::NotAFeed, Kind = crate::Patches> {
    let part: HtmlResult<crate::Patches> =
        req.patch_or(html! { <p id={MsgId}>"Opaque"</p> }, || async { req.redirect(&crate::Local::parse("/").unwrap()) }).await;
    part
}

/// `patch_or`, `invalid` and `invalid_with` answer `req.mode` as the handler leaves it, so a
/// handler that sets it to `Mode::Document` answers the runtime's read of a route that says
/// `patches` with the other side, here a redirect, and no patch: an escape
/// `docs/design.md#choice-patch-routes` names. Writing `req.mode` is the app's own override, as it
/// is for any `HtmlResult` handler.
#[tokio::test]
async fn a_handler_that_sets_req_mode_answers_the_runtimes_read_as_it_set_it() {
    let app = App::new(url_moded::router()).test();
    for read in [
        app.get(&url_moded::Or).mode(crate::Mode::Action).await,
        app.get(&url_moded::Invalid).mode(crate::Mode::Action).await,
        app.get(&url_moded::InvalidWith).mode(crate::Mode::Action).await,
    ] {
        assert!(!read.headers().contains_key("corten-patch"), "the side req.mode chose, not a patch: {:?}", read.headers());
        assert_eq!(read.status(), StatusCode::SEE_OTHER, "the redirect a page load gets");
    }
}

#[crate::routes]
mod url_moded {
    #[route("/or", get = moded_or, patches)]
    pub struct Or;
    #[route("/invalid", get = moded_invalid, patches)]
    pub struct Invalid;
    #[route("/invalid-with", get = moded_invalid_with, patches)]
    pub struct InvalidWith;
}

async fn moded_or(mut req: Req) -> HtmlResult<crate::Patches> {
    req.mode = crate::Mode::Document;
    req.patch_or(html! { <p id={MsgId}>"Moded"</p> }, || async { req.redirect(&crate::Local::parse("/").unwrap()) }).await
}

async fn moded_invalid(mut req: Req) -> HtmlResult<crate::Patches> {
    req.mode = crate::Mode::Document;
    let mut errors = crate::Errors::new();
    errors.refuse(crate::Refusal::Conflict, "moved on");
    req.invalid(&errors, html! { <p id={MsgId}>"Moded"</p> }, || async { req.redirect(&crate::Local::parse("/").unwrap()) }).await
}

async fn moded_invalid_with(mut req: Req) -> HtmlResult<crate::Patches> {
    req.mode = crate::Mode::Document;
    let mut errors = crate::Errors::new();
    errors.refuse(crate::Refusal::Conflict, "moved on");
    req.invalid_with(
        &errors,
        |form| async move { form.draw(html! { <p id={MsgId}>"Moded"</p> }) },
        || async { req.redirect(&crate::Local::parse("/").unwrap()) },
    )
    .await
}

/// What a request through `req.patch_or` costs: `PATCH_REQUESTS` (200) requests in process, one
/// at a time, read by the runtime (`corten: action`, the patch) or, with `PATCH_MODE=document`, by
/// a browser without JavaScript (the page), to a handler that returns `HtmlResult` or, with
/// `PATCH_KIND=patches`, `HtmlResult<Patches>` (`docs/design.md#choice-patch-routes`). Counting it under callgrind at
/// two numbers of requests gives the instructions per request. A build from before `Patches`
/// counts the `HtmlResult` handler with this function less `cost_patches`. The test binary has no
/// global allocator, so preload the one to count with. Run in release: `cargo test --release -p corten-run --all-features --lib --no-run`,
/// then
/// `PATCH_REQUESTS=1200 LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 valgrind --tool=callgrind <that binary> --ignored --exact tests::patches::what_a_patch_or_request_costs`
/// (Debian's `libjemalloc2`) and again at 200.
#[test]
#[ignore]
fn what_a_patch_or_request_costs() {
    let requests: usize = std::env::var("PATCH_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let page = std::env::var("PATCH_MODE").is_ok_and(|m| m == "document");
    let patches = std::env::var("PATCH_KIND").is_ok_and(|k| k == "patches");
    async fn cost_part(req: Req) -> HtmlResult {
        let part = html! { <p id={MsgId}>"Saved " {42u32}</p> };
        req.patch_or(part, || async { req.test_page("Part", html! { <p>"part"</p> }) }).await
    }
    async fn cost_patches(req: Req) -> HtmlResult<crate::Patches> {
        let part = html! { <p id={MsgId}>"Saved " {42u32}</p> };
        req.patch_or(part, || async { req.test_page("Part", html! { <p>"part"</p> }) }).await
    }
    let handler = if patches { get(cost_patches) } else { get(cost_part) };
    let router = App::new(Routes::from(Table::new().route("/part", handler))).router();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        for _ in 0..requests {
            let (status, headers, _) = call_with(router.clone(), "GET", "/part", (!page).then_some("action"), None).await;
            assert!(status == StatusCode::OK && headers.contains_key("corten-patch") != page, "{status} {headers:?}");
        }
    });
}

/// Instructions per request for a slow part's read, the two ways an app can send it: a route of
/// its own whose `corten::live` stream sends the part once (`SLOW_PART=stream`, as before
/// #1400), or the page's own route answering `corten: action` with `req.patch_or_with`'s part
/// side. Count it as `what_a_patch_or_request_costs` says, with `SLOW_PART_REQUESTS=1200` and
/// `200` and `--exact tests::patches::what_a_slow_part_read_costs`.
#[test]
#[ignore]
fn what_a_slow_part_read_costs() {
    let requests: usize = std::env::var("SLOW_PART_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let stream = std::env::var("SLOW_PART").is_ok_and(|m| m == "stream");
    fn picks() -> impl Patch {
        html! {
            <ul id={MsgId}>
                <li>"Halcyon Health (HLTH) 0.00%"</li>
                <li>"Northgate Rail (NRTH) 0.00%"</li>
            </ul>
        }
    }
    async fn send_part() -> LiveResponse {
        crate::live(futures_util::stream::once(async { picks().to_html() }))
    }
    async fn read_part(req: Req) -> HtmlResult<crate::Patches> {
        req.patch_or_with(
            |action| async move { action.patch(picks()) },
            || async { req.test_page("Home", html! { <p>"home"</p> }) },
        )
        .await
    }
    let router = if stream {
        App::new(Routes::from(Table::new().route("/part", get(send_part)))).router()
    } else {
        App::new(Routes::from(Table::new().route("/part", get(read_part)))).router()
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        for _ in 0..requests {
            let (status, _, body) = if stream {
                call_with(router.clone(), "GET", "/part", None, Some("text/event-stream")).await
            } else {
                call_with(router.clone(), "GET", "/part", Some("action"), None).await
            };
            assert!(status == StatusCode::OK && body.contains("Northgate Rail"), "{status} {body}");
        }
    });
}

/// A write that answers a page wherever it is posted, as a patch for the runtime, with a cookie,
/// `Clear-Site-Data` and a header of the page's own.
async fn post_page_drawn(req: Req) -> HtmlResult {
    let mut res =
        req.patch_or(html! { <p id={MsgId}>"saved"</p> }, || async { req.test_page("Saved", html! { <p>"saved"</p> }) }).await?;
    res.headers_mut().insert("clear-site-data", HeaderValue::from_static("\"cache\""));
    res.headers_mut().insert("x-drawn", HeaderValue::from_static("saved"));
    Ok(res.with_cookie(SetCookie::new("saved", "1")))
}

/// The same write at a path with a parameter.
async fn post_item_drawn(req: Req, Params(_): Params<post_page_url::ItemSave>) -> HtmlResult {
    post_page_drawn(req).await
}

/// The same write under any first segment, the API's prefix and Corten's own included.
async fn post_section_drawn(req: Req, Params(_): Params<post_page_url::SectionSave>) -> HtmlResult {
    post_page_drawn(req).await
}

/// A write refused for its input: the page again, with the refusal's status.
async fn post_page_refused(req: Req) -> HtmlResult {
    let mut res = req.test_page("Refused", html! { <p>"refused"</p> })?;
    *res.status_mut() = StatusCode::UNPROCESSABLE_ENTITY;
    Ok(res)
}

async fn post_page_redirected(req: Req) -> HtmlResult {
    req.redirect(&post_page_url::Home)
}

/// An API's answer carrying a page's shell header, as the check reads a page, at a path the app's
/// post-only `/{section}/save` also matches. A request under an API's prefix is answered as the
/// API's before the page stages (`render_errors`), so the check never sees it.
async fn post_api_saved() -> HtmlResult {
    let res = crate::response::Response::builder().header(crate::page::SHELL_HEADER, "api").body(Body::from("saved"));
    Ok(HtmlResponse::new(res.unwrap()))
}

#[crate::routes]
mod post_page_url {
    #[route("/", get = post_page_drawn, post = post_page_drawn)]
    pub struct Home;

    #[route("/save", post = post_page_drawn)]
    pub struct Save;

    #[route("/items/{id}/save", post = post_item_drawn)]
    pub struct ItemSave {
        pub id: u32,
    }

    #[route("/{section}/save", post = post_section_drawn)]
    pub struct SectionSave {
        pub section: String,
    }

    #[route("/refuse", post = post_page_refused)]
    pub struct Refuse;

    #[route("/done", post = post_page_redirected)]
    pub struct Done;

    #[route("/relay", any = post_page_drawn)]
    pub struct Relay;

    #[route("/relayed", post = post_page_relayed)]
    pub struct Relayed;
}

/// An upstream's page, relayed as it came at a post-only path: the upstream answers for it.
async fn post_page_relayed() -> crate::Result<crate::Relay> {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert("corten-shell", HeaderValue::from_static("0123456789abcdef"));
    Ok(crate::Relay::new(StatusCode::OK, headers, Body::from("<p>upstream</p>")))
}

#[crate::routes(area = PostShop)]
mod post_page_area {
    #[route("/shop")]
    pub struct PostShop;

    #[route("/shop/save", post = post_page_drawn)]
    pub struct ShopSave;
}

#[crate::routes(api = PostApi)]
mod post_page_api {
    #[route("/api")]
    pub struct PostApi;

    #[route("/api/save", post = post_api_saved)]
    pub struct ApiSave;
}

/// An app with a page route, post-only routes that draw a page, refuse or redirect, one with a
/// parameter, one in an area, an `any = ..` route and an API, and a POST to it with `headers`.
fn post_page_router() -> crate::Router {
    App::new(post_page_url::router()).area(post_page_area::area).api(post_page_api::api).error_page(test_error_page, ()).router()
}

const POST_PAGE_BROWSER: &[(&str, &str)] = &[("accept", "text/html")];

/// A browser's post answered with a page at a path with no `GET` is an error in a debug build: the
/// browser would show it at an address that answers 405 when it is opened again. The handler's
/// cookies and `Clear-Site-Data` go out with it, and the page's other headers do not. A page's own
/// route, a refusal, a redirect, the runtime's patch, a client that does not ask for HTML, an
/// `any = ..` route (which answers `GET` too), an API's path (answered with a page's shell
/// header; an API's requests never reach the check) and a path of Corten's own are not. The last
/// two are paths the app's post-only `/{section}/save` matches, and at Corten's own only
/// `NotPages`, read by the check itself, keeps the page from being taken for that route's. Fetch
/// metadata that says a top-level navigation is checked; a page's own `fetch` and a form posted
/// into an `<iframe>`, whose answers are not shown as the tab's page, are not.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_page_answering_a_post_to_a_path_with_no_get_is_an_error_in_debug_builds() {
    let router = post_page_router();
    let (status, headers, body) = post_page_send(&router, "/save", POST_PAGE_BROWSER).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(body.contains("post to /save, which has no GET handler"), "it names the route outside dev too: {body}");
    let cookies: Vec<_> = headers.get_all("set-cookie").iter().map(|c| c.to_str().unwrap()).collect();
    assert!(cookies.iter().any(|c| c.starts_with("saved=1;")), "the handler's cookie is kept: {cookies:?}");
    assert_eq!(headers.get("clear-site-data").map(|v| v.to_str().unwrap()), Some("\"cache\""), "and Clear-Site-Data");
    assert!(headers.get("x-drawn").is_none(), "the page's own header is not: {headers:?}");
    let (status, _, body) = post_page_send(&router, "/items/7/save", POST_PAGE_BROWSER).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "a route with a parameter: {body}");
    assert!(body.contains("post to /items/{id}/save, which has no GET handler"), "{body}");
    let (status, _, body) = post_page_send(&router, "/shop/save", POST_PAGE_BROWSER).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "an area's route: {body}");
    let (status, _, body) = post_page_send(&router, "/news/save", POST_PAGE_BROWSER).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "the route that also matches the API's path: {body}");
    assert!(body.contains("post to /{section}/save, which has no GET handler"), "{body}");
    assert_eq!(post_page_send(&router, "/", POST_PAGE_BROWSER).await.0, StatusCode::OK, "the page's own route");
    assert_eq!(post_page_send(&router, "/refuse", POST_PAGE_BROWSER).await.0, StatusCode::UNPROCESSABLE_ENTITY, "a refusal");
    assert_eq!(post_page_send(&router, "/done", POST_PAGE_BROWSER).await.0, StatusCode::SEE_OTHER, "a redirect");
    assert_eq!(post_page_send(&router, "/relay", POST_PAGE_BROWSER).await.0, StatusCode::OK, "any = .. answers GET too");
    let (status, headers, body) = post_page_send(&router, "/api/save", POST_PAGE_BROWSER).await;
    assert_eq!(
        (status, headers.get("corten-shell").is_some()),
        (StatusCode::OK, true),
        "an API's path, answered as the API's before the check: {body}"
    );
    let (status, headers, body) = post_page_send(&router, "/corten/save", POST_PAGE_BROWSER).await;
    assert_eq!(
        (status, headers.get("corten-shell").is_some()),
        (StatusCode::OK, true),
        "a path of Corten's own, which only NotPages keeps from the check: {body}"
    );
    let patch = post_page_send(&router, "/save", &[("accept", "text/html"), ("corten", "action")]).await;
    assert_eq!(patch.0, StatusCode::OK, "the runtime's patch");
    assert_eq!(post_page_send(&router, "/save", &[]).await.0, StatusCode::OK, "not a browser");
    let navigation: &[(&str, &str)] = &[("accept", "text/html"), ("sec-fetch-mode", "navigate"), ("sec-fetch-dest", "document")];
    let (status, _, body) = post_page_send(&router, "/save", navigation).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "a form the browser submits: {body}");
    let fetch: &[(&str, &str)] = &[("accept", "text/html"), ("sec-fetch-mode", "cors"), ("sec-fetch-dest", "empty")];
    assert_eq!(post_page_send(&router, "/save", fetch).await.0, StatusCode::OK, "a page's own fetch");
    let iframe: &[(&str, &str)] = &[("accept", "text/html"), ("sec-fetch-mode", "navigate"), ("sec-fetch-dest", "iframe")];
    assert_eq!(post_page_send(&router, "/save", iframe).await.0, StatusCode::OK, "a form posted into an iframe");
}

/// A release build compiles none of the check: the same post is the page it drew.
#[cfg(not(debug_assertions))]
#[tokio::test]
async fn a_page_answering_a_post_to_a_path_with_no_get_is_sent_in_release_builds() {
    let router = post_page_router();
    for path in ["/save", "/items/7/save", "/shop/save", "/news/save"] {
        let (status, _, body) = post_page_send(&router, path, POST_PAGE_BROWSER).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert!(body.contains("<p>saved</p>"), "{path}: {body}");
    }
}

/// The direct builder is available only for Action, including a GET part read. It may borrow
/// across a read's await, and after consuming it the request's mode is writable again.
#[tokio::test]
async fn a_direct_patch_requires_the_effective_action_mode() {
    async fn checked(mut req: Req) -> HtmlResult {
        if let Some(action) = req.action() {
            tokio::task::yield_now().await;
            let res = action.patch_with_status(StatusCode::ACCEPTED, html! { <p id={MsgId}>"queued"</p> })?;
            req.mode = crate::Mode::Document;
            assert!(req.action().is_none(), "the token does not outlive its effective mode");
            return Ok(res);
        }
        req.redirect(&plain_patch_url::Or)
    }
    let routes = Table::new().route("/part", get(checked));
    let router = App::new(Routes::from(routes)).router();
    for (mode, request_headers) in [
        (crate::Mode::Document, &[][..]),
        (crate::Mode::Navigation, &[("corten", "nav")][..]),
        (crate::Mode::Data, &[("accept", "application/json")][..]),
        (crate::Mode::Action, &[("corten", "action")][..]),
    ] {
        let (status, headers, body) = plain_patch_send(&router, "GET", "/part", request_headers).await;
        let action = mode == crate::Mode::Action;
        assert_eq!(status, if action { StatusCode::ACCEPTED } else { StatusCode::SEE_OTHER }, "{mode:?}: {body}");
        assert_eq!(headers.contains_key("corten-patch"), action, "{mode:?}: {headers:?}");
        if action {
            assert_eq!(body, r#"<p id="msg">queued</p>"#);
        }
    }
}

/// A write that answers a patch whatever asked, with a cookie, `Clear-Site-Data` and a header of
/// the patch's own.
async fn plain_patch_only(mut req: Req) -> HtmlResult {
    req.mode = crate::Mode::Action; // Deliberate override: the debug guard checks the original request.
    let mut res = req.action().ok_or_else(crate::Error::not_found)?.patch(html! { <p id={MsgId}>"saved"</p> })?;
    res.headers_mut().insert("clear-site-data", HeaderValue::from_static("\"cache\""));
    res.headers_mut().insert("x-drawn", HeaderValue::from_static("saved"));
    Ok(res.with_cookie(SetCookie::new("saved", "1")))
}

/// The same, read from a route with a parameter.
async fn plain_patch_item(Params(_): Params<plain_patch_url::Item>) -> HtmlResult {
    // A raw response is outside the checked builder, but still reaches the debug guard.
    Ok(HtmlResponse::new(
        ([("content-type", "text/html; charset=utf-8"), ("corten-patch", "1")], r#"<p id="msg">item</p>"#).into_response(),
    ))
}

/// A refusal answered as a patch whatever asked.
async fn plain_patch_refused(mut req: Req) -> HtmlResult {
    req.mode = crate::Mode::Action; // A checked builder cannot detect this override.
    req.action()
        .ok_or_else(crate::Error::not_found)?
        .patch_with_status(StatusCode::UNPROCESSABLE_ENTITY, html! { <p id={MsgId}>"refused"</p> })
}

/// The patch for the runtime, the page otherwise.
async fn plain_patch_or(req: Req) -> HtmlResult {
    req.patch_or(html! { <p id={MsgId}>"saved"</p> }, || async { req.test_page("Saved", html! { <p>"saved"</p> }) }).await
}

/// An upstream's patch, relayed as it came: the upstream answers for it.
async fn plain_patch_relayed() -> crate::Result<crate::Relay> {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert("corten-patch", HeaderValue::from_static("1"));
    Ok(crate::Relay::new(StatusCode::OK, headers, Body::from(r#"<p id="msg">upstream</p>"#)))
}

/// A patch of its own status for the runtime, checked by the handler, and a redirect otherwise.
async fn plain_patch_moded(req: Req) -> HtmlResult {
    if let Some(action) = req.action() {
        return action.patch_with_status(StatusCode::ACCEPTED, html! { <p id={MsgId}>"queued"</p> });
    }
    req.redirect(&plain_patch_url::Or)
}

#[crate::routes]
mod plain_patch_url {
    #[route("/note", post = plain_patch_only)]
    pub struct Note;

    #[route("/items/{id}", get = plain_patch_item)]
    pub struct Item {
        pub id: u32,
    }

    #[route("/refused", post = plain_patch_refused)]
    pub struct Refused;

    #[route("/or", get = plain_patch_or, post = plain_patch_or)]
    pub struct Or;

    #[route("/moded", post = plain_patch_moded)]
    pub struct Moded;

    #[route("/relayed", post = plain_patch_relayed)]
    pub struct Relayed;
}

/// The app of `plain_patch_url`'s routes.
fn plain_patch_router() -> crate::Router {
    App::new(plain_patch_url::router()).error_page(test_error_page, ()).router()
}

/// An app of one hand-built route, `/table`, which no routes module declares.
fn plain_patch_table() -> crate::Router {
    let table = Table::new().route("/table", crate::router::post(plain_patch_only));
    App::new(Routes::from(table)).error_page(test_error_page, ()).router()
}

async fn plain_patch_send(
    router: &crate::Router,
    method: &str,
    path: &str,
    headers: &[(&'static str, &'static str)],
) -> (StatusCode, HeaderMap, String) {
    let mut req = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let body = crate::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, headers, String::from_utf8(body.to_vec()).unwrap())
}

/// A patch answering a browser's plain request (no `data-patch`, asking for HTML) is an error in a
/// debug build: the browser would show the fragment as the whole page. The error names the method
/// and the route (its pattern, or the path of a route the routes module does not declare) and says
/// what to answer instead; the handler's cookies and `Clear-Site-Data` go out with it, and the
/// patch's other headers do not. A refusal's patch is one too. `req.patch_or`, a handler that
/// checks `req.mode == Mode::Action`, the runtime's `data-patch` fetch and a client that does not
/// ask for HTML are not.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_patch_answering_a_browsers_plain_request_is_an_error_in_debug_builds() {
    let (router, table) = (plain_patch_router(), plain_patch_table());
    let browser = POST_PAGE_BROWSER;
    let action: &[(&str, &str)] = &[("accept", "text/html"), ("corten", "action")];
    let (status, headers, body) = plain_patch_send(&router, "POST", "/note", browser).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(
        body.contains("plain POST to /note (no data-patch, asking for HTML) was answered with a patch"),
        "it names the route outside dev too: {body}"
    );
    assert!(body.contains("req.patch_or") && body.contains("req.action()"), "and what to answer instead: {body}");
    assert!(!headers.contains_key("corten-patch"), "the error page, not the patch: {headers:?}");
    let cookies: Vec<_> = headers.get_all("set-cookie").iter().map(|c| c.to_str().unwrap()).collect();
    assert!(cookies.iter().any(|c| c.starts_with("saved=1;")), "the handler's cookie is kept: {cookies:?}");
    assert_eq!(headers.get("clear-site-data").map(|v| v.to_str().unwrap()), Some("\"cache\""), "and Clear-Site-Data");
    assert!(headers.get("x-drawn").is_none(), "the patch's own header is not: {headers:?}");
    let (status, _, body) = plain_patch_send(&router, "GET", "/items/7", browser).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "a link or a reload: {body}");
    assert!(body.contains("plain GET to /items/{id} "), "the route's pattern: {body}");
    let (status, _, body) = plain_patch_send(&router, "POST", "/refused", browser).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "a refusal's patch: {body}");
    let (status, _, body) = plain_patch_send(&table, "POST", "/table", browser).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "a hand-built route: {body}");
    assert!(body.contains("plain POST to /table "), "named by its path: {body}");
    let navigation: &[(&str, &str)] = &[("accept", "text/html"), ("sec-fetch-mode", "navigate"), ("sec-fetch-dest", "document")];
    let (status, _, body) = plain_patch_send(&router, "POST", "/note", navigation).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "a browser's own form submission, with its fetch metadata: {body}");
    // A page's own `fetch` that asks for HTML, and an `<iframe>`'s load: the patch is not shown as
    // the tab's page, so it is sent.
    for (headers, what) in [
        (&[("accept", "text/html"), ("sec-fetch-mode", "cors"), ("sec-fetch-dest", "empty")][..], "a script's fetch"),
        (&[("accept", "text/html"), ("sec-fetch-mode", "same-origin")][..], "a script's same-origin fetch"),
        (&[("accept", "text/html"), ("sec-fetch-mode", "navigate"), ("sec-fetch-dest", "iframe")][..], "an iframe's load"),
        (&[("accept", "*/*")][..], "a client that accepts anything, as a script's fetch does by default"),
    ] {
        let (status, headers, body) = plain_patch_send(&router, "POST", "/note", headers).await;
        assert_eq!((status, headers.contains_key("corten-patch")), (StatusCode::OK, true), "{what}: {body}");
    }
    // A navigation a service worker answers with navigation preload keeps its destination (probed
    // in Chromium 156 and WebKit 27.2): the tab's is checked, a frame's is not. One the worker
    // passes on with `fetch(event.request)` arrives as `navigate` to `empty`, the tab's and a
    // frame's alike, so it is not checked (a known gap, `docs/design.md#choice-plain-request-patch`).
    let preload = |dest| [("accept", "text/html"), ("sec-fetch-mode", "navigate"), ("sec-fetch-dest", dest), PRELOADED];
    let (status, _, body) = plain_patch_send(&router, "GET", "/items/7", &preload("document")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "a navigation preload for the tab: {body}");
    let passed_on: &[(&str, &str)] = &[("accept", "text/html"), ("sec-fetch-mode", "navigate"), ("sec-fetch-dest", "empty")];
    let framed = preload("iframe");
    for (headers, what) in [(&framed[..], "a navigation preload for a frame"), (passed_on, "a navigation a worker passes on")] {
        let (status, headers, body) = plain_patch_send(&router, "GET", "/items/7", headers).await;
        assert_eq!((status, headers.contains_key("corten-patch")), (StatusCode::OK, true), "{what}: {body}");
    }

    let (status, headers, body) = plain_patch_send(&router, "POST", "/or", browser).await;
    assert_eq!((status, headers.contains_key("corten-shell")), (StatusCode::OK, true), "patch_or draws the page: {body}");
    let (status, headers, _) = plain_patch_send(&router, "POST", "/or", action).await;
    assert_eq!((status, headers.contains_key("corten-patch")), (StatusCode::OK, true), "and the patch for the runtime");
    assert_eq!(plain_patch_send(&router, "POST", "/moded", browser).await.0, StatusCode::SEE_OTHER, "a Mode::Action check");
    let (status, headers, _) = plain_patch_send(&router, "POST", "/moded", action).await;
    assert_eq!((status, headers.contains_key("corten-patch")), (StatusCode::ACCEPTED, true), "its patch for the runtime");
    for (app, method, path) in [(&router, "POST", "/note"), (&router, "GET", "/items/7"), (&table, "POST", "/table")] {
        let (status, headers, body) = plain_patch_send(app, method, path, action).await;
        assert_eq!(
            (status, headers.contains_key("corten-patch")),
            (StatusCode::OK, true),
            "a data-patch fetch of {path}: {body}"
        );
        let (status, headers, body) = plain_patch_send(app, method, path, &[]).await;
        assert_eq!((status, headers.contains_key("corten-patch")), (StatusCode::OK, true), "not a browser, {path}: {body}");
    }
}

/// The header a request navigation preload sends carries.
#[cfg(debug_assertions)]
const PRELOADED: (&str, &str) = ("service-worker-navigation-preload", "true");

/// The runtime's fetch of a whole page (`corten: page`) asks for HTML as a browser does, and
/// neither check sees it: the runtime puts in place what it gets. Each answer is asserted at once,
/// so a check that saw it fails with every case it caught.
#[cfg(debug_assertions)]
#[tokio::test]
async fn the_runtimes_page_fetch_is_not_checked_in_debug_builds() {
    let (patches, pages) = (plain_patch_router(), post_page_router());
    let page_fetch: &[(&str, &str)] = &[("accept", "text/html"), ("corten", "page")];
    let (note, item, saved) = (
        plain_patch_send(&patches, "POST", "/note", page_fetch).await,
        plain_patch_send(&patches, "GET", "/items/7", page_fetch).await,
        post_page_send(&pages, "/save", page_fetch).await,
    );
    assert_eq!(
        [
            (note.0, note.1.contains_key("corten-patch"), note.2.contains(">saved</p>")),
            (item.0, item.1.contains_key("corten-patch"), item.2.contains(">item</p>")),
            (saved.0, saved.1.contains_key("corten-shell"), saved.2.contains("<p>saved</p>")),
        ],
        [(StatusCode::OK, true, true); 3],
        "the patch at /note and /items/7, the page at /save: {} | {} | {}",
        note.2,
        item.2,
        saved.2
    );
}

/// An upstream's answer a `Relay` passes on as it came is the upstream's to check: neither check
/// sees a relayed patch or a relayed page at a post-only path, each sent as it came.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_relayed_answer_is_not_checked_in_debug_builds() {
    let (patch, page) = (
        plain_patch_send(&plain_patch_router(), "POST", "/relayed", POST_PAGE_BROWSER).await,
        post_page_send(&post_page_router(), "/relayed", POST_PAGE_BROWSER).await,
    );
    assert_eq!(
        [
            (patch.0, patch.1.contains_key("corten-patch"), patch.2.as_str()),
            (page.0, page.1.contains_key("corten-shell"), page.2.as_str()),
        ],
        [(StatusCode::OK, true, r#"<p id="msg">upstream</p>"#), (StatusCode::OK, true, "<p>upstream</p>")],
        "a relayed patch, and a relayed page at a post-only path"
    );
}

/// A release build compiles none of the check: a browser's plain request gets the patch.
#[cfg(not(debug_assertions))]
#[tokio::test]
async fn a_patch_answering_a_browsers_plain_request_is_sent_in_release_builds() {
    let (router, table) = (plain_patch_router(), plain_patch_table());
    for (app, method, path) in [(&router, "POST", "/note"), (&router, "GET", "/items/7"), (&table, "POST", "/table")] {
        let (status, headers, body) = plain_patch_send(app, method, path, POST_PAGE_BROWSER).await;
        assert_eq!((status, headers.contains_key("corten-patch")), (StatusCode::OK, true), "{path}: {body}");
    }
}

#[tokio::test]
async fn a_page_that_moved_answers_301_in_every_mode_and_a_form_navigates() {
    #[derive(crate::Route)]
    #[route("/items/{slug}")]
    struct Item<'a> {
        slug: &'a str,
    }
    let routes = Table::new().route("/", get(|req: Req| async move { req.moved::<ForOne>(&Item { slug: "pika chu" }) }));
    for (mode, accept) in [(None, Some("text/html")), (Some("nav"), None), (None, Some("application/json"))] {
        let (status, headers, _) = call_with(app(routes.clone(), None), "GET", "/", mode, accept).await;
        assert_eq!(status, StatusCode::MOVED_PERMANENTLY, "{mode:?} {accept:?}");
        assert_eq!(headers["location"], "/items/pika%20chu");
        assert_eq!(headers["cache-control"], "private, max-age=86400", "the browser keeps it, no shared cache");
    }
    let (status, headers, _) = call(app(routes, None), "GET", Some("action")).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "a data-patch form is sent on, as by redirect");
    assert_eq!(headers["corten-location"], "/items/pika%20chu");
}

#[tokio::test]
async fn a_redirect_to_a_place_keeps_its_fragment_in_every_mode() {
    #[derive(crate::Route)]
    #[route("/items/{slug}")]
    struct Item<'a> {
        slug: &'a str,
    }
    #[derive(crate::view::Id)]
    struct PlaceId<'a>(&'a str);
    let routes = Table::new()
        .route("/", get(|req: Req| async move { req.redirect::<ForOne>(&Item { slug: "pika chu" }.at(PlaceId("7 & 8"))) }))
        .route("/old", get(|req: Req| async move { req.moved::<ForOne>(&Item { slug: "pika" }.at(PlaceId("7"))) }));
    let place = "/items/pika%20chu#place-7%20%26%208";
    let (status, headers, _) = call(app(routes.clone(), None), "GET", None).await;
    assert_eq!((status, &headers["location"]), (StatusCode::SEE_OTHER, &place.parse().unwrap()), "a full load follows it");
    // fetch would follow a 303 and drop the fragment, so the runtime is told where to go: for a
    // navigation, a patch's read, and the whole page it fetches after a write (`corten: page`,
    // #1034).
    for mode in ["nav", "action", "page"] {
        let (status, headers, _) = call(app(routes.clone(), None), "GET", Some(mode)).await;
        assert_eq!((status, &headers["corten-location"]), (StatusCode::NO_CONTENT, &place.parse().unwrap()), "{mode}");
    }
    for mode in ["nav", "page"] {
        let (status, headers, _) = call_with(app(routes.clone(), None), "GET", "/old", Some(mode), None).await;
        assert_eq!(
            (status, &headers["corten-location"]),
            (StatusCode::NO_CONTENT, &"/items/pika#place-7".parse().unwrap()),
            "{mode}"
        );
    }
    let (status, headers, _) = call_with(app(routes, None), "GET", "/old", None, Some("text/html")).await;
    assert_eq!((status, &headers["location"]), (StatusCode::MOVED_PERMANENTLY, &"/items/pika#place-7".parse().unwrap()));
}

/// A redirect's answer depends on the `corten` header, so it varies on it, and the runtime's is the
/// browser's alone: a cache that keys on the URL alone never hands its `corten-location` to a full
/// load, nor a full load's 303 or 301 to the runtime's `fetch`, which would drop the `#id` (#1034).
#[tokio::test]
async fn a_redirect_varies_on_the_mode_and_the_runtimes_is_not_shared() {
    #[derive(crate::Route)]
    #[route("/items/{slug}")]
    struct Item<'a> {
        slug: &'a str,
    }
    #[derive(crate::view::Id)]
    struct SpotId<'a>(&'a str);
    let minute = std::time::Duration::from_secs(60);
    let routes = Table::new()
        .route("/", get(move |req: Req| async move { Public::new(minute, req.redirect(&Item { slug: "pika" }.at(SpotId("7")))) }))
        .route("/old", get(|req: Req| async move { req.moved::<ForOne>(&Item { slug: "pika" }.at(SpotId("7"))) }))
        .route("/done", get(move |req: Req| async move { Public::new(minute, req.redirect(&Done)) }));
    for (uri, mode, status, shared) in [
        ("/", None, StatusCode::SEE_OTHER, true),
        ("/", Some("page"), StatusCode::NO_CONTENT, false),
        ("/", Some("nav"), StatusCode::NO_CONTENT, false),
        ("/old", None, StatusCode::MOVED_PERMANENTLY, false),
        ("/old", Some("page"), StatusCode::NO_CONTENT, false),
        ("/done", None, StatusCode::SEE_OTHER, true),
        ("/done", Some("page"), StatusCode::SEE_OTHER, false),
    ] {
        let (got, headers, _) = call_with(app(routes.clone(), None), "GET", uri, mode, Some("text/html")).await;
        let case = format!("{uri} {mode:?}: {headers:?}");
        assert_eq!(got, status, "{case}");
        let vary =
            headers.get_all(header::VARY).iter().flat_map(|v| v.to_str().unwrap().split(',')).any(|v| v.trim() == "corten");
        assert!(vary, "{case}");
        assert_eq!(headers[header::CACHE_CONTROL].to_str().unwrap().starts_with("public"), shared, "{case}");
    }
    // A `corten` value the runtime does not send is no fetch of its: a data client's redirect.
    let (status, headers, _) = call_with(app(routes, None), "GET", "/", Some("x"), Some("application/json")).await;
    assert_eq!((status, &headers["location"]), (StatusCode::SEE_OTHER, &"/items/pika#spot-7".parse().unwrap()));
}

/// The error page's request is asked as the failed one was: the whole page after a write keeps
/// `corten: page`, so an error page that sends the browser to a place names it in `corten-location`.
#[tokio::test]
async fn the_error_page_of_the_whole_page_after_a_write_redirects_as_its_request_would() {
    async fn moves(_: Failure, req: Req) -> HtmlResult {
        req.redirect(&Done.at(MsgId))
    }
    let router = || App::new(Routes::from(Table::new())).error_page(moves, ()).router();
    // The error page keeps the failure's status (404); what it says of the place is the mode's.
    let (_, headers, _) = call_with(router(), "GET", "/missing", Some("page"), None).await;
    assert!(headers["corten-location"] == "/done#msg" && !headers.contains_key("location"), "{headers:?}");
    let (_, headers, _) = call_with(router(), "GET", "/missing", None, Some("text/html")).await;
    assert!(headers["location"] == "/done#msg" && !headers.contains_key("corten-location"), "{headers:?}");
}

/// A client navigation's `fetch` cannot follow a redirect to another origin (the CSP's
/// `connect-src`, else CORS), so it is told where to go and the browser goes there itself; a full
/// load still gets the 303 or 301.
#[tokio::test]
async fn a_redirect_to_another_origin_is_named_to_a_client_navigation() {
    use crate::http::Uri;
    let routes = Table::new()
        .route(
            "/away",
            get(|req: Req| async move { req.redirect::<ForOne>(&"https://shop.example/sales?x=1".parse::<Uri>().unwrap()) }),
        )
        .route("/moved", get(|req: Req| async move { req.moved::<ForOne>(&"//shop.example/sales".parse::<Uri>().unwrap()) }))
        .route("/here", get(|req: Req| async move { req.redirect::<ForOne>(&Done) }));
    for (uri, to, full) in [
        ("/away", "https://shop.example/sales?x=1", StatusCode::SEE_OTHER),
        ("/moved", "//shop.example/sales", StatusCode::MOVED_PERMANENTLY),
    ] {
        for mode in ["nav", "action", "page"] {
            let (status, headers, _) = call_with(app(routes.clone(), None), "GET", uri, Some(mode), None).await;
            assert_eq!((status, &headers["corten-location"]), (StatusCode::NO_CONTENT, &to.parse().unwrap()), "{uri} {mode}");
            assert!(!headers.contains_key("location"), "{uri} {mode}: nothing for fetch to follow");
        }
        let (status, headers, _) = call_with(app(routes.clone(), None), "GET", uri, None, Some("text/html")).await;
        assert_eq!((status, &headers["location"]), (full, &to.parse().unwrap()), "{uri}: a full load follows it");
    }
    // A path on this origin is still a redirect fetch follows, in one round trip.
    for mode in ["nav", "page"] {
        let (status, headers, _) = call_with(app(routes.clone(), None), "GET", "/here", Some(mode), None).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{mode}");
        assert!(!headers.contains_key("corten-location"), "{mode}");
    }
}

/// The whole page the runtime fetches after a write (`corten: page`) is drawn as a full load's,
/// its layout and `corten-shell` included, not as a navigation's `<main>` (#1034).
#[tokio::test]
async fn the_whole_page_after_a_write_is_drawn_as_a_full_load() {
    let routes = Table::new()
        .route("/", get(|req: Req| async move { req.page::<ForOne>(Shell { req: &req, title: "A", head: "", children: "a" }) }));
    let (status, headers, body) = call(app(routes.clone(), None), "GET", Some("page")).await;
    let (_, _, full) = call(app(routes.clone(), None), "GET", None).await;
    let (_, _, nav) = call(app(routes, None), "GET", Some("nav")).await;
    assert_eq!(status, StatusCode::OK);
    let key = headers["corten-shell"].to_str().unwrap();
    assert_eq!(meta_content(&body, "corten-shell"), key, "the document, as a full load gets it");
    assert!(
        body.starts_with("<!DOCTYPE html>") && full.starts_with("<!DOCTYPE html>") && !nav.starts_with("<!DOCTYPE html>"),
        "{body}"
    );
}

/// A place on a page outside the app keeps its `#fragment` through `moved` and `redirect`, which
/// a `corten::http::Uri` alone drops.
#[tokio::test]
async fn a_redirect_to_a_place_elsewhere_keeps_its_fragment() {
    use crate::http::Uri;
    use crate::route::Elsewhere;
    static COMPARE: std::sync::LazyLock<Uri> = std::sync::LazyLock::new(|| Uri::from_static("https://example.com/compare?x=1"));
    let routes = Table::new()
        .route("/old", get(|req: Req| async move { req.moved::<ForOne>(&Elsewhere::at(&COMPARE, "fee-calculator")) }))
        .route("/go", get(|req: Req| async move { req.redirect::<ForOne>(&Elsewhere::at(&COMPARE, "fees & taxes")) }));
    let place = "https://example.com/compare?x=1#fee-calculator";
    let (status, headers, _) = call_with(app(routes.clone(), None), "GET", "/old", None, Some("text/html")).await;
    assert_eq!((status, &headers["location"]), (StatusCode::MOVED_PERMANENTLY, &place.parse().unwrap()), "a full load");
    let (status, headers, _) = call_with(app(routes.clone(), None), "GET", "/old", Some("nav"), None).await;
    assert_eq!((status, &headers["corten-location"]), (StatusCode::NO_CONTENT, &place.parse().unwrap()), "a client navigation");
    let (status, headers, _) = call_with(app(routes, None), "GET", "/go", None, Some("text/html")).await;
    let to = "https://example.com/compare?x=1#fees%20&%20taxes";
    assert_eq!((status, &headers["location"]), (StatusCode::SEE_OTHER, &to.parse().unwrap()));
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "Elsewhere::at takes a full URL outside the app")]
fn a_place_elsewhere_on_a_path_panics_in_debug_builds() {
    let path = http::Uri::from_static("/items/pika");
    let _ = crate::route::Elsewhere::at(&path, "place-7");
}

#[derive(crate::view::Id)]
struct LostRowId;

/// A message a patch sends.
#[crate::component]
fn SavedNote() -> impl crate::Patch {
    html! { <p id={MsgId}>"saved"</p> }
}

/// A table row, a patch on its own.
#[crate::component]
fn LostRow() -> impl crate::Patch {
    html! { <tr id={LostRowId}><td>"1"</td></tr> }
}

/// A patch whose table row comes after another element, which the runtime's parse (a
/// `<template>`'s content) drops. Each is a component, so the `html!` that sends them together
/// sees neither's tags: only the patch as sent shows the row after the message.
fn lost_row() -> impl crate::Patch {
    html! {
        <SavedNote />
        <LostRow />
    }
}

/// `req.patch_or` and `req.invalid_with`'s `form.draw` answering with `lost_row`.
fn lost_row_routes() -> Table {
    Table::new()
        .route(
            "/",
            crate::router::post(|req: Req| async move {
                req.patch_or::<ForOne, AnyAnswer, _, _>(lost_row(), || async { req.redirect(&Done) }).await
            }),
        )
        .route(
            "/refused",
            crate::router::post(|req: Req| async move {
                let mut errors = crate::Errors::new();
                errors.refuse(crate::Refusal::Conflict, "moved on");
                req.invalid_with::<ForOne, AnyAnswer, _, _, _, _>(
                    &errors,
                    |form| async move { form.draw(lost_row()) },
                    || async { req.redirect(&Done) },
                )
                .await
            }),
        )
}

#[tokio::test]
async fn a_patch_can_begin_with_a_row_and_include_a_note_and_another_row() {
    use crate::{Action, Patch};

    #[derive(crate::view::Id)]
    struct WholePatchRowId(u32);

    fn send<P: Patch>(action: Action<'_>, patch: P) -> HtmlResult {
        action.patch(patch)
    }

    let routes = Table::new().route(
        "/",
        crate::router::post(|req: Req| async move {
            let action = req.action().ok_or_else(crate::Error::not_found)?;
            let first = html! { <tr id={WholePatchRowId(1)}><td>"1"</td></tr> };
            // This literal loses its row alone, but the first fragment makes it safe here.
            let rest = html! {
                <p id={MsgId}>"saved"</p>
                <tr id={WholePatchRowId(2)}><td>"2"</td></tr>
            };
            send(action, Some(vec![&first as &dyn Patch, &rest]))
        }),
    );
    let (status, _, body) = call_with(app(routes, None), "POST", "/", Some("action"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        r#"<tr id="whole-patch-row-1"><td>1</td></tr><p id="msg">saved</p><tr id="whole-patch-row-2"><td>2</td></tr>"#
    );
}

/// A debug build answers a patch the browser would lose part of with an error that names the
/// element lost and the one that came first, outside `corten dev` too: through `action.patch` (here
/// `patch_or`) and a refusal's `form.draw`.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_patch_the_browser_would_lose_part_of_is_an_error_in_debug_builds() {
    for path in ["/", "/refused"] {
        let (status, _, body) = call_with(app(lost_row_routes(), None), "POST", path, Some("action"), None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{path}: {body}");
        let named = crate::escape(r#"<tr id="lost-row"> is dropped, since <p id="msg"> comes first"#);
        assert!(body.contains(&named), "{path}: {body}");
    }
}

#[cfg(debug_assertions)]
#[derive(crate::view::Id)]
struct LostColId;

/// The area's stylesheet links Corten writes after a patch's elements are read with them: after a
/// leading `<col>` the browser drops them, so the patch would go in unstyled.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_patch_whose_area_stylesheet_the_browser_would_drop_is_an_error_in_debug_builds() {
    async fn col_patch(req: Req) -> HtmlResult {
        req.action().ok_or_else(crate::Error::not_found)?.patch(html! { <col id={LostColId}> })
    }
    let router = App::new(Routes::new())
        .area::<Shop>(|shop| shop.route::<ShopItem>(crate::Methods::reads(get(col_patch))).components(&[COST_STYLED]))
        .router();
    let (status, _, body) = call_with(router, "GET", "/shop/item", Some("action"), None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(body.contains(&crate::escape("the area's stylesheet (<link")), "{body}");
    assert!(body.contains(&crate::escape(r#"since <col id="lost-col"> comes first"#)), "{body}");
}

/// A release build compiles none of the check: the patch is sent as drawn.
#[cfg(not(debug_assertions))]
#[tokio::test]
async fn a_patch_the_browser_would_lose_part_of_is_sent_in_release_builds() {
    for (path, status) in [("/", StatusCode::OK), ("/refused", StatusCode::CONFLICT)] {
        let (got, headers, body) = call_with(app(lost_row_routes(), None), "POST", path, Some("action"), None).await;
        assert_eq!(got, status, "{path}: {body}");
        assert_eq!(headers["corten-patch"], "1", "{path}");
        assert_eq!(body, r#"<p id="msg">saved</p><tr id="lost-row"><td>1</td></tr>"#, "{path}");
    }
}

// These fixtures exercise the patch parser on exact script bytes, including text a macro at
// an unknown insertion point cannot write as a literal.
fn note_script(text: &'static str) -> impl crate::Patch {
    use std::sync::atomic::AtomicUsize;
    static SIZE: AtomicUsize = AtomicUsize::new(0);
    crate::view::Html::new(&SIZE, move |out: &mut String| {
        out.push_str(r#"<script id="note-script" type="text/x-template">"#);
        out.push_str(text);
        out.push_str("</script>");
        crate::view::__private::Yes
    })
}

/// A data block whose text has `<!--` and a tag that begins like `<script` (`<scriptx>`, which
/// hides no end tag), then the message and the row.
fn lost_after_script() -> impl crate::Patch {
    html! {
        {note_script("<!-- <scriptx> -->")}
        <SavedNote />
        <LostRow />
    }
}

/// The check reads a script's text as the tokenizer does, so what follows a script with `<!--` in
/// its text is checked: the row after the message is an error in a debug build.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_patch_lost_after_a_script_with_a_comment_in_its_text_is_an_error_in_debug_builds() {
    let routes = Table::new().route(
        "/",
        crate::router::post(|req: Req| async move {
            req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(lost_after_script())
        }),
    );
    let (status, _, body) = call_with(app(routes, None), "POST", "/", Some("action"), None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    let named = crate::escape(r#"<tr id="lost-row"> is dropped, since <p id="msg"> comes first"#);
    assert!(body.contains(&named), "{body}");
}

#[derive(crate::view::Id)]
struct HeadFontId;

/// `html!` writes an end tag for a `<basefont>` and a `<param>`, which the browser ignores: the
/// checks read past them, so the loss beside them is found in what `html!` writes.
#[test]
fn the_patch_checks_read_the_void_end_tags_html_writes() {
    let headed = html! {
        <basefont id={HeadFontId} />
        <SavedNote />
        <LostRow />
    }
    .to_html();
    let object = html! {
        <SavedNote />
        <tr id={LostRowId}>
            <td>
                <object type="image/svg+xml">
                    <param name="a" value="1" />
                    "fallback"
                </object>
            </td>
        </tr>
    }
    .to_html();
    for html in [headed, object] {
        assert_eq!(crate::html::patch_problem(&html), None, "{html}");
        let parse = crate::html::patch_parse(&html);
        assert_eq!(parse.problem.as_deref(), Some(r#"<tr id="lost-row"> is dropped, since <p id="msg"> comes first"#), "{html}");
        assert_eq!(parse.unread, None, "{html}");
    }
}

/// A patch the parse check cannot read to its end (an `<li>` closed by the next `<li>`, which
/// `raw` markup can write) is sent, and a debug build logs where the check stopped, so it is not
/// passed in silence.
#[cfg(all(debug_assertions, feature = "log"))]
#[tokio::test]
async fn a_patch_the_parse_check_cannot_read_is_logged_in_debug_builds() {
    use std::sync::Arc;
    let routes = Table::new().route(
        "/list",
        crate::router::post(|req: Req| async move {
            req.action()
                .ok_or_else(crate::Error::not_found)?
                .patch::<ForOne, AnyAnswer>(html! { <ul id={MsgId}>{crate::raw("<li>one<li>two")}</ul> })
        }),
    );
    let lines = Lines(Arc::default());
    let writer = lines.clone();
    let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
    let _logging = tracing::subscriber::set_default(subscriber);
    let (status, _, body) = call_with(app(routes, None), "POST", "/list", Some("action"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
    assert!(
        text.contains("corten: the debug check of what the browser keeps of the patch for /list read it only up to <li> in <li>, which closes the <li> open around it"),
        "{text}"
    );
}

#[derive(crate::view::Id)]
struct NoteEndId;

/// Two data blocks whose text opens with `<!--<script>` and ends with `-->`, around the message:
/// the browser reads the first block to the second's end tag, so the message is its text, which
/// the markup does not say is not what was meant. The check stops there and a debug build logs it,
/// rather than passing it as read (#1409).
#[cfg(all(debug_assertions, feature = "log"))]
#[tokio::test]
async fn a_patch_whose_script_text_carries_it_past_an_element_is_logged_in_debug_builds() {
    use std::sync::Arc;
    let routes = Table::new().route(
        "/blocks",
        crate::router::post(|req: Req| async move {
            req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(html! {
                {note_script("<!--<script>")}
                <SavedNote />
                <script id={NoteEndId} type="text/x-template">"-->"</script>
                <LostRow />
            })
        }),
    );
    let lines = Lines(Arc::default());
    let writer = lines.clone();
    let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
    let _logging = tracing::subscriber::set_default(subscriber);
    let (status, _, body) = call_with(app(routes, None), "POST", "/blocks", Some("action"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
    assert!(
        text.contains(r#"read it only up to <script id="note-script" type="text/x-template">, whose text a <!-- and a <script in it carry past its first </script>"#),
        "{text}"
    );
}

/// Markup placed with `raw` that the parse check does not read as the browser does is checked only
/// up to there, and a debug build logs where it stopped rather than refusing the patch: an end tag
/// written `</div ignored>`, which closes the `<div>` so the row after it is kept (a refusal would
/// be a false 500); a `</bogus>` before a form's control, which a table's reading moves out of it;
/// a `<col>` the patch ends in before its quote and `>`, which the browser drops, keeping the
/// `<div>` whole (a refusal would be a false 500); and an `<image>`, which the browser reads as
/// an `<img>`, dropping the row it holds (#1409).
#[cfg(all(debug_assertions, feature = "log"))]
#[tokio::test]
async fn a_patch_with_tokens_the_parse_check_does_not_read_is_sent_and_logged_in_debug_builds() {
    use std::sync::Arc;
    let routes = Table::new()
        .route(
            "/decorated",
            crate::router::post(|req: Req| async move {
                req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(html! {
                    <LostRow />
                    <div id={MsgId}>{crate::raw(r#"</div ignored><tr id="kept"></tr>"#)}</div>
                })
            }),
        )
        .route(
            "/form",
            crate::router::post(|req: Req| async move {
                req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(html! {
                    <LostRow />
                    <div id={NoteEndId}>{crate::raw(r#"<form></bogus><input name="q"></form>"#)}</div>
                })
            }),
        )
        .route(
            "/col",
            crate::router::post(|req: Req| async move {
                req.action()
                    .ok_or_else(crate::Error::not_found)?
                    .patch::<ForOne, AnyAnswer>(html! { <div id={MsgId}>{crate::raw("</div><col data-note='")}</div> })
            }),
        )
        .route(
            "/image",
            crate::router::post(|req: Req| async move {
                req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(html! {
                    <div id={MsgId}>{crate::raw(r#"</div><image id="i"><tr id="r"><td>1</td></tr></image>"#)}</div>
                })
            }),
        )
        .route(
            "/doctype",
            crate::router::post(|req: Req| async move {
                req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(html! {
                    <div id={MsgId}>{crate::raw(r#"</div><!DOCTYPE html PUBLIC "><tr id='r'></tr>">"#)}</div>
                })
            }),
        )
        .route(
            "/reference",
            crate::router::post(|req: Req| async move {
                req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(html! {
                    <LostRow />
                    <form id={NoteEndId}>{crate::raw("&bogus;")}</form>
                })
            }),
        );
    let lines = Lines(Arc::default());
    let writer = lines.clone();
    let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
    let _logging = tracing::subscriber::set_default(subscriber);
    let app = app(routes, None);
    for (path, stopped) in [
        ("/decorated", "the patch for /decorated read it only up to the end tag </div ignored>, which is not written </name>"),
        (
            "/form",
            "the patch for /form read it only up to </bogus> in <form>, which the check of what a form holds does not read",
        ),
        ("/col", "the patch for /col read it only up to <col data-note='</div>, a start tag the patch ends in before its >"),
        (
            "/image",
            r#"the patch for /image read it only up to <image id="i">, which a browser reads as an <img>, an element with no end tag"#,
        ),
        (
            "/doctype",
            r#"the patch for /doctype read it only up to the doctype <!DOCTYPE html PUBLIC ">, which the check does not read"#,
        ),
        (
            "/reference",
            r#"the patch for /reference read it only up to &bogus; in <form id="note-end">, which the check of what a form holds does not read"#,
        ),
    ] {
        let (status, _, body) = call_with(app.clone(), "POST", path, Some("action"), None).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
        assert!(text.contains(stopped), "{path}: {text}");
    }
}

/// Characters past ASCII in the names, values and text of markup placed with `raw` are read
/// without a panic, and the check reads on past them to the row the browser drops; text a
/// `<form>` holds is read with its character references decoded, so a `&#32;`, which the browser
/// reads as a space, is not a loss, and a `&nbsp;`, which it moves out of the form, is (#1409).
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_patch_s_characters_past_ascii_and_references_are_read_as_the_browser_reads_them() {
    let routes = Table::new()
        .route(
            "/multibyte",
            crate::router::post(|req: Req| async move {
                req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(html! {
                    <SavedNote />
                    <div id={NoteEndId}>
                        {crate::raw("<span \u{e9}=\"x\" data-\u{e9}='\u{65e5}>'>\u{e9}t\u{e9}</span><x-\u{e9}>\u{65e5}</x-\u{e9}>")}
                    </div>
                    <LostRow />
                })
            }),
        )
        .route(
            "/space",
            crate::router::post(|req: Req| async move {
                req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(html! {
                    <LostRow />
                    <form id={NoteEndId}>{crate::raw("&#32;")}</form>
                })
            }),
        )
        .route(
            "/nbsp",
            crate::router::post(|req: Req| async move {
                req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(html! {
                    <LostRow />
                    <form id={NoteEndId}>{crate::raw("&nbsp;")}</form>
                })
            }),
        );
    let app = app(routes, None);
    let (status, _, body) = call_with(app.clone(), "POST", "/multibyte", Some("action"), None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(body.contains(&crate::escape(r#"<tr id="lost-row"> is dropped, since <p id="msg"> comes first"#)), "{body}");
    let (status, _, body) = call_with(app.clone(), "POST", "/space", Some("action"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _, body) = call_with(app, "POST", "/nbsp", Some("action"), None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(
        body.contains(&crate::escape(r#"<form id="note-end"> loses what it holds, since <tr id="lost-row"> comes first"#)),
        "{body}"
    );
}

#[derive(crate::view::Id)]
struct CostRowId(u32);

/// A patch of 50 table rows, each with three cells, one of them holding a form.
fn fifty_rows() -> impl crate::Patch {
    html! {
        for n in 0..50u32 {
            <tr id={CostRowId(n)}>
                <td>"Item "{n}</td>
                <td>{n * 3}</td>
                <td><form method="post"><input type="hidden" name="row" value={n}><button>"Save"</button></form></td>
            </tr>
        }
    }
}

/// What the debug check of a patch's parse costs a debug build, which every test is: a 50-row patch
/// (`fifty_rows`) checked `PARSE_ROUNDS` times (2,000 by default), timed beside the same patch sent
/// through `action.patch` in process, which includes one check. Run in a debug build:
/// `cargo test -p corten-run --all-features --lib -- --ignored --exact tests::patches::what_the_patch_parse_check_costs --nocapture`.
#[test]
#[ignore]
fn what_the_patch_parse_check_costs() {
    use std::time::Instant;
    let rounds: u32 = std::env::var("PARSE_ROUNDS").ok().and_then(|n| n.parse().ok()).unwrap_or(2000);
    let body = fifty_rows().to_html();
    assert_eq!(crate::html::patch_parse_problem(&body), None);
    let start = Instant::now();
    for _ in 0..rounds {
        std::hint::black_box(crate::html::patch_parse_problem(std::hint::black_box(&body)));
    }
    let check = start.elapsed().as_secs_f64() * 1e6 / f64::from(rounds);
    let routes = Table::new().route(
        "/",
        crate::router::post(|req: Req| async move {
            req.action().ok_or_else(crate::Error::not_found)?.patch::<ForOne, AnyAnswer>(fifty_rows())
        }),
    );
    let router = app(routes, None);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let requests = rounds / 10;
    let start = Instant::now();
    runtime.block_on(async {
        for _ in 0..requests {
            let (status, _, sent) = call(router.clone(), "POST", Some("action")).await;
            assert!(status == StatusCode::OK && sent.len() == body.len(), "{status}");
        }
    });
    let request = start.elapsed().as_secs_f64() * 1e6 / f64::from(requests);
    println!(
        "debug={}: {} bytes; check {check:.1} us; action.patch request {request:.1} us (the check is {:.1}% of it)",
        cfg!(debug_assertions),
        body.len(),
        100.0 * check / request
    );
}

/// The small component the patches of [`what_a_patch_costs`] and
/// [`what_a_patch_in_an_area_costs`] answer with.
#[derive(crate::view::Id)]
struct CostNoteId;

#[crate::component]
fn CostNote() -> impl crate::view::Patch {
    html! { <p id={CostNoteId}>"Saved"</p> }
}

/// The list the large patches [`what_a_patch_costs`] answers with replace.
#[derive(crate::view::Id)]
struct CostListId;

/// The large patch as a component: about 4 KiB.
#[crate::component]
fn CostList() -> impl crate::view::Patch {
    html! {
        <ul id={CostListId}>
            for n in 0..100u32 {
                <li>"Row "{n}" of the list a patch sends"</li>
            }
        </ul>
    }
}

/// A component's string starts at the size the component last rendered to, as an `html!` call
/// site's does, and never below 256 bytes: the second render allocates once, at the size it needs.
#[test]
fn a_component_renders_into_a_string_sized_by_its_last_render() {
    let first = CostList {}.to_html();
    let second = CostList {}.to_html();
    assert_eq!(first, second);
    assert!(first.len() > 4000, "{}", first.len());
    assert_eq!(second.capacity(), first.len() + first.len() / 8);
    assert_eq!(CostNote {}.to_html().capacity(), 256);
}

/// A component behind a reference, a `Box` or an `Option` keeps its own size: each forwards
/// `to_html` to the view inside, where the trait's default would render into an empty string and
/// grow it. Called through the wrapper's own impl (`<W as Render>::to_html`), which method syntax
/// would skip by dereferencing to the component.
#[test]
fn a_wrapped_component_renders_into_a_string_sized_by_its_last_render() {
    let sized = CostList {}.to_html();
    let size = sized.len() + sized.len() / 8;
    let large = [
        ("&T", <&CostList as Render>::to_html(&&CostList {})),
        ("Box<T>", <Box<CostList> as Render>::to_html(&Box::new(CostList {}))),
        ("Some", <Option<CostList> as Render>::to_html(&Some(CostList {}))),
    ];
    // A small component's string is never below 256 bytes behind a wrapper either.
    let small = [
        ("&T", <&CostNote as Render>::to_html(&&CostNote {})),
        ("Box<T>", <Box<CostNote> as Render>::to_html(&Box::new(CostNote {}))),
        ("Some", <Option<CostNote> as Render>::to_html(&Some(CostNote {}))),
    ];
    for (wrapper, html) in &large {
        assert_eq!(*html, sized, "{wrapper}");
    }
    let missed: Vec<_> = large
        .iter()
        .map(|(wrapper, html)| (*wrapper, html.capacity(), size))
        .chain(small.iter().map(|(wrapper, html)| (*wrapper, html.capacity(), 256)))
        .filter(|(_, capacity, wanted)| capacity != wanted)
        .collect();
    assert!(missed.is_empty(), "(wrapper, capacity, wanted): {missed:?}");
    // None renders nothing and allocates nothing.
    let none = <Option<CostList> as Render>::to_html(&None);
    assert_eq!((none.as_str(), none.capacity()), ("", 0));
}

/// What a patch costs: `PATCH_REQUESTS` (200) action requests in process, one at a time, of the
/// patch `PATCH_KIND` names: `component` (the default), a small `#[component]`; `html`, the
/// same markup as a bare `html!`; `large`, a component of about 4 KiB; `mixed`, a bare
/// `Remove` (45 bytes) and a bare `html!` of about 4 KiB in turn. Counting it under callgrind at
/// two numbers of requests gives the instructions per request. The test binary has no global
/// allocator, so preload the one to count with. Run in release:
/// `cargo test --release -p corten-run --all-features --lib --no-run`, then
/// `PATCH_REQUESTS=1200 LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 valgrind --tool=callgrind <that binary> --ignored --exact tests::patches::what_a_patch_costs`
/// (Debian's `libjemalloc2`) and again at 200.
#[test]
#[ignore]
fn what_a_patch_costs() {
    let requests: usize = std::env::var("PATCH_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let kind = std::env::var("PATCH_KIND").unwrap_or_else(|_| "component".to_string());
    async fn note(req: Req) -> HtmlResult {
        req.action().ok_or_else(crate::Error::not_found)?.patch(CostNote {})
    }
    async fn bare(req: Req) -> HtmlResult {
        req.action().ok_or_else(crate::Error::not_found)?.patch(html! { <p id={CostNoteId}>"Saved"</p> })
    }
    async fn list(req: Req) -> HtmlResult {
        req.action().ok_or_else(crate::Error::not_found)?.patch(CostList {})
    }
    async fn remove(req: Req) -> HtmlResult {
        req.action().ok_or_else(crate::Error::not_found)?.patch(crate::view::Remove(CostNoteId))
    }
    async fn bare_list(req: Req) -> HtmlResult {
        req.action().ok_or_else(crate::Error::not_found)?.patch(html! {
            <ul id={CostListId}>
                for n in 0..100u32 {
                    <li>"Row "{n}" of the list a patch sends"</li>
                }
            </ul>
        })
    }
    let router = App::new(Routes::from(
        Table::new()
            .route("/cost/note", get(note))
            .route("/cost/bare", get(bare))
            .route("/cost/list", get(list))
            .route("/cost/remove", get(remove))
            .route("/cost/bare-list", get(bare_list)),
    ))
    .router();
    let paths: &[(&str, &str)] = match kind.as_str() {
        "component" => &[("/cost/note", r#"<p id="cost-note">Saved</p>"#)],
        "html" => &[("/cost/bare", r#"<p id="cost-note">Saved</p>"#)],
        "large" => &[("/cost/list", r#"<ul id="cost-list"><li>Row 0 "#)],
        "mixed" => &[
            ("/cost/remove", r#"<template id="cost-note" data-remove></template>"#),
            ("/cost/bare-list", r#"<ul id="cost-list"><li>Row 0 "#),
        ],
        other => panic!("PATCH_KIND {other}"),
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        for (path, starts) in paths.iter().cycle().take(requests) {
            let (status, _, body) = call_with(router.clone(), "GET", path, Some("action"), None).await;
            assert!(status == StatusCode::OK && body.starts_with(starts), "{path} {status}: {body}");
        }
    });
}

/// A component with a stylesheet, which the area lists, so the area has a section stylesheet.
const COST_STYLED: crate::Component = crate::Component {
    name: "CostStyled",
    script: None,
    style: Some(crate::style::Style {
        name: "cost-styled",
        file: "cost_styled.css",
        css: ".cost-styled__a{color:red}",
        classes: &["a"],
        media: &[],
        breakpoints: &[],
    }),
    event: None,
    view: None,
    anchor: &0,
};

/// What a patch costs where its handler is: `PATCH_REQUESTS` (200) action requests in process,
/// one at a time. `PATCH_WHERE` is where: `styled`, a handler in an area that lists a styled
/// component, so its patch links the area's stylesheet; `plain` (the default), the same handler
/// at the same path in an app whose area lists none; `outside`, the same handler at an app route
/// `/elsewhere/item`, outside the area, which lists the styled component as in `styled`.
/// Counting it under callgrind at two numbers of requests gives the instructions per request. Run
/// in release: `cargo test --release -p corten-run --all-features --lib --no-run`, then
/// `PATCH_REQUESTS=1200 LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 valgrind --tool=callgrind <that binary> --ignored --exact tests::patches::what_a_patch_in_an_area_costs`
/// (Debian's `libjemalloc2`) and again at 200.
#[test]
#[ignore]
fn what_a_patch_in_an_area_costs() {
    let requests: usize = std::env::var("PATCH_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let at = std::env::var("PATCH_WHERE").unwrap_or_else(|_| "plain".to_string());
    async fn cost_patch(req: Req) -> HtmlResult {
        req.action().ok_or_else(crate::Error::not_found)?.patch(CostNote {})
    }
    // The styled component in the area, or in the app's one stylesheet, which no patch links.
    let (shared, listed): (&'static [crate::Component], &'static [crate::Component]) =
        if at == "plain" { (&[COST_STYLED], &[]) } else { (&[], &[COST_STYLED]) };
    let outside = at == "outside";
    // The app's own route only where the patch is outside the area: `styled` and `plain` are the
    // app they were.
    let routes = if outside { Routes::from(Table::new().route("/elsewhere/item", get(cost_patch))) } else { Routes::new() };
    let router = App::new(routes)
        .components(shared)
        .area::<Shop>(|shop| shop.route::<ShopItem>(crate::Methods::reads(get(cost_patch))).components(listed))
        .router();
    let path = if outside { "/elsewhere/item" } else { "/shop/item" };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        for _ in 0..requests {
            let (status, _, body) = call_with(router.clone(), "GET", path, Some("action"), None).await;
            assert!(status == StatusCode::OK && body.starts_with(r#"<p id="cost-note">Saved</p>"#), "{status}: {body}");
        }
    });
}

/// A JSON answer for [`what_a_request_in_an_area_costs`].
#[cfg(feature = "json")]
#[derive(crate::ToJson)]
struct CostQuote {
    id: u32,
    price: u32,
}

/// What a staged request costs where it is found: `SCOPE_REQUESTS` (200) requests in process,
/// one at a time, in an app with two areas (one inside the other) and an API, each with a
/// deadline, a body limit and middleware of its own and the areas a CSP source (`SCOPE_AREAS=1`),
/// or in an app with none, where the same handlers are the app's own routes. `SCOPE_TARGET` is
/// the request: `page` (the inner area's page), `json` (the API's JSON), `slug` (the same page at
/// an app route `/{slug}`), or `routed` and `rest` (the same page outside every area, at an app
/// route `/elsewhere/item` and through an app catch-all `/{*rest}` beside it). Counting it under
/// callgrind at two numbers of requests gives the instructions per request. The test binary has
/// no global allocator, so preload the one to count with. Run in release:
/// `cargo test --release -p corten-run --all-features --lib --no-run`, then
/// `SCOPE_REQUESTS=1200 LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 valgrind --tool=callgrind <that binary> --ignored --exact tests::patches::what_a_request_in_an_area_costs`
/// (Debian's `libjemalloc2`) and again at 200.
#[cfg(feature = "json")]
#[test]
#[ignore]
fn what_a_request_in_an_area_costs() {
    let requests: usize = std::env::var("SCOPE_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let areas = std::env::var("SCOPE_AREAS").is_ok_and(|v| v == "1");
    let target = std::env::var("SCOPE_TARGET").unwrap_or_else(|_| "page".to_string());
    async fn cost_item(req: Req) -> HtmlResult {
        req.test_page("Item", html! { <p>"item"</p> })
    }
    async fn cost_quote() -> crate::JsonResult<CostQuote> {
        Ok(crate::Json(CostQuote { id: 7, price: 1250 }))
    }
    let page = || get(cost_item);
    let quote = || get(cost_quote);
    // The app's own routes a target adds.
    let own = |table: Table| match target.as_str() {
        "slug" => table.route("/{slug}", page()),
        "routed" | "rest" => table.route("/elsewhere/item", page()).route("/{*rest}", page()),
        _ => table,
    };
    let router = if areas {
        App::new(Routes::from(own(Table::new().route("/", page()))))
            .deadline(Duration::from_secs(5))
            .area::<Shop>(|shop| {
                shop.route::<ShopItem>(crate::Methods::reads(page()))
                    .deadline(Duration::from_secs(8))
                    .body_limit(64 << 10)
                    .policy(|p| p.img_src("https://img.example"))
                    .middleware(Step("shop", false))
            })
            .area::<ShopDesk>(|desk| {
                desk.route::<ShopDeskItem>(crate::Methods::reads(page()))
                    .deadline(Duration::from_secs(9))
                    .body_limit(32 << 10)
                    .policy(|p| p.script_src("https://js.example"))
                    .middleware(Step("desk", false))
            })
            .api::<ApiRoot>(|api| {
                api.route::<ApiQuote>(crate::Methods::reads(quote()))
                    .deadline(Duration::from_secs(7))
                    .body_limit(16 << 10)
                    .middleware(Step("api", false))
            })
            .router()
    } else {
        App::new(Routes::from(own(Table::new().route("/", page()).route("/shop/desk/item", page()).route("/api/quote", quote()))))
            .router()
    };
    let (path, answer) = match target.as_str() {
        "json" => ("/api/quote", r#"{"id":7,"price":1250}"#),
        "slug" => ("/item", "<p>item</p>"),
        "routed" => ("/elsewhere/item", "<p>item</p>"),
        "rest" => ("/elsewhere/other", "<p>item</p>"),
        _ => ("/shop/desk/item", "<p>item</p>"),
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        for _ in 0..requests {
            let (status, _, body) = call_with(router.clone(), "GET", path, None, None).await;
            assert!(status == StatusCode::OK && body.contains(answer), "{status}: {body}");
        }
    });
}

#[tokio::test]
async fn req_reads_mode_after_an_earlier_extractor_changes_accept() {
    struct Rewrite;

    impl crate::extract::FromRequestParts<()> for Rewrite {
        type Rejection = std::convert::Infallible;

        async fn from_request_parts(parts: &mut http::request::Parts, _: &()) -> Result<Self, Self::Rejection> {
            parts.headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
            Ok(Self)
        }
    }

    let routes = Table::new().route(
        "/",
        get(|_: Rewrite, req: Req| async move {
            assert_eq!(req.mode, Mode::Data);
            "answer"
        }),
    );
    let router = App::new(Routes::from(routes)).router();
    let req = Request::get("/").header(header::ACCEPT, "text/html").body(Body::empty()).unwrap();
    assert_eq!(router.oneshot(req).await.unwrap().status(), StatusCode::OK);
}
