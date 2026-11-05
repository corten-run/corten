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
tables below are from r15, with all eighteen page apps plus JSON-only aspnet-aot, each page app rendering Corten's markup
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

All numbers are measured, from one run (`results/r15/`, 2026-11-05 UTC, the tree at `ec10c8f`)
on one DigitalOcean c-8 droplet (Intel Xeon Platinum 8168); see [Method](#method). Failed
means the app could not do the test with its usual settings in one CPU and 1 GiB (see caveat 5);
its other numbers are kept where it produced any. r14 (`results/r14/`, the same CPU model, Corten
at `557920c`, where Rails, Nuxt and Django failed the in-memory page test and Django also failed
the item-API page test), r13 (`results/r13/`, the same CPU model, Corten at `7f0b81f`), r12
(`results/r12/`, the same CPU model, Corten at `094f72d`, without Topcoat, axum + Maud, Gin
and Drogon and with no instruction counts), r11 (`results/r11/`, a Platinum 8280, Corten at
`512dc73`), r10 (`results/r10/`, a Platinum 8280, Corten at `f5c76a0`), r8
(`results/r8/`, a Platinum 8168, Corten at `2976f15`, with no instruction counts), r7
(`results/r7/`, a Platinum 8280, Corten at `a9b1163`, with no browser pass), r6
(`results/r6/`, a Platinum 8280, Corten at `cf8ac0f`, with CPU sampled once a second rather
than counted and a one-process item API), and r1-r5 are kept for the record; times are compared within a round, not across rounds.

### Cold start

| App | Process start to first 200, median (min-max) of 10 | Memory after first request | Image |
|---|---|---|---|
| axum-maud | 7.1 ms (5.8 ms-9.9 ms) | 1.344 MiB | 118 MB |
| **corten** | 7.7 ms (6.4 ms-48 ms) | 1.262 MiB | 124 MB |
| topcoat | 8.3 ms (6.8 ms-11 ms) | 1.5 MiB | 124 MB |
| leptos | 9.3 ms (7.4 ms-42 ms) | 1.492 MiB | 128 MB |
| gin | 11 ms (8.9 ms-12 ms) | 1.953 MiB | 135 MB |
| drogon | 33 ms (27 ms-42 ms) | 3.266 MiB | 122 MB |
| aspnet-aot (JSON) | 72 ms (67 ms-104 ms) | 14 MiB | 203 MB |
| sveltekit | 212 ms (193 ms-234 ms) | 25.48 MiB | 333 MB |
| tanstack-start | 261 ms (240 ms-336 ms) | 27.48 MiB | 332 MB |
| react-router | 332 ms (321 ms-414 ms) | 33.82 MiB | 353 MB |
| astro | 350 ms (317 ms-400 ms) | 36.26 MiB | 527 MB |
| nuxt | 356 ms (333 ms-422 ms) | 37.23 MiB | 335 MB |
| aspnet | 736 ms (704 ms-858 ms) | 30.82 MiB | 342 MB |
| nextjs | 771 ms (746 ms-954 ms) | 52.76 MiB | 385 MB |
| laravel | 960 ms (887 ms-1.0 s) | 95.39 MiB | 948 MB |
| rails | 1.2 s (1.1 s-5.8 s) | 63.88 MiB | 431 MB |
| django | 1.3 s (1.1 s-1.5 s) | 65.75 MiB | 276 MB |
| phoenix | 1.5 s (1.4 s-1.7 s) | 124.9 MiB | 262 MB |
| spring | 8.4 s (7.7 s-8.9 s) | 137.6 MiB | 516 MB |

### Item page, items in memory (no database)

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| axum-maud | 300/s, 0.2 ms / 0.4 ms, 4% | 22,287, 3.0 ms / 8.0 ms | 20,069, 32 ms, 0% | 15-19 MiB |
| **corten** | 300/s, 0.4 ms / 0.6 ms, 6% | 15,103, 4.7 ms / 8.9 ms | 13,613, 34 ms, 0% | 16-19 MiB |
| drogon | 300/s, 0.3 ms / 0.4 ms, 4% | 14,828, 4.4 ms / 9.7 ms | 15,381, 35 ms, 0% | 12-15 MiB |
| topcoat | 300/s, 0.4 ms / 0.6 ms, 9% | 5,120, 12 ms / 18 ms | 4,801, 72 ms, 0% | 15-18 MiB |
| gin | 300/s, 0.3 ms / 0.6 ms, 9% | 4,466, 14 ms / 32 ms | 4,309, 93 ms, 0% | 20-29 MiB |
| aspnet | 300/s, 0.6 ms / 2.8 ms, 26% | 3,846, 16 ms / 29 ms | 3,861, 110 ms, 0% | 86-86 MiB |
| phoenix | 300/s, 1.0 ms / 1.4 ms, 37% | 1,309, 48 ms / 67 ms | 1,349, 5.1 s, 0% | 291-299 MiB |
| leptos | 300/s, 1.0 ms / 1.3 ms, 26% | 1,276, 52 ms / 74 ms | 1,143, 376 ms, 0% | 16-34 MiB |
| astro | 300/s, 1.0 ms / 33 ms, 33% | 1,155, 50 ms / 125 ms | 1,078, 336 ms, 0% | 136-138 MiB |
| spring | 300/s, 1.3 ms / 6.1 ms, 54% | 977, 47 ms / 393 ms | 936, 934 ms, 0% | 355-376 MiB |
| sveltekit | 300/s, 1.3 ms / 23 ms, 44% | 773, 83 ms / 152 ms | 712, 465 ms, 0% | 146-151 MiB |
| tanstack-start | 300/s, 1.6 ms / 39 ms, 54% | 637, 98 ms / 168 ms | 628, 503 ms, 0% | 167-168 MiB |
| react-router | 300/s, 2.1 ms / 51 ms, 67% | 494, 120 ms / 204 ms | 481, 666 ms, 0% | 147-148 MiB |
| rails | 300/s, 6.1 ms / 229 ms, 86% | 417, 152 ms / 202 ms | 348, 860 ms, 0% | 137-139 MiB |
| nuxt | **failed**: 196/s served, 772 ms / 48.8 s, 73% | 311, 204 ms / 251 ms | 297, 4.9 s, 0% | 146-147 MiB |
| django | **failed**: 239/s served, 3.8 s / 4.8 s, 100% | 271, 234 ms / 311 ms | 263, 1.2 s, 0% | 346-346 MiB |
| nextjs | **failed**: 136/s served, 1.4 s / 58.6 s, 94% | 168, 383 ms / 500 ms | 162, 20.4 s, 0% | 211-217 MiB |
| laravel | **failed**: never answered /items/item_1 within a minute | - | - | - |

### The item as JSON, items in memory

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 300/s, 0.3 ms / 0.4 ms, 4% | 22,553, 2.5 ms / 8.3 ms | 21,291, 33 ms, 0% | 16-19 MiB |
| topcoat | 300/s, 0.2 ms / 0.4 ms, 4% | 15,083, 4.6 ms / 8.2 ms | 14,522, 33 ms, 0% | 15-18 MiB |
| axum-maud | 300/s, 0.3 ms / 0.4 ms, 4% | 13,049, 5.4 ms / 8.3 ms | 13,169, 33 ms, 0% | 15-19 MiB |
| leptos | 300/s, 0.3 ms / 0.4 ms, 5% | 12,461, 5.7 ms / 8.5 ms | 11,444, 34 ms, 0% | 15-18 MiB |
| aspnet | 300/s, 0.3 ms / 0.6 ms, 15% | 10,780, 5.6 ms / 11 ms | 11,326, 39 ms, 0% | 78-81 MiB |
| aspnet-aot | 300/s, 0.4 ms / 0.7 ms, 12% | 8,708, 6.9 ms / 13 ms | 8,346, 52 ms, 0% | 45-50 MiB |
| nuxt | 300/s, 0.4 ms / 0.7 ms, 10% | 6,648, 8.5 ms / 33 ms | 6,370, 83 ms, 0% | 98-99 MiB |
| spring | 300/s, 0.3 ms / 1.5 ms, 28% | 6,111, 6.5 ms / 98 ms | 6,532, 362 ms, 0% | 361-385 MiB |
| gin | 300/s, 0.3 ms / 1.0 ms, 10% | 3,945, 16 ms / 34 ms | 3,642, 114 ms, 0% | 25-34 MiB |
| tanstack-start | 300/s, 0.4 ms / 4.9 ms, 13% | 3,235, 19 ms / 53 ms | 3,190, 134 ms, 0% | 147-149 MiB |
| sveltekit | 300/s, 0.6 ms / 5.6 ms, 18% | 2,887, 21 ms / 59 ms | 2,810, 155 ms, 0% | 126-129 MiB |
| react-router | 300/s, 0.7 ms / 13 ms, 20% | 2,183, 28 ms / 85 ms | 2,128, 198 ms, 0% | 120-121 MiB |
| drogon | 300/s, 0.8 ms / 1.2 ms, 20% | 2,128, 22 ms / 51 ms | 1,804, 208 ms, 0% | 12-14 MiB |
| astro | 300/s, 0.7 ms / 24 ms, 21% | 1,902, 30 ms / 83 ms | 1,825, 203 ms, 0% | 135-136 MiB |
| phoenix | 300/s, 0.7 ms / 1.1 ms, 28% | 1,645, 40 ms / 55 ms | 1,666, 2.2 s, 0% | 301-335 MiB |
| django | 300/s, 1.0 ms / 1.4 ms, 36% | 1,083, 59 ms / 80 ms | 1,076, 296 ms, 0% | 294-294 MiB |
| nextjs | 300/s, 0.9 ms / 34 ms, 31% | 1,080, 53 ms / 125 ms | 1,063, 323 ms, 0% | 173-174 MiB |
| rails | 300/s, 1.3 ms / 11 ms, 43% | 831, 79 ms / 103 ms | 803, 399 ms, 0% | 129-131 MiB |
| laravel | **failed**: never answered /api/items/item_1 within a minute | - | - | - |

### Item page, item fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 0.7 ms / 1.2 ms, 7% | 3,339, 20 ms / 26 ms | 3,122, 158 ms, 0% | 16-60 MiB |
| aspnet | 150/s, 1.5 ms / 8.8 ms, 37% | 1,184, 53 ms / 81 ms | 1,100, 295 ms, 0% | 69-99 MiB |
| axum-maud | 150/s, 1.3 ms / 1.9 ms, 16% | 941, 70 ms / 84 ms | 912, 536 ms, 0% | 16-62 MiB |
| topcoat | 150/s, 1.5 ms / 2.2 ms, 19% | 835, 77 ms / 95 ms | 809, 462 ms, 0% | 16-59 MiB |
| gin | 150/s, 1.5 ms / 2.7 ms, 22% | 726, 83 ms / 207 ms | 716, 538 ms, 0% | 13-39 MiB |
| leptos | 150/s, 1.8 ms / 2.7 ms, 24% | 706, 92 ms / 117 ms | 608, 566 ms, 0% | 16-54 MiB |
| spring | 150/s, 2.6 ms / 9.3 ms, 64% | 471, 134 ms / 246 ms | 358, 1.4 s, 0% | 419-458 MiB |
| drogon | 150/s, 2.4 ms / 5.4 ms, 44% | 431, 138 ms / 256 ms | 416, 986 ms, 0% | 13-36 MiB |
| astro | 150/s, 2.2 ms / 40 ms, 44% | 427, 152 ms / 201 ms | 398, 795 ms, 0% | 127-149 MiB |
| sveltekit | 150/s, 2.6 ms / 28 ms, 49% | 328, 193 ms / 254 ms | 319, 987 ms, 0% | 138-156 MiB |
| phoenix | 150/s, 3.6 ms / 5.6 ms, 59% | 319, 199 ms / 280 ms | 322, 5.7 s, 0% | 223-311 MiB |
| tanstack-start | 150/s, 3.0 ms / 40 ms, 55% | 293, 217 ms / 282 ms | 284, 4.1 s, 0% | 136-171 MiB |
| rails | 150/s, 4.5 ms / 49 ms, 69% | 282, 226 ms / 299 ms | 254, 1.2 s, 0% | 110-116 MiB |
| react-router | 150/s, 3.5 ms / 48 ms, 62% | 261, 243 ms / 319 ms | 262, 5.4 s, 0% | 136-151 MiB |
| nuxt | 150/s, 7.7 ms / 240 ms, 79% | 200, 321 ms / 371 ms | 197, 14.5 s, 0% | 131-196 MiB |
| django | 150/s, 28 ms / 257 ms, 91% | 157, 403 ms / 525 ms | 166, 2.0 s, 0% | 128-128 MiB |
| nextjs | **failed**: 79/s served, 2.6 s / 52.9 s, 79% | 108, 586 ms / 781 ms | 102, 26.5 s, 0% | 210-249 MiB |
| laravel | **failed**: 80/s served, 11.4 s / 13.5 s, 99% | 84, 761 ms / 905 ms | 84, 3.5 s, 0% | 114-125 MiB |

### The item as JSON, fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 0.7 ms / 1.0 ms, 6% | 3,533, 19 ms / 24 ms | 3,288, 118 ms, 0% | 16-57 MiB |
| aspnet | 150/s, 1.1 ms / 5.5 ms, 26% | 1,826, 34 ms / 57 ms | 1,612, 214 ms, 0% | 59-85 MiB |
| aspnet-aot | 150/s, 1.2 ms / 3.0 ms, 19% | 1,397, 45 ms / 69 ms | 1,278, 255 ms, 0% | 25-51 MiB |
| topcoat | 150/s, 1.5 ms / 2.1 ms, 18% | 950, 67 ms / 88 ms | 939, 397 ms, 0% | 16-56 MiB |
| leptos | 150/s, 1.4 ms / 2.1 ms, 16% | 944, 71 ms / 87 ms | 901, 419 ms, 0% | 15-55 MiB |
| axum-maud | 150/s, 1.4 ms / 2.0 ms, 17% | 917, 71 ms / 90 ms | 876, 438 ms, 0% | 18-60 MiB |
| spring | 150/s, 1.5 ms / 5.1 ms, 41% | 819, 73 ms / 165 ms | 667, 737 ms, 0% | 411-447 MiB |
| nuxt | 150/s, 1.7 ms / 20 ms, 30% | 724, 89 ms / 141 ms | 667, 573 ms, 0% | 126-141 MiB |
| gin | 150/s, 1.4 ms / 2.5 ms, 21% | 715, 82 ms / 223 ms | 716, 552 ms, 0% | 13-44 MiB |
| tanstack-start | 150/s, 1.7 ms / 20 ms, 31% | 672, 98 ms / 130 ms | 573, 568 ms, 0% | 126-148 MiB |
| sveltekit | 150/s, 1.5 ms / 17 ms, 28% | 654, 99 ms / 137 ms | 583, 534 ms, 0% | 132-151 MiB |
| react-router | 150/s, 1.8 ms / 30 ms, 37% | 549, 120 ms / 153 ms | 481, 672 ms, 0% | 127-145 MiB |
| astro | 150/s, 1.9 ms / 31 ms, 37% | 519, 124 ms / 155 ms | 502, 645 ms, 0% | 128-147 MiB |
| rails | 150/s, 2.8 ms / 29 ms, 46% | 388, 160 ms / 254 ms | 346, 932 ms, 0% | 83-85 MiB |
| phoenix | 150/s, 3.2 ms / 5.5 ms, 54% | 378, 166 ms / 243 ms | 364, 5.6 s, 0% | 211-311 MiB |
| drogon | 150/s, 2.7 ms / 6.4 ms, 52% | 362, 168 ms / 289 ms | 357, 1.1 s, 0% | 14-36 MiB |
| nextjs | 150/s, 2.2 ms / 65 ms, 46% | 343, 194 ms / 248 ms | 316, 2.5 s, 0% | 151-192 MiB |
| django | 150/s, 3.1 ms / 5.0 ms, 50% | 292, 218 ms / 278 ms | 313, 998 ms, 0% | 76-77 MiB |
| laravel | 150/s, 4.6 ms / 16 ms, 65% | 237, 264 ms / 501 ms | 241, 1.8 s, 0% | 102-119 MiB |

### Instructions per request

| App | Item page: user / kernel | JSON: user / kernel |
|---|---|---|
| axum-maud | 74,374 / 33,127 | 197,620 / 31,984 |
| **corten** | 103,544 / 32,705 | 70,588 / 32,897 |
| drogon | 117,505 / 32,945 | 1,735,861 / 33,565 |
| gin | 471,081 / 76,183 | 647,590 / 63,971 |
| topcoat | 508,209 / 31,827 | 155,497 / 32,556 |
| aspnet | 1,252,878 / 58,341 | 268,255 / 57,243 |
| astro | 2,021,422 / 80,168 | 1,056,047 / 77,236 |
| phoenix | 2,198,198 / 95,434 | 1,564,005 / 86,464 |
| leptos | 2,782,386 / 35,722 | 204,433 / 32,207 |
| sveltekit | 4,517,921 / 47,216 | 676,583 / 33,684 |
| tanstack-start | 5,340,895 / 50,881 | 539,285 / 33,769 |
| rails | 5,373,073 / 338,913 | 2,277,778 / 292,709 |
| spring | 6,133,819 / 107,771 | 1,331,146 / 100,305 |
| react-router | 6,502,995 / 111,181 | 863,951 / 70,784 |
| nuxt | 9,871,286 / 67,567 | 406,591 / 32,020 |
| django | 12,890,548 / 359,990 | 1,883,430 / 173,258 |
| nextjs | 17,518,478 / 137,022 | 1,696,362 / 58,494 |
| laravel | **failed**: never answered within a minute | **failed**: never answered within a minute |
| aspnet-aot (JSON only) | - | 376,649 / 57,479 |

### Efficiency

What each request costs the machine, from the same runs as the tables above. Pages per CPU-second is requests a second at 64 users over the share of its one core the app used; CPU for 300 pages/s is the fixed-rate phase; pages/s per MiB is the 64-user rate over peak memory.

| App | Pages per CPU-second: memory / item API | JSON per CPU-second: memory / item API | CPU for 300 pages/s from memory | Pages/s per MiB, from memory | Peak memory, 64 users |
|---|---|---|---|---|---|
| axum-maud | 22,814 / 941 | 13,096 / 918 | 3.5% | 1,376 | 16.2 MiB |
| **corten** | 15,258 / 3,340 | 23,220 / 3,533 | 6.2% | 894 | 16.9 MiB |
| drogon | 14,914 / 431 | 2,129 / 362 | 4.2% | 1,159 | 12.8 MiB |
| topcoat | 5,121 / 836 | 15,181 / 950 | 8.7% | 328 | 15.6 MiB |
| gin | 4,467 / 726 | 3,946 / 715 | 8.7% | 185 | 24.1 MiB |
| aspnet | 3,845 / 1,185 | 10,789 / 1,826 | 26% | 44 | 87 MiB |
| phoenix | 1,311 / 319 | 1,648 / 378 | 37% | 4.5 | 291.1 MiB |
| leptos | 1,276 / 706 | 12,496 / 944 | 26% | 80 | 15.9 MiB |
| astro | 1,155 / 427 | 1,902 / 519 | 33% | 8.4 | 137.6 MiB |
| spring | 978 / 470 | 6,119 / 815 | 54% | 2.7 | 356.4 MiB |
| sveltekit | 773 / 328 | 2,887 / 654 | 44% | 5.3 | 146.5 MiB |
| tanstack-start | 638 / 293 | 3,236 / 672 | 54% | 3.8 | 167.9 MiB |
| react-router | 494 / 261 | 2,184 / 549 | 67% | 3.4 | 147.3 MiB |
| rails | 417 / 282 | 831 / 388 | 86% | 2.9 | 142.7 MiB |
| nuxt | failed (311) / 200 | 6,649 / 724 | failed (73%, 196/s served) | failed (2.1) | 146.5 MiB |
| django | failed (271) / 157 | 1,085 / 292 | failed (100%, 239/s served) | failed (0.8) | 346.4 MiB |
| nextjs | failed (168) / failed (108) | 1,080 / 343 | failed (94%, 136/s served) | failed (0.8) | 211.5 MiB |
| laravel | **failed** / failed (85) | **failed** / 238 | **failed** | **failed** | **failed** |
| aspnet-aot (JSON only) | - / - | 8,712 / 1,399 | - | - | - |

Corten renders a page from memory with 66 µs of CPU (15,258 per CPU-second), against ASP.NET Core's 260 µs and Leptos's 784 µs; axum + Maud costs 44 µs and Drogon 67 µs. At 300 pages a second it used 6.2% of its core, and it serves 894 pages a second per MiB. From the item API, fetching and parsing the 55 KB item costs Corten about 230 µs a page, 3.6 times the page itself ([#166 Corten's item-API path spends six times as long fetching and parsing the item as rendering it, and the single-process item API could soon cap it](https://github.com/corten-run/corten/issues/166)).

At 64 users Corten's sampled CPU for the page and JSON from memory was 101.7% and 99.2% of
the app core, so the load kept it busy. Every Corten phase's per-CPU-second figure uses CPU
time counted from the cgroup counter (`cpuCounted: true`), not those samples. The item API
used 44.2% and 47.0% of one core for the page and JSON (44.6% and 47.4% at 256 users),
of the 200% its two processes can use.

### Bytes the item page loads (raw / gzip, KB)

| App | HTML | JavaScript (files) | WASM | CSS |
|---|---|---|---|---|
| astro | 7.8 / 1.8 | 24.9 / 9.2 (3) | 0 | 8.3 / 2.2 |
| **corten** | 11.2 / 2.3 | 34.9 / 12.9 (4) | 0 | 9.0 / 2.7 |
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
| gin | 53 (57) ms | 76 ms | 0 ms | 82 ms | 16 (17) ms | 1.7 MB |
| django | 54 (55) ms | 76 ms | 0 ms | 84 ms | 23 (24) ms | 1.7 MB |
| aspnet | 54 (58) ms | 76 ms | 0 ms | 87 ms | 17 (20) ms | 1.7 MB |
| drogon | 54 (59) ms | 76 ms | 0 ms | 74 ms | 17 (19) ms | 1.7 MB |
| **corten** | 61 (74) ms | 72 ms | 0 ms | 79 ms | 15 (15) ms | 1.6 MB |
| topcoat | 64 (70) ms | 72 ms | 0 ms | 80 ms | 16 (16) ms | 1.8 MB |
| astro | 66 (71) ms | 80 ms | 0 ms | 88 ms | 16 (17) ms | 1.6 MB |
| spring | 67 (87) ms | 96 ms | 0 ms | 73 ms | 37 (60) ms | 1.7 MB |
| rails | 69 (77) ms | 76 ms | 0 ms | 88 ms | 26 (36) ms | 2.1 MB |
| axum-maud | 76 (78) ms | 72 ms | 0 ms | 80 ms | 15 (16) ms | 1.7 MB |
| laravel | 82 (91) ms | 80 ms | 0 ms | 91 ms | 26 (28) ms | 2.2 MB |
| phoenix | 104 (129) ms | 92 ms | 0 ms | 78 ms | 18 (19) ms | 2.3 MB |
| leptos | 112 (118) ms | 84 ms | 0 ms | 86 ms | 23 (26) ms | 1.9 MB |
| nuxt | 113 (121) ms | 76 ms | 0 ms | 84 ms | 24 (25) ms | 2.9 MB |
| sveltekit | 128 (134) ms | 88 ms | 0 ms | 72 ms | 34 (35) ms | 2.4 MB |
| tanstack-start | 147 (154) ms | 80 ms | 0 ms | 81 ms | 30 (31) ms | 3.1 MB |
| nextjs | 169 (183) ms | 88 ms | 0 ms | 84 ms | 141 (181) ms | 3.4 MB |
| react-router | 190 (208) ms | 116 ms | 0 ms | 95 ms | 43 (50) ms | 2.7 MB |
| Mobile (4x CPU, 150 ms RTT, 1.6 Mbps) | | | | | | |
| aspnet | 450 (453) ms | 440 ms | 18 ms | 295 ms | 247 (249) ms | 1.7 MB |
| django | 454 (457) ms | 428 ms | 16 ms | 288 ms | 247 (252) ms | 1.7 MB |
| drogon | 455 (458) ms | 436 ms | 19 ms | 304 ms | 217 (222) ms | 1.7 MB |
| topcoat | 469 (478) ms | 452 ms | 18 ms | 282 ms | 220 (224) ms | 1.9 MB |
| **corten** | 474 (482) ms | 472 ms | 16 ms | 286 ms | 200 (205) ms | 1.6 MB |
| spring | 648 (654) ms | 488 ms | 13 ms | 288 ms | 247 (253) ms | 1.7 MB |
| axum-maud | 651 (653) ms | 484 ms | 15 ms | 296 ms | 242 (246) ms | 1.7 MB |
| gin | 651 (653) ms | 488 ms | 16 ms | 295 ms | 243 (253) ms | 1.7 MB |
| astro | 684 (692) ms | 520 ms | 16 ms | 306 ms | 232 (235) ms | 1.6 MB |
| laravel | 894 (909) ms | 460 ms | 39 ms | 345 ms | 216 (220) ms | 2.2 MB |
| sveltekit | 917 (945) ms | 496 ms | 42 ms | 287 ms | 304 (307) ms | 2.4 MB |
| phoenix | 963 (980) ms | 432 ms | 67 ms | 162 ms | 137 (140) ms | 2.3 MB |
| react-router | 1,137 (1,159) ms | 480 ms | 73 ms | 356 ms | 314 (321) ms | 2.8 MB |
| rails | 1,197 (1,202) ms | 548 ms | 13 ms | 306 ms | 259 (264) ms | 2.1 MB |
| nextjs | 1,477 (1,511) ms | 432 ms | 190 ms | 299 ms | 537 (570) ms | 3.3 MB |
| nuxt | 1,566 (1,597) ms | 556 ms | 131 ms | 277 ms | 267 (277) ms | 2.9 MB |
| leptos | 1,929 (1,938) ms | 460 ms | 93 ms | 293 ms | 242 (251) ms | 1.9 MB |
| tanstack-start | 2,433 (2,462) ms | 536 ms | 146 ms | 304 ms | 343 (349) ms | 3.2 MB |

### Build, four cores (seconds of wall time, CPU-seconds in brackets)

From r15's build step (`build.json`; Method, item 10), on cores 1-4 of the droplet: Clean is
dependencies (downloads included) and build together, the only column that compares like for
like; After the edit is the median of three production builds after a one-line view change on
the tree the clean build left; Dev is the debug build, for the apps whose development loop
compiles the whole program. Peak memory is the highest of any single step the app ran, its
dependencies included. Corten's row builds card-market, the whole example app, a different and
larger crate than the other Rust apps' item pages, though the data does not size them.

| App | Clean | Build alone | After the edit | Peak memory | Dev clean | Dev after the edit |
|---|---|---|---|---|---|---|
| laravel | 7.1 (5.7) | 2.8 | 2.8 (2.8) | 62 MiB |  |  |
| django | 7.5 (6.8) | 1.1 | 1.1 (1.1) | 57 MiB |  |  |
| aspnet | 7.7 (10.1) | 6.2 | 5.7 (7.4) | 147 MiB |  |  |
| sveltekit | 13.6 (12.2) | 3.9 | 3.4 (4.5) | 574 MiB |  |  |
| react-router | 14.8 (15.2) | 1.4 | 1.4 (2.0) | 476 MiB |  |  |
| tanstack-start | 16.1 (17.7) | 2.3 | 2.1 (3.2) | 532 MiB |  |  |
| astro | 16.6 (17.7) | 2.2 | 1.8 (2.4) | 352 MiB |  |  |
| nextjs | 20.2 (35.6) | 9.0 | 5.1 (12.0) | 843 MiB |  |  |
| spring | 24.6 (30.9) | 3.9 | 3.2 (9.1) | 228 MiB |  |  |
| phoenix | 29.2 (65.1) | 5.5 | 4.7 (7.9) | 234 MiB |  |  |
| gin | 32.0 (97.2) | 30.2 | 1.0 (1.7) | 1,220 MiB | 30.4 (92.9) | 1.3 (2.3) |
| axum-maud | 33.8 (100.6) | 32.4 | 11.9 (28.3) | 622 MiB | 20.7 (66.3) | 1.3 (1.2) |
| nuxt | 43.1 (44.8) | 7.6 | 7.1 (10.9) | 599 MiB |  |  |
| rails | 51.8 (108.5) | 1.3 | 1.1 (1.1) | 584 MiB |  |  |
| topcoat | 74.4 (225.2) | 72.5 | 27.6 (61.3) | 884 MiB | 38.5 (132.4) | 4.6 (6.3) |
| **corten** | 87.6 (198.5) | 85.1 | 35.8 (66.6) | 710 MiB | 38.7 (105.8) | 2.4 (2.2) |
| drogon | 97.1 (333.9) | 7.2 | 2.4 (2.4) | 1,182 MiB | 7.3 (18.7) | 2.2 (2.2) |
| leptos | 216.5 (664.2) | 214.1 | 76.9 (148.9) | 2,078 MiB | 116.8 (441.6) | 12.3 (20.1) |

Clean, the Rust apps took 33.8 s (axum + Maud) to 216.5 s (Leptos), Topcoat 74.4 s and Corten
87.6 s, against 7.1-51.8 s for the apps not written in Rust or C++ and 97.1 s for Drogon (89.9 s of
it building Drogon itself). After the edit the Rust apps took 11.9-76.9 s (Corten 35.8 s),
against 1.0-7.1 s for the other apps. Corten's production build takes 2.6 times as long as
axum + Maud's clean build and 3.0 times as long after the edit, for a larger program (above).
Its development build after the edit took 2.4 s, against 1.3 s for axum + Maud and Gin,
2.2 s for Drogon, 4.6 s for Topcoat and 12.3 s for Leptos. Of Corten's clean build,
card-market's own crate is the last 36.25 s of the 85.1 s build, corten 19.38 s before it,
and zstd-sys's build script the slowest dependency at 20.98 s. In a separate diagnostic build
of card-market's crate, LLVM optimization and thin LTO were 32.149 of its 35.62 s (90.3%),
and macro expansion, type checking and borrow checking 1.028 s together. Leptos peaked
highest at 2,078 MiB, next to Corten's 710 MiB.

### What the numbers say

1. Rendering from memory: axum + Maud serves 22,287 item pages a second at 64 users, then Corten (15,103) and Drogon (14,828). Corten serves 4x ASP.NET Core and 12x Leptos.
2. JSON from memory: Corten leads with 22,553 a second, ahead of Topcoat (15,083), axum + Maud (13,049) and Leptos (12,461).
3. With the item API every request fetches and parses about 55 KB of JSON. Corten serves 3,339 pages a second and 3,533 JSON responses; at 150 a second its page used 6.8% of its core.
4. Failed: Next.js failed the in-memory page and item-API page tests; Laravel failed both in-memory tests and its item-API page test; Django and Nuxt failed the in-memory page test. Rails passed that test again.
5. Cold start: axum + Maud, Corten, Topcoat, Leptos and Gin answer 7.1, 7.7, 8.3, 9.3 and 11 ms after their processes start.
6. Browser: Corten is interactive in 61 ms on desktop and 474 ms on the throttled phone. The item page loads 12.9 KB of JavaScript (gzip).

r15 ran on a Platinum 8168, as r14 did, on another droplet. ASP.NET Core's item-API logging
changed between the measured commits, so it is excluded from the unchanged-app median; the new
JSON-only aspnet-aot has no r14 row. Among the other sixteen apps that passed each test in both
rounds, median 64-user throughput rose 14.4% for the page from memory (11 apps), 12.2% for JSON
from memory (15), 15.6% for the item-API page (13), and 12.9% for the item-API JSON (16).
Corten rose 4.4%, 24.8%, 8.4% and 10.0% respectively. Its in-memory page trailed by 9.9
percentage points, just below the automation's greater-than-10-point regression threshold;
its item-API paths also improved less than their peers. JSON from memory improved more.
Page user instructions fell from 105,452 to 103,544 and JSON user instructions rose from
69,772 to 70,588; kernel instructions fell in both. JavaScript grew 0.2%, HTML and CSS held,
cold start fell from 8.1 to 7.7 ms, and desktop and phone interactive improved from 71 to
61 ms and 494 to 474 ms. These are one run each, not proof of a cause.

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

From format 2 (after round conform2), each round's conform step (`run-all.mjs`, between the
instruction counts and the browser step) writes the matrix from the round's own images to
`results/<round>/conformance.json`, so a round's tables are read beside the work its apps did,
not conform2's (`droplet.mjs` says which commit the images were built from, as `imagesFrom`).
Format 2 adds three columns and counts a fourth: a read that fails (the item API,
`conform-items.mjs`, answers 500 for one item) counts as any 5xx, as HTML on the page and JSON or
problem+json on the JSON; the 64 KiB header counts when it is refused, by a 4xx (431 is the
standard one) or by the app closing the connection; and the lines the app writes to stdout and
stderr for each of 20 JSON requests are shown, not counted, since a log line is work an app
chose, not a default it lacks (the ASP.NET Core app wrote four `HttpClient` lines for each
through r13; a log file, as Laravel's default, is not seen). The conform step took about 2.8
minutes an app locally, so a round of nineteen apps gains about 55 minutes (estimated; its limit
of 120 is twice that, not twice a droplet's).

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
[#807 bench/fullstack has no tier where every app implements the same production features, so its tables mix framework cost with feature cost](https://github.com/corten-run/corten/issues/807),
and checking that each app does the same work is
[#806 bench/fullstack checks that every app sends the same output but not that it does the same work, so a table can compare apps doing different jobs](https://github.com/corten-run/corten/issues/806).

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

Instructions are `count.mjs ... api`, median of 3 x 5,000 requests. r15, on a Platinum 8168,
serves 3,339 item-API pages a second against ASP.NET Core's 1,184 (2.8x; 2.3x in the A/B and in r4,
3.2x in r5, 3.1x in r6 and r7, 3.4x in r8, r10, r12 and r13, 3.3x in r11 and 3.5x in r14), at 6.8% of its core at 150 a
second against 36.7% (the fixed-rate CPU computed from requests per CPU-second).

### Instructions per request, by crate (callgrind, 2026-11-05)

Where one request's user instructions go, measured on main `b79a6b23`: card-market's release build
(line tables only, the same code) under callgrind, serving 300 and then 1,300 requests over one
keep-alive connection with `Accept-Encoding: identity`, in two runs, one pair of runs for each
column. The difference over 1,000 is one request with startup and shutdown cancelled out
([cost-by-crate.sh](cost-by-crate.sh), split by [cost-by-crate.mjs](cost-by-crate.mjs)).
Rendering is deterministic (writing HTML is 51,124 in both page columns, measured apart); the
tokio and allocator rows depend on scheduling, and one pair does not show their spread. Kernel
instructions are not seen by callgrind; `count.mjs` gives them (Corten's page 32,705 and JSON 32,897 a
request in the instructions table above, topcoat's page 31,827, Leptos's 35,722).

These counts are lower than `count.mjs`'s for the same pages (the page 98,099 against 103,544,
the item-API page 830,161 against 1,385,381). The commits differ as well as the method (those
counts come from earlier builds), and this is one process's user code over one
sequential connection, which callgrind runs one thread at a time, where `count.mjs` counts the
whole container under four users. So what it says of tokio holds for that load shape, not for
many connections at once.

Compression is not split here: the rounds send `identity`, as these runs do, and its cost is
measured by the A/B below (the build after: 15% of a core at 300 a second with a browser's
`Accept-Encoding` against 12% with `identity`). With `identity`, choosing not to compress
(`compress::negotiate`, `vary`, `finish`) is 1,448 instructions of the page, in "the rest".

| | Page, items in memory | JSON, items in memory | Page, item from the item API |
|---|---|---|---|
| User instructions a request | 98,099 | 67,135 | 830,161 |
| Writing HTML (`Render`, `escape_into`, digits, `Formatted`) | 51,124 (52.1%) | | 51,124 (6.2%) |
| Writing JSON (`ToJson`, `str_body`, numbers) | | 29,524 (44.0%) | |
| Reading JSON (`FromJson`, serde_json's `Value`, UTF-8, floats; from memory only `from_utf8`) | 402 (0.4%) | 374 (0.6%) | 486,228 (58.6%) |
| HTTP: hyper, httparse, http's `HeaderMap` | 12,685 (12.9%) | 10,029 (14.9%) | 27,035 (3.3%) |
| Allocator (glibc malloc and free) | 6,657 (6.8%) | 5,536 (8.2%) | 157,413 (19.0%) |
| memcpy, memcmp | 7,401 (7.5%) | 7,804 (11.6%) | 26,083 (3.1%) |
| tokio | 2,198 (2.2%) | 2,221 (3.3%) | 7,877 (0.9%) |
| axum, tower, matchit (by name: a floor) | 1,684 (1.7%) | 1,786 (2.7%) | 2,012 (0.2%) |
| The rest (Corten's request path, the handler, smaller pieces) | 15,949 (16.3%) | 9,861 (14.7%) | 72,389 (8.7%) |

The rows group functions by name (a function's own instructions, not what it calls), so generic
code is counted where it ran: `HashMap` lookups inside `HeaderMap` are HTTP, not std. Split by
the source file each instruction came from instead, Corten's own files are 26.6% of the page from
memory, Rust's standard library (inlined iterators, `Vec` and `String` growth) about 42%, and hyper,
httparse, http and bytes 11.0%. axum's row counts only functions named for axum, tower or
matchit. Of the functions in "the rest" whose names mention them, most are Corten's and the
app's own code implementing their traits (Corten's service and connection, the handlers and
extractors), which Corten needs with or without axum; axum, tower and matchit's own code there
(a `RouteId` hash, matchit's iterator, tower's `Oneshot`, axum's route futures dropped) is 735
(0.7%) on the page and 771 (1.1%) on the JSON. `http::Extensions` adds 1,116 on the page and 956
on the JSON, part of it the matched path and URL parameters axum inserts. On the item-API page,
the HTTP client (reqwest, hyper's client side and its pool, `url`, `idna`) is about 21,341
(2.6%), most of it between the HTTP row and "the rest" (719 of it, hyper's client channel and
reqwest's `tower::retry`, sits in the tokio and axum rows).

The largest single functions: on the page from memory, `Formatted::write_in` (prices and dates in
the visitor's locale, 14,215, 14.5%), `escape_into` (11,790, 12.0%) and `push_u64` (5,975, 6.1%);
on the JSON, `json::str_body` (15,940, 23.7%); on the item-API page, `json::read::Reader::skip_nested`
(skipping members the app's types do not declare, 152,934, 18.4%: 103,097 of it inside the
`contained_item` and `container_item` objects, which declare only `title`, 22,044 in `ApiItem`
and 21,834 in the listings, from the call graph), the read of the listings (133,739, 16.1%) and
the fields card-market reads as serde_json's `Value` (55,231, 6.7%: every scalar field of its
`Api*` types, about 35, is a `Value`, the app's choice).

What is worth acting on, from these numbers:

1. Replacing axum ([#761 Corten wraps most of axum but still depends on its router, handler traits and SSE, which tie its public API and diagnostics to axum's](https://github.com/corten-run/corten/issues/761))
   would save its 1.7% to 2.7% of a request from memory by name, about 2.5% to 4% with its own
   code in the rest and up to about 5% with all of the `http::Extensions` work, less once Corten
   routes itself: not a throughput reason on its own.
2. Reading upstream JSON is where an item-API page goes: skipping undeclared members (most of
   it inside two nested objects the app reads one member of), the allocator (19.0% there against
   6.8% from memory; whose allocations they are is inferred, as the split keeps no call graph for it) and
   fields read as `Value`. The reader's part is [#763 Corten's form, route and JSON readers still require serde's Deserialize beside their own derives, and FromJson allocates every string it reads from an upstream body](https://github.com/corten-run/corten/issues/763).
3. hyper and http are 13% to 15% from memory, about half of it on the page (42% on the JSON)
   `HeaderMap` hashing, inserting and lookups; tokio is 2% to 3% on one connection. Neither is worth tuning before rendering and reading.
4. On the page, locale formatting is the largest single function, ahead of HTML escaping.

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
record; the Build table in Results is from r15, the current droplet round that measured it. The
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
   8168 at 2.7 GHz in r12 to r15, 16 GB), Ubuntu 24.04, kernel 6.8, Docker 29.9, Node 24, created for the run
   and destroyed after it (`droplet.mjs`). The round runs on the droplet by itself, as a systemd
   unit (`corten-bench-<round>`), so it does not need the machine that started it:
   `droplet.mjs --detach` starts it and leaves, and `droplet.mjs <round> --collect` later
   downloads the results and destroys the droplet once the round has ended (or says where it is).
   On the droplet, `run-all.mjs --unattended` gives each call a time limit (at least twice the
   longest it took in r14, conform's twice a local estimate; the builds' in item 10) and stops one that runs past it
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
   not all the same CPU (r1's, r4's, r5's, r8's, r12's, r13's, r14's and r15's were a Platinum 8168, r2's, r3's,
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
   counted time. A round may run these phases three or five times (`droplet.mjs --passes 3`,
   `BENCH_PASSES` on the droplet; one unless set): the apps take turns, every app's first pass and
   then every app's second, so a drift of the machine falls on every app alike, and each pass writes
   its own files (pass 2 on add `-p<pass>`, `passes.mjs`), and `passes.json` the count.
   `summarize.mjs` (`ssr.mjs`) then reads every pass asked for: each number is the passes'
   median with their range, an app that failed in any pass failed, a phase that some passes have no
   files for says so (`[2 of 3 passes]`), and it marks an app
   whose rate or requests per CPU-second overlaps Corten's range as within noise (`~`); its tables
   lead with the cost at a steady rate (requests per CPU-second and CPU at the fixed rate), peak
   throughput after. A pass adds about the load phases' hours again, so a round of passes is
   usually a few apps (`--apps`).
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
   ([#812 count.mjs restarts the bench droplet in some rounds (r8, r12, aot1), so those rounds have no instruction counts](https://github.com/corten-run/corten/issues/812));
   r15's counts are compared with r14's. An app that cannot be counted is
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
   ([#259 Benchmark round r7 has no browser numbers: Corten refuses the price alert on item_12345, which has no listings, and browser.mjs times out waiting for 'Alert set'](https://github.com/corten-run/corten/issues/259)).
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
    step a 240-minute budget, counted afresh at each start as the unit's hours are (r15's step
    took 47.7 minutes, and its longest call, Leptos's, 13.5); a stopped or crashed build skips its
    app alone, a droplet restart in the step goes on with the next app, and past the budget the
    apps not built are named in `skipped.txt`.

### Drift across rounds

A round's differences under about 10% are noise (caveat 1), so a number that gets a few percent
worse each round never shows in one round's comparison: 5% a round is 41% after seven rounds.
`trend.mjs` looks across rounds instead. It reads every full round's (`r<n>`) `summary.json`
and commit (`commit.txt`, or for a round just collected the commit `conformance.json` says its
images were built from), oldest commit first, and compares the latest round's Corten numbers with
each number's baseline round and with the median of the rounds before the last two (at least
three of the five before them). A latest round without a number has no verdict for it.

1. The numbers with a verdict are the steady ones, each with its noise, how far two rounds of one
   commit land: instructions per request for the page and the JSON (1%; a round's three counts
   spread at most 0.7%), the page's HTML, JS and CSS gzipped (0.5%; they do not move), and peak
   memory at 64 users (5%; 16.3 to 16.9 MiB over r8 to r15).
2. Each keeps a one-sided CUSUM: the sum of each round's share worse than the baseline less the
   noise, never below zero, where a round adds no more than the worse of the rounds beside it (the
   one before, for the latest). It has drifted when that sum passes three times its noise and the
   last two rounds are both worse than the baseline by more than the noise. A noisy round on its
   own, however far off and however many there are apart, is not a drift and does not help a later
   one become one. A round no worse than the baseline starts the sum again, so a fixed regression
   does not linger, but one noisy low round does the same and delays a slow drift by the rounds
   it had built (a steady 2% offset, caught at round 4, is caught at round 8 after one round at
   the baseline). A worsening that holds is a drift after two rounds: an instruction count 5%
   worse each round by the third round, a step that holds by its second (`trend.test.mjs`).
3. It is a warning when it has not drifted but the last two rounds are both worse than that
   median by more than the noise and at least 3%: a recent step that holds. A median of one or
   two rounds is none, since one unusual round would set it.
4. Requests a second and requests per CPU-second are shown, with their change against the
   baseline, and get no verdict: between rounds on one CPU model they moved 20% (r12 to r13 +22%,
   r13 to r14 -20%), more than a drift worth catching, so a rule on them would either cry wolf or
   miss a real 10% loss. Their recent median is left out, since the rounds before may have run
   on other CPU models.

So a loss that only time sees is not caught here: instruction counts do not see waiting (I/O,
locks) or how well the instructions run (Instructions per request), and throughput is compared
only within a round (caveat 1).

`droplet.mjs` runs it when it collects a full round, which writes `results/<round>/trend.json`
(each number's baseline round and why, its commit range, latest value, share worse than both,
sum and limit, the series, and the paths of the round's summary, the baseline's summary and the
raw file) and prints a table, a `DRIFT:` line for each number that drifted and a `WARN:` line
for each warning. A round whose images were built from a tree with changes is marked dirty in
`trend.json` and in those lines. A drift or a warning does not fail the collect; a trend that
cannot be made (a baseline missing, a commit not in the clone) does. A worsening accepted on
purpose (a feature that costs bytes) is taken in by naming a later round for that number alone
in `trend-baseline.json`, with why, so the others keep building; a baseline round that is missing, or
lacks the number, stops the script rather than falling back. The file starts at r14. By hand:
`node bench/fullstack/trend.mjs [round]`. Measured with r10 as every number's baseline, at r14 it
reports the page's JS (+21%) and CSS (+1.3%) as drifted, the instruction counts and HTML at or
under r10's, and throughput 39.5% and requests per CPU-second 29.1% below r10's (14,460 against
23,898 a second, 5,274 against 7,434), which ran on a faster CPU model (Platinum 8280 against
r14's 8168), the reason they get no verdict.

The detector is not yet a schedule or a route to triage: it runs with each full round the nightly
automation collects, but nothing yet reads `trend.json` or turns a `DRIFT:` line into an issue
([#867 Small performance regressions can compound without a trend detector](https://github.com/corten-run/corten/issues/867)).

## Caveats

1. One run per phase on one droplet, unless a round says it ran passes (`--passes`, Method 4):
   in a one-pass round differences under about 10% are noise. A round of passes gives each
   number's range, and a difference whose ranges overlap is within noise. Across rounds,
   `trend.mjs` reports a sustained drift (Drift across rounds).
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
7. Laravel ran with PHP's default `memory_limit` throughout r3 to r15. (r2's main run had raised it
   to 512 MB and measured Laravel again with the default afterwards; `laravel-rerun.log` in r2's raw
   output ([results/r2/raw.txt](results/r2/raw.txt)).)
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
   page test for the first time (121 of 150 a second, 8.46% never sent). In r15 Django and
   Nuxt still failed the in-memory page test; Rails and Django's item-API page passed again.
9. r15 measured the tree at `ec10c8f` (`results/r15/commit.txt`).
   Changes merged to `main` after that are not in these numbers.
10. r6's efficiency numbers divide by CPU sampled once a second, which is coarse for an app using
    a few percent of its core (Corten's 5.7% at the fixed rate); from r7 they divide by the
    counted CPU time. Requests per CPU-second, like requests a second, compare only within a round.
11. r8 has no instruction counts. r8's droplet stopped answering both times the round reached
    `count.mjs`, right after its warmup (the first time with a kernel soft lockup); the cause is not
    known, and the round finished without that step
    ([#466 Benchmark round r8 has no instruction counts: its droplet locked up twice when count.mjs started counting](https://github.com/corten-run/corten/issues/466)).
    r9 measured nothing (its launcher hung in its own `ssh` call before the round started), so r10's counts were compared with
    r7's (the tree at `a9b1163`), the last round before it that counted: counts do not depend on
    the droplet, but Corten changed between the two commits. r12 has none either: its droplet
    restarted while `count.mjs` ran, and the round went on from the next step
    (`results/r12/skipped.txt`). r13 counted again, and its counts are compared with r11's
    (the tree at `512dc73`), the last round before it that counted, and r15's with r14's.
12. Through r11 the other apps rendered Corten's visible text with markup and stylesheets of their
    own (the stylesheets last changed on 2026-10-22, the markup on 2026-10-31 only for the plural
    counts), while Corten's item page changed in nine commits after that
    ([#642 The benchmark's other apps render Corten's item page text but not its markup or styles, which changed in nine commits since Oct 22](https://github.com/corten-run/corten/issues/642)).
    From r12 they render Corten's markup with its stylesheets, so their page bytes, browser times
    and server numbers are not like for like with r11's. r12 is the first round with Corten's markup
    and stylesheets in every app, and r13 the first with all eighteen; in each, and in r15, the
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
    not measured. In r15 it logs `HttpClient` at Warning. Rails (`log_level` info) and Phoenix
    (`Plug.Telemetry` at info) log a line for every request, from memory too, as their production
    defaults do; whether a matched tier turns that off is
    [#806 bench/fullstack checks that every app sends the same output but not that it does the same work, so a table can compare apps doing different jobs](https://github.com/corten-run/corten/issues/806).

## Running it

```sh
# On a fresh droplet, created and destroyed for the run (needs doctl and an SSH key there):
node bench/fullstack/droplet.mjs r16 --ssh-key <id> [--region sfo2]   # waits for the round
node bench/fullstack/droplet.mjs r16 --ssh-key <id> --detach          # or start it and leave,
node bench/fullstack/droplet.mjs r16 --collect                        # then collect it later
# A few apps against each other, without the other apps' hours (r14's eighteen took 6.3):
node bench/fullstack/droplet.mjs aot2 --ssh-key <id> --apps corten,aspnet,aspnet-aot --detach
# Each load phase three times, the apps taking turns, for medians and ranges:
node bench/fullstack/droplet.mjs p1 --ssh-key <id> --apps corten,axum-maud --passes 3 --detach
# Or by hand, from the repository root: the images, the fixture, then everything.
docker build -f examples/card-market/Dockerfile -t cb-corten .
for app in nextjs tanstack-start sveltekit react-router leptos topcoat axum-maud gin drogon django rails laravel aspnet aspnet-aot spring phoenix astro nuxt; do
  docker build -t cb-$app bench/fullstack/apps/$app
done
node bench/fullstack/fixtures/fetch.mjs http://localhost:18400   # or any {"item_1": {...}} file
cd bench/fullstack && node run-all.mjs r16 10   # BENCH_APPS=corten,aspnet-aot for only those
node conform.mjs [apps] [round]   # the feature matrix above (on the bench network; removes its containers when done)
node check-app.mjs <app>    # before adding an app: parity, look, JSON and 404s against corten
                            # (replaces fsw-corten and fsw-<app>, removed after unless keep; needs cb-corten from this tree)
node sync-styles.mjs        # after Corten's styles change (cb-corten rebuilt and running): copy them to every app
node look.mjs [apps]        # every app's pages in Chromium against Corten's, box by box
node build.mjs r16 [apps] [runs=3]   # build cost: clean, after a one-line change, and dev builds
# One request's instructions by stage and crate (callgrind), from the repository root, items in memory:
docker run --rm -v "$PWD:/src" -v "$PWD/bench/fullstack/fixtures:/fixtures:ro" -v /tmp/cg:/out -w /src \
  -e CARGO_TARGET_DIR=/target rust:1-bookworm bash bench/fullstack/cost-by-crate.sh
node bench/fullstack/cost-by-crate.mjs /tmp/cg/cg-page-fixture-300.out /tmp/cg/cg-page-fixture-1300.out
# The item fetched from the item API (running on the host at 18400, with port 8080 free, as
# --network host serves the app there): add --network host and
# -e SOURCE=api -e API_BASE=http://127.0.0.1:18400 -e TARGETS=page, then split cg-page-api-*.out
```

## What the repository keeps

1. A round keeps its summaries and its log as files: `summary.json`, which the tables above come
   from, and `run.log`, `commit.txt`, `host.txt`, `skipped.txt`, `build.json`, `bytes.json`,
   `cold-start.json`, `instructions.json`, `browser.json`, `conformance.json`, `trend.json` and, in a round
   committed before this, `raw.txt` (below). Its raw output
   (each app's k6, CPU and startup files, every count) is one archive beside them, `raw.tar.xz`.
   `droplet.mjs` packs a finished full-stack round once it has downloaded it; after a round run by
   hand and summarized, `node bench/fullstack/pack.mjs <round>` does. It lists the archive back
   and removes a file only when the listing has it. r14's raw output was 1,156 files and 1.64 MB,
   337 KB as this clone's Git pack holds them; as `raw.tar.xz` it is one file of 175 KB (measured).
2. `summarize.mjs` reads a packed round's raw files from its archive, and writes the same
   `summary.json` as from the files (r14's was byte for byte the one committed; since passes, a summary also has `cpuUsedPct`).
   `tar -xJf bench/fullstack/results/<round>/raw.tar.xz -C bench/fullstack/results/<round>` brings
   the files back for a look at one run.
3. The rounds committed before this (r1 to r14 and the side rounds) had their raw output removed
   from the tree. Each one's `raw.txt` names the commit that still has it and the command that
   brings it back; remove it when a round brought back is packed again. The history is not
   rewritten, so their blobs stay in it and a clone still downloads them once (Git's pack was 41.7
   MiB); a checkout has 142 files of results (5.7 MB) instead of 11,150 (22.1 MB), and a new round
   adds one archive instead of a thousand files.
4. The raw output stays in the repository, not in a CI artifact (kept for 90 days at most) or a
   release download, so the runs behind every table stay with the commit that reports them.
