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
//! it has; an answer whose length is known says it (`Content-Length`); and a `2xx` to `CONNECT`
//! has no body. A request's handler is boxed once, and so are the stages around it.
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

/// A request's answer on its way: what an [`Endpoint`] and the stages give.
pub(crate) type Answering = Pin<Box<dyn Future<Output = Response> + Send>>;

/// A route's handler for one or more methods, with its state: what the router calls.
pub(crate) trait Endpoint: Send + Sync + 'static {
    fn call(&self, req: Request) -> Answering;
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
}

/// An answer that is a status alone: the router's `404` and `405`.
struct Status(StatusCode);

impl Endpoint for Status {
    fn call(&self, _: Request) -> Answering {
        Box::pin(std::future::ready(self.0.into_response()))
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
}

/// A handler for some methods, waiting for its state (`S`) or with it.
enum Slot<S> {
    Unbound(Arc<dyn Fn(S) -> Route + Send + Sync>),
    Bound(Route),
}

impl<S> Clone for Slot<S> {
    fn clone(&self) -> Self {
        match self {
            Slot::Unbound(make) => Slot::Unbound(make.clone()),
            Slot::Bound(route) => Slot::Bound(route.clone()),
        }
    }
}

impl<S: Clone + Send + Sync + 'static> Slot<S> {
    fn handler<H: Handler<T, S>, T: 'static>(handler: H) -> Self {
        Slot::Unbound(Arc::new(move |state| Arc::new(Handled { handler: handler.clone(), state, types: PhantomData })))
    }

    fn bind<S2>(self, state: &S) -> Slot<S2> {
        match self {
            Slot::Unbound(make) => Slot::Bound(make(state.clone())),
            Slot::Bound(route) => Slot::Bound(route),
        }
    }

    fn gives(self, gives: &'static [fn() -> std::any::TypeId]) -> Self {
        match self {
            Slot::Unbound(make) => Slot::Unbound(Arc::new(move |state| Arc::new(Giving { gives, inner: make(state) }))),
            Slot::Bound(inner) => Slot::Bound(Arc::new(Giving { gives, inner })),
        }
    }
}

impl Slot<()> {
    fn route(self) -> Route {
        match self {
            Slot::Unbound(make) => make(()),
            Slot::Bound(route) => route,
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

/// What a route's `405` says it allows.
#[derive(Clone)]
enum Allow {
    /// The methods it has handlers for, in the order they were given (`GET` with `HEAD`).
    Methods(Vec<&'static str>),
    /// Nothing: its handler takes every method (`any`).
    Any,
}

/// A route's handlers, one for each method it has and one for any other (`any`, or an unstaged
/// route's `405`), with the state they take (`S`) still to give or given: what [`crate::Methods`]
/// holds.
pub(crate) struct MethodSet<S = ()> {
    slots: [Option<Slot<S>>; 9],
    fallback: Option<Slot<S>>,
    allow: Allow,
}

impl<S> Clone for MethodSet<S> {
    fn clone(&self) -> Self {
        MethodSet { slots: self.slots.clone(), fallback: self.fallback.clone(), allow: self.allow.clone() }
    }
}

impl<S> Default for MethodSet<S> {
    fn default() -> Self {
        MethodSet { slots: std::array::from_fn(|_| None), fallback: None, allow: Allow::Methods(Vec::new()) }
    }
}

impl<S: Clone + Send + Sync + 'static> MethodSet<S> {
    fn on<H: Handler<T, S>, T: 'static>(mut self, at: usize, handler: H) -> Self {
        assert!(self.slots[at].is_none(), "corten: a route has two handlers for {}", NAMES[at]);
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
        self.fallback = Some(Slot::handler(handler));
        self
    }

    /// The handlers of both, which have none for the same method.
    pub(crate) fn merge(mut self, other: MethodSet<S>) -> Self {
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
        }
    }

    /// Each handler marking its request with the layout reads it gives itself.
    pub(crate) fn gives(self, gives: &'static [fn() -> std::any::TypeId]) -> Self {
        MethodSet {
            slots: self.slots.map(|slot| slot.map(|slot| slot.gives(gives))),
            fallback: self.fallback.map(|slot| slot.gives(gives)),
            allow: self.allow,
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

/// What a route's requests go through on the way to its handler, its `404` and its `405`.
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
    /// text after a parameter and its `405` all meet it.
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
/// app's own; [`crate::serve`] serves it itself.
#[derive(Clone)]
pub struct Router {
    inner: Inner,
    /// Whether this is the router a server calls, outside every layer: it alone sets an answer's
    /// length and empties a `HEAD`'s body, after the layers have had the answer, as axum's did.
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
    fn pick<'a>(&'a self, method: &Method, not_allowed: &'a Route) -> (&'a Route, Option<&'a HeaderValue>) {
        let own = match *method {
            Method::HEAD => self.slots[HEAD].as_ref().or(self.slots[GET].as_ref()),
            _ => slot_of(method).and_then(|at| self.slots[at].as_ref()),
        };
        match own {
            Some(route) => (route, None),
            None => (self.fallback.as_ref().unwrap_or(not_allowed), self.allow.as_ref()),
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
            routes.push(Entry {
                path,
                slots: methods.slots.map(|slot| slot.map(Slot::route)),
                fallback: methods.fallback.map(Slot::route),
                allow,
                written,
                stages: around,
            });
        }
        let not_found: Route = Arc::new(Status(StatusCode::NOT_FOUND));
        let not_allowed: Route = Arc::new(Status(StatusCode::METHOD_NOT_ALLOWED));
        Router { inner: Inner::Routes(Arc::new(Dispatch { paths, routes, stages, not_found, not_allowed })), edge: true }
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
                    _ => entry.pick(req.method(), &self.not_allowed),
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
}

/// What the router does to every answer on its way out, as HTTP has it: a `405`'s `Allow`; and,
/// outside every layer, the length when the body's is known, no body for `HEAD`, nor for a `2xx`
/// to `CONNECT`.
struct Fix {
    method: Asked,
    allow: Option<HeaderValue>,
}

#[derive(Clone, Copy, PartialEq)]
enum Asked {
    Head,
    Connect,
    Other,
    /// Inside a layer: only the route's `Allow`, since the layer may still change the body.
    Inside,
}

impl Fix {
    #[inline]
    fn of(method: &Method, edge: bool) -> Fix {
        let method = match *method {
            _ if !edge => Asked::Inside,
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
            // content. Its headers are left as they are, as axum left them.
            let headers = res.headers();
            if headers.contains_key(header::CONTENT_LENGTH)
                || headers.contains_key(header::TRANSFER_ENCODING)
                || res.body().size_hint().lower() != 0
            {
                res = res.map(|_| Body::empty());
            }
            return res;
        }
        if let Some(allow) = self.allow {
            if !res.headers().contains_key(header::ALLOW) {
                res.headers_mut().insert(header::ALLOW, allow);
            }
        }
        if self.method == Asked::Inside {
            return res;
        }
        if !res.headers().contains_key(header::CONTENT_LENGTH) {
            if let Some(length) = res.body().size_hint().exact() {
                res.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(length));
            }
        }
        if self.method == Asked::Head {
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
