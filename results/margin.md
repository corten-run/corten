# corten-run/corten#1965: cycles across placements, declared before the run (2026-11-23, prepared; not yet run)

The binaries are built from three Corten commits (commits.env): main `a02c81e86e6eb81cd6ee5e3815886cb2c4e1a71e`,
and for #1955 ("Give a kept answer again with three fewer allocations") its merge
`5a22836fc283e9d731c701fb7dfa74ce3a843684` (head) and that merge's first parent
`bd6b7741f3e3ce1407a22cbe3f6383093a9e1d2e` (base).

This plan replaces the one of 2026-11-22, which placed functions with LLD's `--shuffle-sections`
and was never run: its container dry run showed a shuffle is not the kind of placement difference
#1965 is about (seed 1 on main kept 5 of 3,335 neighbour pairs and moved all 3,404 functions to a
new order), so it measured a different perturbation from the one a build's placement moves.

## The question

The paired-cycle gate (CONTRIBUTING, Pull requests, item 2) reads one build of each side, and one
build's code placement moves a touched request's cycles by up to about 4% either way (#1965; its
evidence is #1955's pad builds, which put a never-called block of up to about 40,000 bytes in
front of the code). Does reading a touched workload across K placements of each side, each
placement started fresh on every turn, resolve the +1% margin, and what does it say of a known
small change?

1. A/A, main against main across placements, on `plain` and on `kept`: what the protocol can
   resolve on each workload.
2. #1955's change, base against head across the same placements, on `kept`, the request it
   touches: the protocol's reading of it.
3. A diagnostic: where main's unpadded build (the one that would ship) falls among its padded ones.

**Nothing here gates a pull request.** #1955 is merged; its reading here is reported as what the
protocol says of it, and does not reopen it. The A/A rows test no margin: their bound is the run's
resolution, reported as measured.

## The builds (build.sh)

