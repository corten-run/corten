#!/bin/sh
# run.sh <workload>: one host's share of the part plan.env names, after setup.sh, nothing else run
# or logged into on the host meanwhile. <workload> is plain, wait, close, unstaged, after, beside
# or besidemt; a host takes one at a time. Start it detached so a dropped session does not stop it:
#   nohup sh /m/dl/run.sh plain >/m/dl/run.out 2>&1 &
# and collect /m/dl/results when run.out ends with ALL-DONE. Every way run.sh ends, a refusal or
# failure as well as the end of the schedule, writes one line "RUN-ENDED <outcome>: <what>" and
# then ALL-DONE to run.out and results/progress.log. Outcomes: complete, incomplete,
# report-refused, report-crashed (the schedule was run; report.mjs's exit 0, 1, 2, or anything
# else), and refused, wrong-source, missing-binaries, missing-map-record, perf-preflight-failed,
# verify-failed, state-failed, park-failed, check-failed, killed, unexpected-exit (nothing or not
# all was run).
# plan.md (written before any measurement) declares the plan; plan.env holds its numbers.
#
# Comparisons (A is the CSV's base rows, B its head rows), placement i = 1..K, for workload <w>:
#   pilot-<w>    (part pilot) base-p<p_i> against base-p<q_i>: an A/A of the base, read only for
#                the spread of its placement medians
#   aa-<w>       (part gated) base-p<p_i> against base-p<q_i>: the change's base against itself
#   change-<w>   (part gated) base-p<p_i> against head-p<p_i>: the change, each side moved by the
#                same pad
# Workloads, to the probe's config `plain` (one single-threaded runtime) unless said:
#   plain     GET /private, no request header of its own: the record page for one visitor,
#             about 6 KB                                                   (lua/get.lua)
#   wait      GET /wait, no request header of its own: the same page from a handler that
#             sleeps 1 ms first, so its deadline waits                     (lua/get.lua)
#   close     GET /wait with `Connection: close`: the same request with a connection for each,
#             so every connection serves one request whose deadline waits  (lua/close.lua)
#   unstaged  GET /unstaged, no request header of its own: a route that says `unstaged`,
#             answering a short str                                        (lua/get.lua)
#   after     GET /private as `plain` sends it, on connections that have each first sent
#             requests for /wait: each wrk thread's first 512 calls for a request get
#             GET /wait, every call after GET /private                     (lua/after.lua)
#   beside    GET /private on one connection (wrk -t1 -c1 on CPU 4), beside one more connection
#             that asked for /wait three times before the turn's counters started and stays
#             open and idle through the turn                       (lua/get.lua, idle.mjs)
#   besidemt  the same, to the probe's config `plain-mt`: tokio's multi-threaded runtime with
#             one worker
# Every placement is one run of run-pair-fresh.sh (the stage header checks', with the load's size
# and the idle connection added): every
# turn, the unrecorded pair's included, on a freshly started build pinned to CPU 2, wrk -t2 -c64
# (beside and besidemt: -t1 -c1 on CPU 4)
# for TURN (3) s on CPUs 4 and 5, this script and perf on CPU 7, the order turned every pair,
# jemalloc preloaded, the two builds' answers compared first; one unrecorded pair, then R
# recorded pairs, counting plan.sh's EVENTS at 100%; a wrk error or a counter that is not whole
# fails the placement. The placements run in schedule.mjs's order (results/schedule.txt).
#   verify       before anything: every placement answers as its side's unpadded binary
#                (verify.sh, results/verify/), which also writes each workload's mask; a failure
#                stops the run
#   state        `after` alone: whole turns of its load on each side's unpadded binary with the
#                packets recorded and no counter read (state.sh, results/state/); a turn in which
#                a connection sends fewer than three requests for /wait before its first for
#                /private, or one for /wait after, stops the run
#   park         `beside` and `besidemt` alone: whole turns of the load on each side's unpadded
#                binary beside the idle connection, with every wait for an event the server
#                makes recorded by strace and no counter read (park.sh, results/park/); a turn
#                in which a wait of the base has a timeout, or one of the head has none, stops
#                the run
#   check        each comparison's placement 1, answers and its unrecorded pair only
#                (results/check-only/); a failure stops the run
#   placements   the schedule (results/<comparison>/p<NNN>/), each stopped (and failed) after
#                PLACEMENT_TIMEOUT s; a failed one is reported, left where it failed and the
#                run goes on. No placement is run again: one that failed a check or its time
#                limit, or has other than R pairs, leaves its comparison without a bound
# Every placement's placement.txt names the comparison, its two binaries with their sha256s, the
# kit, this run's id, the plan's sha256 and its place in the schedule, and is finished with an
# "ended" line only when its pairs are all in; report.mjs reads no placement that lacks any of
# them. Then results/report.md and report.json (report.mjs). The plan cannot be changed from the
# environment: PAIRS, WARMUP, TURN, EVENTS, CHECKS, MASK, EXPECT, STATUS, K, R, KIT, PART, SEED,
# RUN_ID and PLACEMENT_TIMEOUT are refused, and a results directory that already holds
# a run is refused. DRYRUN=1 (plan.sh; a test of the scripts, not a measurement): DRY_K
# placements, DRY_R pairs, DRY_TURN s turns, and DRY_FAIL_SEQ (a placement that is given 1 s, to
# test that the time limit stops it and leaves its comparison incomplete). DRY_GATED_BASE=1 with
# it: the gated part's comparisons with the base as both sides, whatever part plan.env names
# (plan.sh; build.sh must have been run the same way).
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
for v in PAIRS WARMUP TURN EVENTS CHECKS MASK EXPECT STATUS K R KIT PART SEED RUN_ID PLACEMENT_TIMEOUT; do
    eval "set_=\${$v+x}"
    [ -z "$set_" ] || finish 1 "refused: $v is set in the environment; the plan (plan.env, plan.md) fixes it"
