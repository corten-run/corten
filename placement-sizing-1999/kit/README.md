# Kit 1999: corten-run/corten#1999 and #1996, placement A/A at K = 100 and unpadded against padded

Scratch for one measurement session, not repository documentation. `plan.md` declares what runs,
what is read and why, and was written before any measurement (amended once after review 1, still
before any measurement: plan.md, "Amendment 1"; the first plan is in `history/`, which is not
packed); `plan.env` and `commits.env` hold its numbers and commits.

It is the second placement run's kit (tag `evidence/0c0c599c`, with `analysis/` from
`evidence/c448780e`) with the protocol unchanged (fresh start every turn, pinned CPUs,
`wrk -t2 -c64`, 3 s turns, the placement and answer checks, `run-pair-old.sh` as it was but its
path and a 2 s limit on two curl probes) and these differences:

1. Parts (plan.md): A, `aa-old` at K = 100 placements of R = 8 pairs, base-p<p_i> against
   base-p<q_i>, read as recorded and labels swapped; B, `same-old`, one pad list against itself
   (cut for time in this plan, K_B = 0); C, `unpadded-base`, `unpadded-head`, `unpadded-x1` and
   `unpadded-x2`, an unpadded build against p_1..p_8, interleaved round by round.
2. Four sides: base and head as before, and x1 and x2 (`commits.env`), unpadded builds of two
   nearby commits read against base's padded builds.
3. `pads.mjs` gives lists for any K; for K = 100 its first 30 are the earlier lists, and the rest
   keep q - p mod 4096 distinct and spread over the quarters of a page. `schedule.mjs` sets the
   order of all placements (A's in a random order from plan.env's SCHEDULE_SEED); run.sh follows
   it and report.mjs checks that it did.
4. Every placement's `placement.txt` names the kit, the run id, the plan's sha256, its place in
   the schedule and its binaries with their sha256s, and ends with an `ended` line only when its
   pairs are all in. `report.mjs` refuses results another kit, another plan or a broken run could
   leave and reports an incomplete comparison without a bound; `check-report.mjs` tests both on
   made-up results and, given a real run's results, on that run and its alterations
   (`node check-report.mjs dry-run/results`; the counts are in `dry-run/check-report.txt`).
5. `model.mjs` (normal and resampling failure rates of the two-reading A/A, Shapiro-Wilk,
   Anderson-Darling, lag-1, chi-square and F, the "from within" figure) and `size.mjs` (sizing a
   plan from a pilot A/A; `--reproduce` repeats #1999's figures from the saved medians in
   `prior/`). Shapiro-Wilk and Anderson-Darling agree with scipy 1.18.1 and statsmodels 0.15.0 to
   about 1e-13 on six test vectors.

## Run it

On a fresh c-8 from DigitalOcean's `debian-13-x64` image (8 dedicated CPUs, root, nothing else
running; setup.sh refuses any other system), with the tar uploaded as
`/root/cycles-1996-1999.tar` and `start.sh` beside it:

```sh
sh start.sh <the tar's sha256>
```

or by hand (`mkdir -p /m && tar -xf /root/cycles-1996-1999.tar -C /m`, then
`sh /m/1999/setup.sh` and `nohup sh /m/1999/run.sh >/m/1999/run.out 2>&1 &`).

`setup.sh` installs the packages and rustc 1.100.0 and runs `build.sh` (ends `SETUP-DONE`).
The collector waits for `ALL-DONE` as the last line of `/m/1999/run.out`, and nothing else:
every way the run ends, a failed setup included, writes `RUN-ENDED <outcome>: <what>` and then
`ALL-DONE` there (plan.md, Amendment 1, item 7); `results/report.md` and `report.json` are the summary, about 3.9 to 4.0 hours
in all, about 4.4 at worst (plan.md, Time). `DRYRUN=1` for both is a container test with a stand-in for `perf`
(`dry/perf`): DRY_K_A (5) pads, DRY_K_C (2) of each unpadded comparison, DRY_R (2) pairs, 1 s
turns, and results marked `DRYRUN`. `dry-run/` holds such a run (its README says how it was
run). Before packing, `node check-report.mjs dry-run/results` must pass.

Sizing from a pilot: `node size.mjs <results>/aa-old` (or `--sd <percent>`, `--reproduce`,
`--selftest`).

## Files

1. `plan.md`, `plan.env`, `commits.env`, `plan.sh`; `src-{base,head,x1,x2}/` and `src-*.commit`:
   the four trees (`git archive` of `crates examples Cargo.toml Cargo.lock .cargo`).
2. `probe/`, `shim/clockstep.c`, `lua/picture.lua`, `wrap/cc`, `link-capture.mjs`, `relink.mjs`,
   `layout.mjs`, `stats.mjs`: the earlier kits'.
3. `build.sh`, `verify.sh`, `run.sh`, `run-pair-old.sh`, `setup.sh`, `start.sh`, `dry/perf`,
   `pads.mjs`, `schedule.mjs`; `pack.ps1` writes the tar (not packed itself).
4. `placement.mjs`, `model.mjs`, `report.mjs`, `check-report.mjs`, `size.mjs`.
5. `prior/`: the two earlier runs' A/A and unpadded CSVs, placements, plans and sha256s (tags
   `evidence/ee7b0b41` and `evidence/0c0c599c`), read by `size.mjs --reproduce` and report.mjs.
6. `analysis/`: the earlier calculations (`evidence/c448780e`), and `size-reproduce.txt` and
   `size-selftest.txt` from this kit.
7. `dry-run/`: the container dry run's results, logs and check-report output (not a measurement).
8. `history/` (not packed): the plan before Amendment 1 and the dry run of that kit.
