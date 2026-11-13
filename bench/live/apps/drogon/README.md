# Native Drogon live application

This independent C++17 application uses Drogon 1.9.14's HTTP router and native
`WebSocketController` / `WebSocketConnection::send`. The browser uses the platform
WebSocket API and its own keyed table DOM, cloning a server-provided row template.
It does not run Express, EventSource, a shared renderer/store, or the offline
benchmark oracle. The first HTTP page renders the authoritative rows on the
server, including safe HTML attribute/text escaping. Ordinary upserts preserve
the keyed DOM node; removes delete it and reinserts create a new node.

The shared native runner registers this port for both bounded and native-feed
profiles. Its wire binding extracts original ready/overflow resource receipts
and resume metadata as well as events and snapshots. Registration is not group
qualification: the runner still requires the complete native evidence gates.
Older captures keep their recorded missing-port outcome after registration.

## Protocol

The HTTP controls are `/parity/configure`, `/parity/publish`, `/parity/control`,
`/parity/snapshot` and `/parity/resources`, as specified in `../../PORTS.md`.
Configuration refuses live readers. Snapshot is an independent authoritative
read, returning `{through,rows,work:{reads:1,rows:N}}`. Sequence and entire input
shape validation happen before mutation. A mutex serializes publication,
attachment/replay fencing, snapshots and acknowledgement transitions.

`/parity/socket?from=N` is a native Drogon WebSocket, not an SSE compatibility
endpoint. Text JSON envelopes identify `protocol: "drogon-live/v1"` and `kind`:

- `ready`: native `readerId`, `from`, `status: "accepted" | "expired"`, actual `resources`.
- `event`: original `event` and monotonically increasing per-socket `delivery`.
- `overflow`: `outcome: "resnapshot"`, `delivery`, and the actual saturated
  mutation-time `resources`, captured before clearing pending payloads.

After ready, the browser obtains its initial/expired snapshot if necessary and
sends `{kind:"start",through,snapshot:boolean}`. An accepted reconnect instead
uses bounded history, including the cursor event when retained: its duplicate
must be observed but cannot apply an effect. A snapshot replaces all rows without
invoking event effects. A gap is observed, not silently repaired as an event.
After each delivery the browser sends `{kind:"ack",delivery,through,snapshot}`,
only after its actual DOM/effect update or authoritative recovery snapshot.
Only that acknowledgement permits another native event/overflow frame. Snapshot
acknowledgements discard only queued/replayed writes covered by their cursor.
Post-snapshot writes remain pending; a later overflow remains visible.

Hold pauses each actual server consumer, not just the browser trace. Drop removes
one native delivery while preserving its authoritative write/history. Duplicate
enqueues the actual last write again. Overflow captures saturation, releases the
held consumer, and requests a resnapshot. Disconnect/native close callbacks erase
the reader, queue, replay and in-flight state; detach also closes the browser
socket. `pagehide` closes it on navigation. There are no retained sessions,
external brokers, background publishers or per-reader worker threads.

The ready frame's server-assigned identity is monotonic across configuration
resets. `GET /parity/resources?reader=ID` adds a `reader` observation from the actual
consumer map: id, subscriptions, connections, pendingTasks, queueEvents,
replayEvents and inFlight. Top-level counters remain the unmodified aggregate,
including other healthy readers. Cleanup waits for this reader alone, only after
native connection closure. It does not close or wait for unrelated readers.

Closure before a ready frame has no known reader identity. The browser retains
the actual `CloseEvent` URL, code, reason and `wasClean` as `socket-close` in
`liveApp.transportRecords`, separate from normalized capture records and the
retained original failure. Disconnect/detach/reconnect can finish that attempt's
cleanup only after this terminal event and a CLOSED browser socket, recording
`transport-released` with scope `browser-socket`. This is transport-only proof,
not a server reader-resource observation: unknown inventory is never reported as
zero or queried under an invented identity. The native 16-reader capacity refusal
closes with code 1008 and reason `reader limit`, without a ready frame or admitted
consumer. After capacity is freed, the same page can explicitly reconnect and
resnapshot; admitted attempts still require actual identity-scoped cleanup.

A failed delivery/snapshot is retained as a `failure` record and a browser error;
`settle()` rejects that original failure until an explicit reconnect. The failed
native consumer is closed without acknowledging the unsuccessful delivery.
Disconnect/detach still drain and release it. A reconnect starts a fresh scheduling
chain after own cleanup, performs an actual authoritative resnapshot if recovery
failed, and resumes ordinary consumption. Earlier failure evidence is not erased
or converted into success, and snapshots never manufacture per-event effects.

The publisher accepts exactly one `event`, or (only in explicit native-feed
configuration) `events` of length 1 to 1,044. It prevalidates every shape,
consecutive sequence and intermediate row budget before the first write. Both
forms call the same mutation/history/queue/delivery path per event. The batch
response contains each actual write's acknowledgement/resources. The browser
records all those acknowledgements behind one publication barrier before
applying queued native effects. Concurrent browser publication calls are
serialized through their actual HTTP response/acknowledgement, so a later call
cannot overwrite an earlier write's delivery barrier. Each caller still receives
its own real success or rejection; a rejected call cannot poison later calls.
Individual publications remain individual HTTP
requests, including normal delivery and all measured publications. Bulk input is
only for constructing the larger recovery fault, never for timing measurements.

