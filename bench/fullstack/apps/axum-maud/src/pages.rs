//! Corten's card-market pages as Maud templates, with the markup of aspnet's Razor pages: the
//! layout, the home page, the item page, its alert message and the 404 page.
use maud::{DOCTYPE, Markup, html};

use crate::model::{ContentLine, ItemView, sort_listings};

/// The document every page shares. htmx boosts links and forms; item.js sorts the listings.
fn layout(title: &str, content: Markup) -> Markup {
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                title { (title) }
                link rel="stylesheet" href="/static/style.css";
                link rel="stylesheet" href="/static/components.css";
                script src="/static/htmx.min.js" defer {}
                script src="/static/item.js" defer {}
            }
            body hx-boost="true" {
                header class="site-header__bar" { a href="/" { "Card Market" } }
                main { (content) }
            }
        }
    }
}

pub fn home(shelf: &[&ItemView]) -> Markup {
    layout(
        "Popular items | Card Market",
        html! {
            h1 { "Popular items" }
            @if shelf.is_empty() {
                ul class="item-list__list item-list__ids" {
                    @for n in 1..=50 {
                        li { a href={ "/items/item_" (n) } { "Item " (n) } }
                    }
                }
            } @else {
                ul class="item-list__list" {
                    @for item in shelf {
                        li {
                            a class="item-card__card" href={ "/items/" (item.id) } {
                                strong { (item.title) }
                                @if let Some(subtitle) = &item.subtitle {
                                    span class="item-card__set" { (subtitle) }
                                }
                                @match &item.summary {
                                    Some(s) => span class="item-card__from" { "From " (s.lowest.as_deref().unwrap_or("—")) },
                                    None => span class="item-card__from" { "No listings yet" },
                                }
                            }
                        }
                    }
                }
            }
        },
    )
}

/// The item page: every offer when `all_offers`, and the alert's answer after a form post
/// without JavaScript (empty otherwise).
pub fn item(item: &ItemView, all_offers: bool, message: &str) -> Markup {
    let offers = if all_offers { &item.offers[..] } else { &item.offers[..item.offers.len().min(5)] };
    layout(
        &format!("{} | Card Market", item.title),
        html! {
            article {
                div class="item-detail__top" {
                    div class="item-detail__intro" {
                        nav class="item-detail__crumbs" {
                            @for c in &item.categories {
                                a href={ "/categories/" (c.slug) } { (c.name) }
                            }
                        }
                        h1 { (item.title) }
                        @if let Some(subtitle) = &item.subtitle {
                            p class="item-detail__subtitle" { (subtitle) }
                        }
                        ul class="item-detail__chips" {
                            @for badge in &item.badges {
                                li { (badge) }
                            }
                        }
                    }
                    @if !item.images.is_empty() {
                        div class="item-detail__gallery" {
                            @for (i, url) in item.images.iter().enumerate() {
                                div class="item-detail__image" role="img" aria-label={ (item.title) " image " (i + 1) } data-src=(url) {}
                            }
                        }
                    }
                    section class="item-detail__panel item-detail__summary gap-3 sm:gap-5" {
                        @if let Some(s) = &item.summary {
                            span { strong { (s.lowest.as_deref().unwrap_or("—")) } " lowest" }
                            span { (counted(s.count, "listing", "listings")) }
                            span { (counted(s.quantity, "available", "available")) }
                        } @else {
                            span { "No listings yet" }
                        }
                    }
                }
                section class="item-detail__panel" {
                    h2 { "Listings" }
                    button type="button" data-sort {
                        span { "Price: low to high" }
                        span hidden { "Price: high to low" }
                    }
                    table {
                        thead {
                            tr { th { "Seller" } th { "Condition" } th { "Ships from" } th { "Qty" } th { "Price" } }
                        }
                        tbody {
                            @for l in sort_listings(&item.listings, false) {
                                tr {
                                    td {
                                        (l.seller)
                                        @if let Some(rating) = &l.rating {
                                            " · " (rating) " ★ (" (l.reviews) ")"
                                        }
                                    }
                                    td { (l.condition) }
                                    td { (l.ships_from) }
                                    td { (l.quantity) }
                                    td class="price__amount" { (l.price) }
                                }
                            }
                        }
                    }
                }
                section class="item-detail__panel" id="offers" {
                    h2 { "Offers" }
                    table {
                        thead {
                            tr { th { "Buyer" } th { "Condition" } th { "Qty" } th { "Price" } }
                        }
                        tbody {
                            @for o in offers {
                                tr {
                                    td { (o.buyer) }
                                    td { (o.condition) }
                                    td { (o.quantity) }
                                    td class="price__amount" { (o.price) }
                                }
                            }
                        }
                    }
                    @if offers.len() < item.offers.len() {
                        form method="get" action={ "/items/" (item.id) } hx-get={ "/items/" (item.id) } hx-select="#offers" hx-target="#offers" hx-swap="outerHTML" {
                            button name="offers" value="all" { "Show all " (item.offers.len()) " offers" }
                        }
                    }
                }
                section class="item-detail__panel" {
                    h2 { "Price alert" }
                    div class="alert-form__form" {
                        form method="post" hx-post={ "/items/" (item.id) } hx-target="#alert-message" hx-swap="outerHTML" {
                            input type="hidden" name="item_id" value=(item.id);
                            input type="hidden" name="title" value=(item.title);
                            label { "Email" input type="email" name="email" required; }
                            label { "Alert me below" input type="text" name="target_price" inputmode="decimal" required; }
                            button type="submit" { "Set alert" }
                        }
                    }
                    (alert_message(message))
                }
                section class="item-detail__panel" {
                    h2 { "Details" }
                    p { (item.description) }
                    dl {
                        @for f in &item.fields {
                            dt { (f.name) }
                            dd { (f.value) }
                        }
                    }
                    @if !item.tags.is_empty() {
                        ul class="item-detail__chips" {
                            @for tag in &item.tags {
                                li { (tag) }
                            }
                        }
                    }
                }
                (content_list("Contents", &item.contents))
                (content_list("Included in", &item.included_in))
            }
        },
    )
}

/// The price alert's answer: part of the item page, and alone as htmx's response to the form.
pub fn alert_message(message: &str) -> Markup {
    html! {
        p class="alert-form__message" id="alert-message" aria-live="polite" { (message) }
    }
}

fn content_list(title: &str, lines: &[ContentLine]) -> Markup {
    html! {
        @if !lines.is_empty() {
            section class="item-detail__panel" {
                h2 { (title) }
                ul {
                    @for c in lines {
                        li { a href={ "/items/" (c.item_id) } { (c.title) } " × " (c.quantity) }
                    }
                }
            }
        }
    }
}

/// Corten's 404 page, for a missing item and for any address no route serves.
pub fn not_found() -> Markup {
    layout(
        "Not found | Card Market",
        html! {
            h1 { "Not found" }
            p { "There is no card at this address." }
            p { a href="/" { "Go to popular items" } }
        },
    )
}

/// A count as an English page writes it: digits grouped, and the word singular for one.
fn counted(n: i64, one: &str, other: &str) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + other.len() + 2);
    if n < 0 {
        out.push('-');
    }
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out.push(' ');
    out.push_str(if n == 1 { one } else { other });
    out
}
