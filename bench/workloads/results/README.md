# Benchmark group results

Each group compares contenders doing the same work. Its report names the measured commit,
date, configuration, and outcomes. The groups can be measured on different dates and
commits. Compare contenders within a group, not numbers from different workloads.
The [group definitions](../README.md) describe the features each comparison requires.
Each provenance record binds the published Markdown as `publishedReportSha256`,
separately from the collected archive and native report or result.
Where present, `custodyRef` identifies the privately held original whose digest is
`archiveSha256`. The separate `exportLocator` and `exportSha256` identify the compact
report inputs in the access-controlled evidence repository. These inputs support
checking the reported numbers, not native replay or qualification.

| Group | Measured commit | Date (UTC) | Result |
|---|---|---|---|
| Lean catalog page | [30b39d455](https://github.com/corten-run/corten/commit/30b39d455ad4c9840e1a4206cbd716f519448f1a) | 2026-11-21 | [Throughput, CPU, memory, latency, cold start and pass ranges](r24/catalog-page/report.md). Five of seven passed every phase. |
| JSON API | | | No verified result yet |
| Localized marketplace | [28cdc5bc7](https://github.com/corten-run/corten/commit/28cdc5bc7ec3a48cb0db7288f9d448becfdff81f) | 2026-11-26 | [Localized pages and locale-neutral JSON](r84/localized-marketplace/report.md). Eight adapters passed the feature gate; load failures are marked by phase. |
| Mixed production | | | No verified result yet |
| Fullstack browser | | | No verified result yet |
| Client-heavy | [8b4e863b1](https://github.com/corten-run/corten/commit/8b4e863b15020d720b22d5cf1665f9ae16b2473a) | 2026-11-26 | [Browser journey timings](r87/client-heavy/report.md). Six contenders passed; action-level ranges, not an overall ranking. |
| Live delivery | | | No verified result yet |
| Recoverable live | | | No verified result yet |
| Hardening | [6345df88c](https://github.com/corten-run/corten/commit/6345df88c530fe7fcca7f10bab934aa324179de5) | 2026-11-27 to 2026-11-28 | [Timeout, limit and recovery outcomes](r112/hardening/report.md). All 108 cells observed; eight adapters met the scoped production checks. |

On the lean catalog page at 64 users, Corten served **29,160 pages/s** from the in-memory
fixture and **9,227 pages/s** with the HTTP data source. Axum + Maud was next among eligible
contenders at **25,709** and **8,688 pages/s**, respectively. Express and FastAPI served the
64-user phases but recorded timeouts at 256 users. Their numbers remain visible in the
report and are not used to rank them. The [evidence record](r24/catalog-page/provenance.json)
includes the exact per-pass timeout counts and the source archive checksum.
The current catalog definition also lists Proa, which was not part of r24 and is
not measured or ranked here.
The compact export keeps each contender's cold probes and timed phases by origin
and pass, including the numeric inputs for throughput, latency, CPU and memory,
failures and comparison eligibility. Recompute the report within each source and
phase, excluding ineligible contenders from the comparison only.

The localized marketplace rotates English, French, and German in one timed page profile
per data source. JSON is locale-neutral. At 150 requests/s on the in-memory page, Corten
recorded **0.26 ms** p95, **11.31 MiB** steady container memory, and **171 ms** to the first
complete HTTP 200 from container start in the separate cold probe. The [evidence record](r84/localized-marketplace/provenance.json)
binds the report to the collected archive. Connection-flood resistance was not measured.
The compact export keeps the qualification verdict and browser-profile count by
adapter and source. For each measured profile and adapter it retains the cold probe
and timed numeric inputs and failures by pass, plus the outcomes used to rebuild
the report. Comparison is limited to admitted, measured adapters and does not rank
the omitted inventory.

Hardening's [evidence record](r112/hardening/provenance.json) links the compact
export of all 108 cells. Group by adapter, data source, deployment, and phase to
recompute coverage. Count expected probe outcomes and healthy terminals separately.
Count API recovery only on the API source, and group the production-qualified cells
by adapter and deployment. No cell is eligible for numeric comparison.
