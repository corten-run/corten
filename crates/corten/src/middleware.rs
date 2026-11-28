//! [`Middleware`]: a step of the app's own in every request (a request id, a rate limit, a trace
//! span), at one place in Corten's order. A route that says `unstaged` goes through none of it,
//! the app's, its area's or its API's ([`crate::routes`]), so a rate limit or a check of the
//! app's does not cover it.
//!
//! The order is fixed, outside in, and each stage needs the one before it:
//!
//! 1. Compression is negotiated (`Accept-Encoding`); it is applied last.
//! 2. A request for a host the app does not answer to gets `421` and nothing else, and one HTTP
//!    does not allow `400` ([`crate::security::Policy::host`]); a write another site sent is refused
//!    ([`crate::Failure::CrossSite`]).
//! 3. The request gets its [`crate::Signal`], its nonce and the app.
//! 4. The deadline and the panic catch start ([`crate::Failure::TimedOut`],
//!    [`crate::Failure::Panicked`]).
//! 5. The app's middleware, in the order given ([`crate::App::middleware`]). The route has been
//!    matched, so [`MatchedPath`] names it (none for an unknown URL, nor for a path under an
//!    API's prefix that a route outside the API matched, which the API answers 404). Then, for a request
//!    under an area's or an API's prefix, its own middleware ([`crate::Area::middleware`],
//!    [`crate::Api::middleware`]): the areas' (outer first), then the APIs' (outer first), each in
//!    the order given. A request anywhere else never meets it.
//! 6. The handler's extractors (a [`crate::Caller`] is looked up here, only when read), the
//!    handler. In an app with layout reads ([`crate::App::layout_read`]), a whole document's
//!    `GET` starts them as a page route is called, or as a handler takes its [`crate::Req`],
//!    beside the handler, and a write that draws a page rather than redirect starts the reads its
//!    page draws once it has answered. Either way the page is filled with their values before
//!    its answer goes back out through 5: a middleware sees the filled page, and the time it
//!    measures around `next` includes the reads' wait (`docs/design.md#choice-layout-reads`).
//!    A [`crate::Public`] page, JSON, text or file the app has kept is given here in the handler's place
//!    ([`crate::App::kept_answers`], `docs/design.md#choice-kept-pages`): 1 to 5 ran for its
//!    request as for any other, and 7 and 8 follow, so a middleware meets every request and sees
//!    the kept page as it would the handler's answer.
//! 7. A failure becomes its route's answer: JSON for a JSON route or a data client, the app's
//!    error page for a browser ([`crate::App::error_page`]). For a failure the request is at fault
//!    for (an unknown URL, a wrong method, a method no route in the app has (the router's 501), a
//!    refusal other than a 429, a request that does not parse), the error page starts the layout reads not started yet and waits for them, here,
//!    outside 5: a middleware sees neither the error page nor that wait.
//! 8. `accept-language` in `Vary` when anything negotiated the request's locale from it (the
//!    app's middleware too), security headers, `Cache-Control` (private when anything read a
//!    caller), then the weak `ETag` on the answer to a `GET` or `HEAD` (outside an API and
//!    Corten's own paths), and
//!    `304 Not Modified` in place of the body when the client already has it
//!    (`docs/design.md#limit-etag`), then compression. A middleware sees the `200` with the
//!    whole body, also when the client gets the `304`.
//!
//! [`crate::App::access_log`] is outside every stage and app layer. It sees the finished
//! response, including a host refusal, an error-page replacement and a `304`; an app's own
//! middleware cannot write that line. It also covers routes that say `unstaged`.
//!
//! Whatever a middleware answers (a 429) leaves through 7 and 8 like a handler's answer. A header
//! it sets on a failure (a request id, `Retry-After`) stays on the error page. A middleware that
//! turns a request away answers with a [`crate::Refused`] (`Refused::too_many(wait)`,
//! `Refused::forbidden()`), answered in the request's mode as a [`crate::Caller`]'s refusal is:
//! the error page for a browser, JSON for an API or a data client, `Retry-After` on a 429 and the
//! challenge in `WWW-Authenticate` on a 401.
//!
//! ```
//! use std::time::Duration;
//! use corten::{http::{HeaderValue, IntoResponse, Request, Response}, prelude::*};
//!
//! struct RequestId;
//!
//! impl Middleware for RequestId {
//!     async fn call(&self, req: Request, next: impl Next) -> Response {
//!         let mut res = next.run(req).await;
//!         res.headers_mut().insert("x-request-id", HeaderValue::from_static("r-1"));
//!         res
//!     }
//! }
//!
//! struct RateLimit;
//!
//! impl Middleware for RateLimit {
//!     async fn call(&self, req: Request, next: impl Next) -> Response {
//!         if req.headers().contains_key("x-flood") {
//!             return Refused::too_many(Duration::from_secs(30)).into_response();
//!         }
//!         next.run(req).await
//!     }
//! }
//!
//! let app = App::new(Routes::new()).middleware((RequestId, RateLimit));
//! # let _ = app.router();
//! ```
//!
//! Middleware that belongs to part of the app is given to that part, an area or an API, and runs
//! for each request at its prefix (its routes, nested areas and APIs, an unknown URL there; not
//! a route that says `unstaged`, which meets none), never by a path compared in the middleware:
//!
//! ```
//! # use corten::{http::{IntoResponse, Request, Response}, prelude::*};
//! # struct RateLimit;
//! # impl Middleware for RateLimit {
//! #     async fn call(&self, req: Request, next: impl Next) -> Response { next.run(req).await }
//! # }
//! #[corten::routes(area = Admin)]
//! mod admin {
//!     #[route("/admin")]
//!     pub struct Admin;
//! }
//!
//! #[corten::routes(api = ApiRoot)]
//! mod api {
//!     #[route("/api")]
//!     pub struct ApiRoot;
//! }
//!
//! let app = App::new(Routes::new())
//!     .area(|area| admin::area(area).middleware(RateLimit))
//!     .api(|routes| api::api(routes).middleware(RateLimit));
//! # let _ = app.router();
//! ```
//!
//! A tower layer still goes around the whole app ([`crate::App::layer`]), outside every stage,
//! for what must see the raw request first.

