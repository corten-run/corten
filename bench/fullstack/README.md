# Full-stack comparison: one marketplace item page in twenty apps

This is the historical marketplace workload with **non-equivalent localization work**:
Corten formats values per request while the other implementations use stored strings
(caveat 16). Its tables and relative observations describe these historical implementations,
not valid general framework speed rankings. The separate
[locale-neutral catalog benchmark](../catalog/README.md) gives every framework the same
strings-only page work without currency or number localization. Its results start a new
baseline; they do not replace or form a before/after comparison with the tables here.
[Marketplace v2](../marketplace/README.md) implements equivalent request-time locale formatting
in twenty adapters, with a whole-page conformance gate and its own repeated-pass runner.
It starts a separate baseline and becomes the nightly workload at official r17. See the
[nightly procedure](../marketplace/nightly.md). Compare only compatible v2 rounds, never an
r16 or catalog c1 delta. Catalog remains an optional separate diagnostic, not a nightly duplicate.
All legacy results, including build, browser and instruction measurements, remain below under
their original labels; those measurements are not yet part of the v2 nightly suite.

The same item detail page (title, images, sorted listings table, offers with "show all", a
price-alert form that posts and patches a message), and the same item as JSON, built in:

| App | Stack | Directory | Reviewed by its maintainers |
|---|---|---|---|
| corten | Corten 0.1 (Rust, axum, `html!` views, handlers) | [examples/card-market](../../examples/card-market) | Corten's own |
| leptos | Leptos 0.8 (Rust, SSR plus WASM hydration, axum) | [apps/leptos](apps/leptos) | not yet |
| topcoat | Topcoat 0.11 (Rust, `view!` components, shards and a procedure, no WASM) | [apps/topcoat](apps/topcoat) | not yet |
| axum-maud | axum 0.8.9 and Maud 0.27 (Rust, a router and a template macro, no framework), htmx | [apps/axum-maud](apps/axum-maud) | not yet |
| nextjs | Next.js 16.4.2, App Router, React Server Components, server action | [apps/nextjs](apps/nextjs) | not yet |
| tanstack-start | TanStack Start 1.169.3, React 19, server functions, Nitro | [apps/tanstack-start](apps/tanstack-start) | not yet |
| sveltekit | SvelteKit 3.1.0, Svelte 5.57, adapter-node 6, form action | [apps/sveltekit](apps/sveltekit) | not yet |
| react-router | React Router 7.18.4 on Express | [apps/react-router](apps/react-router) | not yet |
| astro | Astro 7.4.2, Node adapter (standalone), client router, Actions | [apps/astro](apps/astro) | not yet |
| nuxt | Nuxt 4.6.2, Vue 3.5, Nitro | [apps/nuxt](apps/nuxt) | not yet |
| aspnet | ASP.NET Core 10 Razor Pages on Kestrel, htmx | [apps/aspnet](apps/aspnet) | in part: Damian Edwards (ASP.NET Core) asked whether the app resolves services per request and whether Corten enforces limits as Kestrel does (2026-11, [#806 bench/fullstack checks that every app sends the same output but not that it does the same work, so a table can compare apps doing different jobs](https://github.com/corten-run/corten/issues/806)); the app itself not yet |
| aspnet-aot | ASP.NET Core 10 minimal API published with native AOT, the item as JSON only | [apps/aspnet-aot](apps/aspnet-aot) | not yet |
| spring | Spring Boot 4.1.1, Java 25, Thymeleaf on Tomcat, htmx | [apps/spring](apps/spring) | not yet |
| gin | Gin 1.12.0, Go 1.27, templ 0.3, htmx | [apps/gin](apps/gin) | not yet |
| drogon | Drogon 1.9.14 (C++), CSP views, JsonCpp, htmx | [apps/drogon](apps/drogon) | not yet |
| django | Django 6.1.2, Python 3.14, gunicorn 26 (3 sync workers), htmx | [apps/django](apps/django) | not yet |
| fastapi | FastAPI 0.162.2, Python 3.14, Jinja2, `fastapi run` (uvicorn, one process), htmx | [apps/fastapi](apps/fastapi) | not yet |
| express | Express 5.3.0, Node 24, EJS 7, htmx | [apps/express](apps/express) | not yet |
| rails | Rails 8.1.4, Ruby 3.4 with YJIT, Puma (3 threads), Turbo and Stimulus | [apps/rails](apps/rails) | not yet |
| laravel | Laravel 13.38, PHP 8.4, Octane on FrankenPHP (2 workers), Livewire 4.4 | [apps/laravel](apps/laravel) | not yet |
| phoenix | Phoenix 1.8.16, LiveView 1.2, Elixir 1.19 on OTP 28, Bandit | [apps/phoenix](apps/phoenix) | not yet |

Each app was written by Corten's maintainers in what we took to be its framework's usual way.
The last column says whether someone who works on that framework has checked it;
[REVIEW.md](REVIEW.md) says what a reviewer may change and how to propose it.

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
tables below are from r16, with all eighteen page apps then plus JSON-only aspnet-aot (FastAPI and Express joined after it and have no rows yet), each page app rendering Corten's markup
and stylesheets (caveat 12). Each app
has the same interactions: a sort (in the browser, except where the framework renders again on
the server: Phoenix's LiveView and Topcoat's shard, each a round trip), a form action that
updates part of the page, and client-side navigation from the home page, each done the
framework's usual way (htmx for Razor Pages, Spring, Django, FastAPI, Express, Gin, Drogon and axum + Maud; Turbo
for Rails; Livewire for Laravel; LiveView for Phoenix; shards, signals and a procedure for
Topcoat).
The item page's first response carries its first five offers in every app, and "Show all N
offers" is a GET form whose button sends `offers=all`, so without JavaScript every app answers it
with the page with every offer. With JavaScript, Corten answers it with a patch of the other
offers; the htmx apps, Rails (a Turbo Frame) and Astro fetch the page with every offer and keep
its offers; Phoenix, Laravel and Topcoat render the offers again on the server (a LiveView event, a
Livewire call, a shard); and the client-rendered apps (Next.js, TanStack Start, SvelteKit, React
Router, Nuxt, Leptos) draw them from the item they already have. `parity.mjs` counts the table
rows a response's markup carries, a `<template>`'s included, and fails an app whose count
differs; the client-rendered apps' hydration data carries every offer, and parity does not count
it. Prices and ratings still differ (caveat 16).
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

All numbers are measured (`results/r16/`, 2026-11-06 to 2026-11-07 UTC, the tree at `eea6adb`),
with three load-test passes (medians; ranges in `summary.json`), not three complete rounds,
on one DigitalOcean c-8 droplet (Intel Xeon Platinum 8168); see [Method](#method). Failed
means the app could not do the test with its usual settings in one CPU and 1 GiB (see caveat 5);
its other numbers are kept where it produced any. No steps were skipped; Corten passed every test.
r16 is the first measured round with five offers in Corten's initial page (caveat 16).
A load-test failure in any pass marks that app failed, even when its median passes: Next.js's
in-memory page served 158/s with 36.2% never sent in pass 2, and its item-API page 82/s with
20.5% never sent in pass 1. Laravel never answered either in-memory test in pass 1, and its
item-API page served 104/s with 20.14% never sent in pass 1. The tables keep the available medians.
r15 (`results/r15/`, the same CPU model, Corten at `ec10c8f`, one load pass,
with all offers in Corten's initial HTML and no Corten failures), r14 (`results/r14/`, the same CPU model, Corten
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
| axum-maud | 6.3 ms (5.6 ms-7.1 ms) | 1.34 MiB | 118 MB |
| leptos | 8.0 ms (6.7 ms-40 ms) | 1.488 MiB | 128 MB |
| topcoat | 8.1 ms (6.2 ms-9.1 ms) | 1.5 MiB | 124 MB |
| **corten** | 8.6 ms (6.4 ms-48 ms) | 1.277 MiB | 124 MB |
| gin | 10 ms (7.9 ms-13 ms) | 1.941 MiB | 135 MB |
| drogon | 31 ms (27 ms-38 ms) | 3.258 MiB | 122 MB |
| aspnet-aot (JSON) | 67 ms (60 ms-96 ms) | 14 MiB | 203 MB |
| sveltekit | 201 ms (194 ms-207 ms) | 25.63 MiB | 333 MB |
| tanstack-start | 237 ms (224 ms-288 ms) | 27.58 MiB | 332 MB |
| astro | 319 ms (311 ms-384 ms) | 36.5 MiB | 559 MB |
| nuxt | 348 ms (343 ms-377 ms) | 36.49 MiB | 335 MB |
| react-router | 357 ms (310 ms-411 ms) | 33.17 MiB | 353 MB |
| nextjs | 705 ms (690 ms-912 ms) | 52.58 MiB | 385 MB |
| aspnet | 724 ms (687 ms-790 ms) | 30.67 MiB | 342 MB |
| laravel | 863 ms (835 ms-921 ms) | 96.2 MiB | 950 MB |
| django | 1.1 s (1.1 s-1.3 s) | 65.66 MiB | 276 MB |
| rails | 1.1 s (1.1 s-1.3 s) | 63.83 MiB | 431 MB |
| phoenix | 1.3 s (1.3 s-1.3 s) | 125.3 MiB | 262 MB |
| spring | 7.5 s (7.3 s-7.8 s) | 140.8 MiB | 516 MB |

### Item page, items in memory (no database)

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| axum-maud | 300/s, 0.2 ms / 0.5 ms, 4% | 27,327, 1.9 ms / 7.5 ms | 27,776, 30 ms, 0% | 15-19 MiB |
| **corten** | 300/s, 0.3 ms / 0.5 ms, 4% | 20,705, 2.3 ms / 8.5 ms | 19,867, 33 ms, 0% | 16-19 MiB |
| drogon | 300/s, 0.2 ms / 0.5 ms, 4% | 17,870, 3.9 ms / 9.1 ms | 17,886, 33 ms, 0% | 12-14 MiB |
| topcoat | 300/s, 0.4 ms / 0.7 ms, 8% | 5,647, 8.5 ms / 17 ms | 5,098, 69 ms, 0% | 15-18 MiB |
| gin | 300/s, 0.3 ms / 0.7 ms, 9% | 4,687, 13 ms / 31 ms | 4,434, 90 ms, 0% | 21-29 MiB |
| aspnet | 300/s, 0.6 ms / 2.5 ms, 25% | 4,115, 16 ms / 25 ms | 3,946, 107 ms, 0% | 88-91 MiB |
| phoenix | 300/s, 1.0 ms / 1.4 ms, 36% | 1,478, 43 ms / 61 ms | 1,481, 4.9 s, 0% | 285-302 MiB |
| leptos | 300/s, 0.9 ms / 1.3 ms, 25% | 1,356, 50 ms / 71 ms | 1,203, 365 ms, 0% | 16-34 MiB |
| astro | 300/s, 0.9 ms / 27 ms, 29% | 1,202, 49 ms / 118 ms | 1,197, 302 ms, 0% | 137-140 MiB |
| spring | 300/s, 1.1 ms / 5.6 ms, 51% | 1,023, 43 ms / 373 ms | 980, 980 ms, 0% | 360-381 MiB |
| sveltekit | 300/s, 1.2 ms / 21 ms, 43% | 815, 80 ms / 146 ms | 770, 457 ms, 0% | 144-155 MiB |
| tanstack-start | 300/s, 1.4 ms / 33 ms, 50% | 696, 80 ms / 156 ms | 658, 497 ms, 0% | 165-166 MiB |
| react-router | 300/s, 1.8 ms / 41 ms, 61% | 530, 119 ms / 185 ms | 533, 605 ms, 0% | 147-149 MiB |
| rails | 300/s, 2.4 ms / 62 ms, 75% | 440, 143 ms / 194 ms | 395, 836 ms, 0% | 135-137 MiB |
| nuxt | 291/s, 704 ms / 23.0 s, 100% | 325, 195 ms / 238 ms | 309, 3.8 s, 0% | 142-143 MiB |
| django | 300/s, 56 ms / 650 ms, 93% | 311, 192 ms / 288 ms | 310, 1.0 s, 0% | 346-346 MiB |
| nextjs | **failed**: 159/s served, 1.3 s / 56.8 s, 89% | 191, 347 ms / 401 ms | 187, 14.3 s, 0% | 222-224 MiB |
| laravel | **failed**: never answered /items/item_1 within a minute (pass 1) | - | - | - |

### The item as JSON, items in memory

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 300/s, 0.2 ms / 0.5 ms, 4% | 26,385, 1.9 ms / 8.0 ms | 22,279, 31 ms, 0% | 16-19 MiB |
| topcoat | 300/s, 0.2 ms / 0.5 ms, 4% | 17,790, 3.0 ms / 7.9 ms | 15,071, 31 ms, 0% | 15-18 MiB |
| axum-maud | 300/s, 0.3 ms / 0.5 ms, 4% | 16,977, 2.8 ms / 8.0 ms | 17,340, 32 ms, 0% | 15-19 MiB |
| leptos | 300/s, 0.3 ms / 0.5 ms, 5% | 15,854, 3.1 ms / 8.0 ms | 13,341, 32 ms, 0% | 14-18 MiB |
| aspnet | 300/s, 0.3 ms / 0.6 ms, 15% | 12,440, 4.7 ms / 9.7 ms | 13,681, 35 ms, 0% | 52-62 MiB |
| aspnet-aot | 300/s, 0.4 ms / 0.7 ms, 12% | 9,352, 6.4 ms / 12 ms | 9,620, 44 ms, 0% | 45-52 MiB |
| nuxt | 300/s, 0.4 ms / 0.8 ms, 9% | 7,274, 7.7 ms / 30 ms | 7,059, 76 ms, 0% | 100-102 MiB |
| spring | 300/s, 0.3 ms / 1.3 ms, 24% | 6,998, 5.9 ms / 89 ms | 6,076, 464 ms, 0% | 358-384 MiB |
| gin | 300/s, 0.3 ms / 0.9 ms, 9% | 4,052, 16 ms / 33 ms | 3,829, 108 ms, 0% | 25-34 MiB |
| tanstack-start | 300/s, 0.4 ms / 4.0 ms, 12% | 3,514, 15 ms / 49 ms | 3,520, 122 ms, 0% | 142-144 MiB |
| sveltekit | 300/s, 0.4 ms / 3.7 ms, 13% | 3,247, 18 ms / 50 ms | 3,116, 140 ms, 0% | 128-130 MiB |
| react-router | 300/s, 0.6 ms / 5.8 ms, 18% | 2,313, 24 ms / 72 ms | 2,277, 186 ms, 0% | 121-123 MiB |
| phoenix | 300/s, 0.7 ms / 1.0 ms, 26% | 2,150, 29 ms / 46 ms | 2,101, 4.0 s, 0% | 291-330 MiB |
| drogon | 300/s, 0.6 ms / 1.1 ms, 18% | 2,040, 22 ms / 53 ms | 2,088, 207 ms, 0% | 12-14 MiB |
| astro | 300/s, 0.7 ms / 22 ms, 21% | 1,879, 31 ms / 80 ms | 1,962, 187 ms, 0% | 137-138 MiB |
| django | 300/s, 0.8 ms / 1.1 ms, 29% | 1,137, 58 ms / 74 ms | 1,197, 272 ms, 0% | 294-294 MiB |
| nextjs | 300/s, 0.9 ms / 28 ms, 30% | 1,101, 52 ms / 119 ms | 1,136, 300 ms, 0% | 172-173 MiB |
| rails | 300/s, 1.2 ms / 7.7 ms, 39% | 870, 76 ms / 101 ms | 866, 374 ms, 0% | 130-131 MiB |
| laravel | **failed**: never answered /api/items/item_1 within a minute (pass 1) | - | - | - |

### Item page, item fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 0.7 ms / 1.0 ms, 6% | 3,669, 19 ms / 24 ms | 3,355, 151 ms, 0% | 16-59 MiB |
| aspnet | 150/s, 1.4 ms / 6.9 ms, 32% | 1,292, 49 ms / 74 ms | 1,215, 249 ms, 0% | 70-100 MiB |
| axum-maud | 150/s, 1.2 ms / 1.8 ms, 14% | 1,055, 60 ms / 80 ms | 989, 407 ms, 0% | 17-61 MiB |
| topcoat | 150/s, 1.3 ms / 1.9 ms, 16% | 865, 76 ms / 93 ms | 872, 450 ms, 0% | 15-59 MiB |
| gin | 150/s, 1.3 ms / 2.3 ms, 19% | 761, 79 ms / 191 ms | 765, 513 ms, 0% | 14-39 MiB |
| leptos | 150/s, 1.6 ms / 2.4 ms, 21% | 747, 88 ms / 109 ms | 660, 519 ms, 0% | 15-59 MiB |
| drogon | 150/s, 2.1 ms / 5.2 ms, 36% | 520, 117 ms / 202 ms | 471, 901 ms, 0% | 13-36 MiB |
| spring | 150/s, 2.1 ms / 7.3 ms, 55% | 500, 125 ms / 234 ms | 416, 1.2 s, 0% | 424-452 MiB |
| astro | 150/s, 1.9 ms / 33 ms, 38% | 461, 141 ms / 178 ms | 428, 757 ms, 0% | 127-148 MiB |
| phoenix | 150/s, 2.9 ms / 5.1 ms, 49% | 399, 158 ms / 217 ms | 388, 7.7 s, 0% | 205-296 MiB |
| sveltekit | 150/s, 2.1 ms / 22 ms, 41% | 378, 166 ms / 227 ms | 368, 847 ms, 0% | 147-159 MiB |
| tanstack-start | 150/s, 2.5 ms / 32 ms, 47% | 338, 191 ms / 235 ms | 313, 1.0 s, 0% | 139-166 MiB |
| rails | 150/s, 3.3 ms / 35 ms, 56% | 307, 207 ms / 279 ms | 274, 1.2 s, 0% | 107-112 MiB |
| react-router | 150/s, 3.0 ms / 82 ms, 55% | 293, 219 ms / 274 ms | 298, 1.1 s, 0% | 140-154 MiB |
| nuxt | 150/s, 4.1 ms / 170 ms, 70% | 217, 294 ms / 331 ms | 218, 10.6 s, 0% | 136-194 MiB |
| django | 150/s, 5.1 ms / 140 ms, 81% | 197, 321 ms / 383 ms | 206, 1.4 s, 0% | 128-128 MiB |
| nextjs | **failed**: 83/s served, 2.5 s / 51.2 s, 77% | 121, 512 ms / 667 ms | 113, 22.9 s, 0% | 210-259 MiB |
| laravel | **failed**: 104/s served, 7.3 s / 9.8 s, 99% | 110, 580 ms / 678 ms | 109, 2.6 s, 0% | 117-127 MiB |

### The item as JSON, fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 0.6 ms / 1.1 ms, 6% | 3,816, 18 ms / 22 ms | 3,448, 116 ms, 0% | 17-57 MiB |
| aspnet | 150/s, 1.0 ms / 4.9 ms, 23% | 2,068, 30 ms / 48 ms | 1,885, 174 ms, 0% | 59-85 MiB |
| aspnet-aot | 150/s, 1.1 ms / 2.6 ms, 18% | 1,507, 42 ms / 61 ms | 1,433, 216 ms, 0% | 26-53 MiB |
| topcoat | 150/s, 1.3 ms / 1.8 ms, 16% | 1,015, 64 ms / 83 ms | 903, 422 ms, 0% | 16-58 MiB |
| axum-maud | 150/s, 1.2 ms / 1.9 ms, 15% | 1,004, 62 ms / 85 ms | 954, 410 ms, 0% | 16-58 MiB |
| leptos | 150/s, 1.2 ms / 1.8 ms, 15% | 989, 63 ms / 85 ms | 955, 421 ms, 0% | 15-53 MiB |
| spring | 150/s, 1.3 ms / 4.9 ms, 37% | 942, 63 ms / 142 ms | 763, 655 ms, 0% | 408-446 MiB |
| nuxt | 150/s, 1.4 ms / 15 ms, 25% | 801, 79 ms / 123 ms | 722, 514 ms, 0% | 125-138 MiB |
| gin | 150/s, 1.3 ms / 2.3 ms, 20% | 758, 76 ms / 215 ms | 770, 514 ms, 0% | 13-40 MiB |
| sveltekit | 150/s, 1.4 ms / 14 ms, 25% | 705, 90 ms / 130 ms | 612, 521 ms, 0% | 123-145 MiB |
| tanstack-start | 150/s, 1.4 ms / 16 ms, 26% | 668, 97 ms / 130 ms | 578, 563 ms, 0% | 121-143 MiB |
| react-router | 150/s, 1.6 ms / 25 ms, 32% | 598, 109 ms / 142 ms | 536, 603 ms, 0% | 123-140 MiB |
| astro | 150/s, 1.7 ms / 26 ms, 34% | 547, 117 ms / 146 ms | 514, 597 ms, 0% | 125-142 MiB |
| phoenix | 150/s, 2.5 ms / 4.7 ms, 43% | 435, 143 ms / 212 ms | 434, 7.2 s, 0% | 215-326 MiB |
| drogon | 150/s, 2.3 ms / 6.1 ms, 43% | 423, 145 ms / 246 ms | 393, 928 ms, 0% | 13-36 MiB |
| rails | 150/s, 2.3 ms / 20 ms, 40% | 403, 156 ms / 241 ms | 380, 878 ms, 0% | 82-85 MiB |
| nextjs | 150/s, 2.0 ms / 46 ms, 39% | 372, 178 ms / 227 ms | 347, 938 ms, 0% | 146-189 MiB |
| django | 150/s, 2.7 ms / 4.6 ms, 45% | 372, 168 ms / 209 ms | 359, 823 ms, 0% | 76-77 MiB |
| laravel | 150/s, 3.7 ms / 11 ms, 56% | 260, 237 ms / 360 ms | 260, 1.4 s, 0% | 102-118 MiB |

### Instructions per request

| App | Item page: user / kernel | JSON: user / kernel |
|---|---|---|
| axum-maud | 74,237 / 34,184 | 198,010 / 33,419 |
| **corten** | 94,677 / 33,663 | 69,631 / 34,244 |
| drogon | 117,818 / 34,085 | 1,732,963 / 32,466 |
| gin | 470,056 / 76,972 | 644,127 / 62,022 |
| topcoat | 512,596 / 31,742 | 154,745 / 32,988 |
| aspnet | 1,329,104 / 58,942 | 268,472 / 62,963 |
| astro | 1,990,378 / 80,384 | 1,054,325 / 76,675 |
| phoenix | 2,199,139 / 92,554 | 1,561,411 / 83,841 |
| leptos | 2,807,103 / 35,883 | 204,838 / 33,200 |
| sveltekit | 4,540,871 / 46,083 | 675,373 / 33,504 |
| rails | 5,300,616 / 338,703 | 2,283,071 / 291,978 |
| tanstack-start | 5,396,411 / 50,218 | 539,248 / 33,725 |
| spring | 5,897,047 / 112,771 | 1,448,044 / 99,781 |
| react-router | 6,557,904 / 112,222 | 827,620 / 70,555 |
| nuxt | 9,906,131 / 67,799 | 404,090 / 32,370 |
| django | 12,894,971 / 357,548 | 1,889,159 / 172,354 |
| nextjs | 17,423,055 / 134,550 | 1,693,925 / 58,138 |
| laravel | **failed**: never answered within a minute | **failed**: never answered within a minute |
| aspnet-aot (JSON only) | - | 378,054 / 55,755 |

### Efficiency

What each request costs the machine, from the same runs as the tables above. Pages per CPU-second is requests a second at 64 users over the share of its one core the app used; CPU for 300 pages/s is the fixed-rate phase; pages/s per MiB is the 64-user rate over peak memory.

| App | Pages per CPU-second: memory / item API | JSON per CPU-second: memory / item API | CPU for 300 pages/s from memory | Pages/s per MiB, from memory | Peak memory, 64 users |
|---|---|---|---|---|---|
| axum-maud | 28,300 / 1,055 | 17,185 / 1,004 | 3.6% | 1,697 | 16.1 MiB |
| **corten** | 21,195 / 3,670 | 27,491 / 3,817 | 4.2% | 1,234 | 16.8 MiB |
| drogon | 18,069 / 521 | 2,041 / 423 | 4.3% | 1,407 | 12.8 MiB |
| topcoat | 5,648 / 865 | 17,995 / 1,015 | 8.4% | 362 | 15.6 MiB |
| gin | 4,687 / 761 | 4,053 / 758 | 8.5% | 195 | 24.1 MiB |
| aspnet | 4,118 / 1,293 | 12,452 / 2,070 | 25% | 47 | 88.3 MiB |
| phoenix | 1,482 / 399 | 2,158 / 435 | 36% | 5.1 | 285.1 MiB |
| leptos | 1,356 / 747 | 15,989 / 989 | 25% | 83 | 16.2 MiB |
| astro | 1,203 / 461 | 1,879 / 546 | 29% | 8.7 | 137.6 MiB |
| spring | 1,023 / 498 | 7,006 / 942 | 51% | 2.9 | 360 MiB |
| sveltekit | 815 / 378 | 3,248 / 706 | 43% | 5.6 | 144.7 MiB |
| tanstack-start | 696 / 338 | 3,512 / 668 | 50% | 4.2 | 165.5 MiB |
| react-router | 530 / 293 | 2,314 / 598 | 61% | 3.6 | 147.8 MiB |
| rails | 440 / 308 | 870 / 403 | 75% | 3.1 | 140.6 MiB |
| nuxt | 325 / 217 | 7,275 / 801 | 100%, 291/s served | 2.3 | 142.8 MiB |
| django | 311 / 197 | 1,139 / 372 | 93% | 0.9 | 346.1 MiB |
| nextjs | failed (191) / failed (121) | 1,101 / 372 | failed (89%, 159/s served) | failed (0.9) | 222.6 MiB |
| laravel | **failed** / failed (111) | **failed** / 262 | **failed** | **failed** | **failed** |
| aspnet-aot (JSON only) | - / - | 9,357 / 1,509 | - | - | - |

Corten renders a page from memory with 47 µs of CPU (21,195 per CPU-second), against ASP.NET Core's 243 µs and Leptos's 737 µs; axum + Maud costs 35 µs and Drogon 55 µs. At 300 pages a second it used 4.2% of its core, and it serves 1,234 pages a second per MiB. From the item API, fetching and parsing the 55 KB item costs Corten about 225 µs a page, 4.8 times the page itself ([#166 Corten's item-API path spends six times as long fetching and parsing the item as rendering it, and the single-process item API could soon cap it](https://github.com/corten-run/corten/issues/166)).

At 64 users Corten's sampled CPU for the page and JSON from memory was 99.2% and 97.6% of
the app core, so the load kept it busy. Every Corten phase's per-CPU-second figure uses CPU
time counted from the cgroup counter (`cpuCounted: true`), not those samples. The item API
used 45.2% and 48.6% of one core for the page and JSON (45.7% and 48% at 256 users),
of the 200% its two processes can use.

### Bytes the item page loads (raw / gzip, KB)

| App | HTML | JavaScript (files) | WASM | CSS |
|---|---|---|---|---|
| astro | 7.9 / 1.9 | 25.0 / 9.2 (3) | 0 | 8.3 / 2.2 |
| **corten** | 9.1 / 2.1 | 38.5 / 14.1 (3) | 0 | 9.0 / 2.7 |
| topcoat | 10.5 / 2.3 | 47.6 / 15.0 (2) | 0 | 9.0 / 2.7 |
| django | 8.0 / 1.9 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| aspnet | 8.0 / 2.0 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| spring | 7.9 / 1.9 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| axum-maud | 7.7 / 1.8 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| gin | 7.7 / 1.8 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| drogon | 7.7 / 1.8 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| sveltekit | 17.0 / 3.7 | 97.6 / 37.4 (10) | 0 | 8.5 / 2.2 |
| rails | 9.2 / 2.3 | 152.2 / 40.7 (7) | 0 | 9.0 / 2.7 |
| phoenix | 10.7 / 2.6 | 149.2 / 46.2 (1) | 0 | 9.0 / 2.7 |
| nuxt | 17.9 / 4.6 | 198.6 / 72.9 (4) | 0 | 8.3 / 2.2 |
| laravel | 11.4 / 2.9 | 255.8 / 84.3 (1) | 0 | 9.0 / 2.7 |
| react-router | 20.2 / 5.0 | 311.4 / 99.2 (4) | 0 | 8.5 / 2.4 |
| tanstack-start | 18.0 / 4.4 | 342.4 / 110.7 (4) | 0 | 8.5 / 2.4 |
| nextjs | 26.4 / 4.9 | 456.5 / 136.2 (7) | 0 | 8.5 / 2.2 |
| leptos | 18.7 / 3.7 | 24.9 / 7.0 (1) | 770.6 / 305.4 | 8.5 / 2.2 |

### Browser, median of 10 (p90)

| App | Interactive | LCP | Blocking time | Form action | Client navigation | JS heap |
|---|---|---|---|---|---|---|
| Desktop | | | | | | |
| aspnet | 52 (55) ms | 76 ms | 0 ms | 74 ms | 17 (18) ms | 1.7 MB |
| drogon | 52 (54) ms | 72 ms | 0 ms | 76 ms | 17 (18) ms | 1.7 MB |
| django | 53 (56) ms | 76 ms | 0 ms | 73 ms | 20 (23) ms | 1.7 MB |
| gin | 54 (56) ms | 76 ms | 0 ms | 73 ms | 15 (15) ms | 1.7 MB |
| axum-maud | 55 (77) ms | 72 ms | 0 ms | 73 ms | 15 (16) ms | 1.7 MB |
| **corten** | 59 (67) ms | 72 ms | 0 ms | 81 ms | 13 (13) ms | 1.6 MB |
| topcoat | 59 (63) ms | 72 ms | 0 ms | 80 ms | 15 (16) ms | 1.9 MB |
| spring | 65 (71) ms | 84 ms | 0 ms | 73 ms | 33 (36) ms | 1.7 MB |
| astro | 65 (71) ms | 76 ms | 0 ms | 74 ms | 16 (17) ms | 1.6 MB |
| rails | 66 (71) ms | 72 ms | 0 ms | 89 ms | 27 (33) ms | 2.1 MB |
| laravel | 76 (85) ms | 72 ms | 0 ms | 88 ms | 24 (25) ms | 2.2 MB |
| nuxt | 111 (118) ms | 72 ms | 0 ms | 72 ms | 21 (23) ms | 2.9 MB |
| phoenix | 112 (147) ms | 92 ms | 0 ms | 79 ms | 18 (18) ms | 2.3 MB |
| leptos | 113 (126) ms | 96 ms | 0 ms | 72 ms | 24 (25) ms | 1.9 MB |
| sveltekit | 126 (128) ms | 88 ms | 0 ms | 72 ms | 33 (35) ms | 2.4 MB |
| tanstack-start | 141 (151) ms | 80 ms | 0 ms | 84 ms | 27 (30) ms | 3.1 MB |
| nextjs | 162 (174) ms | 84 ms | 0 ms | 87 ms | 140 (144) ms | 3.4 MB |
| react-router | 175 (188) ms | 112 ms | 0 ms | 91 ms | 42 (45) ms | 2.7 MB |
| Mobile (4x CPU, 150 ms RTT, 1.6 Mbps) | | | | | | |
| aspnet | 447 (451) ms | 436 ms | 17 ms | 285 ms | 242 (251) ms | 1.7 MB |
| drogon | 450 (452) ms | 432 ms | 17 ms | 285 ms | 214 (218) ms | 1.7 MB |
| django | 451 (455) ms | 428 ms | 14 ms | 292 ms | 248 (251) ms | 1.7 MB |
| topcoat | 455 (466) ms | 436 ms | 10 ms | 270 ms | 218 (221) ms | 1.9 MB |
| **corten** | 468 (483) ms | 460 ms | 13 ms | 285 ms | 199 (201) ms | 1.6 MB |
| spring | 642 (647) ms | 484 ms | 16 ms | 283 ms | 243 (247) ms | 1.7 MB |
| axum-maud | 643 (648) ms | 484 ms | 11 ms | 280 ms | 240 (243) ms | 1.7 MB |
| gin | 645 (649) ms | 480 ms | 11 ms | 293 ms | 241 (243) ms | 1.7 MB |
| astro | 683 (691) ms | 524 ms | 14 ms | 299 ms | 228 (232) ms | 1.6 MB |
| laravel | 884 (899) ms | 448 ms | 21 ms | 316 ms | 213 (214) ms | 2.2 MB |
| sveltekit | 887 (892) ms | 484 ms | 24 ms | 270 ms | 294 (299) ms | 2.4 MB |
| phoenix | 955 (977) ms | 424 ms | 52 ms | 129 ms | 138 (143) ms | 2.3 MB |
| react-router | 1,106 (1,160) ms | 472 ms | 46 ms | 327 ms | 300 (315) ms | 2.8 MB |
| rails | 1,182 (1,188) ms | 528 ms | 9 ms | 302 ms | 248 (251) ms | 2.1 MB |
| nextjs | 1,437 (1,557) ms | 428 ms | 154 ms | 296 ms | 520 (523) ms | 3.3 MB |
| nuxt | 1,563 (1,572) ms | 548 ms | 116 ms | 272 ms | 265 (272) ms | 2.9 MB |
| leptos | 1,926 (1,936) ms | 448 ms | 78 ms | 286 ms | 246 (248) ms | 1.9 MB |
| tanstack-start | 2,401 (2,407) ms | 516 ms | 126 ms | 286 ms | 341 (348) ms | 3.1 MB |

### Build, four cores (seconds of wall time, CPU-seconds in brackets)

From r16's build step (`build.json`; Method, item 10), on cores 1-4 of the droplet: Clean is
dependencies (downloads included) and build together, the only column that compares like for
like; After the edit is the median of three production builds after a one-line view change on
the tree the clean build left; Dev is the debug build, for the apps whose development loop
compiles the whole program. Peak memory is the highest of any single step the app ran, its
dependencies included. Corten's row builds card-market, the whole example app, a different and
larger crate than the other Rust apps' item pages, though the data does not size them.

| App | Clean | Build alone | After the edit | Peak memory | Dev clean | Dev after the edit |
|---|---|---|---|---|---|---|
| aspnet | 6.6 (9.0) | 5.2 | 4.8 (6.3) | 154 MiB |  |  |
| laravel | 6.6 (4.8) | 2.4 | 2.5 (2.5) | 48 MiB |  |  |
| django | 8.0 (6.4) | 0.9 | 0.9 (0.9) | 57 MiB |  |  |
| sveltekit | 12.8 (12.1) | 3.6 | 3.2 (4.2) | 571 MiB |  |  |
| react-router | 15.3 (14.4) | 1.3 | 1.4 (2.0) | 456 MiB |  |  |
| astro | 16.7 (17.9) | 2.1 | 1.7 (2.4) | 373 MiB |  |  |
| tanstack-start | 16.9 (17.8) | 2.3 | 2.1 (3.1) | 551 MiB |  |  |
| nextjs | 18.7 (33.9) | 7.5 | 4.5 (10.7) | 877 MiB |  |  |
| spring | 21.9 (27.1) | 3.4 | 2.9 (8.0) | 232 MiB |  |  |
| phoenix | 24.9 (55.4) | 5.1 | 4.2 (7.1) | 231 MiB |  |  |
| gin | 29.5 (89.7) | 27.8 | 0.9 (1.6) | 1,206 MiB | 28.2 (86.7) | 1.2 (2.0) |
| axum-maud | 31.7 (95.5) | 30.4 | 11.3 (27.2) | 605 MiB | 18.6 (61.0) | 1.6 (1.2) |
| rails | 44.7 (95.6) | 1.0 | 1.0 (1.0) | 592 MiB |  |  |
| nuxt | 45.4 (41.0) | 7.1 | 6.3 (9.9) | 658 MiB |  |  |
| topcoat | 70.1 (210.9) | 68.1 | 26.2 (58.4) | 884 MiB | 36.1 (124.3) | 4.7 (5.8) |
| **corten** | 77.3 (165.0) | 75.0 | 34.7 (65.2) | 680 MiB | 33.4 (89.7) | 2.6 (2.0) |
| drogon | 88.5 (305.3) | 6.7 | 2.2 (2.2) | 1,206 MiB | 6.3 (17.5) | 2.1 (2.1) |
| leptos | 197.8 (604.2) | 195.5 | 71.7 (138.8) | 2,020 MiB | 106.8 (411.0) | 9.6 (18.3) |

Clean, the Rust apps took 31.7-197.8 s (axum + Maud to Leptos), Topcoat 70.1 s and Corten
77.3 s, against 6.6-45.4 s for the apps not written in Rust or C++ and 88.5 s for Drogon (81.8 s of
it building Drogon itself). After the edit the Rust apps took 11.3-71.7 s (Corten 34.7 s),
against 0.9-6.3 s for the other apps. Corten's production build takes 2.4 times as long as
axum + Maud's clean build and 3.1 times as long after the edit, for a larger program (above).
Its development build after the edit took 2.6 s, against 1.6 s for axum + Maud, 1.2 s for Gin,
2.1 s for Drogon, 4.7 s for Topcoat and 9.6 s for Leptos. Of Corten's clean build,
card-market's own crate is the last 34.88 s of the 75.0 s build, corten 19.94 s before it;
the slowest other crate in the recorded list is tokio at 5.74 s. In a separate diagnostic build
of card-market's crate, LLVM optimization and thin LTO were 31.506 of its 34.985 s (90.1%),
and macro expansion, type checking and borrow checking 1.070 s together. Leptos peaked
highest at 2,020 MiB, next to Corten's 680 MiB.

### What the numbers say

These are observations about r16's historical implementations with unequal localization,
not current or general rankings. They are not v2 results.

1. Rendering from memory: axum + Maud serves 27,327 item pages a second at 64 users, then Corten (20,705) and Drogon (17,870). Corten serves 5.0x ASP.NET Core and 15.3x Leptos.
2. JSON from memory: Corten leads with 26,385 a second, ahead of Topcoat (17,790), axum + Maud (16,977) and Leptos (15,854).
3. With the item API every request fetches and parses about 55 KB of JSON. Corten serves 3,669 pages a second and 3,816 JSON responses; at 150 a second its page used 6.0% of its core.
4. Failed: Next.js failed the in-memory page and item-API page tests; Laravel failed both in-memory tests and its item-API page test. Django and Nuxt passed the in-memory page test again. No Corten test failed.
5. Cold start: axum + Maud, Corten, Topcoat, Leptos and Gin answer 6.3 ms, 8.6 ms, 8.1 ms, 8.0 ms, 10 ms after their processes start.
6. Browser: Corten is interactive in 59 ms on desktop and 468 ms on the throttled phone. The item page loads 14.1 KB of JavaScript (gzip).

r16 ran on a Platinum 8168, as r15 did, on another droplet. The server rows are medians
of three passes in r16 against one in r15. Among the other apps passing each test in both rounds,
median 64-user throughput changed +7.0% for the page from memory (13 apps),
+8.6% for JSON from memory (17), +9.1% for the item-API page (15), and
+8.7% for item-API JSON (18). These are reference peers, not unchanged-app controls:
every page app's Show all markup changed, and Corten now sends five offers initially rather
than every offer in hidden templates (caveat 16). Corten changed +37.1%, +17.0%,
+9.9% and +8.0% respectively; the page gain is not a like-for-like rendering speedup.
Page user instructions fell from 103,544 to 94,677 and JSON from 70,588 to 69,631;
kernel instructions rose from 32,705 to 33,663 for pages and 32,897 to 34,244 for JSON.
JavaScript got worse: 13,187 to 14,392 gzip bytes (+9.1%). HTML fell 10.1% and CSS held.
Cold start rose from 7.7 to 8.6 ms; desktop and phone interactive changed from
61 to 59 ms and 474 to 468 ms. No other Corten metric crosses the single-round regression
thresholds, and the trend detector reports no drift or warning. These runs do not establish a cause.

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

### Hardening, nine apps at their defaults (round harden-local3, 2026-11-07)

How each app holds up against slow clients, oversized requests and connection floods, as its
framework starts it (the step is Method, The hardening step). Measured locally (Docker Desktop on
Windows, one run each, with Rust builds running on the machine, so the well-behaved client's
latencies are indicative; `results/harden-local3/hardening.json`, where each phase's `taken` says
the commit it ran at: the first four phases at `d456063e` with local changes, this step's probe
before the commit that adds it, and the clients that stop reading and the oversized requests run
again at `330ff623` with none, each keeping its first pass in `earlier`; the first pass's `taken`
is the file's header from then, marked `fromHeader`, whose time is when it was last written): Corten,
axum-maud and the six other apps the matched tier then named (Next.js, Leptos, Django, Spring,
Topcoat and ASP.NET Core), ASP.NET Core as both its Razor Pages app
and aspnet-aot. Corten is card-market, with its own 10 s request deadline and its write limit
raised for the probe (Method, The hardening step). The images
were `cb-corten` and `cb-axum-maud` built at `720c8a88`, `cb-aspnet-aot` at this step's first
commit and the others on 2026-11-06 from main, whose apps changed after that only in the page
markup of
[#942 Benchmark: the item page's apps return the same visible page but do different work (Corten formats prices per request and renders every offer)](https://github.com/corten-run/corten/issues/942).
Every app but Next.js was still running after every phase and answered a request on a new
connection after it; Next.js's process had exited during the clients that stop reading (`DOWN`;
the next phase starts the app again). Each cell: what the app did with the abusive connections
(closed, within how long of each one's connect, with what it answered first when it answered;
held, to the end of the phase's hold; for the clients that stop reading, whether the server was
still sending to those it held), the well-behaved client's p99 and its failures (none unless said),
the app's peak memory and its CPU in cores. Times are to about a second: a connection's open is
seen when the probe's event loop gets to it. The probe that ran the clients that stop reading
counted only what the kernel held unread, not what a paused socket had already read into its own
buffer (up to 64 KiB, counted since), so a connection sent less than that reads as sent nothing,
and Django's "none unread at the median" may be up to 64 KiB each.

| App | 2,000 unfinished heads | 200 heads, a byte a second | 100 bodies, a byte a second | 200 clients that stop reading | 5,000 idle connections |
|---|---|---|---|---|---|
| corten | closed within 30.0 s; 160 ms; 49 MiB; 0.02 cores | closed within 29.1 s; 25 ms; 8 MiB; 0.01 cores | closed within 10.1 s (503); 66 ms; 12 MiB; 0.02 cores | closed within 63.1 s; 153 ms; 79 MiB; 0.06 cores | closed within 30.0 s; 245 ms; 41 MiB; 0.04 cores |
| aspnet-aot | closed within 32.0 s (408); 207 ms; 55 MiB; 0.06 cores | closed within 31.7 s (408); 18 ms; 23 MiB; 0.04 cores | closed within 6.8 s (405); 37 ms; 20 MiB; 0.03 cores | closed within 25.5 s; 915 ms; 105 MiB; 0.54 cores | held 60 s; 89 ms; 85 MiB; 0.05 cores |
| aspnet | closed within 32.2 s (408); 200 ms; 90 MiB; 0.17 cores | closed within 31.3 s (408); 29 ms; 59 MiB; 0.14 cores | closed within 5.4 s (400); 176 ms; 46 MiB; 0.27 cores | held 90 s (129 no longer sent to); 3,280 ms; 176 MiB; 0.92 cores | held 60 s; 248 ms; 121 MiB; 0.17 cores |
| topcoat | closed within 32.1 s; 379 ms; 40 MiB; 0.04 cores | closed within 30.0 s; 48 ms; 7 MiB; 0.03 cores | held 90 s; 41 ms; 6 MiB; 0.03 cores | held 90 s (no longer sent to); 1,383 ms; 85 MiB; 0.23 cores | held 60 s; 212 ms; 36 MiB; 0.04 cores |
| axum-maud | held 45 s; 133 ms; 52 MiB; 0.03 cores | held 60 s; 21 ms; 8 MiB; 0.04 cores | held 90 s; 16 ms; 7 MiB; 0.03 cores | held 90 s (no longer sent to); 1,296 ms; 84 MiB; 0.23 cores | held 60 s; 253 ms; 62 MiB; 0.04 cores |
| leptos | held 45 s; 201 ms; 39 MiB; 0.04 cores | held 60 s; 58 ms; 6 MiB; 0.03 cores | closed within 0.2 s (405); 226 ms; 4 MiB; 0.01 cores | held 90 s (182 no longer sent to); 1,561 ms; 83 MiB; 0.49 cores | held 60 s; 524 ms; 34 MiB; 0.04 cores |
| nextjs | held 45 s; 343 ms; 154 MiB; 0.2 cores | held 60 s; 433 ms; 145 MiB; 0.2 cores | degraded: held 90 s (200); 4,182 ms, 25 of 893 failed; 171 MiB; 0.22 cores | DOWN: closed within 78.0 s; no answers, 771 of 771 failed; 647 MiB | held 60 s; 340 ms; 198 MiB; 0.23 cores |
| spring | held 45 s; 1,420 ms; 309 MiB; 0.42 cores | held 60 s; 209 ms; 172 MiB; 0.37 cores | held 90 s; 1,428 ms; 284 MiB; 0.32 cores | degraded: held 90 s (still being sent to); 4,071 ms, 888 of 892 failed; 478 MiB; 0.99 cores | closed within 61.3 s; 224 ms; 259 MiB; 0.22 cores |
| django | degraded: closed 3 of 2,000 within 30.5 s (500 to 3), held the rest; 4,944 ms, 419 of 458 failed; 152 MiB; 0.05 cores | degraded: closed 3 of 200 within 30.8 s (500 to 3), held the rest; 4,934 ms, 588 of 597 failed; 128 MiB; 0.08 cores | closed within 0.3 s (403); 332 ms; 97 MiB; 0.18 cores | degraded: closed 129 of 200 within 88.7 s, held the rest (none unread at the median); 274 ms, 894 of 895 failed; 94 MiB; 0.1 cores | degraded: closed 9 of 2,042 within 91.9 s (500 to 9), held the rest; 4,466 ms, 1,163 of 1,205 failed; 146 MiB; 0.03 cores |

The slow-body column is not the same work in every app. aspnet-aot (no form) and Leptos (no POST
at the item's URL) answered 405 and Django 403 (its CSRF check) before reading a body. The Razor
Pages app answered 400 and closed within 5.4 s, and aspnet-aot closed within 6.8 s; that those
closes are Kestrel's minimum request rate (240 bytes a second after 5 s) is inferred from its
documented default, as only the close is timed.
aspnet-aot has no pages, so it was sent the 9 KB JSON where the others were sent the page: the
like-for-like Kestrel for the clients that stop reading is the Razor Pages app.

Oversized requests (200 headers / a 1 MiB header / a 16 MiB body to the form): corten 431 / 431 / 413; aspnet-aot 431 / 431 / 405; aspnet 431 / 431 / 400; topcoat 431 / 431 / reset; axum-maud 431 / 431 / 413; leptos 431 / 431 / reset; nextjs 200 / 431 / 200; spring 400 / 400 / 413; django 431 / 431 / 403. "reset" is a connection the server reset while the probe was still sending the body (its
write failed with `EPIPE`) with no answer read: hyper (Corten, Topcoat, axum-maud, Leptos)
answers and closes without reading the rest. Whether the answer arrives before the reset is a
race: axum-maud's 413 arrived and its connection was then reset, Corten's 413 arrived with no reset,
and Corten's 431 for the 1 MiB header arrived before its connection was reset, the reset
[Choice 19](../../docs/design.md#choice-head-size) describes for a head past the limit (an earlier
local run read 413 from both Corten and axum-maud, `results/harden-local1/hardening.json`).

Where Corten leads: it closed every abusive connection in every phase, was never degraded, and its
well-behaved client's p99 stayed under 500 ms throughout. Its idle connections were closed by the
header timeout in 30 s, where both Kestrel apps held all 5,000 for the phase's 60 s:
`App::max_connections` is unbounded by default, as Kestrel's is
([Choice 19](../../docs/design.md#choice-head-size)), and the timeout is what bounds them. Against
the clients that stop reading it took 0.06 cores (0.08 in the first pass), where Topcoat and
axum-maud (also hyper, whose writes to every one were blocked by the hold's second half) took 0.23
each (0.63 and 0.87 in the first pass), Leptos 0.49 (0.69), aspnet-aot 0.54 (0.60), the Razor Pages
app 0.92 (1.00) and Spring 0.99 in both (still sending at the end: none of its 200 held the same
unread bytes at both reads, so its 90 s measures its pipelined throughput as much as a slow
reader); Django took 0.1 (0.11) with 894 of 895 of the well-behaved client's requests failing. The
two passes ran the same day on the same images and differ up to fourfold for the hyper apps: in
both Corten took the least and Django the next least, but the other apps' order changed between
them, and two runs do not settle the ratios. Estimated, not measured: at the item-API page's cost
in the Efficiency table (3,670 pages per CPU-second for Corten, 865 for Topcoat, 1,055 for
axum-maud), the rerun's CPU is about 69, 93 and 112 pages for each of the 200 connections, counts
close enough that most of the gap would be what each page costs, not how many each server sent
before its writes blocked. Where it falls short:

1. A body sent a byte a second is closed by the request deadline (card-market's 10 s, with a 503;
   30 s by default), not by a rate: Kestrel closed it within 5.4 to 6.8 s, by its minimum request
   rate as far as can be told (above). On a route whose deadline is removed (`deadline(None)`, for
   a long upload), a body read as it arrives (`pieces_up_to`, `Upload`) is given up on with a 408
   once it falls `Upload::idle`'s minute behind 240 bytes a second, Kestrel's minimum rate, which
   a byte a second does after about 60 s (from the guide, not measured here; before
   [#1074 A request body trickled in a byte at a time is bounded only by the route's deadline: a route with none (a long upload) holds the connection as long as the client likes](https://github.com/corten-run/corten/issues/1074),
   at `73e1c453`, nothing closed it). That is still about ten times Kestrel's time, by design: the
   idle time is the allowance, so an upload that pauses is not cut off.
2. A client that stops reading is closed by `App::send_timeout`'s 60 s (63 s from its connect,
   with the time the server took to fill the socket's buffers), nginx's send timeout, which Corten
   chose over Kestrel's minimum response rate ([Limit 14](../../docs/design.md#limit-http1)):
   aspnet-aot, sent the 9 KB JSON, closed its slow readers within 25.5 s, while the Razor Pages
   app, sent the page as Corten was, held them all 90 s.
3. The 16 MiB body can reach the client as a closed connection instead of the 413: in 1 of the 3
   committed local passes, harden-local3's first (in `earlier`), Corten's connection closed while
   the probe was still sending (the write failed with `EPIPE`) and no 413 was read, and the 413
   arrived in the other 2 (harden-local1 and harden-local3's rerun); a fourth local run, not kept,
   also read the body's connection closed. In that first pass the 1 MiB header's 431 was lost too
   (`closed`; resets for headers were not recorded then). Kestrel (both apps) and Spring answered all three requests in both of
   harden-local3's passes, with no reset. It is the race described above, which hyper's close without reading the rest of the body
   decides.

The table has no droplet round yet: `droplet.mjs <round> --suite harden` runs it (Running it).

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

Instructions are `count.mjs ... api`, median of 3 x 5,000 requests. r16, on a Platinum 8168,
serves 3,669 item-API pages a second against ASP.NET Core's 1,292 (2.8x; 2.8x in r15),
at 6.0% of its core at 150 a second against 32%
(the fixed-rate CPU computed from requests per CPU-second).

### Instructions per request, by crate (callgrind, 2026-11-05)

Where one request's user instructions go, measured on main `b79a6b23`: card-market's release build
(line tables only, the same code) under callgrind, serving 300 and then 1,300 requests over one
keep-alive connection with `Accept-Encoding: identity`, in two runs, one pair of runs for each
column. The difference over 1,000 is one request with startup and shutdown cancelled out
([cost-by-crate.sh](cost-by-crate.sh), split by [cost-by-crate.mjs](cost-by-crate.mjs)).
Rendering is deterministic (writing HTML is 51,124 in both page columns, measured apart); the
tokio and allocator rows depend on scheduling, and one pair does not show their spread. Kernel
instructions are not seen by callgrind; `count.mjs` gives them (Corten's page 32,705 and JSON 32,897 a
request in r15's instruction table, topcoat's page 31,827, Leptos's 35,722). The current table is r16's.

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
   routes itself: not a throughput reason on its own. [Design Choice 25](../../docs/design.md#choice-axum-router) records the decision to
   keep axum's routing.
2. Reading upstream JSON is where an item-API page goes: skipping undeclared members (most of
   it inside two nested objects the app reads one member of), the allocator (19.0% there against
   6.8% from memory; which code made them is inferred, as the split keeps no call graph for it) and
   fields read as `Value`. The reader's part is [#763 Corten's form, route and JSON readers still require serde's Deserialize beside their own derives, and FromJson allocates every string it reads from an upstream body](https://github.com/corten-run/corten/issues/763).
3. hyper and http are 13% to 15% from memory, about half of it on the page (42% on the JSON)
   `HeaderMap` hashing, inserting and lookups; tokio is 2% to 3% on one connection. Neither is
   worth tuning before rendering and reading.
4. On the page, locale formatting is the largest single function, ahead of HTML escaping.

### Writing the item page: `html!` against Maud (callgrind, 2026-11-06)

The same split for card-market and the axum + Maud app (`APP=axum-maud`), three rounds of each at
`ff1701b8`, alternating, with each function's cost with what it calls (`INCLUSIVE=`). Rendering
is deterministic: within 2 instructions in every round.

| | card-market (`html!`) | axum + Maud (maud 0.27.0) |
|---|---|---|
| Writing the document (`Req::render_into`, `pages::item`) | 44,494 | 53,935 to 53,937 |
| Escaping (`escape_into`, `escape_to_string`) | 12,881 | 38,060 |
| The rest of writing | 31,613 | 15,877 |
| Bytes an answer | 8,931 | 7,473 |
| The whole request, three rounds | 94,864, 86,199, 86,224 | 72,074, 72,274, 72,244 |

The pages show the same thing but are not the same work. card-market's document carries more
(the head's description, canonical link, icon and runtime tags, a data attribute on each listing
row) and writes prices, ratings and counts in the visitor's locale (`Formatted`, 8,701), where the
Maud app writes the item API's strings. Maud's escaping pushes each byte on its own: the escaping
gap (25,179) is larger than the whole difference (9,441 to 9,443), and outside escaping `html!` does
about twice Maud's work. Each whole request has more than writing: Corten's request path adds its
security headers, the page's key and the rest of the by-crate table above. card-market's first round
has 8,640 to 8,665 more than the others, which `malloc_consolidate` accounts for (8,630 to 8,632
with what it calls).

### What a browser's request costs Corten (callgrind, 2026-11-06)

The rounds' page requests send `Accept-Encoding: identity` and no `If-None-Match`, the one
request Corten neither tags nor compresses ([design Limit 21](../../docs/design.md#limit-etag): a client that accepts no compression
and names no tag is not a browser keeping pages). Every browser names a compression, so its page
has its `ETag` hashed and its body compressed as well. Measured on this branch's base, main
`a17f1775`, with `route_loop`'s `LOOP_ENCODING` and `LOOP_TAG` added: card-market's release
build, the item page as a full document through the router in process (no hyper, socket or
kernel, so these counts are lower than `count.mjs`'s for a round), items in memory, five offers.
User instructions a request are the difference between a short and a long loop under callgrind,
over the difference in requests: three pairs of 2 s and 6 s loops, median (range); brotli is slow
enough under callgrind that its pairs are 1 s and 30 s loops, two of them, mean (range). The time
is the same loop without callgrind, on Docker Desktop with other work running, three runs (one
for the hash alone); requests a second under load were not measured.

| The request | What Corten does | Instructions a request | Time a request |
|---|---|---|---|
| `identity`, no tag (the rounds, `curl`) | renders | 86,489 (86,485-87,272) | 38-44 µs |
| `identity`, an `If-None-Match` that matches nothing | renders, hashes the tag | 114,189 (113,966-114,218) | 47 µs |
| `gzip, deflate, br, zstd` | renders, hashes, zstd 1 | 344,441 (343,629-345,211) | 94-126 µs |
| `gzip, deflate, br` | renders, hashes, brotli 2 | 1,336,000 (1,335,086-1,336,899) | 283-301 µs |

So hashing the tag adds 27,700 instructions (32% of the in-process request, close to the third of
the render [Limit 21](../../docs/design.md#limit-etag) gives), zstd 1 a further 230,000 (the page averages 8.8 KB, about 2.2 KB once
compressed), and brotli 2, the level until the change below, a further 1.22 million in place of
zstd's. Under zstd, 98% of the compression is the zstd library's own work (of `ZSTD_compress2`:
`ZSTD_compressBlock_fast` 44%, Huffman coding of the literals 21%, the sequences 20%). In process,
a browser's page view costs Corten about four times the instructions of the rounds' request with
zstd, and with brotli, which a client that does not send zstd gets, fifteen times at level 2 and
about nine at level 1; against a round's whole request (r15's page: 103,544 user instructions, 25
offer rows) the same increments are about 3.5, 13 and 8 times, less with the kernel's instructions
counted; hashing and compressing grow with the body, so on r15's
larger page the increments, and these ratios, would be larger.

Since
[#985 Per-request brotli costs about 1.2 million instructions on the item page, 5x zstd 1, with a 4 MiB window for an 8.8 KB body](https://github.com/corten-run/corten/issues/985),
a page compressed per request with brotli uses level 1, measured the same way (two pairs of 1 s
and 30 s loops each; bytes from `render_cost`, the average over its 500 items): level 2 at
`a17f1775` (the table above), level 1 at `7b882204`, and level 0 at `7b882204` with the window
sized to the body in a local build:

| brotli level | Instructions a request | Bytes sent |
|---|---|---|
| 2 (before this change) | 1,336,000 (1,335,086-1,336,899) | 2,142 |
| 1 (now) | 806,872 (806,866-806,878) | 2,358 |
| 0, window sized to the body | 859,102 (857,999-860,205) | 2,492 |

Level 1 takes 40% fewer instructions than 2 for 10% more bytes, still fewer than gzip 1's 2,506
and about 8% more than zstd 1's 2,178; level 0 costs more than 1 and sends more. The 216 bytes level 1
adds fit in the same first congestion window, so they cost a client no round trip, only the time
to send them, and the server saves about 529,000 instructions a page. Both sides are estimated:
216 bytes take about 173 µs at 10 Mbit/s and 17 µs at 100 Mbit/s, and 529,000 instructions about
115 µs of the server's CPU (at the rate of the brotli row in the table above, 1,336,000 in 283 to
301 µs). So below about 15 Mbit/s an
unloaded request may reach the client slightly later at level 1; on a faster link, or on a busy
server, where the CPU a request takes is time other requests wait, level 1 is ahead. Most of what level 1 still costs is the brotli crate's own encoder
and the tables it allocates and zeroes for each response. Those cannot be kept between responses
as zstd's context is: the crate's encoder ends a stream finished and has no reset, so each
response needs a new one. A 4 MiB window was not the cost either: sizing the window to the body
left the instructions unchanged at level 1 (806,910 against 806,872 a request) and within about
430 a request at level 2.

The rounds' page numbers (20,705 a second, 47 µs of CPU a page in r16) are for the request
without either. Sending a browser's headers instead would compare the frameworks' compression
defaults rather than their rendering: in round conform2, asked with `Accept-Encoding: br, gzip`,
eight of the eighteen page apps compressed the page (Corten, React Router, Leptos, Laravel and
Topcoat with brotli; Next.js, Phoenix and Drogon with gzip) and ten sent it as it is, and none
compressed a request that named no encoding. The tag does not split the same way. SvelteKit and
Rails tag every page, even on a request that names no tag and no encoding (conform2's page probe;
that they do so on `identity` too is inferred), so under the rounds' requests they pay for a hash
that Corten skips, which favors Corten's rows; it does not change their places (773 and 417 pages
a second against 15,103 in r15). No other app sent an `ETag` on that probe.

### What each production default costs (callgrind, 2026-11-07)

Corten's production defaults run on every request, so its rows include their cost; this says
how much each one is. card-market's release build at `cdbe4392` was built as it is and eight times
more, each with one default removed by a patch in [ablate/](ablate/) (no off switch exists or is
proposed for most of them), and each build served the item page and its JSON over one keep-alive
connection under callgrind, items in memory, with `Accept-Encoding: identity` (the rounds'
requests) and with a browser's `gzip, deflate, br, zstd`. Instructions are counted only while
the requests are served (zeroed once the server answers, dumped before it stops, so freeing the
items at shutdown is not in them), and one request is the run of 1,300 requests less the run of
300, over 1,000. A default's cost is the build as it is less the build without it, repeat by
repeat: five repeats, median (range); at this resolution a default's cost is good to a few
hundred instructions (code layout moves between builds, and now and then one run's fixed part
jumps by about a million, which moves that repeat by about 1,000 and the median not at all), so a
row near zero, or one whose range crosses it, says the default costs nothing that can be seen.
User instructions only (callgrind does not see the kernel's), on glibc's allocator and the zstd the
crate bundles, where the rounds' image preloads jemalloc and links Debian's libzstd
([design Choice 23](../../docs/design.md#choice-jemalloc-image) puts this page at about 83,000
under jemalloc against 87,000), so these are the rounds' request shape, not their configuration.
Requests per CPU-second under load were not measured, which needs a droplet round ([#1052 No number says what each of Corten's production defaults costs in requests per CPU-second under load, only in instructions on one connection](https://github.com/corten-run/corten/issues/1052)) ([cost-by-default.sh](cost-by-default.sh), split by [cost-by-default.mjs](cost-by-default.mjs);
results and each build's answer headers in [results/defaults1](results/defaults1/)). The headers
show what four patches remove: the security headers patch seven headers on the page and five on
the JSON, the `Cache-Control` patch that header, the `ETag` patch the page's tag for a browser
(nothing else is tagged), and the compression patch `Vary: accept-encoding`, with
`Content-Encoding` and the compressed length for a browser. Every other header and every
`Content-Length` but compression's matches the build as it is, and the other four patches answer
as it does. The `ETag`'s value is keyed per process, so it differs between every two files and
says nothing. What says those four remove only their default is the patch's text alone (the
script's check that every build is a different binary says only that each patch changed
something). The results were counted by an earlier version of the script, which zeroed the count
where this one dumps it, did not check the zero, and did not stamp its builds; each 300-request
run there is 300 requests' cost and a fixed part of about 1.1 million instructions (5.8 million
with zstd), so no startup is in them. Zeroing and dumping were compared once, one repeat of the
page for a browser, as it is and without the `ETag`, on the same two builds (of `f3291094`, not
`cdbe4392`): 344,746 against 344,744 a request, the `ETag` 26,215 against 26,522, within the
resolution above.

| Default removed | Page, `identity` | Page, browser | JSON, `identity` | JSON, browser |
|---|---|---|---|---|
| None: instructions a request | 86,500 | 344,393 | 65,558 | 227,082 |
| Security headers and the CSP (the page's nonce too, where it has one) | 4,789 (4,775-4,850) | 5,162 (4,635-5,576) | 2,343 (2,274-2,428) | 2,319 (1,222-2,328) |
| The host check and the same-origin write check | 610 (471-1,264) | 609 (128-634) | 634 (555-758) | 620 (387-665) |
| The deadline and the panic catch | 414 (406-424) | 421 (251-793) | 54 (1-87) | -122 (-291 to -70) |
| Compression | 2,733 (2,676-3,331) | 233,554 (233,261-233,940) | 1,712 (1,687-1,941) | 162,649 (162,624-162,665) |
| The `ETag` | 8 (-47 to 46) | 26,536 (26,409-26,956) | 50 (-3 to 71) | 24 (12-36) |
| Setting `Cache-Control` | 777 (758-824) | 1,226 (809-1,795) | 808 (746-1,081) | 792 (418-938) |
| Error pages and problem+json (on a success) | 1,076 (1,061-1,092) | 1,072 (521-1,646) | 188 (156-222) | 151 (-348 to 185) |
| The header and send timeouts' connection watch | 83 (7-97) | 79 (-74 to 1,017) | 97 (22-143) | 71 (64-154) |

On the rounds' requests, every default together costs about 10,500 instructions of the page's
86,500 (12%) and 5,900 of the JSON's 65,600 (9%); the largest is the security headers and CSP,
4,800 a page (5.5%), which adds seven headers, then compression's 2,700 a page, which
compresses nothing there: it reads the body's type and size and adds `Vary: accept-encoding`.
That is more than the 1,448 the by-crate split above gives not compressing (`negotiate`, `vary`,
`finish`), though the ablated build still negotiates (the `ETag` decision reads it); the rest,
perhaps hyper writing the extra header and a larger request future, was not measured, so it is
unexplained. For a browser, compressing is two thirds of the page request (233,600 of 344,400
with zstd 1) and nearly three quarters of the JSON's (162,600 of 227,100) and the page's `ETag`
26,500 (7.7%, close to the 27,700 measured in process above); the JSON is not tagged, and nothing
is tagged on `identity` ([design Limit 21](../../docs/design.md#limit-etag)). The rest are each
under 1.3% of a request on `identity`; for a browser the security headers are 1.5% of the page
and 1.0% of the JSON, and the rest under 0.4%. The connection watch's 80 a request is at the edge of
this resolution (its browser range crosses zero); it would be per-request work, marking the
connection busy and idle and its read and write checks, by reading the code rather than by a count,
since one connection's setup (its clock entry) cancels out between the two runs, though the clock's
once-a-second tick, which grows with a run's length, is in it. Removing every default at once was
not measured, so the sum assumes they do not overlap.

So about a tenth of a round's Corten user instructions are defaults that the other apps mostly do
not have ([feature matrix](#feature-matrix-the-bench-apps-as-written-round-conform2-2026-11-04)).
A matched tier
([#807 bench/fullstack has no tier where every app implements the same production features, so its tables mix framework cost with feature cost](https://github.com/corten-run/corten/issues/807))
would leave Corten's rows as they are; what the same features cost the other apps, each in its
own framework's middleware, is not measured here. This runs outside rounds, Corten alone, when
a default changes
([#817 A bench/fullstack round takes 5.5 hours, the planned tiers and repeats would take it past 15, and nothing sets which apps, phases and cadence each tier gets](https://github.com/corten-run/corten/issues/817)).

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

### The image's allocator (Docker Desktop, 2026-11-08)

The evidence behind [design Choice 23](../../docs/design.md#choice-jemalloc-image), card-market
built at `81f1f8ef` with only its allocator's environment changed, except the tuned image in
`results/alloc-faults` and `alloc-idle` (`corten-card-market-p1011b`), a build of this change whose
commit was not recorded, which matched the environment-only `cm-p1011-tc65536` in
`results/alloc-faults-br`. The fault folders' JSON records every image's id and settings, the flood
folders' the image's id and each variant's settings added to it; the table gives the `ab.mjs`
folders':

| Folder | What | Images |
|---|---|---|
| `results/flood-memory`, `-mmap`, `-tuned` | `flood-memory.mjs`: eight floods of 4,000 unfinished heads, three runs each | jemalloc unset, `background_thread:true`, and that with `tcache_max:65536`; glibc, with two arenas or one, and with a 16 KiB mmap threshold |
| `results/alloc-faults` | `alloc-faults.mjs`: page faults and CPU a request, three encodings, three rounds | jemalloc unset (`cm-p1011-je`), the tuned image as committed (`corten-card-market-p1011b`), glibc (`cm-p1011-glibc`) |
| `results/alloc-idle` | `alloc-faults.mjs` with `IDLE_SECONDS=60`: CPU and threads of an untouched app, three rounds | jemalloc unset, the tuned image, and that with `max_background_threads:1` (`jecap1`) |
| `results/alloc-faults-br` | the same, brotli only | jemalloc unset, `background_thread:true` (`jebg`), no decay (`jenodecay`), `thp:never`, `retain:false`, `tcache_max` 64 KiB and 8 MiB, the tuned image, glibc |
| `results/ab-jemalloc` | `ab.mjs`, three encodings, three rounds | jemalloc unset (`je`), `background_thread:true` (`jebg`), glibc |
| `results/ab-jemalloc-br` | `ab.mjs`, brotli only | jemalloc unset, `oversize_threshold` 0 (`jeos0`) and 64 MiB (`jeos64`), glibc |
| `results/ab-jemalloc-tuned` | `ab.mjs`, three encodings, three rounds | jemalloc unset, `background_thread:true,tcache_max:65536` (`jecand`), glibc |

All ran on a desktop with other containers running, so the `ab.mjs` rounds moved by up to 2.4
times between rounds of one image; the fault counts repeat to 0.1 a request. A quiet host has not
run them.

### Build cost on a desktop (round local-2, 2026-11-03)

`build.mjs local-2 all 1` on Docker Desktop (WSL2, 8 CPUs, 9.7 GiB), each step pinned to cores
0-3, on a desktop with other work running (not recorded per step): one run each, kept for the
record; the Build table in Results is from r16, the current droplet round that measured it. The
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
   `codegen-units = 1`, `lto = "thin"` and `opt-level = 3`; the deployment guide's [release profile](../../docs/guide/deploy.md#the-release-profile)
   section compares it with sixteen codegen units and with Cargo's default. In the
   desktop's diagnostic build, macro expansion (0.3 s), type checking (0.65 s) and borrow
   checking (0.87 s) were under 2 s together, and monomorphization 5.6 s.
2. zstd-sys's build script (compiling zstd's C sources, for `corten::compress`) is the slowest
   dependency, and on the critical path here: it ends at 112 s and corten starts at 113 s. It
   took 93 s in this run, and 176 s and 237 s in two earlier desktop runs (not kept here) that
   limited the CPU with a four-core quota instead of pinning, so its time is not settled. From
   the run after this one, Corten's recipe links the build image's libzstd
   (`ZSTD_SYS_USE_PKG_CONFIG=1`, as the template's Dockerfile does), so zstd-sys no longer
   compiles zstd and leaves this list for that reason, not a change in rustc or Corten
   ([#772 Every new Corten app compiles zstd's C sources (compress is in the template), the slowest dependency and on the critical path of a clean release build](https://github.com/corten-run/corten/issues/772)).
3. Then corten (54 s), then card-market; corten-macros (15 s, done at 102 s) did not hold either
   up in this run.
4. What the macros write into card-market, as lines of code for rustc to check and compile, not
   time measured: `#[derive(Deserialize)]` 4,884 lines over 19 uses, `messages!` 1,762 in one,
   `#[component]` 1,088 over 12, `html!` 917 over 18.

### The editor's server and the Docker build after an edit (Docker Desktop, 2026-11-08)

`rust-analyzer.mjs` (`results/dev-loop`, at `9da8fb8d`; `results/dev-loop-default` with
`RA_EXPERIMENTAL=off`) and `docker-rebuild.mjs dev-loop corten,axum-maud 3` (at `c65c10ec`, with
only this folder's scripts changed), on Docker Desktop (WSL2, 8 CPUs, 11.7 GiB) with other work
running, each pinned to cores 0-3 with a 9.7 GiB cap, one app at a time: once, kept for the
record until a droplet round runs them (both run in a round's build step from now on, Method,
item 10). This machine is slow and noisy for builds: axum + Maud's kept-builder Docker build
took 38.7 s where r16's in-container rebuild on the droplet took 11.3 (not the same measurement,
so the ratio is only a rough guide), and Corten's three kept-builder builds ranged from 125 to
303 s and 175 to 366 CPU-seconds. Read the gaps between apps, not each figure.

rust-analyzer 1.99.1, check on save off and its experimental diagnostics on, five edits each
(median, with the completion's range in parentheses; after each edit a completion inside the item
page's markup, then the file's errors asked for at once):

| App | Ready, cold | Ready, warm | Completion after an edit | Unknown field shown | Cleared | Peak memory |
|---|---|---|---|---|---|---|
| axum-maud | 17.1 s | 8.5 s | 89 ms (77 to 842) | 72 ms (5 of 5) | 71 ms | 1,447 MiB |
| **corten** | 42.3 s | 19.7 s | 87 ms (68 to 986) | 65 ms (5 of 5) | 59 ms | 2,568 MiB |
| topcoat | 28.4 s | 8.6 s | 5,537 ms (4,914 to 6,934) | 5,298 ms (5 of 5) | 5,598 ms | 2,139 MiB |
| leptos | 46.1 s | 27.8 s | 10,268 ms (8,186 to 15,105) | 9,721 ms (5 of 5) | 9,005 ms | 3,698 MiB |

1. Inside `html!` the server answered in under a tenth of a second (medians of five edits; the
   first completion after the file is opened took about a second), as it did inside Maud's
   `html!`: a completion after an edit, and an unknown field in the markup reported as an error
   and gone once fixed. Inside Topcoat's and Leptos's `view!` each took 5 to 10 seconds (medians;
   4.8 to 15.1 s over every edit). The markup is not the same size: the macro call the completion
   is in has 25 lines in Corten's `views/alert.rs` (60 lines, two `html!`), 121 in Maud's
   `pages.rs` (249, six), 108 in Topcoat's `main.rs` (440, nine `view!`) and 119 in Leptos's
   `app.rs` (401, thirty-three), and asking for a file's errors analyses all of it. Corten's call
   is about a fifth the size of the others', so this shows the server is not slow inside a small
   `html!`, not that it is as fast as inside Maud's on the same markup, which is not measured.
2. Corten's server loads the whole workspace (its crates and every example app), against axum +
   Maud's one crate; how much of its longer ready time and larger memory that accounts for, and
   what an app with Corten from crates.io would take, is not measured here. Peak memory is the
   warm server's processes' peaks summed (the server and the proc-macro server that expands the
   markup), read after the five edits.
3. With the experimental diagnostics off, as rust-analyzer ships (`results/dev-loop-default`),
   the server reported the unknown field in none of the four, Maud's included, in any of the
   five edits:
   `cargo check` on save (Build) is what shows it then.

The app's own `docker build`, seconds of wall time (CPU-seconds), each the median of its own
three runs:

| App | Cold | After the edit, builder kept | After the edit, layer cache imported |
|---|---|---|---|
| axum-maud | 147.7 (339.0) | 38.7 (74.7), its crate alone | 141.2 (299.8), 130 crates |
| **corten** | 268.7 (440.2) | 149.1 (196.2), 3 crates | 228.2 (361.3), 106 crates |

1. A hosted CI runner that restores BuildKit's layer cache rebuilds an app whose Dockerfile copies
   its source before building, as both of these do, about as if from clean: the edit changes what
   the build step copies, so that step runs again, and its `target/` cache mount is not in the
   exported cache. A Dockerfile that builds the dependencies in a layer of their own first keeps
   them (not measured here). Only a builder kept between builds (a runner of one's own, a
   developer's machine) gets the incremental build with these Dockerfiles.
2. With the builder kept, card-market's build compiles Corten's own crates (`corten-run` and
   `corten-macros`, path dependencies in this repository) as well as the app: its Dockerfile
   touches every file it copies, since cargo goes by file times. An app with Corten from
   crates.io compiles its own crate alone, as axum + Maud's does, so Corten's 149 s is an upper
   bound, not a like-for-like row (Build's "After the edit", which edits in place, compiles
   card-market alone).
3. The cold build's time includes exporting the layer cache; every build resolves the
   Dockerfile's syntax image and base tags over the network, an imported build's new builder may
   pull the base images again, and a build whose cargo registry cache mount is empty (the cold
   one, and every imported one) downloads its crates, so the network is in those times too.
4. `docker-rebuild.json` has no commit: the script recorded none when this ran (it does now). It
   ran at `c65c10ec` with only this folder's scripts changed, as above.

## Method

1. Machine: a DigitalOcean CPU-optimized droplet (`c-8`: 8 dedicated vCPUs, Intel Xeon Platinum
   8168 at 2.7 GHz in r12 to r16, 16 GB), Ubuntu 24.04, kernel 6.8, Docker 29.9, Node 24, created for the run
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
   not all the same CPU (r1's, r4's, r5's, r8's, r12's, r13's, r14's, r15's and r16's were a Platinum 8168, r2's, r3's,
   r6's, r7's, r10's and r11's a Platinum 8280), so times are compared within a round, never across rounds.
2. Cores: the app under test pinned to core 1 with 1 GiB of memory, the item API to cores 2-3,
   the load generator (k6) to cores 4-7, the system and Docker on core 0. One app runs at a time.
   From r7, with items in memory, k6 also gets cores 2-3, which the item API does not use then.
   A matched-tier full-stack round runs on a `c-16`: the edge on cores 4-9 and k6 on 10-15 (with items in
   memory, 2-3 as well), the rest as above (The matched tier).
3. Cold start (`cold-start.mjs`): the container runs a shell that writes the time and execs the
   server; a probe in the same network namespace polls for the first 200 of an item page (items
   from the item API). Docker's own container setup is not in the number. 10 runs each.
4. Server rendering (`run-ssr.mjs`): a 30 s warmup with 32 users (long enough for the JVM's and
   .NET's JITs), then 60 s at a fixed rate (300/s from memory, 150/s from the API), 60 s with 64
   closed-loop users, and 60 s with 256. Items 1 to 500, skewed toward low ids. Responses
   uncompressed and untagged: the load sends `Accept-Encoding: identity` and no `If-None-Match`,
   as `curl` does, so the rounds compare rendering and not the apps' compression defaults, which
   differ (SvelteKit and Rails still tag every page, caveat 17). Corten tags and compresses a
   browser's page, which costs it more than the page itself
   ([what a browser's request costs](#what-a-browsers-request-costs-corten-callgrind-2026-11-06)).
   CPU and memory are sampled from `docker stats` each second; from r7 each
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
   - Mixed: with items from the item API, the item page's phases end with 60 s at the fixed rate
     (150/s) as a site gets it (`mixed-load.js`), so the features that matter only together are
     under load at once: 70% item pages, 2% of them for an item the item API answers in 40 s
     (`item_slow_<n>`: past the 35 s within which the matched profile's deadline must answer, and
     inside the 60 s after which k6 and the edge give up, so an app with no deadline is seen
     answering it), 20% the item as JSON, 5% the home page, and 5% the item page's price-alert form
     posted where and as the page posts it, hidden fields and cookies included (`formOf` and
     `formBody`, as `conform.mjs`'s own post), from the page read just before the phase. Pages and
     posts are sent as a browser's navigations and JSON as a script's request, all asking for
     compression (`Accept-Encoding: br, gzip`, where the other phases ask for none), so each kind
     of answer is compressed as the app compresses it for a browser. Every request comes from k6's
     one address, so a write limit per client (card-market's 20 a minute) is met and its 429s
     counted. One post is sent first as k6 sends them (through the edge in the matched tier), and its
     status kept (`<app>-mixed-form.json`): the
     table marks the posts' column `CHECK POST <status>` when it was not taken, so a post the
     harness built wrong is not read as the app's refusal. An app whose form its script sends
     (Livewire, LiveView) has no post; that share asks for item pages, and the table says why.
     When the 60 s are up, the requests still waiting are kept for their answers for 65 s, past
     k6's 60 s timeout, so every request sent is counted, answered or not; the rate and the app's CPU are
     over the 60 s, so an app is not shown slower for the wait (its CPU counted in the wait is
     charged to those 60 s, a little more for an app whose late answers come last). An app with no
     deadline holds each late item for its 40 s, about 84 at once (estimated, 150/s x 70% x 2%): one
     with fewer request slots (a few workers or threads) is filled by them for the whole phase, and
     every column then shows that, as a site with a slow upstream and no deadline would see it. The summary's Mixed table gives each
     kind of request its median and p99 latency and its answers by class (2xx and 3xx, 429, other
     4xx, 5xx, none), with the app's CPU and peak memory over the phase (`mixed.mjs`;
     `<app>-mixed.json`, and `-cpu`, `-stats` and `-form` beside it). It adds about 2 minutes
     an app a pass (estimated). It runs in both tiers; only in the matched tier is a deadline part
     of every app's profile, though not every app meets it (Next.js has no setting for one and
     holds a hung read past 45 s), and the deadlines differ (card-market's and axum-maud's are
     10 s), so the late items' latency is each app's own deadline, or the item API's 40 s delay
     where it has none, not a comparison of speed. The matched profile has
     no write limit, so only an app with one of its own answers 429, and k6 keeps no cache, so the
     phase does not see a `Cache-Control` policy at work (the feature matrix checks each app's).
     Late items come from `item-api/server.mjs`, the bench host's item API; the Rust item API a
     local round uses unless `BENCH_API_CONTAINER=item-api` has none, and answers them 404.
5. Instructions per request (`count.mjs`): `perf stat` counts the app container's user and
   kernel instructions while 4 users make 5,000 requests (items in memory) after a 30 s warmup;
   median of 3. On a bench host the counters are on the app's pinned cores only (`-C` with
   `BENCH_APP_CPUS`, not `-a`): the container runs nowhere else, so the count should be the same,
   with a counter on one core instead of one per core. Three rounds' droplets restarted as
   counting began, and the counters on the load generator's cores, switched at its every context
   switch, are a suspect
   ([#812 count.mjs restarts the bench droplet in some rounds (r8, r12, aot1), so those rounds have no instruction counts](https://github.com/corten-run/corten/issues/812));
   r16's counts are compared with r15's. An app that cannot be counted is
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
      together compare like for like, and that includes the downloads. FastAPI and Express have
      no build step, so their clean time is the dependency step alone and they have no rebuild.
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
      build compiles only the app, while the Rust and Go ones compile every dependency. The time
      from a save to the open page showing it, under `corten dev` and each stack's own development
      server, is not measured: it needs each app's development server running (Vite, `next dev`,
      Phoenix's live reload, `dotnet watch`, Django's and Rails' reloaders, `corten dev`), told
      apart from the build it starts, and a browser kept on its page to see the change, and the
      round has no harness that does (this step's source images have each app's toolchain and
      source, but start no server; `browser.mjs` times the production pages).
    - Editor and tests, for the Rust apps: `cargo check --all-targets` clean and again after the
      same edit, which is what rust-analyzer runs for its diagnostics when a file is saved (with
      the features Leptos's documentation has an editor set, `ssr`; Corten's checks card-market
      alone, standing in for an app of one crate), and the tests compiled without running them
      (`cargo test --no-run`) from the dependency step, then again after the edit; each says how
      many crates it compiled. Corten's card-market has tests; the other bench apps have none,
      so theirs is the app's crate compiled in test mode with nothing to run. The language
      server's own analysis is measured apart (rust-analyzer, below). These and the other kinds
      of edit below run after the rest of the app's results are saved, and a failure among them
      is recorded apart (`loopsFailed`), so it costs only them.
    - Other kinds of edit, for Corten (`edits` in its recipe): the development build after a
      change to a handler's body, a derive on a type the item page, its JSON and the agent tool
      share, a `messages!` entry in the English catalog, and a route added to `routes`, each
      from the clean development build.
    - Disk: what the dependency step, the production build and the development build each
      wrote, the size of the step's container layer (for the Rust apps, mostly `target/`). A CI
      cache of the dependencies and the build holds about the first two together. Each entry
      records Docker's storage driver (`storage`: overlay2 on the classic image store,
      overlayfs on containerd's).
    - Cores and linker, when the round sets `BENCH_BUILD_SCALE` (vCPU sets; a round sets
      `1-2,0-7` on a c-8, whose vCPUs are hyperthreads, so all eight may add sibling threads
      rather than cores; a matched round's c-16 gives all sixteen, so its build on all of them
      is not compared with a defaults round's): the clean production build again on each, for the apps in
      `BENCH_BUILD_SCALE_APPS` (Corten and axum + Maud, the anchor, unless it names others), and
      for those the development build clean and after the edit linked by mold rather than the
      toolchain's default (rust-lld since Rust 1.90). The linker each build used is read from the
      name it writes into the binary, and the mold build must be mold's. A failure here is kept
      apart from the other steps' results.
    - For Corten: cargo's per-crate timings of the clean build (Corten's alone runs with
      `--timings`, which records when each crate starts and ends), and rustc's passes
      (`-Ztime-passes`) and macro expansion statistics (`-Zmacro-stats`) for card-market's
      crate, flags rustc accepts on stable only with `RUSTC_BOOTSTRAP=1`, used for that report
      alone. Saved apart from the timings above, so a change to their format fails only them.

    - The app's own `docker build` with BuildKit's cache warm (`docker-rebuild.mjs`,
      `docker-rebuild.json`), for the apps in `BENCH_DOCKER_REBUILD_APPS` (Corten and axum +
      Maud unless it names others), after the rest of the app's results are saved: its
      Dockerfile, cache mounts and all, on a builder of its own (`docker buildx create --driver
      docker-container`) pinned to the build cores with the same memory cap, since BuildKit
      takes no core pinning. Cold (nothing cached, its base images pulled, so the network is in
      it), then three builds after the edit, each with the run's number in the button's title
      so none finds itself in the cache: on the builder that built it, with its layers and its
      cache mounts (cargo's `target/`), as a CI runner that keeps its builder or a developer's
      machine has them, and on a new builder given only the layer cache the cold build exported
      (`--cache-to`/`--cache-from type=local`), as a hosted runner restoring a cache has it:
      BuildKit exports no cache mount. Each build writes only to the cache (`--output
      type=cacheonly`), so no image export is in its time; its CPU-seconds are the builder
      container's cgroup counter, and for cargo it names the crates it compiled. A build after
      the edit that ran no step fails rather than reporting a cache hit. Only the two anchors run
      unless the variable names others, for time: on the desktop (below) they took 25.4 and 12.0
      minutes, a cold build and six after the edit, out of a step budget every app's build shares.
      What a restored cache does to the others is read from their Dockerfiles, not measured.
      Leptos's and Topcoat's copy their source before building, with cargo's `target/` and
      registry in cache mounts, as these two do, so a restored layer cache rebuilds them about as
      if from clean too. The rest copy their dependency list first and install it in a layer of
      its own (npm, pip, `dotnet restore`, `go mod download`, Maven, Mix, Bundler and Composer;
      Drogon's builds Drogon in one), so a restored layer cache keeps their dependencies and only
      the steps after the source's copy run again; Gin's keeps only its modules' downloads, since
      with no cache mount for Go's build cache `go build` compiles them again, on a kept builder
      too. Express's and FastAPI's have no `RUN` step after
      it, so this script, which fails a build after the edit that runs no `RUN` step, cannot time
      them.
    - rust-analyzer's own latency (`rust-analyzer.mjs`, `rust-analyzer.json`), for the Rust apps,
      with the language server driven over LSP from the host and its check on save off, so every
      number is its own analysis with the apps' proc macros expanded: ready (first quiescent,
      `experimental/serverStatus`) from a new container, which builds the build scripts and proc
      macros, then again from a new server with those kept; then, five times, the page's edit
      followed at once by a completion inside the item page's markup (`ra` in each recipe), timed
      to its answer, with whether it offers the field there; then the field's name made unknown and
      the time the server takes to answer the editor's request for the file's errors
      (`textDocument/diagnostic`; this server pushes only syntax errors and gives type errors when
      asked, and an unknown field is one of its experimental diagnostics, off by default, which an
      editor can turn on and this does unless `RA_EXPERIMENTAL=off`), with whether the error is in
      it, and the same once the text is back; and the server's peak memory. Corten's server loads
      the whole workspace (the crates and every example), more than an app of one crate gives it.

    Each step runs in a container of its own and reports its wall time, its CPU-seconds (the
    container's cgroup counter, the work done whatever the core count) and the peak of its
    processes' anonymous memory, sampled five times a second by bash builtins (the cgroup's own
    peak counts the page cache the build's output fills, which the kernel gives back under
    pressure). The sampler costs about 0.02 CPU-seconds a second (measured: 0.2 in a 10 s idle
    step). A step that fails says when the kernel killed its processes for passing the memory
    cap. `build.json` is synced and written after every step, so a stopped build keeps what it
    finished (`complete` is false until every measured step has run; Corten's diagnostics come
    after it). Each build call has a 90-minute limit and the step a 240-minute budget, counted
    afresh at each start as the unit's hours are (r16's step took 39.2 minutes, and its longest
    call, Leptos's, 12.1). The two added here were measured on a desktop that built about three
    times slower, roughly, so a round should take less: the Docker build took 25.4 minutes for
    Corten and 12.0 for axum + Maud, and rust-analyzer's ready and timed probes 0.5 to 3.7 minutes
    an app with the experimental diagnostics on, as a round runs it (its container's setup and the
    untimed requests not counted). A stopped or crashed build skips
    its app alone, a droplet restart in the step goes on with the next app, and past the budget the
    apps not built are named in `skipped.txt`.

### The matched tier

Every round above runs each app as its framework starts it (the defaults tier), so a Corten table
partly measures what Corten does that the others do not: the feature matrix shows most apps
without its security headers, host list, same-origin write check or deadline. The matched tier
runs apps that add a production profile, each with its framework's own documented middleware, so
its tables compare the same work. It has rounds of its own, named `m<n>` and run on their own
cadence: `droplet.mjs <m-round> --tier matched` (`BENCH_TIER=matched` on the droplet; an `m<n>`
round is the matched tier's without the flag, so `--collect` and `--attach` need none) runs its
apps, each started with `PROFILE=matched` and `MAX_CONNECTIONS`, in every step that starts one
(cold start included). `run-all.mjs`, `summarize.mjs` and `droplet.mjs` refuse a matched round
not named `m<n>`; every step that writes into a round (`cold-start.mjs`, `run-ssr.mjs`,
`count.mjs`, `conform.mjs`, `bytes.mjs`), run by hand as well, refuses the matched tier's
numbers in an `r<n>` round and the defaults' in an `m<n>` one; and `trend.mjs`, which reads
`r<n>` alone, refuses an `r<n>` whose `summary.json` says it is of the matched tier
(`summary.json` and `conformance.json` record the tier).

The profile:

1. Every counted column of the feature matrix: the security headers on the page and the JSON, a
   strict CSP, a private cache policy, an ETag and a 304, compression, problem+json or JSON
   errors, HEAD, an unknown Host refused, the form's cross-site post and 3 MiB field refused (a
   request body limit; Corten's forms take 2 MiB), a failed read and a hung item API answered
   with a 5xx within 35 s (a deadline; card-market's is 10 s), liveness and readiness.
2. A header timeout: a request head never finished has its connection closed within 35 s
   (Corten's `App::header_timeout` is 30 s). `conform-hold.mjs` sends a request line and one
   header, then nothing, so a timeout on silence alone also counts; a head sent a byte at a time
   is not probed here.
3. A connection cap of 1,000 (`MAX_CONNECTIONS`, which `apps.mjs` passes to each app):
   `conform-hold.mjs` holds 950 idle connections and sends a request on one more, which must be
   answered (a pool of workers each tied up by an idle connection, or a far lower cap, is not the
   profile's cap); then holds 1,050 and sends one more, which must not be answered while they are
   held (it waits, is closed, or never connects, and connections past 950 that never connect are
   a full accept queue, so a cap too); then, once they are closed, a request on a new
   connection must be answered, so a crash or a hang is not read as a cap. The app and the probe
   may hold 65,536 files there, so a file limit is not read as a cap.

The tier's load phases and browser pass reach each app through the edge (`edge.mjs`), as a
deployed app is reached: Corten's design has HTTP/2 and HTTP/3 to browsers come from a proxy or
CDN in front of `corten::serve` ([Limit 14](../../docs/design.md#limit-http1)), which usually ends
TLS too, and the defaults tier measures every app without one. The edge is one nginx (1.29.8,
pinned) with one config for every app, the one the deploy guide checks Corten with
([nginx](../../docs/guide/deploy.md#nginx)) less its cache and with the app's own name as Host: a
worker a core, each with its own listening socket (`reuseport`), TLS with a P-256
certificate made for the run, HTTP/2 to k6 and Chromium (HTTP/1.1 to a client that asks; no
HTTP/3, which is a CDN's), HTTP/1.1 to the app over up to 1,024 kept connections (re-used for 25
s, under Corten's header timeout), each connection on either side kept for the whole phase (nginx
closes one after 1,000 requests by default), and no compression, cache or access log of its own. The app
sees the Host k6 sends it directly, its container name. Chromium is started with
`--ignore-certificate-errors`, since with only a context's `ignoreHTTPSErrors` it refuses to
register a service worker from the edge, as it would not with a public certificate. Caddy 2.11.9
was tried first: at 1,000 requests a second to Corten locally it used 2.8 times nginx's CPU for
the page (670 requests per CPU-second against 1,875) and 3.2 times for the JSON (700 against
2,244; measured, Docker Desktop, one 20 s run each). What matters is the edge's CPU per CPU the
app uses: in full local runs (one each) nginx used 3.0 to 3.5, Caddy about 9. At nginx's ratio,
keeping the app's one core busy would take about 3.2 to 3.5 of the edge's cores (estimated, on
the assumption that the app, nginx and k6 all run faster on a droplet alike), so it has six
there; at Caddy's, neither four nor six would do.

The edge runs on cores of its own (`BENCH_EDGE_CPUS`; 4-9 on a droplet, so a matched full-stack round
needs 16 vCPUs, a c-16, and its script stops on a smaller host before it starts; off a bench host, four
CPUs' time, unpinned), and each phase counts its CPU beside the app's: the summary's
`edgePerCpuSecond`, `edgeCpuUsedPct` (of one CPU) and `edgeBound`, true when the edge used 90% or
more of the cores it had (`edge.json` in the round's load folders says how many), so the phase
measured the edge, not the app; `summarize.mjs` marks such a phase EDGE-BOUND. k6 reads its own CPU time as it ends
(`k6CpuUsedPct`), and `loadBound` (LOAD-BOUND) says it used 90% of its cores. Neither need be
true for something other than the app to set a saturation phase's rate (an unevenly loaded
worker, the network), so through the edge `appIdle` (APP-IDLE) says the app used less than 90%
of its own core: such a phase did not measure what the app can serve. Locally (Docker Desktop on
a shared 8-CPU machine, two runs) every saturation phase through the edge was APP-IDLE: Corten
used 46% to 61% of its core, while the edge used at most 205% of its four CPUs and k6 at most
248% of its four. What limited them was not determined, and directly Corten also stayed under
90% in three of four phases (82% to 92%), so a local run cannot test the edge; on a droplet it
used 96% to 100% directly (r16). A matched round's numbers stand only
where its saturation phases are not marked. Before m1 is read, Corten runs on its droplet directly
(`droplet.mjs --edge off`, whose summary says `edge: "off"`) and through the edge, to check its
core is as busy both ways; this has not been run yet. k6 keeps its
connections, so its handshakes are few; each cold browser load is a new context, so its handshake
is in the load. Cold start, the instruction counts, the feature matrix and the bytes reach the app
directly, since they measure the app. An app whose own server can terminate TLS (Kestrel, Bandit)
is not measured doing so: every app is measured behind the same edge. `BENCH_EDGE=off` runs the
tier's steps without the edge, to measure what it adds to the same app.

An app uses what its framework provides for each part and nothing hand-written; a part its
framework has nothing for is left out and shows as a column not met where a column reads it (no
column reads the headers on an error answer, so an app that sends its error answers without the
profile's headers shows that only in its item below and in the measured paragraph after the list), and no app is tuned beyond
the profile. "Provides" is a middleware, a setting or a builder option of the framework or of the
companion its documentation points to for it (tower-http for axum); a part that needs the app to
write its own handler, error mapper or server loop is left out, as the defaults tier leaves it;
code the framework's own documentation gives for a part, written as it gives it, counts as provided
(Next.js's Proxy for a nonce CSP). Topcoat's documentation gives such code for headers on its error
answers (a layer that queues them with `response_headers`), which its app does not use yet; no
counted column reads those headers, so its row is the same either way.
The tier's apps, by [#817 A bench/fullstack round takes 5.5 hours, the planned tiers and repeats would take it past 15, and nothing sets which apps, phases and cadence each tier gets](https://github.com/corten-run/corten/issues/817)'s
rule (Corten; axum-maud, the anchor every tier shares; the three best on the tier's own measure
and the four most used in the Stack Overflow survey, on r13 and the 2026 survey ASP.NET Core,
Topcoat and Leptos, and Next.js, ASP.NET Core, FastAPI and Express; ASP.NET Core as its Razor Pages
app in the page phases and its native AOT app in the JSON ones), are eight. Spring Boot and Django,
fifth and seventh in that survey, left the four when FastAPI and Express joined the bench
([#818 bench/fullstack has no FastAPI or Express app, though they are the third and fourth most used server frameworks in the 2026 Stack Overflow survey, so a most-popular comparison leaves out two of its top four](https://github.com/corten-run/corten/issues/818)); they stay in the defaults tier. An app takes part
(`matched: true` in `apps.mjs`) once it starts with its profile:

1. `corten`: card-market's defaults are the profile's first two parts; `MAX_CONNECTIONS` sets
   `App::max_connections`, which is unbounded unless set.
2. `axum-maud`: tower-http's layers add the security headers, `Cache-Control: private, no-cache`
   on the pages and the JSON (not `/static`), compression, a 503 past 10 s (`TimeoutLayer`) and a
   2 MiB body limit (`RequestBodyLimitLayer`). axum and tower-http have no host list, same-origin
   check, ETag for a rendered answer, liveness or readiness endpoint, or connection cap; its error
   answers (a failed read as a 502 `text/plain`, a missing item as an empty 404, axum's empty 405)
   are the app's own code, which the profile does not change, as no framework's error pages are
   rewritten by hand; and `axum::serve` has no header timeout or head size setting (hyper's are
   reached by writing the accept loop on hyper-util). Those columns stay unmet.
3. `leptos`: Leptos serves through axum, so it takes axum-maud's tower-http layers beside the
   compression it already had: the security headers, a 503 past 10 s, a 2 MiB body limit, and
   `Cache-Control: private, no-cache` on its routes. What its fallback serves, the static files
   and an unknown path's 404 page, goes without it, since tower-http cannot tell the two apart. A
   page's CSP lets its scripts run by the nonce Leptos makes for each response and writes on the
   hydration scripts (its `nonce` feature, which leptos_axum turns on), set by the shell through
   Leptos's `ResponseOptions`; the page hydrates under it (checked in Chromium: the sort button
   works, no CSP violation, every inline script has the nonce). Its `script-src` also lists
   `'wasm-unsafe-eval'`, which lets the page compile its WebAssembly and runs no text as script, so
   the matrix counts the policy strict, where Topcoat's `'unsafe-eval'` (item 4) does run text as
   script. It misses what axum-maud misses,
   but its page for a failed read is its own 200 with the error in it, the app's code as before.
4. `topcoat`: Topcoat runs tower middleware as one of its own layers (`TowerLayer`, its `tower`
   feature; tower-http is what Topcoat itself compresses with), so it takes axum-maud's tower-http
   header layers and timeout around every request: the security headers, `Cache-Control: private,
   no-cache` on an answer that sets none (its assets keep Topcoat's `public, max-age=31536000,
   immutable`) and a 503 past 10 s. An answer Topcoat makes from an `Error` goes without them, since
   `TowerLayer` passes the error through and the router makes the answer after every layer (a
   cross-site post is refused before any layer runs): in its matrix the JSON 404, the 405, both
   failed reads, the cross-site 403 and the 413 have no security headers or `Cache-Control` (the
   counted columns read headers on the 200 answers only), where axum-maud's answers to the same four
   (the JSON 404, the 405 and both failed reads) have them (axum-maud takes the cross-site post, and
   its 3 MiB post ends in EPIPE, so it has no 403 or 413 to compare); Topcoat's own way to put a
   header on those is `response_headers` in a hand-written layer, which the tier leaves out. Its
   defaults already refuse a body over 2 MiB (413), refuse a cross-site form post (403, its origin
   policy), compress, and close a request head left unfinished at 30 s. Its runtime compiles the
   expressions it reads from the page's markup with `new Function`, so the page CSP needs
   `'unsafe-eval'`, and the header layer sets that one CSP on every answer it sets headers on
   (Leptos keeps answers that are not pages on axum-maud's strict policy; the `pageScripts` column
   reads the page's only): without it Chromium blocks the runtime and the listings' sort does
   nothing (checked in Chromium, the CSP rewritten in the browser); with it the sort works and no
   CSP violation is reported. Topcoat has no host list, ETag for a rendered answer, liveness or
   readiness endpoint, connection cap or head size setting (hyper 1.12's default read buffer,
   417,792 bytes (about 408 KiB), bounds a request head; the probe's 64 KiB header fits under it),
   and its error answers (a failed read as a 500 `text/plain`, a missing item as a 404 `text/plain`,
   an empty 405) are the app's and Topcoat's own, which the profile does not change. Since the
   runtime's rendered answers set no `Cache-Control`, they get the profile's `private, no-cache`,
   which Topcoat's prefetch reads as usable for 0 ms: under the profile a prefetched link is
   rendered again when it is followed after the prefetch's headers arrived (the browser phases click
   without hovering, so they do not prefetch).
5. `nextjs`: Next.js fixes its config when it builds, so the tier runs an image of its own,
   `cb-nextjs-matched`, built with `--build-arg PROFILE=matched` (`buildArgs` in `apps.mjs`, which
   `droplet.mjs` builds from, and the build step's recipe in a matched round, `builds.mjs`); the
   defaults tier's `cb-nextjs` is built from the same config as before. That build adds axum-maud's
   security headers to every answer, and its CSP and `Cache-Control: private, no-cache` to the
   JSON, from `next.config.mjs`'s `headers()`, and the pages' CSP from a Proxy (`proxy.matched.ts`,
   Next.js's file for code that runs before a route, which only that build takes, through
   `pageExtensions`), the code Next.js's Content Security Policy guide gives: a nonce for each
   response, which Next.js writes on the scripts of a page it renders for the request, so the item
   page hydrates under a strict policy (checked in Chromium through the edge: all 11 scripts have
   the nonce, no violation, and the sort, "show all" and the alert work). The App Router's pages
   were already rendered for each request, as a nonce needs; the Proxy leaves out the JSON, the
   static files, bench/live's stream and the Pages Router's marketplace pages, which are not in the
   tier and would need `_document` to write the nonce. The 404 page Next.js prerenders
   (`/_not-found`, for an unknown path) gets the policy but not the nonce, which needs a page
   rendered for the request, so its 10 scripts are blocked (measured); its text and links work
   without them, and the tier measures no script there. Next.js refuses a server action whose
   Origin is not the request's host, and the edge sends the app its container name as Host, so the
   build lists the edge's host in `serverActions.allowedOrigins` (the Dockerfile's `EDGE_HOST`,
   which `edge.test.mjs` checks against the edge's port and the built config), as a deploy names
   its own domain; that refusal and the 1 MB body limit on a server action were already defaults (a
   500, counted as refused). Next.js's own compression (`compress`, on by default) gzips the pages
   but not the route handler's JSON, and its ETag (`generateEtags`) is on no page rendered for the
   request; it has no setting for a JSON 405 or 500 (a route handler's are empty), a host list,
   liveness or readiness, a deadline, or the Node server's header timeout (Node's `headersTimeout`
   is 60 s, and the standalone server sets only `keepAliveTimeout`) or connection cap
   (`server.maxConnections`, which it does not set), so those columns stay unmet.
6. `aspnet` (and `aspnet-aot`), `fastapi` and `express` are not in it yet: each joins with its
   profile.

`BENCH_TIER=matched node conform.mjs [apps] [name]` writes the tier's matrix on its own. Measured
locally (Docker Desktop on Windows, one probe each), from `cb-corten` and `cb-axum-maud` built
from the tree `conform.mjs` ran from, `720c8a88` with no local changes (its `commit` and `dirty`
in `results/conform-matched1/conformance.json`; `imagesFrom` is set only by a droplet round):
of the 24 counted columns Corten met all, its unfinished head closed in 29.3 s, a request was
answered with 950 connections held, and one past 1,050 waited until they closed (then a 200);
axum-maud met 12 and missed 12:
the ETag, the cross-site post, the two failed reads (502 `text/plain`), the 404 and 405 formats
(empty), the unknown Host and the 64 KiB header (200), liveness and readiness, the unfinished head
(still held at 45 s) and the cap (answered with 1,050 held). Leptos, probed the same way from
`cb-leptos` built at `07ee94b6` (`results/conform-matched-leptos1/conformance.json`), met the
same 12 and missed the same 12, with two of those answered differently: its failed read's page
(200 `text/html`) and the cross-site post to its server function (302 with no `serverfnerror`).
Topcoat, probed the same way from `cb-topcoat` built at `9a17b8ea`
(`results/conform-matched-topcoat1/conformance.json`), met 13 and missed 11: it meets the
cross-site post (403) and the unfinished head (closed in 30.0 s) that axum-maud misses, and misses
the page's script CSP (`'unsafe-eval'`) that axum-maud meets. Of the misses it shares with
axum-maud, three are answered differently: its failed reads are a 500 `text/plain` (axum-maud's a
502) and its JSON 404 is `text/plain` (axum-maud's is empty). Not counted: its six error answers
(the JSON 404, the 405, both failed reads, the 403 and the 413) go without the profile's headers,
where axum-maud's answers to the same four carry them.
Next.js, from `cb-nextjs-matched` built at `eedbcc2a`
(`results/conform-matched-nextjs1/conformance.json`), met 14 and missed 10: the ETag, the JSON's
compression (none), 405 and failed read (empty), the unknown Host (200), liveness and readiness,
the item API's deadline and the unfinished head (each held 45 s), and the cap (served with 1,050
held).
No load phase has run in the tier yet.

### The hardening step

`harden.mjs` measures how each app holds up against abuse, not how many requests it serves. Each
phase runs against a freshly started app (as `runArgs` starts it, reading items from the item
API, at its tier's settings), sent by `harden-probe.mjs` from a container on the bench network,
not through Docker Desktop's published port, whose proxy would read the answers itself so that no
server saw a slow reader. Beside the abuse, a well-behaved client asks for the item as JSON on a
new connection every 100 ms. card-market lets one client 20 writes a minute (`WRITES_PER_MINUTE`),
and every probe connection comes from one address, so the step raises it to 1,000: each slow body
then reaches the server's handling of a body, as in every other app, not the app's limiter. The
phases:

1. `headFlood`: 2,000 connections each send a request head without its blank line, then nothing,
   held 45 s (past Corten's 30 s header timeout).
2. `slowHead`: 200 connections each send a 4 KiB head a byte a second, held 60 s.
3. `slowBody`: 100 posts to the form declare a 1 MiB body and send it a byte a second, held 90 s.
4. `slowReader`: 200 connections each pipeline 1,000 page requests and never read, held 90 s
   (more than the sockets' buffers between two containers hold, so the server's writes block; an
   empty line a second shows when the server has closed one).
5. `idleFlood`: 5,000 connections opened and sent nothing, held 60 s.
6. `oversized`: 200 headers, a 1 MiB header, and a 16 MiB body to the form, each on its own
   connection; each one's status, or `closed` when the connection closed with none.

For each phase it records how long after its own connect the server closed each abusive
connection, and what it answered each one first (a status, or nothing); the well-behaved client's
requests, each timed from before its connect (answered 200 within 5 s of that, or failed), and
their p50 and p99; the app's peak memory (`docker stats`, sampled about once a second) and its
CPU (its cgroup's counter, given as cores: CPU seconds a second of the phase); whether the
container still runs or was killed for memory, with its exit code and last log lines when it
stopped; for each oversized request, whether the server reset the connection; for the clients that
stop reading, what each connection still open held unread (the kernel's `rx_queue` in
`/proc/net/tcp`) halfway through the hold and at its end, so that a server whose writes were
blocked (the same bytes at both) is told from one still sending or one that sent nothing; and the status of one
request on a new connection once the abuse has closed. An app is up after a phase when it runs,
was not killed for memory, and answered that request 200; degraded when it is up but more than
1% of the well-behaved client's requests (and more than one) failed. Each phase starts the app
cold, so a JIT's warm-up is in its first seconds' latencies. The probe runs under `timeout` inside
its container, so a phase cut off at its limit leaves no connections for the next one. `results/<round>/hardening.json` keeps each phase's record and its cell;
`node harden.mjs [apps|all] [round] [phases]` runs some phases again and keeps the rest, and exits
1 when a phase could not run or nothing was written, which `droplet.mjs` reads as a round that
stopped short. The step
has its own cadence, not every round's (`droplet.mjs <round> --suite harden`, about eight minutes
an app, estimated from local runs), and in the matched tier (`BENCH_TIER=matched`) runs its apps
with the production profile. It reaches each app directly, with no edge, on the defaults tier's
c-8 and cores, so it measures the bare app: a deployment's proxy in front of it may absorb some of
these clients first.

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

In the legacy workflow, the detector runs with each full round the automation collects (outside this repository),
and the round's report reads `trend.json`: a `DRIFT:` line becomes an issue, or a comment on an
open one for the same number, and a `WARN:` line, or a trend that could not be made, goes to the
maintainer instead. r16's report, the first to read it, found no drift and no warning
([#867 Small performance regressions can compound without a trend detector](https://github.com/corten-run/corten/issues/867)).

## Caveats

1. One run per phase on one droplet, unless a round says it ran passes (`--passes`, Method 4):
   in a one-pass round differences under about 10% are noise. A round of passes gives each
   number's range, and a difference whose ranges overlap is within noise. r16, the first round of
   three passes, measured that noise: across the 72 app and test pairs with a range, the 64-user
   requests a second varied between passes by a median 5.3% (range over median), 13 pairs by
   more than 10% and the widest by 37.6% (Leptos's JSON from memory, with no failed or unsent
   requests); in the fixed-rate phase requests per CPU-second varied by a median 3.0% (the widest
   18.9%). So about 10% covers a typical app's one-pass number, some apps vary by more than that
   between passes of the same build and need passes to judge, and the fixed-rate phase is the
   steadier one. Across rounds,
   `trend.mjs` reports a sustained drift (Drift across rounds).
2. The data is synthetic (generated catalog items), sized like a production marketplace's item
   pages. The item API is a stand-in that serves the same responses as the production API (a
   Rust service with Postgres and Redis, not in this repository).
3. JavaScript dependencies are pinned in each `package.json` without lockfiles, and the Python
   apps' (Django, FastAPI) in `requirements.txt`, which pins only the packages it names, so
   transitive versions can drift between builds; the other apps have lockfiles.
4. The page is small. Apps with large client-side state (a seller grid of live rows) are a
   different test; see [bench/live](../live/README.md) for pushing updates.
5. Each framework runs its production defaults with the worker count its docs give for one CPU, in
   one CPU and 1 GiB. Nothing is tuned to get an app through a test: one that cannot start or cannot
   serve the fixed rate (more than 5% of it never sent, or more than 1% errors) is marked failed.
   Each could be tuned further (caching, streaming, more workers). None of the apps cache rendered
   pages. Gin runs `gin.Default()`, so it logs every request, as Rails and Phoenix do at their
   default level and FastAPI does (`fastapi run` keeps uvicorn's access log). Drogon runs one IO
   thread per core, as its docs advise, and counts its cores from its CPU affinity capped by the
   container's CPU quota, since its own count (`0`) sees every core of the host. FastAPI runs
   `fastapi run`, one uvicorn process: its container guide gives one process a container where the
   container is given its CPUs, and the live stream needs every client in one process. Express runs
   one Node process with `NODE_ENV=production`, as its production guide says, which caches compiled
   views; FastAPI's templates are Starlette's `Jinja2Templates` as created, which checks each
   template file's time on every render (Jinja's default, which FastAPI's docs do not change). Three
   settings differ from a library's default so that the item API source does the same work in every
   app: Gin keeps as many idle connections to the item API as its transport allows (Go's default
   keeps two per host; reqwest, .NET and Node have no per-host cap), FastAPI's httpx clients have no
   connection cap (httpx's default keeps 20 idle and allows 100 in all), and Drogon keeps one
   `HttpClient` (one connection) per request in flight on each thread. Drogon also hands the fixture
   parser's freed memory back to the system after loading (`malloc_trim`), so its memory with items
   in memory is the items' rather than the parser's peak, which the Rust apps avoid by parsing one
   item at a time. Drogon's JSON is JsonCpp's, Drogon's default, which writes 17 significant digits
   (`0.79000000000000004`), so its item JSON is about 3% longer than the others' for the same
   values.
6. The images include the live benchmark's routes (`/live/...`), which the item page does not
   touch.
7. Laravel ran with PHP's default `memory_limit` throughout r3 to r16. (r2's main run had raised it
   to 512 MB and measured Laravel again with the default afterwards; `laravel-rerun.log` in r2's raw
   output ([results/r2/raw.txt](results/r2/raw.txt)).) Through r16 its in-memory tests failed under
   that limit: every worker decoded the whole 27.7 MB fixture at boot and ran out of memory before it
   answered. From
   [#981 bench: Laravel cannot start with items in memory, so check-app.mjs laravel fails: decoding the 27.7 MB fixture passes PHP's 128 MB memory_limit](https://github.com/corten-run/corten/issues/981)
   it reads the fixture one item at a time, as the Rust apps do, keeping only each item's view, and
   starts with the same default. It checks the whole file with `json_validate` first, so with a
   damaged fixture the server logs why and exits at startup instead of serving part of the items
   (`tests/items.php`, run in the image with `php tests/items.php`). Measured locally with one CPU on a loaded machine: the old
   image never answered in 60 s; the new one answered its first item page 5.5 to 7.1 s after
   `docker run` in four runs, at 132 to 144 MiB for the container, and `check-app.mjs laravel`
   passes. So a round from then on has Laravel's in-memory numbers, which no earlier round has.
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
   In r16 Django and Nuxt passed the in-memory page test in all three passes.
9. r16 measured the tree at `eea6adb` (`results/r16/commit.txt`).
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
    (the tree at `512dc73`), the last round before it that counted, r15's with r14's, and r16's with r15's.
12. Through r11 the other apps rendered Corten's visible text with markup and stylesheets of their
    own (the stylesheets last changed on 2026-10-22, the markup on 2026-10-31 only for the plural
    counts), while Corten's item page changed in nine commits after that
    ([#642 The benchmark's other apps render Corten's item page text but not its markup or styles, which changed in nine commits since Oct 22](https://github.com/corten-run/corten/issues/642)).
    From r12 they render Corten's markup with its stylesheets, so their page bytes, browser times
    and server numbers are not like for like with r11's. r12 is the first round with Corten's markup
    and stylesheets in every app, and r13 the first with all eighteen; in each, and in r15 and r16 (the
    round these tables come from), parity passed on 17 pages and `look.mjs` on 4 pages in 4 views,
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
16. The item page's work differs in one way: card-market writes each price and rating from its
    number in the reader's locale on every request (`t.money`, `t.number`), where the other apps
    write the strings the item API sent (`"$" + amount`). On item_1, with five offers shown, that is
    31 prices and 25 ratings, and rendering its `<main>` took 57,257 user instructions against
    43,593 with the API's strings (callgrind, at `eb8589c8`;
    [#942 Benchmark: the item page's apps return the same visible page but do different work (Corten formats prices per request and renders every offer)](https://github.com/corten-run/corten/issues/942)),
    left as it is
    ([#973 Benchmark: card-market formats prices and ratings per request in the reader's locale, the other item-page apps write the API's strings](https://github.com/corten-run/corten/issues/973),
    closed): it is work Corten does and the others do not, so it understates Corten's rows rather
    than flattering them.
    Through r15 card-market also rendered every offer, the ones past the fifth in a `<template>`
    that "Show all" moved into the table (25 rows for item_1, where the others sent 5); from
    r16 it sends five, as the others do.

17. The rounds' page requests send `Accept-Encoding: identity` and no `If-None-Match`, so no app
    compresses its page and Corten does not hash an `ETag` for it ([design Limit 21](../../docs/design.md#limit-etag)), but SvelteKit
    and Rails tag every page anyway (round conform2, on a request that named no encoding), a hash
    Corten skips: it favors Corten's rows
    by whatever that hash costs them, not enough to change their places (773 and 417 pages a
    second against Corten's 15,103 in r15). A
    browser's request costs Corten its tag and its compression as well
    ([what a browser's request costs](#what-a-browsers-request-costs-corten-callgrind-2026-11-06),
    [#961 Benchmark: the page load sends Accept-Encoding: identity with no tag, the one request that skips the ETag hash, so the headline page numbers leave out costs every browser request pays](https://github.com/corten-run/corten/issues/961)).

## Running it

The commands below are for the legacy workload and diagnostics, not the current nightly.
Official r17 and later nightly rounds use [marketplace v2](../marketplace/nightly.md);
use a distinct diagnostic identity here to avoid mixing the baselines.

```sh
# On a fresh droplet, created and destroyed for the run (needs doctl and an SSH key there):
node bench/fullstack/droplet.mjs legacy1 --ssh-key <id> [--region sfo2]   # waits for the round
node bench/fullstack/droplet.mjs legacy1 --ssh-key <id> --detach          # or start it and leave,
node bench/fullstack/droplet.mjs legacy1 --collect                        # then collect it later
# A few apps against each other, without the other apps' hours (r14's eighteen took 6.3):
node bench/fullstack/droplet.mjs aot2 --ssh-key <id> --apps corten,aspnet,aspnet-aot --detach
# Each load phase three times, the apps taking turns, for medians and ranges:
node bench/fullstack/droplet.mjs p1 --ssh-key <id> --apps corten,axum-maud --passes 3 --detach
# The hardening step alone (slow clients, oversized requests, floods), every app or --apps:
node bench/fullstack/droplet.mjs h1 --ssh-key <id> --suite harden --detach
# A round of the matched tier (named m<n>; its apps with the production profile), and its collect:
# A c-16, as the edge has six cores; a hardening round of the tier (--suite harden) has no edge and
# runs on a c-8.
node bench/fullstack/droplet.mjs m1 --ssh-key <id> --tier matched --detach
node bench/fullstack/droplet.mjs m1 --collect
# Or by hand, from the repository root: the images, the fixture, then everything.
docker build -f examples/card-market/Dockerfile -t cb-corten .
for app in nextjs tanstack-start sveltekit react-router leptos topcoat axum-maud gin drogon django rails laravel aspnet aspnet-aot spring phoenix astro nuxt; do
  docker build -t cb-$app bench/fullstack/apps/$app
done
# The matched tier builds Next.js again, as `buildArgs` in apps.mjs says:
docker build --build-arg PROFILE=matched -t cb-nextjs-matched bench/fullstack/apps/nextjs
node bench/fullstack/fixtures/fetch.mjs http://localhost:18400   # or any {"item_1": {...}} file
cd bench/fullstack && node run-all.mjs legacy1 10   # BENCH_APPS=corten,aspnet-aot for only those
node conform.mjs [apps] [round]   # the feature matrix above (on the bench network; removes its containers when done)
node check-app.mjs <app>    # before adding an app: parity, look, JSON and 404s against corten
                            # (replaces fsw-corten and fsw-<app>, removed after unless keep; needs cb-corten from this tree)
node sync-styles.mjs        # after Corten's styles change (cb-corten rebuilt and running): copy them to every app
node look.mjs [apps]        # every app's pages in Chromium against Corten's, box by box
node build.mjs legacy1 [apps] [runs=3]   # build cost: clean, after a one-line change, and dev builds
node docker-rebuild.mjs legacy1 [apps] [runs=3]   # the app's own docker build after the edit, BuildKit's cache warm
node rust-analyzer.mjs legacy1 [apps] [runs=5]    # rust-analyzer's own latency (the Rust apps)
# One request's instructions by stage and crate (callgrind), from the repository root, items in memory:
docker run --rm -v "$PWD:/src" -v "$PWD/bench/fullstack/fixtures:/fixtures:ro" -v /tmp/cg:/out -w /src \
  -e CARGO_TARGET_DIR=/target rust:1-bookworm bash bench/fullstack/cost-by-crate.sh
node bench/fullstack/cost-by-crate.mjs /tmp/cg/cg-card-market-page-fixture-300.out /tmp/cg/cg-card-market-page-fixture-1300.out
# The axum + Maud app the same way: add -e APP=axum-maud (dumps cg-axum-maud-*.out). Writing each
# page with what it calls: INCLUSIVE='render_into|^item_page_axum_maud::pages::item$' before node
# The item fetched from the item API (running on the host at 18400, with port 8080 free, as
# --network host serves the app there): add --network host and
# -e SOURCE=api -e API_BASE=http://127.0.0.1:18400 -e TARGETS=page, then split cg-card-market-page-api-*.out
# What each production default costs: card-market built as it is and with each ablate/ patch, then
# measured; builds go to /tmp/defaults/bins and are reused, so a stopped run measures at once:
docker run --rm -v "$PWD:/src:ro" -v "$PWD/bench/fullstack/fixtures:/fixtures:ro" -v /tmp/defaults:/out \
  -e CARGO_TARGET_DIR=/target rust:1-bookworm bash /src/bench/fullstack/cost-by-default.sh
node bench/fullstack/cost-by-default.mjs /tmp/defaults/results.tsv   # five repeats unless -e REPEATS=n
# One app before and after, alternating (identity, a browser's encodings, brotli alone; AB_ROUNDS=3,
# AB_ENCODINGS=br for some), and the memory floods of unfinished heads leave, by allocator setting
# (docs/design.md#choice-jemalloc-image; FLOOD_VARIANTS=jemalloc,glibc for some); the committed
# fault folders ran REQUESTS=2000, results/alloc-faults-br with ENCODINGS=br too:
node bench/fullstack/ab.mjs results/ab-x cb-corten cb-corten-next
node bench/fullstack/flood-memory.mjs results/flood-x cb-corten [runs=3] [floods=8]
node bench/fullstack/alloc-faults.mjs results/faults-x cb-corten cb-corten-next   # page faults and CPU a request
```

## What the repository keeps

1. A round keeps its summaries and its log as files: `summary.json`, which the tables above come
   from, and `run.log`, `commit.txt`, `host.txt`, `skipped.txt`, `build.json`,
   `docker-rebuild.json`, `rust-analyzer.json`, `bytes.json`, `cold-start.json`,
   `instructions.json`, `browser.json`, `conformance.json`, `hardening.json`, `trend.json` and, in
   a round committed before this, `raw.txt` (below). Its raw output
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
