# Surfaces: one server for web, native and agents

Corten starts with the web, but nothing in it assumes the client is a browser. The server owns
the data, the rules a write follows and the text it renders; what a screen does with data it
already has (sorting, filtering, selecting) is the client's, and is fastest there. A surface
shows screens, keeps their state and sends actions back. Every surface speaks plain HTTP, JSON
or HTML, and server-sent events, which every platform has built in.

## Three contracts

| Contract | What it is | Web (today) | Native screen | Agent |
|---|---|---|---|---|
| Screen | a route whose page struct is its view model | HTML from the page's `html!` view | `Accept: application/json`, `{"title","data"}` from `req.screen` | the same JSON, as a read tool or resource |
| Action | a `POST` route with typed form input | `<form data-patch>`, patch or redirect | the same `POST`, JSON screen back | the same `POST`, as a tool call |
| Feed | keyed rows: snapshot plus numbered patches | `subscribe()` in `corten.js` | `corten_protocol::Replica` through UniFFI | `Replica`, or the raw SSE stream |

One handler answers every surface. It branches on `req.mode` only to choose the response shape,
never to change what the action does. A new surface therefore adds a renderer, not a second
backend.

## What exists now

1. `Mode::Data` and `Req::screen` (feature `json`): the same URL is HTML for browsers and JSON
   for clients that ask for `application/json`. Responses carry `Vary: corten, accept`, so caches
   keep the two apart. The runtime's own `corten` header always wins over `Accept`.
2. `corten-protocol`: the feed's wire types and `Replica`, the client half of the protocol in
   Rust. It depends only on `serde` and `serde_json`, so it builds for iOS, Android, WebAssembly
   and agent processes. `corten-feed` uses the same `check_seq` and `apply_ops` rules, so the
   server follower and every client apply patches the same way.
3. The example's `watch` handler serves a browser with and without JavaScript, and a data
   client, from one function. `examples/watchlist/src/home.rs` tests all three.
4. `corten::agent` (feature `agent`): actions as Model Context Protocol tools over HTTP POST.
   `examples/card-market` exposes `items.get` (a read tool returning the screen JSON) and
   `alerts.create` (the same rule the form uses), behind bearer tokens.
5. PWA: a manifest and a generated service worker (`corten::pwa`) make the web app installable
   with an offline fallback page; the card-market smoke test checks both in Chromium.
6. JSON-only routes (`App::api`): endpoints with no screen (webhooks, OAuth callbacks, calls
   between services, public APIs, the MCP endpoint) under a prefix where every failure is JSON
   and there is no document or nonce. `examples/card-market` mounts its MCP endpoint this
   way, and lets agents' pages on `AGENT_ORIGINS` call it from the browser.

## Native apps (next, not built)

