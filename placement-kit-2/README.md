# The placement kit's second dry run

A test of the scripts under `bench/placement` on one host, 2026-11-25 from 13:23 to 13:53 UTC.
**It is read for nothing: no figure under this directory is a measurement of anything, and
nothing here is a reading for any pull request.** Every step built one commit of `main`,
`e2d0c464e7d7b56ea69b59c8fe7e8c9c2078d5bc`, against itself, with the kit's example probe
(`corten-run` with `json` and `compress`), and no other code.

The kit that ran is `bench/placement` as it is at `2839ccda6`
(`results/kit-sha256.txt` is its files' SHA-256s as the host had them, each the commit's). The
results here were written by that kit, and its `report.mjs` reads them: run on
`results/a-pilot/results`, `results/a-gated/results` and `results/t-pilot/results` it prints
the `report.md` kept in each. The results under the tag `evidence/placement-kit` were written
by the kit at `88c4e26cd` and are read by that commit's `report.mjs`, not by this one.

The host: 8 dedicated CPUs, an Intel Xeon Platinum 8358, Debian 13 with Linux 6.12.117, rustc
1.100.0 with LLD 23.1.5, gcc 14.2.0, perf 6.12.118, wrk 4.1.0 and Node 20.19.2. It was not a
fresh host: another run's work had prepared it (the packages `setup.sh` installs, the toolchain,
`perf_event_paranoid` -1 and `nmi_watchdog` 0), and it was idle and only borrowed, so
`setup.sh` was not run and nothing was installed. It had no git; [`go.sh`](go.sh) says how the
run was started with Debian's git package unpacked beside the checkout and with a cargo home of
its own. Before the run the load average was 0.02 and nothing else was running; a login from
the same place looked at the progress several times while turns ran, which a run that is read
does not allow.

## What ran

[`dry-run.sh`](dry-run.sh) is every step, in order; `results/dry-run.out` is what it printed and
`results/<step>.out` each step's output. The first four items ran with `DRYRUN=1`: 6 placements,
2 recorded pairs and 1 s turns.

1. **(a) The two parts of a plan**, on the kit's `example/plan.json`. The pilot part through
   `plan.mjs`, `build.sh` and `run.sh`: 12 placements linked and checked, 6 turned (36 turns),
   `complete`. `pilot.mjs` on its results: "a dry run sizes nothing". The gated part resolved
   with `--sized-from` those results, which a dry run ignores by design (its K is the dry
   run's 6), then built and run: 18 placements linked and checked, 6 of the A/A and 6 of the
   change turned (72 turns), `complete`. `report.mjs` run again on the gated results printed
   the same page, byte for byte. In those results: the counters' check before any turn
   (`preflight/counts.perf`, each above zero and at 100%), `verify/server-env.txt` (`BIN`,
   `HOME`, `PATH` and `PORT` alone), every server start's `ALLOCATOR jemalloc` in the turns'
   server logs, the probe as built with `inputs-check.txt`, `build-base.env` and
   `build-head.env`, and `host.txt` with its line on cargo's config files outside the probe
   (none).
2. **(c) The selftest**, every case, on (a)'s gated work directory
   (`results/a-gated.selftest.out`, `results/a-gated/selftest/`): `answers`, `failed`, `limit`,
   `map`, `inputs`, `refusals` and `zero`, ending `SELFTEST-OK`.
3. **A masked header with a range, through `verify.sh`** (`ranged`). The example probe's answer
   carries no header that differs between two starts, so this plan
   (`results/plans/ranged/plan.json`) starts the probe behind
   [`ranged/front.mjs`](ranged/front.mjs), a stand-in that passes every request to the probe and
   adds `age` with a value that changes from start to start, and masks `age` with the range 0
   to 7. `plan.mjs`, `build.sh` and `verify.sh` alone: the two starts sent `age: 0` and
   `age: 1`, and all 12 placements answered as their unpadded binary
   (`results/ranged/verify/`). **Nothing was turned.** It tests the kit's mask check, not any
   header of Corten's.
4. **A masked header with a range that two starts send alike** (`alike`: `content-length`,
   6124 from both): `run.sh` ended `verify-failed` before any turn. And **a plan that does not
   name its commits** (`undeclared`): `plan.mjs` refused it.
5. **(t) The sizing code on real counts. Not a dry run, and not a reading: a test of the kit,
   declared as one in its plan** (`results/plans/sizing/plan.json`). A pilot-shaped A/A of 30
   placements, 4 recorded pairs and 2 s turns (300 turns), `complete`. `pilot.mjs` at K = 30:
   eligible, both models kept, "does not pass". `plan.mjs gated ... --sized-from` those
   results scanned K from 5 and printed K = 93 with its pad lists
   (`results/t-gated.plan.out`, which has a line for each K tried). The same plan with K given
   as the number 93 (`results/plans/number/plan.json`) was checked at that K from the same
   results: "passes" (`results/n-gated.plan.out`). In both resolved plans `SIZED_MODEL` is the
   host's CPU model as `run.sh` reads it. **Neither gated part was built or run**: only their
   `plan/` directories exist. The 93 is the K of nothing: the A/A was far smaller than a pilot
   that is read, and no plan takes it.

## The files

`results/` is `<work root>/keep` as `dry-run.sh` gathered it, with `dry-run.out`, and
`results/sha256.txt` the SHA-256 of each file as the host had it. `.gitattributes` keeps every
byte as recorded: the answers' saved headers end their lines with CR LF, as they were sent.
Paths in the outputs under `/root/placement-kit-dry` are the run's one directory on the host:
`corten` the checkout, `w` the work root, `ev` this directory, `git` the unpacked git and
`cargo` cargo's home.
