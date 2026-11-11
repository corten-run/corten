//! What a route answers, named by its handler's return type: [`HtmlResult`] for a page, a patch or
//! a redirect, [`JsonResult<T>`] for JSON, and [`Public`] around either for an answer that is the
//! same for everyone. The type decides how the route's failures are answered (the error page, or
//! JSON) and what the handler may read, so `#[corten::routes]` checks both when the crate
//! compiles:
//!
#![cfg_attr(feature = "json", doc = "```")]
#![cfg_attr(not(feature = "json"), doc = "```ignore")]
//! use corten::prelude::*;
//!
//! #[corten::routes]
//! mod url {
//!     #[route("/", get = home)]
//!     pub struct Home;
//!
//!     #[route("/api/price/{id}", get = price)]
//!     pub struct Price { pub id: u32 }
//! }
//!
//! async fn home(req: Req) -> HtmlResult {
//!     req.page(html! { <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html> })
//! }
//!
//! #[derive(ToJson)]
//! struct Quote { id: u32, cents: u32 }
//!
//! // A path that does not parse is a JSON 400, whatever the client accepts.
//! async fn price(price: Params<url::Price>) -> JsonResult<Quote> {
//!     Ok(Json(Quote { id: price.id, cents: 900 }))
//! }
//! # let _ = App::new(url::router()).router();
//! ```
//!
//! A handler that hides what it answers does not compile:
//!
//! ```compile_fail,E0277
//! use corten::{http::Response, prelude::*};
//!
//! #[corten::routes]
//! mod url {
//!     #[route("/", get = home)]
//!     pub struct Home;
//! }
//!
//! async fn home() -> Response {
//!     Response::default()
//! }
//! # fn main() { let _ = url::router(); }
//! ```

use std::{
    future::Future,
    marker::PhantomData,
    ops::{Deref, DerefMut},
    time::Duration,
};

use crate::{
    body::Body,
    extract::State,
    handler::{Handler, Request},
};
use http::{Method, StatusCode, Uri};

use crate::response::{IntoResponse, Response};

use crate::{cache::Cache, Error, Req, Signal};

/// How a route's failures are answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// By the request's mode: the app's error page for a browser, JSON for a data client
    /// (`Accept: application/json`), the status line for anything else.
    Html,
    /// JSON, a Problem Details document (`application/problem+json`), whatever the client accepts.
    Json,
}

/// What a handler named in `#[corten::routes]` returns: the type says how the route's failures are
/// answered ([`Answer::FORMAT`]) and what the handler may read ([`Answer::Inputs`]). Implemented
/// for [`HtmlResult`], [`JsonResult<T>`], `Result<JsonResponse, JsonError>`, [`Public`], [`NoStore`], text, a bare `StatusCode`,
/// [`LiveResponse`], feeds, [`Media`], a [`Relay`], [`PageOr`] and [`crate::seo::File`]; a crate may add
/// its own.
#[diagnostic::on_unimplemented(
    message = "`{Self}` is not an answer a route can name",
    label = "the handler returns this",
    note = "return `HtmlResult` (a page, a patch, a redirect), `JsonResult<T>`, or `Public<..>` of one; `Response` and `impl IntoResponse` hide what the route answers"
)]
pub trait Answer: IntoResponse {
    /// How the route's failures are answered.
    const FORMAT: Format;
    /// What the handler may read: [`AnyInputs`], or [`AnonymousInputs`] for an answer that is
    /// the same for everyone.
    type Inputs;
    /// The rows of a feed's answer (`FeedResponse<Level>`: `Level`), [`NotAFeed`] for any other.
    /// The route a feed is at names them, `#[route("/feed/levels", get = levels, rows = Level)]`, so
    /// a script handed its URL knows what rows it sends.
    type Rows;
    /// The answer can be a whole page in the app's layout ([`HtmlResponse`]), so a request for a
    /// document starts the app's layout reads ([`crate::LayoutRead`]) as the route is called. False
    /// for anything else: a file, text, JSON, a stream. An answer type of the app's own that wraps
    /// a page says `const PAGE: bool = true;` (or forwards its page's), or its route starts no read
    /// and its layout's places draw nothing.
    const PAGE: bool = false;
}

/// The rows ([`Answer::Rows`]) of an answer that is not a feed.
pub enum NotAFeed {}

/// A page, a patch or a redirect, as a whole response (status and headers too): what
/// [`Req::page`], [`Req::patch`] and [`Req::redirect`] give. A cookie is
/// [`HtmlResponse::with_cookie`]; it derefs to the response for any other header of the
/// handler's own (`res.headers_mut().insert(..)`).
///
/// `For` is who the answer is for, read from where it goes: [`ForOne`], the visitor who asked
/// (an [`HtmlResult`]), or [`ForAll`], inside a [`Public`]. The `Req` methods that make one
/// take it from there, so a handler never names it.
pub struct HtmlResponse<For = ForOne>(pub(crate) Response, PhantomData<For>);

/// An answer for the visitor who asked: it may set a cookie. What [`HtmlResult`] holds.
pub struct ForOne;

/// An answer for everyone, inside a [`Public`]: a cache gives it to anyone, so it sets no
/// cookie, and [`HtmlResponse::with_cookie`] there does not compile.
pub struct ForAll;

/// Who an answer that sets a cookie can be for: [`ForOne`] alone.
#[diagnostic::on_unimplemented(
    message = "a `Public` answer is the same for everyone, so it cannot set a cookie",
    label = "this answer is `Public`",
    note = "return a private answer (`HtmlResult`) to set a cookie; a cache would give the cookie to everyone"
)]
pub trait SetsCookies: sealed::Sealed {}

impl SetsCookies for ForOne {}

mod sealed {
    pub trait Sealed {}
    impl Sealed for super::ForOne {}

    pub trait Immutable {}
    impl Immutable for super::Media {}
    impl Immutable for Result<super::Media, super::Error> {}
}

impl<For> HtmlResponse<For> {
    pub(crate) fn new(res: Response) -> Self {
        HtmlResponse(res, PhantomData)
    }

    /// The page's own value for a [`crate::LayoutRead`] its layout draws, drawn in place of the
    /// read's: a cart page that has read the cart gives the count, so a full load does not wait
    /// for the read (which its [`crate::LayoutRead::start`] can skip for that page).
    ///
    /// ```
    /// # use std::future::Future;
    /// # use corten::{http::request::Parts, prelude::*, LayoutRead};
    /// # struct CartCount;
    /// # impl LayoutRead for CartCount {
    /// #     type Value = Option<u32>;
    /// #     fn start(&self, _: &Parts) -> Option<impl Future<Output = Option<u32>> + Send + 'static> { Some(async { None }) }
    /// #     fn view(count: &Option<u32>) -> impl Render + '_ { html! { if let Some(count) = count { <span>{*count}</span> } } }
    /// # }
    /// fn cart_page(req: &Req, lines: &[u32]) -> HtmlResult {
    ///     # let page = html! { <html><head><title>"Cart"</title><Corten /></head><body>{later::<CartCount>()}<main></main></body></html> };
    ///     Ok(req.page(page)?.give::<CartCount>(Some(lines.len() as u32)))
    /// }
    /// # let _ = cart_page;
    /// ```
    pub fn give<T: crate::LayoutRead>(mut self, value: T::Value) -> Self {
        let given = self.0.extensions_mut().get_or_insert_default::<crate::layout::Given>();
        given.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((std::any::TypeId::of::<T>(), Box::new(value)));
        self
    }
}

impl<For: SetsCookies> HtmlResponse<For> {
    /// The answer with a `Set-Cookie` header, built by [`SetCookie`](crate::security::cookie::SetCookie)
    /// so its safe flags are the default: `Ok(req.redirect(&url::Home)?.with_cookie(SetCookie::new("session", &token)))`.
    /// Each call adds one; an answer that sets a cookie is never stored by a shared cache. This is
    /// the way to set one: never append a `Set-Cookie` header by hand.
    ///
    /// ```
    /// use corten::{prelude::*, security::cookie::SetCookie};
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/", get = home)]
    ///     pub struct Home;
    ///
    ///     #[route("/sign-out", post = sign_out)]
    ///     pub struct SignOut;
    /// }
    ///
    /// # async fn home(req: Req) -> HtmlResult {
    /// #     req.page(html! { <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html> })
    /// # }
    /// async fn sign_out(req: Req) -> HtmlResult {
    ///     Ok(req.redirect(&url::Home)?.with_cookie(SetCookie::remove("session")))
    /// }
    /// # let _ = App::new(url::router()).router();
    /// ```
    ///
    /// A [`Public`] answer is the same for everyone, so setting a cookie on one does not compile:
    ///
    /// ```compile_fail,E0277
    /// use std::time::Duration;
    /// use corten::{prelude::*, security::cookie::SetCookie};
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/", get = home)]
    ///     pub struct Home;
    /// }
    ///
    /// async fn home(req: Req) -> Public<HtmlResult> {
    ///     let page = req.page(html! { <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html> });
    ///     Public::new(Duration::from_secs(60), page.map(|page| page.with_cookie(SetCookie::new("seen", "1"))))
    /// }
    /// # fn main() { let _ = url::router(); }
    /// ```
    #[must_use]
    pub fn with_cookie(mut self, cookie: crate::security::cookie::SetCookie) -> Self {
        self.0.headers_mut().append(http::header::SET_COOKIE, cookie.header());
        self
    }
}

impl<For> IntoResponse for HtmlResponse<For> {
    fn into_response(self) -> Response {
        self.0
    }
}

impl<For> Deref for HtmlResponse<For> {
    type Target = Response;

    fn deref(&self) -> &Response {
        &self.0
    }
}

impl<For> DerefMut for HtmlResponse<For> {
    fn deref_mut(&mut self) -> &mut Response {
        &mut self.0
    }
}

impl Answer for HtmlResponse {
    const FORMAT: Format = Format::Html;
    const PAGE: bool = true;
    type Inputs = AnyInputs;
    type Rows = NotAFeed;
}

