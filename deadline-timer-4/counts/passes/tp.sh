#!/bin/bash
# On a host that measures nothing else at the time: requests a second and latency of the waiting
# workload the gain was first measured on (GET /sdelay/1, the benchmark entry on tokio's
# multi-threaded runtime), one run a build in turn, the builds alternating run by run, then the
# same rounds in the opposite order. The server on CPUs 0-3 (four worker threads), wrk on 4-7.
# No counter is read. Usage: tp.sh <tag> <rounds> <seconds> <connections> <path> <build>...
set -uo pipefail
cd /root/c3tp
TAG=$1; ROUNDS=$2; SECS=$3; CONNS=$4; URLPATH=$5; shift 5
ulimit -n 65536
run() {
    name=$1; tag=$2
    taskset -c 0-3 env ARENA_MODE=default LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 ./bin/$name > srv.log 2>&1 &
    pid=$!
    ok=0
    for i in $(seq 1 100); do
        curl -s -o /dev/null "http://127.0.0.1:8080/baseline11?a=1&b=2" && { ok=1; break; }
        sleep 0.1
    done
    [ $ok = 1 ] || { echo "$tag $name: the server did not answer"; cat srv.log; kill $pid 2>/dev/null; return 1; }
    out=$(taskset -c 4-7 wrk -t4 -c$CONNS -d${SECS}s --latency "http://127.0.0.1:8080$URLPATH" 2>&1)
    kill $pid; wait $pid 2>/dev/null
    rps=$(echo "$out" | awk '/^Requests\/sec/ {print $2}')
    p50=$(echo "$out" | awk '$1 == "50%" {print $2}')
    p99=$(echo "$out" | awk '$1 == "99%" {print $2}')
    bad=$(echo "$out" | grep -E "Socket errors|Non-2xx" | tr -s ' ' | tr '\n' ';')
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$tag" "$name" "$rps" "$p50" "$p99" "${bad:-none}" | tee -a results.tsv
    { echo "### $tag $name"; echo "$out"; } >> raw.log
    sleep 1
}
echo "# $TAG $(date -u +%T) load $(cut -d' ' -f1 /proc/loadavg) $SECS s, $CONNS connections, $URLPATH, order: $*"
for round in $(seq 1 "$ROUNDS"); do
    for name in "$@"; do run $name $TAG.f$round || exit 1; done
done
rev=
for name in "$@"; do rev="$name $rev"; done
for round in $(seq 1 "$ROUNDS"); do
    for name in $rev; do run $name $TAG.b$round || exit 1; done
done
echo "# $TAG DONE $(date -u +%T)"
