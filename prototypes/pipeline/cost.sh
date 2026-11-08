#!/bin/sh
# Instructions per request for each variant of examples/cost.rs under callgrind: a run of N2
# requests less a run of N1, over N2 - N1, so startup and setup cancel out. Variants alternate
# within each repeat. Run in an image with valgrind, the release build of the example at $BIN:
#   VARIANTS="raw api corten" REPEATS=5 sh cost.sh > results.tsv
set -eu
BIN=${BIN:-/target/release/examples/cost}
N1=${N1:-200}
N2=${N2:-1200}
VARIANTS=${VARIANTS:-"raw router host same-origin cancel deadline panic secure cache errors api api-on-route secure-presized api-presized signal-cx signal-ext axum corten"}
count() {
  valgrind --tool=callgrind --callgrind-out-file=/dev/null "$BIN" "$1" "$2" 2>&1 | sed -n 's/.*Collected : \([0-9]*\).*/\1/p'
}
printf 'repeat\tvariant\tper_request\n'
for repeat in $(seq "${REPEATS:-5}"); do
  for v in $VARIANTS; do
    a=$(count "$v" "$N1")
    b=$(count "$v" "$N2")
    printf '%s\t%s\t%s\n' "$repeat" "$v" "$(( (b - a) / (N2 - N1) ))"
  done
done