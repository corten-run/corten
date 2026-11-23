#!/bin/sh
# build.sh: builds #1846r2's two probes on the measuring host, base and head, each from its tree
# (src-base, src-head: git archive of commits.env's BASE and HEAD) with its Cargo.lock, the
# repository's release profile (opt-level 3, thin LTO, one codegen unit) and rustc 1.100.0, into
# /m/target-1846r2. zstd is linked to the system's libzstd, as the Dockerfile `corten new` writes
# builds it (ZSTD_SYS_USE_PKG_CONFIG; needs libzstd-dev and pkg-config). Checks that no
# third-party version outside the tree's Cargo.lock was resolved and that both are linked to
# libzstd, refuses a base and head of one commit, and writes bin/base, bin/head and
# bin/sha256.txt (the build receipt: each commit, binary sha256 and size; run.sh copies it to
# results/). Then pass 3's two binaries (wait.sh): a copy of each tree (wait-src-<side>, never
# src-<side> itself) with wait/probe_wait.rs and its side file put beside kept.rs and the module
# declared at the end of kept.rs (wait/kept-mod.rs, a test-only module), whose corten unit tests
# are built with the same profile, --locked to the tree's Cargo.lock, features json and compress,
# into /m/target-1846r2-wait; written as bin/wait-base and bin/wait-head, with their receipts.
set -eu
P=/m/1846r2; T=/m/target-1846r2
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
    pairs $P/src-$side/Cargo.lock >/tmp/1846r2-lock
    new=$(pairs $P/probe-$side/Cargo.lock | grep -v "^p1846r2-$side " | comm -23 - /tmp/1846r2-lock)
    rm -f /tmp/1846r2-lock
    [ -z "$new" ] || { echo "$side resolved versions its tree's Cargo.lock does not have: $new"; exit 1; }
    cp $T/release/$side $P/bin/$side
    ldd $P/bin/$side | grep -q 'libzstd\.so' || { echo "$side is not linked to the system's libzstd"; exit 1; }
    echo "$side $(cat $P/src-$side.commit) $(sha256sum $P/bin/$side | cut -d' ' -f1) $(stat -c %s $P/bin/$side) bytes" | tee -a $P/bin/sha256.txt
    echo "$side built in $(( $(date +%s) - started )) s"
done
for side in base head; do
    started=$(date +%s)
    W=$P/wait-src-$side
    case $W in /m/1846r2/wait-src-*) rm -rf "$W" ;; *) echo "refusing to remove $W"; exit 1 ;; esac
    cp -r $P/src-$side $W
    cp $P/wait/probe_wait.rs $W/crates/corten/src/probe_wait.rs
    cp $P/wait/side-$side.rs $W/crates/corten/src/probe_wait_side.rs
    cat $P/wait/kept-mod.rs >>$W/crates/corten/src/kept.rs
    echo "== wait-$side $(cat $P/src-$side.commit) $(date -u +%T)"
    (cd $W && CARGO_TARGET_DIR=/m/target-1846r2-wait cargo test --release --locked -p corten-run --features json,compress --lib --no-run --message-format=json >$P/build-wait-$side.json 2>$P/build-wait-$side.log) \
        || { tail -30 $P/build-wait-$side.log; echo "BUILD FAILED: wait-$side"; exit 1; }
    exe=$(node -e '
        const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
        const x = lines.filter((m) => m.reason === "compiler-artifact" && m.target?.name === "corten" && m.profile?.test && m.executable);
        if (x.length !== 1) { console.error(x.length + " test executables"); process.exit(1); }
        console.log(x[0].executable);' $P/build-wait-$side.json)
    cp "$exe" $P/bin/wait-$side
    echo "wait-$side $(cat $P/src-$side.commit) $(sha256sum $P/bin/wait-$side | cut -d' ' -f1) $(stat -c %s $P/bin/wait-$side) bytes (the tree with wait/)" | tee -a $P/bin/sha256.txt
    echo "wait-$side built in $(( $(date +%s) - started )) s"
done
echo BUILD-DONE
