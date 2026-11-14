# Native browser v2 evidence leaves

These optional leaves collect/replay intrinsic observations. They do not replace
`validateSaved`, the shared browser oracle, the isolated adapter, or core OS proof.
Existing runner/journey/verifier/lifecycle integration belongs to their author.
No dependencies, workload settings, resource budgets or timeouts are changed.

## Separate decisions

The integrating verifier's envelope is `native-browser-saved-validation/v2`:

```js
{
  schema: "native-browser-saved-validation/v2",
  status: "verified" | "failed" | "blocked" | "invalid",
  attemptComplete: boolean,
  qualificationPassed: boolean,
  cleanupComplete: boolean,
  expectedExitCode: 0 | 1, // derived ONLY from replayed qualificationPassed
  blocked: [/* fixed reason codes, not saved error strings */],
  sources: { commit, files: [{ path, mode, sha256 }] },
  cells: [/* owner's exact full registry/case replay and dispositions */],
  hostSubject: { /* below; only after evidence replay */ }
}
```

This envelope is an integration contract, not an entrypoint implemented by these
leaves. A complete observed target failure/unsupported outcome is not incomplete
apparatus evidence. Conversely an exception, invalid artifact, lost observer,
missing body or arbitrary nonzero exit never proves an observed target failure.
The owner must replay the exact fixed failed prerequisite and its bounded
downstream-not-run disposition. All-cell completeness still requires every bound
candidate/profile; a selected native control is not a complete group attempt.
`qualificationPassed` continues to require the unchanged strict browser oracle.
`expectedNativeExitCode(true)` returns 0; false returns 1; non-booleans throw.
Native source or host observations confer no review/admission/operator authority.

## Storage API

`new EvidenceStore(folder)` exclusively creates `native-evidence/`. The folder is
an operator-supplied local directory, never a saved path. `.blob(bytes)` returns
`{path:'native-evidence/blobs/<sha256>',bytes,sha256}`; `.record(name,value)` writes
one JSON blob and records its root reference. Names match `[a-z][a-z0-9-]{0,79}`.
`.seal()` writes the exact manifest, including every deduplicated blob:

```js
{schema:"native-browser-evidence/v2", records:{source:ref,tools:ref,execution:ref},
 files:[ref /* sorted by path */], sha256:sha256(encoded(files))}
```

`encoded(value)` is UTF-8 `JSON.stringify(value) + '\n'`; replay rejects duplicate
keys/noncanonical JSON. `openEvidence(folder)` validates the entire namespace;
`.read(ref)` returns bytes; `.json(ref)` returns canonical JSON; `.finish()` proves
the manifest/tree unchanged and every blob consumed. Outer native tree sealing
must still include existing summary/captures/logs and this namespace. Limits:
50,000 blobs, 256 MiB/file, 1 GiB total, 32 MiB/JSON; no links, hard links, special
files, unknown members, saved alternate paths or network roots. Bounds are fixed,
not runner knobs. Store only outputs of the scoped producers below; `.blob` is
not a generic credential sanitizer. No raw HTML, cookie/header/session/CSRF values,
post bodies, arbitrary diagnostics or process command/environment dumps belong here.

## Source, contexts and tools

`captureSource(store,commit)` returns
`{schema:'native-browser-source/v2',commit,files:[{path,mode,sha256,body:ref}]}`.
`replaySource(reader,receipt,commit)` compares all bytes/modes/paths with fixed local
immutable Git and returns `{commit,files:[{path,mode,sha256}]}`. The fixed roots are
Cargo manifests/lock, package manifests/lock, crates, fullstack-browser, fullstack,
marketplace and workloads. It uses the isolated binding's existing exclusion rule
for results/evidence/work/node_modules/target, retaining the existing client-source
root exceptions. Thus it covers the browser adapter's binding-required paths,
without returning unrelated historical outputs absent from that binding.

