# Marketplace v2 r84

Commit: `28cdc5bc7ec3a48cb0db7288f9d448becfdff81f`. Schema: `marketplace-results/v6`. CPU: Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz (online CPUs 0-7).
Group: localized-marketplace. Measured adapters: corten, nextjs, aspnet, django, topcoat, leptos, gin, drogon. Omitted adapters were not tested; this is not a ranking of the full inventory.
Omitted adapters: tanstack-start, sveltekit, react-router, rails, laravel, spring, phoenix, astro, nuxt, axum-maud, fastapi, express.
A new localized baseline, not a change from marketplace r16 or catalog c1.
Corten was built from the measured checkout above (the locked `corten-run` crate is 0.2.0).

Every number is the median [min-max] of three measured passes, not a confidence interval, except in a row marked stopped, which has fewer: of two passes each number is the lower of the two values in its column, of one pass that pass. Overlapping ranges do not establish a speed difference.
Timed page requests rotate through en-US/fr-FR/de-DE; each source reports one combined result, not per-locale throughput. The cold page probe uses en-US. JSON is locale-neutral and timed once per source/pass. Every measured adapter passes both sources and twelve browser profiles before any load.
Fixed load asks for 150 requests/second. Closed-loop 64/256-user results are observed throughput and latency, not proven maximum capacity. Warmup 10s; each phase 15s; identity encoding.
CPU % is sampled app-container usage (100% = one core). CPU us/request and requests/CPU-second use counted whole-container cgroup CPU, not instructions or handler-only time. CPU % and steady memory average the central 15%-95% of samples; peak memory is the sampled maximum, not an unsampled high-water mark.
The sealed resource binding assigns the app one CPU (logical CPU 1), the upstream two (2-3), and the load generator four (4-7). Their memory limits are 1 GiB, 512 MiB, and 2 GiB, respectively.
These load results do not measure browser interactivity, bytes, build cost or instructions.
A stage marked * is the app's measured outcome under this profile: some requests got an answer other than 200 or timed out (10 s), or the fixed rate could not be started. It is recorded, not retried, and the later phases still ran. Its req/s, latency percentiles and requests/CPU-second count every request sent, failed ones included.
A stage marked (stopped: n of 3 passes) is also the app's outcome: its container exited or was OOM-killed during a load phase (warmup included), and the line below the table says when. That profile's later phases and passes were not run, so the stage's numbers come from the n passes before the stop, or none. A 200 of the wrong content type, an app that stopped during its cold start or before a phase began, or an upstream error fails the run instead.

Feature contract: marketplace-production/v2. Popular and performance-oriented candidate cohorts are deduplicated; candidates are not a current speed ranking. ETag/conditional GET and downstream readiness are not required by this workload, and are not claimed equivalent. Logging remains native, not normalized.

Connection-flood resistance: not measured.
The bounded gate also does not assess incomplete request headers, oversized requests or downstream deadlines.

## Feature Qualification

| Candidate | Result | Missing required work |
|---|---|---|
| corten | admitted | none |
| nextjs | admitted | none |
| aspnet | admitted | none |
| django | admitted | none |
| topcoat | admitted | none |
| leptos | admitted | none |
| gin | admitted | none |
| drogon | admitted | none |

Warning: Short 15s phase windows (10s warmup): variability and sampling limits matter; not comparable to manual 60s phases with 30s warmup.

## Rotating pages (en-US/fr-FR/de-DE)

