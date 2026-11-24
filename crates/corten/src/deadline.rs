//! The timer a request's deadline waits on ([`crate::App::deadline`]). A request whose handler
//! waits needs one, and on tokio's multi-threaded runtime a timer made and a timer dropped each
//! take the one lock of the runtime's timer wheel, where the threads serving such requests
//! queue. So a connection [`crate::serve`] accepted keeps one timer for its requests: each
//! deadline moves it later (`Sleep::reset`, which takes no lock while the timer is still set and
//! the new time is not earlier) and gives it back still set.
//!
//! The connection's task owns the timer ([`Keeps`]): it makes it in its own poll, so the timer is
//! of the runtime that polls the connection, and the timer is dropped with the connection. A
//! thread has it only while it polls that connection ([`TIMER`]), which is where a request's
//! deadline finds it. A deadline that finds none (the connection's first to wait, a second one in
//! the same request, a request polled anywhere else: a router served another way, a call a layer
//! moved to another task) makes its own timer and drops it, as every deadline did.

use std::{
    cell::Cell,
    future::Future,
    pin::Pin,
    sync::atomic::{AtomicU64, Ordering::Relaxed},
    task::{Context, Poll},
    time::Duration,
};
use tokio::time::{Instant, Sleep};

/// No connection is being polled on the thread.
const NOWHERE: u64 = 0;
/// A connection that has made no timer is being polled.
const UNNAMED: u64 = 1;
/// The same, and a deadline has waited during this poll: the connection makes its timer.
const ASKED: u64 = 2;
/// The number of the next connection to make a timer.
static NAMES: AtomicU64 = AtomicU64::new(ASKED + 1);

thread_local! {
    /// The connection being polled on this thread: its number once it has made a timer, or one
    /// of the values above.
    static BY: Cell<u64> = const { Cell::new(NOWHERE) };
    /// That connection's timer, while the connection has a number and no deadline has the timer.
    static TIMER: Cell<Option<Held>> = const { Cell::new(None) };
}

/// A connection's timer.
struct Held(Pin<Box<Sleep>>);

#[cfg(test)]
thread_local! {
    /// How many connections' timers this thread has made, less how many it has dropped: how many
    /// there are, where one thread does both (a test on a current-thread runtime).
    pub(crate) static LIVE: Cell<isize> = const { Cell::new(0) };
}

#[cfg(test)]
impl Drop for Held {
    fn drop(&mut self) {
        let _ = LIVE.try_with(|live| live.set(live.get() - 1));
    }
}

pin_project_lite::pin_project! {
    /// A connection's future with the timer its requests' deadlines wait on, lent to the thread
    /// while the connection is polled.
    pub(crate) struct Keeps<C> {
        #[pin]
        conn: C,
        // [`UNNAMED`] until a deadline of the connection's has waited, then the connection's own
        // number, so a timer goes back only to the connection that made it.
        id: u64,
        // The timer, made once: `None` before, while a deadline has it across polls, and for
        // good if that deadline was dropped somewhere else.
        timer: Option<Held>,
    }
}

impl<C> Keeps<C> {
    pub(crate) fn new(conn: C) -> Self {
        Keeps { conn, id: UNNAMED, timer: None }
    }

    /// The connection itself, for what is not a poll (its graceful shutdown).
    pub(crate) fn conn(self: Pin<&mut Self>) -> Pin<&mut C> {
        self.project().conn
    }

    /// When the timer the connection has is set to fire, for a test.
    #[cfg(test)]
    pub(crate) fn kept_until(&self) -> Option<Instant> {
        self.timer.as_ref().map(|timer| timer.0.deadline())
    }
}

/// Puts back what the thread had when the connection's poll ends, also when it panics: a
/// connection can be polled inside another's poll (a handler that blocks on another runtime).
struct Polling<'a> {
    by: u64,
    /// Where the connection's timer goes back to, and what the thread had in its place.
    lent: Option<(&'a mut Option<Held>, Option<Held>)>,
}

impl Drop for Polling<'_> {
    fn drop(&mut self) {
        BY.set(self.by);
        if let Some((home, before)) = self.lent.take() {
            *home = TIMER.replace(before);
        }
    }
}

