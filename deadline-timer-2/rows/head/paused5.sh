#!/usr/bin/env bash
# Runs on the build host: what tokio's paused clock does with a served connection left open, on
# the form that makes a connection's timer at its second request to wait: after one, two and three
# requests of 40 ms under a 300 ms deadline, then idle. Scratch tests added to a copy of the tree
# only (paused3.sh of the tag evidence/deadline-timer counted the form as first built).
# Usage: paused5.sh <tree>
set -uo pipefail
tree=$1
cd /root/dl
rm -rf p0 && cp -r "$tree" p0
cat >> p0/crates/corten/src/tests/server.rs <<'EOF'

async fn scratch_paused_clock(requests: usize) {
    let (told, _heard) = tokio::sync::mpsc::unbounded_channel();
    let (addr, _stop, _server) = listening(waiting(told)).await;
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    let began = tokio::time::Instant::now();
    for n in 1..=requests {
        assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
        println!("paused clock, {requests} requests: at {:?} after request {n}, timers kept {}", began.elapsed(), timers());
    }
    for round in 1..=3 {
        let (tx, rx) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let _ = tx.send(());
        });
        rx.await.unwrap();
        println!("paused clock, {requests} requests: at {:?} after idle round {round}", began.elapsed());
    }
}

#[tokio::test(start_paused = true)]
async fn scratch_paused_clock_1() {
    scratch_paused_clock(1).await;
}

#[tokio::test(start_paused = true)]
async fn scratch_paused_clock_2() {
    scratch_paused_clock(2).await;
}

#[tokio::test(start_paused = true)]
async fn scratch_paused_clock_3() {
    scratch_paused_clock(3).await;
}
EOF
: > paused5.log
docker run --rm -v "/root/dl/p0:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-p0:/target" \
    -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
    cargo test -p corten-run --all-features --lib -- --nocapture --test-threads 1 tests::server::scratch_paused_clock > paused5.out 2>&1
grep -E "paused clock|test result|panicked|^error" paused5.out >> paused5.log
echo "PAUSED5-DONE" >> paused5.log
