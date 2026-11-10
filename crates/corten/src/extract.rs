//! Reading a request: the traits an extractor of the app's own implements, and the whole request
//! for a handler or a middleware that takes it as it came.
//!
//! A value read from the request's head (a visitor's cookie, a header) implements
//! [`FromRequestParts`], and a handler takes it as an argument; one a handler may go without
//! implements [`OptionalFromRequestParts`] too, so it can take `Option<T>`. An extractor that
//! reads the body ([`crate::Form`], [`crate::Upload`]) implements [`FromRequest`]. A refusal
//! (`type Rejection`) is anything that makes a response
//! ([`crate::middleware::IntoResponse`]). Who is asking is a [`crate::Caller`], found by the caller
//! type's [`crate::Identify`], never an extractor written for it. A part of the routes' state is a
//! [`crate::FromRef`] bound:
//!
//! ```
//! use std::convert::Infallible;
//! use corten::{
//!     extract::{FromRequestParts, OptionalFromRequestParts},
//!     http::{StatusCode, request::Parts},
//!     prelude::*,
//!     security::cookie,
//! };
//!
//! #[derive(Clone)]
//! struct Lists;
//!
//! #[derive(Clone, FromRef)]
//! struct Shared {
//!     lists: Lists,
//! }
//!
//! /// The browser's id, from its `visitor` cookie.
//! struct Visitor(String);
//!
//! impl<S: Sync> FromRequestParts<S> for Visitor
//! where
//!     Lists: FromRef<S>,
//! {
//!     type Rejection = StatusCode;
//!
//!     async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, StatusCode> {
//!         let _lists = Lists::from_ref(state);
//!         let id = cookie::get(&parts.headers, "visitor").ok_or(StatusCode::UNAUTHORIZED)?;
//!         Ok(Visitor(id.to_string()))
//!     }
//! }
//!
//! // So a handler may take `Option<Visitor>`: `None` without the cookie.
//! impl<S: Sync> OptionalFromRequestParts<S> for Visitor
//! where
//!     Lists: FromRef<S>,
//! {
//!     type Rejection = Infallible;
//!
//!     async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Option<Self>, Infallible> {
//!         Ok(<Visitor as FromRequestParts<S>>::from_request_parts(parts, state).await.ok())
//!     }
//! }
//!
//! #[corten::routes(state = Shared)]
//! mod url {
//!     #[route("/", get = home)]
//!     pub struct Home;
//!
//!     #[route("/mine", get = mine)]
//!     pub struct Mine;
//! }
//!
//! async fn home(visitor: Option<Visitor>) -> String {
//!     visitor.map_or_else(String::new, |Visitor(id)| id)
//! }
//!
//! async fn mine(Visitor(id): Visitor) -> String {
//!     id
//! }
//! # fn main() { let _ = App::new(url::router(Shared { lists: Lists })); }
//! ```
//!
//! These are Corten's own traits, with the names, the `Rejection` and the
//! `from_request_parts(parts, state)` signature they had when they were axum's
//! (`docs/design.md#choice-own-extractors`), so an extractor written against axum's compiles
//! against them with its `use` changed. A handler argument that implements neither does not
//! compile, under `no_store` too, which reads its arguments the same way: a route's path and
//! query are its [`crate::Params`], and the routes' state is [`State`].
//!
//! ```compile_fail,E0277
//! use corten::prelude::*;
//!
//! #[corten::routes]
//! mod url {
//!     #[route("/items", get = items, no_store)]
//!     pub struct Items;
//! }
//!
//! struct Visits(u32);
//!
//! async fn items(_: Visits) -> String {
//!     String::new()
//! }
//! # fn main() {}
//! ```
//!
//! A handler that takes the routes' state as Corten's `State` compiles:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[corten::routes]
//! mod url {
//!     #[route("/items", get = items, no_store)]
//!     pub struct Items;
//! }
//!
//! async fn items(_: State<()>) -> String {
//!     String::new()
//! }
//! # fn main() { let _ = App::new(url::router()); }
//! ```
//!
//! Only a handler's last argument reads the body, so one that reads it before another argument,
//! or reads it twice, does not compile:
//!
//! ```compile_fail,E0277
//! use corten::prelude::*;
//!
//! #[corten::routes]
//! mod url {
//!     #[route("/notes", get = notes)]
//!     pub struct Notes;
//! }
//!
//! async fn notes(text: String, _: corten::http::Method) -> String {
//!     text
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail,E0277
//! use corten::prelude::*;
//!
//! #[corten::routes]
//! mod url {
//!     #[route("/notes", get = notes)]
//!     pub struct Notes;
//! }
//!
//! async fn notes(_: corten::Bytes, text: String) -> String {
//!     text
//! }
//! # fn main() {}
//! ```
//!
//! Last, it does:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[corten::routes]
//! mod url {
//!     #[route("/notes", get = notes)]
//!     pub struct Notes;
//! }
//!
//! async fn notes(_: corten::http::Method, text: String) -> String {
//!     text
//! }
//! # fn main() { let _ = App::new(url::router()); }
//! ```
//!
//! A handler that takes the whole [`Request`] reads its body with [`bytes_up_to`], up to a limit
//! of the route's own, and answers a body over it itself.
//!
//! A body too large to hold (a file `PUT` as `application/octet-stream`, to an object store or a
//! disk) is read as it arrives with [`pieces_up_to`], one piece at a time.

use std::{future::Future, pin::Pin, task::Poll, time::Duration};

pub use crate::handler::{FromRequest, FromRequestParts, OptionalFromRequestParts, Request, State};
use bytes::Bytes;
use futures_util::StreamExt;
use http_body::Body as HttpBody;
use tokio::time::Sleep;

use crate::{
    answer::Body,
    body::{BodyDataStream, BoxError},
    form::upload::{join, KEPT_AS_IT_CAME, READ_PAST, SMALL_PIECE},
    http::StatusCode,
    Error,
};

