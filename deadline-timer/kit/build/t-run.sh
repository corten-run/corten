#!/usr/bin/env bash
# Runs on the build host: applies <patch> to a fresh copy of the merged head and runs the crate's
# lib tests named by <filter> (all when empty). Usage: t-run.sh <patch> <log> [filter]
set -uo pipefail
patch=$1; log=$2; filter=${3:-}
cd /root/dl
rm -rf w && cp -r head w
(cd w && git init -q . 2>/dev/null; git apply --whitespace=nowarn "/root/dl/$patch") || { echo "T-FAILED patch" > "$log"; exit 1; }
find w/crates/corten/src -name '*.rs' -newer head.tgz -exec touch {} +
touch w/crates/corten/src/deadline.rs w/crates/corten/src/tests/server.rs
docker run --rm -v "/root/dl/w:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-head:/target" \
    -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
    cargo test -p corten-run --all-features --lib -- $filter > "$log" 2>&1
echo "# T-DONE rc=$?" >> "$log"
