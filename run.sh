#!/bin/sh
# run.sh: corten-run/corten#1983's placement runs, after setup.sh, nothing else run or logged into
# on the host meanwhile. Start it detached so a dropped SSH session does not stop it:
#   nohup sh /m/1983/run.sh >/m/1983/run.out 2>&1 &
# and collect /m/1983/results when run.out ends with ALL-DONE. results/margin.md (written before
# the run) declares the plan; plan.env holds its numbers (K placements, R pairs, the pads, the
# clock's step and the Age ranges).
#
# Comparisons (A is the CSV's base rows, B its head rows), placement i = 1..K:
#   aa-old        base-p<p_i> against base-p<q_i>, workload old (GET /picture.png, kept, its Age
#                 past the table: the start's clock moved on by STEP seconds)
#   change-old    base-p<p_i> against head-p<p_i>, workload old: the change, each side moved by the
#                 same pad
#   aa-young      base-p<p_i> against base-p<q_i>, workload young (the same request, its Age in
#                 the table: the clock left alone)
#   change-young  base-p<p_i> against head-p<p_i>, workload young
# and a diagnostic, after them, i = 1..DIAG_K:
#   unpadded-old  base (unpadded, cargo's binary) against base-p<p_i>, workload old: where the
#                 unpadded build sits among the padded ones; no reading uses it
# Every placement of a comparison is one run of run-pair-old.sh: every turn, warm-up included, on
# a freshly started build pinned to CPU 2, wrk -t2 -c64 for 3 s on CPUs 4 and 5, this script and
# perf on CPU 7, the order turned every pair, jemalloc and the clock shim preloaded, the two
# builds' answers compared first; one unrecorded pair, then R (DIAG_R) recorded pairs, counting
# plan.sh's EVENTS at 100%; every start's Age checked against the workload's range before and
# after its turn, and its handler's runs. The four comparisons are interleaved by placement
# (placement 1 of each, then 2 of each, ...), so a drift of the host over the run falls on all
# alike.
#   verify       before anything: every placement answers as its side's unpadded binary
#                (verify.sh, results/verify/); a failure stops the run
#   check        each comparison's placement 1, answers and its unrecorded pair only
#                (results/check-only/); a failure stops the run
#   placements   K x 4 runs (results/<comparison>/p<NN>/), then DIAG_K diagnostic runs; a failed
#                one is reported and the run goes on, and its comparison then gives no bound
# Then results/placements.md and placements.json (report.mjs). The plan cannot be changed from the
# environment: PAIRS, WARMUP, TURN, EVENTS, COLUMNS, STEP, K and R are refused. DRYRUN=1 (plan.sh;
# a container test, not a measurement): the first 5 pads, 2 diagnostic placements, 2 pairs, and a
# stand-in for perf.
set -u
P=/m/1983; RES=$P/results
for v in PAIRS WARMUP TURN EVENTS COLUMNS STEP K R; do
    eval "set_=\${$v+x}"
    [ -z "$set_" ] || { echo "run.sh: $v is set in the environment; the plan (plan.env, margin.md) fixes it"; exit 1; }
done
. $P/plan.sh
mkdir -p $RES
[ -f $RES/margin.md ] || { echo "no $RES/margin.md: it is written before the run"; exit 1; }
if [ "$DRY" = 1 ]; then echo "DRY RUN: K=$K, R=$R, DIAG_K=$DIAG_K, DIAG_R=$DIAG_R; not a measurement" >$RES/DRYRUN; else rm -f $RES/DRYRUN; fi
for b in base head; do [ -x $P/bin/$b ] || { echo "no $P/bin/$b: run build.sh"; exit 1; }; done
for n in $PADS_P; do for b in base-p$n head-p$n; do [ -x $P/bin/$b ] || { echo "no $P/bin/$b: run build.sh"; exit 1; }; done; done
for n in $PADS_Q; do [ -x $P/bin/base-p$n ] || { echo "no $P/bin/base-p$n: run build.sh"; exit 1; }; done
[ -f $P/shim/clockstep.so ] || { echo "no $P/shim/clockstep.so: run build.sh"; exit 1; }
[ -f /root/.cargo/env ] && . /root/.cargo/env
say() { echo "$*" | tee -a $RES/progress.log; }
cmd() { echo "$J $P/bin/$1 \$PORT old"; }

# The counters, counted for a process that is attached to as a turn's server is, all at 100%.
pf=$RES/preflight; mkdir -p $pf
ok=1
taskset -c 2 sh -c 'i=0; while [ $i -lt 3000000 ]; do i=$((i + 1)); done' &
busy=$!
perf stat -x, -e $EVENTS -p $busy -o $pf/counts.perf -- sleep 1 >/dev/null 2>&1 || ok=0
kill $busy 2>/dev/null; wait $busy 2>/dev/null
for e in $(echo $EVENTS | tr ',' ' '); do
    awk -F, -v e=$e 'BEGIN { n = e; sub(/:u$/, "", n) } ($3 == e || $3 == n) && $1 ~ /^[0-9]+$/ && $5 + 0 >= 100 { ok++ } END { exit ok != 1 }' $pf/counts.perf 2>/dev/null || ok=0
done
[ $ok = 1 ] || { echo "perf cannot count $EVENTS at 100% here:"; cat $pf/counts.perf 2>/dev/null; exit 1; }
cp $P/plan.env $P/commits.env $RES/

