# Deployment selection

`deployments.mjs` is a read-only, versioned selection layer over `registry.mjs`, not a
runner, benchmark result, certification authority or replacement registry. It maps every
approved app in all nine feature-parity groups to one named intended representative deployment,
including explicit pending native-port entries rather than substitute applications.
It retains the original cases, popular/performance-oriented contenders and auxiliary families.
The legacy registry identity, hashes, `selectedApps`, scheduled selection and saved rounds do
not change. There is no claim that the remaining parity work or all nine runners are complete.

Two objectives share the **same feature-parity group and raw evidence**, with two labeled
views rather than duplicate runs: marketing compares Corten with popular choices in their
representative supported production configurations; straight performance compares the fastest
qualified challengers/configurations. A representative deployment is an intended baseline,
not evidence of support or certification. Marketing does not justify weak popular configurations,
cherry-picking, hiding faster alternatives or suppressing failures. Keep every raw variant and
its label visible. Scope published claims to the measured workload; use losses and differential
profiling to improve Corten, not to change the work competitors must do. No cohort membership
changes are made here.

## Read-only inventory

```sh
node bench/workloads/deployments.mjs catalog-page
node bench/workloads/deployments.mjs json-api
node bench/workloads/deployments.mjs --all
node --test bench/workloads/deployments.test.mjs
```

The CLI emits only an inventory. It accepts no build, launch, cloud, tuning, app-subset,
receipt-promotion or pass-assertion flags. `plan.mjs` and existing runners are unchanged.
The module has no subprocess, network or write API. Read-only source-path checks distinguish
`source-present` from `pending-integration` for known concrete manifests; missing files never
become `source-present`. A missing native port has `implementation:"pending-implementation"`,
`configuration:null` and an `expectedSourceRoot`, not a fullstack fallback. Such entries cannot
bind deployment descriptors, even if a caller supplies an unrelated configuration.
`pending-integration` representatives and candidates also remain unbound. Binding requires
`implementation:"source-present"` and rechecks the catalog's native source references and
the supplied configuration's references. Receipt names or supplied manifests cannot promote
an implementation. Saved descriptors are rechecked by the same gate.
All entries initially report pending
qualification with no evidence; `source-present` means only that the native configuration
is checked in, not that it implements the entire group's required behavior.
Implementation state, certification and effective deployment are separate: a source path
does not certify parity, and a reserved selection does not prove what ran. Only raw native
runtime evidence can establish the effective configuration; this layer executes nothing.

Each representative manifest records framework, runtime/build, launch command, server,
worker topology, runtime profile/environment, middleware, build contexts/Dockerfiles and
source configuration references. References describe the actual checked-in launch paths,
not a generic framework recommendation. Exact binaries, resolved dependencies, image IDs,
effective auto-selected loops/thread counts, environment, mounts and source identities still
need native runtime/source receipts. All such facts are part of independent qualification.

## Concrete configurations

The machine-readable inventory is authoritative for each app/group mapping. Examples:

| App | Named current native configuration | Important boundary |
|---|---|---|
| Corten | workload-specific catalog/marketplace Dockerfiles and native client-heavy generator | Live remains an explicit pending native port/template; legacy price transport is not a recovery application. |
| Express | Node 24, Express + EJS, one process; matched production middleware where selected | Express remains Express. `Bun.serve` is not a replacement contender for it. |
| ASP.NET Core | ordinary Razor Pages/Kestrel/.NET JIT | Never silently replaced by the separate AOT row. |
| ASP.NET Native AOT | existing `aspnet-aot` minimal API/Kestrel native binary | JSON-only representative in `json-api`, not an HTML/Razor qualification. |
| Django | checked-in matched Granian WSGI launch, one worker, three blocking request threads | Gunicorn's three preloaded sync workers and the existing Uvicorn ASGI override remain visible alternatives, not borrowed production passes. |
| FastAPI | existing `fastapi run`/Uvicorn default; direct Uvicorn matched command | Auto loop selection is disclosed, not relabeled as an explicitly tested loop. |
| Laravel | fullstack Octane/FrankenPHP, two explicit persistent workers, production INI | Native recoverable-live port is pending; the historical Reverb launch cannot stand in for it. OPcache installed is not proof of enabled JIT. |
| Native live Express / ASP.NET / Gin | separate `bench/live/apps/{express,aspnet,gin}/Dockerfile` app-local contexts | Commands are `node server.mjs`, `dotnet LiveParity.dll`, and `./server`; native SSE/keyed browser apps, not marketplace/EJS/Razor/templ implementations. |
| Other selected server apps | their existing release Dockerfile, framework server, native workers and middleware references | A production profile string is not a capability receipt. |
| Client-heavy apps | `bench/client-heavy/build.mjs` native production builder and `run.mjs` journey/static host | Native source is `bench/client-heavy/apps`; Corten uses `bench/browser/gen/src/bin/client.{rs,js}`, not historical `apps/state`. No application-server performance or isolated ranking is claimed. |

