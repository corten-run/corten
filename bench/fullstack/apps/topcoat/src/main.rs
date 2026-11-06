//! Corten's card-market pages in Topcoat: the home page, the item page and the 404 page, with the
//! same markup and stylesheets, and the item as JSON. The listings' sort and the offers' "show
//! all" are shards (rendered again on the server when their signal changes), the price alert a
//! procedure, and links between pages Topcoat's client navigation.
mod items;
mod model;

use std::sync::{Arc, LazyLock};

use futures_util::Stream;
use tokio::sync::broadcast::{self, error::RecvError};
use topcoat::{
    Result,
    asset::{Asset, AssetBundle, RouterBuilderAssetExt, asset},
    context::Cx,
    router::{
        Router, StatusCode,
        content::{
            Form, Json,
            sse::{Event as SseEvent, KeepAlive, Sse},
        },
        error::not_found as not_found_error,
        href, page, path_param, request, route,
    },
    runtime::{Event, RouterBuilderRuntimeExt, link, procedure, shard, signal},
    view::{Child, View, ViewExt, attributes, component, view},
};

use crate::model::{ContentLine, ItemView, alert_message, sort_listings};

const STYLE: Asset = asset!("static/style.css");
const COMPONENTS: Asset = asset!("static/components.css");
const READY: Asset = asset!("static/ready.js");

#[tokio::main]
async fn main() {
    // Load the fixture (if any) and read API_BASE before listening, like the other apps.
    items::init();
    topcoat::start(router()).await.unwrap();
}

fn router() -> Router {
    Router::builder()
        .page(home)
        .page(item_page)
        .page(not_found)
        .route(item_json)
        .route(listings)
        .route(offers)
        .route(create_alert)
        .route(live_prices)
        .route(live_publish)
        .assets(AssetBundle::load().expect("asset bundle next to the binary (topcoat asset bundle)"))
        .runtime()
        .build()
}

/// The document every page shares, as card-market's layout writes it.
#[component]
async fn document(#[into] title: String, #[default] child: Child<'_>) -> Result<impl View> {
    Ok(view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>(title)</title>
                <link rel="stylesheet" href=(STYLE)>
                <link rel="stylesheet" href=(COMPONENTS)>
                topcoat::runtime::script()
                // After the runtime's module, so it runs once the page is interactive.
                <script type="module" src=(READY)></script>
            </head>
            <body>
                <header class="site-header__bar">link(href: href!(home), "Card Market")</header>
                <main>(child)</main>
            </body>
        </html>
    })
}

#[page("/")]
async fn home() -> Result<impl View> {
    let shelf = items::shelf();
    Ok(view! {
        document(
            title: "Popular items | Card Market",
            <h1>"Popular items"</h1>
            if shelf.is_empty() {
                <ul class="item-list__list item-list__ids">
                    for n in 1..=50usize {
                        <li>link(href: href!(item_page, Id(format!("item_{n}"))), "Item " (n))</li>
                    }
                </ul>
            } else {
                <ul class="item-list__list">
                    for item in shelf {
                        <li>
                            link(
                                href: href!(item_page, Id(item.id.as_str())),
                                attrs: attributes! { class="item-card__card" },
                                <strong>(&item.title)</strong>
                                if let Some(subtitle) = &item.subtitle {
                                    <span class="item-card__set">(subtitle)</span>
                                }
                                match &item.summary {
                                    Some(summary) => <span class="item-card__from">
                                        "From "
                                        (summary.lowest.as_deref().unwrap_or("—"))
                                    </span>,
                                    None => <span class="item-card__from">"No listings yet"</span>,
                                }
                            )
                        </li>
                    }
                </ul>
            }
        )
    })
}

/// The price alert form's fields, for a submission without JavaScript.
#[derive(serde::Deserialize)]
struct AlertForm {
    title: Option<String>,
    email: Option<String>,
    target_price: Option<String>,
    /// `all` after "Show all" without JavaScript (a GET form).
    offers: Option<String>,
}

path_param!(id);

