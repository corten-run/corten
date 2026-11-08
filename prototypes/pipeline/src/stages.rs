//! Corten's defaults, each a [`Stage`]: put together by [`Stages::api`] and [`Stages::page`] in
//! Corten's order, or one at a time with [`Stages::with`].

use std::{
    future::Future,
    marker::PhantomData,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

use bytes::Bytes;
use futures_util::{FutureExt, future::Either};
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use http_body::{Frame, SizeHint};
use tokio::sync::Notify;

use crate::{
    Body, BoxError, Endpoint, Failure, FromParts, Has, Here, Request, Response, Stage, Stages, handler::FromCx, handler::State,
};

/// The defaults of a JSON route, outside in: security headers, `Cache-Control`, the host check,
/// failures as problem+json, the same-origin check on writes, the request's signal, the deadline
/// and the panic catch. A stage of the app's own goes inside them: `Stages::api().with(RateLimit)`.
pub type Api = Stages<(((((((((), Secure), Cache), Host), Errors), SameOrigin), Cancel), Deadline<Here>), CatchPanic)>;

impl Stages<()> {
    /// [`Api`]: Corten's defaults for a JSON route.
    pub fn api() -> Api {
        Stages::new()
            .with(Secure::api())
            .with(Cache::private())
            .with(Host::loopback())
            .with(Errors::json())
            .with(SameOrigin)
            .with(Cancel)
            .with(Deadline::new(Duration::from_secs(30)))
            .with(CatchPanic)
    }
}

/// Answers `421 Misdirected Request` to a `Host` the app does not answer to (DNS rebinding):
/// anything but `localhost`, a name under it, an IP address, no `Host`, or a name it lists.
#[derive(Clone)]
pub struct Host {
    names: Arc<[String]>,
}

impl Host {
    /// Loopback names and IP addresses only.
    pub fn loopback() -> Self {
        Host { names: Arc::from([]) }
    }

    /// `name` too; `.shop.example` for every name under it.
    pub fn name(self, name: &str) -> Self {
        let mut names = self.names.to_vec();
        names.push(name.to_ascii_lowercase());
        Host { names: names.into() }
    }

    fn answers(&self, headers: &HeaderMap) -> bool {
        let Some(host) = headers.get(header::HOST) else { return true };
        let Ok(host) = host.to_str() else { return false };
        let name = match host.strip_prefix('[') {
            // An IPv6 literal.
            Some(rest) => return rest.split_once(']').is_some_and(|(ip, _)| ip.parse::<std::net::Ipv6Addr>().is_ok()),
            None => host.rsplit_once(':').map_or(host, |(name, _)| name),
        };
        if name.parse::<std::net::Ipv4Addr>().is_ok() {
            return true;
        }
        let under = |name: &str, domain: &str| {
            name.len() > domain.len()
                && name[name.len() - domain.len()..].eq_ignore_ascii_case(domain)
                && name.as_bytes()[name.len() - domain.len() - 1] == b'.'
        };
        if name.eq_ignore_ascii_case("localhost") || under(name, "localhost") {
            return true;
        }
        self.names.iter().any(|listed| match listed.strip_prefix('.') {
            Some(domain) => name.eq_ignore_ascii_case(domain) || under(name, domain),
            None => name.eq_ignore_ascii_case(listed),
        })
    }
}

impl<Cx: Send + 'static> Stage<Cx> for Host {
    type Out = Cx;

    #[inline]
    fn call<'a, E: Endpoint<Cx>>(&'a self, req: Request, cx: Cx, inner: &'a E) -> impl Future<Output = Response> + Send + 'a {
        if !self.answers(req.headers()) {
            // Not a failure to describe: nothing of the app's runs for another site's name.
            let mut res = Response::new(Body::empty());
            *res.status_mut() = StatusCode::MISDIRECTED_REQUEST;
            return Either::Right(std::future::ready(res));
        }
        Either::Left(inner.call(req, cx))
    }
}

/// Refuses (403) a write another site's page sent: an unsafe method whose `Sec-Fetch-Site` is
/// another site's, or whose `Origin` is not the request's host. A request with neither header is
/// not a browser's and goes through.
#[derive(Clone, Copy)]
pub struct SameOrigin;

impl SameOrigin {
    fn allows(method: &Method, headers: &HeaderMap) -> bool {
        if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS | Method::TRACE) {
            return true;
        }
        if let Some(site) = headers.get("sec-fetch-site") {
            return matches!(site.as_bytes(), b"same-origin" | b"none");
        }
        let Some(origin) = headers.get(header::ORIGIN) else { return true };
        let host = headers.get(header::HOST).map(HeaderValue::as_bytes);
        let origin = origin.as_bytes();
        let rest = origin.strip_prefix(b"https://").or_else(|| origin.strip_prefix(b"http://"));
        rest.is_some_and(|rest| Some(rest) == host)
    }
}

