use super::*;

/// Whether this system has an IPv6 loopback address to listen on.
fn has_ipv6_loopback() -> bool {
    std::net::TcpListener::bind("[::1]:0").is_ok()
}

/// A burst of clients larger than the standard library's backlog of 128 all finish connecting
/// before the server accepts one, on each listener `HOST` gives and on the loopback pair: none
/// waits for its SYN to be sent again. Linux admits one more than the backlog and drops the next
/// SYN, so with 128 the 130th connection would wait a second.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_burst_of_connections_waits_in_the_queue_not_for_a_retransmit() {
    const BURST: usize = 200;
    let somaxconn: usize = std::fs::read_to_string("/proc/sys/net/core/somaxconn").unwrap().trim().parse().unwrap();
    if somaxconn <= BURST {
        eprintln!("skipped: net.core.somaxconn is {somaxconn}, which caps the backlog below the burst");
        return;
    }
    for listeners in [crate::app::bind(Some("127.0.0.1"), 0).await.unwrap(), crate::app::bind(None, 0).await.unwrap()] {
        for listener in &listeners {
            let addr = listener.local_addr().unwrap();
            let mut held = Vec::new();
            for n in 1..=BURST {
                let connected = tokio::time::timeout(Duration::from_millis(900), tokio::net::TcpStream::connect(addr)).await;
                held.push(connected.unwrap_or_else(|_| panic!("{addr}: connection {n} waited for a resent SYN")).unwrap());
            }
        }
    }
}

/// A connection Corten accepts from a TCP listener has Nagle's algorithm off, so a streamed
/// answer's small writes are not held for the acknowledgement of the one before
/// (`docs/design.md#choice-tcp-nodelay`). The serving loop only sees a listener's `Io` as
/// `AsyncRead + AsyncWrite`, so a listener of the app's own keeps what it set.
#[tokio::test]
async fn a_tcp_connection_is_accepted_with_nagle_off() {
    let mut listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let _client = tokio::net::TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
    let (stream, _) = crate::Listener::accept(&mut listener).await;
    assert!(stream.nodelay().unwrap(), "TCP_NODELAY is set on the accepted connection");
}

/// Without `HOST`, `localhost` is both loopback addresses on one port, so a browser that tries
/// `::1` first is answered at once, not after a fallback; stopping ends both.
#[tokio::test]
async fn without_a_host_the_app_listens_on_both_loopback_addresses() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listeners = crate::app::bind(None, 0).await.unwrap();
    let addrs: Vec<_> = listeners.iter().map(|l| l.local_addr().unwrap()).collect();
    assert!(addrs[0].is_ipv4() && addrs[0].ip().is_loopback(), "{addrs:?}");
    assert_eq!(addrs.len(), if has_ipv6_loopback() { 2 } else { 1 }, "{addrs:?}");
    assert!(addrs.iter().all(|a| a.ip().is_loopback() && a.port() == addrs[0].port()), "{addrs:?}");

    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let routes = Table::new().route("/", get(|| async { "hi" }));
    let server =
        tokio::spawn(crate::app::serve_router(listeners, crate::app::plain, Router::from(routes), Default::default(), async {
            let _ = stopped.await;
        }));
    for addr in &addrs {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        assert!(answer.starts_with("HTTP/1.1 200") && answer.ends_with("hi"), "{addr}: {answer}");
    }
    stop.send(()).unwrap();
    server.await.unwrap();
}

/// A server for `app` on a free port of `127.0.0.1` until `stop` is sent.
async fn served<M: crate::Middleware>(
    app: App<M>,
) -> (tokio::sync::oneshot::Sender<()>, tokio::task::JoinHandle<std::io::Result<()>>) {
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    (stop, server)
}

/// What a request over TCP costs, for callgrind: `TCP_REQUESTS` (200) requests for a small JSON
/// answer through Corten's listeners and accept loop, one after another on one keep-alive
/// connection, or with `TCP_CONNECTIONS=1` each on a connection of its own; with
/// `TCP_MAX_CONNECTIONS=n`, under `App::max_connections(n)`. Counting it at two
/// numbers of requests gives the difference per request: `cargo test --release -p corten-run --lib
/// --no-run`, then `TCP_REQUESTS=1200 valgrind --tool=callgrind <that binary> --ignored --exact
/// tests::server::what_a_request_over_tcp_costs` and again at 200.
///
/// With glibc's allocator the keep-alive count has two levels about 370 instructions apart, set
/// by how the one heap the client and the server share here is laid out and not by what a
/// request does: at `8d5160be2` (glibc 2.41) one allocation of 25 to 40 bytes held for the
/// connection moved it from 20,662 to 21,032 or more, and one of any other size tried, from 1 to
/// 4,096 bytes, did not move it. With jemalloc preloaded (`LD_PRELOAD=libjemalloc.so.2`) each of
/// those sizes counted within 9.1 of none. So a difference between two builds read here with
/// glibc's allocator is counted again with jemalloc preloaded before it is believed.
#[tokio::test(flavor = "current_thread")]
#[ignore]
async fn what_a_request_over_tcp_costs() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const BODY: &str = r#"{"id":7,"name":"Lot 7","price":1250}"#;
    let requests: usize = std::env::var("TCP_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let routes = Table::new().route("/", get(|| async { ([(http::header::CONTENT_TYPE, "application/json")], BODY) }));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let mut app = App::new(Routes::from(routes));
    if let Some(max) = std::env::var("TCP_MAX_CONNECTIONS").ok().and_then(|n| n.parse().ok()) {
        app = app.max_connections(max);
    }
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    if std::env::var("TCP_CONNECTIONS").is_ok_and(|each| each == "1") {
        for _ in 0..requests {
            assert!(raw_get(addr, "/", "").await.ends_with(BODY));
        }
    } else {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (mut answer, mut piece) = (Vec::new(), [0; 1024]);
        for _ in 0..requests {
            stream.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
            answer.clear();
            while !answer.ends_with(BODY.as_bytes()) {
                let n = stream.read(&mut piece).await.unwrap();
                assert!(n > 0, "the connection closed before the answer");
                answer.extend_from_slice(&piece[..n]);
            }
        }
    }
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// `App::header_timeout` closes a connection that never finishes its request head, and
/// `App::max_connections` accepts no more connections than it allows until one closes.
#[tokio::test]
async fn a_connection_is_held_only_as_long_and_as_many_as_the_app_allows() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let serve = |app: App| async move {
        let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
        let addr = listeners[0].local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
            let _ = stopped.await;
        }));
        (addr, stop, server)
    };
    let routes = || {
        Routes::from(Table::new().route("/", get(|| async { "hi" })).route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(700)).await;
                "slow"
            }),
        ))
    };

    let (addr, stop, server) = serve(App::new(routes()).header_timeout(Duration::from_millis(300))).await;
    let mut slow = tokio::net::TcpStream::connect(addr).await.unwrap();
    slow.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\n").await.unwrap();
    let mut rest = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), slow.read_to_end(&mut rest)).await;
    assert!(closed.is_ok(), "an unfinished head is not held past the timeout");
    assert!(raw_get(addr, "/", "").await.ends_with("hi"), "a request that finishes its head is answered");
    assert!(raw_get(addr, "/slow", "").await.ends_with("slow"), "a handler may take longer than the head's timeout");
    let mut idle = tokio::net::TcpStream::connect(addr).await.unwrap();
    idle.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    let mut answered = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), idle.read_to_end(&mut answered)).await;
    assert!(closed.is_ok(), "an idle keep-alive connection is closed after the timeout");
    assert!(String::from_utf8_lossy(&answered).ends_with("hi"), "after its answer");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    let (addr, stop, server) = serve(App::new(routes()).header_timeout(None).max_connections(1)).await;
    let mut held = tokio::net::TcpStream::connect(addr).await.unwrap();
    held.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    let mut first = [0u8; 12];
    held.read_exact(&mut first).await.unwrap();
    assert_eq!(&first, b"HTTP/1.1 200");
    let second = tokio::spawn(raw_get(addr, "/", ""));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!second.is_finished(), "a second connection waits while the first is open");
    drop(held);
    let answer = tokio::time::timeout(Duration::from_secs(3), second).await.expect("answered once the first closes").unwrap();
    assert!(answer.ends_with("hi"), "{answer}");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// `App::max_request_head`: a head that reaches it is answered 431 and its connection closed,
/// without waiting for the rest of it; one within it is answered; the app can raise it, past
/// hyper's own read buffer too.
#[tokio::test]
async fn a_request_head_is_held_only_as_large_as_the_app_allows() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let serve = |app: App| async move {
        let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
        let addr = listeners[0].local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
            let _ = stopped.await;
        }));
        (addr, stop, server)
    };
    let routes = || Routes::from(Table::new().route("/", get(|| async { "hi" })));
    // A finished head with a cookie of `bytes`, or an unfinished head of exactly `bytes` (so the
    // server, refusing it, leaves nothing unread and closes without a reset); the answer as text.
    let send = |addr, bytes: usize, finish: bool| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let start = "GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\ncookie: c=";
        let head = if finish {
            format!("{start}{}\r\n\r\n", "x".repeat(bytes))
        } else {
            format!("{start}{}", "x".repeat(bytes - start.len()))
        };
        stream.write_all(head.as_bytes()).await.unwrap();
        let mut answer = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut answer)).await;
        assert!(read.is_ok(), "the connection closes, well before the header timeout");
        String::from_utf8_lossy(&answer).into_owned()
    };

    let (addr, stop, server) = serve(App::new(routes())).await;
    let answer = send(addr, 30 * 1024, true).await;
    assert!(answer.starts_with("HTTP/1.1 200") && answer.ends_with("hi"), "a 30 KiB head is answered: {answer}");
    assert!(answer.contains("x-content-type-options: nosniff"), "by the app: {answer}");
    // One the client never finishes is answered once it reaches the limit.
    let answer = send(addr, 32 * 1024, false).await;
    assert!(answer.starts_with("HTTP/1.1 431 "), "{answer}");
    assert!(!answer.contains("x-content-type-options"), "the server's answer, not the app's: {answer}");
    assert!(send(addr, 0, true).await.ends_with("hi"), "the server still answers");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    let (addr, stop, server) = serve(App::new(routes()).max_request_head(512 * 1024)).await;
    assert!(send(addr, 40 * 1024, true).await.ends_with("hi"), "a raised limit holds a 40 KiB head");
    // Past hyper's own 408 KiB buffer, which would refuse it there unless raised: a head held
    // unfinished at 450 KiB gets no answer until it is finished, then the page.
    let mut held = tokio::net::TcpStream::connect(addr).await.unwrap();
    let start = "GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\ncookie: c=";
    held.write_all(format!("{start}{}", "x".repeat(450 * 1024)).as_bytes()).await.unwrap();
    let mut first = [0u8; 1];
    let early = tokio::time::timeout(Duration::from_millis(500), held.read(&mut first)).await;
    assert!(early.is_err(), "no answer to an unfinished 450 KiB head: {early:?}");
    held.write_all(b"\r\n\r\n").await.unwrap();
    let mut answer = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), held.read_to_end(&mut answer)).await.expect("answered").unwrap();
    assert!(String::from_utf8_lossy(&answer).ends_with("hi"), "answered once finished");
    assert!(send(addr, 512 * 1024, false).await.starts_with("HTTP/1.1 431 "), "and refuses one at it");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// `App::send_timeout`: a client that stops reading an answer has its connection closed once a
