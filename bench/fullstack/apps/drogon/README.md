# Native record JSON

Catalog records use the native C++ model. Marketplace records use complete-schema
validation of JsonCpp values and native reserialization, not upstream response-byte
forwarding. Required fields, numeric bounds, IDs and fixture references are checked;
fixtures are parsed at startup and API records are fetched and parsed per request.
Native templates, ICU localization and legacy item routes remain separate.

Record JSON GET/HEAD responses include native JSON errors for missing records,
unsupported methods and failed upstream reads. Unsupported methods return 405 with
`Allow: GET, HEAD`. Errors are generic and record responses are not output-cached.
The record HTTP client refuses redirects, bounds complete responses to ten seconds,
and observes caller disconnects. An in-flight read owns its upstream connection;
the per-thread idle-client pool is bounded. Aggregate concurrency/body limits and
DNS/TLS-stage cancellation are not qualified by this work.

With the native dependencies from the Dockerfile installed, run from this directory:

```sh
cmake -S . -B build -DBUILD_TESTING=ON
cmake --build build
ctest --test-dir build --output-on-failure
```

From the repository root, build the normal image and run the native HTTP and bad
fixture startup checks:

```sh
docker build -t record-drogon bench/fullstack/apps/drogon
node bench/fullstack/apps/drogon/tests/json-http.mjs record-drogon
node bench/fullstack/apps/drogon/tests/fixture-startup.mjs record-drogon
```

The HTTP driver checks both payloads and sources, complete-record correctness,
malformed responses, redirects, deadlines, disconnect cleanup and recovery. Raw
observations stay under ignored `tests/results/`. These are correctness checks,
not production qualification, native audit receipts or benchmark throughput.

## Session alerts

Marketplace POSTs append exactly one JsonCpp record after the existing ICU/email
validation; invalid input, missing items/locales and cross-site writes append
nothing. The native URL-encoded body parser, not query fields, supplies alert
input. The original CSP templates and scripts are retained. `GET /api/alerts`
independently serializes the session's ordered array of
`{item_id,email,target_minor}` through Drogon's JSON response API. It neither
fetches an item nor creates, clears or refreshes a session, and sends `no-store`.

The first accepted POST sets host-only `marketplace_session`, with `Path=/`,
`HttpOnly`, `SameSite=Lax` and no browser expiry. The credential is 32 bytes from
OpenSSL's cryptographic random source, hex encoded; the existing Drogon dependency
already links OpenSSL. `Secure` follows the native connection's TLS state, never
forwarding headers. The existing connection-origin guard is unchanged apart from
rejecting non-same-origin Fetch Metadata. TLS termination in a proxy is not inferred.
An unknown cookie is never adopted as a new session's credential.

The mutex-protected process-local store expires sessions one hour after creation,
not after reads. Restart loses the synthetic data. At 4,096 live sessions or 1,024
alerts per session, writes fail with 503 rather than evicting live rows. This is
not durable or distributed storage. CTest includes concurrent store/cookie/capacity
checks. For fixture/API HTTP, real browser forms in JS/no-JS contexts, cookie-jar
readback and isolation, run the compiled-native driver documented in
`../gin/README.md` with `drogon` and the image under test.

POST source parsing requires one complete JSON document and the requested record
identity. A successful native CSP response must be prepared before appending.
This is not a transaction tied to client receipt: later delivery failure does not
roll back committed work, and the page source's existing native abort semantics
are not expanded. Read-only paths remain unchanged. Tests cover exact minor units
above 2^53 and the signed-64-bit acceptance boundary.

## Request-local trace context

