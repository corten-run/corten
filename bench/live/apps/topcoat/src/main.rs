mod store;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use store::{Client, Listing, Shared, Subscription};
use topcoat::{
    Result,
    asset::{Asset, AssetBundle, RouterBuilderAssetExt, asset},
    context::{Cx, context},
    router::{
        Router, StatusCode,
        content::Json,
        error::{bad_request, too_many_requests},
        header, page, parse_query_params,
        response::{IntoResponse, Response, response_headers},
        route,
    },
    runtime::{Expr, Js, RuntimeLayer, connected, shard, signal},
    view::{View, component, emit, live, view},
};

const BRIDGE: Asset = asset!("static/bridge.js");

#[tokio::main]
async fn main() {
    let shared = Shared::default();
    shared.0.lock().unwrap().reaper_running = true;
    let reaping = shared.clone();
    let reaper = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            interval.tick().await;
            reaping.0.lock().unwrap().expire_clients(std::time::Instant::now());
        }
    });
    let result = topcoat::start(
        Router::builder()
            .with(shared)
            .page(home)
            .route(feed)
            .route(configure)
            .route(resources)
            .route(reader)
            .route(snapshot)
            .route(publish)
            .route(control)
            .route(acknowledge)
            .route(publisher_ack)
            .route(finish)
            .assets(AssetBundle::load().expect("native asset bundle beside binary"))
            .layer(RuntimeLayer::new().max_runs_per_connection(1))
            .build(),
    )
    .await;
    reaper.abort();
    let _ = reaper.await;
    result.unwrap();
}

#[page("/")]
async fn home(cx: &Cx) -> Result<impl View> {
    let client = context::<Shared>(cx).0.lock().unwrap().new_client().map_err(|_| too_many_requests(1))?;
    let active = signal(cx, || false);
    // Native reruns, including transport retries, acknowledge the emission that
    // is actually on screen before replacing it or canceling its live region.
    let observed =
        Expr::evaluate(|| String::from("0"), Js::source("document.querySelector('#native-screen')?.dataset.serial ?? '0'"));
    Ok(view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <title>"Native Topcoat live parity"</title>
                <script type="module" src=(BRIDGE)></script>
                topcoat::runtime::script()
            </head>
            <body>
                <main id="parity-app" data-client=(&client)>
                    <h1>"Native Topcoat live parity"</h1>
                    <div id="native-controls">
                        <button id="native-connect" type="button" @click=$(|_e|active.set(true))>"Connect"</button>
                        <button id="native-disconnect" type="button" @click=$(|_e|active.set(false))>"Disconnect"</button>
                    </div>
                    feed(client:client.clone(),active:$(active.get()),observed:observed)
                </main>
            </body>
        </html>
    })
}

// Native shard cancellation drops the live body and its Subscription lease.
#[shard("/parity/screen")]
async fn feed(cx: &Cx, client: String, active: bool, observed: String) -> Result<impl View> {
    let shared = context::<Shared>(cx).clone();
    let serial = observed.parse::<u64>().map_err(|_| bad_request("invalid observed emission"))?;
    let initial = {
        let mut store = shared.0.lock().unwrap();
        if serial != 0 {
            store.acknowledge(&client, serial).map_err(|_| bad_request("invalid observed emission"))?;
        }
        store.client(&client).map_err(|_| bad_request("unknown client"))?
    };
    Ok(view! {
        if active {
            (live! {
                if connected(cx) {
                    let subscription=Subscription::new(shared.clone(),&client).map_err(|_|too_many_requests(1))?;
                    loop {
                        let delivery=subscription.next().await;
                        emit! { screen(state:&delivery.state,message:delivery.message) }?;
                    }
                } else {
                    emit! { screen(state:&initial,message:json!({"kind":"waiting"})) }
                }
            })
        } else {
            screen(state:&initial,message:json!({"kind":"idle"}))
        }
    })
}

