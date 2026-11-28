use super::*;

/// The routes `what_a_page_with_posts_costs` sends to.
#[crate::routes]
mod url_action_cost {
    #[route("/desk", get = action_cost_page, post = action_cost_plain, post(price) = action_cost_price)]
    pub struct Desk {
        pub page: Option<u32>,
    }

    #[route("/desk/price", post = action_cost_route)]
    pub struct DeskPrice {
        pub page: Option<u32>,
    }
}
async fn action_cost_page(req: Req, Params(p): Params<url_action_cost::Desk>) -> HtmlResult {
    let at = url_action_cost::Desk { page: p.page };
    req.test_page(
        "Desk",
        html! {
            <form method="post" action={at.price()}><input name={ActionPrice::FIELDS.price}><button>"Price"</button></form>
            <form method="post" action={at}><input name={ActionPrice::FIELDS.price}><button>"Plain"</button></form>
        },
    )
}
async fn action_cost_plain(req: Req, Params(p): Params<url_action_cost::Desk>, Form(_): Form<ActionPrice>) -> HtmlResult {
    req.redirect(&url_action_cost::Desk { page: p.page })
}
async fn action_cost_price(req: Req, Params(p): Params<url_action_cost::Desk>, Form(_): Form<ActionPrice>) -> HtmlResult {
    req.redirect(&url_action_cost::Desk { page: p.page })
}
async fn action_cost_route(req: Req, Params(p): Params<url_action_cost::DeskPrice>, Form(_): Form<ActionPrice>) -> HtmlResult {
    req.redirect(&url_action_cost::Desk { page: p.page })
}

/// What a page with named posts costs on the request path (#1403): `ACTION_REQUESTS` (200)
/// requests in process, one at a time, by `ACTION_CASE`: `get` draws the page at `/desk?page=3`,
/// `plain` posts a urlencoded form there (its plain `post`), `named` posts it to
/// `/desk?page=3&do=price` (a named post) and `route` to `/desk/price?page=3`, a route of its own
/// that declares the page's query again, the shape named posts replace. Each post reads
/// the page's query and the form and redirects back. Counting it under callgrind at two numbers of
/// requests gives the instructions per request. The test binary has no global allocator, so
/// preload the one to count with. Run in release: `cargo test --release -p corten-run --all-features --lib --no-run`,
/// then
/// `ACTION_CASE=named ACTION_REQUESTS=1200 LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 valgrind --tool=callgrind <that binary> --ignored --exact tests::actions::what_a_page_with_posts_costs`
/// (Debian's `libjemalloc2`) and again at 200.
#[test]
#[ignore]
fn what_a_page_with_posts_costs() {
    let requests: usize = std::env::var("ACTION_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let case = std::env::var("ACTION_CASE").unwrap_or_else(|_| "get".into());
    let (method, uri) = match case.as_str() {
        "get" => ("GET", "/desk?page=3"),
        "plain" => ("POST", "/desk?page=3"),
        "named" => ("POST", "/desk?page=3&do=price"),
        "route" => ("POST", "/desk/price?page=3"),
        other => panic!("ACTION_CASE {other}"),
    };
    let router = App::new(url_action_cost::router()).router();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        for _ in 0..requests {
            let req = Request::builder()
                .method(method)
                .uri(uri)
                .header("host", "app.localhost")
                .header("sec-fetch-site", "same-origin");
            let req = match method {
                "GET" => req.body(Body::empty()),
                _ => req.header("content-type", "application/x-www-form-urlencoded").body(Body::from("price=7")),
            };
            let res = router.clone().oneshot(req.unwrap()).await.unwrap();
            let status = res.status();
            let _ = res.into_body().collect().await.unwrap();
            assert_eq!(status, if method == "GET" { StatusCode::OK } else { StatusCode::SEE_OTHER }, "{case}");
        }
    });
}

/// A page with several posts (`post(name) = ..`, #1403): each is sent to the page's own address
/// with `do=name`, a urlencoded form and a multipart upload alike, and reads the page's query.
#[crate::routes]
mod url_actions {
    #[route("/desk", get = actions_page, post = actions_plain, post(price) = actions_price, post(photo) = actions_photo, post(refuse) = actions_refuse)]
    pub struct Desk {
        pub page: Option<u32>,
    }

    #[route("/bare", get = actions_page_bare, post(go) = actions_go)]
    pub struct Bare;
}

#[derive(Fields)]
struct ActionPrice {
    price: u32,
}

