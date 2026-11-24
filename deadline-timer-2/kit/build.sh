#!/bin/sh
# build.sh <workload>: builds on the measuring host the binaries that workload's part reads (the
# stage header checks' build.sh, tag evidence/stage-header-checks-2002, with this kit's paths and
# only the sides the part reads). Each side is compiled once and every placement of it is a relink
# of that one compile's objects with a pad first in .text:
#   base   commits.env's BASE (src-base)   base (unpadded), base-p<n> for every n in PADS_P and PADS_Q
#   head   commits.env's HEAD (src-head)   head (unpadded), head-p<n> for every n in PADS_P
#          (the gated part only: the pilot reads the base alone and builds no head)
# For each side: the tree is put at /m/dl/work and its Cargo.lock beside the probe (/m/dl/probe),
# the target directory (/m/target-dl-<side>) emptied, and the probe built with the repository's
# release profile (zstd linked to the system's libzstd, ZSTD_SYS_USE_PKG_CONFIG) with wrap/ first
# on PATH, so the `cc` rustc runs records the probe's final link (link-capture.mjs, into
# capture/<side>/) and then runs it. A pad of n bytes is pads/pad-<n>.o, assembled here: one
# function, corten_layout_pad, of n bytes of int3 in a section of its own
# (.text.corten_layout_pad, aligned to 16, flagged SHF_GNU_RETAIN so --gc-sections keeps it though
# nothing calls it), and pads/order.txt, a symbol ordering file naming that function alone.
# relink.mjs adds both to the captured link, so LLD puts the pad first in .text and the rest
# after it in their own order. Then:
#   1. no third-party version outside the tree's Cargo.lock was resolved;
#   2. the binary is linked to the system's libzstd and by LLD (its .comment), and the build made
#      no C archive of its own;
#   3. the captured link run again unpadded gives a binary byte-identical to the one cargo built,
#      so the capture holds everything the link read;
#   4. each placement (layout.mjs against its side's unpadded binary) holds exactly that binary's
#      functions and the pad, the pad at the start of .text, every function moved by exactly the
#      pad's size, and every pair of neighbours still next to each other in order;
#   5. base with PADS_P's first pad relinked again is byte-identical (a pad is one placement);
#   6. every binary's sha256 differs from every other's.
# Any failure stops the build. Writes bin/<side>, bin/<side>-p<n>, bin/sha256.txt,
# bin/layout-<side>-p<n>.txt, bin/placements.txt, capture/<side>/args.json, pads/ and
# build-<side>.log. DRYRUN=1 (plan.sh): the first DRY_K (3) pads of each list only.
set -eu
W=${1:-}
. /m/dl/plan.sh
[ "$DRY" = 1 ] && echo "DRYRUN: K=$K, PADS_P=$PADS_P, PADS_Q=$PADS_Q (not a measurement)"
[ -f /root/.cargo/env ] && . /root/.cargo/env
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-1.100.0} ZSTD_SYS_USE_PKG_CONFIG=1
rustc -V
chmod +x $P/wrap/cc
mkdir -p $P/bin $P/capture $P/pads
rm -f $P/bin/base* $P/bin/head* $P/bin/layout-* $P/bin/sha256.txt $P/bin/placements.txt $P/bin/placements-summary.txt $P/pads/*
: >$P/bin/sha256.txt
: >$P/bin/placements.txt
echo "part $PART workload $W K $K sides $SIDES" >$P/bin/built-for.txt
echo corten_layout_pad >$P/pads/order.txt
for n in $PADS_P $PADS_Q; do
    printf '\t.section .text.corten_layout_pad,"axR",@progbits\n\t.p2align 4\n\t.type corten_layout_pad,@function\ncorten_layout_pad:\n\t.skip %s, 0xcc\n\t.size corten_layout_pad, %s\n' "$n" "$n" >$P/pads/pad-$n.s
    cc -c $P/pads/pad-$n.s -o $P/pads/pad-$n.o
    size=$(readelf -sW $P/pads/pad-$n.o | awk '$8 == "corten_layout_pad" { print $3 }')
    [ "$size" = "$n" ] || { echo "pads/pad-$n.o: corten_layout_pad is $size bytes, not $n"; exit 1; }
done
echo "pads: $(ls $P/pads/*.o | wc -l) objects, each one function of its size"
pairs() { awk '/^name = /{n=$3} /^version = /{print n, $3}' "$1" | tr -d '"' | sort -u; }
sum() { echo "$1 $(sha256sum $P/bin/$1 | cut -d' ' -f1) $(stat -c %s $P/bin/$1) bytes" | tee -a $P/bin/sha256.txt; }
zstd() { ldd $P/bin/$1 | grep -q 'libzstd\.so' || { echo "$1 is not linked to the system's libzstd"; exit 1; }; }
build() { # <side>
    side=$1; started=$(date +%s); T=/m/target-dl-$side; D=$P/work
    echo "== $side: $(cat $P/src-$side.commit), $(date -u +%T)"
    case "$D" in /m/dl/work) ;; *) echo "refusing to replace $D"; exit 1 ;; esac
    rm -rf "$D"; mkdir -p "$D"; cp -a $P/src-$side/. "$D/"
    cp $P/src-$side/Cargo.lock $P/probe/Cargo.lock
    case "$T" in /m/target-dl-base|/m/target-dl-head) rm -rf "$T" ;; *) echo "refusing to remove $T"; exit 1 ;; esac
    case "$side" in base|head) rm -rf "$P/capture/$side" ;; esac
    mkdir -p $P/capture/$side
    (cd $P/probe && PATH=$P/wrap:$PATH LINK_CAPTURE=$P/capture/$side CARGO_TARGET_DIR=$T cargo build --release >$P/build-$side.log 2>&1) \
        || { tail -30 $P/build-$side.log; echo "BUILD FAILED: $side"; exit 1; }
    tail -2 $P/build-$side.log
    grep 'link-capture:' $P/build-$side.log || true
    [ -f $P/capture/$side/args.json ] || { echo "$side: no link was captured"; exit 1; }
    pairs $P/src-$side/Cargo.lock >/tmp/dl-lock
    new=$(pairs $P/probe/Cargo.lock | grep -v '^pstage ' | comm -23 - /tmp/dl-lock)
    rm -f /tmp/dl-lock
    [ -z "$new" ] || { echo "$side resolved versions its Cargo.lock does not have: $new"; exit 1; }
    cp $T/release/probe $P/bin/$side
    archives=$(find $T -path '*/out/lib/*' -name '*.a' | sort | paste -sd' ' -)
    [ -z "$archives" ] || { echo "$side: the build made C archives ($archives); this kit checks rustc's code alone"; exit 1; }
    zstd $side
    readelf -p .comment $P/bin/$side | grep -q 'Linker: LLD' || { echo "$side was not linked by LLD"; exit 1; }
    node $P/relink.mjs $P/capture/$side $P/bin/$side-relink
    cmp -s $P/bin/$side $P/bin/$side-relink || { echo "$side: the captured link run again unpadded differs from cargo's binary"; exit 1; }
    echo "$side: the captured link run again unpadded is byte-identical to cargo's binary"
    rm -f $P/bin/$side-relink
    sum $side
    echo "$side built in $(( $(date +%s) - started )) s"
}
place() { # <side> <pad> (POSIX sh shares variables: this one names its own pl_*)
    pl_name=$1-p$2
    node $P/relink.mjs $P/capture/$1 $P/bin/$pl_name $P/pads/pad-$2.o $P/pads/order.txt || { echo "relink failed: $pl_name"; exit 1; }
    zstd $pl_name
    node $P/layout.mjs $P/bin/$1 $P/bin/$pl_name "$2" >$P/bin/layout-$pl_name.txt
    pl_j=$(sed -n 's/^JSON //p' $P/bin/layout-$pl_name.txt)
    node -e '
        const j = JSON.parse(process.argv[1]), a = j.all, why = [];
        if (j.onlyA.length) why.push(j.onlyA.length + " functions only in the unpadded binary");
        if (j.onlyB.join() !== "corten_layout_pad") why.push("only in the placement: " + j.onlyB.join(", "));
        if (!j.padAtStart) why.push("the pad is not at the start of .text");
        if (a.moved !== a.both) why.push((a.both - a.moved) + " functions did not move");
        if (a.exact !== a.both) why.push((a.both - a.exact) + " functions moved by other than the pad");
        if (a.neighboursKept !== a.neighbours) why.push("neighbours kept " + a.neighboursKept + " of " + a.neighbours);
        if (why.length) { console.error(process.argv[2] + ": " + why.join("; ")); process.exit(1); }' "$pl_j" "$pl_name"
    pl_sum=$(sum $pl_name)
    echo "$pl_sum; $(grep '^all functions' $P/bin/layout-$pl_name.txt)" >>$P/bin/placements.txt
}
for s in $SIDES; do build $s; done
started=$(date +%s)
for n in $PADS_P $PADS_Q; do place base $n; done
case " $SIDES " in *" head "*) for n in $PADS_P; do place head $n; done ;; esac
first=$(nth 1 "$PADS_P")
node $P/relink.mjs $P/capture/base $P/bin/base-again $P/pads/pad-$first.o $P/pads/order.txt
cmp -s $P/bin/base-p$first $P/bin/base-again || { echo "base pad $first relinked again differs: a pad is not one placement"; exit 1; }
rm -f $P/bin/base-again
echo "base pad $first relinked again is byte-identical"
dups=$(awk '{ print $2 }' $P/bin/sha256.txt | sort | uniq -d)
[ -z "$dups" ] || { echo "binaries with the same sha256: $dups"; exit 1; }
node -e '
    const fs = require("fs"), dir = process.argv[1];
    const files = fs.readdirSync(dir).filter((f) => /^layout-.*\.txt$/.test(f));
    let exact = 0, both = 0, kept = 0, pairs = 0;
    for (const f of files) {
        const j = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8").split("\n").find((l) => l.startsWith("JSON ")).slice(5));
        exact += j.all.exact; both += j.all.both; kept += j.all.neighboursKept; pairs += j.all.neighbours;
    }
    console.log(files.length + " placements: functions moved by exactly their pad " + exact + " of " + both + "; neighbours kept " + kept + " of " + pairs);' $P/bin | tee $P/bin/placements-summary.txt
echo "$(wc -l <$P/bin/sha256.txt) binaries, every sha256 distinct; placements relinked in $(( $(date +%s) - started )) s"
echo "== $(basename $P/bin/layout-base-p$first.txt)"; grep -v '^JSON' $P/bin/layout-base-p$first.txt
echo BUILD-DONE
