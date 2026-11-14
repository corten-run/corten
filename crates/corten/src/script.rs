//! Behavior in the browser: handlers, plain JavaScript functions that the markup calls with the
//! elements and values they use.
//!
//! ```
//! use corten::prelude::*;
//!
//! // src/views/cart_line.rs
//! #[component(js)]
//! pub fn CartLine<'a>(name: &'a str, quantity: u32) -> impl Render {
//!     let (save, dialog) = refs();
//!     html! {
//!         <li>
//!             <input value={quantity} on:input={js::enable(save)}>
//!             <button ref={save} disabled>"Save"</button>
//!             <button on:click={js::confirm(event, dialog, name)}>"Remove"</button>
//!             <dialog ref={dialog}>"Remove it?"</dialog>
//!         </li>
//!     }
//! }
//!
//! let html = CartLine { name: "Lamp", quantity: 2 }.to_html();
//! assert!(html.contains(r#"<button data-on='click:cart_line.confirm($e,@dialog,"Lamp")'>"#));
//! ```
//!
//! ```js
//! // src/views/cart_line.js
//! /** @param {HTMLButtonElement} save */
//! export function enable(save) {
//!   save.disabled = false;
//! }
//!
//! /** @param {MouseEvent} event @param {HTMLDialogElement} dialog @param {string} name */
//! export function confirm(event, dialog, name) {
//!   event.preventDefault();
//!   dialog.dataset.name = name;
//!   dialog.showModal();
//! }
//! ```
//!
//! - `#[component(js)]` reads the script next to the component (`cart_line.js`, its name in
//!   snake_case) when the crate compiles, and gives the component a module `js` with one Rust
//!   function per `export function`. A call checks the arguments against the handler's JSDoc:
//!   `js::enable(save)` compiles only if `save` is a `<button>` (or the JSDoc says a wider
//!   type), and a missing or misspelled handler does not compile.
//! - `let (save, dialog) = refs();` names elements. Each ref's element type is inferred from the
//!   tag it is put on (`ref={save}` on a `<button>`), and a ref put on elements in a `for` loop is
//!   every one of them, an array in the script. A component with refs has one root element, which
//!   marks where its refs end.
//! - Inside `on:...={..}`, four names are the browser's: `event`, `target` (the element with the
//!   `on:`), `signal` (aborts when that element leaves the page) and `scope` (the root element of
//!   the component that made the handler). Their types come from the event and the tag.
//! - Other arguments are values, sent as JSON: strings, numbers, booleans, typed routes (their
//!   URL), and with feature `json` anything `ToJson`. `data-on` is a single-quoted attribute, so
//!   the JSON's quotes are written as they are, and a list of a few hundred records for a script
//!   (a set it searches and sorts) costs about its JSON's size; only `&`, `'`, `<` and `>` are
//!   written as entities.
//! - `on:connect` runs when the element joins the page (its `signal` aborts when it leaves).
//! - `on:document:keydown` runs for that event anywhere on the page while the element is on it,
//!   after the handlers on the event's path (unless one stopped it), as a listener on the
//!   document would: a screen's shortcuts, whatever has focus. `target` is still the element with
//!   the `on:`, and `event` is typed by the event's name.
//! - A handler is a value: a component takes one as a prop (`on_remove: Handler`) and puts it on
//!   an element (`on:click={on_remove}`); the parent sets it with `on:remove={js::submit(form)}`.
//! - [`script!`] declares a module shared by several components, and [`event`] a typed DOM
//!   event a script dispatches and markup listens for (`on:RowToggled={..}`).
//!
//! Lists and larger components:
//!
//! - **One handler for a list.** `row.closest()` is the element with ref `row` around the event's
//!   target, so `<tbody on:click={js::pick(row.closest())}>` handles a click on any row; the
//!   handler runs only for clicks inside one.
//! - **Groups.** A `@typedef` in the script whose properties include elements becomes a struct,
//!   `js::Selection { rows: row, count }`, built once in the component and passed as one
//!   argument wherever the handlers need the same elements.
//! - **Keys.** `key={item.id}` on the elements of a ref makes a parameter typed
//!   `Map<string, HTMLTableCellElement>` get them by key, for rows a feed updates by id. Every
//!   element of the ref has a key, or the call does not compile ([`Keyed`]).
//! - **Values.** `ref={row.with(cents)}` gives each element of a ref a value, and a parameter
//!   typed `Map<HTMLTableRowElement, number>` gets every one with its value ([`Ref::with`]), for
//!   rows a script sorts or filters by what the server gave them, never a `data-` attribute it
//!   reads by name.
//! - **Typed events.** A parameter typed with a class imported from `"corten/events"` takes only
//!   the `event` of an `on:` for that `#[event]` type (which must be in scope in the
//!   component's module).
//!
//! ```
//! use corten::prelude::*;
//!
//! #[corten::script::event]
//! pub struct RowToggled {
//!     pub id: String,
//!     pub selected: bool,
//! }
//!
//! // stock_grid.js:
//! //   /** @typedef {object} Selection @property {HTMLTableRowElement[]} rows @property {HTMLOutputElement} count */
//! //   export function toggle(row, sel)     row: HTMLTableRowElement, sel: Selection
//! //   export function toggled(event, sel)  event: RowToggled (from "corten/events")
//! //   export function show(cells, id)      cells: Map<string, HTMLTableCellElement>, id: string
//! #[component(js)]
//! fn StockGrid<'a>(rows: &'a [(&'a str, u32)]) -> impl Render {
//!     let (row, count, qty) = refs();
//!     let sel = js::Selection { rows: row, count };
//!     html! {
//!         <table>
//!             <tbody on:click={js::toggle(row.closest(), sel)} on:RowToggled={js::toggled(event, sel)}>
//!                 for (id, n) in rows.iter() {
//!                     <tr ref={row}><td ref={qty} key={*id}>{*n}</td></tr>
//!                 }
//!             </tbody>
//!             <caption><output ref={count}>"0"</output></caption>
//!             <tfoot on:connect={js::show(qty, "a")}></tfoot>
//!         </table>
//!     }
//! }
//!
//! # fn main() {
//! let html = StockGrid { rows: &[("a", 1)] }.to_html();
//! assert!(html.contains(r#"data-on='click:stock_grid.toggle(^row,{rows:*row,count:@count})"#));
//! assert!(html.contains(r#"<td data-ref="qty" data-key="a">1</td>"#));
//! # }
//! ```
//!
//! The browser gets plain HTML: `data-ref="save"` and `data-on='click:cart_line.enable(@save)'`.
//! One listener per event type on the document runs the handlers; nothing runs per element until
//! an event reaches it.
//!
//! A component is scoped (one root element, marked `data-scope`) when it has refs, one of its
//! handlers takes `scope`, or its script imports `keep` (state each instance keeps); in a part
//! (`js = Owner`, below), the owner's handlers' `scope` is the owner's root and does not count. A
//! variable that happens to be named `scope` does not count:
//!
//! ```
//! use corten::prelude::*;
//! # #[corten::script::event]
//! # pub struct RowToggled {
//! #     pub id: String,
//! #     pub selected: bool,
//! # }
//!
//! #[component(js)]
//! fn StockGrid() -> impl Render {
//!     html! { <table><caption><button on:click={js::clear(scope)}>"Clear"</button></caption></table> }
//! }
//!
//! #[component]
//! fn Mode<'a>(mode: &'a str) -> impl Render {
//!     let scope = mode;
//!     html! {
//!         <dt>"Selection"</dt>
//!         <dd>{scope}</dd>
//!     }
//! }
//!
//! # fn main() {
//! assert!(StockGrid {}.to_html().starts_with(r#"<table data-scope="stock-grid">"#));
//! assert_eq!(Mode { mode: "ids" }.to_html(), "<dt>Selection</dt><dd>ids</dd>");
//! # }
//! ```
//!
//! A part of a component (a sheet, a row, a field drawn by a function of its own) calls its
//! owner's handlers with `#[component(js = Owner)]` (`js = path::to::Owner` from another module
//! that can see it): `js` there is the owner's module, so the page loads the owner's one script,
//! and the part adds none. Its refs are its own, as any component's:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! pub fn CartLine<'a>(name: &'a str, quantity: u32) -> impl Render {
//!     html! { <li>{name}<Quantity quantity={quantity} /></li> }
//! }
//!
//! /// The line's quantity field, with the line's handlers.
//! #[component(js = CartLine)]
//! fn Quantity(quantity: u32) -> impl Render {
//!     let save = refs();
//!     html! {
//!         <span>
//!             <input value={quantity} on:input={js::enable(save)}>
//!             <button ref={save} disabled>"Save"</button>
//!         </span>
//!     }
//! }
//!
//! let html = CartLine { name: "Lamp", quantity: 2 }.to_html();
//! assert!(html.contains(r#"<span data-scope="quantity"><input value="2" data-on='input:cart_line.enable(@save)'>"#), "{html}");
//! ```
//!
//! A handler of the owner's that takes `scope` gets the owner's root, so the owner has one (a
//! ref, a handler that takes `scope`, or a script that keeps state); a part whose owner has none
//! does not compile, and says so:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! pub fn CartLine<'a>(name: &'a str) -> impl Render {
//!     let line = refs();
//!     html! { <li ref={line}>{name}<RemoveButton /></li> }
//! }
//!
//! #[component(js = CartLine)]
//! fn RemoveButton() -> impl Render {
//!     html! { <button type="button" on:click={js::remove(scope)}>"Remove"</button> }
//! }
//!
//! let html = CartLine { name: "Lamp" }.to_html();
//! assert!(html.starts_with(r#"<li data-scope="cart-line""#), "{html}");
//! ```
//!
//! ```compile_fail,E0080
//! use corten::prelude::*;
//!
//! #[component(js)]
//! pub fn CartLine<'a>(name: &'a str) -> impl Render {
//!     html! { <li>{name}<RemoveButton /></li> }
//! }
//!
//! #[component(js = CartLine)]
//! fn RemoveButton() -> impl Render {
//!     html! { <button type="button" on:click={js::remove(scope)}>"Remove"</button> }
//! }
//! ```
//!
//! The owner has a script, or `js = Owner` does not compile:
//!
//! ```compile_fail,E0432
//! use corten::prelude::*;
//!
//! #[component]
//! fn Plain() -> impl Render {
//!     html! { <li></li> }
//! }
//!
//! #[component(js = Plain)]
//! fn Part() -> impl Render {
//!     html! { <span></span> }
//! }
//! ```
//!
//! A script is served by its name (`scripts/cart_line.js`), so two components with one name in
//! different modules of one crate fail to compile, rather than the app when it starts. `cargo
//! check` reports it too: E0428 at both components, naming `corten__two_scripts_are__cart_line`.
//! In two crates, the program fails to link on every platform and profile once it uses both:
//!
//! ```compile_fail,E0428
//! mod orders {
//!     use corten::prelude::*;
//!     #[component(js)]
//!     pub fn CartLine() -> impl Render {
//!         html! { <li></li> }
//!     }
//! }
//! mod returns {
//!     use corten::prelude::*;
//!     #[component(js)]
//!     pub fn CartLine() -> impl Render {
//!         html! { <li></li> }
//!     }
//! }
//! fn main() {
//!     let _ = (orders::CartLine, returns::CartLine);
//! }
//! ```
//!
//! The same holds for a typed event (`#[event]`): `corten/events` exports one class of a name and
//! the page dispatches one event of a name, so two `RowToggled`s fail to build
//! (`corten__two_events_are__RowToggled`):
//!
//! ```compile_fail,E0428
//! mod orders {
//!     #[corten::script::event]
//!     pub struct RowToggled {
//!         pub id: String,
//!     }
//! }
//! mod returns {
//!     #[corten::script::event]
//!     pub struct RowToggled {
//!         pub id: u32,
//!     }
//! }
//! fn main() {
//!     let _ = (orders::RowToggled, returns::RowToggled);
//! }
//! ```
//!
//! and so do two classes whose events have one name, `UrlChanged` and `URLChanged` (both
//! `url-changed` on the page, `corten__two_events_named__url_changed`):
//!
//! ```compile_fail,E0428
//! #[corten::script::event]
//! pub struct UrlChanged {
//!     pub to: String,
//! }
//! #[corten::script::event]
//! pub struct URLChanged {
//!     pub to: String,
//! }
//! fn main() {
//!     let _ = (UrlChanged { to: String::new() }, URLChanged { to: String::new() });
//! }
//! ```
//!
//! A typed event is named apart from the browser's and the runtime's (`KeyboardEvent`,
//! `CortenError`, `CortenNotice`), since a handler's `@param` naming one of those is checked as
//! that event:
//!
//! ```compile_fail
//! #[corten::script::event]
//! pub struct CortenError {
//!     pub status: u16,
//! }
//! fn main() {}
//! ```
//!
//! A feed's URL carries the feed's rows to the script. The route names them (`rows = Level`),
//! its handler answers with them (`FeedResponse<Level>`), and the handler parameter that takes the
//! route is a `FeedUrl<Level>` (from `corten`; `Level` is the Rust type of that name in the
//! component's module), from which `subscribe()` takes the row type:
//!
//! ```
//! # #[cfg(feature = "feed")]
//! # mod app {
//! use corten::{feed::{Feed, FeedResponse, Row}, prelude::*};
//!
//! #[derive(Clone, serde::Serialize, Row)]
//! pub struct Level { #[row(id)] id: String, qty: u32 }
//!
//! #[corten::routes(state = Feed<Level>)]
//! pub mod url {
//!     #[route("/feed/levels", get = levels, rows = Level)]
//!     pub struct Levels;
//! }
//!
//! async fn levels(State(feed): State<Feed<Level>>) -> FeedResponse<Level> {
//!     feed.snapshot()
//! }
//!
//! // level_feed.js: @param {FeedUrl<Level>} feed
//! #[component(js)]
//! pub fn LevelFeed() -> impl Render {
//!     let body = refs();
//!     html! { <table><tbody ref={body} on:connect={js::follow(body, url::Levels, signal)}></tbody></table> }
//! }
//! # }
//! # fn main() {
//! # use corten::prelude::*;
//! # #[cfg(feature = "feed")]
//! assert!(app::LevelFeed {}.to_html().contains(r#"level_feed.follow(@body,"/feed/levels",$s)"#));
//! # }
//! ```
//!
//! What does not compile:
//!
//! A feed whose route does not name its rows:
//!
//! ```compile_fail
//! use corten::{feed::{Feed, FeedResponse, Row}, prelude::*};
//!
//! #[derive(Clone, serde::Serialize, Row)]
//! pub struct Level { #[row(id)] id: String }
//! #[derive(Clone, serde::Serialize, Row)]
//! pub struct Stock { #[row(id)] id: String }
//!
//! #[corten::routes(state = Feed<Level>)]
//! pub mod url {
//!     #[route("/feed/levels", get = levels)]
//!     pub struct Levels;
//! }
//!
//! async fn levels(State(feed): State<Feed<Level>>) -> FeedResponse<Level> { feed.snapshot() }
//!
//! # fn main() { let _ = url::router; }
//! ```
//!
//! A handler that answers with other rows than its route names:
//!
//! ```compile_fail
//! use corten::{feed::{Feed, FeedResponse, Row}, prelude::*};
//!
//! #[derive(Clone, serde::Serialize, Row)]
//! pub struct Level { #[row(id)] id: String }
//! #[derive(Clone, serde::Serialize, Row)]
//! pub struct Stock { #[row(id)] id: String }
//!
//! #[corten::routes(state = Feed<Level>)]
//! pub mod url {
//!     #[route("/feed/levels", get = levels, rows = Stock)]
//!     pub struct Levels;
//! }
//!
//! async fn levels(State(feed): State<Feed<Level>>) -> FeedResponse<Level> { feed.snapshot() }
//!
//! # fn main() { let _ = url::router; }
//! ```
//!
//! A route passed for a `FeedUrl<Level>` that is not a feed of `Level` rows (`url::Home` serves a
//! page):
//!
//! ```compile_fail
//! use corten::{feed::{Feed, FeedResponse, Row}, prelude::*};
//!
//! #[derive(Clone, serde::Serialize, Row)]
//! pub struct Level { #[row(id)] id: String }
//! #[derive(Clone, serde::Serialize, Row)]
//! pub struct Stock { #[row(id)] id: String }
//!
//! #[corten::routes(state = Feed<Level>)]
//! pub mod url {
//!     #[route("/", get = home)]
//!     pub struct Home;
//!     #[route("/feed/levels", get = levels, rows = Level)]
//!     pub struct Levels;
//! }
//!
//! async fn levels(State(feed): State<Feed<Level>>) -> FeedResponse<Level> { feed.snapshot() }
//! async fn home() -> &'static str { "home" }
//!
//! #[component(js)]
//! fn LevelFeed() -> impl Render {
//!     let body = refs();
//!     html! { <table><tbody ref={body} on:connect={js::follow(body, url::Home, signal)}></tbody></table> }
//! }
//! # fn main() { let _ = url::router; }
//! ```
//!
//! A feed of another type with the same name (`stock::Level`, where the component's `Level` is
//! this module's):
//!
//! ```compile_fail
//! use corten::{feed::{Feed, FeedResponse, Row}, prelude::*};
//!
//! #[derive(Clone, serde::Serialize, Row)]
//! pub struct Level { #[row(id)] id: String, qty: u32 }
//! mod stock {
//!     #[derive(Clone, serde::Serialize, corten::feed::Row)]
//!     pub struct Level { #[row(id)] pub id: String, pub name: String }
//! }
//!
//! #[corten::routes(state = Feed<stock::Level>)]
//! pub mod url {
//!     #[route("/feed/levels", get = levels, rows = stock::Level)]
//!     pub struct Levels;
//! }
//!
//! async fn levels(State(feed): State<Feed<stock::Level>>) -> FeedResponse<stock::Level> { feed.snapshot() }
//!
//! #[component(js)]
//! fn LevelFeed() -> impl Render {
//!     let body = refs();
//!     html! { <table><tbody ref={body} on:connect={js::follow(body, url::Levels, signal)}></tbody></table> }
//! }
//! # fn main() { let _ = url::router; }
//! ```
//!
//! A ref on an element the handler does not take (`enable` takes a `<button>`):
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine<'a>(name: &'a str, quantity: u32) -> impl Render {
//!     let save = refs();
//!     html! { <li><input ref={save} on:input={js::enable(save)}></li> }
//! }
//! ```
//!
//! A handler the script does not export:
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine<'a>(name: &'a str, quantity: u32) -> impl Render {
//!     let save = refs();
//!     html! { <li><button ref={save} on:click={js::enabel(save)}></button></li> }
//! }
//! ```
//!
//! A value of the wrong type (`name` is a `string`):
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine<'a>(name: &'a str, quantity: u32) -> impl Render {
//!     let dialog = refs();
//!     html! { <li><button on:click={js::confirm(event, dialog, quantity)}></button><dialog ref={dialog}></dialog></li> }
//! }
//! ```
//!
//! A ref or handler written as text:
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine<'a>(name: &'a str, quantity: u32) -> impl Render {
//!     html! { <li><button ref="save"></button></li> }
//! }
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine<'a>(name: &'a str, quantity: u32) -> impl Render {
//!     html! { <li><button data-on="click:cart_line.enable(@save)"></button></li> }
//! }
//! ```
//!
//! A handler for an event anywhere on the page is typed by that event, as on the element
//! (`shortcut` takes a `KeyboardEvent`):
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li on:document:keydown={js::shortcut(event, target)}></li> }
//! }
//! # fn main() {
//! assert!(CartLine {}.to_html().contains(r#"data-on='document.keydown:cart_line.shortcut($e,$t)'"#));
//! # }
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li on:document:click={js::shortcut(event, target)}></li> }
//! }
//! # fn main() {}
//! ```
//!
//! The runtime's own events are named with a colon: `corten:error` on a `data-patch` form whose
//! submit got no answer it can draw (it bubbles, so `on:document:corten:error` hears every form's),
//! and `corten:notice` on the document for a redirect's notice the page did not draw, which only
//! `on:document:corten:notice` hears. A handler takes them as `@param {CortenError} event` and
//! `@param {CortenNotice} event`, which `corten` declares (`/** @import { CortenError } from
//! "corten" */`): `CustomEvent`s whose `detail` is `{ status: number, error?: unknown }` and
//! `{ message: string }`, so the script reads it as the runtime writes it and `tsc` checks that:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li><form on:corten:error={js::failed(event, target)}></form></li> }
//! }
//! # fn main() {
//! assert!(CartLine {}.to_html().contains(r#"data-on='corten:error:cart_line.failed($e,$t)'"#));
//! # }
//! ```
//!
//! A handler for another event does not take it (`shortcut` takes a `KeyboardEvent`):
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li on:corten:error={js::shortcut(event, target)}><form></form></li> }
//! }
//! # fn main() {}
//! ```
//!
//! Nor does a `CortenError` handler take another event, or the `signal`:
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li><form on:click={js::failed(event, target)}></form></li> }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li><form on:submit={js::failed(signal, target)}></form></li> }
//! }
//! # fn main() {}
//! ```
//!
//! A handler that types an event's `detail` itself (`CustomEvent<{ status: number }>`) is checked
//! as a `CustomEvent`: it takes `corten:error`, and not a click:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li><form on:corten:error={js::sent(event)}></form></li> }
//! }
//! # fn main() { let _ = CartLine {}.to_html(); }
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li><button on:click={js::sent(event)}>"Send"</button></li> }
//! }
//! # fn main() {}
//! ```
//!
//! A `CortenNotice` handler takes `corten:notice`, not `corten:error`:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li on:document:corten:notice={js::said(event)}></li> }
//! }
//! # fn main() { let _ = CartLine {}.to_html(); }
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li><form on:corten:error={js::said(event)}></form></li> }
//! }
//! # fn main() {}
//! ```
//!
//! `corten:progress` is a `data-patch` form's upload progress: while a multipart write is sent, the
//! form gets the browser's `ProgressEvent` (`loaded`, `total`, `lengthComputable`, counting the
//! whole request's body), and a page with such a form loads the upload module that sends it. It
//! does not bubble, so it is heard on the `<form>` alone:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let bar = refs();
//!     html! {
//!         <li><form data-patch method="post" enctype="multipart/form-data" on:corten:progress={js::progressed(event, bar)}>
//!             <progress ref={bar}></progress>
//!         </form></li>
//!     }
//! }
//! # fn main() {
//! assert!(CartLine {}.to_html().contains(r#"corten:progress:cart_line.progressed($e,"#));
//! # }
//! ```
//!
//! A `ProgressEvent` handler takes nothing else, and another event's handler does not take it:
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let bar = refs();
//!     html! { <li><form on:submit={js::progressed(event, bar)}><progress ref={bar}></progress></form></li> }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li><form data-patch method="post" enctype="multipart/form-data" on:corten:progress={js::failed(event, target)}></form></li> }
//! }
//! # fn main() {}
//! ```
//!
//! Nor is it heard on a form the runtime sends without it (one without `data-patch`, a GET form, or
//! one whose body is not `multipart/form-data`), on another element, or on the document:
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let bar = refs();
//!     html! {
//!         <li><form method="post" enctype="multipart/form-data" on:corten:progress={js::progressed(event, bar)}>
//!             <progress ref={bar}></progress>
//!         </form></li>
//!     }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let bar = refs();
//!     html! {
//!         <li><form data-patch method="get" enctype="multipart/form-data" on:corten:progress={js::progressed(event, bar)}>
//!             <progress ref={bar}></progress>
//!         </form></li>
//!     }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let bar = refs();
//!     html! {
//!         <li><form data-patch method="dialog" enctype="multipart/form-data" on:corten:progress={js::progressed(event, bar)}>
//!             <progress ref={bar}></progress>
//!         </form></li>
//!     }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let bar = refs();
//!     html! {
//!         <li><form data-patch method="post" on:corten:progress={js::progressed(event, bar)}>
//!             <progress ref={bar}></progress>
//!         </form></li>
//!     }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let bar = refs();
//!     html! { <li on:corten:progress={js::progressed(event, bar)}><progress ref={bar}></progress></li> }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let bar = refs();
//!     html! { <li on:document:corten:progress={js::progressed(event, bar)}><progress ref={bar}></progress></li> }
//! }
//! # fn main() {}
//! ```
//!
//! A browser event's handler takes it as lib.dom's `HTMLElementEventMap` types it, except where an
//! element fires a plainer one: an image's or media element's `error`, `abort`, `progress` and
//! `resize` are `Event`s (lib.dom gives them the window's and XMLHttpRequest's types). A form's
//! `formdata`, fired when its entries are read (a submit, `new FormData(form)`), is a
//! `FormDataEvent`, so a handler can change what the form sends without rebuilding the body: here
//! it leaves out blank fields, so a `GET` form's address has only the filters set. It bubbles, so
//! `on:document:formdata` hears every form's:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li on:document:formdata={js::tidy(event)}><form on:formdata={js::tidy(event)}></form></li> }
//! }
//! # fn main() {
//! let html = CartLine {}.to_html();
//! assert!(html.contains(r#"data-on='document.formdata:cart_line.tidy($e)'"#), "{html}");
//! assert!(html.contains(r#"data-on='formdata:cart_line.tidy($e)'"#), "{html}");
//! # }
//! ```
//!
//! A `FormDataEvent` handler takes no other event, and another event's handler does not take it:
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li><form on:click={js::tidy(event)}></form></li> }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li on:formdata={js::shortcut(event, target)}><form></form></li> }
//! }
//! # fn main() {}
//! ```
//!
//! A page's `securitypolicyviolation`, a `SecurityPolicyViolationEvent` for each thing its CSP
//! refused, bubbles to the document (probed for an image the CSP refused, fired at the document):
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li on:document:securitypolicyviolation={js::refused(event)}></li> }
//! }
//! # fn main() {
//! assert!(CartLine {}.to_html().contains(r#"data-on='document.securitypolicyviolation:cart_line.refused($e)'"#));
//! # }
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li on:document:click={js::refused(event)}></li> }
//! }
//! # fn main() {}
//! ```
//!
//! A media element's `progress` is a plain `Event`, so a `ProgressEvent` handler does not take it,
//! nor an `ErrorEvent` handler (the window's) an image's `error`:
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let bar = refs();
//!     html! { <li><video on:progress={js::progressed(event, bar)}></video><progress ref={bar}></progress></li> }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li><img src="https://cdn.example/a.png" alt="" on:error={js::crashed(event)}></li> }
//! }
//! # fn main() {}
//! ```
//!
//! `on:` takes no other name with a colon, so the same markup with `corten:notice` (no element
//! hears it) or any other does not compile; a component's own event is an `#[event]` type, and
//! another library's is heard by a listener its script adds:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li on:corten:error={js::remove(target)}><form></form></li> }
//! }
//! # fn main() {
//! assert!(CartLine {}.to_html().contains(r#"data-on='corten:error:cart_line.remove($t)'"#));
//! # }
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li on:corten:notice={js::remove(target)}><form></form></li> }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     html! { <li on:corten:saved={js::remove(target)}><form></form></li> }
//! }
//! # fn main() {}
//! ```
//!
//! `on:document:` takes an event of the browser's that bubbles to the document: not `connect`
//! (the element's own), not `focus` (`focusin` is the one that bubbles), and not a typed event
//! (heard on an element it bubbles through):
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let save = refs();
//!     html! { <li on:document:connect={js::enable(save)}><button ref={save}></button></li> }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let save = refs();
//!     html! { <li on:document:focus={js::enable(save)}><button ref={save}></button></li> }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let save = refs();
//!     html! { <li on:document:RowToggled={js::enable(save)}><button ref={save}></button></li> }
//! }
//! # fn main() {}
//! ```
//!
//! The same markup with an event that bubbles compiles, so each one above fails for its event:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CartLine() -> impl Render {
//!     let save = refs();
//!     html! { <li on:document:focusin={js::enable(save)}><button ref={save}></button></li> }
//! }
//! # fn main() {}
//! ```
//!
//! A parameter typed by a declaration `corten::types` generated (`import("../types/app").Tab`)
//! takes a value of the Rust type of that name in the component's module, so a call cannot pass
//! another value, and a renamed variant fails to build:
//!
#![cfg_attr(feature = "json", doc = "```")]
#![cfg_attr(not(feature = "json"), doc = "```ignore")]
//! use corten::prelude::*;
//!
//! #[derive(Clone, Copy, ToJson)]
//! #[serde(rename_all = "kebab-case")]
//! enum Tab { Details, Offers }
//!
//! #[component(js)]
//! fn TabBar() -> impl Render {
//!     html! { <nav on:click={js::show(target, Tab::Offers)}></nav> }
//! }
//! # fn main() {
//! assert!(TabBar {}.to_html().contains(r#"tab_bar.show($t,"offers")"#), "{}", TabBar {}.to_html());
//! # }
//! ```
//!
//! ```compile_fail,E0277
//! use corten::prelude::*;
//!
//! #[derive(Clone, Copy, ToJson)]
//! enum Tab { Details, Offers }
//!
//! #[component(js)]
//! fn TabBar() -> impl Render {
//!     html! { <nav on:click={js::show(target, "offers")}></nav> }
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail,E0277
//! use corten::prelude::*;
//!
//! #[derive(Clone, Copy, ToJson)]
//! enum Tab { Details, Offers }
//!
//! #[component(js)]
//! fn TabBar() -> impl Render {
//!     html! { <nav on:click={js::show(target, 42)}></nav> }
//! }
//! # fn main() {}
//! ```
//!
//! A call takes as many arguments as the function has, each checked against its parameter, the
//! fourteenth as strictly as the first:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn Mixer() -> impl Render {
//!     let (a, b, c, d, e, f, g, h) = refs();
//!     html! {
//!         <div on:connect={js::start(a, b, c, d, e, f, g, h, "i", "j", "k", "l", "m", "n", "o", signal)}>
//!             <canvas ref={a}></canvas><p ref={b}></p><p ref={c}></p><button ref={d}></button>
//!             <input ref={e}><select ref={f}></select><output ref={g}></output><button ref={h}></button>
//!         </div>
//!     }
//! }
//! # fn main() {
//! assert!(Mixer {}.to_html().contains(r#"mixer.start(@a,@b,@c,@d,@e,@f,@g,@h,"i","#));
//! # }
//! ```
//!
//! Past twelve, the arguments are held in halves, each halved again past twelve, so a call of 25
//! (twelve, then six and seven) writes every argument in its place:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn Mixer() -> impl Render {
//!     let (a, b, c, d, e, f, g, h) = refs();
//!     html! {
//!         <div on:connect={js::long(a, b, c, d, e, f, g, h, "1", "2", "3", "4", "5", "6", "7", "8",
//!             "9", "10", "11", "12", "13", "14", "15", "16", signal)}>
//!             <canvas ref={a}></canvas><p ref={b}></p><p ref={c}></p><button ref={d}></button>
//!             <input ref={e}><select ref={f}></select><output ref={g}></output><button ref={h}></button>
//!         </div>
//!     }
//! }
//! # fn main() {
//! let html = Mixer {}.to_html();
//! assert!(html.contains(r#"mixer.long(@a,@b,@c,@d,@e,@f,@g,@h,"1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16",$s)"#), "{html}");
//! # }
//! ```
//!
//! ```compile_fail,E0277
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn Mixer() -> impl Render {
//!     let (a, b, c, d, e, f, g, h) = refs();
//!     html! {
//!         <div on:connect={js::start(a, b, c, d, e, f, g, h, "i", "j", "k", "l", "m", 42, "o", signal)}>
//!             <canvas ref={a}></canvas><p ref={b}></p><p ref={c}></p><button ref={d}></button>
//!             <input ref={e}><select ref={f}></select><output ref={g}></output><button ref={h}></button>
//!         </div>
//!     }
//! }
//! # fn main() {}
//! ```
//!
//! A call to a handler whose parameter is a string literal union (`@param {"list" | "grid"} mode`)
//! does not compile: the parameter would take any value. Such a name is a Rust enum with a
//! generated declaration, as above. The script itself compiles, so an export that only other
//! scripts import types its parameters as it needs:
//!
//! ```compile_fail,E0277
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn ModeSwitch() -> impl Render {
//!     html! { <nav on:click={js::show(target, "list")}></nav> }
//! }
//! # fn main() {}
//! ```
//!
//! ```
//! use corten::prelude::*;
//!
//! // The same script, its handler not called: it compiles.
//! #[component(js)]
//! fn ModeSwitch() -> impl Render {
//!     html! { <nav></nav> }
//! }
//! # fn main() {}
//! ```
//!
//! Any other JSON shape (`{ count: number }`, `number[]`, `string | null`, a `@typedef` of plain
//! values) has no Rust type the call is checked against, so a call to its handler does not
//! compile either, whatever it passes; type the value with a generated declaration, as above:
//!
//! ```compile_fail,E0277
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CountBadge() -> impl Render {
//!     html! { <p on:click={js::show(target, 42)}></p> }
//! }
//! # fn main() {}
//! ```
//!
//! nor a value of the right shape, since nothing checks the shape:
//!
#![cfg_attr(feature = "json", doc = "```compile_fail,E0277")]
#![cfg_attr(not(feature = "json"), doc = "```ignore")]
//! use corten::prelude::*;
//!
//! #[derive(ToJson)]
//! struct Count { count: u32 }
//!
//! #[component(js)]
//! fn CountBadge() -> impl Render {
//!     html! { <p on:click={js::show(target, Count { count: 3 })}></p> }
//! }
//! # fn main() {}
//! ```
//!
//! nor through a `@typedef` of plain values (`counted` takes a `Count`, `{ count: number }`):
//!
#![cfg_attr(feature = "json", doc = "```compile_fail,E0277")]
#![cfg_attr(not(feature = "json"), doc = "```ignore")]
//! use corten::prelude::*;
//!
//! #[derive(ToJson)]
//! struct Count { count: u32 }
//!
//! #[component(js)]
//! fn CountBadge() -> impl Render {
//!     html! { <p on:click={js::counted(target, Count { count: 3 })}></p> }
//! }
//! # fn main() {}
//! ```
//!
//! nor a group with a field of such a type (`tally` takes a `Badge`, whose `ids` is `number[]`):
//!
#![cfg_attr(feature = "json", doc = "```compile_fail,E0277")]
#![cfg_attr(not(feature = "json"), doc = "```ignore")]
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CountBadge() -> impl Render {
//!     let out = refs();
//!     let badge = js::Badge { out, ids: [1, 2] };
//!     html! { <p on:click={js::tally(badge)}><output ref={out}></output></p> }
//! }
//! # fn main() {}
//! ```
//!
//! A parameter typed `unknown` claims nothing the call does not check: it takes any `ToJson`
//! value, and the script narrows it before using it:
//!
#![cfg_attr(feature = "json", doc = "```")]
#![cfg_attr(not(feature = "json"), doc = "```ignore")]
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn CountBadge() -> impl Render {
//!     html! { <p on:click={js::raw(target, 42)}></p> }
//! }
//! # fn main() {
//! assert!(CountBadge {}.to_html().contains("count_badge.raw($t,42)"), "{}", CountBadge {}.to_html());
//! # }
//! ```
//!
//! A typed event's handler on another event (`toggled` takes a `RowToggled`, a click is a
//! `MouseEvent`):
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[corten::script::event]
//! pub struct RowToggled {
//!     pub id: String,
//!     pub selected: bool,
//! }
//!
//! #[component(js)]
//! fn StockGrid() -> impl Render {
//!     let (row, count) = refs();
//!     let sel = js::Selection { rows: row, count };
//!     html! {
//!         <table>
//!             <tbody on:click={js::toggled(event, sel)}><tr ref={row}></tr></tbody>
//!             <caption><output ref={count}></output></caption>
//!         </table>
//!     }
//! }
//! # fn main() {}
//! ```
//!
//! The same with the class imported for its type alone (`/** @import { RowToggled } from
//! "corten/events" */`, `toggle_note.js`):
//!
//! ```compile_fail,E0277
//! use corten::prelude::*;
//!
//! #[corten::script::event]
//! pub struct RowToggled {
//!     pub id: String,
//!     pub selected: bool,
//! }
//!
//! #[component(js)]
//! fn ToggleNote() -> impl Render {
//!     html! { <p on:click={js::toggled(event, target)}></p> }
//! }
//! # fn main() {}
//! ```
//!
//! ```
//! use corten::prelude::*;
//!
//! #[corten::script::event]
//! pub struct RowToggled {
//!     pub id: String,
//!     pub selected: bool,
//! }
//!
//! #[component(js)]
//! fn ToggleNote() -> impl Render {
//!     html! { <p on:RowToggled={js::toggled(event, target)}></p> }
//! }
//! # fn main() {}
//! ```
//!
//! A script that imports an event its component's module does not have: the event is served
//! with the script, so it is the Rust `#[event]` in scope (`stock_grid.js` imports `RowToggled`):
//!
//! ```compile_fail,E0425
//! use corten::prelude::*;
//!
//! #[component(js)]
//! fn StockGrid() -> impl Render {
//!     let (row, count) = refs();
//!     let sel = js::Selection { rows: row, count };
//!     html! {
//!         <table>
//!             <tbody on:click={js::toggle(row.closest(), sel)}><tr ref={row}></tr></tbody>
//!             <caption><output ref={count}></output></caption>
//!         </table>
//!     }
//! }
//! # fn main() {}
//! ```
//!
//! A group field on the wrong element (`count` is an `<output>`):
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! #[corten::script::event]
//! pub struct RowToggled {
//!     pub id: String,
//!     pub selected: bool,
//! }
//!
//! #[component(js)]
//! fn StockGrid() -> impl Render {
//!     let (row, count) = refs();
//!     let sel = js::Selection { rows: row, count };
//!     html! {
//!         <table>
//!             <tbody on:click={js::toggle(row.closest(), sel)}><tr ref={row}></tr></tbody>
//!             <caption><span ref={count}></span></caption>
//!         </table>
//!     }
//! }
//! # fn main() {}
//! ```
//!
//! State kept in a `script!` module, which components share (`keep` is one component's, in its
//! own script):
//!
//! ```compile_fail
//! corten::script::script!(mod tally = "script/tally.js");
//! # fn main() {}
//! ```
//!
//! and refs outside a component's body:
//!
//! ```compile_fail
//! use corten::prelude::*;
//!
//! fn helper() -> Ref {
//!     refs()
//! }
//! ```

use std::{
    cell::{Cell, RefCell},
    marker::PhantomData,
};

pub use corten_macros::{event, script};

use crate::Component;

/// A script module: the handlers of a `#[component(js)]` or a [`script!`] module.
#[derive(Clone, Copy, Debug)]
pub struct Script {
    /// The module's name in the page, its file's stem: `"cart_line"`.
    pub name: &'static str,
    /// The file, next to the component: `"cart_line.js"`.
    pub file: &'static str,
    /// Its source as the browser receives it, compiled into the binary: the file without its
    /// comments, each line where it was (a licence comment, `/*! .. */` or `//! ..`, stays, as
    /// does `//# sourceMappingURL=`).
    pub source: &'static str,
    /// The functions it exports, which the markup may call.
    pub handlers: &'static [&'static str],
    /// The typed events (`#[event]`) it imports from `corten/events` when it runs. They are
    /// served with it, so an app that lists the script's component has them without listing them.
    pub events: &'static [crate::Component],
    /// The script modules of its directory it imports (`import { load } from "./stripe.js"` is
    /// `"stripe"`): a page that loads it preloads them, and the app must list them.
    pub imports: &'static [&'static str],
}

/// A typed DOM event, from [`event`]: its name in the page and its fields, for the class the
/// browser imports from `corten/events`.
#[derive(Clone, Copy, Debug)]
pub struct EventDef {
    /// The Rust name, also the JavaScript class: `"RowToggled"`.
    pub class: &'static str,
    /// The event's type in the page: `"row-toggled"`.
    pub name: &'static str,
    /// The fields, in order.
    pub fields: &'static [Field],
}

/// A field of an [`EventDef`].
#[derive(Clone, Copy, Debug)]
pub struct Field {
    pub name: &'static str,
    #[doc(hidden)]
    pub ts: crate::script::__private::TsType,
}

/// What `#[component(view)]` generates: a class whose properties are the component's holes (a
/// parameter that is the whole text of an element, or an attribute's whole value), read from and
/// written to the page. Scripts import it from `corten/views`.
///
/// ```
/// use corten::prelude::*;
///
/// #[component(view)]
/// pub fn Row<'a>(id: u32, label: &'a str, selected: bool) -> impl Render {
///     html! {
///         <tr key={id} data-selected={selected}>
///             <td>{id}</td>
///             <td><a>{label}</a></td>
///         </tr>
///     }
/// }
///
/// # fn main() {
/// let view = Row.view.unwrap();
/// assert_eq!(view.class, "Row");
/// // `row.label = "x"` writes the link's text; `row.selected = true` adds the attribute.
/// assert!(view.js.contains("set label(v) { text(this.el.firstElementChild.nextElementSibling.firstElementChild, v); }"));
/// assert!(view.js.contains(r#"set selected(v) { this.el.toggleAttribute("data-selected", v); }"#));
/// assert!(view.ts.contains("label: string;") && view.ts.contains("id: number;"));
/// // `key={id}` keys the rows.
/// assert!(view.js.contains(r#"static key(el) { return el.getAttribute("data-key") ?? ""; }"#));
/// # }
/// ```
///
/// A hole on a `<form>` is read and written through Element's own members, since a form's
/// controls' names shadow its own (`<button name="remove">` is `form.remove`):
///
/// ```
/// use corten::prelude::*;
///
/// #[component(view)]
/// pub fn Line(id: u32, busy: bool) -> impl Render {
///     html! {
///         <form key={id} data-busy={busy}>
///             <button name="remove">"Remove"</button>
///         </form>
///     }
/// }
///
/// # fn main() {
/// let js = Line.view.unwrap().js;
/// assert!(js.contains(r#"Element.prototype.hasAttribute.call(this.el, "data-busy")"#), "{js}");
/// assert!(js.contains(r#"set busy(v) { Element.prototype.toggleAttribute.call(this.el, "data-busy", v); }"#), "{js}");
/// assert!(js.contains(r#"if (Element.prototype.hasAttribute.call(el, "data-busy") !== data.busy) Element.prototype.toggleAttribute.call(el, "data-busy", data.busy);"#), "{js}");
/// assert!(js.contains(r#"static key(el) { return Element.prototype.getAttribute.call(el, "data-key") ?? ""; }"#), "{js}");
/// # }
/// ```
///
/// An `<input>`'s `value` and `checked` are what it shows now, which the user changes: the view
/// reads and writes them as properties (and writes the default a form reset goes back to).
///
/// ```
/// use corten::prelude::*;
///
/// #[component(view)]
/// pub fn Line(qty: u32, gift: bool) -> impl Render {
///     html! {
///         <li><input name="qty" value={qty}><input type="checkbox" checked={gift}></li>
///     }
/// }
///
/// # fn main() {
/// let view = Line.view.unwrap();
/// assert!(view.js.contains("get qty() { return Number(this.el.firstElementChild.value); }"));
/// assert!(view.js.contains("set qty(v) { value(this.el.firstElementChild, String(v)); }"));
/// assert!(view.js.contains("get gift() { return this.el.firstElementChild.nextElementSibling.checked; }"));
/// # }
/// ```
///
/// A number property is a JavaScript number in the page, so debug builds stop a value past 2^53
/// (`Order { id: u64::MAX }` panics), as they do for a handler's number argument:
///
/// ```
/// use corten::prelude::*;
///
/// #[component(view)]
/// pub fn Order(id: u64) -> impl Render {
///     html! { <b>{id}</b> }
/// }
///
/// # fn main() {
/// assert_eq!(Order { id: (1 << 53) - 1 }.to_html(), "<b>9007199254740991</b>");
/// # }
/// ```
///
/// A view needs one root element and at least one hole:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(view)]
/// fn Pair<'a>(a: &'a str) -> impl Render {
///     html! { <b>{a}</b><i>"x"</i> }
/// }
/// ```
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// // `label` is part of a longer text, so a script could not write it alone.
/// #[component(view)]
/// fn Label<'a>(label: &'a str) -> impl Render {
///     html! { <p>"Label: "{label}</p> }
/// }
/// ```
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// // A view's key is one of its parameters, alone.
/// #[component(view)]
/// fn Keyed<'a>(id: &'a str, label: &'a str) -> impl Render {
///     html! { <li key={id.len()}><b>{label}</b>" #"{id}</li> }
/// }
/// ```
///
/// A key the markup also shows outside its holes (here in a longer text) makes a view whose rows
/// the server makes: its class has `key` but no `keyOf`, so `rows()` cannot `push` or `replace`.
///
/// ```
/// use corten::prelude::*;
///
/// #[component(view)]
/// fn Line<'a>(id: &'a str, label: &'a str) -> impl Render {
///     html! { <li key={id}><b>{label}</b>" #"{id}</li> }
/// }
///
/// # fn main() {
/// let view = Line.view.expect("a view");
/// assert!(view.js.contains("static key(el)") && !view.js.contains("keyOf"), "{}", view.js);
/// # }
/// ```
///
/// `corten/views` exports one class of a name, so two views of one name in different modules of
/// one crate fail to compile, rather than the app when it starts. `cargo check` reports it too:
/// E0428 at both views, naming `corten__two_views_are__Row`. In two crates, the program fails to
/// link on every platform once it uses both, in every profile:
///
/// ```compile_fail,E0428
/// mod orders {
///     use corten::prelude::*;
///     #[component(view)]
///     pub fn Row(id: u32) -> impl Render {
///         html! { <tr><td>{id}</td></tr> }
///     }
/// }
/// mod returns {
///     use corten::prelude::*;
///     #[component(view)]
///     pub fn Row(id: u32) -> impl Render {
///         html! { <tr><td>{id}</td></tr> }
///     }
/// }
/// fn main() {
///     let _ = (orders::Row, returns::Row);
/// }
/// ```
#[derive(Clone, Copy, Debug)]
pub struct ViewDef {
    /// The Rust name, also the JavaScript class: `"Row"`.
    pub class: &'static str,
    /// The class, `export class Row { .. }`, which uses the module's helper `text`.
    pub js: &'static str,
    /// Its declaration, for `declare module "corten/views"`.
    pub ts: &'static str,
}

/// The start of `views.js`: `rows()` and the helpers the generated classes call by name
/// (`text`, `value`, `checked`), built from `js/view.js`. Its declarations are `js/views.d.ts`,
/// which ships with the crate: an app's `types/app.d.ts` holds only its own view classes.
const VIEW_HELPERS: &str = concat!(include_str!("../js/dist/view.js"), "export { rows, view };\n");

/// The `corten/views` module: the view class of every listed `#[component(view)]`, or `None`
/// when no component has one. A component listed twice counts once; two different views with one
/// name (`ui::Row` and `Row`) are an error, since a script imports a view by its name.
pub fn views_module(components: &[Component]) -> Result<Option<String>, String> {
    let mut seen: Vec<ViewDef> = Vec::new();
    let mut out = String::new();
    for view in components.iter().filter_map(|c| c.view) {
        if let Some(same) = seen.iter().find(|v| v.class == view.class) {
            if same.js == view.js {
                continue;
            }
            return Err(format!("two views named {}: a script imports a view by its name, so rename one", view.class));
        }
        if out.is_empty() {
            out.push_str(VIEW_HELPERS);
        }
        seen.push(view);
        out.push_str(view.js);
    }
    Ok((!out.is_empty()).then_some(out))
}

/// A script module as Corten serves it: its source, then the lines that hand its exports to the
/// runtime (a `corten:module` event on `document`), so the page can load it with a module script
/// and the runtime finds it without an `import()`. The runtime exports nothing for this: it takes
/// the event only from the module the page's own script tag for that name loaded, once, while the
/// page loads. The
/// bench uses it for the same reason.
#[doc(hidden)]
pub fn served(name: &str, source: &str) -> String {
    let mut out = String::with_capacity(source.len() + 200 + 2 * name.len());
    out.push_str(source);
    if !source.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("import \"corten\";\n");
    out.push_str("import * as __corten_self from \"./");
    out.push_str(name);
    out.push_str(".js\";\ndocument.dispatchEvent(new CustomEvent(\"corten:module\", { detail: { name: \"");
    out.push_str(name);
    out.push_str("\", url: import.meta.url, exports: __corten_self } }));\n");
    out
}

/// A Rust type that is a DOM event: [`event`] implements it.
pub trait DomEvent {
    /// Its type in the page, `"row-toggled"`.
    const NAME: &'static str;
}

/// A named element of a component: `let (rows, rest) = refs();`. `T` is the element's DOM
/// interface, inferred from the tag it is put on. Pass it to a handler (a parameter typed `T` gets
/// the first element with it, `T[]` every one), or to a child component that puts it on one of
/// its elements.
///
/// `V` is what the element holds, for a handler that takes a view's rows
/// (`@param {Holds<Row, HTMLTableSectionElement>} body`): [`RowsOf`] when every child the
/// markup puts in it is that `#[component(view)]` (`for line in lines { <Row .. /> }`, or the one
/// `<Row .. />` of a `<template>`), [`NoRows`] otherwise.
///
/// `W` is the kind of value each element gives its script, for a handler that takes the elements
/// with their values (`@param {Map<HTMLTableRowElement, number>} rows`): [`ts::Number`],
/// [`ts::String`] or [`ts::Boolean`] when the markup puts it on every element with a value,
/// `ref={row.with(cents)}` ([`Ref::with`]), [`NoValue`] when it gives none.
///
/// `K` is whether its elements have keys, for a handler that takes them by key
/// (`@param {Map<string, HTMLTableCellElement>} cells`): [`Keyed`] when the markup puts it on
/// every element with a `key={..}`, [`NoKey`] when on none.
pub struct Ref<T = el::HTMLElement, V = NoRows, W = NoValue, K = NoKey> {
    scope: &'static str,
    name: &'static str,
    kind: PhantomData<fn() -> (T, V)>,
    value: PhantomData<fn() -> (W, K)>,
}

/// A ref whose element the markup fills with something other than one view's rows.
pub enum NoRows {}

/// A ref whose elements give their script no value: put as `ref={row}`, not `ref={row.with(..)}`.
pub enum NoValue {}

/// A ref whose elements have no `key={..}`, which a `Map<string, El>` parameter does not take.
pub enum NoKey {}

/// A ref whose every element has a `key={..}`, which a handler parameter typed
/// `Map<string, El>` gets by key ([`ts::Map`]). The type a component's prop names for a parent's
/// ref it puts on keyed elements, `Ref<el::HTMLTableCellElement, NoRows, NoValue, Keyed>`:
///
/// ```
/// use corten::prelude::*;
/// use corten::script::{Keyed, NoRows, NoValue};
///
/// #[component]
/// fn QtyCells<'a>(ids: &'a [&'a str], qty: Ref<el::HTMLTableCellElement, NoRows, NoValue, Keyed>) -> impl Render {
///     html! { <tr>for id in ids.iter() { <td ref={qty} key={*id}>"0"</td> }</tr> }
/// }
///
/// // stock_grid.js: export function show(cells, id), cells a Map<string, HTMLTableCellElement>.
/// // Its other handlers take a RowToggled from "corten/events", so the #[event] type is in scope.
/// #[corten::script::event]
/// pub struct RowToggled {
///     pub id: String,
///     pub selected: bool,
/// }
///
/// #[component(js)]
/// fn StockGrid<'a>(ids: &'a [&'a str]) -> impl Render {
///     let qty = refs();
///     html! {
///         <table>
///             <tbody><QtyCells ids={ids} qty={qty} /></tbody>
///             <tfoot on:connect={js::show(qty, "a")}></tfoot>
///         </table>
///     }
/// }
///
/// # fn main() {
/// let html = StockGrid { ids: &["a", "b"] }.to_html();
/// assert!(html.contains(r#"<td data-ref="qty" data-key="b">0</td>"#), "{html}");
/// # }
/// ```
///
/// A prop that leaves it out, `Ref<el::HTMLTableCellElement>`, is a ref without keys, and an
/// element with a key does not take it:
///
/// ```compile_fail,E0277
/// use corten::prelude::*;
///
/// #[component]
/// fn QtyCells<'a>(ids: &'a [&'a str], qty: Ref<el::HTMLTableCellElement>) -> impl Render {
///     html! { <tr>for id in ids.iter() { <td ref={qty} key={*id}>"0"</td> }</tr> }
/// }
/// # fn main() {}
/// ```
pub enum Keyed {}

/// A ref whose element holds only rows of one `#[component(view)]`, named by [`view_id`] of its
/// name: the type a component's prop names for such a ref,
/// `Ref<el::HTMLTableSectionElement, RowsOf<{ view_id("Row") }>>`.
///
/// A handler that calls `rows(body, OrderRow)` types `body` as
/// `Holds<OrderRow, HTMLTableSectionElement>` (from `corten/views`), and only a ref on an element
/// the markup fills with `OrderRow`s fits it:
///
/// ```
/// use corten::prelude::*;
///
/// #[component(view)]
/// fn OrderRow(id: u32) -> impl Render {
///     html! { <tr key={id}><td>{id}</td></tr> }
/// }
///
/// // order_list.js: export function clear(body), body a Holds<OrderRow, HTMLTableSectionElement>.
/// #[component(js)]
/// fn OrderList<'a>(ids: &'a [u32]) -> impl Render {
///     let body = refs();
///     html! {
///         <table>
///             <tbody ref={body} on:dblclick={js::clear(body)}>
///                 for id in ids.iter() { <OrderRow id={*id} /> }
///             </tbody>
///         </table>
///     }
/// }
///
/// # fn main() {
/// assert!(OrderList { ids: &[1, 2] }.to_html().contains(r#"<tr data-key="2"><td>2</td></tr>"#));
/// # }
/// ```
///
/// Rows of another view, or anything else beside the rows, do not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(view)]
/// fn OrderRow(id: u32) -> impl Render {
///     html! { <tr key={id}><td>{id}</td></tr> }
/// }
///
/// #[component(js)]
/// fn OrderList<'a>(ids: &'a [u32]) -> impl Render {
///     let body = refs();
///     html! {
///         <table>
///             <tbody ref={body} on:dblclick={js::clear(body)}>
///                 for id in ids.iter() { <OrderRow id={*id} /> }
///                 <tr><td>"Total"</td></tr>
///             </tbody>
///         </table>
///     }
/// }
/// # fn main() {}
/// ```
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(view)]
/// fn Note(id: u32) -> impl Render {
///     html! { <tr key={id}><td>{id}</td></tr> }
/// }
///
/// #[component(js)]
/// fn OrderList<'a>(ids: &'a [u32]) -> impl Render {
///     let body = refs();
///     html! {
///         <table>
///             <tbody ref={body} on:dblclick={js::clear(body)}>
///                 for id in ids.iter() { <Note id={*id} /> }
///             </tbody>
///         </table>
///     }
/// }
/// # fn main() {}
/// ```
pub struct RowsOf<const VIEW: u64>(());

/// The number [`RowsOf`] names a view by: FNV-1a of its name, the name scripts import it by. A
/// component that puts a parent's ref on the element holding the rows names it with this:
///
/// ```
/// use corten::prelude::*;
/// use corten::script::{RowsOf, view_id};
///
/// #[component(view)]
/// fn OrderRow(id: u32) -> impl Render {
///     html! { <tr key={id}><td>{id}</td></tr> }
/// }
///
/// #[component]
/// fn OrderBody<'a>(ids: &'a [u32], body: Ref<el::HTMLTableSectionElement, RowsOf<{ view_id("OrderRow") }>>) -> impl Render {
///     html! { <tbody ref={body}>for id in ids.iter() { <OrderRow id={*id} /> }</tbody> }
/// }
///
/// // order_list.js: export function clear(body), body a Holds<OrderRow, HTMLTableSectionElement>.
/// #[component(js)]
/// fn OrderList<'a>(ids: &'a [u32]) -> impl Render {
///     let body = refs();
///     html! { <table on:dblclick={js::clear(body)}><OrderBody ids={ids} body={body} /></table> }
/// }
///
/// # fn main() {
/// let html = OrderList { ids: &[1] }.to_html();
/// assert!(html.contains(r#"<tbody data-ref="body"><tr data-key="1">"#), "{html}");
/// # }
/// ```
pub const fn view_id(name: &str) -> u64 {
    let bytes = name.as_bytes();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut i = 0;
    while i < bytes.len() {
        hash ^= bytes[i] as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
        i += 1;
    }
    hash
}

impl<T, V, W, K> Clone for Ref<T, V, W, K> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T, V, W, K> Copy for Ref<T, V, W, K> {}

impl<T, V, W, K> std::fmt::Debug for Ref<T, V, W, K> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Ref({}/{})", self.scope, self.name)
    }
}