Every binary is #1829's probe program (`probe/src/main.rs`, kit 1923's, unchanged), features `json`
and `compress`, the side's own Cargo.lock, the repository's release profile (opt-level 3, thin LTO,
one codegen unit), rustc 1.100.0 and its LLD (23.1.5 in kit 1923's run), zstd linked to the
system's libzstd, built on the measuring host from one place (`/m/1965/work`, `/m/1965/probe`), so
paths do not differ between sides.

Each side (main, base, head) is **compiled once**, from an emptied target directory of its own.
rustc's linker driver is wrapped (`wrap/cc`, first on PATH) only to record the probe's final link
and copy the objects rustc deletes after it (`link-capture.mjs`); the link itself is rustc's, as
in kit 1923. Run again as captured (`relink.mjs`), that link must give a binary byte-identical to
cargo's.

## The placements

A **placement** is the captured link run again with a pad first in `.text`. A pad of n bytes is
one object (`pads/pad-<n>.o`, assembled by build.sh) holding one function, `corten_layout_pad`, of
n bytes of `int3` that nothing calls, in a section of its own aligned to 16 and flagged to survive
`--gc-sections`; `relink.mjs` adds it and `-Wl,--symbol-ordering-file=pads/order.txt` (that one
name) to the link, so LLD places the pad first and every other function after it **in the default
order, each moved by the pad**. So a placement keeps every function's neighbours and changes only
where the code sits against 64-byte lines and 4 KiB pages, the kind of difference #1955's pad
builds made, without touching the source or the compile.

The pad sizes, fixed here before any binary is built or measured (plan.env, written by
`pads.mjs`, which `pack.ps1` checks plan.env against):

1. `PADS_P`, the pad of placement i (p_i): `320 15120 25824 40624 10304 21008 35808 5552 20288 30992 736 15536 26176 36880 10720 21424 36160 5904 16608 31408 1088 15888 26592 37296 11072 21776 36576 6320 16960 31760`.
   Main's A side in the A/A comparisons, and in the change comparison the pad of both base and head.
2. `PADS_Q`, main's B side in the A/A comparisons (q_i): `22848 12160 38336 27648 12880 2192 32464 17680 7008 33184 22496 11808 38000 27312 12528 1840 32064 17280 6592 32768 22096 11408 37584 26896 16224 1440 31712 16928 6256 36528`.

Why these sizes. A size is 4096 m + 64 t + 16 l: l the 16-byte step within a 64-byte line (0 to 3;
rustc aligns functions to 16, so every function moves by the same amount), t the line within the
page (0 to 63), m whole pages (0 to 9, so up to about 40,000 bytes, the range of #1955's pad
builds). For placement i, P takes l = i mod 4, t = (39 i + 5) mod 64, m = 3 i mod 10, and Q takes
l = floor(i / 4) mod 4, t = (25 i + 37) mod 64, m = (7 i + 5) mod 10. So all are multiples of 16
and not all multiples of 64: each list has the four line phases about equally (P 8, 8, 7, 7 of 0,
16, 32 and 48 bytes; Q 8, 8, 8, 6), page phases spread by a golden-ratio step (P's quarters of a
page 8, 7, 8, 7; Q's 7, 7, 8, 8), and three sizes in each of the ten pages; P runs from 320 to
40,624 bytes and Q from 1,440 to 38,336. An A/A pair (p_i against q_i) has line phases
(i mod 4, floor(i / 4) mod 4), all 16 combinations among the 30. No size repeats across the two
lists, so no A/A pair shares a placement.

Pairing. In the change comparison placement i is **base with pad p_i against head with pad p_i**:
the same offset applied to each side's own layout, which is what a pull request's two builds are
(the same code placement rules, each on its own code). In the A/As placement i is **main with pad
p_i against main with pad q_i**, so the A/A sees placement differences of the same kind and size
as the ones it is meant to resolve, and no A/A pair is one binary against itself.

build.sh stops on any of these, before anything is measured:

1. A third-party version outside the side's Cargo.lock; a binary not linked to the system's
   libzstd, or whose `.comment` does not name LLD; a pad object whose function is not its size.
2. The captured link run again unpadded is not byte-identical to cargo's binary.
3. A placement (`layout.mjs` against the side's unpadded binary, adapted from kit 1923's) whose
   functions are not exactly the unpadded binary's and the pad, whose pad is not at the start of
   `.text`, in which any function did not move, or in which any pair of neighbours is not still
   next to each other in order. How many functions moved by exactly the pad, and the other
   shifts, are recorded per placement (`placements.txt`, `placements-summary.txt`), not required.
4. Main with p_1 relinked a second time is not byte-identical to the first (a pad is one placement).
5. Two binaries with the same sha256.

Then, before any turn is recorded, `verify.sh` starts every placement beside its side's unpadded
binary (config `hit`) and compares their answers to `GET /private` and `GET /page`: status, every
header but `Date`, and body, after `mask.sed` (the `Age` and `ETag` values, drawn per process);
the placement's `/page` must be given kept (an `Age`) and both starts must log the page kept by
their warm-up. Any difference stops the run.

## Comparisons and method (run.sh)

A is the CSV's base rows and B its head rows.

1. `aa-plain`: main-p<p_i> against main-p<q_i>, workload `plain`: `GET /private` to config
   `plain`, the record page for one visitor (not Public), Choice 71's calibration workload.
2. `aa-kept`: main-p<p_i> against main-p<q_i>, workload `kept`: `GET /page` to config `hit`, the
   same record page, Public, warmed twice before the port opens so every request is given the
   kept answer again (kit 1923's `hit`).
3. `change-kept`: base-p<p_i> against head-p<p_i>, workload `kept`: the request #1955 changed (an
   `Age` written without an allocation, the cache's mark read from the entry).
4. `unpadded-kept`, a diagnostic no reading uses: main unpadded against main-p<p_i> for i = 1 to
   DIAG_K = 8, DIAG_R = 8 recorded pairs each, on `kept`: where the build that ships sits among
   the padded ones (median of its 8 placement medians, their range, how many of 8 padded
   placements cost more, and a two-sided sign test).

Placements: **K = 30** per comparison. Pairs: **R = 8** recorded pairs per placement, after one
unrecorded pair. Each placement is one run of `run-pair-fresh.sh` (kit 1923's, unchanged): every
turn, warm-up included, on a freshly started build pinned to CPU 2, `wrk -t2 -c64` for 3 s on CPUs
4 and 5 (`lua/get.lua`), the driver and `perf` on CPU 7, A and B's order turned every pair,
jemalloc preloaded (`PROBE_ALLOCATOR=jemalloc` checks it), the two builds' answers compared first
(status, headers but Date, body, after `mask.sed`) and required the same; `cycles:u`, `cycles:k`
and `instructions:u` counted by `perf stat` over each turn, every counter numeric and at 100%, no
`wrk` error, or that placement fails. For `kept`, every start of both builds must log the page
kept, all of one size. So each placement is started fresh 18 times for its recorded pairs, and a
placement and a process start are told apart: a start's own variation is inside each placement's
pairs, a placement's between them.

The three read comparisons run interleaved by placement: placement 1 of each, then placement 2 of
each, to 30, so a drift of the host over the run falls on all three alike; the diagnostic's 8
placements run after them. Before them, each comparison's placement 1 runs its answer check and
one unrecorded pair (`results/check-only/`); a failure stops the run.

## Reading (report.mjs, placement.mjs)

Per pair, the change is B / A - 1 in user+kernel cycles per request.

1. **Per placement**: the median of its 8 per-pair changes.
2. **Across placements, the gate's statistic**: the median of the 30 placement medians, and its
   one-sided 95% distribution-free upper bound, an order statistic: the smallest rank j with
   P(Binomial(30, 1/2) >= j) <= 5%, which is **the 20th of the 30** sorted placement medians
   (coverage 95.06%: P(Binomial(30, 1/2) >= 20) = 0.0494, and >= 19 is 0.1002), as the 59th of 100
   is for pairs (computed by `stats.mjs`'s `upperRank`, checked by `check-report.mjs`).
3. **Resolution**: the A/A on a workload is what the run can resolve there. An A/A whose bound is
   under +1% resolves the margin; one whose bound is at or above +1%, or with fewer than 30
   complete placements, is **not resolved**.
4. **The change**: `change-kept`'s bound against +1%, no floor. It **meets +1%** if the bound is
   under +1% and `aa-kept` is resolved; it **misses +1%** if the bound is at or above +1% and
   `aa-kept` is resolved; it is **not resolved**, which does not pass, if `aa-kept` is not
   resolved, whatever its own bound.
5. A comparison with fewer than 30 complete placements (a placement failed, or has other than 8
   pairs, or names a binary that is not the plan's for it) gives no bound. No placement is rerun,
   replaced or dropped for its result; nothing is pooled with another run; this plan is not
   declared again after the run.

Diagnostics, which no reading uses: the same statistics for user cycles, kernel cycles and user
instructions per request (the A/A instructions should be flat; #1955 removed about 500 a request
under load); the one-sided 95% lower bound across placements, the 11th of the 30 (the benefit
side: no smallest worthwhile reduction is declared, so no CPU-cost win is claimed from it); the
mean of the 30 placement medians with a one-sided 95% Student t bound (t(0.95, 29) = 1.6991);
the spread between placements (the standard deviation of the placement medians) against the
spread within them (the pooled standard deviation of per-pair changes in a placement, and what
that alone would give a median of 8 pairs, 1.2533 x within / sqrt(8)); each A/A's largest
placement median in absolute value and the range of its placement medians (how far one pair of
builds, one placement each, sat from no change: the spread against which a single-build run's
bound is read); how many placements sit above zero with a two-sided sign test; and the unpadded
diagnostic. Per placement: both sides' median cycles per request, the median change and range,
the user and kernel split and the instruction change. Every binary's sha256, every placement's
layout, the captured link lines and the host are in the results.

## R = 8, not 12

The statistic reads each placement's median, so R matters only through how much a median of R
pairs varies on its own, and that adds to the spread between placements. From earlier runs'
per-pair changes (a bootstrap of medians of R pairs, on the workstation, not in the kit; estimates): kit 1923's
same-build A/A on `plain` has a per-pair standard deviation of 2.42% and medians of 8 and 12 pairs
vary by 0.95% and 0.80%; its pad-40 A/A 2.85%, 0.96% and 0.80%; #1829's fresh `hit` 3.17%, 1.03% and
0.85%. With a between-placement standard deviation s_b, the 20th of 30 sits about
2.06 x sqrt(s_b^2 + s_R^2) / sqrt(30) above the median (normal approximation): at s_b = 1%, 0.49
points with R = 12 and 0.54 with R = 8; at s_b = 2%, 0.82 and 0.85. So R = 8 widens the bound by
about 0.03 to 0.05 points and saves a third of the turns (3 x 30 x 4 pairs, about 44 minutes),
which pays for the diagnostic and leaves the run near 2 hours. The time saved could instead buy
more placements (K = 40 at R = 8 fits 3 hours and narrows the bound by about 13%); K = 30 is kept
because it is where the order statistic's coverage is closest to 95% between 24 and 32 (the 20th
of 30, 95.06%), and so the run can be compared with this plan's first version. R stays even so
the order turns evenly within each placement. If the run's between-placement spread is much
smaller than s_R, R was the wrong thing to cut; the report gives both, and that is a reason to
revisit the plan for a later run, not to change this one.

## Time

On a DigitalOcean c-8 (8 vCPU, Debian 13). Pair rates are kit 1923's on a c-8: `plain` 6.9 s a
pair (results-b7: 101 pairs in 11 min 38 s, each of three comparisons), `kept` 7.3 s a pair
(1923's plan: about 37 minutes for 303 `hit` pairs). A placement's answer check adds about 2 s
(estimate). Each placement is R + 1 = 9 pairs.

1. Setup (packages, rustup): about 3 minutes.
2. Build: three full builds, about 3 to 4 minutes each on a c-8 (kit 1923's full builds took 126
   and 172 s in a busy 8-CPU container; this kit's dry runs took 210, 176 and 128 s, then 111, 115
   and 118 s, in a container on a 12-CPU workstation): about 10 to 12 minutes. Relinks and layouts: 120 placements
   (main 60, base 30, head 30); this round's dry run relinked and checked 20 in 24 s, so the
   120 here take about 2.5 minutes.
3. verify.sh: 120 placements; the dry run verified 20 in 18 s, so about 2 minutes.
4. Checks: 4 unrecorded pairs and the answers, under 1 minute.
5. Placements:
   1. `aa-plain`: 30 x (9 x 6.9 s + 2 s) = 1,923 s, 32.1 minutes.
   2. `aa-kept`: 30 x (9 x 7.3 s + 2 s) = 2,031 s, 33.9 minutes.
   3. `change-kept`: the same, 33.9 minutes.
   4. `unpadded-kept` (diagnostic): 8 x (9 x 7.3 s + 2 s) = 542 s, 9.0 minutes.
   In all 108.9 minutes of turns.

About 127 to 129 minutes in all (2 h 10 min at most), under 3 hours. The dry-run times are from a
container on a busy workstation, not a c-8, and are estimates here.
