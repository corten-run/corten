#!/usr/bin/env bash
# Runs on the build host beside counts.sh's `count` step, in a container of its own with the
# server held to CPU 8 instead of CPU 0: the settle series, then allocations and idle bytes.
set -uo pipefail
cd /root/dl
sed 's/"taskset", "-c", "0"/"taskset", "-c", "8"/' count4.py > cg/count4-cpu8.py
sed 's/"taskset", "-c", "0"/"taskset", "-c", "8"/' extra.py > cg/extra-cpu8.py
grep -c '"-c", "8"' cg/count4-cpu8.py cg/extra-cpu8.py
cp count2.py cg/
cat > cg/inside2.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 python3 util-linux >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
bin() { echo /w/target-$1/release/httparena-corten; }
settle() {
    mode=$1; name=$2; round=$3
    echo "== $mode, a connection for each request, 10 ms after each close: $name round $round $(date -u +%T)"
    ARENA_MODE=$mode python3 /w/count4-cpu8.py $(bin $name) --reps 3 --cases get,sdelay1 --each-its-own --settle-ms 10 | tee /w/out/count-settle-$mode-$name-$round.txt
}
extra() {
    name=$1
    echo "== default, allocations: $name $(date -u +%T)"
    ARENA_MODE=default python3 /w/extra-cpu8.py allocs $(bin $name) --reps 3 | tee /w/out/allocs-$name.txt
    echo "== default, idle connections: $name $(date -u +%T)"
    ARENA_MODE=default python3 /w/extra-cpu8.py idle $(bin $name) --reps 3 | tee /w/out/idle-$name.txt
}
for name in main a c; do extra $name; done
echo "STEP-DONE extra $(date -u +%T)"
for mode in percore-by-hand default; do
    for name in main a c; do settle $mode $name 1; done
    for name in c a main; do settle $mode $name 2; done
done
echo "STEP-DONE settle $(date -u +%T)"
echo COUNT-DONE
EOF
docker run --rm -v /root/dl/cg:/w rust:1-trixie bash /w/inside2.sh > counts-par.log 2>&1
echo "# COUNTS-DONE rc=$?" >> counts-par.log
