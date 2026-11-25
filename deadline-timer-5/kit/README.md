# The kit for the deadline timer's placement run (corten-run/corten#2029)

Scratch for one measurement, not repository documentation. `plan.md` declares what runs, what is
read and why, and was written before any measurement; `plan.env` and `commits.env` hold its
numbers and commits.

It is two kits joined:

1. From the stage header checks' kit (tag `evidence/stage-header-checks-2002`), unchanged:
   `layout.mjs`, `link-capture.mjs`, `placement.mjs`, `stats.mjs`, `wrap/cc` (its path only),
   `mask-etag.sed`, `mask-none.sed` and `lua/get.lua`. Changed from that kit's: `relink.mjs`
   gained `--map` (item 5); `run-pair-fresh.sh` (a placement: the two builds' answers compared,
   one unrecorded pair, the recorded pairs, every turn on a fresh start) gained `LOAD_T`,
   `LOAD_C` and `IDLE` (item 6), and with none of them set runs as that kit's does;
   `probe/Cargo.toml` gained tokio's `rt-multi-thread` (item 6). `build.sh`, `setup.sh` and
   `verify.sh` are that kit's with this kit's paths, a workload argument, only the sides a part
   reads, the Debian 13 check and a time limit on each check.
2. From the placement sizing kit (tag `evidence/placement-sizing-1999`), unchanged: `pads.mjs`
   (the pad lists for any K), `model.mjs` and `size.mjs` (the two-reading A/A's failure rate under
   the normal model and the smoothed resample, Shapiro-Wilk, Anderson-Darling, the permutation
   tests). `size.mjs --reproduce` needs that kit's `prior/`, which is not here. `run.sh` takes
   from that kit's the run id, the plan's sha256, the nine-line record of each placement, the
   seeded schedule, the time limit and the `RUN-ENDED` and `ALL-DONE` lines. It does not take
   that kit's one retry: no placement is run again, replaced or dropped. A placement that fails a
   check or is stopped at its time limit stays where it failed and leaves its comparison with no
   bound, and `report.mjs` refuses results that show a placement run again (a `retries.txt`, a
   `failed/` directory, a `RETRY_MAX` in `plan.env`, or a placement out of the schedule's order
   in time).
