#!/usr/bin/env bash
# Runs on the build host, after paused3.sh: every scratch paused-clock test again on the copy of
# main and on the copy of the merged head, each tree's test file touched first so that cargo
# rebuilds it. paused.sh and paused2.sh ran the head's tests from the binary built for main (the two
# copies are mounted at one path and share a target directory, and the head's copy was no newer than
# that build), which their equal counts of filtered tests show; this run's counts differ.
set -uo pipefail
cd /root/dl
: > paused4.log
for t in p-main p-head; do
    echo "== $t" >> paused4.log
    touch $t/crates/corten/src/tests/server.rs
    docker run --rm -v "/root/dl/$t:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-head:/target" \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
        cargo test -p corten-run --all-features --lib -- --nocapture --test-threads 1 tests::server::scratch_paused_clock 2>&1 \
        | grep -E "paused clock|counted:|bare:|test result|panicked|error" >> paused4.log
done
echo "PAUSED4-DONE" >> paused4.log
