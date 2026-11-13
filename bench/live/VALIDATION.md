# Native live validation record

## Scope and entry points

This lane extends the previously delivered `13e9ce3a11d61e238cca936e43bf8ea17bb77378`
runners. The requested base was `921cd8422d4293863981546ced30da5c2e256cf6`;
upstream was fetched and read without moving this feature branch.
Only live/recoverable-live files were changed. Reserved native app sources were not edited.

```sh
node bench/live/run.mjs ROUND --group live-delivery [--apps comma,list] [--build] [--profile native-feed] [--measure]
node bench/recoverable-live/run.mjs ROUND [--apps comma,list] [--build] [--profile native-feed] [--measure]
node bench/live/verify.mjs ARTIFACT_DIRECTORY
```

Both entries export `async run(args)`: argv without `--group`, or
`{round,apps?,build?,out?,profile?,measure?}`. Apps is a comma-separated string.
The mandatory round is a safe single path segment. Existing destinations are refused.
The result is false and CLI exit is 1 for any incomplete full registry, even when
the explicitly requested subset passed. Historical live mode without `--group` is unchanged.

Default qualification remains 24 events, queue 2/history 4. Explicit native-feed
qualification uses 1,044 events, queue 1,024/history 1,025 for every app in that
profile. Large fault setup batches actual native writes and individual resource
acknowledgements, not effects or measurements. Recovery/slow bounds remain 10 seconds.
Every measured level uses 60 individual native publications at 20/s, at 1/2/4 browsers.

## Observed results

Corten uses the existing Feed, subscribe(), generated keyed views and native
EventSource recovery, not a replacement runtime. Actual source-bound Corten and
ASP.NET recovery rounds each passed six faults and all three measured levels.
Corten, Express, ASP.NET and Gin delivery rounds each passed both faults and all
three measured levels in the explicit native-feed profile. Final DOM, ordered
effects, duplicate suppression, raw native wire/HTTP work, saturation peaks and
post-detach zero resources were independently verified.

Successful native-feed evidence is in:
- `bench/live/evidence/native-feed-corten/`
- `bench/live/evidence/native-feed-peers/` (Express and ASP.NET)
- `bench/live/evidence/native-feed-gin/`
- `bench/recoverable-live/evidence/native-feed-corten/`
- `bench/recoverable-live/evidence/native-feed-aspnet/`

Each remains its original PARTIAL round. They are not combined into an invented
passing group ledger. Every selected candidate remains visible; readiness is false.
Plans are native-live-plan/v2, correctness is native-live-evidence/v1,
measurement is native-live-fanout/v1, with hashed gzip manifests and source diffs.
Old v1 captures retain their original three-port inventory; adding a registration
does not upgrade missing historic rows. Existing v2 missing rows also remain missing.

Measured Corten delivery at `ab03033821ca8e96865fdf59de375190cc5cfb2b`, source bound
by its retained plan/diff and image identity:

| Browsers | Effects | Visible-frame p95 ms | Server CPU microseconds | Current memory bytes | Peak since container start bytes |
|---|---|---|---|---|---|
| 1 | 60 | 55.2 | 146406 | 11046912 | 15953920 |
| 2 | 120 | 55.5 | 182068 | 11665408 | 15953920 |
| 4 | 240 | 54.3 | 169937 | 10809344 | 15953920 |

These numbers are measured, rounded only for display. All raw browser frame/time
origins, schedules, kernel CPU/memory counters and aggregates are retained.
There are no Corten wins or comparative throughput claims from this concurrently
loaded workstation. One repeat at three small levels does not establish saturation
or scalability limits. Frames are paint opportunities, not pixel photometry.
The browser is outside the server's 1 CPU / 1 GiB budget. Memory peak includes
setup/qualification, not an isolated level peak. Server costs include instrumentation.
Corten's initial native screen also server-renders rows; snapshot work counts its
native HTTP snapshot, not all page-render work. No equal total SSR/read-cost claim is made.

