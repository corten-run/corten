# Grouped cloud controller checkpoint

Row 7 checkpoint, not official-run readiness. Expected USD is unknown; no price or
runtime estimate is supplied. No real-account provider operation, allocation, deletion, restart,
publication, schedule change or shared-state mutation was performed for this slice.

**Current status:** the credential-owning worker-snapshot implementation has fresh
independent exact-head security review with no remaining scoped findings. The
controller executes the verified bootstrap bytes, not a second read of its mutable
entry path; credential consumption and provider HTTPS stay inside the clean worker.
The earlier credential, diagnostic, executable-closure and shutdown failures are
retained under Historical Evidence And Proposals below, not current review blockers.
This scoped clearance is not overall readiness or cloud-action approval. Merged CI,
official-source qualification and complete native producer/OS/validator closure
remain pending; the mixed-inbox/inspection bridge does not waive those gates.

The controller is `droplet.mjs`, separate from catalog, marketplace, the dispatcher,
registry, parity and runners. It imports the existing read-only `cloud-contract.mjs`
for the complete nine-group selection, c-8/sfo2/Ubuntu identity, fixed remote files,
systemd unit and archive namespace. There are no adapter, provider, workload,
deployment, environment or numeric-settings CLI overrides. Popular/performance
views share evidence; they do not launch a second campaign.

## Dedicated Group Hosts

A fleet binds the complete current registry to one dedicated host per group. The
hosts run in parallel; contenders and phases within a group retain their native
ordering, CPU budgets, correctness checks and measurement settings. A group host
builds and runs only its group's complete selection, not a filtered list of apps.
Popular and performance views still share the same measurements.

`cloud-contract.mjs::fleetPlan` fixes the round, measured source, account/context,
SSH key, host configuration and a unique ownership token for every registry group.
The full roster and selection are hashed before launch. A host reservation retains
that complete roster but has the distinct `benchmark-dedicated-group-host/v1`
schema and exactly one group's selection. Legacy all-group reservations remain
readable and cannot acquire group-selection fields after reservation.

The per-host production launch adds `--group GROUP --fleet ABSOLUTE_PLAN_JSON`.
Both fields are required together, only at detach, and the approval binds the exact
plan file bytes. Collection and source-audit delivery use the saved host identity;
they cannot change the group. An audit for another group's host is refused.
The existing account, source, process-settlement and ownership gates remain
mandatory independently for every host. No create or start is replayed after an
ambiguous result. A saved create intent can reconcile its one exact name/tag
allocation for recovery, never as proof that create completed or permission to
provision it.

`fleet.mjs` is the complete-registry operator entry. Its root is a fresh physical
directory outside the checkout, separate from legacy reservations. Preparation
uses only local Git and exclusively saves `fleet-ROUND.json`; it neither allocates
a host nor authorizes execution:

```sh
node bench/workloads/fleet.mjs ROUND --fleet-root ABSOLUTE_ROOT --prepare --commit SHA --ssh-key KEY --account-id ACCOUNT --context CONTEXT
node bench/workloads/fleet.mjs ROUND --fleet-root ABSOLUTE_ROOT --detach --print-approval
node bench/workloads/fleet.mjs ROUND --fleet-root ABSOLUTE_ROOT --detach --approve-reviewed-merged-ready REVIEWED_EXACT_HASH
```

Preparation returns 3 with a saved roster. A preview cannot execute: independently
review its exact source, physical root, complete roster and every contained child
subject before supplying the batch approval. Source review and merged native
readiness remain prerequisites; never automatically feed a preview into execution.
The launch intent is durable before any child starts and prevents a second launch,
including after partial failure. Each child has an independent state directory,
operation lock, private credential worker and remote systemd unit.

Admission is staged, not a simultaneous fleet allocation. The first required
registry group must reach bound running state and emit the exact source-bound
common-bootstrap marker after its tooling setup. Only then are the remaining
required hosts admitted serially. Remote benchmark jobs overlap; their contenders,
profiles and measurement parameters are unchanged. The marker precedes native
entry and proves neither feature parity nor a group's performance evidence.
Its observation is bounded to 45 minutes, checks cancellation and preserves the
running host on timeout or an invalid observation. A failed admission or
cancellation leaves every later group visibly `not-admitted`, not silently omitted
or automatically retried. The complete reserved roster remains mandatory.
Later groups must also be observed nonterminal before running admission is saved.
A job already terminal at that observation remains in its saved `starting` state
for ordinary collection, rather than admitting another host from a false running
claim. This does not discard a fast completed job's evidence or permit a restart.

Each production controller runs on a separate worker event loop. Worker entry and
dependency modules execute captured, hash-checked source bytes with a deny-unlisted
loader. Batch approval binds that executable closure and the admission policy.
Collection remains independent and concurrent across saved hosts. The parent
propagates cancellation to children and keeps its lock until every worker exits;
uncertainty retains the lock. It never terminates a possibly mutating child merely
to make a timeout look clean.

Failed worker results and fleet receipts retain only the existing allowlisted
`providerDiagnostic` code and optional HTTP status or code-specific finite detail,
plus an explicit `uncertain`
boolean for a reported operation failure. Raw errors, stacks, command arguments
and credential material are never forwarded. Malformed worker messages still
mean control uncertainty. Diagnostics do not prove host absence, acknowledge a
mutation, permit a retry or authorize cleanup; saved reservations, launch intents
and the existing settlement/lock rules remain authoritative.

Create-link refusals distinguish three consumed-field predicates:
`create-link-shape` (actions is not an array), `create-link-count` (not exactly one
entry) and `create-link-id` (missing or invalid positive safe-integer ID).
Only a failing predicate emits its subcode; deadline/cancellation checkpoints keep
their coarse phase codes, including `create-link`. Historical `create-link-rel`
and `create-link-href` diagnostics remain readable but are no longer emitted:
the create response is an ID projection, not a full validator of unused metadata.
No rejected provider values are retained or forwarded, and old diagnostics do not
establish the cause of an unretained response.

Failures inside the production composition also retain one closed `controllerStage`
code: `source-plan`, `exact-approval`, `remote-main-advertisement`,
`remote-main-fetch`, `remote-main-ancestry`, `source-recheck`,
`controller-construction`, `controller-launch`, `controller-collect`,
`controller-audit`, `controller-checkpoint` or `provider-settlement`.
The stage identifies the failing operation, not its cause or whether a host exists.
Only an own data property from that vocabulary crosses the worker boundary;
unknown values and accessors are not forwarded. It adds no retry, cleanup or
launch authority. Raw Git errors, URLs, arguments and stderr remain private.

Historical href diagnostics could classify a refused representation as
`non-string`, `malformed-uri`, `credentials-or-fragment`, `foreign-origin`,
`semantically-same-canonical-uri`, `query-or-trailing-slash` or
`wrong-action-or-resource`. These are a closed vocabulary, never the rejected URL,
query, IDs or response. A classification does not make that representation valid.
Count refusals similarly retain only `total-changed` or
`terminal-count-mismatch`. Historical failures without these observations remain
unexplained; a synthetic reproduction does not establish their cause.

Create completion consumes only the positive safe-integer droplet ID and unique
positive safe-integer action ID from the bounded JSON response. Advisory `rel` and
`href` values are not read, parsed, followed, logged or forwarded. Ignoring unused
metadata does not declare it schema-conformant: a malformed URI is still malformed.
It also grants no authority. Requests use only the fixed HTTPS origin and a
canonical action path constructed from the numeric ID. The authoritative action
response must match that ID, type `create`, resource type `droplet`, and, when
completed, the POST's exact droplet ID. Pending null/zero resource IDs never prove
completion; even a matching completed response must be observed before the original
absolute deadline, otherwise control uncertainty is retained. Before any provisioning
SSH, the controller explicitly joins this
completed-action/POST host ID to the freshly observed owned reservation host ID.
Wrong IDs, account, ownership, action status, timeout and cancellation still fail
closed without repeating POST. No optional hint can select another host or route.

Collection reuses only saved identities and independently collects terminal hosts:

```sh
node bench/workloads/fleet.mjs ROUND --fleet-root ABSOLUTE_ROOT --collect --print-approval
node bench/workloads/fleet.mjs ROUND --fleet-root ABSOLUTE_ROOT --collect --approve-reviewed-merged-ready REVIEWED_EXACT_HASH
node bench/workloads/fleet-verify.mjs ROUND --fleet-root ABSOLUTE_ROOT --commit SHA
```

Missing, ambiguous or locked child state stays visible and never triggers another
launch. Both successful and failed native inspections must match the host's exact
reserved selection before campaign cleanup. Batch receipts are diagnostics, not proof.
The read-only fleet verifier replays every saved native archive, rechecks its
immutable hashes and confirmed cleanup, and requires unique host identities for
the entire roster. Its intrinsic `verified` status is not publication approval:
`publishableBaseline` remains false until the separate review/results workflow
qualifies and merges the evidence. Preparation/preview return 3; execution returns
0 for all collected verified groups, 1 for terminal incomplete evidence, 3 while
groups remain pending and 2 for control errors. No code means full-round readiness.

A launch census permits only the exact names, ownership tags, sizes and regions
of reserved siblings. An unrelated benchmark host still blocks allocation. The
account must have room for the entire remaining roster, not just the next host.
Sibling membership is not permission to collect, stop or delete that sibling.

An HTTP-successful census with a changed total between pages or a final count
mismatch may be discarded and read again from page 1 after a paced observation
delay of up to one second. Only a new complete census can be returned: no rows,
IDs or totals carry over. All observations share the original absolute command
deadline and cancellation checks, at most 100 GETs in total, 200 rows per page and
a total of at most 20,000. Malformed IDs, metadata or next links fail before this
narrow count-change classification. An HTTP or request error, cancellation or
exhausted deadline/request budget refuses. This is not an
HTTP/network retry or permission to repeat POST/DELETE, replay an old operation,
relax identity/absence checks or infer the cause of a historical failure.

Census predicate refusals use the closed `list-response-` suffixes `shape`
(droplet array), `total` (nonnegative safe-integer metadata), `id`, `duplicate`,
`links`, `pages`, `next` (fixed-origin URL, path and exact next-page parameters),
`count` (count inconsistency after the bounded convergence window), and `bounds` (row, total, page or
shared request ceiling). They expose no rejected values or counts. The code is
attached only at the failed predicate; intervening deadline and cancellation
faults retain their coarse phase code. These diagnostics neither identify the
historical failed response nor make an incomplete census valid. Concurrent
allocations between complete single-page responses do not alone cause a count
refusal; disagreement within a response or between pages is a separate condition.

After identity binding, host checks use fixed-origin `GET /v2/droplets/<saved-id>`
instead of another account-wide census before every SSH/SCP call. Successful
responses must bind that ID and still pass exact name, ownership tags, host size,
region and public-IP checks. Only an explicit HTTP 404 establishes absence;
authorization, rate-limit, network, timeout and malformed-response errors never do.
Account/context checks still surround provider commands. Initial allocation and
unbound recovery require a complete census.

## Failed Allocation Retirement

A known semantic create refusal is returned as failure without poisoning a settled
credential worker. Recovery can then reconcile the unique allocation under its
durable create intent. Even if identity is found, provisioning cannot begin without
the exact completed create-action proof. A timed-out or unsettled mutation remains
uncertain, retains locks and cannot take this recovery shortcut.

Ordinary `--collect` supports a separate unused-host retirement path only from
the pre-start `preparing` state. A bounded read-only host probe must confirm exact
metadata ID, an inactive never-started unit without a restart policy or pending
job, completed cloud-init without user data, no benchmark process or container
runtime, and no benchmark data. `/bench` may be absent or contain only the exact
hashed uploaded control files and an empty log. Ambiguous files, partial data,
unreadable observations or any attempted start refuse this path.

Both retirement probes recognize only their own exact fixed `timeout` parent,
binding its PID, executable and full argv before and after scanning other
processes. Other wrappers and processes receive no exception.

The controller preserves `unused-host.json` with the exact probe hash, bound host,
source and fresh observation window before recording a deletion intent. It issues
at most one DELETE and requires exact-ID 404 confirmation. Later collection only
rechecks the immutable receipt and absence; a lost acknowledgement never repeats
DELETE. The saved status is `retired`, not `collected`, and carries no native archive,
validation, timings or successful result. Fleet inspection reports `unused-retired`
or `cleanup-pending`, never a verified baseline.

An interrupted receipt write before deletion intent is not a permanent recovery
dead end. Collection verifies and retains the exact previous receipt under its
content hash, then requires a new fresh host probe before writing the current
receipt and intent. It never overwrites unknown evidence, treats an old observation
as current permission or repeats a saved deletion intent.

