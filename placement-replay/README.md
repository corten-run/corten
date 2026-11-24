# What a pad moves in a build that links code aligned beyond 16 bytes

Scripts and their output behind one rule in design Choice 72 and Pull requests (item 2, the
placement plan's fifth point): how a placement run checks a build that links code aligned beyond
16 bytes. Read and run on 2026-11-24. Nothing here counted a cycle: these are layouts, read from
recorded files and from links run again, and placement medians read from earlier runs' reports.

This commit's three ancestors hold earlier versions of these files. What this one changes:

1. `replay.mjs` decides whose a function is by its symbol alone, no longer by its input file;
   refuses a side with a function of a crate named as its own in another output section that
   holds code; and has a mode for a placement with a second pad last in `.text`
   (`--last-pad <bytes>`, with `--data-further <bytes>` for where `.data` must begin).
2. `negative.sh` refuses an own function after the first section aligned beyond 16 bytes by
   its symbol, and one in `.init`.
3. `synth.mjs` and `synthetic.sh` are new: placements written by LLD's rule from the two
   unpadded maps kept here, so the checks run with node alone.
4. `relink-two.mjs` and `last-pad.sh` are new: real links of the head with a second pad.
5. `measure-sim.mjs` is new: what the measurement of the data's place reads by chance.
6. The kit was built a third time for this, with the first two builds' binaries byte for byte
   (`results/binaries.sha256` is `results/rebuild-layout/sha256.txt` again), and every link
   and check run again: everything under `results/replay/`, `results/facts-*.json`,
   `results/totals.txt`, `results/negative.txt`, `results/build.out`, `results/replay-all.out`
   and `results/maps.sha256` (now 117 maps) is this run's.

Not here: the 90 placements' maps, 319 MB. The two unpadded links' maps and two of the links
with a second pad are kept, and `results/maps.sha256` has the SHA-256 of every map made.
`replay-all.sh` makes the rest again from the kit in a few minutes after its build.

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

The kit under that tag was built again twice in a Debian 13 container (`rust:1-trixie`: rustc
1.100.0 with LLD 23.1.5, gcc 14.2.0-19, libzstd 1.5.7), at the kit's own paths, by its own
`build.sh`, and a third time for this commit (`results/build.out` is the third build's). The
three builds' 92 binaries have the same SHA-256s (`results/rebuild-layout/sha256.txt`,
`results/binaries.sha256`). They are not byte-identical to the run's
(the base's `.text` begins 528 bytes later and the head's 512), but `.text` has the run's size
on each side, and each of the 90 placements' `layout-*.txt` and `tail-*.txt` is the run's but
for the addresses printed in it: every function's shift is the one the run recorded.

`replay-all.sh` then ran each of the 92 links again with the linker's map (`relink-map.mjs`,
the kit's `relink.mjs` with `-Wl,-Map`), each byte-identical to the link without it, and
checked each placement with `replay.mjs`, naming `corten`, `corten_feed`, `corten_protocol`,
`corten_ui` and `probe` as the sides' own crates. `results/replay/` has one file a placement
and `summary.txt`; `results/totals.txt` is `totals.mjs` adding the summary up;
`results/facts-base.json` and `facts-head.json` are what `replay.mjs --facts` prints of each
unpadded link; `results/base.map.gz` and `head.map.gz` are the two unpadded links' maps and
`results/maps.sha256` the SHA-256 of every map made (these 92 and the 25 with a second pad,
below). The checks:

1. `.text` holds the pad's section first and then the unpadded link's input sections, in its
   order, each with its size and alignment, and begins where it did;
2. in both links every input section begins at the first multiple of its alignment at or after
   the end of the one before it;
3. so the placement is the unpadded layout replayed with the pad;
4. every input section before the first one aligned beyond 16 bytes moved by exactly the pad,
   and every one from it on by a multiple of its alignment from the pad rounded down to the pad
   rounded up to a multiple of the largest alignment at or before it;
5. every symbol the map lists in `.text` is in the same input section in both links, in the
   same order and as far from the section's start, so every symbol before the first section
   aligned beyond 16 bytes moved by exactly the pad;
6. no input section is aligned beyond 64 bytes; none from the first one aligned beyond 16
   bytes on holds a function of a crate named as the side's own; and no other output section
   that holds code (`.init`, `.fini`, the `.plt` sections, one named `.text.*`, or one with
   an input section named `.text*`) holds one;
7. with `--last-pad`, one more section follows the unpadded link's, the second pad's, of the
   size given; with `--data-further`, `.data` begins that many bytes further into a 64-byte
   line than in the unpadded link.

The base's `.text` has 3,442 input sections (3,215 aligned to 16 bytes, 23 to 8, 42 to 4 and 162
to 1) and all moved by exactly the pad in its 60 placements (206,520 of 206,520), with the 3,514
symbols in them (210,840 of 210,840). The head's has 3,483 (3,238 to 16, 23 to 8, 42 to 4, 162
to 1, 5 to 32 and 13 to 64); the first aligned beyond 16 is `compute_length_counts`, after 3,443
sections that moved by exactly the pad in its 30 placements (103,290 of 103,290), with their
3,515 symbols (105,450 of 105,450), 2,025 of them of the crates named; the 40 from it on, none
of those crates, moved by the pad (341 of 1,200 shifts), 16 bytes more (304), 16 less (296) or
32 less (259). The output sections after `.text` moved by one multiple of 64 bytes in each
placement of the head: the pad in 8, 16 less in 8, 32 less in 7 and 16 more in 7.

