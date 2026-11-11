//! Corten's handler and extractor traits: how a request becomes a handler's arguments and its
//! answer a response. They keep the names, the `Rejection` and the
//! `from_request_parts(parts, state)` signature an extractor was written against when they were
//! axum's (`docs/design.md#choice-own-extractors`), so an app's own extractors compile as they
//! were; the app names them through [`crate::extract`].
//!
//! A handler is an async function whose arguments implement [`FromRequestParts`], the last one
//! [`FromRequest`] (it may take the body), and whose result is any
//! [`IntoResponse`](crate::middleware::IntoResponse). The router boxes its future once.

use std::{convert::Infallible, future::Future};

use http::{request::Parts, HeaderMap, Method, StatusCode, Uri, Version};

use crate::{
    extract::BodyRejection,
    response::{IntoResponse, Response},
};

/// A request as a handler or a middleware takes it whole.
pub type Request<T = crate::answer::Body> = http::Request<T>;

/// A value read from a request's head (its method, URL and headers, and what the stages put in
/// its extensions), which a handler takes as an argument. A refusal is `Rejection`, answered as
/// it is.
#[diagnostic::on_unimplemented(
    message = "a request cannot fill `{Self}`",
    note = "a handler's arguments are Corten's extractors (Req, Params, Form, Caller, ..), State<T> of the routes' state, or an extractor of the app's own that implements corten::extract::FromRequestParts; axum's extractors are not read by Corten's router"
)]
pub trait FromRequestParts<S>: Sized {
    /// What answers the request when the value cannot be read.
    type Rejection: IntoResponse;

    /// Reads the value from the request's head.
    fn from_request_parts(parts: &mut Parts, state: &S) -> impl Future<Output = Result<Self, Self::Rejection>> + Send;
}

/// A value read from a request's head that a handler may go without, as `Option<T>`: `None`
/// where the request does not have it, a refusal (`Rejection`) where it has it and it is wrong.
pub trait OptionalFromRequestParts<S>: Sized {
    /// What answers the request when what it has cannot be read.
    type Rejection: IntoResponse;

    /// Reads the value from the request's head, if it has one.
    fn from_request_parts(parts: &mut Parts, state: &S) -> impl Future<Output = Result<Option<Self>, Self::Rejection>> + Send;
}

mod private {
    /// A [`super::FromRequest`] that reads the whole request.
    #[derive(Debug, Clone, Copy)]
    pub enum ViaRequest {}

    /// A [`super::FromRequest`] that is a [`super::FromRequestParts`].
    #[derive(Debug, Clone, Copy)]
    pub enum ViaParts {}
}

/// A value read from the whole request, its body included, which only a handler's last argument
/// may be ([`crate::Form`], [`crate::Json`], [`crate::Upload`], the [`Request`] itself). Every
/// [`FromRequestParts`] is one too.
#[diagnostic::on_unimplemented(
    message = "a request cannot fill `{Self}`",
    note = "a handler's last argument may read the body (Form, Json, Upload, the whole Request); an extractor of the app's own implements corten::extract::FromRequest or FromRequestParts; axum's extractors are not read by Corten's router"
)]
pub trait FromRequest<S, M = private::ViaRequest>: Sized {
    /// What answers the request when the value cannot be read.
    type Rejection: IntoResponse;

    /// Reads the value from the request.
    fn from_request(req: Request, state: &S) -> impl Future<Output = Result<Self, Self::Rejection>> + Send;
}

impl<S: Send + Sync, T: FromRequestParts<S>> FromRequest<S, private::ViaParts> for T {
    type Rejection = <T as FromRequestParts<S>>::Rejection;

    fn from_request(req: Request, state: &S) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let (mut parts, _) = req.into_parts();
        async move { T::from_request_parts(&mut parts, state).await }
    }
}

impl<S: Send + Sync, T: OptionalFromRequestParts<S>> FromRequestParts<S> for Option<T> {
    type Rejection = <T as OptionalFromRequestParts<S>>::Rejection;

