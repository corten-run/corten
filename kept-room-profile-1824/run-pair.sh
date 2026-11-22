#!/bin/sh
# run-pair.sh: one paired comparison for corten-run/corten#1824's kit (1824c). The 1824b kit's
# run-pair.sh (fresh start every turn, the order turned every pair, the answer checks and the
# after-turn check), with what this kit adds: a turn either counts (MODE=stat, the events in
# EVENTS) or samples (MODE=record, perf record on the server's CPU), and every turn records
# /proc/vmstat before and after it and the server's smaps_rollup at its end.
#
# Every turn is on a freshly started server (A or B), pinned to SERVER_CPU, waited for, measured
# and stopped, so each starts with an empty store; the order turns every pair (A first in odd
# pairs). wrk -t2 -c64 loads it for TURN seconds from LOAD_CPUS.
#   stat    perf stat -p <server> over the turn, the events in EVENTS (comma-separated, in the
#           order perf prints them); every hardware event must run 100% of the time and be a
#           number, else the run stops. perf's lines are read by position, and a line may name
#           its event as asked or without its modifier (perf prints L1-icache-load-misses:u and
#           dTLB-load-misses:k without the :u or :k, though it counts what was asked).
#   record  perf record -C SERVER_CPU (everything on that CPU, the server and any kernel work run
#           there) over the turn, REC_EVENT every REC_PERIOD events with the period recorded (-P),
#           REC_FLAGS added (run.sh passes -g and, where perf has it, --kernel-callchains for the
#           call-graph pass); the data is written to SHM (tmpfs, so no writeback runs on the
#           server's CPU) and moved to PERF_DIR/<name>-<pair>-<version>.data after the turn;
#           the warm-up's data is deleted. Beside it, perf stat -C SERVER_CPU counts that CPU's
#           cycles:u and cycles:k over the same time (all tasks, at 100%, else the run stops;
#           CPUSTAT=0 leaves this count out and the columns empty).
# From /proc, after the server answers and before the load, and after it: minflt and VmRSS of the
# server; at the end VmHWM and smaps_rollup (the whole of it to smaps-<name>.log; Anonymous and
# AnonHugePages to the CSV); /proc/vmstat before and after (the deltas of thp_*, compact_*,
# numa_*, pgalloc_*, pgfault, pgmajfault, pgfree, nr_anon_pages and nr_anon_transparent_hugepages
# to vmstat-<name>.csv; the counters are the whole host's).
#
# Before the first turn A and B are each started once and asked every line of CHECKS (curl, Date
# dropped, MASK applied): A twice and B once; A's two answers must be the same, and A and B must be
# the same. After each turn's counts, before it is stopped, the server is asked as AFTER_A or
# AFTER_B says, and the run stops unless the answer is a 200 of the bytes CHECKS' first answer had:
#   kept-new    a URL not asked before (<path>?after=<n>), then again: the second has an Age
#   unkept-new  the same, and the second has none (the store is off)
# A wrk error of any kind (connect, read, write, status, timeout) stops the run: the CSV's errors
# column is their count, 0 in every turn that is recorded.
#
# Usage: run-pair.sh <out dir> <name> <pairs> <path> <lua> <A cmd> <B cmd>
#   <A cmd>, <B cmd>  a command serving HTTP on 127.0.0.1:$PORT; single-quote it so $PORT stays
#                     literal: 'env MALLOC_CONF=... /m/1824c/bin/main $PORT room'
#   <lua>             a wrk script whose done() prints
#                     "RESULT <requests> <connect> <read> <write> <status> <timeout>"
# Environment: AFTER_A, AFTER_B (required); MODE (stat or record, default stat); EVENTS (stat);
# REC_EVENT (default cycles), REC_PERIOD (default 1000003), REC_FLAGS, PERF_DIR (default
# <out dir>/perf) (record); SHM (default /dev/shm); CHECKS (file, one "<path> [curl arguments]"
# a line; default <path>), MASK (sed script, default none), WARMUP (unrecorded pairs first,
# default 1), TURN (seconds, default 3), SERVER_CPU (2), LOAD_CPUS (4,5), PERF (0 runs the turns without perf, for a container without counters:
# not a measurement, the counter columns are empty and no profile is written).
# Writes <out dir>/pairs-<name>.csv (stat: pair,version,requests,<an event a column, named as
# asked with every character not a letter or digit made _>,minflt,rss_idle_kb,rss_end_kb,hwm_kb,
# anon_kb,anon_huge_kb,errors) or turns-<name>.csv (record: pair,version,requests,samples,
# cpu_cycles_u,cpu_cycles_k,minflt,rss_idle_kb,rss_end_kb,hwm_kb,anon_kb,anon_huge_kb,errors);
# version is base for A and head for B; and vmstat-<name>.csv, smaps-<name>.log, raw-<name>.log
# (every turn's perf and wrk output), answers-<name>/ and serve-<name>-{base,head}.log.
set -eu
[ $# -eq 7 ] || { sed -n '2,56p' "$0"; exit 2; }
out=$1; name=$2; pairs=$3; path=$4; lua=$5; acmd=$6; bcmd=$7
after_a=${AFTER_A:?}; after_b=${AFTER_B:?}
warmup=${WARMUP:-1}; secs=${TURN:-3}; mask=${MASK:-/dev/null}; perf=${PERF:-1}; mode=${MODE:-stat}
cpu=${SERVER_CPU:-2}; load=${LOAD_CPUS:-4,5}; shm=${SHM:-/dev/shm}
rec_event=${REC_EVENT:-cycles}; rec_period=${REC_PERIOD:-1000003}; rec_flags=${REC_FLAGS:-}
cpu_events=cycles:u,cycles:k; recpid=; cpustat=${CPUSTAT:-1}
case $mode in
    stat) events=${EVENTS:?EVENTS is required with MODE=stat} ;;
    record) events= ;;
    *) echo "run-pair: MODE is stat or record, not $mode" >&2; exit 2 ;;
