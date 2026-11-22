#!/bin/sh
# run.sh: corten-run/corten#1923's A/A runs, after setup.sh, nothing else run or logged into on
# the host meanwhile. Start it detached so a dropped SSH session does not stop it:
#   nohup sh /m/1923/run.sh >/m/1923/run.out 2>&1 &
# and collect /m/1923/results (and /m/1923/bin/*.txt) when run.out ends with ALL-DONE.
#
# A is main-1 in every comparison; B is main-2 (aa-same), pad40 (aa-pad40) or pad3100
# (aa-pad3100); build.sh says what each is. The method is #1829's fresh-start rerun's
# (run-pair-fresh.sh, every turn, warm-up included, on a freshly started build pinned to CPU 2,
# wrk -t2 -c64 for 3 s on CPUs 4 and 5, this script and perf on CPU 7, the order turned every
# pair, jemalloc preloaded, the answers compared first), as results/margin.md declares:
#   check     every comparison's answers and one unrecorded pair, and pass 2's events on one
#             unrecorded pair, before anything is recorded (results/check-only/); a failure
#             stops the run
#   pass 1    plain (/private), PAIRS (100) recorded pairs per comparison: cycles:u, cycles:k,
#             instructions:u (results/<comparison>/cycles-plain.csv, summary-plain.txt)
#   pass 2    plain again on aa-pad40 and aa-pad3100, MISS_PAIRS (30) pairs, counting
#             L1-icache-load-misses:u, iTLB-load-misses:u, branch-misses:u and instructions:u,
#             less any this host's PMU cannot count at 100% (host.txt says which)
#             (results/<comparison>/counts-plain-misses.csv, summary-plain-misses.txt)
#   hit       only with HIT=1, after the rest: hit (/page, kept) for the three comparisons,
#             PAIRS pairs each, as #1829's run-fresh.sh ran it (about 37 more minutes)
# Then results/floor.md (report.mjs). A failed run is reported and the next one goes on.
# Environment: PAIRS (100), MISS_PAIRS (30), HIT (0). In a container without perf:
#   WARMUP=0 PAIRS=0 MISS_PAIRS=0 NOPERF=1 sh /m/1923/run.sh   (answers only, no turn)
set -u
P=/m/1923; R=$P/results
PAIRS=${PAIRS:-100}; MISS_PAIRS=${MISS_PAIRS:-30}; HIT=${HIT:-0}
mkdir -p $R
[ -f $R/margin.md ] || { echo "no $R/margin.md: it is written before the run"; exit 1; }
for b in main-1 main-2 pad40 pad3100; do [ -x $P/bin/$b ] || { echo "no $P/bin/$b: run build.sh"; exit 1; }; done
[ -f /root/.cargo/env ] && . /root/.cargo/env
say() { echo "$*" | tee -a $R/progress.log; }
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'
cmd() { echo "$J $P/bin/$1 \$PORT $2"; }
A=main-1
COMPARISONS="aa-same:main-2 aa-pad40:pad40 aa-pad3100:pad3100"
MISSES="aa-pad40:pad40 aa-pad3100:pad3100"
CYCLES=cycles:u,cycles:k,instructions:u

