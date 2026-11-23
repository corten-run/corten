#!/bin/sh
# verify.sh <out dir>: every placement build.sh made answers as its side's unpadded binary does,
# before anything is recorded (run.sh runs it first). For each bin/<side>-p<pad>, both it and
# bin/<side> are started with the probe's `hit` config (the kept workload's app: /page warmed
# twice before the port opens; /private is the plain workload's page, the same handler as the
# `plain` config's) and run-pair-fresh.sh, with no pair, compares their answers to GET /private
# and GET /page (checks-verify.txt): status, every header but Date, and body, after mask.sed (the
# Age and ETag values, drawn per process); two answers of the unpadded binary must agree too.
# Then the placement's /page answer must carry an Age (given kept) and both starts must have
# logged the page kept by their warm-up. Any difference stops: the placement is not the same
# program. Writes <out dir>/<side>-p<pad>/ and <out dir>/verdicts.txt.
set -eu
P=/m/1965; out=$1
. $P/plan.sh

J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'
mkdir -p "$out"; : >"$out/verdicts.txt"
one() { # <side> <pad>
    d=$out/$1-p$2
    WARMUP=0 CHECKS=$P/checks-verify.txt MASK=$P/mask.sed \
        taskset -c 7 sh $P/run-pair-fresh.sh "$d" verify 0 2 4,5 /page $P/lua/get.lua "$J $P/bin/$1 \$PORT hit" "$J $P/bin/$1-p$2 \$PORT hit" >"$d.log" 2>&1 \
        || { cat "$d.log"; echo "VERIFY FAILED: $1-p$2 against $1"; exit 1; }
    grep -qx 'age: <seconds since the page was kept>' "$d/answers-verify/2-head.txt" || { echo "VERIFY FAILED: $1-p$2 did not give /page kept"; exit 1; }
    for v in base head; do
        grep -q '^WARM hit: /page .*content-encoding -, age [0-9][0-9]*, [0-9]* bytes$' "$d/serve-verify-$v.log" || { echo "VERIFY FAILED: $1-p$2 ($v) did not keep /page in its warm-up"; exit 1; }
    done
    echo "$1-p$2: $(cat "$d/answers-verify/verdict.txt") as $1 (GET /private, GET /page given kept); $(wc -c <"$d/answers-verify/1-head.txt") and $(wc -c <"$d/answers-verify/2-head.txt") bytes as compared" | tee -a "$out/verdicts.txt"
}
for n in $PADS_P $PADS_Q; do one main $n; done
for n in $PADS_P; do one base $n; one head $n; done
echo "verify: $(wc -l <"$out/verdicts.txt") placements answer as their unpadded binary"