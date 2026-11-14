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
`client-heavy-native/v2`: `group`, `round`, `effectiveWorkload`, `settings`,
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

## Producer Evidence

New invocations use native/v2; historical native/v1 captures are never relabeled.
The six-app selection, fixture defaults, observer and `client-capture/v1` oracle
contract are unchanged. Each supplied pass additionally retains `timing` and
`lifecycle` observations without adding fields to the capture itself.

`plan.json` saves the exact CLI array, default and effective configuration,
effective workload, registry definition, round and source commit. Relevant tracked
and nonignored untracked source files, Git status and binary diff are saved before
and after execution. `evidence/source-*.json` maps each path to its actual saved
bytes in `evidence/blobs/<sha256>`. Node and browser dependency trees receive the
same before/after byte snapshots. Missing, unsafe-linked, oversized or unreadable
inputs explicitly block proof; partial snapshots do not mean coverage.
The collector bounds each tree to 40,000 entries, 32 levels, 128 MiB per file and
1 GiB of unique saved blobs. The observed browser executable alone may be up to
512 MiB (Linux headless-shell exceeds 128 MiB); other inputs retain the 128 MiB
bound. Offline replay checks `browser.json` before reading oversized bytes; only
its exact executable blob receives the exception, not unreferenced blobs, other
references or ordinary files. Replay enforces 1 GiB of unique blobs and 2 GiB of
total saved files. External configuration is not copied or authenticated;
only selected inherited configuration variable names are recorded, not their values.

For the two npm install trees, collection uses a closed-install policy. Only
`.bin` symlinks matching the installed package's declared `bin` are accepted;
their raw relative targets and exact target bytes are saved without following
the symlink. Escaping, chained, directory and non-bin links are refused. Regular
hardlinked files are read only when every link to their inode is inventoried in
that same install root, with stable identity/link counts during reads. This admits
npm's ordinary esbuild binary pair, not an external cache hardlink. Snapshot
`layout` records these aliases/groups and must match before/after as well as their
bytes. Source readers and saved artifacts still reject links and hardlinks.

