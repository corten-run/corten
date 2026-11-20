//! [`crate::App::header_timeout`]: how long a connection may wait for a request's head, and
//! [`crate::App::send_timeout`]: how long a write may wait for the client to take more of an
//! answer. Each connection has a [`Watch`]: busy from when hyper hands over a request's head until
//! its answer's last bytes have gone to the socket, otherwise the time it went idle; and the time a
//! write found the socket full, or the socket last reported room while it waited, until one goes
//! through. One thread per server ticks a coarse clock a few times a second and expires the
//! connections idle or stalled past their timeout; the connection's next read or write then fails
//! and hyper closes it. hyper's own header timer was
//! measured first: about 900 instructions a keep-alive request with a coarse timer of Corten's
//! (1,400 with tokio's), since it sets up a sleep for every head and reads once more to start it.
//! This costs about 300 (callgrind, keep-alive requests over TCP), which Corten's accept loop saved
//! against `axum::serve` when it was measured.

use crate::body::Body;
use bytes::Bytes;
use futures_util::task::AtomicWaker;
use std::{
    future::Future,
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering::Relaxed, Ordering::SeqCst},
        Arc, Mutex, Weak,
    },
    task::{Context, Poll, Wake, Waker},
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// A connection between a request's head and the end of its answer.
const BUSY: u64 = u64::MAX;
/// A connection idle past the timeout.
const EXPIRED: u64 = u64::MAX - 1;
/// A connection whose answer's body hyper has taken (whole, or a stream's last chunk), with bytes
/// of it perhaps still to send: idle from the next flush that completes ([`Watch::flushed`]), not
/// from now.
const DRAINING: u64 = u64::MAX - 2;
/// A timeout that is not set.
const NEVER: u64 = u64::MAX;
/// A connection whose writes are going through (`Watch::stalled`).
const FLOWING: u64 = 0;
/// A connection whose write has waited past the send timeout (`Watch::stalled`).
const STALLED: u64 = u64::MAX;

/// The time, in milliseconds since `base`, as of the last tick, and the connections to watch.
pub(crate) struct Clock {
    base: Instant,
    now: AtomicU64,
    /// The header timeout and the send timeout in milliseconds, [`NEVER`] when not set.
    timeout: u64,
    send: u64,
    watches: Mutex<Vec<Weak<Watch>>>,
}

impl Clock {
    /// A clock that expires connections idle for `header` and those whose write has waited for
    /// `send`, to within a tick either way: a tenth of the shorter, at most a second. `None` when
    /// neither is set. It ticks on a thread of its own, which ends at the first tick after the
    /// clock's last [`Watch`] has dropped.
    pub fn start(header: Option<Duration>, send: Option<Duration>) -> Option<Arc<Clock>> {
        let shortest = match (header, send) {
            (None, None) => return None,
            (Some(one), None) | (None, Some(one)) => one,
            (Some(header), Some(send)) => header.min(send),
        };
        let tick = (shortest / 10).clamp(Duration::from_millis(10), Duration::from_secs(1));
        let millis = |timeout: Option<Duration>| timeout.map_or(NEVER, |t| t.as_millis().try_into().unwrap_or(NEVER));
        let clock = Arc::new(Clock {
            base: Instant::now(),
            now: AtomicU64::new(0),
            timeout: millis(header),
            send: millis(send),
            watches: Mutex::new(Vec::new()),
        });
        let weak = Arc::downgrade(&clock);
        std::thread::Builder::new()
            .name("corten-clock".into())
            .spawn(move || loop {
                std::thread::sleep(tick);
                let Some(clock) = weak.upgrade() else { return };
                clock.tick();
            })
            .expect("corten: could not start the clock's thread");
        Some(clock)
    }

    /// A watch for a connection that has just opened: idle from now.
    pub fn watch(self: &Arc<Self>) -> Arc<Watch> {
        let watch = Arc::new(Watch {
            since: AtomicU64::new(self.now.load(Relaxed)),
            heads: AtomicU64::new(0),
            waker: AtomicWaker::new(),
            stalled: AtomicU64::new(FLOWING),
            writer: AtomicWaker::new(),
            wakes: AtomicU64::new(0),
            held: AtomicBool::new(false),
            clock: self.clone(),
        });
        self.watches.lock().expect("never poisoned").push(Arc::downgrade(&watch));
        watch
    }

    /// Advances the time, expires the connections idle or stalled past their timeout and wakes
    /// them; forgets the closed ones.
    fn tick(&self) {
        let now = Instant::now().saturating_duration_since(self.base).as_millis() as u64;
        self.now.store(now, Relaxed);
        self.watches.lock().expect("never poisoned").retain(|watch| {
            let Some(watch) = watch.upgrade() else { return false };
            let since = watch.since.load(Relaxed);
            // A head that arrives meanwhile makes it busy, and the exchange fails.
            if since < DRAINING
                && now.saturating_sub(since) >= self.timeout
                && watch.since.compare_exchange(since, EXPIRED, Relaxed, Relaxed).is_ok()
            {
                watch.waker.wake();
            }
            // `stalled` is one past the time the write found the socket full.
            let stalled = watch.stalled.load(Relaxed);
            if stalled != FLOWING
                && stalled != STALLED
                && now.saturating_sub(stalled - 1) >= self.send
                && watch.stalled.compare_exchange(stalled, STALLED, Relaxed, Relaxed).is_ok()
            {
                watch.wake_writer();
            }
            true
        });
    }
}

