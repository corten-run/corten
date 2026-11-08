# Marketplace v2

`GET` and form `POST /marketplace/{locale}/{id}` render a native Thymeleaf page.
`GET /api/marketplace/{id}` uses Spring/Jackson to serialize the numeric record.
Locales are `en-US`, `fr-FR`, and `de-DE`; legacy routes are unchanged.

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
