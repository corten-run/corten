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
tables below are from r12, the first round in which every app renders Corten's markup and
stylesheets (caveat 12); its instruction counts are r11's (caveat 11). Each app
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

Topcoat, axum + Maud, Gin and Drogon joined after r12, so they have no rows in the tables below;
the next round measures them.

## Results

All numbers are measured, from one run (`results/r12/`, 2026-11-03 UTC, the tree at `094f72d`) on one
DigitalOcean c-8 droplet (Intel Xeon Platinum 8168); see [Method](#method). Failed means the app could not do the
test with its usual settings in one CPU and 1 GiB (see caveat 5); its other numbers are kept
where it produced any. r12 has no instruction counts, so that table is r11's (caveat 11). r9
measured nothing (its launcher hung in its own `ssh` call before the round started). r11
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
| **corten** | 9.4 ms (7.2 ms-18 ms) | 1.223 MiB | 124 MB |
| leptos | 9.5 ms (8.2 ms-12 ms) | 1.5 MiB | 128 MB |
| sveltekit | 224 ms (209 ms-322 ms) | 25.84 MiB | 333 MB |
| tanstack-start | 265 ms (249 ms-285 ms) | 27.61 MiB | 332 MB |
| react-router | 365 ms (350 ms-421 ms) | 33.89 MiB | 353 MB |
| nuxt | 387 ms (361 ms-455 ms) | 37.05 MiB | 335 MB |
| astro | 394 ms (350 ms-560 ms) | 36.31 MiB | 527 MB |
| nextjs | 827 ms (767 ms-836 ms) | 53 MiB | 385 MB |
| aspnet | 888 ms (803 ms-1.0 s) | 30.93 MiB | 342 MB |
| laravel | 1.1 s (992 ms-1.2 s) | 96.38 MiB | 948 MB |
| django | 1.3 s (1.2 s-1.8 s) | 65.42 MiB | 276 MB |
| rails | 1.4 s (1.2 s-1.5 s) | 63.83 MiB | 431 MB |
| phoenix | 1.7 s (1.6 s-1.8 s) | 124.1 MiB | 262 MB |
| spring | 9.8 s (9.1 s-10.1 s) | 145.6 MiB | 516 MB |

### Item page, items in memory (no database)

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 300/s, 0.3 ms / 0.4 ms, 5% | 14,854, 4.7 ms / 8.9 ms | 13,507, 34 ms, 0% | 16-19 MiB |
| aspnet | 300/s, 0.7 ms / 3.1 ms, 30% | 3,336, 19 ms / 33 ms | 3,424, 122 ms, 0% | 85-88 MiB |
| leptos | 300/s, 1.0 ms / 1.4 ms, 27% | 1,190, 55 ms / 77 ms | 1,061, 401 ms, 0% | 15-33 MiB |
| phoenix | 300/s, 1.2 ms / 1.6 ms, 42% | 1,154, 55 ms / 75 ms | 1,179, 5.1 s, 0% | 282-299 MiB |
| astro | 300/s, 1.1 ms / 34 ms, 35% | 1,035, 56 ms / 133 ms | 985, 345 ms, 0% | 136-137 MiB |
| spring | 300/s, 1.3 ms / 92 ms, 64% | 968, 47 ms / 421 ms | 1,002, 1.3 s, 0% | 362-382 MiB |
| sveltekit | 300/s, 1.3 ms / 28 ms, 47% | 792, 76 ms / 151 ms | 705, 456 ms, 0% | 148-154 MiB |
| tanstack-start | 300/s, 1.7 ms / 41 ms, 58% | 590, 101 ms / 180 ms | 584, 537 ms, 0% | 162-164 MiB |
| react-router | 300/s, 2.1 ms / 57 ms, 71% | 470, 129 ms / 206 ms | 440, 715 ms, 0% | 138-139 MiB |
| rails | 299/s, 14 ms / 238 ms, 92% | 367, 173 ms / 217 ms | 331, 902 ms, 0% | 137-138 MiB |
| nuxt | **failed**: 197/s served, 837 ms / 50.0 s, 77% | 278, 227 ms / 268 ms | 273, 1.6 s, 0% | 141-149 MiB |
| django | **failed**: 261/s served, 2.1 s / 4.4 s, 100% | 257, 247 ms / 340 ms | 251, 1.2 s, 0% | 346-346 MiB |
| nextjs | **failed**: 130/s served, 1.4 s / 58.1 s, 88% | 158, 416 ms / 490 ms | 159, 18.3 s, 0% | 209-215 MiB |
| laravel | **failed**: never answered /items/item_1 within a minute | - | - | - |

### The item as JSON, items in memory

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 300/s, 0.3 ms / 0.4 ms, 4% | 18,938, 3.4 ms / 8.9 ms | 18,419, 35 ms, 0% | 16-19 MiB |
| leptos | 300/s, 0.3 ms / 0.4 ms, 5% | 12,135, 5.8 ms / 8.9 ms | 10,714, 36 ms, 0% | 14-18 MiB |
| aspnet | 300/s, 0.4 ms / 0.6 ms, 17% | 9,984, 6.1 ms / 11 ms | 9,807, 43 ms, 0% | 76-83 MiB |
| nuxt | 300/s, 0.4 ms / 0.8 ms, 11% | 5,957, 9.3 ms / 35 ms | 5,510, 96 ms, 0% | 99-101 MiB |
| spring | 300/s, 0.4 ms / 2.0 ms, 26% | 5,900, 6.5 ms / 100 ms | 5,324, 601 ms, 0% | 339-362 MiB |
| tanstack-start | 300/s, 0.5 ms / 5.6 ms, 15% | 2,948, 20 ms / 54 ms | 2,850, 135 ms, 0% | 150-152 MiB |
| sveltekit | 300/s, 0.5 ms / 4.9 ms, 15% | 2,681, 22 ms / 58 ms | 2,748, 152 ms, 0% | 128-131 MiB |
| react-router | 300/s, 0.8 ms / 17 ms, 22% | 1,879, 32 ms / 97 ms | 1,988, 205 ms, 0% | 117-119 MiB |
| phoenix | 300/s, 0.8 ms / 1.2 ms, 30% | 1,675, 38 ms / 57 ms | 1,690, 4.2 s, 0% | 297-323 MiB |
| astro | 300/s, 0.8 ms / 28 ms, 26% | 1,671, 34 ms / 92 ms | 1,622, 225 ms, 0% | 139-140 MiB |
| nextjs | 300/s, 1.0 ms / 41 ms, 36% | 962, 61 ms / 136 ms | 970, 346 ms, 0% | 167-168 MiB |
| django | 300/s, 0.9 ms / 1.4 ms, 34% | 958, 68 ms / 86 ms | 941, 323 ms, 0% | 294-294 MiB |
| rails | 300/s, 1.3 ms / 10 ms, 44% | 768, 84 ms / 110 ms | 782, 385 ms, 0% | 130-132 MiB |
| laravel | **failed**: never answered /api/items/item_1 within a minute | - | - | - |

### Item page, item fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 0.9 ms / 1.2 ms, 8% | 3,047, 21 ms / 27 ms | 2,834, 135 ms, 0% | 16-55 MiB |
| aspnet | 150/s, 2.2 ms / 11 ms, 47% | 899, 70 ms / 106 ms | 836, 380 ms, 0% | 70-99 MiB |
| leptos | 150/s, 2.1 ms / 2.9 ms, 26% | 662, 98 ms / 121 ms | 571, 917 ms, 0% | 15-54 MiB |
| spring | 150/s, 3.3 ms / 180 ms, 81% | 437, 143 ms / 275 ms | 365, 1.3 s, 0% | 421-442 MiB |
| astro | 150/s, 2.6 ms / 46 ms, 50% | 409, 161 ms / 199 ms | 370, 900 ms, 0% | 126-148 MiB |
| sveltekit | 150/s, 2.8 ms / 29 ms, 52% | 316, 201 ms / 262 ms | 315, 2.4 s, 0% | 142-162 MiB |
| phoenix | 150/s, 3.8 ms / 6.0 ms, 61% | 301, 211 ms / 286 ms | 307, 5.7 s, 0% | 209-304 MiB |
| tanstack-start | 150/s, 3.3 ms / 49 ms, 59% | 266, 240 ms / 304 ms | 260, 7.7 s, 0% | 138-164 MiB |
| rails | 150/s, 4.3 ms / 51 ms, 69% | 262, 240 ms / 310 ms | 235, 1.2 s, 0% | 111-116 MiB |
| react-router | 150/s, 4.0 ms / 210 ms, 69% | 234, 272 ms / 339 ms | 253, 5.8 s, 0% | 127-154 MiB |
| nuxt | 150/s, 24 ms / 958 ms, 90% | 179, 356 ms / 410 ms | 185, 18.6 s, 0% | 143-198 MiB |
| django | 145/s, 731 ms / 1.9 s, 100% | 149, 428 ms / 505 ms | 152, 1.8 s, 0% | 128-128 MiB |
| nextjs | **failed**: 74/s served, 2.7 s / 55.0 s, 82% | 106, 582 ms / 947 ms | 95, 30.9 s, 0% | 246-250 MiB |
| laravel | **failed**: 74/s served, 13.1 s / 13.7 s, 99% | 74, 863 ms / 981 ms | 73, 3.8 s, 0% | 116-125 MiB |

### The item as JSON, fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 0.9 ms / 1.2 ms, 8% | 3,251, 20 ms / 25 ms | 3,068, 118 ms, 0% | 16-57 MiB |
| aspnet | 150/s, 1.7 ms / 7.4 ms, 34% | 1,224, 51 ms / 83 ms | 1,188, 294 ms, 0% | 59-87 MiB |
| leptos | 150/s, 1.6 ms / 2.2 ms, 18% | 938, 68 ms / 87 ms | 895, 417 ms, 0% | 15-53 MiB |
| spring | 150/s, 2.0 ms / 6.3 ms, 47% | 720, 84 ms / 182 ms | 622, 819 ms, 0% | 409-447 MiB |
| nuxt | 150/s, 1.8 ms / 21 ms, 31% | 675, 99 ms / 149 ms | 632, 602 ms, 0% | 124-137 MiB |
| sveltekit | 150/s, 1.9 ms / 20 ms, 33% | 600, 109 ms / 139 ms | 530, 594 ms, 0% | 120-143 MiB |
| tanstack-start | 150/s, 1.9 ms / 22 ms, 33% | 571, 116 ms / 147 ms | 517, 622 ms, 0% | 124-146 MiB |
| react-router | 150/s, 2.2 ms / 33 ms, 42% | 502, 131 ms / 164 ms | 455, 698 ms, 0% | 128-145 MiB |
| astro | 150/s, 2.2 ms / 35 ms, 43% | 481, 136 ms / 162 ms | 447, 713 ms, 0% | 123-141 MiB |
| rails | 150/s, 3.0 ms / 32 ms, 48% | 346, 184 ms / 251 ms | 338, 895 ms, 0% | 82-85 MiB |
| phoenix | 150/s, 3.4 ms / 5.5 ms, 56% | 344, 185 ms / 251 ms | 347, 5.7 s, 0% | 230-313 MiB |
| nextjs | 150/s, 2.8 ms / 79 ms, 54% | 310, 218 ms / 268 ms | 293, 3.5 s, 0% | 148-191 MiB |
| django | 150/s, 3.6 ms / 5.2 ms, 56% | 261, 244 ms / 290 ms | 266, 1.1 s, 0% | 76-77 MiB |
| laravel | 150/s, 5.7 ms / 29 ms, 79% | 195, 327 ms / 384 ms | 189, 1.5 s, 0% | 101-116 MiB |

### Instructions per request

From round r11 (2026-11-02, a Platinum 8280, the tree at `512dc73`); r12 has none (caveat 11).

| App | Item page: user / kernel | JSON: user / kernel |
|---|---|---|
| **corten** | 107,287 / 32,427 | 69,655 / 32,770 |
| aspnet | 1,078,575 / 55,401 | 272,218 / 76,324 |
| astro | 2,036,337 / 80,105 | 1,053,625 / 75,835 |
| phoenix | 2,147,572 / 87,644 | 1,546,353 / 78,444 |
| leptos | 2,723,939 / 34,828 | 204,234 / 32,976 |
| sveltekit | 4,450,975 / 44,063 | 672,054 / 33,112 |
| rails | 4,955,151 / 316,964 | 2,289,061 / 282,969 |
| tanstack-start | 5,216,399 / 48,512 | 514,561 / 33,167 |
| spring | 6,299,253 / 97,222 | 383,000 / 96,628 |
| react-router | 6,431,816 / 107,625 | 827,445 / 69,260 |
| nuxt | 9,794,547 / 62,848 | 428,508 / 32,178 |
| django | 12,714,671 / 345,995 | 1,891,103 / 170,889 |
| nextjs | 16,976,587 / 126,176 | 1,691,263 / 57,763 |
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
| **corten** | 14,982 / 3,048 | 19,342 / 3,251 | 5.1% | 911 | 16.3 MiB |
| aspnet | 3,338 / 900 | 9,993 / 1,224 | 30% | 39 | 86.7 MiB |
| leptos | 1,190 / 662 | 12,173 / 939 | 27% | 75 | 15.9 MiB |
| phoenix | 1,156 / 301 | 1,684 / 344 | 42% | 4.0 | 289.6 MiB |
| astro | 1,035 / 409 | 1,672 / 481 | 35% | 7.6 | 136.4 MiB |
| spring | 968 / 435 | 5,910 / 717 | 64% | 2.7 | 362.7 MiB |
| sveltekit | 792 / 316 | 2,682 / 600 | 47% | 5.3 | 149 MiB |
| tanstack-start | 591 / 266 | 2,948 / 570 | 58% | 3.6 | 162.7 MiB |
| react-router | 470 / 234 | 1,879 / 502 | 71% | 3.4 | 138.3 MiB |
| rails | 367 / 262 | 768 / 346 | 92%, 299/s served | 2.6 | 142.7 MiB |
| nuxt | failed (278) / 179 | 5,958 / 675 | failed (77%, 197/s served) | failed (2.0) | 141.4 MiB |
| django | failed (257) / 149 | 960 / 261 | failed (100%, 261/s served) | failed (0.7) | 346.5 MiB |
| nextjs | failed (158) / failed (106) | 962 / 310 | failed (88%, 130/s served) | failed (0.8) | 209.2 MiB |
| laravel | **failed** / failed (75) | **failed** / 199 | **failed** | **failed** | **failed** |

Corten renders a page from memory with 67 µs of CPU (14,982 per CPU-second), 4.5x ASP.NET Core
(300 µs) and 13x Leptos (840 µs), and its JSON with 52 µs, against Leptos's 82 and ASP.NET Core's
100. At 300 pages a second it used 5.1% of its core, ASP.NET Core 30% and Leptos 27%; that is 5,867
pages per CPU-second, about two fifths of its rate at 64 users, since at a low rate each request
also pays for waking the server. It serves 911 pages a second per MiB: 12x Leptos (75), which
peaks lower (15.9 MiB against 16.3) but serves a twelfth of the pages, and 24x ASP.NET Core (39).
From the item API, fetching and parsing the 55 KB item costs Corten about 260 µs a page, 3.9 times
the page itself
([#166 Corten's item-API path spends six times as long fetching and parsing the item as rendering it, and the single-process item API could soon cap it](https://github.com/todd-skelton/corten/issues/166)).
Corten's pages per CPU-second from memory fell 35.5% from r11, on a Platinum 8280, to r12, on a
Platinum 8168; the median of the other apps that passed fell 28.3% (from -37.8% to -24.3%), and
they render Corten's markup from r12 (caveat 12).

In r12 Corten's core was 102% busy at 64 users for the page from memory and 101% for the JSON: the
load generator, which from r7 also gets the item API's two cores (idle with items in memory), kept
it busy. Every one of Corten's phases has its CPU time read from the container's cgroup counter
rather than from once-a-second samples (`cpu-time.mjs`; `cpuCounted` in `summary.json`), and the
item API used 45-49% of one core at 64 users (46-50% at 256), of the 200% its two processes can
use, in Corten's item-API phases.

### Bytes the item page loads (raw / gzip, KB)

| App | HTML | JavaScript (files) | WASM | CSS |
|---|---|---|---|---|
| astro | 7.8 / 1.8 | 24.9 / 9.2 (3) | 0 | 8.3 / 2.2 |
| **corten** | 11.2 / 2.3 | 33.6 / 12.4 (4) | 0 | 9.0 / 2.7 |
| django | 7.9 / 1.9 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| aspnet | 7.9 / 2.0 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
| spring | 7.8 / 1.9 | 51.8 / 17.0 (2) | 0 | 9.0 / 2.7 |
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
| django | 59 (60) ms | 84 ms | 0 ms | 81 ms | 24 (25) ms | 1.7 MB |
| aspnet | 59 (66) ms | 84 ms | 0 ms | 84 ms | 19 (20) ms | 1.7 MB |
| **corten** | 67 (72) ms | 76 ms | 0 ms | 86 ms | 15 (16) ms | 1.6 MB |
| spring | 72 (92) ms | 96 ms | 0 ms | 88 ms | 36 (85) ms | 1.7 MB |
| astro | 73 (75) ms | 84 ms | 0 ms | 89 ms | 18 (19) ms | 1.6 MB |
| rails | 77 (80) ms | 84 ms | 0 ms | 103 ms | 25 (36) ms | 2.1 MB |
| laravel | 90 (95) ms | 84 ms | 0 ms | 104 ms | 28 (30) ms | 2.2 MB |
| nuxt | 117 (122) ms | 80 ms | 0 ms | 81 ms | 24 (25) ms | 2.9 MB |
| phoenix | 118 (159) ms | 112 ms | 0 ms | 78 ms | 19 (21) ms | 2.3 MB |
| leptos | 121 (145) ms | 84 ms | 0 ms | 84 ms | 25 (28) ms | 1.9 MB |
| sveltekit | 133 (140) ms | 92 ms | 0 ms | 82 ms | 34 (37) ms | 2.4 MB |
| tanstack-start | 154 (165) ms | 84 ms | 0 ms | 81 ms | 31 (33) ms | 3.1 MB |
| nextjs | 182 (190) ms | 88 ms | 0 ms | 82 ms | 125 (179) ms | 3.4 MB |
| react-router | 198 (209) ms | 128 ms | 0 ms | 94 ms | 46 (47) ms | 2.8 MB |
| Mobile (4x CPU, 150 ms RTT, 1.6 Mbps) | | | | | | |
| aspnet | 455 (459) ms | 440 ms | 26 ms | 322 ms | 253 (258) ms | 1.7 MB |
| django | 458 (462) ms | 444 ms | 22 ms | 315 ms | 252 (260) ms | 1.7 MB |
| **corten** | 483 (498) ms | 476 ms | 23 ms | 294 ms | 208 (210) ms | 1.6 MB |
| spring | 654 (655) ms | 496 ms | 22 ms | 323 ms | 249 (253) ms | 1.7 MB |
| astro | 689 (706) ms | 536 ms | 21 ms | 330 ms | 237 (240) ms | 1.6 MB |
| laravel | 903 (913) ms | 464 ms | 44 ms | 350 ms | 223 (229) ms | 2.2 MB |
| sveltekit | 948 (971) ms | 500 ms | 62 ms | 301 ms | 311 (320) ms | 2.4 MB |
| phoenix | 988 (1,015) ms | 444 ms | 87 ms | 169 ms | 143 (150) ms | 2.4 MB |
| react-router | 1,167 (1,174) ms | 500 ms | 89 ms | 361 ms | 328 (342) ms | 2.8 MB |
| rails | 1,200 (1,202) ms | 556 ms | 24 ms | 326 ms | 269 (270) ms | 2.1 MB |
| nextjs | 1,542 (1,547) ms | 444 ms | 224 ms | 323 ms | 546 (560) ms | 3.3 MB |
| nuxt | 1,605 (1,613) ms | 572 ms | 166 ms | 305 ms | 274 (279) ms | 2.9 MB |
| leptos | 1,938 (1,944) ms | 460 ms | 101 ms | 302 ms | 255 (257) ms | 1.9 MB |
| tanstack-start | 2,461 (2,491) ms | 528 ms | 160 ms | 312 ms | 357 (362) ms | 3.2 MB |

### What the numbers say

1. Rendering from memory: Corten serves 14,854 item pages a second at 64 users, 4.5x ASP.NET
   Core (3,336), the next fastest, and 12x Leptos (1,190). In r11, the last round that counted, a
   page cost it 107,287 user-mode instructions; ASP.NET Core 1.08 million, Leptos 2.7 million,
   Next.js 17 million.
2. JSON from memory: Corten leads with 18,938 a second, then Leptos (12,135) and ASP.NET Core
   (9,984). In r11 Corten's JSON cost 69,655 user-mode instructions, a third of Leptos's (204,234)
   and less than its own HTML page.
3. With the item API every request fetches and parses about 55 KB of JSON, and that dominates.
   Corten parses only the fields the page reads (see below) and serves 3,047 pages a second,
   3.4x ASP.NET Core (899) and 4.6x Leptos (662); the rest that passed serve 149-437. As JSON from
   the item API: Corten 3,251, ASP.NET Core 1,224, Leptos 938. At 150 a second Corten's page used
   7.9% of its core, ASP.NET Core's 47%.
4. Failed: Next.js could not serve 300 pages a second from memory (130, p99 58.1 s) or 150 from
   the item API (74). Laravel did not answer within a minute for the in-memory runs, as before:
   each Octane worker loads the 508 items into PHP arrays, which PHP's default `memory_limit`
   (128 MB) does not allow; with the item API it served 74 of 150 pages a second (40.05% never
   sent) and kept up with the JSON. Django (261 of 300 pages a second, 7.59% never sent) and Nuxt
   (197, 10.01%) failed the in-memory page test, which both passed in r8 on the same CPU model
   with markup of their own.
5. Cold start: Corten and Leptos answer 9.4 ms and 9.5 ms after their process starts and hold
   1.2 MiB and 1.5 MiB after the first request. The Node frameworks take 224-827 ms and
   26-53 MiB; Spring Boot 9.8 s and 146 MiB.
6. Browser: on desktop the server-rendered apps with small scripts (Django, ASP.NET Core, Corten,
   Spring, Astro, Rails) are interactive in 59-77 ms. On the throttled phone Corten is
   interactive in 483 ms, with the htmx apps (455-458 ms), against 1,542 ms for Next.js,
   1,938 ms for Leptos (WASM) and 2,461 ms for TanStack Start. Corten's client navigation is the
   fastest on desktop (15 ms); on the phone Phoenix's is (143 ms against 208 ms), over its
   already-open LiveView socket. Corten's item page loads 12.4 KB of JavaScript (gzip) in four
   files, up from 10.6 KB in r11, more than Astro's 9.2 KB.

r12 ran on a Platinum 8168 and r11 on a Platinum 8280. Between them Corten moved 474 commits and
every other app changed to render Corten's markup and stylesheets (caveat 12), so no app is a
fixed reference this time. Medians below are over the other apps that passed the test in both
rounds. The other apps' 64-user requests a second fell by a median of 28.3% for the page from
memory, 34.8% for the JSON from memory, 31.7% for the item-API page and 33.4% for the item-API
JSON. Corten's fell 34.6% (22,713 to 14,854), 40.0% (31,570 to 18,938), 33.8% (4,605 to 3,047)
and 33.3% (4,873 to 3,251): with the others from the item API, and 6.3 and 5.2 points more from
memory. Against r8, on a Platinum 8168 like r12's, Corten's page from memory fell 5.7% (15,747 to
14,854) while the other apps' median fell 15.3%, and its JSON fell 23.2% (24,652 to 18,938)
against 17.3%. r12 has no instruction counts (caveat 11), so it cannot separate Corten's own
change from the droplet's. Where Corten got worse: its item page's JavaScript grew 16.8% (10,844
to 12,670 bytes gzip, in the same four files), and its cold start rose from 6.4 to 9.4 ms, while
the other apps' median rose 37.9% (Leptos 6.2 to 9.5 ms). Its CSS grew 1.3% (2,742 to 2,777
bytes gzip) and its HTML held (2,387 to 2,385), as did its memory after the first request (1.234
to 1.223 MiB) and its peak memory at 64 users (16.6 to 16.3 MiB). In the browser Corten's desktop
interactive went from 47 to 67 ms and its phone from 460 to 483 ms, while the other apps moved by
a median of +48.1% and +7.6%. Counts compare across rounds, and requests a second only within one.

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

Instructions are `count.mjs ... api`, median of 3 x 5,000 requests. r12, on a Platinum 8168,
serves 3,047 item-API pages a second against ASP.NET Core's 899 (3.4x; 2.3x in the A/B and in r4,
3.2x in r5, 3.1x in r6 and r7, 3.4x in r8 and r10, 3.3x in r11), at 7.9% of its core at 150 a
second against 47%.

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

## Method

1. Machine: a DigitalOcean CPU-optimized droplet (`c-8`: 8 dedicated vCPUs, Intel Xeon Platinum
   8168 at 2.7 GHz in r12, 16 GB), Ubuntu 24.04, kernel 6.8, Docker 29.9, Node 24, created for the run
   and destroyed after it (`droplet.mjs`). The round runs on the droplet by itself, as a systemd
   unit (`corten-bench-<round>`), so it does not need the machine that started it:
   `droplet.mjs --detach` starts it and leaves, and `droplet.mjs <round> --collect` later
   downloads the results and destroys the droplet once the round has ended (or says where it is).
   On the droplet, `run-all.mjs --unattended` gives each call a time limit (at least twice the
   longest it took in r5-r8; the builds' are guesses, item 10) and stops one that runs past it or prints nothing for an hour. A kernel
   lockup (r8's) panics the kernel, which reboots the droplet; the unit starts again at boot and
   the round goes on from the next step. A droplet that does not answer for 15 minutes while
   `droplet.mjs` waits or collects is power-cycled, with the same effect (the full comparison
   only; `--collect` gives up, leaving the droplet, only when DigitalOcean cannot be reached
   either). Either way the step it
   was in is skipped (the full comparison only: `--suite live` and `--suite browser` start no
   further), named in `run.log` and in `summary.json` (`skipped`), and its results are partly or
   wholly missing from the round. A round that stops short keeps what it measured, and the
   droplet is destroyed only after its results are downloaded. Droplets of one size are
   not all the same CPU (r1's, r4's, r5's, r8's and r12's were a Platinum 8168, r2's, r3's,
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
10. Build (`build.mjs`, from r13 the round's last step, so a slow build costs no other step its
    time): each app is built in containers pinned to four cores (cores 1-4 of the droplet, the
    vCPUs of a standard CI runner; the host's first four elsewhere, so `nproc` sees four either
    way), from its toolchain image with its source copied in (its own build context and
    `.dockerignore`). The commands, image, directory, environment and fetched files are its
    Dockerfile's (`builds.mjs`; `builds.test.mjs` checks each against the Dockerfile):
    - Dependencies: the Dockerfile's dependency layer, the one Docker keeps while only the app's
      files change (`npm install`, `dotnet restore`, `mix deps.get` and `deps.compile`,
      `bundle install`, `go mod download`, Drogon's own build from source). The Rust
      Dockerfiles fetch and compile their crates in one step, so for them this is `cargo fetch`
      for the platforms the build targets, this benchmark's own split; Corten's fetches the whole
      workspace's crates, more than card-market compiles. It downloads, so its time is the
      network's as much as the tool's.
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
      which this does not time. Topcoat's is taken as `cargo build` alone.
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
    step). Each build call has a 90-minute limit and the step a 300-minute budget, both guesses
    until a round measures them; a stopped build skips its app alone, and past the budget the
    remaining apps are skipped and named in `skipped.txt`.

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
7. Laravel ran with PHP's default `memory_limit` throughout r3 to r12. (r2's main run had raised it
   to 512 MB and measured Laravel again with the default afterwards; `results/r2/laravel-rerun.log`.)
8. r4's droplet had a slower CPU than r3's (Platinum 8168 against 8280). Django and Nuxt, which
   passed r3's in-memory page test near their limit, failed it on r4's; their settings did not
   change. r3's numbers stay in `results/r3/`. In r5, on the same CPU model as r4, Django passed
   it again (4.1% never sent) and Nuxt did not; in r6 and r7, on a Platinum 8280, both passed, and in
   r8, on a Platinum 8168 again, both passed (Nuxt with 1.73% never sent), as they did in r10 and r11,
   on a Platinum 8280. In r12, on a Platinum 8168 and rendering Corten's markup, Django (7.59% never
   sent) and Nuxt (10.01%) failed it.
9. r12 measured the tree at `094f72d` (`results/r12/commit.txt`). Changes merged to `main` after
   that are not in these numbers.
10. r6's efficiency numbers divide by CPU sampled once a second, which is coarse for an app using
    a few percent of its core (Corten's 5.1% at the fixed rate); from r7 they divide by the
    counted CPU time. Requests per CPU-second, like requests a second, compare only within a round.
11. r8 has no instruction counts. r8's droplet stopped answering both times the round reached
    `count.mjs`, right after its warmup (the first time with a kernel soft lockup); the cause is not
    known, and the round finished without that step
    ([#466 Benchmark round r8 has no instruction counts: its droplet locked up twice when count.mjs started counting](https://github.com/todd-skelton/corten/issues/466)).
    r9 measured nothing (its launcher hung in its own `ssh` call before the round started), so r10's counts were compared with
    r7's (the tree at `a9b1163`), the last round before it that counted: counts do not depend on
    the droplet, but Corten changed between the two commits. r12 has none either: its droplet
    restarted while `count.mjs` ran, and the round went on from the next step
    (`results/r12/skipped.txt`). Its instructions table and the counts quoted with it are r11's
    (the tree at `512dc73`).
12. Through r11 the other apps rendered Corten's visible text with markup and stylesheets of their
    own (the stylesheets last changed on 2026-10-22, the markup on 2026-10-31 only for the plural
    counts), while Corten's item page changed in nine commits after that
    ([#642 The benchmark's other apps render Corten's item page text but not its markup or styles, which changed in nine commits since Oct 22](https://github.com/todd-skelton/corten/issues/642)).
    From r12 they render Corten's markup with its stylesheets, so their page bytes, browser times
    and server numbers are not like for like with r11's. r12, the round these tables come from, is
    the first with Corten's markup and stylesheets in every app; parity passed on 17 pages and
    `look.mjs` on 4 pages in 4 views, with no failures.
13. Build times depend on the toolchain images' versions (`rust:1-bookworm`, `node:24-bookworm-slim`
    and the rest move to their newest release) and, for dependencies, on the network and the
    package registries at the time. The rebuild keeps each tool's cache, which favors the tools
    that keep one; a Docker build without a cache mount starts each rebuild without it.

## Running it

```sh
# On a fresh droplet, created and destroyed for the run (needs doctl and an SSH key there):
node bench/fullstack/droplet.mjs r13 --ssh-key <id> [--region sfo2]   # waits for the round
node bench/fullstack/droplet.mjs r13 --ssh-key <id> --detach          # or start it and leave,
node bench/fullstack/droplet.mjs r13 --collect                        # then collect it later
# Or by hand, from the repository root: the images, the fixture, then everything.
docker build -f examples/card-market/Dockerfile -t cb-corten .
for app in nextjs tanstack-start sveltekit react-router leptos topcoat axum-maud gin drogon django rails laravel aspnet spring phoenix astro nuxt; do
  docker build -t cb-$app bench/fullstack/apps/$app
done
node bench/fullstack/fixtures/fetch.mjs http://localhost:18400   # or any {"item_1": {...}} file
cd bench/fullstack && node run-all.mjs r13 10
node check-app.mjs <app>    # before adding an app: parity, look, JSON and 404s against corten
                            # (replaces fsw-corten and fsw-<app>, removed after unless keep; needs cb-corten from this tree)
node sync-styles.mjs        # after Corten's styles change (cb-corten rebuilt and running): copy them to every app
node look.mjs [apps]        # every app's pages in Chromium against Corten's, box by box
node build.mjs r13 [apps] [runs=3]   # build cost: clean, after a one-line change, and dev builds
```