impl<T, V, W, K> Ref<T, V, W, K> {
    /// The element with this ref that holds the event's target, like the DOM's
    /// `event.target.closest(..)`: one handler on a list's container gets the row that was
    /// clicked. A handler with a `closest()` argument runs only for events inside such an
    /// element, so it also says which clicks it is for.
    ///
    /// ```
    /// use corten::prelude::*;
    ///
    /// // stock_grid.js: export function pick(row), row an HTMLTableRowElement. Its other handlers
    /// // take a RowToggled from "corten/events", so the #[event] type is in scope here.
    /// #[corten::script::event]
    /// pub struct RowToggled {
    ///     pub id: String,
    ///     pub selected: bool,
    /// }
    ///
    /// #[component(js)]
    /// fn StockGrid<'a>(ids: &'a [&'a str]) -> impl Render {
    ///     let row = refs();
    ///     html! {
    ///         <table>
    ///             <tbody on:click={js::pick(row.closest())}>
    ///                 for id in ids.iter() { <tr ref={row}><td>{id}</td></tr> }
    ///             </tbody>
    ///         </table>
    ///     }
    /// }
    ///
    /// # fn main() {
    /// let html = StockGrid { ids: &["a", "b"] }.to_html();
    /// assert!(html.contains(r#"<tbody data-on='click:stock_grid.pick(^row)'>"#));
    /// assert!(html.contains(r#"<tr data-ref="row"><td>a</td></tr>"#));
    /// # }
    /// ```
    pub const fn closest(self) -> Closest<T> {
        Closest(Ref { scope: self.scope, name: self.name, kind: PhantomData, value: PhantomData })
    }

