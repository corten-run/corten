# Performance

[Back to the README](../README.md)

Speed at the user's end is Corten's first value, so every claim about it has a measured number.
This page gathers the comparisons; how each number is taken is in the benchmark READMEs it links.

## Reading the comparisons

No single table establishes overall framework speed. The historical marketplace measures a
richer application, with the work differences stated below. The separate catalog measures a
strings-only page and JSON. [Marketplace v2](../bench/marketplace/README.md) adds a separate
rich-page workload with request-time localization in all eighteen adapters, a whole-page
conformance gate and a repeated-pass runner. It starts its own baseline; no v2 performance
results replace the historical tables here.

| Question | Evidence to read |
|---|---|
| How fast does it feel? | Phone interactivity, navigation and form-update latency, transferred bytes |
| What does serving it cost? | CPU per request, CPU and loaded memory at the same fixed rate |
| How much can it handle? | Throughput with a stated latency/error limit and app/upstream headroom |
| What does development cost? | Clean and incremental build times, development rebuilds, CPU and peak memory |

Read throughput alongside CPU utilization and requests per CPU-second: similar req/s can hide
different costs, and an app whose CPU is not busy has not demonstrated its maximum capacity.
A saturated upstream can bound the whole application. Compare repeated passes on one host;
keep medians, ranges, failures and configuration differences visible. The catalog reporter
flags these limits and labels incomplete data rather than treating missing passes as zeros.

