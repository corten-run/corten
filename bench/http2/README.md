# HTTP/2 without a proxy

Decision on 2026-11-13: **option 2 for now**, with option 1 the direction to revisit. Do not
ship an HTTP/2 feature that silently weakens a security bound. The send stall was measured;
the idle-watch bug was found by inspection, not by the historical partial-head probe. This does not
decide that a proxy is cheap or that HTTP/2 is too expensive.

This answers [#1287 Limit 14 makes a proxy a requirement for live streams: weigh HTTP/2 in corten::serve again, with the cost of the requirement on the scale](https://github.com/corten-run/corten/issues/1287).
The baseline is `ecbef5eb`; the executable prototype and probes are at `1a8adcb5f`, with the
measurement driver's shell-quoting correction at `70e523f3b`. The annotated
[evidence/http2-prototype tag](https://github.com/corten-run/corten/tree/evidence/http2-prototype)
points to `70e523f3b` and reaches both the prototype and baseline. No prototype commits are
carried by the decision branch. The server is retained only behind that tag.

## Measurements

The result numbers in this section are **measured**, not estimated. Counts are Valgrind 3.19.0 callgrind `Ir`,
release builds with thin LTO and one codegen unit, Rust 1.99.1, Linux in Docker Desktop.
No throughput or latency comparison under load was made on this shared machine.

| Workload | Baseline / feature-on auto-builder HTTP/1.1 median [min, max] | Feature off / auto-builder HTTP/2 median [min, max] |
|---|---:|---:|
| Item page through router, instructions/request: baseline versus feature off | 74,751 [74,613, 74,766] | 74,531 [74,379, 74,796] |
| Small page through TLS, instructions/request: HTTP/1.1 versus HTTP/2 | 40,519 [40,517, 40,520] | 58,724 [58,698, 59,146] |
| Fixed fragment through TLS, instructions/SSE event: HTTP/1.1 versus HTTP/2 | 2,806 [2,804, 2,806] | 5,174 [5,171, 5,175] |

Each row has three rounds of 1,200 minus 200, divided by 1,000. Builds/protocols alternate.
The item test uses card-market's `fixtures/smoke.json`, `item_5`, identity encoding, and
`oneshot`, consuming the whole body and asserting 200 for every response. Its code section
(`objcopy --dump-section .text`) has the same SHA-256 in both builds:
`4e22d825cfd7442cd081a77c4229f624b0a99f7d04b8e18811fa154f956a000f`.
The overlapping instruction ranges establish no speed difference. The first attempted harness
asked for absent `item_1`, failed its 200 assertion, and its counts were discarded. The whole
test executables have different hashes; only their executable code sections were byte-identical,
not the entire build artifacts. The [raw totals](results/counts.csv) retain every reported round.

The transport probe is deliberately smaller than the item page: a 378-byte document, one
keep-alive TLS connection, sequential requests, and the same feature-on binary for both
protocols. **The 40,519 HTTP/1.1 page count and 2,806 event count use hyper-util's auto builder,
not the shipping `http1::Builder` path.** They compare protocols within the prototype, not
shipping HTTP/1.1 with a completed HTTP/2 implementation. The
stream probe sends 200 or 1,200 identical 63-byte HTML fragments in one response; SSE framing
adds 21 bytes per event. The client runs outside callgrind. Counts include the server's TLS,
HTTP framing and Corten work; startup and one TLS handshake are subtracted. They do not include
the missing HTTP/2 safety work, and are not estimates of a complete implementation's cost.
The transport probe's separate lockfile is kept at the prototype commit: hyper 1.12.0,
hyper-util 0.1.21, h2 0.4.20, tokio-rustls 0.26.6 and rustls 0.23.46 (ring).

`cargo tree --edges normal,build --prefix none --format '{p}'` on a generated template,
deduplicated by package/version and excluding the template itself, gives 59 crates on the
baseline and with the feature off, with identical trees after normalizing the checkout path.
With the feature on it gives 67: `h2`, `tokio-util`, `indexmap`, `hashbrown`, `equivalent`,
`fnv`, `futures-sink` and `futures-channel` are added. TLS is not included in those eight;
the application chooses it. Clean build time and the proxy's operator time, money and memory
were not measured. No estimate is substituted for them.

## Eight Tabs

One browser context, eight tabs kept open, direct `serve_wrapped` with tokio-rustls, no proxy.
Every document was 200 with `nextHopProtocol` equal to `h2`; every tab received both the stock
feed and the trade stream, showed a positive price-update count, and its trade changed again
after all eight were open. One round per engine, Playwright 1.64.1:

| Engine | First load, ms | Other seven loads, ms | Result |
|---|---:|---|---|
| Chromium 156.0.8078.4 | 338 | 228, 207, 232, 242, 251, 253, 214 | Eight loaded and live |
| Firefox 157.0 | 677 | 139, 136, 222, 239, 169, 146, 122 | Eight loaded and live |
| WebKit | Not measured | Not measured | SSL connect error before document; not investigated |

The WebKit error was not investigated: environment versus protocol is unknown.
These are local navigation times, not a comparison with the earlier nginx run. The Chromium
smoke's first attempt used the wrong id (`prices-id` instead of `prices`) and timed out; it
was corrected from the served markup, not by weakening the update assertion. The complete
runtime smoke was not run over TLS: these are the bounded eight-tab probes, not Phase 2.
The weighing was **partial**: the issue's check 1 (three-engine runtime smoke over TLS) and
check 4 (shutdown and reset flood, plus stalled-stream isolation) were not done. The
zero-window probe observes one stalled response, not isolation beside a progressing sibling.

## Connection Rules

The prototype's `http2` feature enabled hyper's HTTP/2 and hyper-util's auto connection
builder only for `serve_wrapped`. It reads the 24-byte HTTP/2 preface after the TLS step;
there is no new public trait, and plain `serve` is unchanged. The TLS step advertises `h2`
and `http/1.1`; preface detection alone cannot check agreement with negotiated ALPN, so a
production design must enforce that at the TLS boundary. It is not h2c Upgrade support.

| Rule | Second answer and evidence |
|---|---|
| Connection cap | Keep the socket's existing permit for its entire lifetime, including TLS and HTTP/1.1 Upgrade. Add a separate bounded concurrent-stream setting; prototype advertises 100. Its sizing and override are not production API decisions. |
| Reset floods | Prototype explicitly sets hyper's pending-accept reset limit to 20 and local-error reset limit to 1,024. These bound different queues; neither is proof against every incoming reset pattern. A rapid-reset flood test and resource measurements remain required. |
| Shutdown | Hyper exposes `graceful_shutdown`/GOAWAY. Prototype calls it and drains to the app's longest deadline. Corten's one-request `Bound` cannot track concurrent route deadlines; preserving their contract, open-stream shutdown and rejection of new streams still need tests. |
| Header timeout | **Same as HTTP/1.1 while a response is open.** With 100 ms configured, stream 1 open at `/quiet` and stream 3's HEADERS missing END_HEADERS, a late CONTINUATION after 500 ms got a response. HTTP/1.1's watch is BUSY while an answer is open too. The untested gap is an idle h2 connection with no open streams. By inspection, the prototype calls `watch.take()` then `busy()` on the first h2 request, so no response can mark that watch idle again. |
| Send timeout | **Fails.** Client advertises INITIAL_WINDOW_SIZE=0, requests one event, receives response headers and no DATA, reset or GOAWAY for 500 ms with 100 ms configured. Granting stream credit then delivers the old event. The socket is writable throughout; the existing socket timer sees no stall. |
| Head size | HTTP/2 needs a decoded header-list bound, including pseudo-header accounting and trailers. Prototype sets 32 KiB. Header-count compatibility and partial compressed blocks were not verified. The auto builder lacks the HTTP/1 builder's `max_header_size` setter; its buffer cap is not equivalent. This is a prototype limitation: Corten could detect the preface itself and retain its HTTP/1 builder. |
| WebSockets | Do not advertise RFC 8441 extended CONNECT; retain the HTTP/1.1 Upgrade path. Explicit HTTP/2 refusal and browser WebSocket fallback still need tests. No RFC 8441 support is claimed. |

The send-timeout failure is a positive observation; the partial-header result is not a lost
HTTP/1.1 guarantee. `watch.rs` starts the header clock at connection open or the last answer's
end, and keeps it BUSY while an answer is open. A stream-counting idle watch is an untried way
to preserve that connection-level guarantee without adding a header timer beside a live stream.

Hyper 1.12.0 has no per-stream send-wait hook. Its `PipeToSendStream` polls the body, holds the
chunk and waits in `poll_capacity` without polling the body again. Corten's own `Answered`
wrapper can observe the handoff and absence of further polls, so a body-stall detector could
close the whole connection, the same granularity HTTP/1.1 uses. That design is **untried**;
the probe does not establish that a wrapper cannot enforce `send_timeout`. It must distinguish
quiet producers, final buffered chunks and progressing siblings without false timeouts.

A header-block hook is proposed in
[hyperium/h2 #928 Proposal: enable an HTTP/2 header-block read timeout](https://github.com/hyperium/h2/issues/928).
The related [hyperium/hyper #4228 Write a HIP for `Body::poll_progress()`](https://github.com/hyperium/hyper/issues/4228)
is a proposal for body progress, not an available per-stream send-wait API or proof it solves
this case. No second HTTP/2 frame parser in Corten is proposed.

## Values In Order

1. **Fast and proven fast:** the default pays no added dependencies or executable code; HTTP/2
   removes observed browser queuing, with the transport costs measured above. Neither benefit
   nor instruction cost alone establishes that the feature preserves security bounds.
2. **Standards first:** HTTP/2 is the right multiplexing protocol. A Corten-specific stream
   envelope would be a new wire format under [Rule 10](../../docs/design.md#rule-standard-formats), and
   still hit the cap at about six tabs.
3. **HTML on its own:** the prototype changes no markup or no-script path. Its checks do not
   establish every HTTP/2 behavior needed for a production deployment.
4. **Compile-time mistakes:** a Cargo feature and preface detection need no new TLS trait;
   ALPN configuration remains a deployment responsibility, not a compiler guarantee.
5. **One way:** retain ordinary routes and SSE, with no page-wide multiplexing lifecycle.
6. **Small surface:** eight opt-in crates buy a standard protocol, not mandatory cost for
   deployments whose edge already provides it. TLS stays outside the framework.
7. **Good defaults:** requiring a second server and ten proxy-specific concerns is a real cost.
   The deployment table has thirteen rows, but 5 is conditional on caching, and 9 and 12
   concern health and HTTPS even without a proxy.
   The existing measured `$host`/port WebSocket failure proves it is not just documentation.
   Put the caveat next to the README's production claim; do not describe the proxy as optional.
8. **Every surface:** browsers and native HTTP/2 clients can share one connection. The native
   client behavior was not rerun here, so the existing architecture record remains the evidence.
9. **Verified:** two eight-tab passes, a reproduced send stall, a busy-header control and
   an idle-watch bug found by inspection support only this partial weighing. They do not certify
   reset-flood protection, shutdown, WebSockets, WebKit or the full runtime smoke over HTTP/2.

The conflict order puts correctness and reliability first, performance second, typed seams
and one way third, convenience last. This is **two reliability failures**, not reliability
against convenience alone: without a proxy the live app already fails (the earlier watchlist
check got no answer for the fourth tab), and an opt-in feature would not change the default.
Defer because a feature should not silently weaken a security bound, not because the existing
deployment is adequate without a proxy. The decision is in [Choice 25](../../docs/design.md#choice-axum-router);
[Limit 14](../../docs/design.md#limit-http1) is its pointer. Close the weighing issue with this
partial evidence and track the connection-level design in a follow-up, not as completed HTTP/2.

## Follow-up Acceptance

The two bounds have separate tests and dispositions in
[Choice 25](../../docs/design.md#choice-axum-router). An upstream header-block timeout
reopens the header half alone. Expiring a header block while another response is open is
stronger than today's watch, not a prerequisite for matching HTTP/1.1. A send-wait hook
must cover DATA still queued after the body ends, not just credit awaited before the handoff.
An opt-in `serve` design must preserve both connection bounds together without a second parser.

[limits.mjs](limits.mjs) is the acceptance client. It prints each case and its timing,
and exits nonzero if any case in the selected suite fails. The tag's older client is only a
historical observation: it succeeds when the zero-window stall reproduces.

1. **Idle header bound:** finish a normal response (including END_STREAM), with no other stream
   open, then send HEADERS without END_HEADERS on the reused h2 connection. At
   `TIMEOUT_MS=100`, require connection closure by the 500 ms observation point and no response
   to a late CONTINUATION. Also test an open connection with no complete first request,
   return to idle after the last of overlapping answers, reset with a sibling and cancellation
   before the handler answers. An idle watch alone must stay busy while a final DATA tail
   awaits credit. Keep the `/quiet` sibling case open: its late CONTINUATION must still work.
2. **Stalled send bound:** retain the zero INITIAL_WINDOW_SIZE request, but require closure by
   500 ms and no delivery of the old response after WINDOW_UPDATE. Connection-level closure
   is sufficient; do not require a per-stream reset. Repeat with a final buffered tail and
   with a sibling that is demonstrably sending DATA. A quiet producer, normal response,
   credit recovery before the bound, continuous credit in small increments, and a canceled
   tail must not trip the detector.

Run the idle and send suites separately when evaluating a detector so that one timer cannot
pass the other's cases. Qualify the combined path separately, with both watches and the
socket write watch enabled and with controls that expect their joint behavior. For example,
a final tail stalled past the send deadline must close the connection even though it
keeps the idle watch busy; after the last normal response completes, the connection must
return to idle and close at the idle deadline, not remain reusable after 500 ms of inactivity.
For credit recovery and reset, keep a quiet sibling open so the idle watch cannot hide
a stale send timer. For socket backpressure, grant ample h2 credit and stop reading TCP
with a quiet sibling open. Require the socket write watch to expire with no outstanding
h2 buffers, and inspect the peer close after resuming reads. As its control, read the same
answer slowly but steadily, a little at intervals well within the bound and for much longer
than the bound in total: that client must stay open and receive the whole answer.
Before shipping, also run the full three-engine TLS runtime smoke,
reset flood and resource checks, shutdown with open streams, decoded-head bounds and explicit
h2 Upgrade refusal/HTTP/1 WebSocket fallback, and measure the enabled path against HTTP/1.1.
Shipping Corten is unchanged.

### Running the Follow-up

The [standalone probe](probe/Cargo.toml) uses the retained prototype's hyper, h2 and TLS
versions and Corten's `Body` and `live`, not the shipping connection loop. It retains
`/events?n=1` and `/quiet` and adds fixture answers for the new controls. The probe is a
separate Cargo workspace; no feature or dependency is added to Corten.

```sh
cargo build --release --locked --manifest-path bench/http2/probe/Cargo.toml
scratch=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$scratch/key.pem" -out "$scratch/cert.pem" -days 1 -subj /CN=localhost
export TLS_CERT="$scratch/cert.pem" TLS_KEY="$scratch/key.pem" TIMEOUT_MS=100
probe="${CARGO_TARGET_DIR:-bench/http2/probe/target}/release/http2-limit-probe"
"$probe" h2-idle
# With the probe listening, in another shell:
node bench/http2/limits.mjs idle
```

Stop the probe between modes. Run `idle` for `service-idle` (count the service future
and body) and `h2-idle` (direct h2 active count), and `send` for `off` (negative
control), `body` (next body poll/drop) and `buffer` (observed byte consumption and
buffer drop). The probe defaults to loopback port 18590; on another loopback port, set
`BIND` for the probe and `HTTP2_PORT` for the client. Delete the scratch certificate and
key when done.

For all three watches together, run the direct h2 probe and the client in one Linux
network namespace, here one `node:24-bookworm` container, with the same TLS setup. The
probe runs inside the container, so it must be a Linux release build whose glibc is no
newer than the image's (Debian bookworm, 2.36), for example built in `rust:1-bookworm`.
The host build above serves only on such a host. Copy that build into `$scratch` beside
the certificate and key, and wait for the probe to listen before starting the client:

```sh
cp "$probe" "$scratch/http2-limit-probe"
docker run --rm -d --name http2-combined --sysctl net.ipv4.tcp_rmem="4096 131072 131072" -v "$scratch:/probe" -v "$PWD/bench/http2:/bench:ro" node:24-bookworm sleep infinity
docker exec -d -e TLS_CERT=/probe/cert.pem -e TLS_KEY=/probe/key.pem -e TIMEOUT_MS=100 -e SOCKET_SEND_BUFFER=16384 http2-combined sh -c '/probe/http2-limit-probe combined > /probe/probe.log 2>&1'
docker exec http2-combined timeout 10 sh -c 'until grep -qs "listening on" /probe/probe.log; do sleep 0.1; done'
docker exec http2-combined node /bench/limits.mjs combined
docker rm -f http2-combined
```

The smaller send buffer and the 128 KiB receive-buffer cap are fixture setup, not new send
bounds; the client fails both socket cases unless it sees the cap. Without it, Linux grew a
sampled paused reader's receive buffer to 632,943 bytes (about 618 KiB), and in some runs
no socket timeout came within the 500 ms window ([Combined Results](#combined-results)).
Run client and server on the same loopback interface, without a forwarding proxy that
can read on the client's behalf. The socket fixture grants enough stream and connection
credit for its whole response. It queues one batch of short DATA chunks at a time and
stops producing when the TLS writer blocks. h2 copies the batch into its encoder before
polling TLS. At socket timeout the probe records the operation, outstanding DATA buffer count,
wait duration and time from the fixture request on a separate connection; the client
reads this before it resumes the stalled socket. Run one acceptance client at a time.

For overhead, use a fresh process for each 200 and 1,200 count, `TIMEOUT_MS=30000`,
and the same Callgrind procedure as [Transport Counts](#transport-counts), below. Run
`node bench/http2/load.mjs h2 <count> page` for `off` versus `service-idle` and
`h2-off` versus `h2-idle`; use `events` for `off`, `body` and `buffer`. Each
comparison is within one transport, not against shipping HTTP/1.1. The hyper `off`
mode still uses the same body and buffer wrapper types but records no progress or timestamps.
For the combined comparison, run both loads with `h2-off` and `combined` on the same
release binary, without `SOCKET_SEND_BUFFER` or the receive-buffer cap. `node:24-bookworm`
has no Valgrind: start the container without the `--sysctl` option and install Debian's
package in it first (`apt-get update && apt-get install -y valgrind`, 3.19.0 on bookworm),
or use another bookworm image with Valgrind and Node 24.

### Follow-up Results

Rerun on 2026-11-19 UTC after resolving the [probe lockfile](probe/Cargo.lock) with
Cargo 1.100: `bytes` 1.12.2 and `smallvec` 1.16.6 were younger than three days at the
first measurement. The replacements are `bytes` 1.12.1 (published 2026-07-08 UTC)
and `smallvec` 1.16.5 (published 2026-11-06 UTC). The crates.io index confirmed
the checksum and publish time of all 77 registry entries, all at least three days old.

Three rounds over loopback TLS used the Linux release probe (Rust 1.99.1) in Docker Desktop
and the Node 24 client on the host. The probe checked elapsed time every 10 ms with both strict
suites run at `TIMEOUT_MS=100`; the client required actual connection closure by 500 ms,
not just GOAWAY or a reset. The ranges below are measured min to max across the three
rounds. [Rerun observations](results/follow-up-wire-r2.jsonl) include the late-write attempt
and whether an old answer appeared. All 120 pass/fail outcomes match the
[earlier-lock observations](results/follow-up-wire.jsonl), retained unchanged.

| Idle case | Hyper service count | Direct h2 count |
|---|---|---|
| No first request | Pass, closed 121.8-139.4 ms | Pass, closed 129.9-132.0 ms |
| Partial first request | Pass, closed 118.1-127.0 ms | Pass, closed 114.7-119.2 ms |
| Partial head after a complete answer | Pass, closed 110.1-112.9 ms | Pass, closed 110.5-113.2 ms |
| Last of two overlapping answers | Pass, closed 107.7-112.3 ms after last end | Pass, closed 111.0-112.7 ms after last end |
| Reset with sibling open, then reset sibling | Pass, closed 106.6-112.3 ms after last reset | Pass, closed 104.8-112.8 ms after last reset |
| Cancel before the handler answers | Pass, closed 108.1-110.7 ms after reset | Pass, closed 106.7-113.7 ms after reset |
| Partial head beside open `/quiet` | Pass, late answer at 511.9-516.8 ms | Pass, late answer at 508.8-517.6 ms |
| Queued final answer stays busy | **Fail**, closed at 97.5-100.9 ms without credit | Pass, drained at 504.4-515.9 ms, closed 107.1-108.7 ms later |

The first two ranges start at the client's connection open. The other closure times start
at the relevant response end or reset, except the premature close for queued DATA, measured
from receipt of its first byte. No late CONTINUATION revived an idle connection; the
open-sibling case deliberately allowed it. Direct h2's `Connection::has_streams()` includes
queued DATA in these runs; Hyper's service future and body guards do not. This is an
independent idle-watch result, not a requirement for a new header-block timeout.

| Send case | No detector | Body polls/drop | Buffer consumption/drop |
|---|---|---|---|
| Zero-window `/events?n=1` | **Fail**, late event 503.6-522.2 ms | Pass, closed 111.8-117.3 ms | Pass, closed 111.9-114.5 ms |
| Final chunk buffered after first byte | **Fail**, late tail 507.8-523.6 ms | **Fail**, late tail 512.5-530.9 ms | Pass, closed 111.0-116.6 ms |
| Same tail with progressing sibling | **Fail**, late tail 507.4-511.7 ms | **Fail**, late tail 510.5-512.1 ms | Pass, closed 111.8-112.5 ms; five sibling writes each time |
| Quiet producer | Pass, still open 503.7-508.5 ms | Pass, still open 506.5-515.9 ms | Pass, still open 504.9-523.4 ms |
| Normal response | Pass, reused at 514.0-523.3 ms | Pass, reused at 515.3-519.3 ms | Pass, reused at 508.8-533.4 ms |
| Credit restored before the bound | Pass, completed 49.8-67.0 ms | Pass, completed 52.4-66.2 ms | Pass, completed 56.9-59.2 ms |
| Incremental credit for one final chunk | Pass, completed 249.5-279.8 ms | Pass, completed 259.1-276.7 ms | Pass, completed 251.6-279.2 ms |
| Reset discards a queued tail | Pass, reused at 513.8-516.5 ms | Pass, reused at 510.4-515.1 ms | Pass, reused at 504.5-511.0 ms |

Stall times start at the request. In the passing stall cases the late WINDOW_UPDATE could
not be written to the closed connection and no old DATA appeared. Early credit was sent
45.4-64.6 ms from the request across the three modes. The body-only detector clears on
another poll or drop, as it must to leave normal answers and quiet producers alone. That
misses the two tails still in h2. The buffer detector follows DATA handed from Hyper to h2:
consuming bytes renews its deadline, and exhaustion or drop removes it. With the pinned
libraries, h2 only consumes a flow-controlled slice, so a remaining tail keeps its timer
even if the body is gone. Consumption can mean copy into the HTTP/2 encoder, not TLS or
socket progress; it does not replace Corten's socket write watch.

These runs exercised the idle and send candidates in separate transport modes.
The combined probe has its own controls and results below.

#### Follow-up Cost

Measured server instructions with Callgrind 3.19.0, three alternating paired rounds on the
revised lock ([rerun counts](results/follow-up-costs-r2.csv);
[earlier-lock counts](results/follow-up-costs.csv)). The page has a 9-byte body; the event
sample is a single response carrying the original 84-byte SSE event, repeated, followed by
one fixed 22-byte end event. Subtracting the 200-count run from the 1,200-count run removes
startup and one TLS handshake, and removes the fixed end event from the event comparison.

| Transport and enabled watch | Unit | Detector off median [min, max] | Detector on median [min, max] |
|---|---|---:|---:|
| Hyper service count | instructions/page | 29,917 [29,903, 30,149] | 30,587 [30,561, 30,618] |
| Direct h2 active count | instructions/page | 25,940 [25,937, 25,943] | 26,721 [26,719, 26,721] |
| Hyper body polls/drop | instructions/event | 5,043 [5,043, 5,045] | 5,583 [5,582, 5,585] |
| Hyper buffer consumption/drop | instructions/event | 5,043 [5,043, 5,045] | 5,696 [5,695, 5,696] |

Compared with the earlier lock, all seven medians are lower by 4 to 285 instructions per
unit (rounded). Each enabled median is still above its corresponding off median. The
rerun does not isolate the cause of the shift. These are fixture costs, not an estimate of
combined overhead, a network latency comparison, or a change to shipping Corten's request path.

## Combined Results

The `combined` mode runs direct h2 with its stream count as the idle watch, tracks DATA
through `Buf::advance`, including after the response body ends, and wraps the
post-handshake TLS stream as Corten wraps `Watched`. A pending write, vectored write,
flush or shutdown starts a socket wait; a completed write clears it, but a flush or
shutdown alone does not. The probe uses a per-stall timer on its single runtime thread
instead of Corten's shared clock thread. All three watch the same connection, and there
is no frame parser. The isolated modes keep their code paths.

The locked build at `00d9e712c` needed a lockfile refresh: Corten now requires
`getrandom` 0.4. The probe uses `getrandom` 0.4.3 (published 2026-06-17 UTC) and
`r-efi` 6.0.0 (2026-02-03 UTC) and no longer needs the old WASI entries. No other
lock entry changed. The crates.io index confirmed the checksums of all 75 registry
entries and that each was published at least three days before the run.

Measured on 2026-11-20 UTC with the Linux release probe built from `a8431b062`
(Rust 1.99.1), probe and Node 24.22.3 client in one `node:24-bookworm` container
on Docker Desktop, `TIMEOUT_MS=100`, the 128 KiB receive-buffer cap and the strict
500 ms closure cutoff. Ranges are measured min to max over three rounds
([observations](results/combined-wire.jsonl)); all 51 outcomes passed.

| Combined case | Result |
|---|---|
| No first request | Pass, closed 120.2-144.9 ms after open |
| Partial first request | Pass, closed 108.4-111.5 ms after open |
| Partial head after a complete answer | Pass, closed 103.4-108.7 ms after the answer ended |
| Last of two overlapping answers | Pass, closed 105.8-106.7 ms after the last end |
| Reset with sibling open, then reset sibling | Pass, open for 500 ms with the sibling; closed 101.3-112.4 ms after the last reset |
| Cancel before the handler answers | Pass, closed 108.7-112.6 ms after reset |
| Partial head beside open `/quiet` | Pass, late answer at 500.9-503.1 ms |
| Queued final answer (replaces the idle-only control) | Pass, send watch closed it 105.6-110.5 ms after its first byte while the stream kept idle busy |
| Zero-window `/events?n=1` | Pass, closed 108.8-115.5 ms |
| Final chunk buffered after first byte | Pass, closed 109.4-111.9 ms |
| Same tail with progressing sibling | Pass, closed 109.1-116.4 ms; four or five sibling writes |
| Quiet producer | Pass, still open 500.2-502.4 ms, sibling page at 500.9-507.1 ms |
| Normal response returns to idle (replaces the send-only control) | Pass, closed 107.7-109.6 ms after the page ended |
| Credit restored before the bound, `/quiet` open | Pass, completed 37.8-39.4 ms; reused at 240.3-243.0 ms |
| Incremental credit for one final chunk | Pass, completed 192.8-202.9 ms |
| Reset discards a queued tail, `/quiet` open | Pass, reused at 501.5-505.4 ms after reset |
| Paused TCP reader after h2 consumed DATA | Pass, socket watch expired 154-165 ms after the request |

Times start as in [Follow-up Results](#follow-up-results). No late frame revived a
closed connection or delivered an old answer. In the socket case `/quiet` held the idle
watch busy, so the socket watch closed the connection on its own. Each round
reported a pending `flush` with zero outstanding h2 DATA buffers after a 100-104 ms wait.
The client received 232,560-269,280 DATA bytes, with no END_STREAM or reset. The peer
close arrived 6.3-25.5 ms after reads resumed.

Six earlier rounds at the same build ran without the receive-buffer cap
([observations](results/combined-wire-uncapped.jsonl); rounds 1-3 used the client
before it selected the replaced idle control by name, with the same 17 cases in order).
Rounds 1-4 passed every case. Rounds 5 and 6 failed only the socket case. In round 5 no
socket timeout had been reported after 505.8 ms paused; the peer closed 31.1 ms after
reads resumed with 771,120 bytes delivered. In round 6 no socket timeout came at all:
none was reported before reads resumed, and the peer did not close within 500 ms after.
Its 4,296,240 bytes, like round 5's, include reading after the resume, so neither count
is a receive-buffer size.

Eight single-case [diagnostic runs](results/combined-socket-diag-uncapped.jsonl) of the
paused reader, also uncapped and on the same build, sampled the client's socket with `ss`
every 50 ms from the start of the case, just before the request (the file keeps each
sample's receive queue, receive buffer and bytes received). Seven passed, the socket
watch expiring 176-277 ms after the request. In the failing run (run 5) the receive
buffer was 632,943 bytes (about 618 KiB); the queue reached 622,006 bytes at 378 ms and
stayed there through the last sample at 553 ms. The socket watch did fire there, on a
pending `flush` with no outstanding h2 buffers after a 103 ms wait, 514 ms after the
request: 14 ms past the cutoff. The 100 ms bound held; only the stall started late, once
the larger buffer had filled. The cap changes when the kernel stops accepting data, not
the watch, its 100 ms bound or the 500 ms check.

Three [preflight rounds](results/combined-wire-preflight.jsonl) at `4ea726f8c` used
one 255-byte DATA chunk per TLS flush in the TCP fixture. All three missed the socket
timeout: no report after 499.7-500.5 ms paused and no peer close within 500 ms of
resuming. The client read 1,702,635-2,050,200 DATA bytes before giving up, including up
to 500 ms of reading after the resume, so these are not receive-buffer sizes. Round 3 also
closed the stalled tail in 144.3 ms with only one observed sibling write, failing the
repeated-progress check. The fixture now batches the short chunks to fill the TCP
window sooner. Neither test's assertion nor its deadline was relaxed.

The isolated suites still reproduce on this build: one round per mode, without the cap,
client in the same container rather than on the host
([observations](results/combined-isolated-wire.jsonl)). Direct h2 passed all eight idle
cases; Hyper service counting failed only the queued final answer (closed at 106.3 ms);
no detector failed the three send stalls, body polls/drop the two tails, and buffer
tracking passed all eight. These are the dispositions in Follow-up Results.

### Steady Reader Control

The suite's last case is the socket watch's control. It uses the paused reader's fixture
(the receive-buffer cap, `/quiet` open, h2 credit for the whole answer), but the client
resumes reading every 20 ms and pauses again once it has read at least 16 KiB. It must
receive the whole 8,355,840-byte answer with END_STREAM, the connection must stay open,
and the probe must report no socket timeout. Measured on 2026-11-20 UTC with the same probe
build and container setup, `TIMEOUT_MS=100` and the cap, seven rounds of the whole
18-case suite, each against a fresh probe process
([observations](results/combined-wire-control.jsonl)). Round 0 was the first in a fresh
container, run to try the new case; the case did not change after it, and round 0 counts
as a full round in every total here. A cold start was not shown to matter. Rounds 1-3 were
the planned three, and 4-6 were added to see whether round 0's failure recurred.

The 17 earlier cases passed in all seven rounds (119 of 119); the paused reader's socket
watch expired 150-166 ms after the request. The steady reader passed in rounds 1-6: it
received the whole answer in 6,878-6,988 ms at an average of 1.20-1.21 MB/s, with at most
21.1-39.9 ms between reads. **In round 0 it failed.** The socket watch expired on a
pending `flush` with no outstanding h2 buffers after a 100 ms wait, 352 ms after the
request, although the client had read at least every 20.7 ms. The client had received
526,320 bytes and saw the close 443.7 ms after its request.

That is a false close: the socket watch disconnected a client that kept reading, each time
well within the bound. One failure in seven rounds is not a measured rate. Two causes fit
the saved row, and neither was measured:

1. A TLS flush that stays pending while records drain (reasoned, not measured). By the
   tokio-rustls 0.26.6 source, `poll_flush` stays pending until every buffered TLS record
   is written, even after partial writes, and this watch, like Corten's, clears a stall
   only on a completed write, not when a flush completes. One flush could then stay
   pending across several steady reads while bytes go out.
2. A receive window that reopens only in large steps (reasoned, not measured). Under the
   128 KiB cap, the loopback receive window may reopen only in large steps, so the
   server's socket could accept nothing for the whole wait while the client drains its
   own queue. Renewing the stall on TLS progress would not help then.

The row records the client's reads, not whether the server's socket accepted bytes during
the 100 ms wait. Counting the bytes written under TLS during a stall would separate the
two: bytes written while the flush stays pending point to the first, none to the second.

The fixture also limits how far the result carries. It queues its next batch only when the
socket is not blocked, and any pending call, a flush included, marks it blocked, so every
batch boundary is an interval with only a flush outstanding and no write that could clear
the stall. A body that keeps producing would call `poll_write`, which rustls accepts while
its 64 KiB `sendable_tls` limit has room, and that clears the stall. When the probe ran,
shipping HTTP/1.1 applied the same flush rule in `crates/corten/src/watch.rs`, and whether
it closed such a reader over TLS was the open question in
[#1742 A TLS flush that stays pending while a slow client reads steadily may trip send_timeout: test serve_wrapped over TLS with a steady reader](https://github.com/corten-run/corten/issues/1742).

The probe and the rounds above are kept as they ran; the probe's watch still clears a stall
only on a completed write. Shipping HTTP/1.1 no longer does: since
[#1756 Start the send timeout's wait over each time the connection reports room, so a TLS write still sending its bytes is not cut at one timeout](https://github.com/corten-run/corten/pull/1756),
Corten's watch starts the wait over each time the connection reports room while a write,
flush or close waits, so a flush that stays pending while its records drain is cut only when
the connection goes a send timeout without reporting room. How far apart those reports come
depends on how the client takes bytes from its socket: with 16 KiB buffers and a 2 s send
timeout, a tokio-rustls client taking 2 KiB every 125 ms, whose socket reads come as whole
records, was still cut in 5 of 5 rounds, while the same rate read evenly from the socket was
kept past 30 s over TLS and plain HTTP alike. The regression test is
`a_flush_that_waits_while_its_bytes_go_out_is_held_only_to_the_send_timeout` in
`crates/corten/src/tests/server.rs`. That change does not address the second cause, a
receive window that reopens only in large steps, and the combined path's HTTP/2 watch
still has to pass the acceptance below.

A socket watch that closes a steadily reading client blocks shipping: the combined path
does not qualify until the full combined suite, steady reader included, passes 10
consecutive rounds with zero failures.

### Combined Cost

Measured server instructions with Callgrind 3.19.0, three alternating paired rounds of
`h2-off` against `combined` on the same release binary, on the procedure in
[Follow-up Cost](#follow-up-cost) with the client in the container
([counts](results/combined-costs.csv)).

| Unit | `h2-off` median [min, max] | `combined` median [min, max] |
|---|---:|---:|
| instructions/page | 26,142 [26,141, 26,144] | 27,939 [27,928, 27,947] |
| instructions/event | 4,179 [4,177, 4,185] | 5,115 [5,115, 5,116] |

All three watches add 1,797 instructions per page (6.9%) and 936 per event (22.4%). The
ranges do not overlap. This is the probe's cost on direct h2, not a production path or
a comparison with HTTP/1.1. The `h2-off` median differs from Follow-up Cost's 25,940.
This pull request changed the `h2-off` code path itself (`h2_probe` is now generic, with a
`fn` wrapper on every `send_data`, and `h2_reply` gained the `answer` block), and Corten,
the lockfile and the client placement are newer; the two sections are not compared. These
counts were taken before the steady reader control was added, which changed only the client.

These runs are evidence for, not completion of,
[#1686 HTTP/2 in corten::serve: show the idle and send bounds together with the socket watch on one opt-in path](https://github.com/corten-run/corten/issues/1686).
One parser-free path held both bounds with the socket watch under the 17 original combined
controls, which passed in every round. The 18th, the socket watch's steady reader control,
failed 1 of 7 rounds, so the combined evidence is not complete. That issue stays open for
the remaining probe work: the full combined suite, steady reader included, passing 10
consecutive rounds with zero failures. Shipping Corten is unchanged. The shipping work is
tracked in
[#1739 HTTP/2 in corten::serve: an opt-in path that passes the combined bounds suite and the shipping checks](https://github.com/corten-run/corten/issues/1739):
shutdown with open streams, reset-flood and resource bounds, decoded-header limits,
explicit h2 Upgrade refusal with HTTP/1 WebSocket fallback, three-engine TLS smoke, and
the enabled path's cost against HTTP/1.1.

## Reproduction

The following is a reconstruction of the measured procedure for a POSIX shell, Docker and
Node 22 or newer. The measurements used the `rust:1-bookworm` image, Rust 1.99.1 and Debian
Valgrind 3.19.0; the commands pin the compiler and print tool versions. A mutable image or
package archive may now supply other tools: record that difference rather than treating new
numbers as the saved run. The expanded commands below were not rerun for this documentation
correction. The load and tabs clients are the tag's clients; the historical limits client
is run from the archived tag, not from the decision checkout.

### Sources and Container

From the decision checkout, keep all scratch writes outside the tracked benchmark directories.
The prototype server, TLS watchlist entry point, item test and separate probe lockfile are in
the tag, not in this directory. `70e523f3b` reaches `1a8adcb5f` and baseline `ecbef5eb`.

```sh
git fetch origin refs/tags/evidence/http2-prototype:refs/tags/evidence/http2-prototype
scratch=$(mktemp -d)
mkdir -p "$scratch/prototype" "$scratch/baseline" "$scratch/results"
git archive evidence/http2-prototype | tar -x -C "$scratch/prototype"
git archive ecbef5eb | tar -x -C "$scratch/baseline"
git diff ecbef5eb evidence/http2-prototype -- examples/card-market/src/app.rs > "$scratch/item.patch"
patch -d "$scratch/baseline" -p1 < "$scratch/item.patch"
docker run --rm -d --name http2-measure -p 127.0.0.1:18590:8080 -v "$scratch:/src" -v "$PWD:/record:ro" -e CARGO_TARGET_DIR=/target -w /src/prototype rust:1-bookworm sleep infinity
docker exec http2-measure sh -ec 'apt-get update; apt-get install -y valgrind binutils openssl jq; rustup toolchain install 1.99.1 --profile minimal; rustup default 1.99.1; rustc --version; valgrind --version'
docker exec http2-measure openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/http2-key.pem -out /tmp/http2-cert.pem -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1
npm ci --no-audit --no-fund
npx playwright install chromium firefox webkit
```

The patch contains only the ignored `http2_request_cost` test. It adds the same
`oneshot`/body-collection loop to baseline as the prototype, not the HTTP/2 feature.
Inspect `item.patch` before applying it. The container has no target or certificate volume:
`/target` and the test-only private key disappear when it is removed. The clients disable
certificate validation solely for this self-signed local test. Port 18590 is bound to loopback.

### Item Cost and Feature Off

Build each copy without enabling `http2`. Separate target directories prevent artifacts from
one source copy being mistaken for another's. The JSON build messages identify the test
executables; run them directly so Cargo is not counted. Both builds use the tag's release
profile (thin LTO, one codegen unit).

```sh
docker exec -w /src/baseline -e CARGO_TARGET_DIR=/target/baseline http2-measure sh -ec 'cargo test --release --locked -p card-market --no-run --message-format=json > /tmp/baseline-build.jsonl'
docker exec -w /src/prototype -e CARGO_TARGET_DIR=/target/off http2-measure sh -ec 'cargo test --release --locked -p card-market --no-run --message-format=json > /tmp/off-build.jsonl'
docker exec http2-measure sh -ec '
  for variant in baseline off; do
    jq -r '"'"'select(.reason == "compiler-artifact" and .target.name == "card-market" and .profile.test and .executable != null) | .executable'"'"' /tmp/$variant-build.jsonl > /tmp/$variant-test
    test "$(wc -l < /tmp/$variant-test)" -eq 1
    objcopy --dump-section .text=/tmp/$variant.text "$(cat /tmp/$variant-test)"
  done
  sha256sum /tmp/baseline.text /tmp/off.text
  cmp /tmp/baseline.text /tmp/off.text
  for round in 1 2 3; do
    for variant in baseline off; do
      for count in 200 1200; do
        REQUESTS=$count valgrind --tool=callgrind --callgrind-out-file=/src/results/item-$variant-$round-$count.callgrind "$(cat /tmp/$variant-test)" --ignored --exact app::tests::http2_request_cost --nocapture
      done
    done
  done'
```

The test asserts status 200 for `/items/item_5` and consumes its entire body. No
`CORTEN_FIXTURE` variable is needed: the harness embeds `fixtures/smoke.json`. The first
attempt's missing `item_1` assertion failure is not part of the results.

For the dependency count, generate a template from each source using that copy's CLI, then
count unique normal/build package-version entries excluding the template root:

```sh
docker exec -w /src/baseline http2-measure cargo run -q -p corten-cli -- new /tmp/template-base --corten-path /src/baseline/crates/corten
docker exec -w /src/prototype http2-measure cargo run -q -p corten-cli -- new /tmp/template-off --corten-path /src/prototype/crates/corten
docker exec -w /tmp/template-base http2-measure cargo tree --edges normal,build --prefix none --format '{p}'
docker exec -w /tmp/template-off http2-measure cargo tree --edges normal,build --prefix none --format '{p}'
docker exec -w /tmp/template-off http2-measure cargo tree --edges normal,build --prefix none --format '{p}' --features corten/http2
```

Deduplicate by package/version, not the rendered path or `(*)` repeated-node marker. Normalize
the source-copy path before comparing trees. The saved counts were 59, 59 and 67; a newly
resolved template lockfile can differ if the registry changes. The eight additions and
measurement versions are listed above; the probe's lockfile is retained in the tag.

### Direct TLS Tabs and Limits

Only one server may own port 8080 at a time. Start the watchlist, run each engine separately,
then stop it before starting the probe:

```sh
docker exec http2-measure cargo build --release --locked -p watchlist --features http2-prototype
docker exec -d -e HOST=0.0.0.0 -e PORT=8080 http2-measure sh -c 'echo $$ > /tmp/server.pid; exec /target/release/watchlist'
node bench/http2/tabs.mjs chromium
node bench/http2/tabs.mjs firefox
node bench/http2/tabs.mjs webkit
docker exec http2-measure sh -ec 'kill -TERM "$(cat /tmp/server.pid)"; while kill -0 "$(cat /tmp/server.pid)" 2>/dev/null; do sleep 0.1; done'
docker exec http2-measure cargo build --release --locked --manifest-path work/http2/probe/Cargo.toml
docker exec -d -e HOST=0.0.0.0 -e PORT=8080 -e TIMEOUT_MS=100 http2-measure sh -c 'echo $$ > /tmp/server.pid; exec /target/release/http2-probe'
node "$scratch/prototype/work/http2/limits.mjs"
docker exec http2-measure sh -ec 'kill -TERM "$(cat /tmp/server.pid)"; while kill -0 "$(cat /tmp/server.pid)" 2>/dev/null; do sleep 0.1; done'
```

Wait for the server to listen before invoking a client. The historical limits client expects
the send stall and the busy-header control described above; [Follow-up Acceptance](#follow-up-acceptance)
tests the bounds instead.

### Transport Counts

Use the probe's normal 30-second timeout, not `TIMEOUT_MS=100`. For each round, alternate
HTTP/1.1 and HTTP/2 through the same feature-on auto-builder binary, with a fresh process for
each 200/1,200 count. Callgrind counts only the server; the Node client runs on the host.
Stop with SIGTERM and wait for exit so callgrind writes its final summary.

```sh
for round in 1 2 3; do
  for kind in page events; do
    for protocol in h1 h2; do
      for count in 200 1200; do
        name=$kind-$protocol-$round-$count
        docker exec -d -e HOST=0.0.0.0 -e PORT=8080 -e NAME="$name" http2-measure sh -c 'echo $$ > /tmp/server.pid; exec valgrind --tool=callgrind --callgrind-out-file=/src/results/$NAME.callgrind --log-file=/src/results/$NAME.log /target/release/http2-probe'
        sleep 3
        node bench/http2/load.mjs "$protocol" "$count" "$kind"
        docker exec http2-measure sh -ec 'kill -TERM "$(cat /tmp/server.pid)"; while kill -0 "$(cat /tmp/server.pid)" 2>/dev/null; do sleep 0.1; done'
      done
    done
  done
done
```

For each file, check its `events:` line: this run collected only `Ir`. Read the numeric
`summary:` value, not a sum of the per-function rows (which can double-count calls).
For example, after verifying `events: Ir`:

```sh
grep '^events:' "$scratch/results/page-h2-1-200.callgrind"
awk '/^summary:/ { print $2 }' "$scratch/results/page-h2-1-200.callgrind"
awk '/^summary:/ { print $2 }' "$scratch/results/page-h2-1-1200.callgrind"
```

Subtract the 200 total from the corresponding 1,200 total and divide by 1,000, then report
the median and range of the three rounds. This removes startup and one TLS handshake per
run. For `events`, each load is one response containing 200 or 1,200 events, not that many
requests. [results/counts.csv](results/counts.csv) keeps the saved paired totals and quotients;
the original full callgrind files were temporary and are not retained.

Finally remove the container (including the test key) and the two scratch source copies and
generated results when no longer needed. Keep only deliberately retained measurement output.

```sh
docker rm -f -v http2-measure
rm -rf "$scratch"
```
