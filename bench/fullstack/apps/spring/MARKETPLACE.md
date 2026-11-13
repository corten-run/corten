# Marketplace v2

`GET` and form `POST /marketplace/{locale}/{id}` render a native Thymeleaf page.
`GET /api/marketplace/{id}` uses Spring/Jackson to serialize the numeric record.
Locales are `en-US`, `fr-FR`, and `de-DE`; legacy routes are unchanged.

The catalog and marketplace JSON endpoints use Spring `ProblemDetail` and Jackson
for missing records (404), method errors (405, retaining `Allow`) and upstream
HTTP/parse failures (500 without exception details). Native `HEAD` suppresses the
body for both success and failure. This handling is limited to `/api/catalog/`
and `/api/marketplace/`; page/form error handling and profiles are unchanged.
Error classification uses Spring's parsed request path and native path patterns,
so percent-encoded and matrix-parameter aliases retain the same JSON behavior as
the canonical routes. The aliases remain enabled; non-JSON routes stay native.
Neither source configures an explicit request/read deadline. This change does not
add one or claim upstream cancellation or bounded completion for a stalled read.

`MARKETPLACE_SOURCE=fixture` loads `MARKETPLACE_FIXTURE_PATH` once at startup
(default `/fixtures/marketplace.json`). Otherwise each request reads one record
from `${API_BASE}/marketplace/records/{id}`, with redirects disabled and no cache.

ICU4J supplies currency/number formatting, locale-aware target-price parsing, and
CLDR plural selection, including French million `many`. Mutable formatters belong
to the current request. Marketplace uses normal full-page form/link navigation;
the existing htmx runtime is still loaded.

Labels and CSS are byte-identical copies of `bench/marketplace/labels.json` and
`marketplace.css`. Run focused native checks from this directory:

```sh
mvn -B test
```

After `mvn -B package`, run `node --test json-http.test.mjs` for the shared JSON
HTTP gate: both 500-record payloads, fixture/API sources, missing records, uncached
upstream changes and upstream errors. It starts throwaway local Docker JVMs with
no profile overrides and removes them and its temporary fixtures afterwards.
On native Linux it adds Docker's `host-gateway` mapping for the host upstream;
Windows and macOS retain Docker Desktop's built-in host resolution.
The native Java tests separately cover `GET`, `HEAD`, methods and malformed JSON.
These checks establish functional JSON behavior, not load or production readiness.

## Native alert sessions

Accepted marketplace POSTs append one alert to the native servlet session. Spring
MVC/Jackson serves `GET /api/alerts` as `[{item_id,email,target_minor}]` in insertion
order, without creating a session for a new reader. Servlet session IDs are not
adopted from unknown caller cookies. Cookies are HttpOnly, SameSite=Lax, cookie-only
(no URL session IDs), and Secure on HTTPS under the servlet container's defaults.
Servlet session expiry applies; restarts lose these synthetic in-memory alerts.

The session mutex protects appends and snapshot reads, including concurrent requests
that add the first alert to an existing session. ICU validation returns both its
localized message and half-up rounded minor units from one parse. Targets beyond
signed 64-bit minor units are rejected. Missing/invalid inputs and missing records
do not append. Marketplace POST rejects cross-site Fetch Metadata or a different
Origin using the servlet request's scheme and Host. This app has no Spring Security
dependency; none is added or disabled. POST responses and readbacks are no-store.
The existing read-only pages, record JSON, full-page marketplace forms and legacy
htmx enhancement remain unchanged.

For an accepted POST only, the controller resolves the normal Thymeleaf view and
renders it once into Spring's `ContentCachingResponseWrapper`. Only a complete,
successful render appends the alert; the buffered bytes are then copied to the
response. A render exception or error status cannot append or expose partial HTML.
GET and rejected form rendering retain the ordinary MVC lifecycle. This does not
promise rollback when a client disconnects after an alert has committed.

POST source reads use a native Jackson `ObjectReader` that rejects missing creator
properties (including nullable ones), unknown keys, null primitive numbers and
scalar coercions. The fetched record is parsed once, then checked before rendering:
required strings/lists/row members, requested ID, per-list unique row IDs and the
numeric bounds in `bench/marketplace/records.mjs` (counts 0..1e9, signed minor units
-1e9..1e9, ratings 0..500). No extra HTTP read or source pass is added. API-backed
GET pages and JSON retain their existing mapper and serialization.

The fixture map remains parsed once at startup and reused by reads. Its parser now
uses the same strict Jackson settings: missing properties, unknown keys and scalar
coercions fail startup rather than being silently normalized. This is necessary
because missing nullable properties and coerced primitive types cannot be recovered
from the resulting typed record. Fixture POSTs still check the record's required
non-null members, ID, uniqueness and numeric invariants before rendering; healthy
fixture GET behavior is unchanged.

`mvn -B test` includes native validation/concurrent-session tests. Real HTTP,
isolation, concurrent writes, and JS/no-JS browser checks for the built image are
documented in `../fastapi/README.md`. They retain the same browser/request cookie
jar between each POST and its separate readback, with no reset/oracle endpoint.
`AlertsHttpTest` runs a real upstream and embedded Tomcat HTTP server: a malformed
`fields: [null]` record with a large title that previously failed inside Thymeleaf
must return 500 with unchanged readback for existing and fresh cookie jars. A valid
subsequent write must still append exactly once.
`../fastapi/alert-contract.test.mjs` additionally exercises the full malformed-record
matrix over real HTTP in both profile environments; setup is in that app's README.

## Unreleased

- Validate complete marketplace POST source records with strict native Jackson
  parsing, requested-ID/unique-row checks and existing numeric contract bounds.
  Reject structurally unparseable fixtures at startup rather than losing evidence
  needed to validate later writes.

- Persist native servlet-session marketplace alerts with independent JSON readback,
  atomic appends and cross-site write rejection.
- Complete native template rendering before committing an accepted alert so a
  failed render cannot mutate the session store.
