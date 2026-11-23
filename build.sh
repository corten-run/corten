#!/bin/sh
# build.sh: builds 1846r3's two probes on the measuring host, base and head, each from its tree
# (src-base, src-head: git archive of commits.env's BASE and HEAD) with its Cargo.lock, the
# repository's release profile (opt-level 3, thin LTO, one codegen unit) and rustc 1.100.0, into
# /m/target-1846r3. zstd is linked to the system's libzstd, as the Dockerfile `corten new` writes
# builds it (ZSTD_SYS_USE_PKG_CONFIG; needs libzstd-dev and pkg-config). Checks that no
# third-party version outside the tree's Cargo.lock was resolved and that both are linked to
# libzstd, refuses a base and head of one commit, and writes bin/base, bin/head and
# bin/sha256.txt (the build receipt: each commit, binary sha256 and size; run.sh copies it to
# results/). (1846r2's build.sh without its third pass's two wait builds.)
set -eu
P=/m/1846r3; T=/m/target-1846r3
[ -f /root/.cargo/env ] && . /root/.cargo/env
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-1.100.0} ZSTD_SYS_USE_PKG_CONFIG=1 CARGO_TARGET_DIR=$T
rustc -V
[ "$(cat $P/src-base.commit)" != "$(cat $P/src-head.commit)" ] || { echo "base and head are one commit"; exit 1; }
mkdir -p $P/bin
: >$P/bin/sha256.txt
pairs() { awk '/^name = /{n=$3} /^version = /{print n, $3}' "$1" | tr -d '"' | sort -u; }
for side in base head; do
    started=$(date +%s)
    echo "== $side $(cat $P/src-$side.commit) $(date -u +%T)"
    rm -f $P/bin/$side
    (cd $P/probe-$side && cargo build --release >$P/build-$side.log 2>&1) \
        || { tail -30 $P/build-$side.log; echo "BUILD FAILED: $side"; exit 1; }
    tail -2 $P/build-$side.log
    pairs $P/src-$side/Cargo.lock >/tmp/1846r3-lock
    new=$(pairs $P/probe-$side/Cargo.lock | grep -v "^p1846r3-$side " | comm -23 - /tmp/1846r3-lock)
    rm -f /tmp/1846r3-lock
    [ -z "$new" ] || { echo "$side resolved versions its tree's Cargo.lock does not have: $new"; exit 1; }
    cp $T/release/$side $P/bin/$side
    ldd $P/bin/$side | grep -q 'libzstd\.so' || { echo "$side is not linked to the system's libzstd"; exit 1; }
    echo "$side $(cat $P/src-$side.commit) $(sha256sum $P/bin/$side | cut -d' ' -f1) $(stat -c %s $P/bin/$side) bytes" | tee -a $P/bin/sha256.txt
    echo "$side built in $(( $(date +%s) - started )) s"
done
echo BUILD-DONE
