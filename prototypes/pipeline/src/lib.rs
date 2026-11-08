//! A prototype of Corten's request pipeline with no axum and no tower, built up from the raw
//! `http::Request` and `http::Response`.
//!
//! There are three ideas, and each is one trait:
//!
//! 1. An [`Endpoint`] answers a request. It gets the raw [`Request`] and a typed context `Cx` (what
//!    the stages around it gave it) and returns the raw [`Response`]. A handler function is one
//!    ([`handler`]), and so is a [`Router`](router::Router), and a struct that writes its answer
//!    by hand.
//! 2. A [`Stage`] is one feature around an endpoint: the host check, the signal, the deadline, the
//!    security headers, error pages. It may answer the request itself, change it, change the
//!    answer, and give the endpoint inside something new in its context (its `Out`).
//! 3. [`Stages`] is the only way to put stages around an endpoint, read outside in:
//!    `Stages::new().with(Host::loopback()).with(Cancel).serve(endpoint)`.
//!
//! What a handler reads is checked against what the stages around it give, when the app compiles:
//! a handler that takes a [`Signal`](stages::Signal) on a route with no [`Cancel`](stages::Cancel)
//! stage does not compile, and a stage that needs one ([`Deadline`](stages::Deadline)) placed
//! outside it does not either. The context is a value passed down the stack, not request
//! extensions, so giving something to a handler costs a move, not an allocation.
//!
//! ```
//! use pipeline::{get, stages::{Cancel, Signal}, Router, Stages};
//!
//! async fn search(signal: Signal) -> &'static str {
//!     if signal.is_aborted() { "gone" } else { "found" }
//! }
//!
//! async fn start(listener: tokio::net::TcpListener) -> std::io::Result<()> {
//!     let app = Stages::new().with(Cancel).serve(Router::new().route("/search", get(search)));
//!     pipeline::server::serve(listener, app).await
//! }
//! ```
//!
//! The context is worked out from where the app is served (with nothing, `()`), so nothing names
//! its type. Without the stage that gives it, the handler's argument does not compile:
//!
//! ```compile_fail,E0277
//! use pipeline::{get, stages::Signal, Router, Stages};
//!
//! async fn search(signal: Signal) -> &'static str {
//!     if signal.is_aborted() { "gone" } else { "found" }
//! }
//!
//! async fn start(listener: tokio::net::TcpListener) -> std::io::Result<()> {
//!     let app = Stages::new().serve(Router::new().route("/search", get(search)));
//!     pipeline::server::serve(listener, app).await
//! }
//! ```
//!
//! Nor does state no stage shares:
//!
//! ```compile_fail,E0277
//! use pipeline::{get, handler::State, Router, Stages};
//!
//! #[derive(Clone)]
//! struct Db;
//! async fn list(State(_db): State<Db>) -> &'static str { "[]" }
//!
//! async fn start(listener: tokio::net::TcpListener) -> std::io::Result<()> {
//!     let app = Stages::new().serve(Router::new().route("/", get(list)));
//!     pipeline::server::serve(listener, app).await
//! }
//! ```
//!
//! A stage that needs another's gift goes inside it; the deadline aborts the request's signal, so
//! outside [`Cancel`](stages::Cancel) it does not compile:
//!
//! ```compile_fail,E0277
//! use std::time::Duration;
//! use pipeline::{get, stages::{Cancel, Deadline}, Router, Stages};
//!
//! async fn start(listener: tokio::net::TcpListener) -> std::io::Result<()> {
//!     let app = Stages::new()
//!         .with(Deadline::new(Duration::from_secs(30)))
//!         .with(Cancel)
//!         .serve(Router::new().route("/", get(|| async { "ok" })));
//!     pipeline::server::serve(listener, app).await
//! }
//! ```
//!
//! The context holds one value of each type. A second stage that gives a type already in it is
//! ambiguous to the compiler, which says only "type annotations needed" (E0283), not the
//! framework's message; a real version would refuse the second stage itself:
//!
//! ```compile_fail,E0283
//! use pipeline::{get, stages::{Cancel, Signal}, Router, Stages};
//!
//! async fn search(signal: Signal) -> &'static str {
//!     if signal.is_aborted() { "gone" } else { "found" }
//! }
//!
//! async fn start(listener: tokio::net::TcpListener) -> std::io::Result<()> {
//!     let app = Stages::new().with(Cancel).with(Cancel).serve(Router::new().route("/", get(search)));
//!     pipeline::server::serve(listener, app).await
//! }
//! ```
//!
//! ```
//! use std::time::Duration;
//! use pipeline::{get, stages::{Cancel, Deadline}, Router, Stages};
//!
//! async fn start(listener: tokio::net::TcpListener) -> std::io::Result<()> {
//!     let app = Stages::new()
//!         .with(Cancel)
//!         .with(Deadline::new(Duration::from_secs(30)))
//!         .serve(Router::new().route("/", get(|| async { "ok" })));
//!     pipeline::server::serve(listener, app).await
//! }
//! ```
use std::{future::Future, marker::PhantomData};

