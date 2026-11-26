# Owned SSH/SFTP Control Drainage

Status: supervised catalog controller source and portable controls frozen for independent
review. First-host native qualification remains pending; no launch clearance is implied.
Neither portable tests nor local SSH/SFTP exit certify Ubuntu/PAM cleanup. The deleted
historical host's thirteen unexplained userspace identities remain unexplained.

## Registration And Admission

New controller reservations contain a durable `benchmark-control-ledger/v1`.
Before spawning each invocation, `droplet.mjs` saves its nonce, measured commit,
reservation, channel, purpose, request digest, existing deadline and helper-source hash.
The expected ledger is never reconstructed from delivered receipts. Saved reservations
without this field retain their legacy interpretation, not retroactive proof.

The earliest SSH command installs the fixed Python guardian/watcher bytes in a private,
collision-refusing `/run/corten-bench-control-<token>` root. Subsequent commands use that
installed helper. The fixed bootstrap loader consumes exactly the source byte length;
the guardian then consumes the bounded request length before holding the remaining
payload input. Source and SSH seal-ledger bytes travel over stdin, not process argv.
Python, unified cgroups and systemd are required; unsupported layouts
stop before native entry, without auth/PAM/config changes or an unregistered fallback.
There is one authenticated readiness attempt, not repeated ambiguous SSH probes.

SSH starts the fixed `/bin/bash -s`; modern SFTP starts the fixed installed
`/usr/lib/openssh/sftp-server -e`, using the client's explicit `sftp -s` server command.
The guardian holds input until its detached watcher publishes registration. The watcher
waits for the source-owned `systemd-run` launcher to finish before its first session
sample; launcher overlap is neither an ownership exception nor extra deadline grace.
Installed-helper command builders reject malformed tokens and out-of-range sequences.
The watcher reads the real endpoint's ancestry, SSH connection/socket ownership, host/boot, session
scope and PID/start/executable/cmdline identities. Names are not ownership evidence.
SFTP batch paths are escaped as protocol input, not interpolated into a shell command.
Existing host-key, batch, forwarding and client deadline policy remains in force.
The socket-owned shared listener may update its status argv, retained in raw samples;
its PID/start, executable and cgroup cannot change. No command name grants this role.

Each source-bound watcher runs outside the session in its own fixed transient service
with `Restart=no` and the existing invocation deadline. After the actual remote result,
it must observe every registered ancestor/endpoint and tracked descendant disappear,
including scope escapes, and the session scope absent or `populated 0`. Zombies block.
It saves raw registration/observations and a `benchmark-control-session/v2` receipt,
then exits. The detached campaign separately checks the watcher's actual unit terminal
state, PID/start disappearance and empty/absent cgroup. A receipt alone is insufficient.

The final registered SSH seal commits the complete controller-side epoch ledger and
includes its own invocation. Bootstrap admission waits for every receipt and watcher,
rejects extra registrations, login scopes and unregistered listener descendants, then
records the proof before the first host baseline. The first bootstrap connection and
final seal are not exempt. Both SSH and SFTP must be represented.
Userspace anywhere under `user.slice` also blocks, including a lingering user manager;
the first blocked raw inventory is retained rather than adopted into the baseline.

Legacy v4 audit delivery remains a separate epoch. Remote publication produces only a
private pending delivery. The campaign waits for the audit seal, records admission, then
exclusively publishes the consumable inbox. Upload and publishing connections must
settle before timing. Bootstrap proof cannot substitute for audit proof.

## Supervised Catalog Path

New reservations establish exactly one fixed SSH guardian stream before the bootstrap
seal. Its raw socket-owned listener and connection ancestry are source-, host-, boot-,
PID/start-, executable-, cgroup-, namespace-, thread- and affinity-bound. The source
pins every declared listener/member thread to CPU0 before registration. Native app,
API and load masks must exclude CPU0; their existing budgets do not change. The exact
declared apparatus remains visible in every original raw host observation. New children,
changed identities/affinity or unknown SSH/login participants invalidate, even if they
were present at the first bookend. No process name grants ownership.

The Python guardian emits typed progress, bounded audit material and a terminal notice
on that same stream. Local source validates frames and fsyncs a bounded append-only
journal. Routine `--collect` while the monitor is live reads that local journal only:
no SSH/SFTP command, channel, provider status query or remote child is created. The
foreground launch retains the existing operation/launch custody until the stream ends.
An unresolved reservation prevents another launch; the legacy `--detach` spelling
now stays foreground for this supervised path. It is not connection-independent.

Audit export uses the existing typed frames, with 32KiB decoded data chunks, at most
8192 files including the subject, 128MiB per source file and 256MiB total including
the subject. The small subject/approval limit remains 16MiB. The guardian compares
the exact private source inventory with the subject snapshot, opens each file with
no-follow/nonblocking flags, incrementally hashes its actual bytes and checks stable
file identity before emitting its end frame. It never reads a context archive whole.
The receiver writes exclusive private partial files with incremental hashing, fsyncs
completed files and validates the subject, manifest, snapshot and complete saved
inventory before renaming the partial directory and publishing its ready marker.
Wrong/missing/extra/replaced/aliased files, truncation and disconnect leave no ready
marker. Partial exports are retained and cannot be adopted or retried in place.
Export custody is not independent source/build audit approval.

