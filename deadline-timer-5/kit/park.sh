#!/bin/sh
# park.sh <workload> <out dir>: for the workloads `beside` and `besidemt` alone, before anything is
# counted (run.sh runs it after verify.sh): shows from outside the server's process that the
# workload's turns are in the state the plan declares them for. For each side the part reads (the
# base; in the gated part the head too), TURNS (3) times: the side's unpadded binary is started as
# a turn starts it (pinned to CPU 2, jemalloc preloaded, the workload's configuration), the idle
# connection is set up as a turn sets it up (idle.mjs: three requests for /wait, then open and
# silent), strace on CPU 7 is attached to the server and records every wait for an event its
# threads make (epoll_wait, epoll_pwait, epoll_pwait2), and the turn's own load is sent (wrk -t1
# -c1 for TURN s on CPU 4 with lua/get.lua). park.mjs then holds the waits that can block (a wait
# given a timeout of 0 cannot, and is passed over) to the side's rule: on the base every one has
# no timeout, since no timer stands in the runtime's wheel; on the head every one has a timeout,
# since the idle connection's kept timer does. A side built from the base's
# commit is held to the base's rule whatever its name (a dry run of the gated part's scripts with
# the base as both sides). A wrk error, an idle connection that was not set up or not held, fewer
# than 100 waits, a line park.mjs does not know, or a turn that breaks the rule stops the run. No
# counter is read here and nothing is recorded as a measurement; a turn under strace is not a
# turn of a placement. Writes <out dir>/<side>-<n>/ (wrk's output, the idle connection's lines,
# strace's output compressed, park.mjs's verdict) and <out dir>/verdicts.txt.
set -eu
W=${1:-}; out=${2:-}
. /m/dl/plan.sh
[ -n "$idle" ] && [ -n "$out" ] || { echo "usage: park.sh beside|besidemt <out dir>"; exit 2; }
TURNS=3
port=18083
mkdir -p "$out"; : >"$out/verdicts.txt"
pid=; ipid=; spid=
stop() { kill $spid $ipid $pid 2>/dev/null || true; wait $spid $ipid $pid 2>/dev/null || true; }
trap stop EXIT
trap 'exit 1' HUP INT PIPE TERM
fail() { echo "PARK FAILED: $*"; exit 1; }
command -v strace >/dev/null || fail "no strace"
! curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null || fail "something already answers on $port"
one() { # <side> <n>
    d=$out/$1-$2; mkdir -p "$d"
    if [ "$(commit_of $1)" = "$BASE" ]; then rule=none; else rule=timed; fi
    PORT=$port taskset -c 2 sh -c "exec $J $P/bin/$1 \$PORT $conf" >/dev/null 2>"$d/serve.log" &
    pid=$!
    i=0
    until curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null; do
        i=$((i + 1)); [ $i -lt 100 ] || fail "$1 turn $2: nothing answers on $port"; sleep 0.1
    done
    node $P/idle.mjs $port "$idle" 3 >"$d/idle.txt" 2>&1 &
    ipid=$!
    i=0
    until grep -q '^IDLE-READY 3 answers of 200 ' "$d/idle.txt"; do
        i=$((i + 1))
        if [ $i -ge 70 ] || grep -q '^IDLE-FAILED' "$d/idle.txt"; then fail "$1 turn $2: the idle connection was not set up: $(cat "$d/idle.txt")"; fi
        sleep 0.1
    done
    taskset -c 7 strace -f -e trace=epoll_wait,epoll_pwait,epoll_pwait2 -o "$d/strace.txt" -p $pid 2>"$d/strace.err" &
    spid=$!
    i=0
    until grep -q 'attached' "$d/strace.err"; do
        i=$((i + 1)); [ $i -lt 50 ] || fail "$1 turn $2: strace did not attach: $(cat "$d/strace.err")"; sleep 0.1
    done
    taskset -c "$load_cpus" wrk -t"$load_t" -c"$load_c" -d"${TURN}s" -s $P/lua/$lua "http://127.0.0.1:$port$path" >"$d/wrk.txt" || true
    kill -INT $spid; wait $spid 2>/dev/null || true; spid=
    kill -0 $ipid 2>/dev/null || fail "$1 turn $2: the idle connection ended during the turn: $(cat "$d/idle.txt")"
    kill $ipid; wait $ipid 2>/dev/null || true; ipid=
    [ "$(grep -c '^IDLE-' "$d/idle.txt")" = 2 ] && grep -q '^IDLE-HELD open for ' "$d/idle.txt" || fail "$1 turn $2: the idle connection was not held through the turn: $(cat "$d/idle.txt")"
    kill $pid; wait $pid 2>/dev/null || true; pid=
    set -- "$1" "$2" $(sed -n 's/^RESULT //p' "$d/wrk.txt")
    [ $# -eq 8 ] || fail "$1 turn $2: no RESULT line from wrk"
    [ "$4$5$6$7$8" = 00000 ] || fail "$1 turn $2: wrk errors: $*"
    node $P/park.mjs "$d/strace.txt" $rule "$3" >"$d/park.txt" || { cat "$d/park.txt"; gzip -9 -f "$d/strace.txt"; fail "$1 turn $2: the server's waits are not the state's (rule: $rule)"; }
    gzip -9 -f "$d/strace.txt"
    echo "$1 turn $2: $3 requests, no error; idle connection held; $(head -1 "$d/park.txt")" | tee -a "$out/verdicts.txt"
}
for s in $SIDES; do
    n=1
    while [ $n -le $TURNS ]; do one $s $n; n=$((n + 1)); done
done
echo "park: $(wc -l <"$out/verdicts.txt") turns in the state"
