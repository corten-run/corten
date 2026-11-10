//! [`Caller`]: who is asking, looked up when a handler reads it and not before.
//!
//! An app says how a caller of each kind is found with [`Identify`]: a person by their session
//! cookie, a partner by its API key. A handler that needs one takes it, and the type says what the
//! route needs:
//!
//! ```
//! use corten::{http::request::Parts, prelude::*, security::cookie};
//!
//! #[derive(Clone, Hash)]
//! struct Viewer { name: String }
//!
//! impl<S: Sync> Identify<S> for Viewer {
//!     async fn identify(parts: &Parts, _state: &S) -> Result<Self, Refused> {
//!         // A real app reads its session store here.
//!         match cookie::get(&parts.headers, "viewer") {
//!             Some(name) => Ok(Viewer { name: name.to_string() }),
//!             None => Err(Refused::sign_in(&url::SignIn)),
//!         }
//!     }
//! }
//!
//! #[corten::routes]
//! mod url {
//!     #[route("/account", get = account)]
//!     pub struct Account;
//!
//!     #[route("/sign-in", get = sign_in)]
//!     pub struct SignIn;
//! }
//!
//! // Someone signed in, or the browser goes to sign in: the handler never runs without one.
//! async fn account(Caller(viewer): Caller<Viewer>) -> String {
//!     viewer.name
//! }
//!
//! async fn sign_in() -> &'static str {
//!     "sign in"
//! }
//! # let _ = App::new(url::router()).router();
//! ```
//!
//! 1. Only a handler that reads a caller pays for the lookup; a page that does not (a public
//!    landing page) never touches the session store. Several readers in one request (a
//!    middleware, the handler, a caller type that is a rule over this one, through
//!    [`Caller::find`], and the error page) share one lookup.
//! 2. Reading one makes the answer private (`Cache-Control: private`), and a [`crate::Public`]
//!    answer's handler cannot take one: that does not compile.
//! 3. The caller is part of the page's key, so after signing in or out the runtime loads the next
//!    page in full and the layout shows who is asking now.
//! 4. Without one, the request fails as [`Identify::identify`] says: a browser is sent to sign
//!    in (a 303, or `corten-location` for a form patch), a data client and a JSON route get a
//!    401, and a refusal is the app's error page for 403 ([`crate::Failure`]).
//! 5. `Option<Caller<T>>` is for a page that shows something either way (a layout's "Sign in" or
//!    "Signed in as"): `None` when there is no caller, and the handler runs.
//! 6. A routes module with `caller = Viewer` holds every handler in it to taking
//!    `Caller<Viewer>`: a route added there without it does not compile (see [`crate::routes`]).
//!
//! A [`crate::Public`] answer cannot read who is asking:
//!
//! ```compile_fail,E0277
//! use std::time::Duration;
//! use corten::{http::request::Parts, prelude::*};
//!
//! #[derive(Clone, Hash)]
//! struct Partner;
//!
//! impl<S: Sync> Identify<S> for Partner {
//!     async fn identify(_parts: &Parts, _state: &S) -> Result<Self, Refused> {
//!         Err(Refused::unauthorized(Challenge::BEARER))
//!     }
//! }
//!
//! #[corten::routes]
//! mod url {
//!     #[route("/rates", get = rates)]
//!     pub struct Rates;
//! }
//!
//! async fn rates(_: Caller<Partner>) -> Public<&'static str> {
//!     Public::new(Duration::from_secs(60), "rates for this partner")
//! }
//! # fn main() { let _ = url::router(); }
//! ```

use std::{
    future::Future,
    hash::{Hash, Hasher},
};

use crate::extract::{FromRequestParts, OptionalFromRequestParts};
use crate::response::IntoResponse;
use crate::response::Response;
use http::request::Parts;
use http::HeaderValue;
use http::StatusCode;

use crate::{route::Href, Error, Signal};

