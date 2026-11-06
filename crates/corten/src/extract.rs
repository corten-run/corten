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
//! names Corten alone (`docs/design.md`, Choice 21). The traits come from `axum-core`, where
//! axum's own paths would also carry axum's derives of the same names when its `macros` feature is
//! on anywhere in the build.
//!
//! A handler that takes the whole [`Request`] reads its body with [`bytes_up_to`], up to a limit
//! of the route's own, and answers a body over it itself.

use axum::body::HttpBody;
pub use axum::extract::State;
pub use axum_core::extract::{FromRequest, FromRequestParts, OptionalFromRequestParts, Request};
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;

use crate::{answer::Body, http::StatusCode, Error};

/// The whole body, or `None` when it is larger than `max` bytes: for a handler that takes the
/// [`Request`] and reads its body up to a limit of the route's own, answering a body over it (and
/// one that does not parse) itself, as a route that keeps another server's error shape must.
/// [`crate::Json`], [`crate::Form`] and [`crate::Bytes`] refuse a body before the handler runs,
/// with the app's limit and Corten's answer. A body whose length says it is over is `None`
/// before any of it is read. `Err` is a body that could not be read (the connection broke), a
/// 400 the handler passes on with `?`. A file in an upload is read the same way, with
/// [`crate::form::File::bytes_up_to`].
///
/// ```
/// use corten::{extract::{bytes_up_to, Request}, http::StatusCode, prelude::*, JsonError, JsonResponse};
///
/// /// The largest configuration this route takes.
/// const MAX_BODY_BYTES: usize = 1024 * 1024;
///
/// /// The shape of the server this route replaces.
/// #[derive(serde::Serialize, ToJson)]
/// struct Said { error: String }
///
/// async fn replace(request: Request) -> Result<JsonResponse, JsonError> {
///     let refused = |error: String| Json(Said { error }).with_status(StatusCode::INTERNAL_SERVER_ERROR);
///     let Some(bytes) = bytes_up_to(request.into_body(), MAX_BODY_BYTES).await? else {
///         return Err(refused("Error: length limit exceeded".into()).into());
///     };
///     let Ok(text) = std::str::from_utf8(&bytes) else {
///         return Err(refused("SyntaxError: not UTF-8".into()).into());
///     };
///     Ok(Json(Said { error: format!("{} bytes, none refused", text.len()) }).into())
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
    if body.size_hint().lower() > max as u64 {
        return Ok(None);
    }
    // The pieces are kept as they came and joined once at the end, so a body that came in one
    // piece (most) is not copied.
    let mut pieces: Vec<Bytes> = Vec::new();
    let mut len = 0;
    let mut stream = body.into_data_stream();
    while let Some(piece) = stream.next().await {
        let piece = piece.map_err(|e| Error::new(e).with_status(StatusCode::BAD_REQUEST))?;
        len += piece.len();
        if len > max {
            return Ok(None);
        }
        pieces.push(piece);
    }
    Ok(Some(match pieces.len() {
        0 => Bytes::new(),
        1 => pieces.pop().unwrap_or_default(),
        _ => {
            let mut whole = BytesMut::with_capacity(len);
            pieces.iter().for_each(|piece| whole.extend_from_slice(piece));
            whole.freeze()
        }
    }))
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use futures_util::stream;

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

    /// A body whose length is known to be over is not read: here, reading it would fail.
    #[tokio::test]
    async fn a_body_whose_length_is_over_is_not_read() {
        let body = Body::new(Sized(Some(Err(std::io::Error::other("read")))));
        assert_eq!(bytes_up_to(body, 5).await.unwrap(), None);
    }

    /// A body that says it holds 6 bytes, and fails if it is read.
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
            http_body::SizeHint::with_exact(6)
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
