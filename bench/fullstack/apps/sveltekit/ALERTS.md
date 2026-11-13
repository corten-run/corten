# Native marketplace alerts

`GET /api/alerts` returns the current session's native JSON array in insertion
order: `[{item_id,email,target_minor}]`. A new cookie jar sees `[]`; repeated reads
do not consume or reset alerts. Readback is independent of the form response.

An accepted marketplace POST appends exactly one row after checking the locale,
item, email and localized target. Invalid fields, missing items and cross-site
requests do not append. The original localized messages remain the form result.
SvelteKit's enhance sends the native form action. The same action renders the full page without JavaScript.

Targets are ungrouped locale-decimal inputs. Fractional cents round half away
from zero using decimal digits, not binary-float dollar arithmetic. The rounded
minor amount must be positive and a safe integer; the native Intl confirmation
is formatted from that same exact stored amount. Thus 2.005 becomes 201 minor
units, 12.505 becomes 1251, and a rounded zero or unsafe integer is rejected.
Extra-fraction acceptance follows this app's pre-persistence native form;
other adapters' existing precision policies are unchanged.

Each app owns its own in-process store, shared only by that app's native route
bundles. Session tokens contain 256 random bits, are never accepted as
client-chosen new identities, and expire after one hour. Cookies use Path=/,
HttpOnly and SameSite=Lax, with Secure on HTTPS. The synthetic workload is bounded
to 10,000 sessions and 1,000 alerts per session; expired sessions are reclaimed.
This is request-to-request persistence in a single server process, not a
restart-durable database or a multi-instance session service. Ordinary read-only
page and item-JSON requests do not establish an alert session.

## Write Boundaries

Before committing, the POST checks the same native URL encodings used by the
page, including contents and included-in links. Malformed link identifiers fail
without appending an alert. Read-only source and page paths are unchanged.

Separate simultaneous first requests with no cookie have no established shared
identity. In particular, parallel no-JS first submissions from separate tabs
cannot be correlated safely; their unknown sessions are not merged. Once the
cookie is established, concurrent writes use that same session. This is not a
global idempotency guarantee.

The cross-app native write-boundary regression is
`node --test --test-concurrency=1 ../nextjs/alerts-boundary.test.mjs`.
Build all six apps first. It checks malformed links and retries in every locale,
and fresh Next/TanStack JS forms without a readback prewarm against a delayed
synthetic HTTP upstream, including failure recovery and independent readback.

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

The existing BENCHMARK_ORIGIN build setting must match the browser's origin;
this is also SvelteKit's native request URL and CSRF policy.
