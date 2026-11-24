#!/usr/bin/env bash
# Runs on the build host: where form C's instructions are (by function), and row 7 with two
# waiting requests first. Usage: attr.sh <tag> <names...>
set -uo pipefail
tag=$1; shift
names="$*"
cd /root/dl
cp attr.py extra.py count2.py cg/
mkdir -p cg/out/attr
cat > cg/attr-inside.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 python3 util-linux >/dev/null 2>&1 || { echo "ATTR-FAILED packages"; exit 1; }
bin() { echo /w/target-$1/release/httparena-corten; }
for mode in default percore-by-hand; do
    for name in "$@"; do
        echo "== $mode, two waiting requests first: $name $(date -u +%T)"
        ARENA_MODE=$mode python3 /w/attr.py count $(bin $name) --first 2 --reps 3
    done
done
for name in "$@"; do
    for scenario in get sdelay1 delay1 row7 row7x2 each-sdelay1; do
        ARENA_MODE=default python3 /w/attr.py funcs $(bin $name) $scenario /w/out/attr/$name-$scenario.txt
    done
done
echo ATTR-DONE
EOF
docker run --rm -v /root/dl/cg:/w rust:1-trixie bash /w/attr-inside.sh $names > attr-$tag.log 2>&1
echo "# ATTR rc=$?" >> attr-$tag.log
