# corten-run/corten#1846: the sixth quiet-host run (1846r4)

Paired cycles for [#1846 Send a kept page in brotli 5, made off the request after its second answer](https://github.com/corten-run/corten/pull/1846)
on its merge candidate: the PR's head `593b92b01` (the branch merged with main's `a02c81e86` at
`70243d056`, then Choice 70) against that main. 1846r3's passes 1 and 2 (the cycle gate and the L1i
diagnostic), unchanged in method, workloads, margin and fail-closed wrapper, with one fix from round
14: a perf counter's running share must be exactly 100% (`gate.mjs`, the preflight in `run.sh`, and
the per-turn checks in `run-pair-fresh.sh` and `run-pair.sh`), where 1846r3 accepted any share of 100
or more. The wait run (1846w) is not repeated (`results/margin.md`, "The held value's wait").
`results/margin.md` declares the plan, the margin, the checks and the time (about 65 to 75 minutes on
a c-8). 1846r2, 1846r3 and 1846w are separate kits whose results stay under their own pins.

## Run it

On a fresh Debian 13 x64 c-8 droplet (root, nothing else running), upload `cycles-1846r4.tar` (made
by `pack.ps1`) as `/root/cycles-1846r4.tar` and `start.sh` as `/root/start.sh`, then:

```sh
sh /root/start.sh
```

It unpacks the kit under `/m/1846r4` and runs `setup.sh` (packages, rustc 1.100.0, `build.sh`) and
`run.sh` detached, into `/m/1846r4/run.out`, whose last lines are `run.sh exit <n>` and
`ALL-DONE`. Exit 0 is the only complete run with the gate met. Then copy back `/m/1846r4/results`
(it includes `sha256.txt`, the build receipt). Do not log in or run anything else while it runs.
Everything is under `/m/1846r4` and `/m/target-1846r4`; another kit can run on the same host
before or after it, not at the same time (CPUs 2, 4, 5, 7 and ports 18081-18082).

The plan cannot be changed from the environment: `PAIRS`, `TURN`, `WARMUP`, `MISS_PAIRS`,
`MISS_TURN`, `EVENTS`, `NOPERF`, `WAIT_ROUNDS` and `WAIT_REPS` are refused. A dry run in a
container without perf (the calibration and the four checks, no pair recorded, not a result):
`DRYRUN=1 sh /root/start.sh`.

## Files

1. `commits.env`, `src-base/`, `src-head/`, `src-*.commit`: the two trees (`git archive` of
   `crates examples Cargo.toml Cargo.lock .cargo`), written by
   `pwsh -File D:\Temp\cycles\export-src.ps1 -Pr 1846r4 -Repo <the branch's checkout>`, which also
   copies each tree's `Cargo.lock` into its probe and fills the commits line of `results/margin.md`.
2. `probe-base/`, `probe-head/`: 1846r2's and 1846r3's probe, byte-identical `src/main.rs`; package
   `p1846r4-{base,head}`.
3. `start.sh`, `setup.sh`, `build.sh` (the two builds, their lock and libzstd checks,
   `bin/sha256.txt`), `run.sh` (preflight, calibration, checks, passes 1 and 2, the gate; its header
   says what each does).
4. `gate.mjs` (the fail-closed validator and the gate) and `check-gate.mjs` (its checks on made-up
   turns, the running-share negatives among them; `pack.ps1` runs it).
5. `run-pair-fresh.sh`, `run-pair.sh`: 1846r3's but for the exactly-100% share check.
   `calibrate-refused.sh`, `check-warm.sh`, `summary.mjs`, `summary-events.mjs`, `stats.mjs`,
   `checks-*.txt`, `mask*.sed`, `expect-*.diff`, `lua/`: 1846r2's, byte-identical (but a comment in
   `calibrate-refused.sh` naming the kit).
6. `pack.ps1`: writes `D:\Temp\cycles\cycles-1846r4.tar` after checking the trees, locks, margin,
   line endings and `check-gate.mjs`.

## Results

Per workload `<w>` in `results/`: `cycles-<w>.csv`, `raw-<w>.log`, `summary-<w>.txt`,
`gate-<w>.txt`, `answers-<w>/`, `serve-<w>-{base,head}.log` (every start's `WARM` and, for
`refused`, `FENCE` line; any panic), `starts-<w>.txt` and `warm-<w>.txt`; pass 2 the same as
`<w>-icache` with `counts-<w>-icache.csv`. Also `gate.txt` (every workload's verdict and pass 1's
gate), `host.txt`, `sha256.txt`, `refused.env`, `calibrate.log`, `check-only/`, `preflight/`,
`progress.log` and `run.log`.