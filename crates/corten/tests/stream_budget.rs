//! The stream budget counts the share each open stream's coder reserves, turns a stream away past
//! it (the stream goes out uncompressed) and gets the share back however the stream ends: dropped
//! unread, read to its end, or cut by an error. The budget is the process's, so this runs in a
//! process of its own and is the only test here: another test's streams would move it.
#![cfg(feature = "compress")]

use bytes::Bytes;
use corten::{
    answer::Body,
    http::{header, Request, Response, StatusCode},
    App, Media, Router,
};
use futures_util::{stream, StreamExt};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// How many zstd streams the budget holds: `compress.rs`'s `STREAM_BUDGET` (256 MiB) over
/// `ZSTD_STREAM_BYTES` (480 KiB). A change to either changes this.
const ZSTD_STREAMS: usize = (256 << 20) / (480 << 10);

/// An event stream's first event, as each stream below starts.
fn first() -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    stream::iter([Ok(Bytes::from_static(b"data: 1\n\n"))])
}

/// An event stream that stays open.
async fn open() -> Media {
    Media::stream("text/event-stream", first().chain(stream::pending()))
}

/// One that ends after its first event.
async fn ends() -> Media {
    Media::stream("text/event-stream", first())
}

/// One that fails after it.
async fn fails() -> Media {
    Media::stream("text/event-stream", first().chain(stream::iter([Err(std::io::Error::other("cut"))])))
}

#[corten::routes]
mod url {
    #[route("/open", get = open)]
    pub struct Open;

    #[route("/ends", get = ends)]
    pub struct Ends;

    #[route("/fails", get = fails)]
    pub struct Fails;
}

async fn request(app: &Router, end: &str) -> Response<Body> {
    let req = Request::get(format!("/{end}")).header(header::ACCEPT_ENCODING, "zstd").body(Body::empty()).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    res
}

/// Whether the stream was given a coder, and so a share of the budget.
fn coded(res: &Response<Body>) -> bool {
    res.headers().get(header::CONTENT_ENCODING).is_some_and(|v| v == "zstd")
}

#[tokio::test]
async fn the_stream_budget_is_given_back_however_a_stream_ends() {
    let app = App::new(url::router()).router();
    // Streams left open fill the budget; the next goes out as it is. Bounded, so a budget that
    // stops counting fails here rather than holding streams until memory runs out.
    let mut open = Vec::new();
    for n in 0..ZSTD_STREAMS {
        let res = request(&app, "open").await;
        assert!(coded(&res), "stream {n} of the {ZSTD_STREAMS} the budget holds");
        open.push(res);
    }
    assert!(!coded(&request(&app, "open").await), "the budget holds no more than {ZSTD_STREAMS}");
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
