#!/bin/sh
# second-pad.sh: a second pad in every placement of both sides, sized by one rule (after the
# kit's build.sh and replay-all.sh, which leaves the unpadded links' maps in /w/maps):
#   sh second-pad.sh <kit directory> <scripts directory> <output directory> <crate>,<crate>...
# The rule: a placement with a first pad of p bytes has a second pad last in .text, sized so
# that .data begins p mod 64 bytes further into a 64-byte line than in its side's unpadded link.
# A second pad of n bytes is one function nothing calls, corten_layout_pad2, in a section of its
# own aligned to 16 bytes, which the ordering file does not name and relink-two.mjs gives last
# on the link line. For every placement of the plan (the base with each pad of PADS_P and
# PADS_Q, the head with each pad of PADS_P) this links the side with the first pad and a second
# pad of each of SIZES, reads from each link's map how much further into a line .data begins,
# keeps the first size that puts it where the rule says, checks that link with
# replay.mjs --last-pad <size> --data-further rule, and links it once more without the map to
# compare the two binaries. A placement with no such size stops the script. It ends with
# second-pad-negative.sh: what replay.mjs must refuse, on real links.
set -eu
P=$1; S=$2; O=$3; OWN=$4
. $P/plan.env
SIZES="16 32 48 64"
mkdir -p $O /w/maps2 /w/pads2
for n in $SIZES; do
    printf '\t.section .text.corten_layout_pad2,"axR",@progbits\n\t.p2align 4\n\t.type corten_layout_pad2,@function\ncorten_layout_pad2:\n\t.skip %s, 0xcc\n\t.size corten_layout_pad2, %s\n' "$n" "$n" >/w/pads2/pad2-$n.s
    cc -c /w/pads2/pad2-$n.s -o /w/pads2/pad2-$n.o
done
further() { sed -n 's/^JSON //p' $1 | node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(j.dataFurther)'; }
: >$O/second-pad.txt
: >$O/second-pad.sha256
: >$O/second-pad-maps.sha256
started=$(date +%s); links=0
for side in base head; do
    pads="$PADS_P"; [ $side = base ] && pads="$PADS_P $PADS_Q"
    for p in $pads; do
        want=$((p % 64)); kept=""; tried=""
        for n in $SIZES; do
            node $S/relink-two.mjs $P/capture/$side /w/$side-two /w/maps2/try.map $P/pads/pad-$p.o $P/pads/order.txt /w/pads2/pad2-$n.o
            links=$((links + 1))
            node $S/replay.mjs /w/maps/$side.map /w/maps2/try.map $p --own $OWN --last-pad $n >/w/try.out 2>&1 || { cat /w/try.out; echo "$side, first pad $p, second pad $n: replay check failed"; exit 1; }
            got=$(further /w/try.out); tried="$tried $n:$got"
            if [ -z "$kept" ] && [ "$got" = "$want" ]; then
                kept=$n
                node $S/replay.mjs /w/maps/$side.map /w/maps2/try.map $p --own $OWN --last-pad $n --data-further rule >$O/second-pad-$side-p$p.txt 2>&1 || { cat $O/second-pad-$side-p$p.txt; echo "$side, first pad $p, second pad $n: the check by the rule failed"; exit 1; }
                echo "$(sha256sum /w/$side-two | cut -d' ' -f1)  $side-p$p-l$n" >>$O/second-pad.sha256
                echo "$(sha256sum /w/maps2/try.map | cut -d' ' -f1)  $side-p$p-l$n.map" >>$O/second-pad-maps.sha256
                node $S/relink-two.mjs $P/capture/$side /w/$side-two-nomap - $P/pads/pad-$p.o $P/pads/order.txt /w/pads2/pad2-$n.o
                links=$((links + 1))
                cmp -s /w/$side-two /w/$side-two-nomap || { echo "$side, first pad $p, second pad $n: the link with the map differs from the link without it"; exit 1; }
                case "$side-$p" in base-15120|head-15120|base-25824|head-25824) gzip -9 -c /w/maps2/try.map >$O/$side-p$p-l$n.map.gz ;; esac
            fi
        done
        [ -n "$kept" ] || { echo "$side, first pad $p: no size of $SIZES puts .data $want bytes further (tried$tried)"; exit 1; }
        echo "$side first pad $p (mod 64: $want): second pad $kept; each size tried and how far it put .data:$tried; $(grep '^the second pad' $O/second-pad-$side-p$p.txt)" >>$O/second-pad.txt
    done
done
echo "$(wc -l <$O/second-pad.txt) placements, each with a second pad that puts .data where the rule says, checked by replay.mjs, its link with the map byte-identical to its link without; $links links in $(( $(date +%s) - started )) s" | tee -a $O/second-pad.txt
for side in base head; do
    echo "$side: second pad by first pad mod 64: $(for w in 0 16 32 48; do echo "$w -> $(grep "^$side first pad [0-9]* (mod 64: $w)" $O/second-pad.txt | sed 's/.*): second pad \([0-9]*\);.*/\1/' | sort -u | tr '\n' ' ')"; done | tr '\n' ';')" | tee -a $O/second-pad.txt
    echo "$side: $(grep -c " $side-p" $O/second-pad.sha256) binaries, $(grep " $side-p" $O/second-pad.sha256 | cut -d' ' -f1 | sort -u | wc -l) distinct SHA-256s" | tee -a $O/second-pad.txt
done
rm -f /w/base-two /w/head-two /w/base-two-nomap /w/head-two-nomap /w/try.out /w/maps2/try.map
# What must be refused, on real links of both sides.
sh $S/second-pad-negative.sh $P $S $O $OWN
echo SECOND-PAD-DONE
