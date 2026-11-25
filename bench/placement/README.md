# Placement run kit

The scripts that run a workload **across placements**: the reading
[CONTRIBUTING.md](../../CONTRIBUTING.md#pull-requests) (Pull requests, item 2, the placement plan's
five points) and [design Choice 72](../../docs/design.md#choice-placement-runs) define. Those two
are the rule; this page says only how to run it and what each script checks. Where this page and
they differ, they are right and the kit is wrong.

A pull request's author writes one plan file, declares it as item 2 says, and runs the commands
below on a quiet Linux host. Nothing here is part of the workspace or of `corten`; it needs a POSIX
shell, Node (standard library only), `git`, `perf`, `wrk`, `curl`, a C compiler with binutils, and
the Rust toolchain the plan names, whose LLD makes every link.

## The plan file

One JSON file. `node plan.mjs <plan.json>` checks it and prints what it declares, the lines a pull
request's plan lists: K, R, the rank of the bound, both pad lists with their phases, the seed.
[`example/plan.json`](example/plan.json) is a plan of `main` against itself, with the probe in
[`example/probe`](example/probe).

| Field | What it is |
| --- | --- |
| `plan` | `1`, the format this kit reads. |
| `name` | The run's name: lowercase letters, digits and hyphens. |
| `base`, `head` | The two commits the plan reads, each a full 40-digit id. A plan without them is not declared, and `plan.mjs` refuses it. |
| `probe.dir` | The probe's crate, a path from the plan file. Its binary is named `probe`, and its `Cargo.toml` takes Corten from `../work/crates/corten`: `build.sh` puts each side's tree at `../work`. |
| `probe.tree` | The paths of the repository a side is built from (`git archive` of them at its commit); `Cargo.lock` must be among them. |
| `probe.toolchain` | The Rust toolchain, as `rustup` names it. |
| `probe.env` | The build's environment, names to text. |
| `probe.build` | The build command, run in the probe's copy. |
| `probe.binary` | The built binary under the target directory, as `release/probe`. |
| `probe.start` | The command that serves `$BIN` on `127.0.0.1:$PORT`: the allocator, its settings and the probe's configuration belong here. A workload may give a `start` of its own. |
| `host.cpuModel` | Text the host's CPU model must contain, or `null` for any. |
| `host.cpus` | `server`, `load` (a list) and `driver`: CPUs of their own for the server, `wrk`, and the driver with `perf`. |
| `load` | `threads` and `connections` of `wrk`, and a turn's `seconds`. |
| `R` | Recorded pairs per placement, after one that is not. |
| `placementSeconds` | The time limit of one placement; past it the placement is stopped and has failed. |
| `pilot` | Optional: `K` of the pilot A/A, and `why` when it is not 100. |
| `workloads[].name` | Lowercase letters. A work directory runs one workload. |
| `workloads[].declared` | What the plan says of the workload; the report prints it. |
| `workloads[].request` | `path`, `headers` (each `"Name: value"`) and optionally `script`, a `wrk` script in place of [`get.lua`](get.lua) that ends with the same `RESULT` line. |
| `workloads[].status` | The status every compared answer must have. |
| `workloads[].mask` | The header values masked when two answers are compared: `{ "header": name }`, with `"value"` or `"range": [low, high]` for one the workload's cost depends on. `[]` when none. |
| `workloads[].K` | A number from 5 to 254, or `"pilot"`: the smallest K the sizing check passes from this plan's pilot. |
| `workloads[].seed` | The seed of the order its placements run in. |
| `workloads[].reads` | The thresholds this run reads across placements: `["margin"]`, `["reduction"]` or both. One a single build already read outside its band is left out and stays as that build read it. |
| `workloads[].reduction` | The smallest worthwhile reduction as a fraction (`0.02`), or `null` when the plan declares no benefit side. |
| `workloads[].recordsSpread` | Whether the plan declares, before the run, that its A/A records a placement spread. |
| `workloads[].expect` | Optional: a file holding the exact difference between base's and head's answers that the change makes by design (the `diff` of their masked headers, and a line for bodies that differ). Without it the two must answer the same. |

The pad lists are not in the plan: `pads.mjs` gives the two lists for a K, and `plan.mjs` refuses a
K whose lists miss the fourth point's phase rules.

## The commands, in order

Run the kit from a checkout of the repository that has both of the plan's commits (`git fetch`
them into a shallow clone): `build.sh` takes each side's tree from it. A part of a plan (`pilot`
or `gated`) for one workload runs in a work directory of its own, an absolute path without white
space outside the checkout.

1. `sh setup.sh <toolchain>` once on a fresh Debian 13 host, as root: the packages, the toolchain
   and the two kernel settings `perf` needs. On another system install the same tools by hand.
2. `node plan.mjs <plan.json> <pilot|gated> <workload> <work dir>` writes `<work dir>/plan/`: the
   plan's bytes and SHA-256, the pad lists, the seeded order, the request and the mask.
3. `sh build.sh <work dir>` builds each side once, captures its final link, links every placement
   and makes every check that needs no running server. It ends with `BUILD-DONE`, or with
   `REFUSED:` and exit 3 when a side has no reading across placements.
4. `nohup sh run.sh <work dir> ><work dir>/run.out 2>&1 &` checks the host and the counters, has
   every placement answer as its unpadded binary (`verify.sh`), runs the placements in the seeded
   order (`turns.sh`) and writes the report. Leave the host alone until `run.out` ends with
   `ALL-DONE`; the line before it is `RUN-ENDED <outcome>: ...`.
5. `<work dir>/results/report.md` is the page for the pull request, `report.json` the same
   figures, and `results/` what an evidence tag keeps. `node report.mjs <results dir>` writes them
   again from the same files.

