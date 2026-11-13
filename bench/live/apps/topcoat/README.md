# Native Topcoat live port

Independent Topcoat 0.12.1 application. Native `#[page]`, `#[shard]`,
`#[component]`, `signal`, keyed components, `live!`, `connected` and `emit!`
own the initial HTML, signal-driven connection controls, live rendering and
visible effect counter. Topcoat's own browser runtime establishes its WebSocket
and applies native snapshot/swap frames. The observation bridge invokes native
signal handlers and reads the actual DOM and original WebSockets. It neither
renders rows nor imports the offline workload/oracle. No generic JavaScript
renderer or custom WebSocket transport is served under the framework's name.

Topcoat provides live rendering, not a recoverable keyed feed. The app-local
store supplies ordered source rows, retained replay, sequence/duplicate guards,
authoritative snapshots and bounded Tokio `mpsc` readers. Existing upserts keep
their position; remove/reinsert appends. The native component increments its
counter only on an accepted event, never on snapshots, duplicates or gaps.
Replay includes the retained boundary so duplicate rejection is observable.
Expired cursors, gaps and held-consumer overflow resnapshot from the real source.

The configure/snapshot/resources/publish/control interface follows
`../../PORTS.md`. `GET /parity/snapshot?client=...` additionally schedules that
authoritative snapshot through the client's native live render. The conventional
HTTP snapshot and native snapshot must match in the browser tests. Additional
app-local acknowledge/finish endpoints acknowledge an observed native emission
and discard a disconnected client's retained state. A reader-local status endpoint
reports the actual lease and unchanged aggregate counters so a healthy peer does
not block another reader's detach. Native `live!` owns a RAII
subscription lease; shard cancellation or actual socket closure drops that lease
and its channel and replay. Rendering prepares one pending client state; only the
browser's application acknowledgement commits retained rows, cursor and counter.
Cancellation cannot promote an unobserved frame into a duplicate resume boundary.
Before reconnect the bridge reconciles its last actually observed serial, making
lost ACK responses idempotent and allowing a delayed ACK after native cancellation.
An unobserved pending state is discarded on reconnect and replayed from the
confirmed cursor, or covered by an authoritative snapshot after history expiry.
Snapshots themselves are also pending until observed and acknowledged.
Final detach changes the native active
signal, waits for native render cancellation AND actual WebSocket closure, then
removes retained client state. It preserves the last visible DOM for quiescence.
The observer disconnects and restores the original browser WebSocket constructor.

Only queue/history 2/4 and 1024/1025 are accepted. History evicts before insert.
Mutation-time peaks count actual native channel occupancy and retained history.
Hold stops server dequeueing; overflow captures saturated counters before clearing
pending events. The native-feed batch validates all 1 to 1,044 events before any
mutation, then applies the identical write path and records each real ack.
Native emission itself waits for an app-local publisher-ack endpoint called only
after the browser consumes and records the real publisher HTTP ack. This is
necessary because Topcoat mutates the DOM before an observer runs; delaying only
the observer would hide an early visible effect. Concurrent HTTP writes reserve
cumulative acknowledgement fences. The source retains one acknowledgement cursor,
not an unbounded list of gates. Direct synthetic HTTP publishers must also advance
that cursor. The original native arrival timestamps are retained separately.
The cursor confirms the entire observed prefix from the single benchmark
publisher; independent publishers coordinating separate prefixes are not modeled.

Ordinary page GETs issue only a scalar identity and retain no client rows. First
live attach allocates a session, capped at 16 including inactive reconnect state.
Disconnected or prepared-but-never-attached sessions expire after 30 seconds;
one process-owned native Tokio interval physically removes them within the next
second, without a browser finish request or a resource-query side effect. Active
leases do not expire. Admission also reaps expired sessions. Reconnect inside
the grace retains confirmed state; reconnect after expiry fails explicitly with
HTTP 410 rather than silently inventing an initial effect count. Reload starts
a fresh page identity. Capacity may reject new live attaches while all 16 session
slots remain legitimately active or inside their bounded reconnect grace.

Every native shard rerun carries the emission serial read from the actual native
screen through Topcoat's `Expr`/`Js` argument facility. The server validates and
acknowledges that serial before rendering or subscribing. This covers native
automatic socket retries and the inactive render as well as explicit reconnect:
an inbound delayed HTTP ACK becomes idempotent, and cancellation renders the
actually observed screen instead of older confirmed rows. No rows or effect
counts are supplied by the observer. A new native ready starts a fresh ordered
observation generation; errors from a previous connection cannot poison it.
Detach continues recording already received native emissions until cleanup ends,
then disconnects the observer, within the unchanged cleanup deadline.
DOM observations are recorded in arrival order independently of HTTP ACK response
completion, including when a successfully accepted ACK response is later lost.
Each native ready retires and aborts the previous ACK request generation. Its
pending or failed requests cannot delay or reject the new generation. Settling
and cleanup drain current observations and requests; cleanup includes the final
finish HTTP request under the same deadline and AbortSignal. A failed finish
reports failure and may leave only the disclosed finite reconnect retention.
Row DOM IDs use an injective base64 encoding in a separate `listing-row-`
namespace; original application keys remain unchanged, including keys matching
control or diagnostic IDs. Topcoat's native keyed morph still owns the rows.

