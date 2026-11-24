#!/usr/bin/env bash
# Runs on the build host, after m-run.sh: what tokio's paused test clock does while a served
# connection sits idle after requests that waited, on main (with the branch's first commit's test
# helpers) and on the merged head. A test added to copies of the trees only.
set -uo pipefail
cd /root/dl
until grep -q "ALL-DONE" status.log 2>/dev/null; do sleep 10; done
rm -rf p-main p-head && cp -r main p-main && cp -r head p-head
(cd p-main && git init -q . && git apply --whitespace=nowarn /root/dl/tests-base.patch) || { echo "PAUSED-FAILED patch"; exit 1; }
for t in p-main p-head; do
cat >> $t/crates/corten/src/tests/server.rs <<'EOF'

#[tokio::test(start_paused = true)]
async fn scratch_paused_clock_between_requests() {
    let (told, _heard) = tokio::sync::mpsc::unbounded_channel();
    let (addr, _stop, _server) = listening(waiting(told)).await;
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    for _ in 0..3 {
        assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
    }
    let before = tokio::time::Instant::now();
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        let _ = tx.send(());
    });
    rx.await.unwrap();
    println!("paused clock moved {:?} while the connection sat idle 200 ms", before.elapsed());
}
EOF
done
: > paused.log
for t in p-main p-head; do
    echo "== $t" >> paused.log
    docker run --rm -v "/root/dl/$t:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-head:/target" \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
        cargo test -p corten-run --all-features --lib -- --exact --nocapture tests::server::scratch_paused_clock_between_requests 2>&1 \
        | grep -E "paused clock moved|test result|panicked|error" >> paused.log
done
echo "PAUSED-DONE" >> paused.log
