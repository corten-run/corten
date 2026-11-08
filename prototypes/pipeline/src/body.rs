//! The body every request and response has, and [`Failure`]: an answer that says it failed, which
//! the stages around it may describe (the error page, problem+json) or leave as a bare status.

use std::{
    borrow::Cow,
    pin::Pin,
    task::{Context, Poll},
};

use bytes::Bytes;
use http::StatusCode;
use http_body::{Frame, SizeHint};

/// An error a body may end with.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
/// The raw HTTP request: `http`'s, with [`Body`].
pub type Request = http::Request<Body>;
/// The raw HTTP response: `http`'s, with [`Body`].
pub type Response = http::Response<Body>;

/// A request's or a response's body: nothing, bytes held whole, the connection's bytes as they
/// arrive, a stream, or a [`Failure`] still to be described.
pub struct Body(Inner);

enum Inner {
    Empty,
    Full(Bytes),
    Failed(Failure),
    Incoming(hyper::body::Incoming),
    Stream(Pin<Box<dyn http_body::Body<Data = Bytes, Error = BoxError> + Send>>),
}

impl Body {
    /// No bytes.
    pub const fn empty() -> Self {
        Body(Inner::Empty)
    }

    /// Bytes made as they are sent.
    pub fn stream<B>(body: B) -> Self
    where
        B: http_body::Body<Data = Bytes> + Send + 'static,
        B::Error: Into<BoxError>,
    {
        use http_body_util::BodyExt;
        Body(Inner::Stream(Box::pin(body.map_err(Into::into))))
    }

    pub(crate) fn incoming(body: hyper::body::Incoming) -> Self {
        Body(Inner::Incoming(body))
    }

    /// The failure this body stands for, if the answer is one.
    pub fn failure(&self) -> Option<&Failure> {
        match &self.0 {
            Inner::Failed(failure) => Some(failure),
            _ => None,
        }
    }
}

impl Default for Body {
    fn default() -> Self {
        Body::empty()
    }
}

impl From<Bytes> for Body {
    fn from(bytes: Bytes) -> Self {
        Body(Inner::Full(bytes))
    }
}

impl From<&'static [u8]> for Body {
    fn from(bytes: &'static [u8]) -> Self {
        Body(Inner::Full(Bytes::from_static(bytes)))
    }
}

impl From<&'static str> for Body {
    fn from(text: &'static str) -> Self {
        Body(Inner::Full(Bytes::from_static(text.as_bytes())))
    }
}

impl From<String> for Body {
    fn from(text: String) -> Self {
        Body(Inner::Full(Bytes::from(text)))
    }
}

impl From<Vec<u8>> for Body {
    fn from(bytes: Vec<u8>) -> Self {
        Body(Inner::Full(Bytes::from(bytes)))
    }
}

impl http_body::Body for Body {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = self.get_mut();
        match &mut this.0 {
            Inner::Empty | Inner::Failed(_) => Poll::Ready(None),
            Inner::Full(bytes) => {
                let bytes = std::mem::take(bytes);
                this.0 = Inner::Empty;
                Poll::Ready((!bytes.is_empty()).then(|| Ok(Frame::data(bytes))))
            }
            Inner::Incoming(body) => Pin::new(body).poll_frame(cx).map_err(Into::into),
            Inner::Stream(body) => body.as_mut().poll_frame(cx),
        }
    }

    fn is_end_stream(&self) -> bool {
        match &self.0 {
            Inner::Empty | Inner::Failed(_) => true,
            Inner::Full(bytes) => bytes.is_empty(),
            Inner::Incoming(body) => body.is_end_stream(),
            Inner::Stream(body) => body.is_end_stream(),
        }
    }

    fn size_hint(&self) -> SizeHint {
        match &self.0 {
            Inner::Empty | Inner::Failed(_) => SizeHint::with_exact(0),
            Inner::Full(bytes) => SizeHint::with_exact(bytes.len() as u64),
            Inner::Incoming(body) => body.size_hint(),
            Inner::Stream(body) => body.size_hint(),
        }
    }
}

/// An answer that failed, with its status and what went wrong. A stage that describes failures
/// ([`crate::stages::Errors`]) turns it into the app's page or problem+json; without one the
/// client gets the status with no body, and the detail goes nowhere.
#[derive(Clone, Debug)]
pub struct Failure {
    status: StatusCode,
    detail: Option<Cow<'static, str>>,
}

impl Failure {
    /// A failure with `status`, which should be a 4xx or 5xx.
    pub const fn new(status: StatusCode) -> Self {
        Failure { status, detail: None }
    }

    /// 404.
    pub const fn not_found() -> Self {
        Failure::new(StatusCode::NOT_FOUND)
    }

    /// What went wrong, for the log and a developer's error page; never shown in production.
    pub fn detail(mut self, detail: impl Into<Cow<'static, str>>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn detail_text(&self) -> Option<&str> {
        self.detail.as_deref()
    }

    /// The answer that stands for it.
    pub fn into_response(self) -> Response {
        let status = self.status;
        let mut res = Response::new(Body(Inner::Failed(self)));
        *res.status_mut() = status;
        res
    }
}
