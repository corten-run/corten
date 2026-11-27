#!/bin/sh
# run.sh <work dir>: turns the part in <work dir>/plan/ (plan.mjs) on the binaries build.sh made,
# with nothing else run or logged into on the host meanwhile. Start it detached, so a dropped
# session does not stop it:
#   nohup sh run.sh <work dir> ><work dir>/run.out 2>&1 &
# and collect <work dir>/results when run.out ends with ALL-DONE. Every way run.sh ends writes one
# line "RUN-ENDED <outcome>: <what>" and then ALL-DONE. Outcomes: complete, incomplete,
# report-refused, report-crashed (the schedule was run; report.mjs's exit 0, 1, 2 or anything
# else), and refused, perf-preflight-failed, verify-failed, killed, unexpected-exit (nothing or
# not all was turned).
#
# Comparisons (A is the CSV's base rows, B its head rows), placement i = 1..K of workload <w>:
#   pilot-<w>    (part pilot) base-p<p_i> against base-p<q_i>: an A/A read only for the spread of
#                its placement medians
#   aa-<w>       (part gated) base-p<p_i> against base-p<q_i>: the change's base against itself
#   change-<w>   (part gated) base-p<p_i> against head-p<p_i>: the change, each side moved by the
#                same pad
# In order:
#   host         the plan's CPU model, when it names one, the CPU model of the A/A the K was
#                checked from, when it was, and the plan's CPUs; then the plan's counters counted
#                for a process attached to as a turn's server is, each above zero and at 100%
#   record       what build.sh checked is copied into the results before any turn: the binaries'
#                SHA-256s, each placement's layout check, each side's unpadded map and its record
#                of sections aligned beyond 16 bytes, the second pads' lines when there are any,
#                the probe's source as built with the request script and the expected answer
#                (checked again against plan/inputs.sha256), and each build's environment;
#                for a workload the plan shuffles, each side's list of its functions
#                (functions-<side>.txt.gz), from which report.mjs draws every ordering file again;
#                host.txt names cargo's config files outside the probe, which nothing checks
#   verify       every placement answers as its side's unpadded binary (verify.sh); a failure
#                stops the run
#   placements   in the plan's seeded order (results/schedule.txt), each one run of turns.sh under
#                the plan's time limit: the two binaries' answers compared, one unrecorded pair,
#                then R recorded pairs, every turn on a freshly started binary on the server's
#                CPU, wrk on the load's CPUs, turns.sh and perf on the driver's. A placement that
#                fails (answers, a turn with a failed request, a counter under 100%, the time
#                limit) is reported and the run goes on; nothing is run again, so its comparison
#                has no bound
#   report       results/report.md and report.json (report.mjs)
# Every placement's placement.txt names the comparison, its two binaries with their SHA-256s, the
# run's id, the plan's SHA-256 and its place in the schedule, and gets its "ended" line only when
# all its pairs are in; report.mjs reads no placement that lacks any of them. A results directory
# that already holds anything is refused: a part is run once (CONTRIBUTING.md#pull-requests: "no
# placement is rerun, replaced or dropped for its result"). run.sh cannot see another work
# directory or host, so that a plan's part has not been run elsewhere is the author's to keep.
set -u
RES=
finish() { # <exit code> <outcome: what>
    trap - EXIT INT TERM
    if [ -n "$RES" ] && [ -d "$RES" ]; then { echo "RUN-ENDED $2"; echo ALL-DONE; } >>"$RES/progress.log"; fi
    echo "RUN-ENDED $2"; echo ALL-DONE
    exit "$1"
}
trap 'st=$?; finish $st "unexpected-exit: run.sh stopped with status $st before its end (see the lines above)"' EXIT
trap 'finish 130 "killed: run.sh got INT"' INT
trap 'finish 143 "killed: run.sh got TERM"' TERM
[ $# -eq 1 ] && [ -f "$1/plan/resolved.sh" ] || finish 2 "refused: usage: run.sh <work dir>   (after plan.mjs and build.sh)"
# Only the plan says whether the placements shuffle: a SHUFFLE the caller's environment holds is not read.
SHUFFLE=0
. "$1/plan/resolved.sh"
B=$WORK/bin; PL=$WORK/plan
[ -z "$(ls -A "$WORK/results" 2>/dev/null)" ] || finish 1 "refused: $WORK/results already holds a run's results, and a part is run once: no placement is rerun, replaced or dropped for its result. Keep them; only results whose progress.log has no 'turns start' line turned nothing"
[ "$(cat "$B/built-for.txt" 2>/dev/null)" = "plan $PLAN_SHA inputs $INPUTS_SHA part $PART workload $W K $K dry $DRY" ] || finish 1 "refused: bin/ was built for '$(cat "$B/built-for.txt" 2>/dev/null)', not this plan's part $PART, workload $W, K $K and inputs: run build.sh"
[ "$(sha256sum "$PL/plan.json" | cut -d' ' -f1)" = "$PLAN_SHA" ] || finish 1 "refused: plan/plan.json is not the plan plan.mjs resolved"
[ "$(sha256sum "$PL/inputs.sha256" | cut -d' ' -f1)" = "$INPUTS_SHA" ] || finish 1 "refused: plan/inputs.sha256 is not the list plan.mjs wrote"
command -v timeout >/dev/null || finish 1 "refused: no timeout command (coreutils) to bound a placement"
model=$(awk -F': *' '/^model name/ { print $2; exit }' /proc/cpuinfo)
[ -z "$CPU_MODEL" ] || case "$model" in *"$CPU_MODEL"*) ;; *) finish 1 "refused: this host's CPU is '$model', not the plan's '$CPU_MODEL'" ;; esac
[ -z "$SIZED_MODEL" ] || [ "$model" = "$SIZED_MODEL" ] || finish 1 "refused: this host's CPU is '$model', and K was checked from an A/A read on '$SIZED_MODEL': an A/A sizes a run on its own setup"
for c in $CPU_SERVER $(echo "$CPU_LOAD" | tr ',' ' ') $CPU_DRIVER; do taskset -c "$c" true 2>/dev/null || finish 1 "refused: no CPU $c to pin to"; done
RES=$WORK/results
mkdir -p "$RES"
# The plan's SHUFFLE stands whatever the cargo env file sets: it is put back, and not exported, after it.
[ ! -f "$HOME/.cargo/env" ] || { plan_shuffle=$SHUFFLE; . "$HOME/.cargo/env"; unset SHUFFLE; SHUFFLE=$plan_shuffle; }
RUN_ID=$(cat /proc/sys/kernel/random/uuid)
echo "$RUN_ID" >"$RES/run-id"
[ "$DRY" = 0 ] || echo "DRY RUN: K=$K, R=$R, $TURN s turns; a test of the scripts, read for nothing" >"$RES/DRYRUN"
cp -R "$PL" "$RES/plan"
say() { echo "$*" | tee -a "$RES/progress.log"; }

