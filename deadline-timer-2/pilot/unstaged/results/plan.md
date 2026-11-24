# The deadline's timer: cycles across placements, in two parts, declared before any run (2026-11-24)

The binaries are built from two Corten commits (`commits.env`): base, main
`81e77162a666a8be1360a6f4705b9f54feb7d511`, and head,
`098f56243e4445777e97cde99ff738099c13cc33`, this branch's head when the pilot starts, which has
that commit of `main` merged in. The pilot builds and turns no head, so that is the head for now:
**the gated run's head is stated in this description before that run's first turn.** Base to head
changes `crates/corten/src/deadline.rs` (new), `app.rs`, `lib.rs`,
`page.rs` and `tests/server.rs`, `docs/design.md`, `docs/guide/cancellation.md` and a changelog
note.

No cycle of either build was counted before this plan was in the pull request's description. What
was counted before it is instructions, by callgrind, and requests a second and latency under
load, on another app (the pull request's description gives them); none of it is read here.

**The plan has two parts, because design Choice 72 asks it.** Since
[#2027 Size a placement run's K from an A/A read on its setup, and record the run that read old at 100 placements](https://github.com/corten-run/corten/pull/2027)
merged, on the day of this plan, a plan declares each workload's K sized from an eligible A/A on
the run's setup, workload and R, and where none has been read "the plan first reads a pilot".
None has been read on this plan's setup (below), so:

1. **Part 1, the pilot,** is declared here in full: an A/A of the base against itself for each
   workload, read only for the spread of its placement medians. It decides nothing about the
   change and turns no binary of the head.
2. **Part 2, the gated run,** is declared here in everything but each workload's K, which the
   pilot sizes by a rule fixed here. The K's, with the pilot's figures behind them, are added to
   the pull request's description before any turn of the gated run.

## What is claimed, and what is not

**No CPU-cost reduction is declared, for any workload, and none will be claimed whatever the
workloads read.** The change's gain is not in the cycles one request costs. It removes two
takings of a lock that every thread of tokio's multi-threaded runtime shares, and what that gives
is requests a second and latency when many cores serve handlers that wait. The probe program this
plan counts runs on one single-threaded runtime on one CPU, where that lock is never waited for,
so a count of its cycles cannot show the gain; it can show what the change costs the requests
that gain nothing, which is what this plan is for.

The rule that covers the gain is CONTRIBUTING, Pull requests, item 2.3: "Waiting and concurrency
(I/O, locks, channels, timers, feeds, streaming, startup): time, because a count does not see
waiting or how well work overlaps. `bench/fullstack/ab.mjs` runs the two builds' images on one CPU
for latency and throughput under load, and `bench/fullstack/cold-start.mjs` times cold start. Take
these on a quiet Linux host: on Docker Desktop one image's throughput moved by up to 25% between
rounds." And, for every number of item 2: "Measure release builds and alternate runs of the two.
Give the tool, the number of runs and their median and range; when one build's runs vary more than
the two builds differ, say so instead of reporting a difference."

The pull request's throughput runs follow the second paragraph (release images, alternated, the
tool, the runs, medians and ranges). They do not use `ab.mjs`, which holds the server to one CPU,
where threads cannot queue for a lock: they were taken with the server on 24 cores of a 48-core
host, and on no other number of cores. The route they measured is the benchmark app's
`GET /sdelay/10`: a staged route (so its deadline is on) whose handler awaits
`tokio::time::sleep` for 10 ms. That handler makes and drops a tokio timer of its own, so the
deadline's two takings of the lock were two of that request's four, and a handler that waits on
something else (a socket, a channel) has only the deadline's two. The pull request therefore
words the gain as what was measured, requests a second and p99 on that host at that core count
for those routes, and not as a lower CPU cost. It claims no gain at another core count (none was
run) and none on tokio's minimum version the crate allows (1.44, whose timer wheel is locked in
shards; the runs were on 1.54.1, which has one lock).

## Workloads

Each is sent to one probe program, config `plain`: the stage header checks' probe (tag
`evidence/stage-header-checks-2002`, `stage-header-checks-2002/kit/probe/`, features `json` and
`compress`) with two routes added, `GET /wait` and `GET /unstaged` (the patch is under the tag
`evidence/deadline-timer`, `deadline-timer/kit/probe-addition/kit.patch`, with the probe's source
as it then reads beside it). Each workload is one the change touches: every request
`corten::serve` answers is polled through the wrapper the change puts around its connection. Each
is held to **+1%, no floor**.

