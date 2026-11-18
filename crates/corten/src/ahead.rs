//! [`Ahead`]: a read started before the handler, awaited where its value is used.

use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

/// A read started now, alongside the rest of the request, and awaited where its value is used,
/// so a page waits for the longer of it and the handler's other reads, not their sum. It is for a
/// read the page itself awaits. A value the layout shows (a cart's count) is a
/// [`crate::LayoutRead`] instead, which Corten starts and draws with no extractor: for a full load,
/// and for a write's own page once the handler has answered, not for a navigation's `<main>` nor a
/// patch. Started with `Ahead` in an extractor, such a value would be read on every write the
/// runtime sends, one that answers a patch too, and before the write, so it could miss what the
/// write did.
///
/// An extractor starts it as the request arrives, and the handler passes it on as it does the
/// viewer. It starts before the handler, so on a write it may not see what the write did: a value
/// that depends on it (the orders after one is placed) is read or given after the write, by the
/// handler, or is a [`crate::LayoutRead`], which a write's own page starts once the handler has
/// answered.
///
/// ```
/// use corten::{extract::FromRequestParts, http::{request::Parts, Method}, prelude::*, Ahead};
///
/// #[derive(Clone)]
/// struct Shop;
/// impl Shop {
///     async fn orders(&self) -> Vec<String> { vec!["A-1".into()] }
/// }
///
/// /// The viewer's orders, which the orders page lists, read as the request arrives.
/// struct Orders { list: Ahead<Option<Vec<String>>> }
///
/// impl FromRequestParts<Shop> for Orders {
///     type Rejection = std::convert::Infallible;
///
///     async fn from_request_parts(parts: &mut Parts, shop: &Shop) -> Result<Self, Self::Rejection> {
///         // A write reads its page after it writes, so the list shows what it did.
///         if parts.method != Method::GET {
///             return Ok(Orders { list: Ahead::ready(None) });
///         }
///         let shop = shop.clone();
///         Ok(Orders { list: Ahead::start(async move { Some(shop.orders().await) }) })
///     }
/// }
///
/// async fn orders(req: Req, orders: Orders) -> HtmlResult {
///     // The page's other reads run here while the orders are read.
///     let list = orders.list.await;
///     # let _ = (req, list);
///     # todo!()
/// }
/// # let _ = orders;
/// ```
///
/// It runs on a task of its own, so the read is `Send + 'static` and takes what it uses by value;
/// a read that borrows the request does not compile:
///
/// ```compile_fail,E0597
/// use corten::{http::request::Parts, Ahead};
///
/// fn start(parts: Parts) -> Ahead<usize> {
///     let path = parts.uri.path();
///     Ahead::start(async move { path.len() })
/// }
/// ```
///
/// Dropped before it is awaited (the handler answered without the layout, the client left, the
/// deadline passed), the read is cancelled. A panic in it is the handler's where it is awaited, so
/// the request fails as a panic in the handler does. It needs the Tokio runtime [`crate::serve`]
/// runs on.
///
/// It is `tokio::spawn` with what a request needs: a bare task runs on after the client left and
/// its panic is lost, and `futures::FutureExt::remote_handle` does both but needs `futures` with
/// its `channel` feature in the app and has no [`Ahead::ready`], so a page that skips the read
/// would hold a second type.
#[must_use = "a started read is cancelled when dropped: await it where its value is drawn"]
pub struct Ahead<T>(State<T>);

enum State<T> {
    Ready(Option<T>),
    Running(tokio::task::JoinHandle<T>),
}

// `T` is only ever moved out, never pinned.
impl<T> Unpin for Ahead<T> {}

impl<T: Send + 'static> Ahead<T> {
    /// Starts `read` now, on a task of its own, in the current tracing span.
    pub fn start(read: impl Future<Output = T> + Send + 'static) -> Self {
        use tracing::Instrument as _;
        Ahead(State::Running(tokio::spawn(read.in_current_span())))
    }
}

impl<T> Ahead<T> {
    /// A value already known (none to read for a navigation), awaited the same way.
    pub fn ready(value: T) -> Self {
        Ahead(State::Ready(Some(value)))
    }
}

impl<T> Future for Ahead<T> {
    type Output = T;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {
        match &mut self.get_mut().0 {
            State::Ready(value) => Poll::Ready(value.take().expect("corten: Ahead awaited after it gave its value")),
            State::Running(task) => match Pin::new(task).poll(cx) {
                Poll::Pending => Poll::Pending,
                Poll::Ready(Ok(value)) => Poll::Ready(value),
                Poll::Ready(Err(error)) => match error.try_into_panic() {
                    Ok(panic) => std::panic::resume_unwind(panic),
                    Err(_) => panic!("corten: an Ahead read was cancelled: the runtime is shutting down"),
                },
            },
        }
    }
}

impl<T> Drop for Ahead<T> {
    fn drop(&mut self) {
        if let State::Running(task) = &self.0 {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };

    use super::Ahead;

    #[tokio::test(start_paused = true)]
    async fn a_read_started_ahead_runs_alongside_the_page() {
        let started = tokio::time::Instant::now();
        let cart = Ahead::start(async {
            tokio::time::sleep(Duration::from_millis(60)).await;
            3
        });
        tokio::time::sleep(Duration::from_millis(56)).await; // the page's own reads
        assert_eq!(cart.await, 3);
        assert_eq!(started.elapsed(), Duration::from_millis(60), "the longer of the two, not their sum");
        assert_eq!(Ahead::ready(7).await, 7);
    }

    #[tokio::test(start_paused = true)]
    async fn a_read_dropped_before_it_is_awaited_is_cancelled() {
        let finished = Arc::new(AtomicBool::new(false));
        let done = finished.clone();
        let cart = Ahead::start(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            done.store(true, Ordering::SeqCst);
        });
        tokio::task::yield_now().await;
        drop(cart);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!finished.load(Ordering::SeqCst));
    }

    #[tokio::test]
    #[should_panic(expected = "the cart store")]
    async fn a_panic_in_the_read_is_the_handlers() {
        let cart: Ahead<u32> = Ahead::start(async { panic!("the cart store") });
        cart.await;
    }
}