#[page([GET, POST] "/items/{id}")]
async fn item_page(cx: &Cx, Form(form): Form<AlertForm>) -> Result<impl View> {
    let id: &str = path_param::<Id>(cx);
    let Some(item) = items::get(cx, id).await? else {
        return Ok(view! { missing() }.boxed());
    };
    // Without JavaScript the form posts here and the page comes back with the message. A GET's
    // query is not a submission, so a link cannot make the page say it.
    let all_offers = form.offers.as_deref() == Some("all");
    let posted = match (request::method(cx).as_str(), form.title, form.email, form.target_price) {
        ("POST", Some(title), Some(email), Some(target)) => alert_message(&title, &email, &target),
        _ => String::new(),
    };
    let message = signal(cx, move || posted);
    let email = signal(cx, String::new);
    let target = signal(cx, String::new);
    let title = item.title.clone();
    Ok(view! {
        document(
            title: format!("{} | Card Market", item.title),
            <article>
                <div class="item-detail__top">
                    <div class="item-detail__intro">
                        <nav class="item-detail__crumbs">
                            for c in &item.categories {
                                <a href=(("/categories/", &c.slug))>(&c.name)</a>
                            }
                        </nav>
                        <h1>(&item.title)</h1>
                        if let Some(subtitle) = &item.subtitle {
                            <p class="item-detail__subtitle">(subtitle)</p>
                        }
                        <ul class="item-detail__chips">
                            for badge in &item.badges {
                                <li>(badge)</li>
                            }
                        </ul>
                    </div>
                    if !item.images.is_empty() {
                        <div class="item-detail__gallery">
                            for (i, url) in item.images.iter().enumerate() {
                                <div
                                    class="item-detail__image"
                                    role="img"
                                    aria-label=((&item.title, " image ", i + 1))
                                    data-src=(url)
                                ></div>
                            }
                        </div>
                    }
                    <section class="item-detail__panel item-detail__summary gap-3 sm:gap-5">
                        match &item.summary {
                            Some(s) => {
                                <span><strong>(s.lowest.as_deref().unwrap_or("—"))</strong>" lowest"</span>
                                <span>(counted(s.count, "listing", "listings"))</span>
                                <span>(counted(s.quantity, "available", "available"))</span>
                            }
                            None => <span>"No listings yet"</span>,
                        }
                    </section>
                </div>
                <section class="item-detail__panel">listings(id: item.id.clone())</section>
                <section class="item-detail__panel">offers(id: item.id.clone(), all: all_offers)</section>
                <section class="item-detail__panel">
                    <h2>"Price alert"</h2>
                    <div class="alert-form__form">
                        <form
                            method="post"
                            @submit=$(async |e: Event| {
                                e.prevent_default();
                                let answer = create_alert(title, email.get(), target.get()).await;
                                message.set(answer);
                            })
                        >
                            <input type="hidden" name="title" value=(&item.title)>
                            <label>
                                "Email"
                                <input
                                    type="email"
                                    name="email"
                                    required=(true)
                                    @input=$(|e: Event| email.set(e.target.value))
                                >
                            </label>
                            <label>
                                "Alert me below"
                                <input
                                    type="text"
                                    name="target_price"
                                    inputmode="decimal"
                                    required=(true)
                                    @input=$(|e: Event| target.set(e.target.value))
                                >
                            </label>
                            <button type="submit">"Set alert"</button>
                        </form>
                    </div>
                    <p class="alert-form__message" id="alert-message" aria-live="polite">$(message.get())</p>
                </section>
                <section class="item-detail__panel">
                    <h2>"Details"</h2>
                    <p>(&item.description)</p>
                    <dl>
                        for f in &item.fields {
                            <dt>(&f.name)</dt>
                            <dd>(&f.value)</dd>
                        }
                    </dl>
                    if !item.tags.is_empty() {
                        <ul class="item-detail__chips">
                            for tag in &item.tags {
                                <li>(tag)</li>
                            }
                        </ul>
                    }
                </section>
                if !item.contents.is_empty() {
                    content_list(title: "Contents", lines: &item.contents)
                }
                if !item.included_in.is_empty() {
                    content_list(title: "Included in", lines: &item.included_in)
                }
            </article>
        )
    }
    .boxed())
}

