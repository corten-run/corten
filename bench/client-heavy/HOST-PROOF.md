# Native Host Composition

This is an execution-worker seam, not a producer approval input. The fixed offline
API remains `await validateSaved({ folder, round, commit })`. Its v2 report exposes
`executionWindow` (Unix milliseconds spanning source-before through terminal/input
finalization), `processWindows` (actual Cargo run and each created browser context,
with app/phase), `toolIdentities` (observed Node/browser executable SHA-256), and
the exact `subjectSha256`, `files`, sources and invocation. Intrinsic replay does
not authenticate a saved folder or observe an OS on which it is replayed.

**Policy limit:** the helper currently accepts one strict cgroup profile, including
an isolated cpuset partition and equal finite descendant controls. These are an
implementation acceptance profile, **not** requirements sourced from the current
reviewed native campaign procedure. No new benchmark CPU/memory budget is approved
by this document. Do not change native defaults or manufacture caps to satisfy it.
The parent policy owner must approve and bind the expected resource policy before
admission, or implement a separately reviewed composition for effective inherited
ancestor limits or whole-host ownership. In particular, a child control of `max`
can be effectively bounded by its ancestor; this helper does not yet compose that
case. Core raw observation capture remains necessary in every case. This helper
alone cannot clear the current campaign adapter's unconditional resource blocker.

The trusted worker, not `run.mjs`, owns Linux process/cgroup observations while
that exact command executes. It supplies them over its existing trusted parent
channel, outside the native evidence folder. Never import receipts from a saved
approval file or accept them just because an untrusted manifest names an owner.

## Worker Procedure

1. Reserve an invocation-owned cgroup v2 unit on the authorized host. Before
   launch, read the actual unit controls and empty recursive membership, record
   the kernel boot ID, and start its lifetime process observer. Create an isolated
   cpuset partition with exclusive effective CPUs and finite CPU/memory limits.
   Configuration intent is not an observation. A unit that cannot supply these
   observations is not admitted by this implementation.
2. Execute the fixed invocation in that unit. Independently record Node, actual
   rustc, browser and renderer PID/start-tick identities and executable digests;
   include helpers and descendants, not only expected-role PIDs. Read the actual
   recursive cgroup tree and every member's `/proc/<pid>/stat`, `comm` and `cgroup`.
   Observe compiler activity during the retained Cargo-run interval, and live
   browser/renderer activity in each qualification and measurement context.
3. Monitor the unit's entire lifetime independently of the producer, including
   signal/abort and helper processes. Retain the underlying event/collection
   records and digest them as `coverageReceiptSha256`. Samples alone cannot prove
   no unobserved process escaped between samples. The trusted worker is responsible
   for lifetime containment, no monitoring gaps, role classification from the
   observed executable/selected process-type argument, and recursive enumeration.
   Do not dump arbitrary arguments or environment values into the receipt.
4. After command exit, positively observe every recursive cgroup empty and the
   host boundary using the existing host observer. Preserve the actual command
   exit/abort receipt. Seal/copy the exact native tree, replay it with the fixed
   API, and bind the worker observation to its full ledger/subject and windows.
   A leaked process, OOM/limit event, forced termination or monitoring gap is an
   apparatus failure, not a zero-valued framework measurement.

The existing core `host-before.json`/`host-after.json` process identities can
establish boot/host continuity and terminal differences. They do not provide live
compiler/renderer membership or actual unit controls. The worker must add the
above unit-lifetime observations, then call
`verifyHostProof(replay, context, hostProof)` from `host-proof.mjs`. On success it
returns `resources: "observed"`, `cleanup: "observed-unit-empty"` and the bound
unit/receipt identities. Contradictions throw a scoped reason. This is the precise
composition point for the campaign adapter's currently missing resources gate;
no native verifier edit or global waiver is needed. Campaign implementation and
OS observation collection remain worker-owned, not implemented by this producer.

## Receipt Fields

`hostProof` has exactly `schema: "client-heavy-host-proof/v1"`, `commit`, `round`,
`subjectSha256`, `filesSha256`, `bootId`, `unitPath`, `observerId`,
`coverageReceiptSha256`, and `samples`. Digests of returned ledgers use SHA-256 of
`JSON.stringify(value, null, 2) + "\n"`, preserving verifier order. The trusted
`context` supplies the same observer/boot/unit identity and expected `cpuSet`,
`cpuMax` (for example `"200000 100000"`) and integer `memoryMaxBytes`.

Each sample has Unix-millisecond `at`, `groups` and `processes`. First/last samples
must be empty and bracket the entire replay window; clocks are ordered. Each
sample contains the whole recursive unit tree, including the root. Each group has
`path`, and the raw file text from `cgroup.procs` as `procs`,
`cpuset.cpus.effective` as `cpuSet`, `cpu.max` as `cpuMax`,
`cpuset.cpus.exclusive.effective` as `cpuExclusive`, `cpuset.cpus.partition` as
`cpuPartition`, `memory.max` as `memoryMax`, and `memory.events` as `memoryEvents`.
This implementation requires the root partition be `isolated`, its exclusive CPUs
match, each observed group have the same effective finite bounds, no max/oom/
oom_kill counter changes, and no group or process escape the unit.

Each process has raw `stat`, `comm`, `cgroup`, observed `executableSha256`, and the
worker-classified `role`: `node`, `compiler`, `browser`, `renderer`, or `helper`.
PID plus start ticks identifies a process, not PID alone. Inventories must exactly
match recursive cgroup membership. Node/browser/renderer executable digests must
match the native executable byte observations. A compiler observation must be
rustc, not just a Cargo launcher. The worker retains its classification evidence;
the receipt omits unrelated command-line content and all environment values.

`admitSaved` additionally requires the independent source/build review and trusted
execution/configuration observation in README. OS proof is neither that review
nor operator permission. A worker can retain a valid failed six-app attempt and
successful resource cleanup without approving it or emitting timings for failures.
Synthetic host-proof fixtures test only this seam; they are never real receipts.
