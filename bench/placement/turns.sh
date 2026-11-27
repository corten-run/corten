#!/bin/sh
# turns.sh: one placement of a comparison, two binaries A and B: their answers to the workload's
# request compared, then one unrecorded pair of turns and the recorded pairs, every turn on a
# freshly started binary (started, pinned, waited for, measured and stopped), the order of the two
# turned every pair. The CSV's rows name A "base" and B "head", whichever binaries they are.
#
# Usage: turns.sh <out dir> <workload> <pairs> <binary A> <binary B>
# Environment, all of it the work directory's plan (run.sh and verify.sh set it):
#   KIT         this directory
#   START       the command that serves HTTP on 127.0.0.1:$PORT from $BIN, run under taskset with
#               an environment of PATH, HOME, PORT and BIN alone (env -i)
#   REQ_PATH    the request's path; HEADERS, a file of its header lines, one a line
#   SCRIPT      the wrk script, whose done() prints
#               "RESULT <requests> <connect> <read> <write> <status> <timeout>" (get.lua)
#   MASK_JSON   the plan's mask: the header values masked, and the ranges it states (mask.mjs)
#   STATUS      the status every compared answer must have
#   EXPECT      empty, or a file holding the exact text of answers/diff.txt that the change makes
#               by design; without it A and B must answer the same. When they answer the same,
#               diff.txt is empty; otherwise it is the diff of the masked headers and then one
#               bodies line, "bodies differ: <A> and <B> bytes, sha256 <A's> and <B's>" or, for
#               one body, "bodies same: <N> bytes, sha256 <its>", so an expected difference holds
#               the bodies too when the headers alone differ
#   WARMUP      unrecorded pairs before the recorded ones
#   TURN        seconds of load in a turn; WRK_T and WRK_C, wrk's threads and connections
#   CPU_SERVER  the CPU every server is pinned to; CPU_LOAD, wrk's CPUs
#   EVENTS      the perf events counted over each turn; every one must be counted once, a count
#               above zero, and running 100% of the turn
#   PORT_A, PORT_B  the ports on 127.0.0.1 A's and B's servers listen on (18081 and 18082, as
#               plan.mjs writes them)
# A compared answer is the status line, every header line but Date with the plan's mask applied,
# each byte as curl wrote it but the CR before each line's end, and the body as received, byte for
# byte. answers.mjs captures, checks, compares and keeps the answers: curl takes each answer once,
# with the request verify.sh's starts send too (Host and the plan's header lines, curl's own Accept
# and User-Agent left out), straight into answers/ files answers.mjs has just created new and holds
# open, and the system diff compares the masked headers once, through those same files; the
# lengths, SHA-256s and bodies line come from the bytes captured, and every file of answers/ is
# created new. It reads each turn's perf and wrk output too, as bytes, which go to the raw log as
# they are; each turn writes them to files of its own, created new for it. A turn whose wrk output
# has other than one complete RESULT line of decimal counts, or any error, or whose counter is
# missing, reported twice, not in a complete row, not a count above zero or not at exactly 100%
# (perf's "100.00"), fails the placement and records nothing. answers.mjs is run with an
# environment of PATH alone, so no NODE_OPTIONS of the caller's reaches it, and under timeout:
# 60 s for the comparison (three curls of 10 s each, which it stops at 15 s, and a diff under a
# timeout of its own, 10 s), 30 s for the rest, and KILL 5 s later; curl's --max-time and diff's
# timeout bound each even when answers.mjs is stopped before them.
# Writes <out dir>/counts-<workload>.csv (pair,version,requests and a column per event),
# raw-<workload>.log (every turn's perf and wrk output), answers/, serve-{A,B}.log (each server's
# error output and serve.mjs's) and, while a server runs, serve-{A,B}.pid. answers/ (made afresh)
# holds each answer's raw-headers, headers and body, diff.txt (the masked headers' diff, in diff's
# normal format, then the bodies line, or nothing), bodies.txt and handoff.json, which names the
# outcome and the SHA-256s of diff.txt and bodies.txt; anything already at one of those paths, an
# answer of another status, a masked header out of its range, two answers of A that differ, or a
# diff that cannot compare or disagrees with the bytes compared, fail the placement. Every curl is run with --disable, so no curl configuration of HOME's (a
# retry, a header) changes a request or how long it may take, and with --noproxy '*', so no proxy
# of the environment's (http_proxy, ALL_PROXY) answers for 127.0.0.1. Every curl has a bound:
# a second for the check that nothing accepts on the two ports before the start, each readiness
# request and each check of a port after a stop, and 10 s for an answer, so a server
# that takes a connection and never answers holds turns.sh, and a signal it has held off, no
# longer than that.
# Every server is run by serve.mjs, as verify.sh runs its base's, and stopped by it alone (TERM,
# and KILL 5 s later for one that ignores TERM); turns.sh waits about 15 s at most for a stop and
# then fails, saying the cleanup is unconfirmed, and, once every server it is stopping has ended,
# fails too if anything still accepts on any of their ports, and a turns.sh killed outright still
# has its servers stopped (by serve.mjs, after turns.sh has ended).
# What a stop checks, and what it cannot: serve.mjs exits 0 only from its server's exit, which Node
# reports once it has reaped that process, so a stop whose serve.mjs exits 0 has ended the server
# serve.mjs started (the process START is, or execs). Once every server a stop ends has ended,
# each of their ports is checked once. A process that START leaves behind, rather than being or
# exec'ing the server, is not tracked: one that accepts on a port when it is checked fails the
# stop, but one that opens a port after that check is not seen. START must be, or exec, the server.
# When A and B answer differently and no difference is expected, both servers are stopped first,
# and only once serve.mjs has said each ended and nothing accepted on either port when checked
# does turns.sh say "turns: <workload>: A and B answer differently; both servers ended and nothing
# accepted on either port when checked" and exit 4. A stop that fails or is unconfirmed, or a
# signal during it, exits 1 without that line. A passing verdict ("answers: same", or "answers:
# differ only as the plan's expected difference says") is printed and written to
# answers/verdict.txt only after the same stop of both servers has passed, so a stop that fails
# leaves no verdict.txt. After that stop, and only then, turns.sh also prints "turns: <workload>:
# handoff sha256 <SHA-256 of answers/handoff.json>", which is what the trend and verify.sh read
# the comparison by. Any other failure exits 1, or with the status of the command that failed
# (set -e), so it is that line and status 4 together that say the answers differ and the stop
# after them passed those checks.
set -eu
[ $# -eq 5 ] || { sed -n '2,82p' "$0"; exit 2; }
out=$1; workload=$2; pairs=$3; abin=$4; bbin=$5
status=$STATUS; warmup=$WARMUP; secs=$TURN; events=$EVENTS; cpu=$CPU_SERVER; load=$CPU_LOAD; path=$REQ_PATH
# One command of its own, so its status is the one checked (a pipeline's is its last stage's).
columns=$(printf '%s\n' "$events" | sed 's/[^A-Za-z0-9,]/_/g')
mkdir -p "$out"
csv=$out/counts-$workload.csv; raw=$out/raw-$workload.log; ans=$out/answers
rm -rf "$ans"; mkdir -p "$ans"; : >"$raw"
fail() { echo "turns: $workload: $*" >&2; exit 1; }
# answers.mjs <mode> <argument>..., with an environment of PATH alone and within its bound (the
# header); timeout's --foreground keeps it in this shell's process group, so the placement's
# deadline TERM reaches it and its curl too. Never with the servers' inputs open.
answers() {
    bound=30; [ "$1" != compare ] || bound=60
    mode=$1; shift
    hst=0; env -i PATH="$PATH" timeout --foreground -k 5 "$bound" node "$KIT/answers.mjs" "$mode" "turns: $workload" "$@" 5>&- 6>&- || hst=$?
    case $hst in 124|137) echo "turns: $workload: answers.mjs $mode did not end within $bound s, and was stopped" >&2 ;; esac
    return $hst
}