    /// This ref, put on an element with a value for its script: `ref={row.with(cents)}`. A
    /// handler parameter typed `Map<HTMLTableRowElement, number>` (or `string`, or `boolean`) gets
    /// every element with the ref and its value, in the page's order, so rows a script only puts
    /// in another order carry what they sort by without a `data-` attribute the script names as
    /// text. The value is named once, here: the script reads it from the map, and the call is
    /// checked as any ref's is. A number is a number in the script, written as a handler's number
    /// argument is: an integer past 2^53 stops debug builds, and a float that is NaN or infinite
    /// arrives as `null`, since JSON has neither.
    ///
    /// ```
    /// use corten::prelude::*;
    ///
    /// // price_list.js: export function sort(body, rows), body an HTMLTableSectionElement and
    /// // rows a Map<HTMLTableRowElement, number>, each row with the cents it gives its ref.
    /// #[component(js)]
    /// fn PriceList<'a>(prices: &'a [(&'a str, u32)]) -> impl Render {
    ///     let (body, row) = refs();
    ///     html! {
    ///         <table>
    ///             <tbody ref={body} on:dblclick={js::sort(body, row)}>
    ///                 for (name, cents) in prices.iter() {
    ///                     <tr ref={row.with(*cents)}><td>{*name}</td></tr>
    ///                 }
    ///             </tbody>
    ///         </table>
    ///     }
    /// }
    ///
    /// # fn main() {
    /// let html = PriceList { prices: &[("Lamp", 1250), ("Rug", 900)] }.to_html();
    /// assert!(html.contains(r#"<tbody data-ref="body" data-on='dblclick:price_list.sort(@body,=row)'>"#), "{html}");
    /// assert!(html.contains(r#"<tr data-ref="row" data-ref-value='1250'><td>Lamp</td></tr>"#), "{html}");
    /// # }
    /// ```
    ///
    /// Every element with the ref gives a value of one kind, which the handler's parameter names.
    /// Rows that give none, or text where the handler takes numbers, do not compile:
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    ///
    /// #[component(js)]
    /// fn PriceList<'a>(prices: &'a [(&'a str, u32)]) -> impl Render {
    ///     let (body, row) = refs();
    ///     html! {
    ///         <table>
    ///             <tbody ref={body} on:dblclick={js::sort(body, row)}>
    ///                 for (name, _) in prices.iter() { <tr ref={row}><td>{*name}</td></tr> }
    ///             </tbody>
    ///         </table>
    ///     }
    /// }
    /// # fn main() {}
    /// ```
    ///
    /// ```compile_fail,E0271
    /// use corten::prelude::*;
    ///
    /// #[component(js)]
    /// fn PriceList<'a>(prices: &'a [(&'a str, u32)]) -> impl Render {
    ///     let (body, row) = refs();
    ///     html! {
    ///         <table>
    ///             <tbody ref={body} on:dblclick={js::sort(body, row)}>
    ///                 for (name, _) in prices.iter() { <tr ref={row.with(*name)}><td>{*name}</td></tr> }
    ///             </tbody>
    ///         </table>
    ///     }
    /// }
    /// # fn main() {}
    /// ```
    ///
    /// Nor does a ref given a value on some elements and not on others:
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    ///
    /// #[component(js)]
    /// fn PriceList<'a>(prices: &'a [(&'a str, u32)]) -> impl Render {
    ///     let (body, row) = refs();
    ///     html! {
    ///         <table>
    ///             <tbody ref={body} on:dblclick={js::sort(body, row)}>
    ///                 for (name, cents) in prices.iter() { <tr ref={row.with(*cents)}><td>{*name}</td></tr> }
    ///                 <tr ref={row}><td>"Total"</td></tr>
    ///             </tbody>
    ///         </table>
    ///     }
    /// }
    /// # fn main() {}
    /// ```
    ///
    /// The attribute is Corten's, as `data-ref` is: markup that writes it by hand does not compile.
    ///
    /// ```compile_fail
    /// use corten::prelude::*;
    ///
    /// #[component]
    /// fn PriceRow() -> impl Render {
    ///     html! { <tr data-ref-value="1250"><td>"Lamp"</td></tr> }
    /// }
    /// # fn main() {}
    /// ```
    pub fn with<X: RefValue<Kind = W>>(self, value: X) -> Valued<T, V, X, K> {
        Valued { at: self, value }
    }
}