The audit wait remains 24 hours and the guardian select wait remains 50ms. Writable
output normally returns immediately; there is no intentional per-chunk sleep. The
retained mixed packet used to reproduce the old limit contains 121812613 bytes
including its subject, 4184 files and 15632 payload frames. A conservative one
50ms wait per frame accounts for 781.6 seconds of scheduling, not a network
throughput guarantee. Disk/backpressure, progress traffic and human review consume
the same unchanged deadline; an incomplete transfer never extends it or qualifies.
With six-digit frame sequences, payload framing is at most 165553126 wire bytes
(excluding monitoring traffic), with a largest frame of 43850 bytes below the
unchanged 65536-byte frame cap. Payload alone therefore needs about 1917 wire
bytes/second averaged over the entire audit wait; usable transfer must also leave
time for review. Portable disk/fixture results do not certify native SSH throughput.

A challenged 15-second local-monitor lease is checked by both the guardian and an
independent campaign watchdog. Lease loss or apparatus change permanently invalidates
publication and triggers existing bounded native cancellation. It cannot resume a
qualified attempt after reconnect. The 48-hour absolute service/stream bound remains.
No new status server, provider credential, authentication or PAM configuration is used.

At normal native completion the guardian freezes and seals its observation log, then
sends the typed terminal notice. Local closure is not remote terminal proof. The
independent campaign process uses the fixed, bounded post-native probe to prove all
registered connection identities disappeared and every declared session scope is empty,
with the listener still bound and no unknown login survivors. Earlier bootstrap/SFTP
watchers likewise require actual unit/PID/cgroup termination before entry. Only after
this final actual drainage may the entry write the collection manifest.

