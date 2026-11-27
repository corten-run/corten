# Scripts, live fragments and feeds

Full guide: `docs/guide/scripts.md` in the Corten repository.

## A component with behavior

`#[component(js)]` reads `snake_name.js` next to the component. Its exported functions are the
handlers; markup calls them through the generated `js` module.

```rust
// src/views/offer_list.rs
#[component(js)]
pub fn OfferList<'a>(t: Msg, offers: &'a [Offer]) -> impl Render {
    let (rows, rest) = refs();
    let (first, more) = offers.split_at(offers.len().min(5));
    html! {
        <div>
            <table>
                <tbody ref={rows}>for o in first { <OfferRow o={o} /> }</tbody>
            </table>
            if !more.is_empty() {
                <template ref={rest}>for o in more { <OfferRow o={o} /> }</template>
                <button type="button" on:click={js::showAll(rows, rest, target)}>
                    {t.item_show_all_offers(offers.len())}
                </button>
            }
        </div>
    }
}
```

```js
// src/views/offer_list.js
// @ts-check

/**
 * @param {HTMLTableSectionElement} rows
 * @param {HTMLTemplateElement} rest
 * @param {HTMLButtonElement} button
 */
export function showAll(rows, rest, button) {
  rows.append(rest.content);
  rest.remove();
  button.remove();
}
```

Write JSDoc and comments freely: the browser gets the script without them (each line stays
where it was, so stack traces match), and a licence comment (`/*! .. */`, `//! ..`) stays, as does
`//# sourceMappingURL=`. A `/` right after a statement-level `}`, after `++` or `--`, or
starting a line that follows a value (an unfinished expression, or a statement ended without `;`)
makes the script go out with its comments, since only a parser could tell that `/` from a
division: end statements with `;` and keep a division on the line it continues.

1. `let (a, b) = refs();` declares refs. A ref's element type comes from the tag it is on; a
   parameter typed `HTMLX[]` gets every element with that ref.