/// One connection's state for its [`Clock`].
pub(crate) struct Watch {
    /// [`BUSY`], [`DRAINING`], [`EXPIRED`], or the time the connection went idle.
    since: AtomicU64,
    /// How many heads have arrived, so an answer finished after the next head arrived does not
    /// mark the connection idle. Only the connection's task writes it.
    heads: AtomicU64,
    waker: AtomicWaker,
    /// [`FLOWING`], [`STALLED`], or one past the time a write found the socket full, or the IO
    /// last reported room while it waited.
    stalled: AtomicU64,
    /// The task whose write, flush or close is waiting; empty while none is, and for a moment
    /// while a call takes it to register its own ([`Watched::send`]).
    writer: AtomicWaker,
    /// How many wakes ([`Watch::wake_writer`]) found `writer` empty, so a call that had taken it
    /// can tell one came meanwhile.
    wakes: AtomicU64,
    /// Whether a write or a close holds the stall: set when one is left waiting, kept when the
    /// clock fails it, and cleared when the IO finishes a write (it went through or the IO failed
    /// it). A flush or a close that goes through ends the stall only while none does
    /// ([`Watched::send`]), so another task's flushes cannot start a waiting write's or close's
    /// wait over. A close that waited and went through leaves it held: the connection is done.
    held: AtomicBool,
    clock: Arc<Clock>,
}

impl Watch {
    /// A request's head has arrived. Also when the clock has just expired the connection: the
    /// head came in time for it to read.
    /// Returns the head's number, for [`Watch::idle`].
    pub fn busy(&self) -> u64 {
        self.since.store(BUSY, Relaxed);
        let head = self.heads.load(Relaxed) + 1;
        self.heads.store(head, Relaxed);
        head
    }

    /// hyper has taken the answer to `head` whole: idle once it has been sent ([`Watch::flushed`]),
    /// unless another head has arrived since. hyper takes a body's last chunk before writing it, and
    /// a whole body (a `Vec`, a file read into memory) at once, so the header timeout counted from
    /// here would close a download its client is still reading (#1746).
    fn idle(&self, head: u64) {
        if self.heads.load(Relaxed) == head {
            self.since.store(DRAINING, Relaxed);
        }
    }

    /// A flush went through: hyper flushes the IO only once its own buffer is empty, so an answer it
    /// had taken whole has now gone to the socket (and over TLS, out of the TLS library's buffer).
    /// The connection is idle from now.
    fn flushed(&self) {
        if self.since.load(Relaxed) == DRAINING {
            self.since.store(self.clock.now.load(Relaxed), Relaxed);
        }
    }

    fn expired(&self) -> bool {
        self.since.load(Relaxed) == EXPIRED
    }

    /// Wakes the waiting call's task: the IO has room, or the clock has expired the wait. A wake
    /// that finds `writer` empty is counted only then, after its take, so a call that had taken it
    /// (and read the count before) sees the count change; and it wakes again, for a call that has
    /// put its waker back since. Counted before the take, a wake could be counted before the call
    /// read the count and still find `writer` empty, and be lost.
    fn wake_writer(&self) {
        match self.writer.take() {
            Some(waker) => waker.wake(),
            None => self.missed(),
        }
    }

    /// The rest of a wake that found `writer` empty ([`Watch::wake_writer`]).
    fn missed(&self) {
        self.wakes.fetch_add(1, SeqCst);
        self.writer.wake();
    }
}

/// The IO's waker while a write, a flush or a close waits ([`Watched::send`]). The IO wakes it
/// when it has room again, so the wait starts over from then, and wakes the connection's task.
/// A TLS stream (tokio-rustls) moves the records it holds to the socket as the client makes room,
/// but its write stays pending until it has room for more and its flush until all have gone: a
/// client reading steadily but slower than the server writes would otherwise be cut at the send
/// timeout while bytes are still going to it (#1742).
impl Wake for Watch {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        let stalled = self.stalled.load(Relaxed);
        // Not one that has gone through meanwhile, nor one the clock has expired.
        if stalled != FLOWING && stalled != STALLED {
            let _ = self.stalled.compare_exchange(stalled, self.clock.now.load(Relaxed) + 1, Relaxed, Relaxed);
        }
        self.wake_writer();
    }
}

