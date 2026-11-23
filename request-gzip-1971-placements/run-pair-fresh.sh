#!/bin/sh
# run-pair.sh, with each turn on a fresh process: before its turn a build is started (pinned as
# run-pair.sh pins it), waited for, measured, and stopped after it, so every turn starts with an
# empty store. For a workload that fills what the process keeps (corten-run/corten#1866's new URLs:
# a store that held every page of a run would need about 200 GB) and must not be measured filled.
# The answers are compared as run-pair.sh does, on a first start of each build; the method is
# otherwise run-pair.sh's (order turned every pair, perf of the server process over the turn, wrk
# on its own CPUs). What a fresh process adds (its first requests' faults and lazily made state)
# is in every turn of both builds.
#
# Usage: run-pair-fresh.sh <out dir> <workload> <pairs> <server cpu> <load cpus> <path> <lua> <base cmd> <head cmd>
#   <base cmd>, <head cmd>  a command serving HTTP on 127.0.0.1:$PORT, run under taskset -c <server cpu>;
#                          single-quote it so $PORT stays literal: '/m/1816/bin/base $PORT'
#   <lua>                  a wrk script whose done() prints
#                          "RESULT <requests> <connect> <read> <write> <status> <timeout>" (see lua/get.lua)
# Environment (all optional):
#   CHECKS  file, one request per line: "<path> [curl arguments]", compared before the run
#           (default: GET <path>)
#   MASK    sed script applied to every checked answer (a value drawn per request or per process);
#           two answers of the base build must agree after it, so nothing else may vary
#   EXPECT  file holding the exact diff of the masked answers that the change makes by design
#           (default: none, base and head must answer the same)
#   STATUS  the status every checked answer must have (default 200)
#   WARMUP  unrecorded pairs before the recorded ones (default 1)
#   TURN    seconds of load in a turn (default 3)
#   EVENTS  the perf events counted over each turn, comma-separated (default
#           cycles:u,cycles:k,instructions:u); every one must be counted, numeric and running
#           100% of the turn (no multiplexing). With the default the CSV is cycles-<workload>.csv,
#           columns cycles_u,cycles_k,instructions_u; otherwise counts-<workload>.csv, a column per
#           event (its name with every character but letters and digits turned to _).
#           (corten-run/corten#1923's copy; the rest is D:\Temp\cycles\run-pair-fresh.sh unchanged.)
# Writes <out dir>/cycles-<workload>.csv, raw-<workload>.log (every turn's perf and wrk output),
# answers-<workload>/ and serve-<workload>-{base,head}.log.
set -eu
[ $# -eq 9 ] || { sed -n '2,33p' "$0"; exit 2; }
out=$1; workload=$2; pairs=$3; cpu=$4; load=$5; path=$6; lua=$7; basecmd=$8; headcmd=$9
status=${STATUS:-200}; warmup=${WARMUP:-1}; secs=${TURN:-3}; mask=${MASK:-/dev/null}
events=${EVENTS:-cycles:u,cycles:k,instructions:u}
columns=$(echo "$events" | tr ',' '\n' | sed 's/[^A-Za-z0-9]/_/g' | paste -sd, -)
if [ "$events" = cycles:u,cycles:k,instructions:u ]; then kind=cycles; else kind=counts; fi
mkdir -p "$out"
csv=$out/$kind-$workload.csv; raw=$out/raw-$workload.log; ans=$out/answers-$workload
rm -rf "$ans"; mkdir -p "$ans"; : >"$raw"
fail() { echo "run-pair: $workload: $*" >&2; exit 1; }

start() { # <version> <port> <command>; the server's pid is then $!
    PORT=$2 taskset -c "$cpu" sh -c "exec $3" >/dev/null 2>>"$out/serve-$workload-$1.log" &
}
bport=18081; hport=18082
for port in $bport $hport; do
    ! curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null || fail "something already answers on $port"
done
: >"$out/serve-$workload-base.log"; : >"$out/serve-$workload-head.log"
base=; head=
stop() { kill $base $head 2>/dev/null || true; wait $base $head 2>/dev/null || true; }
trap stop EXIT
trap 'exit 1' HUP INT PIPE TERM
ready() { # <port> <pid>
    i=0
    until curl -s -o /dev/null "http://127.0.0.1:$1/" </dev/null; do
        i=$((i + 1)); [ $i -lt 100 ] || fail "nothing answers on $1"; sleep 0.1
    done
    [ "$(taskset -cp "$2" | sed 's/.*: //')" = "$cpu" ] || fail "pid $2 is not on cpu $cpu"
}
fresh() { # <version>: (re)starts that build; its pid is then in $base or $head
    if [ "$1" = base ]; then
        [ -z "$base" ] || { kill $base; wait $base 2>/dev/null || true; }
        start base $bport "$basecmd"; base=$!; ready $bport $base
    else
        [ -z "$head" ] || { kill $head; wait $head 2>/dev/null || true; }
        start head $hport "$headcmd"; head=$!; ready $hport $head
    fi
}
fresh base; fresh head

# The two builds answer the same: status and headers but Date, after MASK, and the body as
# received, byte for byte. (Kit 1971's change to kit 1923's script: MASK is applied to the header
# lines only and never to the body, which is saved and compared raw, as Pull requests now asks.)
answer() { # <port> <check line> <out prefix>: writes <prefix>.headers (masked) and <prefix>.body (raw)
    port=$1; line=$2; to=$3
    eval "set -- $line"
    url=http://127.0.0.1:$port$1; shift
    curl -sS --max-time 10 -D "$to.raw-headers" -o "$to.body" "$@" "$url" </dev/null
    tr -d '\r' <"$to.raw-headers" | grep -iv '^date:' | sed -f "$mask" >"$to.headers"
}
checks=$ans/checks.txt
if [ -n "${CHECKS:-}" ]; then grep -v '^[[:space:]]*$' "$CHECKS" >"$checks"; else echo "$path" >"$checks"; fi
diffs=$ans/diff.txt; : >"$diffs"
n=0
while IFS= read -r line; do
    n=$((n + 1))
    answer $bport "$line" "$ans/$n-base"
    answer $bport "$line" "$ans/$n-base-again"
    answer $hport "$line" "$ans/$n-head"
    for f in "$ans/$n-base.headers" "$ans/$n-head.headers"; do
        head -1 "$f" | grep -q "^HTTP/[0-9.]* $status " || fail "check $n ($line): $(head -1 "$f") in $f"
    done
    [ -s "$ans/$n-base.body" ] || fail "check $n ($line): an empty body"
    cmp -s "$ans/$n-base.headers" "$ans/$n-base-again.headers" || fail "check $n ($line): two base answers' headers differ after MASK: $ans/$n-base*.headers"
    cmp -s "$ans/$n-base.body" "$ans/$n-base-again.body" || fail "check $n ($line): two base answers' bodies differ: $ans/$n-base*.body"
    echo "== check $n: $line" >>"$diffs"
    diff "$ans/$n-base.headers" "$ans/$n-head.headers" >>"$diffs" || true
    cmp -s "$ans/$n-base.body" "$ans/$n-head.body" || echo "bodies differ: $(wc -c <"$ans/$n-base.body") and $(wc -c <"$ans/$n-head.body") bytes" >>"$diffs"
    echo "check $n ($line): body $(wc -c <"$ans/$n-base.body") bytes as received, sha256 $(sha256sum "$ans/$n-base.body" | cut -c1-16) base and $(sha256sum "$ans/$n-head.body" | cut -c1-16) head" >>"$ans/bodies.txt"
done <"$checks"
if [ -n "${EXPECT:-}" ]; then
    cmp -s "$diffs" "$EXPECT" || { diff "$EXPECT" "$diffs" >&2 || true; fail "the answers differ other than as EXPECT says"; }
else
    [ "$(grep -vc '^== check' "$diffs" || true)" = 0 ] || { cat "$diffs" >&2; fail "base and head answer differently"; }
fi
echo "checked $n requests: $(if [ -n "${EXPECT:-}" ]; then echo "differ only as $EXPECT says"; else echo same; fi)" | tee "$ans/verdict.txt"

# Both builds stopped after the check, so neither holds memory while the other is measured.
kill $base $head; wait $base $head 2>/dev/null || true; base=; head=
turn() { # <pair> <version>
    fresh "$2"
    if [ "$2" = base ]; then pid=$base; port=$bport; else pid=$head; port=$hport; fi
    perf stat -x, -e "$events" -p "$pid" -o "$out/turn.perf" -- sleep "$secs.4" &
    perfpid=$!
    sleep 0.1
    taskset -c "$load" wrk -t2 -c64 -d"${secs}s" -s "$lua" "http://127.0.0.1:$port$path" >"$out/turn.wrk"
    wait $perfpid
    { echo "## pair $1 $2"; cat "$out/turn.perf" "$out/turn.wrk"; } >>"$raw"
    set -- "$1" "$2" $(sed -n 's/^RESULT //p' "$out/turn.wrk")
    [ $# -eq 8 ] || fail "no RESULT line from wrk in pair $1 $2"
    [ "$4$5$6$7$8" = 00000 ] || fail "errors in pair $1 $2: $*"
    values=
    for ev in $(echo "$events" | tr ',' ' '); do
        # perf names a cache event without its :u (L1-icache-load-misses), though it counts user
        # space only; a line names the event as asked or without the :u.
        sel='BEGIN { n = e; sub(/:u$/, "", n) } $3 == e || $3 == n'
        [ "$(awk -F, -v e="$ev" "$sel" "$out/turn.perf" | wc -l)" = 1 ] || fail "$ev not reported once in pair $1 $2: $(cat "$out/turn.perf")"
        v=$(awk -F, -v e="$ev" "$sel { print \$1 }" "$out/turn.perf")
        case "$v" in ''|*[!0-9]*) fail "unusable counter $ev in pair $1 $2: $(cat "$out/turn.perf")";; esac
        pct=$(awk -F, -v e="$ev" "$sel { print \$5 }" "$out/turn.perf")
        [ "$(awk -v p="$pct" 'BEGIN { print (p + 0 >= 100) }')" = 1 ] || fail "multiplexed counter in pair $1 $2: $ev $pct"
        values="$values,$v"
    done
    echo "$1,$2,$3$values" >>"$csv"
    kill $pid; wait $pid 2>/dev/null || true
    if [ "$2" = base ]; then base=; else head=; fi
}
echo "pair,version,requests,$columns" >"$csv"
w=1
while [ $w -le "$warmup" ]; do turn "w$w" base; turn "w$w" head; w=$((w + 1)); done
echo "pair,version,requests,$columns" >"$csv"
pair=1
while [ $pair -le "$pairs" ]; do
    if [ $((pair % 2)) = 1 ]; then turn $pair base; turn $pair head; else turn $pair head; turn $pair base; fi
    [ $((pair % 10)) != 0 ] || echo "$workload: pair $pair of $pairs done"
    pair=$((pair + 1))
done
rm -f "$out/turn.perf" "$out/turn.wrk"
echo "$workload: done, $csv"