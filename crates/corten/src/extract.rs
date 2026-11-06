//! Reading a request: the traits an extractor of the app's own implements, and the whole request
//! for a handler or a middleware that takes it as it came.
//!
//! A value read from the request's head (a visitor's cookie, a header) implements
//! [`FromRequestParts`], and a handler takes it as an argument; one a handler may go without
//! implements [`OptionalFromRequestParts`] too, so it can take `Option<T>`. An extractor that
//! reads the body ([`crate::Form`], [`crate::Upload`]) implements [`FromRequest`]. A refusal
//! (`type Rejection`) is anything that makes a response
//! ([`crate::middleware::IntoResponse`]). Who is asking is a [`crate::Caller`], found by the caller
//! type's [`crate::Identify`], never an extractor written for it. A part of the routes' state is a
//! [`crate::FromRef`] bound:
//!
//! ```
//! use std::convert::Infallible;
//! use corten::{
//!     extract::{FromRequestParts, OptionalFromRequestParts},
//!     http::{StatusCode, request::Parts},
//!     prelude::*,
//!     security::cookie,
//! };
//!
//! #[derive(Clone)]
//! struct Lists;
//!
//! #[derive(Clone, FromRef)]
//! struct Shared {
//!     lists: Lists,
//! }
//!
//! /// The browser's id, from its `visitor` cookie.
//! struct Visitor(String);
//!
//! impl<S: Sync> FromRequestParts<S> for Visitor
//! where
//!     Lists: FromRef<S>,
//! {
//!     type Rejection = StatusCode;
//!
//!     async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, StatusCode> {
//!         let _lists = Lists::from_ref(state);
//!         let id = cookie::get(&parts.headers, "visitor").ok_or(StatusCode::UNAUTHORIZED)?;
//!         Ok(Visitor(id.to_string()))
//!     }
//! }
//!
//! // So a handler may take `Option<Visitor>`: `None` without the cookie.
//! impl<S: Sync> OptionalFromRequestParts<S> for Visitor
//! where
//!     Lists: FromRef<S>,
//! {
//!     type Rejection = Infallible;
//!
//!     async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Option<Self>, Infallible> {
//!         Ok(<Visitor as FromRequestParts<S>>::from_request_parts(parts, state).await.ok())
//!     }
//! }
//!
//! #[corten::routes(state = Shared)]
//! mod url {
//!     #[route("/", get = home)]
//!     pub struct Home;
//!
//!     #[route("/mine", get = mine)]
//!     pub struct Mine;
//! }
//!
//! async fn home(visitor: Option<Visitor>) -> String {
//!     visitor.map_or_else(String::new, |Visitor(id)| id)
//! }
//!
//! async fn mine(Visitor(id): Visitor) -> String {
//!     id
//! }
//! # fn main() { let _ = App::new(url::router(Shared { lists: Lists })); }
//! ```
//!
//! These are the traits of axum, the server library under Corten, named here so an app's code
//! names Corten alone (`docs/design.md#choice-own-extractors`). The traits come from `axum-core`, where
//! axum's own paths would also carry axum's derives of the same names when its `macros` feature is
//! on anywhere in the build.
//!
//! A handler that takes the whole [`Request`] reads its body with [`bytes_up_to`], up to a limit
//! of the route's own, and answers a body over it itself.
//!
//! A body too large to hold (a file `PUT` as `application/octet-stream`, to an object store or a
//! disk) is read as it arrives with [`pieces_up_to`], one piece at a time.

use axum::body::{BodyDataStream, HttpBody};
pub use axum::extract::State;
pub use axum_core::extract::{FromRequest, FromRequestParts, OptionalFromRequestParts, Request};
use bytes::Bytes;
use futures_util::StreamExt;

use crate::{
    answer::Body,
    form::upload::{join, KEPT_AS_IT_CAME, READ_PAST, SMALL_PIECE},
    http::StatusCode,
    Error,
};

