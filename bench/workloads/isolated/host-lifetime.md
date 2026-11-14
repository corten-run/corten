# Host lifetime failure diagnostics

`host-lifetime.mjs` samples actual delegated command scopes. A caught sampling failure
sets the sticky `host-observation-gap` terminal error even when the next sample recovers
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
The existing three-attempt ENOENT/ESRCH policy, identity checks, one-second continuity
bound and positive empty-scope requirement are unchanged.

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
repeated interval errors, existing retry exhaustion, strict process-name bookends,
unknown-code sanitization, recovery that remains blocked, and a final sample failure
that cannot claim an empty scope. Native descendant churn must retain all eight observed children and
positive empty cleanup. An actual 1,250 ms sampler stall must fail the unchanged
one-second continuity gate despite a clean native exit. These are collector tests,
not benchmark qualification or proof of a historical failure's cause. Churn that
triggers an identity or read race still fails closed; diagnostics do not repair it.
