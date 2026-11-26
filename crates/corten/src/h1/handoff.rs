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

use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};

use bytes::{Buf, Bytes};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

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