This is a canonical committed inventory, not evidence that mutable runner files
were executed. The integrating owner must compare actual runner/tool source hashes
with these files, before/after execution, and reject changed/untracked executable
inputs. Build from retained context stdin, not a mutable source directory. No
dirty/clean flag, label, or commit string substitutes for those comparisons.

`captureBuildContext(store,commit,app)` returns
`{schema:'native-browser-build-context/v2',commit,app,dockerfile,body:ref}`.
`replayBuildContext(reader,receipt,commit,app)` returns
`{commit,app,dockerfile,sha256}` after exact deterministic archive comparison.
These are DISTINCT full build contexts, not the narrower binding inventory.
Corten uses the entire committed root and marketplace Dockerfile; other apps use
their committed `bench/fullstack/apps/<app>` subtree. SvelteKit retains
`Dockerfile.marketplace`; others `Dockerfile`. Standard tar/PAX members are also
compared to canonical Git blob bytes/modes so export attributes cannot silently
omit/substitute inputs. Replay never extracts saved tar. Archive bytes must be the
actual Docker stdin; owner must bind image build command/log/ID to this digest.

`captureTools(store,{browserExecutable})` resolves live local paths, never stores
them, and returns `{schema:'native-browser-tools/v2',lock:ref,node:ref,browser:ref,
packages:[{name,version,archive:ref,files:[{path,body:ref}]}]}`. Exact fixed packages:
`@playwright/test`, `playwright`, `playwright-core`, `typescript`. Each archive is
found only in local npm cache, including npm's configured local cache (offline
config query), SHA-512 checked against the root lock using `packageFiles`, and
compared byte-for-byte with the actual installed package tree. Missing cache or
changed install throws, without fetching or accepting a hash-only substitute.
`replayTools(reader,receipt)` consumes every archived/installed file and executable
and returns `{node,browser,lockSha256}`. Owner MUST compare `lockSha256` with the
canonical source receipt's package-lock.json before accepting tool source closure.
Windows/Linux fixed tool packages are covered; additional platform-only runtime
packages and OS dynamic library authenticity are not silently certified here.
Exact executable bytes are observations, not independent distribution approval.

## Public responses

Byte-response and existing mixed projection APIs bind
`{requestId,responseSha256,path,status}`. Paths are public
paths only, without query/fragment/credentials. Request ID comes from the actual
native network observer. Owner must additionally bind context/case/endpoint and
independent readback source, never infer them from this leaf's success alone.

`retainPublicJSON(store,body,kind,binding)` supports existing mixed `state` and
`record` allowlisted public schemas, retaining exact bytes, duplicate-key checking,
and refusing unknown fields. `retainPublicAsset(store,body,binding,contentType)`
retains exact known JS/CSS/image/font bytes, not HTML or transport payloads. Owner
must independently match asset bytes to the fixed public image/source inventory;
MIME/extension alone cannot establish that arbitrary content is public.

`retainDOMProjection(store,transcript,binding)` reuses mixed `collectDOMReads` /
`replayDOMReads` with the installed fixed `snapshotMixedPage`, not saved code.
Capture at the actual independent parsed response's public read boundary. Receipt:
`{schema:'native-browser-response/v2',type:'public-dom-read-projection',binding,
body:ref,page}`. This is NOT original HTML bytes, nor proof of secret-bearing
hidden input values. The original HTML digest binds observation identity only.
The collector filters hidden/meta/query secrets; do not call it on raw HTML as a
fallback, persist its secret-bearing source, or permit arbitrary snapshot code.
`replayResponse(reader,receipt,binding)` returns `{type,page,extractionComplete}`,
`{type,value,extractionComplete:true}` for JSON, or
`{type,sha256,extractionComplete:true}` for assets. A replayed DOM extraction failure
has extractionComplete:false, not an accepted failed target.

### Fixed browser DOM observations

