# Bound isolated execution contracts

The offline contract covers the exact nine official registry groups. The separate local
isolated-host worker executes and collects only catalog-page, JSON API and localized
marketplace. Neither layer allocates/deletes a host, inspects provider credentials, calls a
provider, publishes results or alters nightly work. Popular-choice and performance views
share these same native executions and raw evidence; they are not extra runs.

The bounded [single-host campaign entry](CAMPAIGN.md) owns one live reservation across the
fixed nine-group sequence, retains six not-run groups and supports JSON build/audit-wait/
no-rebuild timing in the historical three-group checkpoint. The current campaign executes
all nine fixed native entries, awaits the reviewed saved APIs and composes actual core
OS observations; missing native proof remains blocked, not skipped or fabricated. Read
CAMPAIGN.md for the required delegated-unit layout and remaining integration dependencies.
This does not make an unreviewed or incompletely integrated checkout campaign-ready.

The binding evaluates the committed latest-stable policy against its exact saved manifest
and lockfile bytes. Offline replay recomputes that result rather than trusting a saved flag.
A blocked or invalid dependency target prevents comparison eligibility for that group,
without filtering contenders, suppressing native failures or cancelling the campaign.
Native replay and cleanup can still complete; the policy status remains beside the results.
An unrelated target's `not-applicable` status does not replace any native qualification gate.

## Use

Run from a clean, committed checkout containing this module:

```sh
node --test bench/workloads/isolated/contract.test.mjs
node --test bench/workloads/isolated/process.test.mjs bench/workloads/isolated/evidence.test.mjs bench/workloads/isolated/worker.test.mjs
node --test bench/workloads/isolated/source-identity.test.mjs
```

The module API accepts an explicit full current commit. Obtain it through the integrating
caller's existing source-verification path, not from an untrusted artifact. For example:

```js
import { bindExecution, validateBinding } from "./bench/workloads/isolated/contract.mjs";

const binding = bindExecution({
  group: "catalog-page", round: "c2", commit: measuredCommit,
  recipe: "native-defaults", review: null,
});
const checked = validateBinding(JSON.parse(JSON.stringify(binding)));
// checked.binding === "verified-offline"
// checked.ready === false; checked.executionAuthorized === false
```

There is no command-line execution interface. The only subprocesses used by `contract.mjs`
are fixed read-only Git queries. No API accepts an executable, shell command, flags,
contender/case filter, image substitution, environment map, receipt path or output directory.
Native invocations, preparation fixture commands, artifact roots and report invocations are
derived, never interpolated from caller-provided command fragments.

## Identity

`captureSources` requires the full current HEAD, the same HEAD the module loaded, and an
entirely clean checkout including untracked files. The contract itself must be committed.
Nonempty legacy contender/tier/edge/profile selectors are refused before any binding.
It hashes the actual committed Git blob bytes for the fixed source boundary: root manifests
and instructions, docs, bench, crates, scripts and the card-market example. Runtime/build
inputs and locks within that boundary are retained, including native app Dockerfiles and
the contract/tests. Historical results, evidence, work directories and dependency/target
outputs are excluded. Source links and submodules are refused. Git bytes avoid CRLF-dependent
cross-platform fingerprints; local changes are checked before and after hashing.
Every contract Git query explicitly disables replacement objects and lazy fetching, even if
the parent environment requests replacement behavior. Native child environments retain those
same restrictions. Replacement refs can otherwise make an original blob name yield different
bytes, including when matching working changes are hidden by assume-unchanged. The regression
uses a private clone, never replacement refs in the shared repository/worktree.

The binding freezes the measured SHA, all source hashes, official registry definition and
selection hash, exact contenders/cases, retained families, native arguments, effective
options, intended c-8 host description, resource expectations and strict validation state.
`validateBinding` rereads the actual current committed source and reconstructs everything.
Changing fields and computing a new caller-side hash cannot bypass that comparison.
Legacy client-heavy/live CLI snapshots additionally pin their default-defining source
files. When the reviewed native client v2 pure parser is present, both defaults and effective
settings come from that parser instead. There is no numeric CLI fallback for that v2 parser.
A present parser that cannot load fails closed; its dependencies are never silently ignored.

