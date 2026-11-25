//! An HTTP/1.1 server connection of Corten's own, for the requests that have no body, in the
//! place of hyper's (`hyper::server::conn::http1`) on a server whose app asked for it
//! ([`crate::App::own_http1`]). Why it is here, what would make it the default and what would take
//! it out again: `docs/design.md#choice-own-http1`.
//!
//! [`serve`] is one connection: a loop that reads a request's head ([`head`]), calls the
//! connection's service with it, writes the answer, and goes on to the next request. At the first
//! request it does not answer itself (one that may have a body or switch protocols, or an
//! HTTP/1.0 client's that asks to keep the connection) it stops, and the rest of the connection
//! is hyper's ([`handoff`]). Everything around it is unchanged: the
//! service ([`crate::app::Connection`]), the IO it reads and writes ([`crate::watch::Watched`],
//! and so both timeouts and the connection's place under the cap) and shutdown.
//!
//! **When bytes go to the client.** Every answer is written to one buffer (`out`), and the buffer
//! is written to the IO, and the IO flushed,
//! 1. before the connection's task waits for anything: the rest of a head, the handler, the next
//!    piece of an answer's body, or another task's turn ([`TURN`]); and
//! 2. when it holds [`FLUSH_AT`] bytes, before any more is written into it.
//!
//! So a byte is never held while the server is idle, whatever the client sent behind the request
//! (the rest of a pipeline, a stray CRLF, half a head), and the answers to requests that arrived
//! together leave together. Nothing here looks at the bytes the client has sent to decide;
//! hyper's `pipeline_flush` does, which is what makes it unsafe.
//!
//! **What is held in memory.** `out` holds at most [`FLUSH_AT`] bytes, one answer's head and one
//! body piece of [`COPIED`] bytes or less (with its chunk framing) when more is written into it.
//! A larger piece is not copied: it is written from where it is, after `out`, before the next
//! piece is taken from the body, so a stream is read only as fast as its client takes it. What
//! the client sent is read only when the connection needs it (a head) and never while bytes of a
//! head wait to be read, so a client that sends without reading is held back by the socket; the
//! read buffer holds one read ([`Inbox`]): [`READ`] bytes or fewer, or a head of the app's limit.
//!
//! **What a connection that waits for a request holds.** Its two buffers, each as large as its
//! client made it and no larger than a bound: the read buffer begins at [`FIRST`] bytes and
//! grows when a read fills it, and one whose allocation may be more than [`KEPT_READ`] is freed
//! when the connection waits with nothing unread; the buffer of answers begins at [`OUT_FIRST`]
//! and one of more than [`OUT_KEPT`] is freed when the connection waits with nothing unsent.
//!
//! **What it does not do**, each of which hyper does: read a request's body, or answer a request
//! that may switch protocols (both hyper's, with the rest of the connection); send an answer's
//! trailers (they are dropped, and `Trailer` with them); a custom reason phrase
//! (`hyper::ext::ReasonPhrase`).

mod handoff;
pub(crate) mod head;

use std::{
    convert::Infallible,
    future::{poll_fn, Future},
    io,
    pin::{pin, Pin},
    sync::atomic::{AtomicBool, Ordering::Relaxed},
    task::{ready, Context, Poll},
};

use bytes::{Buf, Bytes, BytesMut};
use http::{HeaderMap, Method, Version};
use tokio::io::{AsyncRead, AsyncWrite};

pub(crate) use handoff::Rewound;
use head::{Asked, Coding, Head, Known, Refusal};

use crate::{body::Body, watch::Answered};

