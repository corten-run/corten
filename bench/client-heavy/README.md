# Native client-heavy journey

This is a new functional workload, not a continuation of the historical browser
benchmark. All six selected frameworks stay in the result, including failures.
`../workloads/client.mjs` is an offline oracle only. No application imports it.
Each application owns its mutations and renders through its native framework.

Implementation checks:
1. Build the six native apps against the same explicit fixture; retain build failures.
2. Capture actual loaded data, every operation's DOM and node identities, network,
   errors and owned resources. Validate with the offline oracle before timing.
3. Run a separate measured journey only after qualification, validate it again,
   and save raw captures, action timings and source/build provenance.

From the repository root, with its Playwright installed and `npm ci` in
`bench/browser`:

```sh
node --test bench/client-heavy/*.test.mjs
node bench/client-heavy/run.mjs local --out bench/client-heavy/work/local
```

The defaults are bounded verification sizes (14 rows, 110 large rows, append 7,
24 cards), not performance ranking sizes. Explicit options `--rows 1000 --large
10000 --append 1000 --cards 200` exercise the historical sizes under this new
contract. `--seed`, `--cleanup-ms`, `--observation-ms`, and `--timeout-ms` are
recorded with the effective workload. There is deliberately no contender filter.
Build output is isolated under the output directory. Use `--cargo <executable>`
to choose a Cargo-compatible launcher; the default is `cargo`.
Every invocation builds the current native sources and compiles/runs the Corten Rust
generator through that launcher. External build receipts and precompiled generator
executables are not accepted: self-consistent hashes cannot establish that artifacts
were produced by the claimed framework. The output directory must be new.

The dashboard source is an EventTarget delivering tick *inputs*, not rendered
rows, a reducer, expected snapshots or DOM. Native effects subscribe and native
unmount/disposal releases them. The observer retains the actual screen element
before unmount, then reads that detached DOM after an independently dispatched
tick. It does not clone the screen or reconstruct it from the oracle.
While connected, the screen, dispatched controls and extracted row/card/total text
must pass the browser's `checkVisibility` with CSS visibility and opacity checks.
Hidden descendants cannot supply visible text. Post-unmount reads intentionally
inspect the retained detached DOM, whose layout is no longer visible.

Resources are observed by wrapping the browser's actual EventTarget, timer,
animation/idle/microtask/MessageChannel/scheduler, fetch/XHR/beacon and socket APIs
before scripts load. The source's real listener set supplies subscription counts,
including subscriptions registered before `begin()`. Socket connections are tracked
from construction, not from mount, and every WebSocket send attempt is recorded,
including bootstrap sends and sends that fail. A live bootstrap source subscription
or socket makes the required zero baseline fail; `begin()` never subtracts it away.
Removing a bootstrap subscription or closing a connection releases its count normally.
Workers are refused, service workers blocked, rather than left unobserved.
Element-bound input handlers on detached elements cannot receive browser input;
they are not active owned listeners. Mount-installed global app listeners *are*
counted, including event-handler properties on the window, document, document element and body; replacing
a bootstrap handler is counted too. The one
explicit infrastructure classification is Corten's pair of document delegates for
`click` and `input`: these are page-lifetime listeners installed lazily by the
runtime's `listen`, not component subscriptions. Only each first capture/bubble
registration whose immediate caller is the hashed `/corten/runtime.js` qualifies;
the retained `resourceDetails` names them. An app's global input listener still
fails the hostile test. Bootstrap document listeners and event-handler properties
remain page infrastructure, but source subscriptions and sockets never gain that
exemption. Mounted timers and queued tasks are counted. Promise chains without a
scheduled browser task are not globally enumerable; the native apps own no such
asynchronous work.

The runner records operation dispatch-to-two-animation-frames elapsed time,
including scheduling and rendering, not pure handler CPU. Observer overhead is
present in both journeys. Qualification has `actions: null`; action timings are
collected only in the separate measurement pass after qualification. `readyMs`
is mount-to-visible-screen-and-subscription readiness, not document load time.
These local bounded numbers are diagnostics, not a
ranking or cloud/load readiness. Offline `readyForLoad` remains false.

Integration left to the parent: add `node --test bench/client-heavy/*.test.mjs`
to the check command and route the client-heavy group's native execution to
`node bench/client-heavy/run.mjs <round> --out <artifact-directory>`; document the new
journey in the benchmark guide and changelog. No nightly configuration is changed.

The entry exports `async run(args)` where `args` is the CLI argument array, beginning
with the required round. The returned/saved `result.json` uses
`client-heavy-native/v1`: `group`, `round`, `effectiveWorkload`, `settings`,
`timeoutMs`, `provenance`, `selectedApps`, `builds`, `cells`, `passed`, and
`readyForLoad: false`. Each cell has `outcome`, `qualification`, `measurement`
and `readyForMeasurement`. Failed builds/runs retain reasons, never timing zeros.
`cleanupFailures` records sanitized resource/error identities and diagnostic hashes.
Browser shutdown failures do not skip server shutdown or the final evidence write,
and any cleanup failure makes the overall run fail.
Captures inside each pass retain `client-capture/v1` unchanged. A failed journey
has `records: null` in that capture and its partial observations under `failure`.
No measured action timings are released for a failing measured journey.

