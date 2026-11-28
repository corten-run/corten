# Bounded single-host campaign entry

This checkpoint implements local host ownership, sequencing and collection, not cloud
allocation or an official campaign readiness claim. It retains all nine registry groups.
All nine fixed native entries now execute sequentially. Awaitable fixed saved APIs replay
their safely collected native trees; missing modules/proof remain blocked rather than
skipping an entire group. Actual source/OS integration is not inferred from synthetic
adapter tests. No benchmark timing was measured to test this code. Independent review,
merged native producers/validators and the explicit unit preparation below remain required.

The [owned SSH/SFTP drain contract](owned-ssh-drain.md) adds production registration,
input hold, sealed bootstrap/audit admission and watcher-terminal proof. Actual first-host
native qualification remains pending. Local transport exit still does not clear a remote
session, relax a host bookend, or release an uncertain lock.
New grouped catalog launches use one presealed CPU0-bound SSH control stream and an
explicit foreground local-monitor lease. Routine `--collect` reads its durable local
journal without opening remote commands/channels. Lost lease irrevocably invalidates
and cancels native work; qualification is no longer detached from the local connection.
Terminal stream notice/local exit is not remote-empty evidence: actual source-bound
identity/scope disappearance and existing unit/evidence gates precede normal cleanup.
Supervised audit delivery currently fails closed at its missing locked approval
checkpoint, so JSON/mixed/all-group review waits remain blocked. Catalog has no audit
wait. Legacy schemas/collection remain explicit. See the drain contract for custody,
failed-only recovery and first-official-host qualification limits.

## Parent interface

```sh
node bench/workloads/isolated/campaign-entry.mjs r17 --commit FULL_40_LOWERCASE_SHA --state-dir /bench/campaign
# On a dedicated host for exactly one complete registry group:
node bench/workloads/isolated/campaign-entry.mjs r17 --commit FULL_40_LOWERCASE_SHA --state-dir /bench/campaign --group catalog-page
# The reviewed fleet reservation passes its named layout to the same entry:
node bench/workloads/isolated/campaign-entry.mjs r17 --commit FULL_40_LOWERCASE_SHA --state-dir /bench/campaign --group catalog-page --load-layout c16-generator-v1
# An independent json-api fleet passes its saved c-16 or c-32 layout the same way:
node bench/workloads/isolated/campaign-entry.mjs r17 --commit FULL_40_LOWERCASE_SHA --state-dir /bench/campaign --group json-api --load-layout json-c16-generator-v1
node bench/workloads/isolated/campaign-entry.mjs r17 --commit FULL_40_LOWERCASE_SHA --state-dir /bench/campaign --group json-api --load-layout json-c32-generator-v1
# For a non-catalog group only at the placement authorized by the fleet:
node bench/workloads/isolated/campaign-entry.mjs r17 --commit FULL_40_LOWERCASE_SHA --state-dir /bench/campaign --group json-api --placement dedicated-sfo2
```

In new rounds the fleet can also pass `--placement dedicated-lon1` or
`--placement dedicated-blr1`. The sfo3 command still has no placement flag.
The catalog job keeps its separate `c16-generator-v1` layout.

