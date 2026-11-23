//! The HttpArena entry for Corten (https://www.http-arena.com).
//!
//! Everything goes through Corten's documented API: typed routes for the paths and their
//! parameters, `Json` for the JSON, Corten's own compression for json-comp and
//! `tokio::time::sleep` for the waits. The app keeps Corten's defaults; what this file chooses
//! is where it runs (`ARENA_MODE`, in `main`: per core by Corten's `App::per_core`, per core by
//! hand, or on tokio's multi-threaded runtime) and which routes say `unstaged`.
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use corten::http::Bytes;
use corten::prelude::*;
use corten::{Media, ToJson};
use serde::Deserialize;

/// One item of /data/dataset.json.
#[derive(Deserialize)]
struct DatasetItem {
    id: i64,
    name: String,
    category: String,
    price: i64,
    quantity: i64,
    active: bool,
    tags: Vec<String>,
    rating: Rating,
}

#[derive(Deserialize, ToJson, Clone, Copy)]
struct Rating {
    score: i64,
    count: i64,
}

/// One item of the /json response: the dataset item and its total.
#[derive(ToJson)]
struct Item<'a> {
    id: i64,
    name: &'a str,
    category: &'a str,
    price: i64,
    quantity: i64,
    active: bool,
    tags: &'a [String],
    rating: Rating,
    total: i64,
}

#[derive(ToJson)]
struct Items<'a> {
    items: Vec<Item<'a>>,
    count: usize,
}

/// The dataset HttpArena mounts, read once.
static DATASET: LazyLock<Vec<DatasetItem>> = LazyLock::new(|| {
    let data = std::fs::read_to_string("/data/dataset.json").unwrap_or_default();
    serde_json::from_str(&data).unwrap_or_default()
});

#[corten::routes(api = Root)]
mod url {
    #[route("/")]
    pub struct Root;

    #[route("/baseline11", get = baseline, post = baseline)]
    pub struct Baseline {
        pub a: Option<i64>,
        pub b: Option<i64>,
    }

    // The two answers that are the same for everyone and read nothing but the URL skip the
    // stages, as the guide describes for such a route. The others keep every default.
    #[route("/pipeline", get = pipeline, unstaged)]
    pub struct Pipeline;

    #[route("/delay/{ms}", get = delay, unstaged)]
    pub struct Delay {
        pub ms: u64,
    }

    #[route("/json/{count}", get = json)]
    pub struct JsonItems {
        pub count: usize,
        pub m: Option<i64>,
    }

    #[route("/echo", post = echo)]
    pub struct Echo;
}

/// baseline, limited-conn and the latency tests: the sum of the query values, plus the number
/// in the body when there is one.
async fn baseline(Params(at): Params<url::Baseline>, body: String) -> String {
    let number = body.trim().parse::<i64>().unwrap_or(0);
    (at.a.unwrap_or(0) + at.b.unwrap_or(0) + number).to_string()
}

async fn pipeline() -> &'static str {
    "ok"
}

/// async: wait as long as the path says without holding a thread.
async fn delay(Params(at): Params<url::Delay>) -> String {
    if at.ms > 0 {
        tokio::time::sleep(Duration::from_millis(at.ms)).await;
    }
    at.ms.to_string()
}

/// json-comp and json-tls: the first `count` items of the dataset, each with its total.
async fn json(Params(at): Params<url::JsonItems>) -> Json<Items<'static>> {
    let count = at.count.min(DATASET.len());
    let m = at.m.unwrap_or(1);
    let items = DATASET[..count]
        .iter()
        .map(|item| Item {
            id: item.id,
            name: &item.name,
            category: &item.category,
            price: item.price,
            quantity: item.quantity,
            active: item.active,
            tags: &item.tags,
            rating: item.rating,
            total: item.price * item.quantity * m,
        })
        .collect();
    Json(Items { items, count })
}

/// 8gbit: the body back as it came.
async fn echo(body: Bytes) -> Media {
    Media::new("application/octet-stream", body)
}

fn app() -> App {
    App::new(Routes::new()).api(url::api)
}

/// The certificate HttpArena mounts for the profiles over TLS, when it is there.
fn tls() -> Option<tokio_rustls::TlsAcceptor> {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
    let certs = CertificateDer::pem_file_iter("/certs/server.crt").ok()?.collect::<Result<Vec<_>, _>>().ok()?;
    let key = PrivateKeyDer::from_pem_file("/certs/server.key").ok()?;
    let mut config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(certs, key).ok()?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Some(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
}

/// The app served per core by Corten itself (`App::per_core`).
fn per_core() -> App {
    app().per_core()
}

/// `each` listeners on `port` of every IPv4 address. With `shared` they share the port with
/// each other and with other workers' (`SO_REUSEPORT`), so the kernel spreads the connections
/// over them.
fn listeners(port: u16, each: usize, shared: bool) -> std::io::Result<Vec<tokio::net::TcpListener>> {
    (0..each)
        .map(|_| {
            let socket = tokio::net::TcpSocket::new_v4()?;
            socket.set_reuseaddr(true)?;
            socket.set_reuseport(shared)?;
            socket.bind(([0, 0, 0, 0], port).into())?;
            socket.listen(4096)
        })
        .collect()
}

/// Port 8080 is HTTP and port 8081 the same routes over TLS, as Corten's guide wraps a listener:
/// an app for each port (a serve takes its app), on `each` listeners a port.
async fn serve(acceptor: Option<tokio_rustls::TlsAcceptor>, each: usize, shared: bool, app: fn() -> App) -> std::io::Result<()> {
    let plain = corten::serve_on(listeners(8080, each, shared)?, app());
    let Some(acceptor) = acceptor else { return plain.await };
    let secure = corten::serve_wrapped(listeners(8081, each, shared)?, move |tcp| acceptor.accept(tcp), app());
    tokio::try_join!(plain, secure).map(|_| ())
}

/// Where the app runs, by `ARENA_MODE`, so the three can be compared from one binary:
///
/// - `percore-builtin` (when unset): Corten serves per core (`App::per_core`). One app for each
///   port, shared by every core, on Corten's event loops, with a listener for each core that
///   share the port. The runtime `main` makes only waits for the shutdown.
/// - `percore-by-hand`: one single-threaded runtime per core made here, each serving apps of
///   its own on listeners of its own, which share the port.
/// - `default`: one app for each port on one listener, on tokio's multi-threaded runtime, as
///   `#[tokio::main]` makes it.
fn main() -> std::io::Result<()> {
    LazyLock::force(&DATASET);
    let acceptor = tls();
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    let mode = std::env::var("ARENA_MODE").unwrap_or_else(|_| "percore-builtin".into());
    eprintln!("httparena-corten: ARENA_MODE={mode} on {cores} cores");
    match mode.as_str() {
        "percore-builtin" => {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
            runtime.block_on(serve(acceptor, cores, true, per_core))
        }
        "percore-by-hand" => {
            let threads: Vec<_> = (0..cores)
                .map(|_| {
                    let acceptor = acceptor.clone();
                    std::thread::spawn(move || {
                        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
                        runtime.block_on(serve(acceptor, 1, true, app))
                    })
                })
                .collect();
            for thread in threads {
                thread.join().expect("a worker panicked")?;
            }
            Ok(())
        }
        "default" => {
            let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
            runtime.block_on(serve(acceptor, 1, false, app))
        }
        other => Err(std::io::Error::other(format!("ARENA_MODE is {other}: it is percore-builtin, percore-by-hand or default"))),
    }
}