`native-browser-dom.mjs` adds a browser-only collector/replayer alongside the
unchanged mixed API. It always uses the installed strict
`marketplace/check.mjs::snapshotPage` for ordinary pages, not `snapshotMixedPage`.
Neither capture nor replay accepts caller/saved source, functions, selectors or
snapshot modes. The ordered typed read recorder follows the existing mixed
pattern; it is not a general DOM evaluator.

```js
const observation = await collectBrowserDOM(page, {
  context, case: caseKey, action: actionId, scope,
  originatingResponse: { requestId, sha256 }
});
const expected = {
  observer, context, case: caseKey, action: actionId, scope,
  originatingResponse: { requestId, sha256 },
  readInterval: { startedAt, finishedAt }, url: { path, query }
};
const result = replayBrowserDOM(observation, expected);
const receipt = retainBrowserDOMProjection(store, observation, expected);
// Additive replayResponse branch, with expected LIVE identity, not byte binding:
const stored = replayResponse(reader, receipt, expected);
```

`collectBrowserDOM` generates a fresh observer UUID and brackets the native read
with actual host Unix-ms timestamps, within the existing 15-second action budget.
Context/case/action/originatingResponse are caller-owned actual identities. Case
and action must be fixed browser registry keys/step IDs; context/scope/requestId
are bounded safe IDs. Scope is read from the actual existing resource observer
checkpoint before/after; URL is observed before/after too. Both must remain equal
to expected values. Collector errors/unsupported access produce only a fixed
failure code and unknown result with no partial reads or diagnostic text. Invalid
caller identity, secret/unknown current URL, or exceeded bounds throw instead.

Exact observation fields:

```js
{
  schema: "native-browser-dom-observation/v1",
  ...expected,
  snapshotSha256, // installed snapshot/collector/native-boundary/URL policy digest
  roots: { document: 0, location: 1, global: 2 },
  events: [{ target, kind, key, args, result }],
  result, failure: null | "credential-filter-blocked" |
    "public-error-unavailable" | "native-scope-mismatch" |
    "native-dom-snapshot-failed",
  scopeObservation: { before: scope, after: scope },
  urlObservation: { before: {path,query}, after: {path,query} },
  boundaryObservation: { /* typed native boundary below */ }
}
```

On failure events are empty, scopeObservation/urlObservation/boundaryObservation are null and result
is `{kind:null,page:null,error:null,articleCount:null,extractionComplete:false}`.
This is proof-missing, not an observed semantic target failure or qualification.
On successful ordinary-page replay result is
`{kind:'page',page:<strict snapshot>,error:null,articleCount:1,extractionComplete:true}`.
The fixed missing route instead reads absence of `article.marketplace` and bounded
visible `h1,h2,p,[role="alert"]` elements (tags h1/h2/p/div/section/span only).
Native visibility includes hidden ancestors. Only exact whitespace-normalized
phrases `Not found`, `Not Found`, `Page not found`, `Item not found`, `Record not
found`, `404`, `404 Not Found`, `404: Not Found`, `This page could not be found.`
may be retained. Result is `{kind:'missing-item',page:null,error:{code:'not-found',
text,tag},articleCount:0,extractionComplete:true}`. Unknown text is never saved and
cannot be treated as a target failure. No raw body innerText/HTML is collected.
Error reads expose only `publicMissingTag` (allowlisted tag or null) and
`publicMissingText` (native-visible allowlisted phrase or null), not raw custom
tag names, ARIA attributes or arbitrary computed style values. Unknown neighboring
error elements cannot leak text/metadata into an otherwise successful capture.
Every descendant must also pass native visibility (including CSS display,
visibility and opacity). Computed content-visibility must be `visible` on the
candidate, every descendant and their ancestors, each ancestor walk bounded by
the existing 10,000-member limit. `hidden` and `auto` are unsupported, including
non-atomic inline elements where a browser might still paint the text; native
checkVisibility alone does not check an element's own skipped contents. A
candidate with a hidden or unsupported descendant is refused rather than
assembling a phrase from its hidden textContent. Visible inline spans remain
supported; no raw innerText/HTML fallback is used.