Where the data begins in a 64-byte line (`results/totals.txt`): the base's `.data` 16 bytes in
unpadded and 0, 16, 32 and 48 across its placements, the head's 32 unpadded and in all 30;
`.data.rel.ro` 16 and each of the four against 24, `.got` 48 against 8, `.bss` 40 against 16.
The two unpadded maps also give each output section's size: between base and head `.plt` went
from 48 bytes to 96, `.tdata` from 456 to 480, `.data.rel.ro` from 89,456 to 89,536, `.got`
from 7,728 to 7,768, `.got.plt` from 40 to 64 and `.data` from 4,632 to 4,656.

`negative.sh` shows `replay.mjs` passing one placement as it is and refusing seven things that
are not a placement it should pass (`results/negative.txt`): the wrong pad size, another
build's placement, a map with one section aligned to 64 bytes written 16 bytes on, a pad the
ordering file does not name, a map with one function written 16 bytes further into a section
that is in its place, the head's maps with one function after the first section aligned beyond
16 bytes written under a name of an own crate (`corten::placed::after`), and those maps with
`_init` written as `corten::placed::init`. The fifth is one the first version of `replay.mjs`
passed (`results/negative-v1.txt`). It also shows what is no longer refused: the head read
with `compiler_builtins` named as an own crate. Its two functions after that section are
`__udivti3` and `round`, which do not name it, and the earlier version refused them by their
input file.

