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
7. **Good defaults:** requiring a second server and nine proxy-specific concerns is a real cost.
   The deployment table has twelve rows, but 5 is conditional on caching, and 9 and 12
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

[limits.mjs](limits.mjs) is the **isolated acceptance client**. It prints each case and its timing,
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
Before shipping, also run the full three-engine TLS runtime smoke,
reset flood and resource checks, shutdown with open streams, decoded-head bounds and explicit
h2 Upgrade refusal/HTTP/1 WebSocket fallback. Shipping Corten is unchanged.

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

For overhead, use a fresh process for each 200 and 1,200 count, `TIMEOUT_MS=30000`,
and the same Callgrind procedure as [Transport Counts](#transport-counts), below. Run
`node bench/http2/load.mjs h2 <count> page` for `off` versus `service-idle` and
`h2-off` versus `h2-idle`; use `events` for `off`, `body` and `buffer`. Each
comparison is within one transport, not against shipping HTTP/1.1. The hyper `off`
mode still uses the same body and buffer wrapper types but records no progress or timestamps.

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

The idle and send candidates passed in separate transport modes. No single opt-in path
has demonstrated both bounds with the socket watch or the production qualification
listed above.

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
