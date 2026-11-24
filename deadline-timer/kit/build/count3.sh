#!/usr/bin/env bash
# Runs on the build host: counts instructions a request for the tree base + <patch>, as
# count.sh does for the first four. Usage: count3.sh <name> <patch>
set -uo pipefail
name=$1; patch=$2
cd /root/dl
rm -rf cg/src-$name cg/target-$name
cp -r cg/src-base cg/src-$name
(cd cg/src-$name && git apply --whitespace=nowarn "/root/dl/$patch") || { echo "COUNT-FAILED patch"; exit 1; }
cp count2.py cg/
cat > cg/inside3.sh <<'EOF'
set -uo pipefail
name=$1
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"
(cd /w/src-$name/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$name cargo build --release > /w/out/build-$name.log 2>&1) || { tail -30 /w/out/build-$name.log; echo "COUNT-FAILED build $name"; exit 1; }
grep -oE 'Compiling (tokio|hyper) v[0-9.]+' /w/out/build-$name.log | sort -u | tr '\n' ' '; echo
for mode in default percore-by-hand; do
    echo "== $mode $name $(date -u +%T)"
    ARENA_MODE=$mode python3 /w/count2.py /w/target-$name/release/httparena-corten --reps 3 | tee /w/out/count-$mode-$name.txt
done
echo "== default, a connection for each request: $name $(date -u +%T)"
ARENA_MODE=default python3 /w/count2.py /w/target-$name/release/httparena-corten --reps 3 --cases get,sdelay1 --each-its-own | tee /w/out/count-each-$name.txt
echo COUNT-DONE
EOF
docker run --rm -v /root/dl/cg:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash /w/inside3.sh "$name"
echo "# DONE count3 $name"
