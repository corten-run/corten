#!/bin/sh
# run-pair.sh <workload>: paired cycles per request for corten-run/corten#1938 (a write that names
# the page it changed, KeptAnswers::changed), one workload, both builds. Modeled on #1920's kit
# and ../run-pair-fresh.sh: every turn is on a freshly started build, so both builds' turns
# average over process starts and their layouts and every turn starts with the same store.
#
# Workloads (the probe's routes are in probe-*/src/main.rs):
#   named      POST /items/7/edit, app `page`: head's handler takes KeptAnswers and names /home;
#              base's takes nothing. The store has its counts by path (warmed), and /home is kept.
#   named-off  POST /items/7/edit, app `page-off` (kept_answers(0)): head's handler takes the
#              handle and finds no store, so its call does nothing; base's takes nothing.
#   write      POST /items/8/edit, app `page`: a write that names nothing, the same in both.
#   kept       GET /home, app `page`: the kept page given again.
#   plain      GET /items/8/edit, app `page`: a route that keeps nothing.
#
# A turn: start the build pinned to SERVER_CPU with jemalloc preloaded (as the template's
# Dockerfile runs an app), wait until it answers, warm it (app `page`: GET /home three times, the
# third must carry Age, so /home is kept and the counts by path exist), then perf stat counts the
# server process alone for exactly as long as wrk runs (perf stat -p <server> -- wrk ...):
# cycles:u, cycles:k, instructions:u, task-clock (software, how busy the server was) and, with
# ICACHE=1, L1-icache-load-misses:u as a diagnostic. wrk -t2 -c64 for TURN seconds on LOAD_CPUS.
# A counter below 100% running, a non-numeric counter, or any failed request (connect, read,
# write, timeout or a status other than 2xx/3xx, as wrk counts them) stops the run, after the
# turn's row (with its failures) is written. The order turns every pair (base first in odd pairs).
#
# Before the first turn, each build answers the workload's request on fresh starts, base twice:
# after the warm-up, the request's status line, headers but Date (Age's value masked to `age: *`),
# the body's length and sha256, then whether GET /home is still kept (`home after: kept`, `not
# kept`, or with no store `none kept`). The two base answers must be the same. Head must answer as
# base does, except in `named`, where the change makes exactly one difference by design: base's
# last line says `kept` and head's `not kept` (head's write dropped /home). Anything else stops.
#
# Environment (all optional):
#   OUT        results directory (default /m/1938/results)
#   PAIRS      recorded pairs (default 100); 0 checks the answers and runs the warm-up pairs only
#   WARMUP     unrecorded pairs before them (default 1)
#   TURN       seconds of load a turn (default 3)
#   SERVER_CPU (default 2), LOAD_CPUS (default 4,5)
#   ICACHE     1 to count L1-icache-load-misses:u too (run.sh sets it after a preflight)
#   PERF       0 to run the turns without perf (a container without counters); the counter
#              columns are then empty and the CSV is not a measurement
# Writes $OUT/cycles-<workload>.csv (pair,version,requests,cycles_u,cycles_k,instructions_u,
# icache_u,task_ms,failures,ms; summary.mjs reads it), raw-<workload>.log (every turn's perf and
# wrk output), answers-<workload>/ and serve-<workload>-{base,head}.log.
set -eu
P=/m/1938; bin=$P/bin
[ $# -eq 1 ] || { sed -n '2,45p' "$0"; exit 2; }
w=$1
case $w in
    named) config=page; method=POST; path=/items/7/edit; lua=$P/lua/post-same-origin.lua ;;
    named-off) config=page-off; method=POST; path=/items/7/edit; lua=$P/lua/post-same-origin.lua ;;
    write) config=page; method=POST; path=/items/8/edit; lua=$P/lua/post-same-origin.lua ;;
    kept) config=page; method=GET; path=/home; lua=$P/lua/get.lua ;;
    plain) config=page; method=GET; path=/items/8/edit; lua=$P/lua/get.lua ;;
    *) echo "unknown workload $w"; exit 2 ;;
esac
out=${OUT:-$P/results}; pairs=${PAIRS:-100}; warmup=${WARMUP:-1}; secs=${TURN:-3}
cpu=${SERVER_CPU:-2}; load=${LOAD_CPUS:-4,5}; icache=${ICACHE:-0}; perf=${PERF:-1}
events=cycles:u,cycles:k,instructions:u,task-clock
[ "$icache" != 1 ] || events=$events,L1-icache-load-misses:u
mkdir -p "$out"
csv=$out/cycles-$w.csv; raw=$out/raw-$w.log; ans=$out/answers-$w
rm -rf "$ans"; mkdir -p "$ans"; : >"$raw"
fail() { echo "run-pair: $w: $*" >&2; exit 1; }
for f in "$bin/base" "$bin/head" "$lua"; do [ -e "$f" ] || fail "no $f: run build.sh"; done
command -v wrk >/dev/null || fail "no wrk"