/// Polls `step`, the app's own step on a connection before HTTP ([`crate::serve_wrapped`]),
/// for a connection under `watch`: `None` once the watch has expired, so a step that stalls,
/// reading from the socket or waiting on anything else, ends at the header timeout.
pub(crate) fn bounded<F: Future>(watch: Option<&Watch>, step: Pin<&mut F>, cx: &mut Context<'_>) -> Poll<Option<F::Output>> {
    let Some(watch) = watch else {
        return step.poll(cx).map(Some);
    };
    if watch.expired() {
        return Poll::Ready(None);
    }
    if let Poll::Ready(done) = step.poll(cx) {
        return Poll::Ready(Some(done));
    }
    watch.waker.register(cx.waker());
    // Expired between the first look and the registration: its wake may have been missed.
    if watch.expired() {
        return Poll::Ready(None);
    }
    Poll::Pending
}

/// A connection's IO, whose reads fail once its [`Watch`] has expired idle, and whose writes
/// fail once one has waited past the send timeout. It holds the connection's place under
/// [`crate::App::max_connections`] too: hyper hands the IO to the route when the connection
/// switches (a WebSocket, a tunnel), so the place is given back when the route drops the socket,
/// not when hyper's connection ends.
pub(crate) struct Watched<I> {
    pub io: I,
    pub watch: Option<Arc<Watch>>,
    /// Never read: held for its drop. Declared after `io` because fields drop in the order they
    /// are declared: the socket closes before its place under the cap is given back, so the cap
    /// never admits a connection while the one it replaces still holds its socket.
    pub _open: Option<tokio::sync::OwnedSemaphorePermit>,
}

fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "corten: no request head within the header timeout")
}

fn stalled() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "corten: a write waited past the send timeout for room to send")
}

impl<I: AsyncRead + Unpin> AsyncRead for Watched<I> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let Some(watch) = &this.watch else {
            return Pin::new(&mut this.io).poll_read(cx, buf);
        };
        if watch.expired() {
            return Poll::Ready(Err(timed_out()));
        }
        let read = Pin::new(&mut this.io).poll_read(cx, buf);
        if read.is_pending() && watch.since.load(Relaxed) != BUSY {
            watch.waker.register(cx.waker());
            // Expired between the first look and the registration: its wake may have been missed.
            if watch.expired() {
                return Poll::Ready(Err(timed_out()));
            }
        }
        read
    }
}

impl<I: AsyncWrite + Unpin> Watched<I> {
    /// A write, a flush or a close (`call`), for [`crate::App::send_timeout`]: one that waits
    /// starts the stall, or fails once the clock has expired it, so a call is failed only while
    /// the IO still has no room. While it waits the IO is polled with the watch's waker, so each
    /// time the IO reports room the wait starts over ([`Watch`]'s `Wake`): a TLS stream's call
    /// can stay pending while its bytes go out. A write the IO finished (it went through or the IO
    /// failed it) clears it (`clears`); a flush or a close does only when no write or close that
    /// waited holds it (`holds`, `Watch`'s `held`), since a plain socket's
    /// flush is done at once whether anything went or not, and a route on a switched connection
    /// could otherwise restart the clock with flushes while its writes wait. Nor does a wake
    /// tokio's cooperative budget makes: with the budget spent the IO is polled with the task's
    /// waker, or a client that floods a route's reads could keep a write that never goes through
    /// waiting.
    #[inline]
    fn send<T>(
        &mut self,
        cx: &mut Context<'_>,
        clears: bool,
        holds: bool,
        mut call: impl FnMut(Pin<&mut I>, &mut Context<'_>) -> Poll<io::Result<T>>,
    ) -> Poll<io::Result<T>> {
        let Watched { io, watch, .. } = self;
        let watch = match watch {
            Some(watch) if watch.clock.send != NEVER => watch,
            _ => return call(Pin::new(io), cx),
        };
        let flowing = watch.stalled.load(Relaxed) == FLOWING;
        if flowing {
            let done = call(Pin::new(io), cx);
            if done.is_ready() {
                return done;
            }
        }
        Self::wait(io, watch, cx, clears, holds, flowing, call)
    }

    /// [`Watched::send`] once its call waits, or found the IO waiting: out of line, so the path of a
    /// call that goes through at once stays small (it reads `clock.send` and `stalled` first, then
    /// calls the IO). A wait costs more than it did: the first poll that waits polls the IO again,
    /// and each one clones the watch's `Arc` and registers the task.
    #[cold]
    fn wait<T>(
        io: &mut I,
        watch: &Arc<Watch>,
        cx: &mut Context<'_>,
        clears: bool,
        holds: bool,
        flowing: bool,
        mut call: impl FnMut(Pin<&mut I>, &mut Context<'_>) -> Poll<io::Result<T>>,
    ) -> Poll<io::Result<T>> {
        if flowing {
            watch.stalled.store(watch.clock.now.load(Relaxed) + 1, Relaxed);
        }
        // Before the IO can wake the watch, so its wake reaches the task. A call already waiting
        // (this task's own, or another's on a switched connection a route shares) is put back below
        // if this one goes through, so the IO's next report of room still reaches it; another
        // task's is also woken, in case the IO now holds this call's waker instead, and this
        // task's is woken if a wake came while `writer` was empty. A finished call that displaced
        // none leaves no registration, so two tasks that flush when woken do not wake each other
        // in turn. Two calls that both wait are woken only the last, as tokio's own are.
        at(0);
        let wakes = watch.wakes.load(SeqCst);
        let previous = watch.writer.take();
        at(1);
        watch.writer.register(cx.waker());
        let done = if tokio::task::coop::has_budget_remaining() {
            // A call that has just waited on the task's waker is polled again, so the IO holds the
            // watch's instead.
            call(Pin::new(io), &mut Context::from_waker(&Waker::from(watch.clone())))
        } else if flowing {
            Poll::Pending
        } else {
            call(Pin::new(io), cx)
        };
        let done = match done {
            Poll::Ready(done) => {
                if clears {
                    watch.held.store(false, Relaxed);
                    watch.stalled.store(FLOWING, Relaxed);
                } else if !watch.held.load(Relaxed) {
                    // A flush, or a close that did not wait, that went through with no write or
                    // close holding the stall ends the stall, even one the clock had expired (it
                    // found room after all), so a later wait starts its own (#1762).
                    watch.stalled.store(FLOWING, Relaxed);
                }
                done
            }
            // Expired before the registration: its wake may have been missed.
            // A held stall stays held (`held`), so a flush that goes through later does not end it
            // and the next call that waits fails too.
            Poll::Pending if watch.stalled.load(Relaxed) == STALLED => Err(stalled()),
            Poll::Pending => {
                if holds {
                    watch.held.store(true, Relaxed);
                }
                return Poll::Pending;
            }
        };
        match previous {
            Some(previous) => {
                watch.writer.register(&previous);
                if !previous.will_wake(cx.waker()) || watch.wakes.load(SeqCst) != wakes {
                    previous.wake();
                }
            }
            None => drop(watch.writer.take()),
        }
        at(2);
        Poll::Ready(done)
    }
}

/// Runs a test's step at `point` in [`Watched::wait`], so a test can put a wake between its steps:
/// before it reads the count (0), between its take and its registration (1), and once it is done (2).
#[cfg(test)]
fn at(point: u8) {
    tests::STEP.with(|step| {
        if let Some(step) = step.borrow_mut().as_mut() {
            step(point);
        }
    });
}

#[cfg(not(test))]
#[inline(always)]
fn at(_: u8) {}

impl<I: AsyncWrite + Unpin> AsyncWrite for Watched<I> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        self.get_mut().send(cx, true, true, |io, cx| io.poll_write(cx, buf))
    }

