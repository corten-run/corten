# Recoverable live application

```sh
node bench/recoverable-live/run.mjs <round> [--apps aspnet] [--build]
node bench/recoverable-live/run.mjs <round> --apps corten,aspnet --profile native-feed --measure
node bench/live/verify.mjs bench/recoverable-live/results/<round>
```

The actual native runner, shared driver, evidence schemas, bounds and limits are documented in
[live parity](../live/README.md#native-parity-runners). This entry exports `async run(args)`
with the same explicit-round arguments and returns false for incomplete group coverage.

The registry selects Corten, Phoenix, Rails, Laravel, ASP.NET Core, Leptos and Topcoat. Only the
ASP.NET port supports the default bounded profile; Corten's actual Feed/subscribe/keyed-view
port requires the explicit native-feed profile (1,044 events, queue 1,024/history 1,025, equal
across that round). Missing or stale native images build automatically. Other independent ports
remain explicit missing rows, never qualifying via a shared oracle or another app's transport.
Every implemented app must pass normal, disconnect, missed-updates, expired-cursor, gap and
slow-reader browser journeys. The saved `evidence/native-recovery/` captures preserve the
actual bounded ASP.NET journeys, not group completion or load readiness.

Current explicit-profile captures in `evidence/native-feed-corten/` and
`evidence/native-feed-aspnet/` each pass all six native fault scenarios and the independently
admitted 1/2/4-browser measurement levels. They remain partial rounds, never full-group
readiness. `evidence/native-recovery-timing-limit/` preserves the earlier failed Corten
round without rewriting its identity or relaxing the 10-second gates.

Explicit `--measure` revalidates all six successful saved native recovery journeys before
measuring that app's actual 1/2/4-browser fan-out, visible frame latency and kernel CPU/memory.
Measurements reference their native qualification artifacts; failed or absent ports are not
timed. Default selection/profile behavior is unchanged. Historical v1 captures keep their
original inventory and are not retroactively upgraded when new ports are registered.