esac
mkdir -p "$out"
ans=$out/answers-$name; raw=$out/raw-$name.log; vmcsv=$out/vmstat-$name.csv; smaps=$out/smaps-$name.log
pdir=${PERF_DIR:-$out/perf}
if [ $mode = stat ]; then csv=$out/pairs-$name.csv; else csv=$out/turns-$name.csv; mkdir -p "$pdir"; fi
rm -rf "$ans"; mkdir -p "$ans"; : >"$raw"; : >"$smaps"
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
        *) fail "unknown AFTER kind $1" ;;
    esac
    [ "$first / $second" = "$want" ] || fail "after pair $3 ($1 on $2): got $first / $second, want $want"
}
procs() { # <pid>: "minflt rss_kb"
    echo "$(sed 's/.*) //' /proc/$1/stat | cut -d' ' -f8) $(awk '/^VmRSS:/ { print $2 }' /proc/$1/status)"
}
# perf stat's output, read by position: ",<value>,<value>..." for <events>, or "FAIL <why>".
parse() { # <perf output> [events, default EVENTS]
    awk -F, -v evs="${2:-$events}" '
        BEGIN { n = split(evs, e, ","); i = 0; bad = "" }
        bad != "" || /^#/ || NF == 0 { next }
        {
            i++
            if (i > n) { bad = "an extra line: " $0; next }
            want = e[i]; bare = want; sub(/:[A-Za-z]+$/, "", bare)
            if ($3 != want && $3 != bare) { bad = "line " i " is " $3 ", " want " expected"; next }
            if ($1 !~ /^[0-9]+$/) { bad = "unusable " want ": " $1; next }
            if ($5 + 0 < 100) { bad = "multiplexed " want ": " $5 "%"; next }
            v = v "," $1
        }
        END {
            if (bad == "" && i != n) bad = i " lines for " n " events"
            if (bad != "") print "FAIL " bad; else print v
        }' "$1"
}
columns=$(echo "$events" | tr ',' '\n' | sed 's/[^A-Za-z0-9]/_/g' | paste -sd, -)
vmkeys='^(thp_|compact_|numa_|pgalloc_|pgfault$|pgmajfault$|pgfree$|nr_anon_pages$|nr_anon_transparent_hugepages$)'
vmhead=
vmdelta() { # <before> <after>: "<keys>|<deltas>"
    awk -v re="$vmkeys" 'NR == FNR { b[$1] = $2; next } $1 ~ re { k = k "," $1; d = d "," ($2 - b[$1]) } END { print substr(k, 2) "|" substr(d, 2) }' "$1" "$2"
}
turn() { # <pair> <version>
    fresh "$2"
    if [ "$2" = base ]; then pid=$base; port=$bport; kind=$after_a; else pid=$head; port=$hport; kind=$after_b; fi
    set -- "$1" "$2" $(procs $pid)
    cat /proc/vmstat >"$out/vm.before"
    if [ "$perf" != 1 ]; then
        echo "(no perf)" >"$out/turn.perf"; sleep "$secs.4" &
    elif [ $mode = stat ]; then
        perf stat -x, -e "$events" -p "$pid" -o "$out/turn.perf" -- sleep "$secs.4" &
    else
        rm -f "$shm/1824c-turn.data"
        # shellcheck disable=SC2086
        perf record -C "$cpu" -e "$rec_event" -c "$rec_period" -P -N -m 8M $rec_flags -o "$shm/1824c-turn.data" -- sleep "$secs.4" >/dev/null 2>"$out/turn.perf" &
        recpid=$!
        # CPU $cpu's own user and kernel cycles over the same time, all tasks: what the samples are
        # scaled to where the kernel throttles sampling (profile.mjs). CPUSTAT=0 leaves it out.
        if [ "$cpustat" = 1 ]; then
            perf stat -x, -C "$cpu" -e "$cpu_events" -o "$out/turn.cpustat" -- sleep "$secs.4" &
        else
            sleep "$secs.4" &
        fi
    fi
    perfpid=$!
    sleep 0.1
    taskset -c "$load" wrk -t2 -c64 -d"${secs}s" -s "$lua" "http://127.0.0.1:$port$path" >"$out/turn.wrk"
    wait $perfpid || fail "perf failed in pair $1 $2: $(cat "$out/turn.perf" "$out/turn.cpustat" 2>/dev/null)"
    [ -z "${recpid:-}" ] || { wait $recpid || fail "perf record failed in pair $1 $2: $(cat "$out/turn.perf")"; recpid=; }
    cat /proc/vmstat >"$out/vm.after"
    set -- "$@" $(procs $pid) "$(awk '/^VmHWM:/ { print $2 }' /proc/$pid/status)"
    { echo "## pair $1 $2"; cat /proc/$pid/smaps_rollup; } >>"$smaps"
    set -- "$@" "$(awk '/^Anonymous:/ { print $2 }' /proc/$pid/smaps_rollup)" "$(awk '/^AnonHugePages:/ { print $2 }' /proc/$pid/smaps_rollup)"
    { echo "## pair $1 $2"; cat "$out/turn.perf" "$out/turn.wrk"; } >>"$raw"
    after "$kind" $port "$1"
    # $1 pair, $2 version, $3 minflt before, $4 rss before, $5 minflt after, $6 rss after, $7 hwm,
    # $8 anonymous, $9 anon huge (KiB)
    result=$(sed -n 's/^RESULT //p' "$out/turn.wrk")
    [ -n "$result" ] || fail "no RESULT line from wrk in pair $1 $2"
    requests=${result%% *}; errs=$(echo "$result" | awk '{ print $2 + $3 + $4 + $5 + $6 }')
    [ "$errs" = 0 ] || fail "wrk errors in pair $1 $2: $result"
    if [ $mode = stat ]; then
        if [ "$perf" = 1 ]; then
            values=$(parse "$out/turn.perf")
            case "$values" in FAIL*) fail "pair $1 $2: perf stat: ${values#FAIL }: $(cat "$out/turn.perf")" ;; esac
        else
            values=$(echo "$events" | awk -F, '{ for (i = 1; i <= NF; i++) printf "," }')
        fi
    else
        samples=
        if [ "$perf" = 1 ]; then
            samples=$(sed -n 's/.*(\([0-9]*\) samples).*/\1/p' "$out/turn.perf" | tail -1)
            [ -n "$samples" ] && [ "$samples" -gt 0 ] || fail "pair $1 $2: perf record wrote no samples: $(cat "$out/turn.perf")"
            cpuv=,,
            [ "$cpustat" != 1 ] || cpuv=$(parse "$out/turn.cpustat" "$cpu_events")
            case "$cpuv" in FAIL*) fail "pair $1 $2: perf stat -C $cpu: ${cpuv#FAIL }: $(cat "$out/turn.cpustat")" ;; esac
            case $1 in
                w*) rm -f "$shm/1824c-turn.data" ;;
                *) mv "$shm/1824c-turn.data" "$pdir/$name-$1-$2.data" ;;
            esac
        fi
        values=,$samples${cpuv:-,,}
    fi
    echo "$1,$2,$requests$values,$(($5 - $3)),$4,$6,$7,${8:-0},${9:-0},$errs" >>"$csv"
    vm=$(vmdelta "$out/vm.before" "$out/vm.after")
    if [ -z "$vmhead" ]; then vmhead=${vm%%|*}; echo "pair,version,requests,$vmhead" >"$vmcsv"; fi
    [ "${vm%%|*}" = "$vmhead" ] || fail "pair $1 $2: /proc/vmstat's fields changed"
    echo "$1,$2,$requests,${vm#*|}" >>"$vmcsv"
    kill $pid; wait $pid 2>/dev/null || true
    if [ "$2" = base ]; then base=; else head=; fi
}
if [ $mode = stat ]; then
    header=pair,version,requests,$columns,minflt,rss_idle_kb,rss_end_kb,hwm_kb,anon_kb,anon_huge_kb,errors
