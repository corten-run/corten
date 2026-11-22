//! Release Callgrind fixture for the pages the app keeps (`docs/design.md#choice-kept-pages`).
//! Build with `cargo test --release -p corten-run --test kept_cost --no-run`, then run that binary
//! under `valgrind --tool=callgrind --callgrind-out-file=<file>` with `--ignored --exact
//! request_cost`, `KEPT_CASE=hit|made|again|plain|full` and `REQUESTS=1200`, and again with
//! `REQUESTS=200`; subtract the totals and divide by 1,000. `hit` is a kept page given again;
//! `made` a page made and kept, at a query not asked for before; `again` a write to the page's
//! path and then the page made again in the place of the copy the write dropped, counted
//! together; `plain` a page for one visitor, whose route keeps nothing; `full` a page made at a
//! query not asked for before in a full store (a bound of 4 MiB, filled before the counted
//! requests), which the store does not keep. Every answer's status,
//! whether it was a kept one, and its body are checked, and after the counted requests one more
//! asks for the last URL they asked for, which must be given kept where its page was made (and
//! not where nothing is kept): the same one request at both counts. For `full` that URL is asked
//! for twice, its second request keeping the page and its third given it.
//!
//! A new URL whose mark is another's is taken for known and its page kept, with an answer the
//! client cannot tell from a refused one. So `full` counts only URLs the store refuses: a first
//! pass over [`CANDIDATES`] new URLs, in a second store filled the same way, asks for each twice
//! in a row and keeps those whose second request is not given the page (it made the page, so the
//! first was refused); a URL taken for known was kept the first time and given the second. The
//! counted requests ask for those URLs in the same order, so each sets the marks it set there and
//! is refused as it was. The pass is the same at both counts, so the subtraction leaves it out.

use std::time::Duration;

use corten::{
    http::{Body, Request, StatusCode},
    prelude::*,
    App, Public, Router,
};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// The new URLs the first pass of `full` asks for, of which the counted requests take those the
/// store refused: about 7 in 1,300 share a mark at 131,072 marks.
const CANDIDATES: usize = 1300;

#[corten::routes]
mod url {
    #[route("/kept", get = crate::kept, post = crate::saved)]
    pub struct Kept;

    #[route("/plain", get = crate::plain)]
    pub struct Plain;
}

fn document() -> impl corten::Document {
    html! {
        <html lang="en">
            <head>
                <title>"Kept cost"</title>
                <Corten />
            </head>
            <body>
                <main><p>"Kept cost fixture"</p></main>
            </body>
        </html>
    }
}

async fn kept(req: Req) -> Public<HtmlResult> {
    Public::new(Duration::from_secs(600), req.page(document()))
}

async fn saved() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn plain(req: Req) -> HtmlResult {
    req.page(document())
}

fn get(uri: &str) -> Request {
    Request::get(uri)
        .header("host", "localhost")
        .header("accept", "text/html,application/xhtml+xml,*/*;q=0.8")
        .body(Body::empty())
        .unwrap()
}

/// One request's answer: its status, whether it was a kept one (it has an `Age`), and its body.
async fn send(router: &Router, req: Request) -> (StatusCode, bool, bytes::Bytes) {
    let res = router.clone().oneshot(req).await.unwrap();
    let (status, given) = (res.status(), res.headers().contains_key("age"));
    (status, given, res.into_body().collect().await.unwrap().to_bytes())
}

/// An app whose store of 4 MiB (131,072 marks) is full, made the same way each time, with the
/// page at `/kept`, asked for first: then each new URL is asked for twice until the second is no
/// longer given the page the first made.
async fn filled() -> (Router, bytes::Bytes) {
    let router = App::new(url::router()).dev(false).kept_answers(4 << 20).router();
    let (status, given, body) = send(&router, get("/kept")).await;
    assert!(status == StatusCode::OK && !given);
    let mut filled = 0;
    loop {
        let at = format!("/kept?fill={filled}");
        send(&router, get(&at)).await;
        if !send(&router, get(&at)).await.1 {
            break;
        }
        filled += 1;
        assert!(filled < 10_000, "the store never filled");
    }
    (router, body)
}

/// Of [`CANDIDATES`] new URLs asked for in order in a full store, those it refused, in that order;
/// those it took for known are named on standard error.
async fn refused() -> Vec<String> {
    let (router, _) = filled().await;
    let (mut refused, mut known) = (Vec::new(), Vec::new());
    for n in 0..CANDIDATES {
        let at = format!("/kept?n={n}");
        let (status, given, _) = send(&router, get(&at)).await;
        assert!(status == StatusCode::OK && !given, "{at}");
        if send(&router, get(&at)).await.1 {
            known.push(at);
        } else {
            refused.push(at);
        }
    }
    eprintln!("full: {} of {CANDIDATES} new URLs refused; taken for known: {known:?}", refused.len());
    refused
}

#[test]
#[ignore = "measure the release test binary under Callgrind"]
fn request_cost() {
    let case = std::env::var("KEPT_CASE").unwrap_or_else(|_| "hit".into());
    let requests = std::env::var("REQUESTS").map_or(200, |value| value.parse::<usize>().unwrap());
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let full = if case == "full" { refused().await } else { Vec::new() };
        assert!(case != "full" || full.len() >= requests, "{} of {CANDIDATES} new URLs refused", full.len());
        let path = if case == "plain" { "/plain" } else { "/kept" };
        // One answer, outside the counted loop: the body every answer is checked against.
        let (router, body) = if case == "full" {
            filled().await
        } else {
            let router = App::new(url::router()).dev(false).router();
            let (status, given, body) = send(&router, get(path)).await;
            assert!(status == StatusCode::OK && !given, "{case}");
            (router, body)
        };
        let send = |req: Request| send(&router, req);
        assert!(std::str::from_utf8(&body).unwrap().contains("<main><p>Kept cost fixture</p></main>"));
        for n in 0..requests {
            let (expected, answer) = match case.as_str() {
                "hit" => (true, send(get("/kept")).await),
                "made" => (false, send(get(&format!("/kept?n={n}"))).await),
                "full" => (false, send(get(&full[n])).await),
                "again" => {
                    let write = Request::post("/kept")
                        .header("host", "localhost")
                        .header("sec-fetch-site", "same-origin")
                        .body(Body::empty())
                        .unwrap();
                    let (status, _, _) = send(write).await;
                    assert_eq!(status, StatusCode::NO_CONTENT);
                    (false, send(get("/kept")).await)
                }
                "plain" => (false, send(get("/plain")).await),
                _ => panic!("unknown KEPT_CASE: {case}"),
            };
            assert_eq!(answer, (StatusCode::OK, expected, body.clone()), "{case} {n}");
        }
        let last = match case.as_str() {
            "made" => format!("/kept?n={}", requests.saturating_sub(1)),
            "full" => full[requests.saturating_sub(1)].clone(),
            _ => path.to_owned(),
        };
        if case == "full" {
            let answer = send(get(&last)).await;
            assert_eq!(answer, (StatusCode::OK, false, body.clone()), "{case}: the second request keeps the page");
        }
        let answer = send(get(&last)).await;
        assert_eq!(answer, (StatusCode::OK, case != "plain", body.clone()), "{case}: the last page made was kept");
    });
}