/// The room a connection's first read is offered, and the read buffer it begins with: the head
/// of most requests a browser sends fits, and so do forty short requests in a pipeline. A read
/// that fills what it was offered doubles the next.
///
/// Not 2 KB, which is the size the allocator gives a connection's task: a buffer is made before
/// the connection's first byte has come, and one of the task's size shares a page with a task, so
/// it counts as memory in use while it is still empty.
pub(crate) const FIRST: usize = 2560;
/// The room a read is offered once reads have filled less (a pipeline, a long head), as hyper's
/// at first (`INIT_BUFFER_SIZE`): from here up, how much is offered follows the pieces the
/// connection takes what it read in, and comes back down to this.
const READ: usize = 8192;
/// The most room a read is offered, once reads have filled what they were offered and were taken
/// in pieces that large (heads, under a limit the app raised).
const READ_MOST: usize = 256 * 1024;
/// The largest allocation a read buffer has while its connection waits for a request with
/// nothing unread: one that may be larger (it grew for a head near the app's limit) is freed
/// there.
pub(crate) const KEPT_READ: usize = READ;
/// How many bytes of answers are held before they are written, whatever else is ready.
const FLUSH_AT: usize = 16 * 1024;
/// The room the buffer of answers begins with.
pub(crate) const OUT_FIRST: usize = 1024;
/// The most room the buffer of answers has while its connection waits for a request with
/// nothing unsent: a larger one (an answer's head was that long, or the answers to a pipeline
/// were written behind one that filled it) is freed there. A write's worth.
pub(crate) const OUT_KEPT: usize = FLUSH_AT;
/// The largest body piece copied into the buffer of answers; a larger one is written from where
/// it is, with the buffer in one vectored write where the IO has one.
const COPIED: usize = 8 * 1024;
/// How many requests in a row a connection answers without waiting before it lets other tasks
/// run, as hyper's loop (16 turns).
const TURN: u32 = 16;

#[cfg(test)]
std::thread_local! {
    /// The most room an [`Inbox`] of this thread's connections has held, for a test of the bound.
    pub(crate) static HELD: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// The largest future [`serve`] has made on this thread, in bytes.
    pub(crate) static SERVE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// How many times a connection of this thread began to wait for a request with nothing unread
    /// and nothing unsent, and the most room its two buffers had as it did.
    pub(crate) static IDLE: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
}

/// What the client has sent and the connection has not read yet. A read appends to it
/// (`AsyncReadExt::read_buf`, which writes into the buffer's spare room and needs no `unsafe`
/// here), so no byte of it is written twice.
///
/// **What it holds.** One read's worth, and a read is made only when what it holds has no more of
/// what the connection is reading (a head). A read is offered [`FIRST`] bytes at first and about
/// twice as much after each that fills what it was offered (4 KB, 8 KB and so on), and more than
/// [`READ`] only while the client's bytes are taken in pieces that large: at most twice the
/// largest piece taken of the read before, up to [`READ_MOST`]. So a client that sends a pipeline
/// of small requests is read [`READ`] bytes at a time however fast it sends, and what it has sent
/// beyond that waits in the socket.
///
/// **What it keeps.** Its buffer, for as long as the connection lives: the room its client's
/// requests made it take, [`FIRST`] bytes for one that sends short requests one at a time. One
/// whose allocation may be more than [`KEPT_READ`] is freed when the connection waits for a
/// request with nothing unread ([`Inbox::settle`]).
pub(crate) struct Inbox {
    buf: BytesMut,
    /// How much room the next read is offered.
    room: usize,
    /// How many reads in a row filled little of what they were offered.
    small: u8,
    /// The largest piece taken since the last read.
    most: usize,
    /// The buffer's allocation is larger than a waiting connection keeps ([`KEPT_READ`]): it was
    /// made for a long head. (What the buffer says of its room is not enough to tell: it counts
    /// from what has been taken. Every allocation is made here, of a size that is known, and
    /// none is made larger afterwards.)
    grown: bool,
}

impl Inbox {
    pub(crate) fn new() -> Inbox {
        Inbox { buf: BytesMut::new(), room: FIRST, small: 0, most: 0, grown: false }
    }

    /// The connection begins to wait for a request: a buffer that grew is freed if nothing is
    /// unread, and the next read is offered what a connection's first is.
    pub(crate) fn settle(&mut self) {
        if self.grown && self.buf.is_empty() {
            *self = Inbox::new();
        }
    }

    /// How much room the buffer has, counted from what has been taken of it.
    #[cfg(test)]
    pub(crate) fn room(&self) -> usize {
        self.buf.capacity()
    }

    /// Whether the buffer's allocation is larger than `bound`, where nothing else holds a part
    /// of it (the room is then counted from the allocation's start).
    #[cfg(test)]
    pub(crate) fn larger_than(&mut self, bound: usize) -> bool {
        self.buf.try_reclaim(bound + 1) || self.buf.capacity() > bound
    }

