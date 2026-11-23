#!/bin/sh
# verify.sh <out dir>: every placement build.sh made answers as its side's unpadded binary does,
# before anything is recorded (run.sh runs it first). For each bin/<side>-p<pad>, both it and
# bin/<side> are started with the probe's `old` config and run-pair-old.sh, with no pair,
# compares their answers to GET /picture.png as the workload `old` asks for it: made, given kept
# while young, and given kept once the clock has moved, twice. The status, every header line but
# Date and the body as received must be the same; only the Age's value is set aside for the
# comparison, and it is checked against its range instead (0 to 5 while young, plan.env's
# OLD_LOW to OLD_HIGH once moved). So each placement is shown to send the same answer on both
# paths of the change: an Age from the table and an Age past it. Any difference stops: the
# placement is not the same program. Writes <out dir>/<side>-p<pad>/ and <out dir>/verdicts.txt.
set -eu
P=/m/1983; out=$1
. $P/plan.sh
mkdir -p "$out"; : >"$out/verdicts.txt"
one() { # <side> <pad>
    d=$out/$1-p$2
    WARMUP=0 taskset -c 7 sh $P/run-pair-old.sh "$d" old 0 2 4,5 "$J $P/bin/$1 \$PORT old" "$J $P/bin/$1-p$2 \$PORT old" >"$d.log" 2>&1 \
        || { cat "$d.log"; echo "VERIFY FAILED: $1-p$2 against $1"; exit 1; }
    echo "$1-p$2 as $1: $(sed -n 2p "$d/answers-old/verdict.txt")" | tee -a "$out/verdicts.txt"
}
for n in $PADS_P $PADS_Q; do one base $n; done
for n in $PADS_P; do one head $n; done
echo "verify: $(wc -l <"$out/verdicts.txt") placements answer as their unpadded binary"