bport=18381; hport=18382
for port in $bport $hport; do
    ! curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null || fail "something already answers on $port"
done
: >"$out/serve-$w-base.log"; : >"$out/serve-$w-head.log"
base=; head=
stop() { kill $base $head 2>/dev/null || true; wait $base $head 2>/dev/null || true; }
trap stop EXIT
trap 'exit 1' HUP INT PIPE TERM
start() { # <version> <port>; the server's pid is then $! (taskset and env exec it)
    taskset -c "$cpu" env HOST=127.0.0.1 PORT="$2" LD_PRELOAD=libjemalloc.so.2 \
        MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc \
        "$bin/$1" "$config" >>"$out/serve-$w-$1.log" 2>&1 &
}
ready() { # <version> <port> <pid>
    tries=0
    until curl -s -o /dev/null "http://127.0.0.1:$2/items/8/edit" </dev/null; do
        tries=$((tries + 1)); [ $tries -lt 100 ] || fail "$1 does not answer on $2 (serve-$w-$1.log)"; sleep 0.1
    done
    [ "$(readlink "/proc/$3/exe")" = "$bin/$1" ] || fail "pid $3 is not $bin/$1"
    [ "$(taskset -cp "$3" | sed 's/.*: //')" = "$cpu" ] || fail "pid $3 is not on cpu $cpu"
}
aged() { # <port>: whether GET /home is given from the store (it carries Age)
    curl -sS -D - -o /dev/null --max-time 10 "http://127.0.0.1:$1/home" </dev/null | tr -d '\r' | grep -qi '^age:'
}
warm() { # <version> <port>: /home kept, and the counts by path made (app `page`)
    [ "$config" = page ] || return 0
    ! aged "$2" || fail "$1: /home carried Age on its first request"
    aged "$2" || true
    aged "$2" || fail "$1: /home was not kept after three requests"
}
fresh() { # <version>: (re)starts that build and warms it; its pid is then in $base or $head
    if [ "$1" = base ]; then
        [ -z "$base" ] || { kill $base; wait $base 2>/dev/null || true; }
        start base $bport; base=$!; ready base $bport $base; warm base $bport
    else
        [ -z "$head" ] || { kill $head; wait $head 2>/dev/null || true; }
        start head $hport; head=$!; ready head $hport $head; warm head $hport
    fi
}
answer() { # <port>: the workload's request answered, then whether /home is still kept
    url=http://127.0.0.1:$1$path
    if [ $method = POST ]; then
        curl -sS --max-time 10 -X POST -H 'sec-fetch-site: same-origin' -D "$ans/head.tmp" -o "$ans/body.tmp" "$url" </dev/null
    else
        curl -sS --max-time 10 -D "$ans/head.tmp" -o "$ans/body.tmp" "$url" </dev/null
    fi
    tr -d '\r' <"$ans/head.tmp" | grep -iv '^date:' | sed 's/^[Aa][Gg][Ee]:.*/age: */'
    echo "body $(wc -c <"$ans/body.tmp") bytes, sha256 $(sha256sum "$ans/body.tmp" | cut -c1-64)"
    if aged "$1"; then echo "home after: kept"
    elif [ "$config" = page ]; then echo "home after: not kept"
    else echo "home after: none kept"; fi
    rm -f "$ans/head.tmp" "$ans/body.tmp"
}

# The answers, before any turn, each on a fresh start.
fresh base; answer $bport >"$ans/base.txt"
fresh base; answer $bport >"$ans/base-again.txt"
fresh head; answer $hport >"$ans/head.txt"
kill $base $head 2>/dev/null || true; wait $base $head 2>/dev/null || true; base=; head=
head -1 "$ans/base.txt" | grep -q '^HTTP/1.1 200 ' || fail "base answered $(head -1 "$ans/base.txt")"
cmp -s "$ans/base.txt" "$ans/base-again.txt" || { diff "$ans/base.txt" "$ans/base-again.txt" >&2 || true; fail "two base answers differ"; }
if [ "$w" = named ]; then
    [ "$(tail -1 "$ans/base.txt")" = "home after: kept" ] || fail "base's write dropped /home: $(tail -1 "$ans/base.txt")"
    sed '$s/^home after: kept$/home after: not kept/' "$ans/base.txt" >"$ans/expected-head.txt"
else
    cp "$ans/base.txt" "$ans/expected-head.txt"
