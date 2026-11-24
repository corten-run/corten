#!/usr/bin/env bash
# fmt, clippy and the crate's lib tests on a tree. Usage: checks.sh <tree> [fmt|clippy|lib ...]
set -uo pipefail
tree=$1; shift
cd /root/dl
run() {
    docker run --rm -v "/root/dl/$tree:/src" -v corten-cargo:/usr/local/cargo/registry \
        -v "corten-target-$tree:/target" -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie "$@"
}
: > status-$tree.log
for what in "$@"; do
    case $what in
        fmt) run sh -c 'rustup component add rustfmt >/dev/null 2>&1; cargo fmt --all --check' > fmt-$tree.log 2>&1; echo "# fmt rc=$?" >> status-$tree.log ;;
        clippy) run sh -c 'rustup component add clippy >/dev/null 2>&1; cargo clippy --workspace --all-features --all-targets -- -D warnings' > clippy-$tree.log 2>&1; echo "# clippy rc=$?" >> status-$tree.log ;;
        lib) run cargo test -p corten-run --all-features --lib > lib-$tree.log 2>&1; echo "# lib rc=$?" >> status-$tree.log ;;
        server) run cargo test -p corten-run --all-features --lib tests::server:: > server-$tree.log 2>&1; echo "# server rc=$?" >> status-$tree.log ;;
    esac
done
echo "# CHECKS-DONE" >> status-$tree.log
