# Grouped cloud controller checkpoint

Row 7 checkpoint, not official-run readiness. Expected USD is unknown; no price or
runtime estimate is supplied. No cloud executable, allocation, deletion, restart,
publication, schedule change or shared-state mutation was performed for this slice.

The controller is `droplet.mjs`, separate from catalog, marketplace, the dispatcher,
registry, parity and runners. It imports the existing read-only `cloud-contract.mjs`
for the complete nine-group selection, c-8/sfo2/Ubuntu identity, fixed remote files,
systemd unit and archive namespace. There are no adapter, provider, workload,
deployment, environment or numeric-settings CLI overrides. Popular/performance
views share evidence; they do not launch a second campaign.

**Production is operator gated, not a fake-only transport.** `cloud-production.mjs`
composes the reviewed lifecycle with actual bounded doctl/OpenSSH subprocesses;
the `droplet.mjs` CLI delegates to that same composition. Direct core imports keep
their default cloud-execution guard so they cannot accidentally bypass approval.
No cloud executable has been invoked in this development session. There is no
hidden launcher: an approved detach provisions once, verifies uploads, starts the
fixed systemd job and returns. Do not approve any action until the new transport
and native producer/OS/validator closure have passed independent review and merged.

The wrapper adds no provider, workload, adapter, environment or timing overrides.
Its only extra options are `--print-approval` and
`--approve-reviewed-merged-ready SHA256`. Approval is a trusted operator declaration
that this exact controller/action was reviewed, merged and is ready, not evidence
in a saved JSON file and not an attestation made by the program about itself.
The program separately checks the merged Git ancestry; it cannot authenticate who
performed a human review. Never feed the preview hash back automatically.

An approval subject binds the loaded controller's exact committed source, round,
mode, measured commit/SSH-key ID for detach, absolute state path, exact saved state
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
node bench/workloads/cloud-production.mjs rN --detach --commit SHA --ssh-key ID --state-dir ABSOLUTE_LOCAL_ROOT --print-approval
node bench/workloads/cloud-production.mjs rN --detach --commit SHA --ssh-key ID --state-dir ABSOLUTE_LOCAL_ROOT --approve-reviewed-merged-ready EXACT_ACTION_SHA256
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
local call settles or reaches its existing timeout. At the post-call checkpoint,
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

1. `detach:true`, full 40-character `commit`, numeric `sshKey`.
2. `collect:true`, using only the saved reservation identity.
3. Absolute `deliverAudit` file, exact `campaign` ID, explicit `approveSubject` SHA256.

The core mode grammar, with a production approval/preview option appended:

```text
rN --detach --commit SHA --ssh-key ID --state-dir ABSOLUTE_LOCAL_ROOT
rN --collect --state-dir SAME_ROOT
rN --deliver-audit ABSOLUTE_FILE --campaign rN-TOKEN --approve-subject SHA256 --state-dir SAME_ROOT
```

