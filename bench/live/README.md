# Live updates: one price feed pushed to many clients, in twenty apps

Each app holds many clients subscribed to listing-price updates, using the framework's own way
of pushing to browsers, and sends every price it is given to every client. This measures what a
live page (a price ticker, a seller grid, a notification badge) costs to hold open and to feed.

## Native parity runners

The price-forwarding runs and historical results below are unchanged. They do **not** qualify
the registry's live-delivery or recoverable-live application groups. New native keyed
application probes are separate:

```sh
node bench/live/run.mjs local-check --group live-delivery --apps express,aspnet,gin --build
node bench/recoverable-live/run.mjs local-check --apps aspnet --build
node bench/recoverable-live/run.mjs native-check --apps corten,aspnet --profile native-feed --measure
node bench/live/verify.mjs bench/live/results/parity/local-check
node --test bench/live/parity.test.mjs bench/workloads/live.test.mjs
```

Install the root tooling dependencies and Playwright Chromium first. Docker builds each new
port from `bench/live/apps/<app>`, not the historical fullstack directories. Missing or stale
images build automatically; `--build` forces a source rebuild. Corten's native image uses the
repository-root context and `Dockerfile.parity`, including the actual framework sources and
embedded runtime. Its separate source-image build deadline is 20 minutes; other ports retain
five minutes. A build failure never qualifies a port or starts measurement.
An existing output directory is an error, not permission to overwrite raw evidence.

`bench/live/run.mjs` requires `--group live-delivery` for new parity mode. Without that option
its old positional arguments and historical workload remain the default. Both new entry
points export `async run(args)` accepting either an argv array (round followed by options,
without `--group`) or `{ round, apps, build, out, profile, measure }`. `apps` is an optional comma-separated
registry subset, `build` a boolean, and `out` an optional artifact directory. The CLI accepts
`--apps`, `--build`, `--profile` and `--measure` after selecting the group. The round is mandatory and must be a
safe single path segment. Outputs default to `results/parity/<round>/` here and
`bench/recoverable-live/results/<round>/`. `run` returns a boolean; false produces CLI exit 1.

