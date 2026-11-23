# Margin, declared before the run (2026-11-22, prepared; not yet run)

corten-run/corten#1846, "Send a kept page in brotli 5, made off the request after its second answer"
(issue #1793): 1846w, the held value's wait behind a kept page's brotli 5 job, alone, on a quiet
host. It replaces the third pass of the fourth run (1846r2) for round 12's review.

<!-- commits --> Base `7a275ef1534efb3a1e1130a4bac5de2322ad380f`, head `76a9dc1e4007591b5ad1793f04d7e4e6134afe30` (from commits.env; merge-base of the head with origin/main: `7a275ef1534efb3a1e1130a4bac5de2322ad380f`; origin/main at export: `7e9a0c715bf055374be5e160267e45f419be4b07`).

## What this kit is for, and what it supersedes

Round 12 found three faults in 1846r2's pass 3: its `contended` samples did not show that the
kept job ever waited for the writer's lock (the writer was started at 80% of a separately timed
encode, and nothing timed the job's request for the lock); its one-sided 95% bound took rank 228
of 420 repetitions as if each were independent, though a round's 21 share one process of each
build; and its validator accepted an incomplete or inadmissible matrix. This kit fixes the three
and is declared before any run of it, and before 1846r2's pass 3 is read.

1. **1846r2's pass 3 is superseded by this kit and will not be read as the gate.** Whatever it
   records stays under its own name as a setup with those faults; it is not pooled with this
   kit, and this kit's result does not depend on it.
2. **1846r2's passes 1 and 2 remain the cycle gate** for this change, as 1846r2's margin.md
   declares them (pass 1: the one-sided 95% bound under +1% on all four workloads; pass 2 a
   diagnostic). Pass 1 times the warmed request path only: the second qualifying answer's queueing
   of the job and the worker's first start are not in its turns.
3. This kit's pass is a separate gate: a bound at or over its limit, or a pass that cannot be used,
   blocks the merge, as 1846r2's pass 3 was declared to.

## The commits

Base: origin/main `7a275ef15`, the main the PR merged, as in 1846r2. Head: the PR's branch with
a test-only hook added for this probe, `LOCKING` in `kept.rs`, run by `Entry::make_brotli` once
the bytes are made and just before it asks for the store's write lock, and a test that uses it.
The hook and the test are `#[cfg(test)]`, so the code a release build of the app compiles is
`ef8587ca0`'s, which 1846r2's passes 1 and 2 build; the pass here builds each tree's unit tests,
where the hook exists. The head's other commits after `ef8587ca0` change `docs/design.md` and the
test's layout only.
Since then origin/main has moved past `7a275ef15` with two commits that change `kept.rs` and
`cache.rs` (`a0267d8a6`, "Give a kept answer again with three fewer allocations", and `f7dd7d23c`).
This kit, like 1846r2, measures the branch as merged with `7a275ef15`; a merge of a later main into
the branch is a new candidate this run does not measure.

## The probe

`wait/probe_wait.rs` is 1846r2's (round 10's workstation probe with the declared defaults), a
child module of `kept.rs` in a copy of each tree, so it keeps pages in a real store and runs the
job `Kept::coded` queues, `Entry::make_brotli`: the encoding, the store's write lock, the second
check, the room, the bytes put in. The job is held at a fence once started, a held JSON value is
read twice (the second read queues its forms), the job is let go, and the time from the second
read until the held value's forms exist is recorded (`held_us`): the held value waits for all of
the job. Main has no kept job; its runs do the same setup and queue nothing. Changed for round 12:

1. Every row carries its repetition, so a missing or repeated sample is seen.
2. The head's job records its request for the lock: in `LOCKING` it notes the time (`att_us`)
   and whether `try_write` on the store's lock failed because the lock was held (`att_held`), then
   sets a flag. `lockwait_us` is from that request to the `ADMITTING` hook (lock taken and the
   second check made).
3. In `contended` the writer (another thread keeping a 4 MiB page into a full default store of
   about 30,000 pages, each read since the clock last passed) takes the store's lock before the
   held value is read, in both builds: the probe waits until the writer is inside `Store::keep`'s
   lock (`w_in_us`, from the `make` closure `keep` runs under it). In the head the writer then
   stays inside until the job's flag is set (`w_seen_us`), and only then builds its entry and
   runs the clock's eviction, so the job asks for the lock while the writer holds it and waits for
   that insertion's whole eviction. The writer's wait before the request costs the job nothing: the
   job is encoding then and takes no lock. In the base no job comes and the writer does not wait.
   `ins_us` is the insertion's whole `Store::keep` call; `evicted` the pages it dropped.

So a `contended` head sample shows its contention: `att_held` 1 (the lock was held when the job
asked), `w_in_us` before `att_us` (the writer was inside first), `w_seen_us` at or after
`att_us` (still inside, the eviction not yet begun), `evicted` at least 1, and the job came to the
admission after the request. Samples are not selected: every one must show this (below).

## The pass

