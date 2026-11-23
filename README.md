# corten-run/corten#1846: the seventh quiet-host run (1846r5), the workload `twice`

Paired cycles for [#1846 Send a kept page in brotli 5, made off the request after its second answer](https://github.com/corten-run/corten/pull/1846)
on one workload the six earlier runs did not have: every URL asked twice, so every second answer is
the one that, on the head, queues the page's brotli 5, and the head's compression thread then makes
it on the server's CPU. The pair is 1846r4's: the PR's `593b92b01` (the branch merged with main's
`a02c81e86` at `70243d056`, then Choice 70) against that main; the branch's later merge of main's
`04530f7e0` (`1fce7b3ae`) changed `docs/design.md` alone, none of the exported paths. Round 15
asked for the request that queues the job to be measured; `results/margin.md` declares the plan,
the margin (+1%), the checks and the time (about 22 to 35 minutes on a c-8). 1846r4's four workloads
are not run again (they were measured on these binaries' sources by the sixth run, receipt
`evidence/aed6638f`). 1846r2, 1846r3, 1846r4 and 1846w are separate kits whose results stay under
their own pins.

## Run it

On a fresh Debian 13 x64 c-8 droplet (root, nothing else running), upload `cycles-1846r5.tar` (made
by `pack.ps1`) as `/root/cycles-1846r5.tar` and `start.sh` as `/root/start.sh`, then:

```sh
sh /root/start.sh
```

It unpacks the kit under `/m/1846r5` and runs `setup.sh` (packages, rustc 1.100.0, `build.sh`) and
`run.sh` detached, into `/m/1846r5/run.out`, whose last lines are `run.sh exit <n>` and
`ALL-DONE`. Exit 0 is the only complete run with the gate met. Then copy back `/m/1846r5/results`
(it includes `sha256.txt`, the build receipt). Do not log in or run anything else while it runs.
Everything is under `/m/1846r5` and `/m/target-1846r5`; another kit can run on the same host
before or after it, not at the same time (CPUs 2, 4, 5, 7 and ports 18081-18082).

The plan cannot be changed from the environment: `PAIRS`, `TURN`, `WARMUP`, `MISS_PAIRS`,
`MISS_TURN`, `EVENTS`, `NOPERF`, `WAIT_ROUNDS` and `WAIT_REPS` are refused. A dry run in a
container without perf (the answer check, no pair recorded, not a result):
`DRYRUN=1 sh /root/start.sh`.

## Files

1. `commits.env`, `src-base/`, `src-head/`, `src-*.commit`: 1846r4's two trees (`git archive` of
   `crates examples Cargo.toml Cargo.lock .cargo` at `a02c81e86` and `593b92b01`), copied unchanged.
2. `probe-base/`, `probe-head/`: 1846r4's probe with the `twice` config (kept_answers(8 GiB), warmed
   as `browser`), the in-process `cg` mode for Callgrind (not run on the host) and `main` building
   its runtime itself; byte-identical `src/main.rs`, package `p1846r5-{base,head}`, and
   `tower` and `http-body-util` (for `cg`) from the tree's lock.
3. `lua/twice-browser.lua`: the load, every URL of `/page` asked twice with a browser's codings, the
   second 256 requests after the first on its wrk thread, and an `AGED` line a thread counting the
   first and second requests made and the answers with and without an `Age`.
4. `start.sh`, `setup.sh`, `build.sh` (1846r4's for these paths), `run.sh` (preflight, the check,
   passes 1 and 2, the gate; its header says what each does).
5. `gate.mjs` (the fail-closed validator and the gate: 1846r4's, and no counter at 0 on a turn that
   answered requests, every paired change finite before the sort, and `twice`'s AGED lines) and
   `check-gate.mjs` (its checks on made-up turns; `pack.ps1` runs it).
6. `run-pair-fresh.sh`, `run-pair.sh`, `check-warm.sh`, `summary.mjs`, `summary-events.mjs`,
   `stats.mjs`, `checks-browser.txt`, `mask-browser.sed`, `expect-browser.diff`: 1846r4's,
   byte-identical (`twice` checks `/page` as `browser` did).
7. `pack.ps1`: writes `D:\Temp\cycles\cycles-1846r5.tar` after checking the trees, locks, margin,
   line endings and `check-gate.mjs`. `local/` (the workstation's Callgrind count) and `dryrun/`
   are not packed.

## Results

In `results/`: `cycles-twice.csv`, `raw-twice.log` (every turn's perf and wrk output, its AGED
lines), `summary-twice.txt`, `gate-twice.txt`, `answers-twice/`, `serve-twice-{base,head}.log`,
`starts-twice.txt`, `warm-twice.txt`; pass 2 the same as `twice-icache` with
`counts-twice-icache.csv`. Also `gate.txt`, `host.txt`, `sha256.txt`, `check-only/`,
`preflight/`, `progress.log` and `run.log`.
