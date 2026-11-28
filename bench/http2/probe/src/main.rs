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
    future::{poll_fn, Future},
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
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
// Below h2's 256-byte copy threshold: the DATA tracker clears in the
// encoder, before the TLS writer can report backpressure.
const SOCKET_CHUNK: usize = 255;
const SOCKET_CHUNKS: usize = 32 * 1024;
// A batch (including h2 frame headers) fits into the 16 KiB encoder.
const SOCKET_BATCH: usize = 48;

// The suite takes the report over a fresh connection while the tested client is
// still paused. The paused client cannot itself observe when the server closes.
static SOCKET_REPORT: Mutex<Option<String>> = Mutex::new(None);

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
        "/socket-report" => Response::new(Body::from(SOCKET_REPORT.lock().unwrap().take().unwrap_or_default())),
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
    Combined,
}

struct State {
    active: usize,
    idle_since: Instant,
    next: u64,
    pending: HashMap<u64, Instant>,
    socket_trial: Option<Instant>,
    socket_blocked: bool,
}

type Shared = Arc<Mutex<State>>;

impl State {
    fn shared(opened: Instant) -> Shared {
        Arc::new(Mutex::new(Self {
            active: 0,
            idle_since: opened,
            next: 0,
            pending: HashMap::new(),
            socket_trial: None,
            socket_blocked: false,
        }))
    }
}

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
    let state = State::shared(opened);
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
async fn h2_probe<I, B>(
    io: I,
    opened: Instant,
    timeout: Duration,
    watch_idle: bool,
    state: Option<Shared>,
    data: fn(Bytes, Option<&Shared>) -> B,
) -> Result<(), BoxError>
where
    I: AsyncRead + AsyncWrite + Unpin,
    B: Buf + Send + 'static,
{
    let mut builder = h2::server::Builder::new();
    builder
        .max_concurrent_streams(100)
        .max_pending_accept_reset_streams(20)
        .max_local_error_reset_streams(Some(1024))
        .max_header_list_size(32 * 1024);
    let mut conn = time::timeout_at(opened + timeout, builder.handshake::<_, B>(io)).await??;
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
                tokio::spawn(h2_reply(req.into_parts().0.uri, respond, state.clone(), data));
            }
            _ = tick.tick(), if watch_idle => {
                if idle_since.is_some_and(|since| since.elapsed() >= timeout) {
                    return Ok(());
                }
                if state.as_ref().is_some_and(|s| s.lock().unwrap().pending.values().any(|since| since.elapsed() >= timeout)) {
                    return Ok(());
                }
            }
        }
    }
}

async fn h2_reply<B: Buf>(
    uri: Uri,
    mut respond: h2::server::SendResponse<B>,
    state: Option<Shared>,
    wrap: fn(Bytes, Option<&Shared>) -> B,
) -> Result<(), BoxError> {
    let answer = async {
        if let Some(state) = state.as_ref().filter(|_| uri.path() == "/socket-stall") {
            *SOCKET_REPORT.lock().unwrap() = None;
            state.lock().unwrap().socket_trial = Some(Instant::now());
            let chunks = stream::unfold((state.clone(), 0), |(state, sent)| async move {
                if sent == SOCKET_CHUNKS {
                    return None;
                }
                // Let h2 copy the previous batch before we queue another. Batching
                // avoids one tiny TLS record per DATA frame on the way to backpressure.
                if sent % SOCKET_BATCH == 0 {
                    tokio::task::yield_now().await;
                    loop {
                        let ready = {
                            let state = state.lock().unwrap();
                            !state.socket_blocked && state.pending.is_empty()
                        };
                        if ready {
                            break;
                        }
                        time::sleep(Duration::from_millis(1)).await;
                    }
                }
                Some((Ok::<_, io::Error>(Bytes::from_static(&[b'x'; SOCKET_CHUNK])), (state, sent + 1)))
            });
            Response::new(Body::from_stream(chunks))
        } else {
            reply(uri).await
        }
    };
    let response = tokio::select! {
        response = answer => response,
        _ = poll_fn(|cx| respond.poll_reset(cx)) => return Ok(()),
    };
    let (head, mut body) = response.into_parts();
    let mut send = respond.send_response(Response::from_parts(head, ()), body.is_end_stream())?;
    while !body.is_end_stream() {
        let frame = tokio::select! {
            frame = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)) => frame.transpose()?,
            _ = poll_fn(|cx| send.poll_reset(cx)) => return Ok(()),
        };
        // Let h2 queue DATA so the tracker stays with bytes even after body completion.
        match frame {
            Some(frame) => match frame.into_data() {
                Ok(data) => send.send_data(wrap(data, state.as_ref()), body.is_end_stream())?,
                Err(frame) => {
                    send.send_trailers(frame.into_trailers().unwrap())?;
                    break;
                }
            },
            None => {
                send.send_data(wrap(Bytes::new(), state.as_ref()), true)?;
                break;
            }
        }
    }
    Ok(())
}

