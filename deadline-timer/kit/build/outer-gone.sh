#!/usr/bin/env bash
# Runs on the build host, after mut.sh: what a deadline does that took its connection's timer while
# its handler had entered another runtime, once the connection's own runtime has shut down. A test
# added to a copy of the tree only. Usage: outer-gone.sh <patch over the merged head>
set -uo pipefail
patch=$1
cd /root/dl
until grep -q "MUT-DONE" mut.log 2>/dev/null; do sleep 10; done
rm -rf og && cp -r head og
(cd og && git init -q . 2>/dev/null; git apply --whitespace=nowarn "/root/dl/$patch") || { echo "OG-FAILED patch" > outer-gone.log; exit 1; }
cat >> og/crates/corten/src/tests/server.rs <<'EOF'

#[test]
fn scratch_a_kept_timer_whose_runtime_has_shut_down() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, panic::AssertUnwindSafe, pin::pin, task::Poll};
    let limit = Duration::from_secs(30);
    let outer = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let inner = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let away = std::cell::RefCell::new(None);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    {
        let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
            // As a handler that serves its request on a runtime of its own.
            let _entered = inner.enter();
            let mut timer = Box::pin(Timer::Unset);
            assert!(timer.as_mut().poll(limit, cx).is_pending());
            if timer.is_kept() {
                *away.borrow_mut() = Some(timer);
            }
            Poll::<()>::Pending
        })));
        let entered = outer.enter();
        for _ in 0..2 {
            assert!(conn.as_mut().poll(&mut cx).is_pending());
        }
        drop(entered);
    }
    let mut moved = away.borrow_mut().take().expect("the second deadline has the connection's timer");
    {
        let _entered = inner.enter();
        println!("outer-gone: before the outer runtime shuts down: {:?}", moved.as_mut().poll(limit, &mut cx));
    }
    drop(outer);
    let _entered = inner.enter();
    let polled = std::panic::catch_unwind(AssertUnwindSafe(|| moved.as_mut().poll(limit, &mut cx)));
    println!(
        "outer-gone: after it has: {}",
        match &polled {
            Ok(polled) => format!("{polled:?}"),
            Err(panic) => format!("a panic: {}", panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()),
        }
    );
    std::mem::forget(moved);
}
EOF
docker run --rm -v "/root/dl/og:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-head:/target" \
    -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
    cargo test -p corten-run --all-features --lib -- --exact --nocapture tests::server::scratch_a_kept_timer_whose_runtime_has_shut_down > outer-gone.out 2>&1
grep -E "outer-gone:|test result|^error|panicked" outer-gone.out > outer-gone.log
echo "# OG-DONE" >> outer-gone.log
