#!/usr/bin/env bash
# Runs on the droplet. One variant, several profiles, every run recorded.
# Usage: LABEL=x SERVER_ENV="-e A=b" run2.sh <image> <profile>[,<profile>...] [runs]
#   profile = name[@connections]; names: baseline async async-staged async0 pool spool
# Options (environment): PERF=stat|record (on the first run of each profile), ECHO=1 (start the
# pooled service on ECHO_CPUS), OUT (results file, default /root/pcc/results.tsv).
set -uo pipefail

ROOT=/root/work/httparena-gap/HttpArena
REQ=$ROOT/requests
IMAGE=$1
PROFILES=$2
RUNS=${3:-3}
SERVER_CPUS=${SERVER_CPUS:-0-23}
LOAD_CPUS=${LOAD_CPUS:-24-47}
THREADS=${THREADS:-24}
LABEL=${LABEL:-run}
OUT=${OUT:-/root/pcc/results.tsv}
RAW=/root/pcc/raw
NAME=httparena-gap-server
ECHO_NAME=httparena-gap-echo
ECHO_CPUS=${ECHO_CPUS:-40-47}
ECHO_IMAGE=${ECHO_IMAGE:-$IMAGE}
mkdir -p "$RAW"

start_server() {
    docker rm -f -v "$NAME" >/dev/null 2>&1
    if [ -n "${ECHO:-}" ]; then
        docker rm -f -v "$ECHO_NAME" >/dev/null 2>&1
        docker run -d --name "$ECHO_NAME" --network host --cpuset-cpus="$ECHO_CPUS" \
            --ulimit nofile=1048576:1048576 -e ARENA_MODE=echo ${ECHO_ENV:-} "$ECHO_IMAGE" >/dev/null || { echo "echo start failed"; exit 1; }
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

# name, connections ("" for the profile's own)
args_for() {
    local c=$2
    case "$1" in
        baseline)     echo "http://localhost:8080 --raw $REQ/get.raw,$REQ/post_cl.raw,$REQ/post_chunked.raw -c ${c:-4096} -t $THREADS -d 5s -p 1" ;;
        async)        echo "http://localhost:8080 --raw $REQ/async-delay.raw -c ${c:-32000} -t $THREADS -d 10s -p 1" ;;
        json)         echo "http://localhost:8080 --raw $REQ/json-get.raw -c ${c:-4096} -t $THREADS -d 5s -p 1" ;;
        async30)      echo "http://localhost:8080 --raw $REQ/async-delay.raw -c ${c:-32000} -t $THREADS -d 30s -p 1" ;;
        async-staged) echo "http://localhost:8080 --raw $REQ/pcc-sdelay.raw -c ${c:-32000} -t $THREADS -d 10s -p 1" ;;
        async0)       echo "http://localhost:8080 --raw $REQ/pcc-delay0.raw -c ${c:-32000} -t $THREADS -d 10s -p 1" ;;
        pool)         echo "http://localhost:8080 --raw $REQ/pcc-pool.raw -c ${c:-4096} -t $THREADS -d 8s -p 1" ;;
        spool)        echo "http://localhost:8080 --raw $REQ/pcc-spool.raw -c ${c:-4096} -t $THREADS -d 8s -p 1" ;;
        *) echo "" ;;
    esac
}

cpu_usec() {
    local id; id=$(docker inspect -f '{{.Id}}' "$NAME")
    local f
    for f in /sys/fs/cgroup/system.slice/docker-$id.scope/cpu.stat /sys/fs/cgroup/docker/$id/cpu.stat; do
        [ -r "$f" ] && { awk '/^usage_usec/ {print $2}' "$f"; return; }
    done
    echo 0
}

# user and system microseconds of the server's cgroup
cpu_split() {
    local id; id=$(docker inspect -f '{{.Id}}' "$NAME")
    awk '/^user_usec/ {u=$2} /^system_usec/ {s=$2} END {print u, s}' "/sys/fs/cgroup/system.slice/docker-$id.scope/cpu.stat"
}

# microseconds of the pooled service's cgroup, 0 without one
echo_usec() {
    [ -n "${ECHO:-}" ] || { echo 0; return; }
    local id; id=$(docker inspect -f '{{.Id}}' "$ECHO_NAME")
    awk '/^usage_usec/ {print $2}' "/sys/fs/cgroup/system.slice/docker-$id.scope/cpu.stat"
}