#[derive(Fields)]
struct ActionPhoto {
    photo: crate::Files,
}

/// The desk at `at`, each of its forms naming where it posts.
fn actions_desk(req: &Req, at: &url_actions::Desk) -> HtmlResult {
    req.test_page(
        "Desk",
        html! {
            <form method="post" action={at.price()}>
                <button>"Price"</button>
                <button formaction={at.photo()}>"Photo"</button>
            </form>
            <form method="post" action={at}><button>"Plain"</button></form>
        },
    )
}

async fn actions_page(req: Req, Params(p): Params<url_actions::Desk>) -> HtmlResult {
    actions_desk(&req, &url_actions::Desk { page: p.page })
}

async fn actions_plain(req: Req, Params(p): Params<url_actions::Desk>) -> HtmlResult {
    req.redirect_with_notice(&url_actions::Desk { page: p.page }, "plain")
}

async fn actions_price(req: Req, Params(p): Params<url_actions::Desk>, Form(form): Form<ActionPrice>) -> HtmlResult {
    let text = &format!("priced {} on page {:?}", form.price, p.page);
    req.patch_or(html! { <p id={MsgId}>{text}</p> }, || async {
        req.redirect_with_notice(&url_actions::Desk { page: p.page }, text)
    })
    .await
}

async fn actions_photo(req: Req, Params(p): Params<url_actions::Desk>, mut upload: crate::Upload<ActionPhoto>) -> HtmlResult {
    let mut name = String::new();
    while let Some(file) = upload.next_file().await? {
        if file.is(ActionPhoto::FIELDS.photo) {
            name = file.filename().to_string();
        }
    }
    req.redirect_with_notice(&url_actions::Desk { page: p.page }, format_args!("photo {name} on page {:?}", p.page))
}

/// Refused: the desk again, at the action's address, with a post form that names no address,
/// which would post to that action again (the debug check below).
async fn actions_refuse(req: Req) -> HtmlResult {
    let mut res = req.test_page("Refused", html! { <form method="post"><button>"Again"</button></form> })?;
    *res.status_mut() = StatusCode::UNPROCESSABLE_ENTITY;
    Ok(res)
}

async fn actions_page_bare(req: Req) -> HtmlResult {
    req.test_page("Bare", html! { <p>"bare"</p> })
}

async fn actions_go(req: Req) -> HtmlResult {
    req.redirect(&url_actions::Bare)
}

/// A multipart body with one file, `photo`, named `name`.
fn actions_multipart(name: &str) -> String {
    format!("--b\r\ncontent-disposition: form-data; name=\"photo\"; filename=\"{name}\"\r\ncontent-type: image/png\r\n\r\nPNG\r\n--b--\r\n")
}

#[test]
fn an_actions_address_is_the_pages_with_do() {
    let at = url_actions::Desk { page: Some(2) };
    assert_eq!(at.price().to_string(), "/desk?page=2&do=price");
    assert_eq!(url_actions::Desk { page: None }.price().to_string(), "/desk?do=price");
    assert_eq!(url_actions::Bare.go().to_string(), "/bare?do=go");
    let form = html! { <form method="post" action={at.price()}><button formaction={at.photo()}>"Photo"</button></form> };
    assert_eq!(
        form.to_html(),
        r#"<form method="post" action="/desk?page=2&amp;do=price"><button formaction="/desk?page=2&amp;do=photo">Photo</button></form>"#
    );
}

