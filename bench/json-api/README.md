# Native JSON API Group

This explicit, independent native runner implements the registry's `json-api` matrix:
Corten, ordinary ASP.NET, FastAPI, Express, Spring, axum/Maud, Drogon, Gin, ASP.NET AOT and ntex.
No app is filtered, substituted or borrowed from another framework. Both `catalog-v1`
(strings-only records) and `marketplace-v2` (rich machine-numeric records) are measured in
fixture and API modes. The four cases have `target: "json"` and `locale: null`.
The nine-app historical contract can still be read; strict qualification uses its
measured checkout, not the ten-app roster.

### Optional transport comparison

For a small **fixture-only diagnostic**, use the already-running native JSON app rather
than a new group. Publish its port 8080 only on loopback; pass the full container ID:

```sh
node bench/json-api/transport.mjs FULL_CONTAINER_ID marketplace-v2 "middleware and gzip level from the measured image, or unknown"
```

Three arms share the same three rotating records, four sequential HTTP/1.1 lanes and
150 scheduled requests/second by default. On a constrained generator, specify 30 or 75
as the final argument for **every** adapter; never pool different rates. Compare persistent identity against persistent gzip to
isolate compression; compare persistent identity against identity with a clean close
every ten requests to isolate connection turnover. There is no fourth combined arm and
no duplicate identity run per question. The driver warms each arm, rotates order over
three passes, and reports each pass separately. Each received body is checked against
the fixture after decoding. No validators, proxy, upstream or output cache should be in
this experiment. Native source review is still required to rule out cached output.

Read wire **body** bytes (not headers), successful throughput, p99, failures, dropped
offers, observed connection counts and counted app CPU together. Wall latency stops at
body receipt, before client decoding; validation still costs generator CPU. CPU brackets
the pass using the container's cgroup v2 counter, including observer overhead. Compare
codec CPU only for matching verified settings; the recorded operator declaration is not proof. Record
the adapter, image, codec settings, host, CPU placement and resource budget when comparing
deployments. A server ignoring gzip is unsupported for that arm; reconnects in a persistent
arm or a generator that misses scheduled work invalidate the comparison. These short,
fixed-rate observations do not establish maximum capacity or an official group result.
The driver withholds ranges and paired deltas on missed offers, event-loop utilization
of 80% or more, or p99 start lag of half a lane interval or more, including warmup.
These checks can rule out a run; passing them does not prove the host was isolated.
The pinned ntex adapter compresses the freshly serialized response in-process:
`ntex 4.11.1`'s `src/http/encoding/encoder.rs` selects flate2's fast (level 1)
for gzip. A framework-default axum adapter without a compression layer is unsupported,
not a zero-cost compression result.
The existing identity-only group and native-source gates remain unchanged in purpose.

**Admission pilot, 2026-11-27.** The ntex 4.11.1 release adapter passed all four
functional cases (500 records each, including numeric marketplace records and the
upstream mutation/error checks). Source inspection confirmed fresh serde serialization
and per-request in-process gzip, not pre-encoded fixture bytes. Keep ntex as a JSON
peer, not an HTML or marketplace-page implementation.

On one shared host we also tried the marketplace fixture with Corten and axum from
`468264ace` and the new ntex adapter, each pinned to the same CPU with 1 GiB.
At 30 offers/s (four lanes, 240 measured requests per arm per pass), complete
persistent passes observed four sockets; complete turnover passes observed 24.
The default axum image answered gzip negotiation with identity. Each adapter
had at least one missing offer or inadequate generator headroom in an identity
or comparison pass, so **none produced a three-pass paired estimate**. The pilot
does not support ranking these apps by CPU or latency or quantifying the cost of
reconnecting. Run the same command on an idle native Linux host before publishing
a paired comparison; an official group round also requires the exact-image audits.

