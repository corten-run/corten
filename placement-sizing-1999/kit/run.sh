#!/bin/sh
# run.sh: kit 1999's session (corten-run/corten#1999 and #1996), after setup.sh, nothing else run
# or logged into on the host meanwhile. Start it detached so a dropped SSH session does not stop it:
#   nohup sh /m/1999/run.sh >/m/1999/run.out 2>&1 &
# and collect /m/1999/results when run.out ends with ALL-DONE. Every way run.sh ends, a refusal or
# failure as well as the end of the schedule, writes one line "RUN-ENDED <outcome>: <what>" and then
# ALL-DONE to run.out and results/progress.log (setup.sh and start.sh do the same for a failed
# setup), so the collector waits for ALL-DONE alone and reads the line before it. Outcomes:
# complete, incomplete, report-refused, report-crashed (the comparison was run; report.mjs's exit
# 0, 1, 2, or anything else), and refused, missing-binaries, perf-preflight-failed, verify-failed,
# check-failed, killed, unexpected-exit (nothing or not all was run). plan.md (written before any
# measurement) declares the plan; plan.env holds its numbers.
#
# Comparisons (A is the CSV's base rows, B its head rows), all on the workload `old` (GET
# /picture.png given kept, its Age past the table: the start's clock moved on by STEP seconds):
#   aa-old         A: base-p<p_i> against base-p<q_i>, i = 1..K_A (100), R pairs: base against
#                  itself with two lists of pads, read as recorded and with the labels swapped
#   same-old       B: base-p<p_i> against base-p<p_i>, i = 1..K_B (0: cut, plan.md), R pairs: one binary on
#                  both sides, every turn a fresh start, so no placement differs between A and B
#   unpadded-base  C: base (cargo's binary) against base-p<p_i>, i = 1..K_C (8), R_C pairs
#   unpadded-head  C: head against head-p<p_i>
#   unpadded-x1    C: x1 (commits.env X1, unpadded) against base-p<p_i>
#   unpadded-x2    C: x2 (commits.env X2, unpadded) against base-p<p_i>
# Every placement is one run of run-pair-old.sh (kit 1983's, unchanged): every turn, warm-up
# included, on a freshly started build pinned to CPU 2, wrk -t2 -c64 for TURN (3) s on CPUs 4 and
# 5, this script and perf on CPU 7, the order turned every pair, jemalloc and the clock shim
# preloaded, the two builds' answers compared first; one unrecorded pair, then the recorded pairs,
# counting plan.sh's EVENTS at 100%; every start's Age checked against its range before and after
# its turn, and its handler's runs. The placements run in schedule.mjs's order (results/
# schedule.txt): the parts spread through the session, C's four comparisons side by side in every
# round, so a drift of the host falls on all alike.
#   verify       before anything: every placement answers as its side's unpadded binary, and x1
#                and x2 as base (verify.sh, results/verify/); a failure stops the run
#   check        each comparison's placement 1, answers and its unrecorded pair only
#                (results/check-only/); a failure stops the run
#   placements   the schedule (results/<comparison>/p<NNN>/), each stopped (and failed) after
#                PLACEMENT_TIMEOUT s; a failed one is reported and the run goes on
#   retries      after the schedule, the first RETRY_MAX failed placements, in the order they
#                failed, are run once more (seq K + 1, K + 2, ...; results/retries.txt), their failed
#                attempt moved to results/failed/; a placement that fails twice, or one past
#                RETRY_MAX, leaves its comparison without a bound (plan.md, Amendment 1)
# Every placement's placement.txt names the kit, this run's id, the plan's sha256, its place in
# the schedule and its two binaries with their sha256s, and is finished with an "ended" line only
# when its pairs are all in; report.mjs refuses a placement that lacks any of them. Then
# results/report.md and report.json (report.mjs). The plan cannot be changed from the environment:
# PAIRS, WARMUP, TURN, EVENTS, COLUMNS, STEP, K_A, K_B, K_C, R, R_C, KIT, RUN_ID, SCHEDULE_SEED,
# PLACEMENT_TIMEOUT and RETRY_MAX are refused, and a results directory that already holds a run is
# refused. DRYRUN=1 (plan.sh; a container test, not a measurement): DRY_K_A, DRY_K_B and DRY_K_C
# placements, DRY_R pairs, DRY_TURN s turns, a stand-in for perf, and DRY_FAIL_SEQ (a placement
# whose first attempt is given 1 s, to test the timeout and the retry).
set -u
RES=
# finish <exit code> <outcome: what>: the last two lines of every way run.sh ends.
finish() {
    trap - EXIT INT TERM
    if [ -n "$RES" ] && [ -d "$RES" ]; then { echo "RUN-ENDED $2"; echo ALL-DONE; } >>$RES/progress.log; fi
    echo "RUN-ENDED $2"; echo ALL-DONE
    exit "$1"
}
trap 'st=$?; finish $st "unexpected-exit: run.sh stopped with status $st before its end (see the lines above)"' EXIT
trap 'finish 130 "killed: run.sh got INT"' INT
trap 'finish 143 "killed: run.sh got TERM"' TERM
for v in PAIRS WARMUP TURN EVENTS COLUMNS STEP K_A K_B K_C R R_C KIT RUN_ID SCHEDULE_SEED PLACEMENT_TIMEOUT RETRY_MAX; do
    eval "set_=\${$v+x}"
    [ -z "$set_" ] || finish 1 "refused: $v is set in the environment; the plan (plan.env, plan.md) fixes it"