/// write has waited that long, an endless stream and a body hyper takes whole included; a stream
/// that waits between its own chunks while the client reads is not cut, and `None` holds the
/// stalled connection, past the header timeout too.
#[tokio::test]
async fn an_answer_waits_for_its_client_only_as_long_as_the_app_allows() {
    use crate::body::Body;
    use bytes::Bytes;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let serve = |app: App| async move {
        let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
        let addr = listeners[0].local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
            let _ = stopped.await;
        }));
        (addr, stop, server)
    };
    let routes = || {
        Routes::from(
            Table::new()
                // An answer with no end: only the client stopping, or the server closing, ends it.
                .route(
                    "/endless",
                    get(|| async {
                        let chunk = Bytes::from(vec![b'x'; 64 * 1024]);
                        Body::from_stream(futures_util::stream::repeat_with(move || Ok::<_, std::io::Error>(chunk.clone())))
                    }),
                )
                // 32 MiB, more than the socket buffers hold, so its writes wait on the reader.
                .route("/big", get(|| async { vec![b'x'; 32 << 20] }))
                // Three chunks 400 ms apart, longer than the send timeout below.
                .route(
                    "/paced",
                    get(|| async {
                        Body::from_stream(futures_util::stream::unfold(0, |sent| async move {
                            if sent == 3 {
                                return None;
                            }
                            tokio::time::sleep(Duration::from_millis(400)).await;
                            Some((Ok::<_, std::io::Error>(Bytes::from_static(b"tick")), sent + 1))
                        }))
                    }),
                ),
        )
    };
    let endless = |addr| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(b"GET /endless HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
        stream
    };
    // A client that reads the start of `/big`, whose body hyper takes whole, then no more: done
    // but for its sending, which waits on the client (#1746).
    let whole = |addr| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(b"GET /big HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
        let mut head = [0u8; 12];
        stream.read_exact(&mut head).await.unwrap();
        assert_eq!(&head, b"HTTP/1.1 200");
        stream
    };
    // Reads what is left; Ok with how much once the server has closed, Err while it still sends
    // after 3 s.
    let drain = |mut stream: tokio::net::TcpStream| async move {
        let mut buf = vec![0u8; 256 * 1024];
        tokio::time::timeout(Duration::from_secs(3), async move {
            let mut total = 0;
            while let Ok(read) = stream.read(&mut buf).await {
                if read == 0 {
                    break;
                }
                total += read;
            }
            total
        })
        .await
    };

    let (addr, stop, server) = serve(App::new(routes()).send_timeout(Duration::from_millis(300))).await;
    let stalled = endless(addr).await;
    let stalled_whole = whole(addr).await;
    // Long enough for the socket's buffers to fill and the timeout to pass, with room for a
    // slow machine: the connection is closed by then, so what is left ends.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(drain(stalled).await.is_ok(), "a client that stops reading is closed");
    let read = drain(stalled_whole).await.expect("a client that stops reading a whole body is closed");
    assert!(read < 32 << 20, "before it is sent the rest: {read} bytes");
    let mut paced = tokio::net::TcpStream::connect(addr).await.unwrap();
    paced.write_all(b"GET /paced HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    let mut answer = Vec::new();
    paced.read_to_end(&mut answer).await.unwrap();
    let ticks = answer.windows(4).filter(|w| w == b"tick").count();
    assert_eq!(ticks, 3, "a stream that waits between chunks is not cut: {}", String::from_utf8_lossy(&answer));
    // A reader that pauses 10 ms between reads takes longer than the timeout in all, and its
    // writes wait each time the buffers fill, but each wait ends in time: it gets everything.
    let mut slow = tokio::net::TcpStream::connect(addr).await.unwrap();
    slow.write_all(b"GET /big HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    let started = std::time::Instant::now();
    let (mut got, mut buf) = (0, vec![0u8; 256 * 1024]);
    loop {
        let read = tokio::time::timeout(Duration::from_secs(5), slow.read(&mut buf)).await.expect("reads").unwrap_or(0);
        if read == 0 {
            break;
        }
        got += read;
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(got > 32 << 20, "a reader that keeps reading gets the whole answer: {got} bytes");
    assert!(started.elapsed() > Duration::from_millis(300), "over longer than the timeout");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    let header = Duration::from_millis(300);
    let (addr, stop, server) = serve(App::new(routes()).send_timeout(None).header_timeout(header)).await;
    let stalled = endless(addr).await;
    let stalled_whole = whole(addr).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(drain(stalled).await.is_err(), "without the timeout it is held, and still sending");
    // A whole body's too: the header timeout bounds only what comes before a request, so the
    // client gets the rest when it reads again, and the connection is closed once idle.
    let read = drain(stalled_whole).await.expect("closed once idle");
    assert!(read > 32 << 20, "without the timeout a whole body is held, then sent in full: {read} bytes");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// A stand-in for a TLS stream, as tokio-rustls's acts: it takes up to [`Held::ROOM`] bytes of
/// the answer and moves them to the socket as the client makes room, but its write stays pending
/// until it has room for more, and its flush until everything it holds has gone. It notes, for
/// its connection (by the client's port), how long each flush that waited took, and when it was
/// dropped and whether a flush was waiting then.
struct Held {
    tcp: tokio::net::TcpStream,
    held: Vec<u8>,
    flushing: Option<std::time::Instant>,
    port: u16,
    seen: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<u16, HeldFlushes>>>,
}

#[derive(Default)]
struct HeldFlushes {
    /// How long each flush that waited took, in order.
    waited: Vec<Duration>,
    /// When the connection was dropped, and whether a flush was waiting then.
    dropped: Option<(std::time::Instant, bool)>,
}

impl Held {
    const ROOM: usize = 256 << 10;

    /// Moves what it holds to the socket while the socket takes it.
    fn send(&mut self, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        use tokio::io::AsyncWrite;
        while !self.held.is_empty() {
            match std::task::ready!(std::pin::Pin::new(&mut self.tcp).poll_write(cx, &self.held))? {
                0 => return std::task::Poll::Ready(Err(std::io::ErrorKind::WriteZero.into())),
                sent => drop(self.held.drain(..sent)),
            }
        }
        std::task::Poll::Ready(Ok(()))
    }
}

impl tokio::io::AsyncRead for Held {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().tcp).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for Held {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        use std::task::Poll;
        let this = self.get_mut();
        loop {
            // What it has room for goes in first, then out as far as the socket takes it.
            let took = buf.len().min(Held::ROOM - this.held.len());
            this.held.extend_from_slice(&buf[..took]);
            return match this.send(cx) {
                Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
                Poll::Pending if took == 0 => Poll::Pending,
                Poll::Ready(Ok(())) if took == 0 && !buf.is_empty() => continue,
                _ => Poll::Ready(Ok(took)),
            };
        }
    }

    fn poll_flush(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let sent = this.send(cx);
        if sent.is_pending() {
            this.flushing.get_or_insert_with(std::time::Instant::now);
            return sent;
        }
        if let Some(since) = this.flushing.take() {
            this.seen.lock().unwrap().entry(this.port).or_default().waited.push(since.elapsed());
        }
        std::task::ready!(sent)?;
        std::pin::Pin::new(&mut this.tcp).poll_flush(cx)
    }

    fn poll_shutdown(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        let this = self.get_mut();
        std::task::ready!(this.send(cx))?;
        std::pin::Pin::new(&mut this.tcp).poll_shutdown(cx)
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        let dropped = (std::time::Instant::now(), self.flushing.is_some());
        self.seen.lock().unwrap().entry(self.port).or_default().dropped = Some(dropped);
    }
}

/// `App::send_timeout` over `corten::serve_wrapped`, with an IO that holds part of the answer as
/// a TLS stream does ([`Held`]): a client reading steadily but slower than the server writes
/// keeps its connection past several send timeouts while its own last flush waits on it for longer
/// than one, and gets the whole answer; a client that stops reading during that flush is still
/// closed within twice the send timeout of the stop, while that flush waits (#1742).
#[tokio::test]
async fn a_flush_that_waits_while_its_bytes_go_out_is_held_only_to_the_send_timeout() {
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const BODY: usize = 768 << 10;
    const CHUNK: usize = 8 << 10;
    const PACE: Duration = Duration::from_millis(25);
    // When the client that stops does: by then the server has handed the whole body to `Held`,
    // which holds more than the socket buffers, so its flush is what waits.
    const STOP: usize = 560 << 10;
    let send = Duration::from_millis(400);
    let byte = |at: usize| (at % 251) as u8;
    let routes = Table::new().route("/big", get(move || async move { (0..BODY).map(byte).collect::<Vec<u8>>() }));
    // Small buffers both sides, so the client's pace is what the server sees.
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_send_buffer_size(16 << 10).unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let listener = socket.listen(16).unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let step = {
        let seen = seen.clone();
        move |tcp: tokio::net::TcpStream| {
            let port = tcp.peer_addr().unwrap().port();
            let held = Held { tcp, held: Vec::new(), flushing: None, port, seen: seen.clone() };
            std::future::ready(Ok::<_, std::convert::Infallible>((held, ())))
        }
    };
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(routes)).send_timeout(send);
    let server = tokio::spawn(crate::app::run(vec![listener], step, app, async {
        let _ = stopped.await;
    }));
    // Asks for `/big` and reads `CHUNK` every `PACE` until it has `until` bytes, the connection
    // ends or no byte comes for 5 s. Returns the answer's bytes (head included) and what ended it.
    let read = |until: usize| async move {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.set_recv_buffer_size(16 << 10).unwrap();
        let mut stream = socket.connect(addr).await.unwrap();
        stream.write_all(b"GET /big HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
        let (mut got, mut buf) = (Vec::new(), vec![0u8; CHUNK]);
        let ended = loop {
            if got.len() >= until {
                break String::new();
            }
            match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await {
                Err(_) => break "no byte for 5 s".to_string(),
                Ok(Ok(0)) => break "closed".to_string(),
                Ok(Err(error)) => break format!("failed: {error}"),
                Ok(Ok(read)) => got.extend_from_slice(&buf[..read]),
            }
            tokio::time::sleep(PACE).await;
        };
        (stream, got, ended)
    };
    let steady = async {
        let started = Instant::now();
        let (stream, got, ended) = read(usize::MAX).await;
        let port = stream.local_addr().unwrap().port();
        let took = started.elapsed();
        let head = got.windows(4).position(|w| w == b"\r\n\r\n").expect("an answer's head") + 4;
        let body = &got[head..];
        assert!(body.len() == BODY, "the steady reader got {} of {BODY} body bytes in {took:?}: {ended}", body.len());
        assert!(body.iter().enumerate().all(|(at, &b)| b == byte(at)), "the body arrived as it was sent");
        assert!(took > 4 * send, "over several send timeouts: {took:?}");
        port
    };
    let stops = async {
        let (mut stream, got, ended) = read(STOP).await;
        let stopped = Instant::now();
        assert!(ended.is_empty(), "the reader that stops read {} bytes before it stopped: {ended}", got.len());
        // It reads nothing for well past the timeout, then takes what is left: the server closed
        // it by then, before sending the rest.
        tokio::time::sleep(4 * send).await;
        let mut rest = Vec::new();
        let drained = tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut rest)).await;
        assert!(drained.is_ok(), "a reader that stops is closed");
        assert!(got.len() + rest.len() < BODY, "before the rest is sent: {} bytes", got.len() + rest.len());
        (stream.local_addr().unwrap().port(), stopped)
    };
    let (steady, (stops, stopped)) = tokio::join!(steady, stops);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
    let seen = std::mem::take(&mut *seen.lock().unwrap());
    let last = seen[&steady].waited.last().copied().unwrap_or_default();
    let (dropped, waiting) = seen[&stops].dropped.expect("the stopped reader's connection was dropped");
    let closed = dropped.saturating_duration_since(stopped);
    eprintln!("steady reader's flushes waited {:?}; stopped reader closed {closed:?} after the stop", seen[&steady].waited);
    assert!(last > send, "the steady reader's own last flush waited longer than the send timeout: {last:?}");
    assert!(waiting, "the client that stopped was closed while a flush waited");
    assert!(closed <= 2 * send, "the client that stopped was closed within twice the send timeout: {closed:?}");
}

