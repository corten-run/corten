# Margin for kit 1938c, #1938's integrated pair after round 3 of review, declared before the run (2026-11-22, prepared; not yet run)

<!-- commits --> Base `fef1f83de307e618dbd996c567eb616e9c2da650`, head `b2d15d5fbddf89e7c546fa8a81f4f3284de510ca` (from commits.env; merge-base of the head with origin/main: `fef1f83de307e618dbd996c567eb616e9c2da650`; origin/main at export: `a02c81e86e6eb81cd6ee5e3815886cb2c4e1a71e`).

corten-run/corten#1938, "Let a handler or a task drop the pages the app keeps for a change it made"
(issue #1795). Kits 1938 and 1938b measured base `83b3b8772` against head `84de7c1e5` on a Xeon
Platinum 8280 (receipt tag `evidence/65749d73`); three workloads missed +1% there (`named`,
`named-off`, `write-off`). Round 3 of review found that pair is not the code that would ship: main
has since changed executed paths (text response headers, compression's response path, a kept
answer's `Age` and cache metadata), and the branch has merged it. The head also no longer makes the
pending `KeptAnswers` cell in `App::new`: an app makes it only when `App::kept` is called, so an
app that never calls it allocates nothing for it at startup and runs none of its code on a request.

This kit measures the integrated pair: base is main as the head merged it (the merge commit's first
parent from main), head is the PR's head with that merge, both exported from git. It runs the
eight workloads kits 1938 and 1938b ran between them, with their protocol, CPUs, ports and
statistic, and nothing else.

## What this supersedes and what it does not

- The results of kits 1938 and 1938b stay attributed to their pair (`83b3b8772` against
  `84de7c1e5`) and are not pooled with, replaced by, or reread through this run. This kit's results
  are attributed to its pair alone.
- For the PR's gate, this kit's results are the ones for the code that would ship. A miss here is
  not excused by a pass there, nor a miss there by a pass here.

## Workloads

The probe is kit 1938b's (probe-*/src/main.rs, the same file built against base and head; only its
first comment line changed): `/home` a `Public` page, `/items/7/edit` a write whose handler on
head takes `KeptAnswers` and calls `changed(&url::Home)` (base, which has no `KeptAnswers`, the same
handler taking nothing), `/items/8/edit` a write that names nothing, and a `GET` on both. Apps:
`page` (default bound), `page-off` (`kept_answers(0)`), `page-roomy` (`kept_answers(1 << 30)`).
Served by `corten::serve` (HOST=127.0.0.1, ports 18381 and 18382) on a current-thread runtime with
the template's features (defaults and `compress`), the repository's release profile (opt-level 3,
thin LTO, one codegen unit), rustc 1.100.0, both built on the host from the exported trees with each
tree's Cargo.lock. Every turn starts the build fresh; in an app with a store, `/home` is asked for
three times first (the third must carry `Age`).

1. **named** (opts in): `POST /items/7/edit`, same-origin, app `page`.
2. **named-off** (opts in): the same in app `page-off`: head's handler takes the handle and finds
   no store.
3. **write**: `POST /items/8/edit`, app `page`, a write that names nothing.
4. **write-off**: the same in app `page-off`.
5. **write-off-glibc**: the same as write-off with glibc's allocator (nothing preloaded).
6. **kept**: `GET /home`, app `page`, the kept page given again.
7. **plain**: `GET /items/8/edit`, app `page`, a route that keeps nothing.
8. **new**: `GET /home?t=<thread>&n=<k>`, a new URL with every request (lua/get-new.lua), app
   `page-roomy`: each request misses, runs the page's handler and keeps the page.

Every workload but write-off-glibc runs with jemalloc preloaded (`LD_PRELOAD=libjemalloc.so.2`,
`MALLOC_CONF=background_thread:true,tcache_max:65536`), as the template's image does. Every server
reports the allocator it found and refuses to start if it is not the declared one.

wrk -t2 -c64 on CPUs 4-5 for **3 s** a turn (lua/get.lua, lua/post-same-origin.lua,
lua/get-new.lua), fixed now.

## Method

Kits 1938 and 1938b's, unchanged: `run-pair.sh`, run by `run.sh` under `taskset -c 7`: every turn on
a freshly started build, pinned to CPU 2, warmed, loaded, and stopped. The order turns every pair
(base first in odd pairs). perf stat counts the server process alone for exactly as long as wrk
runs: `cycles:u`, `cycles:k`, `instructions:u`, task-clock, and `L1-icache-load-misses` as a
diagnostic only when a preflight counts it beside the other three at 100% (host.txt says which).
Cycles per request = (cycles:u + cycles:k) / requests wrk completed in the turn.

Before the first turn each build answers the workload's request on fresh starts (base twice): the
status line, the headers but Date (Age's value masked), the body's length and sha256, for `new`
whether the same URL asked for again is given from the store, then whether `/home` is kept. The two
base answers must be the same, and head's the same as base's, except in **named**, where by design
base's write leaves `/home` kept and head's drops it (the transcript's last line, and nothing else,
differs). Base must say `home after: kept` for named, write, kept, plain and new, and `none kept`
for the store-off workloads; kept's answer must carry `Age`; new's first answer must not, and must
say `again: kept`. Then `run.sh` runs every workload once with no recorded pair (check-only/, one
unrecorded pair each) and stops if any fails. `new` proves its insertions in every turn, warm-up
included, after perf has stopped: for each wrk thread, `n=2` and `n=<last - 100>` must be given from
the store, or the workload stops.

The readiness loop counts its probes with its own variable (`tries`), and the warm-up loop with
`wu`, so the warm-up runs exactly one pair (kit 1938's first driver shared `i` between them).

One unrecorded warm-up pair, then **100 recorded pairs** a workload, fixed now. The one-sided 95%
upper bound on the median per-pair change is the 59th smallest of the 100 changes (`summary.mjs`,
distribution-free; it refuses a CSV that has other than exactly 100 pairs and 200 rows, and a rank
other than 59).

Host: a quiet dedicated-CPU droplet (c-8, debian-13-x64, root), set up by `setup.sh` and built by
`build.sh` there, started by `/root/start.sh`; nothing else run or logged into while it runs. Its
CPU model is not known in advance; host.txt records it.

## Margin

No win is claimed or sought.

Every workload passes when the one-sided 95% upper bound on the median per-pair change in
user+kernel cycles per request (the 59th of the 100 sorted changes) is under **+1%**, compared
unrounded.

**No floor is applied to any workload.** Choice 71's layout floor (+1.62%) applies only to its
calibration workload, `plain` as `GET /private` on the #1829 probe app, on a Xeon Platinum 8358
with the exact setup Choice 71 lists. This kit's `plain` is a different request on a different
probe, its host's CPU is not known in advance, and none of the eight is named a negative control
here. So the floor applies to nothing in this run, whatever the host turns out to be, and no
declaration is added or changed after the run.

**named** and **named-off** are the feature's own cost: a handler that takes `KeptAnswers` runs the
extractor and, with a store, hashes and counts the path. If either misses +1% it is reported as the
measured cost of opting in (median, bound, user and kernel split, instructions:u), with no claim that
it is under +1% and no claim that it is a regression beyond what is measured. Whether that cost is
accepted for the freshness it buys is the reviewers' decision, not this run's.

The other six do not opt in. A miss on any of them is reported as a miss, as measured, with no
performance claim either way and no floor, however flat its instructions; it is not reclassified as
a pass after the run.

**Otherwise not met**: reported as measured (median, bound, best and range, user and kernel split,
instructions:u, the icache diagnostic if counted, requests/s, server busy, failures). No rerun or
pooling is declared here.

## Failures, decided now

Fail closed. PAIRS, WARMUP, TURN, WORKLOADS, SERVER_CPU, LOAD_CPUS, OUT, CHECK_ONLY or EXPECT_PAIRS
set in the environment, or a PERF other than 0 or 1, stop `run.sh` (and PAIRS, WARMUP, TURN,
SERVER_CPU and LOAD_CPUS `run-pair.sh`) before anything is done (only a dry run with `PERF=0` may
set them, and it is never a result). A failed answer check stops the run before anything is recorded. A workload whose `run-pair.sh` fails
(a failed request, a counter under 100% or unusable, an answer other than declared, a `new` page not
kept, a CSV without exactly 200 recorded rows) or whose summary fails (other than exactly 100 pairs,
any unusable counter, any turn with a failed request) is printed as `FAILED <workload>: ...` and is
not a result; the other workloads still run, as diagnostic data only. The run then ends `INCOMPLETE`
(results/status.txt), exits nonzero, and run.out ends `EXIT <status>` and `ALL-DONE`. Only `COMPLETE` with `EXIT 0`, after
all eight summaries, each of 100 pairs with every counter at 100% in every turn and zero failed
requests, is a complete receipt.

## Time

Local dry run (2026-11-23 UTC, of this kit's final scripts with head `b2d15d5fb`, a `debian:trixie`
container on the workstation through `/root/start.sh` from this kit's tar, rustc 1.100.0, the
kit's own builds, no perf, `PERF=0 PAIRS=2 TURN=2`; not a measurement): 7 min 21 s from start to
`ALL-DONE`, the two builds at once in 170 s; every answer check passed as declared (the writes
`200`, 5 bytes; `named` the same as base but head's `home after: not kept`; the store-off writes
`home after: none kept`; `kept` and `new` `200`, 371 bytes, `new` `again: kept`; `plain` `200`,
4 bytes); every server reported the declared allocator (`write-off-glibc` glibc, the rest
jemalloc); no request failed in any turn; every `new` turn kept its `n=2` and late URLs for both
threads (about 16,000 new URLs a thread in a 2 s turn); each workload took 13 to 14 s for one
warm-up and two pairs, with exactly 4 recorded rows; each summary refused the counter-less CSV, so
the run printed eight `FAILED` lines, `INCOMPLETE`, `EXIT 1` and `ALL-DONE`, as declared above.
From the same tar without `PERF=0`: `run.sh` stopped (exit 1) on each of PAIRS, WORKLOADS, TURN,
WARMUP, SERVER_CPU, LOAD_CPUS, OUT, CHECK_ONLY, EXPECT_PAIRS and `PERF=2`, writing `INCOMPLETE`;
`run-pair.sh` stopped (exit 2) on TURN, WARMUP, PAIRS, SERVER_CPU, LOAD_CPUS and `PERF=yes`; and
`start.sh` refused to start where `/m/1938c/run.out` existed. On the workstation `summary.mjs`
refused a 2-pair CSV, a 100-pair CSV without `EXPECT_PAIRS=100` and a 100-pair CSV with one failed
request, and summarised a synthetic 100-pair one (rank 59). Only this Time section changed after
the dry run.

Estimated for a c-8 with 3 s turns, from kits 1938 and 1938b's own run on their c-8 (Xeon Platinum
8280), which took 10 min 21 s to 10 min 25 s a workload for one warm-up and 100 pairs (10 min 53 s
for `new`): about 84 minutes for the eight, plus the checks (about 1 minute) and setup with both
builds (about 4 to 6 minutes): about 90 minutes in all. `run-pair.sh` prints its own estimate after
each workload's warm-up pair (run-<w>.log).
