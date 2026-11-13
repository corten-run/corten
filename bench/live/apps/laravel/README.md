# Native Laravel live recovery

Independent Laravel/Livewire/Reverb implementation of the synthetic recoverable
live workload. Shared-runner registration is separate from campaign admission,
a performance result or full-group readiness.
The fullstack Laravel marketplace application remains separate.
Historical receipts retain an automatic-reconnect 2000ms deadline miss and a
routed-close failure, not passes. Current replay avoids unnecessary already-seen
work; fresh checks remain subject to the same deadline, not a timing waiver.
The original German marketplace finding is separately open.

## Native Path

- Installed Livewire's ESM runtime, native component actions, Blade rendering,
  keyed rows and Livewire morphing own the DOM. The browser bridge never renders
  rows or imports the workload/oracle. Its observations read the actual DOM.
- Installed Echo/Pusher use an actual Reverb WebSocket and channel. Every event
  input crosses Reverb before the native Livewire action renders it. Native
  subscription acknowledgements and server open/close callbacks supply lifecycle
  evidence, not a second WebSocket implementation or EventSource substitute.
- FrankenPHP/Octane and Reverb are separate processes. Laravel file-cache locks
  protect cross-process synthetic state. Broadcast HTTP runs outside the state
  lock; a separate publication lock preserves publisher/broadcast ordering.
- Browser actions wait for the actual publisher HTTP acknowledgement before
  asking Livewire to morph a delivery. Concurrent publishers are serialized.
- Native state has acknowledged state plus at most one staged candidate. ACK,
  reconnect and resnapshot compare actual DOM cursor/count/row-count with those
  candidates. Snapshots preserve only observed applied effects, never turn source
  rows into effects, and cannot accept arbitrary counters. Repeated ACKs do not
  release unconsumed credit. Packets must match the original staged native
  delivery; resumed readers have distinct identities so superseded packets cannot
  mutate the new reader.
- The actual automatic native subscription callback resumes from the current
  observed cursor after initialization. Expired history and gaps resnapshot.
  Resume reconciles staged DOM evidence before replaying events strictly after
  that cursor. Re-rendering and acknowledging the already observed cursor first
  added two unnecessary native Livewire HTTP requests on the recovery path.
  Native duplicate controls still traverse Reverb and Livewire and suppress effects.

## Bounds And Cleanup

The two supported queue/history profiles are 2/4 and 1024/1025. Each reader has
one inflight event, one bounded replay copy and one overflow notification; history
and queue peaks are reported. There are at most 16 native connections/channels
and retained clients. Configuration accepts at most 1000 initial rows; the tested
workload uses five identities. These are synthetic application-state bounds, not
a claim that all framework/socket buffers or arbitrary source growth are bounded.

Random locked component identities isolate cookie-sharing tabs. Disconnect waits
for that consumer's native reader/socket/task/queue release. Detach also forgets
its retained candidate state. Unknown counts cannot establish zero resources.
Aggregate resources and per-consumer resources are both checked by the tests.
`nativeSocketBufferBytes` is explicitly null because Reverb's public API does not
expose it. PHP memory/rusage and the native process inventory are observations,
not an aggregate RSS measurement of all workers.

Synthetic `/parity/*` controls are intentionally unauthenticated. Real Livewire
actions retain native CSRF, locked properties and signed component snapshots;
cross-site writes are rejected. This is a local benchmark app, not a production
deployment or public service.

## Verification

From the repository root, build this directory's Dockerfile and run the image
locally. Against its base URL:

```sh
docker build -t native-laravel-live:current bench/live/apps/laravel
node --test bench/live/apps/laravel/test/wire.mjs
node bench/live/apps/laravel/test/native-limits.mjs BASE
node bench/live/apps/laravel/test/browser.mjs BASE
node bench/live/apps/laravel/test/adversarial.mjs BASE
node bench/live/apps/laravel/test/browser.mjs BASE native-feed normal,expired-cursor,slow-reader
```

Run `php test/store.php` and `php test/broker.php` inside the production image
(mount the local `test/` directory when testing an already-built image).
Test-only Event faking is confined to the store unit suite. The broker unit suite
uses the installed native channel manager/server with a low-level socket double
and checks actual pre-allocation bounds; the browser cap probe uses real sockets.
Browser tests otherwise use real Reverb,
Livewire HTTP, native morphs, HTTP writes/ACKs and independent DOM/oracle checks.
`wire.mjs` extracts original native packets without sorting or manufacturing
events. Browser raw receipts omit signed Livewire snapshots and CSRF material.

See [test/receipts/README.md](test/receipts/README.md) for the retained port's
original commands, results, failed routed-close proof and limits. Those are
historical app-local receipts, not qualification of this refreshed image.
No workload validator, assertion bound or deadline was relaxed.
The shared runner registers this port as `laravel-livewire`. It retains native
Livewire HTTP calls/effects and raw Reverb frames, binds their request/socket
identities and origins to the inspected container, and checks both against actual
DOM observations. Reverb overflow resources remain original wire evidence.
Only reusable signed component snapshots, CSRF values and cookies are omitted;
original-body digests/byte counts and unmodified effect HTML/dispatches remain.
Historical captured inventories are not upgraded by registration.

Production inputs were checked against official Packagist, npm, PHP, FrankenPHP,
Node and Docker metadata on 2026-11-13: Laravel 13.42.0, Livewire 4.4.8, Reverb
1.13.0, Octane 2.24.0, PHP 8.5.12, FrankenPHP 1.13.5, Node 26.13.1, Echo 2.6.3
and Pusher 8.6.0. The new image needs its own checks; old-image passes do not apply.

## Unreleased

Imported the retained native port, refreshed stable runtime/framework inputs,
registered its real HTTP/Reverb capture and removed redundant observed-cursor replay.
No general failed-Livewire-HTTP retry behavior or load/campaign qualification is
claimed. Fresh independent review and the full repository check matrix remain
outside this bounded owned-path checkpoint.

The native-feed profile remains unqualified. Its steady delivery path performs
three serialized HTTP operations per event: publication, native Livewire receive
and morph, then native Livewire acknowledgement of the observed DOM. The shared
driver waits for that acknowledgement before publishing the next steady event.
The four 1044-event steady journeys exhaust the unchanged 180000ms deadline while
still progressing; the expired-cursor/slow-reader cases snapshot-cover most of
the same published work and need only 18/20 individual native deliveries.
This is cumulative critical-path latency, not evidence of a stuck reconnect.
Moving the browser Linux-local, using memory-backed native file cache and running
Laravel's standard production optimizer were diagnostic isolation attempts, not
adopted repairs or qualification. None established that all six meet the deadline.
Failed shared captures now retain actual negative HTTP control responses and
native request-finished timing observations instead of discarding those controls
when the journey fails. These observations do not replace native wire/DOM evidence.
