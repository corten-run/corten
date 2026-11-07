<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/corten-weathering-lockup-light.svg">
    <img src="docs/brand/corten-weathering-lockup.svg" alt="Corten" width="420">
  </picture>
</h1>

**Fast web apps: Rust on the server, plain JavaScript in the browser, and each doing the work it is fastest at.**

[![CI](https://github.com/corten-run/corten/actions/workflows/ci.yml/badge.svg)](https://github.com/corten-run/corten/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Rust 1.88+](https://img.shields.io/badge/rust-1.88%2B-orange.svg)](Cargo.toml)

[Getting started](docs/guide/getting-started.md) |
[Guides](#documentation) |
[Examples](#examples) |
[Performance](docs/performance.md) |
[Changelog](CHANGELOG.md)

Corten is a Rust web framework for apps where speed at the user's end matters. The server
renders every page as finished HTML with `html!`, a JSX-like macro. In the browser, plain
JavaScript next to each component does what the page can do with the data it already has, with
no request. When the server is needed, a small runtime swaps pages and patches part of one, and
live data streams in over server-sent events. One handler answers the browser, native apps and
AI agents.

## Highlights

- **HTML that works on its own.** Every page arrives rendered. Links are links and forms post,
  so a page works before its scripts load, and without them.
- **Plain JavaScript where it is fastest.** Behavior is a function in a script next to its
  component, called from the markup by name. No WASM, no virtual DOM, no hydration.
  A 14.5 KB (gzip) runtime.
- **Partial updates from the same handler.** A form marked `data-patch` gets back only the
  elements that changed; without JavaScript the same handler answers with the whole page.
- **Live data.** `<corten-live>` fragments and keyed feeds stream numbered patches over
  server-sent events, with replay and resume, and one feed can run across several instances.
- **Typed end to end.** Routes, form fields, element ids, CSS classes, handler calls, events and
  messages are Rust types, and the TypeScript types for scripts are generated from Rust. A typo
  at these seams fails the build, `corten check` or startup, before any request.
- **One server, every surface.** The same handler answers a browser with HTML, a native app
  with JSON, and an AI agent as a Model Context Protocol tool.
- **Production defaults.** A strict CSP, a cross-site write check, error pages, versioned
  assets, cache headers that never share one user's page with another, compression, health
  checks, graceful shutdown and an installable PWA, from `corten::serve(App::new(routes))`.
- **One binary.** No JavaScript build step or bundler in the app; `static/` is compiled into the
  program.

## Quick start

```sh
cargo install corten-cli    # or cargo binstall corten-cli, for the prebuilt binary
npm install --global typescript    # needs Node.js; corten check type-checks the app's scripts with it
corten new my-app
cd my-app
corten dev    # serves http://localhost:3000 and reloads on save
```

`corten new` writes a working app: a page, a form that patches part of the page, a component
with a script, a test and a Dockerfile. [Getting started](docs/guide/getting-started.md) walks
through it.

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

#[derive(Fields)]
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

## How it works

1. **The server renders.** Each route is a typed struct with its handler. The handler returns
   a page, a patch or a redirect, written with `html!` and components
   ([Views](docs/guide/views.md), [Requests and forms](docs/guide/requests-and-forms.md)).
2. **The browser acts on what it has.** Sorting, filtering, selecting, totals and editing run
   in plain JavaScript functions next to their components; views are typed classes over the
   rows the server rendered, so taking over a page reads it instead of rebuilding it
   ([Scripts](docs/guide/scripts.md)).
3. **The runtime fills the gaps.** Links swap the page's content, forms patch the elements
   that changed, and `AbortSignal` cancels work in the browser and on the server alike
   ([Cancellation](docs/guide/cancellation.md)).
4. **Live data is patches.** `<corten-live>` redraws a fragment and feeds keep keyed rows in
   step, both over server-sent events that resume where they left off
   ([Live data](docs/guide/live-data.md)).
5. **Every client uses the same routes.** A screen answers a request for JSON with its data,
   actions are the same `POST`s, and `corten-protocol` gives native and agent clients the feed
   ([Surfaces](docs/architecture.md)).

## Performance

Every claim about speed has a measured number behind it. The first five rows are one marketplace
item page served by eighteen apps on one CPU each (round r16), with requests sent uncompressed
and untagged, as `curl` sends them; a browser's request costs Corten more. The last row is a
client-heavy table in the browser (round browser-3, on an older, smaller runtime than today's).

| What | Corten, measured |
|---|---|
| Item pages rendered from memory | 20,705 a second, 47 µs of CPU each |
| The same item as JSON | 26,385 a second |
| Memory after the first request | 1.3 MiB |
| JavaScript the item page loaded | 14.1 KB (gzip) |
| Interactive on a throttled phone, on desktop | 468 ms, 59 ms |
| Taking over 1,000 server-rendered rows | 6.0 ms, 101 bytes of memory per row |

Of the eighteen apps, only axum + Maud renders the page from memory faster, and Corten serves
the most JSON and item-API pages. The tables against ASP.NET Core, Next.js, Leptos, Rails and
the rest, what a browser's request adds, the method and the caveats are in
[Performance](docs/performance.md).

## When to use it

Corten fits apps where speed at the user's end matters: stores, marketplaces, dashboards, admin
tools, rich editing screens, content with live parts. The server owns the data and decides what
a write does; the browser does everything it can with the data it already has. It suits teams
that want Rust on the server and the platform's own JavaScript in the browser, with types across
the seam between them.

Look elsewhere for an offline-first app whose data lives on the device (Corten's offline support
is a fallback page and cached files), for server-side TSX or React components, or for a pure
static site (a static site generator is simpler).

## Documentation

| Guide | What it covers |
|---|---|
| [Getting started](docs/guide/getting-started.md) | the `corten` command and the parts of an app |
| [Views](docs/guide/views.md) | `html!`, components, typed links and messages |
| [Requests and forms](docs/guide/requests-and-forms.md) | request modes, patches, validation, redirects |
| [Scripts](docs/guide/scripts.md) | behavior in the browser: handlers, refs, typed events, views |
| [Styles](docs/guide/styles.md) | a scoped CSS file per component, design tokens, themes |
| [Live data](docs/guide/live-data.md) | `<corten-live>`, feeds, running a feed across instances |
| [Cancellation](docs/guide/cancellation.md) | `AbortSignal` in the browser and on the server, deadlines |
| [Type safety](docs/guide/type-safety.md) | every seam between server and client, and how it is checked |
| [The app](docs/guide/app.md) | every default `App` puts around your routes, and how to replace each |
| [Headless components](docs/guide/ui.md) | `corten-ui`: number field, combobox, tabs, menu button, toaster, copy button, relative time, checkbox group, required-when |
| [The UI kit](docs/guide/kit.md) | `corten ui`: theme tokens and styled components copied into the app as source |
| [Deploying](docs/guide/deploy.md) | behind a proxy or CDN: what it must do, an nginx configuration, cache settings for Cloudflare and CloudFront; the release profile and what it costs |
| [Surfaces](docs/architecture.md) | one server for web, native apps and agents |
| [Design decisions and limits](docs/design.md) | why it is built this way, and what it does not do |
| [Performance](docs/performance.md) | every benchmark table, against seventeen other apps and five client frameworks |

API reference: `cargo doc --open -p corten-run`. Building an app with an AI agent? The
[corten skill](skills/corten/SKILL.md) gives it the rules and recipes.

## Examples

In the order to read them; each README says how to run it and where each piece is.

1. [watchlist](examples/watchlist): start here. A stock watchlist with live prices, news, price
   alerts and an account; each route shows one piece of Corten.
2. [card-market](examples/card-market): a card store with every production module on (security,
   PWA, i18n, caching, JSON routes for partners and agents). Read it before you deploy.
3. [seller-desk](examples/seller-desk): a client-heavy inventory screen, for a screen that does
   more in the browser than forms and links.
4. [deck-builder](examples/deck-builder): drag and drop and keyboard moves, undo and redo, a
   chart drawn in the browser, and autosave that rolls back a change the server refuses. Read it
   when a screen keeps state in the browser and saves it as the user works.
5. [auction-room](examples/auction-room): a live auction where signed-in people bid on the same
   lots at once, with SQLite, per-bidder notices and rate limits. Read it when several people
   act on shared data in real time.
6. [ui-gallery](examples/ui-gallery): every `corten-ui` component and every UI kit component.
7. [listings-feed](examples/listings-feed): one live feed served by several instances through
   Postgres and NATS, for when one instance is not enough, with a failover benchmark that kills
   instances while browsers follow.

## Crates

| Crate | What it is |
|---|---|
| [`corten-run`](crates/corten) | the framework, on axum, whose library is `corten`: `App`, `Req`, `html!`, handlers, the browser runtime |
| [`corten-cli`](crates/corten-cli) | the `corten` command: `new`, `dev`, `check`, `build` |
| [`corten-macros`](crates/corten-macros) | the macros, on `proc_macro` alone (no `syn`) |
| [`corten-ui`](crates/corten-ui) | optional headless components for widgets the browser lacks |
| [`corten-feed`](crates/corten-feed) | live feeds: rows, numbered patches, replay, resume |
| [`corten-cluster`](crates/corten-cluster) | one feed across instances: Postgres outbox, NATS JetStream |
| [`corten-protocol`](crates/corten-protocol) | the feed wire format and a client replica, for native and agent clients |

## Status

Corten is 0.1: usable and tested, on Rust 1.88 or later, and built for
[Chase Sets](https://chasesets.com). The API will change before 1.0; [CHANGELOG.md](CHANGELOG.md)
lists what changed. A release publishes every crate at one version on crates.io and attaches a
prebuilt `corten` for Linux, macOS and Windows to the GitHub release. The framework's package is
`corten-run` (`corten` on crates.io is someone else's) and its library is `corten`, so an app
depends on `corten = { package = "corten-run", version = ".." }` (`corten new` writes it) and its
code writes `use corten::...`. The runtime and `corten-ui` are tested in Chromium, Firefox and
WebKit. `corten::serve` speaks HTTP/1.1, so an app with live streams goes behind a proxy or CDN
that serves browsers HTTP/2 or HTTP/3 ([Deploying](docs/guide/deploy.md)).

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
   browser ([design Choice 17](docs/design.md#choice-handler-on-any-element)). Build only what the platform lacks, and
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
   ([design rule 10](docs/design.md#rule-standard-formats)), and typing wraps a standard rather than replacing it.
2. Performance at the user's end.
3. Compile-time safety and one way to do things: a mistake the compiler can catch is a compile
   error, not a startup panic or a per-request check ([design rules](docs/design.md#rules)).
4. Developer convenience.

So the deadline timer that cost 640 ns per request was reworked rather than kept for
convenience, and a nicer API that slows every page loses. Every pull request is reviewed against
these values, in this order, before it merges ([CONTRIBUTING.md](CONTRIBUTING.md#review)).

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
