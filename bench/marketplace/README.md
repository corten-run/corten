# Marketplace v2: equivalent localization work

**A separate application workload, with twenty native adapters and a pre-load conformance
gate.** Every selected app must pass the Docker/browser checks before any load test starts.
No v2 performance baseline is published here. Passing the formatting-capture checker alone
never qualifies an app for load testing.

Keep both workloads' history. [Catalog](../catalog/README.md) isolates a strings-only page and JSON;
marketplace v2 measures a richer application with equivalent locale formatting. Neither
replaces the other's results. Historical [marketplace rounds](../fullstack/README.md) keep
their recorded implementation and caveats. V2 starts a new baseline, not an r16 speedup.
Nightly execution moves to v2 starting at official r17; catalog remains a separate optional
diagnostic, not a duplicate nightly run. Old marketplace tables have non-equivalent
localization work and cannot establish general framework speed rankings.

## Shared work

1. Every page app receives the same raw marketplace data and renders the same rows, images,
   initial offers, forms and styles. Corten's output is not the oracle: independently specified
   content and numeric cases define the required behavior.
2. Prices are USD minor units, counts are non-negative integers, and ratings are hundredths.
   Parse into the ecosystem's appropriate numeric types. The in-memory source may parse and
   construct typed records at startup; HTTP fetches and parses once per request. Both sources
   format displayed values during the page request, not while loading the fixture.
3. Select `en-US`, `fr-FR` or `de-DE` for each request, from the same explicit locale input
   in every adapter. The runner visits every locale, not letting a process-wide default
   accidentally pass an English-only test. The locale's number grouping, decimal separator,
   currency symbol placement and count plural form must match the contract. USD has exactly
   two fraction digits; ratings have at most one, rounded half away from zero.
4. Each app uses its ordinary localization APIs or an established library, plus its normal
   templates and JSON serializer. Reusing formatter objects and static translation catalogs is
   allowed. Caching formatted record values, serialized answers or rendered HTML is not. Typed
   parsers may skip unused upstream fields; there is no requirement to construct a generic DOM.
5. JSON remains machine-readable and identical across locales: numeric prices, ratings and
   counts, not locale-formatted strings. Display formatting is page work, not an artificial
   requirement added to the JSON route. `records.mjs` validates the exact application schema;
   the numeric conformance cases below are not that application schema.
6. Sort, filter, show-all, navigation and price-alert interactions must work with JavaScript
   enabled and disabled wherever the interaction is available without it. Where an ecosystem
   naturally makes a round trip, measure and disclose it rather than replacing its pattern.
7. Compare equivalent required behavior, not identical algorithms. This runner uses the apps'
   default production settings, not the legacy matched-production tier. Record middleware,
   compression, cache policy, limits
   and added libraries; do not silently remove Corten features or add expensive substitutes to
   another app to obtain a ranking.

The standalone Corten adapter does not modify the production marketplace example. All apps
use the full labels in `labels.json`; a localized price in an otherwise unverified page is
insufficient. See [the adapter contract](adapter.md) for routes, schema and every page section.

## Adapter libraries

These are the implementations used in this workload, not a framework feature ranking.
All use native templates/components and ordinary JSON serializers. Form submission is a
native POST with each framework's normal protections, not a timed interactive benchmark.

| Adapter | Request-time localization |
|---|---|
| Corten | Built-in `messages!`, money, decimal and plural APIs |
| Next.js, TanStack Start, React Router | `Intl.NumberFormat`, `Intl.PluralRules` |
| Nuxt, SvelteKit, Astro | `Intl.NumberFormat`, `Intl.PluralRules` |
| axum + Maud, Leptos, Topcoat | ICU4X decimal, experimental currency and plural libraries |
| ASP.NET Core | .NET `CultureInfo`/ICU number and currency formatting; MessageFormat plurals |
| Spring Boot | ICU4J number, currency and plural formatting |
| Phoenix | ex_cldr_numbers and CLDR cardinal plurals |
| Django | Babel number, currency and plural APIs |
| Rails | twitter_cldr number, currency and plural APIs |
| Laravel | PHP intl number/currency and message formatting |
| Gin | x/text numbers, bojanz/currency and go-i18n plurals |
| Drogon | ICU number, currency and plural APIs |