/// What [`Ref::closest`] returns: the element with the ref around the event's target.
pub struct Closest<T>(Ref<T>);

impl<T> Clone for Closest<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Closest<T> {}

/// What [`Ref::with`] returns: the ref, put on an element with its value.
pub struct Valued<T, V, X: RefValue, K = NoKey> {
    at: Ref<T, V, X::Kind, K>,
    value: X,
}

/// A value an element gives its ref's handlers ([`Ref::with`]): a number ([`ts::Number`]), text
/// ([`ts::String`]) or a `bool` ([`ts::Boolean`]), the kinds a handler's `Map<El, number>`,
/// `Map<El, string>` or `Map<El, boolean>` takes. It is sealed: an app's own type gives the
/// number or text it stands for.
#[diagnostic::on_unimplemented(
    message = "an element gives its script a number, text or a bool with its ref, not {Self}",
    label = "the value of ref={{row.with(..)}}",
    note = "give the number or text it stands for, the one the script compares"
)]
pub trait RefValue: value::Sealed {
    /// What the handler's parameter calls it.
    type Kind;
    #[doc(hidden)]
    fn write_value(&self, out: &mut String);
}

mod value {
    /// Implemented by the values [`super::RefValue`] is, and nothing outside Corten.
    pub trait Sealed {}
}

