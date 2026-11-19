//! Loopback-only experiment. Not a replacement for corten::serve.
use bytes::{Buf, Bytes};
use corten::http::{Body, IntoResponse};
use futures_util::{stream, StreamExt};
use http::{Response, Uri};
use http_body::{Body as _, Frame};
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use std::{
    collections::HashMap,
    convert::Infallible,
    future::poll_fn,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::time::{self, Instant};
use tokio_rustls::{
    rustls::{
        self,
        pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer},
    },
    server::TlsStream,
    TlsAcceptor,
};

type Io = TlsStream<tokio::net::TcpStream>;
type BoxError = Box<dyn std::error::Error + Send + Sync>;
const EVENT: &str = "<p id=\"event\">a fixed fragment for the transport comparison</p>";

async fn reply(uri: Uri) -> Response<Body> {
    match uri.path() {
        "/events" => {
            let count = uri.query().and_then(|q| q.strip_prefix("n=")).unwrap();
            let count = count.parse::<usize>().unwrap().min(2000);
            corten::live(stream::repeat_with(|| EVENT.to_owned()).take(count)).into_response()
        }
        "/quiet" => corten::live(stream::pending::<String>()).into_response(),
        "/hold" => {
            let ms = uri.query().and_then(|q| q.strip_prefix("ms=")).unwrap();
            let ms = ms.parse::<u64>().unwrap().min(1000);
            corten::live(stream::once(async move {
                time::sleep(Duration::from_millis(ms)).await;
                EVENT.to_owned()
            }))
            .into_response()
        }
        "/ticker" => corten::live(stream::unfold((), |()| async {
            time::sleep(Duration::from_millis(20)).await;
            Some((EVENT.to_owned(), ()))
        }))
        .into_response(),
        "/wait" => std::future::pending().await,
        "/final" => Response::new(Body::from("x".repeat(4096))),
        "/" => Response::new(Body::from("Same page")),
        _ => Response::builder().status(404).body(Body::empty()).unwrap(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Off,
    ServiceIdle,
    H2Off,
    H2Idle,
    Body,
    Buffer,
}

struct State {
    active: usize,
    idle_since: Instant,
    next: u64,
    pending: HashMap<u64, Instant>,
}

type Shared = Arc<Mutex<State>>;

// Start before awaiting the handler. A reset can drop either the handler future or the body.
struct Active(Shared);

impl Active {
    fn start(state: &Shared) -> Self {
        state.lock().unwrap().active += 1;
        Self(state.clone())
    }
}

impl Drop for Active {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap();
        state.active -= 1;
        if state.active == 0 {
            state.idle_since = Instant::now();
        }
    }
}

struct Waiting {
    state: Shared,
    id: u64,
}

impl Waiting {
    fn start(shared: &Shared) -> Self {
        let mut state = shared.lock().unwrap();
        let id = state.next;
        state.next += 1;
        state.pending.insert(id, Instant::now());
        Self { state: shared.clone(), id }
    }

    fn progress(&self) {
        *self.state.lock().unwrap().pending.get_mut(&self.id).unwrap() = Instant::now();
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        self.state.lock().unwrap().pending.remove(&self.id);
    }
}

// Body mode infers handoff from the next poll (or drop). Buffer mode keeps the
// observation with the bytes, including the part retained by h2 after body drop.
struct Answered {
    body: Body,
    _active: Option<Active>,
    watch: Option<(Mode, Shared)>,
    waiting: Option<Waiting>,
}

struct Data {
    bytes: Bytes,
    waiting: Option<Waiting>,
}

impl Buf for Data {
    fn remaining(&self) -> usize {
        self.bytes.remaining()
    }

    fn chunk(&self) -> &[u8] {
        self.bytes.chunk()
    }

    fn advance(&mut self, n: usize) {
        self.bytes.advance(n);
        if !self.bytes.has_remaining() {
            self.waiting = None;
        } else if n != 0 {
            if let Some(waiting) = &self.waiting {
                waiting.progress();
            }
        }
    }
}

impl http_body::Body for Answered {
    type Data = Data;
    type Error = BoxError;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Data>, BoxError>>> {
        self.waiting = None;
        Pin::new(&mut self.body).poll_frame(cx).map(|frame| {
            frame.map(|result| {
                result.map(|f| {
                    f.map_data(|bytes| {
                        let waiting =
                            self.watch.as_ref().filter(|_| !bytes.is_empty()).map(|(mode, state)| (*mode, Waiting::start(state)));
                        let waiting = match waiting {
                            Some((Mode::Body, waiting)) => {
                                self.waiting = Some(waiting);
                                None
                            }
                            other => other.map(|(_, waiting)| waiting),
                        };
                        Data { bytes, waiting }
                    })
                })
            })
        })
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

async fn hyper_probe(io: Io, opened: Instant, timeout: Duration, mode: Mode) {
    let watch_idle = mode == Mode::ServiceIdle;
    let watch_send = matches!(mode, Mode::Body | Mode::Buffer);
    let state = Arc::new(Mutex::new(State { active: 0, idle_since: opened, next: 0, pending: HashMap::new() }));
    let service_state = state.clone();
    let service = service_fn(move |request: http::Request<hyper::body::Incoming>| {
        let active = watch_idle.then(|| Active::start(&service_state));
        let watch = watch_send.then(|| (mode, service_state.clone()));
        async move {
            Ok::<_, Infallible>(reply(request.into_parts().0.uri).await.map(|body| Answered {
                body,
                _active: active,
                watch,
                waiting: None,
            }))
        }
    });
    let mut builder = hyper::server::conn::http2::Builder::new(TokioExecutor::new());
    builder
        .max_concurrent_streams(100)
        .max_pending_accept_reset_streams(20)
        .max_local_error_reset_streams(1024)
        .max_header_list_size(32 * 1024);
    let mut conn = std::pin::pin!(builder.serve_connection(TokioIo::new(io), service));
    if !watch_idle && !watch_send {
        let _ = conn.await;
        return;
    }
    let mut tick = clock(timeout);
    loop {
        tokio::select! {
            _ = conn.as_mut() => return,
            _ = tick.tick() => {
                let state = state.lock().unwrap();
                if watch_send && state.pending.values().any(|since| since.elapsed() >= timeout) {
                    return;
                }
                if watch_idle && state.active == 0 && state.idle_since.elapsed() >= timeout {
                    return;
                }
            }
        }
    }
}

// Use h2's active count, never a frame parser or a response-body count. Inspect
// it after each connection poll as well as on the timer, so even a request
// completed between ticks restarts the idle period.
async fn h2_probe(io: Io, opened: Instant, timeout: Duration, watch_idle: bool) -> Result<(), BoxError> {
    let mut builder = h2::server::Builder::new();
    builder
        .max_concurrent_streams(100)
        .max_pending_accept_reset_streams(20)
        .max_local_error_reset_streams(Some(1024))
        .max_header_list_size(32 * 1024);
    let mut conn = time::timeout_at(opened + timeout, builder.handshake::<_, Bytes>(io)).await??;
    let mut idle_since = Some(opened);
    let mut tick = clock(timeout);
    loop {
        tokio::select! {
            accepted = poll_fn(|cx| {
                let next = conn.poll_accept(cx);
                if watch_idle {
                    if conn.has_streams() {
                        idle_since = None;
                    } else if idle_since.is_none() || matches!(next, Poll::Ready(Some(Ok(_)))) {
                        idle_since = Some(Instant::now());
                    }
                }
                next
            }) => {
                let Some(Ok((req, respond))) = accepted else { return Ok(()) };
                tokio::spawn(h2_reply(req.into_parts().0.uri, respond));
            }
            _ = tick.tick(), if watch_idle => {
                if idle_since.is_some_and(|since| since.elapsed() >= timeout) {
                    return Ok(());
                }
            }
        }
    }
}

async fn h2_reply(uri: Uri, mut respond: h2::server::SendResponse<Bytes>) -> Result<(), BoxError> {
    let response = tokio::select! {
        response = reply(uri) => response,
        _ = poll_fn(|cx| respond.poll_reset(cx)) => return Ok(()),
    };
    let (head, mut body) = response.into_parts();
    let mut send = respond.send_response(Response::from_parts(head, ()), body.is_end_stream())?;
    while !body.is_end_stream() {
        let frame = tokio::select! {
            frame = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)) => frame.transpose()?,
            _ = poll_fn(|cx| send.poll_reset(cx)) => return Ok(()),
        };
        // Deliberately let h2 queue DATA: this is an idle-watch probe, not a sender.
        match frame {
            Some(frame) => match frame.into_data() {
                Ok(data) => send.send_data(data, body.is_end_stream())?,
                Err(frame) => {
                    send.send_trailers(frame.into_trailers().unwrap())?;
                    break;
                }
            },
            None => {
                send.send_data(Bytes::new(), true)?;
                break;
            }
        }
    }
    Ok(())
}

fn clock(timeout: Duration) -> time::Interval {
    let mut interval = time::interval((timeout / 10).clamp(Duration::from_millis(10), Duration::from_secs(1)));
    interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    interval
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), BoxError> {
    let mode = match std::env::args().nth(1).as_deref() {
        Some("off") => Mode::Off,
        Some("service-idle") => Mode::ServiceIdle,
        Some("h2-off") => Mode::H2Off,
        Some("h2-idle") => Mode::H2Idle,
        Some("body") => Mode::Body,
        Some("buffer") => Mode::Buffer,
        _ => panic!("mode: off | service-idle | h2-off | h2-idle | body | buffer"),
    };
    let cert = CertificateDer::from_pem_file(std::env::var("TLS_CERT")?)?;
    let key = PrivateKeyDer::from_pem_file(std::env::var("TLS_KEY")?)?;
    let mut config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(vec![cert], key)?;
    config.alpn_protocols = vec![b"h2".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let timeout = Duration::from_millis(std::env::var("TIMEOUT_MS")?.parse()?);
    let addr = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:18590".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("listening on {addr}");
    loop {
        let (tcp, _) = listener.accept().await?;
        tcp.set_nodelay(true)?;
        let opened = Instant::now();
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            let Ok(Ok(tls)) = time::timeout_at(opened + timeout, acceptor.accept(tcp)).await else {
                return;
            };
            if matches!(mode, Mode::H2Idle | Mode::H2Off) {
                let _ = h2_probe(tls, opened, timeout, mode == Mode::H2Idle).await;
            } else {
                hyper_probe(tls, opened, timeout, mode).await;
            }
        });
    }
}
