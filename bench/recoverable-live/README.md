# Recoverable live application

```sh
node bench/recoverable-live/run.mjs <round> [--apps aspnet] [--build]
node bench/live/verify.mjs bench/recoverable-live/results/<round>
```

The actual native runner, shared driver, evidence schemas, bounds and limits are documented in
[live parity](../live/README.md#native-parity-runners). This entry exports `async run(args)`
with the same explicit-round arguments and returns false for incomplete group coverage.

The registry selects Corten, Phoenix, Rails, Laravel, ASP.NET Core, Leptos and Topcoat. Only the
ASP.NET native application port is currently implemented for this selection. All other ports
remain explicit missing rows, never qualifying via a shared oracle or another app's transport.
Every implemented app must pass normal, disconnect, missed-updates, expired-cursor, gap and
slow-reader browser journeys. The saved `evidence/native-recovery/` captures preserve the
actual bounded ASP.NET journeys, not group completion or load readiness.