# The counters, counted for a process that is attached to as a turn's server is, all at 100%.
pf=$RES/preflight; mkdir -p "$pf"
ok=1
taskset -c "$CPU_SERVER" sh -c 'i=0; while [ $i -lt 3000000 ]; do i=$((i + 1)); done' &
busy=$!
perf stat -x, -e "$EVENTS" -p $busy -o "$pf/counts.perf" -- sleep 1 >/dev/null 2>&1 || ok=0
kill $busy 2>/dev/null; wait $busy 2>/dev/null
for e in $(echo "$EVENTS" | tr ',' ' '); do
    awk -F, -v e="$e" 'BEGIN { n = e; sub(/:u$/, "", n) } ($3 == e || $3 == n) && $1 ~ /^[0-9]+$/ && $1 + 0 > 0 && $5 + 0 >= 100 { ok++ } END { exit ok != 1 }' "$pf/counts.perf" 2>/dev/null || ok=0
done
[ $ok = 1 ] || { cat "$pf/counts.perf" 2>/dev/null; finish 1 "perf-preflight-failed: perf cannot count $EVENTS, each above zero and at 100%, here (results/preflight/counts.perf)"; }

# What build.sh checked, in the results before any turn, so a report has it whatever happens later.
cp "$B/sha256.txt" "$B/built-for.txt" "$RES/"
mkdir -p "$RES/layout" "$RES/maps" && cp "$B"/layout/*.txt "$RES/layout/"
for s in $SIDES; do
    cp "$B/record-$s.json" "$RES/"; cp "$WORK/maps/$s.map.gz" "$RES/maps/"; cp "$WORK/capture/$s/args.json" "$RES/link-$s.json"; cp "$WORK/build-$s.env" "$RES/"
done
[ ! -f "$B/second-pads.txt" ] || cp "$B/second-pads.txt" "$RES/"
[ ! -f "$WORK/maps/placements.sha256" ] || cp "$WORK/maps/placements.sha256" "$RES/maps/"
[ "$SHUFFLE" = 0 ] || for s in $SIDES; do { [ -s "$B/functions-$s.txt" ] && gzip -9 -n -c "$B/functions-$s.txt" >"$RES/functions-$s.txt.gz"; } || finish 1 "refused: a shuffled run's list of $s's functions, bin/functions-$s.txt, from which report.mjs draws every ordering file again, could not be kept in the results"; done
# The probe's source as build.sh built it, beside the request script and the expected answer in
# plan/: the files the plan names by path, still what plan.mjs listed.
sed -n 's/^[0-9a-f]*  \(probe\/.*\)$/\1/p' "$PL/inputs.sha256" | while IFS= read -r f; do mkdir -p "$RES/$(dirname "$f")"; cp "$WORK/$f" "$RES/$f"; done
(cd "$RES" && sha256sum --quiet -c plan/inputs.sha256) >"$RES/inputs-check.txt" 2>&1 || { cat "$RES/inputs-check.txt"; finish 1 "refused: the probe as built, the request script or the expected answer is not what plan.mjs resolved (plan/inputs.sha256)"; }
cargo_configs() { # the files cargo reads from the directories above the probe's copy and from its home
    d=$WORK
    while :; do
        for f in "$d/.cargo/config.toml" "$d/.cargo/config"; do [ ! -e "$f" ] || echo "$f"; done
        [ "$d" != / ] || break
        d=$(dirname "$d")
    done
    for f in "${CARGO_HOME:-$HOME/.cargo}/config.toml" "${CARGO_HOME:-$HOME/.cargo}/config"; do [ ! -e "$f" ] || echo "$f"; done
}
{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) randomize_va_space $(cat /proc/sys/kernel/randomize_va_space) (runs as $(id -un))"
  echo "os: $([ -f /etc/os-release ] && . /etc/os-release && echo "$PRETTY_NAME"); kernel $(uname -r)"
  RUSTUP_TOOLCHAIN="$TOOLCHAIN" rustc -vV; perf version 2>/dev/null; wrk -v 2>&1 | head -1; as --version | head -1; cc --version | head -1; curl --version | head -1; node --version
  echo "base .comment: $(readelf -p .comment "$B/base" 2>/dev/null | sed -n 's/^ *\[ *[0-9a-f]*\] *//p' | paste -sd';' -)"
  echo "base $BASE"; case " $SIDES " in *" head "*) echo "head $HEAD" ;; esac
  echo "started as: $START"
  echo "every server's environment is PATH=$PATH, HOME=$HOME, PORT and BIN alone (env -i), with what that command sets (verify/server-env.txt); each build's is build-<side>.env"
  echo "cargo's config files outside the probe, as they are now (cargo reads them in a build; the kit neither lists nor checks them): $(cargo_configs | paste -sd' ' - | sed 's/^$/none/')"
  echo "plan $PLAN_SHA, inputs $INPUTS_SHA: part $PART, workload $W, K=$K placements, R=$R recorded pairs each after 1 unrecorded, $TURN s turns, wrk -t$WRK_T -c$WRK_C, $EVENTS"
  echo "every turn on a fresh start; server CPU $CPU_SERVER, wrk CPUs $CPU_LOAD, driver and perf CPU $CPU_DRIVER; a placement's time limit $PLACEMENT_SECONDS s"
  echo "run $RUN_ID"
  [ "$DRY" = 0 ] || echo "DRY RUN: read for nothing"; } >"$RES/host.txt" 2>&1
{ echo "model $model"
  echo "microcode $(awk -F': *' '/^microcode/ { print $2; exit }' /proc/cpuinfo)"
  echo "kernel $(uname -r)"
  echo "os $([ -f /etc/os-release ] && . /etc/os-release && echo "$PRETTY_NAME")"; } >"$RES/host-id.txt"
