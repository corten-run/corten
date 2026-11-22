#!/bin/sh
# run-pair.sh: one paired comparison for corten-run/corten#1824's kit (1824b). The 1846r kit's
# run-pair-fresh.sh, with what this kit adds: page faults and resident memory a turn, and a check
# after every turn that the build kept, or did not keep, what its configuration says.
#
# Every turn is on a freshly started server (A or B), pinned to SERVER_CPU, waited for, measured
# and stopped, so each starts with an empty store; the order turns every pair (A first in odd
# pairs). wrk -t2 -c64 loads it for TURN seconds from LOAD_CPUS. perf stat counts the server
# process over the turn: cycles:u, cycles:k, instructions:u (hardware counters, each required at
# 100% running, else the run stops) and page-faults and minor-faults (software events; a fault
# the kernel takes for madvise(MADV_POPULATE_WRITE) is in /proc's minflt and not in these). From
# /proc, before the load (after the server answers) and after it: minflt, VmRSS, and at the end
# VmHWM and AnonHugePages (smaps_rollup), so resident memory a request is (end - before) / requests.
#
# Before the first turn A and B are each started once and asked every line of CHECKS (curl, Date
# dropped, MASK applied): A twice and B once; A's two answers must be the same, and A and B must be
# the same (no EXPECT here: no comparison in this kit changes an answer). After each turn's
# counts, before it is stopped, the server is asked as AFTER_A or AFTER_B says, and the run stops
# unless the answer is a 200 of the bytes CHECKS' first answer had and:
#   kept-new    a URL not asked before (<path>?after=<n>), then again: the second has an Age
#   unkept-new  the same, and the second has none (the store is off)
#   kept        <path> has an Age
#   unkept      <path> has none
# A wrk error of any kind (connect, read, write, status, timeout) stops the run: the CSV's errors
# column is their count, 0 in every turn that is recorded.
#
# Usage: run-pair.sh <out dir> <name> <pairs> <path> <lua> <A cmd> <B cmd>
#   <A cmd>, <B cmd>  a command serving HTTP on 127.0.0.1:$PORT; single-quote it so $PORT stays
#                     literal: 'env MALLOC_CONF=... /m/1824b/bin/main $PORT room'
#   <lua>             a wrk script whose done() prints
#                     "RESULT <requests> <connect> <read> <write> <status> <timeout>"
# Environment: AFTER_A, AFTER_B (required); CHECKS (file, one "<path> [curl arguments]" a line;
# default <path>), MASK (sed script, default none), WARMUP (unrecorded pairs first, default 1),
# TURN (seconds, default 3), SERVER_CPU (2), LOAD_CPUS (4,5), PERF (0 runs the turns without perf,
# for a container without counters: not a measurement, the counter columns are empty).
# Writes <out dir>/pairs-<name>.csv (pair,version,requests,cycles_u,cycles_k,instructions_u,
# page_faults,minor_faults,minflt,rss_idle_kb,rss_end_kb,hwm_kb,anon_huge_kb,errors; version is
# base for A and head for B), raw-<name>.log (every turn's perf and wrk output), answers-<name>/ and
# serve-<name>-{base,head}.log.
set -eu
[ $# -eq 7 ] || { sed -n '2,37p' "$0"; exit 2; }
out=$1; name=$2; pairs=$3; path=$4; lua=$5; acmd=$6; bcmd=$7
after_a=${AFTER_A:?}; after_b=${AFTER_B:?}
warmup=${WARMUP:-1}; secs=${TURN:-3}; mask=${MASK:-/dev/null}; perf=${PERF:-1}
cpu=${SERVER_CPU:-2}; load=${LOAD_CPUS:-4,5}
events=cycles:u,cycles:k,instructions:u,page-faults,minor-faults
mkdir -p "$out"
csv=$out/pairs-$name.csv; raw=$out/raw-$name.log; ans=$out/answers-$name
rm -rf "$ans"; mkdir -p "$ans"; : >"$raw"
fail() { echo "run-pair: $name: $*" >&2; exit 1; }

start() { # <version> <port> <command>; the server's pid is then $!
    PORT=$2 taskset -c "$cpu" sh -c "exec $3" >/dev/null 2>>"$out/serve-$name-$1.log" &
}
bport=18081; hport=18082
for port in $bport $hport; do
    ! curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null || fail "something already answers on $port"
done
: >"$out/serve-$name-base.log"; : >"$out/serve-$name-head.log"
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
        start base $bport "$acmd"; base=$!; ready $bport $base
    else
        [ -z "$head" ] || { kill $head; wait $head 2>/dev/null || true; }
        start head $hport "$bcmd"; head=$!; ready $hport $head
    fi
}
fresh base; fresh head

