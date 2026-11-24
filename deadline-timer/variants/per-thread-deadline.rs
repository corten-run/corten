//! MEASUREMENT VARIANT V2 (not the change): a deadline's timer kept by the thread, as the
//! prototype did, with the runtime's id checked so a thread never resets another runtime's
//! timer. `Keeps` does nothing here.

use std::{
    cell::RefCell,
    future::Future,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tokio::time::{Instant, Sleep};

type Pool = (Option<tokio::runtime::Id>, Vec<Pin<Box<Sleep>>>);

thread_local! {
    /// The runtime this thread last waited on, and timers of it earlier requests were done with.
    static KEPT: RefCell<Pool> = const { RefCell::new((None, Vec::new())) };
}

pin_project_lite::pin_project! {
    pub(crate) struct Keeps<C> {
        #[pin]
        conn: C,
    }
}

impl<C> Keeps<C> {
    pub(crate) fn new(conn: C) -> Self {
        Keeps { conn }
    }

    pub(crate) fn conn(self: Pin<&mut Self>) -> Pin<&mut C> {
        self.project().conn
    }
}

impl<C: Future> Future for Keeps<C> {
    type Output = C::Output;

    #[inline]
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<C::Output> {
        self.project().conn.poll(cx)
    }
}

pub(crate) struct Kept {
    of: tokio::runtime::Id,
    timer: Option<Pin<Box<Sleep>>>,
}

impl Kept {
    fn take(limit: Duration) -> Kept {
        let of = tokio::runtime::Handle::current().id();
        let until = after(limit);
        let kept = KEPT.with_borrow_mut(|(runtime, timers)| {
            if *runtime != Some(of) {
                timers.clear();
                *runtime = Some(of);
            }
            timers.pop()
        });
        let timer = match kept {
            Some(mut timer) => {
                timer.as_mut().reset(until);
                timer
            }
            None => Box::pin(tokio::time::sleep_until(until)),
        };
        Kept { of, timer: Some(timer) }
    }
}

impl Drop for Kept {
    fn drop(&mut self) {
        let Some(mut timer) = self.timer.take() else { return };
        // The timer lets go of the request's waker, so firing unused wakes nothing.
        let _ = timer.as_mut().poll(&mut Context::from_waker(std::task::Waker::noop()));
        let _ = KEPT.try_with(|kept| {
            let (runtime, timers) = &mut *kept.borrow_mut();
            if *runtime == Some(self.of) && timers.len() < 4096 {
                timers.push(timer);
            }
        });
    }
}

pub(crate) enum Timer {
    Unset,
    Kept { kept: Kept },
}

impl Timer {
    #[cfg(test)]
    pub(crate) fn is_kept(&self) -> bool {
        matches!(self, Timer::Kept { .. })
    }

    pub(crate) fn poll(mut self: Pin<&mut Self>, limit: Duration, cx: &mut Context<'_>) -> Poll<()> {
        if let Timer::Unset = &*self {
            self.set(Timer::Kept { kept: Kept::take(limit) });
        }
        match &mut *self {
            Timer::Kept { kept } => kept.timer.as_mut().expect("there until dropped").as_mut().poll(cx),
            Timer::Unset => unreachable!("set above"),
        }
    }
}

fn after(limit: Duration) -> Instant {
    let now = Instant::now();
    now.checked_add(limit).unwrap_or_else(|| now + Duration::from_secs(86400 * 365 * 30))
}
