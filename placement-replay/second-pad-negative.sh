#!/bin/sh
# second-pad-negative.sh: what replay.mjs must refuse of a placement with a second pad, on real
# links of both sides (after second-pad.sh, whose second-pad.txt says which size the rule takes):
#   sh second-pad-negative.sh <kit directory> <scripts directory> <output directory> <crate>,<crate>...
# For each side, with a first pad of 15120 bytes (16 mod 64): 1. a second pad of another of the
# four sizes, which puts .data elsewhere than the rule says; 2. the rule's second pad named in
# the ordering file after the first pad, so LLD lays it second in .text and not last; 3. the
# placement with the first pad alone, checked as one with a second pad. A check that passes
# stops the script.
set -eu
P=$1; S=$2; O=$3; OWN=$4
mkdir -p /w/maps2 /w/pads2
for n in 16 32 48 64; do
    [ -f /w/pads2/pad2-$n.o ] && continue
    printf '\t.section .text.corten_layout_pad2,"axR",@progbits\n\t.p2align 4\n\t.type corten_layout_pad2,@function\ncorten_layout_pad2:\n\t.skip %s, 0xcc\n\t.size corten_layout_pad2, %s\n' "$n" "$n" >/w/pads2/pad2-$n.s
    cc -c /w/pads2/pad2-$n.s -o /w/pads2/pad2-$n.o
done
printf 'corten_layout_pad\ncorten_layout_pad2\n' >/w/order-both.txt
t() { echo "== $1"; shift; if node $S/replay.mjs "$@" >/w/neg.out 2>&1; then echo "PASSED, which is wrong"; return 1; else grep '^replay.mjs:' /w/neg.out | cut -c1-240; echo "refused"; fi; }
: >$O/second-pad-negative.txt
for side in base head; do
    right=$(grep "^$side first pad 15120 " $O/second-pad.txt | sed 's/.*): second pad \([0-9]*\);.*/\1/')
    [ -n "$right" ] || { echo "$side: second-pad.txt has no size for a first pad of 15120"; exit 1; }
    wrong=16; [ "$right" = 16 ] && wrong=32
    node $S/relink-two.mjs $P/capture/$side /w/$side-two /w/maps2/neg.map $P/pads/pad-15120.o $P/pads/order.txt /w/pads2/pad2-$wrong.o
    t "$side, a first pad of 15120 bytes and a second pad of $wrong where the rule takes $right, so .data is elsewhere than the rule says" /w/maps/$side.map /w/maps2/neg.map 15120 --own $OWN --last-pad $wrong --data-further rule >>$O/second-pad-negative.txt
    node $S/relink-two.mjs $P/capture/$side /w/$side-two /w/maps2/neg.map $P/pads/pad-15120.o /w/order-both.txt /w/pads2/pad2-$right.o
    t "$side, a first pad of 15120 bytes and a second pad of $right that the ordering file names, so it is not last" /w/maps/$side.map /w/maps2/neg.map 15120 --own $OWN --last-pad $right --data-further rule >>$O/second-pad-negative.txt
    t "$side, a first pad of 15120 bytes and no second pad, checked as one with a second pad of $right" /w/maps/$side.map /w/maps/$side-p15120.map 15120 --own $OWN --last-pad $right --data-further rule >>$O/second-pad-negative.txt
done
cat $O/second-pad-negative.txt
rm -f /w/base-two /w/head-two /w/neg.out /w/maps2/neg.map
echo SECOND-PAD-NEGATIVE-DONE
