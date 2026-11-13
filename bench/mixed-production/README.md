# Native mixed production captures

`run.mjs` exports `async run(args)` and accepts an explicit, fresh local round (`wN`).
It executes the existing marketplace applications, not a shared renderer. It never runs a
cloud command, changes nightly state, publishes results, or edits an application. All nine
registry candidates and the retained measurement families remain in `summary.json`, including
when `--apps` selects a development subset. Missing images, missing responses, unsupported
forms, failed native operations and missing readback remain visible. They are not replacements
with easier requests.

## Run

### Read-only saved verification

The bounded [execution-evidence extension](PRODUCER-EVIDENCE.md#execution-lifecycle)
records and replays actual process limits and terminal OS cleanup observations.
Its additive `proof` requires mounted input snapshots, native response/probe replay,
independent audits and actual terminal OS observations. It is not a readiness flag.

`verify.mjs` exports `async validateSaved({ folder, round, commit })`. `folder` is an
existing local saved round, `round` is its explicit `wN` identity, and `commit` is the
full lowercase 40-digit native **and harness** commit available in the local Git
repository. Different harness/build commits are not silently treated as equivalent.
The fixed CLI, for an isolated collector to call after collection, is:

```sh
node bench/mixed-production/verify.mjs --folder <saved-round-folder> --round w91 --commit <full-commit>
```

It prints one JSON `mixed-native-saved-verification/v1` verdict to stdout: `verified`
(exit 0), `failed` (exit 1), or `blocked` (exit 2). Invalid CLI arguments exit 1.
There is no write, fix, collect, execute, publish or ranking option. The API returns
the same object, including `issues` (`kind`, `code`, `at`), every candidate's raw
functional cells/outcomes/reasons and replayed oracle, and any replayed measurement
cells/aggregates. `comparisonEligible` is always false for partial or blocked proof.
Diagnostics do not include arbitrary saved values or exception messages. Invalid
round/commit arguments are not copied into the verdict; both identities remain null
until their bounded syntax has been validated.

Verification binds the current complete registry inventory, fixture, effective plan,
configuration, clean source/harness identity, every tracked build input, exact Git
archives and image build labels. It replays the unchanged mixed oracle from each
individual request artifact, compares source/merged captures and cells, verifies the
existing independent native source-audit receipts when measurement is present, and
rederives saved calibration/steady metrics with `deriveWindow`. Resource streams and
their original Docker rows/boundaries, participant identities, final sealed ledgers,
pass counts and complete-group aggregates are checked rather than accepting summary
`passed`/`eligible` flags. Unexecuted/failed cells remain visible and cannot rank.
Every local executable dependency imported for replay, including transitive catalog
statistics, fixtures, registry and conformance helpers, is checked against the requested
commit. A loader-based regression checks that validation reads cover the complete
imported dependency set, excluding the trusted verifier entry point itself.

The verifier reads only saved files and fixed local Git objects. Git replacement
refs are disabled, blob bytes are checked against their actual object IDs, lazy
fetch is disabled, every transport protocol is denied and prompting is disabled.
Inherited Git config/repository/trace environment overrides are discarded; missing
local objects fail instead of fetching or modifying the object store. It never resolves
the saved external `nativeAudits`, image/readback mapping paths, launches a browser,
executes saved settings, runs Docker or calls a network service. It rejects links
(including linked ancestors and hard-linked files), path escapes/ambiguous Windows
paths (including mixed-slash UNC/device forms before any filesystem access),
duplicate JSON keys/references and case-colliding filenames. It hashes the
whole folder before and after replay; stable saved artifacts are a prerequisite,
not permission to modify them concurrently. Limits are 100,000 entries, 1 GiB total,
256 MiB per file/Git command output, 32 MiB per JSON and depth 64; Git calls time out
after 60 seconds. Exceeding a bound fails closed. No saved artifact is written.

**Historical v1 limit:** original functional and measurement captures without the
additive producer evidence cannot receive a positive complete saved-proof verdict.
Their native response bytes are represented by
hashes/lengths, a redacted DOM and normalized rows, but v1 does not retain enough
credential-safe original response evidence to independently reconstruct and bind
all normalized page, JSON and state facts. The normalized unchanged oracle is still
replayed and reported, but that alone cannot set the verifier's `functionalPassed`
or the affected cell's `passed`. Missing proof is blocked; contradictory facts
(such as a normalized nonempty page from an empty response or executed image/state
differing from the bound build) are invalid. Functional executed-container image,
running state, exit/OOM state and start time are checked separately from build labels.
Missing executed-container proof stays blocked instead of inheriting image labels.

The original v1 `qualify-worker.mjs` saves sanitized hashes/capability cells,
not the original headers/page/form probes required by `validateProbes` and
`qualification`. Hashes cannot rederive production qualification. The host also
does not bind the original ID-keyed cgroup reader responses or inspected
`RestartCount` into the v1 window receipt. The additive producer extension now
replays those original ID-bound sidecars. Missing sidecars yield explicit blocked reasons even when all available
metrics replay. Known hash-only qualification shapes remain blocked, but malformed
probe containers, hashes or unrecognized capability keys are invalid, not an excuse
to downgrade contradictions to unsupported proof. Window HTTP response counts must
equal the actual positive-status stage receipts, including redirects and independent
state reads. Host elapsed time, when retained, must be finite, nonnegative and cover
the window; its absence is blocked proof. Functional-only runs remain non-performance evidence. A blocked
verdict is not a native parity, CPU or source-audit success declaration.

The additive extension retains exact lock-integrity-checked tool archives and their
complete extracted file inventory, mounts them read-only beside the retained Git
archive, and binds actual inspected mount sources/modes. There is no dependency
download fallback. `MIXED_PRODUCTION_NPM_CACHE` can name an existing local npm cache.
Every archived file and every executable host input is checked against the commit;
a final host-input observation detects changes during collection.

Actual DOM query results replay the unchanged native snapshot; exact public JSON
response bytes replay record/state normalization. No expected markup or audit is
generated. Qualification replays the filtered actual probe journal through the
unchanged current contract. Original cgroup stdout, participant restart counts,
all raw resource samples and the stats client's actual OS close event are required
for extended measurement proof. Unknown credential/filter shapes remain blocked.

`attemptComplete` and `dispositions` distinguish complete evidence from target success.
A fully recorded rejecting gate may have `verdict: "verified"`, issue kind
`target-failed`, and the appropriate `recorded-failed` / `gated-not-run` dispositions.
Only downstream stages that the replayed rejecting gate forbids are gated not-run.
Missing raw observations, independent audits, interrupted captures and failed apparatus
are not waived. `functionalPassed` and `comparisonEligible` remain false for a
functional rejection; no failed or partial attempt can rank. A successful comparison
still requires every original functional, qualification, calibration, resource,
ledger and repeated-window gate, plus disjoint CPU placement. See
[producer evidence](PRODUCER-EVIDENCE.md) for the trust boundary and focused checks.

Present qualification slots must be either an artifact-backed outcome or the known
execution-failure variant; malformed slots are invalid, not `not-run`. Retained
hash-only probe facts must still obey exclusive response/failure variants and integer
body lengths. Window participants must have started before observation, and a retained
running state cannot have a nonzero exit code. Missing exit proof remains blocked.
Primary latency must fit its monotonic primary-start/finish span even when every saved
copy agrees. All retained HTTP step durations, including discovery, redirects and
readbacks, must fit the operation's real monotonic lifetime. Serial preparation work
must fit before primary start, and primary/redirect/readback work must fit after it;
these checks apply to warmup and measured cycles alike. Missing individual step
timestamps are not reconstructed from durations. Genuine unsent `dropped` rows retain
the unchanged oracle's failed outcome without requiring a primary receipt or becoming
invalid evidence.
Within each warmup or measured phase, complete cycles must be serial and each client's
requests must retain native plan order without overlapping. The two phases use separate
monotonic epochs. Retained qualification participants must agree with bound role/image,
running/exit/OOM state and resource/source configuration; missing participant proof is
blocked rather than supplied by a reported eligibility flag. Window slots are closed
variants: `not-run` and `failed` carry null metrics and no measurement artifact, while
measured/rejected outcomes require an artifact and matching metrics/statistics. Unknown
outcomes or artifact-less measured claims are invalid, not missing proof.
Derived qualification and its reconciled outcome are published together only after
the original probes, receipt and summary slot agree. A failed qualification gate
leaves null qualification and an invalid outcome, never a derived positive claim.

Run the complete saved-verifier regression suite independently of native collection:

```sh
node --test bench/mixed-production/verify.test.mjs
```

These tests use temporary saved files, coherent synthetic participant/window clocks,
and hostile mutations through the public API. They cover malformed qualification slots
and probe variants, participant lifetime/exit contradictions, physically impossible
latencies with matching dependent receipts/metrics, and recorded dropped outcomes.
They also cover changed replay executables, overlapping serial/client clocks,
qualification execution contradictions and malformed artifact-less window variants.
Qualification publication regressions cover all candidate/source gates, and HTTP
lifetime regressions cover each non-primary step, serial totals and warmup windows.
They are not native parity or performance measurements and do not remove v1 blockers.

Minimal collector/runner follow-up, outside this verifier repair: agree on a
credential-safe, replayable production-probe representation with the existing
qualification contract; retain original cgroup responses bound to participant IDs
at both boundaries, and full restart observations. Also retain credential-safe native
response/extraction evidence that independently binds normalized page/JSON/state
facts, without generating expected markup or trusting supplied success flags.
Producer checkpoint `77c3fe982` adds preliminary sidecars but is not consumed or
admitted by this v1 verifier; schema/acceptance extensions require separate review.
Do not persist session cookies
or CSRF values, manufacture missing observations, or relabel old v1 summaries as
fully verified. The existing native source audits remain independently required.

Install the root tooling dependencies first (`npm ci`). Docker runs the browser in the pinned
Playwright image from the root manifest. Tool images are resolved/pulled and their IDs saved.

```sh
# Automatically build each selected native application using its existing Dockerfile.
node bench/mixed-production/run.mjs w1 --build

# Reuse the existing cb-marketplace-<app> images, saving their resolved IDs/build labels.
node bench/mixed-production/run.mjs w2

# Build an immutable local native-port commit, without editing any application checkout.
node bench/mixed-production/run.mjs w4 --apps fastapi,django,spring --build --build-ref e8c23cf

# Full inventory only: native functional parity, production qualification, calibration,
# then three real equal-mix steady windows per source/candidate. No cloud action.
node bench/mixed-production/run.mjs w5 --build --measure --profile matched --passes 3 --duration 120 --warmup 15 --calibration 30

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

Automatic builds archive the resolved commit and send the retained, hashed context bytes
to Docker on stdin. Ignored/untracked files and uncommitted app changes are never build
inputs. Without `--build-ref`, this commit is HEAD; commit native app changes before a
fresh diagnostic build. The harness's own dirty status is still recorded separately.

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
Without `--measure`, the CLI leaves `readyForLoad: false`, `timingBlocked: true` and
`timing: null`: functional parity alone cannot authorize measurement. With `--measure`, the
additional observed gates and real windows below decide those fields, not a positive receipt
or image declaration. Functional operation clocks are diagnostic wall times only.
Exit status is nonzero for failed native
parity, infrastructure failures or cleanup failures. `complete` means all source capture loops
finished, not that the apps passed.

## Actual Mixed Load

The load implementation is separate from the functional-only runner foundation. `--measure`
requires fresh automatic builds, clean committed source/harness state, the entire retained
inventory, and at least two clients. `--profile defaults|matched` explicitly selects the native
configuration variant: its Docker build argument, actual `PROFILE` environment, image ID and
runtime budgets are recorded. Matched uses the existing native production connection budget,
not a replacement server. Neither variant is assumed feature-qualified; failed defaults are
not relabeled as a passing variant. There is no external positive qualification input.

Every candidate/source first runs the unchanged `bench/marketplace/qualify.mjs` production
HTTP probes on its real image/configuration, including errors, methods, compression, security,
CSRF/origin, body/header/connection bounds and recovery. Original probes are validated in
memory. Saved capability cells and native probe/body hashes omit cookies and hidden secrets.
Every candidate/source must pass; no successful subset is measured.

Calibration and steady windows execute the shared plan, not k6's older item-page mix. Each
cycle has exactly the original source subplan (22 fixture or 31 API primary operations for the
default plan), all locales, listings, numeric JSON, accepted/rejected writes/readbacks and all
API slow variants. Clients run concurrently; each client's request order stays unchanged.
Every cycle uses fresh native cookie contexts, without a reset endpoint or reconstructed
state. Repeated source cycles are independent equal-plan cohorts. App/source containers are
fresh for each calibration or pass; the warmup runs on that same live app before its counters
and measured window begin.

The path-scoped injector observes actual native upstream work concurrently. It never forwards
benchmark IDs through an app. If a plan assigns two operations the same native record path,
the load phase refuses ambiguous attribution rather than changing the seed/plan or filling
expected counters. A prior pending read cannot be reassigned to another operation. Orphan
fetches, cached work, failed cancellation and any loaded semantic failure reject the window.
Every complete cycle is checked by the unchanged mixed oracle. Expensive oracle checks are
outside individual primary HTTP latency observations, never a substitute for real responses.

Defaults are three passes, a 15-second native warmup, a 30-second calibration and 120-second
steady admission window, with at most 16 complete cycles and 120 seconds to drain the last
cycle. `--passes`, `--duration`, `--warmup`, `--calibration`, `--tail-seconds` and `--max-cycles`
are explicitly bounded. A cycle budget exhausted before the window ends is a failure, not an
invented offered rate. All attempted operations and draining work remain in raw evidence.
Rates count actual complete-cycle operations over actual elapsed time including drain, so the
reported mix stays exact. Primary HTTP latency and full client journey latency are separate;
the latter includes native discovery, CSRF, readbacks, parsing and observation overhead.

The existing cgroup v2 reader supplies CPU before/after deltas for app, injector and generator;
the existing Docker stats sampler supplies timestamped CPU/memory samples. Missing or
backwards counters, stopped/restarted/OOM participants and missing memory samples fail closed.
Failed cleanup also blocks admission; a prior participant is never silently left running
while the next candidate is timed.
The shared sampler timestamps receipt, not the daemon's sampling clock. Buffered samples can
share a timestamp; the metrics preserve and count collisions, require an observed clock span
and reject backwards clocks rather than inventing sample spacing.
Generator and upstream CPU must stay below 70% of their quotas, with generator event-loop
p99 delay at most 20 ms. A steady window needs three complete equal-mix cycles and at most
25% drain. These declared calibration checks expose generator/upstream limitations; they do
not prove saturation or turn observed throughput into capacity.

`MIXED_PRODUCTION_APP_CPUS`, `MIXED_PRODUCTION_LOAD_CPUS` and
`MIXED_PRODUCTION_API_CPUS` reuse existing disjoint CPU-set validation (quotas 1/4/2). Without
explicit placement, observations stay diagnostic and `comparisonEligible` stays false.
CPU-headroom denominators honor the smaller of quota and explicit CPU-set width, never the
nominal quota alone when placement is narrower.
Three or more complete passes and every observed gate are required for comparison eligibility.
Explicit placement still does not establish an otherwise quiet or dedicated host. Do not
publish comparative throughput claims from a concurrently loaded workstation.

`measurement/` retains qualification, calibration, warmup, every raw request/cycle, window
clock, source/image/runtime identities, cgroup counters, Docker samples and failure cells.
Schemas are `mixed-native-measurement/v1`, `mixed-native-window/v1`,
`mixed-native-window-receipt/v1` and `mixed-native-metrics/v1`. Aggregates are measured pass
medians/ranges, not oracle rates. Native failed cells keep timing blocked; the implementation
does not set readiness merely because the functional oracle accepted a capture.

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

Immutable native-port builds subsequently exercised both sources from the original source
revisions recorded in their raw captures. The corresponding Python/Java and ASP.NET/Express
changes were imported here as `5858ddcc8` and `a50ef5283`; these import commits are not the
captures' measured identities. Each completed candidate passed 47/53
cells, including all 18 real accepted/rejected POSTs and their independent native store
reads. Their remaining cells were cancellation/deadline failures, not missing readback.
FastAPI returned 502 and Django 500 on native deadline; Spring, ASP.NET and Express still
reached the shorter diagnostic client deadline. The Corten build in that same native-port round exceeded
the bounded native build window and stayed image-unavailable, not unsupported. These are
functional observations of those exact commits, not production qualification or proof of
all storage invariants. Later native fixes must be rebuilt and rechecked.

Compiled-port round `w11`, whose native changes were imported as `f96868119`, observed Gin 50/53 and Drogon 47/53,
including all 18 native POST/readback cases per app. Gin cancelled upstream correctly but
returned 502 for all three native deadlines. Drogon left upstream work pending after abort
and returned 200 after all three 40-second deadline holds. Topcoat exceeded the bounded
build window and remained image-unavailable. No candidate was dropped or timed as qualified.