### Memory source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten (Rust, Hyper, html! views) | 171.00 [171.00-182.00] | 12.97 [11.13-13.14] |
| Next.js 16.4 (Pages Router, React SSR) | 800.00 [779.00-811.00] | 119.94 [86.50-129.81] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 858.00 [828.00-877.00] | 232.70 [228.26-241.99] |
| Django 6.1 (Python, gunicorn, htmx) | 3291.00 [3109.00-3303.00] | 38.84 [37.78-38.86] |
| Topcoat 0.11 (Rust, view! components, shards) | 180.00 [165.00-181.00] | 13.75 [13.67-18.65] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 173.00 [170.00-173.00] | 13.43 [11.97-13.52] |
| Gin 1.12 (Go, templ, htmx) | 333.00 [331.00-345.00] | 12.87 [11.41-15.21] |
| Drogon 1.9 (C++, CSP views, htmx) | 353.00 [347.00-357.00] | 12.11 [11.73-12.86] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 150.06 [150.05-150.06] | 0.19 [0.18-0.24] | 0.26 [0.25-0.33] | 0.39 [0.33-0.39] | 1.56 [1.43-1.91] | 107.52 [100.94-130.63] | 11.31 [11.22-11.41] | 11.60 [11.39-11.67] | 9301.00 [7655.37-9906.70] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) | 150.04 [150.04-150.04] | 1.67 [1.62-1.93] | 3.30 [2.60-3.35] | 23.24 [22.03-30.14] | 32.42 [32.04-35.23] | 2138.13 [2126.93-2374.91] | 123.86 [121.92-129.22] | 125.50 [124.30-132.00] | 467.70 [421.07-470.16] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.04 [150.04-150.04] | 1.55 [1.31-1.69] | 2.13 [1.91-2.24] | 3.21 [2.73-3.61] | 27.29 [23.42-29.38] | 1791.43 [1522.79-1896.35] | 56.66 [56.60-58.32] | 58.03 [57.63-59.63] | 558.21 [527.33-656.69] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 150.02 [149.99-150.02] | 3.77 [3.65-3.79] | 4.68 [4.41-6.41] | 6.99 [6.36-7.67] | 57.62 [56.25-58.00] | 3812.56 [3729.48-3828.00] | 106.87 [106.74-106.94] | 107.20 [107.20-107.30] | 262.29 [261.23-268.13] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 150.05 [149.99-150.06] | 0.31 [0.31-0.36] | 0.42 [0.38-0.46] | 0.49 [0.42-0.54] | 3.43 [3.43-3.79] | 233.24 [231.61-258.71] | 13.57 [13.48-13.58] | 14.09 [13.82-14.09] | 4287.51 [3865.39-4317.52] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 150.05 [149.99-150.05] | 0.60 [0.59-0.70] | 0.84 [0.69-0.90] | 0.93 [0.87-1.13] | 8.00 [7.75-9.06] | 536.45 [519.27-608.88] | 13.62 [13.61-13.67] | 13.99 [13.73-14.01] | 1864.12 [1642.35-1925.78] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 150.05 [149.98-150.05] | 0.51 [0.48-0.57] | 0.69 [0.63-0.74] | 1.15 [1.14-1.22] | 8.34 [7.79-8.91] | 557.88 [526.57-594.40] | 20.76 [20.63-20.86] | 21.27 [20.99-21.27] | 1792.51 [1682.38-1899.07] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) | 150.05 [150.05-150.05] | 0.53 [0.52-0.55] | 0.62 [0.60-0.70] | 0.81 [0.80-0.88] | 6.70 [6.51-6.86] | 446.68 [437.57-457.82] | 54.60 [54.57-54.62] | 54.94 [54.90-54.98] | 2238.73 [2184.26-2285.35] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 21214.51 [20845.48-21335.98] | 2.24 [2.09-2.38] | 7.79 [7.74-7.98] | 13.16 [13.15-13.22] | 79.46 [74.88-81.75] | 37.16 [35.27-39.16] | 11.86 [11.72-11.91] | 12.39 [12.26-12.46] | 26911.67 [25533.55-28354.53] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) | 498.31 [487.91-504.89] | 112.94 [111.54-115.26] | 176.43 [176.32-185.42] | 208.36 [198.62-216.81] | 100.56 [100.51-100.56] | 2005.86 [1982.09-2056.49] | 133.12 [132.91-139.26] | 136.20 [134.20-140.30] | 498.54 [486.26-504.52] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 911.43 [905.81-966.83] | 66.97 [63.04-67.29] | 110.98 [104.66-118.50] | 128.72 [122.17-138.37] | 100.19 [100.16-100.21] | 1103.27 [1033.94-1105.20] | 61.53 [60.59-62.90] | 63.26 [61.59-63.54] | 906.40 [904.81-967.17] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 265.18 [264.68-276.98] | 237.27 [230.79-239.53] | 258.12 [240.68-269.59] | 277.30 [244.40-290.98] | 100.51 [100.51-100.59] | 3769.43 [3608.66-3776.55] | 105.38 [105.19-105.52] | 106.70 [106.40-106.80] | 265.29 [264.79-277.11] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 7574.41 [7346.56-8110.00] | 7.48 [7.21-7.63] | 15.65 [14.28-16.28] | 17.98 [17.85-18.46] | 101.53 [101.32-101.58] | 131.92 [123.20-135.95] | 13.68 [13.67-13.79] | 14.08 [14.00-14.14] | 7580.43 [7355.79-8116.76] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 2516.91 [2443.32-2553.72] | 24.62 [23.44-26.05] | 35.26 [34.10-37.87] | 41.72 [41.27-43.94] | 100.69 [100.60-100.78] | 397.19 [391.53-409.19] | 13.84 [13.79-14.08] | 14.24 [14.14-14.26] | 2517.66 [2443.86-2554.09] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 2051.68 [2046.36-2117.32] | 32.89 [31.64-33.27] | 53.60 [52.82-54.35] | 61.39 [60.51-63.39] | 102.33 [101.79-102.49] | 486.96 [471.89-488.24] | 18.89 [18.75-18.94] | 20.52 [20.20-20.52] | 2053.57 [2048.17-2119.15] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) | 2767.31 [2652.61-2851.24] | 20.12 [19.65-23.80] | 31.34 [31.05-31.99] | 39.99 [39.30-46.04] | 101.74 [101.54-102.17] | 361.16 [350.36-376.90] | 54.93 [54.91-55.10] | 55.49 [55.25-55.52] | 2768.84 [2653.24-2854.17] | 0.00 [0.00-0.00] |

Warning: corten fixture-rotating-page sat64 pass 1: app CPU 74.9%; saturation not demonstrated.

Warning: corten fixture-rotating-page sat64 pass 2: app CPU 81.7%; saturation not demonstrated.

Warning: corten fixture-rotating-page sat64 pass 3: app CPU 79.5%; saturation not demonstrated.

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 19284.37 [18695.32-19831.98] | 7.53 [7.40-10.41] | 25.46 [24.65-27.70] | 38.18 [37.93-38.46] | 78.45 [73.85-93.39] | 40.83 [39.23-48.04] | 14.16 [14.12-14.46] | 15.53 [14.54-15.85] | 24491.92 [20815.30-25492.39] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) * (3 of 3 passes) | 477.39 [452.35-480.69] | 169.31 [164.69-363.66] | 1242.64 [526.90-1244.20] | 9989.90 [9980.52-9999.75] | 100.54 [100.44-100.56] | 2094.30 [2076.35-2209.26] | 147.17 [142.28-155.97] | 149.00 [148.00-163.50] | 477.49 [452.64-481.61] | 2.09 [1.17-2.10] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1182.74 [1063.86-1835.11] | 208.20 [126.13-238.49] | 352.12 [255.40-372.94] | 426.72 [341.03-460.97] | 100.13 [100.10-100.15] | 844.22 [553.86-939.15] | 69.24 [67.12-79.09] | 70.53 [68.18-82.67] | 1184.53 [1064.80-1805.52] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 267.14 [258.96-267.90] | 957.71 [947.59-975.06] | 1019.35 [979.52-1050.00] | 1037.29 [984.98-1059.05] | 100.49 [100.47-100.55] | 3738.95 [3731.48-3859.95] | 111.19 [111.09-111.24] | 111.70 [111.50-111.80] | 267.45 [259.07-267.99] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 6832.79 [6791.99-6946.36] | 33.43 [32.62-33.95] | 67.78 [67.58-67.90] | 74.54 [74.04-75.12] | 101.57 [101.45-101.59] | 146.15 [143.81-147.17] | 19.68 [19.52-19.74] | 20.18 [19.89-20.19] | 6842.25 [6794.70-6953.54] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 2232.70 [2174.11-2264.55] | 115.29 [114.90-117.49] | 178.50 [175.82-179.69] | 199.10 [196.76-199.51] | 101.08 [100.84-101.09] | 447.66 [441.23-459.47] | 25.52 [25.43-26.62] | 26.04 [25.88-27.10] | 2233.82 [2176.43-2266.41] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 1950.59 [1949.67-2157.74] | 157.26 [140.17-160.17] | 201.97 [190.14-203.70] | 213.09 [210.89-221.51] | 102.36 [102.35-102.63] | 511.90 [462.88-512.27] | 26.03 [26.03-26.18] | 26.44 [26.07-26.44] | 1953.52 [1952.08-2160.40] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) * (2 of 3 passes) | 2813.77 [2751.71-2930.14] | 74.67 [69.60-78.01] | 101.42 [101.36-120.43] | 126.47 [122.63-131.36] | 101.84 [101.62-102.23] | 355.29 [340.64-363.10] | 55.97 [55.97-56.27] | 56.92 [56.80-56.96] | 2814.57 [2754.07-2935.68] | 0.04 [0.00-0.04] |

