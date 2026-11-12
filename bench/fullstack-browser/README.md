# Native full-stack browser journeys

`run.mjs` executes the `fullstack-browser` registry group in local Playwright Chromium
against real, immutable Docker images. It never renders an application page. The shared
`bench/workloads/browser.mjs` supplies the effective journey plan, not captured answers.
All ten candidates and all 24 source/locale/device/JS profiles remain in the saved matrix,
including unsupported, failed and not-run cells. No cloud, collector, nightly-state or
publishing integration is present.

## Run

Install the root tooling dependencies and Playwright Chromium using the repository's existing
setup. Have `node:24-bookworm-slim` available locally. `--build` builds the approved native
marketplace images using their existing Dockerfiles; alternatively `--targets` selects
already-built local images. Execution never implicitly pulls an application image.
Each native app gets one CPU, 1 GiB memory and
a fresh container/store per case. The independent numeric upstream gets one CPU and 256 MiB.
The browser runs on the host, outside that budget; these are development diagnostics, not
isolated performance measurements.

The complete-group invocation needs no manually prepared targets or receipts:

```sh
node bench/fullstack-browser/run.mjs w1 --build --out bench/fullstack-browser/work/w1
```

Builds preserve the native implementation: the root-context marketplace Corten Dockerfile,
SvelteKit's marketplace Dockerfile, and each other contender's existing app Dockerfile.
They do not turn Blade into Livewire or remove Rails' Turbo opt-out. Each build automatically
records the actual checkout commit, dirty state and source snapshot, checks that the source
did not change during the build, saves the build log and runs the resolved immutable image.
Run-unique image tags never replace the existing marketplace/collector tags. Owned final
images are removed after execution; shared BuildKit caches are not pruned. A dirty build is
usable for diagnostics but cannot establish clean source provenance. These native image
builds use the existing specialized benchmark infrastructure, not workspace Rust validation.

For existing images or an independent native readback path, use a targets JSON with this shape:

```json
{
  "schema": "native-fullstack-browser-targets/v1",
  "targets": {
    "nextjs": { "image": "cb-marketplace-nextjs" },
    "rails": { "image": "cb-marketplace-rails" },
    "laravel": { "image": "cb-marketplace-laravel" }
  }
}
```

```sh
node --test bench/fullstack-browser/runner.test.mjs bench/fullstack-browser/browser.test.mjs
node bench/fullstack-browser/run.mjs w2 --targets bench/fullstack-browser/work/targets.json --out bench/fullstack-browser/work/w2
node bench/fullstack-browser/run.mjs w3 --build --out bench/fullstack-browser/work/w3 --apps nextjs --cases fixture-en-US-desktop-js,api-fr-FR-mobile-no-js
```

The explicit development round is `wN`; official/nightly rounds are not accepted. Every
output directory must be new; missing parents are created. `--apps` and `--cases` bound
development execution, not group membership. Missing images are failed cells; unconfigured
or unselected cells stay not-run. No retry is applied to a browser action, failed form or
startup deadline. An unavailable/failed/incomplete qualification exits nonzero while retaining
the raw observations. The importable interface is `await run(args)` from `run.mjs`, where
`args` is the CLI argument array including the round. It returns the saved summary.

SvelteKit's existing marketplace build fixes its request/CSRF origin to `127.0.0.1:8080`.
Its cases therefore publish on that loopback port, while other apps use random loopback ports.
A port collision is a failed start, not a reason to disable native CSRF checks or rewrite Origin.

## Observations

The summary schema is `native-fullstack-browser/v1`. It retains the complete effective
`browser-journey-plan/v1`, settings, exact fixture hash, immutable image IDs/digests,
source-commit labels (or explicitly unavailable), runner-file hashes, checkout commit/dirty
state, Chromium executable hash/version, Playwright version, and container identity and
restart checks before/after each journey. An image tag is resolved once; execution uses its
immutable ID. A tag alone never establishes which source built it. Clean matching
`run.corten.marketplace.commit`/`.dirty` or `run.corten.browser.commit`/`.dirty` labels
are necessary for image/source correspondence, not proof of native feature parity.

Each step retains its dispatched action, independently extracted visible page, form binding
discovered before submission, request method/public path/query/transport/status/input,
component IDs, page errors, failed/unfinished requests, upstream start/completion/cancellation
events, readback and failures. Full request bodies, cookies, headers and transport secrets
are not saved. Only `email` and `target_price` are extracted from submitted bodies, using
platform URL-encoded/multipart parsing or observed Livewire snapshots/updates. External-origin
browser traffic is blocked, not replaced with local code; any resulting request failure is
retained as a failure. CSRF fields and session state stay native and in memory.

The initial response is parsed again in a separate script-disabled browser context from its
actual response bytes. This is independent SSR extraction, not a reference renderer. That
parser blocks resources and does not certify CSS parity. Initial and post-action DOM are
compared offline with the existing marketplace oracle. Controls/links dispatch through the
native app. Initial/reset/missing/return are address navigations; the linked journey step
clicks the actual contents link, filtering/sorting submit native GET forms, show-all clicks
the native link, and writes click the discovered POST form. Only HTML email validation is
disabled for the invalid-email server-validation case, as in the existing marketplace gate.

