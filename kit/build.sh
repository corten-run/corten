#!/bin/sh
# build.sh: builds 1846w's two probes on the measuring host. For each side, a copy of its tree
# (wait-src-<side>, never src-<side> itself: git archive of commits.env's BASE or HEAD) gets
# wait/probe_wait.rs and its side file beside kept.rs and the module declared at the end of
# kept.rs (wait/kept-mod.rs, a test-only module); its corten unit tests are built with the
# repository's release profile (opt-level 3, thin LTO, one codegen unit), rustc 1.100.0, --locked to
# the tree's Cargo.lock, features json and compress, zstd linked to the system's libzstd
# (ZSTD_SYS_USE_PKG_CONFIG), into /m/target-1846w-wait. Refuses a base and head of one commit and a
# head without the LOCKING hook the probe records the lock request with. Writes bin/wait-base,
# bin/wait-head and bin/sha256.txt (each commit, sha256 and size; run.sh copies it to results/).
set -eu
P=/m/1846w; T=/m/target-1846w-wait
[ -f /root/.cargo/env ] && . /root/.cargo/env
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-1.100.0} ZSTD_SYS_USE_PKG_CONFIG=1
rustc -V
[ "$(cat $P/src-base.commit)" != "$(cat $P/src-head.commit)" ] || { echo "base and head are one commit"; exit 1; }
grep -q 'static LOCKING' $P/src-head/crates/corten/src/kept.rs || { echo "the head's kept.rs has no LOCKING hook"; exit 1; }
mkdir -p $P/bin
: >$P/bin/sha256.txt
for side in base head; do
    started=$(date +%s)
    W=$P/wait-src-$side
    case $W in /m/1846w/wait-src-*) rm -rf "$W" ;; *) echo "refusing to remove $W"; exit 1 ;; esac
    cp -r $P/src-$side $W
    cp $P/wait/probe_wait.rs $W/crates/corten/src/probe_wait.rs
    cp $P/wait/side-$side.rs $W/crates/corten/src/probe_wait_side.rs
    cat $P/wait/kept-mod.rs >>$W/crates/corten/src/kept.rs
    echo "== wait-$side $(cat $P/src-$side.commit) $(date -u +%T)"
    (cd $W && CARGO_TARGET_DIR=$T cargo test --release --locked -p corten-run --features json,compress --lib --no-run --message-format=json >$P/build-wait-$side.json 2>$P/build-wait-$side.log) \
        || { tail -30 $P/build-wait-$side.log; echo "BUILD FAILED: wait-$side"; exit 1; }
    exe=$(node -e '
        const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
        const x = lines.filter((m) => m.reason === "compiler-artifact" && m.target?.name === "corten" && m.profile?.test && m.executable);
        if (x.length !== 1) { console.error(x.length + " test executables"); process.exit(1); }
        console.log(x[0].executable);' $P/build-wait-$side.json)
    cp "$exe" $P/bin/wait-$side
    ldd $P/bin/wait-$side | grep -q 'libzstd\.so' || { echo "wait-$side is not linked to the system's libzstd"; exit 1; }
    echo "wait-$side $(cat $P/src-$side.commit) $(sha256sum $P/bin/wait-$side | cut -d' ' -f1) $(stat -c %s $P/bin/wait-$side) bytes (the tree with wait/)" | tee -a $P/bin/sha256.txt
    echo "wait-$side built in $(( $(date +%s) - started )) s"
done
echo BUILD-DONE
