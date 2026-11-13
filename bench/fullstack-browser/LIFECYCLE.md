# Native lifecycle evidence proposal

This is an evidence proposal, not an approved oracle variant. Existing strict
`browser-journey-capture/v1` gates are unchanged. A document replaced by native navigation
still has unknown retired DOM/probe results, never fabricated zero resource counts.

## Receipts

The runner saves `native-browser-platform-lifetimes/v1` before harness context closure.
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

## Separately reviewed contract delta

A proposed alternative retirement record should retain old realm/context/unique/frame/loader
IDs; replacement frame/loader/default-context IDs; the actual destruction and commit receipts;
the pre-navigation owned/unattributed ledger; and fresh observation endpoints for every known
socket, stream, dedicated/shared/service worker target and upstream request. Missing discovery,
unmatched IDs, BFCache-frozen contexts, reused realms and target swaps without destruction must
not pass. BFCache requires its own policy and post-freeze/resume probes, not this proof.

The terminal strategy should use the unique-context constant-read probe, then a fresh complete
target/request/socket journal over the approved observation interval, before harness teardown.
All known old-loader requests need terminal receipts and upstream requests need actual terminal
server counters. A missing socket close or worker destruction stays unknown. No-event silence
cannot replace a missing native lifecycle endpoint, and page-session network silence cannot
prove worker-network silence. Only observations with declared complete relevant coverage can
support an absence-of-work claim.

It must explicitly mark retired DOM/resource/probe observations unavailable rather than fill
zeros. Any lingering/unowned process, worker network work, same-realm post-retirement callback,
DOM mutation or pending upstream work still blocks the relevant proof. Timing must end before
harness teardown. No such variant is implemented or accepted here; the parent owns a separate
shared-contract change and independent review.
