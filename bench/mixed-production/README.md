# Native mixed production captures

`run.mjs` exports `async run(args)` and accepts an explicit, fresh local round (`wN`).
It executes the existing marketplace applications, not a shared renderer. It never runs a
cloud command, changes nightly state, publishes results, or edits an application. All nine
registry candidates and the retained measurement families remain in `summary.json`, including
when `--apps` selects a development subset. Missing images, missing responses, unsupported
forms, failed native operations and missing readback remain visible. They are not replacements
with easier requests.

## Run

Install the root tooling dependencies first (`npm ci`). Docker runs the browser in the pinned
Playwright image from the root manifest. Tool images are resolved/pulled and their IDs saved.

```sh
# Automatically build each selected native application using its existing Dockerfile.
node bench/mixed-production/run.mjs w1 --build

# Reuse the existing cb-marketplace-<app> images, saving their resolved IDs/build labels.
node bench/mixed-production/run.mjs w2

# Build an immutable local native-port commit, without editing any application checkout.
node bench/mixed-production/run.mjs w4 --apps fastapi,django,spring --build --build-ref e8c23cf

# Bounded diagnostic, not a deadline qualification or a throughput measurement.
node bench/mixed-production/run.mjs w3 --apps corten,express --build --request-timeout-ms 1200 --complete-delay-ms 30 --slow-delay-ms 2500 --cancel-after-ms 30 --cleanup-ms 150 --startup-timeout-ms 15000

node --test bench/mixed-production/*.test.mjs
```

The browser transport test also needs `MIXED_BROWSER_TESTS=1` and the matching installed
Chromium (or the matching Playwright container). It exercises real cookies, CSRF hidden fields,
opaque native actions, repeated fields, independent store reads and an actual HTTP abort. Its
small HTTP fixture is a transport test only, never native app parity evidence. Other hostile
tests deliberately construct invalid oracle inputs; those are not app captures either.

`--build` uses unique run-owned image tags, the current checkout and each app's existing build
context. Corten uses `bench/marketplace/corten/Dockerfile`; the others use
`bench/fullstack/apps/<app>/Dockerfile`. These benchmark apps are outside the Rust workspace
and keep their existing specialized image builds. Build output, commit and dirty state are
saved. Build failures do not drop candidates. The runner removes its built image tags after
capture and never replaces the shared marketplace tags. Default/reused images may be stale:
their labels and IDs are evidence of what actually ran, not proof they match the checkout.

`--build-ref <7-to-40-digit-local-commit-hash>` requires `--build`. It archives that exact local
commit into the round's `build-source/`, builds its unchanged native Dockerfiles and records
the resolved commit, tree and archive hash separately from harness provenance. It never
checks out, cherry-picks or edits another lane's application files. No hidden image/source
filter, qualification declaration or oracle change is implied. All nine candidates remain in
the summary even for an explicit development `--apps` subset.

Additional value options: `--seed` (default 42), `--clients` (2), `--repetitions` (1), and the
timeouts shown above. Defaults reuse the legacy mixed driver's 40-second stalled upstream,
with a 60-second client timeout, 100-ms slow completion, 50-ms abort after upstream observation,
500-ms cleanup observation and 120-second startup limit. Short client deadlines cannot qualify
longer native server deadlines. Keep the client timeout and upstream delay beyond the native
deadline under test; the defaults exceed 30 seconds. All limits are bounded. Quotas are one
CPU/1 GiB per app, two CPUs/512 MiB per injector and two CPUs/1 GiB per capture worker;
apps/sources execute serially. These are
resource limits, not isolated CPU placement or calibrated load.

Optional `--images <json>` maps native app names to image references for diagnosis and cannot
be combined with `--build`. Optional `--readbacks <json>` maps app names to different existing
native readback paths. Neither option supplies successful evidence or bypasses a gate. The
automatic binding is `/api/alerts` for every candidate, including apps where it returns 404.
No configuration declares that a store exists or that an adapter passes.

## Native Contract

