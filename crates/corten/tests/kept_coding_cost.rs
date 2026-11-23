//! Release Callgrind fixture for a kept page's compressed forms (`docs/design.md#choice-kept-pages`).
//! Build with `cargo test --release -p corten-run --all-features --test kept_coding_cost --no-run`,
//! then run that binary under `valgrind --tool=callgrind --callgrind-out-file=<file>` with
//! `--ignored --exact request_cost`, `KEPT_CASE=hit|made`, `KEPT_ACCEPT` (the request's
//! `Accept-Encoding`: a browser's `gzip, deflate, br, zstd` unless set, `identity` for an
//! uncompressed request) and `REQUESTS=1200`, and again with `REQUESTS=200`; subtract the totals
//! and divide by 1,000. `KEPT_ROUTE=json` asks for a JSON body of about the page's size in its
//! place, as a data client does (`Accept: application/json`), and `page` (the default) for the
//! page. `hit` is a kept page given again, asked for 8,192 times and three more for each of its
//! bytes (when a client that ranks brotli first has asked that often, its brotli at the kept level
//! is due) and
//! then left two seconds before the count, so what is made for it after its answers is there; `made` a page made
//! and kept, at a query not asked for before. `KEPT_BOUND` sets the app's bound, and `KEPT_FILL`
//! other pages kept before a `hit` (the page at other queries, uncompressed, each asked for twice):
//! a bound that leaves room for the page and its zstd but not its brotli 5 counts a hit whose
//! brotli was refused. Every answer's status, whether it was a kept one and
//! its coding are checked, and its body: a kept one's is the bytes the first was given (the same
//! allocation), a made one's the same bytes, and the first decodes to the page uncompressed. The
//! URLs are made before the loop, which allocates only for each request and its body. The coding
//! and bytes given are printed, and with `KEPT_BODY=<file>` the body is written there, to compare two builds' bytes.
#![cfg(all(feature = "compress", feature = "json"))]

use std::io::Read;
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
    #[route("/record", get = crate::record)]
    pub struct Record;

    #[route("/records", get = crate::records)]
    pub struct Records;
}

const NAMES: [&str; 24] = [
    "Access",
    "Area",
    "Archive",
    "Boundary",
    "Condition",
    "Direction",
    "Environment",
    "Feature",
    "Ground",
    "Habitat",
    "Information",
    "Journey",
    "Key",
    "Location",
    "Material",
    "Notes",
    "Origin",
    "Path",
    "Quality",
    "Route",
    "Surface",
    "Terrain",
    "Use",
    "View",
];

/// A record page about the size of the catalog benchmark's (4.4 KB).
fn document() -> impl corten::Document {
    html! {
        <html lang="en">
            <head>
                <title>"Ridge trail 7"</title>
                <Corten />
            </head>
            <body>
                <main>
                    <h1>"Ridge trail 7"</h1>
                    <p>"Archive entry 7"</p>
                    <p>
                        "A walking route through the landscape, recorded for the shared catalog. Entry 7. Read the notes and related records before setting out."
                    </p>
                    <dl>
                        for name in NAMES {
                            <div>
                                <dt>{name}</dt>
                                <dd>{name}" notes for entry 7: North gate, woodland path and open ground."</dd>
                            </div>
                        }
                    </dl>
                </main>
            </body>
        </html>
    }
}

async fn record(req: Req) -> Public<HtmlResult> {
    Public::new(Duration::from_secs(600), req.page(document()))
}

/// The record's fields as JSON, about the page's size: a whole body the app keeps.
async fn records() -> Public<JsonResult<Vec<(String, String)>>> {
    let rows: Vec<(String, String)> = NAMES
        .iter()
        .map(|name| (name.to_string(), format!("{name} notes for entry 7: North gate, woodland path and open ground.")))
        .collect();
    let rows: JsonResult<Vec<(String, String)>> = Ok(Json(rows));
    Public::new(Duration::from_secs(600), rows)
}

