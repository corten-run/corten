# corten-run/corten#1846: the fourth quiet-host run (1846r2)

Paired cycles for [#1846 Send a kept page in brotli 5, made off the request after its second answer](https://github.com/corten-run/corten/pull/1846)
on its merge candidate (the branch after merging `origin/main` `7a275ef15`, which took #1922) against
that main, with 1846r's method and workloads, `refused` fenced on the compression thread and now
failing on any panic in the process (caught ones included), the diagnostic pass of user L1
instruction-cache misses, and a third pass timing a held value's wait behind a kept page's brotli 5
job. `results/margin.md` declares the plan, the margins and bounds, and the time (about 85 to 95
minutes on a c-8). 1846r (the third run, `9d60f9647` against `153be9116`) is a separate kit whose
result, if any, stays under its own pins.

## Run it

On a fresh Debian 13 x64 c-8 droplet (root, nothing else running), upload `cycles-1846r2.tar` (made
by `pack.ps1`) as `/root/cycles-1846r2.tar`, then:

```sh
mkdir -p /m && tar -xf /root/cycles-1846r2.tar -C /m && sh /m/1846r2/setup.sh
nohup sh /m/1846r2/run.sh >/m/1846r2/run.out 2>&1 &
```

(`start.sh` does both, detached.) `setup.sh` installs the packages and rustc 1.100.0 and runs
`build.sh` (ends `SETUP-DONE`). `run.sh` ends `ALL-DONE` in `run.out`; then copy back
`/m/1846r2/results` (it includes `sha256.txt`, the build receipt for all four binaries). Do not log
in or run anything else while it runs. Everything is under `/m/1846r2`, `/m/target-1846r2` and
`/m/target-1846r2-wait`; another kit (1846r, 1923) can run on the same host before or after it, not
at the same time (CPUs 2, 4, 5, 7 and ports 18081-18082).

In a container without perf, `WARMUP=0 PAIRS=0 MISS_PAIRS=0 NOPERF=1 WAIT_ROUNDS=1 WAIT_REPS=2 sh
/m/1846r2/run.sh` runs the calibration, checks every workload's answers, warm-up, fence and panic
lines, and one short round of pass 3; none of it is a result.

## Files

1. `commits.env`, `src-base/`, `src-head/`, `src-*.commit`: the two trees (`git archive` of
   `crates examples Cargo.toml Cargo.lock .cargo`), written by
   `pwsh -File D:\Temp\cycles\export-src.ps1 -Pr 1846r2`, which also copies each tree's `Cargo.lock`
   into its probe and fills the commits line of `results/margin.md`.
2. `probe-base/`, `probe-head/`: 1846r's probe with a panic hook: the fence and every start fail
   on a panic counted before the port opens (its header says how); package `p1846r2-{base,head}`.
3. `wait/`: pass 3's probe (`probe_wait.rs`, round 10's workstation probe with the declared
   defaults), its two side files and the module declaration `build.sh` appends to a copy of each
   tree's `kept.rs` (`wait-src-<side>`, never `src-<side>`).
4. `setup.sh`, `build.sh` (the four builds, their lock and libzstd checks, `bin/sha256.txt`),
   `run.sh` (preflight, calibration, checks, passes 1 to 3; its header says what each does),
   `wait.sh` and `summary-wait.mjs` (pass 3).
5. `calibrate-refused.sh`, `run-pair.sh`, `run-pair-fresh.sh`, `check-warm.sh`, `summary.mjs`,
   `summary-events.mjs`, `stats.mjs`, `checks-*.txt`, `mask*.sed`, `expect-*.diff`, `lua/`: 1846r's,
   unchanged but for the kit's name.
6. `pack.ps1`: writes `D:\Temp\cycles\cycles-1846r2.tar` after checking the trees, locks, margin
   and line endings.

## Results

Per workload `<w>` in `results/`: `cycles-<w>.csv`, `raw-<w>.log`, `summary-<w>.txt`,
`answers-<w>/`, `serve-<w>-{base,head}.log` (every start's `WARM` and, for `refused`, `FENCE`
line; any panic), `starts-<w>.txt` and `warm-<w>.txt`; pass 2 the same as `<w>-icache` with
`counts-<w>-icache.csv`; pass 3 `wait/` and `summary-wait.txt`. Also `host.txt`, `sha256.txt`,
`refused.env`, `calibrate.log`, `check-only/`, `preflight/`, `progress.log` and `run.log`.
