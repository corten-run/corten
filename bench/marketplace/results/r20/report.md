# Marketplace v2 r20

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

## Feature Qualification

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

## en-US

### Memory source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 182.00 [176.00-183.00] | 12.22 [11.82-13.41] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1004.00 [977.00-1020.00] | 293.51 [279.91-297.35] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [150.04-150.05] | 0.41 [0.30-0.42] | 0.52 [0.40-0.53] | 0.55 [0.45-0.57] | 3.38 [2.41-3.48] | 228.28 [165.36-234.59] | 11.39 [11.25-11.41] | 11.64 [11.60-11.65] | 4380.64 [4262.83-6047.27] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.04 [149.99-150.04] | 1.67 [1.44-1.98] | 2.81 [2.22-3.19] | 4.45 [3.57-4.53] | 29.81 [25.78-34.96] | 2016.14 [1728.19-2270.98] | 57.79 [57.56-58.42] | 58.81 [58.47-59.59] | 496.00 [440.34-578.64] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 20544.98 [19501.83-21843.88] | 2.20 [2.11-2.33] | 8.12 [7.36-8.34] | 13.93 [13.17-14.44] | 84.94 [84.75-86.55] | 41.58 [39.27-43.30] | 11.77 [11.66-11.77] | 12.16 [12.04-12.18] | 24049.29 [23096.93-25466.49] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1162.00 [1141.08-1198.85] | 56.49 [54.40-56.79] | 81.22 [78.33-85.47] | 108.03 [97.29-116.73] | 100.21 [100.08-100.24] | 859.11 [833.32-875.78] | 59.86 [59.77-59.98] | 61.08 [60.84-61.45] | 1164.00 [1141.84-1200.02] | 0.00 [0.00-0.00] |

Warning: corten fixture-en-US-page sat64 pass 1: app CPU 84.9%; saturation not demonstrated.

Warning: corten fixture-en-US-page sat64 pass 2: app CPU 84.7%; saturation not demonstrated.

Warning: corten fixture-en-US-page sat64 pass 3: app CPU 86.5%; saturation not demonstrated.

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 18327.11 [17688.88-18740.98] | 9.69 [7.67-9.92] | 28.46 [28.30-30.67] | 42.55 [41.05-43.19] | 88.26 [80.96-88.73] | 46.43 [43.92-49.38] | 13.98 [13.96-14.44] | 14.70 [14.60-15.22] | 21537.62 [20251.52-22770.60] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1695.97 [1686.24-1735.46] | 144.92 [144.19-145.12] | 239.97 [234.81-255.56] | 335.51 [324.88-340.95] | 100.02 [100.00-100.07] | 592.22 [575.65-595.78] | 69.89 [69.34-72.75] | 76.38 [76.24-77.96] | 1688.57 [1678.46-1737.16] | 0.00 [0.00-0.00] |

Warning: corten fixture-en-US-page sat256 pass 1: app CPU 81.0%; saturation not demonstrated.

Warning: corten fixture-en-US-page sat256 pass 2: app CPU 88.7%; saturation not demonstrated.

Warning: corten fixture-en-US-page sat256 pass 3: app CPU 88.3%; saturation not demonstrated.

