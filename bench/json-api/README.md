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

Actual image inspections retain `Entrypoint` and `Cmd`, without image environment values.
Docker may omit either optional field; projections record that absence as explicit `null`,
including in the independent audit subject. A missing `Config`, malformed command, or empty
effective executable still fails. Container observations normalize the same optional absence
only to `null`, never to a required nonempty command or entrypoint from the image or runner.
Every app receipt must use that image's unmodified default execution; upstream, probe and
load receipts must use their complete fixed native commands and inspected tool entrypoints.
All roles retain and replay the container's actual `Config.Entrypoint`, `Config.Cmd`, `Path`
and `Args`. A same-image replacement command or executable is invalid apparatus, not a
complete observed framework failure. Historical captures without these fields remain incomplete.
The isolated audit handoff independently inspects all 18 app images and both Node/k6 tool images;
timing execution metadata must also equal those accepted image observations, not just a
consistently rewritten runtime snapshot. No default command is invented by the runner.
Both tools are prepared before checks, including check-only and negative attempts. The
pinned k6 executable runs only its version command during preparation, never load before
the full functional/source gate. Missing tool provenance or execution observations block
preparation rather than leaving a mutable entrypoint expectation for timing.

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
overhead. Request count/rate must agree with that measured k6 clock. Historical v1 fixed
phases must complete exactly the configured `rate * duration` requests, with no failures
or dropped iterations, not merely report zero failures. V1 has no scheduling observations
that could certify an extra arrival, so its original exact-count rule is unchanged.
Counts below or above that offer fail, even if checks and upstream reads are rewritten
consistently. V2 uses its separate raw scheduling replay, described below, rather than
relaxing historical evidence. Every request still needs both passing named checks and,
in API mode, exactly one upstream read. Retained `iterations` must match the request count
and its rate (if supplied) must match the measured clock; retained dropped counters must be
zero, including their rate if supplied. These optional standard k6 counters are cross-checked
when present, not new mandatory evidence in `json-api-results/v1`. Historical v1 captures
without them retain the request/check/clock/source accounting checks; no independent started
iteration count is inferred from a metric that was not captured.
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

An initial record-sweep violation may instead produce `functional.json.failure.json`.
Its `record-json-attempt/v1` observations bind the canonical fixture hash, ordered request
intents, response bytes and complete request boundaries. Saved replay derives the violation
from status/content type/JSON/value, never from the checker's assertion message. The runner
retains the actual normal child exit one and clock alongside raw responses and existing
image/source/CPU/upstream context. Missing responses, timeouts, control failures and errors
outside this bounded sweep remain incomplete attempts, not failed-target qualification.
All 36 cells are attempted and all native source audits remain required, even for a negative
cell. Any such negative gates timing globally (`timingDisposition: "gated-functional"`),
with empty runs/aggregates and retained owned-container/network cleanup inventory.
`inspectJson` returns `attemptComplete`, per-app `outcomes` and `comparisonEligibleApps`
separately from `baseline`. A complete functional negative attempt has `baseline: false`, no eligible
comparisons and process exit one. Check-only preparation remains unqualified pending the
independent exact-image audit, whether its observed functional outcome passed or failed.

This implementation has unit/fake-operation and HTTP test coverage, not a measured nine-app
native baseline. It makes no independent-review, serialization-audit, deployment-parity,
build-cost, instruction-count or browser-experience claim. The catalog upstream's functional
gate cannot inject redirects; the marketplace gate does exercise refusal of redirects.

## Production V2

New `run.mjs` captures use `json-api-results/v2`. The reader explicitly dispatches
that schema; the standalone reader keeps historical v1 readable with its original
exact fixed-offer and zero-error checks. Current isolated campaigns require v2 evidence;
a self-declared v1 schema cannot bypass the producer-to-measured-commit join.
Thresholds, rates, VUs, durations, budgets,
the full nine-app/four-profile roster and pass rotation are unchanged.

Production fixed phases use the instrumented fixed script below and retain **all**
original stock JSON stdout, not a selected-event replacement. Closed phases use
`timed-load.js`. The producer receipt binds the verifier-known load source hashes,
exact inspected native commands/environments, unchanged pinned tools and added generator
I/O. Every fixed stream has an independently replayed path/hash/length/event/point/metric/
timestamp receipt; summaries, custom clocks, starts/iterations/requests/classifications,
named checks, thresholds and actual normal exit 0/99 must agree. Stderr UTF-8 byte length
must equal the retained command count before log parsing. Raw fixed latency quantiles
are independently sorted/interpolated using pinned k6 TrendSink semantics.

