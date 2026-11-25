#!/bin/bash
# Count host, with nothing else running: how late a deadline's answer is (the crate's ignored test
# how_late_a_deadlines_answer_is, release profile, as the first tag's b-test.sh ran it), the base
# and the head in turn, three runs each after both are built.
cd /root/dl
for t in base head; do rm -rf late-$t && mkdir late-$t && tar -xzf $t.tgz -C late-$t; done
run() {
    docker run --rm -v /root/dl/late-$1:/src -v corten-cargo:/usr/local/cargo/registry -v corten-target-late-$1:/target \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
        cargo test --release -p corten-run --all-features --lib -- --ignored --exact --nocapture tests::server::how_late_a_deadlines_answer_is 2>&1
}
: > c3-late.log
for t in base head; do run $t > c3-late-build-$t.log; echo "# built $t rc=$? $(date -u +%T) load $(cut -d' ' -f1 /proc/loadavg)" >> c3-late.log; done
for round in 1 2 3; do
    for t in base head; do
        echo "== $t round $round $(date -u +%T) load $(cut -d' ' -f1 /proc/loadavg)" >> c3-late.log
        run $t | grep -E "past the deadline|test result|panicked|error" >> c3-late.log
    done
done
echo "# LATE-DONE $(date -u +%T)" >> c3-late.log
