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
Duplicate/gap guards use acknowledged native client state, never a sent message
or workload oracle. One separately inventoried candidate is staged until the
browser acknowledges its actual DOM cursor, effect count and row count. Reconnect
reconciles the browser's previously observed state against the acknowledged or
staged candidate before suppressing any effect. The browser retains that actual
observation because a native LiveView remount replaces the old DOM before its hook
starts. A dropped event replays; an applied event with a dropped acknowledgement
does not increment the counter or append its effect twice.
Overlapping publication calls are serialized. Every attached publisher pauses
only its own native consumer using real LiveView actions, waits for preceding
native deliveries, and resumes credit after the HTTP acknowledgement. This is
required because LiveView patches the DOM before invoking the observation hook;
delaying a hook record alone would hide an already-visible update. Writes still
take the identical authoritative queue/history path, with normal bounded overflow.
The extra native action round trips are real application work, not excluded cost.

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
The per-page identity is explicit extra `live_session` state signed into LiveView's
native token; a later tab's cookie cannot replace it on reconnect. Ready messages
identify the consumer and resource inventory attributes actual readers, connections,
tasks and queue entries per identity. Teardown waits for that consumer while peers
remain active, then final all-reader cleanup separately requires aggregate zero.

Bounds are explicitly queue 2/history 4 or queue 1024/history 1025. Inventory
reports actual BEAM memory/runtime/process counts, source/client/replay rows,
in-flight work and store mailbox occupancy. Application queues are bounded;
kernel socket bytes and native transport buffering are not observable through
the LiveView public API and are marked unknown (`null`), not zero. Per-consumer
cleanup requires explicit numeric zeroes or absence from the complete native
consumer inventory; unknown counters cannot prove release. This does not establish
TCP slow-reader bounds, restart durability, distributed operation or load readiness.

Runtime inputs were refreshed on 2026-11-13 against official Elixir/OTP releases,
Hex package metadata, esbuild metadata and Docker image manifests: Elixir 1.20.5,
OTP 29.1.2, Phoenix 1.8.16, LiveView 1.2.13, Phoenix HTML 4.4.0, Bandit 1.14.1
and esbuild 0.28.2. Builder and runtime bases are digest-pinned. The independent
native lock was regenerated with Mix on that Elixir image, removing unused
inherited fullstack entries. No new library is introduced.
The Dockerfile builds a normal production OTP
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
the original event/snapshot/resource objects in native arrival order, without
manufacturing observations or reading HTTP publisher/resource responses.

`node bench/live/apps/phoenix/test/adversarial.mjs http://127.0.0.1:8080`
intercepts the actual WebSocket to drop the first native event or its browser
acknowledgement, requires recovery within two seconds, and independently checks
two pages sharing one browser cookie jar. These are correctness regressions, not
load qualification or measurement admission.
It also reconnects/detaches one page while its peer keeps receiving and withholds
the first HTTP acknowledgement/native event during overlapping publication calls.

Snapshot requests reconcile the last actual browser observation against only the
acknowledged state or its single staged candidate before replacing rows. The
saved observation is also used after an expired-cursor remount, whose new DOM is
not the old browser state. Overflow after a lost acknowledgement preserves an
already-applied effect; an unobserved delivery contributes none. Unmatched
counters/cursors/row counts fail before snapshot reads or state mutation.
`node bench/live/apps/phoenix/test/recovery.mjs <base>` drops actual native
event/ACK frames, overflows the bounded queue, checks source rows and visible
effects, and verifies duplicate suppression and subsequent progress.
Raw before/after receipts are in `test/receipts/`. Those receipts are historical
and do not qualify refreshed runtime images. New runtime checks retain separate
local, hashed raw attempts bound to exact sources and images, including failures.
All six bounded journeys retain their 45-second whole-journey deadline; the
adversarial/recovery controls retain their two-second recovery and five-second
cleanup gates. These are bounded correctness observations, not throughput
measurements, native-feed qualification or load admission.
