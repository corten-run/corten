#!/bin/sh
# run-pair-old.sh: kit 1965's run-pair-fresh.sh (every turn on a freshly started build, the order
# turned every pair, perf of the server process over the turn, wrk on its own CPUs) for a kept
# answer whose cost depends on its Age: GET /picture.png of the probe's `old` config, a PNG of
# 8,000 bytes kept for four hours. Before its turn every start is asked for the picture twice (the
# first makes and keeps it, the second is given it kept), then:
#   old    the driver signals the clock shim (shim/clockstep.c), which moves the process's
#          monotonic clock on by STEP seconds, so the kept answer is past the table of ages
#   young  the clock is left alone, so the kept answer's Age is in the table
# and the start is asked once more: its Age must be in the workload's range (plan.env), or the
# run stops. After the turn it is asked again: the Age must still be in range and the picture's
# handler must have run exactly once (/picture-runs), so every request of the turn was given the
# answer kept before it. Each of those is written to ages-<workload>.txt; no Age is accepted as
# any number.
#
# The answers are compared first, on a first start of each build: four answers each (made, given
# kept while young, as the workload asks, and that one again), as received: the status, every
# header line but Date with only the Age's value set aside (it differs between two starts by the
# second they were asked in, and is checked against its range instead), and the body byte for
# byte. Two answers of the base build must agree, and base and head must answer the same. The
# headers and bodies as received are kept in answers-<workload>/.
#
# Usage: run-pair-old.sh <out dir> <old|young> <pairs> <server cpu> <load cpus> <base cmd> <head cmd>
#   <base cmd>, <head cmd>  a command serving HTTP on 127.0.0.1:$PORT, run under taskset -c
#                          <server cpu>; single-quote it so $PORT stays literal
# Environment: WARMUP unrecorded pairs before the recorded ones (default 1), TURN seconds of load
# in a turn (default 3). The counters are plan.sh's EVENTS; every one must be counted, numeric
# and running 100% of the turn. Writes <out dir>/counts-<workload>.csv, raw-<workload>.log (every
# turn's perf and wrk output), ages-<workload>.txt, answers-<workload>/ and
# serve-<workload>-{base,head}.log. Kit 1999's amendment 1 (review 1, P3-2) gives the port probe
# and ready()'s curl a 2 s limit, so neither waits on a server that accepts and never answers;
# nothing a turn measures changed (run.sh also bounds the whole placement).
set -eu
[ $# -eq 7 ] || { sed -n '2,31p' "$0"; exit 2; }
P=/m/1999
. $P/plan.sh
out=$1; workload=$2; pairs=$3; cpu=$4; load=$5; basecmd=$6; headcmd=$7
case "$workload" in
    old) step=$STEP; low=$OLD_LOW; high=$OLD_HIGH ;;
    young) step=0; low=$YOUNG_LOW; high=$YOUNG_HIGH ;;
    *) echo "run-pair: no workload $workload"; exit 2 ;;
esac
path=/picture.png; lua=$P/lua/picture.lua
warmup=${WARMUP:-1}; secs=${TURN:-3}
mkdir -p "$out"
csv=$out/counts-$workload.csv; raw=$out/raw-$workload.log; ans=$out/answers-$workload; ages=$out/ages-$workload.txt
rm -rf "$ans"; mkdir -p "$ans"; : >"$raw"; : >"$ages"
fail() { echo "run-pair: $workload: $*" >&2; exit 1; }

start() { # <version> <port> <command>; the server's pid is then $!
    PORT=$2 taskset -c "$cpu" sh -c "exec $3" >/dev/null 2>>"$out/serve-$workload-$1.log" &
}
bport=18081; hport=18082
for port in $bport $hport; do
    ! curl -s --max-time 2 -o /dev/null "http://127.0.0.1:$port/" </dev/null || fail "something already answers on $port"
done
: >"$out/serve-$workload-base.log"; : >"$out/serve-$workload-head.log"
base=; head=
stop() { kill $base $head 2>/dev/null || true; wait $base $head 2>/dev/null || true; }
trap stop EXIT
trap 'exit 1' HUP INT PIPE TERM
ready() { # <port> <pid>
    i=0
    until curl -s --max-time 2 -o /dev/null "http://127.0.0.1:$1/picture-runs" </dev/null; do
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
# The request the load sends, by curl: the head as received to <head file>, the body to <body file>.
ask() { # <port> <head file> <body file>
    curl -sS --max-time 10 -H 'Accept-Encoding: identity' -H 'Accept: */*' -D "$2" -o "$3" "http://127.0.0.1:$1$path" </dev/null
}
age_of() { tr -d '\r' <"$1" | awk -F': ' 'tolower($1) == "age" { print $2 }'; }
within() { # <value> <low> <high>
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
    [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]
}
moved() { [ "$step" = 0 ] || { kill -USR1 "$1"; sleep 0.05; }; } # <pid>: the clock moved on, for `old`
# Corten's connection watch keeps a coarse clock of its own, which a step leaves behind until it
# next ticks: in the container test connections opened in the first second after a step were
# closed once as idle, and none from 1.5 s on. So a turn's load starts 2 s after the step.
settled() { [ "$step" = 0 ] || sleep 2; }
runs() { curl -sS --max-time 10 "http://127.0.0.1:$1/picture-runs" </dev/null; }

# The two builds answer the same.
fresh base; fresh head
capture() { # <name> <port> <pid>: made, given kept while young, as the workload asks, and again
    ask "$2" "$ans/$1-1.head" "$ans/$1-1.body"
    ask "$2" "$ans/$1-2.head" "$ans/$1-2.body"
    moved "$3"
    ask "$2" "$ans/$1-3.head" "$ans/$1-3.body"
    ask "$2" "$ans/$1-4.head" "$ans/$1-4.body"
}
capture base $bport $base
capture head $hport $head
norm() { tr -d '\r' <"$1" | grep -iv '^date:' | sed 's/^[Aa][Gg][Ee]: [0-9][0-9]*$/age: (checked against its range)/'; }
for v in base head; do
    for k in 1 2 3 4; do
        f=$ans/$v-$k
        head -1 "$f.head" | grep -q '^HTTP/[0-9.]* 200 ' || fail "answer $k of $v: $(head -1 "$f.head")"
        [ "$(wc -c <"$f.body")" = 8000 ] || fail "answer $k of $v: a body of $(wc -c <"$f.body") bytes"
        a=$(age_of "$f.head")
        case $k in
            1) [ -z "$a" ] || fail "answer 1 of $v was not made by its handler (Age $a)" ;;
            2) within "$a" 0 5 || fail "answer 2 of $v was not given kept while young (Age '$a')" ;;
            *) within "$a" "$low" "$high" || fail "answer $k of $v: Age '$a' is not in $low..$high" ;;
        esac
        norm "$f.head" >"$f.norm"
    done
    [ "$(runs "$([ $v = base ] && echo $bport || echo $hport)")" = 1 ] || fail "$v: the picture's handler did not run exactly once for four answers"
