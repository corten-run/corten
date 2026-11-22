# corten-run/corten#1824: what a page kept with room costs the kernel, before option 1 is built (1824b)

The "measured before it is built" step for
[#1824 A `Public` page asked for once costs 44% more cycles than the same page not kept](https://github.com/corten-run/corten/issues/1824),
whose last comment recommends option 1: keep a new answer in memory the store has touched before.
Local scratch, not repository documentation. `results/margin.md` declares the plan, the margins
and the time (about 50 to 78 minutes on a c-8, estimated) before the run.

## Run it

On a fresh Debian 13 x64 c-8 droplet (dedicated CPU, root, nothing else running), upload
`D:\Temp\cycles\cycles-1824b.tar` (made by `pack.ps1`) as `/root/cycles-1824b.tar`, then:

```sh
tar -xOf /root/cycles-1824b.tar 1824b/start.sh >/root/start.sh && sh /root/start.sh
```

`start.sh` unpacks the kit into `/m`, runs `setup.sh` (packages, rustc 1.100.0, `build.sh`) and
`run.sh`, detached, both logging to `/m/1824b/run.out`, which ends `ALL-DONE` (or
`SETUP-FAILED`). Then copy back `/m/1824b/results` (`summary.txt` is the tables and the verdicts;
`sha256.txt` the build receipt; `faultcost.txt` the per-page costs). Do not log in or run anything
else while it runs. Everything is under `/m/1824b` and `/m/target-1824b*`; it uses CPUs 2, 4, 5,
7 and ports 18081-18082, like the 1846r and 1923 kits, so not at the same time as either.

In a container without perf: `RESULTS=<dir with margin.md> PERF=0 PAIRS_SCALE=4 FIRST_MIB=256
ROUNDS=1 sh /m/1824b/run.sh` runs every step with a pair or two a comparison and no counters (not a
measurement). That was run locally before packing (below).

## Files

1. `commits.env`, `src-main/`, `src-main.commit`: main's tree (`git archive 7a275ef15 crates examples
   Cargo.toml Cargo.lock .cargo`), the one commit measured.
2. `variants/populate.diff`: the measurement variant (not a candidate; kept bodies copied into the
   store's own 2 MiB chunks, each made resident in one `madvise`), applied by `build.sh`.
3. `probe/`: the server (`probe <port> room|off|hit|plain`) and an in-process mode for callgrind and
   fault counts (`probe cg <config> <requests>`); its header says what each configuration is.
4. `faultcost/`: what making memory resident costs a 4 KiB page, four ways (its header).
5. `setup.sh`, `build.sh`, `run.sh`, `run-pair.sh`, `summary.mjs`, `start.sh`: their headers say
   what each does. `lua/`, `checks-*.txt`, `mask.sed`: the load scripts and the answer checks.
6. `pack.ps1`: writes the tar after checking the tree, the lock, the margin and line endings.
7. `local/` (not packed): what was run on the workstation: `build.out`, `cg-rounds.txt` (callgrind),
   `cg-faults.txt` (faults and resident memory in process), `faultcost-wsl.txt`, `dry/` (the
   container dry run of `run.sh`), `perfdry/` (a privileged-container run with perf, 2 to 4 pairs
   a comparison, of the first variant) and `populate-free-and-reuse.diff` (that first variant, set
   aside: `results/margin.md`).