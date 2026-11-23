# #1938's cycle kit: a write that names the page it changed

Paired user plus kernel cycles per request between base (origin/main, the merge-base) and head of
[#1938 Let a handler or a task drop the pages the app keeps for a change it made](https://github.com/corten-run/corten/pull/1938),
release builds under load, as CONTRIBUTING.md (Pull requests, item 2) asks: the write that opts in
(`KeptAnswers` taken and `changed` called), with and without a store, and three controls that do
not opt in. The method and the margin are in `results/margin.md`, written before the run. Local
scratch, not repository documentation.

## Run it

On a fresh Debian 13 x64 droplet (c-8, dedicated CPU, root, nothing else running), with
`cycles-1938.tar` uploaded as `/root/cycles-1938.tar`:

```sh
mkdir -p /m && tar -xf /root/cycles-1938.tar -C /m && sh /m/1938/setup.sh && sh /m/1938/run.sh
```

Then copy `/m/1938/results` back (`summary-<workload>.txt` are the tables). Do not log in or run
anything else while `run.sh` runs. Everything lives in `/m/1938` and `/m/target-1938`, so another
kit can be unpacked under `/m` and run after it.

## Files

1. `commits.env`: the two commits. `D:\Temp\cycles\export-src.ps1 -Pr 1938` writes `src-{base,head}`
   (git archive of each), `src-*.commit`, each probe's `Cargo.lock` and the commits line of
   `results/margin.md`. `pack.ps1` writes `D:\Temp\cycles\cycles-1938.tar`.
2. `probe-{base,head}`: one program (`src/main.rs`, the same file in both), apps `page` and
   `page-off`; head's Cargo.toml turns on its `named` feature, which makes `POST /items/7/edit`
   take `KeptAnswers` and name `/home`. Bins `base` and `head`.
3. `lua/`: wrk's `get.lua` and `post-same-origin.lua` (from `D:\Temp\cycles\lua`).
4. `setup.sh` (packages including wrk, perf, rustc 1.100.0, then `build.sh`), `build.sh`, `run.sh`
   (host.txt, the no-pair checks of all five workloads, 100 pairs each, summaries),
   `run-pair.sh <workload>` (one workload; usage in its header), `summary.mjs` (#1920's).

In a container without counters: `PERF=0 OUT=/tmp/x PAIRS=2 sh /m/1938/run-pair.sh named` checks the
answers and runs the turns without perf (not a measurement).