use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::time::Duration;

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
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
