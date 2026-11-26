# The deadline's timer, seventh evidence directory (2026-11-26)

The raw results of Part 2 of the cycle plan posted on pull request 2029 (the plan is the
comment 7175633556 there, its addendum the comment 7176100779): the gated run of the seven
workloads. The kit that ran them is under the tag `evidence/deadline-timer-5`
(`deadline-timer-5/kit/`), unchanged, and the wrapper that started the part on each host under
the tag `evidence/deadline-timer-6` (`deadline-timer-6/part5.sh`).

A gated run of a workload is two comparisons across K placements of 8 recorded pairs: the base
`26ab0e37f` against itself (the A/A, under `aa-<workload>/`) and the base against the head
`f8934bc99` (the change, under `change-<workload>/`). K is the workload's pilot's: 30 for
`plain`, `close`, `after`, `beside` and `besidemt`, 69 for `wait`, 53 for `unstaged`. The part was
started on the four hosts between 02:31:07 and 02:31:35 UTC on 2026-11-26 and ended on the last
at 05:35:25 UTC, every `run.sh` with exit 0. Nothing was run again.

Every file is stored byte for byte as the host wrote it, with no line-ending conversion
(`.gitattributes` here says so to git): the answers a run recorded (`*.raw-headers`) keep their
CRLF line endings.

## What is here

The four hosts are H1 to H4, as the plan names them.

1. `gated/H1/` to `gated/H4/`: each host's gated runs. One directory for each workload (`plain`
   and `beside` on H1, `wait` on H2, `close` and `after` on H3, `unstaged` and `besidemt` on H4),
   holding the kit's `results/` whole (every placement's counts, raw log, answers and server
   logs under `aa-<workload>/` and `change-<workload>/`; the checks made before the turns, and
   for `beside` and `besidemt` the watched turns under `park/`; both sides' link maps and their
   records; the plan, `plan.env`, `commits.env` and the kit's lists as the run had them;
   `report.md` and `report.json` as the host wrote them), `run.out` (the output of `run.sh`) and
   `build/` (the builds' logs and each placement's layout).
2. `lists/gated-H1.sha256` to `lists/gated-H4.sha256`: one list for each directory above.
3. `lists/catalog-left-out.sha256`: the list of six files that are not here (below).

Each host packed its results as one archive, which was copied and its sha256 compared at both
ends. The archives themselves are not here:

| Host | Workloads | Archive, bytes | Archive, sha256 | Files in it | Left out | Its list, sha256 |
|---|---|---:|---|---:|---:|---|
| H1 | beside, plain | 2399829 | `319e6bffc2ccd9c8c275ada4861d4f27c6e62f532ac48fb3f479df52681ba761` | 10824 | 2 | `fcc66ed68811f7fb06f67347faed09c45b946a7e3b2d685aca893e24a17826f7` |
| H2 | wait | 1781756 | `57459f607ff539f7263a3c70bf13cf86aa0844d3abf8d823b4b7bdeac4dea7cd` | 12296 | 1 | `0a2596d7a23a484b6627058e33036087121c9c2c099414163afe0cb3c4089626` |
| H3 | after, close | 2430035 | `7107906ae14d7bf96b2ea8dd5985ea7d1ce570d58db94fa9c46830b1b142d05b` | 11370 | 2 | `79d59016afd2061e37d5b100ddff0f966fbfa65f08b9e6c55b2b4e0aeb966950` |
| H4 | besidemt, unstaged | 2697770 | `6c0cec90ceaa147b6ae184f3ca3f747e0a40532639883358a3f5f2738f873394` | 14895 | 2 | `72a61faf91d41c2a886d6b09c1d7b7955a5fbcfb3d8f56a473c3213c9670776b` |

Unlike the pilots' lists, which the pull request has in a comment posted before any gated result
was read, these figures were posted nowhere before this directory was made: each workload's
reading was posted first, as its own comment, and this table is the first record of the archives
and of their lists.

## What is left out, and why

1. Seven files of the four archives: every workload's log of `setup.sh` (`setup.log` in its
   directory). Those logs hold the output of the system's package manager, which names where the
   hosts were rented, and this repository does not record that. Nothing in them is read by the
   kit's report. Their lines are still in the lists, so what was left out can be seen exactly.
   The maintainer decided this for the fifteen such logs of Part 1 (the comment 7202382504 on the
   pull request), and said the gated part's results follow by the same rule.
2. Everything fetched from the host of the catalog's count, which did not run: that host stopped
   27 s into the kit's `setup.sh`, before any image was built and before any request was counted
   (the comment 7193816114), and the maintainer left the count unread and not taken again (the
   comment 7197358710). What was fetched afterwards is six files: the output of the script that
   started the count, the log of `setup.sh`, a listing of the host's directories, and three
   records of the system's own (its list of boots and its journal for the last two). They hold
   no count and no result, and the system's records name the host. `lists/catalog-left-out.sha256`
   has each one's name and sha256, so what is left out can be seen exactly.

## How to check it

A list is the output of `find . -type f | LC_ALL=C sort | xargs sha256sum` in the root of one
unpacked archive: one line `<sha256>  ./<path>` for each of its files.

1. A list against the table above: the sha256 of each file in `lists/` is the figure in the
   table's last column, in the row of its host.
2. A file against its list: in the directory a list is for, check the list, for example

   ```sh
   cd deadline-timer-7/gated/H1 && sha256sum -c ../../lists/gated-H1.sha256
   ```

   Every line reads OK but the setup logs' (two in `gated-H1`, `gated-H3` and `gated-H4`, one in
   `gated-H2`), which are the files left out.

The seven readings are posted on the pull request, one comment for each workload, and together
in the comment 7183984810. Each workload's comment carries its `report.md` here whole, after the
comment's own summary.
