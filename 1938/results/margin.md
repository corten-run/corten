# Margin for #1938's cycles, declared before the run (2026-11-22, prepared; not yet run)

<!-- commits --> Base `83b3b8772b7dbfd93ed55425022d4e101e16e644`, head `84de7c1e5185401ff27bd53f104bdfffb4b14b55` (from commits.env; merge-base of the head with origin/main: `83b3b8772b7dbfd93ed55425022d4e101e16e644`; origin/main at export: `83b3b8772b7dbfd93ed55425022d4e101e16e644`).

corten-run/corten#1938, "Let a handler or a task drop the pages the app keeps for a change it made"
(issue #1795). It adds `KeptAnswers`: a handler that takes it runs one more extractor (it clones a
reference to the app's store, or finds none, and allocates nothing), and its `changed(&route)`
writes the route's link, hashes its path and adds to that path's write count. Its first review asks
for user plus kernel cycles per request under load on the request path that changed, the write
that opts in, beside the instruction counts, and for the requests that do not opt in to be shown
unchanged (CONTRIBUTING.md, Pull requests item 2).

Callgrind, in process with `oneshot` (crates/corten/tests/router_cost.rs, `ROUTER_NAMED`), gives
the expectation for `instructions:u`; the instruction table is in the PR description. It is not a
bound on cycles.

## Workloads

One probe program (probe-*/src/main.rs), built against base and head, served by `corten::serve`
(HOST=127.0.0.1, a fixed PORT) on a current-thread runtime with the template's features (defaults
and `compress`), jemalloc preloaded as the template's Dockerfile runs an app, the repository's
release profile (opt-level 3, thin LTO, one codegen unit), rustc 1.100.0, both built on the host
from the exported trees with each tree's Cargo.lock. Routes: a `Public` page at `/home`, a write at
`/items/7/edit` (head: its handler takes `KeptAnswers` and calls `changed(&url::Home)`; base, which
has no `KeptAnswers`, the same handler taking nothing), a write at `/items/8/edit` that names
nothing, and a `GET` on both. Every turn starts the build fresh; with the store on, `/home` is asked
for three times first (the third must carry `Age`), so the page is kept and the counts by path
exist before the load.

1. **named** (the path that changed): `POST /items/7/edit`, same-origin, store on.
2. **named-off**: the same write in the same app with `App::kept_answers(0)`: head's handler takes
   the handle and finds no store.
3. **write** (control): `POST /items/8/edit`, a write that names nothing, store on.
4. **kept** (control): `GET /home`, the kept page given again.
5. **plain** (control): `GET /items/8/edit`, a route that keeps nothing.

wrk -t2 -c64 on CPUs 4-5 for **3 s** a turn (lua/get.lua, lua/post-same-origin.lua, whose `done()`
prints the requests and every error count), fixed now.

## Method

`run-pair.sh`, run by `run.sh` under `taskset -c 7`: every turn on a freshly started build, pinned
to CPU 2, warmed, loaded, and stopped. The order turns every pair (base first in odd pairs). perf
stat counts the server process alone for exactly as long as wrk runs: `cycles:u`, `cycles:k`,
`instructions:u`, task-clock (software, for how busy the server was), and
`L1-icache-load-misses:u` as a diagnostic only when a preflight counts it beside the other three at
100% (host.txt says which). Every hardware counter must report 100% running in every turn, and
every request must succeed: any connect, read, write or timeout error, or a status wrk counts as
an error, stops the run after the turn's row; failures are counted in the CSV and reported. Cycles
per request = (cycles:u + cycles:k) / requests wrk completed in the turn.

Before the first turn each build answers the workload's request on fresh starts (base twice): the
status line, the headers but Date (Age's value masked), the body's length and sha256, then whether
`/home` is still kept. The two base answers must be the same, and head's the same as base's,
except in **named**, where by design base's write leaves `/home` kept and head's drops it (the
transcript's last line, and nothing else, differs). Then `run.sh` runs every workload once with no
recorded pair (check-only/, one unrecorded pair each) and stops if any fails.

One unrecorded warm-up pair, then **100 recorded pairs** a workload, fixed now. With 100 pairs the
one-sided 95% upper bound on the median per-pair change is the 59th smallest of the 100 changes
(`summary.mjs`, distribution-free).

Host: a new quiet dedicated-CPU droplet (c-8, debian-13-x64, root), set up by `setup.sh` and built
by `build.sh` there; nothing else run or logged into while it runs.

## Margin

No win is claimed or sought: the change adds work to the write that opts in, and none to the
others.

**named** and **named-off** pass when the one-sided 95% upper bound on the median per-pair change
in user+kernel cycles per request (the 59th of the 100 sorted changes) is under **+1%**: what a
write pays for naming a page is under 1% of what the write costs.

**write**, **kept** and **plain** (controls) pass on the same bound, under **+1%**: the requests
that do not name a page are not shown slower by more than that.

**Otherwise inconclusive**: reported as measured (median, bound, best and range, user and kernel
split, instructions:u, the icache diagnostic if counted, requests/s, server busy, failures), with
no performance claim either way, and what the run did not resolve. A control that misses the bound
while its instructions:u are flat is reported as that, beside the layout floor measured for
#1923, not explained away. No rerun or pooling is declared here. A run stopped by a failure or an
unusable counter is reported as such, not as a result.

## Time

Local dry run (2026-11-22, a Debian 13 container on the workstation, rustc 1.100.0, the kit's own
builds, no perf, `PERF=0 PAIRS=2 TURN=2`): every workload's answer check passed as declared
above, no request failed, and a pair took about 5 s with 2 s turns. Estimated for the droplet with
3 s turns: about 7 s a pair, so 100 pairs and the warm-up take about 12 minutes a workload and
about 60 minutes for the five, plus the checks (a few minutes) and setup and building (about 10
to 15 minutes). `run-pair.sh` prints its own estimate after each workload's warm-up pair
(run-<w>.log).