#!/bin/sh
# replay-all.sh: after the kit's build.sh, links every placement again with the linker's map and
# checks it with replay.mjs: base with every pad of PADS_P and PADS_Q, head with every pad of
# PADS_P. Each link with -Map must be byte-identical to the one build.sh made without it.
#   sh replay-all.sh <kit directory> <scripts directory> <output directory>
set -eu
P=$1; S=$2; O=$3
. $P/plan.env
mkdir -p $O /w
: >$O/summary.txt
for side in base head; do
    node $S/relink-map.mjs $P/capture/$side /w/$side /w/$side.map
    cmp -s /w/$side $P/bin/$side || { echo "$side: the link with a map differs from cargo's binary"; exit 1; }
    pads="$PADS_P"; [ $side = base ] && pads="$PADS_P $PADS_Q"
    for n in $pads; do
        node $S/relink-map.mjs $P/capture/$side /w/$side-p$n /w/$side-p$n.map $P/pads/pad-$n.o $P/pads/order.txt
        cmp -s /w/$side-p$n $P/bin/$side-p$n || { echo "$side-p$n: the link with a map differs from build.sh's placement"; exit 1; }
        node $S/replay.mjs /w/$side.map /w/$side-p$n.map $n >$O/replay-$side-p$n.txt 2>&1 || { cat $O/replay-$side-p$n.txt; echo "$side-p$n: replay check failed"; exit 1; }
        echo "$side-p$n $(sed -n 's/^JSON //p' $O/replay-$side-p$n.txt)" >>$O/summary.txt
        rm -f /w/$side-p$n
    done
    echo "$side: $(echo $pads | wc -w) placements linked again with a map, each byte-identical to build.sh's, each passing replay.mjs"
done
echo REPLAY-DONE
