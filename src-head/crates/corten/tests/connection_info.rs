//! A handshake's value reaches each request, including caller identification, without headers
//! being able to replace it. The byte before HTTP stands in for a verified client certificate.

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use corten::{
    http::{header, request::Parts, Request, Response},
    prelude::*,
    ConnectionInfo,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone)]
struct Certificate(Arc<str>);

#[derive(Clone, Hash)]
struct Partner(Arc<str>);

struct PublicHeader;

#[derive(Clone)]
struct Spawn<S>(S);

impl<S> tower::Service<Request> for Spawn<S>
where
    S: tower::Service<Request> + Send,
    S::Future: Send + 'static,
    S::Response: Send + 'static,
    S::Error: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        self.0.poll_ready(cx)
    }

    fn call(&mut self, req: Request) -> Self::Future {
        let answer = self.0.call(req);
        Box::pin(async move { tokio::spawn(answer).await.unwrap() })
    }
}

impl Middleware for PublicHeader {
    async fn call(&self, req: Request, next: impl Next) -> Response {
        let mut answer = next.run(req).await;
        answer.headers_mut().insert(header::CACHE_CONTROL, "public, max-age=60".parse().unwrap());
        answer
    }
}

impl Identify<()> for Partner {
    async fn identify(parts: &Parts, _: &()) -> Result<Self, Refused> {
        let cert = ConnectionInfo::<Certificate>::of(parts).ok_or_else(Refused::forbidden)?;
        Ok(Self(cert.0 .0.clone()))
    }
}

#[corten::routes]
mod url {
    #[route("/direct", get = direct)]
    pub struct Direct;
    #[route("/caller", get = caller)]
    pub struct Caller;
    #[route("/optional", get = optional)]
    pub struct Optional;
}

async fn direct(ConnectionInfo(cert): ConnectionInfo<Certificate>) -> String {
    format!("cert={}", cert.0)
}

async fn caller(partner: Caller<Partner>) -> String {
    format!("caller={}", partner.0 .0)
}

async fn optional(info: Option<ConnectionInfo<Certificate>>) -> String {
    info.map_or_else(|| "no-info".into(), |info| format!("optional={}", info.0 .0))
}

async fn request(stream: &mut tokio::net::TcpStream, path: &str, ending: &str) -> String {
    stream
        .write_all(format!("GET {path} HTTP/1.1\r\nhost: localhost\r\nx-client-certificate: forged\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let answer = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let (mut answer, mut piece) = (Vec::new(), [0; 1024]);
        while !answer.ends_with(ending.as_bytes()) {
            let n = stream.read(&mut piece).await.unwrap();
            assert!(n > 0, "connection closed before its answer: {}", String::from_utf8_lossy(&answer));
            answer.extend_from_slice(&piece[..n]);
        }
        String::from_utf8(answer).unwrap()
    })
    .await
    .expect("request finishes");
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    answer
}

#[tokio::test]
async fn a_handshakes_value_reaches_every_request_and_identify_on_its_own_connection() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handshakes = Arc::new(AtomicUsize::new(0));
    let counted = handshakes.clone();
    let server = tokio::spawn(corten::serve_wrapped_with(
        vec![listener],
        move |mut tcp| {
            let counted = counted.clone();
            async move {
                let mut cert = [0; 1];
                tcp.read_exact(&mut cert).await?;
                counted.fetch_add(1, Ordering::Relaxed);
                Ok::<_, std::io::Error>((tcp, Certificate(Arc::from(char::from(cert[0]).to_string()))))
            }
        },
        App::new(url::router()).middleware(PublicHeader).layer(tower::layer::layer_fn(Spawn)).max_connections(2),
    ));
    let mut alice = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut bob = tokio::net::TcpStream::connect(addr).await.unwrap();
    alice.write_all(b"A").await.unwrap();
    bob.write_all(b"B").await.unwrap();
    for _ in 0..2 {
        for (stream, name) in [(&mut alice, "A"), (&mut bob, "B")] {
            let answer = request(stream, "/direct", &format!("cert={name}")).await;
            assert!(
                answer.contains("cache-control: private, no-cache\r\n"),
                "a read defeats a hand-written public header: {answer}"
            );
            let answer = request(stream, "/caller", &format!("caller={name}")).await;
            assert!(answer.contains("cache-control: private, no-cache\r\n"), "{answer}");
            request(stream, "/optional", &format!("optional={name}")).await;
        }
    }
    assert_eq!(handshakes.load(Ordering::Relaxed), 2, "one value learned per connection, not per request");
    drop((alice, bob));
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn a_plain_connection_has_no_connection_info() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(corten::serve_on(vec![listener], App::new(url::router())));
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    request(&mut stream, "/optional", "no-info").await;
    drop(stream);
    let mut missing = tokio::net::TcpStream::connect(addr).await.unwrap();
    missing.write_all(b"GET /direct HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    let mut answer = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(5), missing.read_to_string(&mut answer)).await.unwrap().unwrap();
    assert!(answer.starts_with("HTTP/1.1 500"), "{answer}");
    drop(missing);
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn the_metadata_entry_point_still_refuses_no_listeners() {
    let error = corten::serve_wrapped_with(
        Vec::<tokio::net::TcpListener>::new(),
        |tcp| async { Ok::<_, std::convert::Infallible>((tcp, 7u8)) },
        App::new(url::router()),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("no listeners"), "{error}");
}
