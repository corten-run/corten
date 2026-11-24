//! MEASUREMENT VARIANT V3 (not the change): a deadline is a time stored in its connection's
//! watch, which the server's clock thread expires at its tick (`crate::watch`), so a request
//! under `serve` touches no tokio timer. A request with no watch at hand makes a tokio timer.

use crate::watch::Watch;
use std::{
    cell::Cell,
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::time::Sleep;

thread_local! {
    /// The watch of the connection being polled on this thread.
    static WATCH: Cell<Option<Arc<Watch>>> = const { Cell::new(None) };
}

pin_project_lite::pin_project! {
    pub(crate) struct Keeps<C> {
        #[pin]
        conn: C,
        watch: Option<Arc<Watch>>,
    }
}

impl<C> Keeps<C> {
    pub(crate) fn with(conn: C, watch: Option<Arc<Watch>>) -> Self {
        Keeps { conn, watch }
    }

    pub(crate) fn conn(self: Pin<&mut Self>) -> Pin<&mut C> {
        self.project().conn
    }
}

struct Lent<'a>(&'a mut Option<Arc<Watch>>, Option<Arc<Watch>>);

impl Drop for Lent<'_> {
    fn drop(&mut self) {
        *self.0 = WATCH.replace(self.1.take());
    }
}

impl<C: Future> Future for Keeps<C> {
    type Output = C::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<C::Output> {
        let this = self.project();
        let before = WATCH.replace(this.watch.take());
        let _lent = Lent(this.watch, before);
        this.conn.poll(cx)
    }
}

/// A deadline stored in a watch, cleared when dropped.
pub(crate) struct Swept(Arc<Watch>);

impl Drop for Swept {
    fn drop(&mut self) {
        self.0.not_due();
    }
}

pin_project_lite::pin_project! {
    #[project = Waiting]
    pub(crate) enum Timer {
        Unset,
        Swept { swept: Swept },
        Own { #[pin] timer: Sleep },
    }
}

impl Timer {
    #[cfg(test)]
    pub(crate) fn is_kept(&self) -> bool {
        matches!(self, Timer::Swept { .. })
    }

    pub(crate) fn poll(mut self: Pin<&mut Self>, limit: Duration, cx: &mut Context<'_>) -> Poll<()> {
        if let Waiting::Unset = self.as_mut().project() {
            let watch = WATCH.with(|cell| {
                let watch = cell.take();
                let own = watch.clone();
                cell.set(watch);
                own
            });
            let timer = match watch {
                Some(watch) => {
                    watch.due_in(limit);
                    Timer::Swept { swept: Swept(watch) }
                }
                None => Timer::Own { timer: tokio::time::sleep(limit) },
            };
            self.set(timer);
        }
        match self.project() {
            Waiting::Swept { swept } => swept.0.poll_late(cx),
            Waiting::Own { timer } => timer.poll(cx),
            Waiting::Unset => unreachable!("set above"),
        }
    }
}
