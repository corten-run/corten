//! What a handler or a middleware answers: a [`Response`], and [`IntoResponse`] for anything
//! that makes one. The names and shapes are the ones an answer was written against when they were
//! axum-core's (`docs/design.md#choice-axum-router`), so an app's own answers compile as they were.

use std::{borrow::Cow, convert::Infallible};

use bytes::{Bytes, BytesMut};
use http::{
    header::{self, HeaderMap, HeaderName, HeaderValue},
    Extensions, StatusCode,
};

use crate::body::{Body, BoxError};

/// A response as a middleware or a handler answers it: the `http` crate's, over Corten's [`Body`].
pub type Response<B = Body> = http::Response<B>;

// Every stage moves a response; past 128 bytes each move is a call to `memcpy` rather than inline
// stores, which cost an API request 384 instructions when the body was four words (design
// Choice 25, step 4).
const _: () = assert!(std::mem::size_of::<Response>() <= 128, "a Response<Body> past 128 bytes is copied by a call each move");

/// A value that answers a request: text (`text/plain`), bytes (`application/octet-stream`), a
/// `StatusCode`, a [`Response`], a refusal, and a tuple of a status and headers before any of them
/// (`(StatusCode::CREATED, [(header::LOCATION, url)], "made")`).
pub trait IntoResponse {
    /// The response.
    fn into_response(self) -> Response;
}

/// A part of a response set on one another value makes, in a tuple before it: headers
/// (`[(name, value)]`, a `HeaderMap`) or extensions.
pub trait IntoResponseParts {
    /// What answers instead when the part cannot be set (a header value that is not one).
    type Error: IntoResponse;

    /// `res` with this part set.
    fn into_response_parts(self, res: ResponseParts) -> Result<ResponseParts, Self::Error>;
}

/// The response a part is set on ([`IntoResponseParts`]): its headers and extensions.
#[derive(Debug)]
pub struct ResponseParts {
    res: Response,
}

impl ResponseParts {
    /// The headers set so far.
    pub fn headers(&self) -> &HeaderMap {
        self.res.headers()
    }

    /// The headers, to set one.
    pub fn headers_mut(&mut self) -> &mut HeaderMap {
        self.res.headers_mut()
    }

    /// The extensions set so far.
    pub fn extensions(&self) -> &Extensions {
        self.res.extensions()
    }

    /// The extensions, to set one.
    pub fn extensions_mut(&mut self) -> &mut Extensions {
        self.res.extensions_mut()
    }
}

/// A response over any body: a [`Response`] as it is, one over another body boxed once.
impl<B> IntoResponse for http::Response<B>
where
    B: http_body::Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    #[inline]
    fn into_response(self) -> Response {
        self.map(Body::new)
    }
}

impl IntoResponse for http::response::Parts {
    fn into_response(self) -> Response {
        Response::from_parts(self, Body::empty())
    }
}

impl IntoResponse for Body {
    #[inline]
    fn into_response(self) -> Response {
        Response::new(self)
    }
}

impl IntoResponse for () {
    #[inline]
    fn into_response(self) -> Response {
        Response::new(Body::empty())
    }
}

impl IntoResponse for Infallible {
    fn into_response(self) -> Response {
        match self {}
    }
}

impl IntoResponse for StatusCode {
    #[inline]
    fn into_response(self) -> Response {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = self;
        res
    }
}

impl<T: IntoResponse, E: IntoResponse> IntoResponse for Result<T, E> {
    #[inline]
    fn into_response(self) -> Response {
        match self {
            Ok(value) => value.into_response(),
            Err(error) => error.into_response(),
        }
    }
}

/// `body` as a response with `content_type`.
#[inline]
fn typed(body: Body, content_type: &'static str) -> Response {
    let mut res = Response::new(body);
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    res
}

const TEXT: &str = "text/plain; charset=utf-8";
const OCTETS: &str = "application/octet-stream";

macro_rules! bodies {
    ($content_type:expr => $($ty:ty),*) => {$(
        impl IntoResponse for $ty {
            #[inline]
            fn into_response(self) -> Response {
                typed(Body::from(self), $content_type)
            }
        }
    )*};
}
bodies!(TEXT => &'static str, String, Box<str>, Cow<'static, str>);
bodies!(OCTETS => Bytes, Vec<u8>, &'static [u8], Box<[u8]>, Cow<'static, [u8]>);

impl IntoResponse for BytesMut {
    fn into_response(self) -> Response {
        self.freeze().into_response()
    }
}

impl<const N: usize> IntoResponse for [u8; N] {
    fn into_response(self) -> Response {
        self.to_vec().into_response()
    }
}

impl<const N: usize> IntoResponse for &'static [u8; N] {
    fn into_response(self) -> Response {
        self.as_slice().into_response()
    }
}

impl IntoResponse for HeaderMap {
    fn into_response(self) -> Response {
        let mut res = Response::new(Body::empty());
        *res.headers_mut() = self;
        res
    }
}

