#!/bin/sh
# run.sh: corten-run/corten#1846's fourth quiet-host run (1846r2), the merged head against the main it
# merged (commits.env), after setup.sh, nothing else run on or logged into the host meanwhile.
# Start it detached so a dropped SSH session does not stop it:
#   nohup sh /m/1846r2/run.sh >/m/1846r2/run.out 2>&1 &
# and collect /m/1846r2/results when run.out ends with ALL-DONE. results/margin.md declares the plan.
#
# The method is the earlier 1846 kit's second run (run-fresh.sh): every turn, warm-up included, on
# a freshly started build pinned to CPU 2 (run-pair-fresh.sh), wrk -t2 -c64 for 3 s on CPUs 4 and
# 5, this script and perf on CPU 7, the order turned every pair, jemalloc preloaded, the answers
# compared before the first turn. Ports 18081-18082 (and 18081 for the calibration), as 1923's kit.
#   preflight  perf counts cycles:u,cycles:k,instructions:u at 100% here (else stop), and
#              L1-icache-load-misses:u with instructions:u (else pass 2 is skipped and
#              results/icache-unavailable.txt says why)
#   calibrate  refused's bound on the built head (calibrate-refused.sh, refused.env)
#   check      every workload once with no recorded pair, on one start a build (run-pair.sh):
#              answers compared and each build's WARM line checked (check-warm.sh), refused's
#              FENCE line too; a failure stops the run before anything is recorded
#   pass 1     each workload, one unrecorded warm-up pair and PAIRS (100) recorded pairs, counting
#              cycles:u, cycles:k, instructions:u (cycles-<w>.csv, summary-<w>.txt), then every
#              start's WARM (and refused's FENCE) line checked (starts-<w>.txt)
#   pass 2     each workload again as <w>-icache, one warm-up pair and MISS_PAIRS (30) recorded
#              pairs of MISS_TURN (1) s turns, counting L1-icache-load-misses:u and instructions:u
#              (counts-<w>-icache.csv, summary-<w>-icache.txt); diagnostic, no margin
#   pass 3     a held value's wait behind a kept page's brotli 5 job (wait.sh): WAIT_ROUNDS (20)
#              alternated processes a build of WAIT_REPS (21) repetitions (results/wait/,
#              summary-wait.txt, whose last lines give the declared checks and bounds)
# A failed workload is reported and the next one goes on.
# Environment: PAIRS (100), MISS_PAIRS (30), MISS_TURN (1), WAIT_ROUNDS (20, 0 skips pass 3),
# WAIT_REPS (21). In a container without perf:
#   WARMUP=0 PAIRS=0 MISS_PAIRS=0 NOPERF=1 WAIT_ROUNDS=0 sh /m/1846r2/run.sh   (calibration and
#   answers only; WAIT_ROUNDS=2 WAIT_REPS=3 tries pass 3 too, which needs no perf)
set -u
P=/m/1846r2; R=$P/results
PAIRS=${PAIRS:-100}; MISS_PAIRS=${MISS_PAIRS:-30}; MISS_TURN=${MISS_TURN:-1}
WAIT_ROUNDS=${WAIT_ROUNDS:-20}; WAIT_REPS=${WAIT_REPS:-21}; export WAIT_ROUNDS WAIT_REPS
mkdir -p $R
[ -f $R/margin.md ] || { echo "no $R/margin.md: it is written before the run"; exit 1; }
for b in base head; do [ -x $P/bin/$b ] || { echo "no $P/bin/$b: run build.sh"; exit 1; }; done
if [ "$WAIT_ROUNDS" != 0 ]; then
    for b in base head; do [ -x $P/bin/wait-$b ] || { echo "no $P/bin/wait-$b: run build.sh"; exit 1; }; done
fi
[ -f /root/.cargo/env ] && . /root/.cargo/env
say() { echo "$*" | tee -a $R/progress.log; }
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'
CYCLES=cycles:u,cycles:k,instructions:u
ICACHE=L1-icache-load-misses:u,instructions:u