This verifies integrity against local committed source, not who approved that source or
whether it is merged upstream. Git history/ref freshness, independent parity review, real
image/build provenance and effective deployment remain separate requirements.

## Native recipes

`native-defaults` is supported for every group. Fresh builds and required output/review
references are explicit operational options, separate from timing/workload defaults.
The module records the actual parser defaults where dependency-free native parsers exist.
It does not replace any native admission gate or default profile.

| Group | Round and fixed preparation | Native defaults and retained evidence |
|---|---|---|
| Catalog page | `cN`, excluding historical `c1`; catalog fixtures; `--build --group catalog-page` | Three passes, 60 s phases, 30 s warmup, rate 150. Both-source page and JSON/browser gates precede page-only timing. Entire `bench/catalog/results/<round>` and strict commit-bound report. |
| JSON API | `jN`; both fixtures; `--build --group json-api` | Same 60/30/150 defaults. All 36 functional cells plus independent exact-image native-source audits. Receipt staging is blocked here, not invented or waived. Entire results tree and strict commit-bound report. |
| Localized marketplace | `wN` or native official `rN` starting at r17; marketplace fixtures; `--build --group localized-marketplace` | Native defaults are 60/30/150, not the separate short-window cloud profile. Exact-image production/browser gates; preserve excluded/stopped outcomes. Native report has no strict-completeness flag; collection must separately check complete selected coverage. |
| Mixed production | `wN --build`; runner generates fixture | Default functional-only profile, seed 42, two clients, one repetition. Measurement defaults remain three passes, 120 s windows, 15 s warmup, 30 s calibration, 120 s tail, 16 cycles. Raw captures, readbacks, faults and measurement tree stay separate. No standalone validator yet. |
| Full-stack browser | `wN --build --out bench/fullstack-browser/work/<round>` | All ten apps and 240 profiles, native desktop/mobile settings. Host Chromium, local Node tool image and free SvelteKit loopback port 8080 required. Native lifecycle/aggregation gaps and absent standalone validator remain blocked. |
| Client-heavy | Safe explicit round; `--out bench/client-heavy/work/<round>` | Always builds all six native bundles and runs Corten's Rust generator; no `--build` flag, receipt substitution or Cargo override. Sizes 14/110/7/24. Separate qualification/measurement, `result.json`, raw captures and `native/`. No standalone validator or OS isolation. |
| Live delivery | Safe explicit round; `--group live-delivery --build` | Preserve the group flag to avoid historical mode. Default bounded correctness: 24 events, queue 2/history 4, no measurement. Corten is incompatible with that profile; missing registrations remain visible. Entire `bench/live/results/parity/<round>` and shared verifier. |
| Recoverable live | Safe explicit round; `--build` | Same bounded defaults, six recovery scenarios. Entire `bench/recoverable-live/results/<round>` and shared verifier. Missing registrations and Corten's default-profile incompatibility are blockers, not substituted transports. |
| Hardening | `wN --build --review <exact-subject-hash>` | Existing bounded profile and matched native production adapters, all 216 cells. Direct/edge qualification stays separate. The required review-reference string alone establishes no approval. Entire results tree, raw controls/receipts and native verifier. |

Four named override recipes exist: `marketplace-short-window` (three passes,
15 s phases/10 s warmup/rate 150), `mixed-measure` (adds measurement without changing the
default native profile/settings), `mixed-production-measure` (the separately reviewed
production procedure adds measurement and the native matched profile), and `native-feed-measure` for either live group
(native-feed for every candidate, 1,044 events, queue 1,024/history 1,025, then the native
1/2/4-browser measurement levels). No arbitrary numeric tuning, caller-selected profile,
sustained attack override or alternative deployment selection is accepted.