impl<Cx: Send + 'static> Stage<Cx> for SameOrigin {
    type Out = Cx;

    #[inline]
    fn call<'a, E: Endpoint<Cx>>(&'a self, req: Request, cx: Cx, inner: &'a E) -> impl Future<Output = Response> + Send + 'a {
        if !Self::allows(req.method(), req.headers()) {
            let refused = Failure::new(StatusCode::FORBIDDEN).detail("a write another site sent");
            return Either::Right(std::future::ready(refused.into_response()));
        }
        Either::Left(inner.call(req, cx))
    }
}

/// Why a request's [`Signal`] aborted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Abort {
    Responded,
    Disconnected,
    Deadline,
}

/// When the work for a request should stop, like the browser's `AbortSignal`: given by [`Cancel`].
#[derive(Clone, Default)]
pub struct Signal(Arc<SignalInner>);

#[derive(Default)]
struct SignalInner {
    /// 0 while running, else an [`Abort`] + 1.
    reason: AtomicU8,
    notify: Notify,
}

impl Signal {
    pub fn reason(&self) -> Option<Abort> {
        match self.0.reason.load(Ordering::Acquire) {
            1 => Some(Abort::Responded),
            2 => Some(Abort::Disconnected),
            3 => Some(Abort::Deadline),
            _ => None,
        }
    }

    pub fn is_aborted(&self) -> bool {
        self.reason().is_some()
    }

    /// Resolves once it aborts.
    pub async fn aborted(&self) -> Abort {
        loop {
            let notified = self.0.notify.notified();
            if let Some(reason) = self.reason() {
                return reason;
            }
            notified.await;
        }
    }

    fn abort(&self, why: Abort) {
        if self.0.reason.compare_exchange(0, why as u8 + 1, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            self.0.notify.notify_waiters();
        }
    }
}

/// The request's signal, for a handler: `signal: Signal`.
impl<Cx: Has<Signal, I> + Sync, I> FromParts<Cx, FromCx<I>> for Signal {
    #[inline]
    fn from_parts(_: &http::request::Parts, cx: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send {
        std::future::ready(Ok(cx.get().clone()))
    }
}

/// Gives each request a [`Signal`], aborted when its answer has been sent, or when the client
/// leaves first (the request's future is dropped).
#[derive(Clone, Copy)]
pub struct Cancel;

/// Aborts the signal when dropped before the answer was sent.
struct Leaving(Option<Signal>);

impl Drop for Leaving {
    fn drop(&mut self) {
        if let Some(signal) = self.0.take() {
            signal.abort(Abort::Disconnected);
        }
    }
}

impl<Cx: Send + 'static> Stage<Cx> for Cancel {
    type Out = (Signal, Cx);

    #[inline]
    fn call<'a, E: Endpoint<(Signal, Cx)>>(
        &'a self,
        req: Request,
        cx: Cx,
        inner: &'a E,
    ) -> impl Future<Output = Response> + Send + 'a {
        let signal = Signal::default();
        // Dropped with the request's future if the client leaves first.
        let mut leaving = Leaving(Some(signal.clone()));
        inner.call(req, (signal, cx)).map(move |res| {
            let signal = leaving.0.take().expect("answered once");
            if http_body::Body::size_hint(res.body()).exact().is_some() {
                signal.abort(Abort::Responded);
                return res;
            }
            // A stream: the signal aborts when its last byte is sent, or it is dropped first.
            let (parts, body) = res.into_parts();
            Response::from_parts(parts, Body::stream(Followed { body, signal: Leaving(Some(signal)) }))
        })
    }
}

struct Followed {
    body: Body,
    signal: Leaving,
}

impl http_body::Body for Followed {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let polled = Pin::new(&mut self.body).poll_frame(cx);
        if let Poll::Ready(None) = polled
            && let Some(signal) = self.signal.0.take()
        {
            signal.abort(Abort::Responded);
        }
        polled
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

/// Answers 503 when the endpoint has not answered within its time, and aborts the request's
/// [`Signal`], so it must be inside [`Cancel`] (the compiler holds it there). The timer is made
/// only when the endpoint first waits.
pub struct Deadline<I> {
    limit: Duration,
    marker: PhantomData<fn() -> I>,
}

impl<I> Clone for Deadline<I> {
    fn clone(&self) -> Self {
        Deadline { limit: self.limit, marker: PhantomData }
    }
}

impl<I> Deadline<I> {
    pub fn new(limit: Duration) -> Self {
        Deadline { limit, marker: PhantomData }
    }
}

impl<Cx: Has<Signal, I> + Send + 'static, I: 'static> Stage<Cx> for Deadline<I> {
    type Out = Cx;

