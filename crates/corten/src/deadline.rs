//! The timer a request's deadline waits on ([`crate::App::deadline`]). A request whose handler
//! waits needs one, and on tokio's multi-threaded runtime a timer made and a timer dropped each
//! take the one lock of the runtime's timer wheel, where the threads serving such requests
//! queue. So a connection [`crate::serve`] accepted keeps one timer for its requests once two of
//! them have waited: each deadline after those moves it later (`Sleep::reset`, which takes no
//! lock while the timer is still set and the new time is not earlier) and gives it back still
//! set.
//!
//! The connection's task owns the timer ([`Keeps`]): it makes it in its own poll, so the timer is
//! of the runtime that polls the connection, and the timer is dropped with the connection. A
//! thread has it only while it polls that connection ([`TIMER`]), which is where a request's
//! deadline finds it. A deadline that finds none (the connection's first two to wait, a second
//! one in the same request, a request polled anywhere else: a router served another way, a call
//! a layer moved to another task) makes its own timer and drops it, as every deadline did.
//!
//! The connection makes its timer at its second request to wait, not its first, so that one
//! whose only request waits (a proxy that opens a connection for each request) makes none: a
//! timer no later request used cost that request more than any other the change touches.

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
/// A connection none of whose deadlines has waited is being polled.
const UNNAMED: u64 = 1;
/// A connection one of whose deadlines has waited, in an earlier poll, is being polled.
const WAITED: u64 = 2;
/// Either of those, and a deadline has waited during this poll.
const ASKED: u64 = 3;
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
    /// How many deadlines have taken a connection's timer on this thread.
    pub(crate) static TAKEN: Cell<usize> = const { Cell::new(0) };
    /// Releases a test request once its deadline's wait has counted towards making the timer.
    pub(crate) static WAITED_POLL: Cell<Option<tokio::sync::oneshot::Sender<()>>> = const { Cell::new(None) };
}

/// The least of [`NAMES`] as each connection that made a timer found it, which is the first
/// number any connection of this process was given: read before every number is taken, and the
/// first to be taken was read before any was.
#[cfg(test)]
static FIRST: AtomicU64 = AtomicU64::new(u64::MAX);

/// Whether the first number a connection of this process was given is above every value that
/// says how many of a connection's deadlines have waited, for a test; `None` before any
/// connection has made a timer.
#[cfg(test)]
pub(crate) fn first_number_is_no_state() -> Option<bool> {
    let first = FIRST.load(Relaxed);
    (first != u64::MAX).then_some(first > ASKED)
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
        mine: Mine,
    }
}

/// What a connection has for its requests' deadlines.
struct Mine {
    /// [`UNNAMED`] until a deadline of the connection's has waited, [`WAITED`] until a second
    /// has, in a later poll, then the connection's own number, so a timer goes back only to the
    /// connection that made it.
    id: u64,
    /// The timer, made once: `None` before, while a deadline has it across polls, and for good
    /// if that deadline was dropped somewhere else. While the connection is polled, what the
    /// thread had in its own place is here.
    timer: Option<Held>,
}

impl<C> Keeps<C> {
    pub(crate) fn new(conn: C) -> Self {
        Keeps { conn, mine: Mine { id: UNNAMED, timer: None } }
    }

    /// The connection itself, for what is not a poll (its graceful shutdown).
    pub(crate) fn conn(self: Pin<&mut Self>) -> Pin<&mut C> {
        self.project().conn
    }

    /// When the timer the connection has is set to fire, for a test.
    #[cfg(test)]
    pub(crate) fn kept_until(&self) -> Option<Instant> {
        self.mine.timer.as_ref().map(|timer| timer.0.deadline())
    }
}

/// Puts back what the thread had when the connection's poll ends, also when it panics: a
/// connection can be polled inside another's poll (a handler that blocks on another runtime).
struct Polling<'a> {
    by: u64,
    mine: &'a mut Mine,
}

impl Drop for Polling<'_> {
    #[inline(always)]
    fn drop(&mut self) {
        // The thread still says whose poll this was: a connection that had a number then had lent
        // its timer.
        if BY.replace(self.by) > ASKED {
            swap(&mut self.mine.timer);
        }
    }
}

/// Swaps the thread's timer and the one in `place`. Not where the thread is ending, as
/// [`Kept`]'s drop: this runs in [`Polling`]'s drop, where a panic during another would abort.
#[inline(always)]
fn swap(place: &mut Option<Held>) {
    let _ = TIMER.try_with(|thread| thread.swap(Cell::from_mut(place)));
}

impl<C: Future> Future for Keeps<C> {
    type Output = C::Output;

