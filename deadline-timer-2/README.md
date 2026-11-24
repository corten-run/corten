# The deadline's timer, second evidence directory (2026-11-24)

What backs design Choice `choice-deadline-timer` and the cycle plan in pull request 2029's
description, beside the first directory (`deadline-timer/`, the tag `evidence/deadline-timer`):
the rule that chose the form of the kept timer and the counts it read, the pilot that sized the
gated run's placements, the dry runs before it, and the checks and counts of the head's code.

This tag's commit has two parents: the commit of the tag `evidence/deadline-timer`, whose tree it
keeps whole, and `05c9bf95f`, the head of form C's branch (`prototype/deadline-slot`), which the
Choice cites and which is on no other branch of the repository.

Nothing here is a cycle count of the change read for a margin. The gated run had not started
when this tag was made.

Every file is stored byte for byte as it was fetched or written, with no line-ending
conversion: the answers a run recorded (`*.raw-headers`) keep their CRLF line endings.

## `variant-rule.md`

The rule, as written before form C was built. The forms: A is `098f56243`, B is A with
`rows/ab/two-stage.diff`, C is `05c9bf95f`. The branch's code at `ca259c467` is B with the second
review's findings applied.

## `rows/`

Instructions and allocations a request by callgrind, against `main` at `81e77162a`.

1. `rows/ab/`: A and B, one session. `rows-AB.md` is the table and the commands; it names its
   files under `variants/ab/`, which is this directory. `count5.py` and `r3-count.sh` are the
   scripts as run, `a-deadline.rs` and `b-deadline.rs` the two forms' module, `out/` every
   count and the run's log. Left out: the two scripts that packed the inputs and fetched the
   output (they name local paths) and the two trees, which are `git archive` of the commits.
2. `rows/c/`: C, another session on another host, with its own count of A as a control.
   `rows-C.md` is the table, the two variants of C's keep policy (d and t), what was observed of
   a deadline polled under another runtime's `EnterGuard`, and its checks; the scripts as run
   and `results/` are beside it. `variant-deadline.rs` is the variants' module and
   `scratch-test.rs` the test of the `EnterGuard` case. The app's entry file is the first
   directory's (`deadline-timer/app/`).
3. `rows/head/`: the branch's code at `ca259c467`. `rows-head.md` is the table (rows 1 to 7 of
   the rule, and rows 8 and 9, which the rule does not have) and the commands; `counts/` every
   count and the logs; `checks/` the output of the three cargo checks, of the tests against
   broken rules (`mut2.py` breaks one rule of the module at a time and `mut2.sh` requires the
   named tests to fail on it) and of the paused clock (`paused5.sh`).

## `kit/`

The kit that ran the pilot, as packed before its first turn (plan sha256
`235bf66b63628ea163de742aa826dd00366d72d6d812a4df5f722835f2ee872d`, of its `plan.env` and
`commits.env`), without the source tree `commits.env` names. `plan.md` is the plan as published
then. Its `commits.env` names `098f56243` as the head: the pilot reads the base alone and built
no head.

## `pilot/<workload>/`

The four pilots (`plain`, `wait`, `close`, `unstaged`): an A/A of the base `81e77162a` against
itself, K = 100, R = 8. `results/` is each host's results directory as fetched (`sha256.txt` in
it lists its files; `host.txt` is the CPU, kernel and tools). `report-local.md` is the report
made again from the fetched results, the same bytes as `results/report.md`. `pilot-confirm.txt`
is the K read once with the call the plan's rule names (the directory it read is given without
its local path). `run.out`, `pilot.sh.out` and `build-base.log` are the run's own output. Left
out: the host's setup log, which is the package installer's output and names the mirrors of the
host's provider.

## `dry/`

Every dry run, whole: on each of the four hosts `dry-pilot` and `dry-gated` (3 placements, 2
recorded pairs, 1 s turns, one placement made to pass its time limit), and on the `close` host
`dry-turn3` (3 placements at the plan's own turns). `plan-gated-trial.env` is the trial plan the
gated dry run used (placeholder K's) and `drycheck.out` the check of the dry runs' outcome with
every figure masked. Each is marked `DRYRUN`, is not a measurement and sizes nothing.

The gated dry runs counted cycles of both builds, the change comparisons of the head as it then
was (`098f56243`, form A) among them, after the plan was first published and before it was
corrected in six places. The plan names that as a departure from CONTRIBUTING: "The figures of
the change comparisons were not looked at, which nobody but the author can know. So that the
record is complete, the dry run's results, its reports among them, are published". They are
here for that reason, and they are of a form that is not the gated run's head.
