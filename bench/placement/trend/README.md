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
| run | The date the run started, in UTC. Each workload's seed is that date and the workload's place in the plan. |
| base | The last release: the highest tag `vX.Y.Z` when the run started, and its commit. |
| head | The commit `main` was at when the run started. |
| workloads | For each workload of the plan, the change in user plus kernel cycles a request, `main` against the release, across K placements: the lower bound to the bound (each one-sided, 95% nominal, as [design Choice 72](../../../docs/design.md#choice-placement-runs) gives the bound), then the median of the placement medians and K, which the run's own pilot sized. "A/A resolved" says the release against itself read under +1% both ways in the same run, which is what lets the run be read. "answers differ" says the release and `main` answer the workload's request differently, so part of the change may be what the answer now holds. |
| reading | `pass at` the threshold: every workload was read and none is past it. `past` the threshold, with the workloads: the lower bound is at or above it, so the run shows `main` costs at least that much more. `not read`, with the workloads: nothing is known of them from this run, and the workloads cell says why (an A/A that did not resolve, a pilot that sized no K, a part that did not complete, a probe that does not build at the release). A run with a workload not read is never a pass. |

The threshold is the plan's, +2% on the lower bound, a proposal until it is settled. It is not
the +1% a measured change is held to: that is read on the bound, and the kit's own page for
each part still prints it. A run past the threshold prints the pull requests merged since the
run before it and an issue to open.

A row's figures are read from the run's directory, each part's `results` as the kit leaves
them. Whoever makes the run keeps that directory under the tag `evidence/trend-<the run's date>`.

| run | base | head | workloads: lower bound to bound, `main` against the release | reading |
| --- | --- | --- | --- | --- |
