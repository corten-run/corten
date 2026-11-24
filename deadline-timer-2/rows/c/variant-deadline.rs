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
    mem::ManuallyDrop,
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
pub(crate) struct Slot(Mutex<Place>);

/// Scratch variant, not committed. `false`: a connection's first deadline to wait waits on a timer
/// of its own and leaves the connection one that is not set yet, for the next. `true`: the first
/// leaves only a mark, and the second makes the connection's timer and waits on it.
const TWO_STAGE: bool = false;

enum Place {
    /// No deadline of the connection's has waited.
    Never,
    /// One has (`TWO_STAGE`), on a timer of its own.
    Waited,
    /// A deadline has the timer, or the connection keeps none any more.
    Out,
    Here(Held),
}

enum Take {
    Timer(Held),
    /// The deadline makes the connection's timer and waits on it.
    Make,
    /// The deadline waits on its own and leaves the connection one that is not set.
    Leave,
    Own,
}

impl Slot {
    pub(crate) const fn new() -> Slot {
        Slot(Mutex::new(Place::Never))
    }

    /// Nothing panics while the lock is held, and a deadline's drop is no place to find out.
    fn place(&self) -> MutexGuard<'_, Place> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn take(&self) -> Take {
        let mut place = self.place();
        match std::mem::replace(&mut *place, Place::Out) {
            Place::Here(timer) => Take::Timer(timer),
            Place::Never if TWO_STAGE => {
                *place = Place::Waited;
                Take::Own
            }
            Place::Never => Take::Leave,
            Place::Waited => Take::Make,
            Place::Out => Take::Own,
        }
    }

    /// Keeps `timer`, or drops it where the connection has one already.
    fn give(&self, timer: Held) {
        let mut place = self.place();
        if !matches!(*place, Place::Here(_)) {
            *place = Place::Here(timer);
        }
    }

    /// Drops the timer: the connection has switched and serves no more requests.
    pub(crate) fn empty(&self) {
        let gone = std::mem::replace(&mut *self.place(), Place::Out);
        drop(gone);
    }

    /// When the timer kept here is set to fire, for a test.
    #[cfg(test)]
    pub(crate) fn until(&self) -> Option<Instant> {
        match &*self.place() {
            Place::Here(timer) => Some(timer.0.deadline()),
            _ => None,
        }
    }
}

thread_local! {
    /// What polls the request being polled on this thread: the address its waker wakes, which is
    /// the connection's task's for a deadline that task polls itself. 0 where no request is.
    static BY: Cell<usize> = const { Cell::new(0) };
    /// The watch of the connection whose request is being polled on this thread. The thread never
    /// drops it, so reading it costs a request no check of whether the thread is ending: a watch
    /// is here only during a poll, and [`Lent`] takes it back when the poll ends.
    static LENT: Cell<ManuallyDrop<Option<Arc<Watch>>>> = const { Cell::new(ManuallyDrop::new(None)) };
}

/// A connection's watch, for a request's answer to lend to the thread while it polls the
/// request.
pub(crate) struct Lends {
    /// While the watch is lent, what the thread had before.
    by: usize,
    /// The watch; while it is lent, what the thread had before.
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
        self.by = BY.replace(cx.waker().data().addr());
        swap(&mut self.watch);
        Some(Lent(self))
    }
}

/// A watch on the thread ([`Lends::lend`]).
pub(crate) struct Lent<'a>(&'a mut Lends);

impl Drop for Lent<'_> {
    #[inline]
    fn drop(&mut self) {
        BY.set(self.0.by);
        swap(&mut self.0.watch);
    }
}

/// Swaps the watch the thread is lent and `watch`.
#[inline(always)]
fn swap(watch: &mut Option<Arc<Watch>>) {
    let lent = LENT.replace(ManuallyDrop::new(watch.take()));
    *watch = ManuallyDrop::into_inner(lent);
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
        if BY.get() != cx.waker().data().addr() {
            return None;
        }
        let lent = LENT.replace(ManuallyDrop::new(None));
        let of: Option<Arc<Watch>> = (*lent).clone();
        LENT.set(lent);
        let of = of?;
        let timer = match of.kept.take() {
            Take::Timer(mut timer) => {
                timer.0.as_mut().reset(after(limit));
                #[cfg(test)]
                TAKEN.with(|taken| taken.set(taken.get() + 1));
                timer
            }
            Take::Make => Held::new(limit),
            Take::Leave => {
                // Made outside the lock: it panics where there is no clock, in the handler's catch.
                of.kept.give(Held::new(Duration::MAX));
                return None;
            }
            Take::Own => return None,
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
