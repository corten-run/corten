#!/usr/bin/env bash
# Runs on the count host after r4-count.sh has built its two binaries (main, the branch's base,
# and B, the two-stage form): one more row with count6.py, row 9, a kept-alive connection whose
# first three requests wait and whose later ones do not, the later ones counted. On this form the
# third request to wait is the first to set the connection's timer, so this is the connection
# whose kept timer is in the runtime's wheel while it serves requests that do not wait. Two rounds
# in opposite orders, three counts each. Usage: r5-count.sh <out name>
set -uo pipefail
out=$1
cd /root/dl
mkdir -p cg/out/$out
cat > cg/inside-r5.sh <<EOF
set -uo pipefail
OUT=$out
EOF
cat >> cg/inside-r5.sh <<'EOF'
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 python3 util-linux >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
O=/w/out/$OUT
for name in main b; do echo "$name: $(sha256sum < /w/target-$name/release/httparena-corten | cut -c1-16)"; done
C="python3 /w/count6.py"
count() {
    name=$1; round=$2; B=/w/target-$name/release/httparena-corten
    echo "== default, kept-alive, the first three requests wait (row 9): $name round $round $(date -u +%T)"
    ARENA_MODE=default $C $B --reps 3 --cases get --first sdelay1 --first-count 3 | tee $O/count-first3-default-$name-$round.txt
    echo "== percore-by-hand, kept-alive, the first three requests wait (row 9): $name round $round $(date -u +%T)"
    ARENA_MODE=percore-by-hand $C $B --reps 3 --cases get --first sdelay1 --first-count 3 | tee $O/count-first3-percore-by-hand-$name-$round.txt
}
for name in main b; do count $name 1; done
for name in b main; do count $name 2; done
echo COUNT-DONE
EOF
docker run --rm --ulimit nofile=1048576:1048576 -v /root/dl/cg:/w rust:1-trixie bash /w/inside-r5.sh > $out-count9.log 2>&1
echo "# R5-COUNT-DONE" >> $out-count9.log
