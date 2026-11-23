# corten-run/corten#1971: cycles across placements, declared before the run (2026-11-23)

The binaries are built from two Corten commits (commits.env): base, main
`14126d2a8a12bccd173ec29032c1818d42904213`, and head,
`498291116fe5d3e3088bb3a663d1afc4dd998898`, this branch with that main merged (the base is its
second parent). Base to head changes `crates/corten/src/compress.rs`, `crates/corten/Cargo.toml`
(the `libdeflater` dependency), `Cargo.lock`, a test, the template's README and card-market's
smoke script and one line of its app.

## What this run is, and what it does not undo

The first declared run for this pull request read one build of each side (`bcf4aa073` against
`fdf94a6a7`, a 48-core host, an HttpArena entry as the probe) and missed +1% on its zstd
workload (bound +1.50% on unchanged instructions). That result stands as recorded. Its diagnostic
found that the base built with a never-called function of 3,100 bytes read +0.71% against the
base at the median (bound +0.95%), so where the code sat moved that workload by most of the margin.

Since then `main` has the reading across placements (design Choice 72, Pull requests item 2).
That text also says a single-build run stays binding for a workload it read with no spread that
applies, and that "a placement run declared after it does not clear such a miss". This plan does
not claim to clear the first run's miss. It measures the code that would merge, a new base and
head, with the probe, host kind and turn protocol the repository's placement runs use, under a
plan that names its touched workloads as read across placements before anything is measured,
because the maintainer asked for a new declared run under a protocol first shown to resolve 1%
by comparing a setting with itself. Whether a reading under this plan can carry the pull request
where the first run missed is for its review and the maintainer to say; the result is reported
either way, beside the first.

## Workloads

All are `GET /private` to the probe's `plain` config: #1829's probe program (kit 1965's
`probe/src/main.rs`, unchanged), features `json` and `compress`; the page is the record page for
one visitor, about 6 KB, not kept, compressed as it is sent when the client accepts a coding.

1. `zstd`, held as fast as it was, **read across placements**: `Accept-Encoding: gzip, deflate,
   br, zstd`. zstd 1 before and after, chosen by the negotiation the change rewrote
   (`Accepts::now`). Touched: +1%, no floor.
2. `plain`, held as fast as it was, **read across placements**: no `Accept-Encoding`, so the page
   is sent as it is, through the same stage. Touched: +1%, no floor. Choice 72's recorded spread
   for `plain` is for a Xeon Platinum 8358; these hosts are an 8168 and an 8280, so no recorded
   spread applies, and this plan reads `plain` across placements from the start.
3. `gzbr`, the reduction the change is for, **read on one build of each side** (cargo's unpadded
   binaries): `Accept-Encoding: gzip, br`. Brotli 1 before, libdeflate's gzip after. Smallest
   worthwhile reduction 5% of user plus kernel cycles a request, claimed only if the one-sided 95%
   upper bound on the median per-pair change is at or below -5%: 40 recorded pairs after one that
   is not, the bound the 26th of the 40 sorted changes. No recorded spread applies to this
   request on this setup, so the single-build bound is its reading.

## Builds and placements (build.sh)

Each side is compiled once on the measuring host, from an emptied target directory, with the
side's own Cargo.lock, the repository's release profile (opt-level 3, thin LTO, one codegen
unit), rustc 1.100.0 and its LLD, zstd linked to the system's libzstd; libdeflate's C is compiled
by the head's build as an app's is. The probe's final link is recorded (`wrap/cc`,
`link-capture.mjs`) and a placement is that link run again with a pad first in `.text`
(`relink.mjs`): one function of n bytes of `int3` that nothing calls, placed first by
`-Wl,--symbol-ordering-file`, so every other function moves by the pad and keeps its order.

K = 30 placements a comparison, the pad sizes kit 1965 declared (`pads.mjs` checks them):

