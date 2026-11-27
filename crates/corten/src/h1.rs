//! An HTTP/1.1 server connection of Corten's own, in the place of hyper's
//! (`hyper::server::conn::http1`) on a server whose app asked for it
//! ([`crate::App::own_http1`]). Why it is here, what would make it the default and what would take
//! it out again: `docs/design.md#choice-own-http1`.
//!
//! [`serve`] is one connection: a loop that reads a request's head ([`head`]), calls the
//! connection's service with it, reads the request's body as the app asks for it ([`body`]),
//! writes the answer, and goes on to the next request. At the first request it does not answer
//! itself (one that may switch protocols, a `CONNECT`, or an HTTP/1.0 client's that asks to keep
//! the connection) it stops, and the rest of the connection is hyper's ([`handoff`]). Everything
//! around it is unchanged: the service ([`crate::app::Connection`]), the IO it reads and writes
//! ([`crate::watch::Watched`], and so both timeouts and the connection's place under the cap)
//! and shutdown.
//!
//! **A request's body.** Where it ends is said by its head, read as hyper's server reads one
//! ([`head::Framing`]), and found in the bytes by [`body::Decoder`]. The app is given what
//! hyper gives it: a body that answers `size_hint` and `is_end_stream` as hyper's does, gives
//! the same pieces, trailers and errors, and marks a read that waits for the client for the
//! request's deadline ([`crate::extract::Arriving`]). The connection reads the socket for a body
//! only when the app has asked for a piece and has none ([`Conn::poll_feed`]): from the handler,
//! from the answer's body (an echo), or from a task that outlived both, in which case the next
//! request is read only when that body has ended. A client that waits to be told to send
//! (`Expect: 100-continue`) is told when the app first asks, and never once any of the answer
//! is written. A body the app dropped unfinished is read past only as far as [`PASSED`] bytes
//! and two pieces that had arrived ([`Conn::pass`], hyper's rule); otherwise the connection
//! ends with that request's answer. A body that is not framed as its head said, or whose client
//! closed its side before its end, fails the app's read, and the connection ends with that
//! answer, since where the next request would begin is not known.
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
//! So the handlers of requests a client has sent run before the answers ahead of them have
//! gone, until [`FLUSH_AT`] bytes of answers are written and not taken, where hyper, which
//! flushes each answer before it reads the next head, runs one handler beyond what the socket
//! takes. [`TURN`] does not bound them: its count begins again whenever the task has waited,
//! for a handler or for a head, so it holds them to 16 only where every request had been read
//! and no handler waited.
//!
//! **What is held in memory.** Of what has not gone to the client, `out` holds less than
//! [`FLUSH_AT`] bytes when more is written into it, and so at most that, one answer's head and
//! one body piece small enough to copy with its chunk framing ([`COPIED`] bytes, or [`FLUSH_AT`]
//! where the IO takes one buffer a write). In front of that it holds less than [`FLUSH_AT`]
//! bytes that have gone already: they are dropped from it when all of it has gone, and when that
//! many have, so a client that always leaves a little unsent does not make it hold what it was
//! sent before. A larger piece is not copied: it is written from where it is, after `out`,
//! before anything is written behind it. The body is asked for the piece after it first, once,
//! and that piece is held (not copied) until the one before has gone, so a stream is read one
//! piece ahead of what its client has taken, and a body that fails before any of its answer had
//! to go leaves no part of it with the client. What the client sent is read only when the
//! connection needs it (a head, or a piece of a body the app has asked for) and never while
//! bytes it has read wait to be taken, so a client
//! that sends without reading is held back by the socket; the read buffer holds one read
//! ([`Inbox`]): [`READ`] bytes or fewer, a head of the app's limit, or, while the app takes a
//! body in pieces that large, up to [`READ_MOST`]. A head's bytes are its
//! request's while it is answered (its header values share them), and a look for the client's
//! end behind a head that filled the buffer is given another, of [`READ`] bytes at the most:
//! so while a request without a body is answered a connection holds no more of what its client
//! sent than the app's limit and a read.
//!
//! Of a request's body the connection holds one read and nothing more of its own: a piece is
//! the read's own bytes, shared and not copied, and is the app's from when it is given, one
//! piece at the most given and not taken. So a body its handler does not read costs the server
//! what came with the head, a part of one read, however much the client sends; and a body the
//! handler reads costs one read at a time, of [`READ`] bytes unless the reads fill and the app
//! takes what they bring whole, when a read is offered twice the last piece and [`READ_MOST`]
//! at the most. A chunk's size line and extensions are counted and dropped as they are read
//! ([`body::EXTENSIONS`] bytes of extensions in a body, then it fails), so a body of one-byte
//! chunks, or of extensions alone, holds a read as any other does. Trailers are kept until the
//! body's end, in a buffer of their own that holds no more than the app's limit on a head and
//! 100 lines; what the app is given of them is a header map made from that.
//!
//! **When an answer cannot be finished.** A body that fails, or panics, before any byte of its
//! answer has gone ends the connection without that answer: the answers before it are sent, and
//! the connection is closed. That is every body that fails before the connection had to wait
//! for it or for its client: one that fails at once, or behind pieces that fit the buffer, or
//! behind one piece too large to copy. A body that fails later has an answer that is cut short:
//! the client has its head and some of its body, no end of it, and a closed connection. hyper
//! draws the line further on (it holds up to 16 pieces, or about 400 KB, before it must write),
//! so an answer hyper would not have begun can be cut short here when its body gives more than
//! this connection holds and then fails without ever having waited.
//!
//! A body's panic is caught where the body is asked for a piece (`poll_frame`), which is where a
//! stream, or a body of the app's own, runs its code. One that panics where it is asked how long
//! it is or whether it has ended (`size_hint`, `is_end_stream`), or as it is dropped, ends the
//! connection's task, as it ends hyper's, and the answers before it that had not been sent go
//! with it here. Those two questions are answered by code of the app's only for a body type of
//! its own (an `http_body::Body` given to `Body::new`).
//!
//! **A client that closes its side** while a request of its is being answered has left, and the
//! request with it, as with hyper, which reads to find that out each time its task is woken with
//! an answer unfinished and nothing of the client's unread. Here it is looked for when a head
//! has been read with nothing behind it (before the handler is asked), while the handler or the
//! body waits, each time the task is polled for a body after it has waited (before the body is
//! asked for more, so a piece that is ready by then is not written), and where a write waits
//! for the client to read, an answer being unfinished until all of it has gone, shutdown or
//! none. The answers before that one are the client's and are sent, for as long as the send
//! timeout lets a write wait; of that one nothing more is written.
//!
//! What no look makes the same is how much each connection has written by the time it can
//! learn of the end. Where nothing waits (the body gives every piece at once and the client
//! takes every write) each goes on writing until its task next yields, and the two yield after
//! different amounts: of an answer neither finishes, either may have sent more.
//!
//! **What a connection that waits for a request holds.** Its two buffers, each as large as its
//! client made it and no larger than a bound: the read buffer begins at [`FIRST`] bytes and
//! grows when a read fills it, and one whose allocation may be more than [`KEPT_READ`] is freed
//! when the connection waits with nothing unread; the buffer of answers begins at [`OUT_FIRST`]
//! and one of more than [`OUT_KEPT`] is freed when the connection waits with nothing unsent.
//! Beside them, the places of the last head's lines (32 bytes a line, and room for more than
//! [`LINES_KEPT`] lines is freed there too) and the header map of the last answer, emptied, with
//! the room that answer's headers made it take.
//!
//! **What it does not do**, each of which hyper does: answer a request that may switch
//! protocols or a `CONNECT` (hyper's, with the rest of the connection); send an answer's
//! trailers (they are dropped, and `Trailer` with them); a custom reason phrase
//! (`hyper::ext::ReasonPhrase`).

