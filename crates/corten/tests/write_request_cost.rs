//! Release Callgrind fixture for document and navigation GETs and action patches with and without
//! layout reads. Subtract a 200-request run from a 1,200-request run, then divide by 1,000.
//! Run the `write_request_cost` test binary with `--ignored --exact request_cost`, setting
//! `PATH_CASE=document|navigation|typed|generic|own`, `READS=0|1` and `REQUESTS=200|1200`.
//! `LEGACY=1` leaves out the preference to measure the late-write bookkeeping separately.

use std::future::Future;

use corten::{
    http::{request::Parts, Body, Request, Response, StatusCode},
    prelude::*,
    LayoutRead,
};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[derive(Id)]
struct Message;

#[corten::routes]
mod url {
    #[route("/page", get = crate::page, post = crate::page)]
    pub struct Page;

    #[route("/typed", post = crate::typed)]
    pub struct Typed;

    #[route("/generic", post = crate::generic)]
    pub struct Generic;
}

async fn page(req: Req) -> HtmlResult {
    req.page(html! {
        <html lang="en">
            <head>
                <title>"Request cost"</title>
                <Corten />
            </head>
            <body>
                <header>{later::<Count>()}</header>
                <main><p>"Request cost fixture"</p></main>
            </body>
        </html>
    })
}

async fn typed(req: Req) -> HtmlResult<Patches> {
    req.patch(html! { <p id={Message}>"Request cost fixture"</p> })
}

async fn generic(req: Req) -> HtmlResult {
    req.patch(html! { <p id={Message}>"Request cost fixture"</p> })
}

struct Count;

impl LayoutRead for Count {
    type Value = u32;

    fn start(&self, _: &Parts) -> Option<impl Future<Output = u32> + Send + 'static> {
        Some(async { 3 })
    }

    fn view(value: &u32) -> impl Render + '_ {
        html! { <span>{value}</span> }
    }
}

#[test]
#[ignore = "measure the release test binary under Callgrind"]
fn request_cost() {
    let case = std::env::var("PATH_CASE").unwrap_or_else(|_| "document".into());
    let reads = std::env::var("READS").is_ok_and(|value| value == "1");
    let legacy = std::env::var("LEGACY").is_ok_and(|value| value == "1");
    let requests = std::env::var("REQUESTS").map_or(200, |value| value.parse::<usize>().unwrap());
    let app = App::new(url::router());
    let router = if reads { app.layout_read(Count).router() } else { app.router() };
    let request = || {
        let req = match case.as_str() {
            "document" => Request::builder().uri("/page").header("accept", "text/html"),
            "navigation" => Request::builder().uri("/page").header("corten", "nav"),
            "typed" => Request::builder().method("POST").uri("/typed").header("corten", "action"),
            "generic" => Request::builder().method("POST").uri("/generic").header("corten", "action"),
            "own" => Request::builder().method("POST").uri("/page").header("corten", "action"),
            _ => panic!("unknown PATH_CASE: {case}"),
        };
        let req = if !legacy && matches!(case.as_str(), "typed" | "generic" | "own") {
            req.header("prefer", "corten-draws=whole")
        } else {
            req
        };
        req.body(Body::empty()).unwrap()
    };
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        // Check and warm up outside the variable-length loop.
        let res = router.clone().oneshot(request()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers().contains_key("corten-patch"), matches!(case.as_str(), "typed" | "generic"));
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert!(std::str::from_utf8(&body).unwrap().contains("Request cost fixture"));
        for _ in 0..requests {
            let Ok(res): Result<Response, _> = router.clone().oneshot(request()).await;
            std::hint::black_box(res);
        }
    });
}
