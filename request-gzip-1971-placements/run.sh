#!/bin/sh
# run.sh <workload>: one host's share of corten-run/corten#1971's placement run, after setup.sh,
# nothing else run or logged into on the host meanwhile. <workload> is plain or zstd; each host
# takes one (results/margin.md says which). Start it detached:
#   nohup sh /m/1971/run.sh plain >/m/1971/run.out 2>&1 &
# and collect /m/1971/results when run.out ends with ALL-DONE. results/margin.md (written before
# the run) declares the plan; plan.env holds its numbers (K placements, R pairs, the pads).
#
# Comparisons (A is the CSV's base rows, B its head rows), placement i = 1..K, for workload <w>:
#   aa-<w>       base-p<p_i> against base-p<q_i>: the change's base against itself, each side its
#                own placement; what the run can resolve on <w>
#   change-<w>   base-p<p_i> against head-p<p_i>: the change, each side moved by the same pad
# and on the zstd host, after them, one single-build comparison:
#   sb-gzbr      base against head, the unpadded binaries cargo built, SB_PAIRS recorded pairs: the
#                reduction the change is for
# Workloads, all GET /private (the record page for one visitor, about 6 KB) to config `plain`:
#   plain   no Accept-Encoding: sent as it is                        (lua/get.lua)
#   zstd    Accept-Encoding: gzip, deflate, br, zstd: zstd 1 on both sides   (lua/get-zstd.lua)
#   gzbr    Accept-Encoding: gzip, br: brotli 1 on base, libdeflate's gzip on head (lua/get-gzbr.lua)
# Every placement of a comparison is one run of run-pair-fresh.sh (kit 1923's, with the answer
# check changed to compare bodies raw): every turn, warm-up included, on a freshly started build
# pinned to CPU 2, wrk -t2 -c64 for 3 s on CPUs 4 and 5, this script and perf on CPU 7, the order
# turned every pair, jemalloc preloaded, the two builds' answers compared first; one unrecorded
# pair, then R recorded pairs, counting cycles:u, cycles:k, instructions:u and
# L1-icache-load-misses:u at 100%. The two comparisons are interleaved by placement (placement 1
# of each, then 2 of each, ...), so a drift of the host over the run falls on both alike.
#   verify       before anything: every placement answers as its side's unpadded binary
#                (verify.sh, results/verify/); a failure stops the run
#   check        each comparison's placement 1, answers and its unrecorded pair only
#                (results/check-only/); a failure stops the run
#   placements   K x 2 runs (results/<comparison>/p<NN>/); a failed one is reported and the run
#                goes on, and its comparison then gives no bound
# Then results/placements-<w>.md and .json (report71.mjs). The plan cannot be changed from the
# environment: PAIRS, WARMUP, TURN, EVENTS, CHECKS, MASK, EXPECT, STATUS and NOPERF are refused.
# DRYRUN=1 (plan.sh; a test of the scripts, not a measurement): the first 5 pads, 2 pairs.
set -u
P=/m/1971; RES=$P/results
W=${1:-}
case "$W" in plain|zstd) ;; *) echo "usage: run.sh plain|zstd"; exit 2 ;; esac
for v in PAIRS WARMUP TURN EVENTS CHECKS MASK EXPECT STATUS NOPERF; do
    eval "set_=\${$v+x}"
    [ -z "$set_" ] || { echo "run.sh: $v is set in the environment; the plan (plan.env, margin.md) fixes it"; exit 1; }
done
. $P/plan.sh
mkdir -p $RES
[ -f $RES/margin.md ] || { echo "no $RES/margin.md: it is written before the run"; exit 1; }
if [ "$DRY" = 1 ]; then echo "DRY RUN: K=$K, R=$R, SB_PAIRS=$SB_PAIRS; not a measurement" >$RES/DRYRUN; else rm -f $RES/DRYRUN; fi
for b in base head; do [ -x $P/bin/$b ] || { echo "no $P/bin/$b: run build.sh"; exit 1; }; done
for n in $PADS_P; do for b in base-p$n head-p$n; do [ -x $P/bin/$b ] || { echo "no $P/bin/$b: run build.sh"; exit 1; }; done; done
for n in $PADS_Q; do [ -x $P/bin/base-p$n ] || { echo "no $P/bin/base-p$n: run build.sh"; exit 1; }; done
[ -f /root/.cargo/env ] && . /root/.cargo/env
say() { echo "$*" | tee -a $RES/progress.log; }
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'
cmd() { echo "$J $P/bin/$1 \$PORT plain"; }
COUNTS=cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u

pf=$RES/preflight; mkdir -p $pf
ok=1
perf stat -x, -e $COUNTS -o $pf/counts.perf -- taskset -c 2 sh -c 'i=0; while [ $i -lt 1000000 ]; do i=$((i + 1)); done' >/dev/null 2>&1 || ok=0
for e in cycles:u cycles:k instructions:u L1-icache-load-misses; do
    awk -F, -v e=$e '($3 == e || $3 == e ":u") && $1 ~ /^[0-9]+$/ && $5 + 0 >= 100 { ok++ } END { exit ok != 1 }' $pf/counts.perf 2>/dev/null || ok=0
done
[ $ok = 1 ] || { echo "perf cannot count $COUNTS at 100% here:"; cat $pf/counts.perf 2>/dev/null; exit 1; }
cp $P/plan.env $P/commits.env $RES/