Warning: corten fixture-rotating-page sat256 pass 1: app CPU 73.9%; saturation not demonstrated.

Warning: corten fixture-rotating-page sat256 pass 2: app CPU 78.4%; saturation not demonstrated.

Warning: corten fixture-rotating-page sat256 pass 3: app CPU 93.4%; saturation not demonstrated.

App outcome: nextjs fixture-rotating-page sat256 pass 1: 83 of 7099 requests failed (1.17%), 0 fixed-rate iterations dropped, 83 checks failed.

App outcome: nextjs fixture-rotating-page sat256 pass 2: 159 of 7606 requests failed (2.09%), 0 fixed-rate iterations dropped, 159 checks failed.

App outcome: nextjs fixture-rotating-page sat256 pass 3: 159 of 7569 requests failed (2.10%), 0 fixed-rate iterations dropped, 159 checks failed.

App outcome: drogon fixture-rotating-page sat256 pass 1: 16 of 41507 requests failed (0.04%), 0 fixed-rate iterations dropped, 16 checks failed.

App outcome: drogon fixture-rotating-page sat256 pass 2: 16 of 42445 requests failed (0.04%), 0 fixed-rate iterations dropped, 16 checks failed.

### HTTP source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten (Rust, Hyper, html! views) | 174.00 [165.00-177.00] | 16.63 [15.43-17.71] |
| Next.js 16.4 (Pages Router, React SSR) | 736.00 [728.00-776.00] | 131.11 [129.09-142.91] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 806.00 [794.00-845.00] | 294.22 [292.15-307.22] |
| Django 6.1 (Python, gunicorn, htmx) | 3036.00 [2910.00-3089.00] | 41.70 [41.37-44.05] |
| Topcoat 0.11 (Rust, view! components, shards) | 175.00 [163.00-187.00] | 13.67 [12.52-16.01] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 168.00 [165.00-175.00] | 14.84 [13.89-17.89] |
| Gin 1.12 (Go, templ, htmx) | 165.00 [158.00-171.00] | 16.32 [13.11-16.70] |
| Drogon 1.9 (C++, CSP views, htmx) | 172.00 [168.00-178.00] | 15.42 [15.18-17.40] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 150.05 [149.99-150.06] | 0.37 [0.37-0.47] | 0.48 [0.47-0.62] | 0.59 [0.56-0.73] | 3.09 [2.88-3.76] | 213.05 [202.88-256.56] | 7.17 [7.11-7.96] | 7.42 [7.37-8.19] | 4693.71 [3897.69-4928.90] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) | 150.04 [149.99-150.04] | 2.23 [2.23-2.47] | 9.48 [6.23-11.64] | 40.74 [35.50-42.95] | 43.20 [41.63-45.08] | 2884.26 [2777.76-3013.64] | 114.17 [113.69-124.77] | 115.80 [115.70-126.50] | 346.71 [331.82-360.00] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.04 [149.99-150.04] | 1.98 [1.92-2.25] | 3.37 [3.15-3.60] | 4.49 [3.93-4.78] | 33.01 [31.55-36.87] | 2194.09 [2097.23-2407.97] | 56.00 [50.40-56.82] | 56.95 [51.67-57.88] | 455.77 [415.29-476.82] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 150.01 [150.01-150.01] | 4.74 [4.64-4.97] | 8.17 [6.09-8.91] | 21.91 [18.37-24.88] | 70.47 [69.58-73.12] | 4730.88 [4667.88-4873.43] | 96.80 [96.46-97.06] | 97.24 [96.70-97.33] | 211.38 [205.19-214.23] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 149.99 [149.99-150.05] | 0.58 [0.52-0.63] | 0.76 [0.64-0.83] | 0.87 [0.76-1.03] | 5.72 [5.27-6.38] | 393.19 [356.62-429.62] | 9.50 [9.11-9.59] | 9.92 [9.47-10.16] | 2543.31 [2327.64-2804.12] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 150.05 [150.04-150.05] | 0.73 [0.71-0.87] | 0.92 [0.84-1.18] | 1.23 [1.01-1.42] | 8.46 [8.36-10.28] | 570.78 [565.75-688.54] | 9.45 [9.43-9.70] | 9.96 [9.90-10.08] | 1751.99 [1452.35-1767.56] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 149.99 [149.99-150.05] | 0.77 [0.76-0.86] | 1.13 [1.03-1.17] | 1.54 [1.48-1.61] | 11.33 [11.23-12.10] | 764.61 [757.65-821.80] | 12.97 [12.84-12.98] | 13.58 [13.40-13.62] | 1307.85 [1216.85-1319.88] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) | 150.05 [150.05-150.05] | 0.96 [0.96-1.05] | 1.24 [1.05-1.35] | 1.54 [1.23-1.66] | 13.96 [13.50-14.88] | 933.10 [902.91-987.62] | 9.50 [9.44-9.54] | 9.72 [9.66-9.93] | 1071.70 [1012.54-1107.53] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 8696.37 [7647.34-8867.50] | 6.42 [6.14-8.62] | 11.29 [10.57-11.55] | 14.49 [14.41-15.17] | 101.33 [101.21-101.71] | 114.42 [112.18-130.39] | 9.30 [8.96-11.05] | 9.91 [9.71-12.05] | 8739.63 [7669.53-8913.87] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) | 340.60 [338.61-347.36] | 177.54 [172.79-178.21] | 239.27 [227.04-240.98] | 258.40 [258.18-309.32] | 100.43 [100.37-100.53] | 2934.20 [2877.61-2956.92] | 124.19 [121.93-127.78] | 126.20 [124.80-129.40] | 340.81 [338.19-347.51] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 607.52 [590.51-624.67] | 101.17 [100.08-104.78] | 139.63 [128.58-142.47] | 162.56 [149.68-167.05] | 100.23 [100.23-100.30] | 1645.51 [1599.73-1691.49] | 61.01 [56.05-61.02] | 63.06 [59.84-64.55] | 607.71 [591.20-625.11] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 211.75 [205.51-215.42] | 300.56 [294.09-307.55] | 325.23 [319.93-337.81] | 348.83 [334.25-360.96] | 100.57 [100.54-100.59] | 4721.16 [4639.74-4865.00] | 96.14 [95.96-96.28] | 96.93 [96.93-97.05] | 211.81 [205.55-215.53] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 4108.41 [3687.31-4362.78] | 15.26 [13.87-17.20] | 23.64 [23.02-25.15] | 28.33 [27.14-28.39] | 101.49 [101.43-101.70] | 243.32 [229.13-271.08] | 9.52 [9.35-10.47] | 10.11 [9.78-11.30] | 4109.82 [3688.91-4364.40] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 2135.33 [1913.61-2238.07] | 30.89 [28.49-34.02] | 35.07 [33.86-38.81] | 42.67 [37.50-43.43] | 101.51 [101.47-101.71] | 467.71 [446.69-522.41] | 10.11 [9.93-10.30] | 10.77 [10.27-11.00] | 2138.08 [1914.22-2238.71] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 1463.93 [1307.87-1477.36] | 41.78 [41.69-47.06] | 73.69 [72.86-83.44] | 88.15 [86.07-97.55] | 102.00 [101.92-102.13] | 682.83 [676.51-764.06] | 12.26 [12.26-12.72] | 12.88 [12.71-14.20] | 1464.49 [1308.80-1478.17] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) | 1262.69 [1218.79-1266.19] | 51.06 [49.81-52.21] | 70.62 [70.00-74.50] | 80.97 [78.39-81.26] | 100.91 [100.89-101.17] | 791.93 [789.76-820.41] | 11.31 [11.28-11.38] | 12.09 [11.99-12.27] | 1262.74 [1218.91-1266.21] | 0.00 [0.00-0.00] |

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 7926.39 [6960.75-8081.47] | 26.75 [26.49-32.30] | 64.27 [63.89-69.00] | 81.60 [81.22-87.44] | 102.00 [101.80-102.25] | 125.90 [123.42-143.45] | 31.85 [27.68-33.52] | 33.92 [28.24-35.18] | 7942.73 [6971.30-8102.62] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) * (3 of 3 passes) | 343.82 [343.23-354.77] | 341.68 [332.18-345.55] | 5346.46 [5049.87-5482.28] | 9980.98 [9973.65-9999.03] | 100.29 [100.19-100.36] | 2904.22 [2813.69-2908.41] | 126.10 [123.52-134.56] | 133.70 [125.60-144.40] | 344.33 [343.83-355.40] | 2.20 [2.18-2.21] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 619.87 [591.72-633.26] | 397.09 [392.99-416.65] | 498.39 [475.61-549.96] | 609.25 [545.15-610.44] | 100.13 [100.06-100.16] | 1616.71 [1612.37-1686.98] | 76.71 [76.48-78.36] | 82.87 [79.76-84.08] | 618.54 [592.77-620.20] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 207.61 [207.46-211.24] | 1206.46 [1190.98-1225.67] | 1299.93 [1275.75-1331.02] | 1317.55 [1286.74-1356.71] | 100.60 [100.58-100.68] | 4813.74 [4727.72-4818.46] | 102.03 [101.72-102.12] | 102.20 [101.90-102.20] | 207.74 [207.54-211.52] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 3607.47 [3562.98-3614.92] | 69.42 [69.15-69.45] | 113.06 [110.82-116.02] | 130.32 [128.83-139.00] | 101.80 [101.54-101.90] | 276.52 [276.11-280.04] | 32.31 [27.89-32.41] | 33.09 [28.71-33.65] | 3616.42 [3570.93-3621.81] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 1862.46 [1728.80-2010.23] | 136.59 [126.11-144.69] | 204.90 [171.58-257.43] | 267.20 [206.15-308.65] | 101.56 [101.40-101.57] | 535.68 [497.06-577.82] | 31.66 [30.86-32.44] | 32.50 [31.58-33.71] | 1866.78 [1730.63-2011.82] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 1405.08 [1341.16-1419.24] | 194.50 [194.09-204.51] | 261.47 [255.73-270.72] | 288.36 [283.46-297.50] | 101.64 [101.52-101.72] | 709.48 [703.29-743.87] | 29.47 [29.24-29.60] | 31.22 [30.30-31.32] | 1409.48 [1344.31-1421.88] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) * (2 of 3 passes) | 1083.20 [1077.00-1129.26] | 152.15 [150.40-169.04] | 482.48 [451.75-511.71] | 1118.37 [570.42-1543.46] | 101.02 [100.94-101.04] | 922.24 [885.39-926.38] | 17.70 [17.53-18.32] | 20.93 [20.76-21.51] | 1084.32 [1079.47-1129.44] | 0.06 [0.00-0.07] |

