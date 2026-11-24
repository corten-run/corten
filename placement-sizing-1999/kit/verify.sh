#!/bin/sh
# verify.sh <out dir>: every binary a comparison reads answers as base's or its side's unpadded
# binary does, before anything is recorded (run.sh runs it first; kit 1983's verify.sh, with the
# two unpadded builds of other commits added). For each bin/<side>-p<pad>, both it and bin/<side>
# are started with the probe's `old` config, and for x1 and x2 both it and bin/base; then
# run-pair-old.sh, with no pair, compares their answers to GET /picture.png as the workload `old`
# asks for it: made, given kept while young, and given kept once the clock has moved, twice. The
# status, every header line but Date and the body as received must be the same; only the Age's
# value is set aside for the comparison, and it is checked against its range instead (0 to 5
# while young, plan.env's OLD_LOW to OLD_HIGH once moved). Any difference stops: the binary is not
# the same program to the request. Writes <out dir>/<name>/ and <out dir>/verdicts.txt, one line a
# binary: "<binary> as <reference>: checked 4 answers ...". Each check is stopped (and fails) after
# PLACEMENT_TIMEOUT s (plan.md, Amendment 1).
set -eu
. /m/1999/plan.sh
out=$1
mkdir -p "$out"; : >"$out/verdicts.txt"
one() { # <reference> <binary>
    d=$out/$2
    WARMUP=0 timeout -k 30 "$PLACEMENT_TIMEOUT" taskset -c 7 sh $P/run-pair-old.sh "$d" old 0 2 4,5 "$J $P/bin/$1 \$PORT old" "$J $P/bin/$2 \$PORT old" >"$d.log" 2>&1 \
        || { cat "$d.log"; echo "VERIFY FAILED: $2 against $1"; exit 1; }
    echo "$2 as $1: $(sed -n 1p "$d/answers-old/verdict.txt")" | tee -a "$out/verdicts.txt"
}
for n in $PADS_P $PADS_Q; do one base base-p$n; done
for n in $HEAD_PADS; do one head head-p$n; done
one base x1
one base x2
echo "verify: $(wc -l <"$out/verdicts.txt") binaries answer as their reference"