//! The HTTP vocabulary every layer above the connection names ([design Choice 25](https://github.com/corten-run/corten/blob/main/docs/design.md#choice-axum-router), part 3):
//! the `http` crate's types (`StatusCode`, `HeaderMap`, `HeaderValue`, `Method`, `Uri`,
//! `request::Parts`), which hyper, tower and HTTP clients share, so an app names the same types
//! its HTTP client does; and the body, request and response Corten builds on them.
//!
//! [`Request`] and [`Response`] are the `http` crate's, over Corten's [`Body`] unless given
//! another. A handler answers with anything that is [`IntoResponse`], a raw `Response` included,
//! and a header or cookie an answer adds is [`IntoResponseParts`], which writes into
//! [`ResponseParts`]; a middleware answers with a `Response`. [`Bytes`] is a body's bytes,
//! shared rather than copied: what a whole-body reader gives and [`crate::Media::new`] takes.
//! [`BodyDataStream`] is a body read as a stream of those pieces.
//!
//! ```
//! use corten::http::{header, Body, IntoResponse, Response, StatusCode};
//!
//! fn teapot() -> Response {
//!     (StatusCode::IM_A_TEAPOT, [(header::CONTENT_TYPE, "text/plain")], Body::from("short and stout")).into_response()
//! }
//! # let _ = teapot();
//! ```
//!
//! Import the names a file uses: `use corten::http::*` also brings in the `http` crate's
//! `Result`, which hides the standard one.

#[doc(no_inline)]
pub use ::http::*;
pub use bytes::Bytes;

pub use crate::body::{Body, BodyDataStream};
pub use crate::handler::Request;
pub use crate::response::{IntoResponse, IntoResponseParts, Response, ResponseParts};

/// This module is the one place these types are named: the paths each had before it are gone,
/// one test each.
///
/// ```compile_fail,E0432
/// use corten::answer::Body;
/// ```
///
/// ```compile_fail,E0432
/// use corten::answer::BodyDataStream;
/// ```
///
/// ```compile_fail,E0432
/// use corten::extract::Request;
/// ```
///
/// ```compile_fail,E0432
/// use corten::middleware::Response;
/// ```
///
/// ```compile_fail,E0432
/// use corten::middleware::IntoResponse;
/// ```
///
/// ```compile_fail,E0432
/// use corten::middleware::IntoResponseParts;
/// ```
///
/// ```compile_fail,E0432
/// use corten::middleware::ResponseParts;
/// ```
///
/// ```compile_fail,E0432
/// use corten::Bytes;
/// ```
#[cfg(doctest)]
pub struct OldPaths;
