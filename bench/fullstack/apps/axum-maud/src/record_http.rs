use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::time::Duration;

/// How long a connection to the catalog or marketplace upstream may sit idle in the pool before a
/// request opens a new one instead. Both fixtures (`bench/catalog/upstream.mjs`,
/// `bench/marketplace/upstream.mjs`, on Node 26) answer with `Keep-Alive: timeout=5` and close a
/// connection idle for their 5 s keep-alive timeout plus Node's 1 s buffer. A request written to a
/// pooled connection as the fixture closes it fails in the send (reqwest keeps an idle connection
/// for 90 s unless told otherwise), so the pool drops a connection a second before the shortest
/// time the fixtures advertise. It is not a retry: each record is still one upstream GET.
pub const UPSTREAM_IDLE: Duration = Duration::from_secs(4);

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .pool_idle_timeout(UPSTREAM_IDLE)
        .build()
        .expect("record HTTP client")
}

pub fn problem(status: StatusCode) -> Response {
    #[derive(Serialize)]
    struct Problem {
        title: &'static str,
        status: u16,
    }
    (
        status,
        [(header::CONTENT_TYPE, "application/problem+json")],
        Json(Problem { title: status.canonical_reason().unwrap_or("Error"), status: status.as_u16() }),
    )
        .into_response()
}
