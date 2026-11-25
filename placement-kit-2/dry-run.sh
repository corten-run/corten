#!/bin/sh
# dry-run.sh <kit> <work root>: the second dry run of bench/placement kept under this tag, every
# step of it. A test of the scripts on one host, read for nothing. <kit> is bench/placement in a
# checkout that has the one commit every plan here names; <work root> must not exist. Each step's
# output goes to <work root>/<step>.out and its exit status is printed; what is kept is gathered
# under <work root>/keep. Every plan builds one commit of main against itself with the kit's
# example probe, and no other code.
#   (a)  the kit's example plan, DRYRUN=1 (6 placements, 2 recorded pairs, 1 s turns): the pilot
#        part through plan.mjs, build.sh and run.sh; pilot.mjs on its results, which must say that
#        a dry run sizes nothing; the gated part resolved with --sized-from those results (a dry
#        run takes its K from DRY_K and ignores them), then build.sh and run.sh; report.mjs again
#        on the gated results, which must print the same page.
#   (c)  on (a)'s gated work directory, every case of the selftest.
#   ranged   DRYRUN=1, a copy of the example plan that masks `age` with the range 0 to 7 and
#        starts the probe behind ranged/front.mjs, a stand-in that adds that header with a value
#        that differs from start to start: plan.mjs, build.sh and verify.sh alone. Nothing is
#        turned.
#   alike    DRYRUN=1, a copy of the example plan that masks `content-length` with a range, a
#        header two starts of the probe send alike: run.sh must end verify-failed before any turn.
#   undeclared  a copy of the example plan without full commits: plan.mjs must refuse it.
#   (t)  NOT a dry run and NOT a reading: sizing/plan.json, a pilot-shaped A/A of 30 placements,
#        4 recorded pairs and 2 s turns, run only so that the sizing code runs on a host on real
#        counts. Its pilot part through plan.mjs, build.sh and run.sh; pilot.mjs at K = 30; then
#        the gated part resolved with --sized-from its results, which scans K from 5 to 254 and
#        prints the K and the pad lists, or refuses when no K passes. Then number/plan.json, the
#        same plan with K given as a number (the K the scan gave, or 254 when it gave none),
#        resolved with --sized-from the same results. Neither gated part is built or run.
set -u
[ $# -eq 2 ] || { sed -n '2,27p' "$0"; exit 2; }
KIT=$1; W=$2; D=$(cd "$(dirname "$0")" && pwd)
[ ! -e "$W" ] || { echo "dry-run: $W exists" >&2; exit 1; }
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

export DRYRUN=1
echo "== (a) main against itself, a dry run: the pilot part, pilot.mjs, the gated part with --sized-from, report.mjs again"
part a-pilot "$KIT/example/plan.json" pilot plain
step a-pilot.sizes node "$KIT/pilot.mjs" "$W/a-pilot/results"
part a-gated "$KIT/example/plan.json" gated plain --sized-from "$W/a-pilot/results"
step a-gated.report node "$KIT/report.mjs" "$W/a-gated/results"
cmp -s "$W/a-gated.report.out" "$W/a-gated/results/report.md" && echo "report.mjs again on the gated results: the same page, byte for byte" || echo "report.mjs again on the gated results: NOT the same page"
echo "== (c) the selftest, every case"
step a-gated.selftest sh "$KIT/selftest/selftest.sh" "$W/a-gated"
echo "== ranged: a masked header with a range that differs between two starts, through verify.sh; nothing turned"
rm -f "$D/ranged/starts.count"
variant ranged "$KIT/example/plan.json" 'p.name = "placement-kit-dry-ranged"; p.workloads[0].start = "node " + here + "/front.mjs $BIN $PORT"; p.workloads[0].mask = [{ header: "age", range: [0, 7] }]; p.workloads[0].declared = "A test of the kit, read for nothing: GET /private to the example probe behind a stand-in that adds an age header whose value differs from start to start, so that verify.sh meets a masked header with a range.";'
step ranged.plan node "$KIT/plan.mjs" "$D/ranged/plan.json" pilot plain "$W/ranged" && step ranged.build sh "$KIT/build.sh" "$W/ranged" && step ranged.verify sh "$KIT/verify.sh" "$W/ranged" "$W/ranged/verify"
echo "== alike: a masked header with a range that two starts send alike (run.sh must end verify-failed, exit 1)"
variant alike "$KIT/example/plan.json" 'p.name = "placement-kit-dry-alike"; p.workloads[0].mask = [{ header: "content-length", range: [6000, 7000] }];'
part alike "$D/alike/plan.json" pilot plain
echo "== undeclared: a plan that does not name full commits (plan.mjs must exit 1)"
variant undeclared "$KIT/example/plan.json" 'p.name = "placement-kit-dry-undeclared"; p.base = p.base.slice(0, 12); delete p.head;'
step undeclared.plan node "$KIT/plan.mjs" "$D/undeclared/plan.json"

unset DRYRUN
echo "== (t) not a dry run and not a reading: a pilot-shaped A/A, so that the sizing code runs on real counts"
variant sizing "$KIT/example/plan.json" 'p.name = "placement-kit-sizing-test"; p.R = 4; p.load.seconds = 2; p.pilot = { K: 30, why: "a test of the kit and not a pilot of anything: the fewest placements the kit takes for a pilot, so that its sizing code runs on a host" }; p.workloads[0].declared = "A TEST OF THE KIT, NOT A READING. GET /private to the example probe, main against itself: a pilot-shaped A/A run only so that pilot.mjs and plan.mjs --sized-from run on a host on real counts. No figure it gives is a measurement of anything, and no K it gives is a K of any plan.";'
part t-pilot "$D/sizing/plan.json" pilot plain
step t-pilot.at30 node "$KIT/pilot.mjs" "$W/t-pilot/results" 30
step t-gated.plan node "$KIT/plan.mjs" "$D/sizing/plan.json" gated plain "$W/t-gated" --sized-from "$W/t-pilot/results"
k=$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).K); } catch { console.log(254); }' "$W/t-gated/plan/resolved.json")
echo "the K given as a number: $k"
variant number "$D/sizing/plan.json" "p.name = \"placement-kit-sizing-number\"; p.workloads[0].K = $k; p.workloads[0].sizedFrom = \"the A/A pilot-plain of this dry run's test pilot (t-pilot), under the tag evidence/placement-kit-2\";"
step n-gated.plan node "$KIT/plan.mjs" "$D/number/plan.json" gated plain "$W/n-gated" --sized-from "$W/t-pilot/results"
for g in t-gated n-gated; do
    if [ -f "$W/$g/plan/resolved.sh" ]; then
        ( . "$W/$g/plan/resolved.sh"; model=$(awk -F': *' '/^model name/ { print $2; exit }' /proc/cpuinfo)
          if [ -n "$SIZED_MODEL" ] && [ "$model" = "$SIZED_MODEL" ]; then echo "$g: SIZED_MODEL is this host's model name as run.sh reads it, byte for byte: $SIZED_MODEL"; else echo "$g: SIZED_MODEL '$SIZED_MODEL' is NOT this host's '$model'"; fi )
    else echo "$g: not resolved, so it has no SIZED_MODEL"; fi
