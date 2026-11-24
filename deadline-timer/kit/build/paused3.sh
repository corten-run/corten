#!/usr/bin/env bash
# Runs on the build host, after paused2.sh, on the copy of the merged head only: whether the
# connection has its timer while the paused clock stands still, and what the paused clock does for a
# timer set the same way with no server in the picture.
set -uo pipefail
cd /root/dl
cat >> p-head/crates/corten/src/tests/server.rs <<'EOF'

#[tokio::test(start_paused = true)]
async fn scratch_paused_clock_with_the_timer_counted() {
    let (told, _heard) = tokio::sync::mpsc::unbounded_channel();
    let (addr, _stop, _server) = listening(waiting(told)).await;
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    let began = tokio::time::Instant::now();
    for n in 1..=3 {
        assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
        println!("counted: clock at {:?} after request {n}, timers kept {}", began.elapsed(), crate::deadline::LIVE.with(std::cell::Cell::get));
    }
    for round in 1..=3 {
        let (tx, rx) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let _ = tx.send(());
        });
        rx.await.unwrap();
        println!("counted: clock at {:?} after idle round {round}", began.elapsed());
    }
}

#[tokio::test(start_paused = true)]
async fn scratch_paused_clock_with_a_bare_timer() {
    let began = tokio::time::Instant::now();
    let holder = tokio::spawn(async move {
        let mut timer = Box::pin(tokio::time::sleep(Duration::MAX));
        timer.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(300));
        std::future::poll_fn(|cx| {
            let _ = timer.as_mut().poll(cx);
            std::task::Poll::<()>::Pending
        })
        .await;
    });
    tokio::task::yield_now().await;
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        let _ = tx.send(());
    });
    rx.await.unwrap();
    println!("bare: clock at {:?} after 100 ms with a timer set 300 ms off in another task", began.elapsed());
    holder.abort();
}
EOF
: > paused3.log
docker run --rm -v "/root/dl/p-head:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-head:/target" \
    -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
    cargo test -p corten-run --all-features --lib -- --nocapture --test-threads 1 tests::server::scratch_paused_clock_with 2>&1 \
    | grep -E "counted:|bare:|test result|panicked|error" >> paused3.log
echo "PAUSED3-DONE" >> paused3.log
