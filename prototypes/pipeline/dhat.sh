#!/bin/sh
# Allocations and bytes allocated per request for each variant of examples/cost.rs under dhat: a
# run of N2 requests less a run of N1, over N2 - N1, as cost.sh does. One run of each count; the
# counts do not vary between runs. Run in an image with valgrind, the release build at $BIN:
#   VARIANTS="raw api corten" sh dhat.sh > results/dhat.tsv
set -eu
BIN=${BIN:-/target/release/examples/cost}
N1=${N1:-200}
N2=${N2:-1200}
VARIANTS=${VARIANTS:-"raw router api api-wait api-on-route signal-cx signal-ext axum corten"}
OUT=${TMPDIR:-/tmp}/dhat.$$
# dhat's summary line: "Total:     2,352,000 bytes in 8,000 blocks".
count() {
  valgrind --tool=dhat --dhat-out-file=/dev/null "$BIN" "$1" "$2" > "$OUT" 2>&1
  sed -n 's/.*Total: *\([0-9,]*\) bytes in \([0-9,]*\) blocks.*/\1 \2/p' "$OUT" | tr -d ,
}
printf 'variant\tallocations\tbytes\n'
for v in $VARIANTS; do
  set -- $(count "$v" "$N1")
  a_bytes=$1 a_blocks=$2
  set -- $(count "$v" "$N2")
  printf '%s\t%s\t%s\n' "$v" "$(( ($2 - a_blocks) / (N2 - N1) ))" "$(( ($1 - a_bytes) / (N2 - N1) ))"
done
rm -f "$OUT"
