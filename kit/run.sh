#!/bin/sh
# run.sh: corten-run/corten#1824's measurement kit (1824f), after setup.sh, nothing else run on or
# logged into the host meanwhile. Started detached by /root/start.sh (or by hand:
#   nohup sh /m/1824f/run.sh >/m/1824f/run.out 2>&1 &
# ); everything ends in /m/1824f/results, and run.out ends ALL-DONE. results/margin.md declares the
# plan, the margins and the time.
#
#   preflight  perf counts cycles:u,cycles:k,instructions:u,page-faults,minor-faults at 100% here
#              (else stop); L1-icache-load-misses:u is counted as a diagnostic when perf counts it
#              at 100% too (with or without `:u` in perf's name for it); host.txt (CPU, kernel,
#              THP, allocator, binaries)
#   check      every comparison once with no recorded pair: its answers compared, one unrecorded
#              1 s pair counted, and each turn's after-check; a failure stops the run here
#   pairs      every comparison (run-pair.sh, a fresh start every turn, the order turned every
#              pair), one unrecorded warm-up pair and its recorded pairs; a failed comparison is
#              reported and the next goes on
#   summary    node summary.mjs results (summary.txt)
# Server CPU 2, wrk CPUs 4 and 5, this script and perf CPU 7, ports 18081-18082.
#
# Fixed, as results/margin.md declares them: 100 recorded pairs every comparison, one unrecorded
# warm-up pair, 3 s turns, the four comparisons, counters on. The run refuses to start if PAIRS,
# JROOM_PAIRS, TURN, WARMUP, COMPARISONS or PERF is set, so nothing changes them on the host.
# Exit status: 0 when every comparison ran and was summarized; 1 when anything failed (the
# preflight, a check, a comparison, the summary). run.out ends ALL-DONE either way, after a line
# EXIT <status>.
# Environment: RESULTS (the results directory, default /m/1824f/results; it must hold
# margin.md); DRY_RUN=1, for a container without counters only: no perf, 2 pairs a comparison
# and no warm-up, the results directory must not be /m/1824f/results, and nothing it writes is
# a measurement.
set -u
P=/m/1824f; R=${RESULTS:-$P/results}; B=$P/bin
for v in PAIRS JROOM_PAIRS TURN WARMUP COMPARISONS PERF; do
    eval "set_=\${$v+x}"
    [ -z "$set_" ] || { echo "$v is set: the kit's pairs, turns, comparisons and counters are fixed (results/margin.md); unset it"; echo "EXIT 1"; echo ALL-DONE; exit 1; }
done
DRY=${DRY_RUN:-0}
case $DRY in
    0) PAIRS=100; WARM=1; PERF=1 ;;
    1) [ "$(cd "$R" 2>/dev/null && pwd -P)" != "$(cd $P/results 2>/dev/null && pwd -P)" ] && [ "$R" != "$P/results" ] \
           || { echo "DRY_RUN=1 writes to the results directory: give it RESULTS=<another directory with margin.md>"; echo "EXIT 1"; echo ALL-DONE; exit 1; }
       PAIRS=2; WARM=0; PERF=0 ;;
    *) echo "DRY_RUN is 0 or 1"; echo "EXIT 1"; echo ALL-DONE; exit 1 ;;
esac
export PERF
COMPARISONS="room hit plain jroom"
finish() { # <status>
    say "EXIT $1"; say ALL-DONE; exit "$1"
}
say() { echo "$*" | tee -a $R/progress.log; }
mkdir -p $R
[ -f $R/margin.md ] || { echo "no $R/margin.md: it is written before the run"; finish 1; }
for b in main head; do [ -x $B/$b ] || { echo "no $B/$b: run build.sh"; finish 1; }; done
[ $DRY = 0 ] || say "DRY RUN: no counters, $PAIRS pairs a comparison, not a measurement"

# jemalloc as the template's image runs it.
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'

