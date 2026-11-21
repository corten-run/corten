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

use std::time::Duration;

use corten::{
    http::{Body, Request, StatusCode},
    prelude::*,
    App, Public,
};
use http_body_util::BodyExt;
use tower::ServiceExt;

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

#[test]
#[ignore = "measure the release test binary under Callgrind"]
fn request_cost() {
    let case = std::env::var("KEPT_CASE").unwrap_or_else(|_| "hit".into());
    let requests = std::env::var("REQUESTS").map_or(200, |value| value.parse::<usize>().unwrap());
    let mut app = App::new(url::router()).dev(false);
    if case == "full" {
        // 131,072 marks, so that few of the new URLs counted are taken for known and kept.
        app = app.kept_answers(4 << 20);
    }
    let router = app.router();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        // One answer each, outside the counted loop: the body every answer is checked against.
        let send = |req: Request| {
            let router = router.clone();
            async move {
                let res = router.oneshot(req).await.unwrap();
                let (status, given) = (res.status(), res.headers().contains_key("age"));
                (status, given, res.into_body().collect().await.unwrap().to_bytes())
            }
        };
        let path = if case == "plain" { "/plain" } else { "/kept" };
        let (status, given, body) = send(get(path)).await;
        assert!(status == StatusCode::OK && !given, "{case}");
        assert!(std::str::from_utf8(&body).unwrap().contains("<main><p>Kept cost fixture</p></main>"));
        if case == "full" {
            // Each new URL asked for twice, until the second is no longer given the page the first
            // made: the store is full.
            let mut filled = 0;
            loop {
                let at = format!("/kept?fill={filled}");
                send(get(&at)).await;
                if !send(get(&at)).await.1 {
                    break;
                }
                filled += 1;
                assert!(filled < 10_000, "the store never filled");
            }
        }
        for n in 0..requests {
            let (expected, answer) = match case.as_str() {
                "hit" => (true, send(get("/kept")).await),
                "made" | "full" => (false, send(get(&format!("/kept?n={n}"))).await),
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
            "made" | "full" => format!("/kept?n={}", requests.saturating_sub(1)),
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
