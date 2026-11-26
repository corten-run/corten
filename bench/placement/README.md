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
| `probe.start` | The command that serves `$BIN` on `127.0.0.1:$PORT`: the allocator, its settings and the probe's configuration belong here, since a server sees `PATH`, `HOME`, `PORT` and `BIN` and nothing else of the shell `run.sh` is run from. It must be, or `exec`, the process that listens: the kit stops the process the command is and nothing it started, so a command that starts the server and waits (a shell that does not `exec` it, say) can end on TERM and leave the server listening, and `verify.sh` fails when anything still accepts on its port after a stop. A workload may give a `start` of its own. |
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
| `workloads[].reads` | The thresholds this run reads across placements: `["margin"]`, `["reduction"]` or both. One a single build already read outside its band is left out and stays as that build read it, but for the margin of a workload read for the catalog's `page` or `json`: see [what it does not do](#what-it-does-not-do), item 14. |
| `workloads[].reduction` | The smallest worthwhile reduction as a fraction (`0.02`), or `null` when the plan declares no benefit side. |
| `workloads[].recordsSpread` | Whether the plan declares, before the run, that its A/A records a placement spread. |
| `workloads[].expect` | Optional: a file holding the exact difference between base's and head's answers that the change makes by design, as `turns.sh` writes it to `answers/diff.txt`: the `diff` of their masked headers (empty when those are the same), then one bodies line, `bodies differ: <A> and <B> bytes, sha256 <A's> and <B's>` when the bodies differ and `bodies same: <N> bytes, sha256 <its>` when they do not, each SHA-256 in full. `turns.sh` compares the two files byte for byte, so an expected difference binds the header lines that differ, every other header line to being the same on both sides, and both bodies by their lengths and SHA-256s, whether the bodies differ or not. `plan.mjs` refuses one that does not end with exactly one bodies line of those two forms, and a `bodies same` line alone, which `turns.sh` writes only after the headers' diff. Without it the two must answer the same, and `diff.txt` is empty. Whether the two differ is what `diff` and `cmp` report, not what `diff.txt` holds: a difference either reports that `diff.txt` does not hold fails the placement as missing evidence. |

The pad lists are not in the plan: `pads.mjs` gives the two lists for a K, and `plan.mjs` refuses a
K whose lists miss the fourth point's phase rules.