Live selection follows the new dispatched native inventory, not `bench/live/apps.mjs`'s
historical transport images. Each concrete live manifest includes its own Dockerfile,
server/client source, native transport, middleware and bounded reader topology. Corten's
active native Feed/subscribe/keyed-view work is retained only as a non-binding root-context
`Dockerfile.parity` template (`/app/server`, `LIVE_PARITY=1`) requiring explicit `native-feed`
profile for the entire round; the port still needs integration/review. Phoenix, Rails, Laravel,
Drogon, Leptos and Topcoat remain pending native handovers. Draft files, partial scenarios and old fullstack
images do not change those statuses. Known port files absent from this checkout remain
`pending-integration`; file presence does not establish registration, scenario correctness,
measurement eligibility or certification.

Client-heavy manifests reference the current driver, builder, observer, native app inputs,
dependency manifests and the Rust/JavaScript client generator. The driver's required round
and effective options are recorded separately. The static host is its ephemeral loopback
`serve()` implementation. The historical `bench/browser/build.mjs` and `serve.mjs` are not
the dispatched build or host for this group.

For fullstack-derived groups, the Express/Bun native lane supplies
`bench/deployments/express-bun/Dockerfile`, root build context, `pins.json` build arguments
`NODE_IMAGE`/`BUN_IMAGE`, one shared npm/source tree and
the commands `node server.mjs` and `bun server.mjs`. The catalog includes this concrete
configuration template without importing its executable build/run scripts. Until those files
are integrated, implementation remains pending here. Its `express-bun-qualification/v1`
eight runtime/source/profile cells are narrower than an entire workload-group qualification;
`readyForLoad:false` and `readyForMeasurement:false` are not passes. Its pending review and
performance evidence cannot be inferred from an ordinary runtime compatibility check.
That fullstack source/image template is not reused for the distinct native live SSE app;
live Bun candidates need their own concrete build and native evidence.

Pending compiler/server candidates are deliberately not executable recipes: no default worker
tuning, new arbitrary connection cap, JIT buffer size or deployment count cap is introduced.
The bounded set is named **per group**, not every compiler/configuration permutation. A new
candidate needs a reviewed catalog change and concrete native configuration before selection;
an unknown name fails closed. Not every compiler must be implemented.

## Evidence and identity

`deploymentDescriptor(group, app, id, binding)` uses `benchmark-deployments/v1` and returns
both `bindingSha256` and `descriptorSha256`. `binding` has exactly these fields:

| Field | Required value |
|---|---|
| `commit` | Full exact source commit, not a branch or short name. |
| `images` | Immutable `sha256:` image ID for every build key, including both JSON payloads. |
| `configuration` | Complete native configuration; `null` uses a catalog configuration when one exists. A representative cannot be silently retuned; a candidate cannot replace its framework. |
| `budget` | A validated `benchmark-native-reservation/v1` record for the applicable native runner, described below. Truthy objects, equality alone and another group's reservation are insufficient. No defaults are supplied by this layer. |
| `evidence` | Exactly `implementation`, `native-parity`, `performance`, `independent-review`, each `null` or `{path, sha256}`. |

The binding hash covers the current registry contract, entire case objects, app/configuration,
commit, image IDs and budget. The descriptor hash also covers the evidence references, so
receipts can refer to the non-circular binding hash. JSON object keys are sorted for the hash;
array order remains meaningful. These are internal benchmark descriptors, not a new Corten
network/file protocol. They do not replace native runner provenance or artifact formats.

### Native reservations

