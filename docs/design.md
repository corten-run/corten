# Design decisions and limits

[Back to the README](../README.md)

The [values](../README.md#values) decide what goes in. This file records how they turned into the
framework's shape, and what it does not do.

Each Choice, Rule and Limit has an anchor after its number, and a citation links to it: in
Markdown `[design Choice 20](../design.md#choice-layout-reads)`, in code the path alone,
`docs/design.md#choice-layout-reads`. A new item goes at the end of its list with an anchor of its
own, so no citation moves. Removing one, or inserting one, keeps every link pointing where it did,
but the links' text still names the old numbers: `npm run check` (`scripts/design-refs.mjs`)
lists each one to correct, and fails on a citation by number with no link and a link to an anchor
that is gone.

## Choices

Each Choice ends with what it stands on, what would reopen it and when its evidence was last
checked, so a later change can tell when it takes a reason away, and a reader can tell a choice
the repository measured from one it argued or assumed, and fresh evidence from old.

Stands on names each premise the choice depends on with its kind, the one most likely to move
first and a value last:

1. measured: a number taken in this repository, with where it was taken and how often, or a
   word that says what is missing ("runs not recorded", "of whole frameworks only").
2. platform: what a standard, a browser or a library does today. Browsers are the engines the
   repository's Playwright runs.
3. reasoned: an argument anyone can check by reading the code or the standard, with no number
   behind it.
4. bet: an assumption about apps, their users, hosts or deploys that nothing here has measured.
5. value: what the README's [values](../README.md#values) ask for; it moves only if a value or
   their order does.

Revisit when names a condition someone can check: a browser shipping a feature, a number
crossing a line, an app needing what the choice rules out. Where nothing in sight would reopen a
choice, it says so and why. A change that makes a condition true, or takes away a premise, reopens
the Choice in the same pull request, which rewrites it or gives it the reason it now stands on
([Review](../CONTRIBUTING.md#review)). A pull request that moves the repository to newer browsers
(Playwright's version in `package.json`) reads the Choices that stand on the platform again
against them.

Last checked dates the evidence, an entry for each measured or platform premise (two that were
checked together share one): the date it was taken, or recorded where the run was not dated, and the
commit it ran on or was recorded in; or the date a platform was probed or read and the versions (the
engines Playwright runs, a crate's version in `Cargo.lock`, rustc's), or, for a source with no
version (a vendor's guide, a registry, an open proposal), the commit it was read at or the one that
wrote it. A Choice with neither kind dates the evidence its reasoning was last checked against, or
the commit that wrote it. An entry moves only when its evidence is taken, probed or read again, and
the pull request that moves it says how, so the next check can repeat it; an old date is the premise
to check next. `npm run check` refuses a Choice without all three, a premise of a kind not listed
here or a value before another kind, a Last checked entry without a date no later than today and a
commit or versions, and Choices out of order (`scripts/choices.mjs`).

The Rules and Limits below have none of the three: a Rule applies the values to code and changes
with them, and a Limit is what Corten does not do, saying, where it is known, what would lift it
or why it is so by design. A decision about the framework's shape is a Choice, even where it
rules something out.

1. <a id="choice-markup-macro"></a>**Markup is a Rust macro, not TSX.** Rendering TSX needs a JavaScript runtime on the server
   or a second toolchain in the app; `html!` keeps one language and compiles to the same string
   writes a hand-written renderer would do. On the benchmark's item page it writes the document in
   fewer instructions than Maud, a Rust macro of the same kind, takes for the same visible page.

   Stands on: measured (callgrind, three rounds of each at `ff1701b8`, alternating, each
   function with what it calls: card-market's `Req::render_into`, the whole document, took 44,494
   instructions a request in every round, with its own extra work in it, the head's tags, a data
   attribute a listing row and prices, ratings and counts in the visitor's locale, for 8,931 bytes;
   the axum + Maud app's `pages::item` took 53,935 to 53,937 for 7,473 bytes; Maud 0.27.0's
   escaping, which pushes each byte on its own, is 38,060 of it against `html!`'s `escape_into`
   at 12,881: that gap, 25,179, is larger than the whole difference of 9,441 to 9,443, and outside
   escaping `html!` does about twice Maud's work, 31,613 against 15,877, so a Maud release that
   escaped as cheaply would reverse it); value (one language and one toolchain in an app, Values 6).

   Revisit when: `Req::render_into` on card-market's item page counts more instructions than
   `pages::item` in the axum + Maud app, or than another compiled template engine writing the
   same page, by more than the runs' range (the benchmark README has the command); the axum + Maud
   app moves past maud 0.27.0; or TSX compiles for the server with no JavaScript runtime and no
   second toolchain in the app.

   Last checked: 2026-11-06, the callgrind rounds of card-market and axum + Maud (maud 0.27.0) at
   `ff1701b8`
   ([#963 Design Choice 1 rests on an unrecorded askama comparison; it should state html!'s rendering cost against Maud on equal work](https://github.com/corten-run/corten/issues/963)).

2. <a id="choice-no-wasm"></a>**No WASM.** Hydrating a WASM app costs hundreds of kilobytes before the page responds; the
   server already has the HTML, so the browser only needs behavior where there is behavior.

   Stands on: measured (the [browser table](performance.md#in-the-browser), median of 10 cold loads each: Leptos's item page
   loads 305 KB of WASM and is interactive on a phone in 1,926 ms, Corten's in 468 ms); reasoned
   (the server already sends the HTML, so the browser needs only the behavior).

   Revisit when: a page's behavior compiled to WASM loads in fewer bytes and is interactive sooner
   than the same behavior in JavaScript, measured as the browser table measures, without hydrating
   what the server drew.

   Last checked: 2026-11-07, round r16's Chromium browser pass, on `eea6adb`.

3. <a id="choice-no-server-vdom"></a>**No virtual DOM on the server.** Frameworks that build a view tree per request and then
   serialize it pay for it in throughput (Leptos in the
   [server benchmark](performance.md#on-the-server)). `html!` writes straight to the
   response buffer.

   Stands on: measured, of whole frameworks only (the server benchmark, median of three load passes:
   300 pages a second take 4.2% of a core in Corten and 25% in Leptos, which differs from Corten in
   more than its view tree); reasoned (a tree built and then serialized is work a direct write does
   not do).

   Revisit when: a view tree measured alone (callgrind on the item page) costs within noise of
   direct writes, or a feature needs the tree on the server, such as computing patches by diffing
   two renders.

   Last checked: 2026-11-06, round r16, three load passes, on `eea6adb`.

4. <a id="choice-plain-functions"></a>**Plain functions, not a client framework, by default.** A handler is an exported function the
   markup calls with the elements it uses, run by one delegated listener per event type; there
   is no component instance, lifecycle class or hydration in the browser. Rows a script changes
   often are views: generated classes that read and write the server-rendered elements.
   One replaceable branch can use `view(host, View, template)`: a DOM operation beside `rows`,
   not another component model. Its server-rendered root id identifies the branch; existing
   `keep`, typed events and `signal` still own state, communication and cleanup.

   Stands on: measured (the client-heavy table in performance.md, round browser-3, older than today's
   runtime: views take over 1,000 server-rendered rows in 6.0 ms, Solid, Svelte, Vue, React and
   Remix in 19.6 to 83.5 ms, the median of 30 loads); reasoned (nested branches need the same
   typed-template check and CSP custom-property application as rows; centralizing those does not
   require tracking application state); value (one way to give an element behavior, Values 5).

   Revisit when: a client framework takes over server-rendered rows as fast as views in the
   client-heavy table, with no hydration (Solid already changes rows faster on some operations
   there); or apps' handlers keep repeating state that crosses components, which a framework would
   hold once. The nested deck preview exercises that boundary: draft data stays in its owner,
   while `view` owns only adoption and cloning. Revisit that split if more screens need another
   state/lifecycle mechanism, or if its root-id identity cannot express their branches.

   Last checked: 2026-11-06, nested deck preview and connected-tree measurements on `fc09b98d`.
   The older browser-3 measurement above remains from 2026-10-23 on `77002fe`, not rerun here.

5. <a id="choice-handlers-checked-where-called"></a>**Handlers are checked where they are called.** The compiler reads each script's JSDoc, so a
   call with a ref on the wrong element, an event of the wrong type, a value of the wrong type or
   a handler the script does not export fails to compile at the call. No generated declarations
   are needed between markup and script, and none can be stale.

   Stands on: bet (the JSDoc types the compiler reads cover what handlers take: elements and their
   lists, maps and views (`Holds`), events, `AbortSignal`, strings and lists of them, numbers,
   booleans, element ids, routes and feed URLs, messages, formats, groups (a `@typedef` of these,
   one object argument), and any value of a Rust type through its generated declaration; a type
   it cannot check a call against, a set of names written as string literals, any other JSON
   shape or an element or event in another shape, refuses the call rather than taking anything,
   and only `unknown` takes any argument, since it claims nothing the call does not check);
   reasoned (with the check at the call, no declarations sit between markup and script to go stale);
   value (a wrong call fails to compile, Values 4).

   Revisit when: an example or a kit component has to take `unknown` where a precise type would
   serve it, because no checked type or generated declaration fits, so a wrong call compiles; or
   JavaScript gains type syntax of its own (TC39's type annotations proposal), which a script
   could carry in place of JSDoc.

   Last checked: 2026-11-07, at `cdbe4392`: every parameter a handler in the repository took as
   any JSON value was listed (seven: six typed events imported in a JSDoc `@import`, now each its
   `#[event]` type, and one test script's object type, now a generated declaration), and the
   fallback now refuses the call
   ([#1037 Unsupported handler parameter types can silently fall back to unchecked Rust-to-JS arguments](https://github.com/corten-run/corten/issues/1037));
   2026-11-07, TypeScript 5.9.3's lib.dom event maps against the events `on:` types, at `f686fd88`
   (five typed `Event` that lib.dom types more narrowly; `formdata` and `securitypolicyviolation`
   now take theirs, and an element's `error`, `abort` and `progress` were probed as plain `Event`s
   in Chromium 156, Firefox 157 and WebKit 27.2; a media element's `resize` is one in the HTML
   standard's event table, not probed), held by `scripts/events.mjs`
   ([#1072 A formdata handler cannot take its FormDataEvent: the event map types formdata as Event, so since the handler check a lib.dom-typed handler does not compile](https://github.com/corten-run/corten/issues/1072)).

6. <a id="choice-plain-css"></a>**Plain CSS files, scoped by the compiler, not utility classes or CSS-in-Rust.** Utility
   frameworks put unchecked strings in every view and need a scanner and a build step; CSS in
   Rust needs inline styles the CSP blocks, or a runtime. A CSS file per component keeps the
   language designers know, and the macro makes its class names typed. Tokens cover the
   one-off values (spacing, direction per breakpoint) utilities are good at. A value drawn from
   data is a custom property the component's file registers (`@property`), set from markup as a
   typed number with a unit (`style={FILL.pct(42.0)}`): a full page carries them in one style
   block allowed by its hash (one header source, no nonce, so a cached page stays the same bytes,
   where a hash per style attribute would be one header source per value), and the runtime sets
   a patch's through the CSSOM, since a document keeps the policy it loaded with.

   Stands on: bet (a CSS file per component and the typed token utilities are quick enough for the
   one-off values utility classes are good at, spacing and direction per breakpoint, so apps do not
   want a utility class for everything); platform (the CSP blocks inline `style=`, and `@property`
   registers a typed custom property); reasoned (an untyped utility class is a string in a view the
   compiler cannot check without a scanner and a build step); value (typed class names, Values 4).

   Revisit when: apps built on Corten ask for, or write their own, utility classes beyond the typed
   token utilities, putting spacing, layout and type in views rather than in component files; or a
   CSP can allow values set from markup without a header source for each.

   Last checked: 2026-11-06, the CSP refusing an inline `style=` and `@property` registering a type,
   probed in Chromium 156, Firefox 157 and WebKit 27.2.

7. <a id="choice-whole-pages"></a>**A page is sent whole, not streamed in parts.** Streaming a slow section later in the same
   response sends the status and headers before that section exists, so a failure in it can no
   longer become an error page or a redirect; placing it out of order needs a script, so
   without JavaScript it lands at the end of the page; and with the data fetched together
   (`tokio::join!`) and rendering in microseconds, the most it saves is the slowest source's
   wait. A part that is slow and optional is a `<corten-live>` whose stream sends it when it is
   ready and ends.

   Stands on: bet (a page's sources are fetched together and the slowest is rarely slow enough for a
   part sent later to be worth its costs); measured (an uncompressed, untagged whole item page request
   takes 47 µs of CPU in the server benchmark, median of three load passes); reasoned (the status
   and headers go before a streamed part exists, so its failure cannot become an error page or a
   redirect); value (a page works without a script, Values 3, where a part placed out of order would
   land at the end of the page).

   Revisit when: browsers place a part streamed out of order with HTML alone, no script; or an app
   measures a first paint that streaming would bring forward by more than a `<corten-live>` part
   does.

   Last checked: 2026-11-06, round r16, three load passes, on `eea6adb`.

8. <a id="choice-compiled-static-files"></a>**Static files are compiled into the program, a constant per file.** `embed!(pub struct
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

   Stands on: bet (an app's static files are small enough to compile into its binary); platform (a
   macro cannot ask cargo to watch a directory, so a new file waits for the next build that compiles
   the crate); reasoned (the binary is the whole deploy, and a constant per file makes a removed
   file a compile error).

   Revisit when: an app's static directory makes builds or images measurably slower than files
   beside the binary would; or a macro on stable Rust can tell cargo to rebuild when a directory
   changes (`proc_macro`'s path tracking is unstable today), which would end the wait for the next
   build.

   Last checked: 2026-11-06, rustc 1.99.1, where `proc_macro::tracked::path` is still unstable
   (feature `proc_macro_tracked_path`) ([rust-lang/rust#99515 Tracking Issue for
   proc_macro::{tracked_env, tracked_path}](https://github.com/rust-lang/rust/issues/99515) is
   open).

9. <a id="choice-work-where-fastest"></a>**Work happens where it is fastest for the user.** The server renders the first page, so it
   arrives finished, and answers what only it can: a write, and data the page does not have. What
   the page can do with what it already has (sorting, filtering, selecting, a total, showing and
   hiding) is a handler, since no render is faster than no round trip; a view makes even 1,000
   rows fast to change ([performance](performance.md#client-heavy-screens)). Rust renders on the server
   because it is the fastest renderer there, and plain JavaScript runs in the browser because no
   framework or WASM layer is faster than the platform's own DOM calls. The scripts guide has the
   table for choosing ([Server or browser](guide/scripts.md#server-or-browser)).

   Stands on: measured (views take over 1,000 server-rendered rows in 6.0 ms, the client-heavy
   table in performance.md, median of 30 loads, round browser-3, older than today's runtime); value
   (Values 1: the work goes where it is fastest for the user).

   Revisit when: Values 1 changes. A case measured against the scripts guide's table (Server or
   browser) moves that case and the table, not this choice.

   Last checked: 2026-10-23, round browser-3, on `77002fe`.

10. <a id="choice-app-owns-document"></a>**The document is a component the app owns, not a shell Corten configures.** A page hands
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

   Stands on: measured (`render_cost` on the item page, eight alternating runs on Windows: a full
   document about 7% faster than with the shell, median 57.5 to 53.8 µs, and a navigation within
   noise, the same bytes); reasoned (a shell key per section would turn every link across sections
   into a full load); value (one way to change the document, Values 5).

   Revisit when: `render_cost` shows a navigation paying for layout it does not send, or apps keep
   adding a flag per page to their layout ([Rule 9](#rule-layout-props)) where elements marked `page` were meant to
   cover it.

   Last checked: 2026-10-25, the eight runs, recorded at `80c4493b`.

11. <a id="choice-corten-request-header"></a>**A request says what it is with a `corten` header, not `Accept` or `Sec-Fetch-*`.** A
   navigation and an action both answer HTML, so no registered media type tells them apart, and
   `Accept` already chooses the format: `application/json` asks for a page's data
   (`Mode::Data`). Carrying the mode there too would need a media type parameter of Corten's own
   (`text/html;corten=nav`), as private as a header but mixed into the format choice that data
   clients, caches and proxies read as content negotiation. `Sec-Fetch-Mode` and `Sec-Fetch-Dest`
   tell a navigation from a `fetch` but not a navigation from an action, a script cannot set
   them, and data clients do not send them. With a header of its own, its absence is the safe
   answer: a browser request without it (and not asking for JSON) gets the whole document, as a
   browser without JavaScript needs. The page the runtime fetches whole after a write asks with
   `corten: page`: it is the whole document too, but a redirect to a place or to another site is
   named to it in `corten-location`, as to a navigation, since `fetch` follows a 303 without its
   `#id` and cannot read another origin's answer. So a redirect varies on `corten`, and an
   answer to that fetch is the browser's alone, as a navigation's is. The mode would move to a
   standard header that says "part of a page" and that a script may set.

   Stands on: platform (no registered media type tells a navigation from an action; a script cannot
   set `Sec-Fetch-*`, and data clients send none); reasoned (a media type parameter would mix the
   mode into content negotiation).

   Revisit when: a standard header says "part of a page" and a script may set it.

   Last checked: 2026-10-30, no registered media type for a request's mode, as written at
   `1e5c56e2`; 2026-11-06, a script's `Sec-Fetch-Mode` and `Sec-Fetch-Dest` replaced by the
   browser's, probed in Chromium 156, Firefox 157 and WebKit 27.2.

12. <a id="choice-own-prefetch"></a>**The runtime prefetches links itself, not with Speculation Rules or `rel="prefetch"`.** A
   navigation the runtime makes asks with `corten: nav` and gets the title, head tags and
   `<main>`, a fraction of the document (all but the one after a write, which is never
   prefetched). A Speculation Rules prefetch and a `rel="prefetch"` both fetch the whole document,
   sent without `corten: nav`, and answers vary on that header (`Vary: corten, accept`), so the
   runtime's request does not take what they fetched: Chromium keeps either in the HTTP cache and
   Firefox a `rel="prefetch"`, and each asks again with the document's `ETag`, which the runtime's
   answer does not share (Firefox and WebKit sent no Speculation Rules prefetch, and WebKit no
   `rel="prefetch"`). Either would download more and still leave the runtime's navigation to fetch
   again. Speculation Rules would fit where the browser navigates anyway (full page loads,
   browsers without the Navigation API), and the runtime would drop its own once a
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

   Stands on: platform (a Speculation Rules or `rel="prefetch"` response is the whole document,
   fetched without the header answers vary on, so the runtime's `fetch` asks again: Chromium and
   Firefox revalidate what they kept, and WebKit sent neither); reasoned (either would download
   more and still leave the navigation to fetch again).

   Revisit when: a browser's own prefetch can be asked with the runtime's headers and answer its
   `fetch`; the runtime's prefetch then goes, and `Purpose: prefetch` with it, since the browser
   sends `Sec-Purpose`.

   Last checked: 2026-11-06, each prefetch the engine sends and a `fetch` with `corten: nav` after
   it, probed in Chromium 156, Firefox 157 and WebKit 27.2.

13. <a id="choice-prefixed-classes"></a>**Component CSS is scoped by prefixing its classes, not with `@scope`.** A prefixed class
   (`.offer-list__row`) matches nothing an app's global stylesheet or another component wrote, so
   a component looks the same on every page; with `@scope`, the class stays `.row` and any
   global `.row` rule still applies to it. A donut limit at nested components would also need every
   component's root marked (`data-scope` marks only those with refs, kept state or a handler
   taking `scope`), and a scoped selector competes on specificity and proximity where a prefixed
   class is one class. The typed class constants do not depend on the prefix. The macro would
   emit `@scope` when it gives the same isolation from global rules, at the same specificity.

   Stands on: platform (`@scope` leaves a global rule for the same class applying, and a scoped
   selector competes on specificity and proximity); reasoned (a prefixed class matches nothing
   another stylesheet wrote).

   Revisit when: the macro can emit `@scope`, or another CSS feature, that keeps global rules out of
   a component at one class's specificity.

   Last checked: 2026-11-06, a global rule's other properties applying inside `@scope`, probed in
   Chromium 156, Firefox 157 and WebKit 27.2.

14. <a id="choice-feed-patch-rows"></a>**A feed patch is keyed `upsert` and `remove` of whole rows, not JSON Patch or Merge Patch.**
   A feed is a set of rows by id, and each write replaces rows or removes them. JSON Patch
   (RFC 6902) could say the same over an object keyed by id (`add` at `/<id>` replaces a row,
   `remove` removes it), but only as a subset: a client given JSON Patch is expected to take any
   path, `test`, `move` and `copy`, and ids would need JSON Pointer escaping (`~0`, `~1`), so a
   subscriber either carries a whole JSON Patch engine for two operations or rejects valid JSON
   Patch. Merge Patch (RFC 7396) merges a value into the old one field by field, so a row cannot
   be replaced whole, and its `null` means "delete", so a field cannot be null. Keyed whole rows
   are one encoding every subscriber applies the same way, in one pass, and `corten-protocol`
   holds it so native and agent clients do not write their own diffing
   ([architecture](architecture.md#rules-that-keep-surfaces-from-drifting), its rule 5). A feed would
   move to JSON Patch if subscribers needed to apply it with a stock JSON Patch library: each
   change as `add` or `remove` at `/<id>`, with the same sequence numbers and resume.

   Stands on: bet (subscribers apply feeds through `corten-protocol`, not a stock JSON Patch
   library); reasoned (Corten would use only a subset of JSON Patch, and Merge Patch cannot replace
   a row whole or keep a null).

   Revisit when: a subscriber needs to apply a feed with a stock JSON Patch library; each change
   then becomes `add` or `remove` at `/<id>`, with the same sequence numbers and resume.

   Last checked: 2026-10-30, the subset of JSON Patch the feed uses, as written at `3600d5c2`, and
   not checked since.

15. <a id="choice-corten-answer-headers"></a>**An answer to the runtime says what it is with `corten-*` headers, not `Location`, a
   media type or `ETag`.** Only the runtime reads them, on answers to its own requests
   ([Choice 11](#choice-corten-request-header)), and nothing outside the framework may depend on
   them. A navigation sent somewhere else within the app is a redirect with `Location` (a 303, or a
   301 from `req.moved`): `fetch` follows it, and the runtime reads where it went from
   `response.url`. Three cases go in `corten-location` instead, and the runtime navigates there
   itself: a place on a page (`#id`), which `fetch` drops from `response.url`; an absolute address,
   which may be another origin `fetch` refuses (the CSP's `connect-src`, else CORS); and a form
   patch sent somewhere after its write, which is a new page loaded whole so its layout is drawn
   again, where a followed 303 would fetch it with the patch's own `corten: action`.
   `redirect: "manual"` cannot hand the runtime the place instead, since it gives an opaque response
   with no `Location`. A form sent on to another handler (`req.resend_to`) is the one write answered
   with `Location`: a 307, which `fetch` follows with the same body, since only a redirect the browser
   follows keeps it; where it went does not matter, as its answer is drawn as the write's own. A
   swap (`corten-page`) and a patch (`corten-patch`) are both `text/html`, and, as in [Choice 11](#choice-corten-request-header), a
   media type parameter of Corten's own would mix into content negotiation; a document a cache
   handed to a navigation fetch by mistake carries neither, so the runtime loads the URL in full.
   `corten-shell` is the key of the page around `<main>`, compared with the one the page loaded
   with, not a validator of the answer, so it is not an `ETag`, which caches and conditional
   requests read (a page's `ETag` is its body's, beside it). `corten-notice` hands the runtime a
   redirect's notice (`req.redirect_with_notice`) the page it swaps in (a navigation's answer, or
   the document after a write) did not draw, which it dispatches as `corten:notice`; the notice
   itself rides to the page in the `__Host-corten-notice` cookie, since `fetch` follows the redirect
   (in `corten-notice`, read only without `Sec-Fetch-Site`, for a write from a plain `http://`
   origin off loopback, which refuses a `Secure` cookie; never with `Policy::hsts`). Corten would
   move to `Location` once `fetch` can read a redirect's target without following it, except for
   a write sent with its progress by `XMLHttpRequest` ([Choice 29](#choice-upload-xhr)), which
   cannot read it either and keeps `corten-location` until it is sent by `fetch`. The runtime
   sends `corten-notice` back, with the page's path, when a page it swapped in reads itself again
   (`ReadAgain`): the cookie is gone by then, and without the notice the read would differ from the
   page on screen and replace it, losing what the user typed. Only a `GET` for that path not from
   another site is read for it, and its answer varies by it.

   Stands on: platform (`fetch` follows a 303 itself, drops the fragment from `response.url` and
   refuses another origin the CSP's `connect-src` or CORS does not allow, and `redirect: "manual"`
   gives an opaque response with no `Location`); reasoned (a followed redirect keeps the patch's
   mode header, and a media type parameter would mix into content negotiation, as in
   [Choice 11](#choice-corten-request-header)).

   Revisit when: `fetch` in a browser can read a redirect's target without following it, when the
   three cases that use `corten-location` move to `Location`. The open proposal that would show
   `Location` on a manual redirect, [whatwg/fetch#1946 Fetch
   Posture](https://github.com/whatwg/fetch/issues/1946), is for runtimes outside the browser and
   leaves browsers as they are.

   Last checked: 2026-11-06, a 303 followed with its fragment dropped, refused across origins
   without CORS, and opaque with `redirect: "manual"`, probed in Chromium 156, Firefox 157 and
   WebKit 27.2; 2026-11-06, the Fetch Posture proposal, read at `62eb57f7`.

16. <a id="choice-looks-are-classes"></a>**A look is classes on the app's element, not an element around it.** A component that only
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

   Stands on: reasoned (a wrapper changes the DOM that a script, a selector and a `<summary>`'s
   place see, even with `display: contents`).

   Revisit when: two or more of the examples write the same markup around one look's element, which
   shows that a component rendering its element is wanted there. No platform change in sight would
   reopen it, since the DOM's shape is the reason.

   Last checked: 2026-11-06, a wrapper with `display: contents` still the button's parent for
   `ul > button` and still hiding a `<summary>`, probed in Chromium 156, Firefox 157 and
   WebKit 27.2.

17. <a id="choice-handler-on-any-element"></a>**Behavior is a handler on any element, not a custom element per component; styles are
   prefixed classes, not shadow DOM.** A custom element does not need hydration (the browser
   upgrades the server's HTML in place), but behavior often belongs on an element whose parent
   takes only certain children, and a wrapper there is moved or breaks its parent: an `<x-row>`
   in a `<tbody>` is moved out of the table, and an `<x-sum>` around a `<summary>` hides the
   app's summary until its `<details>` opens, showing the browser's own label in its place
   (measured in Chromium 156, Firefox 157 and WebKit 27.2, the engines the repository's
   Playwright runs). The standard's answer, a customized built-in (`<tr is="x-row">`), does not
   run in WebKit, whose standards position opposes it. Elsewhere a wrapper still changes the DOM
   ([Choice 16](#choice-looks-are-classes)), each element would be a class instance where a handler is a function ([Choice 4](#choice-plain-functions)),
   and an element's attributes are strings the compiler does not see, where a handler call is
   checked at the markup ([Choice 5](#choice-handlers-checked-where-called)). Shadow DOM would keep a kit look's classes, the app's global
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

   Stands on: platform (probed in Chromium 156, Firefox 157 and WebKit 27.2: the parser moves an
   `<x-row>` out of a `<tbody>`, and a wrapper around a `<summary>` hides it; WebKit does not run
   customized built-ins); reasoned (a class instance per element, and attributes the compiler cannot
   check, [Choice 4](#choice-plain-functions) and [Choice 5](#choice-handlers-checked-where-called)).

   Revisit when: a standard attaches behavior to any element without a class instance per element
   and with attributes the compiler can check. Customized built-ins in every engine would answer
   only where an element may stand.

   Last checked: 2026-11-06, the `<x-row>` moved out of a `<tbody>`, the wrapped `<summary>` hidden
   until its `<details>` opens, and a customized built-in running in Chromium and Firefox but not
   WebKit, probed in Chromium 156, Firefox 157 and WebKit 27.2.

18. <a id="choice-custom-media-breakpoints"></a>**A component names a breakpoint as Media Queries 5's custom media does, and the app writes
   its width when it starts.** A component's `@media (--sm)` and `@media not (--sm)` are the
   standard's syntax, so the name reads as CSS and moves to the browser's own custom media unchanged.
   No engine reads it by default yet (Firefox reads `@custom-media` only behind
   `layout.css.custom-media.enabled`), so the name cannot reach the browser as written. The macro
   cannot write the width either: a component is compiled without the app's token files, and a kit's
   components may sit in a crate several apps share, each with its own theme. So the macro records
   where each name stands, and `Assets` writes `(min-width:<width>)` from the breakpoints of the
   token files in `App::components`, the ones the `md:` utility classes already use, when the app
   starts; a request serves the written stylesheet. A name with no width stops the app, as an
   undeclared `var()` does. A component does not define one (`@custom-media` does not compile),
   since a component that set its own width would switch apart from the theme. A custom property
   (`var(--sm)`) is not an answer: a media query does not read custom properties. When browsers read
   custom media, the app writes the token file's widths as `@custom-media` rules and serves the
   names as written. A breakpoint may name another (`"wide": "{md}"`), so a stylesheet several apps
   share names a role and each theme points it at one of its widths, rather than each app editing
   its copy or renaming its own breakpoints. It borrows the braces of a Design Tokens reference but
   not its path: breakpoints are Corten's extension, not tokens, so `{md}` names a breakpoint, and
   the format's `{group.token}` path would name a token that does not exist.

   Stands on: platform (no engine reads custom media by default; Firefox reads `@custom-media` only
   behind `layout.css.custom-media.enabled`, and a media query cannot read a custom property);
   reasoned (a component compiles without the app's token files, and a kit's crate serves several
   themes, so only the app knows the widths); value (the standard's syntax, Values 2).

   Revisit when: browsers read `@custom-media`; the app then writes the token files' widths as rules
   and serves the names as written.

   Last checked: 2026-11-06, `@custom-media` ignored by default and read in Firefox with
   `layout.css.custom-media.enabled`, and `var()` ignored in a media query, probed in Chromium 156,
   Firefox 157 and WebKit 27.2.

19. <a id="choice-head-size"></a>**A request's head may be 32 KiB unless the app raises it, and connections stay unbounded.**
   hyper's own ceiling is its read buffer, about 400 KiB, so a client that sends large heads and
   never finishes them held that much per connection for the header timeout: 4,000 of them took
   card-market to 913 MiB of its 1 GiB. 32 KiB matches nginx's limit (four 8 KiB buffers, no line
   over 8 KiB) and Kestrel's for headers (with 8 KiB more for its request line), and it holds what
   Corten itself sends: its cookie (`corten-zone`) and headers (`corten`, the notice) are a few
   hundred bytes, as is a route's URL. A larger head, or a URL past it, is answered 431 by hyper
   (with the limit raised above 64 KiB, a URL over 64 KiB gets 414), before any request exists, so
   it has no body and none of the app's headers, and a client still sending the rest may see the
   connection reset instead; a request past the 100 headers hyper allows gets the same 431. The size
   bounds the memory, so the count has no setting of its own. The limit also bounds a chunked body's
   trailers (hyper's were 16 KiB). `App::max_request_head` raises it, past hyper's read buffer too,
   for an app whose requests carry more. At 32 KiB, 4,000 unfinished heads took card-market (one
   CPU, 1 GiB) from 3.4 to 225 MiB, about 57 KiB a connection, since hyper's read buffer grows past
   the head it holds, and 300 KiB heads were answered 431 with its memory at 1.3 MiB
   ([#856 App::max_request_head: a request's head may be 32 KiB unless set (#822)](https://github.com/corten-run/corten/pull/856)).
   Memory not given back after a flood is the allocator keeping freed pages, not something kept per
   connection; [the app guide](guide/app.md) gives the figures for repeated floods and each
   allocator
   ([#852 Memory a flood of unfinished request heads takes is not given back when the connections close, and each flood grows it further (217 to 464 MiB over eight)](https://github.com/corten-run/corten/issues/852)).
   `App::max_connections` stays unbounded unless set, as Kestrel's is: Corten cannot tell how much
   memory the process has to spare or how many connections its traffic needs, and a cap chosen for
   one host refuses real visitors on a larger one or does not protect a smaller one. The guide gives
   what each connection may hold and the peak repeated floods reach, so an app exposed directly sets
   it from its container's memory; a proxy in front bounds connections and heads before they reach
   the app.

   Stands on: bet (an app's requests fit in 32 KiB: Corten's own headers and cookie are a few
   hundred bytes); measured, runs not recorded (under hyper's own ceiling, 4,000 unfinished heads
   took card-market to 913 MiB of its 1 GiB); measured, one flood each (at 32 KiB the same took it
   from 3.4 to 225 MiB, and 300 KiB heads were refused with memory at 1.3 MiB); platform (nginx's
   and Kestrel's limits); reasoned (Corten cannot see how much memory the process has to spare, so
   connections stay unbounded).

   Revisit when: apps raise `App::max_request_head` for ordinary traffic (large cookies, long URLs);
   hyper stops growing its read buffer past the head it holds; or Corten can read the memory its
   container is given (cgroup v2's `memory.max`) well enough to choose a bound for connections.

   Last checked: 2026-11-04, the floods, recorded at `a4214e4a`; 2026-11-04, nginx's and Kestrel's
   limits, as written at `a4214e4a` with no versions named, and not read since; 2026-11-06, hyper
   1.12.0's read buffer, 8 KiB and 400 KiB more.

20. <a id="choice-layout-reads"></a>**A value only the layout shows is read beside the handler and drawn into the finished page,
   not passed through handlers.** Markup renders synchronously inside the handler, so a value the
   layout draws must be awaited before the page is built. Passed as a prop, one cart count put an
   extractor on 172 handlers, lent it to 80 helpers and made closures take the awaited value in a
   real app
   ([#580 A layout value read the guide's way is passed through every handler and helper that can draw the layout, so one cart count touched 172 handlers in a real app](https://github.com/corten-run/corten/issues/580)),
   and a second such value would double that. Awaited before the handler instead (by a middleware,
   or by the App ahead of the route, with the value on the request for the layout to read
   synchronously), no handler passes anything either, and every error page, refusal and answer a
   middleware makes would find the value in; but a full load would wait for the read and then the
   handler, their sum, where beside the handler it waits for the longer of the two. In the Chase
   Sets pilot the request that serves the cart count its layout draws took 60.4 ms and its
   `/account` page 56.2 ms (medians of 12, debug build, one app), so that shape could add up to as
   much again to a full load's server time
   ([#534 A layout value read the way the guide shows starts after the page's own reads, so a full load waits for both, and an extractor cannot read Mode to start it early](https://github.com/corten-run/corten/issues/534)).
   What running beside the handler costs instead is code in Corten, and 0.3% to 0.9% of the item
   page's instructions (below), well under a microsecond against tens of milliseconds: each case it
   brought, a read for an error page or one a page did not need, has a fix and a test (the four are
   listed in
   [#959 Design Choice 20 does not weigh awaiting a layout read before the handler, which would end its error-page cases at a latency cost; every app pays 0.3% to 0.9% a request for the current shape](https://github.com/corten-run/corten/issues/959)),
   and none costs the user time, which the values put first (Values 1). An async render would make
   every `html!` a future for the sake of a few values; streaming the value in later is the trade
   [Choice 7](#choice-whole-pages) declines. So a `LayoutRead` is started as a page route (one whose
   answer is a page) is called for a whole document's `GET`, after the middleware and beside the
   handler, the layout writes `later::<T>()` where it goes, and once the handler has answered Corten
   awaits the read and draws its view in that place, before the app's middleware, compression, the
   ETag and any header see the page. The page is still sent whole: a failure is still an error page,
   which starts, waits for or draws the reads by whether the request is at fault
   ([the views guide](guide/views.md#the-document) gives each case), and a redirect drops (and
   stops) a read still running. Two things follow from a navigation not starting the read. A caller
   only the read looked up makes the page private but stays out of its key, or a full load and a
   navigation would get different keys and every navigation would load in full; and the view is
   display markup only, since the page's head (its modules, its `style` hash) is written before the
   view is drawn. A place is noted by its offset as the page renders, so text that looks like one
   (`raw(..)`) is never filled; a page Corten does not fill (a navigation, a data client, a `Public`
   answer) has its places removed as it renders. A place for a read the app does not register cannot
   be found until a page draws it, so it is a debug build's error on that page rather than a startup
   check ([Rule 8](#rule-compile-errors)). An app without layout reads pays a few extension lookups
   and a larger request future, 0.3% to 0.9% of the item page's instructions per request (callgrind,
   three alternating pairs; the counts are in
   [#857 Layout reads: a value only the layout shows is read beside the page, by no handler (#580)](https://github.com/corten-run/corten/pull/857)),
   and the reads' state is boxed only in an app with them, since held inline it cost every request
   about 9.5k instructions; most of the cost that remains is the app's request future
   (`Wrapped::call`), which the reads' checks grew, and the app renders a page as it did before. In
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

   Stands on: measured, runs not recorded (a small page drawing a count read takes 42.5k
   instructions where the same page drawing a value its handler awaited takes 28.8k); bet (passing a
   value as a prop grows with the handlers that can draw the layout: one cart count touched 172
   handlers in one app outside this repository); bet (an app's layout read takes about as long as
   its page: in one app outside this repository the request serving its read took 60.4 ms and its
   page 56.2 ms, medians of 12, debug build, so awaiting the read before the handler could add up to
   as much again to a full load); measured (callgrind, release, three alternating pairs of runs: an
   app without layout reads pays 0.3% to 0.9% of the item page's instructions); reasoned (markup
   renders synchronously, so a value must be awaited before the page is built); value (time at the
   user's end before code in Corten, Values 1).

   Revisit when: the cost to an app without layout reads grows past 1% of the item page's
   instructions; `html!` can render asynchronously at no measured cost to a page that awaits
   nothing, when a layout value could be awaited where it is drawn; or a release-build measurement
   of an app's layout read shows it under a tenth of its page's server time, when awaiting it before
   the handler would cost little and end the error-page cases.

   Last checked: 2026-11-04, the 42.5k and 28.8k counts, on `a398ea95`; 2026-11-04, the callgrind
   pairs, `efa7503b` against `2293663a`; 2026-11-01, the pilot's read and page times, as reported in
   [#534 A layout value read the way the guide shows starts after the page's own reads, so a full load waits for both, and an extractor cannot read Mode to start it early](https://github.com/corten-run/corten/issues/534)
   (chase-sets at `162ed0c298`, the commit the issue links).

21. <a id="choice-own-extractors"></a>**An app's own extractor implements Corten's `FromRequestParts`, which keeps axum's name,
    `Rejection` and signature.** An app reads a value from the request's head (a visitor's cookie, a
    started read) with an extractor of its own. Corten's router now calls handlers through
    Corten's own `Handler` ([Choice 25](#choice-axum-router), step 3), so the traits it reads
    arguments with are Corten's too: `corten::extract` names `FromRequestParts`,
    `OptionalFromRequestParts`, `FromRequest` and `State`, each written in `crate::handler`,
    with the names, the `type Rejection: IntoResponse` and the
    `from_request_parts(parts: &mut Parts, state: &S)` signature they had as axum's 0.8 traits. An
    extractor written against `corten::extract` compiles as it was, and one written against axum's
    paths compiles with its `use` changed. `Option<T>` and `Result<T, T::Rejection>` read as they
    did, and so do `String`, `Bytes`, `Body` and the whole `Request` as a handler's last argument.
    A tuple of extractors no longer reads as one: axum's impls for tuples were a second way to
    read two values, which an extractor does by reading each in turn, so one that delegated to a
    tuple changes. Before, these were re-exports of axum's (axum's
    handlers needed every argument to implement axum's trait, and Rust's orphan rule forbade a
    trait of Corten's bridged to it), so an axum release that changed the trait changed every
    app's extractors with it; now the shape is Corten's and changes only with a Corten release
    that says so. `Request` stays the `http` crate's `Request` over Corten's body,
    `corten::middleware` names `Response` and `IntoResponse` (still axum-core's until step 4),
    `corten::answer` names `Body`, and `corten::Bytes` and `corten::Listener` the rest.
    `FromRef` (the trait and the derive) stays axum-core's: it is a conversion of the routes'
    state that Corten's `State` reads, nothing on the request path, and leaves with axum. axum's
    own extractors (`Path`, `Query`, `RawQuery`, `Json`, `Extension`, `ConnectInfo`,
    `MatchedPath`, `Parts`) implement axum's traits, not these, so a handler that takes one does
    not compile: a route's path and query are its `Params`, a body its `Json`, `Form` or
    `Upload`, and the head its `Req`; a second reader of each would be a second way. Before,
    axum's `Path` and `RawPathParams` compiled and answered `500` to every request on Corten's
    router, refused at startup by type name; now they fail to compile (`compile_fail` doctests in
    `extract.rs`). A handler that takes the whole `Request` reads its body up to a limit of its own
    with `corten::extract::bytes_up_to`, as an upload's file is read with `File::bytes_up_to`, not
    axum's `to_bytes`, whose one error is both a body over the limit and one that broke, and which
    leaves the rest of a body over it unread, so a client still sending can miss the answer; a
    body too large to hold is read piece by piece with `pieces_up_to`. `Bytes`, `String` and Corten's
    `Json` and `Form` still read the body through axum's readers until step 4, so their limit (2 MiB),
    refusals and texts are unchanged. `corten::axum` stays for a stand-in server in a test (its
    `Router` and `serve`): the stand-in is another server the app calls, not the app, so a Corten
    name for it would be a second server API for tests alone. This lasts while axum is a
    dependency: when it leaves ([Choice 25](#choice-axum-router), step 4) the re-export goes with
    it, and a test that wants a stand-in depends on axum itself.

    Not chosen: new names for the traits (`FromHead`, `FromBody`), which would say what they read
    better but make every app's extractor change for no behavior; keeping axum's traits as
    re-exports after Corten owns dispatch, which leaves axum's version in every app's extractor
    signature for nothing Corten uses; and `#[async_trait]` or boxed futures, which axum 0.8 itself
    dropped for `impl Future` in the trait.

    Stands on: measured (callgrind, release, Corten's handler traits against axum's, step 3
    against step 2 at `7bba1e2b`: about 100 instructions fewer a staged request with jemalloc
    and 150 to 170 with glibc, an unstaged one the same; [Choice 25](#choice-axum-router), Stands
    on);
    reasoned (the trait's shape is axum 0.8's, so an extractor's `impl` body compiles unchanged;
    the router calls `Handler` once per request, as it called axum's); value (one way to read
    each part of a request, Value 5, and a mistake that fails when the app compiles rather than
    when it answers, Value 4).

    Revisit when: an app needs an extractor that cannot be written with this signature (one that
    borrows from the request beyond its call, say); or an axum or http release changes what
    `Parts` holds; or axum leaves ([Choice 25](#choice-axum-router), step 4), which takes `FromRef`
    and `IntoResponse` with it and reopens where they come from.

    Last checked: 2026-11-09, axum 0.8.9 (`axum-core` 0.5.6) and rustc 1.99.1, Corten's own
    traits at the commit that adds them ([Choice 25](#choice-axum-router), Last checked).

22. <a id="choice-locale-in-url"></a>**A page's locale is negotiated from `Accept-Language` unless its URL names one, and a shared
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

   Stands on: platform (a shared cache keys a negotiated page on the raw `Accept-Language`:
   CloudFront's guide warns of it, and Cloudflare keeps one copy per locale only under a rule);
   reasoned (a locale in the URL is a key every cache already uses).

   Revisit when: the CDNs the deploy guide names key a negotiated page on its locale by default, not
   on the header's string.

   Last checked: 2026-11-06, CloudFront's guide to the cache key and Cloudflare's Cache Rules, whose
   Vary setting normalizes `Accept-Language` only when a rule turns it on, read at `62eb57f7`.

23. <a id="choice-jemalloc-image"></a>**The image `corten new` writes preloads jemalloc, an image package, not a crate.** glibc's
   allocator keeps memory a burst of connections freed, and each burst grows what it keeps: eight
   floods of 4,000 unfinished request heads left card-market at 419 MiB with glibc and 45 MiB with
   jemalloc preloaded 35 seconds after the last (31 to 81 MiB after each), one run each
   ([the app guide](guide/app.md),
   [#886 The template's image runs glibc's allocator, which keeps what a flood of unfinished heads freed; preloading jemalloc gives it back, unmeasured for throughput](https://github.com/corten-run/corten/issues/886),
   [#894 docs: a flood of unfinished heads leaves memory with glibc's allocator; size max_connections from repeated floods](https://github.com/corten-run/corten/pull/894),
   [#852 Memory a flood of unfinished request heads takes is not given back when the connections close, and each flood grows it further (217 to 464 MiB over eight)](https://github.com/corten-run/corten/issues/852)).
   No cost to requests was measured: under callgrind the item page took about 83,000 instructions
   per request with jemalloc and 87,000 with glibc (five runs each, at `547b54ae`), and on the
   benchmark item page (three rounds each, 64 connections for 30 seconds, then 1,000 requests a
   second for 30, a 1 GiB container on two cores of a desktop) CPU time per request was within the
   rounds' spread (median 212 against 210 microseconds closed, 292 against 299 open), and memory at
   rest after load was 16.4 to 18.2 MiB against 17.5 to 29.5 (cgroup `memory.current`). With
   compression, as a browser asks for it (zstd 1, the coding current browsers get; images at
   `b179987a`, three rounds each), CPU time per request was again within the spread (median 213
   against 224 microseconds closed, 349 against 368 open) and memory at rest overlapped (17.9 to
   24.7 MiB against 18.8 to 24.0). Brotli, for a client without zstd, was not measured. The rounds
   ran on a shared desktop and varied more between rounds than between allocators, so they show no
   cost large enough to see there, not a gain. The image grows by 1.8 MB (84.1 against 82.3). A
   `#[global_allocator]` crate in the app would do the same in the program, but it compiles C into
   every build and binds the app to it outside Docker too; the image's two lines are the app's,
   which it removes to run on glibc's, and card-market's image has them too
   ([#886 The template's image runs glibc's allocator, which keeps what a flood of unfinished heads freed; preloading jemalloc gives it back, unmeasured for throughput](https://github.com/corten-run/corten/issues/886)).

   Stands on: measured, noisy and partly (memory after eight floods, one run each; CPU time per
   request within the spread of three rounds on a shared desktop, which cannot show a small cost;
   brotli not measured); bet (an app's image is Debian with the `libjemalloc2` package); reasoned
   (an image package binds only the image, where a `#[global_allocator]` crate compiles C into every
   build).

   Revisit when: a run on a quiet Linux host (`bench/fullstack/ab.mjs`) or with brotli shows a cost
   per request; or glibc's own settings (`MALLOC_ARENA_MAX`, its trim threshold) give the memory
   back with no package, which has not been tried.

   Last checked: 2026-11-05, the eight floods, recorded at `83123350`; 2026-11-06, the callgrind
   runs on `547b54ae`, recorded at `b179987a`; 2026-11-06, the rounds with zstd, images at
   `b179987a`, recorded at `312b2c1c`.

24. <a id="choice-openapi"></a>**An API's routes are described as an OpenAPI 3.1 document, with one extension for what it
   cannot say.** OpenAPI is the standard other services, gateways and client generators read, and
   its 3.1 schemas are JSON Schema, which Corten already generates for JSON types; a failure is
   RFC 9457 Problem Details, and a credential a security scheme. A `#[route(prefix = ..)]` family
   (`dim.<key>=<value>`) has no OpenAPI form: a query parameter has one fixed name, and
   `style: deepObject` writes `dim[key]=`, which the route does not read. So the operation names
   the prefixes in `x-corten-query-prefixes`, an extension field OpenAPI reserves `x-` names for
   and tools ignore, rather than describing them as something else or leaving them out
   ([#954 API routes have no OpenAPI document, though Corten already generates JSON Schema for their input and answer types](https://github.com/corten-run/corten/issues/954)).

   Stands on: bet (the tools that read Corten's documents read 3.1 and not yet 3.2); platform
   (OpenAPI 3.1 has no form for a family of query parameters named by a prefix); value (OpenAPI is
   the standard other services, gateways and generators read, Values 2).

   Revisit when: the tools read OpenAPI 3.2, whose `in: querystring` describes the whole query
   string as one schema, where `patternProperties` could name the prefixes. 3.2 allows no
   `in: query` parameter beside it, so every query parameter of such a route would move into that
   schema.

   Last checked: 2026-11-06, OpenAPI 3.1.1, which the document declares, as written at `93a16d2b`;
   2026-11-06, OpenAPI 3.2.0's `in: querystring`, as written at `92df8899`.

25. <a id="choice-axum-router"></a>**Corten's request path is built from parts of its own on hyper, `http`, tokio and
    matchit: a connection loop, stages, a router, handlers and the readers they take. axum and
    tower leave it in steps, each measured; until a step lands, the part it replaces stays
    axum's.** Each part is one of these, and each is built on the one before it:

    1. Transport: tokio's TCP listeners, and the app's own (`corten::Listener`, a TLS step in
       `serve_wrapped`). UDP is only HTTP/3's, which [Limit 14](#limit-http1) leaves to the proxy.
    2. Protocol: hyper's HTTP/1.1 reads and writes the connection. It stays: framing is where a
       server's worst bugs live (request smuggling, chunked bodies, pipelining), hyper is tested
       for them as Corten could not be, and nothing measured here points at it.
    3. Vocabulary: the `http` crate's `Request`, `Response` and `HeaderMap`, which hyper, HTTP
       clients and HTTP/3 libraries share (`corten::http`). Nothing above names the connection's
       protocol.
    4. Stages: what goes around a route ([Choice 28](#choice-fixed-stages)), each one a future that
       wraps the route's, in Corten's one order. A route goes through all of them or says
       `unstaged` and goes through none, its lane in their place (the host check and the headers
       every answer needs); nothing reorders them.
    5. Router: the method and path to a route (matchit), boxing once per request.
    6. Handlers: a function whose arguments are read from the request and its stages, and whose
       answer is any `IntoResponse`, a raw `Response` included.
    7. Typed routes, `#[corten::routes]`, areas, APIs and `App`, which say what each route gets.

    Today 2 and 3 are hyper's and the `http` crate's, Corten's own code is 1, 4, 5 and 7 (the
    accept loop and connection limits, the stages, `corten::Router` on matchit, `Params`, the
    readers `Form`, `Json` and `Upload`, `Upgrade`, and since step 3 the `Handler` impls and
    `FromRequestParts`), and of 6 only `Sse` is still axum's. Until step 2 the stages sat on tower's `Layer` and `Service`
    because axum's router took them. That seam was what an app paid for: axum boxed every layered
    route again and cloned that box on each request, so what went around one route had to be
    written into its handler to cost nothing more. An `unstaged` route's host check and its API's
    JSON, written first as a `route_layer` around those routes, cost 9,230 instructions a request
    against 8,479 written into the route's handler. A prototype pipeline of Corten's own (`prototypes/pipeline` at `7cea4970`, on the branch
    `codex/pipeline-prototype`, which is not yet pushed or merged, so these numbers cannot yet be
    checked from the repository) took 5,393 instructions for one JSON request through its router
    against axum's 8,508, and 9,493 with every default stage against Corten's 17,336. tower's
    `Service` (`poll_ready`, `&mut self`, a clone per call) is a shape for backpressure that
    a request's route does not have; it stays only at the app's edge, where `App::layer` takes
    a tower layer ([Limit 12](#limit-fixed-stages)).

    The steps, in order, each landing only when the one before it has:
    1. The dispatch suite (`crates/corten/tests/dispatch.rs`): raw HTTP/1.1 to `serve_on` and the
       answer's bytes, naming no router type, for matching (a segment of text chosen over a
       parameter, the path before the method, nothing decoded before matching, an empty segment
       standing for an empty parameter before another segment and for none at the end), `HEAD`, `405` with `Allow` for any
       method, percent-decoding of parameters, catch-alls, text after a parameter, an area's and
       an API's prefix, every path under an API's prefix being its own, an API's failures, the
       host check, and an unstaged route's. It passes on axum now, and every later step passes it
       unchanged; a case the next step finds missing is added to it first, on axum.
    2. A router of Corten's on matchit in place of axum's `Router` and `MethodRouter`, and
       `unstaged` as a route whose stages are left out rather than checks written into its
       handler. The stages keep the shape they have unless callgrind counts fewer for another:
       rewritten as combinators on axum's router they cost about 200 to 263 instructions more with
       jemalloc ([Choice 28](#choice-fixed-stages), Not chosen), so the prototype's one future with
       no `async` block per stage is measured again on the new router before it replaces them.
       It lands when the suite passes and callgrind (CONTRIBUTING.md, Pull requests) counts no
       more on card-market's item page, its JSON and an API request than axum's router does.
       It has landed. With the router (at `373a10f9`) the suite passes unchanged, and every request
       measured costs less (jemalloc,
       median of five runs in process, three over a socket): card-market's item page 79,731
       instructions against 82,792 and its JSON 59,754 against 63,008; an API request 13,112
       against 15,726, a page route 18,277 against 21,222, their 404s 12,171 and 18,091 against
       14,094 and 19,980, and an `unstaged` route 6,932 against 8,479, under axum's plain router
       in the same build (7,099). Most of it is fewer copies of the request and fewer allocations
       (`memcpy`, `malloc` and `free` about 1,100 fewer on the API request). The stages kept their
       shape, now one boxed future the router calls (`router::Stages`) rather than a tower
       service in a `route_layer`: the prototype's shape, the stages written as combinators with
       no `async` block of their own, measured on this router (on `8ddeaea2`, the same
       requests), cost more on every one, an API request 13,226 against 13,120, a page route
       18,657 against 18,298, one with a middleware 18,788 against 18,583 and their 404s 12,263 and
       18,458 against 12,171 and 18,091 with jemalloc, and 16 to 298 more with glibc's allocator,
       so it was not taken. An unstaged route is a route whose stages are left out: the router
       sends it through a lane (`route::Lane`) in their place, a `Stages` of its own that holds
       the host check, the headers every unstaged answer gets, the panic catch and, under an API's
       prefix, the API's JSON, and that its `404` for a segment without the text after its
       parameter and its `405`, the router's own, meet as its handler's answer does. Its handler
       is the app's; the lane wraps the handler's boxed future in a box of its own (two boxes, since axum's
       handler boxed its own future; step 3, below, keeps two). It costs 71 to 86 instructions more than those checks written into the handler: 7,003
       against 6,932 in the app's routes and 7,068 against 6,982 in an API's module (67 and 82
       with glibc), within the about 100 [Choice 28](#choice-fixed-stages) allows, which says why
       it is taken. Staged requests moved by 24 fewer to 8 more, within what two builds differ by.
       Three other shapes were measured and not taken, each on one build with no control of its
       own, so the differences are within what two builds can differ by and the choice between
       them is tentative: the lane boxed as a second future of its own, 110 more than the checks
       in the handler; a `laned` that moves its answer less, 19 more than the lane; and the lane
       held by the router's future, outside `Stages`, 55 fewer than the checks in the handler (126
       fewer than the lane) for an unstaged route but 16 to 60 more for each of six staged
       requests, all in the same direction, and staged requests are most of an app's. Wall times (in process, seven runs of 200,000 requests) differ by less than
       their runs do: 859 ns against 839 for an unstaged route, with runs from 768 to 1,064. Until
       step 3, a handler that took one of axum's readers of what axum's router stored (`Path`,
       `RawPathParams`, `MatchedPath`), which compiled and would have answered `500` to every
       request, was refused when its route was made, by its arguments' type names; step 3 refuses
       it when the app compiles.
    3. The handler and reader traits Corten's own, keeping axum's names, `Rejection` and
       `from_request_parts(parts, state)` ([Choice 21](#choice-own-extractors)), so an app's own
       extractors keep compiling, with a note for each change an app sees.
       It has landed (`crates/corten/src/handler.rs`): `Handler`, `FromRequestParts`,
       `OptionalFromRequestParts`, `FromRequest` and `State` are Corten's, one `Handler` impl per
       arity reading the arguments in axum's order, the head's first and the last from the whole
       request. The dispatch suite passes unchanged, and so do every crate test and doctest but
       the message test, whose second error now names Corten's trait in Corten's words. What an
       app sees is in the changelog: an extractor's `impl` names `corten::extract`, not axum; axum's
       own extractors (`Path`, `Query`, `Extension`, ..) and `axum::extract::State` no longer fill a
       handler argument and fail to compile, where `Path` and `RawPathParams` were refused at
       startup. Measured against step 2 at `7bba1e2b` (callgrind, release, five runs with jemalloc and
       three with glibc, every run the same), every staged request that reaches a handler costs
       about 100 fewer with jemalloc and 150 to 170 fewer with glibc, and the rest the same: an API
       request 13,006 against 13,110 (14,034 against 14,187 with glibc), a page route 18,185
       against 18,288 (19,490 against 19,655), one with a middleware 18,469 against 18,573
       (19,771 against 19,938), a staged route beside an unstaged one 18,196 against 18,299
       (19,520 against 19,677), an unstaged route 7,009 against 7,007 and 7,060 against 7,072 in
       an API's module (7,813 against 7,811 and 7,866 against 7,878), the 404s, which call no
       handler of the app's, 12,167 and 18,098 against 12,167 and 18,099, and axum's plain router
       7,085 (8,099) in both. Two other shapes were measured once each and not
       taken: the request split into its head and body inside the handler's future rather than
       before it, 62 more an unstaged request and about 60 more a staged one; and an unstaged
       route's handler boxed once with its lane (step 2's `call_in`, which makes one box of the two
       now that the handler's future is not boxed by axum) rather than boxed by itself
       and again by the lane, 29 more an unstaged request, though staged requests, which it does
       not touch, moved by 18 too, so the two are within what layout moves and the simpler one,
       with no `call_in`, is taken. `Bytes`, `Json` and `Form` still read a body with
       axum's readers until step 4.
    4. Server-sent events written by Corten (`text/event-stream`, a standard format) and
       `corten::Listener` a trait of its own; then axum leaves Corten's dependencies, which
       reopens [Choice 21](#choice-own-extractors)'s `corten::axum` for a test's stand-in server:
       an app's test that wants one then depends on axum itself.

    Not chosen: keeping axum's router and handlers, which this Choice held until the seam above
    was measured (functions named for axum, tower or matchit were 2.5% of the item page's user
    instructions, which undercounts what owning dispatch saves, since allocations and copies axum
    causes are counted in other rows); its reason was correctness, that a router of Corten's
    would write again what axum's tests hold it to (`HEAD`, `405` with `Allow`,
    percent-decoding, nesting, fallbacks), and in the prototype four review rounds in a row each
    found a `HEAD` fault. The suite in step 1 is that risk's answer: those cases are now Corten's
    tests, read on the wire, before anything replaces axum. Nor stages an app orders itself, as
    the prototype has them, where nothing checks that the host check comes before an app's
    middleware; nor replacing hyper, whose reasons are in 2 above; nor a transport of Corten's
    for UDP or QUIC before HTTP/3 is ([Limit 14](#limit-http1)); nor the server-sent events
    encoder first, which saves nothing measured and is the smallest of the parts.

    `#[corten::routes]` names each handler through Corten's `RouteHandler`, one impl per arity
    with `Handler`'s bounds written out, so a handler argument no request can fill fails Corten's
    trait in its words and a second error names the argument in Corten's words too ("a request
    cannot fill `T`", `tests/handler_message.rs`); one impl over every `Handler` reported the
    unmet `Handler<_, ()>` and named no argument. axum's features are only
    `http1` and `tokio` (and `json` with Corten's `json`): `original-uri` copied every request's
    URI for nothing to read (153 instructions a request at `fa597483`), `matched-path` named the
    route for axum's router, which Corten's now does itself (`corten::middleware::MatchedPath`), and
    `form`, `query`, `tracing` and `tower-log` serve readers Corten has its own of.

    Stands on: measured (callgrind, release, five runs with jemalloc and three with glibc, every
    run the same, Corten's handler traits against axum's, step 3 at its commit against step 2 at
    `7bba1e2b`: staged requests 103 to 104 fewer with jemalloc and 153 to 167 with glibc, an
    unstaged route and the 404s within 12; on uncommitted variants of it, one run each, the
    request split inside the handler's future 62 more unstaged and about 60 more staged, and
    `call_in` 29 more unstaged with staged requests moved 18); measured (callgrind, release, jemalloc and glibc, five runs each in process and
    three over one keep-alive socket for card-market, Corten's router at `373a10f9` against
    axum's at `7e897bd6`: every request above costs less, by 1,547 to 3,254 instructions with
    jemalloc and 1,791 to 4,135 with glibc); measured (callgrind, release, three runs each, every
    run the same, Corten's router at `8ddeaea2` against an uncommitted variant of it with the
    stages written as combinators, the variant [Choice 28](#choice-fixed-stages) measured on axum's
    router carried over: 92 to 367 instructions more a staged request with jemalloc, 16 to 298 with
    glibc); measured (callgrind, release, five runs each with jemalloc and three with glibc, every
    run the same, an unstaged route through its lane at `bfa20380` against its checks in its
    handler at `8ddeaea2`: 7,003 against 6,932 in the app's routes and 7,068 against 6,982 in an
    API's with jemalloc, 7,812 against 7,745 and 7,879 against 7,797 with glibc; an API request
    13,110 against 13,120, a page route 18,288 against 18,298, one with a middleware 18,573
    against 18,583, a staged route beside an unstaged one 18,299 against 18,323, and the 404s
    12,167 and 18,099 against 12,171 and 18,091; on uncommitted variants, one run each, the lane
    as a second boxed future 7,042 and the lane held by the router's future 6,877, with staged
    requests 16 to 60 more; wall times, seven runs each in process with jemalloc, medians 859 ns
    against 839 unstaged, 882 against 942 in an API's module and 1,989 against 2,066 for an API
    request, every pair's runs overlapping by more than the difference); measured (callgrind, release, five runs each: an `unstaged` route in the app's
    routes with its host check in a `route_layer` 9,230 (9,229 to 9,233) instructions a request against 8,479 with its checks in the handler, both
    with jemalloc, against main `c65c10ec`); measured (callgrind, release, five runs each, the
    prototype at `7cea4970` on the branch `codex/pipeline-prototype`, not yet pushed or merged, its
    result files in `prototypes/pipeline/results` there, against axum 0.8.9 and Corten at `f4d340c3`: 5,393 against axum's
    8,508 for one JSON request in process through a router with no stages, 9,493 with every
    default stage against Corten's 17,336, and over a loopback socket 12,485 against 15,904;
    whole pipelines, not the router alone, and the prototype's defaults do less than Corten's: no
    error page, tag, compression or layout reads); measured, one pair of runs (functions named for
    axum, tower or matchit 1.7% of the item page's user instructions, 2.5% with their code inside
    Corten's, the item's JSON 3.8%, on `b79a6b23`); platform (hyper 1.12 reads and writes
    HTTP/1.1, matchit 0.8 matches paths, and `http` 1 is the type hyper and its clients share);
    platform (rustc names the argument no request can fill for one impl per arity, where one impl
    over every axum `Handler` did not); reasoned (the dispatch suite reads only the wire, so it
    holds a router of Corten's to what axum does without naming either); value (fast and proven
    fast, Value 1; small surface, deliberate dependencies, Value 6; correctness before speed, the
    order the Values give, which is why the suite comes first).

    Revisit when: a router of Corten's cannot pass the dispatch suite without changing a case, or
    counts more than axum's on any request measured in step 2 (that step then waits, and this
    Choice says why); an axum release changes `IntoResponse` or `Sse` in a way apps see before
    step 4 lands; or Corten serves HTTP/2 or HTTP/3 itself
    ([Limit 14](#limit-http1)), which adds a protocol under 3 and must leave 4 to 7 as they are.

    Last checked: 2026-11-05, the split by crate on `b79a6b23`, recorded at `0154ac63`; 2026-11-06,
    the `original-uri` runs on `fa597483`; 2026-11-06, rustc 1.99.1's error for an argument no
    request fills, held by `crates/corten/tests/handler_message.rs` at `84d33d0b`; 2026-11-08,
    the prototype's runs (`prototypes/pipeline/results/round4.tsv` and `round4-socket.tsv`),
    the prototype at `7cea4970`; 2026-11-09, the `route_layer` runs, on an uncommitted variant of
    `3452790a` with the host check and the API's JSON in a `route_layer`; 2026-11-09, the
    dispatch suite on axum 0.8.9, hyper 1.12.0 and matchit 0.8.4, at `599c302a`; 2026-11-09,
    Corten's router against axum's, at `373a10f9`, with the suite unchanged; 2026-11-09, the
    stages as combinators on Corten's router, on the uncommitted variant of `8ddeaea2`, and the
    unstaged route's lane, at `bfa20380`, with the suite unchanged; 2026-11-09, Corten's handler
    traits (step 3) against step 2 at `7bba1e2b`, with the suite unchanged; 2026-11-09, the lane boxed
    as a second future and held by the router's future, uncommitted variants of `8ddeaea2`, and
    the `laned` variant of `fa0b1525`.

26. <a id="choice-derived-deserialize"></a>**`#[derive(Fields)]` and `#[derive(UrlValue)]` write serde's
    `Deserialize` themselves, as serde's derive writes it.** Each already reads a type's
    `#[serde(..)]` attributes to name a form's keys or a URL's words, so with serde's derive beside
    it the attributes had two readers and a form type derived two things for one meaning. The impl
    follows serde_derive's for the attributes these types use (names, aliases, defaults, `skip`,
    `other`, `deny_unknown_fields`, `borrow`, `bound`, `expecting`, and the bounds serde infers)
    and refuses at compile time one that reads the type another way (`flatten`, `with`, `from`,
    `tag` and the like), whose field takes a type of its own. Not chosen: depending on serde_derive
    from `corten-macros`, which builds on `proc_macro` alone, or keeping the second derive, which a
    derive cannot add to the item it reads
    ([#763 Corten's form, route and JSON readers still require serde's Deserialize beside their own derives, and FromJson allocates every string it reads from an upstream body](https://github.com/corten-run/corten/issues/763)).

    Stands on: platform (serde_derive 1.0.229's impl and bound inference, which
    `crates/corten/tests/derived_deserialize.rs` holds this one to by reading each of its types
    twice, with this derive and with serde's, and comparing values, errors and the names passed to
    the deserializer); measured (reading a seven-field form costs 9,241 instructions before, on
    `62eb57f7`, and after, on `8cd5934e`: callgrind, release build, 1,200 reads less 200 over
    1,000, three runs each, `form::de::tests::what_reading_a_form_costs`); reasoned (`corten-macros` keeps no
    dependencies); value (one way to do each thing and a small surface, Values 5 and 6).

    Revisit when: a serde release changes what its derive writes for these attributes, which the
    twin tests would show; or apps need an attribute this refuses often enough that a type of
    their own is the second way.

    Last checked: 2026-11-06, serde_derive 1.0.229 at `8cd5934e`; 2026-11-06, the form read at
    `8cd5934e`.

27. <a id="choice-caller-types"></a>**Who may use a route is in its handler's type, and every route reaches the app through
    the checks that read it.** A handler takes `Caller<T>`, whose `Identify` finds the caller or
    refuses (sign in, 401, 403, 503), and a routes module's `caller = T` holds every handler in it
    to that at compile time, so a route added later is covered. The lookup runs only when a handler
    or middleware reads it, once per request, and reading it makes the answer private. A route's
    answer type says how it fails (`HtmlResult`: the error page; `JsonResult<T>`: JSON) and
    whether a shared cache may keep it (`Public<..>`, whose handler may only take `Anonymous`
    inputs and whose page cannot set a cookie). A route that says `no_store` is checked as
    answering `NoStore<..>` of its handler's type (`no_store(post)`: only the handlers of the
    methods it names), so that one word in the route, not the handler's signature, says nothing
    may keep it; a handler there that returns `NoStore<..>` too says it twice, and a hand-added
    route says it with `NoStore<..>`. Every route reaches the app through these checks: `App::new`
    takes the `Routes` a `#[corten::routes]` module makes, and `Area::route` and `Api::route` take
    `Methods`, made by Corten's `get`, `post` and the others, which check the same things. A plain
    axum `Router` or method router does not fit any of them, so no route given to the `App` is
    unchecked (what an app answers in a `.layer(l)` around the `Router` that `App::router()` hands
    out, or in a server of its own around it, is its own). A WebSocket (`Upgrade`)
    and another server's answer passed on (`Relay`) are such routes too. A route that says
    `unstaged` ([Choice 28](#choice-fixed-stages)), in any routes module, meets no stage, so
    its answer type is not checked; its handler is checked instead to take only what the request line and the app hold
    (`corten::answer::Unstaged`: the route's `Params`, `Uri`, `Method` and `State`): no `Caller` and no headers, which carry
    the cookies and credentials, so no input Corten gives it says who is asking (an extractor of
    the app's own that implements `Unstaged` is the app's to keep so, as with `Anonymous`), and no
    reader of the body, which no deadline would end there and no same-origin check would keep
    another site from posting. A module with `caller = T`
    cannot hold one, and its handlers are a type (`UnstagedMethods`) that only the hidden
    `__unstaged_route`s of `Routes`, `Area` and `Api` take, so `Area::route` and `Api::route` still
    take only checked `Methods`. Not chosen: guards and
    a context object checked per request (`App::guard`, `Area::guard`, `App<C>`), which Corten
    had and removed in
    [#81 A route's handler says what it answers, who may call it and how it caches, checked for every route](https://github.com/corten-run/corten/pull/81).
    They covered a URL prefix, so a route added under it was covered, but one outside the prefix
    or opened with `App::unguarded` was open, nothing in its handler's type said so, and only a
    request found it. What the type cannot see stays the handler's
    ([Limit 11](#limit-caller-types)).

    Stands on: reasoned (a handler's arguments and return type are checked where the routes module
    is compiled, so a module's `caller = T`, `Public` and `no_store` hold every handler in it,
    and `Routes` and `Methods` are the only types `App::new`, `Area::route` and `Api::route`
    take, so no route given to the `App` skips them, an unstaged route's arguments standing in for
    its answer's); bet (most of an app's access rules are
    about who is asking, which a type can name, and the rest depend on the record, which the
    handler reads anyway); value (mistakes fail at compile time, Value 4).

    Revisit when: an app needs an access rule a type cannot name and a handler cannot check
    without repeating it in every handler of a module; or a way to give the `App` a route is
    found that does not pass `Routes` or `Methods`.

    Last checked: 2026-11-06, the `compile_fail` doctests that hold `caller = T`
    (`crates/corten/src/route.rs`) and the caller's own (`crates/corten/src/caller.rs`) at
    `bcd31ffe`; 2026-11-09, the `unstaged` `compile_fail` doctests in
    `crates/corten/src/route.rs` (a stage's input, a header reader, a body reader, a
    `caller = T` module, a path that reaches Corten's own, a method other than `get`,
    `prefetch`, `/health/live`, `/{*rest}`), at `f703d3f8`.

28. <a id="choice-fixed-stages"></a>**A request goes through fixed stages in one order, and the app's own steps are one
    `Middleware` tuple at one place in it; a route may say it goes through none.** The stages are
    `corten::middleware`'s; the app's steps are resolved at compile time. An area's or an API's
    own steps (`Area::middleware`, `Api::middleware`) run right after the app's, for the requests
    at its prefix; they are boxed, since which run depends on the path, and an app with none pays
    nothing for them. A route that says `unstaged` where it is declared, in the app's routes
    module, an area's or an API's, goes through none of the stages, the app's, area's and API's
    middleware among them, and every other route keeps every stage. It is every stage or no stage, so the
    order a reader checks is still one, and a flag, as `no_store` is, that names what the route
    goes without. It is for an answer that must cost what the router alone costs and is the same
    for everyone who can reach it (a public JSON figure a CDN fronts, a value every client polls),
    beside pages that need every stage; the stages add about 1.5 times what its handler, the
    router and the host check cost together (below). What it keeps is none of the stages and is
    the same for every unstaged route: a lane (`route::Lane`) the router runs in their place, wrapping the handler's boxed future,
    runs the host check every request meets, so a
    DNS-rebound page reads it no more than any route, and, under an API's prefix, writes a failure
    as the API writes every failure there (its Problem Details or `Api::errors` shape), the
    router's `405` and a segment without its suffix among them, so an API's clients still read
    every failure under its prefix as JSON; only a failure boxes anything for that. A tower layer
    around those routes alone (axum's `route_layer`) was built first and measured at 751
    instructions a request more than the same checks in the handler (jemalloc), since axum boxes a
    layered route again and clones that box on each request; the lane costs 71 to 86 more than
    the same checks in the handler (about 1%, which wall times did not show), taken for one place
    that says what goes around a route: the router holds the app's stages or the route's lane for
    each path, and its own `404` and `405` meet the lane as the handler's answer does, with no
    handler of their own. Value 1 still holds with it: the route stays under axum's plain router
    in the same build and inside the bound below, which is what this Choice holds it to
    ([Choice 25](#choice-axum-router), step 2, has the shapes measured). Its answer gets `X-Content-Type-Options: nosniff` and its own
    `Content-Security-Policy: sandbox` beside any the handler set, whatever its type, both
    added as the lane takes its answer: a browser takes it only as the type it
    says, a page of the app's cannot load it as a script (`script-src 'self'` trusts every URL of
    the app's), and a file it sends (an uploaded picture) runs no script on the app's origin; a
    client that reads it as data sees nothing else change, and a PDF the browser opens still shows
    in Chrome's, Edge's and Firefox's viewers; an answer that sets a cookie is
    `private, no-cache` (`no-store` when it says one) with no CDN caching header, so no shared cache hands one
    visitor's cookie to another; a panic is logged and answered `500` by the lane. It
    answers `get` alone and its handler reads no body: no same-origin check covers it, a form
    posted to it needs no preflight, so any site could make its visitors send one, and no deadline
    would end a slow body. An unstaged route whose path can answer at one of Corten's own paths
    does not compile where the path alone shows it, and one that can answer under a path the app
    adds is refused when the app starts, as is one declared outside the module of the innermost
    area or API whose prefix holds it (where a reader of that module would not see what it
    skips), one whose parameter can reach an area's or API's prefix, where a staged route is
    turned away per request and an unstaged one never would be, and one whose path another module
    routes too (a parameter's name and the text after it not counting, as the router matches),
    where the methods it lacks would answer with no stage. Not chosen: an app's own tower layer that
    answers the route's path before the stages (`.layer(l)`), which works today but is outside
    the routes module: its path is a
    string, not a typed route, its handler is checked for nothing, and a reader of the routes does
    not see it; hooks at several stages (before routing, after the caller, around the error page), each a
    place an app's step could run and a reader of the app would have to check; what must see the
    raw request first is a tower layer around the whole app ([Limit 12](#limit-fixed-stages)).
    Nor presets that keep some stages and drop others, each another order to
    read and test, with no app yet needing one (`unstaged` is no stage at all, which
    listings-feed's sequence route uses; its lane chooses nothing, only the checks no route goes
    without, the same for every unstaged route, [Choice 25](#choice-axum-router), step 2); nor the stages rewritten as combinators, measured
    on variants that are not in the repository (Stands on): on axum's router about 200 to 360
    instructions fewer a request with glibc's allocator but about 200 to 263 more with jemalloc,
    which the images preload, and on Corten's own router more with both, 92 to 367 with jemalloc
    and 16 to 298 with glibc; nor making the stages cheap
    enough for such a route instead, since a profile of the staged request (callgrind, jemalloc)
    spread the 13,266 instructions it costs over a route without them across the stages' own work
    (the tag's hash and body read, 3,494 of them; the security headers, 2,371; the error page's
    plumbing, the signal and the boxed future most of the rest), which such a route would still pay;
    nor refusing an answer
    type that sends HTML, since a raw `Response`, which an unstaged route exists to allow, carries any
    content type, and the sandbox keeps such a document from running script; nor sending the
    answer with no header added, as this Choice first had it, which left a `text/plain` echo of
    the URL loadable as a script by the app's own pages and an uploaded SVG running script on its
    origin: correctness comes before the cost (below); nor `Media` setting the headers itself,
    measured on an API request answering `Media` at 524 instructions more with `nosniff` on every
    type and 106 more checking its type alone, paid on every route for what only an unstaged one
    needs; nor adding the sandbox only to a type that runs script, or only when the handler's
    policy has none, which reads text a handler writes (a list of types, a second header, a
    `sandbox` that allows the same origin) and so can be fooled, and cost more: an unstaged request
    measured 8,242 instructions reading them against 8,067 adding both headers always
    (jemalloc); nor writes or body readers on an unstaged route, which no app has asked for and which
    no same-origin check or deadline would cover; nor the form this Choice first had,
    `stages = bare`: a key with one value, whose word was not so (it kept `nosniff`, the sandbox,
    the cookie rule and the panic catch), with no host check, so its answer had to be one anyone
    anywhere may read, and refused in an area's or an API's module and under their prefixes, which
    kept a public figure out of the API it belongs in and made it a rule with exceptions; nor an
    API's allowed origins (CORS) or deadline on it, which are its stages: a partner's page reads it
    through a route with stages, or its handler sends `Access-Control-Allow-Origin` itself.

    That host check put an unstaged route 12% over a plain axum router (jemalloc; 10% with
    glibc), past the about 10% this Choice was to be revisited at. It was: a route the host check
    did not cover answered a DNS-rebound page, and correctness comes before the 494 instructions
    (the README's Values), so the check stays, and the bound below is now the 12% it costs with
    the check (8,479 against 7,559): a change that adds more than the about 100 instructions two
    builds of the same code differ by (measured on the pipeline prototype, which the repository
    does not hold) reopens this. The router of Corten's own ([Choice 25](#choice-axum-router),
    step 2) took it under, not dropping the check: an unstaged route then cost 6,932 instructions
    against 7,099 for a plain axum router in the same build (jemalloc; 7,745 against 8,117 with
    glibc). Its checks then left its handler for a lane the router runs in place of its stages,
    71 more in the app's routes (7,003; 7,812 with glibc) and 86 in an API's module (7,068; 7,879).
    The bound stays where it was, below: the plain axum router counted the same in both builds
    (7,085; 8,099 with glibc), so these are the lane's own cost and not a difference between
    builds, and the next change to an unstaged route has about 29 left in the app's routes and 14
    in an API's module.

    Stands on: measured (callgrind, release, five runs each, on a bench binary that is not in the
    repository, against main `9200aae4`: a request in an area with a pass-through middleware,
    one boxed future, 21,374 to 21,511 instructions against 20,497 to 20,646 with none; a request
    outside that area 19,909 to 19,913 against 19,706; an app whose areas and APIs have none runs
    Corten's own code within 18 instructions of before, while its whole request rose from 19,696
    to 19,976 to 19,988 in the allocator with the same allocations, so the same layout effect may
    be in the request outside the area); measured (callgrind, release, the same JSON handler
    answering `Media`, a request counted as the run of 1,200 less the run of 200 over 1,000, five
    runs each, this change's request path, the staged variants alternating with main `c65c10ec`,
    median and range: with jemalloc an unstaged route 8,479 instructions a request in all five
    runs, 8,537 in an API's module, the same handler through the stages 21,220 (21,218 to 21,228;
    main 21,307, 21,300 to 21,317), a staged route beside an unstaged one 21,252 (21,245 to
    21,265), an API request 15,725 against main's 15,813, its 404 14,106 against 14,082 and a
    page's 404 19,991 against 19,996, and a plain axum router 7,559; with glibc's allocator an
    unstaged route 9,537 (9,531 to 9,539), 9,589 in an API's module, and a plain axum router
    8,635. Before the host check (`stages = bare` at `3452790a`) the same route was 7,985 (7,984
    to 7,986) with jemalloc and 9,040 with glibc, and with the host check and the API's JSON in
    a `route_layer` 9,230; the 494 the host check adds is mostly its read of `Host` and the
    match against the app's names (`security::named`, about 400 in the profile)); measured
    (callgrind, release, five runs each, the same handler on Corten's router at `373a10f9`:
    unstaged 6,932 with jemalloc and 7,745 with glibc in every run, against 7,099 and 8,117 for a
    plain axum router in the same build); measured (callgrind, release, five runs each, the same
    handler through its lane at `bfa20380`: 7,003 with jemalloc in every run and 7,068 in an
    API's module, against 6,932 and 6,982 with its checks in its handler at `8ddeaea2`, and 7,085
    for a plain axum router in both builds; 7,812 and 7,879 with glibc, three runs, against 7,745
    and 7,797, and 8,099 for a plain axum router in both); measured (callgrind, release, three runs each, every run the same, an uncommitted
    variant of `fa0b1525` whose `laned` adds the headers as it takes the handler's answer: 7,022
    and 7,083 against 7,003 and 7,068); measured (callgrind, release, three runs each, the stages written as combinators
    on Corten's router, an uncommitted variant of `8ddeaea2`: 92 to 367 instructions more a
    staged request with jemalloc and 16 to 298 with glibc); measured
    (callgrind, inclusive counts by function, jemalloc, one run each, the bench binary at
    `3452790a`: of the 13,266 instructions the stages add to a request, the tag's hash and body
    read 3,494, the security headers 2,371, and the error page's plumbing, the signal and the
    boxed future most of the rest); measured (callgrind, release, the same request path, on an
    uncommitted variant of main `c65c10ec` with the stages written as combinators on axum's
    router, which the repository does not hold: about 200 to 360 instructions a request fewer
    than main with glibc's allocator, about 200 to 263 more with jemalloc); reasoned (one place for the app's steps is
    one order to read, a tuple resolved at compile time costs no box, and a route that needs none
    of it says so where it is declared); platform (a PDF sent with a sandbox shows in the viewers of
    Chrome, Edge and Firefox as one sent without it, probed as Last checked says; Safari's is not
    run, since the repository's WebKit has no PDF viewer, and WebKit's bug tracker records that it
    showed nothing for one until a fix in December 2024, which was read, not run); bet (apps have an answer anyone may read whose cost the
    stages would make about 2.5 times as costly, beside pages that need them all; listings-feed's
    sequence route, which its failover benchmark reads, is the first use, and no app's in
    production is yet); value
    (one way to do each thing, Value 5, and good defaults with easy overrides,
    Value 7; one place that says what goes around a route, the stages or an unstaged route's lane,
    for 71 to 86 instructions that keep the route inside the bound below, Value 5 within Value 1).

    Revisit when: an app needs a step at a stage the tuple's place cannot reach and a tower
    layer around the app cannot serve it; or a route needs some stages and not others, which
    `unstaged` cannot give (a write, a body, an API's allowed origins or a deadline on it among
    them); or a
    browser the runtime supports shows a PDF sent with a sandbox differently from one sent without
    it; or no
    app but listings-feed uses `unstaged` by the next minor release; or an unstaged route costs more
    than about 100 instructions over what it cost with its checks in its handler at `8ddeaea2`
    with jemalloc, 6,932 in the app's routes and 6,982 in an API's module (7,003 and 7,068
    through its lane since), against a plain axum router in the same build (7,085 in both), the
    control that shows whether two builds differ; or a request outside every area costs more than twice
    the about 200 instructions measured here over the build before area middleware (the lookup
    and any layout effect together; layout alone moved a whole request by about 280). Area
    middleware has no switch, so the next check builds current main with the prefix lookup taken
    out by hand rather than going back to `9200aae4`.

    Last checked: 2026-10-29, the area middleware runs of
    [#353 Area and API middleware: a write limit for the requests at a prefix, with no path checks](https://github.com/corten-run/corten/pull/353)
    (recorded at `04c2393f`; the bench binary was not committed, so the next check writes its
    own); 2026-11-09, the `unstaged` runs on this change against main `c65c10ec` and `stages = bare`
    at `3452790a` (the bench binary was not committed, so the next check writes its own: the same
    JSON handler answered in process by an `App` with the route unstaged, in the app's routes and
    in an API's, by the same `App` with it staged, and by a plain axum `Router`); 2026-11-09, the
    profile of the staged request against `stages = bare` (callgrind, inclusive counts by
    function, jemalloc, one run each) on the bench binary built at `3452790a`; 2026-11-08, the
    stages as combinators on the uncommitted variant of `c65c10ec`; 2026-11-09, a PDF sent `inline` with `Content-Security-Policy: sandbox` shown by
    the viewers of Chrome 156.0.8078.49, Edge 157.0.4341.42 and Firefox 157.0 (Playwright's, its
    PDF viewer turned on) as one sent without it (Playwright's WebKit 27.2 has no PDF viewer and
    downloads both, so Safari was not run), and
    [WebKit bug 284594](https://bugs.webkit.org/show_bug.cgi?id=284594), fixed in December 2024,
    was read; 2026-11-09, the unstaged route on Corten's router at `373a10f9` against axum's
    plain router in the same build ([Choice 25](#choice-axum-router), step 2); 2026-11-09, the
    unstaged route through its lane at `bfa20380` against its checks in its handler at
    `8ddeaea2`; 2026-11-09, the stages as combinators on Corten's router, on an uncommitted
    variant of `8ddeaea2`; 2026-11-09, the `laned` variant of `fa0b1525`.

29. <a id="choice-upload-xhr"></a>**A write whose form hears its progress (`on:corten:progress`) is sent by
    `XMLHttpRequest`, in a module of its own; every other submit is a `fetch`.** `fetch` reports
    nothing of a request body as it is sent, and `XMLHttpRequest`'s `upload` reports each step as
    the browser's `ProgressEvent`. Only a same-origin `data-patch` form sent as
    `multipart/form-data` with a progress handler goes this way, so other forms keep `fetch`'s
    behavior, and `html!` refuses the handler on a form the runtime would never send so. The module
    (`corten-upload`) is loaded by the pages with such a form; every page's runtime carries the few
    lines that load it and hand it the form. Its answer is made a `Response` and read by the same
    code as `fetch`'s, with the same abort (never sent once the signal is aborted) and the same
    failure for a network error; a status a `Response` cannot have (above 599) is that failure
    too, `corten:error` with status 0, where `fetch` would hand it on. Not chosen: a streamed request body (`ReadableStream` with
    `duplex: "half"`), whose reads say what the browser took from the stream, not what was sent,
    and which needs HTTP/2 or later in Chromium and is not sent by Firefox or WebKit; counting
    bytes in a service worker, which sees the same stream.

    Stands on: platform (`fetch` has no upload progress, and a streamed request body is not sent
    by every engine; read in the Fetch standard and MDN, not probed for this choice); reasoned
    (one module only the pages that need it load keeps the cost off every other page; the
    `Response` it hands back keeps one reading of an answer).

    Revisit when: `fetch` reports a request body's progress in every engine the runtime supports
    (the Fetch standard's `FetchObserver` or a successor); the module then goes, the submit is a
    `fetch` again, and its redirects follow [Choice 15](#choice-corten-answer-headers).

    Last checked: 2026-11-07, upload progress by `XMLHttpRequest`, probed in Chromium 156, Firefox
    157 and WebKit 27.2 by the watchlist smoke test (`fetch` and streamed bodies read in the Fetch
    standard and MDN, not probed).

30. <a id="choice-deadline-body"></a>**A deadline that passes while the handler waits for more of the request body is
    the client's 408; the idle time stays a minute and the deadline 30 seconds.** RFC 9110 gives
    408 to a request the server did not receive whole in the time it was prepared to wait, and at
    such a deadline the body has not arrived whole: the client stopped, or is sending slower than
    the deadline allows (a server too busy to read its socket looks the same). So at the deadline
    Corten asks what the handler's last poll waited for: more of the body is the 408
    (`Failure::Failed`, as `?` on `UploadError::Stalled` gives), more of a body over an
    `Upload`'s or a `pieces_up_to` limit that is being read past is the 413 that read gives, and
    anything else is the 503 (`Failure::TimedOut`). A handler that read the whole body and then
    took too long, or never read it, is the server's 503. `bytes_up_to`'s read past is a body
    wait like any other, the 408, since its handler answers an oversized body in a shape of its
    own that the deadline cannot give. The 408 is warned of as the 503 is, since a large upload
    still being sent at the deadline says the deadline is too short for it. The mark is one
    thread-local value: the body `corten::serve` hands the router sets it when a read waits, a
    read past a limit sets it to that limit, and the deadline clears it before each poll of the
    handler, so nothing is allocated. A request served another way is not marked as waiting for
    the body, so its deadline is the 503 there (a read past a limit is still marked). Not chosen:
    an idle time under the deadline (any route whose deadline is set lower brings the 503 back,
    and nginx's `client_body_timeout`, whose minute the idle time follows, is usually what a proxy
    in front already uses); a deadline that starts after the body has arrived (a client that sends
    slowly would then hold a handler's slot past any bound).

    Stands on: platform (RFC 9110, section 15.5.9: 408 Request Timeout); reasoned (the wait is
    known where the deadline is, in the same poll, so the mark reads that poll's wait and needs no
    allocation); measured (callgrind, card-market's item page and its JSON over one keep-alive
    connection, 1,300 requests less 300 over 1,000, three repeats each, medians and ranges: the
    page 86,737 (86,721 to 86,743) instructions a request on `5dba8477` and 86,767 (86,761 to
    86,779) with the mark, 30 more, a difference of 0.03%; its JSON 65,737 (65,736 to 65,764) and
    65,761 (65,748 to 65,764), ranges that overlap, so no difference is shown).

    Revisit when: a body read moves off the handler's task (a reader on a task of its own would
    not mark the handler's thread; nor does one driven inside something that is not polled again
    when the deadline's timer fires, such as a `FuturesUnordered` of reads, which is the 503
    today), or Corten serves HTTP/2, where a body's reads would need the same mark and a test
    that a stalled stream is the 408 while the connection's other streams go on.

    Last checked: 2026-11-07, the count on `e4d8281c` (`5dba8477` with this change), and the
    socket tests at the default deadline.

31. <a id="choice-favicon-path"></a>**`/favicon.ico` is the static directory's icon itself, the
    SVG when there is no `.ico`, not a redirect to its versioned URL.** Browsers ask for the
    path on their own for a document that names no icon, and so do feed readers and crawlers, so
    with no answer of Corten's each such request was the app's 404 page, its layout reads
    included. Corten answers it from the directory the app already gives `App::assets`:
    `favicon.ico` when there is one, else `favicon.svg` (the icon `corten new` writes), sent
    with its own type, a day's public cache and its ETag; with neither, a 404 with no body and
    an hour's. A page or API route of the app's that the router would pick for the path (written
    as it, or a parameter or catch-all route that matches it) takes it instead, whatever its
    methods, as an app's own answer always does for a fixed path an app may want (the health
    checks are Corten's alone because a platform probes them). The SVG is sent rather than a
    redirect because a redirect costs a second request for every client that asks, and it would
    point at a versioned URL that changes with each deploy, so it could not be cached for long
    without naming an old version.
    The file is chosen once, at startup. Not chosen: refusing an app's route at the path at
    startup (an app that draws its icon, or answers it per tenant, would lose the path); a
    redirect (above).

    Stands on: reasoned (one request instead of two, and the redirect's target would change
    with each deploy); bet (a client that asks `/favicon.ico` decodes what it gets by the type
    it is sent with, as for any image, so an SVG there is shown wherever an SVG icon is;
    nothing here checks it in a browser or a crawler); measured (callgrind,
    `what_a_page_with_layout_reads_costs`, 1,200 requests less 200 over 1,000 in process, three
    repeats each, medians and ranges: 65,655 (65,637 to 65,665) instructions a request on
    `82af2ec4` and 65,623 (65,613 to 65,711) on `975ceec1`, with this route, ranges that
    overlap, so no difference is shown);
    value (the icon the template ships answers the browser's own request, and a route of the
    app's still takes it, Values 7).

    Revisit when: a client that matters shows no icon for an SVG sent at `/favicon.ico` but
    would after a redirect, or an app needs more than one icon at the path (per area or per
    host).

    Last checked: 2026-11-07, the cases on `975ceec1` by the crate's tests and card-market's
    smoke, and the callgrind count on `82af2ec4` and `975ceec1`.

## Rules

1. <a id="rule-html-macro"></a>Markup is written in `html!`, never built from strings in a script. A script makes new
   elements by cloning markup the server rendered (a `<template ref={rest}>`, or a view's rows,
   `rows(..).push(items)`, filled through typed holes), and moves, shows, hides or writes the
   ones on the page. (One exception: `ComboBox` mirrors the server's `<option>`s into its
   listbox, so each option is sent once.) The browser holds scripts to it: pages require Trusted
   Types, and only the runtime's policy, which takes the server's answers to its own requests, may
   turn a string into markup ([app guide](guide/app.md#a-policy-for-part-of-the-app)).
2. <a id="rule-patchable-components"></a>A fragment that can be patched is a component, rendered by the page and by the patch, so the
   two cannot drift. It is declared `-> impl Patch`, and its markup's top-level elements each have
   a `#[derive(Id)]` id, which the compiler checks (`view::Patch`), so no patch loses an element in
   the browser.
3. <a id="rule-handler-arguments"></a>A handler reaches the page only through its arguments: refs, `event`, `target`, `signal`,
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
4. <a id="rule-user-facing-text"></a>User-facing text lives in views, the view model or the catalog, never in scripts. Which of
   the first and the last is one rule per app (`docs/guide/views.md`, Text): an app with one
   locale writes fixed text as literals in its views, and the catalog holds only what needs it (a
   count, text with arguments, text a script fills); an app with more than one locale writes all of it through the
   catalog. Text that
   depends on what a script computed ("3 selected") is a catalog message the markup passes
   unfilled (`t.js().rows_selected()`) and the script fills in (`label({ count })`): the
   browser formats it with no round trip, and the compiler checks its arguments against the
   handler's `Message<"count">` (`docs/guide/scripts.md`, Text a script computes).
5. <a id="rule-works-without-js"></a>Pages and actions work without JavaScript: links are links and forms post. A feature only a
   browser can provide (drag and drop, a canvas) needs JavaScript; one that makes a server action
   instant (filtering the rows on the page as you type) keeps the form that does it without.
6. <a id="rule-page-view-model"></a>A page another surface reads derives `Serialize`, and its fields are its whole view model
   (formatted text included). Then `req.screen` gives every surface the same data.
7. <a id="rule-app-and-areas"></a>`App` configures the whole app; a part of it under a URL prefix is an `Area` (or an `Api`
   for routes that answer only JSON), which owns its routes. Its prefix and its routes are route
   types (`#[corten::routes(area = Admin)]` or `(api = ApiRoot)` on the module of its routes,
   `.area(admin::area)`), so a route outside the prefix does not compile. A new setting that applies to a prefix goes on `Area` or `Api`, never on
   `App` as a method taking a prefix string. Who is asking is not a setting: a handler takes
   `Caller<T>`, and an area's routes module says `caller = T`, so a handler there that does not
   take it does not compile. Before adding to `App`, check whether the
   setting belongs on one of those, and whether the builder still reads as one list of settings
   with one way to give each; reorganize it when it does not, rather than add a second way.
8. <a id="rule-compile-errors"></a>A mistake the compiler can see is a compile error, with a `compile_fail` doctest: a type, a
   trait bound, or a `const` assertion over a route's `PATH`. One it cannot see (two settings
   that clash, a `var(--x)` no stylesheet on its pages declares, a PWA that names a static file in
   an app given no static directory)
   fails at startup, and only what depends on the
   request is checked per request. A check that moves earlier also leaves the request path.
9. <a id="rule-layout-props"></a>A layout's props are what most pages set: the title and the page's own head tags. A page that
   needs a different document (a print view, an embed) uses another layout component; a layout
   does not grow a flag per page.
10. <a id="rule-standard-formats"></a>A header, wire format or file format that leaves Corten (read by another client, another
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
    would let Corten move to it ([Choice 11](#choice-corten-request-header), [Choice 12](#choice-own-prefetch),
    [Choice 14](#choice-feed-patch-rows), [Choice 15](#choice-corten-answer-headers), [Choice 18](#choice-custom-media-breakpoints); [Choice 24](#choice-openapi)
    extends one where it cannot say something). A format only Corten's own
    server and runtime read (the `data-on` wire format) needs no standard, but stays internal:
    nothing outside the framework may depend on it.

## Limits

What Corten does not do. Some wait on the platform or on an app that needs them, others are so
by design; where it is known, a limit says what would lift it or why it is so.

1. <a id="limit-navigation-api"></a>Client navigation uses the Navigation API (Chrome, Edge, Firefox 147+, Safari 26.2+); older
   browsers do full page loads, and forms, patches and handlers still work.
2. <a id="limit-whole-element-patches"></a>Patches replace whole elements: the server's markup wins, except for what the user is doing.
   A field they edited keeps its value (for the form that was sent, edited after it was sent),
   and focus and the caret move to the matching element (same id; else, inside the nearest
   element with an id, the same name; focus also follows an element without either to the same
   place). A field without an id or a unique name takes the server's value. Other browser
   state inside a replaced element (an open `<details>`, scroll position) resets, so keep
   targets small.
3. <a id="limit-swapped-scripts"></a>`<script>` tags inside swapped pages do not run. Put behavior in a component's script.
4. <a id="limit-document-listeners"></a>Handlers run from one listener per event type on the document, so a third-party listener that
   stops an event before it reaches the document stops its handlers too, as in any delegating
   framework. Markup the runtime inserts (a navigation, a patch) waits for the modules its
   handlers name, so those handlers always run while their event is dispatched. On the first
   page, an event that arrives before its module (a click while the page still loads) gets the
   browser's default and no handler, as it would without JavaScript; the page loads its
   modules as module scripts that hand their exports to the runtime as they run, so their handlers are
   in before `DOMContentLoaded`, and this needs a person faster than the network.
5. <a id="limit-offline-fallback"></a>Offline is a fallback page plus cached versioned files, not offline data.
6. <a id="limit-prefetch-reuse"></a>Hover and touch prefetch reuses a fetched page for up to 10 seconds (cleared after any form
   post). It keeps the 8 newest and aborts the rest (the request, or the body once it answered),
   so hovering does not hold pages for the whole session; with the browser's data saver on it
   fetches nothing. A route that is costly to draw says `prefetch = false`, or names a function
   of the route for the URLs that are (`prefetch = cheap`), and links to those carry
   `data-no-prefetch`.
7. <a id="limit-feed-write-rate"></a>A feed's write rate is bounded by Postgres commit latency on its feed row. Split hot data into
   several feeds.
8. <a id="limit-views-render-once"></a>`html!` views render once and own what they capture; read from `req` before building the view.
   A value borrowed from one the view owns is computed inside the markup:
   `html! { let shown = saved.as_deref().unwrap_or(typed); <input value={shown}> }`.
9. <a id="limit-stylesheet-support"></a>Component stylesheets support plain CSS with nesting and `@media`, `@supports`, `@container`,
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
10. <a id="limit-tested-browsers"></a>`corten-ui` is tested in Chromium, Firefox and WebKit (Playwright's builds). Its popups are placed by the design system's CSS with
   anchor positioning (Baseline since January 2026); a browser without it shows them where
   `popover` puts them by default, centered. Tabs are horizontal.
    Its names in the page are prefixed (`ui.combo_box.js`, `data-scope="ui-combo-box"`) through
    `[package.metadata.corten] scripts = "ui"`, so an app's own components never collide with
    them. Two of an app's own scripts with one file name are a startup error that names both.
11. <a id="limit-caller-types"></a>A route's type says who may use it ([Choice 27](#choice-caller-types)), not which record:
    a check that depends on the record (the author, the organization) stays in its handler, a
    check the compiler does not see. That an area's or an API's routes are under its prefix is
    checked when a routes module that holds the prefix's struct expands, `cargo check` included;
    a route given to `Area::route` or `Api::route` by hand, or by a routes module whose prefix's
    struct is in another module, is checked by a `const` assertion in a generic method, which
    the compiler evaluates only when it generates code: when it builds the app (`cargo build`,
    `cargo test`, `corten check`), not under `cargo check` alone.
12. <a id="limit-fixed-stages"></a>The app's own steps run at one place in Corten's fixed order of stages
    ([Choice 28](#choice-fixed-stages)), not as hooks at several: a step that must see the raw
    request before every stage is a tower layer around the whole app (`.layer(l)`), and there is
    no step for one route, whose needs are its handler's arguments and return type. A route
    takes every stage or, with `unstaged`, none: no same-origin check, deadline, middleware,
    error page, security headers but `nosniff` and `sandbox`, cache rule but `private` on a
    cookie, or allowed origins, which its handler gives itself if it needs them; the host check
    and, under an API's prefix, the API's JSON for a failure stay; it answers reads only; a wrong
    method or a missing suffix at its path is a plain 405 or 404 (the API's JSON under an
    API's prefix), a failure elsewhere is sent as its handler made it (plain text, not Problem
    Details), and a panic is logged and answered 500 (plain, or the API's JSON under its prefix).
13. <a id="limit-protocol-switch"></a>A connection switches protocols (a WebSocket, a relayed tunnel) only over HTTP/1.1 served by
    `corten::serve`; HTTP/2's extended `CONNECT` is not supported. Corten reads the handshake
    and hands over the bytes: frames, message limits, buffering and per-message checks are the
    WebSocket library's and the route's, though `App::send_timeout` still ends a write the client
    makes no room for. The work on a switched connection is told when shutdown begins and is not
    waited for.
14. <a id="limit-http1"></a>Connections are HTTP/1.1. A request's head must arrive within `App::header_timeout` (30
    seconds), which also closes an idle keep-alive connection, and be at most
    `App::max_request_head` (32 KiB, [Choice 19](#choice-head-size)) with at most 100 headers; an answer must make
    progress, a write that finds the send buffer full waiting at most `App::send_timeout` (60
    seconds, nginx's `send_timeout` and its meaning, rather than Kestrel's minimum rate of 240
    bytes a second, which would need a count of bytes and a window in the connection's writer, for
    every connection); a request body read as it arrives (`pieces_up_to`, `Upload`) gives up on a
    client that sends nothing for its idle time (a minute, nginx's `client_body_timeout`) or whose
    waits, in all, pass that idle time plus a second for every 240 bytes that came (Kestrel's
    minimum body rate, the idle time being how far behind it a client may fall), counting only the
    time spent waiting for the client, since one byte resets an idle time alone and a long upload's
    route has a long deadline or none. That reader is Corten's own and already notes when a wait
    begins, so the rate costs it a count and clearing when the client went quiet for each piece,
    and for each piece it waited for a second clock read, a sum and the earlier of two due times; a
    request that reads no body makes no reader, so it pays nothing. Counted with callgrind against
    `fed087d8` (release, 50 and 250 reads, one run each, which callgrind repeats to within 0.1%): a
    piece `Pieces` waited for, one byte each, went from 2,038 to 2,256 instructions (+218, 10.7%);
    an upload of one-byte pieces from 2,027,784 to 2,196,349 (+8.3%) when they came at once and
    from 5,353,909 to 5,888,581 (+10.0%) when it waited for each; a body read whole was unchanged.
    A one-byte piece is the worst case: a piece of a few KiB, as clients send, pays the same
    instructions over far more bytes. It assumes the handler asks for the next piece promptly, as
    a handler that spends a fixed time on each piece lets a client that sends one in that time go
    on unbounded, as Kestrel's does. A body read whole (`bytes_up_to`, `Form`, `Json`) is bounded
    by the route's deadline alone, which a route that removes it keeps for those; how many may be
    open is `App::max_connections`, unbounded unless set. HTTP/2 and HTTP/3 to browsers come from
    a proxy or CDN in front of `corten::serve`. An app with live streams needs one: over HTTP/1.1 a
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
    guide says it. The same proxy serves native apps: `URLSession` too caps HTTP/1.1
    connections to a host (6) and shares one over HTTP/2, while OkHttp's cap counts calls whatever
    the protocol ([Surfaces](architecture.md#native-apps-next-not-built)). HTTP/2 in Corten (hyper's
    `http2`, chosen by ALPN in `serve_wrapped`) was weighed and left out: it adds a second
    answer to each per-connection rule (a concurrent-streams limit beside
    `App::max_connections`, a `GOAWAY` drain at shutdown, `App::header_timeout` per stream, and
    WebSockets over extended `CONNECT`, [Limit 13](#limit-protocol-switch)), which the proxy handles or makes unnecessary,
    and eight crates to the template's build (`h2`, `tokio-util`, `indexmap` and five smaller).
    HTTP/3 (QUIC over UDP with TLS in the process, `quinn` and `h3`, `Alt-Svc` and a TCP
    fallback where UDP is blocked) gains last-mile latency and loss recovery, which an edge near
    the user gives better than an origin. Either reopens for an app that must serve browsers or
    native apps' platform clients with no proxy at all and has live streams; HTTP/3 also waits
    for a stable `h3`.
15. <a id="limit-script-comments"></a>A component script's comments are removed by a scan that knows strings, template literals
    and regular expressions but is not a JavaScript parser. Where only a parser could tell a
    division from a regular expression (a `/` after a statement-level `}`, after `++` or `--`, or
    starting a line after a value, as after `continue` or `let t`), the script is served as
    written, comments included: correct, only larger. None of the repo's scripts is; of 1,230
    third-party files with comments, 161 (mostly minified bundles) were.
16. <a id="limit-json-numbers"></a>JSON numbers have one form, serde_json's, in responses, feeds and agent output: a whole float
    keeps its fraction (`2.0`), where JavaScript's `JSON.stringify` writes `2`. There is no switch
    to JavaScript's form: a second form would split the surfaces and still not give canonical bytes.
    Text that must match another service's is the app's own (`Raw`, or serde_json's `RawValue`
    where `Serialize` writes it), and a shared checksum is over RFC 8785 (the app guide, Numbers in
    JSON).
17. <a id="limit-empty-file-input"></a>A file input left empty is no file to `Upload`: the browser sends a part with an empty file
    name and no bytes, which `FormData` keeps as an empty `File` and `next_file` passes over. A
    route cannot tell that input from one the form lacks. Handing out empty files would make every
    handler that loops over files skip them to get the same answer, and a file the user did choose
    is never both nameless and empty, so the distinction is left out. A part with bytes is a file
    whatever its name.
18. <a id="limit-handler-props"></a>A handler passed to a component as a prop (`on:sort={..}` on the kit's `SortHeader`) is typed
    by the prop, not by the element the component puts it on: its `event` is an `Event` and its
    `target` an `HTMLElement`, so its script narrows (`event instanceof MouseEvent`) where an
    `on:click` written on an `<a>` declares `MouseEvent` and `HTMLAnchorElement`. Typing a prop by
    the event and element it lands on would make each prop name its element's type, and the
    arguments the call passes (a column, as a Rust type) are checked either way.
19. <a id="limit-permissions-policy"></a>The `Permissions-Policy` a document is sent (`Feature`) is enforced by Chromium-based browsers
    (measured in Chromium 156: with the location granted, `geolocation=()` refuses it). Firefox 157
    and WebKit 27.2 gave the location under the same header (probed), so in them the features it
    denies are the browser's to grant, as before. Chromium on Linux, without Web Bluetooth, logs one
    warning a page load for the `bluetooth` name.
20. <a id="limit-shared-caches"></a>A shared cache in front of the app must key on `Vary` (RFC 9111). One URL answers a page's
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
21. <a id="limit-etag"></a>The `ETag` of a page route's answer is a 64-bit hash of its body, its `Content-Type` and its
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
22. <a id="limit-multipart-overread"></a>A multipart body is read up to 64 MiB past its limit, what a file the handler passes over
    included, so the browser is answered with the form's message rather than a reset connection.
    Each such request holds its connection and searches what it reads for the next boundary, which
    the client chose along with the bytes. The search is `memchr`'s substring search, already in
    axum's tree: linear, as a byte-by-byte search is, but 4.5 times as fast on plain bytes, 35 times
    on `\r`, 23 times on `\r\n` and 2.3 times on the delimiter less its last byte, repeated (the
    search alone over 60 MiB, release, medians of 7, in 16 KiB pieces). The client picks the pieces
    too, and a piece has a cost of its own, kept small: what is held of a piece is joined to the
    next, a piece under 1 KiB in room that is reused, and a part's headers are searched once, so
    1 MiB of `\r` sent a byte at a time takes 846.6M instructions and 250 heads of 8,000 bytes
    1,972.7M, where the reader this one replaced took 1,221.6M and 42,531M (callgrind, release, the
    counts taking in the benchmark's making of each body). So a request that keeps sending is
    bounded by its size (its limit plus 64 MiB), not by a time, unless it falls its idle time behind
    240 bytes a second ([Limit 14](#limit-http1)); one that stops for `Upload::idle` (a minute
    unless set) is let go, and `App::max_connections`, when set, bounds how many are read
    at once. A file read with `bytes_up_to` keeps its pieces of 1 KiB or more as they came (slices
    of buffers already held) and copies runs of smaller ones into one buffer, so a file sent a few
    bytes at a time holds about its size: 8 MiB kept in 1-byte pieces peaked at 21.7 MiB,
    against 277.7 MiB in the reader it replaced. A file under 64 KiB that came in one piece is
    copied out of it, since the piece can be a slice of a read buffer of hundreds of KiB that
    keeping it would hold. The end-to-end times, the other counts and peak memory are in
    [#897 Upload: a file passed over does not count toward the limit; the reader's cost no longer depends on how the body is cut](https://github.com/corten-run/corten/pull/897).
23. <a id="limit-csp-reports"></a>CSP reports (`Policy::report_to`) reach the app from Firefox and WebKit, in two shapes:
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
