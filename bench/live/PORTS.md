# Native live application ports

The entry points are `node bench/live/run.mjs ROUND --group live-delivery` and
`node bench/recoverable-live/run.mjs ROUND`. Both export `async run(args)`, where
`args` is an argv array or `{round, apps?, build?, out?, profile?, measure?}`. `--apps` takes
a comma-separated subset, `--build` rebuilds from source, and `--profile native-feed`
explicitly selects the larger native-feed fixture. The default remains the original
24-event, queue-2/history-4 correctness profile. The native-feed profile uses 1,044
events and queue/history limits of 1,024/1,025 for EVERY candidate in that round.
The history budget includes Corten's transient insert-before-evict entry; its
steady replay retains 1,024. Profiles
are not interchangeable evidence. Neither profile is a throughput measurement.
Explicit `--measure` admits an app only after all native correctness scenarios
have independently revalidated. It then measures 60 native publications at 20/s
to 1, 2 and 4 real browser clients on the SAME native instance, with raw wire,
visible-frame opportunities and cgroup CPU/memory counters. Support up to 16
independent native readers; aggregate pending queue entries must not exceed
reader count times the configured per-reader limit. These are bounded local
observations, not saturation or comparative rankings. No failed admission is timed.

Each directory is independently owned and built. Phoenix, Rails, Laravel, Drogon,
Leptos and Topcoat can be implemented independently of Corten and one another. Do
not edit another app, the registry, or the shared oracle to make a port pass.

Read `native.mjs` (deployment registration), `parity.mjs` (browser driver and raw
evidence verification), `verify.mjs` (saved-round verification), and the independent
`apps/aspnet`, `apps/express`, and `apps/gin` implementations. The application trace
contract is documented in `../workloads/live.mjs`; that module is an OFFLINE oracle,
not application code. No app may import it to manufacture state or observations.

## HTTP control interface

- `GET /` serves the real framework browser application and its keyed renderer.
- `POST /parity/configure` receives `{initial,queueLimit,historyLimit}`. Reset only
  with no live readers. Answer `{configured:true,framework:REGISTRY_ID,version}`.
- `GET /parity/snapshot` is an authoritative read, not the oracle. The conventional
  response is `{through,rows,work:{reads:1,rows:N}}`. A framework-native snapshot
  envelope is allowed with an explicit lossless verifier binding.
- `GET /parity/resources` returns actual owned `subscriptions`, `connections`,
  `pendingTasks`, `queueLimit`, `queueEvents`, `queuePeak`, `historyLimit`,
  `historyEvents`, `historyPeak`. Peaks are cumulative mutation-time instruments,
  not maxima of periodic samples. Include process CPU/memory and buffer inventory.
- `POST /parity/publish` receives `{event}` and acknowledges `{seq,resources}`.
  Reject nonconsecutive writes with HTTP 400 before changing state. Events are
  `{seq,effectId,key,op,row?}`; `op` is upsert or remove. Preserve effect identities.
- In explicit native-feed fault setup ONLY, the same endpoint also accepts
  `{events:[...]}` (1 to 1,044) and returns `{acks:[{seq,resources},...]}`. Validate
  every event and consecutive sequence before any mutation; reject empty, mixed
  event/events, malformed or gapped batches with 400. Invoke the identical native
  write path per event and retain each mutation-time counter/peak. Expose
  `liveApp.publishBatch(events)` with one acknowledgement barrier, recording each
  actual write acknowledgement/resources before releasing queued native effects.
  This avoids 1,025-plus network round trips merely constructing a recovery fault;
  it does not reduce native writes, change 10-second gates or batch measurements.
- `POST /parity/control` accepts `{action:"hold"}`, `{action:"drop",seq}`, and
  `{action:"duplicate"}`. Hold the actual native server consumer until overflow;
  drop one actual delivery to exercise a gap; repeat one actual wire delivery.
  Native reconnect implementations may additionally use `disconnect`/`reconnect`.

The existing SSE ports use `/parity/events?from=N`, `ready` with
`{from,status:"accepted"|"expired",resources}`, `update` with the event, and
`overflow` with `{outcome:"resnapshot",resources}`. This spelling is NOT a required
native transport: register a reviewed raw-wire binding rather than serving a
common EventSource client under a WebSocket/LiveView/Turbo framework name. Keep raw
CDP messages and HTTP bodies; normalization cannot invent missing observations.

An app-local `wire.mjs` must export synchronous `wireEvents(network)`,
`wireSnapshots(network)` and `wireResources(network)`. The last returns every
actual resource payload recorded by the client from native ready/overflow or
other resource-bearing frames, in native frame order. Do not include HTTP resource
responses or publication acknowledgements: the shared verifier binds those
separately. The entire resource object, including peaks and buffer/process fields,
must match its recorded observation. No counter synthesis or omitted raw payloads.
The integration owner registers `wire` and `wireModule`
in `native.mjs`; the runner hashes the module as part of the app source. Native
WebSocket records have `kind: native-websocket-received` / `native-websocket-sent`
and CDP's `response.payloadData`, opcode and timestamp; creation records retain the
URL. SSE records have `kind: native-sse`, `eventName`, `data`, `eventId`, timestamp.
HTTP request records retain method/URL/body; JSON response records retain status,
headers and body. Native WebSocket snapshot envelopes are allowed instead of a
second HTTP read. Bindings must verify native envelope/key/sequence semantics, not
search arbitrary strings for something resembling an expected fixture event.
Declare a non-default `topology` for multiple application/broker processes. The
runner retains `docker top` PID/parent/name inventory, and applies a shared 1 CPU /
1 GiB budget to the container. Extra containers need an explicit integration,
attributed budgets and owned cleanup; never omit them from provenance.

## Browser interface

Expose `window.liveApp` with `records`, a `through` getter, and async methods
`setup(settings)`, `publish(event,probe=false)`, `disconnect()`, `reconnect()`,
`hold()`, `drop(seq)`, `duplicate()`, `settle()`, `detach()`, `released()`, and
`state()`. `state` may be synchronous. Trace actual DOM rows, cumulative applied
effect IDs and an independently incremented visible effect counter. Snapshots
replace rows without invoking per-event effects. Duplicate/gap deliveries must be
observable even when the native runtime correctly rejects their effects.

Use native lifecycle cancellation and prove server reader/task cleanup. Record
publication acknowledgements before application effects (the existing clients use
an acknowledgement barrier, retaining actual receive times separately). After
detach, the runner publishes a cleanup probe and observes unchanged DOM/effects
and zero owned resources for at least 150 ms after its acknowledgement, aligning
each reader's `performance.timeOrigin`. All qualification scenarios and measured
levels must retain the same complete build/container/topology provenance.
A passing subset does not qualify the full registry.
Missing ports stay visible; no transport-only placeholders count as implemented.
