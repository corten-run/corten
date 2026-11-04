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
tables below are from r13, the first round with all eighteen apps, each rendering Corten's markup
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

The same apps hold the live-updates comparison in [bench/live](../live/README.md).

## Results

All numbers are measured, from one run (`results/r13/`, 2026-11-03 to 2026-11-04 UTC, the tree at
`7f0b81f`) on one DigitalOcean c-8 droplet (Intel Xeon Platinum 8168); see [Method](#method). Failed
means the app could not do the test with its usual settings in one CPU and 1 GiB (see caveat 5);
its other numbers are kept where it produced any. r9 measured nothing (its launcher hung in its
own `ssh` call before the round started). r12 (`results/r12/`, the same CPU model, Corten at
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
| axum-maud | 7.0 ms (6.4 ms-9.4 ms) | 1.344 MiB | 118 MB |
| topcoat | 8.0 ms (6.9 ms-10 ms) | 1.496 MiB | 124 MB |
| **corten** | 8.4 ms (6.7 ms-51 ms) | 1.234 MiB | 124 MB |
| leptos | 9.2 ms (7.8 ms-39 ms) | 1.496 MiB | 128 MB |
| gin | 12 ms (9.0 ms-15 ms) | 1.949 MiB | 135 MB |
| drogon | 32 ms (28 ms-43 ms) | 3.262 MiB | 122 MB |
| sveltekit | 214 ms (199 ms-287 ms) | 25.73 MiB | 333 MB |
| tanstack-start | 243 ms (232 ms-320 ms) | 27.6 MiB | 332 MB |
| react-router | 330 ms (322 ms-466 ms) | 33.03 MiB | 353 MB |
| astro | 337 ms (324 ms-347 ms) | 36.16 MiB | 527 MB |
| nuxt | 341 ms (332 ms-410 ms) | 37.3 MiB | 335 MB |
| aspnet | 746 ms (720 ms-1.0 s) | 30.93 MiB | 342 MB |
| nextjs | 747 ms (718 ms-926 ms) | 52.67 MiB | 385 MB |
| laravel | 929 ms (893 ms-956 ms) | 96.42 MiB | 948 MB |
| django | 1.2 s (1.1 s-1.5 s) | 65.52 MiB | 276 MB |
| rails | 1.2 s (1.2 s-1.4 s) | 63.84 MiB | 431 MB |
| phoenix | 1.5 s (1.4 s-1.9 s) | 125 MiB | 262 MB |
| spring | 8.1 s (7.9 s-8.2 s) | 135.4 MiB | 516 MB |

### Item page, items in memory (no database)

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| axum-maud | 300/s, 0.2 ms / 0.4 ms, 4% | 24,209, 2.6 ms / 7.9 ms | 21,915, 32 ms, 0% | 16-19 MiB |
| **corten** | 300/s, 0.3 ms / 0.4 ms, 5% | 18,157, 2.7 ms / 8.4 ms | 15,976, 33 ms, 0% | 16-19 MiB |
| drogon | 300/s, 0.3 ms / 0.4 ms, 4% | 17,956, 3.9 ms / 9.2 ms | 14,340, 35 ms, 0% | 12-15 MiB |
| topcoat | 300/s, 0.4 ms / 0.5 ms, 9% | 5,574, 8.7 ms / 17 ms | 5,135, 68 ms, 0% | 15-18 MiB |
| gin | 300/s, 0.4 ms / 0.5 ms, 9% | 4,527, 14 ms / 32 ms | 4,375, 91 ms, 0% | 20-29 MiB |
| aspnet | 300/s, 0.6 ms / 2.6 ms, 26% | 4,112, 16 ms / 25 ms | 3,906, 107 ms, 0% | 88-91 MiB |
| leptos | 300/s, 1.0 ms / 1.2 ms, 25% | 1,339, 49 ms / 72 ms | 1,146, 376 ms, 0% | 16-32 MiB |
| phoenix | 300/s, 1.1 ms / 1.4 ms, 38% | 1,321, 48 ms / 68 ms | 1,318, 3.9 s, 0% | 286-303 MiB |
| astro | 300/s, 0.9 ms / 31 ms, 31% | 1,183, 49 ms / 121 ms | 1,161, 303 ms, 0% | 128-129 MiB |
| spring | 300/s, 1.1 ms / 8.7 ms, 53% | 1,084, 41 ms / 368 ms | 1,061, 1.7 s, 0% | 358-378 MiB |
| sveltekit | 300/s, 1.1 ms / 23 ms, 42% | 767, 84 ms / 153 ms | 715, 475 ms, 0% | 149-154 MiB |
| tanstack-start | 300/s, 1.5 ms / 37 ms, 53% | 640, 97 ms / 166 ms | 669, 488 ms, 0% | 161-162 MiB |
| react-router | 300/s, 1.9 ms / 48 ms, 65% | 510, 122 ms / 199 ms | 509, 632 ms, 0% | 145-149 MiB |
| rails | 300/s, 2.5 ms / 82 ms, 78% | 429, 145 ms / 201 ms | 381, 870 ms, 0% | 136-138 MiB |
| nuxt | 287/s, 749 ms / 31.7 s, 100% | 316, 201 ms / 244 ms | 297, 4.8 s, 0% | 140-142 MiB |
| django | **failed**: 264/s served, 2.8 s / 4.9 s, 99% | 301, 204 ms / 277 ms | 298, 1.1 s, 0% | 346-346 MiB |
| nextjs | **failed**: 153/s served, 1.3 s / 57.2 s, 91% | 180, 370 ms / 442 ms | 181, 13.3 s, 0% | 212-215 MiB |
| laravel | **failed**: never answered /items/item_1 within a minute | - | - | - |

### The item as JSON, items in memory

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 300/s, 0.3 ms / 0.4 ms, 4% | 22,172, 2.9 ms / 8.2 ms | 20,784, 32 ms, 0% | 16-18 MiB |
| topcoat | 300/s, 0.3 ms / 0.4 ms, 4% | 17,677, 3.3 ms / 8.0 ms | 14,705, 32 ms, 0% | 15-18 MiB |
| axum-maud | 300/s, 0.3 ms / 0.4 ms, 4% | 17,534, 2.5 ms / 8.1 ms | 13,572, 33 ms, 0% | 15-19 MiB |
| aspnet | 300/s, 0.4 ms / 0.5 ms, 15% | 12,658, 4.6 ms / 10 ms | 12,844, 36 ms, 0% | 51-62 MiB |
| leptos | 300/s, 0.3 ms / 0.4 ms, 5% | 12,494, 5.8 ms / 8.2 ms | 13,985, 33 ms, 0% | 15-18 MiB |
| nuxt | 300/s, 0.4 ms / 0.7 ms, 10% | 7,058, 7.9 ms / 31 ms | 6,512, 80 ms, 0% | 98-100 MiB |
| spring | 300/s, 0.3 ms / 1.6 ms, 25% | 6,108, 6.7 ms / 93 ms | 6,432, 315 ms, 0% | 351-377 MiB |
| gin | 300/s, 0.4 ms / 0.9 ms, 10% | 4,082, 15 ms / 33 ms | 3,794, 110 ms, 0% | 25-34 MiB |
| tanstack-start | 300/s, 0.5 ms / 4.2 ms, 13% | 3,399, 17 ms / 51 ms | 3,083, 128 ms, 0% | 140-142 MiB |
| sveltekit | 300/s, 0.5 ms / 4.1 ms, 13% | 3,031, 20 ms / 54 ms | 3,017, 145 ms, 0% | 124-126 MiB |
| drogon | 300/s, 0.6 ms / 1.1 ms, 18% | 2,412, 17 ms / 51 ms | 2,309, 210 ms, 0% | 12-14 MiB |
| react-router | 300/s, 0.7 ms / 7.8 ms, 19% | 2,243, 25 ms / 76 ms | 2,199, 190 ms, 0% | 119-120 MiB |
| phoenix | 300/s, 0.7 ms / 1.0 ms, 27% | 1,924, 33 ms / 50 ms | 1,904, 4.4 s, 0% | 298-323 MiB |
| astro | 300/s, 0.7 ms / 24 ms, 22% | 1,860, 31 ms / 83 ms | 1,844, 200 ms, 0% | 139-141 MiB |
| nextjs | 300/s, 0.9 ms / 33 ms, 31% | 1,085, 54 ms / 122 ms | 1,080, 323 ms, 0% | 178-179 MiB |
| django | 300/s, 0.9 ms / 1.2 ms, 31% | 1,082, 62 ms / 77 ms | 1,103, 287 ms, 0% | 294-294 MiB |
| rails | 300/s, 1.2 ms / 11 ms, 41% | 885, 75 ms / 102 ms | 846, 382 ms, 0% | 129-132 MiB |
| laravel | **failed**: never answered /api/items/item_1 within a minute | - | - | - |

### Item page, item fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 0.8 ms / 1.1 ms, 7% | 3,390, 20 ms / 25 ms | 3,142, 160 ms, 0% | 16-60 MiB |
| aspnet | 150/s, 1.8 ms / 10 ms, 39% | 1,004, 61 ms / 100 ms | 934, 355 ms, 0% | 71-99 MiB |
| axum-maud | 150/s, 1.3 ms / 1.9 ms, 16% | 992, 64 ms / 84 ms | 1,006, 482 ms, 0% | 18-61 MiB |
| topcoat | 150/s, 1.5 ms / 2.2 ms, 18% | 912, 69 ms / 95 ms | 846, 496 ms, 0% | 16-59 MiB |
| gin | 150/s, 1.4 ms / 2.6 ms, 21% | 712, 85 ms / 211 ms | 726, 535 ms, 0% | 13-39 MiB |
| leptos | 150/s, 1.8 ms / 2.7 ms, 23% | 705, 92 ms / 112 ms | 652, 819 ms, 0% | 15-55 MiB |
| drogon | 150/s, 2.2 ms / 5.4 ms, 38% | 493, 123 ms / 235 ms | 453, 989 ms, 0% | 13-37 MiB |
| spring | 150/s, 2.5 ms / 10 ms, 63% | 466, 135 ms / 248 ms | 362, 1.3 s, 0% | 425-459 MiB |
| astro | 150/s, 2.2 ms / 38 ms, 42% | 440, 147 ms / 193 ms | 411, 772 ms, 0% | 126-145 MiB |
| sveltekit | 150/s, 2.3 ms / 25 ms, 44% | 375, 169 ms / 223 ms | 359, 890 ms, 0% | 142-154 MiB |
| phoenix | 150/s, 3.4 ms / 5.6 ms, 57% | 351, 179 ms / 255 ms | 341, 5.7 s, 0% | 221-300 MiB |
| rails | 150/s, 3.4 ms / 36 ms, 58% | 325, 190 ms / 278 ms | 285, 1.1 s, 0% | 110-114 MiB |
| tanstack-start | 150/s, 2.8 ms / 42 ms, 52% | 313, 206 ms / 247 ms | 296, 987 ms, 0% | 130-160 MiB |
| react-router | 150/s, 3.3 ms / 43 ms, 59% | 283, 225 ms / 280 ms | 286, 3.5 s, 0% | 144-156 MiB |
| nuxt | 150/s, 6.3 ms / 273 ms, 77% | 204, 312 ms / 350 ms | 201, 5.1 s, 0% | 138-198 MiB |
| django | 150/s, 6.7 ms / 272 ms, 87% | 177, 361 ms / 409 ms | 181, 1.6 s, 0% | 128-128 MiB |
| nextjs | **failed**: 81/s served, 2.6 s / 52.8 s, 79% | 115, 534 ms / 829 ms | 105, 26.1 s, 0% | 210-254 MiB |
| laravel | **failed**: 90/s served, 10.1 s / 11.3 s, 98% | 96, 669 ms / 743 ms | 94, 2.9 s, 0% | 122-126 MiB |

### The item as JSON, fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 0.7 ms / 1.0 ms, 6% | 3,540, 19 ms / 24 ms | 3,211, 113 ms, 0% | 16-57 MiB |
| aspnet | 150/s, 1.4 ms / 6.3 ms, 30% | 1,374, 45 ms / 74 ms | 1,369, 278 ms, 0% | 59-87 MiB |
| axum-maud | 150/s, 1.4 ms / 2.0 ms, 16% | 1,047, 59 ms / 85 ms | 978, 406 ms, 0% | 17-54 MiB |
| leptos | 150/s, 1.3 ms / 2.0 ms, 16% | 1,008, 61 ms / 87 ms | 923, 421 ms, 0% | 15-57 MiB |
| topcoat | 150/s, 1.4 ms / 2.0 ms, 17% | 978, 64 ms / 86 ms | 922, 416 ms, 0% | 16-58 MiB |
| spring | 150/s, 1.6 ms / 5.6 ms, 39% | 865, 70 ms / 153 ms | 740, 676 ms, 0% | 424-454 MiB |
| nuxt | 150/s, 1.5 ms / 17 ms, 27% | 769, 83 ms / 130 ms | 696, 531 ms, 0% | 125-142 MiB |
| gin | 150/s, 1.4 ms / 2.4 ms, 21% | 746, 77 ms / 218 ms | 747, 520 ms, 0% | 13-38 MiB |
| sveltekit | 150/s, 1.5 ms / 16 ms, 28% | 694, 93 ms / 129 ms | 581, 559 ms, 0% | 118-137 MiB |
| tanstack-start | 150/s, 1.6 ms / 18 ms, 29% | 654, 101 ms / 132 ms | 553, 579 ms, 0% | 125-144 MiB |
| react-router | 150/s, 1.8 ms / 29 ms, 37% | 560, 116 ms / 150 ms | 516, 623 ms, 0% | 125-141 MiB |
| astro | 150/s, 1.8 ms / 29 ms, 37% | 542, 118 ms / 149 ms | 509, 624 ms, 0% | 126-146 MiB |
| drogon | 150/s, 2.4 ms / 6.1 ms, 41% | 429, 145 ms / 233 ms | 392, 1.0 s, 0% | 13-36 MiB |
| rails | 150/s, 2.6 ms / 27 ms, 44% | 409, 152 ms / 240 ms | 369, 902 ms, 0% | 82-85 MiB |
| phoenix | 150/s, 2.9 ms / 5.2 ms, 49% | 407, 154 ms / 223 ms | 403, 8.0 s, 0% | 226-315 MiB |
| nextjs | 150/s, 2.2 ms / 55 ms, 44% | 347, 192 ms / 239 ms | 329, 961 ms, 0% | 150-191 MiB |
| django | 150/s, 2.9 ms / 4.9 ms, 47% | 327, 188 ms / 253 ms | 322, 935 ms, 0% | 76-77 MiB |
| laravel | 150/s, 4.5 ms / 16 ms, 65% | 241, 258 ms / 466 ms | 236, 1.6 s, 0% | 101-116 MiB |

### Instructions per request

| App | Item page: user / kernel | JSON: user / kernel |
|---|---|---|
| axum-maud | 74,186 / 33,989 | 197,769 / 33,058 |
| **corten** | 105,870 / 33,431 | 69,896 / 33,566 |
| drogon | 118,061 / 34,149 | 1,736,129 / 32,654 |
| gin | 471,046 / 76,225 | 649,310 / 63,433 |
| topcoat | 508,770 / 31,890 | 155,254 / 33,379 |
| aspnet | 1,240,748 / 59,074 | 264,211 / 53,613 |
| astro | 2,002,543 / 80,203 | 1,053,963 / 77,078 |
| phoenix | 2,207,113 / 92,369 | 1,563,133 / 84,198 |
| leptos | 2,776,825 / 35,783 | 205,343 / 33,246 |
| sveltekit | 4,537,734 / 47,434 | 673,613 / 33,623 |
| rails | 5,371,391 / 335,271 | 2,275,860 / 289,962 |
| tanstack-start | 5,380,811 / 50,697 | 547,080 / 34,133 |
| spring | 6,254,798 / 109,741 | 1,437,809 / 98,683 |
| react-router | 6,541,973 / 110,582 | 863,461 / 70,515 |
| nuxt | 9,880,157 / 66,623 | 409,695 / 32,236 |
| django | 12,898,706 / 357,763 | 1,884,585 / 171,797 |
| nextjs | 17,742,011 / 136,631 | 1,702,677 / 58,976 |
| laravel | **failed**: did not start | **failed**: did not start |

### Efficiency

What each request costs the machine, from the same runs as the tables above. Pages per
CPU-second is requests a second at 64 users over the share of its one core the app used: work per
request, which does not depend on whether the load kept the core busy. CPU for 300 pages/s is the
fixed-rate phase, what a steady modest load costs. Pages/s per MiB is the 64-user rate over the
app's peak memory in that phase. Instruction counts (above) are the steadiest form of the same
cost; these also include allocation, waiting and the kernel.

| App | Pages per CPU-second: memory / item API | JSON per CPU-second: memory / item API | CPU for 300 pages/s from memory | Pages/s per MiB, from memory | Peak memory, 64 users |
|---|---|---|---|---|---|
| axum-maud | 24,823 / 993 | 17,757 / 1,047 | 3.6% | 1,504 | 16.1 MiB |
| **corten** | 18,423 / 3,391 | 22,872 / 3,541 | 4.6% | 1,087 | 16.7 MiB |
| drogon | 18,211 / 493 | 2,413 / 429 | 4.3% | 1,381 | 13 MiB |
| topcoat | 5,576 / 912 | 17,872 / 978 | 8.6% | 357 | 15.6 MiB |
| gin | 4,528 / 713 | 4,083 / 746 | 8.8% | 188 | 24.1 MiB |
| aspnet | 4,115 / 1,005 | 12,675 / 1,375 | 26% | 47 | 88.3 MiB |
| leptos | 1,339 / 705 | 12,544 / 1,008 | 25% | 83 | 16.2 MiB |
| phoenix | 1,323 / 351 | 1,931 / 407 | 38% | 4.5 | 292.6 MiB |
| astro | 1,184 / 440 | 1,860 / 542 | 31% | 9.2 | 128.6 MiB |
| spring | 1,085 / 465 | 6,116 / 865 | 53% | 3.0 | 359.2 MiB |
| sveltekit | 767 / 375 | 3,031 / 694 | 42% | 5.1 | 149.4 MiB |
| tanstack-start | 640 / 313 | 3,397 / 654 | 53% | 4.0 | 161.6 MiB |
| react-router | 510 / 283 | 2,243 / 560 | 65% | 3.4 | 148.1 MiB |
| rails | 429 / 325 | 885 / 409 | 78% | 3.0 | 142.5 MiB |
| nuxt | 316 / 204 | 7,060 / 769 | 100%, 287/s served | 2.3 | 140.1 MiB |
| django | failed (301) / 177 | 1,084 / 327 | failed (99%, 264/s served) | failed (0.9) | 345.9 MiB |
| nextjs | failed (181) / failed (115) | 1,085 / 347 | failed (91%, 153/s served) | failed (0.8) | 212.3 MiB |
| laravel | **failed** / failed (97) | **failed** / 244 | **failed** | **failed** | **failed** |

Corten renders a page from memory with 54 µs of CPU (18,423 per CPU-second), 4.5x ASP.NET Core
(243 µs) and 14x Leptos (747 µs); axum + Maud with 40 µs and Drogon with 55.
Its JSON takes 44 µs, against axum + Maud's and Topcoat's 56 and ASP.NET Core's and Leptos's
79 and 80. At 300 pages a second it used 4.6% of its core, axum + Maud 3.6%,
Drogon 4.3%, ASP.NET Core 26% and Leptos 25%; that is 6,504 pages per CPU-second,
about a third of its rate at 64 users, since at a low rate each request also pays for waking the
server. It serves 1,087 pages a second per MiB: 13x Leptos (83) and 23x ASP.NET Core
(47); axum + Maud serves 1,504, and Drogon, which peaks lowest (13 MiB against Corten's
16.7), 1,381. From the item API, fetching and parsing the 55 KB item costs Corten about
240 µs a page, 4.4 times the page itself
([#166 Corten's item-API path spends six times as long fetching and parsing the item as rendering it, and the single-process item API could soon cap it](https://github.com/todd-skelton/corten/issues/166)).
Corten's pages per CPU-second from memory rose 23.0% from r12, on the same CPU model; the median
of the other apps that passed both rounds rose 12.5% (from -3.2% to +23.3%).

In r13 Corten's core was 101% busy at 64 users for the page from memory and 100% for the JSON: the
load generator, which from r7 also gets the item API's two cores (idle with items in memory), kept
it busy. Every one of Corten's phases has its CPU time read from the container's cgroup counter
rather than from once-a-second samples (`cpu-time.mjs`; `cpuCounted` in `summary.json`), and the
item API used 45-47% of one core at 64 users (44-45% at 256), of the 200% its two processes can
use, in Corten's item-API phases.

### Bytes the item page loads (raw / gzip, KB)

| App | HTML | JavaScript (files) | WASM | CSS |
|---|---|---|---|---|
| astro | 7.8 / 1.8 | 24.9 / 9.2 (3) | 0 | 8.3 / 2.2 |
| **corten** | 11.2 / 2.3 | 33.9 / 12.5 (4) | 0 | 9.0 / 2.7 |
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
| leptos | 18.6 / 3.7 | 24.9 / 7.0 (1) | 767.0 / 304.2 | 8.5 / 2.2 |

### Browser, median of 10 (p90)

| App | Interactive | LCP | Blocking time | Form action | Client navigation | JS heap |
|---|---|---|---|---|---|---|
| Desktop | | | | | | |
| aspnet | 54 (60) ms | 76 ms | 0 ms | 80 ms | 17 (18) ms | 1.7 MB |
| gin | 55 (58) ms | 76 ms | 0 ms | 82 ms | 15 (16) ms | 1.7 MB |
| django | 57 (59) ms | 80 ms | 0 ms | 81 ms | 22 (26) ms | 1.7 MB |
| drogon | 57 (58) ms | 76 ms | 0 ms | 81 ms | 16 (18) ms | 1.7 MB |
| topcoat | 62 (66) ms | 76 ms | 0 ms | 80 ms | 16 (16) ms | 1.8 MB |
| astro | 65 (71) ms | 80 ms | 0 ms | 88 ms | 16 (17) ms | 1.6 MB |
| **corten** | 68 (71) ms | 80 ms | 0 ms | 88 ms | 14 (15) ms | 1.6 MB |
| rails | 71 (72) ms | 80 ms | 0 ms | 100 ms | 27 (34) ms | 2.1 MB |
| spring | 71 (80) ms | 88 ms | 0 ms | 88 ms | 30 (41) ms | 1.7 MB |
| axum-maud | 77 (81) ms | 72 ms | 0 ms | 83 ms | 16 (16) ms | 1.7 MB |
| laravel | 84 (89) ms | 80 ms | 0 ms | 92 ms | 26 (27) ms | 2.2 MB |
| leptos | 108 (110) ms | 76 ms | 0 ms | 73 ms | 24 (26) ms | 1.9 MB |
| nuxt | 114 (122) ms | 76 ms | 0 ms | 72 ms | 23 (24) ms | 2.9 MB |
| phoenix | 117 (133) ms | 112 ms | 0 ms | 79 ms | 18 (20) ms | 2.3 MB |
| sveltekit | 130 (135) ms | 88 ms | 0 ms | 74 ms | 33 (34) ms | 2.4 MB |
| tanstack-start | 144 (147) ms | 84 ms | 0 ms | 82 ms | 28 (30) ms | 3.1 MB |
| nextjs | 168 (173) ms | 84 ms | 0 ms | 84 ms | 105 (173) ms | 3.4 MB |
| react-router | 191 (199) ms | 120 ms | 0 ms | 92 ms | 43 (48) ms | 2.7 MB |
| Mobile (4x CPU, 150 ms RTT, 1.6 Mbps) | | | | | | |
| aspnet | 452 (454) ms | 432 ms | 17 ms | 310 ms | 247 (250) ms | 1.7 MB |
| drogon | 456 (457) ms | 428 ms | 19 ms | 301 ms | 218 (228) ms | 1.7 MB |
| django | 457 (460) ms | 436 ms | 17 ms | 315 ms | 245 (249) ms | 1.7 MB |
| topcoat | 468 (471) ms | 448 ms | 13 ms | 283 ms | 220 (225) ms | 1.9 MB |
| **corten** | 476 (484) ms | 468 ms | 13 ms | 293 ms | 201 (203) ms | 1.6 MB |
| spring | 646 (654) ms | 488 ms | 15 ms | 301 ms | 246 (248) ms | 1.7 MB |
| axum-maud | 649 (653) ms | 492 ms | 16 ms | 308 ms | 245 (255) ms | 1.7 MB |
| gin | 649 (654) ms | 492 ms | 18 ms | 298 ms | 244 (246) ms | 1.7 MB |
| astro | 680 (693) ms | 516 ms | 16 ms | 326 ms | 231 (234) ms | 1.6 MB |
| laravel | 889 (894) ms | 452 ms | 30 ms | 341 ms | 215 (223) ms | 2.2 MB |
| sveltekit | 903 (908) ms | 500 ms | 27 ms | 287 ms | 304 (332) ms | 2.4 MB |
| phoenix | 960 (974) ms | 440 ms | 63 ms | 152 ms | 144 (151) ms | 2.3 MB |
| react-router | 1,125 (1,150) ms | 480 ms | 59 ms | 347 ms | 311 (373) ms | 2.8 MB |
| rails | 1,195 (1,207) ms | 544 ms | 16 ms | 301 ms | 265 (272) ms | 2.1 MB |
| nextjs | 1,460 (1,570) ms | 428 ms | 175 ms | 313 ms | 525 (532) ms | 3.3 MB |
| nuxt | 1,574 (1,607) ms | 556 ms | 132 ms | 287 ms | 265 (272) ms | 2.9 MB |
| leptos | 1,921 (1,932) ms | 460 ms | 87 ms | 293 ms | 245 (262) ms | 1.9 MB |
| tanstack-start | 2,429 (2,484) ms | 536 ms | 143 ms | 299 ms | 343 (352) ms | 3.1 MB |

### What the numbers say

1. Rendering from memory: axum + Maud serves the most item pages a second at 64 users
   (24,209), then Corten (18,157) and Drogon (17,956). Corten serves 4.4x ASP.NET Core
   (4,112) and 14x Leptos (1,339). A page cost Corten 105,870 user-mode instructions,
   axum + Maud 74,186 and Drogon 118,061; ASP.NET Core 1.24 million, Leptos
   2.8 million, Next.js 17.7 million.
2. JSON from memory: Corten leads with 22,172 a second, then Topcoat (17,677), axum + Maud
   (17,534), ASP.NET Core (12,658) and Leptos (12,494). Corten's JSON cost 69,896
   user-mode instructions, a third of Leptos's (205,343) and less than its own HTML page;
   Drogon's, written by JsonCpp, cost 1.74 million (2,412 a second).
3. With the item API every request fetches and parses about 55 KB of JSON, and that dominates.
   Corten parses only the fields the page reads (see below) and serves 3,390 pages a second,
   3.4x ASP.NET Core (1,004) and axum + Maud (992) and 4.8x Leptos (705); the rest
   that passed serve 177-912. As JSON from the item API: Corten 3,540, ASP.NET Core 1,374, axum +
   Maud 1,047, Leptos 1,008. At 150 a second Corten's page used 6.8% of its core, ASP.NET
   Core's 39%.
4. Failed: Next.js could not serve 300 pages a second from memory (153, p99 57.2 s) or 150 from
   the item API (81). Laravel did not answer within a minute for the in-memory runs, as before:
   each Octane worker loads the 508 items into PHP arrays, which PHP's default `memory_limit`
   (128 MB) does not allow; with the item API it served 90 of 150 pages a second (29.13% never
   sent) and kept up with the JSON. Django failed the in-memory page test again (264 of 300 pages a
   second, 7.62% never sent); Nuxt, which failed it in r12, passed (287, 2.29% never sent, at
   101% of its core).
5. Cold start: axum + Maud, Topcoat, Corten and Leptos answer 7.0, 8.0, 8.4 and 9.2 ms
   after their process starts, Gin 12 ms and Drogon 32 ms, and hold 1.2-3.3 MiB after the first
   request, Corten the least (1.234 MiB). The Node frameworks take 214-747 ms and
   26-53 MiB; Spring Boot 8.1 s and 135 MiB.
6. Browser: on desktop the server-rendered apps with small scripts (ASP.NET Core, Gin, Django,
   Drogon, Topcoat, Astro, Corten, Rails, Spring, axum + Maud) are interactive in
   54-77 ms. On the throttled phone Corten is interactive in 476 ms, with ASP.NET Core,
   Drogon and Django (452-457 ms) and Topcoat (468 ms), against 1,460 ms for Next.js,
   1,921 ms for Leptos (WASM) and 2,429 ms for TanStack Start; Spring, axum + Maud and Gin,
   which load the same htmx as ASP.NET Core and Django, take 646-649 ms. Corten's client
   navigation is the fastest on desktop (14 ms); on the phone Phoenix's is (144 ms against
   201 ms), over its already-open LiveView socket. Corten's item page loads 12.5 KB of
   JavaScript (gzip) in four files, up from 12.4 KB in r12, more than Astro's 9.2 KB and less
   than Topcoat's 15.0 KB in two.
7. The four new apps against Corten, from memory at 64 users, as pages and JSON a second:
   axum + Maud 1.33x and 0.79x (24,209 and 17,534), Drogon 0.99x and 0.11x (17,956 and 2,412),
   Topcoat 0.31x and 0.80x (5,574 and 17,677), and Gin 0.25x and 0.18x (4,527 and 4,082). Per
   CPU-second axum + Maud renders 24,823 pages and Drogon 18,211 against Corten's 18,423, Topcoat 5,576 and Gin 4,528.
   At 64 users Drogon peaks at 13 MiB, Topcoat at 15.6 MiB and axum + Maud at 16.1 MiB, below
   Corten's 16.7 MiB, and Gin at 24.1 MiB.

r13 ran on a Platinum 8168, as r12 did, on another droplet. Between them Corten moved 205 commits,
the other thirteen apps' code changed only in a comment in the htmx apps' shared script, and Topcoat,
axum + Maud, Gin and Drogon joined, so they have nothing to compare with. Medians below are over
the other apps that passed the test in both rounds. Their 64-user requests a second rose by a
median of 12.5% for the page from memory, 14.0% for the JSON from memory, 16.6% for the item-API page
and 14.5% for the item-API JSON. Corten's rose 22.2% (14,854 to 18,157), 17.1% (18,938 to
22,172), 11.3% (3,047 to 3,390) and 8.9% (3,251 to 3,540): 9.7 and 3.1 points more
than the others from memory, and 5.4 and 5.6 points less from the item API. Its instruction
counts, against r11's (the last round before r13 that counted), held: 105,870 user-mode
instructions for the page (107,287, -1.3%) and 69,896 for the JSON (69,655,
+0.3%), with kernel counts up 3.1% and 2.4%. Its item page's JavaScript grew
0.9% (12,670 to 12,789 bytes gzip, in the same four files) while its CSS (2,777) and
HTML (2,385) held; its cold start went from 9.4 to 8.4 ms (-10.6%; the other apps'
median -12.2%), and its peak memory at 64 users from 16.3 to 16.7 MiB. In the browser
Corten's desktop interactive went from 67 to 68 ms and its phone from 483 to 476 ms, while
the other apps moved by a median of -6.5% and -1.3%. Counts compare across rounds, and
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

Instructions are `count.mjs ... api`, median of 3 x 5,000 requests. r13, on a Platinum 8168,
serves 3,390 item-API pages a second against ASP.NET Core's 1,004 (3.4x; 2.3x in the A/B and in r4,
3.2x in r5, 3.1x in r6 and r7, 3.4x in r8, r10 and r12, 3.3x in r11), at 6.8% of its core at 150 a
second against 39%.

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
0-3, on a desktop with other work running (not recorded per step): one run each, a preview
until a droplet round measures it. The one app measured twice moved 2.7x (TanStack Start's
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
   depends on everything else. The diagnostic build's passes for it add up to only 76 s, a gap
   the data does not explain, so reading its shares as the clean build's is an assumption:
   LLVM's optimization and thin LTO are 67 s of the 76 (88%), with the release profile's
   `codegen-units = 1`, `lto = "thin"` and `opt-level = 3`, which no run has varied yet. Macro
   expansion (0.3 s), type checking (0.65 s) and borrow checking (0.87 s) are under 2 s
   together, and monomorphization 5.6 s.
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
   8168 at 2.7 GHz in r12 and r13, 16 GB), Ubuntu 24.04, kernel 6.8, Docker 29.9, Node 24, created for the run
   and destroyed after it (`droplet.mjs`). The round runs on the droplet by itself, as a systemd
   unit (`corten-bench-<round>`), so it does not need the machine that started it:
   `droplet.mjs --detach` starts it and leaves, and `droplet.mjs <round> --collect` later
   downloads the results and destroys the droplet once the round has ended (or says where it is).
   On the droplet, `run-all.mjs --unattended` gives each call a time limit (at least twice the
   longest it took in r5-r8; the builds' are guesses, item 10) and stops one that runs past it
   or prints nothing for an hour. A kernel lockup (r8's) panics the kernel, which reboots the
   droplet; the unit starts again at boot and the round goes on from the next step. A droplet
   that does not answer for 15 minutes while `droplet.mjs` waits or collects is power-cycled,
   with the same effect (the full comparison only; `--collect` gives up, leaving the droplet,
   only when DigitalOcean cannot be reached either). Either way the step it was in is skipped
   (in the build step, only the app that was building; the full comparison only: `--suite live`
   and `--suite browser` start no further), named in `run.log` and in `summary.json`
   (`skipped`), and its results are partly or
   wholly missing from the round. A round that stops short keeps what it measured, and the
   droplet is destroyed only after its results are downloaded. Droplets of one size are
   not all the same CPU (r1's, r4's, r5's, r8's, r12's and r13's were a Platinum 8168, r2's, r3's,
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
   median of 3. A count does not depend on what else the machine is doing, so it is steadier than
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
    step a 420-minute budget, counted afresh at each start as the unit's hours are, both guesses
    until a round measures them; a stopped or crashed build skips its
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
7. Laravel ran with PHP's default `memory_limit` throughout r3 to r13. (r2's main run had raised it
   to 512 MB and measured Laravel again with the default afterwards; `results/r2/laravel-rerun.log`.)
8. r4's droplet had a slower CPU than r3's (Platinum 8168 against 8280). Django and Nuxt, which
   passed r3's in-memory page test near their limit, failed it on r4's; their settings did not
   change. r3's numbers stay in `results/r3/`. In r5, on the same CPU model as r4, Django passed
   it again (4.1% never sent) and Nuxt did not; in r6 and r7, on a Platinum 8280, both passed, and in
   r8, on a Platinum 8168 again, both passed (Nuxt with 1.73% never sent), as they did in r10 and r11,
   on a Platinum 8280. In r12, on a Platinum 8168 and rendering Corten's markup, Django (7.59% never
   sent) and Nuxt (10.01%) failed it. In r13, on the same CPU model, Django failed it again (7.62%
   never sent) and Nuxt passed (287 of 300 a second, 2.29% never sent).
9. r13 measured the tree at `7f0b81f` (`results/r13/commit.txt`, kept on the branch
   `bench/r13-tree`; its apps are the ones merged in
   [#751 Benchmark Topcoat, axum + Maud, Gin and Drogon against Corten](https://github.com/todd-skelton/corten/pull/751)).
   Changes merged to `main` after that are not in these numbers.
10. r6's efficiency numbers divide by CPU sampled once a second, which is coarse for an app using
    a few percent of its core (Corten's 4.6% at the fixed rate); from r7 they divide by the
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
    (the tree at `512dc73`), the last round before it that counted.
12. Through r11 the other apps rendered Corten's visible text with markup and stylesheets of their
    own (the stylesheets last changed on 2026-10-22, the markup on 2026-10-31 only for the plural
    counts), while Corten's item page changed in nine commits after that
    ([#642 The benchmark's other apps render Corten's item page text but not its markup or styles, which changed in nine commits since Oct 22](https://github.com/todd-skelton/corten/issues/642)).
    From r12 they render Corten's markup with its stylesheets, so their page bytes, browser times
    and server numbers are not like for like with r11's. r12 is the first round with Corten's markup
    and stylesheets in every app, and r13, the round these tables come from, the first with all
    eighteen; in each, parity passed on 17 pages and `look.mjs` on 4 pages in 4 views, with no
    failures.
13. Build times depend on the toolchain images' versions (`rust:1-bookworm`, `node:24-bookworm-slim`
    and the rest move to their newest release) and, for dependencies, on the network and the
    package registries at the time. The rebuild keeps each tool's cache, which favors the tools
    that keep one; a Docker build without a cache mount starts each rebuild without it. Each
    rebuild runs in a new container, so a build server (.NET's, Gradle-style daemons) does not
    carry over, as on a fresh CI runner. Peak memory is anonymous memory only: the files rustc
    and the linkers map in are page cache and not counted.
14. Pinned to four cores, a tool that sizes its workers from Node's `os.cpus()` still sees the
    host's eight on the droplet, and may start more workers than four cores run at once.

## Running it

```sh
# On a fresh droplet, created and destroyed for the run (needs doctl and an SSH key there):
node bench/fullstack/droplet.mjs r14 --ssh-key <id> [--region sfo2]   # waits for the round
node bench/fullstack/droplet.mjs r14 --ssh-key <id> --detach          # or start it and leave,
node bench/fullstack/droplet.mjs r14 --collect                        # then collect it later
# Or by hand, from the repository root: the images, the fixture, then everything.
docker build -f examples/card-market/Dockerfile -t cb-corten .
for app in nextjs tanstack-start sveltekit react-router leptos topcoat axum-maud gin drogon django rails laravel aspnet spring phoenix astro nuxt; do
  docker build -t cb-$app bench/fullstack/apps/$app
done
node bench/fullstack/fixtures/fetch.mjs http://localhost:18400   # or any {"item_1": {...}} file
cd bench/fullstack && node run-all.mjs r14 10
node check-app.mjs <app>    # before adding an app: parity, look, JSON and 404s against corten
                            # (replaces fsw-corten and fsw-<app>, removed after unless keep; needs cb-corten from this tree)
node sync-styles.mjs        # after Corten's styles change (cb-corten rebuilt and running): copy them to every app
node look.mjs [apps]        # every app's pages in Chromium against Corten's, box by box
node build.mjs r14 [apps] [runs=3]   # build cost: clean, after a one-line change, and dev builds
```