2. Arguments a handler can take: refs, `event`, `target` (the element with the `on:`),
   `signal` (aborts when that element leaves the page), `scope` (the component's root), and any
   Rust value (`&str`, numbers, `bool`, a typed route, `ToJson` with feature `json`). A name from a
   fixed set (a sort column, a step) is a Rust enum deriving `ToJson`, added with
   `Types::add`, and the parameter is typed by its generated declaration,
   `@param {import("../types/app").SortBy} by`: the call then takes only that enum. Never type a
   handler's parameter as a string literal union: a call to it does not compile (an export only
   other scripts import may use one). Data a script searches or sorts in the browser (a set's
   products) is one such argument, a `ToJson` struct holding the list: it goes in `data-on`, a
   single-quoted attribute, as its JSON with the quotes as they are, so it costs about its size.
   A form's control is passed as its `#[derive(Fields)]` field, `on:change={js::fill(f.weight)}`,
   and the parameter is the control: `HTMLInputElement` (an input or a checkbox),
   `HTMLSelectElement`, `HTMLTextAreaElement`, or `HTMLInputElement[]` for radios or checkboxes
   sharing the name. The runtime finds it by name in the handler's form when the handler runs, so
   the component that draws the field needs no ref. A handler in a form passes the form's control
   of a name this way, whoever draws it. A ref is for the handler's own elements: one a handler
   outside the form reads, one of several sharing a name read through the control around the
   event (`copies.closest()`, a deck line's count), and a widget's own control. A `@typedef` group
   that a handler outside the form also takes keeps its controls as refs for every handler that
   takes it, those inside the form too (the deck builder's `Parts`, which its lines' `<ul>` takes).
   Never pass a field's name as text and look it up with `form.elements.namedItem`, unless only
   its value is read whichever control the app drew: corten-ui's `RequiredWhen` takes
   `control.as_str()` and reads the value of a select, radios, a checkbox or a text field. The compiler cannot see which control the form draws: a
   call that takes a single control (an input, select or textarea) whose form lacks it, has more
   than one, or has another kind, throws, and `corten dev` reports it on draw; a group with none is `[]`.
3. A wrong ref type, wrong event type, wrong value type or a handler the script does not export
   is a compile error at the call. `tsc --checkJs` checks the function bodies, with `strict`,
   `noUncheckedIndexedAccess` (an element or record value read by index is `T | undefined`: read
   with `for .. of`, destructuring, `?.`, or a check), `noFallthroughCasesInSwitch`,
   `allowUnreachableCode: false` and `noUncheckedSideEffectImports`.
4. `on:connect={..}` runs when the element joins the page: first load, navigation, a patch.
5. A component with refs, whose handlers take `scope`, or whose script imports `keep`, has one
   root element; refs resolve inside it and outside nested components. Any element can be the root, a `<tr>` included.
6. A ref on several kinds of element: `ref={tab as HTMLElement}`.
7. State that outlives one event lives in the DOM or in `keep(() => init)` from `corten`: the
   running handler's component's object, one per instance (a second call with another `init`
   gets the first one), with no element passed, so a handler takes no `scope` just for its state.
   Take it first, before any `await`. Only a component's own script imports it, not a `script!`
   module. Handlers are shared by every instance, so never keep state in
   module variables.
8. A control that does nothing without the script renders `hidden`; an `on:connect` handler
   shows it.
9. List the component in `App::components`. A part of it in a function of its own (a sheet, a
   row, a field) takes its handlers with `#[component(js = Owner)]` (`js = path::to::Owner` from
   another module): one script, the owner's; never a script of the part's own for a handler or
   markup the owner draws and passes down only to reach `js`.
10. A value the script computes that the server also draws is a second copy: draw it on the server
    only when a round trip is fast enough; otherwise keep the arithmetic in a `script!` module
    that imports nothing and test both sides against one table of cases (scripts guide, A value
    both sides compute).
11. A page-wide shortcut is `on:document:keydown={js::key(event, ..)}` whose handler starts with
    `if (shortcut(event) !== "p") return;` (`import { shortcut } from "corten/keys"`, served only
    to apps that import it; `shortcut(event, screen)` for keys inside one screen). It is `null`
    for a key in a field (without Control or Meta), IME composition, AltGr, a dialog, popover or
    open modal, Space or Enter on a control, arrows on a radio button, slider or composite
    widget, a handled key; otherwise the key with its modifiers (`"Control+s"`, `"Shift+P"`,
    `"?"`). Never write your own "is the user typing" guard.

## Lists and large components

1. One handler for a list: put it on the container with `row.closest()`, the element with ref
   `row` around the event's target: `<tbody on:click={js::toggle(event, select.closest(), sel)}>`.
   Rows then need no handlers (a row component can be plain `#[component]`).
2. Elements (or messages) several handlers need: a `@typedef {object} Selection` with `@property` lines in the
   script becomes `js::Selection { rows: row, count }`; build it once, pass it as one argument.
3. Rows a feed updates by id: `key={item.id}` on the cells, a `Map<string, HTMLTableCellElement>`
   parameter, `cells.get(row.id)`. Do not read `data-*` attributes for this. Every element given
   the ref has a key (without one, the call does not compile), and each its own: two equal keys
   are one entry of the map, and debug builds stop on them. A key is `key={..}`'s alone: a spread
   of attributes does not write `data-key`. A child component that puts the parent's ref on its
   cells takes it as `Ref<el::HTMLTableCellElement, NoRows, NoValue, Keyed>`.
4. Rows a script only reorders or filters by a value the server knows (a price in cents, a
   stock count): `ref={row.with(sort_cents(l))}` on each row and a
   `Map<HTMLTableRowElement, number>` parameter (`string` for text, `boolean` for a `bool`), read
   as `Array.from(rows).sort(([, a], [, b]) => a - b)`. Rows may share a value and keep their
   key. Never write a `data-*` attribute for a script to read through `dataset` (text on both
   sides, checked by nothing); `data-*` is for CSS and the runtime. A child component that puts
   the parent's ref on its row takes it as
   `Ref<el::HTMLTableRowElement, NoRows, ts::Number>`.
5. A value borrowed from one the view owns: compute it inside `html!` with `let`. A view lent
   to a prop or a call (`action={&html! { .. }}`, `{keep_query(&at, &html! { .. })}`) borrows what it uses, so read the same local in it and
   in the rest of the markup; do not rebind it with `as_ref()` first.
6. Rows a write removes (with `action` from `req.action()`): `action.patch(html! { for id in &done { {Remove(RowId(id))} } })`
   (`corten::view::Remove`), with `#[derive(Id)] struct RowId<'a>(&'a str);` and
   `<tr id={RowId(&item.id)}>` on the row. Rows Load more adds: `view::Append(RowsId, rows)`,
   only the new page, never the whole list again.
7. Filters applied on change: a GET form with `data-keep-place` and a handler that calls
   `form.requestSubmit()`; the runtime keeps the scroll position, a
   scrolling rail's scroll, the groups (`<details>`) the user opened and focus. Focus matches by
   id, else name (and value for a checkbox or radio) inside the nearest ancestor with an id,
   falling back to `<main>`. Give the filter form or rail a `#[derive(Id)]` id to separate it
   from other forms' copies. The index skips inputs of `type="hidden"` but counts disabled
   controls, ones with the `hidden` attribute and ones inside an `inert` element, so a preceding
   control entering or leaving those states does not change its identity. A control at that
   index that cannot take focus, or an ancestor holding no match at that index, leaves focus
   unrestored; only when nothing under the ancestor matches is it looked for by its index in
   `<main>`. A page reading itself again (`ReadAgain`) finds it the same way. Give the control
   its own stable id if matches can be inserted, removed, reordered or moved between ancestors,
   or switch to or from `type="hidden"` (that counts as inserted or removed); a form id only
   keeps other forms' copies out. Never save and
   restore them yourself. `on:change` on the form applies every control (a text field and a
   `<textarea>` too, when they lose focus); `form.requestSubmit(button)` sends it as a submit
   button of the form (its `formaction` decides where); to apply for one control only, put the
   handler on it and pass the form as a ref (`ref={form}`, `js::apply(form)`). Keep the submit
   button so the form works without a script. There is no attribute for this: it is an exported
   function, in one `script!` module when several screens use it.
   A filter or scope whose answer is one part of the screen is a GET `data-patch` form marked
   `data-address`, its route answering with `req.patch_or(part, page)`: as the patch is drawn,
   the address it asked for replaces the current history entry's (no entry is added, so Back
   goes to the page before the screen). An answer that comes after the user left the page (a
   link, Back or Forward, to another `#id` too) does not draw, and one pressed while a visit of
   the runtime's is on its way (a link or Back it fetches, one a `navigate` listener begins too)
   is not sent; an empty or incomplete patch or a drawn 5xx leaves the address, and a page answer
   drawn in place moves it as a patch does. An answer a 3xx (not Corten's own redirect) sent on
   puts the redirect's address in with no `#fragment`: `fetch` hides the one the browser's own
   GET reaches (the `Location`'s, else the action's), so the two can differ there. Where the
   runtime cannot tell the screen is still the
   press's page and entry, with nothing it did not start under way and nothing having replaced
   the entry since the press (`replaceState`, a `history: "replace"` navigation, another marked
   answer's own replace, so of two marked forms pressed before either answers the second leaves
   the first's address; a press an answer's draw makes is on the entry that answer's replace
   leaves, and its answer moves the address again), it leaves the address: so an answer drawn while a navigation the page's
   own `navigate` listener took is on its way (`navigation.transition`, a `data-reload` link
   held before or after it commits) leaves it, and that navigation finishes. The browser shows no navigation for a load of another document on its
   way (the replace lets it go on) or one begun in `navigatesuccess` as another ends (the replace
   cancels it), and none without the Navigation API; the runtime does not track navigations for
   them. A `corten-location` or changed layout is followed as for any `data-patch` form, mark or
   not. It never reloads to repair the address: a replace the browser refuses, or a `navigate` listener
   cancels, leaves the answer drawn under the entry's address, so a listener that cancels it sets
   the address it means itself (or begins its own navigation); while a listener holds it before
   it commits (`precommitHandler`), and while that listener runs inside the replace, a press of a
   marked form is not sent. Pick `data-keep-place`
   when the change redraws most of the page (a list's results), `data-address` when it redraws
   one part of a screen whose rest is costly to read. The patch draws everything the address
   changes, the form included, and any link or form that carries the scope (a `keep_query`
   form's hidden inputs keep the query it was drawn with); never mark a form whose patch appends
   (Load more), and never call `history.replaceState` or `pushState` for it yourself. Its
   submits queue as any `data-patch` form's: a GET pressed while a Save (`formmethod="post"`)
   is on its way goes once the Save's answer is drawn, if the visit has not changed and no newer
   press of the form, or of the one drawn in its place, came since (a press counts as the runtime
   takes it, after a page's `submit` listeners and before its `formdata` ones; an answer already
   drawing keeps its address); if that answer draws the form with `method="post"`, it goes as a
   post, which nothing drops, and a post that waited goes as a GET, fenced like any, if it draws
   the form with `method="get"`, moving the address only if it was pressed marked. Give the form a
   `#[derive(Id)]` id (`html!` refuses the mark without one, and a press of a marked form with
   none leaves the address): presses are told apart by it, so a press of the form a patch drew
   drops the older one's reads.

## Text a script computes

A count or total the script works out is still a catalog message: pass `t.js().rows_selected()`
(the message unfilled, in the page's locale) and take it as `@param {Message<"count">} label`
(`/** @import { Message } from "corten" */`); show `label({ count })` with `textContent`. A
message with other arguments does not compile at the call. Never write the text in the script,
and do not render every variant in a `<template>` for the script to copy.

A number, amount or date the script works out is written with the page's format, never
`Intl` or `toFixed`: pass `t.js().number()`, `t.js().money(USD)` or `t.js().date(DateStyle::Medium)`
(`.time(..)`, `.date_time(..)`, `.zone(Offset::hours(-5))`) and take it as
`@param {NumberFormat}`, `{MoneyFormat}`, `{DateFormat}` or `{PercentFormat}` (`t.js().percent(2)` or `t.js().change(2)`, from `"corten"`); call `money(cents)`
or `when(Date.now())`. It writes what the server's `t.money` and `t.date` write. A zone with
daylight saving time stays on the server.

## A child that reports to its parent

A handler prop: the child takes `on_confirm: Handler<'a>` and puts it on an element with
`on:click={on_confirm}`; the parent writes `<ConfirmButton on:confirm={js::submit(form)} />`.
The handler keeps the parent's refs.

A typed event, when several parents listen or the child decides when it fires (a handler
parameter typed with the imported class only takes that event; keep the `#[event]` type in scope
in the component's module):

```rust
#[event]
pub struct RowToggled { pub id: String, pub selected: bool }
// parent: <tbody on:RowToggled={js::count(event, rows)}>
```

```js
import { RowToggled } from "corten/events";
row.dispatchEvent(new RowToggled({ id, selected: true }));
```

The event is served with the component's script that imports it, so it is not listed (only one
that a `static/` module alone imports is). Handlers several components share go in their own module:
`script!(pub mod validity = "validity.js");`, listed as `validity::COMPONENT`. A page whose
handlers call an unlisted module fails in a debug build (500 naming the module): list it, and
cover each page with a router test so the check runs.

## A fragment the server keeps current

No script needed. Stream components with an `id`; the runtime swaps each one in, like a patch:

```rust
// in the page: the trade count it was drawn at, so a current page is not sent it again
<corten-live src={Trades} since={n}><LastTrade text={&last} /></corten-live>

// GET /live/trades: one value in a tokio watch channel, (trade count, text)
async fn trades(State(m): State<Market>, since: LiveSince) -> LiveResponse {
    corten::live_watch(m.trades.subscribe(), since, |(n, _)| *n, |(_, text)| LastTrade { text }.to_html())
}
```

`view` runs once per open page for each change (a page's part may depend on its request). A part
the same on every page and not small (a table of quotes) is rendered once by the task that sends
the value: send `(cursor, Arc<value>, Arc<str>)` and pass `|(_, _, html)| html.to_string()`; the
page renders its own part from the value it reads with the cursor in one `borrow()`. A part
rendered by a task is in UTC and one language, so render it there only when it has no
translated text and its dates take `.zone(..)`.

Another source (a change stream, a queue) is `corten::live(stream)`: give each item its version,
`Fragment::new(html).cursor(v)`, and use the `LiveSince` argument (the page's `since`, or
`Last-Event-ID` after a reconnect) to send nothing until the next change when it is current. A
slow part sent once is not a stream: the page's own handler answers it (`ReadAgain::now` and
`req.patch_or_with`, in [pages-and-routes.md](pages-and-routes.md)). Its placeholder's link,
`<a class={Show} href={url::Home { picks: Some(true) }} rel="nofollow">..</a>`, is the page's own
route with a query field its handler reads the part in for (the route derives `Default`, so other
links are `url::Home::default()`). The component's CSS swaps it for the loading line only while
the part is busy, which the runtime's part module alone marks:
`.finding { visibility: hidden }`, `[aria-busy] > .finding { visibility: visible }` and
`[aria-busy] > .show { visibility: hidden }`, both in one grid cell of the part
(`display: grid`, `grid-area: 1 / 1`) so the swap moves nothing, and the link shows wherever no
read is bringing the part (no JavaScript, the module not loaded, a failed read), with no
`scripting` media query. See the
live-data guide.

A job's progress is a `<progress value max>` a `corten::live` stream draws again as the job
moves; a growing log or a generated answer is a `view::Append(id, lines)` per piece. A script that
keeps the data follows a feed (one job is a feed of one row), never an `EventSource` of its own
reading untyped names. A stream in a format another party defines is a `Relay` of the app's own
body, which sends `X-Accel-Buffering: no`, writes its own keep-alive comments and has a short
`deadline` on its area or API so shutdown closes it (the live-data guide, Which one).

A job another process runs has only a read to repeat. Many pages following one job: an
`App::task` reads it on an interval into a `watch` channel, and each stream is `live_watch`. One
page's job: `corten::live` over an `unfold` loop that reads, sends only when the version moved, ends
after the settled state and, after a few failed reads, draws that it could not read before it
ends (the live-data guide has it). `App::task` starts with the app: jobs that start later share
one task that sends to a `watch` channel per job.

The element shows its connection as `status` (`connecting`, `live`, `reconnecting`, `closed`,
`ended`) and `stale-since` (when a live stream dropped): style a stale part with
`corten-live[status=reconnecting]`, not with a script that watches for patches. A script that
must react (writing "Stale since 10:42") takes `on:corten-status={js::stale(target, ..)}` on the
element (a bubbling event on each change) and reads the attributes; never a `MutationObserver`.

## Live rows (feature `feed`)

```rust
// a Feed<Stock>: #[derive(Clone, Serialize, ToJson, Row)] struct Stock { #[row(id)] ticker: String, .. }
// (an enum row implements Row by hand). In the routes module, each feed route names its rows:
//   #[route("/feed/stocks", get = stocks, rows = Stock)] pub struct Stocks;
//   #[route("/feed/stocks/live", get = stocks_live, rows = Stock)] pub struct StocksLive;
async fn stocks(State(m): State<Market>) -> FeedResponse<Stock> { m.stocks.snapshot() }
async fn stocks_live(State(m): State<Market>, since: Since) -> FeedResponse<Stock> { m.stocks.live(since) }
// writes: m.stocks.write(|tx| { let s = tx.get_mut(&id)?; s.set_price(cents); Some(()) });

// the component's root: <div on:connect={js::watch(price, url::Stocks, signal)}>
```

```js
import { subscribe } from "corten";
/** @import { FeedUrl } from "corten" */
/** @typedef {import("../types/app").Stock} Stock */

// FeedUrl<Stock> takes only a route with rows = Stock (checked when the crate compiles);
// subscribe() takes the row type from it, so rows and changes are Stock without a @param.
/** @param {HTMLTableCellElement[]} cells @param {FeedUrl<Stock>} feed @param {AbortSignal} signal */
export function watch(cells, feed, signal) {
  subscribe(feed, {
    snapshot: (rows) => rows.forEach((row) => paint(cells, row)),
    patch: (changes) => { for (const c of changes) if (c.op === "upsert") paint(cells, c.value); },
  }, { signal });
}
```

The server renders the rows first; the feed only keeps them current. Clients resume from their
last patch after a disconnect. Across several instances, use `corten-cluster`. A feed that
mirrors a log is `Feed::follow(generation, seq, rows)`, its generation ASCII letters, digits, `.`
and `_` only (`deploy.3`, never `deploy:3` or base64): it panics on anything else.

## A screen's data

A script that needs data the page did not draw (another set's rows, picked by the user) reads it
from the route that answers it as a screen. Data the page needs when it loads is a handler
argument instead (no request).

```rust
// In the routes module: #[route("/sets/{set}", get = set, data = SetListing)] pub struct Set<'a> { pub set: &'a str }
async fn set(req: Req, Params(at): Params<url::Set<'_>>) -> HtmlResult<corten::Screen<SetListing>> {
    let listing = SetListing::read(at.set).await?; // a ToJson, added with Types::add
    req.screen(&listing, set_page(&req, &listing))
}
// another page's markup, links that are the set's page without JavaScript (with it, the address stays),
// under data-no-prefetch: a hover would have the server draw the page the click does not use, and
// replace the read's cached answer (no 304 for the next read):
// <nav data-no-prefetch> for s in &sets { <a href={url::Set { set: &s.code }} on:click={js::switchTo(event, rows, url::Set { set: &s.code }, signal)}>{&s.name}</a> } </nav>
```

```js
import { read, ReadError } from "corten/read";
/** @import { ScreenUrl } from "corten/read" */
/** @typedef {import("../types/app").SetListing} SetListing */

// ScreenUrl<SetListing> takes only a route with data = SetListing (checked when the crate compiles);
// SetListing must come from ../types/app (the typedef above, or @import { SetListing } from it),
// never a type of the script's own; leave types/app.d.ts to corten::types (a hand-written one is not caught).
// read() asks it with Accept: application/json through the HTTP cache (a 304 when unchanged).
/** @type {WeakMap<HTMLTableSectionElement, AbortController>} */
const switching = new WeakMap(); // each table's switch in progress, aborted by the next

/** @param {MouseEvent} event @param {HTMLTableSectionElement} rows @param {ScreenUrl<SetListing>} set @param {AbortSignal} signal */
export async function switchTo(event, rows, set, signal) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; // a new tab: the link's
  const mine = new AbortController();
  const stop = AbortSignal.any([signal, mine.signal]); // the link left, or a later switch started
  event.preventDefault(); // after the line above: where it throws, the link still opens the page
  switching.get(rows)?.abort();
  switching.set(rows, mine);
  try {
    const listing = await read(set, { signal: stop }); // a SetListing: draw it into rows
  } catch (error) {
    if (stop.aborted) return; // so an older, slower answer is never drawn
    if (!(error instanceof ReadError)) throw error;
    location.assign(set); // a failed read (offline, a 401, a redirect): the set's page instead
  }
}
```

It rejects with a `ReadError` (`status` the answer's, a signed-out `Caller` or `Refused::sign_in`
included, which answers a data client 401; or 0, with `redirected` true for a redirect, which it
follows none of and Corten never sends a data client, else with the error as `cause`) and with
`signal`'s reason once it aborts, even after a failed answer. An app sends a signed-out visitor to
sign in with `Refused::sign_in`, not a redirect of its own. A handler whose element can leave
while it reads catches the rejection and returns when its signal is aborted. A read the user can
start again gets its own `AbortController`, aborted by the next, as above.
Never `fetch` a screen's JSON by hand or write its type: the route types it. `read()` returns what
the handler gives `req.screen` to any script on this origin, with the user's cookie: only what the
page may show. The browser keeps one answer per URL, so a read after the page itself was fetched
again there (a navigation, or a hover prefetch of a link to it) gets the whole answer, not a 304:
put `data-no-prefetch` around links whose click reads.
A patch-making method (`action.patch`, `patch_or`, `invalid`) does not compile in a handler that
returns `HtmlResult<Screen<T>>`.

## Many rows: views

A row component a script changes often is a `#[component(view)]`: each parameter that is an
element's whole text, an attribute's whole value, or an input's `value`/`checked` becomes a typed
property of a class in `corten/views`. The handler takes the rows' parent as
`Holds<Row, ..>` and calls `rows(body, Row)`; never query rows by hand.

```rust
#[component(view)]
pub fn Row<'a>(id: u32, label: &'a str, selected: bool, pick: Ref<el::HTMLAnchorElement>) -> impl Render {
    html! { <tr key={id} data-selected={selected}><td><a ref={pick}>{label}</a></td></tr> }
}
// the grid: <tbody ref={body} on:click={js::select(pick.closest(), body)}> for item in items { <Row .. /> } </tbody>
// the ref must be on an element whose children are only <Row .. /> (the compiler checks it)
```

```js
import { Row, rows } from "corten/views";
/** @import { Holds } from "corten/views" */

/** @param {HTMLAnchorElement} link @param {Holds<Row, HTMLTableSectionElement>} body */
export function select(link, body) {
  const row = rows(body, Row).of(link);
  if (row) row.selected = true; // writes the attribute, nothing else
}
```

`rows()` has `at(i)` (none past either end; a negative `i` counts back from the last, as an
array's `at()`, so check what it gives), `get(key)`, `of`, `indexOf`, `push`, `remove`, `swap`,
`clear` and keyed `replace` (pass the `<template>` holding one `<Row .. />` to make new rows). List the view in
`App::components`. Details: `docs/guide/scripts.md`, "Views".

## Widgets

Use `corten-ui` (number field, combobox, tabs, menu button, toaster, copy button, checkbox group, required-when) before writing
one. One choice that shows and hides parts in several places of the page (a period both a figure and a
list below a chart follow) is `ChoiceGroup` with a `ShownFor` around each part, both given one `Chosen { id, value }`, never CSS that repeats
the choice's values or a script that finds the parts. For anything else, use the platform first: `<dialog>`, `popover`, `<details>`, and CSS
anchor positioning. A `<dialog>` the server can draw `open` (a form it refuses) gets
`on:connect={corten_ui::dialog::modal(target)}`, so it is modal, not just open; one the address
opens and a link closes (`?selected=..`) gets `dialog::modalClosedBy(target, close, signal)` with
the link as the `close` ref, so a close request (Escape) goes to its address. A table whose page
has all its rows sorts in place, also when other routes read its order (no round trip; the UI guide
has the measurement), with `on:sort={corten_ui::rows::sort(event, target, head)}` on each kit
`SortHeader`. Declare `let (head, up, down) = refs();` in the table's component. Each header
takes `links={Some(SortLinks { ascending_first: up, descending_first: down })}`. Put
`data-no-prefetch ref={head} on:ReadSortLinks={rows::read(event, up, down)}` on the `<thead>`
and import `corten_ui::ReadSortLinks`. This reads the current typed routes for sorting and for
`ordered` handlers elsewhere. A server-sorted header takes `links={None}` and
`on:sort={None::<Handler>}`. When a cell's text is not its order, put a
`<time datetime>` or `<data value>` in it, or write `ref={cell.with(value)}` on the cell and
give that ref to `rows::sortByNumber(event, target, head, cell)` for numbers or
`rows::sortByText(event, target, head, cell)` for text. The header's `ascending` and `descending` link
to the pages the server sorts each way, and `first` is the direction of the first click
(`Sort::Descending` for a column read newest first; the script puts
the order shown in the address, so a reload and a `ReadAgain` keep it, and in the next read of a
part around the table read again by `ReadAgain::from`, whose route reads the sort from one
`#[route(query)]` set it shares with the page's route and writes it into its next `from`, and
where a form in that part posts, whose route reads the sort the same way as the part's; any other
form whose route reads it, a GET form in the part included, calls
`on:submit={ordered::send(event, target, [sorted(&TableId)])}`, and a link
`on:connect={ordered::link(target, [sorted(&TableId)], signal)}` (the kit's `Pagination` and
`PreviousNext` take that call as `on:link`, put on each link they draw), and sends the order on
screen, a GET form in place of its `keep_query` hidden inputs); a paged table sorts on the server
across its pages (`on:sort={None::<Handler>}`, its pager `on:link={None::<Handler>}`), or sorts only
the page shown, in place (its sort links keep the page, its caption says the order covers the rows
shown, and its pager passes `ordered::link` as `on:link`). Do not write these handlers in the app.
