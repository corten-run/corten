//! Corten's router: a request's path to its route ([matchit]), its method to one of the route's
//! handlers, and the request through the app's stages to it ([`crate::middleware`]), or, for a
//! route that says `unstaged`, through the few checks its lane keeps in their place
//! ([`crate::route::Lane`]). What [`crate::App::router`] gives, [`Router`], is a
//! tower `Service`, for a test or a server of the app's own.
//!
//! It answers as HTTP has a server answer, as axum's router did before it (and Corten's dispatch
//! suite, `tests/dispatch.rs`, holds it to): the path is matched as sent, before anything in it
//! is decoded, and a segment of text is chosen over a parameter; `HEAD` is the route's `GET`
//! without the body; a method the route has no handler for is a `405` whose `Allow` names those
//! it has, and one no route in the app has a handler for is a `501` (RFC 9110 9.1; axum's router
//! answered it `405`); a `HEAD` says the length its `GET` has (`Content-Length`, which the server
//! writes for any other answer from its body's size); and a `2xx` to `CONNECT` has no body,
//! `Content-Length` or `Transfer-Encoding`. A request's handler is boxed once, and so are the
//! stages around it.
//!
//! [matchit]: https://docs.rs/matchit

use std::{
    cell::Cell,
    convert::Infallible,
    future::Future,
    marker::PhantomData,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use crate::body::Body;
use crate::handler::{Handler, Request};
use crate::response::IntoResponse;
use crate::response::Response;
use http::header;
use http::uri::PathAndQuery;
use http::HeaderValue;
use http::Method;
use http::StatusCode;
use http::Uri;
use serde::de::{self, DeserializeOwned, DeserializeSeed, Deserializer, SeqAccess, Visitor};

use crate::form::FormError;
use crate::kept::Verdict;

/// A request's answer on its way: what an [`Endpoint`] and the stages give.
pub(crate) type Answering = Pin<Box<dyn Future<Output = Response> + Send>>;

/// A route's handler for one or more methods, with its state: what the router calls.
pub(crate) trait Endpoint: Send + Sync + 'static {
    fn call(&self, req: Request) -> Answering;

    fn action_patches(&self) -> bool {
        false
    }

    /// Under `corten dev`, this route with each [`Keeping`] in it the copy that says what a
    /// release build does with its answer ([`Telling`]); `None` for one with none.
    fn telling(&self) -> Option<Route> {
        None
    }
}

/// The handler the router chose for a request, which the stages call last.
pub(crate) type Route = Arc<dyn Endpoint>;

/// A handler with the state it takes.
struct Handled<H, T, S> {
    handler: H,
    state: S,
    types: PhantomData<fn() -> T>,
}

impl<H: Handler<T, S>, T: 'static, S: Clone + Send + Sync + 'static> Endpoint for Handled<H, T, S> {
    #[inline]
    fn call(&self, req: Request) -> Answering {
        Box::pin(self.handler.clone().call(req, self.state.clone()))
    }

    fn action_patches(&self) -> bool {
        H::ACTION_PATCHES
    }
}

/// An answer that is a status alone: the router's `404` and `405`. No handler answered it, so it
/// is marked so as it is made ([`crate::cache::Unshared`]): the error page in its place, and the
/// answer in any form a middleware turns it into (another status, a redirect, a body of its own),
/// are never shared. A middleware that answers with a response of its own instead has answered
/// the request itself.
struct Status(StatusCode);

impl Endpoint for Status {
    fn call(&self, _: Request) -> Answering {
        Box::pin(std::future::ready(crate::cache::unshared(self.0.into_response())))
    }
}

/// The router's `501` for a method no route in the app has, marked so the error page tells it
/// from a handler's or a middleware's own empty `501` ([`crate::Failure::UnknownMethod`]), and as
/// no handler's answer, as [`Status`] marks its own.
struct Unimplemented;

impl Endpoint for Unimplemented {
    #[cold]
    fn call(&self, _: Request) -> Answering {
        let mut res = crate::cache::unshared(StatusCode::NOT_IMPLEMENTED.into_response());
        res.extensions_mut().insert(crate::page::Cause::UnknownMethod);
        Box::pin(std::future::ready(res))
    }
}

/// A page route's handler that gives some of the layout's reads itself (`gives(CartCount)`): the
/// request is marked with them, for [`crate::layout`] to leave unstarted.
struct Giving {
    gives: &'static [fn() -> std::any::TypeId],
    inner: Route,
}

impl Endpoint for Giving {
    #[inline]
    fn call(&self, mut req: Request) -> Answering {
        req.extensions_mut().insert(crate::layout::Gives(self.gives));
        self.inner.call(req)
    }

    fn action_patches(&self) -> bool {
        self.inner.action_patches()
    }

    fn telling(&self) -> Option<Route> {
        let inner = self.inner.telling()?;
        Some(Arc::new(Giving { gives: self.gives, inner }))
    }
}

/// A handler whose answer is the same for everyone (`Public`), a page or a whole body: a kept
/// answer is given in its place, and the one it makes is kept ([`crate::kept`]). A page is filled
/// here, as [`crate::middleware`] would after it, so what is kept is the page as it leaves the
/// route. `TELL` is `corten dev`'s copy ([`Telling`]), which keeps nothing and records what a
/// release build does with the answer; a release build's, with `TELL` false, is the code it was.
struct Keeping<const TELL: bool> {
    shape: crate::kept::Shape,
    /// Of a route of whole bodies: whether any of the answers it made last was kept.
    unkept: Option<Arc<crate::kept::Unkept>>,
    inner: Route,
}

impl<const TELL: bool> Endpoint for Keeping<TELL> {
    #[inline]
    fn call(&self, req: Request) -> Answering {
        // A route none of whose bodies is kept (each too small, most often) is its handler's, as
        // it was before the app kept bodies.
        if self.unkept.as_ref().is_some_and(|route| route.leaves()) {
            return self.inner.call(req);
        }
        // Any other request (a navigation, one with a cookie, a write) is the handler's as before.
        let Some(asked) = crate::kept::Asked::of(&req, self.shape) else { return self.inner.call(req) };
        if let Some(kept) = asked.find() {
            if let Some(route) = &self.unkept {
                route.found();
            }
            return Box::pin(std::future::ready(kept));
        }
        // In a full store a URL not asked for before is the handler's as any other request.
        let Some(missed) = asked.missed(&req, self.unkept.clone()) else { return self.inner.call(req) };
        let here = req.extensions().get::<crate::layout::StartHere>().cloned();
        // Under `corten dev`, a future of its own with the same return before `Missed::keep`, so
        // what it says of a drawn key is what a release build does, and the release build's future
        // is left as it is (`tests/router_cost.rs`). The mark it reads is the one the release
        // build reads (below).
        if TELL {
            let answer = self.inner.call(req);
            return Box::pin(async move {
                let res = answer.await;
                let res = match here {
                    Some(here) => here.fill(res).await,
                    None => res,
                };
                if res.extensions().get::<crate::cache::Unrepeatable>().is_some() {
                    missed.drew_key();
                    return res;
                }
                missed.keep::<true>(res).await
            });
        }
        let answer = self.inner.call(req);
        Box::pin(async move {
            let res = answer.await;
            let res = match here {
                Some(here) => here.fill(res).await,
                None => res,
            };
            // An answer with a form's new submit key is this request's alone: marked by the
            // render that drew it (a page's, the layout's reads') or by the watch the handler of
            // every route whose answer may be `Public` runs under (`answer::Made`), which sees one
            // rendered any other way. A key `req.rendered` renders on a thread the watch does not
            // poll (a blocking task) marks only the request's signal, which `Missed::keep` reads
            // before it keeps anything; a bare `to_html()` there marks neither.
            if res.extensions().get::<crate::cache::Unrepeatable>().is_some() {
                return res;
            }
            missed.keep::<false>(res).await
        })
    }

