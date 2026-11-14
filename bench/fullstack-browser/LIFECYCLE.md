# Native lifecycle evidence proposal

This is an evidence proposal, not an approved oracle variant. Existing strict
`browser-journey-capture/v1` gates are unchanged. A document replaced by native navigation
still has unknown retired DOM/probe results, never fabricated zero resource counts.

## Receipts

The runner saves `native-browser-platform-lifetimes/v2` before harness context closure.
`harnessClosedLifecycle` is a separate journal after that closure and cannot certify native
navigation cleanup. CDP sessions are local to the runner's owned Chromium browser.

- `Runtime.executionContextCreated`: context ID, unique ID, default-world flag, frame ID.
- `Runtime.executionContextDestroyed`: context ID and unique ID when supplied.
- `Runtime.executionContextsCleared`: the exact previously observed live IDs at that event.
- `Page.frameNavigated`: frame/parent/loader IDs, URL scheme and public pathname.
- `Page.frameDetached`: frame ID and the native remove/swap reason.
- A fixed read in a specific live default context associates the instrumentation's actual
  random realm ID with that context and the observed frame/loader. Failed reads stay failures.
- A terminal `Runtime.evaluate` of the constant `1` addresses the observed **unique** context
  ID, never a possibly reused numeric ID. Only the specific context-not-found protocol result
  is recorded as such. A live result, missing association or any other error cannot prove
  destruction. This read is not an event probe and does not change oracle acceptance.
- `Network.webSocketCreated`, handshake response status and `webSocketClosed`, correlated by
  native request ID; no request/response headers, payloads or query tokens are saved.
- All page request/frame/loader IDs, resource type (including EventSource), method/public
  pathname, response status and native loading-finished/failed receipts. Worker networking
  is not included in that page session's coverage.
- Browser `Target.targetCreated`, `targetInfoChanged`, `targetDestroyed`: target ID, type,
  browser-context ID and opener ID when available. No auto-attach pause or target termination.

## What this proves

Matched default-context destruction or a context-cleared receipt plus a committed replacement
loader can prove platform replacement of that observed realm. It cannot prove an event was
dispatched into the destroyed realm, read a fresh retired DOM or show its resource counts.
A WebSocket close receipt proves Chromium observed that socket close, not server peer cleanup.
A destroyed dedicated-worker target proves that target ended; absent receipts remain unknown.
Shared/service worker targets may outlive a document. Discovery is not proof of document
ownership, and page Network events do not enumerate worker-owned sockets. No browser global,
delegated framework listener or persistent worker is silently exempted from resource gates.

## Owned pure validators

`validatePlatformRetirement(journal, { realm, retiredAt, observationMs: 250, maxProbeMs: 1000 })`
returns `native-platform-retirement-proof/v1` with `outcome: proved|unknown|failed` and exact
binding/destruction/replacement/probe/request/socket receipts. `retiredAt` is an actual host
navigation-dispatch observation in the journal's `node.performance.now` clock. This is a
separate evidence predicate, not shared-oracle acceptance or native qualification.

The v2 journal includes successful Runtime/Page/Network enable receipts, browser target
discovery, initial and terminal `Target.getTargets` inventories and continuously observed
execution contexts. CDP has no separate query for all live page execution contexts: the
context inventory is explicitly derived from Runtime.enable enumeration and continuous
created/destroyed/cleared events. The validator reconciles both inventories against those
events. Coverage/session failures, missing unique identities, other same-context page/iframe
targets, child-frame contexts or any application-context dedicated/shared/service worker
target make proof unknown. Unknown browser-context ownership is not assumed unrelated.
Targets explicitly assigned to another browser context are not charged to this consumer.

The realm association itself reads the actual observer realm using `uniqueContextId`, not
a recyclable numeric context ID. A matched destruction/clear plus a different committed
loader and default context is required. BFCache/swap-only evidence cannot pass. The final
constant-read probe records both start and completion times; exact context-not-found must
complete within its declared bound in the terminal observation interval. Live execution
fails; timeout, generic protocol/session errors and absent evidence are unknown.

Every page-network dispatch retains native request/frame/loader IDs, parser initiator,
document path, redirect status and terminal success/failure receipt. Failed requests remain
in `nativeFailures`, never become successful work. The predicate requires terminal page
requests and socket close receipts; an open page socket has unknown initiator ownership,
not an infrastructure exemption. Old-loader dispatch after destruction fails. This proves
neither native functional parity nor server peer closure, upstream cancellation, fresh
retired DOM, zero resources or a retired event probe.

