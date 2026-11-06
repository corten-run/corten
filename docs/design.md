# Design decisions and limits

[Back to the README](../README.md)

The [values](../README.md#values) decide what goes in. This file records how they turned into the
framework's shape, and what it does not do yet.

## Choices

1. **Markup is a Rust macro, not TSX.** Rendering TSX needs a JavaScript runtime on the server
   or a second toolchain in the app; `html!` keeps one language and compiles to the same string
   writes a hand-written renderer would do. Measured on the item page, `html!` renders as fast
   as the compiled templates it replaced (askama).
2. **No WASM.** Hydrating a WASM app costs hundreds of kilobytes before the page responds; the
   server already has the HTML, so the browser only needs behavior where there is behavior.
3. **No virtual DOM on the server.** Frameworks that build a view tree per request and then
   serialize it pay for it in throughput (Leptos in the
   [README benchmark](../README.md#performance)). `html!` writes straight to the
   response buffer.
4. **Plain functions, not a client framework, by default.** A handler is an exported function the
   markup calls with the elements it uses, run by one delegated listener per event type; there
   is no component instance, lifecycle class or hydration in the browser. Rows a script changes
   often are views: generated classes that read and write the server-rendered elements.
5. **Handlers are checked where they are called.** The compiler reads each script's JSDoc, so a
   call with a ref on the wrong element, an event of the wrong type, a value of the wrong type or
   a handler the script does not export fails to compile at the call. No generated declarations
   are needed between markup and script, and none can be stale.
6. **Plain CSS files, scoped by the compiler, not utility classes or CSS-in-Rust.** Utility
   frameworks put unchecked strings in every view and need a scanner and a build step; CSS in
   Rust needs inline styles the CSP blocks, or a runtime. A CSS file per component keeps the
   language designers know, and the macro makes its class names typed. Tokens cover the
   one-off values (spacing, direction per breakpoint) utilities are good at. A value drawn from
   data is a custom property the component's file registers (`@property`), set from markup as a
   typed number with a unit (`style={FILL.pct(42.0)}`): a full page carries them in one style
   block allowed by its hash (one header source, no nonce, so a cached page stays the same bytes,
   where a hash per style attribute would be one header source per value), and the runtime sets
   a patch's through the CSSOM, since a document keeps the policy it loaded with.
7. **A page is sent whole, not streamed in parts.** Streaming a slow section later in the same
   response sends the status and headers before that section exists, so a failure in it can no
   longer become an error page or a redirect; placing it out of order needs a script, so
   without JavaScript it lands at the end of the page; and with the data fetched together
   (`tokio::join!`) and rendering in microseconds, the most it saves is the slowest source's
   wait. A part that is slow and optional is a `<corten-live>` whose stream sends it when it is
   ready and ends.
8. **Static files are compiled into the program, a constant per file.** `embed!(pub struct
   Static = "static")` includes the directory when the crate compiles, so the binary is the
   whole deploy (no directory beside it to find or keep in step), and a page names a file by its
   constant, `req.asset(Static::STYLE_CSS)`: a typo or a removed file does not compile. A name
   that comes from data (an uploaded picture's) is `req.find_asset(name)`, an `Option`. The
   cost is that a file added with no change to the code is seen at the next build that compiles
   the crate, since a macro cannot ask cargo to watch a directory; `corten dev` reads the
   directory where the macro read it, so it serves the new file at once and restarts without a
   build when only those files changed (a removed file builds, so a page that names it does not
   compile), and the release Dockerfiles touch every source before
   building, so the crate compiles with every file. The PWA's icons, screenshots and worker
   script are named by their constants too; an image another site serves is a `Uri`.

9. **Work happens where it is fastest for the user.** The server renders the first page, so it
   arrives finished, and answers what only it can: a write, and data the page does not have. What
   the page can do with what it already has (sorting, filtering, selecting, a total, showing and
   hiding) is a handler, since no render is faster than no round trip; a view makes even 1,000
   rows fast to change ([README](../README.md#client-heavy-screens)). Rust renders on the server
   because it is the fastest renderer there, and plain JavaScript runs in the browser because no
   framework or WASM layer is faster than the platform's own DOM calls. The scripts guide has the
   table for choosing ([Server or browser](guide/scripts.md#server-or-browser)).
10. **The document is a component the app owns, not a shell Corten configures.** A page hands
   `req.page` its whole document, the app's layout with the page in it, and the head is markup
   like the rest (`<title>`, the page's tags, `<Corten />` where Corten adds its own), so there is
   no metadata builder, no shell hook and no second way to change the document. The default
   layout and error page live in the `corten new` template, where the app can read and change
   them, not in the crate. `html!` splits a document into the parts each request needs (the
   title for a data client; the title, head tags and `<main>` for a navigation), so a layout
   costs a navigation nothing: on the item page a full document got about 7% faster than with
   the shell and a navigation stayed within noise (`render_cost` medians of alternating runs,
   same bytes). The one navigation that reads the whole document is the one after a `data-patch`
   write that redirects, so what the write changed in the layout is drawn as a full load draws it.
   An element of the layout that depends on the page (a section's nav) is marked `page` and sent
   with `<main>`'s children, in place of the one on screen by its id, rather than adding a value
   to the shell key: a key would turn every link across sections into a full load, and a layout
   per section would repeat one document for each.
11. **A request says what it is with a `corten` header, not `Accept` or `Sec-Fetch-*`.** A
   navigation and an action both answer HTML, so no registered media type tells them apart, and
   `Accept` already chooses the format: `application/json` asks for a page's data
   (`Mode::Data`). Carrying the mode there too would need a media type parameter of Corten's own
   (`text/html;corten=nav`), as private as a header but mixed into the format choice that data
   clients, caches and proxies read as content negotiation. `Sec-Fetch-Mode` and `Sec-Fetch-Dest`
   tell a navigation from a `fetch` but not a navigation from an action, a script cannot set
   them, and data clients do not send them. With a header of its own, its absence is the safe
   answer: a browser request without it (and not asking for JSON) gets the whole document, as a
   browser without JavaScript needs. The mode would move to a standard header that says "part of
   a page" and that a script may set.
12. **The runtime prefetches links itself, not with Speculation Rules or `rel="prefetch"`.** A
   navigation the runtime makes asks with `corten: nav` and gets the title, head tags and
   `<main>`, a fraction of the document (all but the one after a write, which is never
   prefetched). A Speculation Rules prefetch fetches the whole document
   into a cache the browser uses only for a document navigation, not for the runtime's `fetch`. A
   `rel="prefetch"` response goes into the HTTP cache, but it is the document, sent without
   `corten: nav`, and answers vary on that header (`Vary: corten, accept`), so the runtime's
   request does not match it. Either would download more and still leave the runtime's
   navigation to fetch again. Speculation Rules would fit where the browser navigates anyway (full
   page loads, browsers without the Navigation API), and the runtime would drop its own once a
   prefetch can be asked with the runtime's headers and answer its `fetch`. A prefetch says what
   it is with `Purpose: prefetch`, the name Chromium sent before `Sec-Purpose` and server code
   already reads (Laravel's `Request::prefetch`), since a script may not set a `Sec-` header.
   Only a debug build reads it, to name a slow page; it is sent in a release build too, a few
   bytes a hover, so an app's logs can tell what a hover cost. A prefetch the visitor then clicks
   is the visit, with no further request, so a server answers it as it answers a click. It cannot
   tell which prefetches were followed, so visits are counted in the browser, not from the
   requests a server sees, with the header or without. The header goes
   when the runtime's prefetch becomes the browser's own, which sends `Sec-Purpose` itself.
   Which URLs are prefetched is the route's to say (`prefetch = false`, or a function of the
   route), not the handler's: a link to a costly
   URL then sends nothing on a hover, where a handler that refused a prefetch (a `204`) would
   still be asked, and a cache or a browser's own prefetch could hand that `204` to the click.
13. **Component CSS is scoped by prefixing its classes, not with `@scope`.** A prefixed class
   (`.offer-list__row`) matches nothing an app's global stylesheet or another component wrote, so
   a component looks the same on every page; with `@scope`, the class stays `.row` and any
   global `.row` rule still applies to it. A donut limit at nested components would also need every
   component's root marked (`data-scope` marks only those with refs, kept state or a handler
   taking `scope`), and a scoped selector competes on specificity and proximity where a prefixed
   class is one class. The typed class constants do not depend on the prefix. The macro would
   emit `@scope` when it gives the same isolation from global rules, at the same specificity.
14. **A feed patch is keyed `upsert` and `remove` of whole rows, not JSON Patch or Merge Patch.**
   A feed is a set of rows by id, and each write replaces rows or removes them. JSON Patch
   (RFC 6902) could say the same over an object keyed by id (`add` at `/<id>` replaces a row,
   `remove` removes it), but only as a subset: a client given JSON Patch is expected to take any
   path, `test`, `move` and `copy`, and ids would need JSON Pointer escaping (`~0`, `~1`), so a
   subscriber either carries a whole JSON Patch engine for two operations or rejects valid JSON
   Patch. Merge Patch (RFC 7396) merges a value into the old one field by field, so a row cannot
   be replaced whole, and its `null` means "delete", so a field cannot be null. Keyed whole rows
   are one encoding every subscriber applies the same way, in one pass, and `corten-protocol`
   holds it so native and agent clients do not write their own diffing
   ([architecture](architecture.md#rules-that-keep-surfaces-from-drifting), Rules 5). A feed would
   move to JSON Patch if subscribers needed to apply it with a stock JSON Patch library: each
   change as `add` or `remove` at `/<id>`, with the same sequence numbers and resume.
15. **An answer to the runtime says what it is with `corten-*` headers, not `Location`, a
   media type or `ETag`.** Only the runtime reads them, on answers to its own requests (Choice
   11), and nothing outside the framework may depend on them. A navigation or an action can be
   sent somewhere else, and `fetch` follows a 303 itself, dropping the fragment and hiding where it
   went (`redirect: "manual"` gives an opaque response with no `Location`), so the place goes in
   `corten-location` and the runtime navigates. The exception is a form sent on to another
   handler (`req.resend_to`): a 307 with `Location`, which `fetch` follows with the same body, since
   only a redirect the browser follows keeps it; where it went does not matter, as its answer is
   drawn as the write's own. A swap (`corten-page`) and a patch
   (`corten-patch`) are both `text/html`, and, as in Choice 11, a media type parameter of
   Corten's own would mix into content negotiation; a document a cache handed to a navigation
   fetch by mistake carries neither, so the runtime loads the URL in full. `corten-shell` is the
   key of the page around `<main>`, compared with the one the page loaded with, not a validator
   of the answer, so it is not an `ETag`, which caches and conditional requests read (a page's
   `ETag` is its body's, beside it).
   `corten-notice` hands the runtime a redirect's notice (`req.redirect_with_notice`) the page
   it swaps in (a navigation's answer, or the document after a write) did not draw, which it dispatches as `corten:notice`; the notice itself rides to the page
   in the `__Host-corten-notice` cookie, since `fetch` follows the redirect (in `corten-notice`,
   read only without `Sec-Fetch-Site`, for a write from a plain `http://` origin off loopback,
   which refuses a `Secure` cookie; never with `Policy::hsts`). Corten would move to
   `Location` once `fetch` can read a redirect's target without following it. The runtime
   sends `corten-notice` back, with the page's path, when a page it swapped in reads itself again
   (`ReadAgain`): the cookie is gone by then, and without the notice the read would differ from
   the page on screen and replace it, losing what the user typed. Only a `GET` for that path not
   from another site is read for it, and its answer varies by it.
16. **A look is classes on the app's element, not an element around it.** A component that only
   styles an element the app writes (a button, a field, a card, a badge) returns
   `impl ClassList`: `<button type="submit" class={Button { variant, size }}>`. Wrapping the
   element instead (`<Button><button>..</button></Button>`, with `display: contents` so it takes
   no box) changes the DOM though not the layout: a script's `parentElement`, a `:first-child`
   or `> button` rule and a `<summary>` that must be its `<details>`' first child all see the
   wrapper, and a wrapper's own element (a `<div>` card) cannot be the page's `<section>`, `<li>`
   or patch target. A look has no markup, so it has no script, refs or view; a component that
   draws structure or carries semantics (`Alert`'s role, a `<label>` around a control, `Table`'s
   scrolling box) renders its element. A kit component that
   styles a corten-ui widget (`Tabs` around `TabGroup`) wraps it, since the widget, not the app,
   writes the elements it styles; a widget whose one element the app styles takes a `class`
   instead (`CopyButton`).
17. **Behavior is a handler on any element, not a custom element per component; styles are
   prefixed classes, not shadow DOM.** A custom element does not need hydration (the browser
   upgrades the server's HTML in place), but behavior often belongs on an element whose parent
   takes only certain children, and a wrapper there is moved or breaks its parent: an `<x-row>`
   in a `<tbody>` is moved out of the table, and an `<x-sum>` around a `<summary>` hides the
   app's summary until its `<details>` opens, showing the browser's own label in its place
   (measured in Chromium 156, Firefox 157 and WebKit 27.2, the engines the repository's
   Playwright runs). The standard's answer, a customized built-in (`<tr is="x-row">`), does not
   run in WebKit, whose standards position opposes it. Elsewhere a wrapper still changes the DOM
   (Choice 16), each element would be a class instance where a handler is a function (Choice 4),
   and an element's attributes are strings the compiler does not see, where a handler call is
   checked at the markup (Choice 5). Shadow DOM would keep a kit look's classes, the app's global
   rules and the token utility classes out of the component (custom properties, so token values,
   still reach in), hide its ids from the patches that find their targets by id, and leave its
   fields out of the outer `<form>` unless the element is form-associated through
   `ElementInternals`, which needs script (Values 3). Corten uses a custom element where the
   behavior is the element's own rather than its markup's: `<corten-live>` holds a connection,
   shows its state on itself (`status`, `stale-since`) and announces it with `corten-status`,
   while the fragments it receives are patched into the page by id. An app can still render a
   library's custom elements with `html!`, which takes a hyphenated tag (`sl-button`). Customized
   built-ins in every engine would remove the reasons about where an element may stand and about
   a wrapper, since the element is the built-in itself; a component would still be a class
   instance per element whose attributes the compiler cannot check, so behavior moves to the
   standard only when one attaches it without a class instance per element and with attributes
   the compiler can check. Shadow DOM would fit a component that wants none of the app's styles,
   ids or form, which none of Corten's do.
18. **A component names a breakpoint as Media Queries 5's custom media does, and the app writes
   its width when it starts.** A component's `@media (--sm)` and `@media not (--sm)` are the
   standard's syntax, so the name reads as CSS and moves to the browser's own custom media unchanged.
   No engine reads it yet (Firefox has `@custom-media` behind a flag), so the name cannot reach the
   browser as written. The macro cannot write the width either: a component is compiled without
   the app's token files, and a kit's components may sit in a crate several apps share, each with
   its own theme. So the macro records where each name stands, and `Assets` writes
   `(min-width:<width>)` from the breakpoints of the token files in `App::components`, the ones
   the `md:` utility classes already use, when the app starts; a request serves the written
   stylesheet. A name with no width stops the app, as an undeclared `var()` does. A component
   does not define one (`@custom-media` does not compile), since a component that set its own
   width would switch apart from the theme. A custom property (`var(--sm)`) is not an answer: a
   media query does not read custom properties. When browsers read custom media, the app writes
   the token file's widths as `@custom-media` rules and serves the names as written.
   A breakpoint may name another (`"wide": "{md}"`), so a stylesheet several apps share names a
   role and each theme points it at one of its widths, rather than each app editing its copy or
   renaming its own breakpoints. It borrows the braces of a Design Tokens reference but not its
   path: breakpoints are Corten's extension, not tokens, so `{md}` names a breakpoint, and the
   format's `{group.token}` path would name a token that does not exist.
19. **A request's head may be 32 KiB unless the app raises it, and connections stay unbounded.**
   hyper's own ceiling is its read buffer, about 400 KiB, so a client that sends large heads and
   never finishes them held that much per connection for the header timeout: 4,000 of them took
   card-market to 913 MiB of its 1 GiB. 32 KiB matches nginx's limit (four 8 KiB buffers, no line
   over 8 KiB) and Kestrel's for headers (with 8 KiB more for its request line), and it holds what
   Corten itself sends: its cookie (`corten-zone`) and headers (`corten`, the notice) are a few
   hundred bytes, as is a route's URL. A larger head, or a URL past it, is answered 431 by hyper
   (with the limit raised above 64 KiB, a URL over 64 KiB gets 414), before any request exists,
   so it has no body and none of the app's headers, and a client still sending the rest may see
   the connection reset instead; a request past the 100 headers hyper allows gets the same 431.
   The size bounds the memory, so the count has no setting of its own. The limit also bounds a
   chunked body's trailers (hyper's were 16 KiB). `App::max_request_head` raises it, past
   hyper's read buffer too, for an app whose requests carry more. Measured on
   card-market (`--cpus 1 --memory 1g`, probed from a container on its network): 200 connections
   sending 300 KiB heads were each answered 431 and closed, and memory went from 1.0 to 1.3 MiB;
   4,000 holding heads just under 32 KiB, each sent in one write, took it from 3.4 to 225 MiB,
   about 57 KiB a connection (one flood), since hyper's read buffer grows past the head it holds.
   The memory is not given back when they close, and repeated floods of 30 KiB heads grow it more
   slowly each time (eight in a row held 217, 315, 374, 414, 431, 448, 454 and 464 MiB, with the
   file descriptors back to 10 after each); it is the allocator keeping freed pages, not
   something kept per connection: in a separate run of eight floods, glibc kept 419 MiB and
   jemalloc preloaded 45 MiB, with no climb from flood to flood (one run each; the guide gives
   the limits) ([#852 Memory a flood of unfinished request heads takes is not given back when the connections close, and each flood grows it further (217 to 464 MiB over eight)](https://github.com/corten-run/corten/issues/852)).
   `App::max_connections` stays unbounded unless set, as Kestrel's is: Corten cannot tell how
   much memory the process has to spare or how many connections its traffic needs, and a cap
   chosen for one host refuses real visitors on a larger one or does not protect a smaller one.
   The guide gives what each connection may hold and the peak repeated floods reach, so an app
   exposed directly sets it from its container's memory; a proxy in front bounds connections and
   heads before they reach the app.
20. **A value only the layout shows is read beside the handler and drawn into the finished page,
   not passed through handlers.** Markup renders synchronously inside the handler, so a value the
   layout draws must be awaited before the page is built. Passed as a prop, one cart count put an
   extractor on 172 handlers, lent it to 80 helpers and made closures take the awaited value in a
   real app
   ([#580 A layout value read the guide's way is passed through every handler and helper that can draw the layout, so one cart count touched 172 handlers in a real app](https://github.com/corten-run/corten/issues/580)),
   and a second such value would double that. An async render would make every `html!` a future for
   the sake of a few values; streaming the value in later is Choice 7's trade. So a `LayoutRead` is
   started as a page route (one whose answer is a page) is called for a whole document's `GET`,
   after the middleware and beside the handler, the layout writes `later::<T>()` where it goes, and
   once the handler has answered Corten awaits the read and draws its view in that place, before the
   app's middleware, compression, the ETag and any header see the page. The page is still sent
   whole: a failure is still an error page (which, for one the request is at fault for, an unknown
   address, a wrong method, a refusal other than a 429 or a request that does not parse, starts
   the reads not started yet and waits for them as a page does, and for any other, a handler's
   `Error` at any status but 404, a 5xx or a 429, draws a read that is in and starts or waits for
   none, since what failed is likely what the read needs), a redirect still drops (and stops) a
   read still running, and one already in stays for an error page the app's middleware makes of
   it. Two things follow from a navigation not starting the
   read. A caller only the read looked up makes the page private but stays out of its key, or a full
   load and a navigation would get different keys and every navigation would load in full; and the
   view is display markup only, since the page's head (its modules, its `style` hash) is written
   before the view is drawn. A place is noted by its offset as the page renders, so text that looks
   like one (`raw(..)`) is never filled; a page Corten does not fill (a navigation, a data client, a
   `Public` answer) has its places removed as it renders. A place for a read the app does not
   register cannot be found until a page draws it, so it is a debug build's error on that page
   rather than a startup check (Rules, 8). An app without layout reads pays a few extension lookups
   and a larger request future, 0.3% to 0.9% of the item page's instructions per request (86,037 to
   86,812, 85,723 to 86,402 and 86,189 to 86,438 in three alternating pairs of runs, callgrind; per
   function, most of it is the app's request future, `Wrapped::call`, which the reads' checks grew);
   it renders a page as it did before. The reads' state is boxed only in an app with them, since
   held inline it made every request run about 9.5k more, 8.4k of it copying the larger future. In
   an app with them, a whole document pays the reads' start and a copy of the page's body: a small
   page drawing a count read takes 42.5k instructions where the same page drawing a value its
   handler awaited takes 28.8k. A plain axum handler that takes `Req` starts the reads whatever it
   answers (its answer type is not known there), and so does a `PageOr` or `SwitchOr` that answers a
   file or an upgrade: each read's `start` runs (a read that looks up the caller starts that lookup)
   and the reads are polled with the handler, then dropped unused, since the answer has no places. A
   `Public` answer draws none of their values however they were started. A route whose page always
   gives a read's value says `gives(CartCount)` in its routes module, so the read is not started for
   it; the read starts before the handler, so only the route can say this in time
   ([#869 A page that gives a layout read's value still starts the read, so its query runs and is dropped](https://github.com/corten-run/corten/issues/869)).
   The route marks the request with the reads it names (a layer on its handlers; a route without
   `gives` pays one extension lookup per page `GET`), and a page that does not give one is a debug
   build's error rather than a compile-time one, since whether a page gives a value is known only
   once it answers.
22. **A page's locale is negotiated from `Accept-Language` unless its URL names one, and a shared
   page names one.** Negotiation with `Vary: accept-language` is HTTP's own (RFC 9110, 12.5.4)
   and right for a page that is one person's. A shared cache keys it on the raw header: one copy
   per browser's string (`en-US,en;q=0.9` and `en` are two of the same English page) where it
   honors `Vary`, which CloudFront's guide warns of, and one language for everyone where it does
   not; Cloudflare keeps one per locale only under a rule that normalizes the header. CDN
   guidance and other frameworks (Next.js's locale paths, Django's `i18n_patterns`) put the
   locale in the URL, so the URL is the key. So a route takes it as a field,
   `corten::i18n::Locale<Msg>`, read only as a tag `messages!` lists, and the handler gives it to
   `req.set_locale`: `req.t()`, `req.lang()` and the error page follow it, the answer does not
   vary on `Accept-Language`, and the locale is part of the page's shell key, since the layout
   around `<main>` is in it. The field is a type of its own rather than the messages type, which
   would need `Display` to be written in a URL and would then render as its tag wherever a view
   wrote `{t}` by mistake. The tag reads only as `messages!` lists it, so a page has one URL per
   locale, and as any path parameter that does not read, another is a 400 (so a route at `/{lang}`
   answers 400 for a one-segment URL no other route takes). Only a request whose handler sets the
   locale is in it: a form, patch or stream route the page uses takes the field too. Every page in
   an app with messages says its locale in `Content-Language` (RFC 9110, 8.5.4), so a client or a
   cache can see which it got. Not chosen:
   refusing to compile a `Public` page in an app with messages (whether its locale is in its URL
   is known only when the handler runs, and a normalizing cache is a sound deploy), and a debug
   warning on every such page (noise for that deploy)
   ([#784 A Public page in an app with messages varies on the raw Accept-Language header, so a CDN keeps one copy per browser's header string, or serves one language to everyone if it ignores Vary](https://github.com/corten-run/corten/issues/784)).

21. **An app's own extractor implements axum's `FromRequestParts`, named `corten::extract`, not a
   trait of Corten's.** An app reads a value from the request's head (a visitor's cookie, a
   started read) with an extractor of its own, and before this it named axum to write one, as it
   did for a middleware's `Request` and `Response`, a relay's `Body`, an upload's `Bytes` and a
   listener of its own. A Corten trait in its place cannot reach axum's under it: handlers are
   still axum's `Handler`, so every argument must implement axum's `FromRequestParts` (the last,
   `FromRequest`), and Rust's orphan rule forbids the blanket
   `impl<T: FromHead<S>> FromRequestParts<S> for T` that would bridge the two. Each type would
   need both impls, Corten's own `Req`, `Caller` and `Params` included, or a derive written per
   type: a second concept for the same signature (Values, 6). So `corten::extract` names
   `FromRequestParts`, `OptionalFromRequestParts`, `FromRequest`, `Request` and `State`,
   `corten::middleware` names `Response` and `IntoResponse`, `corten::answer` names `Body`, and
   `corten::Bytes` and `corten::Listener` the rest: the same types and traits, so an app imports
   Corten alone. What this does not buy is independence from axum's versions: the traits' shape
   is still axum's, and an axum major version that changes it (0.8 dropped `#[async_trait]` and
   added `OptionalFromRequestParts`) changes an app's extractors with the Corten release that moves to it.
   That waits on Corten owning the handler traits
   ([#761 Corten wraps most of axum but still depends on its router, handler traits and SSE, which tie its public API and diagnostics to axum's](https://github.com/corten-run/corten/issues/761)),
   which should keep these names, the `Rejection` that makes a response and the
   `from_request_parts(parts, state)` signature, so impls written against these paths keep
   compiling. The traits come from `axum-core` (already in axum's tree, kept at axum's version),
   since axum's own paths also carry axum's derives of the same names when its `macros` feature
   is on anywhere in the build: Corten's names would then change with another crate's feature, and
   `corten::FromRef`, the derive and the trait at once, would collide. Nothing on the request
   path changes: these are re-exports. axum's `Path`, `Query` and `RawQuery` are left unnamed on
   purpose: a route's path and query are read as its `Params`, and a second reader would be a
   second way. A handler that takes the whole `Request` reads its body up to a limit of its own
   with `corten::extract::bytes_up_to`, as an upload's file is read with `File::bytes_up_to`, not
   axum's `to_bytes`, whose one error is both a body over the limit and one that broke, and
   which leaves the rest of a body over it unread, so a client still sending can miss the
   answer. `corten::axum` stays
   for a stand-in server in a test (its `Router` and `serve`): the stand-in is another server
   the app calls, not the app, so a Corten name for it would be a second server API for tests
   alone, and `serve_on` would give the stand-in the app's defaults (its security headers, its
   shutdown) that the server it stands in for does not have.

## Rules

1. Markup is written in `html!`, never built from strings in a script. A script makes new
   elements by cloning markup the server rendered (a `<template ref={rest}>`, or a view's rows,
   `rows(..).push(items)`, filled through typed holes), and moves, shows, hides or writes the
   ones on the page. (One exception: `ComboBox` mirrors the server's `<option>`s into its
   listbox, so each option is sent once.) The browser holds scripts to it: pages require Trusted
   Types, and only the runtime's policy, which takes the server's answers to its own requests, may
   turn a string into markup ([app guide](guide/app.md#a-policy-for-part-of-the-app)).
2. A fragment that can be patched is a component, rendered by the page and by the patch, so the
   two cannot drift. It is declared `-> impl Patch`, and its markup's top-level elements each have
   a `#[derive(Id)]` id, which the compiler checks (`view::Patch`), so no patch loses an element in
   the browser.
3. A handler reaches the page only through its arguments: refs, `event`, `target`, `signal`,
   `scope` and values. State that outlives an event is the DOM itself or `keep(init)`, the
   running handler's component's own. (Three exceptions: `CopyButton` copies an element outside
   its component, which it is given as a typed `Id` value and finds by that id, since refs do
   not reach outside a component; `RelativeTime` keeps the page's relative times in its
   module, so one timer serves them all, with a `visibilitychange` and a `pageshow` listener for
   the life of the page that read the clock again when it comes back; and `rows::sort` writes the
   order it drew into the `ReadAgain::from` tag of the part around its table, which the server
   puts beside the part as a patch instruction, so no ref can name it, and into where the forms
   in that part post, looking only beside the elements with an id around the table, as the
   runtime finds a part. A form or link elsewhere whose route reads the order calls
   `ordered::send` (a form's `on:submit`) or `ordered::link` (a link's `on:connect`) from its
   own markup with the tables' ids, `ElementId`s made from their `#[derive(Id)]` types, as
   `CopyButton` is given the element it copies, and it reads the order from the address when it
   is sent or about to be followed; nothing searches the page for them.)
4. User-facing text lives in views, the view model or the catalog, never in scripts. Which of
   the first and the last is one rule per app (`docs/guide/views.md`, Text): an app with one
   locale writes fixed text as literals in its views, and the catalog holds only what needs it (a
   count, text with arguments, text a script fills); an app with more than one locale writes all of it through the
   catalog. Text that
   depends on what a script computed ("3 selected") is a catalog message the markup passes
   unfilled (`t.js().rows_selected()`) and the script fills in (`label({ count })`): the
   browser formats it with no round trip, and the compiler checks its arguments against the
   handler's `Message<"count">` (`docs/guide/scripts.md`, Text a script computes).
5. Pages and actions work without JavaScript: links are links and forms post. A feature only a
   browser can provide (drag and drop, a canvas) needs JavaScript; one that makes a server action
   instant (filtering the rows on the page as you type) keeps the form that does it without.
6. A page another surface reads derives `Serialize`, and its fields are its whole view model
   (formatted text included). Then `req.screen` gives every surface the same data.
7. `App` configures the whole app; a part of it under a URL prefix is an `Area` (or an `Api`
   for routes that answer only JSON), which owns its routes. Its prefix and its routes are route
   types (`#[corten::routes(area = Admin)]` or `(api = ApiRoot)` on the module of its routes,
   `.area(admin::area)`), so a route outside the prefix does not compile. A new setting that applies to a prefix goes on `Area` or `Api`, never on
   `App` as a method taking a prefix string. Who is asking is not a setting: a handler takes
   `Caller<T>`, and an area's routes module says `caller = T`, so a handler there that does not
   take it does not compile. Before adding to `App`, check whether the
   setting belongs on one of those, and whether the builder still reads as one list of settings
   with one way to give each; reorganize it when it does not, rather than add a second way.
8. A mistake the compiler can see is a compile error, with a `compile_fail` doctest: a type, a
   trait bound, or a `const` assertion over a route's `PATH`. One it cannot see (two settings
   that clash, a `var(--x)` no stylesheet on its pages declares, a PWA that names a static file in
   an app given no static directory)
   fails at startup, and only what depends on the
   request is checked per request. A check that moves earlier also leaves the request path.
9. A layout's props are what most pages set: the title and the page's own head tags. A page that
   needs a different document (a print view, an embed) uses another layout component; a layout
   does not grow a flag per page.
10. A header, wire format or file format that leaves Corten (read by another client, another
    tool, or a person writing the file) follows the standard for it where one exists: Problem
    Details for JSON failures, CLDR for number and date formats, the W3C Design Tokens format
    (2025.10) for token files, with Corten's own settings under its `$extensions` key,
    `run.corten`. `tokens!` reads that format with these limits, each a compile error that says
    so (and the guide lists the bounds on nesting, work, chains and combinations of contexts, which
    keep a hostile file from stalling or overflowing the compiler): a resolver modifier needs a `default` (the stylesheet has no input to ask for, and a page
    that chooses no context needs values), a `$root` token at the top of a file has no name to be
    a custom property, a file is a path relative to the one naming it (no URL, scheme, drive or absolute path; a
    workspace's shared tokens in `../` are allowed, as `include_str!` allows them), a
    gradient or typography token has no one CSS value, and a group does not go over a token, nor a
    token over a group with tokens in it, when sources merge or a group `$extends` another (the
    resolver's rule, the later wins, would drop one side's tokens without a word; the token goes
    in the group as its `$root`). Where Corten defines its own instead, a Choice above names the standard it considered, why it does not fit, and what
    would let Corten move to it (Choices 11 to 15). A format only Corten's own
    server and runtime read (the `data-on` wire format) needs no standard, but stays internal:
    nothing outside the framework may depend on it.

## Limits

1. Client navigation uses the Navigation API (Chrome, Edge, Firefox 147+, Safari 26.2+); older
   browsers do full page loads, and forms, patches and handlers still work.
2. Patches replace whole elements: the server's markup wins, except for what the user is doing.
   A field they edited keeps its value (for the form that was sent, edited after it was sent),
   and focus and the caret move to the matching element (same id; else, inside the nearest
   element with an id, the same name; focus also follows an element without either to the same
   place). A field without an id or a unique name takes the server's value. Other browser
   state inside a replaced element (an open `<details>`, scroll position) resets, so keep
   targets small.
3. `<script>` tags inside swapped pages do not run. Put behavior in a component's script.
4. Handlers run from one listener per event type on the document, so a third-party listener that
   stops an event before it reaches the document stops its handlers too, as in any delegating
   framework. Markup the runtime inserts (a navigation, a patch) waits for the modules its
   handlers name, so those handlers always run while their event is dispatched. On the first
   page, an event that arrives before its module (a click while the page still loads) gets the
   browser's default and no handler, as it would without JavaScript; the page loads its
   modules as module scripts that hand their exports to the runtime as they run, so their handlers are
   in before `DOMContentLoaded`, and this needs a person faster than the network.
5. Offline is a fallback page plus cached versioned files, not offline data.
6. Hover and touch prefetch reuses a fetched page for up to 10 seconds (cleared after any form
   post). It keeps the 8 newest and aborts the rest (the request, or the body once it answered),
   so hovering does not hold pages for the whole session; with the browser's data saver on it
   fetches nothing. A route that is costly to draw says `prefetch = false`, or names a function
   of the route for the URLs that are (`prefetch = cheap`), and links to those carry
   `data-no-prefetch`.
7. A feed's write rate is bounded by Postgres commit latency on its feed row. Split hot data into
   several feeds.
8. `html!` views render once and own what they capture; read from `req` before building the view.
   A value borrowed from one the view owns is computed inside the markup:
   `html! { let shown = saved.as_deref().unwrap_or(typed); <input value={shown}> }`.
9. Component stylesheets support plain CSS with nesting and `@media`, `@supports`, `@container`,
   `@layer`, `@keyframes` and `@font-face`; `@import` and escaped class names are not supported.
   Keyframe names are not scoped, so an area's keyframes share one namespace with the rest.
   Every component listed in `App::components` is in one file, whether or not a page uses it: the
   item page's `components.css` (the hidden rules, tokens, two themes, two densities, utilities
   and six components) is 6,955 bytes, 1,573 brotli (measured). `Area::components` moves the components only some pages render into a file
   linked from those pages; the split is by URL prefix, chosen by the app, not detected from what
   a page renders, which would cost every render.
   The lists are written by hand. `corten check` reads the source for a component with a
   stylesheet, script or view that no array names (a `COMPONENTS` list, `.components(&[..])`),
   and a debug build refuses a page that draws one its area does not get. The scan sees names,
   not whether a list reaches `App::components`. A build-time check could do more for a child
   whose type `html!` knows (an inherent constant on each component, `None` for a hand-written
   `Render`, walked at startup), but not for a generic child, whose type is known only where it is
   drawn. It is not built, and the scan answers the reported case, a styled component no list
   names
   ([#980 Check at startup that a listed component's styled children are served with it, so the list check runs in every build and covers areas](https://github.com/corten-run/corten/issues/980)).
10. `corten-ui` is tested in Chromium, Firefox and WebKit (Playwright's builds). Its popups are placed by the design system's CSS with
   anchor positioning (Baseline since January 2026); a browser without it shows them where
   `popover` puts them by default, centered. Tabs are horizontal.
    Its names in the page are prefixed (`ui.combo_box.js`, `data-scope="ui-combo-box"`) through
    `[package.metadata.corten] scripts = "ui"`, so an app's own components never collide with
    them. Two of an app's own scripts with one file name are a startup error that names both.
11. Who may use a route is in its handler's type: it takes `Caller<T>`, whose `Identify` finds
    the caller or refuses (sign in, 401, 403, 503), and a routes module's `caller = T` holds
    every handler in it to that, checked at compile time, so a route added later is covered.
    The lookup runs only when a handler or middleware reads it, once per request, and reading
    it makes the answer private. A route's answer type says how it fails (`HtmlResult`: the
    error page; `JsonResult<T>`: JSON) and whether a shared cache may keep it (`Public<..>`,
    whose handler may only take `Anonymous` inputs and whose page cannot set a cookie). A route
    that says `no_store` is checked as answering `NoStore<..>` of its handler's type (`no_store(post)`:
    only the handlers of the methods it names), so that one word in the route, not the handler's
    signature, says nothing may keep it; a handler there
    that returns `NoStore<..>` too says it twice, and a hand-added route says it with
    `NoStore<..>`. A check
    that depends on the record (the author, the organization) stays in its handler. That an
    area's or an API's routes are under its prefix is a `const` assertion, which the compiler
    evaluates when it builds the app (`cargo build`, `cargo test`, `corten check`), not under
    `cargo check` alone. Every route reaches the app through these checks: `App::new` takes the
    `Routes` a
    `#[corten::routes]` module makes, and `Area::route` and `Api::route` take `Methods`, made
    by Corten's `get`, `post` and the others, which check the same things. A plain axum
    `Router` or method router does not fit any of them, so there is no unchecked way in. A
    WebSocket (`Upgrade`) and another server's answer passed on (`Relay`) are such routes too.
12. A request goes through fixed stages in one order (`corten::middleware`); the app's own
    steps are a `Middleware` tuple at one place in it, resolved at compile time, not hooks at
    several. An area's or an API's own steps (`Area::middleware`, `Api::middleware`) run right
    after the app's, for the requests at its prefix; they are boxed, since which run depends on
    the path, and an app with none pays nothing for them.
13. A connection switches protocols (a WebSocket, a relayed tunnel) only over HTTP/1.1 served by
    `corten::serve`; HTTP/2's extended `CONNECT` is not supported. Corten reads the handshake
    and hands over the bytes: frames, message limits, buffering and per-message checks are the
    WebSocket library's and the route's, though `App::send_timeout` still ends a write the client
    makes no room for. The work on a switched connection is told when shutdown begins and is not
    waited for.
14. Connections are HTTP/1.1. A request's head must arrive within `App::header_timeout` (30
    seconds), which also closes an idle keep-alive connection, and be at most
    `App::max_request_head` (32 KiB, Choice 19) with at most 100 headers; an answer must make
    progress, a write that finds the send buffer full waiting at most `App::send_timeout` (60
    seconds, nginx's `send_timeout` and its meaning, rather than Kestrel's minimum rate of 240
    bytes a second, which needs a count of bytes and a window per connection); how many may be open
    is `App::max_connections`, unbounded unless set. HTTP/2 and HTTP/3 to browsers come from a proxy
    or CDN in front of `corten::serve`. An app with live streams needs one: over HTTP/1.1 a
    browser opens about six connections to a host, each open stream holds one, and requests queue
    behind them once a page with a few `<corten-live>` elements or feeds is open in a few tabs.
    That holds for `serve_wrapped` too, which ends TLS but still speaks HTTP/1.1, so an app with
    live streams has a proxy or CDN in front whatever ends its TLS. Measured with
    `examples/watchlist` (two streams a page) in Chromium: over HTTP/1.1 through nginx, a fourth
    tab got no answer in 15 seconds and nginx logged three documents; through the configuration
    in [Deploying](guide/deploy.md#nginx) with `http2 on`, all eight tabs loaded over `h2`, the
    first in 1.0 s and the other seven in 212 to 471 ms. Corten cannot check this at startup: a
    stream is a handler's return type (`LiveResponse`, `FeedResponse`), and a feed's `rows`
    does not say whether a route streams, since its snapshot route has them too; and
    `serve_wrapped` behind a proxy that re-encrypts to the app is right with live streams, so the
    guide says it. HTTP/2 in Corten (hyper's
    `http2`, chosen by ALPN in `serve_wrapped`) was weighed and left out: it adds a second
    answer to each per-connection rule (a concurrent-streams limit beside
    `App::max_connections`, a `GOAWAY` drain at shutdown, `App::header_timeout` per stream, and
    WebSockets over extended `CONNECT`, Limit 13), which the proxy handles or makes unnecessary,
    and eight crates to the template's build (`h2`, `tokio-util`, `indexmap` and five smaller).
    HTTP/3 (QUIC over UDP with TLS in the process, `quinn` and `h3`, `Alt-Svc` and a TCP
    fallback where UDP is blocked) gains last-mile latency and loss recovery, which an edge near
    the user gives better than an origin. Either reopens for an app that must serve browsers with
    no proxy at all and has live streams; HTTP/3 also waits for a stable `h3`.
15. A component script's comments are removed by a scan that knows strings, template literals
    and regular expressions but is not a JavaScript parser. Where only a parser could tell a
    division from a regular expression (a `/` after a statement-level `}`, after `++` or `--`, or
    starting a line after a value, as after `continue` or `let t`), the script is served as
    written, comments included: correct, only larger. None of the repo's scripts is; of 1,230
    third-party files with comments, 161 (mostly minified bundles) were.
16. JSON numbers have one form, serde_json's, in responses, feeds and agent output: a whole float
    keeps its fraction (`2.0`), where JavaScript's `JSON.stringify` writes `2`. There is no switch
    to JavaScript's form: a second form would split the surfaces and still not give canonical bytes.
    Text that must match another service's is the app's own (`Raw`, or serde_json's `RawValue`
    where `Serialize` writes it), and a shared checksum is over RFC 8785 (the app guide, Numbers in
    JSON).
17. An event stream's (`corten::event_stream`) event names and data are not checked against the
    script that reads them, as a feed's rows are (`rows = Row`, `FeedUrl<Row>`): the script
    listens by a name it writes and parses the data untyped. Prefer `<corten-live>` or a feed
    where either fits. Typing them is left out until an app needs it: nothing but corten's own tests
    and docs uses event streams, and the typing would add a route attribute, a declaration kind and runtime
    code every page loads. An app that needs it starts from `#[event]`, whose names are checked
    and whose shapes `corten/events` declares, rather than a second event model
    ([#591 An event stream's names and data are strings the script reads untyped, where a feed's rows are checked from the route to the script](https://github.com/corten-run/corten/issues/591), closed as not planned).
18. A file input left empty is no file to `Upload`: the browser sends a part with an empty file
    name and no bytes, which `FormData` keeps as an empty `File` and `next_file` passes over. A
    route cannot tell that input from one the form lacks. Handing out empty files would make every
    handler that loops over files skip them to get the same answer, and a file the user did choose
    is never both nameless and empty, so the distinction is left out. A part with bytes is a file
    whatever its name.
19. A handler passed to a component as a prop (`on:sort={..}` on the kit's `SortHeader`) is typed
    by the prop, not by the element the component puts it on: its `event` is an `Event` and its
    `target` an `HTMLElement`, so its script narrows (`event instanceof MouseEvent`) where an
    `on:click` written on an `<a>` declares `MouseEvent` and `HTMLAnchorElement`. Typing a prop by
    the event and element it lands on would make each prop name its element's type, and the
    arguments the call passes (a column, as a Rust type) are checked either way.
20. The `Permissions-Policy` a document is sent (`Feature`) is enforced by Chromium-based browsers
    (measured in Chromium 156: with the location granted, `geolocation=()` refuses it). Firefox 157
    and WebKit 27.2 gave the location under the same header (probed), so in them the features it
    denies are the browser's to grant, as before. Chromium on Linux, without Web Bluetooth, logs one
    warning a page load for the `bluetooth` name.
21. A shared cache in front of the app must key on `Vary` (RFC 9111). One URL answers a page's
    document, a client navigation, a form and a data client's JSON, so a native app or an agent
    reads the screen the browser shows at the address the browser shows, and only the document is
    ever sent public. A cache that keys on the URL alone hands that document to the other three: the
    runtime sees no `corten-page` and loads the URL as a whole page, and a data client gets HTML for
    JSON (measured with nginx `proxy_ignore_headers Vary`); nothing private is stored either way. A
    data URL of its own per page would double every route and link to spare a cache setting: nginx
    keys on `Vary` by default, Cloudflare's Cache Rules can since July 2026, and CloudFront keys on
    the headers its cache policy lists, so the deploy guide names the setting for each instead.
    Corten cannot see which cache is in front, so this is not checked; an app behind one that cannot
    key on `Vary` serves its data clients from `App::api` routes, whose URLs are their own.
22. The `ETag` of a page route's answer is a 64-bit hash of its body, its `Content-Type` and its
    `corten-*` headers, made with the standard library's `RandomState`, keyed randomly when the
    process starts (SipHash 1-3 today; the standard library promises a keyed hash that resists
    chosen collisions, not the algorithm), so nobody outside the process can make two bodies share a
    tag and have a client keep a page that changed. A tag from another process does not match: after
    a restart, or behind a load balancer that sends a client to another instance, the page is sent
    whole, as it was before pages had tags. WebKit 27.2 sends no `If-None-Match` on a reload or a
    `fetch` (probed), so the runtime's navigations there always get the whole page. With the
    `compress` feature, a client that accepts no compression and names no tag is sent none: it is
    not a browser keeping pages (a benchmark, `curl`), and for a page the hash would cost about a
    third of the render, so a CDN that fetches pages uncompressed cannot revalidate them. A file of
    a type compression does not vary on (a PNG, a PDF, `no-transform`) is tagged for every other
    client, since its `304` saves the whole body. Its `Vary` does not name `Accept-Encoding`, though
    whether it carries a tag depends on it, so a shared cache whose fetch of a public file accepted
    no compression and named no tag keeps a copy it cannot revalidate: a whole fetch, never a wrong
    answer. A file is hashed on each such request, about 2.5 instructions a byte (a 1 MiB PNG
    `Media` took 2,645,906 instructions a request on `f56bef59` where it took 20,824 on `cdce43c7`,
    callgrind, release build, five runs, ranges under 0.01%), so a large file whose URL can name its
    content is better sent `Public::immutable`, which is never tagged. Other headers of the app's
    are not in the tag, so one that only some answers at a URL carry (`Content-Disposition`) stays
    on a cache's copy after a `304`. An app value drawn at random for each render (a token in the
    markup) makes a tag that never matches and still costs its hash; Corten skips the hash for its
    own (the nonce, a submit key), which saves time only, and not for a submit key placed as
    `raw(..)` markup.
23. A multipart body is read up to 64 MiB past its limit, what a file the handler passes over
    included, so the browser is answered with the form's message rather than a reset connection.
    Each such request holds its connection and searches what it reads for the next boundary, which
    the client chose along with the bytes. A byte-by-byte search is linear too (at most the
    delimiter's length of work a byte), but slow on bytes the client picks: `memchr`'s substring
    search, already in axum's tree, searched 60 MiB 4.5 times as fast of plain bytes, 35 times of
    `\r`, 23 times of `\r\n` and 2.3 times of the delimiter less its last byte, repeated (the search
    alone, release, medians of 7, in 16 KiB pieces). Read whole, 8 MiB within the limit in 16 KiB
    pieces took 2.2 ms of plain bytes against 6.8 to 7.2 before, 2.7 to 2.9 ms of `\r` against 51 to
    56, and 5.7 to 5.8 ms of the near-delimiter against 11.3 to 11.7; in 1 MiB pieces of `\r`, 5.5
    to 5.7 ms against 52 to 53 (release, medians of 11, three alternated rounds). The client picks
    the pieces too, and a piece has a cost of its own: what is held of the last one (the start of a
    delimiter, a part's headers so far) is joined to it, a piece under 1 KiB in room that is reused,
    and a part's headers are searched once, not from their start at each piece. In 1-byte pieces (an
    HTTP chunk each) 1 MiB of `\r` took 846.6M instructions against 1,221.6M before, of the
    near-delimiter 649.8M against 821.1M, and of plain bytes 575.7M as before; 250 heads of 8,000
    bytes 1,972.7M against 42,531M, the same bytes with short heads 1,102.6M against 1,097.2M. In 16
    KiB pieces 8 MiB took 122.2M against 160.2M of plain bytes, 245.0M against 273.7M of the
    near-delimiter and 139.4M against 529.4M of `\r` (callgrind, release, three requests less one
    over two, the same in two runs; the counts take in the benchmark's making of each body; the 16
    KiB counts with the limit at 16 MiB, so both builds read all 8 MiB). So a request is bounded by
    its size (its limit plus 64 MiB), not by a time, and `App::max_connections`, when set, bounds
    how many are read at once. A file read with `bytes_up_to` keeps its pieces of 1 KiB or more as
    they came (slices of buffers already held) and copies runs of smaller ones into one buffer,
    joining them once at the end, so a file sent a few bytes at a time holds about its size: 8 MiB
    kept in 1-byte pieces peaked at 21.7 MiB against 277.7 MiB before, and 1 MiB of `\r` at 7.1 MiB
    against 86 MiB; passed over in 1-byte pieces, 12.7 MiB both. In 16 KiB pieces the runs varied
    more than the builds (12.5 and 7.7 MiB before, 12.7 and 4.0 after), so no difference is claimed
    there (peak working set, release, two runs, limit 16 MiB). A file under 64 KiB that came in one
    piece is copied out of it, since the piece can be a slice of a read buffer of hundreds of KiB
    that keeping it would hold.
24. CSP reports (`Policy::report_to`) reach the app from Firefox and WebKit, in two shapes:
    Firefox 157 posts a batch in the Reporting API's format (`application/reports+json`, a list)
    with `Origin` set, and WebKit 27.2 posts each report alone as `application/csp-report` with
    `Origin: null` (probed; both say `Sec-Fetch-Site: same-origin`, so the write check lets them
    through). `security::Violations` reads both, since an app reading the Reporting API's shape
    alone would refuse every WebKit report. Chromium 156 (Playwright's build) queued its reports
    for a local endpoint and sent none, so its delivery is not tested. The old `report-uri`
    directive is not written: a browser that reads `report-to` ignores it, and the current
    release of each engine reads `report-to`, so the cost is older releases still in use (an
    older Safari or Firefox), which send nothing. `Violations` still reads the older shape, which
    a collector may forward. The route is checked at compile time: `report_to` takes a route only
    if it has a `post` handler in a module without `caller =`, since a browser posts without the
    visitor's session and a refused report is dropped without a word (a handler that takes a
    `Caller` itself is not seen). `Permissions-Policy` violations are not reported to the
    endpoint, and a trial of one directive beside the enforced policy is not built in: the
    enforced policy's reports show what a change must allow, and `report_only` tries the whole
    policy.
