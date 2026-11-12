#![cfg(feature = "ssr")]

use axum::{
    http::{header, StatusCode},
    routing::get,
    Router,
};
use item_page_leptos::marketplace_page::marketplace_json;

#[tokio::test]
async fn native_json_keeps_statuses_and_represents_missing_and_failed_reads_as_json() {
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let upstream_app = Router::new()
        .route(
            "/marketplace/records/item_1",
            get(|| async { ([(header::CONTENT_TYPE, "application/json")], include_str!("marketplace.json")) }),
        )
        .route("/marketplace/records/failed", get(|| async { (StatusCode::SERVICE_UNAVAILABLE, "private upstream error") }))
        .route("/marketplace/records/invalid", get(|| async { ([(header::CONTENT_TYPE, "application/json")], "not json") }));
    let upstream_task = tokio::spawn(async move { axum::serve(upstream, upstream_app).await.unwrap() });
    // Each integration-test binary has its own source OnceLock and environment.
    std::env::set_var("MARKETPLACE_SOURCE", "api");
    std::env::set_var("API_BASE", format!("http://{upstream_addr}"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route("/api/marketplace/{id}", get(marketplace_json));
    let app_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().unwrap();

    for (id, status, expected) in [
        ("item_1", StatusCode::OK, serde_json::from_str(include_str!("marketplace.json")).unwrap()),
        ("missing", StatusCode::NOT_FOUND, serde_json::json!({ "error": "Not found" })),
        ("failed", StatusCode::BAD_GATEWAY, serde_json::json!({ "error": "Marketplace API did not answer" })),
        ("invalid", StatusCode::BAD_GATEWAY, serde_json::json!({ "error": "Marketplace API did not answer" })),
    ] {
        let response = client.get(format!("{base}/api/marketplace/{id}")).send().await.unwrap();
        assert_eq!(response.status(), status, "{id}");
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()),
            Some("application/json"),
            "{id}: native JSON errors too"
        );
        assert_eq!(response.json::<serde_json::Value>().await.unwrap(), expected, "{id}");
    }
    app_task.abort();
    upstream_task.abort();
    let _ = app_task.await;
    let _ = upstream_task.await;
}