use std::{future::Future, pin::Pin, sync::Arc};

use crate::http::Request;
use crate::response::{IntoResponse, Response};
pub use crate::router::MatchedPath;
use futures_util::future::Either;

/// The rest of the request after a middleware: the next middleware, then the handler.
pub trait Next: Send {
    /// Runs the rest of the request.
    fn run(self, req: Request) -> impl Future<Output = Response> + Send;
}

/// A step of the app's own in every request, or of an area's or an API's in each request at its
/// prefix, but a route's that says `unstaged`; see [`crate::middleware`]. Several are a tuple,
/// run in order: `(RequestId, RateLimit)`.
pub trait Middleware: Send + Sync + 'static {
    /// Answers the request, usually by running `next` and changing what it gives.
    fn call(&self, req: Request, next: impl Next) -> impl Future<Output = Response> + Send;
}

impl Middleware for () {
    #[inline]
    fn call(&self, req: Request, next: impl Next) -> impl Future<Output = Response> + Send {
        next.run(req)
    }
}

macro_rules! tuples {
    ($first:ident $(, $rest:ident)*) => {
        impl<$first: Middleware, $($rest: Middleware),*> Middleware for ($first, $($rest,)*) {
            #[inline]
            #[allow(non_snake_case)]
            fn call(&self, req: Request, next: impl Next) -> impl Future<Output = Response> + Send {
                let ($first, $($rest,)*) = self;
                tuples!(@chain req, next, $first $(, $rest)*)
            }
        }
    };
    (@chain $req:ident, $next:ident, $only:ident) => { $only.call($req, $next) };
    (@chain $req:ident, $next:ident, $first:ident $(, $rest:ident)+) => {
        $first.call($req, Then { middleware: ($($rest,)+), next: $next })
    };
}

tuples!(A);
tuples!(A, B);
tuples!(A, B, C);
tuples!(A, B, C, D);
tuples!(A, B, C, D, E);
tuples!(A, B, C, D, E, F);

/// The middleware after one in a tuple, then the rest.
struct Then<M, N> {
    middleware: M,
    next: N,
}

macro_rules! then {
    ($($name:ident),+) => {
        impl<'a, $($name: Middleware,)+ N: Next> Next for Then<($(&'a $name,)+), N> {
            #[inline]
            #[allow(non_snake_case)]
            fn run(self, req: Request) -> impl Future<Output = Response> + Send {
                let ($($name,)+) = self.middleware;
                <($(&'a $name,)+) as Refs>::call_refs(($($name,)+), req, self.next)
            }
        }
    };
}

