# Margin, declared before the run (2026-11-22, declared again; not yet run) -- THIRD RUN

Third run, declared again on the head that merged `origin/main` `40aba72e1`: the PR's code as of
`3ed9d15f3` (`3438b72d1`, the merge, plus tests; the head below adds only Choice 70's text) against
`40aba72e1`, by `run-fresh.sh` as the second run (every recorded turn on a freshly started build),
workloads (a) to (g), 100 recorded pairs after one warm-up pair. **Margin, unchanged from the second
run and from the earlier declaration of this run, every workload: the one-sided 95% upper bound on
the median per-pair change in user+kernel cycles a request under +1%. A bound at or over +1% on any
of the seven workloads blocks the merge.** Not run yet.

<!-- commits --> Base `40aba72e1bc290a2d362688f7724d1ccf427b794`, head `8921810b6d3499a13625abb60399aa8b9f2985ec` (from commits.env; merge-base of the head with origin/main: `40aba72e1bc290a2d362688f7724d1ccf427b794`; origin/main at export: `dc24029c49dab1b44ee6584b38ac4d90b2d49b26`).

What changed from the earlier declaration (base `a0eeeacca`, head `dfd965334`, below), and why:

1. Base and head. Main moved past `a0eeeacca` (it hashes a kept page's URL once, #1866, which
   changes the lookup on the kept hit, and takes `bytes` 1.12.2), and the review of round 5 found
   the old pair could not clear the build that would merge: in a change whose question is the
   binary's layout, the pair measured must be the one merged. The branch merged `40aba72e1`
   (`origin/main` when it was fetched) and both trees are that main and that merge. The earlier
   runs' results stay in `results-b1` and `results-b5`, for their own inputs. `origin/main` has
   since moved to `dc24029c4` (14 commits: a `2xx` to `CONNECT` loses its framing headers in
   `router.rs`, a branch no workload here takes, plus tests, bench scripts and docs); the pair is
   not moved again for that. If the branch merges a later main before the run, both commits
   change in `commits.env` and this is declared again.
2. A seventh workload, (g) `fallback`, below: none of the six measured a `Public` answer whose
   header the serving thread does not hold, where the head looks through its four held headers
   and then reads the line as main does.
3. A diagnostic pass after the main pass (`run-icache.sh`): user first-level instruction-cache
   misses, which the second run did not count and which the explanation of its misses turns on.
   It is not a gate (below). The main pass's three counters are unchanged and unmultiplexed.
4. The time (below): about 95 minutes, against about 70 for the second run.

Method, builds, page and the answers' check: as the first run's note below says, with every turn on
a fresh start (`run-pair-fresh.sh`), and the trees and probes from `commits.env`.

Workloads (a) to (f): as the first run's note below and the earlier declaration describe them.

(g) `fallback`: `/page` in the default app, kept as in (c) (asked twice before the port opens),
then `/r/0` to `/r/3` asked once each, four other policies whose headers the thread makes after
the page's, so the head's thread holds those four and not the page's. Every request is given the
kept page, and the head's `settle` looks through the four held headers, finds none is the line,
and reads it as main does. The probe checks the four answers' headers (`EVICT ok` in its log, or it
exits) and logs the kept page's answer after them (`WARM`); `run-fresh.sh` requires an `EVICT ok`
for every start of both builds and `check-warm.sh` the page kept in both (`same:-`). The answers
are compared on `checks-fallback.txt` (`/page`) after `mask.sed`. It has the same margin as the
six.