1. Builds (`build.sh`): each tree's corten unit tests with the probe, the release profile,
   `--locked`, features `json` and `compress`, rustc 1.100.0, libzstd from the system
   (`bin/wait-{base,head}`, receipts in `sha256.txt`); run with jemalloc preloaded on CPUs 2, 4, 5
   and 7, nothing else running.
2. Kept body 32,768 bytes (`BROTLI_MAX`); held JSON of 4,021 and 78,967 bytes (`json(4096)` and
   `json(79000)`); setups `idle` (no job in either build), `room`, `refused` (no room for the
   brotli) and `contended` (above).
3. **40 rounds**, each one process of each build of **21 repetitions**, the order alternated (base
   first in odd rounds). A round is a process pair.

## What a sample must show (declared; the validator fails closed)

`summary-wait.mjs` reads the raw rows and the pass can be used only if:

1. Every round 1 to 40 has both builds' files and no other round is there; every repetition 0 to
   20 of every declared row is there exactly once in each: `idle`, `room`, `refused` and
   `contended` at both held sizes, `heldown` at both, and `enc`; every row has its declared
   fields and values that parse; the reference rows (`enc`, `heldown`) are finite and positive.
2. Every sample's `held_us` is finite and positive; the base's rows and every `idle` row show no
   job.
3. Head `room`, both sizes: outcome `admitted`, the job came to its request for the lock with it
   free (`att_held` 0) and to the admission. Head `refused`, both sizes: outcome `refused`, the
   same. (Nothing else takes the lock in these setups.)
4. `contended`, both sizes: in both builds the insertion's call is finite and positive and dropped
   at least one page; in the head every sample shows its contention as above (`att_held` 1,
   `w_in_us` < `att_us` <= `w_seen_us`, `lockwait_us` > 0, the job came to the admission) and its
   outcome is `admitted` or `refused` (whether the brotli finds room after the eviction depends on
   the room the eviction left).
5. Every process exited 0, printed no panic and passed its one test (`wait.sh`).
6. The `idle` control (4,021 bytes), where neither build has a job, has a bound under +0.5 ms.

A sample that fails a condition is not dropped: the pass cannot be used.

## The statistic

Per setup and held size, for each round r: d_r = the median of the head's 21 `held_us` in round r
less the median of the base's 21 in round r (ms). The one-sided 95% upper bound on the median of
d_r is the **26th smallest of the 40** d_r (`stats.mjs`'s `upperRank(40)`: the smallest rank j with
P(Binomial(40, 1/2) >= j) <= 5%, a sign-test bound that assumes the rounds are independent: separate
processes, the order alternated). The estimand is the median, over process pairs, of the head's
median less the base's. The 21 repetitions of a round are not treated as independent; they make
its two medians. Reported as well, descriptive only and held to nothing: the pooled median of the
840 per-repetition differences, each build's median and range, and the d_r range.

## The bounds (4,021-byte held value, 32,768-byte kept body)

H is the base's median, over the pass, of that held value's own forms (`heldown`: brotli 9 and
gzip 9 on the probe's thread); I is the base's median `Store::keep` call for the 4 MiB insertion in
`contended` with that held value (from before it asks for the lock until it returns). The limits
are 1846r2's, unchanged:

1. `room`: bound **under H**.
2. `refused`: bound **under H**.
3. `contended`: bound **under H + I**.

Why: Choice 70 chose 32 KiB as the size whose encoding stays under a small held value's own forms,
so a held value queued behind one kept job should wait less than its own compression costs; with
another writer in the store, the design accepts waiting for that writer too, so the job may add one
insertion's call. These are budgets for the typical added wait of this held value, kept body and
one insertion, not latency ceilings or tail guarantees: H and I are point estimates from the same
pass, not bounds on their own medians. A bound at or over its limit blocks the merge.

Reported with no bound: the 78,967-byte value in every setup, the head's whole-job times, lock
waits and outcomes, brotli 5 of the kept body alone (`enc`), and both held sizes' own forms.

## Not measured by it

A job that waits for more than one writer; a held value queued after the job began encoding (it
waits for less); a writer that takes the lock part way through the job's wait (here it holds it
from before the request, the most this one insertion can add); the request path (1846r2's pass 1,
the warmed path only).

No pooling with 1846r2's pass 3 or the workstation runs, no plan declared again after the run, no
run repeated or dropped for its result. A failed or unusable pass is reported as such with whatever
it recorded.

## Time

Estimated from 1846r2's estimate and a dry run in a container on a busy workstation (2 rounds of
3 repetitions, not a result), where each process took about 1 s and the two builds 23 and 15
minutes with an empty registry cache and other builds running:

1. Setup (packages, rustup) about 3 minutes; the two probe builds (each tree's corten unit tests,
   release profile) about 6 to 10 on a quiet c-8, up to 40 if its downloads or compiles are as slow
   as the workstation's.
2. The pass: 80 processes of 21 repetitions, about 7 to 8 s each: about 11 minutes.

About 20 to 25 minutes in all; under 60 even with the workstation's build times.
