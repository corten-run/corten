#!/bin/sh
# Paired cycles per request for two builds of one server, after corten-run/corten#1822's method:
# both builds started once and pinned to one CPU whose core has no other work; loaded in turn for
# three seconds each by wrk -t2 -c64 on two other CPUs; the order of the two turned about every
# pair; perf stat cycles:u, cycles:k and instructions:u of the server process over each turn,
# divided by the requests wrk saw answered. A turn with a wrk error or multiplexed counters stops
# the run. Before the first turn the two builds' answers are compared.
#
# Usage: run-pair.sh <out dir> <workload> <pairs> <server cpu> <load cpus> <path> <lua> <base cmd> <head cmd>
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
# Writes <out dir>/cycles-<workload>.csv, raw-<workload>.log (every turn's perf and wrk output),
# answers-<workload>/ and serve-<workload>-{base,head}.log.
set -eu
[ $# -eq 9 ] || { sed -n '2,25p' "$0"; exit 2; }
out=$1; workload=$2; pairs=$3; cpu=$4; load=$5; path=$6; lua=$7; basecmd=$8; headcmd=$9
status=${STATUS:-200}; warmup=${WARMUP:-1}; secs=${TURN:-3}; mask=${MASK:-/dev/null}
mkdir -p "$out"
csv=$out/cycles-$workload.csv; raw=$out/raw-$workload.log; ans=$out/answers-$workload
rm -rf "$ans"; mkdir -p "$ans"; : >"$raw"
fail() { echo "run-pair: $workload: $*" >&2; exit 1; }

start() { # <version> <port> <command>; the server's pid is then $!
    PORT=$2 taskset -c "$cpu" sh -c "exec $3" >/dev/null 2>"$out/serve-$workload-$1.log" &
}
bport=18081; hport=18082
for port in $bport $hport; do
    ! curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null || fail "something already answers on $port"
done
start base $bport "$basecmd"; base=$!
start head $hport "$headcmd"; head=$!
stop() { kill $base $head 2>/dev/null || true; wait $base $head 2>/dev/null || true; }
trap stop EXIT
trap 'exit 1' HUP INT PIPE TERM
for port in $bport $hport; do
    i=0
    until curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null; do
        i=$((i + 1)); [ $i -lt 100 ] || fail "nothing answers on $port"; sleep 0.1
    done
done
for pid in $base $head; do
    [ "$(taskset -cp "$pid" | sed 's/.*: //')" = "$cpu" ] || fail "pid $pid is not on cpu $cpu"
done

# The two builds answer the same: status, headers (but Date) and body, after MASK.
answer() { # <port> <check line>
    port=$1; line=$2
    eval "set -- $line"
    url=http://127.0.0.1:$port$1; shift
    curl -sS -i --max-time 10 "$@" "$url" </dev/null | tr -d '\r' | grep -iv '^date:' | sed -f "$mask"
}
checks=$ans/checks.txt
if [ -n "${CHECKS:-}" ]; then grep -v '^[[:space:]]*$' "$CHECKS" >"$checks"; else echo "$path" >"$checks"; fi
diffs=$ans/diff.txt; : >"$diffs"
n=0
while IFS= read -r line; do
    n=$((n + 1))
    answer $bport "$line" >"$ans/$n-base.txt"
    answer $bport "$line" >"$ans/$n-base-again.txt"
    answer $hport "$line" >"$ans/$n-head.txt"
    for f in "$ans/$n-base.txt" "$ans/$n-head.txt"; do
        head -1 "$f" | grep -q "^HTTP/[0-9.]* $status " || fail "check $n ($line): $(head -1 "$f") in $f"
    done
    cmp -s "$ans/$n-base.txt" "$ans/$n-base-again.txt" || fail "check $n ($line): two base answers differ after MASK: $ans/$n-base*.txt"
    echo "== check $n: $line" >>"$diffs"
    diff "$ans/$n-base.txt" "$ans/$n-head.txt" >>"$diffs" || true
done <"$checks"
if [ -n "${EXPECT:-}" ]; then
    cmp -s "$diffs" "$EXPECT" || { diff "$EXPECT" "$diffs" >&2 || true; fail "the answers differ other than as EXPECT says"; }
else
    [ "$(grep -vc '^== check' "$diffs" || true)" = 0 ] || { cat "$diffs" >&2; fail "base and head answer differently"; }
fi
echo "checked $n requests: $(if [ -n "${EXPECT:-}" ]; then echo "differ only as $EXPECT says"; else echo same; fi)" | tee "$ans/verdict.txt"

turn() { # <pair> <version>
    if [ "$2" = base ]; then pid=$base; port=$bport; else pid=$head; port=$hport; fi
    perf stat -x, -e cycles:u,cycles:k,instructions:u -p "$pid" -o "$out/turn.perf" -- sleep "$secs.4" &
    perfpid=$!
    sleep 0.1
    taskset -c "$load" wrk -t2 -c64 -d"${secs}s" -s "$lua" "http://127.0.0.1:$port$path" >"$out/turn.wrk"
    wait $perfpid
    { echo "## pair $1 $2"; cat "$out/turn.perf" "$out/turn.wrk"; } >>"$raw"
    set -- "$1" "$2" $(sed -n 's/^RESULT //p' "$out/turn.wrk")
    [ $# -eq 8 ] || fail "no RESULT line from wrk in pair $1 $2"
    [ "$4$5$6$7$8" = 00000 ] || fail "errors in pair $1 $2: $*"
    cu=$(awk -F, '$3 == "cycles:u" { print $1 }' "$out/turn.perf")
    ck=$(awk -F, '$3 == "cycles:k" { print $1 }' "$out/turn.perf")
    iu=$(awk -F, '$3 == "instructions:u" { print $1 }' "$out/turn.perf")
    case "$cu,$ck,$iu" in *[!0-9,]*|,*|*,,*|*,) fail "unusable counters in pair $1 $2: $(cat "$out/turn.perf")";; esac
    pct=$(awk -F, '$3 ~ /^(cycles|instructions)/ && $5 !~ /^100(\.0+)?$/ { print $3 " " $5 }' "$out/turn.perf")
    [ -z "$pct" ] || fail "multiplexed counters in pair $1 $2: $pct"
    echo "$1,$2,$3,$cu,$ck,$iu" >>"$csv"
}
echo "pair,version,requests,cycles_u,cycles_k,instructions_u" >"$csv"
w=1
while [ $w -le "$warmup" ]; do turn "w$w" base; turn "w$w" head; w=$((w + 1)); done
echo "pair,version,requests,cycles_u,cycles_k,instructions_u" >"$csv"
pair=1
while [ $pair -le "$pairs" ]; do
    if [ $((pair % 2)) = 1 ]; then turn $pair base; turn $pair head; else turn $pair head; turn $pair base; fi
    [ $((pair % 10)) != 0 ] || echo "$workload: pair $pair of $pairs done"
    pair=$((pair + 1))
done
rm -f "$out/turn.perf" "$out/turn.wrk"
echo "$workload: done, $csv"