/// A tuple of references to middleware, run in order.
trait Refs: Send {
    fn call_refs(self, req: Request, next: impl Next) -> impl Future<Output = Response> + Send;
}

macro_rules! refs {
    ($first:ident $(, $rest:ident)*) => {
        impl<'a, $first: Middleware, $($rest: Middleware),*> Refs for (&'a $first, $(&'a $rest,)*) {
            #[inline]
            #[allow(non_snake_case)]
            fn call_refs(self, req: Request, next: impl Next) -> impl Future<Output = Response> + Send {
                let ($first, $($rest,)*) = self;
                refs!(@chain req, next, $first $(, $rest)*)
            }
        }
    };
    (@chain $req:ident, $next:ident, $only:ident) => { $only.call($req, $next) };
    (@chain $req:ident, $next:ident, $first:ident $(, $rest:ident)+) => {
        $first.call($req, Then { middleware: ($($rest,)+), next: $next })
    };
}

/// A middleware with its type erased: an area's or an API's ([`crate::Area::middleware`],
/// [`crate::Api::middleware`]), which the request finds by its path at run time.
pub(crate) trait Erased: Send + Sync + 'static {
    fn call_boxed<'a>(&'a self, req: Request, next: Rest<'a>) -> Pin<Box<dyn Future<Output = Response> + Send + 'a>>;
}

impl<M: Middleware> Erased for M {
    fn call_boxed<'a>(&'a self, req: Request, next: Rest<'a>) -> Pin<Box<dyn Future<Output = Response> + Send + 'a>> {
        Box::pin(self.call(req, next))
    }
}

/// The middleware of some routes, in the order they run.
pub(crate) type Stack = Arc<[Arc<dyn Erased>]>;

/// What the stages give the end of their chain, past the app's middleware: the route, and their
/// own signal, which the route's answer marks as it comes back when it drew a form's new submit
/// key ([`Keyed`]). The stages hold it; each link of the chain carries a reference to it, so the
/// route goes down the chain as one pointer, not the two it is, and the signal with it.
pub(crate) struct Ends<'a> {
    pub(crate) route: Option<crate::router::Route>,
    pub(crate) signal: &'a crate::Signal,
}

/// The rest of the request after the app's middleware: the area's or API's middleware still to
/// run (none for most routes), then the route ([`Ends`]).
pub(crate) struct Rest<'a> {
    pub(crate) stack: &'a [Arc<dyn Erased>],
    pub(crate) ends: &'a Ends<'a>,
}

impl Next for Rest<'_> {
    #[inline]
    fn run(self, req: Request) -> impl Future<Output = Response> + Send {
        match self.stack.split_first() {
            Some((first, stack)) => Either::Left(first.call_boxed(req, Rest { stack, ends: self.ends })),
            None => Either::Right(handle(self.ends, req)),
        }
    }
}

/// The route alone ([`Ends`]), after the app's middleware, for a request in no area or API with
/// middleware.
pub(crate) struct Handle<'a>(pub(crate) &'a Ends<'a>);

impl Next for Handle<'_> {
    #[inline]
    fn run(self, req: Request) -> impl Future<Output = Response> + Send {
        handle(self.0, req)
    }
}

