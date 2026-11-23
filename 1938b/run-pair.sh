#!/bin/sh
# run-pair.sh <workload>: paired cycles per request for corten-run/corten#1938 (a write that names
# the page it changed, KeptAnswers::changed), one workload, both builds; kit 1938b, the
# supplement to 1938 after round 2 of review. 1938's run-pair.sh with its protocol unchanged (a
# fresh start every turn, warm, perf of the server alone for exactly as long as wrk runs, every
# counter at 100%, no failed request, the order turned every pair) and three workloads 1938 does
# not have:
#
# Workloads (the probe's routes are in probe-*/src/main.rs, 1938's probe plus `page-roomy`):
#   write-off        POST /items/8/edit, app `page-off` (kept_answers(0)): a write that does not
#                    take KeptAnswers, in an app with the store off. jemalloc preloaded.
#   write-off-glibc  the same with glibc's allocator (nothing preloaded), the allocator under
#                    which the PR's callgrind counts differ for this request.
#   new              GET /home?t=<thread>&n=<k>, a new URL with every request (lua/get-new.lua),
#                    app `page-roomy` (a 1 GiB store, room for every page of a turn): each request
#                    makes the page and keeps it. jemalloc preloaded.
#
# A turn: start the build pinned to SERVER_CPU with the workload's allocator, wait until it
# answers, warm it (apps `page` and `page-roomy`: GET /home three times, the third must carry Age,
# so /home is kept and the counts by path exist), then perf stat counts the server process alone
# for exactly as long as wrk runs (perf stat -p <server> -- wrk ...): cycles:u, cycles:k,
# instructions:u, task-clock (software, how busy the server was) and, with ICACHE=1,
# L1-icache-load-misses (perf may name it with or without `:u`) as a diagnostic. wrk -t2 -c64 for
# TURN seconds on LOAD_CPUS. A counter below 100% running, a non-numeric counter, or any failed
# request (connect, read, write, timeout or a status other than 2xx/3xx, as wrk counts them)
# stops the run, after the turn's row (with its failures) is written.
#
# `new` proves its insertions in every turn, after perf has stopped and before the server is
# stopped: for each of wrk's threads, the turn's first sent URL (n=2: wrk calls request() once on
# its first thread to check the script and never sends that one, so thread 1's n=1 is not asked
# for) and one near its last (the last n wrk made, less 100, which covers the 32 requests a thread
# can have in flight when wrk stops) must be given from the store (carry Age). A page made but not kept, or a store that filled and
# refused or dropped the turn's pages, stops the run.
#
# Before the first turn, each build answers the workload's request on fresh starts, base twice:
# after the warm-up, the request's status line, headers but Date (Age's value masked to `age: *`),
# the body's length and sha256; for `new`, whether the same URL asked for again is given from the
# store (`again: kept`, which both builds must say); then whether GET /home is still kept (`home
# after: kept`, or with no store `none kept`). The two base answers must be the same, and head's
# the same as base's: none of these workloads differs by design. Anything else stops.
#
# Environment (all optional):
#   OUT        results directory (default /m/1938b/results)
#   PAIRS      recorded pairs (default 100); 0 checks the answers and runs the warm-up pairs only
#   WARMUP     unrecorded pairs before them (default 1)
#   TURN       seconds of load a turn (default 3)
#   SERVER_CPU (default 2), LOAD_CPUS (default 4,5)
#   ICACHE     1 to count L1-icache-load-misses too (run.sh sets it after a preflight)
#   PERF       0 to run the turns without perf (a container without counters); the counter
#              columns are then empty and the CSV is not a measurement (summary.mjs refuses it)
# Writes $OUT/cycles-<workload>.csv (pair,version,requests,cycles_u,cycles_k,instructions_u,
# icache_u,task_ms,failures,ms; summary.mjs reads it), raw-<workload>.log (every turn's perf and
# wrk output, and for `new` its insertion check), answers-<workload>/ and
# serve-<workload>-{base,head}.log. Exits 0 only when every declared pair was recorded.
set -eu
P=/m/1938b; bin=$P/bin
[ $# -eq 1 ] || { sed -n '2,56p' "$0"; exit 2; }
w=$1
alloc=jemalloc
case $w in
    write-off) config=page-off; method=POST; path=/items/8/edit; lua=$P/lua/post-same-origin.lua ;;
    write-off-glibc) config=page-off; method=POST; path=/items/8/edit; lua=$P/lua/post-same-origin.lua; alloc=glibc ;;
    new) config=page-roomy; method=GET; path='/home?t=0&n=1'; lua=$P/lua/get-new.lua ;;
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
[ "$alloc" = glibc ] || [ -e "$(ldconfig -p | sed -n 's/.*libjemalloc\.so\.2.*=> //p' | head -1)" ] || fail "no libjemalloc.so.2"

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
    if [ "$alloc" = jemalloc ]; then
        taskset -c "$cpu" env HOST=127.0.0.1 PORT="$2" LD_PRELOAD=libjemalloc.so.2 \
            MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc \
            "$bin/$1" "$config" >>"$out/serve-$w-$1.log" 2>&1 &
    else
        taskset -c "$cpu" env -u LD_PRELOAD -u MALLOC_CONF HOST=127.0.0.1 PORT="$2" PROBE_ALLOCATOR=glibc \
            "$bin/$1" "$config" >>"$out/serve-$w-$1.log" 2>&1 &
    fi
}
ready() { # <version> <port> <pid>
    # Its own counter: 1938's ready() shared `i` with the warm-up loop below, which then ran again,
    # without end when every server answered its first probe.
    tries=0
    until curl -s -o /dev/null "http://127.0.0.1:$2/items/8/edit" </dev/null; do
        tries=$((tries + 1)); [ $tries -lt 100 ] || fail "$1 does not answer on $2 (serve-$w-$1.log)"; sleep 0.1
    done
    [ "$(readlink "/proc/$3/exe")" = "$bin/$1" ] || fail "pid $3 is not $bin/$1"
    [ "$(taskset -cp "$3" | sed 's/.*: //')" = "$cpu" ] || fail "pid $3 is not on cpu $cpu"
    # The probe refuses to start unless PROBE_ALLOCATOR names the allocator in use, and says which.
    grep "^ALLOCATOR " "$out/serve-$w-$1.log" | tail -1 | grep -q "^ALLOCATOR $alloc " || fail "$1 did not report allocator $alloc (serve-$w-$1.log)"
}
aged() { # <port> [path, default /home]: whether that GET is given from the store (it carries Age)
    curl -sS -D - -o /dev/null --max-time 10 "http://127.0.0.1:$1${2:-/home}" </dev/null | tr -d '\r' | grep -qi '^age:'
}
keeps() { [ "$config" = page ] || [ "$config" = page-roomy ]; }
warm() { # <version> <port>: /home kept, and the counts by path made (apps with a store)
    keeps || return 0
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
answer() { # <port>: the workload's request answered, then (new) whether it was kept, then /home
    url=http://127.0.0.1:$1$path
    if [ $method = POST ]; then
        curl -sS --max-time 10 -X POST -H 'sec-fetch-site: same-origin' -D "$ans/head.tmp" -o "$ans/body.tmp" "$url" </dev/null
    else
        curl -sS --max-time 10 -D "$ans/head.tmp" -o "$ans/body.tmp" "$url" </dev/null
    fi
    tr -d '\r' <"$ans/head.tmp" | grep -iv '^date:' | sed 's/^[Aa][Gg][Ee]:.*/age: */'
    echo "body $(wc -c <"$ans/body.tmp") bytes, sha256 $(sha256sum "$ans/body.tmp" | cut -c1-64)"
    if [ "$w" = new ]; then
        if aged "$1" "$path"; then echo "again: kept"; else echo "again: not kept"; fi
    fi
    if aged "$1"; then echo "home after: kept"
    elif keeps; then echo "home after: not kept"
    else echo "home after: none kept"; fi
    rm -f "$ans/head.tmp" "$ans/body.tmp"
}

# The answers, before any turn, each on a fresh start.
fresh base; answer $bport >"$ans/base.txt"
fresh base; answer $bport >"$ans/base-again.txt"
fresh head; answer $hport >"$ans/head.txt"
kill $base $head 2>/dev/null || true; wait $base $head 2>/dev/null || true; base=; head=
head -1 "$ans/base.txt" | grep -q '^HTTP/1.1 200 ' || fail "base answered $(head -1 "$ans/base.txt")"
if [ "$w" = new ]; then
    grep -qi '^age:' "$ans/base.txt" && fail "base's first answer for a new URL carried Age"
    grep -qx 'again: kept' "$ans/base.txt" || fail "base did not keep the page it made for a new URL"
    grep -qx 'home after: kept' "$ans/base.txt" || fail "base's /home was not kept"
else
    grep -qx 'home after: none kept' "$ans/base.txt" || fail "base kept /home with the store off: $(tail -1 "$ans/base.txt")"
fi
cmp -s "$ans/base.txt" "$ans/base-again.txt" || { diff "$ans/base.txt" "$ans/base-again.txt" >&2 || true; fail "two base answers differ"; }
cmp -s "$ans/base.txt" "$ans/head.txt" || { diff "$ans/base.txt" "$ans/head.txt" >&2 || true; fail "head answers other than base"; }
echo "checked $w ($alloc): base twice the same; head the same: $(head -1 "$ans/base.txt"), $(grep '^body' "$ans/base.txt"), $(grep '^again' "$ans/base.txt" || true) $(tail -1 "$ans/base.txt")" | tee "$ans/verdict.txt"

measure() { # <command...>: runs it; perf counts the server process ($pid) for exactly as long
    if [ "$perf" = 1 ]; then
        perf stat -x, -e "$events" -p "$pid" -o "$out/turn.perf" -- "$@"
    else
        echo "(no perf)" >"$out/turn.perf"
        "$@"
    fi
}
inserted() { # <pair> <version> <port>: `new` only, after perf: the turn's pages were kept
    [ "$w" = new ] || return 0
    lasts=$(sed -n 's/^LAST //p' "$out/turn.wrk")
    [ -n "$lasts" ] || fail "no LAST line from wrk in pair $1 $2"
    echo "$lasts" | while read -r t n; do
        case "$t,$n" in *[!0-9,]*|,*|*,) fail "bad LAST line in pair $1 $2: $t $n";; esac
        [ "$n" -gt 2 ] || fail "thread $t made only $n requests in pair $1 $2"
        late=$((n - 100)); [ $late -ge 2 ] || late=2
        for k in 2 $late; do
            aged "$3" "/home?t=$t&n=$k" || fail "pair $1 $2: /home?t=$t&n=$k, made in the turn, was not kept"
        done
        echo "kept: /home?t=$t&n=2 and /home?t=$t&n=$late (thread's last n $n)"
    done >>"$raw" || exit 1
}
turn() { # <pair> <version>
    fresh "$2"
    if [ "$2" = base ]; then pid=$base; port=$bport; else pid=$head; port=$hport; fi
    started=$(date +%s%N)
    measure taskset -c "$load" wrk -t2 -c64 -d"${secs}s" -s "$lua" "http://127.0.0.1:$port$path" >"$out/turn.wrk" 2>&1 \
        || fail "wrk failed in pair $1 $2: $(cat "$out/turn.wrk")"
    ms=$(( ($(date +%s%N) - started) / 1000000 ))
    { echo "## pair $1 $2"; cat "$out/turn.perf" "$out/turn.wrk"; } >>"$raw"
    inserted "$1" "$2" "$port"
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
            ic=$(awk -F, '$3 ~ /^L1-icache-load-misses(:u)?$/ { print $1 }' "$out/turn.perf")
            case "$ic" in ''|*[!0-9]*) fail "unusable L1-icache-load-misses in pair $1 $2: $(cat "$out/turn.perf")";; esac
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
wu=1
while [ $wu -le "$warmup" ]; do turn "w$wu" base; turn "w$wu" head; wu=$((wu + 1)); done
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
[ "$(grep -c "^w" "$csv")" = 0 ] || fail "$csv still holds warm-up rows"
[ "$(($(wc -l <"$csv") - 1))" = $((pairs * 2)) ] || fail "$csv has $(($(wc -l <"$csv") - 1)) rows, not $((pairs * 2))"
rm -f "$out/turn.perf" "$out/turn.wrk"
echo "$w: done, $csv"