The Corten app is standalone under `corten/`; other adapters add v2 routes without replacing
their legacy marketplace or catalog routes. Formatter/catalog reuse is allowed; formatted
record, HTML and serialized-response caches are not. Dependency versions are recorded in
manifests/lockfiles and resolved image IDs, and should accompany published measurements.
Next.js uses Pages Router SSR here; Phoenix uses controller/HEEx and Laravel uses Blade,
not their legacy LiveView/Livewire examples. V2 result labels name these workload choices.

## Running

The [nightly procedure](nightly.md) describes detached launch and collection. From a clean,
committed checkout, with durable state outside that checkout:

```sh
node bench/marketplace/droplet.mjs r17 --ssh-key <id> --state-dir <outside-checkout>/marketplace-r17 --detach
node bench/marketplace/droplet.mjs r17 --state-dir <outside-checkout>/marketplace-r17 --collect
```

Use a fresh official `rN` with N >= 17 for each nightly round. The dedicated c-8 runs three
passes with `--duration 15 --warmup 10 --rate 150`, pinned to app CPU 1, upstream CPUs 2-3
and load-generator CPUs 4-7. These are short measurement windows: publish medians and ranges,
not a guaranteed finish by 7 am or an unsupported claim about small differences.

### Splitting a round across droplets

