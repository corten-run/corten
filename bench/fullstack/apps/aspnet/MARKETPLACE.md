# Marketplace v2

`GET` and form `POST /marketplace/{locale}/{id}` use Razor Pages. The separate
`GET` and `HEAD /api/marketplace/{id}` serialize the complete numeric record with System.Text.Json.
Locales are `en-US`, `fr-FR`, and `de-DE`; legacy routes are unchanged.

For JSON-compatible `Accept` headers, the catalog and marketplace JSON endpoints use native
Problem Details for missing records, unsupported methods and upstream failures, including in
the default profile. Native content negotiation can return a non-JSON error for a client
that requests only HTML. Page/form error
handling and the matched profile's additional production middleware remain separate. These
functional checks do not qualify a production workload or establish load performance.

`MARKETPLACE_SOURCE=fixture` loads `MARKETPLACE_FIXTURE_PATH` once at startup
(default `/fixtures/marketplace.json`). Otherwise each request reads one record
from `${API_BASE}/marketplace/records/{id}`, with redirects disabled and no cache.

Native ICU-backed `CultureInfo` formats numbers and USD using the Unicode `cu`
currency extension. MessageFormat 8 supplies CLDR plural selection, including French
million `many`. Formatting shares only static labels and culture data between requests.
Native currency spacing is made nonbreaking so amounts and symbols stay together.
Razor's normal antiforgery token protects form posts. Marketplace uses normal
full-page navigation while the existing htmx runtime remains loaded.

Labels and CSS are byte-identical copies of `bench/marketplace/labels.json` and
`marketplace.css`. Run focused native checks from this directory:

```sh
dotnet test tests/Marketplace.Tests.csproj -c Release
```

## Native alert persistence

In both profiles and with either record source, an accepted Razor form
`POST /marketplace/{locale}/{id}` appends exactly one row. `GET /api/alerts`
independently reads the process-local store as an insertion-ordered JSON array
`[{"item_id":"item_1","email":"buyer@example.test","target_minor":1250}]`, with
`Cache-Control: no-store`. No/unknown cookie and fresh browser contexts read `[]`.
GET never creates, resets or clears a store. Validation, missing records,
unsupported locales, antiforgery rejection and cross-site rejection do not append.
The Razor antiforgery token remains required even for direct HTTP test clients.
CultureInfo still parses the price and supplies localized validation. Stored minor
units use the displayed currency's half-away-from-zero rounding and native `Int128`
so even `decimal.MaxValue` remains accepted without overflowing during conversion.
System.Text.Json writes these as JSON integer numbers. Legacy item forms are outside this store.

The first accepted POST issues `marketplace-alerts` through ASP.NET's native
cookie API: a server-generated 256-bit random token, host-only, HttpOnly,
SameSite=Lax, Secure on HTTPS, and a browser-session lifetime. Plain HTTP supports
the local synthetic benchmark. Unknown caller-selected tokens are replaced, never
registered. Preserve the cookie for later POSTs and independent GETs, and establish
it before concurrent writes; two first cookie-less POSTs create separate sessions.
Page/record-JSON GETs do not initialize alert sessions. A singleton concurrent map
and per-session locks make appends and read snapshots atomic, without session
middleware on hot reads or a new dependency. Repeated accepted POSTs append separate
rows; there is no retry deduplication or reset/debug endpoint. Rows and sessions are
retained until process exit, not durable or shared between instances. No parity
flag is required. The native test suite covers POST/readback, all locales,
rejections, multiple clients and concurrent operations.
