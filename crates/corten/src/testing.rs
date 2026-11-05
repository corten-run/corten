//! Requests to an app in its tests, without a socket: `app.test()` gives a [`Client`], which
//! sends a request to a typed route through the finished router (the app's layers, middleware and
//! error page included) and gives back the whole answer.
//!
//! ```
//! # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
//! use corten::{http::StatusCode, prelude::*};
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
//! let app = App::new(url::router()).test();
//! let home = app.get(&url::Home).await;
//! assert_eq!((home.status(), home.text()), (StatusCode::OK, "Hello"));
//! let greeting = app.post(&url::Greet).field(GreetForm::FIELDS.name, "Ada").await;
//! assert_eq!(greeting.text(), "Hello, Ada!");
//! # });
//! ```
//!
//! A URL is a route, as in a view, so a test cannot name one the app does not have:
//!
//! ```compile_fail,E0277
//! # async fn f(app: corten::testing::Client) {
//! app.get(&"/greet").await;
//! # }
//! ```
//!
//! A field is named by its `FieldName` and takes a value of its type:
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
//! # struct Place;
//! # async fn f(app: corten::testing::Client) {
//! app.post(&Place).field(Order::FIELDS.quantity, "two").await;
//! # }
//! ```

use std::{
    fmt::{self, Display},
    future::{Future, IntoFuture},
    net::{IpAddr, SocketAddr},
    pin::Pin,
};

use axum::{body::Body, extract::connect_info::ConnectInfo, Router};
use bytes::Bytes;
use http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use tower_service::Service;

use crate::{
    form::{FieldName, Place},
    page::{Mode, MODE_HEADER},
    route::{Href, Route},
};

/// Sends requests to an app in its tests: `app.test()`, or [`Client::from`] a router the test
/// built itself. Cloning it is cheap, and the clones send to the same app (its state, sessions and
/// stores are shared, as a server's requests share them).
#[derive(Clone)]
pub struct Client {
    router: Router,
}

impl From<Router> for Client {
    fn from(router: Router) -> Self {
        Client { router }
    }
}

impl Client {
    /// A `GET` of `url`. Fields added to it go in its query, as a GET form sends them.
    pub fn get<R: Route + Href>(&self, url: &R) -> Call<'_> {
        self.call(Method::GET, url)
    }

    /// A `POST` to `url`. Fields added to it are its body, as a form posts them.
    pub fn post<R: Route + Href>(&self, url: &R) -> Call<'_> {
        self.call(Method::POST, url)
    }

    /// A request of any method to `url` (`HEAD`, `OPTIONS`, `DELETE`).
    pub fn call<R: Route + Href>(&self, method: Method, url: &R) -> Call<'_> {
        let mut uri = String::new();
        url.write_link(&mut uri, false);
        Call { client: self, method, uri, headers: HeaderMap::new(), fields: String::new(), body: None, peer: None }
    }
}

/// One request a [`Client`] is building; `.await` sends it and gives the [`Answer`].
#[must_use = "a call is sent when it is awaited"]
pub struct Call<'c> {
    client: &'c Client,
    method: Method,
    uri: String,
    headers: HeaderMap,
    fields: String,
    body: Option<(HeaderValue, Bytes)>,
    peer: Option<IpAddr>,
}

/// A value a field of type `T` takes: the type's own (`5` for a `FieldName<u32>`,
/// `Condition::Mint` for a `FieldName<Condition>`), or text for a `String` field.
pub trait FieldValue<T> {
    /// The text the field posts, as a browser sends the control's value.
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

impl<'c> Call<'c> {
    /// Asks as the runtime or a data client does: [`Mode::Action`] for a `data-patch` form's
    /// submit, [`Mode::Navigation`] for a link the runtime follows, [`Mode::Data`] for a client
    /// that asks for JSON. Without it the request is a browser's [`Mode::Document`].
    pub fn mode(mut self, mode: Mode) -> Self {
        let (name, value) = match mode {
            Mode::Document => return self,
            Mode::Navigation => (MODE_HEADER, "nav"),
            Mode::Action => (MODE_HEADER, "action"),
            Mode::Data => (header::ACCEPT, "application/json"),
        };
        self.headers.insert(name, HeaderValue::from_static(value));
        self
    }