    fn data(&self) -> &[u8] {
        &self.buf
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.buf.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// The first `count` bytes, which share the buffer: nothing is copied.
    pub(crate) fn take(&mut self, count: usize) -> Bytes {
        self.most = self.most.max(count);
        self.buf.split_to(count).freeze()
    }

    /// Everything not read, for hyper to read ([`handoff`]).
    fn rest(self) -> Bytes {
        self.buf.freeze()
    }

    /// Reads from `io` once. Room is made when little is left: in the same allocation when
    /// nothing else holds its bytes (a request's headers share them until they are dropped), in
    /// a new one otherwise. `limit`: how long what is unread may be with what is read behind it
    /// (a head, up to the app's limit; `usize::MAX` for a read made while a request is
    /// answered); no room is made for more.
    pub(crate) fn poll_fill<I: AsyncRead + Unpin>(
        &mut self,
        io: &mut I,
        cx: &mut Context<'_>,
        limit: usize,
    ) -> Poll<io::Result<usize>> {
        // The pieces the last read was taken in say how much this one is offered. Nothing taken
        // of it (a head that has not ended) leaves the room as it is.
        if self.most > 0 {
            self.room = self.room.min(self.most.saturating_mul(2).clamp(READ, READ_MOST));
        }
        // Room from when the pieces were larger is given back.
        let roomy = self.buf.capacity() > 4 * self.room.max(self.buf.len());
        if roomy || self.buf.capacity() - self.buf.len() < self.room / 2 {
            // Room for what a read is offered in all, with what is unread at its front (part of
            // a head), and half of that at least behind it: taken back in the allocation where
            // it has that much and nothing else holds a part of it, and otherwise in a new one
            // of just that size. (`BytesMut::reserve` would make it larger: twice the
            // allocation, or the room asked for behind everything taken of it so far.) And for
            // no more than the limit leaves: a head that does not end is read in a buffer that
            // grows to the app's limit for a head and not past it.
            let most = limit.saturating_sub(self.buf.len()).max(1);
            let more = self.room.saturating_sub(self.buf.len()).max(self.room / 2).min(most);
            if roomy || !self.buf.try_reclaim(more) {
                let mut fresh = BytesMut::with_capacity(self.buf.len() + more);
                fresh.extend_from_slice(&self.buf);
                self.grown = fresh.capacity() > KEPT_READ;
                self.buf = fresh;
            }
        }
        #[cfg(test)]
        HELD.set(HELD.get().max(self.buf.capacity()));
        let offered = self.buf.capacity() - self.buf.len();
        let count = {
            let mut read = pin!(tokio::io::AsyncReadExt::read_buf(io, &mut self.buf));
            ready!(read.as_mut().poll(cx))?
        };
        self.most = 0;
        if count == offered {
            // Twice as much, in whole powers of two: 4 KB after the first size, then 8 KB.
            let twice = self.room * 2;
            let twice = if twice.is_power_of_two() { twice } else { twice.next_power_of_two() / 2 };
            self.room = twice.min(READ_MOST);
            self.small = 0;
        } else if count < self.room / 4 && self.room > READ {
            self.small += 1;
            if self.small == 2 {
                self.room = (self.room / 2).max(READ);
                self.small = 0;
            }
        } else {
            self.small = 0;
        }
        Poll::Ready(Ok(count))
    }
}

/// What the bytes a connection has read hold next.
enum Next {
    /// A request this connection answers.
    Head(Head),
    /// Part of a head, or nothing.
    More,
    /// A request that is hyper's, with the rest of the connection. Nothing of it has been taken.
    Hypers,
}

/// One connection's buffers and IO.
struct Conn<I> {
    io: I,
    inbox: Inbox,
    /// How long the head being read was when it was last found unfinished.
    partial: Option<usize>,
    indices: Vec<head::Indices>,
    /// The header map of the last answer, emptied, for the next request.
    cached: Option<HeaderMap>,
    /// [`crate::App::max_request_head`].
    limit: usize,
    /// Answers written and not yet sent; the first `sent` bytes have gone to the IO. Kept from
    /// one answer to the next with the room they made it take, up to [`OUT_KEPT`] (`Conn::rest`).
    out: Vec<u8>,
    sent: usize,
    /// A body piece too large to copy, sent after `out` and followed by `after` (a chunk's end).
    large: Option<Bytes>,
    after: &'static [u8],
    /// How many bytes have gone to the IO in all, to tell whether any of an answer has.
    gone: u64,
    /// Bytes have gone to the IO, or an answer has ended, since its last flush completed.
    unflushed: bool,
    /// The task has waited since the date was last brought up to date.
    waited: bool,
    vectored: bool,
}

impl<I: AsyncRead + AsyncWrite + Unpin> Conn<I> {
    fn new(io: I, limit: usize) -> Conn<I> {
        let vectored = io.is_write_vectored();
        Conn {
            io,
            inbox: Inbox::new(),
            partial: None,
            indices: Vec::new(),
            cached: None,
            limit,
            out: Vec::new(),
            sent: 0,
            large: None,
            after: b"",
            gone: 0,
            unflushed: false,
            waited: true,
            vectored,
        }
    }