aport=$PORT_A; bport=$PORT_B
# Before any start, nothing takes a connection on either port: curl's 7 is a refused one, and
# anything else (an answer, or one taken and never answered, 28) is something already there.
for port in $aport $bport; do
    cst=0; curl --disable --noproxy '*' -s --max-time 1 -o /dev/null "http://127.0.0.1:$port/" </dev/null || cst=$?
    [ $cst = 7 ] || fail "something already accepts on $port (curl status $cst)"
done
: >"$out/serve-A.log"; : >"$out/serve-B.log"
# Each server is run by serve.mjs, which starts it as its own child, writes its process number to
# serve-<A|B>.pid (that process is the one whose CPU is checked and that perf counts: the start
# command is exec'd, so it is the server), and stops it when its standard input ends: TERM, KILL
# if it is still running 5 s later, and its own exit within 5 s more. Of the kit's own scripts,
# only serve.mjs signals a server, through the child's handle, which holds the process until
# serve.mjs reaps it, so no signal goes by a process number that may since name another process;
# this shell sends none. The placement's deadline is another sender: timeout (run.sh, and the
# trend's check) signals turns.sh's whole process group, so the servers get its TERM (and its
# KILL 30 s on) as serve.mjs and this shell do, and serve.mjs then stops its server as above and exits 1.
# A server's standard input is a FIFO whose one writer is this shell's descriptor 5 (A's) or 6
# (B's), opened read and write so neither end waits for the other. No command this shell runs while
# either is open has them: serve.mjs gets both closed, and so does every other one that is not a
# builtin, on the command itself or by running in a subshell that closes them first (the answers'
# comparison). serve.mjs's start, run in the background, is a subshell that closes them with exec,
# for good, before any redirection of its own, one that can wait (a FIFO at its log's path, say)
# included: a redirection that closes them on the command itself would have the shell keep a copy
# of each until the command starts, and so through that wait. So closing one stops that server,
# and so does this shell's end, however it ends, KILL included, even while a command it ran still
# runs or waits to start.
# Starting a server and stopping servers hold off HUP, INT, PIPE and TERM (late) until they are
# done, a stop until serve.mjs has ended, and the shell then exits 1 for the signal: the
# placement's deadline TERM in a stop cannot cut it short and leave a server running.
# A trapped signal ends a wait early, with a status above 128, so a wait it woke is made again.
# serve.mjs is run with an environment of PATH and HOME alone, and the wait for it is bounded:
# about 15 s, more than its own 10 s at most. If it has not ended by then, turns.sh fails, saying
# the cleanup is unconfirmed, and signals nothing. After a stop, once every server it stops has
# ended, nothing may accept a connection on any of their ports (one connect each, at most a second).
a=; b=; sup_A=; sup_B=; late=
hold() { woke=; trap 'late=1; woke=1' HUP INT PIPE TERM; }
release() { trap 'exit 1' HUP INT PIPE TERM; [ -z "$late" ] || exit 1; }
start() { # <A|B> <port> <binary>. Its environment is PATH, HOME, PORT and BIN and what the plan's start command sets, none of the caller's; its error output goes to serve-<A|B>.log.
    hold
    fifo=$out/serve-$1.fifo
    rm -f "$fifo" "$out/serve-$1.pid" "$out/serve-$1.pid.tmp" 5>&- 6>&-; mkfifo "$fifo" 5>&- 6>&-
    if [ "$1" = A ]; then exec 5<>"$fifo" 7<"$fifo"; else exec 6<>"$fifo" 7<"$fifo"; fi
    rm -f "$fifo" 5>&- 6>&-
    # exec 5>&- 6>&- first, and for good: a redirection after it that waits (an open of a FIFO)
    # then holds neither. The subshell execs serve.mjs, so $! is serve.mjs's process.
    (
        exec 5>&- 6>&-
        exec env -i PATH="$PATH" HOME="$HOME" node "$KIT/serve.mjs" --pid="$out/serve-$1.pid" \
            sh -c 'exec 2>>"$0"; exec "$@"' "$out/serve-$1.log" env -i PATH="$PATH" HOME="$HOME" PORT="$2" BIN="$3" taskset -c "$cpu" sh -c "exec $START" \
            <&7 >/dev/null 2>>"$out/serve-$1.log" 7>&-
    ) &
    if [ "$1" = A ]; then sup_A=$!; else sup_B=$!; fi
    exec 7<&-
    release
}
halt() { # <A|B>...: stops those servers that run, together, within about 15 s
    hold
    for v; do if [ "$v" = A ]; then exec 5>&-; else exec 6>&-; fi; done
    st=0; n=0; probe=
    for v; do
        if [ "$v" = A ]; then s=$sup_A; sup_A=; a=; else s=$sup_B; sup_B=; b=; fi
        [ -n "$s" ] || continue
        rm -f "$out/serve-$v.pid" 5>&- 6>&-
        # kill -0 sends no signal: it asks whether the shell's own child, serve.mjs, is still
        # there. Its number cannot name another process until the shell reaps it, which the
        # shell does while it waits for a sleep below (or in wait), and then kill -0 finds
        # nothing. A number taken again since would read as still running, and the bound ends that.
        while kill -0 "$s" 2>/dev/null && [ $n -lt 150 ]; do n=$((n + 1)); sleep 0.1 5>&- 6>&-; done
        if kill -0 "$s" 2>/dev/null; then
            echo "turns: $workload: serve.mjs, stopping $v's server, has not ended 15 s after its input closed: cleanup unconfirmed" >&2
            st=1; continue
        fi
        while :; do
            woke=; sst=0; wait "$s" || sst=$?
            [ $sst -gt 128 ] && [ -n "$woke" ] || break
        done
        [ $sst = 0 ] || { echo "turns: $workload: serve.mjs, stopping $v's server, ended with status $sst" >&2; st=1; continue; }
        probe="$probe $v"
    done
    # The servers serve.mjs stopped have ended, and their listening sockets with them: curl's 7 is
    # a refused connection, and anything else is something that still accepts one. No port is
    # checked until every stop has ended: one checked while another server's stop still runs (5 s
    # and more for one that ignores TERM) could look closed and be opened again in that time, by
    # something its START forked, say, and turns.sh end with it listening.
    for v in $probe; do
        if [ "$v" = A ]; then hport=$aport; else hport=$bport; fi
        cst=0; curl --disable --noproxy '*' -s --max-time 1 -o /dev/null "http://127.0.0.1:$hport/" </dev/null 5>&- 6>&- || cst=$?
        [ $cst = 7 ] || { echo "turns: $workload: something still accepts on $hport after $v's server was stopped (curl status $cst): START must be, or exec, the server that listens, not start it and leave it" >&2; st=1; }
    done
    release
    return $st
}
trap 'halt A B || :' EXIT
trap 'exit 1' HUP INT PIPE TERM
ready() { # <A|B> <port>: that server answers, its process number from serve.mjs is then in $a or $b, and it is on the server's CPU
    i=0
    until [ -f "$out/serve-$1.pid" ] && curl --disable --noproxy '*' -s --max-time 1 -o /dev/null "http://127.0.0.1:$2/" </dev/null 5>&- 6>&-; do
        i=$((i + 1)); [ $i -lt 100 ] || fail "nothing answers on $2"; sleep 0.1 5>&- 6>&-
    done
    # A command substitution is a subshell of this one, with its descriptors: it closes them first.
    p=$(exec 5>&- 6>&-; cat "$out/serve-$1.pid")
    case $p in ''|*[!0-9]*) fail "serve.mjs gave no process number for $1's server: $p";; esac
    aff=$(exec 5>&- 6>&-; taskset -cp "$p") || fail "taskset could not read the CPUs of pid $p (status $?)"
    [ "${aff##*: }" = "$cpu" ] || fail "pid $p is not on cpu $cpu"
    if [ "$1" = A ]; then a=$p; else b=$p; fi
}
fresh() { # <A|B>: (re)starts that binary; its server's process number is then in $a or $b
    halt "$1" || exit 1
    if [ "$1" = A ]; then start A $aport "$abin"; ready A $aport; else start B $bport "$bbin"; ready B $bport; fi
}
fresh A; fresh B