    fn poll_write_vectored(self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        self.get_mut().send(cx, true, true, |io, cx| io.poll_write_vectored(cx, bufs))
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let flushed = this.send(cx, false, false, |io, cx| io.poll_flush(cx));
        if let (Poll::Ready(Ok(())), Some(watch)) = (&flushed, &this.watch) {
            watch.flushed();
        }
        flushed
    }

    /// Watched too: over TLS, closing writes a last record, which waits on the client as any
    /// write does.
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut().send(cx, false, true, |io, cx| io.poll_shutdown(cx))
    }
}

/// A request's answer, whose body marks its connection as sending its last bytes when hyper has
/// taken it ([`Watch::idle`]), idle once they are flushed ([`Watch::flushed`]). A switched
/// connection (a 101, or a 2xx to `CONNECT`: a tunnel) stays busy: it is the route's from then on.
pub(crate) struct Answer<F> {
    pub inner: F,
    /// The connection's watch and the head's number.
    pub watch: Option<(Arc<Watch>, u64)>,
    /// The request is a `CONNECT`, which a 2xx switches (RFC 9110 9.3.6).
    pub connect: bool,
}

impl<F: Future<Output = Result<crate::response::Response, std::convert::Infallible>> + Unpin> Future for Answer<F> {
    type Output = Result<http::Response<Answered>, std::convert::Infallible>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let res = match std::task::ready!(Pin::new(&mut this.inner).poll(cx)) {
            Ok(res) => res,
            Err(never) => match never {},
        };
        let status = res.status();
        let switched = status == http::StatusCode::SWITCHING_PROTOCOLS || (this.connect && status.is_success());
        let watch = this.watch.take().filter(|_| !switched);
        Poll::Ready(Ok(res.map(|body| Answered { body, watch })))
    }
}

/// An answer's body, for [`Answer`].
pub(crate) struct Answered {
    body: Body,
    watch: Option<(Arc<Watch>, u64)>,
}

