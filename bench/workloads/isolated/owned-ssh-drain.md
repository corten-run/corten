# Owned SSH/SFTP Control Drainage

Status: production source and portable controls; **first-host native proof pending**.
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
installed helper. Python, unified cgroups and systemd are required; unsupported layouts
stop before native entry, without auth/PAM/config changes or an unregistered fallback.
There is one authenticated readiness attempt, not repeated ambiguous SSH probes.

SSH starts the fixed `/bin/bash -s`; modern SFTP starts the fixed installed
`/usr/lib/openssh/sftp-server -e`, using the client's explicit `sftp -s` server command.
The guardian holds input until its detached watcher publishes registration. The watcher
reads the real endpoint's ancestry, SSH connection/socket ownership, host/boot, session
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
Collection is not a harmless native-window status poll: an early registered collection
attempt is rejected and retained as an intrusion. Do not poll through SSH during native
execution. Audit admission uses its separate registered epoch while waiting for review.

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

The saved-state allowlist must admit `control` before this source can launch. Existing
failed-setup retirement remains fail-closed on the new control directory/watcher units;
it is not silently exempted or granted new deletion authority by these receipts.
Collection-time local success still returns `remoteDrained: false`; it neither proves
remote emptiness nor retrospectively qualifies a native boundary. Timeout, disconnect,
cancellation or missing result framing retains the existing locks/state/evidence/host.
Normal remote nonzero results remain distinct from transport uncertainty.

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