Marketplace page GETs, JSON GET/HEADs and alert POST source reads capture an
immutable context from their own incoming request. Validation sees Drogon's parsed
header values, subject to the native-parser limits below. Only a valid W3C traceparent's
known fields are forwarded (lowercase hex, nonzero trace/span IDs, no reserved
`ff` version or comma-joined parents). Future versions are down-versioned to `00`
with only the sampled bit, per
[W3C Trace Context 3.2.4](https://www.w3.org/TR/2021/REC-trace-context-1-20211123/#versioning-of-traceparent).
Existing version-00 flag transport is unchanged. Missing/invalid parsed parents forward neither
header. With a valid parent, tracestate is copied as HTTP field bytes, including
8-bit obs-text, but never CR/LF, NUL, DEL or other controls apart from HTAB.
This is transparent tracestate transport, not validation of its vendor grammar.
Drogon's pinned v1.9.14
[native input parser](https://github.com/drogonframework/drogon/blob/3aae769cc405cf5abb9d477675c6430924f02c7c/lib/src/HttpRequestImpl.cc)
stores fields with `headers_.emplace`; its public `getHeader` and `headers()` APIs
cannot recover discarded repetitions. This is a known W3C repeated-tracestate
compliance blocker, not parity: `first=one` followed by `second=two` must become
`first=one,second=two`, but only the first survives. The context validator also
cannot detect duplicate parents discarded by that parser. No replacement parser,
proxy shim or dependency fork is introduced here. Native ordered combination and
validation bounds require a native parser/API change before this blocker clears.

The same pinned parser trims leading/trailing C `isspace` bytes before capture,
including vertical tab and form feed. A valid parent followed by raw `0x0b` or
`0x0c` therefore reaches the handler as a valid parent and forwards both trace
headers. The context validator rejects those controls when present in its input,
but cannot recover bytes the parser discarded. This is another native-parser
blocker, not safe invalid-wire-parent handling. The strict `parser-controls`
suite in `check-trace-flags.mjs` expects native rejection or no forwarded context;
it fails four of eight probes on the normal release image (both bytes in both
API profiles), while fixture probes make no source calls. No workaround is used.
Both parser blockers remain covered by
[#1300 Benchmark parity: Drogon in approved workload groups](https://github.com/corten-run/corten/issues/1300).

Context is a value passed to the native source read and applied to a new outbound
request, not stored on either native client pool, a thread or a global current
operation. Delayed callbacks may retain that value without borrowing the caller's
header storage. Fixture reads still make no HTTP request; `/api/alerts` readback
still makes no source read. Catalog, legacy routes, parsers, rendering, profiles
and existing source deadlines are unchanged. Both `defaults` and `matched` are
tested; Drogon currently has no profile-specific application middleware.

CTest includes parent validation, all 256 possible tracestate bytes and delayed
immutable capture after caller mutation/destruction. The actual HTTP driver runs
both profiles and both sources, all three page/form locales, exact JSON and alert
readback, overlapping same-record traced/untraced reads with delayed headers and
bodies, delayed POST bodies, invalid parents and 8-bit tracestate transport:

```sh
node bench/fullstack/apps/drogon/tests/trace-http.mjs record-drogon
```

Run the same driver with `IMAGE before` against an unchanged image to reproduce
missing headers. Raw request, source and response observations (including image
ID) remain in ignored `tests/results/trace-*.ndjson`. These focused regressions
are not qualification results, independent source-audit receipts or performance
measurements. The changed native build inputs need a new independent audit before
mixed-production admission.

`node bench/fullstack/apps/drogon/check-trace-flags.mjs IMAGE` runs focused
regressions against the normal Release image in both profiles and both sources:
JSON GET/HEAD, pages and native POSTs in three locales, exact traced/untraced body
bytes, future flags `80/81/fe/ff`, unchanged v00 flags, malformed parents, obs-text
state and raw NUL/control/DEL headers. Source observations, body lengths/hashes
and image identity remain in `tests/results/row7-*.ndjson`.

Append `repeated-state` to run the strict, currently failing W3C regression for
separate state fields, reversed wire order and three fields. It intentionally
expects the standard combined value, not the parser's first-field-only output.
It must not be reported as passing parity. Both drivers remove their own
containers and temporary fixtures. These checks are not a native audit,
qualification, performance measurement or an inferred explanation from tests.

Historical source-lane Row7 evidence (2026-11-13, not release-head verification):
the author fetched upstream `8b02835d6987150ce8bc3d6a48c9e700fa81c27a`
without merging it into the local source lane. The new trace CTest failed before
the runtime fix. A preliminary direct-link attempt lacked Drogon's transitive
libraries; the actual regression and final suite used the native CMake targets.
After the fix, all four Release CTest targets pass with assertions enabled.

The normal Release image's flag/header checks failed 64 cases before
(`row7-flags-1794549171096.ndjson`) and pass all 524 checks after
(`row7-flags-1794549674407.ndjson`): 512 route/header cases plus 12 hostile-control
probes. The existing `tests/trace-http.mjs` also passes both profiles and sources,
including delayed/concurrent reads and native alert readback. Strict repeated
state combination fails 48 API cases both before
(`row7-repeated-state-1794549179943.ndjson`) and after
(`row7-repeated-state-1794549674516.ndjson`), across all eight routes in both
profiles; fixture cases make no HTTP calls. Body comparisons in both strict
suites are byte-equal even where the source-header assertion fails. This is an
observed failure, not accepted first-field-only parity. The parser/API limitation
above is from reading the pinned native source, not a cause inferred from tests.

Raw observations retain image identity; images were built from local working
contexts, not clean retained archives. Older evidence is untouched. No
instruction/timing comparison, browser matrix, full Corten framework checks or
independent review was run for this repair. Shared guide/changelog edits and
another agent are outside the authorized scope. The native repeated-state
blocker remains open; no native audit or mixed-production admission is claimed.

### Row7 implementation follow-up (2026-11-13)

This author follow-up fetched `origin/main` without merging unrelated history;
it does not itself constitute independent review.
The shared native cost-driver cleanup repair's permanent two-container negative
regression failed before repair because the second removal was never attempted.
Cleanup now attempts every removal and local resource close, retaining the
original operation error and every cleanup error in an `AggregateError` when
cleanup fails. The ordinary Node suite passes seven tests, with the native
control skipped unless explicitly enabled:

```sh
NATIVE_TRACE_COST_CLEANUP=1 node --test bench/fullstack/native-trace-cost.test.mjs
```

All eight tests pass with that control enabled and a local `alpine:3` image. The
control exercises successful cleanup and injected first-removal failure with two
real containers, a live keep-alive socket and an HTTP server. Its independent
teardown removes the deliberately retained container. An initial native-control
assertion incorrectly expected synchronous socket-map removal; the test now
awaits actual socket closure before checking the map.

A fresh normal Release image reproduced both strict native failures without
changing the probes: four of eight `parser-controls` cases and 48 of 96
`repeated-state` cases fail. New ignored receipts are
`tests/results/row7-parser-controls-1794585389485.ndjson` and
`tests/results/row7-repeated-state-1794585387026.ndjson`, both identifying image
`sha256:db59460ea2a754309f20f1b98cd9d1565a277845580f552dc97c296e76f8cdee`.
Original receipts are untouched. The pinned native source confirms that
`HttpRequestImpl::addHeader` trims with `isspace` and inserts with
`headers_.emplace`. The pinned
[`HttpRequestParser`](https://github.com/drogonframework/drogon/blob/3aae769cc405cf5abb9d477675c6430924f02c7c/lib/src/HttpRequestParser.cc)
does this before
[`HttpServer`](https://github.com/drogonframework/drogon/blob/3aae769cc405cf5abb9d477675c6430924f02c7c/lib/src/HttpServer.cc)'s
earliest request advice; public request accessors expose only the resulting map,
not raw or repeated fields. No recoverable adapter defect was established, so no runtime
workaround, dependency fork or reclassification of failed results is made.

The focused context test additionally supplies unsafe parent controls directly
through the public request setter and requires capture to reject both headers.
This verifies adapter rejection when the bytes survive, not wire-parser safety.
The native production target builds, and all four Release CTest targets pass
with assertions enabled: `trace_context`, `alerts`, `marketplace`, `record_json`.
Both native parser blockers remain open. This follow-up is authored work needing
fresh non-author review, not qualification, a performance measurement, a native
audit or mixed-production admission. Shared citation-ancestry repairs remain
parent integration work.
