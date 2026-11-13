# Native Rails live application

This is an independent Rails application. Action Cable owns its WebSocket,
channel actions and lifecycle; Rails ERB/Turbo helpers render native Turbo Stream
operations and the installed Turbo runtime applies every keyed DOM change. The
browser bridge only invokes native actions, observes actual DOM/effects, and
records the runner contract. There is no EventSource or shared renderer/store.

The Gemfile and lockfile retain the fullstack Rails application's existing native
dependency versions. No new library or broker is required. One Puma process uses
Action Cable's native asynchronous adapter, in one container. Multiple application
processes or instances are not supported by this synthetic in-memory store.

`/parity/configure`, `/parity/snapshot`, `/parity/resources`, `/parity/publish` and
`/parity/control` implement the synthetic control contract. Configuration refuses
connected readers. Publication validates its sequence before changing state.
Snapshot reads replace client rows without replaying effects. Native channel
actions keep one event in flight until the browser acknowledges its real Turbo
render. Each consumer has a bounded pending queue and a bounded replay copy;
overflow reports the actual saturation before clearing the queue and requesting
an authoritative resnapshot. Disconnect removes its reader; the native connection
close is separately counted. Up to 16 readers/retained client states are supported;
final detach explicitly clears its native client state, while forced disconnect
retains it for replay. Configuration clears inactive retained sessions.
Duplicate/gap detection happens against last-applied native client state, not the
workload oracle.

Supported explicit bounds: queue 2/history 4, or queue 1024/history 1025. Peaks are
updated at mutation time. Inventory includes retained client rows, replay copies,
in-flight work, native worker-pool size and actual Ruby CPU/GC counters. Native
socket bytes are not observable through Action Cable's public API and are marked
unknown, not zero. This does not establish load readiness, a TCP slow-reader bound,
multi-node behavior, authentication, or process-restart durability. Controls are
unauthenticated synthetic-data endpoints, not a deployment security policy.

Build from this directory using the Dockerfile. Run native unit checks with
`bundle exec ruby test/store_test.rb`. The runner owner registers this directory
with transport `Rails Action Cable / native Turbo Stream keyed updates`, image
`cb-parity-live-rails`, wire `rails-turbo`, and `wireModule: './apps/rails/wire.mjs'`.
`wire.mjs` only extracts original event/snapshot objects from captured native
Action Cable frames; it never produces application state or effects.

With the native container running, the independent app-local correctness check is
`node bench/live/apps/rails/test/browser.mjs http://localhost:8080` from the root.
It exercises all six bounded-profile fault scenarios and strictly checks actual
DOM/effects against captured raw Action Cable events/snapshots. It is not the
source-bound shared runner, does not qualify the larger native-feed profile or
fan-out measurements, and does not claim group readiness. The unit suite includes
four independent readers, real Turbo template rendering, native HTTP control
dispatch, expiry, duplicate/gap effects and real bounded queue saturation.

The publisher also accepts `{events:[...]}` as an ordinary bulk input, mutually
exclusive with `event`. It prevalidates every event (at most 1,044) and sequence
before mutation, serializes against other publishers, and calls the identical
native write/queue/history/consumer path for every event. `acks` contains each
actual write's sequence and resource counters. `liveApp.publishBatch` retains one
native arrival barrier until those individual acknowledgements are recorded.
This is for bounded fault setup, not measurement timing: default correctness and
all offered-load measurements retain individual HTTP requests. No renderer,
consumer work, history update or mutation-time instrumentation is bypassed.