# Which of pass 2's events this host counts: each beside instructions:u, then all together, on
# a busy loop on CPU 2, numeric and at 100%; one that fails is dropped (the last first, together).
counts() { # <events> <perf output>
    perf stat -x, -e "$1" -o "$2" -- taskset -c 2 sh -c 'i=0; while [ $i -lt 1000000 ]; do i=$((i + 1)); done' >/dev/null 2>&1 || return 1
    for counts_e in $(echo "$1" | tr ',' ' '); do
        # perf names a cache event without its :u; run-pair-fresh.sh matches it the same way.
        awk -F, -v e="$counts_e" 'BEGIN { n = e; sub(/:u$/, "", n) } ($3 == e || $3 == n) && $1 ~ /^[0-9]+$/ && $5 + 0 >= 100 { ok++ } END { exit ok != 1 }' "$2" || return 1
    done
}
pf=$R/preflight; mkdir -p $pf
MISS_EVENTS=
if [ -z "${NOPERF:-}" ]; then
    counts $CYCLES $pf/cycles.perf || { echo "perf cannot count $CYCLES at 100% here:"; cat $pf/cycles.perf; exit 1; }
    for e in L1-icache-load-misses:u iTLB-load-misses:u branch-misses:u; do
        if counts "$e,instructions:u" "$pf/$(echo "$e" | tr -c "A-Za-z0-9\n" _).perf"; then MISS_EVENTS="$MISS_EVENTS${MISS_EVENTS:+,}$e"; else say "pass 2: $e not counted here (preflight/), dropped"; fi
    done
    while [ -n "$MISS_EVENTS" ] && ! counts "$MISS_EVENTS,instructions:u" $pf/together.perf; do
        say "pass 2: $MISS_EVENTS,instructions:u not all at 100% together; dropping ${MISS_EVENTS##*,}"
        case "$MISS_EVENTS" in *,*) MISS_EVENTS=${MISS_EVENTS%,*} ;; *) MISS_EVENTS= ;; esac
    done
fi
[ -z "$MISS_EVENTS" ] || MISS_EVENTS="$MISS_EVENTS,instructions:u"
[ -n "$MISS_EVENTS" ] || MISS_PAIRS=0

{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) (runs as $(id -un))"; uname -a;
  RUSTUP_TOOLCHAIN=1.100.0 rustc -vV; perf version 2>/dev/null; wrk -v 2>&1 | head -1;
  echo "main-1 .comment: $(readelf -p .comment $P/bin/main-1 2>/dev/null | sed -n 's/^ *\[ *[0-9a-f]*\] *//p' | paste -sd';' -)";
  echo "main $(cat $P/src-main.commit)";
  dpkg -s libjemalloc2 libzstd1 wrk 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries (sha256, size):"; cat $P/bin/sha256.txt;
  for v in main-2 pad40 pad3100; do echo "layout of $v against main-1:"; cat $P/bin/layout-$v.txt 2>/dev/null; done;
  echo "allocator: jemalloc (LD_PRELOAD=libjemalloc.so.2, MALLOC_CONF=background_thread:true,tcache_max:65536)";
  echo "pass 1: $CYCLES, $PAIRS pairs per comparison ($COMPARISONS), workload plain";
  echo "pass 2: ${MISS_EVENTS:-none counted}, $MISS_PAIRS pairs per comparison ($MISSES), workload plain";
  echo "hit: $(if [ "$HIT" = 1 ]; then echo "$PAIRS pairs per comparison"; else echo "not run (HIT=0)"; fi)";
  echo "every turn on a fresh start; server CPU 2, wrk CPUs 4,5, driver and perf CPU 7"; } >"$R/host.txt" 2>&1