`reviewSubject(request)` returns the exact source/registry/round/recipe subject hash.
A review declaration has schema `benchmark-isolated-review/v1`, that `subjectSha256`,
a named `reviewer`, and `decision: "approved"`. It is mechanically checked for this exact
subject and retained as `declared-not-authenticated`, never independent-review proof.
Missing declarations remain unknown; even a matching declaration cannot authorize execution.
Requested overrides are always separate from recorded native defaults.

## Resources and validation

The intended host copies the existing catalog c-8/sfo2/Ubuntu contract; allocation and
isolation remain unobserved. Timed HTTP roles retain native 1/2/4 CPU quotas and explicitly
record intended app/upstream/load pinning `1`/`2-3`/`4-7` using each native environment prefix.
Those settings are expectations, not observed environment or native defaults. Mixed
functional capture has separate 1/2/2 CPU app/upstream/capture budgets; only its explicit
measurement recipe requests the measured CPU placement. Its qualification worker has 1 GiB;
the steady-load worker has 2 GiB and 512 MiB shared memory. Host drivers/checkers remain
unisolated. Browser/live/client-heavy and hardening cannot borrow the HTTP pinning adapter.
Hardening keeps its declared complete direct/edge process budgets, not one normalized server.

Every contract keeps native evidence unknown, validators not run or explicitly missing,
coverage cells unknown/not-run, `ready:false` and `executionAuthorized:false`.
Complete flags, verifier exit zero, source presence, matching declarations and self-consistent
hashes cannot promote those states. Failed, unsupported, stopped and not-run outcomes must
stay visible; unavailable measurements must never become numeric zero.

`validateArtifactPaths(binding, paths)` validates the exact native round namespace,
required entry files and safe non-colliding path segments. It reads no artifact files and
does not establish existence, file type, hashes, native correctness or collection safety.
The **entire** native output tree is required later, not only its summary. Standalone native
report/replay commands are recorded where they exist, including their actual supported flags.
Mixed/browser/client-heavy need separate complete validators before a collector can qualify them.

## Checkpoint boundary

`createWorker({ authorize })` in `worker.mjs` is an in-process API for a separately prepared,
fresh Linux host with Node 24+, at least eight available CPUs and the dependencies above.
`worker.run(binding, { stateRoot, signal })` requires an existing private, physical state root
outside/disjoint from the checkout. Native round roots and commands still come only from the
validated binding. It runs the fixed fixture preparations and exact native invocation,
stopping on the first unsuccessful process. It never runs a report against the unchecked
producer tree. Fixed in-process validators read only the safely collected snapshot after all
type/link/path checks and before/after manifest comparisons. It installs scoped
SIGINT/SIGTERM forwarding and accepts an AbortSignal; it never accepts shell/command/flag,
environment, contender, receipt or evidence-root overrides.

`authorize(subject)` must explicitly return boolean true for the exact binding digest,
commit/group/round, canonical state root and observed local host subject. The callback is trusted caller policy,
not authenticated by this module. It must independently establish permission, merged-source
parity review and fresh-host suitability. There is no permissive default. An unsigned
`review` declaration, receipt string or `executionAuthorized` field cannot grant authority.
Calling this API is permission to build/run the selected native workload, not just preview it.
The implementation tests replace native/tool spawns; they do not run benchmark timing.

Before authorization, after it yields, before each native command and after execution, the
worker revalidates the actual committed binding and every working-source file's bytes. This
also detects changes hidden from Git status by assume-unchanged/skip-worktree. The only allowed
text conversion is Git's CRLF-to-LF checkout convention; binary inputs remain byte-exact.
The worker freezes its own binding copy before yielding. Child environments contain only
fixed system PATH, HOME, locale/timezone, Git source-integrity restrictions and the bound CPU-placement keys, not inherited
NODE_OPTIONS, selection/profile tuning, alternate Docker endpoints or provider credentials.

An exclusive, fsynced `.host-attempt.json` reserves that state root before any native spawn.
Attempt identity, binding, command intents/PIDs/exits and collection records are write-once,
hashed and fsynced. One reservation blocks other rounds/groups; crashes and failures do not
unlock it. The integrating controller must designate one state root per isolated host.
There is deliberately no automatic unlock, resume-by-receipt, relaunch or cleanup/delete API.
Only an opaque attempt handle owned by that live worker can collect or verify evidence;
serialized metadata and arbitrary PIDs confer no authority. Restart recovery stays blocked
pending a separate owned-terminal reconciliation contract.