If the common setup itself ran and failed before native entry, collection first
preserves the immutable terminal archive and its raw nonzero exit. A separate
pre-entry packaging check uses only the base image's Python and GNU tools, not
the Node installation or source clone that setup may have failed to create.
It permits only bounded regular metadata and an absent or empty campaign root;
native packaging keeps its existing full-tree validation. A separate
`setup-failed` retirement requires both an absent or empty local campaign root and
a fresh host proof: exact terminal started unit, no native campaign data, only an
absent or exact common-bootstrap marker, exact uploaded controls, matching exit, no running containers or
benchmark processes and no pending jobs. The saved `failed-setup-host.json` binds
the archive and extracted-tree hashes. No native validator result, timings or
successful exit is invented. Unsettled validation, any entry evidence, failed
observations or a running unit preserves the host. Fleet output reports
`setup-failed-retired`; repeat collection checks the same receipt and absence,
without another DELETE. Native-started jobs retain the existing native collection
and evidence gates. Neither retirement path can delete a running benchmark.

The common-bootstrap marker precedes native entry. It is not native evidence or
a reason to strand a terminal host whose entry failed before writing any data.
Setup retirement permits only that exact source-bound marker, preserving an
already-recorded bootstrap observation. A foreign, malformed, symlinked or
missing previously observed marker refuses, as does any native campaign data.

### Failed Native Custody And Retirement

`--retire-failed-native` is a separate, deliberately approved recovery action,
not a relaxation of `--collect` or native validation. Its migration policy supports
only round r21 measured at `9f3d35884c67d90524f978d173fabeb3a17bc970`, for the
eight nonmixed group reservations with preserved
original archives/extractions and raw exit `2`. A different, clean repair-controller
commit must descend from that source and pass the existing fresh merged-main
proof. Preview and exact approval bind both source identities, exact reservation
bytes, original evidence hashes, physical state root and fixed custody roots.
This exception does not permit a source override for collection, audit or launch.

### Cancelled Mixed Wait

The sole additional migration is the exact r21/9f mixed review wait described by
`cloud-cancellation.mjs:mixedWait`. `--cancel-mixed-wait` is an exclusive action of
the existing `cloud-production.mjs` CLI, not an audit option. Its local
`--print-approval` binds the clean repair-controller commit, physical state root,
exact reservation bytes, original account/context, host ID/IP, token/tag/unit,
campaign/plan/subject, original journal event and unchanged original deadline
`2026-11-16T23:57:08.811Z`. The operator's reason is retirement of the old
unpublishable attempt while preserving all evidence, **not** a claim that seven
source guarantees failed. Failed/unsupported rows can be legitimate native outcomes.
No delivery, receipt, source qualification, successful collection or readiness is
fabricated. The original measured source and all workload parameters remain fixed.

After independent review, exact CI and merge, a separate explicit operator approval
uses `--approve-reviewed-merged-ready` with that exact preview hash. This is not
authorization provided by tests, this documentation or an unattended readiness
flip. Production repeats its merged-main, loaded-source and locked-state checks;
saved-context account/exact-ID/account and native known-hosts checks precede SSH.
The fixed script checks every tracked source blob and uploaded control hash before
starting a fresh 30-second dispatch anchor. Cancellation and subsequent mixed
terminal custody pin the original uploaded `job.sh`, `pack.sh` and unit hashes
in `originalMixedControls`, derived from the measured commit's contract and
remote adapter. The permanent `test-fixtures/mixed-original-controls.json`
retains those exact generated bytes and Git blob provenance. Current or future
launch templates are neither accepted as substitutes nor used to regenerate
historical expectations; normal launch generation is unchanged.
It then verifies the metadata host,
live unit/start identity, private unchanged review journal, no audit inbox,
reservation PID, exact Node argv/cwd/UID/GID, parent Bash wrapper and cgroup.
Both processes are held by real pidfds and rechecked before the signal.

`mixed-cancel-reservation.json` and `mixed-cancel-intent.json` are exclusively
created and synced locally before one signal request. The latter binds the reason,
wait, repair source, reservation and emitted script. State retains their hashes.
The remote script exclusively creates and syncs `/bench/mixed-cancel-intent.json`
before its sole `pidfd_send_signal(SIGTERM)`. It cannot issue arbitrary commands,
signal a process group, invoke `systemctl stop/kill`, restart, extend a deadline or
retry. The original Bash wrapper stays alive to wait for the handled Node exit and
run its existing EXIT trap/pack script. A signal acknowledgement returns 3, not
terminal proof. The retained acknowledgement hash is recorded in state; custody
must match its exact remote-intent bytes, PID/start ticks and original wait bytes.
Any refusal or uncertainty after local intent retains the intent
and operation lock; there is no automatic adoption, lock takeover or second signal.

A separately approved `--retire-failed-native` observes that cancelled mixed unit
once. If live it returns 3 without download or further signal. If terminal it
downloads the **existing wrapper archive**, never reruns pack, and preserves the
original bounded archive/extraction. Admission requires raw exit 2, the original
plan/subject/wait, a subsequent real halted journal/result, not-run outcome, no
audit advancement and no unaccounted pending native roots. Custody captures all
`/bench/campaign` source/context/native artifacts (all nine contenders), the full
reserved `bench/mixed-production/results/w21` root even when absent, and the remote
cancellation intent. Only that bounded regular intent root uses the remote
`f\0\0<size>\0<bytes>` framed digest; other roots still require directory hashing.
Links, special files, altered hashes and omitted roots refuse. Existing full
terminal/quiescence, account/exact-ID, metadata/rehash/fresh deletion fences and
durable one-DELETE/confirmed-absence rules apply unchanged. Uncertainty means no
DELETE. A retired reservation supports absence reconciliation only, not another
DELETE. All preexisting operation locks remain exclusive.

The authenticated original mixed subject also binds every captured source blob
and contender build-context archive. Before accepting the wrapper extraction or
later custody, the controller checks the manifest and snapshot hashes, the closed
physical file inventory, each file's exact size and streamed hash, and every
selected contender's context commitment. Equal wrapper and custody tree hashes
alone are insufficient: both copies could omit the same referenced payload.
Missing, altered or extra payloads block retirement before deletion intent.
These preservation checks do not execute native source validators, rebuild an
archive, grant audit approval or establish framework qualification. The focused
portable regression command is `node --test bench/workloads/cloud-mixed-custody.test.mjs`.

Focused portable guards run with `node --test bench/workloads/cloud-cancellation.test.mjs`.
The explicit synthetic Linux harness is `test-fixtures/mixed-cancel-linux.mjs`:
private disposable `/bench` tmpfs, read-only source and original 9f campaign blob
at `/proof/old-campaign.mjs`, no network/socket/credentials. It uses real Git,
`/proc` identity/start times, pidfds, the unchanged entry and original campaign
stop/halt logic, original wrapper prefix/EXIT trap and pack script. Preparation,
host/systemd/metadata observations, synthetic Git/wait identity and harness-only
Node loader environment are declared fixture boundaries, not native qualification.
It also invokes `test-fixtures/mixed-cancel-controller.mjs` with Node's test-only
module-mock flag: only a synthetic known-hosts hash is substituted there, never a
production argv/security override. The installed native verifier is imported
unchanged with a real Git HEAD. For a Windows linked checkout, use a separate
read-only standard bare Git object view of the exact committed source, with
`GIT_DIR` and `GIT_WORK_TREE=/src`; verify its commit/tree and the read-only source
against the sealed checkout first. This is metadata for real Git, not a Git stub,
commit override in controller state, or permission to substitute a different
source tree. No native qualification or production action is run by the harness.

### Terminal Custody Fences

The action retains the original `results.tgz` and `evidence-*` tree unchanged,
and saves the original reservation bytes as `failed-native-reservation.json`.
A fixed controller-owned Python program captures current `/bench/campaign`
and every possible reserved native-output root for that group. JSON includes
both preparation `j42` and timing `j43`, even if one is absent. Absence is explicit
data, never a completed benchmark. The program validates and hashes filesystem
metadata before reading evidence contents, opens every ancestor without following
links, and rejects symlinks, hardlinks, special files and nonportable paths. It
never executes a native script, validator, source checkout or downloaded evidence.
Directory entries stream from owned descriptors, reserving the global node,
name-byte and member-byte budgets before names are retained or sorted.

The separate `failed-native-results.tgz` contains raw trees, metadata and file-hash
inventories, and a root snapshot. The bounded existing archive reader verifies
the download, extracts into a fresh `custody-*` directory and compares root and
original-evidence hashes. `failed-native-capture.json` binds this custody to the
measured reservation and repair controller. Intact recorded custody can resume
with a fresh confirmation; unexplained partial downloads or remote captures are
retained without automatic adoption or overwriting.

Capture and final confirmation require the exact metadata host ID, source-bound
uploaded controls and bootstrap marker, a loaded started terminal unit with
`Restart=no`, `MainPID=0`, exit `2` and no unit job, no pending systemd jobs,
completed cloud-init without user data, and no current benchmark process or
running container. The cloud-init selector must be the single-link symlink
`/var/lib/cloud/instance` with exact absolute target
`/var/lib/cloud/instances/<owned-host-ID>`. The probe reads that pinned link as
data, never traverses it, and opens the canonical instance and every ancestor
without following links. `/var/lib/cloud/data/instance-id` must be a single-link
regular file containing the exact host ID, with at most one final newline;
`user-data.txt` in the canonical instance must be present, single-link, regular
and empty. Descriptor and path identities are checked before and after reading,
and must remain unchanged when quiescence is checked again in each capture,
rehash and fence invocation. Missing, foreign or relative selectors and linked,
special or replaced canonical paths refuse custody; this exception never permits
benchmark-input links or arbitrary cloud-init layouts. Only the probe's exact
timeout parent is exempt from its
process scan. Confirmation rehashes all roots and the custody archive, then
local custody is checked again. A final fence requires the exact unchanged
metadata inventory of every root, rehashes the custody archive and renews current
quiescence before the fresh ownership/account check. The 60-second deletion-proof
window starts locally before the final fence request, conservatively including
remote work and SSH response delivery without relying on remote clock skew.
Interrupted receipt rehashing also precedes the final fence. The absolute
expiry accompanies only this failed-retirement DELETE through asynchronous account
preflight and private-worker IPC. Private HTTP dispatch keeps DELETE unbuffered
until socket/TLS readiness, rechecks expiry before sending, and destroys an unsent
request at expiry. It is never restarted or widened by a provider call. Large local
checks cannot consume that final freshness window. These are current retirement observations,
not a historical accounting or native qualification pass.

`failed-native-host.json` records capture, fresh confirmation and their exact
script hashes before a durable `native-failed` retirement intent and one DELETE.
The same private provider worker and pre-unlock settlement apply. A lost or
uncertain deletion acknowledgement permits exact-ID absence reconciliation only,
never another DELETE. Existing locks are never taken over or cleared by recovery.
The saved measured commit and failure evidence remain unchanged; no validation,
successful exit or collection result is invented. Fleet inspection reports
`native-failed-retired` or `cleanup-pending`, never a qualified baseline.

After independent review and merge, an operator previews the exact action with:

```sh
node bench/workloads/cloud-production.mjs r21 --state-dir ABSOLUTE_GROUP_STATE_ROOT --retire-failed-native --print-approval
```

Execution replaces `--print-approval` with the existing
`--approve-reviewed-merged-ready EXACT_ACTION_SHA256` only after separate operator
approval. Implementing or testing this action authorizes no provider operation.
Synthetic controls run with `node --test bench/workloads/cloud-failed-native.test.mjs`.
The opt-in `CORTEN_FAILED_NATIVE_LINUX=1` local test in
`cloud-failed-native-linux.test.mjs` uses disposable, labeled, networkless containers
with real file descriptors and `/proc`, substituting only service/metadata responses;
it includes the standard cloud-init selector layout and deterministic real-path
replacement controls at capture, rehash and fence. It is not provider,
systemd-host or native performance qualification.

Large source bindings and evidence manifests are compared with exact strict
equality without constructing assertion diffs. Invalid evidence still refuses;
the error contains a bounded message rather than either complete manifest.
Memory-regression reproductions need an operating-system memory limit, not only
a JavaScript heap limit: formatting a diff can allocate outside that heap.

Single-group inspection uses a distinct report schema and cannot establish a
complete official round. Full-round publication requires every current registry
group, exact source and selection, native replay, immutable saved evidence and
confirmed terminal cleanup. Missing, blocked and failed groups stay visible rather
than being omitted. Framework failure outcomes remain distinct from a broken
apparatus and from comparison-eligible measurements.

Report hardware and measurements per group host. Same-size droplets need not have
the same CPU model: compare contenders against Corten on their own group host,
not raw numbers across hosts or unrelated workloads. Parallel wall time is governed
by the slowest group plus launch/collection overhead, rather than the sum of group
times. Total allocated time can rise because provisioning and builds repeat;
neither equal cost nor a morning completion time is guaranteed.