### HTTP source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 159.00 [158.00-161.00] | 15.63 [14.08-18.05] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 917.00 [913.00-945.00] | 354.24 [345.03-355.04] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [150.04-150.06] | 0.61 [0.59-0.62] | 0.78 [0.74-0.79] | 0.87 [0.82-0.87] | 4.67 [4.66-4.82] | 317.44 [315.24-327.05] | 7.80 [7.52-8.10] | 8.13 [7.67-8.25] | 3150.16 [3057.68-3172.15] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.04 [150.04-150.04] | 2.08 [2.03-2.09] | 3.85 [3.79-3.90] | 5.88 [5.78-5.96] | 34.77 [34.49-35.14] | 2334.02 [2284.01-2373.34] | 52.12 [51.46-53.85] | 53.42 [52.40-54.70] | 428.44 [421.35-437.83] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 6696.24 [6220.59-7233.94] | 9.42 [7.68-10.54] | 13.29 [13.21-13.72] | 15.40 [15.37-15.85] | 101.91 [101.78-102.21] | 149.18 [138.00-160.59] | 9.60 [8.75-9.67] | 10.57 [9.17-10.70] | 6703.50 [6227.00-7246.26] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 705.68 [700.38-714.74] | 87.90 [86.89-88.26] | 115.94 [115.48-124.14] | 155.52 [153.91-158.50] | 100.30 [100.25-100.31] | 1415.90 [1397.43-1426.43] | 61.34 [61.21-61.81] | 64.04 [63.89-64.13] | 706.26 [701.05-715.60] | 0.00 [0.00-0.00] |

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 6053.80 [6025.90-6194.09] | 39.86 [38.07-40.29] | 73.92 [72.88-77.49] | 95.04 [91.48-103.12] | 102.25 [102.06-102.37] | 164.82 [161.00-165.59] | 26.88 [25.49-27.22] | 27.68 [25.99-27.81] | 6067.33 [6038.84-6211.14] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 725.17 [718.75-789.07] | 337.30 [325.36-341.10] | 457.35 [438.56-474.16] | 550.48 [495.58-552.67] | 100.16 [100.04-100.18] | 1375.13 [1266.70-1390.28] | 77.87 [77.50-78.10] | 82.20 [81.63-83.38] | 727.20 [719.28-789.45] | 0.00 [0.00-0.00] |

## fr-FR

### Memory source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 186.00 [174.00-190.00] | 12.02 [11.60-12.04] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 955.00 [937.00-962.00] | 268.78 [267.31-281.37] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [149.99-150.05] | 0.32 [0.29-0.32] | 0.42 [0.39-0.43] | 0.46 [0.44-0.49] | 2.61 [2.47-2.61] | 177.77 [169.18-178.21] | 11.30 [11.28-11.40] | 11.61 [11.59-11.62] | 5625.14 [5611.24-5910.88] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.03 [149.98-150.04] | 1.42 [1.36-1.51] | 2.41 [2.32-2.45] | 3.67 [3.63-3.71] | 26.07 [23.97-26.79] | 1740.66 [1656.08-1785.59] | 58.39 [57.18-58.48] | 59.46 [58.22-59.66] | 574.49 [560.04-603.84] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 21574.14 [21427.51-21699.30] | 2.13 [2.09-2.13] | 7.76 [7.64-7.86] | 14.00 [13.66-14.05] | 85.68 [84.38-86.13] | 39.41 [38.72-39.77] | 11.62 [11.58-11.80] | 12.11 [12.03-12.21] | 25375.34 [25143.48-25826.66] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1394.34 [1184.67-1409.83] | 43.83 [40.49-54.15] | 80.09 [69.79-80.67] | 101.83 [93.25-111.34] | 100.17 [100.16-100.22] | 720.39 [708.73-843.41] | 61.59 [59.00-62.04] | 65.26 [60.31-65.81] | 1388.13 [1185.66-1410.98] | 0.00 [0.00-0.00] |

Warning: corten fixture-fr-FR-page sat64 pass 1: app CPU 86.1%; saturation not demonstrated.

Warning: corten fixture-fr-FR-page sat64 pass 2: app CPU 85.7%; saturation not demonstrated.

Warning: corten fixture-fr-FR-page sat64 pass 3: app CPU 84.4%; saturation not demonstrated.

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 18678.02 [17981.71-20018.30] | 9.24 [7.89-11.24] | 29.15 [27.94-29.58] | 39.95 [39.55-41.49] | 89.95 [86.54-94.32] | 47.63 [43.14-51.25] | 14.13 [14.01-14.19] | 14.89 [14.81-15.16] | 20997.05 [19513.95-23177.79] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1965.97 [1806.52-2232.62] | 120.51 [107.04-128.66] | 212.12 [199.66-245.35] | 305.46 [289.32-312.61] | 100.10 [100.08-100.13] | 507.90 [446.50-552.22] | 74.40 [74.02-75.12] | 78.12 [77.06-78.93] | 1968.91 [1810.87-2239.62] | 0.00 [0.00-0.00] |

Warning: corten fixture-fr-FR-page sat256 pass 1: app CPU 94.3%; saturation not demonstrated.

Warning: corten fixture-fr-FR-page sat256 pass 2: app CPU 86.5%; saturation not demonstrated.

Warning: corten fixture-fr-FR-page sat256 pass 3: app CPU 90.0%; saturation not demonstrated.

