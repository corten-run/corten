#!/usr/bin/env bash
# Runs on the build host: fmt, clippy and the crate's lib tests on the merged head with <patch>.
# Usage: final-run.sh <patch> <name>
set -uo pipefail
patch=$1; name=$2
cd /root/dl
rm -rf f-$name && cp -r head f-$name
(cd f-$name && git init -q . 2>/dev/null; git apply --whitespace=nowarn "/root/dl/$patch") || { echo "# FINAL-FAILED patch" > status-$name.log; exit 1; }
find f-$name/crates -name '*.rs' -exec touch {} +
run() {
    docker run --rm -v "/root/dl/f-$name:/src" -v corten-cargo:/usr/local/cargo/registry \
        -v "corten-target-head:/target" -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie "$@"
}
: > status-$name.log
run sh -c 'rustup component add rustfmt >/dev/null 2>&1; cargo fmt --all --check' > fmt-$name.log 2>&1; echo "# fmt rc=$?" >> status-$name.log
run sh -c 'rustup component add clippy >/dev/null 2>&1; cargo clippy --workspace --all-features --all-targets -- -D warnings' > clippy-$name.log 2>&1; echo "# clippy rc=$?" >> status-$name.log
run cargo test -p corten-run --all-features --lib > lib-$name.log 2>&1; echo "# lib rc=$?" >> status-$name.log
echo "# FINAL-DONE" >> status-$name.log
