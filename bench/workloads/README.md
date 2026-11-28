# Workload-specific benchmark groups

Corten participates in each group below. The two challenger categories explain selection,
not a speed ranking. Membership is independent of current adapter readiness. Keep native
framework facilities and equivalent observable work; never slow a peer with a shared renderer
or remove Corten's features to manufacture parity.

<!-- groups:start -->
| Group | Popular challengers | Performance-oriented challengers | Required work |
|---|---|---|---|
| Catalog page (`catalog-page`) | ASP.NET Core, Express, FastAPI | axum + Maud, Drogon, Gin + templ, Proa | typed-record, escaped-fields-and-links, get-filter, request-time-source, no-output-cache |
| JSON API (`json-api`) | ASP.NET Core, FastAPI, Express, Spring Boot | axum + Maud, Drogon, Gin + templ, ASP.NET Core Native AOT (JSON only), ntex | typed-complete-schema, numeric-json, tested-errors, fetch-parse-reserialize, no-output-cache |
| Localized marketplace (`localized-marketplace`) | Next.js (Pages Router), ASP.NET Core, Django | Topcoat, Leptos, Gin + templ, Drogon | complete-marketplace, request-time-localization, filter-sort, valid-invalid-forms, js-and-no-js, bounded-production-http/v2 |
| Mixed production traffic (`mixed-production`) | ASP.NET Core, Spring Boot, Django, Express, FastAPI | Topcoat, Gin + templ, Drogon | localized-reads, numeric-json, listings, accepted-rejected-writes, write-readback, slow-upstream, bounded-production-http/v2 |
| Full-stack browser experience (`fullstack-browser`) | Next.js (Pages Router), Nuxt, React Router, Rails + Hotwire, Laravel + Livewire | SvelteKit, Astro, TanStack Start, Leptos | ssr, native-navigation, filter-sort, valid-invalid-forms, js-and-no-js, desktop-mobile, readiness-actions-bytes |
| Client-heavy screens (`client-heavy`) | React, Vue | Solid, Svelte, Remix | equal-loaded-keyed-rows, dashboard-mutations, sort-filter-selection, no-operation-http, subscription-cleanup, final-dom |
| Live delivery (`live-delivery`) | ASP.NET Core, Express, Phoenix, Rails + Hotwire | Gin + templ, Drogon, Leptos | equal-initial-state, ordered-visible-events, native-transport, bounded-slow-client, browser-correctness, cleanup |
| Recoverable live application (`recoverable-live`) | Phoenix, Rails + Hotwire, Laravel + Livewire, ASP.NET Core | Leptos, Topcoat | equal-initial-state, disconnect, gap-detection, replay-or-resnapshot, no-duplicate-effects, final-keyed-state, bounded-slow-client, cleanup |
| Resilience and hardening (`hardening`) | ASP.NET Core, Spring Boot, Next.js (Pages Router), Django, Express | Gin + templ, Drogon, Topcoat | equal-legitimate-traffic, declared-deployment-budget, bounded-client-deadline, bounded-request-limit, dependency-recovery, useful-service, recovery |
<!-- groups:end -->

