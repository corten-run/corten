//! In-process request work for callgrind, per CONTRIBUTING.md, Pull requests item 2.
//! Build with `cargo test --release -p corten-run --test router_cost --no-run`, then run that
//! binary under `valgrind --tool=callgrind --callgrind-out-file=<file>` with
//! `--ignored --exact request_cost`, `ROUTER_REQUESTS=1200` and again `ROUTER_REQUESTS=200`.
//! Subtract totals and divide by 1,000. `ROUTER_TARGET=missing` counts a 404; otherwise it
//! counts the matched parameter route. No sockets, fixture or global allocator is needed.
//!
//! What a write pays for the answers the app keeps: `ROUTER_TARGET=write` counts a `POST` to
//! the same path (a route with no parameter, so the three apps share its handlers), in an app
//! with no `Public` route, or with `ROUTER_PUBLIC=words` one whose
//! `Public` text is too small to keep, or with `ROUTER_PUBLIC=page` a `Public` page.
//! `ROUTER_ASKED=1` asks for that route three times first, so a page is kept by then.
//! `ROUTER_TARGET=kept` with `ROUTER_PUBLIC=page` counts the kept page given again, and
//! `ROUTER_TARGET=new` with it a page no kept one stands for, made and kept: a new URL each
//! request (`/home?n=1`, ...), in a store with room for all of them.
//! `ROUTER_KEPT=0` turns the store off (`App::kept_answers(0)`), for what a write pays the store
//! in the same app; with it nothing is kept, so `ROUTER_ASKED=1` and `ROUTER_TARGET=kept` with a
//! page, which assert that one is, do not go with it.
//!
//! What a write pays for naming the page it changed: `ROUTER_NAMED=1` with `ROUTER_TARGET=write`
//! and `ROUTER_PUBLIC=page` gives the write a handler that takes `KeptAnswers` and calls
//! `changed(&Home)` before it answers, as an app's handler does, in the same app otherwise. With
//! `ROUTER_KEPT=0` that handler finds no store, so the call does nothing; with `ROUTER_ASKED=1`
//! the store has its counts by path, and each write drops the page kept at `/home`. Compare it
//! with the same variables but `ROUTER_NAMED`, whose handler takes nothing and names nothing.

use std::time::Duration;

use corten::{prelude::*, App, KeptAnswers, Params, Public};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[corten::routes]
mod url {
    #[route("/items/{id}/edit", get = crate::item)]
    pub struct Item {
        pub id: u32,
    }
}

async fn item(at: Params<url::Item>) -> String {
    format!("item {}", at.id)
}

/// The route with a write, and no `Public` route.
#[corten::routes]
mod plain {
    #[route("/items/7/edit", get = crate::read, post = crate::save)]
    pub struct Item;
}

/// With a `Public` text route whose answer is too small for the app to keep.
#[corten::routes]
mod words {
    #[route("/items/7/edit", get = crate::read, post = crate::save)]
    pub struct Item;

    #[route("/words", get = crate::few)]
    pub struct Words;
}

/// With a `Public` page.
#[corten::routes]
mod paged {
    #[route("/items/7/edit", get = crate::read, post = crate::save)]
    pub struct Item;

    #[route("/home", get = crate::home)]
    pub struct Home;
}

/// With a `Public` page, and a write that says the page changed.
#[corten::routes]
mod named {
    #[route("/items/7/edit", get = crate::read, post = crate::save_named)]
    pub struct Item;

    #[route("/home", get = crate::home)]
    pub struct Home;
}

async fn save_named(kept: KeptAnswers) -> &'static str {
    kept.changed(&named::Home);
    "saved"
}

async fn read() -> &'static str {
    "item"
}

async fn save() -> &'static str {
    "saved"
}

async fn few() -> Public<&'static str> {
    Public::new(Duration::from_secs(60), "words")
}

async fn home(req: Req) -> Public<HtmlResult> {
    let page = html! {
        <html lang="en">
            <head>
                <title>"Home"</title>
                <Corten />
            </head>
            <body>
                <main><p>"Request cost fixture"</p></main>
            </body>
        </html>
    };
    Public::new(Duration::from_secs(60), req.page(page))
}

#[test]
#[ignore]
fn request_cost() {
    let requests: usize = std::env::var("ROUTER_REQUESTS").ok().map(|n| n.parse().unwrap()).unwrap_or(200);
    let target = std::env::var("ROUTER_TARGET").unwrap_or_default();
    let public = std::env::var("ROUTER_PUBLIC").unwrap_or_default();
    let asked = std::env::var("ROUTER_ASKED").is_ok_and(|asked| asked == "1");
    let (missing, write, kept, new) = (target == "missing", target == "write", target == "kept", target == "new");
    let path = if missing { "/items/7/unknown" } else { "/items/7/edit" };
    let status = if missing { 404 } else { 200 };
    let named = std::env::var("ROUTER_NAMED").is_ok_and(|named| named == "1");
    assert!(!named || (write && public == "page"), "ROUTER_NAMED=1 needs ROUTER_TARGET=write and ROUTER_PUBLIC=page");
    let (routes, shared) = match (write || kept || new, public.as_str()) {
        (false, _) => (url::router(), None),
        (true, "") => (plain::router(), None),
        (true, "words") => (words::router(), Some("/words")),
        (true, "page") if named => (named::router(), Some("/home")),
        (true, "page") => (paged::router(), Some("/home")),
        (true, _) => panic!("unknown ROUTER_PUBLIC: {public}"),
    };
    let app = App::new(routes);
    let off = std::env::var("ROUTER_KEPT").is_ok_and(|kept| kept == "0");
    let router = if off { app.kept_answers(0).router() } else { app.router() };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let ask = |path: &'static str| {
            let router = router.clone();
            async move {
                let req = http::Request::get(path).body(corten::http::Body::empty()).unwrap();
                let response = router.oneshot(req).await.unwrap();
                assert_eq!(response.status().as_u16(), 200);
                let aged = response.headers().contains_key("age");
                response.into_body().collect().await.unwrap();
                aged
            }
        };
        if let Some(shared) = shared.filter(|_| asked || kept) {
            let aged = [ask(shared).await, ask(shared).await, ask(shared).await];
            // A page is kept from its first answer, and text this small never is.
            assert_eq!(aged, [false, public == "page", public == "page"]);
        }
        if kept {
            let shared = shared.expect("ROUTER_TARGET=kept needs ROUTER_PUBLIC=page");
            for _ in 0..requests {
                assert!(ask(shared).await, "the kept page");
            }
            return;
        }
        if new {
            assert_eq!(shared, Some("/home"), "ROUTER_TARGET=new needs ROUTER_PUBLIC=page");
            for n in 0..requests {
                let req = http::Request::get(format!("/home?n={n}")).body(corten::http::Body::empty()).unwrap();
                let response = router.clone().oneshot(req).await.unwrap();
                assert_eq!(response.status().as_u16(), 200);
                assert!(!response.headers().contains_key("age"), "a new URL is made");
                response.into_body().collect().await.unwrap();
            }
            return;
        }
        for _ in 0..requests {
            let req =
                if write { http::Request::post(path).header("sec-fetch-site", "same-origin") } else { http::Request::get(path) };
            let response = router.clone().oneshot(req.body(corten::http::Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status().as_u16(), status);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            if write {
                assert_eq!(body.as_ref(), b"saved");
            } else if !missing {
                assert_eq!(body.as_ref(), b"item 7");
            }
        }
        if write && asked && !off && public == "page" {
            // The page at /home stands unless the writes named it.
            assert_eq!(ask("/home").await, !named, "ROUTER_NAMED={named}");
        }
    });
}
