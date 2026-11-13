# HTTP/2 without a proxy

Decision on 2026-11-13: **option 2 for now**, with option 1 the direction to revisit. Do not
ship an HTTP/2 feature that silently loses the header and stalled-send bounds. This does not
decide that a proxy is cheap or that HTTP/2 is too expensive.

This answers [#1287 Limit 14 makes a proxy a requirement for live streams: weigh HTTP/2 in corten::serve again, with the cost of the requirement on the scale](https://github.com/corten-run/corten/issues/1287).
The baseline is `ecbef5eb`; the executable prototype and probes are at `1a8adcb5f`, with the
measurement driver's shell-quoting correction at `70e523f3b`. Those commits are kept in this
branch's ancestry for reproduction; none of the prototype is in the final framework.

## Measurements

All numbers below are **measured**, not estimated. Counts are Valgrind 3.19.0 callgrind `Ir`,
release builds with thin LTO and one codegen unit, Rust 1.99.1, Linux in Docker Desktop.
No throughput or latency comparison under load was made on this shared machine.

| Workload | HTTP/1.1 / baseline median [min, max] | HTTP/2 / feature-off median [min, max] |
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
not the entire build artifacts. The [raw totals](http2-counts.csv) retain every reported round.

The transport probe is deliberately smaller than the item page: a 378-byte document, one
keep-alive TLS connection, sequential requests, and the same binary for both protocols. The
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
| WebKit | Not measured | Not measured | SSL connect error before document; unverified |

These are local navigation times, not a comparison with the earlier nginx run. The Chromium
smoke's first attempt used the wrong id (`prices-id` instead of `prices`) and timed out; it
was corrected from the served markup, not by weakening the update assertion. The complete
runtime smoke was not run over TLS: these are the bounded eight-tab probes, not Phase 2.

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
| Header timeout | **Fails.** With 100 ms configured, stream 1 open at `/quiet` and stream 3's HEADERS missing END_HEADERS, waiting 500 ms did not close the connection. A late CONTINUATION completed the request and got a response. The service sees only complete heads; a handler timer cannot fix this. |
| Send timeout | **Fails.** Client advertises INITIAL_WINDOW_SIZE=0, requests one event, receives response headers and no DATA, reset or GOAWAY for 500 ms with 100 ms configured. Granting stream credit then delivers the old event. The socket is writable throughout; the existing socket timer sees no stall. |
| Head size | HTTP/2 needs a decoded header-list bound, including pseudo-header accounting and trailers. Prototype sets 32 KiB. Header-count compatibility and partial compressed blocks were not verified. The auto builder also lacks the HTTP/1 builder's `max_header_size` setter; its buffer cap is not an equivalent replacement. |
| WebSockets | Do not advertise RFC 8441 extended CONNECT; retain the HTTP/1.1 Upgrade path. Explicit HTTP/2 refusal and browser WebSocket fallback still need tests. No RFC 8441 support is claimed. |

The timeout failures are positive observations, not just missing tests: each old request
completed after its configured timeout when the client resumed. Hyper's HTTP/2 builder has
no equivalent of its HTTP/1 header-read timeout, and `PipeToSendStream` can hold a body chunk
while waiting on `poll_capacity` without polling the response body again. A wrapper around
the handler or the socket cannot enforce those two contracts. Do not build another HTTP/2
frame parser in Corten merely to recover them; first investigate supported hooks in hyper/h2.

## Values In Order

1. **Fast and proven fast:** the default pays no added dependencies or executable code; HTTP/2
   removes observed browser queuing, with the transport costs measured above. Neither benefit
   nor instruction cost alone excuses lost timeouts.
2. **Standards first:** HTTP/2 is the right multiplexing protocol. A Corten-specific stream
   envelope would be a new wire format under [Rule 10](../design.md#rule-standard-formats), and
   still hit the cap at about six tabs.
3. **HTML on its own:** the prototype changes no markup or no-script path. Its checks do not
   establish every HTTP/2 behavior needed for a production deployment.
4. **Compile-time mistakes:** a Cargo feature and preface detection need no new TLS trait;
   ALPN configuration remains a deployment responsibility, not a compiler guarantee.
5. **One way:** retain ordinary routes and SSE, with no page-wide multiplexing lifecycle.
6. **Small surface:** eight opt-in crates buy a standard protocol, not mandatory cost for
   deployments whose edge already provides it. TLS stays outside the framework.
7. **Good defaults:** requiring a second server and twelve deployment rules is a real cost.
   The existing measured `$host`/port WebSocket failure proves it is not just documentation.
   Put the caveat next to the README's production claim; do not describe the proxy as optional.
8. **Every surface:** browsers and native HTTP/2 clients can share one connection. The native
   client behavior was not rerun here, so the existing architecture record remains the evidence.
9. **Verified:** two eight-tab passes and two reproduced timeout failures support this bounded
   decision. They do not certify reset-flood protection, shutdown, WebSockets, WebKit or the
   full runtime smoke over HTTP/2.

The conflict order puts correctness and reliability first, performance second, typed seams
and one way third, convenience last. Keep [Limit 14](../design.md#limit-http1) while the two
missing bounds remain.
Reopen option 1 when those bounds can be enforced without a second protocol parser, with a
reset flood, a stalled single stream beside a progressing sibling, shutdown with open streams,
header limits, explicit WebSocket behavior and the three-engine TLS smoke tested. Keep the
issue open for that work; this decision records the costs rather than claiming the requirement
has been removed. [Choice 25](../design.md#choice-axum-router) still ships only hyper's HTTP/1.1
and must be reopened when HTTP/2 actually ships. HTTP/3 remains out for the reasons in
[Limit 14](../design.md#limit-http1).

## Reproduction

Use the prototype commit's source, not the final documentation-only tree. The measurement
driver correction is `70e523f3b`; `work/http2/` there holds the scripts and the probe's lockfile.
Build the watchlist with `cargo build --release -p watchlist --features http2-prototype`.
Its temporary TLS entry point reads `/tmp/http2-cert.pem` and `/tmp/http2-key.pem`, a local
test certificate/key for localhost. Set `HOST=0.0.0.0`, `PORT=8080`, map the test server to
localhost:18590, and run `node work/http2/tabs.mjs chromium` (or `firefox`, `webkit`).

For the transport and adverse-client probes, build
`cargo build --release --locked --manifest-path work/http2/probe/Cargo.toml` and run that
binary instead, with the same test certificate and address. `TIMEOUT_MS=100` selects the
timeout checks in `node work/http2/limits.mjs`. For counts, keep the normal timeout and
run the server under callgrind; `node work/http2/load.mjs h1 200 page` sends the load.
Repeat with 1,200, `h2`, and `events`, then subtract and divide by 1,000. The scripts contain
no certificate or key. The item harness is the ignored `http2_request_cost` test in that
commit; set `REQUESTS=200` and `1200` when running its release test binary under callgrind,
alternating the baseline plus the identical test with the feature-off prototype.
