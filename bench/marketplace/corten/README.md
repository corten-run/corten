# Native alert persistence

The existing native `POST /marketplace/{locale}/{id}` now appends one accepted
alert to an in-memory, process-local store. This is enabled in both default and
matched profiles, with either record source; no parity flag is required. Locale
parsing and localized validation still use Corten's native form and money APIs.

`GET /api/alerts` independently reads that store as an insertion-ordered JSON array:
`[{"item_id":"item_1","email":"buyer@example.test","target_minor":1250}]`.
It returns `Cache-Control: no-store`. No cookie, an unknown cookie, or a fresh
browser context reads `[]`; reads never create, clear or reset state. Invalid
forms, missing records, unsupported locales and cross-site rejections never append.
Each accepted POST appends once, including a repeated accepted form. There is no
retry deduplication key or reset/debug endpoint.

The first accepted POST issues `marketplace-alerts`, a host-only, HttpOnly,
SameSite=Lax session cookie. Its server-generated random token alone binds later
POSTs and independent GETs to the same store; caller-chosen unknown tokens are
replaced, never registered. Preserve the response cookie before sending more
writes, including concurrent writes. Two first POSTs sent without a cookie are
separate sessions. Page and record-JSON GETs do not initialize alert sessions.

Corten's cookie helper defaults to Secure. An accepted form with a same-origin
`http://` Origin uses its explicit local-HTTP option so all benchmark browsers,
including WebKit, retain the cookie. An HTTP client with a cookie jar should send
the matching Origin too; without one the cookie keeps Secure. HTTPS forms keep Secure. Use HTTPS for real
user data; these benchmarks use synthetic data. Sessions and rows live until the
process exits; this is not durable storage or a multi-instance session service.
Appends and read snapshots are atomic under a mutex, never held across an await.
No framework dependency or shared framework change is needed.

Focused checks from the repository root:

```sh
cargo test --manifest-path bench/marketplace/corten/Cargo.toml
```

## Request lifetime

In both profiles, the API source's existing ten-second whole-read timeout now
answers 504, through Corten's native HTML or JSON error response. It covers both
waiting for upstream headers and consuming the body. Other upstream/parse errors
retain their previous error contract. Fixture reads have no upstream timer.
Client disconnect still drops the handler's awaited reqwest future; no spawned
fetch, retry, shared renderer or framework change is involved. The app's existing
request deadline and matched connection limit remain unchanged.

`tests/lifetime.mjs` exercises real native production images for Corten, ASP.NET
and Express. Build each app with its existing Dockerfile, then run from the root:

```sh
node bench/marketplace/corten/tests/build-lifetime.mjs corten <corten-image>
node bench/marketplace/corten/tests/build-lifetime.mjs aspnet <aspnet-image>
node bench/marketplace/corten/tests/build-lifetime.mjs express <express-image>
node bench/marketplace/corten/tests/lifetime.mjs corten <corten-image>
node bench/marketplace/corten/tests/lifetime.mjs aspnet <aspnet-image>
node bench/marketplace/corten/tests/lifetime.mjs express <express-image>
```

It runs default and matched processes with one CPU/1 GiB each, all three page
locales, neutral JSON and actual native form POSTs (including Razor antiforgery).
The source holds headers or the body for 40 seconds; an un-aborted client must
receive native 408/503/504 within the driver's twelve-second observation bound.
Cancellation waits for one observed upstream request, then waits 50 ms before
destroying the real client socket. Within 500 ms the source must report exactly
one request, zero completions, one cancellation and zero pending work. Slow
successful reads and POST non-mutation/recovery are also checked. The driver
never credits its forced cleanup as cancellation and removes its own containers.
Image identity and per-operation status, source counters and measured clocks
remain under ignored `tests/results/`. A third positional argument labels the
artifact directory; a fourth `baseline` limits diagnostics to one locale and
header holds. These are correctness/latency diagnostics, not load qualification
or comparative throughput evidence.
The fourth argument `posts` runs only the native form lifetime checks. Those
first establish a real accepted session, then check that cancelled/deadline POSTs
leave its independently read store unchanged and a recovered POST appends once.
`deadlines` checks header-hold deadlines and slow-read recovery for all locales
and JSON in both profiles. Deadline evidence also requires a contract content
type, not just a status on an empty untyped response.

API deadline checks require application/json with a nonempty error message or
application/problem+json with a matching status and nonempty title. Empty,
invalid JSON and HTML/plain-text API errors fail. The small negative-contract
suite runs with `node --test bench/marketplace/corten/tests/deadline-contract.test.mjs`.

`uploads` checks genuine native forms unfinished at 1000 bytes/s, in all locales
and both profiles; `upload-baseline` limits that diagnostic to en-US. The driver
captures native ASP.NET antiforgery fields and cookies and first establishes a
real alert session. It verifies deadline response before finishing the body,
socket closure, no source work, independent unchanged alert state and successful
recovery. On failure only, it finishes the body after the observation bound to
record a late response, never crediting that response as timely. Corten retains
its native 30-second body deadline (408); ASP.NET/Express retain ten seconds.
The full mode includes these checks as well as source header/body holds.

The build helper uses the existing production Dockerfiles and labels images with
the source commit and a digest of scoped source input hashes. Results record the
image ID/labels, complete input manifest, fixture and driver hashes. Labelled
input digests must match the current inputs before execution. Images built
without the helper are explicitly recorded as sourceInputsVerified=false; the
host driver's HEAD is never presented as proof of an image's build source.

## Marketplace trace context

Native marketplace page GET, record-JSON GET and form POST source reads accept an
optional request-scoped W3C `traceparent`. Its immutable value is passed to the
existing source read, never stored on the shared source/client or in a process
"current operation". Version 00 is forwarded unchanged; supported known fields
of future versions are down-versioned to 00. Invalid, duplicate and zero-ID
contexts are not propagated by the app. No exporter, new fetch, parser, fixture
behavior, deadline or runtime configuration is introduced.

The scoped `tests/traceparent.mjs` driver checks actual native production images
for all three apps, both profiles and all locales. Build with the existing
`tests/build-lifetime.mjs`, then run `node bench/marketplace/corten/tests/traceparent.mjs
<corten|aspnet|express> <image> <artifact-label>` from the root. It binds the image
ID to scoped source hashes and records per-operation upstream headers/counters.
Discovery, primary POST and readback have distinct immutable identities. It also
holds source headers/bodies while another context completes, delays a native
form body before its source starts, and follows invalid/missing contexts with
untraced reads. ASP.NET may create a fresh native Activity for an untraced request;
the negative check rejects reuse of any issued incoming trace ID, not fresh native
tracing. Direct source tests also start a captured call after another completes.
These scoped diagnostics are not the independent clean-source audit or complete
mixed measurement admission. The unresolved cancellation evidence in
`tests/LIFETIME-HANDOFF.md` remains unchanged.
