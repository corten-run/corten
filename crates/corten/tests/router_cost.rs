//! In-process request work for callgrind, per CONTRIBUTING.md, Pull requests item 2.
//! Build with `cargo test --release -p corten-run --test router_cost --no-run`, then run that
//! binary under `valgrind --tool=callgrind --callgrind-out-file=<file>` with
//! `--ignored --exact request_cost`, `ROUTER_REQUESTS=1200` and again `ROUTER_REQUESTS=200`.
//! Subtract totals and divide by 1,000. `ROUTER_TARGET=missing` counts a 404; otherwise it
//! counts the matched parameter route. No sockets, fixture or global allocator is needed.

use corten::{App, Params};
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

#[test]
#[ignore]
fn request_cost() {
    let requests: usize = std::env::var("ROUTER_REQUESTS").ok().map(|n| n.parse().unwrap()).unwrap_or(200);
    let missing = std::env::var("ROUTER_TARGET").is_ok_and(|target| target == "missing");
    let path = if missing { "/items/7/unknown" } else { "/items/7/edit" };
    let status = if missing { 404 } else { 200 };
    let router = App::new(url::router()).router();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        for _ in 0..requests {
            let req = http::Request::get(path).body(corten::http::Body::empty()).unwrap();
            let response = router.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status().as_u16(), status);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            if !missing {
                assert_eq!(body.as_ref(), b"item 7");
            }
        }
    });
}
