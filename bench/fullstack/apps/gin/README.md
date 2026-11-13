# Native record JSON

The catalog and marketplace JSON routes use Gin's native JSON serialization of
their parsed Go records. They accept GET/HEAD and return JSON 404, 405 and 502
errors; unsupported methods include `Allow: GET, HEAD` and do not fetch a record.
Record JSON responses use `Cache-Control: no-store`.

Both record sources use a request-context-aware Go HTTP client with redirects
disabled and a ten-second whole-response timeout, including JSON body decoding.
The same sources serve their existing native templ pages; templates, localization,
forms and legacy item transport are not replaced. Native timeout errors return
504, cancellation errors 408, and other source failures 502. Record-page source
errors use a generic native templ page without exposing upstream details. Caller
disconnects cancel the source request through Go's request context; the same native
client timeout closes an outstanding header or body read. Neither failure can
reach the alert commit point. These semantics also apply without production middleware.

With the pinned Go and templ tools from the Dockerfile installed, generate native
views and run the checks from this directory:

```sh
templ generate
go test ./...
go vet ./...
```

The focused socket tests cover fixture/API reads, JSON methods and errors,
headers/body stalls, caller disconnects, upstream closure and recovery. They are
functional checks, not independent serialization-audit receipts or a load baseline.

## Session alerts

Accepted marketplace form POSTs append one native Go record after localized
validation. `GET /api/alerts` independently serializes the caller's records as an
array of `{item_id,email,target_minor}` in insertion order. It never reads the
marketplace source, issues a session, clears alerts, or echoes a submitted form.
Invalid forms, unsupported locales, missing items and cross-site writes do not
append. Only the URL-encoded POST body supplies alert fields, not the query.

The first accepted write issues `marketplace_session`: 32 cryptographically random
bytes, hex encoded, host-only, `Path=/`, `HttpOnly`, `SameSite=Lax`, with no browser
expiry. `Secure` is set for native TLS, or when trusted deployment configuration
`MARKETPLACE_PUBLIC_ORIGIN` starts with `https://`; forwarding headers never choose
it. The existing origin guard still compares to the native connection's origin.
Sessions and their ordered lists live in this process, expire one hour after
creation (reads do not refresh them), and disappear on restart. Unknown cookies
are not adopted: a write mints a new credential. Limits are 4,096 live sessions and
1,024 alerts per session; exhausted storage returns a generic 503 without evicting
a live list. Readbacks use `Cache-Control: no-store`. These are synthetic-data
benchmark sessions, not durable storage or a multi-process session service.

The native-image HTTP/browser driver is also usable for the other three compiled
adapters. From a checkout with the root Playwright dependencies installed:

```sh
node bench/fullstack/apps/gin/check-alerts.mjs gin IMAGE
node bench/fullstack/apps/gin/check-alerts.mjs drogon IMAGE
node bench/fullstack/apps/gin/check-alerts.mjs topcoat IMAGE
node bench/fullstack/apps/gin/check-alerts.mjs leptos IMAGE
node bench/fullstack/apps/gin/check-alerts.mjs gin IMAGE matched
```

It starts and removes its own resource-limited containers and synthetic fixture/API
source. JS and no-JS contexts use their own browser cookie jars for real readback,
including locale validation, isolation, cross-site rejection and concurrent writes.
This driver is test code only; no adapter imports it or uses a common alert store.

Alert POSTs require one complete upstream JSON document and the requested record
identity. The native templ response is fully rendered into a buffer before a write;
a render error cannot commit a session. The commit is not tied to client receipt:
a later socket/write failure does not roll back an already committed alert. No new
upstream cancellation or disconnect guarantee is claimed. Read-only handlers are
unchanged. Minor-unit tests cover exact integers above 2^53, signed-64-bit maximum,
and rejection beyond that bound.

For API-sourced alert writes, required/non-nullable fields are checked recursively
against the existing native Go record declarations, including nested rows, before
native decoding. Optional pointer fields retain their native null/missing behavior.
No separate schema or record types, dependencies, or GET-path rules are introduced.

## Native production profile

`PROFILE=matched` keeps the same Gin router, native templ views, forms and JSON
serializer. Gin middleware adds a self-only CSP (no inline scripts or eval),
nosniff, strict-origin-when-cross-origin referrer policy, frame denial, same-origin
opener policy, disabled camera/microphone/geolocation permissions, private
`no-store` responses and negotiated Go gzip for text/JSON/JavaScript. HEAD,
already encoded responses, ranges, upgrades and native event streams are not
compressed. Representations are not rewritten.

`HOSTS` is a comma-separated native Host allowlist, defaulting to
`localhost,127.0.0.1,[::1]`. A host without a port permits that host's ports; an
explicit port must match. Unknown authorities receive 421. Forwarded headers are
not trusted. Invalid configuration fails startup. `/health/live` is a real
upstream-independent liveness endpoint; missing health paths remain 404.

The native Go `http.Server` uses 30-second header/read/write/idle deadlines and a
16 KiB maximum header budget. A native `MaxBytesReader` bounds bodies at 2 MiB;
known oversized bodies receive 413 before handlers, and chunked bodies fail native
binding when the limit is reached. The body is not pre-read ahead of the native
cross-site guard. `MAX_CONNECTIONS` (default 1000) configures the native
`netutil.LimitListener`; this uses the already pinned `golang.org/x/net` module,
not a new dependency. Native SSE refreshes its write deadline before each batch
and removes its subscriber on disconnect. Other profiles retain `gin.Default()`
and `r.Run` without this production configuration.

The app-local functional driver runs the existing, unchanged marketplace production
qualification against a real image, with separate fixture/API source receipts:

```sh
node bench/fullstack/apps/gin/check-production.mjs IMAGE OUTPUT_DIRECTORY
```

It retains raw probes, image identity and source revision, and checks actual API
disconnect/deadline cleanup and alert readback. Its synthetic upstream runs in a
separate worker so synchronous socket probes cannot stall it. Containers have
the same one-CPU/512-MiB bound as the alert checker and are removed afterwards.
These direct HTTP checks do not qualify a TLS deployment, the complete hardening
matrix, or comparative throughput. Run the alert browser checker for both profiles
as well; eligibility is an observed result, never inferred from this configuration.
