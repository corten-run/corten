# Native record JSON

The catalog and marketplace JSON routes use Gin's native JSON serialization of
their parsed Go records. They accept GET/HEAD and return JSON 404, 405 and 502
errors; unsupported methods include `Allow: GET, HEAD` and do not fetch a record.
Record JSON responses use `Cache-Control: no-store`.

Both record sources use a request-context-aware Go HTTP client with redirects
disabled and a ten-second whole-response timeout, including JSON body decoding.
The same sources serve their existing native templ pages; templates, localization,
forms and legacy item transport are not replaced. This does not add the production
middleware required by the localized-marketplace or hardening groups.

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
```

It starts and removes its own resource-limited containers and synthetic fixture/API
source. JS and no-JS contexts use their own browser cookie jars for real readback,
including locale validation, isolation, cross-site rejection and concurrent writes.
This driver is test code only; no adapter imports it or uses a common alert store.