Features are a different question from speed. The [highlights](../README.md#highlights) link
to Corten's behavior and examples. A future comparison must distinguish built-in support,
support through a named library, and behavior not implemented or not evaluated in an example;
a benchmark omission is not evidence a framework lacks a feature. Do not combine these into
a single performance score.

## Summary

- **Fast on the server.** 20,705 rendered pages a second on one CPU (uncompressed, untagged),
  5.0x ASP.NET Core; of eighteen apps, behind axum + Maud (27,327) and ahead of Drogon (17,870).
  The most JSON responses and item-API pages of any (26,385 and 3,669 a second), and
  1.3 MiB of memory after the first request (measured, [below](#on-the-server)).
- **Light on the machine.** A page costs 47 µs of CPU (uncompressed, untagged), 5.1x less than
  ASP.NET Core's; 300 pages a second take 4.2% of one core (ASP.NET Core 25%, Leptos 25%), and
  each MiB of memory serves 1,234 pages a second, 14.8x Leptos. axum + Maud costs less CPU
  (35 µs, 3.6%), and Drogon serves more per MiB (1,407) (measured,
  [below](#cpu-and-memory-per-request)).
- **Fast in the browser.** The benchmark item page loaded 14.1 KB of JavaScript (gzip,
  measured). No WASM, no virtual DOM, no hydration: a script takes over 1,000 server-rendered
  rows in 6.0 ms, against 20-84 ms for Solid, Svelte, Vue, React and Remix (measured,
  [below](#client-heavy-screens)).

## Where the numbers come from

Measured on one DigitalOcean c-8 droplet (Xeon Platinum 8168) on 2026-11-06 to 2026-11-07 (UTC), three load-test passes
(round r16, the tree at `eea6adb`). The
method, every table and the caveats are in [bench/fullstack](../bench/fullstack/README.md) and
[bench/browser](../bench/browser/README.md).

These are historical marketplace measurements, including localized prices in Corten's
example. The new [catalog benchmark](../bench/catalog/README.md) measures a strings-only
record-detail page in the same eighteen frameworks, with no locale formatting in any app.
It has a separate baseline; its throughput has not been measured yet.

## On the server

The same item page (listings table, offers, a form that patches) and the same item as JSON in
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
Corten reads only the fields the page uses from that response, not a `serde_json::Value`, and
serves 2.8x ASP.NET Core's pages there (3,669 a second against 1,292) at 6.0% of one core
against 32% ([details](../bench/fullstack/README.md#cortens-item-api-path)). axum + Maud renders the page
from memory faster (27,327 against 20,705); Corten serves the most JSON (26,385) and item-API
pages. Its JSON route costs 69,631 user instructions a request against the page's 94,677.
Against r15 the in-memory page rose 37.1% and JSON 17.0%, while the other passing apps' medians
rose 7.0% and 8.6%. This is not an unchanged-app control: every page app's Show all
markup changed, and Corten now sends five offers initially instead of every offer in hidden
templates. It still formats prices per request where the others write stored strings. The
page improvement is therefore not a like-for-like rendering speedup. JavaScript got worse,
13,187 to 14,392 gzip bytes (+9.1%); no other Corten regression crosses the thresholds.
Requests a second compare only within a round, since droplets of one size differ; instruction
counts compare across rounds. Pushing live updates
is measured in [bench/live](../bench/live/README.md): at 10,000 open connections on one core, only
Corten and Leptos delivered all 100,000 messages a second.

## CPU and memory per request

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

The same item page, loaded cold in Chromium 148 from another site, median of 10 loads each. The
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

A table of rows a script changes, in Chromium 148 on Linux. Each framework's app is written the
way its keyed [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) entry
is, built for production, and checked after every operation, so an app that skips work fails
instead of looking fast. Times run from the click to the DOM being updated (the frames that lay
it out and paint it are in the results): the median of 15, the slower of two rounds, or the
range when they disagree. Takeover runs from the HTML being parsed to the app marking itself
ready, for 1,000 rows the server rendered, less any frame the browser paints in between (the
median of 30 loads that take turns between the apps); every framework kept the server's rows.
Plain JavaScript is the floor: hand-written DOM code. Measured in round browser-3 (2026-10-23, at
77002fe); Corten's runtime has grown since, so its JavaScript row is less than a page sends today
until the next round ([#833 The README's client-heavy table is from round browser-3 (2026-10-23): its 8.6 KB of Corten JavaScript is less than the runtime alone is now (12.1 KB gzip)](https://github.com/corten-run/corten/issues/833)).

| | **Corten (views)** | Solid 1.9 | Svelte 5 | Vue 3.5 | React 19 | Remix 3 | Plain JS (floor) |
|---|---|---|---|---|---|---|---|
| Take over 1,000 server-rendered rows | **6.0 ms** | 19.6 ms | 25.6 ms | 28.3 ms | 60.1 ms | 83.5 ms | 1.4 ms |
| First click on a taken-over row | **1.8 ms** | 1.1 ms | 2.9 ms | 2.5 ms | 5.3 ms | 16.3 ms | 0.4 ms |
| Change 1 row of 10,000 | **0.2 ms** | 0.2 ms | 1.2 ms | 5.9 ms | 11.7 ms | 120 ms | 0.1 ms |
| Change 100 rows of 10,000 | **0.9 ms** | 1.0 ms | 1.8 ms | 6.8 ms | 26.4 ms | 112 ms | 0.6 ms |
| Update every 10th of 1,000 | **0.6 ms** | 0.9 ms | 1.0 ms | 1.6 ms | 2.0 ms | 10.0 ms | 0.4 ms |
| Select a row | **0.2 ms** | 0.3 ms | 1.2 ms | 0.7 ms | 1.1 ms | 8.5 ms | 0.1 ms |
| Swap two rows | **0.3 ms** | 1.0 ms | 1.0 ms | 1.0 ms | 10.1 ms | 8.6 ms | 0.2 ms |
| Create 1,000 rows | **6.4 ms** | 5.6 ms | 6.9 ms | 12.2 ms | 14.9 ms | 15.5 ms | 5.2 ms |
| Create 10,000 rows | **68.9 ms** | 59.2 ms | 81.9 ms | 127 ms | 351 ms | 172 ms | 48.9 ms |
| Dashboard: 200 prices tick | **0.6 ms** | 1.0 ms | 1.6 ms | 1.3 ms | 0.9 ms | 17.2 ms | 0.4 ms |
| Memory per row | **101 B** | 927 B | 1,229 B | 1,876 B | 2,036 B | 2,416 B | 165 B |
| JavaScript, gzip | **8.6 KB** | 6.8 KB | 20.6 KB | 26.2 KB | 68.4 KB | 28.4 KB | 1.1 KB |

Corten's rows are server-rendered `#[component(view)]` components, so taking them over is reading
the page rather than rebuilding it, and a row costs 101 bytes of JavaScript memory against
927-2,416 for the frameworks, which keep each row's data and bookkeeping in JavaScript. Creating
thousands of rows in the browser is where it trails Solid and plain JavaScript (68.9 ms against
59.2 and 48.9 ms for 10,000, down from 87.5 ms in the round before). What is left is mostly the
cost of keeping each row's key and refs in the page, which is what makes takeover and memory
small ([profile](../bench/browser/README.md#creating-many-rows)).
