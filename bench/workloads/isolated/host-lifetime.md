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

The existing three-attempt snapshot budget also covers a process-name-only bookend
change when PID and kernel start ticks are unchanged. The full identity assertion
still rejects that attempt. The collector discards every group and process from it,
rereads the entire recursive scope, and saves only a fresh, fully coherent snapshot.
It never accepts mixed names or skips a member. This repairs the demonstrated local
native churn name race; it does not establish the cause of the historical r21 error.

PID or start-tick changes fail immediately, including changes accompanied by a new
name. ENOENT/ESRCH and name races share one three-attempt budget; other read errors
still fail immediately. Three racing attempts remain an observer gap. Retries do
not reset timestamps, extend the one-second continuity gate, clear a prior observer
failure or replace positive empty-scope proof.

## Checks

Run portable replay tests with:

```sh
node --test bench/workloads/isolated/host-lifetime.test.mjs
```

Inside a fresh, explicitly owned delegated test unit with the layout described in
[the campaign contract](CAMPAIGN.md), run:

```sh
node --test --test-concurrency=1 bench/workloads/isolated/host-lifetime-linux.test.mjs
```

The Linux tests use real child PIDs and cgroups. Fault-injection cases exercise
repeated interval errors, shared retry exhaustion, strict process-name bookends,
unknown-code sanitization, recovery that remains blocked, and a final sample failure
that cannot claim an empty scope. Native descendant churn must retain all eight observed children and
positive empty cleanup. An actual 1,250 ms sampler stall must fail the unchanged
one-second continuity gate despite a clean native exit. These are collector tests,
not benchmark qualification or proof of a historical failure's cause. The two-member
bookend fixture proves that one or two name races discard earlier member records,
metadata and accounting reads, and that the accepted retry has complete fresh
bookends. PID/start changes, three name races, mixed retry exhaustion and read-error
controls remain blocked.