    /// Adds a field the form sends, named by its [`FieldName`]: to the body of a `POST`, to the
    /// query of a `GET`. A field added again is sent again, as a list's values are.
    pub fn field<T, P: Place>(mut self, name: FieldName<T, P>, value: impl FieldValue<T>) -> Self {
        let mut text = String::new();
        value.write_value(&mut text);
        form_urlencoded::Serializer::for_suffix(&mut self.fields, 0).append_pair(&name.to_string(), &text);
        self
    }

    /// Sends a cookie (`name=value`, as a `Set-Cookie` answer gave it). Several are sent together.
    pub fn cookie(mut self, cookie: &str) -> Self {
        let value = match self.headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) {
            Some(had) => format!("{had}; {cookie}"),
            None => cookie.to_string(),
        };
        self.headers.insert(header::COOKIE, value.parse().expect("a cookie is header text"));
        self
    }

    /// Sends a header as a client would (`accept-language`, `authorization`, `origin`). One added
    /// again is sent twice.
    pub fn header(mut self, name: HeaderName, value: &str) -> Self {
        self.headers.append(name, value.parse().expect("a header value is visible ASCII"));
        self
    }

    /// Sends `body` as it is, with its `Content-Type`: a multipart upload, a JSON-RPC message, a
    /// body a test means to be malformed. Fields added as well go in the query.
    pub fn body(mut self, content_type: &str, body: impl Into<Bytes>) -> Self {
        self.body = Some((content_type.parse().expect("a content type is visible ASCII"), body.into()));
        self
    }

    /// Sends `value`'s JSON as the body (`application/json`).
    #[cfg(feature = "json")]
    pub fn json(self, value: &impl crate::json::ToJson) -> Self {
        let json = value.to_json();
        self.body("application/json", json)
    }

    /// Sends the request from `ip`, as the connection's peer: what [`crate::ClientIp`] reads (and
    /// a limit per client counts) when the app is served. Without it the request has no address.
    pub fn from(mut self, ip: impl Into<IpAddr>) -> Self {
        self.peer = Some(ip.into());
        self
    }

    async fn send(self) -> Answer {
        let Call { client, method, mut uri, mut headers, fields, body, peer } = self;
        let body = match body {
            Some((kind, bytes)) => {
                headers.insert(header::CONTENT_TYPE, kind);
                if !fields.is_empty() {
                    uri.push(if uri.contains('?') { '&' } else { '?' });
                    uri.push_str(&fields);
                }
                Body::from(bytes)
            }
            None if fields.is_empty() => Body::empty(),
            None if method == Method::GET || method == Method::HEAD => {
                uri.push(if uri.contains('?') { '&' } else { '?' });
                uri.push_str(&fields);
                Body::empty()
            }
            None => {
                headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-www-form-urlencoded"));
                Body::from(fields)
            }
        };
        let mut req = Request::builder().method(method).uri(uri).body(body).expect("a route writes a URI");
        *req.headers_mut() = headers;
        if let Some(ip) = peer {
            req.extensions_mut().insert(ConnectInfo(SocketAddr::new(ip, 4000)));
        }
        let mut router = client.router.clone();
        let ready = std::future::poll_fn(|cx| Service::<Request<Body>>::poll_ready(&mut router, cx)).await;
        let Ok(()) = ready;
        let Ok(res) = router.call(req).await;
        let (parts, body) = res.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.expect("the app's answer has an end: a live stream does not");
        Answer(Response::from_parts(parts, bytes))
    }
}

impl<'c> IntoFuture for Call<'c> {
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

    /// One header's value as text: empty when the answer has none.
    pub fn header(&self, name: HeaderName) -> &str {
        self.0.headers().get(name).map_or("", |v| v.to_str().expect("a header the test reads is text"))
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
