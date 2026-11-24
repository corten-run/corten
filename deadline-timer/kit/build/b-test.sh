#!/usr/bin/env bash
# Runs on the build host. Usage: b-test.sh <tree> <patch|none> <what> [filter...]
#   what: check | lib | fmt | clippy | late
# Makes /root/dl/<tree> from base.bundle with <patch> applied, then runs cargo in rust:1-trixie.
set -uo pipefail
tree=$1; patch=$2; what=$3; shift 3
cd /root/dl
if [ ! -d src-base/.git ]; then
    git clone -q base.bundle src-base 2>/dev/null || { mkdir -p src-base && cd src-base && git init -q && git fetch -q ../base.bundle HEAD && git checkout -q FETCH_HEAD && cd ..; }
fi
rm -rf "$tree" && mkdir "$tree" && git -C src-base archive HEAD | tar -x -C "$tree"
if [ "$patch" != none ]; then
    (cd "$tree" && git init -q . && git apply --whitespace=nowarn "/root/dl/$patch") || { echo "PATCH FAILED"; echo "# DONE"; exit 1; }
fi
run() {
    docker run --rm -v "/root/dl/$tree:/src" -v corten-cargo:/usr/local/cargo/registry \
        -v "corten-target-$tree:/target" -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie "$@"
}
case "$what" in
    check)  run cargo check -p corten-run --all-features --lib --tests 2>&1 | tail -60 ;;
    lib)    run cargo test -p corten-run --all-features --lib -- "$@" 2>&1 | tail -80 ;;
    late)   run cargo test --release -p corten-run --all-features --lib -- --ignored --exact --nocapture tests::server::how_late_a_deadlines_answer_is 2>&1 | grep -E "past the deadline|test result|panicked|error" ;;
    fmt)    run sh -c 'rustup component add rustfmt >/dev/null 2>&1; cargo fmt --all --check' 2>&1 | tail -60 ;;
    clippy) run sh -c 'rustup component add clippy >/dev/null 2>&1; cargo clippy --workspace --all-features --all-targets -- -D warnings' 2>&1 | tail -60 ;;
esac
echo "# DONE $what $tree rc=${PIPESTATUS[0]}"
