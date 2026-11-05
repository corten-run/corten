//! Requests to an app in its tests, without a socket: `app.test()` gives a [`Client`], which
//! sends a request through the finished app (its layers, middleware and error page included) and
//! gives back the whole [`Answer`].
//!
//! ```
//! # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
//! use corten::{http::StatusCode, prelude::*, testing::Client};
//!
//! #[corten::routes]
//! mod url {
//!     #[route("/", get = home)]
//!     pub struct Home;
//!
//!     #[route("/greet", post = greet)]
//!     pub struct Greet;
//! }
//!
//! #[derive(serde::Deserialize, Fields)]
//! struct GreetForm {
//!     name: String,
//! }
//!
//! async fn home() -> &'static str {
//!     "Hello"
//! }
//!
//! async fn greet(Form(form): Form<GreetForm>) -> String {
//!     format!("Hello, {}!", form.name)
//! }
//!
//! let app: Client = App::new(url::router()).test();
//! let home = app.get(&url::Home).await;
//! assert_eq!((home.status(), home.text()), (StatusCode::OK, "Hello"));
//! let greeting = app.post(&url::Greet).field(GreetForm::FIELDS.name, "Ada").await;
//! assert_eq!(greeting.text(), "Hello, Ada!");
//! # });
//! ```
//!
//! What it sends is what a browser would:
//!
//! 1. The address is a route, as in a view, or a [`Local`] path the test read from an answer
//!    ([`Answer::location`], an asset's URL in a page) or names on purpose (an unknown one, for
//!    the error page). Text is not an address.
//! 2. A form's fields are named by their `FieldName`s and take values of their types; a value the
//!    form would refuse is sent through the name made [untyped](crate::FieldName::untyped).
//! 3. A request asks for HTML as a browser's does, unless [`Call::mode`] makes it the runtime's
//!    or a data client's. Every header it sends is one a test chose, or that.
//!
//! ```compile_fail,E0277
//! # async fn f(app: corten::testing::Client) {
//! app.get(&"/greet").await;
//! # }
//! ```
//!
//! ```compile_fail,E0277
//! # use corten::prelude::*;
//! #[derive(serde::Deserialize, Fields)]
//! struct Order {
//!     quantity: u32,
//! }
//!
//! # #[derive(Route)]
//! # #[route("/order")]
//! # struct Orders;
//! # async fn f(app: corten::testing::Client) {
//! app.post(&Orders).field(Order::FIELDS.quantity, "two").await;
//! # }
//! ```
//!
//! A `GET` has no fields: its query is the route's.
//!
//! ```compile_fail,E0599
//! # use corten::prelude::*;
//! # #[derive(serde::Deserialize, Fields)]
//! # struct Search { q: String }
//! # #[derive(Route)]
//! # #[route("/search")]
//! # struct Find;
//! # async fn f(app: corten::testing::Client) {
//! app.get(&Find).field(Search::FIELDS.q, "pika").await;
//! # }
//! ```

use std::{
    fmt::{self, Display},
    future::{Future, IntoFuture},
    marker::PhantomData,
    net::{IpAddr, SocketAddr},
    pin::Pin,
};

use axum::{body::Body, extract::connect_info::ConnectInfo, Router};
use bytes::Bytes;
use http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use tower_service::Service;

use crate::{
    form::{Entry, FieldName, Numeric, Place, SubmitKey, Untyped},
    page::{Mode, MODE_HEADER},
    route::{Href, Local, Route},
};

/// What a browser's `Accept` asks for on a page load.
const BROWSER_ACCEPT: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/// Sends requests to an app in its tests: [`crate::App::test`]. Clones send to the same app, so
/// its state, sessions and stores are shared, as a server's requests share them.
#[derive(Clone)]
pub struct Client {
    router: Router,
}

impl Client {
    pub(crate) fn new(router: Router) -> Self {
        Client { router }
    }

