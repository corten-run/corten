# Host lifetime failure diagnostics

`host-lifetime.mjs` samples actual delegated command scopes. An exhausted or
nonretryable sampling failure sets the sticky `host-observation-gap` terminal error
even when the next sample recovers
and all retained timestamp gaps are below one second. The continuity gate and the
no-observer-error gate are independent. A clean native exit or an empty final scope
cannot clear either gate.

`terminal.json` additionally retains `observerFailures` with a total `count` and only
the `first` and `last` caught failures. Each entry records the catch phase, operation,
allowlisted error code (or `unknown`), observation time, completed sample count and
last successful sample timestamp. Operation names describe fixed collector steps,
such as `process-stat`, `executable-link`, `process-name-recheck`, `cgroup-read`
and `sample-write`. No error messages, stacks, paths, arguments, daemon output or
arbitrary error properties are saved. Identity diagnostics distinguish PID, start-tick
and process-name changes while retaining the same full identity assertion. Repeated
failures do not grow a diagnostic log.

The original `observerError` remains authoritative, and a nonzero diagnostic count
also blocks replay if that flag contradictorily says no error occurred.

Legacy terminal files without these diagnostics remain readable but cannot reveal
the cause of a swallowed exception. Successful samples describe only completed
observations, not the failed attempt. Do not infer a specific exit race, permission
failure, identity change or latency cause from a generic `host-observation-gap` alone.

## Snapshot Retries

Each attempt reads the entire recursive scope's accounting and membership, then
captures every member with PID/start/name and executable bookends. A closing
recursive membership-only census must match the opening paths and PID sets. Order
alone does not matter. A changed census or a name-only bookend change discards the
whole attempt, including earlier process records, metadata and accounting reads.
No member is skipped or carried forward from a failed attempt.

Process-read ENOENT/ESRCH is a consistency candidate, not proof that a PID exited.
It can recover only through a new complete snapshot. A still-listed PID whose
executable remains unreadable exhausts the budget and blocks proof. Permission,
I/O, non-process read failures and PID/start-tick changes still fail immediately.

Retries use the time left until the previous sample's existing one-second limit,
capped at one second for an initial observation, rather than an arbitrary attempt
count. A monotonic deadline prevents a backward wall-clock change from renewing
that budget. A one-millisecond pause between attempts avoids a busy retry loop.
A retry completing after the deadline cannot publish a sample. Synchronous kernel
reads themselves are not interruptible; the unchanged saved-timestamp continuity
gate independently rejects any oversized gap, even without an observer exception.
Retries never clear a prior observer failure or replace positive empty-scope proof.

These are sampled observations, not an event trace of every short-lived process.
Cumulative cgroup accounting is reread even when exited members are absent from
the accepted census. Nothing reconstructs an unobserved executable or repairs old
evidence. The r21 process-read ENOENT records identify failed operations, not every
native runner failure or the cause of an exception-free accounting gap.

## Checks

Run portable replay tests with:

```sh
node --test --test-concurrency=1 bench/workloads/isolated/host-lifetime-churn.test.mjs bench/workloads/isolated/host-lifetime.test.mjs
```

Inside a fresh, explicitly owned delegated test unit with the layout described in
[the campaign contract](CAMPAIGN.md), run:

```sh
node --test --test-concurrency=1 bench/workloads/isolated/host-lifetime-linux.test.mjs
```

The churn tests use synthetic cgroup files on Windows and Linux. On Linux they also
force six actual, bounded, shell-reaped exits between the census and either the
stat read or executable-link read, using real `/proc` and real clocks. These hybrid
controls are not delegated-cgroup or host qualification. They test whole-snapshot
discard, recursive membership changes, persistent missing reads, immediate
permission/I/O failures, PID/start mismatches, monotonic retry exhaustion, and the
separate accounting-only block for a coherent 1,909 ms gap.

The delegated Linux tests use real child PIDs and cgroups. Fault-injection cases exercise
repeated interval errors, deadline exhaustion, strict process-name bookends,
unknown-code sanitization, recovery that remains blocked, and a final sample failure
that cannot claim an empty scope. Native descendant churn must retain all eight observed children and
positive empty cleanup. An actual 1,250 ms sampler stall must fail the unchanged
one-second continuity gate despite a clean native exit. These are collector tests,
not benchmark qualification or proof of a historical failure's cause. The two-member
bookend fixture proves that repeated name races discard earlier member records,
metadata and accounting reads, and that the accepted retry has complete fresh
bookends. Six name changes and a mixed missing-read/name sequence must recover
inside the deadline. PID/start changes, persistent missing reads and nonretryable
read-error controls remain blocked.
