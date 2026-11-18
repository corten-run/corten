# Host lifetime failure diagnostics

`host-lifetime.mjs` samples actual delegated command scopes. An exhausted or
nonretryable sampling failure sets the sticky `host-observation-gap` terminal error
even when the next sample recovers
and all retained timestamp gaps are below one second. The continuity gate and the
no-observer-error gate are independent. A clean native exit or an empty final scope
cannot clear either gate.

`terminal.json` additionally retains `observerFailures` with a total `count` and only
the `first` and `last` caught failures. Each entry records the catch phase, operation,
allowlisted error code (or `unknown`), observation time, admitted capture count and
last successful capture timestamp. These counts do not certify storage completion.
Operation names describe fixed collector steps,
such as `process-stat`, `executable-link`, `process-name-recheck`, `cgroup-read`
and `sample-write`. No error messages, stacks, paths, arguments, daemon output or
arbitrary error properties are saved. Identity diagnostics distinguish PID, start-tick
and process-name changes while retaining the same full identity assertion. Repeated
failures do not grow a diagnostic log.

If a catalog interval fails while reading the command's process census, its
failure entry includes `catalogCensus`. `entryGapMs` is the signed wall-clock
time from the last admitted sample timestamp to entry into the interval callback.
It can include the tail of the previous sample, the scheduled wait and time
in earlier failed callbacks since that last admission; it is not proof of
scheduler latency. `censusMs` is the rounded monotonic time spent
inside the failed census, including retries, and `attempts` counts whole census
attempts, including the first. The clocks differ: do not add the two durations
to reconstruct a wall-clock interval. None of these fields changes the retry
deadline, cancellation decision or replay verdict.
Earlier failures and failures outside the census have no such measurements.

To exercise the catalog build path without renting a benchmark host, the
**Catalog observer diagnostic** workflow runs Corten's ordinary single-app
catalog build and checks both data sources on a fresh hosted Linux runner.
It runs on manual dispatch or changes to the probe itself, not on main pushes.
Inspect the command outcome, host replay and native check summary together.
An interrupted build is a failed diagnostic, not a zero-throughput app.
There are no timed requests, other contenders or official-round results.

The original `observerError` remains authoritative, and a nonzero diagnostic count
also blocks replay if that flag contradictorily says no error occurred.

Legacy terminal files without these diagnostics remain readable but cannot reveal
the cause of a swallowed exception. Successful samples describe only completed
observations, not the failed attempt. Do not infer a specific exit race, permission
failure, identity change or latency cause from a generic `host-observation-gap` alone.

## Fault Shutdown

The first irrecoverable interval observation or storage failure requests command-local
cooperative cancellation through `onFault`. A sticky asynchronous writer error is
noticed on the next sampling tick. An admitted sample outside the unchanged
one-second continuity bound, or containing a recorded Docker-participant gap, also
notifies once, including during initial capture or attachment. Notification follows
sample admission and executable-capture transaction commit; setup then rechecks
cancellation before returning an observer or creating an interval.

Notification does not await storage, clear a fault, retry a command or change the
caller's signal. A throwing callback does not escape the sampler. The campaign joins
its owned supervisor through the existing cancellation path and retains invalid or
partial evidence, pending native roots and uncertain ownership. Failed lifetime
replay forbids another command. Neither observer failure nor command exit establishes
an empty scope, a complete archive or permission to delete a host.

The existing 120-second cooperative stop and five-second forced-terminal bounds
remain unchanged. They cannot interrupt a blocked synchronous kernel read, a stalled
event loop or outstanding filesystem I/O; FIFO ownership and storage deadlines still
apply. This contains invalid-run duration but does not establish a cause or fix for
the original SSH-associated survivors, whose attempt recorded no observer error.

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

Deferred executable captures are transactional: a rejected attempt closes only
its newly pinned descriptors, not inputs referenced by earlier accepted samples.
A complete census commits into the enclosing Docker observation, which must also
pass its root identity and Docker bookends. Those captures commit to the command
only after the enclosing sample passes all bounds and is admitted to the storage
FIFO. Synchronous admission failure rolls back that sample's new captures.
Rejected-only inputs are neither retained between retries nor hashed at finish.
After admission, pending captures remain owned until finish: a later async write
failure is sticky and prevents terminal publication rather than rolling back an
already admitted sample and pretending earlier evidence alone is complete.

These are sampled observations, not an event trace of every short-lived process.
Cumulative cgroup accounting is reread even when exited members are absent from
the accepted census. Nothing reconstructs an unobserved executable or repairs old
evidence. The r21 process-read ENOENT records identify failed operations, not every
native runner failure or the cause of an exception-free accounting gap.

## Catalog Build Startup

Catalog commands use the same pinned executable descriptors as browser commands.
The sampler still reads each member's PID, start ticks, name, cgroup and executable
bookends, with both recursive membership censuses. It seals the exact executable
bytes after the final resource sample, using the existing bounded helper. Catalog
does not query Docker for participant inventory and its gated bootstrap check is
unchanged.

