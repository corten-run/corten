#!/bin/bash
# Count host. The head's tree with the working tree's two files over it: the deadline tests as
# they stand, then each mutation of mut.py in turn against the same tests; beside them the idle
# memory reading (DHAT counts bytes, so what else runs does not move it); then, with nothing else
# running, how late a deadline's answer is on the base (the test carried over) and the head.
cd /root/dl/u2 || exit 1
mkdir -p log out
: > log/queue.log
say() { echo "$* $(date -u +%T)" >> log/queue.log; }
fresh() {
    rm -rf src && mkdir src && tar -xzf ../head.tgz -C src || return 1
    cp new/server.rs src/crates/corten/src/tests/server.rs && cp new/deadline.rs src/crates/corten/src/deadline.rs
}
tests() {
    docker run --rm -v /root/dl/u2/src:/src -v corten-cargo:/usr/local/cargo/registry -v corten-target-u2:/target \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
        timeout -s KILL 1500 cargo test -p corten-run --all-features --lib -- tests::server deadline > log/test-$1.log 2>&1
    rc=$?
    say "== $1 rc=$rc: $(grep -E '^test result|signal: |^error: test failed' log/test-$1.log | tr '\n' ' ')"
    grep -E '^test .* (FAILED|has been running)|panicked at|fatal runtime error' log/test-$1.log | sort -u | head -12 >> log/queue.log
}
# The idle memory reading, beside the tests.
(
    mkdir -p /root/dl/c3/dhat && cp dhat/extra.py dhat/count2.py dhat/idle5.py /root/dl/c3/dhat/
    for name in base head; do
        docker run --rm --ulimit nofile=1048576:1048576 -e ARENA_MODE=default -v /root/dl/c3:/w -w /w/dhat c3img \
            python3 /w/dhat/idle5.py /w/bin/$name 2 > out/idle-$name.txt 2>&1
        say "== idle $name rc=$?"
    done
) &
fresh || { say "# FRESH-FAILED"; exit 1; }
tests clean
for m in M10 M14 M18 M21a M21b M22 M27; do
    fresh && python3 mut.py src $m >> log/queue.log 2>&1 || { say "# MUT-FAILED $m"; continue; }
    tests $m
done
wait
say "# TESTS-DONE"
# Lateness, the host quiet.
cd /root/dl
rm -rf late-base late-head && mkdir late-base late-head
tar -xzf base.tgz -C late-base && tar -xzf head.tgz -C late-head
cp u2/new/server.rs late-head/crates/corten/src/tests/server.rs && cp u2/new/deadline.rs late-head/crates/corten/src/deadline.rs
python3 u2/late_carry.py late-head late-base >> u2/log/queue.log 2>&1 || { echo "# CARRY-FAILED" >> u2/log/queue.log; exit 1; }
run() {
    docker run --rm -v /root/dl/late-$1:/src -v corten-cargo:/usr/local/cargo/registry -v corten-target-late-$1:/target \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
        cargo test --release -p corten-run --all-features --lib -- --ignored --exact --nocapture tests::server::how_late_a_deadlines_answer_is 2>&1
}
L=u2/out/late.log
: > $L
for t in base head; do run $t > u2/log/late-build-$t.log; echo "# built $t rc=$? $(date -u +%T) load $(cut -d' ' -f1 /proc/loadavg)" >> $L; done
sleep 60
for round in 1 2 3 4 5; do
    for t in base head; do
        echo "== $t round $round $(date -u +%T) load $(cut -d' ' -f1 /proc/loadavg)" >> $L
        run $t | grep -E "past the deadline|test result|panicked|error" >> $L
    done
done
echo "# LATE-DONE $(date -u +%T)" >> $L
echo "# QUEUE-DONE $(date -u +%T)" >> u2/log/queue.log
