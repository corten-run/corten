# Marketplace v2: equivalent localization work

**A separate application workload, with twenty native adapters and a pre-load conformance
gate.** Nightly uses feature-qualified popular and performance-oriented cohorts, deduplicated
into one production run. Candidates lacking the production contract are explicitly excluded
before timing; every admitted app must then pass both Docker/browser gates before any load.
No framework, including axum or Corten, gets unconditional admission. See
[framework groups](nightly.md#framework-groups) for requirements, candidate pools and limits.
An omitted adapter was not tested; an excluded candidate has capability evidence, not timing.
The JSON wrong-method probe uses POST, which the page form implements but the
read-only JSON route does not. It still requires a JSON 405 response; a method
implemented nowhere in an app may correctly return 501 and is not this test.
The first validated v2 production baseline is [historical r20](#results). Passing the formatting-capture checker alone
never qualifies an app for load testing.

Keep both workloads' history. [Catalog](../catalog/README.md) isolates a strings-only page and JSON;
marketplace v2 measures a richer application with equivalent locale formatting. Neither
replaces the other's results. Historical [marketplace rounds](../fullstack/README.md) keep
their recorded implementation and caveats. V2 starts a new baseline, not an r16 speedup.
Nightly execution moves to v2 starting at official r17; catalog remains a separate optional
diagnostic, not a duplicate nightly run. Old marketplace tables have non-equivalent
localization work and cannot establish general framework speed rankings.

## Results

Historical round r20 is the **first validated v2 production baseline**, measured on 2026-11-12 (UTC)
at `43550265076e378d2159a9ebc254cf9412a2355a` on one dedicated c-8 (Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz).
It is a saved measurement of that commit, not today's code or a baseline for the newer
workload-group campaign. There is no speed delta from r16, catalog c1/c2 or another workload.

Group `production`, feature profile `marketplace-production/v1`, native
`PROFILE=matched`, connection cap 1000. Corten and ASP.NET Core qualified in both sources
and passed every browser/content gate. Next.js, FastAPI, Express, Topcoat, Leptos were
probed and excluded, not timed. The report preserves each missing requirement and lists all
omitted adapters, which were not tested. These are measured adapter configurations, not claims
about what their frameworks could implement. Conditional GET/ETag and downstream readiness
are disclosed exceptions; logging remains native, not normalized.

See the [generated report](results/r20/report.md), [saved summary](results/r20/summary.json),
[exact measured commit](results/r20/commit.txt) and [archive checksum receipt](results/r20/archive-sha256.txt).
The original hash-verified archive remains outside Git; raw qualifications, browser checks,
build logs, counted CPU, load summaries and sample streams are retained with these results.
Those r20 files stay where they are; its `summary.json`, over 256 KiB, is listed in
`scripts/bench-size.allow`. A new round commits its report, commit and provenance, small enough to
diff, its summary only when that is within the limit and approved for public disclosure (else its
SHA-256), and leaves its raw receipts in the archive
([nightly procedure](nightly.md#finished-results)). A maintainer chooses
where the archive is kept and publishes it there, and the committed provenance records where it
can be fetched as well as its SHA-256: a checksum receipt alone says how to check a copy, not where
to get one ([Benchmark results](../../CONTRIBUTING.md#benchmark-results)).

Each admitted adapter completed 8 profiles in 3 rotated passes: pages in
en-US, fr-FR, de-DE and locale-neutral JSON once per source/pass, using memory and uncached HTTP
sources. Warmup 10s, phases 15s, fixed load 150 req/s, then 64 and 256 users; identity
encoding, one app core/1 GiB on CPU 1, upstream CPUs 2-3, generator CPUs 4-7.
The saved runner interval was 73.34 minutes (2026-11-12T15:39:48.785Z to 2026-11-12T16:53:08.923Z),
not launch-to-deletion time. No request failures, dropped iterations or app stops were recorded.

All numbers are medians [min-max], not confidence intervals. Corten's memory-source app CPU is below 95%
in some closed-loop passes. No measured HTTP phase reached 80% upstream CPU; the highest phase average was 74.89% of one core.
The report identifies every affected profile/phase/pass; observed throughput is not proven
maximum capacity. These short windows do not establish small speed differences. Conditional
reads, downstream readiness, build cost, bytes, instructions and browser interactivity are not
measured by this load suite. Existing build/browser/byte/instruction tables remain historical
in [Performance](../../docs/performance.md#historical-measurements) and [fullstack](../fullstack/README.md).
This baseline is not the newer nine-group campaign and does not establish its readiness.

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

Dependency input: this refresh moves the Corten app's brotli from 9.1.1 to 9.1.3 and zstd from
0.14.3 to 0.14.4, with other crates it shares with the workspace lock ([#1767 The catalog and marketplace Corten apps lock brotli 9.1.1 and zstd 0.14.3 behind the workspace lock, so those benchmarks time a compression stack CI no longer tests](https://github.com/corten-run/corten/issues/1767)).
Compare a new run with an earlier one as a changed dependency input: no speedup from the move was
measured, and r21 stays pinned to its recorded source, `4225a2837`.

Next.js uses Pages Router SSR here; Phoenix uses controller/HEEx and Laravel uses Blade,
not their legacy LiveView/Livewire examples. V2 result labels name these workload choices.

## Running

The [nightly procedure](nightly.md) describes detached launch and collection. From a clean,
committed checkout, with durable state outside that checkout:

```sh
node bench/marketplace/droplet.mjs r17 --ssh-key <id> --state-dir <outside-checkout>/marketplace-r17 --detach
node bench/marketplace/droplet.mjs r17 --state-dir <outside-checkout>/marketplace-r17 --collect --context <saved-context>
```

Use the saved doctl context for the account that launched the round. Deletion requires
durable publication of the intent (fixed local NTFS on Windows, directory sync on POSIX),
which launch checks before allocating;
see [State and Collection](nightly.md#state-and-collection).

Use a fresh official `rN` with N >= 17 for each nightly round. The dedicated c-8 runs three
passes with `--duration 15 --warmup 10 --rate 150`, pinned to app CPU 1, upstream CPUs 2-3
and load-generator CPUs 4-7. These are short measurement windows: publish medians and ranges,
not a guaranteed finish by 7 am or an unsupported claim about small differences.

### Convergence and soak passes

No report here establishes whether each adapter had stopped changing by the end of the timed
10-second warmup, or whether its memory and tail latency hold over time
([#1851 Load phases run 15 s after a 10 s warmup, and nothing shows the JIT runtimes had reached steady state or that any app's memory holds over time](https://github.com/corten-run/corten/issues/1851)).
Two passes, separate from the timed rounds, take screening readings toward those questions; neither
establishes either answer. Neither changes a timed phase, the warmup, the rate, the droplet job or a saved round, and neither is part of the nightly.

```sh
# One closed loop per adapter, source and target: the timed warmup's 32 users for 5 minutes in 15 s windows.
node bench/marketplace/steady.mjs convergence w3 --group production --build
# A fixed 150 requests/second for 30 to 60 minutes, in 60 s intervals.
node bench/marketplace/steady.mjs soak w4 --group production --minutes 30
node bench/marketplace/steady-report.mjs bench/marketplace/results/convergence/w3/summary.json
```

Each adapter, source and target gets a fresh container, started the way `run.mjs` starts one
before a timed warmup (created, then started while a sidecar polls that target's own path, the JSON
item or the first locale's page, until its first 200), and then one long k6 pass (`window-load.js`:
the timed requests and checks, with each answer counted in the window it completed in).
`--admitted-from <round>/summary.json`
measures only the adapters that saved timed round admitted; without it every selected adapter
runs and the report says admission was not checked. A saved pass with `--group` reads back only
with that group's adapters, or the subset of them its admission admitted. A round that cannot be read or does not
validate fails the pass with a fixed refusal on the console and in `run.log`; why, which can quote
the file, is kept only in `errors.log`. `--minutes`, `--window` (convergence),
`--interval` (soak), `--vus`, `--rate`, `--targets` and `--sources` change the defaults;
`--label key=value` (repeatable) adds a label to every container and network the pass creates,
beside its ownership label. Like a timed round, a pass refuses to start without the current
generated fixture (`node bench/marketplace/fixtures.mjs`). It reads that fixture once into a copy
in the pass's own folder (`mounted-fixture`), checks and hashes the copy, and mounts only the copy,
read-only, for the upstream and every app, so an edit to the original during a pass cannot change
what a later cell serves. The copy is published as the timed runners publish theirs (directory
0711, file 0644, whatever the umask), so an adapter running as another user can read it; it is hashed again before the pass can be complete. Teardown removes
the copy only once every container of the pass is confirmed removed, and keeps it otherwise, since a
container may still mount it; a copy that could not be removed makes the pass incomplete. A
container's log (`cold.log`, `app.log`) is written straight to its file with its stderr as well as
its stdout, and is not read back. The cold probe's readiness and result are read from its stdout
alone: each read writes the probe's stdout, without its stderr, straight to `cold-stdout.log`
(Catalog's `commandRunner` with its opt-in `fileStderr: false`; its defaults are unchanged), and
the file is read back only up to 4,096 bytes, a longer one failing the cold start (`readBounded`).
It must hold exactly what `bench/catalog/cold.mjs` writes (`coldOutput`): the readiness line, then
one result line as `JSON.stringify` writes the fields it names and the path it polled, each line
ended by one newline; padding, a blank line or anything else fails the cold start, nothing is
trimmed. While the probe runs the file is only polled for the readiness line; once the probe has
exited, the final read (`coldResult`) requires both lines, each ended by its newline, so an empty
file, a readiness line alone or a result line without its newline fails the cold start. The result must then pass the timed validator's own cold-start rules
(`validateColdStart` in [report.mjs](report.mjs)), so a first 200 with an empty body fails the cold
start in a pass as it fails a timed round. What the probe wrote, stderr included, is in `cold.log`,
collected before the probe is removed even when it never became ready (a collection that fails is
recorded in `errors.log` and leaves the original failure as it was). Results
go to `results/convergence/<name>/` and `results/soak/<name>/`, outside Git like other raw output.
The pass's name is kept in its run ID (`marketplace-<kind>-<name>-<random>`), which `summary.json`
records and the owner label carries. Its containers and network are named `mkt-` and 12 hex digits
of the run ID's SHA-256, then a role or adapter, because the containers reach one another by those
names and a name built from a long pass name would not be a DNS label (63 characters at most).
Every container is read, logged, sampled and removed by the ID Docker printed for it, after its
owner label is checked; teardown also removes, by ID, anything else carrying the pass's owner label.
A create whose ID Docker did not return is looked for by its own label for a bounded time; if
nothing turns up its cleanup is reported unconfirmed and the pass is incomplete. Each ID that lookup
finds is removed, or confirmed absent, by that ID itself (a lookup by the ID, then its owner label
checked, then removal), whatever the owner-label sweep lists: a listing that leaves it out proves
nothing about it. Cleanup is complete only when every create Docker acknowledged is among the
resources confirmed removed by its ID and every ID found by an attempt's label was removed or
confirmed absent that way; otherwise the fixture copy is kept. A
create Docker did not acknowledge ends the pass at the step that made it, even when teardown finds
it by its label and removes it, so the pass is incomplete; the record of it stays in `cleanup.json`
and in that summary, for diagnosis. Both name an ID only once the pass has it from its own create
or has confirmed its owner label on it: what survived teardown is counted, not listed, and a
failure on an ID a listing returned, or of a listing itself, is a fixed message (Docker's own
output stays in `errors.log`). A saved pass is refused, whatever its `complete` flag says,
unless its removed count equals its acknowledged creates (each is removed by its ID), it has no
unacknowledged create and recovered nothing by its label, and its acknowledged creates are the
ones its cells imply: four for the pass
(host probe, k6 version probe, network, upstream) and, for each cell, four (app, cold-start
sidecar, k6 and the event marker), all of them for a measured cell and at most that many for a
failed one (`passCreates` and `cellCreates`). Each cell's
containers are removed before the next cell starts; a cell that leaves one behind ends the pass.
For the production group's seven candidates a convergence pass is 28 five-minute passes, about
two and a half hours with container starts, plus image builds (estimated, not measured). A pass
describes only the inputs it ran (below), so any change to them needs a new pass: an adapter change
or rebuild (a new commit or image of any measured adapter), a runtime or framework version, a new
fixture, upstream or k6 image, or another host, kernel or CPU setting.

A convergence pass keeps each window's throughput, p95 and p99, and gives each cell one tolerance
reading (`flattenRule`, `marketplace-tolerance/v4`, in [steady-contract.mjs](steady-contract.mjs),
which states the steps). It is a screening reading of throughput, not a certificate of steady
state. Its spans are in seconds (`--window` must divide 60). The tail is the median throughput of
the last 60 s. Otherwise it reads "within the stated tolerance from the window ending at N s"
when, from that window to the end and for at least 60 s, every window is within 10% of the tail
median, every three-window median within 5%, and the least-squares line through those windows
changes by at most 5% of the tail; the onset window must itself be within 5% of the tail, and
neither the first 60 s nor the 60 s before the tail may have a median more than 5% above it
(those two are comparisons between medians, not of each window).
A reading of "not within tolerance at the end" names the comparison that decided it, never a
direction of travel:

1. the median of the first 60 s, or of the 60 s before the last 60 s, is more than 5% above the
   last 60 s median;
2. the final stretch inside the bounds (every window within 10%, every three-window median within
   5% of the tail) is shorter than 60 s, sometimes with "and the last 60 s median is more than 5%
   above the 60 s before it";
3. that stretch lasts at least 60 s but has no onset, and the least-squares line through it goes
   up, or does not go up (flat or down).

When the last 60 s median is zero there is no reading, and the report says that median is zero;
the last window can still have served requests.

A comparison of medians says nothing about the last window: a pass that climbed and whose last
window then fell to half can read "the last 60 s median is more than 5% above the 60 s before it",
because the falling window leaves the stretch empty and the medians are still in that order.

What the reading does not detect, by construction (each case is pinned in `steady.test.mjs`):

1. Oscillation or drift inside those bounds reads as within tolerance. 920, 1000, 1080, 1000
   repeated five times in 15 s windows reads within tolerance from the window ending at 30 s, and a
   steady climb from 1000 to 1076 over 20 windows from the window ending at 105 s.
2. A shift of under 10% in the last window can go undetected: nineteen windows at 1000 then one at
   1090 reads within tolerance from the window ending at 15 s, because the tail median is unchanged.
3. A pass that started faster is not within tolerance even if it then held: four windows at 1100
   then sixteen at 1000 reads "the median of the first 60 s is more than 5% above the last 60 s
   median".
4. The onset is resolved to one window and given as that window's end, so a 15 s window never reads
   under 15 s; readings at different window lengths are not comparable.

5% and 10% are stated choices, not derived from measured noise; revisit them once saved passes show
the window-to-window spread on the measurement host. A cell with any failed request, in a window or
in k6's aggregate count (which includes answers completed during the graceful stop), or whose app
stopped, restarted, was replaced (another container ID or StartedAt) or was OOM-killed, or whose
event stream could not be read or did not show the marker's starts around its load (`unconfirmed`, below), gets no reading: the cell is saved with only its failure code, and a complete pass with such cells stays
reportable, each of them reading "no reading" with its code's text. A saved cell that has a reading
but records a failed request is refused. k6's engine clock is checked as a timed
phase's is (`validateLoadExecution`). A saved pass is refused if it finished at another commit,
if its cleanup failed or is not confirmed complete, if a cell that did not fail records no request
at all (capture refuses such a load as "load sent no requests", and replay applies the same rule
in `reconcileCell`; a convergence cell with requests earlier in the pass and none in its last 60 s
is valid and reads "no reading"), if its window totals do not add up to k6's
request count, if k6's requests less its completed iterations are more than the load's VUs (a
convergence pass's users, a soak's 1,000; each VU has at most one unfinished iteration, which a
captured cell's `vus_max` already bounds), if a window's p95 or p99 is above k6's aggregate latency maximum, if k6's aggregate
failures are fewer than its windows' or more than its windows' plus the requests outside them (the
graceful-stop tail and unrecorded requests), or if it has no adapters, sources or targets.

What a pass saves is an allowlist (`savedText` and `passEvidence` in
[steady-contract.mjs](steady-contract.mjs)): every field in `summary.json` is fixed by the
checkout (the options, the rule, the scope, a failure or startup code), a validated number, or a
value from Docker, the host or k6 that matched a strict pattern: 64-hex image IDs and hashes, a k6
version `N.N.N`, a kernel release, an online CPU set and a Docker server version. The host's CPU
model is saved only as the SHA-256 of its text (`cpuModelSha256`, from `cpuModelDigest`: whitespace
normalized, at most 256 characters, otherwise null); the text stays in `host.txt`, a timed round's
model is compared with it by the same digest, and neither `steady-report.mjs` nor
`report.mjs --convergence` prints either text (`report.mjs` without `--convergence` still prints
the round's model as it always has). A
convergence pass is saved as `marketplace-convergence/v8` and a soak as `marketplace-soak/v10`
(below). Both save what each reading rests on as fixed text, `measurement.containerChecks`, with the
event stream's limit stated, and both reports print it for the cells with a reading (none when no
cell has one). The text names that scope itself (what each cell with a reading rests on; a failed
cell has no reading), so a save whose every cell failed does not say, read alone, that their
settings matched. v8 and v10 are new with this text, which changed within them before either
reached main; a v7 convergence pass saved no such text
and, like a v9 soak, was described as showing that its settings held through the load, more than
its event stream can show. A v6 convergence pass checked its containers' settings only at its inspects and read no
event stream, so a change made during its load and undone before the inspect after it went
unseen, a v5 one did not check its containers' settings or recheck its app just before the load
(both below), a v4 one saved the model's text, and none of v4 to v7 is read. A value that does not
match is saved as null (not recorded), or, where the pass depends on it (an image ID, the k6
version), fails that step. Adapter names (the pass's adapters and those it selected for
admission) must be ones this checkout's adapter inventory has, and a group one of its groups; the
readers refuse any other name without quoting it. A failure is saved only as a code (`failureCodes`), and how a pass
started each app as a code (`startups`); the readers refuse any other field, value or code, with a
fixed message that never quotes the file, and print a code only as its text. Docker's, the host's
and k6's own output, and each failure's message, stay in the raw files beside the summary
(`host.txt`, `docker-version.txt`, `k6.json`, `images.json`, the container receipts,
`events.log`, `errors.log`, `run.log`), outside Git with the rest of the results. The timed
report's like-for-like list names each differing or missing input and quotes neither side's value.

Some checks are made only while a pass runs, because the saved summary does not keep what they
read: k6's raw engine clock against the load container's own run (`validateLoadExecution`, from
the raw `load-clock.json` and container receipts), the app container's before and after inspect
(each must record a 64-hex container ID, a StartedAt timestamp that is a real start, a
RestartCount and its running and OOM states, and the app must be running and not OOM-killed
before the load, `appInstance` and `appBefore`; a missing counter or malformed timestamp on
either side fails the cell rather than comparing equal. The app before the load must also be the
instance that served the cold probe: the container ID, StartedAt and RestartCount Docker reported
once the probe had its first 200 must all be unchanged (`servedCold`), or the cell fails
`instance-changed` before its marker or load container is created. The app is inspected once more
after the load container is created and checked, the last Docker answer before the load starts
(`atLaunch`, kept as `app-container-launch.json`): another ID, StartedAt or RestartCount, or an app
not running or OOM-killed, there fails the cell `instance-changed` and no load starts, so a restart
before the load is never read as one during it. A cell of either kind also fails `instance-changed`
when its event stream (below) shows a start, restart, die, kill or OOM of the app stamped before the
load container's StartedAt (after that last inspect, before the load), and a saved soak event is
never before the load. It fails it too when the app's own inspect after the load shows a StartedAt
other than the one at that last inspect and stamped before the load container's StartedAt
(`startedBeforeLoad`, in nanoseconds), which needs no event stream. Inspects alone cannot show how
many starts there were after the launch check, or when: a second start overwrites the first's
StartedAt, so a restart before the load followed by another during it leaves only the later time.
An app whose inspect after the load shows another container ID, StartedAt or RestartCount than at
the launch check is placed by the event stream; with the stream unavailable the cell fails
`unconfirmed` and has no reading, never a restart accepted as the load's. The settings the summary records are checked on Docker's inspect before any reading from a
container is kept (`appliedSettings`): the upstream's CPU quota (Docker's NanoCpus from `--cpus`,
with no CpuQuota of its own), CPU pinning (`CpusetCpus`) and memory limit before any cell; for each
cell the app's image ID, quota, pinning, memory limit and source (with the group's profile and
connection limit), and the load's image ID, quota, pinning, memory limit and every setting
`window-load.js` reads (`BASE`, `TARGET`, `LOCALE`, `MODE`, `WINDOWS`, `WINDOW_SECONDS`, and
`VUS` or `RATE`, each exactly once with the requested value, and the other absent), before the load
starts and again after it ran, so the VUs and rate `validateLoadExecution` reads are the ones
requested. Since `docker update` changes a running container's CPU quota, pinning and memory
without a restart, the app's settings are checked again at that last inspect before the load and
after the load, and an API cell's upstream's before the cell, at that last inspect and after its load
(`upstream-container-before.json`, `upstream-container-launch.json`, `upstream-container-after.json`).
A container that differs fails the cell `settings` (the upstream before any cell, the pass) with a
fixed message naming the role and setting, never Docker's value; `load-container.json` also keeps
the window settings, as the pass requested them (`windowEnv.requested`) and every value Docker's
inspect reported for each (`windowEnv.observed`, none, one or more), so a refused cell's receipt
shows what Docker had. An inspect shows the settings only at its own moment: a change made after one
check and undone before the next passes both. So every cell, of either kind, reads a live Docker
event stream of its app, its load, its marker and an API cell's upstream (below), listening from
before the launch check to after the inspect after the load. An `update` of the app, the load or an
API cell's upstream (not the marker) the stream delivers fails the cell `settings`, even when every
inspect agreed, and a start, restart,
die, kill or OOM of the upstream fails it `instance-changed`. The stream detects such an event; it
cannot show there was none. Docker's events publisher (Moby's `daemon/events` and its pubsub
publisher) gives up on an event for a subscriber that is slow to take it and goes on with the
stream, so an update and its reversal can both be lost while both marker starts, the fence and the
client's exit still arrive, and no subscriber can show that every event was delivered. A cell whose
stream is unavailable fails `unconfirmed` and has no reading, since it then had no event-stream
check at all; no load starts until the stream has shown the marker's first start, counted only from
a row the reader would accept (a container ID, an action and a nanosecond time). A cell's reading
therefore rests on what was checked: its settings matched at every inspect (the app after its cold
start, at the launch check and after the load; the load before it started and after it ran; an API
cell's upstream before the cell, at the launch check and after the load), and Docker's event stream
delivered no update of those containers, no start, restart, die, kill or OOM of the upstream and,
for a convergence cell, no qualifying start, restart, die, kill or OOM of the app (one delivered
before the marker's second start or stamped at or before the load finished; a later one is
teardown, below, is not read and stays in `events.log`); the stream can drop events for a slow subscriber. Each pass saves that text (`containerChecks`), which names
that scope itself, and both reports print it beside the readings, with how many cells have one: a failed cell did not pass
those checks, a convergence cell whose tolerance reading gave none (too few windows, or a zero
last 60 s median) has no reading for them to back, and a pass with no reading prints none. The load's inspect before it starts is kept as
`load-container-before.json` before its settings are checked, so a load refused there keeps what
Docker had too; an inspect without a container receipt's shape (an `Env` that is not a list of
strings, no `HostConfig`) keeps a fixed note, the load's ID and the window settings instead, never
its malformed values, and still fails the cell `settings` with no load started. Then, for a
convergence cell: the same ID
and StartedAt, running, not restarted or OOM-killed, `heldThrough`; for a soak: the restart
evidence and the exit, signal and OOM observations it saves), the cold-start clock and result, the k6 export's metric names and every
row of a cell's live Docker event stream, with whether it showed the marker's two starts. A saved
summary records their outcome (a cell that failed one has no reading) but cannot be re-verified
from summary.json alone; the raw files beside it (`app-container.json` and
`app-container-after.json`, which keep RestartCount, `load-container.json`, `load-clock.json`,
`load.json`, `events.log`, and `events.json`, which keeps whether the stream was read, its updates by
role, the upstream's events and the app's, and which of the app's container ID, StartedAt and
RestartCount differed from the launch check at the end) are what they read.

For each cell with a reading, a soak reports memory at the start and the end (the median sample in
the first and last memory interval), p99 per latency interval, failed requests (the Markdown prints
k6's aggregate count; each interval's count is only in summary.json, as the cell's
`windows[].failed`), whether it observed evidence that the app restarted, and, separately, the app's
observed exit, signal and OOM events that qualify for the cell (below). Memory and p99 are reported figures: no criterion
says whether they held. Only the fixed rate (below) is reported as held or not. Restart events
come from the cell's live `docker events` stream, filtered to the app, the load, an API cell's
upstream and a small marker container, started before the load. A retrospective `docker events --since/--until` query replays only what the
daemon still buffers (its last 256 events), so an empty answer to one would not show that nothing
happened; the pass does not use one. Instead it starts the marker once the stream runs, before the
load, and again after the app's last inspect: the stream delivers events in the order the daemon
publishes them, so a stream that shows both marker starts was listening before the load began and
was still running after it ended. It does not show that every app event between them was
delivered: the daemon can drop an event for a slow subscriber and go on (above), so an event of
the app the stream did not deliver is not observed. The client hands rows over in chunks,
so the runner does not stop it at the second start's row: it reads on until the fence, the
marker's next row after that start, which must be that start's own exit (its `die`) stamped
strictly later than the start, and so after the load's FinishedAt. A stream without the fence is
unavailable, and so is one whose next marker row there is anything else (a copy of the second
start, or a `die` stamped after the load finished but at or before that start): the runner does not
stop at such a row, and the reader does not take it for the fence. An app event the client delivers after the second start and before the fence is
read like any other. A marker row is a start, or the fence's `die`, only when its action is exactly
that word with no detail after it (`markerIs`), in the runner and the reader alike, so a
`start: detail` row counts as a start in neither. This still relies on the client delivering rows in the daemon's order up to
the fence. Two start rows alone do not show that (two
copies of the first would read as both), so the first two marker starts are witnesses that must
bracket the load on the daemon's clock: the first at or before the load container's StartedAt, the
second strictly later than the first and strictly after the load container's FinishedAt (the
latest daemon time before the app's last inspect, which has none of its own). These comparisons
use the full nanoseconds of the load container's StartedAt and FinishedAt and of each event, so a
marker start earlier in the same millisecond as FinishedAt is not after it. An app event is the
load's whenever it is stamped at or before FinishedAt, even if the stream delivered it after the
second marker start (an OOM kill stamped 15 s into the load is seen, never `none-seen`); only
an app event both after the second marker start and stamped after FinishedAt is teardown. A stream is
unavailable when it failed, did not show both marker starts and the fence within its bound, showed
another marker row where the fence belongs, had witnesses that do not bracket the load, or had a row
that was not the app's, the load's, an API cell's upstream's or the marker's ID, an action and a
nanosecond time, or was an app or upstream row naming a start, restart, die, kill or OOM, or any
row naming an `update`, with anything after that word, or ended with a row that has no newline, or
had a blank row; none of its rows is then used, and the cell fails `unconfirmed` with no reading.
A read stream is saved as `none-seen` (no qualifying start, restart, die, kill or OOM event of the
app was observed: none delivered before the second marker start or stamped at or before FinishedAt,
so a teardown event, which `events.log` still keeps, does not count; this does not show there was none) or `seen` (with those events). "Restarted" is yes only on restart evidence: a RestartCount increase,
another container ID or StartedAt at the end, a `restart` event, or a `start` of the app stamped
strictly after a `die` of it (events are paired by their daemon times, never by the order the
stream delivered them). It is no when none was observed: a soak with a reading always had its stream
read with the marker's starts around the load (`none-seen` or `seen`), and Docker's inspect after
the load compares the app's container ID, StartedAt and RestartCount with those before it whatever
the stream delivered; an exit, signal or OOM event the stream dropped is not listed. A `kill` is a signal,
which need not stop the app (SIGCONT, for one), a `die` with no start after it is an exit, and an
`oom` event or an app not running or OOM-killed at the end is what it says: the report lists these
in their own column, as observations, never as a restart. A soak is saved as
`marketplace-soak/v10`; a v9 soak saved an app with no event in its stream as `clean`, saying more
than the stream shows, a v8 soak read no update of its containers or upstream event and, with its
stream unavailable, saved its restart claim as not established, a v7 soak did not check its containers' settings, recheck its app just before
the load or refuse an unterminated or blank event row, a v6 soak paired a start with a die by
delivery order and saved the CPU model's text, and a v5 soak counted those observations as
restarts; none of them is read. The container states and the memory
samples are read independently of the stream. What the `docker stats` and `docker events` clients write is bounded (`clientLimits` in
[steady-run.mjs](steady-run.mjs): bytes read, bytes in one row, rows read, all counted on what the
client wrote, blank rows and escape sequences included): past a limit that observation is
unavailable at once, no wait on the event stream succeeds any more (not even for a marker row read
before the limit was passed), its client is stopped through its own bounded stop, and the pass goes
on to its teardown as usual. Any stderr from either client, up to the moment its pipes close or are
released after its stop, makes that observation unavailable (for the event stream, the cell then fails `unconfirmed`);
stderr past its limit is not kept. Latency intervals start at the k6 engine's start; memory
samples are stamped on the workstation clock from the moment the load's `docker start` was issued,
in intervals of their own of the same length, which lead the latency intervals by the load
container's startup; restart events use the Docker daemon's clock. The report states both clocks.
The fixed rate is reconciled against its schedule: k6's constant-arrival-rate starts one request
per tick of floor(1e9 / rate) ns from slot 0, at most floor(duration / tick) + 1 over the soak.
`window-load.js` also counts each iteration in the interval k6's engine started it in
(`window_N_arrivals`), and the soak saves those counts with each interval's share of the
schedule. The report says "held" only when the rate matched the schedule within tolerance in every recorded
interval: k6 dropped no
iteration, its recorded requests fall short of the schedule by at most one second of arrivals plus
the boundary slot (the allowance for an iteration the engine's stop cut off), and every interval's
arrivals are within that same allowance of its share of the schedule. A soak whose 270,000
requests all arrived in its first minute did not hold the rate, even though its totals match.
Arrivals and completions are on the same engine clock, and a request completes after its iteration
starts, so a soak whose intervals show more requests completed by an interval boundary than
iterations started by it (270,000 completed in the first minute when 9,001 had started) is refused,
whatever its totals, both when it is captured and when a saved one is read. Nor can the backlog
run the other way: each iteration makes one synchronous request on its own VU, so at every
boundary, the last included, the iterations started but not yet counted as completed are at most
the load's 1,000 VUs (`maxVUs` in `window-load.js`, which `window-load.test.mjs` holds equal to
`fixedRateLoad`). Requests the graceful stop answered or left unrecorded add no room: they were in
flight when the last interval ended, so they are among that boundary's outstanding iterations, and
work lost at the stop cannot explain a backlog in an earlier interval. A soak with every arrival on
schedule and no request completed in any interval (all of them in the graceful-stop tail, or all
unrecorded) is refused at the first boundary; a saved one with all of them unrecorded is refused
already on its totals, since more of its iterations are unfinished than the load has VUs. The same
holds for every iteration the soak started, not only those whose request k6 counted: an iteration
that started but never reached k6's request counter still held its VU, so a soak whose arrivals less
k6's completed iterations are more than 1,000 (270,001 started, 270,000 requests, 269,000 completed)
is refused, both when it is captured and when a saved one is read.
Otherwise it reports the shortfall, names each interval that did not hold with its arrivals and
schedule, and does not present the cell as a fixed-rate result. The reader recomputes every
interval's claim from the saved arrivals, so a saved soak can claim an interval held, or the rate
held, only when its saved counters support it; a claim they do not support is refused. The counts it prints are k6's own, never the schedule's. Memory is
reported as unavailable, with the reason, when sampling failed, a sample had no positive size or
the first or last interval had none; the restart, exit, signal and OOM observations are reported either
way. A saved soak whose rate, memory, p99, restart or state claims contradict its counters is
refused.

No report concludes that a timed warmup is long enough. A timed warmup is set only by a separate
reviewed change to the droplet contract, made from a saved pass that is like-for-like with the
rounds it will time. `steady-report.mjs` prints each cell's reading and that the pass sets no
warmup, and, for a pass with the API source, that an API-source cell's reading is not compared with
a timed round (below). `report.mjs <summary.json> --convergence <pass>/summary.json` first states which of the round's
measured adapter, source and target cells the pass has a reading for, which failed, which the
tolerance reading itself gave none for (a zero last-60 s median: listed with that explanation, not
counted as coverage), which are API-source cells it does not compare and which it lacks, then
compares inputs only for the cells with a reading. An API-source cell's reading is listed but never
counted as coverage or compared: a timed round's replay requires the upstream's own answer counts
to cover the successful API requests (`validate.mjs`), while a pass records no upstream counter,
so nothing shows that the cell's requests went through the upstream. Every round's cells include
its API source, so no pass is like-for-like with a round as a whole: one with some readings is at
most like-for-like for those cells alone (and compares page locales only if one of them is a page), and one with none is compared on
no input. It prints each cell's reading and lists every input that differs or that either side
does not record: the commit and group, the image ID of every measured
adapter, the fixture hash, the upstream and k6 image IDs, the CPU quota and pinning for each role
(an unpinned side counts as missing), the host CPU model (by digest), kernel release and online CPU set, the
startup timeout, the app and upstream memory limits, the response encoding, the timed warmup's 32
users, the cold start before the load, a page warmup that rotated locales (results schema v6), and
a timed warmup with no failed request (a round whose warmup had failures is not comparable). The
timed warmups checked are those of the profiles compared, the source and target of each cell with
a reading: a failure only in another profile's warmup (an API-source one, or a page one for a
JSON-only reading) does not change the verdict for those cells.
With `--convergence` nothing read from either file reaches the output unless it validated: the
round's CPU model is not printed (its header line says so, and the pass's model is compared with
it only by digest); each adapter is named by
this checkout's label, not the round's saved one (an adapter the checkout does not name gets a
fixed text); the round's two saved limits (upstream and CPU window) print only when they are this
checkout's text, otherwise a fixed sentence says they are not printed; and a round that is not
JSON or does not validate is refused with a fixed message (the report without `--convergence`
prints the reason). `--vus` other than 32 is for exploration. Without `--convergence` the
report gains one line, saying no convergence pass was provided to it (it was run without one,
which does not say whether one exists); its other output is unchanged. No convergence pass has been saved for any round, so nothing here says
whether any adapter is warm after 10 seconds.

### Splitting a round across droplets

A round's wall time grows with every candidate, so a named group's round can be split across
droplets started together
([#816 A bench round runs every app in sequence on one droplet, so its wall time grows with each app, tier and repeat, and it cannot be split across droplets and still compared](https://github.com/corten-run/corten/issues/816)):

```sh
node bench/marketplace/droplet.mjs r17 --droplets 3 --ssh-key <id> --state-dir <outside-checkout>/marketplace-r17 --plan
node bench/marketplace/droplet.mjs r17 --droplets 3 --ssh-key <id> --state-dir <outside-checkout>/marketplace-r17 --detach
node bench/marketplace/droplet.mjs r17 --state-dir <outside-checkout>/marketplace-r17 --collect --context <saved-context>
```

`--plan` prints the split, each droplet's remote files and every command, calling neither
`git`, `doctl` nor `ssh`. A split splits the launch's group (`--group`, by default the
scheduled one), never the whole inventory: every droplet runs Corten, the subject, beside its
share of the group's other candidates, dealt round-robin in the group's order, so each candidate
is on exactly one droplet and no other app is added (axum + Maud is no anchor; in a group that
has it, it is one candidate like the rest). A group of n candidates besides Corten splits across
at most n droplets. Each droplet is an ordinary c-8 round of its share (`run.mjs rN --group <g>
--part k/n`, into `results/rN/d<k>`): it qualifies each of its candidates, Corten included,
with the same feature contract as an unsplit round, keeps the raw qualification of each, and
times only those it admits. Each droplet then gates its admitted candidates, both sources and all
twelve browser profiles, before its own load; the gate checks each against the contract, not
against Corten, so it needs no other droplet. A droplet must admit its Corten and at least one
peer, as an unsplit round must: a droplet whose peers are all excluded compares nothing and
fails its part, as does a droplet whose gate fails, so the round cannot merge, though other
droplets may already have measured. The deal is by membership, the group's selected candidates
as `groups.mjs` sets them, not by qualification status, what `admitted()` says of each on a
given run: a candidate that lacks a feature stays selected, since missing support is
implementation backlog, not a reason to drop it. So a split is worth launching only when the
latest full round's Feature Qualification table (not a check-only run's, which has no report)
admits at least one peer for every part of the `--plan` split, or the round fails only after the
other droplets have spent their hours ([nightly.md](nightly.md#split-rounds) says where the
default stands).

The launcher checks the clean checkout, that no benchmark droplet exists and the account's
droplet limit (`doctl account get`) once, then writes `split.json` (commit, group and each
droplet's candidates) and refuses another launch from that state directory.
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
which is reported for ownership review, never deleted. A droplet whose launch stopped before
`systemctl start` (state `creating` or `preparing`) never ran its round: `starting` is saved
just before that command and the unit has no `[Install]` section, so nothing else starts it.
Collect finds it by id, or by name and run tag when its create returned no id (where the
stopped launch said to look for a droplet with that name and tag), checks its name and ownership
tags as for any delete, prints its `doctl` delete command and exits 2 until an exact GET
confirms absence in its saved account. A `starting` droplet is collected like any other,
refusing a missing or unloaded unit; if absence cannot be proved, the part remains
unconfirmed. An account list can report extra IDs but cannot confirm or overturn absence
of a reserved ID. Whenever a droplet never started, is
partial or is missing, the round cannot merge, so collect prints the `ssh` command that stops
each droplet still running, whatever the exit code. Exit 1 means a droplet did not finish its
part, or the parts do not merge; 0 means every droplet finished and was deleted, and the parts
merged into `round/rN/` in the state directory (`summary.json`, `split.json` and each
droplet's `d<k>/`). Exit 2 wins over 3: while one droplet runs, an error on another still exits
2. Then fix what it names (delete a droplet that never started with the printed command, run a
printed `ssh` stop command, or clear the reported error), and run `--collect` again until it
exits 0 or 1; never relaunch the round.

The merge accounts for every candidate of the group exactly once: Corten from each droplet, and
each other candidate from the one droplet whose share it was, admitted and measured or excluded
with its raw qualification and no runs. The parts must be exactly the group's split, so no
subset of candidates can pass as a round. Each part must have finished, with its checks passed,
no failures or cleanup failures and a clean tree at the plan's commit; the merge refuses any
other part and keeps each part's outcome in `split`, where the reader checks it again. The parts
must have run together, each starting before any finished, and each with its own run id. The merged summary retains its inputs' schema and group, with
each droplet's candidates, CPU model, tools and Corten in `split`; the reader checks the split
and each droplet's admission, and a whole round's check of the full group is unchanged. Its
report's Feature Qualification table names each candidate's droplet, every table gets a Droplet
column with Corten on every droplet, and each admitted candidate's req/s and CPU us/request is a
ratio to the Corten on its own droplet beside the raw numbers. Ratios are to Corten only. A ratio
is `-` where either stage stopped, the candidate's or its droplet's Corten's, since a stopped
stage's number is not a median of three passes. Raw
numbers across droplets carry any difference between their machines; compare candidates on
different droplets by those ratios. A Between droplets section lists each droplet's CPU and
candidates and Corten's own req/s and CPU us/request on each. A stage is flagged ("d1 and d2
differ") when two droplets' Corten ranges do not overlap, that is when one droplet's lowest is
above the other's highest: raw numbers on those droplets are then not like for like. With only
Corten on every droplet, nothing checks that a ratio carries from one droplet's machine to
another's. `compare.mjs` compares a split round only with one split the same way, each droplet's
host and images equal to the baseline's same droplet, and Corten's rows are d1's. It says so in
one warning, which adds that the cohort context mixes droplets when an unchanged reference
adapter is on a droplet other than d1, and gives each row its droplet. A droplet's CPU
model is not chosen at create, so droplets can land on a mix (Xeon Platinum 8168 on d1 and 8280
on d2, say). The round still merges and its report reads each candidate by its ratio to its own
droplet's Corten. But `compare.mjs` refuses it, with no deltas, against any baseline whose
same-numbered droplet had another model, including the same two models swapped. It does not fall
back to comparing ratios: compare rounds with mixed droplets by their ratio columns by hand.

For local development, `wN` remains the development identity:

```sh
npm ci
node bench/marketplace/fixtures.mjs
npm run check:marketplace
node bench/marketplace/run.mjs w1 --group production --build --check-only
# From a clean, committed checkout, after reviewing conformance:
node bench/marketplace/run.mjs w2 --group production --build --passes 3
# From a checkout of the measured commit (this one, while it is still at that commit):
node bench/marketplace/validate.mjs bench/marketplace/results/w2 w2 <measured-full-commit>
node bench/marketplace/report.mjs bench/marketplace/results/w2/summary.json
```

Use a fresh `wN` each time: an existing result directory is never overwritten. `--apps` may
select individual apps for development checks. A publishable group baseline needs raw
qualification for every candidate, the full gate and three passes for every admitted app,
and a qualified Corten plus at least one peer. `--group production-qualify` explicitly audits
the full inventory. New grouped runs use the bounded
[`marketplace-production/v2` qualification](nightly.md#framework-groups).
Connection-flood resistance: not measured. ETag and downstream readiness remain exceptions;
this uncached workload does not claim all enterprise features match.
Rebuild images from the old feature profile with `--build` before using them in a new group.
The read-only reporter rejects arbitrary subsets, check-only runs, dirty commits,
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
containers, Docker recorded no kill, stop or restart of the app, and no phase step failed.
An ordinary app exit does not require samples after the exit. When sampling was active, the
client must return the expected shutdown status; a matching signal cannot establish who sent
it before the client was reaped. A client exit observed before the stop request, any client
stderr, an incomplete record, or a sampler deadline fails the phase. Replay refuses
recorded faults and rechecks the Docker CPU and memory display format, finite values after unit
conversion, and the matching sample summary even when the app stopped. A well-formed terminal
zero (such as `0.00%` and `0B / 0B`) is allowed for a stopped phase. Only phases that did not
start a sampler (warmup) need neither file.
Still failures: a phase with no k6 summary or in which no request succeeded, a 200 of the wrong
content type (before a stop too), an app container that stopped during its cold start or before
a phase began (after its first 200, before warmup or between phases), and any error answer
from the upstream to a record read. Results written
this way use schema `marketplace-results/v6`, with raw feature qualification for named groups.
v5 also qualified named groups but timed page locales separately; do not compare those timings with v6.
The reporter and `compare.mjs` retain groupless v3/v4 history (under v3 an app that stopped
failed the round). Historical full-inventory results do not compare with qualified groups.
Archived `marketplace-production/v1` evidence is read under its original contract; it cannot
be mixed with v2 in a split merge or used as a v2 comparison baseline.
The local `wN` commands do not create a droplet, collect c1, update nightly state or publish anything.

### Saved raw evidence

Marketplace uses Catalog's bounded runner for its Git, Docker and check
commands. If one of those commands is stopped and a descendant holds its output
pipes open, the runner releases the pipes after the stop grace and reports a
failed command. Existing command deadlines, load settings and owned-container
cleanup still apply. The separate Docker stats sampler does not use this runner.

The browser gate observes native enhanced form transports without replacing them.
Livewire alert updates must identify the same-origin marketplace alert component,
item, locale, save call and submitted values. The complete rendered-page and
valid/invalid alert assertions still run, as do JavaScript-disabled plain forms.
LiveView alert saves retain their native WebSocket or long-poll transport. The gate
waits for the connected render before filling, matches the exact form, root and
reply references, and requires a successful POST acknowledgement and a reply from
the same session when polling. A POST acknowledgement or changed message alone
does not prove that save completed. Its continuing polls are not navigation:
the correlated save and rendered message precede the full-page assertions, without
requiring global network idle. Transport failures retain bounded diagnostics.
A JavaScript-disabled page runs no animation-frame or timer callbacks, so the gate's alert
message wait keeps its predicate (the first `.marketplace__message` has non-whitespace
`textContent`) but has Playwright re-evaluate it from outside the page, through a `:root`
locator, rather than an in-page poll that never ran again once it had seen the POST document
before its message. That stall matches r19's symptom in [#1251](https://github.com/corten-run/corten/issues/1251),
though r19's cause is not established.
`alert-probe-run.mjs IMAGE [ITERATIONS] [RESULTS_DIR] [--budget SECONDS] [--deadline SECONDS]` repeats the three
English phone alert cases without JavaScript against an image in both sources, laid out like
the gate. It uses the gate's own submission wait, then requires one document POST answered
200 without a redirect, that POST to be the last main-frame document request (a refresh or
redirect to a GET at the same URL fails), the full expected page and the exact message, and
keeps a bounded diagnostic (case, POST chain, document requests, ready state, message and
document tail) for each failure. Its containers and network carry the run's owner label and
are removed by the IDs their creation returned after confirming that label; a removal that
fails or an owner that cannot be confirmed fails the run, and `cleanup.json` records the
outcome. Catalog Contract uploads that record even when the run fails, so it names an ID only once
the run has it from its own create or has confirmed its owner label on it: an ID a listing
returned that is not confirmed as the run's is never named, a failure on it is recorded as a fixed
message, what survived teardown is counted rather than listed, and a listing that fails is recorded
by its kind and exit status alone, never with its client's diagnostic, which can echo the filter. The app and upstream join the network by its ID. Extra `--label` keys may not be the
owner key `run.corten.marketplace.alert-probe` or a key in its dot-delimited namespace
(`run.corten.marketplace.alert-probe.*`); other keys, even with the same literal prefix, are
ordinary. A create that returns no ID, whatever its error (a daemon error can follow a create
the daemon already made), is looked for by a label of its own for up to 10 seconds at teardown,
each lookup cut to the time left; if nothing appears, its cleanup is reported unconfirmed and
the run fails, since Docker may still make it. A failed lookup is reported and does not stop
the sweep by the owner label, and a failed owner-label listing is reported and does not stop an
ID such a lookup found from being removed, or confirmed absent, by that ID. Before removing a container or network the runner looks it up by
its own ID: only an empty answer counts as already gone, and any other answer (another full ID)
leaves its removal unconfirmed and fails the teardown, as `bench/fullstack/idle-close.mjs` does.
`--deadline` bounds the whole run: work stops starting two minutes before it, leaving that
time for the app logs, removal and `cleanup.json`. Catalog Contract runs it for React Router
at 10 iterations per source, including after a failed marketplace gate that built the image,
with a 240-second probe budget and an 840-second deadline inside the step's 15 minutes. It is
a functional check, not a measurement.

New native runs retain `evidenceVersion: "marketplace-raw/v3"` alongside the
`marketplace-results/v6` summary format. `validateSaved({ folder, round, commit })` from
`validate.mjs` returns the summary only after replaying the saved producer folder. Its CLI
above exits nonzero for invalid evidence. Run it from a checkout of the measured commit, such as
`git worktree add --detach <dir> <measured-full-commit>`: it checks the retained image references
against the pins of the checkout it loads, so a round measured before a pin moved fails from a
newer checkout, with a message naming the pin it expected and the measured commit. A split round validates each native `dN` folder;
the merged summary alone is not a producer folder. The historical summary reporter remains
available, but its success is not raw-evidence validation. Newer validators may require
receipt fields that an older producer did not write. Replay older folders from the producer's
measured checkout, not the latest checkout; do not backfill receipts with inferred observations.
Raw replay checks the profile, settings, app image label and qualification receipts under the
same contract. V1 replay is offline only and still requires the original raw receipts.
The v3 receipts also retain the selected immutable k6 manifest, platform and actual
executable version in both the summary and raw tool observation. Earlier versions
without that identity remain historical, not newly qualified v3 measurements.
Image and container projections retain omitted optional Docker `Entrypoint`/`Cmd`
as explicit `null`. Image projection first requires a non-null, non-array configuration
object; malformed configuration cannot become null defaults.
They do not invent command arguments: replay still requires
every nonempty image default and fixed native invocation exactly.

The replay checks both sources, every localized page and neutral JSON profile/pass/phase,
exact per-pass metrics and aggregates, raw qualification and browser/content gate results,
image IDs and clean source labels, the saved fixture bytes and local source commit tree,
container configuration and capacity settings, cold probe output and Docker clock, cgroup
CPU before/after counters, and Docker memory/CPU sample histories. Gate containers must
finish before load. Runs must follow the native rotated serial pass plan without overlapping
windows. Tool entrypoints/commands and exact, non-overlaid checkout/fixture/output mounts
must match the native invocation. Stopped profiles use the existing stop/event rules, not invented zero
measurements. Missing or malformed receipts (including deleted raw files) are invalid, not
an absent-proof fallback. No capability requirement or nightly capacity policy is relaxed.

The native memory mean uses the sampled steady window, while the peak uses every sample.
Floating-point summation can put the mean slightly above the peak even for a constant
decimal reading. The named-group summary check (including merged split summaries) bounds that case
by summing a history with every reading at the saved peak and the same sample count.
An overshoot must also be a possible rounded quotient for that steady-window length.
Native replay still requires both saved means to match the exact calculation from the
retained Docker readings; it does not round or rewrite evidence.

API phases require at least one observed upstream record answer for each successful k6
request (`http_reqs.count - failed`), rather than merely a nonzero read count. Failed or
timed-out requests may also read upstream, so reads need not equal successful traffic.
Stopped phases must retain the complete latency, failure, aggregate-check and named-check
export even if every request failed; they never become numeric passing phases. Stop-sidecar
states must be healthy and agree with their retained runtime snapshots. CPU observations
are ordered by actual serial phase windows and must be cumulative per container ID, including
the shared upstream across apps/profiles/passes. A stopped phase's pre-load counter remains
a lower bound when its post-load counter is unavailable. Gates cannot start before the
specific checked app's retained start time.

The native script makes one HTTP request and two ordered named checks per iteration.
Replay requires `iterations`, `vus_max`, the HTTP failure rate's actual true/false sample
counts, and the aggregate check rate/counts, not just their ratios. Each named check must
cover every completed iteration and at most every request; the content check cannot
outnumber the preceding status check. Their pass/fail sums must equal the aggregate checks.
Status passes/failures cannot exceed the corresponding HTTP success/failure counts.
Only observed unfinished iterations (`http_reqs.count - iterations.count`), bounded by
the observed maximum VUs and the native scenario's VU limit, can lack checks. There is no
percentage-of-traffic cutoff waiver. Rate ratios allow only `1e-12` float64/JSON rounding.
Fixed-rate drops and failed requests remain app outcomes, not a new admission test.
All exported HTTP and iteration latency trends require nonnegative finite values, ordered
percentiles below the maximum, and a mean bounded by the maximum and its contribution
over at most the request count. These checks also apply to stopped phases.
For each linear-interpolated nonnegative quantile `q(p)`, the mean must also lie
between `(1-p)*q(p)` and `p*q(p) + (1-p)*max` (with relative `1e-12` rounding).
For known request/iteration sample counts replay tightens these limits using the
actual interpolated order-statistic position, including one- and two-sample cases.
Every latency maximum must fit the retained engine elapsed clock, allowing only
1 ns conversion rounding or relative `1e-12`, whichever is larger. Total HTTP and
completed-iteration duration work cannot exceed maximum VUs times engine elapsed;
HTTP work must fit completed iteration work plus the maximum duration of each
unfinished request. These are feasibility checks, not latency admission thresholds.

The generator receipt must retain the producer's **2 GiB** limit, not the app's
1 GiB limit. Fixed requests plus dropped iterations cannot exceed the number of
arrival slots in the actual engine elapsed window. Replay uses the executor's
integer-nanosecond `floor(1e9 / RATE)` tick, slot zero and 1 ns clock conversion
rounding. Using the whole elapsed window, including graceful stop, is conservative
with respect to scheduling jitter; it is not a fixed percentage waiver. Real capacity
drops within this bound remain app outcomes.

CPU deltas must fit their enclosing retained phase window and the participant's
quota and logical CPU count. Absolute counters must also fit the container lifetime;
the pre-load counter precedes generator start, while the post-load counter precedes
receipt completion. The upper bound allows 2 ms for the two wall-clock endpoints,
two partial CFS periods and a conservative whole period per CPU for non-expiring
CPU-local runtime slices, capped by physical CPU time. NanoCPU limits use Docker's
default 100 ms period; explicit CFS periods must be within Linux's 1 ms to 1 s range.
See [Linux CFS bandwidth and runtime-slice caveats](https://docs.kernel.org/scheduler/sched-bwc.html).
Every pinned CPU in every role must belong to the retained host online-CPU set,
not just have a plausible index or cardinality. The parsed inventory also bounds
each Docker CPU sample to `100 * online logical CPUs` percent, with only `0.005`
percentage points for Docker's two-decimal display rounding. Instantaneous samples
are not capped at the role's quota; cumulative cgroup counters retain the separate
phase/lifetime quota bounds above.
Each raw Docker memory sample and its displayed limit must fit the participant's
retained memory limit. The only display allowance is half a four-significant-digit
step from [Docker's `BytesSize` formatter](https://github.com/docker/go-units/blob/master/size.go),
including omitted trailing zeroes, not a percentage of the container's capacity.

Upstream control snapshots retain both per-record requests and status answers. The native
upstream increments both synchronously before serving a control GET, so their totals must
match. Both counter maps must be monotonic locally and across serial observations of the
same upstream container, including gaps between apps/profiles/passes; load never resets them.
Every container start must fall within the round and precede the observations it supports,
including upstream-backed gates/cold starts and shared CPU reads. Repeated identities must
keep the same start time. A healthy phase cannot carry sidecar/event observations that the
producer only reads on the stopped-app path.

Each phase also retains `<phase>-clock.json`, written by the real load script's
`handleSummary` callback. Its `state.testRunDurationMs` is k6's counter-rate denominator,
including graceful completion, not the configured duration or Docker lifetime. The legacy
metric export remains unchanged. Replay checks every exported counter's count/rate against that clock with relative
`1e-12` float64/JSON rounding tolerance. The configured-duration lower bound allows only
1 ns of conversion rounding. The Docker/engine window comparison allows 2 ms for
sub-millisecond Docker timestamps truncated by `Date.parse`; engine startup,
shutdown and graceful-stop jitter are not waived as rate error. Generator success and
clock consistency are required even when the app stops. The producer-path mock executes
the actual callback and copy helper with sub-ms and graceful-completion durations; it does
not claim a real load measurement. Setting `MARKETPLACE_PRODUCER_MOCK=1` when running
`node --test bench/marketplace/load-evidence.test.mjs` additionally exercises the pinned
real k6 image against an isolated, delayed HTTP mock, then removes all test containers and
temporary receipts. Both fully served and all-failed exports exercise the complete schema
parser; the all-failed export still cannot qualify as a numeric measurement.
It requires cached images, never pulls, publishes no ports, and has
no external network. Saved replay itself never invokes this test or Docker.
See [k6's summary clock and metric conversion](https://github.com/grafana/k6/blob/master/internal/js/summary.go).
The check/iteration cutoff rules follow [k6's ordered check sample emission](https://github.com/grafana/k6/blob/master/internal/js/modules/k6/k6.go)
and [completed iteration sample emission](https://github.com/grafana/k6/blob/master/internal/js/runner.go).
Earlier raw versions without this independent clock remain historical and fail saved replay;
do not synthesize clocks from their counts/rates.

Cleanup retains the actually created/removed container, network and anonymous-volume
identities, checks anonymous volumes after `docker rm -f -v`, and records the final owned
container/network inventories. Empty failure arrays alone do not establish cleanup.
These are replayable observations, not tamper-proof image/build attestations or a new
qualification system; functional checks alone do not establish native implementation.

Saved replay never runs Docker or a browser, contacts a service, writes files, or fetches
Git objects. The exact source commit must already exist locally; Git replacement objects
and lazy fetching are disabled. Supply a stationary local evidence folder, not a live
runner output. UNC/device paths, symbolic links/junctions, multiply linked files and
non-regular entries are rejected. Reads check file identity/size before and after opening,
with bounds of 25,000 entries, depth 8, 32 MiB per read and 512 MiB total. The validator
does not follow artifact-controlled paths or execute artifact content.

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
Every admitted app must pass both sources before *any* app is timed. CI runs both the legacy
catalog gate and this gate for each of the twenty apps.

Load uses a one-CPU app quota, a four-CPU load-generator quota and a two-CPU upstream quota.
For disjoint pinning set `MARKETPLACE_APP_CPUS`, `MARKETPLACE_LOAD_CPUS` and
`MARKETPLACE_API_CPUS`; overlaps are rejected. Without those settings quotas do not prove core
isolation. Each source has two timed profiles: a localized page and locale-neutral JSON.
The page cycles through `en-US`, `fr-FR`, `de-DE` by scenario iteration, starting at
English each phase. k6 counts attempts for each locale; throughput and latency describe
the mix, not any individual language. The page cold probe uses English. Conformance
and browser checks still cover all three locales for both sources. JSON never selects a locale.
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

If the Next.js image fails to build, check `build-nextjs.log` first. Its locked
`npm ci` step logs package fetches and npm warnings/errors, including extraction
failures, without a full npm trace. The step sets npm's `fetch-timeout` to 60
seconds; the deadline for the whole install is 10 minutes (TERM, then KILL after
another 10 seconds if needed).
An install that ultimately fails is a setup failure, not a timing result. This
step is included when `bench/fullstack/docker-rebuild.mjs` times a cold image
build. The separate dependency timing in `bench/fullstack/builds.mjs` is unchanged.

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

The separate [native trace capture cost diagnostic](../fullstack/native-trace-cost.md)
can compare optimized Gin, Drogon and Topcoat source revisions. It is not part of
nightly timing, a workload qualification or evidence that request tracing is free.
Its parser and cleanup controls run with the marketplace harness checks. Strict
native parser failures remain failed observations even when response bytes match.
