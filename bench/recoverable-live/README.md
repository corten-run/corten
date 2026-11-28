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

Explicit-profile captures in `evidence/native-feed-corten/` and
`evidence/native-feed-aspnet/` each retain all six native fault scenarios and historical
1/2/4-browser measurements. Their v1 measurement records lack the newly required
source-instance/interval, host HTTP and independent reader receipts and no longer
qualify measured native costs. Fresh v3 recovery measurements are required. They
remain partial rounds, never full-group readiness.
`evidence/native-recovery-timing-limit/` preserves the earlier failed Corten
round without rewriting its identity or relaxing the 10-second gates.
These saved captures stay where they are, listed in `scripts/bench-size.allow`. A new round's
captures go to `results/<round>/` here, whose gzip files Git ignores (its `coverage.json` and
`plan.json` stay visible): commit its summary and provenance, recording where a maintainer
published the captures, so they can be fetched, and their SHA-256
([Benchmark results](../../CONTRIBUTING.md#benchmark-results)).

Explicit `--measure` revalidates all six successful saved native recovery journeys before
measuring that app's actual 1/2/4-browser fan-out, visible frame latency and kernel CPU/memory.
Measurements reference their native qualification artifacts; failed or absent ports are not
timed. Default selection/profile behavior is unchanged. Historical v1 captures keep their
original inventory and are not retroactively upgraded when new ports are registered.
Verification reads retained failure/incomplete artifacts even if the current native
profile is unavailable; coverage flags cannot hide or skip their raw files.

To check Laravel's 2- and 4-client cells without reserving an official host, use a disposable
local Linux setup with Docker and the pinned Playwright Chromium. Use a fresh round name:

```sh
node bench/recoverable-live/run.mjs laravel-fanout-local --apps laravel --profile native-feed --measure --build
node bench/live/verify.mjs bench/recoverable-live/results/laravel-fanout-local
```

This runs all six Laravel correctness journeys before the unchanged 1/2/4-client sweep.
Require both `laravel-fanout-2.json.gz` and `laravel-fanout-4.json.gz` to be measured and
verified, not failure artifacts. On a publisher-lag refusal, read the optional
[`publisherLag` diagnostic](../live/README.md#bounded-fan-out) from that cell. A Laravel-only
round is partial; neither a pass nor a failure establishes what limited r108.