# The two binaries answer the same: status and headers but Date, after the plan's mask, and the
# body as received. answers.mjs has curl take A's answer twice and B's once, each once, and diff
# compare the masked headers once (see the header). It runs in a subshell of its own, a command
# substitution that closes descriptors 5 and 6 before it runs anything, so it does not hold the
# servers' inputs open, and a KILL of this shell while it stalls still stops both servers. It
# prints how the answers compare (same, expected: they differ only as the plan's expected
# difference says, or differ) and the SHA-256 of the handoff.json it sealed, and says why when it
# fails, which ends this shell with status 1.
res=$(exec 5>&- 6>&-; answers compare "$ans" $aport $bport "$path" "$HEADERS" "$status" "$MASK_JSON" "${EXPECT:-}") || exit 1
outcome=${res%% *}; seal=${res#* }
case $seal in *[!0-9a-f]*|'') fail "the answers' comparison named no handoff: $res";; esac
[ ${#seal} = 64 ] || fail "the answers' comparison named no handoff: $res"
case $outcome in
    same) verdict="answers: same" ;;
    expected) verdict="answers: differ only as the plan's expected difference says" ;;
    differ)
        # A difference that is not expected is said only after a stop that passed: serve.mjs said both
        # servers ended and their ports refused a connection when checked, so the line and status 4
        # do not stand for answers compared on servers that were then left running.
        halt A B || fail "A and B's answers differ, and stopping their servers after the check failed or is unconfirmed: not read as a difference"
        echo "turns: $workload: A and B answer differently; both servers ended and nothing accepted on either port when checked" >&2
        echo "turns: $workload: handoff sha256 $seal"
        exit 4
        ;;
    *) fail "the answers' comparison said neither same, expected nor differ: $res" ;;
