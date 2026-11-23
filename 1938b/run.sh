#!/bin/sh
# run.sh: kit 1938b's paired cycles (the supplement to 1938), after setup.sh, nothing else run or
# logged into on the host meanwhile. Writes /m/1938b/results: host.txt, check-only/ and
# check-only.log (every workload's answers and one unrecorded pair, before anything is recorded),
# then run-<workload>.log and the 100 pairs a workload that margin.md declares (cycles-<w>.csv,
# raw-<w>.log, answers-<w>/), summary-<w>.txt, and status.txt. Server on CPU 2, wrk on CPUs 4-5,
# this script and perf on CPU 7. L1-icache-load-misses is counted as a diagnostic only when a
# preflight counts it beside the three cycle and instruction counters at 100% (host.txt says
# which, and why not); otherwise it is left out. Environment: PAIRS (default 100), WORKLOADS
# (default the three margin.md declares, in its order), TURN and PERF (run-pair.sh's).
#
# Exit status, decided before the run (margin.md, Failures): a failed check stops the run before
# anything is recorded. A workload whose run-pair.sh or summary fails is reported on a
# `FAILED <workload>: ...` line and is not a result; the remaining workloads still run, as
# diagnostic data only, and the run exits 1 with status.txt `INCOMPLETE`. Only when every
# declared workload recorded all its pairs and its summary succeeded does it print `COMPLETE` and
# exit 0. Whether a workload met its margin is in its summary; a missed margin is a result, not a
# failure of the run.
set -u
P=/m/1938b; R=$P/results
export PAIRS=${PAIRS:-100}
workloads=${WORKLOADS:-write-off write-off-glibc new}
mkdir -p $R
[ -f $R/margin.md ] || { echo "FAILED run: no $R/margin.md (it is written before the run)"; exit 1; }
[ -f /root/.cargo/env ] && . /root/.cargo/env
pf=/tmp/1938b-icache.perf
ICACHE=0
if perf stat -x, -e cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u -o $pf -- \
    taskset -c 2 sh -c 'i=0; while [ $i -lt 2000000 ]; do i=$((i + 1)); done' 2>/dev/null \
    && [ "$(awk -F, '$3 ~ /^(cycles:u|cycles:k|instructions:u|L1-icache-load-misses(:u)?)$/ && $1 ~ /^[0-9]+$/ && $5 + 0 == 100' $pf | wc -l)" = 4 ]; then
    ICACHE=1
fi
export ICACHE
{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) (runs as $(id -un))"; uname -a;
  RUSTUP_TOOLCHAIN=1.100.0 rustc -V; perf version; wrk --version 2>&1 | head -1; node --version;
  echo "base $(cat $P/src-base.commit) head $(cat $P/src-head.commit)";
  dpkg -s libc6 libjemalloc2 libzstd1 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries: base $(sha256sum $P/bin/base | cut -c1-16) head $(sha256sum $P/bin/head | cut -c1-16)";
  echo "allocators: write-off and new jemalloc (LD_PRELOAD=libjemalloc.so.2, MALLOC_CONF=background_thread:true,tcache_max:65536); write-off-glibc glibc's (nothing preloaded); each server reports which it found";
  echo "L1-icache-load-misses diagnostic: $(if [ $ICACHE = 1 ]; then echo counted; else echo "not counted (preflight:"; cat $pf 2>/dev/null; echo ")"; fi)";
  echo "workloads: $workloads; pairs $PAIRS each, every turn on a fresh start; server CPU 2, wrk CPUs 4,5, driver and perf CPU 7"; } >"$R/host.txt" 2>&1
echo "== 1938b check start $(date -u +%T)"
for w in $workloads; do
    if OUT=$R/check-only PAIRS=0 taskset -c 7 sh $P/run-pair.sh $w >>"$R/check-only.log" 2>&1; then
        cat "$R/check-only/answers-$w/verdict.txt"
    else
        tail -20 "$R/check-only.log"
        echo "FAILED check $w: run-pair.sh exited nonzero before any pair was recorded"
        echo INCOMPLETE >"$R/status.txt"
        echo "INCOMPLETE: the checks failed; nothing was recorded"
        exit 1
    fi
done
echo "== 1938b checks ok $(date -u +%T)"
failed=
for w in $workloads; do
    echo "== 1938b $w start $(date -u +%T)"
    if ! taskset -c 7 sh $P/run-pair.sh $w >"$R/run-$w.log" 2>&1; then
        tail -15 "$R/run-$w.log"
        echo "FAILED $w: run-pair.sh exited nonzero $(date -u +%T) (not a result; run-$w.log)"
        failed="$failed $w"
        continue
    fi
    if ! EXPECT_PAIRS=$PAIRS node $P/summary.mjs "$R/cycles-$w.csv" >"$R/summary-$w.txt" 2>&1; then
        cat "$R/summary-$w.txt"
        echo "FAILED $w: summary.mjs exited nonzero (not a result; summary-$w.txt)"
        failed="$failed $w"
        continue
    fi
    cat "$R/summary-$w.txt"
    echo "== 1938b $w ok $(date -u +%T)"
done
if [ -n "$failed" ]; then
    echo INCOMPLETE >"$R/status.txt"
    echo "INCOMPLETE: failed:$failed; the other workloads' summaries are diagnostic only"
    exit 1
fi
echo COMPLETE >"$R/status.txt"
echo "COMPLETE: every declared workload recorded $PAIRS pairs and was summarised"