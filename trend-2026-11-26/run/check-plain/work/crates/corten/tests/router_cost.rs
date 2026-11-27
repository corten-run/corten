//! In-process request work for callgrind, per CONTRIBUTING.md, Pull requests item 2.
//! Build with `cargo test --release -p corten-run --test router_cost --no-run`, then run that
//! binary under `valgrind --tool=callgrind --callgrind-out-file=<file>` with
//! `--ignored --exact request_cost`, `ROUTER_REQUESTS=1200` and again `ROUTER_REQUESTS=200`.
//! Subtract totals and divide by 1,000. `ROUTER_TARGET=missing` counts a 404; otherwise it
//! counts the matched parameter route. No sockets, fixture or global allocator is needed.
//! `ROUTER_TARGET=unstaged` counts a text answer from a route outside the app's stages.
//! (`ROUTER_PUBLIC` and `ROUTER_ASKED` change nothing it counts: that route keeps no answer).
//! `ROUTER_TARGET=api` counts a text answer from a route under an API.
//!
//! What a write pays for the answers the app keeps: `ROUTER_TARGET=write` counts a `POST` to
//! the same path (a route with no parameter, so the three apps share its handlers), in an app
//! with no `Public` route, or with `ROUTER_PUBLIC=words` one whose
//! `Public` text is too small to keep, or with `ROUTER_PUBLIC=page` a `Public` page.
//! `ROUTER_ASKED=1` asks for that route three times first, so a page is kept by then.
//! `ROUTER_TARGET=kept` with `ROUTER_PUBLIC=page` counts the kept page given again.
//! `ROUTER_KEPT=0` turns the store off (`App::kept_answers(0)`), for what a write pays the store
//! in the same app; with it nothing is kept, so `ROUTER_ASKED=1` and `ROUTER_TARGET=kept` with a
//! page, which assert that one is, do not go with it.
//! `ROUTER_TARGET=unkept` with `ROUTER_PUBLIC=page` and `ROUTER_KEPT=2048` counts that page when
//! the app does not keep it: larger than its share of the bound, the last check before a page is
//! kept, so its handler runs and every check before is made for each request.
//! `ROUTER_TARGET=inserted` with `ROUTER_PUBLIC=page` counts that page kept: each request names a
//! URL of its own (`/home?n=<i>`), so each is a miss whose answer is put in the store, which has
//! room for them all.

use std::time::Duration;

use corten::{prelude::*, App, Params, Public};
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

/// The route outside the app's stages.
#[corten::routes]
mod bare {
    #[route("/items/7/edit", get = crate::read, unstaged)]
    pub struct Item;
}

/// The route under an API.
#[corten::routes(api = Api)]
mod api {
    #[route("/api")]
    pub struct Api;

    #[route("/api/items/7/edit", get = crate::read)]
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
    let (missing, write, kept, unstaged) = (target == "missing", target == "write", target == "kept", target == "unstaged");
    let (unkept, inserted) = (target == "unkept", target == "inserted");
    let mounted = target == "api";
    let path = match (missing, mounted) {
        (true, _) => "/items/7/unknown",
        (false, true) => "/api/items/7/edit",
        (false, false) => "/items/7/edit",
    };
    let status = if missing { 404 } else { 200 };
    let (routes, shared) = match (write || kept || unkept || inserted, public.as_str()) {
        (false, _) if unstaged => (bare::router(), None),
        (false, _) => (url::router(), None),
        (true, "") => (plain::router(), None),
        (true, "words") => (words::router(), Some("/words")),
        (true, "page") => (paged::router(), Some("/home")),
        (true, _) => panic!("unknown ROUTER_PUBLIC: {public}"),
    };
    let app = if mounted { App::new(routes).api(api::api) } else { App::new(routes) };
    let bound: Option<usize> = std::env::var("ROUTER_KEPT").ok().map(|bound| bound.parse().unwrap());
    let router = match bound {
        Some(bound) => app.kept_answers(bound).router(),
        None => app.router(),
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let ask = |path: &str| {
            let req = http::Request::get(path).body(corten::http::Body::empty()).unwrap();
            let router = router.clone();
            async move {
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
        if unkept {
            let shared = shared.expect("ROUTER_TARGET=unkept needs ROUTER_PUBLIC=page");
            for _ in 0..requests {
                assert!(!ask(shared).await, "the page the app does not keep");
            }
            return;
        }
        if inserted {
            let shared = shared.expect("ROUTER_TARGET=inserted needs ROUTER_PUBLIC=page");
            // Made before the requests, so each request's own work is all that is counted.
            let paths: Vec<String> = (0..requests).map(|n| format!("{shared}?n={n}")).collect();
            for path in &paths {
                assert!(!ask(path).await, "a URL not asked for before");
            }
            assert!(ask(&paths[0]).await, "each answer was kept");
            return;
        }
        if kept {
            let shared = shared.expect("ROUTER_TARGET=kept needs ROUTER_PUBLIC=page");
            for _ in 0..requests {
                assert!(ask(shared).await, "the kept page");
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
            } else if unstaged || mounted {
                assert_eq!(body.as_ref(), b"item");
            } else if !missing {
                assert_eq!(body.as_ref(), b"item 7");
            }
        }
    });
}