macro_rules! ref_values {
    ($kind:ty: $($t:ty),*) => {$(
        impl value::Sealed for $t {}
        impl RefValue for $t {
            type Kind = $kind;
            #[inline]
            fn write_value(&self, out: &mut String) {
                Arg::<$kind>::write_arg(self, &__private::Ctx { current: None, home: None }, out)
            }
        }
    )*};
}
ref_values!(ts::Number: u8, u16, u32, u64, usize, i8, i16, i32, i64, isize, f32, f64);
ref_values!(ts::Boolean: bool);
ref_values!(ts::String: String, std::borrow::Cow<'_, str>);

impl value::Sealed for str {}
impl RefValue for str {
    type Kind = ts::String;
    #[inline]
    fn write_value(&self, out: &mut String) {
        __private::json_str(self, out)
    }
}

impl<X: RefValue + ?Sized> value::Sealed for &X {}
impl<X: RefValue + ?Sized> RefValue for &X {
    type Kind = X::Kind;
    #[inline]
    fn write_value(&self, out: &mut String) {
        (**self).write_value(out)
    }
}

/// `let (rows, rest) = refs();` at the top of a component's body names the elements its script
/// uses. `#[component]` replaces the call with each ref; anywhere else it does not compile.
pub fn refs<T: __private::Refs>() -> T {
    unreachable!("#[component] replaces refs()")
}

/// A handler call the markup puts on an element: what `js::enable(save)` returns. Components
/// take one as a prop with the type [`Handler`].
pub trait Bind {
    #[doc(hidden)]
    fn write_bind(&self, out: &mut String);
    /// False for a handler that is not there (`None`): its `on:` is left out, and a component
    /// can leave out what only the handler reads (the kit's `SortHeader` its `data-` links).
    fn present(&self) -> bool {
        true
    }
}

/// A handler passed to a component: `#[component] fn Confirm(on_confirm: Handler) -> impl Render`,
/// set by the parent with `<Confirm on:confirm={js::submit(form)} />`.
pub type Handler<'a> = &'a dyn Bind;

impl<T: Bind + ?Sized> Bind for &T {
    fn write_bind(&self, out: &mut String) {
        (**self).write_bind(out)
    }
    fn present(&self) -> bool {
        (**self).present()
    }
}

impl<T: Bind> Bind for Option<T> {
    fn write_bind(&self, out: &mut String) {
        if let Some(bind) = self {
            bind.write_bind(out)
        }
    }
    fn present(&self) -> bool {
        self.as_ref().is_some_and(Bind::present)
    }
}

/// An argument a handler parameter of type `P` accepts. `P` is what the handler's JSDoc says:
/// an element interface (`el::HTMLButtonElement`), `ts::Array<..>` for an array of them, an
/// event interface (`ev::KeyboardEvent`), or one of [`ts`]'s.
#[diagnostic::on_unimplemented(
    message = "this argument does not match the handler's JSDoc type {P}",
    label = "the handler's JSDoc says {P}",
    note = "refs are typed by the tag they are on, event and target by the on: attribute, values by their Rust type"
)]
pub trait Arg<P> {
    #[doc(hidden)]
    fn write_arg(&self, ctx: &__private::Ctx, out: &mut String);
}

/// What a handler parameter needs when its JSDoc type is one no call can be checked against (a set
/// of names written as string literals, a generated declaration inside another type, a JSON shape
/// no Rust type stands for, `{ count: number }`, an element or event type outside the checked
/// forms, `HTMLElementTagNameMap["dialog"]`): nothing has it, so a call does not compile, and the
/// handler's deprecation note says why. The handler
/// itself compiles, so an export only other scripts import is the script's to type. It is sealed:
/// nothing outside Corten can implement it either.
#[diagnostic::on_unimplemented(
    message = "the script types this handler parameter so that no call can be checked against it",
    label = "the warning on this handler says why",
    note = "a set of names, or any other JSON value, is a Rust type with a generated declaration, import(\"../types/app\").Name, and a list or an optional one a Rust type of its own; an element or an event takes an interface the scripts guide lists as checked (several events the one they share, UIEvent or Event); a parameter typed unknown takes any argument"
)]
pub trait Refused: refused::Sealed {}

mod refused {
    /// Implemented by nothing, so [`super::Refused`] is not either.
    pub trait Sealed {}
}

/// DOM element interfaces, named as in TypeScript's lib.dom.
#[allow(clippy::upper_case_acronyms)]
pub mod el {
    /// An element interface.
    pub trait Elem {
        /// Its name in TypeScript: `"HTMLButtonElement"`.
        const TS: &'static str;
    }

    /// `Self` is a `P`: every `HTMLButtonElement` is an `HTMLElement` and an `Element`.
    #[diagnostic::on_unimplemented(
        message = "the handler takes an {P}, and this is an {Self}",
        label = "an {Self}, from the tag its ref is on",
        note = "put the ref on an element the handler takes, or widen the JSDoc type (HTMLElement takes any HTML element)"
    )]
    pub trait SubOf<P> {}

    macro_rules! elements {
        ($name:ident: $($parent:ident),+) => {
            #[doc = concat!("`", stringify!($name), "`.")]
            pub enum $name {}
            impl Elem for $name {
                const TS: &'static str = stringify!($name);
            }
            $(impl SubOf<$parent> for $name {})+
            impl<T: SubOf<$name>, V, W, K> super::__private::RefParam<T, V, W, K> for $name {
                const SIGIL: &'static str = "@";
            }
        };
    }

    elements!(Element: Element);
    elements!(HTMLElement: HTMLElement, Element);
    elements!(HTMLMediaElement: HTMLMediaElement, Element, HTMLElement);
    elements!(SVGElement: SVGElement, Element);
    elements!(SVGSVGElement: SVGSVGElement, Element, SVGElement);
    elements!(HTMLAnchorElement: HTMLAnchorElement, Element, HTMLElement);
    elements!(HTMLAreaElement: HTMLAreaElement, Element, HTMLElement);
    elements!(HTMLAudioElement: HTMLAudioElement, Element, HTMLElement, HTMLMediaElement);
    elements!(HTMLBRElement: HTMLBRElement, Element, HTMLElement);
    elements!(HTMLBaseElement: HTMLBaseElement, Element, HTMLElement);
    elements!(HTMLBodyElement: HTMLBodyElement, Element, HTMLElement);
    elements!(HTMLButtonElement: HTMLButtonElement, Element, HTMLElement);
    elements!(HTMLCanvasElement: HTMLCanvasElement, Element, HTMLElement);
    elements!(HTMLDataElement: HTMLDataElement, Element, HTMLElement);
    elements!(HTMLDataListElement: HTMLDataListElement, Element, HTMLElement);
    elements!(HTMLDetailsElement: HTMLDetailsElement, Element, HTMLElement);
    elements!(HTMLDialogElement: HTMLDialogElement, Element, HTMLElement);
    elements!(HTMLDivElement: HTMLDivElement, Element, HTMLElement);
    elements!(HTMLDListElement: HTMLDListElement, Element, HTMLElement);
    elements!(HTMLEmbedElement: HTMLEmbedElement, Element, HTMLElement);
    elements!(HTMLFieldSetElement: HTMLFieldSetElement, Element, HTMLElement);
    elements!(HTMLFormElement: HTMLFormElement, Element, HTMLElement);
    elements!(HTMLHeadingElement: HTMLHeadingElement, Element, HTMLElement);
    elements!(HTMLHeadElement: HTMLHeadElement, Element, HTMLElement);
    elements!(HTMLHRElement: HTMLHRElement, Element, HTMLElement);
    elements!(HTMLHtmlElement: HTMLHtmlElement, Element, HTMLElement);
    elements!(HTMLIFrameElement: HTMLIFrameElement, Element, HTMLElement);
    elements!(HTMLImageElement: HTMLImageElement, Element, HTMLElement);
    elements!(HTMLInputElement: HTMLInputElement, Element, HTMLElement);
    elements!(HTMLLabelElement: HTMLLabelElement, Element, HTMLElement);
    elements!(HTMLLegendElement: HTMLLegendElement, Element, HTMLElement);
    elements!(HTMLLIElement: HTMLLIElement, Element, HTMLElement);
    elements!(HTMLLinkElement: HTMLLinkElement, Element, HTMLElement);
    elements!(HTMLMapElement: HTMLMapElement, Element, HTMLElement);
    elements!(HTMLMenuElement: HTMLMenuElement, Element, HTMLElement);
    elements!(HTMLMetaElement: HTMLMetaElement, Element, HTMLElement);
    elements!(HTMLMeterElement: HTMLMeterElement, Element, HTMLElement);
    elements!(HTMLModElement: HTMLModElement, Element, HTMLElement);
    elements!(HTMLObjectElement: HTMLObjectElement, Element, HTMLElement);
    elements!(HTMLOListElement: HTMLOListElement, Element, HTMLElement);
    elements!(HTMLOptGroupElement: HTMLOptGroupElement, Element, HTMLElement);
    elements!(HTMLOptionElement: HTMLOptionElement, Element, HTMLElement);
    elements!(HTMLOutputElement: HTMLOutputElement, Element, HTMLElement);
    elements!(HTMLParagraphElement: HTMLParagraphElement, Element, HTMLElement);
    elements!(HTMLPictureElement: HTMLPictureElement, Element, HTMLElement);
    elements!(HTMLPreElement: HTMLPreElement, Element, HTMLElement);
    elements!(HTMLProgressElement: HTMLProgressElement, Element, HTMLElement);
    elements!(HTMLQuoteElement: HTMLQuoteElement, Element, HTMLElement);
    elements!(HTMLScriptElement: HTMLScriptElement, Element, HTMLElement);
    elements!(HTMLSelectElement: HTMLSelectElement, Element, HTMLElement);
    elements!(HTMLSlotElement: HTMLSlotElement, Element, HTMLElement);
    elements!(HTMLSourceElement: HTMLSourceElement, Element, HTMLElement);
    elements!(HTMLSpanElement: HTMLSpanElement, Element, HTMLElement);
    elements!(HTMLStyleElement: HTMLStyleElement, Element, HTMLElement);
    elements!(HTMLTableCaptionElement: HTMLTableCaptionElement, Element, HTMLElement);
    elements!(HTMLTableCellElement: HTMLTableCellElement, Element, HTMLElement);
    elements!(HTMLTableColElement: HTMLTableColElement, Element, HTMLElement);
    elements!(HTMLTableElement: HTMLTableElement, Element, HTMLElement);
    elements!(HTMLTableRowElement: HTMLTableRowElement, Element, HTMLElement);
    elements!(HTMLTableSectionElement: HTMLTableSectionElement, Element, HTMLElement);
    elements!(HTMLTemplateElement: HTMLTemplateElement, Element, HTMLElement);
    elements!(HTMLTextAreaElement: HTMLTextAreaElement, Element, HTMLElement);
    elements!(HTMLTimeElement: HTMLTimeElement, Element, HTMLElement);
    elements!(HTMLTitleElement: HTMLTitleElement, Element, HTMLElement);
    elements!(HTMLTrackElement: HTMLTrackElement, Element, HTMLElement);
    elements!(HTMLUListElement: HTMLUListElement, Element, HTMLElement);
    elements!(HTMLVideoElement: HTMLVideoElement, Element, HTMLElement, HTMLMediaElement);
}

