# Serving a core at a time: where the sleeping handler's gain comes from, and what the rest is

What design Choice 73 (`docs/design.md#choice-per-core`) cites from its second host: the kit as
it was run and its results. The first host's run (HttpArena's own profiles at `17b7b4c4b`) is
not here.

The commit this tag sits on has the code that ran as its history:

1. `1649b2a80`, the proposal's head: `App::per_core` and the scratch entry
   `bench/httparena/corten`. Image `pc`.
2. `abfc550a3`: the entry with more routes and settings, on the same framework code. Image
   `var`. Its `main.rs` says what each setting does (`ARENA_MODE`, `ARENA_TIMER`, `ARENA_DELAY`,
   `ARENA_TIMER_THREADS`, `ARENA_WORKERS`, `ARENA_GQI`, `ARENA_EVI`, `ARENA_IO_EVENTS`,
   `ARENA_LIFO`, `ARENA_POOL`, `ARENA_POOL_KIND`, `ARENA_DEADLINE`, and `ARENA_MODE=echo`, the
   pooled service).
3. `019d15fa1`: a prototype that keeps a request deadline's timer between requests, behind
   `CORTEN_PROTO_KEEP_TIMERS`. Images `var2` and `final`.

The trees that were built were kept beside the results and compared with these commits
afterwards. `pc`'s crates are `1649b2a80`'s and `final` is `019d15fa1`. `var` and `var2` were
built before the code was formatted for its commits: the entry's `main.rs` differs from
`abfc550a3`'s in the layout of two statements, and `var2`'s `crates/corten/src/page.rs` from
`019d15fa1`'s in the layout of one. Nothing else differs.

`var`, `var2` and `final` are built with `--cfg tokio_unstable -C force-frame-pointers=yes` (the
entry's Dockerfile at `abfc550a3`): the first for the runtime settings the entry tries, the
second so `perf record -g` can walk the stacks. `pc` is built without them.

## Host

One DigitalOcean c-48 droplet: 48 vCPUs, a Xeon Platinum 8280 at 2.70 GHz (the header of perf's
data files), Linux 7.0.0-43-generic (`results/setup.txt`), Ubuntu 24.04 by the run's notes. The
runs are from 2026-11-24, 03:48 UTC on.

rustc 1.100.0 in `rust:1-trixie`, tokio 1.54.1, hyper 1.13.0 and mio 1.2.5: the entry has no
lock file, so each build resolved them (`results/build/`). jemalloc is preloaded as the entry's
Dockerfile sets it. The load generator is gcannon 0.10.0, built from
`MDA2AV/HttpArena@3eb74a7` (`docker/gcannon.Dockerfile`), with that commit's `requests/` and
`data/dataset.json`. perf's version was not recorded.

The server runs in a container held to CPUs 0 to 23 with the host's network, and the load in
one held to CPUs 24 to 47, 24 threads, unless a batch says otherwise. For the pooled runs the
service has 12 CPUs (36 to 47) and the load 12 (24 to 35) in `batchF.sh` and `batchG.sh`, and
the service 8 (40 to 47) and the load 16 (24 to 39) in `batchC.sh`.

The scripts expect this directory's `kit/` at `/root/pcc`, the HttpArena clone at
`/root/work/httparena-gap/HttpArena` and the images under the names they use. They were
written for this host and are kept as run, not as a tool.

## What ran

Every run is one row of a `results/*.tsv`: label, profile (`@` and the connections where not
the profile's own), run, requests a second (2xx responses over the time), mean latency, 99th
percentile, the server's CPU a request in microseconds (its cgroup's `usage_usec` over the
responses), the system's share of that CPU, the least, median and most busy of the server's
24 CPUs in percent (`/proc/stat` before and after), then errors, reconnects and, from `run3.sh`
on, the CPUs the server and the service used. `results/load/<label>.log` has the load
generator's output for each run, and `results/cores/` each run's 24 busy shares.
`results/summary.txt` is `kit/summ.py` over each file: the runs, the best and the median.

The profiles (`run3.sh`): `baseline` is HttpArena's `get.raw`, `post_cl.raw` and
`post_chunked.raw` at 4,096 connections for 5 s; `async` its `async-delay.raw` at 32,000 for
10 s (`async30` for 30 s); `json` its `json-get.raw` at 4,096. `async-staged`, `async0`, `pool`
and `spool` send request files written on the host and not kept: by the run's notes one `GET`
each of `/sdelay/10` (the sleep on a route through the stages), `/delay/0`, `/pool` and `/spool`
(the pooled call outside the stages and through them).

1. The two profiles again on `pc`, best of three, two passes with the order turned:
   `results/repro/`. The script that ran it is not in the kit; `repro.out`'s first line gives
   its CPUs, threads, connections and runs.
2. `batchA.sh` (`results.tsv` labels `v-`, `perf-runs.tsv`, `results/perfstat/`): `var` against
   `pc`'s numbers, and `perf stat` over 2.5 s of one run of each profile and mode.
3. `batchB.sh` (`results.tsv` labels `b-` and `c-`): the runtime's settings, the alternative
   timer, the handler waiting on timer threads of the app's own in place of tokio's timer, then
   a second pass of four of them.
4. `probe.sh` (`probe/<mode>.<profile>/`): a 30 s run looked at in its steady state. `perfstat`
   is `perf stat` over 3 s; `threads0`, `threads1`, `t0` and `t1` are each thread's time on a
   CPU and its context switches at two moments about 4.3 s apart; `trace` is `perf trace -s` over
   1 s; `switch.txt` is the report of `perf record -e sched:sched_switch -g` over 1 s, the stacks
   at which threads left a CPU; `cpu.self.txt` is the report of `perf record -F 999 -g` over 3 s
   by function, without callers (`reports.sh` made both reports). `default64` and `percore64`
   are the baseline profile at 64 connections; `thread` is the handler waiting on the app's own
   timer thread.
5. `conns.sh` (`results/conns.out`): the connections on each event loop under `per_core`, from
   the sockets each epoll instance holds, on `var2`, with `get.raw` alone at each count but
   32,000, which is the sleeping profile's.
6. `batchC.sh` (`pool.tsv`): the pooled service with the pool the limit, 1,008 and 72
   connections. Its second pass was stopped after the first configuration (`q72-`), so this is
   one pass.
7. `batchE.sh` (`steady.tsv`, `deadline.tsv`, `few.tsv`, `pool2.tsv`): 30 s runs of the sleeping
   profile, the request deadline on and off on a staged route that sleeps, 64 and 256
   connections in two passes, and the start of a pooled pass with a pool of 4,032 that was
   stopped (`pool2.tsv`, five rows) for `batchF.sh`'s layout. `batchD.sh` was not run on its
   own: its runs are the 64 and 256 connection part of this batch.
8. `batchF.sh` (`few2.tsv`, `pool3.tsv`): 24 connections and the JSON answer, and the pooled
   service with the server's CPU the limit, 4,032 connections, two passes with the order
   turned. The rows of zeros in `few2.tsv` are the load generator with 24 threads and fewer
   connections than threads, which sent nothing: `batchG.sh` ran 8 and 16 connections again
   with 8 threads. The two `wget` lines in `batchF.out` are the start check retried while a
   server opened its 4,032 pooled connections before listening.
9. `batchG.sh` (`keep.tsv`, `few3.tsv`, `pool4.tsv`): the kept-timer prototype on `var2`, and 8
   and 16 connections.
10. `final.tsv`: `final`, two runs each, by `run3.sh`; the batch that called it was not kept.

`build-var2.sh` built an image from a tree, `smoke.sh` checked each route answered in each
mode before the batches, and `busy.py` reads the busy shares of the load's CPUs.

## Readings made from the kept files

These four were made after the run, from the files here, so the numbers can be worked out
again:

1. `results/cycles.txt` (`kit/percycle.py`): for each probe, the process's cores (task-clock
   over the time), context switches a second, and cycles and instructions a request. The
   requests a second are the whole 30 s run's and the counts are from 3 s inside it.