# A and B answer the same: status, headers (but Date) and body, after MASK.
answer() { # <port> <check line>
    port=$1; line=$2
    eval "set -- $line"
    url=http://127.0.0.1:$port$1; shift
    curl -sS -i --max-time 10 "$@" "$url" </dev/null | tr -d '\r' | grep -iv '^date:' | sed -f "$mask"
}
checks=$ans/checks.txt
if [ -n "${CHECKS:-}" ]; then grep -v '^[[:space:]]*$' "$CHECKS" >"$checks"; else echo "$path" >"$checks"; fi
n=0
while IFS= read -r line; do
    n=$((n + 1))
    answer $bport "$line" >"$ans/$n-base.txt"
    answer $bport "$line" >"$ans/$n-base-again.txt"
    answer $hport "$line" >"$ans/$n-head.txt"
    for f in "$ans/$n-base.txt" "$ans/$n-head.txt"; do
        head -1 "$f" | grep -q "^HTTP/[0-9.]* 200 " || fail "check $n ($line): $(head -1 "$f") in $f"
    done
    cmp -s "$ans/$n-base.txt" "$ans/$n-base-again.txt" || fail "check $n ($line): two A answers differ after MASK: $ans/$n-base*.txt"
    cmp -s "$ans/$n-base.txt" "$ans/$n-head.txt" || { diff "$ans/$n-base.txt" "$ans/$n-head.txt" >&2 || true; fail "check $n ($line): A and B answer differently"; }
done <"$checks"
bytes=$(sed -n 's/^content-length: \([0-9]*\)$/\1/p' "$ans/1-base.txt")
[ -n "$bytes" ] || fail "check 1 has no content-length"
echo "checked $n requests: A twice and B the same; $bytes bytes" | tee "$ans/verdict.txt"
kill $base $head; wait $base $head 2>/dev/null || true; base=; head=