{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) (runs as $(id -un))"; uname -a;
  RUSTUP_TOOLCHAIN=1.100.0 rustc -vV; perf version 2>/dev/null; wrk -v 2>&1 | head -1; as --version | head -1; cc --version | head -1; curl --version | head -1;
  echo "base .comment: $(readelf -p .comment $P/bin/base 2>/dev/null | sed -n 's/^ *\[ *[0-9a-f]*\] *//p' | paste -sd';' -)";
  echo "base $(cat $P/src-base.commit) head $(cat $P/src-head.commit)";
  dpkg -s libjemalloc2 libzstd1 wrk 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries (sha256, size):"; cat $P/bin/sha256.txt;
  echo "placements (layout against the side's unpadded binary):"; cat $P/bin/placements.txt; cat $P/bin/placements-summary.txt;
  echo "clock shim: $(sha256sum $P/shim/clockstep.so | cut -d' ' -f1), step $STEP s for the workload old";
  echo "started as: $J <binary> <port> old";
  echo "plan: K=$K placements, R=$R recorded pairs each after 1 unrecorded, $EVENTS; diagnostic DIAG_K=$DIAG_K, DIAG_R=$DIAG_R";
  echo "ages: old $OLD_LOW..$OLD_HIGH, young $YOUNG_LOW..$YOUNG_HIGH";
  echo "PADS_P: $PADS_P"; echo "PADS_Q: $PADS_Q";
  echo "every turn on a fresh start; server CPU 2, wrk CPUs 4,5, driver and perf CPU 7";
  [ "$DRY" = 1 ] && echo "DRY RUN: not a measurement"; } >"$RES/host.txt" 2>&1

# one <comparison> <i> <out dir> <pairs>: placement i of a comparison
one() {
    p=$(nth "$2" "$PADS_P"); q=$(nth "$2" "$PADS_Q")
    case $1 in
        aa-old) A=base-p$p; B=base-p$q; w=old ;;
        change-old) A=base-p$p; B=head-p$p; w=old ;;
        aa-young) A=base-p$p; B=base-p$q; w=young ;;
        change-young) A=base-p$p; B=head-p$p; w=young ;;
        unpadded-old) A=base; B=base-p$p; w=old ;;
    esac
    mkdir -p "$3"
    { echo "comparison $1 placement $2 workload $w"; echo "A $A $(grep "^$A " $P/bin/sha256.txt | cut -d' ' -f2)"; echo "B $B $(grep "^$B " $P/bin/sha256.txt | cut -d' ' -f2)"; } >"$3/placement.txt"
    WARMUP=1 TURN=3 taskset -c 7 sh $P/run-pair-old.sh "$3" "$w" "$4" 2 4,5 "$(cmd $A)" "$(cmd $B)" || return 1
    # Every start of the placement, the unrecorded pair's included, has its line of ages.
    [ "$(grep -c ' before [0-9][0-9]* after [0-9][0-9]* runs 1$' "$3/ages-$w.txt")" = $((2 + 2 * $4)) ] || { echo "$1 p$2: ages-$w.txt does not hold $((2 + 2 * $4)) checked starts" >&2; return 1; }
}

say "== 1983 verify start $(date -u +%T)"
sh $P/verify.sh $RES/verify >$RES/verify.log 2>&1 || { tail -20 $RES/verify.log; say "VERIFY-FAILED"; exit 1; }
tail -1 $RES/verify.log | tee -a $RES/progress.log
say "== 1983 check start $(date -u +%T)"
for c in aa-old change-old aa-young change-young unpadded-old; do
    one $c 1 $RES/check-only/$c 0 >>$RES/check-only.log 2>&1 || { tail -20 $RES/check-only.log; say "CHECK-FAILED: $c"; exit 1; }
    say "$c: $(sed -n 1p $RES/check-only/$c/answers-*/verdict.txt); $(sed -n 2p $RES/check-only/$c/answers-*/verdict.txt)"
done
say "== 1983 checks ok $(date -u +%T)"
FAILED=
run1() { # <comparison> <i> <pairs>
    d=$RES/$1/p$(printf %02d $2)
    if one $1 $2 $d $3 >>$RES/run.log 2>&1; then say "$1 p$(printf %02d $2) ok $(date -u +%T)"; else say "$1 p$(printf %02d $2) FAILED $(date -u +%T)"; tail -15 $RES/run.log; FAILED="$FAILED $1:p$2"; fi
}
i=1
while [ $i -le "$K" ]; do
    for c in aa-old change-old aa-young change-young; do run1 $c $i $R; done
    i=$((i + 1))
done
i=1
while [ $i -le "$DIAG_K" ]; do run1 unpadded-old $i $DIAG_R; i=$((i + 1)); done
node $P/report.mjs $RES >$RES/placements.md && say "report: $RES/placements.md"
cp $P/bin/sha256.txt $P/bin/placements.txt $P/bin/placements-summary.txt $RES/ 2>/dev/null || true
mkdir -p $RES/layout && cp $P/bin/layout-*.txt $RES/layout/ 2>/dev/null || true
for s in base head; do cp $P/capture/$s/args.json $RES/link-$s.json 2>/dev/null || true; done
cp $P/shim/clockstep.c $RES/ 2>/dev/null || true
say "failed:${FAILED:- none}"
say ALL-DONE