/// Who is asking, as `T`, found by `T`'s [`Identify`] when the handler reads it. See
/// [`crate::caller`].
///
/// It reads as the `T` it holds, so a handler that may have none passes it on with
/// `viewer.as_deref()`:
///
/// ```
/// use corten::{http::request::Parts, prelude::*};
///
/// #[derive(Clone, Hash)]
/// struct Viewer {
///     name: String,
/// }
///
/// impl<S: Sync> Identify<S> for Viewer {
///     async fn identify(_parts: &Parts, _state: &S) -> Result<Self, Refused> {
///         Err(Refused::unauthorized(Challenge::BEARER))
///     }
/// }
///
/// fn greeting(viewer: Option<&Viewer>) -> String {
///     viewer.map_or("Hello".into(), |v| format!("Hello, {}", v.name))
/// }
///
/// async fn home(viewer: Option<Caller<Viewer>>) -> String {
///     greeting(viewer.as_deref())
/// }
/// ```
pub struct Caller<T>(pub T);

impl<T> std::ops::Deref for Caller<T> {
    type Target = T;

    #[inline]
    fn deref(&self) -> &T {
        &self.0
    }
}

/// How a caller of this type is found: a session cookie, an API key, a token. `S` is the routes'
/// state (a session store); implement it for every `S` when the lookup needs none.
pub trait Identify<S>: Clone + Hash + Send + Sync + 'static {
    /// Who is asking, or why the request may not go on.
    fn identify(parts: &Parts, state: &S) -> impl Future<Output = Result<Self, Refused>> + Send;
}

/// Why there is no caller, from [`Identify::identify`], why a middleware turned a request away
/// (`Refused::too_many(wait).into_response()`), or why a handler did (`Err(Refused::forbidden())?`).
///
/// It does not implement `std::error::Error`: `From<Refused> for corten::Error` would then overlap
/// the blanket `From<E: Error>`, and `?` would answer a refusal as a plain failure.
#[derive(Debug)]
pub struct Refused(Why);

#[derive(Clone, Debug)]
enum Why {
    SignIn(HeaderValue, Option<std::sync::Arc<str>>),
    /// A 401, 403 or 429, with what the client is told and the header its status needs.
    Refusal {
        status: StatusCode,
        message: Option<std::sync::Arc<str>>,
        header: Option<RefusalHeader>,
    },
    Unavailable(std::sync::Arc<str>),
}

/// The header a refusal sends, named by what it is rather than by the status.
#[derive(Clone, Debug)]
enum RefusalHeader {
    /// A 401's `WWW-Authenticate`.
    Challenge(HeaderValue),
    /// A 429's `Retry-After`.
    RetryAfter(HeaderValue),
}

impl Refused {
    /// No one is signed in, or their session ended: a browser is sent to `to` (a typed route, a
    /// [`crate::Local`] return address, or a `corten::http::Uri` on another site), the way [`crate::Req::redirect`] sends it. A data
    /// client and a JSON route get a 401 with no `WWW-Authenticate`, short of what RFC 9110 asks
    /// of a 401, since a session cookie has no HTTP authentication scheme to name
    /// (`docs/design.md#choice-caller-types`). An app whose data clients send a token refuses one
    /// that sent it with [`Refused::unauthorized`] instead.
    pub fn sign_in(to: &(impl Href + ?Sized)) -> Self {
        match crate::route::header_value(to) {
            Ok(to) => Refused(Why::SignIn(to, None)),
            Err(error) => Refused(Why::Unavailable(error.to_string().into())),
        }
    }

    /// No credentials, and nowhere to sign in (an API key that is missing or wrong): a 401 with
    /// `challenge` in `WWW-Authenticate` (RFC 9110 15.5.2), saying how the client should send
    /// them: `Refused::unauthorized(Challenge::BEARER)`. It takes one, so none is left out:
    ///
    /// ```compile_fail,E0061
    /// let _ = corten::Refused::unauthorized();
    /// ```
    pub fn unauthorized(challenge: Challenge) -> Self {
        let header = Some(RefusalHeader::Challenge(challenge.0));
        Refused(Why::Refusal { status: StatusCode::UNAUTHORIZED, message: None, header })
    }

