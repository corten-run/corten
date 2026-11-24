#!/usr/bin/env bash
# Runs on the build host: instructions a request for the merged base (main), the change with the
# review's fixes (built) and the two-stage variant over it (two), on one single-threaded runtime and
# on the multi-threaded one, kept-alive and with a connection for each request. See r2/rule.md.
set -uo pipefail
cd /root/dl
for name in built two; do
    rm -rf cg/src-$name cg/target-$name
    cp -r cg/src-head cg/src-$name
    cp r2/$name-deadline.rs cg/src-$name/crates/corten/src/deadline.rs
done
cp count2.py cg/
cat > cg/inside-r2.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"
mkdir -p /w/out/r2
for name in main built two; do
    (cd /w/src-$name/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$name cargo build --release > /w/out/r2/build-$name.log 2>&1) || { tail -30 /w/out/r2/build-$name.log; echo "COUNT-FAILED build $name"; exit 1; }
    cp /w/src-$name/bench/httparena/corten/Cargo.lock /w/out/r2/app-Cargo.lock-$name
    echo "$name: $(grep -E '^name = "(tokio|hyper)"$' -A 1 /w/out/r2/app-Cargo.lock-$name | grep version | tr '\n' ' ') $(sha256sum < /w/target-$name/release/httparena-corten | cut -c1-16)"
done
count() {
    mode=$1; name=$2; round=$3
    echo "== $mode $name round $round $(date -u +%T)"
    ARENA_MODE=$mode python3 /w/count2.py /w/target-$name/release/httparena-corten --reps 3 | tee /w/out/r2/count-$mode-$name-$round.txt
    echo "== $mode, a connection for each request: $name round $round $(date -u +%T)"
    ARENA_MODE=$mode python3 /w/count2.py /w/target-$name/release/httparena-corten --reps 3 --cases get,sdelay1 --each-its-own | tee /w/out/r2/count-each-$mode-$name-$round.txt
}
for mode in percore-by-hand default; do
    for name in main built two; do count $mode $name 1; done
    for name in two built main; do count $mode $name 2; done
done
echo COUNT-DONE
EOF
docker run --rm -v /root/dl/cg:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash /w/inside-r2.sh > r2-count.log 2>&1
echo "# R2-COUNT-DONE" >> r2-count.log
