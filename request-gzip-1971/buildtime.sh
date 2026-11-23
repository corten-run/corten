#!/usr/bin/env bash
# Runs on the check droplet: wall time of a clean release build of card-market as its image
# builds it (zstd linked to the build image's libzstd), before and after the change, the two
# taking turns. Usage: buildtime.sh <base commit> <candidate commit> [rounds]
set -uo pipefail
BASE=$1; CAND=$2; ROUNDS=${3:-3}
OUT=/root/buildtime.out; : > "$OUT"
for side in base cand; do
    commit=$BASE; [ "$side" = cand ] && commit=$CAND
    rm -rf "/root/bt-$side"; mkdir -p "/root/bt-$side"
    git -C /root/corten-pr archive "$commit" | tar -x -C "/root/bt-$side" || exit 1
done
one() {
    docker volume rm -f bt-target >/dev/null 2>&1
    docker volume create bt-target >/dev/null
    local start=$(date +%s.%N)
    docker run --rm -v "/root/bt-$1:/src" -v corten-cargo:/usr/local/cargo/registry \
        -v bt-target:/target -e CARGO_TARGET_DIR=/target -e ZSTD_SYS_USE_PKG_CONFIG=1 -w /src rust:1-trixie \
        sh -c 'cargo build --release --locked -p card-market 2>&1 | tail -1; stat -c "binary %s bytes" /target/release/card-market' > /root/bt-last.log 2>&1
    local end=$(date +%s.%N)
    echo "round $2 $1 $(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.1f", b - a }') s | $(tr '\n' ' ' < /root/bt-last.log)" >> "$OUT"
}
one cand 0   # not recorded: fills the registry cache for both
for r in $(seq 1 "$ROUNDS"); do
    if [ $((r % 2)) = 1 ]; then one base "$r"; one cand "$r"; else one cand "$r"; one base "$r"; fi
done
docker volume rm -f bt-target >/dev/null 2>&1
echo "# buildtime done" >> "$OUT"