pub(crate) mod body;
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

use body::{Asks, Broken, Decoder, Feed, Step};
pub(crate) use handoff::{Apart, Handed, Rewound};
use head::{Asked, Coding, Framing, Head, Known, Refusal, Said};

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
pub(crate) const FLUSH_AT: usize = 16 * 1024;
/// The room the buffer of answers begins with.
pub(crate) const OUT_FIRST: usize = 1024;
/// The most room the buffer of answers has while its connection waits for a request with
/// nothing unsent: a larger one (an answer's head was that long, or the answers to a pipeline
/// were written behind one that filled it) is freed there. A write's worth.
pub(crate) const OUT_KEPT: usize = FLUSH_AT;
/// How many header lines a connection that waits for a request keeps room to note the places of
/// (32 bytes a line): more room, which a request with more lines made it take, is freed there.
pub(crate) const LINES_KEPT: usize = 64;
/// The largest body piece copied into the buffer of answers; a larger one is written from where
/// it is, with the buffer in one vectored write where the IO has one.
const COPIED: usize = 8 * 1024;
/// How many requests in a row a connection answers without waiting before it lets other tasks
/// run, as hyper's loop (16 turns). Not a bound on the handlers that run ahead of a client that
/// does not read: the count begins again when the task has waited, and what bounds those is
/// [`FLUSH_AT`] bytes of answers unsent.
const TURN: u32 = 16;

#[cfg(test)]
std::thread_local! {
    /// The most room an [`Inbox`] of this thread's connections has held, for a test of the bound.
    pub(crate) static HELD: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// The most room a read buffer of this thread had that was made for a look, which had none.
    pub(crate) static LOOKED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// The largest future [`serve`] has made on this thread, in bytes.
    pub(crate) static SERVE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// How many times a connection of this thread began to wait for a request with nothing unread
    /// and nothing unsent, the most room its two buffers had as it did, and the most header lines
    /// it had room to note the places of.
    pub(crate) static IDLE: std::cell::Cell<(usize, usize, usize)> = const { std::cell::Cell::new((0, 0, 0)) };
    /// How many times a read buffer of this thread was moved to a new allocation with bytes in
    /// it, and how many bytes were copied in all, for a test of the bound.
    pub(crate) static MOVED: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
    /// The most bytes the buffer of answers of a connection of this thread has held as a send
    /// began, and the most room it had, for a test of the bound.
    pub(crate) static OUT: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
    /// How many requests with a body the connections of this thread have read the body of.
    pub(crate) static BODIES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// How many bodies their app dropped unfinished the connections of this thread have read
    /// past or given up ([`Conn::pass`]), and how many times a piece that a read of the
    /// connection's had cut was taken for one with what followed.
    pub(crate) static PASSES: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
}

/// What the client has sent and the connection has not read yet. A read appends to it
/// (`AsyncReadExt::read_buf`, which writes into the buffer's spare room and needs no `unsafe`
/// here), so no byte of it is written twice.
///
/// **What it holds.** One read's worth, and a read is made only when what it holds has no more of
/// what the connection is reading (a head, or a body its app has asked for a piece of). A read is
/// offered [`FIRST`] bytes at first and about
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
    /// The buffer's allocation is larger than a waiting connection keeps ([`KEPT_READ`]), or one
    /// was since the connection last waited: it was made for a long head. (What the buffer says
    /// of its room is not enough to tell: it counts from what has been taken. Every allocation
    /// is made here, of a size that is known, and none is made larger afterwards; the one a
    /// look is given is no larger than the bound, and leaves this as it was, so the connection
    /// begins again from its first size when it next waits.)
    grown: bool,
    /// The last read filled what it was offered: more of what the client sent with those bytes
    /// may wait in the socket.
    filled: bool,
}

