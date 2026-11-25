#!/usr/bin/env bash
# Runs on the 48-CPU host. One workload of tp48-plan.md: ROUNDS rounds, one run of each build (and
# each condition) a round, a new server for every run, the builds in the order given in odd rounds
# and in the opposite order in even rounds. A run that fails stops the workload.
# Usage: run48.sh <workload> [rounds]
set -uo pipefail
cd /root/t48
W=$1; ROUNDS=${2:-10}
ROOT=/root/t48/HttpArena
REQ=/root/t48/req
OUT=${OUT:-/root/t48/results.tsv}
RAW=/root/t48/raw
NAME=t48-server
mkdir -p "$RAW"

# The workload's settings.
SRV=0-23; MODE=default; WORKERS=; LOADCPUS=24-47; T=24; C=32000; D=10; RAWF=sdelay10; PERF=0; KIND=gcannon
BUILDS="base head old oldbase base2"; CONDS=one
case $W in
    a10)   PERF=1 ;;
    a40)   PERF=1; D=40 ;;
    b1024) C=1024 ;;
    b8192) C=8192 ;;
    c4)    SRV=0-3; WORKERS=4 ;;
    c16)   SRV=0-15; WORKERS=16 ;;
    c48)   WORKERS=48 ;;
    f10)   MODE=percore-by-hand ;;
    d64)   RAWF=get; C=64; PERF=1; BUILDS="base head old base2"; CONDS="quiet wait" ;;
    d1024) RAWF=get; C=1024; PERF=1; BUILDS="base head old base2"; CONDS="quiet wait" ;;
    em)    KIND=wrk; BUILDS="base head old base2"; CONDS="none idle3" ;;
    es)    KIND=wrk; SRV=0; MODE=percore-by-hand; BUILDS="base head old base2"; CONDS="none idle3" ;;
    *) echo "no such workload: $W"; exit 2 ;;
esac

start_server() {
    docker rm -f -v $NAME >/dev/null 2>&1
    docker run -d --name $NAME --network host --cpuset-cpus="$SRV" \
        --ulimit memlock=-1:-1 --ulimit nofile=1048576:1048576 \
        -v "$ROOT/data/dataset.json:/data/dataset.json:ro" -v "$ROOT/data/static:/data/static:ro" -v "$ROOT/certs:/certs:ro" \
        -e ARENA_MODE=$MODE ${WORKERS:+-e ARENA_WORKERS=$WORKERS} "t48:$1" >/dev/null || return 1
    for i in $(seq 1 100); do
        curl -s -o /dev/null -m 1 "http://127.0.0.1:8080/baseline11?a=1&b=2" && return 0
        sleep 0.1
    done
    docker logs $NAME 2>&1 | tail -5
    return 1
}
cpu_usec() {
    awk '/^usage_usec/ {print $2}' "/sys/fs/cgroup/system.slice/docker-$1.scope/cpu.stat" 2>/dev/null || echo 0
}
load() {
    local wrap=()
    [ $PERF = 1 ] && wrap=(perf stat -a -C "$SRV" -e cycles,instructions -x, -o "$RAW/perf.tmp" --)
    rm -f "$RAW/perf.tmp"
    if [ $KIND = gcannon ]; then
        "${wrap[@]}" docker run --rm --network host --cpuset-cpus="$LOADCPUS" --security-opt seccomp=unconfined \
            --ulimit memlock=-1:-1 --ulimit nofile=1048576:1048576 -v "$REQ:$REQ:ro" httparena-gcannon:gap \
            http://localhost:8080 --raw "$REQ/$RAWF.raw" -c $C -t $T -d ${D}s -p 1 2>&1
    else
        taskset -c 24 wrk -t1 -c1 -d${D}s --latency "http://127.0.0.1:8080/baseline11?a=1&b=2" 2>&1
    fi
}

