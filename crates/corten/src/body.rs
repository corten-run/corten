//! [`Body`]: the bytes of a request or a response, as they arrive or are sent.

use std::{
    borrow::Cow,
    fmt,
    pin::Pin,
    task::{Context, Poll},
};

use bytes::Bytes;
use futures_util::{Stream, TryStream};
use http_body::{Frame, SizeHint};

/// Why a body could not be read or sent: the connection broke, or the stream it came from failed.
pub(crate) type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// A body as it is sent or read: a request's, which a handler that takes the whole request reads
/// ([`crate::extract::bytes_up_to`]), a response's, which a middleware's
/// [`crate::middleware::Response`] holds, and what a [`crate::Relay`] passes on from another
/// server (`Body::from_stream(..)`). An empty body holds nothing; any other is boxed once.
///
/// It is two words, as a `Response<Body>` is moved through every stage: a wider body takes the
/// response past the size a move is copied inline at, and each move becomes a call.
pub struct Body(Option<Pin<Box<dyn Piece>>>);

/// A boxed body, which can hand over the bytes it holds whole without reading them.
trait Piece: http_body::Body<Data = Bytes, Error = BoxError> + Send + 'static {
    /// The rest of the body, when it is held whole.
    fn whole(self: Pin<&mut Self>) -> Option<Bytes> {
        None
    }
}

/// The whole body, sent as one piece.
struct Whole(Bytes);

impl http_body::Body for Whole {
    type Data = Bytes;
    type Error = BoxError;

    #[inline]
    fn poll_frame(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let bytes = &mut self.get_mut().0;
        Poll::Ready((!bytes.is_empty()).then(|| Ok(Frame::data(std::mem::take(bytes)))))
    }

    #[inline]
    fn is_end_stream(&self) -> bool {
        self.0.is_empty()
    }

    #[inline]
    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.0.len() as u64)
    }
}

impl Piece for Whole {
    fn whole(self: Pin<&mut Self>) -> Option<Bytes> {
        Some(std::mem::take(&mut self.get_mut().0))
    }
}

impl Body {
    /// A body read from `body`, as it comes.
    pub fn new<B>(body: B) -> Self
    where
        B: http_body::Body<Data = Bytes> + Send + 'static,
        B::Error: Into<BoxError>,
    {
        // A body already a `Body` is not boxed again.
        let mut body = Some(body);
        if let Some(own) = (&mut body as &mut dyn std::any::Any).downcast_mut::<Option<Body>>() {
            return own.take().expect("taken once");
        }
        Body(Some(Box::pin(Boxing { body: body.expect("taken once") })))
    }

    /// A body with nothing in it.
    pub const fn empty() -> Self {
        Body(None)
    }

    /// A body sent as `stream` gives each piece; an error ends it, and the connection with it.
    pub fn from_stream<S>(stream: S) -> Self
    where
        S: TryStream + Send + 'static,
        S::Ok: Into<Bytes>,
        S::Error: Into<BoxError>,
    {
        Body(Some(Box::pin(Streamed { stream })))
    }

    /// The body's pieces as a stream (its trailers, if any, are skipped).
    pub fn into_data_stream(self) -> BodyDataStream {
        BodyDataStream(self)
    }
}

impl Default for Body {
    fn default() -> Self {
        Body::empty()
    }
}

impl fmt::Debug for Body {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            None => f.write_str("Body(empty)"),
            Some(_) => f.write_str("Body(..)"),
        }
    }
}

impl From<()> for Body {
    fn from(_: ()) -> Self {
        Body::empty()
    }
}

macro_rules! whole {
    ($($ty:ty),*) => {$(
        impl From<$ty> for Body {
            fn from(bytes: $ty) -> Self {
                let bytes = Bytes::from(bytes);
                if bytes.is_empty() { Body::empty() } else { Body(Some(Box::pin(Whole(bytes)))) }
            }
        }
    )*};
}
whole!(Bytes, Vec<u8>, &'static [u8], String, &'static str, Box<[u8]>);

impl From<Box<str>> for Body {
    fn from(text: Box<str>) -> Self {
        Body::from(String::from(text))
    }
}

impl From<Cow<'static, str>> for Body {
    fn from(text: Cow<'static, str>) -> Self {
        match text {
            Cow::Borrowed(text) => Body::from(text),
            Cow::Owned(text) => Body::from(text),
        }
    }
}