{ date -u; echo "workload: $W"; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) (runs as $(id -un))"; uname -a;
  RUSTUP_TOOLCHAIN=1.100.0 rustc -vV; perf version 2>/dev/null; wrk -v 2>&1 | head -1; as --version | head -1;
  echo "base .comment: $(readelf -p .comment $P/bin/base 2>/dev/null | sed -n 's/^ *\[ *[0-9a-f]*\] *//p' | paste -sd';' -)";
  echo "base $(cat $P/src-base.commit) head $(cat $P/src-head.commit)";
  dpkg -s libjemalloc2 libzstd1 wrk 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries (sha256, size):"; cat $P/bin/sha256.txt;
  echo "placements (layout against the side's unpadded binary):"; cat $P/bin/placements.txt; cat $P/bin/placements-summary.txt;
  echo "allocator: jemalloc (LD_PRELOAD=libjemalloc.so.2, MALLOC_CONF=background_thread:true,tcache_max:65536)";
  echo "plan: K=$K placements, R=$R recorded pairs each after 1 unrecorded, $COUNTS; single build SB_PAIRS=$SB_PAIRS";
  echo "PADS_P: $PADS_P"; echo "PADS_Q: $PADS_Q";
  echo "every turn on a fresh start; server CPU 2, wrk CPUs 4,5, driver and perf CPU 7";
  [ "$DRY" = 1 ] && echo "DRY RUN: not a measurement"; } >"$RES/host.txt" 2>&1

# one <comparison> <i> <out dir> <pairs>: placement i of a comparison (i is unused by sb-gzbr)
one() {
    p=$(nth "$2" "$PADS_P"); q=$(nth "$2" "$PADS_Q")
    mask=$P/mask-none.sed
    case $1 in
        aa-plain) A=base-p$p; B=base-p$q; w=plain; lua=get.lua; checks=checks-plain.txt ;;
        change-plain) A=base-p$p; B=head-p$p; w=plain; lua=get.lua; checks=checks-plain.txt ;;
        aa-zstd) A=base-p$p; B=base-p$q; w=zstd; lua=get-zstd.lua; checks=checks-zstd.txt; mask=$P/mask-etag.sed ;;
        change-zstd) A=base-p$p; B=head-p$p; w=zstd; lua=get-zstd.lua; checks=checks-zstd.txt; mask=$P/mask-etag.sed ;;
        sb-gzbr) A=base; B=head; w=gzbr; lua=get-gzbr.lua; checks=checks-gzbr.txt; mask=$P/mask-gzbr.sed ;;
    esac
    mkdir -p "$3"
    { echo "comparison $1 placement $2 workload $w"; echo "A $A $(grep "^$A " $P/bin/sha256.txt | cut -d' ' -f2)"; echo "B $B $(grep "^$B " $P/bin/sha256.txt | cut -d' ' -f2)"; } >"$3/placement.txt"
    WARMUP=1 TURN=3 EVENTS=$COUNTS CHECKS=$P/$checks MASK=$mask \
        taskset -c 7 sh $P/run-pair-fresh.sh "$3" "$w" "$4" 2 4,5 /private $P/lua/$lua "$(cmd $A)" "$(cmd $B)" || return 1
}

say "== 1971 $W verify start $(date -u +%T)"
sh $P/verify.sh $RES/verify >$RES/verify.log 2>&1 || { tail -20 $RES/verify.log; say "VERIFY-FAILED"; exit 1; }
tail -1 $RES/verify.log | tee -a $RES/progress.log
say "== 1971 $W check start $(date -u +%T)"
CHECK="aa-$W change-$W"; [ "$W" = zstd ] && CHECK="$CHECK sb-gzbr"
for c in $CHECK; do
    one $c 1 $RES/check-only/$c 0 >>$RES/check-only.log 2>&1 || { tail -20 $RES/check-only.log; say "CHECK-FAILED: $c"; exit 1; }
    say "$c: $(cat $RES/check-only/$c/answers-*/verdict.txt)"
done
say "== 1971 $W checks ok $(date -u +%T)"
FAILED=
run1() { # <comparison> <i> <pairs>
    d=$RES/$1/p$(printf %02d $2)
    if one $1 $2 $d $3 >>$RES/run.log 2>&1; then say "$1 p$(printf %02d $2) ok $(date -u +%T)"; else say "$1 p$(printf %02d $2) FAILED $(date -u +%T)"; tail -15 $RES/run.log; FAILED="$FAILED $1:p$2"; fi
}
i=1
while [ $i -le "$K" ]; do
    for c in aa-$W change-$W; do run1 $c $i $R; done
    i=$((i + 1))
done
if [ "$W" = zstd ]; then
    if one sb-gzbr 1 $RES/sb-gzbr $SB_PAIRS >>$RES/run.log 2>&1; then say "sb-gzbr ok $(date -u +%T)"; else say "sb-gzbr FAILED $(date -u +%T)"; tail -15 $RES/run.log; FAILED="$FAILED sb-gzbr"; fi
fi
node $P/report71.mjs $RES $W >$RES/placements-$W.md && say "report: $RES/placements-$W.md"
cp $P/bin/sha256.txt $P/bin/placements.txt $P/bin/placements-summary.txt $RES/ 2>/dev/null || true
mkdir -p $RES/layout && cp $P/bin/layout-*.txt $P/bin/tail-*.txt $RES/layout/ 2>/dev/null || true
for s in base head; do cp $P/capture/$s/args.json $RES/link-$s.json 2>/dev/null || true; done
say "failed:${FAILED:- none}"
say ALL-DONE
