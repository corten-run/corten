//! What a handler or a middleware answers: a [`Response`], and [`IntoResponse`] for anything
//! that makes one. The names and shapes are the ones an answer was written against when they were
//! axum-core's (`docs/design.md#choice-axum-router`), so an app's own answers compile as they were.

use std::{borrow::Cow, convert::Infallible};

use bytes::{Bytes, BytesMut};
use http::{
    header::{self, HeaderMap, HeaderName, HeaderValue},
    Extensions, StatusCode,
};

use crate::answer::sealed::MayShare;
use crate::body::{Body, BoxError};

/// A response as a middleware or a handler answers it: the `http` crate's, over Corten's [`Body`].
pub type Response<B = Body> = http::Response<B>;

// Every stage moves a response; past 128 bytes each move is a call to `memcpy` rather than inline
// stores, which cost an API request 384 instructions when the body was four words
// (`docs/design.md#choice-axum-router`, step 4).
const _: () = assert!(std::mem::size_of::<Response>() <= 128, "a Response<Body> past 128 bytes is copied by a call each move");

/// A value that answers a request: text (`text/plain`), bytes (`application/octet-stream`), a
/// `StatusCode`, a [`Response`], a refusal, and a tuple of a status and headers before any of them
/// (`(StatusCode::CREATED, [(header::LOCATION, url)], "made")`).
///
/// An answer can be erased behind a box, as `dyn IntoResponse` or a trait of the app's own over
/// this one, which answers through a method that takes the box. Corten does not see what such a
/// box holds, so the handler of a route that answers one is watched for a form's new submit key,
/// as that of any answer type of the app's own is:
///
/// ```
/// use corten::http::{IntoResponse, Response};
///
/// trait Boxed: IntoResponse + Send {
///     fn respond(self: Box<Self>) -> Response;
/// }
///
/// impl<T: IntoResponse + Send> Boxed for T {
///     fn respond(self: Box<Self>) -> Response {
///         (*self).into_response()
///     }
/// }
///
/// let erased: Box<dyn IntoResponse + Send> = Box::new("made");
/// let boxed: Box<dyn Boxed> = Box::new("made");
/// assert_eq!(boxed.respond().status(), 200);
/// # drop(erased);
/// ```
pub trait IntoResponse {
    /// Whether the response may say that a shared cache keeps it for everyone in a way the type
    /// does not show: [`crate::Public`] says so, a type of Corten's that is never `Public` does
    /// not, and one that holds another (`Result`, [`crate::NoStore`], a tuple of parts before it)
    /// says what that one does, and a tuple what each part's refusal does too, since a refusal is
    /// the whole answer. A page's and a JSON answer's ([`crate::HtmlResponse`],
    /// `JsonResponse`) say so too, and with them what holds one (`HtmlResult`, `PageOr`,
    /// `JsonError`): their `DerefMut` lets a handler put any response in their place, a `Public`
    /// one it converted among them. A type of the app's own always does, since Corten cannot see what its
    /// `into_response` makes (a `Public` answer on one branch): its route's handler is watched
    /// for a form's new submit key, as a `Public` one's is, and an answer whose handler drew one is
    /// sent to no shared cache. A raw `Response`, a `[(name, value)]` of headers and a
    /// [`crate::Relay`] say no: what caching their headers say is the app's or the upstream's, and
    /// the stages settle it as any answer's ([`crate::cache`]). Not a public API: its type is one
    /// an app cannot name, so an app's own type cannot say no, nor say what one of Corten's does.
    ///
    /// A function of the type, not a constant: an associated constant would make the trait one no
    /// `dyn IntoResponse` can be made of, and `Self: Sized` leaves this out of a trait object.
    /// Each body is a literal or the bodies of the types it holds, so a release build folds it
    /// where it is read, and a route whose answer says no has no watch.
    ///
    /// ```compile_fail,E0053
    /// use corten::http::{IntoResponse, Response};
    ///
    /// struct Mine;
    ///
    /// impl IntoResponse for Mine {
    ///     fn may_share() -> bool {
    ///         false
    ///     }
    ///
    ///     fn into_response(self) -> Response {
    ///         "mine".into_response()
    ///     }
    /// }
    /// ```
    ///
    /// ```compile_fail,E0053
    /// use corten::http::{IntoResponse, Response};
    ///
    /// struct Mine;
    ///
    /// impl IntoResponse for Mine {
    ///     fn may_share() -> impl Sized {
    ///         <&'static str as IntoResponse>::may_share()
    ///     }
    ///
    ///     fn into_response(self) -> Response {
    ///         "mine".into_response()
    ///     }
    /// }
    /// ```
    ///
    /// ```compile_fail,E0603
    /// use corten::http::{IntoResponse, Response};
    ///
    /// struct Mine;
    ///
    /// impl IntoResponse for Mine {
    ///     fn may_share() -> corten::answer::sealed::MayShare {
    ///         <&'static str as IntoResponse>::may_share()
    ///     }
    ///
    ///     fn into_response(self) -> Response {
    ///         "mine".into_response()
    ///     }
    /// }
    /// ```
    #[doc(hidden)]
    #[inline]
    fn may_share() -> MayShare
    where
        Self: Sized,
    {
        MayShare(true)
    }

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
    fn may_share() -> MayShare {
        MayShare::NO
    }

