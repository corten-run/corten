# Native Phoenix LiveView application

This independent Phoenix application uses an installed Phoenix LiveView screen,
native HEEx keyed streams, the native LiveSocket client, and Phoenix WebSockets.
LiveView renders and patches every row and the independent visible effect
counter. The browser bridge invokes native lifecycle/actions and observes actual
DOM state; it is not a renderer or an EventSource substitute.
The control hook is a sibling of the rendered table: native hook-event loading
locks must not defer the table's stream patches while requesting a resnapshot.

A supervised GenServer serializes authoritative writes and validates complete
single/bulk requests before mutation. Each native connected LiveView process is
monitored, owns a bounded consumer queue and bounded replay copy, and has one
delivery in flight until the browser acknowledges the native DOM patch. Hold,
drop and duplicate controls affect actual native deliveries. Overflow captures
the saturation counters before clearing pending work and requesting a native
authoritative resnapshot. Snapshot replacements do not increment event effects.
Duplicate/gap guards use retained native client state, never a workload oracle.

The ordinary Phoenix router/controller JSON endpoints implement configure,
snapshot, resources, publish and control. Snapshot reads are independent reads,
not POST echoes or resets. Configure refuses connected readers. Bulk publication
accepts 1 to 1,044 events, is mutually exclusive with a single event, prevalidates
all sequences/shapes, and invokes the identical native mutation/queue path per
write, retaining each actual acknowledgement and mutation-time resource peak.
Only fault setup uses bulk in the runner; measurements use individual HTTP writes.

There is one BEAM/Bandit process, native PubSub, no external broker/database, and
at most 16 retained clients/readers. Each page receives its own cryptographically
random native signed LiveView session identity, including tabs sharing a cookie
jar. Forced disconnect retains last-applied client state for replay; final detach
deletes it, and process monitors remove readers/connections. Native CSRF/session
and WebSocket origin checks remain enabled. Synthetic publisher/control endpoints
are deliberately unauthenticated, not a production authorization policy.

Bounds are explicitly queue 2/history 4 or queue 1024/history 1025. Inventory
reports actual BEAM memory/runtime/process counts, source/client/replay rows,
in-flight work and store mailbox occupancy. Application queues are bounded;
kernel socket bytes and native transport buffering are not observable through
the LiveView public API and are marked unknown, not zero. This does not establish
TCP slow-reader bounds, restart durability, distributed operation or load readiness.

Dependencies retain the fullstack Phoenix lock's existing versions. No new
library is introduced; unrelated fullstack CLDR/HTTP-client dependencies are not
runtime dependencies of this app. The Dockerfile builds a normal production OTP
release, serves standard esbuild-bundled installed Phoenix/LiveView clients, and
runs as a non-root user. `ERL_FLAGS` bounds VM scheduler threads in both build and
runtime, without changing publication, rendering or recovery semantics.

Build from this directory with its Dockerfile. Run native checks in its `build`
stage with `PHX_SERVER=false mix run test/store_test.exs`. With the native release
running, from the repository root run
`node bench/live/apps/phoenix/test/browser.mjs http://127.0.0.1:8080`.
The app-local browser check compares actual DOM/effects and every HTTP write/ack
against captured raw native LiveView event/snapshot envelopes. Its oracle is
offline test code only. It does not claim shared-runner or measurement admission.

The integration owner registers `directory: 'phoenix'`,
`transport: 'Phoenix LiveView / native HEEx keyed streams'`,
`wire: 'phoenix-liveview'`, `wireModule: './apps/phoenix/wire.mjs'`, and topology
`one BEAM/Bandit process with native LiveView/PubSub; no external broker/database`.
The wire binding checks native Phoenix v2 LiveView diff/reply envelopes and returns
the original event/snapshot objects without manufacturing observations.