/// An answer that can be [`Public`], and what it is there: the same answer, made for everyone.
/// An [`HtmlResult`] becomes a `Result<HtmlResponse<ForAll>>`, so the `Req` methods that make
/// it make it for everyone and it cannot set a cookie; an answer that cannot set one (text, JSON,
/// a [`Relay`]) stays itself. An answer type of the app's own implements it (with
/// [`ForEveryone`] for `ForAll`) only when it sets no cookie.
#[diagnostic::on_unimplemented(
    message = "`{Self}` cannot be `Public`",
    note = "a `Public` answer is a page, a patch or a redirect (`HtmlResult`), `JsonResult<T>`, text, a status, a `Relay`, `Media`, a `PageOr` of either, a live stream or a feed"
)]
pub trait Shareable {
    /// The answer as [`Public::new`] takes it.
    type ForAll: ForEveryone<Named = Self>;
}

/// An answer made for everyone, as [`Public::new`] takes it, and the answer type a handler
/// names for it (`Named`): `Result<HtmlResponse<ForAll>>` is named `HtmlResult`. Lets
/// `Public::new(age, answer)` find its type from `answer` where no return type says it (a
/// closure).
#[diagnostic::on_unimplemented(
    message = "`{Self}` is not an answer made for everyone, so it cannot be `Public`",
    note = "a page made for one visitor (`HtmlResult`) cannot be: make it in the handler that returns `Public<HtmlResult>`, or have a helper return `corten::Result<HtmlResponse<For>>` for any `For`; a `Public` answer is a page, a patch or a redirect, `JsonResult<T>`, text, a status, a `Relay`, `Media`, a `PageOr` of either, a live stream or a feed"
)]
pub trait ForEveryone: IntoResponse {
    /// The answer type a handler names: `Public<Self::Named>`.
    type Named: Shareable;

    /// Itself, as the type `Public<Self::Named>` holds (the same type, named another way).
    #[doc(hidden)]
    fn for_all(self) -> <Self::Named as Shareable>::ForAll;
}

impl ForEveryone for HtmlResponse<ForAll> {
    type Named = HtmlResponse;

    fn for_all(self) -> Self {
        self
    }
}

impl<A: ForEveryone> ForEveryone for Result<A, Error> {
    type Named = Result<A::Named, Error>;

    fn for_all(self) -> Result<<A::Named as Shareable>::ForAll, Error> {
        self.map(A::for_all)
    }
}

#[cfg(feature = "json")]
impl<A: ForEveryone> ForEveryone for std::result::Result<A, JsonError> {
    type Named = std::result::Result<A::Named, JsonError>;

    fn for_all(self) -> std::result::Result<<A::Named as Shareable>::ForAll, JsonError> {
        self.map(A::for_all)
    }
}

/// An answer that is itself everywhere: it sets no cookie.
macro_rules! for_everyone {
    ($($ty:ty),* $(,)?) => {$(
        impl ForEveryone for $ty {
            type Named = Self;

            fn for_all(self) -> Self {
                self
            }
        }
        impl Shareable for $ty {
            type ForAll = Self;
        }
    )*};
}

for_everyone!(&'static str, String, StatusCode, Relay, Media, LiveResponse);

#[cfg(feature = "feed")]
impl<T> ForEveryone for corten_feed::FeedResponse<T> {
    type Named = Self;

    fn for_all(self) -> Self {
        self
    }
}

#[cfg(feature = "feed")]
impl<T> Shareable for corten_feed::FeedResponse<T> {
    type ForAll = Self;
}

impl Shareable for HtmlResponse {
    type ForAll = HtmlResponse<ForAll>;
}

impl<A: Shareable> Shareable for Result<A, Error> {
    type ForAll = Result<A::ForAll, Error>;
}

#[cfg(feature = "json")]
impl<A: Shareable> Shareable for std::result::Result<A, JsonError> {
    type ForAll = std::result::Result<A::ForAll, JsonError>;
}

#[cfg(feature = "json")]
impl<T> Shareable for crate::Json<T>
where
    crate::Json<T>: IntoResponse,
{
    type ForAll = Self;
}

#[cfg(feature = "json")]
impl<T> ForEveryone for crate::Json<T>
where
    crate::Json<T>: IntoResponse,
{
    type Named = Self;

    fn for_all(self) -> Self {
        self
    }
}

/// What a page handler returns: `async fn item(req: Req) -> HtmlResult`. A failure is the app's
/// error page for a browser.
pub type HtmlResult = crate::Result<HtmlResponse>;

/// What a JSON handler returns: `async fn price(..) -> JsonResult<Quote>`. Every failure of the
/// route, a path or body that does not parse included, is JSON. Its error is a [`JsonError`], so
/// the handler `?`s its input's field errors (a 422 with the fields) next to any other error.
#[cfg(feature = "json")]
pub type JsonResult<T> = std::result::Result<crate::Json<T>, JsonError>;

/// A JSON answer with a status or a cookie of its own, made from [`crate::Json`]:
/// `Json(started).with_status(StatusCode::ACCEPTED)`, `Json(session).with_cookie(cookie)`. Its
/// handler returns `Result<JsonResponse, JsonError>` where one that answers `200` with no cookie
/// returns [`JsonResult<T>`]. The value is written when it is made, with the same headers as any
/// JSON answer; it derefs to the response for any other header of the handler's own. One made
/// from a [`Relay`] (`relay.into()`, below) stays the upstream's: its status, headers and body.
///
/// A status here is the app's own answer, body and all: `503 {"error":"No forecast yet"}` reaches
/// the client as written. A failure (`Err`) is answered as every failure of a JSON route is, a
/// Problem Details document (`application/problem+json`, `{"title","status","detail"}`), except
/// a refusal in the app's own shape, `Err(answer)?` ([`JsonError::Own`]), which is answered as
/// written, and a failure on a route that says `unstaged` outside an API's prefix, which has no
/// stage to shape it and sends the status's reason as plain text. A refusal (a 4xx or 5xx of the app's) is that `Err`; `Ok` is for the route's answers
/// and another server's passed on.
///
/// ```
/// use corten::{http::StatusCode, json::Raw, prelude::*, security::cookie::SetCookie, JsonError, JsonResponse};
///
/// #[derive(serde::Serialize, ToJson)]
/// struct Started { ok: bool }
///
/// #[derive(serde::Serialize, ToJson)]
/// struct Problem { error: &'static str }
///
/// async fn refresh() -> Result<JsonResponse, JsonError> {
///     Ok(Json(Started { ok: true }).with_status(StatusCode::ACCEPTED))
/// }
///
/// async fn capacity(State(forecast): State<Option<Raw>>) -> Result<JsonResponse, JsonError> {
///     match forecast {
///         Some(doc) => Ok(Json(doc).into()),
///         None => Err(Json(Problem { error: "No capacity forecast yet" }).with_status(StatusCode::SERVICE_UNAVAILABLE).into()),
///     }
/// }
///
/// async fn sign_in() -> Result<JsonResponse, JsonError> {
///     let token = "c2Vzc2lvbg";
///     Ok(Json(Started { ok: true }).with_cookie(SetCookie::try_new("session", token)?))
/// }
/// # let _ = (refresh, capacity, sign_in);
/// ```
///
/// A cookie is a [`SetCookie`](crate::security::cookie::SetCookie), so its safe flags are the
/// default; text does not compile:
///
/// ```compile_fail,E0308
/// use corten::prelude::*;
///
/// let _ = Json(1).with_cookie("session=abc");
/// ```
///
/// It answers the visitor who asked, so it is never a [`Public`] answer: a cache would give its
/// cookie to everyone. A public JSON answer is a [`JsonResult<T>`], held bytes included
/// (`Public<JsonResult<Raw>>`), whose refusal may be a `JsonResponse`: a refusal is never
/// shared, and one that sets a cookie is private.
///
/// ```compile_fail,E0277
/// use std::time::Duration;
/// use corten::{prelude::*, JsonError, JsonResponse};
///
/// async fn rates() -> Public<Result<JsonResponse, JsonError>> {
///     let answer: Result<JsonResponse, JsonError> = Ok(Json(1).into());
///     Public::new(Duration::from_secs(60), answer)
/// }
/// ```
#[cfg(feature = "json")]
pub struct JsonResponse(Response);

/// Its status and type, not its headers: a cookie it sets (a session) stays out of logs.
#[cfg(feature = "json")]
impl std::fmt::Debug for JsonResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonResponse")
            .field("status", &self.0.status())
            .field("content_type", &self.0.headers().get(http::header::CONTENT_TYPE))
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "json")]
impl JsonResponse {
    /// The answer with `status`. A status that has no body (`204`, `304`, a `1xx`) is not one
    /// for a JSON answer: a debug build panics, where a bare `StatusCode` answer is the way.
    #[must_use]
    #[track_caller]
    pub fn with_status(mut self, status: StatusCode) -> Self {
        debug_assert!(
            !(status.is_informational()
                || matches!(status, StatusCode::NO_CONTENT | StatusCode::RESET_CONTENT | StatusCode::NOT_MODIFIED)),
            "corten: {status} has no body, so it is not a JSON answer's status; answer with the StatusCode itself"
        );
        *self.0.status_mut() = status;
        self
    }

    /// The answer with a `Set-Cookie` header, as [`HtmlResponse::with_cookie`]: each call adds
    /// one, and an answer that sets a cookie is never stored by a shared cache. Never append a
    /// `Set-Cookie` header by hand.
    #[must_use]
    pub fn with_cookie(mut self, cookie: crate::security::cookie::SetCookie) -> Self {
        self.0.headers_mut().append(http::header::SET_COOKIE, cookie.header());
        self
    }
}

#[cfg(feature = "json")]
impl<T: crate::json::ToJson> crate::Json<T> {
    /// This value answered with `status`: [`JsonResponse::with_status`].
    #[must_use]
    #[track_caller]
    pub fn with_status(self, status: StatusCode) -> JsonResponse {
        JsonResponse::from(self).with_status(status)
    }

