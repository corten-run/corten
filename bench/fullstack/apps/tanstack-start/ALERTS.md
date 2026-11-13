# Native marketplace alerts

`GET /api/alerts` returns the current session's native JSON array in insertion
order: `[{item_id,email,target_minor}]`. A new cookie jar sees `[]`; repeated reads
do not consume or reset alerts. Readback is independent of the form response.
HEAD uses the native GET handler with no response body. Other methods return
405 JSON with `Allow: GET, HEAD` and do not change the session's alerts.

An accepted marketplace POST appends exactly one row after checking the locale,
item, email and localized target. Invalid fields, missing items and cross-site
requests do not append. The original localized messages remain the form result.
The hydrated form calls a native POST server function. The ordinary POST is handled by the native SSR route.

Targets are ungrouped locale-decimal inputs with at most two fractional digits.
Extra precision is rejected rather than rounded. Parsing constructs the positive
integer minor amount directly from the digits, rejects unsafe integers, and
formats the confirmation from that same exact amount with native Intl.

Each app owns its own in-process store, shared only by that app's native route
bundles. Session tokens contain 256 random bits, are never accepted as
client-chosen new identities, and expire after one hour. Cookies use Path=/,
HttpOnly and SameSite=Lax, with Secure on HTTPS. The synthetic workload is bounded
to 10,000 sessions and 1,000 alerts per session; expired sessions are reclaimed.
This is request-to-request persistence in a single server process, not a
restart-durable database or a multi-instance session service. Ordinary read-only
page and item-JSON requests do not establish an alert session.

## Checks

Build with `npm run build`, then run `node --test alerts.test.mjs` for token
isolation, concurrent appends, insertion order, copies, capacity, expiry and
localized minor units. Existing marketplace and catalog tests still apply.

Against the built native server with synthetic marketplace records, set
`ALERTS_BASE_URL` to its actual browser origin and run these separately:

- `node --test alerts-http.test.mjs`
- `node --test alerts-browser.test.mjs`

The browser test uses the repository's Playwright development dependency and
Chromium. It exercises all three locales with and without JavaScript, requires a
non-document POST in enhanced mode, and reads back through
`context.request.get` using the browser context's own cookie jar. HTTP checks
also cover rejected writes, multiple clients and concurrent accepted requests.
These are functional checks, not throughput measurements.
