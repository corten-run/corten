use super::*;

/// A failure that becomes the error page keeps what the handler and the middleware said besides
/// the body (a request id, `Retry-After`, every `Server-Timing` value, what it varies on beside
/// what the error page does), in every mode; the error page's own type and `Cache-Control` win.
#[tokio::test]
async fn the_error_page_keeps_the_headers_of_the_failure_it_replaces() {
    use crate::http::header;
    async fn must_sign_in() -> crate::Result<&'static str> {
        Err(crate::Refused::sign_in(&caller_url::SignIn))?;
        Ok("never")
    }
    let routes = Table::new()
        .route(
            "/busy",
            get(|| async {
                (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "30"), (header::CONTENT_TYPE, "text/x-old")])
            }),
        )
        .route("/mine", get(must_sign_in));
    let router = App::new(Routes::from(routes)).error_page(test_error_page, ()).middleware(Stamp).router();
    for mode in [None, Some("nav")] {
        for (uri, flood, status, retry) in
            [("/nope", false, 404, None), ("/busy", false, 429, Some("30")), ("/nope", true, 429, Some("7"))]
        {
            let mut req = Request::get(uri).header("accept", "text/html");
            if let Some(mode) = mode {
                req = req.header("corten", mode);
            }
            if flood {
                req = req.header("x-flood", "1");
            }
            let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let at = format!("{mode:?} {uri} flood={flood}");
            assert_eq!(res.status().as_u16(), status, "{at}");
            let headers = res.headers();
            assert_eq!(headers["x-request-id"], "r-1", "{at}");
            let timing: Vec<_> = headers.get_all("server-timing").iter().collect();
            assert_eq!(timing, ["app;dur=1", "db;dur=2"], "{at}");
            let vary: Vec<_> = headers.get_all(header::VARY).iter().flat_map(|v| v.to_str().unwrap().split(", ")).collect();
            assert!(vary.contains(&"origin") && vary.contains(&"corten"), "{at}: {vary:?}");
            assert_eq!(headers.get(header::RETRY_AFTER).map(|v| v.to_str().unwrap()), retry, "{at}");
            assert!(headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/html"), "{at}: {headers:?}");
            assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache", "{at}: an error page is never shared");
            let body = res.into_body().collect().await.unwrap().to_bytes();
            assert!(String::from_utf8_lossy(&body).contains("<h1>"), "{at}: the error page");
        }
        // A refusal that sends the caller to sign in keeps them too, and varies on both, once each.
        let mut req = Request::get("/mine").header("accept", "text/html");
        if let Some(mode) = mode {
            req = req.header("corten", mode);
        }
        let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(
            (res.status(), &res.headers()[header::LOCATION]),
            (StatusCode::SEE_OTHER, &"/sign-in".parse().unwrap()),
            "{mode:?}"
        );
        assert_eq!(res.headers()["x-request-id"], "r-1", "{mode:?}");
        let vary: Vec<_> = res.headers().get_all(header::VARY).iter().flat_map(|v| v.to_str().unwrap().split(", ")).collect();
        assert_eq!(vary.iter().filter(|v| **v == "origin").count(), 1, "{mode:?}: {vary:?}");
        assert_eq!(vary.iter().filter(|v| **v == "corten").count(), 1, "{mode:?}: {vary:?}");
    }
}