# The answer to <path> on <port>: "<status> <bytes> <aged>", aged 1 when it has an Age.
ask() { # <port> <path>
    ask_s=$(curl -sS --max-time 5 -o /dev/null -D "$out/after.head" -w '%{http_code} %{size_download}' "http://127.0.0.1:$1$2" </dev/null) || ask_s="000 0"
    if tr -d '\r' <"$out/after.head" | grep -qi '^age: [0-9]*$'; then echo "$ask_s 1"; else echo "$ask_s 0"; fi
}
after() { # <kind> <port> <pair>: the check after a turn
    case $1 in
        kept-new|unkept-new)
            u="$path?after=$3-$(date +%s%N)"; first=$(ask $2 "$u"); second=$(ask $2 "$u")
            want="200 $bytes 0 / 200 $bytes $([ "$1" = kept-new ] && echo 1 || echo 0)" ;;
        kept|unkept)
            first=$(ask $2 "$path"); second=$first
            want="200 $bytes $([ "$1" = kept ] && echo 1 || echo 0) / 200 $bytes $([ "$1" = kept ] && echo 1 || echo 0)" ;;
        *) fail "unknown AFTER kind $1" ;;
    esac
    [ "$first / $second" = "$want" ] || fail "after pair $3 ($1 on $2): got $first / $second, want $want"
}
procs() { # <pid>: "minflt rss_kb"
    echo "$(sed 's/.*) //' /proc/$1/stat | cut -d' ' -f8) $(awk '/^VmRSS:/ { print $2 }' /proc/$1/status)"
}
turn() { # <pair> <version>
    fresh "$2"
    if [ "$2" = base ]; then pid=$base; port=$bport; kind=$after_a; else pid=$head; port=$hport; kind=$after_b; fi
    set -- "$1" "$2" $(procs $pid)
    if [ "$perf" = 1 ]; then
        perf stat -x, -e "$events" -p "$pid" -o "$out/turn.perf" -- sleep "$secs.4" &
    else
        echo "(no perf)" >"$out/turn.perf"; sleep "$secs.4" &
    fi
    perfpid=$!
    sleep 0.1
    taskset -c "$load" wrk -t2 -c64 -d"${secs}s" -s "$lua" "http://127.0.0.1:$port$path" >"$out/turn.wrk"
    wait $perfpid
    set -- "$@" $(procs $pid) "$(awk '/^VmHWM:/ { print $2 }' /proc/$pid/status)" "$(awk '/^AnonHugePages:/ { print $2 }' /proc/$pid/smaps_rollup)"
    { echo "## pair $1 $2"; cat "$out/turn.perf" "$out/turn.wrk"; } >>"$raw"
    after "$kind" $port "$1"
    # $1 pair, $2 version, $3 minflt before, $4 rss before, $5 minflt after, $6 rss after, $7 hwm, $8 anon huge
    result=$(sed -n 's/^RESULT //p' "$out/turn.wrk")
    [ -n "$result" ] || fail "no RESULT line from wrk in pair $1 $2"
    requests=${result%% *}; errs=$(echo "$result" | awk '{ print $2 + $3 + $4 + $5 + $6 }')
    [ "$errs" = 0 ] || fail "wrk errors in pair $1 $2: $result"
    values=
    for ev in $(echo "$events" | tr ',' ' '); do
        if [ "$perf" != 1 ]; then values="$values,"; continue; fi
        sel='BEGIN { n = e; sub(/:u$/, "", n) } $3 == e || $3 == n'
        [ "$(awk -F, -v e="$ev" "$sel" "$out/turn.perf" | wc -l)" = 1 ] || fail "$ev not reported once in pair $1 $2: $(cat "$out/turn.perf")"
        v=$(awk -F, -v e="$ev" "$sel { print \$1 }" "$out/turn.perf")
        case "$v" in ''|*[!0-9]*) fail "unusable counter $ev in pair $1 $2: $(cat "$out/turn.perf")";; esac
        pct=$(awk -F, -v e="$ev" "$sel { print \$5 }" "$out/turn.perf")
        [ "$(awk -v p="$pct" 'BEGIN { print (p + 0 >= 100) }')" = 1 ] || fail "multiplexed counter in pair $1 $2: $ev $pct"
        values="$values,$v"
    done
    echo "$1,$2,$requests$values,$(($5 - $3)),$4,$6,$7,${8:-0},$errs" >>"$csv"
    kill $pid; wait $pid 2>/dev/null || true
    if [ "$2" = base ]; then base=; else head=; fi
}
header=pair,version,requests,cycles_u,cycles_k,instructions_u,page_faults,minor_faults,minflt,rss_idle_kb,rss_end_kb,hwm_kb,anon_huge_kb,errors
echo "$header" >"$csv"
t0=$(date +%s)
w=1
while [ $w -le "$warmup" ]; do turn "w$w" base; turn "w$w" head; w=$((w + 1)); done
if [ "$warmup" -gt 0 ] && [ "$pairs" -gt 0 ]; then
    each=$(( ($(date +%s) - t0) / warmup ))
    echo "$name: the warm-up took about $each s a pair; $pairs pairs should take about $(( each * pairs / 60 + 1 )) minutes"
fi
echo "$header" >"$csv"
pair=1
while [ $pair -le "$pairs" ]; do
    if [ $((pair % 2)) = 1 ]; then turn $pair base; turn $pair head; else turn $pair head; turn $pair base; fi
    [ $((pair % 10)) != 0 ] || echo "$name: pair $pair of $pairs done $(date -u +%T)"
    pair=$((pair + 1))
done
rm -f "$out/turn.perf" "$out/turn.wrk" "$out/after.head"
echo "$name: done, $csv"