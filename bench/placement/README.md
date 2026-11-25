# Placement run kit

The scripts that run a workload **across placements**: the reading
[CONTRIBUTING.md](../../CONTRIBUTING.md#pull-requests) (Pull requests, item 2, the placement plan's
five points) and [design Choice 72](../../docs/design.md#choice-placement-runs) define. Those two
are the rule; this page says only how to run it and what each script checks. Where this page and
they differ, they are right and the kit is wrong.

A pull request's author writes one plan file, declares it as item 2 says, and runs the commands
below on a quiet Linux host. Nothing here is part of the workspace or of `corten`; it needs a POSIX
shell and its tools, GNU coreutils (`env -i`, `timeout`, `sha256sum -c`, `stat -c` and a `sleep`
that takes fractions of a second), `taskset`, `gzip`, `tar`, Node (standard library only), `git`,
`perf`, `wrk`, `curl`, a C compiler with binutils, and the Rust toolchain the plan names, whose LLD
makes every link. [What is this host's alone](#what-is-this-hosts-alone) lists what the scripts
assume beyond that.

## The plan file

One JSON file. `node plan.mjs <plan.json>` checks it and prints what it declares, the lines a pull
request's plan lists: K, R, the rank of the bound, both pad lists with their phases, the seed, and
the SHA-256 of the list of files the plan names by path. [`example/plan.json`](example/plan.json)
is a plan of `main` against itself, with the probe in [`example/probe`](example/probe). A field
that is not in this table is refused, so a misspelled field is not read as one left out.

| Field | What it is |
| --- | --- |
| `plan` | `1`, the format this kit reads. |
| `name` | The run's name: lowercase letters, digits and hyphens. |
| `base`, `head` | The two commits the plan reads, each a full 40-digit id. A plan without them is not declared, and `plan.mjs` refuses it. |
| `probe.dir` | The probe's crate, a path from the plan file. Its binary is named `probe`, and its `Cargo.toml` takes Corten from `../work/crates/corten`: `build.sh` puts each side's tree at `../work`, and each side's `Cargo.lock` in the crate's copy, so the directory holds none of its own. It holds no symbolic link and is not one: `plan.mjs` refuses a link, since what it points at lies outside what the plan names. |
| `probe.tree` | The paths of the repository a side is built from (`git archive` of them at its commit); `Cargo.lock` must be among them. |
| `probe.toolchain` | The Rust toolchain, as `rustup` names it. |
| `probe.env` | The build's environment, names to text. The build sees these, `PATH`, `HOME`, where `rustup` and `cargo` keep their files, the toolchain and the kit's own three variables, and nothing else of the shell `build.sh` is run from. |
| `probe.build` | The build command, run in the probe's copy. |
| `probe.binary` | The built binary under the target directory, as `release/probe`. |
| `probe.start` | The command that serves `$BIN` on `127.0.0.1:$PORT`: the allocator, its settings and the probe's configuration belong here, since a server sees `PATH`, `HOME`, `PORT` and `BIN` and nothing else of the shell `run.sh` is run from. A workload may give a `start` of its own. |
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
| `workloads[].mask` | The header values masked when two answers are compared: `{ "header": name }`, with `"range": [low, high]` for one the workload's cost depends on. `[]` when none. Every masked header must differ between two starts of the base, and one with a range (`low` under `high`) must also be within it in every answer; a single stated value could not do both, so the kit takes a range alone. A header with a range that the two starts send alike stops the run at `verify.sh`: see [what it does not do](#what-it-does-not-do), item 12. |
| `workloads[].K` | `"pilot"`, the smallest K the sizing check passes from this plan's pilot, or a number from 5 to 254. |
| `workloads[].sizedFrom` | With a number for K, and only then: which eligible A/A the number was sized from, in words a reader can follow to it (where it is kept, its run, its comparison). The declaration and the report print it. |
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
   plan's bytes and SHA-256, the pad lists, the seeded order, the request, the mask, and
   `inputs.sha256`, each file the plan names by path (the probe's files, the request script, the
   expected answer) with its SHA-256. The plan file's SHA-256 covers those paths and not what is
   at them, so the list's own SHA-256 is printed with the declaration and declared with it.
3. `sh build.sh <work dir>` checks its copy of the probe against that list, builds each side once,
   captures its final link, links every placement and makes every check that needs no running
   server. It ends with `BUILD-DONE`, or with `REFUSED:` and exit 3 when a side has no reading
   across placements.
4. `nohup sh run.sh <work dir> ><work dir>/run.out 2>&1 &` checks the host and the counters, has
   every placement answer as its unpadded binary (`verify.sh`), runs the placements in the seeded
   order (`turns.sh`) and writes the report. Leave the host alone until `run.out` ends with
   `ALL-DONE`; the line before it is `RUN-ENDED <outcome>: ...`.
5. `<work dir>/results/report.md` is the page for the pull request, `report.json` the same
   figures, and `results/` what an evidence tag keeps: the probe's source as built, the request
   script and each build's environment among it. `node report.mjs <results dir>` prints the page
   again and writes `report.json` again, from the same files.

A part is run once. `run.sh` refuses a work directory that already holds results, and the rule's
"no placement is rerun, replaced or dropped for its result" goes further than a script can see:
that a part of a plan has not been run before, in another work directory or on another host, is
the author's to keep, and so is keeping every run's results, a failed run's included.

A plan in two parts, a pilot and then a gated run whose K the pilot gives:

1. Run the `pilot` part as above. `node pilot.mjs <pilot work dir>/results` prints whether the A/A
   is eligible, the models kept and the smallest K that passes the sizing check. The scan takes
   minutes and prints each K it tries on standard error.
2. `node plan.mjs <plan.json> gated <workload> <work dir> --sized-from <pilot work dir>/results`
   takes that K, and refuses when the pilot ran under another plan file or on other files than
   the plan now names by path, is not eligible or sizes no K. Then `build.sh` and `run.sh` on the
   new work directory, on a host of the pilot's CPU model: `run.sh` refuses another.

With a number for K the plan's `sizedFrom` says which A/A it was sized from. When that A/A is
results of this kit, `--sized-from <results dir>` checks the number: the A/A must be eligible, K
must pass at that K itself, and the A/A's request, start command, load, mask, build command,
build's environment, probe and request script must be this plan's, or `plan.mjs` refuses (item 11
of [what it does not do](#what-it-does-not-do) lists what is not compared). The report takes
what `plan.mjs` saved of that check (`sized` in `plan/resolved.json`) as written, since the A/A is
not among a run's results: a reviewer checks it by running the same `node plan.mjs <plan.json>
gated <workload> <a new directory> --sized-from <the A/A's results>` and comparing the counts it
prints with the report's. Without `--sized-from` nothing checks the
number, as when it was sized from an earlier kit's A/A: `report.json` then has `"sized": null`,
and every reading on the page is followed by "K not checked by the kit", so the page never prints
a bare pass for a K the kit did not check. Showing that such a K meets the sizing rule is the
author's. `node size.mjs <results dir>/<comparison>` prints the chance that an A/A fails at each K
under each model, for an A/A of this kit or of an earlier one.

`DRYRUN=1 node plan.mjs ...` makes the work directory a dry run: 6 placements, 2 pairs and 1 s
turns (`DRY_K`, `DRY_R`, `DRY_TURN`), every check live, the report headed as read for nothing. Use
it to find a plan's mistakes before the run that counts. Its turns are still turns on padded
placements of the plan's commits: where the Choice ties a pull request's next plan to any further
such turn, stop after `build.sh`, which starts nothing.

`sh selftest/selftest.sh <work dir>`, after `build.sh`, shows on that host that a wrong answer, a
failed request, a placement past its time limit, a second pad of a wrong size, files that are no
longer what `plan.mjs` listed, a run `run.sh` must refuse and a counter that read zero each stop
what they must. Name a case to run it alone (`answers`, `failed`, `limit`, `map`, `inputs`,
`refusals`, `zero`). `map`, `inputs` and `refusals` start no server; `answers`, `failed`, `limit`
and `zero` start the base's first placement. `inputs`, `refusals` and `zero` run `build.sh` and
`run.sh` on copies of the plan under `<work dir>/selftest`, so they build nothing and leave the
work directory's own build and results alone; `zero` puts a stand-in for `perf` that reports 0
first on `PATH`.

## What each check proves

| Check | Where | What it shows |
| --- | --- | --- |
| The plan names its commits, thresholds and spread | `plan.mjs` | The file can be declared: base and head are full commits, each threshold is read or left, the spread is declared or not, and it has no field the kit does not read. |
| The files the plan names by path | `plan.mjs`, `build.sh`, `run.sh`, `report.mjs` | The probe that is built, the request script and the expected answer are, file for file, the ones listed when the plan was resolved, with no file or symbolic link more, and the results keep them. |
| The pad lists | `pads.mjs`, `plan.mjs` | The lists for K follow the fourth point: no size in both, the line phases and page quarters it asks. |
| One compile a side, the commit's own versions, LLD | `build.sh` | Every binary of a side is one build's link, and no dependency was resolved afresh. |
| The environment | `build.sh`, `turns.sh`, `verify.sh` | A build and a server see what the plan gives them and not the calling shell's variables (`env -i`); `build-<side>.env` and `verify/server-env.txt` in the results are what they saw. |
| The link run again is byte-identical | `build.sh`, `relink.mjs` | The captured link is the build's own, so a placement differs from it by its pads alone. |
| The record from the unpadded map | `map.mjs record` | Each input section of `.text` aligned beyond 16 bytes and each side's list, for the report. |
| The three refusals | `map.mjs refuse`, `build.sh` | A side the fifth point gives no reading across placements stops before anything is turned: for a section aligned beyond 64 bytes or a Rust-named section, before any placement is linked; for a placement none of the four second pads fits, as the placements are linked. |
| Functions moved by the pad | `layout.mjs` | A placement has its side's functions and the pad, the pad first, each moved by the pad, neighbours in order. |
| The second pad | `build.sh`, `map.mjs data` | With aligned code, the smallest of 16, 32, 48 and 64 bytes that puts `.data` where the rule says, with a line a placement. |
| The map check | `map.mjs check` | With aligned code, the placement's map against the unpadded link's by LLD's layout rule, in place of "moved by the pad". |
| Distinct SHA-256s | `build.sh` | No two placements of one build are one binary. |
| The host and the counters | `run.sh` | The plan's CPU model and CPUs, the CPU model of the A/A a K was checked from, and every counter above zero and at 100% for an attached process, before any turn. |
| The mask | `verify.sh`, `mask.mjs` | Every masked value differs between two starts of the base's unpadded binary; one with a stated range is also within it in every answer. A masked header the two starts send alike stops the run, with a range or without. |
| Answers | `verify.sh`, `turns.sh` | Each placement answers as its unpadded binary, and a placement's two binaries alike, before its turns. |
| Turns | `turns.sh` | Every turn on a fresh start on the server's CPU; a failed request, or a counter that is zero or under 100%, fails the placement, and nothing is run again. |
| The results are the plan's run | `report.mjs` | Refuses results whose plan, pads, order, binaries, records or files named by path are not what the plan gives. |
| Eligibility and K | `pilot.mjs`, `plan.mjs --sized-from` | The A/A may size a run, on this plan's setup as far as item 11 below compares it, and the K passes under each model kept, at that K itself. A K nothing checked is said to be unchecked in every reading. |

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
5. It cannot see how the C code a side links was built: the plan's `probe.env` and `probe.build`,
   each build's environment and each side's captured link line are in the results for a reviewer
   to read. Cargo's own config files outside the probe (`$CARGO_HOME/config.toml`, a
   `.cargo/config.toml` in a directory above the work directory) are read by a build and are in
   neither that environment nor the list of files: `results/host.txt` names the ones that exist
   when `run.sh` runs, and the kit checks none of them.
6. A work directory holds one workload's part and builds its sides itself, so two workloads of a
   plan are two builds of each commit.
7. It does not check that the host is quiet or that its CPUs are whole cores: `results/host.txt`
   records `lscpu` and the thread siblings.
8. Item 2's affected-route, memory and waiting measurements are other tools'.
9. It does not check a K given as a number unless `plan.mjs` is given results of this kit to check
   it from (`--sized-from`). Without them it prints what the plan's `sizedFrom` says and marks
   every reading "K not checked by the kit"; whether that K meets the sizing rule is then the
   author's to show and a reviewer's to check.
10. It does not know whether a part of a plan has been run before. It refuses a work directory
    that already holds results; a second run in another work directory or on another host, or
    results thrown away, it cannot see. Running each part once and keeping what it left is the
    author's.
11. It compares an A/A's setup with a plan's only so far. For a K from the plan's own pilot: the
    workload, the plan file and the files it names by path, which is everything a plan says, and
    the CPU model.
    For a K given as a number, whose A/A may be another plan's: the workload's name, R, the
    request, the start command, the load, the mask, the build command and the build's
    environment, the probe's files and the request script, and the CPU model. Not compared for a
    number, and so a reviewer's to compare from the two plans and `results/host.txt`: the base
    and the head (an A/A read earlier is on an earlier base by the rule's design, so the base
    cannot be asked to match), the tree's paths, the toolchain, the pinned CPUs, the status the
    answers must have, the time limit, the expected answer (an A/A has none), and what no plan
    says: the kernel, the host's settings and its neighbours.
12. It shows that a masked header differs between two starts of the base's unpadded binary, not
    of every binary. And it takes "can differ between starts" as "did differ between those two
    starts": a header with a range that can differ and did not in the two starts the kit made
    stops the run at `verify.sh`, before any turn, though the rule's own example (`kept` and
    `Age`) may be such a header. The author can leave it out of the mask when the workload always
    sends that value; whether a range may stand on the plan's word when two starts agree is a
    question for the rule, which the kit does not answer.
13. `report.mjs` takes each recorded turn's counters and `wrk` result from the counts `turns.sh`
    wrote after checking them; it does not read the raw turn logs again.

## What is this host's alone

The scripts assume, and nothing in a plan changes: an x86-64 Linux host (a pad is bytes of `int3`,
`0xcc`); ports 18081 and 18082 on 127.0.0.1 for a placement's two servers and 18083 for
`verify.sh`'s, free when a run starts; `cc` on `PATH` as the C compiler that assembles the pads
and that `rustc` links through (`wrap/cc` runs `/usr/bin/cc` after recording the link); a probe
binary named `probe`; `/proc/cpuinfo` for the CPU model; and, for `setup.sh` only, Debian 13's
package names. `get.lua` and a plan's own script are `wrk`'s Lua.

## Carried files

`pads.mjs` and `link-capture.mjs` are the placement sizing kit's files byte for byte (tag
`evidence/placement-sizing-1999`), `get.lua` is the one under the tag `evidence/deadline-timer-2`,
and `model.mjs` and `size.mjs` are the sizing kit's files but for one comment line each, so that
`git diff` against that tag shows the pad generator, the models and the reader that the Choice's
figures came from are the ones this kit runs. That is why they keep
what this kit does not use: `pads.mjs --check` and its header speak of that kit's `plan.env`, and
`size.mjs --reproduce` needs that tag's `prior/` files. `stats.mjs` and `pilot.mjs` began as the
files of those names under the tag `evidence/deadline-timer-2`; about a fifth of each is carried.

## Tests

`npm run check` runs `pads.test.mjs`, `stats.test.mjs`, `map.test.mjs` and `report.test.mjs`
without a bench host. Two of them read earlier runs' kept files where they are kept, under the
tags `evidence/placement-sizing-1999` (an A/A's counts) and `evidence/placement-aligned-code-6`
(the maps), which are too large for `bench/`; in a checkout without those tags they fail with the
`git fetch` that brings them ([`tags.mjs`](tags.mjs)).

Those tests run no shell script, so what `build.sh`, `run.sh`, `verify.sh` and `turns.sh` refuse
is held by the selftest alone, on a host that has `perf` and `wrk`, and by nothing in
`npm run check`. The selftest's `inputs` case holds `build.sh`'s three checks of the files named
by path and `run.sh`'s two, `refusals` holds `run.sh`'s refusal of results already there, of
binaries built for another part and of another CPU model, and `zero` holds the above-zero test
of the counters before a run and in a turn. Held by a whole run on a host and by no case: the
counters at 100% and the refusal of one under it, the answers of every placement against its
unpadded binary, a masked header that does differ between two starts, and the probe's source
and each build's environment reaching the results.

Two dry runs of the kit are kept, each read for nothing. The results under the tag
`evidence/placement-kit-2` were written by the kit at `2839ccda6`, on a host with `perf` and
`wrk`, and `node report.mjs` reads them. Those under `evidence/placement-kit` were written by
the kit at `88c4e26cd`, before a run's results held the list of files the plan names by path:
the `report.mjs` of that commit reads them, and this one refuses them, as it refuses any
results without that list.
