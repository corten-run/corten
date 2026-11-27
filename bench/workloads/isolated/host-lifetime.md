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

For pinned executables, a closing bookend distinguishes a capture reference
failure (`executable-recheck-reference`) from a different device/inode
(`executable-recheck-inode`), changed size or mtime on the same inode
(`executable-recheck-size-or-mtime`), and ctime-only change
(`executable-recheck-ctime`). The labels retain no values and do not identify
the process, prove an exec or exit, or show that bytes were unchanged. Each
mismatch rejects the census. Only a catalog interval or an interval of the exact
native JSON API preparation command can establish an executable successor as
described below. During a process rename in a catalog or exact native JSON API
preparation census, a failed closing procfs stat is `executable-recheck-renamed`;
otherwise it retains the `executable-recheck` operation and the existing
process-read rules.

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
Read the command outcome, host sample counts and failed-census timings in the
Actions log. The first and last failures can also report an allowlisted process
or executable recheck operation; other operation names print as `unknown`.
The job does not upload files from the build or results directory.
An interrupted build is a failed diagnostic, not a zero-throughput app.
There are no timed requests, other contenders or official-round results.

The original `observerError` remains authoritative, and a nonzero diagnostic count
also blocks replay if that flag contradictorily says no error occurred.

Legacy terminal files without these diagnostics remain readable but cannot reveal
the cause of a swallowed exception. Successful samples describe only completed
observations, not the failed attempt. Do not infer a specific exit race, permission
failure, identity change or latency cause from a generic `host-observation-gap` alone.

If a Docker participant snapshot fails, a sealed terminal record also includes
`firstDockerGap`: the failed collector stage and an allowlisted error code, or
`unknown`. It is absent without a gap. Only the first failure is described,
including when a later sample is complete. The diagnostic keeps no error text,
daemon output, commands, environment or values read from procfs. The existing
sample still records the gap and notifies as before. A stage identifies a failed
check, not the cause of the underlying failure. A `kernel-census` failure in one
of the fixed census checks also names it (`operation`); an ancestor read or the
root-PID check can fail there without one. A failure after startup rechecks
records their `attempts`.

A container's first process can rename itself or exec its entrypoint just after
Docker reports it running (the Node image runs `docker-entrypoint.sh`, which execs
`node`, whose main thread then renames itself). The collector rechecks only that
churn: a changed process name between the opening and closing reads
(`process-name-close`), or a changed executable inode in the container's census
(`executable-recheck-inode`), on a container whose RFC 3339 Docker `StartedAt` is a real calendar time
at most one second old. It takes the whole capture again, checking before each
new attempt that 250 ms have not passed since the first began; the budget bounds
when an attempt may start, and one started inside it runs to its end. A capture admitted
after a recheck must have the same Docker start time, PID and kernel start time as
the failed one, checked before its executables are pinned; a mismatch is a gap at
`startup-recheck` and leaves no executable proof. Any other failure, an older,
unreadable or impossible start time, or churn still there when the budget leaves no
new attempt remains a gap and
notifies `onFault` as before. A changed name inside the census
(`process-name-recheck`) is not part of this recheck: the census retries it itself,
for every participant, within its own deadline. A sealed terminal record counts admitted rechecks in
`dockerStartupRechecks` (count and the first stage, code and attempts). The count
is of captures, including those in a sample the collector later rejects for another
reason, so it can exceed the retained Docker participant captures.

Separately, if the opening `/proc/PID/stat` read returns `ENOENT` after a
running inspect, an exact-ID re-observation can record the container as stopped.
It must show the same image, start and restart generation, PID zero and an
`exited` or `removing` state with a valid finish time in that capture. The
stopped row has no kernel evidence. Only an unchanged, coherent running response
allows one pause and one final exact-ID inspect. The pause targets 70 ms from
the start of capture; the final inspect must start before 75 ms on the monotonic
clock. Failed confirmation retains the original gap; later proc reads and
startup retries do not use this path.

The closing Docker inspect can itself prove the same stopped transition after
the kernel checks. The collector then discards the incomplete kernel census and
its new executable pins, recording only the stopped row. There is no additional
inspect. An absent participant, an unproved finish, or a changed generation is
still a gap.