Native Feed queue occupancy is source-policy accounting of accepted writes minus
body-emitted patches, not private allocator introspection. Replay transient entry,
coalesced frames, fault slots and the 1,044-entry maximum batch are bounded explicitly.
This is a held native consumer probe, not TCP/kernel socket-memory boundedness.
No authentication, multi-node or process-restart durability is qualified.

Earlier failures are retained unchanged: native-fanout contains ASP.NET offered-rate
failures and a Gin build timeout; native-feed-peers retains another Gin build timeout;
native-recovery-timing-limit retains the earlier Corten 10-second timing failures.
Later fresh rounds do not rewrite those identities. A timed-out Docker build CLI
may finish in the backend later; fresh qualification only used its source-bound
finished image, never a fallback image.

## Checks

Observed this session:
- `node --test bench/live/parity.test.mjs bench/workloads/live.test.mjs`: 111 passed.
- `npm run check:workloads`: 241 passed.
- `npm run check`: 203 passed, one Windows platform skip.
- Native Corten Rust unit tests: four passed; all-target clippy with warnings denied
  and formatting check passed for `bench/live/apps/corten/Cargo.toml`.
- Actual native browser journeys and measured rounds above, saved-byte reopening,
  plus a real legacy Corten HTTP snapshot/write/SSE smoke with LIVE_PARITY absent.
  Legacy root remained "live", write returned 204, snapshot/SSE carried the price,
  and the parity route returned 404.
- Native images were built through each app's source-image Dockerfile. Corten's
  specialized immutable image build includes real framework sources; ordinary Rust
  validation remained separate. Runtime provenance records image/source identity,
  process topology and actual resource budgets.

No complete framework workspace Rust matrix or example-browser matrix was rerun.
No independent agent review was started because the user prohibited new agents.
Parent review remains required. No crates, fullstack app sources, cloud jobs,
automation, pushes, pull requests or merges were changed.

## Remaining ports

Phoenix, Laravel, Drogon, Leptos and Topcoat native ports are not delivered in this
lane. Rails has a separate owner-delivered native application, but parent import,
native registration and shared-runner qualification are still required. These are
pending work, not unsupported frameworks or qualifying transport promises.
The port contract and app-local raw-wire binding interface are in `PORTS.md`.
No other group registry membership or default was changed.

## Changed files

Every path changed after the previously delivered live runner commit, including
this record (129 files), relative to the repository root:

