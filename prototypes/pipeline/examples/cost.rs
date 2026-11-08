//! One request shape through many pipelines, for callgrind: `cost <variant> <requests>` sends that
//! many `GET /api/items/7` requests in process, one at a time, and checks each answer. Counting
//! a run of 1,200 and one of 200 and taking the difference over 1,000 gives one request's
//! instructions with startup left out (CONTRIBUTING.md, Pull requests, 2.1).
//!
//! Every variant does the same work in its handler: read the id from the path, write the same
//! item as JSON with serde_json, answer it as `application/json`.

use std::time::Duration;

use http::{HeaderValue, StatusCode, header};
use http_body_util::BodyExt;
use pipeline::{
    Body, Endpoint, Params, Request, Response, Router, Stages, get, handler,
    stages::{Cache, Cancel, CatchPanic, Deadline, Errors, Host, SameOrigin, Secure, Signal, experiment},
};

#[derive(serde::Serialize)]
struct Item {
    id: u32,
    name: &'static str,
    price_cents: u64,
}

fn item_json(id: u32) -> Vec<u8> {
    serde_json::to_vec(&Item { id, name: "Black Lotus", price_cents: 2_500_000 }).unwrap()
}

const EXPECTED: &[u8] = br#"{"id":7,"name":"Black Lotus","price_cents":2500000}"#;

fn json(bytes: Vec<u8>) -> Response {
    let mut res = Response::new(Body::from(bytes));
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

/// The same answer with room in its header map for the stages' headers, so adding them does not
/// grow it.
fn json_presized(bytes: Vec<u8>) -> Response {
    let mut res = Response::new(Body::from(bytes));
    *res.headers_mut() = http::HeaderMap::with_capacity(12);
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

async fn item_presized(params: Params) -> Result<Response, pipeline::Failure> {
    let id: u32 = params.parse("id")?;
    Ok(json_presized(item_json(id)))
}

/// The handler every prototype variant serves.
async fn item(params: Params) -> Result<Response, pipeline::Failure> {
    let id: u32 = params.parse("id")?;
    Ok(json(item_json(id)))
}

/// The same handler, reading the request's signal from the typed context.
async fn item_with_signal(params: Params, signal: Signal) -> Result<Response, pipeline::Failure> {
    let id: u32 = params.parse("id")?;
    std::hint::black_box(signal.is_aborted());
    Ok(json(item_json(id)))
}

/// The same handler, reading the signal from the request's extensions.
async fn item_with_ext_signal(params: Params, signal: experiment::SignalFromExtensions) -> Result<Response, pipeline::Failure> {
    let id: u32 = params.parse("id")?;
    std::hint::black_box(signal.0.is_aborted());
    Ok(json(item_json(id)))
}

/// The lowest level: no router, no handler, the endpoint writes the answer itself.
struct Raw;

impl<Cx: Send + 'static> Endpoint<Cx> for Raw {
    fn call(&self, req: Request, _: Cx) -> impl std::future::Future<Output = Response> + Send + '_ {
        let id = req.uri().path().rsplit('/').next().and_then(|id| id.parse().ok()).unwrap_or(0);
        std::future::ready(json(item_json(id)))
    }
}

fn request() -> Request {
    let mut req = Request::new(Body::empty());
    *req.uri_mut() = http::Uri::from_static("/api/items/7");
    req.headers_mut().insert(header::HOST, HeaderValue::from_static("localhost:3000"));
    req
}

async fn check(status: StatusCode, body: impl http_body::Body<Data = bytes::Bytes, Error = impl std::fmt::Debug>) {
    let bytes = body.collect().await.unwrap().to_bytes();
    assert!(status == StatusCode::OK && bytes == EXPECTED, "{status}: {bytes:?}");
}

async fn run_prototype<E: Endpoint<()>>(app: E, n: usize) {
    for _ in 0..n {
        let res = app.call(request(), ()).await;
        let (parts, body) = res.into_parts();
        check(parts.status, body).await;
    }
}

fn routes<Cx: Send + Sync + 'static>() -> Router<Cx> {
    Router::new().route("/api/items/{id}", get(item))
}

