use corten::{
    prelude::*,
    view::{Append, Remove},
};
use serde::Deserialize;

use super::Price;
use crate::{
    items,
    model::Offer,
    text::{self, Msg},
};

/// Offers shown before "Show all".
const OFFERS_SHOWN: usize = 5;

/// The item page's parameters: `?offers=all` after "Show all".
#[derive(Clone, Copy, Default, Deserialize, Route, Fields)]
#[route(query)]
pub struct ItemQuery {
    pub offers: Option<Shown>,
}

/// Which offers the page shows: the first five unless all.
#[derive(Clone, Copy, PartialEq, Debug, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Shown {
    All,
}

/// The offers' rows: "Show all" adds the rest at their end.
#[derive(Id)]
struct OfferRowsId;

#[derive(Id)]
struct ShowAllId;

/// The first offers, or every one when `all`. "Show all" is a GET form: without JavaScript it
/// loads the page with every offer (`?offers=all`), and with it (`data-patch`) the answer adds
/// only the rows the page does not have (`MoreOffers`). The first response carries five rows
/// whatever the item has.
#[component]
pub fn OfferList<'a>(t: Msg, id: &'a str, offers: &'a [Offer], all: bool) -> impl Render {
    let shown = if all { offers } else { &offers[..offers.len().min(OFFERS_SHOWN)] };
    let f = ItemQuery::FIELDS;
    html! {
        <div>
            <h2>{t.item_offers()}</h2>
            <table>
                <thead>
                    <tr>
                        <th>{t.table_buyer()}</th>
                        <th>{t.table_condition()}</th>
                        <th>{t.table_qty()}</th>
                        <th>{t.table_price()}</th>
                    </tr>
                </thead>
                <tbody id={OfferRowsId}>for o in shown { <OfferRow t={t} o={o} /> }</tbody>
            </table>
            if shown.len() < offers.len() {
                <form id={ShowAllId} method="get" action={items::Item { id, ..Default::default() }} data-patch>
                    <button name={f.offers} value={Shown::All}>{t.item_show_all_offers(offers.len())}</button>
                </form>
            }
        </div>
    }
}

/// "Show all"'s answer with JavaScript: the offers after the first five, after the rows the page
/// has, and no form.
#[component]
pub fn MoreOffers<'a>(t: Msg, offers: &'a [Offer]) -> impl Patch {
    let more = offers.get(OFFERS_SHOWN..).unwrap_or_default();
    html! {
        {Append(OfferRowsId, html! { for o in more { <OfferRow t={t} o={o} /> } })}
        {Remove(ShowAllId)}
    }
}

#[component]
fn OfferRow(t: Msg, o: &Offer) -> impl Render {
    html! {
        <tr>
            <td>{o.buyer}</td>
            <td>{text::condition(t, o.grade, &o.condition)}</td>
            <td>{o.quantity}</td>
            <Price t={t} cents={o.cents} sent={&o.price} />
        </tr>
    }
}
