#!/bin/sh
# verify.sh <work dir> <out dir>: before anything is measured, every placement build.sh made
# answers the workload's request as its side's unpadded binary does (the placement plan's first
# point, CONTRIBUTING.md, Pull requests, item 2). run.sh runs it first.
#   1. The base's unpadded binary is started twice and its answer's headers kept from each start
#      (<out dir>/start-1.raw-headers, start-2.raw-headers), each answer taken by curl under
#      answers.mjs, with the request turns.sh's comparison sends (Host and the plan's header lines,
#      curl's own Accept and User-Agent left out), and of the plan's status, or it is no evidence
#      and fails verify.sh: every header the
#      plan masks, with a stated range or without, must have been sent once by each start and
#      differ between them (mask.mjs starts, on the headers answers.mjs wrote, by their SHA-256s).
#      A value that is not shown to differ is not one the plan may mask.
#   2. For each bin/<side>-p<pad>, it and bin/<side> are started and turns.sh, with no pair,
#      compares their answers: status, every header but Date after the plan's mask, and the body
#      as received, byte for byte; two answers of the unpadded binary must agree too, and a masked
#      header with a stated range must be within it in every answer. A placement is recorded as
#      verified only from what answers.mjs verifies of what turns.sh left: its handoff line,
#      printed after its servers' stop, the handoff.json of that SHA-256, the diff.txt and
#      bodies.txt it seals and the verdict.txt of its outcome.
# Any difference stops: the placement is not the same program. Each check is stopped (and fails)
# after the plan's placementSeconds; each of the two starts of the base is given 100 tries of a
# readiness request bounded to a second, and is stopped however verify.sh ends: TERM, and KILL
# if it is still running 5 s later, so a server that ignores TERM holds verify.sh no longer
# (serve.mjs, below). serve.mjs stops the process START is, and nothing it started: START must be,
# or exec, the server that listens. After each stop nothing may accept a connection on 18083 (one
# connect, at most a second): one that does, a server START forked and left, say, fails verify.sh,
# and stopping that server is the operator's. Every curl is run with --disable, so no curl
# configuration of HOME's (a retry, a header) changes a request or stretches its bound, and with
# --noproxy '*', so no proxy of the environment's (http_proxy, ALL_PROXY) answers for 127.0.0.1.
# answers.mjs runs its curl so too, giving the answer 10 s. Each answers.mjs is run with an
# environment of PATH alone, so no NODE_OPTIONS of the caller's (--inspect-brk, say) holds it, and
# under timeout: 30 s, and KILL 5 s later, so a stalled one holds verify.sh no longer.
# Every server is started with an environment of PATH, HOME, PORT and BIN alone, kept in
# <out dir>/server-env.txt. Writes <out dir>/<side>-p<pad>/ and
# <out dir>/verdicts.txt, one line a binary: "<binary> as <side>: answers: same; ...".
set -eu
[ $# -eq 2 ] && [ -f "$1/plan/resolved.sh" ] || { echo "usage: verify.sh <work dir> <out dir>" >&2; exit 2; }
. "$1/plan/resolved.sh"
out=$2; B=$WORK/bin; PL=$WORK/plan
export KIT START REQ_PATH STATUS EVENTS CPU_SERVER CPU_LOAD WRK_T WRK_C TURN PORT_A PORT_B
export HEADERS="$PL/headers.txt" SCRIPT="$PL/request.lua" MASK="$PL/mask.sed" MASK_JSON="$PL/mask.json" WARMUP=0 EXPECT=
mkdir -p "$out"; : >"$out/verdicts.txt"
# Each start of the base is run by serve.mjs, which starts the server as its own child and stops
# it when its standard input ends: TERM, KILL if it is still running 5 s later, and its own exit
# within 5 s more. Only serve.mjs signals the server, through the child's handle, which holds the
# process until serve.mjs reaps it, so no signal goes by a process number that may since name
# another process; this shell sends none. Its standard input is a FIFO whose one writer is this
# shell's descriptor 3 (opened read and write, so neither end waits for the other), read through
# descriptor 4 while serve.mjs starts. No command this shell runs while either is open has them:
# serve.mjs gets both closed, and so does every other one that is not a builtin (rm, curl and the
# readiness loop's sleep), on the command itself. So closing descriptor 3 stops the server, and so
# does this shell's end, however it ends, KILL included, even while a command it ran still runs.
# Starting a server and stopping one hold off HUP, INT, PIPE and TERM (late) until
# they are done, a stop until serve.mjs has ended, and the shell then exits 1 for the signal: one
# cannot cut a stop short and leave the server running. A trapped signal ends a wait early, with a
# status above 128, so a wait it woke is made again. serve.mjs is run with an environment of PATH
# and HOME alone, so no NODE_OPTIONS of the caller's (--inspect-brk, say) holds it before it can
# stop anything, and the wait for it is bounded: about 15 s, more than its own 10 s at most. If it
# has not ended by then, verify.sh fails, saying the cleanup is unconfirmed, and signals nothing.
sup=; late=
hold() { woke=; trap 'late=1; woke=1' HUP INT PIPE TERM; }
release() { trap 'exit 1' HUP INT PIPE TERM; [ -z "$late" ] || exit 1; }
halt() {
    hold
    exec 3>&-
    st=0; stopped=
    if [ -n "$sup" ]; then
        s=$sup; stopped=1; sup=
        # kill -0 sends no signal: it asks whether the shell's own child, serve.mjs, is still
        # there. Its number cannot name another process until the shell reaps it, which the
        # shell does while it waits for a sleep below (or in wait), and then kill -0 finds
        # nothing. A number taken again since would read as still running, and the bound ends that.
        n=0
        while kill -0 "$s" 2>/dev/null && [ $n -lt 150 ]; do n=$((n + 1)); sleep 0.1; done
        if kill -0 "$s" 2>/dev/null; then
            echo "verify: serve.mjs, stopping the base's server, has not ended 15 s after its input closed: cleanup unconfirmed" >&2
            st=1; stopped=
        else
            while :; do
                woke=; st=0; wait "$s" || st=$?
                [ $st -gt 128 ] && [ -n "$woke" ] || break
            done
            [ $st = 0 ] || echo "verify: serve.mjs, stopping the base's server, ended with status $st" >&2
        fi
    fi
    # The server serve.mjs stopped has ended, and its listening socket with it: curl's 7 is a
    # refused connection, and anything else is something that still accepts one.
    if [ $st = 0 ] && [ -n "$stopped" ]; then
        cst=0; curl --disable --noproxy '*' -s --max-time 1 -o /dev/null http://127.0.0.1:18083/ </dev/null || cst=$?
        [ $cst = 7 ] || { echo "verify: something still accepts on 18083 after the base's server was stopped (curl status $cst): START must be, or exec, the server that listens, not start it and leave it" >&2; st=1; }
    fi
    release
    return $st
}
trap 'halt || :' EXIT
trap 'exit 1' HUP INT PIPE TERM
# answers.mjs <mode> <say> <argument>..., as the header says, never with descriptors 3 and 4.
answers() {
    hst=0; env -i PATH="$PATH" timeout --foreground -k 5 30 node "$KIT/answers.mjs" "$@" 3>&- 4>&- || hst=$?
    case $hst in 124|137) echo "verify: answers.mjs $1 did not end within 30 s, and was stopped" >&2 ;; esac
    return $hst
}
# The environment a server is started with, as env prints it and then sorted: two commands, each
# with its status checked, since a pipeline's status is its last command's alone.
env -i PATH="$PATH" HOME="$HOME" PORT=18083 BIN="$B/base" env >"$out/server-env.unsorted" || { echo "verify: env could not print the server's environment (status $?)" >&2; exit 1; }
LC_ALL=C sort "$out/server-env.unsorted" >"$out/server-env.txt" || { echo "verify: sort could not sort the server's environment (status $?)" >&2; exit 1; }
rm -f "$out/server-env.unsorted"
fifo=$out/serve.fifo
for s in 1 2; do
    hold
    rm -f "$fifo"; mkfifo "$fifo"
    exec 3<>"$fifo" 4<"$fifo"
    rm -f "$fifo" 3>&- 4>&-
    env -i PATH="$PATH" HOME="$HOME" node "$KIT/serve.mjs" env -i PATH="$PATH" HOME="$HOME" PORT=18083 BIN="$B/base" taskset -c "$CPU_SERVER" sh -c "exec $START" <&4 3>&- 4>&- &
    sup=$!
    exec 4<&-
    release
    i=0
    until curl --disable --noproxy '*' -s --max-time 1 -o /dev/null http://127.0.0.1:18083/ </dev/null 3>&-; do
        i=$((i + 1)); [ $i -lt 100 ] || { echo "verify: nothing answers on 18083" >&2; exit 1; }; sleep 0.1 3>&-
    done
    # The SHA-256 of the headers it wrote, which the mask's check below reads them by.
    sha=$(exec 3>&-; answers start verify 18083 "$REQ_PATH" "$HEADERS" "$STATUS" "$out/start-$s") || exit 1
    if [ $s = 1 ]; then sha1=$sha; else sha2=$sha; fi
    halt || exit 1