/// Shutdown gives connections the longer of the grace and the longest deadline: a request in
/// progress past the grace, within its deadline, is answered in full, and an answer its client has
/// stopped reading is closed then, with no send timeout to close it before (#858).
#[tokio::test]
async fn shutdown_closes_connections_still_answering_once_the_grace_and_deadline_have_passed() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let started = std::sync::Arc::new(tokio::sync::Notify::new());
    let routes = Table::new()
        // 32 MiB, more than the socket buffers hold, so its writes wait on the reader.
        .route("/big", get(|| async { vec![b'x'; 32 << 20] }))
        // Longer than the grace, within the deadline.
        .route(
            "/slow",
            get({
                let started = started.clone();
                move || async move {
                    started.notify_one();
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    "done"
                }
            }),
        );
    let app = App::new(Routes::from(routes))
        .send_timeout(None)
        .shutdown_grace(Duration::from_millis(200))
        .deadline(Duration::from_secs(1));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));

    let mut stalled = tokio::net::TcpStream::connect(addr).await.unwrap();
    stalled.write_all(b"GET /big HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    // The answer has started; from here the client reads no more.
    let mut head = [0u8; 12];
    stalled.read_exact(&mut head).await.unwrap();
    assert_eq!(&head, b"HTTP/1.1 200");
    let mut slow = tokio::net::TcpStream::connect(addr).await.unwrap();
    slow.write_all(b"GET /slow HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    started.notified().await;
    let began = std::time::Instant::now();
    stop.send(()).unwrap();

    let mut answer = String::new();
    slow.read_to_string(&mut answer).await.unwrap();
    assert!(answer.ends_with("done"), "a request in progress has its deadline: {answer}");
    // Without the drain's bound this waits for the client, which never reads.
    tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
    assert!(began.elapsed() >= Duration::from_secs(1), "held for the deadline, the longer: {:?}", began.elapsed());
    let mut rest = vec![0u8; 256 * 1024];
    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        while let Ok(read) = stalled.read(&mut rest).await {
            if read == 0 {
                break;
            }
        }
    });
    assert!(closed.await.is_ok(), "the stalled connection was closed");
}

/// Shutdown gives each connection its own request's deadline, not the longest in the app: a page
/// whose client stopped reading is closed at the page's, while a request to an area with an
/// hour's deadline, in progress past the page's, is answered in full (#887).
#[tokio::test]
async fn shutdown_holds_a_connection_to_its_own_requests_deadline() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // 32 MiB, more than the socket buffers hold, so its writes wait on the reader.
    const BIG: usize = 32 << 20;
    let started = std::sync::Arc::new(tokio::sync::Notify::new());
    let serve = || async {
        let routes = Table::new().route("/big", get(|| async { vec![b'x'; BIG] }));
        let job = get({
            let started = started.clone();
            move || async move {
                started.notify_one();
                tokio::time::sleep(Duration::from_secs(2)).await;
                "done"
            }
        });
        let app = App::new(Routes::from(routes))
            .send_timeout(None)
            .shutdown_grace(Duration::from_millis(100))
            .deadline(Duration::from_millis(600))
            .area::<Admin>(|admin| admin.route::<AdminSlow>(crate::Methods::reads(job)).deadline(Duration::from_secs(3600)));
        let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
        let addr = listeners[0].local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
            let _ = stopped.await;
        }));
        // A client that reads the answer's first bytes, then no more.
        let mut stalled = tokio::net::TcpStream::connect(addr).await.unwrap();
        stalled.write_all(b"GET /big HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
        let mut head = [0u8; 12];
        stalled.read_exact(&mut head).await.unwrap();
        assert_eq!(&head, b"HTTP/1.1 200");
        (addr, stop, server, stalled)
    };
    // How much of the answer the client gets when it reads again: all of it if its connection was
    // still open, so its writes went on.
    let rest = |mut stalled: tokio::net::TcpStream| async move {
        let mut buf = vec![0u8; 256 * 1024];
        let mut total = 0;
        while let Ok(read) = stalled.read(&mut buf).await {
            if read == 0 {
                break;
            }
            total += read;
        }
        total
    };

    // The page's client alone: shutdown ends at the page's deadline, not the grace or the hour.
    let (_, stop, server, stalled) = serve().await;
    stop.send(()).unwrap();
    let began = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
    let took = began.elapsed();
    assert!(took >= Duration::from_millis(600), "not before the page's deadline: {took:?}");
    let read = tokio::time::timeout(Duration::from_secs(5), rest(stalled)).await.expect("closed");
    assert!(read < BIG, "the stalled connection was closed, not sent the rest: {read}");

    // With the area's request in progress: it is answered past the page's deadline, and the page's
    // connection was closed before it.
    let (addr, stop, server, stalled) = serve().await;
    let mut job = tokio::net::TcpStream::connect(addr).await.unwrap();
    job.write_all(b"GET /admin/slow HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    started.notified().await;
    stop.send(()).unwrap();
    let mut answer = String::new();
    job.read_to_string(&mut answer).await.unwrap();
    assert!(answer.ends_with("done"), "the area's request in progress has its hour: {answer}");
    let read = tokio::time::timeout(Duration::from_secs(5), rest(stalled)).await.expect("closed");
    assert!(read < BIG, "the page's connection was closed before the job's answer: {read}");
    tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
}

/// At shutdown a connection whose request's head was still arriving has the grace, and the
/// deadline of the request once it has arrived: one never finished is closed after the grace,
/// one that finishes as a request to an area with an hour's deadline is answered (#887).
#[tokio::test]
async fn a_request_still_arriving_at_shutdown_has_its_own_deadline() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let job = get(|| async {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        "done"
    });
    let app = App::new(Routes::from(Table::new().route("/", get(|| async { "home" }))))
        .header_timeout(None)
        .shutdown_grace(Duration::from_millis(300))
        .deadline(Duration::from_millis(300))
        .area::<Admin>(|admin| admin.route::<AdminSlow>(crate::Methods::reads(job)).deadline(Duration::from_secs(3600)));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    // Both send part of a head.
    let mut never = tokio::net::TcpStream::connect(addr).await.unwrap();
    never.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
    let mut late = tokio::net::TcpStream::connect(addr).await.unwrap();
    late.write_all(b"GET /admin/slow HTTP/1.1\r\n").await.unwrap();
    // A connection made after them answered, so the server has taken theirs: it takes them in
    // the order they came.
    let mut after = tokio::net::TcpStream::connect(addr).await.unwrap();
    after.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    let mut answer = String::new();
    after.read_to_string(&mut answer).await.unwrap();
    assert!(answer.ends_with("home"), "{answer}");
    stop.send(()).unwrap();
    let began = std::time::Instant::now();
    // The rest of the head once shutdown has begun, which closes the listener: the connection
    // read no deadline when it began.
    while tokio::net::TcpStream::connect(addr).await.is_ok() {
        tokio::task::yield_now().await;
    }
    late.write_all(b"host: localhost\r\nconnection: close\r\n\r\n").await.unwrap();

    let mut answer = String::new();
    late.read_to_string(&mut answer).await.unwrap();
    assert!(answer.ends_with("done"), "the request that arrived has the area's hour: {answer}");
    let mut rest = Vec::new();
    let _ =
        tokio::time::timeout(Duration::from_secs(3), never.read_to_end(&mut rest)).await.expect("the unfinished head is closed");
    // Held for the hour, the unfinished head would keep shutdown waiting.
    tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
    assert!(began.elapsed() >= Duration::from_millis(1400), "the job was waited for: {:?}", began.elapsed());
}

/// A server dropped without a shutdown (its future aborted) closes a connection still answering at
/// once, an hour-long area's included (#887 review).
#[tokio::test]
async fn a_server_dropped_without_a_shutdown_closes_its_connections() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (started, mut running) = tokio::sync::mpsc::channel::<()>(1);
    let job = get(move || {
        let started = started.clone();
        async move {
            let _ = started.send(()).await;
            std::future::pending::<&'static str>().await
        }
    });
    let app = App::new(Routes::from(Table::new().route("/", get(|| async { "home" }))))
        .area::<Admin>(|admin| admin.route::<AdminSlow>(crate::Methods::reads(job)).deadline(Duration::from_secs(3600)));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (_stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    conn.write_all(b"GET /admin/slow HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    running.recv().await.expect("the job runs");
    server.abort();
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), conn.read_to_end(&mut rest)).await.expect("closed at once").ok();
}

/// What `client` is sent until its connection closes, which it must within five seconds: well
/// inside the grace the tests below give, so a connection held for the grace fails them.
async fn sent_until_closed(client: &mut tokio::net::TcpStream, who: &str) -> String {
    use tokio::io::AsyncReadExt;
    let mut rest = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut rest)).await;
    // A connection the server reset is closed too.
    let _ = closed.unwrap_or_else(|_| panic!("{who}: not closed, after {:?}", String::from_utf8_lossy(&rest)));
    String::from_utf8(rest).unwrap()
}

/// Shutdown reaches a connection whose task has woken many times since it began to wait for it
/// (the task polls its wait again only when the wait's own waker has fired, and asks at each
/// wake only whether it has): one idle after its requests closes at once, one that never sent a
/// byte closes at once, and one whose handler is still at work answers, says that it closes, and
/// closes, and only then is the server done. A server that is gone without a shutdown closes all
/// three at once.
#[tokio::test]
async fn shutdown_reaches_a_connection_long_after_its_task_began_to_wait_for_it() {
    long_waiting_connections_hear_of_shutdown(1).await;
}

