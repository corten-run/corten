# Bounded repair receipts

Baseline source: `1355108eaa0e3a601fd123cd38e2138b4d7c385f`.
Upstream fetched successfully; the task branch was not merged or rewritten.
Before images were freshly built from that source. After images include the
adjacent snapshot-reconciliation repair and automatic reconnect repair.

Commands, run from the repository root against fresh native containers:

```sh
node bench/live/apps/rails/test/recovery.mjs <base>
node bench/live/apps/rails/test/browser.mjs <base>
node bench/live/apps/rails/test/adversarial.mjs <base>
node --test bench/live/apps/rails/test/wire.test.mjs
```

Native store command inside the app's production image: `bundle exec ruby test/store_test.rb`.
The store receipt is from the final source, including forged-counter and
unobserved-delivery rejection checks. Phoenix compilation used
`mix compile --warnings-as-errors`; changed Elixir files were formatted.

`before.txt` is an expected failing run of the new fault regression.
`after.txt` is its passing counterpart, including native messages and actual DOM
rows/cursor/counter/effects. `recoveryMs` measures one browser publication-to-
snapshot observation, not service throughput. These single local samples are
not a statistical speed comparison. The recovery deadline is 2,000 ms.
`browser.txt`, `adversarial.txt`, `store.txt` and `wire.txt` retain passing output.

Scope is the bounded profile only. No native-feed load qualification, cloud run,
nightly run, publication, merge or full repository CONTRIBUTING matrix was run.
Independent review remains required; no reviewer was spawned for this task.
The original `after.txt` predates the routed detach repair described below; its
automatic-reconnect result checked replay but skipped explicit detach.

## Routed detach repair

Repair baseline: `268607edf2e500bca381dd9adc5f58e38b26fe42`. The application runtime
is unchanged. `recovery.mjs` now requires explicit detach through the existing
5,000 ms cleanup gate, aggregate zero connections/subscriptions/tasks/queues,
empty consumer inventory and zero retained/staged/replay/in-flight application
state before context teardown. It also requires a native upstream close callback.

`routed-detach-before.txt` runs the baseline route with those detach diagnostics:
replay succeeds, but detach times out with one connection, subscription and pending
task. Only page-side close callbacks arrive for the interrupted connection.
`routed-close-api.txt` is a direct, unrouted Chromium WebSocket probe: close code
1001 throws `InvalidAccessError` and leaves the socket open; code 3001 completes
the native close and the application releases its connection. Reproduce it with
`node bench/live/apps/rails/test/routed-close-api.mjs <base>` against an isolated
native application with no active readers.

Playwright 1.64.1's installed implementation explains the apparatus failure:
`WebSocketRoute` forwards server-side close to `WebSocketMock._apiCloseServer`,
which invokes its actual browser `WebSocket.close(code, reason)`. The dispatcher's
`_evaluateAPIRequest` catches the resulting exception. The route's existing
page/server close callbacks therefore could not make the invalid code work.
The injected interruption now uses browser-permitted application code 3001 on
both sides and awaits the requests. No application cleanup or timeout was changed.

`routed-detach-after.txt` retains the identical recovery command after the repair,
including actual close callbacks and native inventory before context teardown.
`routed-detach-repeat.txt` retains two further full recovery runs.
`routed-detach-browser.txt`, `routed-detach-adversarial.txt`,
`routed-detach-store.txt` and `routed-detach-wire.txt` retain the other Rails checks
listed above. `routed-detach-source.txt` binds the unchanged runtime, templates,
dependencies and served bridge to the existing local proof image by SHA-256.
The current store test was mounted read-only because that image's test copy is
older. No application rebuild or runtime source change was needed.
The final test source passed three full recovery runs: each kept the two existing
overflow-loss cases and required automatic-reconnect detach. The new direct API
probe, six bounded browser scenarios, six adversarial cases, 12 store tests
(76 assertions), two wire tests, both changed scripts' `node --check`, and
`git diff --check` passed. Independent review and the full repository CONTRIBUTING
matrix remain outside this bounded task.
These are bounded correctness checks, not load or abrupt-network-loss qualification.
