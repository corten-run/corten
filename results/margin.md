# corten-run/corten#1983: an older kept answer's Age written to a buffer, read across placements (declared 2026-11-23, before the run)

The binaries are built from two Corten commits (commits.env): base
`14126d2a8a12bccd173ec29032c1818d42904213`, main when this plan was written, and head
`8d02090bfa2bae538394e3a36a6b941de844390c`, one commit on it: a kept answer's `Age` of 10,000
seconds or more has its digits written to a buffer on the stack and copied into a value (one
allocation), where base makes the value from the number (two).

## The question, and what decides

Design Choice 70 records that this change was counted and not made: on single builds its cycles
missed the +1% margins set for it, in a run that could not tell where each build's code sat from
what the change cost. Those readings stand as recorded. Choice 70 names a rule that can tell the
two apart as its condition to read the change again, that rule is now Choice 72, and
corten-run/corten#1983 asks for the reading. This is that reading, under CONTRIBUTING, Pull
requests, item 2, on today's main.

Item 2 also says a single-build miss on a workload with no recorded spread stays binding, and
that a placement run declared after it does not clear it. This run is read as not being that
case, and the reading is stated here so a reviewer can reject it: the earlier run's misses are of
`b0bc7ae32` against `9b0f2e6aa` under the plan on #1964, and they are not cleared, reread or
pooled here. This is a new change (the buffer written again on a main whose kept answers have
since changed) with a plan of its own, which Choice 70's entry under Revisit and #1983 both call
for in so many words. If a reviewer holds that the earlier miss binds this change as well, the
change is not made, whatever this run reads.

The change is made (a pull request opened with it) only if every one of these holds:

1. **Cycles, a kept answer past the table (`old`)**: `change-old`'s one-sided 95% upper bound
   across placements on the change in user plus kernel cycles a request is under +1%, and
   `aa-old` resolves +1% in both of its readings.
2. **Cycles, a kept answer in the table (`young`)**: the same for `change-young` and `aa-young`.
   The change does not alter this answer's `Age`, but the function that makes it is the one the
   change edits and most kept answers given are this young, so it is held to the same margin.
3. **Instructions and allocations**, counted apart from this run under callgrind (below): an
   answer 10,005 seconds old takes at least 100 fewer instructions a request than base and one
   allocation fewer; an answer under ten seconds old takes within 16 instructions of base.

The margin is +1% with no floor. No smallest worthwhile reduction is declared, so no CPU-cost win
is claimed from this run whatever it reads: what the change is counted to save is an allocation.
A miss is final for this plan. A comparison that is not resolved or has no bound does not pass;
that leaves the question open for a run with a plan of its own, declared before it. No placement
is rerun, replaced or dropped for its result, nothing is pooled with another run, and this plan is
not declared again after the run. A host on which the counters cannot be counted at 100%, or that
stops answering before its first recorded turn, is replaced; from the first recorded turn the run
is this run.

## The builds (build.sh)

Every binary is the probe program of the first placement run (kit 1965's `probe/src/main.rs`,
features `json` and `compress`) with one more route: `GET /picture.png`, a PNG of 8,000 bytes
that do not compress, `Public` for four hours. That is the answer #1964's runs measured, there
served by the catalog benchmark with its file routes; `GET /picture-runs` gives how many times
its handler ran. The side's own Cargo.lock, the repository's release profile (opt-level 3, thin
LTO, one codegen unit), rustc 1.100.0 and its LLD, zstd linked to the system's libzstd, built on
the measuring host from one place, so paths do not differ between sides.

Each side (base, head) is **compiled once**, from an emptied target directory of its own.
rustc's linker driver is wrapped only to record the probe's final link and copy the objects rustc
deletes after it; the link itself is rustc's. Run again as captured, that link must give a binary
byte-identical to cargo's.

## The placements

A **placement** is the captured link run again with a pad first in `.text`: one object holding
one function of n bytes of `int3` that nothing calls, in a section of its own aligned to 16 and
flagged to survive `--gc-sections`, placed first by `-Wl,--symbol-ordering-file`, so every other
function moves by the pad and keeps its order and its neighbours (Choice 72).

