#!/usr/bin/env bash
# Runs on the build host after the counts: two scratch variants of form C's slot, never committed.
# d: the first deadline to wait waits on its own timer and leaves the connection one not yet set.
# t: the first leaves a mark, the second makes the connection's timer.
set -uo pipefail
cd /root/dl
until grep -q "COUNTS-DONE" counts-count.log 2>/dev/null && grep -q "COUNTS-DONE" counts-par.log 2>/dev/null; do sleep 10; done
: > variants.status
for v in d t; do
    rm -rf var-$v && cp -r c var-$v && cp variant-deadline.rs var-$v/crates/corten/src/deadline.rs
    [ $v = t ] && sed -i 's/const TWO_STAGE: bool = false;/const TWO_STAGE: bool = true;/' var-$v/crates/corten/src/deadline.rs
    grep -n "const TWO_STAGE" var-$v/crates/corten/src/deadline.rs
    docker run --rm -v "/root/dl/var-$v:/src" -v corten-cargo:/usr/local/cargo/registry -v corten-target-c:/target \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
        cargo test -p corten-run --all-features --lib > lib-var-$v.log 2>&1
    echo "# lib-$v rc=$?" >> variants.status
    rm -rf cg/src-$v && cp -r var-$v cg/src-$v && tar -xzf entry.tgz -C cg/src-$v
    sed -i 's/app()\.per_core()/app()/' cg/src-$v/bench/httparena/corten/src/main.rs
done
cp count2.py count4.py extra.py cg/
cat > cg/variants-inside.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"
bin() { echo /w/target-$1/release/httparena-corten; }
for name in d t; do
    (cd /w/src-$name/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$name cargo build --release > /w/out/build-$name.log 2>&1) || { tail -30 /w/out/build-$name.log; echo "COUNT-FAILED build $name"; exit 1; }
    echo "$name: $(sha256sum < $(bin $name) | cut -c1-16)"
done
for name in d t; do
    for mode in default percore-by-hand; do
        echo "== $mode $name $(date -u +%T)"
        ARENA_MODE=$mode python3 /w/count2.py $(bin $name) --reps 3
        echo "== $mode, a connection for each request: $name"
        ARENA_MODE=$mode python3 /w/count2.py $(bin $name) --reps 3 --cases get,sdelay1 --each-its-own
        echo "== $mode, row 7: $name"
        ARENA_MODE=$mode python3 /w/extra.py row7 $(bin $name) --reps 3
        echo "== $mode, a connection for each request, 10 ms after each close: $name"
        ARENA_MODE=$mode python3 /w/count4.py $(bin $name) --reps 3 --cases sdelay1 --each-its-own --settle-ms 10
    done
    echo "== default, allocations: $name"
    ARENA_MODE=default python3 /w/extra.py allocs $(bin $name) --reps 1
    echo "== default, idle connections: $name"
    ARENA_MODE=default python3 /w/extra.py idle $(bin $name) --reps 1
done
echo COUNT-DONE
EOF
docker run --rm -v /root/dl/cg:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash /w/variants-inside.sh > variants.log 2>&1
echo "# VARIANTS-DONE rc=$?" >> variants.status