    /// A `GET` of `to`.
    pub fn get(&self, to: &impl Address) -> Call<'_, NoForm> {
        self.start(Method::GET, to)
    }

    /// A `POST` of a form to `to`: its fields are the body, as a browser posts them.
    pub fn post(&self, to: &impl Address) -> Call<'_, FormBody> {
        self.start(Method::POST, to)
    }

    /// A request of any method to `to` that is not a form: `HEAD`, `OPTIONS`, `DELETE`, or a
    /// `POST` of JSON or of a multipart upload ([`Call::body`]).
    pub fn call(&self, method: Method, to: &impl Address) -> Call<'_, NoForm> {
        self.start(method, to)
    }

    fn start<K>(&self, method: Method, to: &impl Address) -> Call<'_, K> {
        let mut uri = String::new();
        to.write_address(&mut uri);
        Call {
            client: self,
            method,
            uri,
            mode: Mode::Document,
            headers: HeaderMap::new(),
            cookies: String::new(),
            body: Sent::Nothing,
            peer: None,
            kind: PhantomData,
        }
    }
}

mod sealed {
    pub trait Sealed {}
}

/// Where a test can send a request: a route, or a [`Local`] path.
pub trait Address: sealed::Sealed {
    #[doc(hidden)]
    fn write_address(&self, out: &mut String);
}

impl<R: Route> sealed::Sealed for R {}
impl<R: Route> Address for R {
    fn write_address(&self, out: &mut String) {
        self.write_link(out, false);
    }
}

impl sealed::Sealed for Local {}
impl Address for Local {
    fn write_address(&self, out: &mut String) {
        out.push_str(self.as_str());
    }
}

/// A [`Call`] that posts a form: it takes [fields](Call::field).
pub enum FormBody {}

/// A [`Call`] that is not a form: it takes a [body](Call::body), or none.
pub enum NoForm {}

enum Sent {
    Nothing,
    Form(String),
    Body(HeaderValue, Bytes),
}

/// One request a [`Client`] is building; `.await` sends it and gives the [`Answer`].
#[must_use = "a call is sent when it is awaited"]
pub struct Call<'c, K> {
    client: &'c Client,
    method: Method,
    uri: String,
    mode: Mode,
    headers: HeaderMap,
    cookies: String,
    body: Sent,
    peer: Option<IpAddr>,
    kind: PhantomData<fn() -> K>,
}

/// A new submit key, as [`SubmitKey::field`] draws into a form: what a test posts in a
/// `SubmitKey` field, and posts again to send the same submission twice (a double click, a retry).
pub fn submit_key() -> SubmitKey {
    SubmitKey::new()
}

/// A value a field of type `T` takes, as its control would send it: the type's own (`5` for a
/// `FieldName<u32>`, `Condition::Mint` for a `FieldName<Condition>`, a [`submit_key`]), text for
/// a `String` field, a number or any text for an [`Entry`] (which reads whatever was typed), and
/// any text for an [untyped](crate::FieldName::untyped) name.
pub trait FieldValue<T> {
    /// The text the field posts.
    fn write_value(&self, out: &mut String);
}

impl<T: Display> FieldValue<T> for T {
    fn write_value(&self, out: &mut String) {
        use fmt::Write;
        let _ = write!(out, "{self}");
    }
}

impl<T: Display> FieldValue<T> for &T {
    fn write_value(&self, out: &mut String) {
        (**self).write_value(out);
    }
}

impl FieldValue<String> for &str {
    fn write_value(&self, out: &mut String) {
        out.push_str(self);
    }
}

impl<T: Numeric + Display> FieldValue<Entry<T>> for T {
    fn write_value(&self, out: &mut String) {
        FieldValue::<T>::write_value(self, out);
    }
}

impl<T: Numeric> FieldValue<Entry<T>> for &str {
    fn write_value(&self, out: &mut String) {
        out.push_str(self);
    }
}

impl FieldValue<Untyped> for &str {
    fn write_value(&self, out: &mut String) {
        out.push_str(self);
    }
}

