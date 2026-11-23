use corten::prelude::*;

use super::Price;
use crate::{
    model::{Listing, sort_cents},
    text::{self, Msg},
};

/// The listings, cheapest first, with a button that flips the order in the browser
/// (`listing_sort.js`, the same order `sort_listings` gives). Each row gives its ref the cents it
/// sorts by, `ref={row.with(sort_cents(l))}`, and the script reads them as a
/// `Map<HTMLTableRowElement, number>`, so the compiler checks the one name the two share: the
/// script only reorders the rows the server drew, which a ref's value is for; a
/// `#[component(view)]` is for rows a script writes or makes (the scripts guide, Views), and would
/// add the views module to the page. The button does nothing without a script, so it is not drawn
/// then (a `scripting: none` rule in `item_detail.css`), and the table keeps the server's order.
#[component(js)]
pub fn ListingSort<'a>(t: Msg, listings: &'a [&'a Listing]) -> impl Render {
    let (body, row, ascending, descending) = refs();
    html! {
        <div>
            <h2>{t.item_listings()}</h2>
            <button type="button" on:click={js::toggle(body, row, ascending, descending)}>
                <span ref={ascending}>{t.item_sort_asc()}</span>
                <span ref={descending} hidden>{t.item_sort_desc()}</span>
            </button>
            <table>
                <thead>
                    <tr>
                        <th>{t.table_seller()}</th>
                        <th>{t.table_condition()}</th>
                        <th>{t.table_ships_from()}</th>
                        <th>{t.table_qty()}</th>
                        <th>{t.table_price()}</th>
                    </tr>
                </thead>
                <tbody ref={body}>
                    for &l in listings {
                        <tr ref={row.with(sort_cents(l))}><ListingCells t={t} l={l} /></tr>
                    }
                </tbody>
            </table>
        </div>
    }
}

/// A listing's cells.
#[component]
fn ListingCells(t: Msg, l: &Listing) -> impl Render {
    html! {
        <td>
            {l.seller}
            match (l.stars, &l.rating) {
                (Some(stars), _) => {
                    " · "{t.listing_rating(text::msg::ListingRating { rating: t.number(stars), reviews: l.reviews })}
                },
                (None, Some(rating)) => { " · "{t.listing_rating(text::msg::ListingRating { rating, reviews: l.reviews })} },
                (None, None) => {},
            }
        </td>
        <td>{text::condition(t, l.grade, &l.condition)}</td>
        <td>{l.ships_from}</td>
        <td>{l.quantity}</td>
        <Price t={t} cents={l.cents} sent={&l.price} />
    }
}