done
W=${1:-}
case "$W" in plain|wait|close|unstaged|after|beside|besidemt) ;; *) finish 2 "refused: usage: run.sh plain|wait|close|unstaged|after|beside|besidemt" ;; esac
. /m/dl/plan.sh
[ -f $P/plan.md ] || finish 1 "refused: no $P/plan.md: the plan is written before the run"
[ ! -e $P/results/run-id ] || finish 1 "refused: $P/results already holds run $(cat $P/results/run-id): move it away first"
[ -z "$(ls -A $P/results 2>/dev/null)" ] || finish 1 "refused: $P/results is not empty: move it away first"
for s in $SIDES; do
    [ "$(cat $P/src-$(src_of $s).commit 2>/dev/null)" = "$(commit_of $s)" ] || finish 1 "wrong-source: src-$(src_of $s) is commit '$(cat $P/src-$(src_of $s).commit 2>/dev/null)', and commits.env declares $(commit_of $s) for the $s"
done
why=$(kit_check) || finish 1 "refused: $why"
[ "$(cat $P/bin/built-for.txt 2>/dev/null)" = "$BUILT_FOR" ] || finish 1 "missing-binaries: bin/ was built for '$(cat $P/bin/built-for.txt 2>/dev/null)', not '$BUILT_FOR': run build.sh $W"
for b in $SIDES; do [ -x $P/bin/$b ] || finish 1 "missing-binaries: no $P/bin/$b: run build.sh"; done
for n in $PADS_P $PADS_Q; do [ -x $P/bin/base-p$n ] || finish 1 "missing-binaries: no $P/bin/base-p$n: run build.sh"; done
case " $SIDES " in *" head "*) for n in $PADS_P; do [ -x $P/bin/head-p$n ] || finish 1 "missing-binaries: no $P/bin/head-p$n: run build.sh"; done ;; esac
node $P/padlists.mjs --check $P/plan.env || finish 1 "refused: plan.env's pads are not pads.mjs's for each workload's K or miss the rule"
command -v timeout >/dev/null || finish 1 "refused: no timeout command (coreutils) to bound a placement"
RES=$P/results
mkdir -p $RES
[ -f /root/.cargo/env ] && . /root/.cargo/env
RUN_ID=$(cat /proc/sys/kernel/random/uuid)
PLAN_SHA=$(cat $P/plan.env $P/commits.env | sha256sum | cut -d' ' -f1)
echo "$RUN_ID" >$RES/run-id
{ echo "kit $KIT"; echo "run $RUN_ID"; echo "plan $PLAN_SHA"; echo "part $PART"; echo "workload $W"; } >$RES/kit.txt
if [ "$DRY" = 1 ]; then echo "DRY RUN: K=$K, R=$R, TURN=$TURN; fail seq ${DRY_FAIL_SEQ:-none}; not a measurement$([ "$DRY_GATED" = 1 ] && echo "; part gated with the base as both sides")" >$RES/DRYRUN; fi
cp $P/plan.md $P/plan.env $P/commits.env $RES/
say() { echo "$*" | tee -a $RES/progress.log; }
cmd() { echo "$J $P/bin/$1 \$PORT $conf"; }

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
cp $P/bin/sha256.txt $P/bin/placements.txt $P/bin/placements-summary.txt $P/bin/built-for.txt $RES/
mkdir -p $RES/layout && cp $P/bin/layout-*.txt $RES/layout/
for s in $SIDES; do cp $P/capture/$s/args.json $RES/link-$s.json; done
# The record from each side's unpadded link's map, and the map, before anything is measured.
for s in $SIDES; do
    [ -s $P/bin/aligned-$s.txt ] && [ -s $P/bin/map-$s.map.gz ] || finish 1 "missing-map-record: no bin/aligned-$s.txt or bin/map-$s.map.gz: run build.sh $W"
    cp $P/bin/aligned-$s.txt $P/bin/map-$s.map.gz $RES/
