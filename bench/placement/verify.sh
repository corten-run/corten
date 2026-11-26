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
# readiness request bounded to a second, and is stopped however verify.sh ends: TERM, and KILL
# if it is still running 5 s later, so a server that ignores TERM holds verify.sh no longer
# (serve.mjs, below).
# Every server is started with an environment of PATH, HOME, PORT and BIN alone, kept in
# <out dir>/server-env.txt. Writes <out dir>/<side>-p<pad>/ and
# <out dir>/verdicts.txt, one line a binary: "<binary> as <side>: answers: same; ...".
set -eu
[ $# -eq 2 ] && [ -f "$1/plan/resolved.sh" ] || { echo "usage: verify.sh <work dir> <out dir>" >&2; exit 2; }
. "$1/plan/resolved.sh"
out=$2; B=$WORK/bin; PL=$WORK/plan
export KIT START REQ_PATH STATUS EVENTS CPU_SERVER CPU_LOAD WRK_T WRK_C TURN
export HEADERS="$PL/headers.txt" SCRIPT="$PL/request.lua" MASK="$PL/mask.sed" MASK_JSON="$PL/mask.json" WARMUP=0 EXPECT=
mkdir -p "$out"; : >"$out/verdicts.txt"
# Each start of the base is run by serve.mjs, which starts the server as its own child and stops
# it when its standard input ends: TERM, KILL if it is still running 5 s later, and its own exit
# within 5 s more. Only serve.mjs signals the server, through the child's handle, which holds the
# process until serve.mjs reaps it, so no signal goes by a process number that may since name
# another process; this shell sends none. Its standard input is a FIFO whose one writer is this
# shell's descriptor 3 (opened read and write, so neither end waits for the other; serve.mjs and
# curl get it closed), so closing it stops the server, and so does this shell's end, however it
# ends, KILL included. Starting a server and stopping one hold off HUP, INT, PIPE and TERM (late) until
# they are done, a stop until serve.mjs has ended, and the shell then exits 1 for the signal: one
# cannot cut a stop short and leave the server running. A trapped signal ends a wait early, with a
# status above 128, so a wait it woke is made again.
sup=; late=
hold() { woke=; trap 'late=1; woke=1' HUP INT PIPE TERM; }
release() { trap 'exit 1' HUP INT PIPE TERM; [ -z "$late" ] || exit 1; }
halt() {
    hold
    exec 3>&-
    st=0
    if [ -n "$sup" ]; then
        s=$sup
        while :; do
            woke=; st=0; wait "$s" || st=$?
            [ $st -gt 128 ] && [ -n "$woke" ] || break
        done
        sup=
    fi
    [ $st = 0 ] || echo "verify: serve.mjs, stopping the base's server, ended with status $st" >&2
    release
    return $st
}
trap 'halt || :' EXIT
trap 'exit 1' HUP INT PIPE TERM
env -i PATH="$PATH" HOME="$HOME" PORT=18083 BIN="$B/base" env | LC_ALL=C sort >"$out/server-env.txt"
fifo=$out/serve.fifo
for s in 1 2; do
    hold
    rm -f "$fifo"; mkfifo "$fifo"
    exec 3<>"$fifo" 4<"$fifo"
    rm -f "$fifo"
    node "$KIT/serve.mjs" env -i PATH="$PATH" HOME="$HOME" PORT=18083 BIN="$B/base" taskset -c "$CPU_SERVER" sh -c "exec $START" <&4 3>&- 4>&- &
    sup=$!
    exec 4<&-
    release
    i=0
    until curl -s --max-time 1 -o /dev/null http://127.0.0.1:18083/ </dev/null 3>&-; do
        i=$((i + 1)); [ $i -lt 100 ] || { echo "verify: nothing answers on 18083" >&2; exit 1; }; sleep 0.1
    done
    set --
    while IFS= read -r h; do [ -z "$h" ] || set -- "$@" -H "$h"; done <"$HEADERS"
    curl -sS --max-time 10 -D "$out/start-$s.raw-headers" -o /dev/null "$@" "http://127.0.0.1:18083$REQ_PATH" </dev/null 3>&-
    halt || exit 1
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