    /// This value answered with a cookie: [`JsonResponse::with_cookie`].
    #[must_use]
    pub fn with_cookie(self, cookie: crate::security::cookie::SetCookie) -> JsonResponse {
        JsonResponse::from(self).with_cookie(cookie)
    }
}

#[cfg(feature = "json")]
impl<T: crate::json::ToJson> From<crate::Json<T>> for JsonResponse {
    fn from(json: crate::Json<T>) -> Self {
        JsonResponse(json.into_response())
    }
}

/// Another server's answer, in a JSON route that answers some requests itself and passes the rest
/// on (a route moved off another service a part at a time, a cache in front of an upstream):
/// `Ok(relay.into())`. It stays the upstream's answer, as a [`Relay`] is anywhere: never
/// compressed by the app, and its failure status passed on with its body rather than written as
/// the route's JSON error.
///
/// ```
/// use corten::{http::{Body, HeaderMap, StatusCode}, prelude::*, JsonError, JsonResponse, Relay};
///
/// #[derive(ToJson)]
/// struct Order { id: u32 }
///
/// async fn order(ported: bool) -> Result<JsonResponse, JsonError> {
///     if ported {
///         return Ok(Json(Order { id: 7 }).into());
///     }
///     // The old service's answer, from the app's HTTP client.
///     let (status, headers, body) = (StatusCode::OK, HeaderMap::new(), Body::from(r#"{"id":7}"#));
///     Ok(Relay::new(status, headers, body).into())
/// }
/// # let _ = order;
/// ```
#[cfg(feature = "json")]
impl From<Relay> for JsonResponse {
    fn from(relay: Relay) -> Self {
        JsonResponse(relay.0)
    }
}

#[cfg(feature = "json")]
impl IntoResponse for JsonResponse {
    fn into_response(self) -> Response {
        self.0
    }
}

#[cfg(feature = "json")]
impl Deref for JsonResponse {
    type Target = Response;

    fn deref(&self) -> &Response {
        &self.0
    }
}

#[cfg(feature = "json")]
impl DerefMut for JsonResponse {
    fn deref_mut(&mut self) -> &mut Response {
        &mut self.0
    }
}

#[cfg(feature = "json")]
impl Answer for JsonResponse {
    const FORMAT: Format = Format::Json;
    type Inputs = AnyInputs;
    type Rows = NotAFeed;
}

/// A JSON handler's error: an [`Error`] (`?` on any error, as in a page handler), the
/// input's field errors, `?` on [`crate::Errors`], answered as the 422 with `fields` (409 or 410
/// for [`crate::Errors::refuse`]), or a refusal in the app's own shape, `?` on a
/// [`JsonResponse`] ([`JsonError::Own`]). Only a
/// JSON handler takes field errors this way: a page shows its form again with
/// [`crate::Req::invalid`], so `?` on `Errors` there does not compile:
///
/// ```compile_fail,E0277
/// use corten::prelude::*;
///
/// fn check(email: &str) -> Result<(), Errors> {
///     let mut errors = Errors::new();
///     if !email.contains('@') {
///         errors.add_form("Enter an email address.");
///     }
///     errors.into_result(())
/// }
///
/// async fn sign_up(req: Req) -> HtmlResult {
///     check("ada")?;
///     req.page(html! { <html><head><title>"Hi"</title><Corten /></head><body><main>"Hi"</main></body></html> })
/// }
/// ```
#[cfg(feature = "json")]
#[derive(Debug)]
pub enum JsonError {
    /// Any failure, answered as every failure of a JSON route is.
    Error(Error),
    /// The input's field errors: 422 (or the refusal's status), `{"title","status","detail","fields":{..}}`.
    Fields(crate::Errors),
    /// A refusal in the app's own shape (another server's `{"error": ".."}` the route keeps),
    /// answered as written, status and body: `Err(refused(..))?`, where `refused` makes a
    /// [`JsonResponse`]. It is boxed, so the error stays small and a helper returning
    /// `Result<_, JsonError>` passes clippy's `result_large_err`.
    ///
    /// ```
    /// use corten::{http::StatusCode, prelude::*, JsonError, JsonResponse};
    ///
    /// #[derive(ToJson)]
    /// struct Problem<'a> { error: &'a str }
    ///
    /// #[derive(ToJson)]
    /// struct Batch<'a> { batch: &'a str }
    ///
    /// fn refused(status: StatusCode, error: &str) -> JsonResponse {
    ///     Json(Problem { error }).with_status(status)
    /// }
    ///
    /// fn created(request: Option<&str>) -> Result<JsonResponse, JsonError> {
    ///     let id = request
    ///         .filter(|id| !id.trim().is_empty())
    ///         .ok_or_else(|| refused(StatusCode::BAD_REQUEST, "requestId is required"))?;
    ///     Ok(Json(Batch { batch: id }).with_status(StatusCode::CREATED))
    /// }
    /// # assert_eq!(created(None).unwrap_err().into_response().status(), StatusCode::BAD_REQUEST);
    /// # use corten::http::IntoResponse;
    /// ```
    ///
    /// A refusal is a client or server error. One with another status is a bug: a debug build
    /// panics, and in release it is logged and answered as a failure (500), never as written.
    Own(Box<JsonResponse>),
}

#[cfg(feature = "json")]
impl From<JsonResponse> for JsonError {
    #[track_caller]
    fn from(answer: JsonResponse) -> Self {
        JsonError::refusal(answer, cfg!(debug_assertions))
    }
}

#[cfg(feature = "json")]
impl JsonError {
    /// `answer` as a refusal; one with a status that is not a 4xx or 5xx panics when `strict` (a
    /// debug build) and is a failure (500) otherwise, never answered as written.
    #[track_caller]
    pub(crate) fn refusal(answer: JsonResponse, strict: bool) -> Self {
        let status = answer.status();
        if status.is_client_error() || status.is_server_error() {
            return JsonError::Own(Box::new(answer));
        }
        let message = format!(
            "a JSON route refuses with a 4xx or 5xx, not {status} (at {}); answer Ok(..) for any other status",
            std::panic::Location::caller()
        );
        assert!(!strict, "corten: {message}");
        JsonError::Error(Error::new(message))
    }
}

#[cfg(feature = "json")]
impl<E: Into<Error>> From<E> for JsonError {
    fn from(error: E) -> Self {
        JsonError::Error(error.into())
    }
}

#[cfg(feature = "json")]
impl From<crate::Errors> for JsonError {
    fn from(errors: crate::Errors) -> Self {
        JsonError::Fields(errors)
    }
}

#[cfg(feature = "json")]
impl IntoResponse for JsonError {
    fn into_response(self) -> Response {
        match self {
            JsonError::Error(error) => error.into_response(),
            JsonError::Fields(errors) => errors.into_response(),
            JsonError::Own(answer) => answer.into_response(),
        }
    }
}

#[cfg(feature = "json")]
impl<A: Answer> Answer for std::result::Result<A, JsonError> {
    const FORMAT: Format = A::FORMAT;
    const PAGE: bool = A::PAGE;
    type Inputs = A::Inputs;
    type Rows = A::Rows;
}

#[cfg(feature = "json")]
impl<T> Answer for crate::Json<T>
where
    crate::Json<T>: IntoResponse,
{
    const FORMAT: Format = Format::Json;
    type Inputs = AnyInputs;
    type Rows = NotAFeed;
}

impl<A: Answer> Answer for Result<A, Error> {
    const FORMAT: Format = A::FORMAT;
    const PAGE: bool = A::PAGE;
    type Inputs = A::Inputs;
    type Rows = A::Rows;
}

impl Answer for &'static str {
    const FORMAT: Format = Format::Html;
    type Inputs = AnyInputs;
    type Rows = NotAFeed;
}

impl Answer for String {
    const FORMAT: Format = Format::Html;
    type Inputs = AnyInputs;
    type Rows = NotAFeed;
}

/// A status and no body: `StatusCode::NO_CONTENT` for a write that has nothing to say. An error
/// status is answered as any failure of the route is.
impl Answer for StatusCode {
    const FORMAT: Format = Format::Html;
    type Inputs = AnyInputs;
    type Rows = NotAFeed;
}

/// Another server's answer, passed on as it came, for a route that relays an upstream (a gateway,
/// a backend for a frontend): its status, its headers less the hop-by-hop ones (`Connection` and
/// the headers it names, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`,
/// `Trailer`, `Transfer-Encoding`, `Upgrade`), and its body as it arrives. A failure status is
/// passed on with the upstream's body, never replaced by the error page or the JSON error, and
/// the app's security and cache rules still apply to it, except that a `Content-Security-Policy`
/// the upstream sent is kept in place of the app's: a relayed page needs the policy its own HTML
/// was written for (its scripts' nonces and hosts). Without one, the app's applies. Corten does
/// not compress it: its encoding is the upstream's (forward the client's `Accept-Encoding` to
/// have the upstream compress, with an HTTP client that does not decode the body: for reqwest,
/// without its `gzip`, `brotli` and `zstd` features). When the client
/// leaves, the body is dropped, and with it the upstream request. What else to drop
/// (`Set-Cookie`, say) is the route's to decide before it builds the answer.
///
/// ```
/// use corten::{http::{Body, HeaderMap, StatusCode}, prelude::*, Relay};
///
/// async fn models() -> corten::Result<Relay> {
///     // The upstream's answer, from the app's HTTP client: for reqwest,
///     // `Relay::new(res.status(), res.headers().clone(), Body::from_stream(res.bytes_stream()))`.
///     let (status, headers, body) = (StatusCode::BAD_GATEWAY, HeaderMap::new(), Body::from("upstream down"));
///     Ok(Relay::new(status, headers, body))
/// }
/// # let _: Methods = get(models);
/// ```
pub struct Relay(Response);