    /// What the bytes read so far hold: the next request's head, if all of it has arrived.
    fn parse(&mut self) -> Result<Next, Refusal> {
        let bytes = self.inbox.data();
        if bytes.is_empty() {
            return Ok(Next::More);
        }
        let found = match self.partial {
            Some(had) if !head::may_be_whole(bytes, had) => None,
            _ => head::scan(bytes, self.limit, &mut self.indices)?,
        };
        let Some(scanned) = found else {
            // A head that reaches the limit unfinished is refused without waiting for the rest.
            if bytes.len() >= self.limit {
                return Err(Refusal::TooLarge);
            }
            self.partial = Some(bytes.len());
            return Ok(Next::More);
        };
        self.partial = None;
        // Before anything is taken: hyper is given the bytes as they were read.
        if scanned.hypers {
            return Ok(Next::Hypers);
        }
        let bytes = self.inbox.take(scanned.len);
        Ok(Next::Head(head::build(&bytes, scanned, &self.indices, &mut self.cached)?))
    }

    /// Writes everything written so far to the IO and flushes it. Pending: the IO has no room,
    /// and wakes the task when it has.
    fn poll_send(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        loop {
            let rest = &self.out[self.sent..];
            let wrote = match &self.large {
                None if rest.is_empty() => break,
                None => ready!(Pin::new(&mut self.io).poll_write(cx, rest))?,
                Some(large) if self.vectored => {
                    let parts = [io::IoSlice::new(rest), io::IoSlice::new(large), io::IoSlice::new(self.after)];
                    ready!(Pin::new(&mut self.io).poll_write_vectored(cx, &parts))?
                }
                Some(large) if rest.is_empty() => ready!(Pin::new(&mut self.io).poll_write(cx, large))?,
                Some(_) => ready!(Pin::new(&mut self.io).poll_write(cx, rest))?,
            };
            if wrote == 0 {
                return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
            }
            self.unflushed = true;
            self.gone += wrote as u64;
            let of_out = wrote.min(rest.len());
            self.sent += of_out;
            if self.sent == self.out.len() {
                self.out.clear();
                self.sent = 0;
            }
            let mut wrote = wrote - of_out;
            if let Some(large) = &mut self.large {
                let of_large = wrote.min(large.len());
                large.advance(of_large);
                wrote -= of_large;
                if large.is_empty() {
                    // What follows the piece and was not written with it.
                    self.large = None;
                    self.out.extend_from_slice(&self.after[wrote..]);
                    self.after = b"";
                }
            }
        }
        if self.unflushed {
            ready!(Pin::new(&mut self.io).poll_flush(cx))?;
            self.unflushed = false;
        }
        Poll::Ready(Ok(()))
    }

    async fn send(&mut self) -> io::Result<()> {
        poll_fn(|cx| self.poll_send(cx)).await
    }

    /// Waits for more of a head: what has been written goes out first. `Ok(0)` when the client
    /// has closed its side, or the server is shutting down and the connection is between requests
    /// (`first`: no request has been read yet, so the one arriving is read and answered).
    fn poll_head(&mut self, cx: &mut Context<'_>, closing: &AtomicBool, first: bool) -> Poll<io::Result<usize>> {
        if let Poll::Ready(Err(error)) = self.poll_send(cx) {
            return Poll::Ready(Err(error));
        }
        if closing.load(Relaxed) && (!first || self.inbox.is_empty()) {
            return Poll::Ready(Ok(0));
        }
        // What is unread is part of a head, shorter than the limit (`parse`).
        let read = self.inbox.poll_fill(&mut self.io, cx, self.limit);
        if read.is_pending() {
            self.rest();
        }
        read
    }