/// DOM event interfaces, named as in TypeScript's lib.dom.
pub mod ev {
    /// An event interface.
    pub trait EventType {
        const TS: &'static str;
    }

    /// `Self` is a `P`: every `PointerEvent` is a `MouseEvent`, a `UIEvent` and an `Event`.
    #[diagnostic::on_unimplemented(
        message = "the handler takes a {P}, and this on: attribute's event is a {Self}",
        label = "a {Self}",
        note = "the event's type comes from the on: attribute's name (on:click is a PointerEvent); widen the JSDoc type to Event to take any"
    )]
    pub trait SubOf<P> {}

    macro_rules! events {
        ($name:ident: $($parent:ident),+) => {
            #[doc = concat!("`", stringify!($name), "`.")]
            pub enum $name {}
            impl EventType for $name {
                const TS: &'static str = stringify!($name);
            }
            $(impl SubOf<$parent> for $name {})+
        };
    }

    events!(Event: Event);
    events!(UIEvent: UIEvent, Event);
    events!(MouseEvent: MouseEvent, UIEvent, Event);
    events!(PointerEvent: PointerEvent, MouseEvent, UIEvent, Event);
    events!(WheelEvent: WheelEvent, MouseEvent, UIEvent, Event);
    events!(DragEvent: DragEvent, MouseEvent, UIEvent, Event);
    events!(KeyboardEvent: KeyboardEvent, UIEvent, Event);
    events!(InputEvent: InputEvent, UIEvent, Event);
    events!(FocusEvent: FocusEvent, UIEvent, Event);
    events!(CompositionEvent: CompositionEvent, UIEvent, Event);
    events!(TouchEvent: TouchEvent, UIEvent, Event);
    events!(SubmitEvent: SubmitEvent, Event);
    events!(FormDataEvent: FormDataEvent, Event);
    events!(SecurityPolicyViolationEvent: SecurityPolicyViolationEvent, Event);
    events!(ToggleEvent: ToggleEvent, Event);
    events!(AnimationEvent: AnimationEvent, Event);
    events!(TransitionEvent: TransitionEvent, Event);
    events!(ClipboardEvent: ClipboardEvent, Event);
    events!(ErrorEvent: ErrorEvent, Event);
    events!(CustomEvent: CustomEvent, Event);
    // The runtime's two events (corten.js declares their `detail`): `corten:error` on a
    // `data-patch` form whose submit got no answer it can draw, `corten:notice` on the document.
    events!(CortenError: CortenError, CustomEvent, Event);
    events!(CortenNotice: CortenNotice, CustomEvent, Event);
    // A `data-patch` form's upload progress (`corten:progress`): the browser's own interface.
    events!(ProgressEvent: ProgressEvent, Event);

    /// A typed event from `#[event]` is an `Event`.
    impl<E: super::DomEvent> SubOf<Event> for E {}
}

/// JSDoc types that are not elements or events.
pub mod ts {
    /// `string`: `&str`, `String`, a typed route (its URL).
    pub enum String {}
    /// `FeedUrl<Level>` (from `corten`): the URL of a feed of `Level` rows, a route whose
    /// `#[route(..)]` says `rows = Level`. `Level` is the type of that name in the component's
    /// module. `subscribe()` reads the row type from it.
    pub struct FeedUrl<Row>(std::marker::PhantomData<Row>);
    /// A type `corten::types` generated (`import("../types/app").SortBy`): the Rust type of that
    /// name in the component's module, so a call passes one of its values and nothing else.
    pub struct Generated<T>(std::marker::PhantomData<T>);
    /// `number`.
    pub enum Number {}
    /// `boolean`.
    pub enum Boolean {}
    /// `AbortSignal`: the `signal` keyword.
    pub enum AbortSignal {}
    /// Any other type: a JSON value (feature `json`).
    pub enum Any {}
    /// An array: of elements (`HTMLTableRowElement[]`, a ref put on elements in a loop), or of
    /// strings (`string[]`, a slice, an array or a `Vec` of them).
    pub struct Array<T>(std::marker::PhantomData<T>);
    /// Elements by their `key`: `Map<string, HTMLTableCellElement>`, a ref put with
    /// `key={item.id}` on every element ([`Keyed`](super::Keyed)), for rows a feed updates by
    /// id. Two elements with equal keys are one entry, the later in the page's order.
    ///
    /// A ref whose elements have no key does not fit one, and the error says to add `key=`:
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    ///
    /// // stock_grid.js: export function show(cells, id), cells a Map<string, HTMLTableCellElement>.
    /// // Its other handlers take a RowToggled from "corten/events", so the #[event] type is in scope.
    /// #[corten::script::event]
    /// pub struct RowToggled {
    ///     pub id: String,
    ///     pub selected: bool,
    /// }
    ///
    /// #[component(js)]
    /// fn StockGrid<'a>(ids: &'a [&'a str]) -> impl Render {
    ///     let qty = refs();
    ///     html! {
    ///         <table>
    ///             <tbody>for id in ids.iter() { <tr><td ref={qty}>{*id}</td></tr> }</tbody>
    ///             <tfoot on:connect={js::show(qty, "a")}></tfoot>
    ///         </table>
    ///     }
    /// }
    /// # fn main() {}
    /// ```
    ///
    /// Nor does a ref with a key on some elements and not on others:
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    ///
    /// #[corten::script::event]
    /// pub struct RowToggled {
    ///     pub id: String,
    ///     pub selected: bool,
    /// }
    ///
    /// #[component(js)]
    /// fn StockGrid<'a>(ids: &'a [&'a str]) -> impl Render {
    ///     let qty = refs();
    ///     html! {
    ///         <table>
    ///             <tbody>
    ///                 for id in ids.iter() { <tr><td ref={qty} key={*id}>{*id}</td></tr> }
    ///                 <tr><td ref={qty}>"Total"</td></tr>
    ///             </tbody>
    ///             <tfoot on:connect={js::show(qty, "a")}></tfoot>
    ///         </table>
    ///     }
    /// }
    /// # fn main() {}
    /// ```
    pub struct Map<T>(std::marker::PhantomData<T>);
    /// Elements with their values: `Map<HTMLTableRowElement, number>` (`K` is [`Number`],
    /// [`String`] or [`Boolean`]), a ref put with `ref={row.with(cents)}` on each element.
    pub struct Valued<T, K>(std::marker::PhantomData<(T, K)>);
    /// `Holds<Row, HTMLTableSectionElement>` (from `corten/views`): an element `T` whose children
    /// are rows of the view `Row` ([`super::view_id`] of its name), what `rows(body, Row)` takes.
    pub struct Holds<T, const VIEW: u64>(std::marker::PhantomData<T>);
    /// `Message<"count">` (from `corten`): a message of the app's catalog whose arguments are
    /// exactly these ([`super::message_id`] of the names), unfilled: `t.js().rows_selected()`.
    pub enum Message<const ARGS: u64> {}
    /// `NumberFormat` (from `corten`): the page's number format, `t.js().number()`.
    pub enum NumberFormat {}
    /// `MoneyFormat` (from `corten`): an amount's format in a currency, `t.js().money(USD)`.
    pub enum MoneyFormat {}
    /// `PercentFormat` (from `corten`): the page's percentage format, `t.js().percent(2)`, or its
    /// change format, `t.js().change(2)`.
    pub enum PercentFormat {}
    /// `DateFormat` (from `corten`): a date's format, `t.js().date(DateStyle::Medium)`.
    pub enum DateFormat {}
    /// `ElementId` (from `corten`): an element's id from its `#[derive(Id)]` type, an
    /// [`ElementId`](super::ElementId), never a string.
    pub enum ElementId {}
}

/// An element's id for a script parameter typed `ElementId` (or `ElementId[]`): a script that
/// finds an element elsewhere on the page by its id is given one the markup names by its
/// `#[derive(Id)]` type, so a renamed or misspelled id does not compile where a string would
/// find nothing.
///
/// ```
/// use corten::{prelude::*, script::ElementId};
///
/// #[derive(Id)]
/// struct SalesId;
///
/// assert_eq!(ElementId::of(&SalesId).as_str(), "sales");
///
/// fn takes<A: corten::script::Arg<corten::script::ts::ElementId>>(_: A) {}
/// takes(ElementId::of(&SalesId));
/// fn list<A: corten::script::Arg<corten::script::ts::Array<corten::script::ts::ElementId>>>(_: A) {}
/// list([ElementId::of(&SalesId)]);
/// ```
///
/// A string is not one, alone or in a list:
///
/// ```compile_fail,E0277
/// fn takes<A: corten::script::Arg<corten::script::ts::ElementId>>(_: A) {}
/// takes("sales");
/// ```
///
/// ```compile_fail,E0277
/// fn list<A: corten::script::Arg<corten::script::ts::Array<corten::script::ts::ElementId>>>(_: A) {}
/// list(["sales"]);
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ElementId(String);

impl From<ElementId> for String {
    fn from(id: ElementId) -> Self {
        id.0
    }
}

impl ElementId {
    /// The id `id` writes on its element.
    pub fn of(id: &impl crate::view::Id) -> Self {
        let mut out = String::new();
        id.write_id(&mut out);
        // `write_id` escapes for an attribute; the script gets the id itself.
        if out.contains('&') {
            out =
                out.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&");
        }
        Self(out)
    }

    /// The id.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What a `Message<"a" | "b">` parameter and a message with the arguments `a` and `b` are both
/// checked by: FNV-1a of the names, sorted and joined by commas. Used by the code
/// `messages!` and `#[component(js)]` generate.
#[doc(hidden)]
pub const fn message_id(names: &[&str]) -> u64 {
    // Sorted without allocating: each round takes the smallest name above the last one taken.
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut last: Option<&str> = None;
    let mut first = true;
    loop {
        let mut next: Option<&str> = None;
        let mut i = 0;
        while i < names.len() {
            let name = names[i];
            let above = match last {
                Some(last) => less(last, name),
                None => true,
            };
            let below = match next {
                Some(next) => less(name, next),
                None => true,
            };
            if above && below {
                next = Some(name);
            }
            i += 1;
        }
        let Some(name) = next else { return hash };
        if !first {
            hash = (hash ^ b',' as u64).wrapping_mul(0x0100_0000_01b3);
        }
        first = false;
        let bytes = name.as_bytes();
        let mut j = 0;
        while j < bytes.len() {
            hash = (hash ^ bytes[j] as u64).wrapping_mul(0x0100_0000_01b3);
            j += 1;
        }
        last = Some(name);
    }
}

/// `a < b`, byte by byte, in a const fn.
const fn less(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut i = 0;
    while i < a.len() && i < b.len() {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
        i += 1;
    }
    a.len() < b.len()
}

thread_local! {
    /// The component whose markup is rendering (one with refs), for refs and handlers.
    static SCOPE: Cell<Option<&'static str>> = const { Cell::new(None) };
    /// The script modules the page's handlers use, while a page renders.
    static MODULES: RefCell<Option<Vec<&'static str>>> = const { RefCell::new(None) };
}

/// Debug builds: the keys a component's keyed refs have had while it renders, so two elements of
/// one ref whose keys the browser reads as equal, or one whose `key={..}` wrote none (`None`),
/// stop the render, as an integer past 2^53 does. A handler's `Map<string, El>` would hold one
/// entry for the two, or one under `null`. Keys follow the runtime's query for a ref's elements:
/// those in a `<template>`'s content are not the page's and are not recorded. The page's other
/// renders (a patch, rows a script adds) are not seen.
#[cfg(debug_assertions)]
mod keys {
    use std::cell::{Cell, RefCell};
    use std::collections::HashSet;

