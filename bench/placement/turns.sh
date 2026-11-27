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
#   MASK        the sed script that masks the header values the plan names; MASK_JSON, the plan's
#               mask, for the ranges it states (mask.mjs)
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
# A compared answer is the status line, every header line but Date after MASK, and the body as
# received, byte for byte. A turn in which wrk reports an error of any kind, or a counter is
# missing, not a number, zero or under 100%, fails the placement and records nothing.
# Writes <out dir>/counts-<workload>.csv (pair,version,requests and a column per event),
# raw-<workload>.log (every turn's perf and wrk output), answers/, serve-{A,B}.log (each server's
# error output and serve.mjs's) and, while a server runs, serve-{A,B}.pid. The difference is
# what diff printed, taken from its output and not from a file, with the bodies line, and that text
# alone is compared with EXPECT and written, once, as diff.txt: something already at diff.txt
# (answers/ is made afresh), a diff.txt that cannot be created as a new file or written, a diff or
# cmp that cannot compare (status 2), a diff whose output disagrees with its status, a cmp that
# disagrees with the bodies' sizes and SHA-256s, or a stage of the headers' normalization (tr,
# grep, sed) that does not end with status 0, fails the placement. Every curl is run with --disable, so no curl configuration of HOME's (a
# retry, a header) changes a request or how long it may take, and with --noproxy '*', so no proxy
# of the environment's (http_proxy, ALL_PROXY) answers for 127.0.0.1. Every curl has a bound:
# a second for the check that nothing accepts on the two ports before the start, each readiness
# request and each check of a port after a stop, and 10 s for an answer, so a server that takes a
# connection and never answers holds turns.sh, and a signal it has held off, no longer than that.
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
# leaves no verdict.txt. Any other failure exits 1, or with the status of the command that failed
# (set -e), so it is that line and status 4 together that say the answers differ and the stop
# after them passed those checks.
set -eu
[ $# -eq 5 ] || { sed -n '2,66p' "$0"; exit 2; }
out=$1; workload=$2; pairs=$3; abin=$4; bbin=$5
status=$STATUS; warmup=$WARMUP; secs=$TURN; mask=$MASK; events=$EVENTS; cpu=$CPU_SERVER; load=$CPU_LOAD; path=$REQ_PATH
# One command of its own, so its status is the one checked (a pipeline's is its last stage's).
columns=$(printf '%s\n' "$events" | sed 's/[^A-Za-z0-9,]/_/g')
mkdir -p "$out"
csv=$out/counts-$workload.csv; raw=$out/raw-$workload.log; ans=$out/answers
rm -rf "$ans"; mkdir -p "$ans"; : >"$raw"
fail() { echo "turns: $workload: $*" >&2; exit 1; }

aport=18081; bport=18082
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
# comparison, and the reading of each turn's output). So closing one stops that server, and so
# does this shell's end, however it ends, KILL included, even while a command it ran still runs.
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
    rm -f "$fifo" "$out/serve-$1.pid" 5>&- 6>&-; mkfifo "$fifo" 5>&- 6>&-
    if [ "$1" = A ]; then exec 5<>"$fifo" 7<"$fifo"; else exec 6<>"$fifo" 7<"$fifo"; fi
    rm -f "$fifo" 5>&- 6>&-
    env -i PATH="$PATH" HOME="$HOME" node "$KIT/serve.mjs" --pid="$out/serve-$1.pid" \
        sh -c 'exec 2>>"$0"; exec "$@"' "$out/serve-$1.log" env -i PATH="$PATH" HOME="$HOME" PORT="$2" BIN="$3" taskset -c "$cpu" sh -c "exec $START" \
        <&7 >/dev/null 2>>"$out/serve-$1.log" 5>&- 6>&- 7>&- &
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

# The two binaries answer the same: status and headers but Date, after MASK, and the body as
# received. curl's own Accept and User-Agent are left out unless the request has its own.
answer() { # <port> <out prefix>: writes <prefix>.raw-headers, .headers (masked) and .body (raw)
    port=$1; to=$2
    set --
    grep -qi '^accept:' "$HEADERS" || set -- "$@" -H 'Accept:'
    grep -qi '^user-agent:' "$HEADERS" || set -- "$@" -H 'User-Agent:'
    while IFS= read -r h; do [ -z "$h" ] || set -- "$@" -H "$h"; done <"$HEADERS"
    curl --disable --noproxy '*' -sS --max-time 10 -D "$to.raw-headers" -o "$to.body" "$@" "http://127.0.0.1:$port$path" </dev/null 5>&- 6>&-
    # Each stage on its own, its status checked: a pipeline's status is its last stage's alone, so a
    # tr or grep that printed part of the headers and then failed would leave both sides' headers
    # cut short alike, and read as the same. The answer has a status line, so grep selects one.
    tr -d '\r' <"$to.raw-headers" >"$to.lf" || fail "tr could not take the carriage returns out of $to.raw-headers (status $?)"
    gst=0; grep -iv '^date:' "$to.lf" >"$to.dateless" || gst=$?
    [ $gst = 0 ] || fail "grep could not take the Date line out of $to.lf (status $gst)"
    sed -f "$mask" "$to.dateless" >"$to.headers" || fail "sed could not apply the plan's mask to $to.dateless (status $?)"
    rm -f "$to.lf" "$to.dateless"
}
# The comparison runs in a subshell of its own, a command substitution, which closes descriptors 5
# and 6 before it runs anything, so no command it runs (curl, mask.mjs, cmp, diff, sha256sum and
# the rest) holds the servers' inputs open, and a KILL of this shell while one of them stalls still
# stops both servers. Its output says how the answers compare: same, expected (they differ only as
# the plan's expected difference says) or differ. A failure in it says why and ends it with the
# failing status, which ends this shell with that status too (set -e).
compare() {
    answer $aport "$ans/A"
    answer $aport "$ans/A-again"
    answer $bport "$ans/B"
    for f in "$ans/A.headers" "$ans/B.headers"; do
        head -1 "$f" | grep -q "^HTTP/[0-9.]* $status " || fail "$(head -1 "$f") in $f, not status $status"
    done
    node "$KIT/mask.mjs" stated "$MASK_JSON" "$ans/A.raw-headers" "$ans/A-again.raw-headers" "$ans/B.raw-headers" || fail "a masked header is not within the range the plan states"
    cmp -s "$ans/A.headers" "$ans/A-again.headers" || fail "two answers of A differ in their headers after the mask: $ans/A*.headers"
    cmp -s "$ans/A.body" "$ans/A-again.body" || fail "two answers of A differ in their bodies: $ans/A*.body"
    # The headers' difference is diff's own output, taken in memory (a command substitution, with an
    # x after it so no trailing newline is lost), not read back from a file: a diff.txt that held
    # part of what diff printed (one hunk of two, say), or anything else, could otherwise stand for
    # it. diff and cmp say 0 for the same, 1 for different and 2 for trouble, and diff's output must
    # agree with what it said. (curl refuses a header with a NUL byte, which a shell variable cannot hold.)
    hst=0; hdiff=$(s=0; diff "$ans/A.headers" "$ans/B.headers" || s=$?; printf x; exit $s) || hst=$?
    [ $hst -le 1 ] || fail "diff could not compare the two answers' headers (status $hst)"
    hdiff=${hdiff%x}
    if [ $hst = 1 ]; then
        [ -n "$hdiff" ] || fail "diff reported that the two answers' headers differ and printed no difference: missing evidence"
    else
        [ -z "$hdiff" ] || fail "diff reported that the two answers' headers are the same and printed a difference"
    fi
    na=$(wc -c <"$ans/A.body"); nb=$(wc -c <"$ans/B.body")
    da=$(sha256sum <"$ans/A.body"); da=${da%% *}; db=$(sha256sum <"$ans/B.body"); db=${db%% *}
    bst=0; cmp -s "$ans/A.body" "$ans/B.body" || bst=$?
    # cmp reads the bodies again after their sizes and SHA-256s were taken: the two must agree, or
    # a body changed between the reads and the bodies line would name what cmp did not compare.
    case $bst in
        0) [ "$na" = "$nb" ] && [ "$da" = "$db" ] || fail "cmp found the two answers' bodies the same, though their sizes or SHA-256s, read before it, differ: a body changed between the reads"
           line="bodies same: $na bytes, sha256 $da" ;;
        1) [ "$na" != "$nb" ] || [ "$da" != "$db" ] || fail "cmp found the two answers' bodies different, though their sizes and SHA-256s, read before it, are the same: a body changed between the reads"
           line="bodies differ: $na and $nb bytes, sha256 $da and $db" ;;
        *) fail "cmp could not compare the two answers' bodies (status $bst)" ;;
    esac
    # The difference: diff's output and then the bodies line (so an expected one names the bodies as
    # well), or nothing when neither diff nor cmp reported one. This text alone is what EXPECT is
    # compared with, and the same bytes are what diff.txt is written with, once; diff.txt is not read.
    if [ $hst = 1 ] || [ $bst = 1 ]; then
        text="$hdiff$line
