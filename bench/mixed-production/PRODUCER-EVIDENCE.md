# Saved producer evidence extension

This additive producer/replay extension uses fixed-name sidecars without weakening
the independent audit contract, inventory, native capabilities or group procedure.
Historical captures lacking the evidence remain blocked. A complete rejecting
native gate may be verified as recorded failure, never as target success or rank.
The separate verifier-repair checkpoint remains immutable for its own review.

## Execution Lifecycle

`execution/manifest.json` (`mixed-native-execution/v1`) binds round, original
run ID, native source commit, exact producer helper hashes and ordered immutable
event references. `execution/events/00000.json` and subsequent sequence numbers
use `mixed-native-execution-event/v1`. The producer records actual Docker create
acknowledgements, name-to-ID inventories, container/image inspections, terminal
inspection, ID-addressed removal acknowledgements, and post-removal inventories.
It seals only after final run-label container, network, image and volume queries.
Missing or failed commands remain fixed-code events; raw exception strings,
credentials and creation argument lists are not serialized.

Participant observations retain actual image ID, restart count, OS process state,
CPU quota/cpuset and memory configuration, network namespace, command hashes and
mount destinations/modes. Only public source/profile/browser-path environment
values are permitted. Other environment values are omitted. Unrecognized values
of permitted keys are hashed, not disclosed. Images are inspected by immutable ID.
The expected functional, qualification, load and cgroup-reader limits and commands
are derived from the fixed native contract, not accepted from requested limits.
An unhealthy target's actual terminal state, including exit 137 or restarts,
remains visible. Observed limits and successful cleanup do not imply target health.

Container removal addresses the inspected original full ID and uses `rm -f -v`.
That ID is retained from the create acknowledgement, never re-resolved from a
reused container name. A terminal inspection may observe the original container's
renamed name, but must still match its original ID and ownership. Cleanup is one
idempotent protocol per participant; replay rejects duplicate or reordered
initial/terminal observations, removal attempts and post-removal observations.
Replay requires its acknowledgement and a subsequent empty ID inventory. Observed
anonymous volume names require terminal absence too. Network removal binds its
original ID, ownership and post-removal absence. Cleanup retains
the create acknowledgement's original network ID even when the name has been
reused. An absent original network cannot authorize deleting its replacement.
Native image cleanup retains the owned tag/image inspection, actual Docker
acknowledgement and tag absence.
Final inventories are OS responses, not a collector-written success flag. Unknown
event variants, contradictory identities/configuration, duplicates and reordered
terminal protocols are invalid; missing observations remain blocked.

`validateSaved({folder,round,commit})` and its fixed read-only CLI are unchanged.
The additive `proof` uses `mixed-native-saved-proof/v1`, `resources`, `sources`,
`sourceFiles`, `cleanupComplete` and fixed-code `blockers`. Its lifecycle module
is imported only after exact committed-source checks. Missing participant coverage
blocks resource proof. Any invalid evidence clears positive proof fields.
Historical v1 artifacts have blocked resources/sources and false cleanup, never
an inferred positive. Extended proof also requires the input/response evidence below
and independent exact-source audits. An adapter must honor all native blockers;
positive lifecycle observations alone cannot admit any group.

Functional and measurement workers now mount the retained native Git archive,
not mutable checkout source. All producer Git binding queries, including build
context creation and measurement checks, run through the offline immutable-Git
child: replacements and lazy fetching disabled, protocols denied, prompts/optional
locks disabled, inherited Git overrides removed. No Git object fetching is allowed.

The prebuild audit and the later Docker build share
`nativeBuildArchiveArgs(commit, app, {output} = {})` from `build-context.mjs`.
It returns fixed Git arguments, optionally writing to `output`; omit that option
to retain stdout bytes. App/prefix tree archives explicitly use
`--mtime=1970-01-01T00:00:00Z`, because Git otherwise uses the collection wall clock
for tree objects. Corten's whole-commit archive keeps its existing immutable commit
timestamp convention. Neither context is regenerated from a mutable checkout.
Consumers still use the offline immutable-Git environment; this pure argument
builder does not change Git transport/replacement policy or approve any audit.