The bodies line took its SHA-256s, and a difference in the headers alone its `bodies same` line, in
[#2152 A plan's expected difference holds a placement to its bodies' lengths, not to the bodies](https://github.com/corten-run/corten/issues/2152).
An expected difference written before then has the lengths alone, or no bodies line when the
bodies were the same, and `plan.mjs` now refuses both: record it again. Kept results are read as
the kit they ran under compared their answers, and their `kit-sha256.txt` names that kit's
files: results of an earlier kit were held to the bodies' lengths, or to no body when the headers
alone differed, not to the bodies.

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

A dry run does not reach the path a gated part takes at a sized K: it takes its K from `DRY_K`
and ignores `--sized-from`, so it sizes nothing and checks no K, and nothing of it shows that a
gated part binds to its pilot, that the K passes, or that `build.sh`, `run.sh` and `report.mjs`
take a part of that size. Resolving the gated part without `DRYRUN` shows the first two and
builds nothing. Only a run shows the third, and a part that is read is run once, so a fault met
there is not mended by running it again. The kit has gone down that path once, in a test read
for nothing ([Tests](#tests) says what that run was and what no run has shown).

`sh selftest/selftest.sh <work dir>`, after `build.sh`, shows on that host that a wrong answer
(and, under the difference it made as the expected one, a third body of its length, and the
probe's own body under other headers, whose difference ends with its `bodies same` line), a
failed request, a placement past its time limit, a second pad of a wrong size, files that are no
longer what `plan.mjs` listed, a run `run.sh` must refuse and a counter that read zero each stop
what they must. Name a case to run it alone (`answers`, `failed`, `limit`, `map`, `inputs`,
`refusals`, `zero`). `map`, `inputs` and `refusals` start no server; `answers`, `failed`, `limit`
and `zero` start the base's first placement. `inputs`, `refusals` and `zero` run `build.sh` and
`run.sh` on copies of the plan under `<work dir>/selftest`, so they build nothing and leave the
work directory's own build and results alone; `zero` puts a stand-in for `perf` that reports 0
first on `PATH`.

## The trend

`main` is read against the last release with this kit, so that costs that each passed do not
add up unseen ([CONTRIBUTING.md](../../CONTRIBUTING.md#pull-requests), Pull requests, item 2.1,
Trend). It has one plan, [`trend/plan.json`](trend/plan.json), one command and one page,
[`trend/README.md`](trend/README.md), which holds a row a run. On a quiet Linux host prepared as
above (`setup.sh` on a fresh Debian 13 host), in a full clone that has `main` and the release
tags as the remote has them:

```sh
git fetch --tags origin "+refs/heads/main:refs/remotes/origin/main"
nohup node bench/placement/trend.mjs <run dir> ><run dir>.out 2>&1 &
```

The fetch names both ends of `main`, so it brings `origin/main` up to date in a clone that
tracks another branch alone, where `git fetch origin main` leaves it as it was. `<run dir>` is a
directory the command makes: an absolute path without white space, outside the checkout by
where it really is (a link is followed), not there yet, in a directory that is. Leave the host
alone until the command ends. The row is then in `trend/README.md`, to be committed as it is,
and `<run dir>` is what its figures are read from, to be kept as any run's results are.

The trend's plan is a plan as [the plan file](#the-plan-file) above, less what only a run can
give, with the rules that give it. A field that is not in this table is refused.

| Field | What it is |
| --- | --- |
| `trend` | `1`, the format `trend.mjs` reads. |
| `base` | `"release"`: the commit of the highest tag `vX.Y.Z` the checkout has when the run starts. |
| `head` | A remote's branch, `origin/main`, read as the checkout has it when the run starts. |
| `seed` | `"date"`: a workload's seed is the run's date in UTC as `YYYYMMDD` and then its place in the plan as two digits (2026120201 for the first workload of a run of 2026-12-02), so each run has seeds of its own and nobody chooses one after a result. One run a date: the date names the run's plan too, so a run whose date is not later than every row of the page is refused, and a plan has at most 99 workloads. That is the page in the run's checkout: nothing reserves a date across checkouts or between two runs made at once. |
| `threshold` | The rise the trend reports, as a fraction (`0.02`), read on the lower bound. |
| `plan` | The plan, without `base`, `head` and each workload's `seed` and `expect`. Every workload's K is `"pilot"`: each run sizes K from its own pilot. `probe.dir` is a path from the trend's plan file and may lead out of its directory, since the run copies the probe beside its own plan. It copies nothing else, so no workload names a `request.script`. Each workload's `declared` says why it is in the trend and what it does not read. |

Before anything is made or run the command refuses, with exit 2: a run directory that is not as
above, a shallow checkout (the commits `main` merged since a row cannot all be listed from one)
or a partial one (a remote whose `promisor` is true, or `extensions.partialClone`: it lacks
objects and fetches them as they are read, so a run would build and list from what it does not
hold; the command's own git calls are made with `GIT_NO_LAZY_FETCH=1`, so one the check
misjudges fails at the object it lacks), a plan that cannot be read or used or whose probe is not
there, a page that is not the table the command writes with its rows newest first, or whose
newest row is of today's date or a later one (a dry run, which adds none, is not refused for
the date), and a checkout without a release tag or the plan's branch. Then, in order, each step
one of the commands above with its output under `<run dir>/log`:

1. It writes the run's plan from the trend's: the two commits, the seeds and a copy of the probe.
2. For each workload it resolves and builds a dry part and turns nothing, so a probe that does
   not build at the release tag, or a side `build.sh` refuses for its sections, is known before
   any turn. That is all the dry build shows: a placement of a pilot or a gated part that no
   second pad fits is refused when that part is built, which for a gated part is after its
   pilot's turns. It then starts the two sides' unpadded binaries once and compares their
   answers as `turns.sh` compares a placement's, stopped at the plan's `placementSeconds` as a
   placement is. That limit is on this check, which the command adds; `verify.sh`, which each
   part's `run.sh` runs first, holds each placement's comparison to the same limit, gives
   each of its two starts of the base 100 readiness requests of at most a second, and stops
   each start with TERM and, if it is still running 5 s later, KILL. Each start runs under
   [`serve.mjs`](serve.mjs), the server's parent, which sends those two signals through its child
   handle alone (a number it has not yet reaped cannot name another process) and stops the server
   when `verify.sh`'s end of its input closes, so a signal during the stop does not cut it short
   and a `verify.sh` killed outright leaves no server running. `serve.mjs` stops its child alone,
   so after each stop `verify.sh` makes one connection to its port, of at most a second, and
   fails if anything takes it: a start command that left the server running. The kit runs every
   `curl` with `--disable`, so a `.curlrc` (a retry, a header) changes neither a request nor its
   bound. A release
   and `main` may answer differently (today they do on `plain`: the page names the runtime's
   file by a hash of it), and no plan written before the run can say how. So the difference
   found there is kept as the workload's `expect` for this run
   (`<run dir>/expect-<workload>.txt`), with the two bodies' digests
   (`<run dir>/bodies-<workload>.txt`), and the row says "answers differ as recorded". Nobody
   reviewed that difference: the run recorded it.
3. It runs each workload's pilot and then its gated part at the K that pilot sizes. After each
   part it reads `answers/bodies.txt` of every placement the part was resolved to have (its
   `plan/resolved.json`), so results that hold fewer are not read, and requires the two bodies
   the check kept: the release's on both sides of a pilot's or an A/A's placement, the release's and
   `main`'s in the change. `turns.sh` holds a placement of the change to the expected
   difference, which has the header lines that differ and a bodies line of the two bodies'
   lengths and SHA-256s (of the one body, when the headers alone differ), so a third body of
   the same length fails it there. A pilot's or an A/A's placement has no
   expected difference: `turns.sh` holds its two sides to each other, and this holds them to the
   release's body.
4. It reads each gated part's `report.json`, keeps the row as `<run dir>/row.md` and then adds
   it to the page, which it replaces whole from a file written beside it.

A workload is read only when every step of its pilot and its gated part ended with status 0
and the gated part's `report.json` says it is this run's (the plan file's SHA-256, the two
commits and the workload), complete, at the K this run's pilot sized (the pilot is named by its
run id), with figures that are numbers, and its A/A resolved. It is then past the threshold when the
lower bound of the change, `main` against the release, is at or above the threshold, and a pass
otherwise. A pass says the run did not show a rise of at least the threshold. It does not say
the cost is under it: a lower bound of +1.9% under a bound of +5% is a pass. Anything else is
"not read", with the reason in the row, never a pass: a probe that does not build at the
release tag, answers not compared in time or a comparison that left no `diff.txt` that can be
read (one that found the answers the same leaves an empty one), a pilot that sizes no K, a step that failed whatever
report it left, a report that cannot be read, a placement with another body, an A/A that does
not resolve, a comparison without a bound. One workload not read leaves the other to be read
and the row to be written. Nothing is run again for its result. The kit's own page for a gated
part still reads its bound against +1%, as for a change; the trend's row does not.

What the command trusts is what the kit's own scripts wrote in `<run dir>` during this run, when
the step that wrote it ended with status 0. It does not defend against a file edited by hand or
by another process. It does guarantee that nothing it cannot read becomes a pass or loses the
row: such a workload is "not read", and the row is written.

For a run past its threshold the command drafts an issue, its title and body kept as
`<run dir>/issue.md`, with the pull requests `main` merged from the row before it to this one.
The list starts at the release instead when the page has no row, or when this run's head does
not descend from that row's commit (as after `main` was moved back), which the draft then says
in words. It opens nothing: whether the draft becomes an issue or is added to one
already open is for whoever made the run. A list git could not give is said to be unread, not
empty.

| Exit | What ended |
| --- | --- |
| 0 | Every workload was read and none is past the threshold. |
| 1 | A workload is past the threshold, and every workload was read. |
| 3 | A workload was not read, whatever another read: 3 outranks 1, and the issue is still drafted for a workload that is past. |
| 2 | Refused, with nothing run, nothing made and no row. |
| 4 | `trend.mjs` itself failed: a defect in it, or a page that changed while the run was made so that its row cannot be added. Once the parts have run, the row is in `<run dir>/row.md` before the page is touched. Publishing a row is one run at a time, which is the operator's to keep: this exit is given for a changed page only when the command, reading the page again before it writes, finds a row of this run's date or a later one. Two runs that read the same page before either writes both write it, and the page keeps one row; each row is still in its run's directory. |

`DRYRUN=1` makes every part a dry run: the row goes to `<run dir>/row.md` alone, marked, the
page is left as it was and no issue is drafted, whatever a report holds. It exits 0 when every
part ran to its end as a dry run, though nothing was read, and 3 otherwise.

What the command does not do: start or prepare a host, commit the row, keep the results, open
the issue, or review how the two sides' answers differ. The draft's list leaves each pull
request's `Request path:` line and counted cost to be added from its description, since the
command calls no service. It does not check that the host is quiet or that nobody logged in
while it ran.

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
| Answers | `plan.mjs`, `verify.sh`, `turns.sh` | Each placement answers as its unpadded binary, and a placement's two binaries alike or exactly as the plan's expected difference says (the same header lines, and bodies of the same lengths and SHA-256s, whether the two bodies differ or are one), before its turns. A `diff.txt` that cannot be written or does not hold a difference `diff` or `cmp` reported, one that is not there, not a regular file of its own (a link, to `/dev/null` say) or not readable when they report none, or a `diff` or `cmp` that cannot compare, fails the placement. |
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
    environment, the probe's files and the request script, and the CPU model. Those fields are
    compared as the two plans write them, the order of fields and the case of letters included:
    a plan whose request, load or mask entry has its fields in another order than the A/A's
    plan, whose mask names the same headers in another order, or which writes a masked header's
    name in another case, is refused as another setup though it sets up the same run. The
    build's environment alone is compared by name, in whatever order each plan writes it. Not
    compared for a number, and so a reviewer's to compare from the two plans and
    `results/host.txt`: the base and the head (an A/A read earlier is on an earlier base by the
    rule's design, so the base cannot be asked to match), the tree's paths, the toolchain, the
    binary's path under the target directory (`probe.binary`), the pinned CPUs, the status the
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
14. It neither declares nor takes the counts of the catalog's `page` and `json` that item 2 asks
    of a plan that reads a probe across placements. The plan file has no field for them, so they
    go in the posted plan, before the plan's first turn and before either count is taken. Nor
    does it check the workload such a plan names for each target: a workload's `declared` can
    carry the match and its reason, which the report prints as written. A workload read for
    that case after one build read its margin outside names the margin in `reads`; the report's
    pass or miss for it then says only whether the target comes under the case, and the single
    build's reading stands.

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

`npm run check` runs `pads.test.mjs`, `stats.test.mjs`, `map.test.mjs`, `report.test.mjs`,
`trend.test.mjs` and `verify.test.mjs` without a bench host. Two of them read earlier runs' kept files where they are kept, under the
tags `evidence/placement-sizing-1999` (an A/A's counts) and `evidence/placement-aligned-code-6`
(the maps), which are too large for `bench/`; in a checkout without those tags they fail with the
`git fetch` that brings them ([`tags.mjs`](tags.mjs)).

Those tests run two shell scripts, and only on Linux: `trend.test.mjs` runs the trend's answers
check, which is `turns.sh` with no pair turned, on servers of its own (the same answer, two
bodies of one length, a third body of that length under the difference the two made, a
difference in a header alone and, under it, another body both sides share, a
`diff.txt` that cannot be written, one that takes every write and holds none of the difference `diff` and `cmp` reported (and, for the same answers, is no regular file), one unlinked after `diff` wrote it, and a `diff` that cannot compare, each of those four with a
stand-in for a tool `turns.sh` runs, and a side that never answers), on a CPU the test may run
on, and fails saying so when the kit's two ports are in use. `verify.test.mjs`, which `npm run
check` runs too, runs the second, `verify.sh`, and with a plan of no placement, on
a base that ignores TERM: after its two starts, ended by a failed request while the base
runs, sent TERM while it stops the base and killed outright while the base runs, it must have
the base stopped within a bound and leave nothing on its port; it must fail when a start command
forks the server and leaves it listening, and give each readiness request to a base that never
answers at most a second under a `.curlrc` that asks for retries. Each of its servers ends by
itself within a bound, so no test signals one by its number; and `serve.mjs` on its own, which
must stop a server when its input ends (KILL 5 s after TERM for one that ignores TERM), and end
at once, saying so, when its server ends before it is stopped. What `build.sh`, `run.sh`, `verify.sh` and
`turns.sh` refuse otherwise is held by the selftest alone, on a host that has `perf` and `wrk`,
and by nothing in `npm run check`. The selftest's `inputs` case holds `build.sh`'s four checks of the files named
by path and `run.sh`'s two, `refusals` holds `run.sh`'s refusal of results already there, of
binaries built for another part and of another CPU model, and `zero` holds the above-zero test
of the counters before a run and in a turn. Held by a whole run on a host and by no case: the
counters at 100% and the refusal of one under it, the answers of every placement against its
unpadded binary, a masked header that does differ between two starts, and the probe's source
and each build's environment reaching the results.

Three runs of the kit on a host with `perf` and `wrk` are kept, each a test of the scripts and
read for nothing. What they turned is `main` at `e2d0c464e` against itself with the example
probe, and nothing else.

1. Under the tag `evidence/placement-kit-3`, by the kit at `556b23d53`: the selftest's seven
   cases, and a gated part built and turned at a K that `plan.mjs` sized from an A/A. It was
   not a dry run: K = 93, 186 placements of 4 recorded pairs and 2 s turns, declared in its plan
   as a test of the kit and not a reading, ended `complete`. `node report.mjs` reads its
   results and prints the page kept there.
2. Under `evidence/placement-kit-2`, by the kit at `2839ccda6`: a dry run of a pilot part and of
   a gated part, the selftest, a masked header with a range through `verify.sh` behind a
   stand-in, and one part that was not a dry run, a 30-placement A/A declared as a test of the
   kit, from which the K of 93 above was sized. `node report.mjs` reads its three complete
   results (`a-pilot`, `a-gated`, `t-pilot`) and refuses the fourth (`alike`), which ended
   `verify-failed`, as its plan was written to.
3. Under `evidence/placement-kit`, by the kit at `88c4e26cd`: a dry run from before a run's
   results held the list of files the plan names by path. The `report.mjs` of that commit reads
   its results, and this one refuses them, as it refuses any results without that list.

What no kept run shows, and the first plan that is read will meet for the first time:

1. A pilot of the size the rule asks, and a K sized from it. The A/A that K = 93 came from had
   30 placements, the fewest the kit takes, and the sizing check has not run on a host on more.
2. A gated part at a sized K whose base and head differ, or in which a side has code aligned
   beyond 16 bytes, so that each placement's second pad is chosen. The part that was turned had
   one commit on both sides and no such code; the first dry run linked 18 placements with a
   second pad and turned none.
3. A run on a host that `setup.sh` prepared for it. `setup.sh` prepared the first dry run's
   host and has not changed since; the other two runs borrowed a host that other work had
   prepared, which had no git.
4. A workload of Corten's own with a masked header that has a range (item 12 of
   [what it does not do](#what-it-does-not-do)).
5. A run that nobody looked in on. In the two later runs a login was made on the host while
   turns ran, in the third only to ask whether the run's process was alive; a run that is read
   does not allow it.