# <name> <out dir> <pairs> <warm-up pairs> <turn seconds>: runs that comparison, main (A) against
# the candidate (B).
comparison() {
    c_n=$1; c_out=$2; c_p=$3; c_w=$4; c_t=$5; c_accept=
    case $c_n in
        room) set -- /page new-url.lua checks-new.txt room kept-new ;;
        hit) set -- /page get.lua checks-page.txt hit kept ;;
        plain) set -- /private get.lua checks-private.txt plain unkept ;;
        jroom) set -- /records new-url-json.lua checks-json.txt jroom kept-new; c_accept=application/json ;;
        *) echo "unknown comparison $c_n"; return 2 ;;
    esac
    AFTER_A=$5 AFTER_B=$5 AFTER_ACCEPT=$c_accept CHECKS=$P/$3 MASK=$P/mask.sed WARMUP=$c_w TURN=$c_t \
        taskset -c 7 sh $P/run-pair.sh "$c_out" "$c_n" "$c_p" "$1" "$P/lua/$2" "$J $B/main \$PORT $4" "$J $B/head \$PORT $4" || return 1
    # Each side's log: the allocator asked for, and no setting jemalloc refused.
    for c_v in base head; do
        c_f=$c_out/serve-$c_n-$c_v.log
        ! grep -qi 'invalid conf\|jemalloc.*error' "$c_f" || { echo "$c_n $c_v: jemalloc refused its settings: $(grep -i 'conf' "$c_f" | head -2)"; return 1; }
        grep -q '^ALLOCATOR jemalloc' "$c_f" || { echo "$c_n $c_v: not the allocator asked for"; return 1; }
    done
}

counts() { # <events> <perf output>
    perf stat -x, -e "$1" -o "$2" -- taskset -c 2 sh -c 'i=0; while [ $i -lt 1000000 ]; do i=$((i + 1)); done' >/dev/null 2>&1 || return 1
    for counts_e in $(echo "$1" | tr ',' ' '); do
        awk -F, -v e="$counts_e" 'BEGIN { n = e; sub(/:u$/, "", n) } ($3 == e || $3 == n) && $1 ~ /^[0-9]+$/ && $5 + 0 >= 100 { ok++ } END { exit ok != 1 }' "$2" || return 1
    done
}
pf=$R/preflight; mkdir -p $pf
ICACHE=0
if [ "$PERF" = 1 ]; then
    counts cycles:u,cycles:k,instructions:u,page-faults,minor-faults $pf/cycles.perf \
        || { say "perf cannot count cycles:u,cycles:k,instructions:u,page-faults,minor-faults at 100% here:"; cat $pf/cycles.perf; finish 1; }
    if counts cycles:u,cycles:k,instructions:u,page-faults,minor-faults,L1-icache-load-misses:u $pf/icache.perf; then ICACHE=1; fi
fi
export ICACHE
{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) (runs as $(id -un))"; uname -a;
  echo "cmdline: $(cat /proc/cmdline)";
  for t in enabled defrag khugepaged/defrag; do echo "thp $t: $(cat /sys/kernel/mm/transparent_hugepage/$t 2>/dev/null)"; done;
  grep -E '^(MemTotal|MemAvailable)' /proc/meminfo;
  ldd --version | head -1; perf version 2>/dev/null; wrk -v 2>&1 | head -1; node -v;
  echo "main $(cat $P/src-main.commit); head = main + variants/head.diff, the candidate $(cat $P/src-head.commit) (sha256 $(sha256sum $P/variants/head.diff | cut -d' ' -f1))";
  dpkg -s libjemalloc2 libzstd1 libc6 wrk 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries (name, sha256, size):"; cat $B/sha256.txt;
  echo "allocator: jemalloc as the image, LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536";
  echo "L1-icache-load-misses:u diagnostic: $(if [ $ICACHE = 1 ]; then echo counted; else echo "not counted (preflight:"; cat $pf/icache.perf 2>/dev/null; echo ")"; fi)";
  echo "comparisons: $COMPARISONS; $PAIRS recorded pairs each after $WARM that is not; 3 s turns; every turn on a fresh start; server CPU 2, wrk CPUs 4,5, driver and perf CPU 7"; } >"$R/host.txt" 2>&1
cp $B/sha256.txt $R/sha256.txt

say "== 1824f check start $(date -u +%T)"
C=$R/check-only
for c in $COMPARISONS; do
    comparison $c $C 0 1 1 >>$C.log 2>&1 || { tail -20 $C.log; say "CHECK-FAILED: $c"; finish 1; }
    say "$c: $(cat $C/answers-$c/verdict.txt)"
done
say "== 1824f checks ok $(date -u +%T)"

FAILED=
for c in $COMPARISONS; do
    say "== $c start $(date -u +%T)"
    if comparison $c $R $PAIRS $WARM 3 >>$R/run.log 2>&1; then say "== $c ok $(date -u +%T)"; else say "== $c FAILED $(date -u +%T)"; tail -15 $R/run.log; FAILED="$FAILED $c"; fi
done
if [ "$PERF" = 1 ]; then
    node $P/summary.mjs $R >$R/summary.txt 2>&1 || { say "summary failed (or found a comparison it could not judge)"; FAILED="$FAILED summary"; }
    grep -v '^JSON' $R/summary.txt
fi
say "failed:${FAILED:- none}"
[ -z "$FAILED" ] || finish 1
finish 0
