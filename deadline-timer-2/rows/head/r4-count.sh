#!/usr/bin/env bash
# Runs on the count host: instructions and allocations a request for main (the branch's base) and
# B (the two-stage form, the tree named in $2), as r3-count.sh counted main, A and B, with
# count6.py: the seven rows of the rule that picked the form and one more (row 8: a kept-alive
# connection whose first two requests wait and whose later ones do not, which is the connection
# that has made its timer in this form), two rounds in opposite orders, three counts each.
# Usage: r4-count.sh <out name> <b tree .tgz>
set -uo pipefail
out=$1; btree=$2
cd /root/dl
mkdir -p cg/out/$out
rm -rf cg/src-main cg/target-main cg/src-b cg/target-b
mkdir -p cg/src-main cg/src-b
tar -xzf main.tgz -C cg/src-main
tar -xzf "$btree" -C cg/src-b
for name in main b; do
    tar -xzf entry.tgz -C cg/src-$name
    # `App::per_core` is the prototype branch's, not main's.
    sed -i 's/app()\.per_core()/app()/' cg/src-$name/bench/httparena/corten/src/main.rs
done
cp count6.py cg/
cat > cg/inside-r4.sh <<EOF
set -uo pipefail
OUT=$out
EOF
cat >> cg/inside-r4.sh <<'EOF'
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
O=/w/out/$OUT
{ rustc -V; cargo -V; valgrind --version; uname -r; grep -m1 'model name' /proc/cpuinfo; nproc; dpkg -s libjemalloc2 | grep Version; } > $O/host.txt 2>&1
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"
for name in main b; do
    (cd /w/src-$name/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$name cargo build --release > $O/build-$name.log 2>&1) || { tail -30 $O/build-$name.log; echo "COUNT-FAILED build $name"; exit 1; }
    cp /w/src-$name/bench/httparena/corten/Cargo.lock $O/app-Cargo.lock-$name
    echo "$name: $(grep -E '^name = "(tokio|hyper)"$' -A 1 $O/app-Cargo.lock-$name | grep version | tr '\n' ' ') $(sha256sum < /w/target-$name/release/httparena-corten | cut -c1-16)"
done
C="python3 /w/count6.py"
count() {
    name=$1; round=$2; B=/w/target-$name/release/httparena-corten
    echo "== default, kept-alive (rows 1 to 4): $name round $round $(date -u +%T)"
    ARENA_MODE=default $C $B --reps 3 --cases get,sdelay1,pipeline,delay1 --names | tee $O/count-default-$name-$round.txt
    echo "== default, a connection for each request (rows 5, 6): $name round $round $(date -u +%T)"
    ARENA_MODE=default $C $B --reps 3 --cases get,sdelay1 --each-its-own | tee $O/count-each-default-$name-$round.txt
    echo "== default, kept-alive, the first request waits (row 7): $name round $round $(date -u +%T)"
    ARENA_MODE=default $C $B --reps 3 --cases get --first sdelay1 | tee $O/count-first-default-$name-$round.txt
    echo "== default, kept-alive, the first two requests wait (row 8): $name round $round $(date -u +%T)"
    ARENA_MODE=default $C $B --reps 3 --cases get --first sdelay1 --first-count 2 | tee $O/count-first2-default-$name-$round.txt
    echo "== percore-by-hand, kept-alive (rows 1, 2): $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand $C $B --reps 3 --cases get,sdelay1 | tee $O/count-percore-by-hand-$name-$round.txt
    echo "== percore-by-hand, a connection for each request, 10 ms after each close (rows 5, 6): $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand $C $B --reps 3 --cases get,sdelay1 --each-its-own --settle-ms 10 | tee $O/count-settle-$name-$round.txt
    echo "== percore-by-hand, kept-alive, the first request waits (row 7): $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand $C $B --reps 3 --cases get --first sdelay1 | tee $O/count-first-percore-by-hand-$name-$round.txt
    echo "== percore-by-hand, kept-alive, the first two requests wait (row 8): $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand $C $B --reps 3 --cases get --first sdelay1 --first-count 2 | tee $O/count-first2-percore-by-hand-$name-$round.txt
}
for name in main b; do count $name 1; done
for name in b main; do count $name 2; done
echo COUNT-DONE
EOF
# The open-file limit is set because this host's Docker gives a container one of over 10^9, which
# valgrind refuses to start under.
docker run --rm --ulimit nofile=1048576:1048576 -v /root/dl/cg:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash /w/inside-r4.sh > $out-count.log 2>&1
echo "# R4-COUNT-DONE" >> $out-count.log
