# Marketplace v2

`GET` and form `POST /marketplace/{locale}/{id}` render a native controller/HEEx
page. `GET /api/marketplace/{id}` uses Phoenix/Jason to serialize the numeric record.
This API also accepts HTML clients, returning JSON or 404 without content negotiation errors.
Locales are `en-US`, `fr-FR`, and `de-DE`; legacy LiveViews and channels are unchanged.
The marketplace alert is an embedded native LiveView with a real `save` event;
the same form's action and CSRF token keep ordinary no-JS POSTs working. The rest
of the read-only controller/HEEx page and numeric JSON route remain unchanged.

`MARKETPLACE_SOURCE=fixture` loads `MARKETPLACE_FIXTURE_PATH` once at startup
(default `/fixtures/marketplace.json`). Otherwise each request reads one record
from `${API_BASE}/marketplace/records/{id}`, with redirects/retries disabled and no cache.

ex_cldr_numbers supplies currency/number formatting, target-price parsing, and
CLDR plural selection, including French million `many`. Formatting is per request;
only numeric fixture records and static labels are retained. The browser pipeline
and form retain Phoenix's normal CSRF protection. Origin and Fetch Metadata
checks reject cross-site POSTs, including ones carrying valid CSRF tokens.

An accepted submission appends exactly one `{item_id,email,target_minor}` record,
using the same parsed decimal for validation, confirmation and half-up minor-unit
conversion. `GET /api/alerts` uses Phoenix/Jason to return the current session's
records in insertion order with `private, no-store`. It never clears or fabricates
records. Rejected inputs and missing items do not append. Keep the native cookie
jar for form submission and readback. A cryptographically random session identifier
is authenticated in Plug's native HttpOnly, SameSite=Lax cookie. A supervised Agent
serializes concurrent appends; this synthetic store lasts for the server process,
not a durable production database or a cluster. Deployments provide a private,
stable `SECRET_KEY_BASE` and normal HTTPS/secure-cookie configuration; standalone
runs generate a fresh signing key at startup.

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

From the repository root, with Playwright installed and the native image running:

```sh
node bench/fullstack/apps/rails/test/native-alerts.mjs phoenix http://localhost:8080
```

This checks actual native LiveView events, independent HTTP readbacks with the
browser's cookie jar, JS/no-JS, all locales, rejection, order, concurrent POSTs and
two-client isolation. It is not a comparative throughput benchmark.
