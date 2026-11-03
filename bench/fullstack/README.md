# Full-stack comparison: one marketplace item page in fifteen frameworks

The same item detail page (title, images, sorted listings table, offers with "show all", a
price-alert form that posts and patches a message), and the same item as JSON, built in:

| App | Stack | Directory |
|---|---|---|
| corten | Corten 0.1 (Rust, axum, `html!` views, handlers) | [examples/card-market](../../examples/card-market) |
| leptos | Leptos 0.8 (Rust, SSR plus WASM hydration, axum) | [apps/leptos](apps/leptos) |
| topcoat | Topcoat 0.11 (Rust, `view!` components, shards and a procedure, no WASM) | [apps/topcoat](apps/topcoat) |
| nextjs | Next.js 16.4.2, App Router, React Server Components, server action | [apps/nextjs](apps/nextjs) |
| tanstack-start | TanStack Start 1.169.3, React 19, server functions, Nitro | [apps/tanstack-start](apps/tanstack-start) |
| sveltekit | SvelteKit 3.1.0, Svelte 5.57, adapter-node 6, form action | [apps/sveltekit](apps/sveltekit) |
| react-router | React Router 7.18.4 on Express | [apps/react-router](apps/react-router) |
| astro | Astro 7.4.2, Node adapter (standalone), client router, Actions | [apps/astro](apps/astro) |
| nuxt | Nuxt 4.6.2, Vue 3.5, Nitro | [apps/nuxt](apps/nuxt) |
| aspnet | ASP.NET Core 10 Razor Pages on Kestrel, htmx | [apps/aspnet](apps/aspnet) |
| spring | Spring Boot 4.1.1, Java 25, Thymeleaf on Tomcat, htmx | [apps/spring](apps/spring) |
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
tables below are from r11, before the other apps rendered Corten's markup (caveat 12). Each app
has the same interactions: a sort (in the browser, except where the framework renders again on
the server: Phoenix's LiveView and Topcoat's shard, each a round trip), a form action that
updates part of the page, and client-side navigation from the home page, each done the framework's usual way (htmx for
Razor Pages, Spring and Django; Turbo for Rails; Livewire for Laravel; LiveView for Phoenix;
shards, signals and a procedure for Topcoat).
The Corten app also runs everything a production deployment would (CSP, CSRF check, compression,
versioned assets, service worker, error pages, health, MCP tools); the others run their framework
defaults in production mode.

The same apps hold the live-updates comparison in [bench/live](../live/README.md).

Topcoat joined after r11, so it has no rows in the tables below; the next round measures it.

## Results

