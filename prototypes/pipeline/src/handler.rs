//! Handlers: async functions whose arguments read the request and whose result is the answer.
//!
//! Reading is two traits. [`FromParts`] reads the request's head (method, URI, headers) and the
//! context; any argument may. [`FromRequest`] takes the whole request, body included; only the
//! last argument may. The raw [`Request`] is the last argument that reads everything as it came.
//!
//! Answering is one trait, [`Respond`]: the raw [`Response`] is one, and so are text, a status,
//! [`Json`], a [`Failure`] and a `Result` of any two.

use std::{future::Future, marker::PhantomData};

use bytes::Bytes;
use http::{HeaderValue, Method, StatusCode, Uri, header, request::Parts};
use http_body_util::BodyExt;

use crate::{Body, Endpoint, Failure, Has, Request, Response};

/// An argument read from the request's head and the context.
#[diagnostic::on_unimplemented(
    message = "a handler cannot take a `{Self}` here",
    note = "an argument reads the request's head or what the stages around the route give; one that reads the body (`Json`, `Request`) goes last"
)]
pub trait FromParts<Cx, M>: Sized + Send {
    fn from_parts(parts: &Parts, cx: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send;
}

/// The last argument: it may take the whole request, body included.
pub trait FromRequest<Cx, M>: Sized + Send {
    fn from_request(req: Request, cx: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send;
}

/// [`FromRequest`] for every [`FromParts`].
pub struct ViaParts;
/// [`FromRequest`] of a type that reads the body.
pub struct ViaBody;

impl<Cx: Sync, M, T: FromParts<Cx, M>> FromRequest<Cx, (ViaParts, M)> for T {
    #[inline]
    fn from_request(req: Request, cx: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send {
        let (parts, _) = req.into_parts();
        async move { T::from_parts(&parts, cx).await }
    }
}

/// The raw request, as the connection and the stages gave it.
impl<Cx: Sync> FromRequest<Cx, ViaBody> for Request {
    #[inline]
    fn from_request(req: Request, _: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send {
        std::future::ready(Ok(req))
    }
}

impl<Cx: Sync> FromParts<Cx, ViaParts> for Method {
    #[inline]
    fn from_parts(parts: &Parts, _: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send {
        std::future::ready(Ok(parts.method.clone()))
    }
}

impl<Cx: Sync> FromParts<Cx, ViaParts> for Uri {
    #[inline]
    fn from_parts(parts: &Parts, _: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send {
        std::future::ready(Ok(parts.uri.clone()))
    }
}

/// What the stages give, read by type: `State<Db>` from [`crate::stages::Share`].
#[derive(Clone, Copy, Debug)]
pub struct State<T>(pub T);

/// [`FromParts`] of something the context holds.
pub struct FromCx<I>(PhantomData<I>);

impl<Cx: Has<State<T>, I> + Sync, I, T: Clone + Send + Sync> FromParts<Cx, FromCx<I>> for State<T> {
    #[inline]
    fn from_parts(_: &Parts, cx: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send {
        std::future::ready(Ok(cx.get().clone()))
    }
}

/// The request's body read whole, up to 2 MiB, as `T`; the answer, `T` written as JSON.
pub struct Json<T>(pub T);

/// How much of a body [`Json`] and [`Bytes`] read.
pub const BODY_LIMIT: usize = 2 << 20;

async fn read_body(req: Request) -> Result<Bytes, Failure> {
    use http_body::Body as _;
    if req.body().size_hint().lower() > BODY_LIMIT as u64 {
        return Err(Failure::new(StatusCode::PAYLOAD_TOO_LARGE));
    }
    let limited = http_body_util::Limited::new(req.into_body(), BODY_LIMIT);
    match limited.collect().await {
        Ok(collected) => Ok(collected.to_bytes()),
        Err(error) if error.is::<http_body_util::LengthLimitError>() => Err(Failure::new(StatusCode::PAYLOAD_TOO_LARGE)),
        Err(error) => Err(Failure::new(StatusCode::BAD_REQUEST).detail(error.to_string())),
    }
}

impl<Cx: Sync> FromRequest<Cx, ViaBody> for Bytes {
    fn from_request(req: Request, _: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send {
        read_body(req)
    }
}

impl<Cx: Sync, T: serde::de::DeserializeOwned + Send> FromRequest<Cx, ViaBody> for Json<T> {
    fn from_request(req: Request, _: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send {
        let json = req.headers().get(header::CONTENT_TYPE).is_some_and(|kind| {
            kind.as_bytes().split(|b| *b == b';').next().is_some_and(|t| t.trim_ascii().eq_ignore_ascii_case(b"application/json"))
        });
        async move {
            if !json {
                return Err(Failure::new(StatusCode::UNSUPPORTED_MEDIA_TYPE));
            }
            let bytes = read_body(req).await?;
            serde_json::from_slice(&bytes)
                .map(Json)
                .map_err(|e| Failure::new(StatusCode::UNPROCESSABLE_ENTITY).detail(e.to_string()))
        }
    }
}

/// An answer.
pub trait Respond {
    fn respond(self) -> Response;
}

impl Respond for Response {
    #[inline]
    fn respond(self) -> Response {
        self
    }
}

impl Respond for Failure {
    #[inline]
    fn respond(self) -> Response {
        self.into_response()
    }
}

/// A status alone: a 4xx or 5xx is a [`Failure`], so the stages describe it.
impl Respond for StatusCode {
    fn respond(self) -> Response {
        if self.is_client_error() || self.is_server_error() {
            return Failure::new(self).into_response();
        }
        let mut res = Response::new(Body::empty());
        *res.status_mut() = self;
        res
    }
}

fn text(body: Body) -> Response {
    let mut res = Response::new(body);
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    res
}

impl Respond for &'static str {
    fn respond(self) -> Response {
        text(Body::from(self))
    }
}

impl Respond for String {
    fn respond(self) -> Response {
        text(Body::from(self))
    }
}

impl<T: serde::Serialize> Respond for Json<T> {
    fn respond(self) -> Response {
        let mut bytes = Vec::with_capacity(128);
        match serde_json::to_writer(&mut bytes, &self.0) {
            Ok(()) => {
                let mut res = Response::new(Body::from(bytes));
                res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
                res
            }
            Err(error) => Failure::new(StatusCode::INTERNAL_SERVER_ERROR).detail(error.to_string()).into_response(),
        }
    }
}

impl<T: Respond, E: Respond> Respond for Result<T, E> {
    #[inline]
    fn respond(self) -> Response {
        match self {
            Ok(ok) => ok.respond(),
            Err(err) => err.respond(),
        }
    }
}

/// An async function that answers requests. `M` names its arguments' types and where each reads
/// from; the compiler works it out.
pub trait Handler<Cx, M>: Send + Sync + 'static {
    fn call(&self, req: Request, cx: Cx) -> impl Future<Output = Response> + Send + '_;
}

impl<F, Fut, R, Cx> Handler<Cx, (R,)> for F
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = R> + Send + 'static,
    R: Respond,
    Cx: Send + 'static,
{
    // Not an `async fn`: its future would have to outlive `R`, which the trait's `'_` does not say.
    #[allow(clippy::manual_async_fn)]
    #[inline]
    fn call(&self, _: Request, _: Cx) -> impl Future<Output = Response> + Send + '_ {
        async move { self().await.respond() }
    }
}

macro_rules! handler_arity {
    ($(($arg:ident, $marker:ident, $value:ident)),*) => {
        impl<F, Fut, R, Cx, $($arg, $marker,)* Last, LastM> Handler<Cx, (R, $(($arg, $marker),)* (Last, LastM))> for F
        where
            F: Fn($($arg,)* Last) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = R> + Send + 'static,
            R: Respond,
            Cx: Send + Sync + 'static,
            $($arg: FromParts<Cx, $marker>,)*
            Last: FromRequest<Cx, LastM>,
        {
            #[allow(unused_variables)]
            fn call(&self, req: Request, cx: Cx) -> impl Future<Output = Response> + Send + '_ {
                async move {
                    let (parts, body) = req.into_parts();
                    $(
                        let $value = match $arg::from_parts(&parts, &cx).await {
                            Ok(value) => value,
                            Err(failure) => return failure.into_response(),
                        };
                    )*
                    let last = match Last::from_request(Request::from_parts(parts, body), &cx).await {
                        Ok(value) => value,
                        Err(failure) => return failure.into_response(),
                    };
                    self($($value,)* last).await.respond()
                }
            }
        }
    };
}

handler_arity!();
handler_arity!((A, MA, a));
handler_arity!((A, MA, a), (B, MB, b));
handler_arity!((A, MA, a), (B, MB, b), (C, MC, c));
handler_arity!((A, MA, a), (B, MB, b), (C, MC, c), (D, MD, d));

/// A handler as an [`Endpoint`].
pub struct HandlerEndpoint<H, M> {
    handler: H,
    marker: PhantomData<fn() -> M>,
}

/// `f` as an endpoint, for [`crate::Stages::serve`]; [`crate::get`] and the other methods take a
/// handler as it is.
pub fn handler<H, M>(handler: H) -> HandlerEndpoint<H, M> {
    HandlerEndpoint { handler, marker: PhantomData }
}

impl<Cx, H: Handler<Cx, M>, M: 'static> Endpoint<Cx> for HandlerEndpoint<H, M> {
    #[inline]
    fn call(&self, req: Request, cx: Cx) -> impl Future<Output = Response> + Send + '_ {
        self.handler.call(req, cx)
    }
}
