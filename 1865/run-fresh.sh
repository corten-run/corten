#!/bin/sh
# run-fresh.sh: the main pass of #1865's run (results/margin.md), nine workloads, every recorded turn
# on a freshly started build (run-pair-fresh.sh). Called only by run-all.sh, which sets PAIRS, WARMUP
# and TURN (0, 0 and unset for the check, which compares the answers and turns no pair; 100, 1 and
# 3 for the gate). Server on CPU 2, wrk on CPUs 4 and 5, this script and
# perf on CPU 7. The server runs on jemalloc as `corten new`'s Dockerfile runs it. No request asks
# for a coding.
set -eu
P=/m/1865; R=$P/results; PAIRS=${PAIRS:?run-all.sh sets PAIRS}
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'
cmd() { echo "$J $P/bin/$1 \$PORT $2"; }
run() { # <workload> <path wrk asks> <probe config>; checks-<workload>.txt, mask.sed
    CHECKS=$P/checks-$1.txt MASK=$P/mask.sed /m/run-pair-fresh.sh $R $1 "$PAIRS" 2 4,5 $2 /m/lua/get.lua "$(cmd base $3)" "$(cmd head $3)"
}
check() { # <workload> <path> <config>: a start with no pairs, its answers compared
    WARMUP=0 CHECKS=$P/checks-$1.txt MASK=$P/mask.sed /m/run-pair.sh $R $1-check 0 2 4,5 $2 /m/lua/get.lua "$(cmd base $3)" "$(cmd head $3)"
}
logged() { # <workload> <line>: every start of both builds logged a line starting so
    for v in base head; do
        s=$(grep -c '^READY ' $R/serve-$1-$v.log || true); e=$(grep -c "^$2" $R/serve-$1-$v.log || true)
        [ "$s" -gt 0 ] && [ "$s" = "$e" ] || { echo "$R/serve-$1-$v.log: $s starts, $e '$2'" >&2; exit 1; }
        echo "$1 $v: '$2' in $e of $s starts"
    done
}
# (a) the page for one visitor, the control
run private /private private
# (b) the Public page in an app that keeps none
run off /page off
# (c) the kept page: warmed twice by the probe before it serves; that warm-up checked first
check hit /page hit
/m/check-warm.sh $R hit-check same:-
[ "$PAIRS" = 0 ] || { run hit /page hit; logged hit 'WARM hit:'; }
# (d) five policies in turn on a staged route with a middleware, nothing kept
check staged /r/5 staged
logged staged-check 'ROTATION ok'
[ "$PAIRS" = 0 ] || { run staged /r/5 staged; logged staged 'ROTATION ok'; }
# (e) the same five on an unstaged route
check unstaged /u/5 unstaged
logged unstaged-check 'ROTATION ok'
[ "$PAIRS" = 0 ] || { run unstaged /u/5 unstaged; logged unstaged 'ROTATION ok'; }
# (f) the unstaged route with one policy, the same header for every answer
check unstaged-one /u/0 unstaged
logged unstaged-one-check 'ROTATION ok'
[ "$PAIRS" = 0 ] || { run unstaged-one /u/0 unstaged; logged unstaged-one 'ROTATION ok'; }
# (g) the kept page given where its header is not held: kept as (c), then four other policies made
# on the thread, so the head's thread holds four headers and not the page's, and every request's
# settle reads the page's header as main does (the head's fallback)
check fallback /page fallback
/m/check-warm.sh $R fallback-check same:-
logged fallback-check 'EVICT ok'
[ "$PAIRS" = 0 ] || { run fallback /page fallback; logged fallback 'EVICT ok'; }
# (h) a short NoStore answer on the staged route's app after its thread made four Public headers:
# the head's ring is full, and each answer's settle looks through it before reading `no-store`
check nostore /n nostore
logged nostore-check 'EVICT ok'; logged nostore-check 'CONSTANT ok'
[ "$PAIRS" = 0 ] || { run nostore /n nostore; logged nostore 'EVICT ok'; logged nostore 'CONSTANT ok'; }
# (i) the same with a short immutable asset, the other constant
check immutable /i immutable
logged immutable-check 'EVICT ok'; logged immutable-check 'CONSTANT ok'
[ "$PAIRS" = 0 ] || { run immutable /i immutable; logged immutable 'EVICT ok'; logged immutable 'CONSTANT ok'; }
echo "run-fresh: all nine done (PAIRS=$PAIRS)"
