//! A connection is hyper's from the first request this one does not answer itself: one whose head
//! has a `Content-Length`, a `Transfer-Encoding`, an `Expect` or an `Upgrade` line, a `CONNECT`,
//! or an HTTP/1.0 request that asks to keep its connection ([`super::head`]). This connection
//! sends the answers to the requests before it, then gives back
//! its IO with everything it read and did not answer, that request's head first ([`Rewound`]), and
//! the caller serves the rest of the connection with hyper, which reads that request itself.
//!
//! So a request's body is read by hyper alone, with every rule it has for one, and an app that
//! switches protocols sees one thing whichever connection read the requests before: hyper's
//! `OnUpgrade` in the request's extensions, and hyper's `Upgraded` once the `101` (or a tunnel's
//! `2xx`) has gone. hyper has no public way to make either, so a connection of Corten's own could
//! only hand over types of its own, and every place that takes hyper's would need a second arm.
//!
//! Nothing is taken from the read buffer before the head is known to be this connection's to
//! answer, so the bytes hyper is given are the ones the client sent, in the allocation they were
//! read into: no byte is copied, dropped or made.

//!
//! **Types of its own.** hyper's connection here is not the one a server without
//! [`crate::App::own_http1`] runs, though it is the same code: its IO, its service, the future
//! that service gives and the body of its answers are each a type only this module's connections
//! have ([`Apart`], [`Handed`]). The compiler makes one copy of a generic function for each set
//! of types it is used with, and inlines a function into its one caller where it would not into
//! two. Sharing the types gave the functions on hyper's path a second caller each, and a request
//! to a server that never turns this on cost more instructions for it
//! (`docs/design.md#choice-own-http1` has the count). With these, that server's path is compiled
//! as it is without this module in the program.

use std::{
    convert::Infallible,
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
};

use bytes::{Buf, Bytes};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::{body::Body, watch::Answered};

/// A future or an IO as a type of its own, which passes every call on: what Corten's own
/// connection reads, writes and polls is `Apart`, so nothing generic over it is the function
/// hyper's connection runs on a server without [`crate::App::own_http1`] (the module's text).
pub(crate) struct Apart<T>(pub T);

impl<F: Future + Unpin> Future for Apart<F> {
    type Output = F::Output;

    #[inline]
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
        Pin::new(&mut self.get_mut().0).poll(cx)
    }
}

impl<I: AsyncRead + Unpin> AsyncRead for Apart<I> {
    #[inline]
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for Apart<I> {
    #[inline]
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().0).poll_write(cx, buf)
    }

    #[inline]
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    #[inline]
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }

    #[inline]
    fn poll_write_vectored(self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().0).poll_write_vectored(cx, bufs)
    }

    #[inline]
    fn is_write_vectored(&self) -> bool {
        self.0.is_write_vectored()
    }
}

/// The connection's service as hyper calls it once the connection is hyper's: the service
/// Corten's own connection called, given the request hyper read with the body hyper reads for
/// it, as `corten::app::Connection` is given one on a server without [`crate::App::own_http1`].
/// Its answer's body gives its bytes as [`HandedData`], so hyper's writer too is this
/// connection's own copy (the module's text).
pub(crate) struct Handed<S>(pub S);

impl<S> hyper::service::Service<hyper::Request<hyper::body::Incoming>> for Handed<S>
where
    S: tower_service::Service<http::Request<Body>, Response = http::Response<Answered>, Error = Infallible> + Clone,
    S::Future: Unpin,
{
    type Response = http::Response<HandedBody>;
    type Error = Infallible;
    type Future = HandedAnswer<S::Future>;

    fn call(&self, req: hyper::Request<hyper::body::Incoming>) -> Self::Future {
        let req = req.map(crate::extract::arriving);
        // Called without `poll_ready`: the router's is ready at once, always
        // (`docs/design.md#choice-axum-router`), and a connection's service only passes it on.
        HandedAnswer(self.0.clone().call(req))
    }
}

/// [`Handed`]'s future: the service's, with the answer's body as a [`HandedBody`].
pub(crate) struct HandedAnswer<F>(F);

impl<F: Future<Output = Result<http::Response<Answered>, Infallible>> + Unpin> Future for HandedAnswer<F> {
    type Output = Result<http::Response<HandedBody>, Infallible>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.get_mut().0).poll(cx).map(|answer| answer.map(|answer| answer.map(HandedBody)))
    }
}

/// An answer's body on a connection handed to hyper: [`Answered`], each piece a [`HandedData`].
pub(crate) struct HandedBody(Answered);

impl http_body::Body for HandedBody {
    type Data = HandedData;
    type Error = crate::body::BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<HandedData>, crate::body::BoxError>>> {
        Pin::new(&mut self.get_mut().0)
            .poll_frame(cx)
            .map(|frame| frame.map(|frame| frame.map(|frame| frame.map_data(HandedData))))
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.0.size_hint()
    }
}

/// A piece of a [`HandedBody`]: the `Bytes` it is, under a type of its own.
pub(crate) struct HandedData(Bytes);

impl Buf for HandedData {
    #[inline]
    fn remaining(&self) -> usize {
        self.0.remaining()
    }

    #[inline]
    fn chunk(&self) -> &[u8] {
        self.0.chunk()
    }

    #[inline]
    fn advance(&mut self, cnt: usize) {
        self.0.advance(cnt);
    }

    #[inline]
    fn copy_to_bytes(&mut self, len: usize) -> Bytes {
        self.0.copy_to_bytes(len)
    }
}

/// An IO with bytes already read from it put back in front: they are read first, then the IO.
///
/// The read that takes the last of them goes on to the IO for the room it has left, so hyper's
/// first read holds what one read of its own would have: what this connection had read and what
/// waited in the socket behind it. That matters for one thing. hyper keeps a connection whose
/// handler left a body unread only if one more read finishes that body, so where a read ends
/// decides whether the requests behind are answered, and this connection's reads end sooner than
/// hyper's (a head is read no further than the app's limit).
pub(crate) struct Rewound<I> {
    read: Bytes,
    io: I,
    /// An error the IO gave a read that had bytes to give already: the next read's.
    failed: Option<io::Error>,
}

impl<I> Rewound<I> {
    pub fn new(io: I, read: Bytes) -> Rewound<I> {
        Rewound { read, io, failed: None }
    }
}

impl<I: AsyncRead + Unpin> AsyncRead for Rewound<I> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if let Some(error) = this.failed.take() {
            return Poll::Ready(Err(error));
        }
        if !this.read.is_empty() {
            let take = this.read.len().min(buf.remaining());
            buf.put_slice(&this.read[..take]);
            this.read.advance(take);
            if this.read.is_empty() {
                // The allocation is freed here, not when the connection ends.
                this.read = Bytes::new();
                if buf.remaining() > 0 {
                    // What the IO has now, behind them. Nothing there yet leaves the task to be
                    // woken for a read it has no need of, which costs a poll; the client's end
                    // is met again by the next read, and an error is kept for it.
                    if let Poll::Ready(Err(error)) = Pin::new(&mut this.io).poll_read(cx, buf) {
                        this.failed = Some(error);
                    }
                }
            }
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.io).poll_read(cx, buf)
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for Rewound<I> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().io).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_shutdown(cx)
    }

    fn poll_write_vectored(self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().io).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }
}