App outcome: nextjs api-rotating-page sat256 pass 1: 122 of 5514 requests failed (2.21%), 0 fixed-rate iterations dropped, 122 checks failed.

App outcome: nextjs api-rotating-page sat256 pass 2: 121 of 5494 requests failed (2.20%), 0 fixed-rate iterations dropped, 121 checks failed.

App outcome: nextjs api-rotating-page sat256 pass 3: 124 of 5681 requests failed (2.18%), 0 fixed-rate iterations dropped, 124 checks failed.

App outcome: drogon api-rotating-page sat256 pass 2: 12 of 16543 requests failed (0.07%), 0 fixed-rate iterations dropped, 12 checks failed.

App outcome: drogon api-rotating-page sat256 pass 3: 10 of 17237 requests failed (0.06%), 0 fixed-rate iterations dropped, 10 checks failed.

## Locale-neutral JSON

### Memory source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten (Rust, Hyper, html! views) | 174.00 [172.00-179.00] | 11.32 [10.84-13.28] |
| Next.js 16.4 (Pages Router, React SSR) | 767.00 [752.00-768.00] | 71.25 [70.33-90.81] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 738.00 [704.00-746.00] | 119.94 [117.59-126.27] |
| Django 6.1 (Python, gunicorn, htmx) | 3214.00 [3142.00-3235.00] | 13.67 [13.58-21.64] |
| Topcoat 0.11 (Rust, view! components, shards) | 172.00 [171.00-177.00] | 12.30 [12.27-13.20] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 179.00 [174.00-179.00] | 12.52 [11.52-13.90] |
| Gin 1.12 (Go, templ, htmx) | 337.00 [336.00-369.00] | 11.62 [11.44-18.40] |
| Drogon 1.9 (C++, CSP views, htmx) | 353.00 [343.00-356.00] | 11.33 [11.17-12.07] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 150.06 [149.99-150.06] | 0.18 [0.16-0.19] | 0.27 [0.22-0.27] | 0.31 [0.28-0.32] | 1.16 [1.09-1.25] | 85.16 [78.13-92.05] | 10.92 [10.80-10.97] | 11.18 [11.17-11.24] | 11742.61 [10863.69-12799.22] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) | 150.05 [149.99-150.06] | 0.62 [0.53-0.64] | 0.85 [0.68-0.93] | 2.06 [1.64-2.46] | 10.14 [8.59-10.64] | 705.29 [593.42-705.39] | 109.12 [108.60-110.94] | 113.10 [109.20-115.60] | 1417.85 [1417.65-1685.13] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.05 [150.04-150.06] | 0.52 [0.50-0.59] | 0.66 [0.66-0.79] | 1.14 [0.93-1.30] | 9.00 [8.74-10.21] | 603.24 [594.43-675.00] | 51.44 [51.34-51.52] | 51.99 [51.99-52.00] | 1657.71 [1481.49-1682.28] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 150.05 [150.05-150.06] | 0.60 [0.58-0.75] | 0.71 [0.70-0.98] | 0.92 [0.91-1.12] | 7.73 [7.51-9.79] | 517.24 [505.26-650.78] | 97.46 [97.29-98.21] | 97.82 [97.64-98.64] | 1933.32 [1536.62-1979.19] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 150.05 [150.05-150.05] | 0.20 [0.20-0.25] | 0.26 [0.26-0.35] | 0.40 [0.30-0.43] | 1.67 [1.57-1.88] | 116.98 [109.61-132.22] | 12.53 [12.49-12.55] | 12.91 [12.79-12.92] | 8548.14 [7563.08-9122.89] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 150.05 [150.05-150.05] | 0.25 [0.22-0.25] | 0.32 [0.28-0.32] | 0.36 [0.35-0.37] | 2.05 [1.92-2.08] | 139.13 [132.23-143.49] | 11.77 [11.75-12.51] | 12.25 [12.02-12.80] | 7187.31 [6968.89-7562.65] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 150.06 [150.06-150.06] | 0.27 [0.24-0.31] | 0.38 [0.33-0.40] | 0.44 [0.40-0.45] | 3.26 [2.96-3.63] | 221.40 [204.79-246.79] | 21.72 [21.26-21.77] | 22.80 [22.66-22.82] | 4516.81 [4052.01-4882.94] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) | 150.05 [150.05-150.05] | 0.34 [0.30-0.34] | 0.43 [0.40-0.45] | 0.50 [0.46-0.52] | 3.63 [3.30-3.76] | 246.58 [228.30-254.39] | 54.59 [54.49-54.65] | 54.85 [54.77-54.85] | 4055.41 [3930.95-4380.25] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 26717.34 [26548.29-27342.42] | 1.64 [1.56-1.65] | 6.42 [6.35-6.47] | 11.28 [11.21-11.63] | 70.98 [60.44-74.06] | 26.58 [22.34-26.97] | 11.25 [11.12-11.32] | 11.57 [11.29-11.68] | 37621.17 [37071.44-44766.02] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) | 2096.21 [2089.37-2194.68] | 26.46 [25.56-27.30] | 55.05 [53.68-55.84] | 78.63 [76.98-81.06] | 101.08 [101.07-101.14] | 477.05 [455.59-478.04] | 116.03 [114.52-118.29] | 117.00 [115.80-119.30] | 2096.24 [2091.89-2194.95] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 8832.59 [5974.61-8952.47] | 6.08 [5.84-9.14] | 16.96 [16.56-22.38] | 25.68 [22.41-30.01] | 100.39 [99.84-100.47] | 112.27 [111.01-168.22] | 55.48 [54.26-55.60] | 59.60 [57.76-59.65] | 8907.36 [5944.66-9008.55] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 2572.73 [2398.58-2632.54] | 24.68 [24.00-26.24] | 30.89 [30.48-33.80] | 40.29 [33.76-41.64] | 102.47 [102.33-102.72] | 388.30 [379.68-416.48] | 96.85 [96.81-97.78] | 98.11 [97.78-98.83] | 2575.33 [2401.08-2633.78] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 21097.86 [20812.61-22079.78] | 2.25 [2.14-2.26] | 7.01 [6.84-7.31] | 12.42 [12.28-13.19] | 89.82 [89.53-90.32] | 42.30 [40.23-42.99] | 13.17 [13.05-13.19] | 13.53 [13.51-13.62] | 23641.89 [23261.79-24859.93] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 21004.23 [19095.87-21288.44] | 2.37 [2.33-2.82] | 6.93 [6.51-7.02] | 12.48 [12.10-12.57] | 91.04 [90.60-95.17] | 43.29 [42.42-49.49] | 12.40 [12.34-12.91] | 12.78 [12.55-13.25] | 23098.54 [20206.18-23575.46] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 8491.76 [8149.05-8949.54] | 6.87 [6.41-7.22] | 15.88 [15.45-16.36] | 20.40 [20.17-21.04] | 103.66 [103.08-103.92] | 117.48 [111.28-122.49] | 19.10 [19.01-19.35] | 22.02 [21.92-22.03] | 8512.07 [8164.23-8986.10] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) | 5850.56 [5780.28-6352.66] | 8.78 [8.61-9.05] | 15.62 [15.23-15.83] | 17.74 [17.29-18.46] | 101.87 [101.38-102.07] | 170.84 [157.34-172.83] | 54.78 [54.76-54.92] | 55.15 [54.91-55.40] | 5853.53 [5785.92-6355.60] | 0.00 [0.00-0.00] |