impl Relay {
    /// The answer with `status`, `headers` (hop-by-hop ones removed) and `body`.
    pub fn new(status: StatusCode, mut headers: http::HeaderMap, body: Body) -> Self {
        use http::header;
        let named: Vec<String> = headers
            .get_all(header::CONNECTION)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .map(|name| name.trim().to_ascii_lowercase())
            .filter(|name| !name.is_empty())
            .collect();
        for name in &named {
            headers.remove(name.as_str());
        }
        for name in [
            header::CONNECTION,
            header::PROXY_AUTHENTICATE,
            header::PROXY_AUTHORIZATION,
            header::TE,
            header::TRAILER,
            header::TRANSFER_ENCODING,
            header::UPGRADE,
        ] {
            headers.remove(name);
        }
        headers.remove("keep-alive");
        let features = headers.contains_key("permissions-policy");
        let mut res = Response::new(body);
        *res.status_mut() = status;
        *res.headers_mut() = headers;
        res.extensions_mut().insert(Relayed { features });
        Relay(res)
    }
}

impl IntoResponse for Relay {
    fn into_response(self) -> Response {
        self.0
    }
}

impl Answer for Relay {
    const FORMAT: Format = Format::Html;
    type Inputs = AnyInputs;
    type Rows = NotAFeed;
}

/// Bytes the app holds, sent as their media type: a picture a user uploaded, a document the app
/// made, or bytes it makes as they are sent ([`Media::stream`]). The type is one the app names
/// (`"image/png"`), never the one a client sent with the bytes: read an upload's type from its
/// first bytes. What keeps a file that holds HTML from running as a page is the app's headers,
/// which every `Media` gets: browsers do not guess another type
/// (`X-Content-Type-Options: nosniff`), and the CSP allows no inline script. A route that says
/// `unstaged` has no stages, and its answer gets `nosniff` and `Content-Security-Policy:
/// sandbox` instead, whatever its type. A PDF sent [`Media::inline`] from an unstaged route still
/// shows in Chrome's, Edge's and Firefox's viewers (Safari's was not checked); a PDF that must
/// open in every browser is sent from a route with stages or as an attachment.
///
/// It is cached as anything the app answers is (`private, no-cache`), except on an unstaged route,
/// which sends no `Cache-Control` unless the handler says one. At a URL that names its
/// content, a hash of the bytes, the bytes never change, so [`Public::immutable`] lets every cache
/// keep it for a year, as Corten's own versioned files are; its handler cannot read who is asking,
/// as any `Public` handler cannot.
///
/// ```
/// use corten::{prelude::*, Media};
///
/// #[corten::routes]
/// mod url {
///     #[route("/pictures/{id}", get = picture)]
///     pub struct Picture<'a> {
///         pub id: &'a str,
///     }
/// }
///
/// // `id` is a hash of the picture's bytes, made when it was uploaded.
/// async fn picture(picture: Params<url::Picture<'_>>) -> Public<corten::Result<Media>> {
///     let png: &'static [u8] = b"\x89PNG\r\n\x1a\n";
///     Public::immutable(match picture.id.as_str() {
///         "5f2c" => Ok(Media::new("image/png", png)),
///         _ => Err(corten::Error::not_found()),
///     })
/// }
/// # let _ = App::new(url::router()).router();
/// ```
pub struct Media(Response);

impl Media {
    /// `bytes`, sent as `media_type` (`"image/webp"`), a valid header value.
    pub fn new(media_type: &'static str, bytes: impl Into<bytes::Bytes>) -> Self {
        use http::header;
        use http::HeaderValue;
        let mut res = Response::new(crate::body::Body::from(bytes.into()));
        res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(media_type));
        Media(res)
    }

    /// Bytes the app makes as they are sent, as `media_type`: an export too large to hold (every
    /// order as CSV, an archive) goes out a chunk at a time, and the client has the first chunk
    /// before the last is made. The stream is pulled only as fast as the client reads, so memory
    /// stays at a few chunks however large the file, and when the client leaves it is dropped,
    /// which stops whatever makes it (a database cursor, a channel whose sender then fails).
    ///
    /// ```
    /// use corten::{http::Bytes, prelude::*, Media};
    /// use futures_util::StreamExt;
    ///
    /// async fn export() -> Media {
    ///     // A page of rows at a time, from the app's store.
    ///     let pages = futures_util::stream::iter(0..3).map(|page| {
    ///         let rows: String = (0..500).map(|i| format!("{},card {i}\n", page * 500 + i)).collect();
    ///         Ok::<_, std::io::Error>(Bytes::from(rows))
    ///     });
    ///     Media::stream("text/csv", pages).attachment("orders.csv")
    /// }
    /// # let _: Methods = get(export);
    /// ```
    ///
    /// Everything else is `Media`'s: its file name ([`Media::attachment`]), its headers, private
    /// unless [`Public`]. A text type is compressed a chunk at a time as it comes (zstd or brotli,
    /// as an event stream is, each ended when the stream ends), so a chunk of some kilobytes (a
    /// few hundred rows) compresses far better than a row each. It goes out uncompressed in two
    /// cases: to a client that takes only gzip (a script whose HTTP library has neither brotli
    /// nor zstd), and while the server's compressed streams already hold their memory budget. No
    /// `ETag` is made for it, since that would need the whole body.
    ///
    /// What can fail before anything is sent (a query that does not run, a file that is not
    /// there) is the handler's to try first, returning its error as any handler does: once the
    /// stream begins, the status and headers are sent. A chunk that is an `Err` after that ends
    /// the connection without the body's end, so the client knows the file is incomplete (a
    /// browser reports the download failed), and the error is logged; it cannot become an error
    /// page or a redirect. The request's deadline bounds the handler, not the stream, and
    /// [`App::send_timeout`](crate::App::send_timeout) closes a connection whose client stops
    /// reading; nothing bounds a source that stops making chunks while the client waits, so give
    /// each chunk's read a time limit of its own (a query timeout). The error a failed chunk
    /// logs names the media type, so say which export it was in the error itself. Without a
    /// known length the body is chunked (HTTP/1.1) and the client shows no progress;
    /// [`Media::stream_sized`] gives one.
    pub fn stream<S, E>(media_type: &'static str, chunks: S) -> Self
    where
        S: futures_util::Stream<Item = Result<bytes::Bytes, E>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        Media::streamed(media_type, None, chunks)
    }

    /// [`Media::stream`] of `length` bytes, sent as its `Content-Length`, so the client shows
    /// how much is left. The stream must make exactly that many: one that makes more, or ends
    /// with fewer, ends the connection there and is logged, as a failed chunk is. A compressed
    /// one is sent without the length, which is the uncompressed size (one under a kilobyte is
    /// not compressed, and keeps it); a `HEAD` gets the headers without the body, and the
    /// stream is never pulled.
    pub fn stream_sized<S, E>(media_type: &'static str, length: u64, chunks: S) -> Self
    where
        S: futures_util::Stream<Item = Result<bytes::Bytes, E>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        let mut media = Media::streamed(media_type, Some(length), chunks);
        media.0.headers_mut().insert(http::header::CONTENT_LENGTH, http::HeaderValue::from(length));
        media
    }

    fn streamed<S, E>(media_type: &'static str, length: Option<u64>, chunks: S) -> Self
    where
        S: futures_util::Stream<Item = Result<bytes::Bytes, E>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        use futures_util::StreamExt;
        use http::header;
        use http::HeaderValue;
        // Each chunk passed on as it comes; a failure, or a length the stream does not keep,
        // logged and ended as an error, which ends the connection without the body's end.
        let checked = futures_util::stream::unfold(Some((Box::pin(chunks), length)), move |state| async move {
            let (mut chunks, left) = state?;
            let failed = |why: String| {
                tracing::error!("corten: a streamed {media_type} answer stopped after its headers were sent: {why}");
                Some((Err(StreamFailed), None))
            };
            match chunks.next().await {
                Some(Ok(bytes)) => match left.map(|left| left.checked_sub(bytes.len() as u64)) {
                    Some(None) => failed(format!("it made more than the {} bytes it said", length.unwrap_or(0))),
                    Some(Some(left)) => Some((Ok(bytes), Some((chunks, Some(left))))),
                    None => Some((Ok(bytes), Some((chunks, None)))),
                },
                Some(Err(error)) => failed(error.to_string()),
                None => match left {
                    Some(left) if left > 0 => failed(format!("it ended {left} bytes short of the length it said")),
                    _ => None,
                },
            }
        });
        let mut res = Response::new(crate::body::Body::from_stream(checked));
        res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(media_type));
        res.extensions_mut().insert(Streamed);
        Media(res)
    }

    /// Saved as a file named `file_name` rather than shown (`Content-Disposition: attachment`):
    /// a user's export. It stays private like any answer that is not [`Public`].
    ///
    /// ```
    /// use corten::{prelude::*, Media};
    ///
    /// async fn export() -> Media {
    ///     Media::new("text/csv", "id,name\n7,Pikachu\n").attachment("shipments-2026-10-29.csv")
    /// }
    /// # let _: Methods = get(export);
    /// ```
    ///
    /// A plain ASCII name is written `filename="cards.csv"`, and any other with
    /// `filename*=UTF-8''..` (RFC 6266), which browsers read, after a `filename` with `_` for
    /// each other character, for a client that does not. A quote, a backslash, a `%`, a `?`
    /// (`=?..?=` is decoded as RFC 2047 by some browsers) or a control character never reaches
    /// the header unencoded, so a name from user data cannot end the header or add a parameter.
    /// The browser still cleans the name it saves (a `/`, a `:`, a control character) as it does
    /// any. An empty name sends no `filename`, and the browser names the file from the URL. The
    /// last of `attachment` and [`Media::inline`] given is the one sent.
    ///
    /// A link to it takes `download` (`<a href={export} download>`), or `data-reload` for an
    /// `inline` file the browser shows: either keeps the runtime from fetching it on hover and on
    /// click, which would run its handler twice.
    ///
    /// It is the one way to name a download, so a [`Public`] answer cannot set the header itself:
    ///
    /// ```compile_fail,E0080
    /// use std::time::Duration;
    /// use corten::{answer::Header, http::HeaderValue, prelude::*, Media};
    ///
    /// struct Disposition;
    /// impl Header for Disposition {
    ///     const NAME: &'static str = "content-disposition";
    /// }
    ///
    /// async fn catalog() -> Public<Media> {
    ///     let name = HeaderValue::from_static("attachment; filename=\"cards.csv\"");
    ///     Public::new(Duration::from_secs(60), Media::new("text/csv", "id\n")).header::<Disposition>(name)
    /// }
    /// # let _: Methods = get(catalog);
    /// ```
    pub fn attachment(self, file_name: &str) -> Self {
        self.disposition("attachment", file_name)
    }

    /// Shown in the browser when it can be (a PDF in its viewer), and saved as `file_name` when
    /// the user saves it (`Content-Disposition: inline`). Written as [`Media::attachment`]'s.
    pub fn inline(self, file_name: &str) -> Self {
        self.disposition("inline", file_name)
    }

    fn disposition(mut self, kind: &str, file_name: &str) -> Self {
        let value = disposition(kind, file_name);
        let value = http::HeaderValue::try_from(value).expect("a disposition is visible ASCII");
        self.0.headers_mut().insert(http::header::CONTENT_DISPOSITION, value);
        self
    }
}

