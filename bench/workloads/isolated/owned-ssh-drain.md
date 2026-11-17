# Owned SSH/SFTP Control Drainage

Status: production source and portable controls; **not source-ready: routine monitoring
needs a parent architecture decision, and first-host native proof remains pending**.
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

Audit delivery is a separate epoch. Remote publication produces only a private pending
delivery. The detached campaign waits for the audit seal, records admission, then
exclusively publishes the consumable inbox. Upload and publishing connections must
settle before timing. Bootstrap proof cannot substitute for audit proof.

## Native Boundary And Custody

The detached benchmark service remains independent of SSH. A fixed private mutex gates
control registration against native windows; window opening rechecks the sealed epochs.
Control attempted during a window creates retained intrusion evidence and prevents
advancement even if it later disappears. Collection traffic while the campaign owner
is alive also blocks. This is not a new worker engine.
Collection is not a harmless native-window status poll. The controller refuses a new
reservation's `--collect` before any SSH/SFTP once bootstrap is sealed, with an explicit
terminal-status-unavailable error. It does not return a made-up running status, sleep
indefinitely or let a routine operator poll invalidate a campaign. Legacy collection
keeps its existing single observation. Direct control that bypasses this refusal still
creates retained intrusion evidence in the remote guardian.

The original raw native end observation is preserved. Production still uses the unchanged
strict `verifyHostBoundary`; no later clean sample rewrites that observation or excuses
unknown processes, native workers, containers or networks. No process-name exception,
arbitrary kill, retry, restart or baseline adoption is introduced.

Execution version 4 requires bootstrap admission before `started`, separate audit
admission before staging, matching reservation/source/host/boot and replayable proof
files. Older execution versions remain explicitly legacy and cannot claim these events.
The terminal packer copies bounded private control records to the explicit archive root
`control/`, including pre-entry failures before Node or the campaign is usable. Existing
archives are not overwritten. Files have exact allowed names, private ownership, physical
paths and stable inode/content checks. Early failure does not qualify native execution.

The saved-state allowlist admits only the new `control` field; its strict ledger
validation remains in the existing contract. This does not resolve monitoring.
Collection-time local success still returns `remoteDrained: false`; it neither proves
remote emptiness nor retrospectively qualifies a native boundary. Timeout, disconnect,
cancellation or missing result framing retains the existing locks/state/evidence/host.
Normal remote nonzero results remain distinct from transport uncertainty.

## Monitoring Blocker

The current operator learns unit state and audit readiness by opening SSH. Authentication
and PAM/session creation occur before the fixed remote guardian can inspect a native
window. Therefore an SSH status request that arrives during a window is already control
traffic, even if the guardian waits, refuses payload or the session later disappears.
Treating that traffic as harmless would weaken the original raw bookend/timing contract.

These three requirements cannot all be met by the existing protocol: no live/control
SSH across native windows; fresh bounded knowledge of terminal/audit state; and SSH as
the only remote evidence channel. Local clocks, the service's maximum runtime, stale
receipts or a delayed clean inventory are not actual terminal/disappearance observations.
The new pre-network refusal is a safe failure, not an operational monitoring solution.
After seal, even a possibly finished campaign stays preserved until this is resolved.

Parent must choose an approved non-SSH terminal/review observation channel or explicitly
review a different experiment boundary permitting an owned persistent control channel.
Neither is implemented or implicitly authorized here. No new status server, credentials,
auth/PAM scope, polling exception or assumed terminal deadline is introduced. In
particular, this source must not be called ready for a routine official-host launch.

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
deletion policy to a native attempt. It is not a solution to post-seal collection.
New v2 proof/retirement records are capped at 8 MiB; the 25-second remote query,
30-second local observation and existing retirement freshness bounds are unchanged.

## Bounds And Qualification

Invocations retain their existing deadlines, capped at fifteen minutes. Live receipts
permit at most 32 ancestors, 8192 tracked identities, 4096 samples and 65536 aggregate
process rows; individual records are at most 8 MiB and packaged control custody at most
64 MiB. Bounds fail closed, not by retrying, truncating proof or raising deadlines.

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
