//! The HTTP vocabulary every layer above the connection names ([design Choice 25](https://github.com/corten-run/corten/blob/main/docs/design.md#choice-axum-router), part 3):
//! the `http` crate's types (`StatusCode`, `HeaderMap`, `HeaderValue`, `Method`, `Uri`,
//! `request::Parts`), which hyper, tower and HTTP clients share, so an app names the same types
//! its HTTP client does; and the body, request and response Corten builds on them.
//!
//! [`Request`] and [`Response`] are the `http` crate's, over Corten's [`Body`] unless given
//! another; a handler or a middleware answers with anything that is [`IntoResponse`], a raw
//! `Response` included, and a header or cookie an answer adds is [`IntoResponseParts`]. [`Bytes`]
//! is a body's bytes, shared rather than copied: what a whole-body reader gives and
//! [`crate::Media::new`] takes.
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
//! This is the one place they are named; the modules that use them do not name them again:
//!
//! ```compile_fail,E0432
//! use corten::{answer::Body, extract::Request, middleware::Response};
//! ```

#[doc(no_inline)]
pub use ::http::*;
pub use bytes::Bytes;

pub use crate::body::{Body, BodyDataStream};
pub use crate::handler::Request;
pub use crate::response::{IntoResponse, IntoResponseParts, Response, ResponseParts};
