//! What the prototype does, through its public API as an app would use it.

use std::time::Duration;

use bytes::Bytes;
use http::{HeaderValue, Method, StatusCode, header};
use http_body_util::BodyExt;
use pipeline::{
    Body, Endpoint, Failure, Json, Params, Request, Response, Router, Stages, get, handler,
    handler::State,
    stages::{Cancel, Deadline, Errors, Host, Secure, Share, Signal},
};

async fn send<E: Endpoint<()>>(
    app: &E,
    method: Method,
    path: &str,
    headers: &[(&'static str, &'static str)],
) -> (StatusCode, http::HeaderMap, String) {
    let mut req = Request::new(Body::empty());
    *req.method_mut() = method;
    *req.uri_mut() = path.parse().unwrap();
    for (name, value) in headers {
        req.headers_mut().insert(*name, HeaderValue::from_static(value));
    }
    let res = app.call(req, ()).await;
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (parts.status, parts.headers, String::from_utf8(bytes.to_vec()).unwrap())
}

/// The lowest level: an endpoint written by hand, the raw response out, nothing around it.
struct Pong;

impl<Cx: Send + 'static> Endpoint<Cx> for Pong {
    fn call(&self, _: Request, _: Cx) -> impl std::future::Future<Output = Response> + Send + '_ {
        let mut res = Response::new(Body::from("pong"));
        res.headers_mut().insert("x-raw", HeaderValue::from_static("1"));
        std::future::ready(res)
    }
}

#[derive(serde::Serialize)]
struct Item {
    id: u32,
    name: &'static str,
}

#[derive(Clone)]
struct Db(&'static str);

async fn item(params: Params, State(db): State<Db>) -> Result<Json<Item>, Failure> {
    let id: u32 = params.parse("id")?;
    if id == 0 {
        return Err(Failure::not_found().detail("no item 0"));
    }
    Ok(Json(Item { id, name: db.0 }))
}

/// A raw handler: the request as it came in, the raw response out.
async fn echo(req: Request) -> Response {
    let length = req.headers().get(header::CONTENT_LENGTH).cloned();
    let body = req.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
    let mut res = Response::new(Body::from(body));
    if let Some(length) = length {
        res.headers_mut().insert("x-length", length);
    }
    res
}

async fn slow(signal: Signal) -> &'static str {
    tokio::time::sleep(Duration::from_secs(60)).await;
    let _ = signal;
    "late"
}

async fn boom() -> &'static str {
    panic!("the handler broke")
}

#[tokio::test]
async fn an_endpoint_written_by_hand_is_served_with_nothing_around_it() {
    let (status, headers, body) = send(&Pong, Method::GET, "/anything", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "pong"));
    assert_eq!(headers.get("x-raw").unwrap(), "1");
    assert!(headers.get(header::CONTENT_SECURITY_POLICY).is_none(), "no stage: no headers of the framework's");
}

#[tokio::test]
async fn a_fast_route_and_a_secured_one_sit_side_by_side() {
    // The secured route's stages are the API defaults; the fast route has none, and the raw
    // handler beside it reads and writes the raw HTTP types.
    let api = Stages::api().with(Share(Db("Black Lotus")));
    let app = Router::new()
        .route("/ping", get(Pong))
        .route("/echo", pipeline::post(echo))
        .route("/items/{id}", get(api.serve(handler(item))));

    let (status, headers, body) = send(&app, Method::GET, "/ping", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "pong"));
    assert!(headers.get(header::CONTENT_SECURITY_POLICY).is_none());

    let (status, headers, body) = send(&app, Method::GET, "/items/7", &[]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, r#"{"id":7,"name":"Black Lotus"}"#);
    assert_eq!(headers.get(header::CONTENT_SECURITY_POLICY).unwrap(), "default-src 'none'; frame-ancestors 'none'");
    assert_eq!(headers.get(header::X_CONTENT_TYPE_OPTIONS).unwrap(), "nosniff");
    assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "private, no-cache");

    // The route's failure is described by its stages; the router's own 404 has none around it.
    let (status, headers, body) = send(&app, Method::GET, "/items/0", &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "application/problem+json");
    assert_eq!(body, r#"{"title":"Not Found","status":404}"#);
    let (status, _, body) = send(&app, Method::GET, "/nowhere", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::NOT_FOUND, ""));
}