Every registry candidate remains in `coverage.json`, even on an explicitly partial run.
A missing/failed candidate keeps the group incomplete and the exit status nonzero. No port
is silently admitted from the historical transport test. Measurement defaults to `not-run`.
Explicit `--measure` admits only an app whose complete required native fault suite has just
passed, revalidating saved artifacts before timing. See [bounded fan-out](#bounded-fan-out).
No unqualified app is timed. Group readiness is derived from complete selected native
qualification and, when requested, all measured levels, never a manually enabled flag.

Implemented native ports are Express (its response writer and EventSource), ASP.NET Core
(`TypedResults.ServerSentEvents`, a bounded `Channel<Change>` and EventSource), and Gin
(`SSEvent`, a bounded Go channel and EventSource), plus Corten in the explicit native-feed
profile (`Feed`, `subscribe()` and generated keyed views). Their state stores, bounded history,
subscription lifecycle and browser DOM renderers are independent implementations; the runner
only publishes the shared fixture and drives faults. The oracle is imported only by the
runner/verifier, never by an application.

The default `bounded` profile remains 24 events, queue 2 and history 4. Corten's native Feed
has fixed backlog/replay policies, so it is visible but never timed in that incompatible
profile. Explicit `--profile native-feed` uses 1,044 events, queue 1,024 and history 1,025 for
every candidate. The history budget accounts for Corten's transient insert-before-evict
entry; steady native replay retains 1,024. No framework limits or browser runtime are replaced.
Large missed-write/overflow fault setup uses an explicit native batch control: every native
write still runs in order with its own sequence/resource acknowledgement, retained in the
raw HTTP response. The entire batch is validated before mutation. This avoids over 1,024
cross-host HTTP round trips just constructing a fault; recovery/slow-reader gates remain
10 seconds. Ordinary delivery and every measurement remain individual native requests.
Corten's publisher/body instrumentation accounts accepted writes and emitted native patches;
ring/history occupancy follows the fixed source policies, not private-memory introspection.
The inventory records the native coalesced frame and diagnostic duplicate slots separately.
The browser's EventSource decorator only observes original native instances: `subscribe()`
owns cursor handling, retry, deduplication, gap recovery and snapshot fetching; `rows()` and
generated views own keyed screen updates. Historical Corten behavior remains the default
binary mode; the separate parity image explicitly enables `LIVE_PARITY`.

Independent ports not integrated in this lane remain **Phoenix, Rails, Laravel, Drogon,
Leptos and Topcoat** in their registry-selected groups. Rails has a separate port-owner
handoff requiring parent import, registration and shared-runner qualification; it is not
silently admitted here. Phoenix Channels/LiveView, Action Cable/Turbo,
Reverb, Leptos hydration and Topcoat runtime work must remain native when those ports are added.
An SSE port under one of those names would not satisfy that requirement.

### What is exercised

`bench/workloads/live.mjs` supplies the versioned fixture and validates actual browser
observations: five initial keyed rows, 24 numbered upserts/removals/reinsertions, plus a
post-detach publication. Initial/recovery snapshots read the authoritative native state,
replace the displayed rows, and report materialization work. Effect IDs and a separately
incremented visible effect counter detect replayed side effects. Captured application rows
are read back from the DOM, not calculated by the reference-state helper.

Delivery runs normal and held-consumer overflow journeys. Recovery adds forced disconnect,
missed writes, expired history and a dropped native update followed by gap detection. Replay
includes a retained boundary event, and every journey injects a real duplicate transport
event. Expired cursors, gaps and overflow cause authoritative snapshots. Faults are explicit
native benchmark control endpoints, not production features or silently repaired traces.

The slow-consumer test holds the **native queue consumer**, fills its two-event queue, and
publishes once more. The overflow notification contains counters taken at saturation, before
the queue is released; the browser then resnapshots. Queue and four-event history peaks are
updated on mutation, including between observations; history evicts before inserting. This
is not a TCP slow-reader, proxy, kernel socket-memory or fan-out load test. ASP.NET and Gin
retain one in-flight frame outside the queue. Express records writable-buffer
bytes/peak and destroys an over-budget writer; ASP.NET awaits Kestrel's writer and Gin flushes
each frame synchronously. Replay copies, overflow slots, wake signals, live tasks, state rows,
snapshot reads, native CPU/memory counters and emitted bytes are inventoried in raw evidence.
Express counts SSE frame bytes; ASP.NET/Gin count JSON payload bytes, not framing overhead.
Default transport buffers and kernel memory are not presented as measured queue bounds.

The publisher's acknowledged write is recorded before the application's queued effect is
applied. This explicit correctness barrier avoids confusing an SSE event arriving before its
HTTP publish response with an unacknowledged write. `receivedAt` and raw Chromium native SSE
messages retain actual arrival observations separately. Setup/recovery durations and native
CPU/memory/byte observations include the probes' instrumentation and this barrier; they are
not standalone production latency/efficiency numbers. Each app container has one CPU and
1 GiB with no extra swap; only one correctness browser journey is active. A default journey
has a 45-second hard deadline (180 seconds for the larger explicit native-feed fixture),
individual waits are bounded, startup is bounded, and owned containers are removed
in `finally`. The local browser runs outside that app budget and is explicitly inventoried.

Each final detach closes the real EventSource and waits for the native subscription, writer
task and queue to reach zero. The independent post-detach write is acknowledged, followed
by another zero-resource observation and unchanged DOM/effects after at least 150 ms.
Retained history may remain at its finite bound; no broker/database/shared native service is
created. No authentication, multi-node or process-restart durability is claimed.

### Evidence

`native-live-plan/v2` records the complete selection, explicit profile, optional measurement
profile, effective fixture/settings, machine,
budgets, source diff fingerprint, runner/oracle fingerprints and registry contract fingerprint.
Each gzip JSON artifact is `native-live-evidence/v1` on success or `native-live-failure/v1`
on failure. It retains native source hashes, image/source-label binding, exact image/container
identity, actual browser application records, JSON HTTP bodies/acknowledgements, raw CDP SSE/WebSocket,
native resource counters, final HTML, browser version and browser CPU/heap/DOM/resource costs.
Per-app manifests hash the saved gzip bytes. `verify.mjs` reopens bytes, checks provenance and
scenario completeness, matches application snapshots/events against native HTTP/SSE evidence,
reruns the shared oracle and checks the saved aggregates and complete coverage ledger.

Checked-in bounded native captures are under `evidence/native-delivery/` and
`bench/recoverable-live/evidence/native-recovery/`. They are raw correctness evidence from a
concurrently loaded local workstation, not a framework ranking or a passing whole group.
`parity.test.mjs` mutates those real captures to reject wrong DOM, duplicate effects, lost
updates, queue overflows hidden by labels, leaks, raw-wire mismatches, altered provenance and
invented aggregates. These offline hostile tests do not replace rerunning the native ports.

Current explicit native-feed evidence is retained separately: `evidence/native-feed-corten/`
(Corten delivery), `evidence/native-feed-peers/` (Express and ASP.NET delivery),
`evidence/native-feed-gin/` (Gin delivery), and `bench/recoverable-live/evidence/native-feed-corten/`
plus `native-feed-aspnet/` (six recovery cases each). Each app passed its required native
cases before all three requested measurement levels. These are separate partial rounds,
not a manufactured passing whole-group ledger. Earlier build/rate/timing failures remain
unchanged in their original captures. [Validation record](VALIDATION.md) lists checks,
limits, measured observations and every changed path.

Historical `native-live-plan/v1` evidence retains its original three-port inventory. The
verifier checks that versioned inventory, not today's available adapters; adding a port never
upgrades an old missing row to a passing qualification or changes its identity.

### Bounded Fan-Out

`--measure` runs the actual keyed application at 1, 2 and 4 simultaneous browser screens on
one native app instance, after all of that app's group-specific correctness scenarios pass.
Every level resets the same five-row state, publishes the same 60 upserts/removals/reinserts
at an offered 20 events/second, and checks every native wire delivery, DOM state and effect.
More than 500 ms publisher schedule lag fails the level; a snapshot concealing loss fails it.
Each level has a 90-second hard bound, and includes a duplicate native delivery plus final
detach, post-detach publication and zero-resource observation. Native ports cap readers at 16.

Raw browser frame observations retain the first animation frame seeing a version and the
following frame (a paint opportunity, not a pixel-photometry claim). Visible latency uses
that second frame against the publisher browser's actual publication start, with Chromium
time origins retained. Server cost uses actual cgroup CPU usage and current/peak memory,
including all processes in the declared container topology. Memory peak is explicitly since
container start, including qualification/setup; it is not relabeled as an isolated level peak.
Browser process costs are separately retained, outside the server's one-CPU/1-GiB budget.

Per-level `native-live-fanout/v1` gzip artifacts reference the hashed successful native
qualification artifacts and retain all browser/application/raw-wire traces, frame samples,
publication schedule, native resource counts, kernel counters and source/image identity.
`verify.mjs` reopens both qualification and measurements and reconstructs every aggregate.
Failed or missing qualification never starts measurement. Completed bounded measurement is
recorded as such, not permanently `not-run`; it does not by itself qualify missing candidates
or establish Corten wins. `readyForLoad` requires the entire selected group to have verified
native parity and every explicitly requested measurement level; it is admission evidence,
not a quiet/dedicated-host throughput claim. One local repeat at three small fan-out levels cannot
establish saturation, scalability limits or a general framework ranking.

| App | Transport | How the app does it | Code |
|---|---|---|---|
| corten | Server-sent events, Corten's feed protocol | `corten::feed`: `GET /live/feed` is a snapshot, `/live/feed/live?since=` the numbered patches after it, encoded once for every client | [apps/corten](apps/corten) |
| leptos | Server-sent events | axum `Sse` and a tokio broadcast channel | [main.rs](../fullstack/apps/leptos/src/main.rs) |
| topcoat | Server-sent events | Topcoat's `Sse` and a tokio broadcast channel | [main.rs](../fullstack/apps/topcoat/src/main.rs) |
| axum-maud | Server-sent events | axum `Sse` and a tokio broadcast channel, no framework | [main.rs](../fullstack/apps/axum-maud/src/main.rs) |
| gin | Server-sent events | Gin's `SSEvent`, a queue per client | [live.go](../fullstack/apps/gin/live.go) |
| drogon | Server-sent events | `newAsyncStreamResponse`, one stream per client | [live.cc](../fullstack/apps/drogon/src/live.cc) |
| nextjs | Server-sent events | Route handler returning a `ReadableStream` per client | [lib/live.ts](../fullstack/apps/nextjs/lib/live.ts) |
| tanstack-start | Server-sent events | Server route, `ReadableStream` | [src/live.ts](../fullstack/apps/tanstack-start/src/live.ts) |
| sveltekit | Server-sent events | `+server.ts` endpoint, `ReadableStream` | [live.ts](../fullstack/apps/sveltekit/src/lib/server/live.ts) |
| react-router | Server-sent events | Resource route, `ReadableStream` | [live.server.ts](../fullstack/apps/react-router/app/live.server.ts) |
| astro | Server-sent events | Endpoint, `ReadableStream` | [live.ts](../fullstack/apps/astro/src/lib/live.ts) |
| nuxt | Server-sent events | h3 `createEventStream` | [prices.get.ts](../fullstack/apps/nuxt/server/routes/live/prices.get.ts) |
| aspnet | Server-sent events | `TypedResults.ServerSentEvents` over a `Channel<T>` per client | [LivePrices.cs](../fullstack/apps/aspnet/LivePrices.cs) |
| spring | Server-sent events | Spring MVC `SseEmitter` on Tomcat | [LiveController.java](../fullstack/apps/spring/src/main/java/bench/itempage/LiveController.java) |
| django | Server-sent events | Async view, `StreamingHttpResponse`, on uvicorn (ASGI) | [live.py](../fullstack/apps/django/itempage/live.py) |
| fastapi | Server-sent events | `EventSourceResponse`, an `asyncio.Queue` per client; FastAPI's own keepalive comment every 15 s on an idle stream | [main.py](../fullstack/apps/fastapi/app/main.py) |
| express | Server-sent events | `res.write` on each open response | [server.mjs](../fullstack/apps/express/server.mjs) |
| rails | WebSocket, Action Cable | A channel, `ActionCable.server.broadcast` | [prices_channel.rb](../fullstack/apps/rails/app/channels/prices_channel.rb) |
| phoenix | WebSocket, Phoenix Channels | A channel, `Endpoint.broadcast` over PubSub | [prices_channel.ex](../fullstack/apps/phoenix/lib/item_page_web/channels/prices_channel.ex) |
| laravel | WebSocket, Pusher protocol | Reverb, fed by a `ShouldBroadcastNow` event | [PriceTick.php](../fullstack/apps/laravel/app/Events/PriceTick.php) |

Apart from Corten's, these are the full-stack comparison's apps ([bench/fullstack](../fullstack))
with two more routes: the stream and `POST /live/publish`, which sends its JSON body on.
Topcoat, axum + Maud, Gin and Drogon joined after r3, and FastAPI and Express later still, so they
have no rows in the results below; the next round measures them.

## What a run does

For each app and each number of clients (1,000 and 10,000):

1. Start the app alone: one CPU, 1 GiB of memory, a million open files allowed. Read its memory.
2. Connect the clients from a container on other cores ([client.mjs](client.mjs): Node 24, a worker
   thread per load core, six on the droplet, 1,000 new connections a second), each the way the framework's browser client
   does: one `EventSource`-style request for SSE, or a WebSocket that joins the channel. Corten's
   clients load the snapshot first, as `subscribe()` in corten.js does.
3. Ten seconds later, read the memory again (memory per client is the difference).
4. Publish 10 prices a second for 30 seconds, one request at a time, while sampling the app's CPU.
   Each price carries its sequence number and the time it was sent.
5. Every client records each price's delay (sent to received, same machine clock) and whether
   any were missing, repeated or out of order.

Reported: clients connected, prices delivered of those expected (connected clients x prices),
order, delay percentiles, CPU while publishing, memory, and whether the app kept up with 10
publishes a second (a publish request returns when the app has handed the price to every client,
so a slow fan-out stretches the publishing time).

## Fairness notes

- Every app runs with its framework's usual production settings in one CPU and 1 GiB. None is
  tuned to get through the test (a bigger heap, a higher connection limit): an app that cannot
  hold the clients that way is marked failed.
- One process per app, as in a single-instance deployment. Several processes would need a
  shared broker (Redis, Solid Cable, a database) for every one of these except Corten's
  `Feed::follow`, and that is not measured.
- **django** runs on uvicorn for this suite: gunicorn's sync workers (the full-stack setup) hold
  one stream each. There is no Channels or Redis: async views and an in-process queue per client.
- **rails** uses Action Cable's async (in-process) adapter, the fan-out Solid Cable or Redis would
  feed in a multi-process deployment.
- **laravel** runs Reverb, a second process, in the same container on the same CPU as Octane;
  each publish goes from Laravel to Reverb over HTTP. ext-uv is installed, as Reverb's docs say
  to for more than about 1,000 connections.
- **spring** runs with Tomcat's and the JVM's defaults: at most 8,192 connections, and a heap of
  a quarter of the container's memory.
- **nuxt**, **aspnet** and **gin** send one event when a stream opens: their streams send no
  headers until the first write, so a browser would not see the connection open until the first
  price. hyper (Leptos, Topcoat, axum-maud) and Drogon send the headers when the stream opens.
- Slow clients: Corten tells a client that falls more than its buffer behind to reload the
  snapshot (counted as resyncs; prices missed meanwhile count as missing, though the snapshot has
  the latest price). The broadcast channels of Leptos, Topcoat and axum-maud skip what a slow
  client missed. The JavaScript, .NET, Python, Go and C++ apps buffer without a limit.
- The client's own work is in the delay at 10,000 clients: four threads parse 100,000 messages a
  second.

## Running it

```sh
# images: the full-stack apps' (see bench/fullstack) and Corten's live app
docker build -f bench/live/apps/corten/Dockerfile -t cb-live-corten .
node bench/live/run.mjs <round> [clients=1000,10000] [apps=all] [rate=10] [seconds=30]
node bench/live/summarize.mjs <round>
# or on a fresh DigitalOcean droplet, created and destroyed for the run
node bench/fullstack/droplet.mjs <round> --ssh-key <id> --suite live
```

## Results

All numbers are measured, from one run (`results/r3/`, 2026-10-23 UTC) on a DigitalOcean c-8
droplet (Intel Xeon Platinum 8280 at 2.7 GHz, 8 dedicated vCPUs, 16 GB, Ubuntu 24.04, kernel 6.8,
Docker 29.9), created for this suite and destroyed after it: the app pinned to core 1, the clients
on cores 2-7 (six worker threads), the system on core 0. Ten prices a second for 30 seconds;
delay is from the publisher's send to the client's receipt. Kept up: every price delivered to
every client, in order, at the rate asked. Fell behind: every price delivered, in order, but the
app took longer than 30 seconds to send them (the publisher stops after 120 seconds). Failed:
clients refused, prices lost or out of order, publishes unanswered, or the app killed for memory.
r2 (`results/r2/`) measured Corten before handlers replaced islands and before the later
request-path work (`corten::Json`, the middleware layer, float formatting); r1 (`results/r1/`)
ran Spring and Laravel with tuned settings. Both are kept for the record; numbers are compared
within a round.

### 1,000 clients (10,000 messages a second)

| App | Transport | Result | Connected | Delivered per second | Delay p50 / p99 | CPU | Memory connected | Per client |
|---|---|---|---|---|---|---|---|---|
| **corten** | feed (SSE) | kept up | 1,000 | 10,033 | 9.3 / 20 ms | 17% | 25.7 MiB | 25.6 KiB |
| leptos | SSE | kept up | 1,000 | 10,033 | 9.3 / 19 ms | 17% | 23.9 MiB | 23.7 KiB |
| aspnet | SSE | kept up | 1,000 | 10,033 | 13 / 29 ms | 22% | 45.4 MiB | 18.7 KiB |
| phoenix | Channels | kept up | 1,000 | 10,033 | 14 / 33 ms | 27% | 180.3 MiB | 45.5 KiB |
| sveltekit | SSE | kept up | 1,000 | 10,033 | 15 / 37 ms | 25% | 81.5 MiB | 63.6 KiB |
| spring | SSE | kept up | 1,000 | 10,033 | 15 / 55 ms | 28% | 239.3 MiB | 123.1 KiB |
| tanstack-start | SSE | kept up | 1,000 | 10,033 | 16 / 38 ms | 26% | 80.3 MiB | 57.5 KiB |
| astro | SSE | kept up | 1,000 | 10,033 | 16 / 39 ms | 26% | 103.8 MiB | 71.3 KiB |
| react-router | SSE | kept up | 1,000 | 10,033 | 18 / 89 ms | 33% | 98.8 MiB | 70.8 KiB |
| nextjs | SSE | kept up | 1,000 | 10,033 | 20 / 58 ms | 31% | 153.7 MiB | 112 KiB |
| laravel | Reverb | kept up | 1,000 | 10,033 | 22 / 36 ms | 34% | 152.6 MiB | 24.3 KiB |
| nuxt | SSE | kept up | 1,000 | 10,033 | 22 / 52 ms | 33% | 85 MiB | 57.3 KiB |
| django | SSE | kept up | 1,000 | 10,033 | 22 / 48 ms | 41% | 137.8 MiB | 96.3 KiB |
| rails | Action Cable | **failed: messages lost or out of order** | 1,000 | 10,000 | 38 / 89 ms | 67% | 97.3 MiB | 35.4 KiB |

### 10,000 clients (100,000 messages a second)

| App | Transport | Result | Connected | Delivered per second | Delay p50 / p99 | CPU | Memory connected | Per client |
|---|---|---|---|---|---|---|---|---|
| leptos | SSE | kept up | 10,000 | 100,334 | 96 / 235 ms | 102% | 232.2 MiB | 23.7 KiB |
| **corten** | feed (SSE) | kept up | 10,000 | 100,334 | 111 / 243 ms | 103% | 249.5 MiB | 25.5 KiB |
| aspnet | SSE | fell behind: 300 of 300 in 53.8 s | 10,000 | 55,762 | 220 / 475 ms | 102% | 200.9 MiB | 17.8 KiB |
| phoenix | Channels | fell behind: 300 of 300 in 83.6 s | 10,000 | 35,885 | 142 / 335 ms | 102% | 584.9 MiB | 46 KiB |
| sveltekit | SSE | fell behind: 300 of 300 in 98.5 s | 10,000 | 30,457 | 436 / 768 ms | 101% | 262.8 MiB | 24.9 KiB |
| tanstack-start | SSE | fell behind: 300 of 300 in 101.8 s | 10,000 | 29,470 | 458 / 786 ms | 101% | 241.2 MiB | 22.2 KiB |
| astro | SSE | fell behind: 300 of 300 in 109.7 s | 10,000 | 27,347 | 468 / 889 ms | 101% | 299.4 MiB | 27.2 KiB |
| nuxt | SSE | fell behind: 274 of 300 in 120.1 s | 10,000 | 22,814 | 510 / 1,008 ms | 101% | 307.3 MiB | 28.5 KiB |
| rails | Action Cable | fell behind: 160 of 300 in 120.1 s | 10,000 | 13,322 | 697 / 1,288 ms | 101% | 327.3 MiB | 27.1 KiB |
| django | SSE | **failed: 62 of 10000 clients not connected, killed out of memory** | 9,938 | 19,480 | 274 / 1,201 ms | 101% | 1011 MiB | 99.7 KiB |
| nextjs | SSE | **failed: 77 of 10000 clients not connected** | 9,923 | 16,827 | 501 / 2,569 ms | 101% | 604.5 MiB | 57.8 KiB |
| react-router | SSE | **failed: 214 of 300 publishes unanswered, messages lost or out of order** | 10,000 | 12,592 | 534 / 3,482 ms | 101% | 323.7 MiB | 30.1 KiB |
| spring | SSE | **failed: 8017 of 10000 clients not connected, 12 of 12 publishes unanswered, messages lost or out of order** | 1,983 | - | - | 100% | 373.9 MiB | 127.4 KiB |
| laravel | Reverb | **failed: 4995 of 10000 clients not connected, 300 of 300 publishes unanswered, messages lost or out of order** | 5,005 | - | - | 6% | 94 MiB | - |

At 1,000 clients every app but Rails delivered every message in order; they differ in cost.
Corten used 17% of its core and 25.7 MiB, Leptos 17% and 23.9 MiB, ASP.NET Core 22% and 45.4 MiB;
the JavaScript frameworks 25-33% and 80-154 MiB, Django 41%, Rails 67%. Rails delivered all
300,000 messages but 2 arrived out of order, which this suite counts as failed (r2's Rails kept
up).

At 10,000 clients only Corten and Leptos delivered all 100,000 messages a second, so their row is
close to what one core of this machine sends; the other apps used their whole core and fell
behind or failed. ASP.NET Core came next at 55,762 a second, then Phoenix at 35,885. Failures:

1. **django** was killed for memory at 1,011 MiB (about 100 KiB a client) with 9,938 connected;
   every price it sent before then reached every connected client. In r2 it stayed at 1,017 MiB
   and was not killed.
2. **nextjs** connected 9,923 of 10,000; every price it sent reached every client that was
   connected. Not investigated.
3. **react-router**: 214 of 300 publish requests got no answer within 10 seconds; the 86
   answered reached every client.
4. **spring** (Tomcat and JVM defaults) accepted 1,983 connections and answered none of its 12
   publishes. At about 130 KiB a client that is the default heap (a quarter of 1 GiB). r1, with
   75% of memory as heap and Tomcat's limit raised, held 6,666.
5. **laravel** (PHP's default `memory_limit`, 128 MB) accepted 5,005 connections, then Reverb
   closed all of them and every publish failed. r1, with 512 MB, held 10,000, so the limit is the
   likely cause; not confirmed.

Corten against Leptos: the same at 1,000 clients (9.3 ms median delay each); at 10,000 Leptos's
median delay was lower (96 against 111 ms) and the p99s level (235 against 243 ms). r2 had the
medians the other way round (78 against 88 ms), so the difference is within the noise of one
run. Each Corten message is 167 bytes on the wire against 61 for a plain SSE event, because it
carries the feed's cursor (`id: epoch-seq`) and a keyed patch
(`{"op":"upsert","id":...,"value":...}`): a client that reconnects resumes from its cursor, and a
patch updates one row of a grid, neither of which the plain stream does. The reconnect and resume
path was not measured here.
