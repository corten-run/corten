use corten::prelude::*;

use super::{BulkBar, ConfirmDialog, InventoryRow, ItemCount, Line, PriceEdited};
use crate::{
    app::{ArchiveInput, GridQuery, Level, Sort, url},
    text::{Msg, USD, msg},
    ui::{
        button::{Button, ButtonSize, ButtonVariant},
        input::Input,
    },
};

/// The archive form's id: the rows' checkboxes name it in `form=`.
#[derive(Id)]
pub struct ArchiveFormId;

/// The archive dialog's id: the bulk bar's Archive button opens it (`commandfor`), no script.
#[derive(Id)]
pub struct ArchiveDialogId;

/// Every item, with selection (click, shift-click for a range, select all), a filter, sortable
/// columns, inline price edits (each cell says whether its price is saved, a `PriceEdited`
/// event, and the grid counts those that are not), a confirm dialog for archiving, and live stock
/// levels. The sort and the filter read the rows' fields by name (`row.name`, `row.qty`), so a
/// column moved in the markup cannot sort the wrong one, and the count of unsaved prices is the
/// catalog's plural message (`t.js().grid_unsent()`), which picks its form in the browser as the
/// server would.
///
/// Without JavaScript the filter is a `GET` form and each sortable header a link, both to the
/// page with its query (`?q=`, `?sort=`), which the server answers filtered and sorted; with it,
/// their handlers do the same in the browser with no request, and the form's Filter button is not
/// drawn.
///
/// The rows are `InventoryRow` views with no handlers of their own: one handler on the `<tbody>`
/// gets the checkbox that was clicked (`select.closest()`), so 500 rows cost one `data-on`, and
/// the script writes a row's holes through `rows(body, InventoryRow)`.
#[component(css, js)]
pub fn InventoryGrid<'a>(lines: &'a [Line<'a>], view: &'a GridQuery, t: Msg) -> impl Render {
    let (body, select, all, count, bar, form, empty, note, shown) = refs();
    let q = GridQuery::FIELDS;
    // A header's link: the page sorted by its column, with the filter kept.
    let by = |sort: Sort| url::Home { view: GridQuery { q: view.q.clone(), sort: Some(sort) } };
    let sorted = |sort: Sort| (view.sort == Some(sort)).then_some("ascending");
    // A filtered page says how many rows it shows, as the script does once the seller types.
    let filtering = view.q.as_deref().is_some_and(|q| !q.trim().is_empty());
    let showing = lines.iter().filter(|l| !l.hidden).count();
    // What the selection handlers update, built once and passed as one argument.
    let sel = js::Selection { body, all, count, bar };
    // The unsaved-prices note and its text, a plural message the script fills in with the count.
    let unsent = js::Unsent { note, label: t.js().grid_unsent() };
    // How many rows the filter shows of how many there are, in place of the item count.
    let found = js::Found { empty, shown, text: t.js().grid_shown(), number: t.js().number() };
    html! {
        <section
            class={Grid}
            on:connect={js::live(body, url::Levels, signal)}
            on:PriceEdited={js::priceEdited(event, body, unsent)}
            on:submit={js::priceSent(event, body, unsent)}
        >
            <div class={Toolbar}>
                <form class={Filter} method="get" action={url::Home::default()} role="search" on:submit={js::stay(event)}>
                    <input
                        class={Input {}}
                        type="search"
                        name={q.q}
                        value={view.q.as_deref().unwrap_or("")}
                        placeholder="Filter by name or set"
                        aria-label="Filter"
                        on:input={js::filter(target, found, sel)}
                    >
                    if let Some(sort) = view.sort { <input type="hidden" name={q.sort} value={sort}> }
                    <button class={(Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }, NoScript)}>"Filter"</button>
                </form>
                <BulkBar count={count} bar={bar} archive={ArchiveDialogId} on:clear={js::clear(sel)} />
                <output ref={note} hidden></output>
                <div class={Counts}>
                    <output ref={shown} hidden={!filtering}>
                        if filtering {
                            {t.grid_shown(msg::GridShown { shown: t.number(showing), total: t.number(lines.len()) })}
                        }
                    </output>
                    <ItemCount t={t} count={lines.len()} />
                </div>
            </div>
            <div class={Scroll}>
                <table class={Table}>
                    <thead>
                        <tr>
                            <th>
                                <input
                                    ref={all}
                                    type="checkbox"
                                    aria-label="Select all"
                                    on:change={js::selectAll(sel)}
                                >
                            </th>
                            <th aria-sort={sorted(Sort::Name)}>
                                <a href={by(Sort::Name)} on:click={js::sortByName(event, target, body)}>"Name"</a>
                            </th>
                            <th aria-sort={sorted(Sort::Set)}>
                                <a href={by(Sort::Set)} on:click={js::sortBySet(event, target, body)}>"Set"</a>
                            </th>
                            <th>"Condition"</th>
                            <th aria-sort={sorted(Sort::Qty)}>
                                <a href={by(Sort::Qty)} on:click={js::sortByQty(event, target, body)}>"Qty"</a>
                            </th>
                            <th aria-sort={sorted(Sort::Price)}>
                                <a href={by(Sort::Price)} on:click={js::sortByPrice(event, target, body)}>
                                    "Price ("{USD.code()}")"
                                </a>
                            </th>
                        </tr>
                    </thead>
                    <tbody
                        ref={body}
                        on:connect={js::recount(body, found, signal)}
                        on:click={js::toggle(event, select.closest(), sel)}
                    >
                        for line in lines {
                            <InventoryRow
                                id={&line.item.id}
                                name={&line.item.name}
                                set={&line.item.set}
                                condition={line.item.condition}
                                qty={line.qty}
                                sold_out={line.qty == 0}
                                price_cents={line.item.price_cents}
                                selected={false}
                                hidden={line.hidden}
                                select={select}
                            />
                        }
                    </tbody>
                </table>
            </div>
            <p ref={empty} class={Empty} hidden={lines.is_empty() || lines.iter().any(|l| !l.hidden)}>
                "No items match the filter."
            </p>
            // Each row's checkbox belongs to this form (`form=`), so it posts the checked ids. Its
            // submit key makes a resend (a lost answer, a retry) archive once.
            <form ref={form} id={ArchiveFormId} method="post" action={url::Archive} data-patch hidden>
                {SubmitKey::field(ArchiveInput::FIELDS.submit)}
            </form>
            <ConfirmDialog
                id={ArchiveDialogId}
                title="Archive the selected items?"
                confirm="Archive"
                on:confirm={js::archive(form, sel)}
            >
                <p>"Archived items leave the grid. Their listings end."</p>
            </ConfirmDialog>
        </section>
    }
}
