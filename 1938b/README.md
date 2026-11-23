# Kit 1938b: #1938's supplement after round 2 of review

Paired user plus kernel cycles per request between base (origin/main, the merge-base) and head of
[#1938 Let a handler or a task drop the pages the app keeps for a change it made](https://github.com/corten-run/corten/pull/1938),
the same commits, protocol, CPUs, ports and statistic as kit 1938, for three cases 1938 does not
measure: the write that does not opt in with the store off, under jemalloc (`write-off`) and glibc
(`write-off-glibc`), and a new URL with every request, each page kept (`new`, with a check in every
turn that the pages were kept). 1938's results stay the gate for its five workloads; this kit
supersedes none of them. `results/margin.md`, written before the run, declares the plan, the
margin and what a failure means. Local scratch, not repository documentation.

## Run it

On a fresh Debian 13 x64 droplet (c-8, dedicated CPU, root, nothing else running), or on the host
kit 1938 ran on once it has finished, upload `cycles-1938b.tar` (made by `pack.ps1`) as
`/root/cycles-1938b.tar` and `1938b/start.sh` from it as `/root/start.sh`
(`tar -xOf /root/cycles-1938b.tar 1938b/start.sh >/root/start.sh`), then:

```sh
sh /root/start.sh
```

It unpacks the kit under `/m/1938b` and runs `setup.sh` (packages, rustc 1.100.0, `build.sh`) and
`run.sh` detached, into `/m/1938b/run.out`, which ends `EXIT <status>` and `ALL-DONE`. `COMPLETE`
and `EXIT 0` mean every workload recorded its 100 pairs and was summarised; otherwise there are
`FAILED ...` lines, `INCOMPLETE`, and a nonzero status. Then copy back `/m/1938b/results`
(`summary-<workload>.txt` are the tables; `status.txt`, `exit.txt`). Do not log in or run anything
else while it runs. Everything is under `/m/1938b` and `/m/target-1938b-{base,head}`.

## Files

1. `commits.env` (1938's pins), `src-{base,head}/`, `src-*.commit`, each probe's `Cargo.lock`:
   written by `D:\Temp\cycles\export-src.ps1 -Pr 1938b`, which also fills the commits line of
   `results/margin.md`. Both trees and locks are byte-identical to 1938's.
2. `probe-{base,head}`: 1938's probe (`src/main.rs`, the same file in both) with one config added,
   `page-roomy` (`kept_answers(1 << 30)`); head's Cargo.toml turns on its `named` feature, which
   none of this kit's workloads reaches. Bins `base` and `head`.
3. `lua/`: `get.lua` and `post-same-origin.lua` (1938's), `get-new.lua` (a new URL each request;
   prints each thread's last one).
4. `start.sh`, `setup.sh`, `build.sh` (both builds at once), `run.sh` (host.txt, the no-pair checks
   of all three workloads, 100 pairs each, summaries, the exit status), `run-pair.sh <workload>`
   (one workload; usage in its header), `summary.mjs` (1938's, which refuses a CSV with other than
   `EXPECT_PAIRS` pairs). `pack.ps1` writes `D:\Temp\cycles\cycles-1938b.tar`.

A dry run in a container without counters (not a measurement; its summaries fail, so it ends
`INCOMPLETE` and exits 1, which is the driver behaving as declared):
`PERF=0 PAIRS=2 TURN=2 sh /m/1938b/run.sh`.