/// `{kind}; filename="{name}"`, and `; filename*=UTF-8''{name}` when the name is not plain
/// ASCII: each character outside it is `_` in `filename`, and each byte outside RFC 8187's
/// `attr-char` is %-encoded in `filename*`. A `%` and a `?` are not plain either, since some
/// clients decode `%XX` and RFC 2047's `=?..?=` in `filename` (RFC 6266, appendix D). An empty
/// name is `{kind}` alone.
fn disposition(kind: &str, name: &str) -> String {
    if name.is_empty() {
        return kind.to_string();
    }
    let plain = |c: char| matches!(c, ' '..='~') && !matches!(c, '"' | '\\' | '%' | '?');
    let mut out = String::with_capacity(kind.len() + name.len() + 13);
    out.push_str(kind);
    out.push_str("; filename=\"");
    out.extend(name.chars().map(|c| if plain(c) { c } else { '_' }));
    out.push('"');
    if !name.chars().all(plain) {
        out.push_str("; filename*=UTF-8''");
        for b in name.bytes() {
            if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) {
                out.push(char::from(b));
            } else {
                out.push('%');
                out.push(char::from(b"0123456789ABCDEF"[usize::from(b >> 4)]));
                out.push(char::from(b"0123456789ABCDEF"[usize::from(b & 15)]));
            }
        }
    }
    out
}

/// A [`Media::stream`]'s answer, which compression takes a chunk at a time.
#[derive(Clone)]
pub(crate) struct Streamed;

/// What ends a streamed answer that failed after it began (logged where it happened).
#[derive(Debug)]
struct StreamFailed;

impl std::fmt::Display for StreamFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the streamed answer failed")
    }
}

impl std::error::Error for StreamFailed {}

impl IntoResponse for Media {
    fn into_response(self) -> Response {
        self.0
    }
}

impl Answer for Media {
    const FORMAT: Format = Format::Html;
    type Inputs = AnyInputs;
    type Rows = NotAFeed;
}

/// A file or a page: what a route that sends a file ([`Media`], a [`Relay`] of another service's)
/// answers when it may instead send the page with why, or a redirect to it. A download posted
/// from a page (this run's CSV, at the revision the page showed) is refused when the run moved on,
/// and the user gets the page again saying so, not an error page. Each is `.into()` the answer.
///
/// ```
/// use corten::{prelude::*, Media, PageOr};
///
/// #[corten::routes]
/// mod url {
///     #[route("/runs/{id}", get = run)]
///     pub struct Run<'a> {
///         pub id: &'a str,
///         pub said: Option<&'a str>,
///     }
///
///     #[route("/runs/{id}/download", post = download)]
///     pub struct Download<'a> {
///         pub id: &'a str,
///     }
/// }
/// # async fn run(_: Params<url::Run<'_>>) -> &'static str { "run" }
///
/// async fn download(req: Req, at: Params<url::Download<'_>>) -> corten::Result<PageOr<Media>> {
///     let current = at.id.as_str() == "7";
///     if !current {
///         return Ok(req.redirect(&url::Run { id: &at.id, said: Some("stale") })?.into());
///     }
///     Ok(Media::new("text/csv", "sku,qty\n").into())
/// }
/// # let _ = App::new(url::router()).router();
/// ```
///
/// It is for the visitor who asked, as a page is; inside [`Public`] the page is one made for
/// everyone. `.into()` cannot infer the type through [`Public::new`], so name the variant:
///
/// ```
/// use std::time::Duration;
/// use corten::{prelude::*, Media, PageOr};
///
/// #[corten::routes]
/// mod url {
///     #[route("/reports", get = reports)]
///     pub struct Reports;
///
///     #[route("/reports/latest.csv", get = latest)]
///     pub struct Latest;
/// }
/// # async fn reports() -> &'static str { "reports" }
///
/// async fn latest(req: Req) -> Public<corten::Result<PageOr<Media>>> {
///     let ready = false;
///     let answer = if ready {
///         Ok(PageOr::Answer(Media::new("text/csv", "sku,qty\n")))
///     } else {
///         req.redirect(&url::Reports).map(PageOr::Page)
///     };
///     Public::new(Duration::from_secs(60), answer)
/// }
/// # let _ = App::new(url::router()).router();
/// ```
///
/// The other answer is a file, [`Media`] or [`Relay`]; text or a status is not one:
///
/// ```compile_fail,E0277
/// use corten::{Answer, PageOr};
///
/// fn route_answer<A: Answer>() {}
/// route_answer::<PageOr<&'static str>>();
/// ```
pub enum PageOr<A, For = ForOne> {
    /// A page, a patch or a redirect, from [`Req`].
    Page(HtmlResponse<For>),
    /// The file.
    Answer(A),
}

impl<For> From<HtmlResponse<For>> for PageOr<Media, For> {
    fn from(page: HtmlResponse<For>) -> Self {
        PageOr::Page(page)
    }
}

impl<For> From<HtmlResponse<For>> for PageOr<Relay, For> {
    fn from(page: HtmlResponse<For>) -> Self {
        PageOr::Page(page)
    }
}

impl<For> From<Media> for PageOr<Media, For> {
    fn from(media: Media) -> Self {
        PageOr::Answer(media)
    }
}

impl<For> From<Relay> for PageOr<Relay, For> {
    fn from(relay: Relay) -> Self {
        PageOr::Answer(relay)
    }
}

impl<A: FileAnswer, For> IntoResponse for PageOr<A, For> {
    fn into_response(self) -> Response {
        match self {
            PageOr::Page(page) => page.into_response(),
            PageOr::Answer(answer) => answer.into_response(),
        }
    }
}

/// What a [`PageOr`] answers besides a page: a [`Media`] or a [`Relay`]. Sealed, so a page
/// route's other answers (text, a status, a feed) are not the file slot.
pub trait FileAnswer: Answer + file_answer::Sealed {}

impl FileAnswer for Media {}
impl FileAnswer for Relay {}

mod file_answer {
    pub trait Sealed {}
    impl Sealed for super::Media {}
    impl Sealed for super::Relay {}
}

impl<A: FileAnswer> Answer for PageOr<A> {
    const FORMAT: Format = Format::Html;
    const PAGE: bool = true;
    type Inputs = AnyInputs;
    type Rows = NotAFeed;
}

impl<A: FileAnswer + ForEveryone<Named = A> + Shareable<ForAll = A>> Shareable for PageOr<A> {
    type ForAll = PageOr<A, ForAll>;
}

impl<A: FileAnswer + ForEveryone<Named = A> + Shareable<ForAll = A>> ForEveryone for PageOr<A, ForAll> {
    type Named = PageOr<A>;

    fn for_all(self) -> Self {
        self
    }
}

/// On a [`Relay`]'s response: its failure status and its encoding are the upstream's, passed on
/// as they are. `features`: the upstream sent a `Permissions-Policy`, which the page keeps.
#[derive(Clone, Copy)]
pub(crate) struct Relayed {
    pub(crate) features: bool,
}

/// Fragments streamed to `<corten-live>`: what [`crate::live`] gives.
pub struct LiveResponse(pub(crate) Response);

impl IntoResponse for LiveResponse {
    fn into_response(self) -> Response {
        self.0
    }
}

impl Answer for LiveResponse {
    const FORMAT: Format = Format::Html;
    type Inputs = AnyInputs;
    type Rows = NotAFeed;
}

/// A feed's snapshot or live stream, read by the runtime.
#[cfg(feature = "feed")]
impl<T> Answer for corten_feed::FeedResponse<T> {
    const FORMAT: Format = Format::Json;
    type Inputs = AnyInputs;
    type Rows = T;
}

#[cfg(feature = "feed")]
impl<T> IntoResponse for corten_feed::FeedResponse<T> {
    fn into_response(self) -> Response {
        self.into_http().map(Body::new)
    }
}

/// An answer that is the same for everyone, so any cache (a CDN, a proxy) may keep it:
/// `async fn home(req: Req) -> Public<HtmlResult>`. Its handler may only read inputs that cannot
/// tell who is asking ([`Anonymous`]), so a `Caller`, a `HeaderMap` or a cookie there does not
/// compile:
///
/// ```compile_fail,E0277
/// use std::time::Duration;
/// use corten::{http::HeaderMap, prelude::*};
///
/// #[corten::routes]
/// mod url {
///     #[route("/", get = home)]
///     pub struct Home;
/// }
///
/// async fn home(headers: HeaderMap) -> Public<&'static str> {
///     let _ = headers.get("cookie");
///     Public::new(Duration::from_secs(60), "home")
/// }
/// # fn main() { let _ = url::router(); }
/// ```
///
/// Only a successful answer is shared; a failure keeps the default, `private, no-cache`. The rules
/// of [`crate::cache`] still apply when it is sent: a request with a cookie, or a page with the
/// request's nonce, is answered privately.
pub struct Public<A: Shareable> {
    cache: Cache,
    answer: A::ForAll,
    /// The app's headers ([`Public::header`]): `None` unless it adds one, so an answer without
    /// them is one word larger and its drop is a null check.
    // Boxed so an answer without them is one word larger, not three (a `Vec` in place measured
    // about 20 instructions a request more).
    #[allow(clippy::box_collection)]
    headers: Option<Box<Vec<(http::HeaderName, http::HeaderValue)>>>,
}

