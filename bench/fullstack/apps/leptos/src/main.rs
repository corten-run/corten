#[cfg(feature = "ssr")]
#[tokio::main]
async fn main() {
    use axum::{
        http::{header, HeaderValue},
        Router,
    };
    use item_page_leptos::app::{shell, App};
    use leptos::prelude::*;
    use leptos_axum::{generate_route_list, LeptosRoutes};
    use tower_http::{compression::CompressionLayer, set_header::SetResponseHeaderLayer};

    let conf = get_configuration(None).expect("leptos configuration");
    // Load the fixture (if any) before listening, like the other apps.
    item_page_leptos::app::warm_fixture();
    item_page_leptos::catalog::source::init();
    item_page_leptos::marketplace::source::init();
    let leptos_options = conf.leptos_options;
    let addr = leptos_options.site_addr;
    let routes = generate_route_list(App);
    let app = Router::new()
        .route("/api/items/{id}", axum::routing::get(item_page_leptos::app::item_json))
        .route("/api/catalog/{id}", axum::routing::get(item_page_leptos::catalog_page::catalog_json))
        .route("/api/marketplace/{id}", axum::routing::get(item_page_leptos::marketplace_page::marketplace_json))
        .route("/marketplace/{locale}/{id}", axum::routing::post(item_page_leptos::marketplace_page::marketplace_post))
        .merge(live::routes())
        .leptos_routes(&leptos_options, routes, {
            let options = leptos_options.clone();
            move || shell(options.clone())
        });
    // The profile's cache policy is the pages' and the JSON's, not the static files' (the fallback
    // serves those).
    let app = if item_page_leptos::app::matched() {
        app.route_layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-cache"),
        ))
    } else {
        app
    };
    let app = app.fallback(leptos_axum::file_and_error_handler(shell)).layer(CompressionLayer::new()).with_state(leptos_options);
    let app = if item_page_leptos::app::matched() { profile_layers(app) } else { app };
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("leptos item page listening on {addr}");
    axum::serve(listener, app.into_make_service()).await.expect("serve");
}

/// The rest of the matched tier's production profile, as far as tower-http's layers go, as
/// axum-maud adds it: the security headers on every answer (a page's CSP is the shell's, with
/// Leptos's nonce; this one is for the rest), a 503 past a 10 second deadline (card-market's), and
/// request bodies of at most 2 MiB.
#[cfg(feature = "ssr")]
fn profile_layers(router: axum::Router) -> axum::Router {
    use std::time::Duration;

    use axum::http::{header, HeaderName, HeaderValue, StatusCode};
    use tower_http::{limit::RequestBodyLimitLayer, set_header::SetResponseHeaderLayer, timeout::TimeoutLayer};

    let header =
        |name: HeaderName, value: &'static str| SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value));
    router
        .layer(TimeoutLayer::with_status_code(StatusCode::SERVICE_UNAVAILABLE, Duration::from_secs(10)))
        .layer(RequestBodyLimitLayer::new(2 * 1024 * 1024))
        .layer(header(header::CONTENT_SECURITY_POLICY, item_page_leptos::app::CSP_REST))
        .layer(header(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(header(header::REFERRER_POLICY, "strict-origin-when-cross-origin"))
        .layer(header(header::X_FRAME_OPTIONS, "DENY"))
        .layer(header(HeaderName::from_static("cross-origin-opener-policy"), "same-origin"))
        .layer(header(
            HeaderName::from_static("permissions-policy"),
            "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
        ))
}

#[cfg(not(feature = "ssr"))]
pub fn main() {}

/// The live benchmark (bench/live): `GET /live/prices` is a server-sent event stream and every
/// `POST /live/publish` body goes to each open stream, through a tokio broadcast channel.
#[cfg(feature = "ssr")]
mod live {
    use std::{convert::Infallible, sync::LazyLock};

    use axum::{
        http::StatusCode,
        response::sse::{Event, KeepAlive, Sse},
        routing::{get, post},
        Router,
    };
    use futures::Stream;
    use tokio::sync::broadcast::{self, error::RecvError};

    static PRICES: LazyLock<broadcast::Sender<String>> = LazyLock::new(|| broadcast::channel(1024).0);

    pub fn routes<S: Clone + Send + Sync + 'static>() -> Router<S> {
        Router::new().route("/live/prices", get(prices)).route("/live/publish", post(publish))
    }

    async fn prices() -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
        let stream = futures::stream::unfold(PRICES.subscribe(), |mut rx| async move {
            loop {
                match rx.recv().await {
                    Ok(data) => return Some((Ok(Event::default().data(data)), rx)),
                    // A slow client skips what it missed rather than holding the others back.
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        });
        Sse::new(stream).keep_alive(KeepAlive::default())
    }

    async fn publish(body: String) -> StatusCode {
        let _ = PRICES.send(body);
        StatusCode::NO_CONTENT
    }
}
