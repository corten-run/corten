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

New reservations save `gitSource: true`. Their guests build Git 2.56.1 from the
signed upstream release before checkout, without the unavailable Launchpad PPA
([#1993 Fresh benchmark guests depend on the unavailable Git PPA before checkout](https://github.com/corten-run/corten/issues/1993)).
The generated job embeds the exact [CI verifier](../../scripts/benchmark-evidence-git.sh):
it checks the pinned kernel.org archive SHA-256, then requires a valid detached
signature with the pinned signing subkey and primary fingerprint. Extraction
and the two-job, no-Rust build follow verification; package install, download
verification, extraction, build and capability checks all have deadlines.
The installed `/usr/local/bin/git` must have its HTTPS helper, the exact version,
and demonstrate both no lazy fetch of an absent blob and no replacement of an
original object. The host record keeps the version, release URL, SHA-256 and
signer fingerprints. The CI tools image itself is not used on measured hosts.

A failed step stops at `git-install`, with no fallback to distribution Git,
checkout, native entry or bootstrap-ready marker. The job removes its private
build tree on normal failure and uses the existing pre-entry exit archive;
the exact-host cleanup requirements do not change. The `git-source.test.mjs`
Linux fixture executes the generated stage and failure packer with local
commands, not an upstream download or guest qualification.
Reservations without the marker regenerate their original PPA job bytes.
That preserves ordinary collection from the measured checkout. It does not
make a new controller source-compatible with [grouped pre-plan retirement](#failed-native-custody-and-retirement).
Keep the marked recipe fixed too; a future Git pin needs a distinct saved recipe.

New reservations also save `trixieUpstream: true`. Their job pulls the Debian 13 native
upstream image, `node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067`,
which the native browser runner uses from the commit that moved bench to Debian 13
([#1704 bench's Node images and the Gin item-page app still run on Debian 12 after the template and examples moved to Debian 13](https://github.com/corten-run/corten/issues/1704)).
A reservation without the marker regenerates its original job, which pulls
`node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1`.
A new reservation's measured commit must therefore include that move; merged main does.

New dedicated Catalog, Marketplace, Mixed Production and Hardening reservations use
their runners' Playwright containers. JSON API does not launch a browser. These
reservations save `skipHostChromium: true` and omit only the host Chromium install.
Fullstack Browser, Client Heavy, Live Delivery and Recoverable Live still install
host Chromium. Unmarked reservations keep their original job, packer and unit bytes.

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

### JSON API c-16 Placement (Opt-In)

[#2057 JSON API r67 has insufficient apparatus headroom during fast adapters' warmups](https://github.com/corten-run/corten/issues/2057)
found that on a `c-8` the uncapped warmup drives k6 (quota 4, CPUs 4-7) to its
headroom bound while one fast app core is not saturated.
`bench/json-api/placement.mjs` defines an opt-in layout for a `c-16` host that
gives only the load generator more CPUs. It reuses the pins of catalog's
`c16-generator-v1` under JSON API's own name:

| CPUs | Role | Budget |
| --- | --- | --- |
| 0 | host: driver, control apparatus | unpinned host work, as today |
| 1 | app | quota 1, unchanged |
| 2-3 | upstream (one Node process) | quota 2, unchanged |
| 4-15 | k6 and the load resource sampler, which accounts for all twelve | quota 12 (default: 4 on CPUs 4-7) |
| 4-7 | the untimed cold probe, a subset of the k6 CPUs as today | quota 4, unchanged |

The selector is `JSON_API_LOAD_LAYOUT=json-c16-generator-v1` together with exactly
`JSON_API_APP_CPUS=1`, `JSON_API_API_CPUS=2-3` and `JSON_API_LOAD_CPUS=4-15`.
Any other value, an empty value or another pin refuses, and the runner side refuses
a host with fewer than 16 logical CPUs before any container starts. Without the
selector the CPU settings are exactly the default contract's. Catalog's
`--load-layout c16-generator-v1` stays catalog-only.

A result records its placement explicitly: `measurement.cpus` keeps each
role's quota and cpuset as it does today, and an opt-in result adds
`measurement.loadLayout: "json-c16-generator-v1"` and
`measurement.generatorPlacement`, with the cold probe at
`{ "quota": 4, "cpuset": "4-7" }` and the load sampler at
`{ "quota": 12, "cpuset": "4-15" }`. `recordedPlacement` accepts a quota-12 load only
with the marker and both exact records, and refuses either with any other CPUs.
Default results carry neither, so their saved bytes and replay do not change.

No fence changes. The load headroom bound is already 80% of the k6 quota (320% on
the default, 960% on `c-16`); the upstream bounds stay below 80% of one core, both
sampled and counted. The Corten API warmups that failed on the upstream's sampled
peak are a separate, open constraint: more k6 cores do not address it.

To select it, add `--load-layout json-c16-generator-v1` to the single-group
`--prepare` command with `--group json-api`; it is refused on any other group, on
detach or without a continuation root. It may be combined with `--offline-handoff`.
The prepared fleet saves the marker as `single.loadLayout`, and its one job carries
`host: c-16/sfo2` and `loadLayout`, so the approvals, the reservation, the
census, the create mode and the job (`nproc` at least 16 and
`campaign-entry.mjs ... --group json-api --load-layout json-c16-generator-v1`) all
follow from the saved fleet. Placement selection then requires `c-16/sfo2` to be
advertised. The campaign binding requests the four `c16Env` variables and expects
the c-16 CPUs. A fleet, reservation or job without the marker, including every
saved one, keeps its exact bytes.

`bench/json-api/run.mjs` reads the four variables the binding requests, records the
layout, runs k6 at quota 12 on 4-15 and keeps the cold probe and CPU counter reader
on 4-7. The isolated JSON evidence check (`isolated/evidence.mjs`) and JSON staging
(`isolated/json-staging.mjs`) each require the recorded `measurement.loadLayout` to
equal the layout the binding requested, so a default result cannot satisfy a c-16
binding and a c-16 result cannot satisfy a default one. `bench/json-api/report.mjs`
has no binding to compare with. It checks the summary against itself: a quota-12 load
is accepted only with the marker, and the recorded CPUs and `generatorPlacement` must
equal that layout's exact values. Native campaign replay captures
`bench/json-api/placement.mjs` as a named member of the measured source closure. A
measured commit that predates it replays under its own closure list, which never
names the file.

This is apparatus placement for future runs, not a measured speedup and not a fix for
the upstream constraint above. Do not compare JSON API timings across
placements, and do not rerun saved groups only to adopt it.

### JSON API c-32 Placement (Opt-In)

For a future JSON API calibration, use `--load-layout json-c32-generator-v1` at
the same single-group `--prepare` step, not on detach. The saved fleet job
selects only `c-32/sfo2`. Prepare, approval preview, detach and the locked
pre-create check require that pair to be offered in both directions of the
provider catalog; there is no fallback. The job requires `nproc` of at least 32.

Only k6 widens: quota 20 on CPUs 4-23, with the load resource sampler accounting
for all 20. CPU 0 stays for host work, the app and upstream remain on 1 and 2-3,
the untimed cold probe and counter reader stay on 4-7, and CPUs 24-31 are not
assigned to benchmark containers. The same load fence is below 1600%; upstream
fences are unchanged. The binding and replay require the saved layout and its
exact placement, not merely the host size. A default or c-16 reservation
continues to regenerate its original bytes. See the
[JSON API runner guide](../json-api/README.md#opt-in-c-32-load-placement) for the
r93 calibration evidence and its limits.

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

`create-request` records a finite local transport reason when available, such as
`request-error`, `response-aborted`, `invalid-json` or `deadline`. A broken response
or a missing response is still an uncertain POST: the controller does not infer
that it was unsent, release custody or submit it again. Older receipts that lack
a detail do not establish any of those reasons.

`account-capacity` is a code-only launch refusal: the complete census for the
verified account reached or exceeded its valid droplet limit. The direct CLI and
grouped receipt expose neither the limit nor the inventory. This guard stops
before create intent, POST or bootstrap; it does not free capacity, permit a
retry or change reservation custody. A malformed limit or a separate refusal
to cover the reserved fleet does not carry this code. The code does not identify
the failing guard of an older launch whose receipt lacks it.

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
A collect refusal with a supported operator route keeps its own stage through that
wrapper instead: `setup-watcher-proof-missing`, `setup-host-proof-refused`,
`offline-never-started`, `create-errored-contradicted` or
`create-contradiction-unpublished`.
After the archive is extracted, collect marks which native replay check stopped:
`collect-native-evidence-refused` (checks of the extracted directory and its
saved exit marker, or post-replay integrity), `collect-native-replay-start`,
`collect-native-replay-deadline`, `collect-native-replay-interrupted`,
`collect-native-replay-refused` (worker rejected), or
`collect-native-report-refused` (replay prerequisites or the report did not
bind to the reservation and terminal check). These stages do not authorize
retirement or change the replay deadline.
Initial archive scanning and extraction, and the grouped path's first exit
marker read, still report `controller-collect`.
The stage identifies the failing operation, not its cause or whether a host exists.
Only an own data property from that vocabulary crosses the worker boundary;
unknown values and accessors are not forwarded. It adds no retry, cleanup or
launch authority. Raw Git errors, URLs, arguments and stderr remain private.

The direct CLI renders that same closed controller stage and the provider's
allowlisted code-specific detail or HTTP status. It never prints a native error's
message, stack, response or accessor. These labels identify the stopped operation,
not its cause or successful cleanup; the retained state still governs recovery.
For the common-bootstrap marker read, `controller-launch` can also report
`Bootstrap marker: LOCAL-LABEL` (the same closed detail in the fleet receipt's
`providerDiagnostic` field, under code `bootstrap-marker`):

- `local-control-uncertain`: the local SSH invocation did not provide a valid
  process result. Its process tree is not proved gone.
- `remote-completion-unconfirmed`: the local process result did not prove the
  registered remote command's completion. This does not say whether it ran.
- `acknowledged-exit-refused`: an acknowledged exit other than ready (0) or
  not yet ready (3).
- `marker-invalid`: an acknowledged ready read did not pass marker validation.

The first two retain custody and never poll again. Only an acknowledged exit 3
uses the existing bounded poll. These labels do not attest to monitor
registration, establish a cause for r64, or grant a recovery action.

For `offline-never-started` and `create-errored-contradicted` it adds fixed text
naming the pinned route, `--collect --unused-bootstrap-known-hosts`; for
`create-contradiction-unpublished` it names the custody step and the
`provider-create-reappeared` witness. That text is fixed per stage, never derived
from the error.

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

**Starting a new campaign after external cleanup.** A failed upload may leave
the old continuation locked even after an operator has proved its droplet was
destroyed. Do not unlock it, change its native state, or count deletion as a
result. Ordinarily continue in the same root. A reviewed, one-time operator
handoff to a fresh root is possible only when the old campaign is over:

1. Stop dispatch to the old root. Account for every slot, launch intent and
   owner, including scheduled dispatches. No owner may still be able to send a
   create or upload. A manifest alone is not a launch. An ambiguous create
   with no bound provider ID must be reconciled, not skipped.
2. In the original provider account, check all bound IDs, including renamed
   hosts. Retain native deletion receipts or separately reviewed external
   deletion evidence (exact-ID 404 and absence from the complete account
   list). A lookup error, an outstanding job or an unknown owner stops the
   handoff. Preserve the old root, its locks, failure artifacts and issue
   history unchanged.
3. Inventory every old standalone slot read-only: check its state, receipts,
   archives and extracted evidence, including slots reported busy or awaiting
   cleanup. A 404 proves nothing about saved results. If a slot contains a
   verified or potentially recoverable result, or its evidence cannot be
   classified, stop. The unchanged index cannot carry standalone results.
4. Copy the index into an empty root. If an indexed checkout cannot replay
   (including missing or mismatched dependencies at the right commit),
   provide a separate clean worktree at the measured commit with its pinned
   installs at `NEW_ROOT-checkouts/MEASURED_SHA`; leave old worktrees intact.
   Run the read-only continuation report there. Require native replay of the
   full roster: the same verified groups, measured commits and archive hashes
   and exactly the expected missing groups, with no blocked or ambiguous row.
   Exit 1 is expected with missing groups; it does not prove those conditions.
   Keep old failed and never-launched attempts in the handoff inventory, not
   as results in the new root.
5. Record both roots, the last round used, the inventory and the evidence in
   the operator handoff. Switch the single dispatch target only after review.
   Use new round numbers above the old campaign and the normal reviewed
   preparation and pre-create census. Never resume or collect an old attempt
   through the new root. The failed rounds remain failures; the verified
   groups keep their original measured commits.

If a standalone group failed before native entry and its collector recorded the
archive but not deletion, an unrelated group can use that same census. Its
launch approval includes the stopped host's original ID: even a renamed or
retagged host still present in the account prevents creation. An active cleanup
blocks admission. This does not retire or retry the failed group, or publish a result.

A monitored attempt that reached native setup but then failed can remain locked
after audited external deletion. Do not clear its locks or mark it collected.
After independent review of the original failed archive, the evidence that the
local controller tree stopped, and an exact-ID 404 plus a complete same-account
inventory, the operator may add `receipts/external-failed-host.json` to that
attempt's own fleet slot. The record has `schema: "benchmark-external-failed-host/v1"`,
`binding` from `externalFailedHostBinding(readFleet(slot, round, { priorSelection: true }))`,
and `operatorProofSha256`, the SHA-256 of the reviewed operator record binding
that evidence. Keep the operator record and raw archive outside Git. Do not
record a failure when results might still be recoverable. The controller requires
the original stopped locks and invalid, locally closed monitor, with a complete
journal and no terminal or audit frame. It rechecks the
receipt and custody before a successor can allocate, using the complete account
census to refuse the old ID, original name, or run tag. The receipt authorizes
no SSH, delete, or publication; a retry needs a higher round and a new commit.

If the workstation died after a supervised JSON API or Mixed Production audit
delivery, it may have left the monitor `live` without writing close markers.
Use `benchmark-external-failed-host/v2` only after independent review confirms
the original archive ended in failure without a recoverable result, the local
controller tree stopped, and the externally retired host is absent by exact-ID
404 and a complete same-account inventory. Keep the reviewed evidence outside
Git. Use the same receipt fields with `archiveSha256` for the original failed
archive and get `binding` with `externalFailedHostBinding(fleet, { orphaned: true })`.
The original locks stay in place. The controller requires a complete local
journal with an expired peer lease, the matching audit delivery and no terminal
or close record, collection evidence or recovery lock. It rechecks those bytes
and the same census before create. This records the failed attempt without
trying to recover or qualify it.

The same receipt can record external cleanup of a monitored attempt that stopped
after an accepted create but before binding the droplet. The original reservation
must have the posted droplet and action IDs, the exact uncertain create-action
request refusal, and no setup files, guest control, or collection evidence. For
this case review the saved launch and stopped process tree, the exact completed
create action and prior ownership of that ID, and the subsequent exact-ID 404 and
complete same-account inventory. Bind that review in `operatorProofSha256`.
Do not alter the saved reservation, its child locks or the fleet lock. If the
outer continuation lock is still held, stop dispatch to that root and separately
verify and archive that lock and its original owner's closed process tree before
releasing only the outer lock. Keep dispatch stopped until the receipt is in place.
The next launch still checks the old ID, name and tag in its pre-create census.

When retrying a group on a new host, a proved Windows PID reuse on a destroyed
host does not make its old monitor active again. Preparation reads the original
retirement evidence and rechecks the unchanged locks; it never removes them or
authorizes collection or deletion on the old host.

For an existing monitored external failure receipt for a bound droplet, replay
can also recognize a Windows process whose start time is strictly later than the
saved receipt and all three original locks. Ambiguous identity still refuses.
The checks for issuing a new receipt or replaying an unbound posted create are
unchanged. Replay neither changes old custody records nor replaces the
same-account absence check before a new allocation.

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
can name the failing stage: `continuation-admission`, `prepare-reservation`,
`initial-plan` or `locked-plan` (including exact approval checks), or
`final-pre-intent-recheck`. Admission adds a fixed label: `lock-busy` means the
continuation lock exists (not that its owner is live); `lock-check` means some
other lock operation failed. `batch-owner` means the indexed fleet's batch
owner could not be shown to have stopped. `custody-replay` means the selected
group's archived result or retirement proof did not replay; `custody-read`
is the fallback for other errors reading saved evidence. `posted-custody` means
an earlier provider-errored attempt with a posted droplet, in any group and retired
or not, still has a launch, operation or recheck lock beside it. `custody-unresolved`
means custody scanning found a blocker. `custody-account` and `custody-recheck`
name the subsequent custody checks.
`group-selection` covers reservation or eligibility checks. These labels name
checks, not root causes or whether locks were released. Placement keeps its separate
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

New monitored and offline-handoff timing phases for official groups use the
same post-terminal host-boundary proof. A first-after census containing only
new sleeping workers of the same baseline `systemd-udevd` can trigger one
five-second settle observation. Each worker needs matching cgroup, parent
identity and executable provenance, and a start strictly after the sealed
terminal clock of the verified empty command lifetime. Both clocks must
support the wait, the workers must be gone, and the final boundary must pass
the ordinary cleanup checks. In-window workers, missing proof, survivors and
foreign processes still block advancement. The untimed JSON preparation
keeps its existing pre-phase cutoff. The offline timing phase's zero-SYN
qualification fence stays open through the settle wait and second census.
A denied SYN after native command exit can still disqualify the phase; keep
probes stopped throughout the fenced phase, not just during measurement.
This does not change the measured workload window or qualify older evidence:
replay uses the measured checkout, and r68 does not contain the terminal and
executable proof needed for a settle.

### Offline handoff

For a **new single-group continuation attempt**, add `--offline-handoff` to
the `--prepare` command above. Follow with the ordinary detach preview and
exact approval; the prepared manifest binds the mode in both approvals. It
cannot be added on detach, applied to an existing reservation, or used alongside
a live peer. The attempt remains unresolved for further admission until terminal
custody. The default path still uses the monitored lease.

Wait for detach to return 3 with the child's `handoff: "acknowledged"`. This
means the launcher pinned the host key and boot, and durably recorded the
successful bootstrap seal. Native entry still waits for the sealed SSH/SFTP
epoch to drain. At this point the systemd guest can proceed without the
workstation; this receipt is not a native start, timed result, publication
qualification, or cleanup proof. Do not repeat an unacknowledged launch.

During every native phase an additional boot-local nftables rule on the guest
blocks even the allowed peer's SSH packets. The existing owner ingress policy
still drops other peers. A valid phase retains unchanged rule readbacks and a
closed guardian window. Fresh TCP SYNs dropped before `sshd` within the guest's
8-packet burst and 8/minute rate are recorded by phase as packet and byte
counts. They do not disqualify untimed preparation. Official timing requires
zero new hits, even when the fence denied them all: their effect on target
hardware has not been bounded. Such a timing archive is retained as
unqualified, not as a missing handoff or a native workload failure. Excess
probes, other SSH packets at the fence, a changed rule, or an actual unexpected
login/guardian intrusion still refuse the phase. The fence reopens at phase end;
the service's stop hook removes it on an interrupted phase.

The campaign passes the rule set to `nft` as one argument: a single atomic
batch that refuses an existing table, followed by the same readback and policy
check. It never feeds rules on standard input: Node gives a spawned child a
socket there, and Noble's nftables 1.0.9 refuses `nft -f -` on a socket
(`Not a regular file: "/dev/stdin"`, exit 1) while accepting the same rules
from a shell pipe. The hosted SSH ingress check
(`scripts/benchmark-ssh-ingress-ci.sh`, run as root on Ubuntu 24.04) keeps that
socket-stdin install as a negative that must fail with nft's socket refusal and
leave no fence (only on nftables 1.0.9; 1.0.6 and 1.1.3 accept a socket), then
installs through the production call. The same refusal was reproduced in an
Ubuntu 24.04.5 root filesystem with nftables 1.0.9 and Node 26.13.1, where
r62's measured `beginOfflineWindow` refuses on its first call with the same
message. That shows r62's measured module cannot install the fence on Noble's
nftables 1.0.9, consistent with r62's pre-timing halt in
[#2033 Marketplace r62 halts before timing with native SSH fence unavailable after offline handoff](https://github.com/corten-run/corten/issues/2033);
it was not reproduced on a benchmark host. It is separate from the
post-terminal failure in
[#2051 Marketplace r65 completes timing but the post-terminal drain probe refuses](https://github.com/corten-run/corten/issues/2051).
r62 remains an invalid attempt.

A fence refusal names only a fixed step and class, never host text: an `nft`
call failure names its operation (`install`, `install readback`,
`close readback` or `remove`) and outcome (`error=`, `signal=` or `exit=`),
and a readback that does not parse or verify is `install readback invalid`,
`install readback policy mismatch`, or the same for `close readback`. A
refusal after the install leaves the fence for the unit's stop hook.

For first qualification, arrange the independent audit rendezvous before
timing. For JSON's untimed preparation or mixed's pre-build audit wait, use
the existing [read-only owned-host observation](#independent-native-audits)
(steps 2 and 3) before any audit delivery is authorized. Use
`ConnectionAttempts=1` and `ConnectTimeout=3`, at most one observation every
two minutes, and serialize each observation with delivery and collection.
Connection refusal/timeout is no observation; do not attempt a transfer.
Confirm the exact unit and the latest journal event for the matching audit wait.
Stop all active probes before authorizing delivery, or before handoff for a group
without an audit wait. During timing, observe only passively or from the provider
side. There is no status listener or trustworthy out-of-band native completion
signal in this apparatus: provider instance state alone is not native terminal
proof. If there is no independently known terminal signal, wait for the planned
hard runtime bound before attempting collection rather than guessing when timing ends.

JSON still stops after preparation, and mixed still stops before its build,
for [the independent native audit](#independent-native-audits). Use the existing
fixed read-only export only at that group's audit wait, drain/close the export
sessions, and separately approve delivery. The guest waits for the delivered
audit epoch to drain, replays the exact receipt set and subject, then decides
whether timing is eligible. A disconnection can delay delivery or collection;
it cannot open either audit gate. If the sealed review wait expires after
24 hours and no audit control or delivery began, the guest writes a failed
terminal collection manifest and exits 2. This archive contains no qualified
timing. The separately approved collector can retire that exact quiescent host
only after replay proves the expiry and the original launch/boot/ownership
binding; a missing archive or uncertain delivery is not that proof.

Once timing cannot still be running, reconnect and preview then approve the **separate
child** collection command below with the measured checkout. A live or
unreachable unit is not terminal. Collection requires the pinned host/boot,
unchanged unit and archive, current quiescence, native replay and a fresh
pre-delete proof. Missing terminal evidence, an uncertain final bootstrap
acknowledgement, or an incomplete archive can require operator custody; none is
permission to delete or relaunch. The unit's 48-hour runtime limit bounds guest
work, not billing: the guest holds no provider credential, does not destroy
itself, and there is no independent provider-side billing watchdog.

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

If the operator independently confirmed external deletion of a standalone host
whose setup stopped before native entry, continue with the same commands, a
higher round, and a different reviewed merged commit. The report shows
`setup-failed-needs-census` when the original terminal observation, launch
intent, nonzero setup exit and campaign-free archive are preserved and no owner
lock remains. This is local eligibility, not a retirement receipt or a result.
The new reservation leaves the old attempt untouched. Its approval binds the
old host ID and evidence; immediately before create, the worker checks the
old ID is absent from the full census in the same account (even if the host was
renamed), and rechecks the original locks and evidence. Do not interpret prepare
or preview as proof of provider absence.

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

### Isolate an unacknowledged create

A single group whose only create has an unacknowledged response and no saved
droplet or action ID may be isolated in its existing continuation root. This
does not settle the POST, record deletion, release the child or fleet locks, or
allow the original reservation to issue another POST. Its row stays
`quarantined-create`, not verified or retryable. Other groups can continue only
in the same provider account, and their approved create uses one fresh,
account-bracketed provider response for
both the quarantine and historical ID checks and the ordinary pre-create
census. Only a complete inventory with unique, checkable rows proves absence;
there is no second read, page or retake. Nonempty pagination links, an inconsistent
count, or an uncheckable row cannot prove absence. The worker matches the bound
name and tag digests inside the bounded reply and returns only the sighting when
it finds one. This works beyond the count limits for absence and when another
field is malformed. If there is no match, only a complete, bounded projection
can pass ordinary creation checks. In that complete inventory any earlier
historical ID blocks the create even if renamed and untagged. This is not proof
the original POST never succeeded. A validated
name or tag match writes an exclusive `receipts/create-quarantine-witness.json` with the
numeric droplet ID and the matching quarantine digest, without changing the
original reservation. The witness blocks all subsequent creates in this root
even if the droplet changes name or tags. Reconcile it before another create;
there is no automatic clearance. A failed witness write retains operation
custody. Read-only continuation reports show a valid witness as a blocked
`quarantined-create-witnessed` attempt and still replay unrelated result
evidence. Neither a sighting nor a quarantine report authorizes binding or
cleanup.

A failed group may instead prepare a distinct, higher round in the same root
and provider account with `--replace-quarantined-create <quarantine-file-sha256>`.
Use this only after independently checking the original custody proof and
reviewing the risk that the unacknowledged allocation could still appear. The
prepared fleet binds exactly one earlier, same-group quarantine. It has its own
ownership, launch intent and approval. It takes the same account-bracketed
census as another group: any sighting in the census is witnessed and refuses
before the new create intent. After the intent, a final local admission check
before hand-off to the provider worker refuses on changed custody. This
proven-unsent refusal withdraws only the replacement's create intent, leaving
the custody records as found. The only controller path that publishes a witness
is the pre-create census under the shared continuation lock; another launch
cannot publish one while that lock is held. The local check does not see
out-of-band writes during worker hand-off. This does not prove that an earlier
create cannot surface at the provider later.
A replacement does not settle or edit the original
attempt, and another replacement requires the preceding attempt to be settled
or superseded under the ordinary rules for a never-launched reservation.

The operator must stop dispatch to the root and positively account for the
original local controller, worker and their descendants. A stale PID, a missing
droplet or a fleet failure receipt alone is not that proof. Keep that evidence
and the unchanged outer lock outside all the state roots. Use
`unacknowledgedCreateBinding(readFleet(attemptRoot, round, { priorSelection: true }))`
from `fleet-verify.mjs` to get a read-only binding of the existing state, intent,
diagnostic and three retained operation locks. Have a separate reviewer check
the operator evidence, the binding and the provider observation. Save
`receipts/create-quarantine.json` exclusively in that attempt with exactly
`{ schema: "benchmark-create-quarantine/v1", binding, localCustodyProofSha256 }`,
where the digest names the retained proof. Only then archive and release the
original outer continuation lock under the custody procedure below. Never clear
the child locks through this route or copy the attempt to a fresh root. The
binding and census do not replace the operator's process-tree proof.

### Provider-errored create

A create the provider accepts and then fails has its own terminal outcome
([#1689 Benchmark r21: catalog qualification droplet create errored before guest startup](https://github.com/corten-run/corten/issues/1689)).
The launch records it only when four proofs hold. Two stages bound them. Within the
create command's 10-minute deadline, which covers the POST and its action polling,
the polled action has the POST's action ID, `create` type, `droplet` resource type
and the POST's droplet ID (`create-action-errored`), and its status is `errored`.
After that command returns, the absence proof runs as separate provider commands,
each with its own deadline (60 seconds per command), so it can finish after the
create deadline: the exact-ID GET returns 404, and a single-response census lists no
droplet with that ID, name or run tag. The saved account is read before and after
each logical provider command (the create, the GET and the census), not around each
HTTP request inside one; the worker reads within a command on its pinned credential.
The single-response census is one provider response holding the whole inventory:
every row must have a positive unique ID, a name and a list of tags, the response
must report no further page and its count must match its rows. More than one page
(over 200 droplets), a count mismatch or any row that cannot be checked refuses, and
the census is never retaken, so a matching row seen once is never discarded. Offset
pages are not treated as one snapshot of the inventory. As soon as the worker
returns a valid errored identity, before any absence read, the controller saves the
POST's IDs as `createPending`. From then on only that droplet ID can be bound to
the reservation. When absence is proved it writes
`provider-create-errored.json` (action identity, account, absence, one create, no
replacement create, no DELETE, no guest, zero measurements), saves its hash as
`createErrored` on the still-unbound `creating` reservation and stops with
`create-errored-absent`. Its launch and operation locks are released, fleet
receipts report `create-errored`, a later round in the same root is not blocked, and
`--collect` only rechecks the receipt and absence before returning 1. That later
round's pre-create census fences each earlier failure's posted droplet by ID alone: a
listed droplet with that ID, whatever its name or tags, refuses with `posted droplet
is listed` before create intent, and an earlier failure recorded on another provider
account refuses the launch, since this account's census cannot see it. The fence
includes a contradicted create (below) after its pinned retirement: retirement deleted
the droplet it bound, it did not settle what the provider showed under that ID. After
the census, immediately before create intent, the launch rereads each earlier round in
the root: one whose state bytes changed, that took a lock or whose receipt has been
contradicted since refuses with `changed before this create`, with no intent or POST. It never
retries the create or relaunches the round. A later successful attempt is separate
evidence and does not qualify this one. The locks are released only after the
provider worker's teardown settles. If that teardown fails, both locks stay with the
recorded failure and every later path refuses it until the operator's custody step
(below) releases them; `--collect` then only rechecks.

Any missing or contradicting proof leaves the existing path unchanged: an unbound
or non-`errored` action stays `create-action-response`, a GET that is not 404, an
inventory row with the ID, name or tag, an account change or a transport failure
preserves the `creating` reservation for inspection. Such a reservation still blocks
later launches in its root. With a valid errored identity the saved
`createPending` stays: if the exact GET of the posted ID returns that droplet under
its own name, tags and placement with one public IPv4, the launch binds exactly that
allocation. Nothing else binds: not a census row after a 404 (even with the posted ID),
not a census after a GET that failed, and not an allocation with any other ID, even one
carrying this create's name and tags; each refuses `without binding`. That contradiction stays unresolved, and a later `--collect` rechecks
the saved action and absence as below.

The provider can report `errored` long after the create's deadline: in r21 the
action errored about 22 minutes after the accepted POST. A create action still
pending at the deadline stays uncertain with its locks, and the launch also saves
the POST's droplet and action IDs as `createPending` on the unbound `creating`
reservation (a lost POST response saves none). The launch's own launch and
operation locks stay too. A lock record whose PID is gone does not prove that the
original controller, provider worker and their descendants are gone, so no
controller treats it as settled. While either lock remains, group `--collect`
refuses before any provider read with `original launch custody retained` (both locks)
or `partial launch custody` (one), and changes nothing. The route on is the
operator's custody step for retained locks below: account for that launch's process
tree, keep the lock bytes and that proof outside the state roots, release the
group's `.groups-launch.lock` and `operation.lock`, then collect again.

That `--collect`, from the measured checkout, settles the create read-only under
the ordinary operation lock. It reads that exact action with `doctl compute action get`
on the saved account. An action still `in-progress` returns 3 and changes nothing.
Only the same action ID, `create` type, `droplet` resource bound to the posted
droplet ID and status `errored`, followed by the same exact-404 and single-response census
absence proof, writes the same `provider-create-errored.json` receipt and
`createErrored` and returns 1. Guest or monitor artifacts, an unbound or differently
bound action, a failed or uncertain read, a GET that is not 404, a census that is not
one clean response, an inventory match or an account change keeps the reservation
and its IDs and stops. An uncertain read or a failed provider teardown keeps that
collect's operation lock, which every later path refuses until the same custody
step. This errored path never creates or deletes. Fleet `--collect`
still reports a child holding its operation lock as busy and does not run this
recheck. No controller writes a `create-recheck.lock`; a stray one is refused as
custody wherever it appears.

One errored answer is not a failure: if the exact GET still returns the posted
droplet ID, the errored action left a real allocation. When that one row is
positively owned (the saved name, run tags, size and region, one public address)
and no unpublished receipt claims its absence, the collect binds exactly that
posted droplet, as the in-deadline launch does, and returns 3; the completed-action
route below then applies. Another ID, missing ownership, a census match after a 404
or an uncertain read refuses with nothing bound or deleted. An unpublished receipt
beside that exact GET, or beside a census row with the posted ID, the saved name or
the run tag after a 404, is contradicted: the collect writes the witness
`provider-create-reappeared` first, so a later 404 and empty census never adopt that
receipt, and takes the contradiction route below. A census row alone binds nothing.

Run tags count only as exact members of a tag array of non-empty strings. A tag
field that is a string (even one containing the tags) or an array with any other
entry is not ownership, for a bind and for the fresh ownership read before every
DELETE.

A stop between writing the receipt and publishing `createErrored` leaves the receipt
beside a state that still has `createPending`, and from a launch its locks (refused
as above until the custody step). The next collect repeats the fresh action read and
absence proof, then adopts the existing receipt only if its bytes are exactly the
canonical record for that saved state (its own census size and time); any other
bytes refuse and are left unchanged. `createErrored` is published through its own
fresh exclusive staging file (`state.json.create-errored-<random>.tmp`), as the
monitor-ending publications are. A fixed-name `state.json.tmp` left by a stop during
an ordinary save is not verified, so it is never read, promoted, removed or allowed
to block this publication. It stays for the operator to archive. A stray random-named
staging file is likewise left alone. An ordinary save on that reservation, such as
the bind below, still refuses on the fixed-name file until the operator archives it.
A stop after writing that create-errored stage and before its rename leaves it beside
the receipt. If the posted droplet then reappears, the contradicted bind below checks
the stage without reading it as state: its bytes must be exactly this reservation's
publication of the receipt beside it (the saved state with `createErrored` naming
the posted IDs and that receipt's hash), or a prefix of those bytes left by a write
cut short. Such a stage is recorded with its hash, like a reappearance stage, so the
pinned retirement can admit it. Any other bytes bind nothing: the witness is still
written, and the collect refuses with `not this reservation's publication`. That
file was not written by this reservation's publication, so account for its origin by
the custody step, keep its bytes and that account outside the state roots, remove
it, and collect again; the bind and the pinned retirement then proceed as below.

A `completed` action bound to the posted droplet is a real allocation, not a
provider-errored create. (Beside an unpublished receipt it contradicts that receipt,
and takes the contradiction route below.) After the custody step above, group `--collect`
reads the exact GET of the posted droplet ID, never a census. If that one row is the
posted ID and positively owned (the saved name, run tags, size and region and one
public IPv4) it binds that exact allocation and returns 3; a 404, a failed read or a
row without that ownership refuses with `nothing bound`, whatever the census lists,
and the next collect reads again. It never provisions. The binding is its own
checkpoint: that collection's provider worker closes when it returns, and a fresh
collection then retires it only through the pinned unused-bootstrap preview and
approval below, with the fresh unused-host proof and the existing deletion fences.
A monitored reservation takes the pending-monitor case of that route. An
`--offline-handoff` reservation has no monitor and its handoff never started, so
regular `--collect` keeps refusing it at the offline handoff gate, with stage
`offline-never-started`, whose CLI text names `--collect --unused-bootstrap-known-hosts`. The pinned route admits it only as an offline never-started
bound posted create (policy `offline-never-started-posted-create-unused-only-no-qualification`):
the saved host ID equals the posted droplet ID, prelogin policy, no monitor, an
empty ledger and seal list, no launch-pinned host key and no failure record, and,
in a continuation, neither the attempt's `.fleet-operation.lock` nor the outer
`.continuation-operation.lock` remains. It never manufactures a handoff, starts the
guest or relaxes a deletion proof.

A recorded failure is contradicted for good if a later collect sees its posted
droplet again, by the exact GET returning that ID or by a census row with its ID,
name or tag. That collect first writes the witness file `provider-create-reappeared`
beside the reservation, then saves `createErrored.reappeared` (time, which read and
the droplet ID) through its own fresh stage (`state.json.create-reappeared-<random>.tmp`),
and leaves the receipt bytes alone. The witness, a left reappearance stage or the
saved record each contradict the receipt: no later collect, launch in that root,
fleet verification or continuation accepts it again, and no approval or child recheck
made before the record admits the attempt.

If the witness or the state publication fails, that collect stops with stage
`create-contradiction-unpublished` and keeps its operation lock; `state.json` is
unchanged. Every later path refuses on that lock until the custody step below: account
for that collect's process tree, keep the lock bytes outside the state roots, and if
`provider-create-reappeared` is absent (the witness write itself failed), create it
(any content) before removing `operation.lock`. The next collect then sees the
contradiction even if the droplet has gone again. A reappearance stage the failed
publication left stays in place: it is never read as state or removed, and the bind
below records it.

A contradicted receipt, published or unpublished, has one route. Collect reads only
the exact GET of the posted droplet ID (never a census). If that one row is the
posted ID and positively owned (the saved name, run tags, size and region, and
exactly one public IPv4), it writes the witness if it is absent, keeps the receipt and
witness as evidence, replaces `createErrored` with `createContradicted` and binds
exactly that droplet and returns 3. It never provisions. `createContradicted` holds
the posted IDs, the receipt hash, `receiptVerified`, the bind's own exact read
(`reappeared`, always the posted ID), the witness hash (the witness keeps the first
observation, which can be a census row with another ID and the saved name or tag)
and, as `stages`, the name and hash of each reappearance stage and each checked
create-errored publication stage (above) left beside it.
`receiptVerified` is true for a published receipt with its saved hash or an
unpublished one whose bytes are exactly the canonical record for the saved state;
other bytes (a partial write, say) are kept as an unverified artifact, not evidence
that the create failed, and do not stop the bind of a positively owned droplet. A
fresh collection then retires it only through the pinned unused-bootstrap preview and
approval below (policy `contradicted-create-posted-droplet-unused-only-no-qualification`),
which admits exactly the receipt, the witness and each recorded stage, each with its
saved hash, beside the usual files (an unrecorded or changed one refuses), and keeps
the never-started unit proof and the fresh-deletion fences. Regular
`--collect` refuses it as an unused bootstrap needing that approval; an offline
handoff refuses with stage `offline-never-started`. Until retired, the reservation
blocks later rounds in its root. Any other answer, the posted ID absent, renamed,
untagged, in another region or size, without exactly one public IPv4, or another ID,
binds and deletes nothing and refuses with stage `create-errored-contradicted`. Its
CLI text names `--collect --unused-bootstrap-known-hosts`; until the exact droplet
shows its saved ownership, account for that droplet with the provider. No route
deletes a droplet that is not positively owned.

Fleet verification reports a group whose saved `createErrored` receipt rebuilds
from its state, with no launch, operation or recheck lock left, as
`create-errored`; it never qualifies the fleet. A continuation treats that attempt
like a retired one: the group may be prepared again in a new slot. The receipt and
the same lock-free custody are rechecked again at the final pre-intent recheck, so
a lock that appears after the scan refuses. The successor's child checks it once
more, after the account read that opens its create and immediately before it records
create intent and sends the POST, under the child's own locks: the attempt's
manifest and state bytes, its receipt and no launch, operation or recheck lock. An
old attempt that has taken custody again by then refuses the create. A collect of
that attempt that starts after this check never creates, provisions or deletes: it
runs the read-only receipt and absence recheck, or records a reappearance and binds
only the exact owned posted droplet (the contradiction route above). The approval
subject lists each such attempt's account and posted droplet
ID (`createFailures`, bound to its manifest, state and receipt for the selected
group's retry), and separately every earlier provider-errored attempt's account and
posted droplet ID in any group of the continuation (`postedCreates`, settled or
contradicted, including a contradicted attempt after its pinned retirement). The
successor's fresh pre-create census refuses any droplet with one of those IDs on that
account, whatever its name or tags, before it records create intent, whichever group
is selected. Each `postedCreates` row also snapshots its attempt (root, round, group,
manifest and state hashes, custody outcome and whether it was contradicted). The
child's final gate, after the account read that opens its create and after the
selected group's own recheck, rereads every one of them, separately from that retry's
eligibility: a changed manifest or state, a launch, operation or recheck lock beside the
attempt (the same custody check as the selected group's own attempt), a witness or
reappearance stage written since the snapshot, or a contradicted attempt not yet retired
refuses the create before intent or POST (`changed, took custody or was contradicted before
this create`). A contradicted attempt retired by the pinned route does not block; its ID
stays in the census fence. No local recheck is atomic with the provider: a
contradiction recorded after this gate is caught by the next launch, not this one.

Admission applies the gate's custody check first. When `--prepare`, `--print-approval`
or the approval reads the continuation, every earlier posted attempt, retired or not,
must have no launch, operation or recheck lock beside it; otherwise it refuses before any
reservation, approval prompt, intent or POST, with `continuation-admission; posted-custody`.
Nothing clears the lock. Account for its owner by the custody step for that attempt's
locks (verify the lock against the attempt's original launch or collect and that its
process tree is gone, keep its unchanged bytes outside the state roots, then release it),
and run admission again. If ownership is uncertain, leave the lock; the continuation
stays closed.

The group recheck settles only the child. A launch that stopped uncertain at its
create deadline also keeps its attempt's `.fleet-operation.lock` and, in a
single-group continuation, the outer `.continuation-operation.lock`; no controller
releases either. The dead batch lock does not block a new slot, but the outer lock
refuses every later `--prepare` and approval in that continuation root. Continuation
resumes only through the operator custody step described under retained locks below:
verify the outer lock's group, owner and process tree against the original launch,
keep its unchanged bytes and that proof outside the state roots, then release it and
prepare the group in a new slot. If ownership is uncertain, leave it.

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
for a bound `preparing` host with no seal and a pending unregistered monitor, the exact
interrupted first upload below in an offline-handoff reservation with prelogin policy and
no monitor, or an offline-handoff reservation bound to its late posted create that never
started (above). Preview and approve the exact pinned collection action with the same flag
and absolute state root.

```sh
node bench/workloads/cloud-production.mjs ROUND --state-dir ABSOLUTE_GROUP_STATE_ROOT --collect --unused-bootstrap-known-hosts ABSOLUTE_VERIFIED_KEY_FILE --print-approval
node bench/workloads/cloud-production.mjs ROUND --state-dir ABSOLUTE_GROUP_STATE_ROOT --collect --unused-bootstrap-known-hosts ABSOLUTE_VERIFIED_KEY_FILE --approve-reviewed-merged-ready REVIEWED_EXACT_HASH
```

- Before provisioning, the ledger must be empty (including after readiness exhaustion) or
  contain only the unacknowledged sequence-zero, 30-second bootstrap SSH `true` request
  ([#1618 Benchmark r21: first catalog SSH setup has no completion receipt and leaves an unused droplet outside ordinary recovery](https://github.com/corten-run/corten/issues/1618)).
- After a locally acknowledged upload, this path applies only to reservations launched from a commit
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
- If only the very first `job.sh` upload lacks a reply, the measured checkout can retire a host
  with a launch-pinned key **only if the upload never wrote the file**. The probe must find
  only the empty log, the two preceding terminal session receipts, and the exact upload
  request whose watcher failed before registration. Its deadline must have passed; neither
  original PID, connection, transfer server, watcher job, trigger, nor occupied control
  cgroup may remain. A partial file, later request, or missing proof preserves the host.
  An unknown **final bootstrap seal** is not a first-upload failure. The same refusal
  applies to ordinary unmonitored reservations and to offline reservations at any other
  bootstrap step. This records an unused retirement receipt, not a native archive,
  successful transfer, benchmark result, or reconciliation of an already externally deleted host
  ([#1977 JSON r61 loses acknowledgement of the first bootstrap upload and cannot retire the unused host through ordinary collection](https://github.com/corten-run/corten/issues/1977)).

Ordinary `--collect` refuses these pending-bootstrap cases before sending SSH. The pinned probe
never adds, acknowledges or retries a ledger request or starts a unit. A settled SSH refusal
leaves the reservation unchanged. Once a delete intent exists, preview and approve the new
state for exact-ID absence confirmation only; never replay DELETE.

The original local controller, provider worker, SSH and their descendants must be
affirmatively accounted for and gone. No elapsed timeout, absent PID or saved state
alone proves that. Preserve original locks and intents; the controller never clears
or takes over an old lock. Only after that local proof may the operator archive and
release the exclusive child and fleet locks under the existing custody policy.
For an interrupted first upload in a single-group continuation, also account for
the owner of the outer `.continuation-operation.lock`. It serializes all groups:
stop dispatch to that root and verify the lock's group, owner and process tree
against the original launch. Keep the unchanged lock bytes and proof outside
all three state roots before releasing any identified lock for in-place recovery.
If ownership is uncertain or any process can still act, leave the locks and host
alone. This is not the fresh-root handoff described above: after external
deletion the old locks stay in place and no collection is attempted.

Separately verify the SSH
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

For failure before monitor registration, an archived
`control/watch-failure-<id>.json` is never a receipt. Only the exact record the
guardian's watcher writes when its loop reaches the session's drainage deadline
can select a drain proof, and only when it names exactly one settled bootstrap
control in the saved ledger and the archive holds no receipt for it. Any other
watcher failure (an unowned scope participant, a changed listener or observer, a
sample or row cap, a launcher or observation timing failure) keeps refusing. The
terminal host query then also runs a separate fixed drain proof
(`cloud-setup-drain-source.mjs`) after the guardian, in its namespace. For each
failed watcher it requires, on the same boot: the live failure record
byte-identical to the archived one; that control's result exiting with the
ledger's code; its watcher unit failed or unloaded, with no main or control PID,
no queued job, an absent or empty cgroup and its observer gone; the session scope
from its registration absent or empty, with no process of the query's own inventory
inside it; and no process with an identity from that
session's chain or a parent among its PIDs. A process can leave both the scope
and its parent (for example `systemd-run --scope`, then reparenting to PID 1),
so every process outside the live query's own set must also have started before
the earliest failed session's first process. That set is the live session's
chain, its watcher, the query, its timeout and the SSH listener. The listener
must be the same process (PID and start time) that served every failed session,
so a listener restarted during or after a session, or a different one, refuses.
Outside that set only kernel threads are exempt: the kernel-thread flag, kthreadd
(PID 2) as parent and the root cgroup, all three.
Every check of the ordinary query still applies, including
the exact custody inventory, so a stream or unknown control file still refuses.
The host and the verifier also bind each of the failed control's request, start,
launcher, registration, result and failure records to the copied custody, which
retirement compares with the archive. Its receipt is
`benchmark-failed-setup-retirement/v3` (host observation
`benchmark-failed-setup-host/v3`, control proof
`benchmark-control-setup-query/v2` with exact top-level fields). A query with no
archived failure keeps its previous bytes and schemas, so the droplet path replays
saved receipts unchanged. Fleet verification and group continuation replay a v1,
v2 or v3 retirement receipt with the same verifier, which selects the drain proof
from the archived watcher failures, not from the receipt, so a group retired this
way can be continued. The proof adds no write: the failure, archive and exit
stay as they were, and it never qualifies the group.

The drain proof observes host state that can change, so its DELETE carries the
same deadline as the pinned unused proof: 60 seconds from the local start of the
host query, checked after the retirement's exact host read, before and after the
receipt is written, again after the intent's evidence verification immediately
before the intent is saved, after the DELETE's account preflight and in the
provider request. A drain proof's intent
is saved only after that preflight and the deadline check that follows it, as the
exit-one retirement's is, so a proof that expires during the preflight (or a
preflight that fails) leaves its receipt and recorded digest with no intent, and
the next collect recovers them on a fresh proof as below; so does a drain proof
that expires during the intent's evidence verification. The pinned unused and
v1 and v2 setup retirements save their intent before the DELETE's preflight, as
before (a pinned unused proof that expires during that verification likewise
saves no intent); a v1 or v2 setup retirement keeps its existing check of 60 seconds from
the proof's end, made before the intent. Expiry before the intent does not
consume the intent; expiry after the intent forbids another DELETE, so a later
collect only verifies the saved receipt and checks exact absence. For a drain
proof that leaves only the interval between the intent and the request (the
dispatch guards, the production checkpoint and worker IPC, and the provider's own
deadline check), which has no provider read; a proof that expires there still
leaves the host retired with no DELETE sent, which
[#2166 A failed-setup retirement whose drain proof expires before its DELETE is sent stays retired with no way to a fresh proof](https://github.com/corten-run/corten/issues/2166)
tracks.

Expiry after the receipt is written but before the intent leaves a receipt with no
intent. The next collect runs a fresh status check and host query, which appends
controls, so the old receipt is no longer for the final control. Collection
verifies it against the ledger prefix it names, which must still bind those exact
rows, and keeps it under its content hash for archival only. Only the fresh
receipt, which must be for the final control, authorizes the intent and the DELETE
under its own deadline. A history copy kept by an earlier interrupted recovery is
read back at the receipt's own bound (8 MiB for a v2 or v3 receipt), not 4 KiB.

That prefix check takes the receipt's own timestamps, so it cannot tell an edited
receipt from the one written. Before a v2 or v3 receipt is published, the state
therefore records its digest as `pendingRetirement` (`kind` `setup-failed` and
`evidenceSha256`); the retirement state that carries the intent removes it, and
each new receipt replaces it first. An interrupted v2 or v3 receipt is recovered
only when its bytes match that digest. A mismatch refuses with `interrupted
retirement receipt differs from its recorded digest; preserve host`, and a state
with such a receipt but no recorded digest (left by a controller from before this
check) refuses with `interrupted retirement receipt has no recorded digest;
preserve host`. Either refusal keeps no history copy, writes no intent and sends
no DELETE; the host is then handled by the operator cleanup below. Without the
prefix rule such a receipt could never be recovered anyway, because the retry's
appended controls make it fail the full-ledger check. A v1 setup receipt and the
unused and pinned unused receipts record no digest and keep their recovery by full
verification against the current state; the pinned unused reservation is locked
by its digest, so it cannot carry one. `controllerState` accepts
`pendingRetirement` only on a bound `starting` or `running` host with its
archive, evidence hash and extracted evidence preserved, and with no
`retirement`, `deletionIntentAt` or `destroyedAt`.

The digest is saved before the receipt is published, so a published v2 or v3
receipt always has one, and a collect stopped between the two saves only the
digest: the next collect finds no receipt and retires on a fresh proof. The
digest is saved through its own fresh exclusive staging file
(`state.json.pending-retirement-<random>.tmp`), as `createErrored` is, so a
save torn there leaves that stage and no digest, and the next collect retires
on a fresh proof. The stage is never read or removed; it stays for the operator
to archive. A v2 or
v3 receipt and its history copy are published whole: each is written and synced
as `<name>.stage` in the same directory, then hard-linked to its final name,
which fails rather than replace an existing file, and the directory is synced
(except on Windows, where the controller does not sync directories at all, so a
power loss there can still lose a link the collect reported). Publication
requires hard links in the state root; on a filesystem without them the link
fails, the collect refuses with the stage left in place and no receipt, and
nothing falls back to a direct write.
Between writing and syncing the stage and the link, each runs the retirement's
custody check below; a refusal there publishes nothing, so a saved digest changed
or a drain proof expired while the stage was written leaves no receipt or history
copy. The stage's name alone is not trusted: the write holds the file it created
open by its own descriptor until the link or the refusal, so a replacement cannot
reuse its inode, and keeps the digest of the bytes it wrote. Immediately before
the link the name must still be that file (device and inode) holding those bytes,
and after the link both names must be that file before the stage name is removed. A stage replaced or rewritten there
refuses with `publication stage replaced before its link; nothing published, the
replacement is kept` and is left as found. A custody refusal removes the stage
only while it is still the file this write created; a replaced stage is kept and
the refusal says `the publication stage was replaced and is kept`.
A write interrupted before publication therefore leaves only that stage, never a
partial receipt or history copy. A stage is never read: the next collect removes
a stage with exactly that name before it reads the receipt or the history copy,
including one left beside a published file whose stage link was not yet removed.
The v1, unused and pinned unused receipts keep their exclusive direct writes.

The bytes this process wrote, not the file, are the authority for the DELETE.
From publication until the DELETE is sent, the receipt is part of the custody
check below and must match that digest each time it runs.

Every write a retirement makes, and its DELETE, rests on one custody check. In
order: once the intent's verification has run, the evidence it pinned (below), the
slowest part; once published, the receipt this process wrote; the lock this
operation holds (the file this process created, by identity and bytes); the saved
reservation (`state.json`, byte for byte) as this process last loaded or saved
it; and, until the intent, a pinned unused or drain proof's deadline. The fast
checks always follow the slow ones, so a change made while the evidence is walked
is still seen. Once the DELETE has been sent, only the lock and the reservation
remain. That lock is
`operation.lock` for an ordinary collect and `stream-recovery.lock` for an
invalid-monitor recovery collect, which never takes the original
`operation.lock` it finds; a retirement under any other lock refuses. The
reservation bytes are read before the retirement's first await and must hold
exactly the state this process has loaded or saved; they are replaced only by the
retirement's own saves (a v2 or v3 receipt's digest, then the intent), so a
change made by anything else is refused and kept as made, never overwritten. The check runs after every await
or slow step and immediately before every write: after the exact host read (a
provider read), before a stale publication stage is removed, after an
interrupted receipt is verified (which hashes the archive and its extraction) and
before each of its stage removal, history copy and unlink, before the digest,
before and after the receipt is written, at the start of the intent (for a drain
proof, after the DELETE's account preflight), again after the intent's own
verification immediately before it is saved, and after the absence read before
`destroyedAt`. Each state save (the digest, the intent and `destroyedAt`)
checks it once more after writing and syncing its stage, immediately before the
rename that replaces `state.json`, and so does each receipt and history
publication before its link (above); a refusal there removes that complete stage,
which this write created, so it blocks no later save (a torn write's stage still
stays, as above). For the intent save that check includes the receipt and the
pinned evidence, so a receipt edited while the intent's stage is written refuses
with no intent and leaves the receipt and its recorded digest. Before the intent a mismatch refuses with `saved reservation
changed before the deletion intent; preserve host`, `retirement proof expired
before deletion`, `operation.lock changed; preserve custody` or
`stream-recovery.lock changed; preserve custody`, writes nothing after it and
sends no DELETE: changed during the host read, no digest, receipt or intent is
saved; changed during the account preflight or the intent's verification, the
receipt and its digest stay with no intent. A drain proof that expires during
that verification likewise leaves the receipt and its digest, which the next
collect recovers on a fresh proof. The retirement is verified, and its archive
and extraction pinned (below), before the intent is saved, so evidence that
changed by then refuses with no intent and leaves the receipt and its digest for
the next collect, which recovers them on a fresh proof once the evidence matches
again. After the intent the deadline goes with the DELETE itself rather than with
this check, so the absence read that follows a DELETE sent in time is not refused
for it.

After the intent, every retirement kind
(unused, pinned unused and failed-setup v1, v2 and v3) checks through that same
custody check, as this process left them, the
receipt, the saved reservation (`state.json`, byte for byte, so including its
retirement digest), for a v2 or v3 receipt the archived control custody its proof
was built from (the inventory and bytes of the evidence's `control/` folder,
including every watcher failure), for every failed-setup receipt the other inputs
its replay verifier hashes, and the lock this operation holds. The control custody
and those other inputs are checked first, then the receipt, the lock and the
reservation, so the last step before dispatch follows the slower evidence checks
and a receipt edited while the archive's identity is read is still refused. Those other inputs are `results.tgz` and the
whole extracted evidence tree (`run.log`, `host.txt`, `exit-code`, any `campaign/`
and `control/`). They are pinned without rereading them: the verification just
before the intent hashes each, recording `results.tgz`'s file identity (device,
inode, size, mode, link count, birth, modification and change times) around its hash and
every tree entry's identity in the same walk, and the dispatch check compares only
those identities. The archive's identity is compared on both sides of the tree walk,
the slow part, so `results.tgz` changed while the tree is walked still refuses. Nothing else in the state root is pinned; the replay verifier
reads nothing else. The check runs after the DELETE's account
preflight, before the controller hands the DELETE to its transport, and again in
the dispatch guard the transport calls after its last local await before the
request: the production transport's cancellation checkpoint, and, for an
in-process provider engine, the engine's own checkpoint before its REST request.
There it runs before a pinned retirement's own guard and refuses by throwing,
never by reporting the request unsent. The production provider worker is a
separate process and a function cannot cross its IPC, so in production the last
fence is the controller's, immediately before the action is sent to the worker; the
worker's own checkpoint and the IPC transit are not covered, and nothing covers
the interval between the request leaving and the provider acting on it; a change
made only in that uncovered interval is not detected. A mismatch found by one of
these checks refuses with `saved retirement reservation changed; preserve host`,
`archived control custody changed; preserve host`, `setup archive changed;
preserve host`, `setup evidence changed; preserve host`, `operation.lock changed;
preserve custody` or `stream-recovery.lock changed; preserve custody` and sends no
DELETE. A receipt edited before the intent (for a drain proof, including during
the DELETE's account preflight) refuses with
`published retirement receipt differs from the bytes written; preserve host`,
saving no intent; its recorded digest stays, so a later collect refuses it as an
interrupted receipt that differs from its recorded digest. Edited after the
intent, it refuses with the same message before the DELETE is sent, and a later
collect refuses with `retirement evidence changed`. Neither sends a DELETE; the
host is handled by the operator cleanup below.

The exact absence read after the DELETE is a provider read too, so `destroyedAt`
is saved only after the lock this operation holds and the saved reservation (the
intent state it wrote) are checked again. A lock missing or replaced during that
read refuses with `operation.lock changed; preserve custody` and keeps the
replacement; a changed reservation refuses with `saved retirement reservation
changed; preserve host`. Either leaves the intent without `destroyedAt`, and a
later collect under its own lock verifies the receipt, checks exact absence and
sends no second DELETE.

The drain proof is narrow. It can settle only a setup job whose host shows no
Docker socket or daemon at query time (in practice one that failed before
`docker-install`), with the guardian's exact deadline record archived, and that
left no process running that started during or after the failed session.
`bootstrap_stage=docker-install` starts `dockerd` and `containerd`, and the
controller keeps polling for the bootstrap marker (about every 30 seconds) while
the job runs, so a poll whose watcher fails after that point would find both
daemons older than its fence, which alone would accept them. In drain mode only,
the host query and the verifier therefore both refuse with
`Docker or containerd present` when `/run/docker.sock` or
`/run/containerd/containerd.sock` exists or is a symlink (even a dangling one), or
when any process's kernel command name is `dockerd` or `containerd` or starts with
`containerd-` (a shim). The query records the two socket observations in the proof
as `dockerSockets`. A `dockerd` or `containerd` started after the fence never
reaches this check: the start-time check runs first on both sides and refuses it
with `process started during or after a failed session`. The
command name is what a process reports, not an identity: this is a conservative
refusal, not a proof that no daemon held session work, and it also refuses a host
running Docker for any other reason. A failure before Docker started that leaves
any process behind refuses too. A
timer or other short-lived service that happens to run at query time (for example
`apt-daily` or `fwupd-refresh`, before the job disables them) refuses too. A
refusal is not retried: the query's refusal is recorded in the ledger, every later
collect stops with `setup-host-proof-refused` before another query, and the host
is then handled as it was before this proof existed, by the operator cleanup
below. The proof covers processes that were started. It cannot see work the
session handed to a process that already existed (such as `dockerd` or a D-Bus
service) or a thread added to an existing process. Nor does it see work handed to
systemd or D-Bus that has not started a process yet, such as a transient timer
that has not fired; that is acceptable only because control sessions run the
controller's fixed scripts.

`setup-watcher-proof-missing` means an
archived failure is not that deadline record, there is no control ledger, the
failure does not name exactly one bootstrap row in the ledger, that row is not
settled (no local terminal) or its code is not an integer, or the failure sits
beside its own receipt; collection stops before any query. A
custody read failure (for example a non-physical control folder or a record that is
not a regular file) is not reported with that stage: it keeps its own error, which
the production wrapper reports as `controller-collect`, and also stops before any
query. After
monitor registration the drain proof is never used: an archived watcher failure
refuses with the same stage before any query, because stream state may exist on
the host. `setup-host-proof-refused`
means the registered terminal host query had an acknowledged nonzero exit, or
exited zero but returned unusable proof. In the latter case the ledger retains
code zero and records the proof rejection separately. Neither is a retirement receipt. Do not repeat collection to try
to replace the missing proof. A missing transport acknowledgement remains
uncertain. If cancellation leaves an acknowledged exit zero without a proof
decision, the operation lock stays in place. Do not clear the locks or fill in
a ledger result.

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
Fleet verification and retry admission replay the saved failed-setup receipt
against its archive and extracted evidence. For a controlled receipt they also
verify the final setup query and the original control files in the extraction.
Verified setup retirement permits a retry; it does not qualify a result.
The retry approval binds the prior retirement, and the child rechecks it and
its custody before recording the create intent and again before provider dispatch.
A local refusal before contacting the provider keeps the new reservation unused;
a missing provider reply does not count as a local refusal.

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
group. This is a narrow exception to ordinary collection at the measured SHA.
Use a clean checkout of a **strict descendant** of the measured commit that
implements grouped pre-plan retirement and is in the fetched `origin/main` history.
The controller compares the complete committed contents of three files, not just
the group roster or the generated job. To check a candidate using full commit IDs:

```sh
test "$measured" != "$candidate" &&
  git merge-base --is-ancestor "$measured" "$candidate" &&
  git merge-base --is-ancestor "$candidate" origin/main &&
  git diff --quiet --no-ext-diff --no-textconv "$measured" "$candidate" -- \
    bench/workloads/registry.mjs bench/workloads/cloud-contract.mjs bench/workloads/cloud-remote.mjs
```

For example, measured `52b25c556499a9c4f537577aa3fcb6df175dd073` and merged
candidate `14126d2a8a12bccd173ec29032c1818d42904213` pass that source check.
A controller with the changed Git-install contract does not pass it for that
measured commit, even though it regenerates identical unmarked job bytes.
If no compatible merged descendant is verified, stop; do not substitute the
latest checkout or edit a reservation. Source compatibility is not evidence
of native entry, permission to delete, or a reason to reopen a closed slot.
An unacknowledged upload before checkout is not a pre-plan native failure.

This path requires a revoked monitor with a settled local owner, wrapper exit
2, an empty archived campaign directory, and the final failure line from the
measured job's native-entry command. An empty directory **alone** is not proof
that the application wrote nothing. Before retiring the exact host, the
controller checks the unit is idle, saves the campaign and native output roots
(including evidence of absence), verifies the local copies, and checks the
host and roots again. A changed or live host is retained. Neither the wrapper
archive nor the later capture qualifies the group or supplies timing results.

### Retire An Already Captured Handoff Failure

Ordinary collection still keeps a host when the native outcome is
`native-validated` but the wrapper exits 2. For a closed, settled single-group
monitor with the original measured-controller capture already saved, use the
same `--retire-failed-native` action from a clean, reviewed, merged descendant
that passes the source comparison above. Preview from that checkout:

```sh
node bench/workloads/droplet.mjs "$round" --state-dir "$state_dir" \
  --retire-failed-native --print-approval
```

Require recovery policy `grouped-handoff-failure-existing-custody-only`. Compare
its measured and capture controller commits, host and account, launch and
monitor identities, reservation and capture digests, and both archive digests
against the already collected attempt. Run the same command with
`--approve-reviewed-merged-ready <approvalSha256>` instead of `--print-approval`.
The controller checks that exact approval again under the operation lock,
reproduces the original capture script hash, and verifies both retained archives
and extracted trees before contacting the host. Revoked or unsettled monitor
custody, competing or retained locks, and unexplained prior retirement traces
are refusals, not grounds to take over, recapture or repack.

The action uses the existing fresh full rehash, final quiescence and ownership
fences, and bounded DELETE. Before intent and dispatch it rechecks the held
lock, verified custody file identities, both extraction inventories, and the
approved capture and retirement receipt. These checks read metadata and small
records, not archive or extraction payloads, inside the same proof deadline.
The handoff controller checks the approved reservation bytes and file identity
before every state write, including SSH requests and acknowledgements, and only
advances that expectation after publishing its own verified replacement.
Unexpected state is not repaired or overwritten; the operation lock is retained.
It records the merged repair commit separately from the unchanged original
capture. If DELETE was uncertain and the operation lock was released cleanly,
take a new preview at the same repair commit. With a recorded deletion intent,
the action can only verify exact authenticated absence. It rechecks local
custody under the held lock after that observation, before recording completion,
whether DELETE was acknowledged or this is an absence-only retry. It cannot
repeat DELETE, qualify the group, promote the wrapper exit, or publish the
native output.

### Retire The Sealed Client Heavy Exit 1

For [#2082 Benchmark r78 Client Heavy: ordinary collection keeps a paid terminal host after binding its failed archive](https://github.com/corten-run/corten/issues/2082),
use the same separate `--retire-failed-native --print-approval` command, not another
`--collect`. This policy is limited to monitored, dedicated, staged single-group
Client Heavy r78 measured at `7c13920f87b6baa6c7f967027d2eff9358201e4c`. Use a
clean, independently reviewed, merged descendant that passes the committed
source comparison above. The measured checkout, archive and extraction remain
unchanged.

Require policy `r78-client-heavy-sealed-exit-one-retirement-only` and operation
`observe-terminal-and-retire`. Check the preview against this attempt's consumed
launch intent, exact reservation, account and allocation, launch key, registered
boot, sealed campaign and original archive and extraction hashes. Use the exact
new approval hash with `--approve-reviewed-merged-ready`. The locked controller
requires a source-bound raw exit 1, a finished failed group (not a native-validated
group), an intact collection manifest and stream seal/drain, and the complete
r78 journal from authorization and bootstrap admission through the observed
command exit, phase seal and campaign finish. The sealed host observation must
name the same campaign, invocation, leader PID and start ticks, registered boot
and delegated cgroup. Its samples must show that leader in that group between
empty boundary samples, with each recorded process in only one cgroup per
sample. No pending native roots, validation, deletion intent or competing
custody may remain. This checks the command lifecycle, not renderer or native
qualification. It compares the original tar members to the bound extraction
before contacting the host. The verified extraction walk also computes the
existing campaign, control and native subtree hashes from the same bytes.
The collection manifest is still replayed separately, and the recheck after
that replay requires unchanged extraction metadata.

Both host observations use the launch-pinned key and the current same-account
allocation. The read-only probe requires the original boot and job controls, an
idle terminal unit with exit 1, no active benchmark work and no unaccounted
Client Heavy work roots. It checks the still-original wrapper archive and live
campaign/control/output roots against the held bytes. The final fence keeps
the same root inventory and rehashes the original archive within the existing
60-second DELETE proof window; it never repacks, downloads or runs native
validation. A mismatch or incomplete observation preserves custody.

The account preflight must finish within the proof window before the controller
writes the retirement files and durable deletion intent. Only an explicit
local pre-dispatch refusal or a positive not-dispatched acknowledgement from
the private worker can return to fresh approval and two new host observations.
The already acknowledged control ledger stays intact, and any tentative
retirement files are retained as unsent history, not as proof of deletion. These
checks permit at most one dispatched DELETE; only an authenticated exact-ID 404
on the saved account records completion. If DELETE dispatch or acknowledgement
is uncertain but the operation lock settled, preview again at the same repair
commit. Require operation `reconcile-absence-only` and approve that new hash;
it may only check absence, with no SSH or repeat DELETE. The same local custody
check runs after the provider worker closes, before publishing absence or
releasing the operation lock. If custody drifts, keep the lock and leave new
absence unrecorded, even if the provider read itself throws. An unexplained prior
receipt without its intent, interrupted publication or retained lock requires
operator inspection, never automatic takeover. Fleet and continuation treat
the attempt as unqualified and do not admit a successor before confirmed
absence. A successor approval binds the retired attempt's exact state, launch
intent and retirement receipt. The receipt binds a local metadata fingerprint
of the verified archive and extraction. The child rechecks these bindings and
the absence of retained custody before create intent and again before dispatch,
without rereading archive or extraction payloads. Keep the original files in
place; replaced or moved evidence may not match that fingerprint. The saved
ID must also still be absent from the same-account census. No timings or result
are accepted by this route.

### Earlier Failed Native Migrations

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

`cloud-cancellation-controls.test.mjs` checks the original control bytes on every run; its two
Python 3 cases run only when asked. `CORTEN_SYNTHETIC_CONTROL_BOUNDARY=1` runs the exact emitted
cancellation and custody programs through `test-fixtures/mixed-controls-boundary.py` on Linux, which
needs fresh private `/bench`, `/etc/systemd/system` and `/var/lib/cloud` directories, such as a
disposable container's tmpfs mounts. That setting, or `CORTEN_REQUIRE_PYTHON=1` where Python 3 is
guaranteed (CI sets it for `npm run check:workloads`), also checks that the boundary makes its Git
repository without touching a caller named by `GIT_DIR` and `GIT_WORK_TREE`. With either set, a
missing Python fails that check rather than skipping it.

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
and empty on historical hosts. Only a new `quietBootstrap: "prelogin"` reservation
requires the exact source-fixed boot data instead. Its unused-host and failed-setup
probes also bind those bytes to the canonical instance; missing or different data
never proves retirement. Descriptor and path identities are checked before and after reading,
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
For the destroyed r27 and r41 marketplace hosts, replay uses the original
per-locale roster to regenerate the three custody scripts and check their saved
hashes. That roster cannot authorize a reservation, launch or live custody check.

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

Local inspection has a 15-minute deadline including snapshot setup. With a saved
DELETE intent, no recorded destruction and a previously verified, monitored
result, a fresh collect may use up to 25 minutes for replay only after a
same-account exact 404. It checks absence again and rechecks the archive,
extracted evidence and terminal campaign and seal before recording cleanup.
It never sends another DELETE. Other replay deadlines are unchanged.
If ordinary collection at the measured commit cannot finish that replay, a
reviewed merged successor can reconcile an already verified, successfully
collected child with closed monitoring and a saved DELETE intent. Run the child
`cloud-production.mjs --collect --absent-measured-checkout PATH` preview from
the successor, with `PATH` the clean original measured checkout. Its approval must
name `collect-verified-absent-host-only` and the original measured commit. The
ancestor must supply the successor's complete replay source list. Replay reads
the measured commit's blobs and verifies the same evidence again. Only the exact
account and host may be read; a present host, changed reservation, or different
replay result refuses. This route records only `destroyedAt`; it cannot connect
to the guest or send another DELETE. Other collection paths keep their source
requirements.
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
is automatic. The round's `operation.lock` and its `stream-recovery.lock`, the
child locks the controller takes around a round operation, are removed only while
that path is still the file the controller created, with its bytes: if one was replaced during the
operation, teardown keeps the replacement and refuses with `<lock> was replaced
during this operation; the replacement is kept; preserve custody`, with any
earlier refusal as its cause. The root launch lock is still removed by path at
the end of a launch. A killed process may leave both locks. Inspect the exact process and
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
droplet ID is returned across provider IPC. The same exact action with status
`errored` is a permitted create failure, `create-action-errored`, whose output is
only that droplet ID and action ID; IPC rejects the code on any other command or
with any other output, and it is not absence proof. The controller requires that ID to
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
exact account command, its matching nonce/sequence, timely terminal proof,
observed exit 0 without a signal and confirmed IPC drain before cached settlement
may resolve. The owned child's exit and disconnect can arrive in either order
after proof. An exit or disconnect without proof, any later message before drain,
forced close or cancellation stays uncertain.
If the account command still fails, its terminal protocol does not accept an
identity even with `allowFail`; this worker cannot service another request.
An HTTP refusal and a worker lifetime failure are different outcomes, not different
authorities. A proved orderly failed account read can release normal lifecycle
locks; a later explicitly approved collect must independently re-prove ownership
and unusedness. No POST/DELETE or failed enclosing operation is retried, and an
existing deletion intent still permits only fresh absence reconciliation. Other
commands, including a create's action GET, cannot use the account terminal reply.

In the grouped launch worker, the fixed placement catalog GETs use the same private closure evidence for
`request-error`, `response-error` and `response-aborted`. The failure must occur
inside the original catalog deadline, all native requests, assigned sockets and
any responses in that worker must have been observed closed, and the worker must
not have attempted a mutation. This never retries a catalog page or accepts a
partial listing. The separate exact-key `cloud-provider-catalog-failed/v1` reply
uses the same nonce, sequence and `resources-closed` disposition. The parent
requires the exact pending catalog command (with failure allowed), a closed
`catalog-request` diagnostic, observed exit 0 without a signal and IPC drain, all before
expiry or cancellation. Read-only fleet previews do not take this terminal path.
It is still a launch failure, not placement or ownership
evidence. In a locked child this check is before create intent: the reserved
state stays unchanged, normal locks release on verified settlement, and the
existing independent continuation can report `not-created`. A successor still
needs a new, explicitly approved launch. In-flight or unobserved closure,
deadline, bad or missing proof, an unproved worker exit or prior mutation
attempt retain custody; nothing here recovers a reservation with create intent
or clears a historical lock.

Provider failures may append a bounded phase code to the generic CLI error. The
closed vocabulary in `cloud-options.mjs` distinguishes credential consumption,
account/list/catalog/create/delete requests, create response/link validation, action
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
are not forwarded. Catalog-request details use the same labels except
`invalid-json`: complete malformed catalog JSON still goes through catalog
validation. Other phases and unclassified failures retain their coarse codes.
A label alone does not prove settlement. The original r21 account-request and
r63 catalog-request causes remain unknown. A final `provider-settlement` stage
alone does not identify the original failing call.
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
For new dedicated reservations (`quietBootstrap: "prelogin"`), the provider sends
one fixed cloud-config in the create body, not caller-supplied user data. Its
`bootcmd` writes a root-only drop-in for `user@0.service` under `/run`. The
condition skips activation while the drop-in itself exists, even before the
first root login. The hook does not create a control binding.
With the genuine guardian binding in place, guarded install checks the boot
file's bytes, type, ownership and mode, atomically replaces it with the condition
on the binding, and reloads systemd. Neither condition stops an existing
manager or changes SSH, PAM or session ownership.

Both this handoff and the preceding `"after-start"` handoff keep the same
quiet interval. The last login before the drain starts the
unit. After that start is acknowledged, the controller opens no SSH session for
135 seconds: two minutes for natural drain, then the existing 15-second idle
check. The service uses its own monotonic exec-start timestamp for the window.
The before-drain and after-drain snapshots record the manager's active state,
main PID and monotonic activation time, not the time of either sample. A delayed
job can take both samples back-to-back. Without boot-relative journal times for
both samples, their spacing is unknown; do not infer what happened across the
two-minute window. Two active samples with different nonzero PIDs show different
manager processes, not why the process changed. Active followed by inactive
with main PID zero is the expected drain, not evidence of reactivation.
The job checks the installed and effective policy and requires an inactive
manager with no main PID before cloud-init and again before native entry.
New jobs also count UID 0 logind sessions at the early gate: a held login
is refused even if it never started a manager. The service logs the count,
monotonic sample time and presence of root's linger file, not session identities.
The final gate permits the registered monitor's session; all existing ownership
and process checks still apply. A linger file alone does not explain an active manager.
A late early proof fails rather than admitting a sample from after polling
could resume. Nothing retries the start, stops the manager or suppresses a failure.
Saved `"after-start"` jobs retain the drop-in installed after login and their
original job bytes. Saved `quietBootstrap: true` jobs retain the original check immediately after
unit start; jobs without the marker retain their drain check near native entry.
The run log records which property it is querying and the observed state and
main PID, so a busy manager can be distinguished from a stalled query.
If it stays busy the group fails setup, without terminating anyone's work.
The normal login inventory and registered-monitor checks still apply.

Before using this handoff across groups, rehearse on a disposable Ubuntu 24.04
VM with the target image's systemd, sshd, PAM and logind settings, not a container.
Use the production guarded upload/install/start and first status request. In the
rehearsal job keep the generated supervisor, drain and both idle checks; replace
the provisioning and workload body with a bounded stand-in. Record the rehearsal
diff, image and controller commit. Do not register it as benchmark evidence.
Supply the exact create payload on both hosts. On the clean boot require proof
from the installed image (including cloud-init, SSH service/socket aliases and
boot-relative journal times) that the boot policy was loaded before first
authentication. Upstream [cloud-init unit ordering](https://github.com/canonical/cloud-init/blob/24.1/systemd/cloud-init.service.tmpl)
alone is not that proof. Require both idle gates and verify the first status login
followed the early proof. On the second boot hold an identified fixture-owned
UID 0 SSH session across the early check. Even with an inactive manager and PID
zero the service must report the root session and refuse before provisioning. A
preexisting active manager must never be stopped. Do not infer that the negative
worked just from a failure or timeout. Bound each rehearsal to ten minutes, preserve the small
logs and source hashes, then remove the VM and its disks and confirm absence.
An ambiguous or failed result stops the rollout. Even a passing rehearsal needs
one separately approved real group to pass the unchanged pre-timing gate and
reach registration on the merged source before fan-out.

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
   accept or a switch to another host. For offline handoff, require the launch
   key file to match the saved `launchHostKeySha256`.
3. Through that bounded read-only SSH session, save `systemctl show` for the exact
   saved unit with `Id`, `LoadState`, `FragmentPath`, `ActiveState`, `Restart`,
   `MainPID`, `ExecMainCode` and `ExecMainStartTimestamp`. For offline status
   discovery, also read `SubState`, `Job` and `ControlPID`; use the same
   `cloud-sealed-collection.mjs::sealedUnit` predicate as collection. A terminal
   observation ends discovery, not the collection checks. For audit export require the expected
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