    /// Someone is known but may not do this (not staff): a 403.
    pub fn forbidden() -> Self {
        Refused(Why::Refusal { status: StatusCode::FORBIDDEN, message: None, header: None })
    }

    /// Too many failed attempts from this client (counted by the app, by address or account):
    /// a 429 with `Retry-After` (whole seconds, rounded up). A lookup that checks this before the
    /// credentials tells a locked-out client nothing about them.
    pub fn too_many(retry_after: std::time::Duration) -> Self {
        let seconds = retry_after.as_secs() + u64::from(retry_after.subsec_nanos() > 0);
        let header = Some(RefusalHeader::RetryAfter(seconds.into()));
        Refused(Why::Refusal { status: StatusCode::TOO_MANY_REQUESTS, message: None, header })
    }

    /// What a client that reads the failure is told, in place of the status's reason: the JSON
    /// error's message, and [`crate::Api::errors`]'s: `Refused::forbidden().message("Not your order")`.
    /// A browser gets the app's error page, which does not show it, and one sent to sign in is
    /// sent there as before (a data client gets the 401 with it). An [`unavailable`](Refused::unavailable)
    /// lookup's 503 keeps its status's reason: its error is logged, never sent.
    pub fn message(self, message: impl Into<std::sync::Arc<str>>) -> Self {
        let message = Some(message.into());
        Refused(match self.0 {
            Why::SignIn(to, _) => Why::SignIn(to, message),
            Why::Refusal { status, header, .. } => Why::Refusal { status, message, header },
            why @ Why::Unavailable(_) => why,
        })
    }

    /// Who is asking cannot be known now (the session store is down): a 503, so no one is sent
    /// to sign in again for nothing. The message is logged.
    pub fn unavailable(error: impl std::fmt::Display) -> Self {
        Refused(Why::Unavailable(error.to_string().into()))
    }