/// The same where `serve` runs, on a runtime of several threads: the word of shutdown is sent
/// from one thread while the connections' tasks are polled on others.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_reaches_such_a_connection_whose_task_runs_on_another_thread() {
    long_waiting_connections_hear_of_shutdown(8).await;
}

/// `rounds` servers stopped and as many dropped, each with three connections as the two tests
/// above say.
async fn long_waiting_connections_hear_of_shutdown(rounds: usize) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const GET: &[u8] = b"GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    for gone in [false, true].repeat(rounds) {
        let (started, mut running) = tokio::sync::mpsc::channel::<()>(1);
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let slow = get({
            let release = release.clone();
            move || {
                let (started, release) = (started.clone(), release.clone());
                async move {
                    let _ = started.send(()).await;
                    release.notified().await;
                    "late"
                }
            }
        });
        let routes = Table::new().route("/", get(|| async { "hi" })).route("/slow", slow);
        // A grace no connection here may be held for: each closes because of what it is doing.
        let app = App::new(Routes::from(routes)).shutdown_grace(Duration::from_secs(60));
        let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
        let addr = listeners[0].local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let mut server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
            let _ = stopped.await;
        }));
        let mut idle = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut busy = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut silent = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut piece = [0u8; 1024];
        for _ in 0..40 {
            for client in [&mut idle, &mut busy] {
                client.write_all(GET).await.unwrap();
                let mut answer = Vec::new();
                while !answer.ends_with(b"hi") {
                    let read = client.read(&mut piece).await.unwrap();
                    assert!(read > 0, "closed after {:?}", String::from_utf8_lossy(&answer));
                    answer.extend_from_slice(&piece[..read]);
                }
                assert!(answer.starts_with(b"HTTP/1.1 200"), "{:?}", String::from_utf8_lossy(&answer));
            }
        }
        busy.write_all(b"GET /slow HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
        running.recv().await.expect("the slow handler runs");
        if gone {
            // The server's future is dropped where it waits, and the word of shutdown with it.
            server.abort();
            for (client, who) in [(&mut idle, "idle"), (&mut silent, "silent"), (&mut busy, "busy")] {
                assert_eq!(sent_until_closed(client, who).await, "", "{who}: closed with nothing more, the server gone");
            }
            continue;
        }
        stop.send(()).unwrap();
        for (client, who) in [(&mut idle, "idle"), (&mut silent, "silent")] {
            assert_eq!(sent_until_closed(client, who).await, "", "{who}: closed with nothing more");
        }
        let waited = tokio::time::timeout(Duration::from_millis(200), &mut server).await;
        assert!(waited.is_err(), "the server waits for the request still being answered");
        release.notify_one();
        let answer = sent_until_closed(&mut busy, "busy").await;
        assert!(answer.starts_with("HTTP/1.1 200") && answer.ends_with("late"), "the request in progress is answered: {answer}");
        assert!(answer.contains("\r\nconnection: close\r\n"), "and says its connection closes: {answer}");
        tokio::time::timeout(Duration::from_secs(5), server).await.expect("shutdown ends").unwrap().unwrap();
    }
}

/// A connection hears of shutdown when its task had spent tokio's cooperative budget by the time
/// it first waited for it. A wait the budget puts off leaves its waker with no one: it wakes
/// that waker itself, to be polled again, so the task must poll the wait again when the wait's
/// own waker fires, and not only when the channel has something to say. The step before HTTP
/// spends the budget here, in the poll that ends it.
#[tokio::test]
async fn a_connection_whose_task_had_spent_its_budget_still_hears_of_shutdown() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stepped = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let step = {
        let stepped = stepped.clone();
        move |tcp: tokio::net::TcpStream| {
            let stepped = stepped.clone();
            async move {
                // Never pending: asked before each unit is taken.
                while tokio::task::coop::has_budget_remaining() {
                    tokio::task::coop::consume_budget().await;
                }
                stepped.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok::<_, std::convert::Infallible>((tcp, ()))
            }
        }
    };
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(Table::new().route("/", get(|| async { "hi" })))).shutdown_grace(Duration::from_secs(60));
    let server = tokio::spawn(crate::app::run(vec![listener], step, app, async {
        let _ = stopped.await;
    }));
    let mut silent = tokio::net::TcpStream::connect(addr).await.unwrap();
    while stepped.load(std::sync::atomic::Ordering::SeqCst) == 0 {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    // Its task has been polled again since, with a budget to read with, and waits for a request.
    tokio::time::sleep(Duration::from_millis(50)).await;
    stop.send(()).unwrap();
    assert_eq!(sent_until_closed(&mut silent, "silent").await, "");
    tokio::time::timeout(Duration::from_secs(5), server).await.expect("shutdown ends").unwrap().unwrap();
}

/// A connection whose step before HTTP ends in the poll shutdown begins in (one accepted as the
/// server stops) is closed at once, whether or not shutdown had begun before its task first
/// waited for it: one that sent nothing gets nothing, and one whose request had arrived is either
/// closed unread or answered in full, never held or cut. Which of the two is not promised, and
/// this test holds neither.
#[tokio::test]
async fn a_connection_whose_step_ends_as_shutdown_begins_is_closed() {
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stepping = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let step = {
        let (stepping, release) = (stepping.clone(), release.clone());
        move |tcp: tokio::net::TcpStream| {
            let (stepping, release) = (stepping.clone(), release.clone());
            async move {
                stepping.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                release.notified().await;
                Ok::<_, std::convert::Infallible>((tcp, ()))
            }
        }
    };
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(Table::new().route("/", get(|| async { "hi" })))).shutdown_grace(Duration::from_secs(60));
    let server = tokio::spawn(crate::app::run(vec![listener], step, app, {
        let release = release.clone();
        async move {
            let _ = stopped.await;
            // In the poll that begins shutdown, before it does: both steps end, and each task is
            // polled next with shutdown begun (the test's runtime has one thread).
            release.notify_waiters();
        }
    }));
    let mut silent = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut asked = tokio::net::TcpStream::connect(addr).await.unwrap();
    asked.write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    while stepping.load(std::sync::atomic::Ordering::SeqCst) < 2 {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    // Both steps have been polled, and wait.
    tokio::time::sleep(Duration::from_millis(50)).await;
    stop.send(()).unwrap();
    assert_eq!(sent_until_closed(&mut silent, "silent").await, "");
    let answer = sent_until_closed(&mut asked, "asked").await;
    assert!(
        answer.is_empty() || (answer.starts_with("HTTP/1.1 200") && answer.ends_with("hi")),
        "closed unread or answered in full: {answer}"
    );
    tokio::time::timeout(Duration::from_secs(5), server).await.expect("shutdown ends").unwrap().unwrap();
}

/// `App::send_timeout` holds on a switched connection too: a socket whose client stops reading
/// has its route's write fail with `TimedOut`.
#[tokio::test]
async fn a_switched_connection_is_held_to_the_send_timeout() {
    use crate::upgrade::Upgrade;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (failed, failure) = tokio::sync::mpsc::channel::<std::io::ErrorKind>(1);
    let routes = Table::new().route(
        "/ws",
        get(move |upgrade: Upgrade| {
            let failed = failed.clone();
            async move {
                upgrade.websocket(move |mut stream: crate::upgrade::Stream, _: crate::Signal| async move {
                    let chunk = vec![b'x'; 64 * 1024];
                    loop {
                        if let Err(error) = stream.write_all(&chunk).await {
                            let _ = failed.send(error.kind()).await;
                            return;
                        }
                    }
                })
            }
        }),
    );
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(routes)).send_timeout(Duration::from_millis(300));
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"GET /ws HTTP/1.1\r\nhost: localhost\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
        .await
        .unwrap();
    let mut first = [0u8; 12];
    stream.read_exact(&mut first).await.unwrap();
    assert_eq!(&first, b"HTTP/1.1 101");
    // Reads nothing more.
    let mut failure = failure;
    let kind = tokio::time::timeout(Duration::from_secs(5), failure.recv()).await.expect("the route's write fails");
    assert_eq!(kind, Some(std::io::ErrorKind::TimedOut));
    drop(stream);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// `App::max_connections` counts a switched connection for as long as its route holds it: with one
/// allowed, a second connection waits while a WebSocket is open after its `101`, and is served
/// once the WebSocket closes (#1249). A tunnel's case is in
/// `a_connect_tunnel_outlives_the_header_timeout_and_a_refused_connect_does_not`.
#[tokio::test]
async fn a_switched_connection_counts_against_max_connections_until_it_closes() {
    use crate::upgrade::{Switch, Upgrade};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn echo(upgrade: Upgrade) -> crate::Result<Switch> {
        upgrade.websocket(|mut stream: crate::upgrade::Stream, _: crate::Signal| async move {
            let mut buf = [0u8; 64];
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) if stream.write_all(&buf[..n]).await.is_err() => return,
                    Ok(_) => {}
                }
            }
        })
    }
    let routes = Table::new().route("/ws", get(echo)).route("/", get(|| async { "hi" }));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(routes)).max_connections(1);
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
    socket
        .write_all(b"GET /ws HTTP/1.1\r\nhost: localhost\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
        .await
        .unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(socket.read_u8().await.expect("the switch's head"));
    }
    assert!(head.starts_with(b"HTTP/1.1 101"), "{}", String::from_utf8_lossy(&head));
    // An echo shows the route holds the socket.
    let mut echoed = [0u8; 4];
    socket.write_all(b"ping").await.unwrap();
    socket.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");

    let second = tokio::spawn(raw_get(addr, "/", ""));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!second.is_finished(), "a second connection waits while a WebSocket is open");
    socket.write_all(b"pong").await.unwrap();
    socket.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"pong", "the WebSocket is still open");
    drop(socket);
    let answer = tokio::time::timeout(Duration::from_secs(3), second).await.expect("served once the WebSocket closes").unwrap();
    assert!(answer.ends_with("hi"), "{answer}");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// A switched connection counts until its route drops the socket, not until the client closes