1. `PADS_P` (p_i): `320 15120 25824 40624 10304 21008 35808 5552 20288 30992 736 15536 26176 36880 10720 21424 36160 5904 16608 31408 1088 15888 26592 37296 11072 21776 36576 6320 16960 31760`.
2. `PADS_Q` (q_i): `22848 12160 38336 27648 12880 2192 32464 17680 7008 33184 22496 11808 38000 27312 12528 1840 32064 17280 6592 32768 22096 11408 37584 26896 16224 1440 31712 16928 6256 36528`.

No size is in both lists. Across the 30 pairs the 64-byte-line phases of p_i and q_i take all 16
ordered combinations, and q_i - p_i mod 4096 takes 30 distinct values (0, 144, 224, 368, 528,
672, 752, 896, 1056, 1136, 1280, 1360, 1584, 1664, 1808, 1888, 2048, 2192, 2272, 2416, 2576,
2720, 2800, 3104, 3184, 3328, 3408, 3632, 3712, 3936), 8, 8, 7 and 7 of them in the four quarters
of a page.

Placement i of the change is **base with pad p_i against head with pad p_i**. Placement i of an
A/A is **base with pad p_i against base with pad q_i**: the change's base against itself.

build.sh stops, before anything is measured, unless: no third-party version outside the side's
Cargo.lock was resolved; each binary is linked to the system's libzstd and by LLD; the captured
link run again without a pad is byte-identical to cargo's binary; each placement has exactly
that binary's functions and the pad, the pad first in `.text`, every function moved, every pair
of neighbours still next to each other in order, and every function moved by exactly the pad's
size but those named under "The C code" below; base with p_1 relinked a second time is
byte-identical; and every binary has a SHA-256 of its own.

### The C code

Pull requests asks that every function of a placement moved by exactly the pad's size. The base's
do: all of its code is rustc's, one section a function, aligned to 16 bytes. The head's cannot,
and this plan says so before anything is measured, from the build alone (no turn was run): the
change links libdeflate, whose C the system's compiler (gcc 14.2.0 here) put in function sections
of which it aligned 17 to 64 bytes and 5 to 32. A section aligned to 64 bytes can only move by a
multiple of 64, so with a pad that is not one the linker moves it, and what it lays after it, by
the pad rounded. In the head the C code is the last 43 function symbols of `.text`: libdeflate's
39 and the four linked after them (`__udivti3`, `round`, `_init`, `_fini`); with the pad of
15,120 bytes its first function moved by exactly the pad, 39 of the others by 15,104 and 3 by
15,136, and the sections after `.text` (`.data`, `.got`, `.bss` and the rest) by 15,104. The
3,405 function symbols before it, all of Corten's and the probe's among them, moved by exactly
the pad. Over the 30 pads the build made, each of the 43 moved by its pad or by 16 or 32 bytes
more or less, and by exactly the pad in the 8 placements whose pad is a multiple of 64.

So for the head this plan's check is (`tail.mjs`): every function before the first one a C
archive of the build defines moved by exactly the pad, and every function from it on moved by
exactly the pad or by a multiple of 32 bytes less than 64 bytes from it, with its neighbours
kept; each placement's shifts are recorded. That departs from the letter of Pull requests' check for those functions,
which no pad sizes with the 16-byte phases it also asks for could meet. Neither workload read
across placements compresses with gzip, so neither calls libdeflate; whether a request reaches
`__udivti3` or `round` was not looked at. This pull request also changes the rule's text and
design Choice 72 to say how such code is checked, since it is this change that puts it in an
app's binary; whether this reading counts depends on the review accepting that.

One more difference follows from it and is not removed by this plan: the base's sections after
`.text` move by exactly the pad, so across placements its data takes each 16-byte phase of a
64-byte line, while the head's move by the pad rounded to a multiple of 64 and keep theirs. The
A/A, base against base, cannot see what that does to the comparison. For the 8 placements whose
pad is a multiple of 64 (1, 5, 9, 13, 17, 21, 25 and 29) both sides' every function and section
move by exactly the pad; the report gives the change's placement medians for those 8 beside the
other 22 as a diagnostic, which no reading uses.

