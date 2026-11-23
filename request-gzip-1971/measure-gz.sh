#!/usr/bin/env bash
# Runs on the measuring droplet: the under-load measurement for the gzip change, from the exact
# commits of the clone in /root/corten-pr. Usage: measure-gz.sh <base commit> <candidate commit>
set -uo pipefail
BASE=$1; CAND=$2
S=/root/kit; REQ=/root/work/httparena-gap/HttpArena/requests
OUT=/root/measure-gz; mkdir -p "$OUT"
for n in 25 40 50; do sed 's/^Accept-Encoding: .*/Accept-Encoding: gzip, deflate, br, zstd\r/' "$REQ/json-gzip-$n.raw" > "$REQ/json-zstd-$n.raw"; done
grep -c "zstd" "$REQ/json-zstd-25.raw" > /dev/null || { echo "no zstd request file"; exit 1; }
for side in base cand; do
    commit=$BASE; [ "$side" = cand ] && commit=$CAND
    tree=/root/gzm-$side; rm -rf "$tree"; mkdir -p "$tree"
    git -C /root/corten-pr archive "$commit" crates Cargo.toml Cargo.lock | tar -x -C "$tree" || exit 1
    ENTRY_SRC=$S/entry-staged bash "$S/stage-corten.sh" "httparena-corten:gz-$side" "$tree" > "$OUT/build-$side.log" 2>&1 || { echo "build failed $side"; tail -20 "$OUT/build-$side.log"; exit 1; }
done
echo "# built at $(date -u +%H:%M:%S): base $(git -C /root/corten-pr rev-parse --short "$BASE") candidate $(git -C /root/corten-pr rev-parse --short "$CAND")" > "$OUT/built.txt"
SECS=3 PROBE_SKIP='^(date|content-encoding|etag|content-length|transfer-encoding):' bash "$S/pair.sh" httparena-corten:gz-base httparena-corten:gz-cand json-gzbr 41 > "$OUT/gzbr.log" 2>&1
SECS=3 bash "$S/pair.sh" httparena-corten:gz-base httparena-corten:gz-cand json-zstd 61 > "$OUT/zstd.log" 2>&1
SECS=3 bash "$S/pair.sh" httparena-corten:gz-base httparena-corten:gz-cand get-only 61 > "$OUT/identity.log" 2>&1
echo "# measure done $(date -u +%H:%M:%S)" >> "$OUT/built.txt"