    /// The status it is answered with.
    pub(crate) fn status(&self) -> StatusCode {
        match &self.0 {
            Why::SignIn(..) => StatusCode::UNAUTHORIZED,
            Why::Refusal { status, .. } => *status,
            Why::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

/// How a client should send its credentials, sent in a 401's `WWW-Authenticate` (RFC 9110
/// 11.6.1): a scheme, and that scheme's parameters, for [`Refused::unauthorized`].
///
/// ```
/// use corten::{http::request::Parts, prelude::*};
///
/// #[derive(Clone, Hash)]
/// struct Partner { name: String }
///
/// impl<S: Sync> Identify<S> for Partner {
///     async fn identify(parts: &Parts, _state: &S) -> Result<Self, Refused> {
///         // The scheme is matched in any case (RFC 9110 11.1).
///         let sent = parts.headers.get("authorization").and_then(|v| v.to_str().ok());
///         let key = sent.and_then(|v| v.split_once(' ')).filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"));
///         match (sent, key.map(|(_, key)| key)) {
///             // No key: say how to send one.
///             (None, _) => Err(Refused::unauthorized(Challenge::BEARER)),
///             // A real app looks the key up here.
///             (_, Some("dev-key")) => Ok(Partner { name: "dev".into() }),
///             // A key that is wrong (RFC 6750 3.1).
///             _ => Err(Refused::unauthorized(Challenge::BEARER.param("error", "invalid_token"))),
///         }
///     }
/// }
/// ```
///
/// Another scheme is a `const` of the app's, so one that is not a token does not compile:
///
/// ```compile_fail,E0080
/// const NEGOTIATE: corten::Challenge = corten::Challenge::new("Negotiate realm");
/// ```
#[derive(Clone, Debug)]
pub struct Challenge(HeaderValue);

impl Challenge {
    /// `Bearer` (RFC 6750): a key or token sent in `Authorization`.
    pub const BEARER: Challenge = Challenge::new("Bearer");

    /// Another scheme the client knows, written as a `const` of the app's
    /// (`const NEGOTIATE: Challenge = Challenge::new("Negotiate");`), where one that is not a token
    /// (RFC 9110 5.6.2) does not compile; called at run time it panics.
    #[track_caller]
    pub const fn new(scheme: &'static str) -> Self {
        assert!(is_token(scheme.as_bytes()), "corten: an authentication scheme is a token (RFC 9110 5.6.2)");
        Challenge(HeaderValue::from_static(scheme))
    }

    /// A parameter of the scheme's (`realm`, RFC 6750's `error` or `scope`), its value always sent
    /// as a quoted string, with `"` and `\` escaped: a scheme with a parameter that must be a bare
    /// token (Digest's `algorithm`) is not written with it, and RFC 6750's own parameters must not
    /// hold `"` or `\` at all. Panics when `name` is not a token or the challenge has it already
    /// (RFC 9110 11.2, in any case), or `value` has a control character or a byte outside ASCII,
    /// Corten's rule since the authentication framework has no reliable way to carry another
    /// character set (RFC 7617 3): a value from a request or a store is the app's to clean first.
    #[track_caller]
    pub fn param(self, name: &str, value: &str) -> Self {
        assert!(is_token(name.as_bytes()), "corten: a challenge's parameter name is a token: {name:?}");
        assert!(!self.names().any(|had| had.eq_ignore_ascii_case(name.as_bytes())), "corten: a challenge names {name:?} twice");
        assert!(
            value.bytes().all(|b| b == b'\t' || (b.is_ascii() && !b.is_ascii_control())),
            "corten: a challenge's parameter value has no control character and is ASCII"
        );
        let mut text = Vec::with_capacity(self.0.len() + name.len() + value.len() + 5);
        text.extend_from_slice(self.0.as_bytes());
        // The first parameter follows the scheme after a space, the others a comma.
        text.extend_from_slice(if self.0.as_bytes().contains(&b'=') { b", " } else { b" " });
        text.extend_from_slice(name.as_bytes());
        text.extend_from_slice(b"=\"");
        for b in value.bytes() {
            if matches!(b, b'"' | b'\\') {
                text.push(b'\\');
            }
            text.push(b);
        }
        text.push(b'"');
        Challenge(HeaderValue::from_bytes(&text).expect("checked: visible ASCII"))
    }

    /// The names of its parameters, read back from the text `param` wrote: after the scheme, each
    /// name, `=`, a quoted value with `\` before an escaped byte, then `, ` before the next.
    fn names(&self) -> impl Iterator<Item = &[u8]> {
        let text = self.0.as_bytes();
        let mut at = text.iter().position(|&b| b == b' ').map_or(text.len(), |space| space + 1);
        std::iter::from_fn(move || {
            let name = at..at + text.get(at..)?.iter().position(|&b| b == b'=')?;
            // Past the name, `=` and the opening quote, to the closing quote.
            at = name.end + 2;
            while text[at] != b'"' {
                at += if text[at] == b'\\' { 2 } else { 1 };
            }
            at += 3;
            Some(&text[name])
        })
    }

    /// `Basic` (RFC 7617), with the `realm` it requires: a browser answers it with its own
    /// sign-in prompt, naming the realm. Panics as [`Challenge::param`] does.
    #[track_caller]
    pub fn basic(realm: &str) -> Self {
        Challenge::new("Basic").param("realm", realm)
    }

    /// The header's value.
    pub(crate) fn value(&self) -> &HeaderValue {
        &self.0
    }
}

/// A token (RFC 9110 5.6.2): one or more of its characters.
const fn is_token(text: &[u8]) -> bool {
    let mut at = 0;
    while at < text.len() {
        let c = text[at];
        let symbol =
            matches!(c, b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~');
        if !(c.is_ascii_alphanumeric() || symbol) {
            return false;
        }
        at += 1;
    }
    !text.is_empty()
}

/// A [`Refused`] a handler returned as its error (`Err(Refused::forbidden())?`), carried in a
/// [`crate::Error`] and answered as the refusal it is.
#[derive(Debug)]
pub(crate) struct AsError(pub(crate) Refused);

impl std::fmt::Display for AsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.0 .0 {
            Why::Unavailable(message) => write!(f, "who is asking cannot be known: {message}"),
            _ => match self.message() {
                Some(message) => f.write_str(message),
                None => write!(f, "refused: {}", self.0.status()),
            },
        }
    }
}

impl std::error::Error for AsError {}

impl AsError {
    /// What the client is told (`Refused::message`), if anything.
    pub(crate) fn message(&self) -> Option<&str> {
        match &self.0 .0 {
            Why::Refusal { message: Some(message), .. } | Why::SignIn(_, Some(message)) => Some(message),
            _ => None,
        }
    }

    /// Answered as an extractor's refusal is. An unavailable lookup is logged where it is answered.
    pub(crate) fn into_response(self) -> Response {
        if !matches!(self.0 .0, Why::Unavailable(_)) {
            tracing::debug!(status = self.0.status().as_u16(), "corten: request refused by its handler");
        }
        self.0.into_response()
    }
}

/// The lookup's outcome for `T`, for the next reader in the request.
#[derive(Clone)]
struct Found<T>(Result<T, Why>);

/// On the response for a request sent to sign in: where to. The failure stage answers it in the
/// request's mode.
#[derive(Clone)]
pub(crate) struct SignIn(pub HeaderValue);

/// The caller, looked up once per request and type. In an app the lookup is kept on the
/// request's [`Signal`], which its error page shares; outside one (a bare router in a test), in
/// the request's extensions, when they can be written.
async fn find<S: Sync, T: Identify<S>>(parts: &Parts, state: &S) -> Result<T, Why> {
    let Some(signal) = parts.extensions.get::<Signal>() else {
        if let Some(Found(found)) = parts.extensions.get::<Found<T>>() {
            return found.clone();
        }
        return T::identify(parts, state).await.map_err(|Refused(why)| why);
    };
    // One cell per type for the request: readers at the same time (a middleware's two derived
    // types joined) wait for the one lookup, which alone marks the page's key.
    let cell = signal.found::<(Found<T>, u64, std::sync::atomic::AtomicBool)>();
    let (Found(found), hash, marked) = cell
        .get_or_init(|| async {
            // A layer outside the app's (`App::layer`) read it before the request had its signal.
            let found = match parts.extensions.get::<Found<T>>() {
                Some(Found(found)) => found.clone(),
                None => T::identify(parts, state).await.map_err(|Refused(why)| why),
            };
            // The page's key mixes in who it is for by the caller's value, not its type: a rule
            // over another caller that holds only that one (`Seller(Viewer)`,
            // `Staff<R>(Viewer, PhantomData<R>)`) hashes as it does, and a hash is marked once, so
            // pages for one person behind different rules share the layout. A rule that holds data
            // of its own (an org, a role) is keyed by that data too. A refusal is keyed by its
            // type, so a layout that reads several rules as `Option` is keyed by which passed.
            let mut hasher = std::hash::DefaultHasher::new();
            match &found {
                Ok(found) => Some(found).hash(&mut hasher),
                Err(_) => std::any::type_name::<T>().hash(&mut hasher),
            }
            (Found(found), hasher.finish(), std::sync::atomic::AtomicBool::new(false))
        })
        .await;
    // Marked by the first reader that is not a layout read, so the handler's read keys the page
    // even when a layout read looked the caller up first. A layout read's (`crate::LayoutRead`)
    // is noted on the read instead, since a client navigation does not start it.
    match parts.extensions.get::<crate::layout::Asking>() {
        Some(asking) => asking.mark(),
        None => {
            if !marked.swap(true, std::sync::atomic::Ordering::Relaxed) {
                signal.mark_caller(*hash);
            }
        }
    }
    found.clone()
}

impl<T> Caller<T> {
    /// Who is asking as `T`, from the request's one lookup of `T`: for a caller type that is a
    /// rule over another (a seller is a viewer who may sell), whose [`Identify`] reads the other
    /// this way rather than calling its `identify`, so the session is read once in the request,
    /// whichever types the handler, its middleware and the error page take:
    ///
    /// ```
    /// use corten::{http::request::Parts, prelude::*};
    ///
    /// #[derive(Clone, Hash)]
    /// struct Viewer { name: String, sells: bool }
    ///
    /// impl<S: Sync> Identify<S> for Viewer {
    ///     async fn identify(_parts: &Parts, _state: &S) -> Result<Self, Refused> {
    ///         // A real app reads its session store here.
    ///         Ok(Viewer { name: "ada".into(), sells: true })
    ///     }
    /// }
    ///
    /// #[derive(Clone, Hash)]
    /// struct Seller(Viewer);
    ///
    /// impl<S: Sync> Identify<S> for Seller {
    ///     async fn identify(parts: &Parts, state: &S) -> Result<Self, Refused> {
    ///         let Caller(viewer) = Caller::<Viewer>::find(parts, state).await?;
    ///         if viewer.sells { Ok(Seller(viewer)) } else { Err(Refused::forbidden()) }
    ///     }
    /// }
    /// ```
    ///
    /// A refusal of `T`'s is the derived type's too, unless it maps it. Outside an
    /// [`crate::App`] (a bare router in a test) each `find` looks `T` up again.
    ///
    /// The page's key takes each caller's value, not its type, once: a derived type that holds
    /// only `T`, as `Seller` does here (or `T` and a marker, `Staff<R>(Viewer, PhantomData<R>)`),
    /// hashes as `T` does, so pages for one person behind different rules (`Caller<Seller>`,
    /// `Caller<Viewer>`) share it and a navigation between them swaps `<main>` rather than
    /// loading the document again. One that holds more (an org, a role) is keyed by that too,
    /// and a refusal by the type refused. Since a caller is keyed by its data, two caller types
    /// that mean different things should hold data that differs: `Viewer(5)` and `Tenant(5)`
    /// hash alike, so a type whose ids can equal another's hashes a tag of its own as well (a
    /// hand-written `Hash`).
    pub async fn find<S: Sync>(parts: &Parts, state: &S) -> Result<Self, Refused>
    where
        T: Identify<S>,
    {
        find::<S, T>(parts, state).await.map(Caller).map_err(Refused)
    }
}

/// [`find`], keeping the lookup in the request's extensions outside an app.
async fn find_mut<S: Sync, T: Identify<S>>(parts: &mut Parts, state: &S) -> Result<T, Why> {
    let found = find::<S, T>(parts, state).await;
    if parts.extensions.get::<Signal>().is_none() {
        parts.extensions.insert(Found(found.clone()));
    }
    found
}

impl<S: Send + Sync, T: Identify<S>> FromRequestParts<S> for Caller<T> {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Response> {
        find_mut::<S, T>(parts, state).await.map(Caller).map_err(|why| Refused(why).into_response())
    }
}

/// A refusal as an answer, for a [`crate::Middleware`] that turns a request away:
/// `return Refused::too_many(wait).into_response();`. It is answered in the request's mode as a
/// [`Caller`]'s refusal is: the error page for a browser (a sign-in is a redirect), JSON for an
/// API or a data client, with `WWW-Authenticate` on a 401 and `Retry-After` on a 429.
impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        match self.0 {
            Why::SignIn(to, message) => {
                let mut res = StatusCode::UNAUTHORIZED.into_response();
                res.extensions_mut().insert(SignIn(to));
                if let Some(message) = message {
                    res.extensions_mut().insert(crate::Failed(message));
                }
                res
            }
            Why::Refusal { status, message, header } => refused(status, message, header),
            Why::Unavailable(message) => unidentified(&message),
        }
    }
}

