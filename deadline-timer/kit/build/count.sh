#!/usr/bin/env bash
# Runs on the build host (host): makes the source trees, then counts instructions a request
# in a rust:1-trixie container, for each tree given. Usage: count.sh <name>...
set -uo pipefail
cd /root/dl
mkdir -p cg/out
if [ ! -d cg/src-base ]; then
    mkdir cg/src-base && tar -xzf base-tree.tgz -C cg/src-base
    cp -r cg/src-base cg/src-conn && (cd cg/src-conn && git apply --whitespace=nowarn /root/dl/v1.patch) || { echo "COUNT-FAILED patch"; exit 1; }
    cp -r cg/src-conn cg/src-thread && cp variants/v2-deadline.rs cg/src-thread/crates/corten/src/deadline.rs
    cp -r cg/src-conn cg/src-sweep && python3 variants/v3-apply.py cg/src-sweep /root/dl/variants || { echo "COUNT-FAILED v3"; exit 1; }
    # `App::per_core` is the prototype branch's, not main's.
    for name in base conn thread sweep; do tar -xzf entry.tgz -C cg/src-$name; sed -i 's/app()\.per_core()/app()/' cg/src-$name/bench/httparena/corten/src/main.rs; done
fi
cp count2.py cg/
cat > cg/inside.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
{ rustc -V; valgrind --version; uname -r; grep -m1 'model name' /proc/cpuinfo; } > /w/out/host.txt 2>&1
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"
for name in "$@"; do
    (cd /w/src-$name/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$name cargo build --release > /w/out/build-$name.log 2>&1) || { tail -30 /w/out/build-$name.log; echo "COUNT-FAILED build $name"; exit 1; }
    grep -oE 'Compiling (tokio|hyper) v[0-9.]+' /w/out/build-$name.log | sort -u | tr '\n' ' '; echo
done
for mode in default percore-by-hand; do
    for name in "$@"; do
        echo "== $mode $name $(date -u +%T)"
        ARENA_MODE=$mode python3 /w/count2.py /w/target-$name/release/httparena-corten --reps 3 | tee /w/out/count-$mode-$name.txt || { echo "COUNT-FAILED count $mode $name"; exit 1; }
    done
done
for name in "$@"; do
    echo "== default, a connection for each request: $name $(date -u +%T)"
    ARENA_MODE=default python3 /w/count2.py /w/target-$name/release/httparena-corten --reps 3 --cases get,sdelay1 --each-its-own | tee /w/out/count-each-$name.txt
done
echo COUNT-DONE
EOF
docker run --rm -v /root/dl/cg:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash /w/inside.sh "$@"
echo "# DONE count"