Public page routes are fixed marketplace locales and item_1 through item_500 or
item_missing. Canonically encoded queries allow only seller ''/Alice, sort
asc/desc, offers all; missing-item has no query. Duplicate/unknown/secret query,
credentials and fragments reject. Attribute URLs are validated before reads.
All meta elements, including itemprop/content-only metadata, are inventoried
transiently. The inventory also visits native HTMLTemplateElement.content
fragments iteratively, including nested templates. Templates, fields and private
select options share the existing aggregate 10,000-member limit; unsupported
template objects fail closed. All inert template input/textarea/select values
are private, regardless of their own computed style. No template content or
source names are retained. Native input/textarea/select controls are private when hidden,
password-bearing, ARIA-hidden or not natively visible (including ancestors and
CSS opacity/visibility/display). Their actual live values, value attributes,
default values and private select option values are filtered, never serialized.
The inventory precedes every retained read, is bounded by the existing list,
scalar and JSON limits, and fails closed on unsupported private metadata children
or populated file controls. It is not a parser for arbitrary scripts, framework
state or a claim about secrets outside these fixed native field sources.
One native hidden public control is recognized: the sole direct `offers=all`
input of the sole marketplace listings GET form, only while the canonical page
query also has offers=all. Its live/default/attribute value must all equal `all`,
its only attributes must be name/type/value, and its same-origin action must be
the current public path without query. Otherwise it stays in the private
inventory. This is a fixed public form contract, not a substring exception:
another private field with value `all` still filters colliding public reads.
Noncanonical aria-hidden guard strings are refused, not normalized into a
semantic false and retained. Public text/guard reads containing private values or
hidden/script/style/template/meta descendants fail closed. Existing fixed bounds
are 30,000 typed reads, 10,000 list members, 131,072-character scalars and 32 MiB
observation; no runtime budget knobs are added.

Typed values are exactly one of `{scalar}`, `{undefined:true}`, `{object:id}` or
`{list:[typedValue]}`. Replay executes only installed fixed functions, verifies
their digest, every ordered operation/argument and all consumed reads/results;
extra/missing operations, operation/argument/result contradictions or source
substitution throw. The retained blob digest and sealed manifest also reject
altered read bytes that would leave the semantic result unchanged; standalone
transcript replay is not independent observation authenticity.
The policy digest includes the installed collector, so projections collected
under an older private-value/visibility policy require fresh capture, not replay
under the new policy with a saved digest or saved source substitute.
It does not execute saved code or reconstruct secret-bearing original HTML. Read
transcript and actual identity still need the owner's source/execution/native
observer binding.

`retainBrowserDOMProjection` is exported by `native-responses.mjs`; exact receipt:
`{schema:'native-browser-response/v2',type:'public-browser-dom-observation',
identity:expected,body:ref,result}`. `replayResponse` returns `{type,...result}`.
Every expected field must independently match caller ledgers, including actual
context/case/action/scope, unique observer, read interval and originating native
response ID/digest. Caller must bound the interval to actual context/action life,
and bind the URL/origin/request to the intended document. The originating response
may precede later live mutations: this receipt is explicitly a live semantic
observation, NEVER original response bytes or byte equivalence to that response.
Caller retains unchanged strict comparePage, native form, status, request,
resource and qualification gates. Neither a missing article nor safe error text
alone proves an HTTP 404. Existing mixed/JSON/asset APIs remain unchanged.

### Native unsupported-structure boundary

The fixed leaf refuses author shadow roots (open/closed, declarative/imperative,
including hosts in recursively reachable ordinary template fragments), even a
correctly slotted visible error. Native content documents, frame owners and
frame/iframe/object/embed elements are unsupported. No shadow/slot/CSS semantics
are interpreted. Native `user-agent` roots remain supported without traversing
their browser-owned internals. An HTML document element's native main frame ID
is distinguished from a subdocument owner using actual Page.getFrameTree.