/// The whole body, or `None` when it is larger than `max` bytes: for a handler that takes the
/// [`Request`] and reads its body up to a limit of the route's own, answering a body over it (and
/// one that does not parse) itself, as a route that keeps another server's error shape must.
/// `Json`, [`crate::Form`] and [`crate::Bytes`] refuse a body before the handler runs,
/// with the app's limit and Corten's answer. A body over `max` is read past, not kept, up to
/// 64 MiB past it, so a client still sending reads the handler's answer rather than a closed
/// connection, as an upload's is ([`crate::form::File::bytes_up_to`]); past that, or when its
/// length says it is, it is `None` at once and the connection closes after the answer. The
/// route's deadline (the app's, its area's or its API's, [`crate::App::deadline`]) coming while
/// this waits for the body, read past or not, is the client's 408 under [`crate::serve`], not a
/// `None` the handler sees. `Err` is
/// a body that could not be read (the connection broke), a 400 the handler passes on with `?`,
/// or answers in its own shape with why (`error.to_string()`) and its status
/// ([`Error::status_code`]).
///
#[cfg_attr(feature = "json", doc = "```")]
#[cfg_attr(not(feature = "json"), doc = "```ignore")]
/// use corten::{extract::{bytes_up_to, Request}, http::StatusCode, prelude::*, JsonError, JsonResponse};
///
/// /// The largest configuration this route takes.
/// const MAX_BODY_BYTES: usize = 1024 * 1024;
///
/// /// The shape of the server this route replaces.
/// #[derive(serde::Serialize, ToJson)]
/// struct Said { error: String }
///
/// #[derive(serde::Serialize, ToJson)]
/// struct Replaced { bytes: usize }
///
/// async fn replace(request: Request) -> Result<JsonResponse, JsonError> {
///     let refused = |status, error: String| Json(Said { error }).with_status(status);
///     let bytes = match bytes_up_to(request.into_body(), MAX_BODY_BYTES).await {
///         Ok(Some(bytes)) => bytes,
///         Ok(None) => return Err(refused(StatusCode::INTERNAL_SERVER_ERROR, "Error: length limit exceeded".into()).into()),
///         Err(error) => return Err(refused(error.status_code(), format!("Error: {error}")).into()),
///     };
///     let Ok(text) = std::str::from_utf8(&bytes) else {
///         return Err(refused(StatusCode::INTERNAL_SERVER_ERROR, "SyntaxError: not UTF-8".into()).into());
///     };
///     Ok(Json(Replaced { bytes: text.len() }).into())
/// }
///
/// #[corten::routes]
/// mod url {
///     #[route("/configuration", put = replace)]
///     pub struct Configuration;
/// }
/// # fn main() { let _ = App::new(url::router()); }
/// ```
pub async fn bytes_up_to(body: Body, max: usize) -> Result<Option<Bytes>, Error> {
    up_to(body, max, READ_PAST, None).await
}

/// [`bytes_up_to`], reading at most `past` bytes past `max` before giving up on the client;
/// `over` marks a wait there for the deadline, as [`read_past`] says.
async fn up_to(body: Body, max: usize, past: usize, over: Option<Over>) -> Result<Option<Bytes>, Error> {
    if body.size_hint().lower() > max.saturating_add(past) as u64 {
        return Ok(None);
    }
    // As an upload's file is read: a piece of 1 KiB or more is kept as it came, a run of smaller
    // ones is copied into one buffer as they arrive (so a body sent a few bytes at a time holds
    // about its size, not a handle for each), and the pieces are joined once, at the end.
    let mut pieces: Vec<Bytes> = Vec::new();
    let mut small: Vec<u8> = Vec::new();
    let mut len: usize = 0;
    let mut stream = body.into_data_stream();
    while let Some(piece) = stream.next().await {
        let piece = piece.map_err(|e| Error::new(e).with_status(StatusCode::BAD_REQUEST))?;
        len = len.saturating_add(piece.len());
        if len > max {
            drop((pieces, small));
            // Read past, so the client reads the answer; a read that breaks here leaves the same.
            read_past(&mut stream, len, max.saturating_add(past), &mut Idle::new(None), over).await;
            return Ok(None);
        }
        if piece.len() >= SMALL_PIECE {
            if !small.is_empty() {
                pieces.push(Bytes::from(std::mem::take(&mut small)));
            }
            pieces.push(piece);
        } else {
            small.extend_from_slice(&piece);
        }
    }
    Ok(Some(match (pieces.len(), small.is_empty()) {
        (0, _) => Bytes::from(small.into_boxed_slice()),
        // A large body that came in one piece is kept as it came. A small one is copied: the piece
        // can be a slice of a read buffer hundreds of KiB long, which keeping it would hold whole.
        (1, true) if pieces[0].len() >= KEPT_AS_IT_CAME => pieces.swap_remove(0),
        (1, true) => Bytes::copy_from_slice(&pieces[0]),
        _ => join(&pieces, &small, len),
    }))
}

/// The most of a body [`crate::Bytes`], `String`, [`crate::Json`] and [`crate::Form`] read: 2 MiB.
pub(crate) const BODY_LIMIT: usize = 2 << 20;

/// The whole body, for a reader that refuses the request before the handler runs: over
/// [`BODY_LIMIT`] a 413, and a body that could not be read a 400. A body over the limit is read
/// past until 4 MiB of it in all has arrived (and the piece that crossed that), so a form a browser
/// is still sending reads the answer; one that says it is longer is refused before any of it is
/// read. The
/// readers serve every route that takes one, so what a refused request can cost is kept near what
/// the limit allows, not the 64 MiB an upload, which the app chose a limit for, is read past by.
pub(crate) async fn whole(body: Body) -> Result<Bytes, BodyRejection> {
    const FAILED: &str = "Failed to buffer the request body";
    // A deadline that passes while the rest is read past answers this 413, not a 408 that would
    // tell the client to send the same body again.
    match up_to(body, BODY_LIMIT, BODY_LIMIT, Some(Over::Body(BODY_LIMIT))).await {
        Ok(Some(bytes)) => Ok(bytes),
        Ok(None) => Err(BodyRejection::new(StatusCode::PAYLOAD_TOO_LARGE, format!("{FAILED}: length limit exceeded"))),
        Err(error) => Err(BodyRejection::new(StatusCode::BAD_REQUEST, format!("{FAILED}: {error}"))),
    }
}

/// Why a reader of the whole body refused a request, before its handler ran: plain text at its
/// status. [`crate::Bytes`], `String`, [`crate::Json`] and [`crate::Form`] refuse a body over
/// 2 MiB (413) or one that could not be read (400); `String` one that is not UTF-8 (400); `Json`
/// and `Form` one without their content type (415), and `Json` one that does not parse (400) or
/// whose value does not fit the type (422). A handler that answers it itself takes
/// `Result<Json<T>, BodyRejection>`.
#[derive(Debug)]
pub struct BodyRejection {
    status: StatusCode,
    text: std::borrow::Cow<'static, str>,
}

impl BodyRejection {
    pub(crate) fn new(status: StatusCode, text: impl Into<std::borrow::Cow<'static, str>>) -> Self {
        BodyRejection { status, text: text.into() }
    }

    /// The status it answers with.
    pub fn status(&self) -> StatusCode {
        self.status
    }

    /// The text it answers with.
    pub fn body_text(&self) -> String {
        self.text.to_string()
    }
}

impl std::fmt::Display for BodyRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text)
    }
}

impl std::error::Error for BodyRejection {}

impl crate::middleware::IntoResponse for BodyRejection {
    fn into_response(self) -> crate::middleware::Response {
        crate::middleware::IntoResponse::into_response((self.status, self.text))
    }
}

