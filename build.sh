#!/bin/sh
# build.sh: builds #1865's probes (base and head) in release on the measuring host from the trees
# export-src.ps1 wrote (their commits in 1865/src-{base,head}.commit), each with its own resolved
# Cargo.lock (1865/probe-{base,head}/Cargo.lock, made by lock.mjs on the workstation and declared in
# 1865/results/margin.md by sha256). Refuses a lock whose sha256 is not the one in 1865/locks.sha256,
# builds with --locked so Cargo cannot change either, copies both locks into 1865/results/locks/ and
# writes their hashes and the binaries' to 1865/results/build.txt. zstd is linked to the system's
# libzstd, as `corten new`'s Dockerfile builds it (ZSTD_SYS_USE_PKG_CONFIG; needs libzstd-dev and
# pkg-config). Refuses a pair whose base and head are one commit.
set -eu
[ -f /root/.cargo/env ] && . /root/.cargo/env
export ZSTD_SYS_USE_PKG_CONFIG=1
P=/m/1865; R=$P/results
[ "$(cat $P/src-base.commit)" != "$(cat $P/src-head.commit)" ] || { echo "base and head are the same commit"; exit 1; }
(cd $P && sha256sum -c locks.sha256) || { echo "a probe's Cargo.lock is not the one declared (1865/locks.sha256)"; exit 1; }
mkdir -p $P/bin $R/locks
: >$R/build.txt
for side in base head; do
    echo "== $side $(cat $P/src-$side.commit)"
    rm -f $P/bin/$side
    (cd $P/probe-$side && CARGO_TARGET_DIR=/m/target-1865 cargo build --release --locked >$P/build-$side.log 2>&1) \
        || { tail -30 $P/build-$side.log; echo "BUILD FAILED: $side"; exit 1; }
    tail -3 $P/build-$side.log
    cp /m/target-1865/release/$side $P/bin/$side
    ldd $P/bin/$side | grep -q 'libzstd\.so' || { echo "$side is not linked to the system's libzstd"; exit 1; }
    cp $P/probe-$side/Cargo.lock $R/locks/probe-$side.Cargo.lock
    cp $P/src-$side/Cargo.lock $R/locks/src-$side.Cargo.lock
    { echo "$side commit $(cat $P/src-$side.commit)"
      echo "$side probe Cargo.lock sha256 $(sha256sum $P/probe-$side/Cargo.lock | cut -d' ' -f1)"
      echo "$side tree Cargo.lock sha256 $(sha256sum $P/src-$side/Cargo.lock | cut -d' ' -f1)"
      echo "$side binary sha256 $(sha256sum $P/bin/$side | cut -d' ' -f1)"; } >>$R/build.txt
done
(cd $P && sha256sum -c locks.sha256) || { echo "a probe's Cargo.lock changed during the build"; exit 1; }
cargo -V >>$R/build.txt; rustc -V >>$R/build.txt
cat $R/build.txt
echo BUILD-DONE
