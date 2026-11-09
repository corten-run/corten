//! The stream budget counts the share each open stream's coder reserves, turns a stream away past
//! it (the stream goes out uncompressed) and gets the share back however the stream ends: dropped
//! unread, read to its end, or cut by an error. The budget is the process's, so this runs in a
//! process of its own and is the only test here: another test's streams would move it.
#![cfg(feature = "compress")]

use axum::{
    body::Body,
    extract::Path,
    http::{header, Request, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use bytes::Bytes;
use futures_util::{stream, StreamExt};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// How many zstd streams the budget holds: `compress.rs`'s `STREAM_BUDGET` (256 MiB) over
/// `ZSTD_STREAM_BYTES` (480 KiB). A change to either changes this.
const ZSTD_STREAMS: usize = (256 << 20) / (480 << 10);

/// An event stream that stays open, ends after its first event, or fails after it.
async fn events(Path(end): Path<String>) -> Response {
    let first = stream::iter([Ok::<_, std::io::Error>(Bytes::from_static(b"data: 1\n\n"))]);
    let body = match end.as_str() {
        "open" => Body::from_stream(first.chain(stream::pending())),
        "ends" => Body::from_stream(first),
        "fails" => Body::from_stream(first.chain(stream::iter([Err(std::io::Error::other("cut"))]))),
        other => unreachable!("{other}"),
    };
    Response::builder().header(header::CONTENT_TYPE, "text/event-stream").body(body).unwrap()
}

async fn request(app: &Router, end: &str) -> Response {
    let req = Request::get(format!("/{end}")).header(header::ACCEPT_ENCODING, "zstd").body(Body::empty()).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    res
}

/// Whether the stream was given a coder, and so a share of the budget.
fn coded(res: &Response) -> bool {
    res.headers().get(header::CONTENT_ENCODING).is_some_and(|v| v == "zstd")
}

#[tokio::test]
async fn the_stream_budget_is_given_back_however_a_stream_ends() {
    let app = corten::compress::apply(Router::new().route("/{end}", get(events)));
    // Streams left open fill the budget; the next goes out as it is.
    let mut open = Vec::new();
    loop {
        let res = request(&app, "open").await;
        if !coded(&res) {
            break;
        }
        open.push(res);
    }
    assert_eq!(open.len(), ZSTD_STREAMS, "the budget holds this many zstd streams");
    // A client that goes away: its stream is dropped unread.
    open.pop();
    let res = request(&app, "open").await;
    assert!(coded(&res), "a stream dropped unread gives its share back");
    open.push(res);
    assert!(!coded(&request(&app, "open").await), "and the budget is full again");
    // A stream read to its end, and one cut by an error.
    for end in ["ends", "fails"] {
        open.pop();
        let res = request(&app, end).await;
        assert!(coded(&res), "{end}: a share was free");
        assert_eq!(res.into_body().collect().await.is_ok(), end == "ends");
        let res = request(&app, "open").await;
        assert!(coded(&res), "a stream that {end} gives its share back");
        open.push(res);
        assert!(!coded(&request(&app, "open").await), "{end}: and the budget is full again");
    }
}