done
. /m/1999/plan.sh
[ -f $P/plan.md ] || finish 1 "refused: no $P/plan.md: the plan is written before the run"
[ ! -e $P/results/run-id ] || finish 1 "refused: $P/results already holds run $(cat $P/results/run-id): move it away first"
[ -z "$(ls -A $P/results 2>/dev/null)" ] || finish 1 "refused: $P/results is not empty: move it away first"
for b in $SIDES; do [ -x $P/bin/$b ] || finish 1 "missing-binaries: no $P/bin/$b: run build.sh"; done
for n in $PADS_P $PADS_Q; do [ -x $P/bin/base-p$n ] || finish 1 "missing-binaries: no $P/bin/base-p$n: run build.sh"; done
for n in $HEAD_PADS; do [ -x $P/bin/head-p$n ] || finish 1 "missing-binaries: no $P/bin/head-p$n: run build.sh"; done
[ -f $P/shim/clockstep.so ] || finish 1 "missing-binaries: no $P/shim/clockstep.so: run build.sh"
node $P/pads.mjs --check $P/plan.env || finish 1 "refused: plan.env's pads are not pads.mjs's or miss the rule"
command -v timeout >/dev/null || finish 1 "refused: no timeout command (coreutils) to bound a placement"
RES=$P/results
mkdir -p $RES
[ -f /root/.cargo/env ] && . /root/.cargo/env
RUN_ID=$(cat /proc/sys/kernel/random/uuid)
PLAN_SHA=$(cat $P/plan.env $P/commits.env | sha256sum | cut -d' ' -f1)
echo "$RUN_ID" >$RES/run-id
{ echo "kit $KIT"; echo "run $RUN_ID"; echo "plan $PLAN_SHA"; } >$RES/kit.txt
if [ "$DRY" = 1 ]; then echo "DRY RUN: K_A=$K_A, K_B=$K_B, K_C=$K_C, R=$R, R_C=$R_C, TURN=$TURN; fail seq ${DRY_FAIL_SEQ:-none}; not a measurement" >$RES/DRYRUN; fi
cp $P/plan.md $P/plan.env $P/commits.env $RES/
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
[ $ok = 1 ] || { echo "perf cannot count $EVENTS at 100% here:"; cat $pf/counts.perf 2>/dev/null; finish 1 "perf-preflight-failed: perf cannot count $EVENTS at 100% (results/preflight/counts.perf)"; }

# What build.sh checked, in the results before any turn, so a report has it whatever happens later.
cp $P/bin/sha256.txt $P/bin/placements.txt $P/bin/placements-summary.txt $P/bin/unpadded.txt $RES/
mkdir -p $RES/layout && cp $P/bin/layout-*.txt $RES/layout/
for s in $SIDES; do cp $P/capture/$s/args.json $RES/link-$s.json; done
cp $P/shim/clockstep.c $RES/
{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) (runs as $(id -un))"; uname -a;
  RUSTUP_TOOLCHAIN=1.100.0 rustc -vV; perf version 2>/dev/null; wrk -v 2>&1 | head -1; as --version | head -1; cc --version | head -1; curl --version | head -1; node --version;
  echo "base .comment: $(readelf -p .comment $P/bin/base 2>/dev/null | sed -n 's/^ *\[ *[0-9a-f]*\] *//p' | paste -sd';' -)";
  for s in $SIDES; do echo "$s $(cat $P/src-$s.commit)"; done;
  dpkg -s libjemalloc2 libzstd1 wrk 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries (sha256, size):"; cat $P/bin/sha256.txt;
  echo "unpadded .text:"; cat $P/bin/unpadded.txt;
  echo "placements (layout against the side's unpadded binary):"; cat $P/bin/placements.txt; cat $P/bin/placements-summary.txt;
  echo "clock shim: $(sha256sum $P/shim/clockstep.so | cut -d' ' -f1), step $STEP s for the workload old";
  echo "started as: $J <binary> <port> old";
  echo "plan: K_A=$K_A, K_B=$K_B, K_C=$K_C placements; R=$R (A, B), R_C=$R_C (C) recorded pairs each after 1 unrecorded; TURN=$TURN s; $EVENTS";
  echo "ages: old $OLD_LOW..$OLD_HIGH";
  echo "PADS_P: $PADS_P"; echo "PADS_Q: $PADS_Q";
  echo "every turn on a fresh start; server CPU 2, wrk CPUs 4,5, driver and perf CPU 7";
  echo "kit $KIT run $RUN_ID plan $PLAN_SHA";
  echo "os: $([ -f /etc/os-release ] && . /etc/os-release && echo "$PRETTY_NAME")"; echo "kernel.randomize_va_space $(cat /proc/sys/kernel/randomize_va_space)";
  echo "schedule seed $SCHEDULE_SEED; placement timeout $PLACEMENT_TIMEOUT s; at most $RETRY_MAX retries";
  [ "$DRY" = 1 ] && echo "DRY RUN: not a measurement"; } >"$RES/host.txt" 2>&1
