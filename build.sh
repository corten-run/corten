#!/bin/sh
# build.sh: builds kit 1938c's two server probes (base and head, release, the repository's
# profile) on the measuring host, from the trees in src-{base,head} that export-src.ps1 wrote
# (commits in src-{base,head}.commit, from commits.env). The probes take their tree's
# Cargo.lock, and this checks that no third-party version outside it was resolved. zstd is linked
# to the system's libzstd, as the Dockerfile corten new writes builds it (ZSTD_SYS_USE_PKG_CONFIG;
# needs libzstd-dev and pkg-config). Refuses base and head on one commit unless ALLOW_SAME=1 (a
# compile check, never a measurement). The two builds run at once, each in its own target
# directory (/m/target-1938c-{base,head}, paths of the same length), to keep the kit inside its
# time; other kits' builds on the host are untouched. Prints each binary's sha256.
set -eu
P=/m/1938c
[ -f /root/.cargo/env ] && . /root/.cargo/env
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-1.100.0} ZSTD_SYS_USE_PKG_CONFIG=1
rustc -V
if [ "$(cat $P/src-base.commit)" = "$(cat $P/src-head.commit)" ] && [ -z "${ALLOW_SAME:-}" ]; then
    echo "base and head are the same commit; set HEAD in commits.env and export again"; exit 1
fi
mkdir -p $P/bin
pairs() { awk '/^name = /{n=$3} /^version = /{print n, $3}' "$1" | tr -d '"' | sort -u; }
started=$(date +%s)
for side in base head; do
    echo "== $side $(cat $P/src-$side.commit)"
    rm -f $P/bin/$side $P/build-$side.rc
    ( cd $P/probe-$side && CARGO_TARGET_DIR=/m/target-1938c-$side cargo build --release >$P/build-$side.log 2>&1; echo $? >$P/build-$side.rc ) &
done
wait
for side in base head; do
    [ "$(cat $P/build-$side.rc 2>/dev/null)" = 0 ] || { tail -30 $P/build-$side.log; echo "BUILD FAILED: $side"; exit 1; }
    tail -2 $P/build-$side.log
    pairs $P/src-$side/Cargo.lock >/tmp/1938c-lock-$side
    new=$(pairs $P/probe-$side/Cargo.lock | grep -v '^p1938c-' | comm -23 - /tmp/1938c-lock-$side)
    rm -f /tmp/1938c-lock-$side
    [ -z "$new" ] || { echo "$side resolved versions its tree's Cargo.lock does not have: $new"; exit 1; }
    cp /m/target-1938c-$side/release/$side $P/bin/$side
    ldd $P/bin/$side | grep -q 'libzstd\.so' || { echo "$side is not linked to the system's libzstd"; exit 1; }
    echo "$side sha256 $(sha256sum $P/bin/$side | cut -c1-16)"
done
echo "built both in $(( $(date +%s) - started )) s"
echo BUILD-DONE