    // Written for what a poll costs a connection that has made no timer, which is every
    // connection fewer than two of whose requests have waited: 17 instructions (callgrind,
    // keep-alive requests over TCP: this function's 386 a poll against 369 for the connection's
    // own poll without it). The connection itself is polled in one place, here, so its poll is
    // compiled into its one caller, which is this function (`serve_listener` polls the wrapper
    // at three places: while it serves, to close now when the server is gone, and to drain at
    // a shutdown). [`Polling`] owns nothing to drop and reads what it lent from the
    // thread, so putting the thread back is compiled in here too. One that has made its timer
    // lends it and takes it back in every poll, whatever it is serving: a request that does not
    // wait then costs about 25 instructions more. A timer left set costs every connection of
    // its runtime: about 190 instructions each time the runtime's driver parks, as a timer of
    // the app's own does (`docs/design.md#choice-deadline-timer`, cost 1).
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<C::Output> {
        let this = self.project();
        // A connection that has made no timer tells the thread only how many of its deadlines
        // have waited, none or one.
        let polling = Polling { by: BY.replace(this.mine.id), mine: this.mine };
        if polling.mine.id > ASKED {
            swap(&mut polling.mine.timer);
        }
        let polled = this.conn.poll(cx);
        #[cfg(test)]
        let waited = WAITED_POLL.try_with(Cell::take).ok().flatten();
        if BY.get() == ASKED && polled.is_pending() {
            *polling.mine = asked(polling.mine.id);
            #[cfg(test)]
            if let Some(waited) = waited {
                let _ = waited.send(());
            }
        }
        polled
    }
}

/// What a connection with no timer has after a poll in which a deadline of its waited. The first
/// such poll leaves it [`WAITED`] and no timer: a connection whose only request waits makes none.
/// The second gives it its number and its timer, not yet set: made in the connection's own poll,
/// so the timer is of the runtime that polls the connection, whatever its handler had entered
/// when its deadline asked. A deadline asks only once it has made a timer of its own
/// ([`Timer::poll`]), so where there is no clock to make one on, the handler's catch has the
/// panic, as it always had. That leaves a handler that made its timer on a runtime it had
/// entered, on a connection whose own runtime has no clock: the connection then has its number
/// and no timer, and its deadlines go on making their own.
#[cold]
fn asked(id: u64) -> Mine {
    if id == UNNAMED {
        return Mine { id: WAITED, timer: None };
    }
    let timer = std::panic::catch_unwind(|| Box::pin(tokio::time::sleep(Duration::MAX))).ok().map(Held);
    #[cfg(test)]
    LIVE.with(|live| live.set(live.get() + isize::from(timer.is_some())));
    #[cfg(test)]
    FIRST.fetch_min(NAMES.load(Relaxed), Relaxed);
    Mine { id: NAMES.fetch_add(1, Relaxed), timer }
}

/// A connection's timer while a deadline has it. Dropped where its connection is being polled, it
/// goes back to the connection still set, and the next deadline moves it later; dropped anywhere
/// else, the timer is dropped. It keeps the waker of whatever polled it last: the connection's
/// task as a rule, but a handler that polls its request another way (it blocks on a runtime of its
/// own, or a layer polls through a `FuturesUnordered`) leaves that waker, and what the waker
/// holds, until the next deadline polls the timer or the timer fires. A timer no deadline takes
/// before it fires wakes that once, for nothing.
pub(crate) struct Kept {
    of: u64,
    /// `None` only once it is dropped.
    timer: Option<Held>,
}

impl Kept {
    /// The timer of the connection being polled, set to fire `limit` from now. `None` where no
    /// connection is being polled, or its timer is not there: not made yet, another deadline has
    /// it, or the thread is ending and its place for one is gone.
    fn take(limit: Duration) -> Option<Kept> {
        let of = BY.get();
        if of <= ASKED {
            return None;
        }
        let mut timer = TIMER.try_with(Cell::take).ok()??;
        timer.0.as_mut().reset(after(limit));
        #[cfg(test)]
        TAKEN.with(|taken| taken.set(taken.get() + 1));
        Some(Kept { of, timer: Some(timer) })
    }
}

/// Tells the connection being polled, if it has made no timer, that a deadline of its has waited
/// and made its own: at the second poll that ends so, the connection makes its timer, for its
/// next deadline.
#[inline]
fn ask() {
    if matches!(BY.get(), UNNAMED | WAITED) {
        BY.set(ASKED);
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
                None => {
                    let timer = tokio::time::sleep(limit);
                    // After the timer is made, which panics on a runtime with no clock.
                    ask();
                    Timer::Own { timer }
                }
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
