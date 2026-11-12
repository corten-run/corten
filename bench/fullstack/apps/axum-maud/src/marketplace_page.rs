use crate::marketplace::{self, AlertForm, Locale, Query, Record};
use axum::{
    Form, Json,
    extract::{Path, Query as QueryParam, rejection::PathRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use maud::{DOCTYPE, Markup, html};

pub async fn get(Path((tag, id)): Path<(String, String)>, QueryParam(query): QueryParam<Query>) -> Response {
    page(&tag, &id, query, None).await
}
pub async fn post(
    Path((tag, id)): Path<(String, String)>,
    QueryParam(query): QueryParam<Query>,
    Form(form): Form<AlertForm>,
) -> Response {
    page(&tag, &id, query, Some(form)).await
}
async fn page(tag: &str, id: &str, query: Query, form: Option<AlertForm>) -> Response {
    let Some(locale) = Locale::parse(tag) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match marketplace::source::get(id).await {
        Ok(Some(record)) => {
            let message = form.as_ref().map(|f| locale.alert(&record, f)).unwrap_or_default();
            render(&record, locale, &query, &message).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}
pub async fn json(id: Result<Path<String>, PathRejection>) -> Response {
    let Ok(Path(id)) = id else { return crate::record_http::problem(StatusCode::BAD_REQUEST) };
    match marketplace::source::get(&id).await {
        Ok(Some(record)) => Json(record).into_response(),
        Ok(None) => crate::record_http::problem(StatusCode::NOT_FOUND),
        Err(_) => crate::record_http::problem(StatusCode::BAD_GATEWAY),
    }
}
pub fn render(record: &Record, locale: Locale, query: &Query, message: &str) -> Markup {
    let at = locale.href(&record.id);
    let shown = record.offers(query);
    html! {
        (DOCTYPE)
        html lang=(locale.tag()) {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                title { (record.title) " | Card Market" }
                link rel="stylesheet" href="/static/style.css";
                link rel="stylesheet" href="/static/components.css";
                link rel="stylesheet" href="/static/marketplace.css";
                script src="/static/htmx.min.js" defer {}
            }
            body {
                header.site-header__bar { a href="/" { "Card Market" } }
                main {
                    article.marketplace {
                        nav.marketplace__categories {
                            @for c in &record.categories {
                                a href=(locale.href("item_1")) { (c.name) }
                            }
                        }
                        h1 { (record.title) }
                        @if let Some(subtitle) = &record.subtitle { p.marketplace__subtitle { (subtitle) } }
                        ul.marketplace__badges { @for badge in &record.badges { li { (badge) } } }
                        div.marketplace__images {
                            @for (i, url) in record.images.iter().enumerate() {
                                div.marketplace__image role="img" aria-label={ (record.title) " " (i + 1) } data-src=(url) {}
                            }
                        }
                        section.marketplace__summary {
                            @if let Some(s) = &record.summary {
                                span { strong { (locale.money(s.lowest_minor)) } " " (locale.text("lowest")) }
                                span { (locale.listing_count(s.count)) }
                                span { (locale.count(s.quantity)) " " (locale.text("available")) }
                            } @else { span { (locale.text("no_listings")) } }
                        }
                        section.marketplace__listings {
                            h2 { (locale.text("listings")) }
                            form method="get" action=(at) {
                                label { (locale.text("filter")) input type="text" name="seller" value=(query.seller); }
                                label {
                                    (locale.text("sort"))
                                    select name="sort" {
                                        option value="asc" selected[!query.descending()] { (locale.text("asc")) }
                                        option value="desc" selected[query.descending()] { (locale.text("desc")) }
                                    }
                                }
                                @if query.all() { input type="hidden" name="offers" value="all"; }
                                button type="submit" { (locale.text("apply")) }
                            }
                            table {
                                thead { tr { @for key in ["seller", "condition", "ships_from", "qty", "price", "reviews"] {
                                    th { (locale.text(key)) }
                                } } }
                                tbody {
                                    @for row in record.listings(query) {
                                        tr data-listing-id=(row.id) {
                                            td { (row.seller) @if let Some(rating) = row.rating_hundredths { " \u{b7} " (locale.rating(rating)) " \u{2605}" } }
                                            td { (row.condition) } td { (row.ships_from) }
                                            td { (locale.count(row.quantity)) } td { (locale.money(row.price_minor)) } td { (locale.count(row.reviews)) }
                                        }
                                    }
                                }
                            }
                        }
                        section.marketplace__offers {
                            h2 { (locale.text("offers")) }
                            table {
                                thead { tr { @for key in ["buyer", "condition", "qty", "price"] { th { (locale.text(key)) } } } }
                                tbody {
                                    @for row in shown {
                                        tr data-offer-id=(row.id) {
                                            td { (row.buyer) } td { (row.condition) } td { (locale.count(row.quantity)) } td { (locale.money(row.price_minor)) }
                                        }
                                    }
                                }
                            }
                            @if shown.len() < record.offers.len() {
                                a.marketplace__more href=(query.more_href(locale, &record.id)) { (locale.text("show_all")) }
                            }
                        }
                        section.marketplace__alert {
                            h2 { (locale.text("alert")) }
                            form method="post" action=(query_href(locale, &record.id, query)) {
                                label { (locale.text("email")) input type="email" name="email" required; }
                                label { (locale.text("target")) input type="text" inputmode="decimal" name="target_price" required; }
                                button type="submit" { (locale.text("submit")) }
                            }
                            p.marketplace__message aria-live="polite" { (message) }
                        }
                        section.marketplace__details {
                            h2 { (locale.text("details")) }
                            p { (record.description) }
                            dl { @for field in &record.fields { dt { (field.name) } dd { (field.value) } } }
                            ul { @for tag in &record.tags { li { (tag) } } }
                        }
                        @for (class, key, lines) in [
                            ("marketplace__contents", "contents", &record.contents),
                            ("marketplace__included", "included", &record.included_in),
                        ] {
                            section class=(class) {
                                h2 { (locale.text(key)) }
                                ul { @for line in lines {
                                    li { a href=(locale.href(&line.item_id)) { (line.title) } " \u{d7} " (locale.count(line.quantity)) }
                                } }
                            }
                        }
                    }
                }
            }
        }
    }
}
fn query_href(locale: Locale, id: &str, query: &Query) -> String {
    let mut url = url::Url::parse(&format!("http://localhost{}", locale.href(id))).unwrap();
    url.query_pairs_mut()
        .append_pair("seller", &query.seller)
        .append_pair("sort", if query.descending() { "desc" } else { "asc" });
    if query.all() {
        url.query_pairs_mut().append_pair("offers", "all");
    }
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rich_page_escapes_data_and_renders_only_selected_rows() {
        let record: Record = serde_json::from_str(include_str!("../tests/marketplace.json")).unwrap();
        for tag in ["en-US", "fr-FR", "de-DE"] {
            let locale = Locale::parse(tag).unwrap();
            let html = render(&record, locale, &Query::default(), "<script>bad</script>").into_string();
            assert!(html.contains(&format!("lang=\"{tag}\"")));
            assert!(html.contains("Ember &lt;dragon&gt; &amp;"));
            assert!(html.contains("&lt;script&gt;bad&lt;/script&gt;"));
            assert_eq!(html.matches("data-listing-id=").count(), 4);
            assert_eq!(html.matches("data-offer-id=").count(), 5);
            assert!(html.contains("marketplace__included"));
            assert!(html.contains(&format!("/marketplace/{tag}/item_2")));
            assert!(!html.contains("marketplace__subtitle"));
            let query = Query { seller: "Al".into(), sort: "desc".into(), offers: "all".into() };
            let html = render(&record, locale, &query, "").into_string();
            assert_eq!(html.matches("data-listing-id=").count(), 2);
            assert_eq!(html.matches("data-offer-id=").count(), 6);
            assert!(!html.contains("marketplace__more"));
        }
    }
}
