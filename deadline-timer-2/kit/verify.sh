#!/bin/sh
# verify.sh <workload> <out dir>: every placement build.sh made answers as its side's unpadded
# binary does, before anything is recorded (run.sh runs it first; the stage header checks'
# verify.sh with the four requests of this kit's workloads). For each bin/<side>-p<pad>, both it
# and bin/<side> are started and run-pair-fresh.sh, with no pair, compares their answers to the
# four requests the workloads send (checks-verify.txt: `plain`, `wait`, `close` and `unstaged`,
# only `close` with a header of its own): status, every header but Date and the value of a weak
# ETag (mask-etag.sed), and the body as received, byte for byte; two answers of the unpadded
# binary must agree too. Any difference stops: the placement is not the same program. The ETag is
# the one value masked, because a tagged answer's is keyed per process start. Before anything is
# compared, base is started twice and its ETag for each workload's request recorded
# (<out dir>/etag-two-starts.txt), and the mask each workload's comparisons use is written from
# that (/m/dl/masks/<workload>.sed): the ETag's value where both starts sent a weak ETag and the
# two values differ, nothing where neither start sent one. Anything else (one value from two
# starts, an ETag from one start only, an ETag that is not weak) stops the run. Each check is
# stopped (and fails) after PLACEMENT_TIMEOUT s. Writes <out dir>/<side>-p<pad>/ and
# <out dir>/verdicts.txt, one line a binary: "<binary> as <side>: checked 4 requests: same; ...".
set -eu
W=${1:-}; out=$2
. /m/dl/plan.sh
mkdir -p "$out" $P/masks; : >"$out/verdicts.txt"
tags=$out/etag-two-starts.txt; : >"$tags"
etag() { # <workload>: the ETag line base sends for that workload's request, or "none"
    eval "set -- $(cat $P/checks-$1.txt)"
    path=$1; shift
    got=$(curl -s -D - -o /dev/null "$@" "http://127.0.0.1:18083$path" </dev/null | tr -d '\r' | grep -i '^etag:' || true)
    echo "${got:-none}"
}
for s in 1 2; do
    PORT=18083 taskset -c 2 sh -c "exec $J $P/bin/base \$PORT plain" >/dev/null 2>&1 &
    pid=$!
    i=0
    until curl -s -o /dev/null http://127.0.0.1:18083/ </dev/null; do
        i=$((i + 1)); [ $i -lt 100 ] || { echo "verify: nothing answers on 18083"; kill $pid; exit 1; }; sleep 0.1
    done
    for w in plain wait close unstaged; do echo "$w start $s of base: $(etag $w)" >>"$tags"; done
    kill $pid; wait $pid 2>/dev/null || true
done
cat "$tags"
: >$P/masks/verify.sed
for w in plain wait close unstaged; do
    one=$(sed -n "s/^$w start 1 of base: //p" "$tags"); two=$(sed -n "s/^$w start 2 of base: //p" "$tags")
    if [ "$one" = none ] && [ "$two" = none ]; then
        : >$P/masks/$w.sed; echo "$w: no ETag, nothing masked" | tee -a "$tags"
    elif echo "$one" | grep -q '^etag: W/"[0-9a-f]*"$' && echo "$two" | grep -q '^etag: W/"[0-9a-f]*"$' && [ "$one" != "$two" ]; then
        cp $P/mask-etag.sed $P/masks/$w.sed; cp $P/mask-etag.sed $P/masks/verify.sed
        echo "$w: a weak ETag keyed per start, its value masked" | tee -a "$tags"
    else
        echo "verify: $w: two starts of base sent '$one' and '$two'; the plan masks only a weak ETag that differs between starts"; exit 1
    fi
done
# The path and script of the workload are passed for run-pair-fresh.sh's usage only: with no pair
# it sends the checks and no load.
one() { # <side> <pad>
    d=$out/$1-p$2
    WARMUP=0 CHECKS=$P/checks-verify.txt MASK=$P/masks/verify.sed \
        timeout -k 30 "$PLACEMENT_TIMEOUT" taskset -c 7 sh $P/run-pair-fresh.sh "$d" verify 0 2 4,5 /private $P/lua/get.lua "$J $P/bin/$1 \$PORT plain" "$J $P/bin/$1-p$2 \$PORT plain" >"$d.log" 2>&1 \
        || { cat "$d.log"; echo "VERIFY FAILED: $1-p$2 against $1"; exit 1; }
    echo "$1-p$2 as $1: $(cat "$d/answers-verify/verdict.txt"); bodies of $(wc -c <"$d/answers-verify/1-head.body"), $(wc -c <"$d/answers-verify/2-head.body"), $(wc -c <"$d/answers-verify/3-head.body") and $(wc -c <"$d/answers-verify/4-head.body") bytes as received" | tee -a "$out/verdicts.txt"
}
for n in $PADS_P $PADS_Q; do one base $n; done
case " $SIDES " in *" head "*) for n in $PADS_P; do one head $n; done ;; esac
echo "verify: $(wc -l <"$out/verdicts.txt") placements answer as their unpadded binary"
