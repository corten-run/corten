#!/bin/bash
# Count host: the head's tree with one scratch test appended, and that test run.
cd /root/dl
rm -rf c3t && mkdir c3t && tar -xzf head.tgz -C c3t
cat fires.rs >> c3t/crates/corten/src/tests/server.rs
docker run --rm -v /root/dl/c3t:/src -v corten-cargo:/usr/local/cargo/registry -v corten-target-c3t:/target \
    -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
    cargo test -p corten-run --all-features --lib -- --exact --nocapture tests::server::c3_a_timer_left_set_wakes_its_connection_once_when_its_time_comes > c3-test.log 2>&1
echo "# rc=$? $(date -u +%T)" >> c3-test.log
