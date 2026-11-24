#!/usr/bin/env bash
# Runs on the build host, after paused.sh: how far tokio's paused test clock has moved after each of
# three requests whose handler sleeps 40 ms on one served connection (deadline 300 ms), and after
# the connection then sits idle 200 ms of real time, on main (with the branch's first commit's test
# helpers) and on the merged head. A test added to copies of the trees only.
set -uo pipefail
cd /root/dl
for t in p-main p-head; do
cat >> $t/crates/corten/src/tests/server.rs <<'EOF'

#[tokio::test(start_paused = true)]
async fn scratch_paused_clock_across_requests() {
    let (told, _heard) = tokio::sync::mpsc::unbounded_channel();
    let (addr, _stop, _server) = listening(waiting(told)).await;
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    let began = tokio::time::Instant::now();
    for n in 1..=3 {
        assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
        println!("paused clock at {:?} after request {n}", began.elapsed());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        let _ = tx.send(());
    });
    rx.await.unwrap();
    println!("paused clock at {:?} after the connection sat idle 200 ms", began.elapsed());
    assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
    println!("paused clock at {:?} after request 4", began.elapsed());
}
EOF
done
: > paused2.log
for t in p-main p-head; do
    echo "== $t" >> paused2.log
    docker run --rm -v "/root/dl/$t:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-head:/target" \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
        cargo test -p corten-run --all-features --lib -- --exact --nocapture tests::server::scratch_paused_clock_across_requests 2>&1 \
        | grep -E "paused clock at|test result|panicked|error" >> paused2.log
done
echo "PAUSED2-DONE" >> paused2.log
