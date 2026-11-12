# Native JSON API Group

This explicit, independent native runner implements the registry's `json-api` matrix:
Corten, ordinary ASP.NET, FastAPI, Express, Spring, axum/Maud, Drogon, Gin and ASP.NET AOT.
No app is filtered, substituted or borrowed from another framework. Both `catalog-v1`
(strings-only records) and `marketplace-v2` (rich machine-numeric records) are measured in
fixture and API modes. The four cases have `target: "json"` and `locale: null`.

```sh
node --test bench/json-api/*.test.mjs
node bench/json-api/run.mjs j1 --group json-api --build --check-only
node bench/json-api/run.mjs j2 --group json-api --build --receipts /path/to/audited-receipts.json
node bench/json-api/report.mjs bench/json-api/results/j2/summary.json --require-complete --commit FULL_MEASURED_SHA
```

Generate the existing fixtures first with `node bench/catalog/fixtures.mjs` and
`node bench/marketplace/fixtures.mjs`. Node 24, Docker with cgroup v2, and the existing
production Dockerfiles are required for actual native execution. No cloud host, nightly
schedule, shared reservation or old runner is changed. Round names are `jN`; existing
result directories are never overwritten. There is no implicit group or `--apps` subset.
Ordinary ASP.NET and AOT always build/run independently. Corten uses its existing separate
catalog and marketplace native binaries, never substitutes one payload for the other.

## Two Independent Gates

`check.mjs` calls the shared `bench/workloads/json-check.mjs::checkJsonApp` with a required
observer. It retains actual application/control responses in `responses.jsonl`, including
failed probes, and binds a portable observation snapshot by SHA-256 to the case identity.
The report validates complete record sweeps, schemas, mutations, one read per request,
404/error responses and control resets from those raw observations. No page, form, browser
or visual check is required or launched. The shared checker's functional result always keeps
`nativeSerializationVerified: false` and `readyForLoad: false`.

For fixture cases the wrapper additionally resets the owned upstream before the shared gate
and captures its counters afterward. The complete sweep plus missing-record request must
produce zero upstream reads. These extra raw controls are replayed by the report; a functional
result copied from the shared checker without the zero-read observations cannot qualify.

Functional JSON equality and whitespace are **not** proof of native serialization. A
passthrough implementation could pass the HTTP checker. Separate native source verification
stays unqualified without an independently audited receipt supplied by the operator. This
runner does not create positive audit receipts, and none are shipped or claimed here.
The runner's separate `nativeSourceVerified` and `nativeSerializationVerified` fields stay
false until that receipt is verified; the functional result's two false flags are unchanged.
The receipt's guarantees must be established by inspecting the native implementation and
its build/source evidence, not by running the functional checker.

`--receipts` accepts `{ "schema": "json-api-native-audits/v1", "receipts": [...] }`.
Each receipt has `schema: "json-api-native-audit/v1"`, the exact check `identity` recorded
in the summary, a named `auditor`, ISO `auditedAt`, no unresolved `findings`, source files
`[{ "path": "bench/...", "sha256": "..." }]`, and `verified` assertions:
`typedCompleteRecord`, `nativeSerialization`, `noOutputCache`, `noJsonPassthrough`,
`fixtureParsedAtStartup`, `requestTimeFetchParse`, `upstreamErrors`, all true.
Receipt identities bind app, payload/source/target/case key, commit, immutable image ID,
registry contract, CPU settings and framework-default profile. Source snapshots are retained
with the receipt and checked by hash. Receipt identity and file integrity are mechanically
verified, but the truth and independence of the human/source audit remain an operator trust
boundary, not something an unsigned JSON receipt proves cryptographically.

Missing images, routes, functional checks or native receipts leave their selected rows
visible and incomplete. Every member/case is attempted. **No timing begins unless the entire
36-cell matrix passes both gates.** In particular an AOT failure cannot be hidden by an
ordinary ASP.NET result, and functional success alone never admits an app to load.

## Measurement And Evidence

