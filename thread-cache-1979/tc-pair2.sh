#!/usr/bin/env bash
# Runs on the check droplet: paired cycles a request for one image under two allocator settings
# (the same binary, so placement is not a variable). Each turn starts the app afresh on one CPU,
# warms it for 2 s, then counts its user and kernel cycles and user instructions with perf stat
# over a 3 s wrk run from two other CPUs; the settings' order turns every pair.
# The two settings are A and B (tc64k and tc512k unless set), and the answers are compared but
# Date and ETag: the app's weak tag differs between any two starts.
# Usage: tc-pair2.sh <image> <fixture dir> <accept-encoding> <pairs> <out log>
set -uo pipefail
IMAGE=$1; FIX=$2; ENC=$3; PAIRS=$4; OUT=$5
declare -A CONF=([tc64k]="background_thread:true,tcache_max:65536" [tc512k]="background_thread:true,tcache_max:524288" [tc64kb]="background_thread:true,tcache_max:65536" [tc1m]="background_thread:true,tcache_max:1048576")
A=${A:-tc64k}; B=${B:-tc512k}
SERVER_CPU=2; LOAD_CPUS=4,5; PERF_CPU=7; PORT=18495
URL=http://127.0.0.1:$PORT/items/item_5
start() {
    docker rm -f -v tc-app >/dev/null 2>&1
    docker run -d --name tc-app --cpuset-cpus "$SERVER_CPU" --memory 1g --ulimit nofile=65536:65536 -p $PORT:8080 -e "MALLOC_CONF=${CONF[$1]}" \
        -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e AGENT_ORIGINS=http://127.0.0.1:$PORT -e EMBED_ORIGINS=http://127.0.0.1:$PORT \
        -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "$FIX:/fixtures:ro" "$IMAGE" >/dev/null
    for i in $(seq 1 100); do curl -sf -o /dev/null "$URL" && return 0; sleep 0.1; done
    echo "no answer"; return 1
}
load() { taskset -c "$LOAD_CPUS" wrk -t2 -c64 -d"$1" -H "Accept-Encoding: $ENC" "$URL" 2>&1; }
one() {
    start "$1" || exit 1
    load 2s >/dev/null
    local pid stat out ok bad
    pid=$(docker inspect -f '{{.State.Pid}}' tc-app); stat=$(mktemp)
    taskset -c "$PERF_CPU" perf stat -x, -e cycles:u,cycles:k,instructions:u -p "$pid" -o "$stat" -- sleep 3.4 &
    local perf=$!
    sleep 0.2
    out=$(load 3s)
    wait $perf
    ok=$(echo "$out" | grep -oP '^\s*\K\d+(?= requests in)')
    bad=$(echo "$out" | grep -oP 'Non-2xx or 3xx responses: \K\d+'); bad=$((${bad:-0} + $(echo "$out" | grep -c 'Socket errors')))
    awk -F, -v ok="${ok:-0}" -v bad="$bad" -v label="$1" '
        $3=="cycles:u" {cu=$1; pu=$5} $3=="cycles:k" {ck=$1; pk=$5} $3=="instructions:u" {iu=$1; pi=$5}
        END { if (ok==0) { print label, "no requests"; exit }
              printf "%s requests=%d failed=%d cycles_user=%.0f cycles_kernel=%.0f total=%.0f instr_user=%.0f running=%s/%s/%s\n",
                     label, ok, bad, cu/ok, ck/ok, (cu+ck)/ok, iu/ok, pu, pk, pi }' "$stat"
    rm -f "$stat"
}
{
    echo "# $(date -u +%H:%M:%S) $(basename "$FIX") enc=$ENC pairs=$PAIRS load=$(cut -d' ' -f1 /proc/loadavg)"
    start "$A" && curl -s -i -H "Accept-Encoding: $ENC" "$URL" | grep -aviE '^(date|etag):' > /tmp/tc-a.txt
    start "$B" && curl -s -i -H "Accept-Encoding: $ENC" "$URL" | grep -aviE '^(date|etag):' > /tmp/tc-b.txt
    if cmp -s /tmp/tc-a.txt /tmp/tc-b.txt && [ -s /tmp/tc-a.txt ]; then echo "# answers identical but Date and ETag ($(wc -c < /tmp/tc-a.txt) bytes, $(head -1 /tmp/tc-a.txt | tr -d '\r'))"; else echo "# ANSWERS DIFFER"; fi
    for i in $(seq 1 "$PAIRS"); do
        if [ $((i % 2)) = 1 ]; then first=$A; second=$B; else first=$B; second=$A; fi
        echo "pair $i: $(one "$first")"
        echo "pair $i: $(one "$second")"
    done
    docker rm -f -v tc-app >/dev/null 2>&1
    echo "# done $(date -u +%H:%M:%S)"
} > "$OUT" 2>&1
