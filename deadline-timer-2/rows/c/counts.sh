#!/usr/bin/env bash
# Runs on the build host: instructions a request for main (the branch's merge base), form A and
# form C, rows 1 to 7, two rounds in opposite orders, then the settle series, allocations and
# idle bytes. Usage: counts.sh [build|count|settle|extra ...]
set -uo pipefail
cd /root/dl
mkdir -p cg/out
cp count2.py count4.py extra.py cg/
for t in main a c; do
    if [ ! -d cg/src-$t ] || [ "${REFRESH:-}" = "$t" ]; then
        rm -rf cg/src-$t && cp -r $t cg/src-$t && tar -xzf entry.tgz -C cg/src-$t
        # `App::per_core` is the prototype branch's, not main's.
        sed -i 's/app()\.per_core()/app()/' cg/src-$t/bench/httparena/corten/src/main.rs
    fi
done
cat > cg/inside.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
{ rustc -V; cargo -V; valgrind --version; uname -r; grep -m1 'model name' /proc/cpuinfo; nproc; } > /w/out/host.txt 2>&1
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"
bin() { echo /w/target-$1/release/httparena-corten; }
count() {
    mode=$1; name=$2; round=$3
    echo "== $mode $name round $round $(date -u +%T)"
    ARENA_MODE=$mode python3 /w/count2.py $(bin $name) --reps 3 | tee /w/out/count-$mode-$name-$round.txt
    echo "== $mode, a connection for each request: $name round $round $(date -u +%T)"
    ARENA_MODE=$mode python3 /w/count2.py $(bin $name) --reps 3 --cases get,sdelay1 --each-its-own | tee /w/out/count-each-$mode-$name-$round.txt
    echo "== $mode, row 7: $name round $round $(date -u +%T)"
    ARENA_MODE=$mode python3 /w/extra.py row7 $(bin $name) --reps 3 | tee /w/out/count-row7-$mode-$name-$round.txt
}
settle() {
    mode=$1; name=$2; round=$3
    echo "== $mode, a connection for each request, 10 ms after each close: $name round $round $(date -u +%T)"
    ARENA_MODE=$mode python3 /w/count4.py $(bin $name) --reps 3 --cases get,sdelay1 --each-its-own --settle-ms 10 | tee /w/out/count-settle-$mode-$name-$round.txt
}
extra() {
    name=$1
    echo "== default, allocations: $name $(date -u +%T)"
    ARENA_MODE=default python3 /w/extra.py allocs $(bin $name) --reps 3 | tee /w/out/allocs-$name.txt
    echo "== default, idle connections: $name $(date -u +%T)"
    ARENA_MODE=default python3 /w/extra.py idle $(bin $name) --reps 3 | tee /w/out/idle-$name.txt
}
for step in "$@"; do
    case $step in
        build)
            for name in main a c; do
                (cd /w/src-$name/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$name cargo build --release > /w/out/build-$name.log 2>&1) || { tail -30 /w/out/build-$name.log; echo "COUNT-FAILED build $name"; exit 1; }
                cp /w/src-$name/bench/httparena/corten/Cargo.lock /w/out/app-Cargo.lock-$name
                echo "$name: $(grep -E '^name = "(tokio|hyper)"$' -A 1 /w/out/app-Cargo.lock-$name | grep version | tr '\n' ' ') $(sha256sum < $(bin $name) | cut -c1-16)"
            done ;;
        count)
            for mode in default percore-by-hand; do
                for name in main a c; do count $mode $name 1; done
                for name in c a main; do count $mode $name 2; done
            done ;;
        settle)
            for mode in percore-by-hand default; do
                for name in main a c; do settle $mode $name 1; done
                for name in c a main; do settle $mode $name 2; done
            done ;;
        extra)
            for name in main a c; do extra $name; done ;;
    esac
    echo "STEP-DONE $step $(date -u +%T)"
done
echo COUNT-DONE
EOF
docker run --rm -v /root/dl/cg:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash /w/inside.sh "$@" > "counts-$1.log" 2>&1
echo "# COUNTS-DONE rc=$?" >> "counts-$1.log"