`wire.mjs` extracts original events from native CDP WebSocket records, validating
socket URL, protocol, ready/delivery ordering, key and sequence semantics.
Snapshots come from captured HTTP response bodies. It does not synthesize DOM
state/effects. Browser `records` observe actual DOM rows, a separate visible
effect counter and cumulative applied effect IDs. Raw arrival times and frames
are distinct from acknowledgement-barrier-delayed application observations.

## Exact Limits

- One server process, one Drogon I/O worker plus the framework's main event loop;
  no external service/database. At most 16 independent readers.
- Explicit per-reader queue/history bounds are 2/4 or 1,024/1,025 events. History
  evicts before insertion and retains at most the stated limit. Queue/history
  peaks update at each mutation, not by sampling. Aggregate pending queue entries
  are at most reader count times queue limit.
- Each reader separately owns one replay copy of at most history-limit events,
  one in-flight native delivery, and one replaceable overflow resource envelope.
  These are inventoried separately from pending queue entries. No scheduled
  per-publication jobs form an unbounded hidden queue.
- At most 1,000 authoritative rows. Keys/effect IDs are nonempty strings of at
  most 128 UTF-8 bytes without ASCII controls. Numeric row fields and sequences
  are nonnegative JavaScript-safe integers; publications start at sequence 1.
  Upsert row IDs must equal their keys. Remove carries no row.
- HTTP request bodies are at most 1 MiB in memory, client WebSocket messages at
  most 1 KiB. HTTP batches are at most 1,044 writes. Their acknowledgement array
  retains up to 1,044 actual resource observations until serialization completes.
- `pendingTasks` counts live consumer state machines, not OS threads.
  `connections`/`subscriptions` count admitted native readers until the actual
  connection-close callback. Process RSS, RSS high-water and CPU are read from
  Linux `/proc` and `getrusage`. Native socket/kernel buffered bytes are unknown
  (`null`), not zero. The acknowledgement gate bounds application event sends;
  it does not establish a TCP slow-reader memory bound.
- Drogon initializes its default temporary upload directories under the writable
  `/app/uploads`, even though these JSON endpoints keep request bodies in memory.
  There is no mounted volume or application upload endpoint.
- Browser trace/effect arrays are deliberate benchmark instrumentation growing
  with the finite journey. The browser has at most one delivery task in flight
  before acknowledging it. HTTP client requests have a 10-second timeout;
  correctness recovery/cleanup gates remain the shared 10/5-second gates.
- Synthetic controls are unauthenticated and intended only for an isolated
  benchmark. No authorization, process-restart durability, distributed recovery,
  hostile-client service guarantee, throughput ranking or load readiness is claimed.

## Build And Check

Build with this directory as the entire Docker context:

```sh
docker build -t cb-parity-live-drogon bench/live/apps/drogon
docker run --rm -p 127.0.0.1:8080:8080 cb-parity-live-drogon
```

The Dockerfile verifies Drogon's tagged source commit
`3aae769cc405cf5abb9d477675c6430924f02c7c`, including its pinned Trantor submodule,
builds a Release binary, runs the native CTest suite with assertions enabled and
warnings as errors, and runs production as UID 10001. It needs no author-local
SDK image. Identical verified SDK build layers can be reused by Docker's cache.
Native checks separately: `cmake -S . -B build -DCMAKE_BUILD_TYPE=Release`,
`cmake --build build -j2`, `ctest --test-dir build --output-on-failure`.

With an isolated production container running, from the repository root:

```sh
node --test bench/live/apps/drogon/test/wire.test.mjs
node bench/live/apps/drogon/test/http.mjs http://127.0.0.1:8080
node bench/live/apps/drogon/test/browser.mjs http://127.0.0.1:8080 bounded
node bench/live/apps/drogon/test/browser.mjs http://127.0.0.1:8080 native-feed
node bench/live/apps/drogon/test/readers.mjs http://127.0.0.1:8080
node bench/live/apps/drogon/test/repairs.mjs http://127.0.0.1:8080
```

Browser checks use the repository's installed `@playwright/test` and Chromium.
`PLAYWRIGHT_MODULE` may specify an absolute module URL to an existing installation
without copying dependencies. Tests use the offline oracle only after capturing
real transport, HTTP writes/acks and DOM state. Both profiles exercise normal,
disconnect, missed updates, expired cursor, gap and held-consumer overflow with
the unchanged shared correctness validator. These are app-local functional
checks, not shared-runner admission, complete-group qualification or performance
measurements. Independent review and the repository-wide contributing checks
remain integration work, outside this directory-only port.

The integration owner can register `directory: 'drogon'`, image
`cb-parity-live-drogon`, transport
`Drogon WebSocketController / acknowledged bounded consumer / native keyed DOM`,
wire `drogon-websocket`, `wireModule: './apps/drogon/wire.mjs'`, topology
`one Drogon C++ process; no external broker/database`, and both explicit profiles.
This port does not change the registry or shared gates.

The repair regressions hold a real first publication response while calling the
second concurrently, abort one actual gap snapshot and explicitly reconnect,
disconnect/reconnect/detach one reader while another remains healthy, and fill
all 16 native readers to test real pre-ready refusal, same-page recovery and
detach while healthy peers remain counted and consuming. They
compare original native WebSocket/HTTP bodies with DOM/effect observations,
retain the actual failed request/browser error, and require real final cleanup.
They do not fulfill network routes with invented fixture responses or frames.