Images use payload-specific `cb-json-api-<payload>-<app>` tags and immutable IDs, with exact
app/payload/commit/cleanliness/contract/profile labels. Untagged historical images are not
accepted as provenance. Timing requires a clean checkout; HEAD and cleanliness are captured
again after cleanup, and a change fails the result. Payload fixtures, raw checks, native
source snapshots, cold results, k6 summaries, CPU counters and utilization samples have
hash-bound portable artifact references. No extra request-time serialization/output cache
is introduced by this runner.
Runtime inspection captures the actual native image, container identity, source/fixture
environment, empty default `PROFILE`, exact owned `API_BASE`, read-only fixture bind source,
network/name/owner and app CPU/memory limits. Expected runtime context comes from the recorded
absolute host checkout and unique run ID, separately from the native source-audit identity.
Functional snapshots also require the observed upstream receipt; cold/load snapshots require
the upstream and probe/load receipts. Those receipts bind actual Node/k6 images, distinct
containers, exact commands, mounts, CPU/memory budgets, and the load generator's target,
payload, duration, mode, rate and users. Every mount is retained and checked against the exact
allowed set; additional root/executable/source overlays or image volumes are not ignored.
Missing or contradictory observations fail closed.

Each pass starts a fresh native container and probes only `/api/catalog/record_1` or
`/api/marketplace/item_1`. Cold time is Docker-host container-start to the first complete
200, not process exec. Warmup defaults to 30 seconds, then 60-second fixed-rate (150/s),
64-user and 256-user phases. `--passes` is 1, 3 or 5; `--duration`, `--warmup`, `--rate`,
`--startup-timeout` are bounded and recorded. Requests use identity encoding and no validators.
API load phases verify one upstream read per measured request. Fixture cold, warmup and load
phases require zero upstream read deltas; API cold reads must fit the successful probe's
attempt count. Both sources retain before/after counter observations, never a null placeholder.
The timing order is pass, explicit registry profile, then app. App order rotates by
`floor((pass - 1) * appCount / passes)`, the existing native marketplace convention; the
three-pass offsets for nine apps are 0, 3 and 6. Every pass still covers all 36 cells.
The runner saves and consumes the exact effective schedule in `summary.timingPlan`; the
report rejects a missing or changed schedule. A saved plan alone is not execution evidence.

CPU quotas are app 1, load 4, upstream 2 cores; memory limits are app 1 GiB, load 2 GiB,
each upstream 512 MiB. `JSON_API_APP_CPUS`, `JSON_API_LOAD_CPUS`, `JSON_API_API_CPUS` optionally
pin disjoint CPU sets. Legacy tier/subset and catalog CPU selectors cannot change this group.
The CPU sidecar reads cgroup v2 counters. Docker stats provide raw CPU/memory samples.
Each payload's upstream is one Node process; its CPU limit does not imply parallelism.
Low app utilization or a busy upstream can limit throughput, not establish app capacity.

Every load phase retains host start/end clocks and k6's measured `testRunDurationMs` via
[`handleSummary`](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/).
The k6 duration must cover the configured interval without exceeding its existing 10-second
graceful stop; the host bracket must contain that duration with at most 10 seconds of control
overhead. Request count/rate must agree with that measured k6 clock. Fixed phases must complete
exactly `rate * duration` requests (9000 at the defaults), not merely report zero failures.
Raw statistics must have strictly increasing timestamps inside the host bracket, with no gap
or uncovered edge over five seconds. These evidence limits reject incomplete measurements;
they do not establish machine admission or saturation. Existing raw artifacts missing these
clocks, zero-read counters or participating runtime observations remain incomplete reports.

`json-api-results/v1` and `json-api-group/v1` record the exact registry contract and full
matrix. The read-only report replays raw functional observations, verifies native receipts,
recomputes cold/phase metrics from raw artifacts, rejects duplicate/wrong identities and
passes, and rederives every saved fixed/sat64/sat256 aggregate including `passes` and `asked`.
Missing/corrupt/extra evidence cannot establish a complete baseline. Partial reports retain
all selected apps and explicitly label unverified partial numbers rather than zero-filling.
`--require-complete` fails incomplete reports. Check-only runs are not timed baselines.
Functional replay prepares expected record bytes once per case: an exact response match is
already the required JSON value; differing whitespace or key order still takes the full parsed
structural comparison. Every app's identity, status, content type, sweep and source controls
remain independently checked. This is report-side validation work, not application output caching.

This implementation has unit/fake-operation and HTTP test coverage, not a measured nine-app
native baseline. It makes no independent-review, serialization-audit, deployment-parity,
build-cost, instruction-count or browser-experience claim. The catalog upstream's functional
gate cannot inject redirects; the marketplace gate does exercise refusal of redirects.
