# The kit for the deadline timer's placement run (corten-run/corten#2029)

Scratch for one measurement, not repository documentation. `plan.md` declares what runs, what is
read and why, and was written before any measurement; `plan.env` and `commits.env` hold its
numbers and commits.

It is two kits joined:

1. From the stage header checks' kit (tag `evidence/stage-header-checks-2002`), unchanged:
   `run-pair-fresh.sh` (a placement: the two builds' answers compared, one unrecorded pair, the
   recorded pairs, every turn on a fresh start), `layout.mjs`, `link-capture.mjs`, `relink.mjs`,
   `placement.mjs`, `stats.mjs`, `wrap/cc` (its path only), `mask-etag.sed`, `mask-none.sed`,
   `lua/get.lua` and `probe/Cargo.toml`. `build.sh`, `setup.sh` and `verify.sh` are that kit's with
   this kit's paths, a workload argument, only the sides a part reads, the Debian 13 check and a
   time limit on each check.
2. From the placement sizing kit (tag `evidence/placement-sizing-1999`), unchanged: `pads.mjs`
   (the pad lists for any K), `model.mjs` and `size.mjs` (the two-reading A/A's failure rate under
   the normal model and the smoothed resample, Shapiro-Wilk, Anderson-Darling, the permutation
   tests). `size.mjs --reproduce` needs that kit's `prior/`, which is not here. `run.sh` takes
   from that kit's the run id, the plan's sha256, the nine-line record of each placement, the
   seeded schedule, the time limit, the one retry and the `RUN-ENDED` and `ALL-DONE` lines.
3. Written for this run: the probe's two routes (`probe/src/main.rs`: `/wait`, `/unstaged`), the
   four workloads' request files (`checks-*.txt`), `lua/close.lua`, `schedule.mjs` (a part's
   order from its seed), `padlists.mjs` (each workload's pad lists, `pads.mjs`'s for its own K), `pilot.mjs` (eligibility, the models kept and the plan's rule for K),
   `report.mjs` and `selftest/`.

## Parts

`plan.env`'s `PART` says which part the kit runs.

1. `pilot`: for a workload, `pilot-<w>`, base-p<p_i> against base-p<q_i>, K placements in the
   order of the workload's seed. Only the base is built. `report.mjs` gives the spread, whether
   the pilot is eligible and the K the plan's rule gives.
2. `gated`: `aa-<w>` and `change-<w>` (base-p<p_i> against head-p<p_i>), back to back at each
   index of the seeded order. Declared with its K's, its seeds and its head after the pilot.

## Run it

On a fresh Debian 13 x64 host with 8 dedicated CPUs (root, nothing else running), with the tar
unpacked into `/m` (it holds `dl/`):

```sh
sh /m/dl/setup.sh <workload>          # packages, rustc 1.100.0, build.sh; ends SETUP-DONE
nohup sh /m/dl/run.sh <workload> >/m/dl/run.out 2>&1 &
```

The run is over when `/m/dl/run.out` ends with `ALL-DONE`; the line before it says how it ended.
`results/report.md` and `report.json` are the summary. `node pilot.mjs results/pilot-<w>
--confirm` repeats the sizing from the placement directories with the call the plan names.

`DRYRUN=1` for `setup.sh` and `run.sh` is a test of the scripts with real counters: `DRY_K` (3)
placements, `DRY_R` (2) pairs, `DRY_TURN` (1) second turns, results marked `DRYRUN`, nothing
read. `sh selftest/selftest.sh <workload>` shows that a wrong answer, a failed request and a
placement past its time limit each leave nothing recorded. Move `results/` away and build again
without `DRYRUN` before a run that counts.
