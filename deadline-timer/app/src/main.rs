//! The HttpArena entry for Corten (https://www.http-arena.com).
//!
//! Everything goes through Corten's documented API: typed routes for the paths and their
//! parameters, `Json` for the JSON, Corten's own compression for json-comp and
//! `tokio::time::sleep` for the waits. The app keeps Corten's defaults; what this file chooses
//! is where it runs (`ARENA_MODE`, in `main`: per core by Corten's `App::per_core`, per core by
//! hand, or on tokio's multi-threaded runtime) and which routes say `unstaged`.
//!
//! This branch adds what was needed to find out why the default runtime is slower on the
//! handler that sleeps (all by environment variable, so one image runs every variant):
//! settings of the multi-threaded runtime (`runtime`), how `/delay` waits (`Wait`), the same
//! wait on a route with every stage (`/sdelay`, so Corten's deadline is on), and a handler that
//! waits on a pooled connection to a local service (`/pool`, `/spool`, `ARENA_MODE=echo`).
use std::collections::{BinaryHeap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

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

    /// `/delay` with every stage, so the app's deadline is on while the handler waits.
    #[route("/sdelay/{ms}", get = staged_delay)]
    pub struct StagedDelay {
        pub ms: u64,
    }

    /// A call to the pooled service, outside the stages and with them.
    #[route("/pool", get = pool, unstaged)]
    pub struct Pool;

    #[route("/spool", get = staged_pool)]
    pub struct StagedPool;

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
    wait(at.ms).await;
    at.ms.to_string()
}

async fn staged_delay(Params(at): Params<url::StagedDelay>) -> String {
    wait(at.ms).await;
    at.ms.to_string()
}

/// How `/delay` waits, by `ARENA_DELAY`: `tokio` (when unset) is `tokio::time::sleep`; `thread`
/// asks timer threads of the app's own (`ARENA_TIMER_THREADS`, one when unset), which answer
/// over a channel, so the runtime's timer is not used and the wake comes from outside the
/// runtime; `none` does not wait.
enum Wait {
    Tokio,
    Thread(Vec<std::sync::mpsc::Sender<Due>>, AtomicUsize),
    None,
}

/// When a wait ends and who waits for it.
struct Due(Instant, tokio::sync::oneshot::Sender<()>);

impl PartialEq for Due {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl Eq for Due {}
impl PartialOrd for Due {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Due {
    // The earliest first out of a `BinaryHeap`.
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other.0.cmp(&self.0)
    }
}

static WAIT: LazyLock<Wait> = LazyLock::new(|| match std::env::var("ARENA_DELAY").as_deref() {
    Ok("thread") => {
        let threads = number("ARENA_TIMER_THREADS").unwrap_or(1);
        let senders = (0..threads)
            .map(|n| {
                let (send, receive) = std::sync::mpsc::channel::<Due>();
                std::thread::Builder::new()
                    .name(format!("arena-timer-{n}"))
                    .spawn(move || timer(receive))
                    .expect("a timer thread");
                send
            })
            .collect();
        Wait::Thread(senders, AtomicUsize::new(0))
    }
    Ok("none") => Wait::None,
    _ => Wait::Tokio,
});

/// A timer thread: every millisecond (the resolution of tokio's timer) it takes what was asked
/// since and answers what is due. Nothing wakes it, so asking costs the handler no system call.
fn timer(asked: std::sync::mpsc::Receiver<Due>) {
    let mut waiting = BinaryHeap::new();
    loop {
        std::thread::sleep(Duration::from_millis(1));
        waiting.extend(asked.try_iter());
        let now = Instant::now();
        while waiting.peek().is_some_and(|due: &Due| due.0 <= now) {
            let _ = waiting.pop().expect("just seen").1.send(());
        }
    }
}

async fn wait(ms: u64) {
    if ms == 0 {
        return;
    }
    match &*WAIT {
        Wait::Tokio => tokio::time::sleep(Duration::from_millis(ms)).await,
        Wait::Thread(timers, next) => {
            let (send, done) = tokio::sync::oneshot::channel();
            let timer = &timers[next.fetch_add(1, Relaxed) % timers.len()];
            let _ = timer.send(Due(Instant::now() + Duration::from_millis(ms), send));
            let _ = done.await;
        }
        Wait::None => {}
    }
}

/// A number from the environment, when it is set.
fn number(name: &str) -> Option<usize> {
    std::env::var(name).ok().map(|value| value.parse().unwrap_or_else(|_| panic!("{name} is not a number: {value}")))
}

/// Keep-alive connections to the local service (`ARENA_MODE=echo`), each carrying one call at a
/// time, as a database pool's do: at most `ARENA_POOL` (64 when unset) open, the longest idle
/// taken first, and a call waits its turn when all are out.
struct Pool {
    idle: Mutex<VecDeque<tokio::net::TcpStream>>,
    places: tokio::sync::Semaphore,
}

impl Pool {
    fn new(size: usize) -> Pool {
        Pool { idle: Mutex::new(VecDeque::new()), places: tokio::sync::Semaphore::new(size) }
    }

    fn size() -> usize {
        number("ARENA_POOL").unwrap_or(64)
    }

    fn addr() -> std::net::SocketAddr {
        let addr = std::env::var("ARENA_POOL_ADDR").unwrap_or_else(|_| "127.0.0.1:9000".into());
        addr.parse().expect("ARENA_POOL_ADDR is an address")
    }

    async fn connect() -> std::io::Result<tokio::net::TcpStream> {
        let conn = tokio::net::TcpStream::connect(Self::addr()).await?;
        conn.set_nodelay(true)?;
        Ok(conn)
    }

