#!/bin/sh
# run.sh: corten-run/corten#1965's placement runs, after setup.sh, nothing else run or logged into
# on the host meanwhile. Start it detached so a dropped SSH session does not stop it:
#   nohup sh /m/1965/run.sh >/m/1965/run.out 2>&1 &
# and collect /m/1965/results when run.out ends with ALL-DONE. results/margin.md (written before
# the run) declares the plan; plan.env holds its numbers (K placements, R pairs, the pads).
#
# Comparisons (A is the CSV's base rows, B its head rows), placement i = 1..K:
#   aa-plain       main-p<p_i> against main-p<q_i>, workload plain (GET /private, config plain)
#   aa-kept        main-p<p_i> against main-p<q_i>, workload kept (GET /page, kept, config hit)
#   change-kept    base-p<p_i> against head-p<p_i>, workload kept: #1955's change, each side moved
#                  by the same pad
# and a diagnostic, after them, i = 1..DIAG_K:
#   unpadded-kept  main (unpadded, cargo's binary) against main-p<p_i>, workload kept: where the
#                  unpadded build sits among the padded ones; no reading uses it
# Every placement of a comparison is one run of run-pair-fresh.sh (kit 1923's, unchanged): every
# turn, warm-up included, on a freshly started build pinned to CPU 2, wrk -t2 -c64 for 3 s on CPUs
# 4 and 5, this script and perf on CPU 7, the order turned every pair, jemalloc preloaded, the two
# builds' answers compared first (status, headers but Date, body, after mask.sed); one unrecorded
# pair, then R (DIAG_R) recorded pairs, counting cycles:u, cycles:k and instructions:u at 100%. The
# three comparisons are interleaved by placement (placement 1 of each, then 2 of each, ...), so a
# drift of the host over the run falls on all three alike.
#   verify       before anything: every placement answers as its side's unpadded binary
#                (verify.sh, results/verify/); a failure stops the run
#   check        each comparison's placement 1, answers and its unrecorded pair only
#                (results/check-only/); a failure stops the run
#   placements   K x 3 runs (results/<comparison>/p<NN>/), then DIAG_K diagnostic runs; a failed
#                one is reported and the run goes on, and its comparison then gives no bound
# Then results/placements.md and placements.json (report.mjs). The plan cannot be changed from the
# environment: PAIRS, WARMUP, TURN, EVENTS, CHECKS, MASK, EXPECT, STATUS and NOPERF are refused.
# DRYRUN=1 (plan.sh; a container test, not a measurement): the first 5 pads, 2 diagnostic
# placements, 2 pairs.
set -u
P=/m/1965; RES=$P/results
for v in PAIRS WARMUP TURN EVENTS CHECKS MASK EXPECT STATUS NOPERF; do
    eval "set_=\${$v+x}"
    [ -z "$set_" ] || { echo "run.sh: $v is set in the environment; the plan (plan.env, margin.md) fixes it"; exit 1; }
done
. $P/plan.sh
mkdir -p $RES
[ -f $RES/margin.md ] || { echo "no $RES/margin.md: it is written before the run"; exit 1; }
if [ "$DRY" = 1 ]; then echo "DRY RUN: K=$K, R=$R, DIAG_K=$DIAG_K, DIAG_R=$DIAG_R; not a measurement" >$RES/DRYRUN; else rm -f $RES/DRYRUN; fi
for b in main base head; do [ -x $P/bin/$b ] || { echo "no $P/bin/$b: run build.sh"; exit 1; }; done
for n in $PADS_P; do for b in main-p$n base-p$n head-p$n; do [ -x $P/bin/$b ] || { echo "no $P/bin/$b: run build.sh"; exit 1; }; done; done
for n in $PADS_Q; do [ -x $P/bin/main-p$n ] || { echo "no $P/bin/main-p$n: run build.sh"; exit 1; }; done
[ -f /root/.cargo/env ] && . /root/.cargo/env
say() { echo "$*" | tee -a $RES/progress.log; }
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'
cmd() { echo "$J $P/bin/$1 \$PORT $2"; }
CYCLES=cycles:u,cycles:k,instructions:u

pf=$RES/preflight; mkdir -p $pf
ok=1
perf stat -x, -e $CYCLES -o $pf/cycles.perf -- taskset -c 2 sh -c 'i=0; while [ $i -lt 1000000 ]; do i=$((i + 1)); done' >/dev/null 2>&1 || ok=0
for e in cycles:u cycles:k instructions:u; do
    awk -F, -v e=$e '$3 == e && $1 ~ /^[0-9]+$/ && $5 + 0 >= 100 { ok++ } END { exit ok != 1 }' $pf/cycles.perf 2>/dev/null || ok=0
done
[ $ok = 1 ] || { echo "perf cannot count $CYCLES at 100% here:"; cat $pf/cycles.perf 2>/dev/null; exit 1; }
cp $P/plan.env $P/commits.env $RES/