/// it: a route that returns after one echo gives its place back while the client still holds its
/// TCP connection open, and the next connection is served (#1249).
#[tokio::test]
async fn a_switched_connection_stops_counting_when_its_route_drops_the_socket() {
    use crate::upgrade::{Switch, Upgrade};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn once(upgrade: Upgrade) -> crate::Result<Switch> {
        upgrade.websocket(|mut stream: crate::upgrade::Stream, _: crate::Signal| async move {
            let mut buf = [0u8; 4];
            if stream.read_exact(&mut buf).await.is_ok() {
                let _ = stream.write_all(&buf).await;
            }
        })
    }
    let routes = Table::new().route("/ws", get(once)).route("/", get(|| async { "hi" }));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(routes)).max_connections(1);
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
    socket
        .write_all(b"GET /ws HTTP/1.1\r\nhost: localhost\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
        .await
        .unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(socket.read_u8().await.expect("the switch's head"));
    }
    assert!(head.starts_with(b"HTTP/1.1 101"), "{}", String::from_utf8_lossy(&head));
    socket.write_all(b"ping").await.unwrap();
    let mut echoed = [0u8; 4];
    socket.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
    // The route has returned and dropped its stream; the client keeps its end open.
    let answer = tokio::time::timeout(Duration::from_secs(3), raw_get(addr, "/", ""))
        .await
        .expect("served once the route dropped the socket, with the client's end still open");
    assert!(answer.ends_with("hi"), "{answer}");
    let mut rest = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut rest)).await;
    assert!(matches!(closed, Ok(Ok(0))), "the server closed its end when the route dropped it: {closed:?}");
    drop(socket);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// Over `corten::serve_wrapped`, a connection that switches after its step holds its place under
/// `App::max_connections` as a plain one does: the next connection waits while the WebSocket is
/// open and is served once it closes (#1249).
#[tokio::test]
async fn a_switched_connection_after_a_step_counts_against_max_connections() {
    use crate::upgrade::{Switch, Upgrade};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // A stand-in for a handshake: the client sends "hello\n" first.
    async fn hello(mut tcp: tokio::net::TcpStream) -> std::io::Result<(tokio::net::TcpStream, ())> {
        let mut greeting = [0u8; 6];
        tcp.read_exact(&mut greeting).await?;
        match &greeting {
            b"hello\n" => Ok((tcp, ())),
            _ => Err(std::io::Error::other("not a greeting")),
        }
    }
    async fn hold(upgrade: Upgrade) -> crate::Result<Switch> {
        upgrade.websocket(|mut stream: crate::upgrade::Stream, _: crate::Signal| async move {
            let mut buf = [0u8; 64];
            while matches!(stream.read(&mut buf).await, Ok(n) if n > 0) {}
        })
    }
    let routes = Table::new().route("/ws", get(hold)).route("/", get(|| async { "hi" }));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(routes)).max_connections(1);
    let server = tokio::spawn(crate::app::run(listeners, hello, app, async {
        let _ = stopped.await;
    }));
    let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
    socket
        .write_all(b"hello\nGET /ws HTTP/1.1\r\nhost: localhost\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
        .await
        .unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(socket.read_u8().await.expect("the switch's head"));
    }
    assert!(head.starts_with(b"HTTP/1.1 101"), "{}", String::from_utf8_lossy(&head));
    let second = tokio::spawn(async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(b"hello\nGET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        answer
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!second.is_finished(), "a second connection waits while a WebSocket after a step is open");
    drop(socket);
    let answer = tokio::time::timeout(Duration::from_secs(3), second).await.expect("served once the WebSocket closes").unwrap();
    assert!(answer.ends_with("hi"), "{answer}");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// A `2xx` to `CONNECT` switches the connection to a tunnel, as a `101` does, so
/// `App::header_timeout` no longer bounds it: a tunnel carrying bytes both ways stays open past
/// twice the timeout, and so does one where neither side sends (its idle time is the route's), and
/// `App::send_timeout` still ends a write its client makes no room for. The tunnel still counts
/// against `App::max_connections`: with one allowed, the next connection waits while it is open
/// and is served once it closes (#1249).
/// A `CONNECT` refused (`403`) is an answer like any other, and its connection closes once idle
/// past the timeout (#1218).
#[tokio::test]
async fn a_connect_tunnel_outlives_the_header_timeout_and_a_refused_connect_does_not() {
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (failed, mut failure) = tokio::sync::mpsc::channel::<std::io::ErrorKind>(1);
    let tunnel = crate::router::any(move |mut req: Request<Body>| {
        let failed = failed.clone();
        async move {
            if req.headers().contains_key("x-refuse") {
                return StatusCode::FORBIDDEN;
            }
            let flood = req.headers().contains_key("x-flood");
            let on = hyper::upgrade::on(&mut req);
            tokio::spawn(async move {
                let Ok(upgraded) = on.await else { return };
                let mut io = hyper_util::rt::TokioIo::new(upgraded);
                if flood {
                    let chunk = vec![b'x'; 64 * 1024];
                    loop {
                        if let Err(error) = io.write_all(&chunk).await {
                            let _ = failed.send(error.kind()).await;
                            return;
                        }
                    }
                }
                // Relays the client's bytes back to it.
                let mut buf = [0u8; 64];
                loop {
                    match io.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) if io.write_all(&buf[..n]).await.is_err() => return,
                        Ok(_) => {}
                    }
                }
            });
            StatusCode::OK
        }
    });
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let timeout = Duration::from_millis(600);
    let app = App::new(Routes::from(Table::new().route("/", tunnel)))
        .header_timeout(timeout)
        .send_timeout(Duration::from_millis(300))
        .max_connections(1);
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    // The answer's head, a byte at a time so nothing after it is taken.
    async fn head(stream: &mut tokio::net::TcpStream) -> String {
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(stream.read_u8().await.expect("an answer's head"));
        }
        String::from_utf8(head).unwrap()
    }

    let mut tunnel = tokio::net::TcpStream::connect(addr).await.unwrap();
    tunnel.write_all(b"CONNECT / HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    let answer = head(&mut tunnel).await;
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    let opened = Instant::now();
    let mut sent = 0u32;
    while opened.elapsed() < timeout * 5 / 2 {
        let ping = format!("ping {sent}\n");
        tunnel.write_all(ping.as_bytes()).await.unwrap();
        let mut echo = vec![0u8; ping.len()];
        let read = tokio::time::timeout(Duration::from_secs(3), tunnel.read_exact(&mut echo)).await;
        match read {
            Ok(Ok(_)) => assert_eq!(echo, ping.as_bytes()),
            Ok(Err(error)) => panic!("the tunnel closed {:?} after it opened: {error}", opened.elapsed()),
            Err(_) => panic!("no echo {:?} after the tunnel opened", opened.elapsed()),
        }
        sent += 1;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // Then neither side sends for longer than twice the timeout, and the tunnel still relays.
    tokio::time::sleep(timeout * 5 / 2).await;
    tunnel.write_all(b"after a quiet spell\n").await.unwrap();
    let mut echo = [0u8; 20];
    let read = tokio::time::timeout(Duration::from_secs(3), tunnel.read_exact(&mut echo)).await;
    assert!(matches!(read, Ok(Ok(_))), "an idle tunnel is held past the header timeout: {read:?}");
    assert_eq!(&echo, b"after a quiet spell\n");

    // With one connection allowed, the next waits in the listener's queue while the tunnel is
    // open, and is served once the tunnel closes (#1249). Nothing of its answer has arrived, so
    // dropping the first read takes nothing.
    let mut flood = tokio::net::TcpStream::connect(addr).await.unwrap();
    flood.write_all(b"CONNECT / HTTP/1.1\r\nhost: localhost\r\nx-flood: 1\r\n\r\n").await.unwrap();
    let waited = tokio::time::timeout(Duration::from_millis(300), head(&mut flood)).await;
    assert!(waited.is_err(), "a second connection waits while a tunnel is open: {waited:?}");
    drop(tunnel);
    let answer = tokio::time::timeout(Duration::from_secs(3), head(&mut flood)).await.expect("served once the tunnel closes");
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    // The send timeout on a tunnel, which held before the fix too: a client that reads nothing
    // more has the route's write fail.
    let kind = tokio::time::timeout(Duration::from_secs(5), failure.recv()).await.expect("the tunnel's write fails");
    assert_eq!(kind, Some(std::io::ErrorKind::TimedOut));
    drop(flood);

    let mut refused = tokio::net::TcpStream::connect(addr).await.unwrap();
    let asked = Instant::now();
    refused.write_all(b"CONNECT / HTTP/1.1\r\nhost: localhost\r\nx-refuse: 1\r\n\r\n").await.unwrap();
    let mut answer = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), refused.read_to_end(&mut answer)).await;
    let lasted = asked.elapsed();
    let answer = String::from_utf8_lossy(&answer);
    assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
    assert!(closed.is_ok(), "a refused CONNECT's connection is closed once idle past the timeout");
    // Closed by the header timeout, not at once after the answer. Half the timeout leaves room for
    // a clock thread that ticked late, which dates the idle connection earlier.
    assert!(lasted >= timeout / 2, "closed {lasted:?} after the refused CONNECT, before the header timeout");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// A `2xx` to `CONNECT` whose handler says `Content-Length` (as one that writes `0` itself,
/// `Media::stream_sized` or a `Relay` of an upstream's `2xx` may) is sent without it, as RFC 9110
/// 9.3.6 asks, and opens its tunnel: hyper refuses to send a head that has it, which left the
/// client a closed connection and no answer (#1915).
#[tokio::test]
async fn a_connect_answered_with_a_length_is_sent_without_it() {
    a_tunnel_answered_with(header::CONTENT_LENGTH, "0").await;
}

/// As `a_connect_answered_with_a_length_is_sent_without_it`, for `Transfer-Encoding`.
#[tokio::test]
async fn a_connect_answered_chunked_is_sent_without_transfer_encoding() {
    a_tunnel_answered_with(header::TRANSFER_ENCODING, "chunked").await;
}

/// Asks over a socket for a tunnel whose route answers `200` with `name: value`, and checks that
/// the head arrives with neither `Content-Length` nor `Transfer-Encoding` and the tunnel echoes.
async fn a_tunnel_answered_with(name: http::HeaderName, value: &'static str) {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let said = name.clone();
    let tunnel = crate::router::any(move |mut req: Request<Body>| {
        let name = said.clone();
        async move {
            let on = hyper::upgrade::on(&mut req);
            tokio::spawn(async move {
                let Ok(upgraded) = on.await else { return };
                let mut io = hyper_util::rt::TokioIo::new(upgraded);
                let mut buf = [0u8; 64];
                loop {
                    match io.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) if io.write_all(&buf[..n]).await.is_err() => return,
                        Ok(_) => {}
                    }
                }
            });
            (StatusCode::OK, [(name, value)])
        }
    });
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(Table::new().route("/", tunnel)));
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));

    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream.write_all(b"CONNECT / HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    // The head, a byte at a time so nothing after it is taken.
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let byte = tokio::time::timeout(Duration::from_secs(3), stream.read_u8()).await.expect("an answer in time");
        let byte = byte
            .unwrap_or_else(|error| panic!("{name}: the connection closed ({error}) after {:?}", String::from_utf8_lossy(&head)));
        head.push(byte);
    }
    let head = String::from_utf8(head).unwrap().to_ascii_lowercase();
    assert!(head.starts_with("http/1.1 200"), "{name}: {head}");
    assert!(!head.contains("\r\ncontent-length:") && !head.contains("\r\ntransfer-encoding:"), "{name}: {head}");
    stream.write_all(b"through the tunnel\n").await.unwrap();
    let mut echo = [0u8; 19];
    tokio::time::timeout(Duration::from_secs(3), stream.read_exact(&mut echo)).await.expect("an echo").unwrap();
    assert_eq!(&echo, b"through the tunnel\n", "{name}");
    drop(stream);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// `corten::serve_wrapped`: the app's step on each connection before HTTP (a TLS handshake) runs
