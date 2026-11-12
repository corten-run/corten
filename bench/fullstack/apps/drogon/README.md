# Native record JSON

Catalog records use the native C++ model. Marketplace records use complete-schema
validation of JsonCpp values and native reserialization, not upstream response-byte
forwarding. Required fields, numeric bounds, IDs and fixture references are checked;
fixtures are parsed at startup and API records are fetched and parsed per request.
Native templates, ICU localization and legacy item routes remain separate.

Record JSON GET/HEAD responses include native JSON errors for missing records,
unsupported methods and failed upstream reads. Unsupported methods return 405 with
`Allow: GET, HEAD`. Errors are generic and record responses are not output-cached.
The record HTTP client refuses redirects, bounds complete responses to ten seconds,
and observes caller disconnects. An in-flight read owns its upstream connection;
the per-thread idle-client pool is bounded. Aggregate concurrency/body limits and
DNS/TLS-stage cancellation are not qualified by this work.

With the native dependencies from the Dockerfile installed, run from this directory:

```sh
cmake -S . -B build -DBUILD_TESTING=ON
cmake --build build
ctest --test-dir build --output-on-failure
```

From the repository root, build the normal image and run the native HTTP and bad
fixture startup checks:

```sh
docker build -t record-drogon bench/fullstack/apps/drogon
node bench/fullstack/apps/drogon/tests/json-http.mjs record-drogon
node bench/fullstack/apps/drogon/tests/fixture-startup.mjs record-drogon
```

The HTTP driver checks both payloads and sources, complete-record correctness,
malformed responses, redirects, deadlines, disconnect cleanup and recovery. Raw
observations stay under ignored `tests/results/`. These are correctness checks,
not production qualification, native audit receipts or benchmark throughput.

## Session alerts

Marketplace POSTs append exactly one JsonCpp record after the existing ICU/email
validation; invalid input, missing items/locales and cross-site writes append
nothing. The native URL-encoded body parser, not query fields, supplies alert
input. The original CSP templates and scripts are retained. `GET /api/alerts`
independently serializes the session's ordered array of
`{item_id,email,target_minor}` through Drogon's JSON response API. It neither
fetches an item nor creates, clears or refreshes a session, and sends `no-store`.

The first accepted POST sets host-only `marketplace_session`, with `Path=/`,
`HttpOnly`, `SameSite=Lax` and no browser expiry. The credential is 32 bytes from
OpenSSL's cryptographic random source, hex encoded; the existing Drogon dependency
already links OpenSSL. `Secure` follows the native connection's TLS state, never
forwarding headers. The existing connection-origin guard is unchanged apart from
rejecting non-same-origin Fetch Metadata. TLS termination in a proxy is not inferred.
An unknown cookie is never adopted as a new session's credential.

The mutex-protected process-local store expires sessions one hour after creation,
not after reads. Restart loses the synthetic data. At 4,096 live sessions or 1,024
alerts per session, writes fail with 503 rather than evicting live rows. This is
not durable or distributed storage. CTest includes concurrent store/cookie/capacity
checks. For fixture/API HTTP, real browser forms in JS/no-JS contexts, cookie-jar
readback and isolation, run the compiled-native driver documented in
`../gin/README.md` with `drogon` and the image under test.
