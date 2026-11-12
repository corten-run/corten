# Native production profile

Build and run with `PROFILE=matched` for `marketplace-production/v1`. The server
uses Next's native request handler and rendering, including Pages Router SSR,
hydration, localized forms and no-JavaScript navigation. It does not render shared
benchmark HTML. The default profile does not enable the matched server policy.

`server.mjs` is a [Next custom server](https://nextjs.org/docs/pages/guides/custom-server),
not the standalone output server (the two cannot be combined). The Docker image
therefore includes the production dependencies and complete `.next` output.
`npm start` selects production mode before importing Next/React, including when
the calling environment has no `NODE_ENV`. Build and runtime `PROFILE` must agree;
the server checks Next's saved build configuration and refuses a mismatch.

The matched server uses [Node HTTP options](https://nodejs.org/docs/latest-v24.x/api/http.html#httpcreateserveroptions-requestlistener)
for a 16 KiB request header limit, 30-second header/request-body receive deadlines
and a one-second deadline check interval. `MAX_CONNECTIONS` is the existing native
connection cap, defaulting to 1,000; the pending-connection backlog is derived
from that same cap. `HOSTS` lists exact allowed hostnames, with optional ports;
its local default is `localhost,127.0.0.1,[::1]`. Forwarded host
headers do not grant admission. `/health/live` is local liveness, not an upstream
readiness check. Existing marketplace form size/origin checks and the ten-second
upstream headers-plus-body deadline remain in the native handlers.

The server supplies private cache/security headers and fresh nonces. The Pages
document passes its nonce to Next's `Head` and `NextScript`, following the
[Next CSP guide](https://nextjs.org/docs/pages/guides/content-security-policy).
App Router pages retain their native nonce proxy. No eval or inline-script
exception is added. Next still owns compression, serialization and error responses.
Only the matched build's root App Router layout waits for `connection()` so Next
renders its native not-found page per request too, with that request's nonce
instead of static nonce-less bootstrap/Flight scripts.
The default build retains native static not-found prerendering.

Checks from this directory:

1. `npm run test:marketplace` runs the bounded unit/deadline tests.
2. With `PROFILE` unset, run `npm run build` and `npm run test:production`.
   Then set `PROFILE=matched` and run both commands again on a fresh matched build.
   The production suite runs the unchanged marketplace qualifier for fixture and
   API sources, plus a stalled request body and script nonce checks. These real
   deadline/connection probes are intentionally separate from the unit suite.
   Each artifact checks its prerender manifest, rejects the opposite runtime
   profile, checks the normal start entry with `NODE_ENV` absent, and captures
   actual Chromium `securitypolicyviolation` events on
   native 404 pages, hydration, and valid navigation. It uses the repository's
   Playwright installation and Chromium browser.
   Raw qualification evidence is saved under ignored `work/`, not published.
3. Run `bench/marketplace/check.mjs` from the repository against the running app
   for browser parity, using the repository's Playwright installation.

Passing the marketplace qualifier is not full-stack conformance: conditional GET
and downstream readiness are explicitly outside that production feature contract.
No timing or throughput benchmark is established by these functional checks.
