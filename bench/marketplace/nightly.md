# Nightly localized marketplace rounds

The nightly benchmark is `marketplace-v2`, all eighteen adapters, from official **r17**
onward. `wN` remains for explicit development checks. Old fullstack r16 and catalog c1 are
different workloads, not baselines for a new-workload speedup or regression. Do not also run
the old suite or silently combine its tables with this one.

The operator's schedule supplies checkout, maintenance state/log directories and SSH key ID.
The evening invocation decides and launches; the morning invocation collects and reports.
An unfinished job continues until a later collection. Builds, parity and three load passes
are not guaranteed to finish by the morning check.

## Contract

1. Every selected app must pass the existing full browser/conformance gate for both sources
   before any app is timed. All three locales, desktop/phone, JS on/off, numeric cases,
   page sections, forms and uncached upstream probes remain required. Do not relax checks.
2. Time pages in `en-US`, `fr-FR` and `de-DE`, doing equivalent request-time localization.
   JSON remains numeric and locale-independent: time it once per source/pass, not three
   copies under locale names. Page and JSON do different application work; byte length alone
   does not predict equal throughput. Native algorithms need not be identical.
3. Nightly uses three rotated passes, 10 seconds warmup and 15 seconds per fixed-rate,
   64-user and 256-user phase, fixed rate 150 requests/second. These are shorter than manual
   defaults. Publish medians and min/max, not unsupported small-difference claims.
4. Dedicated c-8: CPU 0 system, 1 app, 2-3 upstream, 4-7 generator, with recorded quotas and
   disjoint pinning. The single Node upstream can saturate one core despite its two-core
   quota. Report upstream CPU at least 80% and app CPU below 95% as limits, across phases.
5. This suite measures throughput, latency, counted CPU, memory and container cold starts.
   Build logs and browser correctness do not measure build cost or interactivity. Keep
   old build, bytes, instruction and browser-timing tables explicitly historical until
   equivalent new-workload measurements exist. Never invent or transplant a new row.

## State And Collection

Read the operator's nightly state first: done, running, pr-open or failed. Preserve legacy
state/issue numbers separately as history. A launch records workload, round, commit, night,
startedAt, log and launcher state directory; only validated finished results update
lastFullRound/measuredCommit. r17 has no compatible preceding round. Old regressions cannot
be declared resolved from this workload. Do not close, label or assign any issue.

For pr-open, inspect only that automation-created PR under the merge rules below. Do not
launch while it is unmerged. For a legacy open PR, finish its legacy validation separately.

For running, append output to its log and invoke from the benchmark checkout:

```sh
node bench/marketplace/droplet.mjs r17 --state-dir <round-control-directory> --collect
```

Poll command completion at most 60 seconds apart, up to 30 minutes. Exit 3 means running:
preserve everything; report progress/elapsed time in the morning or after ten hours. Exit 0
means validated results downloaded and deletion confirmed. Exit 1 means partial/failed data
downloaded and deletion confirmed: mark failed, leave artifacts uncommitted, report the
failing stage/error, no docs/results PR or success baseline. Exit 2 or timeout is a collection
error: preserve state/droplet/artifacts and report exact lines, no relaunch. The third identical
collection error marks failed while retaining identity and recovery state. A collect.lock
collision requires checking its exact process; never remove a live lock or collect twice.

The launcher verifies ID, exact name, both shared tags and unique ownership tag, plus a loaded,
terminal unit with Restart=no, before download and again before deletion. It saves and hashes
complete or partial evidence first. Missing units/SSH failures/identity mismatches fail closed.
Do not manually delete, restart or power-cycle running rounds, or touch another run's droplet.
Retry collection after a cleanup failure using the same durable state, not another launch.

## Evening Launch

Only launch between 11 PM and 5 AM Central, at most once per Central night, from done/failed.
Before midnight and its following early morning are the same night. Reserve the night before
calling the launcher; ambiguous launches consume that attempt. Never clear it to retry.

Fetch origin and compare main with measuredCommit. Same SHA: report matches and stop. After a
v2 baseline, skip documentation/results-only changes. Measured inputs are crates/, marketplace
code, shared catalog measurement/check helpers, fullstack adapters/apps.mjs/passes.mjs/
conformance.mjs, Cargo/npm manifests/locks and scripts/steady.mjs. Exclude result directories
and README/nightly docs. r17 is an explicit first-baseline migration even with legacy state.
Do not relaunch a failed commit unchanged from main. Existing corten-bench or corten-marketplace
droplets block launch. Leave independently authorized corten-catalog jobs entirely alone.

Use only the configured benchmark checkout, never the operator's main checkout. Require clean
status, fetch and detach origin/main. Do not stash/reset/discard unexpected files. A detached
catalog job uses its own remote clone; keep its local collector/state/archive intact. Do not
switch under any local process actually building or measuring from this checkout.

Choose the next rN, at least r17, above state, legacy and marketplace result directories on
origin/main and local/remote bench/r* branches. Never reuse an existing result folder. Record
running state and night, then launch hidden from the clean benchmark checkout:

```sh
node bench/marketplace/droplet.mjs r17 --ssh-key <saved-key-id> --state-dir <round-control-directory> --detach
```