/// The whole body, or `None` when it is larger than `max` bytes: for a handler that takes the
/// [`Request`] and reads its body up to a limit of the route's own, answering a body over it (and
/// one that does not parse) itself, as a route that keeps another server's error shape must.
/// `Json`, [`crate::Form`] and [`crate::Bytes`] refuse a body before the handler runs,
/// with the app's limit and Corten's answer. A body over `max` is read past, not kept, up to
/// 64 MiB past it, so a client still sending reads the handler's answer rather than a closed
/// connection, as an upload's is ([`crate::form::File::bytes_up_to`]); past that, or when its
/// length says it is, it is `None` at once and the connection closes after the answer. `Err` is
/// a body that could not be read (the connection broke), a 400 the handler passes on with `?`.
///
#[cfg_attr(feature = "json", doc = "```")]
#[cfg_attr(not(feature = "json"), doc = "```ignore")]
/// use corten::{extract::{bytes_up_to, Request}, http::StatusCode, prelude::*, JsonError, JsonResponse};
///
/// /// The largest configuration this route takes.
/// const MAX_BODY_BYTES: usize = 1024 * 1024;
///
/// /// The shape of the server this route replaces.
/// #[derive(serde::Serialize, ToJson)]
/// struct Said { error: String }
///
/// #[derive(serde::Serialize, ToJson)]
/// struct Replaced { bytes: usize }
///
/// async fn replace(request: Request) -> Result<JsonResponse, JsonError> {
///     let refused = |error: String| Json(Said { error }).with_status(StatusCode::INTERNAL_SERVER_ERROR);
///     let Some(bytes) = bytes_up_to(request.into_body(), MAX_BODY_BYTES).await? else {
///         return Err(refused("Error: length limit exceeded".into()).into());
///     };
///     let Ok(text) = std::str::from_utf8(&bytes) else {
///         return Err(refused("SyntaxError: not UTF-8".into()).into());
///     };
///     Ok(Json(Replaced { bytes: text.len() }).into())
/// }
///
/// #[corten::routes]
/// mod url {
///     #[route("/configuration", put = replace)]
///     pub struct Configuration;
/// }
/// # fn main() { let _ = App::new(url::router()); }
/// ```
pub async fn bytes_up_to(body: Body, max: usize) -> Result<Option<Bytes>, Error> {
    let past = max.saturating_add(READ_PAST);
    if body.size_hint().lower() > past as u64 {
        return Ok(None);
    }
    // As an upload's file is read: a piece of 1 KiB or more is kept as it came, a run of smaller
    // ones is copied into one buffer as they arrive (so a body sent a few bytes at a time holds
    // about its size, not a handle for each), and the pieces are joined once, at the end.
    let mut pieces: Vec<Bytes> = Vec::new();
    let mut small: Vec<u8> = Vec::new();
    let mut len: usize = 0;
    let mut stream = body.into_data_stream();
    while let Some(piece) = stream.next().await {
        let piece = piece.map_err(|e| Error::new(e).with_status(StatusCode::BAD_REQUEST))?;
        len = len.saturating_add(piece.len());
        if len > max {
            drop((pieces, small));
            // Read past, so the client reads the answer; a read that breaks here leaves the same.
            read_past(&mut stream, len, max).await;
            return Ok(None);
        }
        if piece.len() >= SMALL_PIECE {
            if !small.is_empty() {
                pieces.push(Bytes::from(std::mem::take(&mut small)));
            }
            pieces.push(piece);
        } else {
            small.extend_from_slice(&piece);
        }
    }
    Ok(Some(match (pieces.len(), small.is_empty()) {
        (0, _) => Bytes::from(small.into_boxed_slice()),
        // A large body that came in one piece is kept as it came. A small one is copied: the piece
        // can be a slice of a read buffer hundreds of KiB long, which keeping it would hold whole.
        (1, true) if pieces[0].len() >= KEPT_AS_IT_CAME => pieces.swap_remove(0),
        (1, true) => Bytes::copy_from_slice(&pieces[0]),
        _ => join(&pieces, &small, len),
    }))
}

