#!/bin/sh
# run-all.sh: #1865's run alone, nothing else on the host meanwhile; after setup.sh. The settings
# are the declaration's (1865/results/margin.md) and are fixed here: it refuses to start if PAIRS,
# TURN, WARMUP or ICACHE_PAIRS is set in its environment, and passes each script its value itself.
#   1. check: every answer, warm-up, rotation, eviction and constant checked with no pairs, recorded
#      or not (results/check-only.log); a failure stops before any pair, and run-all.sh exits 1.
#   2. main: run-fresh.sh, nine workloads, 100 pairs each after one not recorded, 3 s turns,
#      cycles:u, cycles:k and instructions:u. A failure stops the run, and run-all.sh exits 1; the
#      diagnostic pass is then not run.
#   3. diagnostic: run-icache.sh, 30 pairs each of 1 s turns, L1-icache-load-misses:u and
#      instructions:u. Not a gate: its failure or a host that cannot count the event is recorded,
#      and run-all.sh still exits 0 when the main pass completed.
# results/status.txt records each step's outcome; gate.mjs reads it with the CSVs.
set -u
for v in PAIRS TURN WARMUP ICACHE_PAIRS; do
    if eval "[ -n \"\${$v+set}\" ]"; then
        echo "run-all.sh: $v is set in the environment; the declared settings are fixed (unset it)" >&2
        exit 2
    fi
done
P=/m/1865; R=$P/results
mkdir -p $R
S=$R/status.txt
[ ! -e "$S" ] || { echo "run-all.sh: $S exists: these results are from an earlier run; move them first" >&2; exit 2; }
step() { echo "$1" >>"$S"; echo "== $1 $(date -u +%T)"; }
step "settings main PAIRS=100 WARMUP=1 TURN=3; check PAIRS=0 WARMUP=0; diagnostic ICACHE_PAIRS=30 TURN=1 WARMUP=0"
{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) (runs as root)"; uname -a
  [ -f /root/.cargo/env ] && . /root/.cargo/env; rustc -V
  echo "base $(cat $P/src-base.commit) head $(cat $P/src-head.commit)"
  dpkg -s libjemalloc2 libzstd1 wrk 2>/dev/null | grep -E '^(Package|Version)'
  echo "binaries: base $(sha256sum $P/bin/base | cut -d' ' -f1) head $(sha256sum $P/bin/head | cut -d' ' -f1)"
  (cd $P && sha256sum -c locks.sha256)
  echo "allocator: jemalloc (LD_PRELOAD=libjemalloc.so.2, MALLOC_CONF=background_thread:true,tcache_max:65536)"
  echo "main: 100 pairs after 1 not recorded, 3 s turns, every turn on a fresh start; diagnostic 30 pairs of 1 s turns"
  echo "server CPU 2, wrk CPUs 4,5, driver and perf CPU 7"; } >"$R/host.txt" 2>&1
if env PAIRS=0 WARMUP=0 taskset -c 7 sh $P/run-fresh.sh >"$R/check-only.log" 2>&1; then
    step "check ok"
else
    step "check FAILED"; tail -20 "$R/check-only.log"; exit 1
fi
if env PAIRS=100 WARMUP=1 TURN=3 taskset -c 7 sh $P/run-fresh.sh >"$R/run.log" 2>&1; then
    step "main ok"
else
    step "main FAILED"; tail -15 "$R/run.log"; exit 1
fi
if env ICACHE_PAIRS=30 TURN=1 WARMUP=0 taskset -c 7 sh $P/run-icache.sh >"$R/icache.log" 2>&1; then
    if [ -e "$R/icache-unavailable.txt" ]; then step "diagnostic unavailable"; else step "diagnostic ok"; fi
else
    step "diagnostic FAILED"; tail -15 "$R/icache.log"
fi
step "done"
