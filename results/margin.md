# Margin, declared before the run (2026-11-23 UTC, prepared; not yet run)

corten-run/corten#1846, "Send a kept page in brotli 5, made off the request after its second answer"
(issue #1793), seventh quiet-host cycle run (1846r5): one new workload, `twice`, on the sixth run's
pair (the merge candidate's code against its main).

<!-- commits --> Base `a02c81e86e6eb81cd6ee5e3815886cb2c4e1a71e`, head `593b92b017e3498478464f5339ed911069ee4a34` (from commits.env; 1846r4's trees, copied unchanged; the branch's head `1fce7b3ae` merges main's `04530f7e0`, which changed `docs/design.md` alone, so it builds these sources).

## Why a seventh run

Round 15 found that no run times the request that queues a kept page's brotli 5 (its second
compressed answer to a client that ranks brotli first) or the compression thread's work and first
start: 1846r2 to 1846r4 warm every page before their turns, so their turns give answers again, and
the wait run (1846w) times a held value behind the job, not the request that queued it. This run
adds that request to the turns: every URL is new and asked twice, so half the requests are a
second answer, which on the head queues the job, and the head's compression thread makes the
brotli 5 on the server's CPU during the turn. The thread's first start is not in the turns (below);
the workstation's Callgrind count (in process, not part of this run) measures it.

## The commits

1846r4's: base origin/main `a02c81e86` ("Merge pull request #1976"), head `593b92b01` (the PR's merge
of that main, `70243d056`, then Choice 70). Commits after it on the branch that change none of the
exported paths (`crates`, `examples`, `Cargo.toml`, `Cargo.lock`, `.cargo`) build the same binary,
and the report names any such later head with that check.

## The plan: 1846r4's passes 1 and 2, on the workload `twice` alone

1. The probe program (`probe-{base,head}/src/main.rs`, byte-identical between the two; only the
   package name and the path to `corten` differ) is 1846r4's with the `twice` config, the
   in-process `cg` mode (not run here) and `main` building its current-thread runtime itself as
   `#[tokio::main]` did; the template's features and `json`, the tree's Cargo.lock, the repository's
   release profile, rustc 1.100.0, the system's libzstd, jemalloc preloaded (`PROBE_ALLOCATOR=jemalloc`
   checks it).
2. `twice`: `kept_answers(8 GiB)`, so every URL is kept with room, as 1866's `new` was; before the
   port opens, `/page` (the 6,124-byte `Public` record page) is warmed as 1846r4's `browser` warms it
   (four asks with `Accept-Encoding: gzip, deflate, br, zstd`, 300 ms, one more ask for the WARM
   line), so on the head the compression thread has started and made `/page`'s brotli 5 before
   the turn: `perf stat -p` counts the threads the process has when it attaches, and the thread
   then exists on the head. The load (`lua/twice-browser.lua`, browser codings) asks
   `/page?s=<time>&t=<thread>&n=<URL>` for URLs never asked before, each twice: on each wrk thread
   256 new URLs, then the same 256 again in order. The first answer makes and keeps the page in
   zstd 1 on both builds; the second is given the kept zstd 1 on both, and on the head queues the
   brotli 5 job (or, with the queue full, leaves it to an answer that never comes). The answers
   checked and the WARM rule are `browser`'s (`checks-browser.txt`, `mask-browser.sed`,
   `expect-browser.diff`, `br-smaller`): on `/page` the head answers `br` where the base answers
   `zstd`, with a smaller body.
3. Every turn, its warm-up pair included, on a freshly started build (`run-pair-fresh.sh`), server
   on CPU 2 (its compression thread with it), `wrk -t2 -c64` for 3 s on CPUs 4 and 5, the driver
   and perf on CPU 7, the order of the two builds turned every pair, `perf stat` `cycles:u`,
   `cycles:k` and `instructions:u` of the server process (every thread) over the turn, divided by
   the requests wrk saw answered.
4. **100 recorded pairs** after one unrecorded warm-up pair; the one-sided 95% upper bound on the
   median per-pair change is the 59th smallest of the 100.
5. Every start of both builds must log one WARM line, `/page` kept, in one coding and size
   (`starts-twice.txt`), and `check-warm.sh`'s `br-smaller`; a workload is rejected if either build's
   server log over every start and turn has `panicked at`, `PANICKED` or `FENCE FAILED`.
