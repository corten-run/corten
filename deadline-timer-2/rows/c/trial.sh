#!/usr/bin/env bash
# Runs on the build host: builds the tree in /root/dl/c as <name> and counts it once on the
# kept-alive rows, to compare a change to form C with the build before it. Usage: trial.sh <name>
set -uo pipefail
name=$1
cd /root/dl
rm -rf keep1 && mkdir keep1 && cp -r cg/out keep1/ && cp counts-count.log counts-par.log attr-one.log attr-two.log keep1/
rm -rf cg/src-$name && cp -r c cg/src-$name && tar -xzf entry.tgz -C cg/src-$name
sed -i 's/app()\.per_core()/app()/' cg/src-$name/bench/httparena/corten/src/main.rs
cp attr.py extra.py count2.py cg/
cat > cg/trial-inside.sh <<'EOF'
set -uo pipefail
name=$1
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux >/dev/null 2>&1 || { echo "TRIAL-FAILED packages"; exit 1; }
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"
(cd /w/src-$name/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$name cargo build --release > /w/out/build-$name.log 2>&1) || { tail -30 /w/out/build-$name.log; echo "TRIAL-FAILED build"; exit 1; }
b=/w/target-$name/release/httparena-corten
sha256sum < $b | cut -c1-16
for mode in default percore-by-hand; do
    echo "== $mode $name"
    ARENA_MODE=$mode python3 /w/count2.py $b --reps 1
    ARENA_MODE=$mode python3 /w/extra.py row7 $b --reps 1
done
for scenario in get sdelay1; do
    ARENA_MODE=default python3 /w/attr.py funcs $b $scenario /w/out/attr/$name-$scenario.txt
done
cd /w/out/attr
echo "== get: main to $name"; python3 /w/attr.py diff main-get.txt $name-get.txt --least 4 | cut -c1-170
echo "== sdelay1: a to $name"; python3 /w/attr.py diff a-sdelay1.txt $name-sdelay1.txt --least 4 | cut -c1-170
echo TRIAL-DONE
EOF
docker run --rm -v /root/dl/cg:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash /w/trial-inside.sh "$name" > trial-$name.log 2>&1
echo "# TRIAL rc=$?" >> trial-$name.log