Warning: corten fixture-neutral-json sat64 pass 1: app CPU 71.0%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat64 pass 2: app CPU 60.4%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat64 pass 3: app CPU 74.1%; saturation not demonstrated.

Warning: topcoat fixture-neutral-json sat64 pass 1: app CPU 90.3%; saturation not demonstrated.

Warning: topcoat fixture-neutral-json sat64 pass 2: app CPU 89.5%; saturation not demonstrated.

Warning: topcoat fixture-neutral-json sat64 pass 3: app CPU 89.8%; saturation not demonstrated.

Warning: leptos fixture-neutral-json sat64 pass 1: app CPU 90.6%; saturation not demonstrated.

Warning: leptos fixture-neutral-json sat64 pass 3: app CPU 91.0%; saturation not demonstrated.

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 24968.07 [24614.68-25608.39] | 6.21 [5.84-6.71] | 20.66 [20.28-20.90] | 32.75 [32.20-33.06] | 73.15 [68.72-81.73] | 29.83 [27.01-31.54] | 13.34 [13.04-13.40] | 13.98 [13.84-14.00] | 33524.25 [31703.12-37027.45] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) * (3 of 3 passes) | 2168.91 [2129.44-2349.90] | 81.81 [77.71-84.40] | 135.07 [132.54-138.10] | 160.07 [148.27-164.28] | 101.28 [101.11-101.32] | 461.02 [425.35-469.01] | 115.29 [114.01-118.52] | 116.40 [115.80-120.40] | 2169.11 [2132.14-2351.01] | 0.10 [0.09-0.14] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 14969.48 [13663.93-15607.43] | 15.50 [15.02-16.72] | 31.32 [29.51-35.21] | 41.16 [40.76-46.20] | 98.23 [98.00-98.98] | 65.62 [62.31-71.62] | 64.37 [63.91-64.50] | 65.07 [64.78-65.15] | 15239.39 [13961.79-16048.65] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 2465.30 [2327.11-2481.67] | 100.53 [100.00-108.49] | 124.99 [121.06-129.64] | 135.00 [127.47-139.48] | 102.28 [102.15-102.92] | 405.10 [402.54-429.44] | 101.11 [100.80-101.88] | 101.50 [101.20-102.20] | 2468.54 [2328.60-2484.24] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 19939.24 [19394.29-21385.08] | 10.24 [9.46-10.26] | 27.60 [26.92-29.04] | 38.78 [38.36-39.98] | 93.40 [91.99-95.36] | 47.24 [42.66-47.83] | 19.36 [19.26-19.54] | 19.86 [19.68-20.23] | 21169.32 [20907.97-23438.53] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 20063.28 [17033.61-20393.75] | 10.40 [10.26-13.97] | 26.09 [25.59-28.39] | 36.48 [36.20-39.17] | 95.65 [94.41-99.32] | 46.87 [46.49-57.05] | 15.90 [15.40-15.97] | 16.29 [15.86-16.48] | 21336.83 [17528.26-21511.97] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 7858.43 [7830.44-8152.39] | 32.16 [30.68-32.24] | 53.96 [53.42-54.90] | 61.74 [61.07-62.28] | 104.07 [104.01-104.13] | 127.06 [122.35-127.49] | 28.37 [28.22-28.38] | 28.84 [28.45-29.02] | 7870.39 [7843.89-8173.58] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) | 6198.80 [6025.00-6299.28] | 36.05 [35.76-36.36] | 59.50 [57.94-59.80] | 62.42 [60.66-62.64] | 101.83 [101.78-102.00] | 161.03 [158.56-165.59] | 56.61 [56.53-56.75] | 57.27 [56.85-57.28] | 6210.13 [6039.07-6306.86] | 0.00 [0.00-0.00] |

