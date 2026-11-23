# corten-run/corten#1824: fewer bytes held for each kept answer (1824e)

Paired cycles for the candidate that follows
[#1824 A `Public` page asked for once costs 44% more cycles than the same page not kept](https://github.com/corten-run/corten/issues/1824)'s
finding that a page kept with room pays about 0.95 kernel cycles a byte it holds: the candidate
holds a kept answer's head as its own lines and a count of its names (not a cloned
`HeaderMap`), rebuilds a map with room for those names on a hit, and writes
`Cache-Control` at its own length, 536 bytes fewer for the record page and 408 for the JSON
records under jemalloc. Local scratch, not repository documentation. `results/margin.md`
declares the plan, the margins and the time (about 57 to 96 minutes on a c-8, estimated) before
the run. Main is `a02c81e86`, the candidate `41f2d882f` (`commits.env`). Every comparison is
gated at +1%.

## Run it

On a fresh Debian 13 x64 c-8 droplet (dedicated CPU, root, nothing else running), upload
`cycles-1824e.tar` (made by `pack.ps1`) as `/root/cycles-1824e.tar`, then:

```sh
tar -xOf /root/cycles-1824e.tar 1824e/start.sh >/root/start.sh && sh /root/start.sh
```

`start.sh` unpacks the kit into `/m`, runs `setup.sh` (packages, rustc 1.100.0, `build.sh`) and
`run.sh`, detached, both logging to `/m/1824e/run.out`, whose last line is `ALL-DONE` whatever
happened, after `EXIT <status>` (0 only when every comparison ran and was judged; `SETUP-FAILED`
comes first when setup or a build failed). The pairs (100 a comparison), the warm-up, the turns,
the comparisons and the counters are fixed: `start.sh` and `run.sh` refuse to start with
`PAIRS`, `JROOM_PAIRS`, `TURN`, `WARMUP`, `COMPARISONS` or `PERF` set. Then copy back `/m/1824e/results` (`summary.txt` is the tables and the verdicts;
`sha256.txt` the build receipt; `host.txt` the host and both commits). Do not log in or run
anything else while it runs. Everything is under `/m/1824e` and `/m/target-1824e*`; it uses CPUs
2, 4, 5, 7 and ports 18081-18082, like the 1846r, 1923 and 1824b kits, so not at the same time as
any of them.

In a container without perf, after `setup.sh`: `DRY_RUN=1 RESULTS=<another dir with margin.md> sh
/m/1824e/run.sh` runs every step with two pairs a comparison, no warm-up and no counters (not a
measurement; it refuses the kit's own results directory). That, and `start.sh` itself (which
there stops at the preflight, `EXIT 1`), were run locally on this tar before it was kept.

## Files

1. `commits.env`, `src-main/`, `src-main.commit`, `src-head.commit`: main's tree (`git archive`
   of main's commit), the commit measured as A, and the candidate's commit.
2. `variants/head.diff`: the candidate's change under `crates/` (`git diff` from main to the
   candidate), applied to main's tree by `build.sh` to build B. `pack.ps1` checks both against
   git (the diff byte for byte, every file of `src-main/` by its blob id) before it writes the tar.
3. `probe/`: the server (`probe <port> room|off|hit|plain|jroom`) and an in-process mode for
   callgrind and resident memory (`probe cg <config> <requests>`); its header says what each
   configuration is.
4. `setup.sh`, `build.sh`, `run.sh`, `run-pair.sh`, `summary.mjs`, `start.sh`: their headers say
   what each does. `lua/`, `checks-*.txt`, `mask.sed`: the load scripts and the answer checks.
5. `pack.ps1`: writes the tar after checking the commits, the lock, the margin and line endings.
6. Not packed: `allocmap/` (the counting allocator that gives what each kept answer holds) and
   `local/` (what was run on the workstation: `cg-rounds-v1.txt` callgrind, `cg-rss.txt` resident
   memory in process, `allocmap*.txt`, `dry/` the container dry run).

## Changed after the pack

1. 2026-11-23, after `cycles-1824e.tar` was written (2026-11-23 00:23) and uploaded: `summary.mjs`
   treats a row whose error count is blank or missing, or whose turn answered no requests, as
   unusable (that comparison has no verdict, exit 1), where it had counted a blank as no errors.
   It applies to packs written from now on and to the summary run at collection; the tar being
   measured holds the earlier `summary.mjs`, which `run.sh` runs on the host for its own
   `summary.txt`. `local/summary-test.mjs <summary.mjs>` checks it on synthetic receipts.
