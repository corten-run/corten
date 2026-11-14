# Bounded repair receipts

Baseline source: `1355108eaa0e3a601fd123cd38e2138b4d7c385f`.
Upstream fetched successfully; the task branch was not merged or rewritten.
Before images were freshly built from that source. After images include the
adjacent snapshot-reconciliation repair.

Commands, run from the repository root against fresh native containers:

```sh
node bench/live/apps/phoenix/test/recovery.mjs <base>
node bench/live/apps/phoenix/test/browser.mjs <base>
node bench/live/apps/phoenix/test/adversarial.mjs <base>
node --test bench/live/apps/phoenix/test/wire.test.mjs
```

Native store command inside the app's build stage: `PHX_SERVER=false mix run test/store_test.exs`.
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
The routed Rails automatic-reconnect regression closes its context after checking
native replay; it does not claim to fix the separately observed routed-socket
detach timeout. Existing explicit lifecycle suites passed independently.