Warning: corten fixture-neutral-json sat256 pass 1: app CPU 81.7%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat256 pass 2: app CPU 68.7%; saturation not demonstrated.

Warning: corten fixture-neutral-json sat256 pass 3: app CPU 73.1%; saturation not demonstrated.

App outcome: nextjs fixture-neutral-json sat256 pass 1: 33 of 32291 requests failed (0.10%), 0 fixed-rate iterations dropped, 33 checks failed.

App outcome: nextjs fixture-neutral-json sat256 pass 2: 45 of 32902 requests failed (0.14%), 0 fixed-rate iterations dropped, 45 checks failed.

App outcome: nextjs fixture-neutral-json sat256 pass 3: 33 of 35546 requests failed (0.09%), 0 fixed-rate iterations dropped, 33 checks failed.

Warning: topcoat fixture-neutral-json sat256 pass 1: app CPU 93.4%; saturation not demonstrated.

Warning: topcoat fixture-neutral-json sat256 pass 2: app CPU 92.0%; saturation not demonstrated.

Warning: leptos fixture-neutral-json sat256 pass 3: app CPU 94.4%; saturation not demonstrated.

### HTTP source

#### Cold start

Docker-host container StartedAt to first complete HTTP 200, before readiness/warmup; not process-exec or browser-interactive time.

