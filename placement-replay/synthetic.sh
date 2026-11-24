#!/bin/sh
# synthetic.sh: replay.mjs on placements synth.mjs writes by LLD's rule from the two unpadded
# links' maps kept here (results/base.map.gz and results/head.map.gz), so the checks can be run
# with node alone, without the kit or a container:
#   sh synthetic.sh <scripts directory> <results directory> <work directory> <crate>,<crate>...
# It passes a placement of each side at each place in a line, and of the head with a second pad
# last, and refuses: the wrong pad; the base's link against the head's placement; a second pad
# the check is not told of; the wrong second pad size; a placement without the second pad it is
# told of; a second pad that is not last; a second pad of a size the rule does not allow; a
# function after the first section aligned beyond 16 bytes whose symbol names an own crate; and
# a function of an own crate in .init. It prints the three facts a plan states of each side, and
# checks that a placement's map, with a pad before them, states the same three. The places
# these maps give the sections after .text are synth.mjs's assumption, so --data-further is
# tested on real links: all of them by last-pad.sh and second-pad.sh, and the six kept here
# at the end, four of them with the second pad the rule asks.
set -eu
S=$1; R=$2; W=$3; OWN=$4
mkdir -p $W
gunzip -c $R/base.map.gz >$W/base.map
gunzip -c $R/head.map.gz >$W/head.map
pass() { echo "== $1"; shift; if node $S/replay.mjs "$@" >$W/out.txt 2>&1; then echo "passed"; else grep '^replay.mjs:' $W/out.txt | cut -c1-240; echo "REFUSED, which is wrong"; exit 1; fi; }
t() { echo "== $1"; shift; if node $S/replay.mjs "$@" >$W/out.txt 2>&1; then echo "PASSED, which is wrong"; exit 1; else grep '^replay.mjs:' $W/out.txt | cut -c1-240; echo "refused"; fi; }
for p in 320 15120 25824 40624; do
    node $S/synth.mjs $W/base.map $W/base-p$p.map $p >/dev/null
    node $S/synth.mjs $W/head.map $W/head-p$p.map $p >/dev/null
    pass "base, a pad of $p bytes" $W/base.map $W/base-p$p.map $p --own $OWN
    pass "head, a pad of $p bytes" $W/head.map $W/head-p$p.map $p --own $OWN
    node $S/synth.mjs $W/head.map $W/head-p$p-l64.map $p --last-pad 64 >/dev/null
    pass "head, a pad of $p bytes and a second pad of 64 last" $W/head.map $W/head-p$p-l64.map $p --own $OWN --last-pad 64
