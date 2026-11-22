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
for the complete nine-group selection, [reserved host placement](#dedicated-group-hosts), fixed remote files,
systemd unit and archive namespace. There are no adapter, provider, workload,
deployment, environment or numeric-settings CLI overrides. Popular/performance
views share evidence; they do not launch a second campaign.

## Public Source Permissions

Fresh hosts and the CI tools image install stable upstream Git from the same
Ubuntu Git maintainers' PPA. They fetch its public key over bounded HTTPS, require
the exact primary fingerprint `F911AB184317630C59970973E363C90F8F1B6217`, and scope
APT trust to that source with `signed-by`. This avoids the Launchpad metadata API
whose truncated responses stopped image preparation before tests. A failed
download, key parse or fingerprint check stops setup; distribution Git is not a
fallback. The existing immutable-source Git capability check still runs.
`git-ppa.test.mjs` executes both setup forms with local command fixtures, including
wrong, extra and missing primary keys and failed downloads/parsing. This is not
native framework or official-run qualification.

The production adapter in `cloud-remote.mjs` keeps the job at `umask 077` but
runs only the fixed public Git clone, fetch and exact detached checkout in a
`umask 022` subshell. Committed nonexecutable scripts are `0644` under `0755`
directories, so unprivileged load generators can read the read-only source bind
mounts. The same bootstrap serves legacy all-group and every dedicated-group job.
The source URL, merged-main ancestry, exact HEAD and clean-checkout checks remain
mandatory. There is no recursive permission repair, contender-user override or
change to measured templates, gates or workload settings.

The subshell does not change the parent job's private defaults. Provenance logs,
bootstrap markers and subsequent state files remain `0600`; the exclusive campaign
root and its private subdirectories remain `0700`. Source readability is not
permission to open campaign evidence or uploaded control files.

`cloud-remote.test.mjs` includes a real Linux filesystem/Git regression. It redirects
only the fixed public URL's transport to a local fixture repository, prohibits
network protocols, and executes the generated clone/fetch/checkout shape against
an older merged commit. A UID/GID 65534 reader with no root groups reads exact
committed load-script bytes from the bind-root-equivalent working directory.
The restrictive-umask negative control must still fail with `EACCES`; both paths
must leave source clean and control/campaign files private. Success leaves the
parent shell in `/bench/repo`. Real clone failure and an index-locked checkout
must retain their nonzero exits and the parent's private umask for EXIT-handler
output, without continuing to native entry. Run alongside the
bootstrap and contract tests:

```sh
node --max-old-space-size=256 --test --test-concurrency=1 bench/workloads/cloud-remote.test.mjs bench/workloads/cloud-bootstrap.test.mjs bench/workloads/cloud-contract.test.mjs
```

The permission regression explicitly skips outside Linux or without root to
launch the nonroot reader. It runs no provider, SSH, native workload or framework
build. These controls do not qualify an official source or establish cloud-run
readiness; this repair still requires independent source review before merge.

## Dedicated Group Hosts

A new dedicated fleet uses `benchmark-group-fleet/v5`. The `catalog-page`
job still reserves `c-16/sfo2` with `c16-generator-v1`. That layout gives the
catalog load generator CPUs 4-15; app, upstream and probe placement and budgets
do not change. Before spending, the fleet checks that the catalog placement and
at least one supported `c-8` placement are advertised in both the size and
region listings. That first check does not set aside provider capacity.

After catalog is verified and its host is deleted, the remaining preview
checks again. It selects one common `c-8` region for all remaining groups,
in preference order: `sfo3`, `sfo2`, `lon1`, then `blr1`. Review the actual
region in that preview. If none is available, wait without starting a host or
consuming the remaining attempt. If the proposed region changes before
admission, obtain a fresh preview and approval. Once the remaining intent
is recorded, do not substitute another region or retry a subset. Nonfleet
all-group hosts still use `c-8/sfo2`.

Saved v1 (sfo2), v2 (sfo3), v3 (catalog `c-16/sfo2`, siblings
`c-8/sfo3`), and v4 (siblings pinned to one San Francisco region at
preparation) fleets keep their original placements, rosters and receipts. The
new controller can read them for inspection and independently authorized
recovery, never for new detach or remaining admission. A fleet such as r23 or r24
stays on its original measured controller and existing checks; it can only
admit the remaining children at their recorded placement, if it returns and
the existing approval gates pass. Ordinary
collection still needs the original measured checkout; the existing
merged-controller recovery actions still have their exact eligibility and
approval requirements. Do not rewrite a saved reservation or reuse its approval.
Do not compare timings across placements.

A fleet binds the complete current registry to one dedicated host per group. The
hosts run in parallel; contenders and phases within a group retain their native
ordering, correctness checks and measurement settings apart from the catalog
load generator's placement and CPU budget. A group host
builds and runs only its group's complete selection, not a filtered list of apps.
Popular and performance views still share the same measurements.

`cloud-contract.mjs::fleetPlan` fixes the round, measured source, account/context,
SSH key, host configuration and a unique ownership token for every registry group.
The full roster and selection are hashed before launch. A host reservation retains
that complete roster but has the distinct `benchmark-dedicated-group-host/v1`
schema and exactly one group's selection. The manifest binds the chosen
placement and catalog layout; the provider checks the exact launch mode before
accepting create, and the collector checks the placement and layout returned by
native replay against the reservation. No operator size, region or layout override is accepted.
Legacy all-group reservations remain readable and cannot
acquire group-selection fields after reservation.

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
checks clean committed source and reads the DigitalOcean size and region catalogs
in the saved account/context, through a credential worker with create disabled.
It needs `sizes:read` and `regions:read` in addition to the account read.
The size and region entries must both list each advertised pair and both be
marked available. An optional region absent in both directions is unavailable;
incomplete listings, disagreement or no qualifying pair stop preparation
without a saved fleet. This is
advertised availability, not a stock or quota guarantee. It uses no trial
create and neither allocates a host nor authorizes execution:

```sh
node bench/workloads/fleet.mjs ROUND --fleet-root ABSOLUTE_ROOT --prepare --commit SHA --ssh-key KEY --account-id ACCOUNT --context CONTEXT
node bench/workloads/fleet.mjs ROUND --fleet-root ABSOLUTE_ROOT --detach --print-approval
node bench/workloads/fleet.mjs ROUND --fleet-root ABSOLUTE_ROOT --detach --approve-reviewed-merged-ready REVIEWED_EXACT_HASH
```

Preparation returns 3 with a saved `fleet-ROUND.json`. The detach preview uses
no provider access. The remaining preview reads the provider catalog after
catalog replay to propose a region; neither preview can create a host. Independently
review its exact source, physical root, complete roster and every contained child
subject before supplying the batch approval. Source review and merged native
readiness remain prerequisites; never automatically feed a preview into execution.
The launch intent is durable before any child starts and prevents a second launch,
including after partial failure. Initial detach rechecks both reserved sizes
before consuming its intent and before the first create. Remaining admission
and its children recheck only the exact `c-8` placement bound into the reviewed
remaining approval. Those checks refuse a missing pair; they never substitute
another region after approval.
`fleet-placement-preflight-failed: STAGE` identifies the failed placement check:
transport construction or close, either account read or identity check, catalog read or
validation, the checkpoint before region selection, or region selection itself.
The first account read also starts the worker and waits for its handshake:
`first-account-read-or-worker-start` does not mean a request was sent. Only a safe
provider code and HTTP status may follow the stage, with fixed flags if transport
close also failed or custody is uncertain. No account data or response body is
printed. Inspect the failed check rather than editing any manifest. An
acknowledged catalog HTTP denial or a fully received but invalid
listing stops without a create and releases settled locks. A truncated response,
timeout or disconnected worker does not establish settlement; the lock stays.
An already recorded launch intent still cannot be replayed. Each child has an
independent state directory, operation lock, private credential worker and remote
systemd unit.
Every group in the roster uses the same commit. Merge the repairs needed by
the entire round before preparing it: the first group's results cannot be
carried into a new fleet reservation for a different commit. Use an
[independent continuation](#independent-group-continuation) instead.

Admission is staged, not a simultaneous fleet allocation. The first `--detach`
approval launches only the first complete registry group. Untouched groups remain
visibly deferred during initial launch and collection, and the fleet remains
incomplete. The first group is an official measurement, not a separate setup-only
run that would be repeated later. Its bound running state and common-bootstrap
marker remain required launch observations, but cannot open the remaining fleet.
The marker observation is bounded to 45 minutes, checks cancellation and preserves
the running host on timeout or an invalid observation; it is not native parity or
performance evidence.

After collecting that same first group, preview and independently approve the
separate remaining-admission action:

```sh
node bench/workloads/fleet.mjs ROUND --fleet-root ABSOLUTE_ROOT --admit-remaining --print-approval
node bench/workloads/fleet.mjs ROUND --fleet-root ABSOLUTE_ROOT --admit-remaining --approve-reviewed-merged-ready REVIEWED_EXACT_HASH
```

That action replays the first group's intrinsic native evidence, archive/tree
hashes, complete selection, source/provenance and confirmed host deletion. Only
the authoritative `verified` campaign can open it; valid failed or unsupported
competitor outcomes are still retained under that contract. A synthetic inspector,
bootstrap marker, status string or diagnostic receipt cannot substitute for native
replay. That replay reads this checkout's bench install: without it, the preview
lists the first group as `replay-blocked`, missing
`local bench install missing or differs: run npm --prefix bench ci`, returns 2
and does not replay. The new approval binds the first evidence snapshot and every
remaining child subject. Execution rechecks the snapshot under the fleet lock, consumes an
exclusive remaining intent and rechecks before each child dispatch. Consumed or
legacy launch intents cannot acquire this new admission authority.

The remaining hosts are provisioned one at a time, but their measurements run
in parallel. The next host may be admitted after its predecessor has a unique
host identity, a sealed bootstrap and a live registered monitor. A provider
status of `running` is not enough. Contenders, profiles and measurement parameters are unchanged. A
failed admission or cancellation leaves every later group visibly `not-admitted`,
not silently omitted or automatically retried. The complete reserved roster
remains mandatory. Later groups must also be observed nonterminal before running admission is saved.
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

Keep the local fleet launcher alive while its groups run. A completed worker's
receipt can say `collection: separate-child-approval-required` while another
worker still holds the fleet lock. Collect that completed host promptly using
its own existing group state directory rather than waiting for the slowest group:

```sh
node bench/workloads/cloud-production.mjs ROUND --state-dir ABSOLUTE_GROUP_STATE_ROOT --collect --print-approval
node bench/workloads/cloud-production.mjs ROUND --state-dir ABSOLUTE_GROUP_STATE_ROOT --collect --approve-reviewed-merged-ready REVIEWED_EXACT_HASH
```

Review the exact child collection action. Do not clear a lock or infer remote
termination from a lost local connection. A pending result preserves the host;
verify the terminal evidence, saved archive and confirmed deletion separately
for each group before reporting the fleet as complete.

**Collection after systemd forgets an exit.** For a closed supervised run, the
acknowledged start, registered terminal monitor and native seal prove the run
started and finished. An inactive, dead unit with no retained start time or
exit type does not prove that by itself. The collector checks the expected unit
and boot, no queued job, PID, populated service cgroup, running container or
benchmark process, then downloads the existing exit archive without repacking.
Only ordinary collection with positive systemd exit history may run `pack.sh`
when the archive entry is definitely absent. Expired history and pinned r21
recovery always require the original exit archive. Local native replay must
agree with the monitor. The collector rehashes the archive, then checks the
same inode and timestamps, idle host and unit in a fresh 60-second window.
Account and ownership reads precede that final observation. Immediately before
writing delete intent the collector also checks that the local archive is still
the same unchanged file it hashed. A unit query's acknowledged exit is recorded
even on cancellation; a nonzero exit stops collection, and a missing guardian
acknowledgement retains uncertain custody.

The controller persists delete intent before dispatch. Only positive proof
that this very DELETE was never sent clears that intent for a separately
approved collection; HTTP errors, timeouts after send, lost replies and
crashes with an intent permit absence reconciliation only. There is no
automatic retry. A live, never-started, unsupervised
or invalid-monitor run cannot use this proof. Target failures remain results,
not successful timings or a publishable baseline.

**Terminal native failures.** Ordinary approved child `--collect` at the measured
checkout also handles a dedicated supervised run that ended with raw exit 2
after native entry. It retains the original wrapper without repacking and saves
`failed-native-results.tgz` plus a verified extraction. Custody covers the entire
campaign and the fixed native output path (both prepare and timing for JSON),
including a record of any output path proved absent. The archived plan and
pending list are checked against the reservation; neither chooses what to copy
or authorizes deletion. No failed data enters native replay or becomes timings.
If native validation finished but sealing or later collection failed, raw
exit 2 permits custody only. The collector keeps both archives, leaves the host
in place and returns 3. It does not create a retirement intent.

On Windows, after SSH acknowledges the bootstrap seal, the controller can
briefly retry a local rename that reports `EPERM`. It rechecks the same staged
file, canonical state and owner locks before retrying. It never repeats SSH or
uses an abandoned temporary file, and stops on cancellation or deadline.
If the monitor already settled with a terminal receipt, the controller can
record it from the unchanged canonical ledger. A later collection still
requires the normal closure, lease and remote checks. If the filesystem also
refuses the final state replacement, the staged files and owner locks stay in
place and ordinary collection can still refuse. Do not promote either stage.

Use the per-child command above if an invalid monitor left locks behind. The
foreground controller writes the invalid status without reusing an interrupted
state write's temporary file. If the bootstrap seal completed just before that
write failed, it recognizes the acknowledgement from the saved invocation
ledger, not from the temporary file. Neither fact proves the remote job ended.
The original operation and launch locks remain unchanged. Collection requires
local stream closure, lease expiry and an absent original owner PID. It uses
the separate stream recovery lock and checks the registered boot and exact
started unit. Read-only fleet inspection can verify a saved retirement behind
those retained child locks, but not while their owner or a recovery collector
may still be active. A root batch lock whose owner is gone is reported as
retained, not as changed evidence. On Windows, reports can also replay when
the OS proves the process now using that PID started after the unchanged lock
was written. This does not authorize admission, collection or deletion. A
live, unrecognized or changing root lock is busy. Inspection never clears a
lock or makes a locked fleet complete.
Live or uncertain
custody is preserved. The shared failed-native procedure below checks the
download, rehashes the remote data, renews the idle-host proof and records a
`native-failed` intent before one DELETE. Repeat collection after intent can only
check exact-ID absence. Confirmed retirement returns 1, not success. This does
not reopen old reservations from a different checkout or change sibling state.
Launch saves the digest of the host key established by its acknowledged
first SSH handshake. The collection approval binds that digest, and each
subsequent SSH or SFTP uses a private snapshot of the matching key. A replaced
key is refused; old reservations without a launch pin cannot use failed-native
custody through ordinary collection. Existing explicit recovery policies are
unchanged.

**Pinned r21 only.** Use a separately reviewed, merged successor for one
closed child of the original staged fleet at a time. Keep the original fleet
in place. Keep a separate clean checkout at the measured revision
`4225a2837e04795c11c1b45b3d6af72b7eb5ddc3` with its original root `npm ci`.
The successor reads that revision's validator, dependency bytes and native
inputs, not its own compiler. The successor allows 15 minutes per local replay.
First independently verify the pre-existing exit archive's SHA-256.

```sh
node bench/workloads/cloud-production.mjs r21 --collect --state-dir ABSOLUTE_CHILD_ROOT --r21-measured-checkout ABSOLUTE_MEASURED_CHECKOUT --exit-archive-sha256 REVIEWED_ARCHIVE_DIGEST --print-approval
```

Review the preview against the exact group, host, unit, saved SSH host key,
monitor registration, terminal campaign/seal, archive and staged intent. Only
after independent authorization replace `--print-approval` with
`--approve-reviewed-merged-ready REVIEWED_EXACT_HASH`. Approval is neither
transferable across children nor reusable after state changes. An unadmitted
child cannot be recovered. The first group's admission replay, remaining
launches and fleet verification still use the **measured checkout**, whose
replay deadline remains 60 seconds. Collection alone does not establish
admission. A replay timeout or mismatch before delete intent retains the host;
do not substitute a remote report, change the measured state or retry a DELETE.

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

The direct CLI renders that same closed controller stage and the provider's
allowlisted code-specific detail or HTTP status. It never prints a native error's
message, stack, response or accessor. These labels identify the stopped operation,
not its cause or successful cleanup; the retained state still governs recovery.

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
The read-only fleet verifier needs the same local `npm --prefix bench ci`; without it,
it reports that hint as its `error` before reading any group. It replays every saved native archive, rechecks its
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

## Independent Group Continuation

For an incomplete round, retain the original fleet and use a separate physical
continuation root outside the checkout. Its `index.json` is an array of original
fleet references. Each reference names an absolute fleet root, the original
round and commit, a clean checkout at that commit with its original npm installs,
and the reviewed SHA-256 of `results.tgz` for every verified replayed group in
that fleet. Use `[]` when starting without retained evidence. For example:

```json
[{"root":"/bench-state/original","checkout":"/src/measured","round":"r24","commit":"MEASURED_SHA","archives":{"catalog-page":"REVIEWED_ARCHIVE_SHA256"}}]
```

Use an unmodified index and the same continuation root for the entire set. The
report replays each original attempt, checks the successful archives, the
extracted trees against the pinned archive bytes and confirmed deletion, and
verifies each group against its original contract and roster. It does not use a
cached report as evidence. A changed current contract does not invalidate the
original result or make it eligible to rerun in this root. The report shows the
measured contract and roster, with `matchesCurrentContract: false` when they
differ from today's matchup. The measured
commits must be ancestors of the report checkout, but groups need not have the
same commit, date, framework versions or host. Preserve target failures (including
comparison-ineligibility) in verified group results; a failed or incomplete
apparatus is not a result. An old bound host without confirmed cleanup is shown
as such. Continuation then requires the same provider account and still refuses
create if the existing pre-create census finds any foreign benchmark host.

When retrying a group on a new host, a proved Windows PID reuse on a destroyed
host does not make its old monitor active again. Preparation reads the original
retirement evidence and rechecks the unchanged locks; it never removes them or
authorizes collection or deletion on the old host.

When the launcher checkout advances or a measured checkout moves, use the
optional sibling directory `ABSOLUTE_ROOT-checkouts/MEASURED_SHA` for that
commit's clean worktree. Here `MEASURED_SHA` is the full 40-character Git commit.
The replay first uses that path when present, otherwise the saved checkout
(`checkout` for an indexed fleet, the launch checkout for a new group). Install
the measured checkout's pinned root and bench dependencies there. Replay checks
HEAD and the original dependency pins and bytes; it does not rewrite a reservation
or measure the group again.

```sh
node bench/workloads/group-continuation.mjs --continuation-root ABSOLUTE_ROOT
node bench/workloads/fleet.mjs NEW_ROUND --continuation-root ABSOLUTE_ROOT --group json-api --prepare --commit MERGED_SHA --ssh-key KEY --account-id ACCOUNT --context CONTEXT
node bench/workloads/fleet.mjs NEW_ROUND --continuation-root ABSOLUTE_ROOT --group json-api --detach --print-approval
node bench/workloads/fleet.mjs NEW_ROUND --continuation-root ABSOLUTE_ROOT --group json-api --detach --approve-reviewed-merged-ready REVIEWED_EXACT_HASH
```

The first command is read-only and providerless (`0` all groups verified, `1`
incomplete, `2` invalid). Its `eligibleToRun` is a local selection, not provider
availability or authorization. You do not have to run the full report before
starting the next group. Prepare, preview and launch check whether the **selected
group** can run and whether any existing host conflicts with that launch. A
saved result keeps its group off the launch list; it does not certify the
result for publication. For example, starting marketplace does not require
reopening the catalog page's results archive. Run the full report before
publishing: it checks each group's evidence at the commit it actually measured.

Prepare reads provider placement but does not allocate. The selected group runs the normal
staged first-host checks, native phases and terminal monitor. For JSON that
includes its prepare and timing phases and the independently reviewed audit
between them. There is no extra setup host and no `--admit-remaining` action.
The continuation does not grant approval; the existing exact merged-source,
native readiness, independent review and operator approval requirements apply.

If prepare or detach refuses before writing intent, `fleet-operation-failed`
can name the failing stage: `continuation-admission` (including custody and
eligibility), `prepare-reservation`, `initial-plan` or `locked-plan` (including exact approval checks),
or `final-pre-intent-recheck`. These labels identify the check, not its cause or
whether locks were released. Placement keeps its separate
`fleet-placement-preflight-failed: STAGE` diagnostic. Inspect saved intent and custody
before deciding what to do next; an unlabeled failure does not establish that
intent was never written.

Different groups can run concurrently in the same continuation root. Prepare
and allocation are serialized through a shared lock. As soon as the launched
host has sealed bootstrap, entered the native campaign and renewed its
registered supervisor lease, the shared lock is released. Leave that detach
process running: it still owns its host monitor and attempt lock. Use a separate
terminal for the next group's normal prepare and exact approval. The preview
binds any running peers; the create census rechecks their signed-in account,
owned identities, tags, addresses and placements. The exact target placement
and free account capacity still have to pass. An unknown or unconfirmed
benchmark host, a lost lease or changed peer refuses dispatch, not cleanup.
An earlier controller that did not record peer leases cannot be treated as a
running peer. Never clear a lock or recreate a group to force overlap.

For collection or audit delivery use the ordinary per-host commands at the
measured checkout. For the first attempt use state root
`ABSOLUTE_ROOT/json-api/json-api`. For a retry use the reported `attemptRoot`
plus the group name, for example `ABSOLUTE_ROOT/json-api--r26/json-api`.
Collect a terminal host with its own approval and existing custody checks; it
does not wait for a sibling's measurement or deletion.
There is no automatic retry. After a proven `not-created` attempt or confirmed
retirement without a verified result, the report marks that group `retryable`.
Repeat the same prepare, preview and approved detach commands in the **same
root** with a higher round for that group. This appends a reservation without
reusing a consumed intent, rewriting old attempt bytes or changing any
prepared sibling. Do not move attempts to a new index or root. An ambiguous or
active attempt is refused; leave its evidence and locks in place and use the
existing recovery procedure. Run the report after collection to select another
missing group.

If a standalone group was prepared but never launched, use the same prepare
command in the same continuation root with an explicitly higher round and a
different measured commit. This works only when the previous slot physically
contains its one original manifest and nothing else: no intent, lock, child
state, receipts or other files. Prepare only reads provider placement and leaves
the old bytes and verified groups intact. Once the new attempt is prepared,
only its round can be previewed or launched; an older approval cannot dispatch.

The report is an index of independently publishable group results, with each
group's actual round, commit, dates, archive, attempts and `baseEffectiveOptions`.
Those options describe the base binding; for JSON, actual prepare and timing
options are in the verified per-phase campaign artifacts. Link
each group to its original measurement. It is not a single-revision baseline or
evidence for a speed comparison across groups or revisions.

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

Use the child collector's opt-in `--collect --unused-bootstrap-known-hosts ABSOLUTE_VERIFIED_KEY_FILE`
for a bound `preparing` host with a pending unregistered monitor and no seal. Preview and approve
the exact pinned collection action with the same flag and absolute state root.

```sh
node bench/workloads/cloud-production.mjs ROUND --state-dir ABSOLUTE_GROUP_STATE_ROOT --collect --unused-bootstrap-known-hosts ABSOLUTE_VERIFIED_KEY_FILE --print-approval
node bench/workloads/cloud-production.mjs ROUND --state-dir ABSOLUTE_GROUP_STATE_ROOT --collect --unused-bootstrap-known-hosts ABSOLUTE_VERIFIED_KEY_FILE --approve-reviewed-merged-ready REVIEWED_EXACT_HASH
```

- Before provisioning, the ledger must be empty (including after readiness exhaustion) or
  contain only the unacknowledged sequence-zero, 30-second bootstrap SSH `true` request
  ([#1618 Benchmark r21: first catalog SSH setup has no completion receipt and leaves an unused droplet outside ordinary recovery](https://github.com/corten-run/corten/issues/1618)).
- After an interrupted upload, this path applies only to reservations launched from a commit
  that includes this recovery. Use that exact measured checkout and the original state
  directory; a different checkout refuses before provider access, even if it is newer.
  Only the successful, locally terminal prefix of the fixed no-op, directory setup and
  upload/checksum sequence is eligible; it must include an upload and stop before unit
  installation. The original saved host-key bytes must match the independently verified
  key file, and the local uploaded files and any next staged file must match the measured source.
  The same fresh host probe requires the exact never-started unit, the expected uploaded bytes
  and an empty log, and every original registered session and watcher drained with no foreign
  actor. It binds the matching receipt digests to the unused retirement record
  ([#1744 Benchmark r21: an unused catalog host with six settled bootstrap entries is outside ordinary retirement](https://github.com/corten-run/corten/issues/1744)).

Ordinary `--collect` refuses these pending-bootstrap cases before sending SSH. The pinned probe
never adds, acknowledges or retries a ledger request or starts a unit. A settled SSH refusal
leaves the reservation unchanged. Once a delete intent exists, preview and approve the new
state for exact-ID absence confirmation only; never replay DELETE.

The original local controller, provider worker, SSH and their descendants must be
affirmatively accounted for and gone. No elapsed timeout, absent PID or saved state
alone proves that. Preserve original locks and intents; the controller never clears
or takes over an old lock. Only after that local proof may the operator archive and
release the exclusive child and fleet locks under the existing custody policy. Keep
the proof and original lock bytes outside the fleet and child state roots. Separately verify the SSH
host key against the exact provider/metadata identity and supply a local OpenSSH
`known_hosts` file for that key; the controller passes a private snapshot of the
approved bytes to SSH and never falls back to global host keys. The unused retirement
receipt retains the key digest, not the key file. The snapshot lives in a private
temporary directory beside the reservation, under the private child state root.
A hard stop or uncertain local process closure can leave it there; later
collectors neither adopt nor sweep old snapshots. If an older collector left a
snapshot inside the reservation, collection refuses it. After proving the old
process tree is gone, archive only an independently identified artifact with the
original custody evidence; leave unidentified entries in place.
`--print-approval` binds the exact saved reservation, verified-key
bytes, old measured commit and new controller commit. Supplying the exact approval
attests to both operator checks above; it is not a way to clear retained locks.

Execution rechecks the saved account, host and IP and requires a **fresh** pinned SSH
unused proof. In the pre-provisioning case it additionally requires absence of `/bench`,
the unit file, guardian storage, and control watchers. Systemd must report an exact
zero monotonic start timestamp; the formatted wall-clock timestamp is not used.
The observation-only command never installs a guardian. The pinned DELETE deadline is 60 seconds from the local start of the
SSH proof, including response delivery and provider preflight. Expiry before intent
does not consume the intent; expiry after intent still forbids another DELETE.
Ambiguous, active or foreign custody is preserved. As with other unused
retirement, confirm deletion with an exact-ID 404; after a recorded intent a new
approval can only verify the saved receipt and check absence. The original fleet
intent and all sibling admissions stay unchanged. The child controller must be clean
and merged. Only the pre-provisioning exception allows a different controller commit,
and it must descend from the measured commit. Neither exception lets ordinary
collection or audit run from a mismatched checkout.

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
without another DELETE. Native-started jobs use the separate collection and
custody paths above. No retirement path can delete a running benchmark.

For failure before monitor registration, `setup-watcher-proof-missing` means
the preserved archive already records a watcher failure. `setup-host-proof-refused`
means the registered terminal host query had an acknowledged nonzero exit, or
exited zero but returned unusable proof. In the latter case the ledger retains
code zero and records the proof rejection separately. Neither is a retirement receipt. Do not repeat collection to try
to replace the missing proof. A missing transport acknowledgement remains
uncertain; do not clear the locks or fill in a ledger result.

For operator cleanup, bind the saved reservation to the exact account and numeric
host ID. Independently establish the identity of the host, a terminal unit with
no queued jobs or live benchmark work, and an intact archive matching the saved
hash before authorizing any removal. If the host is already absent, do not
delete again. Keep the operator decision and exact-ID absence confirmation
separate from native state; neither qualifies the group or authorizes a retry.

The common-bootstrap marker precedes native entry. It is not native evidence or
a reason to strand a terminal host whose entry failed before writing any data.
If the job writes its exit marker before publishing its first campaign state,
the monitor invalidates the stream rather than renewing an idle connection.
This is a failure signal, not a terminal result or proof that deletion is safe.
If an SSH or SFTP watcher raises an exception, its archived
`control/watch-failure-<id>.json` records only the line in the archive's
`control/helper.py`. Match the ID to the sealed ledger to find the failed check.
This is diagnostic evidence, never a terminal watcher receipt. A missing receipt
still prevents admission, even when the associated command exited successfully.
During timing, the pinned watchdog signals the campaign directly on failure;
the campaign aborts before optional logging. Look for `control fault:` in the
archived `run.log`. A watchdog's `helperLine` points into the archived
`control/helper.py`; a campaign-side lease failure names the failed check.
For an SSH monitor failure, check `helperLine` in the local
`monitor-local-closed.json`: it can arrive after the archive is sealed.
Only the bounded line number is retained, not raw SSH stderr. A broken
connection or failed storage can lose a diagnostic. Log order is not proof
of causality, and a disposal report can follow an earlier campaign error.
The historical `control/stream-invalid.json` path is an empty, immutable
revocation marker. None of these records proves a clean drain or qualifies a run.
An intermediate process sample may catch a member just before it exits. When the
scope switches from populated to empty during the inventory read, its sample
retains both raw event observations and the member's identity. The watcher
still needs a later sample with no remaining session member to prove drainage.
Setup retirement permits only that exact source-bound marker, preserving an
already-recorded bootstrap observation. A foreign, malformed, symlinked or
missing previously observed marker refuses, as does any native campaign data.

### Failed Native Custody And Retirement

`--retire-failed-native` is a separate, deliberately approved recovery action,
not a relaxation of `--collect` or native validation. Its original migration policy supports
only round r21 measured at `9f3d35884c67d90524f978d173fabeb3a17bc970`, for the
eight nonmixed group reservations with preserved
original archives/extractions and raw exit `2`. A different, clean repair-controller
commit must descend from that source and pass the existing fresh merged-main
proof. Preview and exact approval bind both source identities, exact reservation
bytes, original evidence hashes, physical state root and fixed custody roots.
This exception does not permit a source override for collection, audit or launch.

An independent group can also fail after the wrapper invokes native entry but
before it saves a campaign plan. In this case ordinary collection preserves the
wrapper archive; it cannot produce a benchmark result. Use a separate
`--retire-failed-native --print-approval` from a clean, merged descendant. The
preview must bind the consumed launch intent, reservation, launch key, registered
boot, original archive and extraction, and the output roots for the measured
group. The measured registry and remote-job definitions must still match.

This path requires a revoked monitor with a settled local owner, wrapper exit
2, an empty archived campaign directory, and the final failure line from the
measured job's native-entry command. An empty directory **alone** is not proof
that the application wrote nothing. Before retiring the exact host, the
controller checks the unit is idle, saves the campaign and native output roots
(including evidence of absence), verifies the local copies, and checks the
host and roots again. A changed or live host is retained. Neither the wrapper
archive nor the later capture qualifies the group or supplies timing results.

The shared `cloud-retirement.mjs:failedNativePolicy` allowlist also admits only the
exact `catalog-page` attempt measured at
`dbe1a34c753ee8ef4ac9927484dc3930d36f6e37`, round `r21`, host ID 620052965,
token 39fa09440f45df00, name `corten-bench-groups-r21-39fa09440f45df00`,
tag `corten-bench-groups-run-39fa09440f45df00` and that name's `.service` unit.
Its fixed custody roots are `/bench/campaign` and
`/bench/repo/bench/catalog/results/c21`, plus the original wrapper metadata/archive.
It uses the same terminal custody fences below, only after natural termination
with the original saved exit `2`. It cannot stop, restart or cancel a running job.
Incomplete or invalid catalog files remain original failed evidence: this action
does not repair or qualify them, change catalog validation, or depend on a newer
catalog runner's evidence semantics. The allowlist is eligibility, not runtime
authority. A later observed terminal archive and its hashes, exact reservation,
fresh host/account proofs and separate exact operator approval must still bind
the action. No archive hash, terminal observation or approval is inferred from
this documented identity. The original migration's rules remain unchanged.

The same custody-only exception also admits the exact lean `catalog-page`
attempt measured at `2a4ceb043747b92c753becc2bbcc5def655fc53d`, round `r21`,
host ID 620157651, token e38164eb06fc2043, name
`corten-bench-groups-r21-e38164eb06fc2043`, tag
`corten-bench-groups-run-e38164eb06fc2043` and that name's `.service` unit.
It uses the same fixed catalog roots and every terminal custody fence below.
Eligibility does not assert that this attempt has ended or grant an action:
ordinary collection must first preserve its actual archive and evidence, then
a fresh preview, independent review and separate exact operator approval bind
any recovery. A live unit, missing or changed evidence, foreign ownership,
uncertain controls or expired proof still refuse deletion. No request failure
or upstream-headroom rejection becomes a completed target or successful baseline.

### Cancelled Mixed Wait

The cancelled mixed migration is the exact r21/9f review wait described by
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
never another DELETE. Grouped collection and retirement confirm exact-ID absence
with read-only account/GET/account observations for at most two minutes, paced
one second apart. Every provider call shares the same remaining deadline. Only
an authenticated exact-ID 404 confirms absence; account changes, malformed or
failed reads, cancellation, a reversed clock or an exhausted deadline preserve
uncertainty. A bounded observation count also refuses a stalled clock. A later
invocation verifies retained evidence and repeats only those reads, not DELETE.
Existing locks are never taken over or cleared by recovery.
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
hidden launcher: an approved detach provisions once, verifies uploads and starts the
fixed systemd job. For a supervised reservation the local worker stays alive
until its monitor settles. A clean worker exit does not collect or delete the host.
The provider security review does not authorize an
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

Native replay runs on the operator's checkout, never on the host: run
`npm --prefix bench ci` there after `npm ci`, before a launch or collection. The
host's job installs its own bench package, which collection does not read.
Detach also lists `bench/package.json` or `bench/package-lock.json` when either is
absent at the measured commit. Detach and ordinary collection previews list
`local bench install missing or differs: run npm --prefix bench ci` when this
checkout's `bench/node_modules/typescript/lib/typescript.js` is absent or is not
the pinned 6.0.3 bytes, so neither allocates a host nor collects one it cannot
validate. The plan repeated under the operation lock checks that list again before
any provider access. Evidence-derived validation failures stay generic.

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
reads. If the import-time read of the installed Git HEAD fails, the launcher
reports one fixed reason: `timed out`, `process error`, `unsuccessful exit`, or
`malformed output`. It does not retry or report Git output, raw errors, or
environment values. Replay and evidence validation failures remain generic.
The closure includes the observer's durable writer; transitive observer
imports use those captured bytes under the same deny-unlisted loader.
The fixed TypeScript bundle (the bench package's 6.0.3, `bench/package.json`) and the
semver library are captured once and checked against their pinned package-file hashes.
Each one's exact tooling declaration, resolved archive URL and npm archive integrity
must also match the installed commit's manifests and locks: the root's for semver,
`bench/package.json` and `bench/package-lock.json` for TypeScript. The harness
loads TypeScript only through `bench/typescript.mjs`, itself a captured closure member.
Semver's extensionless CommonJS imports resolve only within the captured library;
the CLI, preload entry and unlisted files cannot execute. This adds no package
resolver or filesystem fallback and retains the existing source-count limit.
The nested worker executes captured entry bytes and installs a
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

Each local inspection has a fixed 15-minute deadline including snapshot setup.
On the r21 catalog archive from `4225a2837`, one Windows scan of 9,131 campaign
entries took 62 seconds. A complete replay also checks the journal, group results,
and final tree. This is a limit on reading evidence, not on a workload, a provider
request, or how recently the host must have been observed for deletion.
Cancellation is checked every 25 milliseconds. The default worker is terminated on completion, timeout or cancellation;
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
name, unique run tag, both shared tags, the reserved size and region and exactly one matching
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
creates the durable reservation inside it. A launch saves `benchPackage: true`
in its reservation and its job runs `npm --prefix bench ci` (the binding parser's
classic TypeScript) after the root install; a state saved without it regenerates
the job bytes it uploaded. Each uploaded job/packer/unit is
SHA256-checked on the owned host before installation/start. The packer requires terminal metadata, keeps an existing
regular archive instead of overwriting it, and publishes a fresh private GNU tar
archive with exclusive hard-link creation; a collision does not replace evidence.
One remote unit start is attempted; there is no forced power cycle, restart or
retry launch. After confirmed create and before dispatching any tracked SSH, the
controller allows at most 24 authenticated SSH no-op probes, paced five seconds
apart after a refusal, in a shared two-minute budget. It retries only a settled SSH
transport failure, not a timeout, cancellation
or uncertain process tree. Each probe rechecks the bound allocation. The first
guardian request still dispatches once; missing completion retains custody. The job has the existing
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
never followed, and only the narrow account transport retry below is allowed. Census pagination
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
cancellation or unproved resource settlement conservatively retain lifecycle locks.
Every provider-owning controller action awaits the same cached worker-close promise
before releasing its operation lock, including early-return and error paths. Forced
worker termination or uncertain shutdown retains the operation lock and any acquired
root launch lock. The outer finalizer awaits that same settlement, not a new teardown
after lock release. Ordinary confirmed shutdown releases the locks normally.
After settled credential consumption, the exact account command's private native request path observes
actual `ClientRequest`, any `IncomingMessage`, and assigned socket close events.
All requests dispatched by that engine must have closed; `destroy()`, `end`, an
HTTP failure or a diagnostic label alone is not proof. One native `ECONNRESET`
before any response on `GET /v2/account` permits one read on a fresh connection,
only after that closure proof and a cancellation checkpoint. Both attempts share
the original command deadline, including credential consumption and closure, and
use the same pinned token, HTTPS verification and response bounds. The controller
still checks account identity and capacity where it did before. Cancellation,
expiry, reverse time, unknown resources and unresolved prior mutations fail closed.
The account command keeps one clock record across both connections; once a
sample goes backwards, a later sample cannot make that command valid again.
HTTP statuses, other errors and other commands cannot authorize this retry.
Only a privately identified failed account read can produce the exact-key
`cloud-provider-account-failed/v2` reply: `nonce`, `sequence`,
`disposition: resources-closed`, and its closed `diagnostic`. Success and other
failures retain their existing result grammar. The parent requires the pending
exact account command, its matching nonce/sequence, timely terminal proof and an
observed exit0 without a signal before cached settlement may resolve. Terminal
proof precedes expected disconnect/exit; an exit without proof, malformed or
duplicate reply, forced close or cancellation stays uncertain.
If the account command still fails, its terminal protocol does not accept an
identity even with `allowFail`; this worker cannot service another request.
An HTTP refusal and a worker lifetime failure are different outcomes, not different
authorities. Only this proved orderly failed read can release normal lifecycle
locks; a later explicitly approved collect must independently re-prove ownership
and unusedness. No POST/DELETE or failed enclosing operation is retried, and an
existing deletion intent still permits only fresh absence reconciliation. Other
commands, including a create's action GET, cannot use this terminal disposition.
Provider failures may append a bounded phase code to the generic CLI error. The
closed vocabulary in `cloud-options.mjs` distinguishes credential consumption,
account/list/create/delete requests, create response/link validation, action
request/response validation, pending-action deadline, and output filtering.
Unexpected HTTP responses use a `-http` code and optionally a numeric status from
that module's closed status table; unlisted statuses are omitted, not accepted or
retried. Only those validated data fields cross the worker failure boundary or a
permitted HTTP-failure result, never native exceptions, raw bodies or credentials.
The public classification survives cached teardown and failed create reconciliation; it is
diagnostic only and changes no action schema, ownership proof, retry, deadline,
approval, uncertainty or lock-release rule. Missing/invalid diagnostics remain
generic errors, not evidence about the provider's response.
For native account-request failures, the optional closed `detail` is the rejection
site: `internal-refusal`, `connect`, `send`, `request-error`, `response-error`,
`response-aborted`, `response-status`, `body-limit`, `invalid-json`, `deadline` or
`cancelled`. These labels do not identify native exception codes: `request-error`
does not prove `ECONNRESET`, and `connect` does not prove DNS/TLS failure or that
a connection was established. Details survive the
existing private-worker IPC and cached finalizer diagnostic; the direct CLI renders
only the closed stage, detail and allowed HTTP status. Unknown, extra or accessor diagnostic fields
are not forwarded. Other phases and unclassified failures retain their coarse
codes. No detail changes retry, credential, acceptance, settlement or lock rules,
and the original r21 account-request cause remains unknown. A final
`provider-settlement` stage alone does not identify the original failing call.
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

Masking does not clear a stopped unit's recorded failure. Before native entry,
the bootstrap logs each fixed firmware unit's load state, active state and
service PID. Only an already masked, stopped failed unit may have its failure
state reset. Active or transitioning units, a live service PID and a missing
mask still fail. After any reset, the mask, inactive state and zero service PID
are checked again; reset failure is fatal. This does not exempt firmware or any
other user process from native cleanup evidence.

On dedicated group hosts, the benchmark and Docker run as system services.
Root SSH still needs a normal logind session, but not a separate user manager.
During provisioning, a runtime systemd drop-in skips new starts of
`user@0.service` while the host's control binding exists. It does not stop
the current manager or change SSH or PAM. Before publishing the bootstrap
marker, the job waits up to two minutes for the manager to exit naturally.
The run log records which property it is querying and the observed state and
main PID, so a busy manager can be distinguished from a stalled query.
If it stays busy the group fails setup, without terminating anyone's work.
The normal login inventory and registered-monitor checks still apply.

On a newly allocated supervised dedicated group host, the controller's guarded
workspace command captures the IPv4 peer of its authenticated OpenSSH
connection (`SSH_CONNECTION`) in a private boot-local file. The systemd job
does not inherit SSH environment variables. It reads the file and atomically
installs a runtime-only nftables input table for TCP port 22. Other IPv4 sources
and all IPv6 sources are dropped before sshd, without an sshd restart, a firewall
service, or a forwarding or application-port rule. No rule is added to shared
hosts or during collection. If `nft` is missing, the job installs the Ubuntu
Noble package under a bounded deadline after the ordinary cloud-init,
APT timer/service gate and package-list update. That package does not start or
enable `nftables.service`.

The job checks the live table against its private readback before writing
bootstrap readiness. Install or verification failure exits before admission:
the controller can collect under the existing setup-failed protocol after a
positive terminal observation, not while the unit is live or unproven.
The first guardian no-op, participant checks, cleanup gates and native
measurement seal are unchanged. Existing foreign processes are not killed or
excused. The recorded workspace command distinguishes earlier uploads for
historical collection and retirement.

The owner must keep the same public IPv4 egress through monitoring, artifact
transfer and terminal cleanup; the normal reconnects use the same droplet public
IPv4 and SSH port. An address is not a credential or a guardian registration:
do not open a second SSH login, even from the same source address. Do not
broaden the rule when a reconnect fails. It stays in place until the disposable
host is removed. The Benchmark Evidence native Linux job exercises the exact
generated scripts with a private sshd and nftables table in Linux namespaces.

The generated job records a fixed preparation stage, source line and original
exit code on command failure, never the failed command or an environment dump.
The EXIT handler retains the original failure and packages the terminal logs.
The production adapter also names campaign-directory, source-cleanliness and
bootstrap-marker stages before native entry. These diagnostics do not convert
failed setup into benchmark results. Run the Linux execution controls with:

```sh
node --max-old-space-size=256 --test --test-concurrency=1 bench/workloads/cloud-bootstrap-execution.test.mjs
```

Those controls execute the generated firmware checks with a local systemctl
fixture, including refused live/unmasked states and failed post-reset checks.
They do not provision a host or qualify a native campaign.

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
| client-heavy | 2 GiB total, 80,000 entries, 128 MiB ordinary files, admitted executables up to 192 MiB for Node and 512 MiB for the browser, 1 GiB unique blobs (`client-heavy/verify-v2.mjs`) | 2 GiB |
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