esac

# Both stopped after the check, so neither holds memory while the other is measured. The verdict
# is published only once that stop has passed, as a difference is: a stop that fails leaves no
# verdict.txt, no passing line and no handoff line, for answers compared on servers that were
# then left running.
halt A B || fail "stopping the two servers after their answers were compared failed or is unconfirmed: no verdict"
answers put "$ans/verdict.txt" "$verdict" || exit 1
echo "$verdict"
echo "turns: $workload: handoff sha256 $seal"
turn() { # <pair> <base|head>: A's turns are the CSV's base rows, B's its head rows
    # The turn's own two files, created new and empty for it (answers.mjs put refuses anything
    # already there), so what is read after it is what this turn's perf and wrk wrote, and a perf
    # or wrk that wrote nothing leaves an empty one, which records nothing. Made before its server
    # starts, so nothing runs between that server's readiness and perf's attaching to it.
    tp=$out/turn-$1-$2.perf; tw=$out/turn-$1-$2.wrk
    answers put "$tp" || exit 1
    answers put "$tw" || exit 1
    if [ "$2" = base ]; then fresh A; pid=$a; port=$aport; else fresh B; pid=$b; port=$bport; fi
    perf stat -x, -e "$events" -p "$pid" -o "$tp" -- sleep "$secs.4" 5>&- 6>&- &
    perfpid=$!
    sleep 0.1 5>&- 6>&-
    set --
    while IFS= read -r h; do [ -z "$h" ] || set -- "$@" -H "$h"; done <"$HEADERS"
    taskset -c "$load" wrk -t"$WRK_T" -c"$WRK_C" -d"${secs}s" "$@" -s "$SCRIPT" "http://127.0.0.1:$port$path" >"$tw" 5>&- 6>&-
    wait $perfpid
    # Its perf and wrk output, each read once, as bytes, by answers.mjs: it appends them to the raw
    # log as they are and, when they are a turn to record, the turn's row to the CSV.
    answers turn "$tp" "$tw" "$events" "$pair_" "$version_" "$raw" "$csv" || exit 1
    rm -f "$tp" "$tw" 5>&- 6>&-
    if [ "$version_" = base ]; then halt A || exit 1; else halt B || exit 1; fi
}
one() { pair_=$1; version_=$2; turn "$1" "$2"; }
echo "pair,version,requests,$columns" >"$csv"
w=1
while [ $w -le "$warmup" ]; do one "w$w" base; one "w$w" head; w=$((w + 1)); done
echo "pair,version,requests,$columns" >"$csv"
pair=1
while [ $pair -le "$pairs" ]; do
    if [ $((pair % 2)) = 1 ]; then one $pair base; one $pair head; else one $pair head; one $pair base; fi
    pair=$((pair + 1))
done
echo "$workload: done, $csv"
