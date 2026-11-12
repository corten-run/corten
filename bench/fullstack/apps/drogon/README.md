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