impl http_body::Body for Answered {
    type Data = Bytes;
    type Error = crate::body::BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, crate::body::BoxError>>> {
        Pin::new(&mut self.get_mut().body).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

impl Drop for Answered {
    fn drop(&mut self) {
        if let Some((watch, head)) = &self.watch {
            watch.idle(*head);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A test's step, given the point in [`Watched::wait`] it runs at.
    type Step = Box<dyn FnMut(u8)>;

    thread_local! {
        /// The step [`at`] runs on this thread, if any.
        pub(super) static STEP: std::cell::RefCell<Option<Step>> = const { std::cell::RefCell::new(None) };
    }

    /// An IO no write or close gets through: a client that reads nothing.
    struct Stuck;

    impl AsyncRead for Stuck {
        fn poll_read(self: Pin<&mut Self>, _: &mut Context<'_>, _: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }
    }

    impl AsyncWrite for Stuck {
        fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, _: &[u8]) -> Poll<io::Result<usize>> {
            Poll::Pending
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }
    }

    /// A write, a flush and a close (TLS writes its last record there) that wait on the client
    /// each fail once the send timeout has passed.
    #[tokio::test]
    async fn a_write_a_flush_or_a_close_that_waits_fails_after_the_send_timeout() {
        use tokio::io::AsyncWriteExt;
        let clock = Clock::start(None, Some(Duration::from_millis(40))).unwrap();
        for step in ["write", "flush", "shutdown"] {
            let mut io = Watched { io: Stuck, watch: Some(clock.watch()), _open: None };
            let done = tokio::time::timeout(Duration::from_secs(2), async {
                match step {
                    "write" => io.write(b"x").await.map(drop),
                    "flush" => io.flush().await,
                    _ => io.shutdown().await,
                }
            });
            let error = done.await.unwrap_or_else(|_| panic!("a {step} that waits is ended")).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::TimedOut, "{step}");
        }
    }

    /// A wake from tokio's cooperative budget is not the IO making room: a write to a client that
    /// reads nothing still fails at the send timeout when its task spends the budget before each
    /// try, as a route reading a flood of requests from that client would.
    #[tokio::test]
    async fn a_write_that_waits_with_the_budget_spent_still_fails_after_the_send_timeout() {
        let clock = Clock::start(None, Some(Duration::from_millis(40))).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let _client = tokio::net::TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        let (tcp, _) = listener.accept().await.unwrap();
        // The client reads nothing, so the socket fills.
        while tcp.try_write(&[0; 64 << 10]).is_ok() {}
        let mut io = Watched { io: tcp, watch: Some(clock.watch()), _open: None };
        let (spend, mut budget) = tokio::sync::mpsc::unbounded_channel::<()>();
        let started = Instant::now();
        let written = loop {
            assert!(started.elapsed() < Duration::from_secs(2), "a write that waits is ended");
            for _ in 0..200 {
                spend.send(()).unwrap();
            }
            let written = std::future::poll_fn(|cx| {
                // Each message received takes from the budget, until none is left.
                while let Poll::Ready(Some(())) = budget.poll_recv(cx) {}
                Poll::Ready(Pin::new(&mut io).poll_write(cx, b"x"))
            })
            .await;
            match written {
                Poll::Ready(written) => break written,
                Poll::Pending => tokio::task::yield_now().await,
            }
        };
        assert_eq!(written.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    /// Two tasks writing to one connection, as a route that shares a switched connection behind a
    /// lock might: a flush that goes through while the other task's write waits does not take the
    /// wake that write is owed when the client makes room.
    #[tokio::test]
    async fn a_call_that_goes_through_does_not_take_the_wake_of_another_tasks_write() {
        use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
        use tokio::io::AsyncReadExt;
        let clock = Clock::start(None, Some(Duration::from_secs(30))).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = tokio::net::TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        let (tcp, _) = listener.accept().await.unwrap();
        // The client reads nothing yet, so the socket fills.
        while tcp.try_write(&[0; 64 << 10]).is_ok() {}
        let io = Arc::new(Mutex::new(Watched { io: tcp, watch: Some(clock.watch()), _open: None }));
        let waiting = Arc::new(AtomicBool::new(false));
        let write = tokio::spawn({
            let (io, waiting) = (io.clone(), waiting.clone());
            std::future::poll_fn(move |cx| {
                let written = Pin::new(&mut *io.lock().unwrap()).poll_write(cx, b"x");
                waiting.store(written.is_pending(), SeqCst);
                written
            })
        });
        let started = Instant::now();
        while !waiting.load(SeqCst) {
            assert!(started.elapsed() < Duration::from_secs(2), "the write waits on the full socket");
            tokio::task::yield_now().await;
        }
        std::future::poll_fn(|cx| Pin::new(&mut *io.lock().unwrap()).poll_flush(cx)).await.unwrap();
        // The client makes room: the waiting write is woken and goes through.
        let reader = tokio::spawn(async move {
            let mut buf = vec![0; 64 << 10];
            while client.read(&mut buf).await.is_ok_and(|read| read > 0) {}
        });
        let written = tokio::time::timeout(Duration::from_secs(2), write).await;
        assert_eq!(written.expect("the waiting write is woken").unwrap().unwrap(), 1);
        reader.abort();
    }

    /// An IO whose writes wait and whose flushes go through at once.
    struct Flushes;

    impl AsyncWrite for Flushes {
        fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, _: &[u8]) -> Poll<io::Result<usize>> {
            Poll::Pending
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// An IO whose first write waits for `write` polls and then goes through and whose later
    /// writes wait, and whose flush waits for `flush` polls and then goes through: an app's own
    /// IO under `serve_wrapped` can stay full right after its flush has gone through.
    struct FlushesLate {
        write: Option<u8>,
        flush: u8,
    }

    impl AsyncWrite for FlushesLate {
        fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
            let write = &mut self.get_mut().write;
            match write {
                Some(0) => {
                    *write = None;
                    Poll::Ready(Ok(buf.len()))
                }
                Some(polls) => {
                    *polls -= 1;
                    Poll::Pending
                }
                None => Poll::Pending,
            }
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            let polls = &mut self.get_mut().flush;
            if *polls == 0 {
                return Poll::Ready(Ok(()));
            }
            *polls -= 1;
            Poll::Pending
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// A flush that waited and then went through leaves no stall behind it, even when the clock
    /// had expired it meanwhile (`expire`): a write that waits after the connection sat idle
    /// longer than the send timeout gets a whole send timeout of its own, not the flush's (#1762).
    /// A write waited and went through before the flush, as on most connections.
    async fn a_write_after_a_flush_that_waited_gets_its_own_send_timeout(expire: bool) {
        let send = Duration::from_millis(200);
        let clock = Clock::start(None, Some(send)).unwrap();
        let watch = clock.watch();
        // A call that waits is polled twice (`Watched::wait` polls it again with the watch's waker).
        let mut io = Watched { io: FlushesLate { write: Some(2), flush: 2 }, watch: Some(watch.clone()), _open: None };
        let waker = Waker::noop();
        let mut cx = Context::from_waker(waker);
        assert!(Pin::new(&mut io).poll_write(&mut cx, b"x").is_pending());
        assert!(matches!(Pin::new(&mut io).poll_write(&mut cx, b"x"), Poll::Ready(Ok(1))));
        assert!(Pin::new(&mut io).poll_flush(&mut cx).is_pending());
        if expire {
            let started = Instant::now();
            while watch.stalled.load(Relaxed) != STALLED {
                assert!(started.elapsed() < send * 10, "the flush's wait expires");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
        assert!(matches!(Pin::new(&mut io).poll_flush(&mut cx), Poll::Ready(Ok(()))));
        // Idle, past the send timeout.
        tokio::time::sleep(send * 4).await;
        assert!(Pin::new(&mut io).poll_write(&mut cx, b"x").is_pending(), "the write was failed at once");
        // It still fails once its own send timeout has passed, counted in the clock's time from the
        // start this write set (one past it), which a starved clock thread makes older than now.
        let started = watch.stalled.load(Relaxed) - 1;
        let error = std::future::poll_fn(|cx| Pin::new(&mut io).poll_write(cx, b"x")).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        let failed = clock.base.elapsed().as_millis() as u64;
        assert!(failed - started >= send.as_millis() as u64, "failed {} ms after its start", failed - started);
    }

    #[tokio::test]
    async fn a_write_that_waits_after_a_flush_went_through_and_the_connection_sat_idle_gets_its_own_send_timeout() {
        a_write_after_a_flush_that_waited_gets_its_own_send_timeout(false).await;
    }

    #[tokio::test]
    async fn a_write_that_waits_after_an_expired_flush_went_through_gets_its_own_send_timeout() {
        a_write_after_a_flush_that_waited_gets_its_own_send_timeout(true).await;
    }

    /// A write waits while another task's flushes go through over and over, as on a switched
    /// connection a route shares: the flushes do not start the write's wait over, so it still fails
    /// at the send timeout (#1762 keeps this while letting a flush end its own stall).
    #[tokio::test]
    async fn flushes_that_go_through_while_a_write_waits_do_not_hold_it_past_the_send_timeout() {
        let send = Duration::from_millis(200);
        let clock = Clock::start(None, Some(send)).unwrap();
        let mut io = Watched { io: Flushes, watch: Some(clock.watch()), _open: None };
        let (writer, flusher) = (Waker::noop(), Waker::noop());
        assert!(Pin::new(&mut io).poll_write(&mut Context::from_waker(writer), b"x").is_pending());
        let started = Instant::now();
        let failed = loop {
            assert!(started.elapsed() < send * 10, "the waiting write was never failed");
            assert!(Pin::new(&mut io).poll_flush(&mut Context::from_waker(flusher)).is_ready());
            match Pin::new(&mut io).poll_write(&mut Context::from_waker(writer), b"x") {
                Poll::Ready(written) => break written,
                Poll::Pending => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        };
        assert_eq!(failed.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    /// A write the send timeout failed leaves its stall behind for the next call: a flush that
    /// goes through at once, as a plain socket's does, does not end it, so the next write that
    /// waits fails on its first poll rather than getting a send timeout of its own.
    #[tokio::test]
    async fn a_flush_after_a_write_the_send_timeout_failed_does_not_give_the_next_write_a_new_timeout() {
        let send = Duration::from_millis(100);
        let clock = Clock::start(None, Some(send)).unwrap();
        let mut io = Watched { io: Flushes, watch: Some(clock.watch()), _open: None };
        let failed = tokio::time::timeout(send * 20, std::future::poll_fn(|cx| Pin::new(&mut io).poll_write(cx, b"x")))
            .await
            .expect("the waiting write is failed");
        assert_eq!(failed.unwrap_err().kind(), io::ErrorKind::TimedOut);
        let mut cx = Context::from_waker(Waker::noop());
        assert!(matches!(Pin::new(&mut io).poll_flush(&mut cx), Poll::Ready(Ok(()))));
        match Pin::new(&mut io).poll_write(&mut cx, b"x") {
            Poll::Ready(Err(error)) => assert_eq!(error.kind(), io::ErrorKind::TimedOut),
            other => panic!("the next write got a new send timeout: {other:?}"),
        }
    }

    /// An IO whose writes and close wait and whose flushes go through at once.
    struct Closes;

    impl AsyncWrite for Closes {
        fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, _: &[u8]) -> Poll<io::Result<usize>> {
            Poll::Pending
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }
    }

    /// A close waits (TLS writes its last record there) while another task's flushes go through
    /// over and over: they do not start the close's wait over, so it still fails at the send
    /// timeout.
    #[tokio::test]
    async fn flushes_that_go_through_while_a_close_waits_do_not_hold_it_past_the_send_timeout() {
        let send = Duration::from_millis(200);
        let clock = Clock::start(None, Some(send)).unwrap();
        let mut io = Watched { io: Closes, watch: Some(clock.watch()), _open: None };
        let (closer, flusher) = (Waker::noop(), Waker::noop());
        assert!(Pin::new(&mut io).poll_shutdown(&mut Context::from_waker(closer)).is_pending());
        let started = Instant::now();
        let failed = loop {
            assert!(started.elapsed() < send * 10, "the waiting close was never failed");
            assert!(Pin::new(&mut io).poll_flush(&mut Context::from_waker(flusher)).is_ready());
            match Pin::new(&mut io).poll_shutdown(&mut Context::from_waker(closer)) {
                Poll::Ready(closed) => break closed,
                Poll::Pending => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        };
        assert_eq!(failed.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    /// Counts its wakes.
    struct Counted(std::sync::atomic::AtomicUsize);

    impl std::task::Wake for Counted {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// Two tasks on one connection that each flush when woken do not wake each other in turn:
    /// a call that goes through wakes the task whose call waits, once, and takes its own
    /// registration back, so that task's flush going through wakes nobody.
    #[tokio::test]
    async fn a_call_that_goes_through_wakes_the_waiting_task_once_and_is_not_woken_back() {
        use std::sync::atomic::Ordering::SeqCst;
        let clock = Clock::start(None, Some(Duration::from_secs(30))).unwrap();
        let mut io = Watched { io: Flushes, watch: Some(clock.watch()), _open: None };
        let (one, two) = (Arc::new(Counted(0.into())), Arc::new(Counted(0.into())));
        let (one_waker, two_waker) = (Waker::from(one.clone()), Waker::from(two.clone()));
        // The first task's write waits, so the connection is stalled.
        assert!(Pin::new(&mut io).poll_write(&mut Context::from_waker(&one_waker), b"x").is_pending());
        // The second task's flush goes through: the first is woken to register again.
        assert!(Pin::new(&mut io).poll_flush(&mut Context::from_waker(&two_waker)).is_ready());
        assert_eq!((one.0.load(SeqCst), two.0.load(SeqCst)), (1, 0));
        // Woken, the first task flushes too, and that wakes nobody.
        assert!(Pin::new(&mut io).poll_flush(&mut Context::from_waker(&one_waker)).is_ready());
        assert_eq!((one.0.load(SeqCst), two.0.load(SeqCst)), (1, 0));
    }

    /// One task whose write waits and whose flush then goes through, with the clock expiring the
    /// write while the flush has taken `writer` (`steps` puts the expiry's wake into the flush):
    /// how many times the task is woken.
    fn the_expirys_wake_reaches_a_waiting_write(steps: impl FnMut(&Watch, u8) + 'static) -> usize {
        use std::sync::atomic::Ordering::SeqCst;
        let clock = Clock::start(None, Some(Duration::from_secs(30))).unwrap();
        let watch = clock.watch();
        let mut io = Watched { io: Flushes, watch: Some(watch.clone()), _open: None };
        let task = Arc::new(Counted(0.into()));
        let waker = Waker::from(task.clone());
        let mut cx = Context::from_waker(&waker);
        assert!(Pin::new(&mut io).poll_write(&mut cx, b"x").is_pending());
        let mut steps = steps;
        STEP.with(|step| *step.borrow_mut() = Some(Box::new(move |point| steps(&watch, point))));
        let flushed = Pin::new(&mut io).poll_flush(&mut cx);
        STEP.with(|step| *step.borrow_mut() = None);
        assert!(flushed.is_ready());
        task.0.load(SeqCst)
    }

    /// A wake that finds a call waiting wakes it and is not counted: only a wake that found `writer`
    /// empty is, after its take, so a call that took `writer` before it cannot read it already counted.
    #[tokio::test]
    async fn a_wake_that_finds_a_waiting_call_wakes_it_and_is_not_counted() {
        use std::sync::atomic::Ordering::SeqCst;
        let clock = Clock::start(None, Some(Duration::from_secs(30))).unwrap();
        let watch = clock.watch();
        let mut io = Watched { io: Flushes, watch: Some(watch.clone()), _open: None };
        let task = Arc::new(Counted(0.into()));
        let waker = Waker::from(task.clone());
        assert!(Pin::new(&mut io).poll_write(&mut Context::from_waker(&waker), b"x").is_pending());
        watch.wake_writer();
        assert_eq!((task.0.load(SeqCst), watch.wakes.load(SeqCst)), (1, 0));
    }

    #[tokio::test]
    async fn an_expiry_whose_wake_comes_while_a_call_has_taken_writer_still_wakes_the_task() {
        let woken = the_expirys_wake_reaches_a_waiting_write(|watch, point| match point {
            0 => watch.stalled.store(STALLED, Relaxed),
            1 => watch.wake_writer(),
            _ => {}
        });
        assert_eq!(woken, 1);
    }

    /// The expiry's wake takes `writer` while the call has it, finds it empty, and is counted and
    /// wakes again only once the call is done: the second wake reaches the task.
    #[tokio::test]
    async fn an_expiry_whose_wake_finds_writer_empty_and_ends_after_the_call_still_wakes_the_task() {
        let woken = the_expirys_wake_reaches_a_waiting_write(|watch, point| match point {
            0 => watch.stalled.store(STALLED, Relaxed),
            // `wake_writer`'s steps, split around the end of the call.
            1 => assert!(watch.writer.take().is_none()),
            2 => watch.missed(),
            _ => {}
        });
        assert_eq!(woken, 1);
    }

    /// One task whose write waits and whose flush then goes through, as a route that writes and
    /// flushes one stream from joined futures might: the flush leaves the write's registration
    /// in place, so the client making room wakes the task.
    #[tokio::test]
    async fn a_call_that_goes_through_leaves_its_own_tasks_waiting_write_to_be_woken() {
        use std::sync::atomic::Ordering::SeqCst;
        use tokio::io::AsyncReadExt;
        let clock = Clock::start(None, Some(Duration::from_secs(30))).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = tokio::net::TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        let (tcp, _) = listener.accept().await.unwrap();
        // The client reads nothing yet, so the socket fills.
        while tcp.try_write(&[0; 64 << 10]).is_ok() {}
        let mut io = Watched { io: tcp, watch: Some(clock.watch()), _open: None };
        let task = Arc::new(Counted(0.into()));
        let waker = Waker::from(task.clone());
        let mut cx = Context::from_waker(&waker);
        assert!(Pin::new(&mut io).poll_write(&mut cx, b"x").is_pending());
        assert!(Pin::new(&mut io).poll_flush(&mut cx).is_ready());
        // The client makes room.
        let reader = tokio::spawn(async move {
            let mut buf = vec![0; 64 << 10];
            while client.read(&mut buf).await.is_ok_and(|read| read > 0) {}
        });
        let started = Instant::now();
        while task.0.load(SeqCst) == 0 {
            assert!(started.elapsed() < Duration::from_secs(2), "the waiting write is woken");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        reader.abort();
    }

    #[test]
    fn a_connection_expires_only_while_idle_and_a_head_in_time_wins() {
        let clock = Clock::start(Some(Duration::from_millis(40)), None).unwrap();
        let watch = clock.watch();
        let first = watch.busy();
        let second = watch.busy();
        std::thread::sleep(Duration::from_millis(150));
        watch.idle(first);
        assert!(!watch.expired(), "a busy connection does not expire, nor go idle on an earlier answer");
        watch.idle(second);
        // Handed over but perhaps not yet sent: no expiry, however long that takes (#1746).
        std::thread::sleep(Duration::from_millis(150));
        assert!(!watch.expired(), "an answer still going out does not expire");
        // A pipelined head read before that answer's flush completes: the flush leaves it busy.
        let third = watch.busy();
        watch.flushed();
        std::thread::sleep(Duration::from_millis(150));
        assert!(!watch.expired(), "a head read while the last answer drained keeps the connection busy");
        watch.idle(third);
        watch.flushed();
        // Idle from the clock's last tick, which a starved clock thread makes older than now: the
        // promise is a timeout from that time, to within a tick, not from this call.
        let idle_at = watch.since.load(Relaxed);
        let started = Instant::now();
        while !watch.expired() {
            assert!(started.elapsed() < Duration::from_secs(2), "an idle connection expires");
            std::thread::sleep(Duration::from_millis(5));
        }
        let expired_at = clock.base.elapsed().as_millis() as u64;
        assert!(expired_at >= idle_at + 40, "idle at {idle_at} ms, expired by {expired_at} ms");
        watch.busy();
        assert!(!watch.expired(), "a head that arrives as it expires is read");
    }
}