/// in the connection's own task, counts against `App::max_connections` and is closed at
/// `App::header_timeout` when it stalls; a step that fails closes the connection.
#[tokio::test]
async fn a_step_before_http_is_counted_and_timed_as_the_connection() {
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // A stand-in for a handshake: the client sends "hello\n" first, anything else fails it.
    async fn hello(
        mut tcp: tokio::net::TcpStream,
    ) -> std::io::Result<(tokio::net::TcpStream, crate::ConnectionInfo<&'static str>)> {
        let mut greeting = [0u8; 6];
        tcp.read_exact(&mut greeting).await?;
        match &greeting {
            b"hello\n" => Ok((tcp, crate::ConnectionInfo("verified"))),
            _ => Err(std::io::Error::other("not a greeting")),
        }
    }
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let routes = Routes::from(Table::new().route("/", get(|| async { "hi" })));
    // Long enough that the two clocks below differ by far more than a loaded machine's delay.
    let app = App::new(routes).header_timeout(Duration::from_millis(600)).max_connections(1);
    let server = tokio::spawn(crate::app::run(listeners, hello, app, async {
        let _ = stopped.await;
    }));
    let request = |greeting: &'static [u8]| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut sent = greeting.to_vec();
        sent.extend_from_slice(b"GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n");
        // A failed step may close the connection before all of it is read.
        let _ = stream.write_all(&sent).await;
        let mut answer = String::new();
        let _ = stream.read_to_string(&mut answer).await;
        answer
    };
    assert!(request(b"hello\n").await.ends_with("hi"), "after its step, the connection is HTTP");
    assert_eq!(request(b"howdy\n").await, "", "a step that fails closes the connection");

    // A client that opens a connection and never finishes its step holds the only slot, until
    // the header timeout closes it.
    let started = Instant::now();
    let mut stalled = tokio::net::TcpStream::connect(addr).await.unwrap();
    stalled.write_all(b"hel").await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let next = tokio::spawn(request(b"hello\n"));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!next.is_finished(), "a connection in its step counts against max_connections");
    let mut rest = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), stalled.read_to_end(&mut rest)).await;
    assert!(closed.is_ok(), "a stalled step is not held past the header timeout");
    // The clock closes it within a tick (a tenth of the timeout, 60 ms) of 600 ms from the accept,
    // either way, and earlier by as much as the clock's thread ran late on a loaded machine, as
    // idle time is counted from its last tick: 400 ms leaves 140 ms for that, well after the
    // check at 200 ms.
    assert!(started.elapsed() >= Duration::from_millis(400), "{:?}", started.elapsed());
    let answer = tokio::time::timeout(Duration::from_secs(3), next).await.expect("answered once it closes").unwrap();
    assert!(answer.ends_with("hi"), "{answer}");

    // A step that takes half the timeout leaves the rest for the head: the timeout counts from
    // the accept, not from earlier.
    let mut half = tokio::net::TcpStream::connect(addr).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    half.write_all(b"hello\nGET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    let mut answer = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), half.read_to_string(&mut answer)).await;
    assert!(answer.ends_with("hi"), "a head sent after a step is answered: {answer:?}");

    // One clock from the accept to the head: a step that takes most of the timeout leaves the
    // rest for the head, not the whole timeout again. It closes within a tick (60 ms) of 600 ms
    // from the accept; a second clock would close it within a tick of 1,000 ms. The bound leaves
    // about 190 ms after the first and 90 ms before the second, so a loaded machine's delay does
    // not fail it (#594).
    let started = Instant::now();
    let mut slow = tokio::net::TcpStream::connect(addr).await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    slow.write_all(b"hello\n").await.unwrap();
    let mut rest = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), slow.read_to_end(&mut rest)).await;
    assert!(closed.is_ok(), "a connection with no head after its step is closed");
    assert!(started.elapsed() < Duration::from_millis(850), "at the header timeout from the accept: {:?}", started.elapsed());

    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    // Shutdown ends a step in progress, with no header timeout to end it otherwise.
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let routes = Routes::from(Table::new().route("/", get(|| async { "hi" })));
    let server = tokio::spawn(crate::app::run(listeners, hello, App::new(routes).header_timeout(None), async {
        let _ = stopped.await;
    }));
    let mut stalled = tokio::net::TcpStream::connect(addr).await.unwrap();
    stalled.write_all(b"hel").await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), server).await.expect("shutdown does not wait for a step").unwrap().unwrap();
    let mut rest = Vec::new();
    assert_eq!(stalled.read_to_end(&mut rest).await.map(|_| rest.len()).unwrap_or(0), 0, "and closes it");
}

/// A route that takes `Upgrade` switches the connection: a WebSocket handshake from the page's own
/// origin or from a client that is not a browser gets its 101 and then the bytes, one from another
/// site is refused as a cross-site write is, and a request that does not ask to switch is a 400,
/// or, where the route takes `Option<Upgrade>`, its other answer.
#[tokio::test]
async fn an_upgrade_route_switches_for_its_own_origin_and_refuses_other_sites() {
    use crate::upgrade::{Switch, SwitchOr, Upgrade};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn echo(mut stream: crate::upgrade::Stream, _: crate::Signal) {
        let mut buf = [0u8; 64];
        while let Ok(n @ 1..) = stream.read(&mut buf).await {
            if stream.write_all(&buf[..n]).await.is_err() {
                break;
            }
        }
    }
    let routes = Table::new()
        .route("/ws", get(|upgrade: Upgrade| async move { upgrade.websocket(echo) }))
        .route(
            "/ws-400",
            get(|upgrade: Upgrade| async move { upgrade.websocket(echo).map_err(|e| e.with_status(StatusCode::BAD_REQUEST)) }),
        )
        .route(
            "/ws-404",
            get(|upgrade: Upgrade| async move { upgrade.websocket(echo).map_err(|e| e.with_status(StatusCode::NOT_FOUND)) }),
        )
        // `Error::new` on a `corten::Error` keeps its source, here a wrong version, at 500.
        .route("/ws-500", get(|upgrade: Upgrade| async move { upgrade.websocket(echo).map_err(crate::Error::new) }))
        .route(
            "/tunnel",
            get(|upgrade: Upgrade| async move {
                let mut headers = http::HeaderMap::new();
                headers.insert("x-upstream", "yes".parse().unwrap());
                Ok::<Switch, crate::Error>(upgrade.switch(headers, echo))
            }),
        )
        .route(
            "/either",
            get(|upgrade: Option<Upgrade>| async move {
                match upgrade {
                    Some(upgrade) => Ok::<_, crate::Error>(upgrade.websocket(echo)?.into()),
                    None => Ok(SwitchOr::Answer("not a socket")),
                }
            }),
        );
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::from(routes)).error_page(test_error_page, ()).api::<ApiRoot>(|api| {
        api.route::<ApiWs>(crate::Methods::reads(get(|upgrade: Upgrade| async move { upgrade.websocket(echo) })))
            .allow_origin("https://partner.example")
    });
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    // The answer's head, and the connection for what follows it.
    let handshake = |path: &'static str, protocol: &'static str, extra: &'static str| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "GET {path} HTTP/1.1\r\nhost: localhost\r\nconnection: keep-alive, Upgrade\r\nupgrade: {protocol}\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n{extra}\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0u8; 1];
            if stream.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            head.push(byte[0]);
        }
        (String::from_utf8(head).unwrap().to_ascii_lowercase(), stream)
    };
    let echoes = |mut stream: tokio::net::TcpStream| async move {
        stream.write_all(b"ping").await.unwrap();
        let mut back = [0u8; 4];
        stream.read_exact(&mut back).await.unwrap();
        &back == b"ping"
    };

    let (head, stream) = handshake("/ws", "websocket", "origin: http://localhost\r\nsec-fetch-site: same-origin\r\n").await;
    assert!(head.starts_with("http/1.1 101"), "{head}");
    assert!(head.contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo="), "{head}");
    assert!(echoes(stream).await, "the switched connection carries bytes both ways");

    let (head, stream) = handshake("/ws", "websocket", "").await;
    assert!(head.starts_with("http/1.1 101"), "a client that is not a browser switches: {head}");
    assert!(echoes(stream).await);

    let (head, _) = handshake("/ws", "websocket", "origin: https://evil.example\r\nsec-fetch-site: cross-site\r\n").await;
    assert!(head.starts_with("http/1.1 403"), "another site's page cannot open it with the user's cookies: {head}");
    let (head, _) = handshake("/ws", "websocket", "origin: https://evil.example\r\n").await;
    assert!(head.starts_with("http/1.1 403"), "nor an older browser's, by its Origin alone: {head}");

    let (head, _) = handshake("/ws", "chat", "").await;
    assert!(head.starts_with("http/1.1 400"), "only a WebSocket handshake is accepted as one: {head}");

    // Another version, or none (taken as one it does not support): a 426 that says which.
    for version in ["sec-websocket-version: 8\r\n", ""] {
        for path in ["/ws", "/either", "/api/ws"] {
            for accept in ["text/html", "application/json"] {
                let refused = raw_get(
                    addr,
                    path,
                    &format!("connection: upgrade\r\nupgrade: websocket\r\n{version}sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\naccept: {accept}\r\n"),
                )
                .await;
                let head = refused.split("\r\n\r\n").next().unwrap().to_ascii_lowercase();
                assert!(head.starts_with("http/1.1 426"), "{refused}");
                assert!(head.lines().any(|line| line == "sec-websocket-version: 13"), "{refused}");
                assert!(head.lines().any(|line| line == "upgrade: websocket"), "{refused}");
                assert!(connection_upgrade(&head), "{refused}");
                if path == "/api/ws" || accept == "application/json" {
                    assert!(head.contains("content-type: application/problem+json"), "{refused}");
                }
                if path == "/ws" && accept == "text/html" {
                    assert!(refused.contains("Something went wrong"), "the custom error page keeps the headers: {refused}");
                }
            }
        }
    }
    // A handler that answers it at another status still says which version (RFC 6455, 4.2.2),
    // but only a 426 names a protocol to switch to.
    let refused = raw_get(
        addr,
        "/ws-400",
        "connection: upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 8\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
    )
    .await;
    let head = refused.split("\r\n\r\n").next().unwrap().to_ascii_lowercase();
    assert!(head.starts_with("http/1.1 400"), "{refused}");
    assert!(head.lines().any(|line| line == "sec-websocket-version: 13"), "{refused}");
    assert!(!head.contains("\r\nupgrade:") && !connection_upgrade(&head), "{refused}");
    // Any other status says nothing of the socket: a 404 that hides it, or a 500.
    for (path, status) in [("/ws-404", "404"), ("/ws-500", "500")] {
        let refused = raw_get(
            addr,
            path,
            "connection: upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 8\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
        )
        .await;
        let head = refused.split("\r\n\r\n").next().unwrap().to_ascii_lowercase();
        assert!(head.starts_with(&format!("http/1.1 {status}")), "{refused}");
        assert!(!head.contains("\r\nsec-websocket-version:"), "{refused}");
        assert!(!head.contains("\r\nupgrade:") && !connection_upgrade(&head), "{refused}");
    }

    // The connection a 426 went out on (with `Connection: upgrade`) serves the next request.
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"GET /ws HTTP/1.1\r\nhost: localhost\r\nconnection: keep-alive, upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 8\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
        .await
        .unwrap();
    let (head, _) = read_answer(&mut stream).await;
    assert!(head.starts_with("http/1.1 426") && connection_upgrade(&head), "{head}");
    stream.write_all(b"GET /either HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await.unwrap();
    let (head, body) = read_answer(&mut stream).await;
    assert!(head.starts_with("http/1.1 200") && body == "not a socket", "{head}{body}");

    // HTTP/1.0 cannot switch, so its `Upgrade` is ignored (RFC 9110, 7.8): `/either` answers its
    // page, and a route that only switches a plain 400.
    let http10 = |path: &'static str| async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "GET {path} HTTP/1.0\r\nhost: localhost\r\nconnection: upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        answer
    };
    let answer = http10("/either").await;
    assert!(answer.starts_with("HTTP/1.") && answer.contains(" 200 ") && answer.ends_with("not a socket"), "{answer}");
    let answer = http10("/ws").await;
    assert!(answer.contains(" 400 ") && !answer.to_ascii_lowercase().contains("\r\nupgrade:"), "{answer}");

    for path in ["/ws", "/tunnel"] {
        let plain = raw_get(addr, path, "").await;
        assert!(plain.starts_with("HTTP/1.1 400"), "{plain}");
        assert!(!plain.to_ascii_lowercase().contains("\r\nupgrade:"), "the route's protocol is not known: {plain}");
    }

    let (head, stream) = handshake("/either", "websocket", "").await;
    assert!(head.starts_with("http/1.1 101"), "{head}");
    assert!(echoes(stream).await);
    let plain = raw_get(addr, "/either", "").await;
    assert!(plain.starts_with("HTTP/1.1 200") && plain.ends_with("not a socket"), "{plain}");
    let (head, _) = handshake("/either", "websocket", "origin: https://evil.example\r\nsec-fetch-site: cross-site\r\n").await;
    assert!(head.starts_with("http/1.1 403"), "a switch it asks for is held to what Upgrade is: {head}");

    // An API's allowed site may open its sockets, as it may write to it, but not with cookies.
    let partner = "origin: https://partner.example\r\nsec-fetch-site: cross-site\r\n";
    let (head, stream) = handshake("/api/ws", "websocket", partner).await;
    assert!(head.starts_with("http/1.1 101"), "{head}");
    assert!(echoes(stream).await);
    let (head, _) = handshake(
        "/api/ws",
        "websocket",
        "origin: https://partner.example\r\nsec-fetch-site: cross-site\r\ncookie: session=abc\r\n",
    )
    .await;
    assert!(head.starts_with("http/1.1 403"), "{head}");
    let (head, _) = handshake("/ws", "websocket", partner).await;
    assert!(head.starts_with("http/1.1 403"), "the pages' sockets still refuse the partner: {head}");

    let (head, stream) = handshake("/tunnel", "remote", "").await;
    assert!(head.starts_with("http/1.1 101") && head.contains("x-upstream: yes") && head.contains("upgrade: remote"), "{head}");
    assert!(echoes(stream).await);

    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// Whether a lowercased response head has `upgrade` among its `Connection` tokens.
fn connection_upgrade(head: &str) -> bool {
    head.lines()
        .filter_map(|line| line.strip_prefix("connection: "))
        .flat_map(|line| line.split(','))
        .any(|token| token.trim() == "upgrade")
}

/// One answer read from a kept-alive connection: its lowercased head and its body, which must
/// have a `Content-Length`.
async fn read_answer(stream: &mut tokio::net::TcpStream) -> (String, String) {
    use tokio::io::AsyncReadExt;
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8; 1];
        assert_eq!(stream.read(&mut byte).await.unwrap(), 1, "the connection closed: {}", String::from_utf8_lossy(&head));
        head.push(byte[0]);
    }
    let head = String::from_utf8(head).unwrap().to_ascii_lowercase();
    let length: usize = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length: "))
        .unwrap_or_else(|| panic!("no content-length: {head}"))
        .trim()
        .parse()
        .unwrap();
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await.unwrap();
    (head, String::from_utf8(body).unwrap())
}

