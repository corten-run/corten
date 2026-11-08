#[cfg(feature = "ssr")]
use crate::marketplace::AlertForm;
use crate::marketplace::{Locale, Query, Record};
use leptos::prelude::*;
use leptos_meta::{Html, Stylesheet, Title};
use leptos_router::hooks::{use_params_map, use_query_map};
use std::sync::Arc;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub enum Loaded {
    Page { record: Arc<Record>, message: String },
    Error(u16),
}
#[server]
pub async fn load_marketplace(tag: String, id: String) -> Result<Loaded, ServerFnError> {
    let Some(locale) = Locale::parse(&tag) else {
        return Ok(Loaded::Error(400));
    };
    Ok(match crate::marketplace::source::get(&id).await {
        Ok(Some(record)) => {
            let message = use_context::<AlertForm>().map(|form| locale.alert(&record, &form)).unwrap_or_default();
            Loaded::Page { record, message }
        }
        Ok(None) => Loaded::Error(404),
        Err(_) => Loaded::Error(502),
    })
}
#[cfg(feature = "ssr")]
pub async fn marketplace_json(axum::extract::Path(id): axum::extract::Path<String>) -> axum::response::Response {
    use axum::{http::StatusCode, response::IntoResponse, Json};
    match crate::marketplace::source::get(&id).await {
        Ok(Some(record)) => Json(record).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}
/// Plain POST fallback rendered by the same Leptos route and resource as GET.
#[cfg(feature = "ssr")]
pub async fn marketplace_post(
    axum::extract::State(options): axum::extract::State<LeptosOptions>,
    request: axum::extract::Request,
) -> axum::response::Response {
    use axum::{body::Body, extract::FromRequest, response::IntoResponse};
    let (parts, body) = request.into_parts();
    let input = match axum::Form::<AlertForm>::from_request(axum::http::Request::from_parts(parts.clone(), body), &()).await {
        Ok(axum::Form(input)) => input,
        Err(error) => return error.into_response(),
    };
    leptos_axum::render_app_async_with_context(
        move || provide_context(input.clone()),
        move || crate::app::shell(options.clone()),
    )(axum::http::Request::from_parts(parts, Body::empty())).await
}

#[component]
pub fn MarketplacePage() -> impl IntoView {
    let params = use_params_map();
    let query = use_query_map();
    let tag = move || params.read().get("locale").unwrap_or_default();
    let record = Resource::new(
        move || (tag(), params.read().get("id").unwrap_or_default(), query.read().to_query_string()),
        |(tag, id, _)| load_marketplace(tag, id),
    );
    view! {
        <Html attr:lang=tag/>
        <Stylesheet href="/marketplace.css"/>
        <Suspense fallback=|| ()>
            {move || Suspend::new(async move {
                match record.await {
                    Ok(Loaded::Page { record, message }) => {
                        let values = query.read();
                        let query = Query {
                            seller: values.get("seller").unwrap_or_default(),
                            sort: values.get("sort").unwrap_or_default(),
                            offers: values.get("offers").unwrap_or_default(),
                        };
                        view! { <MarketplaceDetail record locale=Locale::parse(&tag()).unwrap() query message/> }.into_any()
                    }
                    result => {
                        let status = match result { Ok(Loaded::Error(status)) => status, _ => 502 };
                        #[cfg(feature = "ssr")]
                        if let Some(response) = use_context::<leptos_axum::ResponseOptions>() {
                            response.set_status(axum::http::StatusCode::from_u16(status).unwrap());
                        }
                        let text = if status == 404 { "Not found" } else if status == 400 { "Unsupported locale" } else { "Marketplace API did not answer" };
                        view! { <Title text=text/><h1>{text}</h1> }.into_any()
                    }
                }
            })}
        </Suspense>
    }
}
#[component]
fn MarketplaceDetail(record: Arc<Record>, locale: Locale, query: Query, message: String) -> impl IntoView {
    let title = record.title.clone();
    let listings = record.listings(&query).into_iter().map(|row| {
        let seller = match row.rating_hundredths {
            Some(rating) => format!("{} \u{b7} {} \u{2605}", row.seller, locale.rating(rating)),
            None => row.seller.clone(),
        };
        view! {
            <tr data-listing-id=row.id.clone()>
                <td>{seller}</td><td>{row.condition.clone()}</td><td>{row.ships_from.clone()}</td>
                <td>{locale.count(row.quantity)}</td><td>{locale.money(row.price_minor)}</td><td>{locale.count(row.reviews)}</td>
            </tr>
        }
    }).collect_view();
    let shown = record.offers(&query);
    let more = (shown.len() < record.offers.len()).then(|| {
        view! {
            <a class="marketplace__more" href=query.more_href(locale, &record.id) rel="external">{locale.text("show_all")}</a>
        }
    });
    let offers = shown.iter().map(|row| view! {
        <tr data-offer-id=row.id.clone()>
            <td>{row.buyer.clone()}</td><td>{row.condition.clone()}</td><td>{locale.count(row.quantity)}</td><td>{locale.money(row.price_minor)}</td>
        </tr>
    }).collect_view();
    let summary = match &record.summary {
        Some(s) => view! {
            <span><strong>{locale.money(s.lowest_minor)}</strong>" "{locale.text("lowest")}</span>
            <span>{locale.listing_count(s.count)}</span>
            <span>{locale.count(s.quantity)}" "{locale.text("available")}</span>
        }
        .into_any(),
        None => view! { <span>{locale.text("no_listings")}</span> }.into_any(),
    };
    let contents = [("marketplace__contents", "contents", &record.contents), ("marketplace__included", "included", &record.included_in)]
        .into_iter().map(|(class, key, lines)| view! {
            <section class=class>
                <h2>{locale.text(key)}</h2>
                <ul>{lines.iter().map(|line| view! {
                    <li><a href=locale.href(&line.item_id) rel="external">{line.title.clone()}</a>" \u{d7} "{locale.count(line.quantity)}</li>
                }).collect_view()}</ul>
            </section>
        }).collect_view();
    view! {
        <Title text=format!("{title} | Card Market")/>
        <article class="marketplace">
            <nav class="marketplace__categories">
                {record.categories.iter().map(|c| view! { <a href=locale.href("item_1") rel="external">{c.name.clone()}</a> }).collect_view()}
            </nav>
            <h1>{title}</h1>
            {record.subtitle.clone().map(|s| view! { <p class="marketplace__subtitle">{s}</p> })}
            <ul class="marketplace__badges">{record.badges.iter().map(|b| view! { <li>{b.clone()}</li> }).collect_view()}</ul>
            <div class="marketplace__images">
                {record.images.iter().enumerate().map(|(i, url)| view! {
                    <div class="marketplace__image" role="img" aria-label=format!("{} {}", record.title, i+1) data-src=url.clone()></div>
                }).collect_view()}
            </div>
            <section class="marketplace__summary">{summary}</section>
            <section class="marketplace__listings">
                <h2>{locale.text("listings")}</h2>
                <form method="get" action=locale.href(&record.id)>
                    <label>{locale.text("filter")}<input type="text" name="seller" value=query.seller.clone()/></label>
                    <label>
                        {locale.text("sort")}
                        <select name="sort">
                            <option value="asc" selected=!query.descending()>{locale.text("asc")}</option>
                            <option value="desc" selected=query.descending()>{locale.text("desc")}</option>
                        </select>
                    </label>
                    {query.all().then(|| view! { <input type="hidden" name="offers" value="all"/> })}
                    <button type="submit">{locale.text("apply")}</button>
                </form>
                <table>
                    <thead><tr>{["seller","condition","ships_from","qty","price","reviews"].map(|k| view! { <th>{locale.text(k)}</th> }).collect_view()}</tr></thead>
                    <tbody>{listings}</tbody>
                </table>
            </section>
            <section class="marketplace__offers">
                <h2>{locale.text("offers")}</h2>
                <table>
                    <thead><tr>{["buyer","condition","qty","price"].map(|k| view! { <th>{locale.text(k)}</th> }).collect_view()}</tr></thead>
                    <tbody>{offers}</tbody>
                </table>
                {more}
            </section>
            <section class="marketplace__alert">
                <h2>{locale.text("alert")}</h2>
                <form method="post" action=query_href(locale, &record.id, &query)>
                    <label>{locale.text("email")}<input type="email" name="email" required/></label>
                    <label>{locale.text("target")}<input type="text" name="target_price" inputmode="decimal" required/></label>
                    <button type="submit">{locale.text("submit")}</button>
                </form>
                <p class="marketplace__message" aria-live="polite">{message}</p>
            </section>
            <section class="marketplace__details">
                <h2>{locale.text("details")}</h2><p>{record.description.clone()}</p>
                <dl>{record.fields.iter().map(|f| view! { <dt>{f.name.clone()}</dt><dd>{f.value.clone()}</dd> }).collect_view()}</dl>
                <ul>{record.tags.iter().map(|tag| view! { <li>{tag.clone()}</li> }).collect_view()}</ul>
            </section>
            {contents}
        </article>
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
#[cfg(all(test, feature = "ssr"))]
mod tests {
    use super::*;
    #[test]
    fn rich_leptos_component_renders_only_visible_rows_and_escapes_data() {
        let record: Record = serde_json::from_str(include_str!("../tests/marketplace.json")).unwrap();
        for tag in ["en-US", "fr-FR", "de-DE"] {
            let record = Arc::new(record.clone());
            let locale = Locale::parse(tag).unwrap();
            let html = Owner::new().with(|| {
                leptos_meta::provide_meta_context();
                view! { <MarketplaceDetail record locale query=Query::default() message="<script>bad</script>".to_string()/> }
                    .to_html()
            });
            assert!(html.contains("Ember &lt;dragon&gt; &amp;"));
            assert!(html.contains("&lt;script&gt;bad&lt;/script&gt;"));
            assert_eq!(html.matches("data-listing-id=").count(), 4);
            assert_eq!(html.matches("data-offer-id=").count(), 5);
            assert!(html.contains(&format!("/marketplace/{tag}/item_2")));
        }
    }
}
