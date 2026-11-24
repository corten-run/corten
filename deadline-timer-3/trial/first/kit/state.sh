#!/bin/sh
# state.sh <out dir>: for the workload `after` alone, before anything is counted (run.sh runs it
# after verify.sh): shows from the packets of whole turns that the load reaches the state the plan
# declares the workload for, and keeps it. For each side the part reads (the base; in the gated
# part the head too), TURNS (3) times: the side's unpadded binary is started as a turn starts it
# (pinned to CPU 2, jemalloc preloaded), tcpdump on CPU 7 records every packet with data sent to
# its port, and the turn's own load is sent (wrk -t2 -c64 for TURN s on CPUs 4 and 5 with
# lua/after.lua); state.mjs then reads each connection's requests in order and holds them to its
# rule: 64 connections, each sending at least three requests for /wait before its first for
# /private, none for /wait after, and nothing else. A capture that dropped a packet, a wrk error,
# or a turn that breaks the rule stops the run. No counter is read here and nothing is recorded as
# a measurement; a turn under tcpdump is not a turn of a placement. Writes <out dir>/<side>-<n>/
# (wrk's output, tcpdump's, state.mjs's verdict) and <out dir>/verdicts.txt.
set -eu
out=$1
W=after
. /m/dl/plan.sh
TURNS=3
port=18083; cap=/dev/shm/dl-state.pcap
mkdir -p "$out"; : >"$out/verdicts.txt"
fail() { echo "STATE FAILED: $*"; exit 1; }
command -v tcpdump >/dev/null || fail "no tcpdump"
! curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null || fail "something already answers on $port"
one() { # <side> <n>
    d=$out/$1-$2; mkdir -p "$d"; rm -f $cap
    PORT=$port taskset -c 2 sh -c "exec $J $P/bin/$1 \$PORT plain" >/dev/null 2>"$d/serve.log" &
    pid=$!
    i=0
    until curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null; do
        i=$((i + 1)); [ $i -lt 100 ] || { kill $pid; fail "nothing answers on $port"; }; sleep 0.1
    done
    taskset -c 7 tcpdump -i lo -n -B 262144 -s 128 -w $cap \
        "tcp dst port $port and (((ip[2:2] - ((ip[0]&0xf)<<2)) - ((tcp[12]&0xf0)>>2)) != 0)" 2>"$d/tcpdump.txt" &
    dump=$!
    i=0
    until grep -q 'listening on' "$d/tcpdump.txt"; do
        i=$((i + 1)); [ $i -lt 100 ] || { kill $pid $dump; fail "tcpdump did not start: $(cat "$d/tcpdump.txt")"; }; sleep 0.1
    done
    taskset -c 4,5 wrk -t2 -c64 -d"${TURN}s" -s $P/lua/after.lua "http://127.0.0.1:$port/private" >"$d/wrk.txt" || true
    sleep 0.5
    kill -INT $dump; wait $dump 2>/dev/null || true
    kill $pid; wait $pid 2>/dev/null || true
    grep -q '^0 packets dropped by kernel' "$d/tcpdump.txt" || fail "$1 turn $2: the capture is not whole: $(tail -3 "$d/tcpdump.txt" | paste -sd';' -)"
    set -- "$1" "$2" $(sed -n 's/^RESULT //p' "$d/wrk.txt")
    [ $# -eq 8 ] || fail "$1 turn $2: no RESULT line from wrk: $(grep '^AFTER' "$d/wrk.txt" | paste -sd';' -)"
    [ "$4$5$6$7$8" = 00000 ] || fail "$1 turn $2: wrk errors: $*"
    node $P/state.mjs $cap $port >"$d/state.txt" || { cat "$d/state.txt"; rm -f $cap; fail "$1 turn $2: the load did not reach or keep the state"; }
    rm -f $cap
    echo "$1 turn $2: $3 requests, no error; $(grep '^AFTER' "$d/wrk.txt" | paste -sd';' -); $(head -1 "$d/state.txt")" | tee -a "$out/verdicts.txt"
}
for s in $SIDES; do
    n=1
    while [ $n -le $TURNS ]; do one $s $n; n=$((n + 1)); done
done
echo "state: $(wc -l <"$out/verdicts.txt") turns reach and keep the state"