done
cmp -s "$ans/base-3.norm" "$ans/base-4.norm" || fail "two answers of the base build differ: $ans/base-3.norm and base-4.norm"
for k in 1 2 3 4; do
    cmp -s "$ans/base-$k.norm" "$ans/head-$k.norm" || { diff "$ans/base-$k.norm" "$ans/head-$k.norm" >&2 || true; fail "base and head answer differently (answer $k, head lines)"; }
    cmp -s "$ans/base-$k.body" "$ans/head-$k.body" || fail "base and head answer differently (answer $k, body)"
done
{
    echo "checked 4 answers of each build: same status, head lines (but Date, the Age's value checked apart) and body"
    echo "ages: base $(age_of "$ans/base-2.head") then $(age_of "$ans/base-3.head") and $(age_of "$ans/base-4.head"); head $(age_of "$ans/head-2.head") then $(age_of "$ans/head-3.head") and $(age_of "$ans/head-4.head") (range $low..$high)"
    echo "body: 8000 bytes, sha256 $(sha256sum <"$ans/base-3.body" | cut -d' ' -f1)"
} | tee "$ans/verdict.txt"

# Both builds stopped after the check, so neither holds memory while the other is measured.
kill $base $head; wait $base $head 2>/dev/null || true; base=; head=
turn() { # <pair> <version>
    fresh "$2"
    if [ "$2" = base ]; then pid=$base; port=$bport; else pid=$head; port=$hport; fi
    t=$out/turn
    ask "$port" "$t.h1" "$t.b1"; ask "$port" "$t.h2" "$t.b2"
    [ -z "$(age_of "$t.h1")" ] || fail "pair $1 $2: the start's first answer already had an Age"
    within "$(age_of "$t.h2")" 0 5 || fail "pair $1 $2: the start's second answer was not given kept (Age '$(age_of "$t.h2")')"
    moved "$pid"
    ask "$port" "$t.h3" "$t.b3"
    before=$(age_of "$t.h3")
    within "$before" "$low" "$high" || fail "pair $1 $2: Age '$before' before the turn is not in $low..$high"
    settled
    perf stat -x, -e "$EVENTS" -p "$pid" -o "$out/turn.perf" -- sleep "$secs.4" &
    perfpid=$!
    sleep 0.1
    taskset -c "$load" wrk -t2 -c64 -d"${secs}s" -s "$lua" "http://127.0.0.1:$port$path" >"$out/turn.wrk"
    wait $perfpid
    ask "$port" "$t.h4" "$t.b4"
    after=$(age_of "$t.h4")
    within "$after" "$low" "$high" || fail "pair $1 $2: Age '$after' after the turn is not in $low..$high"
    ran=$(runs "$port")
    [ "$ran" = 1 ] || fail "pair $1 $2: the picture's handler ran '$ran' times, not once: a request of the turn was not given the kept answer"
    echo "$1 $2 before $before after $after runs $ran" >>"$ages"
    { echo "## pair $1 $2"; cat "$out/turn.perf" "$out/turn.wrk"; } >>"$raw"
    set -- "$1" "$2" $(sed -n 's/^RESULT //p' "$out/turn.wrk")
    [ $# -eq 8 ] || fail "no RESULT line from wrk in pair $1 $2"
    [ "$4$5$6$7$8" = 00000 ] || fail "errors in pair $1 $2: $*"
    values=
    for ev in $(echo "$EVENTS" | tr ',' ' '); do
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
echo "pair,version,requests,$COLUMNS" >"$csv"
w=1
while [ $w -le "$warmup" ]; do turn "w$w" base; turn "w$w" head; w=$((w + 1)); done
echo "pair,version,requests,$COLUMNS" >"$csv"
pair=1
while [ $pair -le "$pairs" ]; do
    if [ $((pair % 2)) = 1 ]; then turn $pair base; turn $pair head; else turn $pair head; turn $pair base; fi
    pair=$((pair + 1))
done
rm -f "$out/turn.perf" "$out/turn.wrk" "$out"/turn.h? "$out"/turn.b?
echo "$workload: done, $csv; $(grep -c . "$ages") starts, each with its Age in $low..$high before and after its turn and one run of the handler"