    #[inline]
    fn into_response(self) -> Response {
        self.map(Body::new)
    }
}

impl IntoResponse for http::response::Parts {
    #[inline]
    fn may_share() -> MayShare {
        MayShare::NO
    }

    fn into_response(self) -> Response {
        Response::from_parts(self, Body::empty())
    }
}

impl IntoResponse for Body {
    #[inline]
    fn may_share() -> MayShare {
        MayShare::NO
    }

    #[inline]
    fn into_response(self) -> Response {
        Response::new(self)
    }
}

impl IntoResponse for () {
    #[inline]
    fn may_share() -> MayShare {
        MayShare::NO
    }

    #[inline]
    fn into_response(self) -> Response {
        Response::new(Body::empty())
    }
}

impl IntoResponse for Infallible {
    #[inline]
    fn may_share() -> MayShare {
        MayShare::NO
    }

    fn into_response(self) -> Response {
        match self {}
    }
}

impl IntoResponse for StatusCode {
    #[inline]
    fn may_share() -> MayShare {
        MayShare::NO
    }

    #[inline]
    fn into_response(self) -> Response {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = self;
        res
    }
}

impl<T: IntoResponse, E: IntoResponse> IntoResponse for Result<T, E> {
    #[inline]
    fn may_share() -> MayShare {
        MayShare::either(T::may_share(), E::may_share())
    }

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
    let headers = res.headers_mut();
    // Room for the headers `App` adds too, so the map is allocated once, as a page's and JSON's
    // are: a map made by its first header holds six, and grew when the security headers came.
    headers.reserve(APP_HEADERS);
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    res
}

/// The room a text, bytes or JSON answer's header map starts with: what an answer leaves the app
/// with under the default policy with HSTS, which is its own `Content-Type`, the security headers
/// (seven for an SVG), `Cache-Control`, its `ETag`, `Vary` and, compressed, `Content-Encoding`.
/// It is not a limit. A header on top of those (the handler's own, `Reporting-Endpoints`, an API's
/// `Access-Control-Allow-Origin`) grows the map once, as the security headers grew every such
/// answer's before.
pub(crate) const APP_HEADERS: usize = 12;

const TEXT: &str = "text/plain; charset=utf-8";
const OCTETS: &str = "application/octet-stream";

macro_rules! bodies {
    ($content_type:expr => $($ty:ty),*) => {$(
        impl IntoResponse for $ty {
            #[inline]
            fn may_share() -> MayShare {
                MayShare::NO
            }

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
    #[inline]
    fn may_share() -> MayShare {
        MayShare::NO
    }

    fn into_response(self) -> Response {
        self.freeze().into_response()
    }
}

impl<const N: usize> IntoResponse for [u8; N] {
    #[inline]
    fn may_share() -> MayShare {
        MayShare::NO
    }

    fn into_response(self) -> Response {
        self.to_vec().into_response()
    }
}

impl<const N: usize> IntoResponse for &'static [u8; N] {
    #[inline]
    fn may_share() -> MayShare {
        MayShare::NO
    }

    fn into_response(self) -> Response {
        self.as_slice().into_response()
    }
}

impl IntoResponse for HeaderMap {
    #[inline]
    fn may_share() -> MayShare {
        MayShare::NO
    }

    fn into_response(self) -> Response {
        let mut res = Response::new(Body::empty());
        *res.headers_mut() = self;
        res
    }
}

impl IntoResponse for Extensions {
    #[inline]
    fn may_share() -> MayShare {
        MayShare::NO
    }

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
    #[inline]
    fn may_share() -> MayShare {
        MayShare::NO
    }

    fn into_response(self) -> Response {
        (self, ()).into_response()
    }
}

impl<R: IntoResponse> IntoResponse for (StatusCode, R) {
    #[inline]
    fn may_share() -> MayShare {
        R::may_share()
    }

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
            let name = name.try_into().map_err(|e| invalid_header(res.extensions(), e.to_string()))?;
            let value = value.try_into().map_err(|e| invalid_header(res.extensions(), e.to_string()))?;
            res.headers_mut().insert(name, value);
        }
        Ok(res)
    }
}