- `bench/live/PORTS.md`
- `bench/live/README.md`
- `bench/live/VALIDATION.md`
- `bench/live/apps/aspnet/Program.cs`
- `bench/live/apps/aspnet/wwwroot/client.js`
- `bench/live/apps/corten/Cargo.lock`
- `bench/live/apps/corten/Cargo.toml`
- `bench/live/apps/corten/Dockerfile.parity`
- `bench/live/apps/corten/Dockerfile.parity.dockerignore`
- `bench/live/apps/corten/src/main.rs`
- `bench/live/apps/corten/src/parity.rs`
- `bench/live/apps/corten/src/parity_row.rs`
- `bench/live/apps/corten/src/parity_screen.js`
- `bench/live/apps/corten/src/parity_screen.rs`
- `bench/live/apps/express/client.js`
- `bench/live/apps/express/server.mjs`
- `bench/live/apps/gin/client.js`
- `bench/live/apps/gin/main.go`
- `bench/live/evidence/native-fanout-gin/coverage.json`
- `bench/live/evidence/native-fanout-gin/gin-artifacts.json`
- `bench/live/evidence/native-fanout-gin/gin-fanout-1.json.gz`
- `bench/live/evidence/native-fanout-gin/gin-fanout-2.json.gz`
- `bench/live/evidence/native-fanout-gin/gin-fanout-4.json.gz`
- `bench/live/evidence/native-fanout-gin/gin-measurements.json`
- `bench/live/evidence/native-fanout-gin/gin-normal.json.gz`
- `bench/live/evidence/native-fanout-gin/gin-slow-reader.json.gz`
- `bench/live/evidence/native-fanout-gin/plan.json`
- `bench/live/evidence/native-fanout-gin/source.diff.gz`
- `bench/live/evidence/native-fanout/aspnet-artifacts.json`
- `bench/live/evidence/native-fanout/aspnet-fanout-1.json.gz`
- `bench/live/evidence/native-fanout/aspnet-fanout-2.json.gz`
- `bench/live/evidence/native-fanout/aspnet-fanout-4.json.gz`
- `bench/live/evidence/native-fanout/aspnet-measurements.json`
- `bench/live/evidence/native-fanout/aspnet-normal.json.gz`
- `bench/live/evidence/native-fanout/aspnet-slow-reader.json.gz`
- `bench/live/evidence/native-fanout/coverage.json`
- `bench/live/evidence/native-fanout/express-artifacts.json`
- `bench/live/evidence/native-fanout/express-fanout-1.json.gz`
- `bench/live/evidence/native-fanout/express-fanout-2.json.gz`
- `bench/live/evidence/native-fanout/express-fanout-4.json.gz`
- `bench/live/evidence/native-fanout/express-measurements.json`
- `bench/live/evidence/native-fanout/express-normal.json.gz`
- `bench/live/evidence/native-fanout/express-slow-reader.json.gz`
- `bench/live/evidence/native-fanout/gin-failure.json`
- `bench/live/evidence/native-fanout/plan.json`
- `bench/live/evidence/native-fanout/source.diff.gz`
- `bench/live/evidence/native-feed-corten/corten-artifacts.json`
- `bench/live/evidence/native-feed-corten/corten-fanout-1.json.gz`
- `bench/live/evidence/native-feed-corten/corten-fanout-2.json.gz`
- `bench/live/evidence/native-feed-corten/corten-fanout-4.json.gz`
- `bench/live/evidence/native-feed-corten/corten-measurements.json`
- `bench/live/evidence/native-feed-corten/corten-normal.json.gz`
- `bench/live/evidence/native-feed-corten/corten-slow-reader.json.gz`
- `bench/live/evidence/native-feed-corten/coverage.json`
- `bench/live/evidence/native-feed-corten/plan.json`
- `bench/live/evidence/native-feed-corten/source.diff.gz`
- `bench/live/evidence/native-feed-gin/coverage.json`
- `bench/live/evidence/native-feed-gin/gin-artifacts.json`
- `bench/live/evidence/native-feed-gin/gin-fanout-1.json.gz`
- `bench/live/evidence/native-feed-gin/gin-fanout-2.json.gz`
- `bench/live/evidence/native-feed-gin/gin-fanout-4.json.gz`
- `bench/live/evidence/native-feed-gin/gin-measurements.json`
- `bench/live/evidence/native-feed-gin/gin-normal.json.gz`
- `bench/live/evidence/native-feed-gin/gin-slow-reader.json.gz`
- `bench/live/evidence/native-feed-gin/plan.json`
- `bench/live/evidence/native-feed-gin/source.diff.gz`
- `bench/live/evidence/native-feed-peers/aspnet-artifacts.json`
- `bench/live/evidence/native-feed-peers/aspnet-fanout-1.json.gz`
- `bench/live/evidence/native-feed-peers/aspnet-fanout-2.json.gz`
- `bench/live/evidence/native-feed-peers/aspnet-fanout-4.json.gz`
- `bench/live/evidence/native-feed-peers/aspnet-measurements.json`
- `bench/live/evidence/native-feed-peers/aspnet-normal.json.gz`
- `bench/live/evidence/native-feed-peers/aspnet-slow-reader.json.gz`
- `bench/live/evidence/native-feed-peers/coverage.json`
- `bench/live/evidence/native-feed-peers/express-artifacts.json`
- `bench/live/evidence/native-feed-peers/express-fanout-1.json.gz`
- `bench/live/evidence/native-feed-peers/express-fanout-2.json.gz`
- `bench/live/evidence/native-feed-peers/express-fanout-4.json.gz`
- `bench/live/evidence/native-feed-peers/express-measurements.json`
- `bench/live/evidence/native-feed-peers/express-normal.json.gz`
- `bench/live/evidence/native-feed-peers/express-slow-reader.json.gz`
- `bench/live/evidence/native-feed-peers/gin-failure.json`
- `bench/live/evidence/native-feed-peers/plan.json`
- `bench/live/evidence/native-feed-peers/source.diff.gz`
- `bench/live/fanout.mjs`
- `bench/live/native.mjs`
- `bench/live/parity.mjs`
- `bench/live/parity.test.mjs`
- `bench/live/verify.mjs`
- `bench/live/wire.mjs`
- `bench/recoverable-live/README.md`
- `bench/recoverable-live/evidence/native-feed-aspnet/aspnet-artifacts.json`
- `bench/recoverable-live/evidence/native-feed-aspnet/aspnet-disconnect.json.gz`
- `bench/recoverable-live/evidence/native-feed-aspnet/aspnet-expired-cursor.json.gz`
- `bench/recoverable-live/evidence/native-feed-aspnet/aspnet-fanout-1.json.gz`
- `bench/recoverable-live/evidence/native-feed-aspnet/aspnet-fanout-2.json.gz`
- `bench/recoverable-live/evidence/native-feed-aspnet/aspnet-fanout-4.json.gz`
- `bench/recoverable-live/evidence/native-feed-aspnet/aspnet-gap.json.gz`
- `bench/recoverable-live/evidence/native-feed-aspnet/aspnet-measurements.json`
- `bench/recoverable-live/evidence/native-feed-aspnet/aspnet-missed-updates.json.gz`
- `bench/recoverable-live/evidence/native-feed-aspnet/aspnet-normal.json.gz`
- `bench/recoverable-live/evidence/native-feed-aspnet/aspnet-slow-reader.json.gz`
- `bench/recoverable-live/evidence/native-feed-aspnet/coverage.json`
- `bench/recoverable-live/evidence/native-feed-aspnet/plan.json`
- `bench/recoverable-live/evidence/native-feed-aspnet/source.diff.gz`
- `bench/recoverable-live/evidence/native-feed-corten/corten-artifacts.json`
- `bench/recoverable-live/evidence/native-feed-corten/corten-disconnect.json.gz`
- `bench/recoverable-live/evidence/native-feed-corten/corten-expired-cursor.json.gz`
- `bench/recoverable-live/evidence/native-feed-corten/corten-fanout-1.json.gz`
- `bench/recoverable-live/evidence/native-feed-corten/corten-fanout-2.json.gz`
- `bench/recoverable-live/evidence/native-feed-corten/corten-fanout-4.json.gz`
- `bench/recoverable-live/evidence/native-feed-corten/corten-gap.json.gz`
- `bench/recoverable-live/evidence/native-feed-corten/corten-measurements.json`
- `bench/recoverable-live/evidence/native-feed-corten/corten-missed-updates.json.gz`
- `bench/recoverable-live/evidence/native-feed-corten/corten-normal.json.gz`
- `bench/recoverable-live/evidence/native-feed-corten/corten-slow-reader.json.gz`
- `bench/recoverable-live/evidence/native-feed-corten/coverage.json`
- `bench/recoverable-live/evidence/native-feed-corten/plan.json`
- `bench/recoverable-live/evidence/native-feed-corten/source.diff.gz`
- `bench/recoverable-live/evidence/native-recovery-timing-limit/corten-artifacts.json`
- `bench/recoverable-live/evidence/native-recovery-timing-limit/corten-disconnect.json.gz`
- `bench/recoverable-live/evidence/native-recovery-timing-limit/corten-expired-cursor.json.gz`
- `bench/recoverable-live/evidence/native-recovery-timing-limit/corten-gap.json.gz`
- `bench/recoverable-live/evidence/native-recovery-timing-limit/corten-missed-updates.json.gz`
- `bench/recoverable-live/evidence/native-recovery-timing-limit/corten-normal.json.gz`
- `bench/recoverable-live/evidence/native-recovery-timing-limit/corten-slow-reader.json.gz`
- `bench/recoverable-live/evidence/native-recovery-timing-limit/coverage.json`
- `bench/recoverable-live/evidence/native-recovery-timing-limit/plan.json`
- `bench/recoverable-live/evidence/native-recovery-timing-limit/source.diff.gz`