A round's wall time grows with every app, so it can be split across droplets started together
([#816 A bench round runs every app in sequence on one droplet, so its wall time grows with each app, tier and repeat, and it cannot be split across droplets and still compared](https://github.com/corten-run/corten/issues/816)):

```sh
node bench/marketplace/droplet.mjs r17 --droplets 3 --ssh-key <id> --state-dir <outside-checkout>/marketplace-r17 --plan
node bench/marketplace/droplet.mjs r17 --droplets 3 --ssh-key <id> --state-dir <outside-checkout>/marketplace-r17 --detach
node bench/marketplace/droplet.mjs r17 --state-dir <outside-checkout>/marketplace-r17 --collect
```

`--plan` prints the split, each droplet's remote files and every command, calling neither
`git`, `doctl` nor `ssh`. Every droplet runs Corten and axum + Maud (the anchors) beside its
share of the other apps, dealt round-robin in catalog order, as an ordinary c-8 round of those
apps (`run.mjs rN --part k/n`, into `results/rN/d<k>`). Each droplet gates its own apps, both
sources and all twelve browser profiles, before its own load; the gate checks each app against
the contract, not against Corten, so it needs no other droplet. A droplet whose gate fails
fails the round, as one app's failure fails an unsplit round, though other droplets may already
have measured.

The launcher checks the clean checkout, that no benchmark droplet exists and the account's
droplet limit (`doctl account get`) once, then writes `split.json` (commit and each droplet's
apps) and refuses another launch from that state directory.
It creates every droplet before starting any round, so the rounds start within minutes of each
other; each droplet has its own `d<k>/` state, known_hosts and evidence. Ctrl-C, SIGTERM or
Ctrl-Break stops the launch between steps, and the
launcher then says what each droplet is left doing: a started round keeps running until stopped
(it prints the `ssh` command), a droplet created but not started is billed until deleted (it
prints the `doctl` command). It also saves that text as `launch-stopped.txt` in the state
directory, so a closed stdout or stderr does not lose it. A hangup does not stop the launcher: Node resets
an inherited SIGHUP ignore, so `nohup` alone would not keep it running, and the launcher ignores
SIGHUP itself; closing its terminal lets the launch carry on. While it runs, the launch holds
`launch.lock` (its pid) in the state directory and removes it when it ends, however it ends.
`--collect` refuses while that pid runs, since a live launch may be seconds from
`systemctl start`; if the pid is gone, the launch was killed, and collect removes the stale lock
and collects the stopped launch. Each droplet's state says `starting` from just
before `systemctl start` until the launch has seen the unit running; collect leaves it so, since
a loaded unit does not prove the round ran, and collects it like any other.

`--collect` collects each droplet on its own and deletes each one that finished, so a slow
droplet does not keep a finished one billed. The round is finished only when every droplet has
been: exit 3 while any runs, 2 for a collection error on any droplet (a failed delete
included) or for a leftover droplet named `corten-marketplace-rN-d*` that no live part owns,
which is reported with its delete command, never deleted. A droplet whose launch stopped before
`systemctl start` (state `creating` or `preparing`) never ran its round: `starting` is saved
just before that command and the unit has no `[Install]` section, so nothing else starts it.
Collect finds it by id, or by name and run tag when its create returned no id (where the
stopped launch said to look for a droplet with that name and tag), checks its name and ownership
tags as for any delete, prints its `doctl` delete command and exits 2 until it is gone. A `starting` droplet is collected like any other, refusing a missing or unloaded unit;
if its droplet is gone, it may have run and is missing. Whenever a droplet never started, is
partial or is missing, the round cannot merge, so collect prints the `ssh` command that stops
each droplet still running, whatever the exit code. Exit 1 means a droplet did not finish its
part, or the parts do not merge; 0 means every droplet finished and was deleted, and the parts
merged into `round/rN/` in the state directory (`summary.json`, `split.json` and each
droplet's `d<k>/`). Exit 2 wins over 3: while one droplet runs, an error on another still exits
2. Then fix what it names (delete a droplet that never started with the printed command, run a
printed `ssh` stop command, or clear the reported error), and run `--collect` again until it
exits 0 or 1; never relaunch the round.

The merged summary is a round of all twenty apps, each from the droplet that measured it, with
each droplet's CPU model, tools and anchors in `split`. Its report gives every table a Droplet
column and both anchors on every droplet, and each app's req/s and CPU us/request as a ratio to
the Corten on its own droplet beside the raw numbers. Raw numbers across droplets carry any
difference between their machines; compare apps on different droplets by those ratios. A
Between droplets section lists each droplet's CPU and checks axum + Maud's ratio to Corten on
each. A droplet's ratio range is the widest its passes allow: axum + Maud's lowest over Corten's
highest to axum + Maud's highest over Corten's lowest. A stage is flagged ("d1 and d2 differ")
when two droplets' ranges do not overlap, that is when one droplet's lowest ratio is above the
other's highest. The anchors' rows in every table show how far their raw numbers differ between
droplets. `compare.mjs` compares a split round only with one split the same way, each droplet's
host and images equal to the baseline's same droplet, and Corten's rows are d1's. A droplet's CPU
model is not chosen at create, so droplets can land on a mix (Xeon Platinum 8168 on d1 and 8280
on d2, say). The round still merges and its report reads each app by its ratio to its own
droplet's Corten. But `compare.mjs` refuses it, with no deltas, against any baseline whose
same-numbered droplet had another model, including the same two models swapped. It does not fall
back to comparing ratios: compare rounds with mixed droplets by their ratio columns by hand.

For local development, `wN` remains the development identity:

```sh
npm ci
node bench/marketplace/fixtures.mjs
npm run check:marketplace
node bench/marketplace/run.mjs w1 --build --check-only
# From a clean, committed checkout, after reviewing conformance:
node bench/marketplace/run.mjs w2 --build --passes 3
node bench/marketplace/report.mjs bench/marketplace/results/w2/summary.json
```

Use a fresh `wN` each time: an existing result directory is never overwritten. `--apps` may
select individual apps for development checks. A full publishable baseline needs all twenty
apps and three passes; the read-only reporter rejects subsets, check-only runs, dirty commits,
missing profiles or passes, failed cleanup and aggregates that disagree with saved passes. A
phase in which an app answered requests with anything but a 200 or timed out on them, or could
not keep the fixed rate, is the app's result, not a failed run: it is saved with its failure
rate and dropped iterations, the later phases still run, and the report marks the stage with
`*` and lists each one. An app container that exits or is OOM-killed during a load phase
(warmup included) is the app's result as well: the run records the stop's pass, phase, exit
code and OOM kill, does not run that profile's later phases and passes, and keeps every other
app's and profile's results; the report marks each stage that lost a pass
`(stopped: n of 3 passes)` with a line naming the stop, and a full baseline may have fewer
than three passes only there; of two passes each number is the lower of its column's two
values, not a median. The stop is the app's only when the container stopped after the phase
began, the CPU counter sidecar and, for the HTTP source, the upstream are the same running
containers, Docker recorded no kill, stop or restart of the app, and nothing failed that the
stop does not explain (only docker stats errors stamped after the app finished); otherwise the
run fails.
Still failures: a phase with no k6 summary or in which no request succeeded, a 200 of the wrong
content type (before a stop too), an app container that stopped during its cold start or before
a phase began (after its first 200, before warmup or between phases), and any error answer
from the upstream to a record read. Results written
this way are schema `marketplace-results/v4`. The reporter and `compare.mjs` also read a
`marketplace-results/v3` summary, as v4 with no stop records (under v3 an app that stopped
failed the round), so a v3 round compares with v4 rounds; any other schema is rejected.
The local `wN` commands do not create a droplet, collect c1, update nightly state or publish anything.

The deterministic fixture is 500 new rich trading-card records, not the old marketplace
fixture with a new label: normal records have 25 listings, 12 offers, images, badges, fields,
tags, category links, contents and included-in links. Empty collections, nulls, escaping,
negative/zero/fractional money, rating rounding, large counts and plural cases are included.
This is a new baseline even when run on the same machine as an older workload.

`GET /marketplace/{locale}/{id}` renders the page; its native POST validates the alert.
`GET /api/marketplace/{id}` serializes the canonical numeric record. `MARKETPLACE_SOURCE=fixture`
reads `/fixtures/marketplace.json` once into memory; otherwise each request fetches and parses
`${API_BASE}/marketplace/records/{id}`. Locale selection is in the URL, not ambient machine state.

The gate checks all 500 JSON records and 264 page/interaction observations in twelve profiles
(three locales, desktop/phone, JS on/off) for each source. It checks the canonical stylesheet,
responsive application, visible row counts, exact formatted text, escaped content, native
forms, navigation, missing IDs and unsupported locales. HTTP probes change the record between
requests and verify one upstream read, reserialization rather than forwarding, and errors.
Every selected app must pass both sources before *any* app is timed. CI runs both the legacy
catalog gate and this gate for each of the twenty apps.

Load uses a one-CPU app quota, a four-CPU load-generator quota and a two-CPU upstream quota.
For disjoint pinning set `MARKETPLACE_APP_CPUS`, `MARKETPLACE_LOAD_CPUS` and
`MARKETPLACE_API_CPUS`; overlaps are rejected. Without those settings quotas do not prove core
isolation. Pages are measured separately in all three locales (`en-US`, `fr-FR`, `de-DE`);
locale-neutral JSON is measured once per source per pass, not repeated as a locale control.
Three passes rotate framework order.
Warmup precedes fixed-rate, 64-user and 256-user phases. Results retain commit/dirty state,
fixture hash, resolved image IDs, raw k6 output, counted cgroup CPU, memory, cold-start clock,
configuration, errors and cleanup failures. Image IDs and build logs identify dependency
versions; record runtime/ICU/CLDR versions when publishing a baseline.

The private upstream is a single Node process, even with a two-CPU quota. Its busy CPU is a
measurement limit, not evidence of framework saturation. The reporter flags it and app CPU
below 95%, and prints medians and ranges rather than claiming every difference is meaningful.
The nightly measurement scope is CPU, memory, load and cold start. This runner does not
measure build cost, instructions, bytes or load-to-interactive timing yet. Historical build,
browser and instruction measurements remain evidence only for their original workloads.

## Formatting conformance

`contract.mjs` provides numeric edge cases, the twenty-app inventory, an independent
ECMA-402/CLDR-based oracle and a formatting-capture validator. It is test tooling, never an
implementation helper for the apps. No app imports the oracle to produce measured answers.

```sh
node bench/marketplace/contract.mjs
node --test bench/marketplace/contract.test.mjs
node bench/marketplace/check-capture.mjs capture.json
```

The first command prints the input fixture and its SHA-256, without writing files. A separate
formatter diagnostic can capture actual rendered prices, ratings and count text, in input order,
into this capture (all case rows are required; the arrays here are abbreviated):

```json
{
  "workload": "marketplace-v2",
  "app": "corten",
  "source": "fixture",
  "locale": "en-US",
  "fixtureSha256": "the SHA-256 printed by contract.mjs",
  "prices": [{"id": "price_0", "text": "$0.00"}],
  "ratings": [{"id": "rating_0", "text": "0"}],
  "counts": [{"id": "count_0", "text": "0 listings"}]
}
```

The oracle checks zero and negative prices, grouping, small amounts, rating rounding, and
zero/one/two/large counts, including French's million-count plural form. Grouping/currency
spaces may be ordinary, no-break or narrow no-break spaces; no other punctuation, symbol,
digit, sign or word difference is hidden. Record runtime/ICU/CLDR versions with results.
Investigate a semantic difference rather than broadening normalization until it passes.

A capture cannot prove where formatting ran. Before load, validate both sources, all locales,
changed numeric inputs, rendered row counts, JSON identity, errors and browser interactions;
inspect the adapters to establish request-time work. Use the same helpers for a real page and
its conformance cases. A fixture-specific shortcut is not permitted. The capture validator
always reports `readyForLoad: false`: no standalone formatting test certifies a full app.

## Before measuring

1. Run the twenty adapters' ecosystem-local tests and Docker/browser gate. Keep catalog
   behavior unchanged, and do not rewrite historical result files.
2. Review request-time native localization and serializer paths, not just captured answers.
   Missing support is a failed contract, not a fast row.
3. Use a fresh `wN` for development or official `rN` (N >= 17) for nightly execution, a clean
   measured commit and complete provenance. V2 starts a new baseline: compare only compatible
   v2 rounds, with no r16 or catalog c1 delta.
4. Validate the load generator, CPU placement, upstream headroom and concurrency range. A
   low-utilization app's observed req/s is not its proven maximum; a busy upstream bounds the
   end-to-end measurement. Keep those warnings alongside the table, not in a hidden footnote.
5. Take repeated passes, rotate execution order and report medians and ranges. Establish
   repeatability before claiming a small difference. Preserve failures and partial artifacts,
   but never promote them to a successful full baseline.

## Presentation

Lead with an application a reader can run, then separate four questions:

| Question | Evidence |
|---|---|
| How fast does it feel? | Phone load-to-interactive, navigation and form-update latency, bytes sent |
| What does serving it cost? | Whole-container CPU/request and CPU plus peak memory at the same fixed rate |
| How much can it handle? | Throughput at a stated latency and error limit, with saturation/headroom evidence |
| What does development cost? | Clean build, incremental build and development rebuild, with CPU and memory |

Show core catalog and full marketplace results separately. Do not combine them into a weighted
score or advertise the best ratio from either as overall framework speed. A CPU-normalized
number is useful but does not replace actual latency, capacity or fixed-rate measurements.
Compare loaded memory at the same rate as well as at each app's maximum throughput.

Features are a separate, evidence-linked table: built in, available through a named library,
not implemented in this example, or not evaluated. A missing example is not proof a framework
lacks a feature. Progressive enhancement, typed interfaces, security defaults, localization,
partial updates and live data need a runnable example or check, not a performance-derived
checkmark. Record which implementations maintainers have reviewed.

Never claim build times, instruction counts, bytes or interactive timings from the nightly load suite;
those need their own measurements. Do not present preliminary catalog c1 data as a completed
comparison or compare it with marketplace r16 as a before/after change.
