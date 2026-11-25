#!/bin/bash
# The tree in new.tgz: the deadline tests as they stand, then the mutations named in
# $1 (default: all seven), each against the same tests; M22 is run $2 times (default 10) from one
# build, since what catches it must not depend on which test's connection takes the first number.
cd /work || exit 1
MUTS=${1:-"M22 M10 M14 M18 M21a M21b M27"}; RUNS=${2:-10}
mkdir -p log
: > log/queue.log
say() { echo "$* $(date -u +%T)" >> log/queue.log; }
say "# tree of $(cat new.commit)"
fresh() { rm -rf src && mkdir src && tar -xzf new.tgz -C src; }
tests() {
    docker run --rm -v /work/src:/src -v corten-cargo:/usr/local/cargo/registry -v corten-target-u2:/target \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
        timeout -s KILL 1500 cargo test -p corten-run --all-features --lib -- tests::server deadline > log/test-$1.log 2>&1
    rc=$?
    say "== $1 rc=$rc: $(grep -E '^test result|signal: |^error: test failed|^error(\[|:)' log/test-$1.log | head -4 | tr '\n' ' ')"
    grep -E '^test .* (FAILED|has been running)|panicked at|fatal runtime error' log/test-$1.log | sort -u | head -12 >> log/queue.log
}
fresh || { say "# FRESH-FAILED"; exit 1; }
tests clean
for m in $MUTS; do
    fresh && python3 ../u2/mut.py src $m >> log/queue.log 2>&1 || { say "# MUT-FAILED $m"; continue; }
    if [ "$m" = M22 ]; then
        n=1; while [ $n -le "$RUNS" ]; do tests M22-run$n; n=$((n + 1)); done
        say "M22: $(grep -c '^== M22-run.* rc=101' log/queue.log) of $RUNS runs failed; the tests that failed, by count: $(grep -hE '^test .* FAILED' log/test-M22-run*.log | sort | uniq -c | tr '\n' ';')"
    else
        tests $m
    fi
done
say "# TESTS-DONE"