"
    else
        text=
    fi
    # answers/ is this check's own, made afresh above, so anything already at diff.txt is not one it
    # made: a link to the expected difference, say, which a write would truncate, or a file put there
    # while the answers were compared. It is refused, and diff.txt is created with noclobber (in a
    # subshell, so the option goes no further), which makes a new file and follows no link to a
    # regular one; printf, since a redirection that fails on the special builtin : would end the
    # shell without the reason.
    diffs=$ans/diff.txt
    [ ! -e "$diffs" ] && [ ! -L "$diffs" ] || fail "$diffs cannot be written as a new file: something is there before the check made it"
    (set -C; printf '%s' "$text" >"$diffs") || fail "$diffs cannot be written"
    echo "body $na bytes as received, sha256 $(printf %.16s "$da") A and $(printf %.16s "$db") B" >"$ans/bodies.txt"
    if [ -n "${EXPECT:-}" ]; then
        # The x after cat, as after diff, keeps its trailing newlines; a cat that fails prints none.
        want=$(cat "$EXPECT" && printf x) || fail "the plan's expected difference, $EXPECT, cannot be read"
        if [ "$text" != "${want%x}" ]; then
            { printf '%s' "$text" | diff "$EXPECT" - >&2; } || true
            fail "the answers differ other than as the plan's expected difference says"
        fi
        echo expected
    elif [ $hst != 0 ] || [ $bst != 0 ]; then
        printf '%s' "$text" >&2
        echo differ
    else
        echo same
    fi
}
outcome=$(set -e; exec 5>&- 6>&-; compare)
case $outcome in
    same) verdict="answers: same" ;;
    expected) verdict="answers: differ only as the plan's expected difference says" ;;
    differ)
        # A difference that is not expected is said only after a stop that passed: serve.mjs said both
        # servers ended and their ports refused a connection when checked, so the line and status 4
        # do not stand for answers compared on servers that were then left running.
        halt A B || fail "A and B's answers differ, and stopping their servers after the check failed or is unconfirmed: not read as a difference"
        echo "turns: $workload: A and B answer differently; both servers ended and nothing accepted on either port when checked" >&2
        exit 4
        ;;
    *) fail "the answers' comparison said neither same, expected nor differ: $outcome" ;;