/// An API's own error shape (`Api::errors`) keeps a 426's headers.
#[cfg(feature = "json")]
#[tokio::test]
async fn a_wrong_websocket_version_keeps_its_headers_in_an_apis_error_shape() {
    use crate::upgrade::Upgrade;
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = App::new(Routes::new()).api::<ApiRoot>(|api| {
        api.route::<ApiWs>(crate::Methods::reads(get(|upgrade: Upgrade| async move { upgrade.websocket(|_, _| async {}) })))
            .errors(|status, message| ShapedError {
                r#type: "error",
                error: ShapedDetail { code: status.as_u16(), message: message.to_string() },
            })
    });
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let refused = raw_get(
        addr,
        "/api/ws",
        "connection: upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 8\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
    )
    .await;
    let (head, body) = refused.split_once("\r\n\r\n").unwrap();
    let head = head.to_ascii_lowercase();
    assert!(head.starts_with("http/1.1 426"), "{refused}");
    assert!(head.lines().any(|line| line == "content-type: application/json"), "{refused}");
    assert!(body.starts_with(r#"{"type":"error","error":{"code":426,"#), "the API's own shape: {refused}");
    assert!(head.lines().any(|line| line == "sec-websocket-version: 13"), "{refused}");
    assert!(head.lines().any(|line| line == "upgrade: websocket"), "{refused}");
    assert!(connection_upgrade(&head), "{refused}");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

#[derive(crate::Route)]
#[route("/api/ws")]
struct ApiWs;

#[tokio::test]
async fn an_upgrade_without_a_switchable_connection_is_a_400_without_upgrade() {
    use crate::upgrade::Upgrade;
    let routes =
        || Routes::from(Table::new().route("/ws", get(|upgrade: Upgrade| async move { upgrade.websocket(|_, _| async {}) })));
    let router = App::new(routes()).router();
    for version in [http::Version::HTTP_11, http::Version::HTTP_2] {
        let req = Request::get("/ws")
            .version(version)
            .header("connection", "upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .body(Body::empty())
            .unwrap();
        let res = router.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(!res.headers().contains_key(header::UPGRADE));
        assert!(!res.headers().contains_key(header::CONNECTION));
    }
    let client = App::new(routes()).test();
    let res = client
        .get(&crate::Local::parse("/ws").unwrap())
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
        .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert!(!res.headers().contains_key(header::UPGRADE));
    assert!(!res.headers().contains_key(header::CONNECTION));
}

/// A handshake with no `Sec-Fetch-Site` (what Chromium and Firefox send) is held to its `Origin`
/// against the requested authority, scheme included once the app says it is HTTPS only: a plain-http page on the
/// app's host cannot open a socket to the HTTPS app with the user's `Secure` cookies (#1212).
/// Allowed, a oneshot answers 400, since it cannot switch; refused, 403.
#[tokio::test]
async fn a_handshake_without_sec_fetch_site_is_held_to_the_scheme_under_hsts() {
    use crate::security::Policy;
    use crate::upgrade::Upgrade;
    async fn nothing(_: crate::upgrade::Stream, _: crate::Signal) {}
    let app = |policy: Policy| {
        App::new(Routes::from(Table::new().route("/ws", get(|upgrade: Upgrade| async move { upgrade.websocket(nothing) }))))
            .policy(policy.host("app.example"))
    };
    let at = |router: crate::Router, uri: &'static str, origin: &'static str, host: &'static str| async move {
        let req = Request::get(uri)
            .header("host", host)
            .header("origin", origin)
            .header("connection", "upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .body(Body::empty())
            .unwrap();
        router.oneshot(req).await.unwrap().status()
    };
    let (open, refused) = (StatusCode::BAD_REQUEST, StatusCode::FORBIDDEN);
    let router = app(Policy::new()).router();
    for (origin, expected) in [("http://localhost", open), ("http://proxy.example", refused)] {
        assert_eq!(at(router.clone(), "http://localhost/ws", origin, "proxy.example").await, expected, "{origin}");
    }
    struct PathOnly;
    impl crate::Middleware for PathOnly {
        async fn call(&self, mut req: crate::http::Request, next: impl crate::Next) -> crate::response::Response {
            *req.uri_mut() = http::Uri::from_static("/ws");
            next.run(req).await
        }
    }
    let rewritten = app(Policy::new()).middleware(PathOnly).router();
    assert_eq!(
        at(rewritten, "http://localhost/ws", "http://localhost", "proxy.example").await,
        refused,
        "admission used the target, but the extractor no longer has its authority"
    );
    let status = |router, origin, host| at(router, "/ws", origin, host);
    let https_only = app(Policy::new().hsts()).router();
    let either = app(Policy::new()).router();
    assert_eq!(status(https_only.clone(), "http://app.example", "app.example").await, refused, "a plain-http page");
    assert_eq!(status(https_only.clone(), "https://app.example", "app.example").await, open);
    assert_eq!(status(https_only.clone(), "https://app.example", "app.example:443").await, open, "the default port");
    assert_eq!(status(https_only.clone(), "https://app.example", "app.example:8443").await, refused, "another port");
    // Loopback is secure over plain http, and Chromium and Firefox send no `Sec-Fetch-Site` there.
    assert_eq!(status(https_only.clone(), "http://localhost:3000", "localhost:3000").await, open, "loopback");
    assert_eq!(status(https_only.clone(), "http://192.168.1.5", "192.168.1.5").await, refused, "a LAN page");
    assert_eq!(status(https_only, "capacitor://localhost", "localhost").await, refused, "an app's own scheme");
    // Without hsts the app cannot tell its public scheme behind a proxy that ends TLS.
    assert_eq!(status(either.clone(), "http://app.example", "app.example").await, open);
    assert_eq!(status(either.clone(), "http://192.168.1.5", "192.168.1.5").await, open);
    assert_eq!(status(either.clone(), "https://app.example", "app.example").await, open);
    assert_eq!(status(either.clone(), "http://app.example", "app.example:80").await, open, "the default port");
    assert_eq!(status(either, "http://app.example:443", "app.example").await, refused, "not http's default port");
}

/// `corten::serve` gives each request its connection's peer, which `ClientIp` reads. A proxy's `X-Forwarded-For` is followed only when the
/// app trusts the peer, and the answer is private to the address.
#[tokio::test]
async fn the_client_ip_is_the_peer_or_what_a_trusted_proxy_forwards() {
    let app = |policy: crate::security::Policy| {
        let routes = Table::new().route("/ip", get(|crate::ClientIp(ip): crate::ClientIp| async move { ip.to_string() }));
        App::new(Routes::from(routes)).policy(policy)
    };
    let body = |answer: &str| answer.rsplit("\r\n").next().unwrap().to_string();
    let forwarded = "x-forwarded-for: 1.1.1.1, 198.51.100.7\r\n";

    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app(crate::security::Policy::new()), async {
        let _ = stopped.await;
    }));
    let answer = raw_get(addr, "/ip", forwarded).await;
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    assert_eq!(body(&answer), "127.0.0.1", "without a trusted proxy the header is anyone's");
    assert!(answer.to_ascii_lowercase().contains("cache-control: private"), "{answer}");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let behind = app(crate::security::Policy::new().proxy("127.0.0.0/8"));
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, behind, async {
        let _ = stopped.await;
    }));
    assert_eq!(body(&raw_get(addr, "/ip", forwarded).await), "198.51.100.7");
    assert_eq!(body(&raw_get(addr, "/ip", "").await), "127.0.0.1");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// Without a connection (a test's `oneshot`), `ClientIp` is a 500 that says why and
/// `Option<ClientIp>` is `None`; a layer that gives the request its peer gives it one.
#[tokio::test]
async fn without_a_connection_there_is_no_client_ip() {
    let routes = || {
        Table::new()
            .route("/ip", get(|crate::ClientIp(ip): crate::ClientIp| async move { ip.to_string() }))
            .route("/maybe", get(|ip: Option<crate::ClientIp>| async move { format!("{ip:?}") }))
    };
    let router = App::new(Routes::from(routes())).router();
    let (status, _, _) = call_with(router.clone(), "GET", "/ip", None, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let (status, _, body) = call_with(router, "GET", "/maybe", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "None"));
    let mocked = App::new(Routes::from(routes())).router().layer(peer(std::net::SocketAddr::from(([203, 0, 113, 9], 4711))));
    let (status, _, body) = call_with(mocked, "GET", "/ip", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "203.0.113.9"));
}