{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) (runs as $(id -un))"; uname -a;
  RUSTUP_TOOLCHAIN=1.100.0 rustc -vV; perf version 2>/dev/null; wrk -v 2>&1 | head -1; as --version | head -1;
  echo "main .comment: $(readelf -p .comment $P/bin/main 2>/dev/null | sed -n 's/^ *\[ *[0-9a-f]*\] *//p' | paste -sd';' -)";
  echo "main $(cat $P/src-main.commit) base $(cat $P/src-base.commit) head $(cat $P/src-head.commit)";
  dpkg -s libjemalloc2 libzstd1 wrk 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries (sha256, size):"; cat $P/bin/sha256.txt;
  echo "placements (layout against the side's unpadded binary):"; cat $P/bin/placements.txt; cat $P/bin/placements-summary.txt;
  echo "allocator: jemalloc (LD_PRELOAD=libjemalloc.so.2, MALLOC_CONF=background_thread:true,tcache_max:65536)";
  echo "plan: K=$K placements, R=$R recorded pairs each after 1 unrecorded, $CYCLES; diagnostic DIAG_K=$DIAG_K, DIAG_R=$DIAG_R";
  echo "PADS_P: $PADS_P"; echo "PADS_Q: $PADS_Q";
  echo "every turn on a fresh start; server CPU 2, wrk CPUs 4,5, driver and perf CPU 7";
  [ "$DRY" = 1 ] && echo "DRY RUN: not a measurement"; } >"$RES/host.txt" 2>&1

all_warm() { # <out dir> <workload> <pairs>: every start of both builds logged the page kept, all of one size (kit 1923's)
    aw_want=$((1 + 1 + $3))
    aw_size=$(grep -m1 '^WARM ' "$1/serve-$2-base.log" | sed 's/.*, \([0-9]*\) bytes$/\1/')
    for aw_v in base head; do
        aw_f=$1/serve-$2-$aw_v.log
        aw_n=$(grep -c '^WARM ' "$aw_f" || true)
        aw_k=$(grep -c "^WARM .*content-encoding -, age [0-9][0-9]*, $aw_size bytes\$" "$aw_f" || true)
        [ "$aw_n" = "$aw_want" ] && [ "$aw_k" = "$aw_n" ] || { echo "all_warm: $2 $aw_v: $aw_k of $aw_n WARM lines kept ($aw_size bytes), $aw_want starts" >&2; return 1; }
        echo "all_warm: $2 $aw_v: $aw_k of $aw_want starts kept the page ($aw_size bytes)" | tee -a "$1/warm-$2-all.txt"
    done
}
# one <comparison> <i> <out dir> <pairs>: placement i of a comparison
one() {
    p=$(nth "$2" "$PADS_P"); q=$(nth "$2" "$PADS_Q")
    case $1 in
        aa-plain) A=main-p$p; B=main-p$q; w=plain; cfg=plain; path=/private; checks=checks-plain.txt ;;
        aa-kept) A=main-p$p; B=main-p$q; w=kept; cfg=hit; path=/page; checks=checks-kept.txt ;;
        change-kept) A=base-p$p; B=head-p$p; w=kept; cfg=hit; path=/page; checks=checks-kept.txt ;;
        unpadded-kept) A=main; B=main-p$p; w=kept; cfg=hit; path=/page; checks=checks-kept.txt ;;
    esac
    mkdir -p "$3"
    { echo "comparison $1 placement $2 workload $w"; echo "A $A $(grep "^$A " $P/bin/sha256.txt | cut -d' ' -f2)"; echo "B $B $(grep "^$B " $P/bin/sha256.txt | cut -d' ' -f2)"; } >"$3/placement.txt"
    WARMUP=1 TURN=3 EVENTS=$CYCLES CHECKS=$P/$checks MASK=$P/mask.sed \
        taskset -c 7 sh $P/run-pair-fresh.sh "$3" "$w" "$4" 2 4,5 "$path" $P/lua/get.lua "$(cmd $A $cfg)" "$(cmd $B $cfg)" || return 1
    [ "$w" != kept ] || all_warm "$3" "$w" "$4"
}

say "== 1965 verify start $(date -u +%T)"
sh $P/verify.sh $RES/verify >$RES/verify.log 2>&1 || { tail -20 $RES/verify.log; say "VERIFY-FAILED"; exit 1; }
tail -1 $RES/verify.log | tee -a $RES/progress.log
say "== 1965 check start $(date -u +%T)"
for c in aa-plain aa-kept change-kept unpadded-kept; do
    one $c 1 $RES/check-only/$c 0 >>$RES/check-only.log 2>&1 || { tail -20 $RES/check-only.log; say "CHECK-FAILED: $c"; exit 1; }
    say "$c: $(cat $RES/check-only/$c/answers-*/verdict.txt)"
done
say "== 1965 checks ok $(date -u +%T)"
FAILED=
run1() { # <comparison> <i> <pairs>
    d=$RES/$1/p$(printf %02d $2)
    if one $1 $2 $d $3 >>$RES/run.log 2>&1; then say "$1 p$(printf %02d $2) ok $(date -u +%T)"; else say "$1 p$(printf %02d $2) FAILED $(date -u +%T)"; tail -15 $RES/run.log; FAILED="$FAILED $1:p$2"; fi
}
i=1
while [ $i -le "$K" ]; do
    for c in aa-plain aa-kept change-kept; do run1 $c $i $R; done
    i=$((i + 1))
done
i=1
while [ $i -le "$DIAG_K" ]; do run1 unpadded-kept $i $DIAG_R; i=$((i + 1)); done
node $P/report.mjs $RES >$RES/placements.md && say "report: $RES/placements.md"
cp $P/bin/sha256.txt $P/bin/placements.txt $P/bin/placements-summary.txt $RES/ 2>/dev/null || true
mkdir -p $RES/layout && cp $P/bin/layout-*.txt $RES/layout/ 2>/dev/null || true
for s in main base head; do cp $P/capture/$s/args.json $RES/link-$s.json 2>/dev/null || true; done
say "failed:${FAILED:- none}"
say ALL-DONE