Whose a function is (`results/head.map.gz`): of the 3,483 input sections of the head's `.text`,
3,440 come from 41 objects named for the program and one code unit each
(`probe.addr2line-<hash>.addr2line.<hash>-cgu.0.rcgu.o`), 41 from two libraries (libdeflate's
39 and the compiler built-ins' 2) and 2 from the C start files. A unit holds other crates'
functions beside its own crate's: the first section from addr2line's unit holds alloc's
`RawVecInner::reserve::do_reserve_and_handle`. So `replay.mjs` decides whether a function is
one of a crate named with `--own` by its symbol alone, the mangled name or the printed one. A
function with a name of its own that names no crate (`#[no_mangle]`) is not seen by that test.

## A second pad last in `.text`

`last-pad.sh` (`results/last-pad.txt`, one file a link under `results/last-pad/`) links the
kit's head with a first pad and a second pad: one function nothing calls,
`corten_layout_pad2`, in a section of its own aligned to 16 bytes, which the ordering file
does not name and `relink-two.mjs` gives last on the link line. In each of the 25 links LLD
laid it last in `.text`, 10 bytes after the end of the code before it, and `replay.mjs
--last-pad` passed the placement: every other section and symbol where a placement with the
first pad alone has it.

Where `.data` then begins, with a first pad of 320 bytes, against the unpadded link: a second
pad of 48, 56 or 112 bytes leaves it at its place in a 64-byte line (moved by 64 bytes); one of
8, 64, 72 or 128 puts it 16 bytes further; 16, 24 or 80, 32 further; 32, 40 or 96, 48 further.
So the place does not follow the pad's size alone: the sections between `.text` and `.data`
round it. `.init`, `.fini` and `.plt` move as the data does (`.plt` from 0 to 16, 32 and 48),
so a second pad moves them too. With sizes 48, 8, 16 and 32 and a first pad at each place in a
line (320, 15120, 25824 and 40624 bytes), all sixteen links have `.data` where the size put it
with the first pad of 320, since on this head a first pad moves the end of `.text` by a
multiple of 64. `results/last-pad-negative.txt`: `replay.mjs` refuses a placement with a
second pad checked as one without, the wrong second pad size, a placement without a second pad
checked as one with, and `.data` declared 32 bytes further where it is 16.

`--data-further` is read against the unpadded link. On a side whose largest alignment is 32
bytes a first pad alone can move the data by 32, which these links do not show.

## Without the kit

`synthetic.sh` (`results/synthetic.txt`) runs `replay.mjs` on maps `synth.mjs` writes from the
two unpadded maps by LLD's rule, with node alone: it passes a placement of each side at four
first pads and of the head with a second pad last, and refuses the wrong pad, the other
build, a second pad it is not told of, the wrong second pad size, a missing second pad, a
second pad that is not last, an own function after the first section aligned beyond 16 bytes
by its symbol, and an own function in `.init`. It ends on the two real links with a second
pad that are kept (`results/head-p320-l48.map.gz` and `head-p320-l8.map.gz`), where `.data`
begins included. `results/synth-compare.txt`: for four first pads on each side and four second
pads on the head, every line of `.text` that `synth.mjs` writes is the real link's map's, so
the synthetic maps are what LLD made. What `synth.mjs` writes for the sections after `.text`
is an assumption and is not compared.

## What the measurement of the data's place reads by chance

`measure-sim.mjs` (`results/measure-sim-null.txt`, `results/measure-sim-effect.txt`) draws the
three comparisons of the measurement the fifth point asks for, on the model design Choice 72
uses for an A/A: K normal placement medians of one standard deviation, 200,000 seeded draws.
"Held" is every comparison's bound under +1% in both readings; "shown" is not held with at
least j of K medians on one side of zero in one comparison, j the smallest count whose
binomial tail is at most 5%/6 (22 of 30, 40 of 60, 63 of 100); "not made" is the rest. With no
effect, at the standard deviations the seven A/As read so far had (0.96% to 2.02%): at K = 30
not made in 1.4% to 88.2% and shown in 0.3% to 4.7%; at K = 60 not made in 0.0% to 40.8%
(under 4% up to 1.48%, 8.1% at 1.6%, 17.4% at 1.75%) and shown in 0.0% to 3.3%; at K = 100
not made in 0.0% to 6.4% and shown in 0.0% to 1.3%. With one place costing 1% at K = 60: held
in 3.4% to 4.7%, shown in 73.2% to 95.1%; costing 2%, shown in every draw to one decimal. The
model is the Choice's, which no run has tested.

## Not cited: the band

`band.mjs` and `results/band.txt` were written for a rule that was drafted and set aside: a
band that a single build would be read against on a setup with no recorded spread. Design
Choice 72 has no such rule and cites neither file. They are kept as what was read. `band.mjs`
reads the lowest and the highest placement median of each A/A across placements from the
reports of the three runs design Choice 72 records (`results/placements.json` under the tags
`evidence/ee7b0b41` and `evidence/0c0c599c`, and the three `placements-<workload>.json` under
`evidence/stage-header-checks-2002`). `results/band.txt` is what it printed: seven A/As, the
lowest of all -5.47% (the third run's on its mounted API, 60 placements) and the highest +4.38%
(the second run's on `old`, 30 placements).

## Three smaller readings

1. `align-flags.sh` and `results/align-flags.txt`: libdeflate-sys 1.26.1's
   `lib/deflate_compress.c` compiled by hand by gcc 14.2.0 with
   `-O3 -ffunction-sections -fdata-sections -fPIC` has 12 function sections aligned to 64 bytes
   and 4 to 32, and `.p2align 6` 37 times inside functions. It has them still with
   `-falign-functions=16`; with loop, jump and label alignments of 16, or of 1; with
   `-fno-align-loops`, alone, with `-mtune=generic`, or with `-fno-align-jumps` and
   `-fno-align-labels` (and `-fno-align-functions`, which takes the other sections from 16 to
   1). At `-O2` it has 15 at 64 and 1 at 32, with `-fno-align-loops` or without. At `-Os` it has
   none: every function section at 1. The flags are not the ones the crate's build passes,
   which were not read; the archive that build made has 17 sections at 64 and 5 at 32. No other
   compiler or version was tried.
2. `results/pad-last.txt`: a pad object the ordering file does not name is laid last in `.text`
   (from the first build; not run again).
3. `phase.mjs` and `results/phase.txt`: in the five A/As across placements whose reports are
   under the tags `evidence/stage-header-checks-2002` and `evidence/request-gzip-1971-placed`
   (240 placement medians, each centred on its own A/A's median), the 59 whose two pads share a
   place in a 64-byte line spread 1.31% (standard deviation) and the 181 whose pads differ in
   it 1.37%, a ratio 78.2% of 20,000 seeded permutations reach either way. A reading chosen
   after the results and planned by no run.
