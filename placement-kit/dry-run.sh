#!/bin/sh
# dry-run.sh <kit> <work root>: the dry run of bench/placement kept under this tag, every step of
# it. A test of the scripts on one host, read for nothing: every plan part is resolved with
# DRYRUN=1 (6 placements, 2 recorded pairs, 1 s turns). <kit> is bench/placement in a checkout
# that has the commits the plans name; <work root> must not exist. Each step's output goes to
# <work root>/<step>.out and its exit status is printed; what is kept is gathered under
# <work root>/keep.
#   (a)  main against itself on the kit's example plan: the pilot part, then the gated part, each
#        through plan.mjs, build.sh and run.sh, every check live and every placement turned.
#   (c)  on (a)'s gated work directory, the selftest's cases that start a server: a wrong answer,
#        a failed request, a placement past its time limit.
#   (b)  b/plan.json: main against a head with C code aligned beyond 16 bytes, through plan.mjs
#        and build.sh alone, so the fifth point's links, second pads, map checks and refusals run
#        and nothing is started: no server, no request, no counter. Then the selftest's map case,
#        which links and starts nothing either. verify.sh, run.sh and turns.sh are never run on it.
#   mask a copy of the example plan that masks a header the probe does not send differently
#        between starts: run.sh must stop at verify, before any turn.
#   undeclared  a copy of the example plan without full commits: plan.mjs must refuse it.
set -u
[ $# -eq 2 ] || { sed -n '2,19p' "$0"; exit 2; }
KIT=$1; W=$2; D=$(cd "$(dirname "$0")" && pwd)
[ ! -e "$W" ] || { echo "dry-run: $W exists" >&2; exit 1; }
mkdir -p "$W"
export DRYRUN=1
step() { # <name> <command...>
    n=$1; shift
    "$@" >"$W/$n.out" 2>&1; rc=$?
    echo "$(date -u +%T) $n: exit $rc: $(tail -n 1 "$W/$n.out" | cut -c1-240)"
    return $rc
}
part() { # <name> <plan file> <part> <workload>: plan.mjs, build.sh, run.sh
    step "$1.plan" node "$KIT/plan.mjs" "$2" "$3" "$4" "$W/$1" && step "$1.build" sh "$KIT/build.sh" "$W/$1" && step "$1.run" sh "$KIT/run.sh" "$W/$1"
}
variant() { # <name> <node expression changing the plan p>: a copy of the example plan and its probe
    mkdir -p "$D/$1"; rm -rf "$D/$1/probe"; cp -R "$KIT/example/probe" "$D/$1/probe"
    node -e 'const fs = require("fs"), p = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); eval(process.argv[3]); fs.writeFileSync(process.argv[2], JSON.stringify(p, null, 2) + "\n");' "$KIT/example/plan.json" "$D/$1/plan.json" "$2"
}

echo "== (a) main against itself: the pilot part, then the gated part"
part a-pilot "$KIT/example/plan.json" pilot plain
part a-gated "$KIT/example/plan.json" gated plain
echo "== (c) a wrong answer, a failed request, a placement past its time limit"
step a-gated.selftest sh "$KIT/selftest/selftest.sh" "$W/a-gated" answers failed limit
echo "== (b) a head with code aligned beyond 16 bytes: linked and checked, nothing started"
rm -rf "$D/b/probe"; cp -R "$KIT/example/probe" "$D/b/probe"
step b.plan node "$KIT/plan.mjs" "$D/b/plan.json" gated gzbr "$W/b" && step b.build sh "$KIT/build.sh" "$W/b" && step b.selftest sh "$KIT/selftest/selftest.sh" "$W/b" map
echo "== mask: a masked header that does not differ between starts (run.sh must end verify-failed, exit 1)"
variant mask 'p.name = "placement-kit-dry-mask"; p.workloads[0].mask = [{ header: "etag" }];'
part mask "$D/mask/plan.json" pilot plain
echo "== undeclared: a plan that does not name full commits (plan.mjs must exit 1)"
variant undeclared 'p.name = "placement-kit-dry-undeclared"; p.base = p.base.slice(0, 12); delete p.head;'
step undeclared.plan node "$KIT/plan.mjs" "$D/undeclared/plan.json"

K=$W/keep; mkdir -p "$K"
cp "$W"/*.out "$K/"
for n in a-pilot a-gated mask; do
    mkdir -p "$K/$n"; cp -R "$W/$n/results" "$K/$n/results"; cp "$W/$n"/build-*.log "$K/$n/"
done
cp -R "$W/a-gated/selftest" "$K/a-gated/selftest"
mkdir -p "$K/b/bin" "$K/b/maps" "$K/b/selftest"
cp -R "$W/b/plan" "$K/b/plan"; cp "$W/b"/build-*.log "$W/b"/lock-*.txt "$K/b/"
cp -R "$W/b/bin/layout" "$K/b/bin/layout"
cp "$W/b/bin"/*.txt "$W/b/bin"/*.json "$K/b/bin/"
cp "$W/b/maps"/*.gz "$W/b/maps/placements.sha256" "$K/b/maps/"
for s in base head; do cp "$W/b/capture/$s/args.json" "$K/b/link-$s.json"; done
cp "$W/b/selftest/map"/*.txt "$K/b/selftest/"
( cd "$KIT" && find . -type f | LC_ALL=C sort | xargs sha256sum ) >"$K/b/kit-sha256.txt"
find "$K" -name '*.o' -delete
echo "what (b) left running or recorded as a turn: $(find "$W/b" -name 'counts-*.csv' -o -name 'raw-*.log' -o -name 'serve-*.log' | wc -l) counts, turn logs or server logs under its work directory"
echo DRY-RUN-DONE
