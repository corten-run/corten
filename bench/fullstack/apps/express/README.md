# Express record JSON checks

The native `/api/catalog/:id` and `/api/marketplace/:id` routes serialize parsed records with
Express's `res.json`. Missing records, failed upstream reads and unsupported methods have JSON
error bodies. GET and Express's implicit HEAD remain available; other methods return 405 with
`Allow: GET, HEAD` without fetching. Responses use `Cache-Control: no-store`.
The error boundary follows Express's native case-insensitive route matching, including
malformed IDs on upper- and mixed-case aliases.

These JSON reads alone own a ten-second whole-read deadline and cancel their fetch, including
body consumption, when the caller disconnects. The matched profile's existing request timeout
still applies and returns JSON on these two routes. Page localization, native form APIs, legacy item routes
and the choice of default/matched production middleware are unchanged.

With the app's dependencies installed, run `node --test marketplace.test.mjs`. From the repository
root, build the normal image and run the focused socket checks:

```sh
docker build -t record-express bench/fullstack/apps/express
node bench/fullstack/apps/express/check-native.mjs record-express
```

The driver binds current sources read-only onto that dependency image and tests both production
profiles and both sources. It runs the shared `checkJsonApp` for all 500 records per payload,
checks errors/methods, stalls before headers and trickles the body, aborts actual in-flight
requests, observes upstream socket closure and checks recovery. Raw responses, source hashes,
image identity and a summary stay in ignored `tests/results/`; labeled containers are removed.
`--quick` skips only deadline/disconnect probes. This is focused correctness evidence, not a
native serialization audit receipt, clean-image provenance or load readiness.
`--regressions-only` runs just the case-alias regression probes. Test containers have a
one-CPU, 1 GiB budget; Linux hosts receive an explicit host-gateway mapping.

The native source audit is still pending. Existing parsers do not enforce requested-record
identity, all workload numeric bounds or duplicate row IDs; the catalog parser also preserves
unknown fields.
Passing these HTTP checks does not resolve those limitations or qualify the adapter for load.

## Native alert persistence

In both profiles and with either record source, an accepted native
`POST /marketplace/:locale/:id` appends exactly one row to a process-local memory
store. `GET /api/alerts` independently reads it as an insertion-ordered JSON array
`[{"item_id":"item_1","email":"buyer@example.test","target_minor":1250}]`, with
`Cache-Control: no-store`. Missing/unknown cookies and fresh browser contexts read
`[]`; GET never initializes, clears or resets a store. Invalid forms, missing
records, unsupported locales and cross-site rejections do not append. Native Intl
price parsing, localized messages and form APIs remain in place. Legacy item
forms are not part of this store. No parity flag or new dependency is needed.

The first accepted POST issues `marketplace-alerts`, a server-generated 256-bit
random, host-only, HttpOnly, SameSite=Lax session cookie via Express's cookie API.
It is Secure on HTTPS; plain HTTP is supported for the local synthetic benchmark.
Unknown caller-selected tokens are replaced, never registered. Preserve this
cookie for subsequent POSTs and independent GETs. Establish it before concurrent
writes: two first POSTs without cookies create separate sessions. Page/record-JSON
GETs do not allocate alert sessions. Each append and read is synchronous within
Node's event loop. Repeated accepted POSTs append separate rows, not retry deduplication.
There is no reset/debug API. State survives reads, not process restarts, and is
retained for the process lifetime, not a durable or multi-instance session service.

`node --test marketplace.test.mjs` includes real HTTP POST/readback, all locales,
both profiles, rejection/non-mutation, independent clients and concurrent operations.