/// A body read as it arrives, one piece at a time, up to `max` bytes: for a body too large to
/// hold (a file `PUT` as `application/octet-stream`), which the handler passes on to a disk or an
/// object store as it comes, so the request holds a piece (hyper hands out up to about 500 KiB),
/// not the body. A body that fits in memory is [`bytes_up_to`]'s, and a file in a form is
/// [`crate::Upload`]'s, whose [`crate::form::File::chunk`] this reads as.
///
/// [`Pieces::chunk`] counts what arrives, whatever the `Content-Length` says, and refuses a body
/// over `max` with a 413 as [`bytes_up_to`] does: what is left is read past, not kept, up to
/// 64 MiB past `max`, so a browser, which sends the whole body before it reads the answer, reads
/// the 413 rather than a closed connection; past that, nothing more is read and the connection is
/// closed after the answer. A body whose length says it is over is refused before a piece is
/// handed out. A body that could not be read (the connection broke) is a 400. Either is an
/// [`Error`] the handler passes on with `?`, after removing what it wrote; under an
/// [`crate::Api`] it is the API's JSON.
///
/// A large body takes time to arrive, and the route's deadline runs until the answer starts, so
/// its route is in an API (or an area) whose `deadline` leaves time to read it. Within that, a
/// client that stops sending holds the request until the deadline: a handler that ends it sooner
/// waits for each piece with a timeout of its own, as below. The handler's future is dropped at
/// the deadline, when the client leaves and at shutdown, so no code after the `await` it was in
/// runs: what it wrote of a body it does not finish is removed by a guard's `Drop` or by work the
/// request's [`crate::Signal`] starts.
///
/// ```
/// use std::time::Duration;
///
/// use corten::{extract::{pieces_up_to, Request}, http::StatusCode, prelude::*, Error};
///
/// /// The largest file this route takes.
/// const MAX_BYTES: usize = 4 << 30;
/// /// How long the client may go without sending.
/// const IDLE: Duration = Duration::from_secs(30);
///
/// async fn store(Params(_to): Params<files::Object>, request: Request) -> Result<StatusCode, Error> {
///     let mut pieces = pieces_up_to(request.into_body(), MAX_BYTES);
///     loop {
///         let next = tokio::time::timeout(IDLE, pieces.chunk()).await;
///         let Ok(next) = next else {
///             // Remove what was written of it here, as on the `?` below.
///             return Err(Error::new("the upload stopped").with_status(StatusCode::REQUEST_TIMEOUT));
///         };
///         let Some(piece) = next? else { break };
///         // Write `piece` to the store here, awaiting it, so the body is read no faster.
///         let _ = piece;
///     }
///     Ok(StatusCode::CREATED)
/// }
///
/// #[corten::routes(api = Files)]
/// mod files {
///     #[route("/files")]
///     pub struct Files;
///
///     #[route("/files/{name}", put = store)]
///     pub struct Object {
///         pub name: String,
///     }
/// }
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// // An hour for an upload, while the rest of the app keeps its 30 seconds.
/// let app = App::new(Routes::new()).api(|routes| files::api(routes).deadline(Duration::from_secs(3600)));
/// let app = app.test();
/// let to = files::Object { name: "photo.jpg".into() };
/// let put = app.call(corten::http::Method::PUT, &to).body("application/octet-stream", vec![7; 1024]);
/// assert_eq!(put.await.status(), StatusCode::CREATED);
/// # }
/// ```
pub fn pieces_up_to(body: Body, max: usize) -> Pieces {
    let said = body.size_hint().lower();
    Pieces { stream: body.into_data_stream(), max, read: 0, end: if said > max as u64 { End::Said(said) } else { End::Open } }
}

