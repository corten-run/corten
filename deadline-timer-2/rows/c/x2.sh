#!/usr/bin/env bash
# Runs on the build host: row 7 with two waiting requests first, for every build.
set -uo pipefail
cd /root/dl
cp attr.py extra.py count2.py cg/
cat > cg/x2-inside.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 python3 util-linux >/dev/null 2>&1 || { echo "X2-FAILED packages"; exit 1; }
for mode in default percore-by-hand; do
    for name in main a c d t; do
        echo "== $mode, two waiting requests first: $name $(sha256sum < /w/target-$name/release/httparena-corten | cut -c1-16)"
        ARENA_MODE=$mode python3 /w/attr.py count /w/target-$name/release/httparena-corten --first 2 --reps 3
    done
done
echo X2-DONE
EOF
docker run --rm -v /root/dl/cg:/w rust:1-trixie bash /w/x2-inside.sh > x2.log 2>&1
echo "# X2 rc=$?" >> x2.log
