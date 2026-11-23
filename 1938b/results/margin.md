# Margin for kit 1938b, #1938's supplement after round 2 of review, declared before the run (2026-11-22, prepared; not yet run)

<!-- commits --> Base `83b3b8772b7dbfd93ed55425022d4e101e16e644`, head `84de7c1e5185401ff27bd53f104bdfffb4b14b55` (from commits.env; merge-base of the head with origin/main: `83b3b8772b7dbfd93ed55425022d4e101e16e644`; origin/main at export: `5a22836fc283e9d731c701fb7dfa74ce3a843684`).

corten-run/corten#1938, "Let a handler or a task drop the pages the app keeps for a change it made"
(issue #1795). Kit 1938 (results/margin.md there, declared and uploaded before this file) measures
the write that opts in (`named`, `named-off`) and three controls (`write`, `kept`, `plain`). Its
second review found what 1938 leaves out:

1. `App::new` now allocates the pending `KeptAnswers` cell at startup, in every app, including one
   that never calls `App::kept` and has its store off. The PR's callgrind split under glibc's
   allocator reports +226.8 instructions on a write that names nothing with the store off (and
   +196.9 on a plain read), not shown to be allocator state alone. 1938 has no such workload:
   `named-off` takes `KeptAnswers`, `write` keeps the store on, and every 1938 workload runs with
   jemalloc only.
2. The harness's `ROUTER_TARGET=new` could pass without a single insertion into the store.

This kit adds those cases with the same base and head, the same protocol, CPUs, ports and
statistic as 1938, and nothing else.

## What stays the gate and what this supersedes

- 1938's five workloads (`named`, `named-off`, `write`, `kept`, `plain`) stay the gate for their
  cases, held to 1938's margin.md as declared there. This kit supersedes none of them and does not
  rerun them.
- 1938 has no `new` workload and no result for it, so this kit's `new` supersedes nothing of 1938's:
  it is a new case. The PR's instruction tables have no count from `ROUTER_TARGET=new` either; that
  harness mode is fixed in the PR (it refuses `ROUTER_KEPT=0`, and after the counted requests the
  first and the last URL must be given from the store), and any count from it is taken after the
  fix.
- `write-off` and `write-off-glibc` are new cases too. The plain read under glibc (+196.9 in
  callgrind) is not measured here and stays unresolved.

## Workloads

The probe is 1938's (probe-*/src/main.rs, the same file built against base and head), with one
config added and nothing else changed: `page-roomy`, the same app with `App::kept_answers(1 << 30)`.
Served by `corten::serve` (HOST=127.0.0.1, ports 18381 and 18382) on a current-thread runtime with
the template's features (defaults and `compress`), the repository's release profile (opt-level 3,
thin LTO, one codegen unit), rustc 1.100.0, both built on the host from the exported trees with
each tree's Cargo.lock (byte-identical to 1938's trees and locks). Every turn starts the build
fresh; in an app with a store, `/home` is asked for three times first (the third must carry `Age`).

1. **write-off**: `POST /items/8/edit`, same-origin, app `page-off` (`kept_answers(0)`): a write whose
   handler takes nothing, in both builds, in an app with no store and no call to `App::kept`.
   jemalloc preloaded (`LD_PRELOAD=libjemalloc.so.2`,
   `MALLOC_CONF=background_thread:true,tcache_max:65536`), as 1938's workloads.
2. **write-off-glibc**: the same request and app with glibc's allocator (nothing preloaded), the
   allocator under which the PR's callgrind counts for this request differ.
