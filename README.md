<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/corten-weathering-lockup-light.svg">
    <img src="docs/brand/corten-weathering-lockup.svg" alt="Corten" width="420">
  </picture>
</h1>

**Fast web apps: Rust on the server, plain JavaScript in the browser, and each doing the work it is fastest at.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Corten is built for [Chase Sets](https://chasesets.com).

Corten's goal is speed at the user's end. Rust renders each page on the server with `html!`, a
JSX-like Rust macro, so the first page arrives as finished HTML. In the browser, plain JavaScript
does what the page can do with what it already has (sort, filter, select, edit, total) with no
request: *handlers* are functions in a script next to a component, which its Rust markup calls
by name, and *views* are typed classes over the rows the server rendered. When the server is
needed, a small runtime swaps pages and patches forms, and live data arrives as numbered patches
over server-sent events. One request handler serves the browser, native apps and AI agents.

- **Fast on the server.** 15,103 rendered pages a second on one CPU (uncompressed, untagged),
  3.9x ASP.NET Core; of eighteen apps, level with Drogon (14,828) and behind axum + Maud (22,287),
  a router and a template macro without a framework. The most JSON responses and item-API pages
  of any (22,553 and 3,339 a second), and 1.3 MiB of memory after the first request (measured,
  [below](#performance)).
- **Light on the machine.** A page costs 66 µs of CPU (uncompressed, untagged), 3.9x less than
  ASP.NET Core's; 300 pages a second take 6.2% of one core (ASP.NET Core 26%, Leptos 26%), and
  each MiB of memory serves 894 pages a second, 11x Leptos. axum + Maud costs less on all three
  (44 µs, 3.5%, 1,376 pages per MiB), and Drogon on the last two (4.2%, 1,159) (measured,
  [below](#cpu-and-memory-per-request)).
- **Fast in the browser.** A 13.5 KB (gzip) runtime; the benchmark item page loaded 12.9 KB of
  JavaScript with a 12.2 KB runtime (gzip, measured). No WASM, no virtual DOM, no hydration: a
  script takes over 1,000 server-rendered rows in 6.0 ms, against 20-84 ms for Solid, Svelte,
  Vue, React and Remix (measured, [below](#client-heavy-screens)).
- **Typed end to end.** Routes, form fields, CSS classes, handler calls and the elements they
  take, events and messages are Rust types. TypeScript types for scripts are generated from Rust.
- **Works without JavaScript.** Links are links and forms post; scripts make a page faster and
  richer but never hold it up.
- **Production defaults.** A strict CSP, a cross-site write check, error pages, versioned
  assets, cache headers that never share one user's page with another, compression, health
  checks, graceful shutdown and an installable PWA, from `corten::serve(App::new(routes))`.
  `corten::serve` speaks HTTP/1.1, so an app with live streams (`<corten-live>`, feeds,
  `corten::event_stream`) goes behind a proxy or CDN that serves browsers HTTP/2 or HTTP/3: over
  HTTP/1.1 a browser opens about six connections to a host, and each open stream holds one
  ([Deploying](docs/guide/deploy.md)). Routes with no screen go in a
  `#[corten::routes(api = ApiRoot)]` module, `.api(api::api)`, and answer only JSON.
- **No JavaScript toolchain in the app.** One binary, with the `static/` directory compiled into it.

## Status

Corten is 0.1: usable and tested, on Rust 1.88 or later. A release publishes every crate at one
version on crates.io and attaches a prebuilt `corten` for Linux, macOS and Windows to the GitHub
release. The API will change before 1.0; [CHANGELOG.md](CHANGELOG.md) lists what changed.
The runtime and `corten-ui` are tested in Chromium, Firefox and WebKit.

## Quick start

```sh
cargo install corten-cli    # or cargo binstall corten-cli, for the prebuilt binary
corten new my-app
cd my-app
corten dev    # serves http://localhost:3000 and reloads on save
```

`corten new` writes a working app: a page, a form that patches part of the page, a
component with a script, a test and a Dockerfile. See [Getting started](docs/guide/getting-started.md).

## Example

A page with a form. With JavaScript, submitting it swaps in the greeting; without JavaScript it
posts and the whole page comes back. One handler serves both.

```rust,no_run,edition2024
use corten::prelude::*;

// Every URL, typed, with the handler that serves it. A route without one does not compile.
#[corten::routes]
mod url {
    #[route("/", get = home)]
    pub struct Home;

    #[route("/greet", post = greet)]
    pub struct Greet;
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let app = App::new(url::router());
    corten::serve(app).await
}

// The return type is what the route answers: a page, a patch or a redirect, and on failure the
// app's error page. `JsonResult<T>` answers JSON, failures included.
async fn home(req: Req) -> HtmlResult {
    req.page(home_page(&req, ""))
}

async fn greet(req: Req, Form(form): Form<GreetForm>) -> HtmlResult {
    // With JavaScript, only the greeting, swapped in by its id; without, the whole page.
    req.patch_or(Greeting { name: &form.name }, || async { req.page(home_page(&req, &form.name)) }).await
}

#[derive(serde::Deserialize, Fields)]
struct GreetForm {
    name: String,
}

fn home_page(req: &Req, name: &str) -> impl Document {
    let f = GreetForm::FIELDS;
    html! {
        <Layout req={req} title="Welcome">
            <h1>"Welcome"</h1>
            <form method="post" action={url::Greet} data-patch>
                <input name={f.name} required>
                <button>"Greet me"</button>
            </form>
            <Greeting name={name} />
        </Layout>
    }
}

/// The whole document, a component like any other: `corten new` writes one for you to change.
/// A client navigation gets only the `<title>` and `<main>`'s children.
#[component]
fn Layout(req: &Req, title: &str, children: impl Render) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()}>
            <head>
                <title>{title}</title>
                <Corten />
            </head>
            <body>
                <main>{children}</main>
            </body>
        </html>
    }
}

/// The greeting's id, a type: the page and the patch name the element the same way.
#[derive(Id)]
struct GreetingId;

/// Rendered by the page and by the patch, so the two cannot drift.
#[component]
fn Greeting(name: &str) -> impl Patch {
    html! {
        <p id={GreetingId} aria-live="polite">
            if !name.is_empty() {
                "Hello, " {name} "!"
            }
        </p>
    }
}
```

A misspelled route, field, prop or id does not compile, and neither does a route without a
handler, a patch with a top-level element the browser would drop (one without an id), or a
document without its `<title>`, `<Corten />` (where the runtime and the page's scripts go) or
`<main>`. Behavior lives in a script next to the component: plain functions the
markup calls with the elements they use.

```rust,ignore
// src/click_counter.rs
#[component(js)]
pub fn ClickCounter() -> impl Render {
    let total = refs();
    html! {
        // A click calls count() in click_counter.js with the <output>.
        <button type="button" on:click={js::count(total)}>
            "Clicks: "
            <output ref={total}>"0"</output>
        </button>
    }
}
```

```js
// src/click_counter.js
/** @param {HTMLOutputElement} total */
export function count(total) {
  total.value = String(Number(total.value) + 1);
}
```

`js::count` exists because the script exports `count`, and it takes `total` because the JSDoc
says an `HTMLOutputElement` and the ref is on an `<output>`. Either mismatch is a compile error.

## When to use it

Corten fits apps where speed at the user's end matters: stores, marketplaces, dashboards, admin
tools, rich editing screens, content with live parts. The server owns the data and decides what
a write does; the browser does everything it can with the data it already has, without a round
trip. It suits teams that want Rust on the server and the platform's own JavaScript in the
browser, with types across the seam between them.

Look elsewhere for an offline-first app whose data lives on the device (Corten's offline support
is a fallback page and cached files), for server-side TSX or React components, or for a pure
static site (a static site generator is simpler).

## Values

1. **Fast, and proven fast.** Speed at the user's end is the goal, and every claim has a measured
   number behind it. The work goes where it is fastest for the user: the server renders the first
   page and anything that needs its data, and the browser does what it can with what it already
   has. A server render that is slower than a client action is the wrong choice. A change to
   rendering, the runtime or the request path is measured before and after with the number that
   can see it: instructions per request, time, or bytes shipped
   ([CONTRIBUTING.md](CONTRIBUTING.md#pull-requests)). We say no to features that cost
   every user to help a few, like view transitions on every swap.
2. **Standards first, extended rather than replaced.** Use what the browser, HTTP and the web's
   other standards already provide: custom elements, `FormData`, `AbortSignal`, the Navigation
   API, popover, server-sent events, native validation, Problem Details, CLDR. Where Corten needs
   more, it builds on the standard (a custom element, an `Event` subclass, a `data-` attribute)
   rather than adding a concept of its own. Corten uses a custom element where the behavior is
   the element's own (`<corten-live>` holds a live connection); a component's behavior is a
   handler on whatever element fits, since a table row cannot be a custom element in every
   browser ([design Choice 17](docs/design.md#choices)). Build only what the platform lacks, and
   remove it once the platform catches up. One idea should work the same everywhere, so
   cancellation is `AbortSignal` in the browser and on the server.
3. **HTML that works on its own.** Every page's first render comes from the server, and links and
   forms work without JavaScript. Scripts make a page faster and richer but never hold it up. A
   feature only a browser can provide (drag and drop, a canvas) needs JavaScript, and the page
   around it still works.
4. **Mistakes fail at compile time.** No strings at the seams between server and client: routes,
   handler calls, refs, class names, form fields and messages are all typed. TypeScript types are
   generated from Rust, never written by hand. The app's own setup is held to the same bar: a
   route outside its area, a signed-in route whose handler does not take the caller, a public
   (cacheable) answer whose handler reads who is asking, a handler that hides what its route
   answers, or a prefix with a parameter does not build, and no route reaches the app another
   way. Where the compiler cannot see a mistake, it fails at startup, and only what depends
   on the request is checked per request. If a guarantee exists, a test proves it fails to
   compile when broken.
5. **One way to do each thing.** Behavior is a function the markup calls, cleanup has one hook,
   and a request handler serves every mode. Fewer concepts make large codebases readable for
   people and for agents. The behavior sits next to its markup, and each call names everything
   the function touches.
6. **Small surface, deliberate dependencies.** A dependency or a new concept has to clearly earn
   its place. The framework owns what nearly every app needs, like security headers,
   cancellation, error pages and assets. Domain logic and things only some apps use belong to the
   app or platform.
7. **Good defaults, easy overrides.** `corten::serve(App::new(routes))` should be production-ready.
   Every default can be replaced in one line, and the common case stays short.
8. **One server, every surface.** The same handler and data serve the browser, native apps and AI
   agents. The server is the source of truth for the data and for what a write does; the state
   of a screen (a sort, a selection, an open panel) belongs to the client showing it.
9. **Verified, not assumed.** Every runtime behavior has a browser smoke test. Reliability work,
   like failover and lost-patch counts, is benchmarked rather than argued.

When two values conflict, this order decides:

1. Correctness and reliability. Following a standard where one fits is part of being correct:
   a header or format of Corten's own in its place needs a recorded reason
   ([design rule 10](docs/design.md#rules)), and typing wraps a standard rather than replacing it.
2. Performance at the user's end.
3. Compile-time safety and one way to do things: a mistake the compiler can catch is a compile
   error, not a startup panic or a per-request check ([design rules](docs/design.md#rules)).
4. Developer convenience.

So the deadline timer that cost 640 ns per request was reworked rather than kept for
convenience, and a nicer API that slows every page loses. Every pull request is reviewed against
these values, in this order, before it merges ([CONTRIBUTING.md](CONTRIBUTING.md#review)).

## Performance

Measured on one DigitalOcean c-8 droplet (Xeon Platinum 8168) on 2026-11-05 (UTC), one run
(round r15, the tree at `ec10c8f`). The
method, every table and the caveats are in [bench/fullstack](bench/fullstack/README.md) and
[bench/browser](bench/browser/README.md).

### On the server

The same item page (listings table, offers, a form that patches) and the same item as JSON in
eighteen apps, each with its usual production settings on one CPU and 1 GiB. Requests a
second are at 64 users; "failed" means the app could not serve the fixed rate (or start) without
tuning.

| | Pages/s, no database | JSON/s, no database | Pages/s, item API | Process start to first page | Memory after first request |
|---|---|---|---|---|---|
| axum 0.8 + Maud 0.27 | 22,287 | 13,049 | 941 | 7.1 ms | 1.344 MiB |
| **Corten** | **15,103** | **22,553** | **3,339** | **7.7 ms** | **1.262 MiB** |
| Drogon 1.9 | 14,828 | 2,128 | 431 | 33 ms | 3.266 MiB |
| Topcoat 0.11 | 5,120 | 15,083 | 835 | 8.3 ms | 1.5 MiB |
| Gin 1.12 | 4,466 | 3,945 | 726 | 11 ms | 1.953 MiB |
| ASP.NET Core 10 | 3,846 | 10,780 | 1,184 | 736 ms | 30.82 MiB |
| Phoenix 1.8 | 1,309 | 1,645 | 319 | 1.5 s | 124.9 MiB |
| Leptos 0.8 | 1,276 | 12,461 | 706 | 9.3 ms | 1.492 MiB |
| Astro 7 | 1,155 | 1,902 | 427 | 350 ms | 36.26 MiB |
| Spring Boot 4.1 | 977 | 6,111 | 471 | 8.4 s | 137.6 MiB |
| SvelteKit 3 | 773 | 2,887 | 328 | 212 ms | 25.48 MiB |
| TanStack Start | 637 | 3,235 | 293 | 261 ms | 27.48 MiB |
| React Router 7 | 494 | 2,183 | 261 | 332 ms | 33.82 MiB |
| Rails 8.1 | 417 | 831 | 282 | 1.2 s | 63.88 MiB |
| Nuxt 4 | failed (311) | 6,648 | 200 | 356 ms | 37.23 MiB |
| Django 6.1 | failed (271) | 1,083 | 157 | 1.3 s | 65.75 MiB |
| Next.js 16 | failed (168) | 1,080 | failed (108) | 771 ms | 52.76 MiB |
| Laravel 13 | failed | failed | failed (84) | 960 ms | 95.39 MiB |

The load asks as `curl` does (`Accept-Encoding: identity`, no `If-None-Match`), so no app
compresses its page and Corten does not tag it (SvelteKit and Rails tag every page regardless).
A browser's request costs Corten more than the page. Measured in process on the item page,
hashing its `ETag` adds 27,700 user instructions to the 86,489 of the request the rounds send,
compressing it with zstd a further 230,000, and brotli, for a client without zstd, about 1.2
million in place of zstd's
([details](bench/fullstack/README.md#what-a-browsers-request-costs-corten-callgrind-2026-11-06)).

With the item API every request fetches and parses about 55 KB of JSON, which bounds every app.
Corten reads only the fields the page uses from that response, not a `serde_json::Value`, and
serves 2.8x ASP.NET Core's pages there (3,339 a second against 1,184) at about a fifth of its CPU
([details](bench/fullstack/README.md#cortens-item-api-path)). axum + Maud, a router and a
template macro with no framework, renders the page from memory faster than Corten (22,287 a
second against 15,103); Corten serves the most JSON (22,553 a second) and the most item-API
pages, 3.5x axum + Maud's 941. Corten's JSON route costs less than its HTML page (70,588
against 103,544 user-mode instructions a request). Against r14, the unchanged apps rose by a
median of 14.4% for the page from memory and 12.2% for JSON (excluding ASP.NET Core, whose
logging changed); Corten rose 4.4% and 24.8%. The page therefore improved less than its peers,
while the JSON route improved more. The 9.9-point page gap is just below the automation's
greater-than-10-point regression threshold.
Requests a second compare only within a round, since droplets of one size differ; instruction
counts compare across rounds. Pushing live updates
is measured in [bench/live](bench/live/README.md): at 10,000 open connections on one core, only
Corten and Leptos delivered all 100,000 messages a second.

### CPU and memory per request

Serving more is half of it; the other half is what each request costs. From the same r15 runs,
items in memory: pages per CPU-second are requests a second at 64 users over the share of its
core each app used, CPU for 300 pages a second is the fixed-rate phase, and pages a second per MiB
divide the 64-user rate by the app's peak memory under that load.

| | Pages per CPU-second | CPU for 300 pages a second | Pages a second per MiB | Peak memory, 64 users |
|---|---|---|---|---|
| axum 0.8 + Maud 0.27 | 22,814 | 3.5% | 1,376 | 16.2 MiB |
| **Corten** | **15,258** | **6.2%** | **894** | **16.9 MiB** |
| Drogon 1.9 | 14,914 | 4.2% | 1,159 | 12.8 MiB |
| Topcoat 0.11 | 5,121 | 8.7% | 328 | 15.6 MiB |
| Gin 1.12 | 4,467 | 8.7% | 185 | 24.1 MiB |
| ASP.NET Core 10 | 3,845 | 26% | 44 | 87 MiB |
| Phoenix 1.8 | 1,311 | 37% | 4.5 | 291.1 MiB |
| Leptos 0.8 | 1,276 | 26% | 80 | 15.9 MiB |
| Astro 7 | 1,155 | 33% | 8.4 | 137.6 MiB |
| Spring Boot 4.1 | 978 | 54% | 2.7 | 356.4 MiB |
| SvelteKit 3 | 773 | 44% | 5.3 | 146.5 MiB |
| TanStack Start | 638 | 54% | 3.8 | 167.9 MiB |
| React Router 7 | 494 | 67% | 3.4 | 147.3 MiB |
| Rails 8.1 | 417 | 86% | 2.9 | 142.7 MiB |
| Nuxt 4 | failed (311) | failed (73%, 196/s served) | failed (2.1) | 146.5 MiB |
| Django 6.1 | failed (271) | failed (100%, 239/s served) | failed (0.8) | 346.4 MiB |
| Next.js 16 | failed (168) | failed (94%, 136/s served) | failed (0.8) | 211.5 MiB |
| Laravel 13 | failed | failed | failed | failed |

Corten renders a page from memory with 66 µs of CPU and serves 894 pages a second per MiB. At
the fixed 300-page rate it uses 6.2% of one core; sampled CPU at 64 users is 101.7% for the page
and 99.2% for JSON, while per-CPU-second figures use the cgroup counter. From the item API,
fetching and parsing the item adds about 230 µs to a
page, 3.6 times the page itself.



### In the browser

The same item page, loaded cold in Chromium 148 from another site, median of 10 loads each. The
phone is the Lighthouse profile: 4x CPU slowdown, 150 ms round trip, 1.6 Mbps down.
"Interactive" is when the page's own code says it is ready; client navigation is the home page to
the item page. Every app ran on one core with items from the item API.

| | Phone: interactive | Phone: largest paint | Phone: client navigation | Desktop: interactive | Desktop: client navigation | JS heap | JavaScript, gzip |
|---|---|---|---|---|---|---|---|
| ASP.NET Core 10 | 450 ms | 440 ms | 247 ms | 54 ms | 17 ms | 1.7 MB | 17.0 KB |
| Django 6.1 | 454 ms | 428 ms | 247 ms | 54 ms | 23 ms | 1.7 MB | 17.0 KB |
| Drogon 1.9 | 455 ms | 436 ms | 217 ms | 54 ms | 17 ms | 1.7 MB | 17.0 KB |
| Topcoat 0.11 | 469 ms | 452 ms | 220 ms | 64 ms | 16 ms | 1.9 MB | 15.0 KB |
| **Corten** | **474 ms** | **472 ms** | **200 ms** | **61 ms** | **15 ms** | **1.6 MB** | **12.9 KB** |
| Spring Boot 4.1 | 648 ms | 488 ms | 247 ms | 67 ms | 37 ms | 1.7 MB | 17.0 KB |
| axum 0.8 + Maud 0.27 | 651 ms | 484 ms | 242 ms | 76 ms | 15 ms | 1.7 MB | 17.0 KB |
| Gin 1.12 | 651 ms | 488 ms | 243 ms | 53 ms | 16 ms | 1.7 MB | 17.0 KB |
| Astro 7 | 684 ms | 520 ms | 232 ms | 66 ms | 16 ms | 1.6 MB | 9.2 KB |
| Laravel 13 | 894 ms | 460 ms | 216 ms | 82 ms | 26 ms | 2.2 MB | 84.3 KB |
| SvelteKit 3 | 917 ms | 496 ms | 304 ms | 128 ms | 34 ms | 2.4 MB | 37.2 KB |
| Phoenix 1.8 | 963 ms | 432 ms | 137 ms | 104 ms | 18 ms | 2.3 MB | 46.2 KB |
| React Router 7 | 1,137 ms | 480 ms | 314 ms | 190 ms | 43 ms | 2.8 MB | 98.8 KB |
| Rails 8.1 | 1,197 ms | 548 ms | 259 ms | 69 ms | 26 ms | 2.1 MB | 40.9 KB |
| Next.js 16 | 1,477 ms | 432 ms | 537 ms | 169 ms | 141 ms | 3.3 MB | 136.2 KB |
| Nuxt 4 | 1,566 ms | 556 ms | 267 ms | 113 ms | 24 ms | 2.9 MB | 72.5 KB |
| Leptos 0.8 | 1,929 ms | 460 ms | 242 ms | 112 ms | 23 ms | 1.9 MB | 7.0 KB + 304 KB WASM |
| TanStack Start | 2,433 ms | 536 ms | 343 ms | 147 ms | 30 ms | 3.2 MB | 110.6 KB |

On a phone, Corten is interactive in 474 ms and on desktop in 61 ms. Its item page loads 12.9 KB of JavaScript (gzip).

### Client-heavy screens

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
small ([profile](bench/browser/README.md#creating-many-rows)).

## Documentation

| Guide | What it covers |
|---|---|
| [Getting started](docs/guide/getting-started.md) | the `corten` command and the parts of an app |
| [The app](docs/guide/app.md) | every default `App` puts around your routes, and how to replace each |
| [Deploying](docs/guide/deploy.md) | behind a proxy or CDN: what it must do, an nginx configuration, cache settings for Cloudflare and CloudFront; the release profile and what it costs |
| [Views](docs/guide/views.md) | `html!`, components, typed links and messages |
| [Requests and forms](docs/guide/requests-and-forms.md) | request modes, patches, validation, redirects |
| [Scripts](docs/guide/scripts.md) | behavior in the browser: handlers, refs, typed events, views |
| [Live data](docs/guide/live-data.md) | `<corten-live>`, feeds, running a feed across instances |
| [Cancellation](docs/guide/cancellation.md) | `AbortSignal` in the browser and on the server, deadlines |
| [Styles](docs/guide/styles.md) | a scoped CSS file per component, design tokens, themes |
| [Headless components](docs/guide/ui.md) | `corten-ui`: number field, combobox, tabs, menu button, toaster, copy button, relative time, checkbox group, required-when |
| [The UI kit](docs/guide/kit.md) | `corten ui`: theme tokens and styled components copied into the app as source |
| [Type safety](docs/guide/type-safety.md) | every seam between server and client, and how it is checked |
| [Design decisions and limits](docs/design.md) | why it is built this way, and what it does not do |
| [Surfaces](docs/architecture.md) | one server for web, native apps and agents |

API reference: `cargo doc --open -p corten`. Building an app with an AI agent? The
[corten skill](skills/corten/SKILL.md) gives it the rules and recipes.

## Crates

| Crate | What it is |
|---|---|
| [`corten`](crates/corten) | the framework, on axum: `App`, `Req`, `html!`, handlers, the browser runtime |
| [`corten-cli`](crates/corten-cli) | the `corten` command: `new`, `dev`, `check`, `build` |
| [`corten-macros`](crates/corten-macros) | the macros, on `proc_macro` alone (no `syn`) |
| [`corten-ui`](crates/corten-ui) | optional headless components for widgets the browser lacks |
| [`corten-feed`](crates/corten-feed) | live feeds: rows, numbered patches, replay, resume |
| [`corten-cluster`](crates/corten-cluster) | one feed across instances: Postgres outbox, NATS JetStream |
| [`corten-protocol`](crates/corten-protocol) | the feed wire format and a client replica, for native and agent clients |

Examples, in the order to read them. Each has a README that says how to run it and where each piece
is:

1. [watchlist](examples/watchlist): start here. A stock watchlist with live prices, market news,
   price alerts and an account, styled utility-first; each route shows one piece of Corten.
2. [card-market](examples/card-market): a card store with every production module on (security,
   PWA, i18n, caching, JSON routes for partners and agents). Read it before you deploy.
3. [seller-desk](examples/seller-desk): a client-heavy inventory screen, for when a screen does more
   in the browser than forms and links.
4. [deck-builder](examples/deck-builder): a deck builder, the rich client screen: drag and drop
   and keyboard moves, undo and redo, a chart drawn in the browser, and autosave that rolls back a
   change the server refuses and notices another tab's edit. Read it when a screen keeps state in
   the browser and saves it as the user works.
5. [auction-room](examples/auction-room): a live card auction where signed-in people bid on the
   same lots at once, with bids in SQLite, a notice only the outbid bidder sees, a per-bidder rate
   limit and a house that only it may enter. Read it when several people act on shared data in
   real time.
6. [ui-gallery](examples/ui-gallery): a seller's draft listing built from every `corten-ui`
   component and its orders, drawn by every component of the UI kit (`corten ui`).
7. [listings-feed](examples/listings-feed): a seller's listings table kept live by one feed that
   several instances serve (Postgres and NATS through `corten-cluster`), for when one instance is
   not enough; its failover benchmark kills instances while browsers follow.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the layout, the
checks and how a change is reviewed; report security issues as [SECURITY.md](SECURITY.md)
describes.

## License

[MIT](LICENSE). The kit's icons (`crates/corten-cli/kit/icon.rs`, which `corten ui add icon` copies
into an app) are [Lucide](https://lucide.dev)'s, under its ISC license and, for those derived from
Feather, Feather's MIT license; both are in that file.

## Name

Cor-ten is weathering steel: it is meant to rust, and the rust layer is what protects it. Rust
underneath, a thin protective surface on top. "COR-TEN" is a U.S. Steel trademark for steel.