( cd "$KIT" && find . -type f | LC_ALL=C sort | xargs sha256sum ) >"$RES/kit-sha256.txt"
cp "$PL/schedule.txt" "$RES/schedule.txt"
export KIT START REQ_PATH STATUS EVENTS CPU_SERVER CPU_LOAD WRK_T WRK_C TURN EXPECT PORT_A PORT_B
export HEADERS="$PL/headers.txt" SCRIPT="$PL/request.lua" MASK="$PL/mask.sed" MASK_JSON="$PL/mask.json" WARMUP=1
nth() { echo "$2" | cut -d' ' -f"$1"; }

# one <comparison> <i> <out dir> <seq>: placement i of a comparison, stopped after the plan's
# time limit (timeout signals turns.sh's whole process group, its servers, perf and wrk included,
# TERM and 30 s later KILL)
one() {
    p=$(nth "$2" "$PADS_P"); q=$(nth "$2" "$PADS_Q")
    case $1 in
        pilot-$W|aa-$W) A=base-p$p; Bn=base-p$q; expect= ;;
        change-$W) A=base-p$p; Bn=head-p$p; expect=$EXPECT ;;
        *) echo "no comparison $1" >&2; return 1 ;;
    esac
    mkdir -p "$3"
    { echo "comparison $1 placement $2 workload $W"; echo "A $A $(grep "^$A " "$B/sha256.txt" | cut -d' ' -f2)"; echo "B $Bn $(grep "^$Bn " "$B/sha256.txt" | cut -d' ' -f2)"
      echo "run $RUN_ID"; echo "plan $PLAN_SHA"; echo "seq $4"; echo "started $(date -u +%FT%TZ)"; } >"$3/placement.txt"
    EXPECT=$expect timeout -k 30 "$PLACEMENT_SECONDS" taskset -c "$CPU_DRIVER" sh "$KIT/turns.sh" "$3" "$W" "$R" "$B/$A" "$B/$Bn"
    rc=$?
    [ $rc = 0 ] || { [ $rc = 124 ] || [ $rc = 137 ] && echo "$1 p$2: stopped after $PLACEMENT_SECONDS s (timeout, exit $rc)" >&2; return 1; }
    # Every recorded turn left its row: 2 a pair, after the header.
    [ "$(( $(wc -l <"$3/counts-$W.csv") - 1 ))" = $((2 * R)) ] || { echo "$1 p$2: counts-$W.csv does not hold $((2 * R)) turns" >&2; return 1; }
    echo "ended $(date -u +%FT%TZ)" >>"$3/placement.txt"
}

