# The deadline timer's cycle run: the kit as its pilot runs it, and what was tried before it

Evidence for
[#2029 Keep one deadline timer for a connection's requests](https://github.com/corten-run/corten/pull/2029),
put here on 2026-11-25 (UTC), before the plan of its cycle run was posted on the pull request, so
that the plan can name the kit it runs. The base is `main` at
`26ab0e37f753ffc4f9418bc28ad7825a924d08e1` and the head is the pull request at
`f8934bc998a7609728826c106cfc57fdd1aef3dd`, which holds that base. Nothing under
`deadline-timer/`, `deadline-timer-2/`, `deadline-timer-3/` or `deadline-timer-4/` is changed.

**No pilot and no gated turn has run.** Nothing here is a reading under `CONTRIBUTING.md` (Pull
requests, item 2) or design Choice 72, and nothing here sizes or decides anything in the plan. No
machine's name, address or region is kept here.

## `kit/`: the kit, file for file what the pilot runs

The kit `cycles-deadline-2029-3`: every file of the tar a measuring host unpacks for its dry runs
and its pilot, but the base's source tree (`src-base/`, which is `git archive
26ab0e37f753ffc4f9418bc28ad7825a924d08e1 crates examples Cargo.toml Cargo.lock .cargo` and is
left out here as the repository's own). `README.md` in it says what each file is and where it
came from.

1. The tar: sha256 `c70b37987861adc8e7aa0fd089a8a3945a316c437ebe725d93dcf8981a5be632`,
   14,899,200 bytes. `sh pack.sh <a checkout of the repository> <tar>` run in `kit/` with GNU tar
   makes it again; it was packed to the same bytes on two systems (`trial/trial-2.out`, step C).
2. `kit-files.sha256` lists every file of the tar outside `src-base/` but itself, and
   `sha256sum -c kit-files.sha256` in `kit/` passes on these files. Its own sha256 is
   `789c07948922a3e8b7eccac1df4ec72819b74fc88008d873df97196081c8a12f`.
3. `kit-trees.sha256` has the base's source tree:
   `471dc06bf5d7cc16e36c5a87f72e9b43c48213efb307fa5f5b779882372211ab` (the sha256 of the sorted
   `sha256sum` lines of its files).
4. `commits.env` and `plan.env` are the pilot's: the two commits, K = 100 for each of seven
   workloads, the seeds and the pad lists. The sha256 of the two, `plan.env` first, is
   `29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874`.

On a host `build.sh` and `run.sh` stop if a file of the kit or a side's source tree is not the one
these lists name. The plan as published is not in the tar or here: it names this tag.

Three self-tests of the kit need node alone: `node state.mjs --selftest` (19 cases),
`node park.mjs --selftest` (22) and `node selftest/report-selftest.mjs` (52).

## `look/`: both sides' link maps, looked at once (2026-11-25, 15:05 to 15:10)

The base and the head as it then was, `850d39ac7894b95ca367e9bf569c92de3c4b3b89` (`base.commit`,
`head.commit`; the two commits the head has gained since change nothing a release build compiles),
each built once with the kit's probe in the `rust:1-trixie` image on a machine that is not one of
the plan's hosts. No counter was read.

1. `maps/base.map.gz`, `maps/head.map.gz`: LLD's map of each side's unpadded link.
   `aligned-base.txt`, `aligned-head.txt`: the record `maprec.mjs` writes from each: 3,364 and
   3,371 input sections of `.text`, none aligned beyond 16 bytes.
2. `look.out`: the second run's output, with the head's probe started in each of its two
   configurations and `idle.mjs`'s connection held beside 200 requests for `/private`
   (`idle-plain.txt`, `idle-plain-mt.txt`, `serve-plain.log`, `serve-plain-mt.log`). Those servers
   ran on glibc's allocator, not the jemalloc a turn preloads.

Left out: the first run's output. It ran the map record and the idle connection's steps where
there was no node and no `readelf`, and both failed there; `look.out` is the same steps run again
in containers.

This is not the record the plan's fifth point asks for: that one is made on each measuring host
from the build that is measured.

## `trial/`: the kit tried in a container (2026-11-25, about 18:00 to 18:22)

On a machine of 16 CPUs that is not one of the plan's hosts
(`dry-gated-base-results/host.txt` has what it reported of itself), in a privileged container of
the `rust:1-trixie` image, to show that the kit's newest parts work before the plan declares
them. `trial.out` and `trial-2.out` are what the two passes printed, each step under a line that
begins `==`.

1. **A dry run of the gated part's scripts with the base as both sides**
   (`DRYRUN=1 DRY_GATED_BASE=1`, workload `beside`: 3 placements a comparison, 2 recorded pairs,
   1 s turns): `setup-A.log`, `run-A.out`, `selftest-A.log` and `dry-gated-base-results/`, the
   results as `run.sh` left them, with `report.mjs` run on them once more after `park.mjs` was
   corrected. **This counted cycles and instructions of the base alone, built twice, and none of
   the head.** It is a test of scripts and is read for nothing.
2. **Watched turns on the base and on the head** (`park.sh`, 3 s turns, `strace` on the server,
   no counter read): `park6-beside/`, `park6-besidemt/`. `build-B.log` is the build they ran on,
   made from a tar with made-up K's: the base and the head `f8934bc99`, 3,364 and 3,371 input
   sections of `.text`. The base's waits that can block all had no timeout; the head's all had one
   of 25,253 to 28,458 ms. `park6-besidemt-base-as-both/` is the same on the base built twice.
3. `threads.txt`: each side's threads by name in each of the probe's two configurations, started
   as the kit starts a server (`threads.sh`).
4. `trial-2.out`, step C: the pilot's tar packed again from the kit's files by GNU tar 1.35, to
   the same sha256.

Two things failed in it before it passed, and the kit was corrected before this tag. The first
pass of all stopped at once because the kit's check of its own files compared checksum lines that
two systems write differently; its output was written over by the next pass and is not kept. In
`trial.out` the watched turns of `besidemt` fail on a wait given a timeout of 0, which
`park.mjs` could not read then; `trial-2.out` is those turns again with the kit as it is here.

Left out: the two scripts that drove the passes from outside the container. In two lines of
`trial.out` the name of the directory the trial ran in is replaced by `/work`.

## `tests/`: the deadline's tests against broken rules, on this head (2026-11-25, 18:23 to 18:30)

`cargo test -p corten-run --all-features --lib -- tests::server deadline` on the tree of
`f8934bc998a7609728826c106cfc57fdd1aef3dd` as it is and with one rule broken at a time by
`deadline-timer-4/after-review/first/mut.py`. `queue.log` has each run's result line and
`test-*.log` each run's whole output. M22 (a connection's first number is one of the states) was
run ten times from one build and failed in all ten, the test
`the_first_number_a_connection_is_given_is_none_of_the_states` among the failures each time.
`queue.sh` is the script as it ran, but that the name of the directory it ran in is replaced by
`/work`, and the labels it gave its containers and two words of its first comment that named the
machine are taken out.
