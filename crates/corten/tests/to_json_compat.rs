//! A downstream implementation of the hidden response hook accepted by 0.3.0.

#![cfg(feature = "json")]

use corten::{
    http::{Body, IntoResponse, Response, StatusCode},
    Json, ToJson,
};
use http_body_util::BodyExt;

struct Accepted;

impl ToJson for Accepted {
    fn write_json(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(b"true");
    }

    fn __into_response(self) -> Response {
        (StatusCode::ACCEPTED, [("x-test", "accepted")], Body::from("true")).into_response()
    }
}

#[tokio::test]
async fn json_still_accepts_a_downstream_response_override() {
    let response = Json(Accepted).into_response();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(response.headers()["x-test"], "accepted");
    assert_eq!(response.headers()["content-type"], "application/json");
    assert_eq!(response.into_body().collect().await.unwrap().to_bytes(), "true");
}