`validateDeploymentBudget(group, budget)` accepts exactly `schema`, `group`, `runner`,
`options`, `cpus`, `resources`, `host`, and `edge`. It validates before a descriptor is
hashed or reservations are compared. This internal adapter record explicitly binds fields
from the existing native contracts; it is not a new universal budget or a replacement for
a durable host reservation, native runtime receipt or measured result.

Adapters currently exist only for `catalog-page` (`bench/catalog/run.mjs`), `json-api`
(`bench/json-api/run.mjs`) and `localized-marketplace` (`bench/marketplace/run.mjs`).
`options` must equal that runner's native `parseArgs` result, with explicit complete app/group
selection, round, boolean build/check-only fields and numeric passes, duration, warmup, rate
and startup timeout (plus the native JSON receipts field). Native parsers enforce their
actual bounds and round semantics; check-only is not a timed reservation. `cpus` must equal
the native CPU parser's complete `app`/`api`/`load` output, including quota, placement and
Docker arguments. Invalid or overlapping CPU sets, wrong quotas and omissions fail closed.

`resources` records every applicable native container role, each with `cpu` (its native CPU
record), `memoryBytes`, `sharedMemoryBytes`, and `processes:"all-container-descendants"`.
The existing runner arguments require app 1 GiB, upstream 512 MiB, load 2 GiB, cold probe
256 MiB and sampler 128 MiB; the sampler uses one CPU with the load role's placement.
Catalog/marketplace browser checkers have 2 GiB memory and 1 GiB shared memory; marketplace
also has a 512 MiB transport checker. Other roles record `sharedMemoryBytes:null` because
the runner supplies no explicit shared-memory limit; null is not a claim of zero usage.
These are checked-in native limits, not tuning recommendations or
values callers may enlarge. Their CPU roles follow the corresponding native launch args.

`host` explicitly records `isolation:"none"`, `cpu:null`, `memoryBytes:null`, and process
roles `["driver"]` (catalog/marketplace) or `["driver","functional-checker"]` (JSON).
Null means no host isolation asserted, not zero resource use. Runtime evidence must still
attribute the actual processes and validate the host conditions. `edge` must be `null` for
these direct runners; unbudgeted edge configurations and extra resource roles are rejected.
Changing a native launch budget/topology requires reviewing its adapter, not relabeling it.

The other six groups remain visible in read-only plans but have **no integrated reservation
adapter here and cannot bind descriptors/selections**. Their capture/journey apparatus is
not promoted to a complete measured runner by borrowing catalog limits. Future adapters must
validate their own actual work, resource, process and edge contracts before binding is added.
Even a structurally valid reservation is not evidence that its limits were enforced; native
raw runtime replay and independent review remain mandatory.

`screenDeployment(descriptor, {readArtifact, verifyNative, verifyPerformance})` checks identities
and content hashes. `readArtifact(path)` supplies local bytes through a contained, read-only
artifact store; the caller must reject symlink escape as well as traversal. The screen does
not fetch a path. Receipts use `benchmark-deployment-review/v1`, their exact `kind` and
`bindingSha256`, `author`, `reason`, and `status` (`pending`, `unsupported`, `failed`, `complete`).
Every supplied receipt is read and checked; known failures/unsupported states survive missing
later receipts. Every app and unselected candidate remains visible in the inventory.

Complete implementation, parity and performance receipts each reference nonempty raw
`artifacts`. Parity and performance must repeat the exact entire `cases` array. Performance
has distinct repeated `runs`; every repeat contains every case in registry order with a raw
`artifact` and measured `metrics` (`cpuUsec`, `memoryBytes`, `startupMs`, `p95Ms`). Units and
aggregation must be validated against the native data, not supplied summaries. The independent
review has a different author from implementation/parity/performance, `scope:"entire-group"`
and `reviewed` references to all three receipts. A candidate also binds the fully validated
representative `baseline` descriptor and `baselineBindingSha256`, with the review's explicit
`tradeoff` across CPU, memory, startup and latency under equal work/budgets.

`complete` is a receipt's claim, **not a full-pass flag**. Without trusted native validators
the best screen result is `pending-independent-validation`. `verifyNative` must replay the
native capture/source audits against exact images/configuration and all group requirements;
`verifyPerformance` must derive repeated measurements and verify a meaningful whole-group
tradeoff against the representative, including ranges, noise and regressions. Both receive
`{descriptor, receipts, read, readBytes}` and must return `true` only after those checks.
They are trusted code supplied by the integrating runner, never strings/JSON/CLI flags.
Receipt hashes and an author name cannot establish the truth or independence of an unsigned
audit. This module adds no new trusted native validator and ships no actual passing receipts.

