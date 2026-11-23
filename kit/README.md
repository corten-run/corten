# corten-run/corten#1846: the held value's wait alone (1846w)

How long a held value waits behind a kept page's brotli 5 job, timed on a quiet host for
[#1846 Send a kept page in brotli 5, made off the request after its second answer](https://github.com/corten-run/corten/pull/1846):
the PR's branch (with the test-only `LOCKING` hook) against main's `7a275ef15`. It replaces the
fourth run's (1846r2's) third pass after round 12's review: each `contended` sample now shows the
kept job asked for the store's lock while another writer held it, the bound is taken over process
pairs (rounds), and the validator fails closed on an incomplete or inadmissible matrix.
1846r2's passes 1 and 2 remain the cycle gate. `results/margin.md` declares the plan, the checks,
the statistic, the bounds and the time.

## Run it

On a fresh Debian 13 x64 c-8 droplet (root, nothing else running), upload `cycles-1846w.tar` (made
by `pack.ps1`) as `/root/cycles-1846w.tar` and `start.sh` as `/root/start.sh`, then:

```sh
sh /root/start.sh
```

It unpacks the kit under `/m/1846w` and runs `setup.sh` (packages, rustc 1.100.0, `build.sh`) and
`run.sh` detached, into `/m/1846w/run.out`, which ends with `ALL-DONE`. Then copy back
`/m/1846w/results`. Do not log in or run anything else while it runs. Everything is under
`/m/1846w` and `/m/target-1846w-wait`; another kit can run on the same host before or after it, not
at the same time (CPUs 2, 4, 5 and 7).

A dry run (in a container, not a result; its summary says the matrix is not the declared one):
`WAIT_ROUNDS=2 WAIT_REPS=2 sh /root/start.sh`.

## Files

1. `commits.env`, `src-base/`, `src-head/`, `src-*.commit`: the two trees (`git archive` of
   `crates examples Cargo.toml Cargo.lock .cargo`), written by `export.ps1`, which also fills the
   commits line of `results/margin.md`.
2. `wait/`: the probe (`probe_wait.rs`), its two side files and the module declaration `build.sh`
   appends to a copy of each tree's `kept.rs` (`wait-src-<side>`, never `src-<side>`).
3. `start.sh`, `setup.sh`, `build.sh`, `run.sh`, `wait.sh`; `summary-wait.mjs` (the validator and
   summary), `stats.mjs` (1846r2's), `check-summary.mjs` (the validator's own checks on made-up
   rows; `pack.ps1` runs it).
4. `export.ps1`, `pack.ps1`: run on the workstation; `pack.ps1` writes
   `D:\Temp\cycles\cycles-1846w.tar` after checking the trees, the margin and line endings.

## Results

`results/`: `host.txt`, `sha256.txt`, `progress.log`, `run.log`, `wait/<build>-<round>.{tsv,out,err}`
and `summary-wait.txt` (its last lines: the declared checks, `usable` and the gate).