impl<'c, K> Call<'c, K> {
    /// Asks as the runtime or a data client does: [`Mode::Action`] for a `data-patch` form's
    /// submit, [`Mode::Navigation`] for a link the runtime follows, [`Mode::Data`] for a client
    /// that asks for JSON. Without it (or with [`Mode::Document`]) the request asks for HTML as a
    /// browser's page load does.
    pub fn mode(mut self, mode: Mode) -> Self {
        self.mode = mode;
        self
    }

    /// Sends the cookie `name=value`. Several are sent together, in one `Cookie` header.
    pub fn cookie(mut self, name: &str, value: &str) -> Self {
        if !self.cookies.is_empty() {
            self.cookies.push_str("; ");
        }
        self.cookies.push_str(name);
        self.cookies.push('=');
        self.cookies.push_str(value);
        self
    }

    /// Sends the header `name` with `value`, in place of any it had (`Accept` included):
    /// `accept-language`, `authorization`, `origin`, `sec-fetch-site`. The ones the call
    /// writes itself are set the call's way: `Content-Type` by its fields or [body](Call::body),
    /// `Cookie` by [`Call::cookie`], Corten's `corten` by [`Call::mode`].
    pub fn header(mut self, name: HeaderName, value: &str) -> Self {
        let way = if name == header::CONTENT_TYPE {
            Some("its fields or .body(..)")
        } else if name == header::COOKIE {
            Some(".cookie(name, value)")
        } else if name == MODE_HEADER {
            Some(".mode(..)")
        } else {
            None
        };
        if let Some(way) = way {
            panic!("a test sets {name} with {way}, not .header(..)");
        }
        self.headers.insert(name, value.parse().expect("a header value is visible ASCII"));
        self
    }

    /// Sends the request from `ip`, the connection's peer: what [`crate::ClientIp`] reads (and a
    /// limit per client counts) when the app is served. Without it the request has no address.
    pub fn peer(mut self, ip: impl Into<IpAddr>) -> Self {
        self.peer = Some(ip.into());
        self
    }

    async fn send(self) -> Answer {
        let Call { client, method, uri, mode, mut headers, cookies, body, peer, kind: _ } = self;
        match mode {
            Mode::Document => {
                headers.entry(header::ACCEPT).or_insert(HeaderValue::from_static(BROWSER_ACCEPT));
            }
            Mode::Navigation => {
                headers.insert(MODE_HEADER, HeaderValue::from_static("nav"));
            }
            Mode::Action => {
                headers.insert(MODE_HEADER, HeaderValue::from_static("action"));
            }
            Mode::Data => {
                headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
            }
        }
        if !cookies.is_empty() {
            headers.insert(header::COOKIE, cookies.parse().expect("a cookie is visible ASCII"));
        }
        let body = match body {
            Sent::Nothing => Body::empty(),
            Sent::Form(fields) => {
                headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-www-form-urlencoded"));
                Body::from(fields)
            }
            Sent::Body(kind, bytes) => {
                headers.insert(header::CONTENT_TYPE, kind);
                Body::from(bytes)
            }
        };
        let mut req = Request::builder().method(method).uri(uri).body(body).expect("an address is a URI");
        *req.headers_mut() = headers;
        if let Some(ip) = peer {
            req.extensions_mut().insert(ConnectInfo(SocketAddr::new(ip, 4000)));
        }
        let mut router = client.router.clone();
        let Ok(()) = std::future::poll_fn(|cx| Service::<Request<Body>>::poll_ready(&mut router, cx)).await;
        let Ok(res) = router.call(req).await;
        let streams = res.headers().get(header::CONTENT_TYPE).is_some_and(|kind| kind.as_bytes().starts_with(b"text/event-stream"));
        assert!(!streams, "the answer is a live stream, which has no end to read to: send it with app.router() and read it as it comes");
        let (parts, body) = res.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.expect("the app's answer is read to its end");
        Answer(Response::from_parts(parts, bytes))
    }
}