| Framework | First 200 from container start ms | Successful request ms |
|---|---:|---:|
| Corten (Rust, Hyper, html! views) | 166.00 [157.00-167.00] | 13.09 [12.90-13.34] |
| Next.js 16.4 (Pages Router, React SSR) | 715.00 [696.00-722.00] | 93.43 [90.73-101.41] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 691.00 [687.00-692.00] | 176.63 [169.45-179.01] |
| Django 6.1 (Python, gunicorn, htmx) | 3004.00 [2938.00-3079.00] | 20.02 [18.50-25.26] |
| Topcoat 0.11 (Rust, view! components, shards) | 163.00 [160.00-173.00] | 12.57 [12.56-17.62] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 155.00 [155.00-163.00] | 14.05 [13.11-14.26] |
| Gin 1.12 (Go, templ, htmx) | 171.00 [170.00-182.00] | 17.69 [14.91-21.64] |
| Drogon 1.9 (C++, CSP views, htmx) | 176.00 [170.00-188.00] | 14.36 [13.52-15.21] |

#### Fixed 150 req/s

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 150.05 [150.05-150.06] | 0.36 [0.35-0.45] | 0.46 [0.46-0.60] | 0.56 [0.54-0.72] | 2.68 [2.66-3.13] | 184.61 [182.06-226.75] | 7.28 [6.63-7.28] | 7.48 [7.03-7.51] | 5416.96 [4410.06-5492.82] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) | 150.05 [150.05-150.05] | 1.06 [1.04-1.12] | 1.94 [1.82-2.22] | 12.70 [11.54-14.87] | 18.31 [18.00-18.83] | 1192.44 [1174.58-1283.79] | 99.91 [99.72-100.27] | 100.30 [100.20-100.80] | 838.61 [778.94-851.37] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 150.04 [149.99-150.05] | 1.10 [1.10-1.11] | 1.48 [1.39-1.49] | 2.70 [2.61-2.73] | 17.54 [17.34-17.72] | 1175.27 [1157.17-1179.03] | 46.92 [46.16-47.26] | 48.12 [47.83-48.32] | 850.87 [848.15-864.18] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 149.99 [149.99-150.04] | 1.61 [1.60-1.66] | 1.81 [1.79-2.01] | 2.41 [2.36-2.48] | 22.10 [21.83-22.70] | 1474.25 [1464.13-1515.39] | 86.96 [86.71-87.06] | 87.38 [86.88-87.49] | 678.31 [659.90-683.00] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 150.05 [150.05-150.06] | 0.46 [0.40-0.48] | 0.59 [0.55-0.66] | 0.73 [0.68-0.78] | 3.82 [3.40-3.98] | 262.60 [236.16-271.89] | 8.22 [7.91-8.63] | 8.59 [8.14-8.98] | 3808.06 [3677.92-4234.43] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 150.05 [150.05-150.05] | 0.46 [0.46-0.46] | 0.63 [0.60-0.64] | 0.73 [0.72-0.74] | 3.75 [3.74-3.77] | 262.25 [256.77-262.34] | 8.11 [7.49-8.31] | 8.51 [7.73-8.73] | 3813.09 [3811.84-3894.48] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 150.05 [150.05-150.05] | 0.58 [0.54-0.59] | 0.78 [0.74-0.79] | 0.92 [0.89-1.00] | 6.78 [6.23-6.87] | 458.49 [428.51-463.30] | 13.74 [13.63-13.84] | 14.13 [14.08-14.28] | 2181.08 [2158.42-2333.65] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) | 150.05 [149.99-150.05] | 0.84 [0.80-0.85] | 1.15 [1.14-1.18] | 1.36 [1.32-1.43] | 10.99 [10.46-11.22] | 728.58 [706.08-739.26] | 10.98 [10.96-11.19] | 11.33 [11.25-11.70] | 1372.53 [1352.71-1416.26] | 0.00 [0.00-0.00] |

#### 64-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 10702.25 [9769.85-10834.15] | 5.13 [4.96-6.54] | 9.38 [8.90-9.51] | 13.28 [12.89-13.31] | 101.11 [101.09-101.36] | 92.73 [91.85-101.71] | 9.87 [8.90-10.02] | 10.68 [9.50-10.84] | 10784.41 [9832.21-10887.33] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) | 986.67 [981.89-1006.87] | 56.92 [55.63-57.01] | 109.26 [106.04-109.41] | 130.98 [130.04-134.07] | 100.85 [100.81-100.85] | 1013.06 [992.94-1018.09] | 110.41 [110.34-110.94] | 113.20 [112.40-113.70] | 987.11 [982.23-1007.11] | 0.00 [0.00-0.00] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 1332.40 [1315.66-1393.53] | 45.81 [43.90-47.05] | 64.64 [61.30-64.73] | 84.44 [81.26-86.73] | 100.34 [100.24-100.34] | 749.67 [734.87-759.53] | 54.35 [53.92-54.65] | 57.52 [55.91-57.57] | 1333.92 [1316.60-1360.79] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 707.00 [691.46-709.53] | 90.06 [89.92-91.84] | 95.61 [95.24-106.69] | 99.05 [98.41-111.49] | 100.65 [100.56-100.77] | 1412.86 [1408.76-1445.66] | 86.10 [85.99-86.22] | 87.05 [86.89-87.09] | 707.78 [691.72-709.84] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 7051.32 [6757.70-7554.11] | 8.77 [7.89-9.19] | 14.29 [13.94-14.89] | 17.01 [16.93-17.74] | 101.56 [101.51-101.65] | 141.69 [132.26-147.87] | 9.52 [9.36-10.32] | 10.09 [10.02-11.32] | 7057.46 [6762.51-7560.70] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 6576.76 [6280.37-6588.82] | 8.73 [8.55-10.70] | 13.32 [13.08-13.87] | 15.24 [14.87-15.37] | 101.97 [101.87-102.11] | 151.94 [151.67-159.13] | 9.48 [9.22-9.97] | 10.17 [9.84-10.40] | 6581.48 [6284.19-6593.30] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 3028.52 [2867.45-3107.45] | 20.25 [19.87-21.34] | 38.64 [37.28-39.41] | 41.93 [41.37-41.96] | 103.14 [102.74-103.20] | 329.99 [321.63-348.44] | 12.42 [12.22-12.50] | 13.27 [13.19-13.52] | 3030.38 [2869.90-3109.13] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) | 1831.05 [1743.95-1849.82] | 34.30 [33.88-35.84] | 51.15 [50.03-53.71] | 57.27 [56.24-62.25] | 100.95 [100.59-101.32] | 546.21 [540.32-573.17] | 13.27 [12.95-13.45] | 14.62 [13.93-15.13] | 1830.81 [1744.67-1850.75] | 0.00 [0.00-0.00] |

