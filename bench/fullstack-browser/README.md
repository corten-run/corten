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
node --test bench/fullstack-browser/*.test.mjs
node bench/fullstack-browser/run.mjs w2 --targets bench/fullstack-browser/work/targets.json --out bench/fullstack-browser/work/w2
node bench/fullstack-browser/run.mjs w3 --build --out bench/fullstack-browser/work/w3 --apps nextjs --cases fixture-en-US-desktop-js,api-fr-FR-mobile-no-js
```

Apparatus cleanup fixtures await their real cleanup response body before retiring the root;
retirement is not a network-idle promise. The observer takes a fresh resource snapshot after
observing detachment, and still rejects an unowned in-flight request at that boundary.
The ledger apparatus test retains full failed cleanup snapshots in `work/diagnostics/`.

The explicit development round is `wN`; official/nightly rounds are not accepted. Every
output directory must be new; missing parents are created. `--apps` and `--cases` bound
development execution, not group membership. Missing images are failed cells; unconfigured
or unselected cells stay not-run. No retry is applied to a browser action, failed form or
startup deadline. An unavailable/failed/incomplete qualification exits nonzero while retaining
the raw observations. The importable interface is `await run(args)` from `run.mjs`, where
`args` is the CLI argument array including the round. It returns the saved summary.

Group `qualificationPassed` is recomputed after cleanup and strict capture export: all ten
candidates and all 24 profiles must have qualified native evidence and matching passing
unchanged-oracle results, with clean matching image provenance and no run/cleanup failures.
Completing a selected subset, exporting unsupported captures or closing a browser context
does not qualify the group. `readyForLoad` remains false even if journey qualification passes.

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
shadowed, cross-origin or mismatched bindings remain failures. A sent POST is not used to invent
a positive binding. Function text and sampled props alone do not prove imported helper effects.

The Next observation additionally requires `native-binding-code/v1`: exact public emitted script
bytes extracted from the stopped immutable image, with image/source identity and content hashes.
`binding-image.mjs` only copies those bytes; it does not execute an image or rebuild its code.
`binding-links.mjs` records CDP function locations, exact executed-script correspondence and
descriptor-only native lexical edges. Arbitrary getters, proxies, bound functions, foreign/evaluated
scripts and unavailable links remain unknown. The emitted static export getter is resolved by
its exact body, native scope descriptors and own data field without invoking it. Candidate/helper functions are never called by
discovery. Harness-authored reference equality compares identities. Array allocation checks also
use the document-start native descriptor intrinsic, without invoking an application accessor.
The array constructor, species getter, iterator and iterator completion chain must retain their
native identities; checking `slice` alone cannot prove allocation/destructuring effects. Every supported transport intrinsic used by the mounted
handler must resolve through its actual lexical scope to the captured native intrinsic, not an
imported same-name function.

`binding-effects.mjs` checks the linked component's declarations and entire render expression,
including all prop/child siblings, operands, branches and invoked local callbacks. Calls must
resolve to artifact bodies or document-start identity-checked platform operations. Imported
function edges must also match the emitted import/export declaration. There are no app-helper
name or caller-supplied purity exceptions. Borrowed data needs plain own descriptors; writes,
retention through unmodeled calls, unknown coercions/getters and escaping render callbacks block
the proof. Array callbacks are checked against observed data; `filter`/`map`/`slice` create fresh
results, and `sort` requires a fresh receiver on every relevant path. The limited cache/Intl/
URLSearchParams value construction needed by the emitted repository Next control is modeled;
arbitrary JavaScript, bundler loaders and framework internals are not inferred pure.

The production Next slice recognizes only the emitted static Turbopack registration/import
grammar. Dependency initializers are closed transitively, including duplicate emitted module
definitions. Reviewed React JSX/scalar-hook and framework-initialization contracts are bound to
exact containing-factory and callable hashes in `binding-modules.mjs`, not module numbers,
function names, framework version strings or caller flags. Changed or unknown bodies reject.
An initialization contract does not authorize arbitrary exported calls with application data.
JSX accepts host/Fragment construction with plain props and scalar key/ref only.

The native pending-submit preflight is limited to scalar state dispatch and an owned boolean
ref guard/write. CDP links each handler binding to the owning fiber's actual hook slot; state
dispatchers must have the exact native bound fiber/queue and source-bound dispatcher/reducer,
including the exact emitted dependency closure rather than unchanged entry-function text alone.
The live ref must be a writable own data field. Prefixes are checked in execution order, so an
already-set guard cannot be treated as an unconditional POST. Hook aliases, missing identities,
unsupported actions and unproved callbacks do not gain authority from their spelling.

Dispatch proof also checks argument evaluation, not just statements before `fetch`. It accepts
exactly URL plus a plain options object with one POST method and an optional modeled body;
extra arguments, unknown option names, getters/spreads/duplicates, calls, awaits and object
coercions outside the closed grammar reject. Supported bodies are scalar values, native
FormData and native URLSearchParams with fully checked scalar record fields. FormData locals
are tracked by lexical declaration, and `get` requires its document-start native identity plus
an independently inventoried string-valued form control. File/custom/unknown fields cannot be
assumed scalar. No option expression is executed to prove it benign.
Native FormData construction also requires a bounded CDP absence inventory for synchronous
`formdata` callbacks throughout the document tree and Window, including event-handler properties.
Custom elements, customized built-ins and application shadow roots in associated controls are
unsupported. A present callback stays unknown; constructors are not executed to test purity.
Missing native construction evidence also rejects source-only FormData discovery. The native
prefix/search-record and direct-body positives remain explicit Chromium controls.

Native array capture requires a bounded own numeric length and every own data index exactly
once. Leading, interior, trailing and all-hole arrays reject before effect analysis; absent
indexes are never inferred from a hole-skipping iterator or silently lost during serialization.
Numeric reads additionally require an own, known-position element. Out-of-range reads reject,
including after exact slices or filters. Indexed reads from uncertain filtered/sorted alternatives
reject rather than substituting the first possible element or consulting an inherited getter.
Plain-object reads likewise require an own field on every modeled path; a prototype's unchanged
property-name inventory is not an accessor-purity proof. Map/filter callbacks receive the actual
abstract traversed array as argument three, so caching that receiver cannot hide borrowed records
behind a missing-argument/null approximation. Unknown reads and borrowed retention stay unsupported.

The raw summary embeds artifacts and each positive binding retains its native links and effect
derivation. Capture projection and saved validation recompute the proof, including image/source
identity, rather than trusting `proved` or a stored endpoint. Native replay requires the
complete mandatory intrinsic inventory, per-binding identity edges, a same-realm object anchor,
script realm/origin correspondence and canonical emitted function locations. Deleting identity
observations or relabeling realms/locations cannot retain a positive receipt. All browser `.mjs`
producer/checker files enter the existing runner-file source closure automatically. Missing historical receipts
remain unqualified and saved evidence is not rewritten. Unknown production-bundle effects stay
explicit blockers; the apparatus ESM/JSX adapter is not a React runtime purity contract.
Structural effect replay alone cannot qualify a write. `binding-window.mjs` additionally requires
each proof's capture ID and host/native-clock interval to match one pre-dispatch lifecycle journal
receipt, the current case instance/action, independently observed mounted form backend-node ID,
instrumentation realm/scope and native unique execution context/frame/browser target. The capture
rechecks realm/scope and mounted form identity after its descriptor reads. A matching native POST
must occur in that frame/loader between dispatch start and the action's DOM/resource observation.
Missing, duplicate, stale or transplanted
receipts reject in both strict projection and saved replay. Earlier intact proofs cannot attest a
later guarded action. These are bounded observations, not independent source authentication or
a guarantee about unobserved future state; existing qualification blockers are unchanged.
Saved chronology admits binding-clock phases only through their unique case/action window,
journal receipt and native initial/terminal clock envelope, including incomplete diagnostics that
never proved an enhancement. Unknown, orphaned, duplicate or contradictory phases remain invalid.
The native-journal saved regression remains blocked for its explicitly uncollected semantic/source/
response/cleanup proof; admitting its clock receipts does not qualify that diagnostic.
Handler parameters participate in lexical shadow checks. Prop reassignment (including property
and destructuring writes), intervening function scopes, conditional/unreachable or uncalled
nested fetches, duplicate method properties and option spreads are unsupported, not inferred POSTs.
Object references retained by component-scope initializers, assignments, closures or class fields
are also unsupported, even when the alias is only mutated inside the submit handler. Discovery
does not substitute the sampled prop ID after that reference has escaped. Unrelated lexically
shadowed objects are not treated as aliases of the component prop.
The owning component must have a block body containing `let`/`const` declarations, optional empty
statements, then one terminal render return. That return has an expression grammar, not just
a statement-kind check: sequences, assignments, updates, deletes, awaits, tags and unmodelled
expressions are unsupported. The mounted handler must be a direct declaration, direct return,
or direct `onSubmit` property in that return. Handler values cannot pass through aliases,
captures or opaque factories, either as function literals or via a declaration's references.
An `onSubmit` property is supported only in a linked, effect-checked host `form` constructor
with plain, unique static props (no spreads or computed keys), connected to the terminal return
through literal props/children and effect-checked constructors. Every sibling is checked too,
not only that ancestor path. Arbitrary props factories are unsupported. This limited JSX source
grammar is not a general render-function or factory interpreter. Syntax-only regression controls
can resolve local pure constructors, but production observation never uses that path as evidence.
Standalone calls, branches, loops and other executable component statements remain unsupported.

A prop-object field read is distinct from invoking that field with the prop as receiver.
Calls, optional/computed calls, constructors and tags on the sampled prop/record object are
unsupported regardless of the field name; parentheses do not turn invocation into a pure read.
This also applies outside the handler, including declaration initializers and the terminal return.

Before the native fetch, only empty statements, modeled scalar `let`/`const` declarations, native
`event.preventDefault()` and `new FormData(event.currentTarget)` declarations are supported.
Event receivers must resolve to the handler parameter, not just share its spelling; lexical
shadows and pre-fetch assignments cannot substitute another value. `var`, `using` and
`await using` are unsupported in component declarations and on the pre-fetch path, including
the fetch-containing declaration list. Earlier declarations in the same list are checked too.
Unknown helper calls,
alias writes, getter reads, parameter defaults, awaits, comma expressions and fetch wrappers
are not assumed harmless. The existing URL evaluator, lexical checks and exact request
comparison still apply. These are syntax/effect boundaries, not method-name exceptions or an
attempt to interpret arbitrary component code. A render helper's existence does not prove
that an unknown pre-fetch handler operation is pure.

For API-source actions that issue native marketplace requests, a completed upstream request is
not enough: a phase must contain a successful HTTP 200 read for that action's requested record.
The missing-record action is exempt from the successful-read requirement. A 404, cancellation
or successful read of another record remains in the raw counts but cannot satisfy the action.
Journey checks, final capture projection and saved verification recompute this binding from raw
phase receipts. Conservation-only `reconcileUpstream` callers without action observations do not
certify request-time record reads.

Listener bookkeeping checks native `signal.aborted` before reusing a registration and when
counting resources. It does not rely solely on delivery of an `abort` event: an earlier native
listener may stop that event while the platform still removes the signaled listener. Reusing
the callback must create a fresh binding with the new registration's own `once` semantics.

`node --test bench/fullstack-browser/row7.test.mjs` provides bounded Chromium regression controls
for suppressed abort delivery, requested/wrong/missing record reads across all eleven phases,
mounted React parameter shadowing, component-alias/container/return-factory/receiver escapes and
native socket receipt mutations. The closed-grammar controls compare Node and Chromium errors
and HTTP receipts for event shadows/resource declarations; a real native submit capture listener
also demonstrates the terminal props-factory escape independently of discovery.
`binding-effects.test.mjs` serves actual emitted repository component/helper ESM modules and
checks their CDP-linked native POST, renamed-safe helper, effectful substitution, sibling effects,
initializer/callback retention and altered proof bytes/locations. The source-only Next controls
still execute the actual submit function but now require rejection without emitted provenance.
The test-only JSX/runtime adapter is not a compiled Next deployment or new contender evidence.
`BINDING_NEXT_IMAGE=<immutable image id> node --test bench/fullstack-browser/binding-production.test.mjs`
is the opt-in bounded production-image control. Its unchanged case extracts actual image bytes,
loads the real Next page, requires native discovery/replay and clicks its native submit button.
It checks again after the actual response changes component state. Intercepted emitted-bundle
negative/rename controls carry separate synthetic identities, never image qualification; they
retain the real React mount and compare actual HTTP requests for sibling/initializer/callback
retention and helper/dependency substitution. These are apparatus tests, not new contender
evidence; historical saved observations are not rewritten.
Set `BINDING_NEXT_ORDINARY_ONLY=1` for just the unchanged production positive and its built-in
replay/live-guard checks; the default still runs every existing bundle control. The ordinary
test's child names are not independently selectable through a parent-matching Node test filter.
`binding-dispatch.test.mjs` supplies local argument/descriptor grammar controls, while the focused
native-dispatch test in `binding-effects.test.mjs` confirms unknown option work is never executed
by discovery, real argument failures prevent HTTP dispatch, and sparse native props reject.
`binding-window.test.mjs` supplies receipt-only chronology/identity mutation controls, not a
fabricated qualification capture. The ordinary production test also requires action-bound replay
and rejects an intact earlier proof transplanted to the actual live guarded/no-POST action.

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

### Saved Validation

`verify.mjs` is the standalone, strict read-only replay entry point:

```sh
node bench/fullstack-browser/verify.mjs --folder bench/fullstack-browser/work/w1 --round w1 --commit <full-40-character-commit>
```

The equivalent API is `validateSaved({ folder, round, commit })` from `verify.mjs`.
Relative folders resolve against the repository containing the validator, not the caller's
working directory; absolute local folders may be relocated. The explicit commit must match
the saved producer commit. No Browser, Docker, Git, remote service or installed browser
package is required. Git replacement/graft configuration cannot affect replay because no
Git query runs. On Windows, the stock PowerShell file-attribute reader also checks reparse
tags without interpreting saved paths as code. Recorded external paths are never opened.

Replay checks all ten candidates, all 24 current profiles and all ten native capture files,
canonical producer JSON, fixture/plan/settings/options, dirty and image/build provenance,
raw-case/capture hashes and manifest correspondence. It re-derives native DOM/request,
resource retirement, no-JS/platform lifecycle and final browser/upstream conservation using
the current proof functions and unchanged strict oracle. Stored derived summaries must
match exactly. Independent SSR parser status, response hash and public path/query must
agree with an unambiguous native browser document response. Missing receipts or ambiguous
document identities remain blocked; malformed fields and conflicting receipts are invalid.
Supplied action/readiness durations must be finite, nonnegative and chronologically
consistent. The final browser ledger boundary must follow the retained action, resource,
readiness, lifecycle, cleanup and upstream terminal observations. Action durations use the
producer's later dispatch clock, so action-start plus duration is a lower bound, not an
invented exact dispatch timestamp. Missing timings do not become zero observations.
Every initial, write, rejection and other-session readback is checked for successful HTTP
status, a separate native store endpoint fixed per target/round, unique observer identity
and canonical store fields. Provided case/round/source identities must agree. A retained
failed HTTP read remains failed diagnostics, not a malformed success or an empty store.
Missing read receipts and unauthenticated endpoint/context/source bindings stay blocked.
Host-clock checks cover actual pre-baseline, target inventory, context/realm, parser and URL
identity, retirement probe, cleanup, observer-failure and upstream sample receipts, not only
declared boundaries. Dependencies and journey/cleanup/terminal phases must be ordered.
CDP timestamps and upstream server clocks are never compared with the host clock.
Post-harness journals must preserve the native prefix; their later close receipts are not
charged to the pre-harness final browser boundary and cannot supply native cleanup proof.
Links (including junctions, ancestors and hard links), network/device/ADS or
traversal paths, non-regular files, extra/missing files and changing evidence are refused.

`outcome: "invalid"` (CLI exit 2) means malformed, inconsistent or stale derived evidence.
`outcome: "blocked"` (exit 1) means structurally consistent diagnostics with missing or
failed qualification proof. A historical journal missing new receipts remains unknown;
its old positive summaries are stale, not grandfathered. Replay never rewrites historical
captures or updates their hashes. Tests may recompute summaries only in disposable copies.

Both outcomes keep `qualificationPassed` and `readyForLoad` false. Current producers do not
bundle independently authenticated source/commit receipts, raw process/configuration and
isolation inspections, complete worker-network ownership or native app server-peer closure.
Boolean coverage flags, a context close and unknown worker counts cannot replace those
receipts. Runner source hashes are compared with local current sources, not authenticated
as belonging to a Git commit. Browser binaries, response bytes and custom targets are not
bundled for independent rehashing; build-log authenticity is not recorded. Absent proof stays blocked.
The validator currently has no positive qualification path. It does not repair a producer,
qualify a historical run or authorize load. Keep a saved folder immutable while replaying;
identity/metadata checks detect changes but cannot lock out a hostile concurrent writer.

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

The final pre-harness `requestLedger` is reconciled by ID and complete raw outcome with
exactly one action, cleanup-navigation receipt or retired-event probe. Cleanup navigation
requests are retained separately from the probe's quiescence check. Missing/duplicate IDs,
stale outcomes, failed/body-capture-error requests and unexplained late requests block strict
export, including when an earlier functional flag was positive. Network-observer and browser
errors are retained through that final boundary. `harnessClosedRequestLedger` is separate;
closing the context cannot supply native completion evidence.

`upstreamLedger` retains actual numeric-source snapshots before/after the initial store read,
every action, mutation probes and cleanup, plus a final snapshot after the terminal observation
interval and before harness closure. The source has stable ledger and request identities;
reconciliation checks append-only history, actual finish/close receipts, complete phase
coverage and pending or unassigned work between phases and at the end. Fixture profiles must
have no source work across the entire interval, not just during actions. The runner and strict
exporter recompute these checks from raw snapshots. These receipts prove only the independent
numeric source's request outcomes, not application-server peer closure or worker-network silence.

`resources.mjs` installs observers before native scripts and records native add/remove/once/
abort listener lifetimes, timeouts/intervals/animation/idle callbacks, native DOM observers,
fetch/XHR/microtask work and EventSource/WebSocket/worker connections. DOM roots receive
observer-owned identities; callback-created work inherits the observed target's scope.
Global resources without provable ownership remain explicitly unattributed and prevent
qualification. Native framework subscription internals and arbitrary Promise continuations
are not claimed to be enumerated. Known Playwright hit-target/removal-detection registrations
are retained separately with their observed `InjectedScript` call stacks, not charged to apps.
DOM-observer subscriptions are counted per observed target, including multiple marketplace
roots, repeat observation, native `unobserve` and `disconnect`. Callback-created work inherits
ownership only when the delivered targets identify one scope; mixed-scope work stays unattributed.

Cleanup clicks the app's real header link away, without forcing unmount, deleting native DOM,
clearing timers/listeners, or closing connections. For a same-realm retired root it dispatches
the actual registered event types (default action prevented) plus a retired-page event, then
observes resource counts, real DOM hashes, requests and errors for the bounded interval.
Native document-realm replacement is also captured through CDP. A destroyed realm cannot
supply a fresh retired-DOM read/probe, so those counts stay null and the profile remains
unsupported under the current strict oracle. There is no automatic platform-destruction
waiver. Opaque global ownership similarly needs native lifecycle attribution before full
qualification; a browser context closing is not that proof.

`lifecycle.mjs` correlates observed instrumentation realms with native default execution
contexts, frame/loader commits, target discovery and page WebSocket/EventSource receipts.
The native journal is frozen before harness context closure; the post-harness journal is
separate. Worker network coverage, shared-worker ownership and server peer socket cleanup
remain explicitly unproved. The v2 journal captures initial/terminal target inventories,
continuous runtime-context lifetimes, bounded terminal probes and actual no-JS parser/CSP
provenance. The separate pure `validatePlatformRetirement` and `classifyNoJSRequests` exports
produce raw diagnostic proofs only, never a local qualification waiver. Workers, unknown
ownership/coverage or missing terminal receipts block the platform predicate. See
[the exact interfaces and evidence proposal](LIFECYCLE.md); no shared-oracle variant or
platform-destruction exemption is accepted here.
Committed HTTP frame/loaders also require matched native document dispatch, response and
terminal receipts. Both pure validators require successful assets' own response receipts;
removing network coverage cannot become a positive empty-request proof.
Completed HTTP documents and observed parser inventories must also match native commits in
the reverse direction. Empty commit streams, orphan redirect continuations, missing mandatory
native fields and declared assets without matching dispatch coverage remain unknown. These
checks neither reconstruct deleted observations nor change the strict oracle or 240 profiles.
Redirect links additionally retain the actual predecessor response's complete-URL hash, public
path/scheme/status and native header timing. Independent native network-stack request-time
receipts bind each dispatch in a reused-ID chain, including repeated identical URLs; missing
receipts cannot bridge a deleted middle hop. A bounded read-only parser observation retains
complete-URL hashes, not query strings, and binds declarations to their actual realm and scope.
Query-distinct assets require distinct matching URL identities; only exact-URL duplicates can
coalesce. Missing identities or changed observations remain unknown. Bounded native-clock
samples and response header/terminal timing reject reversed or future
native timestamps independently of host receipt order. Historical journals lacking these new
receipts remain unknown without rewriting their saved captures.

For a retained same-realm root, `retired.mjs` freshly extracts text, rows, forms and component
IDs from that actual detached node. It never reattaches the root or copies the previous page
model. Its route/locale metadata identifies the original observed document. Unavailable fresh
enhancement bindings are explicit and cannot become a passing strict capture.

Every invocation also writes `captures/<app>.json` (`browser-journey-capture/v1`) and
`captures/manifest.json` (`native-browser-strict-export/v1`). `capture.mjs` projects only
complete independently observed cases and calls the unchanged `validateBrowserCapture`.
Every candidate/profile survives; partial failed/unsupported observations stay in the raw
summary, with null evidence in strict unavailable cells as that schema requires. The manifest
binds raw case and capture hashes and retains exact code/image/browser provenance. Failed,
unfinished, intentionally disabled preload and body-capture-error requests are never dropped
to make export pass. Native SvelteKit/RR paths map only through their recorded transport proof.
An oracle rejection is reported as a failed case, not normalized into success. Export does not
certify native qualification, comparative timing or load readiness.

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