3. Written for this run: the probe's two routes (`probe/src/main.rs`: `/wait`, `/unstaged`), the
   workloads' request files (`checks-*.txt`), `lua/close.lua`, `schedule.mjs` (a part's
   order from its seed), `padlists.mjs` (each workload's pad lists, `pads.mjs`'s for its own K), `pilot.mjs` (eligibility, the models kept and the plan's rule for K),
   `report.mjs` and `selftest/`.
4. Added for the plan's fifth workload, `after` (the kit named `-2` was the first with it):
   `lua/after.lua` (each `wrk` thread's first 512 calls for a
   request get `GET /wait`, every call after `GET /private`), `checks-after.txt` (its two
   requests), `state.sh` and `state.mjs` (before anything is counted, whole turns of that load
   with the packets recorded and no counter read: every connection must send at least three
   requests for `/wait` before its first for `/private` and none after), and the workload's name
   where the others are listed. `verify.sh` reads a check file's first line for a workload's
   `ETag`. Nothing the other four workloads run is changed by it.
5. Added for the record CONTRIBUTING asks of every placement run (Pull requests, item 2, the
   plan's fifth point), for every workload: `build.sh` makes each side's unpadded link again
   with LLD's map (`relink.mjs --map`), requires it byte for byte cargo's binary, and
   `maprec.mjs` writes from the map `aligned-<side>.txt`: each input section of `.text` aligned
   beyond 16 bytes and every symbol from the first of them on. `run.sh` puts that record and the
   map (`map-<side>.map.gz`) in the results before anything is measured, and `report.mjs` reads
   no results without them. A side with such a section stops the build: this kit has no second
   pad and makes none of the checks asked for such a side.
6. Added for the plan's third declaration (this kit's name ends `-3`; `report.mjs` reads no
   results of the kits before it):
   - Two workloads, `beside` and `besidemt`: one connection that never waits (`wrk -t1 -c1` on
     CPU 4, `GET /private`) beside one idle connection that asked for `/wait` three times before
     the turn's counters start (`idle.mjs`, started by `run-pair-fresh.sh` when `IDLE` is set,
     required still open and silent after the turn; its two lines for each turn are in the
     placement's raw log, and `report.mjs` reads no placement without them). `beside` is on the
     probe's `plain` configuration, a single-threaded runtime; `besidemt` on `plain-mt`, tokio's
     multi-threaded runtime with one worker (`probe/src/main.rs` builds either by hand).
   - The change's margin by workload: +5% for those two alone, +1% for the rest; an A/A is
     resolved at +1% in both readings for every workload (`report.mjs`).
   - `build.sh` and `run.sh` refuse sources that are not `commits.env`'s commits, and the build's
     record of what it was built for names them.
   - `report.mjs` requires each placement's verdict to name every request of the workload's
     checks file (two for `after`, one for the others), refuses a turn with no requests, user
     cycles, kernel cycles or user instructions, an empty or foreign map, and a record of aligned
     sections that is empty or not that map's.
   - `state.mjs` holds a capture to the exact count of requests `wrk`'s threads sent, to each
     connection's TCP sequence numbers (a packet sent again or a gap is a fault) and refuses a
     capture cut inside a record; `state.sh` passes the threads' calls.
7. Added after the fourth review, before any run of this kit:
   - `park.sh` and `park.mjs`, for `beside` and `besidemt`: before anything is counted, three
     whole turns of the load on each side's unpadded binary beside the idle connection, with
     `strace` recording every wait for an event the server makes and no counter read. The base's
     waits must all have no timeout (no timer stands in the runtime's wheel) and the head's must
     all have one (the idle connection's kept timer does); `report.mjs` reads no results of the
     two workloads without those verdicts.
   - `report.mjs`: for those two workloads a change within its margin is read as met only if the
     head ran at least 95 more user instructions a request than the base at the median across
     placements (`STATE_FLOOR`); the idle connection's two lines are counted in each turn's own
     part of a placement's log, each of the placement's turns once; and a side's record of
     aligned sections must be, byte for byte, the one `maprec.mjs` makes again from the map kept
     beside it.
   - `pack.sh` packs the tar a host gets and writes into it `kit-files.sha256` and
     `kit-trees.sha256`; `build.sh` and `run.sh` stop on a host whose files or trees are not
     those (`plan.sh`'s `kit_check`). `plan.md`, the plan as published, is put beside the kit on
     the host and is in neither list. `plan.env` carries its pad lists (`padlists.mjs --lines`).
   - `gated-env.mjs` writes the gated part's `plan.env` from the pilot's K's. A workload with no
     K gets `K_<W>=0`, which `plan.sh`, `padlists.mjs` and `pack.sh` refuse.
   - `DRYRUN=1 DRY_GATED_BASE=1` (a dry run alone; refused without `DRYRUN=1`): the gated part's
     scripts with the base as both sides, whatever part `plan.env` names. The head's binaries
     are built from `src-base`, `park.sh` holds both sides to the base's rule, and `report.mjs`
     reads the results as a dry run of the gated part. No cycle of the head is counted.

## Parts

`plan.env`'s `PART` says which part the kit runs.

1. `pilot`: for a workload, `pilot-<w>`, base-p<p_i> against base-p<q_i>, K placements in the
   order of the workload's seed. Only the base is built. `report.mjs` gives the spread, whether
   the pilot is eligible and the K the plan's rule gives.
2. `gated`: `aa-<w>` and `change-<w>` (base-p<p_i> against head-p<p_i>), back to back at each
   index of the seeded order. Declared with its K's, its seeds and its head after the pilot.

## Run it

Pack the tar from a checkout of the repository that holds `commits.env`'s commits (GNU tar, git
and node): `sh pack.sh <repository> <tar> [<gated plan.env>]`. It prints the tar's sha256.

On a fresh Debian 13 x64 host with 8 dedicated CPUs (root, nothing else running), with the tar
unpacked into `/m` (it holds `dl/`) and the plan as published copied to `/m/dl/plan.md`:

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
placement past its time limit each leave nothing recorded, for `after` that `state.mjs`
refuses made-up captures that break each part of its rule, for `beside` and `besidemt` that a
turn whose idle connection was not set up is not recorded and that `park.mjs` reads made-up
records of a server's waits as it should, and for every workload that
`report.mjs` reads made-up results as it should (`selftest/report-selftest.mjs`; it,
`node state.mjs --selftest` and `node park.mjs --selftest` need node alone and no host). Move `results/` away and build again
without `DRYRUN` before a run that counts.

A host that runs a second workload after its first: move the first's `results/` away, then
`setup.sh` and `run.sh` again with the second workload (the build is made again for it).