impl<'c> Call<'c, FormBody> {
    /// Adds a field the form posts, named by its [`FieldName`]. One added again is sent again, as
    /// a list's values are.
    pub fn field<T, P: Place>(mut self, name: FieldName<T, P>, value: impl FieldValue<T>) -> Self {
        let mut text = String::new();
        value.write_value(&mut text);
        let fields = match &mut self.body {
            Sent::Form(fields) => fields,
            body => {
                *body = Sent::Form(String::new());
                let Sent::Form(fields) = body else { unreachable!() };
                fields
            }
        };
        form_urlencoded::Serializer::for_suffix(fields, 0).append_pair(&name.to_string(), &text);
        self
    }
}

impl<'c> Call<'c, NoForm> {
    /// Sends `body` as it is, with its `Content-Type`: a multipart upload, a JSON-RPC message, a
    /// body a test means to be malformed.
    pub fn body(mut self, content_type: &str, body: impl Into<Bytes>) -> Self {
        self.body = Sent::Body(content_type.parse().expect("a content type is visible ASCII"), body.into());
        self
    }

    /// Sends `value`'s JSON as the body (`application/json`).
    #[cfg(feature = "json")]
    pub fn json(self, value: &impl crate::json::ToJson) -> Self {
        self.body("application/json", value.to_json())
    }
}

impl<'c, K: 'c> IntoFuture for Call<'c, K> {
    type Output = Answer;
    type IntoFuture = Pin<Box<dyn Future<Output = Answer> + Send + 'c>>;

    fn into_future(self) -> Self::IntoFuture {
        Box::pin(self.send())
    }
}

/// What the app answered, read to its end.
#[derive(Debug)]
pub struct Answer(Response<Bytes>);

impl Answer {
    /// The status.
    pub fn status(&self) -> StatusCode {
        self.0.status()
    }

    /// The headers.
    pub fn headers(&self) -> &HeaderMap {
        self.0.headers()
    }

    /// The value of the cookie `name` the answer sets (`Set-Cookie`), without its attributes:
    /// what [`Call::cookie`] sends back.
    pub fn cookie(&self, name: &str) -> Option<&str> {
        self.0.headers().get_all(header::SET_COOKIE).iter().find_map(|set| {
            let pair = set.to_str().ok()?.split(';').next()?;
            let (key, value) = pair.split_once('=')?;
            (key.trim() == name).then_some(value.trim())
        })
    }

    /// Where a redirect sends the client, when it is a path on this site: a [`Local`] to send the
    /// next request to.
    pub fn location(&self) -> Option<Local> {
        Local::parse(self.0.headers().get(header::LOCATION)?.to_str().ok()?)
    }

    /// The body as text. Panics on a body that is not UTF-8 (an image, a compressed one): read
    /// [`Answer::bytes`] for it.
    pub fn text(&self) -> &str {
        std::str::from_utf8(self.0.body()).expect("the body is UTF-8 text")
    }

    /// The body as it came.
    pub fn bytes(&self) -> &Bytes {
        self.0.body()
    }

