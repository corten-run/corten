//! Matching a path to its route. A [`Router`] is an [`Endpoint`]; each route is too, and gets the
//! path's parameters ([`Params`]) in its context ahead of what the stages around the router gave.
//! A route's own stages go around its handler: `get(api.serve(handler(item)))`.

use std::{borrow::Cow, future::Future, pin::Pin, sync::Arc};

use futures_util::future::Either;
use http::{HeaderValue, Method, StatusCode, Uri, header};

use crate::{Endpoint, Failure, Handler, Has, Request, Response};

type BoxFuture<'a> = Pin<Box<dyn Future<Output = Response> + Send + 'a>>;

/// An endpoint with its type erased, as a route stores it: one box per request, for its future.
trait Erased<Cx>: Send + Sync {
    fn call_boxed(&self, req: Request, cx: Cx) -> BoxFuture<'_>;
}

impl<Cx: Send + 'static, E: Endpoint<Cx>> Erased<Cx> for E {
    fn call_boxed(&self, req: Request, cx: Cx) -> BoxFuture<'_> {
        Box::pin(self.call(req, cx))
    }
}

/// What a route's method takes: a handler function, or an [`Endpoint`] (a struct that answers by
/// hand, or a handler with stages of its own, `api.serve(handler(item))`).
pub trait IntoEndpoint<Cx, M> {
    type Endpoint: Endpoint<Cx>;
    fn into_endpoint(self) -> Self::Endpoint;
}

/// [`IntoEndpoint`] of a handler function.
pub struct IsHandler;
/// [`IntoEndpoint`] of an endpoint.
pub struct IsEndpoint;

impl<Cx, H: Handler<Cx, M>, M: 'static> IntoEndpoint<Cx, (IsHandler, M)> for H {
    type Endpoint = crate::handler::HandlerEndpoint<H, M>;
    fn into_endpoint(self) -> Self::Endpoint {
        crate::handler(self)
    }
}

impl<Cx, E: Endpoint<Cx>> IntoEndpoint<Cx, IsEndpoint> for E {
    type Endpoint = E;
    fn into_endpoint(self) -> E {
        self
    }
}

/// Each method's endpoint, its type erased.
type Handlers<Cx> = Vec<(Method, Arc<dyn Erased<(Params, Cx)>>)>;

/// The handlers of one path, by method. Made by [`get`], [`post`] and [`Methods::on`].
pub struct Methods<Cx> {
    handlers: Handlers<Cx>,
}

impl<Cx: Send + 'static> Methods<Cx> {
    /// `handler` for `method` too.
    pub fn on<H: IntoEndpoint<(Params, Cx), M>, M>(mut self, method: Method, handler: H) -> Self {
        assert!(!self.handlers.iter().any(|(m, _)| *m == method), "the method {method} is given twice");
        self.handlers.push((method, Arc::new(handler.into_endpoint())));
        self
    }

    /// `handler` for `GET` too (and `HEAD`, unless given one).
    pub fn get<H: IntoEndpoint<(Params, Cx), M>, M>(self, handler: H) -> Self {
        self.on(Method::GET, handler)
    }

    /// `handler` for `POST` too.
    pub fn post<H: IntoEndpoint<(Params, Cx), M>, M>(self, handler: H) -> Self {
        self.on(Method::POST, handler)
    }
}

/// `handler` for `GET` (and `HEAD`) at a path.
pub fn get<Cx: Send + 'static, H: IntoEndpoint<(Params, Cx), M>, M>(handler: H) -> Methods<Cx> {
    Methods { handlers: Vec::new() }.get(handler)
}

/// `handler` for `POST` at a path.
pub fn post<Cx: Send + 'static, H: IntoEndpoint<(Params, Cx), M>, M>(handler: H) -> Methods<Cx> {
    Methods { handlers: Vec::new() }.post(handler)
}

struct Route<Cx> {
    keys: &'static [&'static str],
    handlers: Handlers<Cx>,
    /// `Allow` for a method the path does not have.
    allow: HeaderValue,
}

/// Paths and their routes.
pub struct Router<Cx> {
    paths: matchit::Router<usize>,
    routes: Vec<Route<Cx>>,
}

impl<Cx: Send + 'static> Default for Router<Cx> {
    fn default() -> Self {
        Router::new()
    }
}

impl<Cx: Send + 'static> Router<Cx> {
    pub fn new() -> Self {
        Router { paths: matchit::Router::new(), routes: Vec::new() }
    }

    /// The handlers at `path` (`/items/{id}`, `/files/{*rest}`). Panics when two paths clash, as
    /// the app starts.
    pub fn route(mut self, path: &'static str, methods: Methods<Cx>) -> Self {
        let keys = param_names(path);
        assert!(keys.len() <= MAX_PARAMS, "{path}: at most {MAX_PARAMS} parameters");
        let has = |method: &Method| methods.handlers.iter().any(|(m, _)| m == method);
        let mut allowed: Vec<&str> = methods.handlers.iter().map(|(m, _)| m.as_str()).collect();
        if has(&Method::GET) && !has(&Method::HEAD) {
            allowed.push("HEAD");
        }
        let allow = HeaderValue::from_str(&allowed.join(", ")).expect("method names are header text");
        let at = self.routes.len();
        if let Err(error) = self.paths.insert(path, at) {
            panic!("{path}: {error}");
        }
        self.routes.push(Route { keys: Vec::leak(keys), handlers: methods.handlers, allow });
        self
    }
}

