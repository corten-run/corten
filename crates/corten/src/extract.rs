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

use axum::body::HttpBody;
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
            while len <= past {
                match stream.next().await {
                    Some(Ok(piece)) => len = len.saturating_add(piece.len()),
                    _ => break,
                }
            }
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

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use futures_util::{stream, StreamExt};

    use super::bytes_up_to;
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
}