    /// The answer as an `http::Response`.
    pub fn into_response(self) -> Response<Bytes> {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{prelude::*, ClientIp};

    // Only its field names are used: the form a test fills.
    #[derive(serde::Deserialize, crate::Fields)]
    #[allow(dead_code)]
    struct Order {
        item: String,
        #[serde(default)]
        tags: Vec<String>,
        copies: Entry<u32>,
    }

    #[crate::routes]
    mod url {
        #[route("/echo", get = echo, post = echo, delete = echo)]
        pub struct Echo;

        #[route("/ip", get = ip)]
        pub struct Ip;

        #[route("/moved", get = moved)]
        pub struct Moved;
    }

    /// What the request was: its method, query, the headers a test sets, and its body.
    async fn echo(req: axum::extract::Request) -> String {
        let (parts, body) = req.into_parts();
        let body = axum::body::to_bytes(body, 1 << 16).await.unwrap();
        let h = |name: &str| parts.headers.get_all(name).iter().map(|v| v.to_str().unwrap()).collect::<Vec<_>>().join("|");
        format!(
            "{} {} accept={} corten={} cookie={} type={} lang={} body={}",
            parts.method,
            parts.uri,
            h("accept"),
            h("corten"),
            h("cookie"),
            h("content-type"),
            h("accept-language"),
            String::from_utf8(body.to_vec()).unwrap()
        )
    }

    async fn ip(ClientIp(ip): ClientIp) -> String {
        ip.to_string()
    }

    async fn moved(req: Req) -> HtmlResult {
        req.redirect(&url::Echo)
    }

    fn client() -> Client {
        App::new(url::router()).test()
    }

    #[tokio::test]
    async fn a_form_posts_its_fields_as_a_browser_does() {
        let f = Order::FIELDS;
        let echo = client().post(&url::Echo).field(f.item, "Pika & Co").field(f.tags, "a").field(f.tags, "b").field(f.copies, 2).await;
        assert_eq!(
            echo.text(),
            format!(
                "POST /echo accept={BROWSER_ACCEPT} corten= cookie= type=application/x-www-form-urlencoded lang= \
                 body=item=Pika+%26+Co&tags=a&tags=b&copies=2"
            )
        );
        let forged = client().post(&url::Echo).field(f.copies, "two").field(f.item.untyped(), "x").await;
        assert!(forged.text().ends_with("body=copies=two&item=x"), "{}", forged.text());
    }

    #[tokio::test]
    async fn a_mode_cookies_and_headers_are_sent_once_each() {
        let echo = client()
            .get(&url::Echo)
            .mode(Mode::Action)
            .mode(Mode::Navigation)
            .cookie("a", "1")
            .cookie("b", "2")
            .header(http::header::ACCEPT_LANGUAGE, "de")
            .header(http::header::ACCEPT_LANGUAGE, "fr")
            .await;
        assert_eq!(echo.text(), "GET /echo accept= corten=nav cookie=a=1; b=2 type= lang=fr body=");
        let data = client().get(&url::Echo).mode(Mode::Data).await;
        assert!(data.text().contains("accept=application/json corten= "), "{}", data.text());
        let own = client().get(&url::Echo).header(http::header::ACCEPT, "*/*").await;
        assert!(own.text().contains("accept=*/* "), "{}", own.text());
    }

    #[tokio::test]
    async fn a_body_goes_as_it_is_with_its_type() {
        let echo = client().call(Method::DELETE, &url::Echo).body("application/json", r#"{"id":1}"#).await;
        assert!(echo.text().starts_with("DELETE /echo ") && echo.text().ends_with(r#"type=application/json lang= body={"id":1}"#));
    }

    #[test]
    #[should_panic(expected = "a test sets cookie with .cookie(name, value)")]
    fn a_header_the_call_writes_itself_is_refused() {
        let _ = client().get(&url::Echo).header(http::header::COOKIE, "a=1");
    }

    #[tokio::test]
    async fn the_peer_is_the_client_address() {
        assert_eq!(client().get(&url::Ip).peer([203, 0, 113, 7]).await.text(), "203.0.113.7");
        assert_eq!(client().get(&url::Ip).await.status(), 500);
    }

    #[tokio::test]
    async fn a_redirect_is_followed_by_its_location_and_an_unknown_path_is_the_error_page() {
        let app = client();
        let moved = app.get(&url::Moved).await;
        let to = moved.location().unwrap();
        assert!(app.get(&to).await.text().starts_with("GET /echo "));
        let missing = app.get(&Local::parse("/nope").unwrap()).await;
        assert_eq!(missing.status(), 404);
        assert!(missing.text().contains("<html"), "{}", missing.text());
    }

    #[test]
    fn a_cookie_is_read_without_its_attributes() {
        let res = Response::builder()
            .header(header::SET_COOKIE, "theme=dark; Path=/")
            .header(header::SET_COOKIE, "session=abc; Path=/; HttpOnly; Secure")
            .body(Bytes::new())
            .unwrap();
        let answer = Answer(res);
        assert_eq!((answer.cookie("session"), answer.cookie("theme"), answer.cookie("Path")), (Some("abc"), Some("dark"), None));
    }
}
