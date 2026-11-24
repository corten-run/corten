//! The timer a request's deadline waits on ([`crate::App::deadline`]). A request whose handler
//! waits needs one, and on tokio's multi-threaded runtime a timer made and a timer dropped each
//! take the one lock of the runtime's timer wheel, where the threads serving such requests
//! queue. So a connection [`crate::serve`] accepted keeps one timer for its requests: the first
//! deadline of its to wait makes it, each deadline moves it later (`Sleep::reset`, which takes no
//! lock while the timer is still set and the new time is not earlier) and gives it back still set.
//!
//! The timer is kept in the connection's [`Watch`] ([`Slot`]), so it is dropped with the
//! connection, and a connection the app does not watch (no header timeout and no send timeout)
//! keeps none. A request's answer lends the watch to the thread while it is polled ([`Lends`]),
//! which is where the request's deadline finds it; the deadline then holds the watch itself, so
//! the timer goes back to the connection it came from, wherever the deadline is dropped. A
//! deadline that finds no watch, or is not polled by its connection's own task (a router served
//! another way, a request served on another runtime inside a handler, a call a layer moved to
//! another task or polls through a waker of its own), makes its own timer and drops it, as every
//! deadline did: the kept timer is made in a poll the connection's task made itself.

use crate::watch::Watch;
use std::{
    cell::Cell,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    task::{Context, Poll},
    time::Duration,
};
use tokio::time::{Instant, Sleep};

/// A connection's timer.
struct Held(Pin<Box<Sleep>>);

#[cfg(test)]
thread_local! {
    /// How many connections' timers this thread has made, less how many it has dropped: how many
    /// there are, where one thread does both (a test on a current-thread runtime).
    pub(crate) static LIVE: Cell<isize> = const { Cell::new(0) };
    /// How many deadlines have taken a connection's timer on this thread.
    pub(crate) static TAKEN: Cell<usize> = const { Cell::new(0) };
}

impl Held {
    /// A timer set to fire `limit` from now. Panics on a runtime with no clock, as
    /// `tokio::time::sleep` does: a deadline makes it, inside the handler's catch.
    fn new(limit: Duration) -> Held {
        let timer = Box::pin(tokio::time::sleep(limit));
        #[cfg(test)]
        LIVE.with(|live| live.set(live.get() + 1));
        Held(timer)
    }
}

#[cfg(test)]
impl Drop for Held {
    fn drop(&mut self) {
        let _ = LIVE.try_with(|live| live.set(live.get() - 1));
    }
}

/// Where a connection keeps its timer between its requests: empty until a deadline of its has
/// waited, and while a deadline has the timer. A lock, since a deadline may be dropped on any
/// thread; only the connection's own requests take it, one at a time.
pub(crate) struct Slot(Mutex<Option<Held>>);

impl Slot {
    pub(crate) const fn new() -> Slot {
        Slot(Mutex::new(None))
    }

    /// Nothing panics while the lock is held, and a deadline's drop is no place to find out.
    fn place(&self) -> MutexGuard<'_, Option<Held>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn take(&self) -> Option<Held> {
        self.place().take()
    }

    /// Keeps `timer`, or drops it where the connection has one already (a second deadline in one
    /// request made its own).
    fn give(&self, timer: Held) {
        let mut place = self.place();
        if place.is_none() {
            *place = Some(timer);
        }
    }

    /// Drops the timer: the connection has switched and serves no more requests.
    pub(crate) fn empty(&self) {
        drop(self.take());
    }

    /// When the timer kept here is set to fire, for a test.
    #[cfg(test)]
    pub(crate) fn until(&self) -> Option<Instant> {
        self.place().as_ref().map(|timer| timer.0.deadline())
    }
}

thread_local! {
    /// What the connection whose request is being polled on this thread lends it.
    static LENT: Cell<Lends> = const { Cell::new(Lends { by: 0, watch: None }) };
}