esac

# Both stopped after the check, so neither holds memory while the other is measured. The verdict
# is published only once that stop has passed, as a difference is: a stop that fails leaves no
# verdict.txt, and no passing line, for answers compared on servers that were then left running.
halt A B || fail "stopping the two servers after their answers were compared failed or is unconfirmed: no verdict"
echo "$verdict" | tee "$ans/verdict.txt"
# A turn's output is read in a subshell that closes descriptors 5 and 6 first, as the comparison is.
# Each file is read once, into memory (with an x after it, so no trailing newline is lost): the raw
# log, the RESULT line and every counter, the check that it is reported once included, come from
# those same bytes, not from reads of a file that could differ between them.
record() { # writes the turn's perf and wrk output to the raw log, and its CSV row
    perfs=$(cat "$out/turn.perf" && printf x) || fail "perf's output for pair $pair_ $version_ cannot be read"; perfs=${perfs%x}
    wrks=$(cat "$out/turn.wrk" && printf x) || fail "wrk's output for pair $pair_ $version_ cannot be read"; wrks=${wrks%x}
    printf '## pair %s %s\n%s%s' "$pair_" "$version_" "$perfs" "$wrks" >>"$raw"
    res=$(printf '%s' "$wrks" | sed -n 's/^RESULT //p') || fail "wrk's output for pair $pair_ $version_ cannot be read for its RESULT line"
    set -- $res
    [ $# -eq 6 ] || fail "no RESULT line from wrk in pair $pair_ $version_"
    [ "$2$3$4$5$6" = 00000 ] || fail "errors in pair $pair_ $version_: requests $1, connect $2, read $3, write $4, status $5, timeout $6"
    requests=$1
    values=
    # The plan's events, split at their commas by the shell itself, with no pattern expanded.
    set -f; ifs=$IFS; IFS=,
    for ev in $events; do
        IFS=$ifs
        # perf names a cache event without its :u (L1-icache-load-misses), though it counts user
        # space only; a line names the event as asked or without the :u.
        sel='BEGIN { n = e; sub(/:u$/, "", n) } $3 == e || $3 == n'
        c=$(printf '%s' "$perfs" | awk -F, -v e="$ev" "$sel { c++ } END { print c + 0 }") || fail "awk could not read perf's output in pair $pair_ $version_"
        [ "$c" = 1 ] || fail "$ev not reported once in pair $pair_ $version_: $perfs"
        v=$(printf '%s' "$perfs" | awk -F, -v e="$ev" "$sel { print \$1 }")
        case "$v" in ''|0|*[!0-9]*) fail "unusable counter $ev in pair $pair_ $version_ (not a count above zero): $perfs";; esac
        pct=$(printf '%s' "$perfs" | awk -F, -v e="$ev" "$sel { print \$5 }")
        [ "$(awk -v p="$pct" 'BEGIN { print (p + 0 >= 100) }')" = 1 ] || fail "counter under 100% in pair $pair_ $version_: $ev $pct"
        values="$values,$v"
    done
    IFS=$ifs; set +f
    echo "$pair_,$version_,$requests$values" >>"$csv"
}
turn() { # <pair> <base|head>: A's turns are the CSV's base rows, B's its head rows
    if [ "$2" = base ]; then fresh A; pid=$a; port=$aport; else fresh B; pid=$b; port=$bport; fi
    perf stat -x, -e "$events" -p "$pid" -o "$out/turn.perf" -- sleep "$secs.4" 5>&- 6>&- &
    perfpid=$!
    sleep 0.1 5>&- 6>&-
    set --
    while IFS= read -r h; do [ -z "$h" ] || set -- "$@" -H "$h"; done <"$HEADERS"
    taskset -c "$load" wrk -t"$WRK_T" -c"$WRK_C" -d"${secs}s" "$@" -s "$SCRIPT" "http://127.0.0.1:$port$path" >"$out/turn.wrk" 5>&- 6>&-
    wait $perfpid
    (set -e; exec 5>&- 6>&-; record)
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
rm -f "$out/turn.perf" "$out/turn.wrk"
echo "$workload: done, $csv"