/// A body read as it arrives, up to a limit: [`pieces_up_to`].
pub struct Pieces {
    stream: BodyDataStream,
    max: usize,
    /// What has arrived, read past or not.
    read: usize,
    end: End,
}

/// How far a [`Pieces`] has read.
#[derive(Clone, Copy)]
enum End {
    /// Reading.
    Open,
    /// Its length says it is over the limit, by this many bytes in all: not yet read.
    Said(u64),
    /// Over the limit: refused, and read past.
    Over,
    /// The body could not be read.
    Broken,
    /// Read to its end.
    Done,
}

impl Pieces {
    /// The body's next piece as it arrives, `None` at its end; a 413 [`Error`] once it is over
    /// the limit (and at every call after), a 400 once it could not be read.
    pub async fn chunk(&mut self) -> Result<Option<Bytes>, Error> {
        match self.end {
            End::Open => {}
            End::Said(said) => {
                // Refused first, so a read past given up on is not begun again.
                self.end = End::Over;
                if said <= self.max.saturating_add(READ_PAST) as u64 {
                    read_past(&mut self.stream, 0, self.max).await;
                }
                return Err(self.too_large());
            }
            End::Over => return Err(self.too_large()),
            End::Broken => return Err(Error::new("the body could not be read").with_status(StatusCode::BAD_REQUEST)),
            End::Done => return Ok(None),
        }
        match self.stream.next().await {
            None => {
                self.end = End::Done;
                Ok(None)
            }
            Some(Err(error)) => {
                self.end = End::Broken;
                Err(Error::new(error).with_status(StatusCode::BAD_REQUEST))
            }
            Some(Ok(piece)) => {
                self.read = self.read.saturating_add(piece.len());
                if self.read > self.max {
                    self.end = End::Over;
                    read_past(&mut self.stream, self.read, self.max).await;
                    return Err(self.too_large());
                }
                Ok(Some(piece))
            }
        }
    }

    /// What has arrived so far, counted as it came.
    pub fn read(&self) -> usize {
        self.read
    }

    fn too_large(&self) -> Error {
        Error::new(format!("the body is larger than its limit of {} bytes", self.max)).with_status(StatusCode::PAYLOAD_TOO_LARGE)
    }
}