### HTTP source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 158.00 [156.00-166.00] | 17.56 [14.84-20.64] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 930.00 [923.00-931.00] | 352.25 [351.71-359.60] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [150.05-150.05] | 0.58 [0.58-0.58] | 0.73 [0.73-0.74] | 0.81 [0.80-0.85] | 4.47 [4.34-4.57] | 301.79 [298.97-312.15] | 7.75 [7.32-7.99] | 8.16 [7.53-8.36] | 3313.55 [3203.62-3344.79] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.03 [149.99-150.03] | 2.12 [2.03-2.76] | 3.87 [3.78-4.81] | 6.13 [5.81-7.08] | 34.11 [33.38-44.39] | 2308.15 [2269.93-2928.86] | 51.17 [50.14-51.73] | 52.54 [51.57-53.14] | 433.25 [341.43-440.54] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 7523.12 [6830.80-7734.14] | 7.81 [7.58-8.42] | 13.22 [12.48-13.29] | 15.43 [15.18-15.45] | 101.92 [101.73-101.99] | 132.82 [129.20-146.22] | 9.58 [8.73-10.08] | 10.59 [9.29-11.01] | 7528.73 [6838.83-7739.86] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 667.03 [633.82-688.51] | 91.01 [89.55-97.63] | 135.30 [125.36-149.90] | 156.26 [153.93-175.66] | 100.31 [100.25-100.31] | 1522.48 [1457.71-1576.64] | 59.74 [59.21-60.04] | 62.05 [62.04-63.97] | 656.82 [634.26-686.01] | 0.00 [0.00-0.00] |

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 6251.80 [6146.12-6360.60] | 38.70 [38.20-39.48] | 70.37 [69.26-75.36] | 87.56 [86.33-100.04] | 102.27 [102.17-102.36] | 159.57 [156.72-162.31] | 25.48 [25.47-28.58] | 26.06 [26.04-29.32] | 6266.87 [6161.20-6380.79] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 752.95 [683.60-883.89] | 337.79 [274.50-364.63] | 470.93 [384.56-491.83] | 525.49 [409.98-554.65] | 100.16 [100.09-100.22] | 1332.66 [1148.80-1463.59] | 79.24 [79.12-80.83] | 83.77 [81.88-86.30] | 750.38 [683.25-870.47] | 0.00 [0.00-0.00] |

## de-DE

### Memory source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 183.00 [182.00-192.00] | 12.10 [11.53-14.62] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 980.00 [961.00-1020.00] | 284.72 [271.54-294.73] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [150.05-150.05] | 0.31 [0.30-0.37] | 0.40 [0.40-0.50] | 0.46 [0.45-0.55] | 2.55 [2.52-3.03] | 175.30 [175.16-201.45] | 11.27 [11.26-11.31] | 11.59 [11.55-11.61] | 5704.50 [4964.10-5709.01] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.04 [150.04-150.05] | 1.45 [1.44-1.74] | 2.18 [2.12-2.69] | 3.53 [3.43-3.86] | 26.02 [25.58-29.75] | 1709.51 [1696.21-2063.47] | 58.35 [57.74-58.53] | 59.20 [58.68-59.82] | 584.96 [484.62-589.55] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 20950.93 [19790.66-21588.27] | 2.21 [2.15-2.45] | 7.76 [7.50-7.81] | 13.48 [13.34-13.89] | 87.10 [86.64-88.40] | 41.03 [39.95-44.08] | 11.69 [11.63-11.70] | 12.05 [11.96-12.20] | 24372.74 [22687.43-25034.06] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1222.76 [1133.35-1352.82] | 54.24 [43.76-58.78] | 77.62 [71.62-82.83] | 108.24 [99.19-111.63] | 100.21 [100.14-100.24] | 822.15 [743.36-886.98] | 59.90 [58.90-60.96] | 60.88 [60.46-64.89] | 1216.33 [1127.43-1345.24] | 0.00 [0.00-0.00] |

Warning: corten fixture-de-DE-page sat64 pass 1: app CPU 86.6%; saturation not demonstrated.

Warning: corten fixture-de-DE-page sat64 pass 2: app CPU 88.4%; saturation not demonstrated.

