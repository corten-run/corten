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
