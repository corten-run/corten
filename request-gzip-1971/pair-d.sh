#!/usr/bin/env bash
# Runs on the droplet: paired cycles per request for two images under one load profile.
# Each pair runs both builds, the order alternating; each run starts a fresh server,
# warms it for 2 s, then counts the server's cycles (user and kernel) and user
# instructions with perf stat over one load run, divided by the requests it answered.
# Before the pairs, the two builds' answers to the profile's request are compared
# (status, headers but Date, body).
# Usage: pair.sh <imageA> <imageB> <profile> <pairs>     SERVER_ENV for both.
set -uo pipefail
A=$1; B=$2; PROFILE=$3; PAIRS=${4:-6}
ROOT=/root/work/httparena-gap/HttpArena; REQ=$ROOT/requests
SERVER_CPUS=${SERVER_CPUS:-0-23}; LOAD_CPUS=${LOAD_CPUS:-24-47}; THREADS=${THREADS:-24}; CONNS=${CONNS:-4096}
SECS=${SECS:-8}
NAME=httparena-gap-server
L=()
case "$PROFILE" in
    get-only)  TARGET=(http://localhost:8080 --raw "$REQ/get.raw"); PROBE=(-s -i "http://localhost:8080/baseline11?a=13&b=42") ;;
    baseline)  TARGET=(http://localhost:8080 --raw "$REQ/get.raw,$REQ/post_cl.raw,$REQ/post_chunked.raw"); PROBE=(-s -i "http://localhost:8080/baseline11?a=13&b=42") ;;
    plain-get) TARGET=(http://localhost:8080/pipeline); PROBE=(-s -i http://localhost:8080/pipeline) ;;
    json-gzbr) TARGET=(http://localhost:8080 --raw "$REQ/json-gzip-25.raw,$REQ/json-gzip-40.raw,$REQ/json-gzip-50.raw"); PROBE=(-s -i --compressed -H "Accept-Encoding: gzip, br" "http://localhost:8080/json/50?m=4") ;;
    json-zstd) TARGET=(http://localhost:8080 --raw "$REQ/json-zstd-25.raw,$REQ/json-zstd-40.raw,$REQ/json-zstd-50.raw"); PROBE=(-s -i --compressed -H "Accept-Encoding: gzip, deflate, br, zstd" "http://localhost:8080/json/50?m=4") ;;
    *) echo "unknown profile"; exit 1 ;;
esac
gc() {
    docker run --rm --network host "${L[@]}" --cpuset-cpus="$LOAD_CPUS" --security-opt seccomp=unconfined \
        --ulimit memlock=-1:-1 --ulimit nofile=1048576:1048576 -v "$REQ:$REQ:ro" httparena-gcannon:gap \
        "${TARGET[@]}" -c "$CONNS" -t "$THREADS" -d "$1" -p 1 2>&1
}
start() {
    docker rm -f -v "$NAME" >/dev/null 2>&1
    docker run -d --name "$NAME" --network host "${L[@]}" --cpuset-cpus="$SERVER_CPUS" --ulimit nofile=1048576:1048576 \
        -v "$ROOT/data/dataset.json:/data/dataset.json:ro" -v "$ROOT/certs:/certs:ro" ${SERVER_ENV:-} "$1" >/dev/null
    for i in $(seq 1 100); do curl -sf -o /dev/null "http://localhost:8080/baseline11?a=1&b=2" && return 0; sleep 0.1; done
    echo "no answer"; return 1
}
one() {
    local image=$1
    start "$image" || exit 1
    gc 2s >/dev/null
    local stat; stat=$(mktemp)
    docker run --rm --privileged --pid=container:"$NAME" "${L[@]}" httparena-gap-perf:gap \
        perf stat -x, -p 1 -e cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u -- sleep $((SECS + 3)) > "$stat" 2>&1 &
    local perf=$!
    sleep 1
    local out; out=$(gc "${SECS}s")
    wait $perf
    local ok bad
    ok=$(echo "$out" | grep -oP '2xx=\K\d+' | head -1)
    bad=$(echo "$out" | grep -oP '[45]xx=\K\d+' | paste -sd+ | bc)
    # value,unit,event,run-time,percentage
    awk -F, -v ok="${ok:-0}" -v bad="${bad:-0}" -v image="$image" '
        $3=="cycles:u" {cu=$1; pu=$5} $3=="cycles:k" {ck=$1; pk=$5} $3=="instructions:u" {iu=$1; pi=$5} $3 ~ /^L1-icache-load-misses/ {l1=$1; pl=$5}
        END { if (ok==0) { print image, "no requests"; exit }
              printf "%s requests=%d failed=%d cycles_user=%.0f cycles_kernel=%.0f total=%.0f instr_user=%.0f l1i_user=%.1f running=%s/%s/%s/%s\n",
                     image, ok, bad, cu/ok, ck/ok, (cu+ck)/ok, iu/ok, l1/ok, pu, pk, pi, pl }' "$stat"
    rm -f "$stat"
    docker rm -f -v "$NAME" >/dev/null 2>&1
}
echo "# $(date -u +%H:%M:%S) $PROFILE pairs=$PAIRS secs=$SECS conns=$CONNS load=$(cut -d' ' -f1 /proc/loadavg) env=${SERVER_ENV:-}"
start "$A" && curl "${PROBE[@]}" | grep -viE "${PROBE_SKIP:-^date:}" > /tmp/pair-a.txt
start "$B" && curl "${PROBE[@]}" | grep -viE "${PROBE_SKIP:-^date:}" > /tmp/pair-b.txt
docker rm -f -v "$NAME" >/dev/null 2>&1
if cmp -s /tmp/pair-a.txt /tmp/pair-b.txt && [ -s /tmp/pair-a.txt ]; then
    echo "# answers identical but ${PROBE_SKIP:-Date} ($(wc -c < /tmp/pair-a.txt) bytes, $(grep -c ':' /tmp/pair-a.txt) header lines)"
else
    echo "# ANSWERS DIFFER"; diff /tmp/pair-a.txt /tmp/pair-b.txt | head -20
fi
for i in $(seq 1 "$PAIRS"); do
    if [ $((i % 2)) = 1 ]; then first=$A; second=$B; else first=$B; second=$A; fi
    echo "pair $i: $(one "$first")"
    echo "pair $i: $(one "$second")"
done
echo "# done $(date -u +%H:%M:%S)"
