#!/usr/bin/env bash
# Runs on the build host: where each build's instructions are, by function, and the differences.
set -uo pipefail
cd /root/dl
cp attr.py extra.py count2.py cg/
mkdir -p cg/out/attr
cat > cg/attr2-inside.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 python3 util-linux >/dev/null 2>&1 || { echo "ATTR-FAILED packages"; exit 1; }
bin() { echo /w/target-$1/release/httparena-corten; }
for name in main a c; do
    for scenario in get sdelay1 delay1 row7 row7x2 each-sdelay1; do
        ARENA_MODE=default python3 /w/attr.py funcs $(bin $name) $scenario /w/out/attr/$name-$scenario.txt || echo "ATTR-FAILED $name $scenario"
    done
done
cd /w/out/attr
for pair in "main c get" "main c row7" "main a row7x2" "a c sdelay1" "main c sdelay1" "main c delay1" "main c each-sdelay1" "a c each-sdelay1"; do
    set -- $pair
    echo "== $3: $1 to $2"
    python3 /w/attr.py diff $1-$3.txt $2-$3.txt --least 4 | cut -c1-190
done
echo ATTR-DONE
EOF
docker run --rm -v /root/dl/cg:/w rust:1-trixie bash /w/attr2-inside.sh > attr-two.log 2>&1
echo "# ATTR rc=$?" >> attr-two.log