say "== run $RUN_ID: $PART $W, plan $PLAN_SHA; verify start $(date -u +%T)"
sh "$KIT/verify.sh" "$WORK" "$RES/verify" >"$RES/verify.log" 2>&1 || { tail -20 "$RES/verify.log"; finish 1 "verify-failed: a placement does not answer as its unpadded binary, or the plan's mask does not hold (results/verify.log)"; }
tail -1 "$RES/verify.log" | tee -a "$RES/progress.log"
say "== turns start $(date -u +%T); $(( $(wc -l <"$RES/schedule.txt") )) placements to run"
FAILED=
while read -r seq c i; do
    name=p$(printf %03d "$i")
    if one "$c" "$i" "$RES/$c/$name" "$seq" >>"$RES/run.log" 2>&1 </dev/null; then say "$seq $c $name ok $(date -u +%T)"; else say "$seq $c $name FAILED $(date -u +%T)"; tail -15 "$RES/run.log"; FAILED="$FAILED $c:$name"; fi
done <"$RES/schedule.txt"
say "failed (their comparison has no bound; nothing is run again):${FAILED:- none}"
rm -f "$RES/report.json"
node "$KIT/report.mjs" "$RES" >"$RES/report.md" 2>"$RES/report.err"
rc=$?
case $rc in
    0) out="complete: every comparison complete; results/report.md" ;;
    1) out="incomplete: a comparison without all its placements has no bound; results/report.md" ;;
    2) out="report-refused: report.mjs refused the results (results/report.md lists why)" ;;
    *) out="report-crashed: report.mjs exit $rc: $(head -c 300 "$RES/report.err" | tr '\n' ' ')" ;;
esac
[ $rc = 0 ] && finish 0 "$out"
finish 1 "$out"
