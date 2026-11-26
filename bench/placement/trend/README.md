# The trend: `main` against the last release

One row a run, the newest first. A run reads `main` against the last release across placements,
so that costs that each passed do not add up unseen
([CONTRIBUTING.md](../../../CONTRIBUTING.md#pull-requests), Pull requests, item 2.1, Trend;
[design Choice 76](../../../docs/design.md#choice-counted-or-measured)). It is made with the
[placement kit](../README.md#the-trend) from the one plan in [`plan.json`](plan.json), by one
command, `node bench/placement/trend.mjs <run dir>`, which adds the row. A table with no row
means no run has been made.

A row gates nothing: no pull request waits on it and no release is refused by it. It reads
every change since the release together and attributes a cost to none of them.

| Column | What it is |
| --- | --- |
| run | The date the run started, in UTC. One run a date: each workload's seed is that date and the workload's place in the plan, and the command refuses a date the table has a row of. |
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
2. The two bodies' lengths in bytes.
3. The first 16 hexadecimal digits of each body's SHA-256, the release's and `main`'s. A
   pilot's or an A/A's placement must show the release's on both sides.

The kit's `turns.sh` holds a placement to the first two before its turns. The third is the
trend's own: `turns.sh` keeps the digests for each placement, and the command compares them
after each part with the two it recorded. A placement that fails any of them makes its workload
"not read". The run's directory keeps the difference (`expect-<workload>.txt`) and the digests
(`bodies-<workload>.txt`) for whoever reads the row.

The threshold is the plan's, +2% on the lower bound, a proposal until it is settled: no run has
shown what a run of this plan resolves. It is not the +1% a measured change is held to: that is
read on the bound, and the kit's own page for each part still prints it. For a run past the
threshold the command drafts an issue with the pull requests merged since the row before it,
and opens nothing.

A row's figures are read from the run's directory, each part's `results` as the kit leaves
them. Whoever makes the run keeps that directory under the tag `evidence/trend-<the run's date>`.

| run | base | head | workloads: lower bound to bound, `main` against the release | reading |
| --- | --- | --- | --- | --- |
