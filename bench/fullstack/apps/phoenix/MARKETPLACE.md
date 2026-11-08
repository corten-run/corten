# Marketplace v2

`GET` and form `POST /marketplace/{locale}/{id}` render a native controller/HEEx
page. `GET /api/marketplace/{id}` uses Phoenix/Jason to serialize the numeric record.
This API also accepts HTML clients, returning JSON or 404 without content negotiation errors.
Locales are `en-US`, `fr-FR`, and `de-DE`; legacy LiveViews and channels are unchanged.

`MARKETPLACE_SOURCE=fixture` loads `MARKETPLACE_FIXTURE_PATH` once at startup
(default `/fixtures/marketplace.json`). Otherwise each request reads one record
from `${API_BASE}/marketplace/records/{id}`, with redirects/retries disabled and no cache.

ex_cldr_numbers supplies currency/number formatting, target-price parsing, and
CLDR plural selection, including French million `many`. Formatting is per request;
only numeric fixture records and static labels are retained. The browser pipeline
and form retain Phoenix's normal CSRF protection, and the normal LiveView runtime
remains loaded alongside plain HTML GET/POST controls.

ex_cldr_numbers 2.38.3's implicit negative pattern puts the minus after an English
currency prefix. The adapter derives explicit standard negative subpatterns from
the library's CLDR patterns and precompiles them, retaining native symbol,
separator, grouping, and sign formatting. The signed-currency test covers this.

Labels and CSS are byte-identical copies of `bench/marketplace/labels.json` and
`marketplace.css`. Run focused native checks from this directory:

```sh
mix deps.get
mix test test/marketplace_test.exs
```
