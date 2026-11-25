# The placement kit's dry run

A test of the scripts under `bench/placement` on one host, 2026-11-25 (UTC). **It is read for
nothing: no figure under this directory is a measurement of anything.** Every plan part was
resolved with `DRYRUN=1`, so 6 placements, 2 recorded pairs and 1 s turns, where the rule the kit
runs asks far more of a run that is read.

The kit that ran is this commit's `bench/placement`, its files as they are at `88c4e26cd`
(`results/a-gated/results/kit-sha256.txt` is their SHA-256s as the host had them). The host: 8
dedicated CPUs, an Intel Xeon Platinum 8358, Debian 13 with Linux 6.12.117, rustc 1.100.0 with
LLD 23.1.5, gcc 14.2.0, perf 6.12.118, wrk 4.1.0 and Node 20.19.2, prepared by the kit's
`setup.sh 1.100.0`. The setup's log is not kept, since it names the host's package mirror.

## What ran

[`dry-run.sh`](dry-run.sh) is every step, in order; `results/dry-run.out` is what it printed and
`results/<step>.out` each step's output.

1. **(a) `main` against itself**, `e2d0c464e` as base and head, on the kit's
   `example/plan.json`: the pilot part and then the gated part, each through `plan.mjs`,
   `build.sh` and `run.sh`. Every check ran and every placement was turned: 6 placements of the
   pilot's A/A, then 6 of the A/A and 6 of the change. Both runs ended `complete`. The reports
   are `results/a-pilot/results/report.md` and `results/a-gated/results/report.md`.
2. **(c) What must stop a placement**, on (a)'s gated work directory
   (`results/a-gated.selftest.out`): a wrong answer stopped the placement before any turn, a
   turn with failed requests recorded nothing, and a placement past its time limit was stopped.
3. **(b) A head with code aligned beyond 16 bytes**, [`b/plan.json`](b/plan.json): base
   `e2d0c464e` against `498291116`, the head the tag `evidence/request-gzip-1971-placed`
   measured, whose `compress` feature links libdeflate. **Linked and checked only: nothing was
   started.** `plan.mjs` and `build.sh` ran, and the selftest's `map` case; `verify.sh`, `run.sh`
   and `turns.sh` did not. No server ran from any of its binaries, no request was sent to one and
   no counter was read, so no cycle was counted on a padded placement of that head.
   `results/b.build.out` has each side's record (0 input sections of `.text` aligned beyond 16
   bytes on the base, 18 on the head), no refusal on either side, and a second pad's line for
   each of the 18 placements; `results/b/bin/layout/` each placement's map check and function
   check; `results/b/maps/` each side's unpadded map and every placement's.
   `results/b.selftest.out` shows the map check refusing a second pad of 8 bytes and each of the
   four sizes that puts `.data` elsewhere.
4. **A mask that does not hold**, `mask/plan.json`: the example plan with `etag` masked, a
   header this probe's answer does not carry. `run.sh` ended `verify-failed` before any turn
   (`results/mask.run.out`).
5. **A plan that does not name its commits**, `undeclared/plan.json`: `plan.mjs` refused it
   (`results/undeclared.plan.out`).

The two plans of 4 and 5 are as `dry-run.sh` wrote them from the example plan, beside copies of
the example probe, which are not kept twice.

## The files

`results/` is `<work root>/keep` as `dry-run.sh` gathered it, less `setup.log`, and
`results/sha256.txt` the SHA-256 of each file as the host had it. `.gitattributes` keeps every
byte as recorded: the answers' saved headers end their lines with CR LF, as they were sent.
Paths in the outputs (`/m/corten`, `/m/w`, `/m/ev`) are the host's checkout, work root and this
directory.