Normal 99 with coherent classified timeout/429/5xx evidence is saved, not automatically
thrown away as a missing load phase. Later phases and matrix cells continue. Warmup
failure, abnormal/signal/expired/interrupted exits, I/O/output/marshal faults, bad parity,
source evidence, runtime or cleanup remain apparatus/incomplete failures, never app blame.
Every saved metric, aggregate and pass-cell projection is recomputed. Reports retain
failed and missing passes, response counts and min/median/max ranges. Each saved pass
replays on its own, so an invalid pass cannot hide later ones. A pass ended by an
apparatus fault keeps the phases before it that independently replay (including a
coherent normal 99), but its row, app and attempt stay incomplete, never failed or
comparable. An incomplete attempt has no comparison eligibility. In a complete timed
attempt, a supported coherent target failure blames only its app: that app's rows stay
`comparisonEligible: null`, and `comparisonEligibleApps` lists only apps whose every row
independently completed. Any warning (harness, provenance, source/native audit, headroom,
continuity or cleanup) leaves no app comparable. Such an attempt is not a baseline,
and `--require-complete` still fails it, as it does a functional negative.
When the native load command itself faults (timeout, signal, I/O), the raw phase keeps
its first message line, at most 512 characters, before any capture check it provoked;
the phase stays an apparatus fault with null metrics.

App/upstream/load runtime budgets, executable/mount/ownership/identity and lifetimes are
captured before and after every phase. All three roles need window-covering CPU/memory
samples below their memory budgets. Counted app CPU and, for API mode, upstream CPU stay
mandatory. Observed generator peak CPU must be below 80% of its unchanged four-core quota.
The existing upstream is **one Node process**, not a worker pool: API attribution requires
both sampled peak and counted average below 80% of one core. These observations include
the instrumented load's added I/O; synthetic fixtures do not establish native headroom.
Counter windows conservatively include observation overhead; these limits do not prove
CPU saturation or a machine-admission/peak-memory guarantee.

Success keeps exact zero fixture / one API upstream read per request. Failed API read
bounds (`successful requests <= reads <= total requests`) require a new independent
`json-api-native-audit/v2` receipt: the existing source guarantees plus
`atMostOneUpstreamFetch`, `noTransportRetries`, `noBackgroundUpstream` and
`responseAfterUpstreamCompletion`, all true. `transportSourceFiles` names a nonempty,
duplicate-free subset of hash-bound `sourceFiles` inspected for the actual transport,
including retry behavior. The bundle may use `json-api-native-audits/v2`. No positive
audit is generated here. V1 audits still admit successful phases but cannot establish
failed-API bounds. Audit truth/independence remains the operator's source-review boundary.

Read counters must join cold → warmup → all phases → teardown, across the actual ordered
matrix, and to a final upstream observation. Fresh app containers, unchanged participating
identities and no overlapping timing cells are replayed, not inferred from the saved plan.
Counter movement between phases/cases or during/after teardown invalidates the attempt.
Client timeouts do not observe app-handler completion: their classification is retained,
but attribution remains incomplete, as do later phases with an unresolved server tail.
No quiet interval or favorable counter count is taken as a server-drain proof.

Fixed nominal arrivals, all observed starts/offers and observed endpoint variation remain
separate. A late ordinary start is not rejected at zero nanoseconds or nominal-plus-N.
The conditional last-start count check is an evidence-consistency check, not a wall-to-
monotonic conversion or scheduler-stop proof. Fixed drops lack stock monotonic last-offer/
stop observations and remain incomplete/unattributed even with plausible load pressure.
Completion grace is never an offered-arrival budget. Neither the standalone prototype nor
the parent-operated tiny native capture alone enables production eligibility.

Capture hard-caps stdout at 512 MiB (fixed) / 2 MiB (closed), stderr at 4 MiB; any cap/write
fault invalidates the retained prefix. Summary/clock admission caps are 2 MiB each after
timing. At least 528 MiB free disk is checked before each phase; this is not a filesystem
reservation. Fixed replay uses 64 KiB chunks/lines, at most 2,000,000 events / 128 metrics,
and a growing typed latency vector capped at 16 MiB final size (under 32 MiB across growth
allocations). Original bytes are never decompressed: no gzip is accepted on this path.
At defaults, 108 fixed captures can retain at most **54 GiB of admitted raw streams**;
stderr/auxiliary/raw-JSON/stat/app logs are additional. This is an evidence cap, not an
estimate of native output or generator/internal-k6 memory. Actual native output, added
CPU, collector/disk behavior and headroom still need measurement with pinned k6 before
any execution/readiness claim. Disk exhaustion or incomplete samples cannot qualify.

## Standalone Experiment

`fixed-probe.mjs ABSOLUTE_PINNED_K6_BINARY NEW_OUTPUT_DIRECTORY` is an operator-run,
local-only stock-k6 clock experiment, **not** the production matrix runner. It verifies
the binary's 2.4.0 version, retains its executable/source hashes, and performs one ordinary
all-200 JSON fixed phase at 150/s for two seconds against an owned loopback fixture. The
fixture is not a native framework or source audit. Production defaults, matrix selection,
CPU allocations, thresholds, VUs and timeout/grace settings are unchanged. No binary is
downloaded and no Docker/cloud/provider is started by the prototype.