/// A body read as it arrives, one piece at a time, up to `max` bytes: for a body too large to
/// hold (a file `PUT` as `application/octet-stream`), which the handler passes on to a disk or an
/// object store as it comes, so the request holds a piece (hyper hands out up to about 500 KiB),
/// not the body. A body that fits in memory is [`bytes_up_to`]'s, and a file in a form is
/// [`crate::Upload`]'s, whose [`crate::form::File::chunk`] this reads as.
///
/// [`Pieces::chunk`] counts what arrives, whatever the `Content-Length` says, and refuses a body
/// over `max` ([`BodyError::TooLarge`], a 413) as [`bytes_up_to`] does: the rest is read past,
/// not kept, until the body has sent 64 MiB more than `max`, so a browser, which sends the whole
/// body before it reads the answer, reads the 413 rather than a closed connection; past that,
/// nothing more is read and the connection is closed after the answer. A body whose length says
/// it is over is refused before a piece is handed out. A client that sends nothing for a minute
/// ([`Pieces::idle`], nginx's `client_body_timeout`), or trickles the body in so slowly that it
/// falls a minute behind 240 bytes a second (Kestrel's minimum rate), is [`BodyError::Stalled`],
/// a 408, and one whose connection broke [`BodyError::Broken`], a 400; both hold while reading
/// past too, so a client still sending at any real speed is never cut off for taking long in all,
/// and one that stops there is still the 413. The handler matches the error to answer in a shape
/// of its own, or passes it on with `?` (under an [`crate::Api`], the API's JSON), after
/// removing what it wrote.
///
/// A large body takes time to arrive, and the route's deadline runs until the answer starts, so
/// its route is in an API (or an area) whose `deadline` leaves time to read it; shutdown waits
/// for that deadline too (the app guide, Shutdown). The handler's future is dropped at the
/// deadline, when the client leaves and at shutdown, so no code after the `await` it was in
/// runs: what it wrote of a body it does not finish is removed by a guard's `Drop` or by work
/// the request's [`crate::Signal`] starts.
///
/// ```
/// use std::time::Duration;
///
/// use corten::{extract::{pieces_up_to, BodyError, Request}, http::StatusCode, prelude::*, Error};
///
/// /// The largest file this route takes.
/// const MAX_BYTES: usize = 1 << 30;
///
/// async fn store(Params(_to): Params<files::Object>, request: Request) -> Result<StatusCode, Error> {
///     let mut pieces = pieces_up_to(request.into_body(), MAX_BYTES);
///     loop {
///         match pieces.chunk().await {
///             // Write `piece` to the store here, awaiting it, so the body is read no faster.
///             Ok(Some(_piece)) => {}
///             Ok(None) => return Ok(StatusCode::CREATED),
///             // Remove what was written of it in each case below: the body did not finish.
///             Err(BodyError::TooLarge { .. }) => {
///                 return Err(Error::new("A file is at most 1 GiB.").with_status(StatusCode::PAYLOAD_TOO_LARGE));
///             }
///             // A 408 or a 400, as `?` would answer it.
///             Err(other) => return Err(other.into()),
///         }
///     }
/// }
///
/// #[corten::routes(api = Files)]
/// mod files {
///     #[route("/files")]
///     pub struct Files;
///
///     #[route("/files/{name}", put = store)]
///     pub struct Object {
///         pub name: String,
///     }
/// }
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// // Fifteen minutes, which sends 1 GiB at about 10 Mbit/s (and reads one over it past), while the
/// // rest of the app keeps its 30 seconds.
/// let app = App::new(Routes::new()).api(|routes| files::api(routes).deadline(Duration::from_secs(900)));
/// let app = app.test();
/// let to = files::Object { name: "photo.jpg".into() };
/// let put = app.call(corten::http::Method::PUT, &to).body("application/octet-stream", vec![7; 1024]);
/// assert_eq!(put.await.status(), StatusCode::CREATED);
/// # }
/// ```
pub fn pieces_up_to(body: Body, max: usize) -> Pieces {
    let said = body.size_hint().lower();
    Pieces {
        stream: body.into_data_stream(),
        max,
        read: 0,
        idle: Idle::new(Some(IDLE)),
        end: if said > max as u64 { End::Said(said) } else { End::Open },
    }
}

std::thread_local! {
    /// What a read of the request body waited for during the handler's poll that the deadline is
    /// making ([`crate::page`]'s `within`): set by [`Arriving`] and [`reading_past`], cleared
    /// before each poll.
    static WAITED: std::cell::Cell<Waited> = const { std::cell::Cell::new(Waited::Nothing) };
}

/// What the handler's last poll waited for of the request body, for the deadline's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Waited {
    /// Nothing of the body.
    Nothing,
    /// The client, to send more of the body.
    Body,
    /// The client, to send more of a body over its limit, read past so the client reads the 413.
    PastLimit(Over),
}

/// The limit a body read past went over, as the reader's own error says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Over {
    /// [`pieces_up_to`]'s `max`.
    Body(usize),
    /// [`crate::Upload::limit`].
    Upload(usize),
}

/// A request body as it arrives from the connection ([`crate::serve`]), which marks a read that
/// waits for the client, so a deadline that passes while the handler waits for the body answers
/// as the client's (a 408), not as the server's (#1061). It allocates nothing: the mark is one
/// thread-local value, set only when a read waits.
pub(crate) struct Arriving<B>(pub(crate) B);

impl<B: HttpBody + Unpin> HttpBody for Arriving<B> {
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<B::Data>, B::Error>>> {
        let polled = Pin::new(&mut self.0).poll_frame(cx);
        if polled.is_pending() && WAITED.get() == Waited::Nothing {
            WAITED.set(Waited::Body);
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.0.size_hint()
    }
}

/// Forgets a wait for the request body, before the handler is polled again.
#[inline]
pub(crate) fn forget_wait() {
    WAITED.set(Waited::Nothing);
}

/// What the handler's last poll waited for of the request body.
pub(crate) fn waited() -> Waited {
    WAITED.get()
}

/// `fut`, a read of a body over `over`'s limit that is read past: a poll of it that waits marks
/// the wait as one past the limit, so a deadline that passes there answers the 413 the read gives.
pub(crate) async fn reading_past<F: Future>(over: Over, fut: F) -> F::Output {
    let mut fut = std::pin::pin!(fut);
    std::future::poll_fn(|cx| {
        let polled = fut.as_mut().poll(cx);
        if polled.is_pending() {
            WAITED.set(Waited::PastLimit(over));
        }
        polled
    })
    .await
}

/// How long [`Pieces`] waits for the next piece unless [`Pieces::idle`] says otherwise: nginx's
/// `client_body_timeout`.
pub(crate) const IDLE: Duration = Duration::from_secs(60);

/// A body read as it arrives, up to a limit: [`pieces_up_to`].
pub struct Pieces {
    stream: BodyDataStream,
    max: usize,
    /// What has arrived and been counted against `max`, up to the piece that went over it (what is
    /// read past after is not).
    read: usize,
    idle: Idle,
    end: End,
}

/// How far a [`Pieces`] has read.
#[derive(Clone, Copy)]
enum End {
    /// Reading.
    Open,
    /// Its length says it is over the limit, by this many bytes in all: not yet read.
    Said(u64),
    /// Over the limit: refused, and read past.
    Over,
    /// The client stopped sending.
    Stalled,
    /// The body could not be read.
    Broken,
    /// Read to its end.
    Done,
}

/// Why [`Pieces::chunk`] stopped. `?` turns it into an [`Error`] with its status.
#[derive(Debug)]
pub enum BodyError {
    /// The body is over the limit (413). It was read past, so a client still sending reads the
    /// answer.
    TooLarge { limit: usize },
    /// The client sent nothing for [`Pieces::idle`], or sent the body so slowly that it fell that
    /// far behind 240 bytes a second (408). The connection is closed after the answer.
    Stalled,
    /// The body could not be read: the connection broke (400).
    Broken(String),
}

impl std::fmt::Display for BodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BodyError::TooLarge { limit } => write!(f, "the body is larger than its limit of {limit} bytes"),
            BodyError::Stalled => f.write_str("the client stopped sending the body"),
            BodyError::Broken(what) => write!(f, "the body could not be read: {what}"),
        }
    }
}

