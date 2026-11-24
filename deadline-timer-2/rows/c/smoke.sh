#!/usr/bin/env bash
# A short run of extra.py's idle mode on form C's build, to see the script work.
set -uo pipefail
cd /root/dl
cp extra.py count2.py cg/
cat > cg/smoke-inside.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 python3 util-linux >/dev/null 2>&1 || { echo "SMOKE-FAILED packages"; exit 1; }
b=/w/target-c/release/httparena-corten
echo "ulimit -n: $(ulimit -n) hard $(ulimit -Hn)"
ARENA_MODE=default python3 /w/extra.py idle $b --reps 1 || echo "SMOKE-FAILED idle"
echo SMOKE-DONE
EOF
docker run --rm -v /root/dl/cg:/w rust:1-trixie bash /w/smoke-inside.sh > smoke.log 2>&1
echo "# SMOKE rc=$?" >> smoke.log
