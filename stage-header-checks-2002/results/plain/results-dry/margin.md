# Stage header checks: cycles across placements, declared before the run (2026-11-23)

The binaries are built from two Corten commits (`commits.env`): base, main
`6f1bbf0553ec3b60c884bf5855fe8786ca25f1c2`, and head, `66fa66c49be1d60ab7ca90cb3a9a36762092c739`, this branch (the base is the
commit it was cut from). Base to head changes `crates/corten/src/api.rs`, `cache.rs`,
`compress.rs` and `page.rs` (code, comments and unit tests) and `docs/design.md`.

No cycle of either build was counted before this plan was in the pull request's description.
What was counted before it is instructions, by callgrind, on another app (the pull request's
description gives them); they are not read here.

## Workloads

Each is sent to one probe program (`probe/src/main.rs`, features `json` and `compress`, config
`plain`): one app with a page route and a mounted API. The page and the allocator check are
#1829's probe's (kit 1965's), unchanged; the API route is new, so the program is not kit 1965's
and no placement spread design Choice 72 records applies to it. The allocator's setting differs
from those spreads' too (below). Every workload is therefore **read across placements** from
the start, and each is one the change touches: held to **+1%, no floor**.

1. `plain`: `GET /private` with no request header of its own. The record page for one visitor,
   about 6 KB, not kept, sent as it is. Touched: the answer's `Cache-Control` and `Vary` are
   read by the compression and tag stages.
2. `browser`: `GET /private` with the headers of a Firefox navigation (a Firefox 140
   `User-Agent`, `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`,
   `Accept-Language: en-US,en;q=0.5`, `Accept-Encoding: gzip, deflate, br, zstd`,
   `Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Site: none`). The same
   page, compressed with zstd 1 as it is sent. Touched: the same, and how `Accept` and
   `Accept-Encoding` are read.
3. `api`: `GET /api/sum?a=1&b=2` with the headers of a same-origin `fetch` from Firefox
   (as above with `Accept: */*`, `Sec-Fetch-Dest: empty`, `Sec-Fetch-Mode: cors`,
   `Sec-Fetch-Site: same-origin`). A route of a mounted API: typed query values in, a short
   `String` out, too short to compress. Touched: the request mode's two headers are no longer
   read under an API, and `Accept-Encoding` is read as in 2.

**The reduction, declared for `api` alone:** the smallest worthwhile reduction is **1% of user
plus kernel cycles a request**, read across placements as below. No reduction is declared for
`plain` or `browser`, and none will be claimed for them whatever they read.

## Builds and placements (build.sh)

Each side is compiled once on the measuring host, from an emptied target directory, with the
side's own `Cargo.lock`, the repository's release profile (opt-level 3, thin LTO, one codegen
unit), rustc 1.100.0 and its LLD, zstd linked to the system's libzstd. The probe's final link is
recorded (`wrap/cc`, `link-capture.mjs`) and a placement is that link run again with a pad first
in `.text` (`relink.mjs`): one function of n bytes of `int3` that nothing calls, placed first by
`-Wl,--symbol-ordering-file`, so every other function moves by the pad and keeps its order.

**K = 60 placements a comparison.** Design Choice 72 says an A/A of 30 placements may not
resolve, and a plan with no A/A read on its setup has no figure to take K from; 60 is twice the
two runs' size, chosen for that reason alone and before any reading. The pad sizes are
`pads.mjs`'s: its first 30 of each list are kit 1965's 30, and its rule is carried on to 60 with
the second 30 of `PADS_Q` moved by one 64-byte line, since kit 1965's rule alone repeats
q_i - p_i mod 4096 every 32 placements.

1. `PADS_P` (p_i): `320 15120 25824 40624 10304 21008 35808 5552 20288 30992 736 15536 26176 36880 10720 21424 36160 5904 16608 31408 1088 15888 26592 37296 11072 21776 36576 6320 16960 31760 1504 16304 26944 37648 11488 22192 32832 6672 17376 32176 1856 12560 27360 38064 11840 22544 33248 7088 17728 32528 2272 12976 27712 38416 12256 22960 33600 7440 18144 28848`.
2. `PADS_Q` (q_i): `22848 12160 38336 27648 12880 2192 32464 17680 7008 33184 22496 11808 38000 27312 12528 1840 32064 17280 6592 32768 22096 11408 37584 26896 16224 1440 31712 16928 6256 36528 21808 11120 37248 26560 15872 5184 31376 16592 10000 36176 21408 14816 36896 26208 19632 752 31024 20336 5504 35776 20992 14400 40592 25808 19216 336 30624 19936 5152 35424`.

No size is in both lists; each is a multiple of 16 from 320 to 40,624 bytes. Across the 60 pairs
the 64-byte-line phases of p_i and q_i take all 16 ordered combinations, and q_i - p_i mod 4096
takes 60 distinct values (0, 64, 144, 208, 224, 288, 368, 432, 528, 592, 672, 752, 816, 896, 960, 1056, 1120, 1136, 1200, 1280, 1344, 1360, 1424, 1584, 1664, 1728, 1808, 1872, 1888, 1952, 2048, 2112, 2192, 2256, 2272, 2336, 2416, 2480, 2576, 2640, 2720, 2784, 2800, 2864, 3008, 3104, 3168, 3184, 3248, 3328, 3392, 3408, 3472, 3632, 3696, 3712, 3776, 3920, 3936, 4000), 15 of them in each quarter of a page. `PADS_P` has 15 sizes in
each 16-byte phase of a line and `PADS_Q` 16, 16, 16 and 12. `pads.mjs --check` checks all of
this against `plan.env`.

