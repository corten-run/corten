# A connection's kept deadline timer: what was run

What design Choice 73 (`docs/design.md#choice-deadline-timer`) cites: the benchmark app as it was
measured, the variants that were not chosen, the scripts as they were run and every run's result.
All of it is from 2026-11-24.

The commit this tag sits on has the change as its history:

1. `d0ad2c077`: tests of a kept-alive connection's deadlines that hold on the base too.
2. `69663386e`: the change's first form. Image `conn`.
3. `4c6cdf4ad`: the connection polled in one place. Image `final3`; the code an independent review
   read.
4. `6c94d5324`: `main` at `56432f2fc` merged in.
5. `75ded4019`: the review's fixes and tests.
6. `20f12b943`: the Choice, the guide and the changelog note. The tag's parent.

The base of the first three is `be1192a7b` (image `base`). `drop-criteria.md` was written before
any build of the change was measured, and `rule-single-request.md` before the counts it reads.

## Hosts

Two cloud hosts, used one after the other for separate things, neither shared with anything else.

1. Throughput: class c-48, 48 vCPUs, a Xeon Platinum 8280 at 2.70 GHz, Linux 7.0.0-43-generic
   (`results/throughput/host.txt`). The server runs in a container held to CPUs 0 to 23 with the
   host's network, and the load in one held to CPUs 24 to 47 with 24 threads. For the pooled route
   the local service has CPUs 36 to 47 and the load CPUs 24 to 35 with 12 threads. No run was
   taken with the server on fewer cores.
2. Builds, tests and instruction counts: class c-16, 16 vCPUs. The first counts, the lateness
   runs and the first checks ran on one with a Xeon Platinum 8280, the merged recount and
   everything after the review on another with a Xeon Platinum 8358; both Linux
   6.8.0-149-generic (`results/instructions/host.txt`, `results/instructions/merged/host.txt`).
   Everything there runs in `rust:1-trixie`: rustc 1.100.0, valgrind 3.24.0.

## The app and its versions

`app/` is the benchmark app as it was built: the entry of the investigation this change came
from, with the one call `main` does not have (`App::per_core`) removed, which every build script
does with `sed`. Its routes, as the results name them:

1. `async-staged`: `GET /sdelay/10`, a staged route (every stage, so the app's deadline is on)
   whose handler awaits `tokio::time::sleep` for 10 ms. The handler makes and drops a tokio timer
   of its own, so a request on the base takes the timer wheel's lock four times, two of them the
   deadline's.
2. `spool`: `GET /spool`, a staged route whose handler waits on a pooled TCP connection to a
   service on the same host (`ARENA_MODE=echo`), 4,096 connections.
3. `async` (`GET /delay/10`, `unstaged`, so no deadline), `baseline` and `json-comp`: handlers
   the deadline's timer is not part of, measured to see that they do not slow.
4. In the counts: `get` is a staged `GET /baseline11?a=1&b=2` that does not wait, `sdelay0` and
   `sdelay1` are `GET /sdelay/0` and `/sdelay/1`, `delay1` is the unstaged `GET /delay/1`, and
   `pipeline` an unstaged request that does not wait.

The app is outside the workspace and has no lock file, so each build resolved its own versions.
The images of the throughput runs and the first counts were built from the crates, the
workspace's manifest and the app alone, and resolved tokio 1.54.1 and hyper 1.13.0. The merged
recount and the counts after the review were built inside the whole tree, whose cargo
configuration holds back versions published in the last three days, and resolved tokio 1.54.1 and
hyper 1.12.0, which is what the workspace's `Cargo.lock` has
(`app/Cargo.lock.merged-recount`). Both sides of every comparison were built the same way.
Every build has `RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"`, as the app's
Dockerfile sets.

The load generator is gcannon 0.10.0 with HttpArena's request files, as the investigation's
runs used; the commit of HttpArena was not recorded here.

## Images

`base` is `be1192a7b`. `conn` is `69663386e`. `thread` and `sweep` are `conn` with
`variants/per-thread-deadline.rs` and `variants/sweep-deadline.rs` (the second applied by
`variants/sweep-apply.py`). `off` is `base` run with `ARENA_DEADLINE=off`, no deadline at all.
`final` and `final2` are two steps on the way to `4c6cdf4ad`
(`variants/intermediate-final.patch`, `variants/intermediate-final2.patch`, each against the
base with the first commit's tests); `final2` differs from `4c6cdf4ad` by one `mut` that clippy
refused. `final3` is `4c6cdf4ad`. In the counts after the review, `main` is `56432f2fc`,
`built` is the merged head with the review's fixes (`75ded4019` has the same `deadline.rs`
but for four test-only lines, a counter the tests read) and `two` is `built` with
`variants/two-stage-deadline.rs`.
`variants/two-stage.patch` is the same idea against `4c6cdf4ad`, counted before the review.

## Results

`results/throughput/`: `results.tsv` has one row a run (pass, variant, profile, requests a
second, latencies, the server's CPU time, failed requests), `summary.txt` the medians and ranges
`kit/throughput/agg.py` makes of it, and `load/` the load generator's output of each run.

1. `p1` and `p2`: five 10 s runs of each variant in a block, `p2` in the reverse order:
   `base`, `conn`, `thread`, `sweep`, `off`.
2. `p3` was stopped part way and is not read.
3. `p5` and `p6`: five rounds, the builds alternating run by run: `base`, `final2` and `thread`.
   One round's `spool` run in each was answered with errors by every variant (the pooled service
   had not come up); `agg.py` leaves failed runs out and counts them, and the later passes check
   the service before loading.
4. `p7` and `p8`: three rounds alternating `base` and `final3`.
5. `p5.long` to `p8.long`: one 40 s run of `async-staged` a build after each of those passes.

`results/instructions/`: callgrind, the server held to one CPU, one client connection, each
request sent after the answer before it; a count is the difference of a run of 1,240 requests
and one of 240, over 1,000 (`kit/build/count2.py`).

1. The files at its top are the first counts, at the original base: `base`, `conn`, `thread`,
   `sweep`, the intermediates, and `final4` (the two-stage patch). `by-function/` is callgrind's
   output by function for the connection's poll.
2. `merged/`: `56432f2fc` against `6c94d5324`.
3. `review/`: `main`, `built` and `two` after the review, on the multi-threaded runtime
   (`default`) and on one single-threaded runtime (`percore-by-hand`, which under one CPU is one
   runtime), kept-alive and with a connection for each request (`each`), two rounds in opposite
   orders. `count-settle-*` is the second series `rule-single-request.md` reads: a connection
   for each request with the client waiting 10 ms after each close (`kit/build/count4.py`),
   which holds a build's six counts within 16 instructions where they spread over 250 without.

`results/lateness/`: how late a deadline's answer is, 200 deadlines of 50 ms on one connection
(the ignored test `how_late_a_deadlines_answer_is`, release build).

`results/checks/`:

1. `merged-*`: fmt, clippy and the lib tests on `6c94d5324`, the timer's size, and the probe of
   the cycle plan's kit with its added routes built and asked once on each side.
2. `fixed-*`: fmt, clippy and the lib tests on the tree with the review's fixes.
3. `rule-breaks.log`: each test the review asked for, run on a copy of the tree with the rule it
   is for broken (`kit/build/mut.py` says how), where it must fail, and then all of them on the
   tree as it is.
4. `paused4.log`: tokio's paused test clock while a served connection sits idle, on main and on
   the merged head. `paused.log` and `paused2.log` are the same tests' first runs, kept because
   they were made: their `p-head` lines came from the binary built for main (two copies of the
   tree at one path with one target directory), as their equal counts of filtered tests show,
   and are not read. `paused3.log` counts the connection's timer in the same test.
5. `outer-gone.log`: a deadline that took its connection's timer, polled after the connection's
   runtime has shut down.
6. `tokio-read.log`, `tokio-read2.log`: the lines of tokio 1.44.0's and 1.54.1's source the
   Choice's platform premise was read from.

## The kit

`kit/throughput/` and `kit/build/` are the scripts as they were run, with the hosts' scratch
directory names rewritten and nothing else changed; several are steps of one afternoon and say
so. `kit/probe-addition/` is for the cycle run the pull request plans and has not been run: a
patch to the kit under the tag `evidence/stage-header-checks-2002` that adds two routes to its
probe and four workloads to its scripts, and the probe's source as it then reads.

## Not here

Cycles: none were counted. Perf profiles. A run with the server on fewer than 24 cores. A run at
tokio 1.44, the crate's minimum, whose timer wheel is locked in shards.