# The host, in fixed lines report.mjs reads (Amendment 1, P2-2): the 1.97% comparison is a test of
# chance only on the second run's CPU model.
{ echo "model $(awk -F': *' '/^model name/ { print $2; exit }' /proc/cpuinfo)"
  echo "microcode $(awk -F': *' '/^microcode/ { print $2; exit }' /proc/cpuinfo)"
  echo "kernel $(uname -r)"
  echo "randomize_va_space $(cat /proc/sys/kernel/randomize_va_space 2>/dev/null)"
  echo "os $([ -f /etc/os-release ] && . /etc/os-release && echo "$PRETTY_NAME")"; } >$RES/host-id.txt
# The kit as it ran (Amendment 1, P3-8): the tar it came from, and every script and data file.
TAR=${KIT_TAR:-/root/cycles-1996-1999.tar}
{ if [ -f "$TAR" ]; then echo "tar $(sha256sum "$TAR" | cut -d' ' -f1) $TAR"; else echo "tar none: no $TAR"; fi
  ( cd $P && find . -maxdepth 1 -type f ! -name run.out ! -name 'build-*.log' | LC_ALL=C sort | xargs sha256sum
    find dry lua probe/src probe/Cargo.toml shim/clockstep.c wrap -type f | LC_ALL=C sort | xargs sha256sum
    for s in $SIDES; do echo "$(find src-$s -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)  src-$s/ (sha256 of its files' sha256sum lines, sorted)"; done ); } >$RES/kit-sha256.txt
node $P/schedule.mjs "$K_A" "$K_B" "$K_C" "$SCHEDULE_SEED" >$RES/schedule.txt || finish 1 "refused: schedule.mjs gave no order"

sides() { # <comparison> <i>: "A B pairs"
    p=$(nth "$2" "$PADS_P"); q=$(nth "$2" "$PADS_Q")
    case $1 in
        aa-old) echo "base-p$p base-p$q $R" ;;
        same-old) echo "base-p$p base-p$p $R" ;;
        unpadded-base) echo "base base-p$p $R_C" ;;
        unpadded-head) echo "head head-p$p $R_C" ;;
        unpadded-x1) echo "x1 base-p$p $R_C" ;;
        unpadded-x2) echo "x2 base-p$p $R_C" ;;
        *) echo "no comparison $1" >&2; return 1 ;;
    esac
}
# one <comparison> <i> <out dir> <pairs or 0 for the check> <seq> [<timeout s>]: placement i of a
# comparison, stopped after PLACEMENT_TIMEOUT s (timeout signals run-pair-old.sh's whole process
# group, its servers, perf and wrk included, TERM and 30 s later KILL)
one() {
    limit=${6:-$PLACEMENT_TIMEOUT}
    set -- "$1" "$2" "$3" "$4" "$5" $(sides "$1" "$2") || return 1
    A=$6; B=$7
    mkdir -p "$3"
    { echo "comparison $1 placement $2 workload old"; echo "A $A $(grep "^$A " $P/bin/sha256.txt | cut -d' ' -f2)"; echo "B $B $(grep "^$B " $P/bin/sha256.txt | cut -d' ' -f2)";
      echo "kit $KIT"; echo "run $RUN_ID"; echo "plan $PLAN_SHA"; echo "seq $5"; echo "started $(date -u +%FT%TZ)"; } >"$3/placement.txt"
    WARMUP=1 timeout -k 30 "$limit" taskset -c 7 sh $P/run-pair-old.sh "$3" old "$4" 2 4,5 "$(cmd $A)" "$(cmd $B)"
    rc=$?
    [ $rc = 0 ] || { [ $rc = 124 ] || [ $rc = 137 ] && echo "$1 p$2: stopped after $limit s (timeout, exit $rc)" >&2; return 1; }
    # Every start of the placement, the unrecorded pair's included, has its line of ages.
    [ "$(grep -c ' before [0-9][0-9]* after [0-9][0-9]* runs 1$' "$3/ages-old.txt")" = $((2 + 2 * $4)) ] || { echo "$1 p$2: ages-old.txt does not hold $((2 + 2 * $4)) checked starts" >&2; return 1; }
    echo "ended $(date -u +%FT%TZ)" >>"$3/placement.txt"
}

