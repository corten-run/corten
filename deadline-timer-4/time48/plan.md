# The kept deadline timer at 48 CPUs: what is run and how it is read

Written 2026-11-25 04:11 UTC, before any run. This is a prototype's time
measurement on one host. It is not a gate reading and not a cycle count under the published
protocol: one build of each tree, one host, placement not varied, no hypothesis test. Nothing here
goes into the repository, the plan, the kit or the pull request.

## Host

One cloud host with 48 dedicated vCPUs, the size the throughput runs under
`evidence/deadline-timer` used (left out of this copy: the provider's name for the size and the
host's region). Created for this and used for nothing else. It reports a Xeon
Platinum 8280 at 2.70 GHz, the model the earlier runs had, and Linux 7.0.0-44-generic (the earlier
runs: 7.0.0-43-generic). Host settings as the earlier runs: `net.core.somaxconn`,
`tcp_max_syn_backlog` and `netdev_max_backlog` 65535, local ports 1024 to 65535,
`tcp_max_tw_buckets` 131072, `tcp_tw_reuse` 1. Docker 29.1.3 from Ubuntu's package. Load generator
gcannon 0.10.0 built from HttpArena at `3388e4586647`, as the earlier runs used (their HttpArena
commit was not recorded); wrk 4.1.0 from Ubuntu's package for the one-connection workload.

## Builds

| Name | Commit | What |
|---|---|---|
| `base` | `e2d0c464e7d7` | `main` at the plan's base |
| `head` | `bf13f4822c57` | the pull request's head: the timer asked for only after a deadline made its own (two stages) |
| `old` | `4c6cdf4ade8f` | the earlier form, the timer made at the first wait and kept; the image `final3` of the first tag, which the 40 s runs of 440,017 and 439,502 were read on (the 441,621 and 447,122 are of `final2`, which differs from it by one `mut`) |
| `oldbase` | `be1192a7b964` | the base `old` was written on, so that `old` has a base of its own tree: `main` moved between the two bases (in the crates: `answer.rs`, `route.rs` and a test) |
| `base2` | `e2d0c464e7d7` | the image of `base` again, under another name, for the noise bar |

One toolchain and one set of flags for all four: the image `rust:1-trixie` as pulled at the build
(its rustc version is recorded in `log/toolchain.txt`), `cargo build --release` of the benchmark
entry (`bench/httparena/corten`, the app of the first tag, `App::per_core` removed as every earlier
build did) inside each whole tree, `RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"`,
the entry's profile (`opt-level = 3`, thin LTO, one codegen unit). `base` is built first and its
`Cargo.lock` is given to the other three, so that all four have the same versions of every
dependency; a lock that cargo changes is reported. Each binary runs in an image like the entry's
own (`debian:trixie-slim`, jemalloc preloaded, `MALLOC_CONF=background_thread:true,tcache_max:65536`).
This differs from the earlier throughput images in one way: those were built by the entry's
Dockerfile from the crates alone and resolved hyper 1.13.0; these are built in the whole tree.

## How a run is made

Every run starts a new server container (`--network host`, `--cpuset-cpus` as the workload says,
`--ulimit memlock=-1:-1 --ulimit nofile=1048576:1048576`, the dataset, static files and
certificates mounted as before, `ARENA_MODE` as the workload says), waits until it answers, runs
the load, and removes the container. The load is in its own container held to its own CPUs. One
second between runs. Nothing else runs on the host.

A workload is ten rounds. A round is one run of each build (and of each condition, where a
workload has two). Odd rounds take the builds in the order given, even rounds in the opposite
order, so the builds alternate run by run and no build keeps a place in the round. Where there are
two conditions, a build's two runs are back to back, their order turning with the round.

## Workloads

Unless said otherwise: the server on CPUs 0 to 23 with tokio's multi-threaded runtime
(`ARENA_MODE=default`, its default of one worker a CPU: 24), the load on CPUs 24 to 47 with 24
threads, `GET /sdelay/10` (a staged route, so the deadline is on; the handler sleeps 10 ms),
gcannon `-p 1`, 10 s, builds `base head old oldbase base2`.

| Id | Asked as | What differs |
|---|---|---|
| `a10` | (a) | 32,000 connections, 10 s: the earlier `async-staged` |
| `a40` | (a) | 32,000 connections, 40 s: the earlier `async-staged40` |
| `b1024` | (b) | 1,024 connections |
| `b8192` | (b) | 8,192 connections |
| `c4` | (c) | 32,000 connections; 4 workers on CPUs 0 to 3 |
| `c16` | (c) | 32,000 connections; 16 workers on CPUs 0 to 15 |
| `c48` | (c) | 32,000 connections; 48 workers on CPUs 0 to 23, two a CPU: the host has no 48 CPUs free of the load. 24 workers is `a10` |
| `f10` | (f) | 32,000 connections; one single-threaded runtime a core (`ARENA_MODE=percore-by-hand`) on CPUs 0 to 23 |
| `d64` | (d) | `GET /baseline11?a=1&b=2` (staged, never waits), 64 connections; conditions `quiet` and `wait`; builds `base head old base2` |
| `d1024` | (d) | the same at 1,024 connections |
| `em` | (e) | one connection that never waits (`wrk -t1 -c1` on CPU 24, `GET /baseline11?a=1&b=2`, 10 s); conditions `none` and `idle3`; builds `base head old base2` |
| `es` | (e) | the same with the server one single-threaded runtime on CPU 0 (`percore-by-hand`), so both connections are on one driver |

Conditions:

1. `wait` (d): 48 more kept-alive connections, each sending `GET /sdelay/1` once a second, their
   phases spread evenly over the second (`waiters.py`, on CPU 47), started 2 s before the load and
   stopped after it. With a deadline of 30 s a kept timer of each of them always stands. `quiet`:
   no such connection; the same 2 s.
2. `idle3` (e): one more connection sends `GET /sdelay/1` three times before the load and stays
   open and idle. `none`: no such connection.

The queue runs them in this order: `a10 a40 b1024 b8192 c4 c16 c48 f10 d64 d1024 em es`; about four
hours.

Hardware counters are exposed on this host. For `a10`, `a40`, `d64` and `d1024` every run's load
is wrapped in `perf stat -a -C <the server's CPUs> -e cycles,instructions`, counting only (no
sampling), and cycles a request is the count over the 2xx answers. It covers the load generator's
whole run, connections being opened included, and everything that ran on those CPUs, kernel
included.

## What is recorded

For every run: requests a second (gcannon: 2xx answers over its duration; wrk: its own figure),
latency average, p50 and p99 as the load generator prints them, the server container's CPU time a
request (its cgroup's `usage_usec`), cycles and instructions a request where counted, the server's
thread count, and the load generator's whole output.

## A failed run

No error is tolerated. A run fails if any answer is not 2xx, the count of answers is not the count
of 2xx, the load generator reconnected, its output cannot be read, wrk reports a socket error, a
waiter got an answer that is not 200, was closed, was late with a request or answered fewer times
than the run has seconds, or the idle connection was not answered three times. A failed run stops
its workload, which is then not read; it is run again whole once after the queue, and if it fails
again it is reported as failed.

## How it is read

For a workload (and condition), a value (requests a second, p50, p99, cycles a request) and a
build X, with i the round:

1. X's median, least and most over the ten rounds.
2. The ratio to the base of the same round, r_i = X_i / base_i: the median of r_i, its least and
   most, and how many of the ten are above 1 and how many below.
3. The noise bar N of that workload and value: the largest |base2_i / base_i - 1| over the ten
   rounds.
4. X is **resolved** against the base when |median r - 1| > N and at least nine of the ten rounds
   are on the median's side of 1. Otherwise it is not resolved, whatever the median.
5. `old` is read the same way against `oldbase` (its gain over its own base) and against `base`;
   `oldbase` against `base` says what the move of `main` is worth; `head` is also read against
   `old` directly.
6. Where there are two conditions: for each build the ratio of the two conditions' runs of the same
   round, k_i(X) = X_i(wait or idle3) / X_i(quiet or none), read as in 1 and 2, and a build's
   excess over the base, k_i(X) / k_i(base), with the noise bar the largest
   |k_i(base2) / k_i(base) - 1| and the same rule for resolved.

No run is left out of a read workload and no workload is run again because of what it read.

## Before the first read run

One round of `a10`, `d64` and `es` is run into a scratch file to see that the harness works on this
host. Those runs are not read. A fault they show in the harness is mended and written here, under
this line, before the queue starts.

Written at 04:17 UTC, after the check (04:11 to 04:16, 21 runs, none failed) and before the queue:

1. The builds: rustc 1.100.0, cargo 1.100.0, tokio 1.54.1, hyper 1.12.0, jemalloc 5.3.0; the three
   later builds kept the base's lock file unchanged. Binaries (sha256, first 16): `base`
   `08b75ba506765cd4`, `head` `196d19a338a2a13d`, `old` `cbfb0dff31f3041b`, `oldbase`
   `b0537b6d5bc66ab4`.
2. One fault, in what the harness prints and not in what it runs: the first line of a wrk workload
   named gcannon's connections, threads and request file. That line now says what wrk is given.
   Nothing else is changed.