#[tokio::test]
async fn the_whole_app_can_be_inside_the_defaults_with_a_raw_route_in_it() {
    let app = Stages::api().with(Share(Db("Mox"))).serve(Router::new().route("/items/{id}", get(item)).route(
        "/raw",
        get(|req: Request| async move {
            let mut res = Response::new(Body::from(req.uri().path().to_string()));
            *res.status_mut() = StatusCode::IM_A_TEAPOT;
            res
        }),
    ));
    let (status, _, body) = send(&app, Method::GET, "/items/3", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, r#"{"id":3,"name":"Mox"}"#));

    // A raw answer is sent as written, with the defaults' headers added around it.
    let (status, headers, body) = send(&app, Method::GET, "/raw", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::IM_A_TEAPOT, "/raw"));
    assert_eq!(headers.get(header::X_FRAME_OPTIONS).unwrap(), "DENY");

    // Failures from the router are described too, and keep their `Allow`.
    let (status, headers, body) = send(&app, Method::POST, "/items/3", &[]).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(headers.get(header::ALLOW).unwrap(), "GET, HEAD");
    assert_eq!(body, r#"{"title":"Method Not Allowed","status":405}"#);
    let (status, _, body) = send(&app, Method::GET, "/nowhere", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::NOT_FOUND, r#"{"title":"Not Found","status":404}"#));

    // HEAD answers as GET does, without the body.
    let (status, headers, body) = send(&app, Method::HEAD, "/items/3", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, ""));
    assert_eq!(headers.get(header::CONTENT_LENGTH).unwrap(), "21");
}

#[tokio::test]
async fn the_host_and_same_origin_checks_refuse_before_the_app_runs() {
    let app = Stages::api().with(Share(Db("Mox"))).serve(Router::new().route("/items/{id}", get(item).post(item)));
    let (status, headers, body) = send(&app, Method::GET, "/items/1", &[("host", "evil.example")]).await;
    assert_eq!((status, body.as_str()), (StatusCode::MISDIRECTED_REQUEST, ""));
    assert!(headers.get(header::CONTENT_SECURITY_POLICY).is_some(), "a refusal still gets the security headers");
    for host in ["localhost:3000", "app.localhost", "127.0.0.1:8080", "[::1]:3000"] {
        let req = [("host", host)];
        let leaked: &'static [(&'static str, &'static str)] = Box::leak(Box::new(req));
        assert_eq!(send(&app, Method::GET, "/items/1", leaked).await.0, StatusCode::OK, "{host}");
    }
    let listed = Stages::new().with(Host::loopback().name(".shop.example")).serve(Pong);
    assert_eq!(send(&listed, Method::GET, "/", &[("host", "eu.shop.example")]).await.0, StatusCode::OK);
    assert_eq!(send(&listed, Method::GET, "/", &[("host", "shop.example.evil")]).await.0, StatusCode::MISDIRECTED_REQUEST);

    let cross = [("host", "localhost:3000"), ("origin", "https://evil.example")];
    let (status, _, body) = send(&app, Method::POST, "/items/1", &cross).await;
    assert_eq!((status, body.as_str()), (StatusCode::FORBIDDEN, r#"{"title":"Forbidden","status":403}"#));
    let same = [("host", "localhost:3000"), ("origin", "http://localhost:3000")];
    assert_eq!(send(&app, Method::POST, "/items/1", &same).await.0, StatusCode::OK);
    let fetch = [("sec-fetch-site", "cross-site")];
    assert_eq!(send(&app, Method::POST, "/items/1", &fetch).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test(start_paused = true)]
async fn past_its_deadline_a_request_answers_503_and_its_signal_aborts() {
    let app = Stages::new()
        .with(Errors::json().dev(true))
        .with(Cancel)
        .with(Deadline::new(Duration::from_secs(2)))
        .serve(Router::new().route("/slow", get(slow)));
    let (status, _, body) = send(&app, Method::GET, "/slow", &[]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body, r#"{"title":"Service Unavailable","status":503,"detail":"past its deadline"}"#);
}

#[tokio::test]
async fn a_signal_aborts_when_the_answer_is_sent_or_the_client_leaves() {
    use pipeline::stages::Abort;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(None::<Signal>));
    let keep = seen.clone();
    let app = Stages::new().with(Cancel).serve(Router::new().route(
        "/",
        get(move |signal: Signal| {
            let keep = keep.clone();
            async move {
                *keep.lock().unwrap() = Some(signal);
                "ok"
            }
        }),
    ));
    send(&app, Method::GET, "/", &[]).await;
    assert_eq!(seen.lock().unwrap().as_ref().unwrap().reason(), Some(Abort::Responded));

    let left = std::sync::Arc::new(std::sync::Mutex::new(None::<Signal>));
    let keep = left.clone();
    let waiting = Stages::new().with(Cancel).serve(Router::new().route(
        "/slow",
        get(move |signal: Signal| {
            *keep.lock().unwrap() = Some(signal);
            std::future::pending::<&'static str>()
        }),
    ));
    let mut req = Request::new(Body::empty());
    *req.uri_mut() = "/slow".parse().unwrap();
    // Polled once, then dropped, as when the client goes away.
    let mut answer = Box::pin(waiting.call(req, ()));
    assert!(futures_poll_once(answer.as_mut()).await.is_none());
    let signal = left.lock().unwrap().clone().unwrap();
    assert_eq!(signal.reason(), None, "still running");
    drop(answer);
    assert_eq!(signal.reason(), Some(Abort::Disconnected));
}
async fn futures_poll_once<F: std::future::Future + Unpin>(mut fut: F) -> Option<F::Output> {
    std::future::poll_fn(|cx| {
        std::task::Poll::Ready(match std::pin::Pin::new(&mut fut).poll(cx) {
            std::task::Poll::Ready(out) => Some(out),
            std::task::Poll::Pending => None,
        })
    })
    .await
}

#[tokio::test]
async fn a_panic_answers_500_with_its_detail_only_for_a_developer() {
    let app = Stages::api().serve(Router::new().route("/boom", get(boom)));
    let (status, _, body) = send(&app, Method::GET, "/boom", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::INTERNAL_SERVER_ERROR, r#"{"title":"Internal Server Error","status":500}"#));
}

#[tokio::test]
async fn a_body_is_read_as_json_and_refused_in_the_failures_shape() {
    #[derive(serde::Deserialize)]
    struct Alert {
        price: u32,
    }
    async fn alert(Json(alert): Json<Alert>) -> String {
        format!("at {}", alert.price)
    }
    let app = Stages::api().serve(Router::new().route("/alerts", pipeline::post(alert)));
    let mut req = Request::new(Body::from(Bytes::from_static(br#"{"price":5}"#)));
    *req.method_mut() = Method::POST;
    *req.uri_mut() = "/alerts".parse().unwrap();
    req.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let res = app.call(req, ()).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.into_body().collect().await.unwrap().to_bytes(), "at 5");

    let (status, _, body) = send(&app, Method::POST, "/alerts", &[("content-type", "text/plain")]).await;
    assert_eq!(
        (status, body.as_str()),
        (StatusCode::UNSUPPORTED_MEDIA_TYPE, r#"{"title":"Unsupported Media Type","status":415}"#)
    );
}

#[tokio::test]
async fn an_app_can_build_its_own_order_and_describe_failures_its_own_way() {
    fn page(failure: &Failure, _dev: bool) -> Response {
        let mut res = Response::new(Body::from(format!("<h1>{}</h1>", failure.status().as_u16())));
        res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
        res
    }
    let app =
        Stages::new().with(Secure::page()).with(Errors::with(page)).serve(Router::new().route("/", get(|| async { "home" })));
    let (status, headers, body) = send(&app, Method::GET, "/missing", &[]).await;
    assert_eq!((status, body.as_str()), (StatusCode::NOT_FOUND, "<h1>404</h1>"));
    assert!(headers.get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap().starts_with("default-src 'self'"));
}