    fn action_patches(&self) -> bool {
        self.inner.action_patches()
    }

    fn telling(&self) -> Option<Route> {
        let (shape, unkept, inner) = (self.shape, self.unkept.clone(), self.inner.clone());
        Some(Arc::new(Keeping::<true> { shape, unkept, inner }))
    }
}

/// Under `corten dev`, a `Public` handler with what goes around it ([`Table::telling`]): says in the
/// log whether a release build would keep its answer to a `GET` while its store has room, and if
/// not the first reason, as the code that decides it found it ([`Verdict`]), once for each verdict
/// the route has. Nothing is kept under `corten dev`, so this is where an author learns it; a
/// release build has none. The route's [`Keeping`] is its `corten dev` copy, which finds the
/// verdict of the answer.
struct Telling {
    /// What the route's answer is kept as, or why it never is, known when the route was made.
    public: Result<crate::kept::Shape, Verdict>,
    /// The verdicts it has said, a bit each ([`Verdict::tell`]).
    told: Arc<std::sync::atomic::AtomicU32>,
    inner: Route,
}

impl Endpoint for Telling {
    fn call(&self, req: Request) -> Answering {
        // A `HEAD` or a write is not kept, whatever its route.
        if *req.method() != Method::GET {
            return self.inner.call(req);
        }
        let path = req.uri().path().to_owned();
        let signal = req.extensions().get::<crate::Signal>().cloned();
        // What the request decides, read as the route's `Keeping` reads it: a reason the author can
        // change (an app that keeps none, a caller read for it, its URL changed), or one for the
        // request alone, not said.
        let asked = match (self.public, &signal) {
            (Ok(shape), Some(_)) => crate::kept::Asked::checked::<true>(&req, shape).map(|_| ()),
            _ => Ok(()),
        };
        let (public, told) = (self.public, self.told.clone());
        let answer = self.inner.call(req);
        Box::pin(async move {
            // A drawn submit key, and each refusal of the answer, the route's `Keeping` found
            // where a release build's does.
            let res = answer.await;
            let verdict = match (public, &signal, asked) {
                (Err(unkept), _, _) => Some(unkept),
                // An unstaged route's request has no signal, and no answer kept for it.
                (_, None, _) => Some(Verdict::Unstaged),
                (_, Some(_), Err(said)) => said,
                (_, Some(signal), Ok(())) => Verdict::of(signal),
            };
            match (verdict, &signal) {
                (Some(verdict), _) => {
                    verdict.tell(&path, &told);
                    res
                }
                // One a release build would keep: what becomes of its body as it is read here is said.
                (None, Some(signal)) => crate::kept::tell_read(res, signal, move |verdict| verdict.tell(&path, &told)),
                (None, None) => res,
            }
        })
    }

    fn action_patches(&self) -> bool {
        self.inner.action_patches()
    }
}