impl IntoResponse for Extensions {
    fn into_response(self) -> Response {
        let mut res = Response::new(Body::empty());
        *res.extensions_mut() = self;
        res
    }
}

impl<K, V, const N: usize> IntoResponse for [(K, V); N]
where
    K: TryInto<HeaderName>,
    K::Error: std::fmt::Display,
    V: TryInto<HeaderValue>,
    V::Error: std::fmt::Display,
{
    fn into_response(self) -> Response {
        (self, ()).into_response()
    }
}

impl<R: IntoResponse> IntoResponse for (StatusCode, R) {
    #[inline]
    fn into_response(self) -> Response {
        let mut res = self.1.into_response();
        *res.status_mut() = self.0;
        res
    }
}

/// Each header replaces one of the same name set before it.
impl IntoResponseParts for HeaderMap {
    type Error = Infallible;

    fn into_response_parts(self, mut res: ResponseParts) -> Result<ResponseParts, Infallible> {
        res.headers_mut().extend(self);
        Ok(res)
    }
}

impl IntoResponseParts for Extensions {
    type Error = Infallible;

    fn into_response_parts(self, mut res: ResponseParts) -> Result<ResponseParts, Infallible> {
        res.extensions_mut().extend(self);
        Ok(res)
    }
}

/// Each header replaces one of the same name set before it; a name or a value that is not one is
/// a `500` saying which.
impl<K, V, const N: usize> IntoResponseParts for [(K, V); N]
where
    K: TryInto<HeaderName>,
    K::Error: std::fmt::Display,
    V: TryInto<HeaderValue>,
    V::Error: std::fmt::Display,
{
    type Error = Response;

    fn into_response_parts(self, mut res: ResponseParts) -> Result<ResponseParts, Response> {
        for (name, value) in self {
            let name = name.try_into().map_err(|e| invalid_header(e.to_string()))?;
            let value = value.try_into().map_err(|e| invalid_header(e.to_string()))?;
            res.headers_mut().insert(name, value);
        }
        Ok(res)
    }
}

#[cold]
fn invalid_header(error: String) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, error).into_response()
}

impl<T: IntoResponseParts> IntoResponseParts for Option<T> {
    type Error = T::Error;

    fn into_response_parts(self, res: ResponseParts) -> Result<ResponseParts, T::Error> {
        match self {
            Some(part) => part.into_response_parts(res),
            None => Ok(res),
        }
    }
}

macro_rules! tuples {
    ($($ty:ident),+) => {
        #[allow(non_snake_case)]
        impl<R: IntoResponse, $($ty: IntoResponseParts,)+> IntoResponse for ($($ty,)+ R) {
            fn into_response(self) -> Response {
                let ($($ty,)+ body) = self;
                let parts = ResponseParts { res: body.into_response() };
                $(
                    let parts = match $ty.into_response_parts(parts) {
                        Ok(parts) => parts,
                        Err(error) => return error.into_response(),
                    };
                )+
                parts.res
            }
        }

        #[allow(non_snake_case)]
        impl<R: IntoResponse, $($ty: IntoResponseParts,)+> IntoResponse for (StatusCode, $($ty,)+ R) {
            fn into_response(self) -> Response {
                let (status, $($ty,)+ body) = self;
                let parts = ResponseParts { res: body.into_response() };
                $(
                    let parts = match $ty.into_response_parts(parts) {
                        Ok(parts) => parts,
                        // A part's own refusal keeps its status: a header that is not one is a
                        // `500`, not the status the handler meant for a good answer.
                        Err(error) => return error.into_response(),
                    };
                )+
                let mut res = parts.res;
                *res.status_mut() = status;
                res
            }
        }
    };
}
tuples!(T1);
tuples!(T1, T2);
tuples!(T1, T2, T3);
tuples!(T1, T2, T3, T4);
tuples!(T1, T2, T3, T4, T5);
tuples!(T1, T2, T3, T4, T5, T6);
tuples!(T1, T2, T3, T4, T5, T6, T7);
tuples!(T1, T2, T3, T4, T5, T6, T7, T8);

#[cfg(test)]
mod tests {
    use super::*;
    use http::header::LOCATION;

    #[test]
    fn a_status_with_parts_sets_the_status_and_the_headers() {
        let res = (StatusCode::CREATED, [("x-made", "1")], "made").into_response();
        assert_eq!(res.status(), StatusCode::CREATED);
        assert_eq!(res.headers()["x-made"], "1");
    }

    #[test]
    fn a_part_that_is_not_a_header_is_a_500_whatever_status_was_asked() {
        let res = (StatusCode::FOUND, [(LOCATION, "/a\nb")], "").into_response();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(res.headers().get(LOCATION).is_none());
        let res = (StatusCode::OK, [("bad name", "1")], "body").into_response();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