A plan in two parts, a pilot and then a gated run whose K the pilot gives:

1. Run the `pilot` part as above. `node pilot.mjs <pilot work dir>/results` prints whether the A/A
   is eligible, the models kept and the smallest K that passes the sizing check (some minutes).
2. `node plan.mjs <plan.json> gated <workload> <work dir> --sized-from <pilot work dir>/results`
   takes that K, and refuses when the pilot ran under another plan file, is not eligible or sizes
   no K. Then `build.sh` and `run.sh` on the new work directory.

With a number for K, `--sized-from <results dir>` names the eligible A/A of this kit the number was
sized from and makes the check at that K itself. `node size.mjs <results dir>/<comparison>` prints
the chance that an A/A fails at each K under each model, for an A/A of this kit or of an earlier
one (its `--reproduce` needs the sizing run's own files, which are under the tag
`evidence/placement-sizing-1999`).

`DRYRUN=1 node plan.mjs ...` makes the work directory a dry run: 6 placements, 2 pairs and 1 s
turns (`DRY_K`, `DRY_R`, `DRY_TURN`), every check live, the report headed as read for nothing. Use
it to find a plan's mistakes before the run that counts. Its turns are still turns on padded
placements of the plan's commits: where the Choice ties a pull request's next plan to any further
such turn, stop after `build.sh`, which starts nothing.

`sh selftest/selftest.sh <work dir>`, after `build.sh`, shows on that host that a wrong answer, a
failed request, a placement past its time limit and a second pad of a wrong size each stop what
they must. Name a case to run it alone (`answers`, `failed`, `limit`, `map`); `map` links and
starts nothing, the other three start the base's first placement.

## What each check proves

| Check | Where | What it shows |
| --- | --- | --- |
| The plan names its commits, thresholds and spread | `plan.mjs` | The file can be declared: base and head are full commits, each threshold is read or left, and the spread is declared or not. |
| The pad lists | `pads.mjs`, `plan.mjs` | The lists for K follow the fourth point: no size in both, the line phases and page quarters it asks. |
| One compile a side, the commit's own versions, LLD | `build.sh` | Every binary of a side is one build's link, and no dependency was resolved afresh. |
| The link run again is byte-identical | `build.sh`, `relink.mjs` | The captured link is the build's own, so a placement differs from it by its pads alone. |
| The record from the unpadded map | `map.mjs record` | Each input section of `.text` aligned beyond 16 bytes and each side's list, for the report. |
| The three refusals | `map.mjs refuse`, `build.sh` | A side the fifth point gives no reading across placements stops before anything is linked or turned. |
| Functions moved by the pad | `layout.mjs` | A placement has its side's functions and the pad, the pad first, each moved by the pad, neighbours in order. |
| The second pad | `build.sh`, `map.mjs data` | With aligned code, the smallest of 16, 32, 48 and 64 bytes that puts `.data` where the rule says, with a line a placement. |
| The map check | `map.mjs check` | With aligned code, the placement's map against the unpadded link's by LLD's layout rule, in place of "moved by the pad". |
| Distinct SHA-256s | `build.sh` | No two placements of one build are one binary. |
| The host and the counters | `run.sh` | The plan's CPU model and CPUs, and every counter at 100% for an attached process, before any turn. |
| The mask | `verify.sh`, `mask.mjs` | A masked value differs between two starts of one binary; a stated one has its value or range. |
| Answers | `verify.sh`, `turns.sh` | Each placement answers as its unpadded binary, and a placement's two binaries alike, before its turns. |
| Turns | `turns.sh` | Every turn on a fresh start on the server's CPU; a failed request or a counter under 100% fails the placement, and nothing is run again. |
| The results are the plan's run | `report.mjs` | Refuses results whose plan, pads, order, binaries or records are not what the plan gives. |
| Eligibility and K | `pilot.mjs` | The A/A may size a run, and the K passes under each model kept, at that K itself. |

`report.md` states, for each threshold the plan declares, pass, miss, not resolved or no bound, or
that this run does not read it; both readings of the A/A; the benefit side when one is declared;
whether the A/A records a spread; every measure across placements; every placement; and each
side's aligned sections, its list and the second pads' lines.

## What it does not do

1. It does not declare a plan. Posting the plan on the pull request or issue, or pushing it under
   a tag, before the run is the author's; the kit records the plan file's SHA-256 in every result.
2. It does not test a single build's reading against a recorded spread or the default band, or
   check that a run's setup matches a recorded spread's. `reads` is the author's statement of
   which thresholds that test left inside.
3. It records no spread: a pull request that changes the Choice does.
4. It reads a probe that Cargo builds and names `probe`, not the image
   `bench/fullstack/count.mjs` starts.
5. It cannot see how the C code a side links was built: the plan's `probe.env` and `probe.build`
   and each side's captured link line are in the results for a reviewer to read.
6. A work directory holds one workload's part and builds its sides itself, so two workloads of a
   plan are two builds of each commit.
7. It does not check that the host is quiet or that its CPUs are whole cores: `results/host.txt`
   records `lscpu` and the thread siblings.
8. Item 2's affected-route, memory and waiting measurements are other tools'.

## Tests

`npm run check` runs `pads.test.mjs`, `stats.test.mjs`, `map.test.mjs` and `report.test.mjs`
without a bench host. Two of them read earlier runs' kept files where they are kept, under the
tags `evidence/placement-sizing-1999` (an A/A's counts) and `evidence/placement-aligned-code-6`
(the maps), which are too large for `bench/`; in a checkout without those tags they fail with the
`git fetch` that brings them ([`tags.mjs`](tags.mjs)).