Placement i of the change is **base with pad p_i against head with pad p_i**. Placement i of an
A/A is **base with pad p_i against base with pad q_i**: the change's base against itself.

build.sh stops, before anything is measured, unless: no third-party version outside the side's
`Cargo.lock` was resolved; each binary is linked to the system's libzstd and by LLD; the build
made no C archive of its own (both sides are rustc's code alone); the captured link run again
without a pad is byte-identical to cargo's binary; each placement has exactly that binary's
functions and the pad, the pad first in `.text`, every function moved by exactly the pad's size,
and every pair of neighbours still next to each other in order; base with p_1 relinked a second
time is byte-identical; and every binary has a SHA-256 of its own.

Then `verify.sh` starts every placement beside its side's unpadded binary and compares their
answers to the three workloads' requests, each with its workload's headers: status, every header
but `Date` and the value named next, and the body as received, byte for byte. Any difference
stops the run.

**The one header value masked** is that of a weak `ETag`, which Corten keys per process start,
and only where it is shown to differ between starts: before anything is compared `verify.sh`
starts the base twice and records the `ETag` each start sends for each workload's request
(`verify/etag-two-starts.txt`). For a workload where both starts sent a weak `ETag` and the two
values differ, its value is masked in that workload's comparisons (`mask-etag.sed`); for one
where neither start sent an `ETag`, nothing is masked; anything else stops the run. Nothing in
a body is masked.

## Comparisons and method (run.sh)

Three c-8 hosts, Debian 13, one workload each, by the name each is made under: `s1` takes
`plain`, `s2` `browser`, `s3` `api`. A host is kept only if its CPU is a Xeon Platinum 8280 or
8358 (the two models Choice 72's resolved A/As were read on); one with another CPU is destroyed
and made again under its name before anything is built on it. On each host `aa-<workload>` and
`change-<workload>` are interleaved by placement.

R = 8 recorded pairs per placement after one that is not. Each placement is one run of
`run-pair-fresh.sh` (kit 1971's, unchanged): every turn, the unrecorded pair's included, on a
freshly started build pinned to CPU 2, `wrk -t2 -c64` for 3 s on CPUs 4 and 5, the driver and
`perf` on CPU 7, A and B's order turned every pair, jemalloc 5.3.0 preloaded with
`MALLOC_CONF=background_thread:true,tcache_max:524288`, the starter image's setting. Counted by
`perf stat` over each turn: `cycles:u`, `cycles:k`, `instructions:u` and
`L1-icache-load-misses:u` (the change adds code), every counter numeric and at 100%, no `wrk`
error, or that placement fails. Before a placement's pairs its two builds' answers to the
workload's request are compared as `verify.sh` compares them: the change is meant to alter no
answer, so base and head must answer the same.

## Reading (report.mjs)

Per pair, the change is B / A - 1 in user plus kernel cycles a request.

1. Per placement: the median of its 8 per-pair changes.
2. Across placements: the median of the 60 placement medians and its one-sided 95% upper bound,
   the 37th of the 60 sorted (the smallest rank j with P(Binomial(60, 1/2) >= j) <= 5%). The
   lower bound is the 24th.
3. Resolution: the A/A is read twice from the same pairs, as recorded and with its lists' labels
   swapped (each per-pair change read as A / B - 1). If either bound is at or above +1%, or the
   A/A has fewer than 60 complete placements, the workload is **not resolved**, which does not
   pass whatever the change's bound.
4. The change on a workload **meets +1%** if its bound across placements is under +1% and that
   workload's A/A is resolved, and **misses** if its bound is at or above +1% with the A/A
   resolved. No floor.
5. The reduction on `api` is **established** only if the change's upper bound is at or below
   -1%, the A/A is resolved, and the A/A's lower bound (the 24th of 60) is above -1% in both
   readings. Otherwise no CPU-cost win is claimed.
6. A placement that fails a check, has other than 8 pairs, or names a binary that is not the
   plan's leaves its comparison with no bound, which does not pass. No placement is rerun,
   replaced or dropped for its result, and this plan is not declared again after the run.

Reported as diagnostics, which no reading uses: user cycles, kernel cycles, user instructions and
user L1 instruction-cache misses a request across placements as cycles are; the mean of the
placement medians with a Student t bound; the spread between placements against the spread
within them; each A/A's range of placement medians. This pull request records no spread in
Choice 72.

## A dry run of the scripts

After this plan is in the pull request's description and before the run, `DRYRUN=1` runs the
scripts on each host with the first 5 pads of each list and 2 pairs, to find mistakes in the
kit. It counts cycles, is marked `DRYRUN`, is not a measurement and is read for no margin; its
results are kept beside the run's. A script may be corrected after it; nothing this plan
declares may change.

## Not planned

A request under an API with no header of its own; a `POST`; an `unstaged` route; a page kept for
everyone; a client that accepts gzip or brotli and not zstd; a page past 16 KiB; more than one
runtime; the unpadded build against its padded ones; a second host kind; requests a second.

## Time (estimated from kit 1971's run: 62 to 68 s a placement of 9 pairs)

Each host: 120 placement runs, about 2 hours 10 minutes, after about 10 minutes of verify and
checks.
