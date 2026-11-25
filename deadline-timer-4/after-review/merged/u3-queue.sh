#!/bin/bash
# Count host. The tree of the commit named in new.commit: the deadline tests as they stand, then
# each mutation of mut.py in turn against the same tests.
cd /root/dl/u3 || exit 1
mkdir -p log
: > log/queue.log
say() { echo "$* $(date -u +%T)" >> log/queue.log; }
say "# tree of $(zcat new.tgz | git get-tar-commit-id)"
fresh() { rm -rf src && mkdir src && tar -xzf new.tgz -C src; }
tests() {
    docker run --rm -v /root/dl/u3/src:/src -v corten-cargo:/usr/local/cargo/registry -v corten-target-u2:/target \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
        timeout -s KILL 1500 cargo test -p corten-run --all-features --lib -- tests::server deadline > log/test-$1.log 2>&1
    rc=$?
    say "== $1 rc=$rc: $(grep -E '^test result|signal: |^error: test failed' log/test-$1.log | tr '\n' ' ')"
    grep -E '^test .* (FAILED|has been running)|panicked at|fatal runtime error' log/test-$1.log | sort -u | head -12 >> log/queue.log
}
fresh || { say "# FRESH-FAILED"; exit 1; }
tests clean
for m in M10 M14 M18 M21a M21b M22 M27; do
    fresh && python3 ../u2/mut.py src $m >> log/queue.log 2>&1 || { say "# MUT-FAILED $m"; continue; }
    tests $m
done
say "# TESTS-DONE"