impl<A: Shareable> Public<A> {
    /// `answer`, which any cache may keep for `max_age` (whole seconds). Its type says the
    /// `Public`'s, so a closure needs no annotation: `Public::new(age, "home")` is a
    /// `Public<&str>`, and `Public::new(age, req.page(..))` a `Public<HtmlResult>` whose page is
    /// made for everyone.
    ///
    /// A page made for one visitor does not fit, so a helper that makes a page for a `Public`
    /// handler returns `corten::Result<HtmlResponse<For>>` for any `For`, not `HtmlResult`:
    ///
    /// ```
    /// use std::time::Duration;
    /// use corten::{prelude::*, HtmlResponse};
    ///
    /// fn home_page<For>(req: &Req) -> corten::Result<HtmlResponse<For>> {
    ///     req.page(html! { <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html> })
    /// }
    ///
    /// async fn home(req: Req) -> Public<HtmlResult> {
    ///     Public::new(Duration::from_secs(60), home_page(&req))
    /// }
    /// # let _: Methods = get(home);
    /// ```
    pub fn new<T: ForEveryone<Named = A>>(max_age: Duration, answer: T) -> Self {
        Public { cache: Cache::public(max_age), answer: answer.for_all(), headers: None }
    }

    /// `answer` at a URL that names its content (a hash of its bytes, as Corten's versioned files
    /// have), so it never changes there: any cache keeps it for a year and the browser does not ask
    /// again (`public, max-age=31536000, immutable`). Since the URL alone says what the answer
    /// is, a request's cookies do not make it private, and no `Vary: cookie` is added; a cookie it
    /// sets, or a caller something read, still does. A URL that does not name its content (a
    /// user's current picture at `/me/picture`) takes `Public::new` with a lifetime instead, and so
    /// does anything but bytes: a page, a redirect or JSON changes with the deploy, so only `Media`
    /// (or `corten::Result<Media>`) can be immutable. `shared`, `stale_while_revalidate` and
    /// `stale_if_error` do nothing to it; a year covers them all.
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/", get = home)]
    ///     pub struct Home;
    /// }
    ///
    /// async fn home(req: Req) -> Public<HtmlResult> {
    ///     Public::immutable(req.page(html! { <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html> }))
    /// }
    /// # fn main() { let _ = url::router(); }
    /// ```
    ///
    /// Its handler is held to `Public`'s rule, so one that could tell who is asking does not
    /// compile:
    ///
    /// ```compile_fail,E0277
    /// use corten::{http::HeaderMap, prelude::*, Media};
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/me/picture", get = picture)]
    ///     pub struct Picture;
    /// }
    ///
    /// async fn picture(headers: HeaderMap) -> Public<Media> {
    ///     let _ = headers.get("cookie");
    ///     Public::immutable(Media::new("image/png", &b"\x89PNG"[..]))
    /// }
    /// # fn main() { let _ = url::router(); }
    /// ```
    pub fn immutable<T: ForEveryone<Named = A> + Immutable>(answer: T) -> Self {
        Public { cache: Cache::immutable(), answer: answer.for_all(), headers: None }
    }

    /// After `max_age`, a cache may still serve it for up to `stale` while it fetches a fresh one.
    pub fn stale_while_revalidate(mut self, stale: Duration) -> Self {
        self.cache = self.cache.stale_while_revalidate(stale);
        self
    }

    /// After `max_age`, a cache that cannot get a fresh one (the app is down, restarting, or
    /// answers 500, 502, 503 or 504) may serve it for up to `if_error` instead of the error
    /// (`stale-if-error`, RFC 5861): a catalog page a CDN keeps showing through a bad deploy.
    /// `public, max-age=60, stale-if-error=86400`. Like `stale_while_revalidate`, it stays when
    /// the answer is sent privately, since RFC 5861 does not limit it to shared caches.
    /// `s-maxage` forbids a shared cache to serve the response stale (RFC 9111, 5.2.2.10), so a
    /// shared cache that follows RFC 9111 serves neither stale directive on an answer that also has
    /// `shared`.
    pub fn stale_if_error(mut self, if_error: Duration) -> Self {
        self.cache = self.cache.stale_if_error(if_error);
        self
    }

    /// A shared cache (a CDN, a proxy) may keep it for `shared` (`s-maxage`, whole seconds), while
    /// the browser keeps `max_age`: a catalog page a CDN serves for a day that a browser checks
    /// again after a minute. `public, max-age=60, s-maxage=86400`. A lifetime known only when the
    /// request is answered (an API's own `s-maxage`) is passed the same way. When the answer is
    /// sent privately (a client navigation, a request with a cookie), `s-maxage` is dropped with
    /// `public`.
    pub fn shared(mut self, shared: Duration) -> Self {
        self.cache = self.cache.shared(shared);
        self
    }

    /// A header of the app's on the answer, named by a type ([`Header`]): a file that stays out
    /// of search, a canonical link. A download's file name is the answer's own
    /// ([`Media::attachment`]). It is added to the answer's own headers when the answer
    /// succeeds (or redirects), and Corten compresses the answer as it would without it.
    ///
    /// ```
    /// use std::time::Duration;
    /// use corten::{answer::XRobotsTag, http::HeaderValue, prelude::*};
    ///
    /// async fn llms() -> Public<String> {
    ///     let noindex = HeaderValue::from_static("noindex, nofollow");
    ///     Public::new(Duration::from_secs(3600), "# Example".to_string()).header::<XRobotsTag>(noindex)
    /// }
    /// # let _: Methods = get(llms);
    /// ```
    ///
    /// The name is checked when the app builds (`cargo build`, `cargo test`; `cargo check` does
    /// not evaluate it). A header that would make the answer one visitor's (`set-cookie`), one
    /// Corten sets itself (`cache-control` and a CDN's `*-cache-control`, `vary`, the encoding
    /// and length, the security headers, CORS, `corten-*`), one the answer has (`content-type`,
    /// `location`, `content-disposition`) or one of the connection's does not compile, and neither does a name that is
    /// not a lowercase header name:
    ///
    /// ```compile_fail,E0080
    /// use std::time::Duration;
    /// use corten::{answer::Header, http::HeaderValue, prelude::*};
    ///
    /// struct SetCookie;
    /// impl Header for SetCookie {
    ///     const NAME: &'static str = "set-cookie";
    /// }
    ///
    /// async fn home() -> Public<&'static str> {
    ///     Public::new(Duration::from_secs(60), "home").header::<SetCookie>(HeaderValue::from_static("a=b"))
    /// }
    /// # let _: Methods = get(home);
    /// ```
    pub fn header<H: Header>(mut self, value: http::HeaderValue) -> Self {
        let name = const {
            assert!(
                shared_header(H::NAME),
                "corten: a Public answer cannot set this header: it would make the answer one visitor's, or Corten or the answer sets it (the type named in `header::<..>` below)"
            );
            http::HeaderName::from_static(H::NAME)
        };
        self.headers.get_or_insert_default().push((name, value));
        self
    }
}

/// A header a [`Public`] answer may carry ([`Public::header`]), named by a type, so its name is
/// checked when the app compiles. Corten names the common ones ([`XRobotsTag`], [`Link`],
/// [`ContentLanguage`]); an app names another the same way:
///
/// ```
/// struct ContentLocation;
/// impl corten::answer::Header for ContentLocation {
///     const NAME: &'static str = "content-location";
/// }
/// ```
pub trait Header {
    /// The header's name, in lowercase (`"x-robots-tag"`).
    const NAME: &'static str;
}

