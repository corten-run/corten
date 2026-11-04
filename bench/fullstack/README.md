# Full-stack comparison: one marketplace item page in eighteen apps

The same item detail page (title, images, sorted listings table, offers with "show all", a
price-alert form that posts and patches a message), and the same item as JSON, built in:

| App | Stack | Directory |
|---|---|---|
| corten | Corten 0.1 (Rust, axum, `html!` views, handlers) | [examples/card-market](../../examples/card-market) |
| leptos | Leptos 0.8 (Rust, SSR plus WASM hydration, axum) | [apps/leptos](apps/leptos) |
| topcoat | Topcoat 0.11 (Rust, `view!` components, shards and a procedure, no WASM) | [apps/topcoat](apps/topcoat) |
| axum-maud | axum 0.8.9 and Maud 0.27 (Rust, a router and a template macro, no framework), htmx | [apps/axum-maud](apps/axum-maud) |
| nextjs | Next.js 16.4.2, App Router, React Server Components, server action | [apps/nextjs](apps/nextjs) |
| tanstack-start | TanStack Start 1.169.3, React 19, server functions, Nitro | [apps/tanstack-start](apps/tanstack-start) |
| sveltekit | SvelteKit 3.1.0, Svelte 5.57, adapter-node 6, form action | [apps/sveltekit](apps/sveltekit) |
| react-router | React Router 7.18.4 on Express | [apps/react-router](apps/react-router) |
| astro | Astro 7.4.2, Node adapter (standalone), client router, Actions | [apps/astro](apps/astro) |
| nuxt | Nuxt 4.6.2, Vue 3.5, Nitro | [apps/nuxt](apps/nuxt) |
| aspnet | ASP.NET Core 10 Razor Pages on Kestrel, htmx | [apps/aspnet](apps/aspnet) |
| aspnet-aot | ASP.NET Core 10 minimal API published with native AOT, the item as JSON only | [apps/aspnet-aot](apps/aspnet-aot) |
| spring | Spring Boot 4.1.1, Java 25, Thymeleaf on Tomcat, htmx | [apps/spring](apps/spring) |
| gin | Gin 1.12.0, Go 1.27, templ 0.3, htmx | [apps/gin](apps/gin) |
| drogon | Drogon 1.9.14 (C++), CSP views, JsonCpp, htmx | [apps/drogon](apps/drogon) |
| django | Django 6.1.2, Python 3.14, gunicorn 26 (3 sync workers), htmx | [apps/django](apps/django) |
| rails | Rails 8.1.4, Ruby 3.4 with YJIT, Puma (3 threads), Turbo and Stimulus | [apps/rails](apps/rails) |
| laravel | Laravel 13.38, PHP 8.4, Octane on FrankenPHP (2 workers), Livewire 4.4 | [apps/laravel](apps/laravel) |
| phoenix | Phoenix 1.8.16, LiveView 1.2, Elixir 1.19 on OTP 28, Bandit | [apps/phoenix](apps/phoenix) |

Every app renders Corten's pages: the item page, the home page and the 404 page, with the same
elements, classes and stylesheets as [card-market](../../examples/card-market), each written in the
framework's usual way (its templates, components, routing and forms). `sync-styles.mjs` copies
card-market's `style.css` and Corten's built `components.css` into every app, so a change to
Corten's styles reaches them all at the next run of it. `parity.mjs` checks, for 16 item URLs and
the home page, that each app returns the same status, the same visible text and the same outline
(`outline.mjs`: each element with its classes and the few attributes that change what it is,
leaving out what a framework adds for itself, such as `data-*` attributes, wrapper `div`s
without a class and custom elements). `look.mjs` loads four pages in Chromium, at desktop and phone
sizes in light and dark, and compares each element's box and computed styles with Corten's, so a
style that differs fails it even when the markup matches. (Next.js 16 sends an empty document for
a page that calls `notFound()` and renders its 404 only after hydration,
[vercel/next.js#99793 notFound() in a page serves an empty `__next_error__` shell (no root layout, no `lang`, no not-found UI) in the server HTML](https://github.com/vercel/next.js/issues/99793),
so parity checks only its status there and `look.mjs` checks the page in the browser.) Every app
writes its counts as an English page does, digits grouped and the word singular for one ("2,866
listings", "1 listing"), as Corten's plural messages do. Parity compares the grouping (the
fixture's counts are all 3 or more); the singular form is checked by reading each app. And every app
answers `GET /api/items/{id}` with the same JSON. A round runs parity and `look.mjs` after its
server tests, with every app fetching items from the item API, so the home page they compare is
the list of item links; `check-app.mjs`, which every app passes before it joins a round, runs
both with items in memory, where the home page is Corten's cards, and compares the JSON. The
tables below are from r14, with all eighteen apps, each rendering Corten's markup
and stylesheets (caveat 12). Each app
has the same interactions: a sort (in the browser, except where the framework renders again on
the server: Phoenix's LiveView and Topcoat's shard, each a round trip), a form action that
updates part of the page, and client-side navigation from the home page, each done the
framework's usual way (htmx for Razor Pages, Spring, Django, Gin, Drogon and axum + Maud; Turbo
for Rails; Livewire for Laravel; LiveView for Phoenix; shards, signals and a procedure for
Topcoat).
The Corten app also runs everything a production deployment would (CSP, CSRF check, compression,
versioned assets, service worker, error pages, health, MCP tools); the others run their framework
defaults in production mode.

aspnet-aot serves only the JSON: native AOT does not support Razor Pages or MVC, so it is a
minimal API, published as one native executable on `runtime-deps` (no .NET runtime in the image),
with System.Text.Json's source generator. It answers what card-market's JSON route answers, each
with ASP.NET Core's own middleware for it: the same JSON (`check-app.mjs` compares all 508
fixture items), GET and HEAD, failures (404, 405, 500) as `application/problem+json`, the same
security headers and `Cache-Control: private, no-cache`, a 10-second deadline answered with 503,
compression when asked (brotli and gzip; Corten also offers zstd), a host allow-list (`HOSTS`),
and `/health/live` and `/health/ready` (ready while the item API answers). It differs in what
ASP.NET Core does differently: a host it does not know gets a 400 HTML page without the security
headers, before the app's middleware (Corten: 421 with its headers), a problem body carries ASP.NET Core's `type` and
`trace_id`, the host list has no rule for "any IP address", a whole number in a double is
written `9` where Corten writes `9.0` (218 bytes fewer over the fixture's 3.34 MB of JSON;
otherwise the bytes are the same for every fixture item), text with HTML's characters (`<`, `&`,
`'` and others) or characters outside the Basic Multilingual Plane is escaped (`\u003C`, a
surrogate pair) where Corten writes it as it is (the fixture has none), the answer is chunked and
carries `Server: Kestrel` where Corten sends a length and no `Server`, its `Content-Type` adds
`charset=utf-8`, compression is off over
HTTPS (`EnableForHttps`, which the bench's plain HTTP does not reach), and a listing price that does not parse (none
in the fixture) is a 500 where Corten writes `null`, as in apps/aspnet, whose view model it shares. It runs in the JSON steps, cold
start (its probe asks for the item as JSON from the item API rather than the page) and the
instruction counts; the page steps, the browser pass and the build step (whose rebuild edits the
item page) leave it out (`pages: false` in `apps.mjs`).

The same apps hold the live-updates comparison in [bench/live](../live/README.md).

## Results

