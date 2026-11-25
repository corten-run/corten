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
#   4. for `after` alone: state.mjs's own self-test, made-up captures that hold its rule and that
#      break each part of it.
#   5. for `beside` and `besidemt`: an idle connection that does not get its three answers. The
#      turn must fail and no row may be recorded for it.
#   6. report.mjs's own self-test (report-selftest.mjs, node alone): made-up results it must read
#      and ones it must refuse or leave incomplete.
#   7. for `beside` and `besidemt` (printed after 5): park.mjs's own self-test, made-up records of
#      a server's waits that hold each side's rule and that break it.
# Prints one line a test and SELFTEST-OK, or stops at the first that does not hold.
set -u
W=${1:-}
. /m/dl/plan.sh
out=$P/selftest/out; rm -rf "$out"; mkdir -p "$out"
# The workload's mask is verify.sh's to write (a weak ETag keyed per start is masked).
[ -f $P/masks/$W.sed ] || sh $P/verify.sh "$W" "$out/verify" >"$out/verify.log" 2>&1 || { tail -5 "$out/verify.log"; echo "SELFTEST FAILED: verify.sh"; exit 1; }
first=$(nth 1 "$PADS_P")
base="$J $P/bin/base-p$first \$PORT $conf"
run() { # <dir> <path> <B command> [<timeout> [<idle path>]]
    WARMUP=1 TURN=1 EVENTS=$EVENTS CHECKS=$P/checks-$W.txt MASK=$P/masks/$W.sed LOAD_T=$load_t LOAD_C=$load_c IDLE=${5-$idle} \
        timeout -k 30 "${4:-120}" taskset -c 7 sh $P/run-pair-fresh.sh "$1" "$W" 1 2 "$load_cpus" "$2" $P/lua/$lua "$base" "$3" >"$1.log" 2>&1 </dev/null
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
if [ "$W" = after ]; then
    node $P/state.mjs --selftest >"$out/state-selftest.log" 2>&1 \
        || { cat "$out/state-selftest.log"; echo "SELFTEST FAILED: state.mjs passes a capture that breaks its rule, or refuses one that holds"; exit 1; }
    echo "4. state: $(grep -c '^ok ' "$out/state-selftest.log") made-up captures read as they should ($(tail -1 "$out/state-selftest.log"))"
fi
if [ -n "$idle" ]; then
    # The idle connection asks for a path the probe answers 404: no turn may be recorded.
    run "$out/idle" "$path" "$base" 120 /no-such-path; rc=$?
    [ $rc != 0 ] && grep -q "the idle connection was not set up" "$out/idle.log" && [ "$(rows "$out/idle")" = 0 ] \
        || { echo "SELFTEST FAILED: an idle connection that was not set up did not stop the turn (exit $rc, rows $(rows "$out/idle"))"; tail -5 "$out/idle.log"; exit 1; }
    echo "5. idle connection: a turn without it was not recorded (exit $rc, 0 rows): $(grep -m1 'IDLE-FAILED' "$out/idle.log")"
    node $P/park.mjs --selftest >"$out/park-selftest.log" 2>&1 \
        || { cat "$out/park-selftest.log"; echo "SELFTEST FAILED: park.mjs passes waits that break its rule, or refuses ones that hold it"; exit 1; }
    echo "7. park: $(grep -c '^ok ' "$out/park-selftest.log") made-up records of a server's waits read as they should ($(tail -1 "$out/park-selftest.log"))"
fi
node $P/selftest/report-selftest.mjs >"$out/report-selftest.log" 2>&1 \
    || { cat "$out/report-selftest.log"; echo "SELFTEST FAILED: report.mjs reads made-up results it must refuse, or refuses ones it must read"; exit 1; }
echo "6. report: $(grep -c '^ok ' "$out/report-selftest.log") made-up results read as they should ($(tail -1 "$out/report-selftest.log"))"
echo SELFTEST-OK
