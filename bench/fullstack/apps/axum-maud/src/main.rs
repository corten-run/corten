//! Corten's card-market pages with a router and a template macro alone: axum routes, Maud
//! templates with aspnet's markup, and htmx for the alert form, "show all" and navigation. The
//! item as JSON, and the live benchmark's stream and publisher.
mod items;
mod model;
mod pages;

use std::{convert::Infallible, sync::Arc};

use axum::{
    Form, Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use futures_util::{Stream, stream};
use maud::Markup;
use serde::Deserialize;
use tokio::sync::broadcast::{self, error::RecvError};
use tower_http::services::ServeDir;

use crate::{
    items::{ApiError, Items},
    model::{ItemView, alert_message},
};

struct App {
    items: Items,
    /// Every `POST /live/publish` body, for each open `GET /live/prices` stream.
    prices: broadcast::Sender<String>,
}

type AppState = State<Arc<App>>;

#[tokio::main]
async fn main() {
    // Load the fixture (if any) before listening, like the other apps.
    let app = Arc::new(App { items: Items::from_env(), prices: broadcast::channel(1024).0 });
    let router = Router::new()
        .route("/", get(home))
        .route("/items/{id}", get(item_page).post(create_alert))
        .route("/api/items/{id}", get(item_json))
        .route("/live/prices", get(live_prices))
        .route("/live/publish", post(live_publish))
        .nest_service("/static", ServeDir::new("static"))
        .fallback(async || not_found())
        .with_state(app);
    let port: u16 = std::env::var("PORT").map_or(8080, |p| p.parse().expect("PORT is a port number"));
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind PORT");
    axum::serve(listener, router).await.expect("server");
}

async fn home(State(app): AppState) -> Markup {
    pages::home(&app.items.shelf())
}

#[derive(Deserialize)]
struct ItemQuery {
    offers: Option<String>,
}

async fn item_page(State(app): AppState, Path(id): Path<String>, Query(query): Query<ItemQuery>) -> Result<Response, ApiError> {
    let Some(item) = app.items.get(&id).await? else { return Ok(not_found()) };
    // A GET's query is not a submission, so a link cannot make the page show a message.
    Ok(pages::item(&item, query.offers.as_deref() == Some("all"), "").into_response())
}

/// The price alert form's fields.
#[derive(Deserialize)]
struct AlertForm {
    title: Option<String>,
    email: Option<String>,
    target_price: Option<String>,
}

async fn create_alert(
    State(app): AppState,
    Path(id): Path<String>,
    headers: HeaderMap,
    Form(form): Form<AlertForm>,
) -> Result<Response, ApiError> {
    let Some(item) = app.items.get(&id).await? else { return Ok(not_found()) };
    let message = alert_message(
        form.title.as_deref().unwrap_or(""),
        form.email.as_deref().unwrap_or(""),
        form.target_price.as_deref().unwrap_or(""),
    );
    // htmx swaps only the message; without JavaScript the whole page comes back.
    if headers.contains_key("hx-request") {
        return Ok(pages::alert_message(&message).into_response());
    }
    Ok(pages::item(&item, false, &message).into_response())
}

/// `GET /api/items/{id}`: the item as JSON for other services, the same data the page renders.
async fn item_json(State(app): AppState, Path(id): Path<String>) -> Result<Response, ApiError> {
    Ok(match app.items.get(&id).await? {
        Some(item) => Json::<Arc<ItemView>>(item).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    })
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, pages::not_found()).into_response()
}

/// The live benchmark (bench/live): a server-sent event stream of every published price.
async fn live_prices(State(app): AppState) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let prices = stream::unfold(app.prices.subscribe(), |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(data) => return Some((Ok(Event::default().data(data)), rx)),
                // A slow client skips what it missed rather than holding the others back.
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(prices).keep_alive(KeepAlive::default())
}

async fn live_publish(State(app): AppState, body: String) -> StatusCode {
    // No open streams is not an error.
    let _ = app.prices.send(body);
    StatusCode::NO_CONTENT
}
