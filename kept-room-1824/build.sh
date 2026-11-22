#!/bin/sh
# build.sh: builds #1824's probe twice and faultcost on the measuring host, all from one place
# (/m/1824b/work, the tree; /m/1824b/probe, the program; /m/target-1824b, the target), with the
# repository's release profile, rustc 1.100.0 and main's Cargo.lock:
#   main      main (src-main, commits.env's MAIN), the target directory empty first
#   populate  main with variants/populate.diff (measurement only, not a candidate: a store with
#             room copies kept bodies into its own 2 MiB chunks, each made resident in one
#             madvise(MADV_POPULATE_WRITE)); reuses main's third-party builds (cargo clean -p)
# and faultcost (std only, its own target). zstd is linked to the system's libzstd, as the
# Dockerfile corten new writes builds it (ZSTD_SYS_USE_PKG_CONFIG; needs libzstd-dev and
# pkg-config). Checks that no third-party version outside main's Cargo.lock was resolved, that
# both probes are linked to libzstd, that the variant's code is in populate and not in main (its
# POPULATE line's text), and writes bin/main, bin/populate, bin/faultcost, bin/sha256.txt (the
# build receipt) and build-<name>.log.
set -eu
P=/m/1824b; W=$P/work; T=/m/target-1824b
[ -f /root/.cargo/env ] && . /root/.cargo/env
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-1.100.0} ZSTD_SYS_USE_PKG_CONFIG=1 CARGO_TARGET_DIR=$T
rustc -V
mkdir -p $P/bin
: >$P/bin/sha256.txt
pairs() { awk '/^name = /{n=$3} /^version = /{print n, $3}' "$1" | tr -d '"' | sort -u; }
tree() { # <patch or ->: the build's tree at $W
    case "$W" in /m/1824b/work) ;; *) echo "refusing to replace $W"; exit 1 ;; esac
    rm -rf "$W"; mkdir -p "$W"; cp -a $P/src-main/. "$W/"
    [ "$1" = - ] || (cd "$W" && patch -p1 --no-backup-if-mismatch <"$P/variants/$1") || { echo "PATCH FAILED: $1"; exit 1; }
}
build() { # <name> <patch or -> <full|crates>
    name=$1; started=$(date +%s)
    echo "== $name: main $(cat $P/src-main.commit), patch $2, $3 build, $(date -u +%T)"
    tree "$2"
    if [ "$3" = full ]; then
        case "$T" in /m/target-1824b) mkdir -p "$T"; find "$T" -mindepth 1 -delete ;; *) echo "refusing to empty $T"; exit 1 ;; esac
    else
        (cd $P/probe && cargo clean --release -p corten-run -p p1824b >/dev/null 2>&1)
    fi
    rm -f $P/bin/$name
    (cd $P/probe && cargo build --release >$P/build-$name.log 2>&1) \
        || { tail -30 $P/build-$name.log; echo "BUILD FAILED: $name"; exit 1; }
    tail -2 $P/build-$name.log
    pairs $P/src-main/Cargo.lock >/tmp/1824b-lock-main
    new=$(pairs $P/probe/Cargo.lock | grep -v '^p1824b ' | comm -23 - /tmp/1824b-lock-main)
    rm -f /tmp/1824b-lock-main
    [ -z "$new" ] || { echo "$name resolved versions main's Cargo.lock does not have: $new"; exit 1; }
    cp $T/release/probe $P/bin/$name
    ldd $P/bin/$name | grep -q 'libzstd\.so' || { echo "$name is not linked to the system's libzstd"; exit 1; }
    marks=$(grep -c 'POPULATE ' $P/bin/$name || true)
    case "$2,$marks" in -,0|populate.diff,[1-9]*) ;; *) echo "$name: POPULATE text found $marks times, patch $2"; exit 1 ;; esac
    echo "$name $(sha256sum $P/bin/$name | cut -d' ' -f1) $(stat -c %s $P/bin/$name) bytes" | tee -a $P/bin/sha256.txt
    echo "$name built in $(( $(date +%s) - started )) s"
}
build main - full
build populate populate.diff crates
echo "== faultcost $(date -u +%T)"
(cd $P/faultcost && CARGO_TARGET_DIR=/m/target-1824b-faultcost cargo build --release >$P/build-faultcost.log 2>&1) \
    || { tail -30 $P/build-faultcost.log; echo "BUILD FAILED: faultcost"; exit 1; }
cp /m/target-1824b-faultcost/release/faultcost $P/bin/faultcost
echo "faultcost $(sha256sum $P/bin/faultcost | cut -d' ' -f1) $(stat -c %s $P/bin/faultcost) bytes" | tee -a $P/bin/sha256.txt
echo BUILD-DONE