Desktop is 1440x1000, no throttling. Mobile is 390x844, 4x CPU slowdown, 150 ms RTT,
1.6 Mbps download and 750 Kbps upload (the historical profile's binary-unit convention).
Both block service workers and disable cache, including across the journey. Readiness means
visible/enabled native controls after load, not an app-supplied hydration timestamp. Recorded
action times are host-observed dispatch/first semantic DOM change/settled upper bounds,
including automation overhead; settled observations include Chromium's 500 ms network-idle
interval. Arrival starts at `about:blank`, not the historical cross-site start profile;
COOP process switching is not controlled. These are not precise paint or hydration measurements.
Request byte observations
include HTML/CSS/JS/WASM/data, encoded body sizes, decoded body lengths and Playwright's
HTTP header-size estimates, not TLS/link-layer bytes. Failures retain null/unavailable sizes,
not invented zeroes. No throughput or framework speed ranking is produced.

JS-disabled script preloads use the existing native gate's strict intentional-disable
classification only when the observed preload matches and no native CSP is present.
The original failure and unavailable byte counts remain recorded. Other request failures,
including real CSP failures and JS-enabled failures, still fail the action.

## Qualification Gaps

The implementation performs native work even when a capability is missing. A DOM success
message is never independent write evidence. An app with a real native alert store may
configure `"readback": { "path": "/its-independent-store-read" }`; this must be a read-only,
uncached native store endpoint returning `[{"item_id":"item_2","email":"...","target_minor":125}]`
(an `{"alerts":[...]}` envelope is also accepted).
The path is not invented by the runner, may not be the form response, and is read separately
before the journey and after every accepted/rejected write through the browser context's
`context.request`, sharing its cookie jar but not its DOM/POST response. Fresh case stores must start
empty, contain exactly one accepted alert afterwards and remain unchanged by rejections.
With `--build` and no custom manifest, Corten uses the separately owned `/api/alerts` native
port; a missing port is a captured HTTP readback failure. No handler is modified here.
At the base commit, Corten, Next Pages,
Rails and Laravel marketplace handlers format success text without a persistent alert store;
these cells fail write/readback qualification until native stores and independent reads exist.

Laravel's current marketplace is Blade, not a Livewire component. Loading Livewire in its
layout does not qualify it. Qualification needs actual `wire:id`/`wire:submit` bindings and
observed component update POSTs. Rails needs real Turbo presence and Turbo navigation/form
requests; a plain controller document is not substituted for Hotwire. Architecture disclosure
uses observed page/runtime markers and requests, not the inventory's historical labels.
Unrecognized markers stay explicitly unverified.

Adapter work to dispatch after the runner is integrated:

1. Corten's `/api/alerts` array/session persistence port is owned by a separate lane. Rebuild
   its exact merged image and exercise the same-context independent read; do not borrow another
   checkout's successful capture.
2. Next Pages, Nuxt, React Router, SvelteKit, Astro, TanStack Start and Leptos need native
   session-isolated alert persistence and an independent read. Current handlers/actions pass
   form values into message formatting, not a durable/native alert state. Implement validation
   and mutation in each native server action/handler, not a shared renderer or client success flag.
3. Rails needs its marketplace `data-turbo="false"` opt-out removed and real Turbo-compatible
   forms/navigation (including success redirect/stream and validation handling), plus its native
   store/readback. The sampled image also returns an empty missing-item page, not a visible error.
4. Laravel needs a real marketplace Livewire component and update bindings, preserving the native
   no-JS form fallback and CSRF, plus a native store/readback. Its layout's Livewire script alone
   is insufficient.
5. Every candidate needs trustworthy retired-page resource ownership and a bounded event probe;
   destroying a whole browser context is not proof that native page replacement cleaned itself up.

Owned contexts are closed and closure is observed; owned Docker containers, anonymous volumes
and networks are removed with ownership checks in `finally`, including interruption/failure.
Native retired-page listener/timer/subscription ownership and retired-event probes are **not**
available in the current adapters. Those counts are null with a reason, never fabricated zeroes.
Consequently this runner currently cannot produce a fully qualified shared
`browser-journey-capture/v1`: `qualificationPassed` and `readyForLoad` remain false. A separate
raw schema preserves real partial evidence rather than laundering it through the offline
oracle. Native page-scope instrumentation and its bounded probe remain integration work.

Other limits: Chromium only; no repeated/rotated timing passes, changed-input output-cache
probes, load or production-HTTP qualification. React Router's intermittent historical native
form failure is unresolved; this driver adds no retry or timeout increase to hide it. Check
the per-case `formBefore`, DOM/error, request and failure observations to identify the exact
failing submission. All retained benchmark families are listed explicitly as not-run in this
new group, not removed or relabeled from their historical workloads. Unit-test stubs are
apparatus tests only, never native parity results. Repository-wide checks and independent
review remain the parent's responsibility because this lane owns only this directory and
does not spawn agents.