For reference, not as criteria: under callgrind (valgrind 3.19.0, rustc 1.99.1, jemalloc, the probe
on one keep-alive connection, (count at 2,200 requests less 200) / 2,000, the mean of four starts
that each moved the stack, the median of three rounds in turned order; `D:\Temp\i1825-measure\r6`),
`3438b72d1` against `40aba72e1`, instructions a request: (a) `private` 40,198.3 against 40,187.2
(by function every count main's but 2 fewer in `memcpy`); (b) `off` 42,277.0 against 43,353.3
(-2.48%); (c) `hit` 24,187.3 against 24,921.1 (-2.94%); (d) `staged` 43,993.6 against 46,380.3
(-5.15%); (e) `unstaged` 13,540.4 against 13,529.0 (by function every count main's but the
guard's 3); (f) `unstaged-one` 13,528.3 against 13,528.8; (g) `fallback` 24,930.5 against
24,918.3 (+12: `settle` 23 more, the look through the four). Simulated first-level
instruction-cache misses: (a) 1,657.5 against 1,654.0, (e) and (f) 1,029.5 against 1,005.1 and
1,004.1, (g) 1,611.8 against 1,593.8. These are not cycles.

Diagnostic pass, after the main pass and apart from it: `run-icache.sh` (by `run-pair-icache.sh`),
the same seven workloads, probes and binaries, **30 recorded pairs** each (no warm-up pair) of
**1 s turns**, the order turned every pair, every turn on a fresh start, `perf stat` of the server
counting `L1-icache-load-misses:u` and `instructions:u` only, each required at 100% running (a
turn that is not, a wrk error or a counter not counted stops the pass, not the main pass's
results). Before it, `run-icache.sh` checks perf counts the event at 100% beside
`instructions:u` on this host; if not, it writes `icache-unavailable.txt` with perf's output and
the pass is not run, which is reported as such: callgrind's simulated misses are not a substitute.
Reported per workload with `icache-summary.mjs`: each build's median misses and instructions a
request, the median per-pair change, its range and the per-pair changes. **A diagnostic, not a
gate**: it neither passes nor blocks the merge, and no cycle result is read from it.

Expected time: the main pass about 83 minutes (the second run's six workloads took 70.5 minutes,
10:23:05 to 11:33:36 on the c-8, a workload of 101 pairs on fresh starts 11.6 minutes and the
kept page's 12.6 with its warm-up's pause each start; (g) as (c)); the check with no recorded pairs
first about 1 minute; the diagnostic pass about 11 minutes (420 turns of about 1.45 s and the
kept pages' 120 starts' pause): **about 95 minutes**, besides building (two builds, about 4
minutes). That is about 5 minutes over the 90 asked for: the seventh workload at 100 pairs alone
takes the main pass to 83. The pair count and turn length of the gate are left as declared rather
than cut to fit.

Expected by design: base and head answer every workload the same after `mask.sed` (no
`expect-*.diff`).

## The earlier declaration of this run (base `a0eeeacca`, head `dfd965334`), superseded by the above

Third run: the head that leaves the page for one visitor's and an unstaged route's code as main's
(`050ac7ee3`, `f5dd113d4`, formatted in `672f4db5a`; the head below adds only docs) against
`a0eeeacca`, by `run-fresh.sh` as the second run: every recorded turn on a freshly started build,
workloads (a) to (f), 100 recorded pairs after one warm-up pair. **Margin, unchanged from the second
run, every workload: the one-sided 95% upper bound on the median per-pair change in user+kernel cycles
a request under +1%. A bound at or over +1% on any workload blocks the merge.** Nothing below changes
that margin; the first run's note follows unchanged for the method, the builds, the page and the
workloads, and where it describes what the head does, the paragraph next replaces it.

The second run (`7dd30d739` against `a0eeeacca`, `results-b5`) missed on (a) `private` (bound
+1.27%) and (e) `unstaged` (bound +1.01%). Under callgrind (`D:\Temp\i1825-measure\r5`) the head
measured here runs main's instructions on both: (a) every function main's count but 2 in `memcpy`
(40,191.2 against 40,190.1); (e) and (f) every function main's count but the guard's 3 in
`route::laned` (13,533.6 against 13,534.3, 13,528.5 against 13,528.6). What the head changes now:
`cache::settle` skips its scan of `Cache-Control` when the line is the only one and its bytes are a
header the thread holds (the thread's last four `public` headers, made once each for a set of
numbers and shared after); it looks for the cache mark where main does, after the header, and the
mark is main's (16 bytes, no header held). While a thread runs an unstaged route's handler, `Cache`
makes the header in main's code and the thread holds none. Under callgrind against `a0eeeacca`:
(b) `off` 42,284.6 against 43,351.4 instructions a request (-2.46%), (c) `hit` 24,153.7 against
24,882.5 (-2.93%), (d) `staged` 43,995.5 against 46,367.8 (-5.12%), for reference, not as criteria.

Its commits line read: base `a0eeeaccad093672547ff38bdad19426054b6f31`, head `dfd96533497684f22351faf19a7dfc14a87df879`; origin/main at that export `14471284cce457e088dd4ded84ebcfd589785611`.

Expected time: six workloads of 101 pairs on fresh starts, as the second run (about 70 minutes on
the c-8, besides building).

The first run's note, unchanged:
Corten-run/corten#1865, "Send a Public answer's Cache-Control without reading it again or making it
per answer" (issue #1825). Base and head are set in `commits.env` (one place) and exported by
`export-src.ps1`, which fills the line above: the base is the merge-base of the head with
`origin/main` (`e7e89add8`, which was `origin/main` itself when this was prepared), the head the PR's
head (branch `codex/i1825`). If the PR merges a later main before it is measured, both change there.

What the PR changes: `cache::settle` skips its scan of `Cache-Control` while the line is still the
one `Cache` wrote (known by the address of its bytes, which the cache mark now holds), and a
`Public` header is made once per set of numbers on a thread and shared after, while it is one of the
last four that thread made (a fifth puts out the oldest, made again when asked for).

Method (corten-run/corten#1822's, `run-pair.sh`): both builds started once per workload and pinned to
CPU 2, whose core has no other work; loaded in turn for 3 s each by `wrk -t2 -c64` on CPUs 4 and 5;
the order of the two turned every pair; `perf stat` cycles:u, cycles:k and instructions:u of the
server process over each turn (no multiplexing; a multiplexed turn, a wrk error or a non-numeric
counter stops the run), divided by the requests wrk saw answered. One unrecorded warm-up pair, then
**100 recorded pairs** per workload, fixed now. That is fewer than the earlier sets' 140: this PR
runs on one host in one batch with #1846 and #1866, fifteen workloads in all, and 100 for every
workload of the three (reduced evenly) fits the batch in about 3 hours (below). With 100 pairs the
one-sided 95% upper bound on the median is the 59th smallest of the 100 per-pair changes
(`summary.mjs`; 140 pairs used the 81st).

Builds: the probe in `probe-{base,head}` (one program, `src/main.rs`, the same in both; only the
package, bin name and path to `corten` differ), depending on `corten-run` by path to
`src-{base,head}/crates/corten` with the features `corten new`'s template asks for (the defaults
and `compress`), the tree's `Cargo.lock`, and the repository's release profile (opt-level 3, thin
LTO, one codegen unit), built on the measuring host by `build-2.sh` with rustup stable, zstd linked
to the system's libzstd (`ZSTD_SYS_USE_PKG_CONFIG=1`) as the template's Dockerfile builds an app.
The server runs on **jemalloc**, preloaded as that Dockerfile runs an app
(`LD_PRELOAD=libjemalloc.so.2`, `MALLOC_CONF=background_thread:true,tcache_max:65536`; Debian's
libjemalloc2). Neither the template's Cargo.toml nor `corten-run`'s features select an allocator;
jemalloc is the template image's. The probe refuses to start unless `/proc/self/maps` shows it
(`PROBE_ALLOCATOR=jemalloc`). glibc's allocator is not measured. A current-thread tokio runtime, so
every request is answered on one thread and one thread's held headers serve them all.

Before the first turn the two builds' answers (status, headers but Date, body) are compared for each
workload, after `mask.sed` (a kept copy's `Age`; the `ETag`, keyed per process by `cache.rs`'s
`TAG_KEY`); anything else that differs stops the run. No request asks for a coding (wrk and the
checks send no `Accept-Encoding`), so no answer is compressed.

The page: the record page of 6,124 bytes of HTML the #1846 and #1866 probes serve (measured on
`04c209fca`, whose crates `e7e89add8` has unchanged).

Workloads:
1. (a) `private`: `/private`, the page for one visitor (not `Public`, `private, no-cache`), in the
   default app. The control: the PR moves the lookup of the cache mark ahead of the scan for every
   answer (the PR's callgrind: +12 instructions with glibc, +3 with jemalloc, in process).
2. (b) `off`: `/page`, the page `Public` for a day, in an app with `kept_answers(0)`: one policy, so
   the head makes its header once and shares it, and skips the scan.
3. (c) `hit`: `/page` in the default app, kept: the probe asks for it twice before its port opens
   (`check-warm.sh` checks it was kept), and every request is given the kept page.
4. (d) `staged`: a staged route (`/r/{n}`, the same page) in an app with `kept_answers(0)` and one
   middleware of the app's own (`RequestId`, which adds `x-request-id` after the handler and leaves
   `Cache-Control` alone, so the line still stands as written), with five policies in turn, one per
   request: `max-age` 2,592,000 to 2,592,004, `s-maxage=2592000`, `stale-while-revalidate=1036800`,
   `stale-if-error=604800`, each header 96 bytes (the PR's `rotating` case). Nothing is kept, so the
   handler runs each time, and since a thread holds four headers and the five come in strict turn,
   the head makes every header again: its miss path, on every request.
5. (e) `unstaged`: the same five policies in turn on a route that says `unstaged` (`/u/{n}`): no
   stage, no middleware and no `cache::settle`, so the head's skip of the scan saves nothing there
   and what is left is its miss path (the four held headers looked through, the header made with
   its count in one allocation, a clone held by the thread and one by the cache mark) against the
   base's header made from a `Vec`. Its answer is a short JSON figure as `text/plain` (84 bytes):
   an unstaged route is for data, and the short answer makes any cost of the header a larger share
   of the request. The app keeps none, as in (d); an unstaged route is never kept anyway.

How the five policies are asked for, in (d) and (e): `/r/0` to `/r/4` (and `/u/0` to `/u/4`) answer
policy 0 to 4, and are what the answers are compared on. The load asks `/r/5` (`/u/5`), which the
same handler answers with the next policy in turn by a counter of the process (0, 1, 2, 3, 4, 0, ...),
so the server's thread sees them in strict turn whatever order the connections arrive in. A counter
in the wrk script (one URL per policy) was considered and not used: wrk's two threads keep a
counter each, their requests interleave at the server, and a policy asked twice running, or among
the last four made, would be held, so the head would take its miss path on an unknown share of
requests, different from turn to turn. The counter costs both builds the same. Before its port
opens, each staged or unstaged probe asks `.../5` ten times on a listener of its own and checks the
ten headers are the five policies in turn, twice, or exits; `run.sh` requires its `ROTATION ok` line
in both builds' logs.

Margin, declared now:
1. (a) `private` and (e) `unstaged`: **cycles are not worse**: the one-sided 95% upper bound on the
   median per-pair change in user+kernel cycles per request is under +1%.
2. (b) `off`, (c) `hit` and (d) `staged`: no margin; the median per-pair change, its one-sided 95%
   upper bound and the range, in user+kernel cycles and in instructions:u, are reported as measured.
   For reference, not as a criterion, the PR's callgrind counts in process with jemalloc (Choice 70,
   `9cfb17038` against `e7e89add8`): `Public` with `kept_answers(0)` 36,856 to 36,107 instructions a
   request (-2.0%), kept 34,211 to 33,710 (-1.5%), five 96-byte policies in turn 40,152 to 38,050
   (-5.2%). Cycles per request on a server include hyper, the socket and the kernel, which the PR
   does not change, so its share of them is expected smaller.

Expected by design: base and head answer every workload the same after `mask.sed` (no `expect-*.diff`).

Expected time for this PR: five workloads of 101 pairs (one warm-up) at about 11.5 minutes each
(6.85 s a pair, as the earlier droplet measured: 141 pairs in about 16.1 minutes), and three check
starts of a few seconds: about 58 minutes. The batch (#1846 about 49 minutes, #1866 about 73, #1865 about 58): about 3 hours, besides building
(six builds, about 4 minutes) and the 0-pair check (about 4).