    /// The connection waits for a request: a buffer that holds nothing and has more room than a
    /// waiting connection keeps is freed ([`KEPT_READ`], [`OUT_KEPT`]). (While part of a head
    /// waits for the rest, or an answer for its client to take it, that buffer stays.)
    fn rest(&mut self) {
        self.inbox.settle();
        let sent = self.out.is_empty() && self.large.is_none();
        if sent && self.out.capacity() > OUT_KEPT {
            self.out = Vec::new();
        }
        #[cfg(test)]
        if self.inbox.is_empty() && sent {
            let (waits, most) = IDLE.get();
            IDLE.set((waits + 1, most.max(self.inbox.room() + self.out.capacity())));
        }
    }

    /// Room for an answer's head, where the connection has none yet or has freed what it had.
    #[inline]
    fn lend(&mut self) {
        if self.out.capacity() == 0 {
            self.out.reserve(OUT_FIRST);
        }
    }

    /// What the connection does while the handler, or the answer's body, waits: `Err` when the
    /// client is gone, and the request with it.
    fn poll_meanwhile(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        // Everything written so far goes out: the answers before this one, the pieces of a
        // stream.
        if let Poll::Ready(Err(error)) = self.poll_send(cx) {
            return Err(error);
        }
        // A client that closes its side while its request is being answered has left, as with
        // hyper. Seen only while nothing it sent waits to be read: at most one read is taken
        // ahead (a pipelined request), and no more until the connection has used it.
        if self.inbox.is_empty() {
            match self.inbox.poll_fill(&mut self.io, cx, usize::MAX) {
                Poll::Ready(Ok(0)) => return Err(io::ErrorKind::UnexpectedEof.into()),
                Poll::Ready(Err(error)) => return Err(error),
                Poll::Ready(Ok(_)) | Poll::Pending => {}
            }
        }
        Ok(())
    }

