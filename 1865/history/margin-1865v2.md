# Margin, declared before the run (2026-11-22; not yet run): #1865, kit 1865v2

[#1865 Send a Public answer's Cache-Control without reading it again or making it per answer](https://github.com/corten-run/corten/pull/1865),
declared again for its round 6 review, in place of the third run declared in `../1865/results/margin.md`
(base `40aba72e1`, head `8921810b6`), which never ran; that declaration is kept in the workstation kit's `history/margin-run3.md`
(not packed), and the earlier runs' results stay in `../1865/results-b1` and `../1865/results-b5` for their own inputs.

<!-- commits --> Base `7e9a0c715bf055374be5e160267e45f419be4b07`, head `d5a9691c0f28557aa88fe5eb023aa168e8d947df` (from commits.env; merge-base of the head with origin/main: `7e9a0c715bf055374be5e160267e45f419be4b07`; origin/main at export: `a138e239158e3b9ef1f3cded5b6031d3cf23302a`).

**Gate, every one of the nine workloads below: the one-sided 95% upper bound on the median per-pair
change in user+kernel cycles a request, the 59th smallest of the 100 sorted per-pair changes, is
under +1%. A bound at or over +1% on any of the nine blocks the merge.** No workload is named a
negative control, so no floor applies: Choice 71's recorded floor is for `plain` on the #1829 probe
app and its setup, and this run declares no same-run A/A control. The bound is computed only by
`1865/gate.mjs` from complete evidence (below); if the evidence is incomplete, no bound is read and
the run is reported as not having passed.

## The pair

Base `7e9a0c715`: the `origin/main` the branch merged (`ad3bc0f79`), the merge-base of the head with
`origin/main`. Head `d5a9691c0`: the branch head, whose code is `e37a8b260`'s (`d5a9691c0` changes only
`docs/design.md` and the changelog; the exported trees of the two are byte-identical in `crates`,
`examples`, `Cargo.toml`, `Cargo.lock` and `.cargo`). `origin/main` at export was `a138e2391`, which
differs from `7e9a0c715` only outside those paths (CI and bench scripts), so the base tree is
current main's. If main changes those paths before the run, the branch merges it, both commits
change in `commits.env`, the trees and locks are made again, and this is declared again. This
measures the build that would merge, not an older pair.

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
   `corten::json` functions disassemble to the same 37,540 instructions in both builds (below),
   so the catalog's item JSON route is not a workload here.

## Builds (finding 2 of round 6)

Each probe (`probe-{base,head}`, one program, `src/main.rs` the same in both; only the package, the
bin name and the path to `corten` differ) depends on `corten-run` by path to its tree with the
template's features (defaults and `compress`). Its `Cargo.lock` is the tree's with the probe's own
package added and what the probe does not use dropped (`lock.sh`, by `cargo metadata`, which keeps
every version the lock selects), checked by `lock-check.mjs`: 66 packages each, the 63 from a
registry every one the workspace lock's version, source and checksum, the 3 by path the tree's
crates and the probe, and the two locks select the same packages apart from the probe's own name.
Cargo then accepts each lock as it is (`--locked --offline`). The declared locks:

| lock | sha256 |
| --- | --- |
| `probe-base/Cargo.lock` | `8982e9c28ae98bc0e73793dbd51a6bae0ec78d2eab8b3d9742de6e0879e6bc55` |
| `probe-head/Cargo.lock` | `a63367b580630065d1c1199ae03379bf81c68d62cb883b555c8f3befade2e570` |
| `src-base/Cargo.lock` and `src-head/Cargo.lock` (the workspace's, the same in both) | `b58ea4c54663d596065b4d6b7de199677a1f73499ab2ba4193450170d39420a1` |

`build.sh` refuses a probe lock whose hash is not in `locks.sha256` (these two), builds each with
`cargo build --release --locked` (the repository's release profile: opt-level 3, thin LTO, one
codegen unit; rustc 1.100.0; zstd linked to the system's libzstd), checks the locks again after
building, and writes `results/build.txt` (each commit, lock hash and binary hash) and copies the four
locks into `results/locks/`. The server runs on jemalloc, preloaded as the template's Dockerfile runs
an app (`LD_PRELOAD=libjemalloc.so.2`, `MALLOC_CONF=background_thread:true,tcache_max:65536`), and the
probe refuses to start on another allocator. A current-thread runtime, so one thread answers every
request and its held headers serve them all.

## Method and settings (finding 4 of round 6)

`run-all.sh`, with nothing else on the host, fixes the settings and refuses to start if `PAIRS`,
`TURN`, `WARMUP` or `ICACHE_PAIRS` is set in its environment. Server on CPU 2, `wrk -t2 -c64` on CPUs
4 and 5, the driver and `perf` on CPU 7.
1. Check: every workload's two builds answered (status, headers but `Date`, body after `mask.sed`:
   a kept copy's `Age`, the per-process `ETag`), and every warm-up, rotation, eviction and constant
   checked, with no pair turned. A failure stops the run before any pair (exit 1).
2. Main pass (`run-fresh.sh` by `run-pair-fresh.sh`): per workload one warm-up pair not recorded,
   then **100 recorded pairs of 3 s turns**, every turn on a freshly started build, the builds'
   order turned every pair, `perf stat` of the server counting `cycles:u`, `cycles:k` and
   `instructions:u` only, each required at 100% running, divided by the requests `wrk` saw
   answered. A turn with a `wrk` error, an unusable or multiplexed counter stops the pass, and
   `run-all.sh` then exits 1.
3. Diagnostic pass (below), only after the main pass completed.
`results/status.txt` records the settings and each step's outcome.

**The gate's evidence** (`gate.mjs`): `status.txt` with these settings, the check and the main
pass completed; for each of the nine workloads, `cycles-<w>.csv` with exactly pairs 1 to 100, one
base and one head row each and positive requests and counters; `raw-<w>.log` with exactly one turn
a build for the warm-up pair and each of the 100, each turn's three counters at 100% and its `wrk`
RESULT with the CSV's requests and no error; and `answers-<w>/verdict.txt` saying the builds
answered the same. Then for each workload the per-pair change (head / base - 1) in
(`cycles:u` + `cycles:k`) / requests, sorted, and its 59th: `gate.mjs` exits 0 when all nine are
under +1%, 1 when any is not, and 2 when the evidence is incomplete (no gate). It also reports the
median, the range and the user-instruction changes, and the diagnostic pass's outcome.

## Workloads

As the third run's declaration describes (a) to (g), with (h) and (i) new:
1. (a) `private`: `/private`, the record page for one visitor (6,124 bytes, `private, no-cache`).
2. (b) `off`: `/page`, the page `Public` for a day in an app with `kept_answers(0)`.
3. (c) `hit`: `/page` in the default app, kept (asked twice before the port opens; `WARM` checked
   for every start, and kept in both builds by `check-warm.sh`).
4. (d) `staged`: `/r/5`, five policies in turn on a staged route behind a middleware of the app's
   own (`RequestId`), nothing kept (`ROTATION ok` required for every start).
5. (e) `unstaged`: `/u/5`, the same five on an unstaged route, an 84-byte answer.
6. (f) `unstaged-one`: `/u/0`, the unstaged route with one policy.
7. (g) `fallback`: `/page` kept as in (c), then `/r/0` to `/r/3` asked once each, so the head's
   thread holds four other headers and reads the page's as main does (`EVICT ok` for every start).
8. (h) `nostore` (finding 5 of round 6): `/n`, an 84-byte text answer in `NoStore` on a staged route
   in (d)'s app, after `/r/0` to `/r/3` were asked once each before the port opened, so the head's
   thread holds four headers, as many as it holds: every answer's `no-store` is a constant, and the
   head's `settle` looks through the four before reading it as main does. `EVICT ok` and
   `CONSTANT ok` (`/n` answered `no-store` after the four) required for every start.
9. (i) `immutable`: `/i`, a 94-byte SVG given `Public::immutable` (`public, max-age=31536000,
   immutable`), the same way.
No request asks for a coding; no answer is compressed. Expected by design: both builds answer every
workload the same after `mask.sed` (no `EXPECT` file).

## Diagnostic pass, not a gate

`run-icache.sh` (by `run-pair-icache.sh`): the same nine workloads, probes and binaries, **30
recorded pairs** each (no warm-up pair) of **1 s turns**, the order turned every pair, every turn on a
fresh start, `perf stat` counting `L1-icache-load-misses:u` and `instructions:u` only, each at 100%.
It first checks that perf counts the event at 100% on this host; if not, it writes
`icache-unavailable.txt` and the pass is reported as not measured (callgrind's simulated misses are
not a substitute). Its failure is recorded (`diagnostic FAILED`) and does not change the main pass's
results or `run-all.sh`'s exit. It neither passes nor blocks the merge.

## For reference, not as criteria

Under callgrind (valgrind 3.19.0, these binaries, rustc 1.100.0, jemalloc, one keep-alive
connection, (count at 2,200 requests less 200) / 2,000, the mean of four starts that each moved the
stack; `D:\Temp\i1825-measure\r7`), `e37a8b260` against `7e9a0c715`, instructions a request: (h)
`nostore` 21,317.4 against 21,302.6 (three rounds; by function `settle` 551 against 516, the look
through the four, `Cache::apply` +1, the extensions' map -21, which hashes type ids that differ
between builds); (i) `immutable` 23,070.7 against 23,071.3 (three rounds; `settle` 1,271 against
1,247); once each: (a) 40,208.8 against 40,227.5, (b) 42,305.1 against 43,386.6 (-2.49%), (c)
23,852.1 against 24,601.1 (-3.04%), (d) 43,998.7 against 46,403.9 (-5.18%), (e) 13,551.9 against
13,544.8, (f) 13,550.0 against 13,552.9, (g) 24,590.4 against 24,594.2. These are not cycles.

## Expected time

Main pass about 107 minutes, estimated: the second run's workloads took 11.6 minutes for 101 pairs on
fresh starts and the kept page's 12.6 (its warm-up's pause each start), so (a), (b), (d), (e), (f)
about 58, (c) and (g) about 25, (h) and (i) about 24 (four requests and a check before each start);
the check about 1; the diagnostic pass about 14 (540 turns of about 1.45 s and the kept pages'
pauses): **about 122 minutes**, besides setup and the two builds (about 5). That is over the 95 of
the earlier declaration, by the two workloads review asked for; the pair count and turn length of
the gate are not cut to fit.
