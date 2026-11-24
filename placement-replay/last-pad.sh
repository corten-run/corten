#!/bin/sh
# last-pad.sh: what a second pad laid last in .text does to a build with code aligned beyond 16
# bytes, on real links of the kit's head (after its build.sh and replay-all.sh):
#   sh last-pad.sh <kit directory> <scripts directory> <output directory> <crate>,<crate>...
# A second pad of n bytes is one function nothing calls, corten_layout_pad2, in a section of its
# own aligned to 16 bytes, which the ordering file does not name. Part 1 links the head with a
# first pad of 320 bytes and each second pad size of SIZES, checks the placement with
# replay.mjs --last-pad and prints how much further into a 64-byte line .data begins than in
# the unpadded link. Part 2 takes the first size that gives each of 0, 16, 32 and 48 and links
# it with four first pads, one at each place in a line, checking each with --data-further.
set -eu
P=$1; S=$2; O=$3; OWN=$4
SIZES="8 16 24 32 40 48 56 64 72 80 96 112 128"
FIRST="320 15120 25824 40624"
mkdir -p $O /w/maps /w/pads2
pad2() {
    printf '\t.section .text.corten_layout_pad2,"axR",@progbits\n\t.p2align 4\n\t.type corten_layout_pad2,@function\ncorten_layout_pad2:\n\t.skip %s, 0xcc\n\t.size corten_layout_pad2, %s\n' "$1" "$1" >/w/pads2/pad2-$1.s
    cc -c /w/pads2/pad2-$1.s -o /w/pads2/pad2-$1.o
}
link() {   # link <first pad> <second pad>: the placement's map at /w/maps/head-p<first>-l<second>.map
    node $S/relink-two.mjs $P/capture/head /w/head-two /w/maps/head-p$1-l$2.map $P/pads/pad-$1.o $P/pads/order.txt /w/pads2/pad2-$2.o
    sha256sum /w/head-two | cut -d' ' -f1
}
: >$O/last-pad.txt
echo "part 1: the head with a first pad of 320 bytes and a second pad of each size" | tee -a $O/last-pad.txt
for n in $SIZES; do
    pad2 $n
    sum=$(link 320 $n)
    node $S/replay.mjs /w/maps/head.map /w/maps/head-p320-l$n.map 320 --own $OWN --last-pad $n >$O/last-pad-p320-l$n.txt 2>&1 || { cat $O/last-pad-p320-l$n.txt; echo "second pad $n: replay check failed"; exit 1; }
    echo "second pad $n: $(sed -n 's/^JSON //p' $O/last-pad-p320-l$n.txt | node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(`begins ${j.lastPadGap} bytes after the code before it; .text grew by ${j.textGrew - j.pad} besides the first pad; .data ${j.dataFurther} bytes further into a line; places ${JSON.stringify(j.placeInLine)}; ok ${j.ok}`)') sha256 $sum" | tee -a $O/last-pad.txt
done
echo "part 2: the first size that gives each place, with a first pad at each place in a line" | tee -a $O/last-pad.txt
for want in 0 16 32 48; do
    n=$(grep "data $want bytes further" $O/last-pad.txt | sed -n '1s/^second pad \([0-9]*\):.*/\1/p')
    [ -n "$n" ] || { echo "no size of $SIZES puts .data $want bytes further"; exit 1; }
    for p in $FIRST; do
        sum=$(link $p $n)
        node $S/replay.mjs /w/maps/head.map /w/maps/head-p$p-l$n.map $p --own $OWN --last-pad $n --data-further $want >$O/last-pad-p$p-l$n.txt 2>&1 || { cat $O/last-pad-p$p-l$n.txt; echo "first pad $p, second pad $n: replay check failed"; exit 1; }
        echo "data $want further: first pad $p, second pad $n: passed; $(grep '^the second pad' $O/last-pad-p$p-l$n.txt); sha256 $sum" | tee -a $O/last-pad.txt
    done
done
# Negatives on the real links: a second pad the check is not told of, the wrong size, and the
# wrong place declared for the data.
t() { echo "== $1"; shift; if node $S/replay.mjs "$@" >/w/neg.out 2>&1; then echo "PASSED, which is wrong"; else grep '^replay.mjs:' /w/neg.out | cut -c1-240; echo "refused"; fi; }
{
    t "a placement with a second pad, checked as one without" /w/maps/head.map /w/maps/head-p320-l64.map 320 --own $OWN
    t "the wrong second pad size (48 for 64)" /w/maps/head.map /w/maps/head-p320-l64.map 320 --own $OWN --last-pad 48
    t "a placement without a second pad, checked as one with" /w/maps/head.map /w/maps/head-p320.map 320 --own $OWN --last-pad 64
    n16=$(grep "data 16 bytes further" $O/last-pad.txt | sed -n '1s/^second pad \([0-9]*\):.*/\1/p')
    t "the data declared 32 bytes further where the second pad puts it 16" /w/maps/head.map /w/maps/head-p320-l$n16.map 320 --own $OWN --last-pad $n16 --data-further 32
} | tee $O/last-pad-negative.txt
rm -f /w/head-two /w/neg.out
echo LAST-PAD-DONE
