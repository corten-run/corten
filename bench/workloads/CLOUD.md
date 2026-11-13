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
the exact subject, checks clean loaded/committed controller bytes, fetches only the
fixed public source repository's main ref, checks ancestry, then repeats the
snapshot checks. The first provider access repeats approval under the core's
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
`collect()`, `deliverAudit()`, a defensive-copy `state` getter and the local round
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
The fixed default validator is a lazy local import in a local worker, never
downloaded code. Its API remains exactly:

```js
validateCampaign({ folder, round, commit })
```

Its module is `isolated/campaign-verify.mjs`, not the plan validator with the same
function name. `folder` is the extracted `campaign/` root containing
`.host-attempt.json`, not its campaign-ID subdirectory. This module is absent at
the pinned base, so normal validation fails closed. Tests inject a synthetic
report with the current API shape; no synthetic report is native proof.

Each inspection has a fixed 60-second deadline and a 25-millisecond cancellation
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
agent/default keys. No credential is accepted in CLI arguments or remote scripts.
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
Responses have a body bound and whole-request deadline; in-flight timeout,
cancellation or malformed responses conservatively retain lifecycle locks.
Every provider-owning controller action awaits the same cached worker-close promise
before releasing its operation lock, including early-return and error paths. Forced
worker termination or uncertain shutdown retains the operation lock and any acquired
root launch lock. The outer finalizer awaits that same settlement, not a new teardown
after lock release. Ordinary confirmed shutdown releases the locks normally.
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

Bounds are 256 MiB compressed, 512 MiB expanded/tree file bytes, 100,000 total
physical nodes including the extraction root and every implicit parent directory,
64 path components, 255-byte components and 4,096-byte names/absolute extraction
paths. The entire tree, including shared parents counted only once, is preflighted
before any filesystem write. The post-extraction tree hash checks the same node
and depth limits again. Decompression is in memory, not streaming;
larger honest native campaigns remain preserved/blocked, not silently truncated.
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
