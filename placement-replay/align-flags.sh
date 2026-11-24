#!/bin/sh
# align-flags.sh: which of gcc's flags change the alignment of the function sections of one C file
# of libdeflate-sys, compiled by hand. Not the crate's own build: its flags were not read.
#   sh align-flags.sh <libdeflate-sys source directory> [<the build's libdeflate.a>]
set -eu
D=$1; A=${2:-}
cd $D/libdeflate
echo "$(basename $D), lib/deflate_compress.c, $(cc --version | head -1)"
B="-O3 -ffunction-sections -fdata-sections -fPIC"
count() { readelf -SW $1 | awk '/ \.text/ && / AX /{ n[$(NF)]++ } END { for (a in n) printf "%s at %s, ", n[a], a }'; }
t() {
    cc $B $1 -I. -S lib/deflate_compress.c -o /tmp/dc.s 2>/dev/null
    cc $B $1 -I. -c lib/deflate_compress.c -o /tmp/dc.o 2>/dev/null
    echo "cc $B $1: .p2align 6 in the assembly $(grep -c 'p2align 6' /tmp/dc.s || true) times, .p2align 5 $(grep -c 'p2align 5' /tmp/dc.s || true) times; function sections by alignment: $(count /tmp/dc.o)"
}
t ""
t "-falign-functions=16"
t "-falign-functions=16 -falign-loops=16 -falign-jumps=16 -falign-labels=16"
t "-fno-align-loops"
t "-fno-align-loops -fno-align-jumps -fno-align-labels"
t "-fno-align-functions -fno-align-loops -fno-align-jumps -fno-align-labels"
t "-falign-loops=1 -falign-jumps=1 -falign-labels=1"
t "-mtune=generic -fno-align-loops"
t "-O2"
t "-O2 -fno-align-loops"
t "-Os"
echo "where the first .p2align 6 of the plain compile sits (the six lines before it):"
cc $B -I. -S lib/deflate_compress.c -o /tmp/dc.s 2>/dev/null
grep -n -B6 'p2align 6' /tmp/dc.s | head -8
if [ -n "$A" ]; then echo "the build's own archive: sha256 $(sha256sum $A | cut -d' ' -f1); function sections by alignment: $(count $A)"; fi
