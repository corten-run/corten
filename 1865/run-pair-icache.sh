#!/bin/sh
# run-pair-icache.sh: the run's diagnostic pass (results/margin.md), after the main pass:
# run-pair-fresh.sh's turns (each on a freshly started build, the order turned every pair, wrk on its
# own CPUs) with perf stat counting only L1-icache-load-misses:u and instructions:u of the server
# process, so neither is multiplexed and the main pass's three counters are left as they were. The
# main pass compared the two builds' answers on these binaries; this pass does not compare them
# again. A wrk error, a counter not counted or one not at 100% running stops it.
#
# Usage: run-pair-icache.sh <out dir> <workload> <pairs> <server cpu> <load cpus> <path> <lua> <base cmd> <head cmd>
#   as run-pair-fresh.sh. TURN (default 1) is the seconds of load a turn, WARMUP (default 0) the
#   unrecorded pairs first.
# Writes <out dir>/icache-<workload>.csv (pair,version,requests,icache_misses_u,instructions_u),
# raw-icache-<workload>.log (every turn's perf and wrk output) and serve-icache-<workload>-{base,head}.log.
set -eu
[ $# -eq 9 ] || { sed -n '2,15p' "$0"; exit 2; }
out=$1; workload=$2; pairs=$3; cpu=$4; load=$5; path=$6; lua=$7; basecmd=$8; headcmd=$9
warmup=${WARMUP:-0}; secs=${TURN:-1}
mkdir -p "$out"
csv=$out/icache-$workload.csv; raw=$out/raw-icache-$workload.log; : >"$raw"
fail() { echo "run-pair-icache: $workload: $*" >&2; exit 1; }
start() { # <version> <port> <command>; the server's pid is then $!
    PORT=$2 taskset -c "$cpu" sh -c "exec $3" >/dev/null 2>>"$out/serve-icache-$workload-$1.log" &
}
bport=18081; hport=18082
for port in $bport $hport; do
    ! curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null || fail "something already answers on $port"
done
: >"$out/serve-icache-$workload-base.log"; : >"$out/serve-icache-$workload-head.log"
pid=
stop() { [ -z "$pid" ] || { kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true; }; }
trap stop EXIT
trap 'exit 1' HUP INT PIPE TERM
ready() { # <port> <pid>
    i=0
    until curl -s -o /dev/null "http://127.0.0.1:$1/" </dev/null; do
        i=$((i + 1)); [ $i -lt 100 ] || fail "nothing answers on $1"; sleep 0.1
    done
    [ "$(taskset -cp "$2" | sed 's/.*: //')" = "$cpu" ] || fail "pid $2 is not on cpu $cpu"
}
turn() { # <pair> <version>
    if [ "$2" = base ]; then start base $bport "$basecmd"; port=$bport; else start head $hport "$headcmd"; port=$hport; fi
    pid=$!
    ready $port $pid
    perf stat -x, -e L1-icache-load-misses:u,instructions:u -p "$pid" -o "$out/turn.perf" -- sleep "$secs.4" &
    perfpid=$!
    sleep 0.1
    taskset -c "$load" wrk -t2 -c64 -d"${secs}s" -s "$lua" "http://127.0.0.1:$port$path" >"$out/turn.wrk"
    wait $perfpid
    { echo "## pair $1 $2"; cat "$out/turn.perf" "$out/turn.wrk"; } >>"$raw"
    set -- "$1" "$2" $(sed -n 's/^RESULT //p' "$out/turn.wrk")
    [ $# -eq 8 ] || fail "no RESULT line from wrk in pair $1 $2"
    [ "$4$5$6$7$8" = 00000 ] || fail "errors in pair $1 $2: $*"
    im=$(awk -F, '$3 == "L1-icache-load-misses:u" { print $1 }' "$out/turn.perf")
    iu=$(awk -F, '$3 == "instructions:u" { print $1 }' "$out/turn.perf")
    case "$im,$iu" in *[!0-9,]*|,*|*,) fail "unusable counters in pair $1 $2: $(cat "$out/turn.perf")";; esac
    pct=$(awk -F, '$3 ~ /^(L1-icache|instructions)/ && $5 + 0 < 100 { print $3 " " $5 }' "$out/turn.perf")
    [ -z "$pct" ] || fail "multiplexed counters in pair $1 $2: $pct"
    echo "$1,$2,$3,$im,$iu" >>"$csv"
    kill $pid; wait $pid 2>/dev/null || true; pid=
}
echo "pair,version,requests,icache_misses_u,instructions_u" >"$csv"
w=1
while [ $w -le "$warmup" ]; do turn "w$w" base; turn "w$w" head; w=$((w + 1)); done
echo "pair,version,requests,icache_misses_u,instructions_u" >"$csv"
pair=1
while [ $pair -le "$pairs" ]; do
    if [ $((pair % 2)) = 1 ]; then turn $pair base; turn $pair head; else turn $pair head; turn $pair base; fi
    [ $((pair % 10)) != 0 ] || echo "icache $workload: pair $pair of $pairs done"
    pair=$((pair + 1))
done
rm -f "$out/turn.perf" "$out/turn.wrk"
echo "icache $workload: done, $csv"