else
    header=pair,version,requests,samples,cpu_cycles_u,cpu_cycles_k,minflt,rss_idle_kb,rss_end_kb,hwm_kb,anon_kb,anon_huge_kb,errors
fi
echo "$header" >"$csv"
t0=$(date +%s)
w=1
while [ $w -le "$warmup" ]; do turn "w$w" base; turn "w$w" head; w=$((w + 1)); done
if [ "$warmup" -gt 0 ] && [ "$pairs" -gt 0 ]; then
    each=$(( ($(date +%s) - t0) / warmup ))
    echo "$name: the warm-up took about $each s a pair; $pairs pairs should take about $(( each * pairs / 60 + 1 )) minutes"
fi
echo "$header" >"$csv"
[ -z "$vmhead" ] || echo "pair,version,requests,$vmhead" >"$vmcsv"
: >"$smaps"
pair=1
while [ $pair -le "$pairs" ]; do
    if [ $((pair % 2)) = 1 ]; then turn $pair base; turn $pair head; else turn $pair head; turn $pair base; fi
    [ $((pair % 10)) != 0 ] || echo "$name: pair $pair of $pairs done $(date -u +%T)"
    pair=$((pair + 1))
done
rm -f "$out/turn.perf" "$out/turn.cpustat" "$out/turn.wrk" "$out/after.head" "$out/vm.before" "$out/vm.after" "$shm/1824c-turn.data"
echo "$name: done, $csv"