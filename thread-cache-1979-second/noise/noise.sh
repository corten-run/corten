#!/usr/bin/env bash
# Runs on the measurement droplet: how much one setting's cycles a request vary from turn to
# turn, by how the turn is set up. One image, one MALLOC_CONF, the uncompressed item page.
# Modes: bridge (a published port, as tc-pair2.sh), host (the host's network, no proxy), each
# with a fresh container every turn or one container for all turns (-warm).
# Usage: noise.sh <image> <fixture dir> <turns> <out dir> <mode>...
set -uo pipefail
IMAGE=$1; FIX=$2; TURNS=$3; OUT=$4; shift 4
SERVER_CPU=${SERVER_CPU:-2}; LOAD_CPUS=${LOAD_CPUS:-4,5}; PERF_CPU=${PERF_CPU:-7}
ENC=${ENC:-identity}; CONF=${CONF:-background_thread:true,tcache_max:65536}
mkdir -p "$OUT"
sysctl -qw kernel.perf_event_paranoid=-1
start() { # start <network mode>
    docker rm -f -v nz-app >/dev/null 2>&1
    if [ "$1" = host ]; then NET=(--network host); PORT=8080; else NET=(-p 18495:8080); PORT=18495; fi
    URL=http://127.0.0.1:$PORT/items/item_5
    docker run -d --name nz-app --cpuset-cpus "$SERVER_CPU" --memory 1g --ulimit nofile=65536:65536 "${NET[@]}" -e "MALLOC_CONF=$CONF" \
        -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e AGENT_ORIGINS=http://127.0.0.1:$PORT -e EMBED_ORIGINS=http://127.0.0.1:$PORT \
        -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "$FIX:/fixtures:ro" "$IMAGE" >/dev/null
    for i in $(seq 1 100); do curl -sf -o /dev/null "$URL" && return 0; sleep 0.1; done
    echo "no answer"; return 1
}
load() { taskset -c "$LOAD_CPUS" wrk -t2 -c64 -d"$1" -H "Accept-Encoding: $ENC" "$URL" 2>&1; }
count() { # count <label>
    local pid stat out ok bad
    pid=$(docker inspect -f '{{.State.Pid}}' nz-app); stat=$(mktemp)
    taskset -c "$PERF_CPU" perf stat -x, -e cycles:u,cycles:k,instructions:u,instructions:k -p "$pid" -o "$stat" -- sleep 3.4 &
    local perf=$!
    sleep 0.2
    out=$(load 3s)
    wait $perf
    ok=$(echo "$out" | grep -oP '^\s*\K\d+(?= requests in)')
    bad=$(echo "$out" | grep -oP 'Non-2xx or 3xx responses: \K\d+'); bad=$((${bad:-0} + $(echo "$out" | grep -c 'Socket errors')))
    awk -F, -v ok="${ok:-0}" -v bad="$bad" -v label="$1" '
        $3=="cycles:u" {cu=$1; pu=$5} $3=="cycles:k" {ck=$1; pk=$5} $3=="instructions:u" {iu=$1} $3=="instructions:k" {ik=$1}
        END { if (ok==0) { print label, "no requests"; exit }
              printf "%s requests=%d failed=%d cycles_user=%.0f cycles_kernel=%.0f total=%.0f instr_user=%.0f instr_kernel=%.0f running=%s/%s\n",
                     label, ok, bad, cu/ok, ck/ok, (cu+ck)/ok, iu/ok, ik/ok, pu, pk }' "$stat"
    rm -f "$stat"
}
for mode in "$@"; do
    net=${mode%-warm}
    log="$OUT/$mode.log"
    echo "# $(date -u +%H:%M:%S) $mode turns=$TURNS enc=$ENC server=$SERVER_CPU load=$LOAD_CPUS load1=$(cut -d' ' -f1 /proc/loadavg)" > "$log"
    if [ "$mode" != "$net" ]; then start "$net" || exit 1; load 2s >/dev/null; fi
    for i in $(seq 1 "$TURNS"); do
        if [ "$mode" = "$net" ]; then start "$net" || exit 1; load 2s >/dev/null; fi
        echo "turn $i: $(count "$mode")" >> "$log"
    done
done
docker rm -f -v nz-app >/dev/null 2>&1
echo "# noise done $(date -u +%H:%M:%S)" >> "$OUT/done.txt"
