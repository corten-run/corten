
/// Scratch, not the repository's: what a connection's timer does when its time comes with no
/// deadline having it (the connection is idle, or serves requests that do not wait). Printed, and
/// held: the connection's waker is woken once, at the timer's time and not before, and never again
/// while no deadline takes the timer.
#[tokio::test(start_paused = true)]
async fn c3_a_timer_left_set_wakes_its_connection_once_when_its_time_comes() {
    use crate::deadline::{Keeps, Timer};
    use std::{
        future::Future,
        pin::pin,
        sync::atomic::{AtomicUsize, Ordering::Relaxed},
        task::Poll,
    };
    struct Woken(AtomicUsize);
    impl std::task::Wake for Woken {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Relaxed);
        }
    }
    let limit = Duration::from_secs(30);
    let woken = Arc::new(Woken(AtomicUsize::new(0)));
    let waits = std::cell::Cell::new(3);
    let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
        if waits.get() > 0 {
            waits.set(waits.get() - 1);
            let mut timer = pin!(Timer::Unset);
            assert!(timer.as_mut().poll(limit, cx).is_pending());
            println!("C3 a deadline waited: on the connection's timer {}", timer.is_kept());
        }
        Poll::<()>::Pending
    })));
    let waker = std::task::Waker::from(woken.clone());
    let mut cx = std::task::Context::from_waker(&waker);
    let start = tokio::time::Instant::now();
    for _ in 0..3 {
        assert!(conn.as_mut().poll(&mut cx).is_pending());
    }
    println!("C3 after three waits: set to fire in {:?}, woken {}", conn.kept_until().map(|at| at - start), woken.0.load(Relaxed));
    tokio::time::advance(limit - Duration::from_millis(2)).await;
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
    println!("C3 at {:?}: woken {}", start.elapsed(), woken.0.load(Relaxed));
    assert_eq!(woken.0.load(Relaxed), 0);
    tokio::time::advance(Duration::from_millis(4)).await;
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
    println!("C3 at {:?}: woken {}", start.elapsed(), woken.0.load(Relaxed));
    assert_eq!(woken.0.load(Relaxed), 1);
    for _ in 0..5 {
        assert!(conn.as_mut().poll(&mut cx).is_pending());
    }
    tokio::time::advance(limit * 3).await;
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
    println!("C3 at {:?}, after five polls with no deadline: woken {}, still set for {:?}", start.elapsed(), woken.0.load(Relaxed), conn.kept_until().map(|at| at - start));
    assert_eq!(woken.0.load(Relaxed), 1);
    // The next deadline to wait takes the timer again and sets it from now.
    waits.set(1);
    assert!(conn.as_mut().poll(&mut cx).is_pending());
    println!("C3 a fourth wait: set to fire at {:?}", conn.kept_until().map(|at| at - start));
    assert_eq!(conn.kept_until(), Some(tokio::time::Instant::now() + limit));
}