fi
cmp -s "$ans/expected-head.txt" "$ans/head.txt" || { diff "$ans/expected-head.txt" "$ans/head.txt" >&2 || true; fail "head answers other than as expected"; }
echo "checked $w: base twice the same; head $(if [ "$w" = named ]; then echo "the same but /home dropped by its write, by design"; else echo "the same"; fi): $(head -1 "$ans/base.txt"), $(grep '^body' "$ans/base.txt"), head's $(tail -1 "$ans/head.txt")" | tee "$ans/verdict.txt"

measure() { # <command...>: runs it; perf counts the server process ($pid) for exactly as long
    if [ "$perf" = 1 ]; then
        perf stat -x, -e "$events" -p "$pid" -o "$out/turn.perf" -- "$@"
    else
        echo "(no perf)" >"$out/turn.perf"
        "$@"
    fi
}
turn() { # <pair> <version>
    fresh "$2"
    if [ "$2" = base ]; then pid=$base; port=$bport; else pid=$head; port=$hport; fi
    started=$(date +%s%N)
    measure taskset -c "$load" wrk -t2 -c64 -d"${secs}s" -s "$lua" "http://127.0.0.1:$port$path" >"$out/turn.wrk" 2>&1 \
        || fail "wrk failed in pair $1 $2: $(cat "$out/turn.wrk")"
    ms=$(( ($(date +%s%N) - started) / 1000000 ))
    { echo "## pair $1 $2"; cat "$out/turn.perf" "$out/turn.wrk"; } >>"$raw"
    set -- "$1" "$2" $(sed -n 's/^RESULT //p' "$out/turn.wrk")
    [ $# -eq 8 ] || fail "no RESULT line from wrk in pair $1 $2"
    failures=$(( $4 + $5 + $6 + $7 + $8 ))
    cu=; ck=; iu=; ic=; tc=
    if [ "$perf" = 1 ]; then
        cu=$(awk -F, '$3 == "cycles:u" { print $1 }' "$out/turn.perf")
        ck=$(awk -F, '$3 == "cycles:k" { print $1 }' "$out/turn.perf")
        iu=$(awk -F, '$3 == "instructions:u" { print $1 }' "$out/turn.perf")
        tc=$(awk -F, '$3 == "task-clock" { printf "%.0f", $1 }' "$out/turn.perf")
        case "$cu,$ck,$iu,$tc" in *[!0-9,]*|,*|*,,*|*,) fail "unusable counters in pair $1 $2: $(cat "$out/turn.perf")";; esac
        if [ "$icache" = 1 ]; then
            ic=$(awk -F, '$3 == "L1-icache-load-misses:u" || $3 == "L1-icache-load-misses" { print $1 }' "$out/turn.perf")
            case "$ic" in ''|*[!0-9]*) fail "unusable L1-icache-load-misses:u in pair $1 $2: $(cat "$out/turn.perf")";; esac
        fi
        pct=$(awk -F, '$3 ~ /^(cycles|instructions|L1-icache)/ && $5 + 0 < 100 { print $3 " " $5 }' "$out/turn.perf")
        [ -z "$pct" ] || fail "multiplexed counters in pair $1 $2: $pct"
    fi
    echo "$1,$2,$3,$cu,$ck,$iu,$ic,$tc,$failures,$ms" >>"$csv"
    [ "$failures" = 0 ] || fail "$failures failed requests in pair $1 $2 (connect $4, read $5, write $6, status $7, timeout $8)"
    [ "$3" -gt 0 ] || fail "no requests answered in pair $1 $2"
    kill $pid; wait $pid 2>/dev/null || true
    if [ "$2" = base ]; then base=; else head=; fi
}
header=pair,version,requests,cycles_u,cycles_k,instructions_u,icache_u,task_ms,failures,ms
echo "$header" >"$csv"
t0=$(date +%s)
i=1
while [ $i -le "$warmup" ]; do turn "w$i" base; turn "w$i" head; i=$((i + 1)); done
if [ "$warmup" -gt 0 ] && [ "$pairs" -gt 0 ]; then
    each=$(( ($(date +%s) - t0) / warmup ))
    echo "$w: warm-up took about $each s a pair; $pairs pairs should take about $(( each * pairs / 60 + 1 )) minutes"
fi
echo "$header" >"$csv"
pair=1
while [ $pair -le "$pairs" ]; do
    if [ $((pair % 2)) = 1 ]; then turn $pair base; turn $pair head; else turn $pair head; turn $pair base; fi
    [ $((pair % 10)) != 0 ] || echo "$w: pair $pair of $pairs done $(date -u +%T)"
    pair=$((pair + 1))
done
rm -f "$out/turn.perf" "$out/turn.wrk"
echo "$w: done, $csv"