done
echo "t-gated and n-gated are resolved at most: build.sh and run.sh were not run on them ($(ls -d "$W/t-gated/bin" "$W/n-gated/bin" "$W/t-gated/results" "$W/n-gated/results" 2>/dev/null | wc -l) bin or results directories under them)"

echo "== what (a)'s gated results hold of each path a run goes through"
R=$W/a-gated/results
echo "the servers' environment (verify/server-env.txt), names alone: $(cut -d= -f1 "$R/verify/server-env.txt" | paste -sd' ' -)"
echo "the allocator each started server reported, over every turn's server log: $(cat "$R"/*/p*/serve-?.log | grep '^ALLOCATOR' | sort | uniq -c | paste -sd';' -)"
echo "turns recorded: $(cat "$R"/*/p*/raw-*.log | grep -c '^## pair') in the turn logs, $(for f in "$R"/*/p*/counts-*.csv; do tail -n +2 "$f"; done | wc -l) rows of counts, $(for f in "$R"/*/p*/counts-*.csv; do tail -n +2 "$f"; done | awk -F, '{ for (i = 3; i <= NF; i++) if (!($i + 0 > 0)) n++ } END { print n + 0 }') of their values not above zero"
echo "the probe as built, kept in the results: $(find "$R/probe" -type f | wc -l) files; sha256sum -c plan/inputs.sha256 there: $(cd "$R" && sha256sum --quiet -c plan/inputs.sha256 >/dev/null 2>&1 && echo passes || echo FAILS)"
echo "each build's environment in the results: $(ls "$R" | grep '^build-.*\.env$' | paste -sd' ' -), $(cat "$R"/build-*.env | wc -l) lines, of which CFLAGS, RUSTFLAGS or MALLOC_CONF: $(cat "$R"/build-*.env | grep -cE '^(CFLAGS|RUSTFLAGS|MALLOC_CONF)=')"
echo "cargo's config files outside the probe (host.txt): $(grep "cargo's config files" "$R/host.txt" | sed 's/.*: //')"

K=$W/keep; mkdir -p "$K"
cp "$W"/*.out "$K/"
for n in a-pilot a-gated alike t-pilot; do
    mkdir -p "$K/$n"; cp -R "$W/$n/results" "$K/$n/results"; cp "$W/$n"/build-*.log "$K/$n/"
done
cp -R "$W/a-gated/selftest" "$K/a-gated/selftest"
mkdir -p "$K/ranged"; cp -R "$W/ranged/plan" "$K/ranged/plan"; cp -R "$W/ranged/verify" "$K/ranged/verify"; cp "$W/ranged"/build-*.log "$W/ranged"/build-*.env "$K/ranged/"; cp "$W/ranged/bin/sha256.txt" "$K/ranged/"
for g in t-gated n-gated; do [ ! -d "$W/$g/plan" ] || { mkdir -p "$K/$g"; cp -R "$W/$g/plan" "$K/$g/plan"; }; done
for v in ranged alike undeclared sizing number; do mkdir -p "$K/plans/$v"; cp "$D/$v/plan.json" "$K/plans/$v/"; done
( cd "$KIT" && find . -type f | LC_ALL=C sort | xargs sha256sum ) >"$K/kit-sha256.txt"
find "$K" -type l -delete
find "$K" \( -name '*.o' -o -name 'perf' \) -type f -delete
echo "turns under the directories that must hold none (ranged, t-gated, n-gated): $(find "$W/ranged" "$W/t-gated" "$W/n-gated" -name 'raw-*.log' -exec cat {} + 2>/dev/null | grep -c '^## pair') turns in their logs, $(find "$W/ranged" "$W/t-gated" "$W/n-gated" -name 'counts-*.csv' -exec tail -n +2 {} \; 2>/dev/null | wc -l) rows of counts"
echo DRY-RUN-DONE