`boundaryObservation` is opaque to callers and required for successful replay:

```js
{
  schema: 'native-browser-dom-boundary/v1', observer,
  document: {nodeId, backendNodeId, frameId},
  commands: [
    {method:'DOM.enable'},
    {method:'Page.getFrameTree',frameId,childFrames:[]},
    {method:'Page.createIsolatedWorld',frameId,executionContextId},
    {method:'Runtime.callFunctionOn',role:'mutation-start',executionContextId,
      result:{observer,roots}},
    {method:'DOM.getDocument',root:nodeId,nodes:[nodeRecord]},
    // Zero or more actual incremental population receipts:
    {method:'DOM.requestChildNodes',nodeId,children:[nodeId],nodes:[nodeRecord]},
    {method:'DOM.resolveNode',role:'semantic-read',...document},
    {method:'Runtime.callFunctionOn',role:'semantic-read',...document,observer},
    {method:'DOM.describeNode',...document},
    {method:'DOM.resolveNode',role:'mutation-check',...document,executionContextId},
    {method:'Runtime.callFunctionOn',role:'mutation-check',...document,
      executionContextId,result:{observer,roots,mutations:[]}},
    {method:'Runtime.callFunctionOn',role:'mutation-cleanup',executionContextId,observer},
    {method:'Runtime.releaseObjectGroup'}, {method:'DOM.disable'}
  ]
}
// nodeRecord contains ONLY:
{nodeId,backendNodeId,nodeType,kind:'ordinary'|'template'|'document-element',
 childNodeCount,children:null|[nodeId],templateContent:null|nodeId,
 shadowRoots:[{nodeId,backendNodeId,type:'user-agent'}]}
```

Initial and incremental receipts are the actual depth-1, pierce-false native
responses, projected immediately. Null children means not yet populated; every
positive child count must acquire its exact child list. Template fragments need
explicit population even when a whole-document CDP query claims deep traversal.
Replay consumes each command and typed member, checks per-response reachability
and order, globally unique node/backend IDs, complete acyclic document/template
population, all native child counts, allowed UA roots, native document/frame and
isolated-context/read/check bindings. Extra, missing or contradictory members
reject. Raw CDP attributes, text, node names, URLs, remote object IDs and mutation
contents are never saved. The final sealed blob binds all structural reads too.

CDP DOM events cover frontend-known nodes, not every unvisited subtree. Before
incremental population, one fixed native MutationObserver is therefore installed
synchronously in a CDP-created isolated world on the current document and every
reachable ordinary template fragment. Its initial roots must exactly match the
native template population plus document. It covers native child/attribute/text
changes in as-yet-unpopulated ordinary and inert subtrees. Pending records are
checked as well as delivered callbacks; no mutation contents leave that world.
This does not inspect arbitrary scripts or interpret shadow content. CDP provides
native closed-root classification and remains subscribed through the read and
barrier; any native structure/root/document change invalidates the attempt.

DOM.resolveNode supplies the exact inventoried document object for the installed
synchronous semantic read. It must equal that world's current top-level document.
The same ordered native session checks the document again after the read, resolves
it into the observer world, and checks that exact receiver against the observer's
original document with no pending/delivered mutations. Observers are disconnected,
remote groups released and the native session detached, including on failure.
Missing replies, document replacement or lost session return unknown with no
partial reads. A clean final tree or a saved coverage flag is not accepted instead.

All preparation/read/check/cleanup remains inside the existing 15-second read
budget. Native ordinary/template/UA-root identities share the 10,000-node cap;
transient native payloads and the final observation each obey 32 MiB. Unstable or
over-bound pages remain proof-missing, not semantic failures. The installed digest
includes every fixed native helper and the receiver-binding collector wrapper.
These bounded observations do not establish independent execution/source/store
authority, certify detached arbitrary JavaScript state, or cover other documents;
the integrating owner still supplies those independent identities and strict gates.

