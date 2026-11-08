use crate::{
    AlertForm, MarketplaceQuery,
    model::Record,
    routes,
    text::{self, Msg},
};
use corten::prelude::*;
#[path = "classes.rs"]
mod classes;
use classes::Class;
mod site_header;
pub use site_header::SiteHeader;

corten::assets::embed! { pub struct Static = "static"; }

#[component]
pub fn Layout(req: &Req, title: &str, children: impl Render) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()}>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>{title}" | Card Market"</title>
                <link rel="stylesheet" href={req.asset(Static::STYLE_CSS)}>
                <link rel="stylesheet" href={req.asset(Static::SHELL_CSS)}>
                <link rel="stylesheet" href={req.asset(Static::MARKETPLACE_CSS)}>
                <Corten />
            </head>
            <body>
                <SiteHeader />
                <main>{children}</main>
            </body>
        </html>
    }
}
pub fn document<'a>(req: &'a Req, title: &'a str, children: impl Render + 'a) -> impl Document + 'a {
    html! { <Layout req={req} title={title}>{children}</Layout> }
}
pub fn detail<'a>(req: &'a Req, record: &'a Record, at: &'a routes::Marketplace<'a>, message: &'a str) -> impl Render + 'a {
    html! { <Marketplace req={req} record={record} at={at} message={message} /> }
}
#[component]
fn Marketplace<'a>(req: &'a Req, record: &'a Record, at: &'a routes::Marketplace<'a>, message: &'a str) -> impl Render + 'a {
    let t: Msg = req.t();
    let query = &at.query;
    let f = MarketplaceQuery::FIELDS;
    let a = AlertForm::FIELDS;
    let shown = if query.all() { record.offers.len() } else { record.offers.len().min(5) };
    let reset = routes::Marketplace { locale: at.locale, id: &record.id, query: Default::default() };
    let more = routes::Marketplace {
        locale: at.locale,
        id: &record.id,
        query: MarketplaceQuery { offers: Some("all".into()), ..query.clone() },
    };
    html! {
        <article class={Class::Root}>
            <nav class={Class::Categories}>
                for category in &record.categories {
                    <a href={routes::Marketplace { locale: at.locale, id: "item_1", query: Default::default() }}>
                        {&category.name}
                    </a>
                }
            </nav>
            <h1>{&record.title}</h1>
            if let Some(subtitle) = &record.subtitle { <p class={Class::Subtitle}>{subtitle}</p> }
            <ul class={Class::Badges}>for badge in &record.badges { <li>{badge}</li> }</ul>
            <div class={Class::Images}>
                for (i, url) in record.images.iter().enumerate() {
                    <div class={Class::Image} role="img" aria-label={format_args!("{} {}", record.title, i + 1)} data-src={url}></div>
                }
            </div>
            <section class={Class::Summary}>
                if let Some(summary) = &record.summary {
                    <span><strong>{text::money(t, summary.lowest_minor)}</strong>" "{t.lowest()}</span>
                    <span>{t.listing(summary.count)}</span>
                    <span>{t.number(summary.quantity)}" "{t.available()}</span>
                } else {
                    <span>{t.no_listings()}</span>
                }
            </section>
            <section class={Class::Listings}>
                <h2>{t.listings()}</h2>
                <form method="get" action={&reset}>
                    <label>
                        {t.filter()}<input type="text" name={f.seller} value={query.seller.as_deref().unwrap_or_default()}>
                    </label>
                    <label>
                        {t.sort()}
                        <select name={f.sort}>
                            <option value="asc" selected={!query.descending()}>{t.asc()}</option>
                            <option value="desc" selected={query.descending()}>{t.desc()}</option>
                        </select>
                    </label>
                    if query.all() { <input type="hidden" name={f.offers} value="all"> }
                    <button type="submit">{t.apply()}</button>
                </form>
                <table>
                    <thead>
                        <tr>
                            <th>{t.seller()}</th>
                            <th>{t.condition()}</th>
                            <th>{t.ships_from()}</th>
                            <th>{t.qty()}</th>
                            <th>{t.price()}</th>
                            <th>{t.reviews()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        for row in record.listings(query) {
                            <tr data-listing-id={&row.id}>
                                <td>
                                    {&row.seller}
                                    if let Some(rating) = row.rating_hundredths { " \u{b7} "{text::rating(t, rating)}" \u{2605}" }
                                </td>
                                <td>{&row.condition}</td>
                                <td>{&row.ships_from}</td>
                                <td>{t.number(row.quantity)}</td>
                                <td>{text::money(t, row.price_minor)}</td>
                                <td>{t.number(row.reviews)}</td>
                            </tr>
                        }
                    </tbody>
                </table>
            </section>
            <section class={Class::Offers}>
                <h2>{t.offers()}</h2>
                <table>
                    <thead>
                        <tr>
                            <th>{t.buyer()}</th>
                            <th>{t.condition()}</th>
                            <th>{t.qty()}</th>
                            <th>{t.price()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        for row in &record.offers[..shown] {
                            <tr data-offer-id={&row.id}>
                                <td>{&row.buyer}</td>
                                <td>{&row.condition}</td>
                                <td>{t.number(row.quantity)}</td>
                                <td>{text::money(t, row.price_minor)}</td>
                            </tr>
                        }
                    </tbody>
                </table>
                if shown < record.offers.len() { <a class={Class::More} href={&more}>{t.show_all()}</a> }
            </section>
            <section class={Class::Alert}>
                <h2>{t.alert()}</h2>
                <form method="post" action={at}>
                    <label>{t.email()}<input type="email" name={a.email} required></label>
                    <label>{t.target()}<input type="text" inputmode="decimal" name={a.target_price} required></label>
                    <button type="submit">{t.submit()}</button>
                </form>
                <p class={Class::Message} aria-live="polite">{message}</p>
            </section>
            <section class={Class::Details}>
                <h2>{t.details()}</h2>
                <p>{&record.description}</p>
                <dl>
                    for field in &record.fields {
                        <dt>{&field.name}</dt>
                        <dd>{&field.value}</dd>
                    }
                </dl>
                <ul>for tag in &record.tags { <li>{tag}</li> }</ul>
            </section>
            <section class={Class::Contents}>
                <h2>{t.contents()}</h2>
                <ul>
                    for line in &record.contents {
                        <li>
                            <a href={routes::Marketplace { locale: at.locale, id: &line.item_id, query: Default::default() }}>
                                {&line.title}
                            </a>
                            " \u{d7} "{t.number(line.quantity)}
                        </li>
                    }
                </ul>
            </section>
            <section class={Class::Included}>
                <h2>{t.included()}</h2>
                <ul>
                    for line in &record.included_in {
                        <li>
                            <a href={routes::Marketplace { locale: at.locale, id: &line.item_id, query: Default::default() }}>
                                {&line.title}
                            </a>
                            " \u{d7} "{t.number(line.quantity)}
                        </li>
                    }
                </ul>
            </section>
        </article>
    }
}
