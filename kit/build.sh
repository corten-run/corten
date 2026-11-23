#!/bin/sh
# build.sh: builds #1824's probe twice on the measuring host, all from one place (/m/1824f/work,
# the tree; /m/1824f/probe, the program; /m/target-1824f, the target), with the repository's
# release profile, rustc 1.100.0 and main's Cargo.lock:
#   main  main (src-main, commits.env's MAIN), the target directory empty first
#   head  main with variants/head.diff (the candidate's change to crates/, commits.env's HEAD);
#         reuses main's third-party builds (cargo clean -p)
# zstd is linked to the system's libzstd, as the Dockerfile corten new writes builds it
# (ZSTD_SYS_USE_PKG_CONFIG; needs libzstd-dev and pkg-config). Checks that the diff applies
# cleanly, that no third-party version outside main's Cargo.lock was resolved, that both probes
# are linked to libzstd and that the two binaries differ, and writes bin/main, bin/head,
# bin/sha256.txt (the build receipt) and build-<name>.log.
set -eu
P=/m/1824f; W=$P/work; T=/m/target-1824f
[ -f /root/.cargo/env ] && . /root/.cargo/env
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-1.100.0} ZSTD_SYS_USE_PKG_CONFIG=1 CARGO_TARGET_DIR=$T
rustc -V
mkdir -p $P/bin
: >$P/bin/sha256.txt
pairs() { awk '/^name = /{n=$3} /^version = /{print n, $3}' "$1" | tr -d '"' | sort -u; }
tree() { # <patch or ->: the build's tree at $W
    case "$W" in /m/1824f/work) ;; *) echo "refusing to replace $W"; exit 1 ;; esac
    rm -rf "$W"; mkdir -p "$W"; cp -a $P/src-main/. "$W/"
    [ "$1" = - ] || (cd "$W" && patch -p1 --no-backup-if-mismatch --forward <"$P/variants/$1") || { echo "PATCH FAILED: $1"; exit 1; }
}
build() { # <name> <patch or -> <full|crates>
    name=$1; started=$(date +%s)
    echo "== $name: main $(cat $P/src-main.commit), patch $2, $3 build, $(date -u +%T)"
    tree "$2"
    if [ "$3" = full ]; then
        case "$T" in /m/target-1824f) mkdir -p "$T"; find "$T" -mindepth 1 -delete ;; *) echo "refusing to empty $T"; exit 1 ;; esac
    else
        (cd $P/probe && cargo clean --release -p corten-run -p p1824f >/dev/null 2>&1)
    fi
    rm -f $P/bin/$name
    (cd $P/probe && cargo build --release >$P/build-$name.log 2>&1) \
        || { tail -30 $P/build-$name.log; echo "BUILD FAILED: $name"; exit 1; }
    tail -2 $P/build-$name.log
    pairs $P/src-main/Cargo.lock >/tmp/1824f-lock-main
    new=$(pairs $P/probe/Cargo.lock | grep -v '^p1824f ' | comm -23 - /tmp/1824f-lock-main)
    rm -f /tmp/1824f-lock-main
    [ -z "$new" ] || { echo "$name resolved versions main's Cargo.lock does not have: $new"; exit 1; }
    cp $T/release/probe $P/bin/$name
    ldd $P/bin/$name | grep -q 'libzstd\.so' || { echo "$name is not linked to the system's libzstd"; exit 1; }
    echo "$name $(sha256sum $P/bin/$name | cut -d' ' -f1) $(stat -c %s $P/bin/$name) bytes" | tee -a $P/bin/sha256.txt
    echo "$name built in $(( $(date +%s) - started )) s"
}
build main - full
build head head.diff crates
[ "$(sha256sum <$P/bin/main)" != "$(sha256sum <$P/bin/head)" ] || { echo "main and head are the same binary"; exit 1; }
echo BUILD-DONE