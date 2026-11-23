# Margin for corten-run/corten#1824's run 1824f (fewer bytes held for each kept answer), declared before the run

Prepared 2026-11-23; not yet run. Main `04530f7e0934f56d7bd00024bc5631b9ebab9699` (origin/main
when the kit was made, the main parent of the branch's merge `679a219f7`; its `crates/` and lock
are `a02c81e86`'s); the candidate `d3bb2e0e4cdcf609cd41507a42493188af430610`
(the branch's head, unpushed; the kit builds it as main with
`variants/head.diff`, `git diff` of `crates/` from main to the candidate). The callgrind counts
below were made at `4e53ff290`, whose `crates/` differ from the candidate's in one test's layout
only. This follows the 1824e kit (main `a02c81e86` against `41f2d882f`, run 2026-11-23 on a c-8:
all four comparisons met, receipt `evidence/c0c9b924`): after it the candidate keeps no answer
whose head has more than 1,024 names and makes the hit's map without the `try_` forms, which
changes what the keep and hit paths run, so 1824e does not measure this candidate.

## Question

[#1824](https://github.com/corten-run/corten/issues/1824)'s last comments find that a page kept
with room costs extra kernel cycles for the new memory it holds, about 0.95 kernel cycles a
resident byte under jemalloc (the template image's allocator), and that about 1,700 of the 7,825
bytes a kept page held were not its body. The candidate holds a kept answer's head as a boxed
slice of its lines and a count of its names instead of a cloned `HeaderMap` (whose slots, index
and spare room it carried), rebuilds a map with room for those names and the stages' additions
when the answer is given again, writes `Cache-Control` at its own length instead of in a 96-byte buffer, starts a
URL's copy list at one, and keeps no answer whose head has more than 1,024 names. Answers are the
same bytes.

Measured locally before 1824e (not on the droplet), at `23a98a7e9` against `a02c81e86`: under
jemalloc, what one kept answer holds (`malloc_usable_size` of each allocation kept, from a
counting allocator). Not measured again: the fix after it adds no field to the entry and no
allocation to what is kept.

| answer | main | candidate | saved |
| --- | ---: | ---: | ---: |
| the record page, 6,124 bytes (`room`) | 7,648 | 7,112 | 536 |
| the JSON records, 1,999 bytes (`jroom`) | 3,232 | 2,824 | 408 |

Callgrind (valgrind 3.19.0, jemalloc, the probe's `cg` mode, instructions a request after 300
unmeasured, median of three rounds, `local/cg-rounds.txt`), `4e53ff290` against `04530f7e0`:
`room` 48,515 on main and 48,028 on the candidate (-487, -1.00%); `jroom` 53,452 and 53,016
(-436, -0.82%); `hit` 17,875 and 17,843 (-32, -0.18%); `plain` 33,876 and 33,876; `off` 37,326
and 37,264. In process at `23a98a7e9`, resident memory a request: `room` 7,812 to 7,814 and
7,267 to 7,269; `jroom` 3,384 and 2,971 to 2,972.

1824e measured the earlier candidate on a c-8 (Xeon Platinum 8280): bounds on user+kernel
cycles `room` -0.59%, `hit` -1.20%, `plain` -0.21%, `jroom` -0.38%; kernel cycles a request
`room` -508 and `jroom` -427, resident bytes -542 and -411.

**Expected here:** with room, fewer kernel cycles a request by about the bytes saved times 0.95:
**-509** on `room` (536 bytes) and **-388** on `jroom` (408 bytes), resident memory lower by about
those bytes a request, and user instructions lower by about 1%. On `hit` about 0.2% fewer instructions, and on `plain` no
change beyond noise.

## Builds and configurations

One probe program (`probe/`: the 1846r and 1824b kits' record page and the 1846r kit's
`/records` JSON), built twice on the host with rustc 1.100.0, the repository's release profile
and main's Cargo.lock: `main` and `head` (main with `variants/head.diff`). `build.sh` stops if
the diff does not apply, the lock differs, libzstd is not linked as main's is, or the two
binaries are the same.

Configurations: `room` (`kept_answers(8 GiB)`, so no turn fills the store; every request a new
URL of `/page`, `lua/new-url.lua`), `hit` (the default app, `/page` kept before the port opens;
`lua/get.lua`), `plain` (the default app, `/private`, the same page not `Public`), `jroom`
(`kept_answers(8 GiB)`, every request a new URL of `/records` asked for as JSON,
`lua/new-url-json.lua`). jemalloc as the template's image runs it (`LD_PRELOAD=libjemalloc.so.2`,
`MALLOC_CONF=background_thread:true,tcache_max:65536`); each side's serve log must show it and no
setting it refused.

## Comparisons (A main, then B the candidate), pairs fixed now

| name | what it is | judged | pairs |
| --- | --- | --- | ---: |
| room | a `Public` page asked for once, kept with room: the workload that motivates the cut | gated: strictly under +1%; also reported | 100 |
| hit | a kept page given again: runs the changed rebuild of its head | gated: strictly under +1% | 100 |
| plain | the same page, not `Public` | gated: strictly under +1% | 100 |
| jroom | a `Public` JSON body asked for once, kept with room | gated: strictly under +1%; also reported | 100 |

400 recorded pairs, each comparison after one unrecorded warm-up pair. `run.sh` fixes the pairs,
the warm-up, the 3 s turns, the comparisons and the counters, and refuses to start if `PAIRS`,
`JROOM_PAIRS`, `TURN`, `WARMUP`, `COMPARISONS` or `PERF` is set. The one-sided 95% upper bound
on a median per-pair change is the 59th of the 100 sorted changes (distribution-free, as
`summary.mjs` computes it; it refuses a comparison of other than 100 pairs).

## Method

The 1846r and 1824b kits' fresh-start method (`run-pair.sh`): every turn on a freshly started
server pinned to CPU 2, `wrk -t2 -c64` for 3 s on CPUs 4 and 5, this script and perf on CPU 7, the
order turned every pair (A first in odd pairs). perf stat counts the server process over the
turn: `cycles:u`, `cycles:k`, `instructions:u` (each at 100% running, else the comparison
stops), the software events `page-faults` and `minor-faults` (also at 100%), and, where the host
has it, `L1-icache-load-misses` (the preflight takes it with `:u` or without, whichever this
kernel counts; it is a diagnostic and decides nothing). From `/proc`, after the server answers
and before the load, and after the load: `minflt` and `VmRSS`. Per request: counts over the
requests wrk saw answered; resident bytes a request = (VmRSS after - VmRSS before) / requests.

Answers: before each comparison's first turn A and B are each started once and asked the
comparison's check (curl, Date dropped, an Age line dropped, a tag masked): A twice and B once,
all 200 and the same bytes, headers in the same order. After every turn's counts, before the
server stops, it is asked again and the comparison stops unless: in `room` and `jroom`, a URL
not asked before is answered without an Age and then with one (the store kept it); in `hit`,
`/page` has one; in `plain`, `/private` has none; every one a 200 of the bytes the check had.
Any wrk error (connect, read, write, status, timeout) or a turn with no request answered stops the
comparison: a stopped comparison is reported as failed, not as a result, and the next goes on.
Before the comparisons, every comparison runs once with no recorded pair (its answers, one
unrecorded pair of 1 s turns and the after-checks); a failure there stops the run.

Host: a new quiet dedicated-CPU droplet (c-8, debian-13-x64, root), set up by `setup.sh` and built
by `build.sh` there (`/root/start.sh` runs all of it); nothing else run on or logged into it while
it runs. `host.txt` records the CPU, the kernel, glibc, jemalloc, the binaries and both commits.
`run.out` ends `EXIT <status>` and `ALL-DONE`; the status is 0 only when every comparison ran
and `summary.mjs` could judge it, and 1 otherwise.

## Margins

Judged by `summary.mjs` from the CSVs, with nothing pooled across comparisons and no rerun:

1. **Every comparison is gated.** Each of `room`, `jroom`, `hit` and `plain` runs code the
   change touches (`room` and `jroom` keep a head as lines, `hit` rebuilds a map from them,
   `plain` runs the store's ask), so each is held: the one-sided 95% bound (the 59th of 100) on
   the per-pair change in user+kernel cycles a request is strictly under +1%. A miss is a
   regression this run cannot rule out. There is no floor: no comparison is excused by a noise
   allowance or a negative control.
2. **room and jroom are also reported** with the user and kernel split (each median per-pair
   change with its bound), user instructions, kernel cycles a request as a difference against
   the expected -509 and -388 (a ratio between 0.5 and 2 is consistent with the bytes saved;
   outside it, the bytes alone do not explain it) and resident bytes a request against the
   expected -536 and -408. Fewer cycles is said to be shown only when the bound on the
   user+kernel change is below 0.

**The change is shown free of a regression** when all four meet 1. Whether or not `room` and
`jroom` show fewer cycles, the change stands on the memory it saves (measured locally,
deterministic), and the pull request says which.
A comparison stopped by a failure, a multiplexed or non-numeric counter, a failed request or a
failed after-check, or with other than 100 pairs, is reported as such, not as a result, and gives
no verdict; with one, there is no decision.

## Time

1824e on a c-8: its checks and four comparisons took 48 minutes (06:50:49 to 07:38:32), after
setup and both builds. Locally (a WSL2 container) the 1824d dry run took 178 s for the first build and 150 s for the
second, and about 5 s a dry pair without perf. The 1846 kit measured 6.85 s a pair on a c-8 with
the same fresh-start turns. On the c-8, estimated: setup and both builds 8 to 12 minutes; the
check of every comparison 2 to 3 minutes; 404 pairs with the warm-ups at 7 to 12 s each, 47 to 81
minutes. About 57 to 96 minutes in all. `run-pair.sh` prints its own estimate after each warm-up
pair (run.log); nothing is changed mid-run if it is longer: the time is reported.