1. `plain`: `GET /private` with no request header of its own, on kept-alive connections. The
   record page for one visitor, about 6 KB. A staged request that does not wait: its deadline
   never starts a timer. Touched: the connection's poll goes through the wrapper (13 instructions
   a poll, counted). **The stage header checks' probe serves it as it is.**
2. `wait`: `GET /wait` with no request header of its own, on kept-alive connections. The same
   page from a handler that sleeps 1 ms first (`tokio::time::sleep`), so every request's deadline
   waits. Touched: from a connection's second request the deadline moves the connection's timer
   instead of making and dropping its own. **Needs the added route.**
3. `close`: `GET /wait` with `Connection: close`, so `wrk` opens a connection for each request.
   A connection whose only request waits: the deadline makes its own timer as before, and the
   connection then makes one that no later request uses. This is the request the change is
   expected to cost most: 453 and 448 instructions more of about 35,060 a request, 1.3%, by
   callgrind on another app on one single-threaded runtime, before this plan. Instructions are
   not cycles, and the margin is read in cycles; a count of instructions over +1% is why this
   workload is here, not a reading of it. **Needs the added route and the added `wrk` script.**
4. `unstaged`: `GET /unstaged` with no request header of its own, on kept-alive connections. A
   route that says `unstaged`, so it has no deadline; a short `str` out. Touched: the wrapper
   only, on the cheapest request there is (15 to 17 instructions more of 11,590 to 12,170, by
   callgrind on another app, before this plan). It stands for every route with no deadline: such
   a route gains nothing from the change and pays the wrapper. **Needs the added route.**

## Whether a recorded spread or an eligible A/A applies

No, to both. Design Choice 72 records three spreads, and a run may use one, for a single-build
reading or to size K, only when it matches in every field the rule lists. Field by field:

1. The probe program and its features. The `plain` and `kept` spreads were recorded on the probe
   of tag `evidence/ee7b0b41`, and `young` on that of tag `evidence/0c0c599c`, each with features
   `json` and `compress`. This plan's probe is the stage header checks' with two more routes: the
   same features, another program. **Does not match.**
2. The workload's request and configuration. This plan's `plain` is the `plain` spread's request
   to the same configuration. `wait`, `close` and `unstaged` are requests no spread was recorded
   for. **Matches for `plain` alone.**
3. The allocator, its settings and other preloaded libraries. The `plain` and `kept` spreads:
   jemalloc 5.3.0 preloaded with `MALLOC_CONF=background_thread:true,tcache_max:65536`, nothing
   else preloaded; `young`: the same and a clock library. This plan: jemalloc 5.3.0 with
   `tcache_max:524288`, as the stage header checks' run, nothing else preloaded. **Does not
   match.**
4. The turn protocol: every turn on a freshly started build, server, load and driver with `perf`
   each pinned apart, `wrk -t2 -c64`, 3 s turns. **Matches.**
5. The CPU model: a Xeon Platinum 8358 (`plain`, `kept`) or 8280 (`young`). This plan keeps a
   host only with one of the two. **Can match.**

Fields 1 and 3 fail for every workload, so every workload is **read across placements**, each
with its own A/A, and no single-build reading or layout floor is used.

For sizing K, the nearest A/As are the stage header checks' run's three (K = 60), on this plan's
probe but for the two routes and with its allocator setting. None is eligible: the program is
another, two of them are of workloads this plan does not run and the third (`plain`) is one of
four, and their placements ran in the lists' order, not in an order drawn from a seed their plan
declared, which the Choice asks of an A/A that sizes. The fourth run's A/A (tag
`evidence/placement-sizing-1999`) is of another probe and workload, with a clock library
preloaded. **So every workload has a pilot.**

## What both parts share: builds, placements, turns

Each side is compiled once on the measuring host from an emptied target directory, with the
side's own `Cargo.lock`, the repository's release profile, rustc 1.100.0 and its LLD, zstd linked
to the system's libzstd, as the stage header checks' `build.sh` does; a placement is the probe's
recorded final link run again with a pad first in `.text`, one function of n bytes that nothing
calls, so every other function moves by the pad and keeps its order. The build's checks stop the
run before anything is measured, as that kit's plan lists them.