    /// A ref of a component: its component's name and its own.
    type RefName = (&'static str, &'static str);
    /// A component's refs' keys so far, by ref, each as the browser reads it.
    type Keys = HashSet<(&'static str, String)>;
    /// The keyed ref and the key (as written, ` data-key="a"`) of an element whose tag is being
    /// written.
    type Tag = (Option<RefName>, Option<String>);

    thread_local! {
        /// Each component rendering (`scoped`), innermost last, with its refs' keys.
        static RENDERING: RefCell<Vec<(&'static str, Keys)>> = const { RefCell::new(Vec::new()) };
        /// The keyed elements whose tags are being written, innermost last: a render in a ref's
        /// or a key's expression writes its own above the element's.
        static TAGS: RefCell<Vec<Tag>> = const { RefCell::new(Vec::new()) };
        /// How many `<template>`s' content is being written.
        static TEMPLATE: Cell<usize> = const { Cell::new(0) };
    }

    pub(super) fn enter(scope: &'static str) {
        RENDERING.with(|r| r.borrow_mut().push((scope, HashSet::new())));
    }

    pub(super) fn leave() {
        RENDERING.with(|r| r.borrow_mut().pop());
    }

    /// A keyed element's tag begins: its ref and key are noted on it until it ends.
    pub(super) fn open() {
        TAGS.with(|t| t.borrow_mut().push((None, None)));
    }

    /// Its tag ends: checks its key, or, when a render unwinds (`checked` is false), drops it.
    pub(super) fn close(checked: bool) {
        let tag = TAGS.with(|t| t.borrow_mut().pop());
        if !checked || TEMPLATE.with(Cell::get) > 0 {
            return;
        }
        if let Some((Some(at), Some(written))) = tag {
            check(at, &written);
        }
    }

    pub(super) fn ref_written(at: RefName) {
        TAGS.with(|t| {
            if let Some(tag) = t.borrow_mut().last_mut() {
                tag.0 = Some(at);
            }
        });
    }

    pub(super) fn key_written(written: &str) {
        TAGS.with(|t| {
            if let Some(tag) = t.borrow_mut().last_mut() {
                tag.1 = Some(written.to_owned());
            }
        });
    }

    /// A `<template>`'s content is being written, or is no longer.
    pub(super) fn template(inside: bool) {
        TEMPLATE.with(|t| t.set(if inside { t.get() + 1 } else { t.get().saturating_sub(1) }));
    }

    fn check((scope, name): RefName, written: &str) {
        let Some(key) = read(written) else {
            panic!(
                "an element of ref {name} in {scope} has a key={{..}} that wrote no key (None or false), so a handler's \
                 Map<string, ..> would get it under null: give every element of the ref a key"
            )
        };
        // The innermost render of the ref's component holds it, as the page's `data-scope` root
        // nearest the element does.
        let repeated = RENDERING.with(|r| {
            r.borrow_mut()
                .iter_mut()
                .rev()
                .find(|(at, _)| *at == scope)
                .is_some_and(|(_, seen)| !seen.insert((name, key.clone())))
        });
        if repeated {
            panic!(
                "two elements of ref {name} in one {scope} have the key {key:?} as the browser reads it, so a handler's \
                 Map<string, ..> would hold only the later: give each element of the ref a key of its own"
            );
        }
    }

    /// What `getAttribute` returns for a key as written: nothing for no attribute, `""` for one
    /// without a value (`key={true}`), and a value with its line breaks as the parser reads them
    /// (CR LF and CR are LF, NUL is U+FFFD) and its character references decoded.
    fn read(written: &str) -> Option<String> {
        if written.is_empty() {
            return None;
        }
        let Some((_, value)) = written.split_once('=') else { return Some(String::new()) };
        let value = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(value);
        let value = value.replace("\r\n", "\n").replace(['\r'], "\n").replace('\0', "\u{FFFD}");
        let mut read = String::with_capacity(value.len());
        let mut rest = value.as_str();
        while let Some(at) = rest.find('&') {
            read.push_str(&rest[..at]);
            rest = &rest[at..];
            let end = rest.find(';');
            let named = end.and_then(|end| match &rest[1..end] {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                number => match number.strip_prefix('#') {
                    Some(hex) if hex.starts_with(['x', 'X']) => u32::from_str_radix(&hex[1..], 16).ok(),
                    Some(decimal) => decimal.parse().ok(),
                    None => None,
                }
                .and_then(char::from_u32),
            });
            match (named, end) {
                (Some(c), Some(end)) => {
                    read.push(c);
                    rest = &rest[end + 1..];
                }
                _ => {
                    read.push('&');
                    rest = &rest[1..];
                }
            }
        }
        read.push_str(rest);
        Some(read)
    }
}
/// The module of numbers, money and dates for a script (`js/format.js`, minified into
/// `js/dist/format.js`): served with the app's scripts, and loaded by the pages whose handlers
/// take a format (`t.js().money(USD)`), not by every page with the runtime. Not a name a
/// component's script can have (they are snake_case).
pub(crate) const FORMAT_MODULE: &str = "corten-format";

/// [`FORMAT_MODULE`]'s source.
pub(crate) const FORMAT_JS: &str = include_str!("../js/dist/format.js");

/// The module of `shortcut` for a script (`js/keys.js`, minified into `js/dist/keys.js`), which
/// scripts import as `corten/keys`: served with the app's scripts when one imports it (the import
/// map names it then), and preloaded with each script that does. Its name is the one
/// `corten-macros` writes into such a script's imports.
pub(crate) const KEYS_MODULE: &str = "corten-keys";

/// [`KEYS_MODULE`]'s source.
pub(crate) const KEYS_JS: &str = include_str!("../js/dist/keys.js");

/// The module that sends a `data-patch` form's multipart body by `XMLHttpRequest` to report its
/// progress (`js/upload.js`, minified into `js/dist/upload.js`): served with the app's scripts,
/// and loaded by the pages with a form that has an `on:corten:progress` handler, not by every
/// page with the runtime.
pub(crate) const UPLOAD_MODULE: &str = "corten-upload";

/// [`UPLOAD_MODULE`]'s source.
pub(crate) const UPLOAD_JS: &str = include_str!("../js/dist/upload.js");

/// Notes that the page rendering uses script module `name`, so its head loads it.
pub(crate) fn uses(name: &'static str) {
    MODULES.with(|m| {
        if let Some(list) = m.borrow_mut().as_mut() {
            if !list.contains(&name) {
                list.push(name);
            }
        }
    });
}

/// Runs `render` and returns the script modules its handlers use, in first-use order.
pub(crate) fn collect<T>(render: impl FnOnce() -> T) -> (T, Vec<&'static str>) {
    let (value, list) = crate::gather(&MODULES, Vec::new(), render);
    (value, list.unwrap_or_default())
}

/// Used by the code `#[component]`, `html!`, `script!` and `#[event]` generate. Not a public API.
#[doc(hidden)]
pub mod __private {
    use super::*;

    /// A form on the page has an `on:corten:progress` handler, so the page loads the upload module.
    #[inline]
    pub fn uses_upload() {
        uses(UPLOAD_MODULE);
    }

    /// Where an argument is written: the component rendering and the one that made the handler.
    pub struct Ctx {
        pub current: Option<&'static str>,
        pub home: Option<&'static str>,
    }

    /// An argument, written with the parameter type it was checked against.
    pub trait WriteArg {
        fn write_arg(&self, ctx: &Ctx, out: &mut String);
    }

    /// An argument and its parameter's type.
    pub struct Typed<A, P>(A, PhantomData<fn() -> P>);

    impl<A: Arg<P>, P> Typed<A, P> {
        #[inline]
        pub fn new(arg: A) -> Self {
            Typed(arg, PhantomData)
        }
    }

    impl<A: Arg<P>, P> WriteArg for Typed<A, P> {
        #[inline]
        fn write_arg(&self, ctx: &Ctx, out: &mut String) {
            self.0.write_arg(ctx, out)
        }
    }

    /// Only `#[component]` makes refs.
    #[diagnostic::on_unimplemented(
        message = "refs() names a component's elements: write `let (rows, rest) = refs();` at the top of a #[component]'s body",
        label = "outside a component's top level"
    )]
    pub trait Refs {}

    /// The arguments of a call: a tuple of up to twelve, and for more, `Both` of two halves, each a
    /// tuple or `Both` again. A tuple's impls stop at a fixed length, so a longer call nests; its
    /// depth (which the compiler's recursion limit bounds) grows with the logarithm of the count,
    /// and a call of twelve or fewer is the tuple it always was. A half is never empty.
    pub trait Args {
        /// The arguments, comma-separated.
        fn write_args(&self, ctx: &Ctx, out: &mut String);

        /// The arguments after others: a comma, then them.
        #[inline]
        fn write_rest(&self, ctx: &Ctx, out: &mut String) {
            out.push(',');
            self.write_args(ctx, out);
        }
    }

    /// The two halves of a call's arguments past twelve.
    pub struct Both<L, R>(pub L, pub R);

    impl<L: Args, R: Args> Args for Both<L, R> {
        #[inline]
        fn write_args(&self, ctx: &Ctx, out: &mut String) {
            self.0.write_args(ctx, out);
            self.1.write_rest(ctx, out);
        }
    }

    macro_rules! args {
        ($(($($name:ident),*)),*) => {$(
            impl<$($name: WriteArg),*> Args for ($($name,)*) {
                #[allow(non_snake_case, unused_variables, unused_assignments, unused_mut)]
                fn write_args(&self, ctx: &Ctx, out: &mut String) {
                    let ($($name,)*) = self;
                    let mut first = true;
                    $(
                        if !first { out.push(','); }
                        first = false;
                        $name.write_arg(ctx, out);
                    )*
                }
            }
        )*};
    }
    // The longest tuple here is corten-macros' `TUPLE` (in its `script.rs`): a call past it is
    // held in `Both`. The two change together.
    args!(
        (),
        (A),
        (A, B),
        (A, B, C),
        (A, B, C, D),
        (A, B, C, D, E),
        (A, B, C, D, E, F),
        (A, B, C, D, E, F, G),
        (A, B, C, D, E, F, G, H),
        (A, B, C, D, E, F, G, H, I),
        (A, B, C, D, E, F, G, H, I, J),
        (A, B, C, D, E, F, G, H, I, J, K),
        (A, B, C, D, E, F, G, H, I, J, K, L)
    );

    /// One field of a group (a JSDoc `@typedef` the markup builds as a Rust struct):
    /// `name:` and the argument, after a comma unless it is the first.
    #[inline]
    pub fn group_field<A: Arg<P>, P>(first: bool, name: &str, arg: &A, ctx: &Ctx, out: &mut String) {
        if !first {
            out.push(',');
        }
        out.push_str(name);
        out.push(':');
        arg.write_arg(ctx, out);
    }

    /// A call of one handler: `module.name(args)`.
    pub struct Call<A> {
        module: &'static str,
        name: &'static str,
        home: Option<&'static str>,
        /// Its script imports `keep`, so the runtime needs its home.
        keeps: bool,
        /// A shared module's own component, marked rendered for the dev check (debug builds).
        #[cfg_attr(not(debug_assertions), allow(dead_code))]
        owner: Option<&'static Component>,
        args: A,
    }

    impl<A> Call<A> {
        #[inline]
        pub fn new(
            module: &'static str,
            name: &'static str,
            home: Option<&'static str>,
            keeps: bool,
            owner: Option<&'static Component>,
            args: A,
        ) -> Self {
            Call { module, name, home, keeps, owner, args }
        }
    }

    /// The scoped component rendering: a `script!` module's or an unscoped component's handlers
    /// belong to it.
    #[inline]
    pub fn current_scope() -> Option<&'static str> {
        SCOPE.with(Cell::get)
    }

    impl<A: Args> Bind for Call<A> {
        fn write_bind(&self, out: &mut String) {
            uses(self.module);
            #[cfg(debug_assertions)]
            if let Some(owner) = self.owner {
                crate::style::__private::rendered(owner);
            }
            out.push_str(self.module);
            out.push('.');
            out.push_str(self.name);
            out.push('(');
            let current = SCOPE.with(Cell::get);
            self.args.write_args(&Ctx { current, home: self.home }, out);
            out.push(')');
            // A parent's handler on a child's element: `/form` names the component it belongs to,
            // whose state `keep` gives it (the element's nearest root is the child's). Only a
            // script that keeps state needs it.
            if let (true, Some(home)) = (self.keeps, self.home) {
                if current != Some(home) {
                    out.push('/');
                    out.push_str(home);
                }
            }
        }
    }