# Whether perf counts <events> here, each numeric and at 100%, on a busy loop on CPU 2.
counts() { # <events> <perf output>
    perf stat -x, -e "$1" -o "$2" -- taskset -c 2 sh -c 'i=0; while [ $i -lt 1000000 ]; do i=$((i + 1)); done' >/dev/null 2>&1 || return 1
    for counts_e in $(echo "$1" | tr ',' ' '); do
        # perf names a cache event without its :u; run-pair-fresh.sh matches it the same way.
        awk -F, -v e="$counts_e" 'BEGIN { n = e; sub(/:u$/, "", n) } ($3 == e || $3 == n) && $1 ~ /^[0-9]+$/ && $5 + 0 >= 100 { ok++ } END { exit ok != 1 }' "$2" || return 1
    done
}
pf=$R/preflight; mkdir -p $pf
if [ -z "${NOPERF:-}" ]; then
    counts $CYCLES $pf/cycles.perf || { echo "perf cannot count $CYCLES at 100% here:"; cat $pf/cycles.perf; exit 1; }
    if ! counts $ICACHE $pf/icache.perf; then
        { echo "pass 2 not run: perf did not count $ICACHE numerically at 100% on this host:"; cat $pf/icache.perf; } >$R/icache-unavailable.txt
        say "pass 2: $ICACHE not counted here (icache-unavailable.txt); skipped"
        MISS_PAIRS=0
    fi
fi

{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) (runs as $(id -un))"; uname -a;
  RUSTUP_TOOLCHAIN=1.100.0 rustc -vV; perf version 2>/dev/null; wrk -v 2>&1 | head -1;
  echo "base $(cat $P/src-base.commit) head $(cat $P/src-head.commit)";
  dpkg -s libjemalloc2 libzstd1 wrk 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries (side, commit, sha256, size):"; cat $P/bin/sha256.txt;
  echo "allocator: jemalloc (LD_PRELOAD=libjemalloc.so.2, MALLOC_CONF=background_thread:true,tcache_max:65536)";
  echo "pass 1: $CYCLES, $PAIRS pairs a workload, 3 s turns";
  echo "pass 2: $(if [ "$MISS_PAIRS" = 0 ]; then echo "not run"; else echo "$ICACHE, $MISS_PAIRS pairs a workload, $MISS_TURN s turns"; fi)";
  echo "pass 3: $(if [ "$WAIT_ROUNDS" = 0 ]; then echo "not run"; else echo "held value's wait, $WAIT_ROUNDS rounds of one process a build, $WAIT_REPS repetitions each, CPUs 2,4,5,7"; fi)";
  echo "every turn on a fresh start; server CPU 2, wrk CPUs 4,5, driver and perf CPU 7"; } >"$R/host.txt" 2>&1
cp $P/bin/sha256.txt $R/sha256.txt

say "== 1846r2 calibrate $(date -u +%T)"
taskset -c 7 sh $P/calibrate-refused.sh $P >$R/calibrate.out 2>&1 || { cat $R/calibrate.out; say "CALIBRATE-FAILED"; exit 1; }
cat $R/calibrate.out
. $P/refused.env
cp $P/refused.env $R/refused.env

# The workloads: <name> <path> <check-warm rule> <lua> <checks> <mask> <expect, or -> <probe config...>
workload() {
    case $1 in
        browser) echo "browser /page br-smaller get-ae-browser.lua checks-browser.txt mask-browser.sed expect-browser.diff browser" ;;
        gzip) echo "gzip /page same:gzip get-ae-gzip.lua checks-gzip.txt mask.sed - gzip" ;;
        refused) echo "refused /page same:zstd get-ae-browser.lua checks-refused.txt mask.sed - refused $REFUSED_BOUND $REFUSED_FILL" ;;
        json-browser) echo "json-browser /records br-smaller get-json-browser.lua checks-json-browser.txt mask-browser.sed expect-json-browser.diff json-browser" ;;
    esac
}
WORKLOADS="browser gzip refused json-browser"

# Every start of both builds logged one and the same WARM line but its Age (the page kept, in one
# coding and size), and for refused a FENCE ok line; no start of either build logged a panic, in
# its warm-up or its timed turn (Rust's hook prints "panicked at" for a panic the compression
# thread catches too, and the probe's PANICKED and FENCE FAILED lines); then check-warm.sh's rule.
starts() { # <out dir> <workload> <rule> <starts>
    st_out=$1/starts-$2.txt; : >"$st_out"
    for st_v in base head; do
        st_f=$1/serve-$2-$st_v.log
        if grep -q -e 'panicked at' -e '^PANICKED' -e '^FENCE FAILED' "$st_f"; then
            echo "starts: $2 $st_v: a panic or a failed fence in $st_f:" >&2
            grep -m5 -e 'panicked at' -e '^PANICKED' -e '^FENCE FAILED' "$st_f" >&2; return 1
        fi
        st_n=$(grep -c '^WARM ' "$st_f" || true)
        st_k=$(grep -c '^WARM .*, age [0-9][0-9]*, [0-9][0-9]* bytes$' "$st_f" || true)
        st_u=$(grep '^WARM ' "$st_f" | sed 's/, age [0-9]*,/, age _,/' | sort -u | wc -l)
        [ "$st_n" = "$4" ] && [ "$st_k" = "$st_n" ] && [ "$st_u" = 1 ] \
            || { echo "starts: $2 $st_v: $st_n WARM lines ($4 starts), $st_k kept, $st_u distinct" >&2; return 1; }
        st_say="$2 $st_v: $st_n of $4 starts: $(grep -m1 '^WARM ' "$st_f" | sed 's/, age [0-9]*,/, age _,/')"
        if [ "$2" = refused ] || [ "${2%-icache}" = refused ]; then
            st_fe=$(grep -c "^FENCE ok $st_v: " "$st_f" || true)
            [ "$st_fe" = "$4" ] && ! grep -q '^FENCE FAILED' "$st_f" \
                || { echo "starts: $2 $st_v: $st_fe FENCE ok lines ($4 starts)" >&2; return 1; }
            st_say="$st_say; FENCE ok in $st_fe"
        fi
        echo "$st_say" | tee -a "$st_out"
    done
    sh $P/check-warm.sh "$1" "$2" "$3"
}