done
{ date -u; echo "part: $PART; workload: $W"; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) (runs as $(id -un))"; uname -r;
  RUSTUP_TOOLCHAIN=1.100.0 rustc -vV; perf version 2>/dev/null; wrk -v 2>&1 | head -1; as --version | head -1; cc --version | head -1; curl --version | head -1; node --version;
  echo "base .comment: $(readelf -p .comment $P/bin/base 2>/dev/null | sed -n 's/^ *\[ *[0-9a-f]*\] *//p' | paste -sd';' -)";
  for s in $SIDES; do echo "$s $(cat $P/src-$(src_of $s).commit)"; done;
  dpkg -s libjemalloc2 libzstd1 wrk 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries (sha256, size):"; cat $P/bin/sha256.txt;
  echo "placements (layout against the side's unpadded binary):"; cat $P/bin/placements.txt; cat $P/bin/placements-summary.txt;
  echo "started as: $J <binary> <port> $conf";
  echo "plan: part $PART, workload $W, K=$K placements, R=$R recorded pairs each after 1 unrecorded, TURN=$TURN s, $EVENTS";
  echo "PADS_P: $PADS_P"; echo "PADS_Q: $PADS_Q";
  echo "every turn on a fresh start; server CPU 2, wrk -t$load_t -c$load_c on CPUs $load_cpus, driver and perf CPU 7; idle connection: ${idle:-none}";
  echo "kit $KIT run $RUN_ID plan $PLAN_SHA";
  echo "os: $([ -f /etc/os-release ] && . /etc/os-release && echo "$PRETTY_NAME")"; echo "kernel.randomize_va_space $(cat /proc/sys/kernel/randomize_va_space)";
  echo "schedule seed $SEED; placement timeout $PLACEMENT_TIMEOUT s; no placement is run again";
  [ "$DRY" = 1 ] && echo "DRY RUN: not a measurement"; } >"$RES/host.txt" 2>&1
{ echo "model $(awk -F': *' '/^model name/ { print $2; exit }' /proc/cpuinfo)"
  echo "microcode $(awk -F': *' '/^microcode/ { print $2; exit }' /proc/cpuinfo)"
  echo "kernel $(uname -r)"
  echo "os $([ -f /etc/os-release ] && . /etc/os-release && echo "$PRETTY_NAME")"; } >$RES/host-id.txt
# The kit as it ran: every script and data file, and each tree.
( cd $P && find . -maxdepth 1 -type f ! -name run.out ! -name 'build-*.log' ! -name 'setup*.log' | LC_ALL=C sort | xargs sha256sum
  find lua probe/src probe/Cargo.toml wrap selftest -type f | LC_ALL=C sort | xargs sha256sum
  for s in $SIDES; do t=src-$(src_of $s); echo "$(find $t -type f | LC_ALL=C sort | xargs sha256sum | sed 's/^\([0-9a-f]\{64\}\) [ *]/\1  /' | sha256sum | cut -d' ' -f1)  $t/ for the $s (sha256 of its files' sha256sum lines, sorted)"; done ) >$RES/kit-sha256.txt
node $P/schedule.mjs "$PART" "$W" "$K" "$SEED" >$RES/schedule.txt || finish 1 "refused: schedule.mjs gave no order"

# one <comparison> <i> <out dir> <pairs or 0 for the check> <seq> [<timeout s>]: placement i of a
# comparison, stopped after PLACEMENT_TIMEOUT s (timeout signals run-pair-fresh.sh's whole process
# group, its servers, perf and wrk included, TERM and 30 s later KILL)
one() {
    limit=${6:-$PLACEMENT_TIMEOUT}
    p=$(nth "$2" "$PADS_P"); q=$(nth "$2" "$PADS_Q")
    case $1 in
        pilot-$W|aa-$W) A=base-p$p; B=base-p$q ;;
        change-$W) A=base-p$p; B=head-p$p ;;
        *) echo "no comparison $1" >&2; return 1 ;;
    esac
    mkdir -p "$3"
    { echo "comparison $1 placement $2 workload $W"; echo "A $A $(grep "^$A " $P/bin/sha256.txt | cut -d' ' -f2)"; echo "B $B $(grep "^$B " $P/bin/sha256.txt | cut -d' ' -f2)";
      echo "kit $KIT"; echo "run $RUN_ID"; echo "plan $PLAN_SHA"; echo "seq $5"; echo "started $(date -u +%FT%TZ)"; } >"$3/placement.txt"
    WARMUP=1 TURN=$TURN EVENTS=$EVENTS CHECKS=$P/checks-$W.txt MASK=$P/masks/$W.sed LOAD_T=$load_t LOAD_C=$load_c IDLE=$idle \
        timeout -k 30 "$limit" taskset -c 7 sh $P/run-pair-fresh.sh "$3" "$W" "$4" 2 "$load_cpus" "$path" $P/lua/$lua "$(cmd $A)" "$(cmd $B)"
    rc=$?
    [ $rc = 0 ] || { [ $rc = 124 ] || [ $rc = 137 ] && echo "$1 p$2: stopped after $limit s (timeout, exit $rc)" >&2; return 1; }
    # Every recorded turn left its row: 2 a pair, after the header.
    [ "$(( $(wc -l <"$3/counts-$W.csv") - 1 ))" = $((2 * $4)) ] || { echo "$1 p$2: counts-$W.csv does not hold $((2 * $4)) turns" >&2; return 1; }
    echo "ended $(date -u +%FT%TZ)" >>"$3/placement.txt"
}

