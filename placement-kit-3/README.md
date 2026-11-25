# The placement kit's third run: a gated part built and turned at a sized K

A test of the scripts under `bench/placement` on one host, 2026-11-25 from 15:43 to 17:10 UTC.
**It is A TEST OF THE KIT, NOT A READING: no figure under this directory is a measurement of
anything, and nothing here is a reading for any pull request.** Every step built one commit of
`main`, `e2d0c464e7d7b56ea69b59c8fe7e8c9c2078d5bc`, against itself, with the kit's example probe
(`corten-run` with `json` and `compress`), and no other code.

What it is for: no run of the kit had built and turned a gated part at a K that `plan.mjs` sized
from an A/A, and no dry run can, since a dry run takes its K from `DRY_K` and ignores
`--sized-from`. The second dry run (tag `evidence/placement-kit-2`) sized such a part and
stopped there. This run turns it.

The kit that ran is `bench/placement` as it is at `556b23d53` (`results/kit-sha256.txt` is its
31 files' SHA-256s as the host had them, each the commit's). Its `report.mjs` reads
`results/t-gated/results` and prints the `report.md` kept there.

The host: 8 dedicated CPUs, an Intel Xeon Platinum 8358, Debian 13 with Linux 6.12.117, rustc
1.100.0 with LLD 23.1.5, gcc 14.2.0, perf 6.12.118, wrk 4.1.0 and Node 20.19.2: the host of the
second dry run. It was not a fresh host: another run's work had prepared it (the toolchain,
`perf` and `wrk`, `perf_event_paranoid` -1 and `nmi_watchdog` 0), and it was idle and only
borrowed, so `setup.sh` was not run and nothing was installed. It had no git, which `setup.sh`
would have installed: [`go.sh`](go.sh) says how the run was started with Debian's git package
unpacked beside the checkout and with a cargo home of its own. Before the run the load average
was 0.00 and nothing else was running.

What a run that is read does not allow, and this one had:

1. The host was borrowed and not prepared by the kit's own `setup.sh`.
2. Logins while the run went on. One, 40 seconds after the start and before any turn, while the
   first compile ran, listed the logins and the processes. Four while turns ran (16:04, 16:23,
   16:42 and 17:01 UTC) each asked only whether the run's process was alive (a test for a file
   and `kill -0`); none read anything the run wrote. Nothing the run wrote was read before it
   had ended.
3. A timer of the host's own management agent (an update check, about hourly) ran at 16:11:31
   UTC, while turns ran.

## What ran

[`sized-run.sh`](sized-run.sh) is every step, in order; `results/sized-run.out` is what it
printed and `results/<step>.out` each step's output.

1. **(s) The selftest, every case, at this head.** The kit's `example/plan.json` with
   `DRYRUN=1`: its gated part through `plan.mjs` and `build.sh` (18 placements linked and
   checked; `run.sh` was not run on it), then `selftest.sh` on that work directory
   (`results/d-gated.selftest.out`, `results/d-gated/selftest/`): `answers`, `failed`, `limit`,
   `map`, `inputs`, `refusals` and `zero`, ending `SELFTEST-OK`. `inputs` has the case this head
   added: `build.sh` built nothing for a probe with a listed file made a symbolic link to a file
   of the same bytes.
2. **(g) The gated part at a sized K. Not a dry run, and not a reading: a test of the kit,
   declared as one in its plan** (`results/plans/sizing/plan.json`, whose `declared` text the
   report prints: it speaks of a pilot-shaped A/A because the gated part is a part of the same
   plan file, which could not be reworded without the plan becoming another plan).
   - The plan file was written again by the lines that wrote it in the second dry run and is
     that file byte for byte (SHA-256 `af43b9a1...`). The A/A is the second dry run's
     30-placement test A/A as the tag `evidence/placement-kit-2` keeps it
     (`placement-kit-2/results/t-pilot/results`, run `010ff976-c449-4c2c-b4d4-f048a8d8e243`),
     copied to the host and checked there against that tag's list of hashes, 1,626 files
     ([`t-pilot.sha256`](t-pilot.sha256) is the list as it was checked). No A/A was run here.
   - `plan.mjs gated plain ... --sized-from` those results scanned K from 5 for 4 minutes 24
     seconds and gave **K = 93** (`results/t-gated.plan.out`, a line for each K tried: normal
     9324 and smoothed 4240 failing draws of 200,000, against at most 10,000), the K the second
     dry run got. The plan it resolved is the one that run resolved and did not build
     (`placement-kit-2/results/t-gated/plan`), every one of its 10 files byte for byte.
     `SIZED_MODEL` is the host's CPU model as `run.sh` reads it.
   - `build.sh`: each side compiled once, 281 binaries (the two unpadded and 279 placements:
     93 of the base for the A/A's first side and the change, 93 of the base for the A/A's
     second side, 93 of the head), linked and checked in 86 s. Neither side has code aligned
     beyond 16 bytes, so every placement was checked as moved by exactly its pad; the second
     pad was not needed.
   - `run.sh`: 279 placements answer as their unpadded binary; then **186 placements turned,
     93 of the A/A and 93 of the change, in the seeded order, 1,860 turns of which 1,488 are
     recorded, in 76 minutes 47 seconds; none failed; `RUN-ENDED complete`, exit 0.** Every
     one of the 2,232 server starts in the turns' logs reported `ALLOCATOR jemalloc`, no
     recorded count is at or under zero, and `inputs-check.txt` is empty.
   - The report (`results/t-gated/results/report.md`) is headed by the plan's declaration and
     says "K = 93 is the smallest at which the sizing check passes from run 010ff976-...". No
     reading in it ends "K not checked by the kit". `report.mjs` run again on the results
     printed the same page, byte for byte (27,031 bytes).

What the page says, which is **the answer of a test and the reading of nothing**: the A/A
"resolved" (bound +0.64% as recorded and +0.19% with the labels swapped), the change, which is
the same commit, "meets +1%" (median +0.03%, bound +0.22%), placement medians' standard
deviation 1.66%. The A/A the K was sized from had 30 placements, far fewer than a pilot that is
read, and the 93 is the K of no plan.

## What this still does not show

A pilot of the size the rule asks and a K sized from it; a gated part at a sized K whose sides
differ, or where a side has code aligned beyond 16 bytes and the second pad is chosen for each
of its placements (the first dry run linked 18 such placements and turned none); a run from a
host the kit's own `setup.sh` prepared; a workload of Corten's own with a masked header that has
a range.

## The files

`results/` is `<work root>/keep` as `sized-run.sh` gathered it, with `sized-run.out`, and
`results/sha256.txt` the SHA-256 of each file as the host had it. `.gitattributes` keeps every
byte as recorded: the answers' saved headers end their lines with CR LF, as they were sent.
Paths in the outputs under `/root/placement-kit-dry` are the run's one directory on the host:
`corten` the checkout, `w` the work root, `ev` this directory with the kept A/A
(`t-pilot/results`) and the plan the second dry run resolved (`kept-plan`) beside the scripts,
`git` the unpacked git and `cargo` cargo's home. Those two directories are not kept again here:
they are the tag `evidence/placement-kit-2`'s files.
