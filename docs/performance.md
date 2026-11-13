# Performance

[Back to the README](../README.md)

Speed at the user's end is Corten's first value, so every claim about it has a measured number.
This page gathers the comparisons; how each number is taken is in the benchmark READMEs it links.

## Reading the comparisons

No single table establishes overall framework speed. The historical marketplace measures a
richer application, with the work differences stated below. The separate catalog measures a
strings-only page and JSON. [Marketplace v2](../bench/marketplace/README.md) adds a separate
rich-page workload with request-time localization in all twenty adapters, a whole-page
conformance gate and a repeated-pass runner. The qualified production round r20 below starts
its own baseline; historical evidence remains under its original workload and commit. Old marketplace localization was non-equivalent:
Corten formatted values per request while some others used stored strings or non-localized formatting. Those
tables describe historical implementations, not valid general framework speed rankings.

| Question | Evidence to read |
|---|---|
| How fast does it feel? | Phone interactivity, navigation and form-update latency, transferred bytes |
| What does serving it cost? | CPU per request, CPU and loaded memory at the same fixed rate |
| How much can it handle? | Throughput with a stated latency/error limit and app/upstream headroom |
| What does development cost? | Clean and incremental build times, development rebuilds, CPU and peak memory |

Read throughput alongside CPU utilization and requests per CPU-second: similar req/s can hide
different costs, and an app whose CPU is not busy has not demonstrated its maximum capacity.
A saturated upstream can bound the whole application. Compare repeated passes on one host;
keep medians, ranges, failures and configuration differences visible. The catalog and marketplace reporters
flag these limits and label incomplete data rather than treating missing passes as zeros.