The argument order and root are fixed. No selection, recipe, command, validator, image,
environment, output-path, retry or resume argument is accepted. The parent provisions a
private, same-UID `/bench/campaign` outside a clean checkout, a Linux host with Node 24+,
at least eight available CPUs (16 for a c-16 layout, 32 for c-32), Docker and the
actual native build/browser dependencies. Only the catalog group accepts
`c16-generator-v1`. Only json-api accepts
[`json-c16-generator-v1`](../CLOUD.md#json-api-c-16-placement-opt-in) and
[`json-c32-generator-v1`](../CLOUD.md#json-api-c-32-placement-opt-in). Their
bindings set `JSON_API_LOAD_LAYOUT` to the named value and pin the app to 1,
the upstream to 2-3, and k6 to 4-15 or 4-23 respectively. Without a layout
the existing CPU binding is unchanged. The parent separately
establishes the reserved host identity, authorized operator launch, unit/cgroup
ownership and exclusive fresh-host use. This code does not authenticate a cloud size or
prove host exclusivity from a receipt. The trusted parent launching this fixed CLI is the
operator-authorization boundary, not the offline contract's executionAuthorized:false.

`createCampaign({authorize})` has `begin(plan,{stateRoot,signal})`,
`advance(handle,{signal})`, `submitJsonAudit(handle,delivery)`, `submitMixedAudit(handle,delivery)`, `stop(handle,reason)`,
`status(handle)`, `verify(handle)` and `collect(handle)`. `begin` accepts only a frozen
recomputed `bindCampaign({round,commit})` or `bindGroupCampaign({round,commit,group})` plan, reserves `.host-attempt.json` exclusively
and returns an opaque live-process handle. The API also requires the fixed root. Callers
must supply an authorization policy, not a review JSON field. Serialized handles do not
work. A second instance, round, restart or completed attempt cannot acquire that root.
No lock release, native-directory deletion, automatic cleanup or retry API exists.

The private campaign umask remains in effect for evidence. Native fixture writers
publish only their synthetic input file as `0644` and its immediate read-only bind
root as `0711`. This permits known-path reads by non-root image users without directory
listing or access to private sibling evidence. No recursive permission change or
container user override is needed, and serialized workload input bytes are unchanged.

The optional final `--group GROUP` is one exact current registry name, not an app/case
filter. `bindGroupCampaign` returns `benchmark-isolated-group-campaign/v1`, with order
exactly `[group]` and the same complete native work that group has in `bindCampaign`.
The named catalog layout binds the host and CPU environment for its load generator,
without changing the native command, contenders or gates. Replay rebinds the plan
and requires the native summary's layout and actual CPU settings to match it.
All nine source procedures, the shared source digest, fixed recipes and round mapping
remain identical to the all-group plan. Unknown groups, injected selections/options and
edited plans are rejected by rebinding. A non-JSON group neither prepares JSON nor checks
its output freshness. JSON and mixed groups still stop at their mandatory independent
audit waits; no single-group mode approves or bypasses them. OS/supervisor/lifetime,
source-integrity, replay, collection and terminal gates are unchanged.

Each group plan owns one fresh host and its fixed reservation root. The parent may run
these hosts in parallel, but neither a group plan nor its result asserts a complete fleet.
The parent's separate fleet gate must bind the complete current roster, common round and
source, unique host ownership and complete evidence for every group. The legacy all-group
API still executes all nine sequentially and keeps its existing evidence schema.

The CLI owns the handle throughout sequential advancement, including audit waiting.
SIGINT/SIGTERM cancels the owned native command using the existing IPC supervisor and
bounded shutdown; the bootstrap retains its parent-loss watchdog. An uncertain terminal
or cleanup boundary halts further work. The parent must allow that shutdown before its
own unit-wide terminal observation. It must not infer terminal ownership from these files.

Exit 0 means complete intrinsic replay of the bound scope (all nine by default, or the one
complete group with `--group`), not external approval or a successful
comparative baseline. Complete, safely collected failed/blocked evidence exits 1. Uncertain
lifecycle/collection, interrupted review or an invalid replay exits 2 and preserves state.
No result file authorizes host deletion. The parent records its own unit terminal state, run.log,
host.txt and exit-code, and verifies an archive before any owned-resource deletion.

An irrecoverable host-observer fault requests command-local cooperative cancellation
once, without changing caller-signal ownership. This includes caught interval or
sticky writer failures and admitted continuity or Docker-participant gaps, including
initial capture and attachment. The command's owned supervisor must still settle;
invalid lifetime evidence preserves custody and prevents further commands. See
[fault shutdown](host-lifetime.md#fault-shutdown). Notification is not terminal,
empty-scope, archive-completeness or host-deletion proof.

## Rounds and recipes

Campaign rN maps to catalog cN, JSON prepare j(2N), JSON timing j(2N+1), marketplace rN,
mixed/browser/client/hardening wN and live/recoverable rN. N is 17..1000000000. Existing
native output for any reserved round prevents launch; there is no semantic retry.

Both live runners write to their fixed native result roots. Once the command's terminal
lifetime is proved, the campaign transfers only that round's result tree into the external
phase archive and seals its manifest before rechecking the complete source checkout. The
same intake retains failed-app output. Other tracked or untracked changes still block
finalization. Historical result paths, standalone commands and the archive layout are unchanged.

`campaign-contract.mjs` retains the complete registry and hashes the actual nine source
procedure files alongside all measured sources. The production map uses native defaults
except the existing marketplace-short-window, explicit native-feed-measure for both live
groups and mixed-production-measure in the legacy full campaign. Dedicated Mixed
campaigns use `mixed-production-asgi-webflux`: the same `--measure --profile matched`,
plus `--django-deployment django-granian-asgi --spring-deployment spring-webflux`.
The build and audit bind both deployments for both sources, without changing the
measured workload or its gates. The earlier Django-only recipe remains
`mixed-production-django-asgi`; replay uses the measured commit.
The older mixed-measure remains the default-profile recipe,
unchanged. Numeric defaults come from native parsers, not new CLI constants. Dedicated
client-heavy campaigns bind `client-heavy-comparison-v1` from the measured source; the
legacy full campaign retains client-heavy's single-sample diagnostic recipe. Browser
and hardening keep their bounded production procedures. No recipe name establishes
measurement or host proof. All need merged-source review.

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

Status includes uncollectedNativeRoots. A terminal command's entire native tree is collected
even when subsequent host cleanup/source observations fail. The live reservation records both
the checkout-relative original and the campaign-relative transferDestination before any move.
Both remain pending until the durable phase seal; an interrupted transfer may have bytes at
either path but cannot qualify. A staged seal left by a write failure is not a journal event.
If terminal ownership or safe collection cannot be established,
the parent must retain the host for inspection/terminal-safe collection, not delete it merely
because the campaign logs or partial archive were saved.

Host observations retain boot/host, CPU/memory/pressure/cgroup information, PID start
identities and Docker container/network boundaries before/after each group. A new persistent
process/container/network or changed host halts sequencing. These conservative observations
are not a resource peak measurement, an independent quiet-host audit, or proof of isolation.
Actual native CPU quotas/cpusets must still pass the fixed native saved-evidence gate.

The full-stack browser's timed roles are the application (CPU 1), upstream (CPUs 2-3)
and Chromium with its Node driver (CPUs 4-7); none uses the SSH apparatus's CPU 0.
The campaign pins the existing delegated command scope before starting the browser runner.
The runner checks effective CPU placement before timing. Replay requires the sampled
driver/Chromium cgroup, role-specific Docker limits, and corresponding running container
cgroups in the timing windows. This proves separation for those roles, not reserved physical
cores, host service placement, or qualification of the native browser matrix.

Detach preview and its locked recheck generate the official plan from committed
source. They use the same CPU-partition projection as stream open and replay.
Client-heavy keeps its Node driver, Chromium, Rust compiler and loopback server in
the delegated CPU 4-7 scope. Live delivery and recoverable live keep the existing
host browser/driver (including publisher) on CPUs 4-7 and each sequential app
container on CPU 1 at the existing one-CPU/1-GiB budget. Replay matches running app
and browser identities within the retained work windows and checks observed
processes' own effective sets, including child cgroups. It does not claim a trace
of every short-lived process. Mixed production shares the throughput roles for its
measured stage only; its separate functional capture has no pinning proof.

The fixed hardening adapter replays the bounded native service and dependency-recovery
results. The isolated recipe requires the bound CPU gate and its declared budgets and
CPU sets. A complete result still requires the native matrix, exact build archives,
effective CPU and process receipts, and clean terminal boundaries. Passing replay does
not authorize launch or establish a throughput ranking. Connection-flood resistance: not measured.

## Kernel lifetime observations

The parent-owned service must put its wrapper/worker in a supervisor leaf under its exact
`corten-bench-groups-rN-<16hex>.service` cgroup, with cpu/cpuset/memory accounting delegated
and enabled on the empty service root. A compatible systemd layout uses
`Delegate=cpu cpuset memory pids` and `DelegateSubgroup=supervisor`; the parent must verify
that layout on its actual systemd/kernel. Core does not change parent controllers, quotas,
cpusets or memory budgets and never moves the wrapper or an unrelated process. It fails
closed when delegation/accounting is absent. Full-stack browser, client-heavy and
both live commands require their bound child cpuset, without setting a new finite
host-process CPU quota or memory budget.

The fixed cloud bootstrap prepares Node 26, the root, bench and bench/browser npm lockfile
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

Core targets a 100 ms interval for recursive cgroup and live PID/start/executable
reads. Fullstack Browser leaves at least 50 ms between the end of each periodic
Docker census and the start of the next; a gap over one second still fails.

In the bound Linux Browser invocation, the Docker census shares a `flock` gate
with the runner's exact owned container removal. The observer reserves 50 ms for
capture and 50 ms for storage yield when waiting; inside that reserve it only
tries a nonblocking lock, and never renews an expired periodic deadline. After a
recorded fault, finish gets one fresh gate budget of at most one second to record
drain. The original sample times and fault remain; the fault still disqualifies the run.
The runner holds its exclusive lock from before the terminal participant receipt
through the Docker CLI's `close`, including after a client timeout. That is not
daemon acknowledgement: a late daemon removal can still create an observation
gap, which fails closed.

The exact bound Linux Live Delivery and Recoverable Live `native-feed-measure`
invocations use the same gate. Live keeps its 100 ms interval and its existing
actor receipts and workload-end clock. After the original full ID and ownership
labels are checked, only `docker rm -f -v <id>` takes the exclusive lock. The
synchronous Docker CLI keeps its existing deadline, with SIGKILL on timeout;
the lock is released after the call settles, not on a daemon acknowledgement.
An outside removal or a wait that exhausts the observation budget can still
disqualify the run. Standalone Live runs and other invocations are not gated.

The observer retains raw initial process observations content-addressed under processes/, references
the independently re-read identities in each sample, and records raw CPU accounting,
memory current/peak/events and effective controls. No environment or arbitrary command-line
values are retained; only known Chromium process-type flags are extracted. A 256 MiB
per-command observation bound fails closed, never silently truncates evidence. Observations
are incomplete if any retained sample gap exceeds one second; the IPC
setup deadline remains active until both the bootstrap and observer are ready. Raw
initial/final populated=0 and empty recursive membership must agree with terminal flags.
Observations add driver work; they are not a claim of zero observer overhead or a benchmark
timing result. Source-bound observation code is part of the campaign's evidence conditions.
The [storage FIFO](host-lifetime.md#ordered-asynchronous-storage) can write already queued
sample-only frames together (up to 16 frames and 256 KiB), without waiting to fill a batch.
Record frames stay separate. Each frame still counts toward the queue bounds until its
append finishes, and the append uses the existing storage deadline.

The fresh IPC-gated bootstrap's real executable is hashed before the initial empty-scope
sample. For commands using deferred hashing, attachment independently pins the live
executable and rechecks its inode identity; it does not compare it to that initial
hash. Other commands recheck the executable cache key. Startup hashing therefore does
not consume an interval between samples. The one-second gap gate is unchanged.
The Linux fixture delays that real read to test ordering, without replacing kernel data.

Each phase contains `command-N-host/{binding.json,samples.jsonl,terminal.json,processes/**}`.
Commands with deferred executable hashing also retain `executables.json` there.
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

Browser v2 host composition additionally reconciles every nonbaseline Docker inventory
member with the native replay's original full-ID population and its actual snapshot.
Unknown scopes, contradictory inventories, unexplained gaps or an internal participant
observation gap over one second cannot qualify. Creation before a running window and
exit after it remain explicit states, not missing live samples. A still-running native
terminal snapshot must name the actually observed PID/incarnation and zero restart count;
a replay-proven exited failure keeps PID zero and does not become a passing app. CPU and
memory limit files may be absent only on the actual cgroup-v2 root. Actual root observations
are retained and compared unchanged; required non-root/command controls remain mandatory.
The native participant window covers creation through its pre-removal terminal receipt,
not only its running interval. Every in-window poll still needs the original-ID snapshot.
A zero-history created prefix may precede the first actual live kernel observation by at
most one second; a matching exited suffix may follow the last live observation by at most
one second. States only advance created-to-running-to-exited. Missing interior records,
created-after-running, running-after-exit and contradictory terminal exit facts cannot
qualify. These bounds do not infer live processes before start or after exit.

For browser processes and members of catalog command scopes, the sampler opens
the actual `/proc/<observed-pid>/exe` inode,
records its device/inode/size/nanosecond modification/change identity and rechecks it
with the live PID/start/cgroup bookends. It pins that descriptor while continuing raw
sampling; it does not hash executable contents synchronously in a sampling interval.
After the final resource sample, a fixed local Node helper hashes only those inherited
descriptors. Before/after descriptor identity must equal the original sampled identity.
The helper must exit successfully within the existing 30-second bootstrap bound before
finish returns or another command starts. Descriptor closure is unconditional. Unresolved,
changed or unsealed hashes cannot qualify; `executables.json` binds the resolved digest
to its sampled reference. When sealing fails, `terminal.json` distinguishes starting or
running the helper, reading an inherited descriptor, rechecking its identity, and publishing
the proof. An identity failure can name its sampled reference, not the executable path or
arbitrary helper output. A ctime-only mismatch is still a failure, not proof of unlink.
Sample timestamps and the one-second gap gate are not rewritten
or relaxed. This post-sampling work is not benchmark timing and is not an OS authority
claim by the saved JSON. The existing pre-gated bootstrap executable check is unchanged.

For client-heavy, the campaign exclusively creates the native output's `.compiler` sibling
and holds its directory descriptor. The gated builder checks that exact empty directory
before using it as Cargo's fresh target. The campaign removes only its own target after
descriptor sealing and terminal-empty cgroup cleanup, including a drained command whose
native result or executable proof failed. An uncertain stop preserves the target. This
scratch is outside the native and phase evidence trees. Standalone builds still exclusively
create and remove their own target.

`host-participant-linux.test.mjs` is a separate actual-kernel fixture, not a portable test
or native-browser qualification. Its caller owns a fresh long-lived Node Docker container
with one CPU and 1 GiB memory, using the native pinned image
`node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067`.
The test only reads the original full ID; it does not create, stop or remove containers.
It requires root-readable `/proc` and cgroup v2 in the Docker daemon's actual host PID
and cgroup namespaces, plus the local Docker CLI/socket and Linux Node. Socket access
alone does not prove namespace correspondence. The caller must independently verify
the fixture's ownership before removal and save positive original-ID absence afterward.

Run with `BROWSER_PARTICIPANT_OS_TESTS=1`, `BROWSER_PARTICIPANT_ID=<original-full-id>` and
`BROWSER_PARTICIPANT_NAMESPACE=matched`:

```sh
node --test --test-concurrency=1 bench/workloads/isolated/host-participant-linux.test.mjs
```

For the mandatory delegated-unit control, use the same fresh owned unit properties and
fixed round as the lifetime fixture above; set those three environment values on the
unit and execute `sh test-fixtures/linux-participant-unit.sh <absolute-node> <checkout>`
from this directory. That helper uses the production `supervisorBootstrap`; it does not
create/adopt a unit or alter resource budgets. Separately run the same Node test with
`BROWSER_PARTICIPANT_NAMESPACE=mismatched` in a fresh private PID namespace while retaining
the same daemon socket and original container ID. Only an actual `/proc` identity/namespace
mismatch passes this negative control, not Docker timeout or permission failure. Portable
CI must exclude this file explicitly and mandatory Linux CI must select it explicitly.
These controls do not establish the full browser matrix, source authority, host exclusivity
or campaign readiness. The v2 native adapter/producer integration remains a separate gate.

## Post-command udev settle

An authenticated monitored or offline-handoff campaign can take one additional host
observation after official timing or untimed JSON preparation if the first-after
inventory contains only new sleeping children of the same baseline `systemd-udevd`.
Capture and replay use the same eligibility check: only the exact bound native
invocation for the campaign's registered group, round and phase can carry a sealed
clock. Fixture generators and helpers cannot carry one. The clock is optional;
without it only the ordinary first-after boundary can prove cleanup.
Live Delivery and Recoverable Live replay both censuses when a settled census
is present. Both must match the committed phase seal and the verified lifetime;
a supplied but invalid settlement cannot fall back to the first census.
The last native command must have a verified sealed terminal lifetime, including
proof that its accounting scope is empty, before the five-second wait begins. For
official timing, each worker's Linux start ticks must place its birth strictly after
the sealed terminal cutoff unless the following Live Delivery proof applies. For
untimed JSON preparation, the same strict comparison uses the pre-phase census
cutoff instead.

Isolated measured Live Delivery can also settle a cohort born after measured
work but before command exit. The successful native command records one workload
end after every measured actor window and before the last browser and owned
application are torn down. The phase seal binds that record to the command PID,
round and commit. Each measured end also records both clocks on that boot. Replay
orders the measurements, workload end and sealed terminal in each clock separately.
Linux uptime and worker start ticks share the boot-time clock, including suspend;
the monotonic clock excludes suspend and is never converted into boot-time ticks.
A worker in the same 10 ms bucket as the workload end is ambiguous and is refused.
Missing boot-time readings do not establish this proof. No baseline udev worker or
child of that daemon may be present, and every worker in the first-after cohort must
have been born strictly after the workload end tick. This does not establish the
absence of transient workers outside that cohort. The ordinary post-terminal route does not require
this evidence; historical rounds cannot use wall times to reconstruct it.

Both uptime and the monotonic apparatus samples must support the wait. Cancellation
keeps the first-after inventory and skips the second census. Exact cgroup, parent
PID/start identity and matching executable path, device and inode are required, not
just the worker name. On hosts where
[systemd-udevd links to udevadm](https://github.com/systemd/systemd-stable/blob/v255.4/src/udev/meson.build),
procfs may report `/usr/bin/udevadm` for the daemon and its workers. That path
alone establishes neither role nor cleanup. Saved replay uses the measured checkout and requires cleanup
proof before accepting JSON audit readiness. A surviving or replacement worker,
uncertain timing or ownership, a new login or benchmark process, or a changed Docker
baseline still stops sequencing. This does not alter a measured window, prove the
host was quiet, or qualify historical evidence that lacks the proof.

An [offline single-group handoff](../CLOUD.md#offline-handoff) writes execution
version 6. It uses the registered bootstrap and audit epochs without a stream.
Each phase seal includes the guest SSH fence readbacks before and after work;
replay requires the exact policy with zero excess/non-SYN hits, monotonic counts
for rate-bounded pre-login SYNs, and the ordinary lifetimes, workload evidence and
audit gates. Replay reports the packet and byte deltas by sealed phase in
`offlineIngress`. Untimed preparation permits bounded denied SYNs; official timing
requires zero throughout the fenced phase. The fence closes after any post-terminal
udev settle wait and second census, so a SYN denied after native command exit can
still disqualify the phase. Keep probes stopped throughout the fenced phase. The
measured workload window is unchanged. A valid archive with denied SYNs in the
timing phase stays replayable but cannot supply a comparison. The udev settle
checks use monotonic bookends taken on that boot, not workstation timestamps.
For a finished archive the replay result can bind the boot, hostname, ownership
token and exact bootstrap seal ledger to the collector's reservation. That
binding is not a whole-host terminal observation or permission to destroy the host.

An offline JSON or mixed audit wait with no delivery or audit admission can
seal a terminal failure after 24 hours. Replay matches the expired subject
and bootstrap seal, requires JSON's sealed preparation or mixed's absent
native phase, and reports `offlineAuditExpired` without timing results. The
separate collector can use this archived failure only alongside fresh whole-host
terminal and quiescence checks. Other unsealed or uncertain failures do not
qualify for this path.

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
For a verified dedicated client-heavy comparison only, eligible rows also
carry a `comparison` with sample count, actual attempted order for each block,
and per-action median/min/max milliseconds. Skips can leave order effects; the
range is not a winner claim. Native replay ties all three measured blocks to
the fixed recipe and host process windows. An unverified campaign exposes only
dispositions, even if a group's comparison was sealed before the halt.
Failed/unsupported apps remain comparison-ineligible. It has no qualified/controllerReady/
deletion approval claim. The live controller separately establishes operator authorization,
approved merged source, provider/unit ownership and exact unchanged archive-tree binding.

Native dispatcher imports are fixed: catalog verify.mjs validateSaved, JSON strict
inspectJson/inspectEvidence, marketplace validate.mjs validateSaved (returns the replayed
summary, not a status envelope), and the six fixed isolated adapters' inspectSaved. No
caller supplies a verifier. Native assertions/diagnostics are reduced to fixed public codes.
Missing or incomplete producer proof remains blocked; a summary alone is not a substitute
for native replay. Full actual all-nine execution, renewed source/build audits and
dependency proofs have not been performed by this checkpoint. The local delegated-Linux
fixture exercises actual collector lifetimes, not a complete campaign or provider ownership.

## JSON build, audit wait, then timing

JSON first runs the actual full native --build --check-only round. Exit 1 is accepted for
staging only if every selected app's four raw functional cells replay, image/CPU/source/commit configuration
matches, cleanup is clean, no timing occurred and exactly the missing independent audits
explain the failures. Anything else is a retained failed preparation, not an invented audit.
Actual Docker image inspect records for every app/payload build and canonical bound source bytes
are retained. Source names (including native `[id]` and `+page` route names) are mapped
to regular content-addressed `audit-sources/blobs/<sha256>` files by the source manifest;
they are not unsafe archive path names. Environment values are not forwarded from Docker image configuration.
`json-audit-subject.json` binds those images, every app/case identity, source/commit and both native
and source manifests. It explicitly has qualified:false and a review-needed blocker.
The retained image list includes both payload images for each app and both actual Node/k6 tool images.
If Docker omits `Config.WorkingDir`, the image evidence omits `config.workingDir` in both
the live audit subject and saved JSON. If Docker reports it, the subject binds the exact
value, including an empty string. Omission alone does not block review or authorize timing.

The fixed k6 image/version is prepared before functional checks, even in check-only mode;
this runs no load. Staging independently inspects both tool image execution configurations.
App and tool image-default entrypoint/command observations are compared with actual Docker
image inspection during staging and with the accepted subject during timing. Native JSON
receipts retain every role's entrypoint, command, effective executable and arguments: app
defaults are exact, and upstream/probe/load commands are the full fixed native invocations.
Missing fields or substitutions cannot be attributed as a complete target failure; old
captures need new evidence, not a waiver. Image environment values are not copied.

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
  "bundle": { "schema": "json-api-native-audits/v2", "receipts": [] }
}
```

The bundle must contain one independent receipt per selected app and profile, with exact
current image/CPU/source/commit identities and audited adapter source files. The cloud
inbox and campaign accept the v1 and v2 JSON bundle formats. For a failed API phase,
only an extended v2 receipt can establish the transport guarantees; a bundle version alone
cannot. The timing replay checks the receipt and its source bytes against the accepted
delivery. Preparation and timing must both use the current commit-bound producer. The empty
array above only illustrates the envelope, and is rejected. Operator-authorized transport
and actual independent review are separate trust boundaries, journaled explicitly. The
unsigned JSON cannot authenticate a human or make itself authoritative; the parent must
obtain the real review. No new signing/approval service is required or implied.

After acceptance the same handle stages `json-native-audits.json`, rechecks sources,
original/copy hashes and actual built image IDs, then runs timing with --receipts and
without --build in the paired fresh round. The native runner repeats its real checks and
requires the complete set of audits before timing. Images are checked again after timing. Accepted
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
Its phase ordinal comes from the saved, rebound campaign order: zero on a dedicated
group host, or that group's index in the full campaign. The adapter requires the exact
selected binding and a matching campaign-plan hash, reservation, commit and nonce;
it does not accept either ordinal interchangeably. The plan and reservation must remain
unchanged across replay, as must the phase's evidence tree.
It checks the exact binding/invocation, campaign/phase/command, boot and time window, native
manifest, positive terminal empty scope, observed browser renderer, inherited controls and
empty Docker container boundaries. Before using either one or two censuses, the adapter
replays the ordered campaign journal through the phase seal and checks that seal against
the whole phase. The recorded command start and exit bind the lifetime it reads;
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

Saved group evidence is recognized only from its recomputed group plan, without a caller
scope override. Its report uses `benchmark-isolated-group-campaign-inspection/v1` and the
same legacy top-level report fields, with `selection.groups` containing only that exact
group and its complete apps. There is no added top-level `group` field. It never labels
single-group evidence a full-registry campaign or invents missing groups. Group evidence
requires the current execution-version-3 audit/host gates; legacy all-group evidence
retains its existing read compatibility. Invalid/unsafe evidence retains the existing
fixed invalid result, not an untrusted scope label.

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
5. Browser v2 uses the fixed native `validateSaved({folder,round,commit})` API, with
   exact effective options, settings, profiles, full immutable source closure and all 240
   selected cells. Completeness/dispositions, apparatus cleanup and strict qualification
   remain separate. A replayed complete observed target/prerequisite failure retains the
   selected app, requires exact native exit one and supplies no comparison eligibility.
   Legacy v1 remains diagnostic only. No saved summary flag supplies absent raw replay.
   The adapter forwards only the replayed v2 host subject; core checks its execution seal
   and the complete regular-file byte seal against the safely inspected native tree.
   Independent kernel observations must still establish the actual process, Docker
   population, executable, PID/start, cgroup and continuous-window proof. Intrinsic
   qualification or HostConfig declarations never establish OS resources. The current
   native verifier checks `toolIdentities.lockSha256` against the immutable source lock
   and includes that replayed identity in its host subject. Core verifies the forwarded
   identity again; a historical subject that omits it remains blocked, rather than
   borrowing a saved source declaration. This handoff does not establish independent
   OS proof, native browser qualification or whole-campaign readiness.
6. Catalog/JSON raw replay distinguishes a complete failed functional attempt from a
   successful baseline. The bounded negative path is an initial JSON record-sweep violation:
   actual request intents and complete responses replay against canonical records, all
   started requests settle, and the fixed checker exits normally with code one. Catalog
   additionally retains inspected checker/app/upstream identities, CPU/memory/source settings
   and checker terminal state. Catalog requires each role's entire exact native mount set
   (no extra binds or image volumes), zero participant restarts and normal running,
   nonpaused/nonrestarting/error-free app/upstream observations. All three roles retain
   actual image command configuration and container entrypoint/executable/arguments;
   replay requires inherited image execution and the entire fixed checker/upstream
   command, not just its script suffix. JSON binds actual child exit/clock plus its existing runtime
   and upstream observations. Every selected app/source/payload is still attempted. Native
   owned-resource cleanup and all existing source/image/configuration gates remain mandatory.
   A single proven negative gates timing for the whole group; healthy peers remain passed
   but comparison-ineligible, and baseline remains false. No unsupported outcome is inferred.
   Network errors, missing responses, later browser assertions, timeouts, OOM, failed audits,
   harness errors or incomplete cleanup are not converted into complete target failures.
   JSON preparation may stage these replayed negative cells for independent review, but
   cannot approve itself. Timing-phase native receipts must still match the separately
   accepted exact image/source audit; core OS/lifecycle gates remain separate prerequisites.

The parent owns provider lifecycle, remote transport, unit ownership, archive validation,
reviewed merge, guide/changelog integration and broader repository checks outside this
directory. No provider, credentials, publication or nightly code changes are included.

Focused deterministic tests use Node's test-only module mocks, never production plugin
callbacks or real benchmark processes:

```sh
node --experimental-test-module-mocks --test --test-concurrency=1 bench/workloads/isolated/campaign-contract.test.mjs bench/workloads/isolated/campaign-entry.test.mjs bench/workloads/isolated/campaign-verify.test.mjs bench/workloads/isolated/campaign.test.mjs bench/workloads/isolated/json-staging.test.mjs bench/workloads/isolated/host-observation.test.mjs
```

Run binding tests in a clean committed checkout. Source/procedure hashes are real. Mocked
campaign/adapter records are explicitly synthetic, IPC tests launch real fixture processes,
and the delegated-Linux test collects actual kernel observations when its prerequisites
are present. None of those checks measures benchmark timing or authenticates a human review.
Mixed source/context tests retain a byte-pinned verbatim native archive-helper fixture from
288d10fc to avoid depending on an unmerged Git object in a fresh checkout. Build-only
dependencies throw if used. Production imports only the actual fixed native module and
fails closed until that API is merged; the fixture is not a native build/replay approval.
