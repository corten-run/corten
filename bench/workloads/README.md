# Workload-specific benchmark groups

Corten participates in each group below. The two challenger categories explain selection,
not a speed ranking. Membership is independent of current adapter readiness. Keep native
framework facilities and equivalent observable work; never slow a peer with a shared renderer
or remove Corten's features to manufacture parity.

<!-- groups:start -->
| Group | Popular challengers | Performance-oriented challengers | Required work |
|---|---|---|---|
| Catalog page (`catalog-page`) | ASP.NET Core, Express, FastAPI | axum + Maud, Drogon, Gin + templ | typed-record, escaped-fields-and-links, get-filter, request-time-source, no-output-cache |
| JSON API (`json-api`) | ASP.NET Core, FastAPI, Express, Spring Boot | axum + Maud, Drogon, Gin + templ, ASP.NET Core Native AOT (JSON only) | typed-complete-schema, numeric-json, tested-errors, fetch-parse-reserialize, no-output-cache |
| Localized marketplace (`localized-marketplace`) | Next.js (Pages Router), ASP.NET Core, Django | Topcoat, Leptos, Gin + templ, Drogon | complete-marketplace, request-time-localization, filter-sort, valid-invalid-forms, js-and-no-js, production-http |
| Mixed production traffic (`mixed-production`) | ASP.NET Core, Spring Boot, Django, Express, FastAPI | Topcoat, Gin + templ, Drogon | localized-reads, numeric-json, listings, accepted-rejected-writes, write-readback, slow-upstream, production-http |
| Full-stack browser experience (`fullstack-browser`) | Next.js (Pages Router), Nuxt, React Router, Rails + Hotwire, Laravel + Livewire | SvelteKit, Astro, TanStack Start, Leptos | ssr, native-navigation, filter-sort, valid-invalid-forms, js-and-no-js, desktop-mobile, readiness-actions-bytes |
| Client-heavy screens (`client-heavy`) | React, Vue | Solid, Svelte, Remix | equal-loaded-keyed-rows, dashboard-mutations, sort-filter-selection, no-operation-http, subscription-cleanup, final-dom |
| Live delivery (`live-delivery`) | ASP.NET Core, Express, Phoenix, Rails + Hotwire | Gin + templ, Drogon, Leptos | equal-initial-state, ordered-visible-events, native-transport, bounded-slow-client, browser-correctness, cleanup |
| Recoverable live application (`recoverable-live`) | Phoenix, Rails + Hotwire, Laravel + Livewire, ASP.NET Core | Leptos, Topcoat | equal-initial-state, disconnect, gap-detection, replay-or-resnapshot, no-duplicate-effects, final-keyed-state, bounded-slow-client, cleanup |
| Resilience and hardening (`hardening`) | ASP.NET Core, Spring Boot, Next.js (Pages Router), Django, Express | Gin + templ, Drogon, Topcoat | equal-legitimate-traffic, declared-deployment-budget, slow-headers-bodies-readers, connection-flood, oversized-requests, useful-service, recovery |
<!-- groups:end -->

## Implementation status

`registry.mjs` is the versioned selection and functional-work matrix. `evidence.mjs` keeps
every selected app/case visible as unknown, implemented or not implemented, with separate
parity and measurement states. Missing, unsupported and failed evidence is not zero throughput.
This ledger does not certify a feature: a runner must derive cells from its raw correctness
captures and validate its complete evidence before publishing comparative numbers.

The localized marketplace group is wired to the existing marketplace runner as an explicit
`--group localized-marketplace` selection. Its exact-image feature qualification and complete
browser/content gates remain mandatory. Candidates missing production parity stay in the
report with their missing features and are not timed. The existing scheduled `production`
selection and historical reservations are unchanged while native parity work is completed.

The catalog runner accepts `--group catalog-page` for page-only timing of the exact registry
selection in both sources, with its stronger native page and JSON correctness gates retained.
Its versioned group evidence binds checks and timing to each immutable image and verifies
after-run provenance and saved aggregates. This is a native runner integration, not a passing
group result or a cloud launcher; see the [catalog procedure](../catalog/README.md).

Remaining groups stay pending runner/adapter integration. Their presence in this registry is
not a claim that a new benchmark ran, that all native features exist, or that historical
measurements are interchangeable. The mixed and live contract modules are testable oracles,
not substitutes for native adapter implementation, browser captures or load evidence.

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

`hardening.mjs` validates `hardening-capture/v1` against a reviewed attack and legitimate
traffic plan. Functional parity is a prerequisite, while missing defenses, refused
connections, zero useful service, exhaustion and failure to recover stay visible as target
outcomes. Broken injection, invalid controls, corrupt evidence and failed cleanup invalidate
the apparatus instead. Direct and deployed-edge cases remain separate. Native process
topologies may differ, but all required processes must be inventoried and charged within
equivalent total budgets. Unavailable counters stay unavailable, never numeric zero.

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

Corten-only rendering/allocation/default-cost and TCP diagnostics remain separate from
competitive rankings. The distributed listings-feed run and failover test remain separate,
including all application, Postgres, NATS and edge resource costs. Single-application recovery
does not replace those diagnostics.

Implementation is tracked by
[#807 bench/fullstack has no tier where every app implements the same production features, so its tables mix framework cost with feature cost](https://github.com/corten-run/corten/issues/807)
and
[#817 A bench/fullstack round takes 5.5 hours, the planned tiers and repeats would take it past 15, and nothing sets which apps, phases and cadence each tier gets](https://github.com/corten-run/corten/issues/817).