2. `results/threads.txt` (`kit/threads.py`): each busy thread's share of the window on a CPU
   and waiting for one, and its switches a second. It is the reading `probe.sh` prints at the
   end of a probe, whose output was not kept.
3. `results/cycles-by-group.txt` (`kit/cyc.py`): the sleeping profile's cycles a request by
   group of functions, from the three `cpu.self.txt`.
4. `results/summary.txt`, above.

The three counts of the default runtime's CPU on the sleeping profile do not agree: 17.1 cores
by `perf stat`'s task-clock, 19.5 by the threads' own times and about 22 by the cgroup. The
busy shares from `/proc/stat` are not reliable for threads that sleep and wake tens of
thousands of times a second.

Not explained and not run again: with the pool of 1,008, `per_core` with the shared pool read
375,994 to 381,263 requests a second on `/spool` in all three runs, where it read about 310,000
on `/pool` and the default runtime about 315,000 on both.

## Left out

1. The `perf record` data files (4 to 27 MB each, about 230 MB), which the reports here were
   made from, and both server binaries.
2. The reports with callers (`cpu.children.txt`, 1.4 to 2 MB each) and the reports of
   `batchA.sh`'s four `perf record` runs. The `cpu.self.txt` kept have each run of spaces cut
   to two, since perf pads a symbol's column to several hundred characters; nothing else in
   them is changed, and `switch.txt` is as perf wrote it.
3. The `/proc/stat` snapshots before and after each run (`results/cores/` has what was read
   from them) and the probes' `mpstat` output.
4. The source trees that were built (the commits above) and the script that wrote the entry's
   variants.

## Not run

The event loops written by hand (`ARENA_MODE=percore-by-hand`); HttpArena's other profiles
under the variants; HTTPS; a second pass of the runs with the pool the limit; a database; a
proxy or a service on another host; a load that arrives at its own rate; a few connections
whose handlers each use much of a core; a `main` on the multi-threaded runtime under
`per_core`; another host or another kind of host; tests for the kept-timer prototype.
