# Native client-heavy journey

This is a new functional workload, not a continuation of the historical browser
benchmark. All six selected frameworks stay in the result, including failures.
`../workloads/client.mjs` is an offline oracle only. No application imports it.
Each application owns its mutations and renders through its native framework.

Implementation checks:
1. Build the six native apps against the same explicit fixture; retain build failures.
2. Capture actual loaded data, every operation's DOM and node identities, network,
   errors and owned resources. Validate with the offline oracle before timing.
3. Run a separate measured journey only after qualification, validate it again,
   and save raw captures, action timings and source/build provenance.

From the repository root, with its Playwright installed and `npm ci` in
`bench/browser`:

```sh
node --test bench/client-heavy/*.test.mjs
node bench/client-heavy/run.mjs local --out bench/client-heavy/work/local
```

The defaults are bounded verification sizes (14 rows, 110 large rows, append 7,
24 cards), not performance ranking sizes. Explicit options `--rows 1000 --large
10000 --append 1000 --cards 200` exercise the historical sizes under this new
contract. `--seed`, `--cleanup-ms`, `--observation-ms`, and `--timeout-ms` are
recorded with the effective workload. There is deliberately no contender filter.
Build output is isolated under the output directory. Use `--cargo <executable>`
to choose a Cargo-compatible launcher; the default is `cargo`.
Every invocation builds the current native sources and compiles/runs the Corten Rust
generator through that launcher. External build receipts and precompiled generator
executables are not accepted: self-consistent hashes cannot establish that artifacts
were produced by the claimed framework. The output directory must be new.

The dashboard source is an EventTarget delivering tick *inputs*, not rendered
rows, a reducer, expected snapshots or DOM. Native effects subscribe and native
unmount/disposal releases them. The observer retains the actual screen element
before unmount, then reads that detached DOM after an independently dispatched
tick. It does not clone the screen or reconstruct it from the oracle.

Resources are observed by wrapping the browser's actual EventTarget, timer,
animation/idle/microtask/MessageChannel/scheduler, fetch/XHR/beacon and socket APIs
before scripts load. The source's real listener set supplies subscription counts.
Workers are refused, service workers blocked, rather than left unobserved.
Element-bound input handlers on detached elements cannot receive browser input;
they are not active owned listeners. Global app listeners *are* counted, including
event-handler properties on the window, document, document element and body; replacing
a bootstrap handler is counted too. The one
explicit infrastructure classification is Corten's pair of document delegates for
`click` and `input`: these are page-lifetime listeners installed lazily by the
runtime's `listen`, not component subscriptions. Only each first capture/bubble
registration whose immediate caller is the hashed `/corten/runtime.js` qualifies;
the retained `resourceDetails` names them. An app's global input listener still
fails the hostile test. No subscription, connection, timer or queued task is
exempted. Promise chains without a scheduled browser task are not globally
enumerable; the native apps own no such asynchronous work.

The runner records operation dispatch-to-two-animation-frames elapsed time,
including scheduling and rendering, not pure handler CPU. Observer overhead is
present in both journeys. Qualification has `actions: null`; action timings are
collected only in the separate measurement pass after qualification. `readyMs`
is mount-to-visible-screen-and-subscription readiness, not document load time.
These local bounded numbers are diagnostics, not a
ranking or cloud/load readiness. Offline `readyForLoad` remains false.

Integration left to the parent: add `node --test bench/client-heavy/*.test.mjs`
to the check command and route the client-heavy group's native execution to
`node bench/client-heavy/run.mjs <round> --out <artifact-directory>`; document the new
journey in the benchmark guide and changelog. No nightly configuration is changed.

The entry exports `async run(args)` where `args` is the CLI argument array, beginning
with the required round. The returned/saved `result.json` uses
`client-heavy-native/v1`: `group`, `round`, `effectiveWorkload`, `settings`,
`timeoutMs`, `provenance`, `selectedApps`, `builds`, `cells`, `passed`, and
`readyForLoad: false`. Each cell has `outcome`, `qualification`, `measurement`
and `readyForMeasurement`. Failed builds/runs retain reasons, never timing zeros.
Captures inside each pass retain `client-capture/v1` unchanged. A failed journey
has `records: null` in that capture and its partial observations under `failure`.
No measured action timings are released for a failing measured journey.

Set `CLIENT_NATIVE_DIR` to the run's `native` directory before running
`native.test.mjs` to exercise deliberate faults in the actual React app
and Corten-specific subscription/global-listener cleanup faults.
Without it only that integration test is explicitly skipped; the observer and
dispatch-gate tests need no build. The hostile cases are not framework evidence.