Bounds are 16 registered clients/readers and 1,000 source rows. Each reader owns
one bounded channel, at most `historyLimit` replay entries, one ready, snapshot
and overflow slot, and at most one unacknowledged native emission. Acknowledging
only after a DOM observation prevents diagnostic swaps from outrunning the
observer; this is application flow control, not a framework feed feature.
Each session retains its confirmed rows plus at most one pending render state,
including while disconnected. Inventory includes both sets of retained rows and
the process-owned retention task/timer; reader task counts do not include that
separately disclosed process-lifetime sweeper. Shutdown aborts and joins it.
Both publication acknowledgement gating and emission acknowledgement flow control
are app-local facilities, not claims of framework-provided recoverable feeds.
Cleanup includes ordered observation work in the original cleanup deadline, aborts
its own resource request and clears its timers even when a real acknowledgement
is withheld. A failed cleanup leaves at most the already bounded retained client
state until its reconnect grace expires, explicit finish or configure; it does
not report fabricated zeros.
Topcoat 0.12.1's native socket forwarder has a 16-message output channel and one
writer-held message. Its transport buffer bytes and kernel socket memory are
explicitly unknown. Resource connection/task counts describe active app leases,
not every framework task or arbitrary unauthenticated inbound socket. Process
RSS, peak RSS and CPU ticks come from `/proc/self`, not estimated fixture values.

One process, no broker/database. The synthetic publisher/control API and client
ids are deliberately unauthenticated, not production authorization. Disconnected
client state is bounded and expires after the reconnect grace; it has
no restart durability or distributed replay. Hold models a slow native consumer,
not TCP backpressure. Diagnostic browser records are retained for the bounded
test, not a production telemetry store. No throughput, comparative ranking,
performance, cost, cloud qualification or registry admission is claimed.
Docker builds the native application with `cargo build --release --locked`, using
Cargo's standard release optimization (`opt-level=3`) without an optimization
override. Assets are bundled with `topcoat asset bundle --release`. Base images
and build frontend are digest-pinned, and SDK/CLI versions are locked. Earlier
`opt-level=1` images and captures are functional diagnostics only; they do not
qualify this production candidate. A fresh production image must pass its own
native/browser gates before any measurement or qualification claim.
The [SDK](https://crates.io/api/v1/crates/topcoat) and
[CLI](https://crates.io/api/v1/crates/topcoat-cli) pins were checked against the
official registry on 2026-11-13: both 0.12.1 releases were non-yanked and the latest
stable versions, with Rust 1.99 required. Components receive the native `Cx`;
application state uses `context` and router `with`, and the native runtime uses
`RuntimeLayer`. The pinned runtime source retains the run/frame envelope, native
retry behavior and bounded socket forwarder used by this adapter.

Build from this app-local context and install the repository's Playwright tooling:

```sh
docker build -t live-parity-topcoat bench/live/apps/topcoat
cargo test --manifest-path bench/live/apps/topcoat/Cargo.toml --locked
cargo clippy --manifest-path bench/live/apps/topcoat/Cargo.toml --all-targets --locked -- -D warnings
node --test bench/live/apps/topcoat/test/wire.test.mjs
node bench/live/apps/topcoat/test/regressions.mjs http://127.0.0.1:8080
node bench/live/apps/topcoat/test/lifetimes.mjs http://127.0.0.1:8080
node bench/live/apps/topcoat/test/edges.mjs http://127.0.0.1:8080
node bench/live/apps/topcoat/test/http.mjs http://127.0.0.1:8080
node bench/live/apps/topcoat/test/browser.mjs http://127.0.0.1:8080 bounded
node bench/live/apps/topcoat/test/browser.mjs http://127.0.0.1:8080 native-feed
node bench/live/apps/topcoat/test/browser.mjs http://127.0.0.1:8080 bounded normal,slow-reader live-delivery
node bench/live/apps/topcoat/test/browser.mjs http://127.0.0.1:8080 native-feed normal,slow-reader live-delivery
```

Optional `LIVE_EVIDENCE` writes compressed actual native frames, HTTP bodies,
traces and final HTML, refusing to overwrite an existing capture. Browser tests
cover all six fault journeys in each profile, no-JavaScript initial HTML, ordered
visible rows, independent native effect counts, duplicate rejection, recovery,
native socket closure and post-detach silence. The HTTP/browser test opens 16
real native readers, saturates their actual queues, rejects excess clients and
verifies abrupt context cancellation and retained-client cleanup. Rust tests
cover atomic invalid batches, finite history, ordered remove/reinsert, duplicate
and gap guards, replay expiry, overflow, native publisher gating and RAII lease
cleanup. Dedicated browser regressions delay real publisher and emission HTTP
responses, verify native DOM silence before the publisher acknowledgement, and
exercise reader-local detach with a healthy peer and unchanged cleanup deadlines.
Lifetime tests withhold an original native event frame across cancellation and
reconnect, abort an old application ACK while the new native ready frame is held
to verify handshake isolation, hold an inbound ACK across automatic native socket
retry and successful detach to verify no visible rollback, verify complete
ordinary GETs retain no sessions, and close a real
browser abruptly without finish to verify actual timed retention expiry.
For source/image/deployment binding, label a fresh build `bench.source-sha256`
with the output of `test/regressions.mjs --source-hash` and set `LIVE_CONTAINER`
to that container when running the regressions. This is full-context local
functional provenance, not exact-commit or performance qualification.

Integration belongs to the owner of `native.mjs`. Register both profiles with
`directory: 'topcoat'`, this app-local Docker context, transport
`Topcoat native keyed components / live! and emit! / runtime WebSocket`,
`wire: 'topcoat-live'`, `wireModule: './apps/topcoat/wire.mjs'`. The wire binding
validates native run/frame envelopes and the exact app-owned serialized diagnostic
element grammar, then preserves the event/snapshot unchanged. It does not search
arbitrary payload strings for fixture events. No runner, registry, other app or
native fullstack implementation is changed by this port.
