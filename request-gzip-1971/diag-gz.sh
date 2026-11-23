#!/usr/bin/env bash
# Runs on the measuring droplet: the diagnostic for the zstd workload's missed margin. Builds the
# base and the candidate each with a never-called pad (the layout probes of the layout-floor
# receipt), then three comparisons on the workload, each also counting user L1 instruction-cache
# misses. Nothing here is tested against a margin.
# Usage: diag-gz.sh <base commit> <candidate commit>
set -uo pipefail
BASE=$1; CAND=$2
S=/root/kit
OUT=/root/diag-gz; mkdir -p "$OUT"; : > "$OUT/built.txt"
build() { # image name, commit, pad diff or ""
    local tree=/root/gzd-tree; rm -rf "$tree"; mkdir -p "$tree"
    git -C /root/corten-pr archive "$2" crates Cargo.toml Cargo.lock | tar -x -C "$tree" || return 1
    if [ -n "$3" ]; then patch -d "$tree" -p1 < "$S/$3" > "$OUT/patch-$1.log" 2>&1 || { echo "patch failed $1"; return 1; }; fi
    ENTRY_SRC=$S/entry-staged bash "$S/stage-corten.sh" "httparena-corten:$1" "$tree" > "$OUT/build-$1.log" 2>&1 || { echo "build failed $1"; tail -20 "$OUT/build-$1.log"; return 1; }
    echo "# built $1 from $(git -C /root/corten-pr rev-parse --short "$2") ${3:-no pad} at $(date -u +%H:%M:%S): $(docker image inspect "httparena-corten:$1" --format '{{.Id}}')" >> "$OUT/built.txt"
}
build gzd-cand-pad3100 "$CAND" pad3100.diff || exit 1
build gzd-base-pad3100 "$BASE" pad3100.diff || exit 1
run() { SECS=3 bash "$S/pair-d.sh" httparena-corten:gz-base "httparena-corten:$1" json-zstd 61 > "$OUT/$2.log" 2>&1; }
run gz-cand again
run gzd-cand-pad3100 cand-pad3100
run gzd-base-pad3100 base-pad3100
echo "# diag done $(date -u +%H:%M:%S)" >> "$OUT/built.txt"