macro_rules! headers {
    ($($(#[$doc:meta])* $name:ident = $text:literal;)*) => {
        $(
            $(#[$doc])*
            pub struct $name;
            impl Header for $name {
                const NAME: &'static str = $text;
            }
        )*
    };
}

headers! {
    /// `X-Robots-Tag`: what search engines may do with the answer (`noindex, nofollow`), for a
    /// file, where a page would use a `<meta name="robots">`.
    XRobotsTag = "x-robots-tag";
    /// `Link`: a related resource (`<https://example.com/item/7>; rel="canonical"`). Added
    /// twice, it is sent twice.
    Link = "link";
    /// `Content-Language`: the language the answer is in (`en`).
    ContentLanguage = "content-language";
}

/// The headers a [`Public`] answer may not set: one that would make it one visitor's
/// (`set-cookie`, `clear-site-data`), those Corten sets itself (caching, compression, security),
/// those the answer itself has (its type, the place a redirect goes, a range, a download's file
/// name, which [`Media::attachment`] writes escaped), and those that are
/// the connection's, not the answer's. Names under `corten-` and `access-control-` (an API's
/// CORS) are Corten's too, and so is any `*cache-control` and `surrogate-control`: a CDN
/// obeys them over `Cache-Control`, which Corten makes `private` for an answer it must not
/// share.
const NOT_SHARED: [&str; 28] = [
    "set-cookie",
    "clear-site-data",
    "cache-control",
    "surrogate-control",
    "expires",
    "age",
    "date",
    "vary",
    "content-type",
    "content-encoding",
    "content-length",
    "content-range",
    "content-disposition",
    "location",
    "content-security-policy",
    "content-security-policy-report-only",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "cross-origin-opener-policy",
    "permissions-policy",
    "strict-transport-security",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
];

/// Whether `name` starts (`at_end` false) or ends (`true`) with `part`, when the app compiles.
const fn has(name: &[u8], part: &[u8], at_end: bool) -> bool {
    if name.len() < part.len() {
        return false;
    }
    let from = if at_end { name.len() - part.len() } else { 0 };
    let mut i = 0;
    while i < part.len() {
        if name[from + i] != part[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// Whether a [`Public`] answer may set the header `name` (lowercase), when the app compiles.
const fn shared_header(name: &str) -> bool {
    let name = name.as_bytes();
    if has(name, b"corten-", false) || has(name, b"access-control-", false) || has(name, b"cache-control", true) {
        return false;
    }
    let mut n = 0;
    while n < NOT_SHARED.len() {
        let refused = NOT_SHARED[n].as_bytes();
        if refused.len() == name.len() && has(name, refused, false) {
            return false;
        }
        n += 1;
    }
    true
}

impl<A: Shareable> IntoResponse for Public<A> {
    fn into_response(self) -> Response {
        let mut res = self.answer.into_response();
        // No layout read's value is drawn in it, however the reads were started.
        res.extensions_mut().insert(crate::layout::SameForAll);
        if res.status().is_success() || res.status().is_redirection() {
            self.cache.apply(&mut res);
            if let Some(added) = self.headers {
                let headers = res.headers_mut();
                for (name, value) in *added {
                    headers.append(name, value);
                }
            }
        }
        res
    }
}

impl<A: Answer + Shareable> Answer for Public<A> {
    const FORMAT: Format = A::FORMAT;
    const PAGE: bool = A::PAGE;
    type Inputs = AnonymousInputs;
    type Rows = A::Rows;
}

/// An answer nothing may keep, not even the browser's own cache (`Cache-Control: no-store`): a
/// statement, a one-time code. `async fn statement(req: Req) -> NoStore<HtmlResult>`. The browser's
/// back/forward cache may not restore the page either. It applies to a failure the handler returns
/// too: the error page that replaces it is `no-store`. A request refused before the handler runs
/// (a path that does not parse), a handler that panics and one past its deadline never reach it,
/// and get the default. In a routes module the route can say it instead,
/// `#[route("/statement", get = statement, no_store)]`: the handler keeps its own result and its
/// `?`, and a request its extractors refuse is `no-store` too; `no_store(post)` covers only the
/// methods it names (see [`crate::routes`]).
pub struct NoStore<A>(pub A);

impl<A> NoStore<A> {
    /// `answer`, which nothing may keep.
    pub fn new(answer: A) -> Self {
        NoStore(answer)
    }
}

impl<A: IntoResponse> IntoResponse for NoStore<A> {
    fn into_response(self) -> Response {
        let mut res = self.0.into_response();
        Cache::no_store().apply(&mut res);
        res
    }
}

/// Not around a [`Public`] answer, which is the same for everyone and kept by shared caches: an
/// answer cannot be both, so it does not compile.
///
/// ```compile_fail,E0277
/// use corten::prelude::*;
/// use std::time::Duration;
///
/// #[corten::routes]
/// mod url {
///     #[route("/", get = home)]
///     pub struct Home;
/// }
///
/// async fn home(req: Req) -> NoStore<Public<HtmlResult>> {
///     let page = req.page(html! { <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html> });
///     NoStore(Public::new(Duration::from_secs(60), page))
/// }
/// # fn main() { let _ = url::router(); }
/// ```
///
/// Around any other answer it does:
///
/// ```
/// use corten::prelude::*;
///
/// #[corten::routes]
/// mod url {
///     #[route("/", get = home)]
///     pub struct Home;
/// }
///
/// async fn home(req: Req) -> NoStore<HtmlResult> {
///     NoStore(req.page(html! { <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html> }))
/// }
/// # fn main() { let _ = url::router(); }
/// ```
impl<A: Answer> Answer for NoStore<A>
where
    A::Inputs: Unshared,
{
    const FORMAT: Format = A::FORMAT;
    const PAGE: bool = A::PAGE;
    type Inputs = A::Inputs;
    type Rows = A::Rows;
}

/// Bytes a URL can name, which [`Public::immutable`] takes: [`Media`], or `corten::Result<Media>`.
#[diagnostic::on_unimplemented(
    message = "`{Self}` is not bytes a URL can name, so it cannot be immutable",
    note = "`Public::immutable` takes `Media` or `corten::Result<Media>`; a page, a redirect or JSON changes with the deploy, so give it `Public::new` with a lifetime"
)]
pub trait Immutable: sealed::Immutable {}

impl Immutable for Media {}
impl Immutable for Result<Media, Error> {}

/// A handler may read anything.
pub struct AnyInputs;

/// A handler may read only [`Anonymous`] inputs.
pub struct AnonymousInputs;

/// The inputs of an answer that is not shared ([`AnyInputs`]): what [`NoStore`] wraps.
#[doc(hidden)]
#[diagnostic::on_unimplemented(
    message = "a `Public` answer is kept by shared caches, so it cannot be `no-store` too",
    label = "this answer is `Public`",
    note = "a route that says `no_store` (or `no_store(..)` naming this method), or a `NoStore<..>`, answers one visitor; return the answer without `Public` there, or leave this method out of `no_store`"
)]
pub trait Unshared {}
impl Unshared for AnyInputs {}

/// An input that cannot tell who is asking: no cookie, no credential header, no `Caller`. A
/// [`Public`] answer's handler takes only these. Implement it for an extractor of the app's own
/// that reads nothing about the caller. A request's cookies make a `Public::new` answer private
/// when it is sent, but not a [`Public::immutable`] one, which this marker alone keeps from
/// depending on who is asking.
#[diagnostic::on_unimplemented(
    message = "a `Public` answer is the same for everyone, so its handler cannot take `{Self}`",
    label = "`{Self}` may tell who is asking",
    note = "return a private answer, or implement `corten::answer::Anonymous` for an extractor of the app's own that never reads who is asking"
)]
pub trait Anonymous {}

impl<R: crate::route::FromUrl + ?Sized> Anonymous for crate::route::Params<R> {}
impl<T> Anonymous for crate::Form<T> {}
impl<T> Anonymous for crate::form::Upload<T> {}
impl<T> Anonymous for State<T> {}
impl<T: Anonymous> Anonymous for Option<T> {}
impl Anonymous for Req {}
impl Anonymous for Signal {}
impl Anonymous for Method {}
impl Anonymous for Uri {}
impl Anonymous for crate::LiveSince {}
#[cfg(feature = "json")]
impl<T> Anonymous for crate::Json<T> {}
#[cfg(feature = "feed")]
impl Anonymous for corten_feed::Since {}

/// Every argument is [`Anonymous`].
#[doc(hidden)]
pub trait AllAnonymous {}

/// An input a route that says `unstaged` may take: its URL. No stage runs there, so nothing gives
/// the request its signal, its nonce or who is asking, and an extractor that reads one of those
/// (`Req`, `Signal`, `Nonce`, `Caller`, `ClientIp`) does not compile. Nor does one that reads the
/// headers (`HeaderMap`, the whole `Request`), which carry the visitor's cookies and credentials,
/// since no stage keeps a shared cache from storing what an unstaged handler made of them; nor one
/// that reads the body (`Bytes`, `String`, `Form`, `Json`, `Upload`): no deadline ends a client
/// that sends it a byte at a time, and no same-origin check keeps another site from posting it.
/// Implement it for an extractor of the app's own that reads none of these.
#[diagnostic::on_unimplemented(
    message = "a route that says `unstaged` runs no stage, so its handler cannot take `{Self}`",
    label = "`{Self}` reads what a stage gives the request, its headers, or its body",
    note = "take the request's method and URL (Params, Method, Uri) or the module's State, or leave unstaged out so the route gets every stage; an extractor of the app's own that reads none of those implements `corten::answer::Unstaged`"
)]
pub trait Unstaged {}

impl<R: crate::route::FromUrl + ?Sized> Unstaged for crate::route::Params<R> {}
impl<T> Unstaged for State<T> {}
impl Unstaged for Method {}
impl Unstaged for Uri {}

/// Every argument is [`Unstaged`].
#[doc(hidden)]
pub trait AllUnstaged {}
impl AllUnstaged for () {}

/// Whether an answer's [`Answer::Inputs`] allows the handler's arguments.
#[doc(hidden)]
pub trait Accepts<Args> {
    /// The answer is the same for everyone ([`Public`], the only one with [`AnonymousInputs`]).
    const SHARED: bool = false;
}
impl<A> Accepts<A> for AnyInputs {}
impl<A: AllAnonymous> Accepts<A> for AnonymousInputs {
    const SHARED: bool = true;
}

/// A handler's arguments and result, by the shapes Corten's `Handler` uses.
#[doc(hidden)]
pub trait Signature<T> {
    type Args;
    type Out;
}

impl<F, Fut> Signature<((),)> for F
where
    F: FnOnce() -> Fut,
    Fut: Future,
{
    type Args = ();
    type Out = Fut::Output;
}

impl AllAnonymous for () {}

/// For one arity, `Holds<T, At<N>>` with `T` at each position `N` in turn: the arguments before it
/// keep their names, the one at it is `T`, the rest keep theirs.
/// The positions are literals, not `$at + 1`, so an error names `At<2>` rather than an anonymous
/// constant.
macro_rules! holds {
    ([$($before:ident)*] [] [$($at:tt)*]) => {};
    ([$($before:ident)*] [$here:ident $($after:ident)*] [$at:tt $($rest:tt)*]) => {
        impl<T, $($before,)* $($after,)*> Holds<T, At<$at>> for ($($before,)* T, $($after,)*) {}
        holds!([$($before)* $here] [$($after)*] [$($rest)*]);
    };
}

macro_rules! arities {
    ($($ty:ident),*) => {
        impl<F, Fut, M, $($ty,)*> Signature<(M, $($ty,)*)> for F
        where
            F: FnOnce($($ty,)*) -> Fut,
            Fut: Future,
        {
            type Args = ($($ty,)*);
            type Out = Fut::Output;
        }

        impl<$($ty: Anonymous,)*> AllAnonymous for ($($ty,)*) {}
        impl<$($ty: Unstaged,)*> AllUnstaged for ($($ty,)*) {}

        holds!([] [$($ty)*] [0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15]);
    };
}

arities!(A1);
arities!(A1, A2);
arities!(A1, A2, A3);
arities!(A1, A2, A3, A4);
arities!(A1, A2, A3, A4, A5);
arities!(A1, A2, A3, A4, A5, A6);
arities!(A1, A2, A3, A4, A5, A6, A7);
arities!(A1, A2, A3, A4, A5, A6, A7, A8);
arities!(A1, A2, A3, A4, A5, A6, A7, A8, A9);
arities!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10);
arities!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11);
arities!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12);
arities!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13);
arities!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14);
arities!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15);
arities!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16);

