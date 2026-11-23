# Margin, declared before the run (2026-11-22; not yet run): #1865, kit 1865v3

[#1865 Send a Public answer's Cache-Control without reading it again or making it per answer](https://github.com/corten-run/corten/pull/1865),
declared again for its round 7 review, in place of the run declared in kit 1865v2 (base `7e9a0c715`,
head `d5a9691c0`), which was stopped before its main pass: main had since merged
[#1962 Reserve a text or bytes answer's header map once](https://github.com/corten-run/corten/pull/1962),
which changes the text and `Media` answers and the compression stage these workloads take. That
declaration is kept in the workstation kit's `history/margin-1865v2.md` (not packed) and no result
of that run is evidence; the third run's declaration stays in `history/margin-run3.md`.

<!-- commits --> Base `fef1f83de307e618dbd996c567eb616e9c2da650`, head `7d7225f63673a981590c1920e105c6da269653b2` (from commits.env; merge-base of the head with origin/main: `fef1f83de307e618dbd996c567eb616e9c2da650`; origin/main at export: `52b25c556499a9c4f537577aa3fcb6df175dd073`).

**Gate, every one of the nine workloads below: the one-sided 95% upper bound on the median per-pair
change in user+kernel cycles a request, the 59th smallest of the 100 sorted per-pair changes, is
under +1%. A bound at or over +1% on any of the nine blocks the merge.** "Under" is strict and
exact: `gate.mjs` compares (head cycles x base requests) x 100 with (base cycles x head requests)
x 101 as integers, so a bound of exactly +1% is not under it. No workload is named a negative
control, so no floor applies: Choice 71's recorded floor is for `plain` on the #1829 probe app and
its setup, and this run declares no same-run A/A control. The bound is computed only by
`1865/gate.mjs` from complete, consistent evidence (below); if the evidence is incomplete or
inconsistent, no bound is read and the run is reported as not having passed.

## The pair

Base `fef1f83de`: the `origin/main` the branch merged in `83819376a` (that merge's main parent),
the merge-base of the head with `origin/main`. Head: the branch head named on the commits line,
whose `crates`, `examples`, `Cargo.toml`, `Cargo.lock` and `.cargo` are the merge `83819376a`'s
(the commits after it change only `docs/design.md` and the changelog; the exported trees of the
two are byte-identical in those paths). `origin/main` at export, `52b25c556`, differs from the base
only in benchmark scripts, their tests and a changelog note, outside those paths, so the base tree is current main's. If main changes those paths before the run, the branch
merges it, both commits change in `commits.env`, the trees and locks are made again, and this is
declared again. This measures the build that would merge, not an older pair.

What the head changes against this base, by what each workload takes:
1. `cache::settle` skips its read of `Cache-Control` when the line is one line whose bytes are a
   header the thread holds (the thread's last four `public` headers, made once each for a set of
   numbers and shared after). A line it does not hold is read as main reads it, after a look
   through the four.
2. `Cache::value` gives a `public` header held by the thread on a staged answer, the header made in
   main's code on an unstaged one, and `no-store`'s and `immutable`'s constants without reading
   the thread's flag.
3. `ascii::digits_inlined` (`inline(always)`) for the two `Cache-Control` writers; `ascii::digits`,
   the JSON writer's, is main's `#[inline]` around the same body. Card-market's 83
   `corten::json` functions disassemble to the same 37,540 instructions in both builds of this
   pair (below), so the catalog's item JSON route is not a workload here.

## Builds

Each probe (`probe-{base,head}`, one program, `src/main.rs` the same in both; only the package, the
bin name and the path to `corten` differ) depends on `corten-run` by path to its tree with the
template's features (defaults and `compress`). Its `Cargo.lock` is the tree's with the probe's own
package added and what the probe does not use dropped (`lock.sh`), checked by `lock-check.mjs`: 66
packages each, the 63 from a registry every one the workspace lock's version, source and checksum,
the 3 by path the tree's crates and the probe, and the two locks select the same packages apart
from the probe's own name. The declared locks (the same bytes as 1865v2's: main's workspace lock
did not change):

| lock | sha256 |
| --- | --- |
| `probe-base/Cargo.lock` | `8982e9c28ae98bc0e73793dbd51a6bae0ec78d2eab8b3d9742de6e0879e6bc55` |
| `probe-head/Cargo.lock` | `a63367b580630065d1c1199ae03379bf81c68d62cb883b555c8f3befade2e570` |
| `src-base/Cargo.lock` and `src-head/Cargo.lock` (the workspace's, the same in both) | `b58ea4c54663d596065b4d6b7de199677a1f73499ab2ba4193450170d39420a1` |

`build.sh` refuses a probe lock whose hash is not in `locks.sha256`, builds each with
`cargo build --release --locked` (the repository's release profile: opt-level 3, thin LTO, one
codegen unit; rustc 1.100.0; zstd linked to the system's libzstd), checks the locks again after
building, writes `results/build.txt` (each commit, lock hash and binary hash) and copies the four
locks into `results/locks/`. The server runs on jemalloc, preloaded as the template's Dockerfile runs
an app (`LD_PRELOAD=libjemalloc.so.2`, `MALLOC_CONF=background_thread:true,tcache_max:65536`), and the
probe refuses to start on another allocator. A current-thread runtime, so one thread answers every
request and its held headers serve them all.

## Method and settings

`run-all.sh`, with nothing else on the host, fixes the settings and refuses to start if `PAIRS`,
`TURN`, `WARMUP` or `ICACHE_PAIRS` is set in its environment. Server on CPU 2, `wrk -t2 -c64` on CPUs
4 and 5, the driver and `perf` on CPU 7.
1. Check: every workload's two builds answered (status, headers but `Date`, body after `mask.sed`:
   a kept copy's `Age`, the per-process `ETag`), and every warm-up, rotation, eviction and constant
   checked, with no pair turned. Each fetch must succeed (curl's own exit status 0, headers and
   body written to files, no pipe) and its body must have the bytes of its one `Content-Length`;
   any nonzero `cmp` or `diff` exit fails the check, and a workload with no request to check
   fails. A failure stops the run before any pair (exit 1).
2. Main pass (`run-fresh.sh` by `run-pair-fresh.sh`): per workload the same answer check on the
   first start of each build, one warm-up pair not recorded, then **100 recorded pairs of 3 s
   turns**, every turn on a freshly started build, the builds' order turned every pair (odd pairs
   base first, even pairs head first), `perf stat` of the server counting `cycles:u`, `cycles:k`
   and `instructions:u` only, each required at 100% running, divided by the requests `wrk` saw
   answered. A turn with a `wrk` error, an unusable or multiplexed counter stops the pass, and
   `run-all.sh` then exits 1.
3. Diagnostic pass (below), only after the main pass completed.
`results/status.txt` records the settings and each step's outcome.

**The gate's evidence** (`gate.mjs`):
1. `status.txt`: the declared settings line, `check ok`, `main ok`, then at most one diagnostic
   outcome and `done`, each once and in that order, and no other line. A pass recorded both ok and
   FAILED, or twice, gives no gate.
2. For each of the nine workloads, `cycles-<w>.csv` with exactly pairs 1 to 100, one base and one
   head row each, in the declared turn order, and positive integer requests and counters.
3. `raw-<w>.log` with exactly the declared turns in the declared order (the warm-up pair base then
   head, then the 100), each with exactly one perf reading of each of the three counters, at 100%
   running, and exactly one `wrk` RESULT with no error; every CSV counter and request count must be
   exactly its turn's raw reading.
4. `answers-<w>/verdict.txt` saying `checked <n> requests: same` and `answers-<w>/checks.txt`
   holding n requests, n the workload's declared count: 5 for `staged` and `unstaged`, 1 for the
   other seven.
Then for each workload the per-pair change (head / base - 1) in (`cycles:u` + `cycles:k`) /
requests, sorted by exact cross-products, and its 59th: `gate.mjs` exits 0 when all nine are under
+1% (exact, as above), 1 when any is not, and 2 when the evidence is incomplete or inconsistent (no
gate). It also reports the median, the range and the user-instruction changes (rounded, for
reading), and the diagnostic pass's outcome.

## Workloads

As 1865v2 declared them, (a) to (i), each with its declared count of checked requests:
1. (a) `private`: `/private`, the record page for one visitor (6,124 bytes, `private, no-cache`); 1.
2. (b) `off`: `/page`, the page `Public` for a day in an app with `kept_answers(0)`; 1.
3. (c) `hit`: `/page` in the default app, kept (asked twice before the port opens; `WARM` checked
   for every start, and kept in both builds by `check-warm.sh`); 1.
4. (d) `staged`: `/r/5`, five policies in turn on a staged route behind a middleware of the app's
   own (`RequestId`), nothing kept (`ROTATION ok` required for every start); 5 (`/r/0` to `/r/4`).
5. (e) `unstaged`: `/u/5`, the same five on an unstaged route, an 84-byte answer; 5 (`/u/0` to
   `/u/4`).
6. (f) `unstaged-one`: `/u/0`, the unstaged route with one policy; 1.
7. (g) `fallback`: `/page` kept as in (c), then `/r/0` to `/r/3` asked once each, so the head's
   thread holds four other headers and reads the page's as main does (`EVICT ok` for every start);
   1.
8. (h) `nostore`: `/n`, an 84-byte text answer in `NoStore` on a staged route in (d)'s app, after
   `/r/0` to `/r/3` were asked once each before the port opened, so the head's thread holds four
   headers: every answer's `no-store` is a constant, and the head's `settle` looks through the four
   before reading it as main does. `EVICT ok` and `CONSTANT ok` required for every start; 1.
9. (i) `immutable`: `/i`, a 94-byte SVG given `Public::immutable` (`public, max-age=31536000,
   immutable`), the same way; 1.
No request asks for a coding; no answer is compressed. Both builds must answer every workload the
same after `mask.sed` (no allowed difference; `EXPECT` is refused).

## Diagnostic pass, not a gate

`run-icache.sh` (by `run-pair-icache.sh`): the same nine workloads, probes and binaries, **30
recorded pairs** each (no warm-up pair) of **1 s turns**, the order turned every pair, every turn on a
fresh start, `perf stat` counting `L1-icache-load-misses:u` and `instructions:u` only, each at 100%.
It first checks that perf counts the event at 100% on this host; if not, it writes
`icache-unavailable.txt` and the pass is reported as not measured (callgrind's simulated misses are
not a substitute). Its failure is recorded (`diagnostic FAILED`) and does not change the main pass's
results or `run-all.sh`'s exit. It neither passes nor blocks the merge.

## For reference, not as criteria

Under callgrind (valgrind 3.19.0, the probes built from these trees with `build.sh`, rustc 1.100.0,
jemalloc, one keep-alive connection, (count at 2,200 requests less 200) / 2,000, the mean of four
starts that each moved the stack; workstation scratch `i1825-measure/r8`), `83819376a`'s code (the
head's) against `fef1f83de`, instructions a request: (h) `nostore` 20,355.5 against 20,333.0 (three
rounds; by function `settle` 551 against 516, the look through the four, `Cache::apply` +1, the
extensions' map -21, which hashes type ids that differ between builds); (i) `immutable` 22,128.1
against 22,123.2 (three rounds; `settle` 1,271 against 1,247); once each: (a) 40,071.4 against
40,090.7, (b) 42,179.4 against 43,249.7 (-2.47%), (c) 23,716.9 against 24,470.3 (-3.08%), (d)
43,862.1 against 46,280.7 (-5.23%), (e) 13,665.5 against 13,668.3, (f) 13,663.4 against 13,658.3,
(g) 24,442.9 against 24,452.5. These are not cycles. Card-market's 83 `corten::json` functions
disassemble to the same 37,540 instructions in release builds of both trees.

## Expected time

Main pass about 107 minutes, estimated as 1865v2's was: the second run's workloads took 11.6
minutes for 101 pairs on fresh starts and the kept page's 12.6 (its warm-up's pause each start), so
(a), (b), (d), (e), (f) about 58, (c) and (g) about 25, (h) and (i) about 24; the check about 1; the diagnostic pass about 14 (540 turns of
about 1.45 s and the kept pages' pauses): **about 122 minutes**, besides setup and the two builds
(about 10). The pair count and turn length of the gate are not cut to fit.