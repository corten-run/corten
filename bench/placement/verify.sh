#!/bin/sh
# verify.sh <work dir> <out dir>: before anything is measured, every placement build.sh made
# answers the workload's request as its side's unpadded binary does (the placement plan's first
# point, CONTRIBUTING.md, Pull requests, item 2). run.sh runs it first.
#   1. The base's unpadded binary is started twice and its answer's headers kept from each start
#      (<out dir>/start-1.raw-headers, start-2.raw-headers): every header the plan masks, with a
#      stated range or without, must have been sent once by each start and differ between them
#      (mask.mjs starts). A value that is not shown to differ is not one the plan may mask.
#   2. For each bin/<side>-p<pad>, it and bin/<side> are started and turns.sh, with no pair,
#      compares their answers: status, every header but Date after the plan's mask, and the body
#      as received, byte for byte; two answers of the unpadded binary must agree too, and a masked
#      header with a stated range must be within it in every answer.
# Any difference stops: the placement is not the same program. Each check is stopped (and fails)
# after the plan's placementSeconds; each of the two starts of the base is given 100 tries of a
# readiness request bounded to a second, and is stopped however verify.sh ends. Every server is
# started with an environment of PATH, HOME, PORT and BIN alone, kept in
# <out dir>/server-env.txt. Writes <out dir>/<side>-p<pad>/ and
# <out dir>/verdicts.txt, one line a binary: "<binary> as <side>: answers: same; ...".
set -eu
[ $# -eq 2 ] && [ -f "$1/plan/resolved.sh" ] || { echo "usage: verify.sh <work dir> <out dir>" >&2; exit 2; }
. "$1/plan/resolved.sh"
out=$2; B=$WORK/bin; PL=$WORK/plan
export KIT START REQ_PATH STATUS EVENTS CPU_SERVER CPU_LOAD WRK_T WRK_C TURN
export HEADERS="$PL/headers.txt" SCRIPT="$PL/request.lua" MASK="$PL/mask.sed" MASK_JSON="$PL/mask.json" WARMUP=0 EXPECT=
mkdir -p "$out"; : >"$out/verdicts.txt"
pid=
trap '[ -z "$pid" ] || { kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true; }' EXIT
trap 'exit 1' HUP INT PIPE TERM
env -i PATH="$PATH" HOME="$HOME" PORT=18083 BIN="$B/base" env | LC_ALL=C sort >"$out/server-env.txt"
for s in 1 2; do
    env -i PATH="$PATH" HOME="$HOME" PORT=18083 BIN="$B/base" taskset -c "$CPU_SERVER" sh -c "exec $START" >/dev/null 2>&1 &
    pid=$!
    i=0
    until curl -s --max-time 1 -o /dev/null http://127.0.0.1:18083/ </dev/null; do
        i=$((i + 1)); [ $i -lt 100 ] || { echo "verify: nothing answers on 18083" >&2; exit 1; }; sleep 0.1
    done
    set --
    while IFS= read -r h; do [ -z "$h" ] || set -- "$@" -H "$h"; done <"$HEADERS"
    curl -sS --max-time 10 -D "$out/start-$s.raw-headers" -o /dev/null "$@" "http://127.0.0.1:18083$REQ_PATH" </dev/null
    kill $pid; wait $pid 2>/dev/null || true; pid=
done
node "$KIT/mask.mjs" starts "$MASK_JSON" "$out/start-1.raw-headers" "$out/start-2.raw-headers" || { echo "VERIFY FAILED: the plan's mask" >&2; exit 1; }
echo "two starts of base: every header the plan masks differs between them ($(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).map((m) => m.header).join(", ") || "none masked")' "$MASK_JSON"))" | tee "$out/starts.txt"
one() { # <side> <pad>
    d=$out/$1-p$2
    timeout -k 30 "$PLACEMENT_SECONDS" taskset -c "$CPU_DRIVER" sh "$KIT/turns.sh" "$d" "$W" 0 "$B/$1" "$B/$1-p$2" >"$d.log" 2>&1 \
        || { cat "$d.log" >&2; echo "VERIFY FAILED: $1-p$2 against $1" >&2; exit 1; }
    echo "$1-p$2 as $1: $(cat "$d/answers/verdict.txt"); $(cat "$d/answers/bodies.txt")" >>"$out/verdicts.txt"
}
for n in $PADS_P $PADS_Q; do one base "$n"; done
case " $SIDES " in *" head "*) for n in $PADS_P; do one head "$n"; done ;; esac
echo "verify: $(( $(wc -l <"$out/verdicts.txt") )) placements answer as their unpadded binary"