#[component]
async fn screen(cx: &Cx, state: &Client, message: Value) -> Result<impl View> {
    let diagnostic = STANDARD.encode(serde_json::to_vec(&message)?);
    Ok(view! {
        <section id="native-screen" data-through=(state.through) data-serial=(state.serial)>
            <output id="effect-count">(state.count)</output>
            <ul id="listings">
                #[key(row.id)]
                for row in &state.rows { listing(row:row) }
            </ul>
            <output id="native-message" data-message=(diagnostic) hidden=(true)></output>
        </section>
    })
}

#[component]
async fn listing(cx: &Cx, row: &Listing) -> Result<impl View> {
    Ok(view! {
        <li id=(format!("listing-row-{}", STANDARD.encode(row.id.as_bytes()))) data-key=(&row.id)>
            <span class="version">(row.version)</span>" "
            <span class="price">(row.price_cents)</span>" "
            <span class="quantity">(row.quantity)</span>
        </li>
    })
}

fn response(cx: &Cx, result: std::result::Result<Value, StatusCode>) -> Result<Response> {
    response_headers(cx).append(header::CACHE_CONTROL, "no-store".parse()?);
    match result {
        Ok(value) => Json(value).into_response(cx),
        Err(status) => {
            let mut response = Json(json!({"error":status.as_u16()})).into_response(cx)?;
            *response.status_mut() = status;
            Ok(response)
        }
    }
}
#[route(POST "/parity/configure")]
async fn configure(cx: &Cx, Json(input): Json<Value>) -> Result<Response> {
    response(cx, context::<Shared>(cx).0.lock().unwrap().configure(input))
}
#[route(GET "/parity/resources")]
async fn resources(cx: &Cx) -> Result<Response> {
    response(cx, Ok(context::<Shared>(cx).0.lock().unwrap().resources()))
}
#[route(GET "/parity/reader")]
async fn reader(cx: &Cx) -> Result<Response> {
    let query: SnapshotQuery = parse_query_params(cx)?;
    let client = query.client.ok_or_else(|| bad_request("client required"))?;
    response(cx, Ok(context::<Shared>(cx).0.lock().unwrap().reader(&client)))
}
#[derive(Deserialize)]
struct SnapshotQuery {
    client: Option<String>,
}
#[route(GET "/parity/snapshot")]
async fn snapshot(cx: &Cx) -> Result<Response> {
    let query: SnapshotQuery = parse_query_params(cx)?;
    response(cx, context::<Shared>(cx).0.lock().unwrap().snapshot(query.client.as_deref()))
}
#[route(POST "/parity/publish")]
async fn publish(cx: &Cx, Json(input): Json<Value>) -> Result<Response> {
    response(cx, context::<Shared>(cx).0.lock().unwrap().publish(input))
}
#[route(POST "/parity/control")]
async fn control(cx: &Cx, Json(input): Json<Value>) -> Result<Response> {
    response(cx, context::<Shared>(cx).0.lock().unwrap().control(input))
}
#[derive(Deserialize)]
struct Ack {
    client: String,
    serial: u64,
}
#[route(POST "/parity/acknowledge")]
async fn acknowledge(cx: &Cx, Json(input): Json<Ack>) -> Result<Response> {
    response(cx, context::<Shared>(cx).0.lock().unwrap().acknowledge(&input.client, input.serial))
}
#[derive(Deserialize)]
struct PublisherAck {
    through: u64,
}
#[route(POST "/parity/publisher-ack")]
async fn publisher_ack(cx: &Cx, Json(input): Json<PublisherAck>) -> Result<Response> {
    response(cx, context::<Shared>(cx).0.lock().unwrap().publisher_ack(input.through))
}
#[derive(Deserialize)]
struct Finish {
    client: String,
}
#[route(POST "/parity/finish")]
async fn finish(cx: &Cx, Json(input): Json<Finish>) -> Result<Response> {
    response(cx, context::<Shared>(cx).0.lock().unwrap().finish(&input.client))
}