These contracts do not themselves establish fleet readiness or authorize a cloud
action. The complete controller, native single-group producer/replay and fleet
aggregation require independent exact-head review and their normal checks before
an official launch. Existing uncertain hosts and their evidence are not restarted,
discarded or retroactively qualified by this topology change.

**Production is operator gated, not a fake-only transport.** `cloud-production.mjs`
composes the lifecycle with a private credential-owning worker for bounded read-only
doctl credential consumption and fixed-endpoint DigitalOcean REST, plus OpenSSH
subprocesses;
the `droplet.mjs` CLI delegates to that same composition. Direct core imports keep
their default cloud-execution guard so they cannot accidentally bypass approval.
Only synthetic configurations and a loopback fake API are used for native credential
checks; no real account store or provider operation is used. There is no
hidden launcher: an approved detach provisions once, verifies uploads, starts the
fixed systemd job and returns. The provider security review does not authorize an
action: the coherent integration still requires merged CI, official-source
qualification and independently reviewed complete native producer/OS/validator closure.

The wrapper adds no provider, workload, adapter, environment or timing overrides.
Its only extra options are `--print-approval` and
`--approve-reviewed-merged-ready SHA256`. Approval is a trusted operator declaration
that this exact controller/action was reviewed, merged and is ready, not evidence
in a saved JSON file and not an attestation made by the program about itself.
The program separately checks the merged Git ancestry; it cannot authenticate who
performed a human review. Never feed the preview hash back automatically.

An approval subject binds the loaded controller's exact committed source, round,
mode, measured commit/SSH-key ID and account UUID/named doctl context for detach,
absolute state path and its verified physical root, exact saved state
bytes for collect/delivery, and exact audit delivery bytes and approved audit
subject for delivery. Preview uses local Git and read-only files only; it creates
no state and contacts no provider. It returns 2 with explicit missing integration
paths, otherwise 3 awaiting approval, never qualified exit 0. Execution requires
the exact subject, checks clean loaded/committed controller bytes, reads the fixed
public source repository's main advertisement and fetches only that exact object.
Parallel children never update shared tracking refs or `FETCH_HEAD`. Both the
outer and locked launch ancestry checks use the same observed main SHA, then repeat
the snapshot checks. The first provider access repeats approval under the core's
exclusive lock, closing the concurrent-collector snapshot race.
The current native verifier reconstructs bindings against its measured checkout,
so collect/delivery must use that same integrated source commit, not a newer
collector checkout. This compatibility limit must be revisited with the agreed
intrinsic API, not misreported as failed native evidence after allocation.

```text
node bench/workloads/cloud-production.mjs rN --detach --commit SHA --ssh-key ID --account-id SCOPED_ACCOUNT_ID --context NAMED_CONTEXT --state-dir ABSOLUTE_LOCAL_ROOT --print-approval
node bench/workloads/cloud-production.mjs rN --detach --commit SHA --ssh-key ID --account-id SCOPED_ACCOUNT_ID --context NAMED_CONTEXT --state-dir ABSOLUTE_LOCAL_ROOT --approve-reviewed-merged-ready EXACT_ACTION_SHA256
```

Those are the eventual operator interface, not permission to run now. Collection
and audit delivery require their own newly approved exact action; an old launch
approval cannot authorize deletion or receipt delivery.

## API

`controller(options, {run, repo, sleep, inspect, interrupted})` returns `launch()`,
`collect()`, `deliverAudit()`, `cancelMixedWait()`, `retireFailedNative()`,
a defensive-copy `state` getter and the local round
directory. `run(binary, argv, timeoutMs, allowFail)` returns a process result or a
promise for one; every control call is awaited and cancellation is rechecked on
return, not just before the call. It is not a shell or an adapter plugin.
`productionPlan()` is also asynchronous. `inspect` is the read-only campaign
validator seam for tests/integration, not a production adapter override.
`interrupted()` is checked between operations, during validation and before
deletion; it does not kill a remote unit or take over a live campaign.
Production crosses two real `setImmediate` turns both before and after **every**
control subprocess, including local Git checks and error/allow-failure returns.
This crosses a poll phase even when entered from a check callback, allowing OS
signal handlers to latch cancellation deferred by synchronous subprocesses;
resolved promises/microtasks alone are not sufficient. No later command is
issued after cancellation, including identity probes, provisioning, upload,
unit start, audit publication or deletion. A final checkpoint also precedes
returning a completed action's result.

The bounded subprocess itself remains synchronous and is not interrupted by the
controller's signal handler: an in-flight create/start/delete may already have
happened and cannot safely be undone. An acquired operation lock stays held until that
local call settles. A timeout, signal exit, output overflow or spawn exception does
not prove descendant termination: the operation lock and any acquired root launch
lock remain durable on every platform. No further command/retry is issued, even
for an allow-failure call. Operator recovery must establish that the entire local
owned process tree is gone before touching those locks. At the post-call checkpoint,
cancellation rejects with exit 2, retains the durable intent/state/evidence and
issues no recovery mutation or reconciliation command. The host may already be
absent if deletion was in flight; it is never reported confirmed by a cancelled
path. There is no rollback, remote stop, retry launch, repeated deletion or live
lock takeover. Direct test seams are responsible for eventual settlement of
their injected process promises; production keeps its existing bounded calls.
The fixed default validator runs in a separate local worker, never downloaded
code. `cloud-validation-snapshot.mjs` reads its fixed project-module closure from
immutable Git blobs at the approved installed commit, with bounded no-lazy-fetch
reads. The closure includes the observer's durable writer; transitive observer
imports use those captured bytes under the same deny-unlisted loader.
The fixed TypeScript bundle is captured once and checked against its pinned
package hash. The nested worker executes captured entry bytes and installs a
deny-unlisted loader before project or package code evaluates; it never reopens
mutable executable paths or falls back to a package loader. The snapshot helper is
also part of the outer controller/fleet approval closure. Its API remains exactly:

```js
validateCampaign({ folder, round, commit })
```

Its module is `isolated/campaign-verify.mjs`, not the plan validator with the same
function name. `folder` is the extracted `campaign/` root containing
`.host-attempt.json`, not its campaign-ID subdirectory. This module is absent at
the pinned base, so normal validation fails closed. Tests inject a synthetic
report with the current API shape; no synthetic report is native proof.

Each inspection has a fixed 60-second deadline, including snapshot setup, and a 25-millisecond cancellation
check. The default worker is terminated on completion, timeout or cancellation;
no successful report is consumed before its exit is confirmed. Worker stdout,
stderr and exceptions are not forwarded. Termination confirmation gets at most
one additional second. If stopping is uncertain, the operation fails while
retaining the exclusive operation lock, state, archive and host. The injected
in-process test seam cannot be killed: if still pending on timeout/cancellation,
its durable lock is retained even after a late settlement. No late result resumes
collection or authorizes deletion. Retained locks require operator inspection;
there is no automatic takeover. A synchronous blocking injected test function
cannot be interrupted by an event-loop timer; the default worker avoids that limit.

Options are exact: `round` (`r17` onward), absolute local `stateDir`, and one mode:

1. `detach:true`, full 40-character `commit`, numeric `sshKey`, stable account UUID
   `accountId` and explicit named doctl `context`. Account identity is `team:UUID`
   when the provider reports a team, otherwise `user:UUID`; UUIDs are opaque
   provider identifiers, not assumed to be RFC-4122 strings.
2. `collect:true`, using only the saved reservation identity.
3. Absolute `deliverAudit` file, exact `campaign` ID, explicit `approveSubject` SHA256.

The core mode grammar, with a production approval/preview option appended:

```text
rN --detach --commit SHA --ssh-key ID --account-id SCOPED_ACCOUNT_ID --context NAMED_CONTEXT --state-dir ABSOLUTE_LOCAL_ROOT
rN --collect --state-dir SAME_ROOT
rN --deliver-audit ABSOLUTE_FILE --audit-group json-api|mixed-production --campaign rN-TOKEN --approve-subject SHA256 --state-dir SAME_ROOT
```

Exit/result conventions are 3 for a single running observation or delivered audit,
1 for terminal blocked/failed evidence with deletion independently confirmed, and
2 for CLI errors/uncertainty with no further host mutation. A lost deletion response
can mean the host is already absent, not that it was definitely preserved. API failures reject;
the caller maps them to 2 using `publicError()`, never a raw exception stack or
provider output. Exit 0 means complete intrinsic native replay plus all independent
controller ownership, terminal, archive and confirmed-deletion checks, not external
qualification or readiness. `fullGroupQualified` must always be false. A verified
inspection must use the exact current schema, complete ordered registry selection,
all native-validated groups/app outcomes, no blockers/pending roots, sealed manifest,
observed terminal command lifecycle and native CLI marker 0. Complete sealed
blocked/failed inspection requires marker 1; marker 2 or disagreement preserves
the host. A failed framework outcome remains failed even within intrinsically
complete apparatus evidence; it does not become comparison-eligible.
Passed app outcomes may also remain comparison-ineligible under the committed
dependency policy or a native whole-group timing gate. Collection preserves that
boolean distinction; it never promotes a passed row to eligibility. Failed and
unsupported rows cannot be comparison-eligible.

## Reservation And Ownership

The state root must be physically disjoint from the measured checkout, including
symlinked parents, and cannot be a UNC/network path. Use one private root for all
grouped attempts. `groups-rN/` is the exclusive durable reservation; even failed
preflight consumes it. An unresolved reservation blocks another round in that root.
The root launch lock and round operation lock are exclusive files with process
identity, synced before work. No PID liveness guess, stale-lock removal or takeover
is automatic. A killed process may leave both locks. Inspect the exact process and
all state/evidence before any operator recovery; never relaunch the reserved round.

State writes use exclusive temporary files, file fsync, atomic rename and directory
fsync where supported. Windows does not support the directory fsync used here.
Leftover temporary state, unexplained downloads, archives and extraction attempts
are evidence, not garbage to overwrite. A later operation cannot trust a saved
qualification flag or a producer's deletion permission.

Launch records create intent before its only create call. A lost response permits
one list reconciliation, not another allocation. Exact numeric ID (once known),
name, unique run tag, both shared tags, c-8 size, sfo2 region and exactly one matching
public IPv4 are required. Every SSH/SCP call rechecks that identity. Collection of
a creating reservation may bind that exact unique host, but never provisions or
starts it. Failed/unstarted/missing units require operator inspection, not deletion.

The fixed job clones the exact committed source, installs the contract's packages,
runs the all-nine entry and writes an exit marker with terminal-only packaging.
`cloud-remote.mjs` retains the read-only contract's packages/unit and fixed paths;
it checks the fixed GitHub origin URL, fetches main, requires measured-SHA ancestry,
checks out that exact SHA with CRLF conversion disabled and requires a clean tree
again immediately before entry. Source URL/SHA/tree are retained in `host.txt`.
The native command is `bench/workloads/isolated/campaign-entry.mjs`, never a root
campaign module. Immediately before entry the job exclusively creates
`/bench/campaign` with mode 0700, under its 0077 umask and the entry's UID. Any
existing directory, file or symlink fails instead of being reused, chmodded or
removed. The native `begin()` requires this existing physical private root; it
creates the durable reservation inside it. Each uploaded job/packer/unit is
SHA256-checked on the owned host before installation/start. The packer requires terminal metadata, keeps an existing
regular archive instead of overwriting it, and publishes a fresh private GNU tar
archive with exclusive hard-link creation; a collision does not replace evidence.
One remote unit start is attempted; there is no forced power cycle, restart or
retry launch. SSH readiness is at most 40 bounded probes. The job has the existing
48-hour systemd lifetime; control calls have explicit timeouts no greater than
15 minutes. Collection does not poll a running unit. It requires exact loaded unit
ID/path, `Restart=no`, a terminal exit type, prior start and no live MainPID before
archiving, and checks again before deletion.