say "== $KIT $PART $W run $RUN_ID verify start $(date -u +%T)"
sh $P/verify.sh "$W" $RES/verify >$RES/verify.log 2>&1 || { tail -20 $RES/verify.log; say "VERIFY-FAILED"; finish 1 "verify-failed: a binary does not answer as its reference (results/verify.log)"; }
tail -1 $RES/verify.log | tee -a $RES/progress.log
mkdir -p $RES/masks && cp $P/masks/*.sed $RES/masks/
if [ "$W" = after ]; then
    say "== state start $(date -u +%T)"
    sh $P/state.sh $RES/state >$RES/state.log 2>&1 || { tail -20 $RES/state.log; say "STATE-FAILED"; finish 1 "state-failed: the load did not reach or keep the state the workload is declared for (results/state.log)"; }
    tail -1 $RES/state.log | tee -a $RES/progress.log
fi
if [ -n "$idle" ]; then
    say "== park start $(date -u +%T)"
    sh $P/park.sh "$W" $RES/park >$RES/park.log 2>&1 || { tail -20 $RES/park.log; say "PARK-FAILED"; finish 1 "park-failed: the server's waits did not show the state the workload is declared for (results/park.log)"; }
    tail -1 $RES/park.log | tee -a $RES/progress.log
fi
say "== check start $(date -u +%T)"
for c in $CMPS; do
    one $c 1 $RES/check-only/$c 0 0 >>$RES/check-only.log 2>&1 || { tail -20 $RES/check-only.log; say "CHECK-FAILED: $c"; finish 1 "check-failed: $c's placement 1 check (results/check-only.log)"; }
    say "$c: $(cat $RES/check-only/$c/answers-$W/verdict.txt)"
done
say "== checks ok $(date -u +%T); $(wc -l <$RES/schedule.txt) placements to run"
FAILED=
while read -r seq c i; do
    d=$RES/$c/p$(printf %03d $i)
    lim=$PLACEMENT_TIMEOUT; [ "$DRY" = 1 ] && [ "$seq" = "${DRY_FAIL_SEQ:-}" ] && lim=1
    if one $c $i $d $R $seq $lim >>$RES/run.log 2>&1 </dev/null; then say "$seq $c p$(printf %03d $i) ok $(date -u +%T)"; else say "$seq $c p$(printf %03d $i) FAILED $(date -u +%T)"; tail -15 $RES/run.log; FAILED="$FAILED $seq:$c:$i"; fi
done <$RES/schedule.txt
# No placement is run again. One that failed stays where it failed, its placement.txt without an
# "ended" line, and its comparison has no bound.
say "failed (seq:comparison:placement), none run again, no bound for their comparison:${FAILED:- none}"
rm -f $RES/report.json
node $P/report.mjs $RES >$RES/report.md 2>$RES/report.err
rc=$?
jx=$(node -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(j.exit ?? "none"); } catch { console.log("none"); }' $RES/report.json)
case "$rc:$jx" in
    0:0) out="complete: every comparison complete; results/report.md" ;;
    1:1) out="incomplete: one or more comparisons without all their placements; results/report.md" ;;
    2:2) out="report-refused: report.mjs refused the results (results/report.md lists why)" ;;
    *) out="report-crashed: report.mjs exit $rc, report.json exit $jx: $(head -c 300 $RES/report.err | tr '\n' ' ')" ;;
esac
say "report: $RES/report.md, report.mjs exit $rc (0 every comparison complete, 1 one or more incomplete, 2 refused, other: crashed)"
[ "${out%%:*}" = complete ] && finish 0 "$out"
finish 1 "$out"
