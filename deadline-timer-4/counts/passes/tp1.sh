#!/bin/bash
# On a host that measures nothing else at the time: requests a second and latency of one kept-alive
# connection that never waits (GET /baseline11), while another connection that first sent three
# requests that wait (GET /sdelay/1) stays open and idle: the state in which a kept timer stands
# set. One run a build in turn, the builds alternating run by run, then the same rounds in the
# opposite order. The server on CPUs 0-3 (or those SRV names: one CPU gives the single-threaded
# runtime one thread, so both connections share its driver), wrk (one thread, one connection) on CPU 4.
# No counter is read. Usage: tp1.sh <tag> <mode> <rounds> <seconds> <other's path> <build>...
set -uo pipefail
cd /root/c3tp
TAG=$1; MODE=$2; ROUNDS=$3; SECS=$4; OTHER=$5; shift 5
ulimit -n 65536
run() {
    name=$1; tag=$2
    taskset -c ${SRV:-0-3} env ARENA_MODE=$MODE LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 ./bin/$name > srv.log 2>&1 &
    pid=$!
    ok=0
    for i in $(seq 1 100); do
        curl -s -o /dev/null "http://127.0.0.1:8080/baseline11?a=1&b=2" && { ok=1; break; }
        sleep 0.1
    done
    [ $ok = 1 ] || { echo "$tag $name: the server did not answer"; cat srv.log; kill $pid 2>/dev/null; return 1; }
    exec 3<>/dev/tcp/127.0.0.1/8080
    for i in 1 2 3; do
        printf 'GET %s HTTP/1.1\r\nHost: localhost\r\n\r\n' "$OTHER" >&3
        sleep 0.1
    done
    answered=$(timeout 0.3 cat <&3 | grep -ao 'HTTP/1.1 200' | wc -l)
    out=$(taskset -c 4 wrk -t1 -c1 -d${SECS}s --latency "http://127.0.0.1:8080/baseline11?a=1&b=2" 2>&1)
    exec 3<&-
    kill $pid; wait $pid 2>/dev/null
    rps=$(echo "$out" | awk '/^Requests\/sec/ {print $2}')
    p50=$(echo "$out" | awk '$1 == "50%" {print $2}')
    p99=$(echo "$out" | awk '$1 == "99%" {print $2}')
    bad=$(echo "$out" | grep -E "Socket errors|Non-2xx" | tr -s ' ' | tr '\n' ';')
    [ "$answered" = 3 ] || bad="other answered $answered;${bad}"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$tag" "$name" "$rps" "$p50" "$p99" "${bad:-none}" | tee -a results.tsv
    { echo "### $tag $name"; echo "$out"; } >> raw.log
    sleep 1
}
echo "# $TAG $(date -u +%T) load $(cut -d' ' -f1 /proc/loadavg) $MODE, $SECS s, one connection, other sent $OTHER, order: $*"
for round in $(seq 1 "$ROUNDS"); do
    for name in "$@"; do run $name $TAG.f$round || exit 1; done
done
rev=
for name in "$@"; do rev="$name $rev"; done
for round in $(seq 1 "$ROUNDS"); do
    for name in $rev; do run $name $TAG.b$round || exit 1; done
done
echo "# $TAG DONE $(date -u +%T)"