# The shell functions here share one set of variables (POSIX sh), so each names its own aw_*.
all_warm() { # <out dir> <workload> <pairs>: every start of both builds logged the page kept, all of one size
    aw_want=$((1 + ${WARMUP:-1} + $3))
    aw_size=$(grep -m1 '^WARM ' "$1/serve-$2-base.log" | sed 's/.*, \([0-9]*\) bytes$/\1/')
    for aw_v in base head; do
        aw_f=$1/serve-$2-$aw_v.log
        aw_n=$(grep -c '^WARM ' "$aw_f" || true)
        aw_k=$(grep -c "^WARM .*content-encoding -, age [0-9][0-9]*, $aw_size bytes\$" "$aw_f" || true)
        [ "$aw_n" = "$aw_want" ] && [ "$aw_k" = "$aw_n" ] || { echo "all_warm: $2 $aw_v: $aw_k of $aw_n WARM lines kept ($aw_size bytes), $aw_want starts" >&2; return 1; }
        echo "all_warm: $2 $aw_v: $aw_k of $aw_want starts kept the page ($aw_size bytes)" | tee -a "$1/warm-$2-all.txt"
    done
}
plain() { # <out dir> <B> <workload name> <pairs> [events]
    EVENTS=${5:-$CYCLES} CHECKS=$P/checks-plain.txt MASK=$P/mask.sed \
        taskset -c 7 sh $P/run-pair-fresh.sh "$1" "$3" "$4" 2 4,5 /private $P/lua/get.lua "$(cmd $A plain)" "$(cmd $2 plain)"
}
hit() { # <out dir> <B> <pairs>
    WARMUP=0 CHECKS=$P/checks-hit.txt MASK=$P/mask.sed \
        taskset -c 7 sh $P/run-pair.sh "$1" hit-check 0 2 4,5 /page $P/lua/get.lua "$(cmd $A hit)" "$(cmd $2 hit)" &&
    sh $P/check-warm.sh "$1" hit-check same:- &&
    CHECKS=$P/checks-hit.txt MASK=$P/mask.sed \
        taskset -c 7 sh $P/run-pair-fresh.sh "$1" hit "$3" 2 4,5 /page $P/lua/get.lua "$(cmd $A hit)" "$(cmd $2 hit)" &&
    { [ -n "${NOPERF:-}" ] || all_warm "$1" hit "$3"; }
}

say "== 1923 check start $(date -u +%T)"
C=$R/check-only
for c in $COMPARISONS; do
    n=${c%%:*}; b=${c#*:}
    plain $C/$n $b plain 0 >>$C.log 2>&1 || { tail -20 $C.log; say "CHECK-FAILED: $n plain"; exit 1; }
    cat $C/$n/answers-plain/verdict.txt
    if [ "$HIT" = 1 ]; then hit $C/$n $b 0 >>$C.log 2>&1 || { tail -20 $C.log; say "CHECK-FAILED: $n hit"; exit 1; }; fi
done
if [ "$MISS_PAIRS" != 0 ]; then
    for c in $MISSES; do
        n=${c%%:*}; b=${c#*:}
        plain $C/$n $b plain-misses 0 "$MISS_EVENTS" >>$C.log 2>&1 || { tail -20 $C.log; say "CHECK-FAILED: $n plain-misses"; exit 1; }
    done
fi
say "== 1923 checks ok $(date -u +%T)"
FAILED=
run() { # <label> <command...>
    run_l=$1; shift
    say "== $run_l start $(date -u +%T)"
    if "$@" >>$R/run.log 2>&1; then say "== $run_l ok $(date -u +%T)"; else say "== $run_l FAILED $(date -u +%T)"; tail -15 $R/run.log; FAILED="$FAILED $run_l"; return 1; fi
}
summ() { # <out dir> <workload> <script>
    summ_f=$(ls "$1"/cycles-$2.csv "$1"/counts-$2.csv 2>/dev/null | head -1)
    [ -n "$summ_f" ] && [ "$(wc -l <"$summ_f")" -gt 1 ] && node $P/$3 "$summ_f" >"$1/summary-$2.txt" && grep -v '^JSON' "$1/summary-$2.txt"
}
for c in $COMPARISONS; do
    n=${c%%:*}; b=${c#*:}
    run "$n plain" plain $R/$n $b plain $PAIRS && summ $R/$n plain summary.mjs
done
if [ "$MISS_PAIRS" != 0 ]; then
    for c in $MISSES; do
        n=${c%%:*}; b=${c#*:}
        run "$n plain-misses" plain $R/$n $b plain-misses $MISS_PAIRS "$MISS_EVENTS" && summ $R/$n plain-misses summary-events.mjs
    done
fi
if [ "$HIT" = 1 ]; then
    for c in $COMPARISONS; do
        n=${c%%:*}; b=${c#*:}
        run "$n hit" hit $R/$n $b $PAIRS && summ $R/$n hit summary.mjs
    done
fi
node $P/report.mjs $R $P/bin >$R/floor.md && say "report: $R/floor.md"
cp $P/bin/*.txt $R/ 2>/dev/null || true
say "failed:${FAILED:- none}"
say ALL-DONE