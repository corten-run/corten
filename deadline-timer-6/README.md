# The deadline's timer, sixth evidence directory (2026-11-26)

The raw results of Part 1 of the cycle plan posted on pull request 2029 (the plan is the
comment 7175633556 there, its addendum the comment 7176100779): the seven pilots, the dry runs
every host made before them, and the wrapper that started each part on a host. The kit that ran
them is under the tag `evidence/deadline-timer-5` (`deadline-timer-5/kit/`), unchanged.

Nothing here is a cycle count of the change. A pilot is the base `26ab0e37f` against itself in
100 placements of 8 recorded pairs; it sizes the gated run and reads nothing of the head. A dry
run is a test of the scripts, marked `DRYRUN`: 3 placements, 2 recorded pairs, 1 s turns, read
for nothing.

Every file is stored byte for byte as the host wrote it, with no line-ending conversion
(`.gitattributes` here says so to git): the answers a run recorded (`*.raw-headers`) keep their
CRLF line endings.

## What is here

The four hosts are H1 to H4, as the plan names them.

1. `pilot/H1/` to `pilot/H4/`: each host's pilots. One directory for each workload (`plain` and
   `beside` on H1, `wait` on H2, `close` and `after` on H3, `unstaged` and `besidemt` on H4),
   holding the kit's `results/` whole (every placement's counts, raw log, answers and server
   logs under `pilot-<workload>/`; the checks made before the turns; the base's link map and its
   record; the plan, `plan.env`, `commits.env` and the kit's lists as the run had them;
   `report.md` and `report.json` as the host wrote them), `run.out` (the output of `run.sh`) and
   `build/` (the build's logs).
2. `dry/H1/` to `dry/H4/`: each host's dry runs, under `dry5/`: for each workload its self-test,
   a dry run of the pilot part and a dry run of the gated part with the base as both sides.
   `dry/H2/part5-test-220235/` is the one trial of the wrapper the addendum describes, a dry run
   too, and `dry/H2/root/part5-test.out` its output. `root/dry5.out` is the output of the script
   that ran a host's dry runs. The `plan.md` kept in the dry runs' results is the posted plan
   with one line end added at its end, as the addendum says; the trial's and the pilots' are the
   plan as posted.
3. `part5.sh`: the wrapper, as it started the pilot part and the gated part on every host. Its
   sha256 is the one the addendum gives.
4. `lists/`: eight files, one for each directory above (`pilot-H1.sha256` to `dry-H4.sha256`).

## What is left out, and why

Each host's results were packed on the host as one archive. Everything in the eight archives is
here but 15 files: every workload's log of `setup.sh` (`setup.log` in a pilot's directory,
`dry5/<workload>-setup.log` in a dry run's, and the trial's `setup.log`). Those logs hold the
output of the system's package manager, which names where the hosts were rented, and this
repository does not record that. Nothing in them is read by the kit's report. Their lines are
still in the lists, so what was left out can be seen exactly.

The archives themselves are not here. Each one's sha256 and size are in the comment 7181271520
on pull request 2029, posted before any result of the gated part was read.

## How to check it

A list is the output of `find . -type f | LC_ALL=C sort | xargs sha256sum` in the root of one
unpacked archive: one line `<sha256>  ./<path>` for each of its files.

1. A list against the posted note: the sha256 of each file in `lists/` is the figure in the last
   column of that comment's table, in the row of its host and part.
2. A file against its list: in the directory a list is for, check the list, for example

   ```sh
   cd deadline-timer-6/pilot/H1 && sha256sum -c ../../lists/pilot-H1.sha256
   ```

   Every line reads OK but the setup logs' (two in `pilot-H1`, `pilot-H3`, `pilot-H4`, `dry-H1`,
   `dry-H3` and `dry-H4`, one in `pilot-H2`, two in `dry-H2`), which are the files left out.

The seven pilots' figures and reports are posted on the pull request, one comment for each
workload; each `report.md` here is the page its comment carries.
