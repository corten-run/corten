# Stage header checks (corten-run/corten#2002): what was measured, and with what

Base `6f1bbf0553ec3b60c884bf5855fe8786ca25f1c2` (main) against
`66fa66c49be1d60ab7ca90cb3a9a36762092c739`, the pull request's head when it was measured. The
commits after it on the branch change `changelog.d/pr-2002-1.md` alone.

## Cycles under load, across placements

`plan.md` is the plan as it stood in the pull request's description before any cycle of either
build was counted. `kit/` is what ran it (`setup.sh`, `build.sh`, `verify.sh`, `run.sh
<workload>`, `report.mjs`), without the two source trees it builds from, which are the two
commits above.

`results/<workload>/` is one measuring host each (`plain`, `browser`, `api`; a DigitalOcean c-8,
Xeon Platinum 8280, Debian 13), as the host left it:

1. `results/placements-<workload>.md` (and `.json`): the reading. Start here.
2. `results/aa-<workload>/pNN/` and `results/change-<workload>/pNN/`: a placement's
   `counts-<workload>.csv` (every recorded pair's requests and counters), `placement.txt` (the
   two binaries by sha256 and pad), `raw-<workload>.log` (every turn's perf and wrk output) and
   the comparison of the two builds' answers before its pairs.
3. `results/host.txt`, `sha256.txt`, `placements.txt`, `placements-summary.txt`, `layout/`,
   `link-*.json`: the host, the 182 binaries (the same on the three hosts) and where each
   placement's functions landed.
4. `results/verify.log`: each padded binary answering as its unpadded one.
5. `run.out`, `setup.out`, `results/run.log`, `results/progress.log`: the logs.
6. `results-dry/`, `dry.out`: a dry run of the kit before the declared run (5 pads, 2 pairs),
   marked `DRYRUN` and read for nothing.

Left out for size: the answers as received (`*.body`, `*.headers`, `*.raw-headers`) and the
per-binary directories under `verify/`. What comparing them found is kept (`bodies.txt`,
`diff.txt`, `verdict.txt`, `verify.log`).

## Instructions

`instructions/count.sh` and what it wrote on a Xeon Platinum 8280 host: callgrind over a socket
on the prototype's bench app (`bench/httparena/corten` at the tag
`evidence/stage-cost-prototype`, added to each tree) and in process
(`crates/corten/tests/router_cost.rs`), three runs a case; `answers-base/` and `answers-head/`
are each case's answer from the two builds with `Date` and `ETag` masked, and `answers.txt` says
they are the same bytes. (Git stores these files and `setup.out` with the
repository's line endings, so their CRLF reads as LF here.)

## The lines browsers send

`browser-lines/probe.sh` and `probe.out`: the `Accept-Encoding` line Playwright 1.65.1's
Chromium 159, Firefox 159 and WebKit 27.2 sent to a local server over HTTP and HTTPS on
2026-11-23.

## Checks

`checks/full-checks.out`: every command in `CONTRIBUTING.md` (Checks) at `2daf312aa`, each run
separately. `npm run check` failed there on the changelog note's length;
`npm-run-check-at-502edefb8.log` is its run after the note was shortened.
`deck-builder-smoke.log` is the one smoke that failed on that host.