/// A connection's watch, for a request's answer to lend to the thread while it polls the
/// request, and what polled it then: the address its waker wakes, which is the connection's
/// task's for a deadline that task polls itself.
#[derive(Default)]
pub(crate) struct Lends {
    by: usize,
    watch: Option<Arc<Watch>>,
}

impl Lends {
    pub(crate) fn new(watch: Option<Arc<Watch>>) -> Lends {
        Lends { by: 0, watch }
    }

    /// The watch, once the request is answered.
    pub(crate) fn take(&mut self) -> Option<Arc<Watch>> {
        self.watch.take()
    }

    /// Lends the watch to the thread until what this returns is dropped, also by a panic; the
    /// thread then has what it had (a connection can be polled inside another's poll). Nothing
    /// where the connection has no watch.
    #[inline]
    pub(crate) fn lend(&mut self, cx: &Context<'_>) -> Option<Lent<'_>> {
        self.watch.as_ref()?;
        self.by = cx.waker().data().addr();
        swap(self);
        Some(Lent(self))
    }
}

/// A watch on the thread ([`Lends::lend`]).
pub(crate) struct Lent<'a>(&'a mut Lends);

impl Drop for Lent<'_> {
    #[inline]
    fn drop(&mut self) {
        swap(self.0);
    }
}

/// Swaps what the thread is lent and `lends`. Not where the thread is ending.
#[inline(always)]
fn swap(lends: &mut Lends) {
    let _ = LENT.try_with(|thread| thread.swap(Cell::from_mut(lends)));
}

/// A connection's timer while a deadline has it, and the connection's watch, where the timer goes
/// back, still set, when the deadline is dropped: the next deadline moves it later. It keeps the
/// waker of whatever polled it last: the connection's task where it was taken, and another only
/// if the deadline was polled somewhere else afterwards. A timer no deadline takes before it
/// fires wakes that once, for nothing.
struct Kept {
    of: Arc<Watch>,
    /// `None` only once it is dropped.
    timer: Option<Held>,
}

impl Kept {
    /// The timer of the connection whose task is polling this deadline, set to fire `limit` from
    /// now: the one the connection has, or a new one for it. `None` where no connection lends
    /// its watch, or something else polls the deadline inside that connection's poll.
    fn new(limit: Duration, cx: &Context<'_>) -> Option<Kept> {
        let of = LENT
            .try_with(|thread| {
                let lent = thread.take();
                let of = if lent.by == cx.waker().data().addr() { lent.watch.clone() } else { None };
                thread.set(lent);
                of
            })
            .ok()??;
        let timer = match of.kept.take() {
            Some(mut timer) => {
                timer.0.as_mut().reset(after(limit));
                #[cfg(test)]
                TAKEN.with(|taken| taken.set(taken.get() + 1));
                timer
            }
            None => Held::new(limit),
        };
        Some(Kept { of, timer: Some(timer) })
    }
}

impl Drop for Kept {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.take() {
            self.of.kept.give(timer);
        }
    }
}

pin_project_lite::pin_project! {
    /// What a deadline waits on: nothing until its handler waits, then its connection's timer
    /// where its connection's task polls it, or a timer of its own.
    #[project = Waiting]
    pub(crate) enum Timer {
        Unset,
        Kept { kept: Kept },
        Own { #[pin] timer: Sleep },
    }
}

impl Timer {
    /// Whether it has a timer of its connection's, for a test.
    #[cfg(test)]
    pub(crate) fn is_kept(&self) -> bool {
        matches!(self, Timer::Kept { .. })
    }

    /// Ready once `limit` has passed since the first call.
    pub(crate) fn poll(mut self: Pin<&mut Self>, limit: Duration, cx: &mut Context<'_>) -> Poll<()> {
        if let Waiting::Unset = self.as_mut().project() {
            let timer = match Kept::new(limit, cx) {
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

/// `limit` from now, and no further off than 30 years, the longest `tokio::time::sleep` waits.
fn after(limit: Duration) -> Instant {
    Instant::now() + limit.min(Duration::from_secs(86400 * 365 * 30))
}
