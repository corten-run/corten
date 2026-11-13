# Provisional grouped cloud controller

Row 7 checkpoint, not official-run readiness. Expected USD is unknown; no price or
runtime estimate is supplied. No cloud executable, allocation, deletion, restart,
publication, schedule change or shared-state mutation was performed for this slice.

The controller is `droplet.mjs`, separate from catalog, marketplace, the dispatcher,
registry, parity and runners. It imports the existing read-only `cloud-contract.mjs`
for the complete nine-group selection, c-8/sfo2/Ubuntu identity, fixed remote files,
systemd unit and archive namespace. There are no adapter, provider, workload,
deployment, environment or numeric-settings CLI overrides. Popular/performance
views share evidence; they do not launch a second campaign.

**The CLI and default cloud transport are disabled.** Parsing a command exits 2
without opening controller state or spawning a cloud process. Importing the module
does nothing. `controller(options, dependencies)` is functional against the injected
fake process boundary used by the tests, not an official execution permit. It does
not require a hidden local launcher: detach provisions once and hands the fixed job
to systemd, then returns. Real transport must remain disabled until complete native
producer/OS/validator readiness, independent review and explicit operator approval.
Do not remove that guard merely because these tests pass.

## API

`controller(options, {run, repo, sleep, inspect, interrupted})` returns `launch()`,
`collect()`, `deliverAudit()`, a defensive-copy `state` getter and the local round
directory. `run(binary, argv, timeoutMs, allowFail)` is a synchronous process result
boundary, not a shell or an adapter plugin. `inspect` is the read-only campaign
validator seam for tests/integration, not a production adapter override.
`interrupted()` is checked between operations, during validation and before
deletion; it does not kill a remote unit or take over a live campaign.
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

The corresponding future CLI grammar is deliberately parsed but not executed:

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
One remote unit start is attempted; there is no forced power cycle, restart or
retry launch. SSH readiness is at most 40 bounded probes. The job has the existing
48-hour systemd lifetime; control calls have explicit timeouts no greater than
15 minutes. Collection does not poll a running unit. It requires exact loaded unit
ID/path, `Restart=no`, a terminal exit type, prior start and no live MainPID before
archiving, and checks again before deletion.

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

Base read: `41a84f57273b8c1c40e5822e815fc3e94edc6df0`. The separate development
campaign source initially returned
blocked/failed/invalid, `qualified:false`, `controllerReady:false` and
`deletionAuthorized:false`. Even manifest-verified is byte integrity, not independent
review, complete native production/OS evidence, source qualification or readiness.
Its reported review findings still include native-abort sequencing, incomplete
command-intent/started/exited pairing, and archive-controlled raw assertion leakage.
The parent is returning these to its author. This controller does not fix or clear
them. Future `verified` reports are refused until their contract is actually reviewed
and integrated; no speculative success schema is implemented here.

The catalog raw work and client saved-verifier imports reported by the parent do
not change this pinned base or remove those remaining producer/OS/native blockers.
No real campaign, native benchmark, cost measurement or cloud resource was used.

Focused tests (fake provider/process controls, local temporary files, a local
lock-holder child and synthetic local validator workers only):

```sh
node --test --test-concurrency=1 bench/workloads/cloud-contract.test.mjs bench/workloads/cloud-controller.test.mjs bench/workloads/cloud-audit.test.mjs bench/workloads/cloud-validation.test.mjs
```

The existing cloud-contract suite passed before implementation. The added suites
exercise lost/crashed creates, start loss, active/missing/foreign units, live and
dead locks, concurrent collect, state/path aliases, hostile archives, hash/tree
mutation, interrupted extraction, cancellation, uncertain deletion and audit races.
The test fixtures are manufactured apparatus inputs, never passing native results.
The independent review of the initial controller implementation
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

No dependencies were added. No renderer, runtime or request path changed, so those
performance measurements are inapplicable. Per the bounded ownership and fake-only
instruction, broader repository Rust/browser/container checks, package/check-script
integration, guide/changelog changes and an independent agent review are not done
here. This author checkpoint and self-check are **not review clearance**. Parent
integration owns those checks and review before removing any guard or proposing a run.