# One run: a new server of the build's image, the condition set up, the load, the server removed.
run() {
    local round=$1 pos=$2 build=$3 cond=$4 image=$3 note="" wp="" answered=""
    [ "$build" = base2 ] && image=base
    start_server $image || { echo "FAILED $W r$round $build $cond: the server did not start"; return 1; }
    local id pid threads c0 c1 out
    id=$(docker inspect -f '{{.Id}}' $NAME); pid=$(docker inspect -f '{{.State.Pid}}' $NAME)
    case $cond in
        wait)
            taskset -c 47 python3 /root/t48/waiters.py 48 /sdelay/1 > "$RAW/waiters.tmp" 2>&1 &
            wp=$!
            sleep 2 ;;
        quiet) sleep 2 ;;
        idle3)
            exec 3<>/dev/tcp/127.0.0.1/8080
            for i in 1 2 3; do printf 'GET /sdelay/1 HTTP/1.1\r\nHost: localhost\r\n\r\n' >&3; sleep 0.1; done
            answered=$(timeout 0.3 cat <&3 | grep -ao 'HTTP/1.1 200' | wc -l)
            [ "$answered" = 3 ] || note="${note}idle connection answered $answered;" ;;
        none) sleep 0.6 ;;
    esac
    c0=$(cpu_usec $id)
    out=$(load)
    c1=$(cpu_usec $id)
    threads=$(ls /proc/$pid/task 2>/dev/null | wc -l)
    if [ -n "$wp" ]; then
        kill -TERM $wp; wait $wp 2>/dev/null
        local wl; wl=$(cat "$RAW/waiters.tmp")
        echo "$wl" | grep -q "bad=0 late=0 closed=0" || note="${note}waiters: $wl;"
        local least; least=$(echo "$wl" | grep -oP 'least=\K\d+'); [ "${least:-0}" -ge $D ] || note="${note}waiters answered least ${least:-none};"
        out="$out"$'\n'"$wl"
    fi
    [ "$cond" = idle3 ] && exec 3<&-
    docker rm -f -v $NAME >/dev/null 2>&1
    local rps avg p50 p99 n
    if [ $KIND = gcannon ]; then
        local dur ok resp other rec
        dur=$(echo "$out" | grep -oP 'requests in \K[\d.]+' | head -1)
        ok=$(echo "$out" | grep -oP '2xx=\K\d+' | head -1)
        resp=$(echo "$out" | grep -oP 'requests in [\d.]+s, \K\d+(?= responses)' | head -1)
        other=$(echo "$out" | grep -oP '[345]xx=\K\d+' | awk '{s += $1} END {print s + 0}')
        rec=$(echo "$out" | grep -oP 'Reconnects: \K\d+' | head -1)
        [ -n "$dur" ] && [ -n "$ok" ] && [ "${ok:-0}" -gt 0 ] || note="${note}no result;"
        [ "${resp:-x}" = "${ok:-y}" ] || note="${note}responses ${resp:-none} of which 2xx ${ok:-none};"
        [ "$other" = 0 ] || note="${note}not 2xx: $other;"
        [ "${rec:-0}" = 0 ] || note="${note}reconnects $rec;"
        rps=$(awk -v ok="${ok:-0}" -v d="${dur:-1}" 'BEGIN {printf "%.0f", ok / d}')
        avg=$(echo "$out" | awk '$1 == "Latency" {print $2; exit}')
        p50=$(echo "$out" | awk '$1 == "Latency" {print $3; exit}')
        p99=$(echo "$out" | awk '$1 == "Latency" {print $5; exit}')
        n=${ok:-0}
    else
        rps=$(echo "$out" | awk '/^Requests\/sec/ {print $2}')
        avg=$(echo "$out" | awk '$1 == "Latency" {print $2; exit}')
        p50=$(echo "$out" | awk '$1 == "50%" {print $2}')
        p99=$(echo "$out" | awk '$1 == "99%" {print $2}')
        n=$(echo "$out" | grep -oP '^\s*\K\d+(?= requests in)')
        [ -n "$rps" ] || note="${note}no result;"
        echo "$out" | grep -qE "Socket errors|Non-2xx" && note="${note}$(echo "$out" | grep -E 'Socket errors|Non-2xx' | tr -s ' ' | tr '\n' ' ');"
    fi
    local us cyc ins
    us=$(awk -v a="$c0" -v b="$c1" -v n="${n:-0}" 'BEGIN {if (n > 0) printf "%.2f", (b - a) / n; else print "na"}')
    cyc=na; ins=na
    if [ -f "$RAW/perf.tmp" ]; then
        cyc=$(awk -F, -v n="${n:-0}" '$3 ~ /^cycles/ && $1 ~ /^[0-9]+$/ && n > 0 {printf "%.0f", $1 / n}' "$RAW/perf.tmp"); cyc=${cyc:-na}
        ins=$(awk -F, -v n="${n:-0}" '$3 ~ /^instructions/ && $1 ~ /^[0-9]+$/ && n > 0 {printf "%.0f", $1 / n}' "$RAW/perf.tmp"); ins=${ins:-na}
        out="$out"$'\n'"$(grep -v '^#' "$RAW/perf.tmp")"
    fi
    { echo "### $W r$round $pos $build $cond"; echo "$out"; } >> "$RAW/$W.log"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$W" "$round" "$pos" "$build" "$cond" "${rps:-na}" "${avg:-na}" "${p50:-na}" "${p99:-na}" "$us" "$cyc" "$ins" "$threads" "${note:-ok}" | tee -a "$OUT"
    [ -z "$note" ] || { echo "FAILED $W r$round $build $cond: $note"; return 1; }
    sleep 1
}

if [ $KIND = wrk ]; then LOADSAYS="wrk, 1 connection, 1 thread on CPU 24, ${D} s, GET /baseline11"; else LOADSAYS="gcannon, $C connections, $T threads on $LOADCPUS, ${D} s, $RAWF"; fi
echo "# $W START $(date -u +%T) load $(cut -d' ' -f1 /proc/loadavg) rounds $ROUNDS; server CPUs $SRV, $MODE${WORKERS:+, $WORKERS workers}; $LOADSAYS; builds $BUILDS; conditions $CONDS"
for round in $(seq 1 "$ROUNDS"); do
    order=$BUILDS; conds=$CONDS
    if [ $((round % 2)) = 0 ]; then
        order=$(echo $BUILDS | tr ' ' '\n' | tac | tr '\n' ' ')
        conds=$(echo $CONDS | tr ' ' '\n' | tac | tr '\n' ' ')
    fi
    pos=0
    for build in $order; do
        for cond in $conds; do
            pos=$((pos + 1))
            run $round $pos $build $cond || { echo "# $W STOPPED $(date -u +%T)"; docker rm -f -v $NAME >/dev/null 2>&1; exit 1; }
        done
    done
done
echo "# $W DONE $(date -u +%T)"