Replay counts only verified kernel records as live coverage. An `exited` or
`removing` row must have a finish between the end of the last verified running
capture and the end of its own capture. Stopped rows for the same container
generation must agree on finish, exit code and OOM status, even if the terminal
receipt still showed it running. Stopped rows do not extend live coverage.
An exited terminal receipt must also have a valid finish no earlier than the
last verified running capture, even without a stopped row. Fullstack Browser
bounds it by its post-inspect timestamp (`window.endedAt`). Live Delivery records
its window end before the inspect, so that boundary does not constrain the
receipt's finish. Docker timestamps retain nanoseconds,
but comparisons to observation or receipt clocks truncate to milliseconds.
A finish in the last millisecond of a bound is admitted.

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

A child of a catalog command or the native JSON API preparation command can
replace its image via exec between the two executable reads. JSON API fixture
generation and timing still use their existing observer. A different device/inode
at the closing read alone is not enough to retry. The immediately preceding
admitted sample must bind the same PID,
start ticks and cgroup to the opening executable, or bind its parent as
described below. The pinned descriptor must still match every identity field.
Discard the entire failed attempt.
One fresh, complete census within the original deadline must pin and recheck
the exact closing identity (device, inode, size, mtime and ctime) for that same
process in the same cgroup. No further retry is allowed if this census fails.
PID and start-tick changes fail before the executable comparison. When only
the process name differs at that point, the collector must still check the
executable: a stable image permits the ordinary name retry, a different inode
requires the paired proof above, and an unreadable closing image blocks the run.
Both admitted images must still seal to their exact digests at finish.
For a child PID absent from the preceding sample, its opening and closing
process records must name the same parent. The preceding sample must contain
that parent in the same cgroup on the child's exact opening image. The fresh
census must find the same parent (PID, start ticks, cgroup and image) and the
same child on the expected new image, still naming that parent at both reads.
This uses the parent's already-admitted descriptor and digest; the failed
census adds no accounting or process records. Matching an unrelated process's
image is not sufficient.

Unseen old images, same-inode metadata changes and unproven successors remain
blocked. This is sampled image replacement, not a trace of exec syscalls or
an explanation of the original r21 interruption.

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

Catalog commands and the native JSON API preparation command use the same pinned
executable descriptors as browser commands.
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
unfinished bytes. Additional queue limits are 8 MiB, 300 frames (30 seconds at
100 ms) and 4,096 initial records. The writer may append up to 16 already-queued
sample-only frames together, up to 256 KiB in a batch, without waiting to fill it.
Each in-flight frame keeps its queue credits until the append settles. Overflow
fails rather than waiting on the sampler, dropping a member or growing an
unbounded queue. Storage uses at most two evidence FDs: the sample file and one
record or directory. Queue payload and V8 heap limits are not claims about total
process memory.

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

Storage errors and the 30-second startup, append and drain deadlines are sticky.
A timeout cannot cancel an uninterruptible filesystem operation. Its FIFO retains
ownership until the operation returns and cleanup is attempted; partial files and
an unproven scope remain retained, with no terminal seal or cleanup claim. Neither
an empty cgroup nor an eventual successful fsync clears a prior storage failure.
`halted` events retain `hostStorageFailure` for known FIFO faults, including
during startup: the first writer operation, its allowlisted code (or
`unknown`), and, only for a quota refusal, the first exceeded limit
(`total-bytes`, `queued-bytes`, `queued-frames` or `queued-records`).
A timed-out wait identifies the active writer stage if one is known. Record,
directory and final sample closes are distinct from sync. Startup retains the
writer's first fault even if cleanup later fails. When the supervisor reports
its setup deadline as the first interruption of a pending writer, the halt can
name the stage without waiting for I/O. When attachment is still draining, the
campaign journals the supervisor outcome without finishing the disposed observer.
An earlier leader exit or ordinary cancellation is not a writer deadline.
These labels do not contain exception text, paths or process details. A frame
limit reports a full queue, not why the writer fell behind. No terminal seal
is published on this path.

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
blocked even with an empty terminal. Closing-bookend controls distinguish the
changed identity fields after a process-read retry. They verify rollback,
unchanged proof for later accepted samples, and that neither a later sample
nor terminal emptiness clears the fault.

Pending-capture controls use real owned file descriptors with synthetic
membership and Docker reads. They check descriptor bounds, earlier accepted
inputs, final hash membership, enclosing-bookend and sample-write failures. Linux
uses the actual inherited-descriptor digest helper; Windows emulates only that
subprocess. These controls do not establish actual Docker/native qualification.

The delegated Linux tests use real child PIDs and cgroups. Fault-injection cases exercise
both a real shell exec at the catalog closing read and a chmod of the same
running inode, without substituting procfs stat results. The former requires
both image digests in replay; the latter must not seal the mutated descriptor.
Other cases exercise
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