impl From<BodyError> for Error {
    fn from(error: BodyError) -> Self {
        let status = match error {
            BodyError::TooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
            BodyError::Stalled => StatusCode::REQUEST_TIMEOUT,
            BodyError::Broken(_) => StatusCode::BAD_REQUEST,
        };
        Error::new(error.to_string()).with_status(status)
    }
}

impl Pieces {
    /// How long the client may go without sending a piece, here and while a body over the limit
    /// is read past: a minute unless set. It is also the body's allowance against a trickle: the
    /// reads may wait for the client that long plus a second for every 240 bytes that came, in
    /// all (time the handler spends between reads is not counted), so a byte now and then does
    /// not hold the request. A read dropped and begun again (inside a `timeout` or `select!`) does
    /// not start the idle time again. That assumes the handler asks for the next piece promptly:
    /// one that spends a fixed time on each piece lets a client that sends one in that time go on.
    /// `None` leaves only the route's deadline, for both.
    pub fn idle(mut self, idle: impl Into<Option<Duration>>) -> Self {
        self.idle.set(idle.into());
        self
    }

    /// The body's next piece as it arrives, `None` at its end; once it fails, the same failure
    /// at every call after.
    pub async fn chunk(&mut self) -> Result<Option<Bytes>, BodyError> {
        match self.end {
            End::Open => {}
            End::Said(said) => {
                // Refused first, so a read past given up on is not begun again.
                self.end = End::Over;
                if said <= self.max.saturating_add(READ_PAST) as u64 {
                    let past = self.max.saturating_add(READ_PAST);
                    read_past(&mut self.stream, 0, past, &mut self.idle, Some(Over::Body(self.max))).await;
                }
                return Err(BodyError::TooLarge { limit: self.max });
            }
            End::Over => return Err(BodyError::TooLarge { limit: self.max }),
            End::Stalled => return Err(BodyError::Stalled),
            End::Broken => return Err(BodyError::Broken("an earlier piece failed".into())),
            End::Done => return Ok(None),
        }
        match self.idle.next(&mut self.stream).await {
            None => {
                self.end = End::Stalled;
                Err(BodyError::Stalled)
            }
            Some(None) => {
                self.end = End::Done;
                Ok(None)
            }
            Some(Some(Err(error))) => {
                self.end = End::Broken;
                Err(BodyError::Broken(error.to_string()))
            }
            Some(Some(Ok(piece))) => {
                self.read = self.read.saturating_add(piece.len());
                if self.read > self.max {
                    self.end = End::Over;
                    let past = self.max.saturating_add(READ_PAST);
                    read_past(&mut self.stream, self.read, past, &mut self.idle, Some(Over::Body(self.max))).await;
                    return Err(BodyError::TooLarge { limit: self.max });
                }
                Ok(Some(piece))
            }
        }
    }

    /// What has arrived so far, counted as it came.
    pub fn read(&self) -> usize {
        self.read
    }
}

/// How long a body's reader waits for its next piece ([`Pieces::idle`], [`crate::Upload::idle`]),
/// with one timer for the whole body, made the first time a read waits. A read that waits after it
/// notes when it is due and leaves the timer where it is; only a timer that goes off before the
/// read it serves is due is moved to that time. So a piece that has arrived is taken without
/// touching the timer, and a read that waits reads the clock when it begins to wait and when its
/// piece comes, and allocates nothing (measured, callgrind, #1030, #1074).
///
/// The idle time is also an allowance for the whole body ([`MIN_BODY_RATE`]): the reads may wait
/// for the client the idle time, plus a second for each `MIN_BODY_RATE` bytes that came, in all.
/// So a client that sends a byte now and then, which resets an idle time alone, is given up on
/// once it falls that far behind the rate; time the handler spends between reads is not counted.
/// A read dropped while it waits (inside a `timeout`) counts what it waited, and the idle time
/// runs on from when the client went quiet, so reads begun again do not hold a silent client
/// longer than one read would.
pub(crate) struct Idle {
    time: Option<Duration>,
    timer: Option<Pin<Box<Sleep>>>,
    /// Nanoseconds the reads have waited for the client in all, a read dropped while it waited
    /// (inside a `timeout` or a `select!`) included ([`NextPiece`]).
    waited: u64,
    /// Nanoseconds of waiting the pieces that came have earned: [`WAIT_PER_BYTE`] each byte.
    earned: u64,
    /// When the client went quiet: when a read began to wait with none set, cleared when a piece
    /// comes. The idle time runs from here, so reads begun again (inside a `timeout`) do not
    /// start it again; the handler's time between them counts only while no piece came.
    quiet: Option<tokio::time::Instant>,
}

/// The slowest a body is read at, past its idle time: Kestrel's `MinRequestBodyDataRate`, 240
/// bytes a second (#1074).
pub(crate) const MIN_BODY_RATE: u64 = 240;

/// Nanoseconds of waiting each byte of a body earns.
const WAIT_PER_BYTE: u64 = 1_000_000_000 / MIN_BODY_RATE;

impl Idle {
    pub(crate) const fn new(time: Option<Duration>) -> Self {
        Idle { time, timer: None, waited: 0, earned: 0, quiet: None }
    }

    /// Sets the idle time, keeping what the body has waited and earned so far. The timer, set for
    /// the old one, is made again by the next read that waits.
    pub(crate) fn set(&mut self, time: Option<Duration>) {
        self.time = time;
        self.timer = None;
    }

    /// The stream's next item, or `None` when the idle time passed first.
    #[inline]
    pub(crate) fn next<'a>(&'a mut self, stream: &'a mut BodyDataStream) -> NextPiece<'a> {
        NextPiece { idle: self, stream, since: None, due: None }
    }
}

/// A read of a body's next piece ([`Idle::next`]): the stream's next item, or `None` when the idle
/// time passed first. What it waited for the client counts for the body even when it is dropped
/// first (a read inside a `timeout`), and the time after that, the handler's, does not.
pub(crate) struct NextPiece<'a> {
    idle: &'a mut Idle,
    stream: &'a mut BodyDataStream,
    /// When this read began to wait for the client; `None` until it waits.
    since: Option<tokio::time::Instant>,
    /// When it gives up; `None` until it waits, or when the idle time is too long to add to the
    /// clock (`Duration::MAX`), which never gives up.
    due: Option<tokio::time::Instant>,
}

impl NextPiece<'_> {
    /// Adds what this read has waited to the body's waits.
    #[inline]
    fn stop_waiting(&mut self) {
        if let Some(at) = self.since.take() {
            let waited = tokio::time::Instant::now().saturating_duration_since(at);
            self.idle.waited = self.idle.waited.saturating_add(u64::try_from(waited.as_nanos()).unwrap_or(u64::MAX));
        }
    }
}