## Execution and terminal ledger

`participantSnapshot(info,image)` reuses the mixed safe projection. It retains
original IDs, state/PID/start/exit facts, exact Docker limits, hashed command and
mount source, safe environment allowlist, mounts and image identity; owner is
`{agent,task}`. Never save the original raw inspect. HostConfig is configuration
evidence, NOT actual kernel accounting or process-population proof.

`new ExecutionLedger(store,{task,commit,startedAt})` creates
`{schema:'native-browser-execution/v2',task,commit,startedAt,endedAt,events}`.
Task matches `browser-[a-f0-9-]+`. Times are Unix milliseconds.
`.append(event)` assigns monotonic `seq` (0-based). Exact event fields, in addition
to `{event,at,seq}`:

| event | fields |
| --- | --- |
| participant | phase:created/running/terminal, role, app, case, snapshot |
| created | kind:network/image, id, owned:boolean |
| command | operation:create/start/build/copy, role, app, case, id, code |
| browser-window | app, case, startedAt, endedAt |
| remove | kind:container/network/image/volume, id, code |
| inventory | kind, scope:all/owned, code, ids |

Roles are application/upstream/artifact. Application app/case must be fixed
candidate/registry keys; upstream app/case are null; artifact app is a candidate,
case null. Artifacts stay stopped. Record created snapshot before start, exact
start acknowledgement, running readback, and pre-removal terminal readback.
Every application/upstream has exactly one start acknowledgement, including failed
start. Create/build failure may have id:null; start/copy bind an original created ID.
Commands retain exact observed code, never command text or error diagnostics.
Every known create/build command original ID remains in the resource population
even if its inspect receipt is lost (including a known ID returned on command
failure). Successful create/build without an original ID is incomplete. Successful
commands must reconcile with created participant/image observations; empty owned
inventories cannot substitute for those missing receipts or original-ID cleanup.
Record every volume revealed by mounts; remove containers with anonymous volumes.
Container remove event means the fixed actual `docker rm -f -v` acknowledgement,
not arbitrary remove arguments. That acknowledgement covers associated anonymous
volumes too, but each volume still needs its own positive post-removal ALL inventory
absence. Named volumes remain ownership-blocked, not assumed safe to remove.
Fixed unchanged quotas are one CPU/1 GiB app, one CPU/256 MiB upstream.

`await collectDockerInventory(docker,kind,task,scope)` executes fixed read-only
Docker commands. Callback returns `{code,stdout}`. Returned `{kind,scope,code,ids}`
can be spread into an inventory event with actual collection time. Positive `all`
inventory after successful removal must omit the original ID; arbitrary failed
inspect is not proof of absence. After all removals, all four `owned` inventories
must succeed and be empty. Failed commands remain observations, never empty success.
Original-ID absence derives from the latest successful ALL inventory for that
resource kind after removal. Later positive presence revokes prior absence even
if the final label-filtered owned inventory is empty.
`.finish({endedAt})` records the ledger and returns its ref.

`replayExecution(reader,ref)` returns
`{executionWindow,processWindows,participants,commands,cleanupComplete,blocked,
subjectSha256}`. CleanupComplete here covers only this Docker apparatus population;
owner must ALSO replay parser/mutation/browser context close receipts, native host
command terminal state and other apparatus before overall cleanupComplete.
Observed target leaks/failures do not become strict qualification merely because
the apparatus was eventually removed. Runtime config/source identity blockers stay
separate from terminal cleanup. Unknown/malformed/contradictory records throw.
Missing observations return blocked, not a completed failed attempt.
Blocked results retain acknowledged-but-unobserved containers as participants,
with imageId/terminal null where missing; those results cannot form a verified
hostSubject. A stopped artifact has no start attempt, restarts or execution
timestamps/state. Any artifact start acknowledgement or execution history blocks
the stopped-artifact contract and preserves a conservative non-null window, even
when the process exited before terminal inspect. Event fields/exports are unchanged.