6. Every turn's wrk output has, for each of its two threads, `AGED <thread> <first requests made>
   <second requests made> <answers with an Age> <answers without>`; `gate.mjs` requires both lines,
   their answers summing to RESULT's requests, and for each thread: no more answers than requests
   made and at most 64 plus 1% of them unanswered (32 connections a thread, one request each in
   flight when the turn ends; a workstation trial turn had 33 on one thread, a request wrk made and
   made again); no more answers with an Age than second requests; at most 64 plus 1% of its second
   requests not answered with an Age; and some answered with one. So the turns are of URLs asked
   twice whose second answer was, all but a bounded few, the kept one, the answer that queues the
   job on the head. `gate-twice.txt` reports, for each build, how many of the recorded turns'
   second requests were answered kept.
7. Pass 2, a diagnostic: `twice-icache`, one warm-up pair and **30 recorded pairs** of 1 s turns on
   fresh starts, counting `L1-icache-load-misses:u` and `instructions:u` only. Reported per request:
   each build's median, the median per-pair change, its 20th-of-30 bound and the range. **No margin.**

## The margin (pass 1)

The one-sided 95% upper bound on the median per-pair change in user plus kernel cycles per request
is **under +1%**. Met, it shows that for this pair a page asked for exactly twice costs no more than
that, the second answer's queueing and the thread's brotli 5 included; it shows neither a lower cost
nor what caused a difference. Not met, it shows this pair's cost on such a page past +1%; the run
reports the bound, the median and the split, and does not itself decide the merge, which is the
review's against Choice 70's bet that most kept answers are read more than twice. A pass that
fails or cannot be used (below) is reported as such and shows neither.

Expected, from the workstation's count (Callgrind, in process, jemalloc preloaded, 1,000 URLs, the
median of three rounds; not a result): the head's second answer takes 184 more user instructions than
the base's (25,135.8 against 24,951.5) and its first 52 more (264,195.9 against 264,143.9), and its
compression thread spends 1.50 million on each page's brotli 5 (1,497,880), about five times a URL's
two answers. Unless the thread's share of CPU 2 is small, this workload's head is expected to use
far more cycles a request than the base, well past +1%; the run measures how much.

**No layout floor.** No workload is named a negative control, and Choice 71's recorded floor applies
only to `plain` with its recorded setup.

## When the pass and the run can be used (fail closed)

`gate.mjs` decides from the files alone, after both passes (`gate-twice.txt`, `gate-twice-icache.txt`,
`gate.txt`; its own checks on made-up turns are `check-gate.mjs`, which `pack.ps1` runs before
packing). A pass is usable only if: its raw log holds exactly the warm-up pair and pairs 1 to N in
the declared order (base first in the warm-up and odd pairs, head first in even ones), N being 100 in
pass 1 and 30 in pass 2; every turn's perf output has each declared event once, a whole number above
zero (1846r4's validator accepted a zero, so a turn's aggregate cycles could be 0 and its pair's
change -100%), counted **exactly 100%** of the turn (`100`, `100.0` or `100.00`); every turn's wrk
`RESULT` line has requests above zero and no connect, read, write, status or timeout error; every
turn's AGED lines are as item 6 says; the CSV holds exactly those N pairs' rows, each equal to its
turn's raw values and none with a counter at 0; every start of both builds warmed as above; the
answers were checked; and every paired change is a finite number, checked before the changes are
sorted. Only then is a bound computed. The preflight, the per-turn check in `run-pair-fresh.sh` and
the check-only turn in `run-pair.sh` hold the share to the same exactly-100% rule.

`run.sh` refuses `PAIRS`, `TURN`, `WARMUP`, `MISS_PAIRS`, `MISS_TURN`, `EVENTS`, `NOPERF`,
`WAIT_ROUNDS` and `WAIT_REPS` in its environment (so does `start.sh`), refuses a results directory
holding anything but this file, stops before any recorded pair if the preflight or the check fails,
and exits 1 unless every step ran, both passes are usable and pass 1's gate is met. If the host's
perf cannot count the pass 2 events at exactly 100%, pass 2 is not run and the run exits 1 as
incomplete; pass 1's verdict is still reported, with the missing diagnostic stated as an exception.
`run.out` ends with `run.sh exit <n>` and `ALL-DONE`. The only dry run is `DRYRUN=1`: the check with
no pair recorded and no result.

## Not measured by this run

The compression thread's first start: it starts in the warm-up, before the port opens, so that perf
counts it; no turn contains it. The workstation's Callgrind count gives its instructions on the
request that starts it and on the new thread (user space only: neither the thread's creation in the
kernel nor any wait). A cold start's time is not measured. The held value's wait behind the job
stays the wait run's (1846w), for its pins. 1846r4's four workloads are not run again.

No pooling with the earlier runs, no plan declared again after the run, no run repeated or dropped
for its result. A failed pass is reported as failed with whatever it recorded.

## Time

Estimated from 1846r4's run on a c-8 (receipt `evidence/aed6638f`; its builds and its passes about
12.5 and 1.75 minutes a workload):

1. Setup (packages, rustup and rustc 1.100.0, the crates) about 3 to 6 minutes, and the two probe
   builds about 2 to 8.
2. The check: under a minute.
3. Pass 1: 101 pairs of 3 s turns on fresh starts, about 12.5 to 15 minutes.
4. Pass 2: 31 pairs of 1 s turns, about 2 to 3 minutes.
5. The gate: under a minute.

About 22 to 35 minutes in all, under 45.