// Wrap the decrypted IO after TLS accept, as corten::serve wraps Watched.
// The probe has one runtime thread: use a local timer to wake h2 instead of
// Corten's shared clock thread. The write/flush/shutdown rules are the same.
struct Watched {
    io: Io,
    state: Shared,
    timeout: Duration,
    stall: Option<(Instant, Pin<Box<time::Sleep>>)>,
    blocked: bool,
}

impl Watched {
    fn sent<T>(
        &mut self,
        written: Poll<io::Result<T>>,
        op: &'static str,
        clears: bool,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<T>> {
        if written.is_ready() {
            if self.blocked {
                self.blocked = false;
                self.state.lock().unwrap().socket_blocked = false;
            }
            if clears {
                self.stall = None;
            }
            return written;
        }
        if !self.blocked {
            self.blocked = true;
            self.state.lock().unwrap().socket_blocked = true;
        }
        let (since, timer) = self.stall.get_or_insert_with(|| {
            let now = Instant::now();
            (now, Box::pin(time::sleep_until(now + self.timeout)))
        });
        if timer.as_mut().poll(cx).is_pending() {
            return Poll::Pending;
        }
        let state = self.state.lock().unwrap();
        if let Some(start) = state.socket_trial {
            *SOCKET_REPORT.lock().unwrap() =
                Some(format!("{op} {} {} {}", state.pending.len(), since.elapsed().as_millis(), start.elapsed().as_millis()));
        }
        Poll::Ready(Err(io::Error::new(io::ErrorKind::TimedOut, "socket write stalled")))
    }
}

impl AsyncRead for Watched {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl AsyncWrite for Watched {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let written = Pin::new(&mut self.io).poll_write(cx, buf);
        self.sent(written, "write", true, cx)
    }

    fn poll_write_vectored(mut self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        let written = Pin::new(&mut self.io).poll_write_vectored(cx, bufs);
        self.sent(written, "write_vectored", true, cx)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let written = Pin::new(&mut self.io).poll_flush(cx);
        self.sent(written, "flush", false, cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let written = Pin::new(&mut self.io).poll_shutdown(cx);
        self.sent(written, "shutdown", false, cx)
    }
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
        Some("combined") => Mode::Combined,
        _ => panic!("mode: off | service-idle | h2-off | h2-idle | body | buffer | combined"),
    };
    let cert = CertificateDer::from_pem_file(std::env::var("TLS_CERT")?)?;
    let key = PrivateKeyDer::from_pem_file(std::env::var("TLS_KEY")?)?;
    let mut config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(vec![cert], key)?;
    config.alpn_protocols = vec![b"h2".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let timeout = Duration::from_millis(std::env::var("TIMEOUT_MS")?.parse()?);
    let addr = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:18590".into());
    let listener = if let Ok(size) = std::env::var("SOCKET_SEND_BUFFER") {
        let addr: std::net::SocketAddr = addr.parse()?;
        let socket = if addr.is_ipv4() { tokio::net::TcpSocket::new_v4()? } else { tokio::net::TcpSocket::new_v6()? };
        socket.set_send_buffer_size(size.parse()?)?;
        socket.bind(addr)?;
        socket.listen(1024)?
    } else {
        tokio::net::TcpListener::bind(&addr).await?
    };
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
            match mode {
                Mode::Combined => {
                    let state = State::shared(opened);
                    let io = Watched { io: tls, state: state.clone(), timeout, stall: None, blocked: false };
                    let _ = h2_probe(io, opened, timeout, true, Some(state), |bytes, state| {
                        let waiting = state.filter(|_| !bytes.is_empty()).map(Waiting::start);
                        Data { bytes, waiting }
                    })
                    .await;
                }
                Mode::H2Idle | Mode::H2Off => {
                    let _ = h2_probe(tls, opened, timeout, mode == Mode::H2Idle, None, |bytes, _| bytes).await;
                }
                _ => hyper_probe(tls, opened, timeout, mode).await,
            }
        });
    }
}