Then `verify.sh` starts every placement beside its side's unpadded binary and compares their
answers to the three workloads' requests: status, every header but `Date` with nothing masked,
and the body as received, byte for byte (the zstd and brotli or gzip bodies as the server sent
them). Any difference stops the run.

## Comparisons and method (run.sh)

1. `aa-plain` and `change-plain`, on one c-8 (the first host made, a Xeon Platinum 8168),
   interleaved by placement.
2. `aa-zstd` and `change-zstd`, on a second c-8 (a Xeon Platinum 8280), interleaved by
   placement; after them `sb-gzbr`, base against head unpadded.

R = 8 recorded pairs per placement after one that is not. Each placement is one run of
`run-pair-fresh.sh` (kit 1923's, with its answer check changed to compare the body raw): every
turn, the unrecorded pair's included, on a freshly started build pinned to CPU 2, `wrk -t2 -c64`
for 3 s on CPUs 4 and 5, the driver and `perf` on CPU 7, A and B's order turned every pair,
jemalloc 5.3.0 preloaded with `MALLOC_CONF=background_thread:true,tcache_max:65536`. Counted by
`perf stat` over each turn: `cycles:u`, `cycles:k`, `instructions:u` and
`L1-icache-load-misses:u` (the change adds code), every counter numeric and at 100%, no `wrk`
error, or that placement fails. Before a placement's pairs its two builds' answers to the
workload's request are compared: for `plain` and `zstd`, status, headers but `Date` with nothing
masked, and the body as received; for `gzbr`, the decoded body (`curl --compressed`) and the
headers but `Date` and the values of `Content-Encoding` and `Content-Length`, which the change is
meant to alter.

## Reading (report71.mjs)

Per pair, the change is B / A - 1 in user plus kernel cycles a request.

1. Per placement: the median of its 8 per-pair changes.
2. Across placements: the median of the 30 placement medians and its one-sided 95% upper bound,
   the 20th of the 30 sorted (P(Binomial(30, 1/2) >= 20) = 0.0494).
3. Resolution: the A/A is read twice from the same pairs, as recorded and with its lists' labels
   swapped (each per-pair change read as A / B - 1). If either bound is at or above +1%, or the
   A/A has fewer than 30 complete placements, the workload is **not resolved**, which does not
   pass whatever the change's bound.
4. The change on a workload **meets +1%** if its bound across placements is under +1% and that
   workload's A/A is resolved, and **misses** if its bound is at or above +1% with the A/A
   resolved. No floor.
5. A placement that fails a check, has other than 8 pairs, or names a binary that is not the
   plan's leaves its comparison with no bound, which does not pass. No placement is rerun,
   replaced or dropped for its result, and this plan is not declared again after the run.

Reported as diagnostics, which no reading uses: user cycles, kernel cycles, user instructions and
user L1 instruction-cache misses a request across placements as cycles are; the lower bound (the
11th of 30); the mean of the placement medians with a Student t bound; the spread between
placements against the spread within them; each A/A's range of placement medians. The A/As'
ranges are not recorded in Choice 72 by this pull request.

## A dry run of the scripts

After this plan is in the pull request's description and before the run, `DRYRUN=1` runs the
scripts on each host with the first 5 pads of each list and 2 pairs, to find mistakes in the
kit. It is marked `DRYRUN`, is not a measurement and is read for no margin; its results are kept
beside the run's. A script may be corrected after it; nothing this plan declares may change.

## Not planned

A client with gzip alone or brotli alone; a body past 16 KiB; JSON written by `Json` (the first
run's workload); more than one runtime; the unpadded build against its padded ones; a second
host kind.

## Time (estimated from kit 1965's run: 62 to 68 s a placement of 9 pairs)

Each host: 60 placement runs, about 65 minutes, after about 3 minutes of verify and checks; the
second host's 41 single-build pairs add about 5 minutes.