    #[inline]
    fn from_request_parts(parts: &mut Parts, state: &S) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        <T as OptionalFromRequestParts<S>>::from_request_parts(parts, state)
    }
}

/// The value, or the refusal that would have answered the request, for a handler that answers
/// it itself.
impl<S: Send + Sync, T: FromRequestParts<S>> FromRequestParts<S> for Result<T, T::Rejection> {
    type Rejection = Infallible;

    #[inline]
    fn from_request_parts(parts: &mut Parts, state: &S) -> impl Future<Output = Result<Self, Infallible>> + Send {
        let read = T::from_request_parts(parts, state);
        async move { Ok(read.await) }
    }
}

/// The value read from the whole request, or the refusal that would have answered it.
impl<S: Send + Sync, T: FromRequest<S>> FromRequest<S> for Result<T, T::Rejection> {
    type Rejection = Infallible;

    #[inline]
    fn from_request(req: Request, state: &S) -> impl Future<Output = Result<Self, Infallible>> + Send {
        let read = T::from_request(req, state);
        async move { Ok(read.await) }
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Method {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Infallible> {
        Ok(parts.method.clone())
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Uri {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Infallible> {
        Ok(parts.uri.clone())
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Version {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Infallible> {
        Ok(parts.version)
    }
}

/// The request's headers, copied.
impl<S: Send + Sync> FromRequestParts<S> for HeaderMap {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Infallible> {
        Ok(parts.headers.clone())
    }
}

/// The whole request, for a handler that reads it as it came (its body with
/// [`crate::extract::bytes_up_to`]).
impl<S: Send + Sync> FromRequest<S> for Request {
    type Rejection = Infallible;

    async fn from_request(req: Request, _: &S) -> Result<Self, Infallible> {
        Ok(req)
    }
}

/// The whole body as [`crate::Bytes`], refused with a `413` over the route's limit
/// ([`crate::App::body_limit`], 2 MiB unless set; [`BodyRejection`]).
impl<S: Send + Sync> FromRequest<S> for bytes::Bytes {
    type Rejection = BodyRejection;

    async fn from_request(req: Request, _: &S) -> Result<Self, BodyRejection> {
        let limit = crate::extract::body_limit(req.extensions());
        crate::extract::whole(req.into_body(), limit).await
    }
}

/// The whole body as text, refused with a `400` when it is not UTF-8 and a `413` over the
/// route's limit ([`crate::App::body_limit`], 2 MiB unless set; [`BodyRejection`]).
impl<S: Send + Sync> FromRequest<S> for String {
    type Rejection = BodyRejection;

    async fn from_request(req: Request, _: &S) -> Result<Self, BodyRejection> {
        let limit = crate::extract::body_limit(req.extensions());
        let bytes = crate::extract::whole(req.into_body(), limit).await?;
        String::from_utf8(bytes.into()).map_err(|error| {
            BodyRejection::new(
                StatusCode::BAD_REQUEST,
                format!("Request body didn't contain valid UTF-8: {}", error.utf8_error()),
            )
        })
    }
}

/// The body as it comes, unread, for a handler that reads it itself
/// ([`crate::extract::pieces_up_to`]).
impl<S: Send + Sync> FromRequest<S> for crate::answer::Body {
    type Rejection = Infallible;

    async fn from_request(req: Request, _: &S) -> Result<Self, Infallible> {
        Ok(req.into_body())
    }
}

/// A part of the routes' state `T` a handler takes (`State<Market>`), or that an extractor of the
/// app's own reads ([`crate::extract`]): `#[derive(FromRef)]` writes it for each field, and every
/// `Clone` state is a part of itself.
pub trait FromRef<T> {
    /// The part, out of the whole state.
    fn from_ref(input: &T) -> Self;
}

impl<T: Clone> FromRef<T> for T {
    #[inline]
    fn from_ref(input: &T) -> Self {
        input.clone()
    }
}

/// A part of the routes' state (`#[corten::routes(state = T)]`), or all of it, taken by a
/// handler as `State(lists): State<Lists>` where `Lists: FromRef<T>`.
#[derive(Debug, Default, Clone, Copy)]
pub struct State<S>(pub S);

impl<Outer: Send + Sync, Inner: FromRef<Outer>> FromRequestParts<Outer> for State<Inner> {
    type Rejection = Infallible;

    async fn from_request_parts(_: &mut Parts, state: &Outer) -> Result<Self, Infallible> {
        Ok(State(Inner::from_ref(state)))
    }
}

impl<S> std::ops::Deref for State<S> {
    type Target = S;

    fn deref(&self) -> &S {
        &self.0
    }
}

impl<S> std::ops::DerefMut for State<S> {
    fn deref_mut(&mut self) -> &mut S {
        &mut self.0
    }
}

/// What a route calls: an async function whose arguments a request fills and whose result is a
/// response, with the state `S` it is given. `T` is the arguments' types, which tell one arity's
/// impl from another's. Public in a private module: functions an app calls name it as a bound,
/// and an app cannot name or implement it.
pub trait Handler<T, S>: Clone + Send + Sync + Sized + 'static {
    /// The answer to `req`.
    fn call(self, req: Request, state: S) -> impl Future<Output = Response> + Send + 'static;
}

impl<F, Fut, S, Res> Handler<((),), S> for F
where
    F: FnOnce() -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Res> + Send + 'static,
    S: Send + Sync + 'static,
    Res: IntoResponse,
{
    // Not an `async fn`: it would hold the request and the state in the future for nothing.
    #[allow(clippy::manual_async_fn)]
    #[inline]
    fn call(self, _: Request, _: S) -> impl Future<Output = Response> + Send + 'static {
        async move { self().await.into_response() }
    }
}

macro_rules! handlers {
    ([$($ty:ident),*], $last:ident) => {
        #[allow(non_snake_case, unused_mut)]
        impl<F, Fut, S, Res, M, $($ty,)* $last> Handler<(M, $($ty,)* $last,), S> for F
        where
            F: FnOnce($($ty,)* $last,) -> Fut + Clone + Send + Sync + 'static,
            Fut: Future<Output = Res> + Send + 'static,
            S: Send + Sync + 'static,
            Res: IntoResponse,
            M: 'static,
            $( $ty: FromRequestParts<S> + Send + 'static, )*
            $last: FromRequest<S, M> + Send + 'static,
        {
            fn call(self, req: Request, state: S) -> impl Future<Output = Response> + Send + 'static {
                let (mut parts, body) = req.into_parts();
                async move {
                    $(
                        let $ty = match $ty::from_request_parts(&mut parts, &state).await {
                            Ok(value) => value,
                            Err(rejection) => return rejection.into_response(),
                        };
                    )*
                    let req = Request::from_parts(parts, body);
                    let $last = match $last::from_request(req, &state).await {
                        Ok(value) => value,
                        Err(rejection) => return rejection.into_response(),
                    };
                    self($($ty,)* $last,).await.into_response()
                }
            }
        }
    };
}
handlers!([], T1);
handlers!([T1], T2);
handlers!([T1, T2], T3);
handlers!([T1, T2, T3], T4);
handlers!([T1, T2, T3, T4], T5);
handlers!([T1, T2, T3, T4, T5], T6);
handlers!([T1, T2, T3, T4, T5, T6], T7);
handlers!([T1, T2, T3, T4, T5, T6, T7], T8);
handlers!([T1, T2, T3, T4, T5, T6, T7, T8], T9);
handlers!([T1, T2, T3, T4, T5, T6, T7, T8, T9], T10);
handlers!([T1, T2, T3, T4, T5, T6, T7, T8, T9, T10], T11);
handlers!([T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11], T12);
handlers!([T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12], T13);
handlers!([T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13], T14);
handlers!([T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14], T15);
handlers!([T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15], T16);