Warning: corten fixture-de-DE-page sat64 pass 3: app CPU 87.1%; saturation not demonstrated.

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 18963.24 [16029.96-19093.67] | 9.30 [8.80-13.82] | 28.12 [27.27-31.49] | 41.27 [40.32-42.61] | 89.62 [86.73-95.06] | 46.33 [44.86-58.61] | 14.24 [14.11-14.24] | 15.02 [14.93-15.03] | 21584.83 [17062.17-22292.20] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1825.80 [1797.82-2027.30] | 129.67 [114.20-135.86] | 231.82 [225.27-242.89] | 314.01 [264.82-314.07] | 100.11 [100.08-100.15] | 547.15 [491.79-555.22] | 73.33 [72.10-76.29] | 77.37 [76.52-78.56] | 1827.65 [1801.08-2033.40] | 0.00 [0.00-0.00] |

Warning: corten fixture-de-DE-page sat256 pass 1: app CPU 89.6%; saturation not demonstrated.

Warning: corten fixture-de-DE-page sat256 pass 3: app CPU 86.7%; saturation not demonstrated.

### HTTP source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 158.00 [156.00-166.00] | 17.30 [15.73-19.66] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 946.00 [935.00-1010.00] | 362.37 [358.27-378.88] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [149.98-150.05] | 0.58 [0.58-0.86] | 0.73 [0.72-1.04] | 0.81 [0.79-1.10] | 4.44 [4.38-6.49] | 304.61 [297.85-436.19] | 7.61 [7.58-7.86] | 8.05 [7.87-8.10] | 3282.86 [2292.56-3357.41] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.01 [149.99-150.03] | 2.14 [2.13-2.76] | 4.14 [4.07-4.79] | 6.79 [6.47-7.43] | 36.43 [36.35-44.84] | 2454.48 [2433.41-3087.98] | 51.75 [51.46-56.44] | 53.00 [52.61-58.34] | 407.42 [323.84-410.95] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 6888.38 [6844.66-7175.67] | 8.12 [7.80-8.47] | 13.30 [13.28-13.85] | 15.46 [15.21-16.53] | 101.95 [101.90-102.10] | 145.02 [139.30-145.88] | 8.89 [8.58-9.41] | 9.50 [9.26-10.22] | 6895.84 [6855.03-7178.91] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 694.48 [694.24-788.90] | 89.52 [75.27-90.23] | 120.07 [117.71-120.72] | 151.63 [146.19-156.72] | 100.28 [100.27-100.34] | 1438.86 [1281.30-1439.09] | 61.58 [60.86-62.82] | 63.71 [63.68-63.97] | 695.00 [694.88-780.45] | 0.00 [0.00-0.00] |

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 6104.89 [6062.51-6486.96] | 39.76 [37.02-40.22] | 71.34 [70.94-74.34] | 91.54 [89.27-94.37] | 102.06 [102.01-102.21] | 163.52 [153.83-164.64] | 29.95 [27.42-30.23] | 30.74 [28.18-31.04] | 6115.49 [6073.94-6500.67] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 753.78 [706.52-997.30] | 342.14 [237.16-349.37] | 458.25 [377.98-472.66] | 534.08 [412.28-587.27] | 100.21 [100.13-100.22] | 1324.72 [1016.41-1412.83] | 77.17 [74.29-86.54] | 81.61 [80.68-90.59] | 754.88 [707.80-983.85] | 0.00 [0.00-0.00] |

## Locale-neutral JSON

### Memory source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 184.00 [177.00-192.00] | 12.37 [12.37-13.15] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 860.00 [808.00-869.00] | 142.45 [137.66-158.93] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 149.99 [149.99-150.05] | 0.27 [0.27-0.31] | 0.37 [0.36-0.44] | 0.42 [0.40-0.49] | 1.98 [1.89-2.28] | 136.06 [130.29-157.91] | 10.67 [10.63-10.69] | 10.94 [10.76-10.98] | 7349.91 [6332.80-7675.05] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.04 [149.99-150.05] | 0.64 [0.57-0.82] | 0.90 [0.75-1.05] | 2.62 [2.62-2.91] | 13.49 [12.28-17.58] | 880.07 [870.35-1108.15] | 49.56 [49.46-51.73] | 51.85 [50.93-53.28] | 1136.27 [902.41-1148.96] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 22218.09 [21286.85-23037.44] | 1.98 [1.84-2.05] | 7.76 [7.62-8.30] | 13.22 [12.91-14.38] | 66.26 [65.23-78.45] | 30.92 [28.56-35.06] | 10.85 [10.85-11.07] | 11.31 [11.30-11.63] | 32345.84 [28524.10-35017.67] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 12547.87 [12522.61-12703.27] | 4.10 [4.10-4.48] | 10.32 [9.97-10.75] | 15.50 [14.73-16.18] | 99.64 [99.38-99.82] | 78.79 [77.73-79.26] | 56.44 [55.31-60.20] | 57.57 [57.50-61.06] | 12692.59 [12616.69-12864.28] | 0.00 [0.00-0.00] |