impl Future for NextPiece<'_> {
    type Output = Option<Option<Result<Bytes, BoxError>>>;

    #[inline]
    fn poll(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> Poll<Self::Output> {
        let read = &mut *self;
        if let Poll::Ready(item) = read.stream.poll_next_unpin(cx) {
            read.stop_waiting();
            read.idle.quiet = None;
            if let (Some(_), Some(Ok(piece))) = (read.idle.time, &item) {
                read.idle.earned = read.idle.earned.saturating_add((piece.len() as u64).saturating_mul(WAIT_PER_BYTE));
            }
            return Poll::Ready(Some(item));
        }
        let Some(time) = read.idle.time else { return Poll::Pending };
        if read.since.is_none() {
            let now = tokio::time::Instant::now();
            read.since = Some(now);
            // The idle time from when the client went quiet, or the idle time less what the body
            // has waited past what its bytes earned, whichever comes first. Neither is earlier
            // than the last read's, so the timer is never late for this one.
            let quiet = *read.idle.quiet.get_or_insert(now);
            let behind = Duration::from_nanos(read.idle.waited.saturating_sub(read.idle.earned));
            read.due = match (quiet.checked_add(time), now.checked_add(time.saturating_sub(behind))) {
                (Some(idle), Some(rate)) => Some(idle.min(rate)),
                (idle, rate) => idle.or(rate),
            };
        }
        let Some(due) = read.due else { return Poll::Pending };
        let timer = read.idle.timer.get_or_insert_with(|| Box::pin(tokio::time::sleep_until(due)));
        loop {
            if timer.as_mut().poll(cx).is_pending() {
                return Poll::Pending;
            }
            if timer.deadline() >= due {
                return Poll::Ready(None);
            }
            // Set for an earlier read: moved to this one's time, and polled there.
            timer.as_mut().reset(due);
        }
    }
}

impl Drop for NextPiece<'_> {
    #[inline]
    fn drop(&mut self) {
        self.stop_waiting();
    }
}