/// Reads the rest of a body over `max`, keeping nothing, until it ends, breaks, or `read` (what
/// arrived of it before) is 64 MiB past `max`, so a client still sending reads the answer.
async fn read_past(stream: &mut BodyDataStream, mut read: usize, max: usize) {
    let past = max.saturating_add(READ_PAST);
    while read <= past {
        match stream.next().await {
            Some(Ok(piece)) => read = read.saturating_add(piece.len()),
            _ => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use futures_util::{stream, StreamExt};

    use super::{bytes_up_to, pieces_up_to, Pieces};
    use crate::{answer::Body, http::StatusCode, middleware::IntoResponse};

    /// A body in pieces, with no length up front, as a chunked request sends it.
    fn streamed(pieces: &[&'static str]) -> Body {
        let pieces: Vec<Result<Bytes, std::io::Error>> = pieces.iter().map(|p| Ok(Bytes::from_static(p.as_bytes()))).collect();
        Body::from_stream(stream::iter(pieces))
    }

    #[tokio::test]
    async fn a_body_up_to_the_limit_is_read_whole() {
        assert_eq!(bytes_up_to(Body::from("12345"), 5).await.unwrap().as_deref(), Some(&b"12345"[..]));
        assert_eq!(bytes_up_to(streamed(&["12", "345"]), 5).await.unwrap().as_deref(), Some(&b"12345"[..]));
        assert_eq!(bytes_up_to(Body::empty(), 0).await.unwrap().as_deref(), Some(&b""[..]));
    }

    #[tokio::test]
    async fn a_body_over_the_limit_is_none_whether_its_length_is_known_or_not() {
        assert_eq!(bytes_up_to(Body::from("123456"), 5).await.unwrap(), None);
        assert_eq!(bytes_up_to(streamed(&["123", "456"]), 5).await.unwrap(), None);
    }

    /// A body over the limit is read past, so the client reads the answer: the pieces after the
    /// one that went over are read too, and none is kept.
    #[tokio::test]
    async fn a_body_over_the_limit_is_read_past() {
        let read = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = read.clone();
        let pieces = stream::iter(["123", "456", "789", "0"]).map(move |p| {
            counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok::<_, std::io::Error>(Bytes::from_static(p.as_bytes()))
        });
        assert_eq!(bytes_up_to(Body::from_stream(pieces), 5).await.unwrap(), None);
        assert_eq!(read.load(std::sync::atomic::Ordering::Relaxed), 4);
    }

    /// Reading past stops 64 MiB past the limit, where the connection is closed after the answer:
    /// of 70 pieces of 1 MiB with nothing allowed, the one that went over and 64 more are read.
    #[tokio::test]
    async fn reading_past_stops_64_mib_past_the_limit() {
        let read = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = read.clone();
        let mib = Bytes::from(vec![0; 1 << 20]);
        let pieces = stream::iter(std::iter::repeat_n(mib, 70)).map(move |p| {
            counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok::<_, std::io::Error>(p)
        });
        assert_eq!(bytes_up_to(Body::from_stream(pieces), 0).await.unwrap(), None);
        assert_eq!(read.load(std::sync::atomic::Ordering::Relaxed), 65);
    }

    /// A body sent a byte at a time comes back whole and in order.
    #[tokio::test]
    async fn a_body_sent_a_byte_at_a_time_is_whole() {
        let text: Vec<Bytes> = (0..3000).map(|n| Bytes::from(vec![b'a' + (n % 26) as u8])).collect();
        let want: Vec<u8> = text.iter().flat_map(|b| b.iter().copied()).collect();
        let body = Body::from_stream(stream::iter(text.into_iter().map(Ok::<_, std::io::Error>)));
        assert_eq!(bytes_up_to(body, 1 << 20).await.unwrap().as_deref(), Some(&want[..]));
        // Small pieces between large ones are kept in order.
        let mixed = ["ab", std::str::from_utf8(&[b'x'; 2048]).unwrap(), "cd"]
            .map(|p| Ok::<_, std::io::Error>(Bytes::copy_from_slice(p.as_bytes())));
        let read = bytes_up_to(Body::from_stream(stream::iter(mixed)), 1 << 20).await.unwrap().unwrap();
        assert_eq!(read.len(), 2052);
        assert!(read.starts_with(b"abx") && read.ends_with(b"xcd"));
    }

    /// A body whose length is known to be over by more than is read past is not read: here,
    /// reading it would fail.
    #[tokio::test]
    async fn a_body_whose_length_is_far_over_is_not_read() {
        let body = Body::new(Sized(Some(Err(std::io::Error::other("read")))));
        assert_eq!(bytes_up_to(body, 5).await.unwrap(), None);
    }

    /// A small body that came in one piece is copied out of the buffer it was cut from; a large one
    /// is kept as it came.
    #[tokio::test]
    async fn a_small_body_is_copied_and_a_large_one_kept() {
        let buffer = Bytes::from(vec![b'x'; 256 << 10]);
        let small = bytes_up_to(Body::from(buffer.slice(..1024)), 1 << 20).await.unwrap().unwrap();
        assert_ne!(small.as_ptr(), buffer.as_ptr());
        let large = bytes_up_to(Body::from(buffer.slice(..128 << 10)), 1 << 20).await.unwrap().unwrap();
        assert_eq!(large.as_ptr(), buffer.as_ptr());
    }

    /// A body that says it holds more than 64 MiB past the limit, and fails if it is read.
    struct Sized(Option<Result<http_body::Frame<Bytes>, std::io::Error>>);

    impl http_body::Body for Sized {
        type Data = Bytes;
        type Error = std::io::Error;

        fn poll_frame(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<Bytes>, std::io::Error>>> {
            std::task::Poll::Ready(self.0.take())
        }

        fn size_hint(&self) -> http_body::SizeHint {
            http_body::SizeHint::with_exact(5 + super::READ_PAST as u64 + 1)
        }
    }

    /// What reading a body costs, against axum's `to_bytes` that apps called before: `BODY_READS`
    /// (200) reads of an 8 KiB body in one piece and of one in 1 KiB pieces, by `READER` (`ours`
    /// or `axum`). Counted under callgrind at two numbers of reads, the difference over 1,000 is the
    /// cost of 1,000 of each.
    #[test]
    #[ignore]
    fn what_reading_a_body_costs() {
        let reads: usize = std::env::var("BODY_READS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
        let ours = std::env::var("READER").map_or(true, |r| r != "axum");
        let whole = Bytes::from(vec![b'x'; 8 * 1024]);
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        runtime.block_on(async {
            for _ in 0..reads {
                for body in [Body::from(whole.clone()), {
                    let pieces: Vec<Result<Bytes, std::io::Error>> =
                        (0..8).map(|n| Ok(whole.slice(n * 1024..(n + 1) * 1024))).collect();
                    Body::from_stream(stream::iter(pieces))
                }] {
                    let read = if ours {
                        bytes_up_to(body, 1 << 20).await.unwrap().unwrap()
                    } else {
                        axum::body::to_bytes(body, 1 << 20).await.unwrap()
                    };
                    assert_eq!(std::hint::black_box(read).len(), 8 * 1024);
                }
            }
        });
    }

    #[tokio::test]
    async fn a_body_that_cannot_be_read_is_a_400() {
        let broken: Vec<Result<Bytes, std::io::Error>> =
            vec![Ok(Bytes::from_static(b"12")), Err(std::io::Error::other("the connection broke"))];
        let e = bytes_up_to(Body::from_stream(stream::iter(broken)), 5).await.unwrap_err();
        assert_eq!(e.into_response().status(), StatusCode::BAD_REQUEST);
    }

    /// Every piece `chunk` hands out until the end, or the status it failed with.
    async fn all(pieces: &mut Pieces) -> Result<Vec<u8>, StatusCode> {
        let mut got = Vec::new();
        loop {
            match pieces.chunk().await {
                Ok(Some(piece)) => got.extend_from_slice(&piece),
                Ok(None) => return Ok(got),
                Err(e) => return Err(e.into_response().status()),
            }
        }
    }

    /// Pieces are handed out as they came, up to and at the limit, whether the length is known or
    /// not; an empty body is no piece at all.
    #[tokio::test]
    async fn a_body_up_to_the_limit_is_handed_out_piece_by_piece() {
        let mut pieces = pieces_up_to(streamed(&["12", "3", "45"]), 5);
        for want in ["12", "3", "45"] {
            assert_eq!(pieces.chunk().await.unwrap().as_deref(), Some(want.as_bytes()));
        }
        assert_eq!(pieces.chunk().await.unwrap(), None);
        assert_eq!(pieces.chunk().await.unwrap(), None, "and at every call after the end");
        assert_eq!(pieces.read(), 5);
        assert_eq!(all(&mut pieces_up_to(Body::from("12345"), 5)).await.as_deref(), Ok(&b"12345"[..]));
        assert_eq!(all(&mut pieces_up_to(Body::empty(), 0)).await.as_deref(), Ok(&b""[..]));
        let bytes = (0..3000).map(|n| Ok::<_, std::io::Error>(Bytes::from(vec![b'a' + (n % 26) as u8])));
        let want: Vec<u8> = (0..3000).map(|n| b'a' + (n % 26) as u8).collect();
        assert_eq!(all(&mut pieces_up_to(Body::from_stream(stream::iter(bytes)), 3000)).await, Ok(want), "a byte at a time");
    }

    /// Over the limit is a 413 at the piece that went over (none of it handed out) and at every
    /// call after; the pieces before it were handed out, so the handler removes what it wrote.
    #[tokio::test]
    async fn a_body_over_the_limit_is_a_413_at_the_piece_that_goes_over() {
        let mut pieces = pieces_up_to(streamed(&["123", "456", "7"]), 5);
        assert_eq!(pieces.chunk().await.unwrap().as_deref(), Some(&b"123"[..]));
        assert_eq!(pieces.chunk().await.unwrap_err().into_response().status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(pieces.chunk().await.unwrap_err().into_response().status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(pieces.read(), 6, "what was read past is not counted as arrived before the refusal");
    }

    /// A body whose length says it is over is refused before a piece is handed out, and read past
    /// so the client reads the answer.
    #[tokio::test]
    async fn a_body_whose_length_is_over_hands_out_nothing() {
        assert_eq!(all(&mut pieces_up_to(Body::from("123456"), 5)).await, Err(StatusCode::PAYLOAD_TOO_LARGE));
        // Far over (more than 64 MiB past): not read at all; here, reading it would fail.
        let body = Body::new(Sized(Some(Err(std::io::Error::other("read")))));
        assert_eq!(all(&mut pieces_up_to(body, 5)).await, Err(StatusCode::PAYLOAD_TOO_LARGE));
    }

    /// Reading past stops 64 MiB past the limit, as `bytes_up_to`'s does: of 70 pieces of 1 MiB with
    /// nothing allowed, the one that went over and 64 more are read.
    #[tokio::test]
    async fn pieces_are_read_past_no_further_than_64_mib() {
        let read = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = read.clone();
        let mib = Bytes::from(vec![0; 1 << 20]);
        let body = stream::iter(std::iter::repeat_n(mib, 70)).map(move |p| {
            counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok::<_, std::io::Error>(p)
        });
        assert_eq!(all(&mut pieces_up_to(Body::from_stream(body), 0)).await, Err(StatusCode::PAYLOAD_TOO_LARGE));
        assert_eq!(read.load(std::sync::atomic::Ordering::Relaxed), 65);
    }

    /// A read past given up on (the handler's timeout around `chunk`) is not begun again: the next
    /// call is the 413 at once.
    #[tokio::test]
    async fn a_read_past_given_up_on_is_not_begun_again() {
        let first: Vec<Result<Bytes, std::io::Error>> = vec![Ok(Bytes::from_static(b"123456"))];
        let body = Body::from_stream(stream::iter(first).chain(stream::pending()));
        let mut pieces = pieces_up_to(body, 5);
        let given_up = tokio::time::timeout(std::time::Duration::from_millis(20), pieces.chunk()).await;
        assert!(given_up.is_err(), "the read past waits on the rest of the body");
        let again = tokio::time::timeout(std::time::Duration::from_secs(5), pieces.chunk()).await;
        assert_eq!(again.unwrap().unwrap_err().into_response().status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// A body that breaks is a 400, distinct from one over its limit, at every call after too.
    #[tokio::test]
    async fn a_body_that_breaks_is_a_400() {
        let broken: Vec<Result<Bytes, std::io::Error>> =
            vec![Ok(Bytes::from_static(b"12")), Err(std::io::Error::other("the connection broke"))];
        let mut pieces = pieces_up_to(Body::from_stream(stream::iter(broken)), 5);
        assert_eq!(pieces.chunk().await.unwrap().as_deref(), Some(&b"12"[..]));
        assert_eq!(pieces.chunk().await.unwrap_err().into_response().status(), StatusCode::BAD_REQUEST);
        assert_eq!(pieces.chunk().await.unwrap_err().into_response().status(), StatusCode::BAD_REQUEST);
    }
}