/// The listings, cheapest first; the button renders them again on the server in the other order.
#[shard("/shards/listings")]
async fn listings(cx: &Cx, id: String) -> Result<impl View> {
    let descending = signal(cx, || false);
    let item = items::get(cx, &id).await?.ok_or_else(not_found_error)?;
    let down = descending.get();
    Ok(view! {
        <h2>"Listings"</h2>
        <button type="button" @click=$(|_e| descending.toggle())>
            <span hidden=(down)>"Price: low to high"</span>
            <span hidden=(!down)>"Price: high to low"</span>
        </button>
        <table>
            <thead>
                <tr><th>"Seller"</th><th>"Condition"</th><th>"Ships from"</th><th>"Qty"</th><th>"Price"</th></tr>
            </thead>
            <tbody>
                for l in sort_listings(&item.listings, down) {
                    <tr>
                        <td>
                            (&l.seller)
                            if let Some(rating) = &l.rating {
                                " · " (rating) " ★ (" (l.reviews) ")"
                            }
                        </td>
                        <td>(&l.condition)</td>
                        <td>(&l.ships_from)</td>
                        <td>(l.quantity)</td>
                        <td class="price__amount">(&l.price)</td>
                    </tr>
                }
            </tbody>
        </table>
    })
}

/// The first five offers; "Show all" renders the shard again on the server with every offer.
#[shard("/shards/offers")]
async fn offers(cx: &Cx, id: String, all: bool) -> Result<impl View> {
    let all = signal(cx, move || all);
    let item = items::get(cx, &id).await?.ok_or_else(not_found_error)?;
    let total = item.offers.len();
    let shown = if all.get() { total } else { total.min(5) };
    Ok(view! {
        <h2>"Offers"</h2>
        <table>
            <thead>
                <tr><th>"Buyer"</th><th>"Condition"</th><th>"Qty"</th><th>"Price"</th></tr>
            </thead>
            <tbody>
                for o in &item.offers[..shown] {
                    <tr>
                        <td>(&o.buyer)</td>
                        <td>(&o.condition)</td>
                        <td>(o.quantity)</td>
                        <td class="price__amount">(&o.price)</td>
                    </tr>
                }
            </tbody>
        </table>
        if shown < total {
            <form
                method="get"
                action=(format!("/items/{id}"))
                @submit=$(|e: Event| {
                    e.prevent_default();
                    all.set(true);
                })
            >
                <button name="offers" value="all">"Show all " (total) " offers"</button>
            </form>
        }
    })
}

/// The price alert: checked and answered on the server, the message shown by the page.
#[procedure("/alerts")]
async fn create_alert(title: String, email: String, target_price: String) -> Result<String> {
    Ok(alert_message(&title, &email, &target_price))
}

#[component]
async fn content_list(title: &str, lines: &[ContentLine]) -> Result<impl View> {
    Ok(view! {
        <section class="item-detail__panel">
            <h2>(title)</h2>
            <ul>
                for c in lines {
                    <li>link(href: href!(item_page, Id(c.item_id.as_str())), (&c.title)) " × " (c.quantity)</li>
                }
            </ul>
        </section>
    })
}

/// Corten's 404 page, for a missing item and for any address no other page serves.
#[component]
async fn missing() -> Result<impl View> {
    Ok(view! {
        (StatusCode::NOT_FOUND)
        document(
            title: "Not found | Card Market",
            <h1>"Not found"</h1>
            <p>"There is no card at this address."</p>
            <p>link(href: href!(home), "Go to popular items")</p>
        )
    })
}

path_param!(*rest);

#[page("/{*rest}")]
async fn not_found() -> Result<impl View> {
    Ok(view! { missing() })
}

/// `GET /api/items/{id}`: the item as JSON for other services, the same data the page renders.
#[route(GET "/api/items/{id}")]
async fn item_json(cx: &Cx) -> Result<Json<Arc<ItemView>>> {
    let item = items::shared(cx, path_param::<Id>(cx)).await?.ok_or_else(not_found_error)?;
    Ok(Json(item))
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

/// The live benchmark (bench/live): `GET /live/prices` is a server-sent event stream and every
/// `POST /live/publish` body goes to each open stream, through a tokio broadcast channel.
static PRICES: LazyLock<broadcast::Sender<String>> = LazyLock::new(|| broadcast::channel(1024).0);

#[route(GET "/live/prices")]
async fn live_prices() -> Result<Sse<impl Stream<Item = Result<SseEvent>> + use<>>> {
    let stream = futures_util::stream::unfold(PRICES.subscribe(), |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(data) => return Some((Ok(SseEvent::new().data(data)), rx)),
                // A slow client skips what it missed rather than holding the others back.
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new()))
}

#[route(POST "/live/publish")]
async fn live_publish(body: String) -> Result<StatusCode> {
    let _ = PRICES.send(body);
    Ok(StatusCode::NO_CONTENT)
}
