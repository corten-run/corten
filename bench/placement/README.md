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
| `workloads[].request` | `path`, `headers` (each `"Name: value"`) and optionally `script`, a `wrk` script in place of [`get.lua`](get.lua) that ends with the same `RESULT` line. The path is the request target the answers are captured from, sent as written (a `/./` or `/../` in it included), and the one `wrk` asks for under the kit's `get.lua`; a custom `script` can send another path, and the kit does not check that it does not. The path starts with `/`, is printable ASCII and holds no quote, backslash or `#`: `curl` drops a fragment and `wrk` sends it, so the answers and the load would ask for different targets. |
| `workloads[].status` | The status every compared answer must have. |
| `workloads[].mask` | The header values masked when two answers are compared: `{ "header": name }`, with `"range": [low, high]` for one the workload's cost depends on. `[]` when none. Every masked header must differ between two starts of the base, and one with a range (`low` under `high`) must also be within it in every answer; a single stated value could not do both, so the kit takes a range alone. A header with a range that the two starts send alike stops the run at `verify.sh`: see [what it does not do](#what-it-does-not-do), item 12. |
| `workloads[].K` | `"pilot"`, the smallest K the sizing check passes from this plan's pilot, or a number from 5 to 254. |
| `workloads[].sizedFrom` | With a number for K, and only then: which eligible A/A the number was sized from, in words a reader can follow to it (where it is kept, its run, its comparison). The declaration and the report print it. |
| `workloads[].seed` | The seed of the order its placements run in. |
| `workloads[].reads` | The thresholds this run reads across placements: `["margin"]`, `["reduction"]` or both. One a single build already read outside its band is left out and stays as that build read it, but for the margin of a workload read for the catalog's `page` or `json`: see [what it does not do](#what-it-does-not-do), item 14. |
| `workloads[].reduction` | The smallest worthwhile reduction as a fraction (`0.02`), or `null` when the plan declares no benefit side. |
| `workloads[].recordsSpread` | Whether the plan declares, before the run, that its A/A records a placement spread. A shuffled A/A cannot record or replace the policy spread, even if the plan declares one. |
| `workloads[].expect` | Optional: a file holding the exact difference between base's and head's answers that the change makes by design, as `turns.sh` writes it to `answers/diff.txt`: the difference of their masked headers in `diff`'s normal format (empty when those are the same), then one bodies line, `bodies differ: <A> and <B> bytes, sha256 <A's> and <B's>` when the bodies differ and `bodies same: <N> bytes, sha256 <its>` when they do not, each SHA-256 in full. `turns.sh` compares the two files byte for byte, so an expected difference binds the header lines that differ, every other header line to being the same on both sides, and both bodies by their lengths and SHA-256s, whether the bodies differ or not. `plan.mjs` refuses one that does not end with exactly one bodies line of those two forms, and a `bodies same` line alone, which `turns.sh` writes only after the headers' difference. Without it the two must answer the same, and `diff.txt` is empty. [`answers.mjs`](answers.mjs) has `curl` capture each answer once, into files it has just created, and takes whether the two differ, the difference held to `expect`, the lengths and the SHA-256s from those bytes as `curl` wrote them; the headers' difference is the system `diff`'s, run once on the two masked headers' files. It writes `diff.txt` once, created new, and never reads it back: anything already at `diff.txt` when it is written, a link included, fails the placement. The difference is kept as bytes throughout, so a header byte that is not UTF-8 is compared and kept as it was sent. |
| `workloads[].shuffle` | Optional: `true` when the workload's placements sample how a build lays its functions against each other as well as where its image lies. Placement i of every binary (base and head, and the A/A's two sides) is then linked with its pad's function first and then every function of its side's unpadded build in `.text`, in the order of a key [`order.mjs`](order.mjs) takes from the workload's `seed`, i and the name (HMAC-SHA-256). Each index gets its own draw; different indices can draw the same order. The run refuses a change in order or address sharing among the names it compares; a section can move past sections holding only left-out names without changing either (see [what it does not do](#what-it-does-not-do), item 16). Left out, a placement moves the image by its pads alone, and nothing the kit writes or reads differs from a plan without the field. A shuffled plan is sized from a shuffled A/A alone (`--sized-from` compares the field), and its results keep each side's list of functions, `functions-<side>.txt.gz`, from which `report.mjs` draws every ordering file again. Each such placement is a link no app builds: [Choice 72](../../docs/design.md#choice-placement-runs), Inner layout. |

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
there is not mended by running it again. The kit has gone down that path twice: in a test read
for nothing, and then in the trend's first run, the first of the kit's runs that was read
([Tests](#tests) says what each was and what no kept run has shown).

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
| `threshold` | The rise the trend reports, as a fraction (`0.02`), read on the lower bound. The maintainer settled it at +2% on 2026-11-27; [the trend's page](trend/README.md) says what that rests on and when it is read again. |
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
   [`serve.mjs`](serve.mjs), the parent of the process the start command is (or execs), which
   sends those two signals to that direct child alone, through its child handle (a number it has
   not yet reaped cannot name another process), and stops it when `verify.sh`'s end of its input
   closes. So a signal during the stop does not cut it short, and a `verify.sh` killed outright
   still has that child stopped. `serve.mjs` gets an environment of `PATH` and `HOME` alone, so
   no `NODE_OPTIONS` holds it, and `verify.sh` waits for it about 15 s at most (it ends within
   about 10 s), then fails, saying the cleanup is unconfirmed, and signals nothing. Nothing the
   child started is stopped: after each stop `verify.sh` makes one connection to its port, of at
   most a second, and fails if anything takes it, so a listener left by a start command that does
   not exec its server is found, and fails the check, but stopping it is the operator's.
   `turns.sh` runs each server it starts, for a placement's answers and for each turn, the same
   way: under `serve.mjs`, which writes the server's process number for the CPU check and `perf`
   (the start command is exec'd, so that process is the server; `serve.mjs` waits idle on its
   input, on the driver's CPU), stopped through its input after the answers check, after each
   turn and however `turns.sh` ends, the placement's deadline TERM during the stop and a KILL of
   `turns.sh` included, waited for about 15 s at most and, once every server that stop ends has
   ended, followed by one connection to each of their ports that nothing may take (a port checked
   while the other server's stop still ran could be opened again in that time). Before its first
   start it makes one connection to each of its two ports, which nothing may take either. The deadline's `timeout` signals `turns.sh`'s whole
   process group, so its TERM reaches the servers too, and `serve.mjs`, sent it as well, stops
   each as it does when its input ends. The
   `curl`s in `verify.sh` and `turns.sh`, all to 127.0.0.1 and used only for readiness requests
   and the checks of a port, run with `--disable`, so a `.curlrc` (a retry, a header) changes
   neither a request nor its bound, and with `--noproxy '*'`, so no `http_proxy` or `ALL_PROXY`
   of the environment's answers for the servers, each bound to a second. The answers both
   scripts check are captured by `curl`, which `answers.mjs` runs with `--disable` and
   `--noproxy '*'` as well, `--globoff`, so a path such as `/{a,b}` is sent as it is and never
   becomes two requests, and `--path-as-is`, so a path such as `/root/../target` is asked for as
   written, not as `/target`: one request each, sending the `Host` line and the plan's header lines
   (`curl`'s own `Accept` and `User-Agent` left out unless the plan has them), bound to 10 s, its
   header lines kept as `curl` writes them and its body as received, and refused unless its final
   response has the plan's status. An interim `1xx` response (`103 Early Hints`) is not the
   answer's status, but its header lines are kept and compared with the final response's, so an
   answer with early hints differs from one without. The mask's checks (every masked header sent
   once, different in two starts, and within its stated range) read the final response's header
   block alone, from its status line to the blank line that ends it, so a masked header only an
   interim response or a chunked trailer sends is sent 0 times. The comparison masks a header in
   that final block alone, so an interim block and any trailers are compared with no header
   masked (every block, the final one included, is compared with each line's CR before its LF
   taken off and every `Date` line left out): two answers whose early hints preload different files differ, even when the plan masks
   `Link`, because nothing shows an interim block's value may differ between starts. Both scripts run `answers.mjs` with an
   environment of `PATH` alone (so no `NODE_OPTIONS` holds it) under `timeout`, 30 s (60 s for a
   placement's comparison, which takes three answers) and KILL 5 s after, and fail saying so when
   it is stopped. That stop reaches `answers.mjs` alone, so each command it runs has a bound of its
   own that outlives it: `curl`'s `--max-time`, and a `timeout` of 10 s, KILL 2 s after, around
   `diff`. `serve.mjs` publishes its
   server's process number by writing it to a staging file it creates new (`.pid.tmp`) and renaming
   that over the published path, so anything already at the staging path, a FIFO included, stops
   the server and fails the start instead of holding `serve.mjs`. A file or link at the published
   path is replaced; anything `rename` cannot replace, such as a directory, stops the server and
   fails the start. So a server that takes a
   connection and never answers holds neither script, nor a signal it has held off until that
   request ends, any longer. A release
   and `main` may answer differently (today they do on `plain`: the page names the runtime's
   file by a hash of it), and no plan written before the run can say how. So the difference
   found there is kept as the workload's `expect` for this run, but only as `turns.sh` reports
   one after both servers ended and nothing accepted on either port when checked (status 4 and
   its line `A and B answer differently; both servers ended and nothing accepted on either port
   when checked`): a difference after which a stop fails, is unconfirmed or is cut by a signal
   ends `turns.sh` 1, and leaves the workload not read. `turns.sh` likewise prints a passing
   verdict (`answers: same`, or as the expected difference says) and writes
   `answers/verdict.txt` only after that stop of both servers has passed. What the stop checks
   is limited: `serve.mjs` exits 0 only once Node reports its server's exit, which it does once
   it has reaped that process, so the server `serve.mjs` started (the process the start command
   is, or execs) has ended; and each port refuses one connection when it is checked. A process
   the start command leaves behind, rather than being or exec'ing the server, is not tracked: if
   it opens a port after that check, it is not seen. The start command must be, or exec, the
   server. `turns.sh` prints, after that stop, one line `turns: <workload>: handoff sha256
   <SHA-256>` naming `answers/handoff.json`, which `answers.mjs` wrote with the outcome (the
   same, as expected, or differ) and the SHA-256s of `diff.txt` and `bodies.txt`, in one form
   (those three keys in that order, as `JSON.stringify` writes them, and a newline), which is read
   only when its bytes are exactly that form again, so a key given twice is refused; the trend reads
   the outcome, the difference and the bodies line only from files whose bytes have those
   SHA-256s, so a file put in place of one of them after the comparison leaves the workload not
   read. The difference is kept
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
release tag, answers not compared in time or a comparison whose files are not what its handoff
sealed (one that found the answers the same leaves an empty `diff.txt`), a pilot that sizes no K, a step that failed whatever
report it left, a report that cannot be read, a placement with another body, an A/A that does
not resolve, a comparison without a bound. One workload not read leaves the other to be read
and the row to be written. Nothing is run again for its result. The kit's own page for a gated
part still reads its bound against +1%, as for a change; the trend's row does not.

What the command trusts is what the kit's own scripts wrote in `<run dir>` during this run, when
the step that wrote it ended with status 0. It does not defend against a file edited by hand or
by another process. It does guarantee that nothing it cannot read becomes a pass or loses the
row: such a workload is "not read", and the row is written. It reads a file a step left only as
a regular file of its own, never through a link, and never opens a FIFO, a directory or a device
there, so no file left behind can hold the run; and of an answers check that failed (any status
but 4 with its line), it opens nothing at all.

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
| The unpadded link run again is byte-identical | `build.sh`, `relink.mjs` | The captured link is the build's own. An unshuffled placement differs from it by its pads alone; a shuffled one also gives LLD an ordering file for its functions. |
| The record from the unpadded map | `map.mjs record` | Each input section of `.text` aligned beyond 16 bytes and each side's list, for the report. |
| The refusals | `map.mjs refuse`, `build.sh`, `layout.mjs --alike` | A side the fifth point gives no reading across placements stops before anything is turned: for a section aligned beyond 64 bytes or a Rust-named section, before any placement is linked; for a placement none of the four second pads fits, as the placements are linked. For a workload the plan shuffles, head is refused, as its placements are linked, when a placement changes the order or address sharing of the compared names relative to base's at its index, or when fewer than two names can be compared. |
| Functions moved by the pad | `layout.mjs` | A placement has its side's functions and the pad, the pad first, each moved by the pad, neighbours in order. |
| A shuffled placement's order | `order.mjs`, `relink.mjs --every-name`, `layout.mjs --order`, `layout.mjs --alike`, `map.mjs check --shuffled` | For a workload the plan shuffles, in place of "moved by the pad": the ordering file names the pad's function and then each of its side's functions once; the link fails when LLD warns that a name in the file is no symbol, which LLD otherwise only warns of and links on; every placement is linked with its map (the unpadded and placement maps are kept as gzip files in the results' `maps/`, with SHA-256s of their uncompressed bytes in `maps/placements.sha256`; the saved bytes are verified before any turn, and replay verifies both the bytes and the digests in each check's JSON), and every map of the run, the unpadded ones too, is written with LLD's `--no-demangle`, so it names each symbol as the ELF symbol table does; the functions, of the ordering file's list and of both binaries in the checks alike, are the symbol table's (`readelf -sW`'s `.symtab`, type `FUNC`), and a function is of `.text` when its symbol's section index is `.text`'s, by that one rule and never by its address, so a function of no size at the very end of `.text` is drawn and checked and one at that address in the next output section is neither; the placement holds exactly its side's functions and the pad, the pad first in `.text`, and its map lays the unpadded map's input sections out as LLD promises to lay them for the file, read from that map and never from what is expected or from names: each definition of `.text`, in either binary, is of the input section its own link's map gives it (by its address, a section of no size and the end of a section included, and where two sections share the address by the map's symbols there, named byte for byte as the symbol table names them; refused when the map gives it none or does not give it to one), every input section at the earliest place the file gives any symbol its map lists in it, its key (LLD's rule: a symbol of a listed name gives its section that name's place whatever its type, a function, a label or an object, and whether local or global), sections of one key together, in any order among themselves, since LLD sorts them by the key alone and not stably (local copies of one function in several objects share a key, and a real Rust probe's link lays some of them out of their unpadded order), and sections the file places nowhere after them in theirs; each placed section paired with its unpadded one and listing the same symbols as far from its start, and each definition in the section paired with its unpadded one, as far from its start; the first input section of `.text` the first pad's, the only one, at its start and exactly the declared pad's size; the first section after it, each after the end of the one before and the last inside `.text`, before the second pad where there is one; and outside `.text` the output sections with inputs and their ordered input IDs must match the unpadded map. Distinct IDs are compared by ID and position only; repeated IDs also compare size, alignment and symbol names at relative offsets. Absolute addresses are not compared. A placement whose file also names a symbol outside `.text` is refused even if that input order matches, since LLD can order that output section by the same file; with aligned code, the map check finds the unpadded link's sections between the pads in any order, each with its size and alignment, and each section's symbols in one of the unpadded link's of its name, size and alignment that has them at the same offsets (two sections a map names alike are told apart by their symbols, and two alike in those too are interchangeable to it). Each head placement, checked again against its side's unpadded binary and map as base's at its index is, is compared with base's (`layout/head-p<n>-alike.txt`) by the names whose identity is plain on both sides: a name less a ThinLTO suffix (which a rebuild of the same code can renumber, and which `order.mjs` keys without) that each side defines exactly once, as one function of `.text`, one symbol of any type in its symbol table and one symbol of its map at that function's address, written as the symbol table writes it. The check groups compared names by input-section slot and offset within that section and requires the same ordered groups on both sides. Separately it checks that each compared name shares its ELF address with the same other compared names, including across input-section boundaries. Two links with identical addresses can pass `--order` but fail `--alike` if a boundary name changes input sections and that changes its order group. Head is also refused when fewer than two names are compared. A name defined more than once on a side (local copies in several objects, ThinLTO copies of one name), or that those readings disagree on, is left out, never matched by its object, its section or its size, and counted: the check prints, and the report writes at each index (in its Inner layout paragraph and as `report.json`'s `alike`), how many shared names it compared and how many it left out as ambiguous, and it does not check what it leaves out. Replay checks the shared total against the intersection of the two saved function lists after stripping ThinLTO suffixes; the split between compared and left-out names comes from the live check. The cross-side receipt names both ordering files and all four maps. The map check itself takes the sections in any order; their order is `layout.mjs --order`'s, from the same map. |
| The second pad | `build.sh`, `map.mjs data` | With aligned code, the smallest of 16, 32, 48 and 64 bytes that puts `.data` where the rule says, with a line a placement. |
| The map check | `map.mjs check` | With aligned code, the placement's map against the unpadded link's by LLD's layout rule, in place of "moved by the pad". |
| Distinct SHA-256s | `build.sh` | No two placements of one build are one binary. |
| The host and the counters | `run.sh` | The plan's CPU model and CPUs, the CPU model of the A/A a K was checked from, and every counter above zero and at 100% for an attached process, before any turn. |
| The mask | `verify.sh`, `answers.mjs`, `mask.mjs` | Every masked value differs between two starts of the base's unpadded binary; one with a stated range is also within it in every compared answer (the two starts are checked for presence and difference only). Both read each answer's final response's header block, never an interim `1xx` one's header lines or a trailer `curl` writes after it, and the comparison masks a header in that block alone, comparing the others with nothing masked. Only answers of the plan's status are evidence: one of another status stops the run. A masked header the two starts send alike stops the run, with a range or without. |
| Answers | `plan.mjs`, `verify.sh`, `turns.sh`, `answers.mjs` | Each placement answers as its unpadded binary, and a placement's two binaries alike or exactly as the plan's expected difference says (the same header lines, and bodies of the same lengths and SHA-256s, whether the two bodies differ or are one), before its turns. Each answer is captured once by `curl`, with the plan's status, and every fact about it is taken from those bytes, the headers' difference by the system `diff`; the difference and the bodies line are compared and written as `diff.txt` once, created new, and never read back, with `bodies.txt` and a `handoff.json` that names the outcome and both files' SHA-256s. Anything already at a file it writes (a file, or a link, to `/dev/null` or the expected difference say), an answer of another status, cut short or not sent in 10 s, fails the placement. `verify.sh` records a placement only as `answers.mjs verified` reads it from that handoff. |
| Turns | `turns.sh`, `answers.mjs` | Every turn on a fresh start on the server's CPU, its `perf` and `wrk` output written to files created new for that turn and kept byte for byte; a failed request, output that is not exactly one complete `RESULT` line of decimal counts and each counter once in a row that ends with a newline, or a counter that is zero or whose percentage is not `100.00` (or `100`) as written, fails the placement, and nothing is run again. |
| The results are the plan's run | `report.mjs` | Refuses results whose plan, pads, order, binaries, records or files named by path are not what the plan gives. |
| Eligibility and K | `pilot.mjs`, `plan.mjs --sized-from` | The A/A may size a run, on this plan's setup as far as item 11 below compares it, and the K passes under each model kept, at that K itself. A K nothing checked is said to be unchecked in every reading. |

`report.md` states, for each threshold the plan declares, pass, miss, not resolved or no bound, or
that this run does not read it; both readings of the A/A; the benefit side when one is declared;
whether the A/A records a spread; whether its placements are shuffled; every measure across
placements; every placement; and each side's aligned sections, its list and the second pads' lines.

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
15. It does not say how far a shuffled placement's reading stands for the one layout an app
    ships: each such placement is a link no app builds. Nor has a run shown whether shuffled
    placements spread wider or narrower than unshuffled ones, which is why a shuffled plan is
    sized from a shuffled A/A alone.
16. Where it cannot establish a shuffled placement's layout it refuses rather than guesses, and
    so refuses some links that are right: a binary without a `.symtab` (stripped); a function of
    `.text` at an address where two input sections meet whose name the map does not write as the
    symbol table does (a map not written with `--no-demangle`, which `build.sh` always asks for
    in a shuffled run); a placement whose
    ordering file lists a name its map also defines outside `.text` (LLD can order that output
    section by the same file), even where its input order matches the unpadded map; and
    in `--alike`, a change where fewer than two of the names both sides have are defined exactly
    once on each, or whose two links follow one file but lay two input sections of one key in
    other orders where each section also holds a name defined once: two `.text.blob` sections
    that share a key through a local `init`, one holding `u1` and the other `u2`. LLD may lay
    them either way in either link (it sorts by the key alone), and
    the check, comparing `u1` and `u2` in the order each link laid them, refuses. It can also
    refuse two links with the same ELF addresses when a name at an input-section boundary
    belongs to different input sections and changes the ordered groups. Two sections of
    one file and section name that are alike in size, alignment and symbols are interchangeable to
    the map check. The other way, it does not check what it leaves
    out: in `--order` it reads no order among sections of one key, which LLD does not promise, and
    in `--alike` it compares only the names each side defines exactly once, so a name defined more
    than once on either side (local copies in several objects, ThinLTO copies such as `f.llvm.1`
    and `f.llvm.2`) can lie elsewhere in head and a change that moves only such copies is read as
    alike; nor does it see a section both sides have that holds no name it compares move, as one
    does when a symbol head alone has (an alias, say) gives that section another place, so a change
    that moves only such a section is read as alike too, and a section holding a compared name
    can move past sections that hold none and be read as alike, since only the compared names'
    order is checked. It counts what it leaves out, and the
    report says how many at each index: on a real Rust ThinLTO probe (one change's two commits,
    six shuffled orders) it compared 3,433 of the 3,467 names both sides have and left out 34.
    CONTRIBUTING.md and the report say the same of the order a shuffled run promises.

## What is this host's alone

The scripts assume, and nothing in a plan changes: an x86-64 Linux host (a pad is bytes of `int3`,
`0xcc`); ports 18081 and 18082 on 127.0.0.1 for a placement's two servers (`plan.mjs` writes
them to `resolved.sh` as `PORT_A` and `PORT_B`) and 18083 for `verify.sh`'s, free when a run starts; `cc` on `PATH` as the C compiler that assembles the pads
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
`answers.test.mjs`, `trend.test.mjs` and `verify.test.mjs` without a bench host. Two of them read earlier runs' kept files where they are kept, under the
tags `evidence/placement-sizing-1999` (an A/A's counts) and `evidence/placement-aligned-code-6`
(the maps), which are too large for `bench/`; in a checkout without those tags they fail with the
`git fetch` that brings them ([`tags.mjs`](tags.mjs)).

`map.test.mjs` holds `order.mjs`'s key (one value pinned, so a host that computes another fails),
its orders (one per index, the same for both sides' shared names), the shuffled layout and map
checks on made-up links, each way a placement can break the order (a name defined more than once
among them, and functions under `.text` or inside the pad), a symbol of no size at the end of one
input section where the next begins (the map's section, and refused when its symbols there do not
tell the two apart), two sections one file names alike told apart by their symbols in the map
check, a section's key given by every symbol of a listed name, a label or an object as much as a
function, a first pad of another size than the declared one refused, two sections of one key laid
in either order (both passed, one laid away from its key's place refused, and a key one side splits
refused), a function in a section of no size at the next section's address, a function of no size
at the very end of `.text`, and a function of `.text` by its symbol's section index (one of no size
at the unpadded end of `.text` drawn and checked, one at that address in the next output section
neither, a local name at both told apart), a Rust-mangled function of no size where two sections
meet (passed with the symbol table's spelling, refused demangled); and base's and head's order at
one index: the names each side defines once compared in one order, a symbol of head's alone that
moves a shared section holding a compared name refused and one that moves a section holding only a
left-out name passed, a name defined more than once on a side left out and counted
whatever tells its copies apart (its object, its section, a ThinLTO suffix), a name the symbol
table or the map reads otherwise left out, names a ThinLTO suffix alone sets apart one name, names
defined once at one address compared each by its name, definitions at one address in base and
apart in head refused, and base's first alias of `f.llvm.2` renamed in head, which reverses the
copies' sections, refused by the names defined once in them; that `build.sh` writes every map of a shuffled run, and none of an unshuffled one,
with `--no-demangle`; on Linux with `clang`, `ld.lld`, `nm` and `readelf`, the earlier cases
and these as real LLD links, run through `order.mjs` and `layout.mjs` as `build.sh` runs them,
among them copies of one name swapped between two objects while a third object's source is
renamed (left out, not matched), an alias of `f.llvm.2` renamed from `f.llvm.3` to `f.llvm.0`
(refused), a local label of a listed name in another section (the genuine ordering file passed,
another seed's link refused as it), a first pad of 320 bytes declared as 304 (refused), an
out-of-plan `.rodata` reversal (refused by both layout checks), and a real LLD missing-name
warning (the wrapper exits 0 without `--every-name` and 1 with it) (skipped elsewhere).
On x86-64 Linux with `rustc`, `cc` and `readelf`, it also captures a real Rust ThinLTO probe's
link and runs both layout checks on maps from the same captured objects. The maps include unwind,
exception, data and debug inputs, and the pad grows the generated symbol table without changing
its input ID (accepted);
`report.test.mjs` holds the
field's refusals, the declaration, and a shuffled run's results and what is refused in them
(including missing or altered unpadded or placement maps, mismatched map or ordering-file receipts, and
shared-name counts inconsistent with the saved function lists), and
runs `build.sh`'s and `run.sh`'s start under `sh` (Linux) to show the plan alone sets
`SHUFFLE`, that the plan's value stands after the cargo env file each sources, and that `run.sh`
ends the run, refused, before any turn when it cannot keep a side's list of functions or verify
every planned unpadded and placement map. No kept benchmark run has linked a shuffled placement of a real
build, and the selftest has no shuffled case.

`answers.test.mjs` runs `answers.mjs` on servers of its own; its captures and comparisons need
Linux, `curl`, `diff` and `timeout` and are skipped elsewhere: the one request sends the `Host` line and the
plan's header lines alone, to the path as written (one request for `/{a,b}` or `/p[1-2]`), and
reaches no proxy of the environment's; an answer of another status is refused by the comparison and
by a start, the final response's status counting (`103` then `503` is refused as `103`, and `103`
then `200` accepted as `200`); a `diff` that stalls is gone within its own bound once the
`timeout` around `answers.mjs` has stopped it; the difference, the lengths, the SHA-256s and the kept
bodies come from one request per answer, and the difference is the system `diff`'s of the masked
headers; a header that differs only in its whitespace (`X-Test:\t alpha  ` against
`X-Test: alpha`), a change after the 1,000th header line, and lines B,A,B against A,A,B (`2c2`)
are each found as `diff` finds them; a header byte that is not UTF-8 (`0xe9`) is kept in the
difference byte for byte and matches it as `expect`; an answer cut short or never sent is refused;
something put at `diff.txt` or at a capture's files just before they are made (a link to
`/dev/null`, to the expected difference or nowhere, or a file) is refused and never written
through. On any platform: a handoff refuses a regular file put in place of `diff.txt`,
`bodies.txt` or `handoff.json`, another outcome, and a handoff in any other form (a key twice,
pretty-printed, reordered, no newline); and a turn is recorded only from exactly one complete
`RESULT` line and newline-ended `perf` rows at `100.00` or `100` as written (not `100oops`,
`99.99`, `99.99999999999999999`, `100.0`, `1e2` or `+100`), its output kept byte for byte, a
NUL included.

Two shell scripts are run, and only on Linux: `trend.test.mjs` runs the trend's answers
check, which is `turns.sh` with no pair turned, on servers of its own (the same answer, two
bodies of one length, a third body of that length under the difference the two made, a
difference in a header alone and, under it, another body both sides share, a difference in two
headers with one between them, whose first hunk alone, expected, must fail, a `diff.txt` that
cannot be written, an empty file, a link to `/dev/null`, a lone first hunk or a link to the
expected difference put at `diff.txt` by a server while it answers, which must fail and leave
that file as it was, a stand-in `diff` that replaces B's body with a third of the same length,
which must change nothing, headers that differ only in their whitespace or after the 1,000th
line and the B,A,B lines, each found as `diff` finds them, answers of another status under a stand-in `head` that prints a
`200` line, which must leave no verdict, no handoff and no counts, an answer cut short, a side
that never answers, answers that differ after which a start command that forks its server
leaves it listening, which must not read as a difference, and a proxy of the environment's
that answers everything, which no request may reach), on a CPU the test may run on, and fails
saying so when the kit's two ports are in use. Its trend runs, with a stand-in for the kit, also
refuse a regular file put at `diff.txt` or `bodies.txt` after the check, another outcome
sealed, a handoff with a key twice, and a FIFO there, and keep a recorded difference that is not
UTF-8 byte for byte in `expect-<workload>.txt`. It also runs `turns.sh` itself on two servers that ignore TERM: after
answers that are the same, sent TERM while it stops them after answers that differ (which then
must say no difference), sent TERM alone while a readiness request waits on a server that takes
the connection and never answers, and under the check's own deadline, whose TERM reaches the
whole process group, it must have both stopped within a bound, and leave nothing on the kit's
ports, by the time it exits; killed outright while they run, while `answers.mjs` waits on B's
answer, or while B's start waits to open its log (a FIFO there), it cannot wait for them, and
`serve.mjs` stops them after it has ended, within a bound the test counts from the KILL (9 s).
With a server that ends at once on TERM but leaves a process that opens its port again 1.5 s
later, while the other's stop takes 5 s, it must fail, after answers that differ and after the
same, rather than say the stop was confirmed; and with something on its port that takes a
connection and never answers before it starts, it must refuse at once and start no server. With
stand-ins for `perf` and `wrk`, a turn's output must reach the raw log byte for byte, a NUL
included; two incomplete `RESULT` lines, a percentage of `100oops` or `99.99999999999999999`,
or a `perf` row cut before its newline must record no row; and a second turn whose `perf` writes
nothing must fail rather than read the first turn's output.
`verify.test.mjs`, which `npm run check` runs too, runs the second, `verify.sh`, and with a plan
of no placement, on a base that ignores TERM: after its two starts, ended by a failed request
while the base runs, sent TERM while it stops the base after a request that succeeded (which
must then fail it) and killed outright while the base runs, it must have the base stopped within
a bound and leave nothing on its port; it must fail when a start command forks the server and
leaves it listening, give each readiness request to a base that never answers at most a second
under a `.curlrc` that asks for retries, send no request to a proxy of the environment's, keep a
caller's `NODE_OPTIONS` from `serve.mjs` and `answers.mjs`, stop an `answers.mjs` that stalls and
ignores TERM at 30 s and fail with nothing left running, stop the server and fail at once when a
FIFO is at `serve.mjs`'s process-number file, and, with a stand-in `serve.mjs` that does not end when
its input closes, fail about 15 s later saying the cleanup is unconfirmed, signalling nothing.
With a placement, its starts and `turns.sh`'s comparison must send the same one request, answers
of another status must be no evidence for the mask though they differ in the masked header, and
a placement whose bodies line or verdict is not what `turns.sh` sealed must not be recorded. Each
of its servers ends by itself within a bound, so no test signals one by its number; and
`serve.mjs` on its own, which must stop a server when its input ends (KILL 5 s after TERM for one
that ignores TERM), and end at once, saying so, when its server ends before it is stopped. What
`build.sh`, `run.sh`, `verify.sh` and `turns.sh` refuse otherwise is held by the selftest alone,
on a host that has `perf` and `wrk`, and by nothing in `npm run check`. The selftest's `inputs`
case holds `build.sh`'s four checks of the files named by path and `run.sh`'s two, `refusals`
holds `run.sh`'s refusal of results already there, of binaries built for another part and of
another CPU model, and `zero` holds the above-zero test of the counters before a run and in a
turn. Held by a whole run on a host and by no case: the counters at 100% as `perf` itself reports
them, the answers of every placement against its unpadded binary, a masked header that does
differ between two starts, and the probe's source and each build's environment reaching the
results.

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

One run of the kit has been read, apart from those tests: the trend's first run
([the trend](#the-trend)), kept under the tag `evidence/trend-2026-11-26`, by the trend's plan
as `main` had it at `056aba61c`, the release `v0.2.0` against that commit. For each of `plain`
and `unstaged` it ran a pilot of 100 placements, the size the rule asks, and then a gated part
at the K that pilot sized, 60 and 28, with base and head different commits; every part ended
complete and both A/As resolved. So the sizing check has run on a pilot of more than 30
placements, and gated parts at a sized K whose sides differ were built, turned and reported.
That it ran once, after one dry run, on a host the kit's `setup.sh` prepared and that was left
alone from start to end, the tag cannot show: whoever made the run records it there.

What no kept run shows:

1. A gated part in which a side has code aligned beyond 16 bytes, so that each placement's
   second pad is chosen. Neither side of the trend's run has such code (its records list no
   aligned section and no part had a second pad), the part the tests turned had one commit on
   both sides and none, and the first dry run linked 18 placements with a second pad and turned
   none.
2. A workload of Corten's own with a masked header that has a range (item 12 of
   [what it does not do](#what-it-does-not-do)). The trend's plan masks no header.
3. A run on a host that `setup.sh` prepared for it, in what the run keeps. `setup.sh` prepared
   the first dry run's host and has not changed since; the other two tests borrowed a host that
   other work had prepared, which had no git; and the trend's run is said to have been on a host
   it prepared by whoever made the run, whose output the tag leaves out.
4. A run that nobody looked in on, in what the run keeps. In the two later tests a login was
   made on the host while turns ran, in the third only to ask whether the run's process was
   alive; a run that is read does not allow it. Whoever made the trend's run records that
   nobody logged in while it ran.
5. A shuffled placement (`workloads[].shuffle`) of a real build, linked, turned or read, and
   so whether shuffled placements spread wider or narrower than unshuffled ones.