done
t "the wrong pad size (15136 for 15120)" $W/head.map $W/head-p15120.map 15136 --own $OWN
t "the base's unpadded link against the head's placement" $W/base.map $W/head-p15120.map 15120 --own $OWN
t "a placement with a second pad, checked as one without" $W/head.map $W/head-p320-l64.map 320 --own $OWN
t "the wrong second pad size (48 for 64)" $W/head.map $W/head-p320-l64.map 320 --own $OWN --last-pad 48
t "a placement without a second pad, checked as one with" $W/head.map $W/head-p320.map 320 --own $OWN --last-pad 64
node $S/synth.mjs $W/head.map $W/head-p320-mid.map 320 --last-pad 64 --last-pad-before-end >/dev/null
t "a second pad laid before the last section and not after it" $W/head.map $W/head-p320-mid.map 320 --own $OWN --last-pad 64
rename() {   # rename <map> <out> <symbol> <new name>: that symbol's line written with another name
    node -e '
      const fs = require("fs"), [file, out, from, to] = process.argv.slice(1), ls = fs.readFileSync(file, "utf8").split("\n");
      const i = ls.findIndex((l) => l.endsWith(" " + from) && /^ +[0-9a-f]+ +[0-9a-f]+ +[0-9a-f]+ +\d+ {17}\S/.test(l));
      if (i < 0) throw new Error("no symbol line for " + from);
      ls[i] = ls[i].slice(0, ls[i].length - from.length) + to;
      fs.writeFileSync(out, ls.join("\n"));' "$1" "$2" "$3" "$4"
}
rename $W/head.map $W/own-a.map libdeflate_aligned_free corten::placed::after
rename $W/head-p320.map $W/own-b.map libdeflate_aligned_free corten::placed::after
t "a function after the first section aligned beyond 16 bytes whose symbol names an own crate" $W/own-a.map $W/own-b.map 320 --own $OWN
rename $W/head.map $W/init-a.map _init corten::placed::init
rename $W/head-p320.map $W/init-b.map _init corten::placed::init
t "a function of an own crate in .init" $W/init-a.map $W/init-b.map 320 --own $OWN
pass "the head read with compiler_builtins named as an own crate, whose two functions after that section do not name it" $W/head.map $W/head-p320.map 320 --own $OWN,compiler_builtins
# Two real links of the head with a second pad are kept (last-pad.sh made them), so that part
# of the check can be run again here, where .data begins included.
gunzip -c $R/head-p320-l48.map.gz >$W/real-l48.map
gunzip -c $R/head-p320-l8.map.gz >$W/real-l8.map
pass "the real link with a first pad of 320 and a second of 48, .data where the unpadded link has it" $W/head.map $W/real-l48.map 320 --own $OWN --last-pad 48 --data-further 0
pass "the real link with a first pad of 320 and a second of 8, .data 16 bytes further" $W/head.map $W/real-l8.map 320 --own $OWN --last-pad 8 --data-further 16
t "that link with .data declared 32 bytes further" $W/head.map $W/real-l8.map 320 --own $OWN --last-pad 8 --data-further 32
# Four real links with the second pad the rule asks are kept (second-pad.sh made them): each
# side with first pads of 15120 and 25824 bytes, 16 and 32 mod 64. The rule: .data begins the
# first pad's size mod 64 further into a line than in the side's unpadded link.
for f in base-p15120-l48 base-p25824-l48 head-p15120-l64 head-p25824-l16; do
    side=${f%%-*}; p=${f#*-p}; p=${p%-l*}; n=${f##*-l}
    gunzip -c $R/$f.map.gz >$W/rule.map
    pass "the real link of the $side with a first pad of $p and a second of $n, .data where the rule says" $W/$side.map $W/rule.map $p --own $OWN --last-pad $n --data-further rule
done
t "the real link of the head with a first pad of 320 and a second of 8, which the rule does not take" $W/head.map $W/real-l8.map 320 --own $OWN --last-pad 8 --data-further rule
pass "the real link of the head with a first pad of 320 and a second of 48, which it does" $W/head.map $W/real-l48.map 320 --own $OWN --last-pad 48 --data-further rule
node $S/synth.mjs $W/base.map $W/base-p320-l48.map 320 --last-pad 48 >/dev/null
pass "base, a pad of 320 bytes and a second pad of 48 last (a written map: its .text only)" $W/base.map $W/base-p320-l48.map 320 --own $OWN --last-pad 48
# The rule allows a second pad of 16, 32, 48 or 64 bytes. On a written map, where .data is as
# synth.mjs assumes, a second pad of 112 bytes is refused for its size alone; 48 bytes, which
# the same map takes, passes.
node $S/synth.mjs $W/head.map $W/head-p320-l112.map 320 --last-pad 112 >/dev/null
node $S/synth.mjs $W/head.map $W/head-p320-l48.map 320 --last-pad 48 >/dev/null
pass "head, a pad of 320 bytes and a second pad of 48 last, by the rule (a written map)" $W/head.map $W/head-p320-l48.map 320 --own $OWN --last-pad 48 --data-further rule
t "head, a pad of 320 bytes and a second pad of 112 last, by the rule (a written map)" $W/head.map $W/head-p320-l112.map 320 --own $OWN --last-pad 112 --data-further rule
# The three facts a plan states of a side, and that code before them does not change the line:
# the head's placement with a pad of 320 bytes states what its unpadded link states.
for side in base head; do echo "== the three facts of the $side"; node $S/replay.mjs --stated $W/$side.map | cut -c1-600; done
node $S/replay.mjs --stated $W/head.map >$W/stated-a.json
node $S/replay.mjs --stated $W/head-p320.map >$W/stated-b.json
echo "== the head's unpadded link and its placement with a pad of 320 bytes state the same three facts"
if cmp -s $W/stated-a.json $W/stated-b.json; then echo "the same line, $(wc -c <$W/stated-a.json | tr -d " ") bytes"; else echo "DIFFERENT, which is wrong"; exit 1; fi
echo SYNTHETIC-DONE