All numbers are measured, from one run (`results/r11/`, 2026-11-02 UTC, the tree at `512dc73`) on one
DigitalOcean c-8 droplet (Intel Xeon Platinum 8280); see [Method](#method). Failed means the app could not do the
test with its usual settings in one CPU and 1 GiB (see caveat 5); its other numbers are kept
where it produced any. r9 measured nothing (its launcher hung in its own `ssh` call before the
round started). r10 (`results/r10/`, a Platinum 8280, Corten at `f5c76a0`, 93 commits before
r11's, before currencies were found by their numeric key), r8
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
| leptos | 6.2 ms (5.4 ms-7.8 ms) | 1.477 MiB | 127 MB |
| **corten** | 6.4 ms (4.8 ms-22 ms) | 1.234 MiB | 124 MB |
| sveltekit | 167 ms (160 ms-226 ms) | 25.33 MiB | 333 MB |
| tanstack-start | 202 ms (192 ms-236 ms) | 27.7 MiB | 332 MB |
| react-router | 278 ms (273 ms-281 ms) | 33.7 MiB | 353 MB |
| astro | 278 ms (272 ms-346 ms) | 36.31 MiB | 527 MB |
| nuxt | 286 ms (278 ms-347 ms) | 37.12 MiB | 335 MB |
| nextjs | 629 ms (618 ms-647 ms) | 52.29 MiB | 385 MB |
| aspnet | 643 ms (632 ms-698 ms) | 30.55 MiB | 342 MB |
| laravel | 725 ms (716 ms-786 ms) | 95.26 MiB | 947 MB |
| rails | 923 ms (905 ms-939 ms) | 63.88 MiB | 431 MB |
| django | 982 ms (960 ms-1.0 s) | 65.61 MiB | 276 MB |
| phoenix | 1.1 s (1.1 s-1.3 s) | 125.1 MiB | 262 MB |
| spring | 7.1 s (6.9 s-7.2 s) | 147.9 MiB | 516 MB |

### Item page, items in memory (no database)

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 300/s, 0.2 ms / 0.6 ms, 4% | 22,713, 2.3 ms / 7.3 ms | 22,788, 29 ms, 0% | 16-19 MiB |
| aspnet | 300/s, 0.5 ms / 2.0 ms, 18% | 5,153, 13 ms / 18 ms | 4,923, 87 ms, 0% | 61-71 MiB |
| phoenix | 300/s, 0.9 ms / 1.4 ms, 29% | 1,828, 35 ms / 46 ms | 1,726, 4.3 s, 0% | 288-297 MiB |
| leptos | 300/s, 0.8 ms / 1.3 ms, 20% | 1,736, 37 ms / 52 ms | 1,483, 281 ms, 0% | 16-32 MiB |
| astro | 300/s, 0.8 ms / 21 ms, 26% | 1,414, 41 ms / 98 ms | 1,382, 244 ms, 0% | 138-139 MiB |
| spring | 300/s, 0.9 ms / 3.7 ms, 40% | 1,330, 35 ms / 267 ms | 1,312, 739 ms, 0% | 353-375 MiB |
| sveltekit | 300/s, 0.9 ms / 14 ms, 32% | 1,105, 51 ms / 106 ms | 955, 303 ms, 0% | 157-161 MiB |
| tanstack-start | 300/s, 1.2 ms / 24 ms, 42% | 782, 73 ms / 133 ms | 791, 371 ms, 0% | 161-162 MiB |
| react-router | 300/s, 1.6 ms / 34 ms, 53% | 621, 95 ms / 163 ms | 613, 482 ms, 0% | 158-159 MiB |
| rails | 300/s, 1.6 ms / 23 ms, 56% | 590, 108 ms / 126 ms | 537, 549 ms, 0% | 135-141 MiB |
| django | 300/s, 2.3 ms / 4.1 ms, 74% | 415, 154 ms / 167 ms | 414, 643 ms, 0% | 345-346 MiB |
| nuxt | 300/s, 7.8 ms / 122 ms, 83% | 359, 178 ms / 224 ms | 331, 1.9 s, 0% | 141-142 MiB |
| nextjs | **failed**: 175/s served, 1.3 s / 55.4 s, 89% | 212, 313 ms / 359 ms | 204, 10.6 s, 0% | 227-228 MiB |
| laravel | **failed**: never answered /items/item_1 within a minute | - | - | - |

### The item as JSON, items in memory

| App | 300/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 300/s, 0.2 ms / 0.6 ms, 4% | 31,570, 1.8 ms / 7.1 ms | 33,694, 27 ms, 0% | 16-19 MiB |
| leptos | 300/s, 0.2 ms / 0.6 ms, 4% | 20,031, 3.5 ms / 6.5 ms | 19,705, 28 ms, 0% | 14-18 MiB |
| aspnet | 300/s, 0.3 ms / 0.8 ms, 10% | 17,101, 3.5 ms / 7.1 ms | 16,896, 28 ms, 0% | 77-81 MiB |
| spring | 300/s, 0.3 ms / 0.9 ms, 16% | 9,526, 5.2 ms / 57 ms | 8,703, 297 ms, 0% | 351-375 MiB |
| nuxt | 300/s, 0.4 ms / 0.9 ms, 10% | 9,228, 6.2 ms / 28 ms | 8,837, 65 ms, 0% | 104-110 MiB |
| tanstack-start | 300/s, 0.4 ms / 3.1 ms, 12% | 4,123, 13 ms / 39 ms | 3,884, 106 ms, 0% | 137-140 MiB |
| sveltekit | 300/s, 0.4 ms / 2.3 ms, 12% | 3,846, 14 ms / 42 ms | 3,714, 115 ms, 0% | 130-133 MiB |
| phoenix | 300/s, 0.6 ms / 1.2 ms, 21% | 3,113, 20 ms / 30 ms | 2,963, 3.1 s, 0% | 281-329 MiB |
| react-router | 300/s, 0.6 ms / 1.4 ms, 16% | 2,664, 22 ms / 61 ms | 2,631, 161 ms, 0% | 126-128 MiB |
| astro | 300/s, 0.6 ms / 16 ms, 19% | 2,338, 24 ms / 61 ms | 2,265, 161 ms, 0% | 138-140 MiB |
| django | 300/s, 0.6 ms / 1.1 ms, 23% | 1,493, 43 ms / 53 ms | 1,506, 198 ms, 0% | 294-294 MiB |
| nextjs | 300/s, 0.8 ms / 22 ms, 28% | 1,234, 47 ms / 105 ms | 1,239, 275 ms, 0% | 170-171 MiB |
| rails | 300/s, 0.9 ms / 5.8 ms, 30% | 1,168, 54 ms / 70 ms | 1,207, 254 ms, 0% | 126-129 MiB |
| laravel | **failed**: never answered /api/items/item_1 within a minute | - | - | - |

### Item page, item fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 0.6 ms / 1.2 ms, 5% | 4,605, 13 ms / 20 ms | 4,127, 94 ms, 0% | 16-61 MiB |
| aspnet | 150/s, 1.3 ms / 5.8 ms, 26% | 1,409, 45 ms / 65 ms | 1,248, 255 ms, 0% | 70-100 MiB |
| leptos | 150/s, 1.5 ms / 2.0 ms, 18% | 921, 71 ms / 84 ms | 830, 408 ms, 0% | 16-57 MiB |
| spring | 150/s, 1.9 ms / 5.8 ms, 48% | 615, 102 ms / 185 ms | 474, 1.1 s, 0% | 426-456 MiB |
| astro | 150/s, 1.7 ms / 26 ms, 33% | 533, 123 ms / 150 ms | 498, 620 ms, 0% | 135-149 MiB |
| phoenix | 150/s, 2.4 ms / 3.1 ms, 38% | 505, 126 ms / 164 ms | 490, 6.2 s, 0% | 225-307 MiB |
| sveltekit | 150/s, 1.8 ms / 16 ms, 34% | 463, 139 ms / 170 ms | 455, 647 ms, 0% | 152-164 MiB |
| rails | 150/s, 2.5 ms / 24 ms, 42% | 442, 144 ms / 162 ms | 391, 710 ms, 0% | 108-111 MiB |
| tanstack-start | 150/s, 2.2 ms / 24 ms, 41% | 404, 162 ms / 194 ms | 370, 797 ms, 0% | 151-176 MiB |
| react-router | 150/s, 2.6 ms / 30 ms, 47% | 342, 191 ms / 221 ms | 347, 928 ms, 0% | 145-155 MiB |
| django | 150/s, 4.1 ms / 5.1 ms, 61% | 249, 256 ms / 276 ms | 250, 1.1 s, 0% | 126-127 MiB |
| nuxt | 150/s, 3.3 ms / 69 ms, 62% | 235, 271 ms / 298 ms | 234, 7.5 s, 0% | 139-189 MiB |
| nextjs | **failed**: 124/s served, 2.3 s / 39.8 s, 100% | 142, 447 ms / 510 ms | 133, 2.5 s, 0% | 291-301 MiB |
| laravel | **failed**: 132/s served, 3.7 s / 4.6 s, 99% | 135, 449 ms / 605 ms | 135, 2.5 s, 0% | 113-125 MiB |

### The item as JSON, fetched from the item API

| App | 150/s offered: served, p50 / p99, CPU | 64 users: req/s, p50 / p99 | 256 users: req/s, p99, errors | Memory under load |
|---|---|---|---|---|
| **corten** | 150/s, 0.6 ms / 1.2 ms, 5% | 4,873, 13 ms / 19 ms | 4,171, 118 ms, 0% | 16-62 MiB |
| aspnet | 150/s, 1.0 ms / 4.3 ms, 20% | 2,089, 30 ms / 44 ms | 1,976, 166 ms, 0% | 59-86 MiB |
| leptos | 150/s, 1.1 ms / 1.6 ms, 12% | 1,409, 45 ms / 55 ms | 1,281, 278 ms, 0% | 15-56 MiB |
| spring | 150/s, 1.2 ms / 4.7 ms, 34% | 1,167, 50 ms / 119 ms | 872, 563 ms, 0% | 394-452 MiB |
| nuxt | 150/s, 1.2 ms / 13 ms, 22% | 902, 71 ms / 110 ms | 813, 460 ms, 0% | 125-144 MiB |
| sveltekit | 150/s, 1.3 ms / 12 ms, 24% | 848, 77 ms / 100 ms | 737, 409 ms, 0% | 127-150 MiB |
| tanstack-start | 150/s, 1.3 ms / 13 ms, 24% | 801, 84 ms / 105 ms | 669, 444 ms, 0% | 124-145 MiB |
| react-router | 150/s, 1.5 ms / 22 ms, 28% | 698, 96 ms / 118 ms | 618, 492 ms, 0% | 125-145 MiB |
| astro | 150/s, 1.5 ms / 23 ms, 30% | 667, 99 ms / 117 ms | 597, 515 ms, 0% | 124-147 MiB |
| rails | 150/s, 1.7 ms / 13 ms, 28% | 594, 103 ms / 144 ms | 578, 501 ms, 0% | 83-85 MiB |
| phoenix | 150/s, 2.2 ms / 2.9 ms, 34% | 580, 109 ms / 145 ms | 585, 5.3 s, 0% | 216-337 MiB |
| django | 150/s, 2.4 ms / 3.0 ms, 36% | 446, 143 ms / 152 ms | 443, 604 ms, 0% | 75-75 MiB |
| nextjs | 150/s, 1.8 ms / 36 ms, 35% | 435, 154 ms / 186 ms | 385, 771 ms, 0% | 159-191 MiB |
| laravel | 150/s, 3.1 ms / 6.7 ms, 48% | 328, 176 ms / 269 ms | 325, 1.0 s, 0% | 102-118 MiB |

### Instructions per request

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
| **corten** | 23,211 / 4,606 | 33,174 / 4,874 | 4.1% | 1,368 | 16.6 MiB |
| aspnet | 5,159 / 1,411 | 17,125 / 2,095 | 18% | 61 | 84.9 MiB |
| phoenix | 1,829 / 505 | 3,122 / 580 | 29% | 6.3 | 288.9 MiB |
| leptos | 1,736 / 921 | 20,182 / 1,410 | 20% | 107 | 16.2 MiB |
| astro | 1,414 / 532 | 2,338 / 667 | 26% | 10 | 138.5 MiB |
| spring | 1,331 / 615 | 9,537 / 1,167 | 40% | 3.8 | 353.4 MiB |
| sveltekit | 1,105 / 463 | 3,846 / 848 | 32% | 7.0 | 157.7 MiB |
| tanstack-start | 782 / 404 | 4,122 / 801 | 42% | 4.8 | 161.7 MiB |
| react-router | 621 / 342 | 2,665 / 698 | 53% | 3.9 | 158.4 MiB |
| rails | 590 / 442 | 1,168 / 595 | 56% | 4.1 | 142.4 MiB |
| django | 415 / 249 | 1,497 / 446 | 74% | 1.2 | 345.7 MiB |
| nuxt | 359 / 235 | 9,229 / 902 | 83% | 2.5 | 142 MiB |
| nextjs | failed (213) / failed (143) | 1,235 / 435 | failed (89%, 175/s served) | failed (0.9) | 227.2 MiB |
| laravel | **failed** / failed (137) | **failed** / 332 | **failed** | **failed** | **failed** |

Corten renders a page from memory with 43 µs of CPU (23,211 per CPU-second), 4.5x ASP.NET Core
(194 µs) and 13x Leptos (576 µs), and its JSON with 30 µs, against Leptos's 50 and ASP.NET Core's
58. At 300 pages a second it used 4.1% of its core, ASP.NET Core 18% and Leptos 20%; that is 7,325
pages per CPU-second, about a third of its rate at 64 users, since at a low rate each request
also pays for waking the server. It serves 1,368 pages a second per MiB: 13x Leptos (107), which
peaks lower (16.2 MiB against 16.6) but serves a thirteenth of the pages, and 23x ASP.NET Core (61).
From the item API, fetching and parsing the 55 KB item costs Corten about 170 µs a page, 4.0 times
the page itself
([#166 Corten's item-API path spends six times as long fetching and parsing the item as rendering it, and the single-process item API could soon cap it](https://github.com/todd-skelton/corten/issues/166)).
Corten's pages per CPU-second from memory fell 5.1% from r10 to r11, on the same CPU model; the
median of the other apps that passed rose 6.8% (from +3.5% to +14.5%).

In r11 Corten's core was 101% busy at 64 users for the page from memory and 97% for the JSON: the
load generator, which from r7 also gets the item API's two cores (idle with items in memory), kept
it busy. Every one of Corten's phases has its CPU time read from the container's cgroup counter
rather than from once-a-second samples (`cpu-time.mjs`; `cpuCounted` in `summary.json`), and the
item API used 46-51% of one core at 64 users (48% at 256), of the 200% its two processes can
use, in Corten's item-API phases.

### Bytes the item page loads (raw / gzip, KB)

| App | HTML | JavaScript (files) | WASM | CSS |
|---|---|---|---|---|
| astro | 9.3 / 2.6 | 24.9 / 9.2 (3) | 0 | 0.0 / 0.0 |
| **corten** | 11.2 / 2.3 | 28.3 / 10.6 (4) | 0 | 8.9 / 2.7 |
| django | 7.3 / 1.8 | 51.7 / 17.0 (2) | 0 | 2.3 / 0.9 |
| aspnet | 7.3 / 1.9 | 51.7 / 17.0 (2) | 0 | 2.3 / 0.9 |
| spring | 7.2 / 1.8 | 51.7 / 17.0 (2) | 0 | 2.3 / 0.9 |
| sveltekit | 16.3 / 3.6 | 96.4 / 37.1 (11) | 0 | 1.9 / 0.8 |
| rails | 8.5 / 2.2 | 152.2 / 40.6 (7) | 0 | 2.3 / 0.9 |
| phoenix | 10.0 / 2.4 | 149.2 / 46.2 (1) | 0 | 2.3 / 0.9 |
| nuxt | 17.3 / 4.5 | 197.4 / 73.8 (4) | 0 | 1.9 / 0.8 |
| laravel | 10.8 / 2.8 | 255.8 / 84.3 (1) | 0 | 2.3 / 0.9 |
| react-router | 19.5 / 4.9 | 309.8 / 98.7 (4) | 0 | 1.9 / 0.8 |
| tanstack-start | 17.2 / 4.2 | 342.3 / 109.7 (3) | 0 | 1.9 / 0.8 |
| nextjs | 25.3 / 4.8 | 456.2 / 136.1 (7) | 0 | 1.9 / 0.8 |
| leptos | 18.1 / 3.6 | 25.1 / 7.0 (1) | 723.1 / 287.6 | 2.0 / 0.8 |

### Browser, median of 10 (p90)

| App | Interactive | LCP | Blocking time | Form action | Client navigation | JS heap |
|---|---|---|---|---|---|---|
| Desktop | | | | | | |
| django | 36 (40) ms | 56 ms | 0 ms | 75 ms | 17 (18) ms | 1.7 MB |
| aspnet | 37 (39) ms | 56 ms | 0 ms | 74 ms | 14 (15) ms | 1.7 MB |
| astro | 42 (45) ms | 52 ms | 0 ms | 75 ms | 14 (14) ms | 1.6 MB |
| **corten** | 47 (55) ms | 60 ms | 0 ms | 74 ms | 11 (11) ms | 1.6 MB |
| spring | 49 (55) ms | 56 ms | 0 ms | 75 ms | 30 (35) ms | 1.7 MB |
| rails | 50 (56) ms | 56 ms | 0 ms | 89 ms | 23 (29) ms | 2.1 MB |
| laravel | 59 (62) ms | 52 ms | 0 ms | 74 ms | 20 (22) ms | 2.2 MB |
| phoenix | 78 (86) ms | 68 ms | 0 ms | 77 ms | 14 (14) ms | 2.3 MB |
| leptos | 85 (89) ms | 56 ms | 0 ms | 74 ms | 20 (21) ms | 1.9 MB |
| nuxt | 87 (94) ms | 56 ms | 0 ms | 72 ms | 21 (22) ms | 2.9 MB |
| sveltekit | 95 (98) ms | 64 ms | 0 ms | 74 ms | 27 (28) ms | 2.3 MB |
| tanstack-start | 104 (112) ms | 56 ms | 0 ms | 71 ms | 23 (24) ms | 3.1 MB |
| nextjs | 130 (135) ms | 60 ms | 0 ms | 72 ms | 78 (105) ms | 3.4 MB |
| react-router | 148 (154) ms | 84 ms | 0 ms | 70 ms | 35 (36) ms | 2.7 MB |
| Mobile (4x CPU, 150 ms RTT, 1.6 Mbps) | | | | | | |
| aspnet | 423 (425) ms | 388 ms | 0 ms | 273 ms | 235 (238) ms | 1.7 MB |
| django | 431 (433) ms | 396 ms | 0 ms | 267 ms | 235 (239) ms | 1.7 MB |
| **corten** | 460 (469) ms | 460 ms | 4 ms | 264 ms | 193 (197) ms | 1.6 MB |
| spring | 604 (606) ms | 404 ms | 0 ms | 272 ms | 234 (236) ms | 1.7 MB |
| astro | 606 (617) ms | 244 ms | 0 ms | 285 ms | 235 (239) ms | 1.6 MB |
| laravel | 865 (870) ms | 420 ms | 3 ms | 296 ms | 208 (210) ms | 2.2 MB |
| sveltekit | 872 (880) ms | 452 ms | 0 ms | 255 ms | 277 (284) ms | 2.3 MB |
| phoenix | 911 (930) ms | 400 ms | 19 ms | 115 ms | 116 (117) ms | 2.3 MB |
| react-router | 1,033 (1,040) ms | 408 ms | 15 ms | 301 ms | 283 (285) ms | 2.8 MB |
| rails | 1,142 (1,144) ms | 420 ms | 0 ms | 275 ms | 243 (245) ms | 2.1 MB |
| nextjs | 1,368 (1,382) ms | 388 ms | 111 ms | 281 ms | 477 (484) ms | 3.3 MB |
| nuxt | 1,497 (1,507) ms | 416 ms | 82 ms | 249 ms | 262 (309) ms | 2.9 MB |
| leptos | 1,815 (1,825) ms | 396 ms | 44 ms | 269 ms | 233 (242) ms | 1.9 MB |
| tanstack-start | 2,328 (2,344) ms | 408 ms | 108 ms | 271 ms | 335 (338) ms | 3.1 MB |

### What the numbers say

1. Rendering from memory: Corten serves 22,713 item pages a second at 64 users, 4.4x ASP.NET
   Core (5,153), the next fastest, and 13x Leptos (1,736). A page costs it 107,287 user-mode
   instructions; ASP.NET Core 1.08 million, Leptos 2.7 million, Next.js 17 million.
2. JSON from memory: Corten leads with 31,570 a second, then Leptos (20,031) and ASP.NET Core
   (17,101). Corten's JSON costs 69,655 user-mode instructions, a third of Leptos's (204,234) and
   less than its own HTML page.
3. With the item API every request fetches and parses about 55 KB of JSON, and that dominates.
   Corten parses only the fields the page reads (see below) and serves 4,605 pages a second,
   3.3x ASP.NET Core (1,409) and 5.0x Leptos (921); the rest that passed serve 235-615. As JSON from the item
   API: Corten 4,873, ASP.NET Core 2,089, Leptos 1,409. At 150 a second Corten's page used 5.4% of
   its core, ASP.NET Core's 26%.
4. Failed: Next.js could not serve 300 pages a second from memory (175, p99 55.4 s) or 150 from
   the item API (124). Laravel did not start for the in-memory runs: each Octane worker loads the
   508 items into PHP arrays, which PHP's default `memory_limit` (128 MB) does not allow; with the
   item API it served 132 of 150 pages a second (5.05% never sent) and kept up with the JSON. Nuxt
   passed the in-memory page test at 83% CPU (p50 7.8 ms, p99 122 ms), and Django at 74%.
5. Cold start: Leptos and Corten answer 6.2 ms and 6.4 ms after their process starts and hold
   1.5 MiB and 1.2 MiB after the first request. The Node frameworks take 167-629 ms and
   25-52 MiB; Spring Boot 7.1 s and 148 MiB.
6. Browser: on desktop the server-rendered apps with small scripts (Django, ASP.NET Core, Astro,
   Corten, Spring, Rails) are interactive in 36-50 ms. On the throttled phone Corten is
   interactive in 460 ms, with the htmx apps (423-431 ms), against 1,368 ms for Next.js,
   1,815 ms for Leptos (WASM) and 2,328 ms for TanStack Start. Corten's client navigation is the
   fastest on desktop (11 ms); on the phone Phoenix's is (116 ms against 193 ms), over its
   already-open LiveView socket. Corten's item page loads 10.6 KB of JavaScript (gzip) in four
   files, as in r10, more than Astro's 9.2 KB.

r11 and r10 both ran on a Platinum 8280. Between them Corten moved 93 commits and the other apps
did not change. Medians below are over the other apps that passed the test in both rounds. The
other apps' 64-user requests a second rose by a median of 6.8% for the page from memory, 9.2% for
the JSON from memory, 12.3% for the item-API page and 16.1% for the item-API JSON. Corten's
item-API page rose 7.5% (4,283 to 4,605), less than any other app that passed (+8.9% to +21.1%),
and its item-API JSON rose 16.3% (4,191 to 4,873), with the others. From memory
it got worse: its page fell 5.0% (23,898 to 22,713) and its JSON 1.8% (32,155 to 31,570), 11.8
and 11.0 points behind the other apps, and its pages per CPU-second from memory fell 5.1% (24,459
to 23,211; the other apps' median +6.8%). Its instruction counts went the other way: the page
fell 2.6% (110,172 to 107,287; kernel 32,989 to 32,427) and the JSON 0.4% (69,968 to 69,655), while
the other apps' moved by a median of -0.2% and -0.3%. So each page ran fewer instructions in more
CPU time. Corten's pages per CPU-second fell while every other app that passed rose (+3.5% to
+14.5%); one run of each cannot say why. Its cold start rose from 5.9 to 6.4 ms
while the others' median fell 8.1%. Its item page's bytes did not change (JavaScript 10,844, CSS
2,742 and HTML 2,387 bytes gzip), and its memory after the first request (1.223 to 1.234 MiB) and
peak memory at 64 users (16.4 to 16.6 MiB) held. In the browser Corten's desktop interactive went
from 59 to 47 ms and its phone from 459 to 460 ms, while the other apps moved by a median of
-13.5% and -0.5%. Counts compare across rounds, and requests a second only within one.

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

Instructions are `count.mjs ... api`, median of 3 x 5,000 requests. r11, on a Platinum 8280 like
r10's, serves 4,605 item-API pages a second against ASP.NET Core's 1,409 (3.3x; 2.3x in the A/B
and in r4, 3.2x in r5, 3.1x in r6 and r7, 3.4x in r8 and r10), at 5.4% of its core at 150 a second
against 26%.

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
   8280 at 2.7 GHz in r11, 16 GB), Ubuntu 24.04, kernel 6.8, Docker 29.9, Node 24, created for the run
   and destroyed after it (`droplet.mjs`). The round runs on the droplet by itself, as a systemd
   unit (`corten-bench-<round>`), so it does not need the machine that started it:
   `droplet.mjs --detach` starts it and leaves, and `droplet.mjs <round> --collect` later
   downloads the results and destroys the droplet once the round has ended (or says where it is).
   On the droplet, `run-all.mjs --unattended` gives each call a time limit (at least twice the
   longest it took in r5-r8) and stops one that runs past it or prints nothing for an hour. A kernel
   lockup (r8's) panics the kernel, which reboots the droplet; the unit starts again at boot and
   the round goes on from the next step. A droplet that does not answer for 15 minutes while
   `droplet.mjs` waits or collects is power-cycled, with the same effect (the full comparison
   only; `--collect` gives up, leaving the droplet, only when DigitalOcean cannot be reached
   either). Either way the step it
   was in is skipped (the full comparison only: `--suite live` and `--suite browser` start no
   further), named in `run.log` and in `summary.json` (`skipped`), and its results are partly or
   wholly missing from the round. A round that stops short keeps what it measured, and the
   droplet is destroyed only after its results are downloaded. Droplets of one size are
   not all the same CPU (r1's, r4's, r5's and r8's were a Platinum 8168, r2's, r3's, r6's,
   r7's, r10's and r11's a Platinum 8280), so times are compared within a round, never across rounds.
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
   rendered pages.
6. The images include the live benchmark's routes (`/live/...`), which the item page does not
   touch.
7. Laravel ran with PHP's default `memory_limit` throughout r3 to r11. (r2's main run had raised it
   to 512 MB and measured Laravel again with the default afterwards; `results/r2/laravel-rerun.log`.)
8. r4's droplet had a slower CPU than r3's (Platinum 8168 against 8280). Django and Nuxt, which
   passed r3's in-memory page test near their limit, failed it on r4's; their settings did not
   change. r3's numbers stay in `results/r3/`. In r5, on the same CPU model as r4, Django passed
   it again (4.1% never sent) and Nuxt did not; in r6 and r7, on a Platinum 8280, both passed, and in
   r8, on a Platinum 8168 again, both passed (Nuxt with 1.73% never sent), as they did in r10 and r11,
   on a Platinum 8280.
9. r11 measured the tree at `512dc73` (`results/r11/commit.txt`). Changes merged to `main` after
   that are not in these numbers.
10. r6's efficiency numbers divide by CPU sampled once a second, which is coarse for an app using
    a few percent of its core (Corten's 4.1% at the fixed rate); from r7 they divide by the
    counted CPU time. Requests per CPU-second, like requests a second, compare only within a round.
11. r8 has no instruction counts. r8's droplet stopped answering both times the round reached
    `count.mjs`, right after its warmup (the first time with a kernel soft lockup); the cause is not
    known, and the round finished without that step
    ([#466 Benchmark round r8 has no instruction counts: its droplet locked up twice when count.mjs started counting](https://github.com/todd-skelton/corten/issues/466)).
    r9 measured nothing (its launcher hung in its own `ssh` call before the round started), so r10's counts were compared with
    r7's (the tree at `a9b1163`), the last round before it that counted: counts do not depend on
    the droplet, but Corten changed between the two commits.
12. Through r11 the other apps rendered Corten's visible text with markup and stylesheets of their
    own (the stylesheets last changed on 2026-10-22, the markup on 2026-10-31 only for the plural
    counts), while Corten's item page changed in nine commits after that
    ([#642 The benchmark's other apps render Corten's item page text but not its markup or styles, which changed in nine commits since Oct 22](https://github.com/todd-skelton/corten/issues/642)).
    From r12 they render Corten's markup with its stylesheets, so their page bytes, browser times
    and server numbers are not like for like with r11's, the round these tables come from.

## Running it

```sh
# On a fresh droplet, created and destroyed for the run (needs doctl and an SSH key there):
node bench/fullstack/droplet.mjs r12 --ssh-key <id> [--region sfo2]   # waits for the round
node bench/fullstack/droplet.mjs r12 --ssh-key <id> --detach          # or start it and leave,
node bench/fullstack/droplet.mjs r12 --collect                        # then collect it later
# Or by hand, from the repository root: the images, the fixture, then everything.
docker build -f examples/card-market/Dockerfile -t cb-corten .
for app in nextjs tanstack-start sveltekit react-router leptos topcoat django rails laravel aspnet spring phoenix astro nuxt; do
  docker build -t cb-$app bench/fullstack/apps/$app
done
node bench/fullstack/fixtures/fetch.mjs http://localhost:18400   # or any {"item_1": {...}} file
cd bench/fullstack && node run-all.mjs r12 10
node check-app.mjs <app>    # before adding an app: parity, look, JSON and 404s against corten
                            # (replaces fsw-corten and fsw-<app>, removed after unless keep; needs cb-corten from this tree)
node sync-styles.mjs        # after Corten's styles change (cb-corten rebuilt and running): copy them to every app
node look.mjs [apps]        # every app's pages in Chromium against Corten's, box by box
```