`process.mjs` reuses the existing native dispatcher bootstrap rather than rewriting native
cleanup. Readiness is bounded at 30 s, execution at 36 h, cooperative shutdown at 120 s and
forced-exit observation at 5 s. Only the spawned Linux process group with its leader still
observed live may be force-killed; an exited leader's stale PID cannot authorize a kill.
`bootstrap.mjs` adds a 120 s IPC-loss/cancellation watchdog that survives supervisor death.
Forced/aborted/IPC-error/log-error outcomes cannot become success even with exit zero.
An absent observed close remains uncertain and cannot be collected. The native runner owns
Docker cleanup; force-exit does not establish Docker cleanup or release the host reservation.

For observed-terminal owned attempts, the collector exclusively creates `native/` and copies
the **entire** native result tree, including raw failures and empty directories. It refuses
symlinks/junctions, hardlinks, special files, escapes, unsafe names, case collisions, overlaps
and overwrites; source/copy hashes are compared before/after copying and native validation.
Regular files are checked through open descriptors for replacement/mutation. Originals and
partial copies are never deleted. The directory manifest and command-log hashes are durable;
`worker.verify(handle)` rechecks records, logs, originals and the collected tree. A missing
output after failed preparation is explicitly failed evidence, not an empty passing result.
This is an owner-exclusive-directory boundary, not protection against an adversarial same-user
process racing filesystem operations. Uncertain ownership or mutation requires inspection.
No archive is extracted or transported in this slice; future archive sealing must preserve
this manifest and the catalog controller's transport/terminal/ownership safety gates.

Validation reuses catalog's `validateCollected`/`inspectCatalog` strict gate, JSON's actual
`inspectJson(summary, { load: reader(root), commit })` raw replay, and marketplace's
`validateSummary`. All additionally require the bound round/commit, exact effective options
and CPU configuration. Marketplace retains every selected candidate's admitted/excluded
outcome and native stopped/failed-request measurements, not a false all-apps-success label.
Catalog/marketplace native report success is diagnostic only: those APIs consume summaries.
The isolated adapter derives required raw paths from the current native capture layouts:
each selected build/check/qualification and every attempted cold/warmup/load pass, including
k6 output, CPU counters, stats logs/samples and app logs. Present JSON observations are checked
against saved checks, qualification and cold results; k6 fields and resource sample aggregates
are rederived where the native files permit. Missing paths remain explicit; contradictory
present artifacts fail inspection. Legitimate excluded/stopped target outcomes remain visible.
This diagnostic replay does not recover missing HTTP/browser response captures, actual-runtime
source/image binding, stopped-process observations or positive owned cleanup. A complete file
inventory, fabricated matching raw files or aggregate flags cannot supply those proofs.
Consequently catalog and marketplace always retain `qualification:"blocked"` and
`rawCompleteness:"not-established"` until a separately reviewed complete native producer/
validator handoff exists. Their diagnostic summary can say baseline/eligible while the
collection is blocked; it is never `native-validated`. Source/image audits are not manufactured.

JSON's bound default command supplies no independent audit receipts. It will preserve its
failed qualification evidence and must not begin timing without those native gates passing.
This slice deliberately does not add receipt staging, fabricate auditors or change its
invocation; a future reviewed source/image-bound handoff is still needed for a JSON baseline.

The collection outcome is `native-validated`, `blocked` or `failed`, independent of process exit.
`blocked` retains successful process exits and diagnostics without claiming native qualification;
it is not permission to advance a comparative baseline. JSON remains the only integrated
hash-bound raw replay path that can produce `native-validated`, and its required independent
audit receipts are not staged by this worker. `preserved-uncertain` retains unsafe/incomplete
collection without attempting a report on unchecked evidence.
Once a process or validation fails, re-collection cannot promote it. A matching native report
does not erase a failed exit or cleanup. Binding coverage remains unknown/not-run rather than
being synthesized from aggregate flags. `controllerReady:false`, host isolation unverified
and unresolved review/resource blockers remain explicit even for native-validated evidence.
The other six groups return not-run with their original coverage and blockers, without
authorization, reservation, preparation or native execution. This is not a nine-group
controller or proof that any real benchmark passed.

