# The trend: `main` against the last release

One row a run, the newest first. A run reads `main` against the last release across placements,
so that costs that each passed do not add up unseen
([CONTRIBUTING.md](../../../CONTRIBUTING.md#pull-requests), Pull requests, item 2.1, Trend;
[design Choice 76](../../../docs/design.md#choice-counted-or-measured)). It is made with the
[placement kit](../README.md#the-trend) from the one plan in [`plan.json`](plan.json), by one
command, `node bench/placement/trend.mjs <run dir>`, which adds the row. A table with no row
means no run's row has been published here, not that nobody has made a run.

A row gates nothing: no pull request waits on it and no release is refused by it. It reads
every change since the release together and attributes a cost to none of them.

| Column | What it is |
| --- | --- |
| run | The date the run started, in UTC. One run a date: each workload's seed is that date and the workload's place in the plan, and the command refuses a date that is not later than the table's newest row, as the run's checkout has the table. |
| base | The last release: the highest tag `vX.Y.Z` when the run started, and its commit, linked by its full id. |
| head | The commit `main` was at when the run started, linked by its full id. |
| workloads | For each workload of the plan, the change in user plus kernel cycles a request, `main` against the release, across K placements: the lower bound to the bound (each one-sided, 95% nominal, as [design Choice 72](../../../docs/design.md#choice-placement-runs) gives the bound), then the median of the placement medians and K, which the run's own pilot sized. "A/A resolved" says the release against itself read under +1% both ways in the same run, which is what lets the run be read. "answers differ as recorded" is explained under the table of columns. |
| reading | `pass: no rise of` the threshold `shown`: every workload was read and none has its lower bound at or above the threshold. That is all a pass says. It does not say the cost is under the threshold: a workload whose lower bound is +1.9% and whose bound is +5% is a pass. `past` the threshold, with the workloads: the lower bound is at or above it, so the run shows `main` costs at least that much more. `not read`, with the workloads: nothing is known of them from this run, and the workloads cell says why (a probe that does not build at the release, a step of a part that failed, a pilot that sized no K, a part that did not complete, a report that is not this run's or cannot be read, a placement that answered with another body, an A/A that did not resolve). A run with a workload not read is never a pass. |

"answers differ as recorded" says the release and `main` answer the workload's request
differently, so part of the change may be what the answer now holds and not the path to it.
Nobody reviewed that difference. The run found it before any turn, by starting each side once,
and recorded it; a wrong answer that `main` gives every time with the expected status would be
recorded like any other. A pilot's or an A/A's placement has the release on both sides, which
must answer alike. A placement of the change, the release against `main`, is held to what was
recorded:

1. The status line and every header line but `Date`, after the plan's mask (the plan masks no
   header): the lines that differ, with both sides' values, are the ones recorded and no others.
2. The two bodies' lengths in bytes and their SHA-256s, the release's and `main`'s, or the one
   body's when the two are the same. A pilot's or an A/A's placement must show the release's on
   both sides.

The kit's `turns.sh` holds a placement of the change to both before its turns: the recorded
difference is its plan's expected one, and ends with a bodies line of both bodies' lengths and
SHA-256s, or of the one body's when the headers alone differ, so it binds the body even then. A pilot's or an A/A's placement has none, and `turns.sh` holds its two sides to each
other; the command then holds every placement to the bodies it recorded, by the first 16
hexadecimal digits of each SHA-256, which `turns.sh` keeps for each placement. A placement that
fails any of them makes its workload "not read". The run's directory keeps the difference
(`expect-<workload>.txt`) and the digests (`bodies-<workload>.txt`) for whoever reads the row.

The threshold is the plan's, +2% on the lower bound. It was a proposal until 2026-11-27, when
the maintainer settled it at that figure, given the first row below
([design Choice 76](../../../docs/design.md#choice-counted-or-measured) records the ruling). It
rests on two things. In the first run, of 2026-11-26, both A/As resolved: each A/A's bound, as
recorded and with its labels swapped, was +0.62% and +0.31% on `plain` at K = 60 and +0.47% and
+0.61% on `unstaged` at K = 28, under the +1% the kit asks of an A/A, so +2% is over three times
what that run read between two builds that are the same. And 2% is the figure the maintainer
accepted on 2026-11-25, as a proposal, for what a release may carry over the one before it,
there of the request-cost kit's counts of instructions in a case and not of cycles. Those are
one run's bounds, not a limit on what a run of this plan can show, and one run does not show
what rise a release can carry: the threshold is a ruling, not a measured line, and it gates
nothing. It is read again once four weekly rows are in the table below. The threshold is not
the +1% a measured change is held to: that is
read on the bound, and the kit's own page for a gated part still prints that reading (a pilot's
reads nothing: it sizes K). For a run past the threshold the command drafts an issue with the
pull requests merged since the row before it, or since the release when the draft says so, and
opens nothing.

A row's figures are read from the run's directory, each part's `results` as the kit leaves
them. Whoever makes the run keeps that directory under the tag `evidence/trend-<the run's date>`.

| run | base | head | workloads: lower bound to bound, `main` against the release | reading |
| --- | --- | --- | --- | --- |
| 2026-11-26 | v0.2.0 [`a833b4e3e`](https://github.com/corten-run/corten/commit/a833b4e3e55033c5fa179f50cb9291d190aeedfb) | [`056aba61c`](https://github.com/corten-run/corten/commit/056aba61c56cce4b2672b8f299b4961e476654ef) | `plain` -6.53% to -5.77%, median -6.17%, K = 60, A/A resolved, answers differ as recorded; `unstaged` -1.84% to -0.96%, median -1.62%, K = 28, A/A resolved | pass: no rise of +2.00% shown |