/// The error page is drawn in the language the request asked for, as the page it replaces would
/// have been: its `Req` reads the `Accept-Language` the request came with, in every mode.
#[tokio::test]
async fn the_error_page_is_in_the_language_asked_for() {
    crate::i18n::messages! { struct ErrorMsg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
    async fn in_lang(_: Failure, req: Req) -> HtmlResult {
        let lang = req.lang();
        req.test_page("Not found", html! { <p>"in "{lang}</p> })
    }
    let router = App::new(Routes::from(Table::new())).error_page(in_lang, ()).messages::<ErrorMsg>().router();
    for mode in [None, Some("nav")] {
        for (asked, lang) in [("fr-CA, en;q=0.5", "fr"), ("en", "en"), ("de", "en")] {
            let mut req = Request::get("/nope").header("accept", "text/html").header("accept-language", asked);
            if let Some(mode) = mode {
                req = req.header("corten", mode);
            }
            let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(res.status(), StatusCode::NOT_FOUND);
            let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
            assert!(body.contains(&format!("<p>in {lang}</p>")), "{mode:?} {asked}: {body}");
            if mode.is_none() {
                assert!(body.contains(&format!(r#"<html lang="{lang}">"#)), "{asked}: {body}");
            }
        }
    }
}

/// The `Vary` each HTML answer leaves `Req` with, before the app's own stage settles the language
/// (which would hide a page sent with the fixed line, as a page that reads its locale is named
/// there again): a page ends with what [`Req::vary`] says of the request, a patch and a refused
/// form's patch with the fixed line, even in an app whose pages vary on `Accept-Language`, and
/// each with one line.
#[tokio::test]
async fn a_page_varies_as_its_request_does_and_a_patch_as_every_patch_does() {
    use crate::i18n::Messages as _;
    use crate::page::{default_error_page, error_page_fn, Shared};
    use std::sync::Arc;
    crate::i18n::messages! { struct VaryMsg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
    let req = |locales: bool, mode: Option<&'static str>| {
        let mut shared = Shared::new(error_page_fn(default_error_page, ()), None, String::new());
        if locales {
            shared.locales = Some(VaryMsg::LOCALES);
        }
        let mut req = Request::post("/").header("accept-language", "fr");
        if let Some(mode) = mode {
            req = req.header("corten", mode);
        }
        let (mut parts, ()) = req.body(()).unwrap().into_parts();
        parts.extensions.insert(crate::Signal::for_app(Arc::new(shared), 0));
        async move { <Req as crate::extract::FromRequestParts<()>>::from_request_parts(&mut parts, &()).await.unwrap() }
    };
    let vary = |res: &Response| {
        res.headers().get_all(http::header::VARY).iter().map(|v| v.to_str().unwrap().to_string()).collect::<Vec<_>>()
    };
    // Reads no locale, so only `App::messages` makes it vary on the language.
    let page = |req: &Req| {
        let doc = html! {
            <html>
                <head>
                    <title>"A"</title>
                    <Corten />
                </head>
                <body><main>"a"</main></body>
            </html>
        };
        req.page::<ForOne>(doc).unwrap().0
    };
    let language = ["corten, accept, accept-language"];
    let fixed = ["corten, accept"];
    for mode in [None, Some("nav")] {
        assert_eq!(vary(&page(&req(true, mode).await)), language, "{mode:?}: with messages");
        let chosen = req(true, mode).await;
        chosen.set_locale(crate::i18n::Locale::of(VaryMsg::for_locale("fr")));
        assert_eq!(vary(&page(&chosen)), fixed, "{mode:?}: a locale the URL chose");
        assert_eq!(vary(&page(&req(false, mode).await)), fixed, "{mode:?}: nothing read");
        let read = req(false, mode).await;
        let _: VaryMsg = read.t();
        assert_eq!(vary(&page(&read)), language, "{mode:?}: messages read");
    }
    for locales in [true, false] {
        let action = req(locales, Some("action")).await;
        let res = action
            .patch_or_with::<ForOne, crate::Patches, _, _, _, _>(
                |action| async move { action.patch(html! { <p id={MsgId}>"saved"</p> }) },
                || async { unreachable!("an action draws its patch") },
            )
            .await
            .unwrap();
        assert_eq!(vary(&res.0), fixed, "a patch, messages {locales}");
        let action = req(locales, Some("action")).await;
        let mut errors = crate::Errors::new();
        errors.refuse(crate::Refusal::Conflict, "moved on");
        let res = action
            .invalid_with::<ForOne, crate::Patches, _, _, _, _>(
                &errors,
                |form| async move { form.draw(html! { <p id={MsgId}>"refused"</p> }) },
                || async { unreachable!("an action draws its patch") },
            )
            .await
            .unwrap();
        assert_eq!(vary(&res.0), fixed, "a refused form's patch, messages {locales}");
    }
}

#[tokio::test]
async fn a_bare_router_renders_the_page_s_document_without_a_policy() {
    let (status, headers, body) = call(routes(), "GET", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["vary"], "corten, accept");
    assert!(body.starts_with(r#"<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">"#), "{body}");
    assert!(body.contains(r#"<title>A &amp; B</title><meta name="description" content="About A" data-corten-head>"#));
    assert!(body.contains(&format!(r#"<script type="module" src="{}"></script>"#, runtime_path())));
    assert!(!body.contains("modulepreload"), "a page without handlers preloads no scripts");
    assert!(body.contains("<p>&lt;script&gt;</p>"), "page text is escaped");
    assert!(!body.contains("nonce"), "no policy, no nonce");
}

#[tokio::test]
async fn navigation_returns_title_head_tags_and_page_only() {
    let (_, headers, body) = call(app(routes(), None), "GET", Some("nav")).await;
    assert_eq!(headers["corten-page"], "1");
    assert!(body.starts_with(r#"<title>A &amp; B</title><meta name="description" content="About A" data-corten-head><p>"#));
    assert!(!body.contains("<html"), "{body}");
}

#[cfg(feature = "json")]
#[derive(crate::json::ToJson)]
struct Data {
    text: &'static str,
}

#[cfg(feature = "json")]
#[tokio::test]
async fn screen_is_html_for_browsers_and_json_for_data_clients() {
    let router = app(
        Table::new().route(
            "/",
            get(|req: Req| async move {
                let data = Data { text: "<b>" };
                req.screen::<ForOne, AnyAnswer, _>(
                    &data,
                    Shell { req: &req, title: "A & B", head: "", children: demo(data.text) },
                )
            }),
        ),
        None,
    );
    let browser = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    let (_, headers, body) = call_with(router.clone(), "GET", "/", None, Some(browser)).await;
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(body.starts_with("<!DOCTYPE html>"));
    let (_, headers, body) = call_with(router.clone(), "GET", "/", Some("nav"), Some("application/json")).await;
    assert_eq!(headers["corten-page"], "1", "the runtime's mode header wins over Accept");
    assert!(body.starts_with("<title>"));
    let (status, headers, body) = call_with(router, "GET", "/", None, Some("application/json; charset=utf-8")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(headers["vary"], "corten, accept");
    assert_eq!(body, r#"{"title":"A & B","data":{"text":"<b>"}}"#);
}

#[tokio::test]
async fn page_answers_data_requests_with_the_document() {
    let (_, headers, body) = call_with(app(routes(), None), "GET", "/", None, Some("application/json")).await;
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(body.starts_with("<!DOCTYPE html>"));
}

/// Outside `corten dev`, a handler's own error keeps its message out of the error page: only the
/// debug build's errors about the app's code (above) keep theirs.
#[tokio::test]
async fn a_handlers_error_keeps_its_message_off_the_page_outside_dev() {
    let page = |_: Req| async { Err::<Response, _>(Error::new("database password wrong")) };
    let panics = || async {
        if true {
            panic!("the vault key is 1234")
        } else {
            "never"
        }
    };
    let rejects = |Num(n): Num<u32>| async move { n.to_string() };
    let html = Some("text/html");
    for dev in [true, false] {
        let routes = Table::new().route("/", get(page)).route("/panic", get(panics)).route("/n/{n}", get(rejects));
        let router = App::new(Routes::from(routes)).dev(dev).error_page(test_error_page, ()).router();
        for mode in [None, Some("nav")] {
            let (status, _, body) = call_with(router.clone(), "GET", "/", mode, html).await;
            assert_eq!(status, 500, "{body}");
            assert_eq!(body.contains("database password wrong"), dev, "dev {dev} {mode:?}: {body}");
            let (status, _, body) = call_with(router.clone(), "GET", "/panic", mode, html).await;
            assert_eq!(status, 500, "{body}");
            assert_eq!(body.contains("the vault key"), dev, "a panic, dev {dev} {mode:?}: {body}");
            let (status, _, body) = call_with(router.clone(), "GET", "/n/abc", mode, html).await;
            assert_eq!(status, 400, "{body}");
            assert_eq!(body.contains("Invalid URL"), dev, "a rejection, dev {dev} {mode:?}: {body}");
        }
    }
}

/// An error page that fails too (the same unlisted component in the layout) is plain text, which
/// in a debug build keeps what the page's failure says about the app's code, and nothing else.
#[cfg(debug_assertions)]
#[tokio::test]
async fn an_error_page_that_fails_keeps_the_pages_detail_about_the_apps_code_in_its_text() {
    async fn broken(_: Failure, _: Req) -> HtmlResult {
        Err(Error::new("the error page broke"))
    }
    let routes = Table::new()
        .route(
            "/",
            get(|| async {
                Err::<Response, _>(crate::page::unserved(false, "the page draws Meter, which the app does not list".into()))
            }),
        )
        .route("/secret", get(|| async { Err::<Response, _>(Error::new("database password wrong")) }));
    let router = App::new(Routes::from(routes)).dev(false).error_page(broken, ()).router();
    let (status, _, body) = call_with(router.clone(), "GET", "/", None, Some("text/html")).await;
    assert_eq!(status, 500, "{body}");
    assert!(body.starts_with("The page could not be shown.") && body.contains("the page draws Meter"), "{body}");
    let (status, _, body) = call_with(router, "GET", "/secret", None, Some("text/html")).await;
    assert_eq!((status.as_u16(), body.as_str()), (500, "The page could not be shown."));
}

fn failing() -> Table {
    Table::new()
        .route("/", get(|| async { Err::<Response, _>(Error::new("database is down")) }))
        .route("/missing", get(|| async { Err::<Response, _>(Error::status(StatusCode::NOT_FOUND)) }))
        .route("/forbidden", get(|| async { Err::<Response, _>(Error::status(StatusCode::FORBIDDEN)) }))
}

#[tokio::test]
async fn errors_render_in_the_shell_for_each_mode_without_leaking_the_message() {
    let (status, headers, body) = call(app(failing(), None), "GET", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(body.contains("<title>Something went wrong</title>"), "{body}");
    assert_eq!(headers["x-robots-tag"], "noindex", "search engines skip every error page");
    assert!(!body.contains("database"), "the error message stays in the log");
    let (_, headers, body) = call(app(failing(), None), "GET", Some("nav")).await;
    assert_eq!(headers["corten-page"], "1");
    assert!(body.starts_with("<title>Something went wrong</title>"));
    let (_, headers, body) = call_with(app(failing(), None), "GET", "/", None, Some("application/json")).await;
    assert_eq!(headers["content-type"], "application/problem+json");
    assert_eq!(body, r#"{"title":"Internal Server Error","status":500}"#, "the message stays in the log");
    let (status, _, body) = call_with(app(failing(), None), "GET", "/missing", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body.contains("<title>Not found</title>"));
}

#[tokio::test]
async fn an_extractor_rejection_gets_the_error_page_in_a_browser_and_its_text_in_dev() {
    let routes = || Table::new().route("/n/{n}", get(|Num(n): Num<u32>| async move { n.to_string() }));
    let html = Some("text/html,application/xhtml+xml");
    let (status, headers, body) = call_with(app(routes(), None), "GET", "/n/abc", None, html).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(body.contains("<title>Something went wrong</title>") && !body.contains("parse"), "{body}");
    let (_, headers, body) = call_with(app(routes(), None), "GET", "/n/abc", Some("nav"), None).await;
    assert_eq!(headers["corten-page"], "1", "a navigation swaps the error page in: {body}");
    // The whole page after a write (`fetch` sends `Accept: */*`): the explicit mode wins over Accept.
    for accept in ["*/*", "application/json"] {
        let (status, headers, body) = call_with(app(routes(), None), "GET", "/n/abc", Some("page"), Some(accept)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(headers.contains_key("corten-shell") && !headers.contains_key("corten-page"), "{headers:?}");
        assert!(body.contains("<title>Something went wrong</title>"), "{body}");
    }
    let (_, _, body) = call_with(App::new(Routes::from(routes())).dev(true).router(), "GET", "/n/abc", None, html).await;
    assert!(body.contains("<pre>Invalid URL"), "the default error page shows it: {body}");
    let (status, headers, body) = call_with(app(routes(), None), "GET", "/n/abc", None, Some("application/json")).await;
    assert_eq!((status, headers["content-type"].to_str().unwrap()), (StatusCode::BAD_REQUEST, "application/problem+json"));
    assert!(
        body.starts_with(r#"{"title":"Bad Request","status":400,"detail":"Invalid URL"#),
        "a data client gets the text as JSON: {body}"
    );
    let (_, _, body) = call_with(app(routes(), None), "GET", "/n/abc", None, None).await;
    assert!(body.starts_with("Invalid URL"), "so does a client that does not ask for HTML: {body}");
    let (_, _, body) = call_with(app(routes(), None), "GET", "/n/7", None, None).await;
    assert_eq!(body, "7", "a plain-text success is left alone");
}

#[tokio::test]
async fn dev_mode_shows_errors_and_reloads_pages_when_the_server_restarts() {
    let dev = || {
        App::new(Routes::from(failing().route("/ok", get(|req: Req| async move { req.test_page("ok", html! { "ok" }) }))))
            .dev(true)
    };
    let (_, _, body) = call(dev().router(), "GET", None).await;
    assert!(body.contains("<pre>database is down</pre>"), "{body}");

    let router = dev().router();
    let (_, _, page) = call_with(router.clone(), "GET", "/ok", None, None).await;
    let boot = meta_content(&page, "corten-dev").to_string();
    let res = router.clone().oneshot(Request::get("/corten/dev").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.headers()["content-type"], "text/event-stream");
    let mut body = res.into_body();
    let mut events = String::new();
    while !events.contains("\n\n") {
        events.push_str(std::str::from_utf8(&body.frame().await.unwrap().unwrap().into_data().unwrap()).unwrap());
    }
    // Each server start has its own boot id; the page compares it to the one it was served with.
    assert!(!boot.is_empty() && events.contains(&format!("data: {boot}\n")), "{events}");
    // The checks a developer needs, which a production page never loads.
    let (status, headers, script) = call_with(router.clone(), "GET", "/corten/dev.js", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "text/javascript; charset=utf-8");
    assert_eq!(headers["cache-control"], "no-store");
    assert!(script.contains(r#"import { ready } from "corten";"#), "{script}");
    // And the runtime's modules it imports, as written.
    for (path, export) in [("/corten/on.js", "export function parseOn("), ("/corten/field.js", "export function field(")] {
        let (status, headers, script) = call_with(router.clone(), "GET", path, None, None).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(headers["content-type"], "text/javascript; charset=utf-8", "{path}");
        assert!(script.contains(export), "{path}: {script}");
    }

    let prod = App::new(Routes::from(failing())).dev(false).router();
    let (_, _, body) = call(prod.clone(), "GET", None).await;
    assert!(!body.contains("database") && !body.contains("corten-dev"));
    for path in ["/corten/dev", "/corten/dev.js", "/corten/on.js", "/corten/field.js"] {
        let (status, _, _) = call_with(prod.clone(), "GET", path, None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn unknown_urls_and_methods_get_the_error_page_and_the_app_can_replace_it() {
    let (status, _, body) = call_with(app(routes(), Some("ada")), "GET", "/nope", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body.contains("<title>Not found</title>") && body.contains(">home</a>"), "in the shell: {body}");
    // A method the app implements and the route lacks keeps the route's `Allow`; one no route has
    // is a 501 with none (RFC 9110 9.1). Both are drawn in the error page.
    let (status, headers, body) = call_with(app(routes(), None), "OPTIONS", "/", None, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert!(headers.contains_key("allow") && body.contains("Something went wrong"));
    let (status, headers, body) = call_with(app(routes(), None), "DELETE", "/", None, None).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert!(!headers.contains_key("allow") && body.contains("Something went wrong"));
    let custom = App::new(Routes::from(routes())).error_page(oops, ()).router();
    let (_, _, body) = call_with(custom, "GET", "/nope", None, None).await;
    assert!(body.contains("<title>Oops 404</title>") && body.contains("<h1>Lost?</h1>"));
}

/// An error page of the app's own, with no arguments but the failure and the request.
async fn oops(failure: Failure, req: Req) -> HtmlResult {
    let code = failure.status().as_u16();
    req.page(html! {
        <html>
            <head>
                <title>"Oops "{code}</title>
                <Corten />
            </head>
            <body><main><h1>"Lost?"</h1></main></body>
        </html>
    })
}

#[tokio::test]
async fn a_handler_that_panics_gets_the_error_page_and_the_server_keeps_serving() {
    let routes = Table::new().route("/", get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) })).route(
        "/panic",
        get(|| async {
            if true {
                panic!("index out of bounds")
            } else {
                "never"
            }
        }),
    );
    let router = app(routes, None);
    let (status, headers, body) = call_with(router.clone(), "GET", "/panic", None, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(body.contains("<title>Something went wrong</title>") && !body.contains("bounds"), "{body}");
    let (_, headers, body) = call_with(router.clone(), "GET", "/panic", Some("nav"), None).await;
    assert_eq!(headers["corten-page"], "1", "a navigation swaps the error page in: {body}");
    let (status, _, body) = call_with(router.clone(), "GET", "/panic", None, Some("application/json")).await;
    assert_eq!((status, &body[..]), (StatusCode::INTERNAL_SERVER_ERROR, r#"{"title":"Internal Server Error","status":500}"#));
    let (status, _, _) = call(router, "GET", None).await;
    assert_eq!(status, StatusCode::OK, "the next request is served");
    let (_, _, body) = call_with(
        App::new(Routes::from(Table::new().route(
            "/",
            get(|| async {
                if true {
                    panic!("index out of bounds")
                } else {
                    "never"
                }
            }),
        )))
        .dev(true)
        .router(),
        "GET",
        "/",
        None,
        None,
    )
    .await;
    assert!(body.contains("index out of bounds"), "under corten dev the page shows the panic: {body}");
}

/// A second layout, as a marketing page and an account page might have.
#[crate::component]
fn Plain(req: &Req, title: &str, children: impl Render) -> impl Document {
    html! {
        <html lang={req.lang()}>
            <head>
                <title>{title}</title>
                <Corten />
            </head>
            <body>
                <header>"Plain"</header>
                <main>{children}</main>
            </body>
        </html>
    }
}

/// The shell key names the layout that rendered the page: pages in one layout share it, so a
/// navigation between them swaps `<main>`; a page in another layout (or the default error
/// document) has another, so the runtime loads it in full rather than keep the first layout.
#[tokio::test]
async fn a_page_in_another_layout_has_another_shell_key() {
    let routes = Table::new()
        .route("/", get(|req: Req| async move { req.page::<ForOne>(Shell { req: &req, title: "A", head: "", children: "a" }) }))
        .route("/b", get(|req: Req| async move { req.page::<ForOne>(Shell { req: &req, title: "B", head: "", children: "b" }) }))
        .route("/plain", get(|req: Req| async move { req.page::<ForOne>(Plain { req: &req, title: "P", children: "p" }) }));
    let router = app(routes.clone(), None);
    let key = |uri: &'static str, mode: Option<&'static str>| {
        let router = router.clone();
        async move {
            let (status, headers, body) = call_with(router, "GET", uri, mode, None).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            let key = headers["corten-shell"].to_str().unwrap().to_string();
            if mode.is_none() {
                assert_eq!(meta_content(&body, "corten-shell"), key, "{uri}: the document and its header agree");
            }
            key
        }
    };
    let home = key("/", None).await;
    assert_eq!(key("/b", Some("nav")).await, home, "the same layout swaps in");
    let plain = key("/plain", Some("nav")).await;
    assert_ne!(plain, home, "another layout loads in full");
    assert_eq!(key("/plain", None).await, plain, "a layout's key is the same in every mode");

    // An app without an error page: an unknown URL is Corten's plain document, not the layout.
    let bare = App::new(Routes::from(routes)).router();
    let (_, nope, _) = call_with(bare.clone(), "GET", "/nope", Some("nav"), None).await;
    let (_, page, _) = call_with(bare, "GET", "/", Some("nav"), None).await;
    assert_ne!(nope["corten-shell"], page["corten-shell"], "the default error document is another layout");
}

/// The shell key is written once and carried twice: a whole document's header and its head tag
/// hold the same 16 lowercase hex digits, a page's and an error page's, Corten's and the app's;
/// a navigation's header holds the same digits as the document's.
#[tokio::test]
async fn the_header_and_the_head_carry_the_shell_key_s_same_16_digits() {
    let digits = |key: &str| key.len() == 16 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let routes = || Table::new().route("/", get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) }));
    for router in
        [App::new(Routes::from(routes())).router(), App::new(Routes::from(routes())).error_page(test_error_page, ()).router()]
    {
        for uri in ["/", "/nope"] {
            let (_, headers, body) = call_with(router.clone(), "GET", uri, None, Some("text/html")).await;
            let key = headers["corten-shell"].to_str().unwrap();
            assert!(digits(key), "{uri}: {key}");
            assert_eq!(meta_content(&body, "corten-shell"), key, "{uri}");
            let (_, nav, _) = call_with(router.clone(), "GET", uri, Some("nav"), None).await;
            assert_eq!(nav["corten-shell"], key, "{uri}: a navigation");
        }
    }
}

#[tokio::test]
async fn a_page_that_reads_again_says_so_in_its_head_on_every_surface() {
    use std::time::Duration;
    let routes = Table::new().route(
        "/",
        get(|req: Req| async move {
            req.page::<ForOne>(Shell {
                req: &req,
                title: "Saving",
                head: ReadAgain { after: Duration::from_secs(2) },
                children: html! { <p>"Saving"</p> },
            })
        }),
    );
    let tag = r#"<noscript data-corten-read-again="2" data-corten-head><meta http-equiv="refresh" content="2"></noscript>"#;
    let (_, headers, document) = call(app(routes.clone(), None), "GET", None).await;
    assert!(
        document.contains(&format!("<title>Saving</title>{tag}")),
        "in <head>, where the browser reads it without JavaScript: {document}"
    );
    assert!(!headers.contains_key("refresh"), "not the header, which outlives the runtime's navigations");
    let (_, _, swap) = call(app(routes, None), "GET", Some("nav")).await;
    assert!(swap.starts_with(&format!("<title>Saving</title>{tag}<p>")), "a navigation's head tags: {swap}");
}

/// `ReadAgain::without_javascript` in the head (#319): the same refresh, without the mark the
/// runtime reads, on a full load and in a navigation's head tags.
#[tokio::test]
async fn a_page_that_reads_again_only_without_javascript_has_no_mark_in_its_head() {
    use std::time::Duration;
    let routes = Table::new().route(
        "/",
        get(|req: Req| async move {
            req.page::<ForOne>(Shell {
                req: &req,
                title: "Saving",
                head: ReadAgain { after: Duration::from_secs(2) }.without_javascript(),
                children: html! { <p>"Saving"</p> },
            })
        }),
    );
    let tag = r#"<noscript data-corten-head><meta http-equiv="refresh" content="2"></noscript>"#;
    let (_, headers, document) = call(app(routes.clone(), None), "GET", None).await;
    assert!(document.contains(&format!("<title>Saving</title>{tag}")), "{document}");
    assert!(!document.contains("data-corten-read-again"), "the runtime finds nothing to read again: {document}");
    assert!(!headers.contains_key("refresh"));
    let (_, _, swap) = call(app(routes, None), "GET", Some("nav")).await;
    assert!(swap.starts_with(&format!("<title>Saving</title>{tag}<p>")), "a navigation's head tags: {swap}");
}

#[test]
fn read_again_is_whole_seconds_and_works_without_javascript() {
    use std::time::Duration;
    let tag = |after| ReadAgain { after }.to_html();
    assert_eq!(
        tag(Duration::from_secs(2)),
        r#"<noscript data-corten-read-again="2"><meta http-equiv="refresh" content="2"></noscript>"#
    );
    assert!(tag(Duration::from_millis(1500)).contains(r#"read-again="2""#), "rounded up");
    assert!(tag(Duration::ZERO).contains(r#"read-again="1""#), "never sooner than a second");
}

/// A route that says `data = ShownListing` (#1399): its routes module mounts it with its `get`,
/// and with a `post` beside it, whose merged methods keep the `get`'s kind.
#[cfg(feature = "json")]
#[crate::routes]
mod url_screen {
    #[route("/listing", get = listing, post = relist, data = ShownListing)]
    pub struct Listing;
}

#[cfg(feature = "json")]
#[derive(crate::json::ToJson)]
pub struct ShownListing {
    name: &'static str,
}

/// The listing's page, titled.
#[cfg(feature = "json")]
fn listing_page(name: &str) -> impl crate::Document + '_ {
    html! {
        <html>
            <head>
                <title>"Listing"</title>
                <Corten />
            </head>
            <body><main>{name}</main></body>
        </html>
    }
}

/// Given the data in an `Arc`, as an app that shares it would: its JSON is the listing's.
#[cfg(feature = "json")]
async fn listing(req: Req) -> HtmlResult<crate::Screen<ShownListing>> {
    let shown = std::sync::Arc::new(ShownListing { name: "Ashen" });
    req.screen(&shown, listing_page(shown.name))
}

#[cfg(feature = "json")]
async fn relist(req: Req) -> HtmlResult {
    req.redirect(&url_screen::Listing)
}

/// Given a reference to the data, as a helper that takes `&ShownListing` would.
#[cfg(feature = "json")]
async fn listing_by_ref(req: Req) -> HtmlResult<crate::Screen<ShownListing>> {
    let shown = ShownListing { name: "Borrowed" };
    let by_ref = &shown;
    req.screen(&by_ref, listing_page(by_ref.name))
}

/// The area a route that says `data` is mounted again in, by hand.
#[cfg(feature = "json")]
#[derive(crate::Route)]
#[route("/listing")]
struct ListingArea;

/// Its routes module mounts it, a `post` beside its `get`; a data client gets the listing's JSON,
/// read from an `Arc` as from the listing itself; and mounted by hand with a `get` that answers
/// a screen of the same data, given by reference, it is the same.
#[cfg(feature = "json")]
#[tokio::test]
async fn a_route_that_says_data_answers_its_data_in_its_module_and_mounted_by_hand() {
    let module = App::new(url_screen::router()).test();
    let read = module.get(&url_screen::Listing).header(http::header::ACCEPT, "application/json").await;
    assert_eq!(read.text(), r#"{"title":"Listing","data":{"name":"Ashen"}}"#);
    let by_hand = App::new(Routes::new())
        .area::<ListingArea>(|area| area.route::<url_screen::Listing>(crate::route::get(listing_by_ref)))
        .test();
    let read = by_hand.get(&url_screen::Listing).header(http::header::ACCEPT, "application/json").await;
    assert_eq!(read.text(), r#"{"title":"Listing","data":{"name":"Borrowed"}}"#);
}

#[cfg(feature = "json")]
#[tokio::test]
async fn a_page_serves_json_for_a_mixed_case_first_media_type_with_or_without_the_store() {
    let app = || {
        let screen = |req: Req| async move {
            let data = ShownListing { name: "Ashen" };
            Public::new(std::time::Duration::from_secs(60), req.screen::<_, AnyAnswer, _>(&data, listing_page(data.name)))
        };
        App::new(Routes::from(Table::new().route("/listing", crate::route::get(screen).0)))
    };
    for (app, keeps) in [(app(), true), (app().kept_answers(0), false)] {
        let client = app.test();
        for hit in [false, keeps] {
            let html = client.get(&url_screen::Listing).header(http::header::ACCEPT, "text/html").await;
            assert_eq!(html.status(), StatusCode::OK);
            assert!(html.text().contains("<title>Listing</title>") && html.text().contains("Ashen</main>"), "{}", html.text());
            assert_eq!(html.headers().contains_key(http::header::AGE), hit);
        }
        // A page's kept document never answers a data request, regardless of its spelling.
        for accept in ["Application/JSON", "application/JSON", "APPLICATION/JSON; q=1, text/html"] {
            let answer = client.get(&url_screen::Listing).header(http::header::ACCEPT, accept).await;
            assert_eq!(answer.headers()[http::header::CONTENT_TYPE], "application/json", "{accept}");
            assert_eq!(answer.text(), r#"{"title":"Listing","data":{"name":"Ashen"}}"#, "{accept}");
            assert!(!answer.headers().contains_key(http::header::AGE), "{accept}");
        }
        for accept in ["Application/JSONx", "text/html, APPLICATION/JSON"] {
            let answer = client.get(&url_screen::Listing).header(http::header::ACCEPT, accept).await;
            assert!(answer.headers()[http::header::CONTENT_TYPE].to_str().unwrap().starts_with("text/html"), "{accept}");
            assert_eq!(answer.headers().contains_key(http::header::AGE), keeps, "{accept}");
        }
    }
}

/// Browsers keep a full load's `Refresh` after the runtime navigates away, then load it again.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_page_with_a_refresh_header_is_an_error_in_debug_builds() {
    let routes = Table::new().route(
        "/",
        get(|req: Req| async move {
            let mut res = req.test_page("Saving", html! { <p>"Saving"</p> })?;
            res.headers_mut().insert("refresh", http::HeaderValue::from_static("2"));
            Ok::<_, crate::Error>(res)
        }),
    );
    for mode in [None, Some("nav")] {
        let res = app(routes.clone(), None).oneshot(request_in(mode)).await.unwrap();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR, "{mode:?}");
        assert!(!res.headers().contains_key("refresh"), "{mode:?}");
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let body = String::from_utf8_lossy(&body);
        assert!(body.contains("sends a Refresh header"), "it names the mistake outside dev too: {body}");
    }
    let api = Table::new().route("/", get(|| async { ([("refresh", "2")], "ok") }));
    assert_eq!(call(app(api, None), "GET", None).await.0, StatusCode::OK, "only pages are checked");
}

#[tokio::test]
async fn error_pages_render_in_the_shell() {
    let (status, _, body) = call_with(app(failing(), Some("ada")), "GET", "/forbidden", None, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains(">home</a>") && body.contains("Not allowed"));
}

/// A redirect's notice rides in a cookie for the page it goes to: that page reads it once (the
/// answer removes it, and is private), a navigation's page that did not draw it hands it to the
/// runtime in `corten-notice`, and another page neither sees nor removes it.
#[tokio::test]
async fn a_redirect_notice_is_read_once_by_the_page_it_was_for() {
    let routes = Table::new()
        .route("/", get(|req: Req| async move { req.redirect_with_notice(&Done.at(MsgId), "Batch 3517 deleted; 2 left.") }))
        .route("/long", get(|req: Req| async move { req.redirect_with_notice(&Done, "é".repeat(400)) }))
        .route(
            "/done",
            get(|req: Req| async move {
                let notice = req.notice();
                req.test_page("Done", html! { <p>{notice}</p> })
            }),
        )
        .route("/other", get(|req: Req| async move { req.test_page("Other", "nothing") }));
    let router = app(routes, None);
    let set = |res: &Response| {
        res.headers().get_all(header::SET_COOKIE).iter().map(|c| c.to_str().unwrap().to_string()).collect::<Vec<_>>()
    };
    let res = router.clone().oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    assert_eq!(res.headers()[header::LOCATION], "/done#msg");
    let key = |path: &str| crate::page::path_key(path);
    let cookie = &format!("__Host-corten-notice=p={}&m=Batch+3517+deleted%3B+2+left.", key("/done"));
    assert_eq!(set(&res), [format!("{cookie}; Path=/; SameSite=Lax; Max-Age=60; HttpOnly; Secure")]);
    // The page's path, escapes decoded: the link's `%20` and the browser's `%7B` for a `{` name
    // the same page as the characters.
    assert_eq!(key("/items/a%20b"), key("/items/a b"));
    assert_eq!(key("/a%7Bb%7d"), key("/a{b}"));
    assert_ne!(key("/done"), key("/done/"));
    // An escaped `/` is part of one segment, not a second one.
    assert_ne!(key("/a%2Fb"), key("/a/b"));
    // A broken escape is its bytes as they are.
    assert_ne!(key("/bad%zz"), key("/bad"));
    assert_ne!(key("/bad%4"), key("/bad"));
    let fetch = |uri: &str, mode: Option<&str>| {
        let mut req = Request::get(uri).header(header::COOKIE, format!("a=1; {cookie}"));
        if let Some(mode) = mode {
            req = req.header("corten", mode);
        }
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };
    let gone = "__Host-corten-notice=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure";
    for mode in [None, Some("nav")] {
        let res = fetch("/done", mode).await.unwrap();
        assert_eq!(set(&res), [gone], "{mode:?}");
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache");
        // The page drew it: the answer says so (`&d`), so the runtime keeps it only for a full load
        // in its place. A whole document says it too, for the runtime that fetched it after a write.
        let header = res.headers().get("corten-notice").map(|v| v.to_str().unwrap().to_string());
        assert_eq!(header.as_deref(), Some("m=Batch+3517+deleted%3B+2+left.&d"), "{mode:?}");
        let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        assert!(body.contains("<p>Batch 3517 deleted; 2 left.</p>"), "{body}");
    }
    let res = fetch("/other", Some("nav")).await.unwrap();
    assert!(set(&res).is_empty() && res.headers().get("corten-notice").is_none(), "another page leaves it");
    // A HEAD request (a link preview) leaves it for the page's GET.
    let req = Request::head("/done").header(header::COOKIE, cookie.as_str()).body(Body::empty()).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert!(set(&res).is_empty(), "HEAD leaves it");
    // Also when it ends on the error page.
    let missing = cookie.replace(&key("/done"), &key("/missing"));
    let req = Request::head("/missing").header(header::COOKIE, missing).body(Body::empty()).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert!(set(&res).is_empty(), "HEAD to the error page leaves it");
    let req = Request::get("/missing")
        .header(header::COOKIE, cookie.replace(&key("/done"), &key("/missing")))
        .body(Body::empty())
        .unwrap();
    assert_eq!(set(&router.clone().oneshot(req).await.unwrap()), [gone], "the error page's GET reads it");
    // A navigation's page that does not draw it, or holds it in the layout around `<main>`, which
    // a navigation does not run: the runtime gets it. A full load draws it in the layout.
    let routes = Table::new().route("/done", get(|req: Req| async move { req.test_page("Done", "done") })).route(
        "/done/in-layout",
        get(|req: Req| async move {
            let notice = req.notice();
            req.page::<ForOne>(html! {
                <html>
                    <head>
                        <title>"Done"</title>
                        <Corten />
                    </head>
                    <body>
                        <p id="toast">{notice}</p>
                        <main>"done"</main>
                    </body>
                </html>
            })
        }),
    );
    let layouts = app(routes, None);
    for (path, mode) in [("/done", Some("nav")), ("/done/in-layout", Some("nav")), ("/done/in-layout", None)] {
        let cookie = cookie.replace(&key("/done"), &key(path));
        let mut req = Request::get(path).header(header::COOKIE, cookie);
        if let Some(mode) = mode {
            req = req.header("corten", mode);
        }
        let res = layouts.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(set(&res), [gone], "{path} {mode:?}");
        let header = res.headers().get("corten-notice").map(|v| v.to_str().unwrap().to_string());
        let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        if mode.is_some() {
            assert_eq!(header.as_deref(), Some("m=Batch+3517+deleted%3B+2+left."), "{path}");
            assert!(!body.contains("Batch 3517"), "{body}");
        } else {
            assert_eq!(header.as_deref(), Some("m=Batch+3517+deleted%3B+2+left.&d"), "drawn in the layout");
            assert!(body.contains(r#"<p id="toast">Batch 3517 deleted; 2 left.</p>"#), "{body}");
        }
    }
    // Cut at 500 bytes, at a character's end.
    let res = router.clone().oneshot(Request::get("/long").body(Body::empty()).unwrap()).await.unwrap();
    let value = set(&res)[0].clone();
    let value = value.split_once('=').unwrap().1.split(';').next().unwrap();
    let text: String = form_urlencoded::parse(value.as_bytes()).find(|(k, _)| k == "m").unwrap().1.into_owned();
    assert_eq!(text, "é".repeat(250));
}

/// The notice a page drew, sent back by the runtime as that page reads itself again: `req.notice()`
/// answers it for that `GET` from the page's own origin (so the read draws the page as it was),
/// the answer removes no cookie, says it drew it, and varies by it. Another site's request and a
/// text past the longest notice are not taken for it, and a notice cookie for the page wins.
#[tokio::test]
async fn a_notice_sent_back_on_a_read_again_is_drawn_again() {
    let page = |req: Req| async move {
        let notice = req.notice();
        req.test_page("Done", html! { <p>{notice}</p> })
    };
    let routes = Table::new().route("/done", get(page).post(page)).route("/other", get(page));
    let router = app(routes, None);
    let at = |method: &str, path: &str, notice: &str, site: Option<&'static str>, cookie: Option<String>| {
        let mut req = Request::builder().method(method).uri(path).header("corten-notice", notice);
        if let Some(site) = site {
            req = req.header("sec-fetch-site", site);
        }
        if let Some(cookie) = cookie {
            req = req.header(header::COOKIE, cookie);
        }
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };
    let read = |notice: &str, site, cookie| at("GET", "/done", notice, site, cookie);
    let body =
        |res: Response| async move { String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap() };
    for site in [Some("same-origin"), None] {
        let res = read("p=%2Fdone&m=Saved+%3Cb%3E", site, None).await.unwrap();
        assert!(res.headers().get_all(header::SET_COOKIE).iter().next().is_none(), "{site:?}");
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache");
        assert_eq!(res.headers()[header::VARY], "corten, accept, corten-notice");
        assert_eq!(res.headers()["corten-notice"], "m=Saved+%3Cb%3E&d");
        assert!(body(res).await.contains("<p>Saved &lt;b&gt;</p>"), "{site:?}");
    }
    for site in ["cross-site", "same-site", "none"] {
        let res = read("p=%2Fdone&m=Saved", Some(site), None).await.unwrap();
        assert!(res.headers().get("corten-notice").is_none(), "{site}");
        assert!(body(res).await.contains("<p></p>"), "{site}");
    }
    let long = format!("p=%2Fdone&m={}", "a".repeat(501));
    let res = read(&long, Some("same-origin"), None).await.unwrap();
    assert!(res.headers().get("corten-notice").is_none(), "past the longest notice");
    // For another page (a read again the server redirected there, `fetch` keeping the header), with
    // no path, or on a request that is not a `GET`, it is not the page's.
    for (method, path, notice) in [
        ("GET", "/other", "p=%2Fdone&m=Saved"),
        ("GET", "/done", "m=Saved"),
        ("POST", "/done", "p=%2Fdone&m=Saved"),
        ("HEAD", "/done", "p=%2Fdone&m=Saved"),
    ] {
        let res = at(method, path, notice, Some("same-origin"), None).await.unwrap();
        assert!(res.headers().get("corten-notice").is_none(), "{method} {path} {notice}");
        assert_eq!(res.headers()[header::VARY], "corten, accept", "{method} {path} {notice}");
    }
    // The path as the browser escapes it names the same page.
    let routes = Table::new().route("/items/{id}", get(page));
    let res = app(routes, None)
        .oneshot(
            Request::get("/items/a%20b")
                .header("corten-notice", "p=%2Fitems%2Fa%2520b&m=Saved")
                .header("sec-fetch-site", "same-origin")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.headers()["corten-notice"], "m=Saved&d");
    // The page's own cookie wins, and is removed as it is read.
    let cookie = format!("__Host-corten-notice=p={}&m=Deleted.", crate::page::path_key("/done"));
    let res = read("p=%2Fdone&m=Saved", Some("same-origin"), Some(cookie)).await.unwrap();
    assert_eq!(res.headers()["corten-notice"], "m=Deleted.&d");
    assert_eq!(res.headers()[header::VARY], "corten, accept");
    assert_eq!(res.headers().get_all(header::SET_COOKIE).iter().count(), 1);
}

/// Which origins a browser refuses a `Secure` cookie from: plain `http://` but for loopback.
#[test]
fn a_plain_origin_is_http_off_loopback() {
    let with = |origin: &str, host: &str, fetch_site: Option<&'static str>| {
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(site) = fetch_site {
            headers.insert("sec-fetch-site", HeaderValue::from_static(site));
        }
        crate::page::plain_origin(&http::Uri::default(), &headers)
    };
    let plain = |origin: &str| with(origin, origin.split_once("://").map_or("", |(_, host)| host), None);
    for origin in
        ["http://automation.lan:3001", "http://192.168.1.5", "http://localhost.lan", "http://[fe80::1]:80", "http://10.0.0.127"]
    {
        assert!(plain(origin), "{origin}");
    }
    for origin in [
        "https://automation.lan",
        "http://localhost",
        "http://localhost.:3000",
        "http://LOCALHOST:3000",
        "http://app.localhost:3000",
        "http://127.0.0.2:8080",
        "http://[::1]:3000",
        "http://[::1]",
        "null",
    ] {
        assert!(!plain(origin), "{origin}");
    }
    assert!(!crate::page::plain_origin(&http::Uri::default(), &HeaderMap::new()), "no Origin: not a browser's write");
    // A default port is the same written or left out, as in the same-origin check.
    assert!(with("http://lan", "lan:80", None));
    assert!(with("http://lan:80", "lan", None));
    assert!(!with("http://lan", "lan:8080", None));
    assert!(!with("http://localhost", "localhost:80", None));
    // A browser that counts the origin as secure (a policy for an internal tool) sends
    // `Sec-Fetch-Site`, takes a `Secure` cookie and is not read the plain one.
    assert!(!with("http://automation.lan:3001", "automation.lan:3001", Some("same-origin")));
    // Another origin's write (`Policy::allow_origin`): the response is this host's, not that one's.
    assert!(!with("http://admin.lan", "automation.lan:3001", None));
}

#[tokio::test]
async fn an_absolute_target_chooses_the_notice_cookie_by_its_own_host() {
    use crate::extract::FromRequestParts;

    for (origin, cookie) in [("http://desk.lan:3001", "corten-notice"), ("http://desk.lan:3002", "__Host-corten-notice")] {
        let request = Request::post("http://desk.lan:3001/").header(header::HOST, "desk.lan:3002").header(header::ORIGIN, origin);
        let (mut parts, _) = request.body(Body::empty()).unwrap().into_parts();
        let req = Req::from_request_parts(&mut parts, &()).await.unwrap();
        let res = req.redirect_with_notice(&Done, "Saved.").unwrap().into_response();
        assert_eq!(res.headers()[header::SET_COOKIE].to_str().unwrap().split_once('=').unwrap().0, cookie, "{origin}");
    }
}

#[tokio::test]
async fn a_notice_after_an_absolute_target_is_rewritten_uses_the_handler_visible_host() {
    struct PathOnly;
    impl crate::Middleware for PathOnly {
        async fn call(&self, mut req: crate::http::Request, next: impl crate::Next) -> crate::response::Response {
            *req.uri_mut() = http::Uri::from_static("/");
            next.run(req).await
        }
    }
    let app = || {
        let routes =
            Table::new().route("/", crate::router::post(|req: Req| async move { req.redirect_with_notice(&Done, "Saved.") }));
        App::new(Routes::from(routes)).policy(crate::security::Policy::new().host("desk.lan"))
    };
    for (router, cookie) in [(app().router(), "corten-notice"), (app().middleware(PathOnly).router(), "__Host-corten-notice")] {
        let request = Request::post("http://desk.lan:3001/")
            .header(header::HOST, "desk.lan:3002")
            .header(header::ORIGIN, "http://desk.lan:3001")
            .body(Body::empty())
            .unwrap();
        let res = router.oneshot(request).await.unwrap();
        assert_eq!(res.status(), StatusCode::SEE_OTHER);
        assert_eq!(res.headers()[header::SET_COOKIE].to_str().unwrap().split_once('=').unwrap().0, cookie);
    }
}

/// A write from a plain `http://` origin on the LAN, which a browser does not count as secure and so
/// refuses a `Secure` (and `__Host-`) cookie from, gets its notice in a plain `corten-notice`
/// cookie; the page reads that one only from a request without `Sec-Fetch-Site` (which a browser
/// sends to every secure origin, so on HTTPS another site on the domain cannot plant one) and
/// removes it as it was set.
#[tokio::test]
async fn a_notice_written_over_plain_http_on_the_lan_reaches_its_page() {
    let routes =
        Table::new().route("/", crate::router::post(|req: Req| async move { req.redirect_with_notice(&Done, "Saved.") })).route(
            "/done",
            get(|req: Req| async move {
                let notice = req.notice();
                req.test_page("Done", html! { <p>{notice}</p> })
            }),
        );
    let router = app(routes, None);
    let set = |res: &Response| {
        res.headers().get_all(header::SET_COOKIE).iter().map(|c| c.to_str().unwrap().to_string()).collect::<Vec<_>>()
    };
    let value = format!("p={}&m=Saved.", crate::page::path_key("/done"));
    let write = |origin: &str, host: &str| {
        let req = Request::post("/").header("origin", origin).header("host", host);
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };
    let res = write("http://192.168.1.5:3001", "192.168.1.5:3001").await.unwrap();
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    assert_eq!(set(&res), [format!("corten-notice={value}; Path=/; SameSite=Lax; Max-Age=60; HttpOnly")]);
    // A secure origin, loopback over plain `http://` included, keeps the `__Host-` cookie.
    for (origin, host) in [
        ("https://192.168.1.5", "192.168.1.5"),
        ("http://localhost:3000", "localhost:3000"),
        ("http://127.0.0.1:3000", "127.0.0.1:3000"),
    ] {
        let res = write(origin, host).await.unwrap();
        assert_eq!(
            set(&res),
            [format!("__Host-corten-notice={value}; Path=/; SameSite=Lax; Max-Age=60; HttpOnly; Secure")],
            "{origin}"
        );
    }
    let read = |cookie: &str, secure: bool| {
        let mut req = Request::get("/done").header(header::COOKIE, cookie);
        if secure {
            req = req.header("sec-fetch-site", "same-origin");
        }
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };
    let plain = format!("a=1; corten-notice={value}");
    let res = read(&plain, false).await.unwrap();
    assert_eq!(set(&res), ["corten-notice=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly"]);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache");
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(body.contains("<p>Saved.</p>"), "{body}");
    // From a secure origin the plain cookie is not the app's: another site on the domain could
    // have set it. It is neither shown nor removed.
    let res = read(&plain, true).await.unwrap();
    assert!(set(&res).is_empty());
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(body.contains("<p></p>"), "{body}");
    // With both, the `__Host-` one is the notice, and both go.
    let both = format!("corten-notice=p={}&m=Planted.; __Host-corten-notice={value}", crate::page::path_key("/done"));
    let res = read(&both, false).await.unwrap();
    assert_eq!(
        set(&res),
        [
            "__Host-corten-notice=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure",
            "corten-notice=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly"
        ]
    );
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(body.contains("<p>Saved.</p>"), "{body}");
    // A HEAD request leaves it for the GET.
    let req = Request::head("/done").header(header::COOKIE, plain.as_str()).body(Body::empty()).unwrap();
    assert!(set(&router.clone().oneshot(req).await.unwrap()).is_empty(), "HEAD leaves it");
    // A write that `Sec-Fetch-Site` says comes from a secure page keeps `__Host-`.
    let req = Request::post("/")
        .header("origin", "http://192.168.1.5")
        .header("host", "192.168.1.5")
        .header("sec-fetch-site", "same-origin");
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    assert!(set(&res)[0].starts_with("__Host-corten-notice="), "{:?}", set(&res));
    // An app that says it is HTTPS only (`Policy::hsts`) never sets nor reads the plain one: the
    // write from a plain-http page that would set it is refused there, as another site's (#1212).
    let https_app = |policy: crate::security::Policy| {
        let routes = Table::new()
            .route("/", crate::router::post(|req: Req| async move { req.redirect_with_notice(&Done, "Saved.") }))
            .route(
                "/done",
                get(|req: Req| async move {
                    let notice = req.notice();
                    req.test_page("Done", html! { <p>{notice}</p> })
                }),
            );
        App::new(Routes::from(routes)).policy(policy.hsts()).router()
    };
    let https = https_app(crate::security::Policy::new());
    let req = Request::post("/").header("origin", "http://192.168.1.5").header("host", "192.168.1.5");
    let res = https.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(set(&res).is_empty(), "{:?}", set(&res));
    // One it allows by name keeps `__Host-`.
    let allowed = https_app(crate::security::Policy::new().allow_origin("http://192.168.1.5"));
    let req = Request::post("/").header("origin", "http://192.168.1.5").header("host", "192.168.1.5");
    let res = allowed.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    assert!(set(&res)[0].starts_with("__Host-corten-notice="), "{:?}", set(&res));
    let req = Request::get("/done").header(header::COOKIE, plain.as_str()).body(Body::empty()).unwrap();
    let res = https.clone().oneshot(req).await.unwrap();
    assert!(set(&res).is_empty(), "{:?}", set(&res));
}

/// A `Public` page that reads a notice from the plain cookie is sent private, as for the
/// `__Host-` one: the removal is Corten's, not a cookie the app set by mistake.
#[tokio::test]
async fn a_public_page_reading_a_plain_notice_is_private() {
    let minute = std::time::Duration::from_secs(60);
    let routes = Table::new().route(
        "/done",
        get(move |req: Req| async move {
            let notice = req.notice();
            Public::new(minute, req.test_page_for("Done", html! { <p>{notice}</p> }))
        }),
    );
    let router = app(routes, None);
    for cookie in ["corten-notice", "__Host-corten-notice"] {
        let value = format!("{cookie}=p={}&m=Saved.", crate::page::path_key("/done"));
        let req = Request::get("/done").header(header::COOKIE, value).body(Body::empty()).unwrap();
        let res = router.clone().oneshot(req).await.unwrap();
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache", "{cookie}");
        assert_eq!(res.headers().get_all(header::SET_COOKIE).iter().count(), 1, "{cookie}");
    }
}

#[tokio::test]
async fn only_a_swap_says_it_is_a_page_swap() {
    let (_, headers, _) = call(app(routes(), None), "GET", None).await;
    assert!(!headers.contains_key("corten-page"), "a document a cache hands to a navigation makes the runtime reload");
    let (_, headers, _) = call(app(routes(), None), "GET", Some("nav")).await;
    assert_eq!(headers["corten-page"], "1");
}

#[crate::routes]
mod page_or_url {
    #[route("/runs/{id}", get = page_or_run)]
    pub struct Run<'a> {
        pub id: &'a str,
        pub said: Option<&'a str>,
    }

    #[route("/runs/{id}/download", post = page_or_download)]
    pub struct Download<'a> {
        pub id: &'a str,
    }
}

async fn page_or_run(_: Params<page_or_url::Run<'_>>) -> &'static str {
    "run"
}

/// The file for run 7, the run's page saying why for any other.
async fn page_or_download(req: Req, Params(at): Params<page_or_url::Download<'_>>) -> crate::Result<crate::PageOr<crate::Media>> {
    if at.id != "7" {
        return Ok(req.redirect(&page_or_url::Run { id: &at.id, said: Some("stale") })?.into());
    }
    Ok(crate::Media::new("text/csv", "sku,qty\n").into())
}

/// A route that sends a file answers a redirect or a page instead when it refuses, as a page is:
/// private, with the app's headers.
#[tokio::test]
async fn a_file_route_answers_a_page_when_it_refuses() {
    let router = App::new(page_or_url::router()).router();
    let (status, headers, body) = call_with(router.clone(), "POST", "/runs/7/download", None, None).await;
    assert_eq!(
        (status, headers[header::CONTENT_TYPE].to_str().unwrap(), body.as_str()),
        (StatusCode::OK, "text/csv", "sku,qty\n")
    );
    let (status, headers, _) = call_with(router, "POST", "/runs/8/download", None, None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "/runs/8?said=stale");
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache");
    assert!(headers.contains_key(header::CONTENT_SECURITY_POLICY));
}

/// An error's message (`Display`) is its source's, what the log says, and `status_code` the
/// status of the answer it makes, for each way an error is made: checked against the answer, so
/// the two cannot drift apart.
#[test]
fn an_error_says_its_message_and_status() {
    let sign_in: http::Uri = "https://id.example/sign-in".parse().unwrap();
    /// What it is, how it is made, its message and its status.
    type Case = (&'static str, Box<dyn Fn() -> Error>, &'static str, StatusCode);
    let cases: Vec<Case> = vec![
        ("new", Box::new(|| Error::new("no item 7")), "no item 7", StatusCode::INTERNAL_SERVER_ERROR),
        (
            "with_status",
            Box::new(|| Error::new("no item 7").with_status(StatusCode::NOT_FOUND)),
            "no item 7",
            StatusCode::NOT_FOUND,
        ),
        ("not_found", Box::new(Error::not_found), "Not Found", StatusCode::NOT_FOUND),
        ("status", Box::new(|| Error::status(StatusCode::CONFLICT)), "Conflict", StatusCode::CONFLICT),
        (
            "?",
            Box::new(|| std::io::Error::new(std::io::ErrorKind::ConnectionReset, "connection reset").into()),
            "connection reset",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        (
            "refused, said",
            Box::new(|| crate::Refused::forbidden().message("not yours").into()),
            "not yours",
            StatusCode::FORBIDDEN,
        ),
        ("refused", Box::new(|| crate::Refused::forbidden().into()), "refused: 403 Forbidden", StatusCode::FORBIDDEN),
        // The log keeps the cause a 404 hides from the client: the app's to send or not.
        (
            "refused, hidden",
            Box::new(|| Error::from(crate::Refused::forbidden()).with_status(StatusCode::NOT_FOUND)),
            "refused: 403 Forbidden",
            StatusCode::NOT_FOUND,
        ),
        (
            "sign-in",
            Box::new(move || crate::Refused::sign_in(&sign_in).into()),
            "refused: 401 Unauthorized",
            StatusCode::UNAUTHORIZED,
        ),
        (
            "too many",
            Box::new(|| crate::Refused::too_many(Duration::from_secs(30)).into()),
            "refused: 429 Too Many Requests",
            StatusCode::TOO_MANY_REQUESTS,
        ),
        (
            "unavailable",
            Box::new(|| crate::Refused::unavailable("sessions are down").into()),
            "who is asking cannot be known: sessions are down",
            StatusCode::SERVICE_UNAVAILABLE,
        ),
    ];
    for (case, error, message, status) in cases {
        assert_eq!((error().to_string().as_str(), error().status_code()), (message, status), "{case}");
        assert_eq!(error().into_response().status(), status, "{case}: the answer has the status read");
    }
}
