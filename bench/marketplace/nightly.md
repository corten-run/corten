# Nightly localized marketplace rounds

The nightly benchmark is `marketplace-v2`, from official **r17**
onward (FastAPI and Express joined after r17, which had eighteen). A round whose app set differs
from another's is not compared with it: `compare.mjs` gives no deltas across the two. `wN` remains for explicit development checks. Old fullstack r16 and catalog c1 are
different workloads, not baselines for a new-workload speedup or regression. Do not also run
the old suite or silently combine its tables with this one.

## Framework Groups

`groups.mjs` defines candidate cohorts, not language families or unconditional anchors.
The default `production` run deduplicates the popular and performance-oriented shortlists,
so overlapping peers are built and timed once. All candidates must qualify against
`marketplace-production/v1` on the exact image and configuration used for timing:

| Group | Adapters |
|---|---|
| production-popular | Corten, Next.js, ASP.NET, FastAPI, Express |
| production-performant | Corten, ASP.NET, Topcoat, Leptos |
| production | Deduplicated union of the two cohorts above (normal nightly) |
| production-qualify | Full current inventory, only for an explicitly requested capability audit |

The popular shortlist follows the survey cohort proposed in
[#817 A bench/fullstack round takes 5.5 hours, the planned tiers and repeats would take it past 15, and nothing sets which apps, phases and cadence each tier gets](https://github.com/corten-run/corten/issues/817),
updated for the added FastAPI and Express adapters. The performance-oriented candidates
start with that proposal's ASP.NET/Topcoat/Leptos shortlist, not a claim that legacy results
rank today's v2 implementations. Refresh candidate pools through reviewed changes, not
post-hoc removal of a slow peer. A new adapter is not automatically admitted to a cohort.
Axum is not an anchor: it may enter a capability audit, but without equivalent features it
has no row in a production comparison. The same rule applies to Corten and every peer.

Qualification reuses the existing production feature checklist: security headers and strict
script CSP, private caching, page/JSON compression, native form cross-site and size defenses,
404 handling, HTML/JSON upstream errors, HEAD, Host/header defenses, liveness, upstream failure/deadline handling,
incomplete-head timeout and connection cap. Fixture mode omits only upstream-failure probes.
Conditional GET/ETag and downstream readiness are disclosed exceptions: this workload times
uncached identity responses, not conditional reads or readiness traffic. Request logging is
not a scored feature. This is scoped production parity, not every enterprise capability.
Native implementations need not use identical algorithms or middleware. No harness polyfill
adds a missing application feature to make a candidate qualify. Qualification describes the
measured adapter configuration, not what a framework could support in another application.
Native request logging is retained and disclosed, not made artificially identical.
Cross-site probes omit only known native hidden antiforgery tokens that an attacker cannot
read; public routing fields remain. A legitimate same-origin POST must still succeed.
Missing pages must return 404, but may use their native empty or HTML representation.

The production profile uses native `PROFILE=matched` configuration and a connection cap.
Probe both sources before timing; save raw probes, derived cells and every missing feature.
Unsupported candidates are explicitly excluded, never assigned throughput. An unhealthy
probe, failed build, harness error or failed browser/content gate still fails the round.
Require a qualified Corten and at least one qualified peer, otherwise preserve the evidence
as a failed round, not a comparison. Report excluded candidates alongside admitted ones.
An eligibility loss after a prior qualified round is a suspected regression to triage
(`compare.mjs` retains `qualificationLosses` even when it forbids performance deltas),
not a reason to silently remove a framework from history or retest until it passes.

All locales, sources, phases, passes and correctness gates remain identical within each
group. The saved reservation records the group and exact candidate list before cloud creation;
collection requires that same list and re-derives admission from raw qualification evidence.
`--group production-qualify` requests an explicit inventory audit, while
`--collect` always uses the reserved selection and refuses a new group argument.
Never override the selection with `--apps` in an official round. A direct `run.mjs` command
without `--group` retains the full inventory for compatibility with older reservations.
Keep the last compatible baseline in operator state `groupBaselines[group]` (round and
measuredCommit) separately for each group, updating it only after validated results merge;
retain lastFullRound/measuredCommit as the latest merged run. Never compare a group with a
different group or a different admitted set. Reports must name the feature profile, group,
admitted, excluded and omitted adapters. Omitted apps were not tested; excluded candidates
were probed but not timed. Grouping changes coverage and cost, not the required work.
Record measured wall time from the first
finished round of each group, not an estimated or promised budget.

The operator's schedule supplies checkout, maintenance state/log directories and SSH key ID.
The evening invocation decides and launches; the morning invocation collects and reports.
An unfinished job continues until a later collection. Builds, parity and three load passes
are not guaranteed to finish by the morning check.

## Contract

1. Every feature-qualified app must pass the existing full browser/conformance gate for both sources
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
and README/nightly docs. The first round that validates is an explicit first-baseline
migration even with legacy state.
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

## Split Rounds

A round may be split across droplets started together with `--droplets <n>`
([#816 A bench round runs every app in sequence on one droplet, so its wall time grows with each app, tier and repeat, and it cannot be split across droplets and still compared](https://github.com/corten-run/corten/issues/816));
the [marketplace README](README.md#splitting-a-round-across-droplets) describes the split, the
merge and the check. The nightly default stays one droplet until a split round has been run and
validated with Todd's approval. A split is worth launching only when the latest single-host
round's qualification admitted enough peers to give every part at least one: a part whose peers
are all excluded makes the round unmergeable, and that shows only after the other droplets have
spent their hours. Compare the `--plan` split with that round's Feature Qualification table
before launching. As of 2026-11-12 the local qualification admits only Corten and ASP.NET Core,
so every split of `production` leaves a part with no peer, and the default stays one host. When
splitting, check `--plan` first, then launch with the same
state directory rules as above:

```sh
node bench/marketplace/droplet.mjs r17 --droplets 3 --ssh-key <saved-key-id> --state-dir <round-control-directory> --detach
node bench/marketplace/droplet.mjs r17 --state-dir <round-control-directory> --collect
```

Each droplet is a dedicated c-8 with the same pinning, passes, windows and rate. The launch
checks the account's droplet limit before it writes `split.json`, and `--collect` needs no
`--droplets`: it reads the plan. A running launch holds `launch.lock` (its pid) in the state
directory, and collect refuses while that pid runs; as with collect.lock, check the exact
process, and never remove a live lock. A lock whose pid is not running is a killed launch:
collect removes it and collects the stopped launch. The launcher ignores SIGHUP, so a closed
terminal does not stop it. Exit codes are as above, for the round: 3 while any droplet
runs (finished droplets are already collected and deleted), 2 for a collection error on any
droplet or a leftover `corten-marketplace-rN-d*` droplet (reported with its delete command, never
deleted), 1 when a droplet did not finish its part or the parts do not merge, 0 when every
droplet finished, was deleted and merged into `round/rN/` in the state directory. Exit 2 wins
over 3: a droplet can still be running when collect exits 2. Then fix what it names and collect
again until it exits 0 or 1; never relaunch. When a droplet never started, is partial or is
missing, the round cannot merge, and collect prints an `ssh ... systemctl stop` command for each
droplet still running, whatever the exit code: run each, then collect again. This overrides "keep
running" above, so a round that cannot merge stops billing. Import that merged folder, not a
droplet's `d<k>/` alone, as results/rN. A launch stopped by a signal says what each droplet is
left doing, and saves it as `launch-stopped.txt` in the state directory; stop a started round
with the `ssh` command it prints, then collect. A droplet whose launch stopped before
`systemctl start` (`creating` or `preparing`) never ran its round: the launch and collect both
print what to delete (collect finds a droplet whose create returned no id by name and run tag,
and checks its ownership tags before printing a `doctl` delete command); run it. A `starting` droplet is collected, never deleted on a
guess. A split round compares only with a round split the same way, droplet by droplet, so
droplets that land on different CPU models refuse comparison with a baseline whose droplets
differ (see the README); its report's Between droplets section flags stages where Corten's own
numbers differ between droplets, and a flagged stage is reported, not hidden. A split splits the
launch's group, never the whole inventory: Corten on every droplet, each other candidate on one,
each qualified on its droplet with the same feature contract, and no anchor. A droplet that
admits no peer fails its part, and the merge accounts for every candidate once, admitted or
excluded with its evidence. The merge also refuses a part that did not finish clean (checks
passed, no failures, a clean tree at the plan's commit) and parts that did not run together.

## Finished Results

1. Require exit 0, saved archive/checksum, deletion confirmation and report.mjs validation:
   workload/round/commit match, clean before/after, raw qualification for the complete reserved
   candidate set, both browser gates and three full passes for every admitted app/profile
   (fewer only where the app's container stopped, below), no
   harness, parity or cleanup failure, correct counted CPU and aggregates matching saved
   passes. Incomplete data is never a full baseline. Requests an
   app answered with anything but a 200 or timed out on, and fixed-rate iterations it could not
   start, are its measured outcome under the profile, not a run failure: each such phase is
   recorded with its failure rate and drops, the later phases still run, and the report marks
   it (#1128). Report each marked stage beside the numbers; never retry it away or drop the
   app. An app container that exits or is OOM-killed during a load phase, warmup included, is
   that app's outcome too: the stop is recorded with its pass, phase, exit code and OOM kill,
   that profile's later phases and passes do not run, every other app and profile keeps its
   results, and each stage that lost a pass is marked `(stopped: n of 3 passes)` with a line
   naming the stop; of two passes each number is the lower of its column's two values, not a
   median. A stop counts as the app's only when the container stopped after the phase began
   (for an OOM kill that left it running, Docker's oom event is in the phase), the CPU counter
   sidecar and, for an HTTP-source profile, the upstream are the same containers still running,
   Docker recorded no kill, stop or restart of the app during the phase, and nothing failed that
   the stop does not explain (only docker stats errors stamped after the app finished, its
   stats going with its container); otherwise it is a harness failure. A 200 of the wrong
   content type, before or without a stop, an app that stops during its cold start or before
   the phase began (after its first 200, before warmup or between phases), an upstream error
   answer, or a phase in which no request succeeded still fails the run.
2. Hash summary before/after the read-only reporter. Save its generated report as
   results/rN/report.md and exact SHA as commit.txt. Preserve raw logs/checks/image provenance.
   Collection keeps the result folder outside Git in the round-control evidence directory.
   Import that folder into a new bench/marketplace/results/rN only after validation, without
   overwriting an existing folder. Stage and verify any interrupted import separately before
   promotion; never change the archived source. Keep the original hash-verified archive outside
   Git, with a checksum receipt in the committed results folder. Do not publish credentials or
   local control state. Pre-measurement failures may have only run.log/exit-code in evidence.
3. Fetch origin, create bench/rN from origin/main carrying only the untracked result folder.
   Commit results first and docs second. Push only bench/rN. Never overwrite another change.
4. The first round that validates is the first v2 baseline, no r16/c1 delta. r17 ran under
   the earlier gate, which failed the round on any app's failed request, and has none. Later
   compare only validated v2 results with
   identical fixture, matrix, windows/rate, encoding, quotas/pinning and implementation tier.
   Check unchanged adapter and shared paths in the measured commit range, not image hashes.
   Shared semantic changes can require a new baseline. Never use legacy fullstack trend
   schemas/baselines on v2. Do not turn a workload change into a framework regression.
   Use compare.mjs with current and baseline summary paths and --unchanged-apps listing only
   verified unchanged reference adapters. It always compares Corten and reports the reference
   cohort's median percentage changes separately; an incompatible comparison emits no deltas.
   Named-group rounds write `marketplace-results/v5`, including raw native qualification and
   the exact reserved candidate set. The reader retains groupless `marketplace-results/v4`
   and `marketplace-results/v3` history. A v3 summary (r19 and other rounds before app stops
   were recorded) has no stop records, since under v3 an app that stopped failed the round.
   Compatible groupless v3/v4 rounds may compare, but neither becomes a named-group baseline.
   report.mjs rejects any other schema and never relabels old evidence as qualified v5.
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
6. A Corten stage in compare.mjs's newOutcomes: more passes with an app outcome than the
   baseline, any failed request or dropped iteration where the baseline had none in any pass,
   a failure or drop range wholly above a nonzero baseline's (overlapping ranges are not a
   difference), or a stage its container stopped in where the baseline's did not or stopped
   later (the stage has fewer passes, or the stop came in an earlier pass or an earlier phase
   of the same pass). A Corten stage that fails any request, or whose container stops, is a
   regression from a baseline in which it did neither, whatever the percentages. A stage
   stopped in either round has no deltas, and neither do the cold starts of a profile that lost
   a pass to a stop.

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
incomplete/invalid data does. A harness, parity, cleanup or load-run failure leaves results
partial, no success PR; a stage marked as an app outcome or as stopped does not.

On conflicts rebase only the automation's bench/rN, keep main's text and reapply measured
numbers, force-with-lease only that branch, review again and wait for CI. Retry a failed CI job
once only with logs proving an unrelated network/browser flake. Otherwise leave pr-open and
report the failed condition. Never merge another PR. Confirm merge SHA, update lastFullRound,
measuredCommit/workload/status done, fetch and detach the clean benchmark checkout at main.

Report titled merged PR, measured commit/CPU/date/profile/group, measured-group throughput table,
Corten CPU/memory/latency/cold rows and pass ranges, compatible comparison or first-baseline
notice, all warnings and titled regression links. Keep history and other authorized jobs intact.