#[tokio::test]
async fn each_post_goes_to_the_handler_its_do_names_urlencoded_or_multipart() {
    let app = App::new(url_actions::router()).test();
    let at = url_actions::Desk { page: Some(2) };
    // Urlencoded, without JavaScript: the handler reads the page's query and sends it back there.
    let priced = app.post(&at.price()).field(ActionPrice::FIELDS.price, 7).await;
    assert_eq!(priced.status(), StatusCode::SEE_OTHER);
    assert_eq!(priced.location().as_ref().map(crate::Local::as_str), Some("/desk?page=2"));
    // The runtime's `data-patch` send of the same form gets the handler's patch.
    let patch = app.post(&at.price()).field(ActionPrice::FIELDS.price, 7).mode(crate::Mode::Action).await;
    assert!(patch.headers().contains_key("corten-patch"), "{:?}", patch.headers());
    assert_eq!(patch.text(), r#"<p id="msg">priced 7 on page Some(2)</p>"#);
    // Multipart: the router read only the address, so the handler's `Upload` reads the body.
    let photo =
        app.call(http::Method::POST, &at.photo()).body("multipart/form-data; boundary=b", actions_multipart("me.png")).await;
    assert_eq!(photo.status(), StatusCode::SEE_OTHER, "{}", photo.text());
    assert_eq!(photo.location().as_ref().map(crate::Local::as_str), Some("/desk?page=2"));
    // A post with no `do` is the page's plain `post`.
    let plain = app.post(&at).await;
    assert_eq!(
        (plain.status(), plain.location().as_ref().map(crate::Local::as_str)),
        (StatusCode::SEE_OTHER, Some("/desk?page=2"))
    );
    // The key is `do` alone, wherever it is in the query: a key that starts with it is not.
    let local = |path| crate::Local::parse(path).unwrap();
    let priced =
        app.post(&local("/desk?done=1&dot&page=2&do=price")).field(ActionPrice::FIELDS.price, 7).mode(crate::Mode::Action).await;
    assert_eq!(priced.text(), r#"<p id="msg">priced 7 on page Some(2)</p>"#);
    assert_eq!(app.post(&local("/desk?dot=1&page=2")).await.location().as_ref().map(crate::Local::as_str), Some("/desk?page=2"));
    // The key and the name are read decoded, as `Params` reads the query: `%64o=pr%69ce` is `do=price`.
    let priced =
        app.post(&local("/desk?page=2&%64o=pr%69ce")).field(ActionPrice::FIELDS.price, 7).mode(crate::Mode::Action).await;
    assert_eq!(priced.text(), r#"<p id="msg">priced 7 on page Some(2)</p>"#);
}

#[tokio::test]
async fn a_post_no_handler_of_the_page_is_for_is_a_400_and_a_get_of_an_action_draws_the_page() {
    let app = App::new(url_actions::router()).test();
    let local = |path| crate::Local::parse(path).unwrap();
    for path in [
        "/desk?do=sell",
        "/desk?do=price&do=photo",
        "/desk?do=price&%64o=photo",
        "/desk?do=price&do",
        "/desk?do=",
        "/desk?do",
        "/bare",
        "/bare?do=price",
    ] {
        let res = app.post(&local(path)).field(ActionPrice::FIELDS.price, 7).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{path}: {}", res.text());
    }
    // A client that does not ask for HTML reads why.
    let router = App::new(url_actions::router()).router();
    let (status, _, text) = post_page_send(&router, "/desk?do=sell", &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(text, r#"the page has no post named "sell" (do=sell); its posts are price, photo, refuse"#);
    // A `GET` (and a `HEAD`) of an action's address runs no handler: it draws the page.
    let at = url_actions::Desk { page: Some(3) };
    let page = app.get(&at.price()).await;
    assert_eq!(page.status(), StatusCode::OK);
    assert!(page.text().contains(r#"action="/desk?page=3&amp;do=price""#), "the page, its query read: {}", page.text());
    assert_eq!(app.call(http::Method::HEAD, &at.photo()).await.status(), StatusCode::OK);
    // The route allows `POST` though it has only named posts.
    let options = app.call(http::Method::OPTIONS, &url_actions::Bare).await;
    assert_eq!(options.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(options.headers()["allow"], "GET,HEAD,POST");
}

/// A page drawn at an action's address stays there, so a post form in it with no `action` would
/// post to that action again: a debug build answers it as an error that says so. A page whose
/// every post form names its address is drawn there as it is.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_page_at_an_actions_address_with_a_post_form_without_action_is_an_error_in_debug_builds() {
    let app = App::new(url_actions::router()).test();
    let refused = app.post(&url_actions::Desk { page: None }.refuse()).await;
    assert_eq!(refused.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(
        refused.text().contains("is drawn at one of its posts&#39; addresses (do=..)"),
        "outside dev too: {}",
        refused.text()
    );
    assert_eq!(app.get(&url_actions::Desk { page: None }.price()).await.status(), StatusCode::OK, "every form names its address");
    let elsewhere = App::new(Routes::from(Table::new().route(
        "/",
        get(|req: Req| async move { req.test_page("Form", html! { <form method="post"><button>"Go"</button></form> }) }),
    )))
    .test();
    // A route with no named posts may have a `do` of its own: its page is not read.
    assert_eq!(elsewhere.get(&crate::Local::parse("/?do=x").unwrap()).await.status(), StatusCode::OK, "no named posts, no check");
}