impl Inbox {
    pub(crate) fn new() -> Inbox {
        Inbox { buf: BytesMut::new(), room: FIRST, small: 0, most: 0, grown: false, filled: false }
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

    pub(crate) fn len(&self) -> usize {
        self.buf.len()
    }

    /// One that has read `bytes`, for a test of what reads from it.
    #[cfg(test)]
    pub(crate) fn holding(bytes: &[u8]) -> Inbox {
        let mut inbox = Inbox::new();
        inbox.buf.extend_from_slice(bytes);
        inbox
    }

    /// Drops the first `count` bytes: a body's framing, which no one is given. For how much the
    /// next read is offered it is a piece of the smallest size, so a body that is all framing
    /// (extensions, trailers) is read [`READ`] bytes at a time.
    pub(crate) fn skip(&mut self, count: usize) {
        self.most = self.most.max(count.min(1));
        self.buf.advance(count);
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
    /// (a head, up to the app's limit); no room is made for more.
    ///
    /// Inlined always: into the read for a head, as it was when that was its one caller, and
    /// into the read for a body ([`Conn::fill`]), which is a function apart.
    #[inline(always)]
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
            // a head), and behind that half a read's worth at least and half as much again as is
            // unread: taken back in the allocation where it has that much and nothing else holds
            // a part of it, and otherwise in a new one of just that size. So the room made
            // grows with what is held, and a head that comes in small reads is moved to a new
            // allocation only when it has grown by half since the last: about three times its
            // length is copied in all, however many reads bring it (its first bytes at every
            // move, its last at none). (`BytesMut::reserve`
            // would make the allocation larger: twice what it was, or the room asked for behind
            // everything taken of it so far.) And for no more than the limit leaves: a head
            // that does not end is read in a buffer that grows to the app's limit for a head
            // and not past it.
            let most = limit.saturating_sub(self.buf.len()).max(1);
            let more = self.room.saturating_sub(self.buf.len()).max(self.room / 2 + self.buf.len() / 2).min(most);
            if roomy || !self.buf.try_reclaim(more) {
                let mut fresh = BytesMut::with_capacity(self.buf.len() + more);
                fresh.extend_from_slice(&self.buf);
                #[cfg(test)]
                if !self.buf.is_empty() {
                    MOVED.set((MOVED.get().0 + 1, MOVED.get().1 + self.buf.len()));
                }
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
        self.filled = count == offered;
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

    /// Reads from `io` once into the room the buffer has, to learn whether the client has closed
    /// its side ([`Conn::poll_left`]): `Ok(0)` when it has. No room is made where there is any (a
    /// byte tells), so a look, which each request has, moves nothing and allocates nothing: the
    /// request it is made for still holds the bytes of its head, and room could only be made
    /// beside them. What a look does read (a request sent behind this one) is read again from,
    /// with room made, when the connection comes to it.
    ///
    /// Where there is none (what was read filled the buffer, and all of it has been taken: a
    /// head exactly as long as the app's limit, or a pipeline that ended where a read did) the
    /// look is given a new buffer of what a read is offered, and a read's worth at the most
    /// ([`READ`]), whatever the reads before it were offered: it is made beside the last
    /// request's bytes, which that request holds while it is answered, so it is not sized by
    /// them. Nothing is unread when a look is made, so nothing is copied.
    pub(crate) fn poll_look<I: AsyncRead + Unpin>(&mut self, io: &mut I, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        if self.buf.capacity() == self.buf.len() {
            self.room_for_a_look();
        }
        let offered = self.buf.capacity() - self.buf.len();
        let count = {
            let mut read = pin!(tokio::io::AsyncReadExt::read_buf(io, &mut self.buf));
            ready!(read.as_mut().poll(cx))?
        };
        self.filled = count == offered;
        Poll::Ready(Ok(count))
    }

    /// A new buffer for a look that has no room ([`Inbox::poll_look`]). Out of line, and never
    /// inlined: a look that has room, which is nearly every one, pays a comparison for it and
    /// nothing of what making room takes.
    #[cold]
    #[inline(never)]
    fn room_for_a_look(&mut self) {
        let mut fresh = BytesMut::with_capacity(self.buf.len() + self.room.min(READ));
        fresh.extend_from_slice(&self.buf);
        self.buf = fresh;
        #[cfg(test)]
        {
            HELD.set(HELD.get().max(self.buf.capacity()));
            LOOKED.set(LOOKED.get().max(self.buf.capacity()));
        }
    }
}

/// Why the bytes a connection has read hold a whole head and no request for it to answer.
enum Instead {
    /// The head is refused.
    Refused(Refusal),
    /// The request is hyper's, with the rest of the connection. Nothing of it has been taken.
    Hypers,
}

impl From<Refusal> for Instead {
    fn from(refusal: Refusal) -> Instead {
        Instead::Refused(refusal)
    }
}

/// One connection's buffers and IO.
struct Conn<I> {
    io: I,
    inbox: Inbox,
    /// How long the head being read was when it was last found unfinished.
    partial: Option<usize>,
    /// The read that brought the last of those bytes filled what it was offered and no read has
    /// waited since, so the bytes the next read brings came with them ([`Conn::parse`]).
    together: bool,
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
    /// Where the last answer written begins in all that goes to the IO ([`Conn::mark`]).
    begun: u64,
    /// Bytes have gone to the IO, or an answer has ended, since its last flush completed.
    unflushed: bool,
    /// The last send waited for the IO to take more ([`Conn::poll_send`]).
    stalled: bool,
    /// The client has closed its side, with a request of its being answered or an answer to it
    /// waiting to be sent ([`Conn::poll_left`], [`Conn::poll_head`]).
    left: bool,
    /// The task has waited since the last answer's head was written: the date is brought up to
    /// date before the next is, and a body asked for more is asked after a look for its
    /// client's end ([`Conn::poll_body`]).
    waited: bool,
    vectored: bool,
    /// The connection's end of the body of the request being answered, until the body has been
    /// read to its end, has failed, or has been dropped by the app and read past or given up
    /// ([`Conn::poll_feed`]). While it is here, what is unread is the body's, and no head is read.
    feed: Option<Feed>,
    /// The request being answered is the connection's last: its body could not be read to its
    /// end, or was left unread with more of it to come than is read past ([`Conn::pass`]).
    ends: bool,
    /// And its answer says so (`connection: close`), if its head is not written yet: the body was
    /// left unread. (One that failed as the app read it closes the connection without a word, as
    /// with hyper, which stops reading there and does not note that it will close.)
    unkept: bool,
}

/// What a client that waits to be told to send its body is told (`Expect: 100-continue`), as
/// hyper writes it.
const GO_ON: &[u8] = b"HTTP/1.1 100 Continue\r\n\r\n";
/// How many bytes of a body its app dropped are read past, at the most, to keep the connection
/// ([`Conn::pass`]): as many as hyper's first two reads hold (8 KiB, then 16 KiB), which is what
/// hyper reads past for a request sent whole on a new connection.
const PASSED: usize = 8_192 + 16_384;

/// What [`Conn::poll_feed`] did for the request's body.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fed {
    /// Nothing this task has to act on.
    Nothing,
    /// The app's end, in this task, was given what it waited for, and is to be polled again.
    Again,
    /// The app had dropped the body, and the body ended in the piece hyper reads ahead of the
    /// app. hyper has known the body's end since it read that piece, and has looked for the
    /// client's end from then on; this connection, which read nothing ahead, learns of both
    /// only now, and the caller that is about to write looks first ([`Conn::poll_body`]).
    EndedAhead,
}

impl<I: AsyncRead + AsyncWrite + Unpin> Conn<I> {
    fn new(io: I, limit: usize) -> Conn<I> {
        let vectored = io.is_write_vectored();
        Conn {
            feed: None,
            ends: false,
            unkept: false,
            io,
            inbox: Inbox::new(),
            partial: None,
            together: false,
            indices: Vec::new(),
            cached: None,
            limit,
            out: Vec::new(),
            sent: 0,
            large: None,
            after: b"",
            gone: 0,
            begun: 0,
            unflushed: false,
            stalled: false,
            left: false,
            waited: true,
            vectored,
        }
    }

    /// What the bytes read so far hold: the next request's head, if all of it has arrived and
    /// the request is this connection's to answer; `None` while more of it is to come.
    fn parse(&mut self) -> Result<Option<Head>, Instead> {
        let bytes = self.inbox.data();
        if bytes.is_empty() {
            return Ok(None);
        }
        let found = match self.partial {
            // A head found unfinished is looked through again when its end may have come, as
            // hyper looks (`is_complete_fast`), so one sent a few bytes at a time is not parsed
            // for each piece.
            Some(had) if head::may_be_whole(bytes, had) => head::scan(bytes, self.limit, &mut self.indices)?,
            // And once more without its end where hyper would have had these bytes in the read
            // that brought the ones before them: its first read is of `READ` bytes and this
            // connection's of `FIRST`, and what is wrong in a head is refused when a parse sees
            // it, whether the head ends or not. So as far as hyper's first read reaches, bytes
            // that came together (the read before these filled what it was offered, and these
            // were there without a wait) are parsed together: a wrong line in the first `READ`
            // bytes of a head that came at once is refused here as there. A head of that length
            // that is right is parsed once more than its end alone would have it parsed only if
            // it is longer than two reads.
            Some(had) if self.together && had < READ => {
                head::scan(&bytes[..bytes.len().min(READ)], self.limit, &mut self.indices)?
            }
            Some(_) => None,
            None => head::scan(bytes, self.limit, &mut self.indices)?,
        };
        let Some(scanned) = found else {
            // A head that reaches the limit unfinished is refused without waiting for the rest.
            if bytes.len() >= self.limit {
                return Err(Refusal::TooLarge.into());
            }
            self.partial = Some(bytes.len());
            self.together = self.inbox.filled;
            return Ok(None);
        };
        self.partial = None;
        // Before anything is taken: hyper is given the bytes as they were read.
        if scanned.hypers {
            return Err(Instead::Hypers);
        }
        let bytes = self.inbox.take(scanned.len);
        let mut said = Said::NOTHING;
        let head = head::build(&bytes, scanned, &self.indices, &mut self.cached, &mut said)?;
        // The body's reader is made here, where the head is read, and found by the request's
        // answerer in `feed`: a head is then moved as it was before bodies were read.
        if said.framing != Framing::None {
            self.body(said);
        }
        Ok(Some(head))
    }

    /// Writes everything written so far to the IO and flushes it. Pending: the IO has no room,
    /// and wakes the task when it has; `stalled` says so until a send has not had to wait.
    #[inline]
    fn poll_send(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let sent = self.poll_out(cx);
        self.stalled = sent.is_pending();
        sent
    }

    /// [`Conn::poll_send`], but for `stalled`.
    fn poll_out(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        #[cfg(test)]
        OUT.set((OUT.get().0.max(self.out.len()), OUT.get().1.max(self.out.capacity())));
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
            } else if self.sent >= FLUSH_AT {
                // What has gone is not kept in front of what has not: a client that takes its
                // answers slowly enough that some are always unsent would otherwise have the
                // buffer hold every byte sent since it was last empty. Once a write's worth has
                // gone, so each byte is moved at most once for a write's worth sent. (`mark` and
                // `unwrite` count from `sent`, and stay as they are.)
                self.out.drain(..self.sent);
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
    ///
    /// Where the send before this one waited, the read comes first, and a client found to have
    /// closed its side with nothing of its unread has left (`left`) and is written no more: hyper
    /// reads before it writes each time its task is woken, takes an answer for unfinished until
    /// all of it is flushed, and gives up a client that closes its side before then.
    fn poll_head(&mut self, cx: &mut Context<'_>, closing: &AtomicBool, first: bool) -> Poll<io::Result<usize>> {
        let waited = self.stalled;
        if !waited {
            if let Poll::Ready(Err(error)) = self.poll_send(cx) {
                return Poll::Ready(Err(error));
            }
        }
        if closing.load(Relaxed) && (!first || self.inbox.is_empty()) {
            return Poll::Ready(Ok(0));
        }
        // What is unread is part of a head, shorter than the limit (`parse`).
        let read = self.inbox.poll_fill(&mut self.io, cx, self.limit);
        if self.stalled && self.inbox.is_empty() && matches!(read, Poll::Ready(Ok(0))) {
            self.left = true;
            return read;
        }
        if waited {
            if let Poll::Ready(Err(error)) = self.poll_send(cx) {
                return Poll::Ready(Err(error));
            }
        }
        if read.is_pending() {
            // What comes after a wait did not come with what was read before it (`parse`).
            self.together = false;
            self.rest();
        }
        read
    }

    /// The connection waits for a request: what holds nothing and has more room than a waiting
    /// connection keeps is freed ([`KEPT_READ`], [`OUT_KEPT`], [`LINES_KEPT`]). (While part of a
    /// head waits for the rest, or an answer for its client to take it, that buffer stays.)
    fn rest(&mut self) {
        self.inbox.settle();
        if self.indices.capacity() > LINES_KEPT {
            self.indices = Vec::new();
        }
        let sent = self.out.is_empty() && self.large.is_none();
        if sent && self.out.capacity() > OUT_KEPT {
            self.out = Vec::new();
        }
        #[cfg(test)]
        if self.inbox.is_empty() && sent {
            let (waits, most, lines) = IDLE.get();
            IDLE.set((waits + 1, most.max(self.inbox.room() + self.out.capacity()), lines.max(self.indices.capacity())));
        }
    }

    /// Room for an answer's head, where the connection has none yet or has freed what it had.
    #[inline]
    fn lend(&mut self) {
        if self.out.capacity() == 0 {
            self.out.reserve(OUT_FIRST);
        }
    }

    /// Whether the client has closed its side: `Err` when it has (and `left` says so from then
    /// on), or the IO has failed. A client that closes its side while a request of its is being
    /// answered has left, and the request with it, as with hyper. Looked for only while nothing
    /// it sent waits to be read: at most one read is taken ahead (a pipelined request), and no
    /// more until the connection has used it. And not while the request's body is unfinished:
    /// what is read then is the body, read when the app asks for it, and a client that has
    /// closed its side is a body that fails ([`Conn::feed`]), as with hyper. Nor once a body
    /// could not be read to its end (`ends`): nothing more is read of that client, by hyper
    /// either, which so never learns that it left, and its request is answered.
    fn poll_left(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self.inbox.is_empty() && self.feed.is_none() && !self.ends {
            match self.inbox.poll_look(&mut self.io, cx) {
                Poll::Ready(Ok(0)) => {
                    self.left = true;
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
                Poll::Ready(Err(error)) => return Err(error),
                Poll::Ready(Ok(_)) | Poll::Pending => {}
            }
        }
        Ok(())
    }

    /// Begins the body of a request whose head frames one: the connection's end of it (`feed`),
    /// with nothing of it read or given yet. Made where the head is read, so that a head is
    /// what it was before bodies were read, and the connection holds nothing more for a
    /// request that has no body; the request's answerer finds it there ([`Conn::request`]).
    #[cold]
    #[inline(never)]
    fn body(&mut self, said: Said) {
        let decoder = match said.framing {
            Framing::None => return,
            Framing::Length(length) => Decoder::length(length),
            Framing::Chunked => Decoder::chunked(self.limit),
        };
        #[cfg(test)]
        BODIES.set(BODIES.get() + 1);
        self.feed = Some(Feed::new(decoder, said.expects));
    }

    /// The request whose head is `parts`, with the body [`Conn::body`] began, as the app is
    /// given it: what hyper's `Incoming` is on its connection, wrapped as that is so that a read
    /// of it that waits for the client is marked for the deadline
    /// ([`crate::extract::Arriving`]). What has been read of it already (it came with the head)
    /// is the app's at once, a piece that needs no read; not for a client that waits to be told
    /// to send it, which is told when the app asks.
    ///
    /// Apart from the path of a request that has no body, which is made where it was before
    /// bodies were read ([`serving`]).
    #[cold]
    #[inline(never)]
    fn request(&mut self, parts: http::request::Parts) -> http::Request<Body> {
        let body = match &self.feed {
            Some(feed) => {
                let (coming, expects) = feed.coming();
                if !expects {
                    self.feed(None);
                }
                Body::new(crate::extract::Arriving(coming))
            }
            None => Body::empty(),
        };
        http::Request::from_parts(parts, body)
    }

    /// One read for a body. Apart from the read for a head, and never inlined: a head's read is
    /// then [`Inbox::poll_fill`]'s one other caller, compiled into it as it was when it was the
    /// only one, so a request without a body does not pay a call for it.
    #[inline(never)]
    fn fill(inbox: &mut Inbox, io: &mut I, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        inbox.poll_fill(io, cx, usize::MAX)
    }

    /// Gives the app the next piece of its request's body, or the body's end: from what has been
    /// read, and where that holds no more of the body, from the IO, a read at a time (`cx`;
    /// without one nothing is read). A body that is not framed as its head said, and one whose
    /// client closed its side before its end, fails there: the app's read of it does, and the
    /// connection ends with this request's answer, since where the next request begins is not
    /// known. `true` when the one that waited for what was given is this task, which polls what
    /// it holds of the app's again.
    fn feed(&mut self, mut cx: Option<&mut Context<'_>>) -> bool {
        loop {
            let Some(feed) = &self.feed else { return false };
            let (again, over) = {
                let mut reading = feed.reading();
                match reading.decoder.step(&mut self.inbox) {
                    Step::Piece(piece) => {
                        let whole = reading.decoder.given();
                        reading.cut = reading.decoder.partway() && self.inbox.filled;
                        (feed.give(piece, whole, cx.as_deref_mut()), whole)
                    }
                    Step::End(trailers) => (feed.end(trailers, cx.as_deref_mut()), true),
                    Step::Wrong => {
                        self.ends = true;
                        (feed.fail(Broken::Reading, cx.as_deref_mut()), true)
                    }
                    Step::More => {
                        let Some(cx) = cx.as_deref_mut() else { return false };
                        // Nothing is unread here: all that was read was the body's, and is taken.
                        match Self::fill(&mut self.inbox, &mut self.io, cx) {
                            Poll::Pending => return false,
                            Poll::Ready(Ok(count)) if count > 0 => continue,
                            Poll::Ready(_) => {
                                self.ends = true;
                                (feed.fail(Broken::Reading, Some(cx)), true)
                            }
                        }
                    }
                }
            };
            if over {
                self.feed = None;
            }
            return again;
        }
    }

    /// Does for the request's body what the app has asked of it since this was last called, and
    /// has the task woken when it asks again from another ([`Fed`]).
    ///
    /// **The app asked for a piece and has none**: one is read ([`Conn::feed`]). A client that
    /// waits to be told to send the body is told first, once, and only if no byte of the answer
    /// has been written (`tells`), as hyper tells it.
    ///
    /// **The app dropped the body unfinished**: hyper's rule ([`Conn::pass`]).
    ///
    /// Anything else (the app has a piece it has not taken, or has not asked) reads nothing.
    fn poll_feed(&mut self, cx: &mut Context<'_>, tells: bool) -> Fed {
        let Some(feed) = &self.feed else { return Fed::Nothing };
        match feed.looks(cx) {
            Asks::Ready | Asks::Empty { wanted: false } => Fed::Nothing,
            Asks::Empty { wanted: true } => {
                if std::mem::take(&mut feed.reading().expects) && tells {
                    self.lend();
                    self.out.extend_from_slice(GO_ON);
                }
                if self.feed(Some(cx)) {
                    Fed::Again
                } else {
                    Fed::Nothing
                }
            }
            Asks::Dropped { ready, took } => {
                // What hyper has taken of the body by now that this connection has not: it reads
                // a piece ahead of the app when it runs, unless the client waits to be told, and
                // one more when it finds the body dropped. Here nothing was read ahead, so both
                // are read now, but for a piece the app was given and did not take (which was
                // read ahead) and one it took since this task last ran (behind which hyper has
                // not run, and so has read nothing).
                let pieces = if ready || took || feed.reading().expects { 1 } else { 2 };
                if self.pass(cx, pieces) {
                    Fed::EndedAhead
                } else {
                    Fed::Nothing
                }
            }
        }
    }

    /// A body the app dropped before its end: read past, if that takes no waiting, no more than
    /// `pieces` pieces of it and no more than [`PASSED`] bytes; otherwise the connection ends
    /// with this request's answer, which says so if its head is not written yet, and the rest of
    /// the body is not read. hyper's rule (`poll_drain_or_close_read`), which bounds what a
    /// client can make the server read for a request the app has answered already.
    ///
    /// A piece is what had arrived of the body, to the body's end or its chunk's; the line that
    /// ends a chunked body, with its trailers, is a piece of its own. Where a read of this
    /// connection's ended inside a chunk with more of it in the socket (`cut`), what follows to
    /// the chunk's end is the same piece: hyper, whose reads are longer, would have had it in
    /// one. hyper's pieces end where its own reads do too, which this does not follow: the
    /// bound in bytes is in their place.
    ///
    /// A body found wrong, or cut short by its client's end, in the piece hyper would have read
    /// ahead of the app (the first of two) ends the connection without a word in the answer:
    /// hyper stops reading there and notes nothing.
    ///
    /// `true` when the body ended in that piece: hyper knew the body's end before the app
    /// dropped the body ([`Fed::EndedAhead`]).
    #[cold]
    #[inline(never)]
    fn pass(&mut self, cx: &mut Context<'_>, mut pieces: u8) -> bool {
        let Some(feed) = self.feed.take() else { return false };
        let mut reading = feed.reading();
        let ahead = pieces == 2;
        let (mut rest, mut passed, mut quiet) = (reading.cut, 0, false);
        #[cfg(test)]
        PASSES.set((PASSES.get().0 + 1, PASSES.get().1 + usize::from(rest)));
        let ended = loop {
            let had = self.inbox.len();
            let step = reading.decoder.step(&mut self.inbox);
            passed += had - self.inbox.len();
            match step {
                Step::Piece(_) if reading.decoder.given() => break true,
                Step::Piece(_) => {
                    if !rest {
                        pieces -= 1;
                    }
                    rest = reading.decoder.partway() && self.inbox.filled;
                    #[cfg(test)]
                    PASSES.set((PASSES.get().0, PASSES.get().1 + usize::from(rest)));
                    if (pieces == 0 && !rest) || passed > PASSED {
                        break false;
                    }
                }
                Step::End(_) => break true,
                Step::Wrong => {
                    quiet = ahead && pieces == 2;
                    break false;
                }
                Step::More if passed >= PASSED => break false,
                Step::More => match Self::fill(&mut self.inbox, &mut self.io, cx) {
                    Poll::Ready(Ok(count)) if count > 0 => {}
                    Poll::Ready(_) => {
                        quiet = ahead && pieces == 2;
                        break false;
                    }
                    Poll::Pending => break false,
                },
            }
        };
        drop(reading);
        if !ended || passed > PASSED {
            self.ends = true;
            self.unkept = !quiet;
            return false;
        }
        ahead && pieces == 2
    }

    /// Behind an answer whose request's body is unfinished: the answer goes out, and the body is
    /// read for whoever holds it (a task that outlived the handler), as it asks, to the body's
    /// end. Only then is the next request read: until then what the client sends is this
    /// request's. `Err` when the answer cannot be sent.
    fn poll_behind(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.poll_feed(cx, false) == Fed::Again {
            // Nothing of the app's is polled by this task here; whoever was given a piece is.
            cx.waker().wake_by_ref();
        }
        if self.feed.is_none() {
            return Poll::Ready(Ok(()));
        }
        if let Poll::Ready(Err(error)) = self.poll_send(cx) {
            return Poll::Ready(Err(error));
        }
        Poll::Pending
    }

    /// What the connection does while an answer's body waits: `Err` when the client is gone, and
    /// the request with it. The client's end is looked for before anything more is written, as
    /// hyper reads before it writes. For [`Conn::poll_body`] alone, which has looked already in
    /// this poll of the task where the task has waited (`waited`, which nothing changes while
    /// the body is polled): then nothing is looked for here.
    fn poll_meanwhile(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if !self.waited {
            self.poll_left(cx)?;
        }
        // Everything written so far goes out: the answers before this one, the pieces of a
        // stream.
        if let Poll::Ready(Err(error)) = self.poll_send(cx) {
            return Err(error);
        }
        Ok(())
    }

    /// Sends everything written so far, for a caller that waits until it has gone
    /// ([`Conn::poll_send`]), and looks for the client's end while it waits: `Err` when the
    /// client has closed its side, as when the IO fails. hyper looks each time its task is woken
    /// while a request is being answered, which an answer is until all of it is flushed, and
    /// before it writes any more; so here, once a send has waited, and from then on before the
    /// next. A send that does not wait looks for nothing: it is as it was. `looked`: the caller
    /// has looked since the task was last polled, and nothing is looked for here.
    fn poll_deliver(&mut self, cx: &mut Context<'_>, looked: bool) -> Poll<io::Result<()>> {
        let waited = self.stalled;
        if waited && !looked {
            self.poll_left(cx)?;
        }
        let sent = self.poll_send(cx);
        if sent.is_pending() && !waited && !looked {
            self.poll_left(cx)?;
        }
        sent
    }

    /// [`Conn::poll_deliver`] to its end: `false` when what is written cannot be sent, and the
    /// connection is over. If that is because the client has left, the answers before the last
    /// are its all the same: where none of the last has gone they are sent, without it, and the
    /// connection closed. Where some of it has gone, the ones before it have, and it is cut short
    /// there, as hyper drops what it has not written of an answer it gives up.
    async fn deliver(&mut self) -> bool {
        let sent = poll_fn(|cx| {
            let sent = self.poll_deliver(cx, false);
            self.waited |= sent.is_pending();
            sent
        });
        if sent.await.is_ok() {
            return true;
        }
        if self.left && self.unwrite() {
            self.close().await;
        }
        false
    }

    /// The handler's answer. The client's end is looked for first, each time, and so before the
    /// handler is polled at all: hyper looks when it has read a head, and so a request whose
    /// client had closed its side by then is not answered by either, however quick its handler.
    /// (A request read with others behind it is not looked for: its client's end is behind
    /// them.) The answers before it are the client's all the same, and go out first.
    ///
    /// What a look finds is what the IO knows by then. Over a socket just accepted that can be
    /// less than has arrived: tokio takes an accepted socket for readable before its first event
    /// has come, so the first read can take a request with nothing yet said of the client's end
    /// behind it, and then the request is answered, by hyper's connection as by this one, which
    /// each learn of the end when their task next waits.
    ///
    /// A handler that waits for its request's body is given the next piece of it and polled
    /// again ([`Conn::poll_feed`]), [`TURN`] times at the most before other tasks run.
    fn poll_answer<F>(&mut self, cx: &mut Context<'_>, mut answering: Pin<&mut F>) -> Poll<io::Result<http::Response<Answered>>>
    where
        F: Future<Output = Result<http::Response<Answered>, Infallible>>,
    {
        if let Err(left) = self.poll_left(cx) {
            ready!(self.poll_send(cx))?;
            return Poll::Ready(Err(left));
        }
        let mut turns = 0;
        loop {
            if let Poll::Ready(Ok(answer)) = answering.as_mut().poll(cx) {
                return Poll::Ready(Ok(answer));
            }
            let written = self.out.len();
            if self.poll_feed(cx, true) != Fed::Again {
                break;
            }
            // At the body's end the client's end is looked for behind it, before the handler is
            // asked again, as hyper looks when it has read a body's last piece: a client that
            // closed its side behind a whole request has left, with a body as without one.
            if self.feed.is_none() {
                if let Err(left) = self.poll_left(cx) {
                    // A client told to send its body in this turn (`GO_ON`), whose body was
                    // there to its end and who had left, is not told: hyper finds the client's
                    // end before it has flushed what it wrote, and drops that. Nothing has been
                    // sent since `written` was read.
                    self.out.truncate(written);
                    ready!(self.poll_send(cx))?;
                    return Poll::Ready(Err(left));
                }
            }
            turns += 1;
            if turns == TURN {
                cx.waker().wake_by_ref();
                break;
            }
        }
        // While the handler waits, everything written so far goes out: the answers before this
        // one.
        if let Poll::Ready(Err(error)) = self.poll_send(cx) {
            return Poll::Ready(Err(error));
        }
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

    /// What an answer's body gives next: a piece, or `None` at its end (and at its trailers, which
    /// are not sent: the body ends there). `Err` when the body fails, and when it panics: the
    /// panic has been reported where it happened, and it ends this answer as a failure does, not
    /// the task, which has the answers before this one to send ([`serving`]).
    fn poll_piece(cx: &mut Context<'_>, body: &mut Answered) -> Poll<io::Result<Option<Bytes>>> {
        use http_body::Body;
        let polled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Pin::new(&mut *body).poll_frame(cx)));
        Poll::Ready(match polled {
            Ok(Poll::Pending) => return Poll::Pending,
            Ok(Poll::Ready(None)) => Ok(None),
            Ok(Poll::Ready(Some(Ok(frame)))) => Ok(frame.into_data().ok()),
            Ok(Poll::Ready(Some(Err(_)))) => Err(io::Error::other("an answer's body failed")),
            Err(_) => Err(io::Error::other("an answer's body panicked")),
        })
    }

    /// What the connection does where an answer's body waits ([`Conn::poll_meanwhile`]), and for
    /// one that waits for its request's body (an echo, a stream made from what the client
    /// sends): it is given the next piece of that and asked again ([`Conn::poll_feed`]),
    /// [`TURN`] times at the most before other tasks run; what is written of the answer goes out
    /// first, each time, as with hyper, which flushes before it reads on. So an answer whose
    /// body fails with its request's has begun by then, and is cut short.
    ///
    /// At the request's body's end the client's end is looked for behind it, before the answer's
    /// body is asked again, as hyper looks when it has read a body's last piece and before it
    /// writes: a client that has closed its side by then has left, and is written no more of an
    /// answer that waited for what it sent.
    ///
    /// `late`: the request's body was found to have ended in this poll of the task, as its
    /// handler dropped it with its answer. hyper reads that end only once it has written and
    /// flushed what the answer gave in the turn it was made, and looks for the client's end
    /// then; so what is written goes out here before the look, and a client that has left has
    /// the beginning of the answer from both.
    ///
    /// Apart from [`Conn::poll_body`], which a body that does not wait never leaves.
    #[inline(never)]
    fn poll_waiting(&mut self, cx: &mut Context<'_>, body: &mut Answered, late: bool) -> Poll<io::Result<Option<Bytes>>> {
        if late {
            if let Poll::Ready(Err(error)) = self.poll_send(cx) {
                return Poll::Ready(Err(error));
            }
        }
        let mut turns = 0;
        loop {
            self.poll_meanwhile(cx)?;
            if self.feed.is_none() {
                return Poll::Pending;
            }
            let fed = self.poll_feed(cx, false);
            if self.feed.is_none() {
                self.poll_left(cx)?;
            }
            if fed != Fed::Again {
                return Poll::Pending;
            }
            turns += 1;
            if turns == TURN {
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            if let Poll::Ready(next) = Self::poll_piece(cx, body)? {
                return Poll::Ready(Ok(next));
            }
        }
    }

    /// Writes an answer's body as it comes: whether the connection can go on to another request.
    /// `ahead`: what the body gave while the piece before it waited to go, kept by the caller
    /// from one poll to the next.
    ///
    /// Once the task has waited since the answer's head was written (`waited`), the client's end
    /// is looked for each time the task is polled, before the body is asked for more or
    /// anything is written: a piece that is ready by then is not written to a client that has
    /// closed its side by then, as hyper, which reads before it writes each time its task is
    /// woken, writes none. A body polled in the turn its handler answered is not looked for
    /// here: its handler was ([`Conn::poll_answer`]), in that turn, and it pays for this the
    /// read of the flag (3 instructions a request counted, 10 for a 12 KB page).
    fn poll_body(
        &mut self,
        cx: &mut Context<'_>,
        body: &mut Answered,
        coding: &mut Coding,
        ahead: &mut Option<Option<Bytes>>,
    ) -> Poll<io::Result<bool>> {
        use http_body::Body;
        // The request's body, if it is unfinished: read past or given up where the handler
        // dropped it with its answer, before the client's end is looked for. Where that finds
        // the body's end in the piece hyper reads ahead of the app, the client's end is looked
        // for at once: hyper has looked since it read that piece, and a client that closed its
        // side while its handler held a body that had ended is given no answer by either.
        let unfinished = self.feed.is_some();
        let ended_ahead = unfinished && self.poll_feed(cx, false) == Fed::EndedAhead;
        if self.waited || ended_ahead {
            self.poll_left(cx)?;
        }
        // The body ended here and not ahead: hyper reads that end behind what this turn writes
        // of the answer (`poll_waiting`).
        let late = unfinished && !ended_ahead && self.feed.is_none();
        loop {
            // A piece too large to copy, or enough to fill a write, goes out before anything is
            // written behind it: a client that reads slowly holds the stream back. The body is
            // asked first for what follows, once, and that is kept until what is written has
            // gone. So a body that fails there has failed before any of its answer had to go,
            // and the answer is not begun ([`serving`]), as with hyper, which asks a body for
            // more before it flushes; and one that waits there is sent as far as it has come.
            if self.large.is_some() || self.out.len() - self.sent >= FLUSH_AT {
                if ahead.is_none() {
                    match Self::poll_piece(cx, body)? {
                        Poll::Ready(next) => *ahead = Some(next),
                        Poll::Pending => match self.poll_waiting(cx, body, late)? {
                            Poll::Ready(next) => *ahead = Some(next),
                            Poll::Pending => return Poll::Pending,
                        },
                    }
                }
                ready!(self.poll_deliver(cx, self.waited))?;
            }
            let next = match ahead.take() {
                Some(next) => next,
                None => match Self::poll_piece(cx, body)? {
                    Poll::Ready(next) => next,
                    Poll::Pending => match self.poll_waiting(cx, body, late)? {
                        Poll::Ready(next) => next,
                        Poll::Pending => return Poll::Pending,
                    },
                },
            };
            let Some(piece) = next else { return Poll::Ready(self.end(*coding)) };
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

    /// Forgets the last answer written (from `begun` on), if none of it has gone to the IO:
    /// `false` if some has.
    fn unwrite(&mut self) -> bool {
        if self.gone > self.begun {
            return false;
        }
        self.out.truncate(self.sent + (self.begun - self.gone) as usize);
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
                Ok(Some(head)) => break head,
                Ok(None) => {}
                // The answers before it go first; then the connection is hyper's. Not if shutdown
                // began while they went: a request found behind an answer is not begun then
                // (below), by hyper either.
                Err(Instead::Hypers) => {
                    if conn.send().await.is_err() {
                        return false;
                    }
                    if !first && closing.load(Relaxed) {
                        conn.close().await;
                        return false;
                    }
                    return true;
                }
                Err(Instead::Refused(refusal)) => {
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
                // The client is done, the header timeout has passed, or the server is shutting
                // down. A client that closed its side while the last answer waited for it to
                // read has left (`poll_head`): the answers before that one are sent if none of
                // it has gone, and otherwise it is cut short where it is. So with one that
                // closes its side while what is unsent goes out here (shutdown began with an
                // answer still waiting for its client): the client's end is looked for while
                // that waits (`deliver`), as hyper looks while it drains.
                _ => {
                    let sent = if conn.left { conn.unwrite() } else { conn.deliver().await };
                    if sent {
                        conn.close().await;
                    }
                    return false;
                }
            }
        };
        first = false;
        // In a block: the head's parts are read here, and what has been borrowed is held by the
        // future across every wait behind it, to the end of its scope.
        let mut asked;
        let answer = {
            let mut answering = pin!({
                let Head { parts, keep_alive } = head;
                asked = Asked { head: parts.method == Method::HEAD, http11: parts.version == Version::HTTP_11, keep_alive };
                // A body is unfinished here only if this request's head framed one (`parse`):
                // the body of the request before has ended by now (below). The service is
                // called in two places so that a request with no body is made and handed to it
                // as it was before bodies were read, with no copy of it made for a body to be
                // put into.
                if conn.feed.is_some() {
                    service.call(conn.request(parts))
                } else {
                    service.call(http::Request::from_parts(parts, Body::empty()))
                }
            });
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
        if closing.load(Relaxed) || conn.unkept {
            asked.keep_alive = false;
        }
        // The answer's head, written without a wait: its parts are not held across one.
        let (mut body, written) = {
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
            conn.begun = conn.mark();
            let written = head::write(&mut conn.out, parts.status, parts.version, &mut parts.headers, known, asked);
            if written.is_ok() {
                conn.cached = Some(std::mem::take(&mut parts.headers));
            }
            (body, written.ok())
        };
        let Some((mut coding, mut last)) = written else {
            conn.close().await;
            return false;
        };
        if coding != Coding::Length(0) {
            let mut ahead = None;
            let wrote = poll_fn(|cx| {
                let wrote = conn.poll_body(cx, &mut body, &mut coding, &mut ahead);
                conn.waited |= wrote.is_pending();
                wrote
            });
            match wrote.await {
                Ok(goes_on) => last |= !goes_on,
                // The answer cannot be finished: its body failed, or its client left while it
                // waited for the body or for the client to read. If none of it has gone, the
                // client gets the answers before it and no part of this one, as with hyper;
                // otherwise what it has is cut short.
                Err(_) if conn.unwrite() => {
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
        // The request's body, where it is unfinished: read past or given up if the app dropped
        // it, and read to its end for a task that holds it still, before anything behind it is
        // taken for a request.
        if conn.feed.is_some() {
            let read = poll_fn(|cx| {
                let read = conn.poll_behind(cx);
                conn.waited |= read.is_pending();
                read
            });
            if read.await.is_err() {
                return false;
            }
        }
        last |= conn.ends;
        // A piece too large to copy goes out before anything is written behind it, and so does a
        // full buffer: a client that sends requests and reads no answers is not answered further.
        // A client that closes its side while the answer waits for it to read is given up there
        // (`deliver`), in each of the three waits below.
        if (conn.large.is_some() || conn.out.len() - conn.sent >= FLUSH_AT) && !conn.deliver().await {
            return false;
        }
        turn += 1;
        if turn == TURN && !last {
            // A client that keeps sending requests does not keep the thread: what is written goes
            // out, and other tasks run.
            if !conn.deliver().await {
                return false;
            }
            tokio::task::yield_now().await;
            conn.waited = true;
        }
        // Shutdown that began while this answer was made or sent ends the connection here, as
        // one that began before its head was written does (above): no request behind it is
        // begun, whether it has been read or not, as hyper begins none once it is told.
        if last || closing.load(Relaxed) {
            if conn.deliver().await {
                conn.close().await;
            }
            return false;
        }
    }
}
