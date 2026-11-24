#!/bin/sh
# negative-v1.sh: the first version of replay.mjs (this commit's parent's) against the map of
# negative.sh's fifth case, one function written 16 bytes further into a section that is in its
# place. It passed that map, which is why replay.mjs now checks every symbol.
#   sh negative-v1.sh <the first version of replay.mjs> <replay.mjs>     (reads /w/maps)
V1=$1; V2=$2; M=/w/maps
node -e '
  const fs = require("fs"), [file, out] = process.argv.slice(1), ls = fs.readFileSync(file, "utf8").split("\n");
  const i = ls.findIndex((l) => /^ +[0-9a-f]+ +[0-9a-f]+ +[0-9a-f]+ +1 {17}__rustc::__rust_realloc$/.test(l));
  if (i < 0) throw new Error("no such line");
  ls[i] = ls[i].replace(/^(\s*)([0-9a-f]+)(\s+)([0-9a-f]+)/, (m, a, x, b, y) => a + (parseInt(x, 16) + 16).toString(16) + b + (parseInt(y, 16) + 16).toString(16));
  fs.writeFileSync(out, ls.join("\n"));' $M/head-p15120.map /w/neg-symbol.map
echo "== the first version, on a map with one function written 16 bytes further into its section"
if node $V1 $M/head.map /w/neg-symbol.map 15120 >/w/neg.out 2>&1; then echo "passed"; else grep '^replay.mjs:' /w/neg.out | cut -c1-240; echo "refused"; fi
echo "== this version, on the same map"
if node $V2 $M/head.map /w/neg-symbol.map 15120 >/w/neg.out 2>&1; then echo "passed"; else grep '^replay.mjs:' /w/neg.out | cut -c1-240; echo "refused"; fi
rm -f /w/neg-symbol.map /w/neg.out