The production process boundary uses argv with `shell:false`, bounded captured
output, fixed timeouts and generic errors, never raw provider/native exception
output. SSH sends its fixed script through stdin to `/bin/bash -s` with strict
shell options, avoiding another command-line quoting layer. SCP uses batch SFTP,
not legacy SCP shell interpretation. Spaces/apostrophes in absolute local paths
are retained; SSH-config expansion characters (`$`, `%`, double quote) in state
paths are refused. Per-reservation known_hosts is quoted. Client config,
forwarding, local-command hooks and connection multiplexing are disabled.
Production preflight checks both the supplied state path and its physical
resolution before approval output or provider access. Existing directory aliases
are resolved even when trailing state directories do not yet exist; a plain alias
cannot hide expansion characters in its physical parent. Ordinary aliases remain
usable for preview, launch and collection. Saved state is read through the verified
physical root, which is included in approval and passed unchanged to the core.
Retargeting an alias invalidates approval. The transport repeats its known_hosts-path check
as a final guard.
Production and the core share a bounded physical-root walk: a missing drive/root
refuses when no parent remains, and permission, non-directory or symlink-loop
errors refuse immediately rather than being treated as missing directories.
Preview never creates missing directories; core setup may create normal new ones.
No control child inherits a DigitalOcean token override. SSH/SCP may use the existing
agent/default keys. Their allowlist also retains `ProgramData`, which Windows OpenSSH
needs during initialization even for a local `-G` configuration check. Like the other
allowed locations, it is captured when the transport is composed, not reread between
calls. Neither Git nor doctl receives it; the remaining environment stays allowlisted,
and no credential store is copied. No credential is accepted in CLI arguments or remote scripts.
`cloud-provider.mjs` is the controller-side IPC client, not a credential consumer
or native HTTPS client. It captures the builtin-only worker bootstrap bytes in the
same read whose hash enters the fixed thirteen-file executable manifest. It starts
the fixed physical Node executable with only `--input-type=module -` and the fixed
worker-path root anchor, sending those captured bytes over stdin. Node does not
execute the entry path again. The child receives an explicit environment allowlist,
not ambient loader/preload, diagnostic, CA, TLS or key-log settings; its process stdout
and stderr are discarded. Strict boot/init/action/result IPC checks nonce and action sequence,
never arbitrary code, commands or URLs. Before any project import, the worker checks
the complete manifest and installs a closed load hook that serves the verified
snapshot bytes and refuses unlisted executable imports.