The pad sizes are the first placement run's lists, fixed here before any binary is built or
measured (plan.env, written by `pads.mjs`, which the packing step checks plan.env against):

1. `PADS_P`, the pad of placement i (p_i): `320 15120 25824 40624 10304 21008 35808 5552 20288 30992 736 15536 26176 36880 10720 21424 36160 5904 16608 31408 1088 15888 26592 37296 11072 21776 36576 6320 16960 31760`.
   Base's A side in the A/A comparisons, and in the change comparisons the pad of both base and head.
2. `PADS_Q`, base's B side in the A/A comparisons (q_i): `22848 12160 38336 27648 12880 2192 32464 17680 7008 33184 22496 11808 38000 27312 12528 1840 32064 17280 6592 32768 22096 11408 37584 26896 16224 1440 31712 16928 6256 36528`.

A size is 4096 m + 64 t + 16 l: l the 16-byte step within a 64-byte line, t the line within the
page, m whole pages (0 to 9). All 60 are distinct multiples of 16 from 320 to 40,624 bytes, and
no size is in both lists. Across the 30 A/A pairs the 64-byte-line phases of p_i and q_i take all
16 ordered combinations, and q_i - p_i mod 4096 takes 30 distinct values: `2048 1136 224 3408 2576 1664 752 3936 3104 2192 1280 368 3632 2720 1808 896 0 3184 2272 1360 528 3712 2800 1888 1056 144 3328 2416 1584 672`,
which is 8, 8, 7 and 7 in the four quarters of a page (at least floor(30 / 8) = 3 in each), as
the rule for an A/A's lists asks; `pads.mjs --check` fails otherwise.

Pairing. In the change comparisons placement i is **base with pad p_i against head with pad
p_i**. In the A/As placement i is **base with pad p_i against base with pad q_i**: the change's
base against itself, compiled once with the change comparison's build inputs and run with its
probe program, workload and load inputs.

build.sh stops on any of these, before anything is measured:

1. A third-party version outside the side's Cargo.lock; a binary not linked to the system's
   libzstd, or whose `.comment` does not name LLD; a pad object whose function is not its size.
