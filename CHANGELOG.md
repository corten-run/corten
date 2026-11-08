# Changelog

Notable changes to Corten. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Corten is pre-1.0, so any minor version may change the API.

## Unreleased
### Added

- A separate rich marketplace-v2 benchmark: eighteen framework adapters localize raw numeric
  money, ratings and counts during each request in English, French and German. An independent
  pre-load gate checks full pages, native forms, layout, escaping, JSON and uncached upstream
  reads in both data sources. Its repeated-pass runner and read-only report preserve provenance,
  variability, CPU and memory evidence and measurement limits. Catalog also gains a read-only
  report. Historical result files and the pinned catalog run are untouched. Leptos's existing
  build-cost recipe also uses cargo-leptos's supported lockfile flag, matching its image build.

- A separate locale-neutral catalog benchmark in `bench/catalog`: the same strings-only
  record-detail page, JSON, GET filter and related links in eighteen framework apps.
  Correctness checks precede load tests; catalog rounds have their own baseline rather than
  being compared with historical localized marketplace rounds.

- `corten/views` adds `view(host, View, template)` for a single server-rendered branch,
  with typed templates, root-ID adoption, collision checks and CSP-safe custom properties. The
  deck builder exercises nested stateful branches with independent drafts and ID-based controls.

1. `App::api::<ApiRoot>(|api| api.route::<ItemJson>(get(item_json)))`: routes with no screen (webhooks, public APIs, the MCP endpoint)
   answer every failure as JSON whatever the client accepts, including unknown URLs, wrong
   methods and the deadline, with no shell, nonce or context and a `default-src 'none'` CSP.
   `Api::allow_origin` lets one site's pages call them from the browser (CORS preflight and
   headers, writes without cookies let through for those routes only); `Api::context` runs
   `App::context` for them, and `Api::guard` decides who may call them. A route given to an API
   outside its prefix does not compile (item 30).
2. `Error::with_status`, for a 4xx with a message written for the client.
3. `Errors` is a response (feature `json`): 422 with the JSON error and its fields.
4. `Nonce` is an extractor, for a handler that writes HTML with an inline script itself.
5. `Cache` (`corten::cache`, in the prelude): a handler returns `(Cache::public(max_age), response)`
   for a page or JSON that is the same for every visitor, with `.stale_while_revalidate(..)`;
   `Cache::no_store()` keeps a response out of every cache. `App` sends a public response as
   `private, no-cache` when the request has a `Cookie` or `Authorization`, the context found
   someone, the response sets a cookie or the HTML has the request's nonce, and as `private` with
   the same lifetime for a client navigation, a form answer or data from a page route.
   `examples/item-page` marks its home and category pages public; its smoke test checks the
   headers and that a page is restored from the browser's back/forward cache (in Playwright's
   full Chromium; its default headless shell never restores a page).
6. `examples/item-page` serves the item page's data as JSON at `/api/items/{id}` under
   `App::api`, the same view model the page renders, shared with the cache by `Arc`.
7. Handlers replace islands. `#[component(js)]` reads the script next to the component and gives
   it a module `js` with one function per `export function`; the markup calls them,
   `on:click={js::confirm(event, dialog)}`, and each argument is checked against the handler's
   JSDoc when the crate compiles. `let (save, dialog) = refs();` names elements (typed by the tag
   each is put on), `event`, `target`, `signal` and `scope` are the browser's, and other
   arguments are JSON values. A component takes a handler as a prop (`on_remove: Handler`, set
   with `on:remove={..}`). `#[event]` declares a typed DOM event (`on:RowToggled={..}`, the class
   imported from `corten/events`), `script!` a module several components share, and `state(el,
   init)` (from `corten`) state kept with an element. The runtime runs every handler from one
   listener per event type on the document and runs `on:connect` when markup joins the page.
8. `examples/seller-desk`: a client-heavy screen (selection with ranges, filter, sort, inline
   edits, a confirm dialog, live stock levels) on handlers, with a browser test and timings.
9. For lists and large components: `ref.closest()` (the element with the ref around the event's
   target, so one handler on a container serves every row), groups (a `@typedef` of elements in
   the script becomes a struct `js::Name { .. }` passed as one argument), keyed refs
   (`key={item.id}` and a `Map<string, HTMLElement>` parameter), and handlers take up to 12
   arguments. `corten::script::el` is in the prelude.
10. A handler parameter typed with a class imported from `"corten/events"` is checked against the
   `#[event]` type when the crate compiles.
11. `corten::view::Remove(id)`: a patch that removes an element.
12. `[package.metadata.corten] scripts = "prefix"`: a library's scripts and component roots are
    named `prefix.name` and `prefix-name`. `corten-ui` uses `ui`.
13. `#[derive(Id)]` (in the prelude): an element id as a type, `struct RowId<'a>(&'a str)` is
    `row-{key}`, so the markup and the patch that replaces or removes the element cannot drift.
    `Remove` takes one. Two ids with the same name in one program fail to build (two versions
    of one library excepted).
14. `corten fmt [--check] [path ..]` lays out the markup inside `html!` (rustfmt leaves macro
    bodies alone) at rustfmt's `max_width`. It never joins lines the author split and only changes
    whitespace: a body whose tokens would change is left as written, with a warning.
    `corten check` runs `corten fmt --check`.
15. `corten::Json` (feature `json`, in the prelude): axum's `Json` extractor with the same
    rejections, and a response written by `serde_json::to_vec` into a `Vec` the body keeps.
    axum's `Json` writes through a `BytesMut` writer that costs more for every small write. On a
    bench droplet (Xeon Platinum 8280, app on one core, 64 users, two rounds), the item's 8.8 KB
    of JSON under `App::api` served 24,330-25,000 requests a second instead of 18,608-19,168
    (Leptos, which uses axum's `Json`: 20,008-20,377), and took 121,882 user instructions a
    request in process instead of 193,668. `examples/item-page` uses it for `/api/items/{id}`.
16. `#[component(view)]`: the component gets a class in `corten/views` whose properties are its
    holes, a parameter that is an element's whole text or an attribute's whole value.
    `row.label = "x"` writes that text, `row.label` reads it back, an `<input>`'s `value` and
    `checked` are its live properties, a root `key={id}` keys it, and `corten::types` declares it
    so `tsc` checks scripts against the Rust parameters. Debug builds stop a number property past
    2^53. Handlers use views through `rows(parent, View, template)` from the same module: one list
    per parent element that follows changes made elsewhere. Corten serves `rows()` and the classes as one module, only to apps with views.
17. `Holds<Row, HTMLTableSectionElement>` in `corten/views` types a handler parameter that holds
    a view's rows; `rows(body, Row)` takes only that, so `tsc` rejects the wrong view or a plain
    element, and the Rust compiler rejects a ref whose element the markup does not fill with `Row`s
    only. `Ref` gained a second type parameter for it (`RowsOf<{ view_id("Row") }>`, defaulting to
    `NoRows`). `rows()` gained `get(key)` and `indexOf(view)`. A view whose key the markup also
    shows outside its holes has no `keyOf`, and its `rows()` cannot `push` or `replace`: the
    server makes those rows. `examples/seller-desk`'s grid rows are an `InventoryRow` view.

18. Releases: every crate in `crates/` can be published to crates.io at the one version in
    `[workspace.package]`, with license, repository, keywords, categories and `rust-version`
    (1.88, checked by CI and the checks in `CONTRIBUTING.md`). Pushing a tag `vX.Y.Z` runs
    `.github/workflows/release.yml`: the checks, a static `corten` binary for Linux (x86_64,
    aarch64), macOS (x86_64, aarch64) and Windows, `cargo publish --workspace`, and a GitHub
    release with the binaries and the changelog section. `cargo binstall corten-cli` downloads
    the binary. `CONTRIBUTING.md` (Releasing) has the steps, including the first release.
19. `.github/workflows/ci.yml` runs the checks in `CONTRIBUTING.md` on every pull request and
    push to `main`, plus `cargo publish --workspace --dry-run` and a build on Rust 1.88.
20. List fields. `corten::Form` and a route's `Params` (Added 116) read a key
    sent several times into a `Vec` field, a checkbox's `on` into a `bool`, and a blank field into
    `None`; a scalar sent twice is a 422 (400 for a query) naming the field. `#[derive(Fields)]`
    rejects a `bool` or `Vec` field without `#[serde(default)]`, since a browser sends nothing for
    an unchecked box. A typed route's `Vec` or slice field writes its parameter once per item.
    `corten::form::from_bytes` reads a body or query string directly. The alert form reads in
    673 ns against axum's 871 (release build, best of five). `examples/seller-desk` posts its
    checked rows as `ids` fields (each row's box joins the archive form with `form=`) instead of
    a comma-joined field its script wrote.
21. `Area::components(&[..])`: components only an area's pages render (see the `Area` item
    below) get a stylesheet of their own, `sections/{prefix}.css`, linked from those pages only,
    so a large part of the app most visitors never open stops adding to every first load. A
    client navigation into the area loads the stylesheet before it swaps the page in (a full
    load if it fails), and keeps it. A component with a stylesheet listed in two places, or
    tokens in an area, is a startup error; under `corten dev` a page outside the area that
    renders one of its components is an error naming both. Measured with callgrind (release build, in
    process, instructions in `App`'s middleware per item page): without sections a navigation
    took 87,249-87,331 against 87,252-87,257 before (three runs each), and a full document
    100,101-103,892 against 100,176-103,616 (ten runs each, medians 103,270 and 102,652; the same
    build lands near 100,200 or 103,600 from run to run). With the item page's four item
    components in an `/items` section, a navigation took 88,341-88,589: writing the links is
    about 120 of those, and most of the rest is in serde_json, which the section code does not
    call, and the allocator. A full document took 100,766-102,327. The home page's
    component CSS is then 593 bytes brotli instead of 1,047 and an item page's 1,141 in two
    files. The runtime is 126 bytes gzip larger. `examples/hello` puts the about page's note
    in an area, and the smoke test checks the stylesheet loads before the swap, stays, is not
    linked twice, and that a failed load falls back to a full page load.
22. `corten-ui`'s `Toaster` and `Toast`: a persistent `role="status"` region an action's patch
    fills by id (`#ui-toast`), hidden after `seconds` but kept while the pointer or focus is on
    it or the page is hidden (WCAG 2.2.1), with a close button the script reveals. Without
    JavaScript the message is in the page the post answers with. `examples/ui-gallery` saves a
    draft with one.
23. `scripts/smoke.mjs` and `examples/ui-gallery/smoke.mjs` run in Chromium, Firefox and WebKit
    (`node smoke.mjs [url] [engines...]`), and CI installs all three. Checks a browser cannot
    make are skipped with the reason: Playwright's WebKit on Windows has no Navigation API
    (navigations are full loads there) and does not send a `Secure` cookie over http. Its Linux
    build has the API, but Playwright then waits forever after the first navigation the runtime
    intercepts, so the smoke test checks WebKit's swap from inside the page and runs the rest
    without the API.
24. Guards: `Area::guard(|context, req| Access::..)` for an area, `App::guard` for the whole app
    and `Api::guard` for an API. Every route under the prefix (including unknown URLs and wrong
    methods there) needs the guard's `Access::ALLOW`, so a handler cannot forget a sign-in or
    permission check. The check gets the request as
    `Guarded`: `req.writes()` (every method but GET, HEAD and OPTIONS) gives reads and writes at
    one URL different rules, `req.is::<Route>()` names one route, `req.uri()` builds a sign-in
    link back. `App::guard` denies by default; `App::unguarded::<SignIn>()` opens
    one route, and Corten's own routes and the offline page are never guarded. A sign-in answer
    that a guard would send to sign in again is a 500 that says so, not a redirect loop. The app decides who passes; Corten
    answers before the handler and its extractors run, in the request's mode:
    `Access::sign_in(&route)` is a 303 for a page or a form post without JavaScript,
    `corten-location` for a form patch, a JSON 401 for a data client or an `App::api` route,
    and `Access::refuse(error)` is the error page or the JSON error. Guards nest (outer first),
    run the context for API routes under them, and read the app's context type (a guard of
    another type does not compile). Under `corten dev` a refusal names its guard. `Access` is in
    the prelude. `examples/hello` guards an account page; the smoke test checks the redirect
    signed out and the page signed in. Measured with callgrind (item page, full document,
    release build, instructions in Corten's middleware itself, the same in each of 3 runs):
    1,951 before, 2,006 with no guard, 2,392 with a context and a guard on `/items`, and 2,443
    with a context, a guard on `/` and one unguarded route, of about 405,000 for the whole
    request. The answer a guard gives
    is boxed: carried inline, it made every request's future larger, and `memcpy` alone rose
    from 17,935-18,544 instructions to 19,073-19,518.
25. `App<C>`: the context type is part of the app's type. `App::context` turns an `App` (an
    `App<NoContext>`) into an `App<Viewer>`, so a shell or guard that reads another type, a
    guard on an app without a context, and a second `App::context` do not compile (each was a
    startup panic or not caught), and `App::guard`'s closure needs no parameter types.
    `compile_fail` doctests cover each.
26. `App::area::<Admin>(|admin| admin.route::<AdminUser>(get(user)))`: a part of the app under a
    prefix that owns its routes, with `.components(&[..])` for a stylesheet only its pages load
    and `.guard(..)` for who may use it. It replaces `App::section` and a guard given a prefix
    string: the prefix is written once for both, areas and APIs hold their prefixes to one rule
    (letters, digits, `-`, `_`, `.` and `~` between slashes), and an area under an API prefix
    is a startup error. A library ships an area as a function,
    `fn admin<C>(area: Area<C, Admin>) -> Area<C, Admin>`. `Area` is in the prelude.
27. The app guide's "Your own middleware" section: tower layers on the routes run inside
    Corten's middleware (after the context and guards), and layers around `app.router()` run
    outside it, given to `corten::serve`. `docs/design.md` has a rule for where a new `App`
    setting goes (`Area` or `Api` for a prefix, `App<C>` for the context).

    Measured with callgrind (item page, full document, release build, in process, no
    compression, instructions per request in Corten's middleware and axum's routing, two runs
    each, before and after items 25 and 26): no guard 3,969 and 3,968-3,975; a context 4,061 and
    4,059-4,066; a guard on `/items` (an area after) 4,355 and 4,358; `App::guard` with
    `req.writes()` and one unguarded route 4,399 and 4,384-4,391.
28. A `tokens!` theme follows the system too: `"@media": {"(prefers-color-scheme: dark)":
    ":root:not([data-theme=\"light\"])"}` in a theme writes its values again under that
    condition and selector, so a dark theme that the page can choose and the system can ask for
    is written once. Found porting a Chase Sets admin screen, whose dark mode follows the system
    unless the user chose a mode.
29. `Errors::add_form`, `Errors::form` and `Errors::form_message`: a message about the whole form
    (a rule across fields, or the backend refusing the write), rendered as a `role="alert"`
    paragraph and sent to JSON clients as `form` (and first in `message`) and to agent tools
    first in their error. Before, such a message had no place in `Errors`, so `req.invalid`
    gave data clients and agents a 422 without the reason. Found in the same port: the platform
    API rejects some writes with a message that names no form field.
30. An area's and an API's prefix and routes are route types, so the compiler checks what was
    checked per request or not at all: `App::area::<P>` and `App::api::<P>` take `P`, a
    `#[derive(Route)]` whose path is the prefix (a prefix with a parameter or a trailing slash
    does not compile), and a function that fills in the `Area` or `Api` with
    `.route::<R>(method_router)`, where an `R` outside the prefix does not compile (a `const`
    assertion, with `compile_fail` doctests). Before, a route typed wrong answered 500 when
    first requested. The function gets the app's context type, so an area's guard reads the
    context's fields without a type annotation (`|viewer, req| viewer.is_some_and(|v| v.staff)`).
    `Area::new`, `Api::new` and `impl From<Router> for Api` are gone. The per-request check of
    where a route was given left the request path with it: measured with callgrind (item page,
    full document, release build, instructions per request in Corten's middleware and axum's
    routing, two runs each, before and after), no guard 6,841-6,842 and 6,819-6,826, a context
    6,930-6,943 and 6,909, a guard on an `/items` area 7,169-7,176 and 7,159, the item route
    inside that area 7,195 and 7,159, `App::guard` with one unguarded route 7,222-7,229 and
    7,212-7,219. (These count more than item 27's figures, which were taken by another script.)
31. `#[derive(ToJson)]` and `corten::json::ToJson` (feature `json`, in the prelude): a struct or an
    enum written as JSON with the layout decided when the crate compiles, so between two values
    the response copies one byte string (`","count":`) instead of writing each key, quote, colon
    and comma, and string values are tested for characters to escape eight bytes at a time. It
    reads `#[serde(...)]` (`rename`, `rename_all`, `skip`, `skip_serializing_if`, `transparent`, and an
    enum's `tag`, `content` and `untagged`) and writes the bytes serde_json writes; an attribute it
    cannot follow (`flatten`, `serialize_with`, `into` ...) does not compile. A field whose type only
    implements `Serialize` is written by serde_json. `corten::json::to_vec` writes any `ToJson`.
    `examples/item-page` derives it on its view model, and its `render_cost` checks the 500 benchmark
    items against serde_json byte for byte and times the JSON.
32. A `<corten-live>` stream resumes after a reconnect: `corten::live` takes `Fragment`s
    as well as HTML, `Fragment::new(html).cursor(seq)` sends the app's cursor as the event's
    `id`, `<corten-live since={seq}>` gives the first connection the cursor the page was
    rendered at, and the `LiveSince` extractor reads either (`Last-Event-ID` first). A
    handler sends only what changed after it, so a page view or a reconnect costs no extra read
    or render. Asked for by the Chase Sets pilot, whose catalog lists drew every row on each
    connection ([#15 A <corten-live> stream cannot resume after a reconnect](https://github.com/todd-skelton/corten/issues/15)).
33. `corten check` type-checks the app's scripts: TypeScript's `tsc` (from the app's `node_modules`
    or the `PATH`) runs in strict JavaScript mode over every `.js` file in `src/` and `static/`,
    against the DOM's types, the `corten` runtime's JSDoc and the app's generated `types/*.d.ts`,
    with a config it writes under `target/corten/`. The compiler already checked each handler's
    call; this checks its body. An app with scripts needs `tsc` (Changed 158). Asked for by the
    Chase Sets pilot
    ([#20 corten check does not type-check an app's scripts](https://github.com/todd-skelton/corten/issues/20)).
34. `#[derive(FromJson)]`, `corten::json::from_slice` and `from_str` (feature `json`, the derive in the
    prelude): JSON read by Corten's reader, which matches each key against the type's fields, makes
    each value straight from the text and skips (validating) the rest. Where it meets anything it
    does not follow (an escaped key, a missing or duplicate field, a number it does not parse
    itself) serde_json reads the text instead, so the value and every error are serde_json's; it
    needs `Deserialize` next to it for that. It reads `rename`, `rename_all`, `alias`, `default`,
    `skip`, `skip_deserializing`, `deny_unknown_fields` and `transparent`; one it cannot follow, or
    an enum with data, does not compile, and a field of a type with only `Deserialize` is read by
    serde_json from its own text. `examples/item-page` reads its item API's response with it:
    measured in process (`perf_event`, user-mode instructions, release build, the 500 benchmark
    responses of 55 KB), 878,078 instructions a response through serde_json and 698,733 through
    `FromJson` (-20.4%), 913,151 and 733,130 with the conversion into the view model;
    `render_cost` (median of 3) reads one in 304.8 µs through serde_json and 185.5 µs. Its
    `render_cost` checks the 500 responses read the same both ways.
35. Live streams are compressed (feature `compress`). A `corten::live` or feed response to a client
    that accepts zstd or brotli is one compressed stream per connection, flushed after every
    event, with the context kept between events. On a 33-row list (6,126 B an event), measured:
    the first event 425 B with zstd 1 and each redraw 16-23 B, where every event was 6,126 B;
    brotli 4 gives 376 B, then 13-23 B. A stream holds about 470 KiB (zstd, 64 KiB window) or
    800 KiB (brotli) while open, and all of them share a 256 MiB budget past which a new stream is
    sent as it is. Gzip-only clients get streams as they are. Asked for by the Chase Sets pilot
    ([#24 corten::live responses are never compressed](https://github.com/todd-skelton/corten/issues/24)).
36. `SubmitKey` (in the prelude): one submission of a form, so a write whose answer was lost and
    is sent again applies once. A form struct takes a `SubmitKey` field and draws it with
    `SubmitKey::field(f.submit)`, a hidden input with a random UUID v4 (the form most APIs take an
    idempotency key in, [#35 A SubmitKey can only be 32 hex digits, so an API that takes a UUID cannot use it](https://github.com/todd-skelton/corten/issues/35));
    a value that is not a UUID v4 is a 422 naming the field. A reloaded post sends the same key, and the
    runtime keeps it for a `data-patch` form until a submit gets an answer below 500 (a network
    error, a 5xx or an abort keeps it), then renews it. The app stores keys with its writes; Corten
    keeps none. Asked for by the Chase Sets pilot, which wrote about 150 lines for it
    ([#9 Forms have no per-submission idempotency key](https://github.com/todd-skelton/corten/issues/9)).
37. `<corten-live>` shows its connection: a `status` attribute of `connecting`, `live`,
    `reconnecting`, `closed` (the browser gave up) or `ended` (the server finished the stream), and
    `stale-since`, the ISO time a live stream dropped, until it is live again. A page can mark a
    stale part with CSS alone. Asked for by the Chase Sets pilot, whose lists showed a dropped
    stream the same as an unchanged one
    ([#33 A page cannot tell whether a <corten-live> element is connected](https://github.com/todd-skelton/corten/issues/33)).
38. Query sets: `#[derive(Route)] #[route(query)] struct ItemQuery { .. }` declares parameters that
    several routes carry, and `#[route(query)] filters: ItemQuery` on a route's field writes each of
    them as the route's own parameter (`corten::route::QueryParams`). A list's filters are declared once
    for its page, its live rows and its bulk routes, so a route cannot drop one, and making one
    route's URL from another's copies one value. Handlers read it as their route's `Params` field. A
    `#[route(query)]` field of another type does not compile. Asked for by the Chase Sets pilot,
    whose 10 item filters were repeated on 5 routes by a `macro_rules!`
    ([#32 A route cannot share a set of query parameters with another route](https://github.com/todd-skelton/corten/issues/32)).
39. `#[derive(ToJson)]` writes a `#[serde(flatten)]` field whose type is a struct that derives
    `ToJson` (or an `Option` or `Box` of one): its members in place, as serde writes them, laid
    out when the crate compiles. The derive implements `corten::json::ToJsonMembers` for every
    struct with named fields; flattening a map, an enum or a `Serialize`-only type still does not
    compile, now with a message that says why. A dimension with 12 options (796 B) is written in
    640-860 ns, where serde_json's flatten took 1,820-2,660 ns (measured, release build). Asked
    for by the Chase Sets pilot, whose view model of an API type plus a few fields wrote its JSON
    through serde_json
    ([#34 #[derive(ToJson)] refuses #[serde(flatten)] of a struct that is itself ToJson](https://github.com/todd-skelton/corten/issues/34)).
40. Text a script computes comes from the catalog: `t.js()` (from `messages!`) has each message
    with arguments unfilled, a handler takes one as `@param {Message<"count">} label` (`Message`
    from `corten`) and shows `label({ count })`. The markup passes it in the page's locale
    (`js::count(total, t.js().rows_selected())`), sent as its text and argument names in
    `data-on` (`%["","count"," selected"]`), so only the messages a page uses are sent and the
    browser formats them with no round trip. A message whose arguments are not the ones the
    JSDoc names does not compile at the call, and `tsc` checks the script fills in each one. The
    runtime grew 177 B (74 B gzip). Asked for by the Chase Sets pilot, whose selection bar drew
    every count from 0 to the page's rows in a `<template>` (1,220 B on a 33-row list, sent again
    in each live event)
    ([#17 Scripts have no typed way to show user-facing text they compute](https://github.com/todd-skelton/corten/issues/17)).

41. `<corten-live>` dispatches a bubbling `corten-status` event each time its `status` changes, so
    a handler hears it with `on:corten-status={js::stale(target, ..)}` and reads `status` and
    `stale-since`, as a feed's `subscribe` calls its `status` callback. Asked for by the Chase
    Sets pilot, whose "Stale since {time}" banner watched the attributes with a `MutationObserver`
    ([#49 A script cannot hear a <corten-live> element's status change](https://github.com/todd-skelton/corten/issues/49)).
42. `t.by_key(key, &args)` (from `messages!`): the message with a catalog key chosen at run time,
    such as one another service answers with, in the request's locale, its arguments taken by
    name from pairs, a map or a JSON object (`corten::i18n::Args`). It is `None` for a key the
    catalog lacks or when an argument is missing, and renders escaped like any message. Asked for
    by the Chase Sets pilot, whose attention queue matched 20 API keys to methods by hand
    ([#54 A page cannot show a catalog message chosen at run time by its key](https://github.com/todd-skelton/corten/issues/54)).
43. `Policy::form_action(origin)` adds an origin to the CSP's `form-action`, so a page can send a
    form to a hosted checkout, an identity provider or a sibling app, and a form's handler can
    `req.redirect` there; the rest stay blocked (`form-action 'self'`). Found by the Chase Sets
    pilot, whose cart's Check out form posts to marketplace's origin and was blocked by the
    browser before the request was sent; a form posted straight to another app also needs that app
    to accept this origin, so posting here and redirecting is usually simpler
    ([#64 A page cannot send a form to another origin, and a post cannot redirect to one (form-action is always 'self')](https://github.com/todd-skelton/corten/issues/64)).
44. Numbers, money and dates in the request's locale, on the server: `t.number(n)`,
    `t.money(Minor(123450), USD)` (`$1,234.50` in en, `1 234,50 $US` in fr; or a `Decimal` an API
    sends as text, never a float), `t.date(at, DateStyle::Medium)`, `t.time(at, TimeStyle::Short)`
    and `t.date_time(..)` (`Mar 22, 2026, 12:00 PM UTC`), in UTC unless `.zone(..)`, rendered
    escaped and usable as message arguments. `corten::i18n` adds `Decimal`, `Minor`, `Currency`,
    `DateStyle`, `TimeStyle`, `Zone`, `Utc`, `Offset` and `parse_timestamp`. Each locale's data is
    CLDR's from Intl (`scripts/locale-data.mjs`, 108 locales, checked against Intl on 113,080
    values; the Rust test checks 9,828), and `messages!` puts only the listed locales' into the
    app. A tag with no data of its own uses its language's; a language with none is a build
    error. `number`, `money`, `date`, `time` and `date_time` are no longer catalog keys. Asked for
    by the Chase Sets pilot, which wrote `en` dates and prices by hand
    ([#60 A page cannot write a date and time in the request's locale](https://github.com/todd-skelton/corten/issues/60),
    [#63 A page cannot write an amount of money in the request's locale](https://github.com/todd-skelton/corten/issues/63)).
45. The same formats for a script: `t.js().number()`, `t.js().money(USD)` and
    `t.js().date(DateStyle::Medium)` (`.time`, `.date_time`, `.zone(Offset)`) pass a handler whose
    JSDoc takes a `NumberFormat`, `MoneyFormat` or `DateFormat` (from `"corten"`) a function that
    writes what the server writes (`money(123450)` is `$1,234.50` in en), from the locale data sent
    in `data-on` (`%{..}`); a format of the wrong kind does not compile. `scripts/format.mjs` (in
    `npm run check`) runs the runtime's formatter on all 9,828 cases with the formats the server
    sends (`src/i18n/specs.tsv`, which a Rust test rewrites). The runtime is 777 B larger gzipped
    (6,748 to 7,525 B). hello's live prices use it
    ([#60 A page cannot write a date and time in the request's locale](https://github.com/todd-skelton/corten/issues/60),
    [#63 A page cannot write an amount of money in the request's locale](https://github.com/todd-skelton/corten/issues/63)).
46. `<ReadAgain after={..} />` (`Meta::read_again(after)` before item 47 removed `Meta`), among a
    page's head tags: a page showing a read that has not caught up with a write asks to be read
    again. The runtime fetches the same URL after the delay and swaps it in (history entry
    replaced, scroll kept, focus kept by id, no swap when the answer matches the last read's, a
    hidden tab waits),
    however the page was reached: a full load, a link or a `data-patch` form's redirect. A
    navigation away stops it; without JavaScript it is a `<meta http-equiv="refresh">` in
    `<noscript>`. A `Refresh` header on a page is a 500 in debug builds: Chromium, Firefox and
    WebKit keep a full load's after the runtime navigates away and load that URL again (probed).
    The runtime drops `<noscript>` content from the markup it swaps in, which a template would
    otherwise make live. The runtime is 282 B larger gzipped (7,525 to 7,807 B). hello's
    `/saved` shows it
    ([#69 A page cannot ask to be read again shortly, and the Refresh header only works on a full load](https://github.com/todd-skelton/corten/issues/69)).
47. A typed route can carry query parameters whose names are data: a field marked
    `#[route(prefix = "dimension.")]` (a `BTreeMap`, or a `Vec` or slice of pairs) writes each
    entry as `dimension.<key>=<value>`, in order, both encoded. A `HashMap` (whose order would make
    the same link differ), a prefix with a character a URL escapes, and a prefix that overlaps
    another parameter's name are compile errors. Found by the Chase Sets pilot, whose variant
    links built `dimension.<id>=<option>` by hand
    ([#71 A typed route cannot carry query parameters whose names are data (dimension.<id>=<option>)](https://github.com/todd-skelton/corten/issues/71)).
48. `req.moved(&route)`: a `301 Moved Permanently` for a page that moved for good (an old slug, an
    item asked for by its id), kept by the browser for a day (`private, max-age=86400`); a
    `data-patch` form is sent on as by `redirect`, which stays a 303
    ([#72 A page that moved cannot redirect permanently (Req::redirect is always 303)](https://github.com/todd-skelton/corten/issues/72)).
49. The page is a document made of components. `req.page`, `req.screen` and the error page take a
    `Document`: `html!` that starts with `<html>` (one `<head>` with one `<title>` and one
    `<Corten />`, one `<main>` outside any `for`, `if` or `match`, all checked when it compiles), or
    a component that returns `impl Document`, such as the app's `Layout`. `html!` renders only the
    parts a request needs: the title for a data client; the title, the page's head tags (expressions
    and components in `<head>`, marked `data-corten-head`) and `<main>`'s children for a client
    navigation. `<Corten />` is where Corten adds the runtime and the page's scripts and stylesheets.
    `req.asset`, `req.has_asset`, `req.nav`, `req.is_current`, `req.nonce` and `req.lang` are what
    a layout reads. On the item page (release, `render_cost`, eight alternating runs against the
    commit before, Windows) a full document is about 7% faster (median 57.5 to 53.8 us) and a
    navigation within noise (47.0 to 47.8 us; another eight runs gave 48.4 to 48.3), with the same
    bytes, compressed or not.
50. `#[corten::routes]` on a module of routes: each `#[route("/..", get = home, post = save)]` struct in
    it is a typed route that names its handlers, and `url::router()` puts each at its path for
    `App::new` (`#[corten::routes(state = Db)]` gives `url::router(db)`, and every handler may take
    `State<Db>`). A handler that cannot serve its route points its error at the handler's name; a
    route without a handler (`link` marks one that is only linked to, such as an area's page),
    two routes with the same path, or a method named twice does not compile. `corten new`,
    `examples/hello` and the README use it.
51. `corten new` writes the app's `Layout` and `error_page` in `src/views.rs`, for the app to change.
52. `App::error_page` takes `fn(&Req, Failure) -> impl Document`: `Failure` has the status and, under
    `corten dev` only, the error. Every error page is sent with `X-Robots-Tag: noindex`.
53. `JsonLd { value: &product }` (or `<JsonLd value={&product} />`), feature `json`: structured
    data among a page's head tags, as `<script type="application/ld+json">`, with `<` written
    `\u003c` so no text in it can end the element, as `Meta::json_ld` did before item 49 removed
    `Meta`. An expression, component or block inside `<script>` or `<style>` in `html!` is now a
    compile error: it was escaped as HTML, which neither reads back (JSON with `&quot;` is not
    JSON). Found by the Chase Sets pilot, whose item page wrote its own escaping in front of `raw`
    ([#76 A page cannot write JSON-LD in its head since Meta was removed (an expression in <script> is escaped as HTML)](https://github.com/todd-skelton/corten/issues/76)).
54. `#[corten::routes(area = Admin)] mod admin { .. }`: an area's routes name their handlers too.
    The module's `Handlers` trait has a method per route and `admin::area(area, handlers)` mounts
    each in the area: `.area::<admin::Admin>(|area| admin::area(area, Staff).guard(..))`. A route
    without a handler, two routes with one path, and a route outside the area's prefix do not
    compile. Found by the Chase Sets pilot, which serves every route from an area, so item 50
    covered none of them
    ([#78 An area's routes cannot name their handlers (#[corten::routes] covers only App::new)](https://github.com/todd-skelton/corten/issues/78)).
55. `view::Patch` (in the prelude): a view a `data-patch` answer can send, checked when it compiles.
    `html!` is a patch when each of its top-level elements has `id={..}` with a `#[derive(Id)]` type
    and its other top-level parts (expressions, components, every branch of a `for`, `if` or
    `match`) are patches; a component is one when declared `-> impl Patch`, and then its markup must
    be. Text, an element without an id and an id written as text are compile errors, each with a
    `compile_fail` doctest. Each `html!` returns its shape, zero-sized types, so the check costs
    nothing at run time: seller-desk's `render_cost` (rows rooted at `<tr id={RowId(..)}>`, the
    path the check adds code to) is 1,967,358,212 instructions before and 1,967,337,624 after under
    callgrind (release), with the same bytes; the item page's whole `render_cost` is 34,210,499,634
    and 34,188,947,492 (-0.06%).
56. A component parameter can be `impl Render` (any `impl Trait`), a type parameter of its struct:
    `fn Layout(req: &Req, title: &str, children: impl Render) -> impl Document`. The README's example
    compiles as edition 2024, as apps are, so its functions return `impl Document` without lifetimes.
57. `corten_ui::dialog::modal`: `<dialog open={refused} on:connect={dialog::modal(target)}>` makes a
    dialog the server draws open (a refused form, in a whole page or a patch) modal when it joins
    the page, with focus on the first field marked invalid in it. `open` alone is the platform's
    non-modal state: no focus trap, the page behind not inert, no backdrop. It is a handler module
    in `corten_ui::COMPONENTS` (`script!`), takes `HTMLDialogElement` (on another element it does not
    compile) and is 593 bytes as served (measured), loaded only by pages that use it. `examples/ui-gallery`
    refuses a rename in a dialog and its smoke test checks it is modal, with or without the runtime
    for the post, in Chromium, Firefox and WebKit.
58. `data-keep-place` on a form or link: the navigation it starts keeps the scroll position and
    puts focus back on the control the user changed (by id, else by name, and value for a checkbox
    or radio), with its caret, also across a redirect. A list's filters are a GET form applied on
    `change` (`form.requestSubmit()`), so keyboard and screen-reader users no longer start again
    from the top of the page after every filter. A navigation without it still goes to the top.
    `examples/hello`'s about page has a filter that the smoke test checks in Chromium and Firefox
    ([#92 A GET form that applies a filter on change loses the user's place: its navigation scrolls to the top and moves focus to the body](https://github.com/todd-skelton/corten/issues/92)).
59. `view::Append(RowsId, rows)`: a patch that adds rows at the end of the element with that id
    (`<template id data-append>`), so Load more reads and renders one page instead of every row
    shown and the rows the page has stay as they are. `examples/hello`'s about page loads its
    history a page at a time with a GET `data-patch` form, checked by the smoke test ([#90 An answer cannot add rows to a list (Load more re-reads and re-renders every row shown)](https://github.com/todd-skelton/corten/issues/90)).
60. A route's query parameter is named as serde reads its field: `#[serde(rename_all = "camelCase")]`
    and `#[serde(rename = "..")]` rename it in links too (`?priceMin=`), so addresses already shared
    keep working without a hand-written `Params`. A renamed path parameter, or a name a URL would
    have to escape, does not compile (`compile_fail` doctests) ([#91 A query parameter cannot have a name other than its field's (#[route(query)] has no name =), so camelCase URLs need a hand-written Params](https://github.com/todd-skelton/corten/issues/91)).
61. A component several areas list (one screen at `/search` and `/categories/{slug}`) is in a
    stylesheet those areas share, `sections/search+categories.css`, linked from their pages only,
    instead of a startup error that sent it to `App::components` and every page ([#93 An area has one prefix, so a screen at two addresses (/search, /categories/{slug}) puts its stylesheet on every page](https://github.com/todd-skelton/corten/issues/93)).
    The runtime for 58 and 59 is 287 B larger gzipped (8,075 to 8,362 B, measured).
62. A handler's return type is what its route answers (`corten::answer`): `HtmlResult` (a page, a
    patch or a redirect, `Result<HtmlResponse>`; failures are the app's error page) or
    `JsonResult<T>` (every failure of the route is JSON, a path that does not parse included),
    and `Public<..>` around either for an answer a shared cache may keep (`Public::new(max_age,
    answer)`, `.stale_while_revalidate(..)`; only a success or a redirect is shared). A handler
    named in `#[corten::routes]` that returns `Response` or `impl IntoResponse` does not compile,
    and neither does a `Public` handler that takes a `Caller`, a `HeaderMap` or any input not
    marked `Anonymous`. `corten::live` returns `LiveResponse` and a feed's snapshot and stream
    `FeedResponse`.
63. `Caller<T>` (`corten::caller`): who is asking, found by `T: Identify` (a session cookie, an
    API key) only when a handler or middleware takes one, once per request. `Refused::sign_in`
    sends a browser to sign in (303, or `corten-location` for a patch; a JSON 401 for data and
    JSON routes), `unauthorized` and `forbidden` give the error page for 401 and 403, and
    `unavailable` a 503. Reading one makes the answer private and puts the caller in the page's
    key. `Option<Caller<T>>` runs the handler either way. `#[corten::routes(caller = Staff)]`
    holds every handler in the module to taking `Caller<Staff>` (a compile error at the handler
    otherwise). `examples/hello` reads its viewer this way and its account area says
    `caller = Viewer`.
64. `Middleware` and `App::middleware((RequestId, RateLimit))`: the app's own steps, run in order
    at one fixed place in every request (after the cross-site check, the deadline and the panic
    catch; before the handler, the error page, the security headers and `Cache-Control`). The
    tuple is resolved when the crate compiles; one that only passes the request on costs about
    230 instructions, where axum's `from_fn` costs about 700. `corten::middleware` lists the order.
65. Every route reaches the app through the same compile-time checks. `App::new` takes `Routes`,
    which a `#[corten::routes]` module's `router()` makes (`Routes::new()` for an app whose routes
    are all in areas and APIs), and `Area::route` and `Api::route` take `Methods`, which
    Corten's `get`, `post`, `put`, `delete`, `patch`, `head`, `options` and `trace` make
    (`corten::route`, the first four in the prelude), checking each handler as a routes module
    does: its result is an `Answer` and a `Public` answer's inputs are `Anonymous`. An axum
    `Router` or method router does not compile in any of them, so a route can no longer escape
    the answer, caller and cache checks by being registered by hand.
    The checks are at compile time: a page is 22,954 instructions after and 23,530 before, and a
    JSON 400 under `App::api` 28,268 after and 27,776 before (callgrind medians of three runs;
    the app guide's table has the rest).
66. `NoStore<A>`: an answer nothing may keep (`Cache-Control: no-store`), `NoStore<HtmlResult>`
    for a statement or a one-time code, in place of `Cache::no_store()`. A bare `StatusCode` is
    an answer too (`StatusCode::NO_CONTENT` for a write with nothing to say).
67. `#[derive(Fields)]` takes a struct with lifetimes or type parameters, so a query struct that
    borrows the page's values names its form's controls too, and `#[derive(Route)]` declares
    `#[serde(..)]`, so a link-only struct renames its parameters without a serde derive of its own
    ([#98 #[derive(Fields)] refuses a struct with a lifetime, so a borrowed query struct cannot name its form's controls](https://github.com/todd-skelton/corten/issues/98),
    [#99 #[derive(Route)] reads #[serde(rename_all)] but does not declare it, so a link-only struct must derive a serde trait](https://github.com/todd-skelton/corten/issues/99)).
68. `Route::at(id)`: a route with a place on its page, `/accounts/ada#review-7`, from the
    element's `#[derive(Id)]` type, for `req.redirect`, `req.moved`, `req.is_current` and
    `href={..}`, so a redirect after a write brings the browser back to what the user acted on.
    Text does not compile. A client navigation sent to a place gets `corten-location` (`fetch`
    drops a redirect's fragment), and the runtime fetches the page again when the server sends it
    to a URL that differs only in its `#id`, and scrolls to it (Firefox does not scroll to an
    `#id` the address already had). The runtime is 8,666 B gzipped, from 8,529
    ([#100 A typed route cannot carry a #fragment, so a redirect after a write cannot bring the browser back to the element it acted on](https://github.com/todd-skelton/corten/issues/100)).
69. `MonthStyle::{Short, Long}`: `t.date(at, MonthStyle::Long)` and `t.js().date(..)` write the
    month and year alone (`March 2025`) in each locale's order and words, checked against Intl
    like the other styles; `t.date_time` does not take one
    ([#101 t.date has no month-and-year style, so 'Member since March 2025' cannot be localized](https://github.com/todd-skelton/corten/issues/101)).
70. The error page takes extractors, as a handler does: `App::error_page(page, state)` takes
    `async fn(Failure, Req, ..) -> HtmlResult`, so it can take the caller
    (`Option<Caller<Viewer>>`) and draw the layout for who is asking. The lookup runs only for a
    failure, and an optional caller whose lookup fails is `None` there. A body extractor does not
    compile. Callgrind, per request: a page 21,100 -> 21,201 instructions, with a cookie 21,639 ->
    22,030, an unknown URL's error page 20,650 -> 26,122
    ([#88 An error page cannot show who is asking (App::error_page has no Caller), so a signed-in user's 404 is drawn signed out](https://github.com/todd-skelton/corten/issues/88)).
71. `Failure::Unidentified`: a caller whose lookup failed (`Refused::unavailable`) reaches the
    error page as its own case, not as a handler's 503 (`Failure::Failed`); an error page that
    names every case stops compiling until it says what to show
    ([#89 Refused::unavailable reaches the error page as Failure::Failed (503), the same as a handler's own 503](https://github.com/todd-skelton/corten/issues/89)).
72. `ReadAgain` reads a page at a place (`/saved#saved`, a write redirected to `route.at(..)`) again;
    it stopped after one read, since a navigation to the same address with a `#id` was taken for
    a scroll. The runtime is 8,670 B gzipped
    ([#107 ReadAgain never reads a page whose address has a #fragment, so a write redirected to route.at(..) stays on its catching-up state](https://github.com/todd-skelton/corten/issues/107)).
73. `corten new` writes `static/favicon.svg` (Corten's mark) and links it from the layout; the
    examples link the same icon.
74. `Public::shared(Duration)`: a shared cache's own lifetime (`s-maxage`) apart from the
    browser's, so a CDN can keep a slowly changing page for a day while a browser checks again
    after a minute. A response sent privately (a cookie, a client navigation) drops it with
    `public`
    ([#106 Public has no shared-cache lifetime (s-maxage) apart from the browser's, so a CDN cannot keep a page longer than a browser](https://github.com/todd-skelton/corten/issues/106)).
75. `ReadAgain { after }.from(&route)` in a patch: a `data-patch` write whose read is catching up
    answers in place, and the runtime reads the part again from `route` (`corten: action`) until
    it stops asking, instead of the handler waiting for the read or redirecting to a page only to
    show "saving". The reads stop when the part is replaced or the page changes, or when a read
    fails without a patch (the error page, offline), quietly: a handler that cannot read says so
    as a patch, which is applied whatever its status. `examples/hello`'s saved page has a form
    that does it. The runtime is 8,834 B gzipped
    ([#104 A data-patch answer cannot ask to be read again, so a write whose read is catching up has to navigate](https://github.com/todd-skelton/corten/issues/104)).
76. `App::task("refresh", |signal| async move { .. })`: work that lives as long as the app (a
    refresh loop, a queue consumer, a supervised child), started by `corten::serve`. Its `Signal`
    aborts with the new `Abort::Shutdown` when shutdown begins, and `serve` waits for it, up to
    `App::shutdown_grace` (5 seconds unless set), before it returns; one still running then is
    ended and logged by name, and so is one that panics. `App::router` starts none
    ([#116 Work that lives as long as the app (a refresh loop, a supervised child) has no signal, so shutdown neither stops it nor waits for it](https://github.com/todd-skelton/corten/issues/116)).
77. `#[derive(UrlValue)]` (in the prelude) on an enum of unit variants writes each variant as the
    word serde reads for it (its `#[serde(rename_all)]` and `#[serde(rename)]`), so an enum in a
    route's query or path needs no hand-written `Display` kept in step with serde. A variant with
    fields, one serde does not read, or a serde attribute it does not follow is a compile error; a
    test reads every word back through the query reader under each of serde's eight rules.
    `#[serde(..)]` values passed in by a `macro_rules!` are read by `ToJson` and `FromJson` too
    ([#129 A query value must be Display while it is read with serde, so an enum in an address spells its words twice](https://github.com/todd-skelton/corten/issues/129)).
78. `Area::deadline(..)` and `Api::deadline(..)`: routes slower than pages (an upstream that
    answers in minutes, a report, uploads) get a deadline of their own, or `None`, and every
    other route keeps `App::deadline`. In nested areas the innermost that sets one decides. The
    503 and `Abort::Deadline` are the same at every level
    ([#114 App::deadline is one value for the whole app, so one slow route (an upstream call, an upload) lifts it for every page](https://github.com/todd-skelton/corten/issues/114)).
79. `corten::serve_on(listeners, app)` serves an app on listeners of its own (anything that
    implements `axum::serve::Listener`: HTTPS with the app's TLS library, a Unix socket, a socket
    a supervisor hands over) with `serve`'s shutdown across all of them, and
    `corten::listeners(3000)` binds the ones `serve` uses (`HOST`:`PORT`, the loopback pair without
    `HOST`, the port given without `PORT`) for the app to wrap. `serve` is the two together, and
    an app with another default port serves `listeners(8320)` without setting `PORT` itself. The app guide shows HTTPS on
    loopback with `tokio-rustls`
    ([#115 corten::serve takes no listener, so an app that needs TLS or its own socket loses the loopback pair, the stream drain and graceful shutdown](https://github.com/todd-skelton/corten/issues/115)).
80. `corten::Elsewhere::at(&uri, "fee-calculator")`: a place on a page outside the app, which
    `req.moved` and `req.redirect` take, so a redirect to another site keeps its `#fragment`
    (an `axum::http::Uri` drops one it parses). The id is percent-encoded as the browser decodes
    it; a path in place of a full URL is a debug-build panic, since a place on the app's own page
    is `route.at(Id)`
    ([#123 An address outside the app cannot carry a #fragment, so req.moved and req.redirect drop the anchor of an external URL](https://github.com/todd-skelton/corten/issues/123)).
81. `t.percent(ratio, digits)` writes a ratio as a percentage in the locale (`2.9%`, `2,9 %`,
    `%2,9`), with at most `digits` fraction digits, and `t.js().percent(digits)` gives a script
    the same format (`@param {PercentFormat}`). The locale data carries each locale's percent
    pattern and grouping from CLDR, checked against Intl's `style: "percent"` with
    `maximumFractionDigits` on 40 values per locale (13 kept as the Rust and script tests' cases). The runtime grows by 99 bytes gzipped
    ([#119 i18n writes no percentage, so a rate like 2.9% cannot be localized](https://github.com/todd-skelton/corten/issues/119)).
82. `corten::ClientIp`: the visitor's IP address, for a handler that passes it to an API's
    per-client limit or limits by it. It is the connection's peer, or behind proxies the app lists
    (`Policy::proxy("10.0.0.0/8")`, `PROXIES`) the nearest `X-Forwarded-For` address that is not
    one of them; nothing reads the header otherwise. A `Public` handler cannot take it, and an
    answer that read it is private
    ([#120 A handler cannot read the client's address, so an app that calls an API for a visitor cannot pass it on for rate limiting](https://github.com/todd-skelton/corten/issues/120)).
83. `corten::form::Upload<T>` reads a form posted as `multipart/form-data`, which `Form` answers
    with a 415. It gives the files one at a time as they arrive: `next_file()`, then
    `chunk()` to pass a file on without holding it, or `bytes_up_to(max)` (`None` past `max`).
    Then `fields()` reads the text fields into `T` by `Form`'s rules. A file input is a `Files`
    field of the form struct, so markup, the files and `Errors` share its `FieldName`.
    `upload.limit(bytes)` bounds the whole body (2 MiB unless set; 413 past it). Types, counts
    and sizes per file are the handler's checks, reported as field errors. The parser is
    Corten's own, with no new dependency
    ([#140 A form cannot post a file: Form reads only URL-encoded bodies, so a multipart form is a 415 and nothing reads its files](https://github.com/todd-skelton/corten/issues/140)).
84. `#[corten::routes(api = ApiRoot)]`: an API's routes in a module of their own, each naming its
    handler as a page route does; the module gives `api(routes)` (`api(routes, state)` with
    `state = ..`) for `.api(prices::api)`. Only the prefix's route names no handler; a route with
    none, a route outside the prefix, or `area` and `api` together do not compile.
    `examples/item-page` serves its JSON and MCP endpoints from such modules and `bench/live` its
    publish route. The same JSON route costs the same either way: 21,913 instructions per request
    added by hand, 21,836 from its module (callgrind, median of three; the app guide has the
    ranges).
85. `Caller<T>` dereferences to `T`: `viewer.as_deref()` is the `Option<&Viewer>` a layout takes,
    without `viewer.map(|Caller(v)| v)`.
86. `.area(admin::area)` and `.api(api::api)` infer the prefix from the module's function; the
    `::<Admin>` turbofish is needed only for routes added by hand.
87. `corten::upgrade::Upgrade`: a route that switches its connection, as a WebSocket
    (`upgrade.websocket(run)`, the frames read by a library such as tokio-tungstenite) or a tunnel
    relaying an upstream's 101 (`upgrade.switch(headers, run)`). It is checked like any route
    (`Caller<T>`, the host check, the app's middleware), and its handshake as a write: another
    site's page gets a 403. The work runs on its own `Signal`, aborted at shutdown. Requests that
    do not switch run no new code (callgrind: 26,025,236 instructions for 1,200 requests in
    process, against about 26,030,000 on main). `corten::Relay` passes another server's answer on:
    its status, its headers less the hop-by-hop ones and its body as it arrives, never replaced by
    the error page or the JSON error
    ([#117 A route cannot be a WebSocket or pass an upstream response through](https://github.com/todd-skelton/corten/issues/117)).
88. An area with no page at its prefix: its module's prefix route names no handler
    (`#[route("/docs")] pub struct Docs;`) and is then only a `corten::Prefix`, with no `href`,
    so no link to the unserved URL compiles. `Area` and `Api` take any `Prefix`, which every
    `Route` is
    ([#152 An area with no page at its prefix (/items, /sets) must declare the prefix as a link-only route outside its routes module](https://github.com/todd-skelton/corten/issues/152)).
89. `Api::errors(|status, message| ..)`: the JSON every failure Corten answers under an API is
    written as, a `ToJson` of the app's, for an API that speaks another protocol's error shape
    (an Anthropic-compatible gateway). It covers unknown URLs, wrong methods, cross-site writes,
    the deadline, extractor rejections, `Caller` refusals and handlers' errors, keeping their
    headers; a handler's own JSON failure and a `Relay` pass through
    ([#163 An API cannot shape the failures Corten answers itself (404, 405, cross-site 403, Caller 401), so a gateway that must answer in Anthropic's error shape checks keys outside Caller](https://github.com/todd-skelton/corten/issues/163)).
90. `Option<Upgrade>`: `None` for a request that does not ask to switch, so one URL can be a
    WebSocket and a page (or a gateway's relayed answer); the handler returns `SwitchOr<A>`,
    whose failures are answered as `A`'s are. A request that asks is checked as `Upgrade`
    checks it. Routes that do not take it run no new code.
91. `corten::shutdown()`: the app begins the graceful shutdown a signal begins (tasks told, live
    streams ended, listeners closed, requests in progress finished, the grace), from a route a
    supervisor calls or a task. On Windows, `shutdown_signal` also ends on Ctrl-Break, the console
    closing and system shutdown, not only Ctrl-C
    ([#174 An app cannot begin its own graceful shutdown (a route, a task, a supervisor's request), and on Windows only Ctrl-C starts one](https://github.com/todd-skelton/corten/issues/174)).
92. `App::client_zone()` and `Option<ClientZone>`: a handler knows the visitor's time zone (the
    browser's IANA name, kept by the runtime in a `corten-zone` cookie from the first page it
    loads), so a picked date becomes its instant where the user is with no script per form, and a
    page writes times in their zone with the app's time zone library. `None` until the runtime has
    run; a bare `ClientZone` and a `Public` handler taking it do not compile. That cookie alone does
    not make a public page private. The runtime is 78 B larger (gzip)
    ([#149 A handler cannot know the visitor's time zone, so a picked date needs a script to become an instant and every date is written in UTC](https://github.com/todd-skelton/corten/issues/149)).
93. `Refused::message` and `Refused::too_many`: a `Caller` refusal tells a client that reads the
    failure why ("Invalid API key", in the API's error shape) and can be a 429 with `Retry-After`
    for too many failed attempts, so an API key check stays in `Identify`
    ([#177 A Caller refusal cannot say why (Invalid API key) or be a 429 for too many failed attempts, so an API key check stays outside Caller](https://github.com/todd-skelton/corten/issues/177)).
94. A `var(--x)` without a fallback in a listed stylesheet that no stylesheet on the same pages
    declares (the token file, a component's, a `.css` file in the static directory, an area's for
    its own pages) fails `App::router` and names the file and the property, so a misspelled
    token is not a wrong color found in a browser. Checked at startup, about 0.25 ms for 21 KB of
    CSS, since a component's stylesheet compiles without the theme
    ([#179 A stylesheet can use a token the theme does not define (var(--color-primary-contrast)), and nothing reports it until a browser draws the wrong color](https://github.com/todd-skelton/corten/issues/179)).
95. `Error::not_found()`: the 404 a handler answers for a record that is not there,
    `load(id).await?.ok_or_else(Error::not_found)?`, in place of
    `.ok_or_else(|| Error::status(StatusCode::NOT_FOUND))?` (or an app's own `fn not_found`).
96. `HtmlResponse::with_cookie(SetCookie)`: an answer that sets a cookie,
    `Ok(req.redirect(&url::Home)?.with_cookie(SetCookie::new("session", &token)))`, in place of
    `res.headers_mut().append(header::SET_COOKIE, cookie.header())`. The cookie is built by
    `SetCookie`, so its safe flags are the default.
97. `Req::patch_or(view, page)`: a `data-patch` form's answer both ways, the patch with JavaScript
    and `page()` (the page or a redirect) otherwise, in place of
    `if req.mode == Mode::Action { return req.patch(view); }`. Like `Req::invalid`, the page's
    closure runs only without JavaScript, so a patch never loads what only the page shows.
98. `corten::live_watch(values, since, cursor, view)`: a live stream of one value in a
    `tokio::sync::watch` channel, from where the page is: nothing until the next change when it
    shows the current version, the current value first when it is behind, then the latest after
    each change. It replaces about ten lines of `mark_changed`, `unfold` and `Fragment`.
99. `tokens!` gives each utility value a function named after its class: `mx_auto()` is `mx-auto`
    and `gap_3()` is `gap-3`, in place of `mx(Mx::Auto)` and `gap(Space::_3)`. The utility's
    function stays for a value chosen as the page renders and for one per breakpoint. Two that
    would share a name (utility `border-b`, and `border`'s value `b`) are a compile error that
    names both. The watchlist's home page renders in 1.1% fewer instructions (62,827 to 62,162).
100. A component can take an element id as a prop of any id type (`fn ConfirmDialog<I: Id>(id: I)`)
    and print it with `id={id}` or `commandfor={id}`: `Id` now requires `AttrValue` and `Render`,
    which every `#[derive(Id)]` type has. seller-desk opens its archive dialog with
    `command="show-modal"` and no script, sorts and filters its rows by the row view's fields
    (one handler per column) instead of cell positions, writes its unsaved-prices note from the
    catalog, names the prices' currency in their column, and right-aligns the statement's numbers.
    A row is 7 bytes smaller (603 to 596 at 2,000 rows) and about 30 instructions dearer to render
    (its name is now also a whole attribute value, the hole the sort reads).
101. `SetCookie::try_new(name, value)` returns `Err(InvalidCookie::Name | Value)` for a character a
    cookie cannot carry, where `new` panics: a token another service answered with no longer turns
    a sign-in into a 500 the app did not choose. `new` keeps its panic for values the app makes
    and calls the same rule
    ([#204 SetCookie::new panics on a value it cannot carry, so a token from another service can turn a sign-in into a 500](https://github.com/todd-skelton/corten/issues/204)).
102. A return address from outside the code: `corten::Local::parse(text)` keeps a path on this
     site only (one leading `/`, not `//` or `/\`, printable ASCII without `\`, so a control
     character a browser drops cannot make it another host, no `.` or `..` segment, and no
     percent-escaped letter, digit or `-._~` in the path, which Chromium would send unescaped), and
     `req.redirect(&local)` takes it. `req.serves(&local)` says whether the route the router picks
     for its path (the app's own or an area's, not an API's or Corten's) has a `GET` handler, so a
     sign-in no longer checks a return address against a list of prefixes kept by hand. A `Route`
     written by hand and given to `Area::route` must have a path of the shape `#[derive(Route)]`
     writes (whole-segment parameters, plain text), or the app does not compile
     ([#203 An app cannot ask whether it routes a path, so a sign-in's return address is checked against a hand-kept list of prefixes](https://github.com/todd-skelton/corten/issues/203)).
103. `#[derive(FromRef)]`, in the prelude: each field of the app's shared state gets axum's
    `FromRef`, so a handler takes `State<Market>` without a hand-written impl per part. Built on
    `proc_macro` alone (axum's derive needs its `macros` feature); two fields of one type are a
    compile error until one is `#[from_ref(skip)]`. The watchlist and card-market use it.
104. `req.nav(&route)` and `req.nav_section(&route)`: a nav link from one mention of its route,
    `<a {..req.nav(&url::News)}>"News"</a>`, writing `href`, `data-nav` and
    `aria-current="page"` on its own page. The route's URL is made once, written and compared,
    where `href={..}` and `aria-current={req.current(&..)}` made it twice; a tag that also writes
    one of those attributes, or `data-nav` by hand, does not compile. The watchlist and
    seller-desk use it.
106. A JSON answer with a status or a cookie of its own, and JSON the app already holds:
    `Json(value).with_status(StatusCode::ACCEPTED)` and `.with_cookie(SetCookie)` make a
    `JsonResponse` (the handler returns `Result<JsonResponse, JsonError>`), whose status and body
    reach the client as written, a `503 {"error":..}` of the app's own included; and
    `corten::json::Raw::new(bytes)` is JSON held as bytes (checked once to be one JSON value, an
    `InvalidJson` error otherwise), which `Json(raw)` sends with no serialization or copy and
    which a value `Json` writes copies in as it is. With `compress`, a `Raw` sent again is
    compressed once (brotli 9 and gzip 9, on one background thread) and later reads
    send those forms: on an 80 KB document, 15 ms once instead of 220 µs (zstd 1) to 2.1 ms
    (brotli 2) on every read, and 5,000 bytes instead of 6,992. Apps no longer write their own
    `Answer` for these. A held 80 KB document sent in its stored form costs about 24,100
    instructions a request (callgrind), where one compressed on each read costs 1.41 million.
    Every other answer reads `Accept-Encoding` once for both codings, as bytes, and costs what it
    did: 22,357 to 22,252 instructions for a small JSON answer, 99,935 to 99,940 for an 80-row
    one, 22,708 to 22,602 for text (two runs each against main)
    ([#201 A JSON route cannot answer with a status other than 200 or send JSON it already holds as bytes, so each app writes its own Answer](https://github.com/todd-skelton/corten/issues/201),
    [#234 A JSON answer cannot set a cookie the way an HTML answer can](https://github.com/todd-skelton/corten/issues/234)).
105. `t.parse_money(text, currency)`: money as a person types it in the reader's locale, read
    back into `Minor` units, what `t.money` writes: `$1,299.50` is `Some(Minor(129950))` in
    en and `1 299,50 $US` or `12,50` in fr, with or without the symbol, the code, the group
    separators or the fraction (every amount every locale writes reads back, as it is written
    and without its direction marks and no-break spaces). A sign, a group of the wrong size, a
    grouped number that starts with `0` (`0,500`), another locale's decimal
    separator, more fraction digits than the currency shows (`1.234` dollars, `1.5` yen) or an
    amount over `u64` is `None`. The watchlist's and seller-desk's hand-written cent readers are
    gone, and card-market's price alert no longer reads a float: `12,50` on the French page was
    refused and `1e3` was a thousand dollars, and its confirmation is in the reader's locale
    (`alert.set`)
    ([#208 Money typed into a form is parsed by each app, three different ways, and card-market reads it as f64](https://github.com/todd-skelton/corten/issues/208)).
107. A link to an element on the same page takes its `Id`: `href={FeedbackId.fragment()}` writes
    `#feedback`, encoded as `route.at(..)` encodes another page's place, so a validation
    summary's link and the field it names cannot drift apart. It is an attribute value
    (`view::InPage`), not an address: `req.redirect` to it does not compile, and neither does
    text in place of the id. Nothing `html!` writes changed
    ([#254 A link to an element on the same page cannot take an Id, so each app writes its #fragment by hand](https://github.com/todd-skelton/corten/issues/254)).
108. `corten_ui::dialog::modalClosedBy(target, close, signal)`: a dialog the address opens
    (`?selected=it_1`) is made modal as `dialog::modal` makes one, and a close request on it
    (Escape, Android's Back) goes to its close link's address (a ref; a button there does not
    compile) without a new history entry, back when the entry before is the list, so a reload or
    a redraw no longer opens what the user closed and Back cannot loop through it. A
    `cancel` from inside it (a file input's picker) is left alone, and without a script nothing
    changes. ui-gallery's last-sale sheet is tested in Chromium, Firefox and WebKit. Apps' own
    `cancel` scripts can go
    ([#257 corten-ui's dialog::modal closes a dialog the address opened without following its close link, so Escape leaves ?selected= behind](https://github.com/todd-skelton/corten/issues/257)).
109. `corten::Media`: bytes the app holds, sent as a media type the app names
    (`Media::new("image/png", bytes)`; the type is one the app names, read from the bytes, and
    is never the one a client sent with an upload). `Public::immutable(media)` is for a URL that
    names its content: every cache keeps it for a year, cookies or not, as Corten's versioned
    files are. It takes bytes only (a page or JSON changes with the deploy, so it does not
    compile), and its handler is held to `Public`'s rule, so one that could tell who is asking
    does not compile. Before it, a route could serve bytes it held only as an axum `Response`,
    which a route cannot name.
110. `corten_ui::CopyButton`: a button that copies an element's text (an order number, an API
    key's one-time secret; a read-only field's value). The element is named by its
    `#[derive(Id)]` id (`<code id={SecretId}>`, `<CopyButton text={SecretId} label={..}
    copied={..} />`), so the text is on the page once and a button in a list copies its own row's;
    text in its place does not compile. The button is drawn `hidden` and shown where the browser
    has the Clipboard API (a secure origin); after a write it reads the app's `copied` for two
    seconds in a polite live region, and nothing to copy or a failed write changes nothing. Tested
    in ui-gallery in Chromium, Firefox and WebKit: a copy (the clipboard's contents in Chromium,
    which lets a test read it), a denied write, no Clipboard API, and no script. Apps' own copy scripts can go
    ([#244 corten-ui has no copy-to-clipboard control, so each app ships its own script for Copy](https://github.com/todd-skelton/corten/issues/244)).
111. `corten::serve_wrapped(listeners, move |tcp| acceptor.accept(tcp), app)`: `serve_on` with a
    step of the app's own on each connection before HTTP, a TLS handshake. The step runs in the
    connection's own task, counts against `App::max_connections` from before the TCP accept, and
    is closed at `App::header_timeout` when the client stalls before or after it; shutdown ends
    the steps in progress. Before, an app serving HTTPS ran the handshake in a listener of its own
    (the guide's 45 lines), outside both limits, so clients that never sent a ClientHello held
    sockets and tasks with no cap. The library and its configuration (ALPN `http/1.1`) stay the
    app's; the guide's example is four lines. Checked with rustls: HTTPS answers, ALPN is
    `http/1.1`, and a client that sends nothing is closed at the header timeout. A plain
    connection costs about 340 instructions more to open: 27,528-27,543 to 27,841-27,910 for a
    connection with one request, client included (callgrind, in process, three runs each).
    Keep-alive requests cost what they did: 13,827-13,850 to 13,837-13,838
    ([#263 An app serving HTTPS copies the guide's TLS listener, and its handshakes are outside max_connections and header_timeout](https://github.com/todd-skelton/corten/issues/263)).
112. `Area::policy(|p| p.script_src(..).frame_src(..))`: an area's pages add to the app's
    Content-Security-Policy, so a payment provider's scripts and frames, or style attributes for
    sizes drawn from data, are allowed on the pages that need them and not on every other page.
    It only adds (`security::Sources`), nested areas add up, and each area's header is built
    once at startup. A client navigation into or out of such an area loads the page in full, since
    a document keeps the policy it loaded with; an area that adds only what the app has keeps the
    app's. A request finds its area's policy once, by path, and only when some area adds to the
    policy. Per request (callgrind, in process, 1,000 requests, median of three runs, range in
    parentheses), a page outside the area went from 19,695 (18,936-19,698) to 19,095
    (19,095-19,407) with no area policy and 19,122 (19,020-19,728) with one, and a page in the
    area from 19,792 (19,786-20,696) to 20,042 (20,018-20,042), and 20,511 (20,083-20,733) under
    its policy. The same build moves by up to 760 between runs, so only the last, about 500 to
    700 more for a page under an area's policy, may be more than noise
    ([#275 A policy is the whole app's, so the origins one page's payment SDK needs are allowed on every page](https://github.com/todd-skelton/corten/issues/275),
    [#139 A size or position drawn from data needs style attributes, and allowing them opens style-src-attr 'unsafe-inline' for the whole app](https://github.com/todd-skelton/corten/issues/139)).
113. `corten_ui::Copied` (`ui-copied` in the page): `CopyButton` dispatches it after a write the
    browser made, and only then, so an ancestor counts a copy (a referral link's, a share link's)
    with `on:Copied={js::counted(event)}` instead of keeping a copy script of its own. It bubbles
    and carries nothing, since the text may be a secret. ui-gallery counts its SKU's
    copies: one for a copy, none for a denied write. `copy_button.js` is 2,457 bytes, 904 with
    brotli (was 2,223 and 844), and a page with the button fetches `events.js` with it, preloaded
    beside the script so it adds a request but no round trip (276 bytes, 176 with brotli, in
    ui-gallery)
    ([#294 CopyButton tells the app nothing when it has copied, so a copy that is counted keeps its own copy script](https://github.com/todd-skelton/corten/issues/294)).
114. A time relative to now: `t.relative(at, now, RelativeStyle)` writes "in 10 hours" or "3 hr.
    ago" in the request's locale (each locale's plural forms and words from CLDR, checked against
    Intl), and `corten_ui::RelativeTime` keeps it current in the browser on one timer for the
    page, so a live stream no longer redraws every second or resends its part each minute to move
    a countdown. Each locale an app lists adds about 2.3 KB of pointers and 0.4 to 3 KB of text;
    the script is 1.8 KB brotli (5.3 KB as written; component scripts are not minified), on pages
    that use it
    ([#202 A page cannot show a time relative to now that stays current, so a live stream redraws every second and resends the whole part each minute to move a countdown](https://github.com/todd-skelton/corten/issues/202)).
115. `Public::header::<XRobotsTag>(value)`: a header of the app's on any public answer (text,
    `Json`, `Media`, a page), named by a type (`corten::answer::Header`; Corten names
    `XRobotsTag`, `Link` and `ContentLanguage`). The answer is compressed
    and shared as it would be without it. Before, a shared file that had to stay out of search was
    a `Relay`, never compressed (Chase Sets' developer manifest: 161,815 bytes against 19,737 with
    brotli), or an answer type of the app's own. `set-cookie`, the headers Corten sets itself
    (caching, a CDN's `*-cache-control`, CORS, security), those the answer has (`content-type`,
    `location`, `content-disposition`) and the connection's do not compile. A public answer that adds none costs about 30 instructions more per request,
    18,404-18,417 to 18,434-18,459 for a public text answer (callgrind, in process, 1,000
    requests, three runs each); the headers are held behind an `Option<Box<..>>`, since a `Vec`
    in place cost about 50 (18,450-18,467)
    ([#287 A Public answer that is not a page cannot take a header of the app's, so a noindex file is an uncompressed Relay or the app's own answer type](https://github.com/todd-skelton/corten/issues/287)).
116. `Params<R>`: a route's handler reads the route's own parameters back, `Params<url::Item<'_>>`.
     It has the struct's fields, owned (a `&'a str` or `Cow<'a, str>` is a `String`, a `&'a [T]` a
     `Vec<T>`, any other `&'a T` a `T`; a link's field still needs only `Display`), read
     the way a link writes them: a path parameter percent-decoded, a query parameter by the name
     serde reads (`rename`, `rename_all`; `None`, empty or the field's `#[serde(default)]` when the
     link leaves it out), a `#[route(query)]` set from the whole query, a `#[route(prefix = ..)]`
     map from its prefixed keys. A request whose parameters do not fit is a 400
     (`ParamsRejection`). A route with a serde key links do not follow (`alias`, `flatten`,
     `skip`, `with`, `default` on the struct and the like) or a borrowed `#[route(query)]` set
     still writes links, but taking its `Params` does not compile. In a
     `#[corten::routes]` module, a handler of a route with a parameter in its path that does not
     take its own `Params` (one that reads the path with axum's `Path`, or another route's
     `Params`) does not compile (`compile_fail` doctests). On the request path it costs what
     `Path<String>` did: the item page 82,041 to 81,975 instructions per request (the mean of three
     runs on main, which spread over 425, and two here) and its JSON 57,687 to 57,680 (callgrind,
     release, the benchmark fixture) ([#207 A handler reads its path parameters with Path<String>, so nothing checks them against the route struct that declares them](https://github.com/todd-skelton/corten/issues/207)).
117. `corten_ui::CheckboxGroup`: checkboxes of one name of which at least one must be checked
    (`<CheckboxGroup legend=".." missing="Choose where you ship.">`). While none is, its script
    keeps the first enabled box invalid with the app's message, so the browser stops the submit and says so
    at the group, as for a required text field; HTML's `required` on a checkbox means that one box.
    Without the script the form is sent and the handler refuses it, as before. 914 bytes, 379
    with brotli, on the pages that use it
    ([#272 A group of checkboxes cannot require one to be checked without a script, so a form that needs a choice is sent with none](https://github.com/todd-skelton/corten/issues/272)).
118. `corten_ui::RequiredWhen`: fields required only for some values of another field (a refund
    amount for a partial refund), `<RequiredWhen control={f.kind} values={&["partial"]}>`. The
    control is a `FieldName`, so a misspelled one does not compile, and its values are a
    `string[]` parameter, which a handler call now checks and fills from a slice, an array or a
    `Vec` of strings in every build (before, only as an unchecked JSON value with feature `json`). While the control has one of
    the values every field in the set is `required`; for any other the set is disabled, so it is
    neither checked nor sent; an app hides it with `:has` on the control, which holds before the
    script runs. Without the script the
    fields are optional and the handler checks the rule. 1,906 bytes, 678 with brotli, on the
    pages that use it. ui-gallery's listing shows both (where it ships, and the lowest offer when it
    takes offers), and its handler refuses what the browser would have stopped
    ([#269 A field required only for one choice of another field needs a script, so the browser cannot check it before the form is sent](https://github.com/todd-skelton/corten/issues/269)).
119. corten-ui's `PrintButton` opens the browser's print dialog. It is drawn hidden and its script
    shows it, so without a script there is no button that does nothing, and the browser's Print
    command still prints the page. Its script is 736 bytes (too small to compress), on the pages
    that use it. The styles guide's new Printing section covers paper sizes: named `@page` rules
    in a component's own stylesheet, scoped `@media print` rules, and layout chrome that hides
    itself. **Breaking:** in a component's stylesheet an `@page` with no name (which sets every
    page the app prints) does not compile, and a page's name starts with the component's
    (`@page packing-slip-thermal`), so two components cannot set one page
    ([#311 corten-ui has no Print button, and the guide does not say how a page prints at its paper size](https://github.com/todd-skelton/corten/issues/311)).
120. An area can loosen `Cross-Origin-Opener-Policy` for its pages only: `Sources::allow_popups()`
    (`same-origin-allow-popups`) and `Sources::allow_cross_origin_opener()` (`unsafe-none`, which
    Stripe's Connect embedded components need for their sign-in popup), and
    `Policy::allow_cross_origin_opener()` for the whole app. The rest of the app keeps
    `same-origin`, and a page under another opener policy has its own shell key, so a client
    navigation into or out of the area loads the document in full
    ([#318 An area cannot relax Cross-Origin-Opener-Policy, so a page that embeds Stripe Connect breaks its sign-in](https://github.com/todd-skelton/corten/issues/318)).
121. `req.nav_of([(NavTo::section(&url::Desk), "Seller Desk"), (NavTo::page(&url::Money), "Money"), ..])`
    writes a whole nav's links, each with its item, and marks only the deepest entry that holds the page, for a nav whose entries nest or
    come from data (an entry is a route or a `Local`, whose path is written as the browser asks
    for it). Its links name their group (`data-nav-group`), and the runtime ranks the same links
    after a client navigation wherever the markup puts them; a `req.nav` link is still judged
    alone. `corten.js` grows 80 bytes gzip
    ([#341 A nav built from data, or whose current entry is the deepest that holds the page, keeps the first page's aria-current after a client navigation](https://github.com/todd-skelton/corten/issues/341)).
122. `ReadAgain { after }.without_javascript()` asks only a browser without JavaScript to read the
    page again: for a page whose changing part a `<corten-live>` relays while a job runs, which
    with JavaScript keeps itself fresh, and which reading whole would only make open its stream
    again. It writes the `<noscript>` refresh without the mark the runtime reads; the runtime
    is unchanged
    ([#319 A page relayed by <corten-live> cannot ask a browser without JavaScript to read it again](https://github.com/todd-skelton/corten/issues/319)).
123. A script that imports another script module of its directory (`import { loadStripe } from
     "./stripe.js"`) has it preloaded on the pages that load it, with what that one imports, so the
     browser fetches them together instead of one round trip after the other. The tag is made
     when the app starts, so a page costs nothing more to render: one import over a 100 ms
     round trip ran at 245 ms instead of 342 (Chromium, median of 10 cold loads, a local server
     delaying each answer 100 ms). An import of a module the app does not list is a startup
     error that names both (it was a 404 in the browser). The preload helps a full page load; a
     client navigation still fetches a new module's imports after it. The scripts guide describes
     relative imports
     ([#307 A script's relative import of another script module is not preloaded, so the page waits a round trip for it, and the guide does not describe it](https://github.com/todd-skelton/corten/issues/307)).
124. Middleware for part of the app: `Area::middleware` and `Api::middleware` run after the
     app's middleware for each request at the area's or API's prefix (an outer area's before an
     inner one's, then an API's under it, each in the order given), so a rate limit picks its
     routes by where they are, never by a path the middleware compares. A middleware refuses with
     a `Refused` (`Refused::too_many(wait).into_response()`), answered in the request's mode as a
     `Caller`'s refusal is, `Retry-After` included, and the default error page says "Too many
     requests" for a 429. It reads the client's address with `ClientIp::of(&mut req)` without
     splitting the request. card-market's write limit is now on its item pages' area and its
     partner API, with no path checks
     ([#327 Middleware is app-wide only, so card-market's write limit picks its routes by comparing paths and builds its 429 by hand](https://github.com/todd-skelton/corten/issues/327)).
     Measured per request (callgrind, release profile, 5 runs): an app whose areas and APIs have
     none runs 19,976 to 19,988 instructions against main's 19,696, all of it in glibc's
     allocator: the allocations are the same (count and sizes, DHAT) and Corten's own code is
     within 18 (13,971 against 13,953). A request in an area with a pass-through middleware runs
     21,374 to 21,511 against 20,497 to 20,646 with none (one boxed future), and one outside it
     19,909 to 19,913.
125. `t.change(ratio, digits)` and `t.js().change(digits)`: a ratio as a change (a price's move
    today), with exactly `digits` fraction digits and a sign on a gain as on a loss, none on what
    rounds to zero (`+0.60%`, `-0.30%`, `0.00%`; `+0,60 %` in fr, `+%0,60` in tr), as Intl's
    `signDisplay: "exceptZero"` writes it, so a column of them lines up. Each locale's data gains
    the template for a gain; the script's format is a `PercentFormat` with that third template,
    and `scripts/format.mjs` checks it on the same cases as the server (Intl wrote them). watchlist's
    Today column uses it. `change`, `percent`, `parse_money` and `relative` join the message keys
    `messages!` refuses at the top level, since they are its methods (`button.change` is fine)
    ([#331 Polish: watchlist's phone header wraps, and the Today column changes its decimals](https://github.com/todd-skelton/corten/issues/331)).
126. `Media::attachment(name)` and `Media::inline(name)`: a download names its file on any answer,
    private ones included (a user's export), where only a `Public` answer could before. The name
    is written as `filename="cards.csv"` when it is plain ASCII, and otherwise with
    `filename*=UTF-8''..` (RFC 6266) after a `filename` with `_` for each other character, so a
    quote, a backslash, a `%`, a `?` or a line break in a user's file name cannot end the header,
    add a parameter or be decoded as another name. It is the one way to name a download:
    `Public::header` refuses `content-disposition` when the app builds (Added 115). The guide
    says to link to one with `download` (or `data-reload` for a file the browser shows), so the
    runtime does not fetch it on hover and again on click
    ([#364 A private download cannot name its file: Content-Disposition is only on Public answers](https://github.com/todd-skelton/corten/issues/364)).
    No existing answer changes; naming a file costs one header on that answer.
127. `Signal::finish(|signal| async move { .. })`: work a handler must finish (claim, call,
    release) runs to its end even if the handler is dropped, with a signal of its own that aborts
    when the request's does or shutdown begins, so a slow step stops early and the release after
    it still runs; `serve` waits for it at shutdown within `App::shutdown_grace`. The cancellation
    guide no longer says awaited work needs no thought: a drop cannot run async cleanup
    ([#372 A handler dropped when its client leaves cannot release what it holds, and the guide says work it awaits needs no signal](https://github.com/todd-skelton/corten/issues/372)).
    A request that does not call it runs no new code: the app's `Shared` gains one pointer, last,
    read only by `finish`. A plain GET through the router took 16,673 to 17,022 instructions
    before and 16,864 to 16,866 after (callgrind, release build, 5 runs each); the before runs
    vary more than the two differ.
128. `examples/auction-room`: a live card auction. Signed-in people bid on the same lots at once;
    bids are kept in SQLite and checked in one transaction (refused below the price and the step,
    or after the end, and written once per submit key), every page watching a lot sees it change,
    and the outbid bidder alone is told, on every page they have open. Its `Identify`s refuse with
    `sign_in`, `forbidden` (a bidder at the house's desk, the house bidding) and `unavailable`
    (the store is down); its bid and sign-in limits are areas' middleware refusing with
    `too_many`; it works without JavaScript; and its smoke has two bidders in two browsers bidding
    against each other
    ([#337 No example shows several signed-in users in real time with stored data: a live auction room](https://github.com/todd-skelton/corten/issues/337)).
129. `on:document:keydown={js::shortcut(event, ..)}`: a component's handler for an event anywhere
    on the page while the component is on it, so a screen's shortcuts work wherever focus is
    (the page's background, a button) without `document.addEventListener`. It runs after the
    handlers on the event's path, each as its own listener on the document (one stopping the
    event does not keep it from another's), its arguments are read for each event and typed by
    the event (`KeyboardEvent`), and it ends when its element leaves the page. An event that
    does not bubble to the document (`focus`, `mouseenter`), `connect` and a typed event do not
    compile, so a page-wide handler that would never run is a build error. watchlist pauses its
    prices on `p`
    ([#365 A component cannot take keys on the whole page, so work-screen shortcuts call document.addEventListener outside the handler model](https://github.com/todd-skelton/corten/issues/365)).
    A page without one checks one empty set per bubbling event it listens for.
    The minified runtime grows by 280 bytes (25,133 to 25,413), 84 gzipped (9,165 to 9,249)
    and 61 with brotli (8,287 to 8,348).
130. A feed's `snapshot` handler gets the feed's generation as a third argument,
    `snapshot(rows, seq, epoch)`, so a script that uses `seq` as a version can tell a restarted
    feed's `seq` from its own (`docs/guide/live-data.md`).
131. `examples/deck-builder`: a rich client-side screen. A player builds a 40-card deck from a
    collection of 240 by Add, Add selected, drag and drop or the keyboard (Space to pick up, the
    arrows, Space to drop, Escape to put back, each said aloud), with the count, the cost curve and
    the kinds drawn at once, undo and redo (buttons, Ctrl+Z and Ctrl+Shift+Z through
    `on:document:keydown`), and filter and sort in the page. Every change is saved as it is made,
    one save at a time, with the deck's version (its feed's generation and number): a save the rules refuse is rolled back with the
    reason, a stale one (another tab saved first, which its feed shows) lets the player keep both
    changes or take the other tab's deck, and a save that could not be sent, or whose answer was lost, is sent again with its submit key.
    Without JavaScript the same page posts the deck, and the filter and sort are links and a GET
    form ([#336 No example shows a rich client-side screen: a deck builder](https://github.com/todd-skelton/corten/issues/336)).
132. A navigation marks the link or GET form that started it `aria-busy="true"` for as long as it
    marks `<main>`, as a `data-patch` form already was, so a page shows which control is working
    with CSS alone (`docs/guide/requests-and-forms.md`). Both marks now last until the new page is
    swapped in (`<main>`'s ended when the answer's headers came) and stay through a redirect;
    when another navigation replaces one, the first one's marks go at once and the newer one's stay
    ([#422 A navigation marks only main as busy, not the link or GET form that started it, so a page cannot show which action is on its way without a script](https://github.com/todd-skelton/corten/issues/422)).
    The minified runtime grows by 374 bytes (25,510 to 25,884), 124 gzipped (9,278 to 9,402) and
    115 with brotli (8,381 to 8,496).
133. `t.signed_money(amount, currency)` and `t.js().signed_money(currency)`: an amount with its
    sign, as Intl's `signDisplay: "exceptZero"` writes it (`+$3.20`, `-$1.23`, `$0.00`, `+3,20 $US`),
    for a difference between two amounts, the same on the server and in scripts. It uses the
    locale data already shipped: a gain is the loss's template with the plus sign in place of the
    minus, which `scripts/locale-data.mjs` checks against Intl for every locale and currency
    (`docs/guide/views.md`, `docs/guide/scripts.md`). `examples/watchlist` shows today's move in money
    beside the percent, written by the server and kept current by its script. `t.money` itself is unchanged: about 934
    instructions per amount before and after under callgrind (three runs each of 1,200 less 200
    formats; 931.5 to 934.7 before, 933.8 to 933.9 after). `format.js` grows by 48 bytes
    minified (2,487 to 2,535) and 20 gzipped (1,240 to 1,260)
    ([#419 Money cannot be formatted with its sign (+$1.23), on the server or in scripts, so a difference between amounts hand-builds the sign twice](https://github.com/todd-skelton/corten/issues/419)).
134. `#[derive(Href)]` on an enum whose variants each hold a route (an app's screens) makes it a
    link, `href={screen}`, and a component several pages draw takes where its links and forms go
    as `&dyn Href`, so each page passes its own typed route instead of a `String`; a unit variant
    and text where a `&dyn Href` goes do not compile. A `Local` or `Uri` written this way is
    escaped for the attribute. The views guide says how a shared list takes its links and a
    per-row part. A redirect costs what it did: a redirect to a `Local` measured 19,241-19,260
    instructions before and 19,084-19,228 after, one to a route 18,110-18,277 and 18,258-18,316
    (callgrind, 3 runs each)
    ([#361 A value that is one of several routes (an enum of screens) implements Href but cannot be written as href={..}](https://github.com/todd-skelton/corten/issues/361), [#391 A component several pages render cannot take a route as a prop (Href is not dyn-compatible), so a shared list's form action and column links are Strings](https://github.com/todd-skelton/corten/issues/391)).
135. `Sources::referrer(Referrer::NoReferrer)` (also `StrictOrigin`, `SameOrigin`) makes an area's
    `Referrer-Policy` stricter, so a page whose address carries a secret (a consent token, a reset
    link) does not send it with the requests it makes; `Policy::referrer` does it for the app. There
    is no looser value; nested areas send the least any of them allows, and a changed policy gives
    the area its own shell key, and an `App::api` under the area sends it too. An answer that brings
    a policy of its own (a relayed redirect) sends the least of its and the area's, its lines read
    as the browser reads them. Choosing the header per answer, and reading every line
    of one the answer brought, costs a plain GET about 75 instructions (20,351-20,358 to
    20,427-20,432 under callgrind, 3 runs, about 0.4%)
    ([#390 A page or a relayed answer cannot choose a stricter Referrer-Policy: Corten replaces it on every answer](https://github.com/todd-skelton/corten/issues/390)).
136. `corten::Within` is exported beside `Errors`, so a field helper several forms share takes the
    form's scoped errors without reaching into `corten::form` ([#451 form::Within is not re-exported
    beside Errors, so a field helper shared by several forms must find
    corten::form::Within](https://github.com/todd-skelton/corten/issues/451)).
137. A submit refused for the state it was made against, not its input (a stale revision, a step
    already taken), is `errors.refuse(Refusal::Conflict, message)`: `req.invalid` answers it with
    409 (or 410 for `Refusal::Gone`) in every mode, the form drawn again with what the user typed
    and the message at its top, and data clients get the same status in the Problem Details
    document. `Refusal` is a closed set of 4xx refusals, so a 2xx or a 5xx does not compile ([#438 A
    post refused for a reason that is not a field (a stale revision, a step out of order) has no
    answer, so each screen draws its page and sets a 409 on the raw
    response](https://github.com/todd-skelton/corten/issues/438)).
138. `PageOr<Media>` and `PageOr<Relay>`: a route that sends a file answers the page, or a redirect,
    instead when it refuses (a download posted at a stale revision), each `.into()` the answer,
    private like any page and `Public` with a page made for everyone
    ([#415 A handler that answers a file cannot answer a page or a redirect when the file is refused](https://github.com/todd-skelton/corten/issues/415)).
139. `#[route("/{*rest}", any = relay)]`: one handler for every method of a route, those the app
    never names included (`OPTIONS`, `PROPFIND`), for an app moved onto Corten a slice at a time
    that relays the rest to its old server, which then answers them instead of Corten's 405. It is
    the route's only handler (naming another method beside it does not compile). A route with a
    parameter still holds its handler to taking its `Params`: one relay for several catch-alls is
    generic over the route (`async fn relay<R: FromUrl>(_: Params<R>, req: Request)`), and the
    compiler picks the route at each name, so no wrapper per route with a parameter is needed
    (a route without one has no `Params` and takes a handler without them). A path the app
    routes itself keeps only the methods it names. Routes without `any` route and cost as
    before
    ([#360 A catch-all route's handler must take that route's Params, so one relay cannot serve several routes or every method](https://github.com/todd-skelton/corten/issues/360)).
140. Plural messages: `"cards_one"` and `"cards_other"` (the suffixes i18next uses) are one
    message, `t.cards(count)`, which picks the form by the count's CLDR plural category in the
    locale and writes the count as `t.number` does; `t.js().cards()` picks it in the browser the
    same way (`format.js`, checked against Intl for every locale). A catalog without a form its
    language uses (French's `_many`), with one it never uses (English `_zero`), or without
    `_other` does not compile. Breaking: a key ending in `_zero`, `_one`, `_two`, `_few`,
    `_many` or `_other` is a plural form, so `t.cards_one(..)` and `t.cards_other(..)` become
    `t.cards(count)`. Measured: `corten-format` grows from 2,535 to 3,008 bytes (1,260 to 1,475
    gzipped); a `t.js()` plural sends the locale's plural table with its forms (seller-desk's
    grid, which sends one to two handlers, is 502 bytes more per page; its whole page 474 bytes
    raw, 37 gzipped, 15 brotli); seller-desk's `render_cost` under callgrind is 2,026,886,533 instructions
    on main and 2,029,845,444 here (median of 3, +0.15%), and a plural `ItemCount` 1,648.5 per
    render against 1,636.5; the examples' `count == 1` choices are gone and card-market's French no longer
    writes "1 annonces"
    ([#393 Catalogs have no plural rules, so apps pick a form with count == 1 and card-market shows "1 listings"](https://github.com/todd-skelton/corten/issues/393)).
141. `corten dev`, `fmt` and `check` notice when the app's `Cargo.lock` pins another corten than the
    one they were built from (a git revision or a release) and say so before running, with the
    `cargo install` command for the matching one; they ran with the old behavior silently, and
    `check` failed on `cargo fmt --check` with no reason. The command records the commit it is built
    from (`corten --version` prints it), read from `.git` or a published package's
    `.cargo_vcs_info.json`, standard library only. A path dependency is not compared
    ([#458 The corten CLI does not notice it is older than the corten the app pins, so fmt and check silently use old behavior](https://github.com/todd-skelton/corten/issues/458)).
142. Groups and rows of form fields. `#[fields(group)] ship_to: Address` puts a `Fields` struct in a
    form, its fields posted as `ship_to.street` (`f.ship_to.street`), so a field group is defined
    once and a form can hold two of one type. `#[fields(rows)] #[serde(default)] domains:
    BTreeMap<Domain, DomainLimits>` is one group per row, each field named by the row's key,
    `f.domains.at(&Domain::SellerPortal).max_concurrent`, posted as
    `domains[seller-portal].max_concurrent`: the key, not the row's place, joins a row's values, so
    a row left out shifts nothing and an unchecked checkbox is `false` in its own row, and an error
    on one row's field marks that input only, with its own message id. `at` takes only the map's key
    type (a `RowKey`: text, an integer, or a `#[derive(UrlValue)]` enum, by its word); a key's other
    characters are %-encoded. A group of groups, rows in a group or a row, rows without a default, a
    group that is an `Option`, and a row key an enum reads by more than its word (`alias`, `other`)
    do not compile, and neither does a `UrlValue` enum with two variants written as one word. `Form`
    and `corten::form::from_bytes` read both with Corten's own form reader. `#[fields(map)]
    #[serde(default)] counts: BTreeMap<Sku, u32>` is one plain value per key, `f.counts.at(&sku)`,
    posted as `counts[sku]`, with its own error. Plain forms pay for it: reading a form of three
    plain fields costs 3,332 instructions where it took 3,110, and refusing one whose number does
    not parse 5,401 where it took 5,176 (callgrind, release build, 3 runs each); a row's error is
    found by its key, so many rows' errors do not cost each other
    ([#366 A form with the same fields on each row cannot name a row's field or give it its own error](https://github.com/todd-skelton/corten/issues/366), [#363 #[derive(Fields)] refuses #[serde(flatten)], so a field group shared by forms (an address) is copied into each form](https://github.com/todd-skelton/corten/issues/363)).
143. `Req::invalid_with(&errors, form, page)`: a refusal whose form needs a read of its own reads it
    only for the patch, through a `FormPatch` that draws a patch and nothing else (a page there does
    not compile), and the page side only for a browser without JavaScript; a data client gets the
    Problem Details document with neither, as from `invalid` (feature `json`). An app no longer branches on
    `req.mode` for such a refusal and loses the JSON answer
    ([#468 req.invalid takes the refused form's patch already drawn, so a patch that needs a read is read for the no-JavaScript page too](https://github.com/todd-skelton/corten/issues/468)).
144. `DayStyle` for `t.date` and `t.js().date`: the month and day without the year, `Short` (`Mar
    2`) and `Long` (`March 2`), written as Intl writes `{ month, day }` in each locale's order and
    words (`2 mars`, `2. März`), for a chart's axis, a week's row or a timeline whose year the page
    says once; like `MonthStyle`, `t.date_time` does not take it. The locale data gains two patterns
    per locale (from Node's Intl, checked against it, and in the cases the browser's `format.js` is
    checked with); no other format changes
    ([#473 t.date has no month-and-day style without the year (Intl { month: 'short', day: 'numeric' }), so chart labels hand-build month names](https://github.com/todd-skelton/corten/issues/473)).
145. A handler parameter typed by a declaration `corten::types` generated
    (`@param {import("../types/app").SortBy} by`, or a `@typedef` of it) takes a value of the Rust
    type of that name in the component's module, so `js::sortBy(target, SortBy::Price)` compiles
    and `42` or `"prodcut"` do not: one handler serves every name of a fixed set, and a renamed
    variant fails to build. A call to a handler whose parameter is a string literal union
    (`@param {"name" | "price"} by`) no longer compiles, since it took any value; the error and a
    warning on the call say to make it a Rust enum with a generated declaration, and so does a
    list or a generic of one (`Mode[]`, `Record<Mode, number>`, `[Mode, number]`, `{ m: Mode }`):
    any string literal in the parameter's type counts, outside `import("..")`, `Message<..>`, a key
    (an object's, an indexed type's, the keys and members `Pick`, `Omit` and `Exclude` take) and a
    callback's parameter names; a set in a template literal's `${..}` counts. The script still compiles, so an export only other
    scripts import types its parameters as it needs. A `@typedef` of
    any type but an object or a generic one (`@template`) (`Tab | null`, `Tab[]`, `string`) is
    checked as the type it names where a handler takes it, through any number of typedefs, and a
    generated declaration a handler's parameter holds in a shape the call is not checked against is
    refused rather than taking any value, in any shape of a typedef of plain values that holds one;
    a typedef the script keeps for itself is not checked. Typedefs that refer to each other (a
    recursive `Json`, a `Tree` and `Forest`) are seen through as one, and each typedef is
    written out once, so a recursive one, a long chain or a type with thousands of declarations
    costs the macro no more than another.
    What the page gets is unchanged
    ([#362 A handler argument typed by a generated enum union takes any JSON value at the call](https://github.com/todd-skelton/corten/issues/362)).
146. A route costly to draw says `#[route("/reports/suggested", get = suggested, prefetch = false)]` (`Route::PREFETCH`), and every link to it, `href={..}` with the route or a `&dyn Href` holding it, is written with `data-no-prefetch`, so hovering it starts no work and only a click does; the route says it once instead of each link. The runtime now aborts a prefetch it drops (the 8-newest limit, a stale entry, a form post, a visit left before the prefetched answer is used), so the server sees the client go instead of drawing the page to the end, and the views guide describes prefetch, `data-no-prefetch` and `data-reload`. The minified runtime grows by 83 bytes (26,536 to 26,619), 29 gzipped (9,642 to 9,671), 33 with brotli (8,709 to 8,742). The item page's render runs 0.11% more instructions (median of 3, callgrind, release build: 35,623,327,994 against 35,584,847,328 on its base), the check each link makes of its route's `PREFETCH`.
    ([#421 Hover prefetch starts a costly GET page's work; the data-no-prefetch opt-out is undocumented, per link, and a discarded prefetch never aborts](https://github.com/todd-skelton/corten/issues/421)).
147. `Refusal::Upstream`: a submit refused because a service the handler calls failed or did not
    answer (a carrier, a payment provider, another app), answered by `req.invalid` and
    `req.invalid_with` with 502 in every mode: the form drawn again with the message, the page
    without JavaScript, the Problem Details document for a data client, which got the HTML page
    from a handler that set the status by hand. The retry is the same submission: the runtime now keeps a form's
    `SubmitKey` over the key a patch draws (a 5xx patch used to swap in a fresh one, so a retry of a
    write that did apply upstream applied twice), and `SubmitKey::again` draws the posted key into
    the form a browser without JavaScript gets. The minified runtime grows by 172 bytes (26,619 to
    26,791), 36 gzipped (9,671 to 9,707), 29 with brotli (8,742 to 8,771). An agent tool gets the message as `ToolError::Upstream` ("try again later"),
    not as a refusal of a stale state. Still a closed set: no other 5xx, and no `StatusCode`. An
    app's exhaustive `match` on `Refusal` or `ToolError` gains an arm
    ([#480 A post refused because a service it calls failed has no Refusal (502/503), so it cannot use req.invalid_with and a JSON client gets the HTML page](https://github.com/todd-skelton/corten/issues/480)).
148. `corten::form::keep_query(&at, html! { controls })`: a GET form's controls, then the
    rest of a typed route's query as hidden inputs, for a form that changes some of its fields (a
    GET form sends only its own controls and drops its action's query). Every key of the route's
    query that no control names (a field, a `#[route(query)]` set's key, a `#[route(prefix)]`
    entry) is kept, written as the route's links write it, so there is no list of names: a key is
    neither dropped nor sent twice, and a field the route gains is kept by every such form, where a
    hand-written list silently dropped it. It costs a form about 3.5 µs where hidden inputs
    written by hand cost about 0.5 µs (release build, 200,000 renders, 3 rounds: it writes the
    route's address again and reads it back); nothing else renders differently
    ([#439 A GET form that changes some of a typed route's query fields must write every other field as a hidden input by hand, and a missed or doubled one compiles](https://github.com/todd-skelton/corten/issues/439)).
149. corten-ui's `ChoiceGroup` and `ShownFor`: one choice (a radio group) whose value shows and
    hides parts anywhere on the page, the figures and, below a chart, the list worded from them.
    Both take a `Chosen { id, value }`, the choice's `#[derive(Id)]` id and the value the handler
    read, so a part's values are the choice's type (another enum's word does not compile) and its
    group cannot be text. The server checks the value and draws every part for another `hidden`;
    without JavaScript each option is a typed link to the page with that choice; with it, the arrow
    keys and Space choose in place, the address follows in the keys the options differ in (another
    control's, a tab's, stay), and every part, also one a patch adds later, follows the choice. No
    stylesheet repeats the server's values. `TabGroup`'s address now follows the same way, in the
    keys its tabs differ in, so selecting a tab keeps a choice's key (it took the tab link's whole
    query)
    ([#474 A client-only choice cannot switch parts in several places of the page: TabGroup switches only its own panels](https://github.com/todd-skelton/corten/issues/474)).
150. `req.redirect_with_notice(&to, text)` and `req.notice()`: a redirect after a write says what
    it did ("Batch 3517 deleted.") once, on the page it lands on, without a query field that a
    reload, a copied link or Back says again. The text rides in a `__Host-` cookie for that page's
    path (a minute, cut at 500 bytes, the path hashed with its escapes decoded), which the page's
    answer removes and which a `HEAD` request leaves. The page renders it (`Notice`, escaped,
    corten-ui's `Toast { message: req.notice() }` in the layout) and is private. A navigation's page
    that did not draw it, its layout not run, hands it to the runtime in `corten-notice`, and the
    runtime dispatches `corten:notice` (`detail.message`), which the `Toaster` shows; when the
    navigation loads the page in full instead (its layout changed), the runtime keeps the notice in
    session storage and dispatches it after the load. A debug build warns about a full load that
    did not draw it. `OnSite` (sealed): the links a notice may go to, a route, `route.at(id)`, a
    `Local` and a `#[derive(Href)]` enum whose variants all are; another site's URL does not compile.
    The watchlist's subscribe and the gallery's rename use it, and the gallery's toaster moved into
    its layout. A write forgets what was prefetched while it was on its way, which could predate
    it or use up its notice. The minified runtime grows by 637 bytes (26,791 to 27,428), 240
    gzipped (9,707 to 9,947), 216 with brotli (8,771 to 8,987). The item page's render runs
    0.08% more instructions (median of 3, callgrind, release build: 35,619,673,804 against
    35,592,439,055 on its base), the look for the notice cookie in each request's `Cookie`.
    ([#385 A post that redirects cannot say what it did on the page it lands on, so each screen carries its message in a query value](https://github.com/todd-skelton/corten/issues/385)).
151. `Signal::task()`: a task's signal and its `Shutdown` handle, whose `begin()` aborts the signal
    with `Abort::Shutdown` as `serve` does, so a test of an app's task covers its shutdown path (a
    job released, a loop that returns at once) on a paused clock; a request's signal still cannot
    be aborted by the app (a `compile_fail` doctest). Nothing a request does changes
    ([#489 A task's shutdown path cannot be tested: Signal::default never aborts and abort is crate-private, so the app wraps Signal in a trait of its own](https://github.com/todd-skelton/corten/issues/489)).
152. `#[component(js = Owner)]` (`js = path::to::Owner`): a part of a component, a function of its
    own (a sheet, a row, a field), calls its owner's handlers through `js`, so a large page splits
    into parts without a script per part (one more request for a one-line handler) or the owner
    drawing the part's markup and passing it down as a prop. The page loads the owner's one script;
    the part adds none, and an owner without a script does not compile (a `compile_fail` doctest).
    A component's `js` module is now beside it (`__corten_js_{Name}`, hidden) instead of inside
    its `render`, which is how a part reaches it; what renders is unchanged. The item page's
    `render_cost` (release, callgrind, 3 runs) is 35,602,516,052 instructions against
    35,613,859,907 on main (-0.03%, layout: the page has no part)
    ([#492 A sub-component cannot bind its page's script: #[component] has css = Other but no js = Other](https://github.com/todd-skelton/corten/issues/492)).
153. The `zones` feature: the visitor's time zone with its rules, from Corten. With
    `App::zoned_dates()` (which the app sets: the feature alone, which another crate may turn on,
    changes no app's dates), while Corten renders a request's answer (a page, a patch), `t.date`,
    `t.time` and `t.date_time` write in the zone the browser reported, with its daylight saving
    rules (jiff and its bundled tz database, so an image without `/usr/share/zoneinfo` has them),
    and the answer is private; a live part's fragments too. A value that names a day (a due date
    kept as UTC midnight, a chart's axis) takes `.zone(Utc)`, or it reads a day early west of UTC.
    A `Public` answer, the same for everyone, is written as for an unknown zone (UTC, `LocalTime`
    written again in the browser) and stays shared; the route knows it when the crate compiles.
    No handler takes the zone and no component is given it, where an app added a tz crate, a `Zone` newtype, `Option<ClientZone>` on each handler that draws a date and
    a prop down to it. `.zone(..)` still chooses another; outside a request's render a date is in
    UTC. `req.zone()` is the zone (`corten::i18n::Visitor`, a `Zone`), for a picked date, UTC
    until the browser has reported it. corten-ui's `LocalTime` draws a date the first page shows:
    there the server does not know the zone yet and writes UTC, and its script writes it again in
    the browser's zone with the server's own format (`DateFormat` takes an offset,
    `format(at, { offset })`); later pages are the server's. `When` has `datetime()`, `format()` and
    `zone_unknown()`. A date rendered once and kept across requests takes `.zone(..)`, or it is in
    the zone of the request that rendered it. Each `LocalTime` whose script runs carries its format
    (about 850 bytes before compression against about 70 for the date alone). The minified format
    module grows by 18 bytes (3,008 to 3,026); the runtime is unchanged. The item page's
    `render_cost` (release, callgrind, 3 runs, without the feature, which card-market does not
    turn on) is 35,621,122,132 instructions against 35,603,094,486 on main (+0.05%). A page that
    writes ten dates (callgrind, release, per request) runs 34,952 instructions without the
    feature, 36,363 with it in an app that sets neither setting, and 42,854 with
    `zoned_dates` and a zone cookie (the zone looked up once per request, about 380 per date for
    its offset)
    ([#387 Dates in the visitor's zone need a tz crate, a ClientZone argument on every handler and a prop through every component, and the first page is UTC](https://github.com/todd-skelton/corten/issues/387)).
154. `corten::i18n::Day`: a calendar date with no instant behind it (a report's window, a week's
    start, a due date, an API's `"2026-09-02"`). `t.date(day, style)` writes it as that day in every
    zone, as an `OnDay`, which has no `.zone(..)` and no time (`t.time` and `t.date_time` take an
    instant), so a day cannot be written as an instant by mistake (`compile_fail` doctests). With
    `App::zoned_dates` a day kept as midnight UTC read a day early west of UTC. `Day` parses
    `YYYY-MM-DD` only (what `<input type="date">` sends), reads and writes JSON and serde as that
    text, renders as it in `html!` (`<time datetime={on_day.datetime()}>`), is a `string` in
    `corten::types` declarations, and has `plus(n)` and `midnight_utc()` (an `Option`: a
    `SystemTime` does not reach year 1 on every platform; a day is written from its calendar date,
    so `t.date` writes every one). `t.date` takes a `DateValue`: an instant as before, or a `Day`;
    a closure that passes its untyped parameter to `t.date` needs the parameter's type. A script's
    `format("2026-09-02")` with no offset writes the same day (checked by `npm run check`).
    The item page's `render_cost` (release, callgrind, 3 runs) is 35,607,619,833 instructions
    against 35,621,122,132 for the zones change it builds on (-0.04%; the page writes no date).
    ([#502 i18n: no way to write a calendar date (no instant behind it) that never shifts with the zone](https://github.com/todd-skelton/corten/issues/502)).
155. A size drawn from data is a custom property: a component's stylesheet registers it
    (`@property --fill { syntax: "<percentage>"; inherits: false; initial-value: 0% }`), and
    `style={FILL.pct(used)}` sets it, with a method per unit its syntax allows (`px`, `deg`,
    `set(3)`); CSS text, another unit or another component's property does not compile. A
    registered property is the component's (`--meter__fill`), and an `@property` the browser
    would ignore does not compile, its `syntax` read by the specification's own algorithm (escapes
    and non-ASCII keywords included, no keyword starting with `-`) and a number syntax's
    `initial-value` checked (one value, `6px` rather than `calc(2px * 3)`). A full page gets one
    `<style>` at `<Corten />` with a rule per distinct value, allowed by its hash in that
    response's `style-src`, so it paints with the sizes, needs no script or nonce and allows no
    style attribute; the runtime sets the values a patch, navigation or live fragment brings through
    the CSSOM. Both are `!important`, so a value from markup wins over the component's rules,
    and an `!important` declaration of a property markup sets does not compile.
    `examples/seller-desk`'s statement draws each set's share as a bar. The minified runtime grows by 454 bytes (27,428 to 27,882), 144 gzipped, 132 with brotli (a navigation to a
    page that sets no value searches its text, not the DOM; markup in a `<template>` gets its values
    too, so they move with it), and `corten/views`
    (loaded only by a page whose handlers use views) by 395 (2,852 to 3,247), 201 gzipped, 166 with
    brotli, for rows copied from a `<template>` (a copy looks for values only when the template's
    row has some, so a row with none costs one boolean test). Measured with callgrind (release
    build, in-process `oneshot`, the difference between 1,200 and 200 requests over 1,000, median of
    three, against main at 5a7520bc): a page that sets no value runs 23,304 instructions a request
    against 23,176 on main (main runs 23,164 to 23,178, branch 23,301 to 23,314), the empty
    collection around the render and the look in the security headers; a page of four meters with
    two distinct values and one that is not finite runs 42,736 (runs 42,736 to 42,739) against
    23,393 (runs 23,393 to 23,394) for the same markup without them, about 10,500 of it the SHA-256
    of its 124-byte block (three compressions)
    ([#139 A size or position drawn from data needs style attributes, and allowing them opens style-src-attr 'unsafe-inline' for the whole app](https://github.com/todd-skelton/corten/issues/139)).
156. `tokens!`: in an sRGB color, a `hex` more than one 8-bit step from its components in any
    channel no longer compiles to the components silently; the error names both and the hex
    the components are (`#ff0000 is not the components [0.1137, 0.1059, 0.149], which are #1d1b26`).
    One step off is a tool's rounding and the components stay the color; outside sRGB `hex` is the
    format's gamut-mapped fallback and is not checked. A color written as a hex alone (`"#1d1b26"`,
    `{"hex": "#f0a"}`, with an alpha `#1d1b2680`), which the format does not allow, fails with
    the object to write, which compiles to the same color. `corten tokens migrate` is declined:
    it would put a second token parser in the standard-library-only CLI for a one-time move
    ([#493 Writing a color token means working out its sRGB components by hand; a hex that disagrees is ignored silently, and the old tokens.json has no migration](https://github.com/todd-skelton/corten/issues/493)).
157. `pwa::Manifest` sets the manifest's other members: `display` (`Display`, standalone unless
    set), `display_override`, `orientation`, `id` (a page of this app: a route or a `Local`),
    `lang`, `dir`, `categories`, `screenshot(Screenshot::new(..))` with its form factor and label
    (Chrome's richer install dialog), and `shortcut(Shortcut::new(name, &Route))`, a page named by
    its typed route. A screenshot or a shortcut's icon is a static file's constant or a `Uri`,
    resolved to its versioned URL as an icon is. A manifest that sets none of them is written as
    before. `examples/card-market` sets categories, a wide and a narrow screenshot of its home page
    and a shortcut, and its smoke checks that Chromium reads the manifest without errors, that the
    screenshots are served at the sizes it says and that the shortcut opens a page. A manifest image's
    `type` comes from the static directory's own table (a GIF was written `image/png`)
    ([#515 pwa::Manifest cannot set the manifest's other members (orientation, categories, id, screenshots, shortcuts)](https://github.com/todd-skelton/corten/issues/515)).
158. A route parameter may be followed by plain text in its segment, a file's extension:
    `#[route("/sitemap/{kind}/{page}.xml")]` with `page: u32` links to `/sitemap/items/3.xml`, and
    `Params` reads `page` as `3`. A segment that does not end in the text, or is only the text, is
    a 404 before the handler runs, whatever its method (the router matches the segment whole, so
    the route takes every path of its shape, and Corten checks the text), and a value that is not
    the type is a 400 as for any parameter. Two routes of a module that differ only in that text
    (`{name}.rss`, `{name}.atom`) do not compile, nor do two with a parameter where the other has
    its catch-all (`/{name}.txt` or `/{name}` beside `/{*page}`), which the router cannot hold
    and would refuse naming `/{name}`; in different modules, areas or APIs a route with text
    beside a catch-all stops the app at startup naming both as written. `Req::serves` agrees
    with the router. A field after which text comes needs only `Display` for a link, as any field, and two routes
    anywhere in the app (modules, areas, APIs) that differ only in that text stop it at startup.
    A route without such text generates the code it did (the expanded card-market is identical).
    Measured with callgrind (release, in-process `oneshot`, the difference between 1,200 and 200
    requests over 1,000, median of three and the range of the nine pairs): `/file/37.xml` with
    `{page}.xml` runs 20,991 instructions a request (20,970 to 21,169), against 21,083 (21,073 to
    21,203) for the workaround (the segment as text, the handler stripping `.xml` and parsing)
    and 18,529 (18,488 to 18,781) for `/plain/37` with a plain `{page}`. `Req::serves`, which
    now picks a route by its segments' shape and then checks the text, costs 5,350 instructions a
    call (5,344 to 5,364) against 5,210 (5,209 to 5,210) on main, for an app of 12 routes. The
    startup check compares only routes with such text against the others, path by path in place
    (and looks for a catch-all only when one of the two has one): at `App::router`, 400 routes
    with none take 27 microseconds (26 to 27), and 449 (436 to 511) when 10 of them have text,
    against 375 (314 to 706) without the catch-all check; an area adding the same 400 routes one
    by one 56 and 539 (493 to 606) against 435 (394 to 748) (release build, the check's
    functions timed alone, median and range of nine runs of 50)
    ([#514 A route parameter cannot be followed by fixed text in its segment, so /sitemap/{kind}/{page}.xml has no typed route](https://github.com/todd-skelton/corten/issues/514)).
159. A UI kit, copied into the app as source (docs/guide/kit.md). `corten ui init` writes theme
    tokens under shadcn/ui's variable names (`--background`, `--primary`, `--ring`, `--radius`
    and the rest), light and dark, following the system when the page chose none, `src/ui.rs`
    listing the kit's components, and the page's colors in `static/style.css`, and lists
    `ui::COMPONENTS` on the `App`. `corten ui add <name>..` (or `--all`) copies a component into
    `src/ui/` with the kit version it came from, refusing to replace a file unless `--force`, and
    lists it (and, for one that styles a corten-ui widget, adds `corten-ui` to `Cargo.toml` and
    `corten_ui::COMPONENTS` to the `App`); each writes all its changes or none. `corten ui list`
    names them; `corten ui diff` says, for each copy, whether the app edited it and whether the
    kit changed it since (from the version and hash on its first line), with the lines that
    differ. The components are `Button` (six variants, four
    sizes), `Badge`, `Card` with its header, content and footer, `Alert`, `Field`, `Input`,
    `Textarea`, `Select`, `Slider`, `Checkbox`, `Switch`, `RadioGroup`, `Separator`, `Skeleton`,
    `Table`, `Breadcrumb` and `Pagination` (typed route links), `Avatar`, `Dialog` and `Sheet`
    (a `<dialog>` opened by `command="show-modal"`), `Popover`, `Accordion` (`<details name>`),
    and `Tabs`, `DropdownMenu`, `Combobox` and `Toasts`, which style corten-ui's widgets: ordinary
    `#[component(css)]`s whose variants are enums matched to classes, so one without a rule does not
    compile (a `compile_fail` doctest in each), with no script and no `style=`. A component whose
    element takes the app's attributes (a button, a link, an input) styles the element written
    inside it, so `html!` checks those attributes as always. The `corten new` check now also runs
    `corten ui init`, `corten ui add --all` and `corten check` on the new app, and the ui-gallery
    example is drawn by every kit component from the kit's own files (its orders page shows those
    the draft listing does not), so its browser test runs each in Chromium and WebKit, with and
    without JavaScript
    ([#404 corten ui init: no theme tokens a component kit can build on, and a shadcn theme cannot be brought over](https://github.com/todd-skelton/corten/issues/404),
    [#405 corten ui add: no command copies a component's source into an app](https://github.com/todd-skelton/corten/issues/405),
    [#406 Kit components: styled plain elements and native controls](https://github.com/todd-skelton/corten/issues/406),
    [#407 Kit components: Dialog, Sheet, Popover and Accordion on the platform's elements](https://github.com/todd-skelton/corten/issues/407),
    [#408 Kit components: styled Tabs, Dropdown Menu, Combobox and Toast over corten-ui](https://github.com/todd-skelton/corten/issues/408),
    [#409 The component kit has no test that every component compiles in an app and works in each browser](https://github.com/todd-skelton/corten/issues/409),
    [#410 An app cannot see what changed in a kit component since it copied it](https://github.com/todd-skelton/corten/issues/410)).
160. `Mode::swaps()`: true for a navigation and a `data-patch` action, whose answer the runtime
    swaps into the page it has, so the layout around `<main>` does not render. A value only the
    layout shows that needs a read of its own (a cart's count) is read only when it is false, in
    the function that builds the layout's props: a full load and a page without JavaScript have it
    in the HTML, and a click between pages does not read it. The views guide shows the pattern and
    the write side (for its `data-patch` answer the write reads the value and patches the badge;
    a redirect alone leaves the old value). The two places the renderer chose a swap
    now call it: an item-like page measured with callgrind (release, in-process `oneshot`, the
    difference between 1,200 and 200 requests over 1,000, median of three and the range of the
    nine pairs, against main at bfdb1fe1) runs 22,371 instructions as a full document (22,368 to
    22,385) against 22,371 (22,368 to 22,386), and 22,012 as a navigation (21,953 to 22,270)
    against 21,994 (21,921 to 21,997): the runs vary more than the builds differ, so no
    measurable change
    ([#523 A layout value that needs an async read (a cart count) can only be read by every handler on every navigation, or fetched by the browser after load](https://github.com/todd-skelton/corten/issues/523)).
161. `corten::route::FromQuery`: a `#[route(query)]` set whose value is a rule over what was
    sent (a value sent twice that must agree, a flag any `dimension.*` sets), which a derived
    set cannot be. Two derived sets of the same names carry it: `Link` writes its links as
    narrow as the value, and `Read` reads every value sent, which `from_query` turns into the
    value, so handlers get the rule applied and no name is a string. A `Link` and a `Read`
    with different names do not compile, a route checks the set's names against its own as
    before, and a derived set cannot implement it too. Derived sets read as before:
    measured with callgrind (release, in-process `oneshot`, a route with a derived set of a search, a page and two
    `dimension.*` options, the difference between 1,200 and 200 requests over 1,000, median of
    three and the range of the nine pairs), 34,274 instructions a request (34,139 to 34,276)
    against 34,267 on main at daaf983f (34,147 to 34,287). The same query read through a
    `FromQuery` set whose `Read` has `Vec` fields runs 35,232 (35,155 to 35,243): the lists and
    the rule cost about 960 more, paid only by such a set
    ([#530 A #[route(query)] set that reads itself from the whole query has no public reader since Params reads sets field by field](https://github.com/todd-skelton/corten/issues/530)).
162. `corten::Ahead` and `Mode::of`: a read only the layout shows (a cart's count) started
    as the request arrives, in an extractor that holds what the layout needs, and awaited where
    the layout's props are built, so a full load waits for the longer of the page's reads and
    the layout's, not their sum; `Mode::of(&headers)` reads the mode before the handler has its
    `Req`, so the extractor starts the read only for a full load. The read runs on a task of
    its own, is cancelled when dropped unawaited, and its panic is the handler's. The views
    guide's cart count now starts this way. Wall time (release, in-process `oneshot`, a 60 ms
    cart read and 56 ms of page reads as in the issue, median of 12): a full load takes 61.6 ms
    (60.5 to 61.7) against 118.4 (117.8 to 118.9) read after the page, and a navigation 57.4
    either way. Callgrind (the difference between 1,200 and 200 requests over 1,000, median of
    three and the range of the nine pairs): starting the read costs 30,065 instructions a full
    load (29,537 to 30,295) against 24,790 (24,745 to 24,907) for the same page reading it
    after, about 5,300 for the task, paid only on a full load by a page that starts one (one
    request at a time; not measured under load); `Mode::of` moved the request path nowhere
    measurable (a full document 24,954, 24,944 to 24,980, against 24,830 on main, 24,794 to
    24,978; a navigation 23,541, 23,515 to 23,862, against 23,573, 23,515 to 23,893)
    ([#534 A layout value read the way the guide shows starts after the page's own reads, so a full load waits for both, and an extractor cannot read Mode to start it early](https://github.com/todd-skelton/corten/issues/534)).
163. `JsonResponse` from a `Relay` (`Ok(relay.into())`), so a JSON route that answers some
    requests itself and passes the rest to another service (a route moved off it a part at a time,
    a cache in front of it) names one answer, and the relayed one stays the upstream's: its failure
    body passes on, and the app does not compress it. Before, such a route sent its own JSON as a
    `Relay`, uncompressed. No request path changed
    ([#541 A route that answers its own JSON for some requests and relays the rest to another service has no answer type, so a half-ported route sends its own JSON as a Relay](https://github.com/todd-skelton/corten/issues/541)).
164. APIs nest as areas do: an API whose prefix is under another's (a feature's
    `/api/forecast-calibration` in the app's `/api`) keeps its routes, their checks and its `state`,
    takes the settings it leaves unset (`deadline`, `errors`) from the API around it, and meets
    that API's middleware before its own; a setting it gives replaces the outer one. Its partner
    sites are its own alone: the outer API's `allow_origin` grants nothing under the inner prefix,
    for a request, a preflight or a WebSocket switch. Every path under an API's prefix is its own:
    a parameter or catch-all route outside it (an outer API's `/api/{*rest}`, a page's `/{slug}` or
    `/{*rest}`) does not answer one, the API's JSON 404 does. Such a request still meets every middleware a route of the
    API would, with no `MatchedPath`, and its answer carries an empty `Allow` whatever its method or
    status (a method the outer route lacked was a 405 with that route's `Allow`); axum's raw path
    parameters are still the outer route's, so a middleware reads the path, not `RawPathParams`. The same prefix given twice, or an
    outer API's route written under the inner prefix, is a startup error; before, any two prefixes
    that overlapped were, so a feature could not own its JSON routes under a shared `/api`
    (callgrind, release, in-process `oneshot`, the difference between 1,200 and 200 requests
    over 1,000, three rounds alternating main and the branch; median, then the range of the three
    runs: with two APIs side by side, `/api/ping` is 17,096, 17,096 to 17,170, against 17,061,
    17,048 to 17,061 on main; `/v2/items/7` 18,639, 18,627 to 18,639, against 18,604; a page
    outside every API, `/page`, 19,090, 19,084 to 19,227, against 19,054, 19,052 to 19,189: about 35
    more a request, 0.2%, where no check runs. The check of which route matched
    runs only for an API a parameter or catch-all route outside it can reach: nested with no such
    route, `/api/ping` is 17,189 and `/api/items/7` 18,682; with an outer `/api/{*rest}`, 17,422 and
    19,034, each the same in every run, a router with one more route as well as the check)
    ([#539 An API cannot sit inside another API's prefix, so a feature cannot own its JSON routes under a shared /api the way it owns its pages in an area](https://github.com/todd-skelton/corten/issues/539)).
165. The kit's theme has three tones for status, `--info`, `--success` and `--warning`, each with
    a `-foreground`, and `Badge` and `Alert` an `Info`, `Success` and `Warning` variant for them. A
    test of `corten ui` now checks the contrast the guide states, in both themes: each
    `-foreground` on its color, each tone on a card and the muted text 4.5:1, a field's border 3:1
    ([#552 Kit Badge and Alert have no success, warning or info tone, and every Alert is announced as role=alert](https://github.com/todd-skelton/corten/issues/552)).
166. `corten ui add` refuses a component the app has by the same name with a stylesheet of its own
    (the app's `Field` beside the kit's), naming the app's file, before it writes anything: the two
    would style one class prefix, and the program would not link
    ([#550 A kit component and an app component with the same name fail at link time, and corten ui add does not warn](https://github.com/todd-skelton/corten/issues/550)).
167. A look: a component that returns `impl ClassList` (`#[component(css)] fn Button(variant:
    ButtonVariant, size: ButtonSize) -> impl ClassList`) is its classes, written on the app's own
    element, `<button type="submit" class={Button { variant, size }}>`, so the element is the
    app's: no wrapper, no `display: contents`, and a script's `parentElement`, a `> button` rule or
    a `<summary>` sees the element it expects. It takes a stylesheet (its own or an owner's) and no
    script, refs or view, and used as an element (`<Button>`) it does not compile (design.md
    Choice 16; [Looks](docs/guide/styles.md#looks)); the error is `no field named children` (with
    children) and `Render` not satisfied, whose note says to write it as a class.
    Migration: the kit's Button, Input, Select, Textarea, Slider, Badge, Card, CardHeader,
    CardContent, CardFooter, Dialog, DialogFooter, Sheet, Popover and Accordion are looks (Changed
    104). A wrapper that drew no box of its own (`display: contents`: Button, Input, Select,
    Textarea, Slider, Dialog, Sheet and Popover) becomes the class of the element it held:
    `<Button variant={v} size={s}><button>"Save"</button></Button>` is
    `<button class={Button { variant: v, size: s }}>"Save"</button>`, `<Input><input name={f.q}></Input>` is
    `<input class={Input {}} name={f.q}>`, and an element with a class of its own takes both,
    `class={(Input {}, Wide)}`. A wrapper that drew a box becomes the element it wrote, even around
    one child, whose layout would change if it took the class: `<Card>..</Card>` is
    `<div class={Card {}}>..</div>`, and CardHeader, CardContent, CardFooter and DialogFooter are
    each a `<div>` too. Accordion goes on each `<details>` it held,
    `<details class={Accordion {}} name="faq">`, not on an element around them, which its
    stylesheet no longer styles. Badge held text, so it is the `<span>` it wrote, and its `variant`
    is a `BadgeTone` and a `BadgeEmphasis`: `<Badge variant={BadgeVariant::Secondary}>"Draft"</Badge>`
    is `<span class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Solid }}>"Draft"</span>`;
    `Primary`, `Info`, `Success`, `Warning` and `Destructive` keep their tone with `Solid`, and
    `Outline` is `Neutral` and `Outline`
    ([#558 Kit wrappers accept any children, so a Switch without role="switch" or a Button around a summary compiles and silently breaks](https://github.com/todd-skelton/corten/issues/558):
    its Button around a `<summary>` and Input on a `<select>`; a Switch's role is still the app's).
168. The kit's Table has a `TableNumeric` look for a number column (aligned to its end, tabular
    figures, on one line) and a `SortHeader` for a column the table sorts by: a typed link to the
    page sorted by it, `aria-sort` on the column sorted now, and an arrow drawn, not written. Its
    cell rules have no specificity (`:where`), so one class of the app's on a cell wins, and
    cells wrap as text does while headers stay on one line
    ([#559 Kit Table cannot end-align a number column or let a cell wrap without !important](https://github.com/todd-skelton/corten/issues/559),
    [#562 Kit Table keeps every cell on one line, and an app class cannot let a column wrap without matching the kit's specificity](https://github.com/todd-skelton/corten/issues/562),
    [#567 Kit Table has no sortable column header, so each app hand-writes aria-sort, the sort link and its arrow](https://github.com/todd-skelton/corten/issues/567)).
169. `corten::event_stream(stream)`, `StreamEvent` and `EventStreamResponse` (feature `json`): a
    route answers server-sent events of the app's own JSON, `event: <name>` with `data: <JSON>` and
    the event's cursor as its `id`, for a script's `EventSource` or a native client. It is kept
    alive and ends at shutdown like `corten::live`, a failure before the stream starts is answered
    as JSON, and `EventStreamResponse::ended()` (204) stops a reconnect once the stream is over.
    The names and data are not yet typed in the script
    ([#591 An event stream's names and data are strings the script reads untyped, where a feed's rows are checked from the route to the script](https://github.com/todd-skelton/corten/issues/591))
    ([#583 A route cannot answer server-sent events of its own JSON, only live HTML patches or a feed's rows, so a progress stream is sent as a Relay and holds the shutdown open](https://github.com/todd-skelton/corten/issues/583)).
170. `Caller::<T>::find(parts, state)` reads who is asking as `T` from the request's one lookup of
    `T`, for an `Identify` that is a rule over another type (a seller is a viewer who may sell):
    the session is read once in the request whichever of the two types the handler, a middleware
    and the error page take
    ([#581 Caller is looked up once per type, so a caller type that is a rule over another asks the session store again in the same request](https://github.com/todd-skelton/corten/issues/581)).
171. `req.rendered(view)`, a `corten::Rendered`: a view rendered once, as the page would render it
    (in the visitor's time zone under `App::zoned_dates`), to place in several answers (a page's
    body that is also a live stream's fragment). Placed in a page, it brings what its render noted:
    the values of its `style={..}`, so the page's style block has their rules and sizes from data
    paint without a script, and the script modules its handlers use. Markup rendered to a `String`
    and placed with `raw()` brought neither, so its sizes painted at their initial values until a
    patch, with nothing said; under `corten dev` a full page with a `data-vars` value its block has
    no rule for is now an error that says so
    ([#576 Sizes from data (data-vars) in markup placed with raw() never reach the page's style block, and nothing says so](https://github.com/todd-skelton/corten/issues/576)).
172. `JsonError::Own` and `From<JsonResponse> for JsonError`: a JSON route refuses in its own error
    shape with `?` (`Err(refused(StatusCode::BAD_REQUEST, ".."))?`), answered as written, and a
    helper's `Result<_, JsonError>` stays under clippy's `result_large_err`. A refusal of the
    app's is written as that `Err` (an `Ok` one still answers as written). A `match` on `JsonError` needs an arm for the new
    variant, and `JsonResponse`'s `Debug` shows its status and type, not its cookies
    ([#584 A JSON route cannot refuse early in its own error shape: JsonError takes only Corten's, and Result<JsonResponse, JsonResponse> fails clippy's result_large_err](https://github.com/todd-skelton/corten/issues/584)).
173. `#[route(read_only)]` on a field of a `FromQuery` set's `Read`: a parameter's older name that
    `Params` reads and nothing writes, so an address shared before a rename still reads, with no
    field on `Link`. A set with one is not a `QueryParams` (no link or route writes it), a route's
    own field cannot be one, and a route that includes the set checks its names against the older
    one. A field's `#[route(..)]` other than `query`, `read_only` and `prefix = ".."` (a misspelt
    one) no longer compiles
    ([#577 A FromQuery Read cannot take an older parameter name its Link never writes, so a renamed parameter is declared on the link set](https://github.com/todd-skelton/corten/issues/577)).
175. The kit has parts for showing data and spacing a screen: `Meter` (the look of a `<meter>`,
    colored by the state its `low`, `high` and `optimum` give), `Stats` and `Stat` (labelled
    figures, a term and its descriptions, a figure never broken across lines), `StatusDot` (a
    status's color beside the words that name it, not read) and `Stack` and `Cluster` (a column
    or a wrapping row, a `Gap` apart). The gallery's orders page uses each
    ([#557 The kit has no stack or spacing primitive, so every screen hand-writes the gap between cards, alerts and forms](https://github.com/todd-skelton/corten/issues/557),
    [#571 The kit has no meter, so every app draws a share used as a bar of divs with no meter role](https://github.com/todd-skelton/corten/issues/571),
    [#572 The kit has no labelled figure (stat) or status dot, so a dashboard writes its own and names status only by color and title](https://github.com/todd-skelton/corten/issues/572)).
174. The kit's sizes are tokens of its theme: `--control-height` (with `-sm` and `-lg`),
    `--control-padding`, `--control-font-size`, `--card-padding` and `--card-heading-font-size`, read
    by the button, field, select, textarea, combobox, menu, tabs, pagination and card stylesheets
    with today's values as the defaults, so a theme sets the buttons', fields', selects', menu
    buttons', page links' and tabs' size (a 44 px touch target with `control-height`,
    `control-height-sm` and `control-height-lg` at 2.75rem), or a density, in one place; menu items, combobox options,
    checkbox, radio and switch labels and the slider keep their own sizes. A combobox's highlighted
    option has a transparent outline too, so forced colors shows which one Enter picks. Measured
    with every component added (`corten ui add --all`, the stylesheet the app serves): 32,022
    bytes where it was 31,163 (brotli 4,976 against 4,885, gzip 5,662 against 5,560)
    ([#561 Kit control heights, spacing and type are literals, so a theme cannot give every control a 44 px touch target without editing each copied file](https://github.com/todd-skelton/corten/issues/561)).
    An app with its own theme declares them too, as `corten ui init` says; an app set up by an
    older kit adds them to its theme, and `corten ui add` names each one a component it copies
    reads and the app declares nowhere (its theme or a stylesheet under `static/`): a size with the
    kit's line to add, and a color with the kit's light and dark lines for the kit's theme or by name
    for an app's own, to give as a reference to one of its colors (the app does not start until
    each is declared).
176. `corten ui diff` shows a copy's edits and the kit's changes as two diffs from the kit's text the
    copy was made from, which the command carries for every hash a kit file has had
    (`crates/corten-cli/kit/was/`; the 37 earlier texts add 44,569 bytes to the binary), and
    `corten ui add --merge` takes the kit's changes into an edited copy, keeping its edits and
    marking a line both changed as git marks a conflict, then failing until the app resolves them;
    a component stylesheet with a conflict's marker left in it does not compile, so an unfinished
    merge cannot drop a rule unseen (and one with CRLF line ends reads a string continued past a
    line end, `\` then CRLF, as one string, where it said the string was never closed).
    The stamp's version stays the command's: its hash names the copy's base. `kit/was/` keeps the
    current texts too, so a kit file that changes fails its test until its new text is added there,
    and nothing is removed
    ([#599 corten ui diff cannot tell an app's edits from the kit's: every file says 0.1.0 before and after a change, and the CLI has no base to merge against](https://github.com/todd-skelton/corten/issues/599)).
192. The kit's `Stats` takes a `surface`: `StatsSurface::Cards`, each figure a card as before, or
    `StatsSurface::Plain` for figures inside a card (a panel's summary), drawn on the card with no
    surface of their own and their text at the card's content edge, where each figure was a card in
    the card. After `corten ui add --merge stats`, the app writes
    `Stats { surface: StatsSurface::Cards }` at each `Stats {}`; the compiler names each one
    ([#625 Kit Stats draws every figure as a card surface, so a summary inside a card becomes cards in a card; it has no plain form](https://github.com/todd-skelton/corten/issues/625)).

190. The kit draws every corten-ui widget the user sees ([#610 Kit has no look for corten-ui's ChoiceGroup, so it renders as run-together links ('30 days90 days'); only the ui-gallery styles it, by hand](https://github.com/todd-skelton/corten/issues/610)):
    `Segmented` around a `ChoiceGroup` (a segmented control, the chosen option raised), `Stepper`
    around a `NumberField` (its input and buttons at `--control-height`, a `StepperUnit` beside
    the input) and `Checkboxes` around a `CheckboxGroup` (its fieldset as `RadioGroup`'s), which
    the gallery styled by hand. A test fails when corten-ui gains a widget with neither a kit
    look nor a stated reason it draws nothing of its own. `SegmentedLinks` is the same control on
    a `<nav>` of links, the current one `aria-current="page"`, for views the server renders
    ([#574 Kit tabs styles only TabGroup, so a nav of filter links (aria-current) has no segmented look](https://github.com/todd-skelton/corten/issues/574)).
    The card has `CardAction`, controls at the end of the header's heading row that wrap under it
    ([#573 Kit Card header has no slot for actions, so a card with a button in its header is an edit to the copied card](https://github.com/todd-skelton/corten/issues/573)),
    `CardPanel`, a card around one block of content on one element (the surface and its padding,
    no layout, so the element's own class or a `Stack` lays it out), and `CardCompact`, a denser
    card beside roomy ones; a card inside a compact one is roomy again. The header's heading and
    description rules now weigh one class, where they weighed a class and an element: an element
    default (`h2 { .. }`) still does not change them, and an app class on the heading ties, so it
    wins when its rule comes later. An image or icon in the header keeps its own size and sits on
    the heading's row (before the heading, at its start; after it, at the row's end), where it had
    a row of its own. `CardCompact` weighs two classes, so it wins over the card's spaces in
    whatever order the rules come, and the kit's own custom properties start `--kit-` (a card's
    `--kit-card-inset`, a badge's `--kit-tone`), so an app's property of the same name neither
    reaches a kit component nor is hidden inside one
    ([#605 Kit Card has no one-element panel or compact size: (Card {}, CardContent {}) on one element works only by rule order in card.css, and every card is 1.5rem roomy](https://github.com/todd-skelton/corten/issues/605)).
    Measured with every component added (`corten ui add --all`, the stylesheet the app serves):
    35,857 bytes where it was 32,022 (brotli 5,405 against 4,976, gzip 6,136 against 5,662), most
    of it the three new components, which an app pays for only when it adds them.
191. A form field's control is named from the field: `e.id(f.email)` is `{form}-{field}`, for a
    label's `for`, and `<input {..e.control(f.email)}>` writes that `id`, the `name` and what
    `e.aria(..)` writes; `.hint()` names the hint (`corten::form::HintId(&e.id(f.email))`)
    ahead of the error. A label and its control need no `#[derive(Id)]` of their own, and two
    forms' fields of one name never share an id. A tag that writes one of those attributes beside
    the spread does not compile, nor does a tag with two spreads that declare one attribute
    (`e.aria(..)` beside `e.control(..)`). The kit's `Field` names its hint `HintId(&id)`
    (`{id}-hint`), where it was `FieldHintId` (`field-hint-{id}`): a copy that imports
    `FieldHintId` takes `corten::form::HintId` instead, and `.hint()` names a hint only a copy of
    the new `Field` writes, so update the copy first (`corten ui add --merge field`); a test or
    stylesheet that reads `field-hint-` changes with it
    ([#554 Kit Field: the control id is written twice, unchecked, and a field cannot show a hint and its error together](https://github.com/todd-skelton/corten/issues/554)).
194. The kit has `Steps`: a workflow's steps, a `<nav>` named by its `label` around their
    `<ol>`, as Breadcrumb and Pagination render theirs, each a `Step { label, link, state }` that
    links to its step's page or names one with none, counted. Its state is written
    (`StepState::Done(words)`, `Current`, `Todo(words)`), so the check mark a done step is
    drawn with and the words a screen reader hears for it ("(done)", shown to no one else) come
    from one value: a skipped step is a `Todo`, and a finished workflow is every step done. The
    current step is `aria-current="step"`
    ([#629 Kit has no steps for a multi-step workflow, so an app draws its numbered step links, aria-current=step and done marks by hand](https://github.com/todd-skelton/corten/issues/629)).
195. The kit has `NavBar`: the bar across the top of every page on the app's `<header>`, with
    `NavBrand`, `NavSections` (a `<nav>` of `req.nav` links, the current one drawn from the
    `aria-current="page"` they write) and `NavActions`, in the theme's card colors (`--card`,
    `--card-foreground`, which an app's class on the `<header>` sets to recolor the bar and the
    shadows' covers with it). On a narrow
    screen the links stay one row that scrolls sideways, with no script: a shadow at the edge
    with more past it, and a thin scrollbar for a mouse and under forced colors, which drop the
    shadows. It does not fold the links into a menu, which would write each twice and put both
    copies in one nav group (an app that wants one puts its links in a `Popover`), and has no
    sticky position of its own: the app's class on the `<header>` sets one
    ([#630 Kit has no navigation bar: every app (seller-desk, card-market, this port) writes its header nav and current-page mark by hand, and none collapses into a menu on a phone](https://github.com/todd-skelton/corten/issues/630)).
    ui-gallery's pages and seller-desk's wear it. The desk's own header rules are removed and its
    other kit copies refreshed from the kit (`corten ui add --force`), which brings the size
    tokens it now declares, the text controls' focus outline under forced colors and the table's
    sort arrow drawn from `aria-sort`. The gallery's draft shows the steps. Measured, raw bytes
    with compressed in brackets: ui-gallery's components stylesheet, which has every kit piece,
    is 41,309 where it was 37,307 without the two (brotli at level 11 6,215 against 5,677, gzip
    7,061 against 6,457), paid only by an app that adds them; seller-desk's two stylesheets are
    15,968 where they were 14,207 (brotli 11 3,399 against 3,168), and its statement page 2,550
    where it was 2,459, the header's classes.

193. The kit's `Progress`: the look of a `<progress>` (`corten ui add progress`), its track and
    fill in the theme's border and primary colors as the meter's, where a progress bar drew in the
    browser's own colors (a light stripe in a dark theme); with no `value`, a band that moves
    across the track, or stripes under reduced motion; under forced colors, the bar in the system's
    colors; `ProgressSize::Sm` for a nested bar
    ([#632 Kit meter points task progress to <progress>, but the kit has no look for it, so a progress bar draws in the browser's colors in a themed page, a light stripe in dark mode](https://github.com/todd-skelton/corten/issues/632)).
197. The kit's `segmented` draws native radio buttons too: `SegmentedRadios`, a `<fieldset>`
    with its legend (`Legend::Shown`, or `Legend::Hidden` for a screen reader only), around
    `SegmentedRadio`s, each holding the app's `<input type="radio">`. A form sends the choice
    and CSS can read it (`:has(:checked)`), which neither does for a `ChoiceGroup`'s options,
    and it needs no script; the checked choice is raised, the focused one ringed, a disabled
    fieldset or input drawn disabled, and under forced colors the checked one outlined, as the
    other two kinds are. ui-gallery's shipping settings choose a label size with it and post it
    ([#657 Kit Segmented styles ChoiceGroup and links but not a fieldset of native radios, so a no-script choice (a form that posts on change, a CSS layout switch) draws its own segmented control](https://github.com/todd-skelton/corten/issues/657)).
    Measured on ui-gallery's served stylesheet, the piece's rules are 2,156 bytes where they were
    1,344 (brotli, level 11: 598 against 411; gzip: 746 against 516), which every app that adds
    `segmented` pays.
198. `corten ui add` notes each type the app declares with the name of a component or prop type it
    adds (a domain's `struct Progress` beside the kit's `Progress`), and the kit guide shows the
    file that uses both importing the kit's under another name (`Progress as KitProgress`) or by its
    module's path; the classes follow the component, so they stay the kit's
    ([#669 Kit looks take plain nouns (Progress, Stats, Table), so a slice whose domain has that type gets E0252 and a field error on its own type, and the kit guide never shows importing a look under another name](https://github.com/todd-skelton/corten/issues/669)).
199. The kit's `VisuallyHidden` (`corten ui add visually_hidden`): text a screen reader reads and
    the page does not draw, so an icon control's name needs no rule of the app's. `DropdownMenu`
    takes a `trigger`: `MenuTrigger::Text`, the outline trigger with its chevron as before, or
    `MenuTrigger::Icon`, a square ghost button at the control's height with no chevron, for a row's
    ⋮ menu whose name is `VisuallyHidden` text. Breaking for a copy brought up to date
    (`corten ui add dropdown_menu --merge`): `<DropdownMenu>` becomes
    `<DropdownMenu trigger={MenuTrigger::Text}>`, imported with it
    (`dropdown_menu::{DropdownMenu, MenuTrigger}`); one left as it was is E0063, missing field
    `trigger`. The gallery's orders table has a menu per row, and its own hidden-text rule is gone.
    Minified, `dropdown_menu.css` grows from 1,858 to 2,047 bytes (gzip 703 to 745, brotli 589 to
    608), which every app with the menu pays, and `visually_hidden.css` is 144 (gzip 134, brotli 84)
    ([#655 Kit has no visually hidden text and DropdownMenu has no icon trigger, so a row's ⋮ menu writes its own hidden-text rule and draws ⋮ with a chevron](https://github.com/todd-skelton/corten/issues/655)).
200. In a debug build (`cargo run`, `corten dev`, a router test), a page or patch that draws a
    field's hint (`id={HintId(&id)}`) with text, and the element `id` without that hint in its
    `aria-describedby` (or a page with no element `id`), is an error that names the hint, since a
    screen reader never reads it (a patch that does not hold the hint's control, which may be on
    the page already, is not checked). It covers
    `.hint()` on `e.control(..)`, `e.aria(..).hint(&HintId(..))` and `aria-describedby={HintId(..)}`
    by hand; release builds record nothing. The kit's `Field` always writes its hint's element,
    so its control takes `.hint()` always (an empty hint describes nothing), and a helper that
    draws fields from data needs no branch on the hint's text
    ([#682 Field's hint and the control's .hint() are chosen apart: .hint() takes no argument, so a helper drawing fields from data branches on the hint's text, and a control that leaves .hint() off drops a hint from its description silently](https://github.com/todd-skelton/corten/issues/682)).
201. `Within::none(FormId)` (now in the prelude) names a form's fields as `errors.within(FormId)`
    does, for a form whose fields never have a message: `e.id(f.x)` and `{..e.control(f.x)}`, with
    `e.message(..)` writing nothing. Such a form made an empty `Errors` in its markup or went back to
    one `#[derive(Id)]` per field. An app with a `Within` of its own that a glob brings in beside
    the prelude's (E0659, ambiguous) imports its own by name
    ([#685 A form with no field errors cannot name its fields e.id(f)/e.control(f): Within comes only from Errors::within, so it builds an empty Errors in its markup or goes back to one #[derive(Id)] per field](https://github.com/todd-skelton/corten/issues/685)).
202. `SubmitKey` has a JSON Schema (feature `types`, which `agent` turns on), so an MCP write
    tool's input takes an idempotency key as a form does: `submit: SubmitKey`. Agents see a UUID
    string described as a key to send again on a retry, a key that is not a UUID v4 is refused
    before the tool runs (the refusal shows the shape, no longer an example key an agent could
    copy), and the tool gets the `SubmitKey` a form's handler gets. Tools now publish
    `idempotentHint`: true for a read, for a write whose input requires a key, and for one added
    with the new `Tools::idempotent_tool` (a write idempotent without a key); false otherwise. A
    write tool without either still starts
    ([#693 An MCP write tool cannot take an idempotency key, so an agent that retries after a lost reply repeats the write](https://github.com/todd-skelton/corten/issues/693)).
203. `req.resend_to(&to)` sends a write's form on to another handler: a `307 Temporary
    Redirect`, which the browser follows with the same method and body, and so does the
    runtime's `fetch` for a `data-patch` form (its answer is drawn as the write's own), presenting
    a cookie the answer sets (`.with_cookie(..)`). For a write that first names who is asking (a
    guest) and writes as them in the request that presents it. `to` is a page of the app
    (`OnSite`); another site's URL does not compile, an address that is not a path on this site
    (one a hand-written `Route` writes) is an error, and on a `GET` or `HEAD` it is an error
    that says to redirect. `Req::redirect`'s answer with its status rewritten to 307 is no longer
    needed. `examples/watchlist` sends a browser's first alert on this way (`POST /alerts/first`),
    and the smoke test checks it with and without JavaScript. A request still looks up once
    whether it is a write; measured with callgrind, instructions per request over 1,000 (release
    build, 1,200 less 200 requests, 3 runs each, from `27e6ce1a`): a document `GET` 22,740 to 22,756
    before, 22,746 to 22,747 after; a navigation 22,216 to 22,290, then 22,207 to 22,286; a form
    `POST` that redirects 25,918 to 25,919, then 25,927 to 25,928 (one run 26,208)
    ([#717 A write handler cannot hand the same form to another address: Req::redirect is always a 303, so a 307 needs a status rewrite and a data-patch form loses its body](https://github.com/todd-skelton/corten/issues/717)).
204. The kit's `InputGroup` and `Adornment` (`corten ui add input_group`): a sign, a unit or a
    button inside a text input's border. `InputGroup` is the look of a `<span>` around the
    input, drawing the box, its focus ring and its invalid and disabled states, while the input
    inside keeps its `Input` look without its own border; `<Adornment>"$"</Adornment>` is hidden
    from a screen reader, so the label or hint says what it shows. A `Field`'s row now fills with a
    `<span>` around an input as it does with an input (`field.css`), and `ControlWidth` goes on
    the group. A password's reveal stays the app's script. The gallery's lowest offer has its
    "$" inside the border. The gallery's `components.css` (every kit look, minified) grows from
    48,149 to 49,667 bytes (gzip 8,111 to 8,310, brotli 7,157 to 7,337): `input_group.css`, which
    only an app that adds it ships, and `field.css`'s one selector, which every app with `Field`
    ships
    ([#698 Kit Input has no adornment inside its box, so a price's $ or a weight's oz sits outside the border beside the control, where MUI's InputAdornment drew it inside](https://github.com/todd-skelton/corten/issues/698)).
205. The kit's `Table` takes a `layout`: `TableLayout::Scroll`, the columns at every width with the
    wrapper scrolling sideways, as before, or `TableLayout::Stack`, for a table read a row at a
    time: on a phone (40rem, as the kit's other parts) each row is a block of its cells, one per
    line, each led by its column's name from the new `CellLabel` written first in it
    (`<td><CellLabel>"Buyer"</CellLabel>{buyer}</td>`) with the rest of the cell beside it, a row
    header too. The column headers stay drawn as a row when they hold a link or button (a
    `SortHeader`) and are hidden otherwise. It stays a table to a screen reader, which names each
    cell from its header (checked in Chromium's accessibility tree); the label is `aria-hidden`,
    so it is not read twice. The gallery's `components.css` (every kit look, minified) grows from
    48,149 to 49,147 bytes (gzip 8,111 to 8,277, brotli 7,157 to 7,309, measured before the
    orders table's menu column from
    [#725 Kit VisuallyHidden, DropdownMenu's icon trigger, and a positioned Table wrapper (#655, #674)](https://github.com/todd-skelton/corten/pull/725)),
    which an app with `Table` pays whichever layout it uses, and its orders page's HTML from
    11,280 to 12,223 (gzip 3,192 to 3,244) for 16 labels. Breaking for a copy brought up to date:
    `<Table>` becomes `<Table layout={TableLayout::Scroll}>`; one left as it was is E0063,
    missing field `layout`. The gallery's orders table stacks
    ([#575 Kit Table has no stacked layout for phones, so a wide table only scrolls sideways or each app rewrites it as cards](https://github.com/todd-skelton/corten/issues/575)).
206. `shortcut(event, scope?)` from `corten/keys`: the key a page-wide shortcut may take, with its
    modifiers (`"Control+s"`, `"Shift+P"`, `"?"`, `"Shift+Space"`), or `null` when it belongs to
    something else: a key a handler took, an IME composing, an AltGr character, a dialog,
    popover or open modal `<dialog>` (not fullscreen), a field that takes text (in a shadow root too; unless Control or Meta
    is held, and never its editing keys), Space or Enter on a control, the arrows, Home, End and
    page keys on a radio button, slider or composite widget (a character in a list box, menu, menu
    bar, tree or tree grid too), or an element outside `scope`. Each app wrote this guard itself, differently; watchlist's
    counted a ticked checkbox as typing and did not check composition, and now uses `shortcut`.
    It is a module of its own (`scripts/corten-keys.js`, 1,702 B, 870 B gzip; measured), served
    only to an app with a listed script that imports it and preloaded with that script, on a full
    load and on a page the runtime swaps in (not a patch; Changed 121), so the runtime is
    unchanged (33,620 B) and a page without shortcuts fetches nothing more; such an app's import
    map is about 60 B longer. A static script that imports it, or a static `scripts/corten-keys.js`,
    is an error when the app starts
    ([#718 Every page-wide shortcut writes its own 'is the user typing' guard, and the watchlist's, the pack screen's and the intake screen's already disagree (a checkbox, IME, Space on a button)](https://github.com/todd-skelton/corten/issues/718)).
207. corten-ui's `Tooltip` and the kit's `Tip` look (`corten ui add tip`): a short text beside a
    button or link while the pointer rests on it or it has keyboard focus. It is the platform's
    tooltip, `interestfor` on the app's control naming a `popover="hint"` by its
    `#[derive(Id)]` id, which Chromium shows itself; the script shows it in Firefox and WebKit,
    which do not have `interestfor` yet, and does nothing where the browser does. The control
    writes `aria-labelledby` (an icon-only control, whose name it is) or `aria-describedby`
    (a hint). The gallery's icon link to the orders is named by one, and its last sale link
    described by one; `badge.rs`'s example no longer puts text in `title`. Measured on the
    gallery's page: `components.css` 52,223 to 52,685 bytes (gzip 8,750 to 8,820, brotli 7,719
    to 7,778), which every app with the kit's looks ships once `tip` is added; the page's HTML
    18,305 to 18,906 (gzip 4,196 to 4,335) for its two tooltips; and `ui.tooltip.js`, 3,825
    bytes (gzip 1,250), loaded only by a page with a tooltip (the orders page does not)
    ([#720 Kit has no Tooltip, so the React app's 20 tooltips became title attributes: the price matrix's cell errors and the pack screen's shortcut help are mouse-only](https://github.com/todd-skelton/corten/issues/720)).
208. The kit's `Icon` (`corten ui add icon`): an inline `<svg>` of one of 28 Lucide icons (ISC,
    whose license, with Feather's MIT for the ones derived from it, is copied with them) at the
    text's size and in its color: `<Icon glyph={icon::TRASH} />`. Each glyph is a constant in
    the copied `icon.rs`, so a name the set lacks does not compile, nothing is fetched, and an
    app adds one by pasting a Lucide icon's elements into a constant there. It is `aria-hidden`,
    so the control carries the name. The set covers closing, more actions, the four chevrons,
    adding and removing, copying, deleting, downloading and uploading, printing, saving, loading
    again, searching, filtering, grid and list views, settings, help, information and a warning.
    The kit's own marks (chevrons, `Pagination`'s arrows, `Steps`' check and cross) stay drawn
    by their stylesheets, so a piece needs no other. In the gallery the row menu's trigger, the
    orders link and the sales dialog's close button (now a `ButtonSize::Icon` one named by
    `aria-label`) are icons instead of "⋮", "↗" and "Close", and "All sales" has one beside its
    text. Measured on the gallery against main: `components.css` 52,685 to 52,840 bytes (gzip
    8,820 to 8,879, brotli 7,778 to 7,838), which an app pays once it adds `icon`; each glyph is
    written in the page where it is used, so the orders page's HTML grows from 15,997 to 16,501
    (gzip 3,616 to 3,663) for its four row menus' icons and the draft's page from 18,906 to
    19,303 (gzip 4,335 to 4,440) for its three
    ([#719 Kit has no icon component or icon set, so the port copies 11 Material icons' path data into the app and draws the rest of the React app's 39 as Unicode characters (✕ ⋮ ▾ ⚠) or not at all](https://github.com/todd-skelton/corten/issues/719)).
209. `bench/fullstack` and `bench/live` compare Topcoat 0.11 (`tokio-rs/topcoat`, Rust) too: the
    same item page, home page, 404 page and JSON as the other apps, its sort and "show all" as
    shards, the price alert as a procedure (a plain form post without JavaScript), and its `Sse`
    for the live suite. It passes `parity.mjs`, `look.mjs` and the JSON and 404 checks against
    Corten, and round r13 measured it (Documentation 6). `parity.mjs` now ends a tag at the
    first `>` outside a quoted value, since Topcoat's handlers hold `=>`.
210. `bench/fullstack` and `bench/live` compare three more apps, popular server-rendering stacks
    in Go, C++ and plain Rust: axum 0.8 with Maud 0.27 (`axum-maud`, a router and a template
    macro, the stack Corten builds on without it), Gin 1.12 with templ 0.3 (`gin`, Go) and
    Drogon 1.9 with its CSP views (`drogon`, C++). Each renders Corten's markup with htmx and
    the shared `item.js`, as the Razor Pages, Spring and Django apps do, and streams the live
    suite's prices as server-sent events. Each passes `parity.mjs`, `look.mjs` and the JSON and
    404 checks against Corten, and round r13 measured them (Documentation 6). A round's
    `run-ssr.mjs` and `count.mjs` calls get 120 and 70 minutes (from 110 and 60) for the
    eighteen apps, and a droplet's unit 12 hours (from 11).
212. The kit's `TipText` look, in `tip.rs` beside `Tip`: on a `<button type="button">` that shows
    a `Tooltip`, it draws the button as the text around it (font, color, alignment and text
    shadow inherited, no border, background, padding or margin) with a dotted underline and the
    kit's focus ring. Only a link, a button or an `<area>` can show a tooltip (`interestfor`'s
    rule, which the script follows), so text that shows one had to be a button each app reset by
    hand, and a hand reset that came after the app's own size rule undid it. The look's selector
    is `html button:where(..)`, so it wins over an app's bare `button {}` rule (not one with more,
    `button:hover` or `[type=button]`) and an app class on the same button wins over it, in any
    order. A button is one box, so the text does not wrap with the words around it: the look is
    for a word or a short phrase. ui-gallery's Stock card shows one, checked in Chromium, Firefox
    and WebKit (drawn as its text, against an app `button {}` rule and an app size class placed
    before and after the kit's, and its tooltip on hover and on Tab). Measured, ui-gallery's
    `components.css`: 52,939 to 53,386 bytes (gzip 8,888 to 8,988, brotli 7,846 to 7,931)
    ([#757 Kit Tooltip: text that shows one must be a button the app restyles as plain text, so each screen hand-rolls the same reset (MUI's Tooltip wraps any element)](https://github.com/todd-skelton/corten/issues/757)).
213. `bench/fullstack` measures what each app costs to build (`build.mjs`, a round's last step):
    its dependencies, a production build (clean is the two together), the build again after a
    one-line change to the item page's view, and, for the Rust, Go and C++ apps, the development build clean and after
    the same change (`corten dev` runs `cargo build`). Each step runs in a container of its own
    pinned to four cores and reports wall time, CPU-seconds and peak memory. For Corten it also writes
    cargo's per-crate timings and rustc's passes and macro expansion for card-market's crate, to
    show where the time goes. The commands, images and fetched files are each Dockerfile's
    (`builds.mjs`; `builds.test.mjs`, which `npm run check` runs, checks them against the
    Dockerfiles); seven Dockerfiles gain a `tools` stage to build from, and their images do not
    change. The compiled apps build first, a stopped or crashed build or a restart skips that app
    alone, results are saved after every step, a step that runs out of memory says so, the step
    has a 420-minute budget, and a droplet's unit gets 21 hours (from 12). A first desktop round
    (README, "Build cost on a desktop", one run on a loaded machine): Corten's clean production
    build (card-market, a different and probably larger crate than the other apps' item pages) took 333 s and 112 s
    after a one-line view change, about 1.9x axum + Maud's, against 9 s to 206 s clean and under
    50 s after the edit for the apps not written in Rust or C++; its development rebuild took 5.6 s.


211. Pages require Trusted Types (`require-trusted-types-for 'script'; trusted-types corten`),
    so the browser holds scripts to design Rule 1: markup reaches a page from a string only
    through the runtime's own policy, which takes the server's answers to the runtime's requests
    (a patch, a swapped page, a live fragment) and the service worker's URL. Only an answer from
    the page's own origin is drawn: a `data-patch` form, a `ReadAgain` or a `<corten-live>` a
    script pointed at another origin (one `connect-src` allows) gets `corten:error` or a console
    error, not that origin's markup, nor is a `Response` a script made (no URL) or an event it
    dispatched; that catches a script's mistake, not one set on forging what the runtime reads.
    A script that writes `innerHTML` or `insertAdjacentHTML` from a string, or passes one to the runtime's `patch`,
    now gets a `TypeError`. `Policy::trusted_types_policy` and `Sources::trusted_types_policy`
    allow another policy by name (a third-party SDK's, or `default` for a script that writes with
    none), app-wide or on an area's pages only; the worker loads `Pwa::import_script`s through a
    policy of its own. Checked in Chromium, Firefox and WebKit, on `localhost` and on a plain `http://`
    origin off loopback, where the API and the enforcement are both there. Measured against main
    `1de9c2c2`: the runtime 33,902 to 34,523 bytes (gzip 12,092 to 12,391, brotli 10,958 to
    11,216), and each page's CSP header 58 bytes longer
    ([#741 The CSP does not require Trusted Types, so design Rule 1 (no markup from strings in a script) is not enforced by the browser, and the runtime's own innerHTML, DOMParser and service worker calls would break if it were](https://github.com/todd-skelton/corten/issues/741)).
214. Every full document is sent a `Permissions-Policy` that denies 16 powerful features no page
    uses unless the app says so (camera, microphone, screen recording, location, motion sensors,
    installed fonts, idle detection, window placement, payment, USB, serial, HID, Bluetooth,
    MIDI), so a script the CSP allows cannot ask the user for one under the app's name or read the
    sensors, which ask no one, and no frame can be given one. `Policy::allow_feature(Feature::..)`
    allows one on every page and `Sources::allow_feature` on an area's, with the area's own shell
    key; an app whose payment provider's button runs the Payment Request API in a frame allows
    `Feature::Payment` on its checkout (an app upgrading loses such a feature in Chromium, with a
    console error naming it, until it allows it). Only a document is sent it, an HTML or XML answer
    (XHTML, SVG, `text/xml`, any `+xml` type) other than a navigation's or a patch's page, decided
    by the answer and the request's mode together, so an HTML file a navigation fetched has it; JSON, scripts and
    stylesheets are not. A relayed page keeps the one its upstream sent and gets Corten's when it
    brought none; a line the app's middleware or a handler adds goes after Corten's, so it denies more (the
    browser reads a feature's last entry), and must parse, since Chromium drops the whole header
    for one malformed line.
    `Public::header` does not take it. Only Chromium-based browsers read it today. A page's
    header map now reserves 13 headers, not 12: with HSTS a compressed page sends 13
    (`Content-Encoding` beside `Content-Length`), the default error page 12 and a compressed app
    error page 13 (with `X-Robots-Tag`), and with 12 each of them, the default error page too
    (its `Vary` is appended to a full map), grew to capacity 24, as does any page with a header
    of the app's own (counted in a scratch test; without HSTS only the last grew). 13 starts at
    capacity 24 (a 32-slot index, not 16), estimated about 1.3 KB more a response, of which only
    the larger index (64 bytes) is written; those pages grew to that size anyway. Every name is one
    Chromium 156 knows, so no page logs a warning for it, except `bluetooth` in a build without
    Web Bluetooth (Linux), which logs "Unrecognized feature" once a page load and still denies the
    rest; the card-market smoke checks that in Chromium. Each full document is 250 bytes larger (on HTTP/1.1, before header compression) and
    costs about 330 instructions more, the content type's lookup and the header's insert, less
    what the sparser map saves: a small page 22,018 (22,017-22,031) on main `557920cb` to 22,356
    (22,351-22,357); the default error page with HSTS 26,211 (26,209-26,224) to 26,378
    (26,377-26,380); a navigation, which also looks for `corten-page`, 23,495 (23,214-23,541) to
    23,301 (23,300-23,304), inside main's spread; and the runtime, which pays the content type's
    check, 21,789 (21,392-21,841) to 22,038 (22,037-22,039), where main's runs also vary more than
    the builds differ but every run of this build is above every run of main's. At this head, 12
    against 13, median (range): a page with HSTS 22,748 (22,741-22,750) to 22,552
    (22,546-22,555), one with a header of the app's own 25,044 (25,034-25,044) to 23,486
    (23,481-23,490), the default error page 27,696 (27,598-28,270) to 26,378 (26,377-26,380), a
    page 22,550 (22,544-22,551) to 22,356 (22,351-22,357), a navigation 23,495 (23,495-23,497) to
    23,301 (23,300-23,304); no ranges overlap (callgrind, release build, in process, 1,200 less
    200 requests over 1,000, five runs). Times, card-market's `render_cost` on 500 items (one item's fixture copied),
    five alternating runs each, median (range), 12 against 13, without and with HSTS (the app's
    `HTTPS` variable): the
    identity document 23.9 (19.1-29.0) to 25.0 (22.1-35.8) us and 25.6 (20.2-30.1) to 24.5
    (18.8-27.3) us, brotli 201.5 (162.4-236.6) to 191.4 (158.9-226.9) us and 181.9 (168.7-202.9)
    to 174.3 (170.3-182.6) us; every range overlaps, so Docker Desktop's times show no difference
    either way
    ([#743 Corten sends no Permissions-Policy, so a third-party script an area allows can use every powerful feature the origin has; the header is enforced only in Chromium today](https://github.com/todd-skelton/corten/issues/743)).

215. `Public::stale_if_error(..)` writes `stale-if-error` (RFC 5861) next to
    `stale-while-revalidate`, so a CDN (or any cache that implements it) may serve a recently
    expired public page instead of the error while the app is down, restarting or answering 500,
    502, 503 or 504. It stays when the answer is sent privately, like `stale-while-revalidate`,
    and does nothing to `Public::immutable`; `docs/guide/app.md` (Caching) notes that a shared
    cache that follows RFC 9111 serves neither stale directive on an answer with `s-maxage`
    (`.shared(..)`)
    ([#786 Public has stale-while-revalidate but no stale-if-error, so a CDN serves the origin's error instead of a recent copy while the app is down or mid-deploy](https://github.com/todd-skelton/corten/issues/786)).

216. A page route's answer to a `GET` or `HEAD` (a page, a swap, a patch read again, a data client's
    JSON, a `Media` file) carries a weak `ETag`, a keyed hash (the standard library's `RandomState`,
    keyed per process) of the body it rendered, its `Content-Type` and its `corten-*` headers, and a
    request whose `If-None-Match` names it is answered `304 Not Modified` with no body, before
    compression. The browser keeps a `private, no-cache` page and asks before reusing it; until now
    it was always sent the whole page again. Chromium and Firefox ask on a reload, a revisit and the
    runtime's navigations and prefetches; WebKit 27.2 on a typed URL or a link without the runtime
    only (probed with Playwright 1.64.1; the card-market smoke checks Chromium's revisit and
    navigation fetch). Chromium keeps one copy per URL, so after the runtime fetched a page's swap a
    reload names the swap's tag and gets the document whole. The `corten-*` headers count since a
    cache keeps a stored header a `304` leaves out, so a copy that came with a notice never stands
    in for an answer without one. Not tagged: a body with this request's nonce or a new submit key
    (`SubmitKey::field`), an answer nothing may keep or that is immutable, one with an `ETag` or
    encoding of its own, a stream, a relayed page, an error, a write, an API's answer, and, with the
    `compress` feature, a request that accepts no compression and names no tag. A file compression
    sends as it is (a PNG, a PDF) is tagged, since its `304` saves the whole body. A `304` keeps the
    page's headers (its cookies, its `Vary`, from the rule compression uses) and sends no
    `Content-Type` or `Content-Length` (RFC 9110 15.4.5, 8.6). A tagged `200` is 28 bytes larger on
    HTTP/1.1 (`etag: W/".."` and its line end). Card-market's item page, instructions per request on
    main `cdce43c7` and on this change before its rebase onto `e116aeb5` (`f56bef59`; the rebase
    changed no Rust code), median (range), callgrind, release build, in process, 1,200 less 200
    requests over 1,000, five runs (each build in its own container; main's from a run beside the
    branch's previous commit): a document with zstd 368,662 (368,575-368,962) to 401,768
    (401,430-401,791), a navigation with zstd 336,526 (336,477-336,573) to 367,141
    (367,061-367,277); identity, sent no tag, 105,689 (105,612-105,959) to 105,829
    (105,089-106,166), ranges overlapping; and a revisit with the tag, 369,807 (369,633-369,964) to
    139,746 (139,544-140,050), with 2,469 body bytes to none. Brotli, measured earlier against main
    `52a63ecc` before the reviews' changes, went from 1,502,347 (1,502,134-1,502,506) to 1,533,501
    (1,533,406-1,533,785). A 1 MiB PNG `Media` to a browser took 20,824 instructions a request on
    `cdce43c7` and takes 2,645,906 on `f56bef59` (in a corten test, the medians of five runs of 20
    and of 120 requests, each count's range under 0.01%): a file is hashed in full, about 2.5
    instructions a byte, so one whose URL can name its content is better `Public::immutable`. The
    hash costs about 3 instructions a byte of a page, so a page tags in proportion to its size, and
    a tag pays for itself when about one compressed load in eight is answered `304`. Tags from
    another process do not match (design, Limits 21). A page's header map still reserves 13: a
    compressed page with HSTS now sends 14, and 13 makes the same 24 slots ([#742 Pages have no
    ETag, so a private, no-cache page the browser keeps is always sent whole again, and the reason
    given (saves bytes but not the render) is not a recorded Choice and does not count
    compression](https://github.com/todd-skelton/corten/issues/742)).
217. `bench/fullstack` compares ASP.NET Core 10 published with native AOT (`aspnet-aot`): a
    minimal API that serves the item as JSON with the same bytes as card-market's route for every
    fixture item (a whole number in a double aside; ASP.NET Core escapes HTML's characters and
    characters outside the Basic Multilingual Plane, which the fixture has none of) and its errors, headers, deadline, compression, host list and
    health checks, each with ASP.NET Core's own middleware. An app marked `pages: false` takes
    part in the JSON phases, cold start and the instruction counts only, and `droplet.mjs --apps`
    (`BENCH_APPS`) runs a round of a few apps. Measured in round aot1 (one c-8 droplet, a Platinum
    8168): JSON from memory at 64 users, Corten 22,152 a second, Razor Pages on the JIT 10,471, AOT
    7,981 (Razor's JSON route runs none of that middleware, so the round does not separate AOT's
    cost from the middleware's); cold start 8.3 ms, 833 ms (the Razor page, not its JSON route) and
    75 ms. Both ASP.NET Core apps now
    log `HttpClient` at Warning: they logged four Information lines for each call to the item API,
    which every earlier round's item-API numbers for `aspnet` include.
218. A route costly only for some of its URLs (a workflow step that calls another service) says
    which may be fetched on a hover, `#[route("/export", prefetch = cheap)]` with
    `fn cheap(at: &Export<'_>) -> bool`, and every link to the others, in a nav and through a
    `&dyn Href` prop too, is written with `data-no-prefetch`. `Route::PREFETCH` becomes
    `Route::may_prefetch(&self)`. The runtime's hover prefetch sends `Purpose: prefetch`, and a
    debug build logs one whose page took longer than half a second (or was given up on after
    that), naming its URL; release builds send the header too, for an app's own logs. A prefetch
    that is clicked is the visit, so a server answers it as it answers a click; which prefetches
    were followed only the browser knows, so visits are counted there. The item page renders as
    before (85.30k and 86.33k instructions a request on main
    e116aeb5, 85.29k and 86.27k on the branch, callgrind, release, in process, 1,200 less 200
    requests over 1,000, two runs), and the runtime grows from 34,523 to 34,612 bytes (gzip -9
    12,391 to 12,419): 19 bytes for the header, and 70 so that a prefetch answered with neither a
    page nor Corten's redirect (a proxy's 204) is aborted and not handed to the click, which
    fetches the page again rather than load the document in full. The views guide and the skill describe them
    ([#798 Hover prefetch runs a slow GET page in full and the server cannot tell it is a prefetch, so a page that grew slow costs seconds per hover until someone measures it](https://github.com/todd-skelton/corten/issues/798)).

219. A route nothing may keep says so where it is declared, `#[route("/statement", get = statement,
    no_store)]` in a routes module: each handler it names answers as `NoStore<..>` would make it,
    its failures included, and keeps its own result type and its `?`, where `NoStore<HtmlResult>`
    took an `async` block or a second function in a handler that used `?`. A request its extractors
    refuse (a path that does not parse, a `Caller` that is not signed in) is `no-store` too, which
    `NoStore<..>` cannot reach. A `Public` answer on such a route does not compile, and says why, as
    does `NoStore<Public<..>>`. The answer type the route is checked with is `NoStore<..>`. A
    route without `no_store` is written as before. A small page on a `no_store` route takes 26.49k
    instructions a request (26.49k-26.55k) where `NoStore<HtmlResult>` takes 26.54k
    (26.53k-26.59k), and its failure 31.98k (31.83k-31.98k) against 31.90k (31.79k-31.90k)
    (callgrind, release, in process, both forms in one build at 4edce0ee, 1,200 less 200 requests
    over 1,000, median and range of three runs)
    ([#815 NoStore wraps a whole answer, so a handler with ? must move its body into an async block or a second function to be kept out of caches](https://github.com/todd-skelton/corten/issues/815)).
220. `#[derive(ToJson)]` and `#[derive(FromJson)]` describe the JSON they write and read
    (`corten::json::schema::ToJsonSchema` and `FromJsonSchema`, feature `types`), from the same
    reading of `#[serde(..)]` that lays out or reads the bytes, and `corten::types` and
    `corten::agent` take their schemas from them instead of schemars: `Types::add` takes a
    `ToJsonSchema`, a tool's input a `FromJsonSchema` and its output a `ToJsonSchema`. An app no
    longer derives `JsonSchema` or depends on `schemars`, and corten no longer depends on it, so
    the two cannot disagree about a rename, a skipped field or a tag. The schemas are what schemars
    1.2.3 made of the same types for the shapes compared while developing (named, tuple, newtype,
    unit and transparent structs; `rename`, `rename_all`, `rename_all_fields`, `skip`,
    `skip_serializing_if`, field and container `default` by trait and by path,
    `deny_unknown_fields`, `flatten`; unit enums with and without doc comments and a `#` title;
    external, internal, adjacent and untagged enums; generics, numbered per instance; recursive
    types; and Rust's own types serde writes), and `json::schema`'s tests keep those values. Two
    differ. A field with a `default` that is not written while it holds that value
    (`skip_serializing_if`) shows the default on the read side, where a missing field takes it,
    on purpose (so `#[serde(default, skip_serializing_if = "Option::is_none")]` on an input field
    now gives `"default": null`); schemars left it out of both sides. And a generic type's
    `#[serde(default)]` (by `Default`) gives no `default` for any instance, since the impl does
    not require `Default` of its parameters; schemars gave each instance its value. Every
    example's `types/app.d.ts` and card-market's `tools/list` are unchanged, apart from what
    follows. A recursive tool input or output is its document, referred to as `#`, as schemars
    wrote it. A derived type compiles with a field of any type serde takes; describing one whose
    field has no schema panics naming the type (in the test that calls `Types::sync`, or at
    startup for a tool), where schemars did not compile. `Types::add` takes a type with a
    declaration of its own and panics on one without (`Vec<Row>`), and a declaration is named
    after the Rust type, not a `#[serde(rename)]` on it. An `#[event]` field's type needs a
    written schema. The read side describes what `FromJson` reads, so an enum with data in a
    tool's input needs `FromJsonSchema` by hand. Card-market's `alerts.create` no longer says
    `format: email` on `email`, which came from `#[schemars(email)]`; the field's description
    says it is an email address, and the handler checks it as before. Without schemars,
    card-market (`types` and `agent` on) builds faster: from clean, 63.3 s against 72.7 s on
    `604b26c8`, and after `cargo clean -p corten-macros`, a median of 11.9 s against 14.4 s over
    five alternating builds (measured on the desktop in `rust:1-bookworm` with four jobs)
    ([#762 TypeScript and MCP schemas come from schemars while the JSON comes from ToJson, so two macros read the same serde attributes and can disagree](https://github.com/todd-skelton/corten/issues/762)).
221. `bench/fullstack/conform.mjs` probes what each app does around its page and JSON (security
    headers, caching, compression, the page's own form posted cross-site and with a 3 MiB field,
    error formats, host check, liveness and readiness, and a deadline when the item API hangs)
    from a container on the bench network, every app reading the item API, and prints a feature
    matrix of which of Corten's defaults each app also has. Measured locally with the apps as
    written (round conform2): the other apps with pages miss 7 to 18 of them; aspnet-aot, written
    to match Corten's, misses none
    ([#806 bench/fullstack checks that every app sends the same output but not that it does the same work, so a table can compare apps doing different jobs](https://github.com/todd-skelton/corten/issues/806)).
222. The kit's `Button` has `Info`, `Success` and `Warning` variants, filled with the tone as
    `Destructive` is and read from the theme's tokens that `Badge` and `Alert` read, so a screen
    whose notices use a tone can use it on its buttons without editing its copy; each text meets
    WCAG AA in both themes (the theme's `-foreground` pairs the kit's test checks). `corten ui add
    button --merge` takes it; the copy's `ButtonVariant` gains three cases, so a `match` on it in
    the app needs them
    ([#831 Kit Button has no success, warning or info tone though Badge and Alert do, so a port of MUI's color=success/warning buttons edits its copied button](https://github.com/todd-skelton/corten/issues/831)).

223. `Bounds<T>` (`corten::Bounds`, in the prelude): a number field's allowed values, `min` to
    `max` in steps of `step` from `min` (1 unless set, as in HTML), as one constant of the
    field's type. Spread into the input (`{..COPIES}`) it writes `min`, `max` and `step`, and a
    tag that writes one of them as well does not compile; the handler checks
    `COPIES.holds(input.copies)` and adds the app's message. A float holds when `min` plus a
    whole number of steps, typed in decimal, reads as it, so `0.3` is on a step of `0.01` and
    `4915.205` is not. That is exact while the float tells a step apart (6 significant digits
    for an `f32`, most of 7, and 15 for an `f64`); past that, entries a step apart read as one
    float, which holds when one of them is on the step (`f32` quarters past 2^21). Checked over
    8.9 million `f32` quarters up to 2e7, 4.3 million `f32` cents and 2.3 million `f64` cents,
    some past those digits: none refused. A `min` above `max` and a step not above zero hold
    nothing, and a value is refused when it, `min` and `step` need more than 38 digits side by
    side (`1e30` in steps of `1e-9`). `holds` takes about 1,000 ns for an `f64` (979 and 1,058
    in two runs, release, one desktop; an integer's is a comparison and a remainder).
    ui-gallery's listing checks its quantity and weight with the constants its inputs show,
    which it did not check before
    ([#802 A number field's range is typed three times (server check, message, input min/max) and nothing ties them, so they drift; every form hand-writes its own parse-in-range closure](https://github.com/todd-skelton/corten/issues/802)).

224. `corten_ui::rows::sort`, the handler a sort header's link calls to sort a table's rows in place
    (`on:sort={rows::sort(event, target)}` on the kit's `SortHeader`), so a table whose page has
    every row sorts by any column with no script of the app's: each cell by its `data-sort`, else
    the one `<time datetime>` or `<data value>` it holds, else the text without its hidden parts;
    decimal numbers and dates as numbers and text by an `Intl.Collator` in the page's `lang` with
    digits in numeric order, stable, empty values last, ascending then descending, with
    `aria-sort` moved to the header, as the ARIA sortable table does. A click with a modifier key,
    a table with a spanning cell in its header or bodies, and every click without the script
    follow the link, the page the server sorts; `data-no-prefetch` on the `<thead>` keeps a hover
    from fetching that page. A table that shows one page of its rows sorts on the server; the UI
    guide shows how the sort and the page share the route. The gallery's month of sales sorts by
    day, buyer and price, with the server's order for its links, a router test and browser checks.
    The script is 2,975 bytes as served (1,156 gzip -9, 1,000 brotli; release), loaded only by a
    page that uses it. In Chromium, 1,000 rows of a text column took the script 20.6 to 37.1 ms and
    the table's layout after it 54.4 to 113.3 ms, a number column 12.8 to 23.7 ms and 51.8 to
    103.0 ms; 10,000 rows, 161 to 249 ms and 581 to 929 ms of text, 135 to 213 ms and 611 to 925 ms
    of numbers (ten runs each in two sets, the machine busy). Most of it is the browser's table
    layout, which a faster sort would not change
    ([#804 Sorting a table's rows in place costs each app a SortBy enum, a query parameter, a server sort and an ~90-line script per table, so the port dropped click-to-sort from four of the five React DataGrids](https://github.com/todd-skelton/corten/issues/804)).
225. `App::max_request_head(bytes)`: the most a request's line and headers may take, on every
    listener of `serve`, `serve_on` and `serve_wrapped` (32 KiB unless set, Changed 130). A
    larger head is answered `431 Request Header Fields Too Large` as soon as it passes the limit,
    by the HTTP server, and its connection closes
    ([#822 A request head may be about 400 KiB and an app cannot lower it, so 4,000 connections holding unfinished heads took card-market to 913 MiB of its 1 GiB within the header timeout](https://github.com/todd-skelton/corten/issues/822)).
226. Layout reads: a value only the layout shows (a cart's count, an unread count) is declared once,
    `impl LayoutRead for CartCount`, registered with `App::layout_read(..)` and drawn where the
    layout writes `{later::<CartCount>()}`. Corten starts it as a page route is called for a whole
    document's `GET`, after the middleware and beside the handler, and draws its view into the page
    before the app's middleware sees it (the error page draws it when it is in already, and waits
    for none). A navigation, a `data-patch` action, a `HEAD`, an API, a data client, a route that
    answers a file, text or JSON, and a `Public` page do not start it, and an answer that draws no
    layout (a redirect) stops a read still running (one already in stays for an error page the app's
    middleware makes of it). No handler, helper or closure takes it, where the guide's extractor
    (`Ahead` in a `Chrome`) went on every handler that could draw the layout. A page that has the
    value gives it, `req.page(..)?.give::<CartCount>(v)`. A caller only a layout read looks up makes
    the page private without changing its key, so a navigation still swaps. `Answer::PAGE` (default
    false) says which answers are pages; a page from an answer type that does not say so is a debug
    error. In a debug build a `later` for a read the app does not start, one inside `<main>`, one in
    a patch, or one rendered as text or whose `to_html()` string is placed twice, is an error naming
    it; a release build draws nothing for most of them and logs it once (the guide lists each). A
    place whose `to_html()` string the page never writes draws nothing, and the page does not wait
    for its read. The views guide, the cancellation guide and the skill describe it, and design.md
    gives the choice (Choice 20). Card-market's item page, which has no layout reads, takes 86.4k to
    86.8k instructions per request at efa7503b where main 2293663a takes 85.7k to 86.2k (+0.90%,
    +0.79% and +0.29% in each pair of runs, callgrind, release, in process, 1,200 less 200 requests
    over 1,000, three alternating runs each); a small page drawing a count read takes 42.5k, the
    same page with a value its handler awaited 28.8k to 28.9k
    ([#580 A layout value read the guide's way is passed through every handler and helper that can draw the layout, so one cart count touched 172 handlers in a real app](https://github.com/todd-skelton/corten/issues/580)).
230. Under `corten dev`, the browser's console names a form control drawn with a value its own
    attributes refuse (a stored `250` under `step="100"`, a count past `max`), which stops its
    form being sent until the user changes a value they did not set, when the page, a navigation
    or a patch draws it; a blank required field, a refused form drawn again (`aria-invalid`) and a
    control in no form or a `novalidate` one are not reported. The check is a module only a dev
    server serves (`/corten/dev.js`); the runtime that loads it grows by 27 bytes minified, 12
    gzipped (measured, 34,612 to 34,639 and 12,419 to 12,431 at zlib level 9)
    ([#850 A form drawn with a stored value its own min/max/step refuse cannot be sent, and nothing (Bounds, html!, corten dev) says so; a React port meets it because fetcher.submit never ran those checks](https://github.com/todd-skelton/corten/issues/850)).
232. Under `corten dev`, the browser's console also names a live region drawn inside another
    (`role="alert"`, `"status"` or `"log"`, or `aria-live`, unless `aria-live="off"` silences it),
    such as `errors.form_message()` inside the kit's destructive `Alert`, which a screen reader
    may announce twice, when the page, a navigation or a patch draws it. Production pages are
    unchanged: the check is in `/corten/dev.js`, which only a dev server serves
    ([#873 A live region drawn inside another (an alert in an alert) is not reported, so the nesting #861 found still renders without a word](https://github.com/corten-run/corten/issues/873)).
240. `no_store(post)` on a route in a routes module: only the answers of the methods named (and a
    request their extractors refuse) are `no-store`, so a route whose page is ordinary and whose
    write shows a secret once keeps the page's own caching, the back/forward cache included, and
    the write keeps `HtmlResult` and its `?`. A method the route has no handler for, or a `Public`
    answer on a method named, does not compile. Bare `no_store` still covers every handler; the
    code generated for each handler is the one `no_store` or no flag generated before
    ([#844 no_store covers every handler a route names, so a route whose POST answer carries a secret but whose GET is a page still needs NoStore and a second function](https://github.com/todd-skelton/corten/issues/844)).

227. `App::send_timeout(d)`: once a write finds a connection's send buffer full, the client has
    this long to take more of the answer before the connection closes (60 seconds unless set, as
    nginx's `send_timeout`; `None` removes it). A client that sends requests and stops reading
    could hold its connection, task and socket as long as it liked: one pipelining 4,000 JSON
    requests and reading nothing for 75 s was held throughout. Now (card-market, `--cpus 1
    --memory 1g`, measured) one that reads nothing for 50 s still gets all 36,856,000 bytes, and
    one that reads nothing for 75 s gets 129,528 and then a reset. A keep-alive request over TCP
    runs 15 more instructions (33,172 to 33,187, callgrind, release, the least of eight runs each
    of 1,200 requests minus 200). A live stream or feed to such a
    client now ends; a slow download that keeps moving and a stream quiet between events are not
    cut. On the clock `App::header_timeout` already ticks, applied on every listener
    ([#823 A client that stops reading its answers holds its connection as long as it likes: the header timeout and the deadline end before the answer is written, and nothing bounds the send](https://github.com/todd-skelton/corten/issues/823)).
228. `html!` refuses a name assistive technology would drop: `aria-label` or `aria-labelledby` on
    a `<div>` or `<span>` with no `role`, or on an `<a>` with no `href`, does not compile, and
    neither does an `<a>` named that way whose `href={..}` is an `Option` or `bool`, which may write
    none. Elements inside an `<svg>` are not checked (an SVG `<a>` with no href is a group,
    which may be named). The check is a type's, so the code a page runs is the same as before. The
    app guide's new "Accessibility" shows an axe-core audit run with `page.evaluate`, which works
    under the page's Trusted Types in Chromium, Firefox and WebKit without bypassing its CSP
    ([#843 Nothing audits a page's accessibility, and axe cannot be injected into a Corten page without bypassing its CSP, so an aria-label on an <a> whose href is None shipped past the gate](https://github.com/todd-skelton/corten/issues/843)).
229. `Entry<T>` (`corten::Entry`, in the prelude): a number field as the user typed it, the text
    as sent and the number it reads as, so a blank field, `two` or a count past the type is the
    field's message and the form drawn again with what was sent, not the error page.
    `Bounds::read(&entry)` gives the number within the bounds or `None`, and `value={&entry}` draws
    the text, a field not sent is blank, and `corten::form::read_number` reads a number in HTML's
    syntax. corten-ui's `NumberField` takes an `Entry` (Changed 133)
    ([#846 A form's typed number field that does not read is the error page, not the form with a message and what was typed, and the kit's Number accepts only a typed field](https://github.com/todd-skelton/corten/issues/846)).
231. The UI kit's `FormAlert { errors, emphasis }` (in `alert.rs`): a form's own message
    (`errors.add_form(text)`) in the destructive `Alert`, its one live region, or nothing when the
    form has none. `errors.form_message()` inside an `Alert`, which the kit's docs led to, was two
    nested `role="alert"` regions, which a screen reader may read twice; the kit, `form_message()`
    and the forms guide now say which is which
    ([#861 Errors::form_message() is always its own role=alert, so a form's refusal in the kit's destructive Alert is two nested alerts](https://github.com/todd-skelton/corten/issues/861)).
241. `bench/fullstack/trend.mjs` reports a sustained drift in Corten's numbers across full rounds,
    which no one round's comparison sees (differences under about 10% are noise). Instructions per
    request, the page's bytes and peak memory are each compared with their own baseline round
    (`trend-baseline.json`, r14) with a one-sided CUSUM past the number's noise: a drift once the
    sum passes three times its noise, each round adding no more than the worse of the rounds beside
    it, and the last two rounds are both worse by more than the noise, so a noisy round on its own
    never is. A round no worse than the baseline starts the sum again, so a fixed regression, or
    one noisy low round, restarts it. An instruction count 5% worse each round is reported by the
    third round, and a step that holds by its second (`trend.test.mjs`). A step of at least 3% and past the noise that holds
    against the median of the rounds before (at least three of the last five) is a warning. A
    latest round without the number has no verdict. Throughput is shown without a verdict, since
    it moves 20% between rounds on one CPU. `droplet.mjs` runs it when it collects a full round,
    writing `trend.json` and a `DRIFT:` or `WARN:` line for each number that moved (marked when
    a round's images were built from a tree with changes), and fails the collect when the trend
    cannot be made; nothing yet turns a `DRIFT:` line into an issue
    ([#867 Small performance regressions can compound without a trend detector](https://github.com/corten-run/corten/issues/867)).
242. `Policy::report_to(&route)` and `security::Violations` (feature `json`): what a page's CSP
    blocks, or under `report_only` would block, is reported to a route of the app's (or a
    collector's `https://` URL). Every page's CSP, its areas' too, ends `report-to csp`, and a
    full document is sent `Reporting-Endpoints`; a navigation's and a patch's answers are not.
    `Violations`, the route's extractor, reads the two shapes browsers post alike: Firefox's
    batch in the Reporting API's format (`application/reports+json`) and WebKit's one report at
    a time (`application/csp-report`), each violation's page, directive, what was blocked,
    whether it was report-only, the script and its line and column, and the older `report-uri`
    shape a collector may forward. A route without a `post` handler, or in a module that requires
    a caller, does not compile there; a URL a browser would not post to (`http:` to another host,
    a path that is no route) panics at startup. card-market reports to `/csp-reports`,
    and its smoke checks that Firefox and WebKit deliver a Trusted Types violation and the app
    reads it. Without `report_to` a page's headers are as before. With it, the CSP of each page
    and of the service worker script is 15 bytes longer (`; report-to csp`), and a full document
    and that script are sent a `Reporting-Endpoints` line, 41 bytes for card-market's endpoint
    over HTTP/1.1. Instructions per request on card-market's item page (callgrind, release, the
    count at 1,200 requests less the count at 200, over 1,000; five
    rounds, alternated, medians): without `report_to`, 87,722 against main's 87,422, +35 to +997
    a round, inside the 1,145 main's own rounds spread over (86,508 to 87,653); with it, 88,294
    against main's 87,010 in another run, +1,021 to +1,742 a round (1.2% to 2.0%), and 88,087
    against 87,724 for the same build without it (+220 to +985)
    ([#752 Policy has no reporting endpoint, so a report-only CSP rollout (Trusted Types or any change) reports only to each visitor's console](https://github.com/todd-skelton/corten/issues/752)).
243. `corten::http`: the `http` crate (`StatusCode`, `Method`, `HeaderMap`, `HeaderName`,
    `HeaderValue`, `header`, `Uri`, `request::Parts`), the same types `corten::axum::http` names.
    The template, the examples, the guides, the corten skill and Corten's own examples name it
    instead of `corten::axum::http`, so an app's code names its HTTP vocabulary without naming
    axum; what Corten does not wrap yet (a middleware's request and response, bodies, extractors)
    stays under `corten::axum`. Already in every app's build (axum's tree); nothing on the request
    path changes
    ([#760 Apps name axum for http types, tests and extractors, and every app carries tower and http-body-util only to test itself](https://github.com/corten-run/corten/issues/760), first part).
244. corten-ui's `Toaster` takes `failed`, what it says when a `data-patch` submit gets no
    answer the runtime can draw (offline, a closed connection, a proxy's 502: `corten:error`),
    so a write that did not go through is no longer silent unless the page writes its own
    handler. The message stays until closed, the next submit or another page (not the page
    changing only its own address, or a dialog's own form); an empty `failed` says nothing.
    `corten:error` is now cancelable: a screen that says it its own way calls
    `preventDefault()` in a handler anywhere on the page, and the toaster says nothing.
    Breaking: a `Toaster` without `failed` does not compile. The runtime grew 28 bytes minified
    (36,282 to 36,310; 7 gzipped, 13,091 to 13,098 at zlib level 9), and `toaster.js`, served
    as written, 2,407 bytes (3,354 to 5,761; 842 gzipped, 1,273 to 2,115; measured)
    ([#903 A data-patch submit that gets no answer says nothing unless the page writes a corten:error script; the kit Toaster could say it, as it does for corten:notice](https://github.com/corten-run/corten/issues/903)).
245. `corten::testing` and `App::test()`: a test sends requests to the finished app (its
    middleware, layers and error page) without a socket and reads the whole answer:
    `app.test().post(&url::Greet).mode(Mode::Action).field(GreetForm::FIELDS.name, "Ada").await`.
    The address is a route or a `Local`, never text; a form's fields are its `FIELDS` with values
    of their types (a forged one through `untyped()`, a submit key from `testing::submit_key()`);
    a `GET` takes no fields and a form no body, which do not compile, and a urlencoded body sent
    through `.call(..).body(..)` panics naming `.post`. A request asks for HTML as a
    browser's page load does unless `.mode(..)` says otherwise; `.cookie`, `.header`, `.peer`
    (the client address), `.json` and `.body` cover the rest, and the answer reads its status,
    headers, cookies, redirect (`location()`) and body. The template and the examples test with it
    and no longer depend on `tower` or `http-body-util` (card-market keeps them for its two
    router benchmarks)
    ([#760 Apps name axum for http types, tests and extractors, and every app carries tower and http-body-util only to test itself](https://github.com/corten-run/corten/issues/760)).
246. `corten::extract` (`FromRequestParts`, `OptionalFromRequestParts`, `FromRequest`, `Request`,
    `State`), `corten::middleware::{Response, IntoResponse}`, `corten::answer::Body`,
    `corten::Bytes` and `corten::Listener`: what an app names to write its own extractor, a
    middleware, a relay or a listener, so it imports Corten alone. They are axum's traits and types
    (and the `bytes` crate's), not new ones. Breaking: `corten::FromRef` (and the prelude's) is now
    the trait as well as the derive, so `FromRef<S>` bounds work with the prelude, and a file that
    imports both `corten::FromRef` (or `prelude::FromRef`) and `corten::axum::extract::FromRef` by
    name fails to compile (E0252): drop the axum import. The template, the examples, the guides and the skill no longer name `corten::axum`
    outside card-market's benchmark against bare axum, and `npm run check` keeps it so (design
    Choice 21)
    ([#760 Apps name axum for http types, tests and extractors, and every app carries tower and http-body-util only to test itself](https://github.com/corten-run/corten/issues/760)).
247. A page's locale can be in its URL: `corten::i18n::Locale<Msg>` is a route field read only as
    one of the tags `messages!` lists, as it lists it (`/{lang}/categories/{slug}`; another, or
    `/FR/`, is refused, 400), and `req.set_locale(at.lang)`, called before the locale is read (a
    debug build stops a late one), makes `req.t()`, `req.lang()` and the error page follow it whatever
    `Accept-Language` asks. Its answer does not vary on `Accept-Language`, so a shared cache keeps
    one copy of a `Public` page per locale rather than one per browser's header string (or one
    language for everyone, where it ignores `Vary`), and a client navigation to the page in
    another locale loads it in full. Every page and screen in an app with messages now says its
    locale in `Content-Language`, and a request negotiates its locale once, where `req.t()` and `req.lang()`
    each negotiated it. Measured on card-market's item page in process under callgrind, three rounds:
    88,143 instructions per request on main and 88,222 with this (medians, +0.1%; one round read
    89,072). Design Choice 22; the views, app and deploy guides
    and the skill say when to use it
    ([#784 A Public page in an app with messages varies on the raw Accept-Language header, so a CDN keeps one copy per browser's header string, or serves one language to everyone if it ignores Vary](https://github.com/corten-run/corten/issues/784)).
249. `corten_ui::ordered::send` and `ordered::link`, with `corten_ui::sorted(&SalesId)`: a form or
    link outside a sorted table's part sends the order the table shows. Their table ids are
    `corten::script::ElementId`, a new script parameter type (an element's `#[derive(Id)]` id,
    `ElementId[]` in JSDoc), so a string where an id belongs does not compile
    ([#930 rows::sort's order is lost when a form outside the table's part posts the page's old order (the port's Refresh supply)](https://github.com/corten-run/corten/issues/930)).
250. In a debug build (`corten dev`, router tests), an app that has a stylesheet (its components',
    an area's, or a `.css` file among its static files) and no `App::error_page` is told once at
    startup that its failures are Corten's plain document, not its layout. The default is
    unchanged, and a release build says nothing
    ([#801 An app with a layout and no App::error_page fails every request as Corten's unstyled plain document, and nothing (check, debug build, startup) says so](https://github.com/corten-run/corten/issues/801)).
251. A route whose page always gives a layout read's value says so, `#[route("/cart", get = cart,
    gives(CartCount))]` in its routes module, and Corten does not start that read for it: the read
    starts before the handler, so a page that gave the value still sent the read's query and
    dropped it. A type there that is not a `LayoutRead`, or `gives` on a route with no `get`, does
    not compile; a page from the route that does not give the value draws nothing there, and a debug
    build refuses it; the route's error page starts the read as any error page does. Measured
    (callgrind, instructions per request, median of 3): a page with a read and no `gives` is
    39,916 on main and 40,053 with this (+0.3%); a `gives` route that gives the value is 41,330,
    1,277 more than starting the read, which here is a ready future: the saving is the read's own
    query, which the probe does not have
    ([#869 A page that gives a layout read's value still starts the read, so its query runs and is dropped](https://github.com/corten-run/corten/issues/869)).
252. A handler refuses as an extractor does: `Err(Refused::forbidden())?` (`From<Refused> for
    corten::Error`). It is answered as a `Caller`'s refusal: the error page at the refusal's status, a
    sign-in's redirect, a 429's `Retry-After`, and, since the request is at fault, the layout's reads
    drawn on its error page as for a 404, where `Error::status(StatusCode::FORBIDDEN)` starts none (it
    may stand for a service that is down). `.with_status(..)` on it makes it a plain failure at that
    status. The cost is one type check on an error's way out, and none on a page's:
    a 404 from `Error::not_found()` measured 34,795 instructions on main and 35,093 with this
    (callgrind, median of 3), +298 (0.9%), at the edge of main's own rounds (34,790 to 35,084)
    ([#890 A handler cannot refuse a request the way an extractor does, so its 403 page starts no layout read](https://github.com/corten-run/corten/issues/890)).
253. The kit's `FailedAlert { said, emphasis }` (in `alert.rs`), around its children: the text a
    dialog shows when a submit in it got no answer (corten-ui's `dialog::failed`) in the
    destructive alert's look. It is a live region with no look of its own that stays rendered, and
    in it the alert, which is `said` and hidden until the script shows it, so no empty box shows
    before a failure and no alert is inside another. The kit's `dialog` example and ui-gallery's
    rename dialog use it; corten-ui's own examples keep a bare `<p>`, since corten-ui does not
    depend on the kit, and point to it
    ([#969 corten-ui: dialog::failed's text has no kit look: Alert takes no ref, and an Alert in the persistent role=alert region nests alerts or shows an empty box](https://github.com/corten-run/corten/issues/969)).
254. `corten check` fails, naming the file and line, for a component with a stylesheet, script or
    view (`#[component(css)]`, `js` or `view`) that no array names (a `COMPONENTS` list,
    `.components(&[..])`, a `vec![..]`; by its name or a `use .. as` one, in its own crate or a
    workspace member that depends on it, directly or through another, from the root or a member's
    directory), before clippy and the tests. Such a component passed both and failed only when a
    debug build drew it, or went without its stylesheet in a release build. It reads the source, as
    `corten fmt` does, and skips test code (design, Limits 9). `corten fmt` no longer reads past a
    `'\\'` char literal as if it were still inside it. Corten's examples, `corten-ui`, the template
    and the tcgplayer port pass it unchanged
    ([#970 A styled component nested in a listed one but not listed itself passes clippy and corten check, and 500s only when a debug build draws that branch](https://github.com/corten-run/corten/issues/970)).
255. An element of a layout beside `<main>` that depends on the page (a section's nav) is marked
    `page` in `html!`, `<nav page id={SectionNavId}>`: a navigation's answer has it with `<main>`'s
    children, and the runtime puts it in place of the one on screen by its `#[derive(Id)]` id when
    the page draws it differently (one drawn the same keeps its scroll and its scripts' state), so a
    link to another section shows that section's links without a full load. It does not compile
    without a typed id without a key, inside `for`, `if` or `match`, on or in `<head>`, on or
    around `<main>`, inside another, in a component's children, or outside a document, and a debug
    build refuses a layout read drawn in it. A bare `page` attribute is now this mark: an element's
    own attribute of that name is written `page=""`. A layout that writes no `page` renders as before
    (card-market's item page `render_cost` under callgrind: 35.47 billion instructions before and
    after, medians of three runs), and the minified runtime grows 242 B gzipped
    ([#982 A layout part outside <main> that depends on the page (a section's sub-nav) keeps the first page's after a client navigation](https://github.com/corten-run/corten/issues/982)).
256. `corten::extract::bytes_up_to(body, max)`: a whole request body, or `None` when it is over
    `max`, for a handler that takes the `Request` and answers a body over a limit of its own
    itself, as a route that keeps another server's error shape must. The rest of a body over it is
    read past (up to 64 MiB), as an upload's is, so a client still sending reads the answer. Apps
    named axum's `to_bytes` for it, whose one error is both a body over the limit and one that
    broke. It costs no more: reading an 8 KiB body whole and one in eight pieces takes 6,028
    instructions with it and 6,046 with `to_bytes` (callgrind, the ignored
    `what_reading_a_body_costs` test, three runs). Design Choice 21 and the app guide also say a
    test's stand-in for another service stays axum's `Router` and `serve` through `corten::axum`
    ([#949 A handler that reads the whole body up to its own limit still names axum: corten::axum::body::to_bytes has no Corten name](https://github.com/corten-run/corten/issues/949),
    [#950 A test's stand-in for an upstream API has no Corten name: apps still write corten::axum::Router and corten::axum::serve for it](https://github.com/corten-run/corten/issues/950)).
257. An API's OpenAPI 3.1 document, generated from its routes (feature `types`):
    `#[corten::routes(api = ApiRoot, openapi = ApiDoc)]` serves it at a route of the module with no
    handler. Each handler is an operation named after it, summarized by its route's doc comment,
    with its path and query parameters (`Params<R>`, a `#[route(query)]` set's fields, each with its
    type's JSON Schema, a `UrlValue` enum's words), its body (`Json<T>`), its 200
    (`JsonResult<T>`), its credential as a security scheme (`Operation::api_key`, `bearer`) and a
    `default` response for every failure (Problem Details, or the API's own JSON with
    `Api::errors`). Every argument
    and answer says how it appears (`corten::openapi::Argument`, `Answers`), checked when the crate
    compiles, so no handler is left out or described as less than it is; an app's own extractor or
    answer type implements them. The document is built once with the router; a request that is not
    for it costs nothing more. `corten::openapi::sync` keeps a copy beside the code; card-market's
    is checked against the OpenAPI 3.1 schema by `npm run check`
    ([#954 API routes have no OpenAPI document, though Corten already generates JSON Schema for their input and answer types](https://github.com/corten-run/corten/issues/954)).
258. `corten` declares the runtime's two events for a script, `CortenError` (`corten:error`,
    `detail: { status, error? }`) and `CortenNotice` (`corten:notice`, `detail: { message }`):
    `/** @import { CortenError } from "corten" */` and `@param {CortenError} event`. A handler
    typed so is checked where the markup calls it, so `on:click={js::failed(event, ..)}` or
    `js::failed(signal, ..)` does not compile, and its `detail` is the runtime's, not a copy
    each script casts. A handler typed `CustomEvent<..>` (or any event interface with type
    arguments, when that is the whole type and not part of a union) is checked as that
    interface, where it took any argument before. An `#[event]` named after a browser or runtime
    event (`CortenError`, `KeyboardEvent`) does not compile, since a handler's `@param` naming it
    is checked as that event. corten-ui's
    toaster and `dialog::failed` and deck-builder use them. The `data-on` it writes is unchanged
    ([#991 A handler typed CustomEvent<..> for corten:error or corten:notice takes any argument, so a click's event or a signal compiles and detail is typed by hand](https://github.com/corten-run/corten/issues/991)).
259. `Media::stream(type, chunks)` and `Media::stream_sized(type, length, chunks)`: a download the
    app makes as it is sent (an export of every order, an archive), from a stream of
    `Result<Bytes, E>`. It is pulled only as fast as the client reads and dropped when the client
    leaves, it keeps `Media`'s file name, headers and caching, and a text type is compressed a
    chunk at a time (zstd or brotli, as an event stream is), its frame ended when the stream ends;
    an event stream that ends now ends its frame too, where a decoder that checks for the end
    took it as cut short. A failure after it began, or a stream that does not make the length it
    said, ends the connection without the body's end and is logged. auction-room's bid history is
    read from its store a page at a time this way. Measured with `what_a_large_download_costs`
    (512 MiB generated in 64 KiB chunks, over a socket, release, three runs each): streamed, the
    first body bytes arrive in 2.1 to 9.0 ms and the process peaks at 10 MiB resident (7 MiB
    before the request); held in `Media::new`, the first bytes take 273 to 447 ms and it peaks at
    522 MiB. A buffered answer now pays one size check in compression: a whole document with two
    layout reads took 66,120, 66,144 and 66,301 instructions per request on main and 66,112,
    66,221 and 66,099 on this branch (callgrind, three alternating rounds), the same within
    noise. Ending an event stream's frame changes its path from a filter to an unfold:
    `what_an_event_stream_costs` (callgrind, release, 12,000 minus 2,000 redraws, making each
    redraw included, three alternating rounds, each round the same) took 100,382 instructions an
    event with zstd on main and 100,474 on this branch (+0.09%), brotli 213,884 against 213,716
    (-0.08%), and the stream is 3 bytes longer, its frame's end
    ([#1001 Media only accepts buffered bytes, so a large generated download needs Relay instead of an app-owned streaming answer](https://github.com/corten-run/corten/issues/1001)).
260. `corten::Error` implements `Display`, writing its source's message (what the log says), and
    `Error::status_code()` returns the status of the answer it makes (a sign-in's 401, which a
    browser gets as a redirect), so a handler that answers in
    a shape of its own (a route keeping another server's `{"error": ..}` bodies) can say why a
    step failed: `extract::bytes_up_to`'s `Err` for a body that could not be read, which it could
    only answer with a fixed message before. The accessor is named apart from `Error::status`,
    which makes an error. `std::error::Error` stays unimplemented, since the conversion from any
    error (`From<E: std::error::Error>`) would then include `Error` itself. Corten still never
    sends a 5xx message to a browser. The message is the log's, so it can name what a
    `with_status` hid (a refusal answered as a 404 says `refused: 403 Forbidden`); an app that
    sends it, in its own body or in markup, chooses to
    ([#995 corten::Error has no Display or status accessor, so a handler answering in its own JSON shape cannot say why a body read failed](https://github.com/corten-run/corten/issues/995)).
261. `corten::extract::pieces_up_to(body, max)`: a body too large to hold (a file `PUT` as
    `application/octet-stream` to a disk or an object store) read as it arrives, one piece at a
    time with `chunk()`, as an upload's file is. It counts what arrives, whatever the
    `Content-Length` says, and refuses a body over `max` (`BodyError::TooLarge`, a 413) as
    `bytes_up_to` does, reading past the rest until the body has sent 64 MiB more than `max`, so
    a browser, which sends the whole body before it reads the answer, reads the 413 rather than a
    closed connection; a body whose length says it is over is refused before a piece is handed
    out. A client that sends nothing for a minute (`Pieces::idle`, nginx's
    `client_body_timeout`) is `Stalled`, a 408; the minute holds for each piece while reading
    past too, so a slow client still sending is not cut off for the read past in all (one that
    stops there is still the 413), and one that breaks is `Broken`, a 400. The deploy guide's
    nginx setup gives such a route a `location` whose limit is `max` and the read-past, with
    `proxy_request_buffering off`. Counting the body stream by hand, the first shape tried,
    stops at the limit, which a raw-socket client that sends its body before reading (as a
    browser does) saw as a dropped connection 6 times of 6, where `bytes_up_to` answered 9 of 9;
    a reader keeps that read-past in one place. Measured with `what_a_large_upload_costs` (1 GiB
    over a socket, release, three runs, with the idle timer on each piece): 262 to 286 ms, the
    process peaking at 10 MiB resident (7 MiB before the request), the largest piece 496 KiB.
    Nothing else on the request path changes: `bytes_up_to` calls the same read-past, moved into
    a function, only for a body over its limit
    ([#1003 Evaluate a bounded raw-body chunk reader for large PUT and POST uploads without buffering or duplicating limit handling](https://github.com/corten-run/corten/issues/1003)).
262. `on:corten:progress` on a `data-patch` form: its handler is called with the browser's
    `ProgressEvent` while a multipart write's body is sent (`loaded` and `total` count the whole
    request, `lengthComputable` says whether `total` is known), so an upload's progress is a native
    `<progress>` the app fills, with Corten's submit (its keys, refusals, redirects, cancellation)
    kept. Such a form's multipart writes go by `XMLHttpRequest`, which reports upload progress
    where `fetch` does not, in a module of its own (`corten-upload`, 861 bytes, 540 gzipped) that
    only a page with such a form loads; every other submit is a `fetch` as before. The form stays
    `aria-busy` until the answer is drawn, a navigation abandons it (its events stop, its answer is
    not drawn, and one left while the module loads is never sent), a newer submit of the form waits
    for it as for any write, and without JavaScript it posts as before. A handler typed
    `ProgressEvent` takes no other event, and `corten:progress` is heard only on a `data-patch`
    `<form>` with a body method and `enctype="multipart/form-data"`, all at compile time
    (design.md, Choice 29). The
    runtime grows by 424 bytes minified (40,232 to 40,656), 166 gzipped (14,427 to 14,593 at
    `build:js`'s level 6; 14,394 to 14,560 at level 9) and 151 with brotli (13,019 to 13,170, quality
    11); a page's binding of an element's handlers compares each with the progress event once, as
    it parses them, and an ordinary submit adds one check of whether the form has handlers. An
    ordinary submit's cost did not change by more than its run-to-run spread: in Chromium 156,
    watchlist's `/account` page with each build of the runtime routed in its place, `window.fetch`
    replaced by one answering a 204 at once, its sign-out form sent 2,000 times by `requestSubmit`
    (each awaiting its `corten:error`) per sample, 20 samples per build (4 processes, alternating
    builds, 5 samples each): a median of 66.0 µs a submit (61.8 to 89.3) with this build and 69.4
    µs (58.2 to 80.4) before, leaving out one process before whose 5 samples, at 163 to 199 µs,
    ran while the machine was busy. The
    watchlist's profile picture shows the bar
    ([#1002 Enhanced multipart forms expose only aria-busy, so upload progress requires replacing Corten's submission logic](https://github.com/corten-run/corten/issues/1002)).
263. `bench/fullstack`'s build step measures more of where a Rust app is slow to work on: for the
    Rust apps, `cargo check --all-targets` clean and after the edit (what rust-analyzer runs on
    save) and the tests compiled from the dependencies and after the edit; for Corten, the
    development build after four other kinds of edit (a handler's body, a derive on a type three
    answers share, a `messages!` entry, a route added); for every app, what its dependency step,
    production build and development build write to disk; and in a round, Corten's and axum +
    Maud's clean build again on two vCPUs and on all of them, and their development build linked
    by mold, with the linker of each build read from the binary. A failure in these steps is
    recorded apart and hides none of the app's other results. `summarize.mjs` prints each. A
    trial on a desktop (Docker Desktop, cores 0-3, one run each, not a round's machine) took
    Corten's check 1.4 s after the edit against 3.3 s for its development build and 3.5 s for its
    tests, and its development build 2.8 to 6.0 s after the other kinds of edit, the derive on a
    shared type the slowest, each recompiling card-market alone. Save to reload, rust-analyzer's
    own analysis and a Docker build with BuildKit's cache warm are left to
    [#1033 bench/fullstack does not measure save-to-reload under each stack's dev server, rust-analyzer's own latency, or a Docker build with BuildKit's cache warm](https://github.com/corten-run/corten/issues/1033)
    ([#774 bench/fullstack measures no editor, test-build, save-to-reload, disk or core-scaling cost, so where a Corten app is slow to work on is still partly unmeasured](https://github.com/corten-run/corten/issues/774)).
264. `Upload::idle(impl Into<Option<Duration>>)`: a client that sends nothing of a form upload for
    a minute, while the handler reads a file, passes one over or reads the fields, is
    `UploadError::Stalled`, a 408, as `Pieces` already was (nginx's `client_body_timeout`), so a
    stalled client no longer holds its connection, handler and a shutdown drain until the route's
    deadline. The minute holds for each piece, so an upload sent steadily is never cut off; one
    that stops while a body over the limit is read past is still the 413; `None` leaves only the
    route's deadline. Breaking: `UploadError` has a new variant, so a `match` without a wildcard
    arm needs one for `Stalled`. `Upload` and `Pieces` share one read and one timer for the whole body,
    made the first time a read waits and moved only when it goes off before the read it serves
    is due. Measured with the new `what_reading_an_upload_costs` and `what_reading_a_body_costs`
    (`READER=pieces`) under callgrind, release, instructions per read as the difference of 20 and
    120 reads, median of three runs (each within 0.1%), on main `cdbe4392` (the upload path is
    the same at `f3291094`) and with the idle time, for a 2,259-byte form sent a byte at a time (the worst case: a browser's pieces are KiB): every
    piece already there 1,942,244 to 2,027,835 (+38 a piece, +4.4%); every piece waited for
    4,150,032 to 5,341,425 (+527 a waited piece: a clock read and the timer's poll; `idle(None)`
    4,292,483); and `Pieces` reading 8 KiB a byte at a time, each byte waited for, 41,659,778 to
    33,331,597 (20% less, since it no longer makes a timer for each piece)
    ([#1030 Upload's files have no idle time, so a client that stops sending a form upload holds its request until the route's deadline](https://github.com/corten-run/corten/issues/1030)).
265. `bench/fullstack` says what each of Corten's production defaults costs a request: card-market
    is built as it is and with one default removed by each patch in `ablate/` (security headers
    and CSP, host and same-origin checks, deadline and panic catch, compression, `ETag`,
    `Cache-Control`, error pages, connection watch), and `cost-by-default.sh` counts each build's
    user instructions under callgrind only while requests are served, for the page and the JSON
    with `identity` and with a browser's `Accept-Encoding`. The README's "What each production
    default costs" table, at `cdbe4392`, five repeats: together about 12% of the page in the
    rounds' request shape (10,500 of 86,500 user instructions on one connection) and 9% of the
    JSON's, if they do not overlap (removing all at once was not measured), the security headers
    and CSP the largest (4,800 a page); for a browser, compression is two thirds of the page
    request and the page's `ETag` 7.7%. Requests per CPU-second are left to
    [#1052 No number says what each of Corten's production defaults costs in requests per CPU-second under load, only in instructions on one connection](https://github.com/corten-run/corten/issues/1052) ([#810 No round says what each of Corten's production defaults costs a request, so the cost of its safety and its speed cannot be told apart](https://github.com/corten-run/corten/issues/810)).
266. `bench/fullstack` has a matched tier
    ([#807 bench/fullstack has no tier where every app implements the same production features, so its tables mix framework cost with feature cost](https://github.com/corten-run/corten/issues/807)):
    rounds named `m<n>` (`droplet.mjs --tier matched`, `BENCH_TIER=matched`) start each of its
    apps with `PROFILE=matched`, a production profile built from its framework's own middleware,
    and never enter the defaults tier's trend. The profile is the feature matrix's counted columns,
    a header timeout and a cap of 1,000 connections, which `conform-hold.mjs` probes as two new
    columns of the tier's matrix. Corten and axum-maud are in it so far (axum-maud with
    tower-http's layers); card-market reads `MAX_CONNECTIONS` into `App::max_connections`.
267. `bench/fullstack` has a hardening step
    ([#808 bench/fullstack measures only throughput and latency, not how each server holds up against slow clients, oversized requests and connection floods](https://github.com/corten-run/corten/issues/808)):
    `harden.mjs` runs six phases against each freshly started app (unfinished heads, heads and
    bodies sent a byte a second, clients that stop reading, idle connections, oversized
    requests) beside a well-behaved client, and writes whether the app stayed up (or degraded),
    what it did with the abusive connections and what it answered them, the client's latency and
    the app's memory and CPU to `results/<round>/hardening.json`; `droplet.mjs --suite harden`
    runs it on its own cadence, a run with a phase that could not run is not a finished one, and
    a rerun of some phases records the commit each phase ran at and keeps the result it replaces.
    The README reports a local run of nine apps (measured, one run each): Corten closed every
    abusive connection in every phase and took the least CPU against clients that stop reading,
    and it falls short where a trickled body is closed by the deadline (10 s in card-market) and
    not a minimum rate, a client that stops reading by the 60 s send timeout, where Kestrel's
    minimum rates close both sooner, and a 16 MiB body's 413 was lost to the connection closing in
    1 of the 3 committed local passes.
268. `bench/fullstack`'s matched tier reaches its apps through an edge
    ([#809 bench/fullstack serves every app over plain HTTP/1.1 with no proxy, though Corten's design expects one for TLS and HTTP/2](https://github.com/corten-run/corten/issues/809)):
    one pinned nginx with one config (`edge.mjs`, the deploy guide's less its cache, with the
    app's own name as Host) terminates TLS and speaks HTTP/2 to k6 and Chromium and HTTP/1.1 to
    each app, on cores of its own (`BENCH_EDGE_CPUS`, six on a droplet), so the tier's load phases
    and browser pass measure an app as it is deployed. Each phase counts the edge's CPU beside the
    app's (`edgePerCpuSecond`, `edgeCpuUsedPct`), and k6's in every tier (`k6CpuUsedPct`); the
    summary marks a phase the edge or k6 limited (EDGE-BOUND, LOAD-BOUND) and, through the edge,
    a saturation phase whose app used less than 90% of its core (APP-IDLE), as every local one was. A matched full-stack
    round runs on a c-16, and `droplet.mjs --edge off` runs it reached directly, to compare. The defaults
    tier stays direct.
269. `bench/fullstack/REVIEW.md` tells a framework's maintainers what the comparison measures,
    what they may change in their app (settings a production deployment uses, the app's own code)
    and what they may not (caching rendered output, skipping work, tuning past the framework's
    guidance), and how to propose it; the README's app table says whether each app has been
    reviewed by its maintainers (none has been reviewed in full yet)
    ([#814 No one who maintains the other frameworks has reviewed their bench/fullstack apps, so a fair-comparison claim rests on our own reading of each](https://github.com/corten-run/corten/issues/814)).
270. `bench/fullstack` has a mixed load phase
    ([#813 Every bench/fullstack load phase hits one endpoint, so no phase exercises deadlines, write limits and caching together as a real site would](https://github.com/corten-run/corten/issues/813)):
    with items from the item API, each app's item-page phases end with 60 s at the fixed rate as
    70% item pages (2% of them an item the item API answers in 40 s, past the 35 s the matched
    profile's deadline must answer within), 20% JSON, 5% the home page and 5% the item page's form
    posted from k6's one address, all asking for compression, so a deadline, a write limit and
    compression act under load together (`mixed-load.js`, `mixed.mjs`). One post is checked
    before the phase. The summary's Mixed table gives each kind of request its latency and its
    answers by class (2xx and 3xx, 429, other 4xx, 5xx, none), with the app's CPU and peak memory.
    A round's api page call has 220 minutes and its unit 23 hours.
271. The button that sends a form is `aria-busy="true"` with the form until the answer is drawn:
    a `data-patch` form's submitter until its patch comes, and a GET form's until the page it
    started is swapped in, a button outside its form (`form=`, a row's action for one form the
    rows share) included, and through a write's answer that sends the browser to another page,
    until that page is drawn. Another button's newer GET submit of the same form takes the marks,
    and one pressed while a write is on its way is marked beside it until it sends. The
    kit's `Button` draws the state: a ring after its label in the text's color, turning unless
    the user asks for less motion, kept under forced colors, with a `progress` cursor
    ([#1063 A data-patch form's busy state lands only on the form, so a submit button outside it (form=) and the kit's Button show nothing while a server-drawn sheet loads](https://github.com/corten-run/corten/issues/1063)).
272. The kit's `pagination` has `PreviousNext`, Previous and Next alone in `Pagination`'s look,
    for a list that knows only the page before and the page after (a cursor, or the previous and
    next links an API answers with): `previous` and `next` are each an `Option<&dyn Href>`, a
    link with `rel="prev"` or `rel="next"`, and a `None` one a disabled step. It shares
    `pagination.css`, so a copied `pagination.rs` takes it from `corten ui diff`. The
    ui-gallery's payouts card pages by it
    ([#1073 Kit Pagination needs every page's link, so a list paged by previous and next links (a cursor, or the API's own) cannot use it](https://github.com/corten-run/corten/issues/1073)).
273. The kit's `Progress` takes a tone beside its size,
    `Progress { size, tone: ProgressTone::Success }` (`Primary`, `Info`, `Success`, `Warning`,
    `Destructive`), each 3:1 against the track in both themes (the kit's test), so a task that
    finished or failed is drawn in the theme's success or destructive color without an app's page
    rule, which tied with the kit's `::-webkit-progress-value` rule and won only by stylesheet
    order. `Primary` is the bar it was; `Info` is one under way on a screen whose primary color
    marks its actions. The tone is the fill and the band of a bar with no value; under forced
    colors every tone is the system's highlight, as the meter's states are, so the label or the
    words beside the bar say how the task ended. Measured on the kit file as the Dialog's entry
    was: `progress.css` 1,617 to 1,794 bytes (gzip 516 to 567, brotli 412 to 465). Breaking: a
    `Progress { size }` does not compile until it names its tone, which the compiler names;
    `corten ui add progress --merge` updates a copy. The ui-gallery's label run shows a finished
    one
    ([#1059 Kit Progress has no tone, so a finished or failed task's bar cannot be drawn in the theme's success or destructive color](https://github.com/corten-run/corten/issues/1059)).
274. The kit's segmented control takes a width on each of its three forms,
    `<Segmented width={SegmentedWidth::Fill}>`, `SegmentedLinks { width }` and
    `<SegmentedRadios width={..}>`: `Fit`, as wide as its choices (the look it had), or `Fill`, the
    width of its box with the choices in equal parts, as a phone's bar of a few choices (a side, a
    period) is drawn so each is a wide target, the fieldset of `SegmentedRadios` filling its box as
    a flex or grid item too. A filled choice is at least a control's height and its label wraps in
    its part, a word wider than the part breaking inside it, so a narrow screen does not scroll
    sideways. The fill rules are one
    class more specific than the track's, so they win wherever the stylesheets are linked; an app's
    page rule for a full-width bar tied with the kit's and won only by stylesheet order. Measured as
    the Dialog's entry was: `segmented.css` 1,858 to 2,371 bytes (gzip 726 to 856, brotli 577 to
    693). Breaking: each form names its width, which the compiler names; `corten ui add segmented
    --merge` updates a copy. The ui-gallery's label size radios fill the form's column
    ([#1060 Kit Segmented draws only as wide as its choices, so a phone's full-width choice bar (equal parts across the row) keeps its own segmented rules](https://github.com/corten-run/corten/issues/1060)).
275. A kit `Stats` figure's type is the theme's: `--stat-label-font-size`, `--stat-label-font-weight`,
    `--stat-value-font-size`, `--stat-value-font-size-narrow` (a phone's), `--stat-value-font-weight`,
    and `--stat-label-tracking` and `--stat-value-tracking` (`number` tokens in ems), with
    today's values in the kit's theme, so a design system that draws its figures differently sets
    them in one place and the copy stays the kit's. The value is in the page's face and the label
    as written unless the app declares `--stat-value-font-family` (a `fontFamily` token) or
    `--stat-label-text-transform` (in `static/style.css`, as DTCG has no type for it), which the
    stylesheet reads with a fallback. A page's rule for `dt` or `dd` no longer gives the label
    its case or letter spacing, or the value its face, as it could before. An app set up by an
    older kit adds the seven tokens `corten ui add stats --merge` names (or `--force`, for a copy
    without edits) before it starts. The ui-gallery's served `components.css` (every kit
    component, the kit's theme) is 59,274 bytes where it was 58,753 (gzip 9,864 against 9,717,
    brotli 8,657 against 8,567), the theme's seven tokens (210 bytes, on every page of an app on
    the kit's theme) included; the earlier size is the served file with the old rules put back
    ([#1054 Kit Stats writes its label and figure type as literals, so a theme with a display face or uppercase labels (Chase Sets' design system) edits the copied stats.css](https://github.com/corten-run/corten/issues/1054)).
276. The kit's `stack` has `StackStart`, a look written beside a `Stack`
    (`class={(Stack { gap: Gap::Xs }, StackStart {})}`): the column's children keep their own
    width at its start (its end on a right-to-left page), each at most the stack's, a word wider than
    that breaking inside it and a picture narrowing in its shape, for a column of links as wide as
    their words, badges, or a button under a line of text. Its rule names both classes, so it wins
    over `.stack`'s wherever an app links its stylesheets and does nothing beside a `Cluster` or
    alone; an app's own `align-items` on the stack tied with the kit's and won only by stylesheet
    order. Not breaking: every `Stack { gap }` is as it was, and a copied `stack.rs` and
    `stack.css` take it from `corten ui diff`. Measured as the Dialog's entry was: `stack.css` 237 to 395 bytes
    (gzip 164 to 226, brotli 125 to 182). The ui-gallery's selling limit card has a column of a
    link and a badge
    ([#1119 Kit Stack always stretches its children, so a column of links, badges or a button at their own width keeps a page rule that ties with .stack](https://github.com/corten-run/corten/issues/1119)).

### Removed
1. `#[island]`, `#[prop]`, `island()` and the custom element each island was. A component with a
   script renders its own root element, marked `data-scope`; `corten-ui`'s components are
   `#[component(js)]` with a `div` root. `Types::components` declares typed events instead of
   `CortenIslands`, and `corten::find_islands` is gone (the page preloads the modules its
   handlers named while it rendered).
2. The `solid` feature, `corten/solid`, `corten::solid_path` and `SOLID_JS`. Rows a script
   changes are views, which measured faster to take over (7-8.5 ms against 18-20 ms for 1,000
   server-rendered rows) and lighter (116 bytes a row against 927), and the framework no longer
   ships a third-party JavaScript bundle. Solid stays in `bench/browser` as a comparison.
4. `App::shell`, `Meta` (`corten::meta`) and the shell's `Document` struct (`doc.head`, `doc.main`,
   `doc.asset`, `doc.current`, `doc.nonce`): the app's layout component replaces them. Corten
   has no built-in shell; an app without `App::error_page` gets a plain error document.
5. `App::context`, `App<C>`, `Req::context`, `Area::guard`, `App::guard`, `App::unguarded`,
   `Api::guard`, `Api::context` and `Access`: a handler takes `Caller<T>` instead, and an area's
   routes module says `caller = T`. Migrate a context to an `Identify` impl, a guard on an area to
   `caller = ..` on its routes module (with a caller type per role), and `App::guard` to
   `caller = ..` on the app's routes module with the sign-in route in a module of its own.
6. `Cache` from the public API and the prelude, and axum's `Router`, `get`, `post`, `put` and
   `delete` from the prelude (`get` and the others there are Corten's now). Return `Public<..>`
   instead of `(Cache::public(..), page)` and `NoStore<..>` instead of `(Cache::no_store(),
   page)`; build routes in a `#[corten::routes]` module instead of an axum `Router`. A layer on
   one route's method router has no replacement: a route's needs are its handler's extractors
   and answer, and the app's own steps are `Middleware`.
7. `Result` from the prelude, and `corten::Result`'s default `Response`: a handler answers with
   `HtmlResult`, `JsonResult<T>` or another answer, and `corten::Result<T>` (`Result<T,
   corten::Error>`) is for helpers. A bare `corten::Result` names no answer and does not compile.
8. The `link` keyword of `#[route]` in a routes module: a route an API serves goes in the API's
   own `#[corten::routes(api = ..)]` module, with its handler.
9. `Req::current`: `req.nav(&route)` writes the whole nav link, and `req.is_current` answers
   the question elsewhere.
10. `STATIC_DIR`, the default `static/` read from the working directory, `App::assets(dir)`,
    `Req::has_asset`, and `Assets::load`, `Assets::build` and `Assets::url` from the public API:
    static files are compiled in (Changed 73).
11. `corten::Query`, and axum's `Path` from the prelude: a route's parameters are its `Params`,
    whether its handler is named in a routes module or added by hand (`Area::route`), and a
    `GET` form's fields its `Form` ([#207 A handler reads its path parameters with Path<String>, so nothing checks them against the route struct that declares them](https://github.com/todd-skelton/corten/issues/207)).
12. `Route::PREFETCH`: a route says it with `Route::may_prefetch(&self)`, written by
    `#[route("..", prefetch = ..)]` (Added 218).
13. `corten::event_stream`, `StreamEvent` and `EventStreamResponse`: named JSON events over
    server-sent events, read by a script's own `EventSource`. Their names and data were strings at
    the seam, and nothing outside Corten's own tests used them. A job's progress is a `<progress>` a
    `<corten-live>` stream draws again, a growing log or answer a `view::Append` per piece, and data
    a script keeps a feed (one job is a feed of one row); a stream in a format another party defines
    is a `Relay` of the app's own body. Breaking for an app that used them (the live-data guide,
    Which one). Design Limit 17, which recorded that they were untyped, is gone, so Limits 18 to 24
    are now 17 to 23, and the other entries here that cite them say the new numbers
    ([#964 corten::event_stream is public, untyped at the seam and unused outside Corten's own tests: remove it before 1.0 or record what only it serves](https://github.com/corten-run/corten/issues/964)).

### Changed

- Nightly benchmarking moves to equivalent-localization marketplace v2 from official r17,
  with a new baseline, detached launch/collection and three short-window CPU, memory, load
  and cold-start passes. Pages cover all three locales; locale-neutral JSON runs once per
  source per pass. Catalog remains an optional separate diagnostic. Historical results and
  labels are preserved, but unequal legacy localization no longer supports general speed
  rankings; v2 comparisons require compatible rounds, not r16 or catalog c1 deltas.

1. A handler never runs after its event: markup a navigation or patch inserts waits for the
   modules its handlers name, and an event that comes before its module on the first page gets
   the browser's default instead of a late handler. `patch()` returns a promise.
2. Every JSON failure has one shape, `{"error":{"status":404,"message":"Not Found"}}`. A data
   request's error now carries `message`, and an extractor's rejection is that JSON instead of
   plain text. `req.invalid` answers a data request with
   `{"error":{"status":422,"message":...,"fields":{...}}}` instead of `{"errors":{...}}`.
3. The CSP nonce is made only when a document asks for it; other responses get the same policy
   without a nonce source. `Policy::apply` no longer puts a `Nonce` in the request extensions:
   take `nonce: Nonce` as an extractor instead of `Extension<Nonce>`.
4. `App::context` no longer runs for static files, the runtime, the PWA files and the health
   checks.
5. `App` is one middleware instead of three (security, compression, errors). Measured with
   callgrind, a small JSON handler costs 27,584 instructions a request instead of 36,324, a
   small page 31,742 instead of 41,280, and a JSON 404 19,892 instead of 26,930
   (`docs/guide/app.md`, the request path).
6. `examples/item-page` mounts its MCP endpoint with `App::api`; its smoke test calls it from a
   page on another origin.
7. Everything `App` renders that does not set `Cache-Control` is sent `private, no-cache`
   (pages, swaps, patches, JSON, errors, refused writes, CORS preflights); before, it had no
   `Cache-Control` and caches could guess a lifetime. Static files and the runtime are unchanged.
8. The CSP allows Corten's own inline tag (the import map) by its SHA-256 hash, so a document
   no longer has a nonce unless the shell calls `doc.nonce()` or a handler takes `Nonce`.
   `Document::nonce` makes the nonce on first call. A shell that writes its own inline script
   still calls `doc.nonce()`; that page is then never shared by a cache.
9. A full document no longer sends `corten-page`; navigations and form answers still do. A
   document that a cache hands to a client navigation by mistake now makes the runtime load the
   URL as a whole page.
10. With `App::messages`, pages vary on `accept-language` too.
11. Measured with callgrind (median of 4-5 runs): a small JSON handler 28,255 instructions a
    request instead of 27,551, a small page 30,912 instead of 31,757 (`docs/guide/app.md`).
    The item page's document is 82 bytes smaller (9,161 instead of 9,243; 2,178 instead of 2,210
    with zstd), measured with `render_cost`; its times on Docker Desktop varied more between runs
    of the same build than between builds.
12. An MCP tool's output is serialized once: `structuredContent` is written from the JSON text and
    the text block is that text as a JSON string, with no `serde_json::Value` in between. Calling
    `items.get` for one item costs 278,273 instructions instead of 2,020,422 (callgrind, median of
    3). A tool may return `Arc<T>` (serde's `rc` feature) to skip a copy.
13. `bench/fullstack`: every app serves the item as JSON at `/api/items/{id}`, measured like the
    page; cold start is timed from the server's exec to its first 200, without Docker's container
    setup; `count.mjs` counts instructions per request with `perf`; `droplet.mjs` runs the whole
    benchmark on a DigitalOcean droplet and destroys it.
14. `bench/fullstack` compares fourteen frameworks: Django, Rails, Laravel, ASP.NET Core, Spring
    Boot, Phoenix, Astro and Nuxt join the six it had, each built the framework's usual way and
    checked to render the same text and JSON (`check-app.mjs`). Warmups are 30 seconds (the JVM
    and .NET need them); `droplet.mjs` records the droplet's CPU model. Apps run with their usual
    settings in one CPU and 1 GiB; one that cannot start or serve the fixed rate is marked failed
    instead of tuned.
15. `bench/live` (new): one price feed pushed to 1,000 and 10,000 clients in the same fourteen
    frameworks, each with its own transport (server-sent events, Corten's feed, Action Cable,
    Phoenix Channels, Reverb). It reports delivery, order, delay, CPU and memory per client, and
    marks an app that refuses clients, loses messages or stops as failed.
    `droplet.mjs --suite live` runs it on a droplet.
16. HTML escaping skips eight bytes at a time while none of them needs escaping, floats render
    without going through the escaping writer (their text never needs it), and a page's header map
    is allocated once with room for the headers `App` adds. The item page took 110,478-110,898
    user instructions a request in process for a navigation instead of 123,515-123,730, and
    138,127-138,687 for the full document instead of 152,150-153,001 (cycles 5-9% fewer), on the
    bench droplet; under load the difference was inside the run-to-run spread.
17. An MCP tool's reply is joined into one string allocated at its final size, instead of two
    `format!` calls that grew theirs while copying a large result.
18. `App`'s middleware is a tower layer of its own instead of axum's `middleware::from_fn`, which
    boxed the rest of the stack again for every request. Measured with callgrind (release build,
    in process, 4,000 requests): a small JSON handler under `App::api` 16,558 instructions a
    request instead of 17,305, a small page 21,190 instead of 21,880.
19. Floats in views (`{price}`, `data-price={price}`) are written from zmij's digits (already in
    axum's tree through serde_json) instead of through `core::fmt`, with the same text as
    `Display`: checked against it for 300 million values, every bit pattern, short decimals and
    short binary fractions. The few values that could sit exactly halfway between two shortest
    forms, where zmij and `Display` round differently, still go through `Display`, as do `f32`
    values. With the middleware change above, the item page took 100,380 instructions a request
    for a navigation instead of 109,373 and 113,949 for the full document instead of 124,617.
    On a bench droplet (Xeon Platinum 8280, app on one core, 64 users, three rounds alternating
    old and new) the item page served 21,053-22,526 requests a second instead of 17,556-20,084
    (user cycles 88,508-96,341 a request instead of 100,013-116,955), and the item's JSON
    24,565-25,804 instead of 23,314-24,867.
20. `examples/item-page` reads the item API's response into structs of only the fields the page
    uses (`ApiItem`) instead of a `serde_json::Value`, so serde skips the rest of the 55 KB
    without building it. Measured with `perf` on a bench droplet (Xeon Platinum 8280, median of
    3 x 5,000 requests): an item page fetched from the item API costs 1,385,381 user instructions
    instead of 4,395,372, the item's JSON 1,398,989 instead of 4,387,294; from memory both are
    unchanged (123,185 and 133,263). On that droplet, two rounds alternating old and new against
    the item API at 64 users, the item page served 3,128-3,176 requests a second instead of
    1,249-1,270 and the item's JSON 3,349-3,372 instead of 1,337-1,359; at 150 a second the page
    used 6.6-6.7% of its core instead of 13.3% (ASP.NET Core there: 1,344-1,373 pages a second,
    25-27%; `bench/fullstack/results/ab-typed-parse`). A response whose list field is not a list
    now fails the request instead of showing an empty list. `count.mjs` takes `api` as a fifth
    argument to count with items from the item API.
21. The runtime's ref cache survives lists: inserting or removing rows no longer makes the next
    handler query the whole component for its other refs (a click after creating 10,000 rows took
    8.8 ms, now 0.8 ms, then 0.1 ms), and markup joining the page is wired with one query for its
    handlers and one for its refs per insert, instead of two per element.
22. The first page loads its handler modules as `<script type="module">` tags (not preloads the
    runtime then `import()`s), and Corten ends each component's module with lines that hand its
    exports to the runtime (a `corten:module` event it takes only from the module the page's own
    script tag for that name loaded, while the page loads; `"corten"` exports nothing for it).
    Handlers are in when the page's scripts run, before `DOMContentLoaded`: on a page of 1,000
    server-rendered rows the time from the parser finishing to the handlers being ready went from
    75 ms to under 10 ms.
23. `bench/browser` compares Corten's views with React 19, Svelte 5, Vue 3.5, Solid and Remix 3,
    client-rendered, server-rendered and hydrated, and on the dashboard; `run-all.mjs` runs a
    round and `summarize.mjs` prints the README's client table. Takeover leaves out the frames
    Chromium paints between parsing and the app being ready (about 100 ms on some loads and none
    on others, for every app), which had made it bimodal. `droplet.mjs --suite browser` runs
    `bench/fullstack`'s browser pass and then `bench/browser` on a droplet. The README's
    Performance section has a browser table and a client-heavy table from that run
    (`browser-1`).
24. Making many rows is cheaper. When many children join one parent at once, the runtime finds
    the ref names in them with one selector query per name instead of reading every `data-ref`;
    `rows().replace` looks up no keys when the list was empty; and a view's `fill` checks a
    boolean attribute before toggling it. On a droplet, creating 10,000 rows took 79 ms instead of
    90 ms (Solid 64, plain JavaScript 61), a row took 101 bytes of heap instead of 116, and
    takeover was unchanged.
25. The README's client-heavy table is from round `browser-3` (Creating 10,000 rows
    68.9 ms, against 87.5 in `browser-1`; Solid 59.2). `bench/browser/ssr.mjs` takes the loads of
    every app in turns and `run-all.mjs` takes 30, after one app's takeover median in a round
    moved with a slow stretch of the machine. The README's server highlight quotes the round
    its server table is from.

26. `corten new` makes the app depend on the `corten` release on crates.io that matches the
    command's version (`corten = { version = "0.1.0", ... }`) instead of the repository's `main`
    branch, so an app builds against the release it was created for. `--corten-path` still uses
    a local checkout. Install the command with `cargo install corten-cli`.
27. `Cargo.lock` takes tokio 1.54.1; 1.54.0 was yanked.
28. `corten::Result` takes a second, defaulted parameter, `Result<T = Response, E = Error>`, so
    `Result<u32, Errors>` works under `use corten::prelude::*` instead of failing with too many
    generic arguments. Existing handlers are unchanged.
29. `FieldName` is in the prelude, next to `Errors`, `Fields` and `Form`.
30. `corten::serve(app)` replaces `App::serve`. It takes anything that becomes a router (`App`
    does), so an app adds its own layers around the whole app,
    `corten::serve(app.router().layer(..))`, without giving up `HOST`, `PORT`, the log
    subscriber and graceful shutdown.
31. Less work per page, with the same bytes out: head tags (`Meta`) and `corten::escape` escape
    through the word-at-a-time `escape_into` straight into the page instead of a character at a
    time through `format!`; a route's text path parameters (`&str`, `String`, `Cow<str>`) are
    percent-encoded from the string, a run of plain bytes at a time, without going through
    `Display`; and each script module's tag is made when the assets load, so a page no longer
    hashes the module's name twice and formats its tag. Measured with callgrind on the item page
    app: 134,682 instructions per item page request before, 120,175 after (-10.8%), and 95,398 on
    the home page (50 item links) before, 85,261 after (-10.6%). The item view's `render_cost` is unchanged within noise (median 20.0 µs before,
    20.2 µs after, 15 runs each).
32. `Json<T>` responses need `T: ToJson` instead of `T: Serialize`: add `#[derive(ToJson)]` next to
    `Serialize` (`serde_json::Value` already is one). A value that cannot be JSON (a map with tuple keys)
    no longer compiles, where it answered 500. Measured on the item page's view model (the
    benchmark's 500 items, 6.6 KB of JSON on average), user-mode instructions per request in process
    (`perf_event`, release build, the lowest of each run's repeated passes): a JSON request 114,157
    before, 58,259 after (-49%); `render_cost` (median of 3) puts the item as JSON at 33.2 µs before and 12.7 µs after,
    and the whole JSON request at 77.4 µs and 32.1 µs.
33. `escape_into` tests a string for characters to escape in one or two reads when it is under
    eight bytes, where it checked each byte (most of a page's strings are short: 188 per item
    page, 11 bytes on average), and integers are written two digits at a time. The item page's
    body went from 56,280 instructions to 51,171 (-9.1%), a document request from 96,918 to
    90,528 (-6.6%) and a navigation from 87,249 to 81,649 (-6.4%), measured as above;
    `render_cost` puts build + render main at 28.9 µs before and 19.8 µs after (median of 3, noisy on
    this machine).
34. A route parameter with nothing to percent-encode (most ids and slugs) is tested with one table
    lookup per byte and no branch, then copied once, where the encoder searched it byte by byte.
    The bytes written are unchanged. Measured in process on the item page (11 route links), user
    instructions (`perf_event`, release build, lowest of 3 runs): the page body 56,275 before and
    55,658 after (-1.1%), a document request 94,815 and 93,953, a navigation 86,966 and 86,362;
    `render_cost` is unchanged within noise (build + render main, median of 3: 14.3 µs before,
    16.0 µs after).
35. The JSON a request reads or answers with goes through Corten's own JSON code where it still
    went through `serde_json`: the `Json` extractor needs `T: FromJson` (derive it next to
    `Deserialize`) and reads an `application/json` body with Corten's reader, leaving any other
    JSON content type, and any body the reader gives up on, to axum, so the value and every
    rejection are axum's; `req.screen`'s data, `Meta::json_ld` and a handler argument of a JSDoc
    type Corten does not check need `ToJson` instead of `Serialize`, with the same bytes out.
    Measured on the benchmark's 500 items (`perf_event`, user-mode instructions, release build,
    lowest of each run's passes, three runs within 0.5%): reading an item API response (55 KB)
    through the extractor 1,616,862 before and 725,531 after (-55%; axum's `Json` tracks the path
    to an error as it reads), `json_ld` of the item's view model 106,164 and 50,265 (-53%), and a
    whole `Accept: application/json` request for a `req.screen` of it 123,664 and 69,200 (-44%).
36. `FromJson` reads with less work per value: skipping a value tests for whitespace with one
    compare where it tested four, a number no longer skips whitespace its caller already skipped,
    and a struct with a container `#[serde(default)]` is read over that default (each field written
    in place) instead of into one `Option` per field that is moved out at the end. The values and
    errors are unchanged. Measured as in item 34 under Added: an item API response 698,733
    instructions before, 684,106 after (-2.1%; -22.1% against serde_json's 878,078), 733,130 and
    718,504 with the conversion into the view model. Found comparing the reader with the pilot it
    came from, on the same types and text: the pilot took 654,700 and the reader 686,650 (4.9%
    more); these three close 14,000 of the 32,000, and the rest is spread thin.

37. Field errors are read within the form's id: `errors.within(PriceId(id))` (a `#[derive(Id)]`,
    the element a refusal replaces) gives `aria(field)` and `message(field)`, and a message's
    id is `{form id}-{field}-error` (`price-s1-price-error`), where it was `{field}-error`. Two
    refused forms with a field of the same name (a price in every row) gave two elements the same
    id, and the second field was described by the first form's message. `Errors::aria` and
    `Errors::message` are gone: write `let e = errors.within(FormId);` and `e.aria(..)`,
    `e.message(..)`. Found by the Chase Sets pilot, whose item page has two forms with a `text`
    field
    ([#45 Field error ids are only the field's name, so two forms on a page share them](https://github.com/todd-skelton/corten/issues/45)).
38. `Feed::snapshot` keeps the body it wrote until the rows or `seq` change (a write that touches
    a row, `apply`, `reset`), so the snapshots between two writes, one for every page that
    calls `subscribe()`, share one serialization instead of cloning and serializing every row
    each time. The bytes are unchanged, and a body written while a write landed is not kept. The
    feed holds one snapshot's JSON in memory for it. Measured with 9-field listing rows
    (`perf_event`, user-mode instructions, release build, lowest of 7 passes, two runs alike): a
    snapshot with no write since the last 444,927 before and 1,272 after at 100 rows (18 KB), and
    4,424,419 and 1,274 at 1,000 rows (187 KB); a snapshot right after a write 458,893 and 461,114
    (+0.5%), 4,433,932 and 4,440,648 (+0.2%); a write alone 9,664 and 9,705.
39. Escaping text for HTML is cheaper: the eight-byte test for a byte to escape is two compares
    instead of four (`"` and `&` fold into `'`, `<` into `>`; a `#` also matches and is then
    written as it is), the loop over text that has one is a function of its own so text with
    none (most of it) skips saving the loop's registers, and that loop uses the same test.
    Measured with callgrind on the item page (release build, the bench fixture, instructions
    per request): escaping 25,036 to 20,218 (-19%), the whole request 111,932 to 107,267
    (-4.2%); the home page, which escapes little, is unchanged (81,291 and 81,548, the
    difference in the allocator). Wall-clock `render_cost` on a busy host could not tell the two
    apart (24.6 and 24.4 µs best of 8).
40. `req.page(title, view)` is `req.page(doc)` and `req.screen(title, &data, view)` is
    `req.screen(&data, doc)`, the title read from the document's `<title>`. Migrate by writing a
    `Layout` component (the old shell, with `<title>{title}</title>` and `<Corten />` in `<head>`
    and `{children}` in `<main>`) and wrapping each page in it.
41. `App::context` needs the context to be `Hash` as well as `Clone`: any layout may show it, so its hash
    is always in the page key.
42. The error page shows the error under `corten dev` only if it prints `failure.detail` (the default
    and the `corten new` page do); the offline page is the error page for 503 ("Not available").
43. Since item 49, `html!` that is one component is that component, its props evaluated where
    the markup is (so `req={&req}` borrows the handler's `req` and a layout stays a document).
    A prop that borrows a local the view's function made (`let title = format!(..); html! {
    <Dialog title={&title} /> }`) is E0515 there, as it compiled before as a closure. Make it
    in the markup instead, `html! { let title = format!(..); <Dialog title={&title} /> }`: the
    `let`s and the component are a view that owns them, and a document when the component is
    one. Found by the Chase Sets pilot, four of whose views broke this way
    ([#77 A view that is one component cannot pass a reference to its own locals (E0515 since the document change)](https://github.com/todd-skelton/corten/issues/77)).
44. `req.patch`, `req.patch_with_status` and `req.invalid` take an `impl Patch` instead of an
    `impl Render`, and debug builds no longer scan a patch for a top-level element without an id
    (a `corten::live` fragment, which is text, is still scanned). Migrate by declaring each
    component a patch sends `-> impl Patch` and writing its ids as `#[derive(Id)]` types.
45. `Failure` is an enum of every way a request can fail (`NotFound`, `WrongMethod`, `CrossSite`,
    `Refused`, `Rejected`, `Failed`, `Panicked`, `TimedOut`, `Offline`), with `status()` and
    `detail()` in place of the fields, so an error page that names each case stops compiling
    when one is added; `corten new` writes one. A handler's 404 is `NotFound` like an unknown
    URL, and the offline page's `status()` is 200. `req.page`, `req.patch`, `req.redirect` and
    the rest return `HtmlResult`; migrate `-> corten::Result` page handlers to `-> HtmlResult`.
46. A cross-site form post from a browser gets the app's error page (`Failure::CrossSite`, 403)
    instead of a bare status line.
47. The security headers reserve room only for the headers they add, so an error page's header
    map is not reallocated, and the route is called without an `async` layer around it: a page
    is about 500 instructions cheaper (24,021 to 23,525), an HTML 404 about 700 (21,849 to
    21,125) and JSON about 270 (19,579 to 19,307), callgrind medians of three runs (the app
    guide's table). The item page's whole `render_cost` (release, under callgrind) is
    34,215,143,042 instructions before and 34,138,183,828 after (-0.22%).
48. `seo::robots`, `seo::sitemap` and `seo::sitemap_index` return `Public<seo::File>`, an answer
    a route can name (`async fn robots() -> Public<seo::File>`), shared for an hour as before.
    `agent::Tools::route` returns `Methods`, for `Api::route`.
49. Reading a `Caller` makes the answer private even when its `Cache-Control` was written by
    hand (by a middleware, or on an `HtmlResponse`), not only when it came from `Public`.
50. **Breaking:** an app answers only requests whose `Host` is `localhost` (or a name under it),
    an IP address, missing, or a name it lists: `Policy::host("shop.example")` (`.shop.example`
    for its subdomains too) or `HOSTS=shop.example` where the deploy sets `HOST` and `PORT`. Any
    other gets `421 Misdirected Request` before routing, with nothing of the app run, so a
    DNS-rebound page cannot use an app on loopback (or a private network) as its own origin;
    `Policy::any_host()` (`HOSTS=*`) answers every name. The first refused name is logged. A
    deployed app behind a domain adds its names; the bench scripts pass their container names
    ([#113 An app on loopback answers any Host, so a DNS-rebound page can read and write its routes](https://github.com/todd-skelton/corten/issues/113)).
51. **Breaking:** `corten::serve` takes an `App`, not anything that becomes a router, so the
    app's tasks cannot be left behind on the way. A tower layer around the whole app is
    `App::layer(l)` instead of `corten::serve(app.router().layer(l))`.
52. A request carries the app's shared state in its `Signal` rather than as an extension of its
    own, so its extensions fit their first allocation: 207 fewer instructions for a page, 647 for
    a signed-in page and 849 for the error page (callgrind, release build, in-process `oneshot`,
    median of three).
53. CI runs the browser smoke tests in Playwright's image for the `@playwright/test` version in
    `package.json`, which has the three browsers and their system libraries. Installing them on
    the runner (`npx playwright install --with-deps`) fetched about a hundred packages from the
    Ubuntu mirror on every run, and stalled until it was cancelled when the mirror slowed to a few
    KB/s (twice on 2026-10-27, 15 and 5 minutes).
54. `bench/fullstack` measures what a request costs: `run-ssr.mjs` reads each phase's CPU time from
    the container's cgroup counter (`cpu-time.mjs`), and `summarize.mjs` adds requests per
    CPU-second, requests a second per MiB and the item API's CPU to `summary.json`. With items in
    memory the load generator also gets the item API's idle cores: in r6 four could not keep
    Corten's core busy (93% for the page, 88% for the JSON).
55. `bench/fullstack/item-api/server.mjs` runs a server process per core it may use (two on a
    bench droplet), each listening with `SO_REUSEPORT`. In r6 its one process used 39-40% of a core
    for Corten's item-API runs and would have capped an app about 2.6x faster
    ([#166 Corten's item-API path spends six times as long fetching and parsing the item as rendering it, and the single-process item API could soon cap it](https://github.com/todd-skelton/corten/issues/166)).
    On Docker Desktop (shared with other work, so rough), pinned to two cores, it served
    4,400-6,600 items a second to 64 users in three runs against 3,600-4,000 in two with one
    process, using about 1.9 cores. Responses are byte for byte the same.
56. `JsonResult<T>`'s error is `JsonError`: `check(&input)?` answers 422 with the fields
    (`{"error":{..,"fields":{..}}}`), and `?` on any other error is answered as before. Before,
    a JSON handler that checked its input and loaded a record could not `?` both, and the
    `Result<Json<T>, Errors>` the docs named did not compile. On a page `?` on `Errors` still
    does not compile (a `compile_fail` doctest): a page's form answers with `req.invalid`.
    Migration: `return Err(Error::status(..))` in a `JsonResult` handler is `Err(Error::status(..))?`
    (or `.into()`); `?` is unchanged.
57. The runtime no longer carries the code that writes numbers, money and dates for a script
    (`t.js().money(USD)` and the rest): it is a module of its own, `corten-format`, served with the
    app's scripts and loaded as a module script by the pages whose handlers take a format.
    `corten.js` went from 24,514 to 22,834 B (9,102 to 8,380 B gzip, -722 B) on every page; a page
    that takes a format loads the 2,074 B module (1,054 B gzip) with its handlers' modules
    ([#159 The item page's JavaScript grew 32% between benchmark rounds r5 and r6 (7.3 to 9.6 KB gzip)](https://github.com/todd-skelton/corten/issues/159)).
58. `corten::json::from_slice` reads the item API's response in 13% fewer instructions: a field
    the type does not declare that holds a string, number, `true`, `false` or `null` (most of
    them) is skipped without the loop that follows nested arrays and objects, and a key is read
    inline. `examples/card-market`'s `ApiItem`, 20 fixture items averaging 69 KB, release build
    under callgrind: 924,942 to 803,111 instructions an item, the same in each run (serde_json
    reading the same type: 1,376,422). Values and errors are unchanged; the reader's tests compare
    every one with serde_json's
    ([#166 Corten's item-API path spends six times as long fetching and parsing the item as rendering it, and the single-process item API could soon cap it](https://github.com/todd-skelton/corten/issues/166)).
59. corten-ui's text props take the text: `label="Actions"`, `close="Dismiss"`,
    `MenuItem { label: "Help", .. }`, `Tab { label: "Offers", .. }` and
    `Toast { message: Some(text) }`, where each was a `&dyn Render` written `&"Actions"` (and an
    optional message cast `as &dyn Render`). `MenuButton`, `MenuItem`, `Tab`, `TabGroup`,
    `Toaster` and `Toast` take any `Render`; a menu's items and a group's tabs share one label
    type. A tab's panel stays a `&dyn Render`, since each panel is a view of its own type.
    ui-gallery's page renders in the same instructions (callgrind, release: 72,700 to 72,511 a
    request, within noise). Migration: drop the `&` from a label; an empty toast is
    `Toast { message: None::<&str> }`; labels of different types in one menu or group (a message
    with arguments beside one without) are each a reference, `[Tab<&dyn Render>; 2]`
    ([#211 A text prop typed &dyn Render needs &"text", and an optional one needs an `as &dyn Render` cast](https://github.com/todd-skelton/corten/issues/211)).
60. examples/watchlist is a module a screen: `home.rs`, `alerts.rs` and `account.rs` beside
    `news.rs`, with `layout.rs` for the document, `socket.rs` for the WebSocket and each screen's tests next to
    it; `app.rs` keeps the routes, the app and the error page, and its route table says which file
    each route is in. No behavior changed: the same 27 tests pass
    ([#229 watchlist's app.rs is 771 lines of app code for seven screens](https://github.com/todd-skelton/corten/issues/229)).
61. A message's arguments are `corten::i18n::Arg`, not any `Display`: text, an integer, or a value
    `t` formats (`t.number`, `t.money`, `t.date`, another message). An integer is written from
    its digits with no `core::fmt` and no escaping, so card-market's item-API home page (50
    `t.home_item(n)` links) went from 64,425 to 58,505 instructions a request (callgrind,
    release, three runs each), winning back most of what message arguments cost there; the en
    and fr home pages and a category page are the same bytes. A float no longer compiles as an
    argument: its text was the same in every locale (`0.9` on a French page), where
    `t.number(decimal)` writes `0,9`. A type of the app's own implements `Arg` with one method
    (`sink.str(..)`). Migration: pass a float through `t.number`, and a `Display` type of the
    app's own as its text or through an `Arg` impl
    ([#237 The item API's home page got 10% slower in the believable-data change; an integer fast path for message arguments may win it back](https://github.com/todd-skelton/corten/issues/237)).
62. A `Public` answer that sets a cookie does not compile: `HtmlResponse<For>` says who an answer
    is for, `ForOne` (the default, what `HtmlResult` holds) or `ForAll` (inside `Public`), and
    `with_cookie` is only on `ForOne`. The `Req` methods that make a page, a patch or a redirect
    take `For` from where the answer goes (the handler's return type, Corten's `get`, or
    `Public::new`, which finds the `Public`'s type from its answer), so handlers and closures are
    written as before. Before, the cookie compiled and the page was sent `private, no-cache`,
    which a CDN never keeps, with a warning only under `corten dev`; a `Set-Cookie` written by
    hand is still caught that way. No code runs differently (`For` is a type alone; card-market's
    public home page: 33,741 to 33,881 instructions a request, callgrind medians of three, where
    main's own runs spread from 33,701 to 33,933).
    Migration: a helper that makes a page for a `Public` handler returns
    `corten::Result<HtmlResponse<For>>` for any `For` instead of `HtmlResult` (`Public::new`
    says the page "is not an answer made for everyone"); one that wraps a page in `Public` takes
    `corten::Result<HtmlResponse<ForAll>>`, as card-market's `shared` does; a closure given to
    axum's own `get` (tests only: an app cannot mount one) names it, `req.page::<ForOne>(..)`;
    `Public<A>` needs `A: Shareable`, which every answer that can be public implements, and an
    answer type of the app's own implements only when it sets no cookie
    ([#235 A Public answer that sets a cookie compiles, and is only made private when it is sent](https://github.com/todd-skelton/corten/issues/235)).
63. A script keeps state with `keep(() => init)` (from `corten`), which replaces `state(el,
    init)`: the object of the component whose script the running handler is in, one per
    instance, so a handler no longer takes the component's root just to find its state. A
    component whose script imports `keep` is always scoped (`data-scope` on its root, with or
    without refs), and such a component's handler on a child's element names its component
    (`data-on="change:form.save($t)/form"`), so it keeps the parent's state wherever the child
    renders it; markup a parent gives a child keeps the parent's handlers' `scope` too. A
    `script!` module, which components share, cannot import `keep` (a compile error).
    seller-desk's grid handlers lose their `scope` argument (six of them), watchlist's `pause`
    too, and corten-ui's menu button and number field keep theirs per component. Take the object
    first, before an `await` or anything that dispatches an event; outside a handler it throws.
    The runtime is 90 bytes larger gzipped (8,503 to 8,593; brotli 7,663 to 7,742);
    card-market's item page renders as before (58,644 to 58,654 instructions, callgrind).
    Migration: `state(scope, () => init)` is `keep(() => init)`, and a `scope` argument used only
    for it is dropped from the handler and its markup
    ([#238 Runtime state is keyed by an element the handler has to pass: state(root, init)](https://github.com/todd-skelton/corten/issues/238)).
64. examples/watchlist keeps the alerts a browser saves and lists them, each with a Remove
    button. They live in a store whose reads catch up with its writes 1.5 s later, as a replica
    would: a write answers with its receipt (`/alerts?saved=7`), and the page or the patched
    status line and list are read again (`ReadAgain`) until reads have it. Before, the address
    carried the time the alert would land and nothing was kept. A browser's watchlist and alerts
    are kept under one id, now in the `visitor` cookie (`visitor.rs`), which was `list`, and both
    forget the browser used longest ago past 10,000 (`recent.rs`)
    ([#220 watchlist's alerts page never shows the alerts you saved](https://github.com/todd-skelton/corten/issues/220)).
65. `corten-cluster`'s `Cluster::snapshot`, `live` and `live_with` return
    `corten::Result<FeedResponse>`, an answer a Corten route names, instead of an axum
    `Response`: an unknown feed is a 404 and Postgres out of reach a 503, both answered as JSON as
    any failure of a feed's route is. The crate depends on `corten` (feature `feed`) instead of
    axum and `corten-feed`. Migration: a handler that returned the `Response` names
    `corten::Result<FeedResponse>`; outside a Corten app, call `.into_response()` on it.
    `examples/listings-feed` is an `App`: the feed in a routes module, the benchmark's
    writes and reads under `App::api` (`/api/feeds/{seller}/market`, `/seq`, `/api/stats`),
    the instance's name from a middleware (`X-Instance`), Corten's health checks (`/health/ready`
    checks Postgres), and the browser probe a page whose `#[component(js)]` follows the feed
    (`/sellers/{seller}`, a 404 for a seller with no feed), where an inline script would be
    refused by the CSP. The failover benchmark ran again on it (`results/failover-r2.json`)
    ([#217 examples/listings-feed does not use App, so its routes skip Corten's compile-time checks](https://github.com/todd-skelton/corten/issues/217),
    [#233 listings-feed's failover benchmark has not been run since the example was renamed](https://github.com/todd-skelton/corten/issues/233)).
66. examples/watchlist keeps the profile picture Ada uploads and shows it on the account page and
    in the header, from `/pictures/{id}`: an id that is a keyed hash of the bytes, served as a
    `Media` every cache keeps. The upload reads the picture's type from its first bytes (PNG,
    JPEG, GIF or WebP), refuses anything else, keeps at most 256 pictures in memory, and needs
    someone signed in. The file input is styled like the page's buttons
    ([#221 watchlist's profile picture upload never shows the picture](https://github.com/todd-skelton/corten/issues/221)).
67. watchlist's WebSocket is `/quotes`, which a ticker outside the browser opens to follow
    stocks: it sends a ticker and is sent the stock's feed row, then again each time it trades.
    It replaces `/echo`, which answered in capitals and which nothing used. A message longer than a
    ticker closes the socket as too big (1009), a client's close is answered, a send the client
    does not take within 10 seconds ends the socket, and shutdown still closes it with a goodbye
    ([#222 watchlist's WebSocket route is an echo, which a stock app would not have](https://github.com/todd-skelton/corten/issues/222)).
68. seller-desk sells card-market's cards: its rows are the three sets' 540 cards, card-market's
    eleven singles first at the cheapest Near Mint price card-market lists them for (a test
    reads its fixture), the rest priced by rarity. Most start in Near Mint and some played; past
    540 rows each card comes again in its next condition at that condition's share of the price.
    A seller keeps a few copies of a dear card and many of a common, and restocks to that.
    Names are cards' names (no `#1`, `#2`), and the sets are card-market's three
    ([#224 seller-desk and card-market give the same card different prices](https://github.com/todd-skelton/corten/issues/224)).
69. card-market shows card art: a generated SVG for each card of its demo catalog in
    `static/cards/`, served at a versioned URL every cache keeps (and the PWA's worker with
    them, cached the first time each loads). The home and category grids show it sized (`width`,
    `height`), past the first row loaded near the screen (`loading="lazy"`), with `alt=""` since
    the link names the card; the item page shows it first, not deferred, with its text. Only the
    built-in demo catalog has art (another source's `item_3` is another card), so the
    benchmark's item page and the item JSON are unchanged. Measured with the demo
    catalog (release build, over HTTP): Ashen Drake's page is 126 bytes larger (42 with brotli)
    plus its 377-byte picture (brotli); the home page is 1,356 bytes larger (105 with brotli) plus
    the pictures that load.
    ([#223 card-market sells trading cards with no card images](https://github.com/todd-skelton/corten/issues/223)).
70. examples/ui-gallery is one screen: a seller's draft listing for a card, with its quantity,
    price and condition, the card's market in tabs, a menu of actions, a saved toast, a rename
    dialog, the last sale, and its SKU with a copy button
    ([#225 corten-ui is used only by ui-gallery, and the gallery's content does not fit together](https://github.com/todd-skelton/corten/issues/225)).
71. examples/card-market's MCP endpoint answers the failures Corten writes itself (a wrong
    method, a cross-site post, the deadline) as JSON-RPC errors (`Api::errors`), the shape its
    tools' own errors have, and a partner's write without a known key is told to send a valid
    one in `X-Api-Key` (`Refused::message`)
    ([#231 Six public APIs appear in no example](https://github.com/todd-skelton/corten/issues/231)).
72. A typed event (`#[event]`) is served with the script that imports it from `corten/events`,
    so an app lists the script's component and never the event; a script that imports an event its
    component's module does not have does not compile. Before, an app that listed `CopyButton`
    without its event would have had the button's script fail to load. A page whose handlers are
    in such a script fetches `events.js` with it (`<link rel="modulepreload">`, 64 bytes)
    rather than after it, one round trip sooner; seller-desk's price cells had waited for it.
    `Script` has an `events` field, written by `#[component(js)]` and `script!`. And
    `on:Copied={..}` listens for the name the event's `#[event]` gave it: a library's carries its
    prefix (`ui-copied`), which `html!` had dropped, so no listener heard a library's event
    ([#294 CopyButton tells the app nothing when it has copied, so a copy that is counted keeps its own copy script](https://github.com/todd-skelton/corten/issues/294)).
73. **Breaking:** static files are compiled into the program. `corten::assets::embed!(pub struct
    Static = "static")` makes a constant per file (`Static::STYLE_CSS`, `Static::ICONS_192_PNG`)
    and `App::assets(Static)` serves them; `req.asset(Static::STYLE_CSS)` is its versioned URL,
    written without an allocation, and a misspelled or removed file does not compile. A name from
    data is `req.find_asset(name)`, an `Option`, replacing `has_asset`. The binary is the whole
    deploy: the Dockerfiles no longer copy `static/`, and an app no longer writes a lookup next to
    `current_exe()`. A file name a URL cannot carry (a space, `#`, `?`, `%`), two files with
    one constant, or a directory that is not there is a compile error; dotfiles are left out. A file
    added with no change to the code is in the program from the next build that compiles the crate
    (the Dockerfiles touch every source first). Under `corten dev` the app reads the directory from
    disk, and `corten dev` restarts it without compiling when only those files were edited or
    added (a removed file builds, and a failed build is tried again at the next change). A
    release binary holds no path from the build machine. The PWA names its files the same way
    (75). Measured on card-market (release,
    callgrind, three runs each): startup 1,470,715-1,485,822 instructions to 1,381,406-1,387,180,
    the item page 81,556-81,740 to 77,294-77,524 per request (`req.asset` no longer looks a string
    up and allocates the URL), and the binary 6,729,592 to 6,752,216 bytes (+22,624, the files)
    ([#268 Static files are a directory found at run time, so a built program cannot be deployed by itself and each app writes its own lookup](https://github.com/todd-skelton/corten/issues/268)).
74. The trait a `#[route(query)]` set implements is `corten::route::QueryParams` (it was
    `route::Params`), so `Params` is the extractor. The examples read their routes' parameters
    as `Params` (16 handlers); ui-gallery's `HomeQuery` and listings-feed's `MarketQuery` are
    gone, the parameters declared once on the route (`MarketWrite` gains `n`), and watchlist's
    `Alerts` no longer derives `Deserialize` ([#207 A handler reads its path parameters with Path<String>, so nothing checks them against the route struct that declares them](https://github.com/todd-skelton/corten/issues/207)).
75. **Breaking:** the PWA names its files by the constants `embed!` makes, so a misspelled or
    removed icon or worker script does not compile (it was a startup panic):
    `Manifest::icon(Static::ICONS_192_PNG, "192x192")`, `maskable_icon` the same, and
    `Pwa::import_script(Static::SW_PUSH_JS)`. An icon another site serves is a `Uri`
    (`Uri::from_static("https://cdn.example.com/192.png")`), its type read from the path without
    the query. The worker script is always a file of the static directory, so it is same-origin by
    its type; a path (`import_script("/abs/sw.js")`) is no longer taken. A file the app's static
    directory does not serve (none given, or another app's) is still a startup panic, now in
    release builds too
    ([#297 The PWA names its icons and worker script by path, so a misspelled file is a startup panic, not a compile error](https://github.com/todd-skelton/corten/issues/297)).
76. examples/listings-feed is a seller's page, not only a load harness: `/sellers/{seller}` draws
    the first 500 listings in a table (`ListingTable`, rows from a `#[component(view)]`, prices
    in the page's money format) from the feed's read, and one `subscribe()` keeps the counts and
    the rows current as changes arrive from any instance. A form posts a market move
    (`POST /sellers/{seller}/market`, the submit key its idempotency key) and patches its result
    in place; without JavaScript it redirects to the page with the write's sequence
    (`?after=`), which asks to be read again until its instance has the write. The `Listing`
    type the script reads is generated (`types/app.d.ts`); the outputs `bench/run.mjs` reads
    keep their names. `examples/listings-feed/smoke.mjs` checks the page in a browser against
    Postgres and NATS, in CI too
    ([#334 listings-feed is a benchmark harness listed as an example](https://github.com/todd-skelton/corten/issues/334)).
77. **Breaking:** `corten_ui::Choice` and `Picker` carry the type the form field reads:
    `Choice<'a, V> { value: V, label }` and `Picker { value: Option<V>, .. }`, the value written as
    the text its `AsRef<str>` gives. With a `#[derive(UrlValue, Deserialize)]` enum
    (`Choice { value: Condition::NearMint, label: "Near Mint" }` for `condition: Condition`) the
    words the combo box offers are the words the handler reads, a selected value of another type
    does not compile, and a form with any other word is refused (422). `#[derive(UrlValue)]` also
    derives `AsRef<str>`, and `RequiredWhen` takes `values` of any `AsRef<str>`
    (`values={&[Pricing::Offers]}`). ui-gallery reads its condition, pricing, regions, tab and
    sale sheet as enums, where it compared strings
    ([#324 corten-ui choices are strings, so nothing ties a Picker or ComboBox value to the field that reads it](https://github.com/todd-skelton/corten/issues/324)).
78. `t.money`, `t.number`, `t.percent` and `t.change` write a value in about 40% fewer
    instructions: 574 for an amount or a rating in `en` where they took 949, 602 in `fr` where
    they took 1,003 (callgrind, release build, 30 amounts in US dollars and 20 two-place ratings
    per round). A page writes into its `String` without a `dyn Write` call per piece, the digits
    are made in `u64` (a `u128` division is a library call), the template is searched as bytes,
    and the currency's code is compared as a number and written only where the locale writes a
    currency by its code. The text is the same; a test checks that no symbol template has a code
    to place.
79. examples/card-market answers a category nothing is in (a slug from an old link) with
    `X-Robots-Tag: noindex` (`Public::header`), so search engines do not list an empty page; a
    category with cards is unchanged
    ([#335 Some framework features appear in no example: Area::policy, Public::header, Req::signal, Refused::too_many](https://github.com/todd-skelton/corten/issues/335)).
80. A feed's row type reaches the script that follows it. `FeedResponse` is `FeedResponse<Row>`
    (`Feed<Level>::snapshot` answers `FeedResponse<Level>`), a feed's route names its rows
    (`#[route("/feed/levels", get = levels, rows = Level)]`, checked against what its `get`
    answers, through the new `Answer::Rows`), and a handler parameter declared
    `@param {FeedUrl<Level>} feed` (from `corten`) takes only a route whose rows are the Rust
    type `Level` in the component's module; a `FeedUrl` it cannot read is a compile error.
    `subscribe()` takes a `FeedUrl<Row>` and its row type from it, so a script's `snapshot` and
    `patch` are typed with no `@param` of their own, a `Stock` handler given a `Level` feed
    fails `tsc`, and a plain string is not a feed's URL. Each mistake has a `compile_fail` doctest
    or an `@ts-expect-error` line. The page's HTML and the runtime's bytes are unchanged
    ([#326 A feed's row type does not reach subscribe(), so a script's row type is whatever its JSDoc says](https://github.com/todd-skelton/corten/issues/326)).
81. `corten fmt` runs `cargo fmt` first, then lays out `html!` across the package, and again
    until neither changes anything, so the one command fixes what `corten check` reports (a
    check that failed on rustfmt was not fixed by it). It stops after four rounds and names the
    files still changing (rustfmt's `hard_tabs` undoes the layout's spaces), runs `cargo fmt` in
    the package it found from a subdirectory, keeps a CRLF file's line endings, prints each warning
    once, and refuses a flag it does not know. `corten fmt --check` checks both, and
    `corten check` runs it in place of its own `cargo fmt --check`. Given paths, or outside a
    package, `corten fmt` still lays out only the markup
    ([#379 corten fmt does not run cargo fmt, so a check that fails on rustfmt is not fixed by it](https://github.com/todd-skelton/corten/issues/379)).
82. corten-ui's `Choice` writes its value as its `Display`, as a route writes a field, in place of
    its `AsRef<str>`, so a row picked by its numeric id is a `Choice<i32>` and the form's field is
    `line: i32` (as for a route's field, `Display` must write what the field's `Deserialize` reads) ([#376 corten-ui choices must be AsRef<str>, so a row picked by its numeric id cannot use the typed picker](https://github.com/todd-skelton/corten/issues/376)).
    A choice also has `terms`, other words that find it without being shown (a card number, a
    SKU, a grade), and `ComboBox` lists the matches ranked: a label or term typed whole, then one
    that starts with the text, then one that holds it, each kind in the options' order. A choice
    is built with `Choice::new(value, label)` and its terms set with
    `Choice { terms: &["NM"], ..Choice::new(..) }`. examples/ui-gallery finds a condition by its
    grade (`mp`) ([#420 corten-ui ComboBox matches only a substring of the label, so a picker cannot search other terms (a card number) or rank the matches](https://github.com/todd-skelton/corten/issues/420)).
83. **Breaking for JSON clients.** Every JSON failure (under `App::api`, a `JsonResult<T>` route, a
    data client) is an RFC 9457 Problem Details document sent as `application/problem+json`, in
    place of Corten's own `{"error":{"status","message"}}` as `application/json`:
    `{"title":"Not Found","status":404,"detail":"No item 7."}`. `title` is the status's reason,
    `detail` the message a client may be told (left out when it would repeat the title, as for
    every 5xx outside `corten dev`), and `type` is left out, which means `about:blank`.
    Validation errors keep `fields` and `form`, now as extension members beside `detail`. A client
    reads `detail` where it read `error.message`, `status` where it read `error.status`, and
    `fields` where it read `error.fields`. `Api::errors` still writes another protocol's shape,
    sent as `application/json`. Gateways, API tools and clients read the failures without
    knowing Corten (`docs/guide/app.md`, `docs/guide/requests-and-forms.md`)
    ([#392 JSON failures use a shape of our own, {"error":{"status","message"}}, instead of RFC 9457 Problem Details (application/problem+json)](https://github.com/todd-skelton/corten/issues/392)).
84. Breaking: `Href` is implemented with `write_link(&self, out, html)` instead of `with_href`, so
    it can be a `dyn Href`; `with_href` is still there to call. An app's own `impl Href` becomes
    `#[derive(Href)]` on its enum, or `write_link`. `corten_ui::Link` is gone: `MenuItem` and
    `Tab` take their link as `&dyn Href`, the one link trait
    ([#391 A component several pages render cannot take a route as a prop (Href is not dyn-compatible), so a shared list's form action and column links are Strings](https://github.com/todd-skelton/corten/issues/391)).
85. corten-ui's `Choice` takes its terms with `.terms(..)`, from a slice of anything that is
    text: constant `&str`s as before, or the `String`s a row computed, borrowed where they are
    (`Choice::new(c.id, &c.label).terms(&c.terms)`), so terms made per row need no second
    `Vec<Vec<&str>>` kept in step with the options. `Choice` and `Picker` take the term type as
    a third parameter, `&str` by default, so `Choice<Condition>` still names the same type.
    `Choice { terms: .., ..Choice::new(..) }` becomes `Choice::new(..).terms(..)`
    ([#448 corten-ui Choice::terms takes &[&str], so terms computed per row (Vec<String>) need a second Vec<Vec<&str>> before the options](https://github.com/todd-skelton/corten/issues/448)).
86. Values 2 is "Standards first, extended rather than replaced", and following a standard where
    one fits is part of correctness in the conflict order: a header, wire format or file format
    of Corten's own where a standard exists needs a Choice in `docs/design.md` saying why
    (design rule 10), and review looks for one without it (`CONTRIBUTING.md`, Review)
    ([#402 The docs do not say Corten extends standards rather than replacing them, and the formats it defines record no reason](https://github.com/todd-skelton/corten/issues/402)).
87. `ReadAgain::from` takes the route by value as well as by reference (a borrowed route is a
    `Route`, and `ReadAgainFrom<'a, R>` is now `ReadAgainFrom<R>`), so a component that is both part
    of the page and the patch builds the read in its body instead of failing with E0515 or E0597
    ([#440 ReadAgain::from borrows its route, so a component that is both part of the page and the patch cannot build the read in its body (E0515, E0597)](https://github.com/todd-skelton/corten/issues/440)).
88. A `data-patch` form's newer submit no longer aborts a pending write (any method but GET): the
    server may have applied it, and its answer, the page's next state, was dropped. A submit made
    while a write is pending waits, and once the runtime has drawn the write's answer and it took
    the write (2xx) or refused only its input (422), it is sent from the form as it is then (the one
    the answer put in its place, found by id), so a version or count the answer wrote goes with it,
    under the form's new key, without its `on:submit` handlers or the browser's constraint checks
    running a second time. Several presses while the write is out send one submit of where the form
    ended; a refusal of the form's state (409, 410), a 5xx, a write that gets no answer, one the
    runtime does not draw (`corten:error`), a redirect, a reload, a navigation, or a form that left
    the page drops it. A GET submit still replaces an older one. The minified runtime grows by 656
    bytes (25,884 to 26,540), 247 gzipped (9,402 to 9,649) and 219 with brotli (8,496 to 8,715)
    ([#381 A data-patch form's submits replace each other, so a screen where every step counts (a count's + and -) writes its own fetch queue](https://github.com/todd-skelton/corten/issues/381)).
89. `FieldName` names where its field is, `FieldName<P = Root>`: a form's own field is still its
    name alone (`FieldName`, with `as_str`), and a group's or a row's field is a
    `FieldName<Group>`, `FieldName<Row<'k>>` or `FieldName<RowGroup<'k>>`, written, not stored:
    compare it with text with `==` (`f.ship_to.street == "ship_to.street"`) and write it with
    `Display` or in markup. `Errors::iter` yields a `Named` for each name.
    `#[derive(Fields)]` also makes `{Name}GroupFields`, `{Name}RowFields<'k>` and
    `{Name}RowGroupFields<'k>` and implements `corten::form::Fields`.
    `#[serde(flatten)]` stays refused, and its message now points to `#[fields(group)]`: a
    flattened group cannot be told from another of its type, and serde reads a flattened field's
    value only as text
    ([#366 A form with the same fields on each row cannot name a row's field or give it its own error](https://github.com/todd-skelton/corten/issues/366)).
90. A key under a field's name sent without the field itself (`go.x` from an image button, `ids[0]`
    from a PHP-style list) is read as that field's group or rows wherever a form is read (`Form`, a
    `GET` form's query, `Upload::fields`, `form::from_bytes`): a field that is not an `Option` is
    refused (422) with a message that says it was sent only that way, where it was ignored and a
    `#[serde(default)] go: bool` read `false` though the button was pressed, or a defaulted `Vec`
    read empty though values were sent. An `Option` reads as `None`, and a key under a name the
    struct does not have is ignored as before
    ([#363 #[derive(Fields)] refuses #[serde(flatten)], so a field group shared by forms (an address) is copied into each form](https://github.com/todd-skelton/corten/issues/363)).
91. Breaking: corten-ui's `MenuButton` takes its items as children, each the app's own element with
    `role="menuitem"` (a link, with `download` or `target` as it needs; a `<form method="post">`
    with the fields it sends around a `<button role="menuitem">`; a `<button command="show-modal">`
    that opens a confirm dialog), and `MenuItem` is gone: it was only a typed link or a field-less
    post, so a row menu with a download, a post with a field or a confirm dialog was built by hand
    without the menu's keys and focus. The script finds the items in the menu as it needs them (an
    item a patch adds counts) and closes the menu on one click listener. `<MenuButton id="m"
    label="Menu" items={&items} />` becomes `<MenuButton id="m" label="Menu">` with an element per
    item
    ([#413 MenuButton items are only a link or a field-less post, so a row menu with a download, a new-tab link, a post with a field or a confirm dialog is hand-built](https://github.com/todd-skelton/corten/issues/413)).
92. Breaking: a call to a handler whose parameter is a set of names written as string literals
    (`@param {"name" | "price"} by`, also with `null`, optional, through a `@typedef`, or as a
    group's field) no longer compiles, and neither does one to a handler whose parameter holds a
    generated declaration inside another type (`import("../types/app").Tab[]`,
    `.. | null`, a typedef of plain values holding one): each took any value at the call. A
    typedef of a plain type (`@typedef {string} Id`, `@typedef {HTMLElement} Root`) a handler
    takes is now checked as that type, where it took any value. Make the set a Rust enum with a
    generated declaration and type the value with it, alone
    ([#362 A handler argument typed by a generated enum union takes any JSON value at the call](https://github.com/todd-skelton/corten/issues/362)).
93. `tokens!` reads the W3C Design Tokens format, 2025.10, instead of a format of Corten's own:
    token files with `$value`, `$type`, groups, `$root`, `$extends`, `{group.token}` references (a
    reference is `var(--group-token)`) and JSON pointers (URI fragments, as RFC 6901 writes them;
    one into a value is the value, an alias it reaches followed to the value), the Color
    module's color spaces as CSS Color 4, and themes as a resolver document's modifiers
    (`tokens!("tokens/tokens.resolver.json")`; a file with `resolutionOrder` is a resolver, whatever
    its name, and each file it names is found from the file that names it), each context applying under `[data-{modifier}="{context}"]`
    (the default with the default values of what the others change) and declaring again the
    tokens that read one it changes, so a theme works on an element inside the page, a light panel
    on a dark page included. Names are written as CSS writes them (`Brand Primary`
    is `--brand-primary`, `BrandPrimary`), and a top-level token is a custom property with no enum.
    Breakpoints, utilities (`"group"` where they said `"scale"`) and the media condition a
    context follows go under `$extensions."run.corten"`. A context that defines a token the defaults
    lack, or retypes one, does not compile (two `compile_fail` doctests); so do a circle of references, contexts of two modifiers whose CSS together differs from the resolver's answer, two names that are one
    CSS name, breakpoints out of order or a breakpoint or utility whose name starts with a digit, a modifier with no default, and a gradient or typography token,
    which have no one CSS value (a stroke style of dashes and caps is `dashed`, the Format module's
    fallback). The JSON reader stays on `proc_macro` alone
    and now reads arrays and numbers. Migration: move `scales` to typed groups (`"#1d1b26"` becomes
    `{"colorSpace": "srgb", "components": [...], "hex": "#1d1b26"}`, `"4px"` becomes
    `{"value": 4, "unit": "px"}`), each `themes` selector to a modifier context in a resolver, and
    `"@media": {cond: selector}` to the modifier's `"media": {context: cond}`; the system-dark
    selector is now `:where(:root):not([data-theme])` (the page chose no theme, with one attribute's
    specificity so a later modifier's rule wins) rather than
    `:root:not([data-theme="light"])`. The examples' generated CSS adds the default context's rule
    (`[data-theme="light"]`, `[data-density="comfortable"]`) and otherwise differs only in that
    selector, a 6-digit hex where one was written with 3, `0px` for a zero length token and no
    space between layered shadows: card-market's tokens 1,946 to 2,171 bytes (473 to 492
    brotli), the watchlist's 14,713 to 14,952 (1,752 to 1,759 brotli)
    ([#394 tokens! reads a token format of our own instead of the W3C Design Tokens format (DTCG 2025.10)](https://github.com/todd-skelton/corten/issues/394)).

94. Breaking: a form's `FieldName` carries the type its control sends, `FieldName<T = Untyped, P = Root>`
    (`condition: Option<Condition>` is a `FieldName<Condition>`, an `Option` and a `Vec` taken off;
    `&'a str` and `Cow<'a, str>` are `String`), so a control given another field's name does not
    compile: corten-ui's `Picker::new` takes only a field that reads its choices' type,
    `Number::new` only a field that reads a number (`Numeric`), `RequiredWhen` only values of its
    control's type (`ValueOf`: the field's own type, or text for a text field or a checkbox; now
    any `Display`, so a number field's values are numbers), and `SubmitKey::field` and
    `SubmitKey::again` only a `SubmitKey` field. `name={..}`, `Errors` and `Within` take a name
    of any type as before, and a name is still the size of a `&str`, so nothing renders
    differently: the item page's render ran 35,591,033,717 instructions against 35,611,790,177 on
    its base (median of 3, callgrind, release build), within the typed build's own range of 22.5
    million, so no difference. To migrate:
    1. An app's own helper typed `FieldName` (now `FieldName<Untyped>`) takes a type parameter,
       `fn hint<T>(f: FieldName<T>)`, or the type when it draws one kind of control
       (`fn whole_number(f: FieldName<String>)`; the errors point at the calls, the fix is the
       helper's signature), and one typed `FieldName<Group>` for a group's names is now
       `FieldName<T, Group>`: the place moved to the second parameter.
    2. Names of fields of different types are different types: a list of them, or a comparison of
       two, takes `.untyped()` (`[f.email.untyped(), f.price.untyped()]`).
    3. A typed control takes no field whose type it cannot see through: one using its struct's
       generics or a lifetime other than borrowed text, a `Box`, a type alias or a path through
       `$crate` is `Untyped` or its own type, so a `Picker` or `NumberField` on it is written by
       hand or the field's type spelled out
    ([#358 A form's FieldName carries no type, so a Picker<Condition> can name another field](https://github.com/todd-skelton/corten/issues/358)).
95. `bench/fullstack`: `droplet.mjs` turns off the droplet's automatic package updates before
    provisioning, so a reboot comes back on the kernel `perf` was installed for, and `count.mjs`
    writes the running kernel to `count-kernel.txt`, has `perf` count an idle second before any
    load (stopping with the reason when it cannot), and logs when `perf` attaches and when the
    load starts. CI's and CONTRIBUTING's publish dry run builds in a target of its own
    ([#466 Benchmark round r8 has no instruction counts: its droplet locked up twice when count.mjs started counting](https://github.com/todd-skelton/corten/issues/466)).
96. A view lent to a call written in markup (`{keep_query(&at, &html! { .. })}`, a whole argument)
    borrows what it uses, as one lent to a prop does since item 70, so the rest of the page reads
    the same local; it was a `move` closure and a second read was E0382. A view given by value, or
    in a closure of its own (`.map(|g| f(html! { .. }))`), still owns what it uses, and so does one
    in a macro's arguments (`format!(..)`). A callee that needs the view `'static` or `Send` takes
    it by value; a lent view that changes a captured `mut` local now changes the page's one (it
    changed a copy). `{&html! { .. }}` alone is lent too. `keep_query`'s docs and the guide now
    lend the controls, and say to clear the fields a form resets on the route it is given. The item
    page's render runs 0.07% more instructions (median of 3, callgrind, release build:
    35,618,729,963 against 35,592,439,055 on its base), which has no lent call: noise between
    builds of the same markup.
    ([#485 A view lent to a call inside markup ({keep_query(&r, &html! { .. })}) still takes ownership of the locals it uses, so a local also read elsewhere fails with E0382](https://github.com/todd-skelton/corten/issues/485)).
97. `corten new` writes the app as a library, `src/lib.rs` (the routes, handlers, `pub fn app()` and
    its tests), and a `src/main.rs` that only serves `my_app::app()`, so a test target in `tests/`,
    an example and a second binary reach the app's code; in a binary-only app none could. Modules
    are declared in `lib.rs` alone (one declared in both files is a second copy of its components,
    which fails to build), which the template's comments, README and AGENTS.md say. A name the app
    could not be reached by (a keyword, `std`, `test`, a dependency such as `tokio`) is refused. An app made before keeps working; the app guide
    says how to move it
    ([#508 corten new makes a bin-only app: tests/, examples/ and a second bin cannot reach its code, so #506's advice cannot be followed](https://github.com/todd-skelton/corten/issues/508)).
98. Component scripts (`#[component(js)]`, `script!`, `corten-ui`'s) are served without their
    comments: the macro removes them when the crate compiles and keeps every line where it was, so
    DevTools and stack traces still show the author's line numbers, and it still reads the JSDoc
    to check the calls. A licence comment (`/*! .. */`, `//! ..`, `@license`, `@preserve`) stays, as
    does one the browser reads (`//# sourceMappingURL=`). Every line ending stays as it was written
    (`\r\n`, `\r`, `\n`, U+2028, U+2029), a comment's own included. Checked against esbuild: the
    repo's 62 JS files, each with LF and with CRLF endings, minify to the same code with and
    without their comments, and keep their line count. A script with a `/` after a
    statement-level `}`, after `++`/`--`, or starting a line after a value, where only a parser
    could tell a division from a regular expression, is served as written (none of the repo's
    scripts has one; 161 of 1,230 third-party files with comments, mostly minified, would be).
    Measured on the 24 scripts it strips (corten-ui's, the examples' and the template's), brotli
    11 as Corten stores them: 30,779 to 15,855 bytes (-48.5%); gzip 9 36,371 to 18,651 (-48.7%).
    The item page (`bench/fullstack/bytes.mjs`, card-market images of main and this change): its
    two component scripts 1,690 to 874 bytes, every script it loads 29,336 to 28,520 raw and 11,101
    to 10,697 gzipped. Nothing a request does changes: the stripped text is what `include_str!`
    held before
    ([#513 Explore removing comments from component scripts as they are served, if it cuts bytes shipped enough to matter](https://github.com/todd-skelton/corten/issues/513)).
99. `t.money` and `t.number` write a value in about two thirds of the instructions: a currency
    looks up its fraction digits once, when it is made (at compile time for a `const` one), not for
    each amount; digits are made two per division; and a one-byte separator or symbol is pushed as
    a character, an empty piece of a template skipped. What they write is the same, byte for byte,
    in every locale and every currency its data has (compared on 68 MB of values before and after).
    Measured with callgrind (release, the difference between 1,200 and 200 values over 1,000, one run):
    `t.money` in en 754 to 500 instructions a value, `t.number` 406 to 247; card-market's item
    page from memory, which writes a price for each listing and offer (in-process `oneshot`, the
    difference between 1,200 and 200 requests over 1,000, three runs each, against main at
    756ee0ea), 105,190 to 105,336 instructions a request on main and 93,529 to 94,016 here
    (-11%), its JSON route unchanged at about 57,300. The page had grown from about 78,900 when it
    began writing prices in the reader's locale (ce04961b), which is what benchmark round r7 to r8
    saw. `Currency`'s `Debug` is now its code (`Currency("USD")`, was its bytes)
    ([#260 The item page from memory fell 19.9% between benchmark rounds r6 and r7 (23,416 to 18,758/s) while the unchanged apps fell 1.2% and its instructions held](https://github.com/todd-skelton/corten/issues/260)).
100. An `App::api` in an area that sets a deadline, with none of its own, takes the area's, as the
    area's pages do; before, it took the app's
    ([#539 An API cannot sit inside another API's prefix, so a feature cannot own its JSON routes under a shared /api the way it owns its pages in an area](https://github.com/todd-skelton/corten/issues/539)).
101. A parameter or catch-all route outside an `App::api` (a page's `/{slug}`, a relay's
    `/api/{*rest}`) no longer answers a path under the API's prefix; the API's JSON 404 does, as the
    API's docs said. A relay of the old server's paths under an API's prefix moves into the API's
    module (`#[route("/api/v2/{*rest}", any = relay)]`), where it meets the API's settings
    ([#539 An API cannot sit inside another API's prefix, so a feature cannot own its JSON routes under a shared /api the way it owns its pages in an area](https://github.com/todd-skelton/corten/issues/539)).
102. A currency's symbol and fraction digits are found in the locale tables by a number, the
    code's three bytes, which `Currency` already holds; `scripts/locale-data.mjs` writes it beside
    each code. Before, `t.money`, `t.signed_money` and `Currency::parse` turned the table's code
    text into that number on each probe of the binary search, and `t.parse_money` and a script's
    money format compared text. What they write is the same: the generator still checks 1,902,560
    values against Intl, and the i18n tests pass. Measured with callgrind (release, three rounds
    each): card-market's item page from memory (in-process `oneshot`, the difference between 1,200
    and 200 requests over 1,000) is 90,101 instructions a request here (89,166 to 90,101) against
    92,366 on main at 3b197114 (91,439 to 92,414), 2.5% fewer; `t.money` alone, written with
    `write!` into a reused `String` (so `std::fmt` is counted, unlike entry 98), is 780
    instructions a value in `en` USD against 852, `fr` USD 848 against 931, `en` EUR 811 against
    881 and `fr` JPY 951 against 1,036. Most of the page's rise in the issue is card-market writing
    more prices, which stays
    ([#545 The item page's user-mode instructions rose 14.8% between benchmark rounds r7 and r10 (95,949 to 110,172) while its CPU time per page fell](https://github.com/todd-skelton/corten/issues/545)).
103. The kit's `Alert` takes its role from its variant, so a screen reader interrupts only for what
    needs the user now: `role="alert"` for `Warning` and `Destructive`, `role="status"` for
    `Success`, and none for `Neutral` and `Info`, which were all `role="alert"`. A copy made
    before keeps its role until `corten ui add --force alert`
    ([#552 Kit Badge and Alert have no success, warning or info tone, and every Alert is announced as role=alert](https://github.com/todd-skelton/corten/issues/552)).
104. `corten ui init` in an app with a `tokens!` theme of its own keeps it: it writes `src/ui.rs`
    without the kit's tokens and names the tokens the components read, which the app declares, most
    as references to its own, saying when a group of the theme has one of their names (`radius`, whose `$root` declares it). A
    theme it cannot read is reported and nothing is written; `corten ui init --kit-theme` writes the
    kit's theme beside the app's instead. It finds the crate's one `App::new(..)` in any file (`src/app.rs`),
    declares `pub mod ui;` in the crate root (`src/lib.rs`, else `src/main.rs`) and leaves a page
    stylesheet that sets `color-scheme` as it is, saying what to add; `corten ui add` lists
    `corten_ui::COMPONENTS` beside the kit's list wherever it is, and not again when a file has it
    ([#551 corten ui init on an app that already has tokens adds a second theme instead of mapping onto the app's](https://github.com/todd-skelton/corten/issues/551)).
105. The kit's Button, Input, Textarea, Select, Slider, Badge, Card, CardHeader, CardContent,
    CardFooter, Dialog, DialogFooter, Sheet, Popover and Accordion are looks:
    `<button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>` where it was `<Button ..><button>..</button></Button>`, and
    `<section class={Card {}}>` (or an `<article>`, an `<li>`, a form, a patch target) where
    `Card` drew a `<div>`, and `<dialog class={Dialog {}}>` where `Dialog` wrapped the
    `<dialog>`. Alert, Switch, Checkbox and Field still draw their element, for a
    role or a label. A copy made before is replaced with `corten ui add --force <name>`, and its
    uses change as shown
    ([#563 Kit Card and Alert render their own div, so a card cannot be the page's section, article or list item](https://github.com/todd-skelton/corten/issues/563),
    [#565 Kit Card draws its own div, so a card cannot be a patch target, a labelled section or a form without a wrapper](https://github.com/todd-skelton/corten/issues/565)).
106. The kit's Badge takes a tone (`Neutral`, `Primary`, `Info`, `Success`, `Warning`,
    `Destructive`) and an emphasis (`Solid`, `Soft`, `Outline`), `class={Badge { tone, emphasis }}`,
    in place of one variant per look; a soft badge is a 12% tint of its tone, and every pair
    keeps at least 4.5:1 contrast on the page and on a card in both themes, which a test checks
    ([#569 Kit Badge has one look per tone, so an app cannot tell a filled status from an outlined one as MUI Chip does](https://github.com/todd-skelton/corten/issues/569)).
107. The kit's Field takes the control's `#[derive(Id)]` id, `id={QtyId}`, and writes its label's
    `for` from it, so a misspelled name does not compile (the app still writes the id on the control
    too, so the two can still name different types), and a `hint` and an `error` shown together;
    `e.aria(f.qty).hint(&FieldHintId(&QtyId))` on the control names the hint before the error
    (`aria-describedby={FieldHintId(&QtyId)}` on a control the server never marks)
    ([#554 Kit Field: the control id is written twice, unchecked, and a field cannot show a hint and its error together](https://github.com/todd-skelton/corten/issues/554)).
108. corten-ui's `PrintButton` and `CopyButton` take a `class`, the button's look
    (`class={Button { .. }}` from the kit, `class={()}` for none), so a kit app styles them as its
    other buttons.
109. The error page's `Caller` is the one its failed request found: a handler refused (or failed)
    after reading who is asking no longer has the session looked up again for the error page.
    The lookup is kept on the request's `Signal`, which the error page shares, rather than in
    the request's extensions, which the handler took. A middleware's own extensions still do not
    reach the error page (keeping them would copy every request's)
    ([#582 The error page's extractors get none of the failed request's extensions, so a caller the handler found is looked up again and middleware state is gone](https://github.com/todd-skelton/corten/issues/582)).
110. `t.money` finds a currency's symbol by indexing, not by a search: a currency takes its place
    among every currency some locale has a symbol for when it is made (at compile time for a
    `const` one), and each locale's data maps that place to its row (`slots`, written by
    `scripts/locale-data.mjs`), so writing an amount no longer searches the locale's table. What it
    writes is unchanged: the generator's 1,902,560 values in 108 locales still match Intl, and a
    test checks every currency's row in every locale. Measured with callgrind on card-market's item
    page from memory (in-process `oneshot`, the difference between 1,200 and 200 requests over
    1,000, release, three runs each, against main at 4b0b5d71): 92,530 (92,131 to 92,532)
    instructions a request on main and 90,373 (89,992 to 90,724) here, -2.3%, of the -3.2% a
    lookup that cost nothing would give (the same count with the lookup replaced by a constant
    row: 89,568). `render_cost` (release, native Windows, five alternated runs each, on a loaded
    machine) shows no time difference: rendering 24.0 us (22.7 to 31.9) on main and 24.4 (22.0 to
    41.3) here, a full request 45.2 in both, the runs varying more than the builds; the page's bytes
    are the same. A currency parsed at run time (`Currency::parse` on a code from a database)
    does the one search, of the 108 (at most 7 comparisons), when it is parsed, in place of one an
    amount; a `const` one does it when the app compiles. An app carries the list of 108
    currencies (432 bytes) and 124 bytes a locale it lists (its `slots` and their slice), and a
    `Currency` is 5 bytes, not 4. The slots only mean
    something with the list `corten` has, so `messages!` checks its list is that one when the app
    compiles: a `corten` and a `corten-macros` from different releases fail the build rather than
    write another currency's symbol. The rest of the growth from benchmark round r7 to r10 is the
    example writing each price in the reader's locale
    ([#545 The item page's user-mode instructions rose 14.8% between benchmark rounds r7 and r10 (95,949 to 110,172) while its CPU time per page fell](https://github.com/todd-skelton/corten/issues/545)).
111. Every debug build checks that a page gets the stylesheet and script of each component it
    renders, as `corten dev` did alone: a router test that renders the page and `cargo run` now
    fail with the same 500 (the message is logged, and shown under `corten dev`), so a page
    that renders another area's component is no longer served unstyled and silent until someone
    opens it under `corten dev`. Release builds still record nothing, so nothing changes there,
    `corten dev` or not. Outside `corten dev` the message also goes to stderr, so a failing test
    shows it. A test that renders a component must list it on the test's `App`; a page tested
    on a plain axum `Router`, with no `App` to list them, can render no styled component
    ([#619 A page that renders another area's component is served unstyled and silent outside corten dev; nothing renders every page under the check, and an area lists what its components render by hand](https://github.com/todd-skelton/corten/issues/619)).
112. The page a `data-patch` write redirects to is fetched whole (`Mode::Document`, as a full load
    reads it) and the runtime draws again each element around `<main>` the server now draws
    otherwise, so a layout value the write changed (a cart count, a warning) is current with
    JavaScript as it is without; before, the navigation kept the layout the full load drew. An
    element the server draws the same stays the same element, with what scripts added to it. When
    the frame around `<main>` changed (an attribute of `<main>` or of an element around it, or the
    layout's own head tags) or the elements around it are not the same tags, the page loads in
    full instead; what an extension added to the frame before the runtime started (Dark Reader's
    attributes on `<html>`) does not count, since the first write's page need only have no part
    the load lacked, and a part the load had and that page lacks (a theme turned off) stays until a
    full load, since a theme a script set before first paint looks the same. Every other navigation
    still swaps `<main>` alone, except one the user starts
    before the write's page has come, which reads the whole page too. A page read again
    (`ReadAgain`) after a write's page stays as it is while nothing changed. A whole document now
    carries its notice in `corten-notice` too, so the runtime announces one the page did not draw.
    A live region in the layout (a toaster's `role="status"`) stays, with the new message put in it,
    so a screen reader announces it as it does a patch's; around it, what the server draws as
    before (with the patches since: a layout element keeps a copy of what the server drew, which
    each patch into it is applied to, up to about twice what the element holds) stays as a script
    left it, and the
    rest is updated in place, so the toaster's close button stays the one its script holds, and a
    `<details>` or `<dialog>` the user opened or closed there stays so (a modal one stays modal).
    Measured: the runtime is 1,713 bytes larger gzipped (10,091 to 11,804; brotli 9,119 to 10,718;
    27,882 to 33,095 minified), which every first load pays once (it is cached after); a full load
    after each such write instead (the issue's first option) costs nothing there but takes each
    write from about 53 ms to about 88 ms below, and marking the layout parts a write may change
    (its second) leaves a part nobody marked stale, which is the bug; keeping the layout to compare (its markup as loaded; it is
    normalized only when a write compares it) costs each full load a median under 0.1 ms and at
    most 0.4 ms on the watchlist's and the gallery's pages (Chromium, 50 captures a page, 495 and
    327 bytes kept),
    and 1 ms (1.2 ms at most) on a 61.5 KB layout; a patch into a layout element (a ticker in the
    header) costs 16 to 20 us more, the copy's update (Chromium, 400 patches, 7 alternating
    rounds; three runs: medians 103.0, 103.3 and 101.8 us against 83.3, 86.8 and 81.5, ranges 94.3
    to 128.3 against 78.0 to 94.0 apart from one main round of 176.7), and the watchlist's briefing write, which redirects to `/news`,
    now reads 1,919 bytes gzipped where the swap read 1,410 (brotli 1,786 against 1,328; 4,871
    against 3,566 uncompressed), once per write, and the server draws the layout for it as for a
    full load. From the submit to the drawn page (headless Chromium on localhost, 20 rounds of each,
    interleaved, while other builds ran): 53 ms (median, 37 to 128) where the old `<main>` swap
    took 46.5 ms (37 to 67), and both well under the full load a browser makes without the runtime,
    88.5 ms (62 to 120) and 67.5 ms (54 to 106) in the same runs; the full loads, the same code in
    both, moved as much between runs as the swaps differ, so the swap's cost is within this
    machine's noise
    ([#538 A data-patch write that redirects leaves the layout as the full load drew it, so a layout value the write changed stays stale with JavaScript and is right without it](https://github.com/todd-skelton/corten/issues/538)).
113. `class={..}` writes its list in place: each class with a space after it, the last space
    dropped, where it removed the first, which moved every byte of the list. The kit's looks are
    a class list on every element they style, so a long list of them paid it on every row. A
    `ClassList` an app writes by hand now writes the space after each class, as corten's do; one
    written the old way runs its first class into the class before it. Measured with callgrind on
    seller-desk's `render_cost` (522,600 rows rendered, release), against the same rows without
    the looks: the kit's field and button on each price cell cost 211 instructions a row before
    (+5.4% of the page) and 172 after. The same 71 bytes written as one literal class string cost
    12, so the cost is joining the classes, not their bytes, and shorter scoped names would save
    about 8 more. The issue's "a quarter more render time" (810 to 870 us against 632 to 684) came
    from runs not alternated on a loaded machine; alternated, the difference is about 5%.
    Seller-desk's price cells wear the kit's `Input` and `Button` again, narrowed by a `Price`
    class of the cell's own, rather than a copy of their rules that a theme change would not
    reach: 176 instructions a row over the cell without the looks (the 172 and 4 for `Price`,
    +4.5%), and a 500-row page of 730 us against 696 without them (medians of seven alternated
    native runs, 673 to 939 and 654 to 810). The desk's markup grows 89 bytes a row, 44,500 on the
    500-row page, which the example serves uncompressed; 362 bytes with brotli at level 2, as
    `compress` would send it, and 506 with gzip
    ([#612 A kit look's scoped classes cost 71 bytes and about a quarter more render time a row on a 500-row list, so a long list writes the look in its own CSS](https://github.com/todd-skelton/corten/issues/612)).
114. `bench/fullstack`: the thirteen other apps render card-market's item, home and 404 pages with
    its markup and its stylesheets (`sync-styles.mjs` copies them), each in its framework's usual
    way, instead of the same text in markup and styles of their own. `parity.mjs` also compares
    each page's outline of elements and classes (`outline.mjs`), and the new `look.mjs` compares
    each element's box and computed styles in Chromium, at desktop and phone sizes in light and
    dark; a round runs both. From r12 the other apps' bytes, browser and server numbers are not
    like for like with r11's
    ([#642 The benchmark's other apps render Corten's item page text but not its markup or styles, which changed in nine commits since Oct 22](https://github.com/todd-skelton/corten/issues/642),
    [#643 parity.mjs compares only visible text, so a benchmark app's markup and styles can drift from Corten's unnoticed](https://github.com/todd-skelton/corten/issues/643)).
115. corten-ui's `MenuButton`, `TabGroup`, `Number` (`NumberField`) and `Picker` (`ComboBox`)
    take their id as a `#[derive(Id)]` type, as `ChoiceGroup` and `CopyButton` do, where they
    took text: a menu per row keeps its keyed id (`ShipmentMenuId(&s.reference)`) with its escaping,
    and a label's `for` writes the id the control has. Text does not compile. Breaking: `id="m"`
    becomes `id={MenuId}`; `Number<'a>` is `Number<'a, I>`, `Picker<'a, V, S>` is
    `Picker<'a, I, V, S>`, and their `new` takes the id
    ([#656 corten-ui's MenuButton, TabGroup, NumberField and ComboBox take their id as text, not an Id, so a row-keyed widget loses its typed id to format!](https://github.com/todd-skelton/corten/issues/656)).
116. The kit's controls share one width rule. In a `Field` the control fills the field's row:
    `Select` and corten-ui's `ComboBox` now do, as `Input` and `Textarea` did (in the gallery at
    360 and 1280px wide, the "Ship from" select went from 113px to its field's 276 and 291px, and
    the condition combobox from 180px to 273 and 460px); a `Stepper` keeps its width. Breaking:
    outside a `Field`, `Input` no longer fills its container but takes the browser's natural
    width, so a search box sits beside its button. `ControlWidth { width: Width::Sm | Md | Lg |
    Full }` (`corten ui add control_width`) sets an input's, select's or textarea's width from the
    theme's new `--control-width-sm`, `-md` and `-lg` tokens (8, 16 and 24rem, never wider than
    the container), which a field's row also keeps; a widget's own parts (a `ComboBox`, which fills
    its container, or in a row takes 12rem) are out of its reach. Copies made from the old `input.css` and `field.css`
    keep the old widths until `corten ui add input field --merge`
    ([#659 Kit Input fills its field but Select takes its options' width, so a form's selects are short under full-width inputs, and an Input in a toolbar row pushes its button to the next line](https://github.com/todd-skelton/corten/issues/659)).
117. The kit's `SortHeader` takes `on:sort`, the click handler of its link: a page that sorts its
    rows in place passes its typed call naming the column (`on:sort={js::sortBy(event, target, rows,
    By::Total)}`), where its script had to parse the link's query or count cells from one handler on
    the table; the link still sorts the page without the script. A header the server sorts writes
    `on:sort={None::<Handler>}`, and a copy updated with `corten ui add --merge table` does not
    compile until each header has one, which the compiler names
    ([#635 Kit SortHeader takes no handler for its link, so a page that sorts in place by a typed column parses the link's query or counts cells, or keeps its own header](https://github.com/todd-skelton/corten/issues/635)).

118. The kit's `Dialog` takes a size, `Dialog { size: DialogSize::Md }` (`Sm`, `Md`, `Lg`, `Xl`:
    24, 32, 48 and 64rem), where every dialog was 32rem and a list, picture or table in one
    overrode `max-width` by stylesheet order. A side `Sheet`'s width goes with its side,
    `Side::Right(SheetWidth::Md)` (`Sm` to `Xl`: 20, 24, 32 and 40rem, at most 85% of the
    window), so a top or bottom sheet has none to give. `DialogHeader` and `SheetHeader` are
    looks on the app's `<div>` (a `<header>` there is the page's banner landmark), its first
    element: the heading, then the controls the app writes at its end (a `command="close"`
    button, or a link for a dialog the address opens). A dialog or
    sheet longer than the window scrolls with its header held at the top, and a control that takes
    focus scrolls in below the header, not under it. Measured on the kit files before their class
    names get the component prefix, with comments out, whitespace collapsed and the spaces around
    `{};:,>` dropped: `dialog.css` 832 to 1,370 bytes (gzip 467 to 633, brotli 401 to 524),
    `sheet.css` 1,313 to 1,868 (gzip 500 to 682, brotli 415 to 574); the served stylesheet adds
    the prefix to each class. Breaking: `Dialog {}`
    and `Side::Right` and `Side::Left` alone do not compile until each use names its size, which the
    compiler names; `corten ui add dialog sheet --merge` updates a copy
    ([#646 Kit Dialog has one width and no header with a close control, so every list, picture or review dialog overrides max-width by stylesheet order and draws its own close row](https://github.com/todd-skelton/corten/issues/646)).
119. Kit `Steps`: `StepState::Blocked(words)` draws a step that cannot start until something before
    it is fixed with `!` in the warning color in place of its number, so a sighted user tells it
    from one not started (and under forced colors, by the glyph), with its words read after its
    name as `Done` and `Todo` do; and `Step { description: Option<&str>, .. }` writes a muted line
    under the step's name, outside its link so the link keeps the step's name, read and not shown
    under 40rem. **Breaking:** for each `Step` an app writes (add `description: None`) and for a
    `match` on `StepState`; `corten ui add steps --merge` takes the new copy. The page writes a
    `<small>` for each description and nothing more for a step without one. Measured: `steps.css`
    grows from 2,697 to 3,571 bytes (gzip 1,035 to 1,327, brotli 852 to 1,091), paid by a page
    that draws `Steps`
    ([#675 Kit Steps has no blocked state and no visible description, so checkout's 'Review is blocked' step and every step list with a line under its name stay hand-drawn](https://github.com/todd-skelton/corten/issues/675)).
120. Kit `Steps` takes `layout`: `StepsLayout::Row`, the wrapping row it was, or
    `StepsLayout::Timeline`, one step per row down the page with a line between the marks and each
    step's description beside its mark at every width, for what happened to something (a payout's
    times and references), where the row hid descriptions under 40rem. A timeline goes nowhere, so
    it is an `<ol>` named by `label` and not a `<nav>`; its mark sits on the name's first line
    and the line down starts at the mark's foot with a theme's larger control font too, and a
    reference with no place to break wraps rather than widening a phone's page. And
    `StepState::Failed(words)` draws a step that ran and went wrong with a cross in the
    destructive color in place of its number, told from a blocked one (`!`, warning) without
    color, with its words read after its name. **Breaking:** each `Steps` writes `layout`
    (`layout={StepsLayout::Row}` for what it drew), and a `match` on `StepState` gains an arm;
    `corten ui add steps --merge` takes the new copy. Measured with comments out, whitespace
    collapsed and the spaces around `{};:,>` dropped: `steps.css` grows from 2,413 to 3,458
    bytes (gzip 858 to 1,096, brotli 693 to 902), paid by every page of an app that copies `steps`
    ([#687 Kit Steps has only a wrapping row and hides descriptions under 40rem, so a status timeline whose descriptions are data (a payout's times and references) stays hand-drawn](https://github.com/todd-skelton/corten/issues/687),
    [#688 Kit Steps has no failed state, so a step that ran and went wrong (a refused payout) is drawn as blocked or stays hand-drawn](https://github.com/todd-skelton/corten/issues/688)).

121. **Breaking:** `ToolError` has a new variant (below). The MCP endpoint can say where clients get a token, as the MCP authorization spec asks of a
    server that checks tokens: `Tools::authorization(Authorization::new::<Mcp>(origin, issuer))`.
    Corten serves its protected-resource metadata (RFC 9728) at the endpoint's well-known path
    (`/.well-known/oauth-protected-resource/mcp` for `/mcp`; public, cached an hour, readable
    from any site, its preflight answered), and every 401 names it, with the scopes from
    `Authorization::scopes`: `Bearer resource_metadata="..", scope=".."`. Its `resource` is the
    origin with the route's path, which `Authorization::resource` gives the token check to
    compare a token's audience with; a route with a parameter or a trailing slash does not
    compile, the endpoint mounted at another route is a startup panic (under `App::api` or in
    an area, where the metadata is served outside the area), and the origin and issuers must be
    `https` (or `http` on a loopback address). With one, `Tools::auth` runs once on every request
    to the endpoint (`initialize`, `tools/list`), not only on a tool call, and any failure of it
    answers before the method does: a 401 or 403 with the challenge, 400 with
    `error="invalid_request"` for `Invalid`, 403 for `Forbidden`, 503 for `Upstream`, 500 for
    `Internal`. Changed for every endpoint: a 401 for a request that sent
    a bearer token adds `error="invalid_token"` (RFC 6750), and `ToolError` has a new variant,
    `InsufficientScope("a b")`, answered 403 with `error="insufficient_scope"` and the scopes,
    so a `match` on `ToolError` names it. Measured with callgrind, instructions per request over
    1,000 (release build, two runs each, before from `7be57075`, with a token check that does no
    work): a page's document 22,291 to 22,641 before, 22,676 to 22,690 after (22,388 with an
    `Authorization`); a tool call 38,367 to 40,615, then 38,073 to 38,131 (35,985 to 35,990 with
    one); a refused call 44,820 to 44,865, then 42,755 to 42,785 (39,820 to 39,898 with one)
    ([#694 The MCP endpoint's 401 names no protected-resource metadata (RFC 9728), so an MCP client cannot find where to get a token](https://github.com/todd-skelton/corten/issues/694)).
122. A page the runtime swaps in (a navigation, a write's page, a `data-patch` form answered with a
    whole page) fetches what its handler modules import (a module of the script directory,
    `corten/keys`, `corten/views`, `corten/events`) with those modules, as a full load does, not
    one round trip after each arrives: the answer carries their `<link rel="modulepreload">` tags,
    which the runtime moves to the head (once per URL) before it imports the modules. A page whose
    modules import nothing carries nothing more. A patch carries none: it redraws markup whose
    modules the page usually has already, and a ticker's patches would repeat the tags each time
    (a page that reads itself again does carry them in each answer). A full load now preloads
    `corten/views` only when a handler module (or one it imports, or a static file in `scripts/`
    it imports directly) imports it, the rule a swap follows, where before any page with a handler
    module fetched it.
    Measured, seller-desk from the statement to the inventory grid with 300 ms added to each script
    request, release builds, 15 navigations per engine, click to swap, median (range): Chromium 827
    (808 to 1,366) to 527 ms (493 to 879), Firefox 945 (900 to 1,673) to 595 ms (548 to 830),
    WebKit 1,172 (1,084 to 1,272) to 823 ms (758 to 924); that swap's answer grows by 127 B (about
    60 B gzip). The runtime grows by 282 B, 62 B gzip at level 9 (33,620 to 33,902 B; 12,030 to
    12,092). Instructions per request with callgrind (release build, 3 runs, 1,200 less 200
    requests, parent `e3d205e1`), median (range): a navigation to a page whose module imports
    another 24,395 (24,390 to 24,584) before, 25,209 (24,981 to 25,412) after (+3.3%); to a page
    whose module imports nothing 24,409 (24,401 to 24,608), then 24,741 (24,573 to 24,803)
    (+1.4%); a full load 25,793 (25,754 to 25,908), then 25,750 (25,735 to 25,906)
    ([#735 A page the runtime swaps in fetches a handler module's imports only after the module arrives, one round trip later than a full load](https://github.com/todd-skelton/corten/issues/735)).
123. **Breaking:** `Style` gains the public fields `media` and `breakpoints`, so a `Style` built
    by hand names them, and a kit component taken again needs the theme's `sm` breakpoint (below).
    A component's stylesheet names a breakpoint of the token file as a Media Queries 5 custom
    media query, `@media (--md)` from `md` up and `@media not (--md)` below it, and the app writes
    the token file's width in when it starts (`@media not (min-width:48rem)`), so a component and
    the `md:` utilities switch at one width. A name no token file can make (`(--Phone)`), a name
    not alone in its parentheses and `@custom-media` do not compile. A name no token file in
    `App::components` makes stops the app, naming the stylesheet, and so does one that two token
    files give different widths (the kit's theme beside an app's), only when a component names
    it. The kit's `NavBar`, `Stats`, `Steps` and `Table` lay themselves out for a phone below the
    theme's `sm` (40rem in the kit's theme, which now makes it) where they wrote
    `max-width: 40rem`: at exactly 40rem they now draw the wide layout. An app's own theme makes
    `sm` on its root group; `corten ui init` and `corten ui add` say when it is missing or made
    at two widths. A copied kit file takes the change with `corten ui add <name> --merge`.
    Measured, ui-gallery's `components.css` grows by 12 B (52,685 to 52,697), three bytes for
    each of the four rules, and is otherwise byte for byte the same
    ([#747 A component's stylesheet cannot name a token breakpoint, so the kit and the app write 40rem in seven @media rules that do not follow the token file](https://github.com/todd-skelton/corten/issues/747)).
124. **Breaking:** kit `Icon`'s `Glyph` is made with `Glyph::new(svg)`, or `Glyph::filled(svg)`
    for a glyph drawn filled in the text's color (a rated star, a saved heart), in any module of
    the app, so an app's own glyphs live in its own file and the copied `icon.rs` stays as the kit
    wrote it, taking the kit's updates without `--merge`. A `Glyph` still takes only a
    `&'static str`. Whether a glyph fills is part of the glyph, not a prop of `Icon`, so a design's
    empty star is never drawn filled at one call site. A copy taken again with
    `corten ui add icon --merge` keeps compiling only once each glyph the app added there is
    written `Glyph::new(..)` in place of `Glyph(..)` (moving them to a module of the app's own
    is the point). `icon.css` gains one rule, `.icon__filled{fill:currentColor}` as served (32 B);
    a glyph in lines draws as before
    ([#753 Kit Icon draws every glyph as lines only, so a design system's filled glyphs (a rating's star, a saved heart) read as their outline state](https://github.com/todd-skelton/corten/issues/753),
    [#754 Kit Icon: an app's own glyphs can only be written inside the copied icon.rs, so the copy is always 'edited here' and every kit update to it needs --merge](https://github.com/todd-skelton/corten/issues/754)).
125. **Breaking:** a breakpoint in a token file may name another of its group in braces
    (`"wide": "{md}"`), with that one's width for a component's `@media`; it makes no utility
    classes and no `Responsive` method, and one that names no breakpoint with a width in the same
    group (or in another set of the same resolver) does not compile. The kit's phone layouts
    (`NavBar`, `Stats`, `Steps`, `Table`) switch at `wide`, which the kit's theme makes at 40rem in
    place of `sm`, so a theme with Tailwind's names points `wide` at its `md` and the copied files
    stay as the kit wrote them. Breaking for an app that takes one of these components again
    (`corten ui add table --merge`), whether its theme is its own or the kit's from an earlier
    `init`: the theme makes `wide`, as `"wide": "{sm}"` where it already makes `sm` at 40rem (two
    breakpoints never share a width); until then the app does not start, naming the stylesheet,
    and `corten ui add` prints that line. The kit's theme no longer makes `sm`: an app that runs
    `init` from now on and names `(--sm)` in its own stylesheets adds `sm` to a token file of its
    own (an earlier `init`'s copy keeps it). The served CSS is unchanged; the gallery's
    `components.css` is the same bytes
    ([#767 Kit phone layouts switch only at a breakpoint named sm, so a theme with Tailwind's names (sm 40rem, md 48rem) renames md or edits each copied kit file](https://github.com/todd-skelton/corten/issues/767)).

126. An integer in markup (`{count}` in `html!`) or in a message's arguments is written digit
    by digit instead of being checked as UTF-8 first, which its digits always are. The item page
    writes 85 in markup; a request for it runs 3.6% fewer instructions (callgrind in process,
    release build, 1,200 requests minus 200, `item_1`, two runs each on main `557920cb`: 109,366
    and 109,790 to 105,665 and 105,688; its JSON route, which this does not touch, read 69,382 and
    70,037), what it writes unchanged
    ([#781 Corten's item page from memory serves 25% fewer pages than axum + Maud in benchmark round r13 (18,157 against 24,209/s) while its JSON is 26% faster](https://github.com/todd-skelton/corten/issues/781)).
127. When a component names a breakpoint no token file makes, the app's startup error lists the
    breakpoints it does make with their widths and shows the brace form (`"wide": "{md}"`), so an
    app moving to a kit that switches at `wide` sees the one line it needs. Reported by the Chase
    Sets pilot, whose pin move needed `"wide": "{sm}"` to start
    ([#767 Kit phone layouts switch only at a breakpoint named sm, so a theme with Tailwind's names (sm 40rem, md 48rem) renames md or edits each copied kit file](https://github.com/todd-skelton/corten/issues/767)).
128. The kit's `Alert` takes an `emphasis` beside its `variant`, as `Badge` does:
    `AlertEmphasis::Soft` (a tint of the tone, mixed 12% into the card, behind text in the tone,
    as MUI's standard alert is a tint), `Outline` (nearly the look it had: its paragraph's color is
    now mixed in sRGB, a shade off) and `Solid` (filled with the tone). Its tones are the badge's,
    and its text meets WCAG AA in both themes in each, which the kit's test checks; a paragraph
    takes the alert's color, not an app's `p` element rule. Breaking for a copy brought up to date: every
    `<Alert>` writes `emphasis={AlertEmphasis::Outline}` to keep its look, and an app whose alerts
    share one emphasis gives it once in a component of its own (the guide shows one). `corten ui
    add alert --merge` takes it; a copy whose tone rules were edited (a soft look of the app's
    own), or that has a rule of its own added at its end, conflicts there: the kit's change runs
    to the file's last line, so the app's rule is on the "this copy" side to keep
    ([#832 Kit Alert has one look per tone (tone-colored text on the card) and no soft surface like MUI's standard Alert or Badge's Soft emphasis, so a port edits its copied alert.css](https://github.com/todd-skelton/corten/issues/832)).

129. corten-ui's `Number` takes the field's `Bounds` (`Number::new(id, f.qty, QTY, ..)`) in place
    of its own `min`, `max` and `step`, and its `value` is the field's type, not an `f64`;
    bounds of another type than the field's do not compile. A field now has both ends, which its
    handler checks: an open-ended count names its largest, and `step="any"` is gone (a decimal
    names its step). corten-ui's `Numeric` is `corten::form::Numeric` ([#802 A number field's range is typed three times (server check, message, input min/max) and nothing ties them, so they drift; every form hand-writes its own parse-in-range closure](https://github.com/todd-skelton/corten/issues/802)).
131. A benchmark round keeps its summaries and log as files and its raw output in one archive,
    `results/<round>/raw.tar.xz`: `droplet.mjs` packs a finished full-stack round after its download
    (`bench/fullstack/pack.mjs`, which removes a file only once the archive lists it), and
    `summarize.mjs` reads a packed round from it. r14's raw output was 1,156 files and 1.64 MB
    (337 KB in this clone's Git pack); as an archive it is one 175 KB file (measured). The rounds
    already committed keep their summaries and a `raw.txt` naming the commit that has the rest
    (61d14058) and the command that brings it back, and `summarize.mjs` refuses one until it is
    back; the history is not rewritten. A checkout has 142 files of results (5.7 MB) instead of
    11,150 (22.1 MB)
    ([#819 Daily benchmark commits retain raw results and grow Git clone size](https://github.com/todd-skelton/corten/issues/819)).

130. A request's head may be 32 KiB, not hyper's 400 KiB read buffer: a client that sends large
    heads and never finishes them held that much per connection until the header timeout, and
    4,000 took card-market to 913 MiB of its 1 GiB. Now 200 connections sending 300 KiB heads are
    each answered 431 and closed, with memory going from 1.0 to 1.3 MiB, and 4,000 holding heads
    just under 32 KiB take 222 MiB more (measured, card-market at `--cpus 1 --memory 1g`). 32 KiB
    matches nginx's limit and Kestrel's for headers. A keep-alive request over TCP runs the same
    instructions (33,170 before and 33,172 after, callgrind, release, the least of 13 runs each
    of 1,200 requests minus 200). An app whose requests carry more raises it
    with `App::max_request_head` (Added 225,
    [#822 A request head may be about 400 KiB and an app cannot lower it, so 4,000 connections holding unfinished heads took card-market to 913 MiB of its 1 GiB within the header timeout](https://github.com/todd-skelton/corten/issues/822)).

132. A write that finds a connection's send buffer full now waits at most 60 seconds for room,
    then the connection closes (`App::send_timeout`, Added 227): before, nothing bounded it, so a
    client that stopped reading held its connection, and a live stream, feed or WebSocket to it,
    as long as it liked. A WebSocket route sees its write fail with `TimedOut`
    ([#823 A client that stops reading its answers holds its connection as long as it likes: the header timeout and the deadline end before the answer is written, and nothing bounds the send](https://github.com/todd-skelton/corten/issues/823)).
133. corten-ui's `Number::new` takes the name of an `Entry` field (`qty: Entry<u32>`), not a typed
    one (`qty: u32`), and `Number::value` is an `Entry` (`1.into()` for a new form's number,
    `input.qty.clone()` after a refusal), where it was an `Option<T>`: a number the user types
    that does not read is the field's message, not the error page (Added 229)
    ([#846 A form's typed number field that does not read is the error page, not the form with a message and what was typed, and the kit's Number accepts only a typed field](https://github.com/todd-skelton/corten/issues/846)).
140. A benchmark round takes its feature matrix from its own images: `run-all.mjs` runs
    `conform.mjs` as a step between the instruction counts and the browser step, writing
    `results/<round>/conformance.json` after each app, with the commit `droplet.mjs` built the
    images from (about 55 minutes for nineteen apps, estimated from 2.8 an app locally). The
    matrix (format 2) adds a read that fails (`conform-items.mjs`, the item API conform reads,
    answers 500 for one item: any 5xx, HTML on the page, JSON or problem+json on the JSON) and the
    lines each JSON request writes to stdout and stderr (shown, not counted), and counts the 64
    KiB header when it is refused (a 4xx or a closed connection). Measured locally: Corten 500 html
    and 500 problem+json and no line a request, Phoenix 500 html and 500 json and 2 lines. Older
    rounds keep their cells
    ([#806 bench/fullstack checks that every app sends the same output but not that it does the same work, so a table can compare apps doing different jobs](https://github.com/todd-skelton/corten/issues/806)).
141. A message with two or more arguments takes them by name, in a struct of the catalog's module
    (`Msg`'s is `msg`): `t.item_image(msg::ItemImage { title, n })`, where it took them by position
    in the order the default locale first used them. Two values of one type cannot trade places
    without a compile error, and rewording the default text so its arguments move changes no call.
    A field left out or named wrong does not compile. A message with one argument, and a plural
    with only its count, keep the parameter; a plural with more takes `count` as a field. The
    structs are in a module `messages!` adds beside the catalog, so an item of that name there
    clashes with it. These now fail the build where they compiled: two keys whose structs share a
    name (`itemImage` and `item_image`, both with two or more arguments), a key that names no
    struct (`_1`, `self_`), and a catalog named `Crate` or `Super` with such a message
    ([#860 A catalog message with two or more arguments takes them by position, so a swapped pair or a reworded default message compiles and draws the wrong sentence](https://github.com/todd-skelton/corten/issues/860)).
142. The repository moved to the `corten-run` organization: every crate's `repository` is
    `https://github.com/corten-run/corten` (and with it `corten-cli`'s binstall download URL), and
    the template's README and AGENTS.md, SECURITY.md's advisory link, CONTRIBUTING.md's trusted
    publisher (with a step to re-point crates published before the move), the README, the guides
    and design notes, the benchmark README and `corten-ui`'s doc link name it. The crates have no
    `homepage` until `https://corten.run` serves the landing page (it repeated `repository`, which
    Cargo advises against). The published 0.1.0 crates keep the old URLs until the next version
    ([#836 After the move to corten-run, the crates, docs, template and automations still name todd-skelton/corten](https://github.com/corten-run/corten/issues/836)).
143. A bench/fullstack round can run each load phase three or five times (`droplet.mjs --passes 3`,
    `BENCH_PASSES`; one pass unless set), the apps taking turns between passes, and records the
    count (`passes.json`), which a relaunch with `--from` keeps. `summarize.mjs` reads every
    pass asked for: each number is the passes' median with its range, an app that did not start or
    could not hold the fixed rate in any pass failed (said with that pass's numbers), and a phase
    some passes have no files for says how many it has. It marks an app within noise of Corten
    when their ranges overlap, and its tables now lead with the cost at a steady rate (requests per
    CPU-second at the fixed rate and at 64 users, and CPU at the fixed rate from the counted time,
    `cpuUsedPct`), peak throughput after. A one-pass round reads as before: r14's `summary.json`
    is the same but for the added `cpuUsedPct`. The unit's hours grow with each pass
    ([#811 Benchmark rounds are one run per phase, so differences under about 10% are noise, and the headline is peak throughput rather than cost at a steady rate](https://github.com/todd-skelton/corten/issues/811)).
144. The kit's `SortHeader` takes the page sorted by its column each way, `ascending` and
    `descending`, and the way a first click sorts, `first` (`Sort::Descending` for a column read
    newest first), in place of the one `link`: it links to the one a click gives (the other way
    when the table is sorted by it, else `first`) and writes both on the link, so
    `corten_ui::rows::sort` can put the order it shows in the address and follow `first`
    (`data-first`). Breaking for a copy brought up to date: each `link={&next}` becomes
    `ascending={&up} descending={&down} first={Sort::Ascending}` (or `Descending`), and the app's
    code that chose the next order goes; a column with one meaningful order names its route for
    both. It writes the two only with a click handler, so a table the server sorts draws what
    it did. `Bind::present`, which says whether a handler prop is
    there, is documented for that ([#865 A page that reads itself again (ReadAgain) undoes a rows::sort: the runtime swaps in the server's order every few seconds, since the in-place order is not in the address](https://github.com/corten-run/corten/issues/865)).

145. The Dockerfile `corten new` writes (and card-market's, watchlist's and auction-room's) links
    zstd, which `compress` uses, to the build image's libzstd (`ZSTD_SYS_USE_PKG_CONFIG=1`) instead
    of compiling zstd's C sources, the slowest crate on a clean build's critical path. A clean
    release build of a new app took 149 and 119 s instead of 216 and 183 s (two alternated rounds in
    rust:1-bookworm on four CPUs; 317 and 365 CPU seconds instead of 546 and 445), and its binary is
    544 KB smaller; Debian's zstd 1.5.4 compressed three item pages of about 11 KB to the same bytes
    as the vendored 1.5.7, at the same speed within the runs' spread (75 to 119 µs a page against 81
    to 106, medians 107 and 97 µs; measured). The server then needs `libzstd.so.1` where it runs:
    the runtime image, debian:bookworm-slim, has it, and an app that moves to an image without it
    (distroless, scratch) removes the line (the server would not start). A build outside these
    Dockerfiles compiles zstd as before, unless the variable is set where pkg-config finds libzstd.
    zstd stays the first coding, for its CPU time (measured on three item pages of about 11 KB):
    zstd 1 made 2,394 to 2,476 bytes in 69 to 127 µs a page, brotli 2 made 1 to 3% fewer in 398 to
    645 µs, gzip 2,836 to 2,920 in 383 to 463 µs, and a pure-Rust zstd encoder (ruzstd) 3,154 to
    3,298 in 741 to 793 µs
    ([#772 Every new Corten app compiles zstd's C sources (compress is in the template), the slowest dependency and on the critical path of a clean release build](https://github.com/corten-run/corten/issues/772)).
146. corten-ui's `Toast` takes `failed`: an action that did not do what was asked ("Not
    published: the last copy of the card sold while you were editing.") is refused with
    `Toast { message, failed: true }`, marked `data-failed` as the `Toaster`'s own `failed` text
    is, so the kit's `Toasts` draws it as a failure, and it stays until closed, the next submit
    or another page, not `seconds` (with no message it says nothing). It is for an action with no
    form to draw again (a button) and goes with the refusal that says why (`Refusal::Conflict` for
    a state that moved on, `Gone`, `Upstream` for a service that failed):
    `req.invalid(&errors, Toast { message: errors.form(), failed: true }, page)`, so the answer has
    the refusal's status (a data client gets the Problem Details document) and its text, and the
    page an answer without JavaScript draws says it too when its layout takes the answer's `Toast`
    (as ui-gallery's does), since the server draws the mark. The toaster's script now
    keeps any marked message, its own or the server's, where it kept only the ones it put in.
    Breaking: every `Toast { message }` adds `failed: false`; the compiler names each one (the
    kit's `toasts.rs` changes only in its doc example and `toasts.css` only in a comment, so
    `corten ui add --merge toasts` takes them). ui-gallery's Publish answers with one, checked in
    its smoke with and without JavaScript, and a success after it is a notice again. The toaster's
    script as the gallery serves it is 67 bytes smaller (3,555 to 3,488 bytes; 1,290 to 1,273
    gzipped at zlib level 9; measured), since the mark replaces the set of failures it kept
    ([#936 An action that reports its own failure answers with a plain Toast, drawn like a success, and has no way to take the Toaster's failed look](https://github.com/corten-run/corten/issues/936)).
147. The watchlist image no longer runs the workspace's tests in release while it builds: CI's
    browser job compiled every test target in release and ran them before the first smoke
    (13.4 of the image build's 14.7 minutes, in a 19.9-minute watchlist step on main's run
    42131011180), and the job grew to 23 to 30 minutes against its 30-minute limit. They run in
    CI's `rust` job instead, beside the browser job, and in CONTRIBUTING.md's first check after the
    debug tests. With the release build in the `rust` job's cache (run 42148523587), the browser
    job took 14.2 minutes (watchlist step 6.0) and the `rust` job 15.0 (from 6.5; its release
    tests 8.8), so CI takes about 15 minutes where it took 23 to 30
    ([#947 CI's browser job now takes 23 to 30 minutes against its 30-minute limit, so ordinary variance cancels it](https://github.com/corten-run/corten/issues/947)).
148. `corten new` writes `lto = "thin"` under `[profile.release]`: measured on card-market, about
    1.7% fewer instructions per page than Cargo's default, for a slower release build. The
    deployment guide's new [release profile](docs/guide/deploy.md#the-release-profile) section
    compares it with the workspace's profile (one codegen unit) and Cargo's default: build times,
    binary size and cost per request, and says to move it to the root of a workspace
    ([#773 The release profile (thin LTO, codegen-units = 1) makes card-market's own crate the last 151 s of a clean build and all of a 112 s rebuild, and no run has measured what it buys](https://github.com/corten-run/corten/issues/773)).
149. card-market's item page sends its first five offers, not every offer with the rest in a
    `<template>`: "Show all" is a GET form (`?offers=all`) that works without JavaScript, the
    page with every offer, and with it (`data-patch`) gets only the other offers
    (`view::Append`). The benchmark's other apps write "Show all" as the same form, and
    `bench/fullstack/parity.mjs` fails an app whose first response carries a different number of
    table rows, a `<template>`'s included
    ([#942 Benchmark: the item page's apps return the same visible page but do different work (Corten formats prices per request and renders every offer)](https://github.com/corten-run/corten/issues/942)).
150. The kit's `Pagination` tied its `link` closure's borrow to the links' lifetime, so a closure named
    before the markup that borrows the page's data and returns a boxed link did not compile
    (`page_link` does not live long enough). `link` is now any closure that gives a link, so a typed
    route needs no box (`link={|page| url::Orders { page: Some(page) }}`, one allocation fewer per
    page link; estimated, the markup is the same) and a named closure is passed by value
    (`link={page_link}`). Breaking for an app that takes the new `pagination.rs`: the form the kit
    showed, `link={&|page| Box::new(route)}`, gives a box of the route, which is not a link, so it
    becomes `link={|page| route}`; a closure that gives a `Box<dyn Href>` still compiles, and a
    type that names the component writes its closure and link types (`Pagination<'a, F, L>`)
    ([#862 The kit's Pagination ties its link closure's borrow to the links' lifetime, so a named closure that returns a borrowed link does not compile](https://github.com/corten-run/corten/issues/862)).
151. The item page costs about 4% fewer instructions per request, with the same bytes. Callgrind,
    card-market's `item_1` from the benchmark fixture, 3,200 less 200 requests through the router,
    three alternating runs of each build, median (range): a document request 106,348 (106,176 to
    106,636) to 102,160 (102,082 to 102,248), a client navigation 103,962 (103,723 to 104,192)
    to 99,995 (99,759 to 100,355), rendering alone 68,884 (68,875 to 68,886) to 66,708 (66,699
    to 66,709), and the item's JSON route 70,185 (70,070 to 70,187) to 68,626 (68,607 to
    69,225). A page and a JSON document write integers below 100 without the digit buffer
    (`json::to_vec` of the item 47,825 (47,821 to 47,835) to 46,679 (46,672 to 46,681)). The
    shell key (its meta tag and its header), a layout read's mark, the notice cookie's page and
    an asset's ETag are written by one hex helper (`ascii::hex`), where three copied the same
    loop and the rest used the formatter (`Assets::serve` 4,983 to 3,505 instructions a request,
    one run of 1,200 requests each). The head-tag scan finds `<` and `>` a word at a time, and
    the error page's copy of the request keeps the five things it puts back rather than building
    a `Req` on every page request. Compression, the CSP report endpoint, a data request's
    `Accept` and the test client read a media type out of a header with one function
    (`api::media_type`)
    ([#918 Benchmark: investigate the item-page versus JSON throughput gap](https://github.com/corten-run/corten/issues/918)).
152. A page compressed per request for a client that accepts brotli but not zstd uses brotli 1, not
    2: on card-market's item page (callgrind, in process) the request takes 806,872 user
    instructions instead of 1,336,000, for 2,358 bytes instead of 2,142 (gzip 1 sends 2,506, zstd
    1 2,178). brotli 0 (with its window sized to the body) costs more than 1 and sends more, and a
    window sized to the body changed nothing at level 1. A held `json::Raw` compressed on every
    read for a brotli client takes 634 µs on a 79 KB document instead of 1,754 µs, for 7,284 bytes
    instead of 6,939 (a Linux container on a desktop with other builds running, five runs with the
    levels alternating, the median of their medians; brotli 1 took 29% to 36% of brotli 2's time
    in each run, and callgrind counts 3.14 million instructions against 12.7 million). The guide's
    numbers for that document are all remeasured on it; entry 106's were taken on another 80 KB
    document
    ([#985 Per-request brotli costs about 1.2 million instructions on the item page, 5x zstd 1, with a 4 MiB window for an 8.8 KB body](https://github.com/corten-run/corten/issues/985)).
153. The framework's package is `corten-run`, and its library is still `corten`: `corten` on crates.io
    is an empty 2022 placeholder of someone else's, so the main crate could not be published. Code
    is unchanged (`use corten::...`, and the paths `corten-macros` generates), and so is the
    dependency key; an app's line names the package: `corten = { package = "corten-run", version =
    ".." }`, or with `git` or `path` as before. `corten new` writes it, the examples use it, and
    `corten`'s commands still read an app pinned to a revision from before the rename (its lock
    names the package `corten`). Breaking for an app on a git pin that moves past the rename: add
    `package = "corten-run"` to its `corten` line. `corten ui add` reads a line keyed by the
    package too (`corten-run = ..`, as `cargo add corten-run` writes, which the code still calls
    `corten`) and adds `corten-ui` beside it. `cargo test -p corten-run` and `cargo doc -p
    corten-run` name the package
    ([#835 The main crate cannot be published: corten on crates.io is an empty 2022 placeholder, so choose its package name (corten-run) or wait for crates.io](https://github.com/corten-run/corten/issues/835)).
154. card-market's item page renders in about 14% fewer instructions, and a document request
    costs about 8% fewer, with the same bytes: a number or an amount of money that `html!` or a
    message writes is written piece by piece when it is short (the template's text, at most
    three digits, the decimal separator and at most two fraction digits), with no digit buffer
    or template loop. Short means under 1,000, a locale with ASCII digits, and for money a
    currency the locale writes with a symbol; signed money, percentages, changes and everything
    else go through the general writer as before, and `to_string` is unchanged. A test checks
    that both write the same text in every locale, and Intl's cases check the rendered text too.
    The cost: an amount the short path does not take now costs about 5% more, for the checks
    that choose the path. Callgrind, release build at `eea6adba`, three alternating runs of each
    build, median (range). card-market's `item_1` from the benchmark fixture, 3,200 less 200
    uncompressed requests through the router: rendering 51,560 (51,549 to 51,746) to 44,541
    (44,525 to 44,547), a document request 86,859 (86,724 to 86,900) to 79,696 (79,524 to
    80,035), a client navigation 85,328 (85,242 to 85,349) to 78,168 (78,051 to 78,243), and the
    item's JSON route, which formats nothing, 68,789 (68,637 to 68,876) and 68,611 (68,608 to
    68,811), within the runs' spread. Per amount, a loop rendering a set of amounts 3,200 times
    less one rendering it 200 times: `item_1`'s 51 en prices 386 to 227 instructions (writing
    `$` and the digits by hand is 140), and 24 amounts the short path does not take (money of
    $1,000 or more in en, fr with CHF, bn's digits, KWD's three digits, signed money and a
    percentage) 644 to 678
    ([#918 Benchmark: investigate the item-page versus JSON throughput gap](https://github.com/corten-run/corten/issues/918)).
155. The Dockerfile `corten new` writes, and card-market's, preload jemalloc
    (`libjemalloc2`, `LD_PRELOAD=libjemalloc.so.2`), so memory a burst of connections took is
    given back: after eight floods of unfinished request heads glibc's allocator kept 419 MiB and
    jemalloc 45 MiB (one run each). The item page takes about 4.5% fewer instructions per request
    under callgrind with it, CPU time per request under load was within the rounds' spread with
    and without compression, and memory at rest after load was 16.4 to 18.2 MiB against 17.5 to
    29.5 uncompressed, and 17.9 to 24.7 against 18.8 to 24.0 with zstd; the image grows 1.8 MB.
    An existing app adds the two lines from the app guide; removing them runs on glibc's allocator
    ([#886 The template's image runs glibc's allocator, which keeps what a flood of unfinished heads freed; preloading jemalloc gives it back, unmeasured for throughput](https://github.com/corten-run/corten/issues/886)).
156. A handler a route names that takes an argument no request can fill fails in Corten's words
    at the handler's name in `#[route(..)]` (`.. cannot serve this route`), and a second error
    names the argument (`Name: FromRequestParts<()>` is not satisfied); before, it was axum's
    unmet `Handler<_, ()>` with a hint to use `#[axum::debug_handler]`, and named no argument.
    Corten and corten-feed turn on only the axum features Corten uses (`http1`, `tokio`,
    `matched-path`, and `json` with Corten's `json`), so a request no longer carries a copy of its
    URI for `OriginalUri`, which nothing read: on card-market's item page from memory (callgrind,
    release build, three runs each, on fa597483 before entry 154's money change), the functions
    that copy, insert and drop it ran 339 instructions a request after against 492 before, about 0.2% of the 83,400; the whole request's
    count does not resolve that (83,479 after against 83,433 before, with runs differing by up to
    450). `log`, `ryu` and `serde_urlencoded` leave the tree. Breaking for an app that names
    `corten::axum::extract::Query`, `corten::axum::Form` or `OriginalUri` through Corten's
    re-export: a Corten route reads its query with its `Params` and a form with `corten::Form`; a
    stand-in server in a test (an axum `Router`, app guide) reads `RawQuery`, or the app adds
    `axum` with `query` or `form` as a dev-dependency. A `Public` handler can no longer take
    axum's `Query` (it is no longer marked `Anonymous`), for the same reason. Design Choice 25
    records why routing, calling a handler and server-sent events stay axum's
    ([#761 Corten wraps most of axum but still depends on its router, handler traits and SSE, which tie its public API and diagnostics to axum's](https://github.com/corten-run/corten/issues/761)).
157. `FromJson` reads with fewer instructions: a string is scanned sixteen bytes a step where it
    was eight (two words tested together), and a `{`, `[`, `"` or `:` is tested before skipping the
    whitespace in front of it. The values and errors are unchanged. Measured with callgrind on the
    benchmark's 500 item API responses (compact JSON; release build; `read_cost` in
    `examples/card-market`, new; on `d1303fb7`): a response 591,637 instructions before and
    531,100 after (-10.2%; serde_json 877,533). A count is exact for a build: two runs before and
    three after gave the same totals. Decoding an escaped key in the reader, which
    [#763 Corten's form, route and JSON readers still require serde's Deserialize beside their own derives, and FromJson allocates every string it reads from an upstream body](https://github.com/corten-run/corten/issues/763)
    proposed, was measured as a pair of trial builds that differed only in that decoding (a
    key returned as a `Cow`, one run each, before the final layout of this change): 540,305
    with it against 527,673 without (+2.4%), so an escaped key stays serde_json's.
158. `corten check` fails when the app has scripts and TypeScript's `tsc` is not installed, where
    it printed a note and passed, so a CI job without TypeScript passed with every script
    unchecked. It looks for `tsc` first and fails before format, lint and tests run. `corten check
    --no-script-types` skips the scripts' type check and says how many it skipped, for a machine
    that cannot run `tsc`; any other argument is now refused, where it was ignored. Corten's CI
    installs the TypeScript its `package.json` pins before checking the app `corten new` writes,
    which it type-checks now; CONTRIBUTING's container, which has no Node, passes the flag.
    Breaking for an app whose check ran without `tsc`: install TypeScript (`npm install --global
    typescript`, or in the app's `package.json`), or pass the flag
    ([#1013 corten check exits 0 when tsc is not installed, so a CI job without TypeScript passes with every script unchecked](https://github.com/corten-run/corten/issues/1013)).
159. `#[derive(Fields)]` and `#[derive(UrlValue)]` implement serde's `Deserialize` themselves, so a
    form, a query set or a URL word derives one thing: `#[derive(Fields)] struct Sell { .. }` where
    it was `#[derive(Deserialize, Fields)]`. The impl is the one serde's derive writes from the same
    `#[serde(..)]` (`rename`, `rename_all`, `alias`, `default`, `skip`, `other`,
    `deny_unknown_fields`, `borrow`, `bound`, `expecting`), with the bounds serde infers: the same
    names, values and errors, checked against serde's derive on forms, JSON, identifiers by index
    and by bytes, borrowed fields and generic ones (`tests/derived_deserialize.rs`). An attribute
    that reads the type another way (`flatten`, `with`, `deserialize_with`, `from`, `try_from`,
    `transparent`, `remote`, `tag`, `untagged`), which serde's derive beside `Fields` followed
    before, does not compile; such a field gets a type of its own that implements `Deserialize`.
    **Migration:** take `Deserialize` out of a derive list that has `Fields` or `UrlValue`, which is
    now a second impl of the trait (E0119); an app whose only serde derive was that can drop
    `serde` from its dependencies, as `corten new`'s template now does. Reading a seven-field form
    costs the same (callgrind, release build, 1,200 reads less 200 over 1,000, three runs each:
    9,241 instructions a read before and after)
    ([#763 Corten's form, route and JSON readers still require serde's Deserialize beside their own derives, and FromJson allocates every string it reads from an upstream body](https://github.com/corten-run/corten/issues/763)).
160. A value that is not a link where an `Href` is expected (a `&dyn Href`, `req.redirect`, a
    `#[derive(Href)]` variant) fails with "`..` is not a link" and notes that say what a link is,
    that text from outside the code is `Local::parse(text)` and that a boxed route is passed as the
    route itself or as a `Box<dyn Href>`, where before the error ended in a long list of types
    ([#974 Href has no on_unimplemented note, so a value that is not a link (a Box of a route) fails with E0277 listing 120 impls](https://github.com/corten-run/corten/issues/974)).
161. The runtime's declarations for `corten/views` (`rows()`, `view()`, `Holds`, `ViewClass`,
    `Rows` and the rest) ship with the crate in `js/views.d.ts`, which `corten check` already
    gives `tsc`, instead of being written into each app's `types/app.d.ts`. The app's file holds
    only what its own types, events and views produce, so a release that changes the runtime's
    declarations no longer fails the app's types test once and leaves framework text to commit
    with the pin. An app with views gets that failure one last time when it moves to this
    release, as `Types::sync` drops the runtime's block from its file. Since `tsc` now sees
    `rows()` and `view()` declared for every app while the import map names `corten/views` only for
    an app with a view, a script of an app without one that imports it is an error when the app
    starts, as an import of `corten/keys` with nothing serving it is, rather than in the browser.
    `Types::sync`'s message says the file may be out of date with how the Corten release declares
    the app's types as well as with the types
    ([#1020 A pin bump fails the app's corten check once when Corten's own script declarations change, blaming the app's Rust types](https://github.com/corten-run/corten/issues/1020)).
162. A client navigation changes the address when the page's answer is in, as a full load's does,
    not at the click: while a slow handler runs, the address still names the page on screen, so
    reloading, copying or sharing it gets that page, and a link the server redirects shows only
    the redirect's address (keeping the link's `#id` when it names none), in one history entry
    instead of the link's address replaced by the target's; a link the server sends to a place
    on a page or another site (`corten-location`) shows only that address too, the next
    navigation taking this one's place in history before its address changes. `main` and the
    link are busy from the click as before. It holds where the browser has the Navigation API's
    `precommitHandler`, which the runtime detects; elsewhere, and for back and forward, the
    address changes at the click as before. The runtime's own navigations (a redirect followed,
    a write's page) handle their `committed` promise, which a navigation replaced before its
    address changes rejects.
    In the watchlist's smoke, a page held 800 ms showed the old page busy at the old address for
    781 to 800 ms and the new address on the old page for 0 ms, in Chromium and Firefox; the
    issue measured the address changing 29 ms after the click and the page 255 ms after. The
    minified runtime is 789 bytes larger (40,232; 301 more gzip at level 9, 272 brotli, 301 zstd)
    ([#992 A client navigation changes the address before the page arrives, so the address names a page the screen does not show for the handler's whole time](https://github.com/corten-run/corten/issues/992)).
163. The `log` feature (on by default) prints with a subscriber of Corten's own instead of
    `tracing-subscriber`, so an app's default build has five crates fewer: `tracing-subscriber`,
    `sharded-slab`, `thread_local`, `nu-ansi-term` and `lazy_static` (`cargo tree -p corten-run -e
    normal`: 53 crates before, 48 after). Each event at `INFO` or above goes to stdout as the line
    `tracing_subscriber::fmt().with_target(false)` wrote, colors and an error's `.sources` included
    (`2026-11-06T21:20:29.018154Z  WARN message key=value`), which
    `log::tests::lines_are_tracing_subscriber_s` checks line by line against it, with and without
    color, for startup, shutdown, a failed request, an agent tool's error and an app's error with
    sources. What changes: the spans an event is in are not printed (an app that wants them sets its
    own subscriber before `serve`, as before); colors only when stdout is a terminal, where they
    were written into a container's logs too; every control character but a tab is escaped in
    every field, a line break included, where only the message's and an error's escape, bell,
    backspace, form feed, delete and C1 controls were, so request text in a field cannot start a
    line that reads as another event; and a `log` crate record is not printed even where another
    crate in the build turns on `tracing-subscriber`'s `tracing-log`, which made `try_init` forward
    them. The guide said stderr; it was and is stdout. A line costs 10.4% fewer instructions
    (callgrind, release build, 1,200 lines less 200 over 1,000, two runs each: 6,619 and 6,627 a
    line against 7,363 and 7,414 for `tracing-subscriber` with the `ansi` feature `log` turned on
    in it), and the template app's release binary is 151,672 bytes smaller (5,903,632 against
    6,055,304 at `bcd31ffe`). Its clean build time, measured on the first version of this change
    against `f6d39bbd`, did not move beyond the machine's noise (debug, six runs each on 4 CPUs,
    alternating: median 55.7 s against 58.0 s, ranges 50.9 to 61.3 s and 45.1 to 75.6 s)
    ([#764 The default log feature compiles tracing-subscriber and four crates only it needs, to print a few lines to stderr](https://github.com/corten-run/corten/issues/764)).
164. A markup call to a handler whose parameter has a JSDoc type no Rust value is checked against
    does not compile, where it took any `ToJson` value: an object type (`{ count: number }`),
    `number[]`, `string | null`, `object`, `any`, a `@typedef` of plain values, an unknown name, or
    a group with a field of such a type. So does one whose parameter names an element or an event in
    a shape no call is checked against, which took any ref or event: a union of event interfaces
    (`MouseEvent | KeyboardEvent`; take the one they share, `UIEvent` or `Event`),
    `HTMLElement | null`, `EventTarget`, `Node`. The warning on the call says why and what to take
    instead: a generated declaration (`import("../types/app").Name`) for a value, a checked
    interface for an element or an event, or `unknown` for anything the script checks itself, the
    one type that still takes any argument (a value, a ref, `event`, `target`, `signal` or `scope`).
    The handler itself compiles, so an export only other scripts call is typed as the script needs.
    A typed event imported for its type alone (`/** @import { Saved } from "corten/events" */`) is
    now its `#[event]` type, as an `import` statement's is, where it took any event: `on:click` on
    such a handler does not compile. A JSDoc namespace import of them
    (`/** @import * as ev from "corten/events" */`), which compiled, now stops the script compiling,
    as a namespace `import` statement of them does. No example, kit component or template script
    called a handler with such a parameter; six event handlers in `examples/deck-builder` and
    `examples/seller-desk` are now checked
    ([#1037 Unsupported handler parameter types can silently fall back to unchecked Rust-to-JS arguments](https://github.com/corten-run/corten/issues/1037)).
165. `Feed::follow` now panics on a generation that is empty or holds anything but ASCII letters,
    digits, `.` and `_`. It took any without `-` before; one with a character a URL encoder
    escapes (`deploy:3`, base64) never went live under `subscribe()`, though a client that sent
    its cursor raw (`Last-Event-ID`, `Replica::cursor`) could follow it. An app that names its
    generation from configuration checks it against the same set (Fixed 188)
    ([#1067 A feed generation with a character encodeURIComponent escapes never goes live: Since does not decode ?since=, so subscribe() loops snapshot and sync about 190 times a second](https://github.com/corten-run/corten/issues/1067)).
166. The kit's `Gap` has a sixth value, `Gap::App`, which prints only `.stack` or `.cluster`: the
    app's own `gap` utility or class beside it (`class={(Stack { gap: Gap::App }, gap_3())}`) is
    then the only gap, so an app on its own spacing scale keeps the kit's column or wrapping row
    and its dropped child margins instead of a page rule of its own. A literal gap beside the
    utility sets `gap` twice at one specificity, so the stylesheet linked last wins: use `App`
    there. The five
    literal gaps are unchanged. A `match` over `Gap` in an app's code needs the new arm; `corten
    ui diff` shows the change to a copied `stack.rs`. The ui-gallery's payout row uses it with the
    page's own .75rem
    ([#1065 Kit Stack and Cluster always print a literal gap, so an app on its own token spacing scale cannot use them with its gap utility](https://github.com/corten-run/corten/issues/1065)).
167. A body read as it arrives (`pieces_up_to`, `Upload`) is also `Stalled` (408) once the client
    falls its idle time behind 240 bytes a second in all (Kestrel's minimum body rate), counting
    only the time spent waiting for the client. A byte now and then reset the idle time before,
    so on a route with a long deadline or none (a large upload's) a client trickling the body
    held the connection and the request as long as it liked. A client sending at any real speed
    is not affected; `idle(None)` turns the rate off with the idle time. A read dropped and begun
    again (a `chunk()` inside a `timeout` or `select!`) no longer starts the idle time again, so a
    client that went quiet is given up on after the idle time however the handler reads
    ([#1074 A request body trickled in a byte at a time is bounded only by the route's deadline: a route with none (a long upload) holds the connection as long as the client likes](https://github.com/corten-run/corten/issues/1074)).

169. The image `corten new` writes (and card-market's) runs jemalloc with
    `MALLOC_CONF=background_thread:true,tcache_max:65536`, a third line beside the two that
    preload it. The background thread returns a flood's memory while the app is idle (eight floods
    of unfinished heads left 13 to 16 MiB of `memory.current`, against 118 to 139 without it and
    406 to 455 on glibc's allocator, three runs each). The larger thread cache keeps brotli's buffers:
    brotli responses took 19.3 to 19.4 page faults each on average before, and none now. glibc's
    own tunables were tried: fewer arenas changed nothing, and a lower mmap threshold left about
    180 MiB, still growing. `bench/fullstack/flood-memory.mjs` drives the floods,
    `alloc-faults.mjs` counts page faults a request, and `ab.mjs` measures brotli alone too
    ([#1011 Design Choice 23's jemalloc default rests on one flood run each and CPU rounds on a shared desktop; brotli and glibc's own tunables were never measured](https://github.com/corten-run/corten/issues/1011)).

### Fixed
- The fixed favicon keeps its weak content tag when background compression finishes, so a
  conditional GET still returns 304 instead of downloading the unchanged icon again.
- CopyButton ignores clipboard completions from a removed lifetime, including after reconnect.

1. Hover prefetch kept every page a user hovered and never opened until the next form post. It
   now keeps the 8 newest (dropped ones have their bodies cancelled) and fetches nothing when
   the browser's data saver is on.
2. A patch no longer throws away what the user is doing: a field they edited (after its form was
   sent, for the form's own answer) keeps its value, and focus and the caret stay on the
   matching element. An invalid answer focuses its field only if the user has not moved on.
3. An integer handler argument past 2^53 reached the browser as a different number. Debug
   builds and tests now stop on it (pass such a value as a string).
4. A multiple select the user edited kept only its first choice when a patch replaced it; it
   keeps them all.
5. `<corten-live>` reconnected to a stream that had ended, so a finished stream was requested
   again every few seconds. `corten::live` now ends with an `end` event and the element closes.
   Shutdown ends open `corten::live` streams first, as it does feed streams: `docker stop` on the
   hello example with one stream open took 4,059 ms before and 965 ms after (measured, one run
   each; 637 to 929 ms with no stream).
6. `bench/fullstack/browser.mjs` finds Corten's sort button and listing prices by the
   `listing-sort` component's scope (`[data-scope=listing-sort]`). It looked only for the
   `<listing-sort>` island that handlers replaced, so the browser pass stopped at Corten's page.
7. `corten-ui`'s `MenuButton` returned focus to its button in WebKit even when the user had
   clicked elsewhere: WebKit moves focus out of a closing popover before `toggle` fires, so the
   menu now records on `beforetoggle` whether focus was inside it.
8. A client navigation the server redirected (a page handler answering `req.redirect`, now a
   guard sending someone to sign in) changed the address to where it was sent but left the old
   page on screen: the runtime's `history.replaceState` aborted the navigation, and the body
   read with it. The runtime now reads the page, then navigates to its URL in place of the
   requested one with the page in hand, so it is swapped in without a second request. The
   runtime is 156 bytes larger, 46 gzip. Found by the hello smoke test's guarded page in
   Chromium and Firefox.
9. A component's stylesheet can have a class named like the component: `.card` in `Card`'s
   stylesheet is `class={Card}` in its markup. Before, the class constant hid the component's
   own `Component` constant inside `render`, and the build failed with "expected `&Component`,
   found `&Class`" pointing at `#[component(css)]`. Found porting a Chase Sets admin screen,
   where `Field` with `.field` and `Choices` with `.choices` had to be renamed. The generated
   code only moves the class constants into a block: `render_cost`'s render functions measured
   996,177,186 instructions before and 997,217,167 after under callgrind (one run each, 7,735
   bytes a page both times).
10. Without `HOST`, `corten::serve` listens on both loopback addresses, `127.0.0.1` and `[::1]`,
    on one port (only `127.0.0.1` on a system without IPv6). Before, it took `127.0.0.1` alone,
    and a browser that resolves `localhost` to `::1` first (Chromium on Windows) waited for a
    fallback on every new connection: about 200 ms added to every page and asset, measured
    porting a Chase Sets admin screen, where it made the port look slower than the React app it
    replaced. A `[::1]` port another process holds is now an error at startup, since
    `localhost` would reach that process. `HOST` set (as the Dockerfiles set `0.0.0.0`) binds
    that one address, as before.
11. A navigation started before the first page has fired `load` is a full page load instead of a
    swap. A form a script submitted from `on:connect` made Chromium stop loading the page, and
    the runtime taking that navigation over left it without a `load` event
    ([#11 A navigation taken over before the first page loads stops it loading](https://github.com/todd-skelton/corten/issues/11)).
12. `corten dev` rebuilds when a local package the app's build reads changes (a path
    dependency, a workspace's shared crate), not only on a change in the app's directory. It
    takes the packages from `cargo metadata` after each build
    ([#10 corten dev does not rebuild when a path dependency changes](https://github.com/todd-skelton/corten/issues/10)).

13. A `data-patch` form with a control named like one of the form's properties
    (`<button name="action">`, an `<input name="method">`, `id`, `elements`) posts as it does
    without JavaScript. The runtime read `form.action` and `form.method`, which the DOM makes the
    control, and posted to `/[object HTMLButtonElement]` or threw; it now reads the form's own
    properties. Found in the Chase Sets pilot, where `#[derive(Fields)]` named a field `action`.
14. A component is scoped only when it has refs or a handler in its markup takes `scope`
    (`on:click={js::clear(scope)}`). `#[component]` treated any identifier named `scope` as asking
    for it, so a component with a variable or field of that name and two root elements failed with
    an error about refs it did not have. The error for a scoped component with several roots now
    names both causes. Found in the Chase Sets pilot
    ([#26 A component that names a variable scope is treated as scoped](https://github.com/todd-skelton/corten/issues/26)).
15. An image built from one checkout no longer gets the crates another checkout built. The
    Dockerfiles (the examples', the benchmarks' and the one `corten new` writes) keep `target/` in a
    cache every build on the machine shares, and cargo decides a crate is current by file times,
    so a checkout whose files were older than the last build compiled against that build's
    crates (an item page image failed with `FromJson` missing from `corten`), and two builds at
    once wrote the same `target/` (a test build lost an rlib another was replacing). Each build now
    touches the sources it copied first and takes the cache alone (`sharing=locked`), so builds
    wait for each other; a rebuild with no change compiles the workspace's own crates again (the
    item page: 137 s, where it took 6 s), and the registry's stay cached.
16. `corten check` at a workspace root type-checks the scripts of every member that depends on
    `corten`, each against its own `types/`, as `cargo test` there tests each member; it found
    none before and passed without a word. Without `tsc` the note names the members. The CLI reads
    `cargo metadata` with a small JSON reader instead of searching its text. Found by the Chase
    Sets pilot, whose CI ran `corten check` once at the root of its three-member workspace
    ([#39 corten check at a workspace root type-checks none of the members' scripts](https://github.com/todd-skelton/corten/issues/39)).

17. A form with a control named `id` is patched: the runtime read the patch's `el.id`, which for
    `<form id="x"><input name="id">` is the input, so a refused `data-patch` form's 422 was
    dropped and its field errors never shown. Ids are read from the attribute, in the patch and
    where a patch carries over what the user typed (which lost the text in a form like that
    inside a patched block)
    ([#44 A form with a control named id cannot be patched](https://github.com/todd-skelton/corten/issues/44)).
18. A `@typedef` with a `Message` property is a group (`js::Counted { entity, label: t.js().x() }`),
    as one with an element is: a message is not JSON, so the typedef stayed a JSON value, no
    `js::Counted` existed, and the compiler said only that it could not find it. Found by the
    Chase Sets pilot, which passed a count's texts as three parameters
    ([#50 A @typedef of plain values and a Message is not a group, and the error does not say why](https://github.com/todd-skelton/corten/issues/50)).
19. A catalog message may take an argument named like a Rust keyword (`{type}`, `{match}`,
    `{ref}`): its parameter is the raw `r#type`, and `by_key` and `Message<"type">` keep the
    catalog's name. `messages!` refused 59 names, so a catalog shared with another app failed to
    compile; only `self`, `super`, `crate` and `_` remain, with an error that says to rename
    them. Found by the Chase Sets pilot, whose shared catalog has `{type}`
    ([#56 A catalog message cannot take an argument named like a Rust keyword ({type})](https://github.com/todd-skelton/corten/issues/56)).
20. A catalog argument may be camelCase (`{updatedAt}`): the method's parameter is `updated_at`,
    and `by_key` and `Message<"updatedAt">` use the catalog's name, so an API's params with the
    same names fill it. Two names that make one parameter in a message (`{updatedAt}` and
    `{updated_at}`) are an error naming both. Found by the Chase Sets pilot, whose shared catalogs
    have 365 camelCase arguments
    ([#58 A catalog message cannot take a camelCase argument ({updatedAt})](https://github.com/todd-skelton/corten/issues/58)).
21. A patch with a top-level element the browser would drop (no `id`, or text outside an
    element) is an error in debug builds that names it: `req.patch`, `patch_with_status` and
    `req.invalid`'s form answer 500 instead of a patch, so a router test or the first request in
    development fails, and a `corten::live` fragment panics. Release builds send the patch as
    before, with no check. Found by the Chase Sets pilot, whose refused write-off answered 422
    with the API's message in a `<div>` without an id, which the page never showed
    ([#61 A patch element without an id is dropped in the browser, and nothing says so before](https://github.com/todd-skelton/corten/issues/61)).
22. A handler that panics is answered as a 500 with the error page in the request's mode, and the
    panic is logged, instead of the connection closing with no response.
23. `html!` that is `let`s and then one component is a patch when the component is one, as it is
    a document when the component is one: a component declared `-> impl Patch` whose markup made a
    value and passed it to a patch component did not compile. Found by the Chase Sets pilot, which
    wrapped four views in `match () { () => { .. } }` to get past it
    ([#82 A view that is lets then one patch component is not a patch (One<F> never implements Patch)](https://github.com/todd-skelton/corten/issues/82)).
24. A patch or a `<corten-live>` fragment no longer closes what the user opened: a `<dialog>` stays
    open (`showModal()` again when it was modal, so the page behind stays inert), a `<details>` stays
    unfolded and a shown popover stays shown. One the user did not touch takes the new markup's
    state, so the server can still close a dialog it sent open. The runtime is 268 B larger gzipped
    (7,807 to 8,075 B). Found by the Chase Sets pilot, whose item page's live market book closed a
    reference dialog the user was reading
    ([#84 A patch or live fragment closes a <dialog> the user opened and folds a <details> they unfolded](https://github.com/todd-skelton/corten/issues/84)).
25. A checkbox or radio without a `value` attribute is found by its name when a patch keeps what
    the user changed (its selector asked for `[value="on"]`, which only the attribute matches, so
    it fell back to its place).
26. A `data-keep-place` navigation keeps what the user sees around the control it focuses: an
    element that scrolls on its own (a filter rail) keeps its scroll, and a `<details>` open on
    screen stays open (one the user closed stays closed), so the control is in view and focus is not
    lost to `<body>` when the server draws its group closed. `examples/hello`'s filter is in a
    scrolling rail of two groups, checked by the smoke test
    ([#96 A data-keep-place navigation resets a scrolling container (a filter rail), so the control it focuses is out of view](https://github.com/todd-skelton/corten/issues/96),
    [#97 A data-keep-place navigation folds the <details> the user unfolded, so focus can fall to the body](https://github.com/todd-skelton/corten/issues/97)).
    The runtime notes the elements that scroll as they do, so keeping a place reads only those (0.1 ms on a page of 4,770 elements in Chromium, against 15 ms reading every element's scroll; measured), and is 167 B larger gzipped (8,362 to 8,529 B, measured).
27. A release build of `corten` compiles without a warning: the check that a patch has an id on
    each top-level element, which runs in debug builds only, is no longer compiled into release.
28. The error page keeps the headers of the failure it replaces: a request id, `Retry-After`,
    `WWW-Authenticate` and `Server-Timing` a handler or a middleware set were dropped (only
    `Allow` was kept), on the sign-in redirect and the offline page too. The ones that described
    the old body and `Cache-Control` are the error page's
    ([#126 The error page drops the headers a middleware or handler set on the failed response (Retry-After, a request id, Server-Timing)](https://github.com/todd-skelton/corten/issues/126)).
29. A client navigation to a page in another layout loads it in full: the shell key includes the
    layout (a hash of where its `html!` document is written, a constant), so the first layout's
    header and footer no longer stay around the next page's `<main>`, and links between layouts
    need no `data-reload`. The default error document is a layout of its own too
    ([#122 Client navigation between pages with different layouts keeps the first layout, because the shell key does not include the layout](https://github.com/todd-skelton/corten/issues/122)).
30. A link to a route that redirects to another site (`req.redirect(&uri)` or `req.moved(&uri)`)
    leaves the app in one request: a client navigation gets `corten-location` and the browser
    goes there, where before the runtime's `fetch` followed the redirect, the CSP's `connect-src`
    refused it with a console error (the hover's prefetch too), and the page reloaded to follow it
    again
    ([#131 A client navigation to a route that redirects to another origin is blocked by connect-src, then reloads](https://github.com/todd-skelton/corten/issues/131)).
31. `html!` reads a pattern with braces as Rust does: `if let Shape::Circle { r } = shape { .. }`
    and `for Point { x, y } in points { .. }` took the pattern's braces for the body and did not
    compile. `corten fmt` reads them the same way
    ([#142 html! if let cannot take a struct pattern: the pattern's braces are read as the body](https://github.com/todd-skelton/corten/issues/142)).
32. A patch keeps the files chosen in a file input it replaces, as it keeps typed text, so a
    refused upload redraws its input marked invalid with the files still chosen; a successful
    answer to the form that sent them clears them. The runtime grows by 47 bytes gzipped
    ([#143 A patch drops the files chosen in a file input it replaces, so a refused upload cannot mark its input invalid](https://github.com/todd-skelton/corten/issues/143)).
33. A `data-keep-place` swap keeps the scroll of an element that scrolls on its own (a filter
    rail) when the swap lands before that element's `scroll` event, which comes at the next
    frame: a control focus scrolled into view, or a slow machine. It counts the focused control's
    ancestors as scrolled, and an element whose scroll it restored. The runtime grows by 38 bytes
    gzipped
    ([#130 Firefox sometimes loses the filter rail's own scroll after a data-keep-place swap (smoke: 76 -> 0)](https://github.com/todd-skelton/corten/issues/130)).
34. A link to a new page goes to the top of it (or to its `#id`) in Chromium too. Chromium could leave
    a page the runtime swapped in where the last one was scrolled (seen from About to Home, and on
    a link to the page already open), though Firefox and WebKit went to the top; the runtime now
    scrolls itself, as it already did for a page the server sent to an `#id`. Back and forward
    still return to where the user was. Found when `examples/watchlist`'s taller About page made
    the smoke test's "a plain link still goes to the top" fail. The runtime is 6 B larger gzipped
    (9,018 to 9,024 B, measured).
35. A field with a hint of its own can point at the hint and at its error: `e.aria(field).hint(&HintId)`
    writes one `aria-describedby` naming both. Before, the hint needed a second
    `aria-describedby` on the tag, which the browser dropped, or the error's id written by hand.
    A start tag that writes `aria-describedby` or `aria-invalid` beside `e.aria(..)` no longer
    compiles, since the browser would keep only one of them
    ([#147 A field with its own hint cannot also point at its error: Within::aria writes a second aria-describedby, which the browser drops](https://github.com/todd-skelton/corten/issues/147)).
36. A body over `Upload::limit` can be answered with the form and a message. `Upload`'s reads
    return `UploadError` (`TooLarge`, `Malformed`, `Fields`), which `?` still turns into a 413,
    400 or 422; a handler matches `UploadError::TooLarge` instead of comparing statuses or reading
    `Content-Length`. The rest of an over-limit body is now read past (up to 64 MiB) before the
    answer: before, Chromium (and Firefox, for a 20 MB body) took the closed connection for a
    network error and showed nothing, not even the error page
    ([#150 A handler cannot read an Error's status, so an upload over Upload::limit (413) cannot draw the form again with a message](https://github.com/todd-skelton/corten/issues/150)).
37. A page whose handlers call a script module the app does not serve is an error in debug builds
    (a router test, `cargo run`), naming the module to list; a release build logs it. Before, it
    rendered with a 200 and only the browser found the 404, after which the module's handlers did
    nothing
    ([#157 A page that names a script! module the app does not serve renders fine; only the browser finds the 404, and its handlers silently do nothing](https://github.com/todd-skelton/corten/issues/157)).
38. A `Relay` keeps the upstream's `Content-Security-Policy` in place of the app's, so a relayed
    page's own scripts run. Before, the app's policy replaced it and blocked them
    ([#164 A Relay loses the upstream's Content-Security-Policy, so a relayed page's own scripts are blocked](https://github.com/todd-skelton/corten/issues/164)).
39. A connection that never finished its request head was held open for as long as the client
    liked (measured: 150 s and counting), since `serve` never bounded it. A head now
    has 30 seconds (`App::header_timeout`), after which the connection is closed, and
    `App::max_connections(n)` caps how many are open. Both apply to `serve_on` too: Corten now
    accepts connections itself instead of through `axum::serve`; the check costs a keep-alive
    request about 300 instructions, which the accept loop saves, so a request costs what it did
    ([#170 A client that never finishes its request head holds a connection open forever](https://github.com/todd-skelton/corten/issues/170)).
40. The watchlist smoke's check that controls named `action` or `method` do not change a post
    failed in Firefox about one run in three: it saw the post the check before it sent (whose
    message it already matched), which Firefox reported late, not a second post. That check now
    waits for its own answer, and the next one names each post's stock. The runtime never sent
    a post twice: the route the smoke intercepts saw one per submit
    ([#161 Firefox smoke: the shadowed-controls form is seen posting twice now and then](https://github.com/todd-skelton/corten/issues/161)).
41. `examples/seller-desk`: typing a price threw `unsent.add is not a function` and the
    "prices not saved" note never showed. The grid kept two `state(scope, ..)`s for one element,
    and an element has one, so the second got the first's object. They are one object now, and
    `state`'s docs say an element has one state. The seller-desk smoke test, which caught it, now
    runs in CI, and waits for what it checks instead of fixed timers.
42. In Chromium a submit button's `formmethod` decides how a navigating form goes, as it does in
    Firefox and without the runtime. The runtime read the method from `NavigateEvent.formData`,
    which Chromium sets from the form's own method: a `formmethod="post"` button in a GET form was
    taken over and sent as a GET of its `formaction` with no fields, so the write was dropped
    without a word, and a `formmethod="get"` button in a POST form loaded the page in full instead
    of swapping it. It now reads the method from the submitter, else the form. `corten.js`:
    22,834 to 23,032 B (8,380 to 8,442 B gzip)
    ([#190 In Chromium, a POST submit button in a GET form is sent as a GET with no fields: the runtime reads the method from NavigateEvent.formData](https://github.com/todd-skelton/corten/issues/190)).
43. A `data-patch` form reads its submit button as the browser does: `formmethod="put"` (or any
    method the browser does not know) is a GET, an empty `formmethod` is a GET, an empty
    `formaction` is the page's own address, a relative one resolves against `<base href>`, and a
    `formenctype` of `multipart/form-data` sends multipart. It read the raw method and action attributes and only
    the form's `enctype`, so it sent a PUT where the browser sends a GET, used the form's method
    and action for the empty ones, and sent a `formenctype="multipart/form-data"` button's file
    as text. A form whose method is `dialog` now closes its dialog and sends nothing; before, it
    sent a `DIALOG` request. One function, `sendsAs`, reads the button for both the patch and the
    navigation path. `corten.js`: 23,032 to 23,264 B (8,442 to 8,503 B gzip)
    ([#196 A data-patch form reads its submit button's raw formmethod and formaction, so formmethod=put sends a PUT where the browser sends a GET](https://github.com/todd-skelton/corten/issues/196)).
44. A `Relay`'s answer is passed on as it came with feature `compress` on too, as its rustdoc said
    (the guide said a relayed event stream was compressed; it now says none is): a buffered relayed body was compressed for a client that accepted zstd, brotli or gzip, and a
    relayed event stream (a model's streamed answer through a gateway) for one that accepted zstd
    or brotli, holding a compression context (480 KiB reserved for zstd, about 1 MB for brotli)
    from the budget the app's own live streams share, for as long as it ran, and every compressible
    relay got `Vary: accept-encoding`. A relay that should be compressed forwards the client's
    `Accept-Encoding` to its upstream, with a client that does not decode the body. Every other answer pays
    one look at its extensions: 11 instructions when it has none, 32 when it has one (callgrind)
    ([#205 With compress on, a Relay's answer is re-encoded per connection, so a gateway holds a 480 KiB coder for every relayed model stream and cannot opt out](https://github.com/todd-skelton/corten/issues/205)).
45. `SetCookie::path` refuses a control character (a tab or line break) where it is set, and
    `SetCookie::new`, `path` and `remove` name the caller's line when they panic. Before, such a
    path passed `path` and panicked when the answer was sent
    ([#204 SetCookie::new panics on a value it cannot carry, so a token from another service can turn a sign-in into a 500](https://github.com/todd-skelton/corten/issues/204)).
46. The two smoke checks that failed now and then in CI say why when they fail: the early form
    submit (`scripts/smoke.mjs`) reports the navigation requests, responses, commits, failed loads
    and errors with their times, and ui-gallery's first page names the engine, the scripts that
    loaded and the failed requests instead of throwing a bare timeout. When either smoke throws (a
    page whose `load` never comes, as WebKit's first `goto` in `scripts/smoke.mjs` once did), it
    lists the requests its open pages are still loading, oldest first. None of these reproduced
    locally, so none is fixed yet
    ([#232 WebKit smoke: "a form submitted before the first page loads navigates" fails now and then](https://github.com/todd-skelton/corten/issues/232),
    [#252 ui-gallery smoke: the first page's combo box did not connect within 30 s in Firefox (CI, once)](https://github.com/todd-skelton/corten/issues/252)).
47. `bench/fullstack`'s browser pass stopped in round r7: card-market refuses a price alert on an
    item with no listings (`item_12345`), and the pass waited 30 s for "Alert set". The form
    action is no longer timed on that item, for any app, since the others set an alert Corten
    refuses and the two are different work; the empty item's load, sort and client navigation are
    measured as before. Medians of the action now come from eight of ten runs per profile
    ([#259 Benchmark round r7 has no browser numbers: Corten refuses the price alert on item_12345, which has no listings, and browser.mjs times out waiting for 'Alert set'](https://github.com/todd-skelton/corten/issues/259)).
48. `ReadAgain::from(&route)` in a page's markup starts its read, as in a patch, on a full load
    and after a navigation: only those parts are read again, and what is beside them (a form the
    user is filling in, a payment provider's frame) stays. Before, the runtime acted on it only in
    a patch, so a page had to start the first read with a script of its own. It stops when the
    page is left or an element with an id beside the tag is replaced; with JavaScript a page that
    reads parts again is not read whole, so its head's `ReadAgain` is for a browser without it.
    The watchlist's alerts page reads its status line and list so. The runtime grows by 273 B
    (72 B brotli)
    ([#276 A page cannot ask for one of its parts to be read again, so a page holding a third-party frame needs a script to start the read](https://github.com/todd-skelton/corten/issues/276)).
49. examples/ui-gallery's live regions stay in the page while they are empty: the toaster's root,
    the form's result and the menu's result were `display: none` until a message came, so the
    message was often not announced. The toast's box is drawn only while there is a message, and
    its text is the box's color (it was the page's muted grey, under 4.5:1 contrast on the dark box).
50. A `data-patch` form whose submit an `on:submit` handler cancelled was sent anyway: the runtime
    sent it before the page's handlers ran. A handler that stops the submit's propagation still
    gets the patch ([#199 A data-patch form still sends when an on:submit handler cancels the submit event](https://github.com/todd-skelton/corten/issues/199)).
51. A `data-patch` form's body is the browser's: a file field is the file's name (it was
    `[object File]`), line breaks are CRLF, a `text/plain` form is sent as text, not urlencoded,
    and neither content type names a charset. A file chosen again while the first is on its way is a
    new submit unless it is the same file (name, size and time), not a double click ([#200 A data-patch form's urlencoded body differs from the browser's: a file is [object File], line breaks are not CRLF, and text/plain is sent urlencoded](https://github.com/todd-skelton/corten/issues/200)). With 50, `corten.js` grows 201 bytes gzip.
52. The idle-connection test measured the timeout from its own call, not from the clock's tick the
    connection went idle at, so it failed under load when the clock's thread lagged. It now checks
    what the clock promises, and expiry itself is unchanged
    ([#279 watch test: an idle connection can expire early when the clock's thread lags, and the test fails under load](https://github.com/todd-skelton/corten/issues/279)).
53. A patch that took the focused element away (a row removed, or the last row of a list drawn
    again without it) left focus on the body, so a keyboard or screen reader user was sent to the
    top of the document. Focus now goes to the nearest element around it that is still on the
    page, focusable only for the move; so does focus on an element patched into one that cannot
    take it (a button now disabled). `corten.js` grows 158 bytes gzip ([#267 A patch that removes the focused element drops focus to the body](https://github.com/todd-skelton/corten/issues/267)).
54. CI's browser job could hang for an hour or more when a Playwright call never returned (Firefox,
    after the watchlist smoke closed another site's page), holding the runner with no report of
    where. The job now has a 30 minute limit (a passing one takes 11 to 14), and every browser smoke
    stops itself after five minutes with no check finished, printing the last check it finished and,
    for the runtime's smoke, the requests still loading ([#317 CI: the browser job can hang for an
    hour in the watchlist smoke, and has no timeout](https://github.com/todd-skelton/corten/issues/317)).
55. The ui-gallery smoke failed now and then in WebKit with "due to access control checks" for
    `/?sale=last`: WebKit reports a request to the page's own origin that did not finish (the
    hover prefetch, or a load the next navigation dropped) that way, as a page error, and
    Playwright does not always report that request as failed. Such a message for the gallery's
    own origin, which CORS never refuses, no longer fails the smoke; another origin's still does
    ([#301 ui-gallery smoke: WebKit logged a console error for /?sale=last, due to access control checks (CI, once)](https://github.com/todd-skelton/corten/issues/301)).
56. examples/seller-desk started its sales simulation with `tokio::spawn` in `main`, so it ran on
    through shutdown and outside the app. It is the app's `task` now, started once the server
    listens and stopped by its `Signal` at shutdown, as watchlist's market is; after a stall it
    runs one late tick instead of every missed one back to back
    ([#328 seller-desk starts its sales simulation with tokio::spawn, so it does not stop at shutdown](https://github.com/todd-skelton/corten/issues/328)).
57. corten-ui's `NumberField` could drop a step asked for with Enter or Space on a button: a
    pointer press set a flag that skipped the next click, and cleared it in a timer after the
    release, so a key that came before that timer ran (on a busy page) did nothing. The field now
    records the button each pointer pressed and skips only that press's own click (a key's click
    has `detail` 0 and always steps); a press released off the button, cancelled, or on a button
    disabled at its bound makes no click and is forgotten ([#316 ui-gallery smoke (CI, Chromium): a keyboard
    step on the second number field is lost while the first is held](https://github.com/todd-skelton/corten/issues/316)).
58. ui-gallery's RelativeTime smoke pauses its fake clock, so only the test moves the page's time.
    Under load, a slow read used to add real seconds, and "each second" failed
    ([#314 ui-gallery smoke: RelativeTime's each-second check fails under load because the fake clock still runs in real time](https://github.com/todd-skelton/corten/issues/314)).
59. examples/seller-desk looked like a static table. Price cells look like fields; the sortable
    headers show they sort and which way (`aria-sort`); the rows scroll inside the grid under a
    header that stays, with the item count above them (an archive's answer replaces it, and while
    the filter is on it says how many rows it shows of how many, kept true as an archive removes
    rows); a row at quantity 0 is marked sold out, kept current by the live levels (a `sold_out`
    hole of the row's view); on a phone the table keeps the name, quantity and price (it stays a
    table, so each cell has its header); and the statement has a total row
    ([#332 Polish: seller-desk does not look like the client-heavy screen it is](https://github.com/todd-skelton/corten/issues/332)).
60. examples/watchlist signed a visitor in by trusting a `viewer` cookie that held their name, so
    anyone could set one and be anyone, and signing out only cleared it in that browser. Signing in
    now starts a session the server keeps, named by a random token in an `HttpOnly` `Secure`
    cookie; the profile picture is kept in the session, not a cookie of its own; signing out ends
    the session on the server, and signing in again ends the one the browser had
    ([#322 watchlist signs a visitor in by trusting a plain viewer cookie, so anyone can set it and act as anyone](https://github.com/todd-skelton/corten/issues/322)).
61. examples/card-market's item page left the right half of a desktop screen empty: the picture
    stacked under the title. From 56rem the picture is the left column, beside the title, the
    tags and the price summary; a phone's one column is unchanged. The page gains two wrapping
    `<div>`s, 74 bytes of its 11,435
    ([#330 Polish: card-market's item page leaves the right half empty on desktop](https://github.com/todd-skelton/corten/issues/330)).
62. CI's Firefox stalled now and then in the watchlist smoke ("still loading: nothing"), at a
    different step each time, and once lost a page's script context in the ui-gallery Copy check.
    The likely cause is Playwright 1.60's Firefox driver, which could lose the commit of a new
    page's first navigation to a document sent with `Cross-Origin-Opener-Policy: same-origin`, as
    Corten's pages are by default ([microsoft/playwright#42731 Firefox page.goto never resolves on the first navigation to a page with COOP same-origin](https://github.com/microsoft/playwright/issues/42731),
    fixed in its Firefox build 1551); the race did not reproduce locally. The tooling is on
    Playwright 1.64.1 (Firefox build 1555), and CI's browser image follows it; Firefox still
    applies COOP. Its WebKit 27.2 logs a CSP refusal for the style it sets inside every `<select>`
    (WebKit bug 327212); in that WebKit the smokes set that line aside and report every other CSP
    violation from the page's `securitypolicyviolation` events instead (`scripts/browser-bugs.mjs`)
    ([#350 CI's Firefox stalls after the early form check, closing a page whose route is still registered](https://github.com/todd-skelton/corten/issues/350)).
63. A nav link a patch put on the page kept the `aria-current` the server wrote, judged against
    the request that made the patch (a form's action, a `ReadAgain`'s `data-from`) rather than
    the page. The runtime now marks nav links after a patch that puts one on the page or removes
    one, as after a navigation; a patch without one (a ticker's) only looks through the elements it
    put. `corten.js` grows 65 bytes gzip ([#347 A nav link a patch puts on the page keeps the mark the server judged against the form's action, not the page](https://github.com/todd-skelton/corten/issues/347)).
64. A `#[route(prefix = ..)]` field in a `#[route(query)]` set was written into links but read
    back empty: `Params` read a set with serde's derive, which knows nothing of the prefix. A set
    is now read field by field the way a route reads its own, so a list it leaves out is empty
    (it was a 400 without `#[serde(default)]`), a field's own `#[serde(default)]` fills what the
    query leaves out, and a set needs no `Deserialize`. **Breaking:** a set's serde keys that a
    route's reader does not follow (`alias`, `flatten`, `deny_unknown_fields`, the struct's own
    `default`, ...) make `Params` of a route that includes it not compile, naming the key, as they
    do on the route (a struct's `default` would read a link's `None` back as the default's
    value); and a route whose own query names and its sets' could be read back as each other's
    (one name written twice, which was a 400, or a prefix another name starts with) does not
    compile. Reading a route with a four-parameter set costs 4,107 instructions, up from 3,669,
    the same as those parameters on the route itself (callgrind, release build)
    ([#310 A #[route(prefix)] field inside a #[route(query)] set is written into links but Params reads it back empty](https://github.com/todd-skelton/corten/issues/310)).
65. examples/watchlist's header wrapped to two rows on a phone, and its alerts page used the left
    half of a desktop screen. The header is one row at 390 px: the viewer's name (and picture) is
    the link to their account, where the Account link was, and a visitor has a shorter "Sign in"
    button in its place. The alerts form and list sit side by side from 48rem
    ([#331 Polish: watchlist's phone header wraps, and the Today column changes its decimals](https://github.com/todd-skelton/corten/issues/331)).
66. examples/ui-gallery read as a grid of components rather than one listing screen. The
    listing form sits beside one column of the draft's other cards (Market, Activity, Draft,
    Stock), so cards of different heights leave no holes. Its "Ships to" boxes and its pricing,
    now radios, are styled as the fields above them. The "Manage" card's menu is the Draft card's
    "More actions" button. The SKU's copy count shows only after the first copy ("Copies: 2"), and
    `/help` explains each part of the form
    ([#333 Polish: ui-gallery reads as a grid of components rather than a listing screen](https://github.com/todd-skelton/corten/issues/333)).
67. card-market in French translated its headings but not its prices, ratings, conditions or
    card details. Its item page and cards now write a price in US dollars as the reader's locale
    writes money (`0,79 $US`), a seller's rating with the locale's decimal separator, and the
    conditions and detail labels the catalog names (`Peu joué`, `Rareté`); a value the catalog
    does not name is shown as the item API sent it. The page reads these from fields the JSON
    leaves out (`#[serde(skip)]`: cents, a `Decimal` rating, a `Grade`, a `Detail`), so
    `/api/items/{id}` still answers the benchmark's shared view model, and in English the page
    reads as before (`parity.mjs`). The listing sort compares each row's `data-cents`, the
    cents the server sorts by, where it compared a float that was `NaN` without a price, and
    keeps rows with the same price in the server's order both ways, so a second click restores it, and the
    scripts guide says when a `data-` attribute is the right tool rather than a view. The smoke
    checks a price, a rating and a condition in French
    ([#323 card-market in French translates its headings but not its prices, ratings or card details](https://github.com/todd-skelton/corten/issues/323),
    [#329 card-market sorts listings by a data-price string instead of through the rows' views](https://github.com/todd-skelton/corten/issues/329)).
68. `messages!` with an empty catalog (`{}`, an app that uses `t` only for the locale's formats:
    numbers, money, dates and relative times) failed to compile under `#![deny(warnings)]`: its `by_key` had a `match` whose only arm
    returned, so the line after it was unreachable. A doctest compiles an empty catalog with
    warnings denied.
69. Two components with one name in different modules (each feature's `SettingsForm`)
    with a stylesheet or a script fail to build, at the second one, instead of the app panicking
    when it starts ("both style .settings-form__*", "two scripts named"), and so do two `script!`
    modules with one name: like an id, each class prefix and script name is an exported symbol,
    and the symbols now say what clashed
    (`corten__two_components_style__settings_form`, `corten__two_scripts_are__settings_form`,
    `corten__two_ids_are__settings_form`, which was `corten_id__settings_form`)
    ([#368 Two features' components or ids with the same name pass cargo check and fail at link or at server start](https://github.com/todd-skelton/corten/issues/368)).
70. A `data-patch` form's `SubmitKey` is renewed once the whole answer has arrived (a patch, a
    page, or one the runtime does not draw), not when its headers do: an answer whose body was cut
    off on the way dispatches `corten:error` with status 0 and keeps the key, so the retry is the
    same submission and a committed write does not apply twice. An older submit that a newer one
    of the same form aborted no longer renews the key the newer one was sent with. The minified
    runtime grows by 97 bytes (25,413 to 25,510), 29 gzipped (9,249 to 9,278) and 33 with brotli
    (8,348 to 8,381).
71. `rows()` takes a `#[component(view)]` without a key, as the scripts guide always said it could:
    it gives a `RowList` (`at`, `of`, `indexOf`, `remove`, `swap`, `clear`, iteration), without
    `get`, `push` or `replace`, which need a key. A view no longer needs a key only to satisfy
    `tsc`. `scripts/typecheck-fixture.js` checks both
    ([#418 rows() takes only a view with a key, so a keyless #[component(view)] a script only reads fails tsc (TS2769), though the guide presents key as optional](https://github.com/todd-skelton/corten/issues/418)).
72. A `use` inside a `#[corten::routes]` module that brings in a handler, and a handler written
    inside the module, are a compile error there that says handlers are named from where the module
    is declared, not an unused import and "cannot find value" at each handler. A `use` the module
    names for itself (a field's type, a `pub use`, a `#[cfg(test)]` import) is left alone
    ([#359 A handler imported inside a #[corten::routes] module is not found, and the error does not say handlers are named from where the module is declared](https://github.com/todd-skelton/corten/issues/359)).
73. `corten check` runs the tests before `tsc`, so the test that writes `types/app.d.ts` declares a
    new view or event before a script's import of it is checked, instead of `tsc` refusing the
    import with TS2305 and stopping the check. The scripts guide says one component list goes to
    both `App::components` and the types test
    ([#386 corten check runs tsc before the test that writes types/app.d.ts, so a script using a new view fails with TS2305 until the tests are run by hand](https://github.com/todd-skelton/corten/issues/386)).
74. `#[component(css = path::Owner)]` shares a stylesheet from any module of the crate that can see
    the owner, named by its path, so a screen whose panels are in files of their own has one sheet; it worked only in the
    owner's module, and the error named a hidden module with `cargo add` advice. An owner that
    cannot be found is reported at the path written. The owner's module hands its sheet's path to
    the helper at compile time; nothing changes at run time
    ([#377 css = Owner works only in the owner's module, so a screen's views in several files cannot share its stylesheet, and the error names a hidden module](https://github.com/todd-skelton/corten/issues/377)).
75. A view lent to a prop inside another view (`action={&html! { .. }}`) borrows what it uses
    instead of owning it, so the rest of the markup can read the same local; it was a `move`
    closure and a second read was E0382. A view given by value, and the view at the top of an
    `html!`, still own what they use
    ([#414 A view in a prop (action={&html! {..}}) takes ownership of the locals it uses, so a local also read elsewhere in the page fails with E0382](https://github.com/todd-skelton/corten/issues/414)).
76. An element with the `hidden` attribute stays hidden when a component's class gives it a
    `display`: `components.css` (or, when only areas have stylesheets, each area's file) starts with
    `[hidden]:where(:not([hidden=until-found i])){display:none!important}`, so neither an app nor a
    design system for corten-ui has to know to add it. The rule adds 69 bytes to the stylesheet,
    before compression ([#423 The [hidden] { display: none !important } rule corten-ui requires is
    not in the template and nothing checks it, so a component's display silently shows hidden
    parts](https://github.com/todd-skelton/corten/issues/423)).
77. Two `#[component(view)]`s or two `#[event]` types with one name in one crate fail to compile,
    as two components with one name do, rather than the app when it starts (across crates, the
    linker refuses the pair when the program uses code next to both, and the start-time check
    catches the rest)
    (`corten__two_views_are__Row`, `corten__two_events_are__RowToggled`, and
    `corten__two_events_named__row_toggled` for the event's name in the page)
    ([#371 Two features' #[event] types or views with the same name still fail only when the server starts](https://github.com/todd-skelton/corten/issues/371)).
78. A `for`, `if` or `match` inside a `for` in `html!` compiles, in a patch and in any view: it
    failed with "use of moved value" on the whole `html!`, since the marker that says whether each
    part is a patch was moved on the loop's first pass. A patch can now redraw rows known from data
    in one loop, with a branch per row. A view refused as a patch now names the kind of part that
    is not one (`ComponentOrExpressionNotAPatch`: a component declared `-> impl Render`;
    `IdNotADeriveIdType`; `TextOrElementWithoutId`), though not its place in the view. The markers are zero-sized and the macro's output is otherwise the same, so rendering
    is unchanged
    ([#383 An if or match inside a for in html! fails with E0382 (use of moved value), and a patch's E0277 does not name the part that is not a patch](https://github.com/todd-skelton/corten/issues/383)).
79. During a pin bump (`Cargo.toml` moved to another corten revision, `Cargo.lock` not resolved
    yet), `corten dev`, `fmt` and `check` told the user to install the corten the app was leaving:
    the note now compares the command with the revision `Cargo.toml` asks for when it is not the one
    the lock was written for, and says nothing for a tag or branch whose commit the lock does not
    know yet
    ([#475 During a pin bump, the CLI version note reads the stale Cargo.lock and tells you to install the older corten](https://github.com/todd-skelton/corten/issues/475)).
80. A `Box<dyn Href>` (a link a shared component's function prop returns, when one enum of every
    page's route would join separate feature modules) is written as `href={boxed}`, as the `dyn
    Href` it holds; it was an `Href` but not an attribute value. A value that is neither text nor a
    link nor an attribute value is now an error that says so ("this value cannot be written in an
    attribute", naming what an attribute takes) instead of one about a private `__attr` method. The
    item page's `render_cost` (release, callgrind, 3 runs) is 35,567,415,208 instructions against
    35,548,560,642 on main (+0.05%; the page writes no boxed link, so this is layout)
    ([#457 Box<dyn Href> is an Href but not an attribute value, so href={boxed} fails with an error naming a private method](https://github.com/todd-skelton/corten/issues/457)).
81. A query word an enum parameter does not have (`?state=due_now`, an old bookmark or an address
    edited by hand) reads as missing, `None` or the field's `#[serde(default)]`, so `Params` shows
    the page with its filter, sort or tab at its default where it answered 400 with serde's text, and
    a `#[route(prefix = ..)]` entry holding one is left out of the map. A
    parameter that must have a value, a value that is not a word (`?page=two`), a list holding one
    and a form's body are still refused. Links write what they did
    ([#447 A typed query filter whose address holds an unknown value refuses the whole page (400) where it should read as unset](https://github.com/todd-skelton/corten/issues/447)).
82. A `corten-macros` script test bounded three parses on the wall clock (under 2 or 3 s), so check 1
    failed on a busy machine with nothing wrong. Each case now passes in one run under a second, and
    otherwise is checked by its growth (at a size about four times as long as at a quarter of it,
    not sixteen), so load slows both runs alike
    ([#495 A corten-macros script test's wall-clock bound (under 2 s) fails when the machine is busy, so check 1 goes red without a cause](https://github.com/todd-skelton/corten/issues/495)).
84. The browser smokes retry a page's `goto` or `reload` once on `net::ERR_NETWORK_CHANGED`
    alone, which Chromium raises when Docker changes the machine's network interfaces mid-run (twice
    in CI in a week, each blocking a merge until a rerun); any other failure, a second one included,
    still fails. One helper, `scripts/steady.mjs`, wraps each smoke's browser at launch. Test code
    only
    ([#497 Browser CI fails at random on net::ERR_NETWORK_CHANGED during a smoke navigation, blocking merges until a rerun](https://github.com/todd-skelton/corten/issues/497)).
85. `req.redirect_with_notice` from a write on a plain `http://` origin that is not loopback (a LAN
    tool at `http://automation.lan:3001`) reaches its page: a browser refuses the `Secure`
    `__Host-corten-notice` cookie there, so the notice was dropped without a trace. Corten reads
    the write (an `Origin` of this host over `http://`, no `Sec-Fetch-Site`) and sets a plain
    `corten-notice` cookie instead (`HttpOnly`, `SameSite=Lax`, a minute), which a page reads
    only from a request without `Sec-Fetch-Site`, so on HTTPS another site on the domain cannot
    plant one in a current browser; an app with `Policy::hsts()` never sets or reads it, and
    `localhost` and `127.0.0.1` keep `__Host-`. The ui-gallery smoke renames from the machine's
    LAN address in each engine (it fails on the image before this change). The item page's
    `render_cost` (release, callgrind, 3 runs) is 35,612,123,545 instructions against
    35,603,094,486 on main (+0.03%, within the runs' spread: a page's GET only compares the
    method and looks at its cookies once, as before)
    ([#498 redirect_with_notice is lost without a trace on a plain-HTTP LAN deployment: __Host- cookies need a secure origin](https://github.com/todd-skelton/corten/issues/498)).
86. A task (`App::task`) that returns before shutdown began is logged with its name, as one that
    panics is (`corten: task "pricing worker" returned before shutdown began`): a task that could
    not start or gave up ended without a trace, so a log could not tell it from one that runs. A
    task that did its work once and returned is now logged as well: the app guide has it wait for
    the signal when done, and a task the configuration turns off not registered (a `match` on the
    configuration in the builder chain). Nothing a request does changes
    ([#503 A task that returns before shutdown is silent: a task the configuration turns off, or one that cannot start, ends without a trace](https://github.com/todd-skelton/corten/issues/503)).
87. A release build of an app no longer warns that `Assets::module_tag` is never used: its only
    caller is the debug-build check that a page's handlers call a module the app serves, so it is
    built in debug builds only. Nothing a page renders changes
    ([#500 A release build warns that Assets::module_tag is never used: its only caller is a debug-build check](https://github.com/todd-skelton/corten/issues/500)).
88. Corten's unit tests no longer leave directories in the system temp directory: an asset
    fixture and the types test's directory are each removed when dropped, a failing test's too.
    A run of the asset and type tests left 9 directories; it now leaves none (measured).
    `any_change_changes_the_version` had passed only because an earlier fixture was still on disk,
    and now writes the files it compares. Nothing an app does changes
    ([#511 Corten's unit tests leave a directory in the temp directory for each asset fixture on every run](https://github.com/todd-skelton/corten/issues/511)).
89. `bench/fullstack/droplet.mjs` no longer hangs on its own `ssh` calls, and it ends a round
    that hangs on the droplet. Its `ssh` and `scp` calls do not inherit stdin: started hidden on
    Windows, `ssh` sometimes waited on that console after the remote command finished, and the
    r7, r8 and r9 rounds each hung for hours in one such call (r9 never measured anything). Every
    call has a time limit, and the steps that are retried have one on the droplet too, so a retry
    never runs beside the attempt it replaces. When a full-comparison droplet stops answering for 15 minutes (`--stall`), or the
    round's log stops growing for an hour (`--idle`), the droplet is power-cycled if DigitalOcean
    can be reached and, once it has restarted, the round goes on from the step after the one it was in, at most twice.
    The skipped step is recorded in `run.log`, `skipped.txt` and `summary.json` (`skipped`). A
    round that fails, or whose process dies without finishing, tries to download what it measured
    before the droplet is destroyed
    ([#466 Benchmark round r8 has no instruction counts: its droplet locked up twice when count.mjs started counting](https://github.com/todd-skelton/corten/issues/466)).
90. A `bench/fullstack` round runs on its droplet by itself, so a hung connection or a sleeping
    PC can no longer stop or stall it. `droplet.mjs` starts the round as a systemd unit;
    `--detach` leaves once it has started and `--collect` downloads a round that has ended and
    destroys its droplet (or says where it is). `run-all.mjs --unattended` gives every call a time
    limit and stops one that runs past it or prints nothing for an hour. A kernel lockup panics
    and reboots the droplet, and the round goes on from the step after the one it was in, so it
    needs no power cycle from outside. The droplet is destroyed only after its results are
    downloaded. The step order, limits and resume rule are in `round.mjs`, tested by
    `round.test.mjs` (`npm run check`)
    ([#466 Benchmark round r8 has no instruction counts: its droplet locked up twice when count.mjs started counting](https://github.com/todd-skelton/corten/issues/466)).
91. A failure under `NoStore` is sent with `Cache-Control: no-store`, as its doc says: the error
    page that replaces the failed answer kept the default, `private, no-cache`, which let the
    browser keep an expired code's page or someone else's statement's 404 and restore it from its
    back/forward cache. A failure whose `Cache-Control` names `no-store` (`NoStore`'s, or one
    written by hand, however a cache could find it) now gets an error page sent `no-store` (a
    JSON failure already kept it). A request refused before the handler runs, a panic and a
    deadline never reach `NoStore` and keep the default. When Corten decides whether an answer
    may be shared, a `Cache-Control` written by hand now counts for what it plainly says, on any
    of its lines: `private="set-cookie"`, `no-store=1`, a directive inside a quoted value and a
    `no-store` beside `must-understand` (with or without a value; a cache that knows the status
    may ignore the `no-store`) no longer stand for `private` or `no-store`, and neither does a first
    line with a byte outside ASCII (it stood for `private`). A personal answer (it sets a cookie,
    read a caller, has the CSP nonce, or is a `Cache` answer to a request with credentials) with
    only those is sent `private, no-cache`, or `no-store` if any reader could find one in its
    header. A plain `no-store` or `private` is trusted as written only on one line of plain text
    with no quoted value, and a `private` only when no `no-store` (`no-store=1` too) sits beside
    `must-understand`; otherwise a `private` is not trusted, and a `no-store` is sent on one
    line (several joined, or `no-store` alone beside a quoted value or a byte that is not text),
    so a cache that reads only one line, or a value another way, is told the same.
    Measured with callgrind (release, in-process `oneshot`, the difference between 1,200 and 200
    requests over 1,000, median of three and the range of the nine pairs, against main at
    a83452c9): a `NoStore` failure as an HTML error page runs 31,683 instructions a request
    (31,680 to 31,691) against 30,857 (30,852 to 30,918), as it now keeps and reads the header; an
    unknown URL's 404 26,773 (26,588 to 26,804) against 26,773 (26,772 to 26,804); a `Public`
    answer, whose lines are now read in one pass through the lookup `settle` already made,
    23,726 (23,688 to 23,749) against 23,793 (23,759 to 23,804)
    ([#519 NoStore does not apply to a failure: the error page replaces its no-store with private, no-cache](https://github.com/todd-skelton/corten/issues/519)).
92. `bench/fullstack/parity.mjs` passes again: the thirteen other apps write the item page's counts
    as Corten's plural messages do since
    [#393 Catalogs have no plural rules, so apps pick a form with count == 1 and card-market shows "1 listings"](https://github.com/todd-skelton/corten/issues/393),
    digits grouped and the word singular for one (`2,866 listings`, `9,920 available`,
    `1 listing`), each with the number formatting its stack provides (`Intl.NumberFormat`,
    `intcomma`, `number_format`, `number_with_delimiter`, Thymeleaf's `formatInteger`, .NET's
    `N0`; Leptos and Phoenix group by hand). A negative count still differs (the apps write
    "-1 listings", Corten "-1 listing"); no page has one. Corten's page is unchanged. Checked with each app's image and `check-app.mjs` against card-market on the
    fixture: 16 pages, the JSON and the 404s pass for all thirteen (Laravel on a 15-item fixture,
    since PHP's default 128 MB limit does not hold the 508-item one, as its provider notes)
    ([#520 Benchmark parity fails for every app: card-market writes counts as 2,866 since plural messages, the other apps 2866](https://github.com/todd-skelton/corten/issues/520)).
93. A form's write redirected to another origin that its page's CSP `form-action` does not allow
    is a 500 that names the origin and `Policy::form_action` in a debug build, where it passed
    every test and the browser stopped it on the form's page with only a console error. It holds
    any redirect a handler answers to a form's `POST` from one of the app's pages, plain or
    `data-patch` (a `Location`, a sign-in redirect, a `corten-location`), to that page's policy,
    matched as CSP 3 matches a source after a redirect, with the page's `Origin` as `'self'`;
    the handler's other headers (a cookie) go out with the 500. A `GET`, a script's `fetch`,
    another site's post, a `Relay` answer, `Policy::report_only` and a redirect after the
    write's own are not checked, and a release build compiles none of it.
    Measured with callgrind (in-process `oneshot`, a POST that redirects to a path, the
    difference between 1,200 and 200 requests over 1,000, median of three and the range of the
    nine pairs, against main at f5c76a08, the branch at 7befb95d; the later commits change only
    the check of a redirect to another address, which the measured request does not reach): release 27,035 instructions a request on the branch
    (26,988 to 27,047) against 27,035 on main (26,944 to 27,072), none of the check compiled in;
    debug 217,283 on the branch (217,087 to 217,376) against 189,171 on main (189,119 to
    189,197), the headers kept for the check
    ([#527 A form's redirect to another origin that the app's form-action does not allow passes every test and is blocked in the browser](https://github.com/todd-skelton/corten/issues/527)).
94. An error in an expression in `html!` (an attribute's `{..}`, a child's, a prop's) labelled
    the whole `html!`: `row(2)` with `row` a local that shadows a function said "call expression
    requires function" across the macro, and a wrong prop type pointed at the macro too. The
    parentheses the macro puts around an expression now take the expression's span, so the label
    is on `row(2)`. Lints report there too, with a fix for the expression: `cargo clippy -D
    warnings` (and so `corten check`) may now flag code in `html!` it reported at the macro or
    skipped (`manual_unwrap_or_default`, `redundant_pattern_matching`). The code `html!`
    generates is otherwise the same, and rendering costs the same (callgrind, item page: 92,390
    instructions a request on the branch, 92,381 to 92,438, against 92,338 on main, 91,474 to
    92,418)
    ([#555 An html! error from a local that shadows a function points at an unrelated file](https://github.com/todd-skelton/corten/issues/555)).
100. `corten-macros`' test that a large token group merges in linear time bounded the merge on the
    wall clock (under 2 s), so check 1 failed on a busy machine (2.15 s) with nothing wrong, and so
    could the script test of aliases written out once. Both now use the growth check the other
    script tests use (moved to a test module they share): under a second passes, slower is checked
    against the time at a quarter of the size. The merge test now merges into an empty group too,
    so a scan per key fails it whether it finds keys or adds them (measured on one machine: 32.0 s
    at 50,000 tokens against 1.7 s at 12,500, and 33.1 s against 1.9 s, 17 to 19 times where the
    bound is 10). The check's own tests run it on times they give, not ones they measure, so load
    cannot fail them either
    ([#593 corten-macros' dtcg merge test has a wall-clock bound (under 2 s) that fails when the machine is busy, as the script tests did before #495](https://github.com/todd-skelton/corten/issues/593)).

95. Two components with one name in two crates (a library's `Dialog` with a stylesheet and the
    app's) failed to link on Linux and linked on Windows (GNU), where the linker loads a library's
    object file only for a symbol it needs and so never saw the library's, and the page got the
    app's rules; a check passed on one machine and failed in CI. Each component's, event's and
    `script!` module's constant now points at a static beside the symbols that take its names, and
    an id's write does in a debug build, so a program that uses both namesakes (lists the
    component, or renders it or writes the id in a debug build, as every test is) fails to link on
    every platform, naming the symbol
    (`corten__two_components_style__dialog`); a namesake the program does not use may still fail,
    depending on what shares its object file. Each
    `Component` holds the static (`anchor`, hidden; the macros write it), which a hand-written
    one now needs too
    ([#570 The two_components_style guard passes on Windows for a library and an app component with one name, and fails only at Linux link](https://github.com/todd-skelton/corten/issues/570)).

96. `corten new --corten-path` given a checkout's root (a workspace, not the corten crate) wrote
    a dependency that does not build, and `corten ui add` could not find `corten-ui` beside it. A
    workspace root that has the corten crate now means that crate, read by `cargo metadata`, and a
    directory that is neither (or a corten crate in a directory not named `corten`, beside
    which `corten ui add` would not find corten-ui) is refused before anything is written
    ([#560 corten new --corten-path takes the repository root and writes a corten dependency that does not build](https://github.com/todd-skelton/corten/issues/560)).
97. A render that panicked (a handler's, which is caught and the thread renders on) left its
    thread noting the values, script modules and components of every later render outside a page
    (a patch, a live fragment) into lists it never gave back (the values' growing with each
    render); what was being noted is now put back when a render unwinds.
106. `corten ui diff` reported a copy as edited after `corten fmt` laid it out with the app's
    `rustfmt.toml`; it compares the copy with the kit's text laid out the same way (rustfmt with
    the app's settings and edition, then the markup), so only an edit is one
    ([#568 corten ui diff reports a kit copy as edited after corten fmt lays it out with the app's rustfmt.toml](https://github.com/todd-skelton/corten/issues/568)).

101. `Upload::next_file` passed over every part with an empty file name, so a file a client sent
    with bytes and no name was dropped without a word. Only a part with an empty name and no bytes
    (a file input left empty) is passed over now; one with bytes reaches the handler as a file whose
    `filename()` is empty. Telling the two apart reads only as far as the part's first bytes and
    copies nothing
    ([#587 Upload is built for HTML forms: a JSON route taking one file needs a dead form struct, gets HTML refusals, and cannot see an empty file input FormData keeps](https://github.com/todd-skelton/corten/issues/587)).
103. `Types::sync` compared the types file byte for byte, so a Windows checkout whose Git writes
    CRLF line endings (`core.autocrlf`, Git for Windows' default) failed the types test once,
    saying the Rust types had changed, and rewrote the file with LF, which Git shows as no change.
    Line endings no longer count
    ([#600 Types::sync fails once on every Windows checkout with core.autocrlf: a CRLF types file counts as out of date, is rewritten as LF, and git shows no change](https://github.com/todd-skelton/corten/issues/600)).
104. A look written as an element (`<Select>..</Select>`) failed with `no field named children` and
    `Render` not satisfied, and nothing said what to write instead. `Render`'s error now notes that
    a look is the class of the element it styles (`<select class={Select {}}>`), and Added 167
    has the migration from the kit's wrappers to its looks, Badge's tones included
    ([#598 A kit look written as an element fails with 'no field named children' and 'Select: Render is not satisfied', and nothing says to write class={Select {}}](https://github.com/todd-skelton/corten/issues/598)).
99. A listener test bounded a connection's close 120 ms past the header timeout on the wall
    clock, so a loaded machine failed it; its timeout is longer, the bound sits between one clock
    from the accept and a second one after the step, and the lower bound allows for the clock's
    tick and its thread running late. It now also checks that a head sent after a step is
    answered, which a timeout counted from before the accept would refuse
    ([#594 a_step_before_http_is_counted_and_timed_as_the_connection bounds the wall clock 20 ms past the expected close, so a loaded machine fails it](https://github.com/todd-skelton/corten/issues/594)).
105. The kit's text controls (input, select, textarea, combobox) and menu items showed no focus
    under forced colors: their ring is a box shadow, which forced colors does not paint, with
    `outline: none`. They now have a transparent outline, which forced colors paints
    ([#585 Kit text controls and menu items show no focus under forced colors: the focus ring is a box shadow with outline: none](https://github.com/todd-skelton/corten/issues/585)).
107. `corten ui add` in a workspace member whose `corten` comes from the workspace
    (`corten.workspace = true`, or `{ workspace = true }`) said the member had no corten line and
    left `corten-ui` to the app. It adds `corten-ui` from the workspace in the same form, and to
    `[workspace.dependencies]` beside the workspace's `corten`, from the same place, when it has
    none. The kit guide says how a kit in a library crate is shared: each app lists the components
    it renders, so it serves only their CSS
    ([#564 corten ui add does not handle corten from the workspace, so a kit shared by several apps is set up by hand](https://github.com/todd-skelton/corten/issues/564)).
108. A closed popover or `<dialog>` with a class that sets `display` (a kit card's `flex`) was
    drawn open on every load, as an author's `display` wins over the browser's rule that hides it,
    with no way to dismiss it. `components.css` now keeps both hidden while closed, as it keeps
    `[hidden]`, so any look can go on a popup; a `<dialog popover>` shows open however it is
    opened, and a closing `display` transition (`allow-discrete`) plays as it would without the
    rule. An app's own markup changes in two cases: a `@keyframes` animation of `display` on
    close is held at `none` (a `display` transition plays instead), and a closed dialog kept
    drawn to fade out needs the app's own `!important` rule with more weight than an attribute
    (`dialog.fading:not([open]) { display: block !important }`). card-market's item page's
    `components.css` is 135 bytes longer (6,820 to 6,955; 1,541 to 1,573 brotli-11, 1,776 to
    1,811 gzip-9)
    ([#615 A closed popover or dialog with a kit look is drawn open: components.css keeps [hidden] hidden over a look's display, but not :not(:popover-open) or dialog:not([open])](https://github.com/todd-skelton/corten/issues/615)).
120. The kit's `SortHeader` drew its arrow from scoped classes, so a script that sorts the rows in
    place, as its doc says, set `aria-sort` and left the arrow showing the server's order. The
    arrow is now drawn from the header's `aria-sort`, the one state both write
    ([#606 Kit SortHeader draws its arrow from scoped Up/Down classes, so the documented in-place sort updates aria-sort and leaves the arrow showing the old order](https://github.com/todd-skelton/corten/issues/606)).
121. Under forced colors (Windows' contrast themes) the kit's `Tabs` showed no selected tab, as
    the raised background is not painted there. The selected tab is now outlined inside its box.
102. `corten ui add` put a new module between the next module and the attributes above it (a
    `ui.rs` whose modules each carry `#[rustfmt::skip]`), so the attribute moved to the new module.
    It now goes before the next module's attributes and comments, and takes the attributes every
    module has when there are two or more (not a `#[path]`, which is each module's own). When the
    next module has an attribute over several lines, `add` does not lay out `ui.rs` and names the
    attribute and each `pub mod` and `COMPONENTS` entry to add by hand (only an entry it can see
    is missing; a list it cannot read, it says to check)
    ([#586 corten ui add puts a new module between the next module and its attribute in a ui.rs whose modules carry #[rustfmt::skip]](https://github.com/todd-skelton/corten/issues/586)).
122. `corten ui` gave advice from its own kit in an app that pins another corten, without saying so:
    `ui diff` called copies brought up to the pinned kit "changed in the kit since", and
    `ui add --force` would have put back the older components. `ui` prints the pin note `dev`,
    `fmt` and `check` print (for `ui diff`, that it compares with the command's kit), and `ui add`
    and `ui init` refuse while the command is not the pin's: they name the command to install, or
    what the app's `Cargo.toml` asks for to move to the command's corten. The note also says to
    check `corten --version` after the install, since a target directory another revision's
    install used can hand back that build; with `CARGO_TARGET_DIR` (or `CARGO_BUILD_TARGET_DIR`)
    set, its install line builds in a directory of its own under it (`--target-dir`)
    ([#622 cargo install of another corten-cli revision through a shared CARGO_TARGET_DIR installs the old build, and corten ui diff then advises --force from the old kit without noting the pin mismatch](https://github.com/todd-skelton/corten/issues/622)).
123. The kit's `Switch` drew any checkbox inside it as a switch, so one written without
    `role="switch"` looked like a switch while a screen reader announced a checkbox. Only a checkbox
    with the role is drawn as a switch now; one without it is left to the browser's own checkbox
    look, where the missing role is seen. The kit's `Checkbox` likewise leaves an input whose role
    is `switch` to the browser's own look. Both stylesheets' input rules weigh one attribute more
    (`.switch > input[role="switch"]`, `.checkbox > input:not([role="switch"])`), so an app rule
    that restyled their input needs that weight too. A missing role is now seen on the page, not
    yet refused when the app compiles, which the issue keeps open. Its other cases, a `Button` or
    `Input` wrapped around the wrong element, went with those becoming looks on the app's own element
    ([#558 Kit wrappers accept any children, so a Switch without role="switch" or a Button around a summary compiles and silently breaks](https://github.com/todd-skelton/corten/issues/558)).
124. `tokens!` let a later source's token replace a whole group of the same name (the kit's `card`
    color over a theme's `card` group of sizes), so `--card-padding` was gone and the app
    stopped at start naming only the stylesheet that read it. A group over a token, or a token over
    a group with tokens in it, in two sources or in a group and the group it `$extends`, now does
    not compile, and the error names the source that puts one over the other and the source it
    meets; the token goes in the group as its `$root`
    ([#654 tokens! lets a later set's token replace a whole group of the same name (the kit's card color drops a theme's card sizes) without a word](https://github.com/todd-skelton/corten/issues/654)).
125. Under forced colors (Windows' contrast themes) the kit's `Meter` drew its fill in the track's
    color in Firefox, so its value could not be seen (WebKit kept the theme's colors). It is now
    drawn as `Progress` is there: the fill in `Highlight` on a `Canvas` track outlined in
    `CanvasText`. No system color means good or bad, so every state is drawn alike there (as
    Chromium already drew them); an app whose state matters says it in words beside the meter. The
    gallery smoke checks the fill and the track differ under forced colors in each state
    ([#639 Kit Meter shows no fill under forced colors in Firefox, so its value cannot be seen in a contrast theme](https://github.com/todd-skelton/corten/issues/639)).
126. A wide table in a part corten-ui's `ShownFor` wraps (a bare `<div>`), inside a kit card's
    content, grew the card's grid track to the table's width, so on a phone the table did not
    scroll and the whole page did (in Chromium at 390px: the table 1,015px, the page 1,035px).
    The kit's grids that hold the app's content, `CardContent` and an open `Dialog`, now have
    one `minmax(0, 1fr)` column, so any wrapper in them shrinks with them and the table scrolls
    inside the card (350px). A grid of the app's own that holds such a part takes the same track;
    the gallery's smoke checks the case at a phone's width. In turn a card no longer keeps its
    content's minimum width where something squeezes it (a row that does not wrap, a table cell):
    there its buttons wrap and a long word runs past its edge, so such a row wraps (`Cluster`)
    or gives the card a `min-width`. `Alert`, which sits beside a button in a row more often
    than it holds a table, keeps its content's width
    ([#661 ShownFor wraps its part in a bare div, so a kit Table inside it in a card or any grid stops scrolling and widens the page on a phone](https://github.com/todd-skelton/corten/issues/661)).
127. corten-ui's `RelativeTime` redrew every relative time on the page at each tick, though only
    the ones due could have new text, so one time counting seconds redrew a whole list of
    days-old ones every second. Its timer now keeps the times in a heap by when each one's text
    next changes, and a tick redraws only those due; a page coming back (from sleep, a hidden tab
    or the back/forward cache) still redraws them all, as its clock may have jumped, and so does a
    timer that comes well before its time, as the clock was set back. In headless Chromium, one
    time counting seconds and the rest days old, the median tick went from 0.9, 3.1 and 12.6 ms
    to 0.2 ms with 100, 1,000 and 5,000 times on the page
    ([#665 RelativeTime redraws every relative time on the page at each tick, so one time counting seconds costs 13 ms a second with 5,000 on the page](https://github.com/todd-skelton/corten/issues/665)).
128. The kit's `NavBar` drew its name, links, current link's underline and focus rings in the
    page's `--foreground`, `--muted-foreground`, `--primary` and `--ring`, so a bar recolored as its
    doc said, by `--card` and `--card-foreground`, kept the page's text on it: on a blue bar the
    links were 1.26:1 and the current page's mark 1.25:1. Every part is now drawn from the bar's
    pair: the name and links in `--card-foreground` (a link hovered is underlined faintly, the
    current one in full), and the focus rings and edge shadows from it. The doc says that a
    `Ghost` or `Outline` button among the actions takes a class of the app's for the bar's colors,
    and that a menu in the header is drawn in `--popover`. In the light theme the section links
    are now the foreground color, where they were the muted one
    ([#672 Kit NavBar's recolor note sets --card and --card-foreground, but its name, links, current mark and focus ring are drawn in --foreground, --muted-foreground, --primary and --ring, so a brand-colored bar has 1.3:1 links and no visible current page](https://github.com/todd-skelton/corten/issues/672)).
129. On a phone the kit's `NavBar` kept its name, links and actions on one row, so a two-word
    name and one action left the links a 104px strip with one link in view. At 40rem and narrower
    the links now take a row of their own under the name and the actions, the bar's width, still
    scrolling sideways when wider; the bar is about 44px taller there. The keyboard still reaches
    the links before the actions drawn above them. The links' row is positioned, so an icon link's
    hidden text scrolls with it instead of widening the page. There, the name keeps room above it
    for its focus ring, which reached past the top of the page, and a row a browser tabs to
    (Firefox) is ringed inside it in the bar's color. Measured, the changes together: `nav_bar.css`
    with comments out, whitespace collapsed and the spaces around `{};:,>` dropped, before its
    classes are scoped, grows from 1,806 to 2,209 bytes (gzip 653 to 730, brotli 538 to 601)
    ([#673 Kit NavBar keeps name, links and actions on one row on a phone, so an app with a two-word name and one action shows 1 of its 10 links in a 104px strip](https://github.com/todd-skelton/corten/issues/673)).
130. `corten-cluster` held the lock every request takes to find its feed while it built a feed
    from its rows, backfilled its replay log and applied the patches that came during the load,
    and while it applied each patch from JetStream, so loading a large feed (on first use, after
    an idle unload or a gap) held up every request on the instance, for every other feed, and
    blocked the worker threads they ran on. The lock is now held only to find, add or change a
    feed's slot. A load runs as its own task, so it finishes for the requests waiting on it even
    if the one that started it goes away; it builds and backfills the feed on a blocking thread,
    and drains its buffer until it is empty under the lock, so patches are still applied in the
    order they came. A patch is parsed and applied outside the lock, and a gap reloads the feed the
    patch did not fit, not one that has replaced it meanwhile. `Feed::reset` builds the new rows
    before it takes the feed's own lock and frees the old ones after, and the rows of a feed that
    is unloaded, deleted or replaced are freed on a blocking thread. A feed of another generation
    is reset after its successor is in its slot. A load that does not finish no longer leaves its
    feed loading forever: a reload whose rows could not be read goes back to the feed it had and
    tries again shortly; one whose build panicked sends that feed's clients to resync and, like a
    first load that did not finish, leaves the next request to load the feed again (and get the
    error, if it panics again).
    Measured in release on Docker Desktop with 8 cores
    (`finding_a_feed_while_a_large_one_loads`: a feed of 1,000,000 rows loaded and then reloaded
    five times a run, two runs per build, alternating), the slowest request for another, already
    loaded feed took, at the median of ten (range in brackets):

    | Runtime | During the load | During the reload | Nothing loading |
    |---|---|---|---|
    | 8 workers | 46 ms (20 to 65), was 484 ms (265 to 1,025) | 44 ms (25 to 134), was 648 ms (388 to 985) | 16 ms (4 to 62) |
    | 1 worker | 162 ms (64 to 517), was 593 ms (399 to 899) | 599 ms (133 to 1,110), was 1,155 ms (814 to 2,809) | 16 ms (9 to 37) |

    On one worker, reading and decoding the rows (the app's `Source::rows`) still runs on that
    worker, as a request's own work does, so a load there still holds up other requests while it
    reads them; why a reload holds them up longer than a first load there was not measured
    ([#652 corten-cluster's Hub holds its one mutex while loading feeds and applying patches, so a large feed's load stalls every request on the instance](https://github.com/todd-skelton/corten/issues/652)).
131. Two costs in the runtime that grew with the square of a page's rows. `rows()` dropped its
    map of rows by key after each change it made, so finding the next row by key read every row
    again: removing every other row of 4,000 one at a time by key took 2,020 to 2,215 ms, and now
    takes 13.8 to 14.4 ms (1,000 rows: 64.8 to 68.7 ms, now 3.3; 10,000 rows now 39.8 to 40.1).
    The map is kept through `push` and `remove` and made again after `replace`, `clear`, a
    change made elsewhere, or a `data-key` a script sets on a row, read at once or after an await
    (watched only while there is a map);
    `replace` costs what it did (4,000 rows: 9.7 to 9.8 ms, now 9.7 to 10.0). A patch looked up
    the new markup's counterpart of every `<details>`, `<dialog>` and popover before checking the
    user had changed it, and of every submit key, each a query of the new markup: a patch of
    1,000 rows with a details and a popover menu each took 214 to 234 ms, and now 58 to 60 ms (a
    form with a submit key on each row: 276 to 281 ms, now 60 to 62; plain rows 24 to 27 ms, as
    before). It now looks up only what the user opened, and finds elements by id from one map of
    the new markup per patch. Measured in headless Chromium (Playwright 1.64.1) with
    `bench/browser/rows-cost.mjs` and `patch-cost.mjs`, medians of 15 and 9, two to four runs
    each. The minified runtime grows by 227 bytes (33,095 to 33,322; 107 gzipped) and `rows()`
    with the view helpers by 417 (3,247 to 3,664; 190 gzipped). `scripts/smoke.mjs` patches a
    table with a menu on each row and the seller-desk smoke removes rows by key
    ([#648 rows() drops its key map on every change it makes, so removing rows by key is quadratic: half of 4,000 rows takes 2.6 s](https://github.com/todd-skelton/corten/issues/648),
    [#649 A patch looks up the counterpart of every details, dialog and popover before checking the user changed it, so a 1,000-row table with a menu per row takes 584 ms to patch](https://github.com/todd-skelton/corten/issues/649)).
133. The kit's `Table` wrapper is positioned (`position: relative`), so what a cell places
    absolutely, an icon button's hidden text (`VisuallyHidden`), stays inside the box that scrolls
    the table. Before, such text in a cell scrolled out of view sat past the page's edge and widened
    the page on a phone (661px at 390, with the kit's CSS alone). Minified, `table.css` grows from
    1,547 to 1,565 bytes (gzip 661 to 670, brotli 521 to 525)
    ([#674 Kit Table's scroll wrapper is not positioned, so an icon button's hidden text in a scrolled-off cell widens the page on a phone (661px at 390 with kit CSS alone)](https://github.com/todd-skelton/corten/issues/674)).
134. Since the kit's controls stopped taking `width: 100%` (Changed 115), an input in a `Field`
    sized the field's one grid column to its natural width (about 11rem), so in a page's column
    narrower than that it ran past the field and under the next one (measured in an app: 19 inputs
    at 1280px, each 22px past a 151px field). The field's column is now `minmax(0, 1fr)`, no wider
    than the field, so a corten-ui `ComboBox` in it shrinks with it too, its select as well before
    its script runs (outside a `Field` it keeps its 12rem). A `Stepper` keeps its width, its
    buttons a full target, so in a column narrower than it (about 9rem, 10.5 with a unit) it still
    runs past. The cost: in a box sized to its smallest content (a table squeezed below its
    content, `width: min-content`) a `Field` asks for no width and is as narrow as the column
    leaves it, where before it kept its control's width; a box with room (a dialog, an absolutely
    placed box) is as wide as the control asks, as before. Give such a column a width, or the
    control a `ControlWidth`. Measured with comments out, whitespace collapsed and the spaces
    around `{};:,>` dropped: `field.css` 641 to 766 bytes (gzip 329 to 362, brotli 263 to 299).
    `corten ui add field --merge` takes it
    ([#686 Kit Field's grid has no column template, so since #679 an input takes its natural width and runs past a field narrower than about 174px (19 inputs overlap their neighbors at 1280 in the port)](https://github.com/todd-skelton/corten/issues/686)).
132. `corten-macros`' growth check (a case that takes over a second must take about four times as
    long at four times the size) could fail a linear case on a busy machine: its only two runs at
    the larger size were the cold first run (which also decides whether to check at all) and one
    more, so slowing both failed it. A check that would fail now runs one more pair first, still
    counting every earlier run, and names every run's time in its message; a passing check still
    runs four times. The sizes now alternate (whole, quarter, whole, quarter), so a burst of load
    must last through a whole run to slow both quarter runs and let a quadratic case pass. Tests
    give it a linear case whose two larger runs are slowed fourfold, which it passes, and a
    quadratic one whose second and third runs are, which it fails
    ([#667 corten-macros' growth check failed once under load: a linear case's larger runs were slowed more than its smaller ones](https://github.com/todd-skelton/corten/issues/667)).
135. A page a `data-patch` write redirected to that reads itself again (`ReadAgain`, while the
    write's read catches up) read only `<main>` again, so what its layout could not read yet (a
    cart count) stayed missing with JavaScript and was right without it: each read again of a
    write's page is now whole, as the write's was, and draws what changed around `<main>`, until
    a read no longer asks. One that changes nothing in the page leaves it as it is, with what the
    user typed, and draws only what changed around it; both are now compared as the runtime
    rebuilds them, so a layout whose `<head>` does not put `<title>` first no longer has every
    read again swapped in. Other pages read again still read `<main>` alone. On a page the
    runtime swapped in, a notice the page drew (`req.notice()`) is sent back with each read again
    (`corten-notice` on the request, with the page's path, read only from a `GET` for that path
    not from another site, so a read the server redirects elsewhere does not carry it there), and
    `req.notice()` answers it, so the read draws the page as it was: the notice no longer goes,
    with what the user typed, on the first read, and a layout toaster showing it is not emptied.
    Such an answer adds `corten-notice` to its `Vary`. A read again costs a whole document
    while a write's page is behind; a page `GET` looks up one header more, measured 22,504 to
    22,666 instructions per document `GET` and 22,042 to 22,218 per navigation (callgrind,
    release build, 1,200 less 200 requests over 1,000, 3 runs each). The minified runtime grows
    from 33,322 to 33,620 bytes (gzip 11,911 to 12,030, brotli 10,795 to 10,909)
    ([#641 A page that reads itself again after a write drops the write's notice and what the user typed on its first read](https://github.com/todd-skelton/corten/issues/641),
    [#680 A page read again after a write's page is swapped in whenever the layout's head does not put <title> first, dropping what the user typed](https://github.com/todd-skelton/corten/issues/680),
    [#690 A page read again (ReadAgain) after a write's page swaps only <main>, so a layout value that page could not read yet (a cart count while the write lands) stays missing with JavaScript and is right without it](https://github.com/todd-skelton/corten/issues/690)).
137. Two components, ids, scripts or events with one name in two crates (a library's and the
    app's) linked in a release build with thin LTO, the workspace's own profile, so one's
    stylesheet or script was served for both: thin LTO resolved the two guard statics of one
    name to one before the linker saw them. Each guard name is now also a symbol defined in
    assembly (`global_asm!`), which reaches the linker as written, so the pair fails to link in
    every profile (debug, release, thin or fat LTO); under LTO a namesake in a crate the program
    links but never uses fails too. The static stays beside it, so two namesakes in one crate still
    fail to compile. `global_asm!` is stable on x86, Arm, RISC-V, LoongArch and s390x; on other
    targets a release build with LTO still links a pair. `link_clash` builds the release case
    without LTO, with thin and with fat, and a library with two namesakes, which fails to compile
    ([#636 Two namesake components in two crates link in a release build with thin LTO, so the link-time name check misses there](https://github.com/todd-skelton/corten/issues/636)).
136. `examples/card-market`'s `alerts.create` tool set an alert on an item with no listings, which
    the form and the partners' JSON route refuse: it checked the fields but not the item. The three
    now share one function, `set_alert` in `model.rs`, called after loading the item: the fields'
    rules, the item's, then the message, which every surface now takes from the loaded item rather
    than the form's posted title. An agent gets the form's message, and a missing item is refused
    before its fields are read on every surface (the partner route checked the fields first); the
    requests-and-forms guide's JSON example follows it
    ([#691 card-market's alerts.create tool sets an alert on an item with no listings, which the form and the partner route refuse](https://github.com/todd-skelton/corten/issues/691)).
138. Three ui-gallery smoke checks that failed now and then on a loaded machine wait for what they
    check. The menu's dialog check read focus when `open` turned false, a task before the
    `close` event on which the menu gives focus back (WebKit); it now reads focus in the task after
    `close`. Press and hold waited a fixed 700 ms and counted the repeats the machine had run by
    then; it now holds until the value has repeated (at most 10 s). A press released off its
    button was sent as two mouse events, which in one stalled run arrived about 6 s apart, a hold
    that repeats (Firefox's 10.3 for 0.9); the press and release are now dispatched by script in
    one task, as the next check's already are, so the browser's own "no click after a release
    elsewhere" is no longer tested with real input there. Not fixed: on a loaded Windows
    machine about one full three-engine run in three still stops on a page that makes no progress
    for 30 s (a `load` that never comes, a click waiting for its button to be stable, an action
    that never returns), with nothing outstanding or the document's own request unanswered, while
    the server answers the same requests in under 210 ms and each step passes 25 times out of 25
    alone; and WebKit's two Progress checks under reduced motion now and then read the style
    without it. Those checks now say whether the page saw the emulated preference
    ([#666 ui-gallery smoke: the WebKit dialog focus check (and once a Firefox NumberField step) fail intermittently under load](https://github.com/todd-skelton/corten/issues/666);
    what is left is
    [#712 ui-gallery smoke: on a loaded Windows machine a page stops making progress for 30 s about one full run in three, with the server answering in under 210 ms](https://github.com/todd-skelton/corten/issues/712)).
139. Two ids, components with a stylesheet or script, views or typed events with one name in one
    crate passed `cargo check` and failed only in a build, where the error named one of the two
    sites and a mangled symbol, so finding the other meant searching every type with that kebab
    name. Each such name is now also a hidden exported macro, which goes to the crate's root, so
    the pair is E0428 ("the name `corten__two_ids_are__seller_form` is defined multiple times") in
    `cargo check` and an editor, pointing at both `#[derive]`s or `#[component]`s. Two crates'
    namesakes still fail at link, as before. The same-crate `compile_fail` examples now require
    E0428
    ([#696 Two #[derive(Id)] types with one name pass cargo check and fail only at link, and the linker names one site and a mangled symbol, so finding the other means grepping every type with that kebab name](https://github.com/todd-skelton/corten/issues/696)).
140. A caller type that is a rule over another (its `identify` reads the other with
    `Caller::find`) put its own type in the page's key, so pages for one signed-in person behind
    different rules (`Caller<Staff<Intake>>`, `Caller<Staff<Returns>>`) had different keys and every
    navigation between them loaded the document in full after throwing the navigation's answer
    away. The key now takes each caller's value without its type, each distinct value once: a rule
    that holds only the caller it is over (`Seller(Viewer)`, `Staff<R>(Viewer, PhantomData<R>)`)
    hashes as that caller does, so such pages share the key and swap `<main>`. Another person,
    signing in or out, data a rule holds of its own (an org, a role) and which rules refused (a
    refusal is keyed by its type, so a layout that reads rules as `Option`s to draw a link per
    permission is keyed by which passed) still change it. Two caller types whose values hash
    alike (`Viewer(5)` and a `Tenant(5)`) now key alike too, so such a type hashes a tag of its
    own as well. Measured with callgrind, instructions per navigation over 1,000 (release
    build, 3 runs each, from `094f72d7`): a `Caller<Viewer>` page 25,832 to 26,083 before, 25,679
    to 25,851 after; a page behind a rule over it 28,289 to 28,635, then 28,144 to 28,178
    ([#709 A caller type that is a rule over another (Caller::find) puts its own type in the shell key, so pages for the same person behind different rules navigate by full load](https://github.com/todd-skelton/corten/issues/709)).
141. A typed route whose path starts with a parameter (`/{*rest}`, `/{user}/posts`) wrote
    `//evil.example/x` for a value that begins with `/` (or `//posts` for an empty one), which a
    browser reads as another site, so `req.redirect`, `redirect_with_notice` and `href={route}` to
    it could leave the site. The link now writes that second `/` as `%2F` (`/%2Fevil.example/x`),
    which a catch-all reads back as the same value, and a route path that itself starts with `//`
    does not compile, for a hand-written `Route` in an area or an API too. `redirect_with_notice`
    and `resend_to` refuse an address that is not a path on this site as a browser reads it (one
    `/` first, no `\` or control character), which only a hand-written `write_href` can still
    write. Only a
    route whose path starts with a parameter pays, one check per link. Measured with callgrind,
    release build, 3 runs each, from `7e4bcab7`: instructions per `write_href` into a reused
    `String` (11,000 less 1,000 calls, the three routes in one binary), `/items/{id}/offers` 141
    before and after, `/{*rest}` 135 to 142, `/{user}/posts` 112 to 119; per form `POST` answered
    with `redirect_with_notice` (1,200 less 200 requests), 32,724 to 32,745 before, 32,667 to
    33,020 after, no difference visible above run-to-run variation
    ([#727 A route that starts with a catch-all writes //host/.. for a value beginning with /, so OnSite (redirect_with_notice, resend_to) can leave the site](https://github.com/todd-skelton/corten/issues/727)).
142. Kit `Table` stacked on a phone (`TableLayout::Stack`): a `TableNumeric` cell's label started
    at the end of the label column (80 px into it in ui-gallery's orders at 390 px, measured), out
    of line with every other cell's, since `.numeric`'s `text-align: end` outweighed the stacked
    layout's rule. The stacked layout now sets a number's cell to the start at `.numeric`'s own
    weight, so a class an app's component stylesheet linked after the kit's sets on the cell still
    wins; a copied `table.css` takes it with `corten ui add table --merge`
    ([#748 Kit Table Stack: a TableNumeric cell keeps text-align end on a phone, so its CellLabel sits at the end of the label column, out of line with every other label](https://github.com/todd-skelton/corten/issues/748)).
143. The kit's `TableLayout::Stack` stretched every element after a `CellLabel` across the
    value column on a phone, so a `Button` (an Open link 55 px wide drew 164 px at 390 px) or an app's
    pill read as a bar. Each element after a label now takes its content's width (`justify-self: start`),
    no wider than the column in either box model, so a long word still breaks inside the cell;
    text still wraps. A block the app wants across the column sets `width: 100%`. A tooltip,
    popover or dialog in the cell, and every cell with no label, are drawn as before.
    Checked in Chromium, Firefox and WebKit. ui-gallery's `components.css`, measured against main `4a32139a`: 53,430 to 53,677 bytes
    (gzip 9,002 to 9,058, brotli 7,945 to 7,992)
    ([#765 Kit Table Stack: every element after a CellLabel stretches to the value column's width, so a Button or a status pill becomes a full-width bar on a phone](https://github.com/todd-skelton/corten/issues/765)).
144. Since pages required Trusted Types, a script could not load a third-party SDK from an origin
    its `script_src` allowed (`script.src = "https://js.stripe.com/.."` threw), nor could the SDK
    load its own parts, and every server-side check still passed. A page whose `script_src` names
    another host now allows a `default` Trusted Types policy, made by a script at `<Corten />`
    (allowed by its hash) before any script after it runs, which passes an http or https URL on
    another origin and nothing else (no URL on the page's origin, no markup, no script text);
    `script-src` still holds the load to the sources listed. A script before `<Corten />` that
    makes `default` itself is named in the console. A source that names no host (a keyword, a
    scheme alone) or `'strict-dynamic'` makes no policy. An app that allows `default` by name
    keeps its own, and its pages have another shell key from those `<Corten />` makes it on. Such
    a page is 381 bytes larger (the script) and its CSP 62 (the script's hash and `default`),
    measured on the watchlist; every other page and the runtime are unchanged
    ([#768 Trusted Types: a script cannot load a third-party SDK from an origin its area's script_src allows without writing its own default policy, and the SDK's own loads fail the same way](https://github.com/todd-skelton/corten/issues/768)).
145. The kit's `TableLayout::Stack` gave a row header (`<th scope="row">`) a column header's
    2.5rem height on a phone, so a stacked row whose first cell is a row header began with a line
    taller than its others (38 px against a text cell's 27 px in ui-gallery at 390 px), and one
    whose name wrapped was drawn over the next line (77 px of text in a 38 px box). A stacked row
    header is now as tall as its content, as a cell is (`height: auto`), as the kit's comment
    says. Checked in Chromium, Firefox and WebKit. ui-gallery's `components.css`, measured against
    main `9fbe649b`: 53,677 to 53,689 bytes (gzip 9,058 to 9,063, brotli 7,992 to 7,995)
    ([#777 Kit Table Stack: a row header (th scope=row) keeps the header's 2.5rem height on a phone, so a stacked row's first line is taller than its others](https://github.com/todd-skelton/corten/issues/777)).
146. The kit's segmented choices and tabs space an `Icon` (or any element) beside their text by the
    kit's .5rem gap, as `Button` does, where it touched the text; a choice with text alone is
    unchanged. The ui-gallery shows an icon in a tab and in a `SegmentedRadio`, and its smoke checks
    each is the gap apart and on the text's middle
    ([#793 Kit Segmented and Tabs choices set no gap, so an Icon beside a choice's label touches the text where Button, Badge and menu items space it](https://github.com/todd-skelton/corten/issues/793)).
148. A kit `Table` scrolls in its own box wherever it is placed: its wrapper is one column no
    wider than itself, so the table's width is no longer the least width of the grid track, flex
    row, card or content-sized box around it. A `CardPanel` holding a table of eight unwrapped
    cells in an app's grid, at a 390px viewport, was a 1236px panel in a 1256px page; it is now a
    350px panel in a 390px page, the same in Chromium, WebKit and Firefox, and in a flex row, an
    inline-block, a grid with `justify-items: start` and a `<div>` between the grid and the panel.
    A table narrower than its box and a card's other content (a row of buttons) are laid out as
    before. Beside other content in a flex row or `1fr` or `auto` columns, a wide table now takes
    its share and scrolls where it took its whole width (the guide's `minmax(0, 1fr)` advice gave
    the same); an `auto` column beside a `1fr` one keeps it whole. The `<table>` is at least as
    wide as its cells, so WebKit draws its caption and borders across them. The ui-gallery smoke
    checks a panel in a grid, a flex row, a `<div>` in a grid and an inline-block
    ([#796 Kit Table scrolls only while every grid or flex ancestor lets it shrink, so a CardPanel holding one in an app's grid widens the page on a phone](https://github.com/todd-skelton/corten/issues/796)).

147. `<corten-live>`, feeds and `corten::event_stream` answer `X-Accel-Buffering: no`, so nginx passes
    their events on as the app writes them. Behind nginx's default proxy (HTTP/1.0 to the app,
    buffering on), or with `gzip on` for `text/event-stream`, `/live/trades` sent no byte in 25 seconds;
    with the header, events arrive 1,000 ms apart in every case (measured, nginx 1.27)
    ([#785 No guide says how to deploy behind a proxy or CDN, and whether live streams arrive on time through nginx's default buffering is unchecked](https://github.com/todd-skelton/corten/issues/785)).
149. A file the handler passes over is read past and does not count toward `Upload::limit`, and one
    over its own `bytes_up_to(max)` needs room for that `max` as it goes over and then counts
    nothing, however the network split the body: the limit now bounds what the request keeps, so the
    form can say why. Before, a photo far enough over its 10 MB limit (or a large one of the wrong
    type) met the body's limit first and got the bare 413 error page. A body is still read no
    further than 64 MiB past its limit, what is read past included: a body more than that past it is
    `UploadError::TooLarge` and the connection is closed. What is read past is now searched for the
    next part, as a file the handler reads is, with `memchr`'s substring search (already in axum's
    tree), much faster than the byte-by-byte search before on bytes the client picks: 8 MiB in 16
    KiB pieces took 2.2 ms of plain bytes against 6.8 to 7.2, and 2.7 to 2.9 ms of `\r` against 51
    to 56 (release, medians of 11, three alternated rounds). A part's headers that arrive in many
    pieces are searched once, not from their start at each piece, and a piece under 1 KiB is joined
    to what is held in room that is reused: in 1-byte pieces 250 heads of 8,000 bytes took 1,972.7M
    instructions against 42,531M, and 1 MiB of `\r` 846.6M against 1,221.6M; plain bytes and short
    heads are within 0.5%, and in 16 KiB pieces 8 MiB of plain bytes took 122.2M against 160.2M, of
    the delimiter less its last byte 245.0M against 273.7M (callgrind, release, the same in two
    runs; design.md, Limits 22). `bytes_up_to` keeps a file's pieces of 1 KiB or more as they came
    and copies runs of smaller ones into one buffer, so a file sent in small pieces holds about its
    size, not a piece and its room for each: 8 MiB kept in 1-byte pieces peaked at 21.7 MiB against
    277.7 MiB (peak working set, release, two runs); a file under 64 KiB that came in one piece is
    copied out of it, so it does not hold the read buffer it was cut from. Headers past their 8 KiB
    limit are refused however the body is split (one large piece let them through)
    ([#803 An upload over its file limit gets the form's message, but one further over gets the bare 413 error page: the body limit meets it first and the guide's first example uses ?](https://github.com/corten-run/corten/issues/803)).
150. The watchlist smoke read a change cell's trend from the sign of its money, so a few cents' move
    whose percent rounds to 0.00% (`-$0.02 0.00%`, flat) failed at random; it reads the percent, which
    the trend follows. Test only ([#782 Watchlist smoke: 'today's change is a percent with its trend' reads the sign from the money, so a few cents' move that rounds to 0.00% fails at random](https://github.com/todd-skelton/corten/issues/782)).
151. `bench/fullstack`'s build step is tested: its loop (skip the apps built before a restart,
    start none past the budget and name the rest, skip one app whose build was stopped or exited
    with an error and ask for a clean slate) is `round.mjs`'s `buildStep`, which `run-all.mjs`
    calls with its effects and `round.test.mjs` drives with recorded ones. rustc's `total` is kept
    apart from its passes (`rustcPasses`), since the passes nest: card-market's in r14 summed to
    74.5 s against a total of 37.8 s, and `--timings` gave the crate 37.9 s, so on a droplet with
    nothing else running the diagnostic build and the clean build agree. The desktop's 76 s was
    such a sum, so its compile was about 38 s (estimated) and its clean build of the crate (151 s)
    the slow one, about four times as long, on a machine whose load was not recorded. The limits
    are set from r14: each call's at least twice its longest there (`run-ssr.mjs` 140 minutes
    and 150 for the JSON calls, which take the JSON-only apps too, from 120, for 69 to 72), and
    the build step's budget is 240 minutes, from 420 (r14's step took 44.5, Leptos's build 14.2
    of its 90, and the round 6.3 of its 21 hours)
    ([#775 bench/fullstack build step: run-all's loop is untested, Corten's diagnostic rustc build disagrees with --timings by 2x, and the build limits are estimates until r13](https://github.com/todd-skelton/corten/issues/775)).
152. Without JavaScript, the kit's `Stepper` no longer draws `NumberField`'s step buttons, which did
    nothing there: the input is the control, with its own spin buttons back (arrow keys, and
    `min`, `max` and `step` checked when the form is sent). The scripts guide gives the one way for an app's own control that only its
    script makes work, and its opposite: a rule under `@media (scripting: none)` or
    `(scripting: enabled)` in the component's stylesheet, so nothing moves as the script loads;
    corten-ui's docs say the design system hides the buttons and gives the input its own back. The
    rule adds 171 bytes to the gallery's served `components.css` (53,952 bytes with it). The
    ui-gallery smoke checks it in Chromium, Firefox and WebKit
    ([#799 A control only a script makes work is drawn without JavaScript and does nothing: NumberField's step buttons, and no convention for an app's own](https://github.com/todd-skelton/corten/issues/799)).
153. `/health/ready` drops the app's check (`App::ready`) when it has not answered in 800 ms and
    answers `unavailable`, inside Kubernetes' one-second probe timeout; `App::ready_within(d)`
    changes the limit, and one warning is logged until the check answers again. Before, a check
    that waited on a database that was down took the pool's own wait (30 seconds in sqlx), so
    Kubernetes, Docker and load balancers recorded a timeout instead of the answer. The app guide's
    new "Health" says to set the pool's `acquire_timeout` well under the deadline, since both
    default to 30 seconds and a database outage otherwise reads as the deadline on every page;
    listings-feed and card-market drop their own timeouts on the check, and listings-feed's pool
    waits 5 seconds for a connection. An app without a check is unchanged; with a check that
    answers at once a probe took 18,205 instructions against 18,237 to 18,276 before and 8.8 to
    9.5 µs on both builds (measured, callgrind and a release build in process)
    ([#800 With the database down every page waits the full 30 s deadline, and /health/ready waits 30 s too: sqlx's pool wait equals Corten's deadline and App::ready runs its check unbounded](https://github.com/todd-skelton/corten/issues/800)).
154. A smoke's retry of a navigation Chromium aborted with `net::ERR_NETWORK_CHANGED` waits
    for the error page Chromium loads in its place before it navigates again, so the retry is no longer
    interrupted by it (`Navigation ... is interrupted by another navigation to chrome-error://`). The
    watchlist smoke aborts a navigation once (a refused connection, which takes the same path) and
    checks the retry loads the page: 15 of 15 with the wait, 0 of 15 without it. A page already
    showing an error page from an earlier failure waits for the new one too. Test only, after
    [#497 Browser CI fails at random on net::ERR_NETWORK_CHANGED during a smoke navigation, blocking merges until a rerun](https://github.com/todd-skelton/corten/issues/497)
    ([#839 Smoke retry for net::ERR_NETWORK_CHANGED (#497) races Chromium's error page, so the retried goto is interrupted and the smoke still fails](https://github.com/todd-skelton/corten/issues/839)).

155. `bench/fullstack`'s instruction count watches only the app's pinned cores on a bench host
    (`perf stat -C` with `BENCH_APP_CPUS`, written to `count-kernel.txt`), where it watched every
    core (`-a`): the container runs nowhere else, so the count should be the same (the first
    round counted this way is compared with r14), with one cgroup counter instead of one on each
    core; the counters on the load generator's cores, switched at its every context switch, are
    a suspect. An app that cannot be counted is recorded as failed and the others are still
    counted, with `instructions.json` written after each app, where one failure lost the step's
    counts, and `perf` stops however a count ends. A round that starts again after its droplet
    restarted first saves the kernel's log of the boot that ended
    (`results/<round>/kernel-before-start-<n>.txt`) and says whether it shows a soft lockup, an RCU
    stall or a panic; a panic's own report rarely reaches it. Three rounds' droplets
    (r8, r12 and aot1) restarted as counting began; whether watching one core stops that is known
    only after rounds run with it, and the issue stays open until three count in a row
    ([#812 count.mjs restarts the bench droplet in some rounds (r8, r12, aot1), so those rounds have no instruction counts](https://github.com/todd-skelton/corten/issues/812)).
156. A form's or a query's integer field reads a whole number however a number input writes it
    (`3.0`, `1e1`, `-0`), where `3.0` was a 422 and the error page; `3.5` and text outside HTML's
    syntax for a number are still refused, and a float field no longer reads Rust's own `+5`, `5.`,
    `inf` or `NaN`. A path parameter still reads as written. Reading a form of a `u32` and a
    string (`qty=12&note=hi`) takes 1,831 instructions where it took 1,830 (callgrind, release,
    6,000 reads less 1,000, repeat runs within 60 in total); the same field as an `Entry` takes
    1,982, the text it keeps. A float field (`w=0.5&note=hi`) takes 1,901 where it took 1,848, the
    check of what Rust reads that HTML does not
    ([#842 A form's integer field refuses a whole number the browser sends as 3.0 or 1e1 with a 422, not the form and its message](https://github.com/todd-skelton/corten/issues/842)).
157. Shutdown waited for every connection still answering with no limit, so a client that had
    stopped reading held it until `App::send_timeout` closed the connection (with it `None`, for
    ever), and a long download as long as it took, past the platform's wait. A connection now has
    the longer of `App::shutdown_grace` and the longest deadline (the app's, an area's or an
    API's) from when shutdown began, the bound the guide already gave for the platform's wait;
    one still open then is closed, and their number logged. With the defaults that is the
    deadline's 30 seconds, still past `docker stop`'s 10 unless `stop_grace_period` is raised,
    as the guide says
    ([#858 Shutdown waits without limit for every connection still answering, so a client that stops reading holds it past docker stop's 10 s](https://github.com/todd-skelton/corten/issues/858)).
159. corten-macros' growth check (`a_large_group_merges_in_linear_time` and the script
    parser's cases) failed a linear case under load (3 of 12 runs with twice as many busy loops
    as cores, measured): it compared a quarter of the size with the whole, under ten times as
    long, and load slows a case's larger runs more (likely because they no longer fit in the
    caches): a probe read up to 8.5 times as long on a quiet machine and 11.8 under load. It now
    compares a sixteenth with the whole, under 64 times as long (16 is linear, 256 quadratic; at
    most 35.6 was measured under load), and on Linux times a case by the CPU time its thread
    spent (`/proc/thread-self/schedstat`), leaving out the time other processes held the cores,
    with the wall clock where that time does not advance; a test checks that running counts and
    a sleep does not. Under the same load it passed 12 of 12, and 12 of 12 with four times as
    many busy loops as cores
    ([#883 corten-macros' growth check still fails under load when every large run is slowed and one small run is not (a_large_group_merges_in_linear_time)](https://github.com/corten-run/corten/issues/883)).
160. `corten_ui::rows::sort` makes the address the page sorted as shown (`history.replaceState`)
    and each header's link the page its next click gives, when the header's link names both orders
    (the kit's `SortHeader`), taking from them only the query keys the header links differ in, so
    a tab's key and the fragment stay. A page that reads itself again (`ReadAgain`) now reads the
    address as it is then, not as it was when the page came in (so a `TabGroup`'s or a choice's
    key in it is read too), so it no longer swaps the server's
    order back over a sort in place every few seconds, and a reload shows the order on screen too.
    The read is stopped by a navigation to another history entry, as before by any change of
    address, put off while a navigation is on its way, and made again after its delay when a
    script's `replaceState` (a sort clicked as it reads) cancels it on its way. Tied rows sort in
    the order the page drew them, recorded on a body's first sort (a row a patch or a feed replaces
    keeps its place by its `id`), rather than as the last click left them, so clicks give the same
    order for ties however many came before: the server's, for a page drawn in the order it sorts
    from. A page drawn already sorted (a reload of a sorted address) breaks ties by that order, so the
    tie order is the server's only for a page loaded unsorted. The runtime grew 207 bytes minified (34,639 to
    34,846; 90 gzipped, zlib level 9), and `rows.js` from 2,059 to 3,415 bytes (1,004 to 1,556
    gzipped; `esbuild --minify --format=esm`, measured), on a page that uses it
    ([#865 A page that reads itself again (ReadAgain) undoes a rows::sort: the runtime swaps in the server's order every few seconds, since the in-place order is not in the address](https://github.com/corten-run/corten/issues/865), [#863 rows::sort leaves tied rows in the order the last click left them, so one header click orders ties one way with the script and another without it (or after a reload)](https://github.com/corten-run/corten/issues/863)).
161. The error page for a failure the request is at fault for (an unknown URL, a wrong method, a
    refusal other than a 429, a form that does not read) starts the layout's reads not
    started yet and waits for them, no later than the request's deadline, as a page does: before,
    it started none and drew only a value already in, so a 404 or a 403 lost the cart count every
    other page shows and an app read it again in its error page. A read it starts sees the head
    the error page's extractors see. A handler's `Error` at any status but 404, a 5xx, a 429
    and a cross-site write still start none and wait for none, and a read that panics as it
    starts draws nothing rather than failing the answer
    ([#877 An app's error page starts no layout read, so a 404 or a refusal loses the layout's value (a cart count) every other page shows](https://github.com/todd-skelton/corten/issues/877)).
162. A nav link the runtime marks current is put in the middle of the row that scrolls it (the
    kit's `NavBar` links wider than the bar) when it is out of that row's view: on a full load, when
    a client navigation makes another link current, and when a write's page or a patch draws the
    row again, but not in a row in `<main>` the user scrolled sideways (back to its start too)
    when a swap keeps the user's place. A hidden link moves nothing, a link wider than the row is
    put at the start of its content, and the row is scrolled at once, not smoothly. Before, the
    last links of a long row were drawn current out of sight (two of the port's ten pages on a
    1280 px window). A link that stays current is left where the user scrolled the row, and the
    page itself is never scrolled (a load at a fragment stays there); without scripts the row
    starts at its first link. The runtime grew 930 bytes minified (35,352 to 36,282; 388 gzipped,
    12,703 to 13,091 at zlib level 9, measured)
    ([#879 Kit NavBar leaves the current page's link out of view when its row scrolls, so on a 1280px window two of the port's ten pages show no current page](https://github.com/corten-run/corten/issues/879)).
163. Under forced colors (Windows High Contrast) the kit's `Switch`, `Checkbox` and `RadioGroup`
    looked the same on and off, since their state was only a background fill, which a contrast
    theme paints as the page's. A checked box and a switch that is on are now drawn in the system's
    selection colors (a switch's thumb in the text color when off), a chosen radio's dot in the
    selection color, and a disabled one in gray. `Pagination`'s current page is underlined, a
    `Slider`'s track is gray with its thumb in the button text color (Firefox also draws the part
    chosen; Chromium has no part for it), and a `StatusDot` is drawn in the system's text color,
    where it vanished. The look without forced colors is unchanged: the rules are only
    under the media query, and ui-gallery's component stylesheet, every kit piece, grew from 54,754
    to 57,089 bytes (9,149 to 9,372 gzipped, zlib level 9, measured). A `ui-gallery` smoke check
    reads each in Chromium's light and dark contrast palettes and Firefox's: the selection color
    on a checked control and not an unchecked one, gray on a disabled one, a focused checked one's
    ring in a system color, the current page's underline focused or not, the slider's track and
    the dot
    ([#891 Kit Switch, Checkbox and RadioGroup look the same on and off under forced colors: their state is only a background fill, which a contrast theme paints as Canvas](https://github.com/corten-run/corten/issues/891)).
165. The kit's `Button` kept its label on one line at a fixed height, so a long action label
    ran past its box and a 320 px page scrolled sideways (WCAG 1.4.10 reflow; the port's
    "Reprice all inventory using saved curves", 269 px in a 240 px card). A label wider than the
    room now wraps, centered, and the button grows taller (that label: 240 by 56 px, from 261 by
    36), between words, so a row that shrinks to its content keeps each word whole (a label that
    is one long token is broken only by Firefox; the guide gives the app's opt-in). One line
    keeps the size's height at any size a theme or density sets that holds a line (22 px and
    up): each size's block padding is what one line leaves of its token, so Md, Sm and Lg are
    36, 32 and 40 px by default, 28, 24 and 32 under a compact
    density's lower tokens, and 44 under touch-target ones. The sizes set `min-height` and
    `box-sizing: border-box`, so an `<a>` button is the height of a `<button>` (it was 2 px
    taller, its border outside the height), and an `Icon` button stays square. A button in an
    `InputGroup` stays inside the group's border under touch-target sizes (3 px in). Measured in
    Chromium. `button.css` grew from 2,396 to 3,081 bytes as written (762 to 1,047 gzipped, zlib
    level 9), `input_group.css` from 1,889 to 1,904 (821 to 826). The kit guide says how to keep
    a button on one line in a table or a row that shrinks to its content
    ([#892 Kit Button never wraps its label (white-space: nowrap, fixed height), so one long action label makes a 320px page scroll sideways and fail WCAG reflow](https://github.com/corten-run/corten/issues/892)).
166. Back or forward to a page the runtime swapped in drew it as the server does, so what the
    user had typed or chosen in it was gone, where the browser puts it back without the script
    (the port's search box on Back). The runtime now records, as it replaces a page, each field of
    `<main>` the user typed or chose in whose state is not the markup's, under the key of the
    history entry that page was drawn for (so a link that redirects, a link to a fragment of the
    page or a `pushState` before it, or a second link followed before the first page arrives,
    still records the page left under its own entry, and Back before a link's page arrives keeps
    the form), and gives it back to the page drawn again for that entry before it joins, into the
    field found there by id, else by name and place, only when the server draws that field as it
    did (its kind, value, state and a select's options). A value a script set in a field the
    user never typed in is not put back. As the browser does, never a password, a file, a field
    marked `autocomplete="off"` (or in a form so marked), a hidden input or a submit key. It is
    forgotten when the browser drops the entry. Only the fields typed in are read as a page is
    left, and found again with a query each, or one walk of the page's fields for more than 64:
    on a page of 3,000 fields, recording took 1.5 ms with one typed in, 4 ms with 20 and 14 to
    17 ms with 300, and putting them back on Back 0.4, 2.4 and 9 to 10 ms (Chromium, timed
    inside the runtime, 3 runs each, measured); a whole leave with 300 typed took a median
    118 ms from the click against 103 ms before (6 alternated runs; measured). The runtime grew
    2,171 bytes minified (36,310 to 38,481; 705 gzipped, 13,098 to 13,803 at zlib level 9,
    measured)
    ([#896 Back to a page the runtime swapped in drops what the user typed and had not sent, which the browser keeps when the script is off](https://github.com/corten-run/corten/issues/896)).
167. Once shutdown begins, a connection still answering has the longer of the grace and the
    deadline of the request it is answering, not the longest deadline anywhere in the app: one
    area with an hour's deadline (an import job) held a page whose client stopped reading for the
    hour, and made the guide's rule for the platform's wait one an operator could not follow. A
    request of that area in progress still has its hour. Only an app with an area or API whose
    deadline is not the app's keeps each request's. Measured with callgrind (release, requests
    over TCP to a plain route, the difference between 1,200 and 200 requests over 1,000, three
    runs each, median and range, against main at 521e8754): keep-alive, an app without such an
    area runs 35,235 instructions a request (35,231 to 35,236) against 35,242 (35,240 to 35,247),
    and one with an hour-long area 35,417 (35,417 to 35,419) against 35,367 (35,367 to 35,369),
    50 more (0.14%). With a connection a request a build's three runs spread by up to 596: with
    the area 42,985 (42,719 to 43,315) against 43,050 (42,590 to 43,128), overlapping; without
    it 42,618 (42,550 to 42,629) against 43,061 (42,892 to 43,433), lower on a path this changes
    for such an app only by an `Option` check, so read as that spread
    ([#887 Shutdown waits for every answering connection until the app's longest deadline, so one hour-long area makes a stalled page reader hold shutdown an hour and the guide's platform-wait rule unworkable](https://github.com/corten-run/corten/issues/887)).
169. A layout (a component that returns `impl Document`) with a script of its own
    (`#[component(js)]`, or `js = Owner`) did not build when its markup called a handler
    (`on:connect={js::f(signal)}`), or a class that is an expression (`class={if hot { Hot } else
    { Cold }}`): the parts a page draws (`Document::render_part`, which draws every full load, a
    client navigation's part and a data client's) were made without the script's `js` and the
    stylesheet's names in scope, and outside the root's scope, so a ref would have been written
    with its component's name. Each part is now drawn as the whole document is. A layout with a
    stylesheet is now noted where a page draws it, so in a debug build an area that does not list
    it in `App::components` (its stylesheet was not served) is an error, as it is for any
    component
    ([#906 A layout (-> impl Document) with #[component(js)] cannot use its own handlers: js:: is not in scope in render_part](https://github.com/corten-run/corten/issues/906)).

158. A script module that did not load (a request the network dropped: the page's script tag's,
    then the runtime's import, or the import alone) was never asked for again, so an `on:connect`
    handler (a feed's `subscribe`) never ran on that page. It is now asked for again once a wait is
    over that grows with each failure in a row (0.5 s, doubling, at most 30 s); `on:connect` waits
    for it while its element is on the page, another event asks for it, and the console says the
    module did not load rather than that its component is unlisted. 376 bytes on the runtime (135
    gzip, 124 brotli). Found looking into [#880 listings-feed smoke sometimes times out waiting for the feed's status to read live, so CI's browser job fails until re-run](https://github.com/corten-run/corten/issues/880)
    ([#893 A script module whose requests fail is never asked for again, so its on:connect handler (a feed's subscribe) never runs on that page](https://github.com/corten-run/corten/issues/893)).
168. `corten ui init` and `corten ui add` write a copy, `src/ui.rs` and the `App`'s line laid out
    as the app's code (rustfmt with the app's `rustfmt.toml`, then `corten fmt`'s markup layout),
    so `corten check` passes straight after them: a first copy, `--force`, a copy `--merge` finds
    unedited and `src/ui.rs`'s `COMPONENTS` were laid out with rustfmt's defaults, which
    `cargo fmt --check` refused in an app whose `rustfmt.toml` lays code out otherwise, such as
    Corten's own 130 columns. Only the three-way merge laid its result out. A file of the app's
    it had not laid out keeps its layout, with only the edit. The copies are laid out at once,
    rustfmt for each on as many threads as the machine runs. A file rustfmt cannot lay out
    (rustfmt missing) is written as it was, and the command names it in one line
    ([#900 corten ui add --merge writes an unedited kit copy in the kit's layout, not the app's, so corten check fails at cargo fmt](https://github.com/corten-run/corten/issues/900)).
170. A smoke's console listeners are not told of the error Chromium logs for a resource
    `net::ERR_NETWORK_CHANGED` aborted (`scripts/steady.mjs`'s `quiet`, on every page of a
    context `steady` opens): on a CI runner, where Docker changes the network interfaces mid-run,
    it failed a smoke's "no console errors" check though the app did nothing wrong, as the
    listings-feed step of job 127238209012 did. Only that exact text is left out, it is logged
    instead, and a check that needed the resource still fails on its own; what the runtime logs
    for a loss it recovers from is still seen. Test code only
    ([#904 A subresource Chromium aborts with net::ERR_NETWORK_CHANGED fails a smoke's no-console-errors check, which steady() does not cover](https://github.com/corten-run/corten/issues/904)).
171. `on:corten:error={..}` compiled and its handler never ran: the runtime read the type
    `data-on` printed as `corten`, an event nothing sends. Its parser now ends the type at the
    last `:` before the module (a `script/wire.json` case both sides are tested against), so
    `on:corten:error` and `on:document:corten:error` run, typed as a `CustomEvent` (its `detail`
    is not checked). `corten:notice` is dispatched on the document and now bubbles, so
    `on:document:corten:notice` hears it (a bubble-phase listener on `window` now hears it too);
    `on:corten:notice` on an element, which nothing could hear, and any other name with a colon
    do not compile, naming what to write (a component's own event is an `#[event]` type, another
    library's is heard by its script's listener). watchlist's watch form says when a change got no
    answer. 15 bytes on the minified runtime (1 gzip at level 9, 3 brotli), unchanged in the
    README's rounding; no request-path change
    ([#917 on:corten:error in html! compiles and its handler never runs: the runtime reads the event type as corten](https://github.com/corten-run/corten/issues/917)).
174. The kit's `Badge` kept its label on one line (`white-space: nowrap`), so a badge holding a long
    value (a key, a hash, an ID) was wider than its box and pushed a phone's page sideways (the
    pilot's 349 px badge in a 300 px column; a 64-character hash ran 80 to 84 px past its column and
    scrolled a 390 px page sideways 64 px in Chromium and WebKit, 60 px in Firefox). A badge is now
    a block of its text (`inline-block`, `max-width: 100%`, `box-sizing: border-box`,
    `overflow-wrap: break-word`) and never wider than its box: a label that fits the room it is
    given keeps one line, and a longer one wraps between words, and inside a word only when one is
    wider than the room, so that hash wraps inside its badge on a phone, in a row that wraps and in
    a block. Since a flex row's text is never narrower than its longest word, the badge is no longer
    `inline-flex`: a dot or an icon before its words (a `StatusDot`, an `Icon`) is spaced by a rule
    of its own, a quarter rem as before. An icon after the words now touches them, and a badge of a
    mark alone has a quarter rem more on its end side: either takes a class of the app's on the
    badge for its margin (the kit guide). As with `Button`, a badge in a table that shrinks its
    columns may put its words on lines of their own; the kit guide gives the app's class for one
    line and for cutting a value short with an ellipsis, and says a row that does not wrap is pushed
    out by a value with no break in it (use a `Cluster`). `badge.css` grew from 1,530 to 1,977 bytes
    as written (554 to 774 gzipped, zlib level 9), and its rules 79 bytes as the gallery serves them
    (1,287 to 1,366; 416 to 460 gzipped; measured)
    ([#926 Kit Badge never wraps and is as wide as its text, so a badge holding a long key overflows a phone-width page](https://github.com/corten-run/corten/issues/926)).

164. A part of a page that reads itself again from its own route (`ReadAgain::from`) came back
    in the server's order after `corten_ui::rows::sort` sorted a table in it, since its read's
    address was the one the server wrote. `rows::sort` now gives that address the query keys the
    header links differ in, as it does the page's; a part's answer that asks again puts its own
    tag in the old one's place, so a sort after the part's first read reaches the next one too;
    the runtime reads `data-from` when it sends the read rather than when it set it up; and an
    answer to a read whose `data-from` changed while it was on its way is dropped and the part
    read again. A part route that reads the sort as the page's does (one `#[route(query)]` set in
    both) and writes it into its next `ReadAgain::from` draws the part in the order on screen,
    except after a form's answer brings the part's read
    ([#907 A part whose next read a form's answer brings (ReadAgain::from in a patch) is read in the server's order after rows::sort](https://github.com/corten-run/corten/issues/907)). `rows.js` grew from
    3,415 to 3,857 bytes (1,556 to 1,720 gzipped; `esbuild --minify --format=esm`, zlib level 9,
    measured), on a page that uses it, and the runtime 130 bytes minified (35,222 to 35,352; 12,656
    to 12,703 gzipped, zlib level 9)
    ([#885 A page part read again from its route (ReadAgain::from) undoes a rows::sort inside it, since the part's URL is the one the server wrote](https://github.com/corten-run/corten/issues/885)).
172. A part of a page read again from its own route (`ReadAgain::from`) lost a `rows::sort` order
    once a form in it was sent: the form's answer was drawn from where it posted, which had no
    sort, and the next read its answer brought (`ReadAgain::from` in the patch) never entered the
    page, so a later sort could not reach it. `rows::sort` now puts the order where each form in
    the part posts (its `action`, or a submit button's `formaction`; a GET form's address is its
    fields and is left), and a form's answer that brings a read and puts an element with an id
    beside the part's tag takes that tag's place, as a part's own answer does. The runtime grew
    166 bytes minified (38,481 to 38,647; 41 gzipped, 13,803 to 13,844 at zlib level 9; measured),
    and rows.js as served (its comments stripped) about 933 bytes (6,241 to 7,174; 290 gzipped,
    2,297 to 2,587 at zlib level 9; measured: the head as its gallery serves it, the base by
    `comments::strip` and the served module lines). It covers a form inside the part; a form elsewhere on
    the page whose address carries the order is item 175
    ([#930 rows::sort's order is lost when a form outside the table's part posts the page's old order (the port's Refresh supply)](https://github.com/corten-run/corten/issues/930)).
    Checked in the ui-gallery smoke against a form whose answer asks again
    ([#907 A part whose next read a form's answer brings (ReadAgain::from in a patch) is read in the server's order after rows::sort](https://github.com/corten-run/corten/issues/907)).
173. A write another site sent to a page route, refused before the app gave the request its state,
    had its error page drawn with the default state, not the app's: a layout that names a static
    file (`req.asset(Static::STYLE_CSS)`) panicked in a debug build and drew an unversioned URL in
    a release one. The refused request now has the signal every other request has: the app's state,
    the visitor's zone under `client_zone`, and an end once the page is sent (`Abort::Responded`),
    where before work its error page started was never told to stop. Its layout is drawn without
    its reads, which are not started for a request refused before the app's code runs. Only a
    refused write does the new work
    ([#929 A cross-site write's error page is drawn without the app's state: a layout's req.asset panics in debug](https://github.com/corten-run/corten/issues/929)).
175. A form outside a sorted table's part whose route reads the table's order (a "Refresh" beside
    the table that redirects back to the page, the port's Refresh supply) still sent the order the
    page was drawn with after `rows::sort` sorted the table in place, so its answer undid the sort.
    Such a form now calls `corten_ui::ordered::send` from its own markup
    (`on:submit={ordered::send(event, target, [sorted(&SupplyId)])}`), and a link (a "Previous
    page") `ordered::link` (`on:connect={ordered::link(target, [sorted(&SupplyId)], signal)}`). The
    order on screen, read from the page's address, goes where it sends: a POST form's `action` or
    its submitter's `formaction`, and what a GET form sends (in every list of its fields made while
    it is sent, in place of `keep_query`'s hidden inputs), as it is sent; a link's `href` whenever
    it is about to be read (the pointer over it, before the runtime's hover prefetch, focus, a
    click, a middle click, its menu). Each adds the keys the header links differ in when the page
    was drawn in its default order and takes one out when the order on screen has none. A key a
    visible control sends, a form or link to another origin, and one without the call (a reset to
    the default order) are left. A form that posts inside the table's `ReadAgain` part is still rewritten by the
    sort itself; every other form, a GET form in the part included, makes the call. The tables are
    named by `corten::script::ElementId`s, made only from `#[derive(Id)]` types
    (`corten_ui::sorted(&SupplyId)`): a script parameter typed `ElementId` (or `ElementId[]`,
    declared in `corten`) takes no string, so a renamed table's id does not compile where it would
    have named nothing. A call rather than matching the form's keys: a route whose sort is an
    `Option` leaves it out of a default-order address, so key matching could not see that form, and
    it would catch the reset. It is a module of its own, so a page that only sorts a table loads
    nothing more (`rows.js` as served is 7,175 bytes, 7,174 on main: one comment line), and
    `ordered.js` as served is 3,391 bytes (1,282 gzipped at zlib level 9; measured), loaded on a page whose markup calls it. Checked in the
    ui-gallery smoke, with a link in the gallery's own markup
    ([#930 rows::sort's order is lost when a form outside the table's part posts the page's old order (the port's Refresh supply)](https://github.com/corten-run/corten/issues/930)).
176. corten-ui's `Toaster` said a failed submit (its `failed` text, for a `corten:error` no
    handler took) in the same box as a success notice, and nothing marked it, so a stylesheet could
    not draw it as a failure. The message element it puts in now has `data-failed` for that text
    and not for a notice or a patch's message, and the kit's `toasts.css` draws it as a soft
    destructive message (a tint of `--destructive` over `--popover`, its text at least 4.5:1 in
    both themes, which the kit's test checks; under forced colors it looks as a notice does, and
    its words say it failed), its close button in the same color. `toaster.js`
    grew 236 bytes as written (90 gzipped, zlib level 9) and `toasts.css` 591 (174 gzipped); as the
    gallery serves them, `toaster.js` grew 76 bytes (3,479 to 3,555; 29 gzipped, 1,261 to 1,290)
    and its `components.css` 434 (57,429 to 57,863; 71 gzipped, 9,464 to 9,535; measured against
    main `772f55d9`). Checked in the ui-gallery smoke. An action that reports its own failure still
    answers with a plain `Toast`, so it is drawn as a notice
    ([#936 An action that reports its own failure answers with a plain Toast, drawn like a success, and has no way to take the Toaster's failed look](https://github.com/corten-run/corten/issues/936))
    ([#932 The kit Toaster draws a failed submit in the same box as a success notice, and nothing marks it for a stylesheet](https://github.com/corten-run/corten/issues/932)).
177. A `data-patch` submit in a modal dialog that got no answer (`corten:error`) was said by the
    `Toaster` behind the dialog, which covers it and makes it inert, so it was neither seen nor
    read, and nothing in corten-ui said it in the dialog. `corten_ui::dialog::failed` is the
    dialog's handler for it (`on:corten:error={dialog::failed(event, target, said)}`): it shows
    the dialog's own text for it (`said`, drawn `hidden` inside a `role="alert"` region that
    stays rendered, the live-region pattern a screen reader announces; not tried with one),
    keeps the toaster quiet (`preventDefault()`), and hides
    it again on the next submit in the dialog or when the dialog closes. A dialog already closed
    when the failure comes leaves it to the toaster. The UI guide's and ui-gallery's rename dialog use it,
    checked in the gallery smoke. `dialog.js` as the gallery serves it grew 384 bytes (1,267 to 1,651;
    97 gzipped at zlib level 9, 617 to 714; measured), on a page with a dialog
    ([#916 A failed submit inside a modal dialog is said by the Toaster behind the dialog, where it cannot be seen](https://github.com/corten-run/corten/issues/916)).
178. The ui-gallery smoke's Stats phone check failed once in about 80 runs, in WebKit, reading the
    first card 42px above the second, which no settled layout gives. It now measures once the
    page has the new width and two frames have passed, and its output gives the width, the scroll
    and each card's box, since the cause is not known (340 resizes in WebKit never reproduced it).
    The table's checks at 600 and 390px and Steps' at 320px also wait for the new width, and each
    of these checks fails if the page was not at it. Test code only
    ([#939 ui-gallery smoke: the Stats phone-row check measures right after a viewport change and failed once in WebKit](https://github.com/corten-run/corten/issues/939)).
179. The kit's `Toasts` sat a fixed 1rem from the bottom, so on a phone layout with a fixed bottom
    bar every toast covered the bar. It now sits `--toasts-inset-bottom` above the bottom (a size
    token of the theme, 1rem; plus the home indicator's inset on a page with `viewport-fit=cover`),
    and a layout sets the token on `body` where its bar shows. A token rather than a `var()` with a
    fallback, as every size the kit reads is a theme token. An app that takes the new
    `toasts.css` (`corten ui add toasts --merge`) and whose theme predates the token declares it:
    `ui add` prints the line, and the app does not start until it is declared; one that keeps its
    copy is unaffected. `toasts.css` grew 431 bytes (1,905 to 2,336; 179 gzipped at zlib
    level 9, 810 to 989), 142 of its rules without comments (1,624 to 1,766; 41 gzipped); measured
    ([#946 The kit Toasts has a fixed 1rem inset, so on a phone layout with a fixed bottom bar every toast covers the bar, and nothing lets the app lift it](https://github.com/corten-run/corten/issues/946)).
180. deck-builder, listings-feed, seller-desk and ui-gallery draw a failure in their own layout
    (`App::error_page`), as the template, card-market, watchlist and auction-room do, so none of
    Corten's examples starts with the debug build's warning that an app with a stylesheet has no
    error page, and a failure keeps each example's design (and its way back, where it has one)
    ([#951 Four examples (deck-builder, listings-feed, seller-desk, ui-gallery) have a layout and no App::error_page, so a failure leaves their design](https://github.com/corten-run/corten/issues/951)).
181. The kit's `FailedAlert` took a row and a gap in a kit `Dialog`'s grid before anything failed,
    because its live region stays rendered. The region is now out of the flow while its alert is
    hidden (`position: absolute`), and in the flow again once the alert shows. It stays in the
    accessibility tree: in Chromium it is an assertive alert both ways. An app with a copy of the
    kit takes it with `corten ui add alert --merge`
    ([#998 Kit FailedAlert: its always-rendered live region adds an empty row to a kit Dialog's grid before anything has failed](https://github.com/corten-run/corten/issues/998)).
182. An error page the app's middleware made of a page it threw away after the route answered (a
    `Refused::forbidden()` or a bare 403 decided after `next`) drew the layout's places empty:
    drawing the page used up its layout read values, and dropped those the page gave itself. Both
    now stay for that error page, which draws them, with no second read, whether it waits for its
    reads or not. A page with two layout reads costs the same within noise (callgrind, release,
    the difference between 1,200 and 200 requests over 1,000, three alternating rounds against
    main at 853e9b61: median 65,784 instructions a request, range 65,629 to 65,873, against
    65,698, range 65,631 to 65,737; with a value the page gives, 61,140, range 61,073 to 61,184,
    against 61,222, range 61,208 to 61,468)
    ([#911 An error page a middleware makes of an already-filled page draws no layout read values](https://github.com/corten-run/corten/issues/911)).
183. A debug build's error about the app's own code (a page that draws a component the app does
    not serve, a script module it does not list, a hint no control names) kept its message off
    the error page outside `corten dev`, as every failure's is, so an app's own router test,
    which runs without `CORTEN_DEV`, saw the generic error page; the message went only to
    stderr, easy to miss in a long log. It is now the error page's `Failure::detail` in every
    debug build, which the template's error page shows, and so are the `Refresh` header check
    and a write redirected outside `form-action` (which printed nothing outside dev). When the
    error page fails too (the same unlisted component in its layout), its plain text keeps the
    message. A release build never raises these, and a handler's own error, a panic and an
    extractor's rejection still keep their messages off the page outside `corten dev` (tested).
    The layout-read checks are not covered yet
    ([#1035 A debug build's layout-read errors (later::<X>() on an answer that is not a page, a gives(..) the page does not give) answer a bare 500 that names nothing outside corten dev](https://github.com/corten-run/corten/issues/1035))
    ([#1029 A debug build's served-component check answers an app's own router test with a bare 500: the message that names the component goes only to tracing](https://github.com/corten-run/corten/issues/1029)).
184. A list in the kit's `Alert` (the reasons a form was refused, the steps to fix a problem) kept
    the browser's own box: a 1em margin above and below, wider than the alert's .25rem gap, and a
    40px indent. It now has no margin of its own, so it sits the gap under its heading or paragraph,
    an indent of 1.25rem that keeps its markers inside the alert's padding (a list in one of its
    items as much again), and the paragraph's color in every emphasis (the outline's tone mix, the
    neutral outline's muted text), which the kit's contrast test covers with the paragraph's rules.
    The gallery's soft warning and outline info alerts show one, and its smoke measures the margin,
    the gap and the indents, and checks that the outline's list is its paragraph's color and not
    the alert's, in each engine. An app with a copy of the kit takes it with
    `corten ui add alert --merge`
    ([#1048 Kit Alert styles its heading and paragraphs but not a list, so a list in an alert keeps the browser's 1em margin and 40px indent](https://github.com/corten-run/corten/issues/1048)).
185. A page a click was fetching was fetched twice when it took longer than the hover's 65 ms
    dwell to arrive: by the click, then by a prefetch that a dwell ending before it was in started
    (the dwell the click cut short, the pointer back on its link or on a part of it), since the
    address stays the page being left until the new page is in
    ([#1028 A client navigation changes the address when the page's answer is in (#992)](https://github.com/corten-run/corten/pull/1028)).
    The runtime now prefetches no page the newest visit is fetching, and a navigation ends the
    dwell of the link followed (a link the server redirects would be fetched again otherwise).
    Where a redirect sends it is not known until the answer, so a hover on a link to there can
    still fetch it a second time. The watchlist smoke holds such a page's answer, moves the
    pointer off its link and back, and checks it is fetched once (it failed on main in Chromium
    and Firefox). The prefetch check's one-off failure in Firefox (an extra request) matches this.
    The two Firefox checks that failed now and then say what they counted when they fail: each
    request with its purpose, and the timed requests and console errors of the module that is
    imported again
    ([#1053 Two Firefox watchlist smoke checks (prefetch's newest 8, a script module imported again) each fail now and then on a branch that does not touch them](https://github.com/corten-run/corten/issues/1053)).
186. A page upload whose client stopped sending was answered at the deadline as the server's
    timeout (503, `Failure::TimedOut`) and logged as a deadline, never as the stalled client it
    was: a page's deadline (30 seconds) comes before an upload's idle time (a minute), so with the
    defaults `UploadError::Stalled` was never reached. A deadline that passes while the handler
    waits for more of the body (the client stopped, or sends slower than the deadline allows) is
    now the client's 408 (`Failure::Failed` with status 408, or the JSON 408), as `?` on `Stalled`
    answers, warned of as the 503 is, and its connection is closed after it; one that passes while
    an `Upload` or `pieces_up_to` body over its limit is read past is that read's 413. The
    request's signal still aborts with `Abort::Deadline`. A handler slow after the body arrived,
    or one that never read it, is still the 503. The default error page and `corten new`'s say
    "Check your connection" for a 408. Only `corten::serve` marks a read that waits for the body;
    served another way that deadline is the 503 as before (the 413 still holds)
    ([#1061 Upload's idle time (a minute) is longer than a page's default deadline (30 s), so a stalled page upload is answered as the server's timeout, never as Stalled](https://github.com/corten-run/corten/issues/1061)).
187. A handler that takes a form's `formdata` event as lib.dom types it (`@param {FormDataEvent} event`)
    did not compile since every handler parameter is checked
    ([#1066 A handler parameter no call is checked against stops the call compiling; @import'ed events are checked (#1037)](https://github.com/corten-run/corten/pull/1066)):
    Corten typed `on:formdata`'s event `Event`, and `FormDataEvent` was no interface a call is
    checked against. `formdata` is now a `FormDataEvent` and `securitypolicyviolation` a
    `SecurityPolicyViolationEvent`, and both bubble, so `on:document:` hears them. An element's
    `error` is now an `Event`, not an `ErrorEvent`, as the element fires it (probed in Chromium,
    Firefox and WebKit): an `on:error` handler typed `ErrorEvent` read an `event.message` that is
    never there, and no longer compiles; type it `Event`. `abort`, `progress` and `resize` stay
    `Event`, for the same reason, though lib.dom gives them the window's and XMLHttpRequest's
    types. `npm run check` now holds the event map to lib.dom both ways (`scripts/events.mjs`), so
    an event lib.dom types more narrowly cannot fall back to `Event` unnoticed, nor an arm be
    narrower than lib.dom
    ([#1072 A formdata handler cannot take its FormDataEvent: the event map types formdata as Event, so since the handler check a lib.dom-typed handler does not compile](https://github.com/corten-run/corten/issues/1072)).
188. A feed whose generation held a character `encodeURIComponent` escapes (`deploy:3`, `v 1`,
    base64's `/` and `=`) never went live: `Since` reads `?since=` as written, so the cursor
    `subscribe()` sent never matched, every stream answered `sync`, and each open page loaded
    the snapshot again straight away, in a loop (544 snapshots in 3.5 s from one Chromium page,
    measured). `Feed::follow` now panics where it is set on a generation that is not ASCII
    letters, digits, `.` and `_`, the bytes a cursor carries as they are in a URL and an event's
    `id:` line (a line break could also start a field of its own in every patch frame; Changed
    165). Corten's own generations are hex, so they are unchanged. `subscribe()` now loads the
    snapshot again after a backoff (1 s, doubling to 30 s) when a stream answers the cursor the
    snapshot just gave with `sync` as it opens (on its first connection, within 900 ms), so a
    feed that cannot go live for another reason (two feeds behind one URL) costs 3 snapshots in
    the same 3.5 s in Chromium, Firefox and WebKit; a `sync` later on a stream or after a
    reconnect (a reset) still loads it at once. The runtime is 79 B larger (gzip). The watchlist
    smoke checks the backoff's 1 s and 2 s, that it stops on the signal, and that a `sync` later
    or after a reconnect is not delayed
    ([#1067 A feed generation with a character encodeURIComponent escapes never goes live: Since does not decode ?since=, so subscribe() loops snapshot and sync about 190 times a second](https://github.com/corten-run/corten/issues/1067)).
189. `corten-cluster` wrote what happens to a feed across instances (a gap in its patches and the
    reload it starts, a patch dropped as invalid, a failed reload, consumer or resubscribe, a feed
    loaded with no replay log, the relay going active or standing by) to stderr with `eprintln!`,
    so the app's subscriber, its filters and JSON lines never saw them. Each is now a `tracing`
    event with target `corten::feed`, as the feed's own are, with fields (`instance`, `feed`, and
    `have` and `got` for a gap): a warning, or `info` for the relay going active. A test installs
    a subscriber and sees a gap and a dropped patch with their feed; it saw nothing before. An event while
    the app starts (an instance taking the lease, or failing to, before `serve`) no longer prints
    with the default subscriber, which `serve` installs; `eprintln!` printed it. The failover
    bench reads which instance ran the relay from its `/api/stats` at each kill instead
    ([#1069 corten-cluster reports gaps, reloads and relay failover with eprintln!, so the app's tracing subscriber, filters and JSON logs never see them](https://github.com/corten-run/corten/issues/1069)).
190. `subscribe()` told its `status` handler `syncing` twice in a row when a snapshot failed and
    was fetched again. Its recovery paths now each have a browser check in `scripts/smoke.mjs`,
    in Chromium, Firefox and WebKit: a patch that skips a `seq` loads one new snapshot and a
    patch already applied is dropped; a stream answered with an HTTP error is listened to again
    from the last patch's cursor, with no snapshot, after 1 s and then 2 s; a failed snapshot is
    fetched again after 1 s and logged once, and the feed goes live (`sync` was checked with
    [#1067 A feed generation with a character encodeURIComponent escapes never goes live: Since does not decode ?since=, so subscribe() loops snapshot and sync about 190 times a second](https://github.com/corten-run/corten/issues/1067),
    except a `sync` on a stream already open, which WebKit skips). That a stream which opens
    starts the error backoff again is checked too. The live-data guide and the failover
    benchmark now say its 200 clients are the benchmark's own Node client of the feed's
    protocol on its own retry schedule, beside a Chromium page running `subscribe()` that lost
    nothing
    ([#1068 subscribe()'s resync paths (sync, a seq gap, a stream answered with an error) have no browser smoke check, and the failover benchmark counts a Node copy of the client](https://github.com/corten-run/corten/issues/1068)).
191. A closed `<dialog>` an app draws in place from a breakpoint (a filters rail that is a modal
    on a phone) was hidden by the components' stylesheet's `dialog:not([open])` rule with no error
    and no failed check, so the rail was simply missing on wide screens. `corten dev` now warns in
    the console of each closed dialog or popover that the rule keeps hidden while a rule inside
    `@media` or `@container` gives it a `display`, at the width the page is at or any other,
    nested rules included, with the selector, the query and a rule for each reading: drawn in
    place there (`.filters:not([open],[hidden]) { display: block !important }` in that query, which
    leaves a rail the app hides with `hidden` hidden), or the open
    one's look, written under `[open]`, as the kit's dialog and sheet are. The page cannot tell the
    two apart, so it is a warning, not an error. A look outside a query (a card on a dialog) and
    one under `@supports` are still kept hidden while closed and are not reported; the styles
    guide gives both rules. It is a check of `/corten/dev.js`, which only a dev server serves, so
    a production page is unchanged; `scripts/smoke-dev.mjs` checks what it warns of and what it
    does not
    ([#1081 A closed dialog an app draws in place from a breakpoint (a filters rail) is hidden by components.css's !important dialog rule, with no error and no failed check](https://github.com/corten-run/corten/issues/1081)).
192. Nothing answered `/favicon.ico`, which browsers ask for on their own for a PDF, an image or
    JSON opened in a tab, so each such request was the app's 404 page with its layout reads. The
    path now answers the static directory's `favicon.ico`, else its `favicon.svg` (the icon
    `corten new` writes, sent itself rather than a redirect,
    [design](docs/design.md#choice-favicon-path)), each `public, max-age=86400` with its ETag,
    and with neither it is a 404 with no body, `public, max-age=3600`; no layout read starts and
    no page is drawn, and it is never JSON, whatever the client accepts or an API at `/`. A page
    or API route of the app's that the router would pick for the path (written as it, or a
    parameter or catch-all route) still takes it, so an app that answers it today keeps its own answer. A static file's
    ETag is now compared as `If-None-Match` is, weakly and in a list or as `*`, so a proxy that
    marks it weak gets a 304 where it got the whole file
    ([#1056 Nothing answers /favicon.ico, so each browser request for it is the app's 404 page with its layout reads](https://github.com/corten-run/corten/issues/1056)).
194. `bench/fullstack`'s Laravel app starts with items in memory: it decoded the whole 27.7 MB
    fixture at boot, past PHP's default 128 MB `memory_limit`, so its in-memory tests failed in
    every round and `check-app.mjs laravel` could not pass. It now reads the fixture one item at a
    time and keeps the default, and refuses a damaged fixture at boot
    ([#981 bench: Laravel cannot start with items in memory, so check-app.mjs laravel fails: decoding the 27.7 MB fixture passes PHP's 128 MB memory_limit](https://github.com/corten-run/corten/issues/981)).
196. A form with a control named `hasAttribute` or `getAttribute` never ran its `data-on`
    handlers (`on:submit`, `on:corten:error`, `on:corten:progress`): the control shadows the
    form's method of that name, so the runtime's dispatch threw `node.hasAttribute is not a
    function` and skipped them, for an event that bubbles, one that does not, and a form put in
    after load; and a `data-patch` form with one could not be drawn again by its own answer, so
    the write looked failed. The runtime now reads the attributes of an element it dispatches to,
    binds, finds refs in, patches or draws again through Element's own `getAttribute` and
    `hasAttribute`, as its submit path already did, and a patched element's id from its attribute
    (a form's `id` is its control named `id`). Its other members are not covered yet
    ([#1105 Form controls named after other Element members (closest, querySelectorAll, isConnected, remove, contains) still shadow what the runtime calls on a form](https://github.com/corten-run/corten/issues/1105)).
    The runtime is 312 B smaller and 27 B larger gzipped (41,292 to 40,980 B, 14,839 to 14,866 B
    gzip)
    ([#1049 A form with a control named hasAttribute never runs its data-on handlers: the runtime's dispatch calls the form's own methods](https://github.com/corten-run/corten/issues/1049)).
195. A debug build's two layout-read checks, a page that draws `later::<X>()` from a route whose
    answer type says it is not a page (`Answer::PAGE`) and a route that says `gives(X)` whose
    page did not give it, kept their message off the error page outside `corten dev` and wrote
    it nowhere a router test sees, as the served-component check did before Fixed 183. Each is
    now the error page's `Failure::detail` in every debug build, and printed to stderr outside
    `corten dev`, as the other checks about the app's code are (a middleware that answers a page
    of its own in place of such a route's still gets a plain 500, logged and named on stderr
    outside `corten dev`). A release build still draws nothing in the place and logs it once
    ([#1035 A debug build's layout-read errors (later::<X>() on an answer that is not a page, a gives(..) the page does not give) answer a bare 500 that names nothing outside corten dev](https://github.com/corten-run/corten/issues/1035)).
193. A page the runtime fetched whole after a write, whose handler sent the browser on to a place
    (`req.redirect(&route.at(id))`), landed at the path without its `#id`: the fetch said
    nothing, so the server answered a 303, and `fetch` follows one without its fragment. The
    runtime now asks for that page with `corten: page`, which the server answers as the whole
    document, as before, and to which a redirect to a place or to another site is named in
    `corten-location`, as to a navigation; one to another site no longer costs a refused fetch
    and a reload. Every redirect now varies on `corten`, and the answer to the runtime's fetch is
    kept by the browser alone, so a cache that keys on the URL cannot hand a full load's 303 to the
    runtime, or the runtime's `corten-location` to a full load. An extractor's refusal of that
    fetch draws the error page rather than its plain text, and an error page keeps the `Vary` of
    the failure it replaces beside its own
    ([#1034 A page fetched whole after a write that redirects to a place loses its #id: the fetch sends no corten header, so the redirect is a 303 that fetch follows without the fragment](https://github.com/corten-run/corten/issues/1034)).

### Documentation

1. The README is now an overview: highlights, quick start, one compiled example, values,
   benchmarks and an index.
2. The detail moved to guides in `docs/guide/`, and the design choices, rules and limits to
   `docs/design.md`.
3. `cargo test` compiles the README's and the guides' Rust examples, so they cannot drift from
   the API.
4. New `CONTRIBUTING.md`, `SECURITY.md` and this changelog.
5. New agent skill in `skills/corten/`: rules, a decision table and recipes for common tasks. The
   `corten new` template's `AGENTS.md` points to it.
6. The full-stack benchmark tables in the README and `bench/fullstack`, server, browser and build, are
   from round r16 (2026-11-06 to 2026-11-07 UTC, one c-8 droplet, Xeon Platinum 8168, the tree at `eea6adb`),
   with all eighteen page apps and JSON-only aspnet-aot; load rows are medians of three passes.
   Corten serves 20,705 item pages and 26,385 JSON responses a second from memory at 64
   users, and 3,669 item-API pages. A page from memory costs 47 µs of CPU
   (21,195 per CPU-second), serves 1,234 pages a second per MiB, and the item page loads 14.1 KB
   of JavaScript (gzip), up 9.1% from r15. It is the first round with five offers in Corten's initial HTML,
   not all offers in hidden templates, so its page gain is not a like-for-like speedup.
   The Build table is r16's: Corten's clean production build took 77.3 s and its rebuild 34.7 s; axum + Maud took 31.7 s and 11.3 s,
   the apps not written in Rust or C++ took 6.6-45.4 s clean and 0.9-6.3 s after the edit, and Corten's development rebuild took 2.6 s.

7. `Form` in the prelude is `corten::Form` (Added 20), and a route's parameters its `Params`. Against
   axum's: a blank field is `None` for an `Option` (axum gave `Some("")`, or an error for a
   number), and a `bool` accepts `on` (a checked checkbox), which axum refused. `serde` (without its derive) is now always a
   dependency of `corten`; it was already in axum's tree.
8. Hover prefetch does nothing in a browser without the Navigation API, where a click is a full
   page load that could not use the prefetched response.
9. The README, `docs/design.md` and `corten-ui` say what is tested in which browsers: the
   runtime and `corten-ui` in Chromium, Firefox and WebKit.
10. The goal is stated as speed at the user's end, with the work done where it is fastest: the
    README's tagline, introduction, "When to use it" and values 1, 3 and 8, a new design choice
    (9), design rules 1, 4 and 5, `docs/architecture.md`, the agent skill and the `AGENTS.md`
    `corten new` writes. They read as if every interaction should be a server render; sorting,
    filtering, selecting and totalling what a page already has belong in the browser. The scripts
    guide has a new section, Server or browser, with a table for choosing. Pages and actions still
    work without JavaScript; a feature only a browser can provide may need it. The missing piece
    for rich client text is
    [#17 Scripts have no typed way to show user-facing text they compute](https://github.com/todd-skelton/corten/issues/17).
11. The README's example names its view `home_page` (it was `page`), so `home` serving it reads as
    `req.page(home_page(&req, ""))` rather than `req.page(page(..))`; the forms recipe in the agent
    skill follows.
12. The brand pack is in `docs/brand/` (mark, lockups, favicon, palette, traced from
    `corten-weathering-concept.png`), and the README opens with the lockup, in its light version
    when the reader's system is in dark mode.
13. The app guide says why a JSON 400 under `App::api` costs about 500 instructions more since
    every route goes through the checks (Added 65): the checked `get` marks a JSON route's
    failed response with an extension, profiled under callgrind in place of "most likely".
14. The examples use the patterns they lacked. `examples/item-page`: a moved address (`req.moved`),
    `Policy::new().hsts()` behind `HTTPS`, `.deadline`, `.ready` (the item API answers), a
    category page shared longer by CDNs (`.shared(..)`) with its breadcrumbs as `JsonLd`, and an
    alert on an item with no listings answered with a whole-form error (`Errors::add_form`).
    `examples/seller-desk`: a `Middleware` (`Server-Timing`), an archive made idempotent by
    `SubmitKey`, a `NoStore` statement page, a nav from `req.nav`, and a typed event
    (`#[event] PriceEdited`) a price cell sends the grid, which counts the prices not saved.
15. The examples are named for what they are: `examples/hello` is `examples/watchlist` (a stock
    watchlist) and `examples/item-page` is `examples/card-market` (a trading-card store), with
    their packages, images and CI steps. Every example has a designed layout in light and dark.
    The watchlist is styled utility-first from its token file's utilities (`display`, `gap`,
    `p`, `bg`, `columns`, ...), with the repeated combinations named in `src/theme.rs`, and the
    styles guide compares that with Tailwind.
16. Every pull request is reviewed against the values before it merges, by someone who did not
    write it, who looks for the way the change breaks a value (CONTRIBUTING.md, Review). The
    order that decides between conflicting values now sits with the values in the README
    rather than in AGENTS.md, which has an agent start a new agent for the review, and a pull
    request template asks for the checks, the measurements and the findings.
17. `examples/watchlist` is a stock watchlist whose pages each do a job a user has. You watch
    and remove stocks from a market of eight; each browser's list is kept on the server under a
    random id in a `list` cookie (the 10,000 used most recently) and changed under a lock, so two
    removals sent at once both land. Each row's Remove button submits the watch form (`formaction`), and the list and the
    form are patched in place. Each row shows today's change, from the server (`t.percent`) and
    from the script (`t.js().percent(2)`). The market moves from a task of the app's
    (`App::task`, which stops at shutdown) rather than `tokio::spawn`. The About page is now
    News: one query struct (`#[route(query)] filter: NewsQuery`) for the sector filter, whose
    sectors are `#[derive(UrlValue)]`, the "only stocks I watch" filter and Load more; a briefing
    signup checked on the server (field errors, `req.invalid`) that sends the browser back to its
    form (`route.at(Id)`); and stories that link to a place on the publisher's page
    (`Elsewhere::at`). The saved page is now Alerts, a price alert checked on the server and
    answered while its read catches up (`ReadAgain`), and the avatar upload has a form on the
    Account page, with sign out. The smoke test follows the new pages: a list a patch replaces
    opens one new stream and closes the old one, the list survives a reload, the change cells
    follow the feed, a sector's box lists its stories, a refused price comes back marked with
    focus on it, and a story's place stays in the address.
18. `examples/card-market` shows a partner API and a write limit. `POST /api/alerts` sets an
    alert for a partner's user: the handler takes `Caller<Partner>`, found by the `X-Api-Key`
    header (`API_KEYS`, no partner without it), so a request without a known key is a JSON 401,
    and the form's rules answer with the fields. A middleware of the app's (`WriteLimit`)
    allows about 20 writes a minute from one client (`ClientIp`, an IPv6 address by its /64;
    `WRITES_PER_MINUTE` to change it) and answers the next with a 429 and `Retry-After`; a
    partner's alerts are counted by the partner, whatever address it sends from; reads pass
    straight through, so pages a CDN keeps stay public, and agents answer to their token, which
    no longer defaults to `dev-token` (`AGENT_TOKENS`). The smoke test runs the container with
    Docker's networks as its proxies (`PROXIES`), so each forwarded address has its own count.
19. The examples show believable data and fit a phone. card-market, run with no item source
    (`API_BASE` or `ITEM_SOURCE`), serves a demo catalog built into it (`fixtures/demo.json`):
    original cards in three sets, sellers, offers and a sealed box with its contents. Its home
    page lists the source's items as cards (name, set, lowest price) and a category page lists
    its items; against the item API, which has no list, the home page links the first ids as
    before. Tables too wide for a phone scroll inside their panel (the item page) or their box
    (seller-desk's grid). seller-desk's statement writes its amounts with `t.money` and its
    words from a catalog, not a hand-written `$`.
20. `examples/cluster` is `examples/listings-feed`, named for what it is (a seller's listings
    feed served by several instances), like the other examples; the crate it shows is still
    `corten-cluster`. Its package and image are `listings-feed` and `corten-listings-feed`.
21. The styles guide says where a page whose path is the prefix of other areas (`/account` above
    `/account/cart`) puts its CSS: in `App::components`, as the home page does, with the pilot's
    measurement
    ([#239 A page whose path is the prefix of other areas (/account above /account/cart) cannot have a stylesheet only it links](https://github.com/todd-skelton/corten/issues/239)).
22. The examples write no seam as text: card-market's header is a component with scoped
    classes (`SiteHeader`, lined up with the page below it) instead of `class="site"`, and the
    watchlist's `LivePrices` passes its feed's route to the script (`url::Stocks`) instead of
    taking `url::Stocks::PATH` as a `&str`. The watchlist's titles end in "| Watchlist" (its home
    is "Stocks") and its header fits a phone on two lines; card-market's error page links home,
    its item page's tables and price summary fit a phone, its alert form keeps less room under
    it, and its demo cards name their rarity twice (the chips and the details) instead of four
    times: the subtitle is the set and number, and no tag repeats a field or a chip.
23. Each example has a README: what the app is, how to run it (`corten dev` and Docker) with
    the environment it reads, and which file holds each piece. The main README lists the examples
    in the order to read them, watchlist first
    ([#230 No example has a README that says how to run it and where each feature is](https://github.com/todd-skelton/corten/issues/230)).
24. Work on a schedule is a task with tokio's intervals: `App::task`'s documentation and the
    guide (app.md, "On a schedule") show a job hourly at :15 and one every five minutes in one
    loop, so they never overlap, keeping each job's last run for a status page, run on a paused
    tokio clock in a doctest; the guide says what is left to the app (the monotonic clock's jumps,
    the next run's time, local wall times). The guide's task example and the watchlist's market
    task now use `MissedTickBehavior::Skip` (an overrun is followed by one late run; tokio's
    default, `Burst`, runs once for each missed mark, back to back) and poll the signal first
    (`biased`), so no run starts once shutdown has begun. Corten adds no scheduler. Corten's own
    tests build tokio with `test-util` for the paused clock: each tokio clock read in them checks
    one flag more; apps are not affected
    ([#278 An app cannot run a job on a schedule (hourly at :15, every 5 minutes, daily at 03:30), so each writes the clock, the missed-mark skip and the no-overlap rule itself](https://github.com/todd-skelton/corten/issues/278)).
25. The app guide (Areas) and the skill say how a page in an area that another permission opens
    (an order's review form under `/account/purchases`) is declared: a second routes module in the
    same area with its own `caller`, passed in one call,
    `.area(|area| reviews::area(orders::area(area)))`, rather than an `identify` that picks the
    permission from the path. A test holds two modules' callers apart in one area
    ([#273 A page under an area cannot take its own caller, so a nested form that needs another permission checks it by path or by hand](https://github.com/todd-skelton/corten/issues/273)).
26. CONTRIBUTING's check 2 unpacks sources into a throwaway `--tmpfs`, so its publish dry run builds
    against Corten's crates as they are now, not a copy an earlier run left in the shared volume
    ([#300 Check 2's publish dry run builds corten-ui against a stale corten unpacked in the shared registry volume](https://github.com/todd-skelton/corten/issues/300)).
27. `corten_ui::NumberField` says it is for counts and measures (a quantity, a weight), not
    money, and the UI guide says a price is a text input with `inputmode="decimal"` read by
    `t.parse_money`: a number input takes only the browser's decimal syntax, and its value is an
    `f64`. ui-gallery's price and lowest offer are such inputs now, read as money and written
    with `t.money`, its quantity is a `u32`, and its second number field is the shipping weight
    ([#286 corten-ui's NumberField cannot show back a refused entry or take a price in the reader's locale](https://github.com/todd-skelton/corten/issues/286),
    [#325 ui-gallery reads the listing's quantity and price as f64 and writes money with format!](https://github.com/todd-skelton/corten/issues/325)).
28. CONTRIBUTING (Pull requests, item 2) says which measurement fits which change: instructions per
    request for work done in process (callgrind in process, `count.mjs` with `perf` over a socket),
    times as well when memory changes (`render_cost`, with its command and fixture), time on a
    quiet host for waiting and concurrency (`ab.mjs`, `cold-start.mjs`), and bytes for what the
    client receives (`render_cost`, `bytes.mjs`), from alternated release runs reported with their
    median and range; Tooling lists valgrind and `perf`. AGENTS.md, the README's values and the
    pull request template point to it rather than naming `nanoseconds per request`.
29. The checks in `CONTRIBUTING.md` build into volumes named after the checkout's folder
    (`corten-target-<folder>`, `corten-msrv-target-<folder>`) instead of one `corten-target` for
    every checkout, where cargo could take one checkout's build for another's and fail to compile
    code that was fine.
30. The views guide (Text: literals or the catalog) and the design rules say when text is a
    literal and when it goes through the catalog: an app with one locale writes fixed text as
    literals and keeps in its catalog only counts, text with arguments and text a script fills;
    an app with more than one locale writes all of it through the catalog. seller-desk's
    statement, ui-gallery's activity card and listings-feed's move status, which were the only
    fixed text those one-locale apps put in their catalogs, are literals now
    ([#218 Examples write user-facing text two ways: watchlist has a catalog but writes most text as literals](https://github.com/todd-skelton/corten/issues/218)).
31. Every prop is written where a component is used, an empty one too (`head=""`). The views guide
    says why: stable Rust cannot leave a field to a default, and filling a left-out `impl Render`
    prop would fix its type. It also shows how several answers share one component's props, with
    a function for the common value and `..` for the rest. A `compile_fail` doctest on
    `#[component]` covers a left-out prop. ui-gallery's five answers build their `Gallery` that
    way, where each wrote all six props
    ([#210 A component prop cannot be left out, so pages pass head="" and other empty values](https://github.com/todd-skelton/corten/issues/210)).
32. The views guide says how a layout gets who is signed in: as a prop from the `Caller` its
    handler took, not by reading the request. Rendering is synchronous and `Identify` is async, so
    the alternative needs a second async step before full-page renders, with its own rules for a
    failed lookup, caching and the page key
    ([#209 Every page handler extracts the viewer only to pass it to the layout](https://github.com/todd-skelton/corten/issues/209)).
33. `design.md` (Limits 14), `docs/architecture.md`, `docs/guide/app.md` and
    `docs/guide/live-data.md` say that HTTP/2 or HTTP/3 to browsers comes from the proxy or CDN in
    front of `corten::serve`, and that an app with live streams needs it: over HTTP/1.1 a browser's
    six connections to a host run out
    ([#400 architecture.md relies on HTTP/2 to share connections, but Corten serves only HTTP/1.1 and no guide says HTTP/2 must come from a proxy](https://github.com/todd-skelton/corten/issues/400)).
34. `docs/architecture.md` lists number, money and date formatting as the framework's (`t` on
    CLDR data, and `t.js()` in scripts), not as removed
    ([#401 architecture.md says number, money and date formatting was removed from the framework, but t.money, t.number and t.date_time are built in](https://github.com/todd-skelton/corten/issues/401)).
35. `design.md` Choices 11 to 14 say why a request's mode is a `corten` header and not `Accept` or
    `Sec-Fetch-*`, why the runtime prefetches links itself and not with Speculation Rules, why
    component CSS is scoped by prefix and not `@scope`, and why a feed patch is keyed `upsert` and
    `remove` and not JSON Patch or Merge Patch, each with what would let Corten move
    ([#396 The request mode is a corten header of our own, and no doc says why not Accept or Sec-Fetch-*](https://github.com/todd-skelton/corten/issues/396),
    [#397 The runtime prefetches links its own way, and no doc says why not the Speculation Rules API](https://github.com/todd-skelton/corten/issues/397),
    [#398 Component CSS is scoped by prefixing classes, and design.md does not say why not native @scope](https://github.com/todd-skelton/corten/issues/398),
    [#399 A feed patch is an upsert/remove format of our own, and no doc says why not JSON Patch (RFC 6902) or Merge Patch (RFC 7396)](https://github.com/todd-skelton/corten/issues/399)).
36. The requests guide documents `corten:error` (when a `data-patch` submit has no answer to draw,
    with `detail.status`, 0 for none or a cut-off body), and the scripts guide the one way a script
    learns what the server decided on a submit that did draw: the patch's element runs
    `on:connect` with the handler's values and dispatches a typed event, as
    `examples/deck-builder`'s `SaveNote` does. No second, status-only event is added
    ([#432 A script that submits a data-patch form cannot learn the answer's outcome, so the deck builder carries it in an on:connect element](https://github.com/todd-skelton/corten/issues/432)).
37. The requests guide says why the submit key is a form field and not the `Idempotency-Key`
    header: a browser without JavaScript cannot set one, and the header is still an IETF draft
    ([#395 An action takes its idempotency key only as a SubmitKey form field, not the Idempotency-Key header data clients send](https://github.com/todd-skelton/corten/issues/395)).
38. The live-data guide follows a job another process runs (a worker writing to a shared database):
    one `App::task` reading into a `watch` channel for `live_watch` when many pages follow it, or a
    `corten::live` loop that sends only when the version moved, ends after the settled state and
    gives up after a few failed reads. No `live_poll` helper is added: the interval, what to read
    less often and when the job is done are the app's, and a helper would take a closure for each
    ([#388 A live part that follows a job in another process writes its own poll loop, version cursor and end](https://github.com/todd-skelton/corten/issues/388)).
39. The scripts guide says a value a handler computes that the server also draws is a second copy,
    and how to keep the two in agreement: draw it on the server only when a round trip is fast
    enough, or keep the arithmetic in a `script!` module that imports nothing and run one table of
    cases through both in a test, which `corten check` runs. Corten does not compile Rust to the
    script or add a runner of its own: a test already does it
    ([#444 A value a script computes as the user types is also drawn by the server, so its arithmetic is written twice (Rust and JS) with nothing checking they agree](https://github.com/todd-skelton/corten/issues/444)).
40. The app guide's task loop gives its step the signal, and says why: a run in progress is outside
    the loop's `select!`, so one that can take longer than `App::shutdown_grace` (a remote read
    with a 10 s timeout) stops its slow awaits at the signal, and Corten does not race the whole
    step, which would leave half a write. A new section, "A queue a request fills", has a worker's
    loop: the claim and lease are the app's SQL; the job's work, made once and pinned, races its
    renewal (bounded by a timeout, the next a period after it ended) and the signal, which is safe
    because each of its writes is whole and a job can be done again; the work is dropped before the
    claim is released; `finished` and the work's writes are fenced by the claim, so a lost lease
    writes nothing; a retry's delay is the queue's (`run_after`), so a job that fails at once is not
    claimed again at once; a claim error is logged and waited out; the idle wait is a `sleep` and
    a `Notify`, not an interval. `App::task`'s example gives its refresh the signal and tests its
    shutdown with `Signal::task`. Corten has no job queue or worker type
    and no `every` helper: the queue is the app's storage, and a helper that raced the step would
    drop work mid-write
    ([#488 A worker for jobs that requests queue builds its own leased claim, heartbeat, requeue, progress and retry on App::task, once per worker](https://github.com/todd-skelton/corten/issues/488)).
41. The app guide has a Testing an app section: a test asks `app().router()` as a browser would
    (`router()` starts no tasks), and a test with a database takes the connection the code writes
    on, with `#[sqlx::test]` (a fresh database per test) first and a rolled-back transaction for a
    shared one (tests writing the same rows take an advisory lock, or they can deadlock), tests that
    need a database `#[ignore]`d in a `tests/` target of their own, and a fixture recorder an
    example rather than a test. Corten adds no test mode or rollback helper: the driver's are the one
    way
    ([#506 No story for tests that need a database or a live service: #[ignore] runs both, and a live recorder ran with the database tests](https://github.com/todd-skelton/corten/issues/506)).
42. The requests and forms guide has a section on work on something the app's data already names
    that must not run twice (postage for an order, a batch over the same rows): inside
    `Signal::finish` with a time budget, for each item a lock in the store every instance shares (a
    Postgres advisory lock held in a transaction committed with the item's record), under it a check
    of what is done already, a 502 that keeps what was bought when the provider fails, and a 409
    showing the current state while another request holds the lock; and what it does not cover,
    which is the app's to design for its provider (a call whose record is lost, answered by the
    provider's idempotency key), with the timeouts and the shutdown grace the work needs. The app
    guide's On a schedule has a job claim its run by its mark in the shared store, so it does not
    run twice across instances while every instance claims and ticks on the marks (a clock ahead of
    the others makes runs come early). `App::task` and `SubmitKey` say that a loop, a `Mutex` or a
    static lock holds within one process, which a blue/green release or a scaled-out app is not;
    `Signal::finish` and the cancellation guide say that a paid call is checked against the signal
    before it starts rather than stopped midway, and `Refusal::Conflict` covers another request
    acting on the same thing now
    ([#537 The guide's one-at-a-time patterns (a schedule's loop, a shared Mutex) hold within one process, so a second instance during a blue/green release runs the work again, and a paid handler action has no pattern at all](https://github.com/todd-skelton/corten/issues/537)).
43. The app guide (Numbers in JSON) and `ToJson` for floats say how numbers are written in a JSON
    response, a feed's rows and an agent tool's output: as serde_json writes them (a whole float as
    `2.0` where `JSON.stringify` writes `2`, and where each switches to an exponent), which readers
    that type a number by its text read differently; a value a client should read as an integer is
    an integer field, text that must match another service's byte for byte is `Raw`, and a shared
    checksum is over canonical JSON (RFC 8785). Corten keeps one number format for these rather than
    a second one for JavaScript parity, which would make a `ToJson` disagree with the `serde_json`
    fields inside it, feeds and agent output, and would still not give canonical bytes (design.md,
    Limits 16)
    ([#540 Json writes a whole f64 as 2.0 where JSON.stringify writes 2, so a route ported from a Node service changes its numbers' text and how clients read them](https://github.com/todd-skelton/corten/issues/540)).
44. The kit guide says why the kit's tokens are at the top of the file (shadcn/ui's names, and
    none an app's scale would make, so the two themes do not replace each other's values) and how a
    utility over them is written, with its values (`fg_success()`)
    ([#553 Kit role tokens are loose top-level properties, so utilities like fg/bg cannot be generated from a group](https://github.com/todd-skelton/corten/issues/553)).
45. `examples/seller-desk` is styled with the UI kit as `corten ui` gives it: its bulk bar's
    and dialog's buttons, search field, dialog and statement table are the kit's components, copied
    and unedited (`corten ui diff`), and the kit's theme takes the desk's teal and radius in light
    and dark, which its smoke test checks. The grid writes the kit's look in its own CSS for its
    table (whose header stays over the rows as they scroll, also checked). The example serves
    without `compress`: the 500-row page is 272 bytes larger (334,998; 44,500 more since its price
    cells wear the kit's looks, Changed 112) and the stylesheets 6,857
    (14,073, cached). With brotli, as `compress` would send them to a client without zstd (level 2
    for a page, 11 for a static asset), that is 52 bytes (22,280) and 1,165 (3,126)
    ([#548 seller-desk: style it with the UI kit copied into the app and themed to its palette, so one real app shows the kit as corten ui gives it](https://github.com/todd-skelton/corten/issues/548)).
46. The requests guide shows a JSON route taking an upload: one with no text fields names its
    file input with a `Files` field (which `#[derive(Fields)]` marks read, so it is not dead code)
    and takes the file by that name. In an API every refusal of an upload (not multipart, malformed,
    over the limit, fields that do not fit) is the API's failure, in Problem Details or its own
    shape, which tests now hold. That an empty file input is no file,
    where `FormData` keeps an empty `File`, is a limit in `docs/design.md`
    ([#587 Upload is built for HTML forms: a JSON route taking one file needs a dead form struct, gets HTML refusals, and cannot see an empty file input FormData keeps](https://github.com/todd-skelton/corten/issues/587)).
47. Work whose snapshot must follow its lock (`REPEATABLE READ`, where the first statement takes
    the snapshot) takes a session advisory lock before `BEGIN`. The one-at-a-time guide now shows
    that on a connection set to `close_on_drop()`: a handler dropped between the lock and the
    unlock (the client left, the deadline passed) would otherwise return the connection to the
    pool still holding the lock, and a take on any other connection would find it held until the
    pool retires that connection (sqlx's `max_lifetime`, 30 minutes unless set, or 10 minutes idle).
    Cancellation says the same of any state a connection keeps past its transaction. Corten adds
    no helper: the lock is the app's, over its own driver
    ([#607 A session advisory lock taken in a handler stays on its pooled connection when the client leaves, so every later request waits on it; the guide shows only transaction locks](https://github.com/todd-skelton/corten/issues/607)).
48. The kit guide says how the app's own stylesheet meets the kit's looks: a default that weighs
    more than a look's rule (`button[data-primary]`, `.sidebar a`) wins over it on a kit control,
    so a rule for the app's own elements goes on a class of the component that draws them, and
    one meant only as a
    default keeps its weight to the element with `:where(..)`; a table's cells and a stack's
    children are the app's to style, and a cascade layer would reverse that. `corten ui init` ends
    by pointing there
    ([#556 Kit rules tie or lose against an app's ordinary element defaults, so a kit Button or Input can be restyled by style.css](https://github.com/todd-skelton/corten/issues/556)).
49. Typed event streams are not planned until an app needs them: design (Limits) and the live data
    guide say why (no caller, and the typing would add a route attribute, a declaration kind and
    runtime code every page loads) and that one would start from `#[event]`
    ([#591 An event stream's names and data are strings the script reads untyped, where a feed's rows are checked from the route to the script](https://github.com/todd-skelton/corten/issues/591)).
50. The views guide says a namesake the program does not use may still fail to link because a
    linker takes an object file whole, so it depends on what shares that object file (the build
    profile: how the compiler split the crate, or merged it under LTO), not on which linker; it
    said Linux loads more than a Windows GNU link. It also says a release build with thin LTO links
    a pair the program uses, so the check is a debug build's
    ([#636 Two namesake components in two crates link in a release build with thin LTO, so the link-time name check misses there](https://github.com/todd-skelton/corten/issues/636))
    ([#590 A library's component with an app component's name still links on Windows GNU when the program does not use the library's, and Linux may refuse it](https://github.com/todd-skelton/corten/issues/590)).
51. The kit guide's `corten ui add` row, cut short by a merge at a conflict marker in its own text,
    says again what `--merge` does when both sides changed a line and which copies it refuses.
    `npm run check` now fails on a conflict's marker starting a line of the repository's
    Markdown outside fenced code, or a table row (including one in a list or a quote) that does
    not end with its `|`
    ([#658 docs/guide/kit.md's corten ui add row was cut off at '>>>>>>> origin/main' by a merge, losing --merge's refusal rules and the row's closing pipe](https://github.com/todd-skelton/corten/issues/658)).
52. The live data guide says `live_watch` renders its view once per open page for each change,
    since a page's part may depend on its request, and that a part the same on every page is
    rendered once by the task that changes the value and sent with it, while the page renders its
    own from that value. For a 50-row table of 3,132 bytes on 300 pages, a change costs 2.3
    million instructions where rendering on each page took 7.6 million (callgrind, three runs
    each: 2.27 to 2.36 and 7.58 to 7.82; each page's compression and socket write not counted).
    A shared render inside `live_watch` was not added: its view may capture the request
    (`req.t()`, the signed-in name), and each stream renders inside its own request's zone, so a
    render shared between streams would send one reader's language, name or dates to every page;
    a view that captures nothing would need a second, narrower kind of view, and still a render
    outside the request's zone
    ([#650 live_watch renders the same value once per open stream, so a change costs one render for every page watching it](https://github.com/todd-skelton/corten/issues/650)).
53. `docs/architecture.md` (Agents) records why Corten offers nothing for WebMCP (agents in the
    browser) yet, what an app can do today, the part Corten would own (the declarative form) and
    when to revisit
    ([#695 WebMCP: wait for the declarative form API before Corten offers anything, and record when to revisit](https://github.com/todd-skelton/corten/issues/695)).
54. The guide's "Filters and lists that grow" shows the whole script a form that applies on
    change needs, and its two variants: sent as a submit button of the form
    (`form.requestSubmit(button)`, so its `formaction` decides where), and applied by one control
    only (the handler on the control, the form passed as a ref, so the call takes only a form). The runtime gets no
    attribute for it: a behavior is a function the markup calls
    ([#716 A form that applies on change needs a script of its own in every app (form.requestSubmit() on change), where a mark like data-keep-place would do](https://github.com/todd-skelton/corten/issues/716)).
55. `docs/design.md` Choice 17 says why a component's behavior is a handler on any element rather
    than a custom element per component, and why its styles are prefixed classes rather than
    shadow DOM: a wrapper element inside a table or around a `<summary>` is moved or breaks its
    parent in every engine, the customized built-in that would avoid it does not run in WebKit,
    and a shadow root keeps out the app's classes, the patches' ids and the outer form. README
    Values 2 says Corten uses a custom element where the behavior is the element's own, as
    `<corten-live>` holds a live connection
    ([#707 design.md does not say why a component with behavior is not a custom element, or why its styles do not use shadow DOM, though Values 2 names custom elements first](https://github.com/todd-skelton/corten/issues/707)).
56. `examples/deck-builder` is a motion reference: drag targets transition, changed collection rows
    pulse, and deck lines enter with a reduced-motion-safe CSS animation. Its smoke test checks the
    typed `data-motion` markers and their cleanup without depending on a screenshot or a fixed
    animation duration.
57. `examples/deck-builder` accepts drops from one deck line onto another to reorder the local
    presentation, with before/after targets, keyboard ArrowUp/ArrowDown support, and smoke coverage.
58. A deploy guide (`docs/guide/deploy.md`): what a proxy or CDN in front of the app must do (`Host`,
    `X-Forwarded-For`, HTTP/2, event streams, `Vary`, error bodies, connection reuse, health checks,
    body size), an nginx configuration the watchlist's browser smoke test passes through, and the
    cache settings for Cloudflare and CloudFront. `docs/design.md` Limits 20 records that a shared
    cache must key on `Vary` and why a page's JSON stays at the page's URL
    ([#783 A Public page is safe behind a CDN only if the CDN keys on Vary, which Cloudflare and CloudFront do not by default, so a JSON client of a page route can get the cached HTML](https://github.com/todd-skelton/corten/issues/783)).
59. The README's runtime size is the build's, 12.1 KB gzip (34,523 bytes minified, 12,427 gzipped at
    zlib's default level), where it said 5.3 KB brotli since 2026-10-23, when the runtime was 15,920
    bytes. It is now in gzip at the level and in the KB of 1,024 bytes bench/fullstack measures the
    item page's 12.8 KB beside it with, so the two compare. `npm run build:js` writes the number
    into the README (only when it changed), and `npm run check` fails when the README's figure or
    its article is not what a runtime within 32 bytes of the build's would have, or when the README
    has none or two (`scripts/readme-size.mjs`, tested), as it fails for a stale build. The
    client-heavy table, from an earlier round, says so until the next round, tracked in
    ([#833 The README's client-heavy table is from round browser-3 (2026-10-23): its 8.6 KB of Corten JavaScript is less than the runtime alone is now (12.1 KB gzip)](https://github.com/todd-skelton/corten/issues/833))
    ([#821 README says the runtime is 5.3 KB brotli; the build is 11.2 KB, more than twice that, and nothing checks the number](https://github.com/todd-skelton/corten/issues/821)).
60. `serve_wrapped` facing browsers directly is for an app without live streams: the guide and
    `docs/design.md` Limits 14 say so, and record why Corten speaks no HTTP/2 or HTTP/3 itself
    and what would reopen it. Measured: with three watchlist tabs open in Chromium over HTTP/1.1,
    a fourth tab's page had no answer within 15 s, and through the deploy guide's nginx with
    `http2 on` all eight loaded, the first in 1.0 s and the others in 212 to 471 ms; HTTP/2
    through hyper adds eight crates to the template's build (`h2`, `tokio-util`, `indexmap` and
    five smaller), with a clean release build of the template at a median of 492 against 466
    CPU-seconds over three alternating builds on a loaded desktop, within its noise (448-586
    against 427-559)
    ([#787 serve_wrapped ends TLS but speaks only HTTP/1.1, so an app with live streams served without a proxy runs out of browser connections; HTTP/2 is unmeasured and HTTP/3 has no recorded decision](https://github.com/todd-skelton/corten/issues/787)).
61. The app guide's Connections section, and design.md's Choice 19, say what a flood of unfinished
    request heads leaves behind and why: glibc's allocator keeps the freed memory and each flood
    grows it (at least 448 MiB during the eighth, 419 MiB kept after, measured), where with jemalloc
    preloaded the same floods left 31 to 81 MiB with no climb. `max_connections` is sized from
    the peak repeated floods reach, and the guide gives the two lines that preload jemalloc
    ([#852 Memory a flood of unfinished request heads takes is not given back when the connections close, and each flood grows it further (217 to 464 MiB over eight)](https://github.com/corten-run/corten/issues/852)).
62. The request order in `corten::middleware` and the app guide names the steps it left out: a
    page's layout reads start beside the handler, and the page is filled before the answer goes
    back out through the middleware, so a middleware sees the filled page and its timing includes
    the reads' wait; the error page for a failure the request is at fault for starts the reads
    outside the middleware; and the weak `ETag` and `304` come after `Cache-Control`, so a
    middleware sees a `200` with the whole body where the client gets a `304`. The architecture
    gives layout data on a full load (`LayoutRead`) its own row
    ([#901 The request-order lists for middleware leave out layout reads and the ETag step, so a middleware author cannot tell it sees a filled 200 where the client gets a 304](https://github.com/corten-run/corten/issues/901)).
63. `bench/fullstack`'s README splits one request's user instructions by stage and crate
    (callgrind, card-market on main b79a6b23): the item page from memory is 98,099, half of it
    writing HTML and 13% hyper and http, with axum, tower and matchit at least 1.7% (about 2.5%
    with their own code in the rest) and tokio 2.2%; the JSON is 67,135; the item-API page is
    830,161, 59% of it reading the upstream JSON and 19% the allocator. `cost-by-crate.sh` and `cost-by-crate.mjs` measure and split it again
    ([#759 The item page's whole-process instructions are not split by crate, so no one can say what hyper, tokio, axum or Corten each cost a request](https://github.com/corten-run/corten/issues/759)).
64. The app guide's testing section says a browser test should wait for something the new page
    draws, not only for its address: a link or form the runtime follows changes the address when
    the navigation starts, before the new page is drawn (asked by the tcgplayer port).
65. The README's production-defaults line says `corten::serve` speaks HTTP/1.1, so an app with
    live streams goes behind a proxy or CDN that serves browsers HTTP/2 or HTTP/3, and links
    Deploying; the app guide's Connections row and the skill's HTTPS row say the same. Limit 14,
    the deploy guide and the app guide's Your own listeners said so; the README, the Connections
    row and the skill did not
    ([#962 The README calls corten::serve(App::new(routes)) production-ready without saying an app with live streams needs an HTTP/2 proxy or CDN in front](https://github.com/corten-run/corten/issues/962)).
66. The README's page numbers and `bench/fullstack`'s method say the rounds' page requests are
    sent uncompressed and untagged (`Accept-Encoding: identity`, no `If-None-Match`), and a new
    section measures, in process on the item page, what a browser's request adds: 27,700 user
    instructions to hash its `ETag` on top of the request's 86,489, 230,000 more for zstd, and
    about 1.2 million for brotli 2 in place of zstd's. Caveat 17 says SvelteKit and Rails tag every
    page regardless, and caveat 16 that card-market's per-request formatting stays. card-market's
    `route_loop` takes `LOOP_ENCODING` and `LOOP_TAG` for it
    ([#961 Benchmark: the page load sends Accept-Encoding: identity with no tag, the one request that skips the ETag hash, so the headline page numbers leave out costs every browser request pays](https://github.com/corten-run/corten/issues/961),
    [#973 Benchmark: card-market formats prices and ratings per request in the reader's locale, the other item-page apps write the API's strings](https://github.com/corten-run/corten/issues/973)).
67. Each of `docs/design.md`'s 25 Choices ends with what it stands on (each premise named measured,
    platform, reasoned, bet or value, the one most likely to move first and a value last) and a
    condition that would reopen it, so a change can tell when it takes a reason away. The review in
    CONTRIBUTING.md asks whether a change makes a condition true, and `npm run check` refuses a
    Choice without both, a premise of an unlisted kind, with nothing said in parentheses or out of
    order, and Choices out of order (`scripts/choices.mjs`). Writing them showed Choice 1's
    measurement to be one run each that swapped order between loads. Choice 21, which stood after
    22, is back in order, and the architecture's rows that are not built say what would reopen
    them.
68. docs/design.md's Choices, Rules and Limits each have an anchor after their number
    (`#choice-layout-reads`, `#rule-standard-formats`, `#limit-http1`), and the citations in
    the guides, the README, the code and design.md itself link to it, so adding or removing one
    no longer silently points later citations at another. `npm run check` fails on a citation by
    number with no link (on one line or split over two, in prose or in a code block), a link or
    path to an anchor that is gone (in code too), a relative path that does not reach design.md,
    and a link whose number no longer matches its item (`scripts/design-refs.mjs`);
    `scripts/choices.mjs` reads a Choice after its anchor. Rule 10 names the Choices that depart
    from a standard (11, 12, 14, 15 and 18, and 24, which extends one), where its range took in
    Choice 13 and left out 18
    ([#958 design.md's Choices, Rules and Limits are cited by number from code and guides, so inserting one silently breaks every later reference](https://github.com/corten-run/corten/issues/958),
    [#965 Design Rule 10 points at Choices 11 to 15 as its departures from standards, which leaves out Choice 18 and takes in Choice 13, which is not a format](https://github.com/corten-run/corten/issues/965)).
69. Each Choice in `docs/design.md` also ends with when its evidence was last checked: for each
    measured or platform premise, the date and the commit it ran on, or the engine and crate
    versions probed, so a reader can tell fresh evidence from old. `npm run check` refuses a
    Choice without it, or an entry without a date no later than today and a commit or versions
    (`scripts/choices.mjs`). The browser premises were probed again in Chromium 156, Firefox 157
    and WebKit 27.2, which corrected two and named a flag in a third. Choice 15 said `fetch` hides
    where a redirect went; it shows a same-origin target in `response.url` and drops only the
    fragment, so the Choice now names the three cases `corten-location` carries (a place, another
    origin, a form patch), and its `Location` proposal on whatwg/fetch is for runtimes outside the
    browser. Choice 12 said a Speculation Rules prefetch serves only a navigation; Chromium keeps it
    in the HTTP cache too, and Firefox a `rel="prefetch"`, where `Vary: corten` still keeps them
    from the runtime's request. Choice 18 names the flag Firefox 157 reads `@custom-media` behind,
    `layout.css.custom-media.enabled`
    ([#968 Most design Choices give no condition that would change them, and none says when its evidence was last checked (Choice 15's fetch trigger has a live proposal)](https://github.com/corten-run/corten/issues/968)).
70. The app guide's "Other protocols" says where each protocol and format an app may need goes:
    a binary or XML body, a webhook (its signature checked on the bytes as sent) and GraphQL as
    routes under `App::api` that read the body with `bytes_up_to`; gRPC, which needs HTTP/2, and
    a raw TCP or UDP listener in an `App::task`, bound before `serve` so a taken port stops the
    app at startup, ending with its signal. Never a second server
    or a router merged after `app.router()`, which would skip the host check, the middleware and
    the shutdown grace. The skill's pages-and-routes reference says the same
    ([#955 No guide says where gRPC, GraphQL, binary or XML bodies, and raw sockets go in an app, so each app works out its own way around the framework](https://github.com/corten-run/corten/issues/955)).
71. Design Choice 20 now weighs awaiting a layout read before the handler: it ends the error-page
    cases but makes a full load wait for the read and the page together, which in the Chase Sets
    pilot could add up to as much again to its server time (60.4 ms for the request serving the
    read, 56.2 ms for the page, debug build), so the read stays beside the handler. Choices 19 and
    20 and Limit 22 keep their decision and the numbers that carry it, and link the pull request or
    guide that has the full measurement. Choice 23 cites the app guide,
    [#894 docs: a flood of unfinished heads leaves memory with glibc's allocator; size max_connections from repeated floods](https://github.com/corten-run/corten/pull/894)
    and
    [#886 The template's image runs glibc's allocator, which keeps what a flood of unfinished heads freed; preloading jemalloc gives it back, unmeasured for throughput](https://github.com/corten-run/corten/issues/886)
    for the jemalloc flood figures, which Choice 19 no longer carries
    ([#959 Design Choice 20 does not weigh awaiting a layout read before the handler, which would end its error-page cases at a latency cost; every app pays 0.3% to 0.9% a request for the current shape](https://github.com/corten-run/corten/issues/959),
    [#966 design.md's Limit 23 and Choices 19 and 20 carry whole measurement logs, which bury what was decided](https://github.com/corten-run/corten/issues/966)).
72. Design Choice 1 states `html!`'s cost against Maud on the item page (callgrind, three rounds
    at `ff1701b8`): 44,494 instructions a request to write card-market's document against 53,935
    to 53,937 for the axum + Maud app's, most of Maud's in its escaping; the askama comparison,
    one whole-app run each that showed only noise, is gone. `bench/fullstack/cost-by-crate.sh`
    takes `APP=axum-maud`, prints each answer's bytes and names its dumps after the app, and
    `cost-by-crate.mjs` lists a function with what it calls (`INCLUSIVE=`) and knows Maud's
    escaping and the bench apps' files
    ([#963 Design Choice 1 rests on an unrecorded askama comparison; it should state html!'s rendering cost against Maud on equal work](https://github.com/corten-run/corten/issues/963)).
73. design.md: Limits 11 and 12 described decisions (who may use a route is in its handler's
    type; a request's fixed stages, with the app's steps at one place), so they are Choices 27
    and 28, with what they stand on, and Limits 11 and 12 keep only what Corten does not do (a
    check on the record stays in the handler, and a route added outside a routes module that
    holds its prefix is checked against the prefix by a build, not `cargo check`; no hooks at
    several stages, and no step for one route). Their anchors stay, so no citation moves. The
    intro and the Limits section no longer say every limit is "yet": some wait on the platform or
    an app, others are so by design
    ([#967 design.md's Limits 11 and 12 are decisions, not limits, and its intro calls every limit something Corten does not do yet](https://github.com/corten-run/corten/issues/967)).
74. The README is about Corten again: what it is, highlights, the quick start, the compiled
    example, how a request and a page work, a short table of Corten's own measured numbers, and
    the guides, examples and crates. The benchmark tables against other frameworks and their notes
    moved to `docs/performance.md`, unchanged apart from their links, with the README's former
    headline comparisons as its summary; `docs/design.md` and `bench/browser` now cite them there.
75. The native plan in `docs/architecture.md` names the per-host caps of the platforms' own
    clients (`URLSession` 6 HTTP/1.1 connections, which HTTP/2 lifts; OkHttp 5 asynchronous calls
    in flight, even over HTTP/2) and makes `corten-native`'s HTTP client an open decision; design
    Limit 14 and the deploy guide say the proxy serves native apps HTTP/2 or HTTP/3 too
    ([#1006 Native clients have per-host connection limits of their own (URLSession 6 HTTP/1.1 connections, OkHttp 5 requests even over HTTP/2), and neither Limits 14 nor the native plan in architecture.md says how corten-native follows several feeds](https://github.com/corten-run/corten/issues/1006)).

## 0.1.0 (not tagged; `main` as of 2026-10-21)

The first public version.

### Added

1. Server rendering with `html!`: components, typed routes and links, typed messages per locale,
   form field names from `#[derive(Fields)]`, and `compile_fail` tests for each typed seam.
2. One handler per route for four request modes: full documents, client navigation, form patches
   and JSON data screens.
3. `App` defaults: security headers with a CSP nonce, a same-origin write check, error pages,
   versioned static files, health checks, compression, PWA manifest and offline page, and live
   reload in dev.
4. Islands: `#[island]` components with `ref` and `on:event`, the script next to the component,
   typed props and TypeScript declarations generated from Rust types. Solid is opt-in.
5. Scoped component stylesheets with design tokens and themes.
6. Cancellation on web standards: an `AbortSignal` for every island and request, and a request
   signal and deadline on the server.
7. Live data: `<corten-live>` fragments, and feeds (a snapshot plus numbered patches over
   server-sent events) that clients resume after a disconnect.
8. `corten-cluster`: one feed across many instances through a Postgres outbox, a leased relay to
   NATS JetStream and per-instance followers.
9. `corten-ui`: headless number field, combobox, tabs and menu button.
10. `corten::agent`: an app's actions as Model Context Protocol tools.
11. The `corten` CLI: `new`, `dev`, `build` and `check`.
12. Benchmarks against Leptos, SvelteKit, React Router, TanStack Start and Next.js in
    `bench/fullstack`.