For JSON, use the existing `inspectJson` in `bench/json-api/report.mjs` with the contained
artifact reader and expected full commit, and inspect its whole-matrix rows/warnings, native
source/runtime/image provenance and derived measurements. Check-only results are not timed
baselines. The native source audit remains an unsigned operator trust boundary. A future
deployment adapter must bind those native results to this descriptor, not just copy saved
`complete` flags. Other groups need their own native validators; none are auto-certified here.

## Fixed phases

`fixedSelection(group, descriptors, validators)` requires every registry app once, in order,
one round commit and identical total budget objects. Each app has one deployment for the
**entire group**. Source-present candidates require `reviewed-for-selection`; representatives
with pending qualification can be recorded as intent only when implementation and reservation
gates pass. Pending implementation/integration entries remain inventory-only. Selection output retains the
full deployment inventory and auxiliary families, plus a new `selectionSha256`.

Save that hash before starting a round. `verifyPhaseSelection(selection, reservedSha256,
{app, case, descriptorSha256, selectionSha256})` rejects stale contracts, changed selection
content and mid-round configuration swaps. All cold/warmup/load/browser/other group phases
must consume the same reserved selection. A failure is not permission to switch configurations
for later cases, enlarge the droplet or resource limits, drop a contender, or silently rerun.
No execution integration or auto-promotion is added here. Even a reviewed selection reports
`certified:false` and `executionAuthorized:false`; full native runner gates still apply.

## Outcomes

`outcomeKinds` distinguishes policy intent, without changing implemented runner acceptance:

1. `app-capacity`: failure to sustain offered work or exhaustion/stopping within the app's
   declared equal budget. Retain errors, OOM/stop facts, useful service, missing phases and
   bounds; never replace failure with zero throughput or automatically enlarge resources.
2. `harness-failure`: driver, upstream, host, browser or provenance failure invalidates the
   comparison, not proof of application capacity. Retain and diagnose before a separately
   identified rerun, preserving the failed evidence.
3. `functional-failure`: unequal native work, incorrect behavior, safety or recovery failure.
   Retain the app/configuration and missing requirements, not a comparative performance pass.

**Implemented status matters:** `catalog-group-results/v1` still requires zero failed requests
and dropped iterations. c2 remains strictly failed and unchanged. Treating a capacity-limited
catalog phase as a valid outcome requires an explicitly reviewed schema version and raw
derivation changes, not this policy text. Marketplace's existing `run-contract.mjs` v3
`readOutcome`/`phaseEnd` already records app-capacity outcomes (retained in later versions).
That does not mean all nine groups have been updated or that any result can be reinterpreted.
Keep functional admission, app-capacity outcomes and harness validity separate.

## Primary sources

Options below were checked against primary documentation on 2026-11-12. They describe
upstream possibilities, not qualification of these benchmark apps:

1. [Bun with Express](https://bun.sh/guides/ecosystem/express) retains Express.
   [Single-file packaging](https://bun.sh/docs/compiler/executables) embeds the runtime;
   [bytecode caching](https://bun.sh/docs/compiler/bytecode) is a separate startup mode.
   Neither is machine AOT. [Experimental `bun compile`](https://bun.sh/docs/compiler/aot)
   generates machine code and is a separate, unverified candidate here.
2. [ASP.NET Core Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
   has feature/serialization constraints. The existing minimal JSON app is not the Razor app.
3. [Django deployment](https://docs.djangoproject.com/en/dev/howto/deployment/),
   [Uvicorn settings](https://uvicorn.dev/settings/),
   [Granian's native interfaces/settings](https://github.com/emmett-framework/granian) and
   [Nuitka's compiler manual](https://nuitka.net/user-documentation/user-manual.html) motivate
   separately verified server, loop and compiler candidates, not assumed compatibility.
4. [Laravel Octane](https://laravel.com/framework/docs/octane) documents FrankenPHP,
   RoadRunner and Swoole. [PHP OPcache/JIT settings](https://www.php.net/manual/en/opcache.configuration.php)
   must be observed in the actual runtime. No Laravel machine-AOT implementation is claimed.
