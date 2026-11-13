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
node --test bench/fullstack-browser/runner.test.mjs bench/fullstack-browser/transports.test.mjs bench/fullstack-browser/browser.test.mjs
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
Semantic DOM polling runs on the host, without eval or CSP changes. Document replacement
while sampling is retained in `observerTransitions`; only read-only observation continues,
within the original action deadline. Actions and forms are never redispatched.

Livewire input normalization binds the named HTML fields to their actual `wire:model` values
and enclosing component ID before dispatch. It does not assume that `target_price` is the
native state-property name. An absolute update URI is reduced to a pathname only when its
origin matches the document. Next's custom React enhancement is discovered from the mounted
form's real `onSubmit`, owning fiber props and containing component function before dispatch.
`bindings.mjs` uses the already-installed TypeScript parser to resolve only a single supported
native POST expression, without invoking that function or evaluating its source. Unresolved,
shadowed, cross-origin or mismatched bindings remain failures. Source hashes and public native
props establish the receipt; a sent POST is not used to invent a positive binding.

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
Every target defaults to `/api/alerts`; a manifest can select a different independent native
path. A missing port is a captured HTTP readback failure, never an empty store. No handler is
modified here. The separate native dependency commits now supply session stores for Corten,
Next Pages, Nuxt, React Router, SvelteKit, Astro, TanStack Start, Rails and Laravel. Leptos still
needs that port. Native dependencies are retained as separate commits, not copied into this
directory or included in its owned patches.

Loading Livewire in a Laravel layout does not qualify it. Qualification needs actual `wire:id`/`wire:submit` bindings and
observed component update POSTs. Rails needs real Turbo presence and Turbo navigation/form
requests; a plain controller document is not substituted for Hotwire. Architecture disclosure
uses observed page/runtime markers and requests, not the inventory's historical labels.
The independent SSR parse also retains native markers, including bootstrap scripts that
hydration may remove; Astro's emitted ClientRouter module is an observed native marker.
Unrecognized markers stay explicitly unverified.

`mutationProbes` captures separate real HTTP POSTs through the same cookie jar after the
journey: a foreign Origin, cross-site Fetch Metadata, and a missing record. It discovers the
ordinary native form action and preserves its native hidden fields/CSRF in memory. Every
attempt is followed by independent store readback, even when the rejection status is wrong.
For Rails' action-bound CSRF forms, the native layout's generic CSRF token is sent as its
native header so the missing-record request reaches the handler rather than failing the
wrong action's token check. Tokens are never saved. Rails' native Origin rejection may be 422;
the missing-record check still requires 404 and every rejection must leave the store unchanged.
A separate browser context must still read an empty store. These protocol probes do not
claim to test browser SameSite-cookie enforcement or substitute for enhanced native forms.

`functionalChecksPassed` separates actual DOM/navigation/form/input/readback/rejection/isolation
checks from lifecycle observations. Nonzero retired resources still fail the cell and are
retained in `lifecycleFailures`; a functional pass is never a cleanup or measurement pass.

`navigation.mjs` recognizes SvelteKit's physical `.../item_N/__data.json` only for a successful
JS-enabled native router fetch with an observed JSON `type:data`/data-node envelope and the
matching architecture. Wrong locale/item/transport/content/status/payload remains wrong.
The physical path and body hash remain in the raw ledger. Its exported
`normalizeSvelteKitCase` is the shared oracle's clone-only normalization hook, not a changed
gate or document fallback. No shared workload file is edited.

React Router Single Fetch is recognized from the mounted native `Form`, its owning React
fiber, the native route manifest and the observed `text/x-script` pooled envelope. Action
`data` and loader route envelopes are checked separately; physical `.data` URLs remain in
the ledger. `normalizeReactRouterCase` provides a clone-only oracle hook and refuses failed
or unfinished requests. A 404 status is captured independently from the visible error page;
an empty native 404 body still fails the visible-error check.

Next's mounted React handler is read independently before submission. Nuxt's mounted Vue
invoker and TanStack's mounted React handler are followed through bounded CDP lexical-scope
reads, not called. The supported native URL expressions or public native server-function
URL must bind the destination before the observed POST. Only source hashes, selected route
fields and endpoint receipts are saved; raw scopes, handler source and tokens are not.
Unsupported bindings fail closed instead of guessing from the subsequent POST.

Actions wait for actual observed request completion and, with JS enabled, a real animation
frame within the original action deadline. An interim cleared status message is not a settled
render. Late requests are checked again before each step's snapshot. Body-capture failures
retain their request-local error, and the final request ledger retains late completion or
failure evidence. CDP frame/loader facts distinguish observed document-replacement
cancellations from other native failures where identity is unambiguous; these annotations
do not waive failed requests, supply missing bytes, retry an action or increase its timeout.

`resources.mjs` installs observers before native scripts and records native add/remove/once/
abort listener lifetimes, timeouts/intervals/animation/idle callbacks, native DOM observers,
fetch/XHR/microtask work and EventSource/WebSocket/worker connections. DOM roots receive
observer-owned identities; callback-created work inherits the observed target's scope.
Global resources without provable ownership remain explicitly unattributed and prevent
qualification. Native framework subscription internals and arbitrary Promise continuations
are not claimed to be enumerated. Known Playwright hit-target/removal-detection registrations
are retained separately with their observed `InjectedScript` call stacks, not charged to apps.

Cleanup clicks the app's real header link away, without forcing unmount, deleting native DOM,
clearing timers/listeners, or closing connections. For a same-realm retired root it dispatches
the actual registered event types (default action prevented) plus a retired-page event, then
observes resource counts, real DOM hashes, requests and errors for the bounded interval.
Native document-realm replacement is also captured through CDP. A destroyed realm cannot
supply a fresh retired-DOM read/probe, so those counts stay null and the profile remains
unsupported under the current strict oracle. There is no automatic platform-destruction
waiver. Opaque global ownership similarly needs native lifecycle attribution before full
qualification; a browser context closing is not that proof.

Owned contexts are closed and closure is observed; owned Docker containers, anonymous volumes
and networks are removed with ownership checks in `finally`, including interruption/failure.
The raw schema preserves partial evidence. Full `browser-journey-capture/v1` qualification
still needs complete native dependencies, attributable retirement/probe evidence and the
complete matrix. `readyForLoad` remains false; this workstation run never certifies load.

Other limits: Chromium only; no repeated/rotated timing passes, changed-input output-cache
probes, load or production-HTTP qualification. React Router's intermittent historical native
form failure is unresolved; this driver adds no retry or timeout increase to hide it. Check
the per-case `formBefore`, DOM/error, request and failure observations to identify the exact
failing submission. All retained benchmark families are listed explicitly as not-run in this
new group, not removed or relabeled from their historical workloads. Unit-test stubs are
apparatus tests only, never native parity results. Repository-wide checks and independent
review remain the parent's responsibility because this lane owns only this directory and
does not spawn agents.