/// The position of an argument, for [`Holds`].
#[doc(hidden)]
pub struct At<const N: usize>;

/// The handler's arguments include `T` (`I` is where, found by the compiler). A routes module
/// with `caller = Viewer` holds every handler in it to taking `Caller<Viewer>`, and a route with a
/// parameter in its path its handlers to taking its `Params`.
#[doc(hidden)]
#[diagnostic::on_unimplemented(
    message = "this handler's route needs `{T}`, and the handler does not take it",
    label = "this handler",
    note = "add `{T}` to the handler's arguments: every route of a module with `caller = ..` takes its `Caller<..>`, and a route with a parameter in its path its own `Params<..>`"
)]
pub trait Holds<T, I> {}

/// No requirement: `()`.
#[doc(hidden)]
pub struct Free;
impl<A> Holds<(), Free> for A {}

/// On a failed response from a JSON route, before or after its handler ran (a path that does not
/// parse too): the route answers JSON.
#[derive(Clone, Copy)]
pub(crate) struct Answered;

/// A handler with its answer in its type: what `get = handler` builds.
#[doc(hidden)]
pub struct Endpoint<H, O> {
    pub(crate) handler: H,
    pub(crate) answer: PhantomData<fn() -> O>,
    /// The answer is [`Public`] (its inputs are [`AnonymousInputs`]).
    pub(crate) shared: bool,
}

impl<H: Clone, O> Clone for Endpoint<H, O> {
    fn clone(&self) -> Self {
        Endpoint { handler: self.handler.clone(), answer: PhantomData, shared: self.shared }
    }
}

/// A JSON route's failure marked as one, which the stages leave as it is.
#[inline]
fn marked<O: Answer>(mut res: Response) -> Response {
    // A constant: an HTML route's check compiles away.
    if matches!(O::FORMAT, Format::Json) && (res.status().is_client_error() || res.status().is_server_error()) {
        res.extensions_mut().insert(Answered);
    }
    res
}

impl<H, T, S, O> Handler<T, S> for Endpoint<H, O>
where
    H: Handler<T, S>,
    O: Answer + 'static,
    S: Send + 'static,
    T: 'static,
{
    #[inline]
    fn call(self, mut req: Request, state: S) -> impl Future<Output = Response> + Send + 'static {
        // A whole document's layout reads (`crate::LayoutRead`) start as its page route is called,
        // after the middleware, beside the handler's own reads.
        if let Some(here) = req.extensions().get::<crate::layout::StartHere>().cloned() {
            here.arrive(&mut req, O::PAGE, self.shared);
        }
        // A `Public` answer is the same for everyone: written as for a visitor whose zone is not
        // known, its live part's fragments too.
        #[cfg(feature = "zones")]
        if self.shared {
            if let Some(signal) = req.extensions().get::<crate::Signal>() {
                signal.mark_for_everyone();
            }
        }
        futures_util::FutureExt::map(self.handler.call(req, state), marked::<O>)
    }
}

#[cfg(test)]
mod tests {
    /// The handler argument lists a route can hold to a type, written out rather than taken from
    /// `holds!`: every position of every arity, 136 in all (#933). `Free` holds for any list.
    #[test]
    fn every_position_of_each_arity_holds_its_type() {
        fn holds<T, const N: usize, A: super::Holds<T, super::At<N>>>() {}
        fn free<A: super::Holds<(), super::Free>>() {}
        holds::<char, 0, (char,)>();
        holds::<char, 0, (char, u8)>();
        holds::<char, 1, (u8, char)>();
        holds::<char, 0, (char, u8, u8)>();
        holds::<char, 1, (u8, char, u8)>();
        holds::<char, 2, (u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8)>();
        holds::<char, 3, (u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char, u8)>();
        holds::<char, 5, (u8, u8, u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8, u8, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char, u8, u8)>();
        holds::<char, 5, (u8, u8, u8, u8, u8, char, u8)>();
        holds::<char, 6, (u8, u8, u8, u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8, u8, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8, u8, u8, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char, u8, u8, u8)>();
        holds::<char, 5, (u8, u8, u8, u8, u8, char, u8, u8)>();
        holds::<char, 6, (u8, u8, u8, u8, u8, u8, char, u8)>();
        holds::<char, 7, (u8, u8, u8, u8, u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8, u8, u8, u8, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char, u8, u8, u8, u8)>();
        holds::<char, 5, (u8, u8, u8, u8, u8, char, u8, u8, u8)>();
        holds::<char, 6, (u8, u8, u8, u8, u8, u8, char, u8, u8)>();
        holds::<char, 7, (u8, u8, u8, u8, u8, u8, u8, char, u8)>();
        holds::<char, 8, (u8, u8, u8, u8, u8, u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char, u8, u8, u8, u8, u8)>();
        holds::<char, 5, (u8, u8, u8, u8, u8, char, u8, u8, u8, u8)>();
        holds::<char, 6, (u8, u8, u8, u8, u8, u8, char, u8, u8, u8)>();
        holds::<char, 7, (u8, u8, u8, u8, u8, u8, u8, char, u8, u8)>();
        holds::<char, 8, (u8, u8, u8, u8, u8, u8, u8, u8, char, u8)>();
        holds::<char, 9, (u8, u8, u8, u8, u8, u8, u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 5, (u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8)>();
        holds::<char, 6, (u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8)>();
        holds::<char, 7, (u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8)>();
        holds::<char, 8, (u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8)>();
        holds::<char, 9, (u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8)>();
        holds::<char, 10, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 5, (u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 6, (u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8)>();
        holds::<char, 7, (u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8)>();
        holds::<char, 8, (u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8)>();
        holds::<char, 9, (u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8)>();
        holds::<char, 10, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8)>();
        holds::<char, 11, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 5, (u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 6, (u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 7, (u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8)>();
        holds::<char, 8, (u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8)>();
        holds::<char, 9, (u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8)>();
        holds::<char, 10, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8)>();
        holds::<char, 11, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8)>();
        holds::<char, 12, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 5, (u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 6, (u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 7, (u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 8, (u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8)>();
        holds::<char, 9, (u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8)>();
        holds::<char, 10, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8)>();
        holds::<char, 11, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8)>();
        holds::<char, 12, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8)>();
        holds::<char, 13, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 5, (u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 6, (u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 7, (u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 8, (u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 9, (u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8)>();
        holds::<char, 10, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8)>();
        holds::<char, 11, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8)>();
        holds::<char, 12, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8)>();
        holds::<char, 13, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8)>();
        holds::<char, 14, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char)>();
        holds::<char, 0, (char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 1, (u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 2, (u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 3, (u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 4, (u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 5, (u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 6, (u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 7, (u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 8, (u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 9, (u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8, u8)>();
        holds::<char, 10, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8, u8)>();
        holds::<char, 11, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8, u8)>();
        holds::<char, 12, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8, u8)>();
        holds::<char, 13, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8, u8)>();
        holds::<char, 14, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char, u8)>();
        holds::<char, 15, (u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, char)>();
        free::<()>();
        free::<(u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8, u8)>();
    }

    #[test]
    fn a_download_s_name_is_quoted_when_plain_and_encoded_when_not() {
        use super::disposition;
        assert_eq!(disposition("attachment", "shipments-2026-10-29.csv"), r#"attachment; filename="shipments-2026-10-29.csv""#);
        assert_eq!(disposition("inline", "packing slips.pdf"), r#"inline; filename="packing slips.pdf""#);
        assert_eq!(disposition("attachment", ""), "attachment", "the browser names it from the URL");
        // Not ASCII: a fallback, then the exact name, each byte of its UTF-8 encoded.
        assert_eq!(
            disposition("attachment", "Pokémon ✓.csv"),
            r#"attachment; filename="Pok_mon _.csv"; filename*=UTF-8''Pok%C3%A9mon%20%E2%9C%93.csv"#
        );
        // A quote, a backslash or a line break cannot end the parameter or the header.
        assert_eq!(
            disposition("attachment", "a\"b\\c\r\nSet-Cookie: x=1;.csv"),
            r#"attachment; filename="a_b_c__Set-Cookie: x=1;.csv"; filename*=UTF-8''a%22b%5Cc%0D%0ASet-Cookie%3A%20x%3D1%3B.csv"#
        );
        // Some clients decode % in `filename`, so a name with one has the exact form too.
        assert_eq!(disposition("attachment", "100%.txt"), r#"attachment; filename="100_.txt"; filename*=UTF-8''100%25.txt"#);
        // Some decode RFC 2047 in `filename`, which would swap the name for another.
        assert_eq!(
            disposition("attachment", "=?UTF-8?B?ZXZpbC5leGU=?=.csv"),
            r#"attachment; filename="=_UTF-8_B_ZXZpbC5leGU=_=.csv"; filename*=UTF-8''%3D%3FUTF-8%3FB%3FZXZpbC5leGU%3D%3F%3D.csv"#
        );
        for name in ["", "a\u{0}b", "\u{7f}", "日本語.pdf", "tab\there"] {
            let value = disposition("inline", name);
            assert!(value.bytes().all(|b| (0x20..0x7f).contains(&b)), "{value}");
            assert!(http::HeaderValue::try_from(value).is_ok());
        }
    }

    #[test]
    fn a_public_answer_takes_the_app_s_headers_and_not_corten_s_or_the_connection_s() {
        for name in ["x-robots-tag", "link", "content-language", "etag", "last-modified", "x-cache-tag"] {
            assert!(super::shared_header(name), "{name}");
        }
        for name in [
            "set-cookie",
            "cache-control",
            "cdn-cache-control",
            "cloudflare-cdn-cache-control",
            "surrogate-control",
            "access-control-allow-origin",
            "corten-mode",
            "content-type",
            "location",
            "content-range",
            "content-disposition",
            "transfer-encoding",
            "connection",
            "te",
            "age",
            "clear-site-data",
            "permissions-policy",
        ] {
            assert!(!super::shared_header(name), "{name}");
        }
    }
}
