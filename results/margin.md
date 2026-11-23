# Margin, declared before the run (2026-11-22, prepared; not yet run)

corten-run/corten#1846, "Send a kept page in brotli 5, made off the request after its second answer"
(issue #1793), fourth quiet-host run (1846r2): the merge candidate against the main it merged.

<!-- commits --> Base `7a275ef1534efb3a1e1130a4bac5de2322ad380f`, head `ef8587ca0b361b54f1dae5fb0ab265eede15b02d` (from commits.env; merge-base of the head with origin/main: `7a275ef1534efb3a1e1130a4bac5de2322ad380f`; origin/main at export: `83b3b8772b7dbfd93ed55425022d4e101e16e644`).

## Why a fourth run

The third run's kit (1846r) pins `9d60f9647` (the branch merged with main's `153be9116`) against
`153be9116`. Main then merged #1922 ("Keep a Public whole body of 1,024 bytes or more, whatever
its type and build", `7a275ef15`), which changes which bodies the store keeps, and the branch
merged it with three conflicts. Whatever 1846r shows is a result for its own pins only; it is not
pooled with this run and is not evidence for this candidate. This run is the merge candidate's gate.

## What is the same as the third run (1846r)

Passes 1 and 2 are 1846r's, unchanged but for what the next section lists:

1. The probe program (`probe-{base,head}/src/main.rs`, one program; only the package, the bin name
   and the path to `corten` differ), the template's features and `json`, the tree's Cargo.lock, the
   repository's release profile (opt-level 3, thin LTO, one codegen unit), rustc 1.100.0, zstd
   linked to the system's libzstd, jemalloc preloaded (`PROBE_ALLOCATOR=jemalloc` checks it).
2. The four workloads, with the same checks, masks and expected differences (`checks-*.txt`,
   `mask*.sed`, `expect-*.diff`): `browser` (`/page`, a 6,124-byte `Public` record page, with
   `Accept-Encoding: gzip, deflate, br, zstd`), `gzip` (gzip only), `refused` (browser codings at
   a bound calibrated on the built head by `calibrate-refused.sh`, seven other pages kept first,
   leaving the page and its zstd 1 room and too little for its brotli 5) and `json-browser`
   (`/records`, the 1,999-byte JSON body, `Accept: application/json` and browser codings). On
   `browser` and `json-browser` the head answers `br` where the base answers `zstd`, with a smaller
   body; `gzip` and `refused` answer the same, gzip and zstd 1. None of the four is a picture, so
   #1922's change to which bodies are kept does not change what these workloads keep.
3. Every turn, its warm-up pair included, on a freshly started build (`run-pair-fresh.sh`), server
   on CPU 2, `wrk -t2 -c64` for 3 s on CPUs 4 and 5, the driver and perf on CPU 7, the order of the
   two builds turned every pair, `perf stat` `cycles:u`, `cycles:k` and `instructions:u` of the
   server process over the turn, divided by the requests wrk saw answered. A wrk error, a counter
   that is not numeric or not counted 100% of the turn stops that workload. Before the first turn
   the two builds' answers are compared and must differ only as `expect-*.diff` says.
4. **100 recorded pairs** a workload after one unrecorded warm-up pair; the one-sided 95% upper
   bound on the median per-pair change is the 59th smallest of the 100 (`summary.mjs`).
5. `refused`'s completion fence (`/mark`, kept by a second app in the process, queued behind
   `/page`'s job on the one compression thread; the head's port opens only once `/mark` answers
   `br`), then `/page` asked once more and required to be a kept zstd 1 of one size on every start.
6. Pass 2: each workload again as `<w>-icache`, one warm-up pair and **30 recorded pairs** of 1 s
   turns on fresh starts, counting `L1-icache-load-misses:u` and `instructions:u` only. perf may
   print the cache event as `L1-icache-load-misses` (without `:u`); the preflight and
   `run-pair-fresh.sh` accept both names. If the preflight cannot count both at 100% on CPU 2,
   `icache-unavailable.txt` says so and the pass is skipped: that is reported as the diagnostic
   not collected, an exception to state, never as a pass. Reported per request: each build's
   median, the median per-pair change, its 20th-of-30 bound and the range. **No margin.**

## What changed

1. **The commits.** Base: origin/main `7a275ef15`. Head: the PR's branch after merging it
   (`c6cd89e64`) and the round 11 commits after that merge, which change tests and documentation
   only (a test-only hook in `kept.rs` is `#[cfg(test)]`), so the head binary's source is the
   merge's. Since the kit was made, origin/main moved to `83b3b8772`, whose commits after `7a275ef15`
   change `bench/` and `changelog.d/` only (none of what the kit exports: `crates`, `examples`, the
   Cargo files and `.cargo`), so the base stays `7a275ef15`, still the head's merge-base.
2. **A panic fails the start.** Round 11 found the `refused` fence proves queue order, not that
   `/page`'s job returned normally: the compression thread catches a job's panic, which would also
   leave `/page` given its kept zstd 1. The probe now installs a panic hook first thing that counts
   every panic in the process, caught ones included (the hook runs before unwinding). The fence
   fails (`FENCE FAILED ... panics`) if any panic was counted when it closes, and in every config a
   start whose count is not zero when its warm-up ends prints `PANICKED` and exits before its WARM
   line. `run.sh` also rejects a workload if either build's server log, over every start and
   timed turn, has `panicked at`, `PANICKED` or `FENCE FAILED`. So for `refused` a closed fence,
   no panic, and a kept zstd 1 of one size show the job ran to its end and the bound refused its bytes.