/// A page's `POST` handler when it has named posts (`post(hold) = ..`): the one the `do` of the
/// post's address names, or its plain `post` for a post that names none. Only the query is read,
/// so the body, a multipart upload's too, is still the chosen handler's to read, under its limit.
/// A name the page has no post for, a post that names none where the page has no plain `post`,
/// and a post that names two are a `400`: the address is the app's own, so the request is at
/// fault, and no other handler is tried in its place. No handler answers that `400`, so it is
/// marked as the router's own `404` is ([`Status`]).
struct Chooser {
    plain: Option<Route>,
    actions: Box<[(&'static str, Route)]>,
    patches: bool,
}

impl Endpoint for Chooser {
    #[inline]
    fn call(&self, req: Request) -> Answering {
        let chosen = match named(req.uri().query()) {
            Named::None => self.plain.as_ref(),
            Named::One(name) => self.actions.iter().find(|(own, _)| *own == name.as_ref()).map(|(_, route)| route),
            Named::Twice => None,
        };
        match chosen {
            Some(route) => route.call(req),
            None => self.refuse(req.uri().query()),
        }
    }

    fn action_patches(&self) -> bool {
        self.patches
    }
}

impl Chooser {
    fn new(plain: Option<Route>, actions: Box<[(&'static str, Route)]>) -> Self {
        // A mixed chooser stays eligible without reading the query before dispatch.
        let patches = plain.iter().chain(actions.iter().map(|(_, route)| route)).all(|route| route.action_patches());
        Self { plain, actions, patches }
    }

    /// The `400` for a post no handler of the page's is for, its text written for a developer
    /// (the error page shows it under `corten dev`).
    #[cold]
    fn refuse(&self, query: Option<&str>) -> Answering {
        let names = self.actions.iter().map(|(name, _)| *name).collect::<Vec<_>>().join(", ");
        let message = match named(query) {
            Named::None => format!("this post names none of the page's posts ({names}) in its address's do, and the page has no post = .. for one that names none"),
            Named::One(name) => format!("the page has no post named {name:?} (do={name}); its posts are {names}"),
            Named::Twice => format!("this post's address names do twice; it names one of the page's posts ({names})"),
        };
        Box::pin(std::future::ready(crate::cache::unshared((StatusCode::BAD_REQUEST, message).into_response())))
    }
}

/// A debug build's mark on a request to a route with named posts, which [`crate::page::Req`]
/// reads to check the page it draws at one of their addresses.
#[cfg(debug_assertions)]
#[derive(Clone, Copy)]
pub(crate) struct HasPosts;

/// A route's handler for a method, marking its request [`HasPosts`] (a debug build's).
#[cfg(debug_assertions)]
struct Posts {
    inner: Route,
}

#[cfg(debug_assertions)]
impl Endpoint for Posts {
    fn call(&self, mut req: Request) -> Answering {
        req.extensions_mut().insert(HasPosts);
        self.inner.call(req)
    }

    fn action_patches(&self) -> bool {
        self.inner.action_patches()
    }
}

/// What a post's address names in its `do`.
pub(crate) enum Named<'q> {
    None,
    One(std::borrow::Cow<'q, str>),
    Twice,
}

/// The `do` of `query`, its key and value percent-decoded as `Params` reads the query's other
/// keys, so an address names the same post however it is spelled (`%64o=price` is `do=price`). A
/// browser sends a post's name, a Rust identifier, as it is written, so decoding is only for a
/// pair with a `%` in it.
#[inline]
pub(crate) fn named(query: Option<&str>) -> Named<'_> {
    use std::borrow::Cow;
    let decode = |text| percent_encoding::percent_decode_str(text).decode_utf8_lossy();
    let mut found = Named::None;
    for pair in query.unwrap_or("").split('&') {
        // A key that decodes to `do` starts with its `d` or an escape.
        if !matches!(pair.as_bytes().first(), Some(b'd' | b'%')) {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key != crate::route::ACTION_KEY && !(key.contains('%') && decode(key) == crate::route::ACTION_KEY) {
            continue;
        }
        if !matches!(found, Named::None) {
            return Named::Twice;
        }
        found = Named::One(if value.contains('%') { decode(value) } else { Cow::Borrowed(value) });
    }
    found
}

/// A handler for some methods, waiting for its state (`S`) or with it, and, of a `Public` one,
/// what `corten dev` says of it ([`Telling`]).
struct Slot<S> {
    held: Held<S>,
    /// Of a `Public` handler: what its answer is kept as, or why a release build never keeps it,
    /// known when the route is made (`crate::handler::Handler::public`).
    public: Option<Result<crate::kept::Shape, Verdict>>,
}

enum Held<S> {
    Unbound(Arc<dyn Fn(S) -> Route + Send + Sync>),
    Bound(Route),
}

impl<S> Clone for Slot<S> {
    fn clone(&self) -> Self {
        let held = match &self.held {
            Held::Unbound(make) => Held::Unbound(make.clone()),
            Held::Bound(route) => Held::Bound(route.clone()),
        };
        Slot { held, public: self.public }
    }
}

impl<S: Clone + Send + Sync + 'static> Slot<S> {
    fn handler<H: Handler<T, S>, T: 'static>(handler: H) -> Self {
        // Known when the route is made, so no other route's requests ask.
        let keeps = handler.keeps();
        let public = handler.public();
        let held = Held::Unbound(Arc::new(move |state| {
            let handled: Route = Arc::new(Handled { handler: handler.clone(), state, types: PhantomData });
            match keeps {
                Some(shape) => {
                    let unkept = (shape == crate::kept::Shape::Body).then(Default::default);
                    Arc::new(Keeping::<false> { shape, unkept, inner: handled })
                }
                None => handled,
            }
        }));
        Slot { held, public }
    }

    fn bind<S2>(self, state: &S) -> Slot<S2> {
        let held = match self.held {
            Held::Unbound(make) => Held::Bound(make(state.clone())),
            Held::Bound(route) => Held::Bound(route),
        };
        Slot { held, public: self.public }
    }

    fn gives(self, gives: &'static [fn() -> std::any::TypeId]) -> Self {
        let held = match self.held {
            Held::Unbound(make) => Held::Unbound(Arc::new(move |state| Arc::new(Giving { gives, inner: make(state) }))),
            Held::Bound(inner) => Held::Bound(Arc::new(Giving { gives, inner })),
        };
        Slot { held, public: self.public }
    }

    /// Under `corten dev`: a `Public` handler's requests through [`Telling`], outside all else
    /// that goes around it.
    fn telling(self) -> Self {
        let Some(public) = self.public else { return self };
        let told = Arc::<std::sync::atomic::AtomicU32>::default();
        // Its `Keeping`, if any, the copy that finds what a release build does with its answer.
        let tell = |route: Route| route.telling().unwrap_or(route);
        let held = match self.held {
            Held::Unbound(make) => Held::Unbound(Arc::new(move |state| {
                Arc::new(Telling { public, told: told.clone(), inner: tell(make(state)) }) as Route
            })),
            Held::Bound(inner) => Held::Bound(Arc::new(Telling { public, told, inner: tell(inner) })),
        };
        // Told once: the slot is not wrapped again.
        Slot { held, public: None }
    }
}

impl Slot<()> {
    fn route(self) -> Route {
        match self.held {
            Held::Unbound(make) => make(()),
            Held::Bound(route) => route,
        }
    }
}

// The methods a route has a handler of its own for, where each one's handler is (`HEAD` is tried
// at `HEAD`, then at `GET`).
const GET: usize = 0;
const HEAD: usize = 1;
const POST: usize = 2;
const PUT: usize = 3;
const DELETE: usize = 4;
const PATCH: usize = 5;
const OPTIONS: usize = 6;
const TRACE: usize = 7;
const CONNECT: usize = 8;
const NAMES: [&str; 9] = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "CONNECT"];

/// Where `method`'s handler is, for a method a route can name.
#[inline]
fn slot_of(method: &Method) -> Option<usize> {
    Some(match *method {
        Method::GET => GET,
        Method::HEAD => HEAD,
        Method::POST => POST,
        Method::PUT => PUT,
        Method::DELETE => DELETE,
        Method::PATCH => PATCH,
        Method::OPTIONS => OPTIONS,
        Method::TRACE => TRACE,
        Method::CONNECT => CONNECT,
        _ => return None,
    })
}

/// The methods some route in the app has a handler for, which a route without one answers with
/// its `405`; any other is a `501` (RFC 9110 9.1: the server implements it for no resource).
/// `GET` and `HEAD`, which every server implements (9.1), and `OPTIONS`, whose caller asks what a
/// resource allows and gets it from the `405`'s `Allow`, are always among them; a route that
/// takes every method (`any`) puts every method among them.
#[derive(Clone, Copy)]
struct Known {
    slots: u16,
    every: bool,
}

impl Known {
    fn of<'a>(routes: impl Iterator<Item = &'a Entry>) -> Self {
        let mut known = Known { slots: 1 << GET | 1 << HEAD | 1 << OPTIONS, every: false };
        for entry in routes {
            for (at, slot) in entry.slots.iter().enumerate() {
                if slot.is_some() {
                    known.slots |= 1 << at;
                }
            }
            known.every |= entry.fallback.is_some();
        }
        known
    }

    fn has(self, method: &Method) -> bool {
        self.every || slot_of(method).is_some_and(|at| self.slots & 1 << at != 0)
    }
}

/// What a route's `405` says it allows.
#[derive(Clone)]
enum Allow {
    /// The methods it has handlers for, in the order they were given (`GET` with `HEAD`).
    Methods(Vec<&'static str>),
    /// Nothing: its handler takes every method (`any`).
    Any,
}

/// A route's handlers, one for each method it has and one for any other (`any`, which
/// [`Known`] reads as taking every method), with the state they take (`S`) still to give or
/// given: what [`crate::Methods`] holds.
pub(crate) struct MethodSet<S = ()> {
    slots: [Option<Slot<S>>; 9],
    fallback: Option<Slot<S>>,
    allow: Allow,
    /// The page's named posts (`post(hold) = ..`), each chosen by the `do` of the post's
    /// address ([`Chooser`]).
    actions: Vec<(&'static str, Slot<S>)>,
    /// One of its handlers answers with a page or a body the app keeps (`Public`, [`Keeping`]).
    keeps: bool,
}

impl<S> Clone for MethodSet<S> {
    fn clone(&self) -> Self {
        MethodSet {
            slots: self.slots.clone(),
            fallback: self.fallback.clone(),
            allow: self.allow.clone(),
            actions: self.actions.clone(),
            keeps: self.keeps,
        }
    }
}

impl<S> Default for MethodSet<S> {
    fn default() -> Self {
        MethodSet {
            slots: std::array::from_fn(|_| None),
            fallback: None,
            allow: Allow::Methods(Vec::new()),
            actions: Vec::new(),
            keeps: false,
        }
    }
}

impl<S: Clone + Send + Sync + 'static> MethodSet<S> {
    fn on<H: Handler<T, S>, T: 'static>(mut self, at: usize, handler: H) -> Self {
        assert!(self.slots[at].is_none(), "corten: a route has two handlers for {}", NAMES[at]);
        self.keeps |= handler.keeps().is_some();
        self.slots[at] = Some(Slot::handler(handler));
        let names: &[&'static str] = if at == GET { &["GET", "HEAD"] } else { &NAMES[at..=at] };
        if let Allow::Methods(allowed) = &mut self.allow {
            for name in names {
                if !allowed.contains(name) {
                    allowed.push(name);
                }
            }
        }
        self
    }