fn axum_router() -> axum::Router {
    async fn item(axum::extract::Path(id): axum::extract::Path<u32>) -> impl axum::response::IntoResponse {
        ([(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], item_json(id))
    }
    axum::Router::new().route("/api/items/{id}", axum::routing::get(item))
}

#[corten::routes(api = ApiRoot)]
mod api {
    #[route("/api")]
    pub struct ApiRoot;

    #[route("/api/items/{id}", get = crate::corten_item)]
    pub struct ItemJson {
        pub id: u32,
    }
}

async fn corten_item(corten::Params(at): corten::Params<api::ItemJson>) -> corten::Media {
    corten::Media::new("application/json", item_json(at.id))
}

/// Corten today: the same route under `App::api`, Corten's request path for JSON.
fn corten_router() -> axum::Router {
    corten::App::new(corten::Routes::new()).api(api::api).router()
}

async fn run_tower(router: axum::Router, n: usize) {
    use tower::ServiceExt;
    for _ in 0..n {
        let mut req = axum::http::Request::new(axum::body::Body::empty());
        *req.uri_mut() = http::Uri::from_static("/api/items/7");
        req.headers_mut().insert(header::HOST, HeaderValue::from_static("localhost:3000"));
        let res = router.clone().oneshot(req).await.unwrap();
        let (parts, body) = res.into_parts();
        check(parts.status, body).await;
    }
}

const DEADLINE: Duration = Duration::from_secs(30);

fn main() {
    let mut args = std::env::args().skip(1);
    let variant = args.next().expect("cost <variant> <requests>");
    let n: usize = args.next().and_then(|n| n.parse().ok()).expect("cost <variant> <requests>");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async move {
        match variant.as_str() {
            // The floors.
            "raw" => run_prototype(Raw, n).await,
            "router" => run_prototype(routes(), n).await,
            // One stage alone around the router, each.
            "host" => run_prototype(Stages::new().with(Host::loopback()).serve(routes()), n).await,
            "same-origin" => run_prototype(Stages::new().with(SameOrigin).serve(routes()), n).await,
            "cancel" => run_prototype(Stages::new().with(Cancel).serve(routes()), n).await,
            "deadline" => run_prototype(Stages::new().with(Cancel).with(Deadline::new(DEADLINE)).serve(routes()), n).await,
            "panic" => run_prototype(Stages::new().with(CatchPanic).serve(routes()), n).await,
            "secure" => run_prototype(Stages::new().with(Secure::api()).serve(routes()), n).await,
            "cache" => run_prototype(Stages::new().with(Cache::private()).serve(routes()), n).await,
            "errors" => run_prototype(Stages::new().with(Errors::json()).serve(routes()), n).await,
            // Every default, Corten's order.
            "api" => run_prototype(Stages::api().serve(routes()), n).await,
            "secure-presized" => {
                let routes = Router::new().route("/api/items/{id}", get(item_presized));
                run_prototype(Stages::new().with(Secure::api()).serve(routes), n).await
            }
            "api-presized" => {
                let routes = Router::new().route("/api/items/{id}", get(item_presized));
                run_prototype(Stages::api().serve(routes), n).await
            }
            // The defaults on the route alone, the router outside them (a route's own stages).
            "api-on-route" => {
                let app = Router::new().route("/api/items/{id}", get(Stages::api().serve(handler(item))));
                run_prototype(app, n).await
            }
            // A value given to the handler: in the typed context, or in the request's extensions.
            "signal-cx" => {
                run_prototype(Stages::new().with(Cancel).serve(Router::new().route("/api/items/{id}", get(item_with_signal))), n)
                    .await
            }
            "signal-ext" => {
                let routes = Router::new().route("/api/items/{id}", get(item_with_ext_signal));
                run_prototype(Stages::new().with(experiment::CancelInExtensions).serve(routes), n).await
            }
            // The same request elsewhere.
            "axum" => run_tower(axum_router(), n).await,
            "corten" => run_tower(corten_router(), n).await,
            // The size of one request's future through each stack, in bytes.
            "sizes" => {
                fn size<E: Endpoint<()>>(name: &str, app: &E) {
                    let answer = app.call(request(), ());
                    println!("{name}\t{}", std::mem::size_of_val(&answer));
                }
                size("router", &routes());
                size("cancel", &Stages::new().with(Cancel).serve(routes()));
                size("secure", &Stages::new().with(Secure::api()).serve(routes()));
                size("api", &Stages::api().serve(routes()));
                let on_route: Router<()> = Router::new().route("/api/items/{id}", get(Stages::api().serve(handler(item))));
                size("api-on-route (outer)", &on_route);
                let handler_alone = handler(item);
                let mut req = request();
                let params = {
                    let probe: Router<()> = Router::new();
                    let _ = probe;
                    req.headers_mut();
                    Params::probe("/api/items/7")
                };
                let answer = Endpoint::<(Params, ())>::call(&handler_alone, req, (params.clone(), ()));
                println!("handler\t{}", std::mem::size_of_val(&answer));
                let stacked = Stages::api().serve(handler(item));
                let answer = Endpoint::<(Params, ())>::call(&stacked, request(), (params, ()));
                println!("api around the handler\t{}", std::mem::size_of_val(&answer));
            }
            other => panic!("no variant {other}"),
        }
    });
}