impl From<Cow<'static, [u8]>> for Body {
    fn from(bytes: Cow<'static, [u8]>) -> Self {
        match bytes {
            Cow::Borrowed(bytes) => Body::from(bytes),
            Cow::Owned(bytes) => Body::from(bytes),
        }
    }
}

impl http_body::Body for Body {
    type Data = Bytes;
    type Error = BoxError;

    #[inline]
    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        match &mut self.get_mut().0 {
            None => Poll::Ready(None),
            Some(body) => body.as_mut().poll_frame(cx),
        }
    }

    #[inline]
    fn is_end_stream(&self) -> bool {
        self.0.as_ref().is_none_or(|body| body.is_end_stream())
    }

    #[inline]
    fn size_hint(&self) -> SizeHint {
        self.0.as_ref().map_or_else(|| SizeHint::with_exact(0), |body| body.size_hint())
    }
}

pin_project_lite::pin_project! {
    /// A body of another type, its error boxed.
    struct Boxing<B> {
        #[pin]
        body: B,
    }
}

impl<B> http_body::Body for Boxing<B>
where
    B: http_body::Body<Data = Bytes>,
    B::Error: Into<BoxError>,
{
    type Data = Bytes;
    type Error = BoxError;

    #[inline]
    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        self.project().body.poll_frame(cx).map(|frame| frame.map(|frame| frame.map_err(Into::into)))
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

impl<B> Piece for Boxing<B>
where
    B: http_body::Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
}

pin_project_lite::pin_project! {
    /// A body made of a stream's pieces.
    struct Streamed<S> {
        #[pin]
        stream: S,
    }
}

impl<S> http_body::Body for Streamed<S>
where
    S: TryStream,
    S::Ok: Into<Bytes>,
    S::Error: Into<BoxError>,
{
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        self.project()
            .stream
            .try_poll_next(cx)
            .map(|piece| piece.map(|piece| piece.map(|piece| Frame::data(piece.into())).map_err(Into::into)))
    }
}

impl<S> Piece for Streamed<S>
where
    S: TryStream + Send + 'static,
    S::Ok: Into<Bytes>,
    S::Error: Into<BoxError>,
{
}

/// A [`Body`]'s pieces as a stream: [`Body::into_data_stream`].
pub struct BodyDataStream(Body);

impl fmt::Debug for BodyDataStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("BodyDataStream").field(&self.0).finish()
    }
}

impl Stream for BodyDataStream {
    type Item = Result<Bytes, BoxError>;

    #[inline]
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            match std::task::ready!(http_body::Body::poll_frame(Pin::new(&mut self.0), cx)) {
                Some(Ok(frame)) => match frame.into_data() {
                    Ok(data) => return Poll::Ready(Some(Ok(data))),
                    // A trailer: not part of the data.
                    Err(_) => continue,
                },
                Some(Err(error)) => return Poll::Ready(Some(Err(error))),
                None => return Poll::Ready(None),
            }
        }
    }
}

/// The whole of `body`, for Corten's own reads of a body it made or holds to a limit it chose:
/// `Err` when it is over `max` bytes or could not be read.
pub(crate) async fn to_bytes(body: Body, max: usize) -> Result<Bytes, BoxError> {
    use futures_util::StreamExt;
    let Some(mut inner) = body.0 else { return Ok(Bytes::new()) };
    if let Some(bytes) = inner.as_mut().whole() {
        return if bytes.len() > max { Err("length limit exceeded".into()) } else { Ok(bytes) };
    }
    let mut pieces = Body(Some(inner)).into_data_stream();
    let mut out: Vec<u8> = Vec::new();
    let mut only: Option<Bytes> = None;
    while let Some(piece) = pieces.next().await {
        let piece = piece?;
        let len = out.len() + only.as_ref().map_or(0, Bytes::len) + piece.len();
        if len > max {
            return Err("length limit exceeded".into());
        }
        match only.take() {
            None if out.is_empty() => only = Some(piece),
            None => out.extend_from_slice(&piece),
            Some(first) => {
                out.reserve(first.len() + piece.len());
                out.extend_from_slice(&first);
                out.extend_from_slice(&piece);
            }
        }
    }
    Ok(only.unwrap_or_else(|| Bytes::from(out)))
}