## Mounted Inputs And Responses

`execution/inputs.json` (`mixed-native-execution-inputs/v1`) binds the exact commit,
root lockfile, host executable/JSON input inventory, and inspected mount-source
hashes. Three Linux worker dependencies (`@playwright/test`, `playwright`,
`playwright-core`) are extracted only from locally cached original npm archives
whose SHA-512 integrity matches that lockfile. No install or network fetch runs.
Archives, every extracted file and its hash remain under `execution/`; replay
rejects missing, extra, linked, escaped, colliding or modified package files.
`execution/inputs-final.json` observes the actual host inputs again after collection.
Actual source/dependency mounts are read-only and must match their saved input roots.
Mount-source hashing uses producer POSIX Docker syntax, including Docker Desktop
drive-prefix normalization, not the replay machine's path separator convention.

Native functional/load HTTP observations use `mixed-native-response-source/v1`.
Only exact public record/state JSON bytes that pass the fixed public-shape filter
are retained as base64 and checked against the original response hash/length.
Both functional and load capture apply that same public-shape filter before
exposing any normalized JSON record to serialization. Unknown JSON remains only
response hash/length and a fixed extraction diagnostic, not body content. Missing
filtered record/state proof remains blocked with its observed outcome; malformed
present proof or a mismatch with retained normalized facts is invalid.
`response-sources/<sha256>.json` stores deduplicated `mixed-native-dom-reads/v1`
transcripts collected from the actual browser-parsed response. The trusted current
snapshot executes against the observed DOM queries/properties/styles during replay;
no saved code or expected markup executes. Extra/missing reads or normalized facts
that disagree are invalid. Native form evidence contains actual public field names,
method, content type and local path, never hidden values, cookies or URL credentials.
The discovery hash and actual found/absent branch remain bound to its HTTP receipt.

