#!/usr/bin/env bash
# Runs on the count host: instructions and allocations a request for main (the branch's base), A
# (the branch's head) and B (A with the two-stage deadline.rs), as r2-count.sh and r2-settle.sh of
# the tag evidence/deadline-timer counted main, built and two, with count5.py: the seven rows of
# the rule that picks the form, two rounds in opposite orders, three counts each.
set -uo pipefail
cd /root/dl
mkdir -p cg/out/r3
for name in main a; do
    rm -rf cg/src-$name cg/target-$name
    mkdir -p cg/src-$name && tar -xzf $name.tgz -C cg/src-$name
done
rm -rf cg/src-b cg/target-b && cp -r cg/src-a cg/src-b && cp b-deadline.rs cg/src-b/crates/corten/src/deadline.rs
for name in main a b; do
    tar -xzf entry.tgz -C cg/src-$name
    # `App::per_core` is the prototype branch's, not main's.
    sed -i 's/app()\.per_core()/app()/' cg/src-$name/bench/httparena/corten/src/main.rs
done
cp count5.py cg/
cat > cg/inside-r3.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
{ rustc -V; cargo -V; valgrind --version; uname -r; grep -m1 'model name' /proc/cpuinfo; nproc; dpkg -s libjemalloc2 | grep Version; } > /w/out/r3/host.txt 2>&1
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"
for name in main a b; do
    (cd /w/src-$name/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$name cargo build --release > /w/out/r3/build-$name.log 2>&1) || { tail -30 /w/out/r3/build-$name.log; echo "COUNT-FAILED build $name"; exit 1; }
    cp /w/src-$name/bench/httparena/corten/Cargo.lock /w/out/r3/app-Cargo.lock-$name
    echo "$name: $(grep -E '^name = "(tokio|hyper)"$' -A 1 /w/out/r3/app-Cargo.lock-$name | grep version | tr '\n' ' ') $(sha256sum < /w/target-$name/release/httparena-corten | cut -c1-16)"
done
C="python3 /w/count5.py"
count() {
    name=$1; round=$2; B=/w/target-$name/release/httparena-corten; O=/w/out/r3
    echo "== default, kept-alive (rows 1 to 4): $name round $round $(date -u +%T)"
    ARENA_MODE=default $C $B --reps 3 --cases get,sdelay1,pipeline,delay1 --names | tee $O/count-default-$name-$round.txt
    echo "== default, a connection for each request (rows 5, 6): $name round $round $(date -u +%T)"
    ARENA_MODE=default $C $B --reps 3 --cases get,sdelay1 --each-its-own | tee $O/count-each-default-$name-$round.txt
    echo "== default, kept-alive, the first request waits (row 7): $name round $round $(date -u +%T)"
    ARENA_MODE=default $C $B --reps 3 --cases get --first sdelay1 | tee $O/count-first-default-$name-$round.txt
    echo "== percore-by-hand, kept-alive (rows 1, 2): $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand $C $B --reps 3 --cases get,sdelay1 | tee $O/count-percore-by-hand-$name-$round.txt
    echo "== percore-by-hand, a connection for each request, 10 ms after each close (rows 5, 6): $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand $C $B --reps 3 --cases get,sdelay1 --each-its-own --settle-ms 10 | tee $O/count-settle-$name-$round.txt
    echo "== percore-by-hand, kept-alive, the first request waits (row 7): $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand $C $B --reps 3 --cases get --first sdelay1 | tee $O/count-first-percore-by-hand-$name-$round.txt
}
for name in main a b; do count $name 1; done
for name in b a main; do count $name 2; done
echo COUNT-DONE
EOF
# The open-file limit is set because this host's Docker gives a container one of over 10^9, which
# valgrind refuses to start under.
docker run --rm --ulimit nofile=1048576:1048576 -v /root/dl/cg:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash /w/inside-r3.sh > r3-count.log 2>&1
echo "# R3-COUNT-DONE" >> r3-count.log