```sh
node --test bench/json-api/*.test.mjs
node bench/json-api/run.mjs j1 --group json-api --build --check-only
node bench/json-api/run.mjs j2 --group json-api --build --receipts /path/to/audited-receipts.json
# From a checkout of FULL_MEASURED_SHA; tool image references are checked against its pins:
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
40-cell matrix passes both gates.** In particular an AOT failure cannot be hidden by an
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
The isolated audit handoff independently inspects each app's two payload images and both Node/k6 tool images;
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
three-pass offsets for ten apps are 0, 3 and 6. Every pass covers all 40 cells.
The runner saves and consumes the exact effective schedule in `summary.timingPlan`; the
report rejects a missing or changed schedule. A saved plan alone is not execution evidence.

CPU quotas are app 1, load 4, upstream 2 cores; memory limits are app 1 GiB, load 2 GiB,
each upstream 512 MiB. `JSON_API_APP_CPUS`, `JSON_API_LOAD_CPUS`, `JSON_API_API_CPUS` optionally
pin disjoint CPU sets. Legacy tier/subset and catalog CPU selectors cannot change this group.
The CPU sidecar reads cgroup v2 counters. Docker stats provide app and upstream
CPU/memory samples. New load-generator samples read the live container's cgroup directly.
Each payload's upstream is one Node process; its CPU limit does not imply parallelism.
Low app utilization or a busy upstream can limit throughput, not establish app capacity.

#### Opt-in c-16 load placement

[#2057 JSON API r67 has insufficient apparatus headroom during fast adapters' warmups](https://github.com/corten-run/corten/issues/2057)
found k6 at its headroom bound during warmup on a `c-8`. `placement.mjs` defines an
opt-in layout, `JSON_API_LOAD_LAYOUT=json-c16-generator-v1`, for a 16-CPU host. It
requires exactly `JSON_API_APP_CPUS=1`, `JSON_API_API_CPUS=2-3` and
`JSON_API_LOAD_CPUS=4-15`, and the runner refuses it before creating a result folder
on a host with fewer than 16 logical CPUs. Only k6 changes: quota 12 on CPUs 4-15.
The app (quota 1 on CPU 1) and the upstream (quota 2 on CPUs 2-3) keep their pins and
quotas. The untimed cold probe stays on CPUs 4-7 at quota 4, and the CPU counter
reader runs at one CPU (`--cpus 1`) on the same CPUs 4-7. The load resource sampler
accounts for all twelve k6 CPUs.

The summary records the layout explicitly: `measurement.loadLayout` and
`measurement.generatorPlacement` (cold probe `{ quota: 4, cpuset: "4-7" }`, load
sampler `{ quota: 12, cpuset: "4-15" }`), beside the usual `measurement.cpus`. The
report accepts a quota-12 load only with that marker and both exact records, checks
the cold probe's participant receipts against the recorded 4-7 budget, and prints a
fixed line naming the layout. An unmarked summary is the default placement, replayed
exactly as before; neither field is ever written without the selector.

No headroom fence changes. The load bound remains below 80% of k6's quota per
allocated core, which is 320% on the default and 960% on c-16. The single-process
upstream bounds stay below 80% of one core, sampled and counted. The layout changes
apparatus placement for future runs only. It does not by itself resolve the separate
upstream peak seen in the Corten API warmups, it is not a measured speedup, and
timings across placements are not comparable. How a fleet selects it is in
[CLOUD.md](../workloads/CLOUD.md#json-api-c-16-placement-opt-in).

#### Opt-in c-32 load placement

The preserved r93 c-16 fixture warmups for Corten and axum reached k6 CPU upper
bounds of 983.13% and 974.46%, respectively, against the 960% fence. The apps
counted 94% and 95% of their one-core budgets, with no failed HTTP requests in
those warmups. `JSON_API_LOAD_LAYOUT=json-c32-generator-v1` requires at least
32 available logical CPUs and the same app and upstream pins as c-16, with
`JSON_API_LOAD_CPUS=4-23` for k6 at quota 20. CPU 0 remains for host work and CPUs
24-31 are not assigned to benchmark containers. The cold probe and counter reader
stay on 4-7. The sampler accounts for all 20 load CPUs; the same 80%-per-core
fence now requires below 1600%. Upstream bounds, rates, warmups and scenarios are
unchanged. Replay requires the exact marker and its CPU and generator records.
This is apparatus calibration, not a qualified result or a speedup.
See [CLOUD.md](../workloads/CLOUD.md#json-api-c-32-placement-opt-in) for selection.

#### Load resource acquisition

[#2056 JSON API r67 rejects 91 timing attempts on late load-resource rows](https://github.com/corten-run/corten/issues/2056)
tracks why the JSON API runner now brackets load-generator samples. The producer is
`json-api-producer/v3`; older producer evidence keeps its original rules, and the
change does not reclassify saved r67 rows. Run on the Linux Docker host itself,
in the daemon's host PID/cgroup namespaces
with the full cgroup v2 mount. A Docker socket mounted into a build container does
not provide those namespaces. Live Docker inspection by exact container ID is the
PID authority; replay never opens a path from saved data. The read-only sampler
holds the process and cgroup directories open and compares device/inode, PID start
ticks, exact membership path, and populated status across each read. All samples
must belong to the same process and cgroup. This assumes a dedicated host without
privileged process migration or mount manipulation. It cannot see between-read state.

Host timestamps bracket all kernel reads, not stdout arrival. The upper bound
includes the complete final millisecond and must fit in Docker's nanosecond
lifetime, with no grace. Slots start one second after the rounded-up Docker start
timestamp. Replay derives the schedule from the exact lifetime and requires a
complete acquisition for each full slot. A final partial slot can contribute a
sample only if the entire acquisition fits. A successful read that may have
started before exit but whose bracket crosses it can be omitted only after its
identity, clocks and CPU counter agree with the preceding read. A resource read
whose bracket starts at or after exit fails the phase, as does a process or
cgroup disappearance during the read, even in the last partial slot. Before
reading any counters, an absent PID directory or an opening process check that
finds the same process already exiting can end sampling. This requires an exact,
clean Docker exit for the same start, a matching final receipt, and no missing
full slot. No wall-clock inference excuses a failed counter read. The
attached client's exit stops new reads without waiting for its output pipes to
close. A late scheduler wake without a read is acceptable only if no full slot
is missing. The existing
five-second bound applies at both edges and across gaps. At least two observations are needed for a timed
phase to qualify; a very short diagnostic run may end too early to prove headroom.
CPU is the upper bound on percent of a core: the difference in cgroup
`usage_usec` divided by the shortest possible elapsed interval (times 100 after
unit conversion). The first observation anchors CPU without inventing a value
and still supplies memory. This is not Docker's host CPU-counter/online-CPU
calculation or rounded CLI output. Memory subtracts cgroup v2 `inactive_file`
from `memory.current` only when it is strictly smaller, matching Docker's cache
rule, but uses unrounded bytes and separate reads, not an atomic snapshot.
Memory must be positive and below budget. The CPU upper bound must stay strictly
below 80% of quota for load headroom. No missing read is skipped.

After approval for one disposable host probe, set `PROBE_IMAGE_ID` to a locally
present immutable Node image ID. This short synthetic process has no network and
does not run a benchmark. Create it without starting it. The probe checks its
identity and limits, starts it by ID and joins the same sampler the runner uses.
Then remove only that synthetic container.

```sh
docker_local() { docker --host unix:///var/run/docker.sock "$@"; }
id=$(docker_local create --pull=never --network none --cpus 1 --memory 128m \
  --restart=no --label corten.json.resource-probe=1 --entrypoint node "${PROBE_IMAGE_ID:?}" \
  -e 'const mem = Buffer.alloc(8 * 1024 * 1024, 1);
      const work = setInterval(() => {
        const until = performance.now() + 10;
        while (performance.now() < until) mem[0] ^= 1;
      }, 100);
      setTimeout(() => clearInterval(work), 9000);') &&
timeout --kill-after=2s 30s node bench/json-api/load-resource-probe.mjs "$id"
```

The probe replays the captured schedule after exit plus 120 ms. Success prints
the observed sample and interval counts, positive CPU and memory, and
`loadHasHeadroom: true`. Neither this synthetic probe nor fake tests establishes
headroom for k6 in an official run or qualifies historical results.
Hosted probe teardown retries an unavailable inspect of the same full container ID
within its cleanup budget. It searches by the unique attempt label only if create
returned no usable ID, and refuses removal on an ownership mismatch. If removal
times out, a successful exact-ID census can prove absence. If the container is
still listed, cleanup may retry once after rechecking ownership, only when the
earlier inspection left enough budget. If the ownership recheck is unavailable,
one final exact-ID census can confirm absence without sending another removal.
The job fails on unresolved removal.

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
For a current API sweep, before the checker resets the upstream, the runner takes
one more control reading. Its per-record starts must match the sweep counter, and
the response-finish observer must show one completed 200 for every start and no
aborts. A missing witness, non-200 answer, or unhealthy upstream setting leaves
the observed app responses on disk but cannot establish a target failure.
Every app's four cells are attempted and all native source audits remain required, even for a negative
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
The current producer binds the load sampler and its replay source to the measured
commit. That commit cannot fall back to the legacy Docker-stats load policy.
The standalone `--require-complete` report and `inspectJson(summary, { load, commit })`
read the measured Git commit in the repository they run from; an unavailable commit
refuses strict reporting. Report-only inspection without a commit does not consult Git.
Isolated replay instead checks the producer against the campaign's bound source digests.
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
continuity or cleanup) leaves all public v2 app verdicts incomplete and no app comparable;
independently replayed per-phase counts remain visible. Such an attempt is not a baseline,
and `--require-complete` still fails it, as it does a functional negative.
When the native load command itself faults (timeout, signal, I/O), the raw phase keeps
its first message line, at most 512 characters, before any capture check it provoked;
the phase stays an apparatus fault with null metrics.

App/upstream/load runtime budgets, executable/mount/ownership/identity and lifetimes are
captured before and after every phase. The upstream's cold identity and start lifetime
must continue through every phase and adjacent timing cell for the same payload. The load
container's nanosecond lifetime must contain the measured k6 duration and all fixed-stream
event timestamps; nonzero generator samples outside it contradict the observation.
All three roles need window-covering CPU/memory
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

For v2 the runner preloads a JSON-only observer in the two upstream Node processes.
The original control body reports request starts and configured status. On the same
control GET the observer returns actual record responses finished by HTTP status, plus
aborted responses; control and health requests are not counted. A successful control
reset begins a new counter epoch. Before, after and settled phase observations must
show only completed 200s, one per cumulative read, with no abort or pending read.
A v2 transport audit permits checking zero-or-one fetch bounds, not blaming the app
when an individual failed request may never have reached the upstream. Without a
completed 200 for every API request, the failed load remains observed but unattributed.
Server-side finish is not a claim that the client received every byte.

Read counters must join cold → warmup → all phases → teardown, across the actual ordered
matrix, and to a final upstream observation. Fresh app containers, unchanged participating
identities and no overlapping timing cells are replayed, not inferred from the saved plan.
Counter movement between phases/cases or during/after teardown invalidates the attempt.
Check-only preparation replays the actual functional attempts and cleanup and requires
empty runs, aggregates and projections with no observed phases. It does not assert that
a timing schedule executed or admit a baseline.
Client timeouts do not observe app-handler completion: their classification is retained,
but attribution remains incomplete, as do later phases with an unresolved server tail.
No quiet interval or favorable counter count is taken as a server-drain proof.
A structured k6 `Request Failed` warning counts against observed timeouts only when
its error is `request timeout` or Go's `Get "<HTTP(S) URL>": request timeout` form.
Neither form changes the status or threshold checks, and rejection messages omit the target.

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
At defaults, 120 fixed captures can retain at most **60 GiB of admitted raw streams**;
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

The isolated controller also joins all four production v2 load-asset hashes and the upstream observer hash to
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
