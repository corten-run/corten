# Bounded single-host campaign entry

This checkpoint implements local host ownership, sequencing and collection, not cloud
allocation or an official campaign readiness claim. It retains all nine registry groups.
All nine fixed native entries now execute sequentially. Awaitable fixed saved APIs replay
their safely collected native trees; missing modules/proof remain blocked rather than
skipping an entire group. Actual source/OS integration is not inferred from synthetic
adapter tests. No benchmark timing was measured to test this code. Independent review,
merged native producers/validators and the explicit unit preparation below remain required.

## Parent interface

```sh
node bench/workloads/isolated/campaign-entry.mjs r17 --commit FULL_40_LOWERCASE_SHA --state-dir /bench/campaign
```

The argument order and root are fixed. No selection, recipe, command, validator, image,
environment, output-path, retry or resume argument is accepted. The parent provisions a
private, same-UID `/bench/campaign` outside a clean checkout, a Linux host with Node 24+,
at least eight available CPUs, Docker and the actual native build/browser dependencies.
The parent separately establishes c-8 identity, authorized operator launch, unit/cgroup
ownership and exclusive fresh-host use. This code does not authenticate a cloud size or
prove host exclusivity from a receipt. The trusted parent launching this fixed CLI is the
operator-authorization boundary, not the offline contract's executionAuthorized:false.

`createCampaign({authorize})` has `begin(plan,{stateRoot,signal})`,
`advance(handle,{signal})`, `submitJsonAudit(handle,delivery)`, `submitMixedAudit(handle,delivery)`, `stop(handle,reason)`,
`status(handle)`, `verify(handle)` and `collect(handle)`. `begin` accepts only a frozen
recomputed `bindCampaign({round,commit})` plan, reserves `.host-attempt.json` exclusively
and returns an opaque live-process handle. The API also requires the fixed root. Callers
must supply an authorization policy, not a review JSON field. Serialized handles do not
work. A second instance, round, restart or completed attempt cannot acquire that root.
No lock release, native-directory deletion, automatic cleanup or retry API exists.

The CLI owns the handle throughout sequential advancement, including audit waiting.
SIGINT/SIGTERM cancels the owned native command using the existing IPC supervisor and
bounded shutdown; the bootstrap retains its parent-loss watchdog. An uncertain terminal
or cleanup boundary halts further work. The parent must allow that shutdown before its
own unit-wide terminal observation. It must not infer terminal ownership from these files.

Exit 0 means complete all-nine intrinsic replay, not external approval or a successful
comparative baseline. Complete, safely collected failed/blocked evidence exits 1. Uncertain
lifecycle/collection, interrupted review or an invalid replay exits 2 and preserves state.
No result file authorizes host deletion. The parent records its own unit terminal state, run.log,
host.txt and exit-code, and verifies an archive before any owned-resource deletion.

## Rounds and recipes

Campaign rN maps to catalog cN, JSON prepare j(2N), JSON timing j(2N+1), marketplace rN,
mixed/browser/client/hardening wN and live/recoverable rN. N is 17..1000000000. Existing
native output for any reserved round prevents launch; there is no semantic retry.

`campaign-contract.mjs` retains the complete registry and hashes the actual nine source
procedure files alongside all measured sources. The production map uses native defaults
except the existing marketplace-short-window, explicit native-feed-measure for both live
groups and new mixed-production-measure. Mixed adds --measure --profile matched as the
native README specifies. The older mixed-measure remains the default-profile recipe,
unchanged. Numeric defaults come from native parsers, not new CLI constants. Browser,
client and hardening retain their declared native bounded production procedures; this is
not a claim that their measurements or proof are available. All need merged-source review.

## Durable evidence

Execution version 3 adds a second independent review wait before mixed native execution.
Status keeps JSON auditSubjectSha256 unchanged and adds mixedAuditSubjectSha256 and
auditGroup (json-api or mixed-production while waiting). auditInbox names the fixed
corresponding private inbox. The CLI holds its original opaque handle throughout both
waits; there is no saved-handle resume, lock release, review-driven restart or native retry.

