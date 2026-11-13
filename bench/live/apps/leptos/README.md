# Native Leptos live port

Independent Leptos 0.8.22 application. `#[server] initial_snapshot` materializes
the initial server-rendered component, using Leptos's Axum integration and
hydration. `Screen`, `RwSignal`, derived row signals and keyed `<For>` own every
DOM row and the independently incremented visible effect counter. The browser
bridge only controls the native stream, changes Rust signals through WASM
exports, and reads the actual DOM. It contains no renderer or workload oracle.
Duplicate and gap guards are application code because Leptos does not provide
a recoverable keyed feed protocol. Axum's native `Sse` and bounded Tokio `mpsc`
channels provide the server transport and per-reader queue. This is not a
Leptos-native feed claim or a generic JavaScript renderer relabeled Leptos.

The synthetic JSON configure/snapshot/resources/publish/control interface is
documented in `../../PORTS.md`. Source rows preserve insertion order; an upsert
keeps an existing key's position, while remove/reinsert appends it. Snapshots
replace rows without incrementing event effects. Replay includes a retained
boundary event, making duplicate rejection observable. Expired cursors, gaps
and native held-consumer overflow trigger an authoritative resnapshot.

Only queue/history 2/4 and 1024/1025 are accepted. History evicts before insert;
mutation-time peaks count actual Tokio queue occupancy and retained history.
The 1,044-event batch fault setup prevalidates all writes before mutation, then
uses the same native publication path and captures each real acknowledgement.
The bridge holds event application behind the HTTP acknowledgement barrier,
retaining real native arrival timestamps separately. Snapshot initialization
uses the same source as publication, never the offline reference fixture.

At most 16 independent readers and 1,000 source rows are accepted. Each reader
owns one bounded native channel, at most `historyLimit` replay events, one ready
slot and one overflow slot. The response writer holds at most one encoded
frame. CPU ticks/RSS come from `/proc/self`; inventory explicitly leaves kernel
socket and framework transport buffer bytes unknown. Hold stops actual server
dequeueing. Overflow records saturated resources before clearing pending work.
Dropping the SSE body removes its reader and all owned buffers. Final detach
cleans the Leptos reactive owner, whose `on_cleanup` closes the browser stream;
it preserves the last DOM so post-detach quiescence can be verified.

This is one native process without a broker/database. The deliberately
unauthenticated publisher/control API is synthetic, not a production policy.
No multi-node operation, restart durability, TCP slow-reader bound, throughput,
comparative performance, cost, cloud qualification or registry admission is
claimed. Docker uses the standard optimized Cargo release profile, without a
reduced optimization override or custom performance tuning. Earlier local
functional review images used `opt-level=1`; they are not evidence for this
production build. The rebuilt candidate must pass every native gate before
timing. Browser records are diagnostic observations, not a
bounded production telemetry store.

Build with the app-local Dockerfile, using this directory as the context:

```sh
docker build -t live-parity-leptos bench/live/apps/leptos
cargo test --manifest-path bench/live/apps/leptos/Cargo.toml --features ssr --lib
node bench/live/apps/leptos/test/http.mjs http://127.0.0.1:8080
node bench/live/apps/leptos/test/browser.mjs http://127.0.0.1:8080 bounded
node bench/live/apps/leptos/test/browser.mjs http://127.0.0.1:8080 native-feed
```

Install the repository's Playwright tooling first. Optional `LIVE_EVIDENCE`
writes compressed actual browser captures to a new file for each journey.
The browser tests use the existing shared journey and offline validator without
editing either; they additionally compare every recorded event/snapshot with
raw native wire, and all writes/acknowledgements with actual HTTP bodies.
`test/http.mjs` checks publication atomicity, reader saturation and cancellation.
Native Rust tests cover invalid batches, ordered keyed state, replay expiry,
held queue saturation/overflow, finite history and reader RAII cleanup.

`native.mjs` registers both profiles with the app-local Docker context and
`leptos-axum-sse` wire binding. It runs one native application process and gives
the separate WASM/native build its own build deadline. Registration establishes
neither qualification nor group readiness, and cannot upgrade older captures.
