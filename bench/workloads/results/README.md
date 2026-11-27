# Benchmark group results

Each group compares contenders doing the same work. Its report names the measured commit,
date, configuration, and outcomes. The groups can be measured on different dates and
commits. Compare contenders within a group, not numbers from different workloads.
The [group definitions](../README.md) describe the features each comparison requires.
Each provenance record binds the published Markdown as `publishedReportSha256`,
separately from the collected archive and native report or result.

| Group | Measured commit | Date (UTC) | Result |
|---|---|---|---|
| Lean catalog page | [30b39d455](https://github.com/corten-run/corten/commit/30b39d455ad4c9840e1a4206cbd716f519448f1a) | 2026-11-21 | [Throughput, CPU, memory, latency, cold start and pass ranges](r24/catalog-page/report.md). Five of seven passed every phase. |
| JSON API | | | No verified result yet |
| Localized marketplace | [28cdc5bc7](https://github.com/corten-run/corten/commit/28cdc5bc7ec3a48cb0db7288f9d448becfdff81f) | 2026-11-26 | [Localized pages and locale-neutral JSON](r84/localized-marketplace/report.md). Eight adapters passed the feature gate; load failures are marked by phase. |
| Mixed production | | | No verified result yet |
| Fullstack browser | | | No verified result yet |
| Client-heavy | [8b4e863b1](https://github.com/corten-run/corten/commit/8b4e863b15020d720b22d5cf1665f9ae16b2473a) | 2026-11-26 | [Browser journey timings](r87/client-heavy/report.md). Native replay verified; archive locator pending. |
| Live delivery | | | No verified result yet |
| Recoverable live | | | No verified result yet |
| Hardening | | | No verified result yet |

On the lean catalog page at 64 users, Corten served **29,160 pages/s** from the in-memory
fixture and **9,227 pages/s** with the HTTP data source. Axum + Maud was next among eligible
contenders at **25,709** and **8,688 pages/s**, respectively. Express and FastAPI served the
64-user phases but recorded timeouts at 256 users. Their numbers remain visible in the
report and are not used to rank them. The [evidence record](r24/catalog-page/provenance.json)
includes the exact per-pass timeout counts and the source archive checksum.

The localized marketplace rotates English, French, and German in one timed page profile
per data source. JSON is locale-neutral. At 150 requests/s on the in-memory page, Corten
recorded **0.26 ms** p95, **11.31 MiB** steady container memory, and **171 ms** to the first
complete HTTP 200 from container start in the separate cold probe. The [evidence record](r84/localized-marketplace/provenance.json)
binds the report to the collected archive. Connection-flood resistance was not measured.