The inherited noncredential config locations are captured once per action. After
approval and under the lifecycle lock, `doctl auth token --context NAMED_CONTEXT`
consumes the selected existing stored credential exactly once inside that worker through
private, bounded stdout capture. It does not switch/default a context or copy its config.
All subsequent provider calls use that same private in-memory value, never another
doctl config read, token environment/argument, persisted token or config snapshot.
The token and raw credential-command output never enter the controller's buffers,
IPC results, errors or logs.
The token command does not refresh OAuth state; expiration or unavailable identity
fails closed rather than reloading mutable credentials mid-action.
Before and after every provider command, the account endpoint must report exactly the
saved scoped account UUID: `team.uuid` when present, otherwise the user's `uuid`.
Switching teams under the same login is therefore an account change. Malformed
or missing team identity never falls back to user identity. A mismatch or
unavailable identity refuses further effects
and cannot confirm absence/deletion. The UUID and context are non-secret approval
and reservation fields; credentials remain in their existing store and private
process memory, never printed or persisted by this controller. Legacy reservations
without this binding fail closed and need operator inspection, not automatic adoption.
Named-context consumption follows [doctl's auth-token command](https://docs.digitalocean.com/reference/doctl/reference/auth/token/)
and its [read-only implementation](https://github.com/digitalocean/doctl/blob/main/commands/auth.go).
Account/team fields follow [DigitalOcean's account schema](https://github.com/digitalocean/openapi/blob/main/specification/resources/account/models/account.yml).
The clean child, rather than an inference from the parent's mutable environment,
is the diagnostic boundary. Deleting `NODE_OPTIONS` or `NODE_DEBUG` after parent
startup does not disable effective/cached diagnostics; the parent therefore never
owns the credential. Inside the worker, `cloud-provider-engine.mjs` additionally
refuses configured `NODE_DEBUG`,
`NODE_DEBUG_NATIVE` or TLS key logging, active inspection, and enabling native
trace/key-log/heap/profile/report options from `NODE_OPTIONS` or CLI flags.
It checks Node's cached HTTP/HTTPS debug enablement as well: deleting an environment
variable after Node cached it is not a safety boundary. The same check runs before
every native HTTPS construction, without changing process-wide diagnostics or
trying to redact their output after a secret was exposed. Inactive diagnostic
parameter defaults and ordinary non-diagnostic Node options remain usable.
`NODE_OPTIONS` is decoded with Node's own double-quote/backslash argument rules,
so quoting or escaping an enabling option cannot hide it from the preflight.
This follows [Node's documented diagnostic controls](https://nodejs.org/docs/latest-v24.x/api/cli.html#node_debugmodule).

The worker's fixed provider action grammar supports only account lookup, complete bounded
droplet census, one exact-host create, matching create-action polling and one exact-ID delete.
The HTTPS origin is fixed, certificate verification is explicit, redirects are
never followed and no HTTP error/network failure is retried. Census pagination
must remain on the fixed endpoint, contain unique IDs and match its stable total;
an incomplete census cannot prove absence. Create waits only through bounded
read-only polling of its exact droplet/action identity, never a repeated POST.
An `in-progress` create action may have `resource_id: null` or numeric zero;
both remain pending, not ownership or completion proof. Completion still requires
the exact positive droplet ID returned by the single POST, the matching action
ID/type/resource type. The POST must still return exactly one action link with a
positive safe-integer ID. Its advisory `rel` and `href` fields are not consumed.
The [published action-link schema](https://github.com/digitalocean/openapi/blob/998192821fe95ee79e41f577933601d009179dcf/specification/shared/models/action_link.yml)
describes these optional fields, but this adapter deliberately validates only its
consumed projection, not every property of that schema. It does not call malformed
metadata a valid URI or use it as a fallback destination.
Polling constructs `/v2/actions/ID` from the numeric ID, never fetches `href`, and
requires the authoritative response to prove the action ID, create type, droplet
resource type, exact POST droplet ID and completed status. Only the validated
droplet ID is returned across provider IPC. The controller requires that ID to
equal the fresh owned-host ID before any provisioning SSH. Numeric linked-action
lookup also exists in
[godo's ID-based linked-action lookup](https://github.com/digitalocean/godo/blob/147424adb9525690e45ac36401d993b8c71e6ebc/links.go).
The [broader response schema](https://github.com/digitalocean/openapi/blob/998192821fe95ee79e41f577933601d009179dcf/specification/resources/droplets/responses/droplet_create.yml)
permits missing actions or IDs, but those still fail
closed here: without a unique numeric action ID this adapter cannot prove
completion. It does not discover another action or repeat POST. Neither optional
link fields nor zero resource IDs extend the original deadline or bypass
cancellation. This covers synthetic instances, including one
permitted by the [published action model](https://github.com/digitalocean/openapi/blob/998192821fe95ee79e41f577933601d009179dcf/specification/resources/actions/models/action.yml),
not observed responses from the failed r21 launch, whose initial create body was
not retained; that launch's exact cause remains unconfirmed.
Responses have a body bound and whole-request deadline; in-flight timeout,
cancellation or malformed responses conservatively retain lifecycle locks.
Every provider-owning controller action awaits the same cached worker-close promise
before releasing its operation lock, including early-return and error paths. Forced
worker termination or uncertain shutdown retains the operation lock and any acquired
root launch lock. The outer finalizer awaits that same settlement, not a new teardown
after lock release. Ordinary confirmed shutdown releases the locks normally.
Provider failures may append a bounded phase code to the generic CLI error. The
closed vocabulary in `cloud-options.mjs` distinguishes credential consumption,
account/list/create/delete requests, create response/link validation, action
request/response validation, pending-action deadline, and output filtering.
Unexpected HTTP responses use a `-http` code and optionally a numeric status from
that module's closed status table; unlisted statuses are omitted, not accepted or
retried. Only those validated data fields cross the worker failure boundary or a
permitted HTTP-failure result, never native exceptions, raw bodies or credentials.
Classification survives cached teardown and failed create reconciliation; it is
diagnostic only and changes no action schema, ownership proof, retry, deadline,
approval, uncertainty or lock-release rule. Missing/invalid diagnostics remain
generic errors, not evidence about the provider's response.
The adapter follows [DigitalOcean's create/action contract](https://github.com/digitalocean/openapi/blob/main/specification/resources/droplets/droplets_create.yml).
SSH uses [OpenSSH's command/transfer rules](https://man.openbsd.org/ssh.1),
[SFTP-by-default SCP](https://man.openbsd.org/scp.1).

Synthetic local worker controls do not qualify the operator's actual tool/configuration,
agent-key availability, network, provisioning, remote Linux systemd behavior or
image-install supply chain. A local control-subprocess timeout never proves descendant
termination and retains the lifecycle locks as described above; it never stops the remote unit.
Synchronous control calls cannot process an in-process cancellation callback until
the current bounded call returns; cancellation is checked before subsequent calls.
An SSH timeout never proves a remote command stopped. No recovery path stops a
running unit, retries a start or allocates a replacement.

## Evidence And Cleanup

Fresh disposable-host bootstrap runtime-masks `fwupd.service`,
`fwupd-refresh.service` and `fwupd-refresh.timer` after cloud-init and before
provisioning. It requires all three to remain masked and inactive before native
entry, preventing firmware timer/D-Bus activation inside the baseline boundary.
This preparation is not applied to existing hosts or replayed during collection.

Host inventories retain every PID/start/cgroup and the raw `/proc/PID/stat` read
that supplied its identity. Only new identities with matching saved PID/start
fields and Linux's `PF_KTHREAD` flag are exempt from the user-process cleanup
comparison. Names, parent PIDs and claimed kernel booleans are not proof; absent,
malformed or identity-mismatched stat data cannot excuse a new process. New user
daemons, including fwupd, and application leaks still fail. Container, network,
boot, participant and lifetime/resource gates are unchanged. Old inventories do
not acquire proof from later observations: failed historical r21 stays invalid.

Collection hashes the remote archive, reserves a download destination, preserves
interrupted bytes and verifies SHA256 before extraction. A separate synced copy is
kept as `results.tgz`. The original download remains retained too. A retry never
replaces an unexplained download/archive. Extraction destinations are fresh private
directories recorded before writing. Failed partial directories remain retained;
a retry uses a new one. No evidence is imported into the measured repository.

The reader checks the actual compressed bytes rather than trusting two tar listings.
It accepts regular files/directories in ustar/GNU tar and bounded GNU long names.
Checksums, headers, bodies and the zero trailer must be consistent. Symlinks,
hardlinks, special files, pax/sparse/other extensions, traversal, control characters,
foreign roots, reserved Windows names, case aliases, duplicates and file/parent
collisions are rejected before any extraction write. Extraction never restores
archive permissions or owners and uses exclusive file creation. Whole physical-tree
hashes include directories and reject links, hardlinks and special files on reuse.
The archive and extracted tree are rehashed around validation and before deletion.
Raw exit-marker bytes must be ASCII before decoding, then match the exact decimal
exit-code/newline grammar. Node's high-bit-clearing ASCII decoder is not evidence
validation. Malformed terminal markers preserve the archive and host.

### Collection Envelope

The explicit local `benchmark-cloud-evidence-envelope/v1` policy (not a new wire
or saved-state schema) gives the collector and terminal packer independent hard ceilings: **16 GiB regular
file content, 17 GiB expanded tar, 18 GiB compressed archive and 1,100,000 physical
nodes**, including the extraction root and implicit directories. Limits remain
64 path components, 255-byte components and 4,096-byte member/absolute extraction
paths. No evidence is truncated or omitted to fit. Crossing any limit blocks
collection and preserves the host; it cannot authorize deletion or qualification.

These are operational budgets, not measured campaign sizes or native verifier
changes. Their derivation against the ten retained phases in the nine-group
campaign is:

| Phase | Current saved-verifier bound | Content allowance |
|---|---|---:|
| catalog-page | 2 GiB total, 64 MiB/file, 30,000 entries (`catalog/verify.mjs`) | 2 GiB |
| json-api prepare | No whole-tree byte/count ceiling in the saved reader (`json-api/artifacts.mjs`) | 2 GiB |
| json-api timing | Same reader; a separate retained phase | 2 GiB |
| localized-marketplace | 512 MiB cumulative reads, 32 MiB/read, 25,000 physical entries; not a whole-tree byte ceiling (`marketplace/saved-files.mjs`) | 0.5 GiB |
| mixed-production | 1 GiB total, 256 MiB/file, 100,000 entries (`mixed-production/verify.mjs`) | 1 GiB |
| fullstack-browser | 1 GiB total, 256 MiB/file, 50,100 nodes (`fullstack-browser/verify.mjs`) | 1 GiB |
| client-heavy | 2 GiB total, 80,000 entries, 128 MiB ordinary files, one admitted browser blob up to 512 MiB, 1 GiB unique blobs (`client-heavy/verify-v2.mjs`) | 2 GiB |
| live-delivery | No whole-tree byte/count ceiling; individual gzip replay limits are not whole-tree limits (`isolated/adapters/live-delivery.mjs`) | 1 GiB |
| recoverable-live | Uses the same live saved reader | 1 GiB |
| hardening | 1 GiB total, 256 MiB/file, 100,000 entries (`isolated/adapters/hardening.mjs`) | 1 GiB |

The allowances sum to 13.5 GiB. Another 2.5 GiB allows control files, native manifests,
journals, command logs, OS observations and source/build-context snapshots: 16 GiB
in total. They explain the aggregate budget, not per-phase quotas. For counts,
ten 100,000-node phase allowances plus 100,000 control/context nodes give 1,100,000.
The finite native count limits above all fit a phase allowance; readers without a
whole-tree bound cannot imply an unlimited transport contract. The old 100,000
campaign-wide limit did not even leave room for the client's 80,000-entry closure
and the other groups' independently allowed inventories.

The extra 1 GiB for tar and then 1 GiB for gzip are **independent framing ceilings**,
not a claim that every simultaneous content/count/path extreme fits. The packer
counts actual regular bytes and nodes, computes GNU headers, long-name bodies,
512-byte payload padding and the final 10,240-byte record rounding before tar runs,
then checks the compressed file before exclusive publication. The collector checks
the actual expanded byte count, headers, every body/padding byte and zero trailer.
All native proof remains required. An otherwise valid native tree outside this
explicit transport envelope stays preserved/blocked, never silently reduced.

Gzip streams through 64 KiB buffers into one exclusively created private disk spool.
Its full compressed-byte SHA256 must match the remote receipt. The same open spool
FD is fully preflighted, including late gzip corruption and tar trailer failures,
before any extraction entry is written. A full tar SHA256 and physical FD/path
snapshots bind preflight and extraction to the decoded bytes. Files are copied and
hashed in 64 KiB chunks, with exclusive creation and fsync; small controller JSON
and markers retain a separate 16 MiB maximum whole-buffer API. The canonical tree
hash format is unchanged. No whole archive, native file body or array of all tar
members is allocated. The legacy Buffer argument is limited to 16 MiB local
fixtures; production archive collection always supplies a physical path.

Index storage is bounded separately: 12 bytes per node, a fixed 16 MiB hash-slot
table, and a 32 MiB segment-name arena (including one byte per stored segment).
At the maximum node count these three buffers total 63,531,648 bytes, under 61 MiB.
The trie stores parent IDs and segments rather than copied 4 KiB full paths or JS
maps per prefix. Separate 64 MiB counters bound cumulative tar member names and
all unique physical path names, including implicit directories and their trailing
slashes. Both are admitted before extraction, matching the tree hash's metadata
budget. Temporary strings are limited to one path/segment; JS/zlib
and stream overhead is additional, not part of that buffer count. Tree hashing
uses a compact 32 MiB name arena and 4,400,000-byte offset table, with bounded
`opendir` admission before sorting rather than an unbounded `readdir` allocation.
Index/name-budget exhaustion fails closed even below the byte/node ceilings. Limits
may only be lowered through local test APIs, never raised by evidence or CLI input.

Provision **69 GiB of local disk per fresh collection attempt** as a conservative
allowance: retained download 18 + synced archive 18 + tar spool 17 + extracted
content 16 GiB. Filesystem allocation/metadata overhead needs additional space.
Only the invocation's own exclusive spool directory is removed after success or
failure. Downloads, unexplained synced files and partial extraction attempts remain
preserved; retries can therefore require more space. A crash can leave a private
`.cloud-spool-*` directory for operator inspection, never automatic adoption.
The exact loaded controller/approval closure already contains `cloud-local.mjs`,
`cloud-contract.mjs`, `droplet.mjs` and `cloud-remote.mjs`. The provider worker's
existing source snapshot contains `cloud-contract.mjs`; no new module, provider
dependency, state schema, approval schema, bootstrap or job behavior is introduced.
SCP has a time bound, but its temporary download's size is checked after transfer,
not enforced as an in-flight disk quota. The private same-user state directory and
owned root host are trust boundaries, not protection against a hostile same-UID
process mutating paths between system calls. SSH uses private per-reservation
known_hosts with first-contact accept-new, not independently attested host keys.

A read-only native report must match exact round/commit/campaign, report a sealed
manifest, and have **no uncollected native roots** before terminal cleanup is even
considered. Invalid, missing, contradictory or unsealed native evidence preserves
the host. An honest blocked/failed report never becomes successful qualification,
even with process exit zero. Terminal failed jobs may be archived and deleted only
after all ownership/terminal/integrity checks, independently of qualification.

Deletion intent is durable before one exact-ID delete. An error, cancellation or
unconfirmed result is uncertainty, not confirmed deletion. A retry may revalidate
the preserved bytes and confirm that exact ID is absent; it never repeats an
uncertain deletion while that ID is still present. No name-based fallback,
foreign-host SSH, resource restart or blanket cleanup exists.

## Independent Native Audits

Audit delivery is a separate live-owned-host operation, never collection of a
review-waiting host. An explicit operator-approved exact subject hash is a separate
option; a receipt's `decision:approved` cannot grant authority. The caller must
obtain the actual independent review. `--audit-group` selects one of the two fixed
native contracts; omission retains JSON compatibility, never schema-driven routing.
JSON receipt cells come from its native descriptor; mixed receipts follow the
ordered native registry apps, with no hardcoded counts. The controller saves exact
bytes and one durable attempt per group in `auditIntents`; a legacy `auditIntent`
still consumes the JSON attempt. It verifies the live
campaign journal/plan/reservation/subject, and recomputes the subject's canonical
body hash. The requested group, waiting inbox and subject field must all match.
It uploads a private mode-0600 group-specific staging file outside the campaign root.
Immediately before publication it rechecks the live unit and exact waiting subject.
The fixed program uses bounded GNU `mv --no-clobber` for atomic same-filesystem
inbox publication into `json-audit-delivery.json` or `mixed-audit-delivery.json`,
and checks that staging disappeared and inbox bytes still match. Delivered receipt
identities must exactly match that independently approved live subject. JSON
decisions/hashes cannot choose a group, path, module or grant their own authority.
An existing/racing inbox is never overwritten. Failure preserves the attempt and
bytes, not automatic retry authority. The native live process owns full receipt
and source/image validation; this transport never resumes it from serialized JSON.
Real OS behavior of that publication step remains an integration/host check.

### Read-Only Review Export

The subject is produced **after launch**, not by a prelaunch source review. JSON
waits after its check-only build and captures actual built-image identities;
mixed waits before building and captures committed source and deterministic build
contexts. `collect` returns 3 for a live unit **before downloading anything**.
Do not collect, package a terminal archive, stop, restart, signal or change the
job to obtain review bytes. There is no controller export CLI mode. The following
is an explicitly authorized operator read-only inspection using existing host
access, not a new approval mechanism or permission to launch/deliver/delete.

1. Obtain operator authorization for reading one exact saved reservation, its
   waiting campaign and the paths below into a new private local directory outside
   the checkout and controller state. Serialize with the reservation's operator:
   no concurrent collect, delivery or state editing; never remove an operation
   lock. Use the measured, reviewed checkout, not a newer collector. Read the
   child's `groups-ROUND/state.json` through its verified physical state root;
   validate it with `cloud-options.mjs::controllerState`.
   For a fleet, use that group's saved child state root, not the fleet root or a
   sibling. Retain its exact bytes locally; require `starting`/`running`, a bound
   ID/IP, no collection/deletion intent and no previous audit attempt for this
   group (including legacy JSON `auditIntent`). The reservation token is the
   ownership nonce, **not** the campaign ID's independently generated suffix.
2. Before **each** SSH/SFTP session, re-establish the same saved account/context
   and exact provider ID, name, run/shared tags, size, region and unique public IP
   using the existing read-only ownership checks (`providerAccount` before/after
   the exact-ID observation, then `cloud-contract.mjs::ownedDroplet`, with the
   controller's additional unique-public-IP check). Never select by name alone,
   reuse an old census or infer ownership from an IP. Use the saved private
   `known_hosts`; require its already recorded host key (`StrictHostKeyChecking=yes`),
   batch authentication, no client config, agent forwarding, local hooks, port
   forwarding or multiplexing, and the same controlled environment as the existing
   transport. Do not export credentials, process environments or raw image `Env`.
   Missing host-key/ownership evidence stops this procedure, not a first-contact
   accept or a switch to another host.
3. Through that bounded read-only SSH session, save `systemctl show` for the exact
   saved unit with `Id`, `LoadState`, `FragmentPath`, `ActiveState`, `Restart`,
   `MainPID`, `ExecMainCode` and `ExecMainStartTimestamp`. Require the expected
   loaded unit/path, `Restart=no`, active state and nonzero MainPID. Read
   `/bench/bootstrap-ready.json` and `/bench/campaign/.host-attempt.json` to obtain
   the exact campaign ID. In that campaign directory identify the **latest**
   five-digit journal event, not merely an older `review-needed` event. Require
   its status to be `blocked-review-needed` for the requested group, with the
   expected campaign/round/plan hash, subject field and group-specific inbox.
   Refuse an existing delivery inbox. Record the unit observation and latest
   event name/bytes before transfer. Bound each observation to 30 seconds and
   16 MiB of output; do not poll until a different state looks acceptable.

Only these fixed review paths are allowed, relative to that campaign directory:

| Group | Subject | Immutable snapshot | Waiting journal kind |
| --- | --- | --- | --- |
| `json-api` | `json-audit-subject.json` | `audit-sources/` (`blobs/SHA256`) | `review-needed` |
| `mixed-production` | `mixed-audit-subject.json` | `mixed-audit-sources/` (`blobs/SHA256`, `contexts/APP.tar`) | `mixed-review-needed` |

The snapshot is `subject.sourcesManifest.snapshot`, not the mutable working tree
or a freshly regenerated context. JSON also binds `nativeManifest`, `images` and
the complete `identities` in the subject; mixed binds ordered `requests`, each
context archive hash and its build-input inventory. Neither review scope implies
the other's built-image or source qualification. Native preparation results, if
the reviewer needs them, require a separately scoped read-only export matching
JSON's `nativeManifest`; they are not supplied by this minimal source export.

4. Preflight the fixed paths on the owned host: physical directories, same entry
   UID, private control files, regular single-link files, no symlinks, special
   files or case-colliding names. Admit only `blobs/[a-f0-9]{64}` and, for mixed,
   the selected apps' `contexts/APP.tar` from the sealed snapshot. Check the full
   snapshot against its manifest before transfer. Use a private local filesystem
   with a 1 GiB quota for this export, at most 100,000 entries and 256 MiB per
   file, and a 180-second transfer deadline. These are conservative **inspection
   limits**, not campaign/measurement overrides or evidence of actual size. If
   the snapshot exceeds them, stop and retain the host; do not truncate it or
   silently enlarge the limits. A timeout/partial transfer is untrusted evidence,
   never permission to restart the job or overwrite an earlier local attempt.

Use a Linux operator workstation with Node 24+, OpenSSH, GNU `timeout`, util-linux
`mount`/`findmnt`/`prlimit`, and explicit local administrator permission to mount **one new
local tmpfs**. This does not grant permission to modify a remote mount or unit.
Allow up to 1 GiB of local memory/swap for evidence; tmpfs is not encrypted storage.
Run as the inspecting user, without `set -x`, terminal recording or credential
logging. Existing authentication and the verified known-hosts file stay in their
existing locations, read-only; never copy them into the workspace. If these local
permissions/resources are unavailable, stop, rather than using an unbounded folder.
Use the trusted system Node binary, not a shell alias or an inherited Node startup
configuration. The task-local `audit_node` below starts **every local Node command
in this procedure**, including validation and controller preview/delivery, in a
fresh allowlisted environment. It drops `NODE_OPTIONS`, `NODE_PATH`, preload/loader
settings and other inherited startup variables before Node starts. Only approved
system tool paths, locale, Git safety settings and existing credential/configuration
locations survive; credential contents are neither copied nor logged. The existing
saved account/context and host-key checks still apply. Do not run a bare `node`
first to construct the clean environment.

From the trusted measured checkout, provision a unique private workspace. The
mount has both a kernel byte quota and an inode quota; a per-process file limit
alone would not bound a recursive download. Keep this shell and its variables for
the remaining steps. Nothing here changes campaign or measurement settings.

```sh
set -eu
umask 077
AUDIT_PATH=/usr/local/bin:/usr/bin:/bin
AUDIT_NODE=/usr/local/bin/node
test -x "$AUDIT_NODE" || AUDIT_NODE=/usr/bin/node
test -x "$AUDIT_NODE"
readonly AUDIT_PATH AUDIT_NODE
audit_node() {
  /usr/bin/env -i PATH="$AUDIT_PATH" HOME="$HOME" \
    XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}" SSH_AUTH_SOCK="${SSH_AUTH_SOCK-}" \
    LANG=C.UTF-8 TZ=UTC GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 \
    "$AUDIT_NODE" "$@"
}
AUDIT_UID=$(id -u)
AUDIT_GID=$(id -g)
WORK_PARENT=$(mktemp -d /tmp/corten-audit.XXXXXXXX)
test "$(realpath -e -- "$WORK_PARENT")" = "$WORK_PARENT"
WORK="$WORK_PARENT/work"
mkdir -m 700 -- "$WORK"
sudo mount -t tmpfs -o "size=1073741824,nr_inodes=100000,mode=0700,uid=$AUDIT_UID,gid=$AUDIT_GID,nodev,nosuid,noexec" tmpfs "$WORK"
test "$(findmnt -n -o FSTYPE --mountpoint "$WORK")" = tmpfs
audit_node --input-type=module - "$WORK" <<'JS'
import assert from 'node:assert/strict';
import { lstatSync, readdirSync, statfsSync } from 'node:fs';
import { physical } from './bench/workloads/isolated/evidence.mjs';
const root = physical(process.argv[2]), info = lstatSync(root), fs = statfsSync(root);
assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o777, 0o700);
assert.equal(fs.type, 0x01021994); // Linux TMPFS_MAGIC.
assert.ok(fs.blocks * fs.bsize > 0 && fs.blocks * fs.bsize <= 1073741824);
assert.ok(fs.files > 0 && fs.files <= 100000); assert.deepEqual(readdirSync(root), []);
JS
EXPORT="$WORK/export"
mkdir -m 700 -- "$EXPORT"
```

Prepare this **trusted operator script locally**, not from downloaded evidence.
It is streamed on stdin to the existing measured `/bench/repo` checkout; it creates
no remote file and does not import source blobs or unpack contexts. `remote` mode
requires the entry UID (root), fixed `/bench` paths, the latest waiting event and
an absent inbox. `local` mode requires this user's private quota-backed export.
Both modes check UID, permissions, types, links, names and sizes **before any file
content is read**. Directory enumeration is incremental and capped, including the
journal census. Controls are capped at 16 MiB each (bootstrap: 1 KiB), all files
at 256 MiB, and the complete requested copy at 1 GiB / 100,000 entries. The sealed
files must remain unchanged throughout inspection; changes fail, not authorize a
second attempt. These are read-only inspections, not an atomic filesystem freeze.

```sh
cat > "$WORK/preflight.mjs" <<'JS'
import assert from 'node:assert/strict';
import { lstatSync, opendirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { deploymentSha256 } from './bench/workloads/deployments.mjs';
import { digest, physical, readRegular, tree } from './bench/workloads/isolated/evidence.mjs';
try {
  const [mode, root, round, commit, campaign, group, token, planHash, subjectHash, waitEvent, ip, knownHosts] = process.argv.slice(2);
  assert.ok(['validate', 'remote', 'local'].includes(mode));
  assert.ok(['json-api', 'mixed-production'].includes(group));
  assert.match(round, /^r[1-9][0-9]*$/); assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(token, /^[a-f0-9]{16}$/);
  assert.match(campaign, new RegExp(`^${round}-[a-f0-9]{16}$`));
  for (const hash of [planHash, subjectHash]) assert.match(hash, /^[a-f0-9]{64}$/);
  const remote = mode === 'remote', mixed = group === 'mixed-production', prefix = mixed ? 'mixed' : 'json';
  const kind = mixed ? 'mixed-review-needed' : 'review-needed';
  assert.match(waitEvent, new RegExp(`^[0-9]{5}-${kind}\\.json$`));
  if (mode === 'validate') {
    assert.equal(root, '/bench'); assert.equal(isIP(ip), 4);
    assert.ok(knownHosts.startsWith('/') && !/["'\\\r\n$%]/.test(knownHosts));
    physical(knownHosts, false); const s = lstatSync(knownHosts);
    assert.equal(s.uid, process.getuid()); assert.equal(s.nlink, 1); assert.equal(s.mode & 0o077, 0);
    process.exit(0);
  }
  const uid = process.getuid(), maxEntries = 100000, maxFile = 256 * 2 ** 20, maxTotal = 2 ** 30;
  physical(root);
  if (remote) { assert.equal(root, '/bench'); assert.equal(uid, 0); }
  else {
    const fs = statfsSync(root);
    assert.equal(fs.type, 0x01021994);
    assert.ok(fs.blocks * fs.bsize > 0 && fs.blocks * fs.bsize <= maxTotal);
    assert.ok(fs.files > 0 && fs.files <= maxEntries);
  }
  function directory(path, privateMode = true) {
    physical(path); const s = lstatSync(path);
    assert.equal(s.uid, uid); assert.equal(s.mode & (privateMode ? 0o077 : 0o022), 0);
  }
  directory(root, !remote);
  const base = remote ? join(root, 'campaign', campaign) : root;
  if (remote) { directory(join(root, 'campaign')); directory(base); }
  const paths = {
    bootstrap: join(root, 'bootstrap-ready.json'),
    reservation: remote ? join(root, 'campaign', '.host-attempt.json') : join(root, 'reservation.json'),
    plan: join(base, 'plan.json'), event: join(base, remote ? waitEvent : 'wait-event.json'),
    subject: join(base, `${prefix}-audit-subject.json`) };
  const sources = join(base, mixed ? 'mixed-audit-sources' : 'audit-sources');
  function names(path, visit) {
    const dir = opendirSync(path); let count = 0;
    try { for (let e; (e = dir.readSync());) { assert.ok(++count <= maxEntries, 'directory entry limit'); visit(e.name); } }
    finally { dir.closeSync(); }
  }
  function waiting() {
    assert.equal(lstatSync(join(base, `${prefix}-audit-delivery.json`), { throwIfNoEntry: false }), undefined);
    let latest = '';
    names(base, name => { if (/^[0-9]{5}-/.test(name) && name > latest) latest = name; });
    assert.equal(latest, waitEvent, 'waiting journal advanced');
  }
  if (remote) waiting();
  else {
    const allowed = new Set(['bootstrap-ready.json', 'reservation.json', 'plan.json', 'wait-event.json',
      `${prefix}-audit-subject.json`, mixed ? 'mixed-audit-sources' : 'audit-sources']);
    names(root, name => assert.ok(allowed.has(name), 'unexpected export entry'));
  }
  const records = new Map(), folded = new Set(); let entries = 0, total = 0;
  const stamp = s => [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs];
  function admit(path, type, cap = maxFile) {
    assert.ok(++entries <= maxEntries, 'copy entry limit'); physical(join(path, '..'));
    const s = lstatSync(path);
    assert.equal(s.uid, uid); assert.equal(s.mode & 0o077, 0);
    assert.ok(!s.isSymbolicLink() && (type === 'directory' ? s.isDirectory() : s.isFile()), 'link/type');
    if (type === 'file') {
      assert.equal(s.nlink, 1); assert.ok(Number.isSafeInteger(s.size) && s.size >= 0 && s.size <= cap, 'file size limit');
      total += s.size; assert.ok(total <= maxTotal, 'copy byte limit');
    }
    records.set(path, stamp(s));
  }
  for (const [key, path] of Object.entries(paths)) admit(path, 'file', key === 'bootstrap' ? 1024 : 16 * 2 ** 20);
  function walk(path, key = '') {
    const lower = key.toLowerCase(); assert.ok(!folded.has(lower), 'case collision'); folded.add(lower);
    const isDir = ['', 'blobs', ...(mixed ? ['contexts'] : [])].includes(key);
    assert.ok(isDir || /^blobs\/[a-f0-9]{64}$/.test(key) || (mixed && /^contexts\/[a-z][a-z0-9-]*\.tar$/.test(key)), 'snapshot path');
    admit(path, isDir ? 'directory' : 'file');
    if (isDir) names(path, name => walk(join(path, name), key ? `${key}/${name}` : name));
  }
  walk(sources); // Complete metadata/size census before readRegular/tree allocations.
  function unchanged(path) { assert.deepEqual(stamp(lstatSync(path)), records.get(path), 'evidence metadata changed'); }
  const controls = {};
  const read = key => { unchanged(paths[key]); const bytes = readRegular(paths[key]); unchanged(paths[key]);
    controls[key] = digest(bytes); return JSON.parse(bytes); };
  const reservation = read('reservation'), plan = read('plan');
  const { campaignSha256, ...planBody } = plan;
  assert.equal(campaignSha256, planHash); assert.equal(deploymentSha256(planBody), planHash);
  assert.equal(plan.round, round); assert.equal(plan.commit, commit); assert.ok(plan.order.includes(group));
  assert.equal(reservation.id, campaign); assert.equal(reservation.commit, commit);
  assert.equal(reservation.campaignSha256, planHash);
  assert.deepEqual(read('bootstrap'), { schema: 'benchmark-common-bootstrap/v1',
    round, commit, token, group: plan.order.length === 1 ? group : 'all' });
  const event = read('event'), status = event.status;
  assert.equal(event.kind, kind); assert.equal(event.campaign, campaign); assert.equal(event.round, round);
  assert.equal(event.campaignSha256, planHash); assert.equal(event.sequence, Number(waitEvent.slice(0, 5)));
  assert.equal(status.campaign, campaign); assert.equal(status.round, round);
  assert.equal(status.campaignSha256, planHash); assert.equal(status.state, 'blocked-review-needed');
  assert.equal(status.auditGroup, group); assert.equal(status.auditInbox, `${campaign}/${prefix}-audit-delivery.json`);
  assert.equal(status[mixed ? 'mixedAuditSubjectSha256' : 'auditSubjectSha256'], subjectHash);
  const started = Date.parse(event.at);
  assert.ok(Number.isFinite(started) && started <= Date.now() && Date.now() < started + 24 * 60 * 60 * 1000);
  const subject = read('subject'), { subjectSha256, ...body } = subject;
  assert.equal(subjectSha256, subjectHash); assert.equal(deploymentSha256(body), subjectHash);
  assert.equal(subject.schema, `benchmark-${prefix}-audit-subject/v1`);
  assert.equal(subject.campaignSha256, planHash); assert.equal(subject.commit, commit);
  const binding = plan.bindings.find(b => b.request.group === group); assert.ok(binding);
  assert.equal(subject.round, mixed ? binding.request.round : `j${2 * Number(round.slice(1))}`);
  if (mixed) assert.equal(subject.bindingSha256, deploymentSha256(binding));
  else assert.equal(subject.sourceSha256, plan.sourceSha256);
  const { sha256, ...manifest } = subject.sourcesManifest;
  assert.equal(deploymentSha256(manifest), sha256);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length <= maxEntries);
  const allowedFiles = new Set();
  for (const file of manifest.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/); assert.equal(file.storedAs, `blobs/${file.sha256}`);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= maxFile);
    allowedFiles.add(file.storedAs);
    const path = join(sources, file.storedAs); unchanged(path);
    const bytes = readRegular(path); unchanged(path);
    assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.sha256);
  }
  if (mixed) {
    assert.deepEqual(subject.requests.map(r => r.identity.app), binding.selection.apps);
    for (const request of subject.requests) {
      assert.match(request.identity.app, /^[a-z][a-z0-9-]*$/);
      const key = `contexts/${request.identity.app}.tar`, path = join(sources, key); allowedFiles.add(key);
      unchanged(path); assert.equal(digest(readRegular(path)), request.identity.contextArchiveSha256); unchanged(path);
    }
  }
  for (const path of records.keys()) {
    unchanged(path);
    if (path.startsWith(sources + '/')) {
      const key = path.slice(sources.length + 1);
      assert.ok(['blobs', ...(mixed ? ['contexts'] : [])].includes(key) || allowedFiles.has(key), 'unreferenced snapshot file');
    }
  }
  assert.ok(isDeepStrictEqual(tree(sources), manifest.snapshot), 'snapshot differs');
  for (const path of records.keys()) unchanged(path);
  directory(root, !remote);
  if (remote) { directory(join(root, 'campaign')); directory(base); }
  if (remote) waiting();
  console.log(JSON.stringify({ subjectSha256, snapshotSha256: manifest.snapshot.sha256,
    controlsSha256: deploymentSha256(controls), entries, bytes: total }));
} catch {
  console.error('Review preflight refused; preserve workspace, state and host.'); process.exitCode = 2;
}
JS
```

After step 2's fresh provider/ownership observation, execute that script on the
exact host. `COMMIT`, `TOKEN`, `PLAN_SHA256` and `SUBJECT_SHA256` are the independently
observed expected values, not automatically trusted fields from a downloaded
subject. `validate` mode checks remote arguments locally before a remote command
is constructed; `GROUP` must be one of the two table rows. This makes the
single-quoted remote arguments literal, not shell input. Use the same reviewed checkout locally and
remotely. The command verifies the remote HEAD and tracked source before importing
the existing readers, clears Node/shell injection variables, bounds remote work
to 30 seconds plus a five-second kill grace, and emits only small integrity hashes
and counts. No credential, environment dump or raw source goes into these records.

```sh
remote_preflight() {
  audit_node --input-type=module - validate /bench "$ROUND" "$COMMIT" "$CAMPAIGN" "$GROUP" \
    "$TOKEN" "$PLAN_SHA256" "$SUBJECT_SHA256" "$WAIT_EVENT" "$IP" "$KNOWN_HOSTS" < "$WORK/preflight.mjs"
  env -i PATH="$AUDIT_PATH" HOME="$HOME" SSH_AUTH_SOCK="${SSH_AUTH_SOCK-}" \
  timeout 45 ssh -F none -oBatchMode=yes -oStrictHostKeyChecking=yes \
  -oUserKnownHostsFile="\"$KNOWN_HOSTS\"" -oConnectTimeout=15 \
  -oForwardAgent=no -oClearAllForwardings=yes -oPermitLocalCommand=no \
  -oControlMaster=no -oControlPath=none "root@$IP" \
  "exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root LANG=C.UTF-8 TZ=UTC GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 /usr/bin/timeout -k 5 30 /bin/sh -c 'cd /bench/repo && test \"\$(git rev-parse HEAD)\" = \"\$2\" && git --no-optional-locks -c core.fsmonitor=false diff --no-ext-diff --no-textconv --quiet \"\$2\" -- && exec node --input-type=module - remote /bench \"\$@\"' sh '$ROUND' '$COMMIT' '$CAMPAIGN' '$GROUP' '$TOKEN' '$PLAN_SHA256' '$SUBJECT_SHA256' '$WAIT_EVENT'" \
  < "$WORK/preflight.mjs"
}
test ! -e "$WORK/before.json"
remote_preflight > "$WORK/before.json"
```

After that successful preflight and another step 2 observation, use this **download-only**
SFTP batch. `IP`, `UNIT`, `ROUND`, `CAMPAIGN`, `WAIT_EVENT`, `SUBJECT`, `SNAPSHOT`,
`KNOWN_HOSTS` and `EXPORT` are explicitly checked values from steps 1-4, not paths
selected by a receipt. Validate the campaign as `ROUND-[a-f0-9]{16}` and the event
as five digits plus the table's exact waiting kind and `.json`; choose subject
and snapshot from the table. Local paths must be absolute physical paths without
quotes, backslashes, newlines or SSH expansion characters (`$`, `%`). `EXPORT`
must be fresh, mode 0700, quota-limited, and disjoint from state and checkout;
use `umask 077`. In particular, **the snapshot destination must not exist**:
OpenSSH `get -R` adds basename nesting when its destination already exists.
Do not precreate it or reuse an earlier attempt. The shell variables below contain
no credential material. The empty-directory test includes dangling symlinks.
`prlimit` enforces the 256 MiB per-file write limit during transfer too; a growing
remote file fails this inspection, not the waiting job.

```sh
case "$GROUP" in
  json-api) SUBJECT=json-audit-subject.json; SNAPSHOT=audit-sources ;;
  mixed-production) SUBJECT=mixed-audit-subject.json; SNAPSHOT=mixed-audit-sources ;;
  *) exit 2 ;;
esac
audit_node --input-type=module - "$EXPORT" <<'JS'
import assert from 'node:assert/strict';
import { opendirSync } from 'node:fs';
const dir = opendirSync(process.argv[2]);
try { assert.equal(dir.readSync(), null, 'export is not fresh'); } finally { dir.closeSync(); }
JS
test ! -e "$EXPORT/$SNAPSHOT" && test ! -L "$EXPORT/$SNAPSHOT"
env -i PATH="$AUDIT_PATH" HOME="$HOME" SSH_AUTH_SOCK="${SSH_AUTH_SOCK-}" \
prlimit --fsize=268435456:268435456 -- timeout 180 sftp -F none -oBatchMode=yes -oStrictHostKeyChecking=yes \
  -oUserKnownHostsFile="\"$KNOWN_HOSTS\"" -oConnectTimeout=15 \
  -oServerAliveInterval=15 -oServerAliveCountMax=2 \
  -oForwardAgent=no -oClearAllForwardings=yes -oPermitLocalCommand=no \
  -oControlMaster=no -oControlPath=none -b - "root@$IP" <<EOF
get /bench/bootstrap-ready.json "$EXPORT/bootstrap-ready.json"
get /bench/campaign/.host-attempt.json "$EXPORT/reservation.json"
get /bench/campaign/$CAMPAIGN/plan.json "$EXPORT/plan.json"
get /bench/campaign/$CAMPAIGN/$WAIT_EVENT "$EXPORT/wait-event.json"
get /bench/campaign/$CAMPAIGN/$SUBJECT "$EXPORT/$SUBJECT"
get -R /bench/campaign/$CAMPAIGN/$SNAPSHOT "$EXPORT/$SNAPSHOT"
EOF
```

The batch contains no `put`, `mkdir`, `rename`, removal or remote shell escape.
No remote archive or controller-state file is created. Enforce the local quota
and preflight before recursive transfer, not just a size check after downloading.
Keep partial attempts separate; never merge them with a later download.

5. Recheck ownership and the same live unit, latest event name/bytes, reservation,
   plan, subject, snapshot and unchanged local controller state **after** transfer.
   Require equality with the first
   observations and an absent inbox. If the job exited, advanced, expired or any
   byte/identity changed, the copy cannot support delivery. Preserve it as a
   failed inspection; use ordinary collection only when independently terminal.
   The entry's existing 24-hour review wait and the unit's 48-hour lifetime keep
   running during inspection/review. Never extend either deadline. Require review
   to finish before the earlier deadline; do not treat a still-active stopping
   unit or an old waiting event as fresh authority.

After step 5's fresh ownership/unit observations, run the **same** remote preflight
again, then inspect locally from the trusted checkout. Only the script's input
mode/root changes; the expected identity stays fixed. Byte-for-byte equality of
the small summaries binds the before/after control bytes, full snapshot and local
copy. Neither hashing nor a successful comparison is independent audit approval.

```sh
test ! -e "$WORK/after.json" && test ! -e "$WORK/local.json"
remote_preflight > "$WORK/after.json"
audit_node --input-type=module - local "$EXPORT" "$ROUND" "$COMMIT" "$CAMPAIGN" "$GROUP" \
  "$TOKEN" "$PLAN_SHA256" "$SUBJECT_SHA256" "$WAIT_EVENT" \
  < "$WORK/preflight.mjs" > "$WORK/local.json"
cmp -- "$WORK/before.json" "$WORK/after.json"
cmp -- "$WORK/before.json" "$WORK/local.json"
```

6. Give a fresh independent reviewer the verified subject, complete snapshot and
   applicable native audit contract (`isolated/json-staging.mjs` plus
   `json-api/contract.mjs`, or `isolated/mixed-staging.mjs` plus the mixed native
   build-context contract). Source names are data in `sourcesManifest.files`;
   read their `storedAs` blobs, never reconstruct paths from untrusted names or
   run package/build hooks. Contexts are retained byte-for-byte and hashed as tar
   files; inspect their content only in a separately bounded offline sandbox with
   traversal/link/special-file rejection, no credentials or host mounts. The
   reviewer must inspect semantics, every required native receipt identity and
   source claim, not just endorse matching hashes. JSON's exact image identities
   cannot be replaced by a prelaunch/source-only receipt. Mixed's scope is
   committed source/context, **not** a review of a subsequently built image.
   Unresolved findings or insufficient evidence mean no approved delivery.
7. Only after independent review and explicit operator approval of this exact
   subject, use the existing delivery command against the **same child state
   root**, group and campaign. Preview and independently approve its exact action
   hash; never automatically feed preview output into execution:

```sh
audit_node bench/workloads/cloud-production.mjs ROUND --state-dir SAME_CHILD_ROOT --deliver-audit ABSOLUTE_REVIEW_FILE --audit-group GROUP --campaign CAMPAIGN --approve-subject REVIEWED_SUBJECT_SHA256 --print-approval
audit_node bench/workloads/cloud-production.mjs ROUND --state-dir SAME_CHILD_ROOT --deliver-audit ABSOLUTE_REVIEW_FILE --audit-group GROUP --campaign CAMPAIGN --approve-subject REVIEWED_SUBJECT_SHA256 --approve-reviewed-merged-ready REVIEWED_ACTION_SHA256
```

Delivery still rechecks live ownership, waiting group/inbox, nonce-bound state and
exact canonical subject, records its single durable attempt and cannot overwrite
an inbox. The live process, not the exported JSON, accepts the full native receipt
and advances. A delivery result of 3 is not qualification; a failed/uncertain
attempt is not automatic retry authority. Observe normally, then use the existing
separately approved `--collect` only after the exact unit is terminal. Terminal
archive integrity, native replay, exit agreement and cleanup/deletion gates remain
unchanged. This manual export does not exercise or qualify those operations;
real target-host transport and review-to-delivery composition still need verification.

Keep the tmpfs mounted while inspection/review needs its bytes, including after a
failed or partial transfer. Do not reuse it for another attempt. After the owning
operator has explicitly retired this local copy (and retained any required evidence
through a separately authorized bounded destination), release **only this unique
local mount**. This discards its contents; there is no automatic exit trap that
could erase failure evidence, recursive deletion, lazy unmount or remote cleanup:

```sh
test "$(realpath -e -- "$WORK")" = "$WORK_PARENT/work"
test "$(findmnt -n -o FSTYPE --mountpoint "$WORK")" = tmpfs
sudo umount -- "$WORK"
rmdir -- "$WORK"
rmdir -- "$WORK_PARENT"
```

## Readiness And Verification

Fresh independent exact-head review cleared the provider worker-snapshot security
repair, including the complete executable closure and pre-unlock shutdown boundary.
Synthetic Windows and Linux checks cover an ordinary native stdin-entry positive,
post-hash/pre-launch replacement of every bound source without marker execution,
parent startup diagnostics deleted before import, and normal versus withheld worker
shutdown. These controls use synthetic credentials/source dependencies, not actual
account stores or provider operations. Their scoped clearance is not campaign validity.

The parent also has local integrated cloud/core test evidence. Neither local tests
nor independent provider review substitutes for merged CI, official-source
qualification or complete native producer/OS/validator evidence. Those remain pending;
there is no official launch authorization or overall readiness claim here.

The current bridge was read with `git show` against the parent-integrated core
Git tree `sha1:b37727d761c0726af36d41e77d6693c59cb0033c`; no core files were
imported into this cloud-owned branch. Exact inspected LF blob bytes are:

- `isolated/campaign-entry.mjs`: `sha256:b99b5e44231ac7cf7c268a30684d3d403468b264860577d4cc63ccd1d92ab5b0`.
- `isolated/campaign-verify.mjs`: `sha256:1218b873813508491a5ea05290e3152909abbde33373d9beaba80c90f190eb4d`.
- `isolated/json-staging.mjs`: `sha256:12127bb9e95034ebbb0c3ddcd72d15c06fdc58599b79b345c43ef66fe547277c`.
- `isolated/mixed-staging.mjs`: `sha256:21b6907e0c328ca7285db2212b69465ec166073fd88aa1bcf338b680fc787ea8`.

These are content/Git-tree digests, not published commit references. Its entry supports both fixed inboxes
and its inspection returns `verified` for intrinsic all-group completion. The
mapping above consumes that exact schema, not the historical proposal below.
The parent has integrated the reviewed bridge/core and provider implementation;
that integration does not supply the remaining readiness evidence above.

## Historical Evidence And Proposals

The earlier named-context pre/post-account probes did not freeze credentials:
rebinding and restoring the context could target a foreign account. An intermediate
in-memory provider then exposed synthetic Authorization values through native HTTPS
diagnostics. Environment-only preflight was insufficient when startup diagnostics
survived deletion of `NODE_OPTIONS` before import. Later worker probes found an
incomplete executable closure, shutdown uncertainty after lock release, and entry
replacement after the parent's hash but before native launch. These were actual
failing/red synthetic controls, not real-account operations. They motivated the
now-reviewed worker-snapshot design above; they are not unwaived current P1 findings.

The following base reads, proposed seams, pending statements and measured repair
results describe their historical checkpoints, not the current readiness disposition.

Base read: `41a84f57273b8c1c40e5822e815fc3e94edc6df0`. An earlier private
campaign checkpoint's API unconditionally returned
blocked/failed/invalid, `qualified:false`, `controllerReady:false` and
`deletionAuthorized:false`. Even manifest-verified is byte integrity, not independent
review, complete native production/OS evidence, source qualification or readiness.
At that earlier checkpoint, reported review findings included native-abort sequencing, incomplete
command-intent/started/exited pairing, and archive-controlled raw assertion leakage.
Those findings belong to its author. This controller does not fix or clear
them. Future `verified` reports are refused until their contract is actually reviewed
and integrated; no speculative success schema is implemented here.

The catalog raw work and client saved-verifier imports reported by the parent do
not change this pinned base or remove those remaining producer/OS/native blockers.
No real campaign, native benchmark, cost measurement or cloud resource was used.

The parent reported an earlier reviewed lifecycle imported byte-identically at
an earlier integration, with 40 passing tests. This worktree remains
on its original base plus its own commits; no integration files were imported.
The production continuation read the campaign entry, saved verifier, journal,
source/worker and import closure in the then-active author worktree. That worktree had active author edits;
none were imported or executed. Its API still uses
`validateCampaign({folder, round, commit})`, current statuses blocked/failed/invalid,
manifest integrity, command lifecycle and pending-root diagnostics. The local
pinned integration does not contain the complete 13-module production closure;
the approval preview lists the missing paths. Presence is only an integration
check, not native readiness. At that historical checkpoint, a real
local-only detach preview returned 2, listed 12 missing modules (the offline
contract already exists), reported `fullGroupQualified:false`, and created no
state directory. That preview invoked local Git only, never doctl/SSH/SCP.

### Historical Campaign Handoff

Offline intrinsic validity is distinct from source/host trust. Do not require an
impossible signature authenticating a native capture as a permanent qualification
barrier. The proposed composition for the campaign author/integrator is:

1. The fixed read-only API replays every selected group's complete raw artifacts,
   admission/gates, source/image bindings and command intent/start/exit lifecycle.
   It returns exact round/commit/campaign/selection identity, sealed full-tree
   integrity, no pending or uncollected roots, per-group proof including all nine,
   and a separate intrinsic-valid verdict. Honest blocked, incomplete, failed or
   unimplemented groups remain explicit. Public errors must be bounded/sanitized.
2. The trusted live controller independently establishes the operator-approved
   merged source, exact uploaded code, provider ID/name/shared+unique tags/size/
   region/IP, and the exact started owned unit's terminal/no-live-PID state before
   and after collection. It binds those observations to the hash of the original
   archive and its safe extracted tree. These observations come from the live
   process/provider boundary, never imported `approved`/`trusted` JSON fields.
3. Fully qualified success is the conjunction of intrinsic-valid complete current
   all-nine evidence and that live source/host context, not a report claiming to
   authenticate its own capture. Deletion remains a separate terminal-ownership
   and complete-preservation decision. Saved replay alone cannot authorize it.

Required author handoff: retain the exact fixed entry argv/state-root; confirm the
terminal result/manifest and audit inbox contracts; provide the versioned intrinsic
verdict, exact registry/selection identity and complete per-group raw/gate/lifecycle
results without requiring provider ownership from offline replay. Agree on fields
and reviewed fixtures before widening the current report acceptance. The current
core intentionally still refuses speculative success schemas and returns only
blocked/failed terminal cleanup (1), running (3), or preserved errors (2). Its
unconditional false qualification is a temporary integration limitation, not the
intended final composition or an additional cryptographic requirement. None of
these proposed fields has been invented as passing native evidence in this slice.

#### Historical API Proposal Pending Agreement

Read-only inspection of an earlier private author tree confirmed the three-key API and fixed
entry above. Its verifier is still synchronous, has only three native adapters,
and returns blocked/failed/invalid, never verified. The worker already awaits an
async return without changing those input keys or passing host/approval context.
The planned native `inspectSaved(binding, folder)` adapters belong behind that
fixed campaign API, not in cloud CLI options. Nothing from the unfinished sibling
tree is imported or copied into this controller.

The following is a proposed exact **success return**, not an agreed or currently
accepted schema and not a manufactured passing fixture:

```js
({
  schema: "benchmark-isolated-campaign-inspection/v1",
  scope: "intrinsic-evidence",
  status: "verified",
  round, commit, campaign,
  campaignSha256, sourceSha256,
  selection, // exactly cloud-contract.mjs selection(), including apps/contracts
  groups, // exact fixed order, one record per group, described below
  collectionIntegrity: "manifest-verified",
  commandLifecycle: "observed-terminal",
  uncollectedNativeRoots: [],
  archiveTreeSha256, reservationSha256,
  blockers: []
})
```

Each group record has exactly `group`, `outcome:"native-validated"`,
`bindingSha256` and `nativeManifestSha256`. The binding hash uses the existing
`deploymentSha256` on the exact fixed timing binding (JSON includes the fixed
accepted receipts path); the native manifest hash is the verified timing tree
seal. `campaignSha256` and `sourceSha256` come from the rebound measured plan.
All hashes are full lowercase SHA256; round/commit/campaign must match the input
and reservation. Success means every current all-nine native adapter actually
replayed raw samples, gates, resources, source/image/invocation identities and
paired started/exited command lifecycles, including JSON accepted bundle/source
binding and preparation-to-timing linkage. Merely returning these fields, passing
a summary, retaining nine names or replaying preparation is not that validation.
No provider trust, human approval, `qualified`, `controllerReady`, isolation or
deletion-authority claims belong in this intrinsic schema.

`archiveTreeSha256` retains the author's existing meaning: the canonical native
`tree(folder).sha256` over the entire `campaign/` root, including its reservation,
not the gzip hash or the controller's different whole-extraction tree hash.
`reservationSha256` hashes raw `.host-attempt.json` bytes. Consumer integration
must independently bind these to the exact inspected snapshot with that specified
canonical tree algorithm, not compare unlike hashes or trust a saved seal field.
The existing controller gzip/extraction before-and-after checks remain required.

For blocked/failed inspection, preserve the same identity/seal/lifecycle fields
where valid, all nine actual outcomes, bounded diagnostics and explicit blockers;
do not promote missing evidence into verified. Pending original roots keep the
current exact record shape `{group, phase, artifactRoot}`: phase is `prepare`
(JSON only) or `timing`, and the path equals that phase's fixed binding-relative
native artifact root. No arbitrary absolute path or transport instruction is
accepted. A nonempty list, missing collection seal or incomplete lifecycle means
exit 2 with host/evidence preserved, even if copied files exist. Every retained
terminal native tree needs a journal commitment even when cancellation/boundary
failure prevents `group-finished`; terminal does not mean successfully validated.

The integration change must replace the temporary unconditional false/exit-1
branches only after this seam is agreed, implemented and independently reviewed:
intrinsic verified + native CLI exit marker 0 + controller-observed approved
merged source/upload hashes/exact owned started terminal unit + unchanged safe
archive/tree + no pending roots + confirmed deletion yields qualification/exit 0.
Complete sealed blocked/failed evidence plus safe confirmed deletion yields 1;
errors/uncertainty yield 2, running yields 3. Recollection must revalidate bytes
and durable controller provenance, never accept a saved true flag as authority.
Offline verified alone never authorizes host access or deletion, and is not
required to cryptographically authenticate capture. Real operator approval for
JSON receipt delivery remains external to receipt JSON.

Pending author closure at that inspected head: reviewed fixes for timing JSON
receipts not bound to the accepted bundle/sources and halted terminal native
folders lacking a journal seal before group finish; full async native adapters,
producer/OS validity, agreed versioned return and native CLI zero semantics.
These findings were reported by the parent, not cleared by controller tests.
The proposed fields and current API agreement still require author confirmation.

### Historical Verification

Focused tests (fake provider/process controls, local temporary files, a local
lock-holder child and synthetic local validator workers only):

```sh
node --test --test-concurrency=1 bench/workloads/cloud-contract.test.mjs bench/workloads/cloud-controller.test.mjs bench/workloads/cloud-audit.test.mjs bench/workloads/cloud-bridge.test.mjs bench/workloads/cloud-native.test.mjs bench/workloads/cloud-validation.test.mjs bench/workloads/cloud-transport.test.mjs bench/workloads/cloud-provider.test.mjs bench/workloads/cloud-diagnostics.test.mjs bench/workloads/cloud-credentials.test.mjs bench/workloads/cloud-production.test.mjs bench/workloads/cloud-remote.test.mjs bench/workloads/cloud-signals.test.mjs
```

The existing cloud-contract suite passed before implementation. The added suites
exercise lost/crashed creates, start loss, active/missing/foreign units, live and
dead locks, concurrent collect, state/path aliases, hostile archives, hash/tree
mutation, interrupted extraction, cancellation, uncertain deletion and audit races.
The test fixtures are manufactured apparatus inputs, never passing native results.
The earlier independent exact-head review
identified high-bit exit-marker acceptance and implicit-directory expansion before
the tree limit. Permanent tests reproduced both failures before these repairs;
the original 30 tests still passed. A separate test reproduced the unbounded
inspection cancellation. Added checks exercise the roughly 25 KiB compressed
archive bomb (over 126,000 implied nodes) without writing it, the unchanged exact
100,000-node boundary, pre-write component/depth/absolute-path bounds, stalled-inspection locks, late
results, and cancellation/deadline termination of a synchronously busy fake native
validator. These repairs require fresh independent review; they do not clear the
native campaign findings above.

Measured focused repair result: 40 passed, 0 failed, 0 skipped.

Production continuation adds shell-mocked composed transport tests for approval,
missing integration, clean/merged source, source/state changes, upload hashes,
one-shot launch, running/terminal collection, foreign identity, cancellation and
uncertain deletion. Process-boundary tests cover timeout/signal/overflow/spawn
failure classification, literal stdin scripts, credential isolation, argv and
SFTP path handling. Remote-script tests check fixed provisioning/entry/unit,
source provenance and collision-preserving archive publication. These are fake
provider/process tests, not real provisioning or native readiness evidence.
Measured combined production-continuation result: 57 passed, 0 failed, 0 skipped.
`git diff --check` passed. The original 40 lifecycle/archive/audit/validation tests
remain included. The new transport has not had independent review or been merged;
its author's passing tests do not confer production approval.

Follow-up boundary regression first failed because the private campaign root was
absent from the generated job, then passed after exclusive creation was added.
Additional synthetic worker tests cover awaited async success with exactly the
three frozen API keys and sanitized async rejection. Script checks are structural
and process/provider tests are mocked; no remote provisioning script was executed.
Measured combined follow-up result: 60 passed, 0 failed, 0 skipped. The previously
reviewed lifecycle/archive core remains unchanged in this follow-up.

The subsequent signal repair changes control calls to awaitable operations while
keeping the ownership/reservation/archive/deletion rules. Permanent Linux tests
use actual OS SIGTERM from a local Node subprocess while the controller blocks
inside a fake command, with the real `productionSignals()` handlers and production
composition. Before the repair, all nine scenarios reproduced late cancellation:
create could lead to start, final terminal/ownership checks could lead to delete,
and audit transfer could lead to publication. After repair they require exit 2,
cancellation observed before return and zero subsequent external commands.
Fetch, create, upload, install, start, final terminal observation, final ownership,
in-flight deletion and audit upload are covered, including preserved archive and
one-attempt uncertain intents. These tests run in network-disabled Linux with
only injected fake Git/provider/SSH/SCP results, never those external executables.
The Linux-only signal suite is explicitly skipped on Windows, whose POSIX signal
semantics differ; the original 60 tests still run there. The deadline test now
waits for inspection to begin before advancing its fake clock, without changing
the deadline or lock/evidence assertions. This repair is not independent review
clearance or native-composition readiness; success remains disabled until that
separate agreed native contract and external trust composition are integrated.
Measured repair checks: network-disabled Linux 70 passed, 0 failed, 0 skipped;
Windows 60 passed, 0 failed, 1 explicit Linux-signal-suite skip. Both include the
original 60 tests. `git diff --check` passed. No real cloud executable or remote
provisioning script was run; local verification containers used no network and
were automatically removed.

The resolved-state-path repair adds permanent fake-only controls for preview and
approved launch through an alias to a `$`-bearing physical directory, including
missing trailing directories. The negative control first failed with `Missing
expected rejection`; after repair it requires no approval output, Git/provider/
SSH calls, state creation, allocation or deletion. A separate ordinary alias with
spaces/apostrophes still previews and launches exactly once. Windows production
checks: 12 passed, 0 failed, 0 skipped. These are synthetic transport controls,
not real cloud execution or native readiness evidence.

The physical-root follow-up first reproduced an unbounded walk with a child
process reaching its five-second timeout. Permanent child controls now require
bounded refusal without process calls for synthetic ENOENT, EACCES, EPERM,
ENOTDIR and ELOOP, plus an actual missing Windows drive. Child scratch state is
owned by the parent test so timeout cleanup remains possible. Normal missing
directory tails still preview read-only and can be created by core setup.
Windows cloud checks: 65 passed, 0 failed, 1 explicit Linux-signal-suite skip.
An initial bind-mounted Linux run at the alias-repair checkpoint was not green: 66 passed,
4 failed and 2 cancelled, with empty signal-probe JSON and the signal parent's
60-second timeout. A later staged attempt also omitted an audit dependency;
neither result is full verification or clearance.

No dependencies were added. No renderer, runtime or request path changed, so those
performance measurements are inapplicable. Per the bounded ownership and fake-only
instruction, broader repository Rust/browser/container checks, package/check-script
integration, guide/changelog changes and an independent agent review are not done
here. This author checkpoint and self-check are **not review clearance**. Parent
integration owns those checks and review before removing any guard or proposing a run.