Mixed writes mixed-audit-subject.json and mixed-audit-sources/{blobs/**,contexts/*.tar}.
Unlike executable-source bindings, Corten's mixed native context includes every tracked
Git file. Core captures that full committed closure and the exact native tar convention:
commit archive for Corten, fixed epoch tree archive for each other selected app. Git
replacement objects and lazy fetch are disabled. Saved replay compares retained bytes
to actual committed blobs/archives; rehashing a manifest or subject cannot replace them.
This subject is explicitly pre-build source/context review, NOT a built-image/OS claim.

The trusted parent delivers mixed-audit-delivery.json (private same-UID regular file) with
schema benchmark-mixed-audit-delivery/v1, subjectSha256, review and bundle. review has
reviewer, reviewedAt, subjectSha256, findings:[] and decision:approved. bundle has schema
mixed-native-source-audits/v1 and exactly one ordered native receipt per selected app.
Each receipt binds the exact requested identity, complete sourceFiles, traceContext and
the existing JSON native-source guarantees. These fields never authorize themselves:
submitMixedAudit separately requires authorize(action:stage-mixed-audit) for that exact
subject, delivery digest and review. The CLI's trust boundary is parent-controlled inbox
transport, not an archive declaration of human authority.

The retained delivery, mixed-native-audits.json and mixed source/context subject are
committed by mixed-review-needed and mixed-audit-staged journal events. Only then does
the operational mixedPhase append --native-audits /bench/campaign/<owned-id>/mixed-native-audits.json.
The declarative registry binding still records nativeAudits:null; no selector, caller
path or tuning override is introduced. After collection, the native raw validator and
core both bind actual built image IDs/source labels, context bytes and retained native
receipts to this accepted bundle. Missing proof stays incomplete; a different valid audit
cannot replace the accepted one. Async validateCampaign replays these same commitments.

`.host-attempt.json` identifies `<rN>-<16hex>/`, containing `plan.json`, append-only
`00000-kind.json` events (each includes benchmark-isolated-campaign-status/v1), full
command logs, host observations and `<index>-<group>-<phase>/native/**` copies plus native
manifests. Every known journal/log is hash-checked. Events expose active,
blocked-review-needed, finished or preserved-uncertain; finished means sequenced, not ready.
`campaign-result.json` is written once at exhaustion or an observable halt and retains all
nine outcomes. Attempted work at an uncertain halt is preserved-uncertain, not not-run.
`collection-manifest.json` is written after verified finished collection; its manifest
does not recursively include itself. Native originals are separately retained until copy
and manifest verification; this API never deletes either tree. A parent archiver must
validate the entire physical campaign root, including any retained failed partial tree.

Safe collection rejects symlinks/junctions, hardlinks, special files, escapes, collisions,
overwrites and mutation. Only a collected snapshot reaches a native report. Apparatus failure
cannot become success from a report flag. A correctly observed framework failure may be a
complete native attempt: its app outcome stays failed and comparisonEligible stays false.
For example, native client v2 intentionally exits 2 after a positive diagnostic capture;
that exact source-defined exit is distinguished from cancellation, a fixture error or an
unknown nonzero exit. No validator injection or selected-app filtering is permitted.

Status includes uncollectedNativeRoots. A terminal command's entire native tree is copied
even when subsequent host cleanup/source observations fail. If terminal ownership or safe
copy cannot be established, the original root remains explicitly uncollected: the parent
must retain the host for inspection/terminal-safe collection, not delete it merely because
the campaign logs or partial archive were saved.

Host observations retain boot/host, CPU/memory/pressure/cgroup information, PID start
identities and Docker container/network boundaries before/after each group. A new persistent
process/container/network or changed host halts sequencing. These conservative observations
are not a resource peak measurement, an independent quiet-host audit, or proof of isolation.
Actual native CPU quotas/cpusets must still pass the fixed native saved-evidence gate.

## Kernel lifetime observations

The parent-owned service must put its wrapper/worker in a supervisor leaf under its exact
`corten-bench-groups-rN-<16hex>.service` cgroup, with cpu/cpuset/memory accounting delegated
and enabled on the empty service root. A compatible systemd layout uses
`Delegate=cpu cpuset memory pids` and `DelegateSubgroup=supervisor`; the parent must verify
that layout on its actual systemd/kernel. Core does not change parent controllers, quotas,
cpusets or memory budgets and never moves the wrapper or an unrelated process. It fails
closed when delegation/accounting is absent. This is not an approved new finite client
budget or mandatory isolated CPU partition.

The fixed cloud bootstrap prepares Node 26, both root and bench/browser npm lockfile
installations, Playwright Chromium, the native runner's digest-pinned Node tool image,
and the ordinary Rust generator toolchain. Native commands keep a sanitized fixed PATH
including /root/.cargo/bin; inherited PATH, NODE_OPTIONS and credentials are not forwarded.
No native build, fixture size, load schedule or CPU/memory budget is changed by preparation.

The unit delegates cpu/cpuset/memory/pids and requests DelegateSubgroup=supervisor.
Its wrapper verifies the actual leaf, empty service root and enabled controllers before
provisioning. On older systemd without DelegateSubgroup, the same source-bound bootstrap
may exclusively create that leaf and move only its sole wrapper PID. Existing foreign
members, a pre-existing leaf in that fallback, wrong unit or missing controllers fail closed.

Before each bootstrap receives its IPC start message, core exclusively creates a fresh
command child cgroup, moves only that newly spawned PID into it, and records actual boot,
inherited ancestor controls and empty recursive membership. Kernel inheritance/accounting
contains and charges ordinary native descendants, including short-lived children between
samples. Native Docker containers are daemon-owned and are not claimed to belong to that
child: fixed native replay must independently prove their IDs, roles, limits and cleanup.
An unobserved escape or resource/identity gap cannot be cleared by a manifest or requested
budget. Parent live source/unit/host ownership remains the trust boundary of these records.

Core samples recursive cgroup files and live PID/start/executable identities at 100 ms.
It retains raw initial process observations content-addressed under processes/, references
the independently re-read identities in each sample, and records raw CPU accounting,
memory current/peak/events and effective controls. No environment or arbitrary command-line
values are retained; only known Chromium process-type flags are extracted. A 256 MiB
per-command observation bound fails closed, never silently truncates evidence. Observations
are incomplete if any retained sample gap exceeds one second; the IPC
setup deadline remains active until both the bootstrap and observer are ready. Raw
initial/final populated=0 and empty recursive membership must agree with terminal flags.
Observations add driver work; they are not a claim of zero observer overhead or a benchmark
timing result. Source-bound observation code is part of the campaign's evidence conditions.

The fresh IPC-gated bootstrap's real executable is hashed before the initial empty-scope
sample. Attachment rechecks the executable identity/cache key; slow startup hashing does
not consume an unobserved interval between samples. The one-second gap gate is unchanged.
The Linux fixture delays that real read to test ordering, without replacing kernel data.

Each phase contains `command-N-host/{binding.json,samples.jsonl,terminal.json,processes/**}`.
The journal commits each command observation tree; phase-sealed additionally commits the
whole phase's host/native/log tree, including halted phases. JSON prepare images.json is
appended afterward and committed separately by the exact audit subject. Finish requires
positive empty cgroup observations and unchanged inherited controls, not process exit alone.
Only the live-created empty child cgroup is removed; uncertain children remain for the
parent's owned-unit terminal handling. No recursive cgroup cleanup or saved-handle adoption
exists.

Every command, including fixture preparation, replays its sealed lifetime observations
before another command may start. A successful leader exit cannot clear a nonempty or
unproven command scope. The API halts with the original pending native root retained;
it does not fabricate a terminal/failed exit or collect potentially active producer bytes.
A drained cancellation may collect only with positive accounting, terminal, empty-scope,
observer and leader checks, and still halts without qualification. Saved replay rejects
sequencing or group completion past missing/blocked command observations.

Every sampled command cgroup must retain parseable cpu.max, cpuset.cpus.effective and
memory.max in addition to accounting. Missing controls remain blocked; malformed controls
are invalid. Unlimited max is valid, finite caps are not invented, and an effective CPU
set must be a nonempty ordered set of CPU IDs/ranges. Ancestor controls remain separately
bound and unchanged; absent root-only controller files do not become command defaults.

The opt-in local OS fixture is `host-lifetime-linux.test.mjs`. In an already owned
delegated unit it launches real Node processes only, verifies actual accounting/empty
terminal state, and exercises SIGTERM, native finally and descendant exit. Cancellation
remains blocked even when positive cleanup is observed. It never runs benchmark timing.
`test-fixtures/linux-lifetime-unit.sh` executes cloud-contract.mjs::supervisorBootstrap for an
explicitly created local test unit on older systemd without DelegateSubgroup. It moves
only its own shell PID and enables delegated accounting, without changing any budgets.
The caller must use a fresh `corten-bench-groups-r999999999-<16hex>.service`, Delegate
cpu/cpuset/memory/pids, Restart=no and KillMode=control-group. The fixture takes an
absolute Linux Node path and checkout path; it is not a campaign launcher or provider API.

For client v2, core binds observed Node/browser executable bytes and live compiler/renderer
samples to the native report's exact execution/process windows, subject and native tree.
Inherited host limits are reported as observed, not replaced by fabricated finite caps.
Missing live window proof remains blocked. For Docker-backed groups, native resource and
semantic cleanup replay composes with the actual core host-child lifetime/boundary; native
code need not redundantly claim the same external host fact.

`host-lifetime-linux.test.mjs` runs a real gated Node child and kernel collector only when
already inside this explicitly prepared delegated test-unit layout. On other hosts it
skips with that reason. It does not create a service or run a benchmark.

## Awaitable intrinsic API

`await validateCampaign({folder,round,commit})` from campaign-verify.mjs accepts the extracted
campaign root. Historical three-group archives remain readable but cannot become all-nine
completion. Current status events carry executionVersion:3 (version 2 remains readable). Every group must have its fixed
ordered command lifecycle, native/host seals and replayed app outcomes; not-run groups,
pending roots, invalid apparatus or unproven resource/cleanup gates prevent verified.

The success schema is benchmark-isolated-campaign-inspection/v1, scope intrinsic-evidence,
status verified, exact round/commit/campaign/campaignSha256/sourceSha256, the cloud registry
selection shape, ordered groups, collectionIntegrity manifest-verified, commandLifecycle
observed-terminal, empty uncollectedNativeRoots and blockers, archiveTreeSha256 and
reservationSha256. Each group has group/outcome native-validated/bindingSha256/
nativeManifestSha256 plus ordered appOutcomes entries {app,outcome,comparisonEligible}.
Failed/unsupported apps remain comparison-ineligible. It has no qualified/controllerReady/
deletion approval claim. The live controller separately establishes operator authorization,
approved merged source, provider/unit ownership and exact unchanged archive-tree binding.

Native dispatcher imports are fixed: catalog verify.mjs validateSaved, JSON strict
inspectJson/inspectEvidence, marketplace validate.mjs validateSaved (returns the replayed
summary, not a status envelope), and the six fixed isolated adapters' inspectSaved. No
caller supplies a verifier. Native assertions/diagnostics are reduced to fixed public codes.
The current imported browser/client and live/recovery adapters still report genuine producer
gaps. Mixed/hardening adapters and reviewed native proofs must be routed by their owners;
their absence is not silently replaced by a summary-only pass. Full actual all-nine
execution, renewed source/build audits and dependency proofs have not been performed by
this checkpoint. The local delegated-Linux fixture exercises actual collector lifetimes,
not a complete campaign or provider ownership.

## JSON build, audit wait, then timing

JSON first runs the actual full native --build --check-only round. Exit 1 is accepted for
staging only if all 36 raw functional cells replay, image/CPU/source/commit configuration
matches, cleanup is clean, no timing occurred and exactly the missing independent audits
explain the failures. Anything else is a retained failed preparation, not an invented audit.
Actual Docker image inspect records for all 18 built IDs and canonical bound source bytes
are retained. Source names (including native `[id]` and `+page` route names) are mapped
to regular content-addressed `audit-sources/blobs/<sha256>` files by the source manifest;
they are not unsafe archive path names. Environment values are not forwarded from Docker image configuration.
`json-audit-subject.json` binds those images, 36 identities, source/commit and both native
and source manifests. It explicitly has qualified:false and a review-needed blocker.

While the process stays alive, the authorized parent/operator may deliver exactly
`<campaign-id>/json-audit-delivery.json`, at most 16 MiB, regular/no-hardlink, same UID and
mode 0600. Stage the complete file outside the campaign root, then atomically rename it
into that one private inbox. Partial/invalid/wrong-subject delivery halts, never retries.
The fixed audit deadline is 24 hours; expiry or cancellation retains partial evidence.
No whole-host deletion is appropriate while state is blocked-review-needed.

```json
{
  "schema": "benchmark-json-audit-delivery/v1",
  "subjectSha256": "EXACT_json-audit-subject_SHA256",
  "review": {
    "reviewer": "actual independent reviewer",
    "reviewedAt": "2026-11-12T12:00:00Z",
    "subjectSha256": "EXACT_json-audit-subject_SHA256",
    "findings": [],
    "decision": "approved"
  },
  "bundle": { "schema": "json-api-native-audits/v1", "receipts": [] }
}
```

The bundle must contain all 36 real existing json-api-native-audit/v1 receipts, with exact
current image/CPU/source/commit identities and audited adapter source files. The empty
array above only illustrates the envelope, and is rejected. Operator-authorized transport
and actual independent review are separate trust boundaries, journaled explicitly. The
unsigned JSON cannot authenticate a human or make itself authoritative; the parent must
obtain the real review. No new signing/approval service is required or implied.

After acceptance the same handle stages `json-native-audits.json`, rechecks sources,
original/copy hashes and actual built image IDs, then runs timing with --receipts and
without --build in the paired fresh round. The native runner repeats its real checks and
requires all 36 audits before timing. Images are checked again after timing. Accepted
inbox bytes and review records are sealed; no serialized receipt resumes a crashed job.

## Remaining handoffs

Current fixed-adapter integration composes mixed's actual
`mixed-native-saved-verification/v1` and `mixed-native-saved-proof/v1` results. A native
`failed` verdict is contradictory replay, not a target loss. Only a complete, source/resource/
cleanup-closed attempt can retain native `target-failed` gates as observed app failures;
qualification/calibration/steady gates keep their native dispositions and do not require
timing after a functional failure. The operational audit path is exactly the staged inbox
bundle path; the adapter cannot supply a validator, select apps or change native settings.
Mixed comparison eligibility additionally requires membership in the fixed adapter's
`comparisonEligibleApps`, derived from native timing replay. A healthy functional app
does not gain comparative metrics when another app gated the group's timing. Missing
eligibility cannot grant comparison; complete observed failures still finish the attempt.

Live and recovery still replay every native scenario/fanout through the fixed verifier.
Standalone native folders cannot establish cleanup. In a current campaign phase, the adapter
also replays the adjacent fixed command's kernel observations and before/after host boundary.
It checks the exact binding/invocation, campaign/phase/command, boot and time window, native
manifest, positive terminal empty scope, observed browser renderer, inherited controls and
empty Docker container boundaries. Core's phase/journal seals bind these retained bytes;
the live controller separately establishes their execution origin and exclusive ownership.
This composes actual host cleanup instead of requiring the native app to assert it again.
An error-only failure with no retained target HTTP/control observation is incomplete, even
when its host process cleaned up. Startup failures without source proof remain blocked.

The complete client source closure comes from native `contract.mjs::sourceRoots`, including
tracked historical `bench/browser/results/**` bytes. These files are inputs to the native
snapshot, not the current output and not evidence granting approval. The ordinary exclusion
of unrelated result trees remains; untracked/dirty inputs and source substitutions fail closed.

Cloud bootstrap uses the upstream stable Git Ubuntu PPA documented at
https://git-scm.com/install/linux and records an actual
`git --no-replace-objects --no-lazy-fetch --version` capability check before cloning. The
immutable native flags are not removed for older distribution Git. Node/browser/Cargo and
delegated supervisor preparation are unchanged. Local replay tests do not claim that a fresh
cloud host or a complete native campaign has been executed.

The read-only collector API is `campaign-verify.mjs::validateCampaign({folder,round,commit})`.
`folder` is the saved campaign root containing `.host-attempt.json`, not the ID subdirectory.
It rejects unsafe whole trees, foreign root members, wrong identity/binding, missing groups,
altered manifests, inconsistent journals and failed-command promotion. It replays the fixed
fixed native snapshot gates where present, never a caller-provided validation summary.
Status is invalid for unsafe/contradictory evidence; failed for retained incomplete native
failed process/outcome; otherwise blocked unless all nine intrinsic gates complete. Verified
is reachable with complete replay, including structurally complete observed app failures
that remain comparison-ineligible. Deterministic composition tests exercise that path;
they do not prove actual native integration. Nonverified results retain `qualified:false`
and `deletionAuthorized:false`; intrinsic success carries neither approval field.
`collectionIntegrity:manifest-verified` is
only a saved-byte integrity check, not native qualification or human approval. A halt with
no final collection manifest is unsealed-partial, never called a verified collection.
`uncollectedNativeRoots` must be empty before the parent considers any terminal-safe cleanup.
`campaign-contract.mjs::validateCampaign(plan)` is a different, offline plan rebind API.

Review repair: cancellation observed in any phase (including a drained zero exit after
cancellation or forced shutdown) now latches preserved-uncertain in the API itself. A later
advance without the original signal cannot run another group. Already drained native
evidence is still collected before that terminal state is recorded.

Saved journal replay requires initial authorization/start records, each fixed ordered
phase and command intent/start/exit, the JSON preparation/review transition and every
ordered group outcome. A successful fixture cannot replace its required native command.
Rehashed manifests cannot repair missing lifecycles or native snapshots. A synchronous
spawn exception may have no start only with an explicit failed exit/code-null record.
A halted open/nonterminal command must retain its uncollected root and is reported as
commandLifecycle:incomplete-preserved and collectionIntegrity:unsealed-partial, even if a
caller rehashes a collection manifest. None of this authenticates saved human approval.

Public errors use fixed codes (saved-campaign-invalid and
native-evidence-invalid-or-incomplete). Native diagnostic reports expose only bounded
qualification/baseline states, not assertion messages, JSON fragments, warnings or config
values from the archive. Original failed/native evidence remains retained for inspection.

Saved replay cross-checks native snapshot hashes against the group-finished journal,
final outcomes and every repeated status seal, including the separate failed JSON
preparation manifest. Rehashing adjacent native/collection manifests cannot replace
those commitments. JSON review replay reconstructs the subject from sealed preparation,
retained image observations and exact committed source blobs, checks the review-needed
subject hash, and matches the staged journal delivery digest/review to the retained
delivery, native receipt bundle and optional transport inbox. Native receipt validation
is reused against that source snapshot. These are consistency checks, not authentication
of a human or a replacement for the separate trusted parent authorization policy.

Every safely collected phase now emits phase-sealed with its group, phase, native
artifact root and native tree hash, before a cancellation or source/cleanup boundary
error can halt the campaign. Saved replay requires a journal commitment for every
collected native manifest, even without group-finished. Historical completed phases may
use their group-finished seal; successful preparation may use its reconstructed review
subject. Historical halted snapshots without any such commitment are invalid, not
manifest-verified. An unsafe/incomplete copy retains its pending root and remains an
unsealed partial, never a complete collection.

JSON timing also replays every present native-audit reference against the exact accepted
receipt and identity and the retained content-addressed source bytes. A different but
independently valid receipt/source pair cannot replace the staged audit. Missing failed
cells remain incomplete; they are not invented or qualified. The live worker applies the
same check after safe phase collection, and saved replay checks it again independently.

The following producer dependencies were read but are not imported or cleared by this
core checkpoint. Raw replay is not independent source/build or host ownership approval.

1. Client v2 at 700bbc8f: fixed awaitable validateSaved API, native execution/process windows
   and executable identities. Its owner reports an actual complete six-app replay. This
   core adds external kernel collection/composition, not an approval of that capture.
2. Mixed at 288d10fc/bdde4986/0c69b66c/d490de6b: async validateSaved returns verdict and derived measurement/
   proof, not a boolean. Source/tool/dependency/raw/cgroup/failure proof repairs remain
   producer-owned. The pending fixed adapter consumes that complete proof without filters.
   Core now stages the independently reviewed audit bundle using the fixed handoff below.
   Native 288d10fc's deterministic app-context archive convention must be merged before
   this handoff can bind an actual build. Old tree-object archives use the wall clock and
   cannot be substituted for the reviewed context. No native code is imported here.
3. Live and recovery adapters at 8e54ab4ec are imported unchanged. Their fixed verifyRound
   API binds full native-feed inventory and scenario provenance. The existing producer
   still omits retained build/invocation/startup-failure binding and positive terminal
   receipts; these require producer evidence or an explicit reviewed composition, not
   removal of the workload or a requirement that every framework pass.
4. Hardening owner at d077428d/4d7aee1e reports actual Docker apparatus proof and unchanged nested
   verify(folder).proof API, but not a complete framework campaign. Its adapter/native
   chain must be routed separately. Core consumes verified native Docker resource/cleanup
   proof plus actual host-child observations, never an unsigned review-reference approval.
5. Browser adapter at 831de1cf is imported unchanged. Native b3597261f still reports genuine
   source/whole-terminal/capture gaps; its fixed validator must establish semantic browser
   closure separately from core OS exit. All 240 selected native cells remain required.
6. Catalog/marketplace raw validators are fixed imports, pending parent integration and
   current producer review. Catalog's positive-only baseline replay cannot yet classify a
   complete negative framework attempt. JSON retains its original strict report and exact
   accepted-audit binding: no negative attempt is promoted merely to make that baseline
   pass. Failure-aware raw completeness must be native-derived before such attempts qualify.

The parent owns provider lifecycle, remote transport, unit ownership, archive validation,
reviewed merge, guide/changelog integration and broader repository checks outside this
directory. No provider, credentials, publication or nightly code changes are included.

Focused deterministic tests use Node's test-only module mocks, never production plugin
callbacks or real benchmark processes:

```sh
node --experimental-test-module-mocks --test --test-concurrency=1 bench/workloads/isolated/campaign-contract.test.mjs bench/workloads/isolated/campaign-entry.test.mjs bench/workloads/isolated/campaign.test.mjs bench/workloads/isolated/json-staging.test.mjs bench/workloads/isolated/host-observation.test.mjs
```

Run binding tests in a clean committed checkout. Source/procedure hashes are real. Mocked
campaign/adapter records are explicitly synthetic, IPC tests launch real fixture processes,
and the delegated-Linux test collects actual kernel observations when its prerequisites
are present. None of those checks measures benchmark timing or authenticates a human review.
Mixed source/context tests retain a byte-pinned verbatim native archive-helper fixture from
288d10fc to avoid depending on an unmerged Git object in a fresh checkout. Build-only
dependencies throw if used. Production imports only the actual fixed native module and
fails closed until that API is merged; the fixture is not a native build/replay approval.
