#!/bin/bash
# Inside the count image: the session of r6-count.sh (tag evidence/deadline-timer-3,
# deadline-timer-3/rows/) for four trees: the branch before this merge as the control (main:
# 26ab0e37f, b: f8934bc99) and main as merged against the merge (newbase: d15d3ac3a, merge:
# ffc686e39). Rows 1 to 4, 5 and 6 and 9, both runtimes, two rounds in opposite orders, three
# counts each, by that tag's count6.py. Each build takes its tree's own Cargo.lock.
set -uo pipefail
export ZSTD_SYS_USE_PKG_CONFIG=1 CARGO_TERM_COLOR=never
NAMES="main b newbase merge"
O=/s/out/rows
mkdir -p $O
cp /s/ev/count6.py /w/count6.py
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"
for name in $NAMES; do
    tar -xzf /s/entry.tgz -C /w/src-$name || { echo "COUNT-FAILED entry $name"; exit 1; }
    # `App::per_core` is the prototype branch's, not main's.
    sed -i 's/app()\.per_core()/app()/' /w/src-$name/bench/httparena/corten/src/main.rs
    cp /w/src-$name/Cargo.lock /w/src-$name/bench/httparena/corten/Cargo.lock
    (cd /w/src-$name/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$name cargo build --release -j 5 > $O/build-$name.log 2>&1) || { tail -30 $O/build-$name.log; echo "COUNT-FAILED build $name"; exit 1; }
    cp /w/src-$name/bench/httparena/corten/Cargo.lock $O/app-Cargo.lock-$name
    cp /w/target-$name/release/httparena-corten /w/bin/$name
    echo "$name: $(grep -E '^name = "(tokio|hyper)"$' -A 1 $O/app-Cargo.lock-$name | grep version | tr '\n' ' ') $(sha256sum < /w/target-$name/release/httparena-corten | cut -c1-16) $(date -u +%T)" | tee -a $O/built.txt
done
unset RUSTFLAGS
echo "ROWS-BUILT $(date -u +%T)"
C="python3 /w/count6.py"
count() {
    name=$1; round=$2; B=/w/target-$name/release/httparena-corten
    echo "== default, kept-alive (rows 1 to 4): $name round $round $(date -u +%T)"
    ARENA_MODE=default $C $B --reps 3 --cases get,sdelay1,pipeline,delay1 --names | tee $O/count-default-$name-$round.txt
    echo "== default, a connection for each request (rows 5, 6): $name round $round $(date -u +%T)"
    ARENA_MODE=default $C $B --reps 3 --cases get,sdelay1 --each-its-own | tee $O/count-each-default-$name-$round.txt
    echo "== default, kept-alive, the first three requests wait (row 9): $name round $round $(date -u +%T)"
    ARENA_MODE=default $C $B --reps 3 --cases get --first sdelay1 --first-count 3 | tee $O/count-first3-default-$name-$round.txt
    echo "== percore-by-hand, kept-alive (rows 1, 2): $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand $C $B --reps 3 --cases get,sdelay1 | tee $O/count-percore-by-hand-$name-$round.txt
    echo "== percore-by-hand, a connection for each request, 10 ms after each close (rows 5, 6): $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand $C $B --reps 3 --cases get,sdelay1 --each-its-own --settle-ms 10 | tee $O/count-settle-$name-$round.txt
    echo "== percore-by-hand, kept-alive, the first three requests wait (row 9): $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand $C $B --reps 3 --cases get --first sdelay1 --first-count 3 | tee $O/count-first3-percore-by-hand-$name-$round.txt
}
for name in main b newbase merge; do count $name 1; done
for name in merge newbase b main; do count $name 2; done
echo "COUNT-DONE $(date -u +%T)"