Set `CLIENT_NATIVE_DIR` to the run's `native` directory before running
`native.test.mjs` to exercise both passes for all six native assets, deliberate
visibility/content faults in React, Corten-specific cleanup/visibility faults,
and an in-memory React bootstrap socket/subscription retained through cleanup.
That socket probe uses a loopback peer and verifies actual outgoing operation and
cleanup frames, resource counts, and refusal to enter measurement.
Reusing assets for these tests is diagnostic harness regression coverage only:
check their recorded artifact/input hashes against the assets and current native
sources, and disclose that the observer/runner are newer than the build receipt.
This does not bypass the runner's mandatory fresh build or create a new baseline.
Without it the native integration tests are explicitly skipped; the observer and
dispatch-gate tests need no build. The hostile cases are not framework evidence.

## Saved Evidence

The standalone verifier uses only Node built-ins and the existing offline oracle.
It does not import Playwright, run saved code, build apps, launch browsers or
servers, contact a network, or write artifacts. Run it against a quiescent local
directory, with the requested round and full measured commit supplied independently:

```sh
node bench/client-heavy/verify.mjs bench/client-heavy/work/local --round local --commit <full-commit-sha>
node --test bench/client-heavy/verify.test.mjs
```

Its fixed API is `await validateSaved({ folder, round, commit })`, exported from
`verify.mjs`. No validator, command, contender, plan, output or policy override is
accepted. The matching CLI accepts exactly the arguments above, in that order.
Local Git objects for the supplied commit must be available; the verifier explicitly
disables Git lazy fetching and replacement objects, including inherited promisor
configuration and local replacement refs. Read-only
Git object queries compare the saved source/input hashes
against that exact commit. v1 checkout hashes may match committed LF or CRLF bytes;
this compatibility check cannot authenticate the source or the build. Reviewed
runner/build snapshots prevent silently inheriting changed option semantics.

The JSON report uses `client-heavy-saved-verification/v1`. `status: "invalid"`
means malformed, inconsistent, incompatible or unreadable evidence was observed;
`errors` locates each detected problem. `status: "blocked"` means those diagnostic
checks passed but required proof is missing. `diagnosticsPassed` distinguishes
these cases; it is **not** native qualification. CLI exits are 1 for invalid/usage
and 2 for blocked. There is deliberately no success exit for native/v1 evidence.
Consumers, including the isolated worker, must retain the report and blockers,
not convert a blocked report or an empty error list into success.

Verification checks the entire current six-app registry and definition, effective
fixture and cleanup/timeout options, source provenance, saved build inventory,
actual bundle bytes/hashes, and each raw per-app file against `result.json`.
Every supplied qualification and measurement capture is replayed with the existing
oracle, including both passes when one fails. Saved oracle results, pass/ready
flags, operation order, timings and measurement gating must agree with the raw
observations. Derived operation counts, capture duration, cleanup release and
post-probe observation intervals come from the records, and bundle sizes come
from saved bytes. Failed, unsupported and not-run outcomes stay explicit, with
unavailable measurements `null`, never zero. A file ledger hashes every saved
native output, including generated files not covered by v1's build receipt.
An outer outcome must match the unavailable qualification, or the unavailable
measurement after successful qualification. A failed capture cannot be relabeled
unsupported or not-run. Qualification without a measurement remains a blocked
failed cell, not a pass or a wholly unrun cell.
Present native build/workload manifests are checked independently even when the
summary has no builds. Missing manifests block verification; malformed or
contradictory manifests invalidate it. Present summary build claims, failure-log
hashes and artifact hashes are validated even if the separate build manifest is
missing or inconsistent. Optional failure and resource-detail fields must have
their declared shape whenever present, including falsy values and failed,
unsupported or not-run passes that cannot supply timings.
Any oracle-passing capture requires a built receipt when build claims are present,
even if the other pass fails. Failed-pass diagnostics use the producer's complete
partial-record and sanitized-error unions, including nested DOM, data, resource,
network and error fields, source-bound operation inputs and matching failure
phase/reason. Well-formed incomplete or functionally failing observations remain
failed and blocked; they are not required to be complete successful journeys.
Native owned samples must have no more subscriptions than listeners, including
partial failed samples. A saved readiness duration must fit between the baseline
and subsequent active-resource observations, with a fixed 0.01 ms clock-rounding
tolerance (also used for action intervals). This is a consistency bound, not
recomputation or authentication of the missing timing endpoints.

The verifier refuses traversal, absolute paths inside receipts, links/junctions,
linked ancestors, hardlinks, duplicate/case-colliding files and build inputs,
nonregular files and unexpected artifact files/directories. It uses exact integer
file identities and bounds the tree to 4,096 entries, 20 directory levels, 64 MiB
per file and 512 MiB total. The unit tests create and remove real temporary saved
trees with synthetic observations and hostile mutations, not native Rust builds
or framework measurements.

Current `client-heavy-native/v1` does not save a source-bound invocation/plan and
Cargo tool identity, complete source/dependency bytes, independently established
fresh source-to-bundle build proof, raw mount/operation timing starts, or positive
terminal browser/server closure and interruption receipts. Its empty
`cleanupFailures` array is not positive cleanup proof. An oracle can check a
trace's semantics, not authenticate a fabricated browser observation. Consequently
even fully self-consistent files and hashes remain blocked. Plausible `readyMs`
and `elapsedMs` scalars cannot be recomputed and are not released as verified
timings (`timings: null`). `valid`, `ready`, `readyForLoad` and `rankingEligible`
remain false, and isolation remains `"unknown"`. No saved summary flag, note or
self-consistent replacement bundle can promote those states. Missing native
proof requires a separately reviewed runner/evidence change, not a verifier
override or a relabeling of historical artifacts.
