#!/bin/sh
# run-icache.sh: the run's diagnostic pass (results/margin.md), run after run-fresh.sh by
# run-all.sh: user L1 instruction-cache misses and user instructions a request, both builds, the
# same nine workloads and probes, ICACHE_PAIRS pairs each of TURN seconds (run-all.sh sets them, 30
# and 1), every turn on a fresh start (run-pair-icache.sh). Not a gate. First checks that perf counts
# L1-icache-load-misses:u on this host at 100% running beside instructions:u; if it does not, it
# writes results/icache-unavailable.txt with perf's output and exits 0 (the main pass stands).
set -eu
P=/m/1865; R=$P/results; PAIRS=${ICACHE_PAIRS:?run-all.sh sets ICACHE_PAIRS}; export TURN=${TURN:?run-all.sh sets TURN}
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'
cmd() { echo "$J $P/bin/$1 \$PORT $2"; }
pre=$(perf stat -x, -e L1-icache-load-misses:u,instructions:u -- sh -c 'i=0; while [ $i -lt 200000 ]; do i=$((i + 1)); done' 2>&1 >/dev/null || true)
echo "$pre" >"$R/icache-preflight.txt"
ok=$(echo "$pre" | awk -F, '$3 == "L1-icache-load-misses:u" && $1 ~ /^[0-9]+$/ && $5 + 0 == 100 { print "yes" }')
if [ "$ok" != yes ]; then
    { echo "perf on this host did not count L1-icache-load-misses:u at 100% running beside instructions:u;"
      echo "the diagnostic pass was not run. perf stat said:"; echo "$pre"; } >"$R/icache-unavailable.txt"
    cat "$R/icache-unavailable.txt"
    exit 0
fi
run() { # <workload> <path wrk asks> <probe config>
    /m/1865/run-pair-icache.sh $R $1 "$PAIRS" 2 4,5 $2 /m/lua/get.lua "$(cmd base $3)" "$(cmd head $3)"
}
logged() { # <workload> <line every start of both builds logs>
    for v in base head; do
        s=$(grep -c '^READY ' $R/serve-icache-$1-$v.log || true); e=$(grep -c "^$2" $R/serve-icache-$1-$v.log || true)
        [ "$s" -gt 0 ] && [ "$s" = "$e" ] || { echo "$R/serve-icache-$1-$v.log: $s starts, $e '$2'" >&2; exit 1; }
    done
}
run private /private private
run off /page off
run hit /page hit; logged hit 'WARM hit:'
run staged /r/5 staged; logged staged 'ROTATION ok'
run unstaged /u/5 unstaged; logged unstaged 'ROTATION ok'
run unstaged-one /u/0 unstaged; logged unstaged-one 'ROTATION ok'
run fallback /page fallback; logged fallback 'EVICT ok'
run nostore /n nostore; logged nostore 'CONSTANT ok'
run immutable /i immutable; logged immutable 'CONSTANT ok'
echo "icache: all nine done"
