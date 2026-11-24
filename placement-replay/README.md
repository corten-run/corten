# What a pad moves in a build that links code aligned beyond 16 bytes

Scripts and their output behind the rule in design Choice 72 and Pull requests (item 2) for a
placement run of a build that links C code. Read and run on 2026-11-24. Nothing here counted a
cycle: these are layouts, read from recorded files and from links run again.

## From the recorded run

`model.mjs` reads the 30 `tail-head-p*.txt` and `layout-head-p*.txt` files of the head of
[#1971 Compress a request's small body with gzip by libdeflate for a client without zstd](https://github.com/corten-run/corten/pull/1971)
as its placement run recorded them (tag `evidence/request-gzip-1971-placed`,
`request-gzip-1971-placements/results/h09/results/layout/`; the second host's are the same
files) and tests three statements on the 1,290 shifts of the 43 function symbols from
libdeflate's first on. `results/model.txt` is what it printed.

1. "A function moves by the pad rounded up to its own alignment": holds for 529 and fails for
   761. It holds for all 344 in the 8 placements whose pad is a multiple of 64 and for 185 of the
   946 in the other 22.
2. The linker's rule: a function aligned to 16 bytes or less moves as the one before it (750 of
   750); one aligned to 32 or 64 moves by the shift of the one before it rounded down or up to a
   multiple of its alignment (540 of 540), down or up the same way for one gap before it.
3. The bound: every shift is from the pad rounded down to the pad rounded up to a multiple of
   the largest alignment so far (1,290 of 1,290).

It also prints where each function sat: `build_tree`, before the first section aligned beyond
16 bytes, at 4 of the 4 places in a 64-byte line; the three from the first section aligned to
32 to the first aligned to 64 at 2; the 39 from that one on at 1; every one at 29 or 30 distinct
page offsets, 8, 7, 8 and 7 of them in the four quarters of a page, as the pads are.

## From the links run again

The kit under that tag was built again in a Debian 13 container (`rust:1-trixie`: rustc 1.100.0
with LLD 23.1.5, gcc 14.2.0-19, libzstd 1.5.7), at the kit's own paths, by its own `build.sh`
(`results/build.out`). The two binaries are not byte-identical to the run's
(`results/rebuild-layout/sha256.txt`; the base's `.text` begins 528 bytes later and the head's
512), but `.text` has the run's size on each side, and each of the 90 placements' `layout-*.txt`
and `tail-*.txt` is the run's but for the addresses printed in it: every function's shift is the
one the run recorded.

`replay-all.sh` then ran each of the 92 links again with the linker's map (`relink-map.mjs`,
the kit's `relink.mjs` with `-Wl,-Map`), each byte-identical to the link without it, and
checked each placement with `replay.mjs` (`results/replay/`, one file a placement and
`summary.txt`; `results/head.map.gz` and `base.map.gz` are the unpadded links' maps):

1. `.text` holds the pad's section first and then the unpadded link's input sections, in its
   order, each with its size and alignment;
2. in both links every input section begins at the first multiple of its alignment at or after
   the end of the one before it;
3. so the placement is the unpadded layout replayed with the pad;
4. every input section before the first one aligned beyond 16 bytes moved by exactly the pad,
   and every one from it on by a multiple of its alignment from the pad rounded down to the pad
   rounded up to a multiple of the largest alignment at or before it.

The base's `.text` has 3,442 input sections (3,215 aligned to 16 bytes, 23 to 8, 42 to 4 and 162
to 1) and all moved by exactly the pad in its 60 placements (206,520 of 206,520). The head's
has 3,483 (3,238 to 16, 23 to 8, 42 to 4, 162 to 1, 5 to 32 and 13 to 64); the first aligned
beyond 16 is `compute_length_counts`, after 3,443 sections that moved by exactly the pad in its
30 placements (103,290 of 103,290); the 40 from it on moved by the pad (341 of 1,200 shifts), 16
bytes more (304), 16 less (296) or 32 less (259). The sections after `.text` moved by one
multiple of 64 bytes in each placement of the head: the pad in 8, 16 less in 8, 32 less in 7 and
16 more in 7.

`negative.sh` shows `replay.mjs` refusing four things that are not a placement
(`results/negative.txt`): the wrong pad size, another build's placement, a map with one section
aligned to 64 bytes written 16 bytes on, and a pad the ordering file does not name.

## Three smaller readings

1. `results/align-flags.txt`: libdeflate-sys 1.26.1's `lib/deflate_compress.c` compiled by hand
   with `-O3 -ffunction-sections -fdata-sections -fPIC` has 12 function sections aligned to 64
   bytes and 4 to 32, and has them still with `-falign-functions=16`, and with
   `-falign-loops=16 -falign-jumps=16 -falign-labels=16` added: the assembly holds `.p2align 6`
   37 times inside functions in all three. The flags are not the ones the crate's build passes,
   which were not read; the archive that build made has 17 sections at 64 and 5 at 32.
2. `results/pad-last.txt`: a pad object the ordering file does not name is laid last in `.text`.
3. `phase.mjs` and `results/phase.txt`: in the five A/As across placements whose reports are
   under the tags `evidence/stage-header-checks-2002` and `evidence/request-gzip-1971-placed`
   (240 placement medians, each centred on its own A/A's median), the 59 whose two pads share a
   place in a 64-byte line spread 1.31% (standard deviation) and the 181 whose pads differ in
   it 1.37%, a ratio 78.2% of 20,000 seeded permutations reach either way. A reading chosen
   after the results and planned by no run.