    /// Marks the component whose markup renders while `f` runs.
    #[inline]
    pub fn scoped<T>(scope: &'static str, f: impl FnOnce() -> T) -> T {
        struct Restore(Option<&'static str>);
        impl Drop for Restore {
            fn drop(&mut self) {
                SCOPE.with(|s| s.set(self.0));
                #[cfg(debug_assertions)]
                keys::leave();
            }
        }
        #[cfg(debug_assertions)]
        keys::enter(scope);
        let _restore = Restore(SCOPE.with(|s| s.replace(Some(scope))));
        f()
    }

    /// `let (rows, rest) = refs();`: each name, made by `#[component]`.
    #[inline]
    pub const fn new_ref<T, V, W, K>(scope: &'static str, name: &'static str) -> Ref<T, V, W, K> {
        Ref { scope, name, kind: PhantomData, value: PhantomData }
    }

    /// A ref of another component's markup is written with its component: `offer-list/rows`.
    fn qualified(out: &mut String, owner: &'static str, current: Option<&'static str>) {
        if current != Some(owner) {
            out.push_str(owner);
            out.push('/');
        }
    }

    /// What `ref={..}` takes on an element with a key (`K` is [`Keyed`]) or without one
    /// ([`NoKey`]): a ref, which gives its element no value, or a ref with one (`row.with(cents)`).
    #[diagnostic::on_unimplemented(
        message = "every element of a ref gives its script a value of one kind or none, and has a key={{..}} or none, and a ref={{..}} here does not: {Self}",
        label = "a ref={{..}} in this markup gives what the ref's other elements or its handlers do not take, or has a key={{..}} they do not",
        note = "a handler parameter typed Map<El, number> takes a ref whose every element gives a number, ref={{row.with(cents)}}; \
                ref={{row}} gives none; Map<string, El> takes a ref whose every element has a key={{..}}, and a component's prop \
                for such a ref names it Ref<El, NoRows, NoValue, Keyed>"
    )]
    pub trait RefAttr<E, V, K> {
        fn write_ref(&self, out: &mut String);
    }
    /// ` data-ref="rows"`.
    #[inline]
    fn data_ref<T, V, W, K: KeyKind>(r: &Ref<T, V, W, K>, out: &mut String) {
        out.push_str(" data-ref=\"");
        qualified(out, r.scope, SCOPE.with(Cell::get));
        out.push_str(r.name);
        out.push('"');
        K::written(r.scope, r.name);
    }
    impl<E, V, K: KeyKind> RefAttr<E, V, K> for Ref<E, V, NoValue, K> {
        #[inline]
        fn write_ref(&self, out: &mut String) {
            data_ref(self, out)
        }
    }
    /// ` data-ref-value='1250'`: the value as JSON, single-quoted as `data-on` is, so a string
    /// keeps its quotes (`docs/design.md#choice-ref-values`).
    impl<E, V, K: KeyKind, X: RefValue> RefAttr<E, V, K> for Valued<E, V, X, K> {
        #[inline]
        fn write_ref(&self, out: &mut String) {
            data_ref(&self.at, out);
            out.push_str(" data-ref-value='");
            self.value.write_value(out);
            out.push('\'');
        }
    }

    /// ` data-ref="rows"` on an element of interface `E` that holds `V`, with a key or without
    /// (`K`), which makes `rows` a `Ref<E, V, NoValue, K>` (with ` data-ref-value='..'` for
    /// `rows.with(..)`, whose value fixes its third type).
    #[inline]
    pub fn ref_attr<E, V, K>(r: &impl RefAttr<E, V, K>, out: &mut String) {
        r.write_ref(out)
    }

    /// `ref={trigger as HTMLElement}` on an element of interface `E`: `trigger` is a `Ref<W>`,
    /// and every `E` it is on must be a `W`.
    #[inline]
    pub fn ref_attr_as<E: el::SubOf<W>, W, V, K>(r: &impl RefAttr<W, V, K>, out: &mut String) {
        ref_attr(r, out)
    }

    /// Whether the elements of a ref have keys ([`Keyed`]) or not ([`NoKey`]): debug builds note
    /// a keyed one's element, to check its key ([`key_written`]).
    pub trait KeyKind {
        #[inline]
        fn written(_scope: &'static str, _name: &'static str) {}
    }
    impl KeyKind for NoKey {}
    impl KeyKind for Keyed {
        #[inline]
        fn written(_scope: &'static str, _name: &'static str) {
            #[cfg(debug_assertions)]
            keys::ref_written((_scope, _name));
        }
    }

    /// ` data-key=".."` as written on an element with a keyed ref: debug builds stop when two of
    /// the ref's elements in one render of its component have keys the browser reads as equal,
    /// or one has none. The code `html!` writes calls it in debug builds only, between a
    /// [`KeyTag`]'s `open` and `close`.
    #[inline]
    pub fn key_written(_written: &str) {
        #[cfg(debug_assertions)]
        keys::key_written(_written);
    }

    /// The start tag of an element with a keyed ref, held while its attributes are written, so
    /// its ref and key are checked together even when an attribute's expression renders another
    /// view. The code `html!` writes holds it in debug builds only; one dropped without `close`
    /// (a render that unwinds) is let go unchecked.
    pub struct KeyTag(());

    impl KeyTag {
        #[inline]
        pub fn open() -> Self {
            #[cfg(debug_assertions)]
            keys::open();
            KeyTag(())
        }

        /// Its attributes are written: checks its key.
        #[inline]
        pub fn close(self) {
            std::mem::forget(self);
            #[cfg(debug_assertions)]
            keys::close(true);
        }
    }

    impl Drop for KeyTag {
        fn drop(&mut self) {
            #[cfg(debug_assertions)]
            keys::close(false);
        }
    }

    /// A `<template>`'s content, held while it is written: the runtime's query for a ref's
    /// elements does not reach it, so debug builds record none of its keys. The code `html!`
    /// writes holds it in debug builds only, and dropping it ends the content, a render that
    /// unwinds included.
    pub struct TemplateContent(());

    impl TemplateContent {
        #[inline]
        pub fn open() -> Self {
            #[cfg(debug_assertions)]
            keys::template(true);
            TemplateContent(())
        }
    }

    impl Drop for TemplateContent {
        fn drop(&mut self) {
            #[cfg(debug_assertions)]
            keys::template(false);
        }
    }
    /// ` data-on='click:m.f(..) input:m.g(..)'`, or nothing when no handler is there. Single-quoted,
    /// so the JSON in its arguments keeps its quotes as they are (`docs/design.md#choice-data-on-single-quoted`).
    pub fn data_on(out: &mut String, binds: &[(&str, &dyn Bind)]) {
        let mut first = true;
        for (event, bind) in binds {
            if !bind.present() {
                continue;
            }
            out.push_str(if first { " data-on='" } else { " " });
            first = false;
            out.push_str(event);
            out.push(':');
            bind.write_bind(out);
        }
        if !first {
            out.push('\'');
        }
    }

    /// `event` in an `on:` handler: the event, of type `E`.
    pub struct EventKw<E>(PhantomData<fn() -> E>);
    impl<E> EventKw<E> {
        pub const NEW: Self = EventKw(PhantomData);
    }
    impl<E> Clone for EventKw<E> {
        fn clone(&self) -> Self {
            *self
        }
    }
    impl<E> Copy for EventKw<E> {}
    /// `target`: the element with the `on:`, of interface `T`.
    pub struct TargetKw<T>(PhantomData<fn() -> T>);
    impl<T> TargetKw<T> {
        pub const NEW: Self = TargetKw(PhantomData);
    }
    impl<T> Clone for TargetKw<T> {
        fn clone(&self) -> Self {
            *self
        }
    }
    impl<T> Copy for TargetKw<T> {}
    /// `signal`: aborts when the element with the `on:` leaves the page.
    #[derive(Clone, Copy)]
    pub struct SignalKw;
    /// `scope`: the root element of the component that made the handler.
    #[derive(Clone, Copy)]
    pub struct ScopeKw;

    /// What a parameter type gets for a ref of an `T` that holds `V`, whose elements give values
    /// of kind `W` and have keys or not (`K`): the first element (`@`), every one (`*`), every one
    /// by its key (`#`), or every one with its value (`=`).
    #[diagnostic::on_unimplemented(
        message = "the handler's JSDoc type {Self} does not fit this ref, an {T} that holds {V} and gives {W}",
        label = "a ref of an {T} that holds {V} and gives {W}",
        note = "Holds<Row, ..> takes a ref whose element the markup fills with Row views only (a for loop of <Row .. />, \
                or one <Row .. /> in a <template>); RowsOf and Holds name the view by view_id(\"Row\"); \
                Map<El, number> takes a ref whose every element gives a number, ref={{row.with(cents)}}"
    )]
    pub trait RefParam<T, V, W, K> {
        const SIGIL: &'static str;
    }
    // An element type takes the first element: `impl RefParam<T, V, W, K> for HTMLButtonElement` and the
    // others, from `el`'s list (one impl each, so a mismatched Holds gets this trait's message).
    impl<T: el::SubOf<P>, P: el::Elem, V, W, K> RefParam<T, V, W, K> for ts::Array<P> {
        const SIGIL: &'static str = "*";
    }
    impl<T: el::SubOf<P>, P: el::Elem, V, W, K: HasKeys> RefParam<T, V, W, K> for ts::Map<P> {
        const SIGIL: &'static str = "#";
    }
    impl<T: el::SubOf<P>, P: el::Elem, V, W, K> RefParam<T, V, W, K> for ts::Valued<P, W> {
        const SIGIL: &'static str = "=";
    }
    impl<T: el::SubOf<P>, P: el::Elem, const VIEW: u64, W, K> RefParam<T, RowsOf<VIEW>, W, K> for ts::Holds<P, VIEW> {
        const SIGIL: &'static str = "@";
    }

    /// A ref whose elements a `Map<string, El>` parameter gets by key: one put with a key on every
    /// element ([`Keyed`]). A bound of its own, so a ref without keys is told what to add.
    #[diagnostic::on_unimplemented(
        message = "the handler takes this ref's elements by key (Map<string, El>), and its elements have no key={{..}}",
        label = "a ref whose elements have no key",
        note = "add key={{..}} beside the ref on each of its elements, <td ref={{cells}} key={{item.id}}>; a component's prop for \
                a parent's keyed ref names it Ref<El, NoRows, NoValue, Keyed>"
    )]
    pub trait HasKeys {}
    impl HasKeys for Keyed {}

    /// A parameter type one element of interface `T` fits.
    pub trait OneParam<T> {}
    impl<T: el::SubOf<P>, P: el::Elem> OneParam<T> for P {}
    impl<T> OneParam<T> for ts::Any {}
    impl<T, V, W, K> RefParam<T, V, W, K> for ts::Any {
        const SIGIL: &'static str = "@";
    }

    /// A parameter type an event of type `E` fits.
    pub trait EventParam<E> {}
    impl<E: ev::SubOf<P>, P: ev::EventType> EventParam<E> for P {}
    impl<E> EventParam<E> for ts::Any {}

    impl<T, V, W, K, P: RefParam<T, V, W, K>> Arg<P> for Ref<T, V, W, K> {
        fn write_arg(&self, ctx: &Ctx, out: &mut String) {
            out.push_str(P::SIGIL);
            qualified(out, self.scope, ctx.current);
            out.push_str(self.name);
        }
    }
    impl<T, P: OneParam<T>> Arg<P> for Closest<T> {
        fn write_arg(&self, ctx: &Ctx, out: &mut String) {
            out.push('^');
            qualified(out, self.0.scope, ctx.current);
            out.push_str(self.0.name);
        }
    }
    impl<T, P: OneParam<T>> Arg<P> for TargetKw<T> {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            out.push_str("$t");
        }
    }
    impl<P: OneParam<el::HTMLElement>> Arg<P> for ScopeKw {
        fn write_arg(&self, ctx: &Ctx, out: &mut String) {
            out.push_str("$c");
            if let Some(home) = ctx.home {
                if ctx.current != Some(home) {
                    out.push('/');
                    out.push_str(home);
                }
            }
        }
    }
    impl<E, P: EventParam<E>> Arg<P> for EventKw<E> {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            out.push_str("$e");
        }
    }
    impl Arg<ts::AbortSignal> for SignalKw {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            out.push_str("$s");
        }
    }
    impl Arg<ts::Any> for SignalKw {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            out.push_str("$s");
        }
    }

    /// `on:RowToggled={..}` names a type made with `#[event]`.
    pub fn is_event<E: DomEvent>() {}

    /// A view's number property: what `#[component(view)]` checks in debug builds, since the
    /// page holds it as a JavaScript number.
    pub trait ViewNumber {
        fn check(&self, name: &str);
    }
    macro_rules! view_numbers {
        ($($t:ty),*) => {$(
            impl ViewNumber for $t {
                #[inline]
                fn check(&self, name: &str) {
                    debug_assert!(
                        (*self as i128).unsigned_abs() <= MAX_SAFE_INTEGER,
                        "view property {name} = {self} is beyond what a JavaScript number holds exactly (2^53 - 1); make it a string"
                    );
                }
            }
        )*};
    }
    view_numbers!(u8, u16, u32, u64, usize, i8, i16, i32, i64, isize);
    impl ViewNumber for f32 {
        #[inline]
        fn check(&self, _: &str) {}
    }
    impl ViewNumber for f64 {
        #[inline]
        fn check(&self, _: &str) {}
    }
    impl<T: ViewNumber + ?Sized> ViewNumber for &T {
        #[inline]
        fn check(&self, name: &str) {
            (**self).check(name)
        }
    }

    /// JavaScript's `Number.MAX_SAFE_INTEGER`.
    const MAX_SAFE_INTEGER: u128 = (1 << 53) - 1;

    /// Writes `text` as a JSON string, escaped for `data-on`'s single-quoted attribute.
    pub fn json_str(text: &str, out: &mut String) {
        out.push('"');
        for c in text.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '\'' => out.push_str("&#39;"),
                c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => {
                    use std::fmt::Write;
                    let _ = write!(out, "\\u{:04x}", c as u32);
                }
                c => out.push(c),
            }
        }
        out.push('"');
    }

    /// Writes JSON text into `data-on`'s single-quoted attribute: its quotes as they are, and `&`,
    /// `'`, `<` and `>` as entities. `<` and `>` need none in an attribute, but the server's own
    /// readers of its markup (a page's parts, a patch's checks) find tags by them.
    #[cfg(feature = "json")]
    pub fn json_attr(json: &str, out: &mut String) {
        let mut start = 0;
        for (i, byte) in json.bytes().enumerate() {
            let entity = match byte {
                b'&' => "&amp;",
                b'\'' => "&#39;",
                b'<' => "&lt;",
                b'>' => "&gt;",
                _ => continue,
            };
            out.push_str(&json[start..i]);
            out.push_str(entity);
            start = i + 1;
        }
        out.push_str(&json[start..]);
    }

    /// A value as written and behind one or two references (`&&str` from `rows.iter()`).
    macro_rules! values {
        ($p:ty, |$v:ident, $out:ident| $write:expr; $($t:ty),*) => {$(
            impl Arg<$p> for $t {
                #[inline]
                fn write_arg(&self, _: &Ctx, $out: &mut String) {
                    let $v: &$t = self;
                    $write
                }
            }
            impl Arg<$p> for &$t {
                #[inline]
                fn write_arg(&self, ctx: &Ctx, out: &mut String) {
                    Arg::<$p>::write_arg(*self, ctx, out)
                }
            }
            impl Arg<$p> for &&$t {
                #[inline]
                fn write_arg(&self, ctx: &Ctx, out: &mut String) {
                    Arg::<$p>::write_arg(**self, ctx, out)
                }
            }
        )*};
    }
    values!(ts::String, |v, out| json_str(v, out); &str, String, std::borrow::Cow<'_, str>);
    // An integer is written as markup writes one (`Render`), the same digits as `Display` without
    // the formatter: a ref value is one per row.
    values!(ts::Number, |v, out| crate::view::Render::render(v, out); u8, u16, u32, i8, i16, i32);
    // A JavaScript number holds integers exactly up to 2^53; past that the browser would get a
    // different number, silently. Debug builds and tests stop there: pass such a value (a 64-bit
    // id) as a string.
    values!(ts::Number, |v, out| {
        debug_assert!(
            (*v as i128).unsigned_abs() <= MAX_SAFE_INTEGER,
            "handler argument {v} is beyond what a JavaScript number holds exactly (2^53 - 1); pass it as a string"
        );
        crate::view::Render::render(v, out);
    }; u64, usize, i64, isize);
    // JSON has no NaN or infinity.
    values!(ts::Number, |v, out| if v.is_finite() { use std::fmt::Write; let _ = write!(out, "{v}"); } else { out.push_str("null") }; f32, f64);
    values!(ts::Boolean, |v, out| out.push_str(if *v { "true" } else { "false" }); bool);

    /// `[..]` of each string, for a `string[]` parameter.
    fn json_strs<S: AsRef<str>>(items: &[S], out: &mut String) {
        out.push('[');
        for (i, item) in items.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            json_str(item.as_ref(), out);
        }
        out.push(']');
    }

    /// A list of strings, `string[]`: `values={&["above", "below"]}`, a `Vec<String>`.
    impl<S: AsRef<str>> Arg<ts::Array<ts::String>> for &[S] {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_strs(self, out)
        }
    }
    impl<S: AsRef<str>> Arg<ts::Array<ts::String>> for &&[S] {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_strs(self, out)
        }
    }
    impl<S: AsRef<str>, const N: usize> Arg<ts::Array<ts::String>> for [S; N] {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_strs(self, out)
        }
    }
    impl<S: AsRef<str>, const N: usize> Arg<ts::Array<ts::String>> for &[S; N] {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_strs(*self, out)
        }
    }
    impl<S: AsRef<str>> Arg<ts::Array<ts::String>> for Vec<S> {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_strs(self, out)
        }
    }
    impl<S: AsRef<str>> Arg<ts::Array<ts::String>> for &Vec<S> {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_strs(self, out)
        }
    }

    values!(ts::ElementId, |v, out| json_str(&v.0, out); super::ElementId);

    /// Element ids, `ElementId[]`: `[ElementId::of(&SalesId)]`, a `Vec` of them.
    impl<const N: usize> Arg<ts::Array<ts::ElementId>> for [super::ElementId; N] {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_strs(&self.iter().map(|id| id.as_str()).collect::<Vec<_>>(), out)
        }
    }
    impl<const N: usize> Arg<ts::Array<ts::ElementId>> for &[super::ElementId; N] {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_strs(&self.iter().map(|id| id.as_str()).collect::<Vec<_>>(), out)
        }
    }
    impl Arg<ts::Array<ts::ElementId>> for &[super::ElementId] {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_strs(&self.iter().map(|id| id.as_str()).collect::<Vec<_>>(), out)
        }
    }
    impl Arg<ts::Array<ts::ElementId>> for Vec<super::ElementId> {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_strs(&self.iter().map(|id| id.as_str()).collect::<Vec<_>>(), out)
        }
    }
    impl Arg<ts::Array<ts::ElementId>> for &Vec<super::ElementId> {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_strs(&self.iter().map(|id| id.as_str()).collect::<Vec<_>>(), out)
        }
    }

    /// A message for the script to fill in: its text and argument names, made when the crate compiled.
    impl<const ARGS: u64> Arg<ts::Message<ARGS>> for crate::i18n::Template<ARGS> {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            self.write_wire(out);
        }
    }

    impl<R: crate::Route> Arg<ts::String> for R {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            let mut url = String::new();
            self.write_href(&mut url, false);
            json_str(&url, out)
        }
    }

    /// A feed's route, for a parameter that names its rows: written as its URL, as a `string` is.
    impl<R: crate::Route + crate::route::__private::FeedRows<T>, T> Arg<ts::FeedUrl<T>> for R {
        fn write_arg(&self, ctx: &Ctx, out: &mut String) {
            <R as Arg<ts::String>>::write_arg(self, ctx, out)
        }
    }

    /// A value of the Rust type a generated declaration was made from, as JSON.
    #[cfg(feature = "json")]
    impl<T: crate::json::ToJson> Arg<ts::Generated<T>> for T {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_attr(&self.to_json(), out);
        }
    }
    #[cfg(feature = "json")]
    impl<T: crate::json::ToJson> Arg<ts::Generated<T>> for &T {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_attr(&self.to_json(), out);
        }
    }

    /// Any `ToJson` value, as JSON, for a parameter typed `unknown`, which the script narrows.
    #[cfg(feature = "json")]
    impl<T: crate::json::ToJson> Arg<ts::Any> for T {
        fn write_arg(&self, _: &Ctx, out: &mut String) {
            json_attr(&self.to_json(), out);
        }
    }

    /// How `corten::types` describes a type.
    #[cfg(feature = "types")]
    pub type TsType = fn(&mut crate::json::schema::Generator) -> serde_json::Value;
    #[cfg(not(feature = "types"))]
    pub type TsType = ();

    #[cfg(feature = "types")]
    pub const fn ts<T: crate::json::schema::ToJsonSchema + ?Sized>() -> TsType {
        T::json_schema
    }

    #[cfg(not(feature = "types"))]
    pub const fn ts<T: ?Sized>() -> TsType {}
}

#[cfg(test)]
mod tests;