The trust boundary is the exact pinned collector plus independent source audit,
not a cryptographic assertion about discarded secret-bearing response bytes.
Credential-bearing query strings/hidden values are not serialized. A required DOM
read containing a discovered credential blocks evidence instead of inventing a
replacement fact. Credential-bearing form-action authorities are refused before
appending a DOM read, not stripped into a valid action.
DOM `getAttribute` results are filtered by the actual attribute name. Public DOM
and JSON image URLs permit HTTP(S) URLs without userinfo or fragments. Nonempty
queries are accepted only on same-origin marketplace page links for the three
contract locales and fixture item IDs 1 through 500: `seller` is empty or `A`
(the fixed mixed plan's fixture prefix), `sort` is `asc` or `desc`, and `offers`
is `all`, without duplicate keys. A familiar key never authorizes arbitrary
values. Image URLs have no public query-value contract, so all nonempty image
queries are refused. Unknown nonempty queries block extraction, not sanitized
positive facts. Native opaque form-action queries remain transport-only, including
when their keys resemble public page queries. A credential-filter rejection emits
no normalized page or redacted HTML, and never stores the rejected URL in DOM reads.
Missing DOM reads for an observed normalized page stay blocked with that page's
original outcome; present malformed or contradictory proof is invalid.
Unknown JSON shapes do not gain source proof. No response hash alone proves a
positive normalized page, record, state or production capability.

## CPU and participants

Qualification/window participant IDs, images and original process start times must
also match the lifecycle journal's corresponding stage/role. A replacement ID is
invalid; an actual later restart or terminal unhealthy state blocks admission.
All saved measurement references use POSIX separators on every producer host.
Qualification rejection before the CPU reader is created does not attempt its
cleanup. Reader cleanup is enabled only after the original creation and inspection
complete; real cleanup failures still reject admission. Rejected qualifications
and their unexecuted calibration/pass slots remain visible.

Functional capture workers must actually finish with OS exit 0; qualification
workers must finish with exit 0 for eligibility or exit 1 for their replayed
rejecting gate. Exit 137, unfinished collectors, injector restarts and terminal
apparatus failures remain blocked, even if response files exist. An app's actual
unhealthy terminal state is retained under `apps[app].execution[source]`, with its
derived health and per-cell failure reason; it is not converted to missing proof.
Successful HTTP statuses with missing extraction transcripts/public JSON remain
blocked rather than becoming complete target-failure evidence. Arbitrary malformed
JSON/error bodies are not retained to work around credential filtering.

Each calibration/steady directory retains `cpu-before.json` and `cpu-after.json`
with schema `mixed-native-cpu-boundary/v1`, `phase`, `participantIds` keyed by
`app`, `upstream`, `load`, collection timestamps, original command stdout in `raw`,
and `failure` (null or `cgroup-command-failed`). Both commands address the original
full container IDs, never names resolved into replacement participants. The after
participant inspection must still match the original ID and start time.

`cpuBoundary` writes the response before parsing/admission. `replayCpuBoundary`
requires exactly three unique expected IDs, exactly one numeric value per ID, no
duplicate JSON keys, nonnegative safe integers and valid collection clocks. The
existing receipt's role counters come only from this replay. Missing, malformed,
fractional, unsafe, extra or duplicate counters are not repaired or synthesized.
Command failure retains a null response and fixed reason, not exception text.
Replay limits CPU stdout to 16 KiB. Decreasing counters remain rejected by the
unchanged window derivation, rather than being clamped.

`participant-before-<role>.json`, `participant-after-<role>.json`, and qualification's
`participant-qualification-<role>.json` use `mixed-native-participant-boundary/v1`.
Fields are `role`, actual `id`, `imageId`, `startedAt`, `restartCount`, `running`,
`oomKilled` and `paused`. No environment or Docker error string enters this sidecar.
It is written before asserting image/state/restart admission, so a restart, OOM,
unexpected pause or missing restart count stays visible. It does not grant admission.
Inspection failure still leaves the existing failed-stage artifact and missing proof.

`measurement/producer-provenance.json` uses `mixed-native-producer-evidence/v1`
and binds the harness commit and SHA-256 of both new helpers, the original cgroup
reader, marketplace qualifier/feature contract, and fullstack conformance/probe/hold
modules (keys are repository-relative paths). Existing provenance continues binding the modified
measurement/qualification callers. Extended replay checks these against the exact
Git source and rederives every CPU boundary instead of trusting receipt scalars.

The mixed stats sampler retains `stats.log.process.json`
(`mixed-native-stats-client/v1`): actual host PID, spawn/stop/close times, exclusive
OS exit-code/signal, raw log hash and fixed failures. Sampling begins before the
window and stop follows its finish; actual child closure is awaited. Malformed or
unavailable Docker samples remain failures, not zero CPU or discarded rows.

## Qualification and credentials

The existing fixed qualification-worker CLI still takes its settings JSON path.
It calls unchanged marketplace `qualify`/`validateQualification` on original native
probe answers in memory. It additionally writes adjacent
`qualification-evidence.json` (`mixed-native-qualification-evidence/v1`). Identity
is `app`, `source`, `imageId`, `nativeProfile`. An ordered `events` journal is saved
before/after each actual probe, retaining input/response hashes and filtered numeric,
status, timing and contract-relevant response-header facts. Request bodies, request
headers, discovered action URLs and raw page bodies are never serialized. A killed
worker leaves `qualification-in-progress`; execution/filter failures retain fixed
reasons and all preceding safe events. No arbitrary exception text is saved.

On completion, the sidecar also contains `qualification`, `rawProbeSha256`, original
per-probe hashes, and `pageProjection` (original page hash and retained byte spans).
The saved `qualification` is replayed through the unchanged current contract and
must have exactly the original profile, source, cells, missing features and eligibility.
Negative/unsupported features are retained, not turned into success. This is not an
independent source audit or proof that arbitrary native code behaves correctly.
The exact completed initial page/JSON unhealthy-response prefix can independently
replay a rejecting qualification gate. Transport, filtering and interrupted probes
do not become that target-failure variant.

Filtering is deliberately restrictive and fails closed:

1. Cookies, authorization, ETag and arbitrary headers are omitted. Header values
   used by the contract must match explicit finite/structured allowlists. Unexpected
   cache directives, CSP directives/hosts, policy values and error strings block
   replayable evidence instead of becoming permissive placeholders.
2. CSP nonce/hash payloads are masked without changing directive/token classes.
   `serverfnerror` retains only its observed presence, the sole fact the contract
   reads. These transformations must preserve every current feature cell exactly.
3. The actual UTF-8 identity page is blanked byte-for-byte except original form
   opening/closing syntax, recognized method attributes and native scripted-form
   markers. No expected form or markup is generated. Text, script, fields, attribute
   values, action URLs and credentials disappear. Retained spans contain original
   source bytes at original offsets; length and the actual native form branch must
   remain unchanged. Page input is bounded to 12 MiB base64 and 128 matched forms.
4. The projection proves only facts the current qualification contract consumes.
   It does not reconstruct original form fields or attest to discarded content.
   Original hashes bind collector input but cannot independently recover redacted
   bytes. A future contract reading more HTML/header facts requires a new reviewed
   projection and must block these old receipts, not infer the missing facts.

The explicit trust boundary remains collection by the pinned harness plus the
separately required independent exact-source audit. No positive audit receipts,
blanket capability flags, CPU estimates or native-cap waivers are generated here.
Unknown filter syntax can make an otherwise healthy app's evidence unsupported;
that is an explicit blocked-proof limitation, not a reason to omit that candidate.

## Focused checks

`node --test bench/mixed-production/producer-evidence.test.mjs`

`node --test bench/mixed-production/execution-evidence.test.mjs`

`node --test bench/mixed-production/execution-inputs.test.mjs bench/mixed-production/response-evidence.test.mjs bench/mixed-production/stats.test.mjs`

`MIXED_NATIVE_CLOSURE_TESTS=1 node --test --test-name-pattern="complete native HTTP failure evidence" bench/mixed-production/verify.test.mjs`

The last check needs the locked packages already in a local cache and installed
Chromium. It exercises all nine saved candidates with actual local HTTP failures,
but explicitly synthetic lifecycle/audit vectors. It is not native framework parity
or an independent audit. Missing audit and modified dependency regressions must
still block/reject. `MIXED_RESOURCE_OS_PROBE=1` with a fresh absolute directory in
`MIXED_RESOURCE_OS_OUTPUT` runs a separate bounded actual cgroup/restart/stats OS
probe using an already cached Node image, then records removal/absence of all four
owned labelled containers. Neither check builds or officially runs a group.

Tests use real temporary files, synthetic qualification transport vectors and one
actual native HTTP probe subprocess against a local unhealthy test server. They
exercise replay, mutation, missing/duplicate/malformed counters, restart/OOM/pause
failures, credential-bearing bodies/headers/errors, failed features, interrupted
probe outcomes and the fixed worker CLI. They are not native parity, calibration,
capacity or full-group measurements. No official group run is launched here.

The lifecycle tests use real temporary files and hostile recomputed references,
including mutated caps, image/command/network/source contradictions, malformed
state, missing limits/finalization, failed queries, unknown failed variants,
duplicate references and blob replacements in an isolated Git repository. The
opt-in `MIXED_EXECUTION_OS_PROBE=1` test also requires a fresh absolute output
directory in `MIXED_EXECUTION_OS_OUTPUT` and an already cached Node tool image.
It launches only a bounded labelled OS-observer container/network, retains actual
receipts and `observer-replay.json`, and removes its owned Docker resources. It
does not build or qualify a framework, pull an image, or claim benchmark admission.