All numbers are measured, from one run (`results/r14/`, 2026-11-04 UTC, the tree at `557920c`)
on one DigitalOcean c-8 droplet (Intel Xeon Platinum 8168); see [Method](#method). Failed
means the app could not do the test with its usual settings in one CPU and 1 GiB (see caveat 5);
its other numbers are kept where it produced any. r9 measured nothing (its launcher hung in its
own `ssh` call before the round started). r13 (`results/r13/`, the same CPU model, Corten at
`7f0b81f`, 110 commits before r14's, before pages required Trusted Types and a swapped-in page
carried its handler modules' preloads), r12 (`results/r12/`, the same CPU model, Corten at
`094f72d`, 205 commits before r13's, without Topcoat, axum + Maud, Gin and Drogon and with no
instruction counts), r11
(`results/r11/`, a Platinum 8280, Corten at `512dc73`, 474 commits before r12's, before a write's
redirect drew the layout again and class lists were written in place, with the other apps
rendering Corten's text in markup and stylesheets of their own), r10 (`results/r10/`, a Platinum
8280, Corten at `f5c76a0`, before currencies were found by their numeric key), r8
(`results/r8/`, a Platinum 8168, Corten at `2976f15`, before plural
messages, typed custom properties and comment-free component scripts, with no instruction counts),
r7 (`results/r7/`, a Platinum 8280, Corten at `a9b1163`, with no browser
pass), r6 (`results/r6/`, a Platinum 8280, Corten at `cf8ac0f`, with CPU sampled once a second
rather than counted and a one-process item API), r5 (`results/r5/`, a Platinum 8168, Corten at `f80d4a1`, before the
read-again, place-keeping and catalog-formatting runtime that r6's item page loads), r4 (`results/r4/`, the same CPU model, Corten at `05fcb74`, before the
JSON derives, the views runtime and the cheaper escape and route parameters), r3 (`results/r3/`, a Platinum 8280, Corten before it parsed the item API's
response into typed structs), r2 (`results/r2/`, a Platinum 8280, Corten before handlers replaced
islands and before `corten::Json`) and r1 (`results/r1/`, six frameworks, a Platinum 8168 and
20 s warmups) are kept for the record; times are compared within a round, not across rounds.

### Cold start

| App | Process start to first 200, median (min-max) of 10 | Memory after first request | Image |
|---|---|---|---|
| axum-maud | 7.2 ms (6.5 ms-8.1 ms) | 1.344 MiB | 118 MB |
| **corten** | 8.1 ms (7.0 ms-52 ms) | 1.223 MiB | 124 MB |
| topcoat | 9.0 ms (8.0 ms-11 ms) | 1.5 MiB | 124 MB |
| leptos | 9.7 ms (7.7 ms-48 ms) | 1.496 MiB | 128 MB |
| gin | 12 ms (9.8 ms-12 ms) | 1.949 MiB | 135 MB |
| drogon | 33 ms (30 ms-48 ms) | 3.27 MiB | 122 MB |
| sveltekit | 229 ms (217 ms-343 ms) | 25.57 MiB | 333 MB |
| tanstack-start | 268 ms (256 ms-359 ms) | 27.71 MiB | 332 MB |
| nuxt | 388 ms (371 ms-464 ms) | 37.71 MiB | 335 MB |
| astro | 388 ms (376 ms-413 ms) | 36.1 MiB | 527 MB |
| react-router | 389 ms (351 ms-476 ms) | 33.45 MiB | 353 MB |
| nextjs | 837 ms (790 ms-1.0 s) | 52.68 MiB | 385 MB |
| aspnet | 860 ms (820 ms-1.0 s) | 30.75 MiB | 342 MB |
| laravel | 1.1 s (1.0 s-1.1 s) | 96.77 MiB | 948 MB |
| rails | 1.4 s (1.3 s-1.6 s) | 63.87 MiB | 431 MB |
| django | 1.4 s (1.3 s-2.1 s) | 65.4 MiB | 276 MB |
| phoenix | 1.7 s (1.6 s-1.8 s) | 124.3 MiB | 262 MB |
| spring | 10.2 s (9.8 s-10.7 s) | 147.7 MiB | 516 MB |

### Item page, items in memory (no database)

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| axum-maud | 300/s, 0.3 ms / 0.4 ms, 4% | 20,761, 2.8 ms / 8.6 ms | 18,293, 34 ms, 0% | 16-19 MiB |
| **corten** | 300/s, 0.3 ms / 0.5 ms, 6% | 14,460, 4.8 ms / 9.1 ms | 13,198, 36 ms, 0% | 16-19 MiB |
| drogon | 300/s, 0.3 ms / 0.5 ms, 5% | 14,043, 4.6 ms / 9.9 ms | 14,034, 36 ms, 0% | 12-15 MiB |
| topcoat | 300/s, 0.5 ms / 0.7 ms, 11% | 4,674, 14 ms / 18 ms | 4,265, 75 ms, 0% | 15-18 MiB |
| gin | 300/s, 0.4 ms / 0.6 ms, 10% | 4,516, 14 ms / 33 ms | 4,231, 95 ms, 0% | 20-29 MiB |
| aspnet | 300/s, 0.8 ms / 3.3 ms, 32% | 3,302, 19 ms / 32 ms | 3,193, 130 ms, 0% | 85-90 MiB |
| leptos | 300/s, 1.1 ms / 1.5 ms, 30% | 1,112, 59 ms / 83 ms | 940, 445 ms, 0% | 16-32 MiB |
| phoenix | 300/s, 1.3 ms / 1.7 ms, 44% | 1,085, 59 ms / 77 ms | 1,129, 3.6 s, 0% | 287-304 MiB |
| astro | 300/s, 1.2 ms / 43 ms, 39% | 1,070, 53 ms / 135 ms | 961, 361 ms, 0% | 135-136 MiB |
| spring | 300/s, 3.0 ms / 724 ms, 87% | 825, 57 ms / 468 ms | 838, 3.1 s, 0% | 371-382 MiB |
| sveltekit | 300/s, 1.8 ms / 35 ms, 55% | 640, 99 ms / 182 ms | 586, 522 ms, 0% | 149-153 MiB |
| tanstack-start | 300/s, 2.0 ms / 49 ms, 65% | 515, 118 ms / 205 ms | 527, 567 ms, 0.01% | 164-165 MiB |
| react-router | 300/s, 2.5 ms / 66 ms, 78% | 432, 143 ms / 228 ms | 405, 746 ms, 0% | 132-135 MiB |
| rails | **failed**: 262/s served, 2.7 s / 4.0 s, 100% | 310, 208 ms / 247 ms | 285, 1.0 s, 0% | 135-142 MiB |
| nuxt | **failed**: 185/s served, 794 ms / 49.7 s, 74% | 278, 229 ms / 294 ms | 259, 7.3 s, 0.03% | 149-150 MiB |
| django | **failed**: 185/s served, 5.3 s / 5.8 s, 100% | 203, 318 ms / 401 ms | 205, 1.5 s, 0% | 346-347 MiB |
| nextjs | **failed**: 124/s served, 1.4 s / 58.7 s, 89% | 149, 444 ms / 536 ms | 151, 23.4 s, 0% | 214-222 MiB |
| laravel | **failed**: never answered /items/item_1 within a minute | - | - | - |

### The item as JSON, items in memory

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 300/s, 0.3 ms / 0.5 ms, 5% | 18,068, 3.8 ms / 9.1 ms | 17,378, 35 ms, 0% | 16-18 MiB |
| topcoat | 300/s, 0.3 ms / 0.5 ms, 5% | 14,126, 4.8 ms / 8.7 ms | 12,758, 34 ms, 0% | 15-18 MiB |
| axum-maud | 300/s, 0.3 ms / 0.4 ms, 5% | 12,070, 5.7 ms / 8.7 ms | 11,710, 36 ms, 0% | 15-19 MiB |
| leptos | 300/s, 0.3 ms / 0.5 ms, 6% | 10,981, 6.2 ms / 9.0 ms | 10,625, 35 ms, 0% | 15-18 MiB |
| aspnet | 300/s, 0.4 ms / 0.6 ms, 17% | 9,254, 6.6 ms / 12 ms | 9,127, 47 ms, 0% | 77-86 MiB |
| nuxt | 300/s, 0.5 ms / 0.9 ms, 13% | 5,610, 10 ms / 38 ms | 5,512, 98 ms, 0% | 106-107 MiB |
| spring | 300/s, 0.5 ms / 2.6 ms, 31% | 5,444, 7.2 ms / 98 ms | 5,596, 350 ms, 0% | 340-364 MiB |
| gin | 300/s, 0.4 ms / 1.3 ms, 12% | 3,792, 17 ms / 35 ms | 3,690, 115 ms, 0% | 25-35 MiB |
| tanstack-start | 300/s, 0.6 ms / 7.3 ms, 17% | 3,017, 19 ms / 58 ms | 2,836, 140 ms, 0% | 147-149 MiB |
| sveltekit | 300/s, 0.6 ms / 5.7 ms, 17% | 2,660, 22 ms / 65 ms | 2,758, 159 ms, 0% | 126-129 MiB |
| react-router | 300/s, 0.9 ms / 16 ms, 25% | 1,920, 32 ms / 100 ms | 1,972, 211 ms, 0% | 118-119 MiB |
| astro | 300/s, 1.0 ms / 30 ms, 29% | 1,695, 33 ms / 96 ms | 1,726, 214 ms, 0% | 135-137 MiB |
| drogon | 300/s, 0.9 ms / 1.3 ms, 22% | 1,686, 43 ms / 67 ms | 1,805, 208 ms, 0% | 12-14 MiB |
| phoenix | 300/s, 0.9 ms / 1.2 ms, 32% | 1,529, 42 ms / 58 ms | 1,575, 4.8 s, 0% | 294-350 MiB |
| nextjs | 300/s, 1.2 ms / 48 ms, 41% | 957, 61 ms / 142 ms | 967, 346 ms, 0% | 165-166 MiB |
| django | 300/s, 1.1 ms / 1.4 ms, 38% | 876, 75 ms / 89 ms | 862, 341 ms, 0% | 294-295 MiB |
| rails | 300/s, 1.5 ms / 14 ms, 50% | 752, 86 ms / 112 ms | 747, 410 ms, 0% | 130-131 MiB |
| laravel | **failed**: never answered /api/items/item_1 within a minute | - | - | - |

### Item page, item fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 1.0 ms / 1.3 ms, 9% | 3,081, 21 ms / 27 ms | 3,004, 121 ms, 0% | 16-60 MiB |
| axum-maud | 150/s, 1.7 ms / 2.3 ms, 19% | 930, 69 ms / 87 ms | 843, 430 ms, 0% | 16-57 MiB |
| aspnet | 150/s, 3.0 ms / 34 ms, 56% | 877, 71 ms / 109 ms | 799, 387 ms, 0% | 70-98 MiB |
| topcoat | 150/s, 1.9 ms / 2.6 ms, 22% | 806, 81 ms / 96 ms | 737, 485 ms, 0% | 16-58 MiB |
| gin | 150/s, 1.7 ms / 2.8 ms, 23% | 676, 92 ms / 209 ms | 673, 563 ms, 0% | 14-39 MiB |
| leptos | 150/s, 2.3 ms / 3.1 ms, 29% | 601, 110 ms / 128 ms | 513, 670 ms, 0% | 15-58 MiB |
| spring | 150/s, 4.0 ms / 124 ms, 88% | 386, 163 ms / 299 ms | 300, 1.6 s, 0% | 422-449 MiB |
| astro | 150/s, 2.9 ms / 69 ms, 57% | 375, 176 ms / 239 ms | 360, 914 ms, 0% | 122-148 MiB |
| drogon | 150/s, 3.5 ms / 5.9 ms, 55% | 315, 203 ms / 308 ms | 317, 1.2 s, 0.01% | 12-36 MiB |
| sveltekit | 150/s, 3.5 ms / 54 ms, 60% | 291, 219 ms / 285 ms | 285, 4.3 s, 0% | 128-153 MiB |
| phoenix | 150/s, 4.7 ms / 6.5 ms, 72% | 259, 246 ms / 331 ms | 274, 5.7 s, 0% | 196-319 MiB |
| tanstack-start | 150/s, 3.8 ms / 92 ms, 65% | 257, 249 ms / 311 ms | 242, 8.0 s, 0% | 130-167 MiB |
| rails | 150/s, 5.6 ms / 62 ms, 81% | 238, 271 ms / 328 ms | 208, 1.4 s, 0% | 111-115 MiB |
| react-router | 150/s, 4.6 ms / 94 ms, 76% | 219, 291 ms / 366 ms | 225, 1.5 s, 0% | 121-146 MiB |
| nuxt | 150/s, 816 ms / 1.4 s, 100% | 173, 368 ms / 441 ms | 169, 2.1 s, 0% | 144-193 MiB |
| django | **failed**: 121/s served, 4.0 s / 7.9 s, 100% | 129, 497 ms / 595 ms | 130, 2.2 s, 0% | 128-128 MiB |
| nextjs | **failed**: 74/s served, 2.6 s / 55.6 s, 85% | 98, 628 ms / 989 ms | 94, 28.4 s, 0% | 248-258 MiB |
| laravel | **failed**: 65/s served, 15.1 s / 15.8 s, 98% | 67, 946 ms / 1.1 s | 69, 4.0 s, 0% | 115-124 MiB |

### The item as JSON, fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 1.0 ms / 1.3 ms, 9% | 3,212, 21 ms / 26 ms | 3,011, 128 ms, 0% | 16-61 MiB |
| aspnet | 150/s, 1.8 ms / 13 ms, 39% | 1,168, 54 ms / 87 ms | 1,159, 296 ms, 0% | 60-88 MiB |
| axum-maud | 150/s, 1.7 ms / 2.3 ms, 19% | 908, 72 ms / 88 ms | 813, 441 ms, 0% | 16-55 MiB |
| topcoat | 150/s, 1.8 ms / 2.4 ms, 20% | 876, 74 ms / 89 ms | 809, 448 ms, 0% | 16-58 MiB |
| leptos | 150/s, 1.8 ms / 2.4 ms, 20% | 872, 75 ms / 89 ms | 795, 598 ms, 0% | 14-50 MiB |
| spring | 150/s, 2.2 ms / 7.8 ms, 56% | 714, 84 ms / 190 ms | 579, 848 ms, 0% | 424-461 MiB |
| nuxt | 150/s, 2.0 ms / 24 ms, 34% | 665, 98 ms / 153 ms | 588, 636 ms, 0% | 123-138 MiB |
| gin | 150/s, 1.7 ms / 2.9 ms, 24% | 661, 90 ms / 228 ms | 673, 565 ms, 0% | 14-39 MiB |
| sveltekit | 150/s, 2.0 ms / 21 ms, 34% | 580, 112 ms / 153 ms | 513, 604 ms, 0% | 115-141 MiB |
| tanstack-start | 150/s, 2.2 ms / 26 ms, 39% | 554, 121 ms / 158 ms | 470, 697 ms, 0% | 123-146 MiB |
| react-router | 150/s, 2.4 ms / 37 ms, 44% | 492, 135 ms / 175 ms | 436, 743 ms, 0% | 121-138 MiB |
| astro | 150/s, 2.6 ms / 41 ms, 48% | 459, 142 ms / 170 ms | 429, 743 ms, 0% | 124-143 MiB |
| drogon | 150/s, 3.0 ms / 6.9 ms, 54% | 330, 185 ms / 317 ms | 278, 1.5 s, 0% | 13-37 MiB |
| nextjs | 150/s, 3.3 ms / 118 ms, 61% | 298, 227 ms / 280 ms | 277, 4.2 s, 0% | 148-190 MiB |
| phoenix | 150/s, 4.0 ms / 6.0 ms, 64% | 291, 218 ms / 306 ms | 301, 5.8 s, 0% | 209-327 MiB |
| rails | 150/s, 3.7 ms / 41 ms, 58% | 272, 232 ms / 298 ms | 298, 1.0 s, 0% | 82-84 MiB |
| django | 150/s, 4.1 ms / 5.7 ms, 64% | 232, 276 ms / 331 ms | 237, 1.2 s, 0% | 76-77 MiB |
| laravel | 150/s, 8.1 ms / 60 ms, 90% | 173, 370 ms / 439 ms | 171, 1.7 s, 0% | 100-115 MiB |

### Instructions per request

| App | Item page: user / kernel | JSON: user / kernel |
|---|---|---|
| axum-maud | 74,267 / 33,644 | 198,250 / 32,514 |
| **corten** | 105,452 / 33,310 | 69,772 / 33,752 |
| drogon | 117,884 / 34,980 | 1,740,181 / 33,759 |
| gin | 471,610 / 76,026 | 644,373 / 62,721 |
| topcoat | 507,497 / 31,857 | 154,945 / 33,004 |
| aspnet | 1,508,102 / 59,478 | 268,503 / 57,548 |
| astro | 1,959,938 / 80,901 | 1,050,992 / 76,943 |
| phoenix | 2,199,301 / 97,173 | 1,562,483 / 87,154 |
| leptos | 2,785,670 / 35,945 | 204,551 / 32,365 |
| sveltekit | 4,544,397 / 47,204 | 687,824 / 34,027 |
| tanstack-start | 5,407,267 / 52,707 | 543,968 / 33,920 |
| rails | 5,432,000 / 348,243 | 2,258,602 / 293,342 |
| spring | 5,957,138 / 114,063 | 1,125,211 / 95,256 |
| react-router | 6,543,510 / 112,527 | 870,685 / 70,949 |
| nuxt | 10,075,389 / 72,977 | 424,236 / 32,127 |
| django | 12,890,471 / 361,832 | 1,886,715 / 172,428 |
| nextjs | 17,665,086 / 146,551 | 1,709,851 / 59,305 |
| laravel | **failed**: never answered within a minute | **failed**: never answered within a minute |

### Efficiency

What each request costs the machine, from the same runs as the tables above. Pages per
CPU-second is requests a second at 64 users over the share of its one core the app used: work per
request, which does not depend on whether the load kept the core busy. CPU for 300 pages/s is the
fixed-rate phase, what a steady modest load costs. Pages/s per MiB is the 64-user rate over the
app's peak memory in that phase. Instruction counts (above) are the steadiest form of the same
cost; these also include allocation, waiting and the kernel.

| App | Pages per CPU-second: memory / item API | JSON per CPU-second: memory / item API | CPU for 300 pages/s from memory | Pages/s per MiB, from memory | Peak memory, 64 users |
|---|---|---|---|---|---|
| axum-maud | 21,186 / 930 | 12,093 / 908 | 4.4% | 1,266 | 16.4 MiB |
| **corten** | 14,577 / 3,082 | 18,382 / 3,213 | 5.7% | 882 | 16.4 MiB |
| drogon | 14,083 / 315 | 1,686 / 330 | 5.1% | 1,097 | 12.8 MiB |
| topcoat | 4,675 / 806 | 14,193 / 876 | 11% | 306 | 15.3 MiB |
| gin | 4,517 / 676 | 3,793 / 662 | 10% | 187 | 24.1 MiB |
| aspnet | 3,304 / 877 | 9,261 / 1,169 | 32% | 38 | 86.9 MiB |
| leptos | 1,112 / 601 | 10,993 / 872 | 30% | 66 | 16.9 MiB |
| phoenix | 1,086 / 259 | 1,531 / 291 | 44% | 3.7 | 294.2 MiB |
| astro | 1,070 / 374 | 1,695 / 459 | 39% | 7.9 | 135.9 MiB |
| spring | 825 / 384 | 5,452 / 710 | 87% | 2.2 | 371.6 MiB |
| sveltekit | 639 / 291 | 2,661 / 580 | 55% | 4.3 | 149.3 MiB |
| tanstack-start | 515 / 257 | 3,018 / 554 | 65% | 3.1 | 164.4 MiB |
| react-router | 433 / 219 | 1,920 / 492 | 78% | 3.2 | 134.2 MiB |
| rails | failed (311) / 238 | 753 / 272 | failed (100%, 262/s served) | failed (2.1) | 151.1 MiB |
| nuxt | failed (278) / 173 | 5,612 / 665 | failed (74%, 185/s served) | failed (1.9) | 149 MiB |
| django | failed (203) / failed (129) | 877 / 233 | failed (100%, 185/s served) | failed (0.6) | 346.6 MiB |
| nextjs | failed (149) / failed (98) | 957 / 298 | failed (89%, 124/s served) | failed (0.7) | 214.5 MiB |
| laravel | **failed** / failed (68) | **failed** / 176 | **failed** | **failed** | **failed** |

Corten renders a page from memory with 69 µs of CPU (14,577 per CPU-second), 4.4x ASP.NET Core
(303 µs) and 13x Leptos (899 µs); axum + Maud with 47 µs and Drogon with 71.
Its JSON takes 54 µs, against Topcoat's 70, axum + Maud's 83, Leptos's 91 and ASP.NET Core's
108. At 300 pages a second it used 5.7% of its core, axum + Maud 4.4%,
Drogon 5.1%, ASP.NET Core 32% and Leptos 30%; that is 5,274 pages per CPU-second,
about a third of its rate at 64 users, since at a low rate each request also pays for waking the
server. It serves 882 pages a second per MiB: 13x Leptos (66) and 23x ASP.NET Core
(38); axum + Maud serves 1,266, and Drogon, which peaks lowest (12.8 MiB against Corten's
16.4), 1,097. From the item API, fetching and parsing the 55 KB item costs Corten about
260 µs a page, 3.7 times the page itself
([#166 Corten's item-API path spends six times as long fetching and parsing the item as rendering it, and the single-process item API could soon cap it](https://github.com/todd-skelton/corten/issues/166)).
Corten's pages per CPU-second from memory fell 20.9% from r13, on the same CPU model; the median
of the other apps that passed both rounds fell 16.8% (from -24.0% to -0.2%).

In r14 Corten's core was 102% busy at 64 users for the page from memory and 101% for the JSON: the
load generator, which from r7 also gets the item API's two cores (idle with items in memory), kept
it busy. Every one of Corten's phases has its CPU time read from the container's cgroup counter
rather than from once-a-second samples (`cpu-time.mjs`; `cpuCounted` in `summary.json`), and the
item API used 48-51% of one core at 64 users (49-51% at 256), of the 200% its two processes can
use, in Corten's item-API phases.

### Bytes the item page loads (raw / gzip, KB)

| App | HTML | JavaScript (files) | WASM | CSS |
|---|---|---|---|---|
| astro | 7.8 / 1.8 | 24.9 / 9.2 (3) | 0 | 8.3 / 2.2 |
| **corten** | 11.2 / 2.3 | 34.8 / 12.8 (4) | 0 | 9.0 / 2.7 |
| topcoat | 10.4 / 2.3 | 47.6 / 15.0 (2) | 0 | 9.0 / 2.7 |
| django | 7.9 / 1.9 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| aspnet | 7.9 / 2.0 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| spring | 7.8 / 1.9 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| axum-maud | 7.7 / 1.8 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| gin | 7.6 / 1.8 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| drogon | 7.7 / 1.8 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| sveltekit | 16.9 / 3.6 | 97.0 / 37.2 (10) | 0 | 8.5 / 2.2 |
| rails | 9.4 / 2.3 | 152.5 / 40.9 (8) | 0 | 9.0 / 2.7 |
| phoenix | 10.7 / 2.5 | 149.2 / 46.2 (1) | 0 | 9.0 / 2.7 |
| nuxt | 17.9 / 4.5 | 196.9 / 72.5 (4) | 0 | 8.3 / 2.2 |
| laravel | 11.4 / 2.9 | 255.8 / 84.3 (1) | 0 | 9.0 / 2.7 |
| react-router | 20.1 / 5.0 | 310.5 / 98.8 (4) | 0 | 8.5 / 2.4 |
| tanstack-start | 17.9 / 4.3 | 342.1 / 110.6 (4) | 0 | 8.5 / 2.4 |
| nextjs | 26.3 / 4.9 | 456.4 / 136.2 (7) | 0 | 8.5 / 2.2 |
| leptos | 18.6 / 3.7 | 24.9 / 7.0 (1) | 767.1 / 304.2 | 8.5 / 2.2 |

### Browser, median of 10 (p90)

| App | Interactive | LCP | Blocking time | Form action | Client navigation | JS heap |
|---|---|---|---|---|---|---|
| Desktop | | | | | | |
| django | 59 (61) ms | 88 ms | 0 ms | 86 ms | 26 (30) ms | 1.7 MB |
| gin | 59 (61) ms | 84 ms | 0 ms | 81 ms | 18 (18) ms | 1.7 MB |
| aspnet | 61 (63) ms | 84 ms | 0 ms | 84 ms | 19 (22) ms | 1.7 MB |
| axum-maud | 61 (79) ms | 84 ms | 0 ms | 79 ms | 18 (21) ms | 1.7 MB |
| drogon | 61 (65) ms | 84 ms | 0 ms | 82 ms | 20 (21) ms | 1.7 MB |
| topcoat | 66 (71) ms | 84 ms | 0 ms | 80 ms | 18 (18) ms | 1.8 MB |
| **corten** | 71 (78) ms | 84 ms | 0 ms | 87 ms | 16 (16) ms | 1.6 MB |
| astro | 73 (86) ms | 88 ms | 0 ms | 86 ms | 19 (20) ms | 1.6 MB |
| spring | 75 (97) ms | 108 ms | 0 ms | 91 ms | 43 (63) ms | 1.7 MB |
| rails | 79 (85) ms | 88 ms | 0 ms | 97 ms | 27 (38) ms | 2.1 MB |
| laravel | 93 (104) ms | 80 ms | 0 ms | 101 ms | 30 (32) ms | 2.2 MB |
| phoenix | 117 (139) ms | 116 ms | 0 ms | 78 ms | 21 (23) ms | 2.3 MB |
| leptos | 123 (135) ms | 92 ms | 0 ms | 83 ms | 28 (29) ms | 1.9 MB |
| nuxt | 123 (138) ms | 88 ms | 0 ms | 80 ms | 25 (26) ms | 2.9 MB |
| sveltekit | 142 (149) ms | 96 ms | 0 ms | 83 ms | 41 (43) ms | 2.4 MB |
| tanstack-start | 158 (170) ms | 92 ms | 1 ms | 79 ms | 33 (35) ms | 3.1 MB |
| nextjs | 191 (217) ms | 88 ms | 2 ms | 79 ms | 126 (203) ms | 3.4 MB |
| react-router | 210 (222) ms | 132 ms | 0 ms | 93 ms | 50 (56) ms | 2.7 MB |
| Mobile (4x CPU, 150 ms RTT, 1.6 Mbps) | | | | | | |
| aspnet | 455 (460) ms | 444 ms | 27 ms | 314 ms | 256 (259) ms | 1.7 MB |
| drogon | 460 (464) ms | 448 ms | 28 ms | 323 ms | 228 (230) ms | 1.7 MB |
| django | 467 (468) ms | 456 ms | 30 ms | 315 ms | 255 (258) ms | 1.7 MB |
| topcoat | 475 (496) ms | 456 ms | 24 ms | 294 ms | 227 (233) ms | 1.9 MB |
| **corten** | 494 (501) ms | 484 ms | 28 ms | 317 ms | 209 (211) ms | 1.7 MB |
| spring | 652 (652) ms | 504 ms | 29 ms | 326 ms | 257 (260) ms | 1.7 MB |
| axum-maud | 654 (655) ms | 500 ms | 25 ms | 321 ms | 253 (261) ms | 1.7 MB |
| gin | 654 (655) ms | 504 ms | 24 ms | 321 ms | 252 (260) ms | 1.7 MB |
| astro | 692 (694) ms | 528 ms | 26 ms | 340 ms | 240 (242) ms | 1.6 MB |
| laravel | 912 (919) ms | 464 ms | 56 ms | 354 ms | 224 (231) ms | 2.2 MB |
| sveltekit | 949 (972) ms | 512 ms | 65 ms | 297 ms | 318 (328) ms | 2.4 MB |
| phoenix | 1,005 (1,015) ms | 444 ms | 99 ms | 179 ms | 148 (164) ms | 2.4 MB |
| react-router | 1,196 (1,224) ms | 500 ms | 101 ms | 382 ms | 347 (368) ms | 2.8 MB |
| rails | 1,206 (1,217) ms | 564 ms | 30 ms | 323 ms | 271 (275) ms | 2.1 MB |
| nextjs | 1,538 (1,568) ms | 448 ms | 232 ms | 328 ms | 576 (585) ms | 3.3 MB |
| nuxt | 1,617 (1,621) ms | 564 ms | 175 ms | 302 ms | 280 (282) ms | 2.9 MB |
| leptos | 1,946 (1,963) ms | 476 ms | 120 ms | 323 ms | 263 (275) ms | 1.9 MB |
| tanstack-start | 2,479 (2,510) ms | 528 ms | 170 ms | 319 ms | 364 (374) ms | 3.2 MB |

### Build, four cores (seconds of wall time, CPU-seconds in brackets)

From r14's build step (`build.json`; Method, item 10), on cores 1-4 of the droplet: Clean is
dependencies (downloads included) and build together, the only column that compares like for
like; After the edit is the median of three production builds after a one-line view change on
the tree the clean build left; Dev is the debug build, for the apps whose development loop
compiles the whole program. Peak memory is the highest of any single step the app ran, its
dependencies included. Corten's row builds card-market, the whole example app, a different and
larger crate than the other Rust apps' item pages, though the data does not size them.

| App | Clean | Build alone | After the edit | Peak memory | Dev clean | Dev after the edit |
|---|---|---|---|---|---|---|
| laravel | 7.7 (6.1) | 3.0 | 2.9 (3.0) | 69 MiB |  |  |
| aspnet | 7.9 (10.7) | 6.3 | 5.9 (7.9) | 142 MiB |  |  |
| django | 9.3 (9.0) | 1.7 | 1.2 (1.2) | 57 MiB |  |  |
| sveltekit | 12.9 (13.4) | 4.2 | 3.7 (5.0) | 562 MiB |  |  |
| react-router | 15.7 (16.0) | 1.6 | 1.6 (2.2) | 448 MiB |  |  |
| astro | 16.9 (19.1) | 2.5 | 1.9 (2.7) | 412 MiB |  |  |
| tanstack-start | 17.8 (19.3) | 2.5 | 2.3 (3.6) | 525 MiB |  |  |
| nextjs | 21.0 (40.1) | 9.0 | 5.6 (13.6) | 845 MiB |  |  |
| spring | 24.2 (33.0) | 4.3 | 3.5 (9.6) | 231 MiB |  |  |
| phoenix | 32.6 (71.7) | 6.3 | 5.4 (8.7) | 234 MiB |  |  |
| gin | 37.5 (113.0) | 35.4 | 1.1 (1.8) | 1,209 MiB | 35.5 (109.0) | 1.4 (2.4) |
| axum-maud | 37.5 (112.5) | 36.3 | 13.8 (33.2) | 574 MiB | 22.6 (72.9) | 1.4 (1.3) |
| nuxt | 46.2 (48.4) | 8.4 | 7.6 (11.8) | 659 MiB |  |  |
| rails | 58.2 (119.6) | 1.5 | 1.2 (1.2) | 607 MiB |  |  |
| topcoat | 82.9 (251.2) | 80.9 | 30.5 (67.8) | 913 MiB | 42.6 (147.0) | 4.9 (6.9) |
| **corten** | 94.3 (224.8) | 91.7 | 37.3 (71.2) | 766 MiB | 41.2 (116.4) | 2.3 (2.3) |
| drogon | 106.4 (367.3) | 7.8 | 2.7 (2.7) | 1,175 MiB | 7.8 (21.5) | 2.5 (2.5) |
| leptos | 250.9 (772.5) | 248.4 | 86.1 (166.8) | 2,042 MiB | 131.4 (507.6) | 9.9 (22.4) |

Clean, the Rust apps took 37.5 s (axum + Maud) to 250.9 s (Leptos), Topcoat 82.9 s and Corten
94.3 s, against 7.7-58.2 s for the apps not written in Rust or C++ and 106.4 s for Drogon (98.5 s of
it building Drogon itself). After the edit the ranges separate: the Rust apps took 13.8-86.1 s
(Corten 37.3 s) and every other app 1.1-7.6 s. Corten's production build takes 2.5 times as long as
axum + Maud's clean build and 2.7 times as long after the edit, for a larger program (above). Its
development build after the edit, the compile `corten dev` runs after a save before it restarts the
server, took 2.3 s, against 1.4 s for axum + Maud and Gin and 2.5 s for Drogon; Topcoat took 4.9 s
and Leptos 9.9 s. Of Corten's clean build, card-market's own crate is the last 37.9 s of the 91.7 s
build (it depends on everything else), corten 19.0 s before it, and zstd-sys's build script (zstd's
C sources, for `corten::compress`) the slowest dependency at 28.1 s. In a separate diagnostic build
of card-market's crate, LLVM's optimization and thin LTO were 33.7 of its 37.8 s (89%), and macro
expansion, type checking and borrow checking 1.2 s together. Leptos's clean build peaked highest
(2.0 GiB), Corten's at 766 MiB.

### What the numbers say

1. Rendering from memory: axum + Maud serves the most item pages a second at 64 users
   (20,761), then Corten (14,460) and Drogon (14,043). Corten serves 4.4x ASP.NET Core
   (3,302) and 13x Leptos (1,112). A page cost Corten 105,452 user-mode instructions,
   axum + Maud 74,267 and Drogon 117,884; ASP.NET Core 1.51 million, Leptos
   2.8 million, Next.js 17.7 million.
2. JSON from memory: Corten leads with 18,068 a second, then Topcoat (14,126), axum + Maud
   (12,070), Leptos (10,981) and ASP.NET Core (9,254). Corten's JSON cost 69,772
   user-mode instructions, a third of Leptos's (204,551) and less than its own HTML page;
   Drogon's, written by JsonCpp, cost 1.74 million (1,686 a second).
3. With the item API every request fetches and parses about 55 KB of JSON, and that dominates.
   Corten parses only the fields the page reads (see below) and serves 3,081 pages a second,
   3.3x axum + Maud (930), 3.5x ASP.NET Core (877) and 5.1x Leptos (601); the rest
   that passed serve 173-806. As JSON from the item API: Corten 3,212, ASP.NET Core 1,168, axum +
   Maud 908, Topcoat 876, Leptos 872. At 150 a second Corten's page used 8.9% of its
   core, ASP.NET Core's 56%.
4. Failed: Next.js could not serve 300 pages a second from memory (124, p99 58.7 s) or 150 from
   the item API (74). Laravel did not answer within a minute for the in-memory runs, as before:
   each Octane worker loads the 508 items into PHP arrays, which PHP's default `memory_limit`
   (128 MB) does not allow; with the item API it served 65 of 150 pages a second (46.03% never
   sent) and kept up with the JSON. Django failed the in-memory page test again (185 of 300 pages a
   second, 33.91% never sent) and, for the first time, the item-API page test (121 of 150, 8.46%
   never sent). Nuxt, which passed in r13, failed the in-memory page test as in r12 (185, 11.44% never
   sent), and Rails failed it for the first time (262, 7.23% never sent, at 101% of its core).
5. Cold start: axum + Maud, Corten, Topcoat and Leptos answer 7.2, 8.1, 9.0 and 9.7 ms
   after their process starts, Gin 12 ms and Drogon 33 ms, and hold 1.2-3.3 MiB after the first
   request, Corten the least (1.223 MiB). The Node frameworks take 229-837 ms and
   26-53 MiB; Spring Boot 10.2 s and 148 MiB.
6. Browser: on desktop the server-rendered apps with small scripts (ASP.NET Core, Gin, Django,
   Drogon, Topcoat, Astro, Corten, Rails, Spring, axum + Maud) are interactive in
   59-79 ms. On the throttled phone Corten is interactive in 494 ms, after ASP.NET Core,
   Drogon and Django (455-467 ms) and Topcoat (475 ms), against 1,538 ms for Next.js,
   1,946 ms for Leptos (WASM) and 2,479 ms for TanStack Start; Spring, axum + Maud and Gin,
   which load the same htmx as ASP.NET Core and Django, take 652-654 ms. Corten's client
   navigation is the fastest on desktop (16 ms); on the phone Phoenix's is (148 ms against
   209 ms), over its already-open LiveView socket. Corten's item page loads 12.8 KB of
   JavaScript (gzip) in four files, up from 12.5 KB in r13, more than Astro's 9.2 KB and less
   than Topcoat's 15.0 KB in two.
7. Topcoat, axum + Maud, Gin and Drogon against Corten, from memory at 64 users, as pages and
   JSON a second: axum + Maud 1.44x and 0.67x (20,761 and 12,070), Drogon 0.97x and 0.09x
   (14,043 and 1,686), Topcoat 0.32x and 0.78x (4,674 and 14,126), and Gin 0.31x and 0.21x
   (4,516 and 3,792). Per CPU-second axum + Maud renders 21,186 pages and Drogon 14,083 against
   Corten's 14,577, Topcoat 4,675 and Gin 4,517.
   At 64 users Drogon peaks at 12.8 MiB and Topcoat at 15.3 MiB, below Corten's 16.4 MiB,
   axum + Maud at the same 16.4 MiB, and Gin at 24.1 MiB.

r14 ran on a Platinum 8168, as r12 and r13 did, on another droplet. Between r13 and r14 Corten
moved 110 commits; the other seventeen apps did not change, except that seven Dockerfiles name
their toolchain stage for the new build step (`build.mjs`), which does not change what they
build. Medians below are over the other apps that passed the test in both rounds. Their 64-user
requests a second fell by a median of 16.8% for the page from memory, 14.7% for the JSON from
memory, 16.2% for the item-API page and 15.3% for the item-API JSON: this droplet was slower
than r13's. Corten's fell 20.4% (18,157 to 14,460), 18.5% (22,172 to 18,068), 9.1%
(3,390 to 3,081) and 9.3% (3,540 to 3,212): 3.6 and 3.8 points more than the
others from memory, which is worse but within what one run varies, and 7.1 and 6.0 points
less from the item API. Its instruction counts, against r13's, held: 105,452 user-mode
instructions for the page (105,870, -0.4%) and 69,772 for the JSON (69,896,
-0.2%), with kernel counts -0.4% and +0.6%. Its item page's JavaScript grew
2.9% (12,789 to 13,155 bytes gzip, in the same four files) while its CSS (2,777) and
HTML (2,384) held; its cold start went from 8.4 to 8.1 ms (-3.6%; the other apps'
median +13.8%), and its peak memory at 64 users from 16.7 to 16.4 MiB. In the browser
Corten's desktop interactive went from 68 to 71 ms and its phone from 476 to 494 ms, while
the other apps moved by a median of +9.2% and +1.8%. Counts compare across rounds, and
requests a second only within one.

### Browser pass after the many-rows change (round browser-3, 2026-10-23)

`droplet.mjs browser-3 --suite browser` reran parity, bytes and the browser timing for all
fourteen apps on a c-8 droplet (Xeon Platinum 8280), with Corten at 77002fe (the runtime that
finds ref names in many new rows with one query per name); the other apps are unchanged. Every
browser run worked and parity passed on 16 pages for every app. Corten's item page loads 6.9 KB of
JavaScript (gzip, four files; browser-1 6.8 KB). All rows are in
[results/browser-3](results/browser-3); the README's browser table came from this round until r5. A
selection, median (p90):

| App | Interactive | LCP | Blocking time | Form action | Client navigation | JS heap |
|---|---|---|---|---|---|---|
| Desktop | | | | | | |
| corten | 50 (60) ms | 60 ms | 0 ms | 75 ms | 12 (13) ms | 1.4 MB |
| aspnet | 42 (43) ms | 60 ms | 0 ms | 76 ms | 15 (16) ms | 1.5 MB |
| django | 43 (48) ms | 64 ms | 0 ms | 77 ms | 19 (22) ms | 1.5 MB |
| astro | 48 (50) ms | 56 ms | 0 ms | 76 ms | 17 (18) ms | 1.4 MB |
| nextjs | 138 (141) ms | 68 ms | 0 ms | 74 ms | 105 (124) ms | 3.2 MB |
| leptos | 91 (95) ms | 64 ms | 0 ms | 75 ms | 23 (24) ms | 1.7 MB |
| tanstack-start | 105 (113) ms | 64 ms | 0 ms | 71 ms | 26 (28) ms | 2.9 MB |
| Mobile (4x CPU, 150 ms RTT, 1.6 Mbps) | | | | | | |
| corten | 441 (449) ms | 444 ms | 0 ms | 269 ms | 191 (196) ms | 1.4 MB |
| aspnet | 428 (434) ms | 400 ms | 0 ms | 287 ms | 240 (243) ms | 1.5 MB |
| django | 435 (436) ms | 396 ms | 0 ms | 288 ms | 239 (243) ms | 1.5 MB |
| astro | 615 (618) ms | 256 ms | 0 ms | 298 ms | 242 (246) ms | 1.4 MB |
| nextjs | 1360 (1379) ms | 400 ms | 133 ms | 303 ms | 431 (440) ms | 3.1 MB |
| leptos | 1819 (1825) ms | 408 ms | 54 ms | 283 ms | 239 (245) ms | 1.7 MB |
| tanstack-start | 2289 (2308) ms | 408 ms | 52 ms | 289 ms | 336 (341) ms | 2.9 MB |

Every app's desktop interactive times are 4-22% lower than in browser-1 on the same CPU model,
Corten's included (50 ms against 54); phone times moved by up to 4%. One run each, so the
difference between droplets is about as large as anything the change did to this page, which has
no list a script fills.

### Browser pass on the views runtime (round browser-1, 2026-10-23)

`droplet.mjs browser-1 --suite browser` reran parity, bytes and the browser timing for all
fourteen apps on a fresh c-8 droplet (Xeon Platinum 8280), with Corten at the commit that loads
handler modules as module scripts and serves views; the other apps are unchanged from r3. Every
browser run worked. Corten's item page now loads 6.8 KB of
JavaScript (gzip, four files) against 6.2 KB in r3; the rest are within 0.1 KB of r3. All rows
are in [results/browser-1](results/browser-1); the README's browser table came from this round until browser-3.
A selection, median (p90):

| App | Interactive | LCP | Blocking time | Form action | Client navigation | JS heap |
|---|---|---|---|---|---|---|
| Desktop | | | | | | |
| corten | 54 (63) ms | 64 ms | 0 ms | 75 ms | 13 (13) ms | 1.4 MB |
| aspnet | 45 (52) ms | 72 ms | 0 ms | 77 ms | 16 (20) ms | 1.5 MB |
| django | 47 (51) ms | 68 ms | 0 ms | 76 ms | 21 (21) ms | 1.5 MB |
| astro | 52 (57) ms | 60 ms | 0 ms | 75 ms | 18 (20) ms | 1.4 MB |
| nextjs | 150 (160) ms | 72 ms | 0 ms | 85 ms | 89 (144) ms | 3.2 MB |
| leptos | 109 (127) ms | 100 ms | 0 ms | 74 ms | 25 (25) ms | 1.7 MB |
| tanstack-start | 118 (123) ms | 68 ms | 0 ms | 84 ms | 28 (30) ms | 2.9 MB |
| Mobile (4x CPU, 150 ms RTT, 1.6 Mbps) | | | | | | |
| corten | 454 (458) ms | 452 ms | 6 ms | 290 ms | 200 (202) ms | 1.4 MB |
| aspnet | 430 (436) ms | 404 ms | 4 ms | 301 ms | 245 (248) ms | 1.5 MB |
| django | 439 (443) ms | 408 ms | 3 ms | 302 ms | 244 (252) ms | 1.5 MB |
| astro | 604 (622) ms | 264 ms | 0 ms | 326 ms | 244 (246) ms | 1.4 MB |
| nextjs | 1413 (1443) ms | 404 ms | 169 ms | 312 ms | 453 (462) ms | 3.1 MB |
| leptos | 1848 (1858) ms | 416 ms | 89 ms | 307 ms | 254 (258) ms | 1.7 MB |
| tanstack-start | 2332 (2346) ms | 420 ms | 69 ms | 302 ms | 351 (357) ms | 2.9 MB |

Against r3, which ran on the same CPU model (r4 ran on a Xeon Platinum 8168), one run each:
Corten's desktop interactive 54 ms (r3: 58), phone 454 ms (r3: 442), client navigation 13 and
200 ms (r3: 13 and 194). Parity passed on 16 pages for every app.

### ASP.NET Core with native AOT, the item as JSON (round aot1, 2026-11-04)

`droplet.mjs aot1 --apps corten,aspnet,aspnet-aot` ran the round's steps for three apps on one
c-8 droplet (Xeon Platinum 8168), the tree at `origin/main` `4a32139` with this app added. One
run each; differences under about 10% are noise (caveat 1). The instruction counts are missing:
the droplet restarted as `count.mjs` began, as r8's and r12's did (caveat 11), and the round went
on (`results/aot1/skipped.txt`). In this round both ASP.NET Core apps also logged four
Information lines from `HttpClient` for each call to the item API (Corten logs none per request;
both now log its warnings only), so their rows "from the item API" include that cost, which was
not measured; the rows "from memory" make no such call.

| | corten | aspnet (Razor Pages, JIT) | aspnet-aot (minimal API, AOT) |
|---|---|---|---|
| Cold start, median of 10 (min-max); the page, except aspnet-aot's JSON | 8.3 ms (6.9-13.7) | 833 ms (771-963) | 75 ms (63-105) |
| Memory after the first request / image | 1.2 MiB / 124 MB | 30.7 MiB / 342 MB | 14.0 MiB / 203 MB |
| JSON from memory, 300/s: p50 / p99, CPU | 0.3 / 0.4 ms, 4.5% | 0.4 / 0.6 ms, 16.2% | 0.4 / 0.6 ms, 12.9% |
| JSON from memory, 64 users: req/s, p99 | 22,152, 8.7 ms | 10,471, 10.8 ms | 7,981, 13.5 ms |
| JSON from memory, 256 users: req/s, p99 | 19,328, 34 ms | 10,581, 40 ms | 7,730, 53 ms |
| JSON from memory: per CPU-second, peak memory at 64 users | 22,816, 16.3 MiB | 10,480, 80.4 MiB | 7,985, 46.4 MiB |
| JSON from the item API, 150/s: p50 / p99, CPU | 0.9 / 1.1 ms, 7.4% | 1.6 / 6.7 ms, 31.5% | 1.5 / 3.2 ms, 22.4% |
| JSON from the item API, 64 users: req/s, p99 | 3,133, 26 ms | 1,275, 79 ms | 1,231, 75 ms |
| JSON from the item API: peak memory at 64 users | 17.8 MiB | 62.2 MiB | 29.9 MiB |

AOT's first JSON answer came eleven times sooner than the JIT build's first page, with less than
half its memory; the JIT figure includes Razor Pages' and static assets' startup, and its JSON
route's cold start was not measured, so this too is not AOT's alone. At a modest fixed rate from
memory AOT used a fifth less CPU (from the item API, 22.4% against 31.5%). Saturated, it serves fewer requests than the JIT build
(7,981 against 10,471 from memory; from the item API, 1,231 against 1,275, within noise), but the
two do not do the same work: the Razor app's JSON route runs none of the middleware aspnet-aot
runs for it (security headers, problem details, request timeouts, host list, compression), so
this round cannot say how much of the gap is AOT (which gives up the JIT's tuning to the running
program, Dynamic PGO) and how much is that middleware. Corten serves 2.8 times the AOT build's
JSON from memory and 2.5 times from the item API, starts in a ninth of the time (its page against AOT's JSON), and at 64 users
from memory peaked at 16.3 MiB against 46.4 MiB.

### Feature matrix, the bench apps as written (round conform2, 2026-11-04)

`conform.mjs` probes what each app does around the page and the JSON, rather than what its
source is said to do: the headers on a page and on the JSON, an ETag and a conditional GET,
compression when asked, the 404 and 405 formats, HEAD, an unknown Host, a 64 KiB header, a
liveness and a readiness endpoint, the page's price-alert form, and, with an item API that accepts
connections and never answers, how long the page (aspnet-aot: the JSON) and the readiness
endpoint take to answer. The form is found in the page and posted where and as the page posts it,
three times, as a browser at the bench's port sends it (its Host and a navigation's Accept): from
the page at normal size with its cookies (the control), from another site, and from the page with
a 3 MiB field, after which the page is read again. A refusal counts only when the app took the
control post and still served the page; every app with an HTTP form took it (200, Leptos a 302
that reports no failure) and served the page after. Every app reads its items from the item API
(`item-api/server.mjs` on the fixture), and every probe is sent from a container on the bench
network, not through a published port: on Docker Desktop the port proxy lost Corten's 413 to the
3 MiB form some of the time, and its WSL relay held the ports of removed containers without
forwarding them. Measured locally (Docker Desktop on Windows) from `cb-*` images built on
`origin/main` `5ef191ed` (`62f3199f` adds a `no_store` route form to Corten that card-market does
not use, and changes no app), by `conform.mjs` at `1cad81bd` with no local changes; one probe
each. Results in `results/conform2/conformance.json`.

The columns are what Corten does by default, so Corten's 0 below is by construction: the matrix
shows which of Corten's defaults each other app also has, not which app is better hardened. How a
column counts: a form is refused by any 4xx or 5xx (Next.js answers both posts with 500), by a
redirect that reports a failure (Leptos answers a server function called without its script with
a 302 and a `serverfnerror` header), or, for the 3 MiB field, by the connection closing while the
body is sent, which says only that the post was not taken, not why; caching counts when shared
caches may not keep the answer (`private` or `no-store`, and not `public`); the deadline is any 5xx within 35 s (Corten's
default is 30 s and card-market sets 10, gunicorn's worker timeout is 30); liveness is any
conventional path answering 200 (`/health/live`, `/healthz`, `/livez`, `/up`, `/health`,
Spring's actuator); readiness needs a 4xx or 5xx within 35 s while the items cannot be read; a
missing item or a wrong method on the JSON counts as JSON or problem+json; a CSP is strict when
only listed scripts run (no inline script without a nonce or hash, no eval, no wildcard host or
whole scheme such as `https:`). The
64 KiB header is not counted.

Columns not met, of 19 (Laravel and Phoenix of 17, as their forms are sent by their scripts, not
posted: Livewire's as a JSON request to its update endpoint, LiveView's over its websocket;
aspnet-aot of the 10 that are not about pages): corten 0, aspnet-aot 0, laravel 7, phoenix 9,
nextjs 12, react-router 12, topcoat 13, drogon 14, leptos 14, rails 14, sveltekit 14, astro 15,
django 15, spring 15, tanstack-start 15, aspnet 16, axum-maud 16, nuxt 17, gin 18.

1. Only Corten and aspnet-aot send all five security headers on the JSON (a CSP,
   `X-Content-Type-Options: nosniff`, `Referrer-Policy`, framing by `X-Frame-Options` or
   `frame-ancestors`, `Cross-Origin-Opener-Policy`). On the page Django sends
   four (no CSP), Phoenix four (its CSP leaves scripts unrestricted), Rails three; only Corten's
   page has a strict script CSP and a `Permissions-Policy`.
2. Only Corten (421) and aspnet-aot (400) refuse an unknown Host. Django would, but the bench app
   sets `ALLOWED_HOSTS = ["*"]`.
3. With the item API hung, Corten (503 in 10.1 s) and aspnet-aot (503 in 10.1 s) answered within
   their deadline, and Phoenix (500 in 15.2 s), Laravel (500 in 30.2 s) and Django (500 in 30.4 s)
   within 35 s; the other 14 held the page until the probe gave up at 45 s. Only Corten and
   aspnet-aot have a readiness endpoint, and both answered 503 in 2.1 s.
4. Of the 16 forms posted over HTTP, 10 refused the cross-site post and 10 the 3 MiB field; Leptos,
   Spring, Nuxt, axum-maud, Gin and Drogon took the cross-site post, and TanStack Start, React
   Router, Rails, ASP.NET Core (Razor Pages), Nuxt and Gin the 3 MiB field.

aspnet-aot was written for round aot1 to send Corten's headers, deadline and health endpoints, so
its row matching Corten's is by construction too. The tables above compare that work against apps
that do little of it; a tier where every app does the same is
[#807 bench/fullstack has no tier where every app implements the same production features, so its tables mix framework cost with feature cost](https://github.com/todd-skelton/corten/issues/807),
and checking that each app does the same work is
[#806 bench/fullstack checks that every app sends the same output but not that it does the same work, so a table can compare apps doing different jobs](https://github.com/todd-skelton/corten/issues/806).

### Corten's item API path

Corten's item-API page fell from 1,290 a second in r2 to 1,175 in r3 as the unchanged apps fell
5-22% (ASP.NET Core 1,278 to 1,209, Leptos 915 to 812): r3's droplet, not Corten. What remained
was Corten's own cost. Every request parsed the 55 KB response into a `serde_json::Value` and
then read the view from it, 3.47 million instructions an item in process (callgrind), against
about 124,000 to render the page. ASP.NET Core deserializes into typed records and skips the
members it does not use. `examples/card-market` now deserializes into `ApiItem`, structs of only
the fields the page reads (1.08 million instructions an item), and the same views come out for
all 508 fixture items. Leptos's app, as it is written, still parses into a `Value`.

Before and after on one c-8 droplet (Xeon Platinum 8280), the build before (`1ee12d4`) and after
one at a time, alternating, two rounds, items from the item API (`results/ab-typed-parse`):

| | Before | After | ASP.NET Core, same droplet |
|---|---|---|---|
| Page, 64 users: req/s | 1,249-1,270 | 3,128-3,176 | 1,344-1,373 |
| Page, 150/s: CPU, p99 | 13.3%, 1.6-1.7 ms | 6.6-6.7%, 1.1-1.3 ms | 25-27%, 6.1-6.2 ms |
| JSON, 64 users: req/s | 1,337-1,359 | 3,349-3,372 | |
| Page, user instructions a request | 4,395,372 | 1,385,381 | 5.4-9.2 million (JIT and GC vary) |
| JSON, user instructions a request | 4,387,294 | 1,398,989 | |

Instructions are `count.mjs ... api`, median of 3 x 5,000 requests. r14, on a Platinum 8168,
serves 3,081 item-API pages a second against ASP.NET Core's 877 (3.5x; 2.3x in the A/B and in r4,
3.2x in r5, 3.1x in r6 and r7, 3.4x in r8, r10, r12 and r13, 3.3x in r11), at 8.9% of its core at 150 a
second against 56%.

### Corten before and after its type and performance pass (Docker Desktop, 2026-10-21)

`ab.mjs` runs the image Corten's first r1 rows were measured with (`cb-corten`) and the current build
(`cb-corten-next`) one at a time on one CPU, items from memory, alternating, two rounds each
(`results/ab-r1`, `results/ab-r2`; the r2 build also has the faster island scan). "browser" sends
`Accept-Encoding: gzip, deflate, br, zstd` as Chrome, Edge, Firefox and current Safari do, so
compression is measured; the tables above sent `identity`. Measured, Docker Desktop with other
containers running, so throughput at 64 users moved by up to 25% between rounds of the same image.

| Accept-Encoding | Load | Before | After |
|---|---|---|---|
| identity | 300/s: CPU, p50 | 15-16%, 0.88 ms | 12%, 0.77 ms |
| identity | 64 users: req/s (4 runs) | 1,993-3,045 (median 2,700) | 2,702-3,488 (median 3,400) |
| browser | 300/s: CPU, p50 | 31-33%, 1.45 ms | 15%, 0.87 ms |
| browser | 64 users: req/s, p99 | 635-789, 145-169 ms | 1,835-2,401, 63-79 ms |
| browser | bytes per response | 2,800 (brotli 4) | 3,070 (zstd 1) |

What changed: pages compressed with zstd 1 (brotli 2, gzip 1 as fallbacks) by `corten::compress`
instead of tower-http's defaults (brotli 4 here), the runtime and assets compressed once at brotli
11, the item page borrowing the cached item instead of cloning it (about 40-50 µs per request
in `render_cost`), and the island scan looking for dashes instead of every tag (21 µs to 2.4 µs
on this page). Compressed responses are 9% larger for 2.4-3x the throughput.

### Build cost on a desktop (round local-2, 2026-11-03)

`build.mjs local-2 all 1` on Docker Desktop (WSL2, 8 CPUs, 9.7 GiB), each step pinned to cores
0-3, on a desktop with other work running (not recorded per step): one run each, kept for the
record; the Build table in Results is from r14, the first droplet round that measured it. The
one app measured twice moved 2.7x (TanStack Start's
build, 15.2 s in the round and 5.7 s later), so read only the large gaps, not one app against
its neighbour. The round ran an earlier `build.mjs`, with no memory cap and with TanStack
Start's rebuild touching the wrong file; its row is the later run, after the fix, with a 7.7 GiB
cap. Seconds of wall time, with CPU-seconds in brackets where given. Clean is dependencies
(downloads included) and build together, the only column that compares like for like: the Rust
apps compile every crate in the build, where npm, pip and Maven packages mostly arrive built
(Method, item 10). Corten's row builds card-market, the whole example app (its handlers, JSON
routes, messages and agent API), a different and larger crate than the other Rust apps' item
pages, though the data does not size them.

| App | Clean | Build alone | After the edit | Dev clean | Dev after the edit |
|---|---|---|---|---|---|
| Laravel | 9.4 (8) | 2.8 | 3.6 | | |
| ASP.NET Core | 37.0 (36) | 28.9 | 24.7 | | |
| SvelteKit | 67.8 (57) | 20.3 | 18.3 | | |
| Django | 70.3 (39) | 4.1 | 3.8 | | |
| Gin | 78.2 (205) | 60.2 | 1.3 | 67.1 (210) | 2.3 |
| Spring Boot | 87.1 (64) | 14.3 | 12.4 | | |
| React Router | 91.1 (57) | 11.3 | 11.9 | | |
| Phoenix | 94.1 (176) | 21.7 | 10.7 | | |
| TanStack Start | 94.6 (44) | 5.7 | 5.8 | | |
| Astro | 121.4 (77) | 27.7 | 12.6 | | |
| Rails | 130.3 (235) | 3.0 | 4.4 | | |
| Next.js | 145.8 (127) | 51.5 | 38.0 | | |
| axum + Maud | 169.0 (324) | 163.0 | 60.2 (95) | 69.0 (171) | 8.1 (3.5) |
| Nuxt | 205.7 (152) | 59.0 | 47.1 | | |
| Drogon | 292.0 (876) | 44.4 | 8.2 | 28.6 (63) | 5.8 |
| Topcoat | 306.5 (645) | 297.9 | 81.3 (162) | 170.1 (358) | 24.5 (22) |
| Corten | 333.0 (616) | 317.5 | 111.6 (158) | 109.9 (262) | 5.6 (3.7) |
| Leptos | 745.4 (2,114) | 731.3 | 222.6 (365) | 400.4 (1,223) | 32.7 (57) |

Where Rust is slow, measured here: a clean production build of a Rust app took 2.8 to 12.4
minutes on four cores, against 9 seconds to 3.4 minutes for every app not written in Rust except
Drogon (4.9 minutes, 4.1 of them building Drogon itself), and a production build after a one-line
view change 1 to 3.7 minutes, against under 50 seconds for every other app. Corten is third of
the four Rust apps, close to Topcoat: about 1.9x axum + Maud (333 s against 169 s clean, 112 s
against 60 s after the edit) and about half of Leptos. The development build after the edit is
where the apps whose development loop compiles the whole program are closest: Corten, axum +
Maud, Gin and Drogon took 2 to 8 seconds
(Drogon's development build starts with Drogon built), Topcoat 24.5 s and Leptos 32.7 s. The
other apps' development servers compile what a request needs as it
comes, which this does not time. Peak memory is not the problem: Leptos's clean build peaked at
1.9 GiB, Corten's at 743 MiB, Gin's at 1.1 GiB.

Where Corten's time goes, from its clean build's `--timings` and, for the shares of rustc's
passes, a separate diagnostic build of card-market's crate run after it:

1. card-market's own crate is the last 151 of the 317 seconds: it starts as corten ends, and
   depends on everything else. The diagnostic build's passes for it add up to 76 s, but the
   passes nest (`finish_ongoing_codegen` holds `LLVM_passes` and `LLVM_thinlto`), so the sum
   counts the code generation twice and the crate's compile was about 38 s (estimated, half the
   sum, as in r14; this run's raw output is not kept). So the clean build is the outlier, about
   four times the same compile, on a desktop whose load was not recorded. r14, on a droplet with
   nothing else running, measured both: rustc's `total` 37.8 s against 37.9 s in `--timings`
   (its passes summed to 74.5 s), so there the two agree, and LLVM's optimization and thin LTO
   (`finish_ongoing_codegen`) were 33.7 s of the 37.8 (89%). That is with the release profile's
   `codegen-units = 1`, `lto = "thin"` and `opt-level = 3`, which no run has varied yet. In the
   desktop's diagnostic build, macro expansion (0.3 s), type checking (0.65 s) and borrow
   checking (0.87 s) were under 2 s together, and monomorphization 5.6 s.
2. zstd-sys's build script (compiling zstd's C sources, for `corten::compress`) is the slowest
   dependency, and on the critical path here: it ends at 112 s and corten starts at 113 s. It
   took 93 s in this run, and 176 s and 237 s in two earlier desktop runs (not kept here) that
   limited the CPU with a four-core quota instead of pinning, so its time is not settled.
3. Then corten (54 s), then card-market; corten-macros (15 s, done at 102 s) did not hold either
   up in this run.
4. What the macros write into card-market, as lines of code for rustc to check and compile, not
   time measured: `#[derive(Deserialize)]` 4,884 lines over 19 uses, `messages!` 1,762 in one,
   `#[component]` 1,088 over 12, `html!` 917 over 18.

## Method

1. Machine: a DigitalOcean CPU-optimized droplet (`c-8`: 8 dedicated vCPUs, Intel Xeon Platinum
   8168 at 2.7 GHz in r12 to r14, 16 GB), Ubuntu 24.04, kernel 6.8, Docker 29.9, Node 24, created for the run
   and destroyed after it (`droplet.mjs`). The round runs on the droplet by itself, as a systemd
   unit (`corten-bench-<round>`), so it does not need the machine that started it:
   `droplet.mjs --detach` starts it and leaves, and `droplet.mjs <round> --collect` later
   downloads the results and destroys the droplet once the round has ended (or says where it is).
   On the droplet, `run-all.mjs --unattended` gives each call a time limit (at least twice the
   longest it took in r14; the builds' in item 10) and stops one that runs past it
   or prints nothing for an hour. A kernel lockup (r8's) panics the kernel, which reboots the
   droplet; the unit starts again at boot and the round goes on from the next step. A droplet
   that does not answer for 15 minutes while `droplet.mjs` waits or collects is power-cycled,
   with the same effect (the full comparison only; `--collect` gives up, leaving the droplet,
   only when DigitalOcean cannot be reached either). Either way the step it was in is skipped
   (in the build step, only the app that was building; the full comparison only: `--suite live`
   and `--suite browser` start no further), named in `run.log` and in `summary.json`
   (`skipped`), and its results are partly or
   wholly missing from the round. A round that starts again first saves the kernel's log of the
   boot that ended to `kernel-before-start-<n>.txt`; a panic's own report rarely reaches the
   journal (the lockup panics at once, and a droplet has no EFI store for pstore), so a log with
   no lockup in it is not proof there was none. A round that stops short keeps what it measured,
   and the droplet is destroyed only after its results are downloaded. Droplets of one size are
   not all the same CPU (r1's, r4's, r5's, r8's, r12's, r13's and r14's were a Platinum 8168, r2's, r3's,
   r6's, r7's, r10's and r11's a Platinum 8280), so times are compared within a round, never across rounds.
2. Cores: the app under test pinned to core 1 with 1 GiB of memory, the item API to cores 2-3,
   the load generator (k6) to cores 4-7, the system and Docker on core 0. One app runs at a time.
   From r7, with items in memory, k6 also gets cores 2-3, which the item API does not use then.
3. Cold start (`cold-start.mjs`): the container runs a shell that writes the time and execs the
   server; a probe in the same network namespace polls for the first 200 of an item page (items
   from the item API). Docker's own container setup is not in the number. 10 runs each.
4. Server rendering (`run-ssr.mjs`): a 30 s warmup with 32 users (long enough for the JVM's and
   .NET's JITs), then 60 s at a fixed rate (300/s from memory, 150/s from the API), 60 s with 64
   closed-loop users, and 60 s with 256. Items 1 to 500, skewed toward low ids. Responses
   uncompressed. CPU and memory are sampled from `docker stats` each second; from r7 each
   phase's CPU time is also read from the container's cgroup counter before and after it
   (`cpu-time.mjs`, `<app>-<phase>-cpu.json`). From r8 the tables' CPU at the fixed rate is that
   counted time.
   - Items in memory: a 27.7 MB fixture of 508 items loaded at start, so only the framework is
     measured.
   - Item API: every request fetches the item (about 55 KB of JSON) over HTTP from
     `item-api/server.mjs`, which serves the fixture's responses the way the production API does
     with a warm cache, and parses it. From r7 it runs one Node process per core it has (two), so
     it can serve about twice what r6's single process could; its CPU next to each item-API phase
     (`apiCpuPct`) is a percentage of one core, up to 200.
   - JSON: `GET /api/items/{id}` answers the view model the page renders (about 9 KB), written by
     the framework's usual JSON path. Same lookup as the page; only the output differs.
5. Instructions per request (`count.mjs`): `perf stat` counts the app container's user and
   kernel instructions while 4 users make 5,000 requests (items in memory) after a 30 s warmup;
   median of 3. On a bench host the counters are on the app's pinned cores only (`-C` with
   `BENCH_APP_CPUS`, not `-a`): the container runs nowhere else, so the count should be the same,
   with a counter on one core instead of one per core. Three rounds' droplets restarted as
   counting began, and the counters on the load generator's cores, switched at its every context
   switch, are a suspect
   ([#812 count.mjs restarts the bench droplet in some rounds (r8, r12, aot1), so those rounds have no instruction counts](https://github.com/todd-skelton/corten/issues/812));
   the first round counted this way is compared with r14. An app that cannot be counted is
   recorded as failed and the others are still counted, and `instructions.json` is written after
   each app. A count does not depend on what else the machine is doing, so it is steadier than
   time; it does not see waiting (I/O, locks) or how well the instructions run.
   `node count.mjs <round> 3 <apps> page,json api` counts with items from the item API instead,
   so the count includes fetching and parsing each 55 KB response (keys `<app>/<target>/api`).
   It first writes the running kernel (and any package waiting for a reboot) to
   `count-kernel.txt` and has `perf` count an idle second, stopping with the reason when `perf`
   does not fit that kernel or cannot count; `droplet.mjs` turns off the droplet's automatic
   package updates before provisioning, so a reboot comes back on the kernel `perf` was installed
   for.
6. Browser (`browser.mjs`): every app running at once on the app core, items from the item API,
   one app measured at a time; Playwright
   Chromium, cache disabled, 10 runs per app and profile, each cold load starting on a page
   from another origin. Desktop is unthrottled; mobile is 4x CPU slowdown, 150 ms RTT, 1.6 Mbps down.
   "Interactive" is when the page's own code marks itself ready (hydration finished, islands
   connected, or the framework's load event). Action is fill, submit, and wait for the
   confirmation. Navigation is home page to item page. From round r8, the action is not timed on
   `item_12345`, which has no listings: card-market refuses an alert there and the others set
   one, which is different work, so its median comes from 8 of 10 runs, where earlier rounds'
   came from all 10
   ([#259 Benchmark round r7 has no browser numbers: Corten refuses the price alert on item_12345, which has no listings, and browser.mjs times out waiting for 'Alert set'](https://github.com/todd-skelton/corten/issues/259)).
7. Bytes (`bytes.mjs`): every script, WASM and stylesheet the item page loads, fetched raw and
   gzipped here at level 6, so server compression settings do not change the comparison.
8. Efficiency (`summarize.mjs`): requests per CPU-second are a phase's requests over the app's
   CPU time in it (the cgroup counter; before r7, the 64-user rate over the sampled average),
   requests a second per MiB are the 64-user rate over the phase's peak memory, and the item API's
   sampled CPU is kept next to each item-API phase (`apiCpuPct`).
9. k6 runs with every local port and reuses ports in TIME_WAIT: gunicorn's sync workers close
   each connection, and at a few thousand requests a second k6 otherwise ran out of ports
   (r2's first attempt stopped there).
10. Build (`build.mjs`, from r14 the round's last step, so a slow build costs no other step its
    time; the compiled apps first): each app is built in containers pinned to four cores (cores
    1-4 of the droplet, the vCPUs of a standard CI runner; the host's first four elsewhere, so
    `nproc` and Node's `availableParallelism()` see four, though `os.cpus()` lists the host's),
    with up to 12 GiB of memory, from its toolchain image with its source copied in (its own build context and
    `.dockerignore`). The commands, image, directory, environment and fetched files are its
    Dockerfile's (`builds.mjs`; `builds.test.mjs` checks each against the Dockerfile):
    - Dependencies: the Dockerfile's dependency layer, the one Docker keeps while only the app's
      files change (`npm install`, `dotnet restore`, `mix deps.get` and `deps.compile`,
      `bundle install`, `go mod download`, Drogon's own build from source). The Rust
      Dockerfiles fetch and compile their crates in one step, so for them this is `cargo fetch`
      for the platforms the build targets, this benchmark's own split; Corten's fetches the whole
      workspace's crates, more than card-market compiles. It downloads, so its time is the
      network's as much as the tool's. Some builds still download a tool the first time: Phoenix's
      esbuild, cargo-leptos's wasm-bindgen and wasm-opt, and any Maven plugin `go-offline` missed.
    - Build: the Dockerfile's build step on that tree. Clean is the two together: the Rust apps
      compile every crate in the build step, Phoenix, Rails and Drogon compile theirs in the
      dependency step, and npm, pip and Maven packages mostly arrive built, so only the two
      together compare like for like, and that includes the downloads.
    - Rebuild: the build step again after one edit, a `title` on the price-alert form's submit
      button in the file holding the item page's markup (touched in the container, so its time
      is newer than the build's by the container's clock), on the tree the clean build left, so
      with the cache the tool keeps there (cargo's `target/`, `.next/cache`, `obj/`, `_build`).
      That is a developer building for production twice, or CI that keeps the tool's cache. A
      cargo rebuild that compiled nothing fails rather than reporting a no-op's time.
    - Development build, for the apps whose development loop compiles the whole program after a
      save (Rust, Go, C++; `corten dev` runs `cargo build`): the debug build clean and after the
      same edit. The other apps' development servers compile what a request needs as it comes,
      which this does not time. Topcoat's is taken as `cargo build` alone. Drogon's starts with
      Drogon itself installed (a Release build, from the dependency step), so its clean debug
      build compiles only the app, while the Rust and Go ones compile every dependency.
    - For Corten: cargo's per-crate timings of the clean build (Corten's alone runs with
      `--timings`, which records when each crate starts and ends), and rustc's passes
      (`-Ztime-passes`) and macro expansion statistics (`-Zmacro-stats`) for card-market's
      crate, flags rustc accepts on stable only with `RUSTC_BOOTSTRAP=1`, used for that report
      alone. Saved apart from the timings above, so a change to their format fails only them.

    Each step runs in a container of its own and reports its wall time, its CPU-seconds (the
    container's cgroup counter, the work done whatever the core count) and the peak of its
    processes' anonymous memory, sampled five times a second by bash builtins (the cgroup's own
    peak counts the page cache the build's output fills, which the kernel gives back under
    pressure). The sampler costs about 0.02 CPU-seconds a second (measured: 0.2 in a 10 s idle
    step). A step that fails says when the kernel killed its processes for passing the memory
    cap. `build.json` is synced and written after every step, so a stopped build keeps what it
    finished (`complete` is false until every measured step has run; Corten's diagnostics come
    after it). Each build call has a 90-minute limit and the
    step a 240-minute budget, counted afresh at each start as the unit's hours are (r14's step
    took 44.5 minutes, and its longest call, Leptos's, 14.2); a stopped or crashed build skips its
    app alone, a droplet restart in the step goes on with the next app, and past the budget the
    apps not built are named in `skipped.txt`.

## Caveats

1. One run per phase on one droplet. Differences under about 10% are noise.
2. The data is synthetic (generated catalog items), sized like a production marketplace's item
   pages. The item API is a stand-in that serves the same responses as the production API (a
   Rust service with Postgres and Redis, not in this repository).
3. JavaScript dependencies are pinned in each `package.json` without lockfiles, so transitive
   versions can drift between builds; the other apps have lockfiles.
4. The page is small. Apps with large client-side state (a seller grid of live rows) are a
   different test; see [bench/live](../live/README.md) for pushing updates.
5. Each framework runs its production defaults with the worker count its docs give for one CPU,
   in one CPU and 1 GiB. Nothing is tuned to get an app through a test: one that cannot start or
   cannot serve the fixed rate (more than 5% of it never sent, or more than 1% errors) is marked
   failed. Each could be tuned further (caching, streaming, more workers). None of the apps cache
   rendered pages. Gin runs `gin.Default()`, so it logs every request, as Rails and Phoenix do at
   their default level. Drogon runs one IO thread per core, as its docs advise, and counts its
   cores from its CPU affinity capped by the container's CPU quota, since its own count (`0`)
   sees every core of the host. Two settings differ from a library's default so that the item
   API source does the same work in every app: Gin keeps as many idle connections to the item API
   as its transport allows (Go's default keeps two per host; reqwest, .NET and Node have no
   per-host cap), and Drogon keeps one `HttpClient` (one connection) per request in flight on
   each thread. Drogon also hands the fixture parser's freed memory back to the system after
   loading (`malloc_trim`), so its memory with items in memory is the items' rather than the
   parser's peak, which the Rust apps avoid by parsing one item at a time. Drogon's JSON is
   JsonCpp's, Drogon's default, which writes 17 significant digits (`0.79000000000000004`), so
   its item JSON is about 3% longer than the others' for the same values.
6. The images include the live benchmark's routes (`/live/...`), which the item page does not
   touch.
7. Laravel ran with PHP's default `memory_limit` throughout r3 to r14. (r2's main run had raised it
   to 512 MB and measured Laravel again with the default afterwards; `results/r2/laravel-rerun.log`.)
8. r4's droplet had a slower CPU than r3's (Platinum 8168 against 8280). Django and Nuxt, which
   passed r3's in-memory page test near their limit, failed it on r4's; their settings did not
   change. r3's numbers stay in `results/r3/`. In r5, on the same CPU model as r4, Django passed
   it again (4.1% never sent) and Nuxt did not; in r6 and r7, on a Platinum 8280, both passed, and in
   r8, on a Platinum 8168 again, both passed (Nuxt with 1.73% never sent), as they did in r10 and r11,
   on a Platinum 8280. In r12, on a Platinum 8168 and rendering Corten's markup, Django (7.59% never
   sent) and Nuxt (10.01%) failed it. In r13, on the same CPU model, Django failed it again (7.62%
   never sent) and Nuxt passed (287 of 300 a second, 2.29% never sent). In r14, on the same CPU
   model, Django (33.91% never sent) and Nuxt (11.44%) failed it, and so did Rails, which had passed it
   in every round from r2 (262 of 300 a second, 7.23% never sent); Django also failed the item-API
   page test for the first time (121 of 150 a second, 8.46% never sent).
9. r14 measured the tree at `557920c` (`results/r14/commit.txt`).
   Changes merged to `main` after that are not in these numbers.
10. r6's efficiency numbers divide by CPU sampled once a second, which is coarse for an app using
    a few percent of its core (Corten's 5.7% at the fixed rate); from r7 they divide by the
    counted CPU time. Requests per CPU-second, like requests a second, compare only within a round.
11. r8 has no instruction counts. r8's droplet stopped answering both times the round reached
    `count.mjs`, right after its warmup (the first time with a kernel soft lockup); the cause is not
    known, and the round finished without that step
    ([#466 Benchmark round r8 has no instruction counts: its droplet locked up twice when count.mjs started counting](https://github.com/todd-skelton/corten/issues/466)).
    r9 measured nothing (its launcher hung in its own `ssh` call before the round started), so r10's counts were compared with
    r7's (the tree at `a9b1163`), the last round before it that counted: counts do not depend on
    the droplet, but Corten changed between the two commits. r12 has none either: its droplet
    restarted while `count.mjs` ran, and the round went on from the next step
    (`results/r12/skipped.txt`). r13 counted again, and its counts are compared with r11's
    (the tree at `512dc73`), the last round before it that counted, and r14's with r13's.
12. Through r11 the other apps rendered Corten's visible text with markup and stylesheets of their
    own (the stylesheets last changed on 2026-10-22, the markup on 2026-10-31 only for the plural
    counts), while Corten's item page changed in nine commits after that
    ([#642 The benchmark's other apps render Corten's item page text but not its markup or styles, which changed in nine commits since Oct 22](https://github.com/todd-skelton/corten/issues/642)).
    From r12 they render Corten's markup with its stylesheets, so their page bytes, browser times
    and server numbers are not like for like with r11's. r12 is the first round with Corten's markup
    and stylesheets in every app, and r13 the first with all eighteen; in each, and in r14, the
    round these tables come from, parity passed on 17 pages and `look.mjs` on 4 pages in 4 views,
    with no failures.
13. Build times depend on the toolchain images' versions (`rust:1-bookworm`, `node:24-bookworm-slim`
    and the rest move to their newest release) and, for dependencies, on the network and the
    package registries at the time. The rebuild keeps each tool's cache, which favors the tools
    that keep one; a Docker build without a cache mount starts each rebuild without it. Each
    rebuild runs in a new container, so a build server (.NET's, Gradle-style daemons) does not
    carry over, as on a fresh CI runner. Peak memory is anonymous memory only: the files rustc
    and the linkers map in are page cache and not counted.
14. Pinned to four cores, a tool that sizes its workers from Node's `os.cpus()` still sees the
    host's eight on the droplet, and may start more workers than four cores run at once.
15. Through r14 (and in aot1) the ASP.NET Core Razor Pages app logged four Information lines from
    `HttpClient` for each call to the item API (its `appsettings.json` left that category at the
    default); Corten logs none per request. Every result of its that read from the item API
    includes that cost (the rows "from the item API", cold start and the browser pass), which was
    not measured. It now logs `HttpClient` at Warning. Rails (`log_level` info) and Phoenix
    (`Plug.Telemetry` at info) log a line for every request, from memory too, as their production
    defaults do; whether a matched tier turns that off is
    [#806 bench/fullstack checks that every app sends the same output but not that it does the same work, so a table can compare apps doing different jobs](https://github.com/todd-skelton/corten/issues/806).

## Running it

```sh
# On a fresh droplet, created and destroyed for the run (needs doctl and an SSH key there):
node bench/fullstack/droplet.mjs r15 --ssh-key <id> [--region sfo2]   # waits for the round
node bench/fullstack/droplet.mjs r15 --ssh-key <id> --detach          # or start it and leave,
node bench/fullstack/droplet.mjs r15 --collect                        # then collect it later
# A few apps against each other, without the other apps' hours (r14's eighteen took 6.3):
node bench/fullstack/droplet.mjs aot2 --ssh-key <id> --apps corten,aspnet,aspnet-aot --detach
# Or by hand, from the repository root: the images, the fixture, then everything.
docker build -f examples/card-market/Dockerfile -t cb-corten .
for app in nextjs tanstack-start sveltekit react-router leptos topcoat axum-maud gin drogon django rails laravel aspnet aspnet-aot spring phoenix astro nuxt; do
  docker build -t cb-$app bench/fullstack/apps/$app
done
node bench/fullstack/fixtures/fetch.mjs http://localhost:18400   # or any {"item_1": {...}} file
cd bench/fullstack && node run-all.mjs r15 10   # BENCH_APPS=corten,aspnet-aot for only those
node conform.mjs [apps] [round]   # the feature matrix above (on the bench network; removes its containers when done)
node check-app.mjs <app>    # before adding an app: parity, look, JSON and 404s against corten
                            # (replaces fsw-corten and fsw-<app>, removed after unless keep; needs cb-corten from this tree)
node sync-styles.mjs        # after Corten's styles change (cb-corten rebuilt and running): copy them to every app
node look.mjs [apps]        # every app's pages in Chromium against Corten's, box by box
node build.mjs r15 [apps] [runs=3]   # build cost: clean, after a one-line change, and dev builds
```
