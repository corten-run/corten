# JSON adapter checks

From this adapter's directory, with the .NET 10 SDK:

```sh
dotnet run --project tests/Records.Tests.csproj -c Release
```

This package-free executable links the actual source/model/serializer files and disables JSON
reflection. It checks complete DTO round trips, escaping, numeric/null values, fixture loading
once, request-time HTTP parsing, encoded identifiers, missing records, upstream errors,
malformed/missing data and cancellation after an HTTP request is already in flight. Marketplace
validation checks every required field and nested type/null rule, all numeric bounds, unique row
IDs, requested/fixture record IDs and fixture item references. It exits unsuccessfully on the
first failed assertion.

After review, build the normal native image and run the focused HTTP checker from the repository
root:

```sh
docker build -t aspnet-aot-json bench/fullstack/apps/aspnet-aot
node bench/fullstack/apps/aspnet-aot/tests/check-native.mjs aspnet-aot-json
```

The HTTP checker starts and removes its own labeled containers and temporary fixtures. It checks
all 500 catalog and marketplace records in both sources, native reserialization (including
discarding unknown upstream members), numeric/null values, escaping, changed upstream data,
missing records, redirects and errors, GET/HEAD/method handling, legacy items, health and the
absence of page routes. It rejects malformed marketplace inputs using independent cases checked
against the canonical oracle and exercises invalid fixture startup. For both sources and
payloads it runs the reviewed shared JSON gate, retaining actual responses in
`tests/results/review-native-raw.ndjson`. For each HTTP source it aborts real in-flight requests
and waits for the actual ten-second request deadline, while stalled before headers and during
the body. It checks that the upstream socket closes, no retry occurs, and a following read and
readiness check work. It does not perform load testing, change group admission, or replace the
standard benchmark runner. `tests/results/` is ignored for locally saved command output.