In [#1643 Grouped catalog diagnostic: host observer cancels the first image build after a 1,791 ms sample gap](https://github.com/corten-run/corten/issues/1643),
the saved nonofficial run had a 915 ms gap before Docker appeared in an accepted
sample. At 14:17:06.923 UTC, sample 12 listed Node and Docker. The first caught
`process-cgroup` ENOENT was 1,644 ms later, the last `executable-link` ENOENT was
1,738 ms later, and the next sample was 1,791 ms later. The build reported
cancellation; the final scope was empty, but replay remained blocked. The archive
does not identify the failing PID, time the failed reads or measure the nested
guest's scheduler wait.

To check the distinction between a slow first read and a missing executable,
run the two catalog regression tests from the repository root:

```sh
node --test --test-name-pattern='catalog pins|listed catalog PID' bench/workloads/isolated/host-lifetime-churn.test.mjs
```

The first test uses a controlled clock: the sampler must retain the executable
without reading the whole file, then reproduce its digest at finish. The second
shows why an empty final scope is not enough: a listed member whose executable
remains unreadable still blocks replay. Neither test measures build speed or
qualifies a native catalog run.

## Ordered Asynchronous Storage

One in-process `fs/promises` FIFO writes initial process records and samples. It
completely writes each exact initial PID/start/name/executable/cgroup/type record,
fsyncs its file, closes it, fsyncs its directory and closes that descriptor before
appending a sample that references it. Samples are never written ahead of their
record dependencies, even when the kernel flushes un-fsynced appends on its own.
There is no helper process, worker, custom message protocol or production I/O hook.

The sampler retains its actual capture timestamps, 100 ms interval and independent
one-second replay limit. It can capture ahead of storage without retimestamping
rows at completion. The combined 256 MiB record/sample limit includes admitted but
unfinished bytes. Additional queue limits are 8 MiB, 64 frames and 4,096 initial
records, including the one in-flight frame. Overflow fails rather than waiting on
the sampler, dropping a member or growing an unbounded queue. Storage uses at most
two evidence FDs: the sample file and one record or directory. Queue payload and
V8 heap limits are not claims about total process memory.

`beginLifetime`, `attach` and `finish` are awaited. Attachment starts periodic
capture before waiting for its initial record writes, keeping the native bootstrap
gated until they finish. Finish stops capture, waits for every admitted frame,
fsyncs/closes the sample file and its directory, and verifies exact initial record
bytes before publishing terminal evidence. The terminal sample count must match
completed appends. A private fsynced terminal file is renamed to the final name
only after these steps; the caller receives a manifest only after namespace sync.

Observer setup remains owned by its command even if the gated native child exits
or is cancelled while asynchronous storage is pending. Supervision supplies a
startup AbortSignal and joins setup until it settles or the original 30-second
startup deadline expires; child close never renews that deadline. Cancellation,
early exit and setup failure forbid later attachment or timer creation. A late
returned observer is disposed without a terminal seal, and pending filesystem I/O
retains its FIFO ownership until it actually returns. Completed attachment releases
the startup-only listeners, preserving normal drained-cancellation collection.

Storage errors and the existing 30-second startup/frame/drain deadlines are sticky.
A timeout cannot cancel an uninterruptible filesystem operation. Its FIFO retains
ownership until the operation returns and cleanup is attempted; partial files and
an unproven scope remain retained, with no terminal seal or cleanup claim. Neither
an empty cgroup nor an eventual successful fsync clears a prior storage failure.
Fully observed and flushed cancelled/forced evidence retains the old contract:
it can be collected as explicitly nonqualifying evidence, never a clean success.
A new abort during finish cannot seal an earlier contradictorily clean result.

Queued raw bytes are **not yet durable**. Off-sampler capture enlarges the bounded
pending-observation window compared with blocking capture. Power loss before a
record's file and directory sync can lose that pending record; completed per-record
syncs still happen during sampling, not only at finish. Durable orphan records may
survive without a sample. Preterminal sample appends may be missing/torn after power
loss, as before. No referencing append precedes its record flushes. A process-kill
control tests interruption, not hardware power-loss durability or old failure causes.

## Checks

Run portable replay tests with:

```sh
node --test --test-concurrency=1 bench/workloads/isolated/host-lifetime-durability.test.mjs bench/workloads/isolated/host-lifetime-churn.test.mjs bench/workloads/isolated/host-lifetime.test.mjs
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

The catalog controls charge a first-sighting full executable read against the
remaining window, prove that pinned reads preserve identity and exact digests
through terminal cleanup, and keep a persistently unreadable listed member
blocked even with an empty terminal.

Pending-capture controls use real owned file descriptors with synthetic
membership and Docker reads. They check descriptor bounds, earlier accepted
inputs, final hash membership, enclosing-bookend and sample-write failures. Linux
uses the actual inherited-descriptor digest helper; Windows emulates only that
subprocess. These controls do not establish actual Docker/native qualification.

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
