//! The prototype answering a real client over TCP: hyper reads the request, the endpoint gets it
//! raw, the stages run, and the bytes on the wire are the answer.

use pipeline::{Body, Response, Router, Stages, get};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn exchange(addr: std::net::SocketAddr, request: &str) -> String {
    let mut tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    tcp.write_all(request.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    tcp.read_to_end(&mut answer).await.unwrap();
    String::from_utf8(answer).unwrap()
}

#[tokio::test]
async fn a_raw_route_and_a_defended_one_answer_over_tcp() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/ping", get(|| async { Response::new(Body::from("pong")) }))
        .route("/safe", get(Stages::api().serve(pipeline::handler(|| async { "safe" }))));
    tokio::spawn(pipeline::server::serve(listener, app));

    let raw = exchange(addr, "GET /ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await;
    assert!(raw.starts_with("HTTP/1.1 200 OK\r\n"), "{raw}");
    assert!(raw.ends_with("\r\n\r\npong"), "{raw}");
    assert!(!raw.to_ascii_lowercase().contains("content-security-policy"), "{raw}");

    let safe = exchange(addr, "GET /safe HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await;
    let lower = safe.to_ascii_lowercase();
    assert!(safe.starts_with("HTTP/1.1 200 OK\r\n") && safe.ends_with("safe"), "{safe}");
    assert!(
        lower.contains("content-security-policy: default-src 'none'") && lower.contains("x-content-type-options: nosniff"),
        "{safe}"
    );

    let misdirected = exchange(addr, "GET /safe HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n").await;
    assert!(misdirected.starts_with("HTTP/1.1 421 Misdirected Request\r\n"), "{misdirected}");
    let missing = exchange(addr, "GET /nowhere HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await;
    assert!(missing.starts_with("HTTP/1.1 404 Not Found\r\n") && missing.contains("content-length: 0"), "{missing}");
}
