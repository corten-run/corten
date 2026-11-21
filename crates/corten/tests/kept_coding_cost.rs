//! Release Callgrind fixture for a kept page's compressed forms (`docs/design.md#choice-kept-pages`).
//! Build with `cargo test --release -p corten-run --all-features --test kept_coding_cost --no-run`,
//! then run that binary under `valgrind --tool=callgrind --callgrind-out-file=<file>` with
//! `--ignored --exact request_cost`, `KEPT_CASE=hit|made`, `KEPT_ACCEPT` (the request's
//! `Accept-Encoding`: a browser's `gzip, deflate, br, zstd` unless set, `identity` for an
//! uncompressed request) and `REQUESTS=1200`, and again with `REQUESTS=200`; subtract the totals
//! and divide by 1,000. `hit` is a kept page given again, asked for twice and then left two
//! seconds before the count, so what is made for it after its answers is there; `made` a page made
//! and kept, at a query not asked for before. Every answer's status, whether it was a kept one and
//! its coding are checked, and its body: a kept one's is the bytes the first was given (the same
//! allocation), a made one's the same bytes, and the first decodes to the page uncompressed. The
//! URLs are made before the loop, which allocates only for each request and its body. The coding
//! and bytes given are printed, and with `KEPT_BODY=<file>` the body is written there, to compare two builds' bytes.
#![cfg(feature = "compress")]

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

fn get(uri: &str, accept: &str) -> Request {
    Request::get(uri)
        .header("host", "localhost")
        .header("accept", "text/html,application/xhtml+xml,*/*;q=0.8")
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
    let router = App::new(url::router()).dev(false).router();
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
        // The page uncompressed, at a URL of its own: the handler does not read the query.
        let (_, _, page) = send("/record?uncompressed", "identity").await;
        if hit {
            send("/record", &accept).await;
            send("/record", &accept).await;
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let uris: Vec<String> =
            (0..=requests).map(|n| if hit { "/record".to_owned() } else { format!("/record?n={n}") }).collect();
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