/// The `500` in place of the answer whose extensions are `answer`, given a header that is not one:
/// Corten's failure, not the answer the handler meant, and `NoStore` where that answer was
/// ([`crate::cache::unshared_in_place_of`]).
#[cold]
fn invalid_header(answer: &Extensions, error: String) -> Response {
    crate::cache::unshared_in_place_of(answer, (StatusCode::INTERNAL_SERVER_ERROR, error).into_response())
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

/// Sets each part on the answer in turn. Once one fails, its refusal answers instead, and each part
/// after it is still read for the policy it would have set: a [`crate::cache::Cache::no_store`]
/// after a header that is not one keeps the refusal `NoStore` ([`after_a_failed_part`]), as one
/// before it does, so the guarantee does not depend on the order of the parts.
macro_rules! tuples {
    ($($ty:ident),+) => {
        #[allow(non_snake_case)]
        impl<R: IntoResponse, $($ty: IntoResponseParts,)+> IntoResponse for ($($ty,)+ R) {
            // A part's refusal answers in the body's place.
            #[inline]
            fn may_share() -> MayShare {
                let may = R::may_share();
                $(let may = MayShare::either(may, <$ty::Error as IntoResponse>::may_share());)+
                may
            }

            fn into_response(self) -> Response {
                let ($($ty,)+ body) = self;
                let parts: Result<ResponseParts, Response> = Ok(ResponseParts { res: body.into_response() });
                $(
                    let parts = match parts {
                        Ok(parts) => $ty.into_response_parts(parts).map_err(IntoResponse::into_response),
                        Err(failed) => Err(after_a_failed_part($ty, failed)),
                    };
                )+
                match parts {
                    Ok(parts) => parts.res,
                    Err(failed) => failed,
                }
            }
        }

        #[allow(non_snake_case)]
        impl<R: IntoResponse, $($ty: IntoResponseParts,)+> IntoResponse for (StatusCode, $($ty,)+ R) {
            #[inline]
            fn may_share() -> MayShare {
                <($($ty,)+ R) as IntoResponse>::may_share()
            }

            fn into_response(self) -> Response {
                let (status, $($ty,)+ body) = self;
                let parts: Result<ResponseParts, Response> = Ok(ResponseParts { res: body.into_response() });
                $(
                    let parts = match parts {
                        Ok(parts) => $ty.into_response_parts(parts).map_err(IntoResponse::into_response),
                        Err(failed) => Err(after_a_failed_part($ty, failed)),
                    };
                )+
                match parts {
                    Ok(parts) => {
                        let mut res = parts.res;
                        *res.status_mut() = status;
                        res
                    }
                    // A part's own refusal keeps its status: a header that is not one is a
                    // `500`, not the status the handler meant for a good answer.
                    Err(failed) => failed,
                }
            }
        }
    };
}

/// `failed`, the refusal of a part before `part` in a tuple, with the `NoStore` policy `part`
/// would have set on the answer ([`crate::cache::Marks`]): `part` is set on an empty answer of its
/// own, read for that policy and dropped, so `(status, bad_headers, Cache::no_store(), body)` keeps
/// its refusal out of every cache as `(status, Cache::no_store(), bad_headers, body)` does. Nothing
/// else of `part` is kept, and a refusal of its own is not read.
#[cold]
fn after_a_failed_part<P: IntoResponseParts>(part: P, mut failed: Response) -> Response {
    if let Ok(read) = part.into_response_parts(ResponseParts { res: Response::new(crate::body::Body::empty()) }) {
        let marks = crate::cache::Marks::of(read.extensions());
        crate::cache::Marks { unshared: false, ..marks }.put(&mut failed);
    }
    failed
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
