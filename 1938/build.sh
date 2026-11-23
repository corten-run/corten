#!/bin/sh
# build.sh: builds #1938's two server probes (base and head, release, the repository's profile)
# on the measuring host, from the trees in src-{base,head} that export-src.ps1 wrote (commits in
# src-{base,head}.commit). The probes take their tree's Cargo.lock, and this checks that no
# third-party version outside it was resolved. zstd is linked to the system's libzstd, as the
# Dockerfile corten new writes builds it (ZSTD_SYS_USE_PKG_CONFIG; needs libzstd-dev and
# pkg-config). Refuses base and head on one commit unless ALLOW_SAME=1 (a compile check, never a
# measurement). Prints each binary's sha256. Its own target directory, so other kits' builds on
# the host are untouched.
set -eu
P=/m/1938
[ -f /root/.cargo/env ] && . /root/.cargo/env
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-1.100.0} ZSTD_SYS_USE_PKG_CONFIG=1
rustc -V
if [ "$(cat $P/src-base.commit)" = "$(cat $P/src-head.commit)" ] && [ -z "${ALLOW_SAME:-}" ]; then
    echo "base and head are the same commit; set HEAD in commits.env and export again"; exit 1
fi
mkdir -p $P/bin
pairs() { awk '/^name = /{n=$3} /^version = /{print n, $3}' "$1" | tr -d '"' | sort -u; }
for side in base head; do
    echo "== $side $(cat $P/src-$side.commit)"
    rm -f $P/bin/$side
    (cd $P/probe-$side && CARGO_TARGET_DIR=/m/target-1938 cargo build --release >$P/build-$side.log 2>&1) \
        || { tail -30 $P/build-$side.log; echo "BUILD FAILED: $side"; exit 1; }
    tail -2 $P/build-$side.log
    pairs $P/src-$side/Cargo.lock >/tmp/1938-lock-$side
    new=$(pairs $P/probe-$side/Cargo.lock | grep -v '^p1938-' | comm -23 - /tmp/1938-lock-$side)
    rm -f /tmp/1938-lock-$side
    [ -z "$new" ] || { echo "$side resolved versions its tree's Cargo.lock does not have: $new"; exit 1; }
    cp /m/target-1938/release/$side $P/bin/$side
    ldd $P/bin/$side | grep -q 'libzstd\.so' || { echo "$side is not linked to the system's libzstd"; exit 1; }
    echo "$side sha256 $(sha256sum $P/bin/$side | cut -c1-16)"
done
echo BUILD-DONE