# Busy share of each server core between two /proc/stat snapshots: "min med max" in percent,
# and the whole list to the raw directory.
busy() {
    python3 - "$1" "$2" "$SERVER_CPUS" "$3" <<'PY'
import sys
def read(p):
    d = {}
    for line in open(p):
        f = line.split()
        if f[0].startswith("cpu") and f[0] != "cpu":
            v = list(map(int, f[1:9]))
            d[int(f[0][3:])] = (sum(v), v[3] + v[4])
    return d
a, b = read(sys.argv[1]), read(sys.argv[2])
lo, hi = map(int, sys.argv[3].split("-"))
out = []
for c in range(lo, hi + 1):
    total = b[c][0] - a[c][0]
    idle = b[c][1] - a[c][1]
    out.append(100.0 * (total - idle) / total if total else 0.0)
open(sys.argv[4], "w").write(" ".join(f"{x:.0f}" for x in out) + "\n")
s = sorted(out)
print(f"{s[0]:.0f}/{s[len(s)//2]:.0f}/{s[-1]:.0f}")
PY
}

start_server
PID=$(docker inspect -f '{{.State.Pid}}' "$NAME")
IFS=',' read -ra LIST <<< "$PROFILES"
for spec in "${LIST[@]}"; do
    p=${spec%@*}; c=""; [ "$spec" != "$p" ] && c=${spec#*@}
    a=$(args_for "$p" "$c"); [ -n "$a" ] || { echo "unknown profile $p"; continue; }
    for run in $(seq 1 "$RUNS"); do
        tag="$LABEL.$spec.$run"
        c0=$(cpu_usec); read -r u0 s0 <<< "$(cpu_split)"
        e0=$(echo_usec); w0=$(date +%s.%N)
        cat /proc/stat > "$RAW/$tag.stat0"
        perfpid=""
        if [ "$run" = 1 ] && [ "${PERF:-}" = stat ]; then
            ( sleep 2; perf stat -p "$PID" -e task-clock,context-switches,cpu-migrations,cycles,instructions,cache-misses -o "$RAW/$tag.perfstat" -- sleep 2.5 ) >/dev/null 2>&1 &
            perfpid=$!
        elif [ "$run" = 1 ] && [ "${PERF:-}" = record ]; then
            ( sleep 2; perf record -F 999 -g -p "$PID" -o "/root/pcc/perf/$LABEL.$spec.data" -- sleep 2.5 ) >/dev/null 2>&1 &
            perfpid=$!
        fi
        # shellcheck disable=SC2086
        out=$(gc $a)
        cat /proc/stat > "$RAW/$tag.stat1"
        e1=$(echo_usec); w1=$(date +%s.%N)
        ecores=$(awk -v a="$e0" -v b="$e1" -v t0="$w0" -v t1="$w1" 'BEGIN{printf "%.1f", (b-a)/1e6/(t1-t0)}')
        scores=$(awk -v a="$c0" -v b="$(cpu_usec)" -v t0="$w0" -v t1="$w1" 'BEGIN{printf "%.1f", (b-a)/1e6/(t1-t0)}')
        c1=$(cpu_usec); read -r u1 s1 <<< "$(cpu_split)"
        [ -n "$perfpid" ] && wait "$perfpid"
        dur=$(echo "$out" | grep -oP '(?:requests|frames sent) in \K[\d.]+' | head -1)
        ok=$(echo "$out" | grep -oP '2xx=\K\d+' | head -1)
        rps=$(awk -v ok="${ok:-0}" -v d="${dur:-1}" 'BEGIN{printf "%d", ok/d}')
        avg=$(echo "$out" | grep Latency | head -1 | awk '{print $2}')
        p99=$(echo "$out" | grep Latency | head -1 | awk '{print $5}')
        bad=$(echo "$out" | grep -oP '[45]xx=\d+' | tr '\n' ' ')
        rec=$(echo "$out" | grep -oP 'Reconnects: \K\d+' | head -1)
        us=$(awk -v a="$c0" -v b="$c1" -v n="${ok:-0}" 'BEGIN{ if (n>0) printf "%.2f", (b-a)/n; else print "na"}')
        sys=$(awk -v a="$s0" -v b="$s1" -v ua="$u0" -v ub="$u1" 'BEGIN{ t=(b-a)+(ub-ua); if (t>0) printf "%.0f", 100*(b-a)/t; else print "na"}')
        cores=$(busy "$RAW/$tag.stat0" "$RAW/$tag.stat1" "$RAW/$tag.cores")
        { echo "### $tag"; echo "$out"; } >> "$RAW/$LABEL.log"
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$LABEL" "$spec" "$run" "$rps" "${avg:-na}" "${p99:-na}" "$us" "$sys" "$cores" "${bad}rc=${rec:-0} server=${scores}c echo=${ecores}c" | tee -a "$OUT"
        sleep 1
    done
done
docker rm -f -v "$NAME" >/dev/null 2>&1
[ -n "${ECHO:-}" ] && docker rm -f -v "$ECHO_NAME" >/dev/null 2>&1
exit 0
