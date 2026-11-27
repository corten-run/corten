//! Server-sent events as Corten writes them: the `text/event-stream` format of the HTML standard
//! (9.2, Server-sent events), for [`crate::live`] and the development reload stream.
//!
//! An event is its fields, each `name: value` on a line, then a blank line. A stream that has
//! sent nothing for 15 seconds sends a comment (`:`), so a proxy that closes a quiet connection
//! keeps it open.

use std::{
    convert::Infallible,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use bytes::Bytes;
use futures_util::Stream;
use http::{header, HeaderValue};
use http_body::Frame;

use crate::{body::Body, response::Response};

/// How long a stream stays quiet before it sends a comment.
const KEEP_ALIVE: Duration = Duration::from_secs(15);

/// One event, written as its fields are added.
#[must_use]
pub(crate) struct Event(Vec<u8>);

impl Event {
    pub(crate) fn new() -> Self {
        Event(Vec::new())
    }

    /// An event with room for `len` bytes of fields, so one that fits is written without growing.
    pub(crate) fn with_capacity(len: usize) -> Self {
        Event(Vec::with_capacity(len))
    }

    /// The event's type (`event:`), which the client listens for by name.
    pub(crate) fn event(self, name: &str) -> Self {
        self.field("event", name)
    }

    /// The event's id (`id:`), which a client that reconnects sends back as `Last-Event-ID`.
    pub(crate) fn id(self, id: &str) -> Self {
        debug_assert!(!id.contains('\0'), "an event's id holds no NUL");
        self.field("id", id)
    }

    /// How long the client waits before it reconnects (`retry:`, in milliseconds).
    pub(crate) fn retry(mut self, wait: Duration) -> Self {
        self.0.extend_from_slice(format!("retry: {}\n", wait.as_millis()).as_bytes());
        self
    }

    /// The event's data: one `data:` line for each of its lines (a line ends at CRLF, CR or LF, as
    /// the client reads them), which the client joins again with a line feed. Empty data writes no
    /// line, and an event with none is not dispatched.
    pub(crate) fn data(mut self, data: &str) -> Self {
        if data.is_empty() {
            return self;
        }
        let mut lines = data.as_bytes();
        loop {
            let end = memchr::memchr2(b'\r', b'\n', lines).unwrap_or(lines.len());
            self.0.extend_from_slice(b"data: ");
            self.0.extend_from_slice(&lines[..end]);
            self.0.push(b'\n');
            if end == lines.len() {
                break self;
            }
            let next = if lines[end..].starts_with(b"\r\n") { end + 2 } else { end + 1 };
            lines = &lines[next..];
        }
    }

    fn field(mut self, name: &str, value: &str) -> Self {
        debug_assert!(!value.contains(['\r', '\n']), "an event's {name} holds no line break");
        self.0.extend_from_slice(name.as_bytes());
        self.0.extend_from_slice(b": ");
        self.0.extend_from_slice(value.as_bytes());
        self.0.push(b'\n');
        self
    }

    /// The event's bytes, ended by its blank line.
    pub(crate) fn into_bytes(mut self) -> Bytes {
        self.0.push(b'\n');
        Bytes::from(self.0)
    }
}

/// A response that sends `events` as they come, a comment after each 15 seconds without one,
/// and ends when `events` does.
pub(crate) fn response<S>(events: S) -> Response
where
    S: Stream<Item = Event> + Send + 'static,
{
    let body = Events { events, quiet: tokio::time::sleep(KEEP_ALIVE) };
    let mut res = Response::new(Body::new(body));
    let headers = res.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    res
}

pin_project_lite::pin_project! {
    /// The body of an event stream.
    struct Events<S> {
        #[pin]
        events: S,
        #[pin]
        quiet: tokio::time::Sleep,
    }
}

impl<S: Stream<Item = Event>> http_body::Body for Events<S> {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        let mut this = self.project();
        match this.events.poll_next(cx) {
            Poll::Ready(Some(event)) => {
                this.quiet.as_mut().reset(tokio::time::Instant::now() + KEEP_ALIVE);
                Poll::Ready(Some(Ok(Frame::data(event.into_bytes()))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => {
                std::task::ready!(std::future::Future::poll(this.quiet.as_mut(), cx));
                this.quiet.as_mut().reset(tokio::time::Instant::now() + KEEP_ALIVE);
                Poll::Ready(Some(Ok(Frame::data(Bytes::from_static(b":\n\n")))))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_each_field_on_its_line() {
        let event = Event::new().event("patch").id("e-3").data("<p id=\"a\">1</p>").into_bytes();
        assert_eq!(event, "event: patch\nid: e-3\ndata: <p id=\"a\">1</p>\n\n");
        assert_eq!(Event::new().retry(Duration::from_millis(250)).data("b0").into_bytes(), "retry: 250\ndata: b0\n\n");
        assert_eq!(Event::new().retry(Duration::from_millis(1500)).into_bytes(), "retry: 1500\n\n");
    }

    #[test]
    fn data_takes_a_line_for_each_of_its_lines() {
        assert_eq!(Event::new().data("a\nb\r\nc\rd").into_bytes(), "data: a\ndata: b\ndata: c\ndata: d\n\n");
        assert_eq!(Event::new().event("x").data("").into_bytes(), "event: x\n\n");
        assert_eq!(Event::new().data("a\n").into_bytes(), "data: a\ndata: \n\n");
    }

    #[tokio::test(start_paused = true)]
    async fn a_quiet_stream_sends_a_comment() {
        use http_body_util::BodyExt;
        let res = response(futures_util::stream::once(async { Event::new().data("x") }).chain(futures_util::stream::pending()));
        assert_eq!(res.headers()[header::CONTENT_TYPE], "text/event-stream");
        assert_eq!(res.headers()[header::CACHE_CONTROL], "no-cache");
        let mut body = res.into_body();
        let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert_eq!(first, "data: x\n\n");
        let started = tokio::time::Instant::now();
        let next = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert_eq!(next, ":\n\n");
        assert_eq!(started.elapsed(), KEEP_ALIVE);
    }

    use futures_util::StreamExt;
}
