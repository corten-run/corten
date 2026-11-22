#!/bin/sh
# build.sh: builds #1923's four probe binaries on the measuring host, all from one place
# (/m/1923/work, the tree; /m/1923/probe, the program; /m/target-1923, the target), with the
# repository's release profile and main's Cargo.lock:
#   main-1    main (src-main), the target directory empty first
#   main-2    main again, the target directory emptied again first: a second, separate build of
#             the same source at the same paths (A/A identical)
#   pad40     main with variants/pad40.diff: a never-called function of 40 NOP bytes and a return
#             at the top of crates/corten/src/router.rs (a small shift of the code after it)
#   pad3100   main with variants/pad3100.diff: the same with 3,100 NOP bytes (a larger shift)
# pad40 and pad3100 reuse main-2's third-party builds and rebuild corten-run and the probe
# (cargo clean -p). zstd is linked to the system's libzstd, as the Dockerfile corten new writes
# builds it (ZSTD_SYS_USE_PKG_CONFIG; needs libzstd-dev and pkg-config). Checks that no
# third-party version outside main's Cargo.lock was resolved, that the pad function is in the
# pad builds and in neither main build, and prints each binary's sha256 and, per pad build, how
# far its code moved against main-1 (layout.mjs). Writes bin/<name>, bin/sha256.txt,
# bin/layout-<name>.txt and build-<name>.log.
set -eu
P=/m/1923; W=$P/work; T=/m/target-1923
[ -f /root/.cargo/env ] && . /root/.cargo/env
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-1.100.0} ZSTD_SYS_USE_PKG_CONFIG=1 CARGO_TARGET_DIR=$T
rustc -V
mkdir -p $P/bin
: >$P/bin/sha256.txt
pairs() { awk '/^name = /{n=$3} /^version = /{print n, $3}' "$1" | tr -d '"' | sort -u; }
tree() { # <patch or ->: the variant's tree at $W
    case "$W" in /m/1923/work) ;; *) echo "refusing to replace $W"; exit 1 ;; esac
    rm -rf "$W"; mkdir -p "$W"; cp -a $P/src-main/. "$W/"
    [ "$1" = - ] || (cd "$W" && patch -p1 --no-backup-if-mismatch <"$P/variants/$1") || { echo "PATCH FAILED: $1"; exit 1; }
}
build() { # <name> <patch or -> <full|crates>
    name=$1; started=$(date +%s)
    echo "== $name: main $(cat $P/src-main.commit), patch $2, $3 build, $(date -u +%T)"
    tree "$2"
    if [ "$3" = full ]; then
        case "$T" in /m/target-1923) rm -rf "$T" ;; *) echo "refusing to remove $T"; exit 1 ;; esac
    else
        (cd $P/probe && cargo clean --release -p corten-run -p p1923 >/dev/null 2>&1)
    fi
    rm -f $P/bin/$name
    (cd $P/probe && cargo build --release >$P/build-$name.log 2>&1) \
        || { tail -30 $P/build-$name.log; echo "BUILD FAILED: $name"; exit 1; }
    tail -2 $P/build-$name.log
    pairs $P/src-main/Cargo.lock >/tmp/1923-lock-main
    new=$(pairs $P/probe/Cargo.lock | grep -v '^p1923 ' | comm -23 - /tmp/1923-lock-main)
    rm -f /tmp/1923-lock-main
    [ -z "$new" ] || { echo "$name resolved versions main's Cargo.lock does not have: $new"; exit 1; }
    cp $T/release/probe $P/bin/$name
    ldd $P/bin/$name | grep -q 'libzstd\.so' || { echo "$name is not linked to the system's libzstd"; exit 1; }
    pads=$(nm $P/bin/$name | grep -c 'layout_pad' || true)
    case "$2,$pads" in -,0|pad*,1) ;; *) echo "$name: $pads layout_pad symbols, patch $2"; exit 1 ;; esac
    echo "$name $(sha256sum $P/bin/$name | cut -d' ' -f1) $(stat -c %s $P/bin/$name) bytes" | tee -a $P/bin/sha256.txt
    echo "$name built in $(( $(date +%s) - started )) s"
}
build main-1 - full
build main-2 - full
build pad40 pad40.diff crates
build pad3100 pad3100.diff crates
for v in main-2 pad40 pad3100; do
    node $P/layout.mjs $P/bin/main-1 $P/bin/$v | tee $P/bin/layout-$v.txt
done
if cmp -s $P/bin/main-1 $P/bin/main-2; then echo "main-1 and main-2 are identical (A/A identical runs them as A and B all the same)"; else echo "main-1 and main-2 differ"; fi
echo BUILD-DONE