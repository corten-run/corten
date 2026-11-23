# corten-run/corten#1965: the cycle gate read across placements

Paired cycles of Corten main against itself and of #1955's change, each side compiled once and
**placed K = 30 ways by relinking the same objects with a never-called pad first in `.text`**
(sizes fixed in `plan.env` before any build, from `pads.mjs`), so every function moves by the
pad and keeps its order and neighbours. Each placement is started fresh on every turn and read
with R = 8 recorded pairs after one that is not, under kit 1923's fresh-start protocol (#1829's).
The statistic is the median across placements of each placement's median per-pair change, with
the order-statistic bound the 20th of 30. Main against main (main pad p_i against main pad q_i,
two declared lists) on `plain` and `kept` is what the run can resolve; #1955's base pad p_i against
head pad p_i on `kept` is read against +1% only where that A/A resolves. A diagnostic reads main's
unpadded build against 8 of its padded ones. `results/margin.md` declares the plan, the reading
and the time (about 2 h 10 min on a c-8, estimated). Local scratch, not repository documentation.

## Run it

On a fresh Debian 13 x64 c-8 droplet (root, nothing else running), upload `cycles-1965.tar` (made
by `pack.ps1`) as `/root/cycles-1965.tar`, then:

```sh
mkdir -p /m && tar -xf /root/cycles-1965.tar -C /m && sh /m/1965/setup.sh
nohup sh /m/1965/run.sh >/m/1965/run.out 2>&1 &
```

(or upload `1965/start.sh` from the tar as `/root/start.sh` and `sh /root/start.sh`, which does
both detached). `setup.sh` installs the packages and rustc 1.100.0 and runs `build.sh` (ends
`SETUP-DONE`). `run.sh` ends `ALL-DONE` in `run.out`; then copy back `/m/1965/results`
(`placements.md` is the summary; `placements.json`, `host.txt`, `sha256.txt`, `placements.txt`,
`placements-summary.txt`, `layout/`, `link-*.json`, `verify/` and every placement's CSV and logs
are beside it). Do not log in or run anything else while it runs. Everything is under `/m/1965`
and `/m/target-1965-{main,base,head}`; another kit can run on the host before or after it, not at
the same time (CPUs 2, 4, 5, 7 and ports 18081-18082).

The plan cannot be changed from the environment: `PAIRS`, `WARMUP`, `TURN`, `EVENTS`, `CHECKS`,
`MASK`, `EXPECT`, `STATUS` and `NOPERF` are refused, and K, R, the pads and the diagnostic are read
from `plan.env` (`plan.sh`). A container test (not a measurement): `DRYRUN=1` for both `setup.sh`
and `run.sh` uses the first `DRY_K` (5) pads of each list, `DRY_DIAG_K` (2) diagnostic placements
and `DRY_R` (2) pairs, and marks the results `DRYRUN`.

## Files

1. `commits.env`, `src-{main,base,head}/`, `src-*.commit`: the three trees (`git archive` of
   `crates examples Cargo.toml Cargo.lock .cargo`), written by `export.ps1` (workstation only,
   not in the tar), which checks BASE is HEAD's first parent.
2. `plan.env`: K, R, `PADS_P`, `PADS_Q`, `DIAG_K`, `DIAG_R`, which `margin.md` states; `pads.mjs`
   writes and checks the pad lists (`node pads.mjs --check plan.env`); `plan.sh` reads plan.env
   for the shell scripts and applies DRYRUN.
3. `probe/`: #1829's probe program (kit 1923's `src/main.rs`, unchanged), package `p1965`,
   depending on `../work/crates/corten`; build.sh copies the side's Cargo.lock beside it.
4. `wrap/cc`, `link-capture.mjs`: the `cc` rustc runs while build.sh builds, which records the
   probe's final link (`capture/<side>/args.json`) and copies the objects rustc deletes after it.
   `relink.mjs`: runs that link again, unpadded or with a pad object and its ordering file.
5. `build.sh`: the pad objects (`pads/`, assembled on the host), the three builds, the unpadded
   relink check (byte-identical to cargo's binary), the 120 placements and their checks
   (`layout.mjs`, adapted from kit 1923's: exact shifts, neighbours, the pad first),
   `bin/sha256.txt`, `bin/placements.txt`, `bin/placements-summary.txt`. `verify.sh`: every
   placement's answers against its unpadded binary.
6. `run.sh`: preflight, `host.txt`, verify, checks, the 90 read placement runs interleaved, the 8
   diagnostic ones, report. `run-pair-fresh.sh`, `stats.mjs`, `mask.sed`, `lua/get.lua`,
   `checks-plain.txt`: kit 1923's, unchanged (`checks-kept.txt` is its `checks-hit.txt`;
   `checks-verify.txt` holds both paths).
7. `placement.mjs` (the statistics), `report.mjs` (`results/placements.md` and `.json`),
   `check-report.mjs` (their checks on made-up results with plan.env's pads; `pack.ps1` runs it).
8. `pack.ps1` (workstation only): writes `D:\Temp\cycles\cycles-1965.tar` after checking the trees,
   that margin.md states plan.env, that the pads are `pads.mjs`'s, line endings and
   `check-report.mjs`.
