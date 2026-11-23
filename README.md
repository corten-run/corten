# Kit 1938c: #1938's integrated pair after round 3 of review

Paired user plus kernel cycles per request between base (main as the head merged it) and head of
[#1938 Let a handler or a task drop the pages the app keeps for a change it made](https://github.com/corten-run/corten/pull/1938),
for the eight workloads kits 1938 and 1938b measured between them (`named`, `named-off`, `write`,
`write-off`, `write-off-glibc`, `kept`, `plain`, `new`), with their protocol, CPUs, ports and
statistic. Kits 1938 and 1938b measured an older pair (`83b3b8772` against `84de7c1e5`); their
results stay attributed to that pair. `results/margin.md`, written before the run, declares the
plan, the margin (+1% on the 59th of 100 pairs, no floor) and what a failure means. Local scratch,
not repository documentation.

## Run it

On a fresh Debian 13 x64 droplet (c-8, dedicated CPU, root, nothing else running), upload
`cycles-1938c.tar` (made by `pack.ps1`) as `/root/cycles-1938c.tar` and `1938c/start.sh` from it
as `/root/start.sh` (`tar -xOf /root/cycles-1938c.tar 1938c/start.sh >/root/start.sh`), then, with
none of PAIRS, WARMUP, TURN, WORKLOADS, SERVER_CPU, LOAD_CPUS, OUT, CHECK_ONLY, EXPECT_PAIRS or PERF
in the environment:

```sh
sh /root/start.sh
```

It unpacks the kit under `/m/1938c` and runs `setup.sh` (packages, rustc 1.100.0, `build.sh`) and
`run.sh` detached, into `/m/1938c/run.out`, which ends `EXIT <status>` and `ALL-DONE`. `COMPLETE`
and `EXIT 0` mean every workload recorded its 100 pairs, every counter at 100% and no failed
request, and was summarised; otherwise there are `FAILED ...` lines, `INCOMPLETE`, and a nonzero
status. Then copy back `/m/1938c/results` (`summary-<workload>.txt` are the tables; `host.txt`,
`status.txt`, `exit.txt`) and `/m/1938c/run.out`. Do not log in or run anything else while it
runs. Everything is under `/m/1938c` and `/m/target-1938c-{base,head}`.

## Files

1. `commits.env` (BASE `fef1f83de`, HEAD the PR head), `src-{base,head}/`, `src-*.commit`, each
   probe's `Cargo.lock`: written by `D:\Temp\cycles\export-src.ps1 -Pr 1938c` from git, which also
   fills the commits line of `results/margin.md`.
2. `probe-{base,head}`: kit 1938b's probe (`src/main.rs`, the same file in both; only its first
   comment line differs from 1938b's), packages renamed `p1938c-*`; head's Cargo.toml turns on its
   `named` feature. Bins `base` and `head`.
3. `lua/`: `get.lua`, `post-same-origin.lua` and `get-new.lua`, 1938b's.
4. `start.sh`, `setup.sh`, `build.sh` (both builds at once), `run.sh` (host.txt, the no-pair
   checks of all eight workloads, 100 pairs each, summaries, the exit status), `run-pair.sh
   <workload>` (one workload; usage in its header), `summary.mjs` (1938b's, refusing any CSV but
   exactly 100 pairs and a rank other than 59). `pack.ps1` writes `D:\Temp\cycles\cycles-1938c.tar`.

Fail closed: PAIRS, WARMUP, TURN, WORKLOADS, SERVER_CPU, LOAD_CPUS, OUT, CHECK_ONLY or
EXPECT_PAIRS in the environment, or a PERF other than 0 or 1, stop `run.sh` unless `PERF=0`
(`run-pair.sh` refuses PAIRS, WARMUP, TURN, SERVER_CPU and LOAD_CPUS the same way), and
`summary.mjs` refuses a CSV with a failed request in any turn. A dry run in a container without counters (not a measurement; its summaries
fail, so it ends `INCOMPLETE` and exits 1, which is the driver behaving as declared):
`PERF=0 PAIRS=2 TURN=2 sh /root/start.sh`.