1. Web-like screens run in a native shell around the server-rendered pages (Hotwire Native or
   similar). Open decision: Hotwire Native drives pages through Turbo's JavaScript adapter.
   Either the mobile shell pages load Turbo Drive, or `corten.js` implements that adapter.
   Prototype both before choosing; it changes only the runtime, not apps. A shell's web view is
   a browser, so it holds live streams as [design Limit 14](design.md#limit-http1) says.
2. Native screens (camera scanning, offline seller work) read `req.screen` JSON, post the same
   actions, and follow feeds with `Replica`. A `corten-native` crate would wrap `Replica`, an
   HTTP/SSE client and an offline outbox (SQLite on the device, an idempotency key per write)
   behind UniFFI, giving Swift and Kotlin one tested core. A screen may follow several feeds at
   once, and the platforms' own clients cap what goes to one host. `URLSession` opens at most
   `httpMaximumConnectionsPerHost` HTTP/1.1 connections to a host per session (6 by default,
   sometimes lower, depending on the network); HTTP/2 shares one connection and ignores it, so
   behind the proxy or CDN the browser already needs
   ([Deploying](guide/deploy.md#what-the-proxy-must-do), item 3) it does not bind. OkHttp's
   `Dispatcher.maxRequestsPerHost` (5 by default) counts calls started with `enqueue` until
   their callback returns, whatever the protocol, and okhttp-sse's `EventSource` reads its
   stream inside that callback, so five open feeds through one `OkHttpClient` leave every other
   queued call to that host waiting unless the app raises it (synchronous calls and WebSockets
   are not counted). Which client `corten-native` uses is an open decision (below).
3. Design tokens come from one source and generate CSS, Swift and Kotlin. Only the components
   native screens use are mirrored.

## Agents

1. Reading: an agent fetches any screen as JSON. Because rule 7 keeps every displayed value in
   the view model, the agent sees what a person sees, and nothing is scraped from HTML.
2. Acting (built): `corten::agent::Tools` registers each tool with a name, a description and a
   handler `(caller, Input) -> Result<Output, ToolError>`. The `inputSchema` and `outputSchema`
   agents see are generated from `Input` and `Output` by the derives that read and write them
   (`FromJson`, `ToJson`), so they cannot drift from the code, and bad arguments are refused
   before the handler runs. `Tools::auth` checks every call once and hands the proven caller to
   the tool; `ToolError::Unauthorized` is HTTP 401, `InsufficientScope` is HTTP 403 with
   `error="insufficient_scope"`, and `Forbidden` and `Invalid` are tool results with `isError`.
   `Tools::authorization` names the authorization server: Corten serves the endpoint's RFC 9728
   metadata next to it, names it in every 401, and checks the token on every request to the
   endpoint.
3. Agent UIs: chat clients that render HTML UI from tools can embed Corten's server-rendered
   fragments as they are, because they are plain HTML; their handlers need only the runtime.
4. Agents in the browser (WebMCP, not built): a page offering tools to an agent running in the
   browser. When it was reviewed (Corten `e9cb241`) it was a W3C Community Group draft, not on
   the Standards Track; only Chrome shipped it, behind an origin trial; its API had moved during
   2026 (`navigator.modelContext` became `document.modelContext`, and `provideContext()` and
   `clearContext()` were removed); and the normative section for its declarative form was still
   marked TODO. Corten offers nothing for it yet: building on a draft means rewriting with each
   revision (Values 2).

   An app can offer a tool today from a function its component's markup calls, in the
   `#[component(js)]` script, with `document.modelContext.registerTool(.., { signal })`, so the
   tool goes away with the component. Nothing in Corten needs to change for that.

   The part Corten would own is the declarative form, where an annotated `<form>` is the tool:
   `html!` could write the tool's name and field descriptions from the form's
   `#[derive(Fields)]` struct, with no script, and the agent would use the form's own path
   (session cookie, same-origin check, `SubmitKey`, `req.invalid`). To settle then: whether the
   agent gets the patch or the data-mode JSON back; the styling hooks the draft proposes for a
   form an agent is filling (`:tool-form-active`, `:tool-submit-active`); and a smoke check in
   a browser that has it. Revisit when the declarative section is written and a second engine
   ships it, or a major agent calls it
   ([#695 WebMCP: wait for the declarative form API before Corten offers anything, and record when to revisit](https://github.com/corten-run/corten/issues/695);
   related:
   [#692 An MCP tool is a second handler next to its route, with its own auth closure instead of Identify, so each action is written once per surface and drifts](https://github.com/corten-run/corten/issues/692)).

## Types across seams

Every place two languages or two processes meet is checked automatically, in CI, from one Rust
definition:

| Seam | Source of truth | Checked by |
|---|---|---|
| Rust to markup | page struct and component props | `html!` and `#[component]` are Rust: a missing field or prop is a compile error |
| Markup to handler | each handler's JSDoc, in the script next to the component | `#[component(js)]` reads the script when the crate compiles: `js::name(..)` exists only for an export, and each argument must match its `@param` type: a ref by the tag it is on, `event` by the `on:` name, `target` by the tag, values by their Rust type (a JSON value by a generated declaration's; a call to a handler whose parameter has no type to check the argument against does not compile, and only `unknown` takes any argument). `tsc --checkJs` (`strict` and the checks of [Choice 34](design.md#choice-script-checks)) checks the function bodies against the same JSDoc |
| Typed events | the `#[event]` struct | `corten::types` declares its class in `corten/events` with the fields' types; `on:Name` must name an `#[event]` type |
| Feed rows to script | the row struct | `corten::types` writes `types/app.d.ts`; `subscribe<Row>` types the snapshot and every patch |
| Form fields to handler | the input struct | `#[derive(Fields)]`: views print `Input::FIELDS.email`, a `FieldName`, and `Errors` takes only that, so a renamed field is a compile error |
| Links to routes | the route struct (`#[derive(Route)]`) | the router mounts `Route::PATH`; a path parameter without a field, a link missing a field, or a redirect or current-page check given a path as text does not compile |
| Route parameters to handler | the route struct | the handler reads them back as `Params<Route>`, the struct's fields owned and read by the names the link writes; in a routes module a handler of a route with a path parameter that does not take its own `Params` does not compile |
| Markup to stylesheet | the component's CSS file (`#[component(css)]`) | each class is a constant only that component (and helpers that name it, `css = Owner`) can use; a class the file lacks, or one written as text, does not compile; an unused class is a dead-code warning; a rule that does not start inside the component does not compile |
| Views to tokens | the token files (`tokens!`) | scales are enums, utilities take them per breakpoint, and a theme context that defines a token the defaults lack does not compile |
| Text to catalogs | the default locale's catalog (`messages!`) | every locale must have the same keys and arguments; a key is a method and an argument a parameter, so a misspelling does not compile |
| Agent arguments and results | the tool's input and output structs | schemas generated from them; arguments are deserialized before the handler runs |
| JSON from an API route | the response struct (`#[derive(ToJson)]`) | `Json<T>` needs `ToJson`; the derive reads `#[serde(...)]` and a rename rule or attribute it cannot write as serde does is a compile error, so the JSON is what the same struct's `Deserialize` reads |
| JSON from another service | the response struct (`#[derive(FromJson)]` next to `Deserialize`) | `corten::json::from_slice` needs `FromJson`; the derive reads `#[serde(...)]` and an attribute it cannot read as serde does is a compile error, and where its reader gives up serde_json reads the text, so the value and errors are serde_json's |
| Screen JSON to native and agents | the page struct | `Types::json_schema` gives JSON Schema for code generators |
| An API to its other services and client generators | the API's routes and its handlers' argument and answer types | `#[corten::routes(api = .., openapi = ApiDoc)]` serves an OpenAPI 3.1 document built from them (`corten::openapi`); a handler whose argument or answer cannot say how it appears does not compile, a parameter or body type with no JSON Schema fails the router build, and `openapi::sync` keeps a copy beside the code that `npm run check` validates |

The declarations file is generated by a test (`Types::sync`) that rewrites it and fails when it
is stale, so a Rust change without the new file fails CI, and a script that no longer matches
fails `npm run check`. A subscription that names no type gets `unknown`, never
`any`, so nothing is read unchecked. `scripts/typecheck-fixture.js` proves each of these with
`@ts-expect-error` lines that must stay errors.

Not checked: `data-*` attributes a script reads through `dataset` (strings on both sides; pass
the value as a handler argument instead), that a ref inside an `if` is present when a handler
runs (the call throws when it is not; the type says it is always there), the value a call passes to a
handler parameter typed `unknown` (any `ToJson`, ref or event; the script narrows it, and `tsc` holds it to
that), that a route marked `link` in a routes module (or a plain `#[derive(Route)]` struct) is
served by the API or area that should serve it (the app's tests cover that), that every component a page renders is listed in
`App::components`, or in an area (`Area::components`) the page is under (checked at run time in debug builds,
a router test or `cargo run` as well as `corten dev`: the page fails and names it), that a CSS custom property a stylesheet reads exists (a misspelled `var()` falls
back silently), and logic a script repeats from Rust (the listing sort rule in the item page).

## Rules that keep surfaces from drifting

1. No business logic in a surface. Rules, validation, formatting and permissions live in Rust
   on the server.
2. A screen's page struct is its whole view model ([design rule 6](design.md#rule-page-view-model)). Displayed text, prices
   included, is a field.
3. Actions are idempotent or carry an idempotency key, because native and agent clients retry
   (a 502 can hide a committed write). A browser form carries one as a `SubmitKey`
   ([Forms](guide/requests-and-forms.md#forms)), and an agent's tool call as a `SubmitKey` field of
   the tool's input; work on something the app's data already names
   is made idempotent by a check of what is done already under a lock, and a key for each provider
   call made from what it acts on, instead
   ([Work that must not run twice at once](guide/requests-and-forms.md#work-that-must-not-run-twice-at-once)).
4. A screen is never also an API route. `/api/items/{id}` next to `/items/{id}` is a second
   backend for the same screen; a native screen reads `req.screen` instead. `App::api` is for
   endpoints that have no screen.
5. One feed protocol. Clients never invent their own diffing. Changes go through
   `corten-protocol` and its tests.
6. A new surface ships with a test that drives the example through it, like `scripts/smoke.mjs`
   does for the web.

## What belongs in the framework

The test for each candidate feature: the framework takes it only when the framework creates the
problem (client navigation, generated files, its own transports) or is the only layer that can
see it. Anything that depends on the app's domain, data or vendors stays out, even if every app
needs one, because a framework version would be either partial or a wrapper that hides the real
library. A row that is not built says what would reopen it, as a design Choice says when to
revisit it ([design](design.md#choices)). Measured against a production marketplace app:

| Need | Owner | Why |
|---|---|---|
| Pages, patches, handlers, feeds across instances, CSP and CSRF, assets, head tags, PWA, catalog, sitemap, health, shutdown, agent tools | Framework | Built and tested earlier. |
| Layout data on client navigation | Framework: page key (from the `Caller` a handler read), `data-nav` and `data-nav-group` | Client navigation swaps only `<main>`, so only the framework can know the layout went stale. It reloads when the caller or deploy changes and keeps `aria-current` right. |
| Layout data on a full load | Framework: `LayoutRead`, `App::layout_read`, `later::<T>()` | Markup renders synchronously inside the handler, so otherwise every handler that draws the layout awaits and passes the value ([design Choice 20](design.md#choice-layout-reads)). The framework starts the read beside the handler and draws it into the finished page. |
| Which nav items show for which roles | App | Roles and permissions are the app's model; the layout component decides. |
| Which routes need sign-in or a permission | Framework: `Caller<T>` and `Identify`, `caller = T` on a routes module; the decision is the app's | The answer has to come out right in each request mode (a redirect, `corten-location`, a JSON 401, the error page) and before the handler reads the body, and a route that forgets it should not compile, which only the framework can check. Who passes is the app's model, in its `Identify`. |
| Return addresses (`?next=`) | Framework: `Local`, `Req::serves` | A check that a path stays on the site has to know how browsers read `//`, `/\` and dot segments, and whether the app has a page there has to match the route the router picks, which only the framework holds. Where to send a user without one is the app's. |
| Field errors | Framework: `Errors`, `req.invalid`, focus on first invalid field | The 422 has to come out right in each request mode (patch, page, JSON) and as an agent error; that is transport the framework owns. |
| Routes with no screen (webhooks, public APIs) | Framework: `JsonResult<T>`, `App::api` | The framework's error pages and nonce assume a browser asking for a page; only the framework can switch them off for a prefix and answer every failure as JSON instead. |
| HTTP caching of pages and JSON | Framework: `Public<..>`, `private, no-cache` by default | Only the framework sees everything that makes a response personal (a caller read, the request's credentials, the mode, the nonce, a cookie set), so only it can refuse to mark such a response shareable. What to cache on the server (data, queries) is the app's, since only the app knows when its data changes. |
| Which host names the app answers to | Framework: `Policy::host`, `HOSTS` | The framework chooses the loopback bind and is the only layer in front of every route (the app's, the API's, `/health`, `/corten`), so it is the one place a DNS-rebound request can be turned away before any of them runs. Which names are the app's is the deploy's, in `HOSTS`. |
| The client's address behind a proxy | Framework: `ClientIp`, `Policy::proxy`, `PROXIES` | Only the framework holds the connection, so only it can give a handler the peer, and which hop of `X-Forwarded-For` to believe is one rule that every handler reading it has to get right (a header anyone can write). Which proxies are in front is the deploy's, in `PROXIES`. |
| Cross-origin calls to those routes (CORS) | Framework: `Api::allow_origin` | The framework's same-origin check refuses cross-site writes, so it is the only layer that can let one site's calls through for some routes while the pages keep refusing them. Anything beyond one allowed site and its preflight is `tower-http`'s CORS layer around the app (`App::layer`). |
| Types across the server/browser seam | Framework: `corten::types` (TypeScript from the Rust types), `#[component(js)]` handler calls checked against JSDoc, `#[event]`, `subscribe<Row>`, `#[derive(Fields)]` | The framework defines the seams (handler calls, events, feeds, form posts, tools), so it is the only layer that can type both ends. |
| Response compression | Framework: `corten::compress` | The framework serves the runtime and assets and knows they never change (compress once, best level) and that pages are generated per request (fastest level that pays). A generic layer re-compresses static files on every request at a level tuned for neither. |
| Validation rules and messages | App | Domain rules; messages come from the app's catalog. |
| Push notifications | Framework: `Pwa::import_script` only | The framework writes the service worker, so the app needs a way in. VAPID, encryption, subscription storage and sending are a library (`web-push`) plus the app's tables. |
| Feed diagnostics | Framework: `tracing` events, target `corten::feed` | Resyncs, limiter refusals and drains happen inside the feed; `corten-cluster`'s gaps, reloads, consumer failures and relay failover inside the cluster. |
| Metrics export, trace propagation, OpenTelemetry | Platform | A `tracing` subscriber layer chosen per deployment. |
| Entity and summary streams | Framework: idle unload in `corten-cluster` | One feed per entity is the model; unloading unused feeds keeps memory bounded. |
| Several topics on one connection | Not built | HTTP/2 or HTTP/3 shares one connection across streams. Corten serves HTTP/1.1 ([design Limit 14](design.md#limit-http1)), so that comes from the proxy or CDN in front of `corten::serve`, which a deploy with live streams needs: over HTTP/1.1 a browser opens about six connections to a host, and a page with a few live elements, open in a few tabs, uses them up. Multiplexing would add a second protocol and break per-stream resume and backpressure for a saving the proxy already gives. Nothing of Corten's own would be built for it: HTTP/2 in Corten itself would give it, and [design Limit 14](design.md#limit-http1) says what would reopen that. |
| Shared stream per URL across components in one page | Not built | Tried and reverted: two subscribers on one URL is rare, and sharing couples their lifecycles and replay (a late joiner needs its own snapshot). Revisit if a page needs it. |
| Per-user filtering of live data | App | A per-user feed plus route authorization; the framework cannot know who may see a row. |
| Number, money, date formatting | Framework: `t.number`, `t.money`, `t.percent`, `t.date_time`, `t.date`, and `t.js()` in scripts | The first paint must be right without a script, so the server formats, and a script must write the same text, so both use one format per locale: CLDR's separators, symbols and patterns, checked against `Intl`, for the locales `messages!` lists. Formats CLDR has beyond these (units, lists, other calendars) are the app's, with ICU4X or the browser's `Intl`. |
| Component stylesheets | Framework: `#[component(css)]`, `App::components` | Scoping class names and checking the markup against them needs the macro that compiles the markup; joining and serving the files needs the asset pipeline. |
| Design tokens to CSS and Rust | Framework: `tokens!` | Utilities are typed in views and their classes must exist in the served CSS, so both come from the one macro, at compile time. The files are the W3C Design Tokens format (2025.10), themes through its resolver, with breakpoints and utilities under `$extensions."run.corten"`. |
| Design tokens to Swift and Kotlin | Build tooling | The same W3C token files, which Style Dictionary and Terrazzo already turn into Swift and Kotlin; a build step per platform, not part of the server. |
| A component library (buttons, dialogs, menus) | App or a library crate | Look and domain vary per product. The framework gives the parts (scoped CSS, handlers, `COMPONENTS` lists); it ships no widgets. |
| Behavior of widgets the browser lacks (number field, combobox, tabs, menu button) | `corten-ui`, a separate crate in this repo | Focus, keys and ARIA are the same in every product and hard to get right, so each app should not write them; but they are optional, change faster than the core and add client code. So they live outside `corten` (not re-exported, depends only on `corten`), headless (no CSS: the design system styles them by role and ARIA state), and each one is removed when the platform's own element is good enough. Dialogs, popovers, accordions, selects, switches and sliders are already the platform's. |
| Sessions and authentication | App | Only cookie helpers and `Identify` (how a `Caller` is found) are provided. |
| Switching a server-rendered client branch | Framework: `view(host, View, template)` beside `rows`; state and mode remain the app's | The framework creates typed template refs and the CSP custom-property encoding that cloning must preserve. The helper adopts by server-rendered root ID or clones without rewriting IDs; it supplies no renderer, child-prop synchronization or second lifecycle. |

## Open decisions

1. Native navigation: Turbo Drive in shell pages versus a Turbo-compatible adapter in `corten.js`.
2. Auth across surfaces: session cookies for web and native shells, tokens for native screens
   and agents. Whatever is chosen, the app turns it into a caller type (`Identify`) that
   handlers take as `Caller<T>`, one type per kind of caller.
3. Native screens' HTTP client: a Rust HTTP/SSE client in `corten-native`, carrying every feed
   over one HTTP/2 connection and outside both platforms' caps, against `URLSession` and OkHttp
   (above), which need no `h2`, TLS stack or trust roots on the device and on iOS keep VPN On
   Demand and background sessions, which a client on its own sockets loses (Happy Eyeballs it must
   bring itself, as hyper-util's connector does), but leave OkHttp's cap for the app to raise.
