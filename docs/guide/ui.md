# Headless components

[Back to the guides](../../README.md#documentation)

`corten-ui` is an optional crate of components for the widgets the browser has no element for. Each
renders accessible markup on the server, works as plain HTML before its script loads, and ships
no CSS. A widget's `id` is a `#[derive(Id)]` type (a keyed one, `ShipmentMenuId(&s.reference)`,
for one per row, or a form's `e.id(f.qty)`), as an element a patch or another control names
takes one, and its parts' ids are made from it (`{id}-button`, `{id}-tab-0`), so a label's
`for` or another control naming it writes the same id; text does not compile.

| Component | Without JavaScript | The script adds |
|---|---|---|
| `NumberField` | a native `<input type="number">` (arrow keys, `min`, `max`, `step`, `required`), for a count or a measure (a quantity, seats, a weight), on an `Entry` field (`qty: Entry<u32>`), within the `Bounds` of its number type that its handler reads it with (`Number::new` takes no other field's name, a typed `qty: u32` included, and no other type's bounds), and drawn again after a refusal with the number as sent (text that is no number, which a number input cannot hold, as empty); a price is a text input instead (below). Its step buttons are drawn, so the field does not move as the script loads: the design system hides them under `@media (scripting: none)`, as the kit's `Stepper` does | step buttons with press and hold, Page Up and Down, Home and End, the step's decimals |
| `ComboBox` | a native `<select>`, which keeps the value; its options are `Choice`s of the type the form field reads, each written as its `Display` as a route writes a field, with a route's contract that `Display` writes what the field's `Deserialize` reads (true of numbers, text, `Uuid` and `UrlValue` enums; `Choice::new(Condition::NearMint, "Near Mint")` for `condition: Condition`, `Choice::new(line.id, &line.name)` for `line: i32`), so the values it offers are the ones the handler reads, and `Picker::new` takes only the name of a field that reads them (a picker of conditions on `f.size` does not compile) | a text input that filters a listbox (ARIA 1.2 combobox) by each choice's label and `terms` (`Choice::new(..).terms(&["NM"])`, words that find it without being shown, `&str`s or the `String`s a row computed), the best matches first; validation reported on the input |
| `TabGroup` | tabs that are typed links to the page with that tab selected | roving focus, arrow keys, switching in place with the address following in the keys the tabs differ in (another control's stay) |
| `ChoiceGroup` and `ShownFor` | one choice, a `Chosen { id, value }` (its `#[derive(Id)]` id and the value the handler read), drawn by a radio group whose options are typed links to the page with that choice (`?window=90`), where the server checks it and draws every `ShownFor` part for another value `hidden`, wherever on the page the part is | roving focus (the first option when none is chosen), arrow keys and Space, choosing in place with the address following in the keys the options differ in (another control's keys stay), and every part of the choice (also one a patch adds later) shown or hidden for it; group and parts take the same `Chosen`, so a part's values are the choice's type and a word of another enum does not compile. A part is a `<div>` around its children: a kit `Table` in it scrolls wherever the part is, but other wide content (an app's own table, a `<pre>`) needs the room to shrink: in a grid of the app's own, give the grid `minmax(0, 1fr)` tracks (as the kit's card content has), or it widens the grid rather than scrolling; in a flex row of the app's own that does not wrap, give the row's children `min-width: 0` (`.row > * { min-width: 0; }` in the row's stylesheet) |
| `MenuButton` | a popover menu (`popovertarget`) of the app's own items, its children with `role="menuitem"`: a link (with `download` or `target`), a post form with its fields, a dialog command | arrow keys, Home and End, typeahead, focus in and back, `aria-expanded`, the button as the menu's CSS anchor |
| `Toaster` | the message is part of the page the post answers with | a live region an action's patch fills (`req.patch_or(Toast { message: Some(text) }, page)`) or a redirect's notice fills (`Toast { message: req.notice() }` in the layout, and `corten:notice` after a navigation), hidden after `seconds` but kept while the pointer or focus is on it or the page is hidden, and a close button; its `failed` text when a `data-patch` submit gets no answer (`corten:error`) that no handler took with `preventDefault()`, kept past `seconds` until closed, the next submit or another page (an empty `failed` says nothing) |
| `CopyButton` | no button: the text (an order number, an API secret) is on the page to select | a button, where the browser has the Clipboard API (a secure origin), that copies the text (or a field's value) of the element its `#[derive(Id)]` id names (`<code id={SecretId}>`, `<CopyButton text={SecretId} label={..} copied={..} class={()} />`, `class` its look, as `class={Button { .. }}` from the kit), so the text is on the page once, and says it copied in a polite live region, then dispatches `Copied`, which bubbles, so an ancestor can count the copy (`on:Copied={js::counted(event)}`); nothing to copy or a failed write changes nothing and dispatches nothing |
| `LocalTime` | the first page's date (and a `Public` page's) in UTC; later pages' in the visitor's zone, written by the server | a `<time datetime>` with `t.date`'s text (`<LocalTime when={t.date_time(at, DateStyle::Medium, TimeStyle::Short)} />`): on a browser's first page, before it has reported its zone (`App::zoned_dates`, the `zones` feature), its script writes it again in the browser's zone with the server's own format, as it does on a `Public` page, which is the same for everyone; on later pages the server writes it there and no script runs |
| `Tooltip` | Chromium shows it (`interestfor` is the platform's); elsewhere it is not shown, and a screen reader still reads it as the control's name or description | a short text beside a button or link while the pointer rests on it or it has keyboard focus, where the browser has no `interestfor` (Firefox and WebKit in November 2026): the control writes `interestfor={SaveTipId}` and `aria-describedby={SaveTipId}` (or `aria-labelledby`, on an icon-only control) and the tooltip is `<Tooltip id={SaveTipId} class={()}>"Saves the draft"</Tooltip>`, a `popover="hint"` anchored to the control; shown after the pointer rests half a second and at once on keyboard focus, kept while the pointer moves onto it, hidden a quarter second after it leaves both, on focus leaving or on Escape. Only an `<a>`, `<button>` or `<area>` shows one, as with `interestfor`, so text that shows one is a `<button type="button">`, which the kit's `TipText` look draws as the text around it. The attributes are the platform's, on the app's own element, so the control stays any element the app writes; each names the tooltip by its id type, so a typo does not compile, though nothing requires the `aria-` one. One set of listeners on the document serves every tooltip, so a control a patch adds shows its tooltip too; where the browser has `interestfor` the script does nothing |
| `PrintButton` | no button: the browser's own Print command prints the page | a button (`<PrintButton label={..} class={()} />`, `class` its look) that opens the print dialog; what prints, and at what paper size, is the page's print styles ([Printing](styles.md#printing)) |
| `CheckboxGroup` | a `<fieldset>` with its legend around the app's checkboxes of one name; the form is sent with none checked, and the handler refuses it | while no enabled box is checked, the first is invalid with the app's message (`missing="Choose where you ship."`), so the browser stops the submit and says so there, as for a required text field; checked again after a form reset |
| `RequiredWhen` | a `<fieldset>` around the app's fields, enabled, nothing required; the handler checks the rule | while the form's `control` field (a `FieldName`: a select, radios or a checkbox, also one joined with `form=`) has one of `values` (the field's own type: `values={&[Pricing::Offers]}` for `pricing: Pricing`, text for a text field or a checkbox; another enum's word does not compile), every field in the set but checkboxes is `required`; for any other value the set is disabled, so it is neither checked nor sent. Hide it with `:has` on the control in the app's CSS, which holds before the script and without it |

```rust,ignore
const QTY: Bounds<u32> = Bounds::new(1, 99); // the handler reads QTY.read(&input.qty)
// A new form's number; after a refusal, what was sent: `value: input.qty.clone()`.
let qty = Number { value: 1.into(), ..Number::new(QtyId, f.qty, QTY, t.fewer(), t.more()) };
html! { <div class={Field}><label for={QtyId}>{t.quantity()}</label><NumberField field={&qty} /></div> }
```

`NumberField` is for counts and measures, not money: a number input takes only the browser's
own decimal syntax (`$1,299.99` and a French `1 299,99` never reach the server), and the
field reads a binary number of its type. A price is `<input inputmode="decimal">`
holding the text the form sent, so a refused entry is shown back as typed, read with
`t.parse_money(&input.price, USD)` in the page's locale into `Minor` units ([Views](views.md)).
ui-gallery's listing has both.

`MenuButton`'s items are its children, each the element the page would write with
`role="menuitem"`, so a menu holds whatever a row's actions need:

```rust,ignore
html! {
    <MenuButton id={ShipmentMenuId(reference)} label={t.more_actions()}>
        <a role="menuitem" href={url::Shipment { reference, edit: true }}>{t.edit()}</a>
        <form method="post" action={url::BuyPostage { reference }} data-patch>
            <input type="hidden" name={f.direction} value={Direction::Return}>
            <button role="menuitem">{t.buy_return_label()}</button>
        </form>
        <button type="button" role="menuitem" command="show-modal" commandfor={ConfirmId}>{t.buy_another()}</button>
        <a role="menuitem" href={url::ShipmentCsv { reference }} download>{t.download_csv()}</a>
    </MenuButton>
}
```

The script reads the items from the menu when it needs them, so a patch that adds or removes one
changes the menu, and closes the menu when one is used. An item is an element with
`role="menuitem"` (or `menuitemcheckbox`, `menuitemradio`); one without the role is not reached
by the arrow keys, so give every link and button one (a post form's button, not its `<form>`). A
`disabled` or `hidden` item is passed over; one that should stay reachable and say why it does
nothing is `aria-disabled="true"` instead. Closing a dialog an item opened with
`command`/`commandfor` returns focus to the menu's button.

A design system wraps each one and styles its parts by role and state, which are what assistive
technology announces, so the styles cannot drift from it: `.field [role="option"][aria-selected="true"]`,
`.tabs [role="tab"][aria-selected="true"]`, `.menu [role="menu"]:popover-open`. Each component's root is a `div`
(`[data-scope=number-field]`) around its parts; the wrapper lays it out, or gives it
`display: contents` so the parts join the wrapper's layout. Labels come from the app, in the
page's language. Links are typed routes. List `corten_ui::COMPONENTS` in `App::components`.

Everything else Base UI-style libraries provide is already the platform's: `<dialog>` with
`command="show-modal"` for dialogs and alert dialogs, `popover` for popovers,
`<details name>` for accordions, toggletips as a `popover` opened by `popovertarget`, `<select>` (with `appearance: base-select` where supported),
checkboxes, radios and `<input type="range">`. [examples/ui-gallery](../../examples/ui-gallery) shows
them all on one screen, a seller's draft listing for a card, styled by a small design system, with a dialog the server refuses a form in and one the
address opens, and has a browser test that runs in Chromium, Firefox and
WebKit. A tooltip is the platform's too, `interestfor` with `popover="hint"`, which Chromium
shows itself; `Tooltip` is that element with a script for the browsers that do not yet, to go
once they all do. The toaster is not in the top layer, so an open modal `<dialog>` covers it: a form in a dialog answers
inside the dialog.

A button opens a dialog, or any popover, with no script: `command="show-modal"` (or
`popovertarget`) and `commandfor={..}`, the dialog's `#[derive(Id)]` id, which a component that
renders the dialog for its parent takes as a prop of any id type (`I: Id`). A script calls
`showModal()` only for what a click cannot do, below.

A form in a dialog that the server refuses comes back with the dialog drawn `open`, and when the
answer is a whole page (a post without the runtime) `open` is all the platform has: the dialog
shows, but it is not modal, so focus and Tab leave it for the page behind, which is not inert,
and there is no backdrop. `corten_ui::dialog::modal` makes such a dialog modal when it joins the
page (a load, a navigation or a patch) and focuses the first field marked invalid in it; one drawn
closed stays closed. It takes the dialog itself, so on any other element it does not compile.
List `corten_ui::COMPONENTS` and it is served.

```rust,ignore
<button type="button" command="show-modal" commandfor={RenameId}>"Rename"</button>
<dialog id={RenameId} open={!errors.is_empty()} on:connect={dialog::modal(target)}>
    <form method="post" action={url::Rename} data-patch>..</form>
</dialog>
```

A dialog the address opens (a record beside its list, `/items?selected=it_1`, closed by a link to
`/items`) is drawn `open` the same way, but Escape on a modal dialog closes it where the address
cannot see: a reload or a redraw would open it again. `dialog::modalClosedBy` makes it modal, and
a close request on it (Escape, Android's Back, a click outside a `closedby="any"` dialog) goes to
its close link's address, a ref, without a new history entry and without clicking the link: back,
when the entry before is that address, else in place of the dialog's entry (always so in a browser
without the Navigation API, where Back after a dialog opened from the list shows the list once
more). Attributes on the link (`data-reload`, `data-keep-place`, an `on:click`) do not apply.
Android's Back on the open dialog cannot loop between the two. A `cancel` from inside it, such as
a file input's dismissed picker, is left alone. The close is a link: a button there does not
compile. Without a script, the dialog is open and the link closes it.

```rust,ignore
let close = refs();
html! {
    <dialog open aria-label={item.name} on:connect={dialog::modalClosedBy(target, close, signal)}>
        ..
        <a ref={close} href={url::Items { selected: None }}>"Close"</a>
    </dialog>
}
```

A table whose page has every row of it sorts in place: `corten_ui::rows::sort` is the handler a
sort header's link calls (the kit's `SortHeader`, `on:sort={rows::sort(event, target)}`). It
sorts each body of the link's table by the column of the clicked header, ascending and then
descending on the next click, and sets `aria-sort` on that header (the kit draws the arrow from
it) and removes it from the others. Each cell sorts by its `data-sort`, a value the server writes
(a price in cents, a date as `2026-10-30`, never the cell's formatted text), or else by its text,
leaving out what is `hidden` or `aria-hidden` (a stacked table's `CellLabel`). A column whose
values are all decimal numbers (`-2`, `12.5`) sorts as numbers; any other by an `Intl.Collator`
in the page's `lang`, with digits in numeric order (`Item 2` before `Item 10`). Equal values are
in the order the page drew them, whatever earlier clicks did (the server's order for them when the
page was drawn unsorted, the drawn order when it came in sorted); an empty one is last either way. As in the ARIA sortable table, `aria-sort` is
what tells a screen reader the new order; nothing is announced. A click with a modifier key, and a
table whose header or bodies have a cell that spans columns or rows, are left to the link; so is
every click without the script, so the link is the page the server sorts (a route field,
`sold: Option<SoldBy>`), which draws `aria-sort` on its column, the default order's too. A
`SortHeader` takes the page sorted by its column each way (`ascending`, `descending`) and links
to the one a click gives: the other way when the table is sorted by it, else the way `first` says
(`Sort::Descending` for a column read newest or largest first), which the script follows too; with a click handler it also writes both on the link, and after a sort
the script makes the address the page sorted as shown, in place of its history entry, and each
header's link the page its next click gives. So a reload and a page that reads itself again
(`ReadAgain`, which reads the address as it is then) show the order on screen, and a click with a
modifier key opens the order that click would give. Only the query keys the header links differ
in are taken from them, so a tab's or a choice's key and the fragment stay, as with `TabGroup`.

A part of the page around the table that reads itself again from its own route
([`ReadAgain::from`](requests-and-forms.md#a-read-that-has-not-caught-up-yet) among its markup)
gets the same keys in the address of its next read, also when the sort comes while a read is on
its way (that answer is dropped and the part read again). So that route takes the sort as the
page's does, draws the part sorted by it, and writes it into the part's next `ReadAgain::from`;
put the sort in one `#[route(query)]` set that both routes include (as
[the routes of a list's filters](requests-and-forms.md#forms) do), so its name is the same by
construction. A part route without it answers in its own order, without `aria-sort`, and the
sort is undone on the next read. A form in the part that posts (its `action`, or a submit
button's `formaction`) gets the same keys where it sends, so its route reads the sort as the
part's does and answers in it, and a `ReadAgain::from` its answer brings takes the part's tag in
the page, so a later sort reaches that read too. A form elsewhere on the page whose route reads
the table's order (a "Refresh" beside the table whose answer redirects back to the page sorted as
it was asked) says so with `data-order-of`, the `#[derive(Id)]` id of the table or an element
around it (`<form method="post" action={&url::RefreshSupply { choice }} data-order-of={SupplyId}>`):
it gets the order on screen where it posts, its buttons' `formaction`s too, so the redirect draws
it. On a submit button instead, only where that button sends gets it, and on a link (a
"Previous page" whose route reads the order) its `href` does. A form that does not name
the table is left as it is, so a reset to the default order keeps its address, and so is a GET
form (its address is its fields), also when a hidden field of its own carries the order. Whether
the page was drawn in its default order (a route that leaves a sort it does not have out of the
address) or sorted, the keys the header links differ in are put in, replaced or taken out, as for
the page's own address.

Put `data-no-prefetch` on the `<thead>`, or a hover fetches
the page the server sorts, which the click then does not use. A cell can also sort by the one
`<time datetime>` or `<data value>` it holds (outside its hidden parts), so corten-ui's
`LocalTime` sorts by its time, not its text. A time sorts as an instant when it is a date or a date
and time with `Z` or an offset, as `LocalTime` writes it; a duration, a week, or a number written
for the reader's language (`12,5`) needs `data-sort`. List `corten_ui::COMPONENTS` and it is served.

```rust,ignore
<thead data-no-prefetch>
<SortHeader label="Price" sort={by_price} ascending={&url::Sales { sold: Some(SoldBy::Price) }}
    descending={&url::Sales { sold: Some(SoldBy::PriceDown) }} first={Sort::Ascending} class={TableNumeric {}}
    on:sort={rows::sort(event, target)} />
..
<td class={TableNumeric {}} data-sort={sale.cents}>{t.money(Minor(sale.cents), USD)}</td>
```

It sorts the rows the page has, so it is for a table that shows all of its rows; on a table that
shows a page of them it would sort that page alone. Such a table (the kit's `Pagination` under
it) sorts on the server, by the same links with `on:sort={None::<Handler>}` (`examples/ui-gallery`'s orders page): the route carries
the sort and the page together, a sort link leaves the page out, so a new order starts at the
first page, and the pages' links keep the sort. A page of rows can also be sorted on its own, when
an order across pages would cost more than it is worth (pages by a keyset, `after` the last id,
would need a keyset and an index for each order): `rows::sort` as above, each sort link keeps
the page (the same `after` or offset) so the server sorts those same rows without the script, and
the caption says the order covers the rows shown ("These 50 sales, sorted by price").

```rust,ignore
#[route("/sales")]
pub struct Sales { pub sold: Option<SoldBy>, pub page: Option<usize> }
..
<SortHeader label="Price" sort={by_price} ascending={&url::Sales { sold: Some(SoldBy::Price), page: None }}
    descending={&url::Sales { sold: Some(SoldBy::PriceDown), page: None }} first={Sort::Ascending} class={TableNumeric {}}
    on:sort={None::<Handler>} />
..
<Pagination .. link={&|page| Box::new(url::Sales { sold, page: Some(page).filter(|p| *p > 1) })} />
```

A table whose rows a script also writes or filters keeps their data in a view and sorts that
(`rows()`, [Scripts](scripts.md)), by the view's fields rather than by column.

The design system places popups with CSS anchor positioning (the script makes the control that
opens each popup its anchor):

```css
.field [popover] {
  inset: auto;
  position-area: block-end span-inline-end;
  position-try-fallbacks: flip-block;
  min-width: anchor-size(width);
}
```