## Proposed validator handoff

Native owners work outside `isolated/**`. Client-heavy is separately assigned
`bench/client-heavy/verify.mjs::validateSaved({ folder, round, commit })`; mixed is separately
assigned `bench/mixed-production/verify.mjs`, with its API finalized by that owner. Do not add
duplicate validators or require those owners to edit this directory. For the other groups,
a possible seam is `complete.mjs` and `complete.test.mjs` under `bench/fullstack-browser`,
`bench/live`, `bench/recoverable-live` and `bench/hardening`. No isolated-directory changes or
worker registration are part of those assignments. Proposed common semantics:

```js
export async function validateComplete(root, expected) {
  // Read/replay native evidence; throw on incomplete or contradictory requested work.
  // Return { report: nativeReport, coverage: existingRegistryCoverage } only after replay.
}
```

`root` is the physical collected native tree. `expected` is frozen data with `group`, `round`,
`commit`, `selection`, `options`, `settings`, `resources` and `sources`, directly from the
bound request/selection/effective invocation/resources/source manifest. It is not an authority
receipt. The export must be offline/read-only, contain every followed artifact, require exact
identity and configuration, and replay raw observations, source/image provenance and cleanup.
Use `bench/workloads/evidence.mjs::coverage` instead of introducing another ledger schema;
derive every selected cell explicitly, retain native failed/stopped/unsupported/not-run
outcomes, and never invent zero measurements. A partial report may accompany a thrown error;
saved success flags or a self-consistent hash alone cannot establish completion.

Mixed must distinguish functional-only captures from explicitly requested production
qualification/calibration/windows. Browser must replay all 240 cells and lifecycle evidence;
the current summary qualification aggregation bug remains a native-owner blocker, not a
validator waiver. Client-heavy must bind all six actual native builds plus separate raw
qualification, measured journeys and cleanup. Live/recovery can reuse asynchronous
`bench/live/verify.mjs::verifyRound`, but strict wrappers additionally require the expected
full inventory, empty `missing`/`unqualified`, matching plan provenance/configuration and
complete replay for the requested mode. Hardening reuses `verify(folder)` with expected
provenance/options and complete raw creation/removal, resource and matrix replay. A
complete observed target failure remains failed; it does not require groupReady:true or
every competitor to pass. A printed summary alone is never a completeness gate.

The legacy single-group worker retains its original three-group scope. The separate campaign
entry now dispatches all nine fixed entries and awaits fixed adapter/native APIs; see
CAMPAIGN.md for the actual handoff, mixed/JSON audit waits and external OS observations.
Native source/validator repairs still require their own review and parent integration.
Diagnostic replay success or a `blocked` verifier result
cannot qualify a native run; retain that report and its missing invocation/source/build/timing/
cleanup proof as blockers. There is no validator plugin registry or caller-injected success
callback. Missing ports, isolation adapters, source-audit receipts or raw observations must
remain blockers.

Only this new directory is changed. Existing check-script integration, guide/changelog edits,
repository-wide checks and independent review belong to the integrating parent; this bounded
task does not authorize editing those paths or spawning a reviewer.

## Review repairs

Independent review of immutable worker 991e3f490 requested changes for Git replacement-object
binding, summary-only catalog/marketplace qualification, and running a report before safe
collection. That review's pinned suite reported 38 passed / 1 failed: the validation probe
was terminated by its 540000 ms child watchdog (549364 ms observed). The earlier author's
39-pass result does not clear that independent failure. The repair splits the fake worker
validation/unsafe/unsupported probes without increasing that watchdog, test timeout, native
deadline or any qualification gate. Fresh independent review remains required.