done
said=$(answers starts verify "$MASK_JSON" "$out/start-1.raw-headers" "$sha1" "$out/start-2.raw-headers" "$sha2") || { echo "VERIFY FAILED: the plan's mask" >&2; exit 1; }
printf '%s\n' "$said" >"$out/starts.txt"
printf '%s\n' "$said"
verified=0
one() { # <side> <pad>
    d=$out/$1-p$2
    timeout -k 30 "$PLACEMENT_SECONDS" taskset -c "$CPU_DRIVER" sh "$KIT/turns.sh" "$d" "$W" 0 "$B/$1" "$B/$1-p$2" >"$d.log" 2>&1 \
        || { cat "$d.log" >&2; echo "VERIFY FAILED: $1-p$2 against $1" >&2; exit 1; }
    # Both the verdict and the bodies' evidence, as answers.mjs verifies them, or nothing is recorded.
    line=$(answers verified "verify: $1-p$2" "$d/answers" "$d.log" "turns: $W") || { echo "VERIFY FAILED: $1-p$2 against $1: what turns.sh left is not a verified placement" >&2; exit 1; }
    printf '%s as %s: %s\n' "$1-p$2" "$1" "$line" >>"$out/verdicts.txt"
    verified=$((verified + 1))
}
for n in $PADS_P $PADS_Q; do one base "$n"; done
case " $SIDES " in *" head "*) for n in $PADS_P; do one head "$n"; done ;; esac
echo "verify: $verified placements answer as their unpadded binary"
