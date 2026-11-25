#!/bin/sh
# turns.sh: one placement of a comparison, two binaries A and B: their answers to the workload's
# request compared, then one unrecorded pair of turns and the recorded pairs, every turn on a
# freshly started binary (started, pinned, waited for, measured and stopped), the order of the two
# turned every pair. The CSV's rows name A "base" and B "head", whichever binaries they are.
#
# Usage: turns.sh <out dir> <workload> <pairs> <binary A> <binary B>
# Environment, all of it the work directory's plan (run.sh and verify.sh set it):
#   KIT         this directory
#   START       the command that serves HTTP on 127.0.0.1:$PORT from $BIN, run under taskset
#   REQ_PATH    the request's path; HEADERS, a file of its header lines, one a line
#   SCRIPT      the wrk script, whose done() prints
#               "RESULT <requests> <connect> <read> <write> <status> <timeout>" (get.lua)
#   MASK        the sed script that masks the header values the plan names; MASK_JSON, the plan's
#               mask, for the values it states (mask.mjs)
#   STATUS      the status every compared answer must have
#   EXPECT      empty, or a file holding the exact text of answers/diff.txt that the change makes
#               by design; without it A and B must answer the same
#   WARMUP      unrecorded pairs before the recorded ones
#   TURN        seconds of load in a turn; WRK_T and WRK_C, wrk's threads and connections
#   CPU_SERVER  the CPU every server is pinned to; CPU_LOAD, wrk's CPUs
#   EVENTS      the perf events counted over each turn; every one must be counted once, numeric
#               and running 100% of the turn
# A compared answer is the status line, every header line but Date after MASK, and the body as
# received, byte for byte. A turn in which wrk reports an error of any kind, or a counter is
# missing, not a number or under 100%, fails the placement and records nothing.
# Writes <out dir>/counts-<workload>.csv (pair,version,requests and a column per event),
# raw-<workload>.log (every turn's perf and wrk output), answers/ and serve-{A,B}.log.
set -eu
[ $# -eq 5 ] || { sed -n '2,26p' "$0"; exit 2; }
out=$1; workload=$2; pairs=$3; abin=$4; bbin=$5
status=$STATUS; warmup=$WARMUP; secs=$TURN; mask=$MASK; events=$EVENTS; cpu=$CPU_SERVER; load=$CPU_LOAD; path=$REQ_PATH
columns=$(echo "$events" | tr ',' '\n' | sed 's/[^A-Za-z0-9]/_/g' | paste -sd, -)
mkdir -p "$out"
csv=$out/counts-$workload.csv; raw=$out/raw-$workload.log; ans=$out/answers
rm -rf "$ans"; mkdir -p "$ans"; : >"$raw"
fail() { echo "turns: $workload: $*" >&2; exit 1; }

start() { # <A|B> <port> <binary>; the server's pid is then $!
    PORT=$2 BIN=$3 taskset -c "$cpu" sh -c "exec $START" >/dev/null 2>>"$out/serve-$1.log" &
}
aport=18081; bport=18082
for port in $aport $bport; do
    ! curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null || fail "something already answers on $port"
done
: >"$out/serve-A.log"; : >"$out/serve-B.log"
a=; b=
stop() { kill $a $b 2>/dev/null || true; wait $a $b 2>/dev/null || true; }
trap stop EXIT
trap 'exit 1' HUP INT PIPE TERM
ready() { # <port> <pid>
    i=0
    until curl -s -o /dev/null "http://127.0.0.1:$1/" </dev/null; do
        i=$((i + 1)); [ $i -lt 100 ] || fail "nothing answers on $1"; sleep 0.1
    done
    [ "$(taskset -cp "$2" | sed 's/.*: //')" = "$cpu" ] || fail "pid $2 is not on cpu $cpu"
}
fresh() { # <A|B>: (re)starts that binary; its pid is then in $a or $b
    if [ "$1" = A ]; then
        [ -z "$a" ] || { kill $a; wait $a 2>/dev/null || true; }
        start A $aport "$abin"; a=$!; ready $aport $a
    else
        [ -z "$b" ] || { kill $b; wait $b 2>/dev/null || true; }
        start B $bport "$bbin"; b=$!; ready $bport $b
    fi
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
    curl -sS --max-time 10 -D "$to.raw-headers" -o "$to.body" "$@" "http://127.0.0.1:$port$path" </dev/null
    tr -d '\r' <"$to.raw-headers" | grep -iv '^date:' | sed -f "$mask" >"$to.headers"
}
answer $aport "$ans/A"
answer $aport "$ans/A-again"
answer $bport "$ans/B"
for f in "$ans/A.headers" "$ans/B.headers"; do
    head -1 "$f" | grep -q "^HTTP/[0-9.]* $status " || fail "$(head -1 "$f") in $f, not status $status"
done
node "$KIT/mask.mjs" stated "$MASK_JSON" "$ans/A.raw-headers" "$ans/A-again.raw-headers" "$ans/B.raw-headers" || fail "a masked header is not what the plan states"
cmp -s "$ans/A.headers" "$ans/A-again.headers" || fail "two answers of A differ in their headers after the mask: $ans/A*.headers"
cmp -s "$ans/A.body" "$ans/A-again.body" || fail "two answers of A differ in their bodies: $ans/A*.body"
diffs=$ans/diff.txt
diff "$ans/A.headers" "$ans/B.headers" >"$diffs" || true
cmp -s "$ans/A.body" "$ans/B.body" || echo "bodies differ: $(wc -c <"$ans/A.body") and $(wc -c <"$ans/B.body") bytes" >>"$diffs"
echo "body $(wc -c <"$ans/A.body") bytes as received, sha256 $(sha256sum "$ans/A.body" | cut -c1-16) A and $(sha256sum "$ans/B.body" | cut -c1-16) B" >"$ans/bodies.txt"
if [ -n "${EXPECT:-}" ]; then
    cmp -s "$diffs" "$EXPECT" || { diff "$EXPECT" "$diffs" >&2 || true; fail "the answers differ other than as the plan's expected difference says"; }
    echo "answers: differ only as the plan's expected difference says" | tee "$ans/verdict.txt"
else
    [ ! -s "$diffs" ] || { cat "$diffs" >&2; fail "A and B answer differently"; }
    echo "answers: same" | tee "$ans/verdict.txt"
fi

# Both stopped after the check, so neither holds memory while the other is measured.
kill $a $b; wait $a $b 2>/dev/null || true; a=; b=
turn() { # <pair> <base|head>: A's turns are the CSV's base rows, B's its head rows
    if [ "$2" = base ]; then fresh A; pid=$a; port=$aport; else fresh B; pid=$b; port=$bport; fi
    perf stat -x, -e "$events" -p "$pid" -o "$out/turn.perf" -- sleep "$secs.4" &
    perfpid=$!
    sleep 0.1
    set --
    while IFS= read -r h; do [ -z "$h" ] || set -- "$@" -H "$h"; done <"$HEADERS"
    taskset -c "$load" wrk -t"$WRK_T" -c"$WRK_C" -d"${secs}s" "$@" -s "$SCRIPT" "http://127.0.0.1:$port$path" >"$out/turn.wrk"
    wait $perfpid
    { echo "## pair $pair_ $version_"; cat "$out/turn.perf" "$out/turn.wrk"; } >>"$raw"
    set -- $(sed -n 's/^RESULT //p' "$out/turn.wrk")
    [ $# -eq 6 ] || fail "no RESULT line from wrk in pair $pair_ $version_"
    [ "$2$3$4$5$6" = 00000 ] || fail "errors in pair $pair_ $version_: requests $1, connect $2, read $3, write $4, status $5, timeout $6"
    requests=$1
    values=
    for ev in $(echo "$events" | tr ',' ' '); do
        # perf names a cache event without its :u (L1-icache-load-misses), though it counts user
        # space only; a line names the event as asked or without the :u.
        sel='BEGIN { n = e; sub(/:u$/, "", n) } $3 == e || $3 == n'
        [ "$(awk -F, -v e="$ev" "$sel" "$out/turn.perf" | wc -l)" = 1 ] || fail "$ev not reported once in pair $pair_ $version_: $(cat "$out/turn.perf")"
        v=$(awk -F, -v e="$ev" "$sel { print \$1 }" "$out/turn.perf")
        case "$v" in ''|*[!0-9]*) fail "unusable counter $ev in pair $pair_ $version_: $(cat "$out/turn.perf")";; esac
        pct=$(awk -F, -v e="$ev" "$sel { print \$5 }" "$out/turn.perf")
        [ "$(awk -v p="$pct" 'BEGIN { print (p + 0 >= 100) }')" = 1 ] || fail "counter under 100% in pair $pair_ $version_: $ev $pct"
        values="$values,$v"
    done
    echo "$pair_,$version_,$requests$values" >>"$csv"
    kill $pid; wait $pid 2>/dev/null || true
    if [ "$version_" = base ]; then a=; else b=; fi
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
