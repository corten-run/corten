#!/bin/sh
# verify.sh <out dir>: every placement build.sh made answers as its side's unpadded binary does,
# before anything is recorded (run.sh runs it first). For each bin/<side>-p<pad>, both it and
# bin/<side> are started with the probe's `plain` config and run-pair-fresh.sh, with no pair,
# compares their answers to the three requests the workloads send (checks-verify.txt: GET /private
# with no Accept-Encoding, with `gzip, deflate, br, zstd` and with `gzip, br`): status, every
# header but Date and the value of a weak ETag (mask-etag.sed), and the body as received, byte for
# byte; two answers of the unpadded binary must agree too. Any difference stops: the placement is
# not the same program. The ETag is the one value masked, because a compressed answer's is keyed
# per process start: before anything is compared, base is started twice and its ETag for the zstd
# request recorded (<out dir>/etag-two-starts.txt); if the two starts gave one value the mask has
# no ground and the run stops. Writes <out dir>/<side>-p<pad>/ and <out dir>/verdicts.txt.
set -eu
P=/m/1971; out=$1
. $P/plan.sh

J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'
mkdir -p "$out"; : >"$out/verdicts.txt"
tags=$out/etag-two-starts.txt; : >"$tags"
for s in 1 2; do
    PORT=18083 taskset -c 2 sh -c "exec $J $P/bin/base \$PORT plain" >/dev/null 2>&1 &
    pid=$!
    i=0
    until curl -s -o /dev/null http://127.0.0.1:18083/ </dev/null; do
        i=$((i + 1)); [ $i -lt 100 ] || { echo "verify: nothing answers on 18083"; kill $pid; exit 1; }; sleep 0.1
    done
    echo "start $s of base: $(curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip, deflate, br, zstd' http://127.0.0.1:18083/private </dev/null | tr -d '\r' | grep -i '^etag:')" >>"$tags"
    kill $pid; wait $pid 2>/dev/null || true
done
cat "$tags"
[ "$(grep -c 'etag: W/"[0-9a-f]*"$' "$tags")" = 2 ] || { echo "verify: a start of base sent no weak ETag for the zstd request"; exit 1; }
[ "$(sed 's/^start [12] of base: //' "$tags" | sort -u | wc -l)" = 2 ] || { echo "verify: two starts of base sent one ETag, so masking it has no ground"; exit 1; }
one() { # <side> <pad>
    d=$out/$1-p$2
    WARMUP=0 CHECKS=$P/checks-verify.txt MASK=$P/mask-etag.sed \
        taskset -c 7 sh $P/run-pair-fresh.sh "$d" verify 0 2 4,5 /private $P/lua/get.lua "$J $P/bin/$1 \$PORT plain" "$J $P/bin/$1-p$2 \$PORT plain" >"$d.log" 2>&1 \
        || { cat "$d.log"; echo "VERIFY FAILED: $1-p$2 against $1"; exit 1; }
    echo "$1-p$2: $(cat "$d/answers-verify/verdict.txt") as $1; bodies of $(wc -c <"$d/answers-verify/1-head.body"), $(wc -c <"$d/answers-verify/2-head.body") and $(wc -c <"$d/answers-verify/3-head.body") bytes as received" | tee -a "$out/verdicts.txt"
}
for n in $PADS_P $PADS_Q; do one base $n; done
for n in $PADS_P; do one head $n; done
echo "verify: $(wc -l <"$out/verdicts.txt") placements answer as their unpadded binary"