impl<Cx: Send + 'static> Endpoint<Cx> for Router<Cx> {
    fn call(&self, req: Request, cx: Cx) -> impl Future<Output = Response> + Send + '_ {
        let Ok(found) = self.paths.at(req.uri().path()) else {
            return Either::Left(std::future::ready(Failure::not_found().into_response()));
        };
        let route = &self.routes[*found.value];
        let path = req.uri().path();
        let base = path.as_ptr() as usize;
        let mut ranges = [(0u16, 0u16); MAX_PARAMS];
        for (at, (slot, (key, value))) in ranges.iter_mut().zip(found.params.iter()).enumerate() {
            // matchit hands back slices of the path, which http caps below 64 KiB.
            debug_assert_eq!(route.keys.get(at), Some(&key), "the route's names, in matchit's order");
            let start = value.as_ptr() as usize - base;
            debug_assert!(start + value.len() <= path.len() && path.len() <= u16::MAX as usize);
            *slot = (start as u16, (start + value.len()) as u16);
        }
        let head = req.method() == Method::HEAD;
        let handler = route
            .handlers
            .iter()
            .find(|(m, _)| m == req.method())
            .or_else(|| if head { route.handlers.iter().find(|(m, _)| *m == Method::GET) } else { None });
        let Some((method, handler)) = handler else {
            let mut res = Failure::new(StatusCode::METHOD_NOT_ALLOWED).into_response();
            res.headers_mut().insert(header::ALLOW, route.allow.clone());
            return Either::Left(std::future::ready(res));
        };
        let params = Params { uri: req.uri().clone(), keys: route.keys, ranges };
        let answer = handler.call_boxed(req, (params, cx));
        if head && *method == Method::GET {
            // The GET's answer without its body, its length kept. A failure keeps its body, which
            // holds no bytes, so the stages around the router still describe it (and hyper sends
            // no body for a HEAD whatever the description is).
            return Either::Right(Either::Left(async move {
                let (mut parts, body) = answer.await.into_parts();
                if body.failure().is_some() {
                    return Response::from_parts(parts, body);
                }
                if let Some(length) = http_body::Body::size_hint(&body).exact() {
                    parts.headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
                }
                Response::from_parts(parts, crate::Body::empty())
            }));
        }
        Either::Right(Either::Right(answer))
    }
}

const MAX_PARAMS: usize = 4;

/// The path's parameters, as the route named them. Held as positions in the request's path, so
/// reading one copies nothing unless it was percent-encoded.
#[derive(Clone)]
pub struct Params {
    uri: Uri,
    keys: &'static [&'static str],
    ranges: [(u16, u16); MAX_PARAMS],
}

impl Params {
    /// Parameters for a test or a measurement that calls a route's endpoint without a router:
    /// none named.
    #[doc(hidden)]
    pub fn probe(path: &'static str) -> Self {
        Params { uri: Uri::from_static(path), keys: &[], ranges: [(0, 0); MAX_PARAMS] }
    }

    /// The parameter `key`, percent-decoded; `None` when the route has none of that name or it
    /// is not UTF-8 once decoded.
    pub fn get(&self, key: &str) -> Option<Cow<'_, str>> {
        let at = self.keys.iter().position(|k| *k == key)?;
        let (start, end) = self.ranges[at];
        let raw = &self.uri.path()[start as usize..end as usize];
        if !raw.contains('%') {
            return Some(Cow::Borrowed(raw));
        }
        decode(raw).map(Cow::Owned)
    }

    /// The parameter `key` read as a `T`, or 404: a path whose parameter does not read names no
    /// resource.
    pub fn parse<T: std::str::FromStr>(&self, key: &str) -> Result<T, Failure> {
        self.get(key).and_then(|value| value.parse().ok()).ok_or_else(Failure::not_found)
    }
}

/// The parameters a route pattern names, in order, as matchit reads it: `{name}` and `{*name}`,
/// with `{{` and `}}` a literal brace.
fn param_names(path: &'static str) -> Vec<&'static str> {
    let bytes = path.as_bytes();
    let mut names = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        match (bytes[at], bytes.get(at + 1)) {
            (b'{', Some(b'{')) | (b'}', Some(b'}')) => at += 2,
            (b'{', _) => {
                let end = path[at..].find('}').map(|end| at + end).unwrap_or_else(|| panic!("{path}: a `{{` with no `}}`"));
                let name = &path[at + 1..end];
                names.push(name.strip_prefix('*').unwrap_or(name));
                at = end + 1;
            }
            _ => at += 1,
        }
    }
    names
}

fn decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let digits = bytes.get(at + 1..at + 3)?;
            if !digits.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The path's parameters, for a handler of a route: `params: Params`.
impl<Cx: Has<Params, I> + Sync, I> crate::FromParts<Cx, crate::handler::FromCx<I>> for Params {
    #[inline]
    fn from_parts(_: &http::request::Parts, cx: &Cx) -> impl Future<Output = Result<Self, Failure>> + Send {
        std::future::ready(Ok(cx.get().clone()))
    }
}
