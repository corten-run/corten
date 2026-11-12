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
million `many`. Only static labels and culture data are shared between requests.
Native currency spacing is made nonbreaking so amounts and symbols stay together.
Razor's normal antiforgery token protects form posts. Marketplace uses normal
full-page navigation while the existing htmx runtime remains loaded.

Labels and CSS are byte-identical copies of `bench/marketplace/labels.json` and
`marketplace.css`. Run focused native checks from this directory:

```sh
dotnet test tests/Marketplace.Tests.csproj -c Release
```
