//! [`crate::App::header_timeout`]: how long a connection may wait for a request's head, and
//! [`crate::App::send_timeout`]: how long a write may wait for the client to take more of an
//! answer. Each connection has a [`Watch`]: busy from when hyper hands over a request's head until
//! its answer's body is dropped, otherwise the time it went idle; and the time a write found the
//! socket full, until one goes through. One thread per server ticks a coarse clock a few times a
//! second and expires the connections idle or stalled past their timeout; the connection's next
//! read or write then fails and hyper closes it. hyper's own header timer was measured
//! first: about 900 instructions a keep-alive request with a coarse timer of Corten's (1,400 with
//! tokio's), since it sets up a sleep for every head and reads once more to start it. This costs
//! about 300 (callgrind, keep-alive requests over TCP), which Corten's accept loop saved against
//! `axum::serve` when it was measured.

use crate::body::Body;
use bytes::Bytes;
use futures_util::task::AtomicWaker;
use std::{
    future::Future,
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering::Relaxed},
        Arc, Mutex, Weak,
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// A connection between a request's head and the end of its answer.
const BUSY: u64 = u64::MAX;
/// A connection idle past the timeout.
const EXPIRED: u64 = u64::MAX - 1;
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
            if since < EXPIRED
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
                watch.writer.wake();
            }
            true
        });
    }
}

/// One connection's state for its [`Clock`].
pub(crate) struct Watch {
    /// [`BUSY`], [`EXPIRED`], or the time the connection went idle.
    since: AtomicU64,
    /// How many heads have arrived, so an answer finished after the next head arrived does not
    /// mark the connection idle. Only the connection's task writes it.
    heads: AtomicU64,
    waker: AtomicWaker,
    /// [`FLOWING`], [`STALLED`], or one past the time a write found the socket full.
    stalled: AtomicU64,
    /// The task whose write is waiting.
    writer: AtomicWaker,
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

    /// The answer to `head` is done: idle from now, unless another head has arrived since.
    fn idle(&self, head: u64) {
        if self.heads.load(Relaxed) == head {
            self.since.store(self.clock.now.load(Relaxed), Relaxed);
        }
    }

    fn expired(&self) -> bool {
        self.since.load(Relaxed) == EXPIRED
    }

    /// A write's, a flush's or a close's outcome, for [`crate::App::send_timeout`]: one that waits
    /// starts the stall, or fails once the clock has expired it, so a call is failed only while
    /// the IO still has no room. A write that went through (or failed) clears it; a flush or a
    /// close does not (`clears`), since a plain socket's flush is done at once whether anything
    /// went or not, and a route on a switched connection could otherwise restart the clock with
    /// flushes while its writes wait.
    fn sent<T>(&self, written: Poll<io::Result<T>>, clears: bool, cx: &Context<'_>) -> Poll<io::Result<T>> {
        if self.clock.send == NEVER {
            return written;
        }
        if written.is_ready() {
            if clears && self.stalled.load(Relaxed) != FLOWING {
                self.stalled.store(FLOWING, Relaxed);
            }
            return written;
        }
        match self.stalled.load(Relaxed) {
            STALLED => return Poll::Ready(Err(stalled())),
            FLOWING => self.stalled.store(self.clock.now.load(Relaxed) + 1, Relaxed),
            _ => {}
        }
        self.writer.register(cx.waker());
        // Expired between the first look and the registration: its wake may have been missed.
        if self.stalled.load(Relaxed) == STALLED {
            return Poll::Ready(Err(stalled()));
        }
        Poll::Pending
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
/// fail once one has waited past the send timeout.
pub(crate) struct Watched<I> {
    pub io: I,
    pub watch: Option<Arc<Watch>>,
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

impl<I: AsyncWrite + Unpin> AsyncWrite for Watched<I> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let Some(watch) = &this.watch else {
            return Pin::new(&mut this.io).poll_write(cx, buf);
        };
        watch.sent(Pin::new(&mut this.io).poll_write(cx, buf), true, cx)
    }

    fn poll_write_vectored(self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let Some(watch) = &this.watch else {
            return Pin::new(&mut this.io).poll_write_vectored(cx, bufs);
        };
        watch.sent(Pin::new(&mut this.io).poll_write_vectored(cx, bufs), true, cx)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let Some(watch) = &this.watch else {
            return Pin::new(&mut this.io).poll_flush(cx);
        };
        watch.sent(Pin::new(&mut this.io).poll_flush(cx), false, cx)
    }

    /// Watched too: over TLS, closing writes a last record, which waits on the client as any
    /// write does.
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let Some(watch) = &this.watch else {
            return Pin::new(&mut this.io).poll_shutdown(cx);
        };
        watch.sent(Pin::new(&mut this.io).poll_shutdown(cx), false, cx)
    }
}

/// A request's answer, whose body marks its connection idle when hyper has done with it. A
/// switched connection (a 101, or a 2xx to `CONNECT`: a tunnel) stays busy: it is the route's
/// from then on.
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
            let mut io = Watched { io: Stuck, watch: Some(clock.watch()) };
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
