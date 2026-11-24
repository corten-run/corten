#!/bin/sh
# kinds.sh: replay.mjs --kinds on the recorded pair of unpadded links (results/base.map.gz and
# results/head.map.gz, real links) and on layouts relay.mjs writes from the head's by LLD's
# rule, which nobody has linked. Run by synthetic.sh, or alone with node:
#   sh kinds.sh <scripts directory> <results directory> <work directory>
# Each case prints the mode's summary line and the lines of the functions that are not excused
# or of a kind, and fails unless the summary holds what the case expects.
set -eu
S=$1; R=$2; W=$3
mkdir -p $W
[ -f $W/base.map ] || gunzip -c $R/base.map.gz >$W/base.map
[ -f $W/head.map ] || gunzip -c $R/head.map.gz >$W/head.map
LIB='liblibdeflate_sys.rlib'
k() {   # k <title> <base map> <head map> <expected in the summary> [more expected ...] [-- replay arguments]
    echo "== $1"; a=$2; b=$3; shift 3
    want=
    while [ $# -gt 0 ] && [ "$1" != -- ]; do want="$want
$1"; shift; done
    [ $# -eq 0 ] || shift
    node $S/replay.mjs --kinds $a $b "$@" >$W/kinds.txt
    grep -v '^{' $W/kinds.txt | grep -v 'kind none.*; excused; ' | grep -v 'kind 2 [^;]*; excused; ' | cut -c1-330
    echo "$want" | while IFS= read -r w; do
        [ -z "$w" ] || grep '^listed: ' $W/kinds.txt | grep -qF -- "$w" || { echo "the summary does not hold: $w, which is wrong"; exit 1; }
    done
    echo "as expected"
}
relay() { node $S/relay.mjs "$@" >/dev/null; }
same() { node $S/relay.mjs $1 $W/same.map | grep -q ', 0 lines that differ' || { echo "relay.mjs does not write $1 as it is, which is wrong"; exit 1; }; }
same $W/base.map; same $W/head.map
echo "== relay.mjs with no edit writes each unpadded link's .text as LLD laid it"; echo "as expected"

k "the recorded pair: the base lists nothing, the head 40, all of kind 2; libdeflate's 38 excused, the two built-ins not" \
    $W/base.map $W/head.map \
    'listed: 0 on the base, 40 on the head, 40 in all; kind 1: 0, kind 2: 40,' \
    'excused: 38 (15 by clause 1, 23 by clause 2); not excused: 2 (__udivti3 [libcompiler_builtins.rlib], round [libcompiler_builtins.rlib])'

# Both sides link the library; the head links one more of its functions.
relay $W/head.map $W/after48.map --insert-after crc32_x86_vpclmulqdq_avx512_vl512 "$LIB(crc32.o)" one_more 48 16
k "one more library function of 48 bytes after the library's last section aligned to 64: what follows moves by 48, the built-ins with it" \
    $W/head.map $W/after48.map \
    'listed: 40 on the base, 41 on the head, 41 in all; kind 1: 0, kind 2: 8,' \
    'excused: 39 (15 by clause 1, 24 by clause 2); not excused: 2 (__udivti3 [libcompiler_builtins.rlib], round [libcompiler_builtins.rlib])'
grep -q '^__udivti3 .*base 32 mod 64, no clause; head 16 mod 64, no clause; kind 2 ' $W/kinds.txt || { echo "__udivti3 is not of kind 2 at 32 and 16, which is wrong"; exit 1; }
relay $W/head.map $W/after64.map --insert-after crc32_x86_vpclmulqdq_avx512_vl512 "$LIB(crc32.o)" one_more 64 16
k "the same function of 64 bytes: what follows keeps its offset, and the built-ins are of no kind" \
    $W/head.map $W/after64.map \
    'kind 1: 0, kind 2: 1, kind 3: not known, none: 40;'
grep -q '^round .*kind none ' $W/kinds.txt || { echo "round is of a kind, which is wrong"; exit 1; }
relay $W/head.map $W/before.map --insert-after crc32_slice8 "$LIB(crc32.o)" one_more 48 16
k "one more library function before that section: the four between move and are excused, and everything from the section on keeps its offset" \
    $W/head.map $W/before.map \
    'kind 1: 0, kind 2: 5, kind 3: not known, none: 36;' \
    'excused: 39 (15 by clause 1, 24 by clause 2)'
grep -q '^round .*kind none ' $W/kinds.txt || { echo "round is of a kind, which is wrong"; exit 1; }

# A function aligned to 32 bytes behind another archive's section aligned to 64, that archive
# then grown by 16 bytes: one place on each side, and not the same one.
relay $W/head.map $W/other-a.map --insert-after libdeflate_aligned_free 'libother.rlib(o.o)' other32 64 32
relay $W/head.map $W/other-b.map --insert-after libdeflate_aligned_free "$LIB(utils.o)" grown 16 16 --insert-after grown 'libother.rlib(o.o)' other32 64 32
k "a function aligned to 32 behind another archive's section aligned to 64, that archive grown by 16 bytes" \
    $W/other-a.map $W/other-b.map \
    'not excused: 3 (other32 [libother.rlib], __udivti3 [libcompiler_builtins.rlib], round [libcompiler_builtins.rlib])'
grep -q '^other32 .*base 32 mod 64, no clause; head 0 mod 64, no clause; kind 2 ' $W/kinds.txt || { echo "other32 is not of kind 2 at 32 and 0 with no clause, which is wrong"; exit 1; }

# Sides whose aligned sections are all at 32 bytes: a function behind them takes its unpadded
# offset and that plus 32 on each side, so offsets 32 apart are one offset modulo 32.
relay $W/head.map $W/only32-a.map --align-all 64 32
relay $W/head.map $W/only32-b.map --align-all 64 32 --insert-first 'probe.o' early 32 16
k "sides with sections aligned to 32 alone, the head's code 32 bytes further on: no function is of a kind" \
    $W/only32-a.map $W/only32-b.map \
    'listed: 40 on the base, 40 on the head, 40 in all; kind 1: 0, kind 2: 0, kind 3: not known, none: 40;'
grep -q '^round .*base 16 mod 32, no clause; head 16 mod 32, no clause; kind none ' $W/kinds.txt || { echo "round is not at one offset modulo 32 on both sides, which is wrong"; exit 1; }

# The base's largest alignment 32 and the head's 64: the pads give a function behind them two
# places on the base and one on the head.
k "largest alignments that differ, 32 on the base and 64 on the head: the built-ins are of kind 2 and not excused, the library's own are excused" \
    $W/only32-a.map $W/head.map \
    'not excused: 2 (__udivti3 [libcompiler_builtins.rlib], round [libcompiler_builtins.rlib])'
grep -q '^round .*base 16 mod 32, no clause; head 48 mod 64, no clause; kind 2 ' $W/kinds.txt || { echo "round is not of kind 2 behind 32 and 64, which is wrong"; exit 1; }

# A function in no archive: clause 1 excuses it where its own section is aligned so, and clause
# 2 never does.
relay $W/head.map $W/loose.map --insert-after libdeflate_aligned_free 'loose.o' loose64 64 64 --insert-after loose64 'loose.o' loose16 16 16
k "functions from an object in no archive, on the head alone: one in a section aligned to 64 is excused by clause 1, one behind it is not excused" \
    $W/head.map $W/loose.map \
    'not excused: 3 (__udivti3 [libcompiler_builtins.rlib], round [libcompiler_builtins.rlib], loose16 [loose.o])'
grep -q '^loose64 \[loose.o\]: base not listed; head 0 mod 64, clause 1; kind 2 [^;]*; excused; ' $W/kinds.txt || { echo "loose64 is not excused by clause 1, which is wrong"; exit 1; }

# A second library first linked on the head, after everything else: its function before its own
# first aligned section is behind another archive's alignment and is not excused.
relay $W/head.map $W/second.map --insert-after round 'libsecond.rlib(a.o)' lead16 16 16 --insert-after lead16 'libsecond.rlib(a.o)' second64 64 64 --insert-after second64 'libsecond.rlib(a.o)' tail16 16 16
k "a second library first linked on the head: its function before its first aligned section is not excused, the two from that section on are" \
    $W/head.map $W/second.map \
    'excused: 40 (16 by clause 1, 24 by clause 2); not excused: 3 (__udivti3 [libcompiler_builtins.rlib], round [libcompiler_builtins.rlib], lead16 [libsecond.rlib])'

# Kind 1 from the maps: a listed function whose section's size differs.
relay $W/head.map $W/grown.map --size round 118
k "a listed function whose section is 16 bytes larger on the head: kind 1" \
    $W/head.map $W/grown.map \
    'kind 1: 1, kind 2: 0, kind 3: not known, none: 39;'
grep -q '^round .*kind 1 ' $W/kinds.txt || { echo "round is not of kind 1, which is wrong"; exit 1; }

# Kind 3, and what a report decides: the request runs round and libdeflate_gzip_compress on the
# head alone. Both are of kind 3; the library's function is excused and round is not.
printf 'libdeflate_crc32\n' >$W/ran-a.txt
printf 'libdeflate_crc32\nlibdeflate_gzip_compress\nround\n' >$W/ran-b.txt
k "both sides link the library alike and the request runs two listed functions on the head alone: both of kind 3, one excused, one taking the reading" \
    $W/head.map $W/head.map \
    'kind 1: 0, kind 2: 0, kind 3: 2, none: 38;' 'taking the reading: 1' \
    -- --ran-base $W/ran-a.txt --ran-head $W/ran-b.txt
grep -q '^round .*kind 3; not excused; run on base no, on head yes; takes the reading: yes' $W/kinds.txt || { echo "round does not take the reading, which is wrong"; exit 1; }
: >$W/ran-none.txt
printf 'libdeflate_crc32\nlibdeflate_gzip_compress\n' >$W/ran-c.txt
k "the recorded pair with a report that the request runs two of the library's functions on the head and neither built-in on either side: no function takes the reading" \
    $W/base.map $W/head.map \
    'kind 3: 2,' 'taking the reading: 0' \
    -- --ran-base $W/ran-none.txt --ran-head $W/ran-c.txt
k "the recorded pair with a report that the head's request runs round: it takes the reading" \
    $W/base.map $W/head.map \
    'kind 3: 3,' 'taking the reading: 1' \
    -- --ran-base $W/ran-none.txt --ran-head $W/ran-b.txt
echo KINDS-DONE