/// Reads the rest of a body over its limit, keeping nothing, until it ends, breaks, `read` (what
/// arrived of it before) is over `past` (the limit and what is read past it), or no piece comes
/// for `idle`, so a client still sending reads the answer. `over` marks a wait here for the deadline, which then answers the
/// read's 413; `None` (for [`bytes_up_to`], whose handler answers in a shape of its own) leaves it
/// a wait for the body, the 408.
async fn read_past(stream: &mut BodyDataStream, mut read: usize, past: usize, idle: &mut Idle, over: Option<Over>) {
    while read <= past {
        let next = idle.next(stream);
        let piece = match over {
            Some(over) => reading_past(over, next).await,
            None => next.await,
        };
        match piece {
            Some(Some(Ok(piece))) => read = read.saturating_add(piece.len()),
            _ => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use futures_util::{stream, StreamExt};

    use super::{bytes_up_to, pieces_up_to, BodyError, Pieces};
    use crate::{answer::Body, http::StatusCode, middleware::IntoResponse, Error};

    /// A body in pieces, with no length up front, as a chunked request sends it.
    fn streamed(pieces: &[&'static str]) -> Body {
        let pieces: Vec<Result<Bytes, std::io::Error>> = pieces.iter().map(|p| Ok(Bytes::from_static(p.as_bytes()))).collect();
        Body::from_stream(stream::iter(pieces))
    }

    #[tokio::test]
    async fn a_body_up_to_the_limit_is_read_whole() {
        assert_eq!(bytes_up_to(Body::from("12345"), 5).await.unwrap().as_deref(), Some(&b"12345"[..]));
        assert_eq!(bytes_up_to(streamed(&["12", "345"]), 5).await.unwrap().as_deref(), Some(&b"12345"[..]));
        assert_eq!(bytes_up_to(Body::empty(), 0).await.unwrap().as_deref(), Some(&b""[..]));
    }

    #[tokio::test]
    async fn a_body_over_the_limit_is_none_whether_its_length_is_known_or_not() {
        assert_eq!(bytes_up_to(Body::from("123456"), 5).await.unwrap(), None);
        assert_eq!(bytes_up_to(streamed(&["123", "456"]), 5).await.unwrap(), None);
    }

    /// A body over the limit is read past, so the client reads the answer: the pieces after the
    /// one that went over are read too, and none is kept.
    #[tokio::test]
    async fn a_body_over_the_limit_is_read_past() {
        let read = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = read.clone();
        let pieces = stream::iter(["123", "456", "789", "0"]).map(move |p| {
            counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok::<_, std::io::Error>(Bytes::from_static(p.as_bytes()))
        });
        assert_eq!(bytes_up_to(Body::from_stream(pieces), 5).await.unwrap(), None);
        assert_eq!(read.load(std::sync::atomic::Ordering::Relaxed), 4);
    }

    /// Reading past stops 64 MiB past the limit, where the connection is closed after the answer:
    /// of 70 pieces of 1 MiB with nothing allowed, the one that went over and 64 more are read.
    #[tokio::test]
    async fn reading_past_stops_64_mib_past_the_limit() {
        let read = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = read.clone();
        let mib = Bytes::from(vec![0; 1 << 20]);
        let pieces = stream::iter(std::iter::repeat_n(mib, 70)).map(move |p| {
            counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok::<_, std::io::Error>(p)
        });
        assert_eq!(bytes_up_to(Body::from_stream(pieces), 0).await.unwrap(), None);
        assert_eq!(read.load(std::sync::atomic::Ordering::Relaxed), 65);
    }

    /// A body sent a byte at a time comes back whole and in order.
    #[tokio::test]
    async fn a_body_sent_a_byte_at_a_time_is_whole() {
        let text: Vec<Bytes> = (0..3000).map(|n| Bytes::from(vec![b'a' + (n % 26) as u8])).collect();
        let want: Vec<u8> = text.iter().flat_map(|b| b.iter().copied()).collect();
        let body = Body::from_stream(stream::iter(text.into_iter().map(Ok::<_, std::io::Error>)));
        assert_eq!(bytes_up_to(body, 1 << 20).await.unwrap().as_deref(), Some(&want[..]));
        // Small pieces between large ones are kept in order.
        let mixed = ["ab", std::str::from_utf8(&[b'x'; 2048]).unwrap(), "cd"]
            .map(|p| Ok::<_, std::io::Error>(Bytes::copy_from_slice(p.as_bytes())));
        let read = bytes_up_to(Body::from_stream(stream::iter(mixed)), 1 << 20).await.unwrap().unwrap();
        assert_eq!(read.len(), 2052);
        assert!(read.starts_with(b"abx") && read.ends_with(b"xcd"));
    }

    /// A body whose length is known to be over by more than is read past is not read: here,
    /// reading it would fail.
    #[tokio::test]
    async fn a_body_whose_length_is_far_over_is_not_read() {
        let body = Body::new(Sized(Some(Err(std::io::Error::other("read")))));
        assert_eq!(bytes_up_to(body, 5).await.unwrap(), None);
    }

    /// A reader of the whole body (`Json`, `Form`, `String`, `Bytes`) reads past its 2 MiB by at
    /// most 2 MiB more: of ten pieces of 1 MiB, the three that went over and two more are read,
    /// and a body that says it is longer than 4 MiB is refused before any of it is read.
    #[tokio::test]
    async fn a_whole_body_reader_reads_past_by_its_own_limit() {
        let read = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = read.clone();
        let mib = Bytes::from(vec![0; 1 << 20]);
        let pieces = stream::iter(std::iter::repeat_n(mib, 10)).map(move |p| {
            counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok::<_, std::io::Error>(p)
        });
        let refused = super::whole(Body::from_stream(pieces)).await.unwrap_err();
        assert_eq!(refused.into_response().status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(read.load(std::sync::atomic::Ordering::Relaxed), 5);

        let said = Body::new(Said(4 << 20 | 1));
        let refused = super::whole(said).await.unwrap_err();
        assert_eq!(refused.into_response().status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// A body that says how long it is, and fails if it is read.
    struct Said(u64);

    impl http_body::Body for Said {
        type Data = Bytes;
        type Error = std::io::Error;

        fn poll_frame(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<Bytes>, std::io::Error>>> {
            std::task::Poll::Ready(Some(Err(std::io::Error::other("read"))))
        }

        fn size_hint(&self) -> http_body::SizeHint {
            http_body::SizeHint::with_exact(self.0)
        }
    }

    /// A small body that came in one piece is copied out of the buffer it was cut from; a large one
    /// is kept as it came.
    #[tokio::test]
    async fn a_small_body_is_copied_and_a_large_one_kept() {
        let buffer = Bytes::from(vec![b'x'; 256 << 10]);
        let small = bytes_up_to(Body::from(buffer.slice(..1024)), 1 << 20).await.unwrap().unwrap();
        assert_ne!(small.as_ptr(), buffer.as_ptr());
        let large = bytes_up_to(Body::from(buffer.slice(..128 << 10)), 1 << 20).await.unwrap().unwrap();
        assert_eq!(large.as_ptr(), buffer.as_ptr());
    }

    /// A body that says it holds more than 64 MiB past the limit, and fails if it is read.
    struct Sized(Option<Result<http_body::Frame<Bytes>, std::io::Error>>);

    impl http_body::Body for Sized {
        type Data = Bytes;
        type Error = std::io::Error;

        fn poll_frame(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<Bytes>, std::io::Error>>> {
            std::task::Poll::Ready(self.0.take())
        }

        fn size_hint(&self) -> http_body::SizeHint {
            http_body::SizeHint::with_exact(5 + super::READ_PAST as u64 + 1)
        }
    }

    /// What reading a body costs: `BODY_READS` (200) reads of an 8 KiB body in one piece and of
    /// one in 1 KiB pieces, by `READER` (`ours`, or `pieces`). Counted under callgrind at two numbers of reads, the difference over 1,000 is the
    /// cost of 1,000 of each.
    #[test]
    #[ignore]
    fn what_reading_a_body_costs() {
        let reads: usize = std::env::var("BODY_READS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
        // `READER=pieces`: `Pieces` read a byte at a time, each byte waited for (#1030).
        let raw = std::env::var("READER").is_ok_and(|r| r == "pieces");
        let whole = Bytes::from(vec![b'x'; 8 * 1024]);
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        runtime.block_on(async {
            for _ in 0..reads {
                for body in [Body::from(whole.clone()), {
                    let pieces: Vec<Result<Bytes, std::io::Error>> =
                        (0..8).map(|n| Ok(whole.slice(n * 1024..(n + 1) * 1024))).collect();
                    Body::from_stream(stream::iter(pieces))
                }] {
                    if raw {
                        // `Pieces` (`pieces_up_to`), 8 KiB a byte at a time, each byte waited for.
                        let mut bytes = whole.iter().map(|b| Bytes::copy_from_slice(&[*b])).collect::<Vec<_>>().into_iter();
                        let mut wait = true;
                        let waits = stream::poll_fn(move |cx| {
                            if wait {
                                wait = false;
                                cx.waker().wake_by_ref();
                                return std::task::Poll::Pending;
                            }
                            wait = true;
                            std::task::Poll::Ready(bytes.next().map(Ok::<_, std::io::Error>))
                        });
                        let mut pieces = super::pieces_up_to(Body::from_stream(waits), 1 << 20);
                        let mut got = 0;
                        while let Some(piece) = pieces.chunk().await.unwrap() {
                            got += std::hint::black_box(piece).len();
                        }
                        assert_eq!(got, 8 * 1024);
                        drop(body);
                        continue;
                    }
                    let read = bytes_up_to(body, 1 << 20).await.unwrap().unwrap();
                    assert_eq!(std::hint::black_box(read).len(), 8 * 1024);
                }
            }
        });
    }

    #[tokio::test]
    async fn a_body_that_cannot_be_read_is_a_400() {
        let broken: Vec<Result<Bytes, std::io::Error>> =
            vec![Ok(Bytes::from_static(b"12")), Err(std::io::Error::other("the connection broke"))];
        let e = bytes_up_to(Body::from_stream(stream::iter(broken)), 5).await.unwrap_err();
        assert_eq!(e.into_response().status(), StatusCode::BAD_REQUEST);
    }

    /// Every piece `chunk` hands out until the end, or the status it failed with.
    async fn all(pieces: &mut Pieces) -> Result<Vec<u8>, StatusCode> {
        let mut got = Vec::new();
        loop {
            match pieces.chunk().await {
                Ok(Some(piece)) => got.extend_from_slice(&piece),
                Ok(None) => return Ok(got),
                Err(e) => return Err(Error::from(e).into_response().status()),
            }
        }
    }

    /// Pieces are handed out as they came, up to and at the limit, whether the length is known or
    /// not; an empty body is no piece at all.
    #[tokio::test]
    async fn a_body_up_to_the_limit_is_handed_out_piece_by_piece() {
        let mut pieces = pieces_up_to(streamed(&["12", "3", "45"]), 5);
        for want in ["12", "3", "45"] {
            assert_eq!(pieces.chunk().await.unwrap().as_deref(), Some(want.as_bytes()));
        }
        assert_eq!(pieces.chunk().await.unwrap(), None);
        assert_eq!(pieces.chunk().await.unwrap(), None, "and at every call after the end");
        assert_eq!(pieces.read(), 5);
        assert_eq!(all(&mut pieces_up_to(Body::from("12345"), 5)).await.as_deref(), Ok(&b"12345"[..]));
        assert_eq!(all(&mut pieces_up_to(Body::empty(), 0)).await.as_deref(), Ok(&b""[..]));
        let bytes = (0..3000).map(|n| Ok::<_, std::io::Error>(Bytes::from(vec![b'a' + (n % 26) as u8])));
        let want: Vec<u8> = (0..3000).map(|n| b'a' + (n % 26) as u8).collect();
        assert_eq!(all(&mut pieces_up_to(Body::from_stream(stream::iter(bytes)), 3000)).await, Ok(want), "a byte at a time");
    }

    /// Over the limit is a 413 at the piece that went over (none of it handed out) and at every
    /// call after; the pieces before it were handed out, so the handler removes what it wrote.
    #[tokio::test]
    async fn a_body_over_the_limit_is_a_413_at_the_piece_that_goes_over() {
        let mut pieces = pieces_up_to(streamed(&["123", "456", "7"]), 5);
        assert_eq!(pieces.chunk().await.unwrap().as_deref(), Some(&b"123"[..]));
        assert_eq!(Error::from(pieces.chunk().await.unwrap_err()).into_response().status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(Error::from(pieces.chunk().await.unwrap_err()).into_response().status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(pieces.read(), 6, "what was read past is not counted as arrived before the refusal");
    }

    /// A body whose length says it is over is refused before a piece is handed out, and read past
    /// so the client reads the answer.
    #[tokio::test]
    async fn a_body_whose_length_is_over_hands_out_nothing() {
        assert_eq!(all(&mut pieces_up_to(Body::from("123456"), 5)).await, Err(StatusCode::PAYLOAD_TOO_LARGE));
        // Far over (more than 64 MiB past): not read at all; here, reading it would fail.
        let body = Body::new(Sized(Some(Err(std::io::Error::other("read")))));
        assert_eq!(all(&mut pieces_up_to(body, 5)).await, Err(StatusCode::PAYLOAD_TOO_LARGE));
    }

    /// Reading past stops 64 MiB past the limit, as `bytes_up_to`'s does: of 70 pieces of 1 MiB with
    /// nothing allowed, the one that went over and 64 more are read.
    #[tokio::test]
    async fn pieces_are_read_past_no_further_than_64_mib() {
        let read = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = read.clone();
        let mib = Bytes::from(vec![0; 1 << 20]);
        let body = stream::iter(std::iter::repeat_n(mib, 70)).map(move |p| {
            counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok::<_, std::io::Error>(p)
        });
        assert_eq!(all(&mut pieces_up_to(Body::from_stream(body), 0)).await, Err(StatusCode::PAYLOAD_TOO_LARGE));
        assert_eq!(read.load(std::sync::atomic::Ordering::Relaxed), 65);
    }

    /// A read past given up on (the handler's future dropped, at its deadline) is not begun again:
    /// the next call is the 413 at once.
    #[tokio::test]
    async fn a_read_past_given_up_on_is_not_begun_again() {
        let first: Vec<Result<Bytes, std::io::Error>> = vec![Ok(Bytes::from_static(b"123456"))];
        let body = Body::from_stream(stream::iter(first).chain(stream::pending()));
        let mut pieces = pieces_up_to(body, 5);
        let given_up = tokio::time::timeout(std::time::Duration::from_millis(20), pieces.chunk()).await;
        assert!(given_up.is_err(), "the read past waits on the rest of the body");
        let again = tokio::time::timeout(std::time::Duration::from_secs(5), pieces.chunk()).await;
        assert_eq!(Error::from(again.unwrap().unwrap_err()).into_response().status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// A body that breaks is a 400, distinct from one over its limit, at every call after too.
    #[tokio::test]
    async fn a_body_that_breaks_is_a_400() {
        let broken: Vec<Result<Bytes, std::io::Error>> =
            vec![Ok(Bytes::from_static(b"12")), Err(std::io::Error::other("the connection broke"))];
        let mut pieces = pieces_up_to(Body::from_stream(stream::iter(broken)), 5);
        assert_eq!(pieces.chunk().await.unwrap().as_deref(), Some(&b"12"[..]));
        assert_eq!(Error::from(pieces.chunk().await.unwrap_err()).into_response().status(), StatusCode::BAD_REQUEST);
        assert_eq!(Error::from(pieces.chunk().await.unwrap_err()).into_response().status(), StatusCode::BAD_REQUEST);
    }

    /// A client that sends nothing for the idle time is a 408, while reading and at every call
    /// after; `None` waits as long as the route's deadline lets it.
    #[tokio::test(start_paused = true)]
    async fn a_client_that_stops_sending_is_a_408() {
        let stalls = || {
            let first = stream::iter([Ok::<_, std::io::Error>(Bytes::from_static(b"12"))]);
            Body::from_stream(first.chain(stream::pending()))
        };
        let mut pieces = pieces_up_to(stalls(), 5);
        assert_eq!(pieces.chunk().await.unwrap().as_deref(), Some(&b"12"[..]));
        let started = tokio::time::Instant::now();
        assert!(matches!(pieces.chunk().await, Err(BodyError::Stalled)));
        assert_eq!(started.elapsed(), std::time::Duration::from_secs(60));
        assert_eq!(Error::from(pieces.chunk().await.unwrap_err()).into_response().status(), StatusCode::REQUEST_TIMEOUT);
        let mut waits = pieces_up_to(stalls(), 5).idle(None);
        waits.chunk().await.unwrap();
        let waited = tokio::time::timeout(std::time::Duration::from_secs(3600), waits.chunk()).await;
        assert!(waited.is_err(), "no idle time of its own");
    }

    /// The idle time holds piece by piece while a body over the limit is read past, not for the
    /// read past in all: a client sending steadily (above the minimum rate), however long it takes,
    /// reads the 413, and one that stops is answered after the idle time.
    #[tokio::test(start_paused = true)]
    async fn reading_past_waits_the_idle_time_for_each_piece() {
        let sent = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = sent.clone();
        // 40 pieces, 20 seconds apart: 13 minutes in all, each within the minute, at 409 bytes a
        // second after the first.
        let slow = stream::iter(0..40).then(move |n| {
            let counted = counted.clone();
            async move {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok::<_, std::io::Error>(if n == 0 { Bytes::from_static(b"123") } else { Bytes::from(vec![b'x'; 8192]) })
            }
        });
        let mut pieces = pieces_up_to(Body::from_stream(slow), 5);
        assert_eq!(pieces.chunk().await.unwrap().as_deref(), Some(&b"123"[..]));
        assert!(matches!(pieces.chunk().await, Err(BodyError::TooLarge { limit: 5 })));
        assert_eq!(sent.load(std::sync::atomic::Ordering::Relaxed), 40, "read to its end");
        let first: Vec<Result<Bytes, std::io::Error>> = vec![Ok(Bytes::from_static(b"123456"))];
        let stops = Body::from_stream(stream::iter(first).chain(stream::pending()));
        let started = tokio::time::Instant::now();
        assert!(matches!(pieces_up_to(stops, 5).chunk().await, Err(BodyError::TooLarge { limit: 5 })));
        assert_eq!(started.elapsed(), std::time::Duration::from_secs(60));
    }

    /// A body of `count` pieces of `size` bytes, each `every` after the read for it begins
    /// (so only time spent waiting for it passes).
    fn sent_every(count: usize, size: usize, every: std::time::Duration) -> Body {
        let piece = Bytes::from(vec![b'x'; size]);
        Body::from_stream(stream::iter(0..count).then(move |_| {
            let piece = piece.clone();
            async move {
                tokio::time::sleep(every).await;
                Ok::<_, std::io::Error>(piece)
            }
        }))
    }

    /// Reads `pieces` to its end or its first failure: the bytes read and the failure.
    async fn read_all(pieces: &mut Pieces) -> (usize, Option<BodyError>) {
        let mut read = 0;
        loop {
            match pieces.chunk().await {
                Ok(Some(piece)) => read += piece.len(),
                Ok(None) => return (read, None),
                Err(error) => return (read, Some(error)),
            }
        }
    }

    /// A body trickled in a byte a second, each byte well within the idle time, is given up on once
    /// it falls the idle time behind the minimum rate: at 60.25 s, with 60 bytes read, a 408
    /// (#1074). Without an idle time (`idle(None)`) it is read for as long as it is sent.
    #[tokio::test(start_paused = true)]
    async fn a_body_trickled_in_is_a_408_once_it_falls_behind_the_rate() {
        let started = tokio::time::Instant::now();
        let mut pieces = pieces_up_to(sent_every(10_000, 1, std::time::Duration::from_secs(1)), usize::MAX);
        let (read, failed) = read_all(&mut pieces).await;
        assert!(matches!(failed, Some(BodyError::Stalled)), "{failed:?}");
        assert_eq!(read, 60);
        let took = started.elapsed().as_millis();
        assert!((60_249..=60_251).contains(&took), "{took} ms");
        assert_eq!(Error::from(pieces.chunk().await.unwrap_err()).into_response().status(), StatusCode::REQUEST_TIMEOUT);
        let mut waits = pieces_up_to(sent_every(10_000, 1, std::time::Duration::from_secs(1)), usize::MAX).idle(None);
        let read = tokio::time::timeout(std::time::Duration::from_secs(3600), read_all(&mut waits)).await;
        assert!(read.is_err(), "still reading after an hour");
        // A longer idle time is a longer allowance: two minutes, about twice as long.
        let started = tokio::time::Instant::now();
        let mut longer = pieces_up_to(sent_every(10_000, 1, std::time::Duration::from_secs(1)), usize::MAX)
            .idle(std::time::Duration::from_secs(120));
        assert_eq!(read_all(&mut longer).await.0, 120);
        let took = started.elapsed().as_millis();
        assert!((120_499..=120_501).contains(&took), "{took} ms");
    }

    /// A body sent at the minimum rate or above, however long it takes, is read whole: here 240
    /// bytes a second for an hour, and 960 KiB in pieces of 16 KiB 59 seconds apart.
    #[tokio::test(start_paused = true)]
    async fn a_body_sent_at_the_rate_is_read_whole_however_long_it_takes() {
        let mut steady = pieces_up_to(sent_every(3600, 240, std::time::Duration::from_secs(1)), usize::MAX);
        assert!(matches!(read_all(&mut steady).await, (864_000, None)));
        let mut far_apart = pieces_up_to(sent_every(60, 16 << 10, std::time::Duration::from_secs(59)), usize::MAX);
        assert!(matches!(read_all(&mut far_apart).await, (983_040, None)));
    }

    /// Bytes that came without a wait earn allowance too: 64 KiB sent at once, then two pauses of
    /// 50 seconds before the last pieces, is read whole (a client that paused after a fast start).
    #[tokio::test(start_paused = true)]
    async fn bytes_that_came_without_a_wait_earn_allowance() {
        let at_once = stream::iter([Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; 64 << 10]))]);
        let paused = stream::iter(0..2).then(|_| async {
            tokio::time::sleep(std::time::Duration::from_secs(50)).await;
            Ok::<_, std::io::Error>(Bytes::from_static(b"x"))
        });
        let body = Body::from_stream(at_once.chain(paused));
        let mut pieces = pieces_up_to(body, usize::MAX);
        assert!(matches!(read_all(&mut pieces).await, (65_538, None)));
    }

    /// A read dropped while it waits (a handler that reads inside a `timeout`) keeps what it
    /// waited: a byte-a-second trickle read that way, read again at once, is still a 408 at
    /// 60.25 s.
    #[tokio::test(start_paused = true)]
    async fn a_read_dropped_while_it_waits_does_not_start_the_wait_again() {
        let started = tokio::time::Instant::now();
        let mut pieces = pieces_up_to(sent_every(10_000, 1, std::time::Duration::from_secs(1)), usize::MAX);
        let mut read = 0;
        let failed = loop {
            match tokio::time::timeout(std::time::Duration::from_millis(900), pieces.chunk()).await {
                Err(_) => continue,
                Ok(Ok(Some(piece))) => read += piece.len(),
                Ok(Ok(None)) => break None,
                Ok(Err(error)) => break Some(error),
            }
        };
        assert!(matches!(failed, Some(BodyError::Stalled)), "{failed:?} after {read} bytes");
        let took = started.elapsed().as_millis();
        assert!((60_249..=60_251).contains(&took), "{took} ms");
    }

    /// A read dropped while it waits counts what it waited, and the handler's time after it does
    /// not: a body sent at 240 bytes a second, read inside a 100 ms `timeout` with ten seconds of
    /// the handler's own work after each one that passes, is read whole.
    #[tokio::test(start_paused = true)]
    async fn the_handlers_time_after_a_dropped_read_is_not_counted() {
        let mut pieces = pieces_up_to(sent_every(30, 240, std::time::Duration::from_secs(1)), usize::MAX);
        let mut read = 0;
        let failed = loop {
            match tokio::time::timeout(std::time::Duration::from_millis(100), pieces.chunk()).await {
                Err(_) => tokio::time::sleep(std::time::Duration::from_secs(10)).await,
                Ok(Ok(Some(piece))) => read += piece.len(),
                Ok(Ok(None)) => break None,
                Ok(Err(error)) => break Some(error),
            }
        };
        assert!(failed.is_none() && read == 7200, "{failed:?} after {read} bytes");
    }

    /// An idle time set after a read waited is the one the next wait keeps to: a body that sends
    /// more than a second's worth at 1 s and then nothing, read with `idle(5 s)` after that, is a
    /// 408 at 6 s.
    #[tokio::test(start_paused = true)]
    async fn an_idle_time_set_after_a_wait_is_kept_to() {
        let started = tokio::time::Instant::now();
        let first = stream::iter([()]).then(|()| async {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; 241]))
        });
        let mut pieces = pieces_up_to(Body::from_stream(first.chain(stream::pending())), usize::MAX);
        assert_eq!(pieces.chunk().await.unwrap().map(|piece| piece.len()), Some(241));
        let mut pieces = pieces.idle(std::time::Duration::from_secs(5));
        assert!(matches!(pieces.chunk().await, Err(BodyError::Stalled)));
        assert_eq!(started.elapsed(), std::time::Duration::from_secs(6));
    }

    /// Reads begun again inside a `timeout` do not start the idle time again: 64 KiB at once and
    /// then nothing, read with a 900 ms `timeout` tried again at once, is a 408 at 60 s, as it is
    /// read plainly, not once those bytes' allowance (273 s more) is spent.
    #[tokio::test(start_paused = true)]
    async fn reads_begun_again_do_not_start_the_idle_time_again() {
        for retried in [false, true] {
            let started = tokio::time::Instant::now();
            let at_once = stream::iter([Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; 64 << 10]))]);
            let mut pieces = pieces_up_to(Body::from_stream(at_once.chain(stream::pending())), usize::MAX);
            assert_eq!(pieces.chunk().await.unwrap().map(|piece| piece.len()), Some(64 << 10));
            let failed = loop {
                if !retried {
                    break pieces.chunk().await.err();
                }
                match tokio::time::timeout(std::time::Duration::from_millis(900), pieces.chunk()).await {
                    Err(_) => continue,
                    Ok(read) => break read.err(),
                }
            };
            assert!(matches!(failed, Some(BodyError::Stalled)), "retried {retried}: {failed:?}");
            let took = started.elapsed().as_millis();
            assert!((59_999..=60_001).contains(&took), "retried {retried}: {took} ms");
        }
    }

    /// Time the handler spends between reads (passing each piece on to a slow store) is not the
    /// client's: a body sent at 480 bytes a second, read with ten seconds between pieces (23 bytes
    /// a second in all), is read whole.
    #[tokio::test(start_paused = true)]
    async fn the_handlers_time_between_reads_is_not_counted() {
        let mut pieces = pieces_up_to(sent_every(200, 240, std::time::Duration::from_millis(500)), usize::MAX);
        let mut read = 0;
        while let Some(piece) = pieces.chunk().await.unwrap() {
            read += piece.len();
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
        assert_eq!(read, 48_000);
    }
}
