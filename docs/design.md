# Design decisions and limits

[Back to the README](../README.md)

The [values](../README.md#values) decide what goes in. This file records how they turned into the
framework's shape, and what it does not do yet.

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
with them, and a Limit is what Corten does not do yet, where it says what would lift it.

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

   Stands on: measured (the README's browser table, median of 10 cold loads each: Leptos's item page
   loads 304 KB of WASM and is interactive on a phone in 1,929 ms, Corten's in 474 ms); reasoned
   (the server already sends the HTML, so the browser needs only the behavior).

   Revisit when: a page's behavior compiled to WASM loads in fewer bytes and is interactive sooner
   than the same behavior in JavaScript, measured as the browser table measures, without hydrating
   what the server drew.

   Last checked: 2026-11-05, round r15 in Chromium 148, on `ec10c8f`.

3. <a id="choice-no-server-vdom"></a>**No virtual DOM on the server.** Frameworks that build a view tree per request and then
   serialize it pay for it in throughput (Leptos in the
   [README benchmark](../README.md#performance)). `html!` writes straight to the
   response buffer.

   Stands on: measured, of whole frameworks only (the README benchmark, one run: 300 pages a second
   take 6.2% of a core in Corten and 26% in Leptos, which differs from Corten in more than its view
   tree); reasoned (a tree built and then serialized is work a direct write does not do).

   Revisit when: a view tree measured alone (callgrind on the item page) costs within noise of
   direct writes, or a feature needs the tree on the server, such as computing patches by diffing
   two renders.

   Last checked: 2026-11-05, round r15, on `ec10c8f`.

4. <a id="choice-plain-functions"></a>**Plain functions, not a client framework, by default.** A handler is an exported function the
   markup calls with the elements it uses, run by one delegated listener per event type; there
   is no component instance, lifecycle class or hydration in the browser. Rows a script changes
   often are views: generated classes that read and write the server-rendered elements.
   One replaceable branch can use `view(host, View, template)`: a DOM operation beside `rows`,
   not another component model. Its server-rendered root id identifies the branch; existing
   `keep`, typed events and `signal` still own state, communication and cleanup.

   Stands on: measured (the README's client-heavy table, round browser-3, older than today's
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

   Stands on: bet (the JSDoc types the compiler reads cover what handlers take; a union of strings
   is already any JSON value to it, which the scripts guide works around with a handler per value);
   reasoned (with the check at the call, no declarations sit between markup and script to go stale);
   value (a wrong call fails to compile, Values 4).

   Revisit when: an example or a kit component has to take a type the compiler reads loosely,
   because the guide's workaround does not fit, so a wrong call compiles; or JavaScript gains type
   syntax of its own (TC39's type annotations proposal), which a script could carry in place of
   JSDoc.

   Last checked: 2026-10-27, a union of strings typed as any JSON value, found at `2893a72d`, and
   not checked since.

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
   part sent later to be worth its costs); measured (a whole item page request takes 66 µs of CPU in
   the README benchmark, one run); reasoned (the status and headers go before a streamed part
   exists, so its failure cannot become an error page or a redirect); value (a page works without a
   script, Values 3, where a part placed out of order would land at the end of the page).

   Revisit when: browsers place a part streamed out of order with HTML alone, no script; or an app
   measures a first paint that streaming would bring forward by more than a `<corten-live>` part
   does.

   Last checked: 2026-11-05, round r15, on `ec10c8f`.

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
   rows fast to change ([README](../README.md#client-heavy-screens)). Rust renders on the server
   because it is the fastest renderer there, and plain JavaScript runs in the browser because no
   framework or WASM layer is faster than the platform's own DOM calls. The scripts guide has the
   table for choosing ([Server or browser](guide/scripts.md#server-or-browser)).

   Stands on: measured (views take over 1,000 server-rendered rows in 6.0 ms, the README's
   client-heavy table, median of 30 loads, round browser-3, older than today's runtime); value
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
   browser without JavaScript needs. The mode would move to a standard header that says "part of
   a page" and that a script may set.

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
   move to `Location` once `fetch` can read a redirect's target without following it. The runtime
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

21. <a id="choice-own-extractors"></a>**An app's own extractor implements axum's `FromRequestParts`, named `corten::extract`, not a
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
   That would wait on Corten owning the handler traits, which [Choice 25](#choice-axum-router) declines for now; if
   Corten ever owns them, they should keep these names, the `Rejection` that makes a response and the
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

   Stands on: platform (handlers are axum's `Handler`, and Rust's orphan rule forbids bridging a
   trait of Corten's to axum's); value (a second trait beside axum's for each type would be a second
   concept, Values 6).

   Revisit when: Corten owns extraction and dispatch (`FromRequestParts` and the `Handler` impls
   that call a handler, not only the `RouteHandler` bound it owns now), which [Choice 25](#choice-axum-router) declines for
   now and says what would reopen it: the orphan rule then no longer stands between them, and these
   names stay as Corten's own. An axum release that changes `FromRequestParts` reaches apps'
   extractors with the Corten release that moves to it, a cost this Choice accepts, and is
   [Choice 25](#choice-axum-router)'s first condition.

   Last checked: 2026-11-06, axum 0.8.9 (`axum-core` 0.5.6) and rustc 1.99.1, at `62eb57f7`.

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

25. <a id="choice-axum-router"></a>**Matching a path to its route, calling the handler and framing server-sent events stay
   axum's; the handler bound and axum's features are Corten's.** Corten owns the layer around
   them: the accept loop and connection limits, its middleware stages, typed routes and
   `Params`, the readers (`Form`, `Json`, `Upload`), `Upgrade`, and the checks every route
   passes. What stays axum's is `Router`, `MethodRouter` and matchit, axum's `Handler` impls
   that read each argument and call the function, and `Sse`.

    Owning them was weighed against correctness first (the order in the README's Values): a router
    of Corten's would write again what axum's tests already hold it to, `HEAD`, `405` with
    `Allow`, percent-decoding, nesting and fallbacks, about 4,600 lines of axum 0.8.9's routing,
    method routing, handler, boxing, matched-path and nested-path modules without their tests, and
    that risk outranks the speed it could buy. The speed is small: from memory, functions named
    for axum, tower or matchit are 1.7% of the item page's user instructions and their code
    inside Corten's is 0.7% more, 2.5% in all, 3.6% counting all of `http::Extensions`, where
    axum puts the matched path and parameters; on the item's JSON the same rows are 3.8% and
    about 5%, and on the item-API page 0.2% (bench/fullstack, split by crate). A router of
    Corten's would still match paths and hand over parameters, so it would save less than that.
    No prototype router was measured: allocations and copies axum causes are counted in other
    rows, so these shares are not a ceiling, but a gain of their size would not outweigh the risk
    above, and only a measured share well past it would (below).
    Clashes between the routes of one module need no dispatch of Corten's either:
    `#[corten::routes]` sees every path in its module, and clashes across areas and APIs stay a
    startup check.

    Server-sent events stay axum's for the same reason on a smaller scale: `text/event-stream` is
    a standard format (multi-line data, comments, retry and keep-alive), axum's encoder writes it,
    and an encoder of Corten's would be a second copy of it with nothing measured to gain.

    Two things were Corten's to take without owning dispatch, and it took them:
    1. **The handler bound.** `#[corten::routes]` names each handler through Corten's
       `RouteHandler`, whose message is Corten's (`.. cannot serve this route`). It was one impl
       over every axum `Handler`, so a handler argument no request can fill reported axum's
       unmet `Handler<_, ()>`, with a hint to use `#[axum::debug_handler]`, at the handler's name,
       and named no argument; `#[diagnostic::do_not_recommend]` on that impl and moving the bound
       to the trait did not change that. It is now one impl per arity with axum's own bounds
       written out (`FromRequestParts` for each argument, `FromRequest` for the last,
       `IntoResponse` for the result), so the same handler fails Corten's trait, in its words, and
       a second error names the argument (`Name: FromRequestParts<()>` is not satisfied). The
       handler is still the same function with axum's `Handler` impl, so nothing on the request
       path changes (`tests/handler_message.rs` builds such an app and reads both messages).
    2. **axum's features.** Corten turns on only `http1`, `tokio` (its `serve_on` loop on
       axum's `Listener`, `ConnectInfo`) and `matched-path`, and `json` with Corten's own
       `json` (`corten::Json` shares `axum::Json`'s rejection); corten-feed asks for none, so an
       app with a feed gets the same set. `original-uri` copied every request's URI into its
       extensions for nothing to read (about 150 of card-market's item page's 83,400
       instructions at fa597483), and `form`, `query`, `tracing` and `tower-log` serve readers
       Corten has its own of; without them `log`, `ryu` and `serde_urlencoded` leave the tree.
       matchit, mime, sync_wrapper and tower are still in it only for axum, and
       serde_path_to_error with `json`.

    What staying costs: an axum major version that changes `Handler`, `FromRequestParts` or
    `IntoResponse` changes the bounds above and an app's own extractors ([Choice 21](#choice-own-extractors)) with the
    Corten release that moves to it, and the second error's note is still axum's ("not a valid
    axum extractor"). This changes if an axum release changes those traits in a way apps see, if
    axum's share of the item page from memory grows past about 5% (functions named for axum,
    tower or matchit and their code inside Corten's, 2.5% now; the JSON's 3.8%), or if owning dispatch would catch a
    mistake that now compiles
    ([#761 Corten wraps most of axum but still depends on its router, handler traits and SSE, which tie its public API and diagnostics to axum's](https://github.com/corten-run/corten/issues/761)).

    Stands on: bet (axum keeps `Handler`, `FromRequestParts` and `IntoResponse` as apps see them
    across the releases Corten moves to); measured, one pair of runs, a floor and no prototype
    (callgrind on card-market's item page from memory, split by crate on main `b79a6b23`: functions
    named for axum, tower or matchit are 1.7% of its user instructions, 2.5% with their code inside
    Corten's, and the item's JSON 3.8% by the same measure; allocations and copies axum causes are
    counted in other rows); measured, three runs each, at the function level only (on `fa597483`,
    the functions that copy, insert and drop a request's URI ran 339 instructions a request without
    `original-uri` against 492 with it, 153 fewer, about 0.2% of the item page's 83,400; the whole
    request's count does not resolve it, with runs differing by up to 450); platform (rustc names
    the argument no request can fill for one impl per arity with axum's bounds written out, where
    one impl over every axum `Handler`, with `#[diagnostic::do_not_recommend]` or the bound moved to
    the trait, did not; `crates/corten/tests/handler_message.rs` checks that today's error names the
    route in Corten's words and names the argument); platform (`text/event-stream` is a standard
    format axum's encoder already writes); reasoned (a router of Corten's would write again what
    axum's tests hold it to, `HEAD`, `405` with `Allow`, percent-decoding, nesting and fallbacks,
    and `#[corten::routes]` sees every path in its module, so route clashes need no dispatch of
    Corten's); value (correctness before speed, the order the README's Values give).

    Revisit when: an axum release changes `Handler`, `FromRequestParts` or `IntoResponse` in a way
    apps see; axum's share of the item page from memory grows past about 5% (functions named for
    axum, tower or matchit and their code inside Corten's: 2.5% now, the JSON's 3.8%); or owning
    dispatch would catch a mistake that now compiles.

    Last checked: 2026-11-05, the split by crate on `b79a6b23`, recorded at `0154ac63`, and axum's
    own share at `15e81290`; 2026-11-06, the `original-uri` runs on `fa597483`; 2026-11-06, rustc
    1.99.1's error for an argument no request fills, held by
    `crates/corten/tests/handler_message.rs` at `84d33d0b`; 2026-11-06, axum 0.8.9's event stream
    encoder at `62eb57f7`.

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
11. <a id="limit-caller-types"></a>Who may use a route is in its handler's type: it takes `Caller<T>`, whose `Identify` finds
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
12. <a id="limit-fixed-stages"></a>A request goes through fixed stages in one order (`corten::middleware`); the app's own
    steps are a `Middleware` tuple at one place in it, resolved at compile time, not hooks at
    several. An area's or an API's own steps (`Area::middleware`, `Api::middleware`) run right
    after the app's, for the requests at its prefix; they are boxed, since which run depends on
    the path, and an app with none pays nothing for them.
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
    WebSockets over extended `CONNECT`, [Limit 13](#limit-protocol-switch)), which the proxy handles or makes unnecessary,
    and eight crates to the template's build (`h2`, `tokio-util`, `indexmap` and five smaller).
    HTTP/3 (QUIC over UDP with TLS in the process, `quinn` and `h3`, `Alt-Svc` and a TCP
    fallback where UDP is blocked) gains last-mile latency and loss recovery, which an edge near
    the user gives better than an origin. Either reopens for an app that must serve browsers with
    no proxy at all and has live streams; HTTP/3 also waits for a stable `h3`.
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
17. <a id="limit-event-stream-unchecked"></a>An event stream's (`corten::event_stream`) event names and data are not checked against the
    script that reads them, as a feed's rows are (`rows = Row`, `FeedUrl<Row>`): the script
    listens by a name it writes and parses the data untyped. Prefer `<corten-live>` or a feed
    where either fits. Typing them is left out until an app needs it: nothing but corten's own tests
    and docs uses event streams, and the typing would add a route attribute, a declaration kind and runtime
    code every page loads. An app that needs it starts from `#[event]`, whose names are checked
    and whose shapes `corten/events` declares, rather than a second event model
    ([#591 An event stream's names and data are strings the script reads untyped, where a feed's rows are checked from the route to the script](https://github.com/corten-run/corten/issues/591), closed as not planned).
18. <a id="limit-empty-file-input"></a>A file input left empty is no file to `Upload`: the browser sends a part with an empty file
    name and no bytes, which `FormData` keeps as an empty `File` and `next_file` passes over. A
    route cannot tell that input from one the form lacks. Handing out empty files would make every
    handler that loops over files skip them to get the same answer, and a file the user did choose
    is never both nameless and empty, so the distinction is left out. A part with bytes is a file
    whatever its name.
19. <a id="limit-handler-props"></a>A handler passed to a component as a prop (`on:sort={..}` on the kit's `SortHeader`) is typed
    by the prop, not by the element the component puts it on: its `event` is an `Event` and its
    `target` an `HTMLElement`, so its script narrows (`event instanceof MouseEvent`) where an
    `on:click` written on an `<a>` declares `MouseEvent` and `HTMLAnchorElement`. Typing a prop by
    the event and element it lands on would make each prop name its element's type, and the
    arguments the call passes (a column, as a Rust type) are checked either way.
20. <a id="limit-permissions-policy"></a>The `Permissions-Policy` a document is sent (`Feature`) is enforced by Chromium-based browsers
    (measured in Chromium 156: with the location granted, `geolocation=()` refuses it). Firefox 157
    and WebKit 27.2 gave the location under the same header (probed), so in them the features it
    denies are the browser's to grant, as before. Chromium on Linux, without Web Bluetooth, logs one
    warning a page load for the `bluetooth` name.
21. <a id="limit-shared-caches"></a>A shared cache in front of the app must key on `Vary` (RFC 9111). One URL answers a page's
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
22. <a id="limit-etag"></a>The `ETag` of a page route's answer is a 64-bit hash of its body, its `Content-Type` and its
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
23. <a id="limit-multipart-overread"></a>A multipart body is read up to 64 MiB past its limit, what a file the handler passes over
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
    counts taking in the benchmark's making of each body). So a request is bounded by its size (its
    limit plus 64 MiB), not by a time, and `App::max_connections`, when set, bounds how many are
    read at once. A file read with `bytes_up_to` keeps its pieces of 1 KiB or more as they came
    (slices of buffers already held) and copies runs of smaller ones into one buffer, so a file sent
    a few bytes at a time holds about its size: 8 MiB kept in 1-byte pieces peaked at 21.7 MiB,
    against 277.7 MiB in the reader it replaced. A file under 64 KiB that came in one piece is
    copied out of it, since the piece can be a slice of a read buffer of hundreds of KiB that
    keeping it would hold. The end-to-end times, the other counts and peak memory are in
    [#897 Upload: a file passed over does not count toward the limit; the reader's cost no longer depends on how the body is cut](https://github.com/corten-run/corten/pull/897).
24. <a id="limit-csp-reports"></a>CSP reports (`Policy::report_to`) reach the app from Firefox and WebKit, in two shapes:
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
