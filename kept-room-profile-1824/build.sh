#!/bin/sh
# build.sh: builds #1824's probe and faultcost on the measuring host (/m/1824c/work, the tree;
# /m/1824c/probe, the program; /m/target-1824c, the target), with the repository's release
# profile, rustc 1.100.0 and main's Cargo.lock: one build, main (src-main, commits.env's MAIN),
# the target directory empty first. Both sides of every comparison run this one binary (room or
# off is a command-line choice), so there is no layout difference between them.
# zstd is linked to the system's libzstd, as the Dockerfile corten new writes builds it
# (ZSTD_SYS_USE_PKG_CONFIG; needs libzstd-dev and pkg-config). Checks that no third-party version
# outside main's Cargo.lock was resolved and that the probe is linked to libzstd and keeps its
# symbol table (perf report names its functions), and writes bin/main, bin/faultcost,
# bin/sha256.txt (the build receipt) and build-<name>.log.
set -eu
P=/m/1824c; W=$P/work; T=/m/target-1824c
[ -f /root/.cargo/env ] && . /root/.cargo/env
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-1.100.0} ZSTD_SYS_USE_PKG_CONFIG=1 CARGO_TARGET_DIR=$T
rustc -V
mkdir -p $P/bin
: >$P/bin/sha256.txt
pairs() { awk '/^name = /{n=$3} /^version = /{print n, $3}' "$1" | tr -d '"' | sort -u; }
started=$(date +%s)
echo "== main: $(cat $P/src-main.commit), full build, $(date -u +%T)"
case "$W" in /m/1824c/work) ;; *) echo "refusing to replace $W"; exit 1 ;; esac
rm -rf "$W"; mkdir -p "$W"; cp -a $P/src-main/. "$W/"
case "$T" in /m/target-1824c) mkdir -p "$T"; find "$T" -mindepth 1 -delete ;; *) echo "refusing to empty $T"; exit 1 ;; esac
rm -f $P/bin/main
(cd $P/probe && cargo build --release >$P/build-main.log 2>&1) \
    || { tail -30 $P/build-main.log; echo "BUILD FAILED: main"; exit 1; }
tail -2 $P/build-main.log
pairs $P/src-main/Cargo.lock >/tmp/1824c-lock-main
new=$(pairs $P/probe/Cargo.lock | grep -v '^p1824c ' | comm -23 - /tmp/1824c-lock-main)
rm -f /tmp/1824c-lock-main
[ -z "$new" ] || { echo "main resolved versions main's Cargo.lock does not have: $new"; exit 1; }
cp $T/release/probe $P/bin/main
ldd $P/bin/main | grep -q 'libzstd\.so' || { echo "main is not linked to the system's libzstd"; exit 1; }
# perf names a function of the probe from its symbol table; a stripped binary would leave only
# addresses.
nm $P/bin/main 2>/dev/null | grep -q ' [Tt] main$' || { echo "main has no symbol table (stripped?)"; exit 1; }
echo "main $(sha256sum $P/bin/main | cut -d' ' -f1) $(stat -c %s $P/bin/main) bytes" | tee -a $P/bin/sha256.txt
echo "main built in $(( $(date +%s) - started )) s"
echo "== faultcost $(date -u +%T)"
(cd $P/faultcost && CARGO_TARGET_DIR=/m/target-1824c-faultcost cargo build --release >$P/build-faultcost.log 2>&1) \
    || { tail -30 $P/build-faultcost.log; echo "BUILD FAILED: faultcost"; exit 1; }
cp /m/target-1824c-faultcost/release/faultcost $P/bin/faultcost
echo "faultcost $(sha256sum $P/bin/faultcost | cut -d' ' -f1) $(stat -c %s $P/bin/faultcost) bytes" | tee -a $P/bin/sha256.txt
echo BUILD-DONE