`classifyNoJSRequests(journal)` returns `native-no-js-request-proof/v1`, retaining every
request and native failure. It binds actual script-disabled context configuration, native
document/frame/loader, CDP parser initiator, DOM stylesheet/image/preload declarations and
observed header/meta CSP facts. Parser assets require direct parser provenance or a known
stylesheet initiator. The existing strict intentional-disabled-preload predicate remains
unchanged; Chromium can report its initiator as script/about:blank, which is retained, not
relabeled parser. A real CSP, unbound request, unrelated abort or application transport is
not classified away. Neither validator filters the strict export or changes qualification.
Document classification also requires its own matched frame/loader/status response receipt
(or native redirect receipt); absent responses remain unknown even in a document-only ledger.
Asset classification cannot borrow an unverified document's CSP/ownership facts.
Both validators reconcile every observed HTTP commit's frame/loader/path with its final
native document request, response and loading-finished receipt, preserving redirect hops.
Every successful asset needs its own ordered, identity-matched response and terminal receipt.
Missing whole network streams, missing committed loaders and deleted asset responses are
unknown coverage, not proof of no work. Page/Network enable receipts are required as well as
the declared coverage flags. The Chromium apparatus tests exercise these deletions against
actual journals and keep intact native redirect/parser/preload cases positive.
Reconciliation is bidirectional: every completed HTTP document and parser inventory also
needs its unique matching native commit. Empty commit streams cannot classify no-JS work.
A redirect continuation requires its preceding dispatch under the same request/frame/loader/
resource identity and the actual CDP `redirectResponse` URL hash, public path/scheme and status.
The hash binds the complete URL without retaining its query or headers. URL equality alone
does not identify a dispatch when a chain revisits the exact same URL. The journal separately
retains each native `Network.requestWillBeSentExtraInfo.connectTiming.requestTime`, but no
cookies or headers from that event. Ordered, unique network-stack receipts must account for
every dispatch in the request-ID chain; each redirect response's native `requestTime` must
match its preceding dispatch's independent receipt, with native `redirectHasExtraInfo` true.
It is not assumed equal to `requestWillBeSent.timestamp`. Missing, extra or ambiguous receipts
make the link unknown and cannot assign a later hop's response to an earlier dispatch.
Reused IDs and a continuation's status alone cannot identify an immediate predecessor. Missing
new identity/timing receipts in historical journals stay unknown; no saved journal is upgraded.
Mandatory dispatch, response, terminal and parser fields and their observation ordering are checked.
Observed stylesheet/image/script-preload declarations require matching native dispatches;
Only identical complete-URL hashes may share a coalesced request; path equality cannot merge
query-distinct resources. `recordDocument` starts a bounded read-only parser URL observation
using the actual realm's unique native context ID. It verifies the observer realm, scope,
document path and full declaration lists against the captured DOM before retaining URL hashes
and start/finish times. Complete URLs exist transiently in observer memory, not the journal.
Terminal observation drains these pending reads. A replacement realm, changed declarations,
failed read or missing identity remains unknown rather than borrowing another document's data.
Parser ownership, preload matching and stylesheet initiators use query-sensitive hashes too.
Deleted asset streams remain unknown.
Unobserved or cross-origin asset coverage is not invented from a DOM declaration.

Initial and terminal CDP `Performance.getMetrics` Timestamp samples retain their host round-trip
bounds. Native request/response/terminal timestamps must lie inside that monotonic interval and
the initial host/native clock-offset envelope. Each continuation must not precede its predecessor
dispatch. Native response timing retains `requestTime` and `receiveHeadersEnd`; the observed
header completion must follow dispatch and precede transfer finish or redirect continuation.
`responseReceived.timestamp` is notification time, which Chromium can report after native
`loadingFinished.timestamp`; it is not substituted for the actual header-completion timestamp.
Its own native time still must follow dispatch and header completion and precede its bounded
host delivery. No arbitrary clock epsilon or missing-timing fallback supplies proof.

Socket creation identities must be unique, and handshake/close receipts must conserve that
identity exactly once in observation order. A handshake after close, duplicate receipt,
missing native timestamp, backwards handshake/close time or time outside the same bounded
native-clock envelope leaves proof unknown. Creation has no native CDP timestamp, so its host
receipt is checked against the observation bounds and the subsequent handshake/close receipts;
no creation timestamp is invented. Handshake status must be a native HTTP status, not an
assumed successful upgrade. Socket receipts outside the observation interval cannot be dropped
to manufacture a positive proof. `row7.test.mjs` applies these mutations to an actual closed
Chromium socket and keeps the intact journal positive and unchanged. This is still not server
peer-closure evidence or a shared-oracle waiver.

Raw journey sidecars include `platformRetirementProofs`, `platformCleanupProof` when relevant,
and `noJSRequestProof` for no-JS profiles. Strict captures still use the unchanged oracle.

## Separately reviewed contract delta

A proposed alternative retirement record should retain old realm/context/unique/frame/loader
IDs; replacement frame/loader/default-context IDs; the actual destruction and commit receipts;
the pre-navigation owned/unattributed ledger; and fresh observation endpoints for every known
socket, stream, dedicated/shared/service worker target and upstream request. Missing discovery,
unmatched IDs, BFCache-frozen contexts, reused realms and target swaps without destruction must
not pass. BFCache requires its own policy and post-freeze/resume probes, not this proof.