fn get(uri: &str, accept: &str) -> Request {
    let kind = if uri.starts_with("/records") { "application/json" } else { "text/html,application/xhtml+xml,*/*;q=0.8" };
    Request::get(uri)
        .header("host", "localhost")
        .header("accept", kind)
        .header("accept-encoding", accept)
        .body(Body::empty())
        .unwrap()
}

#[test]
#[ignore = "measure the release test binary under Callgrind"]
fn request_cost() {
    let case = std::env::var("KEPT_CASE").unwrap_or_else(|_| "hit".into());
    let accept = std::env::var("KEPT_ACCEPT").unwrap_or_else(|_| "gzip, deflate, br, zstd".into());
    let requests = std::env::var("REQUESTS").map_or(200, |value| value.parse::<usize>().unwrap());
    let path = match std::env::var("KEPT_ROUTE").as_deref() {
        Ok("json") => "/records",
        Ok("page") | Err(_) => "/record",
        Ok(other) => panic!("unknown KEPT_ROUTE: {other}"),
    };
    let fill = std::env::var("KEPT_FILL").map_or(0, |value| value.parse::<usize>().unwrap());
    let app = App::new(url::router()).dev(false);
    let router = match std::env::var("KEPT_BOUND") {
        Ok(bound) => app.kept_answers(bound.parse().unwrap()),
        Err(_) => app,
    }
    .router();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let send = |uri: &str, accept: &str| {
            let req = get(uri, accept);
            let router = router.clone();
            async move {
                let res = router.oneshot(req).await.unwrap();
                let given = (res.status(), res.headers().contains_key("age"));
                let coding = res.headers().get("content-encoding").cloned();
                (given, coding, res.into_body().collect().await.unwrap().to_bytes())
            }
        };
        let hit = match case.as_str() {
            "hit" => true,
            "made" => false,
            _ => panic!("unknown KEPT_CASE: {case}"),
        };
        // The answer uncompressed, at a URL of its own: the handler does not read the query.
        let (_, _, page) = send(&format!("{path}?uncompressed"), "identity").await;
        if hit {
            let fills: Vec<String> = (0..fill).map(|n| format!("{path}?fill={n}")).collect();
            for uri in fills.iter().chain(&fills) {
                send(uri, "identity").await;
            }
            for _ in 0..8192 + 3 * page.len() {
                send(path, &accept).await;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let uris: Vec<String> = (0..=requests).map(|n| if hit { path.to_owned() } else { format!("{path}?n={n}") }).collect();
        let (given, coding, body) = send(&uris[requests], &accept).await;
        assert_eq!(given, (StatusCode::OK, hit), "{case}");
        let mut decoded = Vec::new();
        match coding.as_ref().map(|coding| coding.to_str().unwrap()) {
            None => decoded.extend_from_slice(&body),
            Some("br") => drop(brotli::Decompressor::new(&body[..], 4096).read_to_end(&mut decoded).unwrap()),
            Some("zstd") => decoded = zstd::stream::decode_all(&body[..]).unwrap(),
            Some("gzip") => drop(flate2::read::GzDecoder::new(&body[..]).read_to_end(&mut decoded).unwrap()),
            Some(other) => panic!("{other}"),
        }
        assert!(decoded == page, "{case}: the body decodes to the page");
        for uri in &uris[..requests] {
            let (again, same, bytes) = send(uri, &accept).await;
            assert!(again == given && same == coding, "{case} {uri}");
            if hit {
                assert!(bytes.as_ptr() == body.as_ptr() && bytes.len() == body.len(), "{case}: the bytes the first was given");
            } else {
                assert!(bytes == body, "{case}: the same bytes");
            }
        }
        if let Ok(file) = std::env::var("KEPT_BODY") {
            std::fs::write(file, &body).unwrap();
        }
        println!("{case}, accept-encoding {accept}: {coding:?}, {} bytes, {} uncompressed", body.len(), page.len());
    });
}