Proa is selected only for its compiled catalog page, and ntex only for its native
JSON API. Neither selection implies a measured advantage or admits a tuned deployment.
Do not add a localized Proa or browser port on the strength of an HTTP throughput
ranking. The [optional JSON comparison](../json-api/README.md#optional-transport-comparison)
reuses the fixture-backed app to measure body compression and connection reuse. It
is not a tenth group or a new phase multiplied across the official matrix.

## Implementation status

The [grouped cloud controller](CLOUD.md) supports a dedicated fresh host for each complete
registry group. `fleet.mjs ROUND --fleet-root ROOT --prepare` reserves the complete current
inventory (with the exact commit, SSH key and saved provider identity). An explicitly reviewed
`--detach` approval launches only the first complete group, not a common-setup qualification run.
Every other group remains visibly deferred, including during first-stage `--collect`;
the fleet is still incomplete. Each host runs only its group's
native entries. The [campaign procedure](isolated/CAMPAIGN.md) retains independent source-audit
waits and terminal-only evidence collection for each host. A separate fleet gate requires
every current group before reporting a complete round. These are separate from the legacy marketplace
schedule and the per-group development commands below. Exact merged-source review, native
producer/validator integration and host-readiness gates remain mandatory before allocation;
an implemented controller or a passing portable suite is not a completed benchmark.

After collecting that same first host, a separate `--admit-remaining --print-approval`
replays its actual intrinsic native evidence and checks its archive, extracted tree,
source/provenance, complete selection and confirmed deletion. It requires the campaign's
authoritative `verified` outcome, not perfect performance or success from every competitor;
valid failed and unsupported app outcomes remain visible. Synthetic inspection, bootstrap
readiness, operation receipts and saved status alone cannot authorize later admission.
The new exact approval binds that evidence snapshot and every remaining child subject.
Execution rechecks it under the fleet lock and consumes a once-only remaining intent before
dispatch. Remaining dedicated hosts are admitted serially after each local worker settles;
their remote group campaigns overlap. Changed evidence, uncertainty, interruption or an
admission failure stops untouched children without making the intent replayable. Final fleet
verification still refuses an active root operation lock and requires every official group.
Use `--print-approval` for each fresh action, then supply its reviewed hash with
`--approve-reviewed-merged-ready`; neither preview nor these commands grants operational
approval. Historical fleets remain collectable, but legacy or consumed launch intents cannot
acquire new remaining-admission authority.
An accepted root alias remains bound to the same physical fleet: collection and remaining
admission can use either spelling while the original requested path still resolves there.
Removing or retargeting it refuses remaining admission, even via the physical path. Each
invocation's requested spelling still requires its own exact approval; consumed intents are
never rewritten to repair path identity.

For a partial round, use [independent group continuation](CLOUD.md#independent-group-continuation)
to reference already verified group results and run only missing groups. Each
result keeps its measured revision and evidence; the index is not a new fleet.

The [client-heavy runner](../client-heavy/README.md) builds all selected native
applications, observes their actual DOM and resources, and gates a separate
measured journey on correctness. Its defaults are bounded local verification,
not an isolated ranking or a cloud/nightly integration. Other native groups
retain their independently reported implementation and qualification states.

`registry.mjs` is the versioned selection and functional-work matrix. `evidence.mjs` keeps
every selected app/case visible as unknown, implemented or not implemented, with separate
parity and measurement states. Missing, unsupported and failed evidence is not zero throughput.
This ledger does not certify a feature: a runner must derive cells from its raw correctness
captures and validate its complete evidence before publishing comparative numbers.

The localized marketplace group is wired to the existing marketplace runner as an explicit
`--group localized-marketplace` selection. Its exact-image feature qualification and complete
browser/content gates remain mandatory. Timing has four cases: one page rotating through
`en-US`, `fr-FR` and `de-DE`, and one locale-neutral JSON case, for each of fixture and API.
Page throughput is for the mix, not for each locale. Parity still checks each locale separately
in both sources, on desktop and mobile, with JavaScript on and off. The new group contract
requires v6 results; the preceding bounded v5 contract retains its eight per-locale/JSON cases.
Both the localized and mixed groups check ordinary,
sequential HTTP requests before timing. Connection-flood resistance: not measured.
Historical qualification does not admit an app to a new run. Candidates missing production parity stay in the
report with their missing features and are not timed. The existing scheduled `production`
selection and historical reservations are unchanged while native parity work is completed.

The catalog runner accepts `--group catalog-page` for page-only timing of the exact registry
selection in both sources, with its stronger native page and JSON correctness gates retained.
Its versioned group evidence binds checks and timing to each immutable image and verifies
after-run provenance and saved aggregates. Its separate explicit-commit cloud controller uses
independent durable reservations and terminal-only collection/deletion. This is implementation,
not a passing group result or proof of workload readiness; see the [catalog procedure](../catalog/README.md).

The [JSON API runner](../json-api/README.md) keeps catalog and numeric marketplace payloads
separate in both sources, with no HTML qualification. Functional responses and independently
audited native parse/serialization sources are separate gates, bound to exact images and
configuration. Neither gate can be borrowed from a passing subset or a different ASP.NET
configuration. Native audit receipts and a complete matrix are prerequisites, not assumed
readiness; no new baseline or cloud integration is claimed.

The other groups now have explicit local native driver entry points. Their apparatus still
requires complete native qualification, reviewed measurement settings and isolated evidence.
Their presence is not a claim that all native features exist, a comparative benchmark passed,
or historical measurements are interchangeable. Offline oracles do not replace native
application observations. `plan.mjs` reports the distinction for each group.

## Explicit execution

Use one named group and one round, rather than a default that launches every server adapter:

```sh
node bench/workloads/run.mjs --plan catalog-page c3
node bench/workloads/run.mjs client-heavy local-client
node bench/workloads/run.mjs fullstack-browser w1 --build --out bench/fullstack-browser/work/w1
```

The first command only prints the exact native invocation and pending deployment intent.
Execution delegates to the group's own runner, preserving its defaults, native exit status
and raw evidence. The browser example requires a new output directory and the native runner's
explicit development round (`wN`).
It never launches a droplet or changes the nightly schedule. Contender and case filters
are refused here; native diagnostic invocations remain separate and cannot qualify an
incomplete group. Split-round `--part` is also refused, including `--part=1/2`.
Planning reads the immutable inventory, independently of legacy `BENCH_APPS`, `BENCH_TIER`
and `BENCH_EDGE`. Execution refuses these overrides when nonempty: unset them rather than
silently changing the selected group or its native deployment.
A dispatcher entry is not a passing result: missing native ports,
failed controls and unsupported capabilities remain visible in the runner's ledger.
The mixed, browser, live and hardening ports still require complete native qualification.

Cancellation uses IPC to ask the native Node process to handle `SIGINT` or `SIGTERM`, not
Windows' hard-terminating `kill`. Before native execution it skips startup; during startup
it retains cancellation until a native signal handler registers. Parent disconnection also
requests cancellation. The dispatcher waits for native exit without a force-kill deadline,
so the native runner remains the owner of its processes, containers and `finally` cleanup.
Repeated dispatcher signals do not force termination. Cancellation cannot become success,
even if a native handler exits zero. Native nonzero failures remain nonzero.
This is not a cleanup guarantee: synchronous work delays delivery, a runner without a signal
handler may continue to completion, and a stuck or uncooperative runner may require operator
intervention. The bootstrap reports unhandled cancellation if the native entry returns;
only the native runner's own cleanup evidence can establish that resources were removed.

[Deployment selection](deployments.md) names representative production configurations and
bounded performance candidates without altering the legacy registry or any active round.
Popular-choice and performance views use the same feature-parity work and raw evidence;
they are not extra benchmark runs. A plan is not the effective runtime configuration.
Alternatives need complete group-specific native and repeated performance evidence plus
independent review. This dispatcher does not yet select or qualify alternative deployments.

`npm run check:workloads` checks the shared contracts and dispatch. `npm run check:groups`
also checks the integrated native driver apparatus and replays saved live evidence.
Its socket controls run serially so unrelated test files do not compete for the same
bounded observation window. Neither command substitutes for native application runs,
browser captures, independent deployment review or a complete measured matrix.

```sh
node bench/workloads/plan.mjs catalog-page
node bench/workloads/plan.mjs localized-marketplace
node bench/workloads/plan.mjs fullstack-browser --evidence cells.json
node --test bench/workloads/*.test.mjs
```

Planning is read-only and never creates cloud work. For an authorized official localized
round use the [marketplace launch and collection procedure](../marketplace/nightly.md), with
`--group localized-marketplace`; collection always uses its saved reservation. Discover
current settings from the measured commit and retain complete provenance. Do not compare
different groups, payloads, native deployments, gate versions or incompatible options.

## Parity boundaries

Catalog page and JSON are separate cases, as are catalog and marketplace JSON. Numeric JSON
does not perform money localization and is not repeated under locale labels. Native AOT is
a separate JSON-only challenger, never a replacement for ordinary ASP.NET Core JSON.
Browser groups must disclose actual native architecture: Pages Router is not App Router,
Blade is not Livewire, and controller HEEx is not LiveView. Names in the shortlist describe
the intended native feature work, not evidence it is implemented yet.

Live groups require equal initial-state work and application-visible correctness, not the
same SSE/WebSocket envelope. Recoverable live permits cursor replay or an authoritative
resnapshot with equivalent final keyed state, but implies no authentication, multi-node
or process-restart durability. HTTP hardening defaults cannot be blindly applied to long-lived
streams. In the hardening group a missing protection is a measured outcome, not an exclusion;
broken parity, harness or cleanup remains an invalid measurement.

## Shared correctness contracts

These modules validate captured application work offline. They do not run an adapter,
launch traffic, qualify a group or provide performance numbers. Their tests use synthetic
captures, including invalid evidence. A runner must save the exact effective plan and raw
observations, verify their provenance, and supply independently reviewed settings. Passing
an oracle with manufactured observations is not a native-framework parity result.

`mixed.mjs` creates a seeded, fingerprinted `mixed-plan/v1` from the current marketplace
records. It covers localized page reads, locale-neutral numeric JSON, listings, accepted
and rejected form writes, and slow upstream completion, deadline and cancellation cases.
Native form actions, encodings and session state remain native; transport secrets are not
serialized into the public evidence. Writes need actual submission evidence, the expected
localized result and independent state readback. Explicit failed, dropped, unsupported and
not-run outcomes remain counted and cannot establish parity. The validator always leaves
`readyForLoad` false: native adapters, reviewed load settings and operational qualification
are separate work.

`live.mjs` defines `live-keyed-state/v1`, `live-delivery/v1` and `recoverable-live/v1`.
It checks equal initial snapshot work, keyed insert/delete/reinsert effects, visible ordering,
duplicates and gaps, authoritative resnapshot or replay, finite queue/history bounds and
instrumented cleanup. Native SSE, WebSocket and framework-specific envelopes are normalized
without prescribing a common transport. Snapshot rows, application effects, publication
acknowledgements and owned-resource observations must come from the implementation, not
from the reference-state helper. Browser execution, continuous peak instrumentation and
complete native process/store inventories remain runner responsibilities.

The [native hardening runner](../hardening/README.md) uses ordinary bounded HTTP requests
to observe client deadlines, request limits and recovery after a private dependency delay.
It keeps direct and deployed-edge deployments separate. A target that cannot serve a
request stays in the results; an invalid control or missing evidence is not a target
failure. Earlier pressure-workload captures are historical and cannot fill these cells.

Run all shared contract checks with `npm run check:workloads`. None of these offline checks
establishes build-time, instruction-count, browser-interactivity or load-test results.

`browser.mjs` creates a fingerprinted native marketplace journey for every selected source,
locale, device and JavaScript mode. It checks initial SSR, linked navigation, observable
filter/sort/show-all work, accepted/rejected native forms and independent write readback.
Native router data requests keep their actual transport paths; Livewire and Hotwire work
cannot be replaced with a full-page controller response under their names. Page-scope cleanup
and browser/environment observations remain requirements for a future native runner.

`client.mjs` describes equal keyed rows and dashboard data with explicit fixture sizes and
seed. Its oracle checks native selection, sorting/filtering, keyed mutations, dashboard
updates, no operation-time HTTP and post-unmount resource cleanup. Reference-state helpers
must not manufacture captured DOM or resource observations. Both new oracles always leave
`readyForLoad` false and do not replace the retained historical browser/client measurements.

`json-check.mjs` is a native HTTP correctness gate, not a load runner. `checkJsonApp` exercises
every record against either the catalog or marketplace schema without requesting HTML or
requiring forms. The caller retains raw responses through its required observer. Missing
records and upstream errors need JSON representations, but no common error-body format is
imposed. HTTP-source probes change upstream records and check exactly one upstream read
for every record in the complete sweep and each subsequent probe. Wire formatting cannot
prove native parse/reserialize work: a pretty serializer is valid, while a byte forwarder
can manipulate whitespace. The gate therefore leaves `nativeSerializationVerified` and
`readyForLoad` false and requires independent native source/serializer verification.
Catalog's current upstream
does not inject redirects; its result explicitly says redirects were not tested. Marketplace
also tests refusal of upstream redirects. These checks do not establish production middleware
parity, process provenance or measurement readiness, and do not substitute AOT for ordinary
ASP.NET Core. Unit tests use a deliberately small test server, not a comparative adapter.

## Retained evidence

`retainedFamilies` in the registry keeps existing runner/test entry points for cold start, CPU/memory/
latency, HTML/CSS/JS/WASM bytes, browser readiness/actions, clean/incremental/development builds,
editor/test-build/disk/core scaling and supported hardware instruction counts. Save-to-reload
is retained as explicitly not implemented: no save-to-browser-reload harness exists yet.
Each needs a workload-specific port or an explicit historical/unsupported/not-run label;
grouping never removes it or invents new measurements. No new cadence is defined here.

A group's published result commits its report and provenance, and a summary only if it fits
and is approved for disclosure. The collected archive and other raw output stay outside the
tree. Provenance records the original's SHA-256 (`archiveSha256`) and where it can be fetched.
For an original that must stay in controlled custody, the
[grouped results publication exception](../../CONTRIBUTING.md#benchmark-results) instead
requires independent replay of that original in place, a custody reference, and a separate
downloadable export with its own digest. Do not record the export as the original or use it to
qualify a group. `npm run check` fails on a file
under `bench/` with an archive suffix or over 256 KiB, in any commit of the pull request, unless
the base's `scripts/bench-size.allow` lists it at that path and blob, or it is a dependency lock
file at a path `LOCKS` in `scripts/bench-size.mjs` lists, beside its manifest; the
[contributor guide](../../CONTRIBUTING.md#benchmark-results) has the full rule.

Corten-only rendering/allocation/default-cost and TCP diagnostics remain separate from
competitive rankings. The distributed listings-feed run and failover test remain separate,
including all application, Postgres, NATS and edge resource costs. Single-application recovery
does not replace those diagnostics.

Implementation is tracked by
[#807 bench/fullstack has no tier where every app implements the same production features, so its tables mix framework cost with feature cost](https://github.com/corten-run/corten/issues/807)
and
[#817 A bench/fullstack round takes 5.5 hours, the planned tiers and repeats would take it past 15, and nothing sets which apps, phases and cadence each tier gets](https://github.com/corten-run/corten/issues/817).