The instrumented script imports the original load options and request/check behavior.
It adds exhaustive wire-outcome/start counters, Gauge clock extrema and stock
`--out json=-` output. **This adds generator CPU, allocation, serialization and pipe/disk
I/O.** Its headroom has not been measured under pinned native k6. New Gauges retain only
extrema; they do not add a per-request Trend. Stock k6 still has its existing trends and
output buffers, whose peak memory cannot be established by synthetic Node fixtures.

`events.jsonl` retains the full, unfiltered original output bytes. `capture.json` binds
its SHA-256, byte/event/point/metric counts and exact first/last timestamps, plus normal
exit/host clocks and separate summary, custom-clock and stderr hashes/lengths. There is
no gzip/decompression path. Replay is `node bench/json-api/fixed-prototype.mjs verify
OUTPUT_DIRECTORY`. It streams at 64KiB, with a 64KiB line limit, 512MiB raw limit,
2,000,000 event limit and 128-metric limit. Oversize/partial/malformed output, missing
final newline, I/O errors, output/marshal/write log errors, abnormal exits and inconsistent
count/rate/check/iteration/drop/clock joins invalidate the observation. Limits are evidence
admission safeguards, not workload settings. Capture stops on stdout/stderr cap errors;
any retained prefix is explicitly incomplete, never accepted as the full stream.

The stdout writer cannot write beyond 512MiB; stderr cannot exceed 4MiB. Summary and
clock admission limits are 2MiB each, checked after timing, not hard filesystem quotas.
The collector reserves at least 528MiB free disk before launching. Exact native output
volume/peak heap/CPU at the production defaults is **not measured**; 9000 nominal arrivals
is not a physical scheduler maximum. The fixed caps bound admitted evidence independently
of that unknown cost. The parent-operated tiny probe must retain measured volume and
resource observations before any extrapolation or qualification.

Instance duration is wall-clock based and has a different origin from scenario progress.
Uncapped scenario progress brackets an origin interval; capped progress is not an exact
elapsed time. Conversion uses explicit outward nanosecond enclosures, retaining the
separate millisecond uncertainty of the scenario wall epoch. Built-in drop point times
remain wall observations, **not** a monotonic scheduler-stop proof. Completion grace never
becomes an offered-arrival budget. Nominal count, actual offers and last-start variation
are reported separately; no nominal-plus-one or zero-nanosecond endpoint gate is imposed
by this experiment. Ordinary endpoint variation is retained for native review, not labeled
an application failure. A conditional last-start count check is only a consistency check.

Every replay returns `json-api-fixed-prototype/v1`, `status: "unqualified"`,
`attemptComplete: false`, `targetOutcome: null`, `comparisonEligible: null` and
`scheduling.endpointEligible: null`. A coherent load exit99 preserves classified counts,
not app-failure attribution. The production v1 reader stays zero-error strict; this
prototype cannot opt into it or establish a baseline. Production v2 uses the separate
joins above. Native headroom qualification and independent exact-source audits are not
established by this experiment or its synthetic tests.

Replay requires the recorded executable's absolute path, SHA-256 and pinned version,
the exact experiment source inventory/hashes and argv matching its fixed configuration,
script and output paths. Source hashes are checked against the verifier's local source
tree by default; portable callers may explicitly supply an independently trusted source
manifest and executable digest to `verifyFixedPrototype`. No saved artifact chooses code
or causes the recorded executable to run. A self-recorded digest is not an independent
executable attestation. Every custom-clock counter count/rate must join the full raw stream,
and latency average must match its raw sum/point count, not just its extrema.

The isolated controller also joins all four production v2 load-asset hashes to
its measured-commit source binding. Matching a mutable local producer alone is
not sufficient. Its captured verifier includes the complete fixed-stream and
timed-outcome import closure; neither evidence nor a recorded producer path can
select executable code. Historical v1 evidence stays on its original verifier.

The disjoint successor `timed-outcomes.mjs` derives complete or incomplete load observations
and projects all requested pass/phase cells with failure counts and ranges. Normal exit99
can retain a complete classified no-drop load observation; it does not itself attribute a
target failure. Fixed dropped work remains incomplete without an observed monotonic last
offer/stop; wall timestamps and completion grace do not fill that gap. Ordinary coherent
late starts are retained without a zero-nanosecond endpoint gate. The closed-only
`timed-load.js` retains success/timeout/429/5xx counters without changing imported load
options or thresholds. Production v2 wires these observations through the separate
runtime/resource/source/cleanup joins described above; this observation module alone
cannot grant app attribution or comparisons. Historical v1 gates remain strict.