Warning: corten fixture-neutral-json sat64 pass 1: app CPU 78.5%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat64 pass 2: app CPU 65.2%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat64 pass 3: app CPU 66.3%; saturation not demonstrated.

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 20952.81 [19994.23-21455.74] | 8.22 [7.83-8.26] | 26.03 [24.63-27.13] | 37.55 [37.22-40.49] | 77.39 [76.52-81.29] | 38.09 [36.01-38.76] | 13.15 [12.99-13.16] | 13.51 [13.51-13.79] | 26250.80 [25800.65-27769.96] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 13816.79 [13203.54-13942.92] | 16.78 [16.45-17.56] | 33.74 [33.05-35.07] | 46.68 [46.67-48.58] | 98.87 [98.68-98.98] | 71.19 [70.26-74.45] | 59.27 [58.64-62.44] | 59.74 [59.14-63.00] | 14045.97 [13431.64-14232.83] | 0.00 [0.00-0.00] |

Warning: corten fixture-neutral-json sat256 pass 1: app CPU 77.4%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat256 pass 2: app CPU 76.5%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat256 pass 3: app CPU 81.3%; saturation not demonstrated.

### HTTP source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 163.00 [161.00-165.00] | 13.71 [13.58-14.02] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 792.00 [792.00-823.00] | 225.21 [215.36-225.79] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 150.05 [149.99-150.05] | 0.60 [0.54-0.80] | 0.76 [0.69-0.96] | 0.82 [0.76-1.02] | 4.22 [3.83-5.54] | 286.50 [260.95-375.16] | 7.35 [6.56-7.36] | 7.64 [7.04-7.68] | 3490.44 [2665.51-3832.21] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.03 [150.02-150.04] | 1.27 [1.19-1.74] | 2.32 [1.97-2.68] | 5.15 [4.97-5.20] | 21.33 [21.28-27.21] | 1446.30 [1431.08-1788.05] | 44.22 [43.90-46.60] | 47.75 [46.80-50.09] | 691.42 [559.27-698.77] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 8465.41 [7546.34-8486.89] | 6.58 [6.42-7.97] | 11.43 [11.07-12.47] | 15.89 [15.10-17.11] | 101.46 [101.46-101.67] | 117.74 [117.42-131.97] | 9.44 [8.59-9.62] | 10.23 [9.08-10.42] | 8493.13 [7577.40-8516.78] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1797.66 [1576.30-1892.03] | 34.35 [33.74-38.42] | 46.66 [46.54-59.79] | 59.99 [57.42-74.60] | 100.49 [100.40-100.51] | 568.40 [531.23-637.70] | 52.26 [51.92-54.51] | 56.89 [53.36-60.30] | 1759.31 [1568.13-1882.43] | 0.00 [0.00-0.00] |

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten 0.1 (Rust, axum, html! views) | 7265.19 [7216.04-7921.54] | 31.30 [25.03-31.45] | 65.19 [63.46-66.30] | 81.53 [80.79-83.99] | 102.03 [101.90-102.15] | 137.39 [125.97-138.29] | 27.00 [24.81-29.41] | 27.65 [25.30-29.86] | 7278.57 [7230.98-7938.59] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 3743.84 [2953.02-4053.72] | 58.45 [56.99-82.00] | 119.72 [104.72-133.05] | 143.68 [121.86-157.89] | 100.60 [100.58-100.63] | 266.83 [250.24-338.08] | 65.01 [63.86-66.46] | 69.29 [66.23-71.05] | 3747.71 [2957.92-3996.24] | 0.00 [0.00-0.00] |

## Limits

single Node process, even with a two-CPU quota; high upstream CPU can limit API-mode throughput; closed-loop VUs alone do not prove app saturation
cgroup v2 usage_usec before/after docker start -a of k6; includes small Docker command/idle windows, not only HTTP handler CPU