The pad lists for K placements are those `pads.mjs K` of the sizing kit prints (tag
`evidence/placement-sizing-1999`, `placement-sizing-1999/kit/pads.mjs`), which meet the rule for
an A/A's two lists at any K to 254 and are, for K to 30, the first two placement runs' lists.
The lists for one K are not the first sizes of the lists for a larger K (they are to K = 30), so
a workload's gated run has the lists of its own K_w, which the kit writes and checks for each
workload (`padlists.mjs`). Placement i of an A/A is **base with pad p_i against base with pad q_i**. Placement i of the
change is **base with pad p_i against head with pad p_i**.

A placement is R = 8 recorded pairs after one that is not, by the stage header checks'
`run-pair-fresh.sh`, unchanged: every turn, the unrecorded pair's included, on a freshly started
build pinned to CPU 2, `wrk -t2 -c64` for 3 s on CPUs 4 and 5, the driver and `perf` on CPU 7, A
and B's order turned every pair, jemalloc 5.3.0 preloaded with
`MALLOC_CONF=background_thread:true,tcache_max:524288`. Counted by `perf stat` over each turn:
`cycles:u`, `cycles:k`, `instructions:u` and `L1-icache-load-misses:u` (the change adds code),
every counter numeric and at 100%, no `wrk` error, or that placement fails. A placement that
fails a check, or is stopped at 300 s, is run again once after its part's other placements, at
most three a comparison (the sizing kit's `PLACEMENT_TIMEOUT` and `RETRY_MAX`); none is run
again, replaced or dropped for its result.

The order of a part's placements is a shuffle of their indices drawn from a seed this plan
declares (this kit's `schedule.mjs`, which shuffles as the sizing kit's does: Fisher-Yates from
the end, `mulberry32` of the seed), written to `schedule.txt` beside the results, so that run order is time and not the pad lists'
own pattern.

Four c-8 hosts, Debian 13, one workload each for both parts: `d1` takes `plain`, `d2` `wait`,
`d3` `close`, `d4` `unstaged`. A host is kept only if its CPU is a Xeon Platinum 8280 or 8358;
one with another CPU is destroyed and made again under its name before anything is built on it.
As made: `d1` and `d4` have a Xeon Platinum 8280, `d2` and `d3` an 8358.
A workload's gated run is on the host its pilot ran on, kept between the parts; if a host is
lost, the pilot is read again on its replacement under this plan before that workload's K is
declared.

`close` is the one workload whose turns open connections under load, 64 at a time, each closed by
the server after its answer. `wrk` counts a connection it cannot open, or one closed before its
answer is whole, as an error, and an error fails the placement. The dry run below is where a host
that cannot keep that up for 3 s is found; if it cannot, `close` is not run as declared, the pull
request says so, and nothing else in this plan changes.

## Part 1: the pilot

For each workload w, on its host: `pilot-w`, an A/A of the base, **K = 100 placements**, the
size the Choice gives a pilot unless its plan says why another serves; R = 8; the pad lists
`pads.mjs 100` (those of the sizing kit's `plan.env`); the order from seed 7301 for `plain`, 7302
for `wait`, 7303 for `close` and 7304 for `unstaged`.

The pilot is read for the spread of its 100 placement medians (each the median of a placement's
8 per-pair changes, B / A - 1 in user plus kernel cycles a request) and for nothing else. Whether
it resolves +1% does not matter. It is **eligible** when the three conditions below hold. This
kit's `pilot.mjs` works them out with the sizing kit's `model.mjs`, unchanged, called as that
kit's `report.mjs` calls it (20,000 permutations, seed 1999, for each of the two tests):

1. All 100 placements were read with all 8 pairs.
2. Neither the lag-1 autocorrelation of the medians in run order nor Spearman's correlation of
   the medians with run order is at p < 0.05, each by permutation.
3. Zero is inside the interval from the 42nd to the 59th of the 100 sorted medians.

From an eligible pilot, `size.mjs` gives the chance that an A/A of K placements fails one of its
two readings under the normal model and under a smoothed resample of the pilot's medians. If
Shapiro-Wilk or Anderson-Darling rejects normality at 5%, only the smoothed resample is kept;
otherwise both are.

**The rule for K, fixed now.** Each workload has its own K: **the smallest K from 30 to 254 at
which every kept model's count of failing draws is at most 10,000 of 200,000**, read with
`sizePilot(readPilot(dir), { K: [K], draws: 200000, seed: 1983 })` as `Math.round(rate * draws)`
for that K itself. The one-decimal rates `size.mjs` prints decide nothing. A K found this way is
a model's estimate; the gated run's own A/A decides what the run resolves. That call also works
out the sizing kit's own "K for at most 5%" lines every time, which takes minutes, so the K's
from 30 up are tried with the two functions the call runs for a K, with its arguments
(`failRateNormal(K, s, 200000, 1983)` and `failRateSmoothed(pilot, K, 200000, 1983)` of
`model.mjs`, s the standard deviation of the medians and the pilot's medians in the order of
their placements' indices), and the K found is then read once with the call itself
(`pilot.mjs --confirm`), whose counts are the ones published.

A pilot that is not eligible sizes nothing, and so does one for which no K to 254 meets the rule.
That workload is then not read across placements under this plan, which does not pass; the way on
is a new pilot under a new plan, not a second reading of this one.

What goes into the pull request's description after the pilot and before any turn of the gated
run: for each workload its K, the three eligibility figures, the two normality tests' p-values,
the standard deviation of its medians and each kept model's count of failing draws at that K.

## Part 2: the gated run

For each workload w, on its host: `aa-w` and `change-w`, K_w placements each, the pad lists
`pads.mjs K_w`. The K_w indices run in an order from seed 7311 for `plain`, 7312 for `wait`, 7313
for `close` and 7314 for `unstaged`; at each index the A/A's placement and the change's are
turned back to back, the A/A's first at the odd places of the order and the change's first at
the even. No pair of the pilot is read here: the gated run counts its own A/A.

Before anything is counted, `verify.sh` starts every placement beside its side's unpadded binary
and compares their answers to the four workloads' requests (`checks-verify.txt`): status, every
header but `Date` and the value of a weak `ETag` where two starts of the base are shown to send
different ones, and the body as received, byte for byte. Any difference stops the run. Before a
placement's pairs its two builds' answers to the workload's request are compared the same way:
the change is meant to alter no answer. Before this plan the probe with the added routes was
built once on main and once on this branch as it then was and asked the three paths: `/private`
200 with 6,124 bytes, `/wait` 200 with the same 6,124 bytes, `/unstaged` 200 with 2 bytes, the
same headers and bytes on both sides. That was a check of the addition, with no load and no
counter.

## Reading the gated run (report.mjs)

Per pair, the change is B / A - 1 in user plus kernel cycles a request.

1. Per placement: the median of its 8 per-pair changes.
2. Across placements: the median of the K_w placement medians and its one-sided 95% upper bound,
   the j-th of the K_w sorted, j the smallest rank with P(Binomial(K_w, 1/2) >= j) <= 5% (the
   37th of 60, the 59th of 100). The lower bound is the (K_w + 1 - j)-th.
3. Resolution: the A/A is read twice from the same pairs, as recorded and with its lists' labels
   swapped. If either bound is at or above +1%, or the A/A has fewer than K_w complete
   placements, the workload is **not resolved**, which does not pass whatever the change's bound.
4. The change on a workload **meets +1%** if its bound across placements is under +1% and that
   workload's A/A is resolved, and **misses** if its bound is at or above +1% with the A/A
   resolved. No floor.
5. No reduction is read: the plan declares none (`WIN_WORKLOAD=none`), so `report.mjs` reports
   each workload's bounds and establishes no win.
6. A placement that still fails a check after its one rerun, has other than 8 pairs, or names a
   binary that is not the plan's leaves its comparison with no bound, which does not pass. This
   plan is not declared again after the run.

Reported as diagnostics, which no reading uses: user cycles, kernel cycles, user instructions and
user L1 instruction-cache misses a request across placements as cycles are; the spread between
placements against the spread within them; each A/A's range of placement medians and its
eligibility figures. This pull request records no spread in Choice 72.

## What result means the change does not merge

1. Any of the four workloads **misses**: its change's bound across placements is at or above +1%
   with its A/A resolved. For `close` that is the cost of the timer a single-request connection
   makes for nothing, and the remedy is known and measured in instructions: make the timer only
   once a second request of the connection has waited. That is a change to the code, so it is a
   new head and a new plan, not a second reading of this run.
2. Any of the four is **not resolved**, has a comparison with no bound, or has no K (its pilot
   not eligible, or no K to 254 meeting the rule): the plan then says nothing for that workload,
   which does not pass.
3. `verify.sh` or a placement's own check finds base and head answering differently: the change
   is meant to alter no answer.

Nothing this plan counts can show that the change does not help: the throughput it claims was
measured before this plan, on another app and host, and is not rerun here.

## The kit

The kit that runs both parts was put together after this plan was first published and before
the pilot, and passed the dry run below. It is two kits joined, with this plan's additions:

1. From the stage header checks' kit (tag `evidence/stage-header-checks-2002`), unchanged:
   `run-pair-fresh.sh` (a placement: the two builds' answers compared, one unrecorded pair, the
   recorded pairs, every turn on a fresh start), the relink and its layout checks,
   `placement.mjs` and `stats.mjs`. Its `build.sh`, `setup.sh` and `verify.sh` are here with a
   workload argument, only the sides a part reads and a time limit on each check.
2. From the sizing kit (tag `evidence/placement-sizing-1999`), unchanged: `pads.mjs`,
   `model.mjs` and `size.mjs`. `run.sh` takes from that kit's the run's id, the plan's sha256,
   each placement's record, the order from a seed, the time limit and the one retry.
3. Written for this plan: the probe's two routes, the four workloads' request files and the
   `wrk` script that closes (first written as a patch against the stage header checks' kit, tag
   `evidence/deadline-timer`, `deadline-timer/kit/probe-addition/`, for the first plan's K = 60),
   `schedule.mjs`, `padlists.mjs`, `pilot.mjs` (eligibility, the models kept, the rule for K),
   `report.mjs` and a self-test.

It goes under an evidence tag with the results. A script corrected after the pilot's first turn
is named there with its correction; nothing this plan declares changes.

## A dry run of the scripts

Taken on each of the four hosts after this plan was first in the pull request's description and
before the pilot, to find mistakes in the kit and to see `close` hold its load without a `wrk`
error. `DRYRUN=1` ran the pilot part's scripts and then the gated part's (with placeholder K's of
37, 60, 91 and 254 and the head named above), each with 3 placements, 2 recorded pairs after one
unrecorded and 1 s turns (this plan first said 5 placements; 3 were run), one placement of each
run made to pass its time limit so that it failed and was run again, and before each run the
kit's self-test, which shows that an answer that differs stops a placement before any turn, that
a turn with a failed request records nothing and fails its placement, and that a placement past
its time limit is stopped and leaves no server. On `d3`, `close` was then run once more at the
plan's own turns: 3 placements of 8 recorded pairs after one unrecorded, 3 s turns.

What it showed. Both parts' runs ended complete on all four hosts, with every build's layout
checks, every binary's answers verified and each report written; `close` at 3 s turns had no
failed request and no placement run again. Two mistakes were found and corrected before the
pilot. The first report refused its results: the plan's numbers had lower-case names, which
`pads.mjs`'s reader skips; they are upper case now. And the kit took a workload's pads as the
first K of one list, which is right only to K = 30; each workload's lists are now written and
checked for its own K.

A dry run counts cycles, the head's among them in the gated part's. It is marked `DRYRUN`, is
not a measurement, sizes nothing and is read for no margin: the figures of its change
comparisons were not looked at, and its results are kept beside the run's.

## Not planned

An `unstaged` route whose handler waits, and a connection for each request whose handler does not
wait: both run the wrapper alone, as `unstaged` and `plain` do, and were counted before this plan
(26 to 48 instructions more of 16,980 to 18,200 a request, 0.15% to 0.28%, more polls of the
connection than `unstaged` has; and 33 and 57 of about 31,150). A route whose deadline
is removed (`deadline(None)`), which is `unstaged`'s case with the other stages. A deadline that
fires. A request pipelined behind another. A handler that waits on something other than tokio's
timer. More than one runtime or thread, which is where the gain is. Tokio at the crate's minimum
version. The unpadded build against its padded ones; a second host kind; requests a second.

## Time (estimated from the stage header checks' run: 62 to 68 s a placement of 9 pairs)

Each host. The pilot: 100 placements, about 1 hour 50 minutes, after about 10 minutes of setup
and checks. The gated run: 2 K_w placements, about 2 hours 10 minutes at K_w = 60, 3 hours 40
minutes at 100 and 9 hours 20 minutes at 254. `wait` and `close` turns are the same 3 s. In the
dry run, `close`'s three placements at the plan's turns took 62 to 63 s each on `d3`.