Every repetition uses the unchanged `bench/workloads/mixed.mjs` effective plan: 53 primary
operations, both sources, three page locales, numeric JSON, listing sorts/prefix filtering,
accepted/rejected localized writes, slow completion, server deadline and client cancellation.
Requests are serialized in plan order, satisfying the per-source/client ordering rule. A new
app container per source and a new browser/API cookie context per client isolate state.

The worker discovers the actual POST form and keeps native cookies, hidden/CSRF fields,
submitter fields, action query and encoding in memory. It sends the planned input through that
form's native HTTP transport, without disabling app protections. Redirects remain additional
visible work. JavaScript is off: this driver verifies the native no-JS HTTP path, not enhanced
browser behavior. It extracts the actual native HTML with the existing marketplace DOM
extractor. The document is fulfilled from the captured native response without another primary
fetch; native stylesheets can load, scripts cannot run. This parsing is not a CSP/security or
full marketplace browser qualification.

Independent readback is `GET /api/alerts`, HTTP 200 with `Content-Type: application/json`,
returning a bare, insertion-ordered array:

```json
[{"item_id":"item_1","email":"mixed-client@example.test","target_minor":125}]
```

Every object has exactly those three fields, with an integral positive USD minor amount.
The native application owns the store, locale parsing and validation. The runner never creates
an alert from expected inputs or from the confirmation message. Readback uses the same cookie
jar as discovery and POST. Three separate GETs capture `before`, `after`, and `readback`;
`readback.via = "independent-read"` describes the observed additional GET, not the POST echo.
The first state in each `(source, client)` is `[]`; accepted writes append exactly once and
rejected writes preserve it. No retries, resets, client-side sorting or state reconstruction.

The private authenticated injector records each actual upstream request, path, completion,
disconnect and pending work. Prep/state reads have separate operation IDs. Primary counters
include native redirect work, not preparation/readback. Cancellation explicitly aborts a real
HTTP request only after the upstream has observed the app's fetch. The injector never destroys
held work to manufacture a cancellation counter. A client abort with a still-running upstream
fails parity, even if cleanup later removes the app container.

## Evidence And Gates

Results are atomically reserved under `results/<round>/`, never overwritten:

- `summary.json`: `mixed-native-run/v1`, complete inventory, every request cell, native image
  IDs/build provenance, host/tool settings, shared-contract/harness hashes, oracle verdicts,
  source container states, readiness probe status/body hashes, failures and cleanup outcomes.
- `plan.json`, `marketplace.json`: complete unchanged effective plan and numeric input fixture.
- `<app>/<source>/request_<n>.json`: durable primary-start marker, then actual normalized row,
  decoded native body hash/size, status/encoding/allowlisted headers, redacted native DOM,
  extraction, upstream events, state reads and individual oracle check. Cookies, hidden token
  values, action-query secrets and arbitrary exception/native error bodies are not persisted.
- `<app>/<source>/settings.json`, `capture.json` and `<app>-capture.json`: source settings,
  actual captures and merged `mixed-results/v1` oracle input. Interrupted workers retain saved
  attempts and explicit missing cells. Invalid attempted evidence remains invalid; it is not
  rewritten into an unsupported unsent row to get a valid oracle document.

`validateResults` runs on the real merged capture. Isolated cell checks use only that cell and
real preceding state transitions, with other cells explicitly unsupported, to expose independent
read results even when a different write lacks state evidence. `afterFunctionalGate` blocks
any measurement callback unless every selected registry candidate passes the complete oracle.
The CLI additionally leaves `readyForLoad: false`, `timingBlocked: true` and `timing: null`:
production HTTP qualification/native-work audit and calibrated load are not supplied here.
Raw operation clocks are diagnostic wall times only. Exit status is nonzero for failed native
parity, infrastructure failures or cleanup failures. `complete` means all source capture loops
finished, not that the apps passed.

## Native Ports Needed

