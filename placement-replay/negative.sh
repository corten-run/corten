#!/bin/sh
# negative.sh: replay.mjs must refuse what is not a placement of the unpadded link:
#   sh negative.sh <kit directory> <scripts directory> <crate>,<crate>...   (after replay-all.sh; reads /w/maps)
# 1. the wrong pad size; 2. another build's placement; 3. a map in which one section aligned to
# 64 bytes sits 16 bytes on, as "every function moved by exactly the pad" would have it;
# 4. a placement linked without the ordering file naming the pad, so the pad is not first;
# 5. a map in which one function sits 16 bytes further into a section that is where it should
# be; 6. a side one of whose own crates has a function after the first section aligned beyond
# 16 bytes (the head's map read with compiler_builtins named as one of its own).
P=$1; S=$2; OWN=$3; M=/w/maps
t() { echo "== $1"; shift; if node $S/replay.mjs "$@" >/w/neg.out 2>&1; then echo "PASSED, which is wrong"; else grep '^replay.mjs:' /w/neg.out | cut -c1-240; echo "refused"; fi; }
echo "== the head's placement with a pad of 15120 bytes, as it is"
node $S/replay.mjs $M/head.map $M/head-p15120.map 15120 --own $OWN >/w/neg.out 2>&1 && echo "passed" || echo "REFUSED, which is wrong"
t "the wrong pad size (15136 for a pad of 15120)" $M/head.map $M/head-p15120.map 15136 --own $OWN
t "the base's unpadded link against the head's placement" $M/base.map $M/head-p15120.map 15120 --own $OWN
move() {   # move <map> <out> <pattern of the line> : that line's two addresses written 16 bytes on
    node -e '
      const fs = require("fs"), [file, out, pattern] = process.argv.slice(1), ls = fs.readFileSync(file, "utf8").split("\n");
      const i = ls.findIndex((l) => new RegExp(pattern).test(l));
      if (i < 0) throw new Error("no line matches " + pattern);
      ls[i] = ls[i].replace(/^(\s*)([0-9a-f]+)(\s+)([0-9a-f]+)/, (m, a, x, b, y) => a + (parseInt(x, 16) + 16).toString(16) + b + (parseInt(y, 16) + 16).toString(16));
      fs.writeFileSync(out, ls.join("\n"));' "$1" "$2" "$3"
}
move $M/head-p15120.map /w/neg-moved.map ':\(\.text\.deflate_compress_fastest\)$'
t "one section aligned to 64 bytes written 16 bytes on in the placement's map" $M/head.map /w/neg-moved.map 15120 --own $OWN
echo '_start' >/w/neg-order.txt
node $S/relink-map.mjs $P/capture/head /w/neg-unordered /w/neg-unordered.map $P/pads/pad-15120.o /w/neg-order.txt
t "the pad linked without being named in the ordering file" $M/head.map /w/neg-unordered.map 15120 --own $OWN
move $M/head-p15120.map /w/neg-symbol.map '^ +[0-9a-f]+ +[0-9a-f]+ +[0-9a-f]+ +1 {17}__rustc::__rust_realloc$'
t "one function written 16 bytes further into a section that has not moved from its place" $M/head.map /w/neg-symbol.map 15120 --own $OWN
t "the head read with compiler_builtins named as one of its own crates" $M/head.map $M/head-p15120.map 15120 --own $OWN,compiler_builtins
rm -f /w/neg-*