    /// The handler for every method the route has none of its own for, in place of its `405`
    /// (its answer still says, in `Allow`, the methods the route has).
    pub(crate) fn fallback<H: Handler<T, S>, T: 'static>(mut self, handler: H) -> Self {
        assert!(self.fallback.is_none(), "corten: a route has two handlers for any method");
        self.keeps |= handler.keeps().is_some();
        self.fallback = Some(Slot::handler(handler));
        self
    }

    /// Its `POST` handler as the page's post `name`, which a post whose `do` is `name` reaches.
    /// The route still allows `POST`.
    pub(crate) fn named(mut self, name: &'static str) -> Self {
        let slot = self.slots[POST].take().expect("corten: a named post is a post handler");
        assert!(!self.actions.iter().any(|(own, _)| *own == name), "corten: a route has two handlers for the action {name}");
        self.actions.push((name, slot));
        self
    }

    /// The handlers of both, which have none for the same method.
    pub(crate) fn merge(mut self, other: MethodSet<S>) -> Self {
        self.keeps |= other.keeps;
        for (at, (mine, theirs)) in self.slots.iter_mut().zip(other.slots).enumerate() {
            if theirs.is_some() {
                assert!(mine.is_none(), "corten: a route has two handlers for {}", NAMES[at]);
                *mine = theirs;
            }
        }
        if other.fallback.is_some() {
            assert!(self.fallback.is_none(), "corten: a route has two handlers for any method");
            self.fallback = other.fallback;
        }
        for (name, slot) in other.actions {
            assert!(!self.actions.iter().any(|(own, _)| *own == name), "corten: a route has two handlers for the action {name}");
            self.actions.push((name, slot));
        }
        self.allow = match (self.allow, other.allow) {
            (Allow::Any, _) | (_, Allow::Any) => Allow::Any,
            (Allow::Methods(mut mine), Allow::Methods(theirs)) => {
                for name in theirs {
                    if !mine.contains(&name) {
                        mine.push(name);
                    }
                }
                Allow::Methods(mine)
            }
        };
        self
    }

    /// The handlers with the state they take, for a router without it.
    pub(crate) fn with_state<S2>(self, state: S) -> MethodSet<S2> {
        MethodSet {
            slots: self.slots.map(|slot| slot.map(|slot| slot.bind(&state))),
            fallback: self.fallback.map(|slot| slot.bind(&state)),
            allow: self.allow,
            actions: self.actions.into_iter().map(|(name, slot)| (name, slot.bind(&state))).collect(),
            keeps: self.keeps,
        }
    }

    /// Under `corten dev`: each `Public` handler's requests through [`Telling`]. A page's named
    /// posts are writes, which are never kept.
    fn telling(self) -> Self {
        MethodSet { slots: self.slots.map(|slot| slot.map(Slot::telling)), fallback: self.fallback.map(Slot::telling), ..self }
    }

    /// Each handler marking its request with the layout reads it gives itself.
    pub(crate) fn gives(self, gives: &'static [fn() -> std::any::TypeId]) -> Self {
        MethodSet {
            slots: self.slots.map(|slot| slot.map(|slot| slot.gives(gives))),
            fallback: self.fallback.map(|slot| slot.gives(gives)),
            allow: self.allow,
            actions: self.actions.into_iter().map(|(name, slot)| (name, slot.gives(gives))).collect(),
            keeps: self.keeps,
        }
    }
}

macro_rules! methods {
    ($($method:ident => $at:ident),*) => {
        $(
            /// A route's handler for this method, checked for nothing but being a handler (Corten's
            /// own routes and the tests'; an app's go through [`crate::route::get`] and the others).
            #[inline]
            pub(crate) fn $method<H: Handler<T, S>, T: 'static, S: Clone + Send + Sync + 'static>(handler: H) -> MethodSet<S> {
                MethodSet::default().on($at, handler)
            }
        )*

        #[allow(dead_code)]
        impl<S: Clone + Send + Sync + 'static> MethodSet<S> {
            $(
                /// This route's handler for this method too.
                #[inline]
                pub(crate) fn $method<H: Handler<T, S>, T: 'static>(self, handler: H) -> Self {
                    self.on($at, handler)
                }
            )*
        }
    };
}
methods!(get => GET, head => HEAD, post => POST, put => PUT, delete => DELETE, patch => PATCH, options => OPTIONS, trace => TRACE);

/// A route's handler for every method, those a route never names included; its answers say no
/// `Allow`.
#[inline]
pub(crate) fn any<H: Handler<T, S>, T: 'static, S: Clone + Send + Sync + 'static>(handler: H) -> MethodSet<S> {
    MethodSet { allow: Allow::Any, ..MethodSet::default() }.fallback(handler)
}

/// Routes being gathered for an app (its own, its areas', its APIs', Corten's), each path with its
/// handlers: what [`Router::new`] serves once they are all in.
pub(crate) struct Table<S = ()> {
    routes: Vec<Placed<S>>,
}

impl<S> Clone for Table<S> {
    fn clone(&self) -> Self {
        Table { routes: self.routes.clone() }
    }
}

struct Placed<S> {
    path: Arc<str>,
    methods: MethodSet<S>,
    /// The path as written when text follows a parameter (`/feeds/{name}.xml` at
    /// `/feeds/{name}`): a request whose segment does not end in it is a `404`.
    written: Option<&'static str>,
    through: Through,
}

impl<S> Clone for Placed<S> {
    fn clone(&self) -> Self {
        Placed { path: self.path.clone(), methods: self.methods.clone(), written: self.written, through: self.through.clone() }
    }
}

/// What a route's requests go through on the way to its handler, its `404`, its `405` and the
/// router's `501` at its path.
#[derive(Clone)]
enum Through {
    /// The app's stages, given to [`Router::new`].
    App,
    /// Its lane in their place: a route that says `unstaged`, which keeps the host check and
    /// the few headers every answer needs ([`crate::route::Lane`]).
    Lane(Arc<crate::route::Lane>),
}

impl<S> Default for Table<S> {
    fn default() -> Self {
        Table { routes: Vec::new() }
    }
}

