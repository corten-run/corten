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
commit or versions, and Choices out of order (`scripts/choices.mjs`). A commit is cited in
backticks, another repository's as GitHub writes it (`owner/repo@sha`), and one of Corten's alone,
on GitHub: on `main`'s history, or, when no branch keeps it, under `refs/tags/evidence/<name>`
(usually its short name); `npm run check` fails on one that is on neither
(`scripts/design-refs.mjs`).

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

   Stands on: measured (the client-heavy table in performance.md, round browser-4, the median of 30
   loads: views take over 1,000 server-rendered rows in 10.2 ms, Solid, Svelte, Vue, React and
   Remix in 16.2 to 131 ms; Solid, the nearest, takes 1.6 times as long, against 3.3 times in
   round browser-3, 19.6 ms against 6.0 on another CPU, Chromium and runtime. Each is one round of
   a number that has moved between runs: browser-2 measured 29.5 ms for views and three reruns of
   that step 4.9, 20.7 and 6.3 ms. In browser-4 about half the loads had a long frame of
   rendering before views were ready, which takeover leaves out (a median of none in browser-3), and
   the page, though ready sooner than in browser-3 as every app's was, was ready after Svelte's and
   Vue's, where in browser-3 it was the first framework ready. Part of that rise was the runtime's
   own evaluation at load, measured on one Intel Core i9-10885H laptop with browser-4's Chromium
   (156.0.8078.4), `bench/browser/ssr.mjs` and performance marks in copies of the page: taking
   turns with `77002fe`, the round's commit took over 4.24 ms slower (standard deviation 1.03) in
   8 pairs of 30 loads and 2.96 ms slower (0.62) in 4 more, Solid -0.19 and -0.20 ms, and its
   evaluation, the median of the loads with no long frame, was 9.4 ms against 5.9 (+3.5 ms, no
   spread recorded), spent in four startup steps that did work nothing used or did it the slow way
   (reading every `data-ref`'s name, a `details, dialog` query over the whole page, the layout
   snapshot's regular expressions, and looking for missing meta tags through the whole page). The
   round's median load had a long frame, on which takeover reads about 9 ms higher, so part of 6.0
   to 10.2 ms is probably that.
   [#1246 Runtime: cut startup work on a long page (#1222)](https://github.com/corten-run/corten/pull/1246) cut that evaluation: in another session on the same laptop and Chromium, against a base
   (`8c2a1b71`) with the round's runtime, evaluation fell 4.14 ms (standard deviation 0.16; base
   10.15 ms, 9.90 to 10.70, against 6.00, 5.90 to 6.40, medians of 6 runs of 30 loads each), and
   the takeover of the loads with no long frame 3.91 ms (standard deviation 2.40) over 8 pairs of
   30 loads, with Solid, the control, at -0.31 ms (standard deviation 0.85). The two sessions
   measured the same runtime at 9.4 and 10.15 ms, so their differences compare (+3.5 ms, then
   -4.14), not their levels. The round's 10.2 ms is the number until the next browser round
   measures takeover again
   ([#1222 Taking over 1,000 server-rendered rows rose from 6.0 to 10.2 ms in round browser-4 while Solid's, Svelte's, Vue's and React's fell](https://github.com/corten-run/corten/issues/1222)));
   reasoned (nested branches need the same typed-template check and CSP custom-property
   application as rows; centralizing those does not require tracking application state); value
   (one way to give an element behavior, Values 5).

   Revisit when: a client framework takes over server-rendered rows as fast as views in the
   client-heavy table, with no hydration (not met in browser-4, one round: the nearest, Solid,
   hydrates and takes 16.2 ms against 10.2, though it already creates rows faster); or apps'
   handlers keep repeating state that crosses components, which a framework would hold once. The
   nested deck preview exercises that boundary: draft data stays in its owner, while `view` owns
   only adoption and cloning. Revisit that split if more screens need another state/lifecycle
   mechanism, or if its root-id identity cannot express their branches.

   Last checked: 2026-11-11, the client-heavy table, round browser-4 on a Xeon Platinum 8358, on
   `3fb4b1ac`; 2026-10-23, round browser-3 on a Xeon Platinum 8280, on `77002fe`; 2026-10-23,
   browser-2 and its three reruns, recorded in the browser benchmark's README at `0cda9827`;
   2026-11-11, an A/B of `3fb4b1ac` against `77002fe` with `bench/browser/ssr.mjs` on an Intel
   Core i9-10885H laptop, Chromium 156.0.8078.4; 2026-11-11, paired runs of `8c2a1b71` against
   `8c9e84fd` (the startup change), the same laptop and Chromium; 2026-11-06, nested deck preview
   and connected-tree measurements on `fc09b98d`.

5. <a id="choice-handlers-checked-where-called"></a>**Handlers are checked where they are called.** The compiler reads each script's JSDoc, so a
   call with a ref on the wrong element, an event of the wrong type, a value of the wrong type or
   a handler the script does not export fails to compile at the call. No generated declarations
   are needed between markup and script, and none can be stale. Scripts are JavaScript with JSDoc,
   not TypeScript source: `tsc` checks both, and the call check, the generated declarations and
   data read at run time are the same either way. The macro already reads TypeScript's type syntax
   inside JSDoc, so the call check would carry over; what TypeScript source adds is a step before
   serving: full TypeScript needs code emitted for `enum`, namespaces and parameter properties, so
   a build step; erasable-only TypeScript (TypeScript 5.8's `erasableSyntaxOnly`) needs a pass that
   blanks its type syntax (annotations, `as`, `satisfies`, `!`, type parameters and arguments,
   `interface`, `type`, modifiers, overloads, type-only imports and more) and keeps up with each
   TypeScript release. Moving every script to TypeScript would still leave one format, so the
   choice rests on that step, which JavaScript does not need, against the few checks below, each of
   which JavaScript can be written to get too (a JSDoc type, a rest parameter; a class's only by
   restating its fields). Stricter checks of a body are `tsc` options, which hold for JavaScript as
   for TypeScript
   ([#1038 Evaluate script safety checks beyond strict, including indexed access and exact optional properties](https://github.com/corten-run/corten/issues/1038)),
   and data read at run time is unchecked in either
   ([#1039 Audit runtime data boundaries and unsafe any escapes behind Corten's script type-safety guarantees](https://github.com/corten-run/corten/issues/1039)).

   Stands on: bet (the JSDoc types the compiler reads cover what handlers take: elements and their
   lists, maps and views (`Holds`), events, `AbortSignal`, strings and lists of them, numbers,
   booleans, element ids, routes and feed URLs, messages, formats, groups (a `@typedef` of these,
   one object argument), and any value of a Rust type through its generated declaration; a type
   it cannot check a call against, a set of names written as string literals, any other JSON
   shape or an element or event in another shape, refuses the call rather than taking anything,
   and only `unknown` takes any argument but a form field (which needs the control's type to know
   what to find, [Choice 57](#choice-field-arguments)), since it claims nothing the call does not
   check);
   platform (apps require TypeScript 6.0 or later for the runtime's Navigation API DOM types;
   TypeScript 7.0.2 is pinned for framework CI to match npm's newest stable release installed by
   the getting-started guide. It checks JSDoc types as it checks annotations, except where
   JavaScript infers a type, in the cases probed so far: a property first given after an empty
   object literal, which a JSDoc type on the object catches; a value whose type nothing fixes (an
   untyped `new Promise` or `new Set()`, a type parameter no argument decides), `any` in JavaScript
   and `unknown` in TypeScript, which a JSDoc type fixes; a function called with `new` that sets
   `this`'s properties, and extra arguments to a function reading `arguments`: 6.x accepts these
   in JavaScript and 7.0.2 refuses them (a class and a rest parameter fix them); and a property
   a class's constructor or method sets first, which JavaScript takes as declared even when the
   class declares its fields, so a misspelled write is
   flagged only when `this` is retyped to a typedef that repeats the fields (`@this` on a method, a
   cast in the constructor), and a read of the misspelled name only when a method other than the
   constructor set it and `undefined` is not accepted; TypeScript 5.8 added `erasableSyntaxOnly`.
   TypeScript 7.0.2 exports no stable parsing entry point: its root exports only `version` and
   `versionMajorMinor`, and its parser and AST entry points are all under `typescript/unstable/`.
   The repository's AST checks import `typescript/unstable/sync`, `typescript/unstable/fs` and
   `typescript/unstable/ast`, with the root dependency pinned exactly to `7.0.2` in `package.json`
   and the lockfile, not a compatible-version range, and `corten check` in a checkout finds it
   as `node_modules/.bin/tsc`, as it finds an app's. The benchmark harness's consumers of the
   classic compiler API (`createSourceFile`, `forEachChild`, `transpileModule`) in
   `bench/fullstack-browser` and `bench/workloads` have their own package, `bench/package.json`,
   pinned exactly to TypeScript 6.0.3, the newest release with that API);
   reasoned (with the check at the call, no declarations sit between markup and script to go stale;
   component behavior is exported functions, not classes; the runtime's one hand-written class,
   `<corten-live>`, sets only the fields it declares, and the classes it generates, one per view
   (the macro writes them) and one per typed event (`assets.rs` writes them), are typed by the
   declarations written beside them; each of the runtime's untyped `new Promise`s and `new Set()`s
   was read, and none's value is used as a type it is not; the unstable parser API lets
   `scripts/escapes.mjs` inspect JSDoc and `scripts/events.mjs` compare the compiler's DOM event
   maps with `crates/corten-macros/src/dom.rs` without a separate parser dependency.
   The benchmark package's own install keeps the harness's classic API without holding Corten's
   checks or the CLI's compiler lookup to an older compiler. The exact pin and negative parser
   fixtures bound this dependency, but do not make the API stable); measured (deck-builder's and
   seller-desk's largest scripts and three small handlers, converted to TypeScript, surfaced no
   bug; esbuild 0.28.2's output (`--format=esm`), which stands in for either language since Corten
   serves esbuild's output for neither, with whitespace and comments removed was the same bytes,
   17,424 and 4,358, and its plain output differed by comments and the parentheses a JSDoc cast
   needs, 22,498 against 22,046 for deck-builder; `tsc` on the repository took, on TypeScript
   5.9.3, 6.6 to 7.3 s with them as JavaScript and 7.6 to 8.7 s as TypeScript, three runs each, not
   alternated, on a loaded machine, so no difference in time is claimed; no empty object literal
   given properties later and no function called with `new` is in the repository's scripts, and
   none reads `arguments`); value (a wrong call fails to compile, Values 4; one authoring format,
   Values 5, which keeping JavaScript holds without a migration; no build step and no
   syntax-removal pass in a macro that depends on nothing, Values 6).

   Revisit when: an example or a kit component has to take `unknown` where a precise type would
   serve it, because no checked type or generated declaration fits, so a wrong call compiles; or
   JavaScript gains type syntax of its own (TC39's type annotations proposal), which a script
   could carry in place of JSDoc; or a script needs a check `checkJs` cannot give with a JSDoc type
   (an object built up a property at a time that cannot be written as a literal or a typed value);
   or a component or the runtime has a hand-written class, or a function called with `new`, that
   sets properties it does not declare, or a function that reads `arguments`; or TypeScript stops
   reading a JSDoc form the scripts use (7.0 dropped several, among them `@enum`, `@class`, Closure
   function types, a bare `?` or postfix `!`, and a value written where a type belongs, none of
   which they use); or a TypeScript release changes what the probes behind the measured premise
   show; or TypeScript ships a stable parsing API for these AST checks; or a TypeScript 7.x
   update changes the unstable sync, filesystem or AST APIs they use; or benchmark tooling moves
   off the classic compiler API, so `bench/package.json` can be removed; or a TypeScript release
   newer than 6.0.3 still ships that API, for the benchmark package to move to; or the
   `@typescript/typescript-<platform>-<arch>/lib/lib.dom.d.ts` package layout that
   `scripts/events.mjs` resolves through the root compiler changes; or the runtime or kit
   needs a DOM type unavailable at the TypeScript 6.0 minimum (CI checks both 6.0.3 and 7.0.2),
   or TypeScript changes the checked-JavaScript inference differences at that minimum.

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
   ([#1072 A formdata handler cannot take its FormDataEvent: the event map types formdata as Event, so since the handler check a lib.dom-typed handler does not compile](https://github.com/corten-run/corten/issues/1072));
   2026-11-10, JSDoc against TypeScript source at `c480d006` with TypeScript 5.9.3: deck-builder's
   and seller-desk's largest scripts converted by TypeScript's own JSDoc-to-annotation fix (148
   and 44 edits, two syntax fixes by hand, 0 errors), and the JSDoc in the 33 component, example
   and template scripts listed (492 `@param`, 84 `@type`, 24 `@typedef`, about 40 casts, 16
   `@import`), and all 62 scripts `jsconfig.json` checks besides its test fixture, the runtime's
   included, compiled as TypeScript to find a property first given by assigning it (none: the three
   such errors were types JSDoc gave that the copy lost), the template's and two kit handlers
   converted by hand (0 errors), esbuild 0.28.2 run on the converted pair, `tsc` timed three times
   on each, TypeScript 5.8's release notes read for `erasableSyntaxOnly` and 7.0's for JSDoc, and
   TypeScript 7.0.2 run on the repository's `jsconfig.json` (0 errors) and on the same probes
   (the same results as 5.9.3, but for a function called with `new` and a call with more arguments
   than a function reading `arguments` declares, which 7.0.2 refuses), and the repository's scripts
   searched for each, the first through the TypeScript copy (no TS2683 or TS7009), the second with
   `rg` for `arguments` (only in comments)
   ([#1040 Reassess JSDoc versus TypeScript for component scripts using measured safety and authoring tradeoffs](https://github.com/corten-run/corten/issues/1040));
   2026-11-14, TypeScript 7.0.2 on `4cbc5e627` and the change: `tsc -p jsconfig.json`, including
   every `@ts-expect-error` in `scripts/typecheck-fixture.js`, passes. Moving the compiler reopens
   the compiler premise, not the authoring format: the known inference limits above remain
   reasons for precise JSDoc, not a serving-time syntax pass. Three sequential wall-time
   runs on the same workstation: 5.9.3 took 4.532, 3.697 and 4.178 s, and 7.0.2 took 1.389, 1.064
   and 0.962 s (medians 4.178 and 1.064 s, not alternated, not a controlled performance claim).
   The event-map check now reads 7.0.2's own DOM library through its native AST API. `input`
   remains `Event` because a select or checkbox fires a plain event, unlike a text edit's
   `InputEvent`. The old JavaScript parser API is gone, so the event and unsafe-escape checks
   use the native API too, with their existing negative fixtures retained.
   The [HTML checkbox activation steps](https://html.spec.whatwg.org/multipage/input.html#checkbox-state-(type=checkbox))
   were read for the plain `input` event (no interface override);
   2026-11-14, TypeScript 7.0.2's installed `package.json` export map, `lib/version.cjs` and
   root module exports inspected at `e8d4165cd`: only version information is stable, and all
   parsing entry points are explicitly unstable. The exact pin is retained. The AST checks
   and their negative parser fixtures are exercised by the root `npm run check`;
   2026-11-14, at `face427ab` and the change: browser evidence's classic-API failure reproduced
   in `binding-effects.test.mjs`. Root `typescript` 5.9.3 restored solely for those benchmark
   consumers, with 7.0.2 under `typescript7` explicitly selected by Corten's CLI, root compiler
   and AST checks. This corrects the earlier assumption that app-local pins covered all bench
   consumers: the evidence harness also imports the root compiler;
   2026-11-14, reopened at `727130519` and the change: apps require TypeScript 6.0 or later
   (5.9.3 lacks the Navigation API declarations), the CLI rejects older versions explicitly,
   and its alias lookup is confined to the checkout supplying `crates/corten/js`, never a
   registry dependency or arbitrary ancestor. The escape scan parses all files in one native
   session rather than starting a process per file. Three sequential wall-time runs of
   `node scripts/escapes.mjs` before batching: 9.392, 8.134, 8.427 s, after: 2.431, 2.337,
   2.255 s (medians 8.427 and 2.337 s on the same workstation, not controlled for load);
   2026-11-14, at `630ceb703` and the change: external TypeScript 6.0.3 and pinned 7.0.2
   run on `jsconfig.json`, including the runtime and kit (both pass). CI now installs 6.0.3
   outside the repository and runs that same config, so the minimum is continuously checked.
   The constructor-function and extra-arguments JavaScript probes were run with both:
   6.0.3 accepts them, while 7.0.2 reports TS2683, TS7009 and TS2554.
   The minimum comparison uses semantic-version precedence: 6.0.0 prereleases are below
   stable 6.0.0, while 6.0.1 and 7.0.0 prereleases are above it. The CLI's version-boundary
   regression was reproduced with 6.0.0-dev.20250801 and the boundary cases checked at
   `f46913f75` and the change;
   2026-11-20, at `cdd1525e0` and the measured head `60f89ec39`: the harness's classic API
   consumers moved to `bench/package.json`, pinned exactly to TypeScript 6.0.3 (npm's newest
   6.x, whose `lib/typescript.d.ts` declares `createSourceFile`, `forEachChild` and
   `transpileModule`), installed by `npm --prefix bench ci`, and the root `typescript` became
   7.0.2, npm's `latest` that day, so the checkout's compiler alias and the CLI's lookup for it
   were removed. Node's resolver gave 6.0.3 for `typescript` from the harness importers checked,
   `bindings.mjs`, `binding-artifact.mjs`, `binding-effects.mjs`, `binding-links.mjs`,
   `binding-modules.mjs`, `scopes.mjs` and four tests in `bench/fullstack-browser`, and 7.0.2
   from `scripts/`. Apps under `bench/fullstack/apps` were not checked and keep their own
   packages' compilers. Those importers now load the compiler by path through
   `bench/typescript.mjs`, which fails with the install hint (`npm --prefix bench ci`) when the
   compiler is absent. The cloud validator's worker resolves imports only against the captured
   allowlist, without filesystem or package lookup: its own loader maps `typescript` to
   `bench/node_modules/typescript/lib/typescript.js`, pinned by SHA-256 to the bytes of the npm
   archive matching the bench lock's integrity, and capture also requires the measured commit's
   bench manifest and lock to pin that version, archive and integrity. The browser binding
   extraction with 5.9.3 (main's locked archive) and with 6.0.3 gave identical output on the
   same inputs: the emitted scripts of two local production Next.js images (21 scripts each,
   5,185 and 5,193 functions: inventory and locations, module registrations, React contracts and
   their closures, free names, form handler discovery and URL resolution), and the 12,526 calls
   the browser evidence tests made to the extractor's exported functions. Of those calls' inputs,
   2,593 were seen under both compilers, all with the same output. Another 338 per run carry
   per-run random values, so they never recur across runs and were not compared.

6. <a id="choice-plain-css"></a>**Plain CSS files, scoped by the compiler, not utility classes or CSS-in-Rust.** Utility
   frameworks put unchecked strings in every view and need a scanner and a build step; CSS in
   Rust needs inline styles the CSP blocks, or a runtime. A CSS file per component keeps the
   language designers know, and the macro makes its class names typed. Tokens cover the
   one-off values (spacing, direction per breakpoint) utilities are good at. A value drawn from
   data is a custom property the component's file registers (`@property`), set from markup as a
   typed number with a unit (`style={FILL.pct(42.0)}`): a full page carries them in one style
   block allowed by its hash (one header source, no nonce, so a cached page stays the same bytes,
   where a hash per style attribute would be one header source per value), and the runtime sets
   a patch's through the CSSOM, since a document keeps the policy it loaded with. The compiler
   and startup check use one dependency-free CSS Syntax Level 3 tokenizer; policy and the
   boundaries of the checks are in [Limit 9](#limit-stylesheet-support).

   Stands on: bet (a CSS file per component and the typed token utilities are quick enough for the
   one-off values utility classes are good at, spacing and direction per breakpoint, so apps do not
   want a utility class for everything); platform (the CSP blocks inline `style=`, and `@property`
   registers a typed custom property); platform (CSS tokenizer boundaries distinguish comments
   from whitespace and keep URL payloads out of selectors and declarations, so both checks can
   use those same boundaries); reasoned (an untyped utility class is a string in a view the
   compiler cannot check without a scanner and a build step); value (typed class names, Values 4).

   Revisit when: apps built on Corten ask for, or write their own, utility classes beyond the typed
   token utilities, putting spacing, layout and type in views rather than in component files; or a
   CSP can allow values set from markup without a header source for each.

   Last checked: 2026-11-18, CSS rule, declaration and priority boundaries in the shared
   stylesheet fixture against constructed and external sheets in Chromium 159, Firefox 159
   and WebKit 27.2.
   The CSP refusing an inline `style=` and `@property` registering a type were probed on
   2026-11-06 in Chromium 156, Firefox 157 and WebKit 27.2.

7. <a id="choice-whole-pages"></a>**A page is sent whole, not streamed in parts.** Streaming a slow section later in the same
   response sends the status and headers before that section exists, so a failure in it can no
   longer become an error page or a redirect; and with the data fetched together (`tokio::join!`)
   and rendering in microseconds, the most it saves is the slowest source's wait. Two ways place a
   part streamed later with HTML alone, with JavaScript off. Chromium's out-of-order streaming
   (Declarative Partial Updates, on by default since Chrome 150) places it anywhere in the page's
   own markup: a `<?start name>` processing instruction marks its place, a fallback up to `<?end>`,
   and a `<template for>` sent later replaces that. Firefox and WebKit parse the marker as a comment
   and leave the template inert, so there the fallback stays and the part never shows; and no engine
   lets a script parse a stream into the page as the parser does (the streaming setters,
   `streamHTMLUnsafe`) without Chromium's experimental flag, so the runtime's navigations, which
   swap `<main>` in from a fetched answer, could not place a part that comes later without a script
   of their own doing what the parser does. Declarative shadow DOM, in all three, places it only at
   a slot: a `<slot name>` in a `<template shadowrootmode="open">` shows its fallback, and an
   element with that `slot` sent later as a child of the same host replaces it. With the whole page
   in the shadow root, the page is out of the document's reach: `document.getElementById` does not
   find its elements, a `#fragment` link does not scroll to one, and the document's stylesheets do
   not apply (a label's `for` still works). With only a layout in the shadow root (a default slot
   for the page and a named one for the part) the page, as the host's own children, keeps its ids,
   fragment links and styles, but the part can go only where that layout put a slot: its place and
   every element around it are in the shadow tree, which the document's stylesheets and ids do not
   reach, and it must be a child of the host, which stays open until the part arrives, so the page's
   markup after it waits inside that element. A part sent inside the page's own markup (a cell of a
   grid in `<main>`) is not placed: it stays where it is sent and the slot keeps its fallback. So no
   page of Corten's is in a shadow root or streamed in parts. A part that is slow and optional is
   drawn waiting and read once the page is on the screen (`ReadAgain::now`, answered by the page's
   own handler with `req.patch_or_with`), anywhere in the page, in every engine, after a full load
   and a navigation alike; where no read brings it, its waiting line links to the page with it read
   in ([Choice 44](#choice-slow-part-link)).

   Reopened by
   [#1483 One handler answers a page and its slow part: ReadAgain::now and Req::patch_or_with](https://github.com/corten-run/corten/pull/1483),
   since Chromium now places a part streamed out of order inside the page's own markup, which was
   this Choice's Revisit-when, and kept: in one engine of three it would be a second way to bring
   a slow part (Values 5) that, without a script, Firefox and WebKit never show (Values 3, which
   the waiting line's link meets in all three), and that the runtime would have to apply itself
   in those engines and on its own navigations, a script in every page's runtime for what the
   platform does not yet do (Values 1 and 2); and the part would still cost the page its status
   and headers.

   Stands on: bet (a page's sources are fetched together and the slowest is rarely slow enough for a
   part sent later to be worth its costs); measured (an uncompressed, untagged whole item page request
   takes 47 µs of CPU in the server benchmark, median of three load passes); platform (with
   JavaScript off, Chromium 156 applies a `<template for>` sent later to a `<?start name>` range
   inside the page's own markup, and Firefox 157 and WebKit 27.2 do not, keeping its fallback;
   the streaming setters are in Chromium only behind `--enable-experimental-web-platform-features`;
   a slot in a declarative shadow root shows its fallback until a child of its host for it
   arrives later in the response; a shadow root keeps the document's ids, fragments and
   stylesheets out of what it holds; an element for the slot sent elsewhere is not placed);
   reasoned (the status and headers go before a streamed part exists, so its failure cannot
   become an error page or a redirect); value (a page works without a script, Values 3, where a
   part a script places would land at the end of the page without one, a part streamed with
   `<template for>` never shows in two engines, and a page in a shadow root would lose its ids,
   links and styles).

   Revisit when: Firefox and WebKit apply `<template for>` by default and every engine has a
   streaming setter on by default, so a full load and a navigation alike could place a part
   streamed later without a script of Corten's own; then a part in the page's response is weighed
   against its status and headers, and against a part read once the page is on the screen. Or an
   app measures a first paint that streaming would bring forward by more than a part read once
   the page is on the screen does.

   Last checked: 2026-11-16 for `<template for>` and declarative shadow DOM (the whole page in the
   shadow root, a layout's slots, a part sent inside the page's cell), in Chromium 156 with and
   without `--enable-experimental-web-platform-features`, Firefox 157 and WebKit 27.2 (Playwright
   1.64.1, JavaScript off for placing the part, on for the rest), by `node scripts/dsd-probe.mjs`
   at `a1436d473`, and [Chrome 150's release notes](https://developer.chrome.com/release-notes/150) for
   `<template for>` on by default; 2026-11-06 for the item page's time, round
   r16, three load passes, on `eea6adb`.

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

   Stands on: bet (an app's static files are small enough to compile into its binary, a video
   included: a short clip is, and long or many videos belong in storage of their own); platform (a
   macro cannot ask cargo to watch a directory, so a new file waits for the next build that compiles
   the crate); reasoned (the binary is the whole deploy, and a constant per file makes a removed
   file a compile error).

   Revisit when: an app's static directory makes builds or images measurably slower than files
   beside the binary would, or startup measurably slower (every file is hashed when the app
   starts, so a large video costs there too); or a macro on stable Rust can tell cargo to rebuild when a directory
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

   Stands on: measured (views take over 1,000 server-rendered rows in 10.2 ms, ahead of the client
   frameworks measured, Solid next at 16.2 ms; the client-heavy table in performance.md, median of
   30 loads, round browser-4. That is one round of a number that has moved between runs (browser-2
   measured 29.5 ms, three reruns of it 4.9, 20.7 and 6.3), and it rose from browser-3's 6.0 ms
   on another CPU, Chromium and runtime while about half the loads now have a long frame of
   rendering before views are ready and the page is ready after Svelte's and Vue's. Part of that
   rise was the runtime's own evaluation at load, measured with `bench/browser/ssr.mjs` on one
   Intel Core i9-10885H laptop with browser-4's Chromium (156.0.8078.4): taking turns with
   `77002fe`, the round's commit took over 4.24 ms slower (standard deviation 1.03) in 8 pairs of
   30 loads and 2.96 ms slower (0.62) in 4 more, and its evaluation was 9.4 ms against 5.9 (+3.5 ms,
   medians of the loads with no long frame, no spread recorded); the round's median load had a long
   frame, which probably accounts for part of the rest.
   [#1246 Runtime: cut startup work on a long page (#1222)](https://github.com/corten-run/corten/pull/1246) cut evaluation by 4.14 ms (standard deviation 0.16, 6 runs of 30 loads) in another session
   on the same laptop and Chromium, from a base (`8c2a1b71`) with the round's runtime at 10.15 ms to
   the change's 6.00; the sessions' levels differ, so their differences compare. The next browser
   round measures takeover again
   ([#1222 Taking over 1,000 server-rendered rows rose from 6.0 to 10.2 ms in round browser-4 while Solid's, Svelte's, Vue's and React's fell](https://github.com/corten-run/corten/issues/1222)));
   value (Values 1: the work goes where it is fastest for the user).

   Revisit when: Values 1 changes. A case measured against the scripts guide's table (Server or
   browser) moves that case and the table, not this choice.

   Last checked: 2026-11-11, round browser-4 on a Xeon Platinum 8358, on `3fb4b1ac`; 2026-10-23,
   round browser-3 on a Xeon Platinum 8280, on `77002fe`; 2026-10-23, browser-2 and its three
   reruns, recorded in the browser benchmark's README at `0cda9827`; 2026-11-11, an A/B of
   `3fb4b1ac` against `77002fe` with `bench/browser/ssr.mjs` on an Intel Core i9-10885H laptop,
   Chromium 156.0.8078.4; 2026-11-11, paired runs of `8c2a1b71` against `8c9e84fd` (the startup
   change), the same laptop and Chromium.

10. <a id="choice-app-owns-document"></a>**The document is a component the app owns, not a shell Corten configures.** A page hands
   `req.page` its whole document, the app's layout with the page in it, and the head is markup
   like the rest (`<title>`, the page's tags, `<Corten />` where Corten adds its own), so there is
   no metadata builder, no shell hook and no second way to change the document. The default
   layout and error page live in the `corten new` template, where the app can read and change
   them, not in the crate. `html!` splits a document into the parts each request needs (the
   title for a data client; the title, head tags and `<main>` for a navigation), so a layout
   costs a navigation nothing: on the item page a full document got about 7% faster than with
   the shell and a navigation stayed within noise (`render_cost` medians of alternating runs,
   same bytes). The answers the runtime reads whole are the two pages that follow a `data-patch`
   write, the page it redirects to and its own ([Choice 66](#choice-write-own-page-whole)), so what
   the write changed in the layout is drawn as a full load draws it.
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

   A write the runtime sends also says that it draws its own page whole
   ([Choice 66](#choice-write-own-page-whole)), and says it in the standard header for that, as an
   HTTP preference (RFC 7240): `Prefer: corten-draws=whole`. A preference is what this is, one the
   server may ignore, and RFC 7240 has a server that does not know one ignore it, which is the
   deploy crossing both ways: a runtime from before (a tab open across a deploy) sends none and gets
   `<main>` alone, an answer it draws, and a server from before reads the request as it did. A
   header of Corten's own (`corten-draws: whole`, as this was first written) would do the same, and
   a new value of `corten` would not, since a server that does not know a value of `corten` reads
   the request as a whole document's. Not `return=representation`: it asks for the resource's state
   after a successful request, where a refused form (422) is the answer that most needs the whole
   page, and `<main>` and the whole document are both representations of the page; what the runtime
   says is what it can draw, so the preference is one Corten names. It is not in RFC 7240's registry
   (a specification is required, and an unregistered preference is ignored as an unknown one is,
   as the RFC's own examples show); neither is `corten`. Weighed and not a reason against it: it adds
   no CORS preflight, since `Prefer` is not a safelisted header but `corten` beside it is not either,
   so a submit to another origin was preflighted already (and the app's pages refuse cross-site
   writes); an intermediary may act on a preference it defines (`respond-async`), not on one it does
   not know; the server reads it only for a write the runtime sent: the line the runtime sends,
   `corten-draws=whole` alone, is compared whole, which costs a write no more than looking up a
   header of its own did (a patch took 62 instructions less, within the runs' range), and any other
   line is split at the commas and semicolons outside quotes (`cache::split_unquoted`, as
   `Cache-Control` is read), about 820 instructions more
   ([Choice 66](#choice-write-own-page-whole) has the numbers). No `Preference-Applied` is sent: RFC
   7240 (3) keeps it for when it is not apparent whether a preference was applied, and here the
   answer says what it is (`corten-shell` and no `corten-page` on a whole page, `corten-page` on
   every `<main>`, a navigation's too, as the runtime reads them), so it would add its bytes to every
   whole page and change nothing the runtime does. No `Vary` names it: RFC 7240 asks for one where
   applying a preference can vary what a cache does, and here none can. Only a write's answer
   varies with it, never a `GET`'s or `HEAD`'s (`page::own_page_whole`); a cache sends a `POST` on
   to the server, whatever it stored (RFC 9111, 4: an unsafe request is written through), and reuses
   a `POST`'s answer only for a later `GET` of its address, and only when it has explicit freshness
   and a `Content-Location` naming that address (RFC 9110, 9.3.3), which a page's answer does not
   (it is private and `no-cache` unless the app says otherwise, and Corten sends no
   `Content-Location`); and the PWA's worker passes every request but a `GET` to the network
   (`pwa.rs`).

   The preference is sent by the runtime and by the module it loads to send a progress upload
   (`corten-upload`), and a server answers a module's address, whatever version it names, with its
   own bytes, so across a deploy a runtime may load the other version's module. A module the runtime
   loads keeps its signature compatible from one version to the next: the upload module keeps its
   arguments in their old order and takes the runtime's headers last, so a runtime from before,
   passing none, sends the action header alone and is answered with `<main>`, and a runtime from
   after, handed the module from before, sends the upload without the preference and draws the
   `<main>` it gets. The watchlist smoke checks both.

   Stands on: platform (no registered media type tells a navigation from an action; a script cannot
   set `Sec-Fetch-*`, and data clients send none; a server answers any version's module address with
   its own bytes); reasoned (a media type parameter would mix the
   mode into content negotiation; RFC 7240: a server ignores a preference it does not
   know, `Preference-Applied` only where it is not apparent, `Vary` only where a cache's handling
   can vary; RFC 9110, 9.3.3 and RFC 9111, 4: a `POST`'s answer never answers a `POST`, and a `GET`
   only with freshness and `Content-Location`); measured (the preference's cost on a write, by
   callgrind).

   Revisit when: a standard header says "part of a page" and a script may set it; or a registered
   preference says what a client can draw of an answer, which would replace `corten-draws`.

   Last checked: 2026-10-30, no registered media type for a request's mode, as written at
   `1e5c56e2`; 2026-11-06, a script's `Sec-Fetch-Mode` and `Sec-Fetch-Dest` replaced by the
   browser's, probed in Chromium 156, Firefox 157 and WebKit 27.2; 2026-11-15, `Prefer` weighed
   against a header of Corten's own, RFC 7240's text and its registry of preferences (`respond-async`,
   `return`, `wait`, `handling` and others, none about what a client draws) read, the CORS
   safelist (`Accept`, `Accept-Language`, `Content-Language`, `Content-Type`, `Range`) checked,
   and the cost of reading it measured by callgrind on `914f4781e`, with and without the whole
   line compared first (as `70b69a3db` has it), against `5d0bf7599`, three alternating rounds;
   2026-11-16, the upload module called with an older runtime's arguments and the runtime handed the
   older module, both passing in the watchlist smoke in Chromium, Firefox and WebKit on `3587a1b18`,
   and the same two cases by a one-off probe in Chromium against that build (not a repository
   check), each failing with `3dc461f6e`'s module or runtime served in its place: called the older
   way, that module throws, and that runtime handed the older module sends no upload.

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
   handler awaited takes 28.8k. A `PageOr` or `SwitchOr` that answers a file or an upgrade
   starts the reads, since either may answer a page: each read's `start` runs (a read that looks up the caller starts that lookup)
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
   (`chase-sets/chase-sets@162ed0c298`, the commit the issue links).

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
    that says so. `Request` and `Response` are the `http` crate's over Corten's own body
    (`corten::http::Body`), `corten::http` names `IntoResponse` and `IntoResponseParts`,
    Corten's since step 4 with axum-core's names and shapes, and `corten::http::Bytes` and
    `corten::Listener` the rest. `FromRef` (the trait and the derive) is Corten's too: a
    conversion of the routes' state that Corten's `State` reads, with the impl for the state
    itself that axum-core's had. axum's
    own extractors (`Path`, `Query`, `RawQuery`, `Json`, `Extension`, `ConnectInfo`,
    `MatchedPath`, `Parts`) implement axum's traits, not these, so a handler that takes one does
    not compile: a route's path and query are its `Params`, a body its `Json`, `Form` or
    `Upload`, and the head its `Req`; a second reader of each would be a second way. Before,
    axum's `Path` and `RawPathParams` compiled and answered `500` to every request on Corten's
    router, refused at startup by type name; now they fail to compile as any type implementing
    neither trait does (the `compile_fail` doctest in `extract.rs` holds that with a type of the
    app's own; axum is not a dependency to name in one). A handler that takes the whole
    `Request` reads its body up to a limit of its own with `corten::extract::bytes_up_to`, as an upload's file is read with `File::bytes_up_to`, not
    axum's `to_bytes`, whose one error is both a body over the limit and one that broke, and which
    leaves the rest of a body over it unread, so a client still sending can miss the answer; a
    body too large to hold is read piece by piece with `pieces_up_to`. `Bytes`, `String` and Corten's
    `Json` and `Form` read a whole body with Corten's reader at a limit (2 MiB, axum's, unless set) and with its
    texts: a 413 over it, a 400 for a body that broke or text that is not UTF-8, a 415 for a
    content type that is not the reader's, each one `corten::extract::BodyRejection` (plain text)
    where axum had a type for each. A body over the limit is read past until twice the limit has arrived, at most the limit and
    64 MiB (and the piece that crossed that), so a browser still sending sees the 413, and one
    whose length says it is longer is refused unread: these readers serve every route that takes
    one, so a refused request costs about what the limit allows, not the 64 MiB `bytes_up_to` and
    an upload read past, which an app chooses per route. The limit is set where the deadline is,
    `App::body_limit`, `Area::body_limit` and `Api::body_limit`, resolved by the same prefix
    rules (the innermost area or API that sets one), and it is what an `Upload` keeps unless its
    handler says otherwise: an app that takes large documents under `/api` raises it there, and
    an area of short forms lowers it, without either changing every page. It was fixed at 2 MiB
    when axum left (axum's `DefaultBodyLimit` layer set it per route, and no example app read a
    larger whole body). It is a setting again because the limit is the readers' defence and one
    size serves neither end of an app well: a public area of short forms is cheaper to refuse at
    a few KiB, and an API that takes documents needs more than 2 MiB without dropping `Json` for
    `bytes_up_to` and parsing by hand. No example app sets one yet, so that is a bet, and every
    app pays for it whether it sets one or not: a whole body read costs about 1% more (below). Not chosen: a limit per route, which axum's layer gave and which
    would be a second place a route's settings live beside its area or API; and a type parameter
    on the readers (`Json<T, LIMIT>`), which puts a server setting in every handler's signature.
    The request's `Signal`, which every staged request already allocates, carries the limit,
    so setting one adds no allocation: each request reads the limit from the scope of its area or
    API, given to its route when the router is built, or for an unknown URL and a route that can
    match under another prefix found by the request's path ([Choice 28](#choice-fixed-stages)),
    and pays an XOR as its signal is made, and a reader the lookup of the signal and another XOR.
    The readers wait for a slow client until the deadline, not an idle time as an `Upload` does,
    so a raised limit is held that long: a prefix that raises one keeps a deadline. A route that
    says `unstaged` reads no body; one that takes more than its prefix allows takes the whole
    `Request` and reads it with `bytes_up_to`.
    One reader per body, a whole one: a body declared over the limit is read past from its first
    piece and none of it is kept. `Json`'s answers are axum 0.8.9's, recorded before it left and
    held by a test (`json.rs`, `AXUM_0_8_9`), and so is which content types it takes: mime
    0.3.17's grammar, narrower than RFC 9110's (8.3.1: no tab, no space before `;`, no escapes in
    a quoted value), kept so an app's clients are answered as before; `Form` reads its content
    type with Corten's media-type reader (`api::media_type`), which takes the type before any `;`
    with the whitespace around it trimmed and does not check the parameters, so the two differ for
    a content type the RFC allows and mime did not (a space before `;`). A test's stand-in for another server the
    app calls is not the app, so Corten names nothing for it: the test depends on a server of its
    own (axum as a dev-dependency, say), as the app guide shows.

    Not chosen: new names for the traits (`FromHead`, `FromBody`), which would say what they read
    better but make every app's extractor change for no behavior; keeping axum's traits as
    re-exports after Corten owns dispatch, which leaves axum's version in every app's extractor
    signature for nothing Corten uses; and `#[async_trait]` or boxed futures, which axum 0.8 itself
    dropped for `impl Future` in the trait.

    Stands on: measured (callgrind, release, Corten's handler traits against axum's, step 3
    against step 2 at `7bba1e2b`: about 100 instructions fewer a staged request with jemalloc
    and 150 to 170 with glibc, an unstaged one the same; [Choice 25](#choice-axum-router), Stands
    on);
    bet (the maintainer asked for the limit to be set where the deadline is, after the review of
    the framework without axum; an app that needs a size other than 2 MiB for `Json` or `Form`
    is expected, not yet seen);
    measured (callgrind, release, jemalloc, 1,200 against 200 requests in process through the
    stages, one run each, the settable limit against `9653c20c`: a plain answer 13,234
    instructions a request before and 13,261 after, and a 1 KiB body `Bytes` reads 17,291 before
    and 17,461 after, the same with `App::body_limit(4 << 20)` set (an area's limit then added a
    prefix lookup like the deadline's, not measured; since
    [#1213 The stages find a request's area by its path in six prefix tables after the router has already matched its route](https://github.com/corten-run/corten/issues/1213)
    it is read from the route's scope with the area's deadline and middleware, which
    [Choice 28](#choice-fixed-stages) measures together, Stands on); a limit put on the request as
    an extension of its own instead cost 17,969 with one set);
    measured (axum 0.8.9's `Json` answers to twelve bodies under eight content types, recorded
    before it left and held by `json.rs`'s `AXUM_0_8_9` table);
    reasoned (the trait's shape is axum 0.8's, so an extractor's `impl` body compiles unchanged;
    the router calls `Handler` once per request, as it called axum's); value (one way to read
    each part of a request, Value 5, and a mistake that fails when the app compiles rather than
    when it answers, Value 4).

    Revisit when: an app needs an extractor that cannot be written with this signature (one that
    borrows from the request beyond its call, say); or an `http` release changes what `Parts`
    holds; or an app needs a body limit for one route that differs from its area's or API's,
    which would add one per route; or by the 0.2 release no example or reported app sets a
    body limit, which takes the setting away again; or a client is refused a JSON content type RFC 9110 allows, which
    moves `Json` to one reader of the RFC's grammar, shared with `Form`, so a content type is
    parsed one way.

    Last checked: 2026-11-09, axum 0.8.9 (`axum-core` 0.5.6) and rustc 1.99.1, Corten's own
    traits at the commit that adds them ([Choice 25](#choice-axum-router), Last checked);
    2026-11-10, `IntoResponse`, `FromRef` and the body readers Corten's, axum gone
    ([Choice 25](#choice-axum-router), step 4), with axum 0.8.9's `Json` answers recorded first;
    2026-11-10, the limit set per app, area and API and its cost, measured against `9653c20c`;
    2026-11-12, an area's limit read from its route's scope, not by a prefix lookup, measured
    with the area's other settings at `f7d33ce2` against main `31de4268`
    ([Choice 28](#choice-fixed-stages), Stands on).

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

23. <a id="choice-jemalloc-image"></a>**The image `corten new` writes preloads jemalloc, an image
   package, not a crate, with its background thread and a 64 KiB thread cache.** glibc's allocator
   keeps memory a burst of connections freed, and each burst grows what it keeps. Eight floods of
   4,000 unfinished 30 KiB request heads (`bench/fullstack/flood-memory.mjs`, card-market at
   `81f1f8ef`, `--cpus 1 --memory 1g`, three runs each, the cgroup's `memory.current` 35 seconds
   after the last flood, its anonymous memory in brackets) left 406 to 455 MiB (398 to 446) on
   glibc's allocator, climbing 31 to 38 MiB a flood. Its own settings did not stop that: two arenas
   or one left 382 to 452 MiB (376 to 439), and two with a 16 KiB mmap threshold 177 to 184 (172 to
   177), still climbing 20 MiB a flood. jemalloc as Debian builds it left 118 to 139 MiB (114 to
   128), since it returns memory only while the app allocates, and with `background_thread:true` 7
   to 11 (4 to 8), and 13 to 16 (4 to 9) with the thread cache below too, with no climb. Sampled a
   second before each hold ended, the highest was 187 to 197 MiB with the background thread, 217 to
   227 without it and 418 to 466 on glibc. The thread costs nothing seen at rest: an app that had
   served no request took 87 to 112 ms of CPU a minute with the tuned settings and 83 to 91 without
   them (`alloc-faults.mjs` with `IDLE_SECONDS=60`, cgroup `usage_usec`, three rounds,
   `results/alloc-idle`), with three more threads; capping them at one (`max_background_threads:1`)
   left one more thread and 79 to 113 ms, so the image leaves jemalloc's default. A flooded app's
   idle time, while the thread returns the flood's memory, was not measured
   ([the app guide](guide/app.md),
   [#852 Memory a flood of unfinished request heads takes is not given back when the connections close, and each flood grows it further (217 to 464 MiB over eight)](https://github.com/corten-run/corten/issues/852),
   [#1011 Design Choice 23's jemalloc default rests on one flood run each and CPU rounds on a shared desktop; brotli and glibc's own tunables were never measured](https://github.com/corten-run/corten/issues/1011)).
   jemalloc's thread cache stops at 32 KiB unless set, and a brotli response, which a client
   without zstd gets, allocates buffers above that, so jemalloc maps them again for every one: the
   item page sent with brotli took 19.3 to 19.4 minor page faults a request with jemalloc's
   defaults, its background thread, no decay, `retain:false` or `thp:never`, and none with
   `tcache_max` at 64 KiB or 8 MiB, as on glibc (`bench/fullstack/alloc-faults.mjs`, the server's
   `minflt` over 2,000 requests, three rounds, `results/alloc-faults-br`); with `identity` or zstd
   jemalloc's defaults, the tuned image and glibc took none (`results/alloc-faults`). That probe's
   coarse CPU time put a brotli page at 355 to 595 microseconds with those faults and 285 to 350
   without in one set, but 430 to 580 against 340 to 530 (tuned) and 345 to 465 (glibc) in the
   other, so it agrees in direction only. On the benchmark item page (`bench/fullstack/ab.mjs`,
   jemalloc as it comes, tuned, and glibc alternating, three rounds, 300 requests a second for 40
   seconds, then 64 users, `results/ab-jemalloc-tuned`) the tuned image used 12.4% of its core at
   300 brotli pages a second (12.0 to 14.4) against 16.8% (15.8 to 18.4) and 17.0% on glibc (16.3
   to 17.5), and served 3,486 a second at 64 users (2,298 to 3,829) against 2,132 (1,303 to 2,210)
   and 2,357 (1,908 to 2,470); with `identity` and with a browser's encodings (zstd) their ranges
   overlapped, except a browser's at 64 users, where glibc's 2,139 to 3,392 sat below both (while in
   `results/ab-jemalloc` glibc's median, 4,936, was above theirs, 3,607 and 3,454, the ranges
   overlapping). No image with glibc's tunables went through `ab.mjs`, since none gave a flood's
   memory back. An earlier set without the thread cache
   (`results/ab-jemalloc`) had glibc at 3,554 brotli pages a second against 1,720 for jemalloc and
   1,905 with its background thread. Those rounds ran on Docker Desktop with other work running,
   where rounds of one image moved by up to 2.4 times at 64 users (glibc with `identity`, 3,490 to
   8,467) and CPU time at 300 a second by up to 1.9 times (7.8 to 14.5% in `results/ab-jemalloc`),
   so they show no cost they could see, and a brotli gain that the fault counts explain but whose
   size they do not settle. Under callgrind the item page took about 83,000 instructions per
   request with jemalloc and 87,000 with glibc (five runs each, at `547b54ae`). The image grows by
   1.8 MB (84.1 against 82.3). A `#[global_allocator]` crate in the app would do the same in the
   program, but it compiles C into every build and binds the app to it outside Docker too; the
   image's three lines are the app's, which it removes to run on glibc's, and card-market's image
   has them too
   ([#886 The template's image runs glibc's allocator, which keeps what a flood of unfinished heads freed; preloading jemalloc gives it back, unmeasured for throughput](https://github.com/corten-run/corten/issues/886)).

   Stands on: measured (memory after eight floods, three runs each, seven allocator settings; page
   faults a request, repeatable to 0.1 in every round; idle CPU, three rounds; instructions a
   request under callgrind, five runs each); measured, noisy (CPU time and throughput in three
   rounds on a shared desktop, whose rounds moved by up to 2.4 times); platform (Debian 13's
   `libjemalloc2`, 5.3.0, has `background_thread` off and a 32 KiB `tcache_max` unless set, and
   takes these option names); bet (an app's image is Debian with that package); reasoned (an image
   package binds only the image, where a `#[global_allocator]` crate compiles C into every build).

   Revisit when: a run on a quiet Linux host (`ab.mjs` or `alloc-faults.mjs` on a droplet) shows a
   cost per request or no gain with brotli; the brotli encoder or its level changes what it
   allocates (buffers above 64 KiB would fault again); Debian's jemalloc changes its thread cache's
   default or drops `background_thread`; or an allocator Debian ships returns a flood's memory with
   no settings.

   Last checked: 2026-11-06, the callgrind runs on `547b54ae`, recorded at `b179987a`; 2026-11-08,
   the floods, the page faults and the rounds, images of `81f1f8ef` (but for the tuned image in
   `results/alloc-faults` and `alloc-idle`, a build whose commit was not recorded); 2026-11-19,
   Debian's libjemalloc2 5.3.0 (package 5.3.0-3) in `debian:trixie-slim` on amd64, its defaults
   printed by `MALLOC_CONF=stats_print:true`.

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
    matchit: a connection loop, stages, a router, handlers and the readers they take. axum left
    it in four steps, each measured, and tower's traits stay only at its edges: `App::layer`
    takes a tower layer, and the whole router is a tower `Service` for a server of the app's
    own.** Each part is one of these, and each is built on the one before it:

    1. Transport: tokio's TCP listeners, and the app's own (`corten::Listener`, a TLS step in
       `serve_wrapped`). UDP is only HTTP/3's, which [Limit 14](#limit-http1) leaves to the proxy.
    2. Protocol: hyper's HTTP/1.1 reads and writes the connection. It stays: framing is where a
       server's worst bugs live (request smuggling, chunked bodies, pipelining), hyper is tested
       for them as Corten could not be, and nothing measured here points at it.

       While a connection is idle, a request's head must arrive within `App::header_timeout` (30
       seconds), which also closes an idle keep-alive connection, and be at most
       `App::max_request_head` (32 KiB, [Choice 19](#choice-head-size)) with at most 100 headers; an answer must make
       progress, a write that finds the send buffer full waiting at most `App::send_timeout` (60
       seconds, nginx's `send_timeout` and its meaning, rather than Kestrel's minimum rate of 240
       bytes a second, which would need a count of bytes and a window in the connection's writer, for
       every connection; the wait starts over each time the connection reports room, since over
       TLS a write or a flush stays pending while the TLS library sends what it holds, where a
       plain socket's write would go through: before that, with 16 KiB buffers, a client reading
       4 KiB every 62 ms against a 700 ms timeout got its whole answer over plain HTTP in 5 of 5
       rounds and was cut over tokio-rustls through `serve_wrapped` in 5 of 5, as the
       [steady reader control](../bench/http2/README.md#steady-reader-control) had reasoned, and
       after it got it over both in 5 of 5. A slower reader is still cut where it takes bytes
       from its socket in bursts: a tokio-rustls client reading 2 KiB every 125 ms against
       2 seconds was cut within 9 seconds in every round (3 before the change, 5 after), its
       socket reads coming as whole 16 KiB records; in 2 traced rounds the server's socket
       reported room about a second apart twice and then not for the last 1.8 or 2 seconds
       before the cut, where plain HTTP's came every 1.5 seconds. The same rate read evenly from
       the socket was kept past 30 seconds over TLS and plain HTTP alike, and plain readers in
       bursts (16 KiB a second, `curl --limit-rate 16K`) were cut, so the reading pattern decides
       it, not TLS
       ([#1757 send_timeout cuts a slow reader that takes bytes from its socket in bursts, over TLS and plain HTTP alike](https://github.com/corten-run/corten/issues/1757));
       and while the connection's task has spent tokio's cooperative budget a report of room
       does not start the wait over
       ([#1742 A TLS flush that stays pending while a slow client reads steadily may trip send_timeout: test serve_wrapped over TLS with a steady reader](https://github.com/corten-run/corten/issues/1742)));
       a request body read as it arrives (`pieces_up_to`, `Upload`) gives up on a client that sends
       nothing for its idle time (a minute, nginx's `client_body_timeout`) or whose
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
       open is `App::max_connections`, unbounded unless set.

       Live streams still require a proxy or CDN speaking HTTP/2 to browsers, even when
       `serve_wrapped` ends TLS itself. The earlier watchlist check (two streams per page)
       saw the fourth HTTP/1.1 tab get no answer in 15 seconds, against eight loaded over h2
       through nginx; the browser cap is about six connections per host, not eight tabs.
       The app cannot diagnose this at startup: a feed's snapshot and stream both have rows,
       and a TLS-wrapped origin behind a re-encrypting proxy is valid. The deployment guide
       has ten proxy-specific concerns, not thirteen extra requirements: its rows 5 (shared
       caching), 9 (health) and 12 (HTTPS policy) are conditional or apply without a proxy.
       The measured nginx `$host` port loss causing a WebSocket 403 shows a real configuration
       failure. Operator time, money and memory have not been measured, not counted as zero.

       The opt-in `http2` prototype at `1a8adcb5f`, retained under
       [evidence/http2-prototype](https://github.com/corten-run/corten/tree/evidence/http2-prototype),
       was weighed against `ecbef5eb`. Off, the template still has 59 dependency crates with
       the same tree and the item test's identical executable code section (not identical
       whole binaries). Three alternating callgrind pairs give 74,531 instructions per item
       request against 74,751, with overlapping ranges, so no speed difference is shown.
       On, it adds eight crates (67 total), with TLS still the app's choice. Eight direct-TLS
       watchlist tabs loaded and received live events over h2 in Chromium and Firefox.
       WebKit's SSL connect error was not investigated; environment versus protocol is unknown.
       A small TLS page counted 58,724 instructions/request over h2 against 40,519 over HTTP/1.1
       through the feature-on hyper-util auto builder, not the shipping `http1::Builder` path.
       Events counted 5,174 against 2,806 through that same builder. These medians do not
       include the missing security-bound implementation. Workloads, ranges, client scripts
       and the partial coverage are in [HTTP/2 evidence](../bench/http2/README.md).

       The prototype does not ship. With a 100 ms send timeout, a zero-window response
       resumed after 500 ms once the client granted credit: the socket watch misses that wait.
       The partial-head probe, however, kept stream 1 open at `/quiet` while stream 3 waited
       for CONTINUATION. HTTP/1.1's header watch is BUSY while an answer is open too, so this
       is not evidence of a weakened header guarantee. The historical probe did not cover an
       idle h2 connection with no open streams. The historical prototype's first h2 request
       calls `watch.take()` then `busy()`, removing the response's path back to idle.

       **Idle disposition:** use protocol stream activity, not response-body lifetime.
       Direct [h2's active-stream count](https://github.com/hyperium/h2/blob/v0.4.20/src/server.rs#L562-L565)
       passed all eight [idle cases](../bench/http2/README.md#follow-up-results) in three runs:
       the reused connection with an incomplete head closed in 110.5 to 113.2 ms with 100 ms set,
       the watch returned to idle after overlap, reset and cancellation, and an open sibling
       kept the watch busy. The Hyper service count passed those cases but went idle too early
       with a final DATA tail still waiting for credit (closed in 97.5 to 100.9 ms from its
       first byte); direct h2 stayed busy until the tail drained. Hyper does not expose the h2
       count. This establishes an idle-watch candidate independently of the send decision.
       It is not a wire-flush signal or a header-block timer while a sibling remains open.

       A detector based only on polling and dropping Corten's `Answered` body cannot preserve
       the send bound. In [hyper 1.12.0's send loop](https://github.com/hyperium/hyper/blob/v1.12.0/src/proto/h2/mod.rs#L157-L186),
       a body may be waiting to produce data or hyper may be waiting for room to send a chunk
       it already took. Seeing the handoff can distinguish those two waits, but hyper hands
       the whole chunk to h2 as soon as it has some capacity, and can finish the body at that
       point. [h2 0.4.20's send queue](https://github.com/hyperium/h2/blob/v0.4.20/src/proto/streams/prioritize.rs#L749-L838)
       can still hold the unsent part. The same body poll and drop can therefore mean either
       a normal end or a buffered tail still waiting for credit. Clearing a timer on body
       drop misses the latter; leaving it armed without a completion signal can close the
       former. Socket writes cannot identify progress on one response rather than a sibling.

       **Send disposition:** do not use body polls and drop alone. The tested `Answered`
       detector closed the zero-window connection in 111.8 to 117.3 ms but missed both final-tail
       cases: the old DATA still arrived after the client gave credit past 500 ms, with or
       without a progressing sibling. A parser-free `Body::Data` tracker stayed with the
       bytes after the body ended. In the pinned Hyper/h2 probe it closed all three stalls
       in 111.0 to 116.6 ms, and distinguished quiet production, normal completion, resumed or
       incremental credit, and reset. This is a measured candidate for flow-control waits,
       not a general send guarantee: h2 can consume the buffer into its encoder before
       TLS flush, so the socket write watch still matters.

       Keep HTTP/1.1 in `serve` and HTTP/2 at the proxy. The probe's
       [combined mode](../bench/http2/README.md#combined-results) has since run the h2 count,
       the buffer tracker and a socket write watch like `Watched` on one connection path with
       no frame parser. The 17 original combined controls passed in every round, including a
       paused TCP reader that only the socket watch closed, with h2 holding no DATA buffers. The
       steady reader control, the 18th, failed 1 of 7 rounds with a false close by the socket
       watch, so the combined evidence is not complete; the remaining probe work stays in
       [#1686 HTTP/2 in corten::serve: show the idle and send bounds together with the socket watch on one opt-in path](https://github.com/corten-run/corten/issues/1686).
       Even complete, it is a probe, not `serve`: nothing ships before the checks that Revisit
       when lists.
       Do not add a second frame parser or treat closing the whole connection as a substitute
       for detecting the stall.
       The auto builder's missing HTTP/1 `max_header_size` setter is also a prototype
       limitation, not a reason HTTP/2 cannot ship: Corten could detect the preface itself
       and retain its HTTP/1 builder. Decoded h2 head limits, concurrent-stream/reset bounds,
       GOAWAY with open streams and HTTP/1 WebSocket fallback still need verification.
       Do not advertise RFC 8441 unless implemented; explicit h2 refusal is an alternative.

       This weighs two reliability failures, not reliability against convenience alone:
       the no-proxy live app already fails at the fourth tab, and an opt-in feature would
       leave the default unchanged. The reason to defer is that a feature must not silently
       weaken a security bound. Keep the proxy requirement (option 2) until the connection-level
       design (option 1) holds both bounds on an opt-in `serve` path. One stream per page
       (option 3) still exhausts the cross-tab cap and adds a custom format where HTTP/2 is
       standard, against [Rule 10](#rule-standard-formats). HTTP/3 remains out: `quinn` and an
       unstable `h3`, TLS tied to QUIC, and no need for it merely to remove this connection cap.
    3. Vocabulary: one module, `corten::http`: the `http` crate's types (`StatusCode`,
       `HeaderMap`, `Uri`), which hyper, HTTP clients and HTTP/3 libraries share, and what Corten
       builds on them: `Body` (and `BodyDataStream`), `Request` and `Response` over it, `Bytes`,
       and `IntoResponse`, `IntoResponseParts` and `ResponseParts`, which are Corten's contract
       for how a handler answers rather than shared ones, kept here so an app imports one module
       for a request and its answer. Nothing above names the connection's protocol, and an app
       names this layer from one place; the crate defines each type where it is used (the body in
       `body`, the request in `handler`, the response in `response`) and the module gathers them.
       Until it was one module, an app named the body from `answer`, the request from `extract`
       and the response from `middleware`. `MatchedPath` stays in `middleware`: it is the
       route's pattern, which the router gives, not HTTP's.
    4. Stages: what goes around a route ([Choice 28](#choice-fixed-stages)), each one a future that
       wraps the route's, in Corten's one order. A route goes through all of them or says
       `unstaged` and goes through none, its lane in their place (the host check and the headers
       every answer needs); nothing reorders them.
    5. Router: the method and path to a route (matchit), boxing once per request.
    6. Handlers: a function whose arguments are read from the request and its stages, and whose
       answer is any `IntoResponse`, a raw `Response` included.
    7. Typed routes, `#[corten::routes]`, areas, APIs and `App`, which say what each route gets.

    Today 2 and 3 are hyper's and the `http` crate's, and the rest is Corten's own code (the
    accept loop and connection limits, the stages, `corten::Router` on matchit, `Params`, the
    readers `Form`, `Json` and `Upload`, `Upgrade`, since step 3 the `Handler` impls and
    `FromRequestParts`, and since step 4 the body, `IntoResponse`, the server-sent events writer
    and `Listener`): axum is no longer a dependency. Until step 2 the stages sat on tower's `Layer` and `Service`
    because axum's router took them. That seam was what an app paid for: axum boxed every layered
    route again and cloned that box on each request, so what went around one route had to be
    written into its handler to cost nothing more. An `unstaged` route's host check and its API's
    JSON, written first as a `route_layer` around those routes, cost 9,230 instructions a request
    against 8,479 written into the route's handler. A prototype pipeline of Corten's own (`prototypes/pipeline` at `7cea4970`, on the branch
    `codex/pipeline-prototype`, which is not yet pushed or merged, so these numbers cannot yet be
    checked from the repository) took 5,393 instructions for one JSON request through its router
    against axum's 8,508, and 9,493 with every default stage against Corten's 17,336. tower's
    `Service` (`poll_ready`, `&mut self`, a clone per call) is a shape for backpressure that
    a request's route does not have; it stays only at the edges: `App::layer` takes a tower
    layer ([Limit 12](#limit-fixed-stages)), `corten::Router` is a `Service` (its `poll_ready`
    always ready) so an app's own loop or tower's tools can serve it, and the connection loop
    calls it so. No stage, route or handler is one. At that edge the router gives a `HEAD` the
    length its `GET`'s body has, where its `GET` says one (none for a `1xx`, a `204` or a
    `304`, nor for an answer that says `Transfer-Encoding`: hyper gives their `GET` none), and
    drops the body, and leaves every other answer's
    `Content-Length` to the server: hyper's HTTP/1 encoder writes it from the body's exact size
    into the head it sends, `content-length: 0` for an empty body where the status may have one,
    so a header the router set as well was made in two allocations and inserted only for the
    encoder to find again: 803 instructions and two allocations of the lean catalog page's
    44,134 and 22 a request (Stands on has the runs, and that the cycles a request under load
    did not tell the two builds apart). Three answers differ on the wire from when the router
    set it, each as HTTP asks: a `204` or a `304` given a body with bytes said that body's
    length, which hyper wrote from the header without looking at the status, and says none now;
    a `HEAD` said `Content-Length: 0` for a `204` or a `304` (RFC 9110 8.6 allows a `204` none,
    and a `304` only its `200`'s); and an answer whose handler set `Transfer-Encoding` over a
    body of known size, which hyper refused to send with the router's length beside it (the
    client got no answer), is sent chunked, and its `HEAD` says no length (RFC 9112 6.2). Each
    was seen on the wire at `0aef5330c`, with the test Stands on names run against it. A `101`
    a handler answers itself differs the same way as a `204`, by hyper's source and not seen on
    the wire, since hyper hands the connection on after one. On a connection the server is
    closing, hyper's source has the length's line follow `connection: close`, where it came
    before it. An
    answer Corten's server did not send (`App::test()`'s, or one taken from `corten::Router` by
    a test or by an app's own loop that serves the router) says its length in its body, not in
    a header, unless it answers a `HEAD` or its handler set one; an `App::layer` never saw the
    header, which was set outside it.

    The steps, in order, each landing only when the one before it has:
    1. The dispatch suite (`crates/corten/tests/dispatch.rs`): raw HTTP/1.1 to `serve_on` and the
       answer's bytes, naming no router type, for matching (a segment of text chosen over a
       parameter, the path before the method, nothing decoded before matching, an empty segment
       before another segment, which on axum's matchit 0.8.4 matched a parameter as an empty
       value and since matches none, as an empty segment at the end never did), `HEAD`, `405` with `Allow` for a
       method the route lacks, percent-decoding of parameters, catch-alls, text after a parameter, an area's and
       an API's prefix, every path under an API's prefix being its own, an API's failures, the
       host check, and an unstaged route's. It passes on axum now, and every later step passes it
       unchanged; a case the next step finds missing is added to it first, on axum.
       Once axum had left, one case changed on purpose: a method no route in the app has a
       handler for (`PROPFIND`, `QUERY`) is a `501` with no `Allow`, as RFC 9110 9.1 says, where
       axum's router answered `405` with the route's `Allow`, which 15.5.6 keeps for a method the
       server implements and the resource lacks
       ([#1216 A method the app routes nowhere (PROPFIND, QUERY) is answered 405, where RFC 9110 9.1 says 501](https://github.com/corten-run/corten/issues/1216)).
       The deliberate matchit 0.9.2 upgrade later made every path parameter nonempty: an empty
       segment no longer matches it, though another route such as a catch-all may answer
       ([Choice 48](#choice-matchit)); the dispatch suite now requires that rule.
       The path is still matched first, so an unknown URL is a `404` whatever its method: RFC 9110
       sets no order among its errors when more than one applies, and the `404` keeps the app's
       own not-found page for a mistyped address, where a `501` would say nothing about it.
       A browser's `501` is the error page's `Failure::UnknownMethod`, which the request is at
       fault for as it is for a `405`, so the page waits for the layout's reads; the router marks
       its `501` (a response extension), so a `501` a handler or a middleware answers for a part
       not built yet stays `Failure::Failed`, a failure of the app's; the mark counts only while
       the answer is still the router's empty `501` (a body whose size is known to be zero), so a
       middleware that turned it into another status, or gave it a body of its own that is not
       plain text, keeps what it wrote on the error page's path, as it does on an API's; a
       plain-text body is `Failure::Rejected { status: 501 }` for a browser and JSON for an API's
       client, as a handler's plain-text `501` is; and an empty body whose size is not known (a
       middleware that wraps or streams it) is sent as a bare `501` with no error page, as the
       router's `404` and `405` are then. `CONNECT` is a `501` only in origin form (`CONNECT /items/7`); the
       authority form a client sends (`CONNECT host:443`) names no path, so it is a `404`.
       The methods some route has are gathered when the router is built, with `GET`, `HEAD` and
       `OPTIONS` always among them (`OPTIONS` because its caller asks what a resource allows,
       which the `405`'s `Allow` tells it, where a `501` would tell it nothing), and every method
       once any route takes every method (`any`, a relay whose upstream may implement it); only a
       request that reaches a route's `405` reads them, so no other request does more work
       (Stands on has the counts).
       A `501` is a 5xx, so a scanner's `PROPFIND` or `TRACE` raises a proxy's or a CDN's 5xx
       rate, where a `405` did not; RFC 9110 9.1 says a server SHOULD answer it so, a client
       reads from it that no resource here takes the method, and Corten does not log it as an
       error. Nothing on the wire tells the router's `501` from a handler's, and CloudFront's
       stock 5xx metric and Cloudflare's error-rate notifications filter by no method (Stands on),
       so leaving them out takes an alert built from access logs or the app's own metrics: the deploy guide gives the filter,
       `status = 501 AND method not in the app's served methods`
       ([Deploying](guide/deploy.md#monitoring)). That cost is accepted rather than keeping the
       `405` the standard does not ask for: Standards first (Value 2) comes before Good defaults
       (Value 7) in the order the Values give, the cost falls on alerting and on clients that
       retry every 5xx by default (Stands on), each with a setting that leaves these out, rather
       than on what a client is told, and the `405` would tell every client a wrong thing (that this resource
       lacks a method the server implements) to spare an operator's alert.
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
       parameter and its `405` and `501`, the router's own, meet as its handler's answer does. Its handler
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
       It has landed. The body (`corten::http::Body`), `IntoResponse` and `IntoResponseParts`,
       the readers of a whole body, the server-sent events writer and `Listener` are Corten's, and
       `corten::axum`, `compress::apply` and `Policy::apply` are gone: compression and the
       security headers are stages `App` puts around every route, and a route with neither is
       `unstaged`. corten-feed answers with the `http` crate's `Response` over a body of its own
       (`FeedBody`). Corten's workspace keeps axum only as a dev-dependency: card-market's bench
       binary answers with it beside Corten. The benchmark apps outside the workspace that measure
       axum as a framework (axum-maud, leptos) depend on it as they always did, and Corten's own
       bench apps no longer do. The dispatch suite passes unchanged.

       Measured at `5548c97a` against step 3 at `67e7f5f5` with a harness outside the repository
       (the same JSON item answered in process by each request shape, built with feature `json`;
       callgrind, release, the run of 1,200 requests less the run of 200 over 1,000, three runs of
       each build with jemalloc and with glibc's allocator in brackets, every run the same but the
       feed's below): a
       staged page costs 478 fewer and the rest is within 24: a page route 17,717 against 18,195
       (18,960 against 19,500), one with a middleware 18,001 against 18,479 (19,241 against
       19,781), a staged route beside an unstaged one 17,723 against 18,201 (18,985 against
       19,517), an API request 13,057 against 13,059 (14,089 against 14,075), its 404 12,227
       against 12,251 (13,366 against 13,369) and a page's 18,087 against 18,101 (19,996 against
       20,010), and an unstaged route 7,030 against 7,019 and 7,076 against 7,065 in an API's
       module (7,834 against 7,823 and 7,882 against 7,871). A service of no framework in the same
       harness (tower's `service_fn` answering the same JSON) counted 3,190 (3,568) in both builds,
       so the builds are comparable; a plain axum router, which shares no code with Corten either,
       counted 7,059 against 7,092 (8,073 against 8,106), axum's own code compiled differently
       beside a different Corten ([Choice 28](#choice-fixed-stages) has its profile). The
       differences of 2 to 24 are small and their cause is not separated: two builds of the
       harness moved the same Corten code by up to 8 ([Choice 28](#choice-fixed-stages)), less than
       some of them, and no profile was taken to tell layout from code. Wall times
       (in process, one CPU, jemalloc, seven runs of 200,000 requests alternating the builds, on
       Docker Desktop) differ by less than their runs do: an API request 2,626 ns against 2,683
       (runs 1,874 to 3,485), a page 3,748 against 3,963 (2,894 to 6,397) and an unstaged route
       1,077 against 1,119 (847 to 1,804).

       The body is two words: none for an empty one and one box for any other, the bytes of a whole
       one included. Held as bytes beside a box, four words where axum's body was two, it made a
       `Response<Body>` 144 bytes rather than 128, and every request moves one through the stages:
       `memcpy` was called 40 to 57 times a request rather than under once, and an API request cost
       13,393, its 404 12,416 and a page's 404 18,561 (jemalloc, five runs, every run the same, on
       an uncommitted variant built without feature `json`), 246 to 468 more than step 3 in the
       same runs (13,009, 12,170 and 18,093). With the body two words, `memcpy`'s cost on the API
       request is step 3's to the instruction (1,594,184 over the run), and a compile-time assertion
       keeps `Response<Body>` at 128 bytes or fewer. A JSON body read whole by `Json` under an API,
       now through Corten's reader, costs 409 fewer: a `POST` 14,165 against 14,574 (15,707 against
       15,969), and in wall time a median of 2,694 ns against 3,372, though the two builds' runs overlap (2,062
       to 2,930 against 2,249 to 3,728). A
       [`live`](guide/live-data.md) stream's events are Corten's writer's: one patch event with its
       id, read from the response's body, costs 2,161 instructions against axum's `Sse` 4,982
       (2,402 against 4,074), its buffer sized for the fragment up front; grown from empty, as
       axum's was, it cost 4,451 (3,461) in an earlier build of the harness. A feed's live event (a
       row written, its patch read from the stream) costs 28 to 36 more, 7,553 to 7,561 against
       7,525 (7,668 to 7,674 against 7,560 to 7,573, about 100 more): corten-feed's body
       (`FeedBody`, which names no Corten type) boxes its stream, and Corten boxes that body as it
       boxes any other, so each event passes one more `poll_frame` than axum's one box did, and a
       stream opens with one more allocation. Not taken out: one box needs a stream type Corten can
       box itself, which `FeedBody` cannot name (its stream holds an `async fn`'s future) without
       making the public `FeedBody` generic, for 0.5% of an event (1.5% with glibc).

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
    unmet `Handler<_, ()>` and named no argument. Until step 4, axum's features were only
    `http1` and `tokio` (and `json` with Corten's `json`): `original-uri` copied every request's
    URI for nothing to read (153 instructions a request at `fa597483`), `matched-path` named the
    route for axum's router, which Corten's now does itself (`corten::middleware::MatchedPath`), and
    `form`, `query`, `tracing` and `tower-log` serve readers Corten has its own of.

    Stands on: platform (RFC 9110 9.1: an origin server SHOULD answer `501` to a method it does
    not recognize or implement, and every server implements `GET` and `HEAD`; 15.5.6: `405` is
    for a method the server knows that the target resource does not support, and MUST carry
    `Allow`; 15.6.2: `501`, which requires no `Allow`; and 9.1 again, a method's name is
    case-sensitive; migration step 1); platform (hyper 1.12.0's HTTP/1 encoder writes
    `Content-Length` from the body's exact size for an answer without the header, to an
    HTTP/1.0 client too, and leaves it off a `1xx` and a `204`, as RFC 9110 8.6 requires, off a
    `304`, which 8.6 allows only its `200`'s, and, for an HTTP/1.1 client, off an answer with
    `Transfer-Encoding` (an HTTP/1.0 client, which reads no chunks, is sent the length and no
    `Transfer-Encoding`): read in its `proto/h1/role.rs`, and held on the wire by the dispatch
    suite's `HEAD` case and `tests::the_server_writes_an_answer_s_length_from_its_body`);
    measured (callgrind, release, glibc's allocator, in a Linux container on Docker Desktop,
    the lean catalog page of `bench/catalog` over one kept-alive connection, a run of 1,300
    requests less one of 300, three runs of each build with the builds taking turns: 44,134
    instructions a request with the router setting `Content-Length`, 44,121 to 44,143, and
    43,331 with the length left to the server, 43,289 to 43,333, with 22 calls to `malloc` a
    request with the router setting it against 20 without; and `perf stat` on the same two
    builds in the same container under `wrk` with 64 connections, the server on one CPU and
    the load on three others, ten rounds with the builds taking turns: 116,559 cycles a request
    at the median with the router setting it and 110,507 without, but the difference within a
    round was a median of 1,689 fewer, its quartiles 8,949 fewer and 1,157 more, lower in 6
    rounds of 10, so the cycles do not tell the builds apart and the count does; no script in
    the repository drives either run); bet (no app serves `corten::Router` by a server that
    leaves the length of a body of known size unsaid; nothing here has counted what serves
    Corten apps, and hyper's HTTP/1 server is the one Corten's own loop uses); platform, an accepted cost (migration step 1, the docs as
    read on 2026-11-13: a CloudWatch alarm on CloudFront's `5xxErrorRate` counts every `501`,
    since the metric has no dimension but `DistributionId` and `Region`
    ([Types of metrics for CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/programming-cloudwatch-metrics.html)),
    and Cloudflare's Origin Error Rate notification filters only by domain and sensitivity and its
    Advanced Error Rate notification by status code and IP address
    ([Platform Notifications](https://developers.cloudflare.com/notifications/notification-available/));
    Cloudflare's Monitors run a SQL query with filters by field
    ([Monitors](https://developers.cloudflare.com/notifications/monitors/)), but the pages read do
    not say whether `events.httpRequests`, the dataset their example queries, carries the method
    (a dataset's columns are listed by an authenticated introspection call,
    [Datasets](https://developers.cloudflare.com/analytics/sql-api/datasets/)), so a monitor by
    method is a built-in route not verified here; the method is in their access logs, CloudFront's `cs-method`
    ([Standard logging reference](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logs-reference.html))
    and Cloudflare Logpush's `ClientRequestMethod`
    ([HTTP requests](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/http_requests/)),
    so an operator who wants these out builds the alert from logs or from the app's metrics);
    platform, an accepted cost (migration step 1, the docs as read on 2026-11-13: a client that
    retries every 5xx by default retries the router's `501` where it did not retry the `405`:
    Polly's `HandleTransientHttpError` handles 408, any status of 500 or more and
    `HttpRequestException`
    ([HTTP client integrations](https://www.pollydocs.org/community/http-client-integrations.html)),
    as Polly.Extensions.Http's `HttpPolicyExtensions.HandleTransientHttpError` does
    ([README](https://github.com/App-vNext/Polly.Extensions.Http/blob/master/README.md)), and the
    retry strategy of Microsoft.Extensions.Http.Resilience, which its standard handler uses,
    handles 408, 429 and 500 and above by default
    ([HttpRetryStrategyOptions constructor](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.http.resilience.httpretrystrategyoptions.-ctor),
    [Build resilient HTTP apps](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience));
    each lets its caller say which answers to retry, and a retried `501` costs the client its
    retries' delay and the server a cold answer, not a different outcome);
    reasoned (migration step 1: with the request's method and status, as access logs and an app's metrics
    carry them, an operator can tell the router's `501` from the app's own, since the app's
    routes serve a short list of methods and a scanner's are outside it; RFC 9110
    sets no order among its errors, so the path is matched first and an unknown URL keeps the
    app's `404` page, which says more about a mistyped address than a `501`; and `OPTIONS` is
    always one the app implements because its caller asks what a resource allows, which the
    `405`'s `Allow` answers and a `501` would not); reasoned (the mark is checked against the
    `501` only when it is there, so the counts below hold for every request but that `501`,
    whose check is one comparison on a cold path); measured (callgrind, release, glibc's allocator, the run of 1,200
    requests less the run of 200 over 1,000 in process, three runs of each build alternating,
    every run within 2 of the others, on `8b02835d` and on it with migration step 1's `501` and its
    marker, in a harness outside the repository: a page route 17,403 instructions against
    17,585, the 182 fewer all in glibc's `_int_malloc` and `unlink_chunk` with every function of
    Corten's within 3; an unstaged route 7,023 against 7,022 and a page's `404` 21,991 against
    21,988; a `405` 6,557 against 6,529 at an unstaged route and 22,352 against 22,323 at a page,
    the 28 to 29 the method's second look costs; and `PROPFIND` as a `501` 6,978 against 6,623 as a
    `405` at the unstaged route and 22,906 against 22,425 at the page, the marker's extension
    map allocated on that cold path); measured (callgrind, release, three runs of each build with jemalloc and with
    glibc, every run the same but the feed's, step 4 at `5548c97a` against step 3 at `67e7f5f5`, built with
    feature `json`, in a harness outside the repository that answers the same JSON item by each
    request shape, the dispatch suite unchanged: a staged page 478 fewer, every other request
    within 24, a `POST` read by `Json` 14,165 against 14,574, a service of no framework 3,190 in
    both; a `live` stream of 1,200 fragments less one of 200, over 1,000, 2,161 instructions an
    event against 4,982; a feed's live event 7,553 to 7,561 against 7,525); measured (wall time,
    in process, one CPU, jemalloc, seven runs of 200,000 requests each alternating the builds on
    Docker Desktop, the same commits: medians within the runs' ranges for an API request, a page
    and an unstaged route, and a JSON `POST`, whose runs overlap too, 2,694 ns against 3,372); measured (callgrind,
    release, two runs, an earlier build of the live harness on the uncommitted tree: 4,451
    instructions an event with the buffer grown from empty); measured (callgrind, release, on an
    uncommitted variant with the body four words, without feature `json`, five runs with jemalloc and three with glibc, an API
    request 384 more, its 404 246 and a page's 404 468, against step 3's 13,009, 12,170 and
    18,093 in the same runs, with `memcpy` called 40 to 57 times a
    request); reasoned (LLVM copies a move of up to 128 bytes on x86-64 with inline stores and
    calls `memcpy` past it, and 144 is past it); measured (callgrind, release, five runs with
    jemalloc and three with glibc, every run the same, Corten's handler traits against axum's, step 3 at its commit against step 2 at
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
    HTTP/1.1, matchit 0.9.2 matches paths ([Choice 48](#choice-matchit)), and `http` 1 is the type hyper and its clients share);
    platform (rustc names the argument no request can fill for one impl per arity, where one impl
    over every axum `Handler` did not); reasoned (the dispatch suite reads only the wire, so it
    holds a router of Corten's to what axum does without naming either); measured (the partial
    HTTP/2 weighing at `1a8adcb5f`, driver correction `70e523f3b`, against `ecbef5eb`:
    three alternating differential callgrind runs per variant, 59 dependencies off and 67 on,
    eight direct-TLS tabs live in Chromium and Firefox, and a zero-window send resumed after
    500 ms with 100 ms configured, as [HTTP/2 evidence](../bench/http2/README.md) records);
    reasoned (the open-sibling header probe matches HTTP/1.1's busy-watch contract, while
    `watch.take()` in the prototype loses the return to idle); reasoned (hyper
    1.12.0 can finish the body while h2 0.4.20 still has queued data, so body polls and drop
    alone do not tell Corten that a stream made progress or completed); measured
    ([follow-up raw TLS cases](../bench/http2/README.md#follow-up-results), three rounds
    on the publish-age-checked lockfile, repeating every earlier pass and failure:
    h2's active count preserved the idle bound where Hyper's service count did not, and a
    byte-consumption watch preserved the send bound on these cases where body polls and drop
    alone did not; the passing candidates were tested separately, with
    [Callgrind medians](../bench/http2/README.md#follow-up-cost) off to on of 25,940 to 26,721
    instructions per page for the direct h2 count and 5,043 to 5,696 per event for buffer
    tracking); measured ([combined probe](../bench/http2/README.md#combined-results) at
    `a8431b062`, three rounds at 100 ms in one Linux container with the paused reader's
    receive buffer capped at 128 KiB: all 17 combined cases passed, every stall closed in
    105.6 to 116.4 ms and the socket watch expired 154 to 165 ms after its request; uncapped,
    two of six rounds missed only the socket case, one with no socket timeout reported
    within the 500 ms window and one with no socket timeout at all, and a sampled uncapped
    run's receive buffer grew to 632,943 bytes (about 618 KiB) with the watch firing after a
    103 ms wait, 514 ms after the request; Callgrind medians off to on of 26,142 to 27,939
    instructions per page and 4,179 to 5,115 per event, three rounds each, not against
    HTTP/1.1); measured ([steady reader control](../bench/http2/README.md#steady-reader-control)
    at `ec476a9f6`, seven rounds of the combined suite at 100 ms with the cap: the 17 earlier
    cases passed every time, but a client reading at least 16 KiB every 20 ms received the
    whole answer in six rounds and was closed in one by the socket watch on a `flush` pending
    for 100 ms, a false close, so the combined evidence does not yet include a socket watch
    that leaves steady readers open; a TLS flush pending while records drain and a capped
    receive window reopening only in large steps both fit, each reasoned, not measured on the
    probe; the first has since been measured on shipping HTTP/1.1 over tokio-rustls, which cut
    such a reader until the send timeout's wait started over at each report of room, and a
    slower reader that takes its bytes in bursts is still cut at a 2-second timeout
    (Protocol, item 2 above));
    value (fast and proven fast, Value 1; small surface, deliberate dependencies, Value 6; correctness before speed,
    which is why the dispatch suite comes first and an opt-in protocol must not silently
    weaken a security bound even though the no-proxy live app already fails).

    Revisit when: a router of Corten's cannot pass the dispatch suite without changing a case
    (other than the deliberate `501` and empty-segment changes migration step 1 records), or
    counts more than axum's on any request measured in step 2 (that step then waits, and this
    Choice says why); a `Response<Body>` grows past 128 bytes (step 4); Corten's own
    server sends an answer by anything but hyper's HTTP/1 encoder (hyper's HTTP/2 server sets
    `Content-Length` only for a body with bytes to send), or that encoder stops writing the
    length from the body's size, which `tests::the_server_writes_an_answer_s_length_from_its_body`
    fails on: the router then sets it again, or that sender is shown not to need it (a `Router`
    an app serves by another library's server is that server's to write a length for,
    [the app guide](guide/app.md)); for HTTP/2, an upstream
    active-stream count exposed through Hyper reopens the idle design, and a per-stream send-wait
    signal covering queued data after the body ends reopens the send design. The
    [isolated controls](../bench/http2/README.md#follow-up-acceptance) qualify each detector
    with the other disabled. The probe's combined mode held both bounds with the socket watch
    under the 17 original [combined controls](../bench/http2/README.md#combined-results) in
    every round, but the steady reader control failed 1 of 7 rounds, so that evidence is not
    complete; the full combined suite, steady reader included, passing 10 consecutive rounds
    with zero failures stays in
    [#1686 HTTP/2 in corten::serve: show the idle and send bounds together with the socket watch on one opt-in path](https://github.com/corten-run/corten/issues/1686).
    Reopen the proxy decision when an opt-in path in `serve` passes that suite to the same
    bar and the shipping checks below
    ([#1739 HTTP/2 in corten::serve: an opt-in path that passes the combined bounds suite and the shipping checks](https://github.com/corten-run/corten/issues/1739)).
    A combined case failing on a rerun reopens the combined evidence in Stands on, not the
    proxy decision. An upstream header-block timeout
    ([hyperium/h2 #928 Proposal: enable an HTTP/2 header-block read timeout](https://github.com/hyperium/h2/issues/928))
    reopens the header half only. The historical open-sibling case is a control, not a demand
    for a stronger header guarantee. Shipping still needs shutdown with open streams,
    reset-flood and resource checks, decoded head limits, explicit h2 Upgrade refusal and
    HTTP/1 WebSocket fallback, full three-engine TLS smoke, and the enabled path's cost
    against HTTP/1.1.
    HTTP/3 also waits for a stable `h3` and a need beyond this cap. A new protocol stays below
    the vocabulary in 3 and leaves 4 to 7 as they are.
    The `501` itself (migration step 1) is reopened when a named client or tool is reported
    failing on these `501`s where it handled the `405`, in a way no documented setting of it
    avoids. A retry policy that retries every 5xx and a 5xx alarm that cannot filter by method
    are known and accepted (Stands on): the one can be told which answers to retry and the other
    replaced by an alert built from access logs, so neither alone reopens it.

    Last checked: 2026-11-05, the split by crate on `b79a6b23`, recorded at `0154ac63`; 2026-11-06,
    the `original-uri` runs on `fa597483`; 2026-11-06, rustc 1.99.1's error for an argument no
    request fills, held by `crates/corten/tests/handler_message.rs` at `84d33d0b`; 2026-11-08,
    the prototype's runs (`prototypes/pipeline/results/round4.tsv` and `round4-socket.tsv`),
    the prototype at `7cea4970`; 2026-11-09, the `route_layer` runs, on an uncommitted variant of
    `3452790a` with the host check and the API's JSON in a `route_layer`; 2026-11-09, the
    dispatch suite on axum 0.8.9, hyper 1.12.0 and matchit 0.8.4, at `599c302a`; 2026-11-09,
    Corten's router against axum's, at `373a10f9`, with the suite unchanged; 2026-11-09, the
    stages as combinators on Corten's router, on the uncommitted variant of `8ddeaea2`, and the
    unstaged route's lane, at `bfa20380`, with the suite unchanged; 2026-11-10, Corten's handler
    traits (step 3) at `6d78a069` against step 2 at `7bba1e2b`, with the suite unchanged;
    2026-11-10, axum gone (step 4) at `5548c97a` against step 3 at `67e7f5f5`, with the suite
    unchanged; 2026-11-09, the lane boxed
    as a second future and held by the router's future, uncommitted variants of `8ddeaea2`, and
    the `laned` variant of `fa0b1525`; 2026-11-12, the dispatch suite with its one case changed
    for RFC 9110 9.1 (the `501`), on `794e6c7f` and on it with that change; 2026-11-13, RFC 9110 9.1, 15.5.6 and 15.6.2 as Stands on cites
    them, and the seven requests Stands on counts for the `501`, on `8b02835d` and on it with
    the `501` and its marker; 2026-11-13, CloudFront's and Cloudflare's metric, alert and log
    pages as Stands on cites them, read for migration step 1 with main at `c3d455a1`; 2026-11-13,
    Polly's, Polly.Extensions.Http's and Microsoft.Extensions.Http.Resilience's retry defaults and
    Cloudflare's Monitors and SQL API datasets pages as Stands on cites them, read for migration
    step 1 with main at `f12d3daa`; 2026-11-13, hyper
    1.12.0, hyper-util 0.1.21 and h2 0.4.20, prototype `1a8adcb5f` and driver `70e523f3b`
    against `ecbef5eb`, with the corrected watch semantics read in `watch.rs` and `app.rs`,
    and the untried connection-level alternative distinguished from the measured send stall;
    2026-11-13, matchit 0.9.2's matching and insertion source read and the dispatch suite's
    17 tests passed with empty parameters refused ([Choice 48](#choice-matchit)); 2026-11-14,
    the same dispatch suite passed in the merged workspace's full debug tests at `66cb2936e`;
    2026-11-18, the deployment guide's rows counted again at `83da31ef1`, with its thirteenth
    (what a proxy passes on for a page's tag and its `304`): ten are proxy-specific;
    2026-11-18, hyper 1.12.0's send loop and h2 0.4.20's active count and send queue read
    against Corten's `Answered` at `e927c2463`, then exercised in the
    [standalone TLS probe](../bench/http2/README.md#follow-up-results); 2026-11-19,
    the same probe rerun with bytes 1.12.1 and smallvec 1.16.5 in its lockfile, three wire
    and Callgrind rounds per mode; 2026-11-19, hyper 1.12.0's HTTP/1 encoder read for the
    `Content-Length` it writes, each answer the socket test asks for seen on the wire before
    and after, and the lean catalog page counted under callgrind and under `perf stat` with
    rustc 1.99.1, on `0aef5330c` and on it with the router leaving the length to the server;
    2026-11-20, the probe's combined mode at `a8431b062`
    with getrandom 0.4.3 and r-efi 6.0.0 in its lockfile, three wire and Callgrind rounds,
    and one round of each isolated mode with the same dispositions; 2026-11-20, the steady
    reader control at `ec476a9f6` on the same probe build, seven rounds with one false close;
    2026-11-20, the send timeout over tokio-rustls 0.26.6 through `serve_wrapped` against plain
    HTTP, steady readers at three rates, before the wait started over on each report of room
    (five rounds each at `4bf5b1e78`, and three of the 2-second case at `efdb1df36`, whose
    crates are the same) and after (five rounds each at `ee411b38e`), recorded at the commit
    that adds this entry, and the gaps between the socket's reports of room traced in two of
    the 2-second case's rounds each, plain and TLS, at `ee411b38e`; 2026-11-20, the 2-second
    case at `5596df8b5` with the reading pattern varied, five rounds each: even 2 KiB reads
    every 125 ms from the socket over TLS and plain kept, tokio-rustls cut, 16 KiB a second
    over plain cut, `curl --limit-rate 16K` (7.88.1) over plain and TLS cut.

26. <a id="choice-derived-deserialize"></a>**`#[derive(Fields)]`, `#[derive(UrlValue)]` and `#[derive(FromJson)]`
    write serde's `Deserialize` themselves, as serde's derive writes it.** Each already reads a
    type's `#[serde(..)]` attributes to name a form's keys, a URL's words or a JSON reply's fields,
    so with serde's derive beside it the attributes had two readers and a type derived two things
    for one meaning. The impl follows serde_derive's for the attributes these types use (names,
    aliases, defaults, `skip`, `other`, `deny_unknown_fields`, `borrow`, `bound`, `expecting`,
    `transparent`, and the bounds serde infers) and the shapes `FromJson` reads (named, tuple,
    newtype and unit structs, enums of unit variants), and refuses at compile time one that reads
    the type another way (`flatten`, `with`, `from`, `tag` and the like), whose field takes a type
    of its own. For `FromJson` this also means its reader and the `Deserialize` it falls back to
    come from one reading of the attributes. A type whose `Deserialize` is written by hand, or by
    serde for an attribute `FromJson` refuses, is made a `FromJson` with an empty impl, which
    serde_json reads through that `Deserialize`: the derive never guesses at another impl, and
    serde's derive beside it is a second impl (E0119). Since `Fields` and `UrlValue` write the
    `Deserialize` `FromJson` would, they write its `FromJson` and schema too (features `json` and
    `types`), so a form's input is read from JSON and is an agent tool's input with no derive beside
    theirs, and `FromJson` beside them is a second impl as well. A generic `Fields` or `UrlValue`
    type's `FromJson` is the trait's own body, which hands the text to serde_json, under
    `Self: DeserializeOwned` (a generic `#[derive(FromJson)]` keeps Corten's reader): the bounds
    serde infers for its `Deserialize` (`T: Default` for a defaulted `T`, a bound on `T::Assoc`) are
    not one per parameter, and a reader written against them would have to repeat each. So a generic
    form or URL-value type is read by serde_json, a value nested in another twice (the reader finds
    its text, serde_json reads it), with no way back to the reader: `FromJson` beside `Fields` and
    an empty impl are both a second impl. An enum with `#[serde(other)]` is read by the reader up to
    a word it does not know, where it gives up on the whole text and serde_json reads it again, and
    is described as any string. One whose `Deserialize` borrows from its input cannot be a
    `FromJson`, which reads owned values. Not chosen: depending on serde_derive from
    `corten-macros`, which builds on `proc_macro` alone, or keeping the second derive, which a
    derive cannot add to the item it reads
    ([#763 Corten's form, route and JSON readers still require serde's Deserialize beside their own derives, and FromJson allocates every string it reads from an upstream body](https://github.com/corten-run/corten/issues/763),
    [#1042 Let FromJson generate its required Deserialize implementation](https://github.com/corten-run/corten/issues/1042)).

    Stands on: platform (serde_derive 1.0.229's impl and bound inference, which
    `crates/corten/tests/derived_deserialize.rs` holds this one to by reading each of its types
    twice, with this derive and with serde's, and comparing values, errors and the names passed to
    the deserializer; and rustc reporting a cycle error (E0391) naming `SHAPE` when a `Fields`
    type's rows reach that type through a path or another type, which is all that refuses such rows at compile
    time, so the reader never follows keys deeper than the types go; the `compile_fail,E0391`
    doctests in `crates/corten/src/form.rs` hold it); measured (reading a seven-field form costs
    9,241 instructions before, on `62eb57f7`, and after, on `8cd5934e`: callgrind, release build,
    1,200 reads less 200 over 1,000, three runs each,
    `form::de::tests::what_reading_a_form_costs`; reading the item benchmark's 500
    API responses costs 265,550,044 instructions through `FromJson` and 438,766,522 through
    serde_json alone, before, on `c65c10ec` with serde's derive, and after, on `a791d9ba` with this
    one and again on `58b8c2f8`: callgrind, release build, `read_cost` in `examples/card-market`,
    two runs each; a generic `Fields` or `UrlValue` type's read through serde_json, and an
    `#[serde(other)]` enum's second read, are not measured); reasoned (`corten-macros` keeps no
    dependencies); value (one way to do each thing and a small surface, Values 5 and 6).

    Revisit when: a serde release changes what its derive writes for these attributes, which the
    twin tests would show; or apps need an attribute this refuses often enough that a type of their
    own is the second way; or generic `Fields` or `UrlValue` types, or `#[serde(other)]` enums, are
    common enough that their serde_json read shows in a measured page or API, which would ask for a
    reader that repeats serde's inferred bounds or reads past a word it does not know; or rustc stops
    reporting that `SHAPE` cycle, or those doctests stop failing on a new toolchain, which would ask
    for another refusal of rows that reach their own type, or a depth the reader keeps to.

    Last checked: 2026-11-06, the form read at `8cd5934e`; 2026-11-08, the JSON read for `FromJson`
    at `a791d9ba` and `58b8c2f8`; 2026-11-09, serde_derive 1.0.229 at `b44bd54b` (the twin tests, on
    the branch merged onto the integration tip); 2026-11-12, one reading for `FromJson`'s reader and
    `Deserialize`, with the `transparent` twins `Phantom` (beside a `PhantomData`) and `Named`
    (beside a defaulted field), on the branch from `24062789`; 2026-11-13, serde_derive 1.0.229's
    `allow_transparent` (a path type whose last segment is `PhantomData`), with the twins `Count`
    (a tuple), `Scored` (a `default = "path"` field), `Wrapped<T>` and `Qualified`
    (`<u8 as Marked>::PhantomData`), on the branch merged with `b7916d9e`; 2026-11-14, the form read
    again at `4674d1d3` and with rows in rows at `16525bc5`: 9,222 instructions a read in both
    (callgrind, release build, 1,200 reads less 200 over 1,000, three runs each, all six within 174
    instructions of each other over the 1,000 reads); 2026-11-15, rustc's E0391 for rows that reach
    their own type through another type and through `Rule<u8>`, the `compile_fail,E0391` doctests at
    `1e0bcd58`; 2026-11-16, rustc's E0391 naming `SHAPE` for a row written as `self::Step`, after
    preserving path punctuation, the `compile_fail,E0391` doctest at `4f83d633` (focused form
    doctests with `--show-output`, 61 passed, one ignored); 2026-11-17, serde_derive 1.0.229's
    `check_transparent` and `check_from_and_try_from` against the `FromJson` compile errors in
    `crates/corten/src/json.rs`; 2026-11-18, serde_derive 1.0.229's conversion argument diagnostics
    against the compile errors in `crates/corten/tests/handler_message.rs`.

27. <a id="choice-caller-types"></a>**Who may use a route is in its handler's type, and every route reaches the app through
    the checks that read it.** A handler takes `Caller<T>`, whose `Identify` finds the caller or
    refuses (sign in, 401, 403, 503), and a routes module's `caller = T` holds every handler in it
    to that at compile time, so a route added later is covered. The lookup runs only when a handler
    or middleware reads it, once per request, and reading it makes the answer private. A 401 from
    `Refused::unauthorized` carries the app's `Challenge` in `WWW-Authenticate`, which RFC 9110
    (15.5.2) requires on every 401, so its constructor takes one and no `unauthorized` leaves it
    out: `Challenge::bearer(realm)` (RFC 6750 (3) has a parameter follow the scheme, and a realm
    is the one every Bearer API has) and `Challenge::basic(realm)` (RFC 7617 requires the realm),
    or a scheme in a `const` of the app's, checked when the program compiles as a token that is
    neither `Bearer` nor `Basic` (a `Challenge::new` outside a `const` is checked as it runs),
    with parameters always sent as quoted strings and checked when the challenge is made (a
    challenge is built where the request is refused, so a mistake in a literal shows on the first
    refused request, which an app's tests send; [Rule 8](#rule-compile-errors) gives way here
    because Corten has no startup point for an app's challenges, and a `const` form would be a
    second way to write one: an app whose realm comes from configuration builds its `Challenge`
    once at startup and clones it, which fails at startup). The MCP endpoint builds its own from
    its origin and scopes when it is mounted, and without an `Authorization` names itself as the
    realm, or `mcp` when its name, which is also its `serverInfo` and may be any text, is empty
    or not printable ASCII. It takes `Bearer` with no token after it as no token, so the client is
    told where to get one (RFC 6750 2.1 does not allow an empty token, and 3.1 would let it be
    `invalid_request`; with an `Authorization`, a check that wants that 400 returns
    `ToolError::Invalid`, and without one a check's `Invalid` is the tool call's result). A 401
    sends one challenge, with parameters and no token68 (`Negotiate <data>`); a client offered two
    schemes at once (RFC 9110 11.6.1 allows a list) is not one an app has needed.
    Of the 401s `Refused` makes, `sign_in`'s to a data client is the one that falls short of
    RFC 9110: it carries no challenge, since a session cookie has no HTTP authentication scheme
    to name ([Limit 11](#limit-caller-types); a 401 an app writes by hand, `Error::status`, is
    its own). A key sent in a header of the app's own (`X-Api-Key`) has no scheme either, so an
    API that keeps one for clients that already send it also takes the key as a bearer token and
    challenges `Bearer`. Corten reads the credentials it tells every API to take, with
    `caller::bearer` (the scheme in any case, RFC 9110 11.1; an empty token, a value outside
    visible ASCII or two `Authorization` lines, which RFC 9110 5.3 does not let a client send,
    none), so no app parses `Authorization` by hand; the MCP endpoint's check reads the token with
    it, and the endpoint's 401 names a token invalid whenever the request used the bearer method
    (an `Authorization` line that is `Bearer` and something other than whitespace), readable or
    not, since RFC 6750 3.1 leaves the error out only for a request without bearer credentials.
    Not chosen for the type: `unauthorized()` sending `Bearer` by default, which would have
    kept every caller compiling but named a scheme for an app that takes another; a `BEARER`
    constant with no parameter, which RFC 6750 (3) does not allow; a method per RFC 6750 error
    code (`.invalid_token()`), which would tie a type every scheme uses to one scheme's three
    codes, each a literal the app's tests send; a raw
    `HeaderValue`, which checks neither the scheme nor the quoting; and a `&'static str` scheme
    with no parameters, which cannot say `error="invalid_token"` (RFC 6750 3.1). Not chosen for
    `sign_in`: a scheme of Corten's own (`Cookie`), which no client reads and which
    [Rule 10](#rule-standard-formats) would hold to a reason it lacks; `Basic`, which a browser
    answers with its own prompt for a password the app never asked for; a 403 in its place (as
    Django REST framework answers a session API), which tells a client that its credentials were
    refused when it sent none, so a native app cannot tell "sign in" from "not allowed"; nor a
    challenge `sign_in` would carry, a second way to say what `unauthorized` says for a client
    that sends a token, which a lookup that takes both should refuse with `unauthorized` when the
    request sent a wrong one. A route's
    answer type says how it fails (`HtmlResult`: the error page; `JsonResult<T>`: JSON) and
    whether a shared cache may keep it (`Public<..>`, whose handler may only take `Anonymous`
    inputs and whose page cannot set a cookie). A route that says `no_store` is checked as
    answering `NoStore<..>` of its handler's type (`no_store(post)`: only the handlers of the
    methods it names), so that one word in the route, not the handler's signature, says nothing
    may keep it; a handler there that returns `NoStore<..>` too says it twice, and a hand-added
    route says it with `NoStore<..>`. Every route reaches the app through these checks: `App::new`
    takes the `Routes` a `#[corten::routes]` module makes, and `Area::route` and `Api::route` take
    `Methods`, made by Corten's `get`, `post` and the others, which check the same things. Nothing
    else (another framework's router, a tower service) fits any of them, so no route given to the `App` is
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
    handler reads anyway); bet (a challenge's realm and error code are literals, or configuration
    an app builds one `Challenge` from at startup, so checking them when a challenge is made finds
    a mistake in the first test that refuses a request or when the app starts, and a value from a
    store or a request is the app's to clean); platform (RFC 9110 15.5.2: a 401 MUST send
    `WWW-Authenticate`; RFC 6750 (3) for Bearer's parameters and (2.1) for the credentials
    `caller::bearer` reads, with the scheme in any case (RFC 9110 11.1) and one `Authorization`
    line (RFC 9110 5.3); RFC 7617 (2) for Basic's realm;
    IANA's HTTP Authentication Scheme Registry, which has no scheme for a session cookie); measured
    (refusing a second `Authorization` line costs `caller::bearer` 17 instructions a call, 466
    against 449 for reading the first alone, by callgrind over 1,200 and 200 calls in a scratch
    harness, three runs that gave the same counts); value
    (mistakes fail at compile time, Value 4: a
    route's caller, and a challenge's scheme in a `const`; a challenge's realm and parameters are
    the bet above).

    Revisit when: an app needs an access rule a type cannot name and a handler cannot check
    without repeating it in every handler of a module; or a way to give the `App` a route is
    found that does not pass `Routes` or `Methods`; or an HTTP authentication scheme for a
    session cookie is registered, which `Refused::sign_in`'s 401 would then name; or an app needs
    two challenges on one 401, or a token68 one; or an app needs to tell unreadable bearer
    credentials (a value outside visible ASCII, two `Authorization` lines) from none, which
    `caller::bearer` answers alike.

    Last checked: 2026-11-06, the `compile_fail` doctests that hold `caller = T`
    (`crates/corten/src/route.rs`) and the caller's own (`crates/corten/src/caller.rs`) at
    `bcd31ffe`; 2026-11-09, the `unstaged` `compile_fail` doctests in
    `crates/corten/src/route.rs` (a stage's input, a header reader, a body reader, a
    `caller = T` module, a path that reaches Corten's own, a method other than `get`,
    `prefetch`, `/health/live`, `/{*rest}`), at `f703d3f8`; 2026-11-10, IANA's HTTP
    Authentication Scheme Registry (no scheme for a session cookie) and the tests that a 401
    keeps its challenge as JSON and on the error page ([`tests/caller.rs`](../crates/corten/src/tests/caller.rs)), at
    `96e2c907`, the commit that adds them; 2026-11-10, the tests that a handler's own 401, the
    page swapped in and a middleware's refusal keep it, at `2d6b88d0`; 2026-11-10, those tests
    with a realm on every Bearer challenge and Basic through a handler and a middleware, the
    MCP endpoint's realm and 400 challenge (`crates/corten/src/agent.rs`), and the
    `compile_fail` doctest that holds `Challenge::new("bearer")` out, at `075bda73`; 2026-11-10,
    the tests of the MCP endpoint's `mcp` realm, of a scheme `Challenge::new` makes in a `const`,
    and of card-market's empty bearer token, at `7d743d7a`; 2026-11-10, the MCP endpoint's test
    of `Bearer` alone or with only whitespace after it, and card-market's agents with a lowercase
    scheme and its partners' empty key, at `ea4aff53`; 2026-11-11, the test of `caller::bearer`'s
    credentials (`crates/corten/src/caller.rs`: the scheme in any case, two spaces, `Bearer` alone
    or with whitespace, `Basic`, a value outside visible ASCII), at `751e26bb`, the commit that
    adds it; 2026-11-11, the reader's test of two `Authorization` lines, the MCP endpoint's test
    that a token outside visible ASCII is named invalid (`crates/corten/src/agent.rs`), and the
    callgrind count of the reader, at `de945242`, the commit that adds them; 2026-11-11, the MCP
    endpoint's test that a bearer token on either of two `Authorization` lines is named invalid, at
    `e4d024b0`, the commit that adds it.

28. <a id="choice-fixed-stages"></a>**A request goes through fixed stages in one order, and the app's own steps are one
    `Middleware` tuple at one place in it; a route may say it goes through none.** The stages are
    `corten::middleware`'s; the app's steps are resolved at compile time. The page tag stage
    can skip the hash for a `GET`, but not for an otherwise taggable `HEAD`: without its
    validator, a cache could freshen an older page of the same length ([Limit 21](#limit-etag)).
    The stage future holds the request once. Each stage moves its handle to the next, and
    dispatch consumes it to give the request to the first middleware or, when there is none,
    the route. The compiler rejects a stage that reads it after hand-off. The late layout poller
    lives in the existing late-write box, so it neither enlarges the ordinary future nor adds
    a box to a late-eligible write.
    The stages read the incoming request's mode, credentials, validators, and the host and
    origin headers they need before dispatch. The error page and cache rule share those reads.
    `Req` negotiates from the headers where it is taken: middleware and earlier extractors can
    change them ([Choice 21](#choice-own-extractors)). Keeping those two views separate is what
    lets a handler see an edit without letting it change the outer cache or same-origin decision.
    `MatchedPath` and `Signal` remain independently available in the request's extensions;
    the nonce slot is independent of either. The debug-only form redirect check is held by the
    stages, not put in the request's extensions.
    An area's or an API's own steps (`Area::middleware`, `Api::middleware`) run right after the
    app's, for the requests at its prefix; they are boxed, since which run depends on the route, and
    an app with none pays nothing for them. What an area or API sets (its deadline, body limit, policy and middleware,
    with those of the areas and APIs around it) is resolved once for each when the router is
    built and given to each of its routes, so a request reads it from the route it matched; only
    an unknown URL, whose `404` belongs to the prefix it is under, and a route that can match a
    path under another prefix, an area's, an API's or one of Corten's own (`/corten/`, the
    assets'), look it up by the request's path, a scan of those prefixes. Which routes can is
    counted segment by segment when the router is built (`api::can_match_under`), as matchit
    0.9.2 matches: a parameter takes at least one byte of its segment after any text before it,
    a catch-all the nonempty rest of the path, and a prefix of Corten's own holds only paths with
    a segment after it. So a page's `/{*rest}` looks up by path, as does `/{slug}` beside an area
    at `/shop` (it matches `/shop`) and `/shop/{id}` beside one at `/shop/desk`, while `/{slug}`
    in an app with no areas, or beside `/shop/desk` alone, has its scope. The count reads each
    route alone, so it may send by path one whose paths under another prefix a static route beside
    it always answers first (`/{slug}` beside an area's route at `/shop`); it never gives a route
    a scope when one of its paths is under another prefix. A route that says `unstaged` where it
    is declared, in the app's routes
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
    router's `405` and `501` and a segment without its suffix among them, so an API's clients still read
    every failure under its prefix as JSON; only a failure boxes anything for that. A tower layer
    around those routes alone (axum's `route_layer`) was built first and measured at 751
    instructions a request more than the same checks in the handler (jemalloc), since axum boxes a
    layered route again and clones that box on each request; the lane costs 71 to 86 more than
    the same checks in the handler (about 1%, which wall times did not show), taken for one place
    that says what goes around a route: the router holds the app's stages or the route's lane for
    each path, and its own `404`, `405` and `501` meet the lane as the handler's answer does, with no
    handler of their own. In that build the unstaged route retired fewer instructions than
    axum's plain router and stayed inside the instruction bound below, which is what this Choice
    holds it to. That count does not show that it ran faster
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
    Nor presets or flags that keep some stages and drop others, each another path to
    read and test. The lean catalog page met the old Revisit-when in letter: it needed the host
    check and the document's headers, but not a tag or a cache rule that looks for a caller's
    credentials. Nearly all the cost of the work it did not need was the tag. The tag is now
    decided from the request
    ([#1661 Skip unsolicited page ETags without a coding in lean builds](https://github.com/corten-run/corten/pull/1661),
    [Limit 21](#limit-etag)): the measured request, a `GET` with `Accept-Encoding: identity` and no
    `If-None-Match`, pays no hash, with nothing new for an app to declare. A qualifying coding or an `If-None-Match`
    only lets an otherwise eligible `GET` receive a generated tag ([Limit 21](#limit-etag) says which codings
    qualify in each build); the rule reads the request's headers, not whether the client keeps pages. The stages
    hold the request once
    ([#1674 Shrink the boxed future for staged requests](https://github.com/corten-run/corten/pull/1674)).
    An HTML answer never goes without security headers: a staged page keeps its document
    headers, and an unstaged one still gets its sandbox. About 3,500 cycles a request (3% on
    this page) is no reason to take the document headers away. No flag has a measured case.
    Where the declaration shows an answer cannot use a group, leave out that work case by case,
    each in its own change with its own measured cost. `unstaged` is no stage at all, which
    listings-feed's sequence route uses; its lane chooses nothing, only the checks no route goes
    without, the same for every unstaged route ([Choice 25](#choice-axum-router), step 2).
    Nor the stages rewritten as combinators, measured
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
    in an API's module. Step 4 ([Choice 25](#choice-axum-router)) leaves it at 7,030 and 7,076 at `5548c97a`
    (7,834 and 7,882 with glibc), against 7,019 and 7,065 for step 3 in the same harness (7,823
    and 7,871). The plain axum router stopped being a control at that step: the same source with
    the same features counted 7,059 against 7,092 (8,073 against 8,106 with glibc), since in step
    3's build its header array's `into_response_parts` was a call (272 instructions a request)
    and collecting its body another (354), and in step 4's both are inlined: it moved with how
    axum's code compiled beside a different Corten. From step 4 the control is a service of no
    framework (tower's `service_fn` reading the id from the path and answering the same JSON),
    which shares no code with Corten or axum: it counted 3,190 in both builds (3,568 with glibc),
    so the builds do not differ. The unstaged route's 11 more is measured, and whether it is the
    route's own code or how the build laid it out is not separated (two builds of the harness
    moved the same Corten code by up to 8); either way it counts against the bound: 7,030 is 98 over 6,932 and
    7,076 is 94 over 6,982 (jemalloc), so the next change that adds to an unstaged route reopens
    this.

    The instruction bounds below bound work on the measured routes, not speed. For a change
    to the request path, also measure cycles under load as
    [CONTRIBUTING](../CONTRIBUTING.md#pull-requests) describes.

    Stands on: measured (callgrind, release, five runs each, on a bench binary that is not in the
    repository, against main `9200aae4`: a request in an area with a pass-through middleware,
    one boxed future, 21,374 to 21,511 instructions against 20,497 to 20,646 with none; a request
    outside that area 19,909 to 19,913 against 19,706, which was then a scan of the areas'
    prefixes on every request and since
    [#1213 The stages find a request's area by its path in six prefix tables after the router has already matched its route](https://github.com/corten-run/corten/issues/1213)
    is paid only where the route can match under one (measured below); an app whose areas and
    APIs have none runs Corten's own code within 18 instructions of before, while its whole
    request rose from 19,696
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
    plain axum router in the same build); measured (callgrind, release, jemalloc, five runs each
    alternating with main `31de4268`, a request counted as the run of 1,200 less the run of 200
    over 1,000 by `tests::what_a_request_in_an_area_costs`, median and range: each route given
    its scope at `f7d33ce2` against six prefix lookups a request, in an app with two areas (one
    inside the other) and an API that each set a deadline, a body limit and a middleware, a page
    in the inner area 23,733 (23,733 to 23,733) against 24,061 (24,061 to 24,061) and the API's
    JSON 13,647 (13,647 to 13,648) against 13,870 (13,870 to 13,870), and in an app with none,
    where both are the app's own routes, the same page 18,261 (18,261 to 18,261) against 18,399
    (18,397 to 18,399) and the same JSON handler 12,957 (12,957 to 12,957) against 13,095 (13,095
    to 13,095)); measured (callgrind, release, jemalloc, three runs each, both apps in one build at
    `6ffc316f`, which shares one set of stages among each scope's routes, the same harness: the
    page in the inner area 23,732.9 (23,731.5 to 23,732.9) against 18,261.3 (18,259.9 to
    18,261.3) as an app route, 5,471.6 more (5,470.2 to 5,473.0), and the API's JSON 13,647.3
    (13,647.1 to 13,647.4) against 12,956.9 (12,956.9 to 12,957.0) for the same handler as an app
    route, 690.3 more (690.2 to 690.5)); measured (callgrind, release, jemalloc, three runs each,
    the routes counted by segment at `084db982` against `416882fa`, the same harness with its
    `slug`, `routed` and `rest` targets: a page at `/{slug}` in the app with no areas 18,406.4
    (18,406.4 to 18,407.8) against 18,520.7 (18,520.7 to 18,520.8), 114.4 fewer, now 145.4 over
    the same page at a fixed route, 18,261.0; in the app with areas, where `/{slug}` can match
    `/shop` and still looks its scope up by path, 18,740.7 against 18,740.8; and there a page an
    app `/{*rest}` answers outside every area 19,236.7 (19,236.6 to 19,238.3) against 18,569.8
    (18,569.7 to 18,569.8) at `/elsewhere/item`, 667.0 more in both builds; every other target
    within 0.1 of before); measured (callgrind, release, five runs each, the same
    handler through its lane at `bfa20380`: 7,003 with jemalloc in every run and 7,068 in an
    API's module, against 6,932 and 6,982 with its checks in its handler at `8ddeaea2`, and 7,085
    for a plain axum router in both builds; 7,812 and 7,879 with glibc, three runs, against 7,745
    and 7,797, and 8,099 for a plain axum router in both); reasoned (every route the router holds
    has whole-segment parameters, which is what keeps the segment count independent of matchit's
    version: `#[derive(Route)]`'s `parse_path` refuses text before a parameter, an area's and an
    API's routes are held to `route::route_shaped` when the app compiles, and text after a
    parameter is stripped before the router holds the path (`suffixed`); a `Route` written by hand
    and given to the hidden `Routes::__route` can put text before one, and the count follows
    matchit 0.9.2 for that too; such a route can also meet 0.9.2's order-dependent conflict,
    a known limit [Choice 48](#choice-matchit) records); platform (matchit 0.9.2, exactly pinned by
    [Choice 48](#choice-matchit), read in `tree.rs`: a parameter takes at least one byte after
    any text before it and before any suffix, a segment holds one parameter, and a catch-all
    takes the nonempty rest of the path. Corten still strips suffixes before insertion, so
    0.9's tightened prefix/suffix conflicts do not change the shapes its macros insert.
    `Router::new` still reports every insertion error with the rejected path and matchit's
    conflicting route. The count now refuses empty parameter values, including a hand-written
    `/corten{x}/{b}` against `/corten/`. It is not exact: a static route beside a route may
    answer first the paths it counts. `tests::url::can_match_under_never_says_no_where_matchit_matches`
    checks the count against 0.9.2 and requires every tested route to insert); measured (callgrind,
    release, three runs each, every run the same, an uncommitted variant of `fa0b1525` whose
    `laned` adds the headers as it takes the handler's answer: 7,022
    and 7,083 against 7,003 and 7,068); measured (callgrind, release, three runs each with
    jemalloc and with glibc, every run the same, step 4 at `5548c97a` against step 3 at
    `67e7f5f5`, in the harness with the control (the same numbers on the uncommitted tree before
    review): an unstaged route 7,030 against 7,019 and
    7,076 in an API's module against 7,065, a `service_fn` with no framework 3,190 in both, a
    plain axum router 7,059 against 7,092; with glibc 7,834 against 7,823, 7,882 against 7,871,
    3,568 in both, and 8,073 against 8,106; the harness built before the control, two runs each:
    7,022 against 7,012 and 7,073 against 7,063); measured (callgrind, release, three runs each, the stages written as combinators
    on Corten's router, an uncommitted variant of `8ddeaea2`: 92 to 367 instructions more a
    staged request with jemalloc and 16 to 298 with glibc); measured
    (callgrind, inclusive counts by function, jemalloc, one run each, the bench binary at
    `3452790a`: of the 13,266 instructions the stages add to a request, the tag's hash and body
    read 3,494, the security headers 2,371, and the error page's plumbing, the signal and the
    boxed future most of the rest); measured (callgrind, release, the same request path, on an
    uncommitted variant of main `c65c10ec` with the stages written as combinators on axum's
    router, which the repository does not hold: about 200 to 360 instructions a request fewer
    than main with glibc's allocator, about 200 to 263 more with jemalloc); measured (the lean
    catalog lane at `229b1e928`, one binary with switches to turn stages off, `perf stat` on the
    server pinned to one CPU and `wrk` with 64 connections on three others, 500 record IDs
    requested with `Accept-Encoding: identity`, 12 alternated rounds for the stage switches.
    In cycles a request, user and kernel together: the tag cost 14,003 by the difference of the low quartiles and 16,561 by the difference of the
    medians, within that one batch (cycle levels are not compared across batches, which drifted by up to 15%);
    the cache rule cost nothing the rounds could see; all security headers together cost about
    3,500; the host check, same-origin check, nonce slot, signal and credentials together cost
    about 5,000. In a separate 14-round batch at the same commit, with the request-based tag
    rule and the request held once, Corten sending every security header cost 3% more by the low
    quartile and 9% more by the median of the per-round differences than axum + Maud sending
    none, and 3% to 10% less than axum + Maud sending the same headers by one middleware.
    [The stage decision and figures](https://github.com/corten-run/corten/issues/1651#issuecomment-6985183384)
    and [the tables and method](https://github.com/corten-run/corten/issues/1644#issuecomment-6985178754)
    give the rounds);
    reasoned (one place for the app's steps is
    one order to read, a tuple resolved at compile time costs no box, and a route that needs none
    of it says so where it is declared); platform (a PDF sent with a sandbox shows in the viewers of
    Chrome, Edge and Firefox as one sent without it, probed as Last checked says; Safari's is not
    run, since the repository's WebKit has no PDF viewer, and WebKit's bug tracker records that it
    showed nothing for one until a fix in December 2024, which was read, not run); bet (apps have an answer anyone may read whose cost the
    stages would make about 2.5 times as costly, beside pages that need them all; listings-feed's
    sequence route, which its failover benchmark reads, is the first use, and no app's in
    production is yet); measured (callgrind, x86-64 Linux release, `catalog-lean` identity GETs:
    sharing the staged header reads reduced named request-map lookups from 17 to 14, kept three
    response-map lookups and three request extension inserts, and reduced median instructions per
    request from 43,274.3 (43,274.1 to 43,275.6) to 42,763.2 (42,762.1 to 42,770.4).
    A mounted JSON GET with a session cookie kept six named request-map lookups, none for
    `Authorization`, and went from 35,796.1 (35,794.0 to 35,797.9) to 35,650.6 (35,647.5 to
    35,654.7) median instructions per request); value
    (one way to do each thing, Value 5, and good defaults with easy overrides,
    Value 7; one place that says what goes around a route, the stages or an unstaged route's lane,
    for 71 to 86 instructions that keep the route inside the bound below, Value 5 within Value 1).

    Revisit when: an app needs a step at a stage the tuple's place cannot reach and a tower
    layer around the app cannot serve it; or a route needs some stages and not others, and a flag
    for a group it can do without saves cycles a request under load beyond the spread of
    alternated rounds, after taking out the work the request or the route's declaration already
    shows the answer cannot use, without taking away a document's security headers; or a
    browser the runtime supports shows a PDF sent with a sandbox differently from one sent without
    it; or no
    app but listings-feed uses `unstaged` by the next minor release; or an unstaged route costs more
    than about 100 instructions over what it cost with its checks in its handler at `8ddeaea2`
    with jemalloc, 6,932 in the app's routes and 6,982 in an API's module (7,003 and 7,068
    through its lane, 7,030 and 7,076 since step 4), when a control that shares no code with
    Corten counts the same in both builds (a plain axum router, 7,085 in both, until step 4; since
    step 4 a `service_fn` with no framework, 3,190 in both), or the control itself moves between
    builds by more than the route does, which says the harness no longer separates them; or, in
    one build of `tests::patches::what_a_request_in_an_area_costs` with jemalloc, a request in its app
    with two areas and an API costs more than about 100 instructions over the same request in its
    app with none, beyond the difference measured once each route was given its scope (at
    `6ffc316f`: 5,472 for the page in the inner area against the same page as an app route, and
    690 for the API's JSON route against the same handler as an app route); or, in one build of
    the same harness in its app with areas, a page an app catch-all answers outside every area,
    which looks its scope up by path, costs more than about 100 instructions over the same page at
    an app route there, beyond the 667 measured at `084db982` (19,236.7 through the catch-all
    against 18,569.8 at the route, a catch-all's match counted in it); or a route whose every
    path is outside the other prefixes is sent by path for a reason other than a static route
    beside it answering those paths first, which says the segment count has grown looser
    than it reads; or one is given a scope while one of its paths is under another prefix, which a
    request would then answer with the wrong area's settings; or
    `tests::url::can_match_under_never_says_no_where_matchit_matches` fails, which says the matchit a
    build resolves matches a path the count says a route cannot reach; or Corten's exact
    matchit 0.9.2 pin changes, whose matching and conflict rules must be read again;
    or a derived route, or an area's or API's, may put text before a parameter, which
    `parse_path` and `route_shaped` refuse today; any of which the count must then follow.
    Also revisit if `router::tests::staged_page_future_sizes` fails on x86-64 Linux because a
    boxed future grew. It measures the real stages and typed handler for a small page without
    app middleware or layout reads, and holds each boxed future within the size of one request
    of what its build profile measured, so a stage that holds the request again across the
    stages after it fails the test. A compiler that moves a future's layout by that much fails
    it too, with no change to the stages, and so does a change that shrinks a future by that
    much, which only lowers the measurement. Measure both profiles again before moving a
    measurement.

    Last checked: 2026-11-20, `staged_page_future_sizes` at `3089d0a97`, after it failed on
    main: the stage future grew from 2,632 to 3,008 bytes in a debug build and from 2,176 to
    2,280 in a release one, holding the page snapshot that sharing the staged header reads keeps
    before dispatch, not the request again (the stage owns one request slot, and dispatch takes
    it). This Choice's catalog GET counts were taken with that snapshot and are what the stages
    cost with it, so the Choice stands and the measurements moved; 2026-11-19, the header lookup, extension
    and instruction counts before
    (`aa0f0c7e1`) and after sharing the reads and restoring the short circuits (`76229a2fd`),
    from three short/long pairs per build for each workload: 1,300 less 300 catalog GETs,
    on one connection per run;
    2026-10-29, the area middleware runs of
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
    variant of `8ddeaea2`; 2026-11-09, the `laned` variant of `fa0b1525`; 2026-11-10, the
    unstaged route and the plain axum router with axum gone (step 4) at `5548c97a` against step 3
    at `67e7f5f5`, with the profile of each, and the `service_fn` control with no framework in both
    builds (three runs each with jemalloc and with glibc, every run the same); 2026-11-12, each
    route given its area's or API's scope at `f7d33ce2` against main `31de4268`
    ([#1213 The stages find a request's area by its path in six prefix tables after the router has already matched its route](https://github.com/corten-run/corten/issues/1213)),
    and the app with areas against the one with none in one build at `6ffc316f`; 2026-11-13,
    routes counted by segment at `084db982` against `416882fa`, with a catch-all's request;
    2026-11-13, matchit 0.8.4's parameter matching and route insertion read in its source
    (`tree.rs`), with 0.8.6's for the Revisit-when; 2026-11-13, matchit 0.8.5's `tree.rs` read
    against 0.8.4's and 0.8.6's, the versions crates.io lists for 0.8 (0.8.6 the newest), and the
    workspace's `Cargo.lock` (matchit 0.8.4, axum 0.8.9 requiring `=0.8.4`), with the
    differential test in the commit that adds it, which fails when the count is made to refuse an
    empty value before a `/`; 2026-11-13, matchit 0.9.2's `tree.rs`, `error.rs` and insertion
    tests read against 0.8.4 and 0.8.6, and `Router::new` and `api::can_match_under` re-read
    against them for the exact pin ([Choice 48](#choice-matchit)); 2026-11-14, the matching
    differential and area-scope tests passed in the merged workspace's full debug tests at
    `66cb2936e`; 2026-11-14, matchit 0.8.6's and 0.9.2's insertion read for the order-dependent
    conflict a hand-written prefixed route can meet, and the differential and area-scope tests
    passed again in the full debug tests of `0653768e1` and of the merge `4c6ac3e3d`;
    2026-11-18, the staged catalog page's boxed future sizes in x86-64 Linux release builds
    before (`7620ef9be`) and after (`ca900161d`) keeping the request in one slot; 2026-11-18,
    rechecked after moving the poller into the existing late-write box (`8db1903dd`): in DHAT,
    100 catalog GETs on one connection allocated one 2,144-byte stage and one 1,880-byte handler
    future each, against 4,952 and 1,880 bytes at the baseline; 2026-11-19, rustc 1.99.1 rejected
    reads after hand-off and after both dispatchers took the request, in the change that makes
    the handle move-only ([#1674 Shrink the boxed future for staged requests](https://github.com/corten-run/corten/pull/1674#round-two)).
    2026-11-18, the lean catalog stage switches and comparison with and without the same
    headers at `229b1e928` (measured above); 2026-11-19, the merged request-based tag rule
    (`7620ef9be`) and the single owned request (`aa0f0c7e1`) read against those experiments.

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

32. <a id="choice-stream-coding"></a>**A compressed stream is zstd, else gzip, never brotli.** A
    live stream, a feed and a streamed `Media` are compressed as one stream per connection,
    flushed after each event or chunk with the context kept, so the client decodes each at once
    and a redraw costs about what changed. Playwright's WebKit (27.2, on Windows) dispatches a
    flushed brotli event that decodes to more than 16 KiB only once more of the body arrives, so the
    last change before a quiet spell showed one event late: an event of 16,385 bytes showed only
    when the next chunk came, with Corten's encoder and with Node's at quality 4 and 11, and with
    empty blocks after it (the issue saw a 17 KB event from Node's encoder on time; that was not
    seen again). Replaying a stream's captured chunks one a second from a Node server, gzip and
    identity were on time at every size tried, to 200 KB, in all three engines
    ([#1131 Brotli-compressed SSE delays final events in WebKit](https://github.com/corten-run/corten/issues/1131)).
    The watchlist smoke holds the fix: an event that decodes to 52,395 bytes with nothing after it
    must be dispatched within 5 s in each engine (Chromium and Firefox get zstd there, WebKit
    gzip), and a build whose streams are brotli fails it in Playwright's WebKit on Windows; CI's
    Linux WebKit takes no brotli, so there the rule is held by the negotiation tests and the smoke's
    HTTP checks, which ask for each coding themselves.
    So a client that accepts zstd gets zstd 1 as before, any other that accepts gzip gets gzip 3
    (sync-flushed, its window kept), and one that accepts only brotli gets the stream as it is, even
    if it says `identity;q=0` (RFC 9110 section 12.4.1 lets a server disregard the field when nothing
    it has is acceptable, as a stream past the budget already does, rather than answer 406). A
    streamed `Media` follows the same rule though a download ends, so its tail is never held for
    long: one rule for every stream, at the cost of gzip's bytes for a client without zstd.
    Gzip sends more than brotli 4 did, most for a large region (`what_a_redraw_sends`, ten redraws
    of a list with one row changed): of 40 rows (2.7 KB) 60 to 69 bytes against 20 to 40, of 250 (17
    KB) 477 to 524 against 23 to 91, and of 640 (45 KB, past deflate's 32 KiB window, so most of the
    event before is out of reach) 6,203 to 6,214 against 44 to 2,029. Level 3, not 1: at 1 the
    redraws are 129 to 453 bytes, 2,188 to 2,684 and 7,238 to 7,330. A gzip stream holds 352,232 bytes and reserves 360
    KiB (`tests/stream_memory.rs`, the bytes asked of the system allocator; jemalloc, which the
    template's image preloads, rounds them up to its size classes, which is not measured), where
    brotli reserved 1,000 KiB. It costs more CPU: an event of the 2.7 KB redraw, made and sent
    through the compression layer, is about 286,650 instructions against brotli's 213,720 (zstd 1:
    100,470, unchanged).
    Not chosen: brotli with an empty block or a keepalive after each event (WebKit held the event
    back with empty blocks after it); a gzip-only client getting the stream as it is, as before (a
    redraw's saved bytes are why streams are compressed).

    Stands on: platform (Playwright's WebKit on Windows holds back a flushed brotli event of more
    than 16 KiB and sends `deflate, gzip, br`, no zstd; its Linux build, which CI's smoke runs,
    takes no brotli at all, so the smoke there cannot see the holdback and the rule is held by
    `compress.rs`'s tests and [`tests/bodies.rs`](../crates/corten/src/tests/bodies.rs); the 16 KiB edge matches libcurl's write size, the
    Windows build's network stack, which suggests the holdback is that stack's, not measured;
    Chromium and Firefox send zstd, which arrives at once there; no WebKit that accepts zstd was
    tried, and Safari, whose network stack is not Playwright's and which caniuse lists as sending
    zstd over HTTPS from 26.3, was not tried at all); measured (bytes a redraw by `what_a_redraw_sends`, one run, the counts fixed
    by the encoders; a gzip stream's memory by `tests/stream_memory.rs`; the large event on a
    quiet stream by the watchlist smoke; instructions an event by callgrind,
    `what_an_event_stream_costs` at 2,000 and 12,000 events, three runs each, within 20
    instructions); reasoned (a sync flush ends deflate's output on a byte boundary with everything
    sent so far decodable, so a decoder has the whole event); value (an event on time at the
    user's end before the bytes brotli saves, Values 1).

    Revisit when: a WebKit that Playwright runs dispatches a flushed brotli event of more than
    16 KiB at once, or sends zstd (then check a flushed zstd event there); Safari is tried and
    shows a large event on time under brotli (then the holdback is the Windows build's own, and
    brotli can come back for a client without zstd), or late under zstd or gzip; or apps send redraws
    over 32 KB to clients without zstd often enough that gzip's bytes show in a round.

    Last checked: 2026-11-08, WebKit 27.2, Chromium 156 and Firefox 157: the late brotli event
    against `c65c10ec`'s streams and Node's encoder, by replaying a stream's captured chunks one a
    second from a Node server (the issue's Isolation), and each engine's `Accept-Encoding`;
    2026-11-08, the callgrind counts on `c65c10ec` (brotli 4, zstd) and `541fc59b` (gzip 3, zstd);
    2026-11-08, the bytes, miniz_oxide 0.9.1 and brotli 9.0.0, on `202f6427` with
    `what_a_redraw_sends`; 2026-11-08, the memory on `a4958acb` with `tests/stream_memory.rs` (test
    profile, printed with `--nocapture`, the same in two runs); 2026-11-09, the watchlist smoke's
    large event, against a server built from `0b9a134c`, in Chromium, Firefox and WebKit (two
    runs, all on time, 10 to 22 ms; the second, which reads the route's answer, saw 200 with zstd,
    zstd and gzip, and failed only WebKit's busy-mark check, the flake of
    [#1108 The smoke's busy-mark check failed once in WebKit: the replaced button A was still marked busy while B's submit was on its way](https://github.com/corten-run/corten/issues/1108)),
    and in WebKit again with the check's bounded fetch (`228dba80`, gzip, 32 ms),
    all on Windows; 2026-11-09, the smoke against `022c3282` with `c65c10ec`'s `compress.rs`
    and `answer.rs`, whose streams are brotli, in WebKit on Windows (one run: the route
    answered 200 with `br`, and no event came in 5 s), and the same build on `535b22f9` in
    Playwright 1.64.1's Linux image, as CI runs it (one run: the route answered 200 uncompressed,
    so that WebKit did not ask for brotli or zstd, its header not logged, and the event came in
    18 ms); 2026-11-09, the whole smoke against a server built from `0b9a134c` in that Linux image
    (one run, all passed; Chromium and Firefox got zstd, WebKit gzip, the large event in 7 to
    17 ms); 2026-11-09, the memory again on `022c3282`, which counts only the
    test's thread (352,232 bytes, the same).

33. <a id="choice-state-derives"></a>**An app's shared state derives `Clone` and `FromRef`, two
    derives that each say one thing, not a state attribute that writes both.** `Clone` says the
    state can be copied, which routing and a handler that takes the whole state both need:
    `#[corten::routes(state = Shared)]` gives each route its own copy
    (`Methods::with_state(.., state.clone())`, which takes an `S: Clone` because Corten's router
    binds a copy of the state into each of a route's method slots, `router.rs`'s
    `MethodSet::with_state`), and a handler's `State<Shared>` goes through `handler.rs`'s
    `impl<T: Clone> FromRef<T> for T`. `FromRef` says each field can be taken alone:
    it gives each field its own extractor (`State<Market>`), which clones that field and needs no
    `Clone` of the containing type. The six examples with shared state route seven state types:
    three derive both (watchlist's `Shared`, card-market's `ApiState` and listings-feed's
    `Shared`) and four derive `Clone` alone, their handlers taking the whole state (card-market's
    `Source` (the state of its pages), auction-room's `Auction`, deck-builder's `Builder` and
    seller-desk's `Desk`). A test's state in watchlist's `account.rs` derives both too, but no
    route takes it, so it is not counted. A `#[corten::state]` attribute would take one word off
    each of the three that derive both (the `Clone` in `#[derive(Clone, FromRef)]`) and give
    three of the other four (`Auction`, `Builder`, `Desk`) a choice between it and the derive
    they write now; `Source`, an enum, could not take it, since `FromRef` is derived only for a
    struct with named fields. That is a third way to write state, and a concept to learn that one
    word a type does not earn (Values 5 and 6). The generated code would be the same. `FromRef`
    deriving `Clone` itself is not chosen either: a type that writes its own `impl Clone` and
    derives `FromRef` would get a second, conflicting impl (no routed state does both today, but
    the shape is real: `corten_cluster::Cluster<S>`, routed as a state by
    `#[corten::routes(state = Cluster<Items>)]` in its tests, writes its own `Clone` because its
    fields are behind an `Arc` and `#[derive(Clone)]` would bound it on its parameter), and the
    derive list would no longer say that the type is `Clone`. Not chosen: the attribute; an option
    on `FromRef` (`#[from_ref(clone)]`), the same second spelling in another place
    ([#1045 Evaluate a state declaration that bundles Clone and FromRef](https://github.com/corten-run/corten/issues/1045)).

    Stands on: reasoned (each route takes its own copy of the state, in `routes.rs`'s
    `Methods::with_state(.., state.clone())`, Corten's router clones it again into each method
    slot, `router.rs`'s `MethodSet::with_state`, and once more for each request, `router.rs`'s
    `Handled::call`, since `handler.rs`'s `Handler::call` takes the state by value, all bounded
    `S: Clone`; a handler takes the whole state through `handler.rs`'s
    `impl<T: Clone> FromRef<T> for T`; both are Corten's own since axum left,
    [Choice 25](#choice-axum-router), step 4, so `Clone` is Corten's decision, not a platform's;
    an impl the derive wrote would conflict with a hand-written `Clone`; and the attribute saves
    one word on three types while adding a way to write six of the seven, counts that move with
    the examples); value (one way to do each thing and a small surface, Values 5 and 6).

    Revisit when: a third mechanical impl is derived beside the pair on two or more of the
    examples' routed state types, so an attribute would carry more than two derives' worth; or
    Corten stops copying the state into each route (the routes macro) and into each method slot
    and request (the router) (a handler given `&S` or one shared `Arc`, say), and `handler.rs`'s
    `impl<T: Clone> FromRef<T> for T`, through which a handler takes the whole state, stops
    requiring `Clone`, so state no longer needs `Clone`.

    Last checked: 2026-11-10, the examples' state types, `from_ref.rs`, `routes.rs`,
    `Methods::with_state` and `corten-cluster`'s tests, at `97a63a92` (then also axum 0.8.9 and
    axum-core 0.5.6 from `Cargo.lock`, the platform premise this Choice no longer has);
    2026-11-11, with axum gone, `router.rs`'s `MethodSet::with_state` and `Slot::bind` (one
    clone per method slot) and `Handled::call` (one per request), `corten`'s `route.rs`'s
    `Methods::with_state`, `handler.rs`'s `Handler::call` and `FromRef` blanket impl, each
    bounded `Clone` or taking the state by value, and no crate under `crates/` depending on axum,
    at `25acd6a7`.

34. <a id="choice-listen-backlog"></a>**A listener asks the system to hold 511 finished
    connections, not 128.** `corten::listeners`, and so `serve`, binds each socket with a
    backlog of 511, the connections whose handshake is done and that the server has not yet
    accepted, where `TcpListener::bind` asks for 128 (mio's and the standard library's number).
    Investigating round r17's page timeouts and dropped load iterations
    ([#1128 Benchmark r17: investigate widespread page timeouts and dropped load iterations](https://github.com/corten-run/corten/issues/1128))
    found a burst-connect delay that reproduces, though it is not shown to be what made r17's
    failures: Linux takes one more than the backlog and drops the next SYN, so that client waits
    for its resend, about a second. With 1,024 k6 clients
    starting at once against a page on one CPU, the kernel counted 142 and 485 listen-queue
    overflows (two runs) and the slowest connect took 1.27 and 2.08 s at 128; at 511 there were
    none and it took 0.28 and 0.24 s, and 4096 overflowed none either. 511 is Node's default and
    nginx's on Linux. A deeper queue is not free: past `App::max_connections` connections wait in it
    for as long as the cap holds, each with what it has sent so far in kernel memory, so the queue
    is kept no deeper than a burst needs, and 511 is the smallest of the sizes tried that held
    this one, not a measured minimum. The system caps the number: Linux at `net.core.somaxconn`
    (4096 since 5.4, 128 before), macOS at `kern.ipc.somaxconn` (128 by default, so there the change
    takes a raised setting), and Windows 11 held 200 in one run and refused a connection past them.
    A listener of the app's own (`serve_on`) sets its own backlog.
    Not chosen: keeping 128 (the overflows and second-long connects above); the system's maximum,
    `SOMAXCONN` or 4096 (as deep a queue behind `max_connections` as the system allows, for no
    burst that 511 did not hold); a setting on `App` (a new concept for a number an app that needs
    another can set on a listener of its own).

    Stands on: measured (k6, 1,024 clients at once against a page on one CPU in Docker Desktop's
    Linux 6.18 VM, two runs at 128 and at 511, one at 4096, the kernel's `ListenOverflows` and
    k6's slowest connect; the crate's test
    `a_burst_of_connections_waits_in_the_queue_not_for_a_retransmit`, 200 connections on each
    listener with none waiting 900 ms, which a backlog of 128 fails at the 130th); platform (Linux
    admits backlog + 1 and drops the next SYN, retransmitted after about a second; the caps above;
    Windows 11's 200 is one run on loopback, and Windows Server and macOS were not tried); reasoned
    (connections held past `max_connections` cost kernel memory, not measured); value (a burst of
    users connects at once rather than a second late, Values 1, as a default with no setting to
    find, Values 7).

    Revisit when: a round or an app sees listen-queue overflows at 511 under a burst a server
    should take; a platform cap not listed above is found, a listed one changes (a macOS default
    raised, a Windows that holds more or fewer than 200), or one of them is shown to need a
    different default; or a measurement of the kernel memory held past `max_connections` shows
    511 costs more than the bursts it absorbs.

    Last checked: 2026-11-08, the k6 bursts and overflow counts on Docker Desktop's Linux 6.18 VM,
    against `c65c10ec` (128), `3249bbed` (511) and `1a84048d` (4096); 2026-11-08, Windows 11's 200
    on loopback, recorded in `c62a8706`; 2026-11-10, the crate's test on `70730b56` (Linux, passed
    without skipping) and a socket probe on Linux in which a backlog of 128 timed out at the 130th
    connection and 511 admitted 200 on each loopback address.

35. <a id="choice-runtime-terser"></a>**The runtime and its modules are minified by esbuild and then by
    terser.** Every page of every app loads the runtime, so its bytes are paid on each first
    visit. esbuild bundles each file (the runtime takes in `on.js`), lowers it to ES2022 and
    minifies it, as before; terser, a development dependency of the repository's tooling that no
    app installs, minifies that output again, compressing in two passes and renaming the module's
    top-level names. The runtime on `21f9fab3`, as built (banner included), is 40,988 bytes
    against 41,093, 14,318 with gzip (level 9) against 14,851, and 12,955 with brotli (level 11)
    against 13,487: 3.6% less with gzip and 3.9% less with brotli, as Corten serves it, and 0.3%
    less uncompressed. The saving is terser's renaming: on `c65c10ec`, without it, 495 of the 529
    bytes it saved with gzip came back. Not chosen (measured on `c65c10ec`): esbuild's minifier
    alone (above); terser on esbuild's unminified bundle instead (14,373 bytes with gzip and
    13,015 with brotli, and 41,468 uncompressed, 477 more than before); terser renaming without
    compressing (43 bytes more with gzip, 35 with brotli); one pass (12 and 6 bytes more); a third
    pass (the same bytes as two).

    Stands on: measured (each built file before and after on `21f9fab3`, one build each, the
    build being deterministic: the runtime 105 bytes less uncompressed, 533 with gzip and 532
    with brotli; `view.js` 20, 75 and 60 less; `format.js` 11, 8 and 18 less; `upload.js` and
    `keys.js` within 11 bytes either way, `upload.js` 1 byte more uncompressed and `keys.js` 1
    more with gzip; on `c65c10ec` the runtime was 107, 529 and 478 less); measured (the browser
    smoke tests on the built files of `10cd394d`, one run each, in the engines each runs: the
    watchlist, also under `corten dev`, card-market, ui-gallery, seller-desk, deck-builder and its
    preview, auction-room and listings-feed all passed; an earlier build, terser over the
    unminified bundle, failed one Firefox check that fails under load without it, the feed's
    reconnect timing, [#1102 The watchlist smoke's Firefox feed backoff check fails under load: a 2 s wait measured over 6 s against a 3.5 s bound](https://github.com/corten-run/corten/issues/1102));
    value (fewer bytes on every page, Values 1, for a dependency of the tooling only, Values 6).

    Revisit when: esbuild's minifier comes within 1% of the two after compression, so one tool
    does it and terser goes; or terser's output fails a smoke test in a supported engine that
    esbuild's alone passes.

    Last checked: 2026-11-20, terser 5.51.3 with esbuild 0.28.2 on `3efd3266d` builds all eight
    files byte for byte as 5.51.2 does there (the same SHA-256 each), so the move changes no
    shipped byte, and the build gives terser no input source map, so 5.51.3's source-map change
    does not apply; 2026-11-10, sizes on `21f9fab3` with esbuild 0.28.2
    and terser 5.51.2, and the smoke tests on `10cd394d` (and CI's on this change).

36. <a id="choice-derived-row"></a>**A feed row's key is the field marked `#[row(id)]`, which `#[derive(Row)]` reads; the
    row's `Clone` and `Serialize` stay in its derive list.** The impl every row wrote by hand
    (`fn id(&self) -> &str { &self.id }`) is one attribute on the field, so the key is named where
    the field is and moves with it when it is renamed. The derive writes nothing else. A derive adds
    impls, not other derives, and writing the row's `Serialize` itself would be a second
    serializer beside serde's to keep in step, to save one word in a derive list; `Clone` is the
    compiler's own derive. So a row still lists `Clone` and `Serialize` (and `ToJson` where a
    script reads its type), and Rust checks each with the trait's `Send`, `Sync` and `'static`
    bounds. Not chosen: an attribute macro (`#[corten::row(id = id)]`) that adds the derives to the
    item, which hides standard derives behind a spelling of Corten's and names the field in an
    argument rather than on it; taking a field named `id` without a mark, since a row's key is
    better said (`sku`, `ticker`) than guessed. So a struct row with named fields, keyed by one of
    them, derives `Row`, and only a row the derive cannot express (such as an enum, a tuple struct,
    whose fields serde writes without names, a key made of several fields) implements the trait by
    hand:
    the hand-written impl is what is left for those, not a second way for the rest. Beyond the impl,
    the derive refuses what makes a script or a replica read the key as something other than
    `id()`, as far as the row's own serde attributes say: one that leaves the id out, writes or
    reads it as other text or under two names, reads or writes the row as another value, or has
    another member that serde writes or reads under the id's key. An id type's own `Serialize` and `Deserialize`, a row's
    that are not serde's derive, and a flattened field's members are not known when the derive
    runs, so they are not checked
    ([#1044 Generate feed-row requirements and the Row implementation from one declaration](https://github.com/corten-run/corten/issues/1044)).

    The derive is `corten::feed::Row`, beside the trait, and not in `corten-feed` itself: its impl
    names `::corten::feed::Row`, so `corten-feed` and `corten-protocol`, which do not depend on
    `corten`, keep writing their test rows by hand, as does a row whose `id` does more than
    return a field (`corten-cluster`'s `Gated`). That is a cost: a native or agent client built on
    `corten-protocol` alone, which a replica's read-side checks are for, writes its rows' `impl Row`
    by hand too, since taking the derive there would bring in `corten` and its server
    dependencies. No such client is in the repository or has been reported.

    Stands on: reasoned (the generated impl is the one written by hand and the feed's path is
    unchanged, which `crates/corten/tests/derived_row.rs` checks by comparing a derived row's
    snapshot and replayed patch with a hand-written one's); value (one declaration for the key,
    and no second way to derive `Clone` or `Serialize`, Values 5 and 6).

    Revisit when: an example app, or an app that reports it, implements `Row` by hand for a key
    made from more than one field, which a mark on one field cannot say; or a native or agent
    client on `corten-protocol` alone keeps rows it would derive (the derive would then take a path
    to the trait, such as `#[row(crate = corten_protocol)]`).

    Last checked: 2026-11-10, the derive, its `compile_fail` examples, each compiled for its own
    message, `tests/derived_row.rs`, and the rows of the four example apps and `corten-cluster` by
    `cargo clippy --workspace --all-targets`, on `76247120`, the derive's last change; 2026-11-10,
    the live benchmark's row, outside the workspace, by reading it on `76247120` (it has no serde
    attribute).

37. <a id="choice-asset-ranges"></a>**A static file answers one range of its bytes at any
    version's URL, only as it is stored, and never sends `Accept-Ranges`.** A `<video>` asks for
    ranges to seek, so a file sent only whole makes a player download what it skips, and Safari on
    iOS plays media only from a server that answers ranges. A `GET` of a versioned URL, this
    version's or an old one's, for a file sent unencoded answers one range as a `206` with its
    `Content-Range`, a range the file cannot hold as a bare `416`, and `If-Range` keeps the range only for
    the tag of the bytes sent, compared byte for byte (RFC 9110). An old version's URL is answered
    from this version's file, `no-cache`, under that file's strong tag, so a page still holding an
    old version's URLs after a deploy (a tab left open, a page a cache kept) still plays and seeks
    its clip: every deploy renames every file, so refusing those ranges would stop the clip for
    every Safari visitor until the page is reloaded, even when its bytes did not change. Sent whole
    instead: several ranges or another unit (RFC 9110 lets a server ignore `Range`); a compressed
    body, whose offsets are not the file's; and the favicon, whose URL outlives every deploy under
    a weak tag. The cost, which this Choice brings: a server cannot tell an older version's URL
    from a newer one's, so while a fleet runs two versions, or when a deploy lands between two
    ranges of one playback, a file whose bytes changed can be answered from either version at
    either URL. A client that sends `If-Range` then gets the whole file; one that does not may
    join ranges of two versions and play neither. Sending other versions' URLs whole prevented
    that, and was traded for Safari playing them; a file whose bytes did not change has the same
    tag and bytes in both. No answer advertises ranges: the header is optional and browsers send
    `Range` without it. The PWA's worker leaves a range to the network, since its cache holds whole
    files and cannot hold a `206`, and the video or audio a player loads too (a request whose
    destination is `video` or `audio`): one without a range (Playwright's Linux WebKit sends one
    first) would otherwise be stored whole, downloading the whole video, which a player does not
    read back from the cache; its captions and poster are cached like any versioned file. Not
    chosen: `Accept-Ranges: bytes` on every file (optional, above); an old version's URL sent whole
    (Safari on iOS would not play it, above); a URL named by each file's own hash rather than the
    app's version (an unchanged clip would keep its URL across deploys and a server would know
    which bytes a URL names, but it changes how every asset is named and cached, a change of its
    own); multipart ranges (no browser player asks for them, and each would be a body Corten
    writes); slicing an encoded body (the client's offsets name the file, not the encoding); the
    worker cutting a range from a whole file it cached and answering the `206` itself (code in
    every app's worker for offline video, which no app here needs;
    [Limit 5](#limit-offline-fallback) stays).

    Stands on: platform (Apple's Safari Web Content Guide, "Creating Video", says a server hosting
    media for iOS must answer byte ranges, which iOS uses for random access; with no
    `Accept-Ranges`, Chromium and Firefox ask for the clip by a `Range` and play it from the
    `206`, and WebKit reads it whole once and then asks for a range from inside it, each seeking,
    as card-market's smoke shows on Linux, below; the 8 KB clip comes whole in Chromium's and
    Firefox's first range, so the smoke does not show them asking for a range from inside it);
    measured (callgrind, `what_serving_a_file_costs`, which sends no `Range`, so its count is what
    every file's answer pays, 1,200 requests less 200 over 1,000, five runs each taking turns:
    11,826.69 (11,825.27 to 11,826.73) instructions a request on `97a63a92` with the test added
    and 12,024.05 (12,024.05 to 12,025.49) on `92d38464`, with ranges at this version's URL only,
    +197 (+1.7%); then 12,024.02 (12,023.98 to 12,024.06) on `84719c0f` and 12,026.06 (12,026.01
    to 12,026.08) on a build whose request path is `a7b1c808`'s, with old URLs ranged too, +2);
    reasoned (one range per answer and a tag naming the bytes sent keep a client that sends
    `If-Range` from joining bytes of two files).

    Revisit when: Safari or iOS on real hardware, not tested here, will not play or seek a clip
    served this way, or a client that matters will not seek without `Accept-Ranges`; a clip is
    reported playing garbled after a deploy (ranges of two versions joined); a player asks for
    several ranges; or an app needs a `Media` answer, not a static file, to seek.

    Last checked: 2026-11-10, Apple's guide read and the crate's asset tests on `112422cb`;
    2026-11-10, card-market's smoke in Playwright 1.64.1 against a build of `4ec25ef4`, on Linux
    with Chromium, Firefox and WebKit each playing and seeking the clip, and on Windows with
    Chromium and Firefox; 2026-11-10, the count on `97a63a92` and `92d38464`; 2026-11-10, the
    count on `84719c0f` and `a7b1c808`.

38. <a id="choice-json-derives"></a>**A type's JSON role is the derive that names its direction,
    `ToJson` to write and `FromJson` to read, not a data-role attribute.** Each derive is already
    the one thing a type declares for its direction: `ToJson` lays out the JSON a response, a
    screen's data, a typed script argument or an agent tool's output writes, and its schema (feature
    `types`); `FromJson` reads it, with its `Deserialize`
    ([Choice 26](#choice-derived-deserialize)). An attribute such as `#[corten::data(write)]` would
    spell the same derive another way: it takes no line off a type and adds no check the derive does
    not already make, and two spellings of one thing is what Values 5 and 6 rule out. The direction
    stays in the type's own declaration, so nothing is written because it appears in a handler's
    signature, and no type of another module or crate is exposed by it. An agent tool's output was
    the one place a response type still needed serde's `Serialize` beside `ToJson`: its
    `outputSchema` came from `ToJson`'s schema while its bytes came from `Serialize`, so a
    hand-written `Serialize` could drift from the schema with nothing failing to compile (Value 4).
    Tool outputs are now bounded on `ToJson`, so a derived `ToJson` writes both the schema and the
    bytes (a field of another crate's type inside it is still written by serde under a schema
    written for it, as in any `ToJson` answer), and a tool's output is written by the code every
    other response is. The std types Corten gives a schema for are `ToJson` too, and `FromJson` in
    their owned forms (`str`, `[T]`, `Path` and `RawValue` boxed or shared), written and read as
    serde does (but for a map whose key is not a `JsonKey`, which is not written, or not `String`,
    which is not read, an array of more than 32 items, which is not read, and an `Arc` or `Rc` read
    without serde's `rc`), and another crate's type that has a schema goes in a
    `#[serde(transparent)]` newtype that derives `ToJson`, one impl. A `ToJson` written by hand, for
    a type whose schema is written by hand (one the derive refuses, or another crate's type with
    none, in a newtype of the app's), comes with that `ToJsonSchema` beside it, two impls its author
    keeps in step, as before. Tool inputs are bounded on `FromJson` the same way, so an input that
    derives serde's `Deserialize` beside a schema written by hand does not compile, short of the
    deliberate `impl FromJson for T {}` a type whose `Deserialize` `FromJson` cannot write takes
    (written by hand, or serde's for an attribute it refuses), which again leaves two impls in its
    author's hands. A hand-written `ToJson` can write what serde could not, broken JSON, which would
    break the JSON-RPC answer around a tool's output, so whether an output is parsed before it is
    sent follows from its type: `ToJson::__well_formed` (hidden) is true for Corten's own impls, for
    `Raw` (parsed when it is made) and for what serde writes, the AND of its fields' for the derive
    (each type expanded once in a question, so a tree, a cycle or a type many others hold answers at
    once), and false for an impl written by hand (`JsonKey` likewise, for a map's keys). serde_json
    writes well-formed JSON for a `Serialize` that follows serde's protocol, as every derived one
    does; it does not check a hand-written one that calls a map's `serialize_key` twice, which a
    debug build's parse catches and a release build sends as written, as before this Choice. An
    output derived over well-formed types, the common case, goes out unparsed; one that is or holds
    a hand-written `ToJson` is parsed in every build, and one that is not one JSON object is the
    tool's internal error, logged with the tool's name, the output's size and the fault, not its
    data. A debug build parses every output and answers a bad one with a 500, so a test stops at it.
    Not chosen: parsing every output in a release build, about 92,700 more instructions a call
    (303,500 against 210,762, 44% of `tool_cost`, and 14% over the serde path this replaced) for
    outputs Corten's and the derives' impls cannot break; and checking only an output's ends, which
    sent a broken object as written. `Json` answers are unchanged: they send a hand-written `ToJson`
    as written. A tool output whose `ToJson` falls back to a field's own `Serialize` and fails
    (another crate's map with a key JSON cannot hold, or a std type serde refuses: a path that is
    not UTF-8, a `SystemTime` before the epoch) panics where it is written, as in every other
    `ToJson` answer; the call catches that panic and answers the tool's internal error (`isError`,
    "internal error"), as it did when serde wrote outputs, so `ToJson` stays the one writer (an app
    built with `panic = "abort"` ends instead):

    ```rust,ignore
    // Before: the tool's output derived serde's Serialize as well, for the agent endpoint.
    #[derive(serde::Serialize, corten::ToJson)]
    struct Adjusted { id: String, quantity: i64 }

    // After: ToJson alone.
    #[derive(corten::ToJson)]
    struct Adjusted { id: String, quantity: i64 }

    // Not chosen: a data-role attribute spelling the same derive.
    #[corten::data(write)]
    struct Adjusted { id: String, quantity: i64 }
    ```

    Feed rows are the known exception: the feed sends a row with serde (`Row: Serialize`) and its
    script type comes from `ToJson`, so a row still derives both; their declaration is
    [#1044 Generate feed-row requirements and the Row implementation from one declaration](https://github.com/corten-run/corten/issues/1044).

    Schema definitions are cached by Rust type identity and direction, not by the printed path.
    A [static in a generic impl](https://doc.rust-lang.org/reference/items/static-items.html#statics--generics)
    belongs to the declaration, not the instance: `Wrapper` over two versions of a dependency's
    type would share both the static and the printed name. A [function address](https://doc.rust-lang.org/std/ptr/fn.fn_addr_eq.html)
    can be shared by distinct functions or differ for the same function across codegen units.
    Only `types` enables [`typeid`](https://github.com/dtolnay/typeid/tree/1.0.3), a dependency-free
    crate maintained by David Tolnay, with about 220 lines in its library source. Its `of` obtains
    the compiler's `TypeId` with free lifetimes erased via an unsafe trait-object lifetime cast
    on zero-sized `PhantomData`, without touching borrowed data. Corten uses the result only as a
    schema cache key, never for downcasting or as proof of type equality. Owning the same unsafe
    implementation here would leave Corten maintaining its compiler assumptions and compatibility
    without a stronger guarantee. Definition names still come from the Rust name and the existing
    numeric suffix rule. A handler importing the wrong declaration fails when declarations are
    generated, not on a request.

    Not chosen: the attribute, a synonym; an attribute that derives both directions, which would
    save a type that is read and written one name in its `#[derive(..)]` list
    ([#1043 Evaluate whether a data-role attribute improves on the existing ToJson derive](https://github.com/corten-run/corten/issues/1043)).

    Stands on: platform (the std types' `ToJson` and `FromJson` write and read what serde and
    serde_json do for them, some by Corten's own code: serde 1.0.229 and serde_json 1.0.154);
    measured (an agent's `items.get` call in card-market's `tool_cost` runs about 21% fewer
    instructions, a median of 266,844 before (265,376 to 267,830) and 211,152 after (211,123 to
    211,865): callgrind, release, 1,200 calls less 200 over 1,000, three alternating runs each,
    14,464 bytes an answer on average over the calls counted; parsing each output in a release build
    would add about 92,700 a call, a median of 303,500 (302,705 to 303,650) against 210,762 (210,433
    to 211,420), three runs each, on `19fd761c` with its debug parse made unconditional
    (`debug_assert!` to `assert!`); card-market's output is derived, so it is not parsed; tests
    compare a tool answer's bytes with serde's for the item, and each std type's with serde's, and
    check which outputs are parsed); reasoned (serde_json writes well-formed JSON for a `Serialize`
    that follows serde's protocol, not checked for one that does not, where a debug build's parse is
    the net; the separate `ToJson::__well_formed` check recognizes a type asked again in one
    question by its derive's static and its `type_name`, which can coincide for one generic type
    over two arguments of the same printed name, with the same net; a derived `ToJson` writes a
    tool output's schema and its bytes, and a derived `FromJson` a tool input's schema and what it
    reads); platform (Rust 1.89's `TypeId::of` requires `'static`; `typeid` 1.0.3 returns the
    compiler identity without that bound); value (one declaration per direction, Values 4, 5 and 6).

    Revisit when: an example app needs, because the derives refuse its type, a hand-written `ToJson`
    with a `ToJsonSchema` beside it or a `Deserialize` with the opt-in `impl FromJson for T {}`
    (none in `examples/` at the last check), or a JSON seam other than the feed is bounded on
    serde's `Serialize` or `Deserialize` again, or serde or serde_json changes how it writes or
    reads one of the std types Corten writes or reads itself (the `json` tests that compare them
    fail). Drop `typeid` when the standard library can identify types with non-static lifetimes at
    the supported Rust floor.

    Last checked: 2026-11-09, the derives and the agent endpoint's bounds, inputs and outputs, at
    `7965aeab`, the bounds' last change; 2026-11-10, no such impl in `examples/`, at `7197604f`;
    2026-11-10, the std types' and pointers' `ToJson` and `FromJson` against serde's bytes and
    values (`json` tests, and `corten-run` built with `json` alone and with `agent,feed`, serde
    1.0.229 and serde_json 1.0.154), at `479f3f0e`; 2026-11-10, the `tool_cost` count, on `217bce2c`
    with `tool_cost` added and on `6d04bbe6`, which parses only an output that is or holds a
    hand-written `ToJson`, and the release parse's cost on `19fd761c`; 2026-11-10, which outputs are
    parsed, trees, cycles and twelve types that all hold each other included (the agent test of that
    name), at `d4aca597`; 2026-11-18, Rust's static and function address rules, Rust 1.89's
    [`TypeId::of`](https://doc.rust-lang.org/1.89.0/std/any/struct.TypeId.html#method.of), and the
    [`typeid` 1.0.3 source](https://github.com/dtolnay/typeid/blob/1.0.3/src/lib.rs), with the
    `same_printed_types_and_generic_instances_get_separate_definitions` regression at `6d7d2cd92`.

39. <a id="choice-script-checks"></a>**Scripts are type-checked with `strict`, `noUncheckedIndexedAccess`,
    `noFallthroughCasesInSwitch`, `allowUnreachableCode: false` and
    `noUncheckedSideEffectImports`, not `exactOptionalPropertyTypes`.** `strict` is not every
    check `tsc` has. Each of the type-checking options it leaves out (below, chosen or not) was
    tried alone on the runtime, the kit, the examples, the template and the typing fixture before
    any was turned on.
    `noUncheckedIndexedAccess` makes an element read from an array, or a value from a record, by
    index `T | undefined` until the code checks it. It found 76 such reads, two of them bugs: the
    kit's `ComboBox` with no options threw on Enter after Arrow Down, and `rows(..).at(i)` past
    the end gave a view of no row (it is now `undefined` there, as an array's `at()` is,
    negative indexes counting back from the last as they do there). The other 74 were reads a
    loop's bound, a length check or the server's own data kept in range. Outside the runtime's
    hot loops they were rewritten to need no index (`for .. of`, destructuring) or given a
    check; inside them (`view.js`'s loops over rows, `scan`'s over the refs a change adds) they
    keep the loop they had and cast what they read, with a comment saying what keeps it in range,
    since `rows()` with those loops rewritten timed slower (below) and a cast costs nothing once
    minified. A message's parts and the templates the server writes for a format are cast too,
    for another reason: the server writes them in a shape it checks, so a read the cast covers
    cannot miss (not timed). The
    runtime's minified build (esbuild then terser, gzip level 9, against `39060950`): `corten.js`
    14,594 to 14,592 bytes, `format.js` 1,486 to 1,499, and `view.js` 2,186 to 2,196, `at()`'s
    check of the ends.
    `noFallthroughCasesInSwitch`, `allowUnreachableCode: false` and
    `noUncheckedSideEffectImports` each found nothing and cost nothing; a case that runs into the
    next one, code after a `return` and a side-effect import of a module that is not there are
    mistakes the compiler can see. An app, the repository and the browser benchmark's view apps
    use the same checking options: `corten check` writes the app's config with a copy of the
    repository's `jsconfig.json`'s options, and a test fails when any of the three differ.
    This compares options, not compiler versions: apps support TypeScript 6.0 or later, while
    repository checks and the explicit benchmark type-check command in
    [CONTRIBUTING (Tooling)](../CONTRIBUTING.md#tooling) use 7.0.2.
    Not chosen: `exactOptionalPropertyTypes`, which tells a property left out from one set to
    `undefined` (5 errors, none a bug: two were `addEventListener`'s `{ signal }` with
    `signal` possibly `undefined`, which Web IDL reads as left out, and three were Corten's own
    option types, which would need `| undefined` written on each property; the difference it
    checks is one neither a DOM option object nor JSON makes, so it costs annotations and
    catches nothing here); `noPropertyAccessFromIndexSignature` (48 errors, reads such as
    `el.dataset.value` to be written `el.dataset["value"]`, a style that catches nothing a
    record's `T | undefined` does not); `noImplicitReturns` (3, all functions meant to give
    `undefined` on one path, which `strict` already makes each caller handle);
    `noImplicitOverride` (no class overrides anything); and `noUnusedLocals` (0),
    `noUnusedParameters` (1, a handler's `event` named for the reader) and
    `allowUnusedLabels: false` (0), which are lint, not safety: an unused name or label runs as
    written.

    Stands on: measured (`tsc` 5.9.3 with each option alone over `jsconfig.json`'s files on
    `34138ae5`, the counts above, and the minified sizes before
    and after on `39060950`, one build each, the build being deterministic); measured (Chromium through Playwright 1.64.1 on a busy Windows workstation, `bench/browser/rows-ab.mjs` (run
    before it was committed), `rows()` with 1,000 rows, paired medians of 41 samples taking
    turns with `c65c10ec`'s `view.js`: with its loops rewritten not to index
    (`bench/browser/view-unindexed.js` in `f6885eca`, tag `evidence/script-checks-1038`), keeping some rows and making the rest
    was 4.3% to 13.7% slower in seven of seven runs, where `c65c10ec` against itself was -3.0%
    to 4.7%; the noise is too large to time the cast loops, which minify to the code they were,
    `at()` aside); platform (Web IDL converts a dictionary member that is `undefined` as one
    that is not present, and `JSON.stringify` leaves out a property whose value is
    `undefined`); reasoned (a read past the end the checker cannot see is a `TypeError` far
    from the read, as the `ComboBox`'s was); value (Mistakes fail at compile time, Values 4, after the user's speed,
    Values 1, which is why the hot loops cast instead).

    Revisit when: lib.dom's option dictionaries accept `undefined` under
    `exactOptionalPropertyTypes` and a script of Corten's comes to tell a property left out from
    one set to `undefined`, a TypeScript release adds a check that `strict` leaves out, or a
    timing on a quiet host shows the hot loops rewritten not to index cost nothing (their casts
    could then go).

    Last checked: 2026-11-11, TypeScript 5.9.3 on `34138ae5` and the change, the
    sizes against `39060950` (esbuild 0.28.2, terser 5.51.2), and the timings in Chromium
    (Playwright 1.64.1) on 2026-11-08; 2026-11-14, reopened at `727130519` with TypeScript
    7.0.2: its `tsc --help --all` checking options read against this Choice and the options in
    `jsconfig.json`, and `tsc -p jsconfig.json` run. No additional checking flag beyond those
    considered under 5.9.3 changes the choice.
    The equal-options test is not evidence of equal compiler selection.

40. <a id="choice-script-boundaries"></a>**What a script reads from outside the checker is `unknown` and checked where it
    enters, as much as the reader needs; a feed's rows are trusted as the server's.** `tsc`
    checks values whose making it saw, and JSDoc types are erased at run time, so a value parsed
    or read from outside (`JSON.parse`, `res.json()`, storage, another window) is whatever it
    is, whatever its annotation says. Each place the runtime reads one was sorted by who made the
    value. A feed's snapshot and patches are the server's, written by `corten-protocol`, but the
    runtime reading them may not be the one that server ships: a tab left open across a deploy
    keeps the runtime it loaded (its URL is versioned), and a `FeedUrl` can name a route that
    answers other JSON. Their envelope is checked (`crates/corten/js/feed.js`: a snapshot's
    `epoch`, `seq` and `rows`; a patch's `seq` and each change's `op`, `id` and an
    upsert's `value`). A bad snapshot is a failed one (logged, fetched again after the backoff a
    failure gets); a bad patch, whose write is lost, closes the stream and loads the snapshot
    again after a backoff that doubles while the next stream's patches are bad too, so a server
    that only sends bad patches is asked again every 30 s once the backoff tops out. Before, a
    snapshot of another shape reached the script's `snapshot` with no rows (and, unless that
    threw, the stream was asked to resume from `undefined-undefined`); a patch whose changes were
    of another shape moved `seq` on before the script's `patch` threw on them, so its write was
    lost for good; and a patch that was not
    JSON threw in the listener, its write missed until the next patch showed the gap. That is
    correctness, first in the order, against 129 bytes every page pays (measured below). An HTTP error or a body that is not JSON was already a failed
    snapshot, and `EventSource` closes a stream that is not `text/event-stream`, so a proxy's
    error page never reaches either check. The rows are not checked: `Row` is the server's own
    type, the checker holds the script to it, and checking it in the browser would need a
    runtime schema the browser does not have (the Rust client, `corten_protocol::Replica`,
    deserializes rows with the type, since there it has one). A notice the runtime kept in
    `sessionStorage` for a full reload is checked field by field, since storage outlives a
    version of the runtime. Trusted, as the server's or the runtime's own: `data-on` arguments
    (the server writes them into the document the runtime runs in, in the format `wire.json`
    tests both sides against, and markup that could write others could run its own script),
    which `JSON.parse` gives as an unchecked `any` into the argument's type, and the
    `corten:module` event each served module dispatches, which the runtime takes only from the
    module its page's own script tag loaded. Explicit `any` was removed from the runtime, the
    kit, the template and the examples (26 uses): where the DOM library has no type for an API
    (a service worker's global, `navigator.connection`) they declare the part
    they use and cast once where the value enters. TypeScript 7.0.2's DOM library now declares
    the Navigation API, so the former `navigation.d.ts` is removed: only `NavigateEvent.info`
    is narrowed to the runtime's own symbol-keyed `Info` at the listener boundary. The shared
    `RuntimeNavigateEvent` typedef also types `startedBy`, so its separately annotated event
    cannot restore the DOM's unchecked `info`. `scripts/navigation-types.test.mjs` compiles
    misspelled source-property reads inside both functions in memory and requires TS2339,
    without exporting the runtime's private symbol keys for a fixture. The DOM's
    `NavigationResult` dictionary has optional fields; `go` asserts both returned promises,
    which `navigate()` always supplies. These are type-only changes, with the same minified
    runtime. A form's
    property read past a shadowing control is typed by its name (`HTMLFormElement[K]`); a
    format's function is `(value: never) => string`, its branches typed. Typing the Navigation
    API's `info` found a read the checker had not seen: the place a `data-keep-place`
    navigation returns to was read when it could be `null`, kept safe only by the element
    lookup before it, now checked. `scripts/escapes.mjs` (in `npm run check`) reads those
    files with TypeScript's parser and fails on an `any` (or JSDoc's `*` or `?`) in a JSDoc type
    or a declaration file, and on a `@ts-ignore`, `@ts-nocheck` or `@ts-expect-error` comment,
    which belong to the typing fixtures. An implicit `any` (what `JSON.parse` returns, used as it is) is not found
    by it, which is why each parse is listed here. Casts stay: the DOM gives an `Element` where
    the markup guarantees an `HTMLInputElement`, and a cast says so in one place. An app's own
    scripts are not held to this; `corten check` checks them with the same compiler options.
    The runtime's minified build (gzip level 9, against the change before it, `27530e82`):
    `corten.js` 14,592 to 14,794 bytes, of which the feed's checks are 129 (measured by building
    with `snapshotOf` giving its input and `patchOf` the parsed JSON, unchecked) and the rest 73;
    `format.js` 1,499 to 1,492.
    One limit stays: a tab left open across a deploy that changes `Row` keeps the app's script
    it loaded, and the new server's snapshot (a new generation, so the stream resyncs) gives that
    script rows of the new shape. If its `patch` throws on one, that write is lost until the next
    snapshot, since `seq` moved on before the script ran; if its `snapshot` throws, the snapshot
    is fetched again after the backoff. The live-data guide says to keep a deploy's `Row`
    readable by the script before it. Reloading open pages when a feed's generation changes
    would close it, and is not done here.
    Not chosen: validating rows from a schema the server derives (bytes for every app with a
    feed; the rows match the server's `Row` except across a deploy, and there a check against
    the old script's schema would refuse the new rows rather than let them throw in the script,
    so the write would be lost all the same); a schema library (a dependency
    for the few values that come from outside); checking only that a patch is JSON (a change
    without an `id` would reach the script's `patch` and throw in the app's code, after `seq`
    moved on).

    Stands on: measured (each `JSON.parse` and `res.json()` in the runtime and each `any` in
    the scripts, inventoried on `c65c10ec` and `648617e3` (tag `evidence/script-boundaries-1039`), 26 uses on each; the sizes above;
    the check's time next to `JSON.parse` alone, patches of 1, 10 and 100 changes of a
    nine-field row, medians of 15 alternating 100 ms rounds, three runs in Chromium 156 through
    Playwright 1.64.1 on a busy workstation: the full check -1.6% to 8.0% over the parse, and
    `JSON.parse` against itself -8.1% to 6.6%, so the check's cost is within what this timing
    can resolve; the probe is `bench/browser/feed-check-cost.mjs`, committed after those runs, and
    one run of it on 2026-11-09, in Chromium and in Node, gave the check -7.5% to 14.2% over the
    parse and the parse against itself -9.6% to 6.8%); platform (JSDoc and TypeScript types are erased at run time, `JSON.parse`
    returns `any`, `EventSource` fails a stream whose type is not `text/event-stream`, and
    TypeScript 7.0.2's DOM library declares `window.navigation` always present, although not all
    supported browsers have it, with `NavigateEvent.info` as `any` and `NavigationResult`'s promises
    optional. The runtime widens navigation to `Navigation | undefined` at this boundary and
    checks availability before use; `go` casts only after its caller's availability check);
    reasoned (a value the checker
    did not see made is only as typed as its producer: the server's rows are, an older runtime's
    reading of a newer protocol and old storage are not); value (Correctness and reliability
    first, a patch's write never lost without a snapshot; Mistakes fail at compile time, Values
    4; Fast, and proven fast, Values 1, which is why the rows are not checked).

    Revisit when: TypeScript's DOM library gives `NavigateEvent.info` a checked type or changes
    the Navigation API shapes the runtime uses; the browser gets a
    way to check JSON against a schema without a library; or a feed carries rows the server did
    not type (a feed relayed from another service); or open pages reload when a feed's generation
    changes, which ends the limit above.

    Last checked: 2026-11-11, the sizes against `27530e82` (esbuild 0.28.2 and terser 5.51.2) and
    `scripts/escapes.mjs` on the change; 2026-11-10, TypeScript 5.9.3 on `560c4cf7` and the change
    (the explicit-`any` count, 26 and 0); 2026-11-08, TypeScript
    6.0.3 on the change, which checks clean, and the timings in Chromium 156 (Playwright 1.64.1),
    again on 2026-11-09; 2026-11-14, reopened for TypeScript 7.0.2 on `4cbc5e627` and the change:
    its DOM declarations read, the redundant Navigation API declarations removed, the runtime
    type-checked and its minified build checked unchanged, and the existing unsafe-escape
    fixtures run through TypeScript 7's native parser API; 2026-11-14, TypeScript 7.0.2 on
    `c34532753` and the change: the helper's unchecked `info` reproduced by the compiler probe,
    then both helper and listener checked through the shared event typedef and the probes;
    2026-11-14, at `727130519` and the change: the optional Navigation API boundary restored,
    with a compiler probe requiring TS18048 for an unguarded read;
    2026-11-14, at `630ceb703` and the change: dialog and toaster use lib.dom's Navigation
    types rather than hand-declared shapes, with an optional boundary for older browsers.
    Their scripts and the runtime checked with TypeScript 6.0.3 and 7.0.2 (both pass).

41. <a id="choice-tcp-nodelay"></a>**Each TCP connection Corten accepts has Nagle's algorithm off.** Corten's
    `Listener` for tokio's `TcpListener`, which `serve`, `serve_on` and `serve_wrapped` accept
    from, sets `TCP_NODELAY` on each connection, as Go's `net` package (so `net/http`) does on
    every TCP connection and nginx (`tcp_nodelay on`) on its keep-alive, TLS and unbuffered ones;
    hyper sets nothing on a server's connections. A whole answer goes out in one write, so pages
    and JSON are the same either way. A streamed one (a feed, a `LiveResponse`, a `Relay`,
    `Media::stream`) writes each piece as it comes, and with Nagle's algorithm the small writes
    made while one is unacknowledged wait for that acknowledgement and go out together: a round
    trip for each such batch wherever the other end is (a browser on a slow network included), and
    more when the other end delays its acknowledgement, as Linux does by 40 ms or more. Measured
    with `bench/nodelay` (ten events of about 50 bytes, nginx with the deploy guide's upstream
    keep-alive, the app, nginx and the client each in a container of its own), when nginx reused
    its connection to the app right after its last stream the second event came 42.5 and 43.0 ms
    (the medians of two runs of 80 streams) after the first when the app made them back to back,
    40.9 and 40.8 ms with 1 ms between them and 31.8 and 32.7 ms with 10 ms, and every event made
    before the acknowledgement came with it; with the option set, -0.1, -0.05 and -0.01 ms. With
    the option set, 6 of 1,800 streams (Corten's listeners and a copy that sets it itself, busy and
    after idle) had an event more than 20 ms late, at most 29.9 ms, and none had its second event
    held, against nearly every busy stream without it. Of 644 streams on a connection unused at
    least 150 ms, 6 had an event more than 20 ms late (at most 33.1 ms), 2 of them with the option
    set, so a connection unused a few hundred milliseconds was not shown delayed either way. The
    first event came with the head (more than 20 ms after it in 3 of 3,600 streams, at most
    29.9 ms); that it is never held rests on the packet capture, where it was in the head's
    segment: of 87 bursts without the option, 75 had their second segment 40.2 to 46.5 ms after
    the first, each within 0.1 ms of nginx's acknowledgement. It costs one system call a
    connection and nothing a request: callgrind counted a keep-alive request at 26,418 and 26,415
    instructions before and 26,423 and 26,417 after, and a request on a connection of its own at
    46,484 and 46,847 before and 46,481 and 46,740 after, within what runs of one build differ by.
    A listener of the app's own sets what it chooses; one that wants Nagle's algorithm calls
    `set_nodelay(false)` on what it accepts. A failed `set_nodelay` is not logged: it is not
    expected on an accepted TCP socket, and the connection is served as it would have been before,
    so a log line would give nothing to act on.
    Not chosen: leaving Nagle's algorithm on (tens of milliseconds on a live page's events behind
    a proxy, and a round trip a batch to a browser without one); a setting on `App` (a new concept
    for what one line in a listener of the app's own does); holding pieces back in Corten to join
    them into fewer writes (the pieces are made apart, and waiting for the next is the delay
    itself).

    Stands on: measured (`bench/nodelay`, two runs of each build alternated, 20 rounds of five
    streams per app and gap each, on Docker Desktop's Linux 6.18 VM on a workstation running other
    builds, `results/before-*.json` and `results/after-*.json`, and one packet capture of 87
    bursts, observed once and not committed; callgrind on `what_a_request_over_tcp_costs` in the
    crate's tests, at 200 and 1,200 requests, two runs of each build alternated); platform (Nagle's
    algorithm holds a small write until the last is acknowledged, RFC 896; Linux, the app's and
    nginx's, delays the acknowledgement of a small segment, 40 to 46 ms in the capture; Go's `net`
    package and nginx set `TCP_NODELAY` by default; hyper sets nothing on a server's connections,
    and hyper-util only on its client's); reasoned (Corten writes whole answers, and a stream's
    pieces as they are made, so Nagle's algorithm has little to join and costs a wait where it
    does); value (a live page's events reach the user as they are made, Values 1, with no setting
    to find, Values 7).

    Revisit when: hyper or tokio sets `TCP_NODELAY` on accepted connections itself, when the line
    goes as redundant; or a measurement of a workload of many tiny writes shows the extra packets
    cost more than the waits they avoid. A peer that does not delay its acknowledgements is not a
    reason: the writes made while one is unacknowledged still wait a round trip.

    Last checked: 2026-11-11, `bench/nodelay` with nginx 1.29.8 on Docker Desktop's Linux 6.18.58
    VM on this branch with and without the line (its Rust as at `a833b4e3`), and callgrind
    (valgrind 3.19.0, rustc 1.99.1) on `efbd210d` and the change; 2026-11-11, hyper 1.12.0 and
    hyper-util 0.1.21 (`Cargo.lock`) read for `nodelay`, with nginx's `tcp_nodelay` documentation
    (nginx.org, for 1.29.8) and Go's `net` package documentation and source on its master branch
    (`TCPConn.SetNoDelay`, "The default is true"; `newTCPConn` sets it); 2026-11-20, a short
    `bench/nodelay` run on nginx 1.31.9 with one build as at `4225a2837` (2 rounds of 2 streams,
    gaps 0 and 1 ms, the `default`, `on` and `off` listeners, not a build without the line): in every
    `default` and `on` burst the first event came within 20 ms of the headers and no later event was
    over 20 ms late, and in all four busy `off` bursts the second event was 39.9 to 44.1 ms late
    (its gap after the first event at the client less that gap at the app).

42. <a id="choice-locale-same-language"></a>**A negotiated locale is RFC 4647 Lookup, then a step of
    Corten's own: a range Lookup matches to nothing takes the first listed locale of its
    language.** `negotiate` takes the `Accept-Language` ranges highest `q` first and runs each
    through Lookup (RFC 4647, 3.4): the range, then the range without its last subtag (and a
    single-character subtag before it) until a listed locale is named. Where none is, it takes the
    first listed locale whose primary language is the range's before the next range is tried.
    Lookup has no such step. It never returns a tag more specific than the range ("de-ch" can give
    `de` or `de-CH`, never `de-CH-1996`), and it processes every range before the default (3.4.1),
    so the step departs from it twice. First, `fr` gets a listed `fr-CA` where Lookup would give
    the default. Second, the step runs before a lower range, so with `en, fr-CA` listed,
    `fr-FR, en;q=0.5` gets `fr-CA` where Lookup would give `en`. An app that lists a regional form
    without the bare language (`fr-CA`, or `pt-BR` alone) gets those readers to their language,
    which was what `negotiate` did before Lookup was added
    ([#1234 Locale negotiation jumps from an exact tag straight to the primary language, so zh-Hant-TW gets zh and sr-Latn-RS gets sr when both are listed](https://github.com/corten-run/corten/issues/1234)).
    The cost: the step does not read the script, so with `en, zh-Hans, zh-Hant` listed and no
    `zh`, `zh-TW, zh-Hant;q=0.9` gets `zh-Hans`, the first `zh` locale, before `zh-Hant` is tried
    (`negotiation_takes_the_same_language_before_a_lower_range`); the views guide tells an app
    with Traditional Chinese readers to list `zh-TW` and `zh-HK`, which Lookup then matches.
    Not chosen: Lookup alone (a reader of `fr` gets the first locale, often English, from an app
    that has French); the step after every range, as a computed default (3.4.1 allows the default
    to search further), which would send `fr-FR, en;q=0.5` to `en`; filling in a range's likely
    script before Lookup (CLDR's likely subtags, `zh-TW` to `zh-Hant-TW`), which fixes the `zh`
    case but is a table Corten does not carry.

    Stands on: bet (an app lists a regional form of a language without the bare one more often
    than it lists two scripts of one language without either's region, and a reader would rather
    have a listed form of their language than the app's first locale); platform (RFC 4647, 3.4,
    Lookup never returns a tag more specific than the range, and 3.4.1 processes every range
    before the default and lets the default search further); reasoned (the step runs only when
    Lookup names nothing for a range, so an app that lists each tag its readers send gets Lookup's
    answer); value (a reader gets a page in their language without the app listing each region,
    Values 7, at the cost of a departure from the standard that this Choice records, Values 2).

    Revisit when: an app reports readers given another script or region they did not ask for by
    the step (the `zh-TW` case above), or Corten takes CLDR's likely subtags for another reason,
    when the step can match a range's script before taking the first locale of its language.

    Last checked: 2026-11-11, RFC 4647 sections 3.4 and 3.4.1 read against `negotiate` as at
    `09a9cd5d6`, and the step's cases run in its tests.

43. <a id="choice-no-npm-launcher"></a>**No npm initializer: an app starts from the `corten`
    command, installed with Cargo, and `create-corten` only says so.** A `create-corten` package,
    which `npm create corten` runs, could download the prebuilt `corten` of its own version and
    run `corten new`, so a developer coming from JavaScript could start with a command they know
    ([#872 Evaluate optional npm onboarding through a launcher for the existing Corten CLI](https://github.com/corten-run/corten/issues/872)).
    Corten publishes no initializer that creates an app. The app it would write is a crate that
    builds with Cargo, and `corten dev`, `check` and `fmt` are the command's, which Cargo installs
    (`cargo install corten-cli`, or `cargo binstall corten-cli` for the prebuilt binary), so the
    package would take the place of `corten new` and leave every other step of getting started as
    it is: the common case is no shorter, and installing Rust, which no npm package does, is the
    same either way. Against that it is a second way to start an app and a release channel to
    keep: a Node script outside the runtime that downloads an executable and runs it; a package on
    a second registry at the crates' version, where a published version cannot be replaced, as on
    crates.io; a publish step after crates.io's that can fail on its own, leaving the crates at a
    version npm does not have; a trusted publisher npm sets up only for a package that already
    exists, so its first version is published by hand; and a test of each of those on every
    platform. Such a launcher would also have to check the binary before running it. Its publish
    step could write each archive's sha256 into the package from the same run's builds, so that
    is a constraint on its design, not a reason against it. The release workflow now gives its
    archives GitHub build provenance, verified before any crate is published or the GitHub
    release is created, and a plain `SHA256SUMS` file (which detects a changed or damaged
    download, not who built it), which closes the manual-download half of a gap of its own
    ([#1286 The release's corten binaries carry no checksum, signature or build attestation, so a cargo binstall or manual download has only HTTPS to trust](https://github.com/corten-run/corten/issues/1286)).
    `cargo binstall` does not consume that file or GitHub attestations; it verifies only a
    minisign signature, which Corten chooses not to add
    ([Choice 49](#choice-release-verification)), so it still has only HTTPS,
    and verification before installation uses the
    [manual download](guide/getting-started.md#verify-a-prebuilt-binary) (cargo-binstall
    1.27.0's `SUPPORT.md` and `SIGNING.md`, read 2026-11-13).
    That evidence does not make an npm initializer's extra channel or lifecycle any smaller.

    The name is held all the same, as the [release runbook](../RELEASING.md#publishing-and-ownership)
    says to hold `corten` on crates.io should it come free ("take it only so no one else can"):
    `npm create corten` runs whatever `create-corten` holds, so with the name open anyone could
    make it run their code.
    `create-corten` is a placeholder, published once by hand, with no dependencies or install
    scripts, that creates nothing: it prints the three steps (install Rust, `cargo install
    corten-cli`, `corten new <name>`) and a link to the getting-started guide, and exits with
    status 1, so a script that goes on into the app stops. Holding it moves the risk from anyone
    who publishes the name to whoever takes over the account that holds it. That account requires
    two-factor authentication, and the package refuses tokens and has no trusted publisher, so it
    changes only through a person signed in. No release publishes it; a move of the guide is a new
    version of it, by hand.

    Not chosen: an initializer that also installs the command, a second installer for a binary
    Cargo already installs; the pattern esbuild and Biome use, a package that depends on one
    package per platform holding the binary (`npx corten dev`), where npm checks each download
    itself, but six packages are published at every version beside the crates and the app still
    builds with Cargo, so it moves the `cargo install` line to npm as a second way to install the
    command; and leaving the name open, which keeps no package but lets a stranger's code answer
    the npm convention.

    Stands on: platform (on the npm registry `create-corten`, `createcorten`, `corten` and
    `corten-cli` have no package, the `corten` scope is held by an account that is not the
    project's (its package list answers, empty) and the `corten-run` scope does not exist, so the
    unscoped `create-corten`, which `npm create corten` runs, is the only natural name, and it is
    open to anyone); platform (npm gives names first come, first served, counts a package with no
    genuine function as squatting and may remove it, and moves a name only on a trademark or like
    claim, never on request; it sets up a trusted publisher only for a package already on the
    registry); bet (npm counts a package that tells a developer how Corten is installed as having
    a function, and does not remove the placeholder as squatting); bet (what stops a developer who
    knows JavaScript from trying Corten is installing Rust, which an npm package does not do,
    rather than the `cargo install` line, and the issue proposing the package came from the
    project, not from someone who stopped there); reasoned (an app `corten new` writes is an
    ordinary crate, and its other commands are the `corten` command's, so an npm initializer moves
    `corten new` and leaves the getting-started guide's other steps on Cargo); reasoned (with the
    name open, `npm create corten` runs a stranger's code with no account taken over; held, it
    takes a person signed in to one account with two-factor authentication, the kind of risk the
    crates carry on crates.io, on one more account); value (a release that can stop between two
    registries, one at the new version and the other not, puts its reliability at risk, first in
    the values' order; an initializer is a second way to start an app, Values 5, under one way to
    do things, third in the order; a second channel and a script that runs a downloaded binary
    have to earn their place, Values 6; and a channel that leaves the common case as long does not
    make it shorter, Values 7, so it gives only developer convenience, last in the order).

    Revisit when: an app made by `corten new` can be run, reloaded and checked with no command
    Cargo installs, so an initializer would be the whole of getting started; Corten publishes
    something on npm for another reason, so a channel, its publisher and its recovery are already
    kept; someone outside the project asks for `npm create corten` to create an app, or reports
    giving up at the `cargo install` line; or `create-corten` is not the placeholder: another
    account published the name first, npm removes the placeholder as squatting, or a version the
    project did not publish appears. Corten cannot place a placeholder on a name another account
    holds, so then the getting-started guide warns that `npm create corten` is not Corten's and
    that Corten is installed with Cargo, and a package that runs anything beyond printing is
    reported to npm as malware (npm does not hand over a name on request); after a takeover of the
    project's account, the account is recovered, its sessions revoked and the version reported.

    Last checked: 2026-11-12, the npm registry (`npm view` of the four names, the `corten` and
    `corten-run` scopes' package lists) and npm's trusted-publishing, `npm trust` (npm 11.21.2) and
    name-squatting documentation, read at `684a5395f`.

44. <a id="choice-slow-part-link"></a>**A slow part is read by the page's own handler once the page is
    on the screen (`ReadAgain::now`, `req.patch_or_with`), by a script module only such a page
    loads; where no read brings it, it is a link the app writes to its own page with a query field
    that reads the part in, not a marker Corten reads.** A page that should not wait for a slow read
    (a visitor's picks, a partner's prices) draws the part waiting with `{ReadAgain::now(route)}`
    inside it (`<p id="picks">Finding picks...<template data-corten-read-now data-from="/"></template></p>`):
    the part is the element the tag is in, which needs the id its patch replaces, so the tag and
    its part leave and arrive together, and a `<template>` is allowed in every element a part may
    be (`ul`, `table`, `tr`). Once the page is on the screen, and when a page's or a form's
    answer puts such a tag on it, the runtime fetches `data-from` as a part read again is (a GET
    with `corten: action`) and applies the patch it answers. A page the browser prerenders reads
    its parts once it is shown, not before: the server's slow read is for a page someone sees. The
    route is the page's own and says `patches` ([Choice 50](#choice-patch-routes)), and its
    handler answers both with `req.patch_or_with(part, page)`: two closures, of which
    `Mode::Action` runs the part's and every other mode the page's, so neither runs a read only
    the other draws. Before, the part was a `<corten-live>` stream of one item: a route of its
    own, a handler that repeated what the page reads (the visitor, the list) and a second waiting
    state, the stream's
    ([#1400 A slow part costs a second route, a stream handler that repeats the page's read and two waiting states, where one handler could answer the page and its part](https://github.com/corten-run/corten/issues/1400)),
    and a `patches` route could not answer a part that needs a read of its own without building
    a patch it would not send
    ([#1462 A patches route's handler whose part needs its own read cannot answer its page without building a patch it will not send: only patch_or turns a page into HtmlResult<Patches>, and it takes the patch already built](https://github.com/corten-run/corten/issues/1462)).
    The part closure receives the checked `Action` and builds its patch with `action.patch`
    or `action.patch_with_status`; the page closure receives no builder. The result keeps the
    sealed patch-answer kinds, `AnyAnswer` or `Patches`, never a data screen. This closes the
    unchecked page-side construction gap shared with `patch_or`
    ([Choice 58](#choice-plain-request-patch)), without changing the runtime's read or the
    page's fallback. Deliberate mode overrides and raw responses still meet the debug check.
    Tags with the same `data-from` in one page or patch are read once, so two parts one read
    draws share it and its patch replaces both; each then waits for the slowest of what that read
    does, so independent slow parts take a query field each, one address each. A page in a
    `Public`, which shared caches give to anyone, has its part read for anyone too, so a part read
    for one visitor there is read from a route of its own. The answer varies on `corten`, as every
    page and patch does, so a cache keeps it apart from the page at the same URL, and a prefetch (a
    link's, Speculation Rules) gets the page, which reads no part. The read is a `fetch` from the
    page's own origin, which the CSP's `default-src 'self'` allows, and the tag is a
    `<template>`, not a script.

    The reads are `js/part.js`, served beside the runtime (`/corten/{version}/part.js`, versioned
    and cached with it, and precached by an app's service worker), not in the runtime every page
    loads: rendering the tag notes the module (`script::uses`, as a format argument notes
    `corten-format`), so the page's head preloads it with the runtime, its preload marked
    `data-corten-part`, and a navigation's answer carries the preload, which the runtime moves into
    the head. The runtime holds only what starts the module: when the page loads with that mark in
    its head, or when markup the server sent or a script's `patch` has a tag (a search of its
    text for the attribute's name in any case, made as the runtime parses it: the server's goes
    through the runtime's Trusted Types policy, a script's `TrustedHTML` a policy the page allows
    made, which the runtime does not put through its own), it imports the module, whose fetch the
    preload has already started, and hands it the two things only the runtime has: the function
    that draws a patch through that policy (`trusted-types corten` admits one policy, the
    runtime's, so the module cannot draw markup itself) and the busy marks it shares with forms.
    From then on the module finds every tag itself, with a `MutationObserver` of the page: a
    navigation's page, a form's answer, a `<corten-live>` fragment, a layout element a write's page
    draws again in place. Served beside the runtime, not with the app's scripts, so an app with no
    static files or components has it too. The runtime is 15,612 bytes gzipped and 14,100 brotli
    at `051f040ef` (15,568 and 14,060 on main at `7d9bbbf1e`, so 44 and 40 more), and the module 1,534 and 1,359; those 44 bytes are the import, the hand-over, the search
    of a markup's text (the server's or a script's patch), the query of the head on load and the
    call that shows a part's read what its `apply` parsed (`own`, below), which every page
    runs (a search of text already in hand, one query of the head, one test of an argument) and
    which a page without a slow part ends there. The same code was 57 and 63 more at `2d697e24d`
    than main at `b0c2abd4d`, before main's runtime read the DOM through its prototypes
    ([#1567 Protect runtime DOM access from form controls named after members](https://github.com/corten-run/corten/pull/1567));
    it compresses better beside that code, not smaller. Against that main, the figures that follow:
    without that call it would be 55 and 49 more than main; a method `o` of the call's signal (round 16) cost 59 and 51, but a script's `patch()`
    passes its own signal, so a script's signal with an `o` refused the patch or was shown its
    markup (round 17); the parsed patch kept on `apply` for the module to read after the call
    (round 15) cost 59 bytes gzipped (56 brotli) but was shared by every call, a seventh parameter
    of `apply` 61 and 59, a test of `own` as a function in `apply` rather than in its parse 61 and
    60, a key of a `WeakMap` the runtime hands the module 68 and 55, a private `Symbol` 73 and 70, a
    method named `parsed` 60 and 58, a variable of the runtime read through a function handed to
    the module 69 and 69, a call into the module with it 73 and 73, and a second read of a part
    read's `signal.aborted` once its answer was drawn (round 14) 63 and 68 with the search; a search for the name only after a space or a `/` cost 5 bytes more than one
    for the name alone, and missed one written straight after a quoted value, which HTML also
    reads as an attribute; measured the same way. A name in the text that is no tag (a page that
    shows the markup) only fetches the module, which finds nothing to read. With
    the module's discovery and its failure marks in the runtime instead, as at `73279ab7a`, it was
    15,631 and 14,094, and with the reads in it too, 16,685 and 15,059 at `cd6861c76` (Stands
    on). A page without a slow part fetches nothing more, except once, when a PWA's service worker
    installs and precaches the module with the runtime. A stub that started the fetch before the
    module arrived was not needed: the module is preloaded with the page that needs it.

    The read depends on its part alone: a patch of another element meanwhile (the next cell of a
    grid, a live row of the same list, another part read first) changes nothing. While the read is
    on its way the module marks the part `aria-busy="true"`, as the runtime does a form and a
    navigation, and takes its mark away when the read ends, unless a submit marked it since
    (whoever marked an element last clears it, as between a submit and a navigation). Every part
    still on the page when its read ends was not drawn, and is marked `data-corten-read-failed`:
    offline, the server unreachable, an error page, a page, a patch without it, or a redirect. A
    read is its tag's at its address: it stops once one of its tags leaves the page (a form's
    answer replaced its part, a page was swapped in, or a layout element kept in place, a live
    region, took new children with a new tag) or is drawn again with another `data-from` (a
    layout element keeps the tag and draws its attributes again, as when a form's whole page
    switches the account the part is for). Its fetch ends, its answer is not drawn over what is
    there now, even once its stylesheets load, its other parts are marked at once, and a tag at
    a new address is read there, whatever the old one's read did (a failure at the old address
    does not stop the new). The runtime's `apply` reads its signal's `aborted` once, right
    before it draws, after the patch's stylesheets have loaded; the module's signal looks then
    whether every tag is still on the page at its address, so an answer drawn first in the same
    task (a form's, waiting for the same stylesheet, that replaced the part) stops it before any
    observer could hear of it. A part a layout element holds with the same tag at the same
    address keeps its read, and one whose read failed there stays failed, even when the element
    draws the part's own attributes again and so takes away the marks the module put on it: the
    module knows each tag's read and failed address, and puts the busy or failed mark back rather
    than read it again. A redirect (a sign-in's `corten-location`) is not followed: the part is
    marked and its link, a navigation, follows it, as without JavaScript. Following it would take
    a user who is typing elsewhere on the page away unasked, from a read that only the page's own
    stage or extractor could redirect (the part side answers `HtmlResult<Patches>`, which cannot),
    and which answered the page itself a moment before; and it needed the runtime to know whether
    a navigation had started since the read began (a `beforeunload` listener while a read lasted,
    counts in its navigations, Firefox's ends of a page's fetches as it begins to leave), the
    source of most of the edge cases the review of
    [#1483 One handler answers a page and its slow part: ReadAgain::now and Req::patch_or_with](https://github.com/corten-run/corten/pull/1483)
    found. A read the browser ended by hiding the page (its back-forward cache) is made again
    once the page is shown, if its parts are still there at their addresses. A tag in an element
    with no id, which no patch could replace, is logged and that element marked, as the runtime
    logs a patch's element with no id.

    Reads do not chain: a part waiting in the answer to a part's read is marked failed rather than
    read, so two parts whose answers draw each other waiting cannot read each other without end
    with no delay; a part's own slow part is read in by the link's page. The module knows which
    tags an answer drew from the elements of its markup, before anything else can run: the
    runtime's `apply` parses a patch as soon as it is called and, before it links a stylesheet or
    loads a module the patch needs, hands what it parsed to its `own` argument when that is a
    function, which only a part's read passes: the module has `apply` from the runtime, which never
    exports it, and a script's `patch()` passes `false`, its signal only a signal, whatever
    properties it has. A part's read passes a function that takes the waiting tags in that markup (those
    in its elements and in the content of a template that appends, not those in any other
    template's content, which never joins the page). The markup goes from the call to its own read
    and nowhere else, so nothing keeps it once the call is over (drawn, cancelled, aborted, or
    with no target on the page). Those elements, and no others, are marked failed when the page
    gains them; a part anything else draws waiting is read, whatever its address and whenever it
    joins the page: one a form's answer or a part read again
    draws in the same task right after it (both waiting for one stylesheet), in place of a tag the
    part's answer drew or beside it once it removed it, one at an address only a template's
    content in the part's answer names, and one a script draws while the answer is drawn, from a
    callback its drawing runs (`focusin` as the focus moves to the answer's field, a custom
    element's `connectedCallback`, even a stylesheet link's in the answer, which runs as the
    runtime links it, before the answer waits for it). Not chosen: every change in the observer's next batch counted
    as the answer's, which marked such a form's part failed without reading it (the review of
    [#1483 One handler answers a page and its slow part: ReadAgain::now and Req::patch_or_with](https://github.com/corten-run/corten/pull/1483),
    round 13); the addresses of the tags the answer's text writes, the first tag the page gained
    at each counted as the answer's, which counted a newer answer's tag at the same address, or one
    at an address only template content in the answer wrote, as the part's answer's, and marked it
    failed unread (round 14); and the changes the page made between a read of the answer's
    `signal.aborted` right before it is drawn and a second right after, counted as the answer's
    because no other answer runs in that task, which also counted what scripts the drawing calls
    back draw in it, synchronously, as the answer's (round 15); and the patch `apply` parsed last,
    kept on `apply` and read by the module right after its call, which a script's patch made from
    a stylesheet link's `connectedCallback` as `apply` linked it had already replaced, and which
    kept a cancelled answer's markup until the next patch (round 16); and a method `o` of the
    call's signal, which a script's `patch()` passes as the script gave it (round 17). A part a periodic read's answer (`ReadAgain::from`), a `<corten-live>` fragment or a
    script's `patch` draws waiting is read, as one a form's answer draws is: what draws it is not
    a part's read, so it sets the pace (its interval, a stream's fragments, a user's submits), and
    one that draws the part again ends the read the one before started, so one read at most is on
    its way for a part. A page whose head asks to be read again (`ReadAgain`) is read on its
    interval, whatever its parts' reads: read whole with a changed `<main>`, the page draws its
    part waiting again, which ends the read on its way and reads the part again, so a part slower
    than the interval never comes, and the page's interval is chosen with room for it. Putting
    the page's read off once while a part's is on its way, as the runtime did before, cost every
    page 33 bytes gzipped (9 brotli) more, measured with `scripts/build-js.mjs`'s esbuild and terser
    settings and Node's `zlib`; reading a page again faster than its own slow part is the app's
    interval to change.
    A part's answer that asks to be read again (`ReadAgain::from`) places its tag as any patch's
    is (in place of the tag beside what it drew, or kept off the page and still read), so such a
    page goes on being read whole too; placing it inside the part, so the page knew, and hardening
    `ReadAgain::from`'s own reads (stopping a read whose parts left, a check after its
    stylesheets load) are changes to `ReadAgain::from` of their own, not this Choice's. Not
    `aria-busy="false"` for a failure: busy says whether an element is being updated, and false
    is also the state of every element that is not, so it would say no more than the mark's
    removal does. A `data-` attribute, as Values 2 extends a standard: the waiting element is the
    app's, any element, where an attribute of Corten's own like `<corten-live>`'s `status` is
    valid only on Corten's element; `corten-` is the runtime's prefix, as on the tag.

    The waiting part holds a link to the page's own route with a query field whose handler branch
    reads the part in (`url::Home { picks: Some(true) }`, `rel="nofollow"`), as an address already
    says what a page reads (the receipt a page waits for): nothing of Corten's own in the URL. The
    link shows unless a read is bringing the part: the component's CSS hides it, and shows the line
    saying the part is on its way, under the part's `[aria-busy]`, which only the part module sets.
    So it shows without JavaScript, when the runtime or the module never runs (blocked by an
    extension or the CSP, a 503 for `part.js`) and once the read has failed, with no code of the
    runtime's for any of them, and in every browser, as no media query decides it. The cost is the
    link drawn from the first paint until the module marks the part busy, a moment on a load, as
    the module runs once the page is parsed; in the line's place (one grid cell of the part in the
    watchlist's CSS, both there, the hidden one with `visibility: hidden`), the swap moves nothing
    around it. Corten draws no link: the server would draw it from a
    label only the app has, which is the link the app writes; and a query parameter Corten reads
    on every page would be a second way for an address to say what a page reads. The cost is one
    field plus one handler branch per page with a slow part (other links name the page through its
    route's `Default`, `url::Home::default()`), and the address the link opens waits for the slow
    read wherever it is opened, with JavaScript too. One case is left with the line and no link: a
    read the server never answers, which stays busy as a form's submit does, since Corten sets no
    timeout of its own.

    Not chosen: a `<corten-live>` stream of one item, the shape before, which also left a
    stream that ended after a fragment that failed to apply, or was dropped each time before the
    part was sent, with the line and no link; the tag beside the part naming it by its
    `#[derive(Id)]` type (`data-part`), which kept a typed name but let tag and part leave the page
    apart, so a read had to track which of them was still there and where an answer's tag went;
    the elements with an id beside the tag as its part, as `ReadAgain::from` reads them, which in
    a grid of cells made every cell busy and showed the failure link for good when any cell was
    patched during the read; the reads in the runtime, which every page would load for the few
    with a slow part (Values 1); the runtime finding the tags itself (a query of `<main>` and the
    layout elements it drew on each swap, a search of each patch's text) and marking every part
    failed when the module did not load, 224 bytes gzipped (169 brotli) on every page at
    `73279ab7a`, with the link hidden under `@media (scripting: enabled)` and shown again under
    `[data-corten-read-failed]`, which needed that mark from the runtime and showed a browser
    without the `scripting` media feature both the line and the link; following a part read's
    redirect (above); a header of Corten's own
    for the part's read, where `corten: action` already asks for a patch; the link in a
    `<noscript>`, which a browser with scripting on never draws, so it would never show for a read
    that failed; declarative shadow DOM, whose slots place a part streamed later without a
    script only at a slot of a shadow tree around the page, as a child of a host still open
    ([Choice 7](#choice-whole-pages)); and Chromium's `<template for>`, which places a part
    streamed later in the page's response anywhere in its markup but in Chromium alone: without a
    script, Firefox and WebKit keep the part's fallback for good, so the page would still need the
    link this Choice draws (Values 3), the part would cost the page its status and headers, and
    the runtime would have to place it itself in those engines and on its navigations, which no
    engine's default streaming setter does yet ([Choice 7](#choice-whole-pages)).

    Stands on: bet (an app has a slow part on few of its pages, so a field on each of those costs
    less than a marker Corten reads on every request); measured (`npm run build:js`'s
    `js/dist/corten.js` and `js/dist/part.js`, gzip level 6 and brotli level 11 by Node's
    `zlib`: the runtime 15,612 and 14,100 bytes and the module 1,534 and 1,359 at `051f040ef`,
    against 15,568 and 14,060 for the runtime on main at `7d9bbbf1e`, so a page without a slow
    part loads 44 bytes gzipped more than on main; and against 15,407 and 13,925 on main at
    `b0c2abd4d`, 15,464 and 13,988 at `2d697e24d` (57 more), 15,631 and 14,094 with the discovery
    in the runtime at `73279ab7a`, and 16,685 and 15,059 with the reads in it too at `cd6861c76`,
    224 and 1,278 more); platform (`aria-busy` means the element is being updated, WAI-ARIA
    1.2; the elements a patch draws are the ones its parse made, moved into the page, not copies,
    so the objects the module takes before the patch is drawn are the ones the page gains, and a
    `<template>`'s content is a fragment of its own, which no query of the patch's elements
    enters, DOM standard; a page drawn in one task is not drawn by its answer alone, since the
    drawing calls back into the page's scripts (focus events, custom element reactions, among
    them a customized built-in stylesheet link's as `apply` links it, before its first `await`),
    which may draw too, so only what is handed from one call to its own read is that read's,
    HTML standard; continuations waiting for one
    promise run in one microtask checkpoint, so another answer waiting for the same stylesheet
    draws right after it, before the observer is told, ECMAScript jobs); reasoned (the runtime's read sends `corten: action`, which is `Mode::Action`, so a handler that picks its
    side by mode answers the read with the part and every other request with the page; the page's
    handler can call the read the part's side calls, so reading the part in is a branch on the
    field; the link is in the markup with JavaScript too, and shown unless the module marks its
    part busy, so no runtime step draws, removes or shows it);
    value (a page works without a script, Values 3, where a part only a script reads would never
    come; one handler serves the page and its part, with one waiting state, Values 5).

    Revisit when: the repository's examples and the Chase Sets pilot between them write such a
    field and handler branch on three or more routes (one, watchlist's home, in this repository);
    or the link drawn before the module marks its part busy is seen on a load (a smoke check or a
    report of it), when the part's waiting state would be the runtime's to draw again; or Firefox and WebKit, as Chromium does, place a part
    streamed later with HTML alone inside the page's own markup ([Choice 7](#choice-whole-pages)).

    Last checked: 2026-11-16, the picks read once on load and again after a navigation back, busy
    while their read is on its way, a patch that leaves them as they were, a failed read, an error
    page and a redirect marked with the link shown and the page left where it was, the link's page with the
    picks read in, the part module fetched once by the page with the picks and never by one
    without, two parts one read draws and one of them removed while it is on its way (the other
    marked at once), a part replaced while its answer's stylesheet loads, a part a patch appends,
    only the part busy with a cell and a live row beside it patched during its read and a form
    whose controls shadow what the runtime reads drawn as a part, a part waiting in a part's answer
    marked failed and not read and one in a part read again read, a part a form's answer draws
    waiting in the task a part's answer is drawn (one stylesheet held for both) read and the one
    the part's answer draws not, a tag in an element with no id
    logged and its element marked, a page read again on its interval while its part's read never
    ends, its part drawn waiting again and read again, a read cut by a hidden page read again when shown
    and not over a part a form replaced meanwhile (`pagehide` and `pageshow` dispatched by the
    test), a client navigation away leaving nothing marked, a page left whole and come back to with
    its part, a part in a layout element that is the page's, a part in a live region around
    `<main>` drawn in place by a write's page and by its read again with `<main>` unchanged, a
    part that is itself a live region kept in place with a new tag while its first read is held
    (the new tag read, the first read cancelled and its late answer not drawn), a part a kept
    element holds as it was keeping its read and a failed one staying failed, and the same with
    the part's own attributes drawn again (busy while its read is held, or failed, and not read
    twice), a part's answer and a newer patch that replaced the part waiting for one stylesheet
    (the newer drawn, the answer not), a part replaced while its answer's stylesheet is held
    ending its read before the stylesheet loads, a tag a kept element draws again with another
    address read there (its held read at the old address cancelled and its answer not drawn, and
    a failed read at the old address not stopping it), a part a script draws as a part's answer
    is drawn, at once from the `focusin` of the focus it moves to the answer's field or from a
    custom element in the answer's `connectedCallback`, a microtask later, or with a patch of its
    own, read (2026-11-17), one a script's patch draws from the `connectedCallback` of the
    answer's stylesheet link (a customized built-in, in Chromium and Firefox; WebKit has none)
    read and the answer's own still marked failed, and no parsed patch kept by anything once its
    part left while it waited for its stylesheet, its signal had aborted, or its element had no
    target (Chromium's heap after a collection) (2026-11-17), a script's `patch` whose tag's attribute follows a newline, or a tab
    in capitals, loading the module (2026-11-17), a part a form's answer draws in place of
    one a part's answer drew waiting at the same address, or at that address once it removed it,
    one a part read again draws in its place, and one at an address only a template's content in
    a part's answer names, each in the task the part's answer is drawn (one stylesheet held for
    both), read (2026-11-17), a script's `patch` drawing the first waiting part of a page whose
    head did not preload the module loading it and its part read (2026-11-17), the part module refused with a 503 and the
    part's link shown with no line and no mark, a part a `<corten-live>` fragment draws and a
    later fragment draws again while the first read is held (the first cancelled, the second
    drawn), a prerendered page read once shown
    (`document.prerendering` and `prerenderingchange` stood in for: Playwright's headless Chromium
    156 did not prerender a Speculation Rules page in a probe), and the link shown and the line
    hidden with JavaScript off (`javaScriptEnabled` in Playwright 1.64.1), in Chromium 156,
    Firefox 157 and WebKit 27.2 by `scripts/smoke.mjs`.

45. <a id="choice-data-on-single-quoted"></a>**`data-on` is a single-quoted attribute, so the JSON of
    a handler's arguments keeps its quotes.** A script gets what it works on through its handler's
    arguments ([Rule 3](#rule-handler-arguments)), so a set of a few hundred records it searches or
    sorts in the browser is a `ToJson` argument, typed by its generated declaration and checked at
    the call. `data_on` writes the attribute between `'`, and a JSON argument has only `&`, `'`, `<`
    and `>` written as entities (`json_attr`; a string argument, `json_str`, the same). `<` and `>`
    need none in an attribute, but the server's own readers of its markup (a page's parts, a
    patch's checks) find tags by them, and those that read attributes (`html::start_tag`, for a
    patch's ids, and `html::start_tags`, which walks a page with it for `corten dev`'s checks of
    `data-vars` and hints) read a quoted value to its own quote, so text in a handler's JSON is
    never taken for an attribute. The `data-on` format, the runtime's parser and the typing are
    unchanged: the browser gives the parser the same string from either attribute, and only the
    server's text of it changed. The single quote is HTML's own attribute syntax, and `data-on` is
    a format only Corten's server and runtime read, so it needs no standard
    ([Rule 10](#rule-standard-formats)).

    Double-quoted, each quote of the JSON was `&quot;`, five bytes more, so a value grew by five
    times its share of quotes: 300 products, 51,073 bytes of JSON of which 9,000 (17.6%) are
    quotes, made an attribute of 96,130 bytes, 88% over the JSON, and records with longer values
    have fewer quotes for their size and grew less (about 55% in
    [#1253 A script's data can only reach it as a handler argument in an attribute, so a large ToJson list grows about 55% from escaped quotes](https://github.com/corten-run/corten/issues/1253)).
    Single-quoted, the same products are 51,130 bytes, 0.1% over the JSON, and 5,302 bytes with
    zstd against 6,265, 6,170 with brotli against 7,378. The server writes the attribute in about
    half the time (141 µs against 274), and a component with two small handler calls costs 2,445
    instructions to draw against 2,696, since a quote is no longer six bytes to write. Card-market's
    item page stays 8,818 bytes, and 3 bytes more with zstd (2,181) and 4 more with brotli (2,364);
    the seller desk at 100 rows is 610 bytes smaller (78,704). Neither page's render time moved by
    more than runs of one build differ by. In the browser, parsing a page with the 300 products and
    getting the value back (the runtime's parse of the argument, which ends in `JSON.parse`) took
    Chromium 0.80 to 0.92 ms, Firefox 0.76 to 0.94 and WebKit 1.08 to 1.34, against 2.01 to 2.28,
    1.97 to 2.18 and 3.34 to 4.35 double-quoted. The parse alone took Chromium 235 to 323 µs
    against 1,401 to 1,616, Firefox 120 to 130 against 1,240 to 1,390 and WebKit 390 to 480 against
    2,620 to 3,500, measured. Pairing the ends of each engine's two ranges (its fastest
    single-quoted run with its slowest double-quoted one, and the reverse), that is 8.6% (Firefox,
    120 against 1,390) to 23% (Chromium, 323 against 1,401) of the time, about four to twelve
    times faster (4.3 to 11.6). The value back took about the same either way.

    Not chosen here, and left open: the issue's `<script type="application/json">` block with an
    id that a handler argument would name. On Value 1 it wins for the pages it serves. End to end
    it took Chromium 0.56 to 0.69 ms, Firefox 0.70 to 0.73 and WebKit 0.84 to 1.00, 0.06 to 0.34 ms
    less than the single-quoted attribute: its page parses a little slower (Chromium 374 to 415 µs
    against 235 to 323), but `JSON.parse` reads its text with no walk of an attribute first (182 to
    276 µs against 564 to 598), and that part grows with the data. The server writes it in 55 µs
    against 141, since only `<` is escaped (as `\u003c`). Its page is 63 bytes larger (51,193), 56
    with zstd and 64 with brotli, which a 1.6 Mbit/s link takes about 0.3 ms to carry. What it
    costs every page is a reader in the runtime: 128 bytes, 41 with gzip and 45 with brotli for the
    least one (an argument kind for a block's id in `on.js`, and `getElementById` and `JSON.parse`
    where an argument is resolved), downloaded once a release, since the runtime's URL is
    versioned and `immutable`, and nothing on a load. A patch that redraws an element whose
    handler names a block carries the block too, as a top-level element with its id, the bytes the
    attribute would have had, or the handler reads the old data. So the few pages that hand a
    script tens of kilobytes would be a fraction of a millisecond faster, and every user would pay
    41 bytes a release. Value 1 weighs that itself: "We say no to features that cost every user to
    help a few." Both the cost and the help are small, but the help goes only to the pages that hand
    a script large data and the cost to everyone who loads the runtime, so on Value 1 the block is
    not earned until an app's pages carry data large enough that its gain outweighs what every user
    downloads. The single-quoted attribute adds nothing to the runtime and gives those pages most of
    their gain (the parse four to twelve times faster), so it is taken now. The block is also a
    second way for data to reach a script beside its arguments (Values 5 and 6), which ranks below
    performance at the user's end, so that would not decide against it once Value 1 is met. The two
    changes do not exclude each other: a block would carry the large values and `data-on`
    everything else a page has (formats, messages, a component's small arguments), single-quoted
    either way, so this Choice is taken on its own and the issue stays open for the block. Data a script
    needs after the page loads, which a choice picks, is not the block's: a script reads it from
    its route ([Choice 55](#choice-screen-read)). Also not
    chosen: a block the app writes itself (a way around the typed call, and markup a view would
    have to keep in step with the script); leaving the attribute double-quoted (88% more bytes for a
    large argument, and a parse four to twelve times slower).

    Stands on: measured (`json_argument_cost` in `crates/corten/src/script/tests.rs`, five runs of
    2,000 renders of each form, once; `bench/browser/data-on-cost.mjs` on the pages that test
    writes, eight runs of 100 `DOMParser` parses and 100 value reads of each form in Chromium,
    Firefox and WebKit, the forms alternated, twice; the block's reader,
    `node block-reader-size.mjs` after `npm ci` on `e8a3a6bd` (tag `evidence/e8a3a6bd`), which
    builds the runtime with the reader and without it, once; callgrind on
    `what_a_handler_call_costs` at 200 and 1,200 renders,
    two runs of each build alternated; `render_cost` in `examples/card-market` and
    `examples/seller-desk`, three runs of each build alternated, and card-market's again, eight of
    each); platform (an HTML attribute value between `'` holds `"` as it is, and the browser gives
    a script the decoded value either way; a `type="application/json"` script is a data block,
    which a CSP's `script-src` does not block, checked in the three engines under the watchlist's
    policy); reasoned (the parser reads the attribute's decoded value, the same string in either
    form, so nothing on the client changes; a block a handler names by id is on the page only if
    the patch that redraws the handler brings it); value (a page costs the user about what its data
    does, Values 1, with no new concept, Values 6; Value 1 says no to a reader every user downloads
    for a gain only pages with large data see, until such pages show the gain outweighs it, and a
    block's speed for those pages would outrank its second way, Values 5, so this Choice does not
    decide the issue).

    Revisit when: an app or example hands a script a JSON argument over 170 KB on a page most of
    its users load at least once a release. The reader's 41 bytes with gzip are 328 bits, about
    0.2 ms at 1.6 Mbit/s, paid once a release; the block's least measured gain, 0.06 ms a load
    for 51 KB of JSON, reaches 0.2 ms at 51 KB times 0.2 / 0.06, about 170 KB, taking the gain to
    grow in proportion to the data (reasoned; measured only at 300 products). That opens a new
    Choice for the block, not this one, since `data-on` stays single-quoted for every other
    argument either way. This Choice reopens when something outside Corten has to read `data-on`,
    which [Rule 10](#rule-standard-formats) keeps internal.

    Last checked: 2026-11-12, `json_argument_cost` and the three engines' parse and value back on
    `7564cdc4` (Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2, Playwright 1.64.1), and the
    block's reader on `e8a3a6bd` (tag `evidence/e8a3a6bd`), which adds it to `ab020512`;
    2026-11-12, callgrind (valgrind 3.19.0) and `render_cost` on
    `194f5179` against the change, `fb22d82d`; 2026-11-12, card-market's `render_cost` again on
    `80dbd7db` against its merge into the change, `7f34dea8` (eight runs of each build alternated,
    five with main first and three with the change first); 2026-11-11, the CSP in Chromium
    156.0.8078.4, Firefox 157.0 and WebKit 27.2.

46. <a id="choice-ref-values"></a>**A value an element gives its script is its ref's,
    `ref={row.with(cents)}`, written as JSON in `data-ref-value` and read as a `Map` from each
    element to its value.** A script that reorders or filters rows the server drew compares
    something each row carries (a price in cents, a count in stock). A `data-` attribute read
    through `dataset` named it as text twice, in the markup and in the script, so a misspelled or
    renamed name compiled, passed `tsc` and read `undefined`, and the value reached the script as a
    string to convert. A ref already ties a handler's parameter to the elements it names, checked
    when the crate compiles ([Choice 5](#choice-handlers-checked-where-called)), so the value goes
    on the ref: `row.with(x)` fixes the ref's third type parameter from `x`'s Rust type (a number,
    text or a `bool`: `ts::Number`, `ts::String`, `ts::Boolean`), every element given the ref gives
    a value of that one type, and a parameter typed `Map<El, number>` (or `string`, `boolean`) takes
    only such a ref, as `El` takes only a ref on that tag. A ref given a value on some elements and
    none on others, or text where the handler takes `number`, does not compile (`compile_fail`
    doctests on `Ref::with`). The call names it `=row`, and the runtime gives the handler every
    element with the ref, in the page's order, with `JSON.parse` of its `data-ref-value`. The server
    writes the value with the writers a handler's arguments use, single-quoted
    ([Choice 45](#choice-data-on-single-quoted)), so a number is a number in the script, and an
    integer past 2^53 stops debug builds as an argument's does. The one name the markup and the
    script share is the ref's, which the compiler already holds them to; `data-ref-value` is the
    runtime's own, written only by `ref=`.

    A key is carried the same way: the ref's fourth type parameter says whether its elements have
    one (`Keyed` when the markup puts `key={..}` beside it, `NoKey` when not), fixed by each
    element it is on, so a parameter typed `Map<string, El>` takes only a ref whose every element
    has a key, and the error says to add `key={..}`. Without it a forgotten key compiled and the
    handler got a one-entry `Map`, every element filed under the absent key
    ([#1329 A `Map<string, ..>` handler parameter accepts a ref whose elements have no `key=`, so a forgotten key compiles and the handler gets a one-entry `Map`](https://github.com/corten-run/corten/issues/1329)).
    Equal keys cannot be seen when the
    crate compiles, so debug builds stop a render in which two elements of a ref in one render of
    its component have keys the browser reads as equal (as `getAttribute` returns them, so
    `key={true}` and `key=""` are one, and so are a carriage return and a line feed), or a
    `key={..}` writes none (`None`), as they stop on an integer past 2^53; release builds keep no
    record. It never stops a correct render: where it cannot know what a browser makes of the
    markup, it lets a duplicate pass. The check counts the elements the runtime's query finds, so
    one in a `<template>`'s or a `<noscript>`'s content is not counted, nor one an expression or a
    component writes into an element whose content a browser reads as text (`<textarea>`, an HTML
    `<title>`, `<iframe>`, `<xmp>`, `<noembed>`, `<noframes>`); one written in those in the markup
    itself does not compile where `html!` can see it is parsed as HTML
    ([Choice 54](#choice-html-parse-refusals)). In an `<svg>` they are elements like any other, and
    what they hold is counted, except in its `<foreignObject>`, `<desc>` and `<title>`, the HTML
    standard's integration points, whose children are HTML's. It counts an
    element against its component's render only when the element is written into the string that
    render writes, so a view written into a string of its own (`html! { .. }.to_html()` or a
    component's `children.to_html()` as an attribute's value, which the browser reads as text) is
    not counted there, though a component rendered so has a record of its own; and an element's
    ref and key are noted on it until its tag is written, so a view an attribute's expression
    renders meanwhile notes its own. Markup a view writes into its own string and an app then
    places in the page (`raw`) is not checked against the page's, and Corten does the same with a
    document's head tags: it renders each expression or component in its `<head>` into scratch
    storage and copies it into the page (`head_slot` in `crates/corten/src/view.rs`), so equal keys
    in two of them, or in one and the body, are not checked. Its limit is at a component's edge
    ([Limit 30](#limit-markup-context)), where the markup on either side cannot know the other's
    context: a component's markup does not see an `<svg>` its
    parent writes it into, so it takes a `<template>`, `<noscript>`, `<textarea>`, `<title>`,
    `<iframe>`, `<xmp>`, `<noembed>` or `<noframes>` at its top there for HTML's, and the keys in
    it, which the runtime finds, are not checked; and a component's children do not see where the
    component writes them (in an `<svg>`'s `<desc>`, say, where a `<template>` is HTML's), so the
    content of one of those among them is not checked either, unless it is in an `<svg>` the
    children write themselves, which is SVG's wherever it lands. Following the namespace across
    components would have every element's markup report it to the check, for a duplicate few apps
    can write. Nor does it follow MathML: one of those in a `<math>`, outside its text integration
    points (`<mi>`, `<mo>`, `<mn>`, `<ms>`, `<mtext>`, where a `<mglyph>` or a `<malignmark>`
    stays MathML's) and an `<annotation-xml>` whose first `encoding` is `text/html` or
    `application/xhtml+xml` (with another or none, an `<annotation-xml>`'s content is MathML's),
    is MathML's and the runtime finds what it holds, which the check does not
    count. An element a browser moves out of an `<svg>` (`<div>`, `<p>`) does not compile written
    straight into one ([Choice 54](#choice-html-parse-refusals)), so the check
    follows the markup there as the browser does, except where `html!` cannot see it: a component
    that writes such an element at the top of its markup into a parent's `<svg>`, or an expression
    that writes one there, closes the drawing, and the parent's check still takes what follows for
    SVG's. Nor does it follow an element a browser moves out of a table (a
    `<span>` written straight into a `<tr>`, put before the `<table>`): when the table is a
    component's root, the moved element falls outside it, so the runtime does not find it there
    while the check counts it, and may stop on a duplicate the runtime does not see. Both are
    markup a browser does not keep as written, not a correct render. Literal HTML nesting whose
    start tags close or discard an open element is now refused where the markup between the two
    shows it ([Choice 54](#choice-html-parse-refusals)); nesting across a component or an
    expression is not, and has the same edge.
    A `data-key` written by hand is refused like `data-ref` and `data-ref-value`: `key={..}`
    is the one way to key an element. The check decodes the five references
    Corten's escapers write and no others, and leaves
    out a key written with any other `&` (only an app's own `AttrValue` writes one), since guessing
    at what a browser reads there would repeat HTML's character reference rules or stop correct
    markup. Whether it runs is `corten-run`'s own debug-assertions setting: the code `html!` writes
    calls it in every build, and a release build of Corten makes those calls empty, so a
    per-package setting cannot leave half of it on. The runtime is unchanged:
    a check of the live page's keys there would cost every user bytes to report a mistake the debug check finds
    in the render that makes it, and rows a patch or a script adds later carry the keys the server
    or the script gives them.

    Not chosen: the row's key (`ref={rows} key={..}` and a `Map<string, El>`). A key is a row's
    identity, which two rows with the same price cannot share, and it is text, so taking it for the
    value would change what a keyed ref means and still convert in the script. A typed `dataset`
    (a declaration generated from the component): the attribute's name stays text in the markup,
    and it is a second way to hand a script data beside its arguments and refs (Value 5). A
    `#[component(view)]`'s holes: they type rows a script makes, and would bring the views module
    to a page that only reorders. A handler argument with the values in the rows' order: the list
    and the rows are tied only by position, which a reorder or a patch to one row breaks. A value is
    one number, text or `bool` an element gives, not a record: a script that needs more about a row
    reads the row it has, or takes the records as a `ToJson` argument. `data-` is HTML's place
    for a page's private data and `data-ref-value` is read only by Corten's runtime, so it needs no
    standard ([Rule 10](#rule-standard-formats)); a `data-` attribute written for CSS or for the
    runtime (`data-selected`, `data-reload`) is unchanged.

    Reopened for [#1387 corten-ui's sort and combo box read data-* attributes by name instead of ref values](https://github.com/corten-run/corten/issues/1387):
    a sort header appeared to need a record of two addresses and its first direction. It already
    has one address in the native `href` and its active direction in `aria-sort`. One text ref
    gives the other address; the ref it belongs to gives the first direction. The head's typed
    event reads the current values only when a sort or ordered control asks, and takes `aria-sort`
    from the live header even if both URLs stayed the same. The alternate route writes directly to
    its ref value's output unless the URL needs JSON or HTML escaping. A draft that split
    the record over the anchor, cell and arrow repeated the native route and resolved the table's
    maps once per header on connect. The single value needs neither a record type nor any runtime
    reader change, and still leaves the link useful without JavaScript.

    What it costs every user is the runtime's reader, the `=` kind in `on.js` and its case in
    `resolve`: 107 bytes raw (42,427 to 42,534), 21 with gzip (14,995 to 15,016) and 24 with brotli
    (13,528 to 13,552), downloaded once a release, since the runtime's URL is versioned and
    `immutable`, and nothing on a load: the value is read only when a handler that takes it runs.
    What it costs a page that uses it is the value written on each element: card-market's item page,
    whose listings each give their ref their cents (22 rows a page on average), is 418 bytes larger
    (8,818 to 9,236), since each row now carries its ref's name beside its value (`data-ref="row"
    data-ref-value='1250'` where it had `data-cents="1250"`), and 21 bytes larger with zstd (2,181
    to 2,202), 11 with brotli (2,364 to 2,375) and 1 smaller with gzip (2,512 to 2,511), the bytes a
    user receives. Rendering its main part costs about 930 instructions more a page, about 42 a row,
    2.4% (callgrind: `ItemDetail`'s render took 2,363.8 and 2,368.9 million instructions over the
    test's 60,000 renders before, 2,424.5 and 2,419.7 million after); the whole test, compression of
    the larger pages included, is 0.8% more (28,332.8 and 28,354.7 million to 28,576.2 and 28,575.3
    million). An integer value is written as markup writes a number (`Render`), not through
    `Display`'s formatter, which had made the same render 13.5% more. A page whose elements give no
    value costs nothing: seller-desk's desk took 2,080,520,197 instructions to render in every run
    of both builds.

    Value 1 comes first. It says no to features that cost every user to help a few, and on it
    [Choice 45](#choice-data-on-single-quoted) refused a 41-byte reader whose help went only to the
    few pages that hand a script tens of kilobytes. This reader's help does not go to a few: under
    the bet in Stands on, it goes to every app whose script reads back a value its markup wrote,
    which a script that reorders, filters or follows rows the server drew does. Its cost, in
    [Choice 45](#choice-data-on-single-quoted)'s terms, is 21 bytes with gzip, 168 bits, about 0.1
    ms at 1.6 Mbit/s, downloaded once a release and cached after, since the runtime's URL is
    versioned and `immutable`; the render cost falls only on a page whose elements give values, and
    a page that gives none is unchanged to the instruction. So Value 1 does not refuse it, and Value
    4, mistakes failing at compile time, decides: a value a script reads back is checked when the
    crate compiles, where with a `data-` attribute a misspelled or renamed name compiled, passed
    `tsc` and gave the script `undefined` with no error anywhere (a sort that subtracts gets NaN,
    which `sort` takes as equal, and leaves the rows as they were), and a number came as text the
    script had to convert (one compared with `<` orders `"999"` after `"1250"`). No change without a
    reader in the runtime does that: a value read through `dataset` is text the compiler cannot see,
    and the ways not chosen above each give up a row's identity or its order. One way for a script
    to get what an element carries, its ref, is Value 5's. If the bet fails, the help goes to a few
    after all, and the Revisit-when reopens the 21 bytes on Value 1.

    Stands on: measured (the runtime's size by Node's `zlib`, raw, gzip at its default level and
    brotli at quality 11, once each build; the item page's bytes from `render_cost` in
    `examples/card-market`; instructions by callgrind on the release `render_cost` tests of
    card-market and seller-desk, two runs of each build alternated, the base first, and, for the
    key check and what it adds to the code `html!` and `#[component]` write, on watchlist's
    `key_check_cost`, three runs of each build alternated); platform (a
    `data-` attribute is HTML's place for data private to the page, and `getAttribute` gives a
    script its decoded value, so `key={true}` and `key=""` are one key of the handler's `Map`, and
    so are a carriage return and a line feed; the query that finds a ref's elements does not reach a
    `<template>`'s content or, with scripting on, a `<noscript>`'s; the HTML standard's tree
    construction, which the key check follows for what that query finds: the elements whose content
    a browser reads as text and the integration points in SVG and MathML, as
    [Choice 54](#choice-html-parse-refusals) records); reasoned (the runtime already finds a ref's
    elements in the page's order for `*` and `#`, so a value is one attribute read per element
    when the handler runs and nothing on a load; the ref's third type parameter is one type wherever
    the component uses the ref, so a ref given text on one element and a number on another, or a
    value on one and none on another, is a type error, and its fourth, whether its elements have
    keys, is fixed the same way by each element, so a ref with a key on one element and none on
    another does not compile whatever its handlers take, and a `Map<string, El>` parameter's bound
    takes only a ref whose every element has one; a debug
    build's record of keys is per render of a component and the string it writes, as the runtime
    finds a ref's elements under the component's root nearest them, and leaves out a `<template>`'s or a `<noscript>`'s content,
    which its query does not reach, but not an `<svg>`'s outside its `<foreignObject>`, `<desc>` and
    `<title>`, which it does); bet (values are given today in five places: card-market's listing
    sort, `listing_sort.rs`, read by `listing_sort.js`; corten-site's wall, `surface.rs`, read by
    `wall.js`; its seam's marked names, `apart.rs`, read by `apart.js`; its header table,
    `steel.rs`, read by `answer.js`; and the watchlist's smoke page, `smoke.rs`, read by
    `quoted.js`. The corten-ui table's explicit cell values, its kit's alternate sort link and
    ComboBox search terms are additional uses. Apps that hand their scripts values on elements
    the scripts reorder, filter or follow get the same check without another reader); value (that help, at
    a cost every user pays of 21 bytes with gzip once a release, which Value 1 does not refuse; a
    mistake in a value a script reads fails when the crate compiles, and no name is text at a seam,
    Values 4; one way for a script to get what an element carries, its ref, Values 5; a value on a
    ref, not a new concept, Values 6).

    Revisit when: an app's script needs a record per element rather than one number, text or `bool`
    (then the value might be any `ToJson` with its generated declaration), or the platform gives
    elements typed custom data a script can read without a name as text, or something outside Corten
    has to read `data-ref-value`, which [Rule 10](#rule-standard-formats) keeps internal, or an app
    is found to give equal keys where the debug check cannot see them across a component's edge (in
    a `<template>` a component writes into a parent's `<svg>`, or among children it writes into an
    `<svg>`'s `<desc>`, [Limit 30](#limit-markup-context)), when following the context across
    components would be weighed against its cost to every render, or a browser reads a key other
    than `getAttribute` gives it, when the check would compare what the runtime reads. The bet
    fails, and the 21 bytes reopen against checking `dataset` names some other way (a declaration of
    each component's `data-` names generated as `corten::types` is), when on 2027-05-13 or later
    a read in `crates/`, `examples/` and `skills/` finds no markup giving a ref a value
    (`ref={name.with(..)}`, on one line or split over several) beyond the original five places
    named in Stands on and their tests and docs. A search for `.with(` lists the candidates, and
    each is read, since a search alone misses markup split over lines. The earlier check for the
    sort and ComboBox migration is satisfied: they are now uses beyond those five.

    Last checked: 2026-11-18 for the sort-header encoding (one URL per anchor suffices, with no
    value reader change; [#1665 Use typed refs for sort header routes](https://github.com/corten-run/corten/pull/1665)
    gives the gallery measurements). On 2026-11-15, the release cost of the key check and of all it adds to the code
    `html!` and `#[component]` write (`scoped_into` around a scoped component's and a scoped
    document's render, the locals `html!` opens around a `<template>`'s, a `<noscript>`'s and a
    text holder's content, a document head's `<title>` among them, the key's calls beside a keyed
    ref's element, and the blocks a document's parts are gated by), on `c84e5fb5a` with the
    harness of the commit after it against `731a4bbff`, the `main` it merged then, by callgrind
    (valgrind 3.19.0), three alternated runs of each build, the base first: watchlist's
    `key_check_cost` (`LivePrices`, a scoped component with 50 rows and two keyed cells each;
    `KeyedMarkup`, with cells keyed by `key={..}` and by a static `key=".."`, a `<template>`, a
    `<noscript>`, a `<textarea>` and a `<template>` among a component's children in an `<svg>`'s
    `<desc>`; and `KeyedDocument` around it, a scoped document whose head has a `<title>` and
    whose `<main>` holds a keyed ref's element and a `<template>` of its own, rendered whole and as
    the `Swap` and `Title` parts; 1,000 renders each), with the test copied into the base,
    counted 131,623,718, 13,703,103 and 27,893,110 instructions for the three in every run of both
    builds, wrote the same bytes (23,408, 2,976 and 6,370 a render) and compiled to the same
    instructions to the line (2,416 lines each, addresses aside). That harness omitted the
    doctype because the macro then counted it as a second root. A scoped document now accepts
    one leading `<!DOCTYPE html>` before its `<html>` root. The declaration is not an element,
    and without it the browser uses quirks mode. The historical counts above predate that fix.
    Card-market's `render_cost`,
    on `6575d4d8c` against `72a37a87e` (no generated code has changed since), counted
    `ItemDetail`'s render at 2,372,754,748 instructions (median; 2,372,507,167 to 2,372,779,152)
    on the base and 2,372,745,747 (2,369,854,428 to 2,372,790,283) on the branch, each difference
    inside one build's own range, and its `Layout`, `SiteHeader` and `ItemDetail` compile to the
    same instructions (12,414 lines each) but for one constant's generated name;
    2026-11-14, one-off probes, not checks the repository repeats: pages written by hand (not by
    `html!`) loaded in Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2 (Playwright 1.64.1),
    counting what `querySelectorAll` finds and the keys of the handler's `Map`. An element in a
    `<template>`'s or a `<noscript>`'s content, or written in a `<textarea>`, an HTML `<title>` (in
    `<head>`, in the body, in an `<svg>`'s `<desc>`), an `<iframe>`, an `<xmp>`, a `<noembed>` or
    a `<noframes>`, is not found, nor what a `<template>` in an `<svg>`'s `<desc>` or `<title>`
    holds, and one in an `<svg>`'s own `<title>` or in an `<svg>`'s `<template>` is. `key={true}`
    and `key=""`, and a carriage return and a line feed, are one key. `&#128;`, `&#+97;`, `&#97`,
    `&nbsp;`, `&#0;`, `&#xD800;` and `&#x110000;` read as U+20AC, the text itself, `a`, U+00A0 and
    U+FFFD, which the check leaves out rather than decode. To repeat them, load such pages in the
    three engines and count. The tests beside `TemplateKeys`, `NoscriptKeys`, `SvgTemplateKeys`,
    `TextOnlyKeys`, `NoteKeys`, `SvgTitleKeys`, `DescTemplateKeys`, `OuterSvgKeys`, `RawKeys`,
    `NestedKeys`, `BlankKeys` and `NewlineKeys` hold the check to what they found;
    2026-11-15, a ref with a key on some elements and none on another refused beside a handler
    that takes one element and with no handler, by the ref attribute's bound, not the `Map`'s, on
    `6575d4d8c` (`compile_fail` doctests on `ts::Map`);
    2026-11-14, a key a view writes into a string of its own (`html! { .. }.to_html()` and a
    `render` into a string of the app's as an attribute's value, and a component's
    `children.to_html()`) not counted against its component's render, and two equal keys in that
    render beside one still counted, on `1960d19f3`, as the tests beside `TitledKeys`,
    `ChildTitledKeys` and `TitledTwiceKeys` hold the check to;
    2026-11-14, a `<template>` among a component's children, which the component writes into an
    `<svg>`'s `<desc>`, not counted, and one in an `<svg>` the children write themselves counted,
    on `7c2fba42a`, as the tests beside `DescribedKeys` and `BoxedSvgKeys` hold the check to;
    2026-11-13, a ref without keys refused by a `Map<string, El>` parameter and a
    render with two equal keys stopped in a debug build, on the change for
    [#1329 A `Map<string, ..>` handler parameter accepts a ref whose elements have no `key=`, so a forgotten key compiles and the handler gets a one-entry `Map`](https://github.com/corten-run/corten/issues/1329)
    against `0ff569c69`, where the first compiled (`compile_fail` doctests on `ts::Map` and
    `Keyed`, and the tests beside `KeyedCells`); 2026-11-13, the runtime's size on `f12d3daa3`
    against the change, `09a61616c`;
    2026-11-13, callgrind (valgrind 3.19.0) on card-market's and seller-desk's `render_cost` on
    `f12d3daa3` against `09a61616c` and against `bf3ce25bb`, which writes an integer as markup does,
    and the item page's bytes on `c3d455a1` against `3ae633f34`; 2026-11-13, the value read back by
    card-market's smoke on `bf3ce25bb`, sorted by the script in Chromium and read with
    `getAttribute` without scripts in Chromium, Firefox and WebKit (Playwright 1.64.1).

47. <a id="choice-patch-brings-area-styles"></a>**A patch ends with the section stylesheet links of its handler's path, and the
    runtime loads the ones the page lacks before it puts the patch in place; the server is not
    told the page the patch lands on.** A page links the stylesheets of the areas its path is
    under (`Area::components`, [Limit 9](#limit-stylesheet-support)), and a navigation's answer
    carries the same links for the runtime to load before it swaps the page in. A patch carried
    none and the runtime's `apply()` loaded none, so a `data-patch` form on `/search` answered by
    a handler at `/items/{slug}/save` drew the `/items` area's dialog unstyled, while the debug
    check passed because it read the handler's path
    ([#1366 A patch answered by another area's handler draws that area's components unstyled: the runtime's patch loads no section stylesheet and check_rendered reads the handler's path](https://github.com/corten-run/corten/issues/1366)).
    Now `Action::patch` (and a refused form's patch) ends with the links of the handler's path, after
    the patch's elements, and `apply()` loads those the document lacks with the patch's modules,
    through the function a navigation uses (`stylesOf`). A patch whose first element is a `<col>`
    loses them, since the runtime's parse then keeps only `<col>`s and `<template>`s, which a debug
    build refuses ([Limit 2](#limit-whole-element-patches)). A component a patch renders is then
    listed where its handler is, as a page's components are listed where the page is, and the
    debug check's path is the right one. A stylesheet that fails to load is taken out of the
    head again and the patch goes in unstyled, where a navigation loads the page in full: a
    patch is often a write's answer, which a reload would lose, and the next patch that links the
    stylesheet tries again. A second answer that links a stylesheet still loading (two patches in
    flight, a patch and a navigation) waits for the same load rather than take the link in the
    head for a loaded stylesheet. One that neither loads nor fails holds the answer as it holds a
    navigation's, and holds every later answer that links it too, each later patch from the
    area's handlers and each later navigation into the area, until the page is loaded again:
    Corten sets no timeout of its own, as the browser sets none on a page's stylesheets.

    Every cost it adds, and who pays it. First, the runtime is 53 bytes larger with gzip and 49
    with brotli, paid by every user of every Corten app, apps with no areas too, once a release,
    since the runtime's URL is versioned and cached for good. Second, a patch from a handler
    outside every area of an app with area stylesheets costs 95.1 instructions a request more
    (18,709.4 against 18,614.3), the area check (`section_links` and `memcmp`); in an app whose
    areas have no stylesheets a patch costs nothing measurable (18,559.0 against 18,562.5), since
    the check returns at once. Third, a patch whose handler is under an area with a stylesheet,
    wherever it lands and whatever it renders, is the link longer (88 bytes for the watchlist's
    `/smoke` area, sent as they are, since a patch under 1 KiB is not compressed) and costs
    633.5 instructions more in the harness (19,193.0 against 18,559.5). About 120 of those find
    and write the link (`section_links` +104, `memcmp` +18); about 510 are the harness patch's
    buffer growing to hold it (`realloc`, `finish_grow`, the copy and the allocator's own frames,
    by the per-function counts of one run of each). That patch's 27-byte body leaves its buffer
    at 32 bytes, and the 87-byte link, pushed whole, makes it grow once more, to 114 bytes
    (reasoned from the lengths and `String`'s growth to the larger of double and what is
    needed); a patch whose buffer has room for the link pays about the 120, as a patch drawn by a
    bare `html!` does, whose string starts at its call site's last size and never below 256
    bytes (the harness patch is a component, whose string starts empty). Fourth, on
    a page that lacks the area's stylesheet, the page fetches it and the answer waits for it,
    even when the patch renders none of the area's components (one that only removes a row, or
    renders components from `App::components`): the link goes by the handler's path, not by what
    the patch drew. That costs the stylesheet's bytes once a page (the watchlist's
    `sections/smoke.css` is 62 bytes, sent as they are, measured) and one request's wait
    (reasoned: the stylesheet's own fetch, which a warm cache may answer). On a page that has
    the stylesheet, the same-area case, the runtime finds the link in the head and fetches
    nothing.

    Weighed: all four are the README's conflict order, 2, performance at the user's end. What
    they buy is in its 1, correctness and reliability: without them a patch from another area's
    handler is drawn unstyled with no error, in release as in debug. Correctness comes first in
    that order, so the costs are paid. They are also small where they fall most: by the bet
    below, most patches land in their handler's area, where the change costs the link's bytes
    and the instructions above and no request, and the case it fixes, a patch landing outside
    its handler's area, is the minority. Giving a component's string a size of its own, as an
    `html!` call site's has, takes the 510 of growth off the harness patch and saves more than
    the links cost:
    [#1418 Size a component's string from its own last render, as an html! call site's is](https://github.com/corten-run/corten/pull/1418)
    measures a small component's patch at 17,537.5 instructions a request against 18,734.5 on
    main `0ff569c6` (1,197 fewer) and a 4 KiB one's at 26,695.9 against 32,414.8, with its own
    harness; the string then starts at 256 bytes, room for the 88-byte link. It is a change of
    its own, not part of this one; its head is not on this history, so it is cited by the pull
    request.
    The stylesheet a patch brings is loaded under the policy of the page it lands on, not the
    area's: an image or font it loads from a source only `Area::policy` adds is refused on a page
    outside the area. An area stylesheet that needs such a source does not carry over to patches
    answered outside the area; the source goes on the app's policy, or the handler moves to the
    page's side.

    Not chosen: the runtime telling the server the page's path (a request header of Corten's own
    beside `corten: action`, [Choice 11](#choice-corten-request-header)), which would let the server
    leave out a link the page has or, as the issue's second option, refuse the patch in a debug
    build. Leaving links out saves the same-area patch its link bytes, but every patch request
    carries the header, a response that depends on it needs `Vary` on it, and a script's
    `patch()` or a `ReadAgain` read has no page path to send that the server could trust more
    than the document's own head; refusing in a debug build leaves a release build drawing the
    patch unstyled and makes the app list the component in both areas (a shared file) or in
    `App::components`, which every page then links, the pilot's workaround. `Referer` is not
    used for the same purpose, since an area may set a referrer policy that sends less, and a
    proxy may drop it. Recording which components a patch rendered, so only their sections are
    linked (and a patch that draws none of them links none), would make every release render keep
    that record, which [Limit 9](#limit-stylesheet-support) rules out. A live fragment
    (`corten::live`) is drawn without a request's path and still carries no links: a stream that
    renders an area's component on a page outside the area lists it where its pages are.

    Stands on: measured (callgrind, release, `tests::what_a_patch_in_an_area_costs` at 200 and
    1,200 requests with jemalloc, its three `PATCH_WHERE` cases, three runs of each build
    alternated, before at `d1cb28f9` (main) with the test as at `43e7e8a1` added and after at
    `43e7e8a1`, every run of a build within 1.6 instructions of the others; the runtime's
    minified size with Node's gzip and brotli at their defaults, once, at `bccc912f` (this change
    merged onto main) against main `0ff569c6`; the patch's and the stylesheet's bytes from the
    watchlist, once); platform (a
    `<link rel="stylesheet">` added to `<head>` fires `load` once its rules apply and `error` when
    it fails, `style-src 'self'` allows it under the policy the document loaded with, and its
    subresources are under that policy too; the load, the failure and a second patch waiting for
    a load are checked in Chromium, Firefox and WebKit by `scripts/smoke.mjs`, and a navigation
    waiting for a patch's load in Chromium and Firefox, WebKit having no Navigation API; a
    `<template>` whose first element is a `<col>` keeps only `<col>`s and `<template>`s, the HTML
    standard's "in column group" insertion mode, checked in the three by `scripts/smoke.mjs`
    against `crates/corten/src/patch-parsing.json`); reasoned (a
    handler's path decides its area, as a page's does, so the links need nothing the request does
    not have; the runtime already skips a stylesheet the head has, by its URL; the wait a page
    outside the area pays is one request; the harness patch's buffer grows once more for the link,
    from its 27-byte body's 32 bytes); bet (a patch from an area's handler, a write's answer
    or a `ReadAgain` read of a part under the area, mostly lands on a page in the same area, where
    the links are bytes and no request; a part polled under an area sends the link with every
    read, and writes and reads are few enough a visit that those bytes do not show beside its
    pages); value (a patch drawn unstyled with no error is wrong output, which the README's
    conflict order puts first, 1, correctness and reliability, above the costs weighed above,
    which are its 2, performance at the user's end; an area's rules still load only where they are
    used rather than on every page, README Value 1, Fast; a component is listed in its own area
    for patches as for pages, README Value 5, One way to do each thing).

    Revisit when: an app in the repository or the Chase Sets pilot sends patches or `ReadAgain`
    reads under an area whose link bytes reach a tenth of its patch bytes on a screen people use
    for many writes, or watch through many reads, in a row (a patch-heavy desk, a part polled
    every few seconds); patches from an area's handlers are found landing mostly on pages outside
    it, where each first one waits for the stylesheet; the runtime starts sending the page's path
    for another reason, when the server could leave out the links the page has; a live
    fragment is found drawing an area's component unstyled on a page outside it; or
    [#1418 Size a component's string from its own last render, as an html! call site's is](https://github.com/corten-run/corten/pull/1418)
    closes unmerged, when a linked component patch, whose string starts empty, keeps the 510 of
    growth and the weighing above loses its offset.

    Last checked: 2026-11-13, the callgrind runs on `d1cb28f9` against `43e7e8a1`, with valgrind
    3.19.0; 2026-11-13, the runtime's size at `bccc912f` against main `0ff569c6`; 2026-11-13, the patch's link and `sections/smoke.css` from the watchlist at `43e7e8a1`;
    2026-11-13, the patch's link loaded, failed, kept and waited for in Chromium 156.0.8078.4,
    Firefox 157.0 and WebKit 27.2 (Playwright 1.64.1) by `scripts/smoke.mjs`, and a navigation
    waiting for a patch's load in Chromium and Firefox; 2026-11-13, both of those waits drawn
    unstyled, and those two checks alone failing, in Chromium and Firefox with round 1's
    `stylesOf` (`9c722e27`) put back in this head's runtime; 2026-11-16, a leading `<col>`'s
    patch losing its stylesheet link, a case of `crates/corten/src/patch-parsing.json` that
    `scripts/smoke.mjs` loaded on `1f0bc47b7`, in Chromium 156.0.8078.80, Firefox 157.0 and
    WebKit 27.2 (Playwright 1.64.1).

48. <a id="choice-matchit"></a>**Every app uses the exact matchit version Corten tests, 0.9.2.**
    `crates/corten/Cargo.toml` requires `=0.9.2`, not a caret or tilde. The exact pin is what
    fixes [#1368 A new app resolves matchit 0.8.6 while Corten tests on 0.8.4, and the two match an empty path segment differently](https://github.com/corten-run/corten/issues/1368):
    with `0.8`, a fresh app's lockfile took 0.8.6 while the workspace's held 0.8.4, and a patch
    release (0.8.5) had changed what an empty segment matches, so no looser requirement holds
    every app to the matcher Corten's tests ran. A later matchit release, a patch included, is
    taken only by changing the pin and running the edge-path tests again.

    Which version is the smaller question. For the routes Corten's macros and areas insert,
    0.8.6 and 0.9.2 match and insert alike: `Node::at` is the same in both, and every conflict
    check 0.9 adds needs a parameter with text before or after it in its segment, which no such
    route has (`route_shaped` and `parse_path` refuse text before a parameter, and Corten strips
    the text after one before inserting it). 0.9.2 was chosen as the maintained line: 0.8.6
    (January 2025) is 0.8's last release, and 0.9.0 to 0.9.2 have followed since October 2025,
    so a fix lands where the pin can take it without a minor-version move. `=0.8.4` was weighed:
    it keeps the matcher every app has tested with and costs no instructions. It lost on
    correctness and reliability, which the conflict order puts before the instructions. Upstream
    calls its empty-value matching a bug: matchit 0.8.5's release note says "Fixed a bug where
    empty route parameters were accepted"
    ([ibraheemdev/matchit#60 Reject Empty Route Parameters](https://github.com/ibraheemdev/matchit/pull/60)).
    The bug gives a wrong answer: under 0.8.4 an empty value lets a parameter route shadow a
    catch-all, so `/x//y` reaches a POST-only `/x/{a}/y` instead of a `/{*page}` page, and a
    GET there fails (`tests::url::serves_agrees_with_the_router` now requires the page to answer it).
    And 0.8 gets no more fixes; they ship only on 0.9.x, so a pin on 0.8.4 would take the next
    one only through a forced minor-version move. 0.8.4 also matches an empty value in some
    places and not others: as the first segment (`//posts` reaches `/{user}/posts` with `user`
    empty) and between segments (`/items//edit` reaches `/items/{id}/edit`), but not at the end
    (`/items/` reaches no `/items/{id}`). That inconsistency alone is a Value 5 point, which
    ranks below the instructions, and is not why 0.8.4 lost. Links already refused an empty
    value at both ends, for different reasons: at the start because a browser reads `//posts`
    as another host, at the end because the router missed it. Corten no longer
    depends on axum, so card-market's comparison-only axum 0.8.9 keeps its own matchit 0.8.4.

    This is breaking for apps tested with 0.8.4: a parameter must be nonempty even before a
    slash (`/items//edit` no longer matches `/items/{id}/edit`), and links refuse that empty
    value as they already refuse one at the start or end. Without another matching route it is a
    404; a catch-all can now answer where an empty parameter used to shadow it, including a
    POST-only parameter route that previously caused a GET to fail. Catch-alls still carry
    empty inner segments.
    Corten keeps one suffix convention: it inserts `{name}text` as `{name}` and checks the
    suffix itself, so suffix-only alternatives remain conflicts, and no fallback catches a
    missing suffix. A `Route` written by hand and given to the hidden `Routes::__route` can put
    text before a parameter (`/a{x}/{y}`); such a route meets 0.9.2's conflict rules, and
    `Router::new` names the rejected path and the conflicting route at startup.

    Known limit: for those hand-written routes 0.9.2 refuses some pairs in one insertion order
    and takes them in the other, though no path is ambiguous between them. `/{z}/b` added after
    `/a{x}/{y}` stops the app, and added before it starts and answers each route's own paths;
    likewise `/{z}/b` after `/a{x}`, and `/{slug}/more` after `/shop{x}/desk` (0.8.6 takes all
    three in either order). Reorder the routes, or drop the text before the parameter, which no
    derived route has anyway. `tests/matchit.rs` and
    `tests::url::a_prefixed_hand_written_route_conflicts_in_one_order_only` hold this, so a matchit
    that fixes it fails them and this paragraph goes.

    What the exact pin costs: Cargo allows one semver-compatible version of a crate in a build,
    one 0.9.x here, so an app with another dependency that requires matchit 0.9.3 or later (a
    future axum, say) cannot resolve until Corten moves the pin; and a matchit fix, a security
    fix included, reaches apps only in a Corten release. The matched request costs about 50
    instructions more (0.29%), and an unknown path about 11 more (0.06%), measured below. The
    cost most likely arrived with 0.8.6, not 0.9: 0.8.6 rewrote `tree.rs` and changed
    `params.rs`, while from 0.8.6 to 0.9.2 `Node::at` is unchanged and `params.rs` only gains
    `Debug` impls, so `=0.8.6` would likely cost about the same (reasoned from the sources, not
    measured).
    Correctness and reliability take those costs first: no app changes matcher with its
    lockfile, and every app matches as Corten's tests do.

    Stands on: platform (matchit 0.8.4, 0.8.6 and 0.9.2 registry sources: 0.8.4 admits empty
    values before `/`, 0.8.6 and 0.9.2 refuse them; the 0.8.6 to 0.9.2 diff of `tree.rs` leaves
    `Node::at` alone and adds only insertion checks, each for a parameter with a prefix or
    suffix in its segment; crates.io's release dates for 0.8.6, 0.9.0, 0.9.1 and 0.9.2; Cargo
    unifies semver-compatible versions, so one 0.9.x per build; matchit 0.8.5's release note,
    "Fixed a bug where empty route parameters were accepted", from
    [ibraheemdev/matchit#60 Reject Empty Route Parameters](https://github.com/ibraheemdev/matchit/pull/60));
    measured (a probe of matchit 0.8.4 and 0.9.2, one router per question: on 0.8.4 `//posts`
    reaches `/{user}/posts` with `user` empty and `/x//y` reaches `/x/{id}/y` beside
    `/{*rest}` with `id` empty, while `/items/` reaches no `/items/{id}`; on 0.9.2 `//posts`
    and `/items/` reach nothing and `/x//y` reaches `/{*rest}`); measured (callgrind 3.19.0,
    release with thin LTO and glibc's allocator, three alternating runs each of
    `tests/router_cost.rs`, 1,200 requests less 200 divided by 1,000, the merge `4c6ac3e3d`
    against main `de46e974b`: a matched `/items/7/edit` request 17,413.113 instructions
    (17,412.966 to 17,413.119) against 17,362.966 (17,362.943 to 17,363.075), and a 404 at
    `/items/7/unknown` 19,095.113 (19,095.042 to 19,095.119) against 19,083.825 (19,083.792 to
    19,083.919); the same at `0653768e1` against main `d2f885c3e`, before main's patch
    stylesheets: 17,412.966 against 17,362.948 and 19,095.004 against 19,083.886); measured
    (those two commits built with line tables, one run each, giving the same +50.0 and +11.2,
    split by source file: the whole request is one
    inlined closure, and in the matched request matchit's `tree.rs` counts 10 more and its
    `params.rs` 9 more, standard-library slice, `Vec` and comparison code inlined beside them
    about 21 more, `memcmp` 9 more and `memcpy` 10 fewer, and no Corten file more than 3; in
    the 404 `tree.rs` counts 21 more, slice iteration 9 more, `params.rs` 5 fewer, `memcmp` 14
    fewer and `memcpy` 10 fewer: the cost is matchit's lookup and parameter code, not Corten's);
    reasoned (that lookup and parameter code is 0.8.6's: `tree.rs` differs by 954 changed lines
    from 0.8.4 to 0.8.6, and by 267 from 0.8.6 to 0.9.2, none of those 267 in `Node::at`;
    `params.rs` by 55 and then 11, the 11 being `Debug` impls; so `=0.8.6` would likely cost
    the same; not measured); reasoned (an exact pin makes a new app
    and the workspace resolve the same matcher, independently of axum; `tests/matchit.rs` asks
    matchit itself about values, catch-alls, trailing slashes, `%2F`, the fallback from a
    refused empty value to a catch-all, longest prefixes and suffixes, conflicts in either
    order, the order-dependent conflict above, an empty route and the nonconflicting suffix
    cases fixed in 0.9.1 and 0.9.2; the scope differential test checks that no matched path
    loses its area's or API's settings); value (correctness and reliability first, then
    measured request work, with one matching convention and a deliberate dependency, Values 1,
    5, 6 and 9).

    Revisit when: the pin changes, a matchit fix affects a route Corten accepts, the direct
    matching or scope tests fail, or an app needs suffixed alternatives that Corten's
    whole-segment convention refuses; matchit publishes any release after 0.9.2, or an advisory
    names 0.9.2 (read it, and take a fix in a Corten release); an app reports that it cannot
    resolve beside a dependency that needs a later 0.9.x; or a derived, area or API route may
    put text before a parameter, which would bring the order-dependent conflict to every app.
    Re-read insertion errors and the scope count with any version change, and measure matched
    and unknown requests before taking it.

    Last checked: 2026-11-13, matchit 0.8.4, 0.8.6 and 0.9.2 registry source read, including
    `tree.rs`, 0.9.2's `error.rs`, `lib.rs` and `tests/insert.rs`, against Corten at `0ff569c69`;
    2026-11-13, the four direct matching tests failed on 0.8.4 and passed on the exact 0.9.2
    pin, with all 17 dispatch tests passing after the deliberate empty-value change;
    2026-11-14, the 0.8.6 and 0.9.2 sources diffed file by file, and the order-dependent
    conflict run on both (0.8.6 takes every pair in both orders); 2026-11-14, crates.io's
    list of matchit releases read, matchit 0.9.2 the newest (published 2026-04-08) after 0.9.1,
    0.9.0 and 0.8.6; 2026-11-14, the matched and
    unknown requests counted at `4c6ac3e3d` against `de46e974b` and at `0653768e1` against
    `d2f885c3e`, with the same harness copied into each base snapshot, rustc 1.99.1 and
    valgrind 3.19.0, and the cost split by source file at the second pair;
    2026-11-14, the six direct matching tests, 17 dispatch tests, scope differential and the
    hand-written order-dependent conflict test passed in the full debug tests of `0653768e1`
    and of the merge `4c6ac3e3d`; 2026-11-14, matchit's release notes for 0.8.4, 0.8.5 and
    0.8.6 and [ibraheemdev/matchit#60 Reject Empty Route Parameters](https://github.com/ibraheemdev/matchit/pull/60) read, a probe of matchit 0.8.4 and 0.9.2 run on `//posts`,
    `/x//y` and `/items/`, and the 0.8.4, 0.8.6 and 0.9.2 sources line-counted file by file.

49. <a id="choice-release-verification"></a>**Release archives are verified with GitHub artifact
    attestations and `SHA256SUMS`; Corten keeps no minisign signing key.** `cargo binstall`
    checks a Corten archive's download over HTTPS, not against its build. Its users verify by
    hand before installation: download the archive and `SHA256SUMS`, run `gh attestation verify`
    against this repository's release workflow and the release tag, check the checksum, then
    extract the binary and put it on `PATH`
    ([Getting started](guide/getting-started.md#verify-a-prebuilt-binary)). The checksum detects
    a damaged download, not who built it; the attestation ties the archive to the workflow run
    that built it. This is the platform's standard build provenance, not a Corten signing format.
    The release workflow verifies each archive before publication and checks that the uploaded
    bytes match those verified
    ([#1369 Attest release binaries and verify checksums before publication](https://github.com/corten-run/corten/pull/1369),
    merged as `c3d455a1`). Its first tagged run has not yet been verified end to end.

    Not chosen: a minisign signature binstall checks itself. A long-lived key is another secret
    to hold, rotate and potentially leak, and adds a second trust root for one installation
    path. Binstall also documents just-in-time minisign keys, discarded after each release:
    these avoid a long-lived secret but still add a second signing scheme and public-key
    publication in the crate's metadata. Neither is needed to make each archive verifiable
    against its build, though the manual step remains a cost for binstall users.

    Stands on: platform (cargo-binstall's [signing documentation](https://github.com/cargo-bins/cargo-binstall/blob/b0ba29dbf234bdaba340dd6c57c96c560756b5e3/SIGNING.md)
    supports minisign, including just-in-time keys, not GitHub attestations, and its
    [supported metadata](https://github.com/cargo-bins/cargo-binstall/blob/b0ba29dbf234bdaba340dd6c57c96c560756b5e3/SUPPORT.md)
    has no checksum-file setting); platform (the [release workflow](../.github/workflows/release.yml)
    added in `c3d455a1` attests each archive and gates publication on verification against the
    workflow, source commit and tag, then publishes `SHA256SUMS` and the verified archives);
    reasoned (using that provenance avoids a second trust root and a long-lived signing secret
    to guard and rotate, at the cost of a manual check with `gh` for binstall users);
    value (standard platform evidence and a documented check serve Standards first and
    Verified, not assumed, Values 2 and 9, without another signing scheme, Values 5 and 6).

    Revisit when: binstall verifies GitHub attestations itself, closing the gap without another
    signing key; a user reports an installation path that cannot run `gh`; or the release
    workflow's first tagged run shows the attestation check failing.

    Last checked: 2026-11-14, cargo-binstall's `SIGNING.md` and `SUPPORT.md` read at
    `cargo-bins/cargo-binstall@b0ba29dbf234bdaba340dd6c57c96c560756b5e3`: minisign is the supported
    signature algorithm, just-in-time keys are documented, and neither GitHub attestation
    verification nor a checksum-file setting is documented; 2026-11-14, the release workflow
    read at `ff78cf143` against its introduction in `c3d455a1`, including `attest`,
    `verify-archives`, the `publish` dependency and the uploaded archive digest checks.

50. <a id="choice-patch-routes"></a>**A route a part is read again from says `patches`, and its `get` handler's type says
    it answers a patch: `HtmlResult<Patches>`.** `ReadAgain::from` has the runtime fetch a route
    with `corten: action` and apply the patch it answers; a page or a redirect there gives it
    nothing to apply, so the part stops updating with an error in the console and no build or test
    failing. A handler's result now carries what the runtime's read can get, as a second parameter
    of `HtmlResponse` beside `For` ([Choice 27](#choice-caller-types)): `AnyAnswer` (a page, a
    patch or a redirect, what `HtmlResult` is) or `Patches`, which only `action.patch`,
    `action.patch_with_status`, `req.patch_or`, `req.patch_or_with`, `req.invalid` and
    `req.invalid_with` make (the last four a patch in `Mode::Action` and their caller's page or
    redirect otherwise, `patch_or_with` taking the patch's side as a closure too, so a part with a
    read of its own runs it only for the read, [Choice 44](#choice-slow-part-link); the first two
    require the borrowed builder from `req.action()`, which checks that effective mode,
    [Choice 58](#choice-plain-request-patch)), since `HtmlResponse`'s
    constructor is the crate's own. A route says `patches` in its routes module; the module checks
    its `get` handler's result is `HtmlResult<Patches>` (or `Public<..>` or `NoStore<..>` of it),
    at the handler's name, and only such a route is a `PatchRoute`, the one kind of route
    `ReadAgain::from` takes. So a refactor that drops a `patch_or` fails the build. It is one
    handler model: the same request APIs, `?` on any `corten::Error`, and a handler that both
    redirects and patches (a write's) stays an `HtmlResult`; only the handler a part is read from
    names `Patches`, and there a redirect or page goes on `patch_or`'s other side, for a browser
    without JavaScript. The macro cannot read a handler's return type (it sees the handler's
    name), and stable Rust cannot name that type where the macro writes the route's impl, so no
    trait the route implements can follow its handler; a `const` there can, but only as a value,
    which only an assertion after monomorphization can refuse (Not chosen, below). So the route
    says `patches` and the macro checks it, as `rows = Level` is said and checked against
    `FeedResponse<Level>`. The trait the macro implements for such a route,
    `route::__private::AnswersPatch`, is public only because that impl is written in the app's
    crate and must name it; it is hidden and not an API. A route given by
    hand, a `#[derive(Route)]` struct, is never a `PatchRoute`: nothing ties its type to its
    handler, so `ReadAgain::from` refuses it rather than trusting it. A `PatchRoute` mounted by
    hand is held to its word as well, since `Area::route` and `Api::route` take a route type and
    any handlers: each answer type says its kind (`Answer::Kind`, `AnyAnswer` or `Patches`, as
    each says its `Rows`), `get(h)` carries `h`'s on the `Methods` it makes (`Methods<S, Patches>`;
    every other method's, and handlers with no `get`, are `AnyAnswer`, the default), and the
    routes macro tells `#[derive(Route)]` the route said `patches` (a hidden `Route::PATCHES`,
    true), so those two, and the routes macro's own `Routes::__route`, refuse such a route with
    any other `get`, or none. The kind is sealed, so an answer cannot claim it: `Answer::Kind` is
    bounded by `KindOf<Self>`, which `AnyAnswer` is for every answer and `Patches` only for the
    answers of a sealed trait, `PatchAnswer`, that holds `HtmlResponse<_, Patches>` and
    `corten::Result`, `Public` and `NoStore` of one; those three forward their answer's kind
    through `KindOf`'s hidden associated types, so the forwarding is proved for any answer they
    hold, an `impl Answer` among them, and an app's own type that says `Patches`, or forwards
    another answer's kind with `A::Kind`, does not compile (`compile_fail` doctests on
    `Answer::Kind`). The routes module's check of its own `get` reads the same `Answer::Kind`
    the mount reads, as a bound only `Patches` meets (a hidden `PatchKind`) with its wording at
    the handler's name, so the two checks cannot disagree on what answers a patch. The shape to
    write, and the one the message names, is `HtmlResult<Patches>`; as a compatibility detail, a
    handler returning `impl Answer<.., Kind = Patches>` passes both checks too (a test in
    [`tests/patches.rs`](../crates/corten/src/tests/patches.rs)), but rustc warns on it (`opaque_hidden_inferred_bound`: the `impl` does not
    prove `Kind`'s bound, which only the hidden type's impl can), which fails an app that denies
    warnings. The mount's side of that can only be a `const`: stable Rust has no bound for
    "a route that is not a `PatchRoute`", so it is an inline `const { assert!(..) }` beside the
    path-shape assertions the same functions already make
    ([Limit 11](#limit-caller-types)), which the compiler evaluates only when it generates the
    code that mounts the route: `cargo build`, and `cargo test` (or `cargo test --lib`) when
    something it generates reaches the mount, a test, a doctest or a library's own public code,
    with its message; not `cargo check`, clippy or rust-analyzer, which generate no code, nor a
    `cargo test` that generates nothing reaching the mount: `cargo test --lib` when no unit
    test reaches it, and `cargo test` when only a binary's `main` mounts the route (its test
    build never generates `main`'s callees), which `corten check` covers by building every
    target before its tests. Its error points into
    Corten's `mounted_with`, naming the route there (`mounted_with::<url::Status, AnyAnswer>`),
    not at the app's call: the note for a generic call names the call that instantiated the
    function holding the `const`, and `Area::route` cannot hold it itself, since its `Methods` is
    an `impl` argument it cannot name (an explicit type parameter would end `route::<R>(..)`);
    `#[track_caller]` changes nothing at compile time. That costs every
    answer type one associated type (an app's own says `type Kind = AnyAnswer;`), and `Methods`
    a defaulted second parameter, which a `get` of a `Patches` handler, or of one that hides its
    kind (`corten::Result<impl Answer<Inputs = AnyInputs>>`, which names it,
    `Kind = AnyAnswer`, where a `Methods` is named), changes.

    What still steps around it, each on purpose and none by mistake: implementing the hidden
    `route::__private::AnswersPatch` for a route, which makes it a `PatchRoute` whose handler
    nothing checked; calling the hidden `Methods::__patches`, which says any handlers answer a
    patch; and a second route at the same path, a `#[derive(Route)]` struct or a `Route` written
    by hand, mounted with a `get` that answers its page where the `patches` route's own module is
    not mounted: `ReadAgain::from(url::Status)` reads the path, and the other route's handler
    answers it; and a handler that writes `req.mode` (to `Mode::Document`, say) before
    `patch_or`, `invalid` or `invalid_with`, which then answer the mode it wrote, the page or
    a redirect, as they do for any `HtmlResult` handler (a test in [`tests/patches.rs`](../crates/corten/src/tests/patches.rs)). Writing
    `req.mode` is the app's explicit override, and it stays one: a mode those three read but
    the handler cannot write would change what an ordinary `HtmlResult` handler that writes it
    gets, and splitting them by kind would add a concept for a case few apps write. The derive's
    hidden `__patches` word is not one: it only adds the mount check.

    The cost to every app is that the
    patch-making methods have one more type parameter, which a handler's return type fixes; a
    closure handler whose result nothing fixes, or a call that names `For` with a turbofish,
    names it too (`action.patch::<ForOne, AnyAnswer>`). A `data-patch` form takes any route, as
    before: one whose handler answers its page gets that page swapped in, a working form that
    sends and draws the whole page, and the [requests guide](guide/requests-and-forms.md#request-modes)
    says so. Not chosen: a debug build answering 500, or `dev.js` saying so on the page, when a
    `ReadAgain::from` read gets a page, which finds the mistake only on a page someone opens under
    `corten dev` and only while the read happens; a `patches` word with no type behind it, which
    a refactor could leave standing on a handler that no longer patches; returning `Patches` from
    every patch-making method, which every handler that redirects on one path and patches on
    another would have to convert; requiring `patches` of a `data-patch` form's route, which
    would refuse forms that work; and a `const PATCHES: bool = false` on `Answer` beside `PAGE`,
    true for `HtmlResponse<ForOne, Patches>`, which the routes macro could copy onto every route
    from its `get` handler with no word (a `const` in the route's impl calling a generic
    `const fn` with `&handler`, as the `patches` check does) and `ReadAgain::from` could refuse
    with an inline `const { assert!(R::PATCHES, ..) }`. That works on stable, but the assertion
    fails only when the call is monomorphized: `cargo check` and rust-analyzer show nothing, only
    `cargo build` (or a test) fails, and its message is the assertion's, with no
    `on_unimplemented` wording at the route or the handler, where a trait bound fails where it is
    written, in the editor. For a route mounted by hand the same assertion is taken, because no
    bound can say it there; `ReadAgain::from`, where one can, keeps the bound. Also not chosen
    for that mount: refusing a `PatchRoute` in `Area::route` and `Api::route` outright, which
    leaves no way to mount one by hand with a handler that does answer a patch; a flag on
    `Methods` checked when the app starts, a panic at run time where the assertion stops the
    build; and `Methods` naming its `get` handler's whole answer type, which would change the
    type of every `get(..)` an app names as `Methods` (`Answer::Kind` changes only a
    `Patches` handler's and a hidden one's). And not chosen for the seal: `KindOf<Self>` without
    the hidden associated types, each wrapper saying `type Kind = A::Kind` where
    `A::Kind: KindOf<Self>`, which no bound proves for an `impl Answer` it holds, so
    `corten::Result<impl Answer<Inputs = AnyInputs>>` would stop being an answer at all; and
    leaving `Kind` open, which an app's own answer type could set to `Patches` and serve the
    runtime's read a page.

    Stands on: platform (a procedural macro gets the tokens of `#[route(..)]`, so `get = alerts`
    and not `alerts`'s signature, and stable Rust has no way to name a function's return type in
    an impl, `type_alias_impl_trait` being unstable, so no trait the route implements can follow
    its handler without a word on the route; a `const` in the impl can follow it as a value, and
    a `const { assert!(..) }` that reads it fails only after monomorphization, under
    `cargo build` and not `cargo check`, with no `on_unimplemented` wording; stable Rust has
    no negative bounds or specialization, so `Area::route` cannot refuse a `PatchRoute` with a
    `Methods<_, AnyAnswer>` by a bound, and associated type defaults are unstable, so `Route`
    cannot gain a type every `Route` written by hand would not have to name; the route's side of
    that check is the hidden `const PATCHES`, which has a default); reasoned (`HtmlResponse::new` is `pub(crate)`, so an app cannot make a
    `Patches` answer but through the methods that answer a patch to the runtime, and `Patches` is
    a `KindOf` only of an answer of the sealed `PatchAnswer`, so no answer type of the app's own
    can say it; the marker types
    are zero-sized `PhantomData`, so the response and every method's work are what they were, and
    the check is a `const` with nothing to run); measured (callgrind, release, instructions per
    request through a route's `patch_or` in process, 1,200 requests less 200 over 1,000, with the
    `#[ignore]` test `what_a_patch_or_request_costs` in [`tests/patches.rs`](../crates/corten/src/tests/patches.rs), three
    alternate runs of each build, the median and the range, on `0ff569c69` (before) and on
    `811324247` (after, a handler returning `HtmlResult` and one returning
    `HtmlResult<Patches>`): the patch (`Mode::Action`) 17,971.83 before (17,971.80 to
    17,971.84), 17,972.76 after with `HtmlResult` (17,972.75 to 17,972.83) and 17,972.76 with
    `HtmlResult<Patches>` (17,972.76 to 17,972.90), one more; the page (`Mode::Document`)
    18,404.68 before (18,404.65 to 18,406.15), 18,389.72 after with `HtmlResult` (18,389.65 to
    18,389.74) and 18,389.60 with `HtmlResult<Patches>` (18,388.02 to 18,389.69), 15 fewer; both
    differences are in how the generic methods were inlined, not work added or removed, and the
    two kinds cost the same); bet (the routes a part is read from are few and
    declared in a routes module, so the one word and the one return type cost an app little, and
    no app reads a part again from a route given by hand); value (mistakes fail at compile time,
    Values 4).

    Revisit when: Rust can name a function's return type where the macro writes the route's impl
    (`type_alias_impl_trait` or return-type notation for functions stable), so the marker could
    follow the handler without `patches`; or `cargo check` and rust-analyzer report an inline
    `const` assertion that fails after monomorphization, and it can carry a diagnostic of the
    crate's own, which would make the word-free `const PATCHES` as early and as clear as a bound,
    and the mount check as early; or stable Rust gains negative bounds or specialization, so
    `Area::route` and `Api::route` could refuse a `PatchRoute` with an `AnyAnswer` `get` by a
    bound;
    or an app needs `ReadAgain::from` on a route given by
    hand; or a `data-patch` form whose handler lost its patch is reported as sending whole pages
    unnoticed, which would make the form's route worth checking too.

    Last checked: 2026-11-14, rustc 1.99.1 and 1.88 (`rust-version`), `type_alias_impl_trait`
    still unstable, and the `compile_fail` doctests on `ReadAgain::from`, `Patches`,
    `Public::new` and `corten::routes` with the messages `tests/handler_message.rs` holds, on
    `811324247` (merged with main at `0ff569c69`), first written on `d1cb28f9`; 2026-11-14, a
    `patches` route mounted by hand (`Area::route`) with a `get` that answers its page refused
    when the app builds (the `compile_fail,E0080` doctest on `Methods`) and with one that answers
    `HtmlResult<Patches>` serving the patch
    (`a_route_that_says_patches_mounted_by_hand_with_a_patch_handler_answers_a_patch`), and a
    handler returning `corten::Result<impl Answer<Inputs = AnyInputs>>` building once its patch
    names `::<ForOne, AnyAnswer>` (the doctest on `AnyAnswer`; `Kind = AnyAnswer` on the `impl`
    still leaves it E0283), on `a2351ef92` merged with main at `de46e974`; 2026-11-14, an answer
    type of an app's own that says `type Kind = Patches;`, or forwards `A::Kind`, refused (the
    `compile_fail,E0277` doctests on `Answer::Kind`), `HtmlResult<Patches>` and `Public` and
    `NoStore` of it still `Patches` (the `Public::new` and `Methods` doctests), a `get` of
    `corten::Result<impl Answer<Inputs = AnyInputs, Kind = AnyAnswer>>` named as `Methods` (the
    doctest on `AnyAnswer`), a post-only mount refused with the mount's message
    (`tests/handler_message.rs`), and, in a scratch crate with the same assertion, a mount only
    `main` reaches passing `cargo test` and failing `cargo build --bins`, on `75d031c24`;
    2026-11-14, a handler returning `impl Answer<.., Kind = Patches>` taken by its routes module
    and by a mount, and its patch served
    (`an_opaque_patch_answer_is_the_get_of_a_patches_route_in_its_module_and_mounted_by_hand`),
    an app's own answer that holds a patch refused as such a route's `get` (the
    `compile_fail,E0277` doctest on `PatchRoute`), the routes module's message still at the
    handler's name (`tests/handler_message.rs`), on `89e355062`; 2026-11-16, with Corten itself,
    a `patches` route only a binary's `main` mounts with a `get` that answers a page passing
    clippy, `cargo test` and `cargo check --bins` and refused with E0080 by `cargo build --bins`
    and `cargo build --all-targets`, the same mount only an example's `main` reaches refused by
    `cargo test`, and one only a bench's own `main` (`harness = false`) reaches passing `cargo test`
    and refused by `cargo build --all-targets`, on `30bed57ed`.

51. <a id="choice-msrv"></a>**The Rust floor moves for a needed dependency fix, not for freshness alone.**
    The minimum supported Rust version (MSRV) is the oldest compiler Corten promises to
    build on, including the workspace's examples and all-feature/all-target CI check. It is
    not a recommendation to stay off newer stable Rust. Move it when a dependency release
    Corten needs for correctness, security or a maintained line requires a newer compiler,
    and record that dependency and need here. Keep the new floor at a Rust release at least
    about six months old at the time of the move. An urgent correctness or security fix that
    needs a newer compiler reopens this Choice rather than silently bypassing that guard.

    The floor is now Rust 1.89, released 2025-08-07, more than six months before this move.
    async-nats moves from 0.50.0 to 0.52.0: a received carriage return in a header value
    could panic a subscriber's connection task, so a publisher could stop its subscribers.
    0.52 fixes that; 0.51 also fixes spurious missing heartbeats and pull-consumer hot loops
    and bounds JetStream API requests. These affect the cluster's feed path. Both releases
    require Rust 1.89. There is no claim that 0.50 is abandoned: its missing fixes suffice.
    async-nats 0.53 keeps Rust 1.89 and fixes how the client requires TLS and trusts server
    discovery. `Cluster::start` takes the app's `async_nats::Client`, so staying on 0.52
    would prevent an app from taking those fixes.
    SQLx stays on 0.8.6. None of the Postgres, pool or TLS fixes in 0.9.0 is needed on
    corten-cluster's paths (Stands on, reasoned), but 0.9.1 fixes a pool race that applies
    to listings-feed. Returning a connection makes it available before incrementing the idle
    count. A concurrent checkout can decrement a zero count, and if maintenance reads the
    wrapped count, it can spin on a runtime worker. This is a risk confirmed from the source,
    not a reproduced Corten hang. Keep Rust 1.89 for now rather than raise the floor for all
    apps or carry a private SQLx fork without a demonstrated Corten incident. A maintained
    backport that builds on the floor, or SQLx 0.9.1 or later once the floor can move to Rust
    1.94, can close [#1673 SQLx 0.8.6 can spin a listings-feed worker in pool maintenance](https://github.com/corten-run/corten/issues/1673).

    auction-room keeps SQLx's bundled SQLite, which RUSTSEC-2026-0459 reports: SQLite before
    3.54.0 can return stale process memory when a process opens a database file together with
    a `-wal` file that a less trusted party wrote. auction-room opens only the file its
    operator names in `DATABASE_URL`, never one a user supplies, so it is not exposed, and its
    README says not to copy it to open such files.
    SQLx 0.9.1 now allows the fixed bundled libsqlite3-sys, but requires Rust 1.94.
    Keep the workspace floor at 1.89: although 1.94 meets the age guard, this example does
    not open untrusted database files, and upgrading it would raise the floor even if
    corten-cluster stayed on SQLx 0.8. Linking a system SQLite 3.54.1 built from sqlite.org
    was tried and rejected: it cost libclang, a C build and a download in every CI job and a
    patched SQLite for every contributor, and a version-only scan still flagged the crate.
    A scan of `Cargo.lock` reports the advisory; this paragraph is the exception, not an audit ignore.

    Stands on: platform (crates.io declares Rust 1.89.0 for async-nats 0.51.0 through 0.53.0,
    and Rust 1.94.0 for SQLx 0.9.0 and 0.9.1; the
    [async-nats changelog](https://github.com/nats-io/nats.rs/blob/async-nats/v0.52.0/async-nats/CHANGELOG.md)
    describes the header panic and JetStream fixes, and the
    [0.53.0 release notes](https://github.com/nats-io/nats.rs/releases/tag/async-nats%2Fv0.53.0)
    describe the TLS and discovery fixes); platform (sqlx-sqlite 0.8.6 requires
    libsqlite3-sys 0.30.1 and [0.9.1 allows `>=0.30.1, <0.41.0`](https://github.com/transact-rs/sqlx/blob/v0.9.1/sqlx-sqlite/Cargo.toml); the
    [SQLite advisory](https://rustsec.org/advisories/RUSTSEC-2026-0459.html) fixes the bundled
    source in libsqlite3-sys 0.39.0 / SQLite 3.54.0 and exposes only a process that opens a
    database, with its `-wal`, that a less trusted party could have written); bet (apps can
    move to a compiler about six months old at little cost but should not be forced onto a
    just-released one by a routine dependency refresh; nothing here measured that);
    reasoned (requiring a named fix keeps the build promise useful without making it a
    reason to retain a known failure; auction-room's only database is the file its operator
    names in `DATABASE_URL`, `src/main.rs` and its Dockerfile; corten-cluster needs none of
    the Postgres, pool or TLS fixes in the [SQLx 0.9.0 changelog](https://github.com/launchbadge/sqlx/blob/v0.9.0/CHANGELOG.md)
    (numbers are SQLx pull requests): it takes the app's `PgPool` and never calls `Pool::close` (#3952, close returning before its
    connections closed), builds no connect options (#3800, escaping `PgConnectOptions::options`),
    decodes no `rust_decimal` or JSON (#3919 and #4158, panics on an overflowing decimal and a
    bad JSONB version byte), takes no `PgAdvisoryLock` (#4199; its migration lock is
    `pg_advisory_xact_lock` in a transaction) and prepares only persistent statements
    (#3863); #4006 (SCRAM's SHA-256 moved off the async executor) and #4201 (SASLprep, so some
    non-ASCII passwords are accepted) touch only opening a connection, which it does at start,
    on relay election and when the pool grows: without them a runtime worker is held for one
    hash, and such a password is refused at start, where its operator sees it; it enables no TLS feature, so #4251 (a TLS socket that could wait on one
    direction forever, reported on MySQL over TLS on macOS) is not in its build, but an app
    that reaches Postgres over TLS enables that feature itself and, because `Cluster::start`
    takes SQLx 0.8's `PgPool`, stays on 0.8 without it; the remaining Postgres entries cover
    geometric types, `.pgpass` handling and query macros, which it does not use);
    platform (SQLx 0.8.6's [return and checkout](https://github.com/transact-rs/sqlx/blob/v0.8.6/sqlx-core/src/pool/inner.rs#L192-L213)
    can underflow `num_idle`, and its [maintenance sweep](https://github.com/transact-rs/sqlx/blob/v0.8.6/sqlx-core/src/pool/inner.rs#L539-L555)
    uses the count as its loop bound;
    [transact-rs/sqlx #4289 fix(pool): prevent num_idle underflow that wedges maintenance in a CPU spin](https://github.com/transact-rs/sqlx/pull/4289)
    shipped in 0.9.1); reasoned (listings-feed runs on multithreaded Tokio and leaves the
    pool's default idle and maximum-lifetime maintenance on, so taking the app's `PgPool`
    does not keep this race off the feed path);
    value (small surface and deliberate dependencies, verified rather than assumed: Values 6
    and 9).

    Revisit when: a SQLx release that builds on the Rust floor allows libsqlite3-sys 0.39 or
    later, any Corten crate or example opens a database another party could write, another
    advisory is published against the bundled SQLite auction-room builds, SQLx's TLS hang
    (#4251) is reported on Postgres, a Corten app reproduces or reports the pool hang,
    a maintained backport of the pool fix builds on the floor, the floor reaches 1.94,
    an app on corten-cluster needs another SQLx 0.9 fix, or a held dependency line needs a
    correctness or security fix or loses maintenance, the Rust floor moves for another needed
    dependency, or an urgent fix requires a compiler less than about six months old. Re-read
    release notes, compiler requirements and advisories before moving either driver, and
    record the reason and the new floor here with its checked build.

    Last checked: 2026-11-18, crates.io metadata for async-nats 0.53.0 and SQLx 0.9.1,
    sqlx-sqlite 0.9.1's manifest, RUSTSEC-2026-0459 and async-nats 0.53.0's release notes;
    2026-11-18, the SQLx 0.8.6 pool and defaults against listings-feed's pool setup on
    `51675cc48`, and the SQLx 0.9.1 changelog and Rust requirement for the fix;
    2026-11-14, crates.io metadata for SQLx 0.8.6 and 0.9.0, sqlx-sqlite 0.8.6
    and 0.9.0 and async-nats 0.51.0 and 0.52.0, their release notes, Rust 1.89.0's release
    date and RUSTSEC-2026-0459, against `7d232f93d`; 2026-11-14, the SQLx 0.9.0 changelog's
    Postgres, pool and TLS fixes against corten-cluster's SQLx use, on `f776b350d`.

52. <a id="choice-asked-open-state"></a>**A patch keeps what the user opened or closed, except that the element a `data-patch`
    answer replaces opens again when the user closed it and asked for it from outside it.** A
    patch carries a `<dialog>`, `<details>` or popover the user opened or closed into the fresh
    markup unless the server changed it from what it sent before
    ([#84 A patch or live fragment closes a <dialog> the user opened and folds a <details> they unfolded](https://github.com/corten-run/corten/issues/84)),
    as it keeps a field they edited ([Limit 2](#limit-whole-element-patches)): what a screen shows
    open belongs to the client showing it (README Value 8). That rests on the user's state being
    newer than whatever the patch draws, which holds for a redraw nobody asked for (a live
    fragment, a `ReadAgain` read, a script's `patch()`, a patch of a region around the element).
    It fails for the answer to a press: a Preview button beside a dialog, in a `data-patch` form
    whose answer draws the dialog `open`, opened it once, and after the user closed it the next
    press sent the request, got the dialog drawn open and showed nothing, since the user's close
    differed from what the server had sent
    ([#1371 A data-patch answer to a trigger outside a dialog cannot open it again once the user closed it: the patch keeps the user's closed state over the answer's open](https://github.com/corten-run/corten/issues/1371)).
    The press is newer than the close. So when a `data-patch` submit's answer replaces a
    `<dialog>` or `<details>` the user closed, draws it `open`, and the control that sent it is
    outside that element, it opens, as drawn: a dialog markup draws `open` is not modal, so one
    the user had modal opens modal only when the app makes it so, as
    `on:connect={corten_ui::dialog::modal(target)}` does when it joins the page (the issue's
    sheet does). The control that sent it is the submitter; when there is none (Enter in a form
    without a button, a script's `requestSubmit()`), the focused control if it is one of the
    form's, else the form, so Enter in a field of a dialog that a form with no submit button wraps
    is a press inside it. With a submit button outside the dialog, Enter goes through that button,
    which the browser makes the submitter, so it is a press outside. A button inside a dialog that
    names a form outside it (`form=`) is a press inside the dialog.
    It only opens: one the user opened stays open whatever the answer draws, as the rule above
    keeps it, since the issue asks for what the user closed to be asked for again, not for an
    answer to close what they opened. Outside is where the control was when it was pressed: the
    ids of the dialogs and `<details>` around it are read at the press, and a submit that waits
    for a write's answer carries them until it is sent, so removing the control, redrawing the
    dialog, replacing its form earlier in the same answer, or the write's answer redrawing the
    button, while the answer is on its way, does not make a press inside one outside (a check at
    the answer saw a removed button as outside every element and opened a dialog the user had
    closed). A press inside the element (a refused form in a dialog
    the user closed with Escape while it was on its way), the elements inside the one replaced,
    and every redraw nobody asked for keep the user's. A `data-patch` submit answered with a whole
    page, not a patch, redraws `<main>` from the new markup, its dialogs and `<details>` as drawn,
    as on main, while the layout's elements outside `<main>` keep the user's. When the server draws
    an open dialog closed, the runtime replaces it without calling `close()`. For a modal opened
    by the [optional dialog widget](guide/ui.md), the widget handles focus and sends `close` on
    the attached replacement
    ([#1455 A patch that draws an open dialog closed replaces it without the browser's close: no close event, and focus does not return to its opener](https://github.com/corten-run/corten/issues/1455)).
    A popover has no markup that shows it, so no answer can ask for one shown
    and it stays as the user left it. A non-modal dialog the user closes while the answer to a press
    outside it is on its way opens when the answer comes: the runtime knows the press, not what the
    user meant by the close after it. A script's `requestSubmit()` while focus is outside the
    form is a press outside, as the form is.

    Not chosen: keeping the user's state only while the server's markup of the element is what it
    was, so a dialog the server draws `open` again counts as the server changing it. It is wider
    than the press: a live fragment that sends an open dialog again, as a ticker redraws the same
    region, would open a dialog the user closed, the case #84 fixed. An attribute on the fresh
    element that says to open it, which the runtime honours: an answer could then say it, but it
    is a second way to open a dialog beside the markup's `open` and a concept of Corten's own,
    for what the press already says (README Value 5). Closing an open dialog with `close()` when
    the answer draws it closed: it was tried and taken out, since `close()` queues its `close`
    event after the patch has detached the dialog (so a delegated `on:close` handler never hears
    it), closes nested modals outer-first (so focus lands on the page), and lets a `beforetoggle`
    handler change the tree while the runtime walks it. The widget instead asks the runtime
    which patch root took its modal away, during the existing connect signal's abort. It looks
    only inside recorded roots, follows a detached counterpart through any further recorded
    replacements, and acts after the sweep, innermost first. A ref lookup during a patch reads
    the current tree without using the ref cache or draining mutation records. Once all the
    replacements are recorded, a patch that had such a lookup discards the warmed cache and
    ends the removed elements' lives before wiring the rest of that patch. A later connect
    then sees the new refs even before the observer has counted their changes. The observer
    scans after the patch sets CSS variables and current nav links, then clears the recorded
    roots as usual. If the successor is drawn open and has not connected at abort, the
    dialog widget passes the opener on after it connects
    ([#1629 A ref-taking focus handler between overlapping dialog replacements in one patch loses the dialog's close](https://github.com/corten-run/corten/issues/1629)).
    A dialog needs the drawn-state record made before connect, so a dialog a connect handler
    just created cannot receive the old close. Duplicate ids are invalid; moving an
    already-drawn dialog into a replacement
    root to reuse the removed dialog's id is outside the widget's contract. An open redraw
    carries the opener forward. A native close takes precedence over a forwarded one; a vetoed
    open is not a native close. Focus goes to the recorded opener or its verified replacement
    in the same removal sweep. Like native close, it does not follow an opener already lost
    to an earlier patch. A location guard loses a live close while a navigation is pending,
    and a page marker or document-wide id lookup can mistake unrelated same-page markup for
    the replacement. Neither navigation nor
    an arbitrary script removal is a patch. The pilot's workaround, replacing the closed
    dialog with an empty element before each submit, is the per-page script this removes.

    What it costs: the runtime is 386 bytes larger raw, 149 with gzip (15,069 to 15,218) and 124
    with brotli (13,601 to 13,725), paid once a release by every user. A submit reads the
    `closest` dialog or `<details>` around its control, once per one it is in (usually none),
    into a set, and with no submitter looks the focused element up among the form's controls; a patch pays an argument passed down, and the test runs for the patch's own root
    only, after the checks that already find the user changed it, as one `Set.has`. That patch work
    is reasoned, not measured: a few calls where the root's state is already read.

    The later widget close handoff adds 232 bytes raw, 98 gzip and 81 brotli to core (43,846 to
    44,078 raw, 15,612 to 15,710 gzip, 14,100 to 14,181 brotli). The optional served
    `ui.dialog.js` is 1,653 to 4,711 bytes raw, 714 to 1,691 gzip and 591 to 1,462 brotli
    (up from 4,315 raw, 1,568 gzip and 1,353 brotli before the widget-only fixes).
    Only a page that loads the widget normally opts in to the map. The patch records replaced
    or removed roots, not all ids in the document; the removal sweep clears those records.
    With no dialog or widget, 10,000 ids in Chromium took 0.0313 ms per sparse patch on both
    builds (ranges 0.0250-0.0788 and 0.0238-0.1413 ms); whole redraws took 18.3 and 18.4 ms
    (ranges 15.575-30.975 and 14.850-29.300 ms). The differences were smaller than run-to-run
    variation; neither patch looked up every id for the hook.

    Stands on: measured (minified core and served widget sizes, and the no-dialog patch timings
    above); platform (a `<dialog>`'s and a `<details>`' open state is their
    `open` attribute, which markup sets and closing removes, while a popover's shown state has no
    attribute; the watchlist's dialog, `<details>` and live checks, and the UI Gallery's close,
    focus and native-result checks, in Chromium, Firefox and WebKit);
    reasoned (a submitter, or with none the focused control of the form or the form, outside the
    element it asks for is the user asking for that element, and nothing else the runtime sees is; where it was is fixed by the press, not by
    what the page became while the answer was on its way; the cost is a few calls in the cases it
    changes);
    value (a control pressed again that does nothing visible is wrong output, the README's conflict
    order 1, correctness, above the bytes it costs, its 2; a server-drawn dialog opens from its
    trigger without a per-page script or an attribute of Corten's own, README Value 5; the user's
    open state still belongs to the client wherever they did not ask, README Value 8).

    Revisit when: an app needs a form outside an element to redraw it without changing its open
    state (a Refresh beside a sheet the user closed on purpose), which would call for a way to say
    so; the platform gets markup for a shown popover, when an answer could ask for one; or a
    press inside an element is found to ask for it open (a Show more in a `<details>` the user
    folded), when the rule would need the submitter's intent rather than its place; a real app
    needs native close semantics for a user-opened dialog or for a kept layout dialog updated in
    place, or needs focus to follow an opener lost outside the sweep, which this replacement-only
    widget does not address; or the platform provides a native close that can be observed by
    an attached handler during replacement, so the widget's forwarding and the core lookup
    can go.

    Last checked: 2026-11-14, the smoke's dialog and `<details>` reopen checks failing with main's
    runtime (`e59c32c28`, the checks as at `c264af2ac`) and passing on `bf1b2eaa2`, and its
    in-flight and live checks passing on both, in Chromium 156.0.8078.4, Firefox 157.0 and WebKit
    27.2 (Playwright 1.64.1); 2026-11-14, the runtime's size on `bf1b2eaa2` against `e59c32c28`;
    2026-11-14, the press recorded where it was on `c1b7bce23`, the smoke's removed-button,
    redrawn-dialog and form-first checks passing in Chromium 156.0.8078.4; 2026-11-14, the rule
    narrowed to opening only on `6011ef751`: the runtime's size against `8f11b7b35`, and the
    smoke's open-state checks, the one that keeps a dialog the user opened open among them,
    passing in Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2; 2026-11-14, the control of a
    submit with no submitter read from focus, and `within` carried by a submit that waits for a
    write: the smoke's Enter and `requestSubmit()` checks failing on `fef11cb38` and passing with
    them, every open-state check passing, in Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2,
    and the runtime's size against `8f11b7b35`; 2026-11-14, the smoke's check of a submit that
    waited for a write, its button moved outside the dialog by the write's answer, failing on
    `fef11cb38` and passing on `50371f299`'s runtime, in the same three engines. 2026-11-18,
    the widget close handoff at `9ce6fe5c9` against main `70dd920cc`: served bytes by Node 24's
    zlib defaults once per build, and no-dialog patch time from 51 alternating pairs per case
    in Chromium 156.0.8078.4 (sparse and whole redraws at 100, 2,000 and 10,000 ids). The gallery's
    lost opener, same-id navigation, unrelated id reuse and two native close races failed
    with `faa5ae1f8` in Chromium. A live patch during a pending navigation passed there, but
    delivered no close with main `70dd920cc`.
    The gallery's close checks passed with the handoff in Chromium 156.0.8078.4, Firefox 157.0
    and WebKit 27.2 (Playwright 1.64.1). 2026-11-18, the gallery's vetoed-open, dialog-first
    overlap and script-created same-id cases failed on `e4a97b811` and passed with the widget
    fixes in the same three engines. The reverse overlap order passed on both. Core was
    byte-identical to `e4a97b811`. 2026-11-18, with a focus handler that reads a ref, both
    replacement orders lost the close and result on `e927c2463`. 2026-11-19, both orders pass with
    direct ref reads during a patch, and those reads see current markup in Chromium 159, Firefox
    159 and WebKit 27.2. In each engine, a later connect sees the old signal aborted and the
    patch's CSS variables and current nav link applied, unlike on `ac87c5b03`. An overlapping
    redraw that keeps the modal open still returns focus to the original opener on a later close.
    In the same three engines, the warmed-ref smoke's later connect saw only the surviving ref on
    `ed1ce4b21` and both the surviving and added refs after the cache reset.

53. <a id="choice-page-actions"></a>**A page's several writes are named posts of its own route, chosen by a `do` parameter
    in the address each form posts to, not by the pressed button's name in the body or a route per
    write.** A path takes one `POST`, so a screen with several writes gave each a route of its
    own, and each such route declared the page's query set again so its handler could redirect
    back to the view it was sent from: 53 times in one port of a marketplace's seller screens
    ([#1403](https://github.com/corten-run/corten/issues/1403)). A route now names its writes
    beside its plain `post`, `post(price) = set_price`, and the routes module gives the route a
    method per name, `at.price()`: an `Action` whose address is the page's own with `do=price`,
    which renders as an attribute value (`action={at.price()}`, `formaction={at.price()}`) and is
    not an `Href`, so nothing links or redirects to it. At a route with named posts, and only
    there, the router's `POST` handler reads `do` from the request's query and calls the handler
    it names, or the plain `post` when it names none, and answers 400 with the names the page has
    otherwise; a `GET` or `HEAD` of the same address draws the page. Each handler takes the
    page's `Params`, so the query set is said once and reaches every write and its redirect.

    The address carries the name because a browser sends a form to the pressed button's
    `formaction`, else the form's `action`, query kept, in both of a post's encodings, with or
    without JavaScript, and the runtime's `data-patch` send reads the same two attributes, so the
    runtime did not change. The query is read before the body, so a multipart upload is chosen as
    a urlencoded form is, and the chosen handler's extractor keeps the body: its limit, its
    streaming and its errors. Enter in a field presses the form's first submit button, so it
    sends where that button does, and `requestSubmit()` with no submitter sends to the form's
    `action`: each goes where the markup says, as a click does.

    Not chosen: the pressed button's `name` and `value` in the body, HTML's own way to say which
    control submitted a form (Rails' `commit`, Django's submit names). Routing on it reads the
    body before routing: a urlencoded body is buffered, parsed and handed on, and a multipart one
    is read until the submitter's part, which a browser writes in tree order among the others
    (after a file input above it), so the router would hold the files ahead of it under a limit of
    its own or take the body from the handler's `Upload`, and every post to such a route would pay
    that read. A route per write with a shared query set, what apps wrote: correct, and still a
    route and a `Params` per write that each say the page's query, the duplication the issue
    counts. A `back` parameter or the `Referer` to redirect to: the handler would redirect wherever
    a request says, an open redirect to guard, and still could not read the page's view as typed
    `Params`. A path per write under the page (`/inventory/price`): a route of its own again.

    `do` is a query parameter of Corten's own on an address users see
    ([Rule 10](#rule-standard-formats)). The standard way to name the pressed control is its name
    and value in the body, which does not fit for the reasons above; what carries Corten's
    parameter, a `formaction` or an `action` with a query, is HTML's own, and Corten moves to the
    submitter if a browser ever sends it where a server can read it before the body. A route with
    a query parameter of its own named `do` does not compile, nor does a post named for one of a
    route's own methods (`href`, `at`) or with a name that is not ASCII, which a browser would send
    percent-encoded. What it leaves open is a form with no `action` on a page drawn at a post's
    address, which posts there again ([Limit 29](#limit-page-action-address)).

    What it costs, in instructions per request on the request path (the release test
    `what_a_page_with_posts_costs`, callgrind, the difference between 1,200 and 200 requests):
    a write that is a named post, `/desk?page=3&do=price`, is 22,928 where the same write at a
    route of its own, `/desk/price?page=3`, was 21,882 before this change, 1,046 (4.8%) more: the
    router finding and reading `do` (about 190 of it when the name was compared undecoded, 78 more
    to decode it as `Params` does) and the rest the handler's `Params` decoding one more query
    pair, which it reads and drops. The page's plain `post` beside named posts is 22,010 against
    21,805 (205 more, the router reading the query), and drawing the page, whose forms now write
    `/desk?page=3&amp;do=price` where they wrote `/desk/price?page=3`, 22,321 against 22,230 (91
    more). A post to a route with no named post, mounted as before, is 21,893 against 21,882 (11
    more, with none of this change's code on its path). The runtime is unchanged.

    Stands on: measured (instructions per request under callgrind, three runs of each case alternating between the
    two builds, every run within 2 of the others); platform (a form's submission goes to its submitter's
    `formaction`, else its `action`, query kept, for `application/x-www-form-urlencoded` and
    `multipart/form-data`, where only a `GET` replaces the query (HTML's form submission
    algorithm); the smoke's urlencoded and multipart named posts with and without JavaScript, and
    a `data-patch` one, in Chromium, Firefox and WebKit); reasoned (the router reads the request's
    query, which it already holds, and no body, and a route with no named post is mounted as before;
    the `do` key and its name are percent-decoded as `Params` reads the query's other keys, so an
    address names one post however it is spelled, and only a pair with a `%` pays to decode); value (a
    screen's view is said once and every write goes back to it, and a post a page does not have is
    a compile error, README Value 4; it works without JavaScript and in both encodings, Value 3; a
    page's writes are its route's, one concept rather than a route per write, Values 5 and 6).

    Revisit when: a browser sends the submitter where a server can read it before the body (a
    header), when routing on the standard submitter would cost no body read; an app needs one of a
    page's named posts sent from another page's form, which a path of its own still serves; or an
    app needs a query parameter named `do` on a page with posts.

    Last checked: 2026-11-15, instructions per request on `e69833f2c` against `dea1788d2`, three
    runs of each case alternating between the two; 2026-11-15, three runs of each case on
    `bd92c7435`, which decodes `do`, against those of `dea1788d2`, every run within 2 of the
    others; 2026-11-15, the watchlist and ui-gallery smokes on `bd92c7435` in Chromium 156,
    Firefox 157 and WebKit 27.2 (Playwright 1.64.1).
54. <a id="choice-html-parse-refusals"></a>**`html!` refuses markup a browser parses differently from how it
    is written (an element in an element whose content is text, a `<plaintext>`, and an element
    taken out of foreign content, and literal HTML nesting that closes or discards an open
    element), and the shapes of a patch's top level the runtime's parse of it loses wherever they
    are written, where the markup shows how a browser parses it. A code-generating build also
    refuses known top-level losses when it sees the view sent as the entire patch. Script and style literals
    that need a known context are refused when the markup cannot prove one.** An element written in a
    `<textarea>`, an HTML `<title>`, a `<script>`, a `<style>`, an `<iframe>`, an `<xmp>`, a
    `<noembed>` or a `<noframes>` was written by `html!` as markup and read by the browser as
    text, a `<plaintext>` made the rest of the page text, its end tag included, and an element the
    HTML standard's rules for foreign content take out of an `<svg>` or a `<math>` (`<b>`, `<div>`,
    `<p>`, `<span>`, `<table>` and the others it lists, and a `<font>` with `color`, `face` or
    `size`), written straight into one, closed the drawing or the formula before it. Each compiled, and the view's author
    found the text or the moved content only on the page. Now each is a compile error that says
    what to write instead: the element beside the holder, or text meant to show tags as a string;
    behavior in a `#[component(js)]`, styles in the component's CSS, or a data block's content as
    a string literal, which an HTML `<script>` or `<style>` writes as is; `<pre>` for preformatted
    text; HTML in a drawing inside a `<foreignObject>`, and in a formula inside an `<mtext>`
    (`compile_fail` examples of `html!`). Text
    and expressions in the elements read as text compile as before, written escaped; an expression
    in a `<script>` or a `<style>` was refused already.

    A foreign `<script>` or `<style>` stays in the HTML tokenizer's data state. Where the markup
    shows foreign content, `html!` escapes a literal's `<` and `&` at compile time so a browser
    keeps the text instead of opening a tag or decoding a character reference. This uses the
    standard's text encoding rather than rejecting valid source such as a spaced comparison or
    `&&`. HTML (including HTML integration points) keeps the raw write. In an unknown context
    a literal with either character is refused: encoding changes HTML raw text, while writing
    raw text can change foreign content. An optional breakout attribute on a `<font>` can pop
    the surrounding foreign elements, so its children and the markup after it are not known.
    Each conditional arm starts in the same context; if an arm can change it, the markup after
    the conditional is not known. A loop that may change context is checked for such literals
    anywhere in its body, even before the change, since the next iteration starts where the
    previous one left off. Ordinary comparisons and other harmless `<` in known HTML raw text
    do not change that context. None of these checks add a render-time decision.

    The runtime parses a patch as a `<template>`'s content, where the first top-level element
    other than a head's (`<script>`, `<style>`, `<link>`, `<template>` ..) decides how the
    rest is read, so a table row beside a status line was dropped with only a console error
    ([#1409 A patch that puts a table row beside other top-level elements loses the row: the runtime's template parse drops it, and only a console error says so](https://github.com/corten-run/corten/issues/1409)).
    In a view that could be a patch (every top-level element has an `id={..}`), `html!` refuses
    three shapes: a table part (`<tr>`, `<td>`, `<th>`, `<tbody>`, `<thead>`, `<tfoot>`,
    `<caption>`, `<col>`, `<colgroup>`) after a first `<table>`; an element HTML's wherever it
    lands (one the rules for foreign content take out of an `<svg>`: a `<p>`, a `<div>`, a
    `<table>` ..) after a first `<col>`; and after a first other table part, a `<table>` at the
    top level or in a later top-level element that is not a table part, and a `<form>` there that
    holds an element, where an element HTML's wherever it lands is the form's, around it or in it (a
    `<form>` holding a `<div>` or a `<p>`, or one in a `<div>`), neither read into a
    `<template>`, an `<svg>` or a `<math>` (whose `<form>` is SVG's or MathML's, kept as written
    even in a `<div>`), or an SVG or MathML integration point. Each is lost wherever the view is written,
    under the rule below: in a patch the view begins, the parse drops the table part, or every
    element after the `<col>` but a `<col>` or a `<template>`, or drops the `<table>` tag and
    moves its parts out, or puts the `<form>` in empty and moves what it holds out of it; in a
    patch that already began with a table part (one an element or a component before the view
    wrote), it drops the `<table>` tag and reads the table's parts as the patch's, drops the `<col>`
    or puts it in a `<colgroup>` it adds, or does to the third shape what it does where the view
    begins; in a patch that began with another element, and in a page's body, the parse drops the
    table part, the `<col>` or the first table part; in a page's table, the `<table>` closes it,
    the element after a `<col>` is moved out of it, and the third shape's `<table>` closes it or
    its `<form>` is put in empty; and in an `<svg>` or a `<math>`, the `<table>`, the element
    after a `<col>` or the element HTML's wherever it lands in or around the `<form>` closes the
    drawing or the formula. A test in `corten` (`a_shape_html_refuses_is_lost_after_each_table_part`)
    holds each shape, and each kind of the third (a `<table>` at the top level, in a `<div>` and
    in a `<label>`'s `<span>`; a `<form>` holding a `<div>`, a `<p>` or a `<label>`'s `<span>`,
    and one in a `<div>`), written first and after each of the nine table parts, to
    `crates/corten/src/patch-parsing.json`, whose parses `scripts/smoke.mjs` checks in Chromium,
    Firefox and WebKit; the other places were probed once (Last checked). No other shape of the
    kinds these come from is lost wherever it is written: after a first `<tr>`, `<td>`, `<tbody>`
    or `<caption>`, a `<p>`, `<div>` or `<span>` is kept (moved before the table that is not
    there) and a table part after it too, so a component that writes
    `<p id={NoteId}>..</p><tr id={RowId(8)}>..</tr>` is correct where its parent writes a row
    before it, and compiles; and a `<form>` of fields (`<input>`, `<select>`, `<textarea>`,
    `<button>`, a `<label>` around them) after a first table part, which the patch's parse puts in
    empty, is kept as written in an `<svg>` or a `<math>`, where none of them is taken out, so it
    compiles, though few views will be written there: refusing it would refuse a component that is
    correct where its parent writes it, which the rule below does not allow.

    Where the whole patch is a concrete `html!` view, the first literal element can decide the
    reading. The macro marks a loss at a later literal sibling: a table part dropped after a body
    element, a table part dropped or wrapped after a different kind of table part, or anything but
    a `<col>` or `<template>` dropped after a first `<col>`. It checks both readings of a leading
    `<title>`, `<base>`, `<basefont>`, `<bgsound>` or `<noframes>`: the standard and Firefox read
    it as a head's, and Chromium and WebKit let it choose body rules. A zero-sized return shape
    carries the diagnostic as a lazy constant. `Action::patch_with_status` and `FormPatch::draw`
    evaluate it when Rust generates code for a concrete view; `cargo check` does not. Even a
    send inside a literal `if false` is checked, independent of which branch a request takes.
    The doc-hidden `__private::PatchShape` lost dyn compatibility. No supported API changed:
    the sealed method adds no bound to `Patch` callers and does not enter the `dyn Patch` vtable.
    A component, reference, optional patch or collection can be part of a larger composition and
    supplies no verdict. `corten::live` already takes rendered fragments. The debug check still reads every
    patch sent, reports a loss with a 500 (or panics for a live fragment), and is where losses
    involving unseen output or top-level blocks are found ([Limit 2](#limit-whole-element-patches)).

    `html!` sees only its own markup, so it acts only where that markup shows how a browser
    parses it, following the HTML standard's tree construction: HTML under an element that is
    HTML's wherever it lands (one the rules for foreign content take out of an `<svg>`, a
    document's `<head>`), in an `<svg>`'s `<foreignObject>`, `<desc>` and `<title>` (its HTML
    integration points), and in a `<math>`'s `<mi>`, `<mo>`, `<mn>`, `<ms>` and `<mtext>` (its
    text integration points, where a `<mglyph>` or a `<malignmark>` stays MathML's) and an
    `<annotation-xml>` whose first `encoding` (the one a browser keeps of an attribute written
    twice) is `text/html` or `application/xhtml+xml`, in any letter case; SVG in a
    literal `<svg>` written where the markup shows HTML, where a `<textarea>`, `<title>` or
    `<style>` is SVG's and holds elements;
    MathML in such a literal `<math>`, outside those points, and in an `<annotation-xml>` whose first
    `encoding` is another or that has none (where an `<svg>` is SVG's, as the standard's tree
    construction dispatcher has it), where they are MathML's and hold elements, and an
    element taken out of foreign content is refused. At the top of a component's markup, which its
    parent may write into an `<svg>`, among a component's children, which go where the component
    writes them, after an expression or a component (what it writes may open or close an `<svg>`
    or an element read as text), and in an `<annotation-xml>` where an expression or a spread
    comes before any written `encoding` (either may write the first one), it does not know, and
    makes no context-dependent structural refusal; nor in what an element read as text there
    holds, or a `<noscript>` anywhere,
    which may be text (below). A literal `<svg>` or `<math>` written there is foreign wherever it lands, but
    its namespace is not shown (a `<math>` in an `<svg>` is SVG's, an `<svg>` straight in a
    `<math>` MathML's), so an element taken out of foreign content is refused straight in it,
    literal text in a foreign `<script>` or `<style>` is escaped, and
    what any element that is an integration point of either namespace holds is not known.
    `html!` writes attributes in the order they are written, so the first `encoding` in the markup
    is the one a browser keeps. The structural checks miss a mistake rather than refuse an
    element whose context they do not know, so a component that draws an SVG fragment without
    its `<svg>` (`<rect><title>"Sales "<b>"42"</b></title></rect>`) compiles. The separate
    literal encoding check can refuse a script or style literal that worked at its one actual
    placement. A static data block in a fixed HTML-only slot can pass the complete tag via
    trusted `raw` without untrusted input ([Views](guide/views.md)); otherwise put the literal
    directly in markup that shows HTML. The proof is local to tag boundaries; it does not
    emulate HTML tree construction or resolve arbitrary fragment insertion modes
    ([Limit 30](#limit-markup-context)). The accessible-name check and the named
    link's `href` check keep their older rule, under which only an `<svg>`'s `<foreignObject>`
    holds HTML, so an `<a>` in an `<svg>`'s `<title>` or `<desc>` is not held to them, as before:
    moving them to the standard's integration points would refuse markup that compiled.

    Literal ancestors also establish the start-tag rules for HTML nesting: a block in a `<p>`
    closes a paragraph in button scope; an `<li>`, `<dd>` or `<dt>` closes an earlier item when
    no special element but an `<address>`, `<div>` or `<p>` intervenes; an `<a>` acts on an
    active anchor before the last formatting-list marker; a `<button>` or `<nobr>` closes an
    earlier one in scope; and a heading directly in a heading closes it. A nested `<select>` or `<input>` closes a select in
    scope; option, option-group and ruby starts generate implied end tags where their scope
    establishes it, keeping the exceptions for an `<option>` in an `<optgroup>` and an `<rt>`
    in an `<rtc>`. These now fail at compile time, with or without refs,
    since moved content can leave the component's scope.

    Every refusal rests only on facts the literal markup of the same `html!` proves, between
    the two elements it relates. An unknown fact does not cause an element to be refused, but it
    can make a script or style literal impossible to encode correctly for all contexts. Unseen
    are the caller's context at the top of the markup, a
    component's output (with or without children) and where it writes its children, an
    expression's output, `raw` among them (trusted text with no promise to be balanced, so it may
    open or close any element), and what an HTML `<script>` or `<style>` writes when its text
    can end it early (a matching end tag) or keep a script open past its generated end tag
    (`<!--<script>`). The macro checks those lexical transitions across adjacent literals; it
    does not parse markup after an early close to recover the context. Also unseen is the
    namespace of a literal `<svg>` or `<math>` written where the markup does not show HTML.
    Every component is unseen, `<Corten />` included: the
    macro knows a component only by the name it is written with, which an app's own component may
    share, and proving the path names `corten::Corten` would refuse such a component, which is
    valid markup. Unseen output may also leave a browser reading text rather than tags: a
    `<script>` it opens (or one whose text holds `<!--<script>`) runs past any literal
    `</script>` until a second one, a `<plaintext>` to the end of the page, a comment to its
    `-->`, a `<textarea>` to its end tag. So the tokenizer's state is a fact apart from the
    namespace and the open elements, and a later literal start tag proves none of them: once
    the walk or the parser passes an unseen node, an element after it in the same `html!` is
    not refused on that structural basis, in a `<template>`, an `<svg>` or a `<foreignObject>`
    it opens too. Script and style literals that need a known context are still refused there.
    One body of an `if` or `match` does not follow another, so a refusal in a body with nothing
    unseen before it stands.
    One context is taken as known rather than proven, and it is a precondition, not an
    exception: `html!` output, a component's included, is drawn where a browser reads tags.
    Writing a component into script or style text its caller left open is not supported, since a
    script's text comes from a string, not markup: a component `TemplateMarkup` whose markup is
    `<p><div>"Detail"</div></p>`, written after `<script type="text/x-template">"<!--<script>"</script>`
    and before `{raw("</script>")}`, is refused for its `<div>`, though Chromium, Firefox and
    WebKit keep the whole as the script's text (the sixth review's counterexample). The promise
    that no context-dependent structural refusal stops markup a browser keeps as written holds
    for output placed where the browser reads tags; this is the shape it does not cover. Inside a literal
    element, where the markup does not show it is HTML's, what an element a browser parsing HTML
    reads as text holds (`<iframe>`, `<textarea>`, `<title>`, `<style>`, `<script>`, `<xmp>`,
    `<noembed>`, `<noframes>`, `<plaintext>`) is unseen, not tags: as HTML's it is text, as
    SVG's or MathML's elements, so `<iframe><p><div>"Detail"</div></p></iframe>` at the top of a
    component compiles (all three engines keep it as the iframe's text), and after a
    `<plaintext>` there nothing is refused. What a `<noscript>` holds is unseen everywhere: text
    with scripting on, markup without it. This is a structural rule: for literal encoding, a
    direct `<style>` in a known HTML `<noscript>` can keep its bytes in either scripting mode
    when preceding content preserves the context and the text cannot close either element early.
    In an `<svg>` or `<math>` the markup places (a
    literal `<svg>` under a `<div>`) they hold elements, which are read as before. Kind by kind:
    an element read as text needs its holder to be parsed as HTML (an element that is HTML's
    wherever it lands, or an integration point of an `<svg>` or `<math>` such an element holds,
    with nothing unseen before the holder in the same `html!`) and the holder's content up to
    the element to be literal; an expression there may write `</textarea>`. A `<plaintext>` needs the first of
    those. An element taken out of foreign content needs to be written in a literal `<svg>` or
    `<math>`, through elements that are an integration point in neither namespace, with nothing
    unseen before it in the same `html!` (between them it may write a `<foreignObject>`, before
    them leave a script open); it does not need the root's own
    namespace, since a start tag of that list leaves SVG and MathML alike. A nesting rule needs
    both elements to be HTML's, as above, every element open between them to be literal, and
    nothing unseen before the inner one in the same `html!`: an expression between them may close the outer element
    (`raw("</p>")`) or open a boundary that stops the browser's search (`<button>`, `<object>`,
    `<ul>`, `<dl>`, a `<span>` under a heading or an option, a `<ruby>`, an `<svg>`, a
    `<template>`), and browsers then keep the inner element where it is written. The search
    starts at the inner element and stops at the first literal match or boundary within that
    range, finding nothing past it; one before the outer element may leave a script open, which
    makes both literal start tags text. A nested `<form>` is not refused: the form pointer is not
    reset by scope and a template's content does not use it, so it needs the markup to show that
    no `<template>` is open anywhere around the inner form. Only a document's markup shows that,
    and a document's body follows its `<Corten />`, which is unseen, so no markup proves it, and
    the rule is gone rather than kept for a document's `<head>`. A duplicate attribute and a hand-written `data-key` are refused by the one start tag
    that writes them, which needs no context; after unseen output that start tag may be a
    script's text, which a browser keeps, and it is refused still, since two values for one name,
    or a key written two ways, is a mistake in the source wherever it lands. A patch's top-level shape needs its first element
    and the later one to be literal top-level elements of a view that could be a patch, with
    nothing unseen before the lost element's start tag: in the first element, between the two,
    or in a later element that holds the lost one, before it. Unseen output there may leave an
    element open (`raw("<table>")` keeps a later row in its table, `raw("<template>")` in the
    first `<table>` keeps one in its content, as Chromium, Firefox and WebKit parse it), so after
    an expression, a component, such a script or style, or a block or an element that holds one,
    nothing is refused and the debug check finds the shape when it is sent. What a lost
    top-level element holds does not save it, since the parse loses it at its start tag:
    `<table id={..}>{text}</table>` after a first row is still refused, as is a row holding an
    expression after a first `<table>`. That
    gives up a `<form>` after a first table part with an expression in it, which the parse empties
    at its start tag whatever the expression writes, as a miss. Where the patch lands is not
    needed for the refusals made where `html!` is written; the send boundary adds that fact for
    the literal whole-patch cases.

    `html/nesting.rs` walks the parsed nodes once in document order with a stack of literal
    ancestors and stops refusing at the first unseen node; each control-flow body starts from
    where its block does (any body is written first some time, and a refusal in a loop's first
    run holds whenever it runs), what follows the block following any of them. The parser does
    the same for the text-holder and foreign-content refusals: after an unseen node a literal
    `<svg>`, a breakout element or a `<textarea>` shows neither the namespace nor a text holder.
    That gives up the shapes a browser would change anyway whose proof crosses an unseen node:
    `<p>{text}<div>` compiles though no text can keep the `<div>` in the `<p>`, and so does
    `<svg><foreignObject><textarea><b>` at the top of a component, which a browser changes in
    either namespace, and so does anything in a document's body, which follows its
    `<Corten />`, and a nested `<form>` anywhere, and `<iframe><p><div>` at the top of a
    component, which a browser changes only where its parent writes it into an `<svg>`, and
    `<noscript><p><div>`, which it changes only with scripting off; misses, rather than refusals
    that would also stop the shapes browsers keep.
    It adds no render code: `Gen` writes what it wrote before this change (the `<Corten />`
    assertion an earlier round of it added is gone). Its compile-time
    cost, measured at `960b2d5a0` by the ignored `nesting_check_cost` test in a release build
    (one Linux container, 4 CPUs): a 3,001-element list four elements deep, walked 1,000 times
    a sample, took 308.2, 304.1 and 280.5 µs a walk (median 304.1 µs, about 0.1 µs an element).
    Not measured: the whole macro expansion, the duplicate-attribute check, how the walk
    grows with ancestor depth, and the walk as this round leaves it (one flag in place of the
    unseen count and the template state, and no form rule, so no more work a node; nor the
    seventh round's test for an element that may read as text, a few name comparisons an
    element; not run again).
    Each rule keeps its own scope boundaries; a nested list in a `<ul>` and a form in a
    `<template>` still compile. The content of a `<template>` and of a foreign element (an
    `<svg>`, a `<math>`, their integration points, or an element whose namespace the markup does
    not show) starts with nothing open rather than modelling the tree builder further: an `<a>`
    reached through a `<foreignObject>`, `<title>`, `<desc>`, `<mi>` or `<mtext>` inside an
    outer `<a>` is kept by browsers and compiles.
    A duplicate emitted HTML attribute name is refused case-insensitively, with an expression
    value too: `ref`, bare `page` and `key` are compared as `data-ref`, `data-corten-page` and
    `data-key`, so their uppercase literal names are distinct, as is `page=".."` beside bare
    `page`. Repeated pseudo-attributes are still duplicates. Spreads remain opaque, so the first
    `encoding` rule still matters when a spread precedes or follows a written one. Handler calls
    (`on:..`) still combine in one `data-on` attribute, including repeated events.

    Not chosen: a complete HTML validator or table insertion-mode simulation. A `<div>` straight
    in a `<table>` still compiles (foster parenting), as does a `<table>` in a `<p>`, whose
    closure depends on quirks mode, not just literal
    ancestors. The key check's table limit is in [Choice 46](#choice-ref-values).
    A separate `WholePatch` bound would make `cargo check` report the loss but would require apps
    generic over `Patch` to change their bounds. An associated constant directly on the sealed
    supertrait would make existing `dyn Patch` uses stop compiling.
    Refusing where the markup does not show the context, which would refuse a
    component's SVG fragment, valid wherever its parent writes it in an `<svg>`. Following the
    context across components, which the macro does not see: each component's render would
    report its namespace to the next, at a cost to every render for markup few apps write. A
    check in the browser (`dev.js`): it would find the mistake only on a page someone loads, and
    a compile error finds it in every build ([Rule 8](#rule-compile-errors)). Taking an
    expression or a component to leave the open elements and the parsing context as they were,
    which would keep the refusals across them: `raw` makes no such promise, and browsers keep the
    shapes it can make (a `<button>` written in a `<p>` before a literal `<div>`), so that would
    refuse kept markup. Leaving it: the
    markup is what a reader of the view sees, and it is not what the user gets.

    Stands on: platform (the HTML standard's tree construction: the elements whose content a
    browser parsing HTML reads as text, RCDATA `<textarea>` and `<title>`, RAWTEXT `<style>`,
    `<xmp>`, `<iframe>`, `<noembed>` and `<noframes>`, and script data, `<script>`; `<plaintext>`;
    the HTML integration points in SVG, the MathML text integration points, the two start tags
    (`<mglyph>`, `<malignmark>`) they keep MathML's, and `<annotation-xml>`'s two HTML encodings;
    the tokenizer's rule that of an attribute written twice on one tag the first is kept and the
    rest are dropped;
    and the start tags its rules for parsing tokens in foreign content take out
    of an `<svg>` or a `<math>`, which `TEXT_ONLY`, `RAW_TEXT`, `SVG_HTML_POINTS`,
    `MATH_HTML_POINTS` and `BREAKOUT` in `crates/corten-macros/src/html.rs` copy; the "in
    template" insertion mode's head tags and table start tags, and what the table insertion
    modes do with the tags after them, which `TEMPLATE_HEAD` and `TABLE_PARTS` copy, held equal to
    the debug check's `HEAD_TAGS` and `TABLE_PARTS` in `crates/corten/src/html.rs` by a test there,
    which also holds both copies of `DECIDING_HEAD` equal; the macro and browser-vector tests
    use the same literal whole-patch cases and compare the macro's actual verdict with the
    recorded parses of its output;
    the tokenizer's script data, RAWTEXT and data states, in which an appropriate end tag ends a
    `<script>` or `<style>` whatever the markup around it says, `<!--` and `<script` carry a
    script past one, and in foreign content `<` may start a tag and `&` a character reference;
    the parser escapes both where the context is known to be foreign, and `writes_tags` treats
    a remaining raw `<` in their text as unseen output;
    the tree construction dispatcher, which reads an `<svg>`'s or a `<math>`'s `<form>` as foreign
    content's whatever HTML element is around the drawing, so the third shape is not read into one;
    the browsers
    Playwright runs, which read an element in those holders as text and keep one in an `<svg>`'s
    own `<title>`, and keep the first of a duplicated `encoding`, and keep each kind's inner
    element in its outer one across a boundary written where `html!` does not see it, and the
    anchors of a `<math>` in an `<svg>` and of an `<svg>` in a `<math>`); reasoned (an `html!`
    sees its own markup and nothing around it, so what its top and a component's children land
    in is not known, nor what a component or an expression writes, since `raw` prints trusted
    text as is with no promise that it is balanced, nor what a `<script>` or `<style>` with a
    raw `<` writes, nor which component a path names (`<Corten />` may be an
    app's); what any of those writes may leave the tokenizer in a script's, a comment's or a
    `<plaintext>`'s text, which no later literal start tag leaves; an element HTML reads as text
    holds text as HTML's and elements as SVG's or MathML's, so where the namespace is not shown
    neither is what it holds, and a `<noscript>`'s depends on scripting; a component is drawn
    where a browser reads tags, since script text is a string's, not markup's; `html!` writes an element's attributes in the order they are written, spreads in their
    place (`open_tag` in `crates/corten-macros/src/html.rs`), so the first `encoding` in the
    markup is the first the browser reads; the refusals add no code to what `html!`
    writes, apart from encoding literal bytes in the proven foreign context); value (correct
    output above the rest, the README's conflict order 1: refuse literals whose encoding cannot
    be chosen correctly across their possible contexts, not an element merely because its
    context is unknown; a mistake the compiler can see is a compile error, its 3 and Values 4).

    Revisit when: the HTML standard changes the elements it reads as text, its integration points
    or the start tags it takes out of foreign content, when the lists in `html.rs` follow it; or the
    runtime parses a patch some other way than as a `<template>`'s content, when the patch
    refusals go or change with it; or a browser keeps one of the refused patch shapes as written
    after some first element or in some place a view is written, when `patch-parsing.json`'s cases
    fail in the smoke (or the probe in Last checked, run again, finds it kept) and that refusal
    goes (a whole-patch refusal goes only when every supported engine keeps the shape, since it
    exists for the engines that lose it: Firefox keeps a row after a leading `<base>`, Chromium and
    WebKit drop it); or an app is found to write one of the refused shapes across a component's edge or an
    expression (a component whose top-level element lands in an `<svg>` and writes an element
    there a browser moves out, children a component writes into a `<textarea>`, a block in a `<p>`
    after a text expression, a row after a `<table>` whose rows an expression writes), when
    following the context across components ([Limit 30](#limit-markup-context)) would have to be
    weighed against its cost to every render; or `raw` is made to promise balanced markup, when an
    expression could be taken to leave the open elements as they were and the tokenizer reading
    tags; or `html!` stops writing HTML script or style text that can end its holder early or
    keep it open, when that text would stop being unseen output too; or an app needs components drawn inside
    script text (a client-side template filled from a component's markup), when the precondition
    that output is drawn where a browser reads tags goes too, and with it every refusal outside a
    patch's top level but the two of a single start tag; or Rust can check the marked shape before
    code generation without new public bounds, when `cargo check` should report it too.

    Last checked: 2026-11-19, for the whole-patch send boundary: on Rust 1.89.0 and stable 1.99.1,
    a cross-crate probe with a lazy constant passed `cargo check` and reported the lost `<tr>`
    at its macro invocation under `cargo build`. A generic `Patch` caller and reference, optional,
    vector and `dyn Patch` inputs still built. `patch-parsing.json` records loss for a paragraph
    before a table part and no loss for a paragraph between two rows. 2026-11-18, the HTML
    tokenizer's data state and foreign-content rules.
    Chromium 159.0.8154.6, Firefox 159.0 and WebKit 27.2 all decoded the reference and opened
    a child element in unescaped `<script>` and `<style>` literals in SVG and MathML, and
    kept the escaped versions as literal text without a child element (`parsesAsHtmlMeans`).
    On the same engines, this smoke also verified that a foreign `<font>` with no `color`
    leaves two styles in SVG but with `color` moves both to HTML, and that closing SVG between
    iterations changes a following style to HTML. The same smoke verifies that an ordinary
    comparison stays text, does not affect a following stylesheet, and does not make a nested
    tag into an element;
    2026-11-17, after a sixth review found refusals of kept markup in an element
    HTML reads as text whose namespace the markup does not show, and a duplicate check that took
    `key` (written `data-key`) and `KEY` for one attribute, the outputs of the new passing cases
    (`<p><div>"Detail"</div></p>` in a top-level `<iframe>`, `<noscript>`, `<xmp>`, `<noembed>`,
    `<noframes>`, `<style>` and `<script>`, and in a `<noscript>` in a `<div>`) serialized back
    unchanged, and the same in a top-level `<textarea>` and `<title>` and in a `<textarea>` in an
    `<svg>`'s `<foreignObject>` read back as text, in Chromium 156.0.8078.4, Firefox 157.0 and
    WebKit 27.2, which also kept `data-key` and `KEY` as two attributes and the review's
    counterexample (`<p><div>` in script text a caller left open) as the script's text, the shape
    the precondition above leaves unsupported, and each new passing case was added to
    `parsesAsHtmlMeans`;
    2026-11-17, after a fifth review found refusals of kept markup after a script
    left open (a later literal `<svg>`, `<p>` or `<textarea>` regained certainty) and asked that
    every component, `<Corten />` included, be unseen, the outputs of the new passing cases (a
    `<div>` in an `<svg>`, a `<div>` in a `<p>`, and a `<g>` in a `<textarea>`, each after a
    script whose text holds `<!--<script>` and before `raw("</script>")`; the same after a script
    `raw` opens, in a `<template>` too; and after one a component writes, in a `<foreignObject>`
    too and as its children, and what a component named `Corten` writing `</span><button><span>`
    makes of a `<div>` in a `<p>`) serialized back unchanged in Chromium 156.0.8078.4, Firefox
    157.0 and WebKit 27.2, which still drop a nested form in a document's `<main>` (the miss),
    and were added to `parsesAsHtmlMeans`; 2026-11-17, after a fourth review found refusals of kept markup across a
    `<script>` whose text `html!` writes as is and across an app component named `Corten`, the
    outputs of the new passing cases (a `<div>` in a `<p>` after `</script><button><script>` in a
    script and after the same in a style, a nested form in a template a script's text opens in a
    document's `<main>`, a `<g>` in a `<textarea>` in an `<svg>` a script's text opens, and what
    a same-named `Corten` writing `raw("<button>")` makes of a `<div>` in a `<p>`) serialized
    back unchanged in Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2, and the first four
    added to `parsesAsHtmlMeans`; 2026-11-17, the patch shapes read again against the same rule when
    [#1538 Refuse the patch shapes a browser loses wherever they are written, and check the rest in debug builds](https://github.com/corten-run/corten/pull/1538)
    and this change met, and the shapes
    with `raw` between their two elements (a row after `raw("<table>")`, a row in a `<table>`
    holding `raw("<template>")`, a `<p>` after a `<col>` and `raw("<template>")`, a `<table>` after
    a first row and `raw("<template>")`, at the top level and in a `<div>`) parsed as a
    `<template>`'s content in Chromium 156, Firefox 157 and WebKit 27.2, each of which kept every
    one; 2026-11-17, each refusal's facts read again against `html/nesting.rs` and
    the parser after a third review found refusals of kept markup across a component, an
    expression and a foreign root's unseen namespace, and the kept shapes
    (`parsesAsHtmlMeans` in `scripts/smoke/patch-parsing.mjs`: one per nesting kind across a boundary written
    by `raw`, a form pair in a template written by `raw` in a document's `<main>`, anchors across
    a `<foreignObject>` and a `<template>` written by `raw`, and the anchors of a `<math>` in an
    `<svg>` and of an `<svg>` in a `<math>`) parsed in Chromium 156, Firefox 157 and WebKit 27.2,
    each of which kept every one as written; 2026-11-16, the HTML standard's "in body" start-tag rules, scope boundaries,
    special elements and active-formatting markers, read against `html/nesting.rs` in this
    change based on `f5f2132aa`, and each of its refusal rules, for every tag the rule names
    (`refusedNesting` in `scripts/smoke/patch-parsing.mjs`), parsed in Chromium 156, Firefox 157 and
    WebKit 27.2, each of which moved or dropped the inner element, while keeping the template
    and foreign-content cases, and again after review that the form pointer is the only rule that
    depends on ancestors outside the markup (template contents do not use it); 2026-11-15, the
    HTML standard's tree construction (its tokenization states for
    RCDATA, RAWTEXT, script data and PLAINTEXT, its HTML and MathML text integration points, its
    tree construction dispatcher, which keeps `<mglyph>` and `<malignmark>` MathML's at a text
    integration point and reads an `<svg>` in a MathML `<annotation-xml>` as SVG's, and its rules for parsing tokens in foreign content, which take the same
    start tags out of a `<math>` as out of an `<svg>`), read that day, against the lists in
    `crates/corten-macros/src/html.rs` on `6575d4d8c` and again on this round's change, as its
    tests and the examples of `html!` hold the parse and the refusals to. The MathML and
    SVG-breakout claims rest on that dated read of the standard, and on what the engines below do
    with it: `scripts/smoke/patch-parsing.mjs` (`parsesAsHtmlMeans`, in every engine the watchlist smoke runs)
    loads, written by hand as `html!` writes them (it is not rendered by `html!`), the shapes
    `html!`'s examples hold: a `<title>` in an `<mi>`'s `<mglyph>` and `<malignmark>`, a `<div>`
    in an `<mtext>`, an `<svg>` straight in a `<math>` (MathML's), an `<annotation-xml>` with an
    HTML `encoding`, with `TEXT/HTML` first and another after it, with a MathML one (a MathML
    `<title>` and an `<svg>` whose `<foreignObject>` holds HTML) and with none (an `<svg>` in it
    SVG's), and an `<svg>`'s `<title>`, `<style>` and `<textarea>`, and the refused shapes beside
    them (an element in a `<title>` in an `<mi>` and in an HTML `<annotation-xml>`, a `<div>` in
    an `<mrow>` and in an `<annotation-xml>` with no `encoding`, with a MathML one and with a
    non-HTML one before `text/html`, a `<p>` in an `<svg>`), and checks the parsed elements, and
    passed in Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2 (Playwright 1.64.1). Its two
    duplicated-`encoding` shapes (`TEXT/HTML` then `x`, which holds HTML, and `x` then
    `text/html`, whose `<div>` lands outside the `<math>`) are the evidence for the tokenizer's
    first-kept rule, and `open_tag`'s written order was read on `a10334375`; 2026-11-14, a one-off probe, not a repository check: a
    page written by hand (not by `html!`, which refuses most of it) loaded in Chromium
    156.0.8078.4, Firefox 157.0 and WebKit 27.2 (Playwright 1.64.1), reading
    `querySelectorAll` for an element written in a `<textarea>`, an HTML `<title>` (in `<head>`,
    in the body and in an `<svg>`'s `<desc>`), an `<iframe>`, an `<xmp>`, a `<noembed>` and a
    `<noframes>`, which found none, and in an `<svg>`'s own `<title>`, which found it. To repeat
    it, load such a page in the three engines and count the matches; 2026-11-16, for a patch's top
    level, the "in template", "in table", "in table body", "in row" and "in column group"
    insertion modes read again that day against `TEMPLATE_HEAD`, `TABLE_PARTS` and `patch_top`
    in `crates/corten-macros/src/html.rs`, and `scripts/smoke.mjs` loading the 740 shapes in
    `crates/corten/src/patch-parsing.json` (among them every refused shape and each kind of the
    third, written first and after each of the nine table parts, and a row holding an `<svg>`
    with a `<title>`) as a `<template>`'s content on `b89eead89`, which passed
    in Chromium 156.0.8078.80, Firefox 157.0 and WebKit 27.2 (Playwright 1.64.1), with Chromium
    and WebKit letting a leading `<title>`, `<base>`, `<basefont>`, `<bgsound>` or
    `<noframes>` decide; 2026-11-16, the same check of the 767 shapes there on `8b124f980`, among
    them an `<svg>`'s and a `<math>`'s `<form>` in a `<div>` after four first table parts, kept
    as written in all three; 2026-11-16, the same check of the 782 shapes there on `72ea009ac`,
    among them an `<xmp>`'s, `<iframe>`'s, `<noembed>`'s and `<noframes>`'s markup kept as text
    after a `<tr>`, and the shapes the debug check stops at (a `</p>` or `</br>` in an `<svg>` or
    `<math>`, Firefox taking one in a `<foreignObject>` or `<mi>` out of it, and a script whose
    text carries it past its first `</script>` over a `<p>`); 2026-11-16, the same check of the 790
    shapes there on `b02b1c706`, among them an end tag written `</div ignored>` and a `<tr/>`, which
    the browsers read otherwise than as written and the debug check stops at, and a `<form>` whose
    `</input>` before its control the browsers ignore; 2026-11-16, the same check of the 795 shapes
    there on `2ae79c0a5`, among them a `<col>` the patch ends in before its `>`, an `<image>` read
    as an `<img>` and a `<div>` in a `<p>`, and of the 3,000 patches of
    `scripts/patch-generated.json` (seed 1409), where the debug check reported a loss only in an
    engine that loses something and, where one did, reported it or stopped; 2026-11-16, the same
    check of the 802 shapes there on `81d83650e`, among them a doctype a quoted `>` ends early, a
    `<form>` holding only `&#32;` after a `<tr>`, kept, names past ASCII, and a `<template>`'s
    `<form>` holding a `<label>` after a `<td>`, moved out of it in every engine, and of the 3,000
    patches of `scripts/patch-generated.json` (seed 1409, now with characters past ASCII, character
    references, NUL and doctypes, compared with their text and the id check's verdict), with the
    same result and the id check reporting only what an engine's parse shows at its top level;
    2026-11-16, the same check of the 819 shapes there on `80e9fa8f8`, among them a `<form>`
    holding a start tag the patch ends in after a `<tr>`, kept empty, an `<annotation-xml>` whose
    `encoding` is `text&#x2F;html`, an HTML integration point, an `<a>` in an `<a>` across a
    `<foreignObject>`, which closes the outer one, and a `<template>` in an `<mi>` after a
    `<tbody>`, past which Firefox alone reads the rest as a body's, and of the 3,000 patches of
    `scripts/patch-generated.json` (now with forms holding a tag the patch ends in), with the same
    result; 2026-11-17, the same check of the 824 shapes there on `7f9cb8ad8`, among them a loss
    found before a start tag the patch ends in, kept, and a `<select>` in a `<foreignObject>` or
    `<mi>` after a `<tr>`, past which every engine, Firefox 157 included, keeps a later row, and of
    the 3,000 generated patches, with the same result; 2026-11-16, a one-off probe, not a repository check, in Chromium
    156.0.8078.80, Firefox 157.0 and WebKit 27.2 (Playwright 1.64.1): each kind of the third shape (a `<table>` at the top level, in a `<div>` and in a
    `<label>`'s `<span>`; a `<form>` holding a `<div>` or a `<p>`, one in a `<div>`, and one
    holding a `<label>`'s `<span>`), after each of the eight first table parts but `<col>`, parsed
    as a `<template>`'s content after a `<p>` and after a leading `<title>`, and in a page's
    body, `<table>`, `<tbody>`, `<tr>`, `<td>`, `<caption>`, `<colgroup>`, `<svg>`, `<math>` and
    `<select>` (`DOMParser`), was kept as written in none of them, while a `<form>` of fields
    alone, or in a `<label>`, was kept in an `<svg>` and a `<math>`, and a `<table>` in a
    `<label>`'s `<foreignObject>` in an `<svg>`. To repeat it, parse those shapes there and
    compare the elements with the markup.

55. <a id="choice-screen-read"></a>**A script reads a screen's data with `read()`, from a module of its own, typed by its route; not
    from a data block in the page.** A rich screen in the browser needs data the page did not draw:
    another set's products when the user picks it, the package for another shipping service
    ([#1399 A script cannot read its page's typed data: req.screen answers data clients JSON, but a script's only typed input is a handler argument written into the page](https://github.com/corten-run/corten/issues/1399)).
    A script's only typed input was a handler argument written into the page
    ([Rule 3](#rule-handler-arguments)), so such a screen drew every choice's data into the page or
    fetched JSON by hand under a type written beside the server's. The route already answers that
    data: `req.screen` gives a data client `{"title","data"}`, tagged and revalidated as any page
    is. So a route says `data = T`, and its `get` handler must return `HtmlResult<Screen<T>>`,
    which only `req.screen` given a `T` makes, checked at the handler's name in `#[route(..)]`
    (the methods that answer a patch, `patch_or`'s other side included, answer only as
    `AnyAnswer` or `Patches`, so none of them reaches `Screen<T>`); the same route mounted
    again by hand (`Area::route`, `Api::route`) takes only a `get` that answers a screen of
    `T`, also checked when the crate compiles: the route's `Route::Data` is `HasData<T>`
    (`NoData` for a route without data), and the handlers' kind must match it (`DataMatches`):
    every kind matches `NoData`, and only `Screen<T>` matches `HasData<T>`. A `Route` written
    by hand names its `Data` too, since a trait's associated type has no default on stable Rust,
    a break for such an impl (none in the examples or the template), and code generic over a route
    that mounts handlers at it bounds it `R: Route<Data = NoData>` (CHANGELOG, **Breaking:**); the route is then a handler
    argument of type `ScreenUrl<T>`, where `T` must come from the declarations `corten::types`
    writes (a type the script declares would match the Rust type by name alone; what is checked is
    the path the name is imported from, `types/app`, so a file written by hand at that path is not
    detected), and `read(url, { signal })`
    from `corten/read` asks it with `Accept: application/json` and resolves to `data`, typed as
    `T` by that declaration. The read is a `fetch` in the default cache mode, so the
    browser's HTTP cache does for it what it does for any `GET`: an answer it kept is asked about
    with its weak `ETag` and an unchanged one is a 304 with no body (while nothing else fetched
    that URL in between: the browser keeps one answer per URL, so the page fetched there again,
    by a navigation or by the runtime's hover prefetch of a link to it
    ([Choice 12](#choice-own-prefetch)), replaces the data's and the next read gets the whole
    answer; a link whose click reads sits under `data-no-prefetch`, which also spares the server
    drawing a page the click does not use), and a `Public` route's
    `max-age` lets a read within it make no request; `Vary: corten, accept` keeps the page's HTML
    from answering it. A redirect is not followed (`redirect: "manual"`): what answers before the
    handler or replaces its answer (an app's middleware sending a visitor to sign in) is not
    checked against the route's data, and its target is another route's. Corten's own sign-in
    refusal (a `Caller`, `Refused::sign_in`) answers a data client 401, not a redirect, so a
    redirect is one the app writes. A failure is a `ReadError` whose `status` is the answer's
    (that 401 included), or 0 when there was none it could use: with `redirected` true for a
    redirect (`fetch`'s opaque redirect, which tells a redirect from no answer but not where it
    goes, [Limits](#limit-read-redirect)), else with the error as `cause` (offline, or a success
    that is not a screen's JSON), as `corten:error` gives a submit the network fails; an abort
    rejects with `signal`'s reason, as `fetch` does, even when a failed answer came first. No new endpoint, header or format: the URL, the
    negotiation and the envelope are the ones native screens already read.

    What it costs: nothing for an app whose scripts do not import it. `corten/read` is a module
    of its own, as `corten/keys` is, in the import map and preloaded only for apps whose listed
    scripts import it, so the runtime is the same bytes (43,395, 15,341 with gzip, 13,846 with
    brotli, on `dea1788d2` and on `4eb3d62d1`) and so is every other app's import map. In an app
    that imports it, each page's import map names it
    (`,"corten/read":"/assets/<version>/scripts/corten-read.js"`, 60 bytes, 4 to 9 once the page
    is compressed), and the pages whose scripts import it preload it (a 77-byte
    `<link rel="modulepreload">`). The module is 749 bytes, 486 with gzip and 409 with brotli,
    which the users of an app that reads download once a release. The server's work is
    unchanged: a `req.screen` page costs 37,950 instructions a request as HTML and 41,211 as a
    data client's JSON on `dea1788d2` and on `4eb3d62d1`, within 0.2 of each other in every run
    (the answer's kind is a type only). A read costs a request where a handler argument costs
    none, so data a page needs when it loads stays a handler argument; a read is for data a
    choice picks or the page may never need.

    Not chosen: the `<script type="application/json">` block
    [Choice 45](#choice-data-on-single-quoted) left open. It makes the pages that hand a script
    large data at load a little faster, but it puts the data in the page whether the script needs
    it or not, so it does nothing for a screen whose data a choice picks (each choice's data would
    be drawn into the page), and its reader is in the runtime every user downloads, where a read
    costs only the apps that call it. It stays open on [Choice 45](#choice-data-on-single-quoted)'s terms, for large data a page
    needs when it loads. Also not chosen: a script that fetches the JSON itself under a type it
    writes (a type at the seam written by hand, which README Value 4 rules out); an `App::api`
    route beside each screen (a second route and handler for data the screen already answers);
    `read` in the runtime itself (every user would download it to help the pages that read); a
    second method that answers a screen, `req.screen_of(..)` beside `req.screen`, which would have
    left `req.screen`'s type parameters as they were but given an app two ways to answer one
    screen (README Value 5). `req.screen` took a type parameter for the answer's kind instead, a
    break Corten takes before 1.0: a call that names its types with a turbofish names three, and
    a `req.screen(..)` in a closure that names no answer names its kind (CHANGELOG, **Breaking:**).

    Stands on: measured (the minified runtime's and `corten/read`'s sizes by Node's `zlib`, gzip
    at level 6 and brotli at quality 11, on `dea1788d2` and `4eb3d62d1`, once each, and the
    module's again on `c74c4fa83`, once it cancels a refused answer's body, gives a malformed
    success a `cause` and lets an abort win over a failed answer, 666, 438 and 367, and on
    `7664551c8`, once it tells a redirect apart (`redirected`), 749, 486 and 409; a
    `req.screen` page's instructions a request under callgrind, 1,200 requests through the
    router in process less 200, over 1,000, in both modes, three alternated runs of each build,
    release, in `rust:1-bookworm`: HTML 37,949.68 to 37,949.73 on `dea1788d2` and 37,949.64 to
    37,949.75 on `4eb3d62d1`, JSON 41,211.21 to 41,211.38 and 41,211.29 to 41,211.40;
    the import-map entry on three of the watchlist's pages, `/`, `/smoke/reading` and `/news`,
    the page's size by `zlib` with and without it: 60 bytes raw, 9, 7 and 8 with gzip, 4, 5 and
    8 with brotli); platform (`fetch` in the default cache mode keeps a 200 the server tags and
    revalidates it with `If-None-Match`, a 304 answering it from the kept copy: the smoke's read
    checks, where in Chromium the second read names the first answer's tag and in Firefox it is
    answered 304, and the server answers that tag with a 304 and no body; Playwright's WebKit asks
    again without the tag and is sent the whole answer, as it does the runtime's navigation fetch;
    `redirect: "manual"` answers a redirect as an opaque answer without following it, a
    `ReadError` 0 with `redirected` in all three; Corten's sign-in refusal answers a data client
    401, which `a_handlers_refusal_signs_in_and_answers_a_data_client_as_an_extractors` tests);
    reasoned (a hover prefetch is a `fetch` of the link's URL, which takes the URL's one entry in
    the browser's cache as a navigation does, so a read after it is answered whole: why a link
    whose click reads sits under `data-no-prefetch`; `read.js`'s own logic, which the smoke checks in the three engines with a stand-in
    `fetch`, so not a browser probe: a 404 that arrives as the signal aborts rejects with the
    abort, a success that is not JSON with a `SyntaxError` cause and JSON that is not the
    envelope with a `TypeError` one; an app whose scripts do not import `corten/read` gets the same runtime and import
    map, so its pages pay nothing; `data`'s type comes from the route's `data = T` and the
    declaration of `T`, so no script writes it, and a route whose handler can answer without a
    `T` does not compile, through `req.page`, a redirect or a patch-making method, which the
    `compile_fail` doctests on `Req::screen` and `PatchingKind` show, and mounted again by hand
    with such a handler it does not compile either, which the `compile_fail` doctests on
    `Area::route` and `a_data_route_mounted_by_hand_with_a_page_handler_says_why` show; what
    middleware answers or a handler replaces through `DerefMut` is not checked, which is why a
    read follows no redirect; a script that meets one navigates to the URL, which the browser
    follows, where offline it would wait or say so, which is why a redirect is told apart); value (a rich screen in the browser is as possible as one the
    server draws, and only the apps that read pay for it, README Value 1;
    types at the seam come from Rust, Value 4; one way to a screen's data, the route that answers
    it, with no second endpoint, Values 5 and 6).

    Revisit when: `corten/read` grows past 1 KB with gzip; most apps' scripts import it, when a
    reader in the runtime may cost less than the module's own request; a page needs a screen's
    data when it loads in amounts where [Choice 45](#choice-data-on-single-quoted)'s block would
    pay (its Revisit when); Chromium or Firefox stops revalidating a read it kept, which the 304
    rests on; a `Req` method other than `req.screen` comes to answer as `Screen<T>`; or a
    `req.screen` page's instructions a request move by more than 1%; or stable Rust gives a trait's
    associated type a default, when a `Route` written by hand need not name its `Data`.

    Last checked: 2026-11-15, the runtime's size, the instruction counts and the import-map entry
    on `dea1788d2` and `4eb3d62d1`; 2026-11-15, the module's size and the smoke's read checks on
    `c74c4fa83`; 2026-11-15, the module's size and the smoke's read checks again on
    `7664551c8`, the read checks in Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2
    (Playwright 1.64.1); 2026-11-16, the hand mount's check when the crate compiles
    (`Route::Data` and `DataMatches`, its `compile_fail` doctests and message test) on
    `f109794c6`.

56. <a id="choice-network-only-preload"></a>**The generated service worker answers a navigation
    under a `network_only` prefix with the request navigation preload already sent, rather than
    declining it.** The worker turns navigation preload on, so a page's request leaves while the
    worker starts, and it declined every request under a `network_only` prefix (sign-in, checkout,
    an OAuth callback, an agents' endpoint), so that nothing there was cached or given the offline
    page. For a navigation the two did not fit: the browser sends the preload as the fetch event
    starts, and when the worker does not call `respondWith` it drops the preload's answer and sends
    the request again, so every network-only page was rendered twice and a one-time `GET` (an OAuth
    `?code=`, a magic link) was redeemed twice, the user seeing the second answer
    ([#1524 corten::pwa enables navigation preload but declines network-only navigations, so every navigation to a network_only path reaches the server twice](https://github.com/corten-run/corten/issues/1524)).
    Such a navigation is now answered with `(await event.preloadResponse) || fetch(request)`: the
    preload's answer when one was sent, one fetch when none was. Where the browser has navigation
    preload but sent none for this navigation (the worker that turns it on was not yet active when
    the navigation began, or the app's script turned it off), `preloadResponse` resolves to
    `undefined` and `fetch(request)` sends the request once, with the navigation's own mode and
    redirect mode, as a declined navigation would have. No cache is read or written and no offline
    page is given, so offline it fails as a declined one did, with the browser's error, and a
    failed preload is not sent again as a fetch, since it may have reached the server. A redirect
    (the callback's 302 or 303 to a page) keeps its meaning: a
    navigation's redirect mode is `manual`, so the answer is an opaque redirect the browser follows
    itself, and the page it lands on is a navigation of its own, through the worker as any page.
    Still declined: a network-only navigation in a browser without navigation preload
    (`registration.navigationPreload` absent), where declining sends it once; a posted form, for
    which no preload is sent; and every request there that is not a navigation. An app's
    `import_script` listener that already answers such a navigation keeps its answer, and the
    worker's own `respondWith` then throws an `InvalidStateError` into the worker's console. It
    costs every client 185 bytes more of worker (2,857 to 3,042 uncompressed as card-market's
    default image serves it, 1,153 to 1,183 with gzip at level 9), and a request no more on the
    server.

    Not chosen: navigation preload off, so declining would be right (every navigation would wait
    for the worker to start before its request leaves, to spare a case the worker can answer);
    declining when no preload was sent (the worker must call `respondWith` before
    `preloadResponse` settles, so it cannot tell); leaving it to the app's own `import_script`
    listener (every app with a sign-in would rewrite the framework's worker); routing the prefixes
    past the worker with the static routing API (`InstallEvent.addRoutes`, `source: "network"`),
    which would start no worker and send no preload for them, but which only Chromium of the three
    tested engines has.

    Stands on: platform (the Service Workers standard's Handle Fetch: for a `GET` navigation with
    navigation preload enabled the preload request is sent in parallel with the fetch event, and
    when no handler calls `respondWith` the event's result is null and the navigation is fetched
    again; a navigation's redirect mode is `manual`, so `respondWith` takes an opaque redirect for
    it; and the engines: Chromium, Firefox and WebKit each run the generated worker with
    navigation preload on, and of them only Chromium has `InstallEvent.addRoutes`; Chromium and
    WebKit send a navigation's preload before the worker decides, and Firefox sends none for a
    navigation the worker declines); measured
    (card-market's browser smoke, which counts on the server the requests one navigation sends
    under the worker, run once with each worker, and a count of ten navigations of each kind in
    each engine with each worker, the requests counted by the app (`src/smoke.rs`): with the
    worker that declined, a navigation to `/mcp` reached the server twice in Chromium (10 of 10)
    and in WebKit (9 of 10, three times on the first), a one-time link twice in both (10 of 10),
    and each once in Firefox; with this worker each reached it once in all three, 10 of 10; a
    posted form and a page outside the prefixes reached it once in all three with either worker;
    and a probe of each engine with each worker, logging on the server each request's
    `Service-Worker-Navigation-Preload` header: with the worker that declined, Chromium and WebKit
    sent a network-only navigation twice, the first with the header, and Firefox once, without it,
    while the same worker's answered page had it in all three, so Firefox sends no preload for a
    navigation the worker declines rather than reusing one; with this worker each sent it once,
    with the header. In the same probe a link to another site that redirects (302) into the
    network-only prefix, as an OAuth provider sends the user back, reached the callback once in
    all three with this worker (twice in Chromium and WebKit with the one that declined), with the
    app's `SameSite=Lax` cookie, and landed on the page the callback redirected to; a
    `SameSite=Strict` cookie reached the callback with this worker exactly where it did with the
    one that declined, so no engine sends it where it did not before: in Chromium when the link
    was on one of the app's pages and not when it was on the other site's, in WebKit in both, and
    in Firefox in neither; Firefox's preload of it said `Sec-Fetch-Site: same-origin` where its
    declined navigation had said `cross-site`, as Chromium's and WebKit's still did; Corten reads
    that header only for writes, which no preload is; and one fetch of `/service-worker.js` from
    card-market's default image with `0c916b5a0`'s worker, against the same text with
    `226b12b35`'s template in place of its own, the lines generated before the template being the
    same, for the sizes);
    reasoned (where the preload has gone out, answering with it is the only answer that sends the
    request once); value (correctness first: a navigation reaches the server once; then
    performance: a network-only page is rendered once, from the request already in flight).

    Revisit when: Firefox and WebKit ship `InstallEvent.addRoutes`, so the prefixes can be routed
    past the worker in every tested engine; Chromium and WebKit reuse a declined navigation's
    preload, or stop sending one for it as Firefox does, so declining would send it once; Corten,
    or an app's own middleware (a Fetch-Metadata policy), reads `Sec-Fetch-Site` on a `GET`
    navigation, which Firefox's preload of a cross-site one calls `same-origin`; an engine sends a
    `SameSite=Strict` cookie on the preload of a navigation whose own request would not carry it;
    or an app needs a network-only navigation the worker does not see at all.

    Last checked: 2026-11-16, the Service Workers Editor's Draft of 29 October 2026, built from
    `w3c/ServiceWorker@57dfd24` (Handle Fetch, Create Fetch Event and Dispatch), read that day;
    2026-11-16, card-market's smoke and the count
    in Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2 (Playwright 1.64.1) on Windows,
    against a build of `f61cf6cfe` and one of it with `412a3b4c9`'s worker; 2026-11-16, a one-off
    probe, not a repository check, in Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2
    (Playwright 1.64.1): a worker reporting whether its global has `InstallEvent.addRoutes`
    (Chromium only) and navigation preload (all three). To repeat it, register a worker that
    reads `"addRoutes" in InstallEvent.prototype` and `self.registration.navigationPreload`;
    2026-11-16, card-market's smoke in the same three engines against a build of `0c916b5a0`, and
    a second one-off probe in them: the worker of `0c916b5a0` and the declining one of `226b12b35`
    (origin/main), each filled with the network-only prefix `/auth/` and served by a server that
    logs each request's `Service-Worker-Navigation-Preload`, `Cookie` and `Sec-Fetch-Site`, with a
    link to a server on another host that redirects (302) into `/auth/`. To repeat it, navigate
    under each worker to a page, to a page under the prefix and through that link, and count the
    requests the server logs; 2026-11-16, that probe again with the workers of `0c916b5a0` and
    `226b12b35` in Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2 (Playwright 1.64.1), with
    a `SameSite=Strict` cookie beside the `Lax` one and the link also on a page of the other host,
    logging which cookies each request to `/auth/` carried; 2026-11-16, the worker's sizes,
    one fetch of `/service-worker.js` from card-market's default image built with `0c916b5a0`'s
    worker, and the same text with `226b12b35`'s template in place of its own.

57. <a id="choice-field-arguments"></a>**A handler is given a form's control by its `#[derive(Fields)]` field, which
    the runtime finds by name in the handler's form when the handler runs.** A component that
    draws a form's fields for forms with a script and without one (a package's fields in two
    editors) has no refs to give the script, since refs do not reach outside a component, so a
    script reached a control by `form.elements.namedItem("weight")`: a field name as text the
    compiler did not check, of a type the script had to narrow
    ([#1408 A script cannot be handed a form field as a typed element: it looks the control up by a name string the compiler does not check](https://github.com/corten-run/corten/issues/1408)).
    Now the markup passes the field, `on:change={js::fill(f.service, f.weight, f.size)}`, and
    the handler's parameter is the control: `HTMLInputElement`, `HTMLSelectElement`,
    `HTMLTextAreaElement`, or `HTMLInputElement[]` for radios or checkboxes that share the name.
    A field passes only where the handler takes one of those, and text or another element does not
    pass where it takes one; each is a `compile_fail` doctest on `FieldName`. The
    call writes `~` with the kind (`i`, `s`, `t`, `*`) and the posted name as a JSON string
    (`~i"parcels[1].weight"`), in `data-on`, a format only Corten's server and runtime read, so it
    needs no standard ([Rule 10](#rule-standard-formats)). When the handler runs, the field
    module (`corten-field`, `js/field.js`), which a page loads only when its handlers take a field,
    as a format argument loads `corten-format`, takes the form of the element with the `on:` (the form itself; for a control, the one it belongs
    to, `form=` included, a form-associated custom element's too; else the one around it, so a `<label>` takes the form it is in, not its
    control's, which `form=` may put elsewhere), reads that form's own `elements` by the browser's
    index of its names (`namedItem`, so a control named `elements` or `namedItem` cannot stand in
    for either), keeps the controls whose `name` is the field's (the index also holds ids), and
    gives the one control of the name with the kind's tag, or every input of it for a group (`[]`
    for none); a control a patch replaced is the new one, as a ref's is. Anything else runs nothing
    and throws what the call takes and what the form has instead, in the words `corten dev` uses. Whether the form draws the field as the kind the
    handler takes cannot be known when the crate compiles ([Limit 32](#limit-field-kind)), so
    `corten dev` reports such a call, with what the form has, when a page or a later draw puts it
    on the page. Behavior is still a function the markup calls, and the field is an argument as a
    ref is: no second way to attach behavior, and nothing to learn but the parameter's type.

    Not chosen: the field's name as text, `js::fill(f.weight.as_str())`, which is how a script
    was given one before (corten-ui's `RequiredWhen` passes its control so): the name is right, but
    the script still looks it up by a string and narrows what it finds, which is the issue. A
    `RadioNodeList`, as `namedItem` gives: it gives a list only for two or more controls of a name
    and the control itself for one, and a script cannot make one, so a handler could not count on
    its type. Requiring refs: the component that draws the fields would take refs from every form
    that uses it, with or without a script, and a ref does not cross a component's edge. Marking the
    kind on the field (`#[fields(select)]`) so the compiler checks it: a concept on `Fields` that
    still does not see the markup another component writes, so the runtime check would stay.
    Finding the control once, when the handler connects: a patch that replaces it would leave the
    handler with the old one. The lookup in the runtime every page loads, as this change first had
    it: 204 bytes with gzip on every page (15,341 to 15,545), for a call few pages make, where a
    module of its own costs every page 51 (66 with the check that keeps a handler's run from
    allocating, below) and only a page with a field 741 more and one
    request,
    which its first load makes with its handlers' modules, as a module script of the page. `RequiredWhen` keeps its name as text: its control may be a select,
    radios or a checkbox, and it reads only the value, which no one element type covers. A walk
    over every control of the form, as this change first had it: three fields took a run 600 to
    980 us in a form of 500 controls, and 3.4 to 5.5 ms in one of 2,000 (below), against the
    index's few. A load error that does not ask Corten's own modules whether their component is
    listed in `App::components`: 14 bytes with gzip on every page, for a console message after a
    server fails to serve one of them, so the hint stays as it is for every module.

    What it costs, in the conflict order. Correctness gives up nothing: the control is the one the
    form has when the handler runs, and a call whose form has another runs nothing rather than
    hand the handler the wrong element. Performance: every page's runtime is 225 bytes larger raw,
    66 with gzip (15,341 to 15,407) and 79 with brotli (13,846 to 13,925), paid once a release by
    every user, chiefly for the parser's `~` branch (about 20 with gzip), loading the field module
    for a call that takes one (14), and a handler's run that looks up a binding's other modules and
    makes no closure or array when it has none, as before (about 15). The lookup and its message
    are that module, 1,340 bytes raw, 741 with gzip and 640 with brotli as built (as the watchlist
    serves it, with the line Corten appends, 1,551 bytes, 838 with its gzip and 716 with its
    brotli, and an 82-byte script tag in the page), which only a page whose handlers take a field fetches, as one
    more module script of the page; a page the runtime swaps in imports it with the page's
    handler modules, and an event before it arrives gets the browser's default, as one before
    those does. A field argument writes its posted name where a
    ref writes its own: a handler given four controls (an input, a select, a textarea and two
    radios) writes `data-on` of 58 bytes with fields against 30 with refs, but the form with refs
    also writes a `data-ref` on each control and a `data-scope` on its component, so the whole
    form is 266 bytes with fields against 331 with refs. Rendering a field writes its posted name as a string argument does;
    the item page's `render_cost`, which draws no field (so never notes the field module), is unchanged: its bytes are the same
    (7,772 for `<main>`, 9,236 for the document), and five alternated runs of each build gave
    build and render of `<main>` in 19.2 us (18.0 to 21.7) on main and 20.4 us (18.0 to 22.8) on
    this change, each build's runs varying more than the two differ, as they did when this was
    first measured (19.2 us, 15.6 to 20.8, against 18.4 us, 16.0 to 21.0). The lookup reads the
    form's index of names: a handler given three fields (an input, a select and a textarea) spent
    4 to 10 us a run finding them in a form of 50, 500 or 2,000 controls, in Chromium, Firefox and
    WebKit alike, where a walk over every control spent 60 to 95 us at 50, 600 to 980 at 500 and
    3.4 to 5.5 ms at 2,000. Compile-time safety is
    what the change buys: the name was already right as text (`f.weight.as_str()`), and now the
    handler's parameter is the control, checked at the call.

    Stands on: measured (the runtime's and the field module's minified sizes by Node's `zlib` gzip
    and brotli at their defaults, once each build, and the module as the watchlist serves it, once;
    a field's `data-on` and markup against a ref's for the same four
    controls, once; the item page's `render_cost`, five alternated runs of each release build; the lookup of three
    fields in a form of 50, 500 and 2,000 controls against a walk over them, the median of 15
    batches in each of the three engines, once); platform (a form's `elements`
    lists its controls in tree order, `form=` ones included, and a control's `localName` is its
    tag; the smoke's field checks in Chromium, Firefox and WebKit); reasoned (a posted name
    denotes one field of the form, a single control or the radios or checkboxes of a group that
    share it, so the form is where a name finds that field's controls; the kind a form draws
    is another component's markup, which no one `html!` sees); value (in the README's conflict
    order: correctness first (the control is found when the handler runs, and no other is given),
    then performance (README Value 1: the lookup is a module only the pages that call it load, not
    bytes every page pays for a call few make), then compile-time safety, which is what the
    change buys (Value 4: the field is typed at the seam and its name is the one `Fields` writes),
    with one way to do things (Value 5: behavior stays a function the markup calls, and a handler
    in a form reaches the form's control of a name as its field, whichever component draws it,
    while a ref names an element of the handler's own component, a control among them when the
    handler is outside the form, reads one of several that share a name through the control around
    the event, or is a widget's that draws its own)).

    Revisit when: `Fields` or `html!` comes to know the kind a form draws a field as, when the
    kind check moves to the compiler and the runtime's goes; an app needs a control outside any
    form, which is a ref's; a handler is measured spending time in the lookup; or most pages come to
    load the field module, when its bytes belong in the runtime.

    Last checked: 2026-11-15, a field's bytes against a ref's and the item page's `render_cost`
    (native release builds) on `a69607283` against `c9ed56785`; 2026-11-15, the runtime's and the field module's sizes on `0a5e18c29`
    against `1c72b0379`, and the smoke's field checks on it, the field module's loading among
    them, in Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2 (Playwright 1.64.1), and
    `corten dev`'s reports of a mismatched field in Chromium 156.0.8078.4; 2026-11-16, the runtime's size on `03283dcb3` against `1c72b0379`, and the
    smoke's retries of the field and format modules answered 503 and a link to a page that takes a
    field, on it, in the same three engines; 2026-11-16, the smoke's field and retry checks in the
    same three engines and `corten dev`'s reports, on `e5e260bd6`, which merges main's `read()`;
    2026-11-16, the item page's `render_cost` (native release builds) on `f7fc2e5ee` against
    `226b12b35`, the runtime's and the field module's sizes on it, and the smoke's checks of the form
    a field is found in, an empty group and a group named for a select, in the same three engines,
    and `corten dev`'s reports, on it; 2026-11-16, the runtime's and the field module's sizes, the
    lookup of three fields in forms of 50, 500 and 2,000 controls against a walk over them in
    Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2, the smoke's field checks in the same three
    engines (an element whose id is a field's name among them), and `corten dev`'s reports in their
    new words, on `1b6fc2f11`; 2026-11-16, the field module's sizes as built and as the watchlist
    serves it, the smoke's field checks in the same three engines (a form-associated custom
    element's `form=` among them, which the field module of `037bb827b` fails in each), and
    `corten dev`'s reports, on `98e7ca184`.

58. <a id="choice-plain-request-patch"></a>**Building a patch directly requires a checked
    Action; a debug check still catches overrides and raw responses to a browser's plain
    request.** `Req::action() -> Option<Action<'_>>` returns
    `Some` only in the current effective `Mode::Action`. Only its opaque borrowed `Action`
    has `patch` and `patch_with_status`; the unchecked `Req` methods are removed.
    `patch_or`, `invalid` and `invalid_with` keep their mode-selecting contracts and check
    internally. `patch_or_with` passes the checked `Action<'r>` to its part closure
    (`FnOnce(Action<'r>) -> PartFut`), not its page closure, and keeps both sides lazy. It
    shares the sealed `PatchingKind` bound with `patch_or`. This follows `invalid_with`'s
    `FormPatch` precedent without a new response
    kind, wire format or dependency. `Action` consumes itself, has no public constructor or
    `Clone`/`Copy`, and its borrow prevents writing the request's mode while it still has a
    subsequent use. Compile-fail doctests pin these guarantees, the removed methods, and that an
    app can neither construct an `HtmlResponse` nor recast a page's kind to `Patches`. The builder
    is `corten::Action`, left out of the prelude: `route::Action` already names a post's address,
    and an app that glob-imports `route` with the prelude would get an ambiguous name.
    The sealed `PatchingKind` still permits `AnyAnswer` and `Patches`, not `Screen<T>`;
    `Public` and `NoStore` keep their inference. Patch content, live SSE fragments and feed
    protocol values are not HTTP patch answers and need no token.

    The check reads the app's writable `req.mode`, including a deliberate override, as
    [Choice 50](#choice-patch-routes) requires. It proves a typed patch was built on a checked
    path, not that the original wire request asked for one, nor that every possible response
    is a typed patch. A boolean mode test alone cannot refine Rust's `Req`; binding the
    capability makes the unchecked builder unavailable in every build. `patch_or` remains
    the ordinary two-mode answer and constructs its patch before making its future, so a
    view of non-Send references does not make the handler future non-Send. A `patches`
    route's fallback kind conversion stays private to the mode-selecting combinators.
    This is the breaking construction change in
    [#1532 A patch can be made without checking the request's mode: req.action() could hand out the only way to make one, as invalid_with's FormPatch does](https://github.com/corten-run/corten/issues/1532).

    Keep the debug check at the response boundary. The runtime's `data-patch` fetch
    (`corten: action`) applies the fragment; a browser that asked by itself shows it as the
    whole document, without layout, stylesheets or navigation. The check uses the original
    request, before an app override: an HTML `Mode::Document` request not fetched by the
    runtime, whose fetch metadata where present says top-level navigation (`navigate` to
    `document`), gets a 500 if the final response has `corten-patch`. This catches explicit
    mode overrides, raw marked responses and replacements through `DerefMut` after app steps.
    It names the method and route pattern (or raw path), recommends `patch_or` or `action`,
    and preserves `Set-Cookie` and `Clear-Site-Data`. No guard or diagnostic method clone is
    compiled into release builds. A relay remains exempt: its upstream owns the contract.
    Tests retain both the mode-override and raw-response cases, in debug and release.

    Weighed in README order: correctness favors rejecting unchecked typed construction in
    every build rather than only in plain-request tests; performance adds only a borrowed
    token to the existing mode check, with the small instruction differences measured below;
    compile-time safety and one way to do
    things favor the capability over a second unchecked route to the same answer. The
    framework owns this mode-dependent rendering contract, not the handler's domain writes
    or its choice of fallback. Do not require Action for low-level HTTP or live feeds, or
    pretend the type proves an unmodified final response. Not chosen: a public kind cast,
    deprecating but retaining unchecked builders, a second mode enum, or a dev.js-only warning
    that cannot run without JavaScript.

    What it does not see: a request whose fetch metadata says it is not a top-level navigation (a
    page's own `fetch` that asks for HTML, an `<iframe>`'s load), whose answer is not shown as the
    tab's page; a navigation a service worker passes on with `fetch(event.request)`, which reaches
    the server as `navigate` to `empty` whether it was the tab's or a frame's, so it cannot be
    told from a frame's and is not checked, though the worker may show its answer as the tab's
    page (a known gap: Corten's own worker passes one on only when the browser sent no navigation
    preload for it, as when the worker was not yet active as the navigation began; an app's own
    worker may pass on every one); an `unstaged` route, which skips the stages it runs in; a fragment sent
    without `corten-patch` (a response built by hand, or one put in place of the handler's through
    `DerefMut`), which is not a patch to it; a relayed upstream answer (a `Relay`'s), checked by
    the upstream; and a release build. A request the runtime makes is
    never checked, its `corten: page` fetch of a whole page included. Browsers send fetch metadata
    only to a secure context (HTTPS or `localhost`), so a debug build opened over plain HTTP at
    another address (a phone on the LAN) gets none, and both checks take a page's own `fetch` that
    asks for `text/html` there for a navigation: a false 500, which opening the app over HTTPS or
    at `localhost` avoids.

    For the checked construction, release callgrind 3.19.0 with rustc 1.99.1 and jemalloc
    counted main `bbd9d7432` against this change merged with it, `abbdf9831`: each built alone
    (`--all-features --lib`, the release profile), three alternating rounds of 1,200 less 200
    requests, divided by 1,000. Medians (ranges), instructions per request:

    | Answer | Before | Checked Action |
    |---|---|---|
    | `patch_or`, `AnyAnswer`, Action | 17,984.501 (17,984.469-17,984.576) | 17,988.603 (17,988.477-17,988.605) |
    | `patch_or`, `Patches`, Action | 17,984.590 (17,984.494-17,984.607) | 17,988.405 (17,987.066-17,988.497) |
    | `patch_or`, `AnyAnswer`, Document | 18,403.771 (18,403.722-18,403.805) | 18,403.761 (18,403.724-18,403.777) |
    | `patch_or`, `Patches`, Document | 18,403.770 (18,403.708-18,403.797) | 18,403.604 (18,402.128-18,403.693) |
    | Direct small component, Action | 17,539.291 (17,539.284-17,539.291) | 17,549.334 (17,549.306-17,549.428) |
    | `patch_or_with`, slow part read | 17,770.887 (17,770.815-17,770.894) | 17,770.835 (17,770.775-17,770.885) |

    The page side and the lazy read are unchanged. The `patch_or` Action case counts about four
    more (0.02%) and the direct patch about ten more (0.06%); a per-function comparison of the
    first round's profiles places both. All four of `patch_or`'s are in the benchmark, not the
    request path: the test's check after each response, `headers.contains_key("corten-patch")`,
    makes one `memcmp` call a request in both builds, which takes 22 instructions instead of 18,
    while the framework's own header lookups on that route count what they did. Eight of the
    direct route's ten are on the request path, in `Mode::asked`'s two header lookups a request:
    the same number of `memcmp` calls, each 22 instructions instead of 18, though the same
    function on the `patch_or` route of the same binary counts what it did before. The other two
    are in the direct handler itself, its mode check, which the unchecked baseline did not make.
    `Action::patch` counts what the baseline's unchecked builder did and nothing calls `memcmp`
    more often. Why those calls take glibc's longer path was not traced; `memcmp`'s cost depends on where the
    compared bytes lie, which a rebuild can move (reasoned). The token is a borrow and allocates
    nothing.

    Stands on: platform (a browser shows an HTML response to a navigation or a form submit as the
    document, whatever its markup); platform (the
    [Fetch Metadata](https://www.w3.org/TR/fetch-metadata/) headers a browser sends, on which both
    checks' "top-level navigation" stands: `Sec-Fetch-Mode: navigate` with
    `Sec-Fetch-Dest: document` for a link, a reload or a form it submits, `navigate` with
    `iframe` for a frame's load, `cors` (or `same-origin`) with `empty` for a page's `fetch`,
    and none to a URL that is not potentially trustworthy, so none over plain HTTP except to
    `localhost`; probed in Chromium 156: each of those values at `localhost`, and no
    `Sec-Fetch-*` header at all over plain HTTP to the machine's LAN address. That a script cannot
    set them is [Choice 11](#choice-corten-request-header)'s probe); platform (what a navigation
    a service worker answers carries: the request navigation preload sends keeps the navigation's
    destination, `document` or `iframe`, and adds `Service-Worker-Navigation-Preload: true`, so
    it is judged as the browser's own; one the worker passes on with `fetch(event.request)` is a
    new request, which the
    [Fetch Request constructor](https://fetch.spec.whatwg.org/#dom-request) gives no destination,
    and arrives as `navigate` to `empty`, with no `Sec-Fetch-User` and no preload header, for
    the tab's navigation and a frame's alike; probed in Chromium 156 and WebKit 27.2 at
    `localhost`, a link, a reload and a frame's load through a worker of each kind. Taking
    `navigate` to `empty` for the tab's would answer a frame's patch, passed on, with a false
    500; a header Corten's worker added to say which it was would be a format of Corten's own for
    one worker's case, and an app's own worker would still pass on navigations unmarked); reasoned (every
    patch-making method sets `corten-patch` through one constructor, `html_response`, and the app cannot make an `HtmlResponse` but
    through the request APIs);
    measured (callgrind, release, instructions per request through a route's `patch_or` in
    process, 1,200 requests less 200 over 1,000, with the `#[ignore]` test
    `what_a_patch_or_request_costs` in [`tests/patches.rs`](../crates/corten/src/tests/patches.rs), alternate runs, the median
    and the range: `55757d723` (before, six runs) against `55757d723` with only this change's
    `crates/corten/src/page.rs` (three runs), the patch (`Mode::Action`) 17,969.79 (17,969.76 to
    17,969.80) and 17,969.83 (17,969.83 to 17,969.87), the page (`Mode::Document`) 18,382.70
    (18,382.68 to 18,382.82) and 18,382.72 (18,382.71 to 18,382.76), the same within a tenth of an
    instruction; the whole change (three runs), whose other files are tests, an example and
    documents, 17,974.49 (17,974.48 to 17,975.89) and 18,388.71 (18,388.59 to 18,388.78), about
    five and six more, which the build with `page.rs` alone does not show. Those come from the
    tests: `55757d723` with only the then-unsplit test file as at `019058f59` (three runs,
    alternating with three of `55757d723` rebuilt) counts 17,975.85 (17,975.82 to 17,975.88)
    and 18,388.76 (18,388.73 to 18,388.76) against 17,969.86 (17,969.78 to 17,969.86) and
    18,382.79 (18,382.69 to 18,382.84), six more in each mode with no line of the request path
    changed. The `tests` module is `#[cfg(test)]`, compiled into the same test binary as the code it
    counts, and the release profile builds that binary as one codegen unit with thin LTO, so more
    tests in it can move what the optimizer inlines and lays out (reasoned; which functions moved
    was not traced); an app's binary does not include the test module.
    The counted page asks for no HTML, which in a release build reaches the
    same code, since the check and the method it clones are not compiled there);
    measured (the checked-construction comparison above, `abbdf9831` against `bbd9d7432`,
    its medians, ranges and the per-function profile comparison); value (Values 3, a
    form works without JavaScript; Values 9, the developer sees it in a test).

    Revisit when: `req.mode` ceases to be an application override, or the low-level response
    escape paths change, when the remaining debug check's coverage should be reconsidered;
    or an app needs a fragment answered to a top-level navigation on purpose, which
    would need a way to say so; or the runtime stops marking its own
    requests with the `corten` header ([Choice 11](#choice-corten-request-header)), on which "the
    runtime did not fetch it" stands; or a browser changes the fetch metadata it sends (a
    navigation without `navigate` and `document`, a frame or a script's fetch with them, or the
    headers sent over plain HTTP too), on which "a top-level navigation" stands; or a navigation
    a service worker passes on can be told from a frame's (a browser keeping its destination, or
    an app needing the case checked), when the known gap above closes.

    Last checked: 2026-11-16, the router test
    `a_patch_answering_a_browsers_plain_request_is_an_error_in_debug_builds` and its release
    counterpart (the release build's run with `--release`), on `855797ab6`; 2026-11-16, the callgrind runs on
    `4060b8b27` and, of the tests alone, on `019058f59`'s `tests.rs`; 2026-11-16, the reading of
    `html_response`'s callers in `crates/corten/src/page.rs` that the reasoned premise rests on, on
    `855797ab6`; 2026-11-16, the fetch metadata a page's navigation, form submit, `<iframe>` and
    `fetch` (with `Accept: text/html`) send, probed in Chromium 156 at `localhost` and over plain
    HTTP at a LAN address, against the Fetch Metadata Working Draft of 21 September 2026;
    2026-11-16, the fetch metadata of navigations a service worker answers from navigation preload
    and passes on with `fetch(event.request)`, probed in Chromium 156 and WebKit 27.2 (Firefox was
    not run); 2026-11-17, the checked Action's six compile-fail doctests, positive example,
    four-mode/GET/await/status test and release wire-guard regressions, and a callgrind
    comparison then, on `b77577301` against `2292cd604`; 2026-11-17, the checked Action,
    `patch_or_with` part token and the callgrind comparison above, on `abbdf9831` against
    `bbd9d7432`.

59. <a id="choice-local-date-time"></a>**A date and time a visitor enters is a time on their clock, `LocalDateTime`, read in the
    zone its form was drawn in, which the form carries back (`DrawZone` draws it, `FormZone` is
    what the post reads); a time the clocks skip or repeat is read as Temporal's default
    (`compatible`) reads it.** `<input type="datetime-local">` sends what the visitor's clock read
    (`2026-11-13T14:05`), with no offset. Corten wrote an instant in the visitor's zone
    (`t.date_time`) but read none back, so an app took the field as a `String`, parsed it, and found
    the instant with `Zone::offset`, whose offset is the instant's, the one being found: each app
    corrected its own guess and decided on its own what a time the clocks skip or repeat means, and
    one that got it wrong stored the wrong instant
    ([#1421 A datetime-local field has no typed reader: each app parses the visitor's local time and resolves its zone offset itself](https://github.com/corten-run/corten/issues/1421)).
    Now `corten::i18n::LocalDateTime` reads and writes HTML's local date and time syntax, and an
    `Entry<LocalDateTime>` field keeps the text as sent, as `Entry<u32>` does. A
    `LocalDateTime` is not an instant (no `Into<SystemTime>`, not a `DateValue`), so a clock
    reading is not written or stored as one without its zone (a `compile_fail` example on the
    type). `Entry` now holds a sealed `EntryValue` (a number, a `Day` or a `LocalDateTime`, a
    `compile_fail` example for an app's own) rather than numbers alone, so `<input type="date">`
    became `Entry<Day>` at no further cost, and `day.start(zone)` is where a picked day begins
    (the first instant its clock reads the day: its midnight, or, where the clocks skip midnight,
    the change; `day.start(&input.zone)` in a form that carries its zone); `day.midnight_utc()`, the same as `day.start(Utc)`, is deprecated for it.

    The zone a form is read in is the one it was drawn in, and the form carries it. `req.zone()`
    is not the same across the two requests: it is UTC on a browser's first page, which loads the
    script that reports the zone, and in a `Public` page, and the visitor's zone on the post after
    it. A form drawn on the first page and read in the post's zone would store its time moved by
    the visitor's offset, with no error. So a page draws in a `DrawZone`, made from the request's
    zone (`DrawZone::from(req.zone())`), from `Utc` or an `Offset`, or, for a form drawn again
    after a refused post, from the zone that post sent (`DrawZone::from(&input.zone)`), so a time
    typed under `UTC` is not shown again as another zone's. It writes the hidden input
    (`zone.field(f.zone)`), the zone's name (`zone.name()`) and an instant as the input's
    `value` (`zone.local(at)`) or its `min` and `max` (`zone.min(at)`, `zone.max(at)`), the only
    public ways to, so the three come from one zone. The post reads the hidden input as a typed `FormZone` field (a 422 naming it when it is
    missing or names no zone, as any typed field a page writes itself). What the compiler checks,
    each with a `compile_fail` example: `Entry::at` and `LocalDateTime::at` take only a
    `FormZone`, so neither `req.zone()` nor a `DrawZone` reads a posted time; a `FormZone` has no
    constructor but its `Deserialize`, so it is made only from what a client sent (a form, a
    query, JSON) and `FormZone::from(req.zone())` does not compile; and
    `field` takes only a `FormZone` field's name. What it does not check: that the form draws the
    hidden input at all (a form without it compiles, and its post is a 422), that a page draws the
    input and the times from the same `DrawZone`, and that a form drawn again is drawn in the
    posted zone rather than the request's. The zone is sent as a name that already exists: a tz
    database name (`America/Chicago`, `UTC`) or an offset (`-06:00`, to the minute and less than a
    day, so an `Offset` of a day or more is drawn as `±23:59`), one way for each zone: UTC is sent
    as `UTC`, and `+00:00` or `-00:00` is refused.

    Without JavaScript the browser never reports its zone, so the form is drawn and read in UTC.
    The answer is to say so: the page shows `zone.name()` with the field (the guide's example draws
    it in the label), so a visitor types a time in the zone the page states, the form works as
    plain HTML, posts with no script, and reads back what the visitor saw (Value 3, HTML that works
    on its own). That holds only for a page that draws the name, which Corten cannot check; the
    guide, the skill and the types' documentation draw it. A browser with JavaScript gets the same on its first
    page and its own zone from the next. A `Public` page is the same for everyone, so it draws in
    `DrawZone::from(Utc)` (`req.zone()` there is UTC too, and a debug build warns each time a
    `Public` answer reads it). Drawing in UTC and saying nothing would store a visitor's `14:05` as
    UTC's; guessing a zone (from the language, the address) would store it in a zone the visitor
    was never shown.

    A skipped time (`02:30` on the morning the clocks go from 2 to 3) moves forward by the gap,
    and a repeated one (`01:30` on the night they go back) is the earlier instant. That is
    Temporal's default disambiguation, `compatible`, which its documentation says is what legacy
    `Date` does, and RFC 5545 (iCalendar) section 3.3.5 prescribes the same: the first
    occurrence of a repeated time, and a skipped time read at the UTC offset before the gap. A
    day's start is not a typed time: `day.start(zone)` is the first instant whose clock reads the
    day, as Temporal's `startOfDay` (its spec's `GetStartOfDay`) gives it: the earlier midnight
    where midnight repeats, and where the clocks skip midnight, the change itself. Reading `00:00`
    as a typed time gives the same where a gap begins at midnight, but where one starts the day
    before and crosses midnight (Toronto's clocks went from `23:30` to `00:30` at
    1919-03-31T04:30Z) it moves `00:00` forward to `01:00`, and a query from it would leave out
    the day's first half hour; so where the clock shows a later time than midnight at the instant
    `00:00` reads as, `day.start` searches back across the gap for the change. So an instant in the second of two repeated hours, drawn and sent back
    unchanged, reads as the first: the form carries the zone, not the instant. Every instant a form
    draws, the stored `value`, the `min` and the `max`, is rounded down to the minute
    (`floor_minute`): an input counts its steps from its `min`, so one with seconds is off every
    step and the browser would not send the form, and rounding all of them down keeps their order,
    so a stored time in the same minute as its `min` is not drawn before it. Where the clocks go
    back, a later instant reads earlier on the clock (`01:45` before the change, `01:30` after
    it), so a `min` drawn at its own reading can be after the value of a later instant, and a
    `max` before the value of an earlier one; `zone.min(at)` draws at the smaller of the offsets
    at `at` and a day after it, and `zone.max(at)` at the larger of those at `at` and a day before
    it, so the bounds hold every value drawn between them, an hour wider near the change. An edit
    form reads
    the field with `Entry::at_keeping(&input.zone, stored)`, which is the stored instant when the
    field comes back equal to the value drawn from it, so an unchanged field keeps its seconds and
    its offset in a repeated hour (Temporal's `ZonedDateTime.with` keeps the offset an edit started
    from, `offset: 'prefer'`, for the same reason). The input then allows the part of a minute
    before a `min` with seconds, and a time the clocks skip or repeat near a bound reads outside
    it, so the handler's comparison stays the check. Reading asks the zone only for its offset
    (`Zone::known_offset`, `Zone::offset` with `None` where the zone's rules end, as jiff's range
    does late on 9999-12-30 UTC), a day before and a day after the time and at the two instants
    those give, so
    it works for every zone a form is drawn in (`Utc`, an `Offset`, `req.zone()`'s `Visitor`)
    without the `zones` feature and adds no dependency; a zone whose offset changed twice within
    two days would be read with the outer two; where the platform has no instant a day away (its
    first and last days), the nearest instant it has stands in, so `day.start(Utc)` is midnight
    UTC on every day the platform has. A time whose instant is past a zone's rules is refused
    (drawn as nothing, read as `None`, the field's message) rather than taken at UTC's offset,
    which `Visitor::offset` gives there for a written date. `Visitor::known_offset` gives Jiff the
    original timestamp: since 0.2.41, TZif transition lookup uses the second that contains the
    instant, even for a fractional timestamp before 1970. The Toronto regression test checks
    the offset a millisecond before the 1919 transition and at the transition. A test reads every
    zone in the bundled tz database around every change of offset from 1970 to 2040, compares each
    reading with jiff's `compatible()`, which finds the candidates in the database itself, fails if any zone
    changes its offset twice within two days, checks that a `min` and a `max` drawn around each
    change hold every value drawn between them, and checks that each zone is sent by a name a
    `FormZone` reads back. Another reads every zone from its first change (its local mean time,
    before 1900 for most) to 2040, where some zones do change twice within two days, and checks
    the start of the day before, of and after each change against Temporal's start of day, the
    earlier midnight or, where midnight is skipped, the change jiff finds in the database.

    Not chosen: reading a day's `00:00` as a typed time for `day.start`, which this Choice did
    before: it dropped the start of a day whose gap crosses midnight (Toronto, 1919-03-31). Reading in the request's zone (`req.zone()`) with no zone in the form, which this
    Choice first did: it is right only when the draw and the post have the same zone, which a
    first page and its post do not. One type for the zone drawn and the zone posted, which this
    Choice did next: it had to be made from `req.zone()` to draw, so a post could make one from
    `req.zone()` too and read in it, and `LocalDateTime::at` took any zone; two types leave the
    post only the zone it was sent. Rounding a `min` up to the minute, which this Choice did next:
    a stored time in the same minute as its `min` (a few seconds after a listing) was drawn before
    it, and the browser would not send the form, even with only another field changed. Keeping
    the stored instant by a comparison each handler wrote, which this Choice showed before
    `at_keeping`: a handler that left it out lost the stored seconds and, in a repeated hour, moved
    an unchanged time by an hour. Drawing a `min` and a `max` at their own readings, which this
    Choice did next: where the clocks go back they could be out of order with the stored value,
    and the browser would not send the form unchanged. Finding the instant of the change to draw
    the bounds exactly: it asks the zone for its offset some thirty times where a day either side
    is two, and only near a change does it draw tighter bounds than the handler checks anyway.
    Taking a zone's offset past its database's range as UTC's, as reading did before: a time in
    the year 9999 was read and drawn in UTC under the zone's name. Carrying the drawn instant or each field's offset instead of
    the zone: a visitor who changes the time across a change of the clocks would be read at the
    offset of a time they did not pick. Reading or writing in the zone Corten writes dates in
    while it renders (`App::zoned_dates`), so a component would draw an input from an instant with
    no zone, as `t.date_time` does: the handler reads the form before any render, outside that
    zone. Asking the visitor for their zone in the form (a `<select>` of zones): an app can, and the
    zone it posts is a `FormZone` then; most forms have no room for it. Temporal's other answers
    (`earlier`, `later`, `reject`) as options: one answer is one way to do it, and no app has asked
    which of two `01:30`s a visitor meant. `<input type="time">`: a time of day names no day, so it
    is no instant in any zone, and a type for it would be a new concept no app has needed; an app
    with a date and a time posts one `datetime-local`. A `Bounds` for times (`min`, `max` and
    `step` written once for the input and the handler): a time's bounds are mostly instants known
    only at the request (now, when a listing went up), so the handler compares the instants.
    `Serialize` and JSON for `LocalDateTime`: an API sends an instant with its offset (RFC 3339,
    `parse_timestamp`); it is read from text (`Deserialize`) only as a form's or a query's field.

    Stands on: platform (the HTML standard's valid local date and time string, `T` or a space
    between a date and a time of `HH:MM` with optional seconds and one to three fraction digits,
    its valid normalized form, which an `<input type="datetime-local">`'s value sanitization
    gives and its picker sets, and its step base, `min` before `value`, with a step of 60 seconds
    by default and a step scale factor of 1000 milliseconds; Temporal's
    `disambiguation: "compatible"`, `earlier` for a repeated time and `later` for a skipped one
    (its spec's `DisambiguatePossibleEpochNanoseconds`), its start of a day (`startOfDay`,
    `GetStartOfDay`: the first valid wall-clock time of the date), and its time zone identifiers, a tz
    database name (`America/Chicago`, `UTC`) or an offset to the minute written `±HH:MM`
    (RFC 3339's `time-numoffset`), which a browser's reported zone is one of and a `FormZone` is
    sent as;
    RFC 5545 section 3.3.5; Jiff 1 and its bundled IANA tz database (`jiff-tzdb` 1.0.0,
    tzdb 2026f in the workspace lock), whose `compatible()` is checked against `at` in
    `every_change_in_every_zone_reads_as_temporal_compatible_reads_it`;
    a browser reports its zone only from a script, so `req.zone()` is UTC before the first page's
    script runs and without one (`App::client_zone`)); reasoned (a zone whose offset changes at
    most once in any two days has, for a time on its clock, its candidates at the time minus the
    offset a day before or a day after, and a time the clock skips has neither, so both reads are
    exact; a form read in the zone it was drawn in reads back what the visitor saw, whichever
    request drew it; a clock reading that is no `Into<SystemTime>` and no `DateValue` cannot reach
    `t.date` or a field typed as an instant, and a reader that takes only a type with no
    constructor but deserializing what a client sent cannot be given the request's zone; rounding
    every instant a form draws down keeps their order, and a clock read at the smaller of two
    offsets a day apart is no later than it reads at any instant in that day, where the zone
    changes its offset at most once); measured (callgrind, instructions a request, by
    `tests::what_a_date_and_time_field_costs` in the lib's release test binary with all features
    on `939be002f`: 1,200 and 200 requests through the router with `oneshot` from a browser that
    reported America/Chicago, the difference over 1,000, three rounds alternating the eight cases,
    medians with every round within 2 instructions of them; the baseline is the same page and post
    with the times and the zone as text the app does not read: drawing the form, the zone's hidden
    input and name and a `datetime-local` with `value`, `min` and `max`, 29,382 against 25,280,
    +4,102 (16%); reading a post sent unchanged, which `at_keeping` keeps without resolving a
    time, 29,607 against 27,788, +1,819 (6.5%); a post changed by a minute, resolved in the posted
    zone, 30,616, +2,828 (10%); and one changed to a time the clocks skip (2027-03-14T02:30 in
    Chicago), resolved across the gap, 30,862, +3,074 (11%). Only a page that draws such a field
    and a post that reads one pay it: no other page or form calls these. Correctness comes before
    speed (README, Values), and the cost buys a time read in the zone it was typed in, with the
    browser's own bounds and validation, no dependency and no client script); value (a standard's
    answer before one of Corten's, HTML that works on its own, a mistake the compiler can catch
    is a compile error, one way to do each thing and a small surface: Values 2, 3, 4, 5 and 6).

    Revisit when: an app needs to ask a visitor which of two repeated times they meant, or to
    refuse a skipped one; an app needs a time of day alone; the tz database gives a zone two
    changes of offset within two days (the all-zones test fails after a jiff-tzdb update); the
    runtime can redraw a first page's dates and times in the zone it reports, so a first page
    need not be in UTC; a way appears to tie a form's hidden zone input to its time fields at
    compile time (a form type that draws both); an app needs a time to the second in a form
    (`step` under a minute), which drawing to the minute would cut; or an app repeats the same
    instant bounds check on many forms, when a `Bounds` for times would earn its place.

    Last checked: 2026-11-15, the HTML standard's local dates and times microsyntax, its
    `datetime-local` state and its step base (Living Standard, last updated 14 November 2026),
    Temporal's `ZonedDateTime` documentation for `disambiguation` and its spec's
    `DisambiguatePossibleEpochNanoseconds`, and RFC 5545 section 3.3.5, read that day, against
    `1c72b0379`; 2026-11-16, the HTML standard's step scale factor and default step for
    `datetime-local` and Temporal's `ZonedDateTime` documentation for time zone identifiers, read
    that day and checked against the `FormZone` reader at `5f2b8cb8a` (the split into `DrawZone`
    and `FormZone`), with jiff 0.2.38 and jiff-tzdb 0.1.9 (`Cargo.lock`), and the all-zones test
    passing on `5f2b8cb8a`; 2026-11-16, the `FormZone` reader refusing `+00:00` and `-00:00`,
    `Entry::at_keeping`, the drawn `min` and `value` in one minute, a day's start on the platform's
    first and last days, and the all-zones test with its `FormZone` round trip, passing on
    `12794f3ff`; 2026-11-16, jiff 0.2.38's `Timestamp::MAX` (its documentation read that day), a
    time past it refused in a tz database zone, `zone.min` and `zone.max` holding an unchanged value
    where the clocks go back, `LocalDateTime::at`'s `compile_fail` doctests, and the all-zones
    test with its `min` and `max` check, passing on `e9c2ce45e`; 2026-11-17, Temporal's
    `GetStartOfDay` in its spec (read that day), Toronto's 1919-03-31 change in the bundled
    database, and `day.start` against Temporal's start of day around every change in every zone
    from its first, with `Visitor::known_offset` asking jiff at the second an instant is in,
    passing on `591222898`; 2026-11-17, the measured costs above, counted on `939be002f`;
    2026-11-19, both all-zones comparisons and the `Timestamp::MAX` range test passing in CI
    with Jiff 1.0.0 and jiff-tzdb 1.0.0 (tzdb 2026f) on `ecd649c69`.

60. <a id="choice-connection-info"></a>**A connection's handshake value reaches requests through an opt-in typed extension.**
    `serve_wrapped_with` takes a step returning `(Io, T)`, where
    `T: Clone + Send + Sync + 'static`, and inserts `ConnectionInfo<T>` into each request's
    standard `http::Extensions`. A handler takes that extractor; `Identify` borrows it with
    `ConnectionInfo::of`. Reading it makes the answer private, like reading `ClientIp`, but
    a page whose layout depends on the caller still uses `Caller`: an arbitrary handshake
    value is not required to be hashable or to identify a layout. An app groups several facts
    in one struct and uses `Arc` for a value expensive to clone. The wrapper prevents a value
    of a framework extension's type from replacing that extension.

    The old `serve_wrapped` keeps its return shape, and `serve_on` still needs no step. Their
    step returns a zero-sized no-data value selecting the unchanged, non-generic connection
    service, not an optional box or a dynamic dispatch on every request. Only the new entry
    point wraps that service to clone and insert an extension. All three use the same listener
    loop, connection permit, watch and drain; the step still runs after accept, inside the
    header timeout and connection limit.
    No TLS library or new dependency belongs to Corten.

    Changing `serve_wrapped`'s return shape would break existing apps for a feature they do not
    need. A thread-local cannot carry a certificate through middleware that spawns a task;
    an extension follows the request. Letting a custom listener finish TLS before returning
    its IO puts that handshake outside Corten's timeout and connection limit. A request header
    is not proof of a TLS client's identity. Standard request extensions already provide the
    typed store, so this adds no wire format, metadata map or second connection loop.

    What it costs, in the conflict order. Every plain HTTP request pays 2.1 instructions more
    (24,287.261 against 24,285.154, 0.0087%, measured below; the ranges do not overlap, so it is
    real), and this Choice accepts that. It is not work the feature does on that path: the
    ordinary service runs the same instructions and inserts nothing, and the difference is in how
    the compiled connection task, now generic over its step's value, is polled. What was tried
    within one loop cost as much or more: the generic service with a no-op insert about 30
    instructions, that service kept out of line about 10, and an async plain step or choosing the
    service when the handshake ends no less than 2.1. The way left to keep the plain task
    unchanged is a second connection loop for the new entry point, rejected above: its permit,
    header clock, send timeout and drain would be kept in step with the first by hand, a
    reliability cost, and reliability ranks before performance in the README's order. It was not
    measured. Value 1 refuses a feature that costs every user to help a few; here every user's
    cost is two instructions in 24,000, estimated at about a nanosecond, which no time or latency
    measured at the user's end resolves. A TLS request without a value measured no change.

    Stands on: measured (release, Callgrind 3.19.0 on x86-64 Linux, a typed route returning
    `served` over one persistent socket, default features off, Tokio 1.54.1 and tokio-rustls
    0.26.6 with rustls 0.23.46; three rounds alternating before and after, subtracting 200
    requests from 1,200 and dividing by 1,000: plain HTTP 24,285.154 instructions per request
    before, range 24,284.606-24,286.526, and 24,287.261 after, range
    24,286.994-24,288.051, +2.107 or 0.0087%; TLS without metadata 31,337.779 before,
    range 31,337.769-31,337.898, and 31,337.723 after, range 31,337.483-31,338.365.
    The ordinary service and hyper poll have identical instruction totals; the small HTTP
    difference is in task polling, so these counts do not establish literally zero added
    instructions. A generic ordinary service added about 30 instructions per request and was
    replaced with the non-generic service above); platform (`http` 1.5 extensions require a cloneable, sendable, shareable owned
    value); reasoned (selecting the ordinary service for unit data leaves no metadata insertion
    on ordinary requests; the tests exercise two connections keeping distinct stand-in
    certificates across repeated requests and `Identify`, a forged header cannot replace one,
    reads make answers private, a plain connection has none, the metadata step obeys
    connection and header limits and shutdown, and a documented API's handler takes the value,
    required or optional, with its operation in the document unchanged); value (correctness
    before speed, one way to do each thing and a small default surface, README Values).

    Revisit when: a change to the connection task raises a plain HTTP request above the
    24,287.261 instructions accepted here on the same harness (that count is the baseline; the
    2.1 above is not a regression still to fix); a compiler or code change lets the one loop poll
    the plain task at the 24,285.154 it cost before, which removes the residual; an app needs a
    connection value that cannot be cheaply cloned or shared; or the framework changes its
    connection service or request-extension ownership model.

    Last checked: 2026-11-17, before `6c5f17b11` (merged as `b08c48d23`), and the metadata
    path's Rust sources matching `caebfa19d` in the counts above, the connection-info
    integration tests and handshake bounds test, the `Public` compile-fail doctest, and the
    OpenAPI test of a documented route taking it.

61. <a id="choice-access-logs"></a>**Access logging is an opt-in `App` switch, off in every app the template's included,
    and an event through the existing tracing subscriber after the response is finished.**
    `App::access_log(true)` emits an `INFO` event with target `corten::access`, with method,
    path without the query, the route that answered when one did, final status, final body's known size
    (or `"stream"`) and elapsed time until the response is ready. The status is what the client
    gets: a final `100` or `103`, which hyper's HTTP/1 server replaces with an empty `500` before
    closing the connection, is logged as that `500`, and a `101` as itself. A response future
    dropped before it is ready writes nothing; a ready response's line is not changed by a later
    disconnect. It sees the host check's
    `421`, cross-site refusals, error-page replacements, conditional `304`s, compression and
    app layers. It never polls a body to count it, so a live stream is logged when its answer
    is ready, not at a close it may never reach; a body HTTP gives no content (a `204`, a `304`,
    a `1xx`, a `2xx` to `CONNECT`) counts zero. The existing subscriber still owns formatting,
    escaping and routing, including a filter on the line's fields: the check before a request
    names them. No access-log format or dependency is added. With the switch off,
    no clock is read and no request metadata is retained for logging.
    Ordinary enabled requests keep the route beside the answer's future, without a response
    extension, second wrapper or URI clone; the route's name is the router's own `Arc<str>`,
    counted, not copied. Only an app with tower layers
    needs a shared route handoff: a layer can dispatch
    on another task and replace the whole response, defeating both response extensions and
    task-local storage, so a layer that sends clones of one request to several routes is logged
    with the last one matched. The enabled wrapper repeats the route-name lookup in an index built
    only when enabled, separate from normal dispatch so its lookup keeps its original caller,
    and makes the two decisions after the match that dispatch makes: a segment without the text
    its route writes after a parameter is the app's `404`, and a path an API's prefix holds that a
    route outside it matched is the API's (`Scopes::foreign`, the stages' check), so neither names
    a route. Disabled dispatch has no recording branch, additional caller or logging index.

    Measured with CONTRIBUTING's request-path count (release build, Callgrind 3.19, (1,200
    requests minus 200) / 1,000, three runs in alternating order;
    `log::tests::what_an_access_request_costs`, an unlayered app answering through `oneshot` with
    the body collected). "Before" is `38587c414` with only that test added (its framework and
    lockfile are those of `main` then); the others are `65ac1dc47`, this change merged with `main`
    at `e006be831`. Instructions per request, median [min, max]:

    | Request | Before | Off | On | Accepting subscriber |
    | --- | --- | --- | --- | --- |
    | Parameter route | 17,681.0 [17,680.9, 17,681.1] | 17,679.0 [17,678.9, 17,679.1] | 27,299.7 [27,258.1, 27,300.7] | 19,101.1 [19,101.0, 19,102.6] |
    | Unknown URL `404` | 19,135.0 [19,135.0, 19,135.0] | 19,123.0 [19,122.9, 19,123.1] | 27,307.7 [27,307.5, 27,314.4] | 20,505.0 [20,505.0, 20,505.0] |

    The line adds 9,619 (54%) and 8,173 (43%). Preparing the event and handing it to `tracing`
    is about 1,400 of that (the accepting subscriber takes the event and writes nothing); the rest
    is Corten's subscriber formatting the line (timestamp, fields, escaping) into its buffer and
    handing the bytes to a sink that discards them. Writing them to stdout is not counted: its
    system call, and any wait when stdout is a slow pipe or terminal, come on top, as do an app's
    tower layers and their shared route handoff. With the switch off a request costs 2 and 12
    instructions fewer than before, and the ranges do not overlap, but the off path runs nothing
    of the feature: this is code layout, not saved work.

    Not chosen: an app middleware, which cannot see early refusals or the response after
    the error page, conditional GET and compression; a tower layer each app writes, which
    repeats framework knowledge and dependencies; always-on logging, which changes existing
    apps and charges apps that already log at their proxy; enabling it in the app `corten new`
    writes, which would charge every new app the measured cost for a line its proxy may already
    write; carrying dispatch's own match out to the log, which would put a check in the request
    path of every app, logging or not; a separate text format such as
    Common Log Format, which makes logs a second output channel beside tracing; or wrapping
    every body to count bytes and time to close, which costs streams for a different measure.

    Stands on: reasoned (only the outer router boundary sees the final response, and unknown-size
    bodies cannot be counted without polling them); measured (the instruction counts above);
    bet (deployments that want a request line from the app set the switch, and the rest already
    log at their proxy); value (README Values 1, 6 and 7, and the conflict order's performance at
    the user's end before developer convenience: the line is opt-in, shares the existing
    subscriber and adds no dependency).

    Revisit when: an app needs body-completion timing or actual streamed byte counts rather than
    response-readiness timing and a stream marker, or a tracing event cannot express the fields
    an operator needs without a separate log format; or an enabled line costs a small share of
    a request (then the template could turn it on); or the switch off costs more than the
    measured difference above; or the stages decide after the match in another way the index
    does not repeat; or the HTTP server Corten runs on sends a final informational status other
    than `101` (then the line logs it as itself).

    Last checked: 2026-11-16, the request stages, final HTTP handling, the API boundary and
    subscriber read, at `f5f2132aa`; 2026-11-17, hyper 1.12's HTTP/1 server answering a final
    `100` and `103` with an empty `500` over a socket, at `67d888836`; 2026-11-17, a subscriber
    filtering on the line's fields, a `CONNECT` tunnel's empty answer over a socket, and the costs
    above, at `65ac1dc47` against `38587c414`.

62. <a id="choice-changelog-fragments"></a>**Unreleased changelog entries are per-change
    Markdown bullets.** Pull requests add separate files rather than edit the same list. The
    PR number and an entry suffix keep two pull requests for one issue from taking the same
    path; before there is a PR number, a unique branch slug takes its place. Release preparation
    collects the notes into the dated version section, with bullets starting with the Breaking
    marker first and filename order within each group. It moves the previous release unchanged
    to a file beside the main changelog, so existing relative links in that section still work.
    Fragments use prose with single-line inline HTTPS links so a link works before and after its
    note moves, without rewriting it or depending on a reference definition.

    [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) describes the published changelog,
    not how to store fragments. Corten keeps its human-written, newest-first, dated versions
    and an Unreleased section, which links to the pending notes. The new bullets are not
    grouped into its recommended change categories: they are the same uncategorized list
    Corten already uses, with upgrade notes brought to the front.
    [Towncrier](https://towncrier.readthedocs.io/en/stable/tutorial.html#creating-news-fragments)
    would bring a Python tool and put a category in each filename.
    [Changesets](https://changesets.dev/guide/getting-started#what-is-a-changeset) would add npm
    package and bump metadata to each note, duplicating the explicit Rust workspace version
    bump in [release preparation](../RELEASING.md#prepare-the-candidate). Neither is a shared
    fragment standard or needed to collect Markdown bullets with the Node tooling already here.

    Stands on: platform (the two tools' input conventions and Keep a Changelog's published
    guidance); reasoned (distinct paths avoid edits to the same Unreleased list, and one
    workspace version is chosen for the whole release, not inferred from notes); value
    (README Values 2 and 6: keep the published format familiar without adding a release dependency).

    Revisit when: the workspace needs separate package bumps or categorized notes, or a
    common Markdown fragment format can keep the existing release procedure without adding a
    toolchain or duplicating version decisions.

    Last checked: 2026-11-17, Towncrier 26.9.0, Changesets 3.0.3, Keep a Changelog 1.1.0,
    and Corten's release procedure at `231225b9a`.

63. <a id="choice-cluster-feed-subjects"></a>**Cluster feed keys use literal NATS subjects, not encoded names; the
    relay drops invalid legacy keys and publishes reload markers for size refusals.**
    Corten requires nonempty dot-separated tokens
    without whitespace, control characters, `*` or `>`. This is stricter than the broker: it may
    accept an embedded `*` or a non-breaking space, but the documented naming rules reserve
    wildcards and exclude whitespace. Control characters are not useful in names, and Postgres
    cannot store NUL. UTF-8 and multiple tokens are allowed. The existing subjects and message
    IDs for valid keys do not change.

    Keys are limited to 1,024 bytes and the subject prefix to 255. These bounds leave room
    for a 2,729-byte custom reply inbox prefix, a dot and a 22-byte token, and 64 bytes of
    publish framing in NATS's default 4,096-byte control line. The key fits the feed primary
    key and the outbox `(feed, seq)` entry under the
    Postgres B-tree limit on standard 8 KB pages without depending on compression.
    `create_feed` and `begin` return `InvalidFeedKey` before doing SQL. `Cluster::feed` checks
    before loading an uncached key, returning `None` for an invalid one; only validated keys
    get cache entries. `Cluster::start` checks both the subject prefix and the generated reply
    inbox before changing the database or starting background work. NATS does not advertise
    its control-line limit, so deployments that change it set `Options::max_control_line` to
    match the lowest server limit the client can encounter.

    The control-line budget is separate from the payload limit. Starting with async-nats
    0.53, the client's cached payload limit follows later server INFO messages as well as
    the handshake. The client cannot ask for a fresh limit, and an INFO is not a per-publish
    measurement of what JetStream will accept.

    The relay uses the same check, independent of the client or broker, for rows that an old
    version or external SQL could have queued. It marks an invalid row done with the existing
    `published_at` marker, logs the row ID and key at error level, and continues without
    sending the patch. The marker means done, not delivered, in this case. Ordinary pruning
    can remove the row; the app's committed data is not changed. A server with a lower
    control-line limit than the one configured in Corten can still reject a publish.

    JetStream's `10054` acknowledgement and the client's `MaxPayloadExceeded` before
    sending both identify one refused publish. Neither requires giving up notification
    delivery, even when the connection's limit is stale and the broker would accept the
    patch. The relay sends an empty message on the patch's subject with its `Feed-Generation`
    and `Nats-Msg-Id`, and a `Corten-Reload` header containing the decimal feed sequence.
    NATS provides headers and deduplication but no feed invalidation signal; the single
    cluster-only header carries that signal without changing the feed's patch or SSE format.
    A same-generation marker at or below the follower's loaded sequence is redundant;
    otherwise it reloads from Postgres, including when the marker arrives during a load.
    An old follower drops a same-generation marker as invalid JSON and can stay stale until
    a gap or other reload. Other generations still use the existing generation mismatch path.

    The relay sends markers after the batch's patch attempts, so a later patch may already
    have revealed the gap. It marks acknowledged rows done in one batch, even when another
    row's marker cannot be sent or acknowledged. Marker sends and acknowledgements share a
    deadline of half the lease from its last renewal, leaving time to retire acknowledged rows.
    The failed row stays pending and takes one slot on a retry; a full batch with nothing to
    retire can stall the queue. The broker and stream limits must fit the longest key plus up
    to 135 bytes of marker headers. Within JetStream's configured deduplication window from
    first acceptance, the shared ID deduplicates retries of either the original patch or its
    marker. A duplicate acknowledgement retires the row but does not identify which
    representation was first accepted; outside the window both can be stored. The
    application write remains committed and the outbox body stays available for replay
    and inspection until ordinary pruning.

    The relay pipelines a batch of up to 256 patches, even when every patch belongs to one
    feed, draining ready acknowledgements while it sends. It uses one NATS reply subscription
    while holding the relay lease, allocating a distinct range of reply slots to each patch or
    marker batch. Replies do not have to arrive in order. Successful batches reuse the
    subscription without another subscribe or flush; a batch with unresolved replies closes
    the inbox before a retry can use a new one. Losing the lease or cancelling the relay also
    closes the inbox. No unanswered publish leaves a registration in the client's multiplexer.
    The longest slot suffix fits in the existing control-line reserve.
    The client does not expose its subscription capacity. A tiny queue can drop replies
    during a burst. If some patch replies arrive but others time out, the whole pipelined
    selection is retried, adding broker work even when JetStream deduplicates by message ID
    within its configured window. For the rest of that relay publisher's lifetime, patch
    batches keep only one reply outstanding, which fits any positive queue capacity without
    using more broker subscriptions. A serial pass uses the renewal interval to limit new
    sends, bounds in-flight waits by the lease, and retires acknowledged rows before
    continuing the pending rows on later passes. Marker batches can also retire replies
    that arrived without waiting for an identically sized retry to succeed.
    A broker's connection-wide `Maximum Payload Violation`
    or disconnect identifies no publish; the relay retries all selected rows on a pipelined send
    or acknowledgement failure and does not force a reconnect. Later patches can overtake a
    failed one in JetStream; followers recover as described in the
    [relay stream-order limit](#limit-relay-stream-order).

    Not chosen: encoding arbitrary keys (a new wire mapping and migration of valid subjects),
    restricting keys to ASCII, or introducing a separate quarantine and repair path for rows
    no supported app can publish. Checking only new keys leaves the pre-upgrade relay failure
    in place. Using async-nats 0.53's JetStream publish acknowledgements retains one reply
    registration per unanswered publish, even after the acknowledgement future is
    dropped. Subscribing per batch adds subscribe and unsubscribe commands even for a single
    update; subscribing per reply slot can exceed the broker's connection subscription limit.
    Using `Subject::is_valid` would copy the key
    and accept whitespace outside the framing bytes. Dropping a refused notification leaves a
    loaded feed stale if no later patch arrives; retrying the same oversized body can keep the
    feed stale and block the relay's ordinary pending scan. A per-feed hold adds an index to
    every append and can make selecting work for unrelated feeds slow. A separate queue would
    not put a patch back in its original stream position. Refreshing a shared client to confirm its
    cached limit disrupts followers and other publishers, and a fresh connection's limit
    would still not be an acknowledgement. Discarding the queued publishes on connection loss
    is not an operation async-nats 0.53 exposes. Dropping a handle does not cancel the connection
    task, `force_reconnect` queues a command, and `drain` flushes pending work. A fresh client
    per lease or batch would need the caller's connection configuration and still would not
    prevent its queue from crossing a socket failure. `max_reconnects(0)` means unlimited;
    positive limits count consecutive connection attempts and reset after success.
    Waiting for an acknowledgement between rows of the same feed serializes a hot backlog on
    broker round trips. JetStream's `Nats-Expected-Last-Subject-Sequence`
    compares the most recent stored message on a subject by its stream-wide sequence, not by
    Corten's feed sequence or message ID. Unrelated publishes can advance the stream, so the
    relay still needs the preceding patch's or marker's actual broker sequence before it can
    guard the next one. It would have to track that sequence per subject and recover it after
    failover or retention. The subject check can also reject a retry before message-ID
    deduplication sees it. `Nats-Expected-Last-Msg-Id` checks the entire stream, not one feed.

    Stands on: platform (the [NATS subject rules](https://docs.nats.io/nats-concepts/subjects)
    exclude whitespace and reserve wildcards for subscriptions, the
    [NATS server configuration](https://docs.nats.io/reference/config/) defaults to a 4 KB
    control line, [JetStream message deduplication](https://docs.nats.io/learn/jetstream/publishing#avoiding-duplicate-writes)
    uses a configured window, and [Postgres B-tree entries](https://www.postgresql.org/docs/16/btree-intro.html)
    fit only about a third of a page;
    [JetStream's size check](https://github.com/nats-io/nats-server/blob/v2.15.2/server/stream.go#L6663-L6674)
    returns `10054` on that publish; its
    [subject expectation check](https://github.com/nats-io/nats-server/blob/v2.15.2/server/stream.go#L6774-L6797)
    uses the stored stream sequence and precedes
    [message-ID deduplication](https://github.com/nats-io/nats-server/blob/v2.15.2/server/stream.go#L7020-L7044);
    the [NATS broker](https://github.com/nats-io/nats-server/blob/v2.15.2/server/client.go#L2617-L2621)
    sends a connection error without a subject or reply ID, and
    [async-nats 0.53](https://docs.rs/crate/async-nats/0.53.0/source/src/connector.rs)
    caches the limit from its handshake and later INFOs, and its
    [publish queue](https://docs.rs/crate/async-nats/0.53.0/source/src/lib.rs) survives reconnect;
    zero [maps to no reconnect limit](https://docs.rs/crate/async-nats/0.53.0/source/src/options.rs);
    [client drain](https://docs.rs/crate/async-nats/0.53.0/source/src/client.rs) flushes pending work;
    the connection handler drops messages when a subscription's queue is full);
    reasoned (retrying cannot repair a key that fails a pure check; the compact marker fits
    limits that refuse larger patches, provided they can carry the headers; the durable
    app state does not depend on the delta being sent, and followers can reload it even
    without a later patch); value (correctness and reliability first, early failure and a
    small surface: README Values 4 and 6).

    Revisit when: an app needs arbitrary text as a cluster key, the NATS server's default
    control line or documented grammar changes, clients can identify an individual broker
    refusal or reliably refresh the cached limit without reconnecting, JetStream provides a
    standard invalidation signal, supported limits cannot carry the marker, or deployments need every
    delta delivered or immediate recovery on old followers, the NATS client can abandon queued
    publishes on socket loss, deployments need raw stream ordering, or JetStream can guard a
    subject by a publisher-supplied predecessor ID without first waiting for the predecessor's
    stream sequence. If the client exposes subscription capacity, bound the number of
    outstanding replies directly. Use the client's JetStream publish API again when a released version
    reclaims unanswered publish registrations without a healthy-path regression
    ([nats-io/nats.rs #1641 Prune abandoned requests from the multiplexer](https://github.com/nats-io/nats.rs/pull/1641)).

    Last checked: 2026-11-20, the `corten-cluster` integration tests at `4225a2837` on
    PostgreSQL 19.0 and NATS 2.15.3 with async-nats 0.53.0 and SQLx 0.8.6: 36 passed, the opt-in
    TLS and capped-subscription tests among them returning early without their brokers, and the
    four `#[ignore]`d benchmarks not run. A generated 1,024-byte key was inserted into both
    `corten_feeds` and `corten_outbox`, both types of size refusals reloaded followers, and a
    follower recovered after a broker disconnect;
    2026-11-19, async-nats 0.53.0's reply map and subscription cleanup,
    real JetStream retries with publish acknowledgements suppressed and then restored, a full
    batch on a 64-reply subscription, recovery after a partial timeout with a three-subscription
    broker limit and a 64-reply queue, and the relay throughput, follower latency and
    missing-ack RSS tests;
    2026-11-18, async-nats 0.53.0's INFO and reconnect handling and the
    `corten-cluster` integration tests on Postgres 16.13 and NATS 2.15.2 with 0.53.0,
    including both types of size refusals and follower recovery after a broker disconnect;
    2026-11-18, `corten-cluster` integration tests on Postgres 16.13 and
    NATS 2.15.2 with async-nats 0.52.0: both refusals publish markers while retaining the
    patch in Postgres. Ready and loading followers reload a refused tail, then apply the
    next patch normally, while a cold follower reads the committed state. A refused marker does
    not stop unrelated rows crossing a batch boundary. With one marker acknowledgement
    withheld, the acknowledged rows retire first. A retry retires the remaining row once
    acknowledgements resume. The longest marker overhead measured 135 bytes. Retries
    deduplicate in both orders without reconnecting. After a real broker disconnect, the batch
    remains pending for retry and a queued later patch reaches JetStream before retry. The
    follower reloads from Postgres, ignores a stored repeat and at-or-behind markers, and
    delivers the next write as a normal patch on its live stream;
    2026-11-17 at `056964945`, subject rules and control-line configuration.

64. <a id="choice-exclusive-ends"></a>**Any-step bounds use native hints and check exclusive ends
    on the server.** HTML has no exclusive number bound. For both `f32` and `f64`, emit the
    endpoint itself as `min` or `max`, just as for an inclusive bound. The hint is advisory.
    The cost is that an endpoint can reach the handler, which runs the authoritative
    `Bounds` check and refuses it with a typed field error and HTTP 422 on a form POST.
    Show the logical rule in a visible hint and in the field error.

    Correctness and HTML that works on its own matter more than blocking every invalid
    value early. Moving a hint inward can stop a server-valid submission before the handler
    sees it. Firefox can read an excluded `f64` endpoint and the next float as the same number.
    Chromium and WebKit can reject a decimal Rust rounds inward even against a serialized
    `f32` rounding midpoint, and a shortest spelling of an excluded `f32` can itself land on
    that midpoint. Keep the ordinary native hints instead of trying to encode exclusivity in
    an inclusive attribute, or replacing number inputs with a parser or input mask.

    Known limit: even with unshifted hints, Chromium and WebKit can block a server-valid
    decimal spelling about one float step inside an exclusive end. For an `f64` minimum of
    `0.0010000000000000002` (emitted as `1.0000000000000002e-3`), both block the fixed
    spelling `0.0010000000000000005`, which `Bounds::read` accepts as the next float.
    Keep native feedback for ordinary fields. An app that needs these values can omit the
    native range hint on that field and enforce the exclusive rule on the server alone.

    Any-step bounds and programmatic prefills share one formatter, using exponent notation
    past 18 digits written out. The digit budget governs notation, not logical ranges.
    Plain inputs use `Bounds::input_value`, which `NumberField` also uses; it preserves
    submitted text on redisplay. Existing stepped fields and standalone `Entry` attributes
    keep their formatting.

    Concrete `f32` and `f64` constructors reject non-finite or reversed ranges, or ranges with
    no representable member, using stable const comparisons and adjacent-float operations.
    A stepped bound stays off an end by starting one step in.

    Stands on: platform ([HTML's number state](https://html.spec.whatwg.org/multipage/input.html#number-state-(type=number))
    and [floating-point syntax](https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#floating-point-numbers));
    measured (gallery POSTs at and just inside the `f64` minimum and `f32` maximum in three
    engines, and the precise-end counterexample above); value (correctness, standards first,
    and HTML that works without JavaScript).

    Revisit when: HTML gains an attribute for exclusive number bounds, or browsers compare
    native range hints at full double precision.

    Last checked: 2026-11-18, gallery POSTs with JavaScript disabled in Chromium, Firefox and
    WebKit (Playwright 1.64.1), with 422 for ordinary endpoints and 200 for inward values, and
    a separate no-JavaScript probe confirming the precise-end counterexample in Chromium and
    WebKit.

65. <a id="choice-locked-check"></a>**Checking and shipping use the lock; local builds update it.**
    `corten check` uses `--locked` on the full Cargo metadata it already reads, before formatting
    or compiling, and on lint, build and tests. The starter Dockerfile and every example's also
    build with `--locked` (the starter's build with a profile too, and its install of the
    `corten` command, [Choice 69](#choice-profile-image)), and so does card-market's timed benchmark recipe, its download too
    ([#1584 card-market's image and its paired bench recipe still build without --locked](https://github.com/corten-run/corten/issues/1584)). A missing or stale lock is an error, not a successful check that silently
    repairs the dependency graph and leaves CI's committed graph unchecked. Cargo finds the
    workspace-root lock even from a member, including a library. The CLI does not require a
    member-local lock or inspect Git's index: the developer commits the resolved lock.
    A command that writes the manifest writes the lock to match: `corten new` and `corten ui add`
    (when it adds `corten-ui`) run `cargo update --workspace` in the app's directory, which
    honors Cargo's configuration there and adds what the lock lacks without moving the versions
    a workspace's lock already has, so their output passes the check with no step between.
    `corten dev`, `corten build` and ordinary Cargo builds keep Cargo's normal lock updates;
    those are the edit loop, while a check verifies what is ready to commit and ship.
    `corten build --locked` passes the flag to its builds, profiled or not, so Cargo fails them
    when the lock is missing or needs updating.
    Not chosen: an opt-in `corten check --locked` or an opt-out that lets CI silently repair
    the graph; an additional metadata subprocess when the check already resolves metadata;
    `cargo generate-lockfile` in `corten new`, which rebuilds an existing workspace lock with
    every package at its newest version when the app is created as a member.

    Stands on: reasoned (locking the existing resolution adds no Cargo invocation; using Cargo
    rather than locating a lock ourselves preserves workspace semantics; a lock rewritten by
    CI is not the lock an image receives); value (correctness before developer convenience,
    one way to check and good defaults, README Values).

    Revisit when: the check no longer reads full Cargo metadata before its other steps, or an
    app needs to verify a graph without retaining a lock and cannot use ordinary Cargo checks,
    or Cargo gains a lock-writing command that `corten new` should use instead.

    Last checked: 2026-11-17, the check's metadata and Cargo-step order read at `7d9bbbf1e`;
    2026-11-17, `corten new` then `corten check`, and `corten ui add --all` then `corten check`,
    each with no step between, on the change after `dd4baf7a4`; 2026-11-17, Cargo 1.99.1 on a
    new member of a workspace whose lock held `itoa` 1.0.0: `cargo generate-lockfile` moved it to
    1.0.19, `cargo update --workspace` kept 1.0.0, and for a standalone app with no lock the two
    wrote identical locks; 2026-11-20, each image's one build read as a locked release build by
    `scripts/images.test.mjs`, and card-market's timed recipe as a locked fetch and build by
    `bench/fullstack/builds.test.mjs`, at `d8832da25`; 2026-11-20, the starter's image read by
    the same test as two `RUN`s, each in its one shape: the install of the `corten` command,
    locked, and the build, `cargo build` or `corten build`, locked either way, at `99c6ccc85`
    merged with `4225a2837`.

66. <a id="choice-write-own-page-whole"></a>**A write's own page is whole in document mode or an action
    that prefers it; a patch does not fill a layout read.** A `data-patch` write that answers with its
    own result (a form drawn again with what it refused, a bulk add whose failed lines the page
    lists) could not bring a layout read up to date: `req.page` in `Mode::Action` rendered `<main>`
    alone, and a patch carries elements by id where a read's view, drawn at two places, has none. So
    the shell's count was right without JavaScript and stale with it, the split
    [#538 A data-patch write that redirects leaves the layout as the full load drew it, so a layout value the write changed stays stale with JavaScript and is right without it](https://github.com/corten-run/corten/issues/538)
    closed for a write that redirects
    ([#1370 A write that answers its own result with JavaScript (a patch, or its page) cannot bring a layout read up to date: only a redirect redraws the shell, so a partial result must choose between its detail and the shell's count](https://github.com/corten-run/corten/issues/1370)).
    Now a write's `req.page` (any method but `GET` and `HEAD`) is the whole document with
    JavaScript as without, for a runtime that says it draws it (`Prefer: corten-draws=whole`,
    [Choice 11](#choice-corten-request-header)): a runtime from before (a tab open across the deploy)
    gets `<main>` alone, as it did, since it would take a whole page for an answer it does not
    draw, say the write failed, and a resend would be a new write. A runtime given `<main>` for
    a write with a matching shell key has the next navigation read the whole page. Across a
    mixed-version deploy, different runtime bytes change the shell key: either runtime keeps the
    shell boundary and reloads the current address without resending, losing the write's answer
    (including a refusal's input and messages). The layout reads a whole answer
    draws start once the handler has answered with it
    (nothing runs beside the handler, whose reads must see what it wrote), `give` is honored, and
    the runtime applies it with the comparison it runs on the page a write redirects to
    ([Choice 10](#choice-app-owns-document)), drawing `<main>` and each element around it that
    changed, in the same document. Until it is in, every navigation reads the whole page, as after a
    write that redirects, so one that leaves it on its way still shows what the write changed. The
    runtime keeps the writes whose change no layout has drawn, numbered as their outcomes come: a
    write's whole own page, a redirect, and a patch (or `<main>`) that took the write, each
    undrawn until it is in. A page's layout stands for those answered before it was asked for and
    the write it answers, and drawing it makes every other write answered since it was asked for
    undrawn again: with two writes out, whichever page is drawn last, its layout may be older than
    the other write, so the next navigation reads the whole page. That holds for a patch too: one
    that drew a layout element (a count with an id) and is then drawn over by an older write's own
    page is undrawn again, so the next navigation reads the whole page. A navigation that cuts off a write not yet drawn (waiting
    for its answer, or a patch that took it whose scripts are loading; only a navigation does: a
    newer submit of the form waits for it) reads the whole page,
    and the write, which the server may have applied, counts too, numbered as the navigation starts
    and after the writes that page draws: the server may still be running it as that page is read,
    so the navigation after reads the whole page again. One that failed in view (the network failed,
    a 5xx, or the body of an answer that took it was cut off, or did not draw, after its headers
    came), which the server may have applied too, counts for a navigation to another page.
    When an error is shown, a cut body or a completed 5xx marks the same write undrawn again,
    even if a later write's layout covered it while the body was on its way.
    An undrawn failure vetoes a whole `ReadAgain` poll even if another write is undrawn or the
    page normally polls whole while its write lands. If a whole poll is already waiting for its
    answer or assets, it skips the draw and schedules the next read. This avoids replacing the
    whole layout, not every failure message: a partial draw can still replace `<main>` and page-owned
    layout parts. Without the Navigation API, `ReadAgain` reloads.
    A write the server applies after the navigation
    after its cut-off (a slow write still running then) shows at the next whole page read for another
    reason (another write, a reload). A page the app's or an area's
    middleware makes with `Req` in the route's place is filled as the middleware answers, under the
    request's deadline and before the error page, from the head that `Req` was taken with, as the
    route's own page is. Middleware can take `Req` from a retained head after the route answers
    and replace its response. Only the forwarded request's extensions tell `Req` not to copy the
    head at a typed endpoint, where a page-capable route takes its own copy and a patch-only
    route needs none. Each dispatch that stages late fill replaces the record, so a write forwarded
    to another router can still start its layout reads. The record holds the route mark and only
    this dispatch's optional deadline as values, without a separate deadline allocation. The
    receiving app's layout reads follow its own deadline, not one from forwarded or copied
    extensions. The enclosing app's request timer still bounds the entire response from the inner
    app, as with any slow service. Set the inner deadline no longer than the outer one if slow
    places should be left empty instead of the outer timer answering 503. With no inner deadline,
    an outer one-second timer cuts off a response waiting on a two-second inner read. Replaying a
    retained head starts a fresh dispatch; the signal still closes head publication independently.
    A head retained by middleware is kept on the request's `Signal` (a `Req` stays the size it
    was on `main`), which the head's extensions hold in turn, so it is let go when the write is answered
    or its future dropped unanswered (the client gone, a middleware's timeout). Publication checks
    the closed mark under the slot lock, so a detached extraction cannot recreate the cycle after
    cleanup. The route and middleware fills run only for responses with places. A typed patch-only
    route with no app or scoped middleware skips the preference and late fill entirely. A named
    POST with only patch handlers does too; the router works that out at startup. A mixed POST
    stays eligible without reading its query twice. Middleware can answer in the route's place or
    change the mode or preference, so a page made with `Req` honors the headers it was taken with.
    In an app with reads, a swap write that goes through middleware can enter the late timeout
    poller even if its incoming request did not prefer a whole page. The page-capable route or
    early `Req` keeps the head regardless of the preference middleware leaves: a handler may
    still set `req.mode = Mode::Document` ([Choice 50](#choice-patch-routes)). Only a whole page
    with places fills late; a fragment starts no reads.
    A `GET` form's page stays `<main>` alone, as a navigation's, since a `GET` changes nothing the
    layout shows. A page whose frame differs swaps `<main>` and the layout's elements that are the
    page's, as a navigation does, and the next navigation reads the whole page; it cannot load in
    full, as the redirect's page does, since loading the address would not draw the write's answer.
    The limit: where a navigation's page loads in full (a section stylesheet that fails to load, a
    page element with no place on screen), so does the write's, as its `<main>` did before: its
    address is loaded and its answer is lost (a refused form's messages and values), its notice kept.

    Not chosen: a patch that gives a value (`action.patch(..)?.give::<CartCount>(n)`) filling each
    place on screen. Every page with a layout read would carry a marker per place for the runtime to
    find, a cost on every page to serve the few writes that answer in place, and it would be a second
    way to bring a read up to date beside the page (Values 5). A notice that carries a list, so the
    write can redirect: narrower, since a form drawn again is no notice. A built-in client behavior
    or a second handler model: what the issue asks for is a page, which the server already draws.
    So a patch still fills no layout read; a write whose answer must change one answers its page,
    and a layout value a patch updates is a component with an id, passed its value as a prop.

    Not chosen either: the runtime's record of the writes (the numbers, the undrawn and failed
    sets, `drew`) in a script module of its own, loaded before a page's first write is sent, as
    `upload.js` is for a form with progress, with only the calls to it in the runtime. Built with
    the runtime's settings (esbuild and terser, gzip by Node's `zlib`), the runtime would be 44,971
    bytes and 16,029 with gzip where it is 45,027 and 16,074, 45 less, and the module 490 and 326:
    a page that writes would load 281 bytes more in all, and its first write would wait for one more
    script before it is sent: a module of Corten's own (`corten-upload.js`) imported cold from the
    watchlist over loopback takes a median of 10.3 ms in Chromium, 33 in Firefox and 22 in WebKit
    (25 fresh pages each, Playwright, on a loaded host; 8.8 to 287), and over a network at least one
    round trip more. A navigation reads the record as it starts, before it
    can wait for anything, so one that starts while the module loads would need a record of its own
    in the runtime for the writes it cuts off. 45 bytes on every page do not pay for a slower first
    write and a second record (Values 1 and 2).

    Historical measurements: a write's own page in `Mode::Action` sends the layout's markup and waits for its
    reads, which start only once the handler has answered. In the crate's test app (two layout
    reads, a small layout, a route of a routes module), with a read that takes 20 ms, the whole page
    is 506 bytes and answers in 21.3 ms (median of 25, three runs, 20.2 to 25.8), where `<main>` was
    37 bytes in 0.04 ms: the user waits for the layout's reads after the write, as a browser
    without JavaScript does. In the watchlist (its real layout, no layout reads) the write's own page
    is 2,632 bytes, 1,123 with gzip, where `<main>` is 911 and 471 (the smoke's write to
    `/smoke/written`, fetched by Node three times each, the same each time, gzip by Node's `zlib` at
    its default level). In instructions (callgrind, release, `70031a793` against `main` at
    `1c72b037` with the harness tests added), it takes 62,450 where its `<main>` swap took 24,781;
    the same write from a browser without JavaScript, the same whole document, takes 57,595 (57,182
    before), and a `GET` of the whole document 53,072, so the runtime's write pays 4,855 more than
    the same write without JavaScript: the copy of the request's head that its reads start from
    (made before the handler, since the handler takes the request), the fill's two boxes and the
    preference. In an app without layout reads it takes 28,199 where it took 24,683 (the document's
    head and layout). A runtime that does not prefer it gets `<main>` in 23,885 (23,244 before: the
    look for the preference and the route's look at the request's mark; not traced further). A write
    that answers something else starts no read, since nothing runs beside its handler. In an app
    with layout reads only a route whose answer type can be a page keeps a copy of the request's
    head, known where the route is called: one that answers patches alone (`HtmlResult<Patches>`),
    JSON or text keeps none, and its patch takes 25,716 where it took 23,532. An `HtmlResult` route
    keeps it, since its handler may answer either: a `data-patch` form whose handler is
    `req.patch_or(view, page)` answers a patch with JavaScript and its page without, so it is
    `HtmlResult` and pays the copy on each patch, 31,180 where it took 22,900, 8,280 more; such a
    handler may return `HtmlResult<Patches>` instead, as the guides say. The historical gap between
    the two patches was 5,464 on `70031a793` (31,180 less 25,716), as on `bb7562d9d` and
    `70b69a3db`. That gap included more than the copy: it also included the route continuation
    and the dropped head.
    The head is copied field by field from the request in place. Before `main`'s named posts were
    merged in, that version's patch-to-patch gap was 5,395 (`914f4781e`, 30,930 less 25,535).
    Taking the request apart and putting it back gave a gap of 5,535
    (`17f285075`, 31,132 less 25,597), 140 more. With named
    posts merged in, the field-by-field version's patch-to-patch gap was 5,464
    (`70b69a3db`, 31,017 less 25,553), 69 more than its earlier gap, not traced. The headers and
    extensions are cloned either way, since a read is given the whole head. A route given by hand (`Table`)
    copies the head as its `Req` is taken, whatever it answers, and so does a `Req` the app's or an
    area's middleware takes before a write's route, a second copy beside the route's: the own page
    takes 66,413 and an `HtmlResult` patch 35,580 with a middleware that takes `Req` and passes the
    request on, about 2,100 and 2,550 more than without it once the `Req` itself (1,847 before) is
    counted (at `70031a793`, where that head and the request's signal kept each other and were never
    freed; see below for what freeing them costs). Other requests pay a little: in an app without layout reads a patch takes 23,269 where
    it took 22,752, a navigation in an app with them 22,358 where it took 22,221, and a whole
    document 53,072 where it took 52,782. Of the whole document's 290 (`callgrind_annotate`, each
    function's own instructions, `main` against the head): 145 is the test's own search of the
    answer (`str::contains`, called as often in both; not the server's work, and why it reads more
    is not traced); 87 is copying, two more copies a request in `At::run`'s future (58; the request
    is moved into its future by a function that first looks for the preference, which a variant with
    the look inside the future cost the whole document 995 over `main`, a slot of the request kept
    in each of its states) and a `Req` 8 bytes larger (29); 24 in `At::run` itself, 12 in taking
    `Req`, and 10 in the head's extensions cloned under another name. So about 145 is the server's,
    all of it moving bytes. The navigation's 137 and the patch's 517 are not traced. The watchlist's
    watch (an app without layout reads) takes 81,585 where it took 80,551, and `main` takes 81,697
    for the same request with the preference, which `corten::testing` now sends for `Mode::Action`
    and `main` ignores: the watch's rise is the test client's one header more, and what the server
    adds to it is within its runs' range (up to 430 instructions here, against at most 3 on the
    crate's patch) and is not resolved. The route's
    fill is boxed: with the box only around the reads, past the handler, an `HtmlResult` patch took
    262 less but every other write about 480 to 590 more, as each route's future grew. Letting go of
    the heads a `Req` kept before the route (a mark on the signal, looked at as the write ends, and
    the heads taken off it only where one was kept) costs a write the runtime sent in an app with
    layout reads about 90 to 150 instructions (callgrind, release, `what_a_write_answering_in_an_action_costs`,
    the head against `ef35919bb`, which leaked them, three alternating rounds, median [range]): its own
    page 62,569 [62,546 to 62,581] where it took 62,482 [62,478 to 62,511], an `HtmlResult` patch
    31,329 [31,328 to 31,329] where it took 31,180, a `Patches` one 25,862 where it took 25,716; the
    same write without JavaScript is unchanged (57,619 [57,618 to 57,625] against 57,622 [57,576 to
    57,644]). With a middleware that takes `Req` the own page takes 69,873 [69,804 to 69,891] where it
    took 66,448 [66,447 to 66,498], and an `HtmlResult` patch 37,523 where it took 35,578: that is
    the head and the request's signal freed where before they leaked, `_int_free`, `free` and
    `malloc_consolidate` 4,253 more per request and `malloc` and `_int_malloc` 1,669 less
    (`callgrind_annotate`, each function's own instructions, 1,200 requests of each build), the
    memory the leak took handed back. In that historical comparison the runtime was 1,181 bytes larger raw and 462 with gzip
    (15,612 to 16,074 at zlib's default level, against `main` at `27c29d7d2`), numbering the
    writes a layout draws and which of them failed in view.

    The no-read paths neither install nor mutate the late-fill extension. The generic route
    still has to negotiate: it can answer a whole page even in an app without reads. That is
    not an attribution of its entire measured cost to negotiation. The remaining overhead and
    the 496 more gzip bytes on pages that load core are accepted so the same handler's own-page
    answer shows what the write changed with or without JavaScript, without adding a marker
    to every layout place or a second way to update it. Apps with reads still pay for the late
    path when eligible, and generic routes can capture the head even when they answer a patch.
    These instruction counts do not establish elapsed time.

    Fresh Callgrind instruction counts from `write_request_cost`, main `4f1b085df` against `5a553e247`.
    Measured median instructions per request [range]; paired increases are calculated before
    rounding. Cases with reads use `READS=1 MIDDLEWARE=1` (pass-through middleware); legacy
    leaves out the whole-page preference.

    | Request | Layout reads and middleware | Main | Head | Paired increase |
    |---|---|---:|---:|---:|
    | Document GET | No | 19,045.50 [19,045.47 to 19,045.52] | 19,162.51 [19,161.04 to 19,162.51] | +116.99 [115.54 to 117.04] (0.61%) |
    | Navigation GET | No | 17,680.41 [17,680.37 to 17,680.42] | 17,807.45 [17,807.42 to 17,807.46] | +127.05 [127.00 to 127.08] (0.72%) |
    | Direct typed patch | No | 18,141.72 [18,141.69 to 18,141.72] | 18,327.73 [18,327.71 to 18,327.73] | +186.01 [186.00 to 186.01] (1.03%) |
    | Generic patch | No | 18,168.72 [18,168.69 to 18,168.76] | 18,643.72 [18,643.69 to 18,643.76] | +474.97 [474.96 to 475.07] (2.61%) |
    | Typed patch, legacy | Yes | 17,395.75 [17,394.37 to 17,395.76] | 19,080.42 [19,079.44 to 19,082.08] | +1,685.06 [1,684.67 to 1,686.33] (9.69%) |
    | Typed patch, preferred | Yes | 18,215.74 [18,215.69 to 18,215.77] | 19,987.55 [19,987.48 to 19,987.57] | +1,771.78 [1,771.75 to 1,771.88] (9.73%) |
    | Generic patch, legacy | Yes | 17,419.79 [17,419.79 to 17,419.84] | 21,693.29 [21,693.26 to 21,693.33] | +4,273.49 [4,273.42 to 4,273.55] (24.53%) |
    | Generic patch, preferred | Yes | 18,242.76 [18,242.73 to 18,242.79] | 22,960.68 [22,960.68 to 22,963.17] | +4,717.92 [4,717.89 to 4,720.45] (25.86%) |

    With reads and middleware, the paired generic increase net of the typed increase is
    2,588.43 [2,587.22 to 2,588.75] when legacy and 2,946.14 [2,946.05 to 2,948.67] when preferred.
    Neither patch starts a read, and the net increase does not isolate head copying.

    Stands on: measured (callgrind, release, `write_request_cost`,
    `what_a_write_answering_in_an_action_costs`, `what_a_page_with_layout_reads_costs` and the
    watchlist's `what_a_watch_costs`, the difference
    of 1,200 and 200 requests over 1,000, three alternating rounds of each build, every range within
    140 instructions but the watch's (up to 430); `what_a_writes_own_page_costs_in_time_and_bytes` for the time and bytes; the
    runtime's size by Node's `zlib`, once each build); reasoned (a patch carries elements by id, and
    a layout read's view at two places has none, so filling it needs a marker on every page; a
    write's own answer is not at an address a full load would draw; a handler takes the request, so
    the head its page's reads start from is copied before it runs, and only the answer type says
    beforehand that no page will come, and request extensions are not evidence that one dispatch
    is enclosed by another); value (the page shows the same values with JavaScript as
    without, Values 3; one answer brings a layout read up to date after a write, a page, Values 5;
    correctness before performance, the order of the values).

    Revisit when: an app needs a patch to change a layout read and cannot answer its page (a write
    whose page is too costly to draw again), which would reopen markers on the places; or a route
    can have the request's head back from its handler once it has answered (an extractor that hands
    it on), which would take the copy off an `HtmlResult` route's patch; or the paired
    `write_request_cost` controls show a repeatable increase beyond the measured ranges in the
    generic-only cost or in the cost of the late-write machinery. With `READS=1 MIDDLEWARE=1`,
    pair both preferred and legacy typed and generic patches with main. Both kinds of request
    can enter the late poller, and a generic route can keep the head for either. Compare the
    generic and typed deltas separately for each preference. Separate the capture, boxed
    continuation and drop by profiling, not by calling the generic-minus-typed gap a copy.
    Also revisit if the paired no-read patch or GET controls
    show a repeatable increase beyond the measured ranges, or apps cannot set a receiving app's
    deadline short enough to leave its slow places empty before the enclosing app times out.
    The 5,467-instruction threshold was historical: it compared the generic and typed patches in
    `what_a_write_answering_in_an_action_costs`, not a standalone head copy.

    Last checked: 2026-11-18, measured against main `4f1b085df` at `5a553e247` with the same
    `write_request_cost` fixture on both (release, all features, Rust 1.99.1, Callgrind 3.19.0 and
    jemalloc, three alternating 1,200-minus-200 pairs divided by 1,000). The fixture uses the
    checked action patch builder on both sides, with assertions outside the counted loop. Gzip
    by Node's `zlib`: core 15,612 to 16,108 bytes, upload 539 to 559. The paused-clock forwarding
    tests start the inner read once and verify that the outer app returns 503 when the inner app
    has no deadline, and returns 200 with a slow place empty when the inner deadline is shorter.
    Independent writes with copied extensions and replays of finished dispatches fill under
    their own deadlines. The 503 and concurrent copied-extension tests fail with the old
    inheritance code at `1fc806635`. An earlier check used release Callgrind 3.19.0 with jemalloc and
    Rust 1.99.1, `cc81e15bb` against `a6665d11a` before merging main, with the same `write_request_cost`
    fixture and three alternating 1,200-minus-200 pairs. No-read median instructions per request
    [range], before to after: document GET 19,174.47 [19,173.03 to 19,174.50] to 19,158.51
    [19,158.47 to 19,159.96], navigation GET 17,815.45 [17,815.41 to 17,815.45] to 17,803.41
    [17,803.41 to 17,804.88], direct typed patch 18,323.72 [18,323.72 to 18,323.77] to 18,311.68
    [18,310.29 to 18,311.72], and generic patch 18,647.72 [18,647.72 to 18,647.73] to 18,631.71
    [18,631.68 to 18,633.41]. Median paired savings [range] were 14.54 [14.52 to 16.00],
    12.00 [10.58 to 12.04], 12.04 [12.00 to 13.48] and 16.01 [14.32 to 16.06], respectively.
    With reads and pass-through middleware, the typed patch saved 83.01 [82.99 to 84.44]
    when legacy and 84.48 [83.04 to 84.57] when preferred. The generic patch saved 135.02
    [134.97 to 135.06] when legacy and 134.97 [134.96 to 135.04] when preferred.
    A write forwarded through a typed endpoint to another router returned a whole page with an
    empty cart header on `a6665d11a`. The receiving router now fills the header and starts its
    cart read exactly once, with and without a deadline.
    The previous check compared `251a1792c` against main `5599e451c`, with the same fixture and three
    alternating 1,200-minus-200 pairs. Median additional instructions per request without reads:
    document GET 122 (paired range 121 to 122), navigation GET 128 (128 to 128), direct typed
    patch 188 (186 to 188), generic patch 485 (485 to 485). Those medians are 19, 15, 16 and 20
    higher, respectively, than the prior check. With reads and no middleware the typed patch
    adds 197 (197 to 198), the generic patch 4,643 (4,643 to 4,643), and the own page 13,972
    (13,972 to 13,972), drawing a document instead of a fragment. With reads and pass-through
    middleware, the typed patch adds 1,533 (1,532 to 1,533) when legacy and 1,620 (1,620 to 1,620)
    when preferred. The generic patch adds 4,191 (4,189 to 4,191) when legacy and 4,633
    (4,633 to 4,633) when preferred. The paired generic delta net of the typed delta is 2,657
    (2,656 to 2,659) when legacy and 3,012 (3,012 to 3,012) when preferred. Neither isolates
    the copy. Neither patch starts a read, and the typed patch still skips the head copy.
    Both the generic and typed-patch regressions return a whole page with unfilled layout reads on
    `41f6ae507` when middleware replaces the patch with a page from a retained request head.
    On `251a1792c` the replacement fills its layout and starts exactly one read in each case;
    2026-11-18, release Callgrind 3.19.0 with jemalloc, `7d8253ceb` against
    main `70dd920cc`, with the same `write_request_cost` fixture and three alternating
    1,200-minus-200 pairs. Median additional instructions per request without reads: document
    GET 103 (range 103 to 103), navigation GET 113 (113 to 113), direct typed patch 172
    (172 to 172), generic patch 465 (465 to 465). Each delta moved by one instruction from the
    previous check. With reads and no middleware the typed patch adds 179 (178 to 180), the
    generic patch 4,367 (4,367 to 4,367), and the own page 13,696 (13,694 to 13,696), drawing a
    document instead of a fragment. With reads and pass-through middleware, the typed patch
    adds 1,359 (1,359 to 1,359) when legacy and 1,446 (1,446 to 1,447) when preferred. The generic
    patch adds 3,913 (3,912 to 3,913) when legacy and 4,357 (4,357 to 4,357) when preferred. The
    paired generic delta net of the typed delta is 2,553 (2,552 to 2,554) when legacy and 2,910
    (2,910 to 2,910) when preferred. Neither isolates the copy. The legacy generic patch now
    pays for head retention in case its handler overrides the mode, but starts no read. The
    typed patch still skips the capture. Core gzip remains 15,612 to 16,108 bytes and upload
    gzip 539 to 559;
    2026-11-18, `010f04f23` against
    main `70dd920cc`. Using the same `write_request_cost` fixture on both builds, three alternating
    1,200-minus-200 pairs measured these median additional instructions per request without reads:
    document GET 102 (range 102 to 104), navigation GET 112 (112 to 113), direct typed patch
    173 (173 to 173), generic patch 466 (466 to 466). These are 6 to 14 more than the preceding
    check's deltas. They do not measure named-route dispatch in isolation. With reads and no
    middleware the typed patch adds 180 (180 to 180), the generic patch 4,374 (4,374 to 4,374),
    and the own page 13,703 (13,703 to 13,703), drawing a document instead of a fragment.
    With reads and pass-through middleware, both legacy and preferred writes can enter late
    staging at that revision, but only the preferred generic patch retains the head. The typed
    patch adds 1,778 (1,777 to 1,778) when legacy and 1,967 (1,966 to 1,967)
    when preferred. The preferred-minus-legacy difference, net of main, is 189 (189 to 189)
    for typed patches and another 2,905 (2,905 to 2,907) for the generic-only path. Neither
    patch starts a read. Core gzip remains 15,612 to 16,108 bytes and upload gzip 539 to 559;
    2026-11-18, `7adced7ed` against main `9de7529fc`, using the same method and fixture: the
    no-read deltas were 96 (95 to 96) for document GET, 102 (102 to 102) for navigation GET,
    159 (159 to 159) for typed patch and 454 (454 to 454) for generic patch. In that version
    the preferred versus legacy controls measured 1,086 (1,086 to 1,088) for the late-write
    path and 2,905 (2,904 to 2,905) more for the generic-only path. One profile of the generic
    patch without middleware counted 1,512 in the inclusive capture. Core gzip measured 15,612 to
    16,108 bytes, upload gzip 539 to 559. The watchlist smoke covers named form controls in
    the frame fallback and both cut and completed 503 bodies after another write draws;
    2026-11-18, release Callgrind 3.19.0 with jemalloc, `e80694ef7` against merged
    main `9de7529fc`, using the same earlier `write_request_cost` fixture on both. Three alternating
    1,200-minus-200 runs, with assertions outside the counted loop. Median instructions per
    request, main to head: without reads, document GET 19,022 to 19,121, nav GET 17,651 to 17,757,
    typed patch 18,101 to 18,547 and generic patch 18,128 to 18,579. With reads configured, typed
    patch 18,175 to 19,274 and generic patch 18,202 to 22,194. Preferred versus legacy typed patches,
    net of the same comparison on main, measured 537 additional instructions for negotiation,
    the late mark and cleanup, the deadline extension and the pending-page check at that head.
    The equivalent generic comparison adds 2,888 instructions beyond that then-shared path,
    including 1,512 in the inclusive `at_late_route` capture. The remainder includes the captured
    head's cleanup and its boxed route continuation. Core gzip 15,612 to 16,079 bytes, upload gzip
    539 to 559;
    2026-11-17, callgrind (valgrind 3.19.0) on `32ea2c896` against `ef35919bb`
    (the early heads let go against leaked; `main` at `76b5126b7` merged), three alternating rounds,
    the middleware case's own instructions per function compared by `callgrind_annotate`, the
    runtime's size against `27c29d7d2` by Node's `zlib` (the head merges it), the on-demand record
    built by the runtime's settings on that merge, a module's cold import timed by Playwright, and the watchlist's own-page
    checks in three engines (the own page drawn over a patch, the body cut off after its headers and
    the read again after a whole own page failing with `6790fa5da`'s runtime);
    2026-11-16, callgrind (valgrind 3.19.0) on `70031a793` against `main` at
    `1c72b037` with the harness tests added and `bb7562d9d` as a third build, three alternating
    rounds each, the whole document's own instructions per function compared by `callgrind_annotate`,
    and the runtime's size against `dbe1a34c7` by Node's `zlib` (the head merges `main` at
    `30bed57ed`, `2b33cd568` and then `dbe1a34c7` after `70031a793`; those merges are not
    measured by callgrind); 2026-11-15, callgrind on `70b69a3db`
    against `main` at `83a9c9fbd` with the harness tests added, and `914f4781e` with and without the whole `Prefer`
    line compared first against `17f285075` (the round before, `5d0bf7599` merged), three
    alternating rounds each, the time and bytes in release on `70b69a3db` (three runs of 25), the
    watchlist's bytes on `70b69a3db`, and the runtime's size against `83a9c9fbd` by Node's `zlib`;
    2026-11-15, callgrind on `e2c5cec0c` against `ef7570f63`, and the fill's box past the handler
    measured as a third build (earlier rounds: `04000147b` against `02ac51d9e`, `e59c32c28` against `934c94367`,
    `e760a5385` and `de46e974b` against the change as it was, `0d2d818cd` with the harness);
    2026-11-15, a patch answered before a navigation left it drawn by that page, and an upload's
    headers, by the watchlist smoke on `70b69a3db`, each failing with the runtime of `17f285075` in
    Chromium; 2026-11-15, a write without the preference answered `<main>` and drawn with no failure, and a
    navigation that leaves a patch before it is drawn, by the watchlist smoke, each failing with the
    runtime of `e2c5cec0c` in Chromium; 2026-11-15, a write that failed in view by the watchlist smoke
    in Chromium and Firefox, failing on `fba53d131` in Chromium; 2026-11-14, the writes a layout draws
    in either order and a write cut off before its answer by the watchlist smoke in Chromium and
    Firefox (WebKit, without the Navigation API, skips them) on `04000147b`, each failing on
    `3eeba8d8d` in Chromium, and a middleware's page filled under the deadline and before the error
    page by the crate's tests on `04000147b`, failing without it.
67. <a id="choice-exhaustive-failure"></a>**Failure stays exhaustive.** An app's error page
    names every variant, so adding one stops the app from compiling until it decides how to
    present the new failure and its status. This is a breaking API change, even when all the
    app needs is one more name in an existing arm. Marking `Failure` as `#[non_exhaustive]`
    would require a catch-all instead: when the router gained `UnknownMethod` (501), the
    app could have silently drawn it with a page meant for an internal error (500). Corten
    sends the failure's status either way. An app that wants Corten's wording can group named
    variants in one arm and use `failure.default_text()` without giving up the compile error.

    Stands on: reasoned (an exhaustive match without a catch-all has to name a new variant,
    and the router's 501 is distinct from an app's own error
    ([Choice 25](#choice-axum-router))); value (correctness before developer convenience,
    with the compiler pointing out the app's missing decision).

    Revisit when: Corten reaches 1.0 and commits to semver for page types, or apps report that
    the repeated breaks outweigh the signal.

    Last checked: 2026-11-18, `Failure`, its status and the template's exhaustive error page
    read at `54f7ca9d`, with the repin that needed a new arm recorded in
    [#1397 Each new Failure variant breaks every app whose error page matches Failure without a `_` arm: decide whether Failure is `#[non_exhaustive]`](https://github.com/corten-run/corten/issues/1397).

68. <a id="choice-profile-build"></a>**A profile-guided release is an option of `corten build`, which runs
    the app while a command the app names sends it requests.** `corten build --profile-from
    <command>` runs the toolchain's four steps: an instrumented build, that copy of the app at
    work, `llvm-profdata merge`, and the release build with the merged profile
    ([deploying](guide/deploy.md#a-profile-guided-build)). `corten build` alone is the build it
    was. The command is the app's because what it sends decides the gain, and it does nothing
    but send: `corten build` starts the copy on a free port it gives the command in `PORT`,
    waits for it to listen, and stops it with `SIGTERM` when the command ends, so that the copy
    writes its profile. The copy is started without `HOST`, so it listens on this machine
    only, where the build and the command look for it. Starting, waiting and stopping are where a script goes wrong without a
    word (a copy killed, not waited for, or left running writes no profile or a stale one), so
    they are in the command once and not in each app's script. The instrumented copy has a
    target directory of its own, so `target/release` never holds a binary that writes a
    profile, and a step that fails leaves the last release standing. What can be told is wrong
    without building is refused before the first build: a toolchain without `llvm-profdata`, a
    system that cannot ask the copy to stop, a command that is not there, another profiled
    build in the same target directory, and a Cargo configuration that may set flags the profile's flag, which has to
    go in the environment, would replace. A command that fails,
    a copy that exits early or does not listen, a profile not written, and a package that
    builds two binaries each stop the build after the copy and before the release.
    Cargo arguments come from a closed list given before `--profile-from` (`--features`,
    `--all-features`, `--no-default-features`, `--locked`, `--package`, `--bin`), passed in
    the same order to both builds, so the profile is of the binary the release is, and a
    misspelled one is refused rather than built past; an argument that moves the release from
    Cargo's default `target/release` (`--target`, `--target-dir`, `--profile`) is refused, since
    the copy has to run where it is built to be profiled. Cargo's configuration is not checked
    for them: a target set there is Cargo's to apply, and the copy it builds has to run on the
    machine that builds it.
    The standard library the `corten` command is held to can kill a child but not ask it to
    stop, so the command has the shell send `SIGTERM`, and the option is Unix only: Windows
    has no command that sends another process a Ctrl-C.
    Not chosen: the steps left to the guide, which each app then copies with their traps (the
    profiles the build's own macros write, a profile left from an earlier run, the
    configuration's flags dropped, the copy killed); a command that starts and stops the copy
    itself, which moves the same traps into every app's script; the four steps written into the
    starter's Dockerfile behind a build argument, which gives a build outside the image nothing
    and has the traps over again in a Dockerfile (the image's build runs this command instead,
    [Choice 69](#choice-profile-image)); a profile by default, since a build cannot know
    an app's requests and the second build and the run are minutes; reading Cargo's
    configuration as Cargo does to keep its flags, which takes a TOML parser the command does
    not have; an `llvm-profdata` found on the `PATH`, which may read another LLVM's format;
    and every argument after a `--` passed to Cargo, which lets one that moves the binary or
    its messages through to steps that read both.

    Stands on: measured (the catalog app built by the option took 30,730 fewer cycles a request
    than its ordinary build on the catalog page at the median of 10 alternated rounds, 21% of
    the ordinary build's 143,443, lower in all 10, and 32,516 fewer where it compressed each
    answer, 14% of 230,402, lower in 8 of 10, from a command of 3,000 requests; ten earlier
    rounds of each on a busier machine gave 29% and 18%; one profiled build from an empty
    target directory took about eleven minutes against about four for one ordinary build);
    platform (rustc's `-Cprofile-generate` and `-Cprofile-use` and the `llvm-tools`
    component's `llvm-profdata`; Cargo reads rustflags from the environment or from its
    configuration and never both, and builds a crate again, one from the registry included,
    when the file `-Cprofile-use` names is replaced; a process that returns from `main` or
    calls `exit` writes its profile and one that a signal ends does not); reasoned (a
    separate target directory is the only place an instrumented build cannot be mistaken for
    the release; a refusal before the first build costs nothing, where a dropped linker flag
    or a missing tool found after it costs a build); bet (an app has, or will write, a command
    that reaches the routes its readers do, which the build cannot check: a command that sent
    the copy nothing leaves a profile of the app starting and stopping; and the app listens on
    `PORT` as `corten dev` already asks of it); value (fast and proven fast, with mistakes
    failing early and one way to build a release, and the option kept off every app that does
    not ask for it, README Values).

    Revisit when: Cargo can add a flag to the ones its configuration sets, or builds with a
    profile itself, so the refusal or the steps go; the standard library can ask a child
    process to stop, or an app on Windows needs the option; an app's release needs a Cargo
    argument not on the list (a cross build, a custom profile); or an app measures a profile from its own command
    gaining nothing over the ordinary build.

    Last checked: 2026-11-19, the rounds above at `b032155e2` (the earlier ones on the sources
    of `70544a54a`) with rustc and Cargo 1.99.1 in `rust:1-bookworm`, the catalog app
    (`bench/catalog/corten`) with its default features on one CPU under `wrk` with 64
    connections; 2026-11-19, Cargo 1.99.1: a build given `-Cprofile-use` compiled a registry
    crate again after the file at the same path was replaced, an ordinary build after a
    profiled one compiled nothing and put the binary without the profile back in
    `target/release`, an empty `RUSTFLAGS` left the configuration's flags out, and a file
    named by `include` had its `rustflags` read; 2026-11-19, rustc 1.99.1: an instrumented
    server ended by `SIGTERM`'s default action left no profile file, and the same server
    leaving through `exit` on that signal left one; 2026-11-20, the list of Cargo arguments
    ([#1731 corten build --profile-from passes no Cargo arguments, so an app whose release needs features, a package, a target or the lock cannot use it: decide what corten build passes on](https://github.com/corten-run/corten/issues/1731)),
    a profiled build of a two-binary package given `--no-default-features --features=given -p
    --locked --bin` and an empty `-F` on Cargo 1.100.0, selecting a workspace member that is not
    the default one: each build was given exactly them, as written and in order (a `cargo` on
    the `PATH` recorded each argument), and the test fails when the release build is not.

69. <a id="choice-profile-image"></a>**The starter's image is built with a profile when its build is given the
    app's script, by the same command.** `docker build --build-arg PROFILE_FROM=train.sh` has
    the Dockerfile `corten new` writes run `corten build --locked --profile-from sh -- train.sh`
    where it runs `cargo build --release --locked`
    ([deploying](guide/deploy.md#a-profile-in-the-image)). So an app deployed the documented way
    can have what [Choice 68](#choice-profile-build) measured, by the one command that builds a
    profiled release, and the binary is built and profiled on the system the image is built
    for. Without the argument the build runs what it ran and fetches nothing: the `RUN` that
    adds `llvm-tools` and installs the `corten` command does nothing. The argument is the
    script's path, not a command line, so the Dockerfile quotes it once, after a `--`, and the
    shell splits nothing; a path that is no file fails the build before the app is built. The
    command installed is the release with the number of the `corten` that wrote the
    Dockerfile, as the app's manifest names the library's, built from source with its lock. It
    goes under `/usr/local`, into the layer: cargo's home in this build is a cache mount, which
    is no part of a layer, so a later build that reused the layer where the cache was gone
    would have no command, and apps on one builder would write over each other's. It is
    installed before the sources are copied in, so a builder that has kept the layer does not
    install it again after a change to the app. A release without the option is refused in
    that `RUN`: 0.2.0's `corten build` took no arguments, so it would build the ordinary
    binary and the image would have no profile and no word of it; and a `corten` built from a
    commit between releases writes the number of the release before it. The cost is that the
    image's build runs the app: the copy has to start in a build, which has no other container
    beside it, so an app that needs a database as it starts cannot use the argument, and every
    build with the argument compiles each crate again for the new profile.
    Not chosen: a profile in every image build, since a build cannot know the app's requests,
    an app that needs a service would not build at all, and every build would pay the time; the
    argument as a whole command line, which the shell would split; a script that `corten new`
    writes into every app, which would still ask for the starter's one page when the app has
    others, and a profile that barely reached an app's routes gained about half as much
    ([Choice 68](#choice-profile-build)); the command's version read from `Cargo.lock` during
    the build, which is a parser written in shell and has no release to install for an app on a
    git revision; the command installed from the commit that built the `corten` that wrote
    the Dockerfile, which is exact between releases too and clones the repository in every
    build that has not kept the layer; a second Dockerfile, or a stage, that copies in a binary
    built where the app's services are, since the builder's system then has to match the
    image's and a mismatch fails when the container starts, not when the image is built; and a
    profile file taken elsewhere and handed to the image's build, which goes stale without a
    word when the app's code or the compiler moves.

    Stands on: measured (the app `corten new` writes, its two binaries built in `rust:1-trixie`
    by the Dockerfile's two commands and run on `debian:trixie-slim` with the image's jemalloc
    settings: the profiled one took 41,922 fewer cycles a request on the home page at the
    median of 10 alternated rounds, 32% of the ordinary build's 130,903, and 40,193 fewer where
    each answer is compressed, 22% of 183,102, lower in all 10 rounds of each, from a script of
    500 requests; its image built in 188 seconds with the argument against 69 without, one
    build each, and in 121 after a change to one file); platform (a `RUN` has a loopback
    interface, so a server and its client run in one; a build argument declared before a
    `RUN` that reads it is part of that layer's cache key; a cache mount is not part of the
    layer its `RUN` makes; a build has no service container beside it); reasoned (the same
    command inside the image and outside it is one way to build a profiled release; a path
    quoted once after `--` is neither split nor read as an option); bet (an app that deploys
    from this Dockerfile and wants the gain can start with nothing beside it; and the release
    that carries this Dockerfile installs from crates.io as 0.2.0 did here); value (fast and
    proven fast for the documented deploy, with the ordinary build kept as the default and the
    profile one argument away, and a build that cannot take a profile failing rather than
    passing without one, README Values).

    Revisit when: a build can run a service beside it, so the argument can cover an app with a
    database; a release's `corten` command cannot be built in the build stage; a workflow
    builds the starter's image, so these lines are checked on every change and not by hand; or
    apps keep a script from the day they are written, so the starter could carry one.

    Last checked: 2026-11-20, the rounds above at `9fae8ff55` with rustc 1.100.0, the app on
    one CPU under `wrk` with 64 connections; 2026-11-20, the Dockerfile `corten new` writes at
    this change, built with Docker 29.9.3 and the guide's script. As written, its first `RUN`
    installed corten-cli 0.2.0 from crates.io and refused it, naming the release, before the
    sources were copied in. With that one line pointed at this checkout (no release has the
    option yet): without the argument the first `RUN` did nothing. A path that is no file
    failed after the install and before the app's build, naming the path. The script's path
    ran the copy in the build, and the image's server answered its page as user 10001. After
    a change to one of the app's files the first `RUN` was reused from the builder's layers
    and only the build ran. The build argument's two values in these runs each ran the
    first `RUN` anew.

70. <a id="choice-kept-pages"></a>**The app keeps its own `Public` pages, where the handler
    stands.** A page whose route says its answer is the same for everyone told every shared
    cache to keep it, and the app kept none: each request without credentials ran the handler,
    the render, the tag's hash and the compression again. The whole document a `Public` page's
    handler made for a `GET` that shows nothing about who asks is now kept for its shared
    lifetime (`s-maxage`, else `max-age`, RFC 9111 section 4.2.1) and given to the next such
    request with an `Age` ([caching](guide/app.md#the-pages-the-app-keeps),
    `crates/corten/src/kept.rs`). The hash of its body and its bytes in each coding are made
    once and stay with it, so the tag and the compression after the handler cost a kept page a
    lookup. It is on unless the app says otherwise, holds at most 32 MiB
    (`App::kept_answers`), and is off under `corten dev`.

    It stands at the handler's place, not in front of the app. What makes a kept answer safe to
    give to anyone is the rule checked when the app compiles, that a `Public` handler takes only
    inputs that cannot tell who asks, and that rule covers the handler alone. A middleware may
    refuse a request (a rate limit, an allow-list, a maintenance switch), send it elsewhere or
    stamp its answer, and a store in front of it would pass each of those by for a kept page and
    replay one request's headers to the next. Here every stage runs for every request: the
    middleware meets it and sees the `200` with the whole body, as
    [the request path](guide/app.md#your-own-middleware) says it does, and the security headers,
    `Cache-Control`, the tag and the compression treat a kept page as the handler's answer, so no
    rule about what may be shared is written twice. Only a route typed `Public` whose answer is
    a page asks the store at all, which is known when the route is made, so no other route's
    `GET` pays for it; a write pays a hash of its path and a count.

    "Cannot tell who asks" is less than a key needs: an extractor of the app's own may be
    `Anonymous` and read the browser's `User-Agent` or a country header a proxy set. So a page
    is kept only when each input of its handler is one of Corten's own whose reading of a page's
    request is known (`Params`, `Form`, `State`, `Req`, `Signal`, `Method`, `Uri`), which is
    also known when the route is made (`Anonymous::KEYED`, whose type an app cannot name, so
    an extractor of the app's own cannot claim it); a page whose handler takes another is made
    for every request. What those inputs read of the whole document's `GET` is the key:
    the `Host`, the path and the query, and the `Accept-Language` when the page's `Vary` names
    it or a message was read in the language it asks for. The header is compared as it was
    sent, as a CDN compares it ([Choice 22](#choice-locale-in-url)), with at most eight copies
    for a URL, a new one in the place of one not read since it was kept or since room was last
    made. The request must be at the URL the router matched (a route's parameters are read
    from the path as it was matched), with no cookie but the time zone's, no `Authorization`, no
    caller read by a middleware and no body. The answer must be a `200` of a known size with a
    lifetime that sets no cookie, drew neither the request's nonce nor a value made for this
    request, varies on nothing else, and carries exactly the marks a page is known to carry: one
    added later that this code does not know is not replayed by mistake, the page is simply not
    kept. A `Date` the handler set is left out of what is kept, so each answer given in its place
    is dated when it is sent, and its `Age` counts from the handler's date as a cache counts one
    (RFC 9111, 4.2.3, the apparent age less the time the answer took): a cache after the app then
    finds the page as old whichever answer it is given. A page that date makes older than its
    lifetime, or whose date is not in IMF-fixdate form, the form HTTP sends, is not kept. A page is
    put in the store only while no write to its path has been counted since its handler read,
    seen under the store's lock, so one read before a write and kept late never takes the place of
    one read after it.

    A write drops what is kept at its path, whatever the query, since a named post is
    `?do=name` at its page's path, whatever it is answered. That is wider than RFC 9111
    section 4.4 asks (a write that did not fail): a handler that answered `4xx` or `5xx`,
    passed its deadline (a `503`, or a `408` while it waited for the body) or lost its client
    may have written first, and its status does not say; work that outlives its request
    (`Signal::finish`) counts again when it ends. The router's own `405` and `501` count as
    well: a middleware met the request first and may have taken the write itself, and leaving
    them out by a mark the router set was tried and left a page stale in that case. The price is
    that any client can have a kept page made again: one write to a path drops every copy kept
    there (each query, host and language), and each is made again by the next request for it.
    Each costs what the page cost before the app kept pages and the copy into the store. Only
    a write that does not reach the app's middleware is not counted: one another site sent, one
    for a host the app does not answer, or one a layer in front (`App::layer`) answered
    itself. A write that went through also drops the place on
    the site its `Location` or `Content-Location` names. A write is counted when it is answered or dropped, so one whose
    effect lands later (a task the handler did not wait for, a store whose readers lag) can
    leave a page as it was for its lifetime, which the lifetime allows and the guide says.
    Writes are counted by a hash of the path with its escapes decoded, and a kept page stands
    only while the count is the one its request found before its handler ran: a write takes no
    lock and searches nothing, and a page whose handler was reading while the write went
    through is not kept. There are 65,536 counts (256 KiB, made when the first page is asked
    for, so an app with no `Public` page holds none), and a write to another path drops a
    given kept page early once in 65,536 times, which costs that page a render. Nothing else
    drops a page before its lifetime ends: not a change made by a task
    or another instance, a purge at a CDN in front (which is given the kept page again with
    its `Age`), or a request's `Cache-Control: no-cache`. How long a page stands is the app's
    to say, and a reload is not a reason to render it.

    Requests that miss a page together run its handler once: the first makes the page, and the
    others asking for the same copy wait for it and are given the page when it is kept for them.
    They meet in a table of their own, by a hash of the URL, the `Host` and the `Accept-Language`
    as sent and the count of writes to the path the request found, under a lock taken for no
    wait. The table holds no page, so a slow handler keeps nothing alive outside the bound,
    keeping one copy of a URL does not end the wait for another, and a request after a write
    makes the page again rather than wait for one read before it. Two copies whose hashes meet are
    made one after the other, since each request looks its own copy up once it has waited. A
    request looks for a kept copy again once it holds or has joined the page being made, so one
    kept between its first look and then (the first request's, or one made for every language by
    another) is given at once rather than made again or waited for. A request given a kept page
    does what it did before; one that misses takes the table's lock when it starts and when it
    ends, and looks in the store twice. The language is keyed as sent whatever the page varies on,
    since that is known only from its answer: a request waits for no page in another language,
    and a page the same in every language is made once for each `Accept-Language` sent while it
    is made. When the first request's page is not kept (an error, a page drawn for that request),
    the others run their own handlers then, and the page is remembered as not kept for a minute,
    until a write to its path, or until a request that made it alone keeps it, so requests for a
    page never kept wait for each other about once a minute. That is best effort: the table
    remembers the latest 1,024 such pages and forgets the one remembered first, so with more than
    that in a minute a page may be waited for again sooner. At most 1,024 pages are made at once
    that others wait for; past that, a request makes its page as it would with nothing kept. So
    the table holds at most 2,048 entries and 1,024 remembered times, about 130 KB at most beside
    the bound by their sizes, and a request that ends does a lookup and forgets at most one page
    beside those whose time is up. When that request is dropped (its client left, its deadline
    passed) or panics, the wait ends with it and they run their own, with nothing remembered. A
    request that waited and was not given a page runs its own handler and does not wait again,
    even where a write has meanwhile started another request making the page: in a burst of
    writes such requests may each read the source, which bounds every request to one wait. A
    request's own deadline drops its wait as it would its handler. The first requests after a
    start wait as the others do, so a deploy does not send a slow source a request for each
    visitor who comes while each page is first made.

    Not chosen: in front of the middleware, for the reasons above, though it would save the
    stages too; leaving out a write by its status (a `4xx`, a `501`) or by a mark the router
    set on the ones it refuses, each of which left a page stale in a case a review found; off unless asked for, which leaves the cost on every app that already said its
    pages are public; a page for one visitor kept by caller, where a mistake in the key shows
    one user's page to another ([architecture](architecture.md#what-belongs-in-the-framework));
    honoring a request's `no-cache`; removing a written path's pages by a search of the store or
    a second index by path, which a write would pay for under the store's lock; a sweep that
    removes pages as their lifetimes end, since a page that no longer stands is replaced when it
    is next asked for and goes when room is made; waiting only where a copy that no longer stands
    is kept, with the wait held by that copy, which left the first requests after every start to
    each run the handler, and which a review found let a request after a write wait for a page
    read before it and the keeping of one language's copy end another's wait; admitting requests
    by what the old copy varied on, which has a request wait for a page in another language once
    a page begins to vary; giving
    a waiting request the first one's page when it was not kept, which may be that request's
    alone (a nonce, a cookie); a waiting request taking the first one's place when it is dropped,
    so the others would wait in turn on each handler that fails; forgetting pages not kept by a
    pass over the table, which a review found made each end look at every page being made once
    more than 1,024 were (81,774 places looked at as 1,100 such pages ended, by the test that now
    holds it to one each); no memory of pages not kept, which would cost each wave of requests for
    a page never kept one handler's time of waiting (31 of 64 requests past the deadline in every
    round of the wave below, against 28 with it) to save about 130 KB at most and no instruction
    on a measured path; leaving a handler's `Date` out with nothing for its age, with which a cache
    after the app counted the first answer older than each given in its place, and not keeping a
    page that sets a `Date` at all, which loses the page for an input HTTP gives a meaning to; and,
    left for changes of their own, a call
    that drops a page for a change no write to its path made, a way for an extractor of the
    app's own to say it reads only the URL, `Public` text, JSON and files
    (their handlers take other inputs, which a key would have to cover), a page served stale
    while it is made again, and one copy for each
    locale rather than for each `Accept-Language` sent.

    Stands on: measured (the catalog benchmark's app with its page marked `Public` for a minute,
    `44323327e` on this change's `f7e53a594` against `60a77b231` on main's `6045710b0`, each
    answer's bytes compared first: a kept page took 104,129 cycles a request against 123,879 where
    nothing is compressed and 110,889 against 202,439 where each answer is, at the medians of 12
    alternated rounds; within a round that is 14.5% fewer at the median uncompressed, from 3.3% to
    21.0%, and 46.3% fewer compressed, from 30.9% to 61.3%, lower in all 12 rounds of each, with
    12.7% and 43.2% the one-sided 95% bounds on the median; user-mode instructions fell 35.5% and
    81.0%. The same rounds at `88e9d012b`, before a kept page's bytes were copied to their own size,
    had 4.0% fewer cycles uncompressed, bound 2.0%, and 41.7% fewer compressed, bound 38.8%. A page
    for one visitor, which asks the store nothing, was not told from main's: its cycles changed by
    0.0% and -0.6% at the median with bounds of +4.4% and +2.1%, its instructions by +0.4% and +0.1%
    with bounds of +1.5% and +0.3%. A `Public` page asked for with a session cookie, which is never
    kept, took 2.1% more instructions at the median of 8 rounds, bound 3.4%, and its cycles were not
    told from main's, -2.6% with a bound of +7.2%. Reading the rest of such a request's headers in
    one pass, where each had been looked up by its name, and copying the kept page's head with room
    for what the stages add (`a383ca3d8` against `13b1252a9`, the change and main with the
    catalog benchmark's page marked `Public`, by callgrind's count for 1,300 requests less its
    count for 300): a kept page asked for with the fifteen headers a browser sends ran 44,221
    instructions against 45,170 and missed the simulated first-level instruction cache 1,878 times
    against 1,925, one asked for with curl's three ran 28,221 against 28,943, a page made and kept
    95,178 against 95,791, a page asked for with a session cookie 81,011 against 81,006, a
    navigation inside the app 79,970 against 79,976 and a data client's request 82,173 against
    82,324; under load a kept page's cycles changed by -0.6% at the median of 140 pairs of turns,
    with a one-sided 95% bound of +0.4%, and its user cycles by -1.2% with a bound of -0.3%. 3,000
    kept pages of 4,488 bytes with their zstd
    form took 7,260 bytes each of resident memory with glibc's allocator and 8,107 with jemalloc;
    under a 32 MiB bound and three passes over 40,000 URLs the process settled 57.8 MiB above where
    it began with glibc's and 35.2 MiB above with jemalloc, so what an allocator holds beyond the
    bytes asked of it is beside the bound; `tests/kept_memory.rs` holds the bytes asked to the
    bound, 4,177,233 of 4,194,304 for its page in every coding and 4,050,606 with no compression.
    Requests that miss together (`200f08426` against `fc86d8eff`, `tests/kept_cost.rs` under
    callgrind, its count for 1,200 requests less its count for 200, in 5 rounds that alternated
    the two builds, each answer's status, `Age` and body checked and the last page made asked
    for again and given kept): a kept page given again ran 19,226 instructions against 19,234 at
    the median, a page made and kept at a URL not asked for before 35,810 against 34,821 (2.8%
    more), a write and the page made again 46,053 against 45,361 (1.5% more), and a page for one
    visitor, whose route keeps nothing, 18,270 against 18,355, each build's rounds within 12
    instructions of each other. Of a miss's added cost, by callgrind's inclusive counts over the
    1,200 requests, the store's second look took about 300 instructions a request for a new URL
    and 420 after a write, and the table's keyed hash 320 to 340. Timed (`tests/kept_wave.rs`, 64
    requests sent at once for a page whose handler reads a source that answers 4 reads at a time
    in 50 ms each, under a 500 ms deadline, the same two builds in 2 passes of 5 rounds each, the
    order of the builds turned about between the passes, the medians of the 10 rounds): where a
    write had dropped the copy, the handler ran once where it had run 64 times, and all 64
    requests were answered, the slowest in 52.0 ms (from 51.0 to 52.1 over the rounds), where 28
    had passed their deadline in every round and the 36 answered took 256.5 ms at the median and
    461.9 ms at the slowest; the first requests after a start the same, the slowest in 51.9 ms
    (50.9 to 58.8), where 28 had failed; for a page never kept, the first wave lost 31 to the
    deadline in every round where 28 had been lost, as its requests waited 50 ms for the first
    one's page before running their own, and the second, the page remembered as not kept, 28 as
    before. Under load (below, one URL asked for, `c9c11bfda` against `fc86d8eff`, not taken
    again for the second look, which a kept page does not reach), a kept page's
    cycles changed by +0.1% at the median of 140 pairs of turns, with a one-sided 95% bound of
    +0.6%, its user cycles by -0.4% with a bound of +0.2%, and its user instructions by -0.1% with
    a bound of +0.5%, which meets the margin set before the rounds, cycles not worse with the bound
    under +1%; the first 40 pairs alone did not (+0.4%, bound +1.7%), so 100 more were run the
    same way and all 140 are counted. The host was not quiet: the workstation's other work kept
    its CPUs 95 to 100% busy, and one pair's change ranged from -7.7% to +16.1%.
    Not measured: what a write pays for its count; a miss that is kept against the same page
    made with nothing kept; a store read from more than one core; the cycles of a miss, and
    requests that miss together on a quiet host or with a real source; and the
    tables that index the pages, which do not shrink when pages go, 8 bytes a slot and a map entry a
    URL, about 3 MB at most beside a 32 MiB bound by their sizes); platform (a shared cache may keep
    an answer for `s-maxage` and else `max-age`, sends its `Age`, and invalidates the target and the
    `Location` of a write that did not fail: RFC 9111 sections 4.2.1, 5.1 and 4.4; a recipient
    counts an answer's lifetime less its `Age`, section 4.2.3; the connection is HTTP/1.1, so a
    request's target is its path and query and its host is the `Host` header,
    [Limit 14](#limit-http1)); reasoned (the inputs a kept page's handler may take read, of a whole
    document's `GET` without credentials, its URL, its `Host` and, for its language,
    `Accept-Language`, which is the key; the stages after the handler read the request and the
    answer and nothing the handler held, so they treat a kept answer as its own); bet (an app that
    marks a page `Public` means the lifetime it wrote also with no CDN in front, and does in its
    handler nothing that must happen for every request); value (fast and proven fast; standards
    first, the app being a shared cache as RFC 9111 describes one; mistakes fail at compile time,
    what may be kept being known from the route's types; good defaults, easy overrides, with one
    setting for the bound, README Values).

    Revisit when: apps report pages shown past what they meant, so the default should be off
    or the lifetime the app's to set apart from `s-maxage`; an app must drop a page for a
    change made by a task, another instance or a purge; the stages around the handler
    become most of a kept page's cost on a measured app, so a place further out is worth its
    rules; a multi-core measurement shows requests waiting on the store's lock; writes no
    handler takes (a scanner's `POST /`) make kept pages again often enough to show, so the
    router's own refusals are worth leaving out where the request met no middleware; requests for
    pages not kept are shown to wait for each other often enough to matter, or requests in many
    languages for a page the same in all of them to load its source; an app is shown to make more
    than 1,024 pages at once, or to forget pages not kept within their minute; or the connection
    speaks HTTP/2, where a request's target carries its authority.

    Last checked: 2026-11-21, the second look and the table's bounds with rustc 1.100.0, release
    builds of `200f08426` and `fc86d8eff` counted by valgrind 3.24.0's callgrind and the waves
    timed on a workstation's Docker VM with 4 worker threads and 4 CPUs. 2026-11-21, requests
    that miss together with rustc 1.99.1, release builds
    counted by valgrind 3.24.0's callgrind, the waves timed on a workstation's Docker VM with 4
    worker threads, and the cycles of a kept page from the two builds started once on one of the
    VM's CPUs, its sibling left idle, and loaded in turn for three seconds each by `wrk` with 64
    connections on another core's two, the order turned about from each pair to the next, the
    app's counters read by `perf stat` at 100% and divided by the requests `wrk` saw answered,
    the bodies identical and the headers but `Date` and `Age`. 2026-11-21, the pass over the
    headers with rustc 1.100.0: the counts under
    callgrind, and the cycles from the two builds started once on one CPU, its core's other thread
    left idle, and loaded in turn for three seconds each by `wrk` with 64 connections on the two
    CPUs of another core, 500 URLs asked for unevenly and uncompressed, the order of the two
    turned about from each pair to the next, the app's cycles counted by `perf stat` and divided
    by the requests answered. 2026-11-20, the other rounds above with rustc 1.99.1, the app on one
    CPU under `wrk` with 64 connections on three others, one of them the other thread of the
    app's core, 500 URLs asked for unevenly, the app's cycles and instructions counted by
    `perf stat` and divided by the requests answered. The bodies of the two builds' answers were
    identical in each coding, and the headers differed by the kept page's `Age` and, where
    compressed, the tag. The commits after `f7e53a594` up to `24e61b4b0` change which writes count
    and nothing a page's `GET` runs. `tests/kept_memory.rs` at this change, with all features and
    with none.

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
   the browser for want of an id; what the browser's parse of a patch's top level loses is
   [Limit 2](#limit-whole-element-patches).
3. <a id="rule-handler-arguments"></a>A handler reaches the page only through its arguments: refs, form fields (a form's
   control by its `#[derive(Fields)]` name, found in the handler's form,
   [Choice 57](#choice-field-arguments)), `event`, `target`, `signal`, `scope` and values. State that outlives an event is the DOM itself or `keep(init)`, the
   running handler's component's own. (Three exceptions: `CopyButton` copies an element outside
   its component, which it is given as a typed `Id` value and finds by that id, since refs do
   not reach outside a component; `RelativeTime` keeps the page's relative times in its
   module, so one timer serves them all, with a `visibilitychange` and a `pageshow` listener for
   the life of the page that read the clock again when it comes back; and `rows::sort` writes the
   order it drew into the address and into the part the runtime reads again around its table,
   found as the runtime finds a part: its `ReadAgain::from` tag, which no ref can name, and where
   its forms that post send (a `GET` form's fields are its query, so it is not rewritten). That
   search is closed: any other form or link whose route reads the order, inside the part or not,
   except a form that posts without an `action` or `formaction` (it sends to the address, which
   has the order), names the tables in its markup or in a kit pager's `on:link` (`ordered::send`,
   `ordered::link`, with `sorted(&Id)` of each table's `#[derive(Id)]`, or of an element around
   them, as `CopyButton` is given the element it copies) and reads the order from the address, so a
   new kind of reader is one of those calls, not a wider search ([Limit 24](#limit-sort-readers)).
   Which tables sort in place, also when other routes read their order, is decided in the [UI
   guide](guide/ui.md) from the measurements there.)
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
   instant (filtering the rows on the page as you type) keeps the form that does it without. A
   form that belongs to one page posts to that page's route, a page's several writes are named
   posts of it ([Choice 53](#choice-page-actions)), and a write with a path of its own redirects
   once done and draws a page only to refuse, so the page a browser is left at answers a `GET`
   ([Where a form posts](guide/requests-and-forms.md#where-a-form-posts)).
6. <a id="rule-page-view-model"></a>A page another surface reads derives `ToJson`, and its fields are its whole view model
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
    [Choice 14](#choice-feed-patch-rows), [Choice 15](#choice-corten-answer-headers), [Choice 18](#choice-custom-media-breakpoints), [Choice 53](#choice-page-actions); [Choice 24](#choice-openapi)
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
   place). A field without an id or a unique name takes the server's value. A `<dialog>` or
   popover the user opened or closed stays so when it has an id, and a `<details>` when it has
   one or by its place among its parent's children, unless the server changed it or the user
   asked again from outside for one they closed ([Choice 52](#choice-asked-open-state)). One
   without an id is matched by place only for a `<details>`, so an anonymous dialog or popover in
   a redrawn element takes the new markup's state (a dialog the user closed opens again when the
   new markup draws it open, and one they opened closes when it draws it closed), and a
   `<details>` that moved takes another's state. A dialog the server drew open, which the user
   closed and opened again, looks unchanged, so an answer that draws it closed closes it, without
   a native `close` event. A modal the [optional dialog widget](guide/ui.md) opened and the user
   left open gets a `close` on a same-id replacement. Other
   browser state inside a replaced element (scroll position) resets, so keep targets small. The
   runtime parses a patch as a `<template>`'s content, where the first top-level element (other
   than a head's, such as a `<script>` or `<template>`; Chromium and WebKit let a leading
   `<title>`, `<base>`, `<basefont>`, `<bgsound>` or `<noframes>` decide) decides how the
   rest is read, so a table part beside other elements is dropped or moved there unless the table
   parts come first. `html!` refuses the shapes lost wherever they are written: a table part
   after a first `<table>`; an element HTML's wherever it lands (a `<p>`, a `<div>`, a `<table>`
   ..) after a first `<col>`; and after a first other table part, a `<table>` at the top level or
   in a later element, and a `<form>` there that holds an element, with an element HTML's
   wherever it lands in or around it ([Choice 54](#choice-html-parse-refusals)). When a concrete
   `html!` is sent whole, a code-generating build also refuses literal losses that depend on
   what came first (a `<tr>` after a first `<p>`). Where the compiler does not see the loss, for
   example when a component or an expression writes an element or when one leaves an element open
   between two literals, a debug build refuses the patch as drawn when it sends it, naming the
   element. A release build sends those unchecked shapes, so a mix that only some data draws is
   found only by a debug render that draws it
   ([#1409 A patch that puts a table row beside other top-level elements loses the row: the runtime's template parse drops it, and only a console error says so](https://github.com/corten-run/corten/issues/1409)).
   That check refuses a patch from an area's handler that begins with a `<col>` even where the page
   already has the area's stylesheet, whose link Corten writes after the patch's elements and the
   parse drops: the server does not know what the page linked, and on a page without it the patch
   would land unstyled, so it is refused on both, and a `<colgroup>` with an id keeps the link.
   The check reads markup as `html!` writes it (a script's text as the browser's tokenizer does,
   a `<textarea>`'s, `<title>`'s, `<style>`'s, `<xmp>`'s, `<iframe>`'s, `<noembed>`'s and
   `<noframes>`'s as text, a void element's end tag ignored, and text where it decides with its
   numeric character references, `&Tab;`, `&NewLine;`, `html!`'s escapes and `&nbsp;` decoded and a
   NUL ignored), and reports a loss only from the tokens it reads as the browser does. It stops at
   any other, whether `html!` writes it (a `<div>` in a `<p>`, a `<form>` in a `<form>`, a
   `<noscript>`) or markup placed with `raw` does: an end tag left out, one written otherwise than `</name>` (`</div ignored>`) or one
   that closes no element open (a `</p>` or `</br>`, which adds an element or, in an `<svg>` or
   `<math>`, closes it); an HTML element's start tag ending `/>`, which the browser opens; a
   comment a browser ends elsewhere than at its `-->` (`<!-->`, `<!--->`, one with `--!>` in it);
   a CDATA section outside an `<svg>` or `<math>`, or one not ended by `]]>`; a doctype other
   than `<!DOCTYPE html>`, which a quoted `>` in it ends early; where text decides (in such a form,
   in a table holder, after a first `<col>`, at the top level), a named character reference it does
   not decode, and any text that shows in a table, row group, row or column group or after a first
   `<col>`, a `<` that starts no tag among it too; an element HTML's
   wherever it lands written straight in an `<svg>` or `<math>`, which `html!` refuses; a `<!--`
   and a `<script` in a script's text that carry it past its first `</script>` and over an
   element, which the markup does not say was written as its text; in a `<form>` a table's
   reading would put in empty, any token before what it holds but a comment, a bogus comment, a
   `<!DOCTYPE html>` and a void element's end tag; a start tag the patch ends in before its `>` (`<col data-note='`
   at the end, which the browser drops with what follows its `<`, an end tag in its value too); an HTML `<image>`, which the browser reads as an `<img>`;
   a `<plaintext>`, and a `<noscript>`, whose content Firefox reads as text and Chromium and
   WebKit as elements; and an element the browser does not put where it is written: a table part
   outside a table, anything in a `<table>`, row group or row but its own parts, a `<script>`,
   `<style>` or `<template>`, anything in a column group but a `<col>` or `<template>` (a `<script>`
   or `<style>` there closes it), and text in any of them, an element that closes one open around it
   (a `<div>` in a `<p>`, an `<li>` in an `<li>`, a heading in a heading, an `<a>` in an `<a>`, an
   `<svg>` or `<math>` between them too, since only a cell, caption, `<object>`, `<applet>`,
   `<marquee>` or `<template>` keeps the outer one open),
   a `<form>` in a `<form>`, what a `<select>` holds but its options, an `<html>`, `<body>`,
   `<head>`, `<frame>` or `<frameset>`, and, after a first table part, a `<form>`, `<table>` or
   table part in an SVG or MathML integration point, and a `<template>` in one, past whose end tag
   Firefox, unlike the standard and the other engines, reads the rest of the patch as a body's. There it
   reports a loss found before and otherwise logs a warning naming where it stopped, so markup
   written through `raw` is checked only as far as these rules reach, and what a patch loses after
   one of them is found by neither the check nor `html!`. `scripts/patch-generated.json` holds
   the check to these rules in 3,000 patches generated from a fixed seed (with characters past
   ASCII in names, values and text, character references, doctypes and text at the top level),
   which the smoke parses in all three engines, text included: it reports a loss only where an
   engine loses something, and where one does, reports it or says where it stopped; and the id
   check reports an element without an id or text outside one only where the engine's parse has
   one at its top level or loses something. Neither reads how deep markup nests: Chromium attaches
   an element nested deeper than 512 elements at depth 512 (measured in Chromium 156; Firefox and
   WebKit not checked), in a page as in a patch, which a recursive component (a comment thread)
   can reach.
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
   A video does not play offline: the worker leaves a range, and the video or audio a player
   loads, to the network ([Choice 37](#choice-asset-ranges)).
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
9. <a id="limit-stylesheet-support"></a>Component stylesheets support plain CSS with nesting.
   At-rule names match ASCII case-insensitively in both blocks and statements.
   The supported block at-rules are listed below:

| At-rules | Processing |
|---|---|
| `@media`, `@supports`, `@container`, `@layer`, `@starting-style` | Rules checked and classes prefixed as at the surrounding level; declarations in a nested rule stay declarations. Token breakpoints in `@media` are resolved at app startup. |
| `@scope` | Root and limit selectors checked and prefixed; rules checked as described below. |
| `@property` | Body copied raw, then required descriptors and supported syntax checked; registered names and references prefixed to the component. Not allowed inside a style rule. |
| `@position-try` | Declaration body copied raw; its dashed-ident name and matching references in `position-try-fallbacks` and `position-try` declarations in this file prefixed to the component, even before the definition. Not allowed inside a style rule. |
| `@keyframes`, `@font-face`, `@counter-style`, `@font-palette-values`, `@font-feature-values` | Bodies copied raw, without selector checks or class prefixes. Their names (animation, font family, counter style, palette and feature-value names) remain global: use component-qualified names when private. |
| `@page` | Name must start with the component's name and `-` (written by the author); body copied raw, including margin at-rules. The name remains global. An unnamed page or a name without that prefix is refused. |

   Raw bodies still compact trivia, and references to registered custom
   properties are renamed there too. Their nested block at-rules are copied raw (for example
   `@styleset` and `@top-left`), not independently checked against this list. The statement parser
   copies `@layer` without changing the name's case, and discards `@charset` in any case
   (the generated stylesheet is UTF-8).
   `@import` is refused because it loads a stylesheet the component does not own;
   `@custom-media` is refused because tokens define breakpoints. Unrecognized rules such as
   `@namespace` and `@document` are refused outside raw bodies; put them in the app's global
    stylesheet. At-rule names must match whole names, not prefixes: `@supports_other` and
    `@layer_other` are not supported. Unknown statements are refused even inside raw bodies.
    Escaped or non-ASCII at-rule and class names are not supported.

   The macro and startup custom-property check share [CSS Syntax Level 3
   tokenization](https://www.w3.org/TR/css-syntax-3/#tokenization). URL payloads are opaque,
   even with escaped names, and comments between tokens are not spaces. Source spans keep
   the original UTF-8 bytes: for a quoted `url()`, the function span ends at `(` and all
   following whitespace is trivia (including both bytes of CRLF), rather than absorbing
   all but the last whitespace code point as the spec algorithm does. A comment before
   the quote takes the unquoted URL path, not the quoted function path. The macro refuses
   mismatched block delimiters, bad strings and bad URLs instead of letting browser recovery
   consume later components. Static CSS is checked as UTF-8, with one leading BOM removed
   at decoding, not treated as whitespace elsewhere. Startup checks literal `var()` reads
   in declaration values (including declarations directly in `@scope` and in recognized
   page-margin at-rules with no prelude) and operands in recognized `@container` size features.
   Bare declarations inside a grouping rule directly under `@scope` are not checked:
   Chromium drops them, though Firefox and WebKit keep them. Chromium also drops `.b` in
   `@media all { --ink: red; .b { color: var(--ink) } }` directly under `@scope`. The scanner does
   not reproduce that selector error recovery.
   Put those declarations inside a style rule within the group for all three browsers.
   The scanner checks operands only when a size feature occupies the name slot of a colon
   or range comparison, not when it merely appears in an opaque condition. The scanner does
   not parse the operand's value grammar: it checks the read in `(width > flag var(--x))`,
   for example, even though browsers retain that condition without matching it. It does not
   check style or scroll-state query preludes or arbitrary at-rule conditions. It skips the
   whole lookup if it has a fallback, including `var({--x}, var(--fallback))`.
   Blocks in a custom-property value and the invalid `ident: { ... }` form do not declare
   properties. The check does not validate descriptor
   values in a global stylesheet or infer whether a selector matches; for example, a global
   `@property --x { syntax: "<length>"; inherits: false; initial-value: red }` is counted
   structurally even though a browser drops that registration.

   A registered custom property's name is prefixed only where it names that property: in its
   registration, declaration names, `var()` and `inherit()` lookups (also inside container
   size queries and `if()` conditions), style queries,
   `@supports` declaration tests, and property lists in `transition`, `transition-property` and
   `will-change`. An `attr()` name or a bare dashed identifier in another namespace is not a
   custom-property reference. This leaves anchor, container, timeline, view-transition and
   font-palette names unchanged, even if they share a spelling with a registered property.
   A name computed at runtime, for example one built by a script or supplied by `attr()`, is not scoped.
   This includes CSS-only lookups such as `var(var(--missing, --t), 1px)` and
   `var(if(else: --t), 1px)`, where a fallback or branch supplies the name. A literal
   `style()` test is scoped when it supplies an `if()` condition through a result slot of a
   [CSS arbitrary substitution function](https://drafts.csswg.org/css-values-5/#arbitrary-substitution-function):
   a `var()`, `inherit()`, `attr()` or `env()` fallback, a nested `if()` branch value, or a
   `random-item()` choice. This does not infer conditions assembled at runtime, follow
   argument boundaries built by CSS spread syntax, or treat ordinary values as tests.

   A `@position-try` name, like an `@property` name, starts with `--` and uses ASCII letters,
   digits, `-` and `_`, without `__` (reserved for the component prefix). References can use
   CSS escapes. The scoping pass prefixes only names defined in this file. The values of
   `position-try` and `position-try-fallbacks` are read as
   [CSS Syntax](https://www.w3.org/TR/css-syntax-3/#tokenization) tokens, and only an ident
   token equal to a local name is renamed, where the value takes an option: at its top level,
   in a `var()`, `env()`, `attr()` or `inherit()` fallback, and in an `if()` branch's value. A
   lookup's name and an `if()` condition (`style(--x: 1)`) are not option names, a dashed
   function token (`--x()`) calls a custom function, and strings, URLs, anchor names, other
   functions' arguments and unrelated declarations are not position references. The macro
    matches whole names from the source before normalizing whitespace and comments as in
    other declarations. In an unprefixed option such as `--externa\6c  flip-block`, the first
    space terminates the hex escape and the second remains a separator.
   A registered custom property with the same name does not rename an option, but its `var()`
   lookup still gets the property prefix. A name carried in a custom property's value is not
   rewritten as a position option.
   [CSS Anchor Positioning](https://www.w3.org/TR/css-anchor-position-1/#at-ruledef-position-try)
   gives position options a tree-scoped namespace, not a selector-scoped one: all Corten
   components share the document tree, so prefixing prevents collisions. This does not make
   anchors component-local. The older raw global namespaces stay global rather than silently
   renaming names that apps can already share through global CSS or font files; revisit that
   policy when an app needs checked private names for them.

   An `@scope` with no root is refused because its implicit root is outside the component.
    Each selector must match only elements that have one of the file's classes or are inside
    one (by a descendant or child combinator; `+`, `~` and `||` from the class's element lead
    outside it), directly or through every selector of an `:is()` or `:where()` the browser
    keeps. A class inside another function only filters, though it is still prefixed. A nested
    selector is relative when it starts with a combinator or contains no `&` delimiter, even
    in an invalid arm; only a matchable `&` supplies an anchor at its own position. The same
    check decides whether an `@scope` root is owned; if it is not, each selector in its body
    must pass on its own. An inner root under an unowned scope supplies proof for its body only
    if it requires a class on its element or an ancestor: neither explicit `&` nor implicit
    nesting can borrow proof from a style rule there. An owned scope bounds its nested scopes.
    The check does not implement the full selector grammar, so a selector it cannot show
    is owned does not compile. For instance, it does not infer that the `:not(::before)`
    arm of `@scope (:is(.list, :not(::before)))` cannot match; remove that arm. It recognizes
    direct pseudo-element arms, including `:/**/:before`.
   The `to (...)` limit is prefixed as any selector is, so a class in it is one of this
   component's: a limit can stop at this component's own classes, never at a nested component's
    root by naming that component's class. A limit does not supply proof of ownership.
   Every component listed in `App::components` is in one file, whether or not a page uses it: the
   item page's `components.css` (the hidden rules, tokens, two themes, two densities, utilities
   and six components) is 6,955 bytes, 1,573 brotli (measured). `Area::components` moves the components only some pages render into a file
   linked from those pages, and from the patches their handlers answer
   ([Choice 47](#choice-patch-brings-area-styles)); the split is by URL prefix, chosen by the app,
   not detected from what a page renders, which would cost every render.
   The lists are written by hand. `corten check` reads the source for a component with a
   stylesheet, script or view that no array names (a `COMPONENTS` list, `.components(&[..])`),
   and a debug build refuses a page, or a patch, that draws one its handler's area does not get. The scan sees names,
   not whether a list reaches `App::components`. A build-time check could do more for a child
   whose type `html!` knows (an inherent constant on each component, `None` for a hand-written
   `Render`, walked at startup), but not for a generic child, whose type is known only where it is
   drawn. It is not built, and the scan answers the reported case, a styled component no list
   names
   ([#980 Check at startup that a listed component's styled children are served with it, so the list check runs in every build and covers areas](https://github.com/corten-run/corten/issues/980)).
10. <a id="limit-tested-browsers"></a>`corten-ui` is tested in Playwright's builds: Chromium
    159.0.8154.6, Firefox 159.0 and WebKit 27.2 (revision 2388) in Playwright 1.65.1.
    Its popups are placed by the design system's CSS with anchor positioning (Baseline since
    January 2026); a browser without it shows them where `popover` puts them by default, centered.
    Tabs are horizontal.
    Its names in the page are prefixed (`ui.combo_box.js`, `data-scope="ui-combo-box"`) through
    `[package.metadata.corten] scripts = "ui"`, so an app's own components never collide with
    them. Two of an app's own scripts with one file name are a startup error that names both.
11. <a id="limit-caller-types"></a>A route's type says who may use it ([Choice 27](#choice-caller-types)), not which record:
    a check that depends on the record (the author, the organization) stays in its handler, a
    check the compiler does not see. That an area's or an API's routes are under its prefix is
    checked when a routes module that holds the prefix's struct expands, `cargo check` included;
    a route given to `Area::route` or `Api::route` by hand, or by a routes module whose prefix's
    struct is in another module, is checked by a `const` assertion in a generic method, which
    the compiler evaluates only when it generates the code that calls that method. So is a route
    that says `patches`, mounted by hand or by its routes module, against the kind of the `get`
    handler it is given ([Choice 50](#choice-patch-routes)), and so is the shape of a hand-written
    `Route`'s path. Those assertions fail any build that generates the code that mounts the route:
    `cargo build`, and `cargo test` when something it builds reaches the mount, a test, a
    doctest, an example or a library's own public non-generic code, which it builds for the
    doctests and the binaries, as the template's `app()` in its library is. `cargo test --lib`
    builds only the library's test binary, which generates what its unit tests reach, so it fails
    when a unit test reaches the mount and not otherwise. They do not fail `cargo check`, clippy
    or rust-analyzer, which generate no code, nor `cargo test` in a crate whose only mount is in a
    binary's `main`, since a binary's test build never generates `main`'s callees. `corten check`
    builds every target (`cargo build --all-targets`) after clippy and before the tests, so it
    fails such a crate as `cargo build` does, and one whose mount only a bench's own `main`
    reaches
    ([#1429 corten check misses a mount's const assertion when only a binary's main mounts the route](https://github.com/corten-run/corten/issues/1429));
    a mount only a feature the check does not turn on reaches is evaluated only by a build with
    that feature. `Refused::sign_in`'s 401 to a
    data client carries no `WWW-Authenticate`, short of RFC 9110 (15.5.2), since a session cookie
    has no HTTP authentication scheme to name; a lookup that also takes a token should answer a
    wrong one with `unauthorized`, which carries one.
12. <a id="limit-fixed-stages"></a>The app's own steps run at one place in Corten's fixed order of stages
    ([Choice 28](#choice-fixed-stages)), not as hooks at several: a step that must see the raw
    request before every stage is a tower layer around the whole app (`.layer(l)`), and there is
    no step for one route, whose needs are its handler's arguments and return type. A route
    takes every stage or, with `unstaged`, none: no same-origin check, deadline, middleware,
    error page, security headers but `nosniff` and `sandbox`, cache rule but `private` on a
    cookie, or allowed origins, which its handler gives itself if it needs them; the host check
    and, under an API's prefix, the API's JSON for a failure stay; it answers reads only; a wrong
    method or a missing suffix at its path is a plain 405 (501 for a method no route in the app
    has) or 404 (the API's JSON under an
    API's prefix), a failure elsewhere is sent as its handler made it (plain text, not Problem
    Details), and a panic is logged and answered 500 (plain, or the API's JSON under its prefix).
13. <a id="limit-protocol-switch"></a>A connection switches protocols (a WebSocket, a relayed tunnel, a tunnel a `2xx` to `CONNECT` opens) only over HTTP/1.1 served by
    `corten::serve`; HTTP/2's extended `CONNECT` is not supported. Corten answers as the route
    says (its `101` to a WebSocket handshake, its `2xx` to `CONNECT`) and hands over the bytes: frames, message limits, buffering, per-message checks and how long
    the connection may sit idle are the WebSocket library's and the route's, though
    `App::send_timeout` still ends a write the client makes no room for. `App::header_timeout`
    no longer applies and the deadline covered only the handler, so a switched connection on which
    neither side sends stays open until the route ends it. It still counts against
    `App::max_connections` until then: the cap's permit is held by the socket hyper hands over,
    not by hyper's connection, which ends at the switch (fixed by
    [#1249 max_connections does not count a switched connection: a WebSocket or CONNECT tunnel releases its permit when hyper hands off the socket](https://github.com/corten-run/corten/issues/1249)).
    So a route that accepts switched connections must end idle ones (a deadline from the last
    frame the client sent, with pings so one that only listens answers) and should bound how
    many it keeps: otherwise sockets no one uses take the cap from every other request. The work
    on a switched connection is told when shutdown begins and is not waited for. A `CONNECT`
    tunnel route is reached only in origin form (`CONNECT /tunnel`): the authority form a client
    sends (`CONNECT host:443`) names no path a route can match, so it is a `404`
    ([Choice 25](#choice-axum-router), migration step 1).
14. <a id="limit-http1"></a>Connections are HTTP/1.1. An app with live streams needs an HTTP/2
    proxy or CDN even when it ends TLS itself. The connection bounds, measured tradeoff and
    reopening criteria are in [Choice 25](#choice-axum-router), protocol step 2; configuration
    is in [Deploying](guide/deploy.md).
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
    arguments the call passes (a column, as a Rust type) are checked either way. A handler meant
    for such a prop takes the wide type too (corten-ui's `rows::sort` and `ordered::link`, which
    the kit's pagers take as `on:link`), so written on an element of its own it accepts any
    element: `ordered::link` on a `<button>` compiles, is reported in the console, and does nothing.
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
    `fetch` (probed), so the runtime's navigations there always get the whole page. A `GET` that
    does not explicitly accept a non-identity coding and sends no `If-None-Match` gets no tag:
    for a client like `curl` or a benchmark, the hash would cost about a third of the render for
    nothing. A CDN that fetches pages without asking for a coding gets no tag to revalidate them.
    What counts is the header as it reaches the app: behind a proxy that takes `Accept-Encoding`
    off, a browser that holds no tag is never sent one (one that still holds a tag names it, and
    is answered when the proxy passes `If-None-Match` on too;
    [deploying](guide/deploy.md#response-compression)).
    With `compress`, only explicitly named codings Corten can send count.
    Without it, any named non-identity coding with a positive weight counts, as does a positive
    `*` (it allows unlisted codings, RFC 9110 section 12.5.3). An absent or empty
    `Accept-Encoding` does not count in either build. An otherwise taggable `HEAD` gets a weak
    `ETag` in both builds even without an accepted coding or `If-None-Match`. The tag cannot match
    a stored untagged `GET`, so the cache should consider that copy stale even if the new answer
    has the same `Content-Length` ([RFC 9111 section 4.3.5](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.3.5)).
    A file of a type compression does not vary on (a PNG, a PDF, `no-transform`) is tagged for
    every other client, since its `304` saves the whole body. Its `Vary` does not name `Accept-Encoding`, though
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
    the client chose along with the bytes. The search is `memchr`'s substring search (no crates
    under it): linear, as a byte-by-byte search is, but 4.5 times as fast on plain bytes, 35 times
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
24. <a id="limit-sort-readers"></a>A form or link whose route reads a table's order that
    `rows::sort` drew takes that order only by naming the table (`ordered::send`, `ordered::link`,
    [Rule 3](#rule-handler-arguments)). Two kinds need no call: a form in the part read again around
    the table that posts, which `rows::sort` rewrites, and a form that posts without an `action` or
    `formaction`, which sends to the address it keeps. Any other that does not name the table sends
    the order the page was drawn with, and nothing notices (a kit pager must write `on:link`, but
    `on:link={None::<Handler>}` builds): the compiler cannot see which routes read the order, and
    the runtime cannot tell a form that should carry it from one that should not. A navigating sort
    header would close this at the cost of a round trip on every sort ([UI guide](guide/ui.md)). It
    lifts when a route's type says it reads a table's order, so markup that sends to it on a page
    that draws that table without the call does not build.

25. <a id="limit-wire-diagnostics"></a>A page cannot see what the runtime sent or received: no
    hook hands a script a submit's answer or a live stream's fragments as they came, so an in-page
    inspector of the payload a page received has no supported way in (a script that wraps `fetch`
    or `EventSource` before the runtime calls them is outside its contract). The browser's network panel shows
    each navigation and submit and its answer, after content decoding and only while it is open,
    and Chromium's shows an event stream's messages, the other engines' not checked
    ([Requests and forms](guide/requests-and-forms.md#seeing-what-went-over-the-wire)). An app
    learns its own outcomes from typed events its markup dispatches, from a submit's patch or a
    live fragment. So by design: a hook would cost every page a check on each patch and runtime
    bytes for an inspector few apps would show (Value 1), would have to define its own order,
    cancellation and redaction of the private HTML and form data it carries, and would be a second
    way to hear an outcome (Value 5), where the network panel already shows the wire (Value 2;
    [#1130 Expose opt-in browser diagnostics for action responses and live HTML patches](https://github.com/corten-run/corten/issues/1130)).
    It lifts when apps need the received payload in the page for their users, not their
    developers, or when Chromium's panel stops showing an event stream's messages.
26. <a id="limit-origin-scheme"></a>Without `Policy::hsts`, a write or a WebSocket handshake that carries no `Sec-Fetch-Site`
    (every handshake from Chromium and Firefox, and any write from a plain-http page, to which
    browsers send none) is held to its `Origin`'s name and port against `Host`, not its scheme: a
    plain-http page on the app's host passes against the app served over HTTPS
    ([#1212 A write or WebSocket handshake without Sec-Fetch-Site is checked against Host without the scheme, so a plain-HTTP page on the app's host passes against the HTTPS app](https://github.com/corten-run/corten/issues/1212)).
    The app cannot tell which scheme it is served over: a proxy or CDN in front usually ends TLS
    and sends plain HTTP on, and the app reads no `X-Forwarded-Proto`, which anyone can send to an
    app that does not list its proxies. With `hsts` the app says it is HTTPS only, and the
    `Origin` must then be `https` or loopback. It lifts when the app knows its scheme for itself:
    a forwarded scheme read only from the proxies `Policy::proxy` lists (as `ClientIp` reads
    `X-Forwarded-For`), or the connection's own TLS state when `serve_wrapped` ends TLS in the
    app.
27. <a id="limit-path-values"></a>A path parameter cannot carry a value its link would not read
    back as. A browser resolves a `.` or `..` segment away before it asks (the URL Standard, which
    reads `%2e` as a dot there too), so `/items/..` opens `/` and the `{*rest}` key
    `public/../private/x` opens `/files/private/x`; and the router has no segment for an empty
    parameter anywhere (`//posts` is another host to a browser, `/items/` matches no `{id}`,
    and `/notes//edit` matches no `/notes/{title}/edit`). So `.`,
    `..`, a `{*rest}` value with such a segment, and an empty path parameter are not
    written as they are by a `#[derive(Route)]` link: a debug build panics when the link is
    written, naming the route by its module path (`shop::url::Item`) and the field, and a release
    build writes `%FF` after the value (`/items/..%FF`, `/files/public/..%FF/private/x`,
    `/%FF/posts`), which no browser resolves and the route answers with a 400, since no parameter
    reads a value that is not UTF-8, and logs that as an error the first time for each route and
    field in the process, so a list that links a stored value on every row is one line, not one
    per link and render. A route is known by its name and module path, which leaves out function
    bodies, so two routes of one name declared in two functions of one module share their line. A
    refusal counts as that time only when the subscriber takes an error event of Corten's
    (`tracing::event_enabled!`), as Corten's default subscriber and one that filters by level and
    target do, so one written before the app installs its subscriber does not use it up. The check
    asks before the event exists, so a subscriber that filters on an event's message text or its
    line can disagree with it either way: a refusal it drops still uses up the one line, and one
    it would log may never be logged. Later refusals of a route and field read the list of those
    logged and do not wait on each other. The link opens no
    other page or file either way. A route that starts with a `{*rest}` refuses a dot segment after
    the value's leading `/` too (`/..`), though it writes that `/` as `%2F` (`/%2F..`), which no
    browser resolves: the refusal is kept, since it costs nothing where no value has such a
    segment and the value means a path above the route's. A value that only contains dots
    (`a.b`, `...`, `.hidden`) is written as it is. Empty segments inside a nonempty catch-all
    still read back (`/files/a//b`). A route's own path
    cannot have a `.` or `..` segment, or that text after a parameter: with `#[derive(Route)]`
    neither compiles, and a `Route` written by hand does not build with that text after a
    parameter in its `WRITTEN` path, or with a dot segment in its `PATH` where an area or an API
    adds it. A hand-written `Route` the app adds at its top level is not checked for a dot segment
    in its `PATH`, and the values a hand-written `write_href` writes are its own, which nothing
    checks. The check is where a
    link is written, not where a request is read: no browser sends such a segment, so a check on
    every request with parameters would cost them all to stop what no link sends, and a value
    decoded from a segment can hold `../` anyway (`..%2F`), so it would not make a parameter safe
    to use as a file path; an app that does that checks the value itself. Writing a link pays
    inside the pass that already encodes each value, which also says whether the value has a dot,
    so a whole-segment value pays a comparison of its length, and one of two bytes or fewer a look
    at its first byte. Counted with callgrind in a release build (1,000 and 11,000 links of one
    route, the difference over 10,000), at `076abde0` against `80dbd7db`, a link costs:
    `/items/{id}` 120 instructions against 117, `/{user}/posts` 128 against 131, `/{lang}/news`
    with `en` 114 against 113, `/feeds/{name}.xml` 125 against 121, three parameters (one a
    `u32`, checked on what its `Display` wrote) 525 against 506, and `/files/{*path}` with a
    29-byte value 178 against 170 without a dot and 270 against 170 with one (`sum.md`): whether a
    dot starts a segment depends on the bytes beside it, which that pass does not keep, so a
    `{*rest}` value with a dot is read again, eight bytes at a time. Where a page writes a link
    into an attribute, the check made the link too large to be inlined there at `9aee73ad`, which
    cost the item page's `render_cost` run about 27M instructions of 28,365M; checking a value of
    two bytes or fewer out of line (`ce50dab8`) inlines it again, and at `076abde0` the run counts
    28,366.4M, 28,359.7M and 28,368.4M against 28,346.8M, 28,362.2M and 28,356.3M at `80dbd7db`:
    the ranges overlap, and the medians are 10.1M apart, less than the 15.4M between
    `80dbd7db`'s own runs.
    An app whose slugs, names or file keys come from people refuses these values where it stores
    them, so its links never reach the check.
28. <a id="limit-keep-place-identity"></a>A navigation that keeps the user's place (a
    `data-keep-place` form or link, or a page reading itself again for `ReadAgain`) restores
    focus by the control's own id, else by its name (and value for a checkbox or radio) and its
    index among the matching controls inside the nearest ancestor with an id, else `<main>`.
    Inputs of `type="hidden"` are left out of that index. Disabled controls, ones with the
    `hidden` attribute and ones inside an `inert` element are counted, so a preceding control
    entering or leaving those states does not change the index. The control at that index is
    focused if it can take focus; if it cannot, or the ancestor still holds matches but no match
    at that index, focus is not restored. Only when nothing under the ancestor matches (the
    ancestor is gone, or every match in it) is the control looked for in `<main>`, at the index it
    had there before the swap. Without the control's own stable id, inserting, removing or
    reordering matching controls ahead of it can leave focus unrestored or move it to another
    control, and a matching field that switches to or from `type="hidden"` across the swap counts
    as inserted or removed. Because the ancestor is tried first and `<main>` only when nothing
    under it matches, two more shapes move focus: a control that leaves its ancestor while
    another match enters it gives focus to that match (where the runtime once looked in `<main>`
    and found the original), and a control that itself turns `type="hidden"`, leaving no match
    under its ancestor, is looked for in `<main>` and may give focus to another form's copy. An
    index does not identify an item through an order change. Give such a control its own stable
    `#[derive(Id)]` id, which avoids all of these; an id on its form keeps other forms' copies out
    of the count.
    This limit is deliberate: inferring an identity from changing markup would
    still guess where the app's id can state it.
29. <a id="limit-page-action-address"></a>A page drawn at one of its posts' addresses
    (`/inventory?page=3&do=price`: a write it refused, drawn without JavaScript, or the address
    opened by hand) stays at that address, so a post form in it with no `action` sends to that
    post again, whatever the form is for: a browser resolves a missing `action` to the document's
    address, query included (HTML's form submission), and nothing Corten sends can change where a
    browser without JavaScript posts. A page with named posts writes every post form's `action`,
    `action={at}` for its plain `post` ([Choice 53](#choice-page-actions)). A debug build answers
    a page of a route with named posts, drawn at an address whose query has a `do` key, whose
    markup has a `<form method="post">` with no `action`, or an empty one, with a 500 that names
    the form; the router marks such a route's requests, so a route without named posts may use a
    `do` of its own unread, and it reads only those pages, after they are written. A release build
    compiles none of it, so it costs nothing in production and never runs in a smoke test against a
    production image. It reads
    the form's own attributes: a form whose every button carries a `formaction` is flagged though
    it posts nowhere wrong (give it an `action` too), and a `formmethod="post"` button in a `GET`
    form and a form a script adds are not seen. A patch is not read: the runtime applies it at the
    address the browser was already at.
30. <a id="limit-markup-context"></a>An `html!` sees one component's markup, not what it lands in
    or where a component writes its children, so `html!`'s refusals of markup a
    browser parses differently from how it is written (an element in an element whose content is
    text, a `<plaintext>`, an element taken out of foreign content, or literal HTML nesting
    whose start tag closes or discards an open element;
    [Choice 54](#choice-html-parse-refusals)) and the debug check of a keyed ref's
    keys ([Choice 46](#choice-ref-values)) act only where that markup shows how a browser parses
    it (and the refusal of a patch's top level, only where the first element is written in it,
    and only for the shapes lost whatever the patch began with and wherever the view lands, since a
    component's markup does not show which table part, if any, an element before it wrote, or
    whether its parent writes it in an `<svg>`), and where it does not they let
    a mistake pass rather than stop correct structure. At the top
    of a component's markup, which its parent may write into an `<svg>` or a `<math>`, those
    structural refusals do not act: an element a browser moves out of foreign content (`<b>`, `<div>`, `<p>`,
    `<span>`, `<table>` and the rest of the standard's list, a `<font>` with `color`, `face` or
    `size`), an element in a `<title>`, `<textarea>`, `<script>`, `<style>`, `<iframe>`,
    `<xmp>`, `<noembed>` or `<noframes>`, and a `<plaintext>` are not refused there, nor among a
    component's children, nor in an `<annotation-xml>` where an expression or a spread comes
    before any written `encoding`, until an element of the markup shows the context. Keys in a
    `<template>`, `<noscript>`, `<textarea>`, `<title>`, `<iframe>`, `<xmp>`, `<noembed>` or
    `<noframes>` there are not checked, though in an `<svg>` the runtime finds them. Among a
    component's children, which it may write into an `<svg>`'s `<desc>`, the same holds, unless
    they are in an `<svg>` the children write themselves under an element that shows HTML. A
    literal `<svg>` or `<math>` at the top of the markup or among a component's children does not
    show its namespace either (a `<math>` an `<svg>` holds is SVG's), so an element taken out
    of foreign content is refused straight in it, and nothing in its integration points. A
    `<script>` or `<style>` literal is escaped only when its context is known to be foreign,
    even when the exact foreign namespace is not known. A literal with `<` or `&` is refused
    when the markup cannot distinguish HTML from foreign content on every expansion, even if
    it would work in its one actual placement. This is a local check at tag boundaries, not
    full HTML tree construction or a model of every fragment insertion mode. What an
    element HTML reads as text holds is not read there either (as HTML's it is text, as SVG's
    elements), so `<iframe><p><div>"Detail"</div></p></iframe>` at the top of a component compiles
    and nothing after such a `<plaintext>` is refused, nor is what a `<noscript>` holds, anywhere
    (text with scripting on). Nor does
    the markup show what an expression or any component writes, `<Corten />` included (`raw`
    may open or close any element), nor what a `<script>` or `<style>` whose literal text can
    end it early or keep it open writes: `</script>` in it ends the element and what follows is
    markup, and `<!--<script>` keeps it open past its end tag. What one writes may
    leave a browser reading a script's text, a comment or a `<plaintext>`, which a later
    literal start tag does not end, so after one no structural refusal that needs a known context
    acts in the same `html!` (a duplicate attribute and a hand-written `data-key` still do), in a
    `<template>` or an `<svg>` written after it too; `<p>{text}<div>` compiles, though a browser
    closes the paragraph, as do nested tags in a document's body, which follows `<Corten />`.
    An ordinary `<` in known HTML raw text does not stop structural checks. A nested `<form>` is refused
    nowhere: only a document's markup could show that no `<template>` holds it, and its body
    follows `<Corten />`. Every refusal assumes `html!` output, a component's included, is drawn
    where a browser reads tags; writing a component into script or style text a caller left open
    is not supported, since a script's text comes from a string, not markup, and a refused shape
    there (the sixth review's `TemplateMarkup` with `<p><div>`, after
    `<script type="text/x-template">"<!--<script>"</script>` and before `raw("</script>")`) is
    kept by browsers as the script's text and refused still. Following the parsing context across components would lift the first of these: each
    component's render would tell the next what it is written into, at a cost to every render,
    for markup few apps write. What an expression writes is the app's: `raw` is trusted text.

31. <a id="limit-read-redirect"></a>A script's `read()` follows no redirect and cannot see where one
    goes. It asks with `redirect: "manual"`, since the target is another route's answer and not
    the route's data, and the browser hands it an opaque answer with no `Location`, so it rejects
    with a `ReadError` 0 whose `redirected` is true: a redirect, told apart from no answer, but
    not where to. Corten's own sign-in refusal (a signed-out `Caller`, `Refused::sign_in`)
    answers a data client 401, not a redirect, so this is only a redirect the app writes itself
    (its own middleware, or an answer replaced through `DerefMut`); an app that sends a visitor
    to sign in does it with `Refused::sign_in`, and a script reads that as a 401. A script that
    meets either navigates to the URL, and the browser follows the redirect or the sign-in
    ([Choice 55](#choice-screen-read)).

32. <a id="limit-field-kind"></a>A form field given to a handler (`js::fill(f.weight)`) is checked
    against the handler's parameter when the crate compiles, but whether its form draws that
    control is checked only when the handler runs ([Choice 57](#choice-field-arguments)). A
    field's name carries what it reads (`FieldName<Condition>`), not whether a form draws it as a
    select or as radios, a call may name a field no control on the page has, and the markup that
    draws the control may be another component's, often in another crate, so no one expansion of
    `html!` sees both the call and the control. A call that takes a single control (`i`, `s`,
    `t`) whose form has no control of the name, more than one, or one of another kind, or that
    takes a group (`*`) whose form has a control of the name that is not an input, runs nothing
    and throws what it takes and what the form has instead
    (`corten: shipping.fill takes field weight as one <input>, and its form has select`), and
    `corten dev` reports the same when the page or a later draw puts the call on the page, so the
    mistake shows on load rather than on the first event that calls it. A group with
    no control of the name is `[]` and is neither an error nor reported, since a form may leave
    out a group of radios. It checks again for markup added to the page and a control that joins a
    form, not when a `name`, `form` or `data-on` attribute changes or a control is removed, so a
    mistake those make shows only as the runtime's error when the handler runs. It reports a call
    once, when it is drawn: a call drawn before a later patch or script adds its control keeps that
    report in the console though the handler then finds the control, so a report on a page that
    draws its controls after its calls is checked against the page as it is. A call and its control
    drawn in one `html!` expansion (a `<select name={f.service}>` given to a handler that takes an
    input, in the same form) could be checked when the crate compiles, since the macro sees both;
    it is not yet ([#1536 A form field's control kind is not checked at compile time when the call and the control are in the same html! expansion](https://github.com/corten-run/corten/issues/1536)),
    and that would not reach the case this Choice is for, fields another component draws. It lifts
    when the kind a form draws for a field is known where the call is checked.

33. <a id="limit-developer-markup-scan"></a>The developer checks for patch ids, form hints,
    empty submit keys and `data-vars` share the
    [HTML tokenizer's](https://html.spec.whatwg.org/multipage/parsing.html#tokenization)
    tag, comment and text boundaries. They do not build the browser's tree. The patch id
    check still stops at the shapes in [Limit 2](#limit-whole-element-patches). The hint
    check recognizes SVG and MathML text (including CDATA), decodes numeric whitespace
    references and `&Tab;` and `&NewLine;` in HTML text and textarea values, and leaves
    script and stylesheet source, iframe fallback and inert template contents out of
    hint text. The open-element stack follows SVG and MathML exits and the in-body
    start tags that close list items, definition items and paragraphs. An `<input>`
    start pops an in-scope `<select>` and its open descendants before inserting the
    input. It ignores a nested form start outside template contents while the form
    pointer is set, before considering a paragraph close. For explicit ends it checks
    list-item scope for `</li>`, button scope for `</p>`, and ordinary scope for `</dd>`
    and `</dt>`.
    It does not insert the empty paragraph that a stray `</p>` creates or model the
    special stack removal for a misnested `</form>`. It does not follow other insertion
    modes or reparenting (for example, moving text out of a table), or the paragraph
    close that depends on whether a table is parsed in quirks mode.
    Hints and submit keys distinguish an ordinary template from a declarative shadow root
    on an eligible document host without a root already. This is a scan of written markup:
    it does not decode attribute values, model the accessibility tree or follow slotting,
    script changes or custom-element registration. A patch uses a template fragment and
    does not attach declarative shadow roots. The server scanner runs only with debug
    assertions. The `data-vars` check also requires development mode and a full document.
    A normal release build still serves browser diagnostics in development mode but
    does not return the server error for a missing `data-vars` rule.
    It checks the scripting-on parse, including templates whose contents can be copied,
    and, when it finds an HTML `<noscript>`, the scripting-off parse, where it checks
    fallback markup only outside inert template contents.

34. <a id="limit-relay-stream-order"></a>JetStream stream order is not always Corten feed
    order. Postgres commits each feed's sequence under its row lock. The relay submits
    ordinary patches in outbox-ID order, which is feed-sequence order within a generation.
    The relay drains acknowledgements while sending and correlates them to one batch attempt;
    a late reply cannot retire rows in a retry even when the retried message IDs are the same.
    A tiny client queue can drop replies on a pipelined attempt. Retrying the selection adds
    broker work even when JetStream deduplicates it by message ID. After a partial patch reply
    timeout the relay waits for each patch's reply before sending the next, rather than
    repeatedly overflowing the queue or opening more subscriptions.

    - **Connection failure.** A pipelined patch send or acknowledgement failure retires none of
      the selected outbox IDs in that attempt, including rows already acknowledged. After
      a mid-batch disconnect the NATS client may send queued publishes on the replacement
      socket; JetStream can store later patches of a feed before it accepts the missing
      patch on retry, or before the retry stores its reload marker.
    - **Per-row size refusal.** Even without a disconnect, the relay sends reload markers
      after attempting ordinary patches, so JetStream can store later patches of a feed
      before the refused row's marker. If the marker cannot be sent or acknowledged, that
      row stays pending while other acknowledged rows can retire. If only the ack is lost,
      the marker may already be stored.

    In either case the configured deduplication window starts at JetStream's first
    acceptance of the message ID. A retry after that window can store another patch or
    marker for the same row. In both failure cases a Corten follower may stay at its last
    applied sequence until an update arrives. It reloads committed state from Postgres on
    a feed-sequence gap or a marker ahead of it. This restores state, not every missed
    delta. Followers ignore same-generation patches and markers at or behind their current
    sequence. Revisit when deployments need raw stream ordering
    ([#1657 Measure JetStream atomic batch publish for the cluster relay, so a disconnect cannot store a feed's later patches without the earlier ones](https://github.com/corten-run/corten/issues/1657));
    see [Choice 63](#choice-cluster-feed-subjects) for other criteria.