The terminal strategy should use the unique-context constant-read probe, then a fresh complete
target/request/socket journal over the approved observation interval, before harness teardown.
All known old-loader requests need terminal receipts. `upstreamLedger` now retains and
reconciles actual numeric-source counters through actions, mutation probes, cleanup and the
final pre-harness interval, using stable source/request IDs and append-only snapshot checks.
Its terminal finish/close receipts are not application-server socket peer closure. Missing
phases, pending work, changed history and new requests outside the recorded phases stay unknown.
The final browser request ledger is also checked against every action and cleanup assignment
before export; a late failed POST or body-capture error cannot disappear in projection.
A missing socket close or worker destruction stays unknown. No-event silence
cannot replace a missing native lifecycle endpoint, and page-session network silence cannot
prove worker-network silence. Only observations with declared complete relevant coverage can
support an absence-of-work claim.

It must explicitly mark retired DOM/resource/probe observations unavailable rather than fill
zeros. Any lingering/unowned process, worker network work, same-realm post-retirement callback,
DOM mutation or pending upstream work still blocks the relevant proof. Timing must end before
harness teardown. No such variant is implemented or accepted here; the parent owns a separate
shared-contract change and independent review.

Complete target discovery starting before app execution, with no worker target in the app's
browser context throughout the interval, could establish that worker-network coverage is not
applicable. That is different from assuming unknown workers are absent. Existing targets,
unknown browser-context ownership, discovery gaps and targets without terminal receipts need
an explicit outcome; a persistent framework worker is not an automatic exemption. A final
target inventory is now captured and reconciled by the owned pure predicate above. Peer-side
stream/socket receipts remain unimplemented, explicitly unclaimed evidence endpoints.

## No-JS request boundary

The unchanged oracle currently requires every no-JS request to have transport `document`.
Real no-JS Chromium also makes parser stylesheet requests and reports intentionally blocked
script/module preloads. The raw ledger preserves resource type, content type, native failure,
CSP/DOM preload evidence and completion; the strict exporter does not delete these requests.
Thus admitting platform-destroyed retirement alone will not resolve this second mismatch.

A separately reviewed request variant should distinguish native document navigation/form
POSTs, parser assets and application fetch/router requests. All no-JS workload actions still
need native documents and no application JS transport. Parser assets require actual resource
and document/stylesheet provenance; intentionally disabled script preloads require the existing
strict script-disabled/CSP/preload proof, not a general aborted-request exception. Keep every
failed/unfinished request in the complete ledger, with its native outcome, and explicitly
reject unrelated aborts, missing document errors, unbound data fetches and body-capture errors.

## Bounded native observations

`work/lifecycle/w25/summary.json` records four fixture profiles and 44 actual actions against
clean Nuxt/React Router images built at `f1974c056`. Both React Router profiles and Nuxt mobile
no-JS passed functional checks, not qualification. Nuxt JS retained a build-manifest request
that did not complete within the action deadline. Its retired native form also issued an
actual POST `/api/marketplace/item_1` during the detached event probe (status 200); the ledger
retained one listener and one pending task. This is post-retirement application work to review
at `bench/fullstack/apps/nuxt/app/pages/marketplace/[locale]/[id].vue` (`submitAlert`), separate
from document-level framework infrastructure and the full-navigation contract boundary.

The journal's old-unique-context probes observed context-not-found while DOM/resource/event
probe fields for destroyed realms remained unavailable. `captures/manifest.json` validates all
ten strict files with all 24 profiles retained; none is a fully captured passing group. No
full matrix, comparative timing, readiness waiver or shared-oracle edit was performed.

`work/lifecycle/w27/summary.json` additionally records the v2 journal against a clean native
React Router image at `7bc125b86`: one `fixture-en-US-mobile-no-js` profile, 11 real actions,
passing functional/DOM checks, ten journey retirement predicates plus final platform cleanup
proved. The parser classifier retained all 94 page requests: 12 documents, 34 parser assets
and 48 intentionally disabled preloads with their actual native failed receipts intact.
The previous w26 journal retains six unknown final-landing-page requests; w27 adds an actual
observation of that destination's asset declarations rather than rewriting the older evidence.
Both strict qualification and readiness remain false under the unchanged shared oracle.

An actual w27 final-retirement binding is realm 141126c267d610f425689bf03b2f4178, numeric
context 25, unique context `2126592634671779275.-3616000808792517322`, frame
`0AF45C70B00A677D06713438510E6BD2`, loader `E1CCAD96F844BB05EF0BEA3956006FFE`.
`Runtime.executionContextsCleared` contains that exact numeric/unique pair. The same frame
commits loader `4211239077BBF319B2F22F188D3F39DD` at `/`, with default context 27 and unique
context `4200417748653844733.-802785212106649483`. The terminal old-unique-context read records
the exact native context-not-found error between host times 32532.7889 and 32535.1054 ms,
inside its 1000 ms deadline and before harness closure. These identities are observed native
receipts, not synthetic resource counts or a successful event probe in a dead realm.