An ordinary failed group can also reach this handoff. A clean SSH exit is not a
drain proof and a verified drain does not make the failed group successful.
After terminal publication, the campaign's fault line distinguishes revoked
control (`campaign drain control invalid`), a reply that failed parsing or
verification (`campaign drain invalid proof`), and a failed probe. A probe failure
uses `campaign drain probe` followed by a fixed category: `start`, `deadline`,
`output limit`, or `exit` (signal or unsuccessful exit). The registered guardian
remains byte-identical and does not report which internal check refused. A registered
identity still present remains pending; exhausting the overall wait is still
`campaign drain deadline`, not the deadline of an individual probe. No probe output is logged.
The saved [#2051 Marketplace r65 completes timing but the post-terminal drain probe refuses](https://github.com/corten-run/corten/issues/2051)
predates these categories. Its `campaign drain probe refused` line does not identify
which check or process failed, and this diagnostic does not qualify that round.

The collector waits for actual local closure plus a two-lease (30-second) embargo,
then may attempt guarded collection. The embargo is not proof that remote work stopped.
Remote guard admission additionally requires actual stream-drain evidence, or permanent
lease invalidation plus observed remote lease expiry for failed-only recovery. Existing
unit-terminal, exact provider ownership, archive/evidence and pre-delete unit checks
still run. Active work is never deleted; normal terminal cleanup issues one DELETE and
retains uncertainty rather than repeating it. Failed monitor recovery retains original
launch/operation locks, uses a separate exclusive recovery lock, cannot publish success
or automatically delete, and still needs existing actual-quiescence retirement gates.

If startup acknowledgement is lost before monitor registration, or a controller crash
leaves no actual local-close record, automated collection refuses and preserves the
reservation/host for inspection. A timeout or stale journal is not invented closure.
Failed-only collection can retain evidence but does not grant retirement of a new
failed native attempt; existing retirement ownership/quiescence gates still apply.

## Native Boundary And Custody

A fixed private mutex still gates new control registration against native windows.
Unregistered control traffic during native work retains intrusion evidence and prevents
advancement even after disappearing. The only permitted live stream is the presealed,
continuously checked apparatus, not an exemption for any SSH process. Legacy sealed-v4
collection still refuses intrusive status polling; older legacy collection is unchanged.

The first raw native end observation is preserved, including on apparatus-read failure.
The existing process/container/network boundary checks remain; narrow apparatus checks
are additional. No later clean snapshot hides a native worker or container. No arbitrary
kill, retry, restart, process-name exception or late baseline adoption is introduced.

Execution v5 explicitly adds the presealed apparatus, stream audit-admission and final
stream seal/drain records. V4 keeps sealed epoch admission; older versions remain
explicitly legacy and cannot claim either newer proof. The packer copies bounded private
control custody to `control/`, including pre-entry failures. Archives are not replaced.
Transport uncertainty retains locks/state/evidence/host and remains distinct from normal
remote nonzero completion. Local result records continue to say `remoteDrained: false`.

## Audit Gate

The stream producer/consumer has typed audit-ready, same-stream material, private pending
delivery, sealed admission and exclusive inbox publication controls. However the public
supervised `--deliver-audit` action deliberately refuses before queueing: its local-only
queue does not yet execute production's existing locked approval recheck. Integrating
that authorization checkpoint is outside this catalog freeze. This blocks supervised
JSON/mixed/all-group completion at their mandatory review waits, not catalog-page,
which has no independent audit wait. Legacy audit delivery is unchanged. No approval
or review requirement is bypassed to make another group complete.

## Pre-Entry Retirement

New control reservations may use failed-setup retirement only while bootstrap remains
unsealed, no native campaign/window/admission exists, the unit has the existing nonzero
terminal setup exit, and the campaign directory is absent or empty. The original
metadata, exact job/unit/script hashes, cloud-init, container-idle and process/path
checks still execute. Legacy script bytes and v1 receipt interpretation are unchanged.

The v2 failed-setup receipt adds the complete expected request sequence, prior session
receipts and actual prior watcher termination, fixed helper/boot binding, raw current
query registration, executable/argv/PID-start/cgroup identity of the current read-only
Python/timeout query and its source-bound watcher, and bounded original custody hashes.
Only those exact identities may remain live as the retirement query itself; no name
grants ownership and no unknown participant is adopted. The fixed transient watcher
must have the exact active PID, source command, unit path, cgroup and `Restart=no`.
Changed source, sequence, boot, custody, unknown descendants/login/unit participants,
earlier live watchers or any native entry refuse retirement. A transport failure still
retains locks/state/host.

This proof deliberately returns `remoteDrained: false`: the current query/watcher have
not yet disappeared. It extends neither native qualification nor the existing pre-entry
deletion policy to a native attempt. It does not authorize post-native retirement.
New v2 proof/retirement records are capped at 8 MiB; the 25-second remote query,
30-second local observation and existing retirement freshness bounds are unchanged.

## Bounds And Qualification

Invocations retain their existing deadlines, capped at fifteen minutes. Live receipts
permit at most 32 ancestors, 8192 tracked identities, 4096 samples and 65536 aggregate
process rows; legacy/session records are at most 8 MiB and packaged control custody at
most 64 MiB. The supervised stream has 64 KiB frames and a 64 MiB observation/journal
cap, with 2-second maximum observation gaps. Bounds fail closed, not by retrying, truncating proof or raising deadlines.

`cloud-control-runtime.test.mjs` executes the actual fixed Python source against an
in-memory kernel/systemd/SSH/SFTP fixture, never real host services. Separate negatives
cover disconnect, surviving ancestor/zombie, live watcher, unknown session survivor,
intrusion, changed custody inode and mismatched completion framing. Replay tests retain
the original thirteen-survivor rejection despite clean direct-command observer metadata
and a later clean inventory. The legacy v1 replay/preflight API is not a live producer.

On the first official host, before native bookends, the production barrier must qualify
actual Ubuntu/PAM ancestry, exclusive session scopes, socket ownership, the installed
SFTP server, input hold, every terminal receipt and actual watcher termination. Stop and
preserve evidence if any premise fails. No separate paid calibration, native test,
authentication change, provider action or launch clearance is implied by portable tests.

## Source Closure

Saved validation calls `campaign-verify.mjs` -> `control-admission.mjs` ->
`../cloud-control-session.mjs` for receipt replay, plus the existing
`campaign-journal.mjs` and `host-observation.mjs` for journal and raw-stat validation.
The admission module also imports `../cloud-control-runtime.mjs` and
`../cloud-local.mjs`; the runtime imports `./cloud-transport.mjs` and
`./isolated/control-session-source.mjs`. All six imported paths must be captured even
though saved validation never calls the live subprocess functions. The fixed Python
string is imported and hashed during replay, not executed there.

Controller/native producers additionally use `droplet.mjs`, `cloud-remote.mjs`,
`cloud-audit.mjs`, `isolated/campaign-entry.mjs` and `isolated/campaign.mjs`.
`isolated/control-session-qualification.mjs` is legacy test support, not a live producer
or an import of saved validation. `test-fixtures/control-session-kernel.py` is test-only.
`cloud-retirement.mjs` additionally imports the runtime, session replay and admission
helpers for pre-entry v2 proof only; it is not reached by saved campaign validation.
No dependency, source-inventory allowlist or validation resource cap is changed here.

The supervised path additionally imports `isolated/control-stream.mjs` from saved
campaign/admission/host verification. Its pure verifiers execute during replay.
`isolated/control-stream-source.mjs` is imported by the fixed guardian source and must
be captured: its Python bytes are hashed during saved replay, not executed there.
Producer-only modules are `cloud-control-stream.mjs` (also a literal dynamic import of
`cloud-transport.mjs`) and `isolated/control-stream-remote.mjs` (campaign entry).
The Python source module imports `isolated/control-stream.mjs` for its literal audit
bounds, adding that replay import edge but no new production module. The read-only
`test-fixtures/control-stream-material.py` fixture is test-only, never saved replay;
on Windows it models Linux private permission bits/no-follow availability rather
than claiming to qualify those native filesystem guarantees.
The new stream fixture/kernel and stream test modules are test-only. Parent integration
must recompute exact immutable closure; no inventory allowlist or resource cap is edited.