    #[inline]
    fn call<'a, E: Endpoint<Cx>>(&'a self, req: Request, cx: Cx, inner: &'a E) -> impl Future<Output = Response> + Send + 'a {
        let signal = cx.get().clone();
        Within { answer: inner.call(req, cx), timer: None, limit: self.limit, signal }
    }
}

pin_project_lite::pin_project! {
    /// The endpoint's answer, or the deadline's 503 once its timer has run out.
    struct Within<F> {
        #[pin]
        answer: F,
        // Boxed and made only when the endpoint first waits, so an answer ready at once costs
        // no timer and its future stays small.
        timer: Option<Pin<Box<tokio::time::Sleep>>>,
        limit: Duration,
        signal: Signal,
    }
}

impl<F: Future<Output = Response>> Future for Within<F> {
    type Output = Response;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Response> {
        let this = self.project();
        if let Poll::Ready(res) = this.answer.poll(context) {
            return Poll::Ready(res);
        }
        let timer = this.timer.get_or_insert_with(|| Box::pin(tokio::time::sleep(*this.limit)));
        match timer.as_mut().poll(context) {
            Poll::Ready(()) => {
                this.signal.abort(Abort::Deadline);
                Poll::Ready(Failure::new(StatusCode::SERVICE_UNAVAILABLE).detail("past its deadline").into_response())
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

/// A panic in the endpoint answers 500, instead of dropping the connection with no answer.
#[derive(Clone, Copy)]
pub struct CatchPanic;

impl<Cx: Send + 'static> Stage<Cx> for CatchPanic {
    type Out = Cx;

    #[inline]
    fn call<'a, E: Endpoint<Cx>>(&'a self, req: Request, cx: Cx, inner: &'a E) -> impl Future<Output = Response> + Send + 'a {
        Caught { answer: inner.call(req, cx) }
    }
}

pin_project_lite::pin_project! {
    struct Caught<F> {
        #[pin]
        answer: F,
    }
}

impl<F: Future<Output = Response>> Future for Caught<F> {
    type Output = Response;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Response> {
        let answer = self.project().answer;
        match std::panic::catch_unwind(AssertUnwindSafe(|| answer.poll(context))) {
            Ok(polled) => polled,
            Err(panic) => {
                let message = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "a panic with no message".into());
                Poll::Ready(Failure::new(StatusCode::INTERNAL_SERVER_ERROR).detail(message).into_response())
            }
        }
    }
}

/// The security headers on every answer: a CSP, `nosniff`, a referrer policy, `X-Frame-Options`
/// and an opener policy. An answer that set one keeps its own.
#[derive(Clone)]
pub struct Secure {
    csp: HeaderValue,
    referrer: HeaderValue,
    opener: HeaderValue,
}

const OPENER: HeaderName = HeaderName::from_static("cross-origin-opener-policy");

impl Secure {
    /// For answers that are never a page: a CSP that allows nothing.
    pub fn api() -> Self {
        Secure {
            csp: HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
            referrer: HeaderValue::from_static("strict-origin-when-cross-origin"),
            opener: HeaderValue::from_static("same-origin"),
        }
    }

    /// For pages: scripts, styles and the rest from this origin only.
    pub fn page() -> Self {
        Secure {
            csp: HeaderValue::from_static(
                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'",
            ),
            ..Secure::api()
        }
    }

    fn apply(&self, headers: &mut HeaderMap) {
        headers.reserve(6);
        let mut set = |name: HeaderName, value: &HeaderValue| {
            if let header::Entry::Vacant(entry) = headers.entry(name) {
                entry.insert(value.clone());
            }
        };
        set(header::CONTENT_SECURITY_POLICY, &self.csp);
        set(header::X_CONTENT_TYPE_OPTIONS, &NOSNIFF);
        set(header::REFERRER_POLICY, &self.referrer);
        set(header::X_FRAME_OPTIONS, &DENY);
        set(OPENER, &self.opener);
    }
}

const NOSNIFF: HeaderValue = HeaderValue::from_static("nosniff");
const DENY: HeaderValue = HeaderValue::from_static("DENY");

impl<Cx: Send + 'static> Stage<Cx> for Secure {
    type Out = Cx;

    #[inline]
    fn call<'a, E: Endpoint<Cx>>(&'a self, req: Request, cx: Cx, inner: &'a E) -> impl Future<Output = Response> + Send + 'a {
        inner.call(req, cx).map(move |mut res| {
            self.apply(res.headers_mut());
            res
        })
    }
}

/// `Cache-Control: private, no-cache` on an answer that does not say: nothing shared keeps it.
#[derive(Clone, Copy)]
pub struct Cache;

impl Cache {
    pub fn private() -> Self {
        Cache
    }
}

const PRIVATE: HeaderValue = HeaderValue::from_static("private, no-cache");

impl<Cx: Send + 'static> Stage<Cx> for Cache {
    type Out = Cx;

