# Lean catalog page: r24 (native run c24)

All seven contenders completed the official attempt. Five passed every timed phase; Express and FastAPI had request timeouts at 256 users. Their observations are included, but neither is eligible for a group performance comparison. This is a verified group result, not an all-contender pass.

Measured commit: `30b39d455ad4c9840e1a4206cbd716f519448f1a`.

Per phase: duration 60 s; warmup 30 s; fixed rate 150 req/s; encoding identity.
Started: 2026-11-21T12:29:09.247Z; finished: 2026-11-21T15:14:40.533Z.
Fixture SHA-256: `f76eecaecb5af637b524d8f518e0341bde9bcbafd81e2ff14001972966fad8c5`.

| CPU role | Quota, cores | Logical CPU pinning |
|---|---:|---|
| app | 1.0 | 1 |
| load | 12.0 | 4-15 |
| api | 2.0 | 2-3 |

Speed configuration: `catalog-lean`; configured contenders: `corten`, `aspnet`, `express`, `fastapi`, `axum-maud`, `drogon`, `gin`.

Upstream: `node-cluster-2/v1`, exactly two request workers plus coordinator; unchanged 2-CPU/512-MiB budget. Raw replay: verified; first-host admission: passed. Legacy evidence is not retroqualified.

Group: `catalog-page`; registry: `benchmark-groups/v1`; contract SHA-256: `67e0bffbf6bc138c570b7d3855b9dc440c2d11526a1321269f14433155dd98f0`.
Document header contract: `catalog-document-headers/v1`.
After-run commit: `30b39d455ad4c9840e1a4206cbd716f519448f1a`; tree dirty after run: false.
Exact apps: `corten`, `aspnet`, `express`, `fastapi`, `axum-maud`, `drogon`, `gin`.
Timing targets: page only, fixture and API sources. Native correctness gates remain page AND JSON; JSON is not timed. This is a group comparison, not the historical twenty-app catalog baseline.

At 64 users, Corten had the highest successful page throughput among eligible contenders with both data sources. Each cell is the median [minimum, maximum] of the three passes. The in-memory fixture and HTTP API supply the same page data. No change against a prior round is claimed.

| Framework | Memory page successful req/s | HTTP page successful req/s |
|---|---:|---:|
| corten | 29,160 [28,051, 29,803] (3/3) | 9,227 [9,037, 9,273] (3/3) |
| aspnet | 6,328 [6,317, 6,336] (3/3) | 3,296 [3,269, 3,323] (3/3) |
| express (ineligible) | 5,307 [5,210, 5,349] (3/3) | 1,729 [1,690, 1,735] (3/3) |
| fastapi (ineligible) | 2,161 [2,112, 2,333] (3/3) | 268 [262, 279] (3/3) |
| axum-maud | 25,709 [25,201, 25,920] (3/3) | 8,688 [8,665, 8,783] (3/3) |
| drogon | 19,195 [19,138, 19,222] (3/3) | 5,187 [5,073, 5,459] (3/3) |
| gin | 11,307 [11,119, 11,597] (3/3) | 4,167 [3,795, 4,246] (3/3) |

## Timed outcomes

At 256 users, Express recorded 1 timeout on API pass 2 and 5 on API pass 3. FastAPI recorded 50, 46, and 38 timeouts on fixture passes 1 through 3, and 2, 1, and 2 on API passes 1 through 3. These passes recorded no HTTP errors or dropped iterations. The timings establish what happened, not why.

Observed load/request outcomes, not root-cause diagnoses. Successful req/s excludes failed requests; attempted req/s includes them. Ranges retain every observed pass. Failed apps are not comparison-eligible, including when a different phase passed.