3. **new**: `GET /home?t=<thread>&n=<k>`, a new URL with every request (lua/get-new.lua: k counts
   1, 2, ... in each of wrk's two threads), app `page-roomy`: each request misses, runs the page's
   handler, and keeps the page. The 1 GiB bound (the same in both builds) is room for every page a
   3 s turn makes, so the store never fills and refuses a URL it was not asked for before (the
   default 32 MiB would fill within a turn, and from then on mostly measure renders that are not
   kept). jemalloc preloaded.

Every server reports the allocator it found (`/proc/self/maps`) and refuses to start if it is not
the declared one; `run-pair.sh` also checks the report.

wrk -t2 -c64 on CPUs 4-5 for **3 s** a turn (lua/post-same-origin.lua, lua/get-new.lua, whose
`done()` print the requests and every error count, and for `new` each thread's last k), fixed now.

None of the three is named a negative control. Choice 71's recorded floor (+1.62%) is calibrated on
one workload alone, `plain` (`GET /private`) on a matching setup, which none of these is, and no
same-run A/A layout control is declared here; the store-off writes are on the code the review says
the change touches (an allocation every head app makes at startup). So each is held to **+1% with
no floor**, however flat its instructions, and no declaration is added or changed after the run.

## Method

1938's, unchanged: `run-pair.sh`, run by `run.sh` under `taskset -c 7`: every turn on a freshly
started build, pinned to CPU 2, warmed, loaded, and stopped. The order turns every pair (base first
in odd pairs). perf stat counts the server process alone for exactly as long as wrk runs:
`cycles:u`, `cycles:k`, `instructions:u`, task-clock (software, for how busy the server was), and
`L1-icache-load-misses` (perf may print it with or without `:u`; both are read) as a diagnostic only
when a preflight counts it beside the other three at 100% (host.txt says which, and the preflight's
output when it is not counted). Every hardware counter must report 100% running in every turn, and
every request must succeed: any connect, read, write or timeout error, or a status wrk counts as
an error, stops the workload after the turn's row; failures are counted in the CSV and reported.
Cycles per request = (cycles:u + cycles:k) / requests wrk completed in the turn.

Before the first turn each build answers the workload's request on fresh starts (base twice): the
status line, the headers but Date (Age's value masked), the body's length and sha256, for `new`
whether the same URL asked for again is given from the store, then whether `/home` is kept. The two
base answers must be the same and head's the same as base's (none of these workloads differs by
design); base's `new` must say its first answer had no `Age`, `again: kept` and `home after: kept`,
and the store-off writes `home after: none kept`. Then `run.sh` runs every workload once with no
recorded pair (check-only/, one unrecorded pair each) and stops if any fails.

`new` proves its insertions in every turn, warm-up included, after perf has stopped and before the
server is stopped: for each wrk thread, `/home?t=<t>&n=1` and `/home?t=<t>&n=<last - 100>` must
be given from the store (`Age`), or the workload stops. The extra requests are outside the counted
interval.

One unrecorded warm-up pair, then **100 recorded pairs** a workload, fixed now. The one-sided 95%
upper bound on the median per-pair change is the 59th smallest of the 100 changes (`summary.mjs`,
distribution-free; 1938's, with only a check added that the CSV has the 100 pairs declared).

Host: a quiet dedicated-CPU droplet (c-8, debian-13-x64, root), set up by `setup.sh` and built by
`build.sh` there (both builds at once, each in its own target directory), started by
`/root/start.sh`; nothing else run or logged into while it runs. It may be the host kit 1938 ran
on, after 1938 has finished, never during it.

## Margin

No win is claimed or sought.

**write-off**, **write-off-glibc** and **new** each pass when the one-sided 95% upper bound on the
median per-pair change in user+kernel cycles per request (the 59th of the 100 sorted changes) is
under **+1%**.

**Otherwise not met**: reported as measured (median, bound, best and range, user and kernel split,
instructions:u, the icache diagnostic if counted, requests/s, server busy, failures), with no
performance claim either way, and what the run did not resolve. A workload that misses while its
instructions:u are flat is reported as that; no floor applies to it. No rerun or pooling is
declared here.

`write-off-glibc` is a cycles result for that request under glibc on this host. It does not by
itself say what the callgrind instruction difference is: its instructions:u change is reported
beside it, and the PR's Choice 70 keeps the glibc counts explicitly unresolved unless this run
measures otherwise.

## Failures, decided now

A failed check stops the run before anything is recorded. A workload whose `run-pair.sh` fails (a
failed request, a counter under 100% or unusable, an answer other than declared, a `new` page not
kept) or whose summary fails is printed as `FAILED <workload>: ...` and is not a result; the other
workloads still run, and their summaries are diagnostic data only. The run then ends `INCOMPLETE`
(results/status.txt), exits nonzero, and run.out ends `EXIT <status>` and `ALL-DONE`. Only `COMPLETE`
with `EXIT 0`, after all three summaries, is a complete receipt. A run stopped by a failure or an
unusable counter is reported as such, not as a result.

## Time

Local dry runs (2026-11-22, a `debian:trixie` container on the workstation through `/root/start.sh`,
rustc 1.100.0, the kit's own builds, no perf, `PERF=0 PAIRS=2 TURN=2`; not a measurement):

- The first stopped in the checks on `new`: thread 1's `n=1` was not kept. wrk calls `request()` once
  on its first thread to check the script and never sends it, so thread 1's first URL sent is
  `n=2`; every other URL probed after a turn was kept. The check now asks for `n=2` and the late URL.
  An earlier attempt never left the checks: 1938's `run-pair.sh`, which this kit copied, uses `i`
  both in `ready()` and as the warm-up loop's counter, and `ready()` sets it to 0 and leaves it at
  the number of failed probes. When the second server of a warm-up pair answers its first probe,
  the counter is back at 1 after the pair and the warm-up pair runs again, without end while that
  keeps happening, as it did in the container. This kit gives each its own variable and fails a
  CSV that still holds warm-up rows. Kit 1938 has the same code: there it can only add unrecorded
  warm-up pairs (its recorded loop counts with `pair`, and its CSV is rewritten after the
  warm-up), or keep its run from reaching the recorded pairs at all.
- The last: setup and both builds in about 3 minutes (the two builds at once, 115 s); every
  answer check passed as declared (store-off writes `200`, 5 bytes, `home after: none kept`;
  `new` `200`, 371 bytes, `again: kept`, `home after: kept`); every server reported the declared
  allocator; no request failed; every `new` turn kept its `n=2` and late URLs (about 17,000 new
  URLs a thread in a 2 s turn); each workload took about 13 s for one warm-up and two pairs; each
  summary refused the counter-less CSV, so the run printed three `FAILED` lines, `INCOMPLETE`,
  `EXIT 1` and `ALL-DONE`, as declared above.

Estimated for a c-8 with 3 s turns: about 6.9 s a pair (kit 1923's c-8 run of the same protocol
took 11 min 38 s for one warm-up and 100 pairs), so about 11.6 minutes a workload and 35 minutes
for the three, plus the checks (about 1 minute) and setup with both builds (estimated 4 to 6
minutes): about 40 to 42 minutes in all. `run-pair.sh` prints its own estimate after each
workload's warm-up pair (run-<w>.log).