pair() { # <out dir> <name> <pairs> <fresh|once> <events> <turn> <workload...>
    pr_out=$1; pr_name=$2; pr_pairs=$3; pr_mode=$4; pr_events=$5; pr_turn=$6; shift 6
    pr_path=$2; pr_rule=$3; pr_lua=$P/lua/$4; pr_checks=$P/$5; pr_mask=$P/$6; pr_expect=$7; shift 7
    [ "$pr_expect" = - ] && pr_expect= || pr_expect=$P/$pr_expect
    pr_base="$J $P/bin/base \$PORT $*"; pr_head="$J $P/bin/head \$PORT $*"
    if [ "$pr_mode" = once ]; then
        WARMUP=0 CHECKS=$pr_checks MASK=$pr_mask EXPECT=$pr_expect \
            taskset -c 7 sh $P/run-pair.sh "$pr_out" "$pr_name" 0 2 4,5 "$pr_path" "$pr_lua" "$pr_base" "$pr_head" &&
        starts "$pr_out" "$pr_name" "$pr_rule" 1
    else
        EVENTS=$pr_events TURN=$pr_turn CHECKS=$pr_checks MASK=$pr_mask EXPECT=$pr_expect \
            taskset -c 7 sh $P/run-pair-fresh.sh "$pr_out" "$pr_name" "$pr_pairs" 2 4,5 "$pr_path" "$pr_lua" "$pr_base" "$pr_head" &&
        { [ -n "${NOPERF:-}" ] || starts "$pr_out" "$pr_name" "$pr_rule" $((1 + ${WARMUP:-1} + pr_pairs)); }
    fi
}

say "== 1846r2 check start $(date -u +%T)"
C=$R/check-only
for w in $WORKLOADS; do
    pair $C $w 0 once $CYCLES 3 $(workload $w) >>$C.log 2>&1 || { tail -20 $C.log; say "CHECK-FAILED: $w"; exit 1; }
    cat $C/answers-$w/verdict.txt; cat $C/starts-$w.txt
done
say "== 1846r2 checks ok $(date -u +%T)"

FAILED=
run() { # <label> <command...>
    run_l=$1; shift
    say "== $run_l start $(date -u +%T)"
    if "$@" >>$R/run.log 2>&1; then say "== $run_l ok $(date -u +%T)"; else say "== $run_l FAILED $(date -u +%T)"; tail -15 $R/run.log; FAILED="$FAILED $run_l"; return 1; fi
}
summ() { # <workload file name> <script> [turn]
    summ_f=$(ls $R/cycles-$1.csv $R/counts-$1.csv 2>/dev/null | head -1)
    [ -n "$summ_f" ] && [ "$(wc -l <"$summ_f")" -gt 1 ] && node $P/$2 "$summ_f" ${3:-} >"$R/summary-$1.txt" && grep -v '^JSON' "$R/summary-$1.txt"
}
if [ "$PAIRS" != 0 ]; then
    for w in $WORKLOADS; do
        run "$w" pair $R $w $PAIRS fresh $CYCLES 3 $(workload $w) && summ $w summary.mjs
    done
fi
if [ "$MISS_PAIRS" != 0 ]; then
    for w in $WORKLOADS; do
        run "$w-icache" pair $R $w-icache $MISS_PAIRS fresh $ICACHE $MISS_TURN $(workload $w) && summ $w-icache summary-events.mjs $MISS_TURN
    done
fi
if [ "$WAIT_ROUNDS" != 0 ]; then
    run wait sh $P/wait.sh && grep -v '^JSON' $R/summary-wait.txt
fi
say "failed:${FAILED:- none}"
say ALL-DONE