Corten runs `cargo vendor` to save registry dependency bytes and the resolved
generator lockfile, then builds/runs with `--locked --offline` and that vendor
source. Source replacement uses a saved TOML file with Cargo's documented
[config-relative paths](https://doc.rust-lang.org/cargo/reference/config.html#config-relative-paths),
not shell-quoted inline configuration arguments. Raw Cargo version, vendor and verbose compiler output/status receipts are
saved, including actual `compiler-artifact` cache observations. Vendored bytes and
the lockfile are checked again after the build. This does not authenticate a
compiler binary, wrapper or external Cargo configuration. These belong to the
external trusted observation and independent review below. Fresh target and
generated compiler input closure are collected by the v2 adapter. A queued
Cargo-compatible launcher is not killed by a shell-only timeout.
Raw relative generator dep-info paths resolve against the metadata root package's
compiler working directory, while their original spelling remains in the ledger.
The v2 vendor tree accepts `+` in versioned Cargo package filenames (SemVer build
metadata); v1 and non-vendor artifact paths keep the legacy character restrictions.
Cargo availability is checked before loading compiler/framework dependencies. A
missing Cargo command ends as an explicit apparatus failure with all six not-run
outcomes, not a successful JavaScript subset. Unused dependency trees are not
collected on that early path; offline proof remains incomplete, never qualified.

Each successful JavaScript build saves actual esbuild options, metafile, original
bundle bytes, appended footer, full input bytes and final artifact hashes. The
source/dependency snapshots include native compiler/plugin modules rather than
just their version strings. Node and browser executable bytes are saved when
available within the collector bounds. Tool receipts establish observed command
results and outputs, not independent build authentication. Browser launch uses
Playwright's owned `BrowserServer` process and retains its actual executable,
PID and fixed launch options. Linux also checks `/proc/<pid>/exe`; the generic
`chromium.executablePath()` full-browser default is not substituted for the
headless-shell that actually ran. Shutdown closes the owned server/process, not
merely the remote connection. Worker executable comparisons remain exact.

Opt-in real Linux apparatus controls (ordinary npm install, actual headless image,
before/after closure and hostile links, not framework qualification):

```sh
CLIENT_LINUX_CONTROLS=1 node --test --test-concurrency=1 bench/client-heavy/install-layout.test.mjs bench/client-heavy/linux-controls.test.mjs
```

`timing` records browser `performance.timeOrigin` and raw mount/operation start
and end clocks, with their capture record indexes and observation clocks. Scalars
can therefore be recomputed without inventing starts. `lifecycle` records actual
context-close events and return/failure receipts, and deadline cancellation or
observed abort. Missing closure evidence, a failed close or a fired deadline bars
measurement even if an oracle reports a semantic pass. Terminal browser/server
closure and received SIGINT/SIGTERM abort observations are saved separately.
Synchronous native build interruption is not independently authenticated.

Finalization writes every selected app file, including failed, unsupported and
not-run cells. `collection.accounting: "complete"` means all six outcomes were
retained, not that all succeeded. Unavailable measurements remain `null`.
`collection.proof` remains `"blocked"`, isolation `"unknown"`, ranking eligibility
false and `readyForLoad` false. `passed` is only the runner's local semantic and
cleanup diagnostic. The producer CLI exits 1 for failure and 2 for a diagnostic
pass requiring independent review, never 0 for strict qualification.

`review-subject.json` hashes the exact final artifact ledger, excluding itself.
It is the subject for a separate trusted execution/source/build review, not an
approval, signature or qualification token. A reviewer must bind independent
execution evidence to that exact subject; a replacement self-consistent ledger
cannot approve itself. There is no authored `approved` flag or approval input.
The standalone verifier dispatches by the saved schema. Legacy v1 retains its
reviewed producer pins at `5e2c6b6e9ebd838cb3d8f2d8b427de83616236b3` and all its
blocked proof policy. Those pins never move to the v2 producer. Historical
captures are not rewritten, and the v1 tests are not v2 qualification.

Focused producer tests need no Rust build or installed framework dependencies:

```sh
node --test --test-concurrency=1 bench/client-heavy/evidence.test.mjs bench/client-heavy/run.test.mjs
```

## Native v2 Replay

`await validateSaved({ folder, round, commit })` in `verify.mjs` remains the fixed
API. No policy, oracle, command, context or contender injection is accepted. Its
v2 implementation is split into `contract.mjs` (pure current option/default and
build-option semantics), `compiler.mjs` (dep-info collection/decoding),
`replay-v2.mjs` (trace and clock invariants), and `verify-v2.mjs` (saved closure).
Offline validation never imports the runner, browser automation or saved code,
builds anything, writes artifacts, or contacts the network. The six selected apps
are mandatory. An empty failure list or successful subset cannot qualify a run.

New builds use an invocation-owned fresh Cargo target, save compiler-artifact
messages, Cargo metadata, raw `.rustc_info.json`, every textual dep-info file and
the union of actual compiler input bytes, including generated inputs. The target
is removed after collection. Vendored bytes and lockfile observations are retained.
Raw esbuild input/metafile/options, bundle/footer bytes, dependency snapshots and
every final artifact are cross-checked. The exact invocation is re-parsed using
the merged native defaults, not historical browser sizes. Configuration variable
**names** are unioned across plan, tool receipts and final observation, never
dumped or asserted absent; values and external configuration are a trusted-host
review responsibility. Source bytes must match the independently requested full
local commit (LF/CRLF checkout compatibility is explicit), and complete tracked
source inventory is checked with Git replacements and lazy fetch disabled.

Every supplied pass replays the existing oracle, including failures. Raw browser
start/end points must use the same origin, match their record indexes and fit
between preceding and corresponding observations. Readiness and action scalars
are recomputed by subtraction. Context deadlines, aborts, close return/events,
terminal browser disconnect and server close observations are checked separately.
Each actual HTTP request retains its clocks, method, path, status, body byte count
and hash; successful passes must receive every required artifact's exact saved
bytes. Replayed request aggregates are derived from those receipts. Failed passes
release `timings: null`, never zero. Terminal cleanup failure or interruption
cannot preserve the summary's pass. All six cell and build files remain present.

The report schema is `client-heavy-saved-verification/v2`. `errors` consists of
`{ at, reason }`, scoped to the file, app/pass, request ledger or summary invariant.
`intrinsic` has `valid`, `complete`, `passed` and `cleanupPassed`; `selectedApps`,
`cells`, `files`, `sources.files`, `configurationNames`, `subjectSha256`,
`invocation`, `effectiveWorkload`, `settings` and `timeoutMs` expose the checked
binding. Each cell retains `outcome`, `reason`, `replayPassed`, qualification,
measurement and build; derived timings and request aggregates appear only on
successful passes. Consumers compare these settings to their execution binding.

1. `invalid`: malformed, unreadable or contradictory claims. CLI exit 1.
2. `blocked`: consistent diagnostics but incomplete source/dependency/tool proof.
   CLI exit 2. This is not a failed framework measurement.
3. `failed`: valid complete attempt with an observed framework, build, cleanup or
   interruption failure, or explicit unavailable outcome. CLI exit 1. Preserve
   every failure and null measurement; do not drop cells or promote an empty set.
4. `verified`: complete successful **intrinsic replay only**. CLI exit 0. It does
   not authenticate execution, source-to-bundle production or host isolation.

Offline `authentication` is always `external-required`; `ready`, `readyForLoad`
and `rankingEligible` stay false and isolation stays `unknown`, even for verified
synthetic bytes. A ledger cannot establish its own authenticity.

## Trusted Admission Seam

`await admitSaved({ folder, round, commit }, { context, observation, buildReview, hostProof })`
in `admission.mjs` composes a fresh fixed offline replay with observations supplied
through the controller's **external trusted channel**. Nothing is loaded from a
saved `approved` file. This seam checks binding, not the trustworthiness of the
channel: the controller must obtain the context and observation from its observed
isolated unit, not copy claims out of the producer. No cryptographic signature
is required or claimed. A complete synthetic tree cannot admit itself.

`client-heavy-trusted-context/v1` fixes attempt/unit/host/observer/producer IDs,
commit/round, invocation and source-file ledger digests, CPU set, memory maximum,
CPU quota, boot ID, unit cgroup path, exclusive-unit observation, and
network-policy/toolchain/configuration digests. Those settings alone are not OS proof.
`client-heavy-trusted-observation/v1` repeats that identity and actual isolation,
binds the final subject, complete file ledger, unioned configuration names and
toolchain/configuration/network digests, records start/end epoch clocks and the
observed producer exit (2 for a locally successful run). The observer is distinct
from the producer. The trusted toolchain/configuration digest covers actual
compiler, linker, wrappers, sysroot/dynamic libraries, launchers, caches and user
configuration seen inside the unit, not merely version strings. The controller
retains the observation's underlying receipts and checks the source manifest
against its binding. Names-only environment evidence is not that review.

Independent source/build review is a separate
`client-heavy-independent-build-review/v1` receipt, bound to the exact final
subject/source/toolchain/configuration and its own receipt digest. Its reviewer
must differ from producer and observer. A null review remains blocked. The author
does not create an independent review or an observation by setting these fields;
unit-test objects are explicitly synthetic and never persisted as approvals.
Exact required fields are enforced in `admission.mjs`; all digests of structured
values use SHA-256 of `JSON.stringify(value, null, 2) + "\n"` in the verifier's
returned order. Context and observation are attempt-scoped, not global booleans.

`hostProof` is the separate worker-owned live OS observation described in
[HOST-PROOF.md](HOST-PROOF.md). `verifyHostProof(replay, context, hostProof)` in
`host-proof.mjs` composes raw process/cgroup observations with the replay's exact
execution and per-pass windows, executable digests and artifact subject. It can
also check resources for a valid failed attempt without admitting that attempt.
A null OS proof blocks admission; CPU/memory budgets, source hashes, an empty
error list and before/after host manifests cannot substitute for it. The producer
does not author this proof or claim this workstation supplied an isolated unit.

The composed report is `client-heavy-admission/v1`, status `admitted`, `blocked`
or `invalid`. Only a verified replay plus the external matching observation and
independent review sets `admitted`/`readyForLoad` true and isolation `trusted-unit`.
Ranking eligibility remains false: a functional attempt is not a performance
ranking. This module does not launch a campaign, authorize operators or provision
resources. Campaign/controller code remains outside this adapter's ownership.

Focused checks (synthetic tests are not native measurement evidence):

```sh
node --test bench/client-heavy/replay-v2.test.mjs
node --test --test-concurrency=1 bench/client-heavy/verify-v2.test.mjs
```

## Saved Evidence (Legacy v1)

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

Historical `client-heavy-native/v1` does not save a source-bound invocation/plan and
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