    #[inline]
    fn call<'a, E: Endpoint<Cx>>(&'a self, req: Request, cx: Cx, inner: &'a E) -> impl Future<Output = Response> + Send + 'a {
        inner.call(req, cx).map(|mut res| {
            if let header::Entry::Vacant(entry) = res.headers_mut().entry(header::CACHE_CONTROL) {
                entry.insert(PRIVATE);
            }
            res
        })
    }
}

/// Describes every [`Failure`] inside it: problem+json ([`Errors::json`]) or the app's own page
/// ([`Errors::with`]). Headers the failure had (`Allow`, `Retry-After`) stay.
#[derive(Clone)]
pub struct Errors {
    describe: fn(&Failure, bool) -> Response,
    /// Whether the detail is shown (a developer's server).
    dev: bool,
}

impl Errors {
    /// `application/problem+json`: `{"title","status"}`, with `"detail"` under `dev`.
    pub fn json() -> Self {
        Errors { describe: problem, dev: false }
    }

    /// The app's own description of a failure; the `bool` is whether to show its detail.
    pub fn with(describe: fn(&Failure, bool) -> Response) -> Self {
        Errors { describe, dev: false }
    }

    /// Show each failure's detail.
    pub fn dev(self, dev: bool) -> Self {
        Errors { dev, ..self }
    }
}

fn problem(failure: &Failure, dev: bool) -> Response {
    use std::fmt::Write;
    let status = failure.status();
    // The reason phrases are ASCII words with nothing to escape; the detail is any text.
    let mut json = String::with_capacity(64);
    let _ = write!(json, r#"{{"title":"{}","status":{}"#, status.canonical_reason().unwrap_or("Error"), status.as_u16());
    if let Some(detail) = failure.detail_text().filter(|_| dev) {
        let _ = write!(json, r#","detail":{}"#, serde_json::Value::from(detail));
    }
    json.push('}');
    let mut res = Response::new(Body::from(json));
    *res.status_mut() = status;
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/problem+json"));
    res
}
impl<Cx: Send + 'static> Stage<Cx> for Errors {
    type Out = Cx;

    #[inline]
    fn call<'a, E: Endpoint<Cx>>(&'a self, req: Request, cx: Cx, inner: &'a E) -> impl Future<Output = Response> + Send + 'a {
        inner.call(req, cx).map(move |res| {
            let Some(failure) = res.body().failure() else { return res };
            let described = (self.describe)(failure, self.dev);
            // The failure's status and headers (`Allow`, `Retry-After`), the description's body
            // and the headers it sets.
            let (mut parts, _) = res.into_parts();
            let (new, body) = described.into_parts();
            for (name, value) in &new.headers {
                parts.headers.insert(name, value.clone());
            }
            Response::from_parts(parts, body)
        })
    }
}
/// Gives every request a `State<T>`: what the app's handlers share (a database pool), read by
/// type, `State(db): State<Db>`.
#[derive(Clone)]
pub struct Share<T>(pub T);

impl<Cx: Send + 'static, T: Clone + Send + Sync + 'static> Stage<Cx> for Share<T> {
    type Out = (State<T>, Cx);

    #[inline]
    fn call<'a, E: Endpoint<(State<T>, Cx)>>(
        &'a self,
        req: Request,
        cx: Cx,
        inner: &'a E,
    ) -> impl Future<Output = Response> + Send + 'a {
        inner.call(req, (State(self.0.clone()), cx))
    }
}

/// For the measurements only: the same signal carried as a request extension, as axum and
/// Corten carry what a layer gives a handler, to price the typed context against it.
pub mod experiment {
    use super::*;

    #[derive(Clone, Copy)]
    pub struct CancelInExtensions;

    impl<Cx: Send + 'static> Stage<Cx> for CancelInExtensions {
        type Out = Cx;

        #[inline]
        fn call<'a, E: Endpoint<Cx>>(
            &'a self,
            mut req: Request,
            cx: Cx,
            inner: &'a E,
        ) -> impl Future<Output = Response> + Send + 'a {
            let signal = Signal::default();
            req.extensions_mut().insert(signal.clone());
            inner.call(req, cx).map(move |res| {
                signal.abort(Abort::Responded);
                res
            })
        }
    }

    /// The signal from the request's extensions.
    pub struct SignalFromExtensions(pub Signal);

    impl<Cx: Sync> FromParts<Cx, crate::handler::ViaParts> for SignalFromExtensions {
        #[inline]
        fn from_parts(parts: &http::request::Parts, _: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send {
            std::future::ready(
                parts
                    .extensions
                    .get::<Signal>()
                    .cloned()
                    .map(SignalFromExtensions)
                    .ok_or(Failure::new(StatusCode::INTERNAL_SERVER_ERROR)),
            )
        }
    }
}