#### 256-user closed loop

| Framework | req/s | p50 ms | p95 ms | p99 ms | CPU % | CPU us/request | Steady MiB | Peak MiB | Requests/CPU-second | Failed % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Corten (Rust, Hyper, html! views) | 9152.16 [8264.87-10000.80] | 21.41 [18.99-24.27] | 60.11 [57.61-62.76] | 78.55 [75.91-80.39] | 102.07 [101.92-102.16] | 108.94 [99.84-120.80] | 28.33 [25.99-31.97] | 28.94 [27.14-33.93] | 9179.00 [8277.99-10015.98] | 0.00 [0.00-0.00] |
| Next.js 16.4 (Pages Router, React SSR) * (3 of 3 passes) | 977.50 [966.13-978.90] | 192.61 [191.34-194.58] | 287.74 [278.95-290.79] | 3352.62 [3333.13-3753.41] | 100.59 [100.53-100.71] | 1021.55 [1019.18-1033.91] | 119.89 [116.52-120.55] | 122.00 [119.40-123.50] | 978.91 [967.20-981.18] | 0.21 [0.21-0.23] |
| ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx) | 3058.55 [2165.40-3899.40] | 66.66 [58.48-98.89] | 164.31 [112.74-197.03] | 217.34 [133.77-263.37] | 100.52 [100.29-100.62] | 332.35 [256.20-464.23] | 67.72 [66.69-69.49] | 70.34 [68.52-72.06] | 3008.92 [2154.12-3903.22] | 0.00 [0.00-0.00] |
| Django 6.1 (Python, gunicorn, htmx) | 683.21 [680.75-689.71] | 373.05 [370.23-374.32] | 398.65 [397.14-399.72] | 410.51 [405.85-413.16] | 100.80 [100.68-100.91] | 1463.43 [1449.91-1467.97] | 89.80 [89.69-89.83] | 89.97 [89.85-90.18] | 683.32 [681.21-689.70] | 0.00 [0.00-0.00] |
| Topcoat 0.11 (Rust, view! components, shards) | 6327.12 [5450.55-6885.01] | 36.94 [32.87-44.50] | 77.96 [73.86-83.27] | 97.12 [92.36-102.45] | 102.08 [101.95-102.10] | 157.82 [144.99-183.19] | 28.28 [27.68-29.32] | 28.88 [28.32-29.98] | 6336.19 [5458.74-6896.94] | 0.00 [0.00-0.00] |
| Leptos 0.8 (Rust, SSR + WASM hydration) | 5548.11 [5446.74-5675.88] | 44.40 [42.86-47.81] | 74.53 [73.80-79.91] | 96.59 [94.94-104.23] | 102.60 [102.47-102.66] | 179.72 [175.61-183.29] | 27.54 [25.36-28.48] | 28.16 [26.27-29.22] | 5564.28 [5455.96-5694.33] | 0.00 [0.00-0.00] |
| Gin 1.12 (Go, templ, htmx) | 2801.45 [2712.68-2961.28] | 94.07 [87.48-96.99] | 126.39 [124.70-127.73] | 137.82 [137.26-139.67] | 103.13 [103.00-103.50] | 356.25 [337.15-367.74] | 29.63 [29.03-30.08] | 30.70 [29.92-31.19] | 2807.03 [2719.31-2966.01] | 0.00 [0.00-0.00] |
| Drogon 1.9 (C++, CSP views, htmx) | 1036.67 [989.14-1098.29] | 178.25 [171.35-199.82] | 468.35 [441.55-478.36] | 497.77 [464.69-510.12] | 100.64 [100.61-100.75] | 962.13 [907.89-1008.67] | 21.15 [20.50-21.64] | 22.54 [22.21-22.85] | 1039.36 [991.40-1101.45] | 0.00 [0.00-0.00] |

App outcome: nextjs api-neutral-json sat256 pass 1: 34 of 14722 requests failed (0.23%), 0 fixed-rate iterations dropped, 34 checks failed.

App outcome: nextjs api-neutral-json sat256 pass 2: 32 of 14884 requests failed (0.21%), 0 fixed-rate iterations dropped, 32 checks failed.

App outcome: nextjs api-neutral-json sat256 pass 3: 31 of 14844 requests failed (0.21%), 0 fixed-rate iterations dropped, 31 checks failed.

## Limits

single Node process, even with a two-CPU quota; high upstream CPU can limit API-mode throughput; closed-loop VUs alone do not prove app saturation
cgroup v2 usage_usec before/after docker start -a of k6; includes small Docker command/idle windows, not only HTTP handler CPU
