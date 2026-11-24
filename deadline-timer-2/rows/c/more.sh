#!/usr/bin/env bash
# After the checks: the scratch test of the guard residual, the deadline tests many times over,
# and the crate checked against tokio 1.44.0.
set -uo pipefail
cd /root/dl
until grep -q "CHECKS-DONE" status-c.log 2>/dev/null; do sleep 5; done
run() {
    tree=$1; target=$2; shift 2
    docker run --rm -v "/root/dl/$tree:/src" -v corten-cargo:/usr/local/cargo/registry \
        -v "$target:/target" -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie "$@"
}
: > more.status
# 1. The deadline stress tests 20 times, then every server test 5 times.
run c corten-target-c sh -c 'for i in $(seq 1 20); do cargo test -q -p corten-run --all-features --lib tests::server::deadlines 2>&1 | grep -E "^test result|FAILED|panicked" ; done' > repeat-stress.log 2>&1; echo "# repeat-stress rc=$?" >> more.status
run c corten-target-c sh -c 'for i in $(seq 1 5); do cargo test -q -p corten-run --all-features --lib tests::server:: 2>&1 | grep -E "^test result|FAILED|panicked" ; done' > repeat-server.log 2>&1; echo "# repeat-server rc=$?" >> more.status
# 2. The scratch test, in a copy.
rm -rf c-scratch && cp -r c c-scratch && cat scratch-test.rs >> c-scratch/crates/corten/src/tests/server.rs
run c-scratch corten-target-c cargo test -p corten-run --all-features --lib tests::server::scratch_ -- --nocapture > scratch.log 2>&1; echo "# scratch rc=$?" >> more.status
echo "# MORE-DONE" >> more.status