At the base `921cd8422d4293863981546ced30da5c2e256cf6`, the nine actions below calculate a
message and render it; none implements the required persistent session alert store/readback.
Real runner captures, not this source inspection, decide each saved failure cell. A route
mapping alone cannot fix these gaps. Implement the native store in each app, not in this runner:

| App | Native action to extend | Native readback/store work |
|---|---|---|
| Corten | `bench/marketplace/corten/src/main.rs:create_alert` | App-owned synchronized alert state, opaque session cookie, typed `/api/alerts` route. |
| ASP.NET | `bench/fullstack/apps/aspnet/Pages/Marketplace.cshtml.cs:Render` | Persist validated minor amounts in native session/store; JSON readback handler with same session. |
| Spring | `bench/fullstack/apps/spring/src/main/java/bench/itempage/MarketplaceController.java:show` | Session-backed accepted alerts and JSON `/api/alerts` controller; preserve CSRF and locale parsing. |
| Django | `bench/fullstack/apps/django/itempage/marketplace_views.py:show` | Native session-backed alerts plus JSON GET route and URL binding; preserve CSRF. |
| Express | `bench/fullstack/apps/express/server.mjs:marketplace` | Native session/store, accepted minor-unit persistence and JSON GET route; preserve origin rejection. |
| FastAPI | `bench/fullstack/apps/fastapi/app/main.py:marketplace` | Native session/store and JSON GET route; commit only after validated numeric input. |
| Topcoat | `bench/fullstack/apps/topcoat/src/marketplace_view.rs:marketplace_page` | Native session/store, POST persistence and registered JSON readback route. |
| Gin | `bench/fullstack/apps/gin/marketplace.go:routes` | Native session/store and GET handler; retain request context and same-origin write check. |
| Drogon | `bench/fullstack/apps/drogon/src/marketplace.cc:routes` | Native session/store plus GET handler; retain origin check and native async fetch lifecycle. |

For every port, missing records, invalid email/price and cross-site writes must not mutate
state; separate sessions must not share it. Independently test those invariants in the app.
Cancellation propagation and native deadlines also need app-local fixes wherever the injector
captures completion/pending work after client abort, or a response inconsistent with the
deadline contract. Do not change the oracle, relabel a timeout as a deadline, shorten native
timeouts only for a passing capture, or replace native work with runner-side behavior.

Local native diagnostics retained all 477 inventory cells. Cached-image round `w3` reached all
nine candidates; Spring needed the longer startup window in `w6`, and Django's two short-bound
preparation misses completed in `w8`. Every candidate's actual `/api/alerts` probes returned
404. Each completed candidate exercised 53 primary operations and 18 real POSTs, not a
readback declaration. These runs precede the separately owned Corten/ASP.NET/Express store
ports and do not certify those changes. Fresh Express `--build` round `w4` also exercised both
sources and removed its owned image tag.

The cancellation captures disconnected the upstream for Corten, Topcoat and Gin. ASP.NET,
Spring, Django, Express, FastAPI and Drogon still had pending upstream work at the cleanup
observation bound. Concrete native seams to extend are ASP.NET `MarketplaceSource.Get` and
its page callers (request cancellation token), Spring `MarketplaceSource.get` (blocking
client lifecycle), Django `MarketplaceSource.get` (blocking `requests` lifecycle), Express
`server.mjs:marketplace` (pass the native disconnect signal to `fetchMarketplaceRecord`),
FastAPI `main.py:marketplace` (disconnect-aware async fetch lifecycle), and Drogon
`marketplace.cc:get`/page route (use its native cancellable HTTP infrastructure rather than
the legacy callback fetch).

The short diagnostic deadline cells are client timeouts, not native deadline proof. Longer
Corten round `w7` observed three real native deadline responses: HTTP 500, with upstream
cancelled and no pending work. They still fail the existing deadline response contract.
`bench/marketplace/corten/src/source.rs:record` currently propagates the upstream timeout as
an ordinary error; native deadline status mapping needs an app-local fix, not a runner-side
reclassification. No capture authorizes load or supplies throughput evidence.