Exit/result conventions are 3 for a single running observation or delivered audit,
1 for terminal blocked/failed evidence with deletion independently confirmed, and
2 for CLI errors/uncertainty with no further host mutation. A lost deletion response
can mean the host is already absent, not that it was definitely preserved. API failures reject;
the caller maps them to 2 using `publicError()`, never a raw exception stack or
provider output. Exit 0 is reserved for a future strictly valid reviewed contract;
**this checkpoint cannot return it**. `fullGroupQualified` must always be false.

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
usable for preview and launch. The transport repeats its known_hosts-path check
as a final guard.
Production and the core share a bounded physical-root walk: a missing drive/root
refuses when no parent remains, and permission, non-directory or symlink-loop
errors refuse immediately rather than being treated as missing directories.
Preview never creates missing directories; core setup may create normal new ones.
Only doctl inherits the existing DigitalOcean token; SSH/SCP may use the existing
agent/default keys. No credential is accepted in CLI arguments or remote scripts.
The provider endpoint is fixed and doctl HTTP retries are explicitly zero, so its
429/5xx retry policy cannot repeat an ambiguous create/delete. The commands follow
[doctl's documented flags](https://docs.digitalocean.com/reference/doctl/reference/compute/droplet/create/)
and [OpenSSH's command/transfer rules](https://man.openbsd.org/ssh.1),
[SFTP-by-default SCP](https://man.openbsd.org/scp.1).

No tool version/configuration, agent-key availability, network, provisioning,
Linux systemd behavior or image-install supply chain has been exercised here.
Timeouts force termination of the local CLI child only, never of the remote unit.
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

## Independent JSON Audit

Audit delivery is a separate live-owned-host operation, never collection of a
review-waiting host. An explicit operator-approved exact subject hash is a separate
option; a receipt's `decision:approved` cannot grant authority. The caller must
obtain the actual independent review. The controller checks the full 36-receipt
envelope, saves exact bytes and durable one-attempt intent, verifies the live
campaign journal/plan/reservation/subject, and recomputes the subject's canonical
body hash. It uploads a private mode-0600 staging file outside the campaign root.
Immediately before publication it rechecks the live unit and exact waiting subject.
The fixed program uses bounded GNU `mv --no-clobber` for atomic same-filesystem
inbox publication, and checks that staging disappeared and inbox bytes still match.
An existing/racing inbox is never overwritten. Failure preserves the attempt and
bytes, not automatic retry authority. The native live process owns full receipt
and source/image validation; this transport never resumes it from serialized JSON.
Real OS behavior of that publication step remains an integration/host check.

## Readiness And Verification

Base read: `41a84f57273b8c1c40e5822e815fc3e94edc6df0`. Historical campaign source read:
`69bc0ffc62ec73ad4b4671ee57ae3e47a2afdead`. That API unconditionally returns
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

The parent reported the reviewed `616a8a245`/`7452abc90` lifecycle imported byte
identically at integration `5e2c6b6e9`, with 40 passing tests. This worktree remains
on its original base plus its own commits; no integration files were imported.
The production continuation read the campaign entry, saved verifier, journal,
source/worker and import closure at author HEAD
`bc2264f52b055af9550f5d44efc1155d301ec472`. That worktree has active author edits;
none were imported or executed. Its API still uses
`validateCampaign({folder, round, commit})`, current statuses blocked/failed/invalid,
manifest integrity, command lifecycle and pending-root diagnostics. The local
pinned integration does not contain the complete 13-module production closure;
the approval preview lists the missing paths. Presence is only an integration
check, not native readiness. On `d2c68e583fdae6d00d4a774fe0d6b640b29ead37`, a real
local-only detach preview returned 2, listed 12 missing modules (the offline
contract already exists), reported `fullGroupQualified:false`, and created no
state directory. That preview invoked local Git only, never doctl/SSH/SCP.

## Campaign Handoff

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

### Exact API Proposal Pending Agreement

Read-only inspection of the author tree at
`d03a019d8e7d26a7bbefa8b8d2f5c748479daaf2` confirms the three-key API and fixed
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

Focused tests (fake provider/process controls, local temporary files, a local
lock-holder child and synthetic local validator workers only):

```sh
node --test --test-concurrency=1 bench/workloads/cloud-contract.test.mjs bench/workloads/cloud-controller.test.mjs bench/workloads/cloud-audit.test.mjs bench/workloads/cloud-validation.test.mjs bench/workloads/cloud-transport.test.mjs bench/workloads/cloud-production.test.mjs bench/workloads/cloud-remote.test.mjs bench/workloads/cloud-signals.test.mjs
```

The existing cloud-contract suite passed before implementation. The added suites
exercise lost/crashed creates, start loss, active/missing/foreign units, live and
dead locks, concurrent collect, state/path aliases, hostile archives, hash/tree
mutation, interrupted extraction, cancellation, uncertain deletion and audit races.
The test fixtures are manufactured apparatus inputs, never passing native results.
The independent review of `616a8a245f7988d1505ec9e1c97cd0d144382e4a`
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
An initial bind-mounted Linux run at `2f761f967` was not green: 66 passed,
4 failed and 2 cancelled, with empty signal-probe JSON and the signal parent's
60-second timeout. A later staged attempt also omitted an audit dependency;
neither result is full verification or clearance.

No dependencies were added. No renderer, runtime or request path changed, so those
performance measurements are inapplicable. Per the bounded ownership and fake-only
instruction, broader repository Rust/browser/container checks, package/check-script
integration, guide/changelog changes and an independent agent review are not done
here. This author checkpoint and self-check are **not review clearance**. Parent
integration owns those checks and review before removing any guard or proposing a run.
