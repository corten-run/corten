#!/usr/bin/env bash
# Runs on the build host, after r2-count.sh: the second series of r2/rule.md. A connection for each
# request whose handler sleeps 1 ms, the client waiting 10 ms after each close, on one
# single-threaded runtime, for the three builds r2-count.sh made.
set -uo pipefail
cd /root/dl
until grep -q "R2-COUNT-DONE" r2-count.log 2>/dev/null; do sleep 10; done
cp count4.py cg/
cat > cg/inside-settle.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 python3 util-linux >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
count() {
    name=$1; round=$2
    echo "== percore-by-hand, a connection for each request, 10 ms after each close: $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand python3 /w/count4.py /w/target-$name/release/httparena-corten --reps 3 --cases sdelay1 --each-its-own --settle-ms 10 | tee /w/out/r2/count-settle-$name-$round.txt
}
for name in main built two; do count $name 1; done
for name in two built main; do count $name 2; done
echo COUNT-DONE
EOF
docker run --rm -v /root/dl/cg:/w rust:1-trixie bash /w/inside-settle.sh > r2-settle.log 2>&1
echo "# R2-SETTLE-DONE" >> r2-settle.log
