# Scripts

[Back to the guides](../../README.md#documentation)

A component with behavior has a script next to it. The script exports plain functions; the
markup calls them, by name, with the elements and values they use. There is no component
object, no context and no lifecycle class: a handler is a function, and its arguments say
everything it touches.

```rust,ignore
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

| In the markup | In the script |
|---|---|
| `#[component(js)]` on `OfferList` | `offer_list.js` next to it; `js::showAll` is its `export function showAll` |
| `let (rows, rest) = refs();`, `ref={rows}` on a `<tbody>` | a parameter `@param {HTMLTableSectionElement} rows` (`HTMLTableSectionElement[]`: every element with the ref; `Map<string, ..>`: every one by its `key={..}`; `Map<.., number>`: every one with the value it gives, `ref={row.with(cents)}`, [below](#lists-and-larger-components)) |
| `on:click={js::showAll(..)}` | runs `showAll` on a click on that element |
| `row.closest()` | the element with ref `row` around the event's target (the handler runs only inside one) |
| `f.weight`, a `#[derive(Fields)]` field ([Form fields](#form-fields)) | its control in the handler's form, found by name when the handler runs: `HTMLInputElement`, `HTMLSelectElement`, `HTMLTextAreaElement`, or `HTMLInputElement[]` for radios or checkboxes that share the name |
| `js::Selection { rows: row, count }` | a `@typedef` of elements: one object argument |
| `event`, `target`, `signal`, `scope` | the event (`PointerEvent` for a click), the element with the `on:`, an `AbortSignal` that aborts when it leaves the page, the component's root element |
| a Rust value: `&str`, a number, `bool`, a typed route, a slice, array or `Vec` of strings for `string[]`, a `corten::script::ElementId` (or a slice, array or `Vec` of them) for `ElementId` (`ElementId[]`) from `corten`, made only from a `#[derive(Id)]` type (`ElementId::of(&SalesId)`, never a string; corten-ui's `sorted(&SupplyId)` is one for a sorted table, and its `CopyButton` passes one), any `ToJson` (feature `json`) for a parameter typed `unknown` (which also takes a ref, `event`, `target`, `signal` or `scope`, but not a form field, which needs the control's type to know what to find) | the JSON value (an integer past 2^53 stops debug builds, since a JavaScript number cannot hold it exactly: pass a 64-bit id as a string; a float for a `number` is written as `Display` writes it, [Numbers in JSON](app.md#numbers-in-json)). `unknown` claims nothing the call does not check, so the script narrows it before using it. Any other JSON shape (`{ count: number }`, `number[]`, `string \| null`, `object`, `any`, a `@typedef` of plain values) has no Rust type the call is checked against, so a call to that handler does not compile, and a warning on the call says why: type the value with a generated declaration (next row). The same holds for an element or an event in a shape no call is checked against (`MouseEvent \| KeyboardEvent`, `HTMLElement \| null`, `EventTarget`, `Node`): take an interface the rows above check (several events take the one they share, `UIEvent` or `Event`, and the script narrows it) |
| a value of a Rust type `corten::types` writes a declaration for (`SortBy::Price`, an enum that derives `ToJson`, collected by `Types::components`) | a parameter typed by that declaration, `@param {import("../types/app").SortBy} by` (or a `@typedef` of it, or of that): the call takes that Rust type and nothing else, so one handler serves every name and a renamed variant fails to build. The Rust type is the one of that name in the component's module, so bring it in with `use` under its declared name (the declaration is named after the Rust type, whatever `#[serde(rename)]` the type has). A declaration types a value alone: a list, an optional value or a generic around one does not compile, so declare a Rust type for the whole value. A call to a handler with a string literal anywhere in a parameter's type (`"name" \| "price"`, in a list, with `null`, optional, in a tuple or an object, through typedefs, in a typedef of plain values, or as a group's field) does not compile, since a set of names written that way would take any value; a warning on the call says why. A key is not a name: an object's (`{ "aria-label": string }`), an indexed type's (`HTMLElementTagNameMap["dialog" \| "details"]`), and the keys and members `Pick`, `Omit` and `Exclude` take after the type (`Extract<string, "a" \| "b">` is the set itself); neither is a callback's parameter name (`(Mode) => void`), nor a template literal type (a set in its `${..}` counts); such a type is still one no call is checked against, so it refuses the call as the row above says. A call does not compile either when a parameter holds a generated declaration in a shape the call is not checked against, through typedefs and in a typedef of plain values in any shape (`P`, `P \| null`, `P[]`, or inside another typedef). The script itself compiles: an export only other scripts import types its parameters as it needs. Typedefs that refer to each other are seen through as one, and each is written out once, so a recursive one (a `Json` type) costs no more than another. A generic typedef of the script's own (`@template`) is a definition, not a name for another type |
| `on:connect={..}` | runs when the element joins the page (first load, navigation, patch, a script's insert); on the first load it runs before the page's `load`, and a navigation it starts then (a link it clicks, a form it submits) is a full page load, not a swap |
| `on:document:keydown={..}` | runs for that event anywhere on the page while the element is on it ([below](#events-anywhere-on-the-page)) |
| `on:corten:error={..}`, `on:document:corten:notice={..}`, `on:corten:progress={..}` | the runtime's own events: a `data-patch` submit that got no answer it can draw, a redirect's notice the page did not draw ([Typed events](#typed-events)), and a `data-patch` form's upload progress, a `ProgressEvent` heard on the `<form>` ([Requests and forms](requests-and-forms.md)) |

**What the compiler checks.** `#[component(js)]` reads the script when the crate compiles and
gives the component a module `js` with one Rust function per export, its parameters typed by
the JSDoc. A ref's element type is inferred from the tag it is put on, `event`'s from the
`on:` name as lib.dom's `HTMLElementEventMap` types it (`on:click` is a `PointerEvent`,
`on:formdata` a `FormDataEvent`, a name it does not list an `Event`; an element's `error`,
`abort`, `progress` and `resize` are `Event`s, as the element fires them; `input` is an `Event`
because selects and checkboxes fire one, even though text edits fire an `InputEvent`) and `target`'s from
the tag, so passing a `<tbody>` ref where the handler takes a `<button>`, a `MouseEvent` where
it takes a `KeyboardEvent`, a number where it takes a `string`, or calling a handler the script
does not export is a compile error that points at the call. A call takes as many arguments as
the function has, each checked the same way; arguments that belong together (a widget's
elements and its labels) read better as one `@typedef` group
([Lists and larger components](#lists-and-larger-components)). Inside the script, `tsc --checkJs`
checks the function bodies against the same JSDoc.
It runs with `strict` and four checks `strict` leaves out, the same settings Corten checks its own
runtime, kit and examples with (a test fails when they differ):
`noUncheckedIndexedAccess`, under which an array's element or a record's value read by index is
`T | undefined` until the script checks it (`for (const row of rows)`, `const [first] = rows`,
`rows[i]?.focus()`, or `if (!row) return` after the read); `noFallthroughCasesInSwitch`,
under which a `case` that runs into the next one is an error; `allowUnreachableCode: false`, under
which code that can never run (after a `return`) is an error; and `noUncheckedSideEffectImports`,
under which `import "./file.js"`, run only for its effects, must name a module that exists. A
script that read by index without a check fails `corten check` after the upgrade that added them
until it checks. An app cannot turn one of them off: `corten check` writes the configuration it
checks with each time, and `--no-script-types` leaves every script unchecked, not one option.
`exactOptionalPropertyTypes` is not used: it refuses a property set to `undefined` where one is
optional, and the DOM's option objects (`{ signal }` for `addEventListener`) take that as left out,
as JSON does, so it rejects scripts that work ([design Choice 39](../design.md#choice-script-checks)).
Types are erased when the script runs, so they hold only for values the checker saw made. What
comes from outside it (JSON a script fetches or parses, storage, a message from another window or
a worker) is typed `any` by TypeScript's libraries (`JSON.parse`, `res.json()`, `event.data`),
so `JSON.parse(text).x.y` passes the check: give it the type `unknown`
(`/** @type {unknown} */`) and check it before use. Corten's runtime does that with what it
reads: a feed's envelope is checked, while its rows are trusted as the server's own type
([Live rows](#live-rows)). Corten's own scripts (the runtime, the kit, the template and these
examples) have no explicit `any` and no `@ts-ignore`, which `npm run check` holds them to; where
the DOM library lacks a type (a service worker's global, `navigator.connection`) they declare what
they use and cast once, with a comment saying what vouches for the value
([design Choice 40](../design.md#choice-script-boundaries)).
A ref on several kinds of element is typed as one they all are: `ref={tab as HTMLElement}`.

**JSDoc, not TypeScript.** The checker is TypeScript's either way: `corten check` runs `tsc` with
`strict` and `checkJs`, and the editor reads JSDoc as it reads annotations. What each check
covers:

| What | Checked by | TypeScript source instead |
|---|---|---|
| a call in the markup, `js::showAll(..)` | the Rust compiler, against the JSDoc | the same, read from annotations |
| a function's body | `tsc`, in `corten check` and the editor | refuses a few things JavaScript infers, below, each of which JavaScript can be written to check |
| a value of a Rust type | the declarations `corten::types` writes, which the script imports | the same |
| data that arrives at run time (`fetch`, `JSON.parse`, `dataset`, a feed's rows) | nothing when it arrives: it is trusted as declared | the same |

TypeScript source refuses a few things checked JavaScript infers; these are the ones found so far.
An empty object literal given a property after it is made (`const box = {}; if (x) box.count = 1;`)
is typed as always having it: write the object whole or give it a type
(`/** @type {{ count?: number }} */ const box = {};`). A property a class's constructor or method
sets first is taken as declared, even when the class declares its fields, so a misspelled
`this.naem = ..` is not flagged unless `this` is retyped to `Fields`, a typedef that repeats the
class's fields (`/** @this {Fields} */` on a method, `/** @type {Fields} */ (this).name = ..` in
the constructor), and a read of `naem` only when a method other than the constructor set it and
`undefined` is not accepted. Keep behavior in exported functions, as components do; a class that
stays declares its fields with a first value (`status = 0;`, which TypeScript 7 requires of a field
the constructor writes only through `Fields`) and writes them only through `Fields`, as the
runtime's two classes do. For a function called with `new` and a call with more
arguments than a function reading `arguments` declares, 6.x accepts these in JavaScript and
7.0.2 refuses them; use a class and a rest parameter (`...rest`) instead. A value whose type
nothing fixes (`new Promise((resolve) => ..)`, a type parameter no argument decides) is `any` in
JavaScript and `unknown` in TypeScript: give it one (`/** @type {Promise<boolean>} */`). TypeScript
source would also need a pass that removes TypeScript's syntax before a browser could run the
script, or a build step; JavaScript needs neither. A cast is `/** @type {T} */ (value)` where
TypeScript writes `value as T`, and a type argument goes on the declaration
(`/** @type {Map<string, number>} */ const prices = new Map();`).
[Design Choice 5](../design.md#choice-handlers-checked-where-called) has the measurements and when
this is revisited.

**What the browser gets.** Plain HTML: `data-ref="rows"` and
`data-on='click:offer_list.showAll(@rows,@rest,$t)'`. `data-on` is single-quoted, so the JSON of
its values goes in with its quotes as they are and only `&`, `'`, `<` and `>` in it are written as
entities. Data a script searches or sorts in the browser (a set's few hundred products) is one
such value, a `ToJson` struct holding the list and typed by its generated declaration, and costs
the page about its JSON's size; double-quoted, each `&quot;` added 88% to 300 products
([why `data-on` is single-quoted](../design.md#choice-data-on-single-quoted)). One listener per event type on the
document runs the handlers, innermost element first, and `event.stopPropagation()` stops the
walk as it would stop bubbling. Nothing runs per element until an event reaches it. Script
modules are compiled into the binary, served at versioned URLs, loaded as module scripts by the
pages that render them and imported when markup that names them joins later. They are served
without their comments, each line where it was, so DevTools and a stack trace show the line you
wrote; JSDoc costs the browser nothing, so document a handler as fully as it needs (a licence
comment, `/*! .. */`, `//! ..` or one with `@license`, stays, and so do `//# sourceMappingURL=` and a
`#!` first line).
A script with a `/` right after a statement-level `}`, after `++` or `--`, or starting a line after
a value keeps its comments: only a parser could tell whether that `/` divides (`docs/design.md`,
Limits). List each component once, `App::new(routes).components(&[OfferList])`.

## Server or browser

Do the work where it is fastest for the user. A round trip costs a network hop and a render
(tens of milliseconds on a phone, more on a poor connection); a handler changing the page costs
microseconds, and a [view](#views) changes 1,000 rows in a few milliseconds. So the server
answers what only it can, and the browser does the rest.

| The page needs | Do it with | Why |
|---|---|---|
| to sort, filter, select or page through rows it already has | a handler, and a `#[component(view)]` for many rows | no request |
| to show, hide or expand what it already has | `<details>`, `popover`, `<dialog>`, or a handler with a `<template>` | the platform does it |
| a value computed from what is on the page (a total, a preview) | a handler | no request ([when the server draws it too](#a-value-both-sides-compute)) |
| to save, buy, sign in or change anything | a form the server answers, `data-patch` | the server decides what a write does |
| data it does not have (the next results, a search across everything) | a link, or a `GET` form | only the server has it |
| data that changes on the server | a [feed](live-data.md) or `<corten-live>` | sent when it changes |

A handler that makes a server action instant keeps the action: rows a handler filters as the
user types sit in a `GET` form that filters them on the server without JavaScript.

### A control only the script makes work

A control that does nothing without its handler (a `type="button"` that steps a count, clears a
selection) is not drawn when scripts are off, by a rule in the component's stylesheet, beside its
other rules:

```css
@media (scripting: none) { .clear { display: none; } }
```

The browser decides before it draws, so nothing moves as the script loads and no handler runs
to do it. A control that also needs something the browser may lack (the clipboard) is drawn
`hidden` and shown by its `on:connect` handler once it knows, as corten-ui's `CopyButton` is.
Not `<noscript>`: it can only add markup when scripts are off, not leave out a control that needs
them. The media query hides the browser-only listing sort button on
[Card Market's item page](../../examples/card-market/src/views/item_detail.css); the listings
keep the server's order. The query follows whether scripts are on, not whether this one ran: with
JavaScript off for the site it matches `none`, but a script an extension blocks or that fails to
load still matches `enabled`, so a script-only control is drawn and does nothing. A browser without
the `scripting` media feature (before Chromium 120, Firefox 113, Safari 17) draws it, as it did.

A submit button or link that is the visible way to do an ordinary server action is not such a
control, even when a handler makes the action instant: it stays drawn with scripts on.
`examples/seller-desk`'s grid filters its rows as the seller types, and its filter is still a
`GET` form with its Filter button drawn in every browser. Where the grid's script runs, the form's
submit handler keeps the page, since the rows are already filtered; where it does not (scripts off,
or its module did not load), the button sends the form and the server answers with the rows
filtered. Its sort headers are links to the sorted page the same way, which the handlers sort in
place instead of following. Hiding such a control under `@media (scripting: enabled)` leaves a
page whose module did not load with no visible way to do what its server still does, because the
query stays true. Hide it, if replacing it is worth that, only once the component's replacement
works: from the component's own handler, or on a state only the working component sets, as a slow
part's link is hidden only while a read is on its way ([A slow part](live-data.md#a-slow-part)).
There is no page-wide flag that says a script loaded.

In [Deck Builder](../../examples/deck-builder/README.md), Save stays drawn too. The builder's
handler opts a clean form into `data-patch` when it connects and uses its autosave queue. Until then
the browser submits the plain form: a save redirects, and a refusal draws the page with its reason.
If a native Save is still waiting after the server committed it, a different edit sent with that
same form key gets a conflict, not a success for the first edit. If the module loads after the
player has typed, a difference from `defaultValue` keeps that document native. Starting autosave
would not know whether the native form had already saved. The count fields and focus stay put,
and the next native Save uses the original key and version before opening a fresh page. Add and
Add selected can save without changing any count input. If autosave starts on such a form and
submits a key that already saved natively, the server draws a conflict page with the saved deck
and a fresh key. It does not give the queue an acknowledgement for a draft it never saved.
Filter applies the current query even if its input handler was not there when the player typed it.

### A value both sides compute

A value a handler computes that the server also draws (a refund the first draw shows, and the
answer without JavaScript) is written twice, once in Rust and once in the script, and the
compiler checks neither against the other. When a round trip per change is fast enough, draw it
on the server only (a `GET` form, or a `data-patch` part) and there is one copy. When it must
answer on every keystroke, keep the two small: the arithmetic in one pure function on each side,
the JavaScript one in a `script!` module that imports nothing (`refund.js`, which the
component's script imports as `./refund.js`), and one table of cases a test runs through both.
`corten check` runs the tests, so a change to one side that misses the other fails it; Corten
checks its own formats against the server's the same way (`scripts/format.mjs`). The test runs
`node`, so it needs Node on the `PATH` of every machine that runs `cargo test` (CI included).

The helper is the same module the browser uses, not a test copy:

```js
// src/matrix/refund.js
/** @param {number} paid @param {number} received */
export function refundOf(paid, received) {
  const refund = Math.max(0, paid - received);
  return { refund, net: paid - refund };
}
```

Declare it with `script!(pub mod refund = "refund.js");` beside that file and list
`refund::COMPONENT` with the app's components. The component's script imports
`{ refundOf }` from `"./refund.js"`; it may also import `keep` from `"corten"` or a view from
`"corten/views"`. The test imports only `refund.js`, so none of those browser imports needs a
stub. Keep the helper's imports, if any, free of browser modules too.

```rust,ignore
/// Paid and received, then the refund and what the seller nets, in cents.
const CASES: &[[i64; 4]] = &[[1000, 750, 250, 750], [1000, 1200, 0, 1000], [7, 3, 4, 3]];

#[test]
fn the_script_refunds_what_the_server_does() {
    for [paid, received, refund, net] in CASES {
        assert_eq!(super::refund(*paid, *received), Refund { refund: *refund, net: *net });
    }
    // The same cases through the script's export, relative to this crate.
    let cases = CASES.iter().map(|[paid, received, ..]| format!("[{paid},{received}]")).collect::<Vec<_>>().join(",");
    let script = format!(
        "import {{ refundOf }} from './src/matrix/refund.js';
         for (const [paid, received] of [{cases}]) {{ const r = refundOf(paid, received); console.log(r.refund, r.net); }}"
    );
    let out = std::process::Command::new("node")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args(["--input-type=module", "-e", &script])
        .output().expect("node runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let lines: Vec<String> = String::from_utf8(out.stdout).unwrap().lines().map(str::to_string).collect();
    let expected: Vec<String> = CASES.iter().map(|[.., refund, net]| format!("{refund} {net}")).collect();
    assert_eq!(lines, expected);
}
```

Node imports `refund.js` as a module only if the nearest `package.json` above it does not say
`"type": "commonjs"` (`--input-type=module` covers the `-e` text, not the files it imports); an
app that sets it puts a `package.json` holding `{ "type": "module" }` beside its scripts.

Keep money in integer minor units on both sides, and round with the same rule: `Math.round` and
`f64::round` differ on a negative half (`-2.5` is `-2` in JavaScript and `-3` in Rust). Writing the
result is the formats' job, which already agree ([below](#numbers-money-and-dates-a-script-writes)).

### Testing scripts

Test the part that needs no browser with Node's own test runner (`node --test`), or from a Rust
test when the same cases must agree with the server, as above. Import the source helper, not the
component script that calls it. This needs no Corten loader, fake `corten` package or DOM stubs.

Test behavior that uses `corten`, `corten/views`, refs, events or `signal` in a browser on a page
the app serves. The page's import map resolves the real runtime and its generated view classes;
opening a source file in Node does not. Mapping the names alone is not enough: the runtime
starts listeners and scans the document as it loads, and views use the browser's DOM prototypes.
Corten ships no Node loader or stub runtime. A fake `keep` or `rows` would not test the behavior
the page runs.

Use a browser runner such as Playwright, start the app as for a browser smoke test, and interact
with its rendered controls. For example, against the seller-desk example:

```js
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(process.argv[2]);
  await page.evaluate(async () => {
    const { ready } = await import("corten");
    await ready;
  });
  await page.locator("tbody input[type=checkbox]").first().click();
  assert.equal(await page.getByRole("group", { name: "Selected items" }).locator("output").textContent(), "1");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
```

Run it with `node test-selection.mjs http://localhost:3000` while the example runs (`corten dev`,
as [its README](../../examples/seller-desk/README.md#run-it) says), after installing Playwright and
its Chromium browser in the test environment. This runs `inventory_grid.js`, which imports both
`corten` and `corten/views`, without replacing either module. It also checks the markup's call
and refs, which calling the export alone would miss. Check cancellation by removing the component
with a client-side navigation or patch, which keeps the document alive, and checking that its
work was running before and stops after; a full page load ends every script with its document,
so it would pass even if the handler ignored `signal`. Do not supply a different lifecycle in
the test. For an enhancement a task depends on, also load the page with JavaScript on and the
component's module blocked (`page.route` aborting its URL before the page loads, which also
aborts the runtime's retries), check that the block took effect, and finish the task through the
visible native control. Check the server's answer did the task (the response body, not only the
page it leaves), then that the page shows what the answer carried, so a script that fakes the
result on screen cannot pass for it. Keep the test with scripts off as well; an interaction only
a browser with scripts can do (a drag) needs neither.
[The seller-desk smoke](../../examples/seller-desk/smoke.mjs) covers selection, filtering and
sorting with the grid's module running; filtering also with that module blocked and with scripts
off, and sorting with scripts off. [The runtime smoke areas](../../scripts/smoke/) cover connection
and cleanup. Neither harness needs per-app implementations of Corten's modules. Browser tests run
separately from `cargo test` and `corten check`; keep them in the app's CI too.

## Components and their roots

A component with refs, whose handlers take `scope`, or whose script imports `keep` has one root
element. The root is where its refs and state end: `data-scope="offer-list"` marks it, and a ref
resolves to the elements with that name inside the root and outside any nested component's root.
Two `OfferList`s on one page never see each other's rows (a handler a component passes to a
nested copy of itself resolves to the nearest copy). The root can be any element, so a component
can be a `<tr>` or an `<li>`.

A document can put `<!DOCTYPE html>` before its `<html>` root too: the declaration is not a
second element, and the browser needs it for standards mode. Literal HTML nesting that closes
an element early (a `<div>` in a `<p>`, nested anchors or list items) is refused where the macro
can see its HTML context, so a ref cannot silently move out of that root. Nesting hidden by a
component, expression or `raw` is not checked; nor is table foster parenting. Keep the rendered
tree inside its root ([views](views.md)).

## Handlers as props

A child component takes a handler the parent decides, as a prop of type `Handler`, and puts it
on one of its elements. The parent sets it with `on:name`:

```rust,ignore
#[component]
fn ConfirmButton<'a>(label: &'a str, on_confirm: Handler<'a>) -> impl Render {
    html! { <button type="button" on:click={on_confirm}>{label}</button> }
}

#[component(js)]
fn CartLine<'a>(item: &'a Item) -> impl Render {
    let form = refs();
    html! {
        <li>
            <form ref={form} method="post" action={RemoveItem { id: &item.id }} data-patch>
                <ConfirmButton label="Remove" on:confirm={js::submit(form)} />
            </form>
        </li>
    }
}
```

The handler keeps the parent's refs and scope wherever the child renders it:
`data-on='click:cart_line.submit(@cart-line/form)'`. `None::<Handler>` leaves the `on:` out.
A handler passed as a prop is typed by the prop, not by the element the child puts it on: its
`event` is an `Event` and its `target` an `HTMLElement`, whatever the `on:` name, so its JSDoc
takes those (`@param {Event} event`) and narrows inside where it needs more
(`event instanceof MouseEvent`).

## Typed events

A component tells its parents something happened by dispatching an event. `#[event]` declares
one from a Rust struct; the browser imports its class from `corten/events`, and markup listens
with `on:` and the type's name:

```rust,ignore
#[event]
pub struct RowToggled {
    pub id: String,
    pub selected: bool,
}

// a parent: <tbody on:RowToggled={js::count(event, rows)}>
```

```js
import { RowToggled } from "corten/events";
row.dispatchEvent(new RowToggled({ id, selected: true }));
```

The class bubbles and carries the fields; `Types::components` declares it with the fields' types
(see [Type safety](type-safety.md)). It is served with the component's or `script!` module's script that imports it, so listing
that component is enough; only an event no such script imports (one a module in `static/`
imports, or `import()` loads) is listed in `App::components` itself. Two different events with
one name are a startup error, and a library's are named under its prefix (`ui-copied`). A
handler parameter typed with a class imported from `"corten/events"` (by an `import` statement, or
for its type alone by `/** @import { RowToggled } from "corten/events" */`, which serves nothing)
takes only the `event` of an `on:` for that type, a compile error otherwise; the `#[event]` type is in scope in the
component's module (for `script!`, the module that invokes it), or the script does not compile.
Events are imported by name: a namespace import of `"corten/events"` (`import * as ev`, or
`/** @import * as ev from "corten/events" */`) stops the script compiling, whether or not a
handler uses its types. In `examples/seller-desk`, each price cell sends `PriceEdited` as its price
is typed or put back, and the grid around the cells counts the prices not saved.

A script that submits a `data-patch` form (`form.requestSubmit()`) and needs what the server
decided learns it the same way: the patch the handler answers with carries an element whose
`on:connect` dispatches a typed event with the values the handler read, and the screen listens
for it. The outcome is then the handler's own data, typed by its Rust struct and checked at the
call, which a status could not carry. `examples/deck-builder`'s `SaveNote` is this: each save's
patch draws a note whose
`on:connect={js::answered(target, answer.outcome(), answer.version(), answer.draft(), answer.unsure())}`
dispatches `DeckAnswered`, and the deck builder takes the saved version, a refusal or a stale
save from it. Which of those it was is a `SaveOutcome`, an enum that derives `ToJson`, as the
event's field and as `answered`'s parameter (`@param {import("../../types/app").SaveOutcome} outcome`),
so `tsc` checks the builder's `event.outcome === "Refused"` against the enum's names: a renamed
variant fails the Rust build and then `tsc`, where a `String` field would let the branch quietly stop
matching. The page as first loaded has had no save answered, and a generated declaration cannot be
optional at a call (the table at the top of this page), so that is a variant of its own, `Loaded`,
for which `answered` dispatches nothing. A submit with no answer to draw (other than a bare `204` or
`205`, the submit done with nothing to draw) is `corten:error` on the
form (when a read drew over it while the write was out, on the form the read drew in its place
on the same page, else on the document; it bubbles, and a handler that says so itself calls `preventDefault()`, which keeps
corten-ui's `Toaster` quiet), and a redirect's notice the page did not draw is `corten:notice` on the document
([Requests and forms](requests-and-forms.md)). Markup takes them as it takes the browser's:
`on:corten:error={js::failed(event, target)}` on the form (or `on:document:corten:error` for every
form's) and `on:document:corten:notice`, which is the only place one is heard. The handler types
the event as `corten` declares it, `/** @import { CortenError, CortenNotice } from "corten" */`:
`@param {CortenError} event` reads `event.detail.status` (0 when no answer could be used, with
`detail.error`) and `@param {CortenNotice} event` reads `event.detail.message`, so `tsc` checks
what the script reads against what the runtime sends, and the markup that passes it another event
or the `signal` does not compile. A handler that types `detail` itself
(`CustomEvent<{ status: number }>`) is checked only as a `CustomEvent`, so its markup may pass it
any custom event; `CortenError` is the type that ties it to `corten:error`. An `#[event]` is not
named `CortenError` or `CortenNotice`, nor after a browser event Corten checks a handler against
(`KeyboardEvent`, `PointerEvent`). Any other event name
with a colon does not compile: a component's own event is an `#[event]` type, and another
library's (`htmx:*`, a custom element's) is heard by a listener its script adds.

## Lists and larger components

A grid of 500 rows with a handler on every checkbox prints 500 handler calls. Five tools keep a
large component small and its handlers short.

**One handler for the list.** `row.closest()` is the element with ref `row` that holds the
event's target, like the DOM's `event.target.closest(..)`. Put the handler on the container; it
runs only for events inside such an element:

```rust,ignore
<tbody on:click={js::toggle(event, select.closest(), sel)}>
    for line in lines {
        <tr ref={row}><td><input ref={select} type="checkbox" value={line.id}></td>..</tr>
    }
</tbody>
```

The rows need no handler of their own, so a row component can be markup only.

**Groups.** When several handlers need the same elements, describe them once in the script with
a `@typedef`. Each one with an element (or a `Message`) among its properties becomes a struct in `js`, checked
field by field, built once and passed as one argument:

```js
/**
 * @typedef {object} Selection
 * @property {HTMLTableRowElement[]} rows
 * @property {HTMLInputElement[]} boxes
 * @property {HTMLOutputElement} count
 */

/** @param {MouseEvent} event @param {HTMLInputElement} box @param {Selection} sel */
export function toggle(event, box, sel) { .. }
```

```rust,ignore
let sel = js::Selection { rows: row, boxes: select, count };
// on:click={js::toggle(event, select.closest(), sel)}, on:change={js::selectAll(sel)}, ..
```

The page gets `{rows:*row,boxes:*select,count:@count}`; the script gets an object. A catalog
message (`Message<"count">`, see [Text a script computes](#text-a-script-computes)) makes a typedef a
group too, so text and the values it goes with travel together:
`js::Counted { entity: "Levels", label: t.js().rows_selected() }`. A typedef of plain values
only (strings, numbers) is not a group: it is one JSON value, and since no Rust type is checked
against it, a call to a handler that takes it does not compile. Declare a Rust type for it and take
its generated declaration instead. A group's field of such a type does the same to the handlers
that take the group (a field typed `unknown` does not).

**Keys.** `key={item.id}` on the elements of a ref (`data-key` in the page) lets a parameter
typed `Map<string, HTMLTableCellElement>` get them by key, so rows from a [feed](live-data.md)
find their cells without reading attributes. Every element given the ref has a key or none does,
and only a ref whose elements have one fits a `Map<string, ..>`: one without a key, on all its
elements or on some, does not compile, and the error says to add `key={..}`. A ref with keys still
fits `El` and `El[]`. A component that puts a parent's ref on keyed elements names its type
`Ref<el::HTMLTableCellElement, NoRows, NoValue, Keyed>` (`corten::script::{Keyed, NoRows, NoValue}`).

```rust,ignore
<td ref={qty} key={item.id}>{line.qty}</td>
// on:connect={js::live(qty, url::Levels, signal)}, live(cells, feed, signal) with cells.get(level.id)
```

A `Map` holds one element per key, so two elements of the ref with equal keys are one entry, the
later in the page's order, and the other is out of the handler's reach. Keys are equal as the
browser reads them (`getAttribute`): `key={true}` and `key=""` are both the empty string, a carriage
return reads as a line feed, and `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&#39;`, which Corten writes
for `&`, `<`, `>`, `"` and `'`, are those characters. Debug builds stop a render in which two
elements of a ref in one component have equal keys, or a `key={..}` writes none (a `None`), as they
stop on a number past 2^53; release builds do not check. They count the elements the runtime finds,
so an element in a `<template>`'s or a `<noscript>`'s content is not one of them, nor one an
expression or a component writes into an element a browser reads as text (`<textarea>`, `<title>`,
`<iframe>`, `<xmp>`, `<noembed>`, `<noframes>`). An element written in one of those in the markup
does not compile where the markup shows it is HTML, nor one in a `<script>` or a `<style>`, nor a
`<plaintext>` (the browser would show its tags as text; [views](views.md),
[design Choice 54](../design.md#choice-html-parse-refusals)). Inside an `<svg>` all
of them are elements like any other, and what they hold is found, except in its `<foreignObject>`,
`<desc>` or `<title>`, which hold HTML. A component's markup does not see an `<svg>` its parent
writes it into, and a component's children do not see where the component writes them, so the keys
in a `<template>`, `<noscript>`, `<textarea>`, `<title>`, `<iframe>`, `<xmp>`, `<noembed>` or
`<noframes>` at the top of a component's markup (which its parent may write into an `<svg>`), or
in one among a component's children (outside an `<svg>` the children write themselves), are not
checked ([design Limit 30](../design.md#limit-markup-context)). Nor are those in one of them inside
a `<math>` (outside its `<mi>`, `<mo>`, `<mn>`, `<ms>` and `<mtext>`, and an `<annotation-xml>`
whose first `encoding` is `text/html` or `application/xhtml+xml`, or in a `<mglyph>` or `<malignmark>` in
one of them), where it is MathML's and the runtime
finds what it holds: where the check cannot be sure, it lets a duplicate pass rather than stop a correct render. Markup that is not correct is another matter:
a browser moves an element written straight into a `<table>`'s rows (a `<span>` in a `<tr>`)
out before the table, so when the table is a component's root the runtime does not find it there,
while the check counts it where it is written and may stop on a duplicate the runtime does not see. A view written into a
string of its own (`html! { .. }.to_html()` or `children.to_html()` as an attribute's value, which
the browser reads as text) does not count toward its component's keys; a component rendered so
checks its own. Corten writes a document's head tags that way too (each expression or component in
`<head>` into a string it then copies into the page), so equal keys in two of them, or in one and
the body, are not checked. They see what one render writes: rows a patch or a script adds later are the page's, so give every row a key of its
own (an id, not a name two rows can share). A key an `AttrValue` of the app's writes with any other
`&` (`&#128;`, `&nbsp;`) is not checked, since what a browser reads there follows rules of HTML's
the check does not repeat.
The check belongs to `corten-run`: it runs when that crate is built with debug assertions (as
`cargo build` and `cargo test` build it), for every crate's markup, whatever the app's own crate is
built with. A spread of attributes does not write `data-key`, as it does not write `data-ref`. A
`data-key=".."` written by hand is refused; write `key={..}`.

**A value for each element.** Rows a script compares (orders by price, filters by stock) carry what
it compares with their ref: `ref={row.with(sort_cents(l))}` gives each row a value, and a parameter
typed `Map<HTMLTableRowElement, number>` gets every row with its value, in the page's order. Two
rows may give the same value, and a row with a key keeps it. The value is named once, in the markup,
and the script reads it from the map, so the two share no attribute name as text, and a number is a
number in the script (an integer past 2^53 stops debug builds, and a NaN or infinite float arrives
as `null`, as a handler's number argument does). The call is checked as any ref's is: a ref whose
elements give no value, give text where the handler takes `number`, or give one on some elements and
not on others does not compile. A value is a number, text (`string`) or a `bool` (`boolean`); an
app's own type gives the number or text it stands for.

```rust,ignore
<tbody ref={body}>
    for l in listings { <tr ref={row.with(sort_cents(l))}><ListingCells l={l} /></tr> }
</tbody>
// on:click={js::toggle(body, row)}, toggle(body, rows) with Array.from(rows).sort(([, a], [, b]) => a - b)
```

The page gets `<tr data-ref="row" data-ref-value='1250'>` and the call `toggle(@body,=row)`. A
component that puts a parent's ref with values on its element names its type
`Ref<el::HTMLTableRowElement, NoRows, ts::Number>` (`corten::script::{NoRows, ts}`). A `data-`
attribute a script reads through `dataset` is text on both sides that nothing checks: write one
for CSS or for the runtime (`data-selected`, `data-reload`), and give a value a script reads with
the element's ref.

**Values the markup owns.** `html!` owns what it captures (a view lent to a prop,
`action={&html! { .. }}`, borrows from the view around it instead), so a value borrowed from one
of them is computed inside the markup, with `let`:

```rust,ignore
let saved = cents.map(money);
html! {
    let shown = saved.as_deref().unwrap_or(typed);
    <input value={shown}>
}
```

**Parts.** A large component splits into parts, functions of their own (a sheet, a row, a
field), and a part calls its owner's handlers with `#[component(js = Owner)]`
(`js = super::terms::TermsPage` from another module of the crate that can see it, named by its
path as `css = Owner` is): `js` there is the owner's module, so the page still loads one script,
the owner's, and the part adds none. A part's refs are its own, as any component's. The `scope`
an owner's handler takes is the owner's root, so the owner needs one (a ref, a handler taking
`scope`, or a script that keeps state; a part whose owner has none does not compile), and a part
whose handlers take `scope` or keep state renders inside its owner. An owner without a script
does not compile (E0432, naming the owner's hidden handler module).

```rust,ignore
#[component(js = TermsPage, css = TermsPage)]
fn AccountChooser<'a>(accounts: &'a [Account]) -> impl Render {
    html! {
        <select name="account" on:change={js::prefill(target)}>
            for a in accounts { <option value={a.id}>{a.name}</option> }
        </select>
    }
}
```

**Refs in a standalone part.** When a part is drawn in the page and also sent alone, the
component that owns the script can export a ref for it. Give the ref a concrete
`corten::script::Ref<El>` type in its `refs()` declaration. This makes a
`ComponentNameRefs` bundle with a getter returning a typed ref for each such declaration.
The bundle has no writable fields. A part that takes `InventoryRefs` cannot be passed or filled
with another component's refs, even if both declare a ref of the same name and element type.
An exported ref cannot share its name with another ref declaration in the owner or carry
`#[cfg]` or `#[cfg_attr]`. Put the condition on the component instead.

```rust,ignore
use corten::{prelude::*, script::Ref};

#[derive(Id)]
struct SetPickerId(u32);

#[component(js)]
fn Inventory(instance: u32, set: &str) -> impl Render {
    let picker: Ref<el::HTMLSelectElement> = refs();
    html! {
        <section>
            <button type="button" on:click={js::focus_picker(picker)}>"Focus set"</button>
            <SetPicker bundle={InventoryRefs} instance={instance} set={set} />
        </section>
    }
}

#[component]
fn SetPicker(bundle: InventoryRefs, instance: u32, set: &str) -> impl Patch {
    html! {
        <select id={SetPickerId(instance)} aria-label="Set" ref={bundle.picker()}>
            <option>{set}</option>
        </select>
    }
}
```

The handler is still a plain exported function (`focus_picker(picker)`, with
`@param {HTMLSelectElement} picker`). The patch handler renders
`SetPicker { bundle: InventoryRefs, instance, set }` too. An exported ref writes its
owner-qualified name in the element's `data-ref`, so the part writes the same name both ways.
The part has no scope or script of its own. The bundle identifies the owner type, not an
instance. Keep the target under the intended owner's root and use an instance-specific ID, such
as `SetPickerId(instance)`, when the owner appears more than once on a page. Refs that don't need
exporting keep the inferred `let name = refs();` form.

A patch (with `action` from `req.action()`) removes rows as well as replacing them: `action.patch(html! { for id in &done { {Remove(RowId(id))} } })`
(`corten::view::Remove`, a `<template id data-remove>` the runtime applies), and adds them with
`view::Append(RowsId, rows)` (`<template id data-append>`). `RowId` is the
`#[derive(Id)]` the row prints its id with ([typed ids](views.md#typed-links-and-messages)), so
the two cannot drift.

## Form fields

A handler takes a form's control as its field: the markup passes the `#[derive(Fields)]` name,
as `name={..}` does, and the script's parameter is the control. A handler in a form (on it,
inside it, or joined to it with `form=`) reaches the form's control of a name this way, whichever
component draws it (a package's fields that the form shares with forms that have no script, which
has no refs to give one). A ref names an element of the handler's own component: every element
that is not a form's named control, and a named control the handler needs as that element rather
than as its form's control of the name. That is one a handler outside the form reads (the deck
builder's hidden `version`, which its `on:connect` on the element around the form reads), one of
several that share a name, read through the control around the event (`copies.closest()`, the
count input of the deck line that changed), and a widget's own control (corten-ui's
`NumberField`), which it draws for whatever field the app names, in a form or not. A `@typedef`
group of refs that a handler outside the form also takes keeps its controls as refs for every
handler that takes it, those inside the form too: the deck builder's `Parts` holds `version`, and
its lines' `<ul>`, inside the form, takes `Parts` as `start` does.

```rust,ignore
let f = Shipment::FIELDS;
html! {
    <form>
        <select name={f.service} on:change={js::fill(f.service, f.weight, f.size)}>..</select>
        <PackageFields />  // draws the weight input and the size radios, with no refs
    </form>
}
```

```js
/** @param {HTMLSelectElement} service @param {HTMLInputElement} weight @param {HTMLInputElement[]} sizes */
export function fill(service, weight, sizes) {
  weight.value = service.value === "air" ? "2" : "9";
  for (const size of sizes) size.checked = size.value === "small";
}
```

| The form draws | The parameter |
|---|---|
| an `<input>`, a checkbox (a `bool` field) | `HTMLInputElement` |
| a `<select>` (`multiple` for a `Vec`) | `HTMLSelectElement` |
| a `<textarea>` | `HTMLTextAreaElement` |
| radios, or checkboxes that share a name (a `Vec`) | `HTMLInputElement[]`: every one, in the form's order; none is `[]` |

The page gets `data-on='change:shipping.fill(~s"service",~i"weight",~*"size")'`. When the handler
runs, the runtime finds the controls of that name in the form of the element with the `on:` (the
form itself; for a control, a form-associated custom element among them, the one it belongs to,
`form=` included; else the one around it. A button whose `form=` names no form is in none, as its
submit is, and a `<label>` or `<legend>`, which is not a control, takes the form around it, not the
labelled control's), so a control a patch replaced is the new one. The lookup uses the form's own index of
its controls' names, so it costs a run a few microseconds however many controls the form has. A field of a group or a row is passed the same way
(`f.parcels.at(&1).weight`, `parcels[1].weight`), and so is one in a `@typedef` group. The name is
the one `Fields` writes, so a renamed field is renamed in both places; text where a field belongs,
and a field where the handler takes text or another element, do not compile.

What the compiler cannot see is the control. A field's name carries what it reads
(`FieldName<Condition>`), not whether the form draws it as a select or as radios, and the markup
that draws it may be another component's. So the runtime checks it: a call that takes one
control (an input, select or textarea) whose form has none of that name, more than one, or one of
another kind, and a call that takes a group whose form has a control of the name that is not an
input, runs nothing and throws what it takes and what the form has instead (none, more than one,
another kind, or no form at all): `corten: shipping.fill takes field weight as one <input>, and its form has select`.
A group with no control of the name is `[]`, as a group of radios the form left out is.
Under `corten dev` the console says the same as soon as the page draws such a call, before
anything calls it ([design Limit 32](../design.md#limit-field-kind)). A group is an array, not the
`RadioNodeList` a form's `elements.namedItem` gives: `namedItem` gives a list only for two or more
controls of a name and the control itself for one, and a script cannot make one, so the handler
could not count on its type. Besides the cases above, a ref is an `<output>`, a list, a button, a
control outside any form, and an `<input type="image">`,
which the browser leaves out of a form's controls since it is a submit button that posts `name.x`
and `name.y`, never its field. A page whose handlers take a field loads the module that finds it,
`corten-field` (1,340 bytes, 741 gzipped), as a format argument loads `corten-format`; a page with
none does not.

## Shared scripts

Handlers several components use live in a module of their own:
`script!(pub mod validity = "validity.js");` declares `validity::check(..)` and the constant
`validity::COMPONENT` to list. A page whose handlers call a module the app does not list (a
component's or a `script!` module's) is an error in a debug build, so a router test or
`cargo run` finds it before a browser does; a release build logs it each time such a page
renders and leaves the page's other modules working. Which handlers a page calls depends on what it renders, so this
is checked when it renders, not when the crate compiles.

A script can import another script module with a relative path, by its file name:
`import { loadStripe } from "./stripe.js";` in `payment_entry.js` loads the `script!` module
declared from `stripe.js`. Every script is served from the same directory of the same version, so
the path is `./{file name}`. A page that loads `payment_entry.js` preloads `stripe.js` with it
(and what that imports), so the browser fetches both at once rather than finding the import once
the first has arrived. That holds for a page the runtime swaps in too (a navigation, a write's
page, a `data-patch` form answered with a whole page): its answer carries the preload tags of
what its handlers' modules import, which the runtime starts before it imports those modules, and
`corten/views` and `corten/events` come the same way.
A patch does not carry them: it usually redraws markup whose modules are on the page already. The
imported module is a component's or a `script!` module, so it exports only
functions with JSDoc types like any handler module; a helper that exports anything else is a plain
file of the static directory's `scripts/`. An import of a module the app does not serve fails when
the app starts, since the browser would get a 404. A dynamic `import("./x.js")` is left for when
it runs, and is not preloaded. A library's scripts are served by their prefixed names, so one
imports another as `./ui.listbox.js`; an import without the prefix does not compile.

## Libraries

A crate of components for other apps prefixes the names it puts in the page, so they never meet
an app's own: `[package.metadata.corten] scripts = "ui"` in its `Cargo.toml` makes its scripts
`ui.combo_box.js` and its roots `data-scope="ui-combo-box"`. `corten-ui` does this.

## When handlers run

A handler runs while its event is dispatched, so it can call `event.preventDefault()`. The
first page loads the modules its handlers name as module scripts of its own, right after the
runtime; Corten ends each component's module with lines that hand its exports to the runtime
(a `corten:module` event the runtime takes only from the module the page's own script tag for
that name loaded, and only while the page loads; it is not an API, and `"corten"` exports nothing for it), so its
handlers are in when the browser runs the page's scripts, before `DOMContentLoaded`, with
no `import()` to wait for. Markup the runtime inserts (a navigation, a patch, a live fragment)
waits for the modules its handlers name, and modules named inside a `<template>` load with the
page. On the first page, an event that arrives before its module is in gets the browser's
default and no handler, as without JavaScript. `on:connect` waits for its module instead.

A focus handler that runs while a patch restores focus sees refs in the markup inserted so
far. A later `on:connect` in that patch sees the refs after all its replacements, even if the
component's refs had already been read before the patch.

A module that did not load (a request the network dropped: the page's script tag's, then the
runtime's import, or the import alone for a module only inserted markup names) is asked for
again once a wait is over that grows with each failure in a row (0.5 s, doubling, at most 30 s, as
`subscribe` reconnects). `on:connect` waits for it for as long as its element is on the page; any
other event gets the browser's default and asks for it, so a later one finds it. Each failure is
in the console. A module that throws as it runs fails the same way every time, so its element's
handler never runs and its error is in the console again at each try.

## Events anywhere on the page

A screen's shortcuts act wherever focus is: on the page's background after a click, after a
navigation, on a button. `on:keydown` hears only the keys pressed inside its element, so a
component takes them with `on:document:keydown={..}`, for as long as it is on the page. Its
handler runs after the handlers on the event's path (unless one stopped it), as a listener of its
own on the document would: one component stopping the event does not keep it from another's,
and an element that joins the page during the event hears the next one. Its arguments are read
for each event, so refs are the component's current elements, `target` is the element with the
`on:`, and `event` is typed by the event's name (`KeyboardEvent`); a ref found from the event
(`row.closest(..)`) is there only for events inside it. Nothing removes it: it ends when its
element leaves the page. It takes the events that bubble to the document: `focus`,
`mouseenter` and the media events stay on their element and do not compile there
(`on:document:focusin` and `on:document:mouseover` are the ones that bubble). watchlist's prices
pause on `p`:

```rust,ignore
<button ref={pause} aria-keyshortcuts="p" on:click={js::pause(target, price, change)}
    on:document:keydown={js::pauseKey(event, target, price, change)}>
```

```js
import { shortcut } from "corten/keys";

/** @param {KeyboardEvent} event @param {HTMLButtonElement} button ... */
export function pauseKey(event, button, prices, changes) {
  if (shortcut(event) !== "p") return;
  event.preventDefault();
  pause(button, prices, changes);
}
```

The handler hears every key, so it asks `shortcut(event)` whether the key is the page's to take.
`corten/keys` is a module of its own (1,803 bytes, 916 gzipped): an app serves it only when one
of its listed scripts imports it (a component's or a `script!` module, not a static file's), and
a page whose handlers are in that script fetches it with the script, on a full load and on a page
the runtime swaps in (not a patch).
Pages without shortcuts fetch nothing more; the import map names it on every page of such an app
(about 60 B). It is `null` when the key belongs to something else:

1. a key a handler already took (`defaultPrevented`), an IME composing a character, or a
   character typed with AltGr;
2. a key pressed in a dialog or popover (native, or `role="dialog"`), or anywhere while a modal
   `<dialog>` is open (fullscreen is not a dialog: shortcuts work there);
3. in a field that takes text (an input that does, `textarea`, `select`, `contenteditable`, a
   `textbox`, `combobox`, `searchbox` or `spinbutton`, in an open shadow root too; a closed one is
   hidden from the page), any key without
   Control or Meta, and the arrows, Home, End, page keys, Backspace and Delete with them;
4. Space and Enter on something they press: a link, a button, any input, `summary`, or an
   element with a control's role (`checkbox`, `switch`, `tab`, `option`, a menu item);
5. the arrows, Home, End and page keys on a radio button or a slider, or in a list box, menu,
   menu bar, tree, tree grid, grid, radio group or tab list, and a character without Control or
   Meta in a list box, menu, menu bar, tree or tree grid, which finds an item by it (tabs, radio
   groups and grids do not, so a letter there is the page's).

A key pressed with nothing focused (the page's background) is the page's. Otherwise it is the key
after the modifiers held, in the order Control, Alt, Shift, Meta: `"p"`, `"Shift+P"` (a letter's
case is Shift's, not Caps Lock's), `"Control+s"`, `"ArrowLeft"`, `"Shift+Space"`. Another
character is as typed, without Shift, since layouts differ on which characters need it: `"?"`,
`"/"`. Ctrl on Windows and Linux is Cmd on a Mac, so a shortcut that takes either compares both
(`"Control+s"`, `"Meta+s"`); in a field that is how Control+S saves while the reader types (pick
a key the field does not use itself: Control+A selects its text). On a Mac, Option types
another character, so a letter's shortcut takes Control or Meta, not Alt. Shortcuts for keys
inside one screen pass it, `shortcut(event, screen)`: a key from outside it (the app bar, a
dialog the screen is not in) is then `null` too, a key in a dialog inside it is the screen's, and
a key pressed with nothing focused is still the page's. A shortcut that wants a key the rule
gives away (Escape in a field, say) reads `event.key` itself.
A shortcut of one character key, like this one, is one a speech user can set off by talking, so
WCAG 2.1.4 asks that the reader can turn it off or remap it, or that it take a modifier (Ctrl,
Alt) instead. Prefer this to `document.addEventListener` in an `on:connect` handler, whose
arguments are read once, when the element joins, so refs a patch later replaces are stale.

## Text a script computes

"3 selected" or "Showing 12 of 40" depends on what the browser counted, and asking the server
for it is a round trip for a change the browser makes in microseconds. It is still a message of
the app's catalog (`messages!`): the markup passes it unfilled, in the page's locale, and the
handler fills it in.

```rust,ignore
// locales/en.json: { "rows_selected": "{count} selected" }
let t: Msg = req.t();
html! { <tbody on:change={js::count(rows, total, t.js().rows_selected())}>..</tbody> }
```

```js
/** @import { Message } from "corten" */
/** @param {HTMLInputElement[]} rows @param {HTMLOutputElement} total @param {Message<"count">} label */
export function count(rows, total, label) {
  total.textContent = label({ count: rows.filter((row) => row.checked).length });
}
```

`t.js()` has a method for each message with arguments. A message is sent only where a page
passes it, as its text and argument names in `data-on`; there is no catalog module and no locale
lookup in the browser. `Message<"count">` names the arguments, and a message whose arguments are
not exactly those does not compile at the call (`Message<"shown" | "total">` takes a message with
both). Inside the script, `tsc` checks that `label` is given each of them. Write it with
`textContent`, which does not read it as markup. A number in it is written with the page's
format (below). A plural message (`t.js().grid_items()`, from `grid.items_one` and `_other`) is
the same `Message<"count">`: the script passes the count as a number, `label({ count: 3 })`, and
the form is picked as the server picks it, with the count written in the page's format. It is sent
with the locale's plural table and number format (about 300 bytes more in the attribute) and
loads `corten-format` ([below](#numbers-money-and-dates-a-script-writes)). Never choose between
two messages with `count === 1` in a script.

## Numbers, money and dates a script writes

A total the browser adds up, a price from a live feed, or a time an event happened is written in
the page's locale, as the server writes it. The markup passes the page's format and the script
calls it:

```rust,ignore
const USD: Currency = Currency::new("USD");
let t: Msg = req.t();
html! { <tbody on:change={js::total(rows, out, t.js().money(USD), t.js().date(DateStyle::Medium))}>..</tbody> }
```

```js
/** @import { MoneyFormat, DateFormat } from "corten" */
/** @param {HTMLInputElement[]} rows @param {HTMLOutputElement} out @param {MoneyFormat} money @param {DateFormat} day */
export function total(rows, out, money, day) {
  const cents = rows.filter((row) => row.checked).reduce((sum, row) => sum + Number(row.value), 0);
  out.textContent = `${money(cents)} on ${day(Date.now())}`; // $1,234.50 on Mar 22, 2026
}
```

`t.js().number()` is a `NumberFormat` (`format(1234)`, or a decimal as its text, `format("21.5")`),
`t.js().money(USD)` a `MoneyFormat` (`format(minor)`: an integer of minor units, as
`t.money(Minor(..), USD)` takes; a float is rounded to one; `t.js().signed_money(USD)` is one
that writes as `t.signed_money` does), and `t.js().date(DateStyle)`,
`.time(TimeStyle)` and `.date_time(..)` a `DateFormat` (`format(at)`: a `Date`, milliseconds or
ISO text), in UTC unless `.zone(Offset::hours(-5))`, and `t.js().percent(2)` a `PercentFormat`
(`format(ratio)`, `format(0.029)` or `format("0.029")`, as `t.percent(ratio, 2)` writes it;
`t.js().change(2)` is one that writes as `t.change(ratio, 2)` does). A format of the wrong kind does not compile
at the call. Each is sent in `data-on` as the locale's separators, templates and names, and the
runtime writes with the server's algorithm, so the text a script writes is the text the server
rendered (`scripts/format.mjs` checks the two on every case), not what the browser's `Intl`
writes, which differs by browser and version. A zone with daylight saving time has no fixed
offset to send: write those dates on the server.

The code that writes them, `corten-format`, is a module of its own (3,005 bytes, 1,492 gzipped),
not part of the runtime: a page whose handlers take a format loads it as a module script next to
theirs, and a page whose handlers take none does not download it.

## State

A handler is a plain function shared by every instance, so state that outlives one event lives
in the DOM (an attribute, an `<output>`'s value) or with the component: `keep(() => init)` from
`corten` gives the running handler's component its object, the same one for every handler of that
instance until its root leaves the page, and another one for each other instance. No element is
passed. The component is the one whose script the handler is in: a component whose script
imports `keep` is scoped (its root is marked `data-scope`, refs or not), and a handler it passes
to a child keeps its state wherever the child renders it, as it keeps its refs. A `script!`
module is shared by components, so importing `keep` there does not compile. A component has one
state, made by the first call's `init`, so keep everything in one object the handlers share:

```js
const kept = () => keep(() => ({ index: -1, unsent: new Set() }));

/** @param {Selection} sel */
export function clear(sel) {
  kept().index = -1;
}
```

Take it first, while the handler runs: a callback the handler sets up (a timer, a listener, a
feed's rows) uses the object it got (`const s = kept();` first). Outside any handler `keep`
throws; inside one that something else's handler interrupts (an event it dispatches, a
`focus()`, a popover's `toggle`), the other handler's `keep` is that handler's component's.
`examples/deck-builder` keeps a whole screen in it: the deck the page shows, the saved deck and its
version, the undo and redo stacks and the saves still on their way, shared by its handlers and its
feed's callbacks.

## Reading a part again

`patch(html, signal?)` from `corten` applies trusted markup, not a fetched string. Its `html`
parameter is `TrustedHTML`: pages require Trusted Types, so the browser refuses a string with a
`TypeError`, and `corten check` refuses it too. Only a policy the page explicitly allows can
make that value; `patch` does not use the runtime's policy for a script's input.

When a script knows a part changed (a provider's confirmation, a timer or a message), give it
a ref to a hidden GET form marked `data-patch` and call `requestSubmit()`:

```rust,ignore
let refresh = refs();
html! {
    <form hidden method="get" action={url::Status { id }} data-patch ref={refresh}></form>
    <button type="button" on:click={js::refresh(refresh)}>{t.refresh()}</button>
}
```

```js
/** @param {HTMLFormElement} form */
export function refresh(form) {
  form.requestSubmit();
}
```

The route answers the part as a patch (`req.patch_or` if it also serves a page). The runtime
fetches and draws it through its own policy. Use `requestSubmit()`, not `submit()`, which skips
the submit event the runtime handles. For reads after a server-chosen delay, render
[`ReadAgain { after }.from(route)`](requests-and-forms.md#a-read-that-has-not-caught-up-yet)
instead; each answer decides whether to read again.

## Rules

1. Markup is written in `html!`, never built from strings in a script. A script makes new
   elements by cloning markup the server rendered (a `<template ref={rest}>`, or a view's rows,
   `rows(..).push(items)`), and moves, shows, hides or writes the ones on the page.
2. A script reaches the page only through its arguments: refs, form fields, `event`, `target`,
   `signal`, `scope`, values. A handler that looks elements up by selector is a smell.
3. User-facing text lives in views, the view model or the catalog, never in scripts. Text that
   depends on what a script computed is a message the markup passes (below).
4. Cleanup is `signal` alone: pass it to `addEventListener`, `fetch`, `subscribe` and `mount`.
   See [Cancellation](cancellation.md).

## Views

### Switching Branches

`view(host, View, template)` from `corten/views` places one server-rendered branch in `host`
and returns its generated view. Write its holes normally:

```javascript
import { DeckEditor, DeckSummary, view } from "corten/views";

// The template refs are Holds<DeckEditor, HTMLTemplateElement> and
// Holds<DeckSummary, HTMLTemplateElement>. The host is an ordinary element ref.
view(host, DeckEditor, editor).total = 7;
view(host, DeckSummary, summary).saved_total = 7;
```

Each template holds exactly one `#[component(view)]` root with a `#[derive(Id)]` id. Use a
different root id for each branch and a different key for each instance. The id is the branch's
identity, not a mutable view hole. Render it identically in the initial HTML and its template.
When that id and tag are already the host's only element child, `view` wraps the existing root:
SSR, repeated updates and reconnects do not replace it. Otherwise it clones the template, applies
the server's custom properties through the CSSOM, and replaces the host's children. It rejects
scripts, malformed roots and IDs colliding within the clone or outside the outgoing subtree
before replacing anything. It never rewrites IDs; labels, ARIA references and ID-based controls
still name the elements the server rendered. These checks are not an HTML sanitizer: templates
are trusted server markup, not user-provided HTML. Use it in the document's light DOM, where
ID-based controls resolve their targets.

`view` is not a renderer, cache, state container or lifecycle API. It does not fill child props,
preserve removed DOM, diff trees, restore focus after a switch or restore child state. The usual
delegated handlers connect new children and abort removed children's `signal`. Same-branch
updates preserve DOM-owned state such as focus, selection and an open native disclosure. A
branch switch discards it. Keep state that must survive in a component above the host, pass data
through typed events, and let children request their initial data on connect. Work begun by a
child must still respect its signal after an `await`.

`examples/deck-builder/src/views/deck_preview.rs` is a nested screen: two independent preview
owners, editor and summary views, a draft-notes child, a disclosure grandchild, and an export
child containing the kit's CopyButton. Draft notes survive branch changes in the owner; transient
editing feedback, disclosure state and copy feedback belong to the removed children.

### Reading And Writing

A component a script changes often (a row of a grid with thousands) can be a
`#[component(view)]`. Its handlers then write the component's holes by name instead of finding
elements:

```rust,ignore
#[component(view)]
pub fn Row<'a>(id: u32, label: &'a str, selected: bool, pick: Ref<el::HTMLAnchorElement>) -> impl Render {
    html! {
        <tr key={id} data-selected={selected}>
            <td>{id}</td>
            <td><a ref={pick}>{label}</a></td>
        </tr>
    }
}

#[component(js)]
fn Grid<'a>(items: &'a [Item]) -> impl Render {
    let (body, template, pick) = refs();
    html! {
        <table>
            <tbody ref={body} on:click={js::select(pick.closest(), body)}>
                for item in items {
                    <Row id={item.id} label={&item.label} selected={false} pick={pick} />
                }
            </tbody>
            <template ref={template}><Row id={0} label="" selected={false} pick={pick} /></template>
        </table>
    }
}
```

```js
// grid.js
import { Row, rows } from "corten/views";
/** @import { Holds } from "corten/views" */

/** @param {HTMLAnchorElement} link @param {Holds<Row, HTMLTableSectionElement>} body */
export function select(link, body) {
  const list = rows(body, Row); // body's rows, the same list every time
  const row = list.of(link); // the row that was clicked
  if (row) row.selected = true;
  const sixth = list.at(5); // none when there are fewer rows
  if (sixth) sixth.label += " !!!"; // writes that one text node
}
```

Views are not a second way to handle events: the markup calls handlers with `on:` as everywhere
else, and a handler that gets the list's parent (and the `<template>`, to make new rows) calls
`rows(body, Row, template)`:

| `rows()` | |
|---|---|
| `at(i)`, `get(key)`, `of(event.target)`, `indexOf(view)`, `length`, iteration | the views of the rows; `at`, `get` and `of` give none for a row that is not there, and a negative `at` counts back from the last, as an array's (`at(-1)` is the last row, so the row before the first is `i > 0 ? list.at(i - 1) : undefined`) |
| `push(items)`, `remove(view)`, `swap(i, j)`, `clear()` | change the rows; new ones are clones of the template's row, filled with their data |
| `replace(items)` | shows exactly `items`: rows with a key it had keep their element and are filled again |

A row with a form whose write takes a submit key draws the key field in the template with
`SubmitKey::template_field(f.submit)`, which holds no key, and the runtime gives each new row's
form one of its own when it is sent; `SubmitKey::field` there would give every row the template's
one key ([Requests and forms](requests-and-forms.md#forms)). The rows the server draws keep
`SubmitKey::field`, so a `Row` drawn both ways takes its key field as a prop (a
`corten::form::SubmitField`): `SubmitKey::field(f.submit)` in the loop and
`SubmitKey::template_field(f.submit)` in the `<template>`.

One parent has one list, whichever handler asks, and it notices rows changed without it (a server
patch, a sort) the next time it is used. It keeps its rows by key through its own changes and
notices a key a script sets on a row, so a handler that removes or adds rows one at a time by key
(a selection, a feed's changes) does not read every row's key again for each. A sort or a filter
reads the rows' properties, not cells by index, so a column moved in the markup cannot sort by the
wrong one and `tsc` checks the field's name and type: read each row's key once (`list.map((row) =>
({ el: row.el, key: row.label }))`), sort those (text with an `Intl.Collator` for the page's
`lang`), then `body.append(...)` the elements. Give each column its own handler (`sortByName`,
`sortByPrice`) over a shared function rather than one handler taking the field's name as text: the
markup's call is checked against the handler's name, while no call to a handler whose parameter is
a JSDoc union of strings compiles (a Rust enum the server declares, such as `SortBy`, is the other
checked way, in the table at the top of this page). `examples/seller-desk` sorts and filters its
grid this way, and `examples/deck-builder` makes its deck's lines with `replace(items)` after each
change, each filled from the collection row of the same card. Rows a script only puts in another
order, and never writes or makes, need no view: each gives its ref the value it sorts by
(`ref={row.with(sort_cents(l))}`, the number the server's own sort uses, such as a price in cents,
never a cell's text), and the handler compares the values of a `Map<HTMLTableRowElement, number>`
([A value for each element](#lists-and-larger-components)). Two rows may share the value, the
compiler checks that every row gives one of the type the handler takes, and the views module stays
off a page that needs nothing else from it. `examples/card-market`'s listings sort this way. A
table that only sorts by the header clicked needs no script of its own: corten-ui's `rows::sort`
is that handler ([UI](ui.md)).

The parameter's type says whose rows it holds: `Holds<Row, HTMLTableSectionElement>` (or
`Holds<Row, HTMLTemplateElement>` for the template). `tsc` then rejects `rows(body, Card)` and
`rows(plainElement, Row)`, and the Rust compiler rejects passing a ref whose element the markup
does not fill with `Row`s only: the ref must be on the element whose children are a loop of
`<Row .. />` (or on a `<template>` holding one `<Row .. />`), with nothing else beside them. A
component that takes such a ref as a prop names its type
`Ref<el::HTMLTableSectionElement, RowsOf<{ view_id("Row") }>>`.

| In the markup | In the view |
|---|---|
| `{label}`, the only child of an element | `label`: reads and writes that element's text |
| `data-selected={selected}`, an attribute's whole value | `selected`: the attribute (a `bool` adds or removes it) |
| `value={qty}` or `checked={on}` on an `<input>` | `qty`, `on`: what the input shows now (the user's edit), and its default |
| `key={id}` on the root | `Row.key(el)` and `Row.keyOf(data)`, what `rows()` keys by; when `id` is also used outside holes (a child's prop, an element id), only `Row.key(el)`: the server makes the rows, and `rows()` has no `push` or `replace`. Without a key, `rows()` has no `get` either: rows a script reads, removes or reorders need none |
| a parameter used any other way (`"Label: "{label}`, inside a loop, in a `class`), or a `Ref` | nothing: a script could not write it alone |

Holes are found when the crate compiles, on elements whose place is fixed (no loop, condition,
expression or component before them), so the view walks straight to them. Numbers, text and
`bool` parameters can be properties. A number property is a JavaScript number in the page, so
debug builds stop a value past 2^53 (a 64-bit id), as they do for a handler's number argument:
make such a value a string. `corten::types` declares the classes in `corten/views` (the app's
`types/app.d.ts`), and `rows()`, `view()` and `Holds` come with the crate (its `js/views.d.ts`, which
`corten check` gives `tsc`), so `row.lable = "x"` or `row.label = 3` fails `tsc`. A view needs one root
element and at least one hole, or the component does not compile. List the component in
`App::components`; `rows()` and the classes are served as one module, mapped as
`corten/views`, and only to apps with views. A page fetches it with a handler module that
imports it (or imports a module that does, or a static file in `scripts/` it imports directly),
and no other page does.

A view's class reaches `corten/views` from the component list the types test gives
`Types::components`, so keep one list per feature (`pub const COMPONENTS: &[Component]`) and give
it to both `App::components` and the types test. A view has a constant of its own even when it
shares its owner's stylesheet (`#[component(view, css = Owner)]`), and a debug build (a router test,
`corten dev`) names a rendered component that is not listed. `corten check` runs the tests before `tsc`, so a new view
is declared before a script's import of it is checked; the types test fails once, saying it
rewrote `types/app.d.ts`, and the next check passes. A Corten release that changes only the
runtime's declarations (`rows()`, `view()`, `Holds`) does not, since they ship with the crate; one
that changes how the app's own types, events or views are declared does, once, as the message says.

## Live rows

Rows the server keeps current come from a [feed](live-data.md), and the handler writes them
through [views](#views):

| Piece | Server | Browser |
|---|---|---|
| Live rows | `corten::feed::Feed<Row>`: `write(\|tx\| ...)`, `snapshot()`, `live(since)` (feature `feed`), at a route with `rows = Row` | `subscribe(feed, { snapshot, patch, status }, { signal })` in an `on:connect` handler, `feed` a `FeedUrl<Row>` parameter |
| Rendering | the rows, rendered with `html!` as `#[component(view)]`s | `rows(body, Row).get(row.id).price = row.price` for each changed row, in the same handler |

## A screen's data

A script that needs data the page did not draw (another set's products, the package for another
shipping service) reads it from the route that already answers it, typed. A route's `req.screen`
answers a data client (`Accept: application/json`) with `{"title", "data"}`; `read()` from
`corten/read` asks it for that, the way a native screen does, and returns `data` typed by the
route:

| Piece | Server | Browser |
|---|---|---|
| The data | a `ToJson` view model, added with `Types::add` | `import("../types/app").SetListing` |
| The route | `#[route("/sets/{set}", get = set, data = SetListing)]`, whose `get` handler returns `HtmlResult<Screen<SetListing>>` from `req.screen(&listing, doc)` | a handler parameter `@param {ScreenUrl<SetListing>} set` (from `corten/read`), given `url::Set { set }` in the markup |
| The read | the same handler: a browser gets the page, a script the JSON | `await read(set, { signal })`, which resolves to a `SetListing` |

```rust,ignore
#[corten::routes]
pub mod url {
    #[route("/sets/{set}", get = set, data = SetListing)]
    pub struct Set<'a> { pub set: &'a str }
}

async fn set(req: Req, Params(at): Params<url::Set<'_>>) -> HtmlResult<corten::Screen<SetListing>> {
    let listing = SetListing::read(at.set).await?;
    req.screen(&listing, set_page(&req, &listing))
}

// In another page's markup: a link per set it can switch to. Without JavaScript it opens the
// set's page; with it, its click reads the set's data and draws it here, and the address stays.
// `data-no-prefetch`, or a hover fetches the set's page, which the click then does not use.
<nav data-no-prefetch>
    for s in &sets {
        <a href={url::Set { set: &s.code }} on:click={js::switchTo(event, rows, url::Set { set: &s.code }, signal)}>{&s.name}</a>
    }
</nav>
```

```js
import { read, ReadError } from "corten/read";
/** @import { ScreenUrl } from "corten/read" */
/** @typedef {import("../types/app").SetListing} SetListing */

/** Each table's switch in progress, aborted by the next, so a slower older answer is not drawn. */
/** @type {WeakMap<HTMLTableSectionElement, AbortController>} */
const switching = new WeakMap();

/**
 * @param {MouseEvent} event @param {HTMLTableSectionElement} rows
 * @param {ScreenUrl<SetListing>} set @param {AbortSignal} signal
 */
export async function switchTo(event, rows, set, signal) {
  // A click that opens a new tab or window is the link's own.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  // Aborted when the link leaves the page or the next switch starts. Made before the click is
  // taken, so a browser that cannot (no AbortSignal.any) throws here and the link opens the page.
  const mine = new AbortController();
  const stop = AbortSignal.any([signal, mine.signal]);
  event.preventDefault();
  switching.get(rows)?.abort();
  switching.set(rows, mine);
  try {
    const listing = await read(set, { signal: stop });
    // listing.products is SetListing's, as the server declared it: draw it into rows.
  } catch (error) {
    if (stop.aborted) return; // the link left the page, or a later switch took over
    if (!(error instanceof ReadError)) throw error;
    location.assign(set); // the read failed (offline, a 401, a redirect): the set's page instead
  }
}
```

The type goes from the route to the script, checked at each step, as a feed's rows do
([Live rows](#live-rows)). The route names its data (`data = SetListing`), and its `get` handler
must return `HtmlResult<Screen<SetListing>>`, which only `req.screen` and `req.screen_with_status`
make, given a `SetListing`: a handler that answers a page or a redirect, or a screen of other
data, does not compile at its name in `#[route(..)]`, since a script's read would get no data or
the wrong data. `Screen` is `corten::Screen`, not in the prelude, so an app's own `Screen` type
is not made ambiguous. `req.screen` takes the data, or a reference, `Box`, `Rc` or `Arc` of
it, whose JSON is the data's (`req.screen(&listing, ..)` with `listing: &SetListing`). A route
says `data` without `patches` or `rows`: its `get` answers a screen, not a patch or a feed.

`SetListing` in `ScreenUrl<SetListing>` must come from the declarations `corten::types` writes:
`import("../types/app").SetListing` written there, `/** @import { SetListing } from "../types/app" */`
(at any depth, `../../types/app`), or a `@typedef` of either as above; a type the script
declares itself does not compile, since it would match by name whatever its shape. Corten checks
the path the name comes from, not the file: a file written by hand at that path is not detected,
so leave `types/app.d.ts` to `corten::types`. It stands for the Rust type of that name in the component's module, so the call takes
only a route whose data is that type; a route that names no data, or other data, does not compile
at the call. In the script a plain string is not a
`ScreenUrl`, so `read("/sets/m21")` fails `tsc`, and so does a field the data does not have. A
route says `data` only in its routes module, which mounts it with the `get` it checked; the same
route mounted again by hand (`Area::route`, `Api::route`) takes only a `get` that answers a
screen of its data, and one that answers a page or other data does not compile. A response a handler replaces through `DerefMut` or
middleware answers instead is not checked either. The data must be a type without a borrowed lifetime (`SetListing`,
not `SetListing<'a>`), since the handler's return type names it.

The read goes through the browser's HTTP cache. Corten tags a `200` it may be asked about again
with a weak `ETag` and sends it `private, no-cache` by default, so each read asks with the tag it
kept and an unchanged answer is a `304` with no body (behind a proxy, when it passes
`Accept-Encoding` and `If-None-Match` on: [deploying](deploy.md#response-compression)); a
`Public` route's `max-age` lets a read
within it make no request at all. The page and its data share the URL, and `Vary: corten, accept`
keeps a cached page from answering a read. The browser keeps one answer per URL, so the 304 holds
while nothing else fetched that URL in between: once the page itself is fetched there again (a
navigation back to it, or the runtime's hover prefetch of a link to it), the next read gets the
whole answer. So a link whose click reads, as `switchTo`'s do, sits under `data-no-prefetch`, as
a sorting table's `<thead>` does ([UI guide](ui.md)): a hover would otherwise have the server
draw the page, which the click does not use, and replace the read's cached answer. A read rejects with a `ReadError` (from `corten/read`)
when the answer is not a success (`status` is its status: a 404, a 503, or the 401 that Corten's
own sign-in refusal, a `Caller` or `Refused::sign_in`, answers a data client where a browser gets
a redirect) or when there is none it can use (`status` 0, with the error as `cause`: `fetch`'s
`TypeError` offline, a `SyntaxError` for a success that is not JSON, a `TypeError` for JSON that
is not a screen's), and with `signal`'s reason once it aborts, even when a failed answer came
first. A redirect is not followed, since its target is another route's answer: it is a
`ReadError` 0 with `redirected` true. Corten answers a data client with none, so a redirect is one
the app writes (its own middleware, or an answer it replaced): send a signed-out visitor to sign
in with `Refused::sign_in` ([Who is asking](app.md#who-is-asking)), which a script reads as a 401.
On either, a script can navigate to the URL, and the browser follows the sign-in or the redirect,
as `switchTo` does ([Limits](../design.md#limit-read-redirect)). In a handler pass `signal`, so a read the element no
longer needs is dropped when it leaves the page; the runtime reports a handler's rejected promise,
so a handler whose element can leave while it reads catches the rejection and returns when
its signal is aborted, as `switchTo` does. A read the user can start again before the last one
answers gets a controller of its own that the next one aborts, joined to `signal` with
`AbortSignal.any`, so an older answer that arrives last is never drawn. `switchTo` keeps the
address: a reload, the back button or a shared link shows the page the address names, not the set
it drew, so a switch that should be in the address is a plain link the runtime navigates, with no
handler. The envelope is checked; the data is trusted as the route's own type, as a
feed's rows are ([design Choice 40](../design.md#choice-script-boundaries)). `read()` returns
what the handler gives `req.screen`, and any script on this origin can read it with the user's
cookie, so give it only what the page itself may show that user.

Data the page needs when it loads is a handler argument, which costs no request; data it may never
need, or that a choice the user makes picks, is a read; a change to what the server draws is a
`data-patch` form. `corten/read` is a module of its own (767 bytes, 493 gzipped), served only to
apps whose scripts import it and preloaded with those scripts, so a page that reads nothing does
not download it and the runtime is unchanged; such an app's import map names it on every page (60
bytes, under 10 compressed)
([why a read and not a data block](../design.md#choice-screen-read)).