3. **Pass 3, the held value's wait** (below), for round 11's second P2.
4. The kit lives under `/m/1846r2`, `/m/target-1846r2` and `/m/target-1846r2-wait`, with the same
   CPUs and ports as 1846r and 1923 (2, 4, 5, 7; 18081-18082): one kit at a time on a host.

## The margin (passes 1 and 2, unchanged)

For **every** workload: the one-sided 95% upper bound on the median per-pair change in user plus
kernel cycles per request is **under +1%**. A bound at or over +1% on any of the four blocks the
merge; a workload that fails or cannot be used (a failed turn, a check, fence or panic check that
does not pass, a counter not at 100%) does not clear it. A bound under +1% clears the gate and shows
neither a lower cost nor what caused any difference. No workload is named a negative control: the
layout floor of the pending Choice 71 (`codex/i1923`, not merged) is not applied, and every workload
is held to +1%. Reported for each: the pairs, each build's median, the median change, the bound, the
range, the user/kernel split and `instructions:u`; and pass 2's per-request
`L1-icache-load-misses:u` as a diagnostic.

## Pass 3: a held value's wait behind a kept page's brotli 5 job

CONTRIBUTING.md (Pull requests, 2.3) has waiting and locks timed on a quiet Linux host; round 10's
probe timed this on a workstation. Pass 3 runs the same probe on this host (`wait/`, round 10's
`probe_r10.rs` with its defaults set to the values below and its test renamed; a child module of
`kept.rs` in a copy of each tree, so it keeps pages in a real store and runs the job `Kept::coded`
queues, `Entry::make_brotli`: encoding, the store's write lock, the second check, the room, the bytes
put in). The job is held at a fence once started, a held JSON value is read twice (the second read
queues its forms), the job is let go, and the time from the second read until the held value's
forms exist is recorded (`held_us`): the held value waits for all of the job, the worst case for one
job. Main has no kept job; its runs do the same setup and queue nothing.

1. Builds: each tree's corten unit tests with the probe, the release profile, `--locked`, features
   `json` and `compress`, rustc 1.100.0, libzstd from the system (`bin/wait-{base,head}`, receipts
   in `sha256.txt`); run with jemalloc preloaded as the app's probe is, on CPUs 2, 4, 5 and 7.
2. Kept body 32,768 bytes (the bound, `BROTLI_MAX`); held JSON of 4,021 and 78,967 bytes (`json(4096)`
   and `json(79000)`); setups `idle` (no job in either build), `room`, `refused` (no room for the
   brotli) and `contended` (a full default store of about 30,000 pages, each read since the clock
   last passed, into which another thread keeps a 4 MiB page at 80% of the encode's median, so the
   job's lock can wait for that insertion's eviction).
3. **20 rounds**, each one process of each build of **21 repetitions**, the order alternated (base
   first in odd rounds): 420 pairs a setup and size, a pair being the same setup, size, round and
   repetition in the two builds. The one-sided 95% upper bound on the median per-pair difference
   (head - base, ms) is the order statistic `stats.mjs`'s `upperRank` gives for n = 420.
4. Usable only if: every process exits 0 with no panic and gives the same number of samples as its
   pair; every head `room` job's outcome is `admitted` and every head `refused` job's is `refused`;
   and the `idle` control (4,021 bytes), where neither build has a job, has a bound **under +0.5 ms**.
   A pass that cannot be used blocks the merge.
5. **Bounds (4,021-byte held value, 32,768-byte kept body).** H is the base's median, over the pass,
   of that held value's own forms (`heldown`: brotli 9 and gzip 9 on the probe's thread); I is the
   base's median `store.keep` call for the 4 MiB insertion in `contended` (from before it asks for
   the lock until it returns).
   1. `room`: bound **under H**.
   2. `refused`: bound **under H**.
   3. `contended`: bound **under H + I**.
   Why: Choice 70 chose 32 KiB as the size whose encoding stays under a small held value's own forms,
   so a held value queued behind one kept job should wait less than its own compression costs; with
   another writer in the store, the design accepts waiting for that writer too, so the job may add
   one insertion's call. A bound at or over its limit blocks the merge. Round 10's workstation
   medians, for scale only: H 5.3 ms, I 5.8 to 6.3 ms, added waits about 2 to 4.5 ms (room,
   refused) and 8 ms (contended).
6. Reported with no bound: the 78,967-byte value in every setup, the head's whole-job times and
   outcomes, brotli 5 of the kept body alone (`enc`), and both held sizes' own forms.
7. Not measured by it: a job that waits for more than one writer, a held value queued after the job
   began encoding (it waits for less), and the request path (pass 1 covers that).

No pooling with the earlier runs, no plan declared again after the run, no run repeated or dropped
for its result. A failed workload or pass is reported as failed with whatever it recorded.

## Time

Estimated from 1846r's estimate and round 10's workstation probe:

1. Setup (packages, rustup) about 3 minutes; the two probe builds about 6 to 8; the two wait builds
   (the corten unit tests, release profile) about 6 to 10 more.
2. Calibration (up to 375 starts of the head, each warmed and fenced) and the four checks: about 3.
3. Pass 1: 4 x 101 pairs at about 7.5 s: about 51 minutes.
4. Pass 2: 4 x 31 pairs of 1 s turns at about 3.5 s: about 7 minutes.
5. Pass 3: 40 processes of about 8 s (round 10 took about 10 s a process at two kept sizes; one
   here): about 6 minutes.

About 85 to 95 minutes in all, under 110.