/// A task of the app's is told when shutdown begins, and `serve` waits for it to finish what it
/// was writing before it returns.
#[tokio::test]
async fn shutdown_tells_the_tasks_and_waits_for_them() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let written = Arc::new(AtomicBool::new(false));
    let (reason_tx, reason) = tokio::sync::oneshot::channel();
    let journal = written.clone();
    let app = App::new(Routes::new()).task("journal", move |signal: Signal| async move {
        let why = signal.aborted().await;
        // The write in progress when the signal came.
        tokio::time::sleep(Duration::from_millis(100)).await;
        journal.store(true, Ordering::SeqCst);
        let _ = reason_tx.send(why);
    });
    let (stop, server) = served(app).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!server.is_finished() && !written.load(Ordering::SeqCst));
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
    assert!(written.load(Ordering::SeqCst), "serve returned before the task finished");
    assert_eq!(reason.await.unwrap(), crate::Abort::Shutdown);
}

/// A task that ignores the signal is ended at the grace, so it cannot hold the process; one that
/// panics ends alone, and the app keeps serving.
#[tokio::test]
async fn a_task_past_the_grace_is_ended_and_one_that_panics_ends_alone() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let dropped = Arc::new(AtomicBool::new(false));
    let guard = Dropped(dropped.clone());
    let routes = Routes::from(Table::new().route("/", get(|| async { "hi" })));
    let app = App::new(routes)
        .shutdown_grace(Duration::from_millis(50))
        .task("stuck", move |_signal: Signal| async move {
            let _guard = guard;
            std::future::pending::<()>().await
        })
        .task("broken", |_signal: Signal| async move { panic!("the task failed") });
    let (stop, server) = served(app).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!server.is_finished(), "a task that panicked took the server with it");
    let started = std::time::Instant::now();
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), server).await.expect("a stuck task held serve").unwrap().unwrap();
    assert!(started.elapsed() >= Duration::from_millis(50), "serve did not wait the grace");
    tokio::time::timeout(Duration::from_secs(1), async {
        while !dropped.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the stuck task was left running");
}

/// A `[::1]` port another process holds is an error, not a server only `127.0.0.1` reaches:
/// `http://localhost` would get the other process.
#[tokio::test]
async fn a_taken_ipv6_loopback_port_is_an_error() {
    if !has_ipv6_loopback() {
        return;
    }
    // The test needs the number it takes on `::1` free on `127.0.0.1`, which nothing reserves: a
    // test running beside it may hold it there (#1203), so a number busy there is tried again. The
    // probe cannot be held through the test: `bind(None, ..)` would then fail on `127.0.0.1`, not on
    // the `::1` port this is about, so a number taken in between is caught by the retry instead.
    let mut busy = "";
    for _ in 0..8 {
        let taken = std::net::TcpListener::bind("[::1]:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
            busy = "before the test";
            continue;
        }
        let error = crate::app::bind(None, port).await.expect_err("the port is taken on ::1");
        assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
        match crate::app::bind(Some("127.0.0.1"), port).await {
            Ok(listeners) => {
                assert_eq!(listeners.len(), 1, "HOST names one address");
                return;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => busy = "by the time HOST bound it",
            Err(error) => panic!("{error}"),
        }
    }
    panic!("each of 8 ports taken on ::1 was busy on 127.0.0.1 too, the last {busy}");
}

/// Work a handler finishes (`Signal::finish`) runs past the handler being dropped: its slow step
/// sees why it should stop, and what follows it (a release) runs, whether the client left, the
/// deadline passed or the server is shutting down, which waits for it.
#[tokio::test]
async fn finished_work_releases_what_it_holds_when_the_handler_is_dropped() {
    use std::{sync::Mutex, time::Duration};
    use tokio::io::AsyncWriteExt;
    let released: Arc<Mutex<Vec<(&'static str, crate::Abort)>>> = Arc::default();
    let routes = {
        let released = released.clone();
        Routes::from(Table::new().route(
            "/{name}",
            get(move |signal: crate::Signal, Num(name): Num<String>| {
                let released = released.clone();
                async move {
                    let name: &'static str = Box::leak(name.into_boxed_str());
                    signal
                        .finish(move |signal| async move {
                            // The slow call, which only the signal ends.
                            let reason = signal.aborted().await;
                            // A release that outlasts the connection: `/slow-release` takes 500 ms.
                            let release = if name == "gone" { 500 } else { 30 };
                            tokio::time::sleep(Duration::from_millis(release)).await;
                            released.lock().unwrap().push((name, reason));
                            "done"
                        })
                        .await
                }
            }),
        ))
    };
    // Long enough that only `/late` meets it on a loaded machine.
    let app = App::new(routes).deadline(Some(Duration::from_secs(1))).shutdown_grace(Duration::from_secs(2));
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    let wait_for = |name: &'static str| {
        let released = released.clone();
        async move {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Some((_, reason)) = released.lock().unwrap().iter().find(|(n, _)| *n == name) {
                        return *reason;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("{name}: the release never ran"))
        }
    };

    // The client leaves mid-call.
    let mut left = tokio::net::TcpStream::connect(addr).await.unwrap();
    left.write_all(b"GET /left HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(left);
    assert_eq!(wait_for("left").await, crate::Abort::Disconnected);

    // The deadline passes: the client gets 503 and the work still releases.
    let answer = raw_get(addr, "/late", "").await;
    assert!(answer.starts_with("HTTP/1.1 503"), "{answer}");
    assert_eq!(wait_for("late").await, crate::Abort::Deadline);

    // Shutdown during two calls: one whose client is still there is told (`Shutdown`) and
    // answers; one whose client left is still releasing, and serve waits for it.
    let kept = tokio::spawn(raw_get(addr, "/kept", ""));
    let mut gone = tokio::net::TcpStream::connect(addr).await.unwrap();
    gone.write_all(b"GET /gone HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(gone);
    let began = std::time::Instant::now();
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), server).await.expect("serve returned").unwrap().unwrap();
    assert!(began.elapsed() >= Duration::from_millis(400), "serve did not wait for the release: {:?}", began.elapsed());
    let done: Vec<_> = released.lock().unwrap().clone();
    // Its client left as shutdown began: either is the first reason, and either way it released.
    assert!(done.iter().any(|(name, _)| *name == "gone"), "serve returned before the work it had to finish: {done:?}");
    assert!(done.contains(&("kept", crate::Abort::Shutdown)), "{done:?}");
    assert!(kept.await.unwrap().ends_with("done"), "the client that stayed got its answer");
}

/// A panic in work a handler finishes is the handler's: the request answers 500 and the server
/// goes on.
#[tokio::test]
async fn a_panic_in_finished_work_is_the_handlers() {
    let router = App::new(Routes::from(Table::new().route(
        "/",
        get(|signal: crate::Signal| async move {
            signal.finish(|_signal| async move { panic!("the release failed") }).await;
            "never"
        }),
    )))
    .router();
    let (status, _, _) = call(router.clone(), "GET", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let (status, _, _) = call(router, "GET", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "the server goes on after it");
}

/// A `2xx` to `CONNECT` is a tunnel, so the router sends it with no body, whatever the handler
/// wrote, and without any `Content-Length` or `Transfer-Encoding` it said (RFC 9110 9.3.6,
/// #1915); a refusal keeps its body and its length.
#[tokio::test]
async fn a_connect_answered_with_success_has_no_body() {
    let routes = Table::new().route(
        "/",
        crate::router::any(|req: Request<Body>| async move {
            use crate::response::IntoResponse;
            if req.headers().contains_key("x-refuse") {
                return (StatusCode::FORBIDDEN, [(header::CONTENT_LENGTH, "6")], "tunnel").into_response();
            }
            if req.headers().contains_key("x-unframed") {
                return (StatusCode::OK, "tunnel").into_response();
            }
            (StatusCode::OK, [(header::CONTENT_LENGTH, "6"), (header::TRANSFER_ENCODING, "chunked")], "tunnel").into_response()
        }),
    );
    let (status, headers, body) = call(routes.clone(), "CONNECT", None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, ""));
    assert!(!headers.contains_key(header::CONTENT_LENGTH) && !headers.contains_key(header::TRANSFER_ENCODING), "{headers:?}");
    // A body with neither framing header is emptied for its size alone.
    let req = Request::builder().method("CONNECT").uri("/").header("x-unframed", "1").body(Body::empty()).unwrap();
    let res = Router::from(routes.clone()).oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(!res.headers().contains_key(header::CONTENT_LENGTH) && !res.headers().contains_key(header::TRANSFER_ENCODING));
    assert_eq!(res.into_body().collect().await.unwrap().to_bytes(), "");
    let req = Request::builder().method("CONNECT").uri("/").header("x-refuse", "1").body(Body::empty()).unwrap();
    let res = Router::from(routes).oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(res.headers()[header::CONTENT_LENGTH], "6");
    assert_eq!(res.into_body().collect().await.unwrap().to_bytes(), "tunnel");
}