| App | Profile | Phase | Passed / failed / requested passes | Successful req/s median [min, max] | Attempted req/s median [min, max] | Failed requests median [min, max] | Drops median [min, max] |
|---|---|---|---|---|---|---|---|
| corten | fixture-page | fixed | 3 / 0 / 3 | 150.01 [150.00, 150.01] | 150.01 [150.00, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| corten | fixture-page | sat64 | 3 / 0 / 3 | 29,160.34 [28,050.75, 29,802.64] | 29,160.34 [28,050.75, 29,802.64] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| corten | fixture-page | sat256 | 3 / 0 / 3 | 25,524.91 [24,743.75, 26,931.52] | 25,524.91 [24,743.75, 26,931.52] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| corten | api-page | fixed | 3 / 0 / 3 | 150.01 [150.00, 150.01] | 150.01 [150.00, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| corten | api-page | sat64 | 3 / 0 / 3 | 9,226.92 [9,037.34, 9,272.92] | 9,226.92 [9,037.34, 9,272.92] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| corten | api-page | sat256 | 3 / 0 / 3 | 8,088.83 [7,961.26, 8,378.80] | 8,088.83 [7,961.26, 8,378.80] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| aspnet | fixture-page | fixed | 3 / 0 / 3 | 150.01 [150.01, 150.01] | 150.01 [150.01, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| aspnet | fixture-page | sat64 | 3 / 0 / 3 | 6,328.45 [6,316.72, 6,336.23] | 6,328.45 [6,316.72, 6,336.23] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| aspnet | fixture-page | sat256 | 3 / 0 / 3 | 5,589.82 [5,562.48, 5,633.46] | 5,589.82 [5,562.48, 5,633.46] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| aspnet | api-page | fixed | 3 / 0 / 3 | 150.01 [150.01, 150.01] | 150.01 [150.01, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| aspnet | api-page | sat64 | 3 / 0 / 3 | 3,296.13 [3,268.99, 3,323.11] | 3,296.13 [3,268.99, 3,323.11] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| aspnet | api-page | sat256 | 3 / 0 / 3 | 3,007.43 [2,975.83, 3,008.61] | 3,007.43 [2,975.83, 3,008.61] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| express | fixture-page | fixed | 3 / 0 / 3 | 150.00 [150.00, 150.01] | 150.00 [150.00, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| express | fixture-page | sat64 | 3 / 0 / 3 | 5,306.60 [5,209.71, 5,348.83] | 5,306.60 [5,209.71, 5,348.83] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| express | fixture-page | sat256 | 3 / 0 / 3 | 5,174.25 [5,037.75, 5,354.65] | 5,174.25 [5,037.75, 5,354.65] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| express | api-page | fixed | 3 / 0 / 3 | 150.01 [150.00, 150.01] | 150.01 [150.00, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| express | api-page | sat64 | 3 / 0 / 3 | 1,728.95 [1,689.63, 1,734.72] | 1,728.95 [1,689.63, 1,734.72] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| express | api-page | sat256 | 1 / 2 / 3 | 1,513.02 [1,477.71, 1,515.43] | 1,513.02 [1,477.72, 1,515.51] | 1.00 [0.00, 5.00] | 0.00 [0.00, 0.00] |
| fastapi | fixture-page | fixed | 3 / 0 / 3 | 150.01 [150.00, 150.01] | 150.01 [150.00, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| fastapi | fixture-page | sat64 | 3 / 0 / 3 | 2,160.53 [2,112.03, 2,333.18] | 2,160.53 [2,112.03, 2,333.18] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| fastapi | fixture-page | sat256 | 0 / 3 / 3 | 2,245.36 [2,180.58, 2,256.31] | 2,245.99 [2,181.34, 2,257.14] | 46.00 [38.00, 50.00] | 0.00 [0.00, 0.00] |
| fastapi | api-page | fixed | 3 / 0 / 3 | 150.01 [150.01, 150.01] | 150.01 [150.01, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| fastapi | api-page | sat64 | 3 / 0 / 3 | 268.26 [262.03, 279.32] | 268.26 [262.03, 279.32] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| fastapi | api-page | sat256 | 0 / 3 / 3 | 202.72 [198.68, 211.29] | 202.75 [198.69, 211.32] | 2.00 [1.00, 2.00] | 0.00 [0.00, 0.00] |
| axum-maud | fixture-page | fixed | 3 / 0 / 3 | 150.01 [150.01, 150.01] | 150.01 [150.01, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| axum-maud | fixture-page | sat64 | 3 / 0 / 3 | 25,709.30 [25,200.75, 25,920.00] | 25,709.30 [25,200.75, 25,920.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| axum-maud | fixture-page | sat256 | 3 / 0 / 3 | 23,070.21 [22,890.95, 24,371.90] | 23,070.21 [22,890.95, 24,371.90] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| axum-maud | api-page | fixed | 3 / 0 / 3 | 150.00 [150.00, 150.01] | 150.00 [150.00, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| axum-maud | api-page | sat64 | 3 / 0 / 3 | 8,687.91 [8,664.55, 8,782.69] | 8,687.91 [8,664.55, 8,782.69] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| axum-maud | api-page | sat256 | 3 / 0 / 3 | 7,899.51 [7,801.21, 8,286.45] | 7,899.51 [7,801.21, 8,286.45] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| drogon | fixture-page | fixed | 3 / 0 / 3 | 150.01 [150.00, 150.01] | 150.01 [150.00, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| drogon | fixture-page | sat64 | 3 / 0 / 3 | 19,195.48 [19,137.85, 19,221.85] | 19,195.48 [19,137.85, 19,221.85] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| drogon | fixture-page | sat256 | 3 / 0 / 3 | 17,539.07 [17,446.55, 19,102.55] | 17,539.07 [17,446.55, 19,102.55] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| drogon | api-page | fixed | 3 / 0 / 3 | 150.01 [150.01, 150.01] | 150.01 [150.01, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| drogon | api-page | sat64 | 3 / 0 / 3 | 5,187.46 [5,073.08, 5,459.28] | 5,187.46 [5,073.08, 5,459.28] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| drogon | api-page | sat256 | 3 / 0 / 3 | 5,084.65 [4,961.75, 5,267.33] | 5,084.65 [4,961.75, 5,267.33] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| gin | fixture-page | fixed | 3 / 0 / 3 | 150.01 [150.00, 150.01] | 150.01 [150.00, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| gin | fixture-page | sat64 | 3 / 0 / 3 | 11,307.11 [11,118.67, 11,597.15] | 11,307.11 [11,118.67, 11,597.15] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| gin | fixture-page | sat256 | 3 / 0 / 3 | 10,367.10 [10,307.08, 10,809.63] | 10,367.10 [10,307.08, 10,809.63] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| gin | api-page | fixed | 3 / 0 / 3 | 150.01 [150.01, 150.01] | 150.01 [150.01, 150.01] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| gin | api-page | sat64 | 3 / 0 / 3 | 4,166.82 [3,795.26, 4,246.12] | 4,166.82 [3,795.26, 4,246.12] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| gin | api-page | sat256 | 3 / 0 / 3 | 4,018.70 [3,907.84, 4,038.61] | 4,018.70 [3,907.84, 4,038.61] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |

## Corten efficiency

Median and [minimum, maximum] across available passes. Memory is each pass's peak under load; p95 is the median of per-pass p95s, not a pooled percentile.

| Source / response | Attempted requests/CPU-second | Peak MiB | Sampled CPU % | p95 ms | Successful req/s range |
|---|---:|---:|---:|---:|---:|
| fixture-page | 29,485 [28,301, 30,183] | 9.62 [9.35, 9.89] | 101.1 [101.1, 101.5] | 2.85 [2.83, 2.94] | 28,051-29,803 |
| api-page | 9,229 [9,039, 9,275] | 9.73 [9.57, 10.75] | 101.5 [101.3, 101.5] | 9.75 [9.54, 9.82] | 9,037-9,273 |

## Limits

CPU efficiency is whole-container CPU, not handler-only time. Low sampled CPU flags possible underutilization; it does not diagnose its cause. This suite does not measure build times, instruction counts or browser interactivity.