## Workers and peer applicability

`replayWorkerAbsence(journal)` returns
`{schema:'native-browser-worker-absence/v2',status:'verified'|'blocked',blocked,
journalSha256,population}`. Journal is existing platform-lifetimes/v2, plus this
actual successful native command receipt (not synthesized from a coverage flag):

```js
{event:'Target.setDiscoverTargets',startedAt,receivedAt,
 params:{discover:true},result:{}}
```

Discovery must precede initial getTargets; Runtime/Page/Network enables precede
initial inventory. Initial inventory precedes application work; continuous target
events reconcile exactly to final inventory, with no observer loss. Relevant
worker of any kind, unknown worker context, extra own page/frame or unobserved
target scope stays blocked. Discovery-time transient workers count even when gone
before initial inventory. Worker-present needs a proper collector, not a flag.

`replayPeerApplicability(journal,workerProof)` independently recomputes/binds that
proof and returns `{schema:'native-browser-peer-applicability/v2',status,blocked,
journalSha256,applicability:'empty-set'|'unknown',peers}`. Complete worker absence
and continuous clock-bounded native page request/response/terminal journal can
derive the empty application long-lived population. Ordinary completed HTTP
keepalive is NOT a peer. WebSocket/EventSource/event-stream MIME or pending request
is NOT waived by CDP close, target destruction, context teardown or cleanup.
This minimal leaf accepts no nonempty peer proof: observed peers remain blocked
until matched actual endpoint receipts collected pre-teardown have a reviewed
contract/collector. Existing full native redirect replay rules are retained.
An orphan redirect continuation blocks, as do retained ExtraInfo observations
without all matching dispatch hops. Retained HTTP frame commits and parsed
document identities must reconcile with completed document Network receipts;
deleting the entire main Network stream cannot turn those observations into an
empty-set success. This reconciles existing observations, not new coverage flags.
Neither leaf proves retired DOM/event probes or relaxes strict browser capture.

## Core composition

Owner forms hostSubject only from replayed leaves, never saved claims:

```js
{schema:'native-browser-host-subject/v2', executionWindow,
 processWindows:[{kind:'browser',app,case,startedAt,endedAt}],
 toolIdentities:{node,browser},
 participants:[{id,role,app,case,imageId,window,terminal}],
 subjectSha256, filesSha256}
```

Browser windows must be actual journal bounds converted with actual timeOrigin;
participant window conservatively spans created through pre-removal terminal
receipt, not only first running poll. Stopped artifacts and observed failed-start
without running observation have null window; an artifact with a start attempt or
execution history never gets a stopped-artifact null window. Original full IDs are mandatory.
Core independently observes/binds actual host Node/Chromium and all running Docker
participant process identities/cgroups, controls and terminal state. One scope
cannot discharge another. Core owns OS helper/host-lifetime/native-replay/composition;
these leaves do not modify isolated code or assert exclusive-host authority.

## Checks and limits

Run `node --test --test-concurrency=1 bench/fullstack-browser/native-*.test.mjs`.
The fixed DOM controls live in `native-responses.test.mjs`, already explicitly
included by the evidence-contract CI command; no wildcard CI change is needed.
Pure controls reject corrupt/extra/missing/linked evidence, mismatched canonical
Git/source/archive/tool/response binding, incomplete terminal inventories,
worker/peer gaps and false qualification-exit claims. Native controls use installed
Chromium, a bounded public local HTTP fixture, and the existing pinned Node image
with no pull. They create labeled disposable Docker participants and remove them
with volumes. These are actual collector controls, NOT native marketplace parity
or a full campaign. End-to-end native app qualification/replay after owner
integration, broader CONTRIBUTING checks, documentation/changelog integration and
fresh independent review remain required before readiness. No full matrix, push,
cloud or new agent is started by these leaves/tests.