2. The captured link run again unpadded is not byte-identical to cargo's binary.
3. A placement (`layout.mjs` against the side's unpadded binary) whose functions are not exactly
   the unpadded binary's and the pad, whose pad is not at the start of `.text`, in which any
   function did not move by exactly the pad's size, or in which any pair of neighbours is not
   still next to each other in order.
4. Base with p_1 relinked a second time is not byte-identical to the first.
5. Two placements of one side with the same sha256. (Base and head with one pad may be one
   binary only if the change compiles to the same code; the count is reported.)

## The workloads, and how a start is made old

Both workloads are the same request to the same app (the probe's config `old`, which warms
nothing): `GET /picture.png` with `Accept-Encoding: identity` and `Accept: */*`, the header lines
#1964's load sent, from `wrk -t2 -c64`.

1. `young`: the answer is kept by the start's first request and given again from then on; its
   `Age` is 0 to a few seconds, a slice of the table. Base and head run the same instructions.
2. `old`: the same, and then the start's monotonic clock is moved on by STEP = 10005 seconds
   before its turn, so every request of the turn is given a kept answer 10,005 seconds old or a
   little more: past the table, where base makes the `Age` from the number and head writes it to
   a buffer. The lifetime is 14,400 seconds, so the answer still stands.

An answer cannot be made old in a process started a moment ago except by waiting or by moving
the clock, and Choice 72's protocol starts a build fresh for every turn. So every server is
started with a small library preloaded beside the allocator (`shim/clockstep.c`, built on the
host): it passes every `clock_gettime` on to the C library and adds a step to a reading of
`CLOCK_MONOTONIC`, the clock a kept answer's age is taken from. The step is 0 until the driver
sends the process `SIGUSR1`, and 10,005 seconds from then on. `CLOCK_REALTIME`, which `Date` is
written from, is not changed. The driver signals a start only for `old`. What this costs the
measurement: each `clock_gettime` the server makes passes through one more function, in every
turn of both sides and both workloads alike, so no comparison has it on one side only (in the
container test a request of the picture made 1.06 reads of that clock and 1.01 of another); and
an answer made old this way has not sat in memory for 2 hours 46 minutes, as #1964's had.

One thing the step disturbs, found in the container test and allowed for: Corten's connection
watch keeps a coarse clock of its own, which a step leaves behind until it next ticks, and
connections opened in the first second after a step were closed once as idle (62 or 63 of the
load's 64, with the load started 0, 0.3 and 0.6 s after it; none at 1.0 s, at 1.5 s, at 4 s or in
six tries at 2 s; none with a step of 25 seconds, which is under the 30-second header timeout).
So for `old` the driver waits 2 s between the step's check and the turn, and a turn with any
`wrk` error fails its placement, as in every kit.

Every start, the unrecorded pair's included, is checked, and no `Age` is accepted as any number:

1. Before its turn the driver asks for the picture twice with the load's header lines: the first
   answer must carry no `Age` (the handler made it) and the second an `Age` of 0 to 5 (given
   kept). For `old` the clock is then moved.
2. It asks once more: the `Age` must be 10005 to 10020 for `old` and 0 to 15 for `young`
   (plan.env's OLD_LOW, OLD_HIGH, YOUNG_LOW, YOUNG_HIGH), or the placement fails.
3. After the turn it asks again: the `Age` must still be in that range, and `/picture-runs` must
   be 1: the handler ran once in the start's life, so every request of the turn, whatever its
   header lines, was given the answer kept before the clock moved. Otherwise the placement fails.

Each start's two ages and its handler's runs are written beside its counts (`ages-<workload>.txt`),
and the report refuses a placement that lacks one.

## Answers compared before anything is recorded (verify.sh, run-pair-old.sh)

`verify.sh` starts every placement beside its side's unpadded binary and compares four answers of
each to the picture's request: made, given kept while young, given kept once the clock has moved,
and that again. Compared as received: the status, every header line but `Date`, and the body byte
for byte (8,000 bytes), with nothing in the body masked. One header value is set aside for the
comparison, the `Age`'s, which differs between two starts by the second each was asked in; it is
checked instead against its range (none on the first answer, 0 to 5 on the second, 10005 to 10020
on the third and fourth). Two answers of the unpadded binary must agree as well. So every
placement is shown to answer as its unpadded binary on both of the change's paths, an `Age` from
the table and an `Age` past it. Each placement run makes the same comparison between its own two
binaries first, with its workload's ranges, and the heads and bodies as received are kept in the
results. Any difference stops the run (verify) or fails the placement.

## Comparisons and method (run.sh)

A is the CSV's base rows and B its head rows.

1. `aa-old`: base-p<p_i> against base-p<q_i>, workload `old`.
2. `change-old`: base-p<p_i> against head-p<p_i>, workload `old`: the request the change alters.
3. `aa-young`: base-p<p_i> against base-p<q_i>, workload `young`.
4. `change-young`: base-p<p_i> against head-p<p_i>, workload `young`.
5. `unpadded-old`, a diagnostic no reading uses: base unpadded against base-p<p_i> for i = 1 to
   DIAG_K = 8, DIAG_R = 8 recorded pairs each, on `old`: where the build that would ship sits
   among the padded ones, which Choice 72 asks later runs to read more of.

Placements: **K = 30** per comparison. Pairs: **R = 8** recorded pairs per placement, after one
unrecorded pair. Each placement is one run of `run-pair-old.sh`, which is kit 1965's
`run-pair-fresh.sh` with the checks above: every turn, the unrecorded pair's included, on a
freshly started build pinned to CPU 2, `wrk -t2 -c64` for 3 s on CPUs 4 and 5, the driver and
`perf` on CPU 7, A and B's order turned every pair, jemalloc 5.3.0 preloaded with
`MALLOC_CONF=background_thread:true,tcache_max:65536` (the probe checks it), `cycles:u`,
`cycles:k`, `instructions:u` and `L1-icache-load-misses:u` counted by `perf stat` on the server's
process over each turn, every counter numeric and at 100%, and no `wrk` error, or that placement
fails.

The four read comparisons run interleaved by placement: placement 1 of each, then placement 2 of
each, to 30, so a drift of the host over the run falls on all four alike; the diagnostic's 8
placements run after them. Before them, each comparison's placement 1 runs its answer check and
one unrecorded pair; a failure stops the run.

## Reading (report.mjs, placement.mjs)

Per pair, the change is B / A - 1 in user plus kernel cycles per request.

1. **Per placement**: the median of its 8 per-pair changes.
2. **Across placements, the gate's statistic**: the median of the 30 placement medians, and its
   one-sided 95% distribution-free upper bound, an order statistic: the smallest rank j with
   P(Binomial(30, 1/2) >= j) <= 5%, which is **the 20th of the 30** sorted placement medians.
   Its 95% is nominal, as Choice 72 says: the pads are a declared set, not a random sample of
   the builds a change can land in.
3. **Resolution**: each A/A is read twice from the same pairs, as recorded and with its lists'
   labels swapped (each per-pair change read as A / B - 1). It **resolves** +1% only if its
   bound is under +1% in both readings; with either at or above +1%, or with fewer than 30
   complete placements, the workload is **not resolved**.
4. **The change** on a workload: it **meets +1%** if its bound is under +1% and the workload's
   A/A is resolved; it **misses +1%** if its bound is at or above +1% and the A/A is resolved; it
   is **not resolved**, which does not pass, if the A/A is not resolved, whatever its own bound.
5. A comparison with fewer than 30 complete placements (a placement failed, has other than 8
   pairs, lacks a checked `Age` for a start, or names a binary that is not the plan's for it)
   gives no bound, which does not pass.

Reported across placements as cycles are, and read by no verdict: user cycles, kernel cycles,
user instructions and user L1 instruction-cache misses per request (the change adds a function);
the one-sided 95% lower bound, the 11th of the 30; the mean of the placement medians with a
one-sided 95% Student t bound; the spread between placements against the spread within them; each
A/A's lowest and highest placement median, the placement spread of its workload on this setup;
how many placements sit above zero with a two-sided sign test; and the unpadded diagnostic. Per
placement: both sides' median cycles and instruction-cache misses per request, the median change
and its range, the user and kernel split and the instruction change. Every binary's sha256, every
placement's layout, the captured link lines, the shim's source and the host are in the results.

This run reads no recorded placement spread (Choice 72 records none for this request or this
setup) and no single-build bound. Whether its A/As' spreads are recorded in Choice 72 is for the
pull request that reports it.

## Instructions and allocations (counted apart)

Under callgrind in a Linux container, as #1964's counts were: the catalog benchmark with its
file routes and the PNG's lifetime set to four hours, on this plan's base and with this plan's
change on it, one connection, a browser's twelve header lines and no coding named; the count for
1,300 requests less the count for 300, over 1,000. For the old answer each server is started,
asked once, and left for 10,005 seconds of real time before it is asked again, with no clock
moved; the allocations are callgrind's calls to `malloc`. Those counts were started before this
plan was posted, since the wait is 2 hours 47 minutes, and none had been read when it was
written. Two counts of one build have differed by 256 instructions over 1,000 requests.

## Time

On a c-8 cloud host (8 dedicated vCPUs, Debian 13). A turn is a start, four requests, 3.4 s
under `perf` and a stop, about 4.2 s for `young` and, with the wait after the step, 6.2 s for
`old`; a placement is its answer check and 9 pairs, about 79 s and 115 s (estimates from the
container dry run).

1. Setup (packages, rustup) and two full builds: about 12 minutes. Relinks and layouts of 90
   placements: about 2 minutes.
2. verify.sh, 90 placements: about 4 minutes. Checks: about 2 minutes.
3. Placements: 2 x 30 x 115 s and 2 x 30 x 79 s, 194 minutes, and the diagnostic's 8, about 15
   minutes.

About 3 hours 50 minutes in all.