mod body;
pub mod handler;
pub mod router;
pub mod server;
pub mod stages;

pub use body::{Body, BoxError, Failure, Request, Response};
pub use handler::{FromParts, FromRequest, Handler, Json, Respond, handler};
pub use router::{Params, Router, get, post};

/// Answers a request: the raw [`Request`] and what the stages around it gave (`cx`) in, the raw
/// [`Response`] out. The lowest level of the framework; everything else is one of these.
pub trait Endpoint<Cx>: Send + Sync + 'static {
    fn call(&self, req: Request, cx: Cx) -> impl Future<Output = Response> + Send + '_;
}

/// One feature around an endpoint. `Out` is the context the endpoint inside it gets: `Cx` itself
/// for a stage that gives nothing, `(T, Cx)` for one that gives a `T`.
pub trait Stage<Cx>: Send + Sync + 'static {
    type Out: Send;

    fn call<'a, E: Endpoint<Self::Out>>(
        &'a self,
        req: Request,
        cx: Cx,
        inner: &'a E,
    ) -> impl Future<Output = Response> + Send + 'a;
}

/// Stages to put around an endpoint, outermost first. The only way to add behavior to a request:
/// the app's defaults are a `Stages` value ([`Stages::api`]), and so is a route's own.
#[derive(Clone)]
pub struct Stages<L>(L);

impl Stages<()> {
    /// No stages: the endpoint gets the request as the connection gave it.
    pub const fn new() -> Self {
        Stages(())
    }
}

impl Default for Stages<()> {
    fn default() -> Self {
        Stages::new()
    }
}

impl<L> Stages<L> {
    /// `stage` inside the ones before it.
    pub fn with<S>(self, stage: S) -> Stages<(L, S)> {
        Stages((self.0, stage))
    }

    /// The endpoint with these stages around it.
    pub fn serve<E>(self, endpoint: E) -> L::Served
    where
        L: Around<E>,
    {
        self.0.around(endpoint)
    }
}

/// A list of stages around an endpoint. Implemented for `()` and `(L, S)`; not for apps.
pub trait Around<E> {
    type Served;
    fn around(self, endpoint: E) -> Self::Served;
}

impl<E> Around<E> for () {
    type Served = E;
    fn around(self, endpoint: E) -> E {
        endpoint
    }
}

impl<L: Around<Stacked<S, E>>, S, E> Around<E> for (L, S) {
    type Served = L::Served;
    fn around(self, endpoint: E) -> L::Served {
        self.0.around(Stacked { stage: self.1, inner: endpoint })
    }
}

/// A stage around an endpoint, which is an endpoint.
pub struct Stacked<S, E> {
    stage: S,
    inner: E,
}

impl<Cx, S: Stage<Cx>, E: Endpoint<S::Out>> Endpoint<Cx> for Stacked<S, E> {
    #[inline]
    fn call(&self, req: Request, cx: Cx) -> impl Future<Output = Response> + Send + '_ {
        self.stage.call(req, cx, &self.inner)
    }
}

/// The context holds a `T`: what a handler's argument or a stage reads from it. The context is a
/// list, `(Signal, (State<Db>, ()))`; `I` says where in it the `T` is, and the compiler works it out.
#[diagnostic::on_unimplemented(
    message = "nothing around this endpoint gives it a `{T}`",
    label = "needs a `{T}`",
    note = "add the stage that gives a `{T}` outside it, in its `Stages::new().with(..)`; stages are read outside in, so it goes before the stage or route that reads it"
)]
pub trait Has<T, I> {
    fn get(&self) -> &T;
}

/// [`Has`]: the `T` is the first in the list.
pub struct Here;
/// [`Has`]: the `T` is further along.
pub struct There<I>(PhantomData<I>);

impl<T, R> Has<T, Here> for (T, R) {
    #[inline]
    fn get(&self) -> &T {
        &self.0
    }
}

impl<T, H, R: Has<T, I>, I> Has<T, There<I>> for (H, R) {
    #[inline]
    fn get(&self) -> &T {
        self.1.get()
    }
}