/// The route's own future, not an async block around it, which would move the request once more.
/// No route: a path under a nested API that a route outside it matched, answered with a 404 that
/// the API writes as its own, which no handler answered either, so it is marked as the router's
/// own `404` is (`crate::cache::Unshared`). The answer is read for a form's new submit key as it
/// comes back ([`Keyed`]), before any middleware sees it.
#[inline]
fn handle<'a>(ends: &'a Ends<'a>, mut req: Request) -> impl Future<Output = Response> + Send + 'a {
    // A whole document in an app with layout reads: the route's page is filled before the app's
    // middleware sees it. Looked for only in such an app, the one the stages start reads in
    // (`page::render_errors`): in any other app, the look it saves pays for the signal's below.
    let here = if ends.signal.shared().is_some_and(|shared| !shared.layout_reads.is_empty()) {
        req.extensions().get::<crate::layout::StartHere>().cloned()
    } else {
        None
    };
    // A request a middleware rebuilt, with a signal of its own or none: the signal its `Req`s
    // mark (`Req::rendered`), read as the answer comes back. The usual request carries the
    // stages' own, which `Keyed` marks.
    let theirs = if req.extensions().get::<crate::Signal>().is_some_and(|signal| signal.is(ends.signal)) {
        None
    } else {
        Some(rebuilt(&mut req))
    };
    let answer = match &ends.route {
        Some(route) => Either::Left(route.call(req)),
        // Made as it is polled, so the future holds no response while it waits: with one held
        // beside the stages' signal in `Keyed`, the stages' poll called `memcpy` four times a
        // request where main calls it once (callgrind).
        None => Either::Right(async { crate::cache::unshared(IntoResponse::into_response(http::StatusCode::NOT_FOUND)) }),
    };
    let answer =
        match (here, theirs) {
            (None, None) => Either::Left(answer),
            // Boxed, so a request in an app without layout reads carries none of the fill's state.
            (Some(here), None) => Either::Right(Box::pin(async move { here.fill(answer.await).await })
                as std::pin::Pin<Box<dyn Future<Output = Response> + Send>>),
            // Apart from the fill alone, whose future holds no signal: with one beside it there, each
            // filled request ran 63 instructions more in it (callgrind, the settle test's `fill`).
            (here, Some(theirs)) => Either::Right(Box::pin(async move {
                let mut res = answer.await;
                if let Some(here) = here {
                    res = here.fill(res).await;
                }
                // Marked as a render marks the answer it is drawn for, so `Keyed` marks the stages'
                // signal too.
                if theirs.key_drawn() {
                    crate::cache::unrepeatable(&mut res);
                }
                res
            }) as std::pin::Pin<Box<dyn Future<Output = Response> + Send>>),
        };
    Keyed { answer, signal: ends.signal }
}

/// The signal of a request a middleware rebuilt: the one it gave the request, or, for one it gave
/// none, one made here for the request's `Req`s to share ([`crate::signal::Detached`]), leaving
/// it without a `Signal` for what reads that.
#[cold]
#[inline(never)]
fn rebuilt(req: &mut Request) -> crate::Signal {
    if let Some(theirs) = req.extensions().get::<crate::Signal>() {
        return theirs.clone();
    }
    let made = crate::Signal::default();
    req.extensions_mut().insert(crate::signal::Detached(made.clone()));
    made
}

pin_project_lite::pin_project! {
    /// The route's answer (its page filled), which marks the stages' own signal ([`Ends`]) when it
    /// drew a form's new submit key (`crate::cache::Unrepeatable`, put on by the render that drew
    /// it or the watch around a `Public` handler, which marks only the answer, or by [`handle`] for
    /// a request a middleware rebuilt, from the signal its `Req`s mark: `req.rendered` marks only
    /// that one, even in an answer no watch is around, such as text). A render marks the
    /// signal its request carries too, and a middleware may have given it one it made, with no
    /// signal or another one: the stages read theirs before they settle the answer, so a middleware
    /// that then makes a new response of this one, without its extensions, takes the mark away no
    /// more than one that passed the request on as it was. The signal is the stages' by reference,
    /// not a thread's, so the mark reaches them on whatever thread the answer comes back: a
    /// middleware may poll `next`, or call it, on a scoped thread of its own (a [`Next`] and its
    /// future are `Send`). The usual answer has no extensions, so the look is a null check.
    struct Keyed<'a, F> {
        #[pin]
        answer: F,
        signal: &'a crate::Signal,
    }
}

impl<F: Future<Output = Response>> Future for Keyed<'_, F> {
    type Output = Response;

    // Always: with `#[inline]` alone the settle test's `Public` page counted 40 instructions more
    // a request, and its pages that draw a key 35 and 36 (callgrind).
    #[inline(always)]
    fn poll(self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Response> {
        let this = self.project();
        let polled = this.answer.poll(cx);
        if let std::task::Poll::Ready(res) = &polled {
            if res.extensions().get::<crate::cache::Unrepeatable>().is_some() {
                keyed(this.signal);
            }
        }
        polled
    }
}

#[cold]
#[inline(never)]
fn keyed(signal: &crate::Signal) {
    signal.mark_key_drawn();
}

refs!(A);
refs!(A, B);
refs!(A, B, C);
refs!(A, B, C, D);
refs!(A, B, C, D, E);
then!(A);
then!(A, B);
then!(A, B, C);
then!(A, B, C, D);
then!(A, B, C, D, E);
