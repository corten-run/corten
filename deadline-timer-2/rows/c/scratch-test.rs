
/// Scratch, never committed: what form C does when a deadline is polled by its connection's own
/// task under another runtime's `EnterGuard`, and when that runtime is then shut down.
#[test]
fn scratch_a_timer_made_under_another_runtimes_guard() {
    use crate::deadline::Timer;
    use std::{future::Future, panic::AssertUnwindSafe, pin::pin, task::Poll};
    let other = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_time().build().unwrap();
    let handle = other.handle().clone();
    let serving = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
    let limit = Duration::from_millis(50);
    serving.block_on(Lending::new(async move {
        let mut other = Some(other);
        let began = tokio::time::Instant::now();
        let kept = {
            let mut timer = pin!(Timer::Unset);
            std::future::poll_fn(|cx| {
                let _guard = handle.enter();
                timer.as_mut().poll(limit, cx).map(|()| timer.is_kept())
            })
            .await
        };
        println!("SCRATCH 1 under the guard: kept={kept} fired after {:?} timers={} taken={}", began.elapsed(), timers(), taken());
        let (fired, kept) = request(limit, None).await;
        println!("SCRATCH 2 no guard, other runtime alive: kept={kept} fired={fired:?} timers={} taken={}", timers(), taken());
        other.take().unwrap().shutdown_background();
        tokio::time::sleep(Duration::from_millis(200)).await;
        for n in 3..=4 {
            let mut timer = pin!(Timer::Unset);
            let began = tokio::time::Instant::now();
            let polled = std::future::poll_fn(|cx| match std::panic::catch_unwind(AssertUnwindSafe(|| timer.as_mut().poll(limit, cx))) {
                Ok(Poll::Ready(())) => Poll::Ready(format!("fired after {:?}", began.elapsed())),
                Ok(Poll::Pending) => Poll::Pending,
                Err(_) => Poll::Ready("panicked".to_string()),
            });
            let out = tokio::time::timeout(Duration::from_secs(2), polled).await.unwrap_or_else(|_| "never fired in 2 s".to_string());
            println!("SCRATCH {n} no guard, other runtime shut down: kept={} {out} timers={} taken={}", timer.is_kept(), timers(), taken());
        }
    }));
}