    /// One call: eight bytes out, and the service's eight back once it has waited.
    async fn call(&self) -> std::io::Result<u64> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let _place = self.places.acquire().await.expect("never closed");
        let idle = self.idle.lock().expect("never poisoned").pop_front();
        let mut conn = match idle {
            Some(conn) => conn,
            None => Self::connect().await?,
        };
        conn.write_all(&7u64.to_le_bytes()).await?;
        let mut answer = [0; 8];
        conn.read_exact(&mut answer).await?;
        self.idle.lock().expect("never poisoned").push_back(conn);
        Ok(u64::from_le_bytes(answer))
    }
}

/// The pool every core shares (`ARENA_POOL_KIND` unset: a connection is opened by the first
/// handler that finds none idle, so on that handler's event loop; `main`: all of them are
/// opened by `main` before it serves, so on the runtime `main` made).
static SHARED: LazyLock<Pool> = LazyLock::new(|| Pool::new(Pool::size()));

thread_local! {
    /// `ARENA_POOL_KIND=percore`: a pool for each thread, with its share of the connections.
    /// Only for the per-core modes, where a task stays on its thread.
    static OWN: Arc<Pool> = Arc::new(Pool::new(Pool::size().div_ceil(std::thread::available_parallelism().map_or(1, |n| n.get()))));
}

static POOL_PER_CORE: LazyLock<bool> = LazyLock::new(|| std::env::var("ARENA_POOL_KIND").as_deref() == Ok("percore"));

async fn call() -> String {
    let answer = if *POOL_PER_CORE {
        let own = OWN.with(Arc::clone);
        own.call().await
    } else {
        SHARED.call().await
    };
    match answer {
        Ok(answer) => answer.to_string(),
        Err(error) => panic!("the pooled service failed: {error}"),
    }
}

async fn pool() -> String {
    call().await
}

async fn staged_pool() -> String {
    call().await
}

/// `ARENA_POOL_KIND=main`: every connection of the shared pool opened here, before serving.
async fn open_pool() -> std::io::Result<()> {
    if std::env::var("ARENA_POOL_KIND").as_deref() == Ok("main") {
        let mut conns = VecDeque::new();
        for _ in 0..Pool::size() {
            conns.push_back(Pool::connect().await?);
        }
        *SHARED.idle.lock().expect("never poisoned") = conns;
    }
    Ok(())
}

/// The local service the pool calls (`ARENA_MODE=echo`): it reads eight bytes, waits
/// `ARENA_ECHO_MS` milliseconds (1 when unset) and writes them back, a connection at a time.
async fn echo_service(listener: tokio::net::TcpListener) -> std::io::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let wait = Duration::from_millis(number("ARENA_ECHO_MS").unwrap_or(1) as u64);
    loop {
        let (mut conn, _) = listener.accept().await?;
        conn.set_nodelay(true)?;
        tokio::spawn(async move {
            let mut call = [0; 8];
            while conn.read_exact(&mut call).await.is_ok() {
                tokio::time::sleep(wait).await;
                if conn.write_all(&call).await.is_err() {
                    break;
                }
            }
        });
    }
}

/// The multi-threaded runtime for `ARENA_MODE=default`, as `#[tokio::main]` makes it unless the
/// environment sets one of: `ARENA_WORKERS` (worker threads), `ARENA_GQI`
/// (`global_queue_interval`), `ARENA_EVI` (`event_interval`), `ARENA_IO_EVENTS`
/// (`max_io_events_per_tick`), `ARENA_LIFO=off` (`disable_lifo_slot`), `ARENA_TIMER=alt`
/// (`enable_alt_timer`). The last two are tokio's unstable API (`--cfg tokio_unstable`).
fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    if let Some(workers) = number("ARENA_WORKERS") {
        builder.worker_threads(workers);
    }
    if let Some(interval) = number("ARENA_GQI") {
        builder.global_queue_interval(interval as u32);
    }
    if let Some(interval) = number("ARENA_EVI") {
        builder.event_interval(interval as u32);
    }
    if let Some(events) = number("ARENA_IO_EVENTS") {
        builder.max_io_events_per_tick(events);
    }
    if std::env::var("ARENA_LIFO").as_deref() == Ok("off") {
        builder.disable_lifo_slot();
    }
    if std::env::var("ARENA_TIMER").as_deref() == Ok("alt") {
        builder.enable_alt_timer();
    }
    builder.build()
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

/// The app, with Corten's defaults; `ARENA_DEADLINE=off` removes the request deadline
/// (`App::deadline(None)`), to see what its timer costs a handler that waits.
fn app() -> App {
    let app = App::new(Routes::new()).api(url::api);
    if std::env::var("ARENA_DEADLINE").as_deref() == Ok("off") {
        return app.deadline(None);
    }
    app
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
    app()
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
    LazyLock::force(&WAIT);
    match mode.as_str() {
        "percore-builtin" => {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
            runtime.block_on(async {
                open_pool().await?;
                serve(acceptor, cores, true, per_core).await
            })
        }
        "echo" => {
            let port = Pool::addr().port();
            let threads: Vec<_> = (0..cores)
                .map(|_| {
                    std::thread::spawn(move || {
                        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
                        runtime.block_on(async { echo_service(listeners(port, 1, true)?.remove(0)).await })
                    })
                })
                .collect();
            for thread in threads {
                thread.join().expect("a worker panicked")?;
            }
            Ok(())
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
        "default" => runtime()?.block_on(async {
            open_pool().await?;
            serve(acceptor, 1, false, app).await
        }),
        other => {
            Err(std::io::Error::other(format!("ARENA_MODE is {other}: it is percore-builtin, percore-by-hand, default or echo")))
        }
    }
}