    fn poll_answer<F>(&mut self, cx: &mut Context<'_>, answering: Pin<&mut F>) -> Poll<io::Result<http::Response<Answered>>>
    where
        F: Future<Output = Result<http::Response<Answered>, Infallible>>,
    {
        if let Poll::Ready(Ok(answer)) = answering.poll(cx) {
            return Poll::Ready(Ok(answer));
        }
        self.poll_meanwhile(cx)?;
        Poll::Pending
    }

    /// A piece of an answer's body, with what follows it on the wire.
    fn put(&mut self, piece: Bytes, after: &'static [u8]) {
        let copied = if self.vectored { COPIED } else { FLUSH_AT };
        if piece.len() <= copied {
            self.out.extend_from_slice(&piece);
            self.out.extend_from_slice(after);
        } else {
            debug_assert!(self.large.is_none(), "a large piece goes out before the next is written");
            self.large = Some(piece);
            self.after = after;
        }
    }

    /// The end of an answer's body: whether the connection can go on to another request.
    fn end(&mut self, coding: Coding) -> io::Result<bool> {
        match coding {
            Coding::Length(0) => Ok(true),
            Coding::Length(_) => Err(io::Error::other("an answer's body ended before its Content-Length")),
            Coding::Chunked => {
                self.out.extend_from_slice(b"0\r\n\r\n");
                Ok(true)
            }
            Coding::Close => Ok(false),
        }
    }

    /// Writes an answer's body as it comes: whether the connection can go on to another request.
    fn poll_body(&mut self, cx: &mut Context<'_>, body: &mut Answered, coding: &mut Coding) -> Poll<io::Result<bool>> {
        use http_body::Body;
        loop {
            // A piece too large to copy, or enough to fill a write, goes out before the next is
            // taken from the body: a client that reads slowly holds the stream back.
            if self.large.is_some() || self.out.len() - self.sent >= FLUSH_AT {
                ready!(self.poll_send(cx))?;
            }
            let frame = match Pin::new(&mut *body).poll_frame(cx) {
                Poll::Ready(frame) => frame,
                Poll::Pending => {
                    self.poll_meanwhile(cx)?;
                    return Poll::Pending;
                }
            };
            let piece = match frame {
                None => return Poll::Ready(self.end(*coding)),
                Some(Err(_)) => return Poll::Ready(Err(io::Error::other("an answer's body failed"))),
                Some(Ok(frame)) => match frame.into_data() {
                    Ok(piece) => piece,
                    // Trailers, which are not sent: the body ends here.
                    Err(_) => return Poll::Ready(self.end(*coding)),
                },
            };
            let ends = body.is_end_stream();
            if piece.is_empty() {
                if ends {
                    return Poll::Ready(self.end(*coding));
                }
                continue;
            }
            if let Some(goes_on) = self.piece(piece, ends, coding) {
                return Poll::Ready(Ok(goes_on));
            }
        }
    }

    /// Writes a piece of an answer's body, which is not empty, as the answer's coding frames it;
    /// `ends`: it is the body's last. `Some` when the body is written to its end: whether the
    /// connection can go on to another request.
    fn piece(&mut self, mut piece: Bytes, ends: bool, coding: &mut Coding) -> Option<bool> {
        match coding {
            Coding::Length(left) => {
                let length = piece.len() as u64;
                if length >= *left {
                    // All that the head promised; a body that goes on is cut there.
                    piece.truncate(*left as usize);
                    *left = 0;
                    self.put(piece, b"");
                    return Some(true);
                }
                *left -= length;
                self.put(piece, b"");
                // Shorter than its head said: sent, and the connection closes.
                ends.then_some(false)
            }
            Coding::Chunked => {
                head::chunk_size(&mut self.out, piece.len());
                self.put(piece, if ends { b"\r\n0\r\n\r\n" } else { b"\r\n" });
                ends.then_some(true)
            }
            Coding::Close => {
                self.put(piece, b"");
                ends.then_some(false)
            }
        }
    }

    /// Where the next byte written to `out` will be in all that goes to the IO.
    fn mark(&self) -> u64 {
        self.gone + (self.out.len() - self.sent) as u64
    }

    /// Forgets an answer written from `mark` on, if none of it has gone to the IO: `false` if
    /// some has.
    fn unwrite(&mut self, mark: u64) -> bool {
        if self.gone > mark {
            return false;
        }
        self.out.truncate(self.sent + (mark - self.gone) as usize);
        self.large = None;
        self.after = b"";
        true
    }

    /// Sends what is written and closes the IO (over TLS, its last record), each for as long as
    /// the send timeout allows. The connection is over: by reference, so the future of each call
    /// holds no copy of it ([`serve`]'s future has room for every one).
    async fn close(&mut self) {
        if self.send().await.is_ok() {
            let _ = poll_fn(|cx| Pin::new(&mut self.io).poll_shutdown(cx)).await;
        }
    }

    /// Answers a head that is refused, after the answers before it, and closes. A client that
    /// speaks HTTP/2 is not answered, as hyper does not answer it: what is unread, where hyper
    /// looks, begins with what such a client opens its connection with.
    async fn refuse(&mut self, refusal: Refusal) {
        if !head::speaks_h2(self.inbox.data()) {
            head::tick();
            self.lend();
            head::refuse(&mut self.out, refusal.status());
        }
        self.close().await;
    }
}

/// Serves one connection until the client closes it, a request or its answer ends it, an error
/// does, or `closing` is set and the request in progress, if any, has been answered. Setting
/// `closing` wakes nothing: the caller polls again after setting it.
///
/// `Some` when the connection is not over and the next request on it is hyper's: the IO, that
/// request's head with everything behind it, and the service, for the caller to serve with hyper
/// ([`handoff`]). The answers before that request have gone.
///
/// **What the future holds** is held by every connection from when it is accepted, so it is kept
/// small: the connection is made before the future and moved into it once (an `async fn` has
/// room for each argument twice, as it was passed and as it is used), and what a request needs
/// only until its handler is called, or an answer only until its head is written, is in a block
/// that ends before the next wait.
pub(crate) fn serve<'a, I, S>(
    io: I,
    mut service: S,
    head_limit: usize,
    closing: &'a AtomicBool,
) -> impl Future<Output = Option<(I, Bytes, S)>> + 'a
where
    I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    S: tower_service::Service<http::Request<Body>, Response = http::Response<Answered>, Error = Infallible> + 'a,
{
    let mut conn = Conn::new(io, head_limit);
    let serve = async move { serving(&mut conn, &mut service, closing).await.then(|| (conn.io, conn.inbox.rest(), service)) };
    #[cfg(test)]
    SERVE.set(SERVE.get().max(std::mem::size_of_val(&serve)));
    serve
}

/// [`serve`], for a connection where it will stay: `true` when the rest of it is hyper's.
async fn serving<I, S>(conn: &mut Conn<I>, service: &mut S, closing: &AtomicBool) -> bool
where
    I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    S: tower_service::Service<http::Request<Body>, Response = http::Response<Answered>, Error = Infallible>,
{
    let mut first = true;
    // How many requests have been answered since the task last waited.
    let mut turn = 0;
    loop {
        // Asked before a head is read, as hyper asks, and not with the request in hand: what is
        // held across a wait is held by every connection, in this future.
        if poll_fn(|cx| service.poll_ready(cx)).await.is_err() {
            return false;
        }
        let head = loop {
            match conn.parse() {
                Ok(Next::Head(head)) => break head,
                Ok(Next::More) => {}
                // The answers before it go first; then the connection is hyper's.
                Ok(Next::Hypers) => return conn.send().await.is_ok(),
                Err(refusal) => {
                    conn.refuse(refusal).await;
                    return false;
                }
            }
            let read = poll_fn(|cx| {
                let read = conn.poll_head(cx, closing, first);
                conn.waited |= read.is_pending();
                read
            });
            match read.await {
                Ok(count) if count > 0 => {}
                // The client is done, the header timeout has passed, or the server is shutting down.
                _ => {
                    conn.close().await;
                    return false;
                }
            }
        };
        first = false;
        // In a block: the head's parts are read here, and what has been borrowed is held by the
        // future across every wait behind it, to the end of its scope.
        let (request, mut asked) = {
            let Head { parts, keep_alive } = head;
            let asked = Asked { head: parts.method == Method::HEAD, http11: parts.version == Version::HTTP_11, keep_alive };
            (http::Request::from_parts(parts, Body::empty()), asked)
        };
        let answer = {
            let mut answering = pin!(service.call(request));
            let answer = poll_fn(|cx| {
                let answer = conn.poll_answer(cx, answering.as_mut());
                conn.waited |= answer.is_pending();
                answer
            });
            match answer.await {
                Ok(answer) => answer,
                // The client left, or a write failed: the handler is dropped with the connection.
                Err(_) => return false,
            }
        };
        if closing.load(Relaxed) {
            asked.keep_alive = false;
        }
        // The answer's head, written without a wait: its parts are not held across one.
        let (mut body, mark, written) = {
            let (mut parts, body) = answer.into_parts();
            let known = {
                use http_body::Body;
                if body.is_end_stream() {
                    Known::Nothing
                } else {
                    body.size_hint().exact().map_or(Known::Unknown, Known::Exactly)
                }
            };
            if conn.waited {
                head::tick();
                conn.waited = false;
                turn = 0;
            }
            conn.lend();
            let mark = conn.mark();
            let written = head::write(&mut conn.out, parts.status, parts.version, &mut parts.headers, known, asked);
            if written.is_ok() {
                conn.cached = Some(std::mem::take(&mut parts.headers));
            }
            (body, mark, written.ok())
        };
        let Some((mut coding, mut last)) = written else {
            conn.close().await;
            return false;
        };
        if coding != Coding::Length(0) {
            let wrote = poll_fn(|cx| {
                let wrote = conn.poll_body(cx, &mut body, &mut coding);
                conn.waited |= wrote.is_pending();
                wrote
            });
            match wrote.await {
                Ok(goes_on) => last |= !goes_on,
                // The answer cannot be finished. If none of it has gone, the client gets the
                // answers before it and no part of this one, as with hyper; otherwise what it
                // has is cut short.
                Err(_) if conn.unwrite(mark) => {
                    conn.close().await;
                    return false;
                }
                Err(_) => return false,
            }
        }
        // The answer is whole: for the header timeout, the connection is idle from the flush
        // that follows (`Answered`'s drop, then `Watched`'s flush), so one is owed even if the
        // answer's last bytes have gone already.
        drop(body);
        conn.unflushed = true;
        // A piece too large to copy goes out before anything is written behind it, and so does a
        // full buffer: a client that sends requests and reads no answers is not answered further.
        if (conn.large.is_some() || conn.out.len() - conn.sent >= FLUSH_AT) && conn.send().await.is_err() {
            return false;
        }
        if last {
            conn.close().await;
            return false;
        }
        turn += 1;
        if turn == TURN {
            // A client that keeps sending requests does not keep the thread: what is written goes
            // out, and other tasks run.
            if conn.send().await.is_err() {
                return false;
            }
            tokio::task::yield_now().await;
            conn.waited = true;
        }
    }
}