impl<S: Clone + Send + Sync + 'static> Table<S> {
    pub(crate) fn new() -> Self {
        Table::default()
    }

    /// `methods` at `path`, beside the handlers already there for other methods.
    pub(crate) fn route(self, path: &str, methods: MethodSet<S>) -> Self {
        self.place(path, methods, None, Through::App)
    }

    /// `methods` at `path`, written `written` (text after some parameters): a request whose
    /// segment lacks the text is a `404`, whatever its method, once the route is matched.
    pub(crate) fn written(self, path: &str, written: &'static str, methods: MethodSet<S>) -> Self {
        self.place(path, methods, (written != path).then_some(written), Through::App)
    }

    /// `methods` at `path`, written `written`, going through `lane` in place of the app's stages
    /// (a route that says `unstaged`): its handler's answer, its `404` for a segment without the
    /// text after a parameter, its `405` and the router's `501` at its path all meet it.
    pub(crate) fn unstaged(
        self,
        path: &str,
        written: &'static str,
        methods: MethodSet<S>,
        lane: Arc<crate::route::Lane>,
    ) -> Self {
        self.place(path, methods, (written != path).then_some(written), Through::Lane(lane))
    }

    fn place(mut self, path: &str, methods: MethodSet<S>, written: Option<&'static str>, through: Through) -> Self {
        match self.routes.iter_mut().find(|placed| *placed.path == *path) {
            Some(placed) => {
                // An unstaged path is routed once (`App::router` refuses one routed again), so
                // two lanes never meet at one path.
                match (&placed.through, &through) {
                    (Through::App, Through::App) => {}
                    (Through::Lane(mine), Through::Lane(theirs)) => {
                        assert!(Arc::ptr_eq(mine, theirs), "corten: the unstaged route {path:?} is routed twice")
                    }
                    _ => panic!("corten: the route {path:?} is routed both unstaged and through the stages"),
                }
                placed.methods = std::mem::take(&mut placed.methods).merge(methods);
                placed.written = placed.written.or(written);
            }
            None => self.routes.push(Placed { path: path.into(), methods, written, through }),
        }
        self
    }

    /// Both tables' routes, the handlers of a path in both together.
    pub(crate) fn merge(mut self, other: Table<S>) -> Self {
        for Placed { path, methods, written, through } in other.routes {
            self = self.place(&path, methods, written, through);
        }
        self
    }

    /// Whether a route's answer is one the app keeps (`Public`: a page or a whole body): an app
    /// with none has nothing a write could drop, so it counts no writes ([`crate::kept`]).
    pub(crate) fn keeps(&self) -> bool {
        self.routes.iter().any(|placed| placed.methods.keeps)
    }

    /// Under `corten dev`: each `Public` handler's requests through [`Telling`], which says what a
    /// release build does with its answer.
    pub(crate) fn telling(self) -> Self {
        let routes = self.routes.into_iter().map(|placed| Placed { methods: placed.methods.telling(), ..placed });
        Table { routes: routes.collect() }
    }

    /// The routes with the state their handlers take.
    #[allow(dead_code)]
    pub(crate) fn with_state<S2>(self, state: S) -> Table<S2> {
        let routes = self.routes.into_iter().map(|placed| Placed {
            path: placed.path,
            methods: placed.methods.with_state(state.clone()),
            written: placed.written,
            through: placed.through,
        });
        Table { routes: routes.collect() }
    }
}

/// What goes around a request's route: the app's stages ([`crate::middleware`]'s order), made
/// by [`crate::App::router`] with what the area or API each route is in sets, or an unstaged
/// route's lane ([`crate::route::Lane`]) in their place.
pub(crate) trait Stages: Send + Sync + 'static {
    /// The request through the stages, `route` last.
    fn run(self: Arc<Self>, req: Request, route: &Route) -> Answering;
}

/// The finished app: its routes, Corten's own, the stages around them and the app's
/// [layers](crate::App::layer), as [`crate::App::router`] makes it. A tower `Service`, cloned
/// cheaply, for a test that sends what [`crate::App::test`]'s client does not or a server of the
/// app's own; [`crate::serve`] serves it itself. Its answer says its length in its body's
/// `size_hint`, which the server writes as `Content-Length`; only a `HEAD`'s, whose body is
/// dropped, carries the header from here.
#[derive(Clone)]
pub struct Router {
    inner: Inner,
    /// Whether this is the router a server calls, outside every layer: it alone empties a `HEAD`'s
    /// body and says its length, after the layers have had the answer, as axum's did.
    edge: bool,
}

#[derive(Clone)]
enum Inner {
    Routes(Arc<Dispatch>),
    /// A tower layer of the app's around the routes ([`crate::App::layer`]).
    Layered(Arc<dyn Outer>),
}

impl std::fmt::Debug for Router {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Router").finish_non_exhaustive()
    }
}

struct Dispatch {
    paths: matchit::Router<usize>,
    routes: Vec<Entry>,
    /// The app's stages for an unknown URL's `404`, and for a route given none of its own.
    stages: Option<Arc<dyn Stages>>,
    not_found: Route,
    not_allowed: Route,
    /// A method no route in the app has a handler for (`PROPFIND` with no `any` route): `501`.
    not_implemented: Route,
    known: Known,
}

/// A path's handlers, ready to answer.
struct Entry {
    path: Arc<str>,
    slots: [Option<Route>; 9],
    fallback: Option<Route>,
    /// What its `405` (or its `fallback`'s answer) says it allows; nothing for `any`.
    allow: Option<HeaderValue>,
    written: Option<&'static str>,
    /// The stages its requests go through: the app's, with what the area or API it is in sets,
    /// or its lane in their place.
    stages: Option<Arc<dyn Stages>>,
}

impl Entry {
    /// The handler for `method`, and the `Allow` its answer gets when it is not one of the
    /// route's own methods.
    #[inline]
    fn pick<'a>(&'a self, method: &Method, dispatch: &'a Dispatch) -> (&'a Route, Option<&'a HeaderValue>) {
        let own = match *method {
            Method::HEAD => self.slots[HEAD].as_ref().or(self.slots[GET].as_ref()),
            _ => slot_of(method).and_then(|at| self.slots[at].as_ref()),
        };
        match own {
            Some(route) => (route, None),
            None => match &self.fallback {
                Some(fallback) => (fallback, self.allow.as_ref()),
                None => dispatch.refuse(method, self.allow.as_ref()),
            },
        }
    }
}

impl Router {
    /// `table`'s routes, each through the stages `at` gives for its path, or `stages` where it
    /// gives none (and an unknown URL too, a `404`), unless it has a lane of its own. A path the
    /// router cannot hold beside another (`/a/{x}` beside `/a/{y}`) stops the app, naming it.
    pub(crate) fn new(table: Table, stages: Option<Arc<dyn Stages>>, at: impl Fn(&str) -> Option<Arc<dyn Stages>>) -> Self {
        let mut paths = matchit::Router::new();
        let mut routes = Vec::with_capacity(table.routes.len());
        for Placed { path, methods, written, through } in table.routes {
            if let Err(error) = paths.insert(&*path, routes.len()) {
                panic!("corten: the route {path:?} cannot be routed beside the app's others: {error}");
            }
            let allow = match methods.allow {
                Allow::Any => None,
                Allow::Methods(names) => Some(HeaderValue::from_str(&names.join(",")).expect("method names are header text")),
            };
            let around = match through {
                Through::App => at(&path).or_else(|| stages.clone()),
                Through::Lane(lane) => Some(lane as Arc<dyn Stages>),
            };
            let mut slots = methods.slots.map(|slot| slot.map(Slot::route));
            // A page's named posts: its `POST` handler chooses among them by the post's `do`, so
            // no other request, and no post to a route without them, reads its query.
            if !methods.actions.is_empty() {
                let actions = methods.actions.into_iter().map(|(name, slot)| (name, slot.route())).collect();
                slots[POST] = Some(Arc::new(Chooser::new(slots[POST].take(), actions)));
                // A debug build marks the route's requests, so only a page of a route with named
                // posts is checked for a post form that would send to one again (`Req`).
                #[cfg(debug_assertions)]
                {
                    slots = slots.map(|slot| slot.map(|inner| Arc::new(Posts { inner }) as Route));
                }
            }
            routes.push(Entry { path, slots, fallback: methods.fallback.map(Slot::route), allow, written, stages: around });
        }
        let not_found: Route = Arc::new(Status(StatusCode::NOT_FOUND));
        let not_allowed: Route = Arc::new(Status(StatusCode::METHOD_NOT_ALLOWED));
        let not_implemented: Route = Arc::new(Unimplemented);
        let known = Known::of(routes.iter());
        let dispatch = Dispatch { paths, routes, stages, not_found, not_allowed, not_implemented, known };
        Router { inner: Inner::Routes(Arc::new(dispatch)), edge: true }
    }

