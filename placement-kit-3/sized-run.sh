#!/bin/sh
# sized-run.sh <kit> <work root>: the third run of bench/placement kept under this tag, every step
# of it. A TEST OF THE KIT, NOT A READING: a gated part built and turned at a K that plan.mjs sized
# from an A/A, which no run of the kit had done and no dry run can reach. <kit> is bench/placement
# in a checkout that has the one commit every plan here names; <work root> must not exist. Each
# step's output goes to <work root>/<step>.out and its exit status is printed; what is kept is
# gathered under <work root>/keep. Every plan builds one commit of main against itself with the
# kit's example probe, and no other code.
#   (s)  DRYRUN=1, the kit's example plan: its gated part through plan.mjs and build.sh (6
#        placements a comparison; run.sh is not run on it), then every case of the selftest on
#        that work directory. Anything but SELFTEST-OK stops the run here.
#   (g)  NOT a dry run and NOT a reading. sizing/plan.json is written again by the lines that
#        wrote it in the second dry run (dry-run.sh under the tag evidence/placement-kit-2), and
#        must be that file byte for byte: a pilot K is taken only from an A/A read under the same
#        plan file. t-pilot/results beside this script is that run's 30-placement test A/A as the
#        tag keeps it (results/t-pilot/results there), checked here against the tag's list of
#        hashes, and kept-plan/ the gated part as that run resolved it and never built
#        (results/t-gated/plan there). The gated part is resolved again with --sized-from the
#        A/A's results (plan.mjs tries each K from 5 and takes the first that passes), compared
#        with kept-plan/, and then built by build.sh and turned by run.sh at that K; report.mjs
#        again on its results must print the same page. Were the kept A/A refused, the A/A would
#        be run again here and the K taken from that one; the output says which of the two
#        happened.
set -u
[ $# -eq 2 ] || { sed -n '2,23p' "$0"; exit 2; }
KIT=$1; W=$2; D=$(cd "$(dirname "$0")" && pwd)
[ ! -e "$W" ] || { echo "sized-run: $W exists" >&2; exit 1; }
mkdir -p "$W"
step() { # <name> <command...>
    n=$1; shift
    "$@" >"$W/$n.out" 2>&1; rc=$?
    echo "$(date -u +%T) $n: exit $rc: $(tail -n 1 "$W/$n.out" | cut -c1-240)"
    return $rc
}
part() { # <name> <plan file> <part> <workload> [<plan.mjs arguments>]: plan.mjs, build.sh, run.sh
    pn=$1; pf=$2; pp=$3; pw=$4; shift 4
    step "$pn.plan" node "$KIT/plan.mjs" "$pf" "$pp" "$pw" "$W/$pn" "$@" && step "$pn.build" sh "$KIT/build.sh" "$W/$pn" && step "$pn.run" sh "$KIT/run.sh" "$W/$pn"
}
variant() { # <name> <plan to copy> <node expression changing the plan p>: a copy of a plan and of the example probe
    mkdir -p "$D/$1"; rm -rf "$D/$1/probe"; cp -R "$KIT/example/probe" "$D/$1/probe"
    node -e 'const fs = require("fs"), p = JSON.parse(fs.readFileSync(process.argv[1], "utf8")), here = process.argv[4]; eval(process.argv[3]); fs.writeFileSync(process.argv[2], JSON.stringify(p, null, 2) + "\n");' "$2" "$D/$1/plan.json" "$3" "$D/$1"
}
keep() { # what is kept, gathered whether the run went to its end or stopped
    K=$W/keep; mkdir -p "$K/plans/sizing"
    cp "$W"/*.out "$K/"
    [ ! -f "$D/sizing/plan.json" ] || cp "$D/sizing/plan.json" "$K/plans/sizing/"
    for n in d-gated t-gated t-pilot; do
        [ -d "$W/$n" ] || continue
        mkdir -p "$K/$n"
        [ ! -d "$W/$n/results" ] || cp -R "$W/$n/results" "$K/$n/results"
        [ -d "$W/$n/results" ] || [ ! -d "$W/$n/plan" ] || cp -R "$W/$n/plan" "$K/$n/plan"
        [ ! -d "$W/$n/selftest" ] || cp -R "$W/$n/selftest" "$K/$n/selftest"
        for f in "$W/$n"/build-*.log "$W/$n"/build-*.env "$W/$n/bin/sha256.txt"; do [ ! -f "$f" ] || cp "$f" "$K/$n/"; done
    done
    ( cd "$KIT" && find . -type f | LC_ALL=C sort | xargs sha256sum ) >"$K/kit-sha256.txt"
    find "$K" -type l -delete
    find "$K" \( -name '*.o' -o -name 'perf' \) -type f -delete
}

echo "== (s) a dry gated part resolved and built, and on it the selftest, every case"
export DRYRUN=1
step d-gated.plan node "$KIT/plan.mjs" "$KIT/example/plan.json" gated plain "$W/d-gated" && step d-gated.build sh "$KIT/build.sh" "$W/d-gated" && step d-gated.selftest sh "$KIT/selftest/selftest.sh" "$W/d-gated"
unset DRYRUN
[ "$(tail -n 1 "$W/d-gated.selftest.out" 2>/dev/null)" = SELFTEST-OK ] || { echo "the selftest did not end SELFTEST-OK: nothing more is run"; keep; echo SIZED-RUN-STOPPED; exit 1; }
grep -E '^(answers|failed|limit|map|inputs|refusals|zero): ' "$W/d-gated.selftest.out" | cut -c1-600
echo "run.sh was not run on d-gated: $(ls -d "$W/d-gated/results" 2>/dev/null | wc -l) results directories under it"

echo "== (g) not a dry run and not a reading: a gated part at a K sized from an A/A, built and turned"
variant sizing "$KIT/example/plan.json" 'p.name = "placement-kit-sizing-test"; p.R = 4; p.load.seconds = 2; p.pilot = { K: 30, why: "a test of the kit and not a pilot of anything: the fewest placements the kit takes for a pilot, so that its sizing code runs on a host" }; p.workloads[0].declared = "A TEST OF THE KIT, NOT A READING. GET /private to the example probe, main against itself: a pilot-shaped A/A run only so that pilot.mjs and plan.mjs --sized-from run on a host on real counts. No figure it gives is a measurement of anything, and no K it gives is a K of any plan.";'
PILOT=$D/t-pilot/results
was=$( . "$PILOT/plan/resolved.sh"; echo "$PLAN_SHA $INPUTS_SHA" )
now=$(sha256sum "$D/sizing/plan.json" | cut -d' ' -f1)
echo "sizing/plan.json as written here: sha256 $now; the kept A/A was read under: ${was% *} (inputs ${was#* })"
[ "$now" = "${was% *}" ] && echo "the plan file is the one the kept A/A was read under, byte for byte" || echo "the plan file is NOT the one the kept A/A was read under"
( cd "$D/t-pilot" && sha256sum --quiet -c ../t-pilot.sha256 ) >"$W/t-pilot.kept-check.out" 2>&1 \
    && echo "the kept A/A's results: $(wc -l <"$D/t-pilot.sha256") files, each with the bytes the tag evidence/placement-kit-2 lists for it" \
    || echo "the kept A/A's results are NOT what the tag evidence/placement-kit-2 lists ($(wc -l <"$W/t-pilot.kept-check.out") lines in t-pilot.kept-check.out)"
if step t-gated.plan node "$KIT/plan.mjs" "$D/sizing/plan.json" gated plain "$W/t-gated" --sized-from "$PILOT"; then
    echo "the K is sized from the kept A/A: no A/A was run here"
else
    echo "plan.mjs refused the kept A/A (t-gated.plan.out is kept as t-gated.plan.refused.out): the A/A is run again here, and the K taken from it"
    mv "$W/t-gated.plan.out" "$W/t-gated.plan.refused.out"; rm -rf "$W/t-gated"
    part t-pilot "$D/sizing/plan.json" pilot plain || { echo "the A/A run again did not end complete: nothing more is run"; keep; echo SIZED-RUN-STOPPED; exit 1; }
    PILOT=$W/t-pilot/results
    step t-pilot.at30 node "$KIT/pilot.mjs" "$PILOT" 30
    step t-gated.plan node "$KIT/plan.mjs" "$D/sizing/plan.json" gated plain "$W/t-gated" --sized-from "$PILOT" || { echo "no K from the A/A run again: nothing more is run"; keep; echo SIZED-RUN-STOPPED; exit 1; }
fi
( . "$W/t-gated/plan/resolved.sh"; model=$(awk -F': *' '/^model name/ { print $2; exit }' /proc/cpuinfo)
  echo "t-gated as resolved: part $PART, workload $W, K = $K, R = $R, turns of $TURN s, dry $DRY; in the second dry run the same plan resolved to K = $( . "$D/kept-plan/resolved.sh"; echo "$K" )"
  if [ -n "$SIZED_MODEL" ] && [ "$model" = "$SIZED_MODEL" ]; then echo "SIZED_MODEL is this host's model name as run.sh reads it, byte for byte: $SIZED_MODEL"; else echo "SIZED_MODEL '$SIZED_MODEL' is NOT this host's '$model'"; fi )
d=$(diff -rq "$D/kept-plan" "$W/t-gated/plan" 2>&1)
[ -z "$d" ] && echo "t-gated/plan is the plan the second dry run resolved and did not build, every file byte for byte ($(ls "$W/t-gated/plan" | wc -l) files)" || { echo "t-gated/plan differs from the plan the second dry run resolved:"; echo "$d" | cut -c1-300; }
step t-gated.build sh "$KIT/build.sh" "$W/t-gated" && step t-gated.run sh "$KIT/run.sh" "$W/t-gated"
echo "t-gated: build.sh and run.sh ended; run.sh's last status line: $(grep '^RUN-ENDED' "$W/t-gated.run.out" 2>/dev/null | tail -n 1 | cut -c1-240)"
R=$W/t-gated/results
if [ -f "$R/report.md" ]; then
    step t-gated.report node "$KIT/report.mjs" "$R"
    cmp -s "$W/t-gated.report.out" "$R/report.md" && echo "report.mjs again on the gated results: the same page, byte for byte ($(wc -c <"$R/report.md") bytes)" || echo "report.mjs again on the gated results: NOT the same page"
else echo "t-gated has no results/report.md"; fi

echo "== what t-gated's results hold"
echo "binaries linked and listed (bin/sha256.txt): $(wc -l <"$W/t-gated/bin/sha256.txt" 2>/dev/null)"
echo "verify.log: $(tail -n 1 "$R/verify.log" 2>/dev/null | cut -c1-200)"
echo "placements with a row of counts: aa-plain $(ls "$R"/aa-plain/p*/counts-*.csv 2>/dev/null | wc -l), change-plain $(ls "$R"/change-plain/p*/counts-*.csv 2>/dev/null | wc -l); progress.log: $(grep -c ' ok ' "$R/progress.log" 2>/dev/null) placements ok, $(grep -cE '^[0-9]+ [a-z-]+ p[0-9]+ ' "$R/progress.log" 2>/dev/null) lines of placements; $(grep '^failed' "$R/progress.log" 2>/dev/null | cut -c1-200)"
echo "the servers' environment (verify/server-env.txt), names alone: $(cut -d= -f1 "$R/verify/server-env.txt" 2>/dev/null | paste -sd' ' -)"
echo "the allocator each started server reported, over every turn's server log: $(cat "$R"/*-plain/p*/serve-?.log 2>/dev/null | grep '^ALLOCATOR' | sort | uniq -c | paste -sd';' -)"
echo "turns recorded: $(cat "$R"/*-plain/p*/raw-*.log 2>/dev/null | grep -c '^## pair') in the turn logs, $(for f in "$R"/*-plain/p*/counts-*.csv; do tail -n +2 "$f"; done 2>/dev/null | wc -l) rows of counts, $(for f in "$R"/*-plain/p*/counts-*.csv; do tail -n +2 "$f"; done 2>/dev/null | awk -F, '{ for (i = 3; i <= NF; i++) if (!($i + 0 > 0)) n++ } END { print n + 0 }') of their values not above zero"
echo "the probe as built, kept in the results: $(find "$R/probe" -type f 2>/dev/null | wc -l) files; sha256sum -c plan/inputs.sha256 there: $(cd "$R" 2>/dev/null && sha256sum --quiet -c plan/inputs.sha256 >/dev/null 2>&1 && echo passes || echo FAILS); inputs-check.txt: $(wc -c <"$R/inputs-check.txt" 2>/dev/null) bytes"
echo "each build's environment in the results: $(ls "$R" 2>/dev/null | grep '^build-.*\.env$' | paste -sd' ' -); cargo's config files outside the probe (host.txt): $(grep "cargo's config files" "$R/host.txt" 2>/dev/null | sed 's/.*: //')"
echo "the report's first lines that say what the run is:"; grep -n -m 3 -E 'A TEST OF THE KIT|sized|K = ' "$R/report.md" 2>/dev/null | cut -c1-400
keep
echo SIZED-RUN-DONE