impl<C: Future> Future for Keeps<C> {
    type Output = C::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<C::Output> {
        let this = self.project();
        if *this.id == UNNAMED {
            // No deadline of this connection's has waited: all the thread is told is that, so a
            // connection whose handlers never wait pays only for this.
            let polling = Polling { by: BY.replace(UNNAMED), lent: None };
            let polled = this.conn.poll(cx);
            if BY.get() == ASKED {
                (*this.id, *this.timer) = made();
            }
            drop(polling);
            return polled;
        }
        let by = BY.replace(*this.id);
        let before = TIMER.replace(this.timer.take());
        let _polling = Polling { by, lent: Some((this.timer, before)) };
        this.conn.poll(cx)
    }
}

/// A connection's number and its timer, not yet set: made in the connection's own poll, so the
/// timer is of the runtime that polls the connection, whatever its handler had entered when its
/// deadline asked.
#[cold]
fn made() -> (u64, Option<Held>) {
    #[cfg(test)]
    LIVE.with(|live| live.set(live.get() + 1));
    (NAMES.fetch_add(1, Relaxed), Some(Held(Box::pin(tokio::time::sleep(Duration::MAX)))))
}

/// A connection's timer while a deadline has it. Dropped where its connection is being polled, it
/// goes back to the connection still set, and the next deadline moves it later; dropped anywhere
/// else, the timer is dropped. Its waker stays the last deadline's, so a timer no deadline takes
/// before it fires wakes that request's task, the connection's, once for nothing.
pub(crate) struct Kept {
    of: u64,
    /// `None` only once it is dropped.
    timer: Option<Held>,
}

impl Kept {
    /// The timer of the connection being polled, set to fire `limit` from now. `None` where no
    /// connection is being polled, or its timer is not there: not made yet (the connection then
    /// makes it, for its next deadline), or another deadline has it.
    fn take(limit: Duration) -> Option<Kept> {
        let of = BY.get();
        if of <= ASKED {
            if of == UNNAMED {
                BY.set(ASKED);
            }
            return None;
        }
        let mut timer = TIMER.take()?;
        timer.0.as_mut().reset(after(limit));
        Some(Kept { of, timer: Some(timer) })
    }
}

impl Drop for Kept {
    fn drop(&mut self) {
        // Not where the thread is ending, when what it was lent is gone.
        if BY.try_with(Cell::get) == Ok(self.of) {
            let _ = TIMER.try_with(|home| home.set(self.timer.take()));
        }
    }
}

pin_project_lite::pin_project! {
    /// What a deadline waits on: nothing until its handler waits, then its connection's timer
    /// where there is one to take, or a timer of its own.
    #[project = Waiting]
    pub(crate) enum Timer {
        Unset,
        Kept { kept: Kept },
        Own { #[pin] timer: Sleep },
    }
}

impl Timer {
    /// Whether it has its connection's timer, for a test.
    #[cfg(test)]
    pub(crate) fn is_kept(&self) -> bool {
        matches!(self, Timer::Kept { .. })
    }

    /// Ready once `limit` has passed since the first call.
    pub(crate) fn poll(mut self: Pin<&mut Self>, limit: Duration, cx: &mut Context<'_>) -> Poll<()> {
        if let Waiting::Unset = self.as_mut().project() {
            let timer = match Kept::take(limit) {
                Some(kept) => Timer::Kept { kept },
                None => Timer::Own { timer: tokio::time::sleep(limit) },
            };
            self.set(timer);
        }
        match self.project() {
            Waiting::Kept { kept } => kept.timer.as_mut().expect("there until dropped").0.as_mut().poll(cx),
            Waiting::Own { timer } => timer.poll(cx),
            Waiting::Unset => unreachable!("set above"),
        }
    }
}

/// `limit` from now, as `tokio::time::sleep` counts it: a time too far to add is 30 years off.
fn after(limit: Duration) -> Instant {
    let now = Instant::now();
    now.checked_add(limit).unwrap_or_else(|| now + Duration::from_secs(86400 * 365 * 30))
}
