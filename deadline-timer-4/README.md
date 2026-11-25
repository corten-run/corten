# The kept deadline timer measured as it is

Evidence for `docs/design.md#choice-deadline-timer` and for
[#2029 Keep one deadline timer for a connection's requests](https://github.com/corten-run/corten/pull/2029),
taken on 2026-11-25 (UTC) on the form the pull request ships. Unless a file says otherwise the
base is `main` at `e2d0c464e7d7b56ea69b59c8fe7e8c9c2078d5bc` and the head is the pull request at
`bf13f4822c575a9ba478a5f8a97cfee289f3c88b`, which holds that base. Nothing under
`deadline-timer/`, `deadline-timer-2/` or `deadline-timer-3/` is changed.

None of this is a cycle run under `CONTRIBUTING.md` (Pull requests, item 2) or design Choice 72:
one build of each tree, one host a measurement, placement not varied. No machine's name, address
or region is kept here; each directory says what its host reported of itself.

## `time48/`: requests a second, latency and CPU time on 48 CPUs

`plan.md` was written before any run and says what is run and how it is read; its "Before the
first read run" part was added after the harness check and before the queue. Two things are left
out of this copy: the provider's name for the host's size and the host's region, and a remark of
the local time of day. It says that nothing of it goes into the repository or the pull request,
which was so when it was written; it is kept here on the maintainer's direction after the runs
were read.

1. `setup.sh`, `build.sh`, `mkreq.sh`, `run48.sh`, `queue.sh`, `smoke.sh`, `waiters.py`: the
   scripts as they ran. `sum48.mjs` reads `results.tsv` as the plan says.
2. `host.txt`: the host's kernel, CPU count and model, the toolchain, the binaries' and images'
   ids and the tools' versions. `log/`: the toolchain, both Dockerfiles and each build's lock file.
3. `smoke.out`, `smoke.tsv`: the one round run before the queue (04:11 to 04:16 UTC, not read).
4. `queue.out`, `results.tsv`: every run of the queue (04:16 to 07:16 UTC), one line a run.
   `raw/`: each workload's log with the load generator's whole output. `req/`: the requests sent.
5. `summary.txt`: `node sum48.mjs results.tsv`, the reading the Choice cites: each build's
   median and range, its ratio to the base of the same round, the noise bar and whether it is
   resolved.

Builds: `base` and `base2` are `e2d0c464e`, `head` is `bf13f4822`, `old` is the earlier form at
`4c6cdf4ad` and `oldbase` the base it was written on, `be1192a7b`. The server's CPU time a request
is its container's cgroup `usage_usec` over the answers; it is not one of the values the plan
declared a reading rule for before the runs, and `sum48.mjs` reads it by the same rule.

## `counts/`: the instructions of a timer left set

Counted by callgrind on a host of 16 CPUs (`out/host.txt`: Xeon Platinum 8168, Linux 6.12.117,
valgrind 3.24.0), the benchmark entry built from each tree with `--cfg tokio_unstable`.

1. `c3-build.sh`, `c3-build2.sh`: the count image, the two trees and the candidate forms
   `variants.py` writes from the head's `deadline.rs` (the timer taken out of the wheel when its
   connection has no deadline waiting: `out1`, `out8`, `req1`, `req8`, `rq1`, `rq8`; the timer set
   no further off than a second: `soon`, `soon2`; the timer left 30 years off: `far`).
2. `count7.py` counts instructions, allocations and parks a request; `sets.sh` is the sets of rows
   (`main`, `extra`, `loop`, `standing`, `busy`, `slow`); `c3-run.sh` and `c3-run3.sh` to
   `c3-run5.sh` ran them, `smoke.sh` tried every option once.
3. `out/`: every line `count7.py` printed, a file a set, build and round. `summary.txt`:
   `sum.mjs`'s reading of them, each build's median of three counts a round and its difference
   from the base of the same round.
4. `prof.sh`, `prof2.sh`, `fnprof.py`, `fnprof-full.py`, `prof.txt`, `prof2-out8.txt`,
   `prof2-req1.txt`: instructions a request by function, head less base and two forms less the
   head.
5. `fires.rs`, `c3-test.sh`: a scratch test of what a timer left set does when its time comes
   with no deadline having it. The crate now holds that test as
   `a_timer_left_set_wakes_its_connection_once_when_its_time_comes`.
6. `c3-late.sh`: an earlier script for the lateness. Its output is not kept here;
   `after-review/first/out/late.log` is the run the Choice cites.
7. `passes/`: requests a second and latency passes on a host of 8 CPUs (the server on four, `wrk`
   on four), 02:33 to 03:10 UTC, by `tp.sh`, `tp1.sh` and `tp2.sh`, read by `tpsum.mjs`. The Choice
   cites none of them: `time48/` replaced them.

## `after-review/`: what the third review asked for

`first/` ran on the count host on the head's tree (`bf13f4822`) with the working tree's
`tests/server.rs` and `deadline.rs` over it as they stood at 13:34 UTC: three of the four tests
the branch then added, and one comment of `deadline.rs` in a longer wording than the one committed.
`u2-queue.sh` is the queue.

1. `log/test-clean.log`, `log/test-M*.log`, `log/queue.log`: the deadline tests
   (`cargo test -p corten-run --all-features --lib -- tests::server deadline`) on that tree, then
   against each rule break of `mut.py` in turn.
2. `out/idle-base.txt`, `out/idle-head.txt`: the bytes and blocks an idle connection holds in
   five states, by DHAT (`idle5.py` over `extra.py` and `count2.py`), two runs each.
3. `out/late.log`: how late a deadline's answer is (the crate's ignored test
   `how_late_a_deadlines_answer_is`, release profile, no `tokio_unstable`), the base and that tree
   in turn, five rounds, nothing else running. The base has no such test; `late_carry.py` carries
   it and its three helpers over from the head's test file.

`merged/` ran the same tests and rule breaks (`u3-queue.sh`, with `first/mut.py`) on the tree of
the branch once it had merged `main` at `26ab0e37f`: commit
`684796f6bca1ae070f85f7a239f1d5e21be9fbf5`, all four tests in it.
