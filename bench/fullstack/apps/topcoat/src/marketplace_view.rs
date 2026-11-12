use crate::{
    COMPONENTS, Id, READY, STYLE,
    marketplace::{self, AlertForm, Locale as PageLocale, Query, Record},
};
use std::sync::Arc;
use topcoat::asset::{Asset, asset};
use topcoat::{
    Result,
    context::Cx,
    router::{
        content::{Form, Json},
        error::{bad_request, not_found},
        page, path_param, request, route,
    },
    view::{View, component, view},
};
const MARKETPLACE: Asset = asset!("static/marketplace.css");
path_param!(locale);

#[page([GET, POST] "/marketplace/{locale}/{id}")]
pub async fn marketplace_page(cx: &Cx, Form(form): Form<AlertForm>) -> Result<impl View> {
    let locale = PageLocale::parse(path_param::<Locale>(cx)).ok_or_else(|| bad_request("unsupported marketplace locale"))?;
    let query = Form::<Query>::from_bytes(request::uri(cx).query().unwrap_or_default().as_bytes())?.0;
    let record = marketplace::source::get(path_param::<Id>(cx)).await.map_err(topcoat::Error::msg)?.ok_or_else(not_found)?;
    let message = if request::method(cx).as_str() == "POST" {
        let (message, minor) = locale.alert_result(&record, &form);
        if let Some(target_minor) = minor {
            crate::alerts::append(cx, crate::alerts::Alert { item_id: record.id.clone(), email: form.email.clone(), target_minor })?;
        }
        message
    } else {
        String::new()
    };
    Ok(view! {
        <!DOCTYPE html>
        <html lang=(locale.tag())>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>((&record.title, " | Card Market"))</title>
                <link rel="stylesheet" href=(STYLE)>
                <link rel="stylesheet" href=(COMPONENTS)>
                <link rel="stylesheet" href=(MARKETPLACE)>
                topcoat::runtime::script()
                <script type="module" src=(READY)></script>
            </head>
            <body>
                <header class="site-header__bar"><a href="/">"Card Market"</a></header>
                <main>detail(record: &record, locale: locale, query: &query, message: &message)</main>
            </body>
        </html>
    })
}
#[route(GET "/api/marketplace/{id}")]
pub async fn marketplace_json(cx: &Cx) -> Result<Json<Arc<Record>>> {
    let record = marketplace::source::get(path_param::<Id>(cx)).await.map_err(topcoat::Error::msg)?.ok_or_else(not_found)?;
    Ok(Json(record))
}
#[component]
async fn detail(record: &Record, locale: PageLocale, query: &Query, message: &str) -> Result<impl View> {
    let shown = record.offers(query);
    Ok(view! {
        <article class="marketplace">
            <nav class="marketplace__categories">
                for category in &record.categories {
                    <a href=(locale.href("item_1"))>(&category.name)</a>
                }
            </nav>
            <h1>(&record.title)</h1>
            if let Some(subtitle) = &record.subtitle { <p class="marketplace__subtitle">(subtitle)</p> }
            <ul class="marketplace__badges">for badge in &record.badges { <li>(badge)</li> }</ul>
            <div class="marketplace__images">
                for (i, url) in record.images.iter().enumerate() {
                    <div class="marketplace__image" role="img" aria-label=((&record.title, " ", i + 1)) data-src=(url)></div>
                }
            </div>
            <section class="marketplace__summary">
                match &record.summary {
                    Some(summary) => {
                        <span><strong>(locale.money(summary.lowest_minor))</strong>" " (locale.text("lowest"))</span>
                        <span>(locale.listing_count(summary.count))</span>
                        <span>(locale.count(summary.quantity)) " " (locale.text("available"))</span>
                    }
                    None => <span>(locale.text("no_listings"))</span>,
                }
            </section>
            <section class="marketplace__listings">
                <h2>(locale.text("listings"))</h2>
                <form method="get" action=(locale.href(&record.id))>
                    <label>(locale.text("filter")) <input type="text" name="seller" value=(&query.seller)></label>
                    <label>
                        (locale.text("sort"))
                        <select name="sort">
                            <option value="asc" selected=(!query.descending())>(locale.text("asc"))</option>
                            <option value="desc" selected=(query.descending())>(locale.text("desc"))</option>
                        </select>
                    </label>
                    if query.all() { <input type="hidden" name="offers" value="all"> }
                    <button type="submit">(locale.text("apply"))</button>
                </form>
                <table>
                    <thead><tr>for key in ["seller", "condition", "ships_from", "qty", "price", "reviews"] { <th>(locale.text(key))</th> }</tr></thead>
                    <tbody>
                        for row in record.listings(query) {
                            <tr data-listing-id=(&row.id)>
                                <td>(&row.seller) if let Some(rating) = row.rating_hundredths { " \u{b7} " (locale.rating(rating)) " \u{2605}" }</td>
                                <td>(&row.condition)</td><td>(&row.ships_from)</td>
                                <td>(locale.count(row.quantity))</td><td>(locale.money(row.price_minor))</td><td>(locale.count(row.reviews))</td>
                            </tr>
                        }
                    </tbody>
                </table>
            </section>
            <section class="marketplace__offers">
                <h2>(locale.text("offers"))</h2>
                <table>
                    <thead><tr>for key in ["buyer", "condition", "qty", "price"] { <th>(locale.text(key))</th> }</tr></thead>
                    <tbody>
                        for row in shown {
                            <tr data-offer-id=(&row.id)>
                                <td>(&row.buyer)</td><td>(&row.condition)</td><td>(locale.count(row.quantity))</td><td>(locale.money(row.price_minor))</td>
                            </tr>
                        }
                    </tbody>
                </table>
                if shown.len() < record.offers.len() {
                    <a class="marketplace__more" href=(query.more_href(locale, &record.id))>(locale.text("show_all"))</a>
                }
            </section>
            <section class="marketplace__alert">
                <h2>(locale.text("alert"))</h2>
                <form method="post" action=(query_href(locale, &record.id, query))>
                    <label>(locale.text("email")) <input type="email" name="email" required=(true)></label>
                    <label>(locale.text("target")) <input type="text" inputmode="decimal" name="target_price" required=(true)></label>
                    <button type="submit">(locale.text("submit"))</button>
                </form>
                <p class="marketplace__message" aria-live="polite">(message)</p>
            </section>
            <section class="marketplace__details">
                <h2>(locale.text("details"))</h2>
                <p>(&record.description)</p>
                <dl>for field in &record.fields { <dt>(&field.name)</dt><dd>(&field.value)</dd> }</dl>
                <ul>for tag in &record.tags { <li>(tag)</li> }</ul>
            </section>
            for (class, key, lines) in [
                ("marketplace__contents", "contents", &record.contents),
                ("marketplace__included", "included", &record.included_in),
            ] {
                <section class=(class)>
                    <h2>(locale.text(key))</h2>
                    <ul>for line in lines {
                        <li><a href=(locale.href(&line.item_id))>(&line.title)</a>" \u{d7} " (locale.count(line.quantity))</li>
                    }</ul>
                </section>
            }
        </article>
    })
}
fn query_href(locale: PageLocale, id: &str, query: &Query) -> String {
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
    use topcoat::router::{Body, Router, request::Request, to_bytes};

    #[derive(serde::Deserialize)]
    struct Preview {
        locale: String,
        #[serde(flatten)]
        query: Query,
    }

    #[page("/preview")]
    async fn preview(Form(input): Form<Preview>) -> Result<impl View> {
        let record: Record = serde_json::from_str(include_str!("../tests/marketplace.json")).unwrap();
        let locale = PageLocale::parse(&input.locale).unwrap();
        Ok(view! { detail(record: &record, locale: locale, query: &input.query, message: "<script>bad</script>") })
    }

    async fn render(router: &Router, query: &str) -> String {
        let request = Request::builder().uri(format!("/preview?{query}")).body(Body::empty()).unwrap();
        let response = router.handle(request).await;
        assert_eq!(response.status(), 200);
        String::from_utf8(to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap()
    }

    #[tokio::test]
    async fn rich_topcoat_view_escapes_data_and_limits_rows() {
        let router = Router::builder().page(preview).build();
        for tag in ["en-US", "fr-FR", "de-DE"] {
            let html = render(&router, &format!("locale={tag}")).await;
            assert!(html.contains("Ember &lt;dragon&gt; &amp;"));
            assert!(html.contains("&lt;script&gt;bad&lt;/script&gt;"));
            assert_eq!(html.matches("data-listing-id=").count(), 4);
            assert_eq!(html.matches("data-offer-id=").count(), 5);
            assert!(html.contains(&format!("/marketplace/{tag}/item_2")));
            let html = render(&router, &format!("locale={tag}&seller=Al&sort=desc&offers=all")).await;
            assert_eq!(html.matches("data-listing-id=").count(), 2);
            assert_eq!(html.matches("data-offer-id=").count(), 6);
            assert!(!html.contains("marketplace__more"));
        }
    }
}