say "== 1999 run $RUN_ID verify start $(date -u +%T)"
sh $P/verify.sh $RES/verify >$RES/verify.log 2>&1 || { tail -20 $RES/verify.log; say "VERIFY-FAILED"; finish 1 "verify-failed: a binary does not answer as its reference (results/verify.log)"; }
tail -1 $RES/verify.log | tee -a $RES/progress.log
say "== 1999 check start $(date -u +%T)"
CMPS="aa-old"; [ "$K_B" -gt 0 ] && CMPS="$CMPS same-old"; [ "$K_C" -gt 0 ] && CMPS="$CMPS unpadded-base unpadded-head unpadded-x1 unpadded-x2"
for c in $CMPS; do
    one $c 1 $RES/check-only/$c 0 0 >>$RES/check-only.log 2>&1 || { tail -20 $RES/check-only.log; say "CHECK-FAILED: $c"; finish 1 "check-failed: $c's placement 1 check (results/check-only.log)"; }
    say "$c: $(sed -n 1p $RES/check-only/$c/answers-old/verdict.txt); $(sed -n 2p $RES/check-only/$c/answers-old/verdict.txt)"
done
say "== 1999 checks ok $(date -u +%T); $(wc -l <$RES/schedule.txt) placements to run"
FAILED=
: >$RES/retries.txt
while read -r seq c i; do
    d=$RES/$c/p$(printf %03d $i)
    pairs=$(sides $c $i | cut -d' ' -f3)
    lim=$PLACEMENT_TIMEOUT; [ "$DRY" = 1 ] && [ "$seq" = "${DRY_FAIL_SEQ:-}" ] && lim=1
    if one $c $i $d $pairs $seq $lim >>$RES/run.log 2>&1; then say "$seq $c p$(printf %03d $i) ok $(date -u +%T)"; else say "$seq $c p$(printf %03d $i) FAILED $(date -u +%T)"; tail -15 $RES/run.log; FAILED="$FAILED $seq:$c:$i"; fi
done <$RES/schedule.txt
# Retries (plan.md, Amendment 1): the first RETRY_MAX failed placements, once each, in the order
# they failed, numbered on from the schedule; the failed attempt is kept in results/failed/.
n=$(wc -l <$RES/schedule.txt); tries=0; LOST=
for f in $FAILED; do
    seq0=${f%%:*}; rest=${f#*:}; c=${rest%%:*}; i=${rest#*:}; name=p$(printf %03d $i)
    if [ $tries -ge "$RETRY_MAX" ]; then LOST="$LOST $c:$name"; continue; fi
    tries=$((tries + 1)); seq=$((n + tries)); d=$RES/$c/$name
    mkdir -p $RES/failed; [ ! -e $d ] || mv $d $RES/failed/$c-$name-seq$seq0
    echo "$seq $c $i retry-of $seq0" >>$RES/retries.txt
    pairs=$(sides $c $i | cut -d' ' -f3)
    if one $c $i $d $pairs $seq >>$RES/run.log 2>&1; then say "$seq $c $name ok (retry of seq $seq0) $(date -u +%T)"; else say "$seq $c $name FAILED again (retry of seq $seq0) $(date -u +%T)"; tail -15 $RES/run.log; LOST="$LOST $c:$name"; fi
done
say "failed:${FAILED:- none}; retried $tries; lost (no bound for their comparison):${LOST:- none}"
rm -f $RES/report.json
node $P/report.mjs $RES >$RES/report.md 2>$RES/report.err
rc=$?
jx=$(node -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(j.exit ?? "none"); } catch { console.log("none"); }' $RES/report.json)
case "$rc:$jx" in
    0:0) out="complete: every comparison complete; results/report.md" ;;
    1:1) out="incomplete: one or more comparisons without a bound ($(node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Object.entries(j.complete).filter(([, v]) => !v).map(([c]) => c).join(", "));' $RES/report.json)); results/report.md" ;;
    2:2) out="report-refused: report.mjs refused the results (results/report.md lists why)" ;;
    *) out="report-crashed: report.mjs exit $rc, report.json exit $jx: $(head -c 300 $RES/report.err | tr '\n' ' ')" ;;
esac
say "report: $RES/report.md, report.mjs exit $rc (0 every comparison complete, 1 one or more incomplete, 2 refused, other: crashed)"
[ "${out%%:*}" = complete ] && finish 0 "$out"
finish 1 "$out"