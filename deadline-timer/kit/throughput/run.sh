#!/usr/bin/env bash
# Runs on the c-48. One variant, several profiles, every run recorded (after the investigation's
# run3.sh, with json-comp and a long staged run added).
# Usage: LABEL=x SERVER_ENV="-e A=b" run.sh <image> <profile>[,<profile>...] [runs]
#   profile = name[@connections]; names: baseline json-comp async async-staged async-staged40 spool
# Options (environment): ECHO=1 (start the pooled service on ECHO_CPUS), OUT (results file).
set -uo pipefail

ROOT=/root/work/arena/HttpArena
REQ=$ROOT/requests
IMAGE=$1
PROFILES=$2
RUNS=${3:-3}
SERVER_CPUS=${SERVER_CPUS:-0-23}
LOAD_CPUS=${LOAD_CPUS:-24-47}
THREADS=${THREADS:-24}
LABEL=${LABEL:-run}
OUT=${OUT:-/root/dl/results.tsv}
RAW=/root/dl/raw
NAME=arena-server
ECHO_NAME=arena-echo
ECHO_CPUS=${ECHO_CPUS:-40-47}
mkdir -p "$RAW"

start_server() {
    docker rm -f -v "$NAME" >/dev/null 2>&1
    if [ -n "${ECHO:-}" ]; then
        docker rm -f -v "$ECHO_NAME" >/dev/null 2>&1
        docker run -d --name "$ECHO_NAME" --network host --cpuset-cpus="$ECHO_CPUS" \
            --ulimit nofile=1048576:1048576 -e ARENA_MODE=echo httparena-corten:base >/dev/null || { echo "echo start failed"; exit 1; }
        sleep 1
    fi
    docker run -d --name "$NAME" --network host \
        --cpuset-cpus="$SERVER_CPUS" \
        --ulimit memlock=-1:-1 --ulimit nofile=1048576:1048576 \
        -v "$ROOT/data/dataset.json:/data/dataset.json:ro" \
        -v "$ROOT/data/static:/data/static:ro" \
        -v "$ROOT/certs:/certs:ro" \
        ${SERVER_ENV:-} "$IMAGE" >/dev/null || { echo "server start failed"; exit 1; }
    if docker run --rm --network host busybox sh -c \
        'for i in $(seq 1 50); do wget -q -O /dev/null "http://localhost:8080/baseline11?a=1&b=2" && exit 0; sleep 0.2; done; exit 1'; then
        return 0
    fi
    echo "server did not answer on 8080"; docker logs "$NAME" 2>&1 | tail -20
    docker rm -f -v "$NAME" >/dev/null 2>&1; exit 1
}

gc() {
    docker run --rm --network host --cpuset-cpus="$LOAD_CPUS" \
        --security-opt seccomp=unconfined \
        --ulimit memlock=-1:-1 --ulimit nofile=1048576:1048576 \
        -v "$REQ:$REQ:ro" httparena-gcannon:gap "$@" 2>&1
}

args_for() {
    local c=$2
    case "$1" in
        baseline)       echo "http://localhost:8080 --raw $REQ/get.raw,$REQ/post_cl.raw,$REQ/post_chunked.raw -c ${c:-4096} -t $THREADS -d 5s -p 1" ;;
        json-comp)      echo "http://localhost:8080 --raw $REQ/json-gzip-25.raw,$REQ/json-gzip-40.raw,$REQ/json-gzip-50.raw -c ${c:-4096} -t $THREADS -d 5s -p 1 -r 25" ;;
        async)          echo "http://localhost:8080 --raw $REQ/async-delay.raw -c ${c:-32000} -t $THREADS -d 10s -p 1" ;;
        async-staged)   echo "http://localhost:8080 --raw $REQ/pcc-sdelay.raw -c ${c:-32000} -t $THREADS -d 10s -p 1" ;;
        async-staged40) echo "http://localhost:8080 --raw $REQ/pcc-sdelay.raw -c ${c:-32000} -t $THREADS -d 40s -p 1" ;;
        spool)          echo "http://localhost:8080 --raw $REQ/pcc-spool.raw -c ${c:-4096} -t $THREADS -d 8s -p 1" ;;
        *) echo "" ;;
    esac
}

cpu_usec() {
    local id; id=$(docker inspect -f '{{.Id}}' "$NAME")
    awk '/^usage_usec/ {print $2}' "/sys/fs/cgroup/system.slice/docker-$id.scope/cpu.stat" 2>/dev/null || echo 0
}

start_server
IFS=',' read -ra LIST <<< "$PROFILES"
for spec in "${LIST[@]}"; do
    p=${spec%@*}; c=""; [ "$spec" != "$p" ] && c=${spec#*@}
    a=$(args_for "$p" "$c"); [ -n "$a" ] || { echo "unknown profile $p"; continue; }
    for run in $(seq 1 "$RUNS"); do
        tag="$LABEL.$spec.$run"
        c0=$(cpu_usec)
        # shellcheck disable=SC2086
        out=$(gc $a)
        c1=$(cpu_usec)
        dur=$(echo "$out" | grep -oP '(?:requests|frames sent) in \K[\d.]+' | head -1)
        ok=$(echo "$out" | grep -oP '2xx=\K\d+' | head -1)
        rps=$(awk -v ok="${ok:-0}" -v d="${dur:-1}" 'BEGIN{printf "%d", ok/d}')
        avg=$(echo "$out" | grep Latency | head -1 | awk '{print $2}')
        p99=$(echo "$out" | grep Latency | head -1 | awk '{print $5}')
        bad=$(echo "$out" | grep -oP '[45]xx=\d+' | tr '\n' ' ')
        rec=$(echo "$out" | grep -oP 'Reconnects: \K\d+' | head -1)
        us=$(awk -v a="$c0" -v b="$c1" -v n="${ok:-0}" 'BEGIN{ if (n>0) printf "%.2f", (b-a)/n; else print "na"}')
        mem=$(docker stats --no-stream --format '{{.MemUsage}}' "$NAME" | awk '{print $1}')
        { echo "### ${PASS:-}$tag"; echo "$out"; } >> "$RAW/$LABEL.log"
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${PASS:-}" "$LABEL" "$spec" "$run" "$rps" "${avg:-na}" "${p99:-na}" "$us" "${bad}rc=${rec:-0} mem=$mem" | tee -a "$OUT"
        sleep 1
    done
done
docker rm -f -v "$NAME" >/dev/null 2>&1
[ -n "${ECHO:-}" ] && docker rm -f -v "$ECHO_NAME" >/dev/null 2>&1
exit 0