    /// A logging app with tower layers carries its matched name out through those layers.
    pub(crate) fn record_route(self, names: Names) -> Self {
        let inner = Router { edge: false, ..self };
        Router { inner: Inner::Layered(Arc::new(Recording { inner, names })), edge: true }
    }

    /// The names an access line gives the routes: what each is written as, sharing the router's
    /// copy. `foreign` says which routes an API's prefix may take a request from
    /// ([`Names::of`]); `scopes` decides it for each request.
    pub(crate) fn access_names(&self, scopes: Arc<crate::app::Scopes>, foreign: impl Fn(&str) -> bool) -> Names {
        let Inner::Routes(dispatch) = &self.inner else { unreachable!("called before app layers") };
        let mut paths = matchit::Router::new();
        for entry in &dispatch.routes {
            let named = AccessName {
                route: entry.written.map_or_else(|| entry.path.clone(), Arc::from),
                pattern: entry.path.clone(),
                written: entry.written,
                foreign: foreign(entry.path.as_ref()),
            };
            paths.insert(entry.path.as_ref(), named).expect("router paths were already validated");
        }
        Names { paths, scopes }
    }

    /// Outside the final HTTP fix as well as every app layer. Reuses the optional outer-service
    /// path, leaving a disabled app's future and its response untouched. `names` is `None` when
    /// [`Router::record_route`] names the route inside the app's layers.
    pub(crate) fn access_log(self, names: Option<Names>) -> Self {
        Router { inner: Inner::Layered(Arc::new(AccessRouter { inner: self, names })), edge: false }
    }

    /// This router inside `layer` ([`crate::App::layer`]).
    pub(crate) fn layer<L>(self, layer: L) -> Router
    where
        L: tower_layer::Layer<Router>,
        L::Service: tower_service::Service<Request> + Clone + Send + Sync + 'static,
        <L::Service as tower_service::Service<Request>>::Response: IntoResponse + 'static,
        <L::Service as tower_service::Service<Request>>::Error: Into<Infallible> + 'static,
        <L::Service as tower_service::Service<Request>>::Future: Send + 'static,
    {
        let inside = Router { edge: false, ..self };
        Router { inner: Inner::Layered(Arc::new(Around(layer.layer(inside)))), edge: true }
    }

    #[inline]
    fn answer(&self, req: Request) -> RouterFuture {
        match &self.inner {
            Inner::Routes(dispatch) => dispatch.answer(req, self.edge),
            Inner::Layered(outer) => {
                let fix = self.edge.then(|| Fix::of(req.method(), true));
                RouterFuture { answering: outer.call(req), fix }
            }
        }
    }
}

/// A test's routes served as they are, with no stage around them.
#[cfg(test)]
impl From<Table> for Router {
    fn from(table: Table) -> Router {
        Router::new(table, None, |_| None)
    }
}

impl Dispatch {
    #[inline]
    fn answer(&self, mut req: Request, edge: bool) -> RouterFuture {
        let mut fix = Fix::of(req.method(), edge);
        let path = req.uri().path();
        let (route, allow, stages, matched) = match self.paths.at(path) {
            Ok(found) => {
                let entry = &self.routes[*found.value];
                let matched = MatchedPath::new(&entry.path, req.uri(), &found.params);
                // A segment without the text the route writes after its parameter is not the
                // route's, whatever the method; no other route answers it either.
                let (route, allow) = match entry.written {
                    Some(written) if !crate::route::routes_path(written, path) => (&self.not_found, None),
                    _ => entry.pick(req.method(), self),
                };
                (route, allow, entry.stages.as_ref(), Some(matched))
            }
            Err(_) => (&self.not_found, None, self.stages.as_ref(), None),
        };
        fix.allow = allow.cloned();
        if let Some(matched) = matched {
            req.extensions_mut().insert(matched);
        }
        let answering = match stages {
            Some(stages) => stages.clone().run(req, route),
            None => route.call(req),
        };
        RouterFuture { answering, fix: Some(fix) }
    }

    /// The answer to a method the route has no handler for: its `405`, with its `Allow`, when some
    /// route in the app has one for it, and a `501` with no `Allow` when none has (RFC 9110 9.1
    /// and 15.6.2: no resource here supports it, so the `Allow` of this one is not the answer).
    #[cold]
    fn refuse<'a>(&'a self, method: &Method, allow: Option<&'a HeaderValue>) -> (&'a Route, Option<&'a HeaderValue>) {
        if self.known.has(method) {
            (&self.not_allowed, allow)
        } else {
            (&self.not_implemented, None)
        }
    }
}

/// What the router does to every answer on its way out, as HTTP has it: a `405`'s `Allow`; and,
/// outside every layer, no body for a `HEAD`, which keeps the length its `GET` would say when
/// the body's is known, nor for a `2xx` to `CONNECT`, which loses its `Content-Length` and
/// `Transfer-Encoding` too.
///
/// The length of any other answer is left to the server, which writes it from the body's exact
/// size into the head it sends (hyper 1.12's HTTP/1 encoder, `content-length: 0` included where
/// a status may have one). Setting the header here as well made the value in two allocations
/// and put it in the map for the encoder to find again, 803 instructions a request on the lean
/// catalog page (docs/design.md#choice-axum-router). So an answer taken from the router without
/// Corten's server, by a test or an app's own loop, says its length in its body's `size_hint`,
/// not in a header, unless its handler set the header itself.
struct Fix {
    method: Asked,
    allow: Option<HeaderValue>,
}

#[derive(Clone, Copy, PartialEq)]
enum Asked {
    Head,
    Connect,
    /// Any other method, and every method inside a layer, which may still change the body: only
    /// the route's `Allow`.
    Other,
}

impl Fix {
    #[inline]
    fn of(method: &Method, edge: bool) -> Fix {
        let method = match *method {
            _ if !edge => Asked::Other,
            Method::HEAD => Asked::Head,
            Method::CONNECT => Asked::Connect,
            _ => Asked::Other,
        };
        Fix { method, allow: None }
    }

