#!/bin/sh
# selftest.sh <workload>: after build.sh, shows that what must stop a turn from counting does.
# Not a measurement; it writes under /m/dl/selftest/out and nothing in results/.
#   1. a wrong answer: side B is a stand-in that answers 200 with another body (wrong.mjs).
#      run-pair-fresh.sh must fail before any turn, and leave no counts file.
#   2. a failed request: the answers are checked on the workload's own request and found the
#      same, then the load is sent to a path the probe answers 404. wrk reports the status
#      errors, the turn must fail, and no row may be recorded for it.
#   3. a placement past its time limit: the same placement run under `timeout 1` must be stopped
#      and leave no recorded pair.
# Prints one line a test and SELFTEST-OK, or stops at the first that does not hold.
set -u
W=${1:-}
. /m/dl/plan.sh
out=$P/selftest/out; rm -rf "$out"; mkdir -p "$out"
# The workload's mask is verify.sh's to write (a weak ETag keyed per start is masked).
[ -f $P/masks/$W.sed ] || sh $P/verify.sh "$W" "$out/verify" >"$out/verify.log" 2>&1 || { tail -5 "$out/verify.log"; echo "SELFTEST FAILED: verify.sh"; exit 1; }
first=$(nth 1 "$PADS_P")
base="$J $P/bin/base-p$first \$PORT plain"
run() { # <dir> <path> <B command> [<timeout>]
    WARMUP=1 TURN=1 EVENTS=$EVENTS CHECKS=$P/checks-$W.txt MASK=$P/masks/$W.sed \
        timeout -k 30 "${4:-120}" taskset -c 7 sh $P/run-pair-fresh.sh "$1" "$W" 1 2 4,5 "$2" $P/lua/$lua "$base" "$3" >"$1.log" 2>&1 </dev/null
}
rows() { if [ -f "$1/counts-$W.csv" ]; then echo $(( $(wc -l <"$1/counts-$W.csv") - 1 )); else echo none; fi; }

mkdir -p "$out"
run "$out/wrong" "$path" "node $P/selftest/wrong.mjs \$PORT"; rc=$?
[ $rc != 0 ] && grep -q "base and head answer differently" "$out/wrong.log" && [ "$(rows "$out/wrong")" = none ] \
    || { echo "SELFTEST FAILED: a wrong answer did not stop the placement (exit $rc, rows $(rows "$out/wrong"))"; tail -5 "$out/wrong.log"; exit 1; }
echo "1. wrong answer: stopped before any turn (exit $rc, no counts file): $(grep -m1 'answer differently' "$out/wrong.log")"

run "$out/failed" /no-such-path "$base"; rc=$?
[ $rc != 0 ] && grep -q "errors in pair" "$out/failed.log" && [ "$(rows "$out/failed")" = 0 ] \
    || { echo "SELFTEST FAILED: failed requests did not stop the turn (exit $rc, rows $(rows "$out/failed"))"; tail -5 "$out/failed.log"; exit 1; }
echo "2. failed requests: the turn was not recorded (exit $rc, 0 rows): $(grep -m1 'errors in pair' "$out/failed.log")"

run "$out/slow" "$path" "$base" 1; rc=$?
{ [ $rc = 124 ] || [ $rc = 137 ]; } && { [ "$(rows "$out/slow")" = none ] || [ "$(rows "$out/slow")" = 0 ]; } \
    || { echo "SELFTEST FAILED: the time limit did not stop the placement (exit $rc, rows $(rows "$out/slow"))"; exit 1; }
sleep 2
! curl -s -o /dev/null http://127.0.0.1:18081/ </dev/null && ! curl -s -o /dev/null http://127.0.0.1:18082/ </dev/null \
    || { echo "SELFTEST FAILED: a server was left running after the time limit"; exit 1; }
echo "3. time limit: stopped (exit $rc), no recorded pair, no server left"
echo SELFTEST-OK