/// A 503 for a request whose caller could not be looked up, by an extractor or by a handler's
/// `Refused::unavailable`: the error page's [`crate::Failure::Unidentified`], not a plain
/// `Error::status(SERVICE_UNAVAILABLE)`.
fn unidentified(message: &str) -> Response {
    let mut res = Error::new(format!("who is asking cannot be known: {message}"))
        .with_status(StatusCode::SERVICE_UNAVAILABLE)
        .into_response();
    res.extensions_mut().insert(crate::page::Cause::Unidentified);
    res
}

/// A 401, 403 or 429 for a request without the caller its handler reads, with what the client is
/// told and the header its status needs (`WWW-Authenticate`, `Retry-After`).
fn refused(status: StatusCode, message: Option<std::sync::Arc<str>>, header: Option<RefusalHeader>) -> Response {
    let mut res = status.into_response();
    res.extensions_mut().insert(crate::page::Cause::Refused);
    if let Some(message) = message {
        res.extensions_mut().insert(crate::Failed(message));
    }
    let header = match header {
        Some(RefusalHeader::Challenge(value)) => Some((http::header::WWW_AUTHENTICATE, value)),
        Some(RefusalHeader::RetryAfter(value)) => Some((http::header::RETRY_AFTER, value)),
        None => None,
    };
    if let Some((name, value)) = header {
        res.headers_mut().insert(name, value);
    }
    res
}

