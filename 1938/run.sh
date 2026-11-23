#!/bin/sh
# run.sh: #1938's paired cycles, after setup.sh, nothing else run or logged into on the host
# meanwhile. Writes /m/1938/results: host.txt, check-only/ and check-only.log (every workload's
# answers and one unrecorded pair, before anything is recorded; a failure there stops the run),
# then run-<workload>.log and the 100 pairs a workload that margin.md declares
# (cycles-<w>.csv, raw-<w>.log, answers-<w>/), and summary-<w>.txt. Server on CPU 2, wrk on CPUs
# 4-5, this script and perf on CPU 7. L1-icache-load-misses:u is counted as a diagnostic only
# when a preflight counts it beside the three cycle and instruction counters at 100% (host.txt
# says which); otherwise it is left out. Environment: PAIRS (default 100), WORKLOADS (default all
# five, in margin.md's order), TURN (run-pair.sh's default).
set -u
P=/m/1938; R=$P/results
export PAIRS=${PAIRS:-100}
workloads=${WORKLOADS:-named named-off write kept plain}
mkdir -p $R
[ -f $R/margin.md ] || { echo "no $R/margin.md: it is written before the run"; exit 1; }
[ -f /root/.cargo/env ] && . /root/.cargo/env
pf=/tmp/1938-icache.perf
ICACHE=0
if perf stat -x, -e cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u -o $pf -- \
    taskset -c 2 sh -c 'i=0; while [ $i -lt 2000000 ]; do i=$((i + 1)); done' 2>/dev/null \
    && [ "$(awk -F, '$1 ~ /^[0-9]+$/ && $5 + 0 == 100' $pf | wc -l)" = 4 ]; then
    ICACHE=1
fi
export ICACHE
{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) (runs as $(id -un))"; uname -a;
  RUSTUP_TOOLCHAIN=1.100.0 rustc -V; perf version; wrk --version 2>&1 | head -1;
  echo "base $(cat $P/src-base.commit) head $(cat $P/src-head.commit)";
  dpkg -s libjemalloc2 libzstd1 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries: base $(sha256sum $P/bin/base | cut -c1-16) head $(sha256sum $P/bin/head | cut -c1-16)";
  echo "allocator: jemalloc (LD_PRELOAD=libjemalloc.so.2, MALLOC_CONF=background_thread:true,tcache_max:65536)";
  echo "L1-icache-load-misses:u diagnostic: $(if [ $ICACHE = 1 ]; then echo counted; else echo "not counted (preflight:"; cat $pf 2>/dev/null; echo ")"; fi)";
  echo "workloads: $workloads; pairs $PAIRS each, every turn on a fresh start; server CPU 2, wrk CPUs 4,5, driver and perf CPU 7"; } >"$R/host.txt" 2>&1
echo "== 1938 check start $(date -u +%T)"
for w in $workloads; do
    OUT=$R/check-only PAIRS=0 taskset -c 7 sh $P/run-pair.sh $w >>"$R/check-only.log" 2>&1 \
        || { tail -20 "$R/check-only.log"; echo "CHECK-FAILED $w"; exit 1; }
    cat "$R/check-only/answers-$w/verdict.txt"
done
failed=0
for w in $workloads; do
    echo "== 1938 $w start $(date -u +%T)"
    if taskset -c 7 sh $P/run-pair.sh $w >"$R/run-$w.log" 2>&1; then
        echo "== 1938 $w ok $(date -u +%T)"
        node $P/summary.mjs "$R/cycles-$w.csv" | tee "$R/summary-$w.txt"
    else
        failed=1
        echo "== 1938 $w FAILED $(date -u +%T)"; tail -15 "$R/run-$w.log"
    fi
done
[ $failed = 0 ] && echo ALL-DONE || echo "ALL-DONE (with a failed workload: not a result for it)"