    #[inline]
    fn apply(self, mut res: Response) -> Response {
        use http_body::Body as _;
        if self.method == Asked::Connect && res.status().is_success() {
            // RFC 9110 9.3.6: a `2xx` to `CONNECT` switches the connection to a tunnel, so it has no
            // content, and a server must not send `Content-Length` or `Transfer-Encoding` in it.
            // hyper refuses to send a head with either (hyper 1.12's HTTP/1 encoder), which would
            // close the connection with no answer at all (#1915), so both go with the body. Its
            // other headers are left as they are.
            let headers = res.headers_mut();
            let length = headers.remove(header::CONTENT_LENGTH).is_some();
            let chunked = headers.remove(header::TRANSFER_ENCODING).is_some();
            if length || chunked || res.body().size_hint().lower() != 0 {
                res = res.map(|_| Body::empty());
            }
            return res;
        }
        if let Some(allow) = self.allow {
            if !res.headers().contains_key(header::ALLOW) {
                res.headers_mut().insert(header::ALLOW, allow);
            }
        }
        if self.method == Asked::Head {
            // The server cannot know the length of a body that is gone. An answer whose `GET` the
            // server gives no length gets none here either: RFC 9110 8.6 allows none in a `1xx`
            // or a `204`, and a `304`'s only as its `200`'s, which this body's is not; and one
            // that says `Transfer-Encoding` is sent in chunks, with no length (RFC 9112 6.2).
            let status = res.status();
            let unsaid = status.is_informational()
                || matches!(status, StatusCode::NO_CONTENT | StatusCode::NOT_MODIFIED)
                || res.headers().contains_key(header::TRANSFER_ENCODING);
            if !unsaid && !res.headers().contains_key(header::CONTENT_LENGTH) {
                if let Some(length) = res.body().size_hint().exact() {
                    res.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(length));
                }
            }
            *res.body_mut() = Body::empty();
        }
        res
    }
}

/// [`Router`]'s answer to a request.
pub struct RouterFuture {
    answering: Answering,
    fix: Option<Fix>,
}

impl Future for RouterFuture {
    type Output = Result<Response, Infallible>;

    #[inline]
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let res = std::task::ready!(this.answering.as_mut().poll(cx));
        Poll::Ready(Ok(match this.fix.take() {
            Some(fix) => fix.apply(res),
            None => res,
        }))
    }
}

impl tower_service::Service<Request> for Router {
    type Response = Response;
    type Error = Infallible;
    type Future = RouterFuture;

    #[inline]
    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        Poll::Ready(Ok(()))
    }

    #[inline]
    fn call(&mut self, req: Request) -> RouterFuture {
        self.answer(req)
    }
}

/// The route an access line names for a request: the one that answers it as its own. An
/// enabled-only index of its own keeps the normal matcher and dispatch's call sites as they are.
pub(crate) struct Names {
    paths: matchit::Router<AccessName>,
    scopes: Arc<crate::app::Scopes>,
}

struct AccessName {
    /// As its routes write it (`/feeds/{name}.xml`), shared with the router's copy where that is it.
    route: Arc<str>,
    /// As the router holds it (`/feeds/{name}`), which an API's prefix is compared with.
    pattern: Arc<str>,
    written: Option<&'static str>,
    /// Whether an API's prefix may take a request it matches ([`crate::app::Scopes::foreign`]).
    foreign: bool,
}

impl Names {
    /// Not the route a segment without its written suffix matched, which dispatch answers with
    /// the app's `404`, nor one outside an API whose prefix holds the path, which the API answers
    /// as an unknown URL of its own. Each is the decision [`Dispatch::answer`] and the stages make.
    fn of(&self, path: &str) -> Option<Arc<str>> {
        let named = self.paths.at(path).ok()?.value;
        if named.written.is_some_and(|written| !crate::route::routes_path(written, path)) {
            return None;
        }
        if named.foreign && self.scopes.foreign(&named.pattern, path) {
            return None;
        }
        Some(named.route.clone())
    }
}

struct Recording {
    inner: Router,
    names: Names,
}

impl Outer for Recording {
    fn call(&self, mut req: Request) -> Answering {
        if let Some(shared) = req.extensions_mut().remove::<crate::access::Shared>() {
            shared.set(self.names.of(req.uri().path()));
        }
        let answering = self.inner.answer(req);
        Box::pin(async move {
            let Ok(res) = answering.await;
            res
        })
    }
}

/// Logging alone, without cloning a service or retaining a URI for each request.
struct AccessRouter {
    inner: Router,
    names: Option<Names>,
}

impl Outer for AccessRouter {
    fn call(&self, req: Request) -> Answering {
        crate::access::answer(
            req,
            self.names.is_none(),
            |req| self.names.as_ref()?.of(req.uri().path()),
            |req| self.inner.answer(req),
        )
    }
}

/// A layer's service, called as the router is: by reference, cloned for each request.
trait Outer: Send + Sync + 'static {
    fn call(&self, req: Request) -> Answering;
}

struct Around<T>(T);

impl<T> Outer for Around<T>
where
    T: tower_service::Service<Request> + Clone + Send + Sync + 'static,
    T::Response: IntoResponse + 'static,
    T::Error: Into<Infallible> + 'static,
    T::Future: Send + 'static,
{
    fn call(&self, req: Request) -> Answering {
        let mut service = self.0.clone();
        Box::pin(async move {
            let ready: Result<(), Infallible> = std::future::poll_fn(|cx| service.poll_ready(cx)).await.map_err(Into::into);
            let Ok(()) = ready;
            let answered: Result<T::Response, Infallible> = service.call(req).await.map_err(Into::into);
            let Ok(res) = answered;
            res.into_response()
        })
    }
}

/// The route a request matched, as its routes write its path (`/items/{id}`), which the router
/// puts in the request's extensions before the stages: a middleware reads it with
/// `req.extensions().get::<MatchedPath>()`. An unknown URL has none, nor does a path under an
/// API's prefix that a route outside the API matched (the API answers it with a `404`). A
/// route's parameters ([`crate::Params`]) are read through it from the request's path as it was
/// when it was matched, whatever a middleware does to the request's URI after.
#[derive(Clone, Debug)]
pub struct MatchedPath {
    route: Arc<str>,
    /// Where each parameter is in [`MatchedPath::path`], in the order the route names them.
    params: Ranges,
    /// The path matched, kept (a count on the request's own bytes, not a copy).
    path: PathAndQuery,
}

#[derive(Clone, Debug)]
enum Ranges {
    Few(u8, [(u32, u32); 4]),
    Many(Box<[(u32, u32)]>),
}

impl MatchedPath {
    /// The route's path as its routes write it, with its parameters' names (`/items/{id}`).
    pub fn as_str(&self) -> &str {
        &self.route
    }

    /// The request's path and query as they were when the router matched them.
    pub(crate) fn matched(&self) -> &PathAndQuery {
        &self.path
    }

    #[inline]
    fn new(route: &Arc<str>, uri: &Uri, params: &matchit::Params<'_, '_>) -> Self {
        let path = uri.path();
        let base = path.as_ptr() as usize;
        let at = |value: &str| {
            let start = value.as_ptr() as usize - base;
            (start as u32, (start + value.len()) as u32)
        };
        let params = if params.len() <= 4 {
            let mut few = [(0, 0); 4];
            for (slot, (_, value)) in few.iter_mut().zip(params.iter()) {
                *slot = at(value);
            }
            Ranges::Few(params.len() as u8, few)
        } else {
            Ranges::Many(params.iter().map(|(_, value)| at(value)).collect())
        };
        // A URI with no path (`*`, an authority) matches no route, so it never has parameters.
        let path = uri.path_and_query().cloned().unwrap_or_else(|| PathAndQuery::from_static("/"));
        MatchedPath { route: route.clone(), params, path }
    }

    fn ranges(&self) -> &[(u32, u32)] {
        match &self.params {
            Ranges::Few(len, few) => &few[..*len as usize],
            Ranges::Many(many) => many,
        }
    }

    /// The name of the route's `n`th parameter.
    fn name(&self, n: usize) -> &str {
        let mut names = self.route.split('{').skip(1).map(|rest| {
            let name = &rest[..rest.find('}').unwrap_or(rest.len())];
            name.trim_start_matches('*')
        });
        names.nth(n).unwrap_or("")
    }
}

/// Why a route's parameters could not be read: a value that is not its field's type (a `400`),
/// or a request no route matched, or read as another route's (a `500`, the app's fault).
pub(crate) enum PathError {
    Invalid(FormError),
    Unreadable(String),
}

/// The route's parameters in the path it matched as `T`, a tuple in the order the route names them
/// (as `#[derive(Route)]` writes it), each percent-decoded and read as its field's type.
pub(crate) fn path_params<T: DeserializeOwned>(matched: Option<&MatchedPath>) -> Result<T, PathError> {
    let Some(matched) = matched else {
        return Err(PathError::Unreadable(
            "the request reached a route with path parameters without the router matching it".into(),
        ));
    };
    let path = matched.path.path();
    let fault = Cell::new(None);
    match T::deserialize(Params { path, matched, fault: &fault }) {
        Ok(value) => Ok(value),
        Err(error) => match fault.take() {
            Some(fault) => Err(PathError::Unreadable(fault)),
            None if error.is_in_path() => Err(PathError::Invalid(error)),
            None => Err(PathError::Invalid(FormError::in_path(error.to_string()))),
        },
    }
}

/// [`path_params`]'s deserializer: the parameters as a sequence.
struct Params<'a> {
    path: &'a str,
    matched: &'a MatchedPath,
    /// Set for an error that is the app's, not the request's.
    fault: &'a Cell<Option<String>>,
}

impl<'de> Deserializer<'de> for Params<'_> {
    type Error = FormError;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        let len = self.matched.ranges().len();
        self.deserialize_tuple(len, visitor)
    }

    fn deserialize_tuple<V: Visitor<'de>>(self, len: usize, visitor: V) -> Result<V::Value, FormError> {
        let has = self.matched.ranges().len();
        if len != has {
            self.fault.set(Some(format!("the route {:?} has {has} parameters and {len} were read", self.matched.as_str())));
            return Err(de::Error::custom("wrong number of path parameters"));
        }
        visitor.visit_seq(Values { path: self.path, matched: self.matched, at: 0 })
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(self, _: &'static str, len: usize, visitor: V) -> Result<V::Value, FormError> {
        self.deserialize_tuple(len, visitor)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf option
        unit unit_struct newtype_struct seq map struct enum identifier ignored_any
    }
}

struct Values<'a> {
    path: &'a str,
    matched: &'a MatchedPath,
    at: usize,
}

impl<'de> SeqAccess<'de> for Values<'_> {
    type Error = FormError;

    fn next_element_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>, FormError> {
        let Some(&(start, end)) = self.matched.ranges().get(self.at) else { return Ok(None) };
        let at = self.at;
        self.at += 1;
        let raw = &self.path[start as usize..end as usize];
        let text = percent_encoding::percent_decode_str(raw)
            .decode_utf8()
            .map_err(|_| FormError::in_path(format!("Invalid UTF-8 in `{}`", self.matched.name(at))))?;
        let ty = std::any::type_name::<T::Value>();
        crate::form::de::path_value(seed, &text).map(Some).map_err(|error| crate::form::de::not_in_path(&text, ty, error))
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.matched.ranges().len() - self.at)
    }
}

#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
mod tests {
    use super::*;
    use crate::{App, Corten, HtmlResult, Params, Req};

    #[crate::routes]
    mod pages {
        #[route("/small/{id}", get = small_page)]
        pub struct SmallPage<'a> {
            pub id: &'a str,
        }
    }

    async fn small_page(req: Req, Params(at): Params<pages::SmallPage<'_>>) -> HtmlResult {
        req.page(crate::html! {
            <html>
                <head>
                    <title>"Small page"</title>
                    <Corten />
                </head>
                <body>
                    <main><p>{at.id}</p></main>
                </body>
            </html>
        })
    }

    #[test]
    fn staged_page_future_sizes() {
        // Heap payloads of the real stage and typed handler boxes, with no app middleware or
        // layout reads. What made the stage future large was the request held again in each
        // stage, so each future is held within the size of one request, above and below, of
        // what its build profile measured.
        //
        // Measured on x86_64-unknown-linux-gnu with rustc 1.100.0: 3,008 bytes for the stage
        // future in a debug build (all features, default features and none) and 2,280 in a
        // release one (all features and default features), 760 for the handler's in each, with
        // a request of 240. The stage future holds the request's page snapshot
        // (`page::RequestPage`: its mode and credentials, and in a debug build room for an
        // `Option<FormCheck>`, which this GET leaves empty), read once before dispatch.
        //
        // The sizes are the compiler's layout, so the test can fail in three ways:
        // - a future grew by a request or more after a change to the stages or the handler:
        //   something that size is held again across the stages after it. Run this test in
        //   both profiles and remeasure the staged catalog request before moving a
        //   measurement: the fixture guards Corten's overhead, not every app's;
        // - a future shrank by a request or more. That leaves room for a second copy before
        //   the test fails, so measure both profiles and lower the measurements. (Nearer than
        //   that, one copy can still pass until the measurement is lowered.)
        // - another toolchain moved the layout that far with no such change. Measure both
        //   profiles again and move the measurements and the versions above with them.
        const REQUEST: usize = std::mem::size_of::<http::Request<Body>>();
        // The stage future and the handler future, in bytes.
        const MEASURED: (usize, usize) = if cfg!(debug_assertions) { (3008, 760) } else { (2280, 760) };
        let profile = if cfg!(debug_assertions) { "debug" } else { "release" };

        let router = App::new(pages::router()).router();
        let Inner::Routes(dispatch) = &router.inner else { panic!("expected a router with no outer layer") };
        let matched = dispatch.paths.at("/small/one").unwrap();
        let entry = &dispatch.routes[*matched.value];
        let (route, _) = entry.pick(&Method::GET, dispatch);
        let request = || http::Request::builder().uri("/small/one").body(Body::empty()).unwrap();
        let stage = entry.stages.as_ref().unwrap().clone().run(request(), route);
        let handler = route.call(request());

        let stage_size = std::mem::size_of_val(stage.as_ref().get_ref());
        let handler_size = std::mem::size_of_val(handler.as_ref().get_ref());
        eprintln!("stage future: {stage_size} bytes; handler future: {handler_size} bytes; request: {REQUEST} bytes");
        for (name, size, measured) in [("stage", stage_size, MEASURED.0), ("handler", handler_size, MEASURED.1)] {
            assert!(
                size < measured + REQUEST,
                "{name} future: {size} bytes in a {profile} build, a request ({REQUEST} bytes) or more over the \
                 {measured} measured: something that size is held again across the stages, or another rustc \
                 moved the layout. See this test's comment before moving a measurement"
            );
            assert!(
                size + REQUEST > measured,
                "{name} future: {size} bytes in a {profile} build, a request ({REQUEST} bytes) or more under the \
                 {measured} measured: measure both profiles and lower the measurements, as this test's comment says"
            );
        }
    }
}
