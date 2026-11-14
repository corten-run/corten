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

All response APIs bind `{requestId,responseSha256,path,status}`. Paths are public
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