impl<S: Send + Sync, T: Identify<S>> OptionalFromRequestParts<S> for Caller<T> {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Option<Self>, Response> {
        match find_mut::<S, T>(parts, state).await {
            Ok(caller) => Ok(Some(Caller(caller))),
            Err(Why::Unavailable(_)) if parts.extensions.get::<Signal>().is_some_and(Signal::is_error_page) => Ok(None),
            Err(Why::Unavailable(message)) => Err(unidentified(&message)),
            Err(_) => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Challenge;

    #[test]
    fn a_challenge_is_its_scheme_then_its_parameters_quoted() {
        assert_eq!(Challenge::BEARER.0, "Bearer");
        let challenge = Challenge::BEARER.param("realm", "partners").param("error", "invalid_token");
        assert_eq!(challenge.0, r#"Bearer realm="partners", error="invalid_token""#);
        assert_eq!(Challenge::new("Basic").param("realm", r#"say "hi" \ go"#).0, r#"Basic realm="say \"hi\" \\ go""#);
    }

    #[test]
    fn a_name_inside_a_quoted_value_is_not_a_parameter() {
        let challenge =
            Challenge::BEARER.param("error_description", "scope=x, realm=\"y\"").param("scope", "y").param("realm", "z");
        assert_eq!(challenge.0, r#"Bearer error_description="scope=x, realm=\"y\"", scope="y", realm="z""#);
        assert_eq!(Challenge::basic("shop").0, r#"Basic realm="shop""#);
    }

    #[test]
    #[should_panic(expected = "is ASCII")]
    fn a_parameter_value_outside_ascii_panics() {
        let _ = Challenge::BEARER.param("realm", "caf\u{e9}");
    }

    #[test]
    #[should_panic(expected = "names \"REALM\" twice")]
    fn a_parameter_named_twice_panics() {
        let _ = Challenge::BEARER.param("realm", "a \"quoted\", realm=").param("scope", "x").param("REALM", "b");
    }

    #[test]
    #[should_panic(expected = "an authentication scheme is a token")]
    fn a_scheme_with_a_space_panics() {
        let _ = Challenge::new("Bearer realm");
    }

    #[test]
    #[should_panic(expected = "parameter name is a token")]
    fn a_parameter_name_with_a_quote_panics() {
        let _ = Challenge::BEARER.param("re\"alm", "x");
    }

    #[test]
    #[should_panic(expected = "no control character and is ASCII")]
    fn a_parameter_value_with_a_line_break_panics() {
        let _ = Challenge::BEARER.param("realm", "a\r\nSet-Cookie: x=1");
    }
}