Features are a different question from speed. The [highlights](../README.md#highlights) link
to Corten's behavior and examples. A future comparison must distinguish built-in support,
support through a named library, and behavior not implemented or not evaluated in an example;
a benchmark omission is not evidence a framework lacks a feature. Do not combine these into
a single performance score.

## Nightly scope

Starting at official r17, the [nightly procedure](../bench/marketplace/nightly.md) uses only
marketplace v2, not a duplicate catalog run. Later official rounds use fresh `rN` identifiers
with N >= 17; `wN` is for development. V2 has a new baseline: compare only compatible v2
rounds, never calculate an r16 or catalog c1 before/after delta.

The nightly suite measures CPU, memory, load and cold start. Three passes use
`--duration 15 --warmup 10 --rate 150` on a dedicated c-8 with app CPU 1, upstream CPUs 2-3
and load-generator CPUs 4-7. Pages are timed in `en-US`, `fr-FR` and `de-DE`; locale-neutral
JSON is timed once per source per pass, not repeated as a locale control. The pre-load gate
requires every adapter in the reserved [framework group](../bench/marketplace/nightly.md#framework-groups),
both sources and every conformance profile for each feature-qualified candidate. Popular and
performance-oriented shortlists share one deduplicated production run; native capability
probes exclude unsupported peers, with explicit reasons. Axum is not an automatic anchor.
A round can be [split across droplets](../bench/marketplace/nightly.md#split-rounds) started
together; the nightly default stays one host.
A group result does not rank unmeasured apps; only identical groups, admitted sets and
otherwise compatible configurations can be compared. The scoped production checklist's
ETag and downstream-readiness exceptions are disclosed in the group contract.

Report these as short-window medians and ranges, with errors, utilization and headroom limits;
they do not guarantee a finish by 7 am or establish small differences without repeatability.
Build times, instructions, bytes and interactive timing are not measured by this suite yet.
The older measurements below remain historical evidence for their own workloads, not v2
results. The nonlocalized [catalog](../bench/catalog/README.md) remains an optional, separate
diagnostic. Full-feature claims remain separate from measured speed.

## On the server

Historical round r20 is the **first validated v2 production baseline**, measured on 2026-11-12 (UTC)
at `43550265076e378d2159a9ebc254cf9412a2355a` on one dedicated c-8 (Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz).
It is a saved measurement of that commit, not today's code or a baseline for the newer
workload-group campaign. There is no speed delta from r16, catalog c1/c2 or another workload.

Group `production`, feature profile `marketplace-production/v1`, native
`PROFILE=matched`, connection cap 1000. Corten and ASP.NET Core qualified in both sources
and passed every browser/content gate. Next.js, FastAPI, Express, Topcoat, Leptos were
probed and excluded, not timed. The report preserves each missing requirement and lists all
omitted adapters, which were not tested. These are measured adapter configurations, not claims
about what their frameworks could implement. Conditional GET/ETag and downstream readiness
are disclosed exceptions; logging remains native, not normalized.

The saved runner interval was 73.34 minutes (2026-11-12T15:39:48.785Z to 2026-11-12T16:53:08.923Z);
it is not launch-to-deletion time or a cloud-cost measurement. The app had 1 core and
1 GiB, pinned to CPU 1; the single-process upstream had
2 cores and 512 MiB on CPUs 2-3; the generator used CPUs
4-7, leaving CPU 0 for the system. Pinning and quotas are saved in the summary.

All 2 admitted adapters completed 8 profiles and 3 passes each, with no request
failures, dropped iterations or app stops, including warmup. The qualification table below is
specific to the measured commit, not later adapter repairs. It does not certify the newer
group contracts or change their readiness. Corten's archived `0.1`/`axum` table label is stale
metadata, not measured implementation provenance. The saved build used `corten-run v0.2.0`,
with the hyper-backed Corten at the measured commit; raw labels and generated tables are
preserved unchanged.

No measured HTTP phase reached 80% upstream CPU; the highest phase average was 74.89% of one core. The single-process upstream still has a one-core ceiling despite its two-core quota.

The following tables and pass-specific warnings are generated by the read-only reporter from
[r20's saved summary](../bench/marketplace/results/r20/summary.json), with the
[original report](../bench/marketplace/results/r20/report.md) and
[archive checksum receipt](../bench/marketplace/results/r20/archive-sha256.txt).
Table order is the reserved candidate order, not a speed ranking. Every measured phase keeps
its throughput, latency, fixed-load CPU/memory, counted efficiency and pass ranges.

Commit: `43550265076e378d2159a9ebc254cf9412a2355a`. Schema: `marketplace-results/v5`. CPU: Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz (online CPUs 0-7).
Group: production. Measured adapters: corten, aspnet. Omitted adapters were not tested; this is not a ranking of the full inventory.
Omitted adapters: tanstack-start, sveltekit, react-router, django, rails, laravel, spring, phoenix, astro, nuxt, axum-maud, gin, drogon.
A new localized baseline, not a change from marketplace r16 or catalog c1.

Every number is the median [min-max] of three measured passes, not a confidence interval, except in a row marked stopped, which has fewer: of two passes each number is the lower of the two values in its column, of one pass that pass. Overlapping ranges do not establish a speed difference.
Pages cover all three locales; JSON is locale-neutral and timed once per source/pass. Every measured adapter passes both sources and twelve browser profiles before any load.
Fixed load asks for 150 requests/second. Closed-loop 64/256-user results are observed throughput and latency, not proven maximum capacity. Warmup 10s; each phase 15s; identity encoding.
CPU % is sampled app-container usage (100% = one core). CPU us/request and requests/CPU-second use counted whole-container cgroup CPU, not instructions or handler-only time. CPU % and steady memory average the central 15%-95% of samples; peak memory is the sampled maximum, not an unsampled high-water mark.
These load results do not measure browser interactivity, bytes, build cost or instructions.
A stage marked * is the app's measured outcome under this profile: some requests got an answer other than 200 or timed out (10 s), or the fixed rate could not be started. It is recorded, not retried, and the later phases still ran. Its req/s, latency percentiles and requests/CPU-second count every request sent, failed ones included.
A stage marked (stopped: n of 3 passes) is also the app's outcome: its container exited or was OOM-killed during a load phase (warmup included), and the line below the table says when. That profile's later phases and passes were not run, so the stage's numbers come from the n passes before the stop, or none. A 200 of the wrong content type, an app that stopped during its cold start or before a phase began, or an upstream error fails the run instead.

Feature contract: marketplace-production/v1. Popular and performance-oriented candidate cohorts are deduplicated; candidates are not a current speed ranking. ETag/conditional GET and downstream readiness are not required by this workload, and are not claimed equivalent. Logging remains native, not normalized.

### Feature Qualification

| Candidate | Result | Missing required work |
|---|---|---|
| corten | admitted | none |
| nextjs | excluded, not timed | fixture: pageHeaders; fixture: pageScripts; fixture: host; fixture: live; fixture: unfinishedHead; fixture: connectionCap; api: pageHeaders; api: pageScripts; api: host; api: live; api: deadline; api: unfinishedHead; api: connectionCap |
| aspnet | admitted | none |
| fastapi | excluded, not timed | fixture: bigHead; fixture: live; fixture: unfinishedHead; fixture: connectionCap; api: page500; api: json500; api: bigHead; api: live; api: unfinishedHead; api: connectionCap |
| express | excluded, not timed | fixture: json404; fixture: json405; fixture: host; fixture: live; api: json404; api: json405; api: json500; api: host; api: live |
| topcoat | excluded, not timed | fixture: pageScripts; fixture: json404; fixture: json405; fixture: host; fixture: bigHead; fixture: live; fixture: connectionCap; api: pageScripts; api: page500; api: json404; api: json405; api: json500; api: host; api: bigHead; api: live; api: connectionCap |
| leptos | excluded, not timed | fixture: crossSite; fixture: json404; fixture: json405; fixture: host; fixture: bigHead; fixture: live; fixture: unfinishedHead; fixture: connectionCap; api: crossSite; api: json404; api: json405; api: json500; api: host; api: bigHead; api: live; api: unfinishedHead; api: connectionCap |

Warning: Short 15s phase windows (10s warmup): variability and sampling limits matter; not comparable to manual 60s phases with 30s warmup.

### en-US

#### Memory source

##### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 182.00 [176.00-183.00] | 12.22 [11.82-13.41] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1004.00 [977.00-1020.00] | 293.51 [279.91-297.35] |

##### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [150.04-150.05] | 0.41 [0.30-0.42] | 0.52 [0.40-0.53] | 0.55 [0.45-0.57] | 3.38 [2.41-3.48] | 228.28 [165.36-234.59] | 11.39 [11.25-11.41] | 11.64 [11.60-11.65] | 4380.64 [4262.83-6047.27] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.04 [149.99-150.04] | 1.67 [1.44-1.98] | 2.81 [2.22-3.19] | 4.45 [3.57-4.53] | 29.81 [25.78-34.96] | 2016.14 [1728.19-2270.98] | 57.79 [57.56-58.42] | 58.81 [58.47-59.59] | 496.00 [440.34-578.64] | 0.00 [0.00-0.00] |

##### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 20544.98 [19501.83-21843.88] | 2.20 [2.11-2.33] | 8.12 [7.36-8.34] | 13.93 [13.17-14.44] | 84.94 [84.75-86.55] | 41.58 [39.27-43.30] | 11.77 [11.66-11.77] | 12.16 [12.04-12.18] | 24049.29 [23096.93-25466.49] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1162.00 [1141.08-1198.85] | 56.49 [54.40-56.79] | 81.22 [78.33-85.47] | 108.03 [97.29-116.73] | 100.21 [100.08-100.24] | 859.11 [833.32-875.78] | 59.86 [59.77-59.98] | 61.08 [60.84-61.45] | 1164.00 [1141.84-1200.02] | 0.00 [0.00-0.00] |

Warning: corten fixture-en-US-page sat64 pass 1: app CPU 84.9%; saturation not demonstrated.

Warning: corten fixture-en-US-page sat64 pass 2: app CPU 84.7%; saturation not demonstrated.

Warning: corten fixture-en-US-page sat64 pass 3: app CPU 86.5%; saturation not demonstrated.

##### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 18327.11 [17688.88-18740.98] | 9.69 [7.67-9.92] | 28.46 [28.30-30.67] | 42.55 [41.05-43.19] | 88.26 [80.96-88.73] | 46.43 [43.92-49.38] | 13.98 [13.96-14.44] | 14.70 [14.60-15.22] | 21537.62 [20251.52-22770.60] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1695.97 [1686.24-1735.46] | 144.92 [144.19-145.12] | 239.97 [234.81-255.56] | 335.51 [324.88-340.95] | 100.02 [100.00-100.07] | 592.22 [575.65-595.78] | 69.89 [69.34-72.75] | 76.38 [76.24-77.96] | 1688.57 [1678.46-1737.16] | 0.00 [0.00-0.00] |

Warning: corten fixture-en-US-page sat256 pass 1: app CPU 81.0%; saturation not demonstrated.

Warning: corten fixture-en-US-page sat256 pass 2: app CPU 88.7%; saturation not demonstrated.

Warning: corten fixture-en-US-page sat256 pass 3: app CPU 88.3%; saturation not demonstrated.

#### HTTP source

##### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 159.00 [158.00-161.00] | 15.63 [14.08-18.05] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 917.00 [913.00-945.00] | 354.24 [345.03-355.04] |

##### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [150.04-150.06] | 0.61 [0.59-0.62] | 0.78 [0.74-0.79] | 0.87 [0.82-0.87] | 4.67 [4.66-4.82] | 317.44 [315.24-327.05] | 7.80 [7.52-8.10] | 8.13 [7.67-8.25] | 3150.16 [3057.68-3172.15] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.04 [150.04-150.04] | 2.08 [2.03-2.09] | 3.85 [3.79-3.90] | 5.88 [5.78-5.96] | 34.77 [34.49-35.14] | 2334.02 [2284.01-2373.34] | 52.12 [51.46-53.85] | 53.42 [52.40-54.70] | 428.44 [421.35-437.83] | 0.00 [0.00-0.00] |

##### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 6696.24 [6220.59-7233.94] | 9.42 [7.68-10.54] | 13.29 [13.21-13.72] | 15.40 [15.37-15.85] | 101.91 [101.78-102.21] | 149.18 [138.00-160.59] | 9.60 [8.75-9.67] | 10.57 [9.17-10.70] | 6703.50 [6227.00-7246.26] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 705.68 [700.38-714.74] | 87.90 [86.89-88.26] | 115.94 [115.48-124.14] | 155.52 [153.91-158.50] | 100.30 [100.25-100.31] | 1415.90 [1397.43-1426.43] | 61.34 [61.21-61.81] | 64.04 [63.89-64.13] | 706.26 [701.05-715.60] | 0.00 [0.00-0.00] |

##### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 6053.80 [6025.90-6194.09] | 39.86 [38.07-40.29] | 73.92 [72.88-77.49] | 95.04 [91.48-103.12] | 102.25 [102.06-102.37] | 164.82 [161.00-165.59] | 26.88 [25.49-27.22] | 27.68 [25.99-27.81] | 6067.33 [6038.84-6211.14] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 725.17 [718.75-789.07] | 337.30 [325.36-341.10] | 457.35 [438.56-474.16] | 550.48 [495.58-552.67] | 100.16 [100.04-100.18] | 1375.13 [1266.70-1390.28] | 77.87 [77.50-78.10] | 82.20 [81.63-83.38] | 727.20 [719.28-789.45] | 0.00 [0.00-0.00] |

### fr-FR

#### Memory source

##### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 186.00 [174.00-190.00] | 12.02 [11.60-12.04] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 955.00 [937.00-962.00] | 268.78 [267.31-281.37] |

##### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [149.99-150.05] | 0.32 [0.29-0.32] | 0.42 [0.39-0.43] | 0.46 [0.44-0.49] | 2.61 [2.47-2.61] | 177.77 [169.18-178.21] | 11.30 [11.28-11.40] | 11.61 [11.59-11.62] | 5625.14 [5611.24-5910.88] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.03 [149.98-150.04] | 1.42 [1.36-1.51] | 2.41 [2.32-2.45] | 3.67 [3.63-3.71] | 26.07 [23.97-26.79] | 1740.66 [1656.08-1785.59] | 58.39 [57.18-58.48] | 59.46 [58.22-59.66] | 574.49 [560.04-603.84] | 0.00 [0.00-0.00] |

##### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 21574.14 [21427.51-21699.30] | 2.13 [2.09-2.13] | 7.76 [7.64-7.86] | 14.00 [13.66-14.05] | 85.68 [84.38-86.13] | 39.41 [38.72-39.77] | 11.62 [11.58-11.80] | 12.11 [12.03-12.21] | 25375.34 [25143.48-25826.66] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1394.34 [1184.67-1409.83] | 43.83 [40.49-54.15] | 80.09 [69.79-80.67] | 101.83 [93.25-111.34] | 100.17 [100.16-100.22] | 720.39 [708.73-843.41] | 61.59 [59.00-62.04] | 65.26 [60.31-65.81] | 1388.13 [1185.66-1410.98] | 0.00 [0.00-0.00] |

Warning: corten fixture-fr-FR-page sat64 pass 1: app CPU 86.1%; saturation not demonstrated.

Warning: corten fixture-fr-FR-page sat64 pass 2: app CPU 85.7%; saturation not demonstrated.

Warning: corten fixture-fr-FR-page sat64 pass 3: app CPU 84.4%; saturation not demonstrated.

##### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 18678.02 [17981.71-20018.30] | 9.24 [7.89-11.24] | 29.15 [27.94-29.58] | 39.95 [39.55-41.49] | 89.95 [86.54-94.32] | 47.63 [43.14-51.25] | 14.13 [14.01-14.19] | 14.89 [14.81-15.16] | 20997.05 [19513.95-23177.79] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1965.97 [1806.52-2232.62] | 120.51 [107.04-128.66] | 212.12 [199.66-245.35] | 305.46 [289.32-312.61] | 100.10 [100.08-100.13] | 507.90 [446.50-552.22] | 74.40 [74.02-75.12] | 78.12 [77.06-78.93] | 1968.91 [1810.87-2239.62] | 0.00 [0.00-0.00] |

Warning: corten fixture-fr-FR-page sat256 pass 1: app CPU 94.3%; saturation not demonstrated.

Warning: corten fixture-fr-FR-page sat256 pass 2: app CPU 86.5%; saturation not demonstrated.

Warning: corten fixture-fr-FR-page sat256 pass 3: app CPU 90.0%; saturation not demonstrated.

#### HTTP source

##### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 158.00 [156.00-166.00] | 17.56 [14.84-20.64] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 930.00 [923.00-931.00] | 352.25 [351.71-359.60] |

##### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [150.05-150.05] | 0.58 [0.58-0.58] | 0.73 [0.73-0.74] | 0.81 [0.80-0.85] | 4.47 [4.34-4.57] | 301.79 [298.97-312.15] | 7.75 [7.32-7.99] | 8.16 [7.53-8.36] | 3313.55 [3203.62-3344.79] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.03 [149.99-150.03] | 2.12 [2.03-2.76] | 3.87 [3.78-4.81] | 6.13 [5.81-7.08] | 34.11 [33.38-44.39] | 2308.15 [2269.93-2928.86] | 51.17 [50.14-51.73] | 52.54 [51.57-53.14] | 433.25 [341.43-440.54] | 0.00 [0.00-0.00] |

##### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 7523.12 [6830.80-7734.14] | 7.81 [7.58-8.42] | 13.22 [12.48-13.29] | 15.43 [15.18-15.45] | 101.92 [101.73-101.99] | 132.82 [129.20-146.22] | 9.58 [8.73-10.08] | 10.59 [9.29-11.01] | 7528.73 [6838.83-7739.86] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 667.03 [633.82-688.51] | 91.01 [89.55-97.63] | 135.30 [125.36-149.90] | 156.26 [153.93-175.66] | 100.31 [100.25-100.31] | 1522.48 [1457.71-1576.64] | 59.74 [59.21-60.04] | 62.05 [62.04-63.97] | 656.82 [634.26-686.01] | 0.00 [0.00-0.00] |

##### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 6251.80 [6146.12-6360.60] | 38.70 [38.20-39.48] | 70.37 [69.26-75.36] | 87.56 [86.33-100.04] | 102.27 [102.17-102.36] | 159.57 [156.72-162.31] | 25.48 [25.47-28.58] | 26.06 [26.04-29.32] | 6266.87 [6161.20-6380.79] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 752.95 [683.60-883.89] | 337.79 [274.50-364.63] | 470.93 [384.56-491.83] | 525.49 [409.98-554.65] | 100.16 [100.09-100.22] | 1332.66 [1148.80-1463.59] | 79.24 [79.12-80.83] | 83.77 [81.88-86.30] | 750.38 [683.25-870.47] | 0.00 [0.00-0.00] |

### de-DE

#### Memory source

##### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 183.00 [182.00-192.00] | 12.10 [11.53-14.62] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 980.00 [961.00-1020.00] | 284.72 [271.54-294.73] |

##### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [150.05-150.05] | 0.31 [0.30-0.37] | 0.40 [0.40-0.50] | 0.46 [0.45-0.55] | 2.55 [2.52-3.03] | 175.30 [175.16-201.45] | 11.27 [11.26-11.31] | 11.59 [11.55-11.61] | 5704.50 [4964.10-5709.01] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.04 [150.04-150.05] | 1.45 [1.44-1.74] | 2.18 [2.12-2.69] | 3.53 [3.43-3.86] | 26.02 [25.58-29.75] | 1709.51 [1696.21-2063.47] | 58.35 [57.74-58.53] | 59.20 [58.68-59.82] | 584.96 [484.62-589.55] | 0.00 [0.00-0.00] |

##### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 20950.93 [19790.66-21588.27] | 2.21 [2.15-2.45] | 7.76 [7.50-7.81] | 13.48 [13.34-13.89] | 87.10 [86.64-88.40] | 41.03 [39.95-44.08] | 11.69 [11.63-11.70] | 12.05 [11.96-12.20] | 24372.74 [22687.43-25034.06] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1222.76 [1133.35-1352.82] | 54.24 [43.76-58.78] | 77.62 [71.62-82.83] | 108.24 [99.19-111.63] | 100.21 [100.14-100.24] | 822.15 [743.36-886.98] | 59.90 [58.90-60.96] | 60.88 [60.46-64.89] | 1216.33 [1127.43-1345.24] | 0.00 [0.00-0.00] |

Warning: corten fixture-de-DE-page sat64 pass 1: app CPU 86.6%; saturation not demonstrated.

Warning: corten fixture-de-DE-page sat64 pass 2: app CPU 88.4%; saturation not demonstrated.

Warning: corten fixture-de-DE-page sat64 pass 3: app CPU 87.1%; saturation not demonstrated.

##### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 18963.24 [16029.96-19093.67] | 9.30 [8.80-13.82] | 28.12 [27.27-31.49] | 41.27 [40.32-42.61] | 89.62 [86.73-95.06] | 46.33 [44.86-58.61] | 14.24 [14.11-14.24] | 15.02 [14.93-15.03] | 21584.83 [17062.17-22292.20] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1825.80 [1797.82-2027.30] | 129.67 [114.20-135.86] | 231.82 [225.27-242.89] | 314.01 [264.82-314.07] | 100.11 [100.08-100.15] | 547.15 [491.79-555.22] | 73.33 [72.10-76.29] | 77.37 [76.52-78.56] | 1827.65 [1801.08-2033.40] | 0.00 [0.00-0.00] |

Warning: corten fixture-de-DE-page sat256 pass 1: app CPU 89.6%; saturation not demonstrated.

Warning: corten fixture-de-DE-page sat256 pass 3: app CPU 86.7%; saturation not demonstrated.

#### HTTP source

##### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 158.00 [156.00-166.00] | 17.30 [15.73-19.66] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 946.00 [935.00-1010.00] | 362.37 [358.27-378.88] |

##### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [149.98-150.05] | 0.58 [0.58-0.86] | 0.73 [0.72-1.04] | 0.81 [0.79-1.10] | 4.44 [4.38-6.49] | 304.61 [297.85-436.19] | 7.61 [7.58-7.86] | 8.05 [7.87-8.10] | 3282.86 [2292.56-3357.41] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.01 [149.99-150.03] | 2.14 [2.13-2.76] | 4.14 [4.07-4.79] | 6.79 [6.47-7.43] | 36.43 [36.35-44.84] | 2454.48 [2433.41-3087.98] | 51.75 [51.46-56.44] | 53.00 [52.61-58.34] | 407.42 [323.84-410.95] | 0.00 [0.00-0.00] |

##### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 6888.38 [6844.66-7175.67] | 8.12 [7.80-8.47] | 13.30 [13.28-13.85] | 15.46 [15.21-16.53] | 101.95 [101.90-102.10] | 145.02 [139.30-145.88] | 8.89 [8.58-9.41] | 9.50 [9.26-10.22] | 6895.84 [6855.03-7178.91] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 694.48 [694.24-788.90] | 89.52 [75.27-90.23] | 120.07 [117.71-120.72] | 151.63 [146.19-156.72] | 100.28 [100.27-100.34] | 1438.86 [1281.30-1439.09] | 61.58 [60.86-62.82] | 63.71 [63.68-63.97] | 695.00 [694.88-780.45] | 0.00 [0.00-0.00] |

##### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 6104.89 [6062.51-6486.96] | 39.76 [37.02-40.22] | 71.34 [70.94-74.34] | 91.54 [89.27-94.37] | 102.06 [102.01-102.21] | 163.52 [153.83-164.64] | 29.95 [27.42-30.23] | 30.74 [28.18-31.04] | 6115.49 [6073.94-6500.67] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 753.78 [706.52-997.30] | 342.14 [237.16-349.37] | 458.25 [377.98-472.66] | 534.08 [412.28-587.27] | 100.21 [100.13-100.22] | 1324.72 [1016.41-1412.83] | 77.17 [74.29-86.54] | 81.61 [80.68-90.59] | 754.88 [707.80-983.85] | 0.00 [0.00-0.00] |

### Locale-neutral JSON

#### Memory source

##### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 184.00 [177.00-192.00] | 12.37 [12.37-13.15] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 860.00 [808.00-869.00] | 142.45 [137.66-158.93] |

##### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 149.99 [149.99-150.05] | 0.27 [0.27-0.31] | 0.37 [0.36-0.44] | 0.42 [0.40-0.49] | 1.98 [1.89-2.28] | 136.06 [130.29-157.91] | 10.67 [10.63-10.69] | 10.94 [10.76-10.98] | 7349.91 [6332.80-7675.05] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.04 [149.99-150.05] | 0.64 [0.57-0.82] | 0.90 [0.75-1.05] | 2.62 [2.62-2.91] | 13.49 [12.28-17.58] | 880.07 [870.35-1108.15] | 49.56 [49.46-51.73] | 51.85 [50.93-53.28] | 1136.27 [902.41-1148.96] | 0.00 [0.00-0.00] |

##### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 22218.09 [21286.85-23037.44] | 1.98 [1.84-2.05] | 7.76 [7.62-8.30] | 13.22 [12.91-14.38] | 66.26 [65.23-78.45] | 30.92 [28.56-35.06] | 10.85 [10.85-11.07] | 11.31 [11.30-11.63] | 32345.84 [28524.10-35017.67] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 12547.87 [12522.61-12703.27] | 4.10 [4.10-4.48] | 10.32 [9.97-10.75] | 15.50 [14.73-16.18] | 99.64 [99.38-99.82] | 78.79 [77.73-79.26] | 56.44 [55.31-60.20] | 57.57 [57.50-61.06] | 12692.59 [12616.69-12864.28] | 0.00 [0.00-0.00] |

Warning: corten fixture-neutral-json sat64 pass 1: app CPU 78.5%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat64 pass 2: app CPU 65.2%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat64 pass 3: app CPU 66.3%; saturation not demonstrated.

##### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 20952.81 [19994.23-21455.74] | 8.22 [7.83-8.26] | 26.03 [24.63-27.13] | 37.55 [37.22-40.49] | 77.39 [76.52-81.29] | 38.09 [36.01-38.76] | 13.15 [12.99-13.16] | 13.51 [13.51-13.79] | 26250.80 [25800.65-27769.96] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 13816.79 [13203.54-13942.92] | 16.78 [16.45-17.56] | 33.74 [33.05-35.07] | 46.68 [46.67-48.58] | 98.87 [98.68-98.98] | 71.19 [70.26-74.45] | 59.27 [58.64-62.44] | 59.74 [59.14-63.00] | 14045.97 [13431.64-14232.83] | 0.00 [0.00-0.00] |

Warning: corten fixture-neutral-json sat256 pass 1: app CPU 77.4%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat256 pass 2: app CPU 76.5%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat256 pass 3: app CPU 81.3%; saturation not demonstrated.

#### HTTP source

##### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 163.00 [161.00-165.00] | 13.71 [13.58-14.02] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 792.00 [792.00-823.00] | 225.21 [215.36-225.79] |

##### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [149.99-150.05] | 0.60 [0.54-0.80] | 0.76 [0.69-0.96] | 0.82 [0.76-1.02] | 4.22 [3.83-5.54] | 286.50 [260.95-375.16] | 7.35 [6.56-7.36] | 7.64 [7.04-7.68] | 3490.44 [2665.51-3832.21] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.03 [150.02-150.04] | 1.27 [1.19-1.74] | 2.32 [1.97-2.68] | 5.15 [4.97-5.20] | 21.33 [21.28-27.21] | 1446.30 [1431.08-1788.05] | 44.22 [43.90-46.60] | 47.75 [46.80-50.09] | 691.42 [559.27-698.77] | 0.00 [0.00-0.00] |

##### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 8465.41 [7546.34-8486.89] | 6.58 [6.42-7.97] | 11.43 [11.07-12.47] | 15.89 [15.10-17.11] | 101.46 [101.46-101.67] | 117.74 [117.42-131.97] | 9.44 [8.59-9.62] | 10.23 [9.08-10.42] | 8493.13 [7577.40-8516.78] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1797.66 [1576.30-1892.03] | 34.35 [33.74-38.42] | 46.66 [46.54-59.79] | 59.99 [57.42-74.60] | 100.49 [100.40-100.51] | 568.40 [531.23-637.70] | 52.26 [51.92-54.51] | 56.89 [53.36-60.30] | 1759.31 [1568.13-1882.43] | 0.00 [0.00-0.00] |

##### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 7265.19 [7216.04-7921.54] | 31.30 [25.03-31.45] | 65.19 [63.46-66.30] | 81.53 [80.79-83.99] | 102.03 [101.90-102.15] | 137.39 [125.97-138.29] | 27.00 [24.81-29.41] | 27.65 [25.30-29.86] | 7278.57 [7230.98-7938.59] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 3743.84 [2953.02-4053.72] | 58.45 [56.99-82.00] | 119.72 [104.72-133.05] | 143.68 [121.86-157.89] | 100.60 [100.58-100.63] | 266.83 [250.24-338.08] | 65.01 [63.86-66.46] | 69.29 [66.23-71.05] | 3747.71 [2957.92-3996.24] | 0.00 [0.00-0.00] |

### Limits

single Node process, even with a two-CPU quota; high upstream CPU can limit API-mode throughput; closed-loop VUs alone do not prove app saturation
cgroup v2 usage_usec before/after docker start -a of k6; includes small Docker command/idle windows, not only HTTP handler CPU

## Historical measurements

Measured on one DigitalOcean c-8 droplet (Xeon Platinum 8168) on 2026-11-06 to 2026-11-07 (UTC), three load-test passes
(round r16, the tree at `eea6adb`). The
method, every table and the caveats are in [bench/fullstack](../bench/fullstack/README.md) and
[bench/browser](../bench/browser/README.md).

These are historical marketplace measurements with non-equivalent localization, including
localized prices in Corten's example. The separate [catalog benchmark](../bench/catalog/README.md) measures a strings-only
record-detail page in those eighteen frameworks and FastAPI and Express, with no locale formatting in any app.
It has a separate baseline; its throughput has not been measured yet.

### Historical server

Historical implementations of an item page (listings table, offers, a form that patches)
with unequal localization work, and the same item as JSON in
eighteen apps, each with its usual production settings on one CPU and 1 GiB. Requests a
second are at 64 users; "failed" means the app could not serve the fixed rate (or start) without
tuning. Corten's maintainers wrote every app; none has yet been reviewed in full by its
framework's maintainers, and [REVIEW.md](../bench/fullstack/REVIEW.md) asks them to.

| | Pages/s, no database | JSON/s, no database | Pages/s, item API | Process start to first page | Memory after first request |
|---|---|---|---|---|---|
| axum 0.8 + Maud 0.27 | 27,327 | 16,977 | 1,055 | 6.3 ms | 1.34 MiB |
| **Corten** | **20,705** | **26,385** | **3,669** | **8.6 ms** | **1.277 MiB** |
| Drogon 1.9 | 17,870 | 2,040 | 520 | 31 ms | 3.258 MiB |
| Topcoat 0.11 | 5,647 | 17,790 | 865 | 8.1 ms | 1.5 MiB |
| Gin 1.12 | 4,687 | 4,052 | 761 | 10 ms | 1.941 MiB |
| ASP.NET Core 10 | 4,115 | 12,440 | 1,292 | 724 ms | 30.67 MiB |
| Phoenix 1.8 | 1,478 | 2,150 | 399 | 1.3 s | 125.3 MiB |
| Leptos 0.8 | 1,356 | 15,854 | 747 | 8.0 ms | 1.488 MiB |
| Astro 7 | 1,202 | 1,879 | 461 | 319 ms | 36.5 MiB |
| Spring Boot 4.1 | 1,023 | 6,998 | 500 | 7.5 s | 140.8 MiB |
| SvelteKit 3 | 815 | 3,247 | 378 | 201 ms | 25.63 MiB |
| TanStack Start | 696 | 3,514 | 338 | 237 ms | 27.58 MiB |
| React Router 7 | 530 | 2,313 | 293 | 357 ms | 33.17 MiB |
| Rails 8.1 | 440 | 870 | 307 | 1.1 s | 63.83 MiB |
| Nuxt 4 | 325 | 7,274 | 217 | 348 ms | 36.49 MiB |
| Django 6.1 | 311 | 1,137 | 197 | 1.1 s | 65.66 MiB |
| Next.js 16 | failed (191) | 1,101 | failed (121) | 705 ms | 52.58 MiB |
| Laravel 13 | failed | failed | failed (110) | 863 ms | 96.2 MiB |

The load asks as `curl` does (`Accept-Encoding: identity`, no `If-None-Match`), so no app
compresses its page and Corten does not tag it (SvelteKit and Rails tag every page regardless).
A browser's request costs Corten more than the page. Measured in process on the item page,
hashing its `ETag` adds 27,700 user instructions to the 86,489 of the request the rounds send,
compressing it with zstd a further 230,000, and brotli 1, for a client without zstd, about
690,000 in place of zstd's
([details](../bench/fullstack/README.md#what-a-browsers-request-costs-corten-callgrind-2026-11-06)).

With the item API every request fetches and parses about 55 KB of JSON, which bounds every app.
Corten's historical implementation reads only the fields the page uses from that response,
not a `serde_json::Value` ([details](../bench/fullstack/README.md#cortens-item-api-path)).
Its JSON route costs 69,631 user instructions a request against the page's 94,677.
Against r15 the in-memory page rose 37.1% and JSON 17.0%, while the other passing apps' medians
rose 7.0% and 8.6%. This is not an unchanged-app control: every page app's Show all
markup changed, and Corten now sends five offers initially instead of every offer in hidden
templates. It still formats prices per request where some others use stored strings or non-localized formatting. The
page improvement is therefore not a like-for-like rendering speedup. JavaScript got worse,
13,187 to 14,392 gzip bytes (+9.1%); no other Corten regression crosses the thresholds.
Requests a second compare only within a round, since droplets of one size differ; instruction
counts compare across rounds. Pushing live updates
is measured in [bench/live](../bench/live/README.md): at 10,000 open connections on one core, only
Corten and Leptos delivered all 100,000 messages a second.

### Historical CPU and memory per request

Serving more is half of it; the other half is what each request costs. From the same r16 passes,
items in memory: pages per CPU-second are requests a second at 64 users over the share of its
core each app used, CPU for 300 pages a second is the fixed-rate phase, and pages a second per MiB
divide the 64-user rate by the app's peak memory under that load.

| | Pages per CPU-second | CPU for 300 pages a second | Pages a second per MiB | Peak memory, 64 users |
|---|---|---|---|---|
| axum 0.8 + Maud 0.27 | 28,300 | 3.6% | 1,697 | 16.1 MiB |
| **Corten** | **21,195** | **4.2%** | **1,234** | **16.8 MiB** |
| Drogon 1.9 | 18,069 | 4.3% | 1,407 | 12.8 MiB |
| Topcoat 0.11 | 5,648 | 8.4% | 362 | 15.6 MiB |
| Gin 1.12 | 4,687 | 8.5% | 195 | 24.1 MiB |
| ASP.NET Core 10 | 4,118 | 25% | 47 | 88.3 MiB |
| Phoenix 1.8 | 1,482 | 36% | 5.1 | 285.1 MiB |
| Leptos 0.8 | 1,356 | 25% | 83 | 16.2 MiB |
| Astro 7 | 1,203 | 29% | 8.7 | 137.6 MiB |
| Spring Boot 4.1 | 1,023 | 51% | 2.9 | 360 MiB |
| SvelteKit 3 | 815 | 43% | 5.6 | 144.7 MiB |
| TanStack Start | 696 | 50% | 4.2 | 165.5 MiB |
| React Router 7 | 530 | 61% | 3.6 | 147.8 MiB |
| Rails 8.1 | 440 | 75% | 3.1 | 140.6 MiB |
| Nuxt 4 | 325 | 100%, 291/s served | 2.3 | 142.8 MiB |
| Django 6.1 | 311 | 93% | 0.9 | 346.1 MiB |
| Next.js 16 | failed (191) | failed (89%, 159/s served) | failed (0.9) | 222.6 MiB |
| Laravel 13 | failed | failed | failed | failed |

Corten renders a page from memory with 47 µs of CPU, against ASP.NET Core's 243 µs and Leptos's
737 µs; axum + Maud costs 35 µs and Drogon 55 µs. At 300 pages a second Corten uses
4.2% of its core and serves 1,234 pages a second per MiB. These rows use counted cgroup CPU;
the load sends uncompressed, untagged requests, not the costlier browser request described above.

## In the browser

Historical r16 (`eea6adb`), not v2: the same item page, loaded cold in Chromium 148 from another site, median of 10 loads each. The
phone is the Lighthouse profile: 4x CPU slowdown, 150 ms round trip, 1.6 Mbps down.
"Interactive" is when the page's own code says it is ready; client navigation is the home page to
the item page. Every app ran on one core with items from the item API.

| | Phone: interactive | Phone: largest paint | Phone: client navigation | Desktop: interactive | Desktop: client navigation | JS heap | JavaScript, gzip |
|---|---|---|---|---|---|---|---|
| ASP.NET Core 10 | 447 ms | 436 ms | 242 ms | 52 ms | 17 ms | 1.7 MB | 17.0 KB |
| Drogon 1.9 | 450 ms | 432 ms | 214 ms | 52 ms | 17 ms | 1.7 MB | 17.0 KB |
| Django 6.1 | 451 ms | 428 ms | 248 ms | 53 ms | 20 ms | 1.7 MB | 17.0 KB |
| Topcoat 0.11 | 455 ms | 436 ms | 218 ms | 59 ms | 15 ms | 1.9 MB | 15.0 KB |
| **Corten** | **468 ms** | **460 ms** | **199 ms** | **59 ms** | **13 ms** | **1.6 MB** | **14.1 KB** |
| Spring Boot 4.1 | 642 ms | 484 ms | 243 ms | 65 ms | 33 ms | 1.7 MB | 17.0 KB |
| axum 0.8 + Maud 0.27 | 643 ms | 484 ms | 240 ms | 55 ms | 15 ms | 1.7 MB | 17.0 KB |
| Gin 1.12 | 645 ms | 480 ms | 241 ms | 54 ms | 15 ms | 1.7 MB | 17.0 KB |
| Astro 7 | 683 ms | 524 ms | 228 ms | 65 ms | 16 ms | 1.6 MB | 9.2 KB |
| Laravel 13 | 884 ms | 448 ms | 213 ms | 76 ms | 24 ms | 2.2 MB | 84.3 KB |
| SvelteKit 3 | 887 ms | 484 ms | 294 ms | 126 ms | 33 ms | 2.4 MB | 37.4 KB |
| Phoenix 1.8 | 955 ms | 424 ms | 138 ms | 112 ms | 18 ms | 2.3 MB | 46.2 KB |
| React Router 7 | 1,106 ms | 472 ms | 300 ms | 175 ms | 42 ms | 2.8 MB | 99.2 KB |
| Rails 8.1 | 1,182 ms | 528 ms | 248 ms | 66 ms | 27 ms | 2.1 MB | 40.7 KB |
| Next.js 16 | 1,437 ms | 428 ms | 520 ms | 162 ms | 140 ms | 3.3 MB | 136.2 KB |
| Nuxt 4 | 1,563 ms | 548 ms | 265 ms | 111 ms | 21 ms | 2.9 MB | 72.9 KB |
| Leptos 0.8 | 1,926 ms | 448 ms | 246 ms | 113 ms | 24 ms | 1.9 MB | 7.0 KB + 305 KB WASM |
| TanStack Start | 2,401 ms | 516 ms | 341 ms | 141 ms | 27 ms | 3.1 MB | 110.7 KB |

On a phone, Corten is interactive in 468 ms and on desktop in 59 ms. Its item page loads 14.1 KB of JavaScript (gzip).

## Client-heavy screens

A table of rows a script changes, in Chromium 156 on Linux. Each framework's app is written the
way its keyed [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) entry
is, built for production, and checked after every operation, so an app that skips work fails
instead of looking fast. Times run from the click to the DOM being updated (the frames that lay
it out and paint it are in the results): the median of 15, the slower of two rounds, or the
range when they disagree. Takeover runs from the HTML being parsed to the app marking itself
ready, for 1,000 rows the server rendered, less any frame the browser paints in between (the
median of 30 loads that take turns between the apps); every framework kept the server's rows.
Plain JavaScript is the floor: hand-written DOM code. Measured in round browser-4 (2026-11-11, at
`3fb4b1ac`, on a DigitalOcean c-8 droplet with a Xeon Platinum 8358;
[how the round ran](../bench/browser/README.md#on-linux-against-the-most-used-frameworks-round-browser-4)).

| | **Corten (views)** | Solid 1.9 | Svelte 5 | Vue 3.5 | React 19 | Remix 3 | Plain JS (floor) |
|---|---|---|---|---|---|---|---|
| Take over 1,000 server-rendered rows | **10.2 ms** | 16.2 ms | 19.3 ms | 21.6 ms | 54.8 ms | 131 ms | 1.1 ms |
| First click on a taken-over row | **1.4 ms** | 1.0 ms | 2.4 ms | 2.2 ms | 4.4 ms | 11.7 ms | 0.3 ms |
| Change 1 row of 10,000 | **0.2 ms** | 0.2 ms | 1.0 ms | 2.4 ms | 8.4 ms | 77.8 ms | 0.2 ms |
| Change 100 rows of 10,000 | **0.5 ms** | 0.7 ms | 1.4 ms | 3.2 ms | 7.4 ms | 78.6 ms | 0.4 ms |
| Update every 10th of 1,000 | **0.6 ms** | 0.5 ms | 0.5 ms | 0.8 ms | 1.6 ms | 7.1 ms | 0.3 ms |
| Select a row | **0.2 ms** | 0.2 ms | 0.6 ms | 0.4 ms | 0.7 ms | 6.8 ms | 0.1 ms |
| Swap two rows | **0.3 ms** | 0.5 ms | 0.5 ms | 0.5 ms | 7.5 ms | 5.9 ms | 0.2 ms |
| Create 1,000 rows | **5.0 ms** | 4.4 ms | 5.8 ms | 8.3 ms | 10.5 ms | 11.6 ms | 3.8 ms |
| Create 10,000 rows | **48.4 ms** | 41.6 ms | 57.7 ms | 85.4 ms | 284 ms | 123 ms | 37.5 ms |
| Dashboard: 200 prices tick | **0.4 ms** | 0.7 ms | 0.8 ms | 1.0 ms | 0.6 ms | 12.6 ms | 0.3 ms |
| Memory per row | **101 B** | 928 B | 1,229 B | 1,876 B | 2,031 B | 2,413 B | 166 B |
| JavaScript, gzip | **17.9 KB** | 6.8 KB | 20.6 KB | 26.2 KB | 68.4 KB | 28.4 KB | 1.1 KB |

Corten's rows are server-rendered `#[component(view)]` components, so taking them over is reading
the page rather than rebuilding it, and a row costs 101 bytes of JavaScript memory against
928-2,413 for the frameworks, which keep each row's data and bookkeeping in JavaScript. Its
takeover is the fastest of the frameworks in this round, but that is one round of a number that
has moved between runs before: round browser-2 measured 29.5 ms for Corten, and three reruns of
that step on one CPU model gave 4.9, 20.7 and 6.3 ms
([browser benchmark](../bench/browser/README.md#on-linux-against-the-most-used-frameworks-round-browser-3)).
It is also slower than in round browser-3 (2026-10-23, at `77002fe`): 10.2 ms against 6.0 then,
while Solid, Svelte, Vue, React and plain JavaScript took over faster in this round than in that
one (Solid 16.2 ms against 19.6) and Remix slower. Two things moved for Corten that did not for
most apps. On about half of its loads (and React's) a long frame rendered between parsing and the
app being ready (the server's rows painted first, or the app's own frames), which takeover leaves out; the median of that rendering, 58 ms, falls
between the loads with the frame and those without and is not the frame's length, where
browser-3's median was none for every app. And while every app was ready sooner after navigation
began than in browser-3 (Corten 105.6 to 89.0 ms, Svelte 123.5 to 39.6, Vue 125.2 to 42.2, plain
JavaScript 98.4 to 21.0), Corten's rank changed: it was ready before every other framework then
and after Svelte and Vue now. The two rounds ran on different CPUs (a Xeon Platinum 8280 then),
different Chromium versions (148 then) and different Corten runtimes, and they do not show which
of those slowed Corten's takeover. An A/B on one Intel Core i9-10885H laptop with browser-4's
Chromium (156.0.8078.4), `bench/browser/ssr.mjs` taking turns between browser-4's commit and
`77002fe`, measured part of it: takeover 4.24 ms slower (standard deviation 1.03) over 8 pairs of 30
loads and 2.96 ms slower (0.62) over 4 more, Solid -0.19 and -0.20 ms, and the runtime's own
evaluation at load, from performance marks in copies of the page over the loads with no long
frame, 9.4 ms against 5.9 (+3.5 ms, no spread recorded), spent in four startup steps that did work
nothing used or did it the slow way. Browser-4's median load had a long frame, on which takeover
reads about 9 ms higher, so part of 6.0 to 10.2 ms is probably that.
[#1246 Runtime: cut startup work on a long page (#1222)](https://github.com/corten-run/corten/pull/1246) cut that evaluation: in another session on the same laptop and Chromium, against a base
(`8c2a1b71`) with browser-4's runtime, evaluation fell 4.14 ms (standard deviation 0.16; base 10.15
ms, 9.90 to 10.70, against 6.00, 5.90 to 6.40, medians of 6 runs of 30 loads each), and the
takeover of the loads with no long frame 3.91 ms (standard deviation 2.40) over 8 pairs of 30
loads, with Solid, the control, at -0.31 ms (standard deviation 0.85). The two sessions measured
the same runtime at 9.4 and 10.15 ms, so their differences compare (+3.5 ms, then -4.14), not
their levels. The 10.2 ms above is browser-4's; the next browser round measures takeover again
([#1222 Taking over 1,000 server-rendered rows rose from 6.0 to 10.2 ms in round browser-4 while Solid's, Svelte's, Vue's and React's fell](https://github.com/corten-run/corten/issues/1222)). Its
JavaScript is the runtime, views and the page's handlers, 17.9 KB gzip, more than Solid's 6.8 KB
and less than the other frameworks'. Creating thousands of rows in the browser is where it trails
Solid and plain JavaScript (48.4 ms against 41.6 and 37.5 ms for 10,000). What is left is mostly
the cost of keeping each row's key and refs in the page, which is what makes takeover and memory
small ([profile](../bench/browser/README.md#creating-many-rows)).