Use doctl's saved default context, not an injected token. The launcher exclusively reserves
before create, makes one fresh c-8, then provisions/builds/gates/measures on that host by itself.
Wait up to 20 minutes in polls at most 60 seconds. Require exit 0, droplet ID/IP, the log's
running-round-by-itself marker and durable launcher status running. Report round, commit and
commits main moved. On uncertainty inspect the reservation and owned host, never create again.
If unit is running, keep running. If terminal, collect partial data. If missing, preserve the
host and report the provisioning error rather than guessing deletion is safe.

## Finished Results

1. Require exit 0, saved archive/checksum, deletion confirmation and report.mjs validation:
   workload/round/commit match, clean before/after, all eighteen apps, both gates, three full
   passes of each intended profile, zero request failures/drops and cleanup failures, correct
   counted CPU and aggregates matching saved passes. Incomplete data is never a full baseline.
2. Hash summary before/after the read-only reporter. Save its generated report as
   results/rN/report.md and exact SHA as commit.txt. Preserve raw logs/checks/image provenance.
   Keep the original hash-verified archive outside Git, in maintenance storage, with a checksum
   receipt in the committed results folder. Do not publish credentials or local control state.
3. Fetch origin, create bench/rN from origin/main carrying only the untracked result folder.
   Commit results first and docs second. Push only bench/rN. Never overwrite another change.
4. r17 is the first v2 baseline, no r16/c1 delta. Later compare only validated v2 results with
   identical fixture, matrix, windows/rate, encoding, quotas/pinning and implementation tier.
   Check unchanged adapter and shared paths in the measured commit range, not image hashes.
   Shared semantic changes can require a new baseline. Never use legacy fullstack trend
   schemas/baselines on v2. Do not turn a workload change into a framework regression.
   Use compare.mjs with current and baseline summary paths and --unchanged-apps listing only
   verified unchanged reference adapters. It always compares Corten and reports the reference
   cohort's median percentage changes separately; an incompatible comparison emits no deltas.
5. Update marketplace README Results intro/link with round, UTC date, CPU, measured SHA,
   profile/windows and limits. Generate current server tables in docs/performance.md from the
   reporter: all page locales, JSON once, sat64 and sat256 throughput/latency, fixed CPU/memory,
   counted efficiency, cold starts and pass ranges. Keep old build/bytes/instructions/browser
   sections explicitly historical. Replace root README's server headlines with measured v2
   numbers, no overall fastest claim. Rewrite the existing benchmark docs changelog entry,
   not a new duplicate. Keep features as separate evidence-linked capabilities.
6. Re-read every number against saved evidence and check sorting/labels/ranges/limits. Search
   obsolete old-round headlines outside history. Run reporter/tests, npm run check,
   npm run check:marketplace and git diff --check. Docs commit may change only README.md,
   CHANGELOG.md, docs/performance.md and marketplace README. Obtain independent diff review.

## Comparisons And Issues

Use only compatible v2 rounds, per source/page-locale/JSON and phase. State both commits/CPUs,
medians/ranges and unchanged-app median changes. No causal claim from one round. Consider:

1. sat64 throughput or requests/CPU-second trailing unchanged apps' median change by more
   than 10 percentage points.
2. Fixed CPU rising over 1.5 points and 25% without an unchanged-app median rise.
3. Fixed or sat64 peak memory rising over 15% and 2 MiB.
4. Cold-start median rising over 25% and 2 ms.
5. p95 latency rising over 10% while unchanged apps move less than 5%, or a previously passed
   test failing. Invalid/failed runs are failures, not successful slower baselines.

Inspect open automation-created v2 regression issues in state, then repository issue search;
comment exact new numbers on a matching metric rather than duplicate it. Otherwise create one
issue per distinct regression, with compatibility, commits/CPUs/ranges, unchanged-app context,
uncertainty, relevant commit log, reproduction and titled results PR link. Mark Opened by the
nightly benchmark automation. Keep its number in state; drop closed issues. Comment recovery
only with compatible evidence and leave closing to Todd. Legacy issues remain separately open.
Do not infer instruction/bytes/build/interactive regressions from this suite.

## Pull Request And Report

Open bench/rN against main titled Benchmark round rN: localized marketplace results and docs
from <short SHA>, attach it to the task, set pr/status pr-open. Include measured machine/SHA,
profile, Corten rows, compatible comparison or first-baseline statement, all limits/failures and
regressions. Every named issue/PR must be a Markdown link with its actual title.

Poll exact-head GitHub checks at most 60 seconds, up to 40 minutes. Merge with a merge commit
only with every check SUCCESS, mergeable state, no unresolved independent-review findings,
passed docs validation, and diff limited to marketplace/results/rN plus root README, CHANGELOG,
docs/performance and marketplace README. Valid regressions do not block truthful results;
incomplete/invalid data does. Failed app/gate/load results remain partial, no success PR.

On conflicts rebase only the automation's bench/rN, keep main's text and reapply measured
numbers, force-with-lease only that branch, review again and wait for CI. Retry a failed CI job
once only with logs proving an unrelated network/browser flake. Otherwise leave pr-open and
report the failed condition. Never merge another PR. Confirm merge SHA, update lastFullRound,
measuredCommit/workload/status done, fetch and detach the clean benchmark checkout at main.

Report titled merged PR, measured commit/CPU/date/profile, eighteen-app throughput table,
Corten CPU/memory/latency/cold rows and pass ranges, compatible comparison or first-baseline
notice, all warnings and titled regression links. Keep history and other authorized jobs intact.
