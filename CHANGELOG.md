# Changelog

Notable changes to Corten. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Corten is pre-1.0, so any minor version may change the API.

## Unreleased

Pending entries are in [changelog.d/](changelog.d/).

- CI cancels a pull request's older run when a newer push arrives, so only the head's checks wait
  for a runner; pushes to main and the release's call keep every run.
- A document component with refs, `scope` or `keep` accepts a leading `<!DOCTYPE html>`:
  its single root is the `<html>` element, so the page can render in standards mode.
- **Breaking:** `html!` refuses duplicate emitted HTML attribute names (case-insensitively, including
  names with expression values), hand-written `data-key` (write `key={..}`), and visible HTML
  nesting whose start tags close or discard an open element: blocks in paragraphs, nested list
  and definition items without a boundary, active anchors, buttons or `nobr` still in scope,
  directly nested headings, and select,
  option-group, option and ruby starts that close an open element. Diagnostics say what to change. The content of a
  `<template>` or of SVG and MathML is checked apart from the elements around it, where browsers
  keep what is written.
  A nesting refusal rests only on literal markup of the same `html!` before the inner element:
  no nesting is checked after a component (`<Corten />` too, so none in a document's body) or an
  expression (`raw` may write any element, or leave a script open), nor is a nested form; a
  duplicate attribute and a hand-written `data-key` need no context and are refused anywhere.
  Every refusal assumes the output is drawn where a browser reads tags: a component written into
  script text a caller left open is not supported. This is not a complete HTML validator
  ([views](docs/guide/views.md)).
- `html!` no longer refuses an element in a `<textarea>`, `<title>` or another element read as
  text, or a `<plaintext>`, under the `<foreignObject>`, `<desc>`, `<title>` or `<mtext>` of an
  `<svg>` or `<math>` at the top of a component's markup or among its children, where its
  namespace depends on the caller (a `<math>` in an `<svg>` is SVG's), nor an element read as
  text or taken out of foreign content after an expression or a component, which may close the
  holder or write an integration point. Wrap such an `<svg>` in an HTML element to have it checked.
- `html!` no longer refuses markup after a `<script>` or `<style>` whose literal text holds a
  `<`: it writes that text as is, so `</script>` there ends the element and what follows is
  markup it does not see, as after `raw`. The nesting, text-holder, foreign-content and patch
  checks treat such an element as unseen output, so `<p><script>"</script><button><script>"</script><div>..`
  compiles, as browsers keep it, and a `<div>` after `<script>"if (a < b) go();"</script>` in a
  `<p>` is no longer refused either (a miss).
- No nesting, text-holder, foreign-content or patch-shape refusal of `html!` acts after unseen
  output in the same markup (a duplicate attribute and a hand-written `data-key` still do), even
  where a later literal
  `<svg>`, `<p>` or `<textarea>` would have shown the context: what an expression, a component
  or a script whose text holds `<!--<script>` writes may leave a browser reading the script's
  text, so `<script>"<!--<script>"</script><p><div>..</div></p>{raw("</script>")}` compiles, as
  browsers keep it. `<Corten />` is unseen like any other component, so a component of the
  app's named `Corten` compiles, and nothing in a document's body is refused (a miss).
- `html!` no longer reads what an element HTML reads as text holds (`<iframe>`, `<textarea>`,
  `<title>`, `<script>`, `<style>`, `<xmp>`, `<noembed>`, `<noframes>`, `<plaintext>`) where the
  markup does not show the element is HTML's, nor what a `<noscript>` holds anywhere: it may be
  text, so `<iframe><p><div>"Detail"</div></p></iframe>` at the top of a component compiles, as
  browsers keep it, and nothing after such a `<plaintext>` is refused.
- `html!` compares attribute names as it writes them: `ref` (written `data-ref`), bare `page`
  (written `data-corten-page`) and `key` (written `data-key`) beside their uppercase literal names
  (`REF`, `PAGE`, `KEY`) compile as distinct attributes, as does bare `page` beside `page=".."`.
  Repeated pseudo-attributes and case-insensitive duplicate literals (`Key` beside `KEY`) are
  still refused, as are hand-written generated attributes.
- The patch shapes `html!` refuses (below) compile where output the markup does not show (an
  expression, a component, or a `<script>` or `<style>` whose text holds a `<`) comes before the
  lost element's start tag: in the first element, between the two, or in a later element that
  holds the lost one, before it, since what it writes may leave an element open
  (`raw("<table>")` keeps the row after it); the debug check reads them when sent. One inside
  the lost top-level element itself does not save it (`<table id={..}>{text}</table>` after a
  first row, or a row holding an expression after a first `<table>`, is still refused).
- Every `corten` command accepts `--help` and `-h`, printing its own usage and exiting
  successfully without running the command; `corten help <command>` prints the same and refuses an
  unknown command. An option given twice (`--name`, `--corten-path`, `--port`) is refused instead of
  taking the first. `corten check` reports each step and its elapsed time on stderr, including in
  redirected logs, while preserving Cargo's output.
- The MCP endpoint moves the request's headers into a tool call instead of copying them, and its
  `OPTIONS` answer reads them in place; the route's body limit and body errors are unchanged.
- Document script testing without runtime stubs: import-free shared logic in Node, including
  Rust/JavaScript parity cases, and runtime-dependent handlers on a served page with Playwright.
- JSON benchmark v2 keeps classified target failures separate from apparatus
  faults, retains verified phases of incomplete passes, and leaves independently
  complete peers comparable. Raw stock-load output, counted resources, source
  and cleanup gates still apply. Its producer assets must match the measured
  commit, and current campaigns reject schema downgrades; standalone historical v1
  evidence retains its original exact fixed-offer and zero-error verifier.
  The campaign carries independently reviewed v2 transport receipts from the
  cloud inbox through timing replay; a version label alone is not an audit.
- CI builds the Git-capable Playwright test-tools image only in the browser group that runs
  the workload apparatus; the other two smoke groups no longer depend on Launchpad's Git PPA.
- Catalog Contract selects affected parity apps on pull requests and runs all parity and JSON
  jobs for unrecognized app paths. Benchmark Evidence runs portable source-custody checks when
  captured sources change and native kernel checks when their own inputs change. Both scope
  against the full Git diff and cancel superseded pull request runs, not main runs.
- Document how a GET filter handler chooses focus and text selection before `requestSubmit()`
  so `data-keep-place` restores them after the page swap, without another runtime behavior.

- Give maintainers one [release runbook](RELEASING.md) for deciding readiness, shipping urgent and
  security patches, publishing, verifying public packages and binaries, and recovering from failed
  releases.
- The catalog benchmark uses a fixed two-worker upstream within its existing CPU
  and memory budget, retaining per-process headroom and a first-host preflight.
  Saved worker evidence joins every preflight to the timed upstream and the
  apparatus source hashes to the bound measured commit; failed capacity checks
  remain unqualified rather than attributed to the measured framework.

- The catalog benchmark keeps one supervised control connection off the measured
  cores. Losing that connection does not authorize deleting an active droplet.
  Collection replays the saved control evidence before authorizing cleanup.

- Preserve every client benchmark candidate's not-run record when policy input
  is invalid or missing. Such attempts still fail before any native build.

- Capture the benchmark validator's pinned semver library and committed tooling
  declaration before replay. Resolve its CommonJS imports only from those
  verified bytes, without reopening installed files or enabling package fallback.

- Stop an isolated benchmark command cooperatively when its host observer detects
  an irrecoverable observation/storage failure, broken continuity or a recorded
  Docker-participant gap. Preserve invalid evidence and uncertain ownership;
  cancellation does not qualify a run or authorize host deletion.

- Correct the grouped browser documentation to describe the current replayed
  tool/lock identity handoff. Missing historical identities and independent OS
  proof still block qualification; the documentation grants no readiness.

- The catalog stand-in upstream reuses UTF-8 record bytes and handles canonical
  reads synchronously, retaining exact controls and read counts. Measured apps
  still fetch, parse and render or serialize per request; apparatus capacity
  checks, resource budgets and failure interpretation are unchanged.

- A slow part is answered by the page's own handler: `{ReadAgain::now(route)}` inside the part
  drawn waiting (the element whose id the part's patch replaces) has the runtime read it once the
  page is on the screen (a GET with `corten: action` to the page's own route, which says
  `patches`), and `req.patch_or_with(part, page)` answers both, its two sides closures so the
  part's read runs only for the part and the page's only for the page. Before, the part was a
  `<corten-live>` stream of one item on a route of its own whose handler repeated the page's
  reads, with a second waiting state; and a `patches` route whose part needed a read of its own
  could not answer its page without building a patch it would not send. Tags that name one address
  are read once, so two parts one read draws share it (each waits for the slowest; independent
  parts take a query field each). The part, and only it, is `aria-busy="true"` while the read is
  on its way, so a patch of a cell or row beside it changes nothing; a part its read did not
  replace (no patch, an error page, a redirect, or one of a shared read's parts gone meanwhile) is
  marked `data-corten-read-failed`. The app's link to the page with the part read in shows unless
  the part is busy (`[aria-busy] > .show { visibility: hidden }`, in the grid cell its loading line
  shares, so the swap moves nothing), so it shows without JavaScript, when the part module does not
  load and once the read failed, and follows a redirect as a navigation.
  A read is its tag's at its address: a part that is a live region a write's page draws again in
  place with a new tag has the new tag read and the old read stopped, so an old answer never lands
  over a newer one (even one waiting for the same stylesheet); a kept tag the page draws with
  another address is read there, its old read stopped and an old failure forgotten; and a kept
  part whose own attributes the page draws again keeps its busy or failed mark. A read the
  back-forward cache ended is made again when the page is shown, and a prerendered page reads
  once it is shown. A part waiting in a part's answer is marked failed, not read, so reads do not
  chain; which tags the answer drew is told by the elements of its markup, taken from the patch
  the runtime parsed, handed to that read alone before anything else runs (an argument of the
  runtime's own call, never a property of a script's signal), so a part a form's answer or a part read again
  draws in the same task (both waiting for one stylesheet) is read, even in place of one the
  part's answer drew or at its address, and so is one a script draws from a callback the drawing
  runs (a `focusin`, a custom element's `connectedCallback`, even its stylesheet link's), and
  nothing keeps the markup once the patch is drawn or cancelled; a page whose head asks to be read again is read on its interval, and draws its part
  waiting again when its `<main>` changed. The reads, and finding the parts, are a script module
  of their own, `part.js`, served beside the runtime and loaded only by a page that draws such a
  part (and precached once by a PWA's service worker); the runtime only imports it, on a load
  whose head preloads it or for markup with a waiting part (the server's, or a script's
  `patch`, its attribute's name found in any case and after any separator), and grows by 44 bytes
  gzipped and 40 brotli (15,568 and 14,060 on main at `7d9bbbf1e`, 15,612 and 14,100 at
  `051f040ef`), and the module is 1,534 gzipped, 1,359 brotli at `051f040ef` (`npm run build:js`'s `js/dist`, gzip 6 and brotli 11 by Node's
  `zlib`). An app with such a stream moves to this shape: drop the stream's route and handler,
  put `ReadAgain::now` inside the part where the `<corten-live>` was, and hide the link under the
  part's `[aria-busy]` instead of showing it on `corten-live[status="closed"]`. Choices 7 and 44 are rewritten: declarative shadow
  DOM places a part streamed later without a script only at a slot of a shadow tree around the
  page, as a child of a host still open, and Chromium's `<template for>` (on by default since
  Chrome 150) anywhere in the page, but Firefox and WebKit not at all, so Choice 7, reopened, keeps
  pages whole; `scripts/dsd-probe.mjs` checks both again
  ([#1400 A slow part costs a second route, a stream handler that repeats the page's read and two waiting states, where one handler could answer the page and its part](https://github.com/corten-run/corten/issues/1400),
  [#1462 A patches route's handler whose part needs its own read cannot answer its page without building a patch it will not send: only patch_or turns a page into HtmlResult<Patches>, and it takes the patch already built](https://github.com/corten-run/corten/issues/1462)).
- `serve_wrapped_with` carries a TLS handshake's value to each request as
  `ConnectionInfo<T>`, readable by handlers (including a documented API's, where it adds
  nothing to the document) and `Identify`. The existing serve paths carry no value;
  connection limits, timeouts and shutdown still cover the handshake.

- The watchlist smoke's first field change after a link now tests a same-shell page swap, with
  the field module held back, rather than racing the scripts of a full document load.

- Permit custody-only terminal retirement of the exact r21 lean catalog attempt
  if ordinary native collection refuses its failed evidence. Keep original raw
  failures, source/reservation/archive binding, live-job refusal, current ownership
  and quiescence proofs, separate reviewed approval and single-delete confirmation.
  This is cleanup eligibility, not benchmark validation or permission to stop a run.

- **Breaking:** a view that could be a patch (each top-level element has an `id={..}`) in a shape
  the runtime's parse loses wherever it is written no longer compiles: a table part (`<tr>`,
  `<td>`, `<th>`, `<tbody>`, `<thead>`, `<tfoot>`, `<caption>`, `<col>`, `<colgroup>`) after a
  first `<table>`; an element HTML's wherever it lands (a `<p>`, a `<div>`, a `<table>` ..) after
  a first `<col>`; and after a first other table part, a `<table>` at the top level or in a later
  element, and a `<form>` there that holds an element, with an element HTML's wherever it lands in
  or around it (a `<form>` holding a `<div>`, or one in a `<div>`). Each was dropped, the table
  taken apart or the form's content moved out of it, in the browser with only a console error.
  Send the table part inside the `<table>`, the `<col>`s in a `<colgroup>` with an id, or the rest
  in a patch of its own. Every other shape depends on what the patch began with or where the view
  is written (a `<p>` and a `<tr>` after it are kept after a first `<tr>`, and an `<svg>` keeps a
  `<form>` of fields after a `<tr>`), so it still compiles and the debug check below finds it
  when it is sent
  ([#1409 A patch that puts a table row beside other top-level elements loses the row: the runtime's template parse drops it, and only a console error says so](https://github.com/corten-run/corten/issues/1409),
  [design Choice 54](docs/design.md#choice-html-parse-refusals)).

- A debug build refuses a patch the browser would lose part of: the runtime parses a patch as a
  `<template>`'s content, where the first top-level element (other than a head's, such as a
  `<script>` or `<template>`; Chromium and WebKit let a leading `<title>`, `<base>`,
  `<basefont>`, `<bgsound>` or `<noframes>` decide) decides how the rest is read, so a table
  row, cell or other table part beside another element was dropped (or a `<table>` or `<form>`
  after a row taken apart) with only a console error about the next element. `action.patch`,
  `req.patch_or`, `req.invalid` and `form.draw` now answer it with a 500, and a `corten::live`
  fragment panics, naming the element lost and the one that came first, so an app's own
  debug-build tests that draw such a patch now fail; a patch with a token the check does not read
  as the browser does, whether `html!` writes it or markup placed with `raw` does (an end tag left
  out, written otherwise than `</name>` or that closes no element open; an HTML start tag ending
  `/>`; a comment a browser ends elsewhere than at its `-->`; a CDATA section outside an `<svg>`
  or `<math>` or not ended; a doctype other than `<!DOCTYPE html>`; where text decides, a named
  character reference it does not decode, and text in a table holder or after a first `<col>`; an
  element HTML's wherever it lands written straight in an `<svg>` or `<math>`; a script whose text
  a `<!--` and a `<script` carry past its first `</script>` and over an element; in a form a
  table's reading empties, any token before what it holds but a comment; a start tag the patch
  ends in; an HTML `<image>`, `<plaintext>`, `<noscript>`, `<html>`, `<body>`, `<head>`,
  `<frame>` or `<frameset>`; after a first table part, a `<template>` in an SVG or MathML
  integration point, past which Firefox reads the rest as a body's; an element the browser does
  not put where it is written, such as a table part outside a table, a `<div>` in a `<p>` or an
  `<a>` in an `<a>`; the full list is Limit 2), is checked up to there and sent, with a warning
  naming where it stopped. A release build sends what it sent before; only `corten dev`'s check
  that each `data-vars` has a style rule, which reads start tags with the same code, now reads them
  as the browser's tokenizer does (whitespace around `=`, a `/` not before the `>`, names past
  ASCII, and the text of an `<xmp>`, `<iframe>`, `<noembed>` or `<noframes>`), which only markup
  placed with `raw` writes
  ([#1409 A patch that puts a table row beside other top-level elements loses the row: the runtime's template parse drops it, and only a console error says so](https://github.com/corten-run/corten/issues/1409)).

- Preserve type-token punctuation in `#[derive(Fields)]`, so group, row and key types
  written as paths compile, including keys of `#[fields(map)]` fields.

- `patch` takes `TrustedHTML`, not a string, so `corten check` refuses markup the browser's
  Trusted Types enforcement would reject. The scripts guide shows how to read a part again
  with a hidden GET `data-patch` form and `requestSubmit()`, or `ReadAgain::from`.

- Form controls named `parentElement`, `parentNode` or other DOM members no longer hang
  patching or stand in for the form's members that the runtime (patches, navigation),
  `shortcut()`, `view()`, `rows()` and the generated view classes read. A generated class now
  reads a hole whose path starts from a form, into it or past it, and a form's whole text through
  the platform's getters; its steps from any other element are unchanged
  ([#1531 Patching a form with a control named parentElement hangs the tab: the runtime walks parentElement, which the control shadows](https://github.com/corten-run/corten/issues/1531)).

- Apply supported lean settings to catalog-page competitors as well as Corten:
  reduce optional access logging, compression and timer work where supported,
  record the exact profile in container evidence and reports, and retain full
  source/rendering correctness. Richer groups keep their existing configuration.
  Keep ASP.NET's native Kestrel header/keepalive timers at their defaults: setting
  them to infinite caused early connection closure in Linux correctness checks
  ([#1564 Catalog lean ASP.NET fails native JSON correctness with connection errors](https://github.com/corten-run/corten/issues/1564)).

- Configure the standalone catalog Corten benchmark for the lean rendering
  workload: omit optional compression and remove handler/header/send timers using
  supported settings, while keeping page stages, error logs, full correctness
  checks and the HTTP-source timeout. Production defaults and richer benchmarks
  are unchanged; historical results keep their measured configuration. Keep the
  shared JSON API consumer's default compression build and timers by selecting
  lean build/runtime settings only in the catalog runner.

- Preserve completed catalog load/request failures as versioned, replayable failed
  app outcomes, separate from successful baselines and apparatus failures. Retain
  all passes, raw counters, participant lifetimes and side errors; require successful
  checker boundaries before any cold timing and attempt-wide upstream lifetime/CPU
  continuity. Reject unknown prior termination in v3 functional participants and
  require full lifetime-state consistency across observations. Summary-only reports
  reconcile failure ledgers and baseline disposition with retained phases before
  labeling an attempt complete. Keep HTTP error responses failed regardless of
  their media type, retaining their content-check failures; report successful
  throughput, failed requests and drops separately without excluding healthy peers
  ([#1556 Catalog benchmark discards failed-load metrics and cannot replay completed target outcomes](https://github.com/corten-run/corten/issues/1556)).

- The watchlist smoke's check that a submit which waited for a write the network failed is not
  sent holds that write until the newer press is made, and presses both buttons in the page, where
  it failed the write after a fixed 600 ms. On a loaded machine the newer press came after the
  failure, went out as a submit of its own and watched a stock that a later case then could not
  select, which ended the run in a 30 s `selectOption` timeout
  ([#1149 Smoke and check failures under load remain after the #1053 and #1102 fixes: a fixed 4 s wait on the formaction post, page loads past their 30 s timeout, and builds.test's touch case](https://github.com/corten-run/corten/issues/1149)).
  Runtime behavior is unchanged.

- Distinguish a failed benchmark account observation from uncertain worker lifetime
  only after native request/response/socket closure, a bound terminal reply and
  timely exit0. Preserve the failed operation and fresh cleanup proofs without
  retries, worker reuse or repeated mutations; uncertain paths keep their locks.

- Preserve closed rejection-site details for benchmark provider account requests
  through private-worker diagnostics and cached teardown, without exposing native
  errors or changing retries, credential use, acceptance or lifecycle locks.

- Launch only the first complete official benchmark group initially; require its
  replayed native evidence and confirmed cleanup before a separately approved,
  once-only admission of the remaining dedicated group hosts. Keep deferred groups
  visible, the complete registry mandatory and legacy collection available.

- Show the grouped controller's closed failure stage and allowed provider detail
  in direct CLI errors, without reflecting raw exceptions or changing recovery,
  cleanup or benchmark acceptance rules.

- `FeedUrl<Row>` now requires `Row` to resolve to the declarations `corten::types` generates
  (`import("../types/app").Row`), as `ScreenUrl<Data>` does. A local typedef, an import from
  another module, or an undeclared row name does not compile; generated imports and their
  aliases keep the feed's row type tied to the server's.

- A handler is given a form's control by its `#[derive(Fields)]` field,
  `on:change={js::fill(f.service, f.weight, f.size)}`, and its parameter is the control:
  `HTMLInputElement`, `HTMLSelectElement`, `HTMLTextAreaElement`, or `HTMLInputElement[]` for
  radios or checkboxes that share the name. The runtime finds it by name in the handler's form
  when the handler runs, so a component that draws the fields for forms with and without a
  script needs no ref, and the script looks nothing up by a name as text. Text where a field
  belongs, and a field where the handler takes text or another element, do not compile; a call
  that takes a single control (an input, select or textarea) whose form lacks it, has more than
  one of the name, or has one of another kind, throws, as does a group whose form has a control of
  the name that is not an input, saying what the call takes and what the form has instead, and
  `corten dev` reports the same when the page draws it (a group with none is `[]`). The lookup
  is a module of its own (`corten-field`, 741 bytes with gzip) that only a page whose handlers take
  a field loads, and reads the form's index of names, a few microseconds a run in a form of 2,000
  controls; every page's runtime is 66 bytes larger with gzip
  ([#1408 A script cannot be handed a form field as a typed element: it looks the control up by a name string the compiler does not check](https://github.com/corten-run/corten/issues/1408)).

- `App::access_log(true)` writes one tracing `INFO` event with target `corten::access` after
  every stage and app layer, with method, path without the query, the route that answered when
  one did, final status (a final `100` or `103`, which the HTTP/1 server answers as an empty
  `500`, as that `500`), body bytes (or `"stream"`; zero for a `2xx` to `CONNECT`) and duration
  to response readiness; a request dropped before its answer is ready writes none, and a
  subscriber may filter it on its fields. Off
  unless set, also in the app `corten new` writes. Uses the existing subscriber and escaping,
  which now copies text between control characters a run at a time. Measured: +9,619
  instructions on a parameter route (+54%), +8,173 on a `404`, with the line written to a sink,
  not stdout; off, within 12 of before.

- Clear only an already stopped, masked firmware unit's failed state during
  fresh benchmark setup, then recheck the mask, inactive state and service PID.
  Record fixed setup stages, source lines and original failure codes without
  dumping commands or environment; keep native cleanup and measurement gates.
  Install stable upstream Git from its fingerprint-verified, signed Ubuntu PPA
  directly in CI and fresh hosts, avoiding truncated Launchpad metadata API reads.

- The scripts guide gives `corten-format`'s size once, as built (3,005 bytes, 1,492 gzipped),
  where it said 1.4 kB in one place and about 1 KB in another, and `corten/keys`'s as built too.
  `npm run build:js` now writes the size a guide gives right after one of Corten's script modules
  (`corten-format`, `corten-upload`, `corten/keys`, `corten/read`), as it writes the runtime's in
  the README, and `npm run check` fails when one is not the built module's or is written another
  way.

- Read a date and time a visitor picks (`<input type="datetime-local">`) as the instant it
  names in the zone its form was drawn in: `corten::i18n::LocalDateTime` reads and writes HTML's
  local date and time syntax (`InvalidLocalDateTime` when it does not read), and
  `Entry<LocalDateTime>` keeps the text as sent (as `Entry<u32>` does). A page draws in a
  `corten::form::DrawZone` (`DrawZone::from(req.zone())`, `DrawZone::from(Utc)` on a `Public`
  page, `DrawZone::from(&input.zone)` when a refused post is drawn again): `zone.field(f.zone)`
  writes the zone as a hidden input, `zone.name()` shows it (`UTC` without JavaScript), and
  `zone.local(at)` writes an instant as the input's `value` (rounded down to the input's minute
  steps with `floor_minute`), and `zone.min(at)` and `zone.max(at)` as its bounds, to the minute
  and, where the clocks go back, at the offset that keeps every value between them inside them.
  A tz database zone draws and reads only where its rules reach (jiff's range, to late 9999-12-30
  UTC); past it a time is refused, not taken as UTC, and `Zone::known_offset` says where a zone's
  rules end. The post reads the hidden input as a
  `corten::form::FormZone` field, and `entry.at(&input.zone)` is the instant;
  `entry.at_keeping(&input.zone, stored)`, for an edit form, is `stored` when the field comes back
  as it was drawn. The compiler checks that a posted time is read only in a `FormZone` (not in
  `req.zone()` or a `DrawZone`), that a `FormZone` is made only by deserializing what a client
  sent (a form, a query), never from a zone, and that the hidden input is a `FormZone` field; a
  form that leaves out the hidden input still compiles, and its post is a 422.
  A skipped time moves forward by the gap and a repeated one is the earlier (Temporal's default,
  RFC 5545). `Entry` holds any sealed `corten::form::EntryValue` (a number, a `Day` for
  `<input type="date">`, or a `LocalDateTime`), and `day.start(zone)` is where a day begins in a
  zone: the first instant its clock reads the day, as Temporal's `startOfDay` gives, which where
  the clocks skip midnight is the change, even one that starts the day before (Toronto's day of
  1919-03-31 began at `00:30`) ([design Choice 59](docs/design.md#choice-local-date-time)).

- `Visitor` (`req.zone()`) gives the offset before a change of the clocks up to the change itself
  before 1970 too: jiff looks an instant up by its second toward zero, which before 1970 is the
  next second, so the last moments before a change (`1919-03-31T04:29:59.999Z` in Toronto) were
  read and written at the offset after it.

- **Breaking (for `#![deny(warnings)]` builds):** `Day::midnight_utc` is deprecated for
  `day.start(Utc)`, the same instant, so a crate that denies warnings and calls it no longer
  builds until it changes the call.

- Fullstack browser benchmark evidence uses bounded, authenticated, deduplicated JSON
  records and incremental raw-case hashing instead of one growing inline summary. The
  complete matrix, raw observations, native settings, safety ceilings and proof gates
  are preserved; bounded historical summaries remain read-only diagnostics.

- Scope the official cloud checkout's public umask to Git source creation so
  unprivileged load generators can read committed benchmark scripts. Keep job,
  control and campaign state private, with real Linux Git/nonroot regression
  controls and unchanged source, correctness and measurement gates.

- Make the watchlist smoke's waiting-submit cases dispatch each press in the page before
  changing fields or releasing held answers, so a loaded browser's early click acknowledgement
  does not race their busy, send-count and renewed-key checks. Runtime behavior is unchanged.
  Capture the first request before editing fields, and poll file output independently of
  animation frames, with the same outcome deadline and forbidden-send checks.

- A script reads a screen's data typed, from the route that answers it, with
  `read(url, { signal })` from the new `corten/read` module. A route that says `data = T` in
  `#[route(..)]`, whose `get` handler returns `HtmlResult<corten::Screen<T>>` (which only
  `req.screen` makes, given a `T` or a reference, `Box`, `Rc` or `Arc` of one), is a handler
  argument of type `ScreenUrl<T>`. The parameter must name the declaration `corten::types` writes:
  `import("../types/app").T`, `@import { T } from "../types/app"` or a `@typedef` of either; a
  type the script declares itself does not compile. `read()` asks the route with
  `Accept: application/json` through the browser's HTTP cache (an unchanged answer is a 304) and
  resolves to its `data`, typed as `T`. A route says `data` without `patches` or `rows`, and
  the same route mounted again by hand (`Area::route`, `Api::route`) with a `get` that answers a
  page or other data does not compile. `read()` follows no redirect. It rejects with a
  `ReadError`: `status` is the answer's (a signed-out `Caller`'s or `Refused::sign_in`'s 401
  included), or 0 when there was none it could use, with `redirected` true for a redirect the app
  wrote itself, else with the error as `cause` (offline, a `SyntaxError` for a success that is
  not JSON, a `TypeError` for JSON that is not a screen's). Once `signal` aborts it rejects with
  its reason, even after a failed answer. The module (749 bytes, 486 with gzip, 409 with brotli)
  is served and preloaded only for apps whose scripts import it; the runtime is unchanged. A
  static script's import of `corten/keys` or `corten/read` is now looked for outside its
  comments, so a `corten/keys` named only in a comment no longer stops the app
  ([#1399 A script cannot read its page's typed data: req.screen answers data clients JSON, but a script's only typed input is a handler argument written into the page](https://github.com/corten-run/corten/issues/1399)).

- **Breaking:** `req.screen` and `req.screen_with_status` take a type parameter for the answer's
  kind, `<For, Kind, T>`, so a call that names their types with a turbofish names three. Where
  `req.screen::<ForOne, _>(&data, doc)` was written, write
  `req.screen::<ForOne, corten::AnyAnswer, _>(&data, doc)` (or leave the types to the handler's
  return type). Calls without a turbofish are unchanged, except a `req.screen(..)` given straight
  to `Public::new` or `NoStore::new` where no return type names the answer (a closure), which
  fails with E0283 and names the kind the same way, `req.screen::<_, corten::AnyAnswer, _>(..)`.
  `action.patch`, `action.patch_with_status`, `patch_or`, `invalid` and `invalid_with` answer
  only as `AnyAnswer` or `Patches` (the sealed `corten::answer::PatchingKind`), so a handler that returns
  `HtmlResult<Screen<T>>` cannot answer through them, and code of an app's own that is generic
  over an answer's kind and calls them bounds it `K: corten::answer::PatchingKind`. A `Route`
  written by hand (`impl corten::Route for ..`, not `#[derive(Route)]`) names what its screen
  answers a data client: add `type Data = corten::route::NoData;` to the impl. Code of an app's
  own that is generic over a route and mounts handlers at it (`area.route::<R>(methods)`,
  `api.route::<R>(methods)`) bounds it `R: corten::Route<Data = corten::route::NoData>`, a route
  that names no data (E0277 otherwise)
  ([#1399 A script cannot read its page's typed data: req.screen answers data clients JSON, but a script's only typed input is a handler argument written into the page](https://github.com/corten-run/corten/issues/1399)).

- Verify the cancelled mixed campaign's captured source blobs and every selected
  build context against its original authenticated subject before retirement;
  refuse equally incomplete wrapper and custody copies without deletion intent.

- Add an explicitly approved, single-attempt cancellation path for the exact old
  r21 mixed source-review wait. Signal only its verified pidfd-owned campaign entry,
  preserve the wrapper's terminal archive and all nine contexts, and require
  separate terminal custody and fresh retirement guards without audit approval or
  source qualification. Retain uncertainty and prohibit repeated signal/DELETE.
  Bind cancellation and mixed terminal custody to the original uploaded control
  manifest, independently of later launch-template changes.

- Bound matched Spring marketplace upstream reads with the native ten-second
  timeout and map typed header timeouts to MVC 504 responses; retain default
  behavior and the documented caller-disconnect limitation.

- Bound Drogon marketplace page source reads with the existing native deadline and
  caller-disconnect lifetime, preserving request-local trace context.

- Save bounded, structural same-page browser diagnostics when native compiled
  alert hydration checks fail. Retain only closed categories and numbers, not
  browser text or URL paths; keep readiness gates and their errors unchanged.

- Include the observer's durable writer in the fixed native replay source closure;
  keep deny-unlisted imports and replay captured commit bytes, not checkout edits.

- Verify the standard cloud-init instance selector by pinned descriptor and exact
  owned host ID during failed-native custody. Keep all other paths link-free,
  require matching instance identity and empty regular user data, and refuse
  selector, ancestry or file replacement during each terminal proof.

- Bound failed-native retirement proof age from the final SSH request's local
  start, including response delivery, and refuse expired DELETEs after asynchronous
  HTTPS socket/TLS setup without queuing a mutation before readiness.

- Extend failed-native custody eligibility only to the exact r21 catalog host
  attempt measured at `dbe1a34c753ee8ef4ac9927484dc3930d36f6e37`. Retain original
  failed evidence and all terminal/deletion fences without qualifying it or
  changing ordinary collection or the original migration.

- Add an explicitly approved r21 failed-native custody/retirement action, separate
  from benchmark qualification. Preserve original failure evidence and all reserved
  native roots before fresh terminal-host checks and one owned deletion attempt;
  stream directory admission within global evidence budgets and carry the final
  proof's absolute expiry through private provider dispatch. Keep ordinary
  collection gates and uncertain-delete reconciliation unchanged.

- Probe the marketplace JSON route's method rejection with POST, which the page
  form implements, rather than requiring an app to implement DELETE somewhere.
  Keep the JSON 405 requirement and all production qualification gates.

- Copy stable installed dependency hardlinks into independent hardening evidence,
  retaining source identity and mutation checks, bounded no-follow reads and
  single-link saved evidence. Report bounded relative-path rejection diagnostics.
  Pin snapshot output directories before creates/writes and retain output
  identities through sealing, rejecting directory/junction and file replacement.
  Refuse unqualified Linux output filesystems before creation, including WSL
  DrvFS/9p where descriptor child paths can create through a replaced directory.

- Keep asynchronous benchmark observer startup owned through cancellation and
  early native exit; dispose abandoned setup without late capture or a terminal seal.

- Keep benchmark host sampling off synchronous record flushes with one bounded
  asynchronous filesystem FIFO. Preserve per-record file/directory durability
  before referencing sample writes, strict continuity and cancellation gates;
  do not seal unfinished or failed storage or reinterpret historical failures.

- Resample complete benchmark host scopes within the existing one-second window
  when process churn invalidates a census, and require matching recursive
  membership bookends. Keep PID/start, executable, accounting, observer-error and
  positive-empty cleanup gates; roll back executable captures from rejected
  attempts and observations without closing earlier accepted inputs. Do not
  reinterpret retained failed evidence.

- Retain raw host process stat evidence and exempt only identity-bound Linux kernel
  threads from grouped benchmark user-process cleanup. Prepare fresh disposable
  hosts against firmware-service activation before baseline; keep new user-process
  leaks and unproved historical inventories fail-closed.

- Retain omitted optional Docker image/container command defaults as explicit null
  in JSON, catalog and marketplace benchmark evidence and the JSON audit handoff.
  Missing or malformed image configuration, malformed execution and substituted or missing
  required nonempty container commands remain invalid; no image or workload changes.

- Publish synthetic benchmark fixtures with explicit readable file permissions
  and search-only bind roots, including under the private campaign umask. Keep
  neighboring evidence private and contender users/read-only mounts unchanged.

- Document a bounded read-only export of live JSON/mixed audit subjects and
  immutable snapshots for independent review, followed by the existing exact-
  subject delivery and terminal collection. Include quota-backed private workspace
  setup, metadata-first preflight, fresh snapshot destinations and clean Node
  startup. No active-campaign collection or automatic approval is added;
  target-host transport still needs qualification.

- Replay live group phases using the saved campaign's exact scope and group order,
  including ordinal zero on a dedicated host. Require the matching campaign plan,
  selected binding and host reservation without relaxing native/lifetime seals.

- Project benchmark create responses onto the positive droplet/action IDs rather
  than gating on unused advisory link text. Fixed-origin action polling still
  proves exact create completion; explicitly join its droplet ID to the freshly
  observed owned host before provisioning. Keep one POST, original deadlines,
  account/ownership, settlement and terminal-only cleanup gates unchanged.
  Recheck the original absolute deadline before granting completed-action success;
  late completion stays uncertain and cannot authorize provisioning.

- A page's several writes are named posts of its own route, `#[route("/inventory", get = show,
  post(price) = set_price, post(photo) = add_photo)]`, so a screen with several writes declares
  its query set once instead of on a route per write to redirect back to the same view
  ([#1403](https://github.com/corten-run/corten/issues/1403)). The routes module gives the route a
  method per name, `action={at.price()}` or a button's `formaction={at.photo()}`, whose address is
  the page's own with `do=price`; the router chooses the handler from the address alone, so a
  urlencoded form and a multipart upload are chosen alike and the handler's extractor still owns
  the body. A post with no `do` goes to the plain `post`; an unknown name, `do` sent twice or no
  `do` without a plain `post` is a 400; a `GET` of a post's address draws the page. A name with
  no handler, two handlers for one name, a route with posts but no `get` or in an API's module, a
  query parameter named `do`, and a redirect to a post's address do not compile. A debug build
  answers a page of a route with named posts, drawn at a `do` address, with a post form that has no
  `action` with a 500 (docs/design.md, Choice 53 and Limit 29). The watchlist's account page and
  the ui-gallery's draft use them.

- Preserve closed production-controller failure stages through fleet workers and
  saved receipts, distinguishing pre-reservation source and Git failures from
  launch, collection and teardown without forwarding raw errors or changing gates.
  Refuse later-host admission when its service is already terminal; preserve its
  started identity and evidence for collection instead of saving a false running state.

- A form's row can hold rows, and a map: `#[fields(rows)] #[serde(default)] conditions:
  BTreeMap<u32, Condition>` in the type of a form's rows names
  `f.rules.at(&1).conditions.at(&0).kind`, posted `rules[1].conditions[0].kind`, reads it into
  the maps inside the map and gives it its own error, so a list whose items own a list needs no
  key the app joins and splits by hand. Rows go as deep as the types do; a type whose rows reach
  its own type does not compile
  ([#1395 A form's row cannot hold rows, so a list whose items own a list (rules and their conditions, lines and their parts) needs a hand-built composite key](https://github.com/corten-run/corten/issues/1395)).

- Stage grouped benchmark host admission behind the first required group's
  source-bound common bootstrap, then admit remaining hosts serially while their
  benchmark jobs overlap. Preserve the complete registry and all measurement gates.
  Failed creates can be reconciled without provisioning and unused never-started
  allocations and terminal pre-native setup failures retired through normal
  collection with separate immutable evidence, one deletion intent and exact-ID
  absence confirmation, never a successful baseline. Early failure packaging does
  not depend on the Node installation or source clone that setup may not have made.
  A valid common-setup marker remains provenance, not native-entry evidence or a
  reason to strand a terminal host with an empty campaign.

- Distinguish benchmark provider census refusal predicates and finite href/count
  details without forwarding rejected values. Bound count-only census convergence
  by the original deadline and shared request limit; use exact-ID host observations
  after binding rather than repeated whole-account censuses.

- Earlier droplet-scoped create-link compatibility and href diagnostics are
  retained as historical evidence. The current ID projection above replaces hint
  spelling checks; incomplete or misbound authoritative actions remain refused.

- Earlier create-link refusal diagnostics remain readable as historical evidence;
  current refusals cover consumed IDs and authoritative action proofs rather than
  unused link text. Checkpoint failures retain coarse phase codes.

- **Breaking:** Apps with scripts require TypeScript 6.0 or later. `corten check` names an
  older installed compiler and the minimum version before checking the runtime's DOM types.
  Version comparisons include prerelease ordering: a 6.0.0 prerelease is below the minimum.

- Corten's own checks use TypeScript 7.0.2, matching npm's newest stable release installed by the
  getting-started guide, and use its DOM declarations for the Navigation API. Move the
  repository's AST checks off the removed JavaScript API, using the exactly pinned compiler's
  unstable native parser API until a stable parsing entry point is available.
  Keep navigation `info` checked in both the listener and its `startedBy` helper through one
  shared narrowed event type, with compiler regression probes for both reads.
  Select 7.0.2 explicitly through the `typescript7` npm alias; retain root TypeScript 5.9.3
  only for benchmark tooling's classic compiler API, avoiding colliding `tsc` bins in Corten checks.
  A broken checkout compiler directs contributors to `npm ci` in that checkout, not a global install.

- Accept omitted optional `rel`/`href` fields on benchmark provider create links,
  while still requiring one positive action ID and exact droplet-bound completed
  action proof. Conflicting supplied fields remain rejected; no mutation is retried.

- Validate Django marketplace fixtures at startup and fetched records before every
  JSON, page or write response, retaining complete numeric schema and requested-ID
  checks without repeating validation on fixture reads or successful POSTs.

- Permit paced fresh complete benchmark provider censuses after transient count or
  total mismatches within one original deadline and global request limit. Partial
  results remain rejected; HTTP errors and mutations are never retried.

- The kit's `Checkbox`, `Radio` and `Switch` draw their label, the whole click and tap target,
  at least `--control-height` tall wherever they are used (in a list, a table cell or a toolbar),
  as a button or field beside them is, so a theme that sets it to 2.75rem gives them a 44 px touch
  target too; before, the label stayed 20 px whatever the theme said. A dense row sets a lower
  `--control-height` on its container. A label that wraps grows, its box on the first line's
  middle. The label is border-box, so a `min-height: var(--control-height)` an app gave it as a
  workaround adds nothing and can go. The kit theme's `--choice-list-gap` drops from .75rem to
  .25rem, so with the kit's theme a `Checkboxes` or `RadioGroup` row is 2.25rem tall and its
  choices are 2.5rem apart (2rem before), the first choice's text .5rem further under the legend.
  An app with a copied `checkbox.css`, `radio_group.css` or `switch.css` takes the change with
  `corten ui add --force`, or `--merge` for an edited copy (`corten ui diff` shows which). A theme
  that declares `choice-list-gap` at the kit's old .75rem (one `corten ui init` wrote, or one that
  took `corten ui add`'s suggested line) keeps it, so once its copies are updated its rows are 3rem
  apart unless it sets .25rem in `tokens/ui.tokens.json`
  ([#1388 Kit Checkbox, Radio and Switch ignore --control-height: their label, the whole target, stays 20 px when a theme makes every other control 44 px](https://github.com/corten-run/corten/issues/1388)).

- Preserve sanitized provider diagnostics and control uncertainty from grouped
  benchmark workers in fleet failure receipts, without exposing raw errors or
  changing launch, settlement, lock or cleanup gates.

- **Breaking:** Raise the minimum supported Rust from 1.88 to 1.89 so `corten-cluster` and
  listings-feed can use async-nats 0.52. It fixes a received header containing a carriage
  return panicking the subscriber's connection task; 0.51 also fixes JetStream hangs and
  spurious missing-heartbeat errors. [Choice 51](docs/design.md#choice-msrv) records when the
  floor moves and why SQLx stays on 0.8.

- **Breaking:** An app using `corten-cluster` must depend on async-nats 0.52, since
  `Cluster::start` takes an `async_nats::Client`. 0.52 removes `From<&str>` and
  `From<String>` for `HeaderValue`; use `HeaderValue::try_from`, `from_lossy` or the
  `insert`/`append` methods that take a string. Such an app also takes 0.51's changes: new
  error-kind variants, new public consumer fields, websocket errors as tokio-websockets 0.13
  types, recreated ordered consumers named `{name}_{n}` and the JetStream context timeout as
  the only bound on its API requests (upstream's breaking changes for
  [0.52](https://github.com/nats-io/nats.rs/blob/async-nats/v0.52.0/async-nats/CHANGELOG.md#breaking-changes) and [0.51](https://github.com/nats-io/nats.rs/blob/async-nats/v0.52.0/async-nats/CHANGELOG.md#breaking-changes-1), and 0.51's
  [behaviour changes](https://github.com/nats-io/nats.rs/blob/async-nats/v0.52.0/async-nats/CHANGELOG.md#behaviour-changes-1)).

- Record RUSTSEC-2026-0459 in auction-room's bundled SQLite as an explained exception
  ([Choice 51](docs/design.md#choice-msrv)): it needs a database file a less trusted party
  wrote, and the example opens only the file its operator names in `DATABASE_URL`, never a
  user-supplied one.

- Bind dedicated workload-group hosts to a complete current-registry fleet roster,
  exact source and provider identity. Preserve native group defaults and complete
  contenders; permit only exact reserved sibling hosts, require room for the whole
  fleet, and keep single-group evidence distinct from a completed official round.
  Run controllers on isolated parallel worker event loops from verified source
  snapshots, collect each host independently, and replay the full roster read-only.
  Match failed inspections to the exact reserved selection before cleanup.
  Keep parallel Git proofs on exact observed commits without shared-ref writes,
  and bind nested native validation to captured committed code and a pinned parser.
  Existing all-group reservations and uncertain-host recovery remain separate;
  local workload verification files run serially without changing measurements.
  Reject altered benchmark source bindings and evidence manifests with strict
  boolean comparisons and bounded diagnostics, without formatting enormous diffs.

- Link to [corten.run](https://corten.run) from the README's introduction.

- Record [Choice 49](docs/design.md#choice-release-verification): verify release archives with
  GitHub artifact attestations and `SHA256SUMS`, without a minisign signing key. Binstall users
  follow the documented manual check before installing the binary.

- Retry entire host-lifetime snapshots for comm-only bookend changes within the
  existing three-attempt budget. Every accepted identity must still match in full;
  PID/start changes, retry exhaustion and the one-second continuity gate stay strict.
  This repairs a demonstrated local native churn race, not an established r21 cause.

- Retain bounded first/last host-lifetime observer failures with fixed operation and
  allowlisted error codes, without saving raw errors or weakening identity, retry,
  continuity or cleanup proof. This adds diagnostics; it does not establish or repair
  the historical r21 failure's cause.

- Make generated catalog fixtures and Gin's public static assets readable by native
  non-root image users under a private job umask. Preserve original catalog checker
  errors when negative-response receipts are missing or invalid, without accepting
  failed checks or starting timing; add private-umask native Gin CI coverage.

- Preserve bounded provider failure-phase codes and allowlisted HTTP statuses through
  grouped cloud worker IPC, teardown and CLI errors, without printing native errors,
  raw responses or credentials, or changing provider validation and recovery rules.

- Preserve captured `ProgramData` only for grouped cloud SSH/SCP children so Windows
  OpenSSH can initialize with the sanitized environment. Git/doctl environments and
  credential handling are unchanged; local configuration-only checks make no connection.

- A navigation that keeps the user's place (`data-keep-place`, or a page reading itself again for
  `ReadAgain`) finds the focused control by name inside its nearest ancestor with an id and leaves
  inputs of `type="hidden"` out of its index, so a repeated filter field in a hidden input no
  longer takes its place, nor does a copy in another form when the filter's form or rail has an
  id. Disabled controls, ones with the `hidden` attribute and ones inside an `inert` element still
  count, and the control is looked for again in `<main>` only when nothing under its ancestor
  matches. A matching field that switches to or from `type="hidden"` across the swap now counts as
  inserted or removed, so focus may be left unrestored or go to another field; give the control
  its own id ([Limit 28](docs/design.md#limit-keep-place-identity))
  ([#1372 A data-keep-place navigation gives focus to a hidden input with the focused control's name and value: placeOf matches any input in main by index](https://github.com/corten-run/corten/issues/1372)).

- **Breaking:** Require matchit `=0.9.2` exactly, so a fresh app resolves the matcher Corten's
  tests run
  ([#1368 A new app resolves matchit 0.8.6 while Corten tests on 0.8.4, and the two match an empty path segment differently](https://github.com/corten-run/corten/issues/1368)).
  An empty segment no longer matches a path parameter anywhere: `/items//edit` used to reach
  `/items/{id}/edit` with an empty `id`, and is now a 404 unless another route, such as a
  catch-all, matches it. To keep such a request working, give the empty case a route of its
  own (`/items/edit`) or move the value to the query (`/items/edit?id=`). A `#[derive(Route)]`
  link with an empty path parameter between two segments, which used to write `//`, now does
  what one at the start or end of the path already did: a debug build panics naming the route
  and field, and a release build writes `%FF` after it, which the route answers with a 400, and
  logs an error once for each route and field. Cargo takes one matchit 0.9.x per build, so an
  app with another dependency that needs matchit 0.9.3 or later cannot resolve until Corten
  moves the pin, and a matchit fix reaches apps in a Corten release. A matched request costs
  about 50 instructions more (0.29%) and a 404 about 11 more (0.06%). Derived, area and API
  routes match and insert as before apart from empty values; a `Route` implemented by hand
  with text before a parameter (`/a{x}/{y}`) and given to the hidden `Routes::__route` now
  meets 0.9's prefix and suffix conflict checks, and some such pairs stop the app in one order
  only (`/{z}/b` after `/a{x}/{y}`; design Choice 48's known limit).

- Keep grouped cloud create actions with a numeric zero resource ID pending until
  the matching action completes with the exact owned droplet ID. Preserve strict
  identity/link checks, bounded polling and the single-create rule; this fixes a
  synthetic API-schema compatibility case, not a confirmed cause of the r21 failure.

- Reweigh HTTP/2 in design Choice 25 and keep the proxy requirement for now. The browser cap
  is about six HTTP/1.1 connections per host; an eight-tab direct-TLS check passed over h2 in
  Chromium and Firefox. The opt-in prototype missed a flow-controlled send timeout and left
  its idle watch permanently busy. Its partial-header probe with an open stream did not show
  a regression from HTTP/1.1. Publish the partial evidence and follow-up criteria, and put
  the proxy caveat beside the README's production-defaults claim.

- Add a versioned workload-group registry with the approved popular and performance-oriented
  challengers, separate functional-parity and measurement coverage, and explicit retained
  benchmark families. The localized-marketplace selection reuses existing strict gates;
  native qualification and complete group measurements remain separate from source registration.

### Added

- `corten::script::Keyed` and `corten::script::NoKey`: the fourth type parameter of `Ref`,
  which says whether a ref's elements have a `key={..}`, so a handler parameter typed
  `Map<string, El>` takes only a keyed ref. A component's prop for a parent's keyed ref names it
  `Ref<El, NoRows, NoValue, Keyed>`; `Ref<El>` is `NoKey`
  ([#1329 A `Map<string, ..>` handler parameter accepts a ref whose elements have no `key=`, so a forgotten key compiles and the handler gets a one-entry `Map`](https://github.com/corten-run/corten/issues/1329),
  [design Choice 46](docs/design.md#choice-ref-values)).
- Bind native browser DOM evidence to bounded public reads, the actual document and
  network origin, with exact replay and separate semantic and apparatus lifetimes.
  Unsupported structure, private data, missing proof and uncertain cleanup remain
  ineligible; timed-out body reads retain capacity until their actual sends settle.

- Stream grouped cloud evidence through bounded physical-file hashing, durable copying
  and complete archive preflight before extraction. Explicit byte, node and path budgets
  cover the campaign phases without loading the complete archive into memory; oversized
  or invalid evidence remains preserved rather than truncated or promoted to a result.

- Run grouped benchmark evidence, isolated adapters and browser proof controls in
  dedicated serial CI suites, plus required real Linux process and Docker-participant
  controls in disposable delegated units. These checks do not stand in for native
  framework qualification or an official benchmark run.

- Preserve native passed-but-comparison-ineligible outcomes during grouped collection,
  including dependency-policy and whole-group timing gates. Failed and unsupported
  outcomes remain ineligible; host ownership, evidence and cleanup checks are unchanged.

- Quote Spring's colon-bearing htmx attribute name in the native Thymeleaf layout,
  restoring catalog and marketplace HTML without changing boosting behavior or checks.

- Refresh the native Rails, Phoenix, Gin and Drogon live build inputs to reviewed
  stable versions and immutable base images. Bind deployment runtime descriptions
  to those sources; changed inputs still require new qualification evidence.

- Keep the native Razor and AOT benchmark CI test SDKs aligned with their production
  Dockerfiles, so a runtime upgrade cannot leave the test jobs on an older SDK.

- Preserve literal route, scoped-package and vendor-version filenames when collecting
  native benchmark evidence. Collection, archive and artifact namespaces share the
  portable-name check without decoding names or relaxing traversal, link or collision checks.

- Prepare current Git in the browser CI image so native immutable-source checks run
  with replacement objects and lazy fetching disabled, instead of failing on an older CLI.
  Run source-replay checks as the checkout owner, retaining Git's ownership protection.

- Register the native Rails, Phoenix and Laravel live ports without promoting
  historical captures. Retain Livewire/Reverb wire and DOM evidence, including
  negative HTTP controls and request timings on failed journeys; Laravel's
  observed native-feed deadline misses remain unqualified outcomes.

- Align server build recipes with the refreshed Python 3.15 and Java 27 images,
  the native Spring JSON check with its production toolchain, deployment runtime
  descriptions with their current sources, and the Express Node/Bun comparison
  with the reviewed htmx 4 artifact. Changed inputs require new native qualification;
  older captures remain historical.

- Bind grouped comparison eligibility to the committed offline latest-stable dependency
  policy while preserving every contender's native outcomes and failed evidence.

- Reconcile grouped deployment manifests with the checked-in Node 26 and .NET 11
  launch paths and native Corten/Topcoat/Leptos live ports. Source registration remains
  separate from qualification; no older captures qualify changed images.

- Align the native Corten parity and Leptos live Dockerfiles with the reviewed
  digest-pinned Rust/trixie production toolchain and cargo-leptos version. Prior
  captures remain historical, not qualification of the new image inputs.

- Pin grouped benchmark helper images, native live Express and the Express/Bun
  Node comparator to Node 26.13.1 by immutable digest. Retain their separate
  native qualification requirements instead of borrowing older runtime results.
  Django's local production-qualification helper uses that same upstream pin.

- Capture request-local marketplace trace context in Gin, Drogon and Topcoat,
  preserving native rendering and source clients. Keep Drogon's native parser
  normalization and repeated-header failures explicit; this does not qualify
  that contender for traced production work. Add an opt-in native instruction-cost
  diagnostic with complete dump validation and all-resource cleanup.

- Register the native Topcoat keyed live application in its selected recoverable-live
  group, retaining its runtime WebSocket and app-local replay/acknowledgement bounds.
  Historical missing-port evidence stays unchanged; functional integration is not a
  completed group timing baseline.

- A value the markup gives an element for its script is the element's ref's: `ref={row.with(cents)}`
  (a number, text or a `bool`), and a handler parameter typed `Map<HTMLTableRowElement, number>`
  gets every element of the ref with its value, a number as a number. The call is checked as any
  ref's is, so a ref whose elements give no value, give one of another type, or give one on some
  elements and not others does not compile, where a `data-` attribute read through `dataset` was
  text on both sides that nothing checked. `examples/card-market`'s listing sort reads its cents
  this way, and the scripts guide recommends it for rows a script only reorders;
  `examples/corten-site`'s wall, `apart.js` and `answer.js` read their values the same way. Measured
  against `main`: the runtime is 107 bytes larger raw, 21 with gzip and 24 with brotli;
  card-market's item page, whose 22 listing rows (on average) each give a value, is 418 bytes larger
  and takes about 930 instructions more to render (2.4%); a page whose elements give no value is
  unchanged, to the instruction ([design Choice 46](docs/design.md#choice-ref-values)). An integer
  handler argument is now written as markup writes a number, with the same digits as before.
  **Breaking:** `data-ref-value` is printed by Corten, as `data-ref` is, so markup that writes it by
  hand no longer compiles; give the value with the element's ref. A spread of pairs (`{..attrs}`)
  now skips `data-ref-value`, `data-ref`, `data-on` and `data-scope`, whole names in any case, as it
  skipped `data-vars`, so pairs that wrote them are dropped; it costs at most five length-checked
  comparisons per pair, on pair spreads only. corten-ui's `rows::sort` still reads the `data-sort`
  an app writes (moving it onto ref values is
  [#1387](https://github.com/corten-run/corten/issues/1387)).

- Refresh the Rust benchmark inputs with pinned Rust/trixie build and runtime
  images, reqwest 0.13.5 throughout the assigned HTTP clients, cargo-leptos 0.3.12
  and native Topcoat 0.12.1. Preserve native rendering, exact alert readback and
  historical results; the new toolchain and dependency graph are new-round inputs.

- The marketplace browser gate observes native LiveView WebSocket and long-poll
  saves with exact form and reply correlation, waits for readiness before editing,
  and retains bounded case diagnostics on transport failure. Livewire saves must
  match the native component, item, locale and submitted values.

- Native marketplace runs retain raw load clocks, checks, counted CPU, memory,
  lifecycle, gate and cleanup observations. A read-only validator replays their
  complete matrix and exact aggregates; older results remain historical when
  required proof is absent. Replay does not establish independent source approval
  or host ownership, and does not change the recorded capacity outcomes.

- Release archives carry GitHub build provenance and a `SHA256SUMS` file. The release verifies
  every archive's provenance before publishing to crates.io or creating the GitHub release, and
  the install guide documents verification on Linux, macOS and PowerShell. `cargo binstall`
  still checks its download only by HTTPS.

- A read-only saved client-heavy evidence validator checks source identities,
  native bundles, observations, outcomes and resource/timing consistency without
  executing archived code or contacting a network. Historical v1 captures remain
  blocked from qualification and verified timings when required proof is absent.

- Grouped catalog runs preserve versioned raw load, counted CPU, memory samples,
  cold-start, image/check and cleanup observations. An offline validator replays
  the complete native matrix, upstream identity continuity and exact aggregates; historical summaries cannot
  acquire missing evidence retroactively. Host isolation and independent source
  audit remain separate gates, not inferred from replay success.

- A native Drogon keyed live application uses its own acknowledged WebSocket
  delivery, bounded reader queues, snapshot recovery and reader-scoped cleanup.
  Group registration preserves original wire observations and historical missing
  outcomes; bounded correctness diagnostics are not a completed timing baseline.

- Native workload-group driver entry points retain all selected contenders and explicit
  failure/unsupported coverage. Deployment manifests separate representative production
  choices from performance candidates and bind qualification to exact native evidence.
  These local apparatus integrations and read-only plans are not completed group baselines
  or automatic qualification of alternative runtimes.

- Native Rails, Laravel and Phoenix marketplace alert stores expose independent,
  session-isolated readback for accepted writes. Their adapters retain native
  LiveView, Turbo and Livewire behavior; group qualification remains separate.

- Native Corten, ASP.NET and Express marketplace reads retain request-owned
  cancellation and explicit trace context. ASP.NET and Express also bound
  unfinished form parsing and prevent a timed-out parser from resuming routing.
  Express flushes the timeout response before closing an unfinished upload and
  cancels body-parser's native decompressor as well as its incoming request.
  Real-socket probes retain caller-abort, upload, JSON-error and alert-readback
  outcomes. The original Corten stalled-body abort failure remains unresolved;
  later passing probes are not a complete group qualification or timing baseline.

- Native Drogon, Gin, Topcoat and Leptos marketplace forms persist accepted alerts
  in isolated cookie sessions, with independent readback and no append after
  invalid input, incomplete records or failed native rendering. Confirmations use
  the exact stored minor amount. Leptos retains its enhanced server action and
  plain form fallback; the other adapters retain their native renderers and forms.
  Gin's opt-in production profile adds native security headers, host checks,
  compression, body/connection bounds and upstream-independent liveness. Native
  browser and HTTP checks remain separate from comparative load qualification.

- Native FastAPI, Django and Spring marketplace page, JSON and alert source reads
  forward trace headers per request, without changing shared client headers or
  successful payloads. Concurrent, delayed and untraced native HTTP regressions
  check isolation, including non-ASCII header bytes in FastAPI and Django. These observations
  support source auditing; they do not qualify mixed-workload performance.

- Native Next.js, Nuxt, React Router, SvelteKit, Astro and TanStack Start
  marketplace forms persist accepted alerts with session-isolated readback,
  preserve their framework's enhanced and plain-form paths, and reject writes
  whose source or rendering input failed. Next.js, Nuxt, SvelteKit and TanStack
  Start guard pending same-form JS submissions to retain one session; these
  correctness changes are not a completed group baseline. The shared correctness
  checker recognizes TanStack's native generated server action only with matching
  same-origin submitted fields, while retaining plain-form checks.

- Native FastAPI, Django and Spring marketplace alerts persist accepted writes
  in isolated sessions with independent readback and no append after rejected,
  incomplete-source or render-failed submissions. FastAPI owns its page-source
  cancellation and deadline; Django WSGI and Spring MVC lifetime limitations
  remain explicitly failed capabilities, not completed group qualification.

- A native client-heavy runner exercises Corten, React, Vue, Solid, Svelte and
  Remix against the same keyed data and dashboard input. Independent visible-DOM,
  network and lifecycle gates precede a separate measured journey. Builds are
  fresh and source-bound; failed cleanup or qualification suppresses timings.
  Bounded local diagnostics are not an isolated performance ranking.

- Native Corten, ASP.NET Razor Pages and Express marketplace forms persist each
  accepted alert, with independent session-scoped JSON readback. Rejected forms,
  failed source reads and render failures do not append. This is process-local
  benchmark state, not durable storage or load qualification.

- Catalog runners preserve full native application stdout and stderr in raw evidence,
  rather than silently saving only the final 8 MiB of stdout. Bounded diagnostics no
  longer repeatedly copy growing log strings. Log-collection errors still fail the run;
  application settings, load thresholds and measurement windows are unchanged.

- FastAPI's native record JSON routes bound complete upstream reads, cancel them
  on caller disconnect and return generic JSON source/serialization errors.
  Opt-in request tracing spans native serialization without changing successful
  responses. Focused CI retains failure evidence; unexplained healthy-read errors
  remain an investigation, not a claimed fix or group load qualification.

- Native record JSON parity checks for Express, Spring and Drogon retain each
  framework's parser and serializer, complete payloads and JSON error/method
  behavior. Express and Drogon bound request-owned reads and cancellation; Spring
  keeps its existing source timeout behavior. Native pages and forms remain in
  place. These functional repairs are not source-audit receipts or load results.

- Gin's native catalog and marketplace JSON routes support GET/HEAD, generic JSON
  errors and uncached responses. Their shared native HTTP client refuses redirects,
  bounds complete reads and cancels work with the request. Existing templ pages and
  forms remain native; this is not production qualification or a group load result.

- Offline correctness contracts for the full-stack browser and client-heavy groups
  cover native navigation/forms, equivalent keyed state, operation-time HTTP and
  terminal resource cleanup. Reference helpers cannot supply native observations;
  these contracts do not qualify adapters or produce timings.

- Ordinary ASP.NET Core's catalog and marketplace JSON routes support native `HEAD`
  and Problem Details for JSON-compatible clients in both profiles. Page/form error
  handling stays separate; these functional checks are not production qualification
  or performance results.

- Native parity groundwork for Next.js and Django adds opt-in production transport
  and security settings without replacing their renderers. Next builds bind their
  profile and scope nonce-dependent rendering to that profile. Leptos's plain form
  fallback rejects cross-site posts before body/source work; axum retains native
  typed JSON with bounded source reads. Qualification limits remain explicit, not
  hidden as missing rows or claimed performance results.

- The separate ASP.NET Core Native AOT JSON adapter now supports complete catalog and numeric
  marketplace records through native source-generated serialization, with fixture-at-startup
  or uncached request-time HTTP sources. Focused source and native executable checks cover
  schemas, error responses, redirects, cancellation and deadlines. Ordinary ASP.NET Core stays
  a separate challenger; this is not page parity or a group performance result.

- A catalog-page workload-group runner with page-only timing in both sources, retained native
  page and JSON correctness gates, immutable image bindings and checked after-run provenance
  and aggregates. Legacy catalog rounds keep their original validation. A separate JSON-only
  functional gate checks complete catalog and marketplace records, uncached upstream work
  and JSON errors without imposing page features; native serialization still requires source
  verification. Neither integration establishes a new baseline or cloud-run readiness.

- A separate native JSON API group runner retains both payloads and sources,
  functional observations, independent source-audit requirements and replayed raw
  timing/runtime evidence. An explicit-commit catalog-page droplet controller uses
  independent durable reservations, verified archives and terminal-only cleanup.
  Neither changes the nightly schedule or establishes a native group baseline.

- Offline correctness contracts for the approved mixed-traffic, live-delivery,
  recoverable-live and hardening groups. They preserve native transport/form behavior,
  independent state readback, bounded-resource cleanup and explicit failure outcomes.
  Synthetic contract tests are not native adapter qualification or measured results;
  runner integration remains pending.

- A nightly `bench/marketplace` group round can be split across droplets started together:
  `droplet.mjs rN --droplets <n> --detach` checks the checkout, existing droplets and the
  account's droplet limit once, writes the plan (commit, group and each droplet's candidates) and
  creates every droplet before starting any, holding `launch.lock` so collect waits for a live
  launch and a hangup does not stop it. Each droplet runs Corten beside a round-robin share of
  the group's other candidates (`run.mjs --group <g> --part k/n`), qualifies them with the
  group's feature contract and times only those it admits; a droplet with no admitted peer fails
  its part. `--collect` collects and deletes each droplet as it finishes, reports any leftover
  droplet, prints the command that stops each running droplet once one that never started, is
  partial or is missing means the round cannot merge, and merges the round only when every
  droplet has finished clean and every candidate of the group is accounted for once, admitted and
  measured or excluded with its evidence; parts that did not run together, or share a run, do not
  merge. The report shows each droplet's CPU and Corten in
  every table, each candidate's ratio to the Corten on its own droplet (`-` where either stage
  stopped), and flags a stage where
  Corten's own numbers differ between droplets beyond the pass ranges. A one-droplet round runs,
  reports and compares as before, and a split round compares only with one split the same way,
  each row naming its droplet
  ([#816 A bench round runs every app in sequence on one droplet, so its wall time grows with each app, tier and repeat, and it cannot be split across droplets and still compared](https://github.com/corten-run/corten/issues/816)).
- Feature-qualified marketplace comparison groups: popular and performance-oriented
  candidate pools share one deduplicated production run instead of timing the full inventory
  each night. Both sources must satisfy the same scoped production checklist, then the full
  localized browser/content gate; unsupported candidates are listed with missing features,
  not timed or silently dropped. No framework is an unconditional anchor. ETag and downstream
  readiness are disclosed exceptions, not claims of complete enterprise equivalence.

- The marketplace alert-form check saves the exact submitted case, POST status and response,
  current message and original timeout when the result message does not arrive. The
  React Router timeout from r19 remains unconfirmed as an adapter defect
  ([#1251 Benchmark r19: React Router fixture correctness times out waiting for an alert-form message](https://github.com/corten-run/corten/issues/1251)).

- `corten::caller::bearer(&headers)` reads the token of RFC 6750's bearer credentials
  (`Authorization: Bearer <token>`), the scheme `Challenge::bearer` asks an API's clients to use:
  the scheme in any case, one or more spaces, the token trimmed, and `None` for no
  `Authorization`, another scheme, `Bearer` with nothing after it, a value outside visible ASCII
  or two `Authorization` lines (RFC 9110 5.3). The `Challenge` and `Tools::auth` examples (now a
  compiled doctest, where it called an `auth::bearer` that does not exist) and card-market's
  partners and agents read with it in place of their own parsers
  ([#1225 Corten tells an API to take its key as a bearer token but gives it no reader, so each app parses Authorization by hand and the agent docs call an auth::bearer that does not exist](https://github.com/corten-run/corten/issues/1225)).
- The watchlist smoke checks three runtime behaviors it did not. A tapped link nothing hovered is
  prefetched at `touchstart`, and its visit uses that answer (Chromium and Firefox; WebKit's run
  has no Navigation API, so nothing is prefetched). An upload answered with a status that has no
  body is read with none: Corten's `204` redirect (`corten-location`) is followed with no
  `corten:error`, a bare `204` or `205` dispatches none (below), and a bare `304` is
  `corten:error` with that status (in Chromium and Firefox: Playwright cannot answer one in
  WebKit); one answered with a status of 600 is
  `corten:error` with status 0; the form is left not busy each time. Another file of the same
  name, chosen while a write sending the first is out, is sent after it, whether its size or only
  its time differs, where the same file pressed again is not. Each check failed against a runtime
  with the line it covers taken out
  ([#1229 Three runtime behaviors have no browser check: touch prefetch, an upload answered with a status a Response cannot have, and a same-name file sent as a new submit](https://github.com/corten-run/corten/issues/1229)).
- FastAPI and Express join `bench/fullstack`'s matched tier, so every app its membership names now
  starts with the profile. Under `PROFILE=matched` FastAPI adds Starlette's host list, gzip and body
  limit, the security headers and `Cache-Control` from the middleware FastAPI's tutorial gives,
  `HEAD` on the JSON, and uvicorn's connection cap (`--limit-concurrency`, a 503 past it, run as
  FastAPI's manual-server guide starts uvicorn); its matched matrix meets 15 of 24 columns. Express
  adds Helmet, its own `compression` and `connect-timeout` middleware, `Permissions-Policy` and
  `Cache-Control` as Helmet's documentation sets a header, and Node's 30 s header timeout and
  connection cap; it meets 17 of 24. Without the profile both apps answer as before
  ([#807 bench/fullstack has no tier where every app implements the same production features, so its tables mix framework cost with feature cost](https://github.com/corten-run/corten/issues/807)).
- `SubmitKey::template_field(f.submit)` draws a submit key field with no key, for a form inside a
  `<template>` that a script copies (rows of a list drawn in the browser), and the runtime gives
  an empty submit key a new one when its form is first sent, a `data-patch` form or a plain post,
  before any `on:submit` handler or listener added after the runtime loads (`requestSubmit()`,
  not `submit()`, which fires no event). Each copy is then a submission of its own; a copy of a
  template that held a key shared it, so the app applied only the first copy's submit, and a
  script had to carry its own UUID function to avoid that. A `SubmitKey` posted empty (without
  JavaScript) is still refused with a 422 naming the field, a debug build's page that draws
  `SubmitKey::template_field` outside a `<template>` a script copies (a declarative shadow root,
  `<template shadowrootmode="open">`, is drawn in the page and needs its own key) is an error, and a page
  whose only key field is a template's keeps its `ETag`. The runtime grows 27 bytes compressed
  ([#1254 A script cannot mint a submit key for a form it makes from a template, so copied rows share one key](https://github.com/corten-run/corten/issues/1254)).

- `examples/corten-site`: Corten's own site as an example. It is one page that demonstrates
  itself: a link reloads it with every script blocked, one of its components is shown as the
  lines where its three files meet, its own source is broken five ways with what the compiler
  said, and the server streams its own readings, with the memory it holds, the machine it is on
  and how much of its CPU and memory is in use (the machine's, or of the limits a container
  or a systemd unit holds the server to), where the system counts them. Tests hold what it says to
  `docs/performance.md`, the README,
  `docs/design.md` or its own source. `deploy/` and the `Site` workflow ship it to one small
  machine behind nginx as a systemd service: each change on `main` is tested, built, copied over
  SSH and switched to, and the release before is put back when the new one does not answer as its
  commit. The workflow does nothing until the repository names a machine. Its smoke test runs in
  Chromium, Firefox and WebKit, in CI's `webkit-gallery` group, and builds and draws the plate
  behind the page (one fragment shader, drawn after weathering steel) in Chromium, where it also
  reads that the plate is no brighter under the steel's type than the type can stand.

- `examples/corten-site/deploy/infra`: the machine that serves Corten's site as OpenTofu
  configuration for DigitalOcean (a droplet, an address that stays when the droplet is replaced,
  a firewall, and the DNS zone), applied on each change on `main` by the `Site machine`
  workflow with its state in a Spaces bucket. A droplet made from it is handed `provision.sh`,
  `nginx.conf` and the service file as it starts, waits until the site's name reaches it and
  sets itself up, so nobody signs in; a change to anything it is handed makes a new droplet,
  and the workflow then starts the `Site` workflow to ship it a release. The `Site` workflow
  no longer runs for a change to those files and the deploy guide alone, and `provision.sh`
  asks for the package lists again when another update holds their lock. `bootstrap.sh` gives
  the repository the two environments, the keys and the variables this needs, once. The
  workflow applies nothing until the repository names a bucket for the state. The site's
  service is now held to loopback (`IPAddressDeny=any`), which on a cloud machine keeps it
  from the metadata address.
- `examples/corten-site`'s machine slows one address that asks as fast as it can, where
  before one address asking for the page left another reader with none. One reader (an IPv4
  address or an IPv6 network of 64 bits) may ask nginx for 100 things at once and 20 a second
  after, have 100 answers on their way, and ask 100 times on a connection, and the machine's
  firewall lets it hold 256 connections and open 19 in a second; over the first two the
  answer is 429, and a connection over the last is let in when its sender tries again, a
  second later at the soonest. A request refused for asking too fast is written to neither
  of nginx's logs, nor are the redirects of port 80 and of other names. After an apply the
  `Site machine` workflow asks the machine for 300 requests and for 40 connections at once
  and for 250 requests one after another, and fails where it refuses, delays or ends too
  few. No limit keeps a request under it waiting, and one request in a hundred opens a
  connection; readers who share an address share its limits, and someone with many addresses
  is not slowed by them. The deploy guide has what was measured (What one address can do).
- `examples/corten-site`'s machine is replaced by one that already serves. A new droplet is
  handed the old one's certificate and the release it serves, and the address moves to it
  once it answers as the site; before, the address moved to a droplet that then took minutes
  to get a certificate and a release, and the site was away meanwhile. Every droplet lets one
  key, which the `Site machine` workflow alone holds, run one command as root that gives or
  takes those (`infra/handover.sh`), and the apply runs `infra/relay.sh` between making a
  droplet and moving the address: when the new droplet does not come to serve, the apply
  fails with the address where it was. A droplet that is handed a certificate asks Let's
  Encrypt for none. `bootstrap.sh` makes the key, and run again adds it to a repository set
  up before. Where nothing can be handed over (no key, or a droplet made before this) the
  address moves first, as it did. The workflow asks the site once a second while it applies
  and says how many went unanswered, and `gh workflow run site-machine.yml -f replace=true`
  makes a new machine where nothing has changed (`-f without_handover=true` makes one that
  is handed nothing). Rehearsed in containers, and run for corten.run, where on the one
  replacement that was handed anything the site answered each of 174 requests a second
  apart: the deploy README says what that leaves untried. `provision.sh`, when it runs a
  second time, writes in the deploy user's directories as that user: as root it made
  whatever a link there pointed at that user's, so the holder of the deploy key could become
  root. It stops for a key's file that is not there. The workflow's check runs the
  handover's command, those lines of `provision.sh` and the relay in containers
  (`infra/handover.test.sh`, `provision.test.sh`, `infra/relay.test.sh`).
- `examples/corten-site`'s machine sends other names on to the site's: the repository variable
  `SITE_REDIRECTS` (a JSON list, such as `["www.example.com"]`; `provision.sh`'s fifth argument
  by hand) gives each name a record at the machine's address and a place on the site's
  certificate, and nginx answers it on both ports with a redirect (308) to the same path at
  the site's name. A new machine serves the site under its own name first, then takes the
  other names on once each reaches it, so a name that is late or refused a certificate holds
  back only itself. A run of `provision.sh` asks for a certificate only when the names the
  one in place holds are not the ones given, and after an apply the `Site machine` workflow
  fails where a name does not send its visitors to the site. Port 80 now redirects to the
  site's name whatever host was asked for, not to the host the request named. A test of the
  site looks in the checkout for every file or directory the page links to in the repository
  ([#838 corten.run shows a Squarespace Coming Soon page: build the landing page as a Corten app, host it and point the domain at it](https://github.com/corten-run/corten/issues/838)).

### Changed

- A debug build answers a browser's plain request (no `data-patch`, asking for HTML) that a
  handler answered with `req.patch` or `req.patch_with_status` with a 500 that names the method
  and the route and says to answer with `req.patch_or` or build the patch from `req.action()`
  first: the browser would show the fragment as the whole page, with no layout, stylesheets or
  navigation. The handler's cookies and `Clear-Site-Data` go out with the error. The runtime's
  `data-patch` fetch and a client that does not ask for HTML still get the patch, and a release
  build compiles none of the check. **Breaking (debug builds only):** the test `Client` asks for
  HTML unless `.mode(..)` is set, so an app's router test that sends a plain request (no
  `.mode(Mode::Action)`) to a handler answering only `req.patch` or `req.patch_with_status` now
  gets a 500, as does `corten dev` when a browser loads that route itself. To move: answer with
  `req.patch_or(view, || async { .. })`, which draws the page or a redirect for a plain request,
  or return the patch only when `req.mode == Mode::Action`; a test that means the runtime's
  request sends `.mode(Mode::Action)`. A request whose fetch metadata says it is not a top-level
  navigation (`Sec-Fetch-Mode` other than `navigate`, as a page's own `fetch` sends, or
  `Sec-Fetch-Dest` other than `document`, as an `<iframe>` sends), a relayed upstream answer
  and an `unstaged` route are not checked, by this check or by the one for a page at a path with
  no `GET`. Neither is a navigation a service worker passes on with `fetch(event.request)`,
  which arrives as `navigate` to `empty`, the tab's and a frame's alike; one answered from
  navigation preload, as Corten's worker does, is checked. Browsers send fetch metadata only
  over HTTPS or to `localhost`, so a debug build opened over plain HTTP at a LAN address takes a
  page's own `fetch` that asks for HTML for a navigation, a false 500.
  The watchlist's smoke-only styled-note route redirects without JavaScript, and its dialog and
  `<details>` routes draw the sheet page with them open
  ([#1423 A patch answering a browser's plain post is shown as the whole page, and the #1340 debug check only catches a page](https://github.com/corten-run/corten/issues/1423)).

- **Breaking:** a handler parameter typed `Map<string, El>` takes only a ref whose every element
  has a `key={..}`: a ref without keys no longer compiles there, and the error says to add `key={..}`,
  where it compiled and the handler got a one-entry `Map`. A ref with a key on some elements and
  not on others does not compile, whatever its handlers take (`El`, `El[]` or a `Map`). A ref
  now carries in its fourth type parameter whether its elements have keys (`Keyed` or `NoKey`),
  fixed by the markup as its value's kind is
  ([#1329 A `Map<string, ..>` handler parameter accepts a ref whose elements have no `key=`, so a forgotten key compiles and the handler gets a one-entry `Map`](https://github.com/corten-run/corten/issues/1329),
  [design Choice 46](docs/design.md#choice-ref-values)).
- Debug builds stop a render in which two elements of a ref in one render of its component have
  keys the browser reads as equal (`key={true}` and `key=""` are one, and so are a carriage
  return and a line feed), or a `key={..}` writes none (`None`), since the `Map` would hold one
  entry for them. Whether it runs is `corten-run`'s debug-assertions setting, for every crate's
  markup. Release builds do not check, and the runtime is unchanged.
- The check counts the elements the runtime finds. It leaves out a `<template>`'s or a
  `<noscript>`'s content, and what an expression or a component writes into an element a browser
  reads as text (a `<textarea>`, `<title>`, `<iframe>`, `<xmp>`, `<noembed>` or `<noframes>`
  outside an `<svg>` or in its `<foreignObject>`, `<desc>` or `<title>`). It leaves out a key
  written with a reference Corten does not write (an app's own `AttrValue`). Where the markup
  cannot know how a browser parses it, it lets a duplicate pass: in a `<template>` or an element
  read as text at the top of a component's markup, which its parent may write into an `<svg>`,
  and among a component's children, which the component may write in an `<svg>`'s `<desc>`
  (unless they are in an `<svg>` of the children's own). Keys a view writes into a string of its
  own (`html! { .. }.to_html()` or `children.to_html()` as an attribute's value) are not its
  component's. A document's head tags, each copied into the page, are not checked against each
  other or the body.
- A spread of attribute pairs now skips `data-key`, as it skips `data-ref` and `data-ref-value`:
  a key is `key={..}`'s to write. A `data-key=".."` written by hand beside a ref is still taken
  as its key, a known limit: `html!` does not yet refuse it as it refuses `data-ref`.
- **Breaking:** a component that puts a parent's ref on elements with a key names the ref's type
  `Ref<el::HTMLTableCellElement, NoRows, NoValue, Keyed>` where it wrote
  `Ref<el::HTMLTableCellElement>`, and a ref that a `Map<string, El>` handler took with no keys
  gets `key={..}` on each of its elements.
- **Breaking:** three kinds of markup a browser parses differently from how it is written no
  longer compile (an element in an element whose content is text, a `<plaintext>`, and an element
  taken out of foreign content; HTML a browser rearranges inside HTML, such as a `<div>` in a
  `<p>`, still compiles) where the markup shows how the browser parses it: under an element that is HTML's wherever it lands (a `<div>`,
  a `<p>`, a document's `<head>`), in an `<svg>`, its `<foreignObject>`, `<desc>` and
  `<title>` included, in a `<math>`, and in its `<mi>`, `<mo>`, `<mn>`, `<ms>` and `<mtext>` (where
  a `<mglyph>` or a `<malignmark>` stays MathML's) and an `<annotation-xml>` whose first
  `encoding` is `text/html` or `application/xhtml+xml`
  ([design Choice 54](docs/design.md#choice-html-parse-refusals)). An element inside a `<textarea>`, `<title>` (a `<title>` nested in an
  SVG `<title>` too), `<iframe>`, `<xmp>`, `<noembed>` or `<noframes>` was text to the browser:
  put the element beside it, or write text meant to show tags as a string (`"<b>"`). An element
  inside a `<script>` or a `<style>`: behavior goes in a `#[component(js)]`, styles in the
  component's CSS file, and a data block (`<script type="text/x-template">`) writes its content as
  a string literal, which a `<script>` or `<style>` writes as is. A `<plaintext>` made the rest of the page text: write `<pre>`. An element
  the HTML standard's rules for foreign content take out of an `<svg>` or a `<math>` (`<b>`,
  `<div>`, `<p>`, `<span>`, `<table>` and the others it lists, and a `<font>` with `color`,
  `face` or `size`), written straight into one, or into an `<annotation-xml>` whose first
  `encoding` is not an HTML one (or that has none), closed the `<svg>` or the MathML around it: put
  it in a `<foreignObject>`, in a formula in an `<mtext>`, or give the `<annotation-xml>`
  `encoding="text/html"` first. Inside an `<svg>`,
  or a `<math>` outside those elements, a `<textarea>`, `<title>` or `<style>` belongs to the
  drawing or the formula and holds elements. At the top of a component's markup, among a
  component's children and in an `<annotation-xml>` whose `encoding` an expression or a spread may
  write first, where the markup does not show how they are parsed, none of this is refused until
  an element of the markup shows the context ([design Limit 30](docs/design.md#limit-markup-context)).
- `ReadAgain::from` takes only a route that says `patches` in its routes module, whose `get`
  handler returns `HtmlResult<Patches>`: an answer only `req.patch`, `req.patch_with_status`,
  `req.patch_or`, `req.invalid` and `req.invalid_with` make, so the handler's answer to the
  runtime's read of the route is a patch (what answers before the handler, a stage or an
  extractor such as a `Caller` refusal, a response replaced through `DerefMut`, and a handler
  that writes `req.mode` before `req.patch_or`, `req.invalid` or `req.invalid_with`, which
  then answer the mode it wrote, are not checked). Before, any route compiled, and one whose handler answered its page left
  the part as it was with an error in the console, found only when the page ran; now that route,
  or a `patches` route whose `get` handler may answer a page or a redirect, does not compile, at
  the call or at the handler's name ([design Choice 50](docs/design.md#choice-patch-routes)). A
  route given by hand (a `#[derive(Route)]` struct) is never one, and a `patches` route mounted
  by hand (`Area::route`, `Api::route`) takes only a `get` handler that returns
  `HtmlResult<Patches>`: `get(h)` carries what `h` answers (`Methods<S, Patches>`), and
  any other `get` there, or none, stops the build (`E0080`, as a route's path of the wrong shape
  does: when the code that mounts it is compiled, by `cargo build` or by `cargo test` where a
  test or the library reaches it; not by `cargo check`, nor by `cargo test` when only a binary's
  `main` mounts it).
  **Breaking:** an
  app that reads a part again says `patches` on its route and returns `HtmlResult<Patches>` from
  its `get` handler (a page or a redirect goes on `patch_or`'s other side); and `HtmlResponse`
  has a second type parameter (`Kind`, `AnyAnswer` by default), which `req.patch`,
  `req.patch_with_status`, `req.patch_or`, `req.invalid` and `req.invalid_with` take after
  `For`. A handler's return type fixes it, around `Public::new(age, req.patch(..))` and
  `NoStore::new(..)` too; a call that names `For` with a turbofish names `Kind` after it:
  `req.patch::<ForOne, AnyAnswer>(..)` and `req.patch_with_status::<ForOne, AnyAnswer>(..)`
  (were `::<ForOne>`), `req.patch_or::<ForOne, AnyAnswer, _, _>(..)` and
  `req.invalid::<ForOne, AnyAnswer, _, _>(..)` (were `::<ForOne, _, _>`), and
  `req.invalid_with::<ForOne, AnyAnswer, _, _, _, _>(..)`, six type arguments with its lifetime
  left out (was `::<ForOne, _, _, _, _>`). A closure handler whose result nothing else fixes
  names them too, `get(|req: Req| async move { req.patch::<ForOne, AnyAnswer>(..) })`, and is
  `E0283` (type annotations needed) without them, as is a handler that hides its answer,
  `corten::Result<impl Answer<Inputs = AnyInputs>>`, and calls them directly (one that returns
  a helper's `HtmlResult` is fine): `req.patch::<ForOne, AnyAnswer>(..)` or
  `req.patch_or::<ForOne, AnyAnswer, _, _>(..)` there. `Answer` requires `Sized` and has an
  associated type, `Kind`: an answer type of an app's own says `type Kind = AnyAnswer;`, even
  one that holds a patch or wraps another answer, since only `HtmlResult<Patches>` and
  `Public` or `NoStore` of it can be `Patches` (`type Kind = Patches;` or
  `type Kind = A::Kind;` there is `E0277`). `Methods` has a second type parameter,
  `AnyAnswer` by default, which `get(h)` sets to `h`'s kind, so `let _: Methods = get(h)`
  does not compile (`E0308`) for a handler that returns `HtmlResult<Patches>`, whose
  `Methods` is `Methods<(), Patches>`, or one that hides its kind,
  `corten::Result<impl Answer<Inputs = AnyInputs>>`, which says it in the `impl`:
  `impl Answer<Inputs = AnyInputs, Kind = AnyAnswer>`. Nothing changes at run time: the marker is zero-sized and the check a `const` with
  nothing to run (callgrind, a `patch_or` request in process, `what_a_patch_or_request_costs` on
  `0ff569c69` and `811324247`: 17,972 instructions for the patch before and 17,973 after, 18,405
  before and 18,390 after for the page, the same for `HtmlResult` and `HtmlResult<Patches>`). The requests guide now says
  what a `data-patch` form gets from a handler that answers its page: the page swapped in, as a
  navigation's
  ([#1342 A handler's type does not say whether it can answer a patch, so ReadAgain::from takes a route that only answers its page and the runtime finds out when it runs](https://github.com/corten-run/corten/issues/1342)).
- A `#[component]`'s own string (`to_html`, which a patch, a refused form's patch and a live
  fragment are rendered with when the view is a component) now starts at the size that component
  last rendered to, an eighth more and never below 256 bytes, as an `html!` call site's does,
  where it started empty and grew while the component was drawn. Each component keeps its own
  size, so a small patch does not shrink a large one's. Measured (callgrind, release, jemalloc,
  `tests::what_a_patch_costs` at 200 and 1,200 requests, three runs of each build alternated)
  against main `0ff569c6`: a small component's patch costs 17,537.5 instructions a request
  against 18,734.5 and a 4 KiB component's 26,695.9 against 32,414.8; a bare `html!` patch
  (17,512.2) and a 45-byte `Remove` and a 4 KiB `html!` patch in turn (22,728.4 a request)
  cost what they did. The string a response holds until it is written is near the size it
  needs: a 4 KiB component's is 4,628 bytes where it grew to 8,192, and a small one's 256 where it
  grew to 32, as an `html!` patch's already was (the new sizes asserted by a test, the old ones
  reasoned from `String`'s doubling from empty).
  Wall time, the same harness at 200,000 requests, three runs of each build alternated, median
  [range] in seconds, main `9c867b5e` with the harness added against this change, in a 4-CPU
  container: a small component 1.06 [1.05-1.32] against 0.99 [0.84-1.28], a bare `html!` 0.85
  [0.74-0.89] against 0.90 [0.72-0.91], a 4 KiB component 1.34 [1.22-1.64] against 1.09
  [1.04-1.30], and the mixed sequence 1.20 [1.15-1.31] against 1.17 [1.13-1.34]. Every range
  overlaps the other build's, so no wall-time gain is established beyond the noise on that host;
  the instruction counts are the evidence.
  A patch whose handler is under an area with a stylesheet ends with that stylesheet's link
  ([design Choice 47](docs/design.md#choice-patch-brings-area-styles)); a component patch's
  string now starts with room for it (256 bytes against the watchlist's 88-byte link), so it no
  longer grows to hold the link, the about 510 instructions that Choice counts in its harness
  (reasoned from the sizes, not measured on the merged code).
- The app `corten new` writes posts its form to the page's own route
  (`#[route("/", get = home, post = greet)]`, `action={url::Home}`) instead of `/greet`, a path
  with no `GET`, where a browser without JavaScript was left at an address that answers 405 when
  it is reloaded from a bookmark. The README and the getting-started guide show the same, and the
  requests-and-forms guide states the rule: a form that belongs to one page posts to that page's
  route, and a write with a path of its own redirects once done and draws a page only to refuse.
  ui-gallery lists a card on the draft's route and `/save` sends the browser back to the draft
  with a notice; watchlist uploads a picture to `/account`, and `/watch` and `/unwatch` send a
  browser without JavaScript back to the watchlist with a notice and refuse a stock the market
  does not list with a 422 (the page without JavaScript, the form as a patch with it, and a
  Problem Details document to a data client, which got a 200 with the watchlist before)
  ([#1340 The app corten new writes posts its form to /greet, an address with no GET: without JavaScript the page is drawn there and a reload posts again, where the guide says a page and its form share one URL](https://github.com/corten-run/corten/issues/1340)).

- A debug build answers a browser's plain post (no `data-patch`, asking for HTML) with a 500
  that says what to do when a path whose `#[corten::routes]` route has no `GET` handler answers
  it with a page and a success status, keeping the handler's cookies and `Clear-Site-Data`; a
  release build compiles none of the check. **Breaking (debug builds only):** an app from an
  earlier `corten new` (`/greet`, with no `GET`), or any post-only route that answers a
  browser's plain post with a 200 page (a payment provider's return, a sign-in provider's
  `form_post` callback, a refusal sent with 200), now gets a 500 in debug builds and in its
  router tests. To move: post the form to the page's own route (`get = .., post = ..`), or
  answer the write with `req.redirect` or `req.redirect_with_notice` once it is done and refuse
  with `req.invalid`. A router built by hand, an `unstaged` route and an `any = ..` route are
  not checked
  ([#1340 The app corten new writes posts its form to /greet, an address with no GET: without JavaScript the page is drawn there and a reload posts again, where the guide says a page and its form share one URL](https://github.com/corten-run/corten/issues/1340)).

- A request whose method no route in the app has a handler for (`PROPFIND`, `QUERY`, `TRACE`,
  or `PUT` in an app that routes no `PUT`) now answers `501 Not Implemented` with no `Allow`,
  where it answered `405 Method Not Allowed` with the route's `Allow`: RFC 9110 9.1 says a
  server answers 501 for a method it implements for no resource, and keeps 405 (15.5.6) for one
  it implements and this resource lacks. **Breaking for clients and monitors:** they get a 501
  where they saw a 405, and a scanner's `PROPFIND` or `TRACE` now counts toward a proxy's or a
  CDN's 5xx rate, and a client that retries every 5xx by default (Polly's
  `HandleTransientHttpError`, .NET's standard resilience handler) retries it. The app does not
  log it as an error. CloudFront's `5xxErrorRate` and Cloudflare's error-rate notifications
  cannot leave it out, since neither filters by method (Cloudflare's Monitors may, not verified
  here); the deploy guide says how to build one from access logs that leaves out
  `status = 501 AND method not in the app's served methods`, which hides neither the app's own
  501s to a method it serves nor any other 5xx, and that an app with an `any` route has nothing
  to leave out ([Deploying](docs/guide/deploy.md#monitoring)). A method
  some route has, and `GET`, `HEAD` and `OPTIONS` always, are still a 405 with `Allow` where the
  route lacks them; an app with an `any` route (a relay) implements every method, so it answers no
  501; an unknown URL is still a 404 whatever the method, and so is a `CONNECT` to a host and port
  (the authority form a client sends), which names no path. A browser gets the error page as the
  new `Failure::UnknownMethod`, which the request is at fault for as it is for a 405, so the
  page waits for the layout's reads (only the router's 501 is, while it is still its empty 501: a
  middleware that turns it into another status, or gives it a body that is not plain text, keeps
  what it wrote, a plain-text body is `Failure::Rejected` with status 501 for a browser and JSON
  for an API's client, and an empty body of unknown size is sent as a bare 501; a 501 a handler
  or a middleware answers, `Error::status(NOT_IMPLEMENTED)` or the bare status, is still
  `Failure::Failed`), and
  an API its JSON, in its `Api::errors` shape when it has one. **Breaking:** an app's error page that matches
  `Failure` without `_` gains an `UnknownMethod` arm. Only a request that reaches a route's
  405 checks the method again: measured with callgrind (release, glibc, three runs each, every run
  within 2), an unstaged route and a 404 move by 1 to 3 instructions and a page route by 182
  fewer, all in the allocator; a 405 costs 28 to 29 more, and a `PROPFIND` that was a 405 costs
  355 to 481 more as a 501, which allocates the router's marker
  ([design Choice 25](docs/design.md#choice-axum-router), migration step 1)
  ([#1216 A method the app routes nowhere (PROPFIND, QUERY) is answered 405, where RFC 9110 9.1 says 501](https://github.com/corten-run/corten/issues/1216)).
- Pin the benchmark suites to one verified k6 release and record its actual
  executable, immutable image and platform. Native saved replay requires this
  identity, and legacy continuation/trends refuse incompatible or unidentified
  tool boundaries instead of assigning new metadata to old measurements.

- Refresh the JavaScript benchmark framework/compiler dependencies and retain
  committed package locks in their production builds and build recipes. React
  Router uses its current native Express dispatcher. Previous rounds are not
  relabeled; version choices, checks and remaining transitive audit findings are
  recorded in `bench/fullstack/refresh-js.md`.

- Lock Express's existing production dependency tree and use the same `npm ci`
  command in its image and build recipe. Historical full-stack results retain
  their original dependency-reproducibility caveat.

- `html!` refuses a path in the app written as text in an element's URL attribute (`href`, `src`,
  `srcset`, `action`, `formaction`, `poster`, `imagesrcset`, `data`, `ping`, `xlink:href`): a
  value that starts with one `/` (or `\`), or is `http:` or `https:` without the `//` of a
  host, such as `href="/items"`, `href={"/items"}` or `action="/watch"`, is a compile error that
  names the fix, as the type-safety guide already said of every link. This breaks an app that
  wrote one. To migrate, link to the route, `href={url::Items}` (a `#[derive(Route)]` struct;
  `url::Item { id: &id }` for one with parameters, `url::Items.at(Id)` for a place on a page),
  and name a static file by its constant, `src={req.asset(Static::LOGO_SVG)}`
  (`href={(req.asset(Static::SPRITE_SVG), "#arrow")}` with a fragment, a tuple that keeps a
  `srcset`'s descriptors, and for `ping` a tuple that keeps the spaces between its URLs). A path
  on this origin that the app does not route, such as another service behind the same proxy or
  `/oauth2/sign_out`, is a `corten::Local`,
  `href={Local::parse("/oauth2/sign_out").expect("a path on this site")}`, which keeps a query
  and `#fragment`: an explicit opt-out the compiler takes on trust, since a `Local` of a path the
  app routes compiles too. A fragment (`#top`), a full URL, `mailto:`,
  `tel:` and `//host` still compile. Any other expression in braces is not checked, so a path
  built there (`href={format!("/items/{id}")}`, a tuple of its parts) still builds: replace it
  with a route too. The views guide and the `html!` docs no longer show the hand-built path, and the guides
  say where the check holds
  ([#1232 The guides say a path written as text does not compile for any link, but html! takes href="/items" and href={("/items/", &id)}, and the views guide teaches the second](https://github.com/corten-run/corten/issues/1232)).
- `App::max_connections` counts a switched connection, a WebSocket after its `101` or a tunnel
  after a `2xx` to `CONNECT`, until its route drops the socket: the cap's permit is held by the
  socket hyper hands to the route. Before, it was given back at the switch, so a client that
  opened connections and switched them was not bounded by the cap. This breaks an app that sets
  the cap and keeps sockets open: its WebSockets and tunnels now count against the cap, and once
  they fill it, new connections wait until one closes. To migrate, raise the cap by the most
  sockets the app keeps open, with room left for health probes, which wait behind a full cap like
  any other connection, and end idle ones in the route (a deadline from the last frame heard, with
  pings for a client that only listens, as `examples/watchlist`'s `/quotes` does)
  ([#1249 max_connections does not count a switched connection: a WebSocket or CONNECT tunnel releases its permit when hyper hands off the socket](https://github.com/corten-run/corten/issues/1249)).
- A request reads what its area or API sets (deadline, body limit, CSP and shell key,
  middleware, its API) from the route it matched: `App::router` resolves each area's and API's
  once, with those of the areas and APIs around it, and gives it to each of their routes, where
  each request looked it up by its path in six prefix tables. Only an unknown URL, whose `404`
  is its prefix's, and a route that can match a path under another prefix, counted segment by
  segment (a page's `/{*rest}`, or `/{slug}` beside an area at `/shop`), look it up by path, so
  what a request meets is unchanged. Measured at `f7d33ce2` against main `31de4268` (callgrind,
  release, jemalloc, five runs each), a page in an inner area costs 328 instructions fewer and an
  API's JSON 223 fewer, and in an app with no areas or APIs each costs 138 fewer; and later,
  counting segments, a page at `/{slug}` in an app with no areas costs 114 fewer than
  when it was looked up by path (at `084db982` against `416882fa`, three runs each)
  ([#1213 The stages find a request's area by its path in six prefix tables after the router has already matched its route](https://github.com/corten-run/corten/issues/1213)).

- `data-on` is written single-quoted, so the JSON of a handler's arguments keeps its quotes and
  only `&`, `'`, `<` and `>` in it are entities. A large `ToJson` argument, the data a script
  searches or sorts in the browser, stays a typed handler argument and costs about its JSON's
  size: 300 products (51,073 bytes of JSON) went from an attribute of 96,130 bytes to one of
  51,130, 5,302 bytes with zstd against 6,265, and Chromium, Firefox and WebKit parsed such a page
  in about 9 to 23% of the time, four to twelve times faster (Chromium 235 to 323 µs against
  1,401 to 1,616, Firefox 120 to 130 against 1,240 to 1,390, WebKit 390 to 480 against 2,620 to
  3,500, measured; the ends of each engine's ranges paired, from Firefox's 120 against 1,390 to
  Chromium's 323 against 1,401). Formats and messages a page passes to a script shrink the same
  way.
  The `data-on` format, the runtime and the typing are unchanged; a test or tool that matched
  `data-on="` or `&quot;` in a page's text matches `data-on='` and `"` now, and a `corten` and a
  `corten-macros` from either side of the change do not build together, since a message's text is
  written for one attribute or the other. This is why the release is 0.3.0, not 0.2.x: Cargo
  would take a 0.2.x `corten-macros` for an app that holds `corten-run` at 0.2.0, and that app
  would fail to build. The data block the issue asks for is left open
  ([#1253 A script's data can only reach it as a handler argument in an attribute, so a large ToJson list grows about 55% from escaped quotes](https://github.com/corten-run/corten/issues/1253)).
- The seven crates name `https://corten.run` as their `homepage` again, now that the site is
  served there
  ([#838 corten.run shows a Squarespace Coming Soon page: build the landing page as a Corten app, host it and point the domain at it](https://github.com/corten-run/corten/issues/838)).

### Fixed

- Catalog timed-load evidence initializes its four outcome counter series once
  per active VU and increments only the classified outcome per request. Preserve
  exact totals and zero-valued categories with less load-generator bookkeeping;
  request settings, checks, thresholds and qualification gates are unchanged.

- Grouped benchmark collection and retirement confirm delayed provider deletion
  with bounded, exact-ID, read-only observations instead of failing on the first
  still-present response. Account checks share the deadline, and uncertainty
  retains the deletion intent without issuing another DELETE or qualifying
  failed results.

- `corten check` builds every target (`cargo build --all-targets`) between clippy and the tests,
  so a `const` assertion only a binary's `main` reaches fails it as it fails `cargo build`: a
  route that a bin-only app's `main` alone mounts by hand, outside its area or saying `patches`
  with a `get` that answers a page, passed clippy and `cargo test`, which generate none of
  `main`'s callees, and only `cargo build` refused it (design Limit 11). With the default
  profiles the tests reuse the test targets the build compiled, so the check adds about one
  compile of each binary and of each bench target; a `[profile.test]` that differs from
  `[profile.dev]` has the tests compile their targets again
  ([#1429 corten check misses a mount's const assertion when only a binary's main mounts the route](https://github.com/corten-run/corten/issues/1429)).

- A navigation under a `Pwa::network_only` prefix reaches the server once with the PWA's service
  worker in control. The worker turns navigation preload on and then declined these
  navigations, so the browser dropped the preload's answer and sent the request again: every
  network-only page was rendered twice, and a one-time `GET` (an OAuth callback's code, a magic
  link) was redeemed twice, the user seeing the second answer. In card-market's smoke a
  navigation to `/mcp` reached the server twice in Chromium and WebKit and once in Firefox; now
  once in all three. The worker answers such a navigation with the request preload sent (or one
  fetch when none was), with no cache and no offline page, and a redirect is followed by the
  browser as before; a posted form, a browser without navigation preload and every other request
  under the prefix are still left to the browser. An `import_script` listener that already answers
  such a navigation keeps its answer, and the worker's own listener now throws an
  `InvalidStateError` into the worker's console there. The worker is 185 bytes larger (30 with
  gzip at level 9) (design Choice 56,
  [#1524 corten::pwa enables navigation preload but declines network-only navigations, so every navigation to a network_only path reaches the server twice](https://github.com/corten-run/corten/issues/1524)).

- A `data-patch` answer that draws a dialog `open` opens it again after the user closed it, when
  the button that asked for it (or, with none, the focused control of the form, else the form) is
  outside the dialog: the element a submit's answer replaces opens then, as drawn, as the press is
  newer than the user's close, so a
  Preview button beside a server-drawn sheet works on every press, not only the first, and a
  `<details>` asked for unfolded unfolds. Where the button was is read when it is pressed, so
  one removed, or a dialog redrawn, while the answer is on its way still counts as inside. A
  submit from inside the element, the elements inside the one replaced, a live fragment, a
  `ReadAgain` read and a script's `patch()` still keep what the user opened or closed, and a
  popover stays as the user left it (design Choice 52). It only opens: a dialog the user opened
  stays open when such an answer draws it closed. The runtime is 149 bytes larger with gzip.

- A patch answered by a handler in an area (`Area::components`) brings the area's stylesheet:
  the answer links its handler's section stylesheets after its elements, as a navigation's
  answer does, and the runtime loads the ones the page lacks with the patch's modules before it
  puts the patch in place, so a `data-patch` form on a page outside the area no longer draws the
  area's components unstyled. A second patch or a navigation that links a stylesheet still
  loading waits for the same load. One that fails to load is taken out again and the patch goes in
  unstyled; the next patch that links it tries again. The link goes by the handler's path, not by
  what the patch draws, so a page outside the area fetches the area's stylesheet, and the answer
  waits for it, for any patch from the area's handlers, even one that only removes a row; the
  stylesheet is under that page's CSP, not `Area::policy`'s. The debug check of a patch's
  components, which read the handler's path while the page the patch lands on linked other
  stylesheets, is now right for that path, and its messages say it was a patch. **Breaking:**
  every patch whose handler is under an area with a stylesheet ends with that `<link>`, so an
  app's test that compares such a patch's body whole changes (the watchlist's Load more test now
  splits it off)
  ([#1366 A patch answered by another area's handler draws that area's components unstyled: the runtime's patch loads no section stylesheet and check_rendered reads the handler's path](https://github.com/corten-run/corten/issues/1366)).
- Give the Rust benchmark images distinct locked target caches and a shared whole Cargo home,
  including the package-cache lock. Keep pinned CLI binaries outside that mount and align the
  fullstack recipes' dependency, build and development paths with the images. Historical results
  remain historical; no build timings or native qualification are inferred from this change.

- The marketplace browser gate recognizes Livewire's native enhanced alert response
  only for the same origin, matching component, item, locale, save call and submitted
  values. Native transport and plain-form behavior remain unchanged.

- The Dockerfile `corten new` writes gives the app's target cache an `id` of its own
  (`<app>-target`), so a build waits only for another build of the same app, where every app on a
  Docker host built from the template shared one locked `/src/target` cache and waited for every
  other app's build. Downloaded crates are cached as cargo's whole home
  (`CARGO_HOME=/var/cache/cargo`) instead of its `registry` directory, since cargo's lock on them
  is in the home: two builds that run at once wait for each other's download, where with
  `registry` alone one of them could fail to unpack a crate the other was unpacking. Apps no longer
  share compiled dependencies, so two apps with the same ones compile them once each. The examples'
  Dockerfiles take one `id` for the workspace they share (`corten-examples.target`), so each example
  still builds on the crates the last one compiled, and one for their `registry` cache
  (`corten-examples.registry`): without it that cache was every image's
  `/usr/local/cargo/registry`, which an app from the earlier template or another Rust image could
  be unpacking into at the same time, with no lock the two builds both see. The examples write
  theirs one build at a time, in the step that holds their locked target. An app made before keeps
  its Dockerfile; one that takes the change starts its next build with empty caches, and the old
  ones stay on the builder until `docker builder prune`
  ([#1345 The Dockerfile template's target cache has no id, so every app's build on a host waits for every other's](https://github.com/corten-run/corten/issues/1345)).
- A WebSocket handshake of a version other than 13, or of none, is answered 426 with
  `Sec-WebSocket-Version: 13`, `Upgrade: websocket` and `Connection: upgrade` (RFC 6455, 4.2.2;
  RFC 9110, 15.5.22), kept on the app's error page, Problem Details and an `Api::errors` shape,
  where it was a 400 that named no version; a handler that gives it a 400 keeps
  `Sec-WebSocket-Version: 13`, and any other status (a 404 that hides the socket) none of them.
  An HTTP/1.0 request's `Upgrade` is ignored (RFC 9110, 7.8), so an `Option<Upgrade>` route gives
  its other answer, and a proxy that passes `Upgrade` on over HTTP/1.0 gets that answer too.
  Corten needs hyper 1.12, the first that keeps a 426's `Connection: upgrade` when it adds
  `close`. **Breaking:** a handshake of a wrong or missing version gets a 426 where it got a 400,
  a request to an `Upgrade` route that does not ask to switch, and a handshake on a
  connection that cannot switch (HTTP/2, `app.test()`), get a 400 where they got a 426 without
  the `Upgrade` header a 426 must have, and an HTTP/1.0 request with `Upgrade` to an
  `Option<Upgrade>` route gets that route's page where it got a 426 (RFC 9110, 7.8), so a client,
  health check or app test that expects the old status sees the new one
  ([#1239 A WebSocket route's refusals lack the headers the standards require: a 426 has no Upgrade, and a handshake of another version gets a 400 without Sec-WebSocket-Version](https://github.com/corten-run/corten/issues/1239)).
- A typed link no longer writes a path value that would open another page: `.` or `..`, which a
  browser resolves away (`url::Item { id: ".." }` linked to `/`, and a `{*rest}` key
  `public/../private/x` to `/files/private/x`), and an empty value first or last in the path,
  before text in its segment, or as a whole `{*rest}` value, where the router has no segment for
  it (`/{user}/posts` with an empty `user` wrote `/%2Fposts`, which a `/{slug}` route read as the
  slug `/posts`). A debug build panics when such a link is written, naming the route by its
  module path (`shop::url::Item`) and the field; a release build writes `%FF` after the value
  (`/items/..%FF`), which the route answers with a 400, and logs that as an error once for each
  route and field, counting only a refusal written while the subscriber takes an error event of
  Corten's, as Corten's default subscriber and a level or target filter do (a subscriber that
  filters on an event's message text or its line can disagree with that check either way: a
  refusal it drops still uses up the one line, and one it would log may never be logged).
  Values that only contain dots (`a.b`, `.hidden`) are written as before, and so is an empty
  value between two segments. A route path with a `.` or `..` segment, or that text after a
  parameter, no longer compiles, nor does a hand-written `Route` whose `WRITTEN` has that text
  or whose `PATH` in an area or an API has such a segment; a hand-written `Route` at the app's
  top level is not checked for a dot segment in its `PATH`, and the values a hand-written
  `write_href` writes are not checked. The check costs a whole-segment value a comparison of its
  length, and one of two bytes or fewer a look at its first byte, and a `{*rest}` value with a
  dot a second read (docs/design.md#limit-path-values)
  ([#1241 A typed link writes a path value of . or .. as it is, so the browser resolves it away: an item with id .. links to /, and a rest key public/../private/x links to /files/private/x](https://github.com/corten-run/corten/issues/1241)).

- `#[derive(FromJson)]` reads its `#[serde(..)]` once, and writes its reader and the
  `Deserialize` it falls back to from that one reading, as Choice 26 says. A `transparent` struct
  is read as its one field that is neither skipped, defaulted nor a `PhantomData`, the field serde
  reads, so one beside a `PhantomData` or a defaulted field compiles and reads as serde's derive
  reads it, where before the reader's stricter rule refused it. A `PhantomData` is told by the
  field type's path, as serde_derive tells it: `<X as Tr>::PhantomData` is one, and a
  `&PhantomData<T>` or `*const PhantomData<T>` is not, so beside another read field it is refused
  as serde refuses it. A transparent struct whose one read field is a path ending in
  `PhantomData` (`<X as Tr>::PhantomData`), which compiled before, is now refused as serde
  refuses it. Each other attribute it refused is still a compile error, some with reworded
  messages: a `rename` or `rename_all` that is not one string now asks for one name (or rule)
  for reading and writing, as `Fields` does, and a transparent struct with no field to read or more
  than one gives serde_derive's message. `corten-macros` is 87 lines shorter (measured: line
  count)
  ([#1224 #[derive(FromJson)] reads its serde attributes twice, so a transparent struct serde accepts (beside a PhantomData or a defaulted field) does not compile, though Choice 26 says one reading](https://github.com/corten-run/corten/issues/1224)).

- A `data-patch` submit answered with a bare `204 No Content` (the `StatusCode::NO_CONTENT` the
  server's docs give for a write with nothing to say) or `205 Reset Content` is the submit done
  with nothing to draw (RFC 9110, 15.3.5 and 15.3.6): no `corten:error`, so corten-ui's `Toaster`
  no longer shows its failed text for a write that succeeded, and a submit pressed while it was
  out is sent, where before it was dropped. A `205` also resets the form (firing `reset`), unless
  the user changed a field after it was sent (another file of the same name, or text a number
  input cannot read, among them), a control was added to the form since, or the user pressed again
  with other values
  ([#1258 A data-patch write answered 204, which the server doc gives for a write with nothing to say, fires corten:error and drops the queued submit](https://github.com/corten-run/corten/issues/1258)).
  corten-ui's `NumberField` and `ComboBox` follow a form reset, which sends no `input`: a
  button at the bound the reset puts back is disabled again, and the option marked as the value
  is the select's. A file input's files are told by each one's name, size and time there and when
  a patch answers: another file of the same name, chosen while the answer that takes the first is
  on its way, stays chosen, where before it was taken with the answer.
- A slow part a `<corten-live>` stream sends once had no answer without JavaScript: the browser
  opens no stream, so its placeholder stayed for good, as it did when a stream gave up. The live
  data guide's slow-part pattern and
  [design Choice 44](docs/design.md#choice-slow-part-link) now give it one with what routes
  already do: the placeholder holds a link (`rel="nofollow"`) to the page's own route with a query
  field that has its handler read the part in (`url::Home { picks: Some(true) }`), so an app
  writes no second route per part, at the cost of one field plus one handler branch per page.
  The component's CSS hides the link under `@media (scripting: enabled)` and the line saying the
  part is on its way under `@media (scripting: none)`, and swaps them inside
  `corten-live[status="closed"]`, so a browser without the `scripting` media feature shows both.
  The watchlist's home page has picks written this way. `scripts/smoke.mjs` checks, in Chromium,
  Firefox and WebKit, that without JavaScript the link shows and opens the page with the picks;
  that with it, while the stream is held unanswered (`connecting`), the line shows and the link
  does not, in the page loaded and in one a client navigation drew; and that a stream answered
  with a 204 shows the link, which opens the page with the picks
  ([#1264 A slow part a <corten-live> stream sends once has no answer without JavaScript: its placeholder stays for good](https://github.com/corten-run/corten/issues/1264)).
- A component stylesheet's `@scope` rule has its root and limit prefixed as any selector is, so
  `@scope (.list) to (.slot)` matches the component's list down to its slot, and `list` and
  `slot` are classes of the file (`class={Slot}`). Before, the prelude was copied as written, so
  `@scope (.list)` matched no element and every rule in it was dead, and it compiled. Under a
  root at the top of the file that names one of its classes, rules start anywhere (`:scope`,
  `li`), since they match only under the root; under any other root
  (`@scope ([data-theme="dark"])`) each rule starts at one of the classes, as before. `@scope`
  with no root, a pseudo-element in the root or limit, or another prelude, each of which the
  browser drops or scopes outside the component, does not compile
  ([#1237 A component stylesheet's @scope prelude is copied unprefixed, so @scope (.list) matches nothing and its rules never apply, and it compiles](https://github.com/corten-run/corten/issues/1237)).
- A `2xx` to `CONNECT` keeps its connection busy as a `101` does, so `App::header_timeout` no
  longer closes a tunnel once the timeout has passed from when it opened, whether it is carrying
  traffic or idle: as on a WebSocket, idle limits on the tunnel are the route's, and
  `App::send_timeout` still ends a write that waits on it. A refused `CONNECT` is an answer like
  any other, closed once idle past the timeout. Before, the tunnel's empty `200` marked the
  connection idle at once, and a downstream proxy measured hundreds of streams cut at 29 to 31 s
  under the default 30 s
  ([#1218 A CONNECT answered 2xx goes idle like a plain answer, so the header timeout cuts the tunnel mid-stream (only a 101 stays busy)](https://github.com/corten-run/corten/issues/1218)).
- Each TCP connection Corten accepts (`serve`, and `serve_on` or `serve_wrapped` with tokio's
  `TcpListener`) has Nagle's algorithm off (`TCP_NODELAY`), as Go's `net/http` and nginx do, so
  a feed's patches or a live element's fragments made one after another are no longer held for
  the acknowledgement of the last one. Through nginx with the app in a container of its own, the
  second of ten small events made back to back on a reused connection came 42.5 and 43.0 ms (the
  medians of two runs) after the first, the other eight with it; with the option set, -0.1 ms,
  and a request costs the same instructions; a listener of the app's own keeps its choice (design
  Choice 41, `bench/nodelay`)
  ([#1215 TCP_NODELAY is never set, so small back-to-back writes of a streamed answer may wait on Nagle and a delayed ACK (unmeasured)](https://github.com/corten-run/corten/issues/1215)).
- A write or a WebSocket handshake with no `Sec-Fetch-Site` (every handshake from Chromium and
  Firefox) is checked against `Host` by its name and port, and under `Policy::hsts` its scheme,
  where only what followed `://` was compared: under `Policy::hsts` the `Origin` must be `https` or
  loopback, so a plain-http page on the app's host can no longer open a socket to the HTTPS app
  (with the user's `Secure` cookies) or post to it. Browsers send `Sec-Fetch-Site` only to secure
  origins, so an app with `hsts` now refuses every write and handshake from a plain-http page other
  than loopback, in every browser, the app itself reached as `http://192.168.1.5` included; one
  served that way must not set `hsts`. A default port is the same written or left out
  (`https://app.example` matches `Host: app.example:443`), also for the plain notice cookie, and an
  origin of another scheme (`capacitor://localhost`) is refused. Without `hsts` the scheme is still
  not compared, since behind a proxy that ends TLS the app cannot tell which it is served over
  ([design Limit 26](docs/design.md#limit-origin-scheme)); the deploy guide's checklist says to set
  `hsts` for an app served only over HTTPS even when the proxy sends the header
  ([#1212 A write or WebSocket handshake without Sec-Fetch-Site is checked against Host without the scheme, so a plain-HTTP page on the app's host passes against the HTTPS app](https://github.com/corten-run/corten/issues/1212)).
- Locale negotiation follows RFC 4647 Lookup, then Corten's same-language step: an
  `Accept-Language` tag loses its last subtag (and a single-character one before it) until it
  names a listed locale, and only then is the first locale of its language taken
  ([design Choice 42](docs/design.md#choice-locale-same-language)), so `zh-Hant-TW` gets `zh-Hant`
  and `sr-Latn-RS` gets `sr-Latn` in an app that lists `zh` or `sr` first, and
  `fr-CA-u-ca-gregory` gets a listed `fr-CA`. Before, a tag that was not listed went straight to
  the first locale of its language, so those readers got the other script
  ([#1234 Locale negotiation jumps from an exact tag straight to the primary language, so zh-Hant-TW gets zh and sr-Latn-RS gets sr when both are listed](https://github.com/corten-run/corten/issues/1234)).
- The MCP endpoint (`agent::Tools`) answers a request whose `MCP-Protocol-Version` header names
  a revision it does not speak, or that sends the header twice, with `400 Bad Request`, as MCP
  2025-06-18 and 2025-11-25 require: a JSON-RPC error with no `id` (`-32600`, its `data` the
  revisions it speaks and the one requested), checked before the token, or for a body that is not
  JSON or a batch, the same error as without the header. It answered such a request as one of its
  own revisions, with a 200. A request without the header is still read as 2025-03-26, and an
  `initialize` request (with an `id`), sent before a revision is agreed, is answered whatever the
  header names
  ([#1231 The MCP endpoint ignores the MCP-Protocol-Version header, so a request naming a revision Corten does not speak gets a 200 where both revisions it lists require a 400](https://github.com/corten-run/corten/issues/1231)).
- `examples/deck-builder`'s `DeckAnswered`, the pattern the scripts guide shows for learning a
  `data-patch` submit's outcome, carries it as `SaveOutcome`, an enum that derives `ToJson`, in
  place of a `String`: `answered` takes it and the builder's branches compare its declared names,
  so a renamed or misspelled outcome fails the build or `tsc` instead of leaving a refused save
  not rolled back. The page as loaded is a variant of its own, `Loaded`, for which no event is sent
  ([#1243 deck-builder's DeckAnswered carries the save outcome as a String, so a renamed outcome still builds and the script's branch silently stops matching](https://github.com/corten-run/corten/issues/1243)).

### Documentation

- The forms guide no longer pairs a radio group with a plain enum field: a radio group drawn
  with none checked sends nothing, so its field is `Option<Enum>` and the handler adds the
  field's message when it is `None`, which redraws the form with the message without JavaScript;
  a `<select>`, or radios drawn with one checked, stays the enum. A word the page never offers is
  still a 422. A doctest and a router test hold the reading and the redraw
  ([#1413 An enum form field that is missing or holds an unknown word fails the whole form with a 422, where a string field could draw a message on the field](https://github.com/corten-run/corten/issues/1413)).

- Benchmark deployment refreshes target the newest stable framework, runtime and build
  tools rather than LTS alone. Record incompatible inputs without forcing dependencies,
  silently downgrading them or removing selected contenders; qualify new inputs afresh.

- The corten-site deploy guide has the times of the first replacement of the site's machine
  (on `cd3f67f43`: about two minutes down by chance of a Site run the merge had started, six
  until the run the workflow starts was answered) in place of "a replacement has not been
  timed", says that with names that redirect a machine asks Let's Encrypt for two certificates,
  each from its own set of names' five a week, and its list of what has not run on a real
  machine no longer names the address moving or a name that redirects and names more of what
  has not
  ([#838 corten.run shows a Squarespace Coming Soon page: build the landing page as a Corten app, host it and point the domain at it](https://github.com/corten-run/corten/issues/838)).
- The commands CONTRIBUTING gives for the listings-feed smoke and the `corten-cluster` tests, the
  listings-feed README and its failover benchmark remove their Postgres containers with
  `docker rm -f -v`, so the data volume each one's image declares goes with it rather than staying
  behind
  ([#1233 The Postgres containers CONTRIBUTING and the listings-feed example start are removed with docker rm -f, which keeps each one's anonymous data volume](https://github.com/corten-run/corten/issues/1233)).
- The app guide's table of defaults has rows for the handler deadline (30 seconds, then a 503, or
  the client's 408 while it waited for the body) and the request body limit (2 MiB for `Json`,
  `Form`, `String`, `Bytes` and what an `Upload` keeps, then a 413), each with its overrides, so
  they are found where every other default is
  ([#1220 The app guide's table of defaults leaves out the 30-second handler deadline and the 2 MiB body limit, so an app learns of its 503 and 413 only from prose](https://github.com/corten-run/corten/issues/1220)).
- [The Choice on npm onboarding](docs/design.md#choice-no-npm-launcher) records why Corten
  publishes no npm initializer that creates an app (`npm create corten`): the app would still
  build with Cargo and its other commands are installed by Cargo, so it would replace only
  `corten new`, at the cost of a second way to start an app and a second release channel. It also
  records that `create-corten` is held by a placeholder, published once by hand, that prints the
  Cargo steps, so the npm convention cannot run a stranger's code
  ([#872 Evaluate optional npm onboarding through a launcher for the existing Corten CLI](https://github.com/corten-run/corten/issues/872)).
- `bench/fullstack/README.md`'s four cited commits that GitHub did not keep on `main`'s history
  (`2fa883a6`, `1e1fb7be`, `eedbcc2a`, and `7f0b81f`, which only the branch `bench/r13-tree` held) are
  kept under `refs/tags/evidence/`, so `scripts/design-refs.mjs` checks every commit the file
  cites and skips none
  ([#1260 bench/fullstack/README.md cites three commits GitHub does not have (2fa883a6, 1e1fb7be, eedbcc2a), outside the cited-commit check](https://github.com/corten-run/corten/issues/1260)).
- `npm run check` fails on a commit cited in backticks in the repository's Markdown that is not
  on the checkout's history or under `refs/tags/evidence/` (which keeps cited commits no branch
  has), naming its file, line and commit and the fetch from corten-run/corten that brings the
  evidence tags; a shallow clone fails once, saying to fetch the whole history. CI's `npm-check`
  group checks out the whole history, and with it every tag. Another repository's commit is
  written `owner/repo@sha`, as GitHub writes one, and `scripts/choices.mjs` takes that form as a
  Last checked commit; Corten's own is written alone. Thirteen citations of five commits written
  without backticks in `docs/`, `bench/browser/README.md` and `bench/fullstack/README.md` now
  have them, so they are checked
  ([#1219 Twelve commits design.md cites as evidence for Choices 25, 26 and 38 and Limit 21 are not on GitHub, so their numbers cannot be taken again](https://github.com/corten-run/corten/issues/1219)).

## Release archive

- [0.2.0](CHANGELOG.0.2.0.md)
- [0.1.0](CHANGELOG.0.1.0.md)
