# Benchmark group results

Each group compares contenders doing the same work. Its report names the measured commit,
date, configuration, and outcomes. The groups can be measured on different dates and
commits. Compare contenders within a group, not numbers from different workloads.
The [group definitions](../README.md) describe the features each comparison requires.

| Group | Measured commit | Date (UTC) | Result |
|---|---|---|---|
| Lean catalog page | [30b39d455](https://github.com/corten-run/corten/commit/30b39d455ad4c9840e1a4206cbd716f519448f1a) | 2026-11-21 | [Throughput, CPU, memory, latency, cold start and pass ranges](r24/catalog-page/report.md). Five of seven passed every phase. |
| JSON API | | | No verified result yet |
| Localized marketplace | | | No verified result yet |
| Mixed production | | | No verified result yet |
| Fullstack browser | | | No verified result yet |
| Client-heavy | | | No verified result yet |
| Live delivery | | | No verified result yet |
| Recoverable live | | | No verified result yet |
| Hardening | | | No verified result yet |

On the lean catalog page at 64 users, Corten served **29,160 pages/s** from the in-memory
fixture and **9,227 pages/s** with the HTTP data source. Axum + Maud was next among eligible
contenders at **25,709** and **8,688 pages/s**, respectively. Express and FastAPI served the
64-user phases but recorded timeouts at 256 users. Their numbers remain visible in the
report and are not used to rank them. The [evidence record](r24/catalog-page/provenance.json)
includes the exact per-pass timeout counts and the source archive checksum.
