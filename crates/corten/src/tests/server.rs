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
            let host = crate::security::request_host(req.uri(), || req.headers().get(header::HOST));
            assert_eq!(host.and_then(|h| h.text()), Some("proxy.example"), "authority available to the extractor");
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

/// The deadline of the app [`waiting`] makes.
const LIMIT: Duration = Duration::from_millis(300);
/// How long after its time a deadline's answer may reach a test's client on a busy machine.
const SLACK: Duration = Duration::from_millis(900);

/// What [`waiting`]'s handlers tell a test: that one began, and how its request's signal ended.
#[derive(Debug, PartialEq)]
enum Told {
    Began,
    Ended(crate::Abort),
}

/// An app whose deadline is [`LIMIT`]: `/quick` answers at once, `/wait` after 40 ms, `/never`
/// never, `/read` with its body once that has arrived, and `/admin/slow`, in an area whose
/// deadline is an hour, after twice `LIMIT`. `/wait` and `/never` tell `told` how their request's
/// signal ended, and `/never` and `/admin/slow` that they began.
fn waiting(told: tokio::sync::mpsc::UnboundedSender<Told>) -> App {
    type Tx = tokio::sync::mpsc::UnboundedSender<Told>;
    fn report(signal: crate::Signal, told: Tx) {
        tokio::spawn(async move {
            let _ = told.send(Told::Ended(signal.aborted().await));
        });
    }
    let wait = {
        let told = told.clone();
        move |signal: crate::Signal| {
            report(signal, told.clone());
            async {
                tokio::time::sleep(Duration::from_millis(40)).await;
                "done"
            }
        }
    };
    let never = {
        let told = told.clone();
        move |signal: crate::Signal| {
            report(signal, told.clone());
            let _ = told.send(Told::Began);
            std::future::pending::<&'static str>()
        }
    };
    let slow = move || {
        let _ = told.send(Told::Began);
        async {
            tokio::time::sleep(LIMIT * 2).await;
            "slow"
        }
    };
    let routes = Table::new()
        .route("/quick", get(|| async { "quick" }))
        .route("/wait", get(wait))
        .route("/never", get(never))
        .route("/read", crate::router::post(|body: String| async move { body }));
    App::new(Routes::from(routes))
        .deadline(LIMIT)
        .area::<Admin>(|admin| admin.route::<AdminSlow>(crate::Methods::reads(get(slow))).deadline(Duration::from_secs(3600)))
}

/// A server for `app` on a free port of `127.0.0.1`: its address, what stops it, and its task.
async fn listening(
    app: App,
) -> (std::net::SocketAddr, tokio::sync::oneshot::Sender<()>, tokio::task::JoinHandle<std::io::Result<()>>) {
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    (addr, stop, server)
}

/// Sends a request with no body on a connection and reads its answer: the status, the body, and
/// how long the answer took from before the request was written. An answer that has not come in
/// 20 s, many times the longest any of these tests waits for, fails the test (a wake that was
/// missed, which would otherwise hang it).
async fn asked(stream: &mut tokio::net::TcpStream, line: &str) -> (u16, String, Duration) {
    let answer = tokio::time::timeout(Duration::from_secs(20), answered(stream, line)).await;
    answer.unwrap_or_else(|_| panic!("{line}: no answer in 20 s"))
}

/// [`asked`] with no bound on the wait, for a runtime with no clock to bound it by.
async fn answered(stream: &mut tokio::net::TcpStream, line: &str) -> (u16, String, Duration) {
    use tokio::io::AsyncWriteExt;
    let began = std::time::Instant::now();
    stream.write_all(format!("{line} HTTP/1.1\r\nhost: localhost\r\naccept: text/html\r\n\r\n").as_bytes()).await.unwrap();
    let (head, body) = read_answer(stream).await;
    (head[9..12].parse().expect("a status"), body, began.elapsed())
}

/// [`asked`] for a request [`waiting`]'s deadline answers: the 503 with the error page, no
/// earlier than [`LIMIT`] after the request was written.
async fn late(stream: &mut tokio::net::TcpStream, line: &str) {
    let (status, body, took) = asked(stream, line).await;
    assert_eq!(status, 503, "{line}: {body}");
    assert!(body.contains("<!DOCTYPE html>"), "{line}: the error page: {body}");
    assert!(took >= LIMIT && took < LIMIT + SLACK, "{line}: at its own deadline, {LIMIT:?}: {took:?}");
}

/// Every request of a kept-alive connection has the whole deadline, counted from when its own
/// handler first waits, whatever the requests before it on the connection did: a handler that
/// finishes first answers and its signal ends `Responded`; one that does not is answered 503 with
/// the error page at the deadline and its signal ends `Deadline`; a deadline that fired, a
/// connection idle for longer than the deadline, and a request to an area with a longer deadline
/// leave the next request its own.
#[tokio::test]
async fn every_request_of_a_connection_has_its_own_deadline() {
    let (told, mut heard) = tokio::sync::mpsc::unbounded_channel();
    let (addr, stop, server) = listening(waiting(told)).await;
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    async fn done(conn: &mut tokio::net::TcpStream, heard: &mut tokio::sync::mpsc::UnboundedReceiver<Told>) {
        let (status, body, took) = asked(conn, "GET /wait").await;
        assert_eq!((status, body.as_str()), (200, "done"));
        assert!(took < LIMIT + SLACK, "{took:?}");
        assert_eq!(heard.recv().await, Some(Told::Ended(crate::Abort::Responded)));
    }
    async fn never(conn: &mut tokio::net::TcpStream, heard: &mut tokio::sync::mpsc::UnboundedReceiver<Told>) {
        late(conn, "GET /never").await;
        assert_eq!(heard.recv().await, Some(Told::Began));
        assert_eq!(heard.recv().await, Some(Told::Ended(crate::Abort::Deadline)));
    }
    // Handlers that finish first, one after another, and one that does not wait at all.
    for _ in 0..4 {
        done(&mut conn, &mut heard).await;
    }
    assert_eq!(asked(&mut conn, "GET /quick").await.1, "quick");
    // The deadline, counted from each request, and a handler that finishes first after it.
    for _ in 0..3 {
        never(&mut conn, &mut heard).await;
        done(&mut conn, &mut heard).await;
    }
    // Idle past the deadline an earlier request had: the next handler to wait is not cut short.
    tokio::time::sleep(LIMIT * 2).await;
    done(&mut conn, &mut heard).await;
    never(&mut conn, &mut heard).await;
    // An area's longer deadline lets its handler wait past the app's, and the app's routes have
    // the app's again after it.
    let (status, body, took) = asked(&mut conn, "GET /admin/slow").await;
    assert_eq!((status, body.as_str()), (200, "slow"));
    assert!(took >= LIMIT * 2, "{took:?}");
    assert_eq!(heard.recv().await, Some(Told::Began));
    never(&mut conn, &mut heard).await;
    done(&mut conn, &mut heard).await;
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// A body that stops arriving is the client's 408 at the deadline on a connection whose earlier
/// requests waited too, counted from that request, and the connection is closed after it.
#[tokio::test]
async fn a_body_that_stalls_after_requests_that_waited_is_the_clients_408_at_its_own_deadline() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (told, _heard) = tokio::sync::mpsc::unbounded_channel();
    let (addr, stop, server) = listening(waiting(told)).await;
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    for _ in 0..3 {
        assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
    }
    // A body that arrives whole is answered.
    conn.write_all(b"POST /read HTTP/1.1\r\nhost: localhost\r\ncontent-length: 5\r\n\r\nwhole").await.unwrap();
    assert_eq!(read_answer(&mut conn).await.1, "whole");
    let began = std::time::Instant::now();
    conn.write_all(b"POST /read HTTP/1.1\r\nhost: localhost\r\ncontent-length: 10\r\n\r\npart").await.unwrap();
    let (head, _) = read_answer(&mut conn).await;
    let took = began.elapsed();
    assert!(head.starts_with("http/1.1 408"), "{head}");
    assert!(took >= LIMIT && took < LIMIT + SLACK, "at its own deadline: {took:?}");
    let mut rest = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(5), conn.read_to_end(&mut rest)).await;
    assert!(closed.is_ok(), "the connection is closed after the 408");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// Shutdown treats a connection whose requests have waited as any other: an idle one closes at
/// once, one whose handler is past the grace has its request's deadline and is then answered
/// 503, and one whose request is in an area with an hour's deadline is answered in full.
#[tokio::test]
async fn shutdown_holds_a_connection_whose_requests_waited_to_its_requests_deadline() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (told, mut heard) = tokio::sync::mpsc::unbounded_channel();
    let (addr, stop, server) = listening(waiting(told).shutdown_grace(Duration::from_millis(20))).await;
    let mut conns = Vec::new();
    for _ in 0..3 {
        let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
        for _ in 0..3 {
            assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
        }
        conns.push(conn);
    }
    let [mut idle, mut never, mut slow] = <[tokio::net::TcpStream; 3]>::try_from(conns).unwrap();
    let asked_never = std::time::Instant::now();
    never.write_all(b"GET /never HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    slow.write_all(b"GET /admin/slow HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    // Both handlers have begun.
    let mut began = 0;
    while began < 2 {
        began += usize::from(heard.recv().await == Some(Told::Began));
    }
    let stopped = std::time::Instant::now();
    stop.send(()).unwrap();
    let mut rest = Vec::new();
    idle.read_to_end(&mut rest).await.unwrap();
    assert!(rest.is_empty() && stopped.elapsed() < LIMIT + SLACK, "the idle connection closes at once: {:?}", stopped.elapsed());
    let mut answer = String::new();
    never.read_to_string(&mut answer).await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 503"), "past the grace, the request has its deadline: {answer}");
    assert!(asked_never.elapsed() >= LIMIT, "not before its deadline, shutdown or not: {:?}", asked_never.elapsed());
    assert!(stopped.elapsed() < LIMIT + SLACK, "{:?}", stopped.elapsed());
    let mut answer = String::new();
    slow.read_to_string(&mut answer).await.unwrap();
    assert!(answer.ends_with("slow"), "the area's request is answered in full: {answer}");
    tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
}

/// A deadline that waits on its connection's timer when shutdown begins fires at its own time:
/// the timer's wake reaches the connection's task after shutdown has begun as before it. The test
/// above cannot tell: there the request's deadline and the time its connection is held to once
/// shutdown has begun (shutdown's start and that deadline's length) are milliseconds apart, and the
/// task's wait for that time wakes it and polls the connection, so a timer whose wake was lost
/// would be answered 503 within the slack all the same. Here shutdown begins half a deadline after
/// the request, so the connection is held to half a deadline after the request's own time, and an
/// answer that came only with that wait would come a whole deadline after shutdown began, or
/// later. Each half is [`SLACK`]; a machine so slow that the request's deadline has passed before
/// shutdown begins fails the test, which could not have told.
#[tokio::test]
async fn a_deadline_on_a_connections_timer_fires_at_its_own_time_once_shutdown_has_begun() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const LONG: Duration = Duration::from_millis(1800);
    let (told, mut heard) = tokio::sync::mpsc::unbounded_channel();
    let app = waiting(told).deadline(LONG).shutdown_grace(Duration::from_millis(20));
    let (addr, stop, server) = listening(app).await;
    let before = taken();
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    for _ in 0..3 {
        assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
    }
    assert_eq!(timers(), 1, "the connection has made its timer, and the next deadline to wait takes it");
    let asked_never = std::time::Instant::now();
    conn.write_all(b"GET /never HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    while heard.recv().await.expect("the app holds the sender") != Told::Began {}
    tokio::time::sleep(SLACK.saturating_sub(asked_never.elapsed())).await;
    assert_eq!(taken() - before, 2, "the third to wait took the connection's timer, and this request's deadline has it now");
    let stopped = std::time::Instant::now();
    stop.send(()).unwrap();
    assert!(asked_never.elapsed() < LONG, "shutdown began after the deadline: {:?}", asked_never.elapsed());
    let mut answer = String::new();
    conn.read_to_string(&mut answer).await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 503"), "the request has its deadline: {answer}");
    assert!(asked_never.elapsed() >= LONG, "not before its deadline, shutdown or not: {:?}", asked_never.elapsed());
    assert!(stopped.elapsed() < LONG, "at its deadline, not when its connection's time was up: {:?}", stopped.elapsed());
    tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
}

/// A thread that serves one runtime and then another (a test's, or an app that builds its own)
/// serves each as if it were the first: nothing a connection of the first runtime kept for its
/// deadlines is used on the second, also when the first ended with its connections open.
#[test]
fn a_thread_that_serves_one_runtime_after_another_holds_each_to_the_deadline() {
    for round in 0..3 {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let open = runtime.block_on(async {
            let (told, heard) = tokio::sync::mpsc::unbounded_channel();
            let (addr, stop, server) = listening(waiting(told)).await;
            let mut conns = Vec::new();
            for _ in 0..4 {
                let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
                for _ in 0..3 {
                    assert_eq!(asked(&mut conn, "GET /wait").await.1, "done", "round {round}");
                }
                late(&mut conn, "GET /never").await;
                assert_eq!(asked(&mut conn, "GET /wait").await.1, "done", "round {round}");
                conns.push(conn);
            }
            // One connection is in a request whose handler waits when the runtime ends.
            use tokio::io::AsyncWriteExt;
            conns[0].write_all(b"GET /never HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            (conns, stop, server, heard)
        });
        // The runtime ends with the server running and its connections open.
        drop(runtime);
        drop(open);
    }
}

/// A handler that serves a request on a runtime of its own (it blocks on one, inside
/// `block_in_place`) and drops that runtime: the inner request has its deadline every time, on a
/// connection whose earlier requests did the same, so nothing the connection keeps for its
/// deadlines belongs to a runtime that is gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_served_on_another_runtime_inside_a_handler_has_its_deadline() {
    let (told, _heard) = tokio::sync::mpsc::unbounded_channel();
    let inner = waiting(told).router();
    let relay = |path: &'static str| {
        let inner = inner.clone();
        get(move || {
            let inner = inner.clone();
            async move {
                tokio::task::block_in_place(move || {
                    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                    let res = runtime.block_on(inner.oneshot(Request::get(path).body(Body::empty()).unwrap())).unwrap();
                    res.status().as_u16().to_string()
                })
            }
        })
    };
    let routes = Table::new().route("/inner/wait", relay("/wait")).route("/inner/never", relay("/never"));
    let (addr, stop, server) = listening(App::new(Routes::from(routes))).await;
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    for round in 0..3 {
        for _ in 0..3 {
            assert_eq!(asked(&mut conn, "GET /inner/wait").await.1, "200", "round {round}");
        }
        let (status, body, took) = asked(&mut conn, "GET /inner/never").await;
        assert_eq!((status, body.as_str()), (200, "503"), "round {round}");
        assert!(took >= LIMIT && took < LIMIT + SLACK, "round {round}: at the inner deadline: {took:?}");
    }
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// How many connections' timers this thread has made and not dropped (`crate::deadline`).
fn timers() -> isize {
    crate::deadline::LIVE.get()
}

/// Waits until this thread's connections have `count` timers, which a closed connection's task
/// takes a moment to reach.
async fn timers_reach(count: isize) {
    let reached = tokio::time::timeout(Duration::from_secs(10), async {
        while timers() != count {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    assert!(reached.await.is_ok(), "{} timers, not {count}", timers());
}

/// A connection keeps one timer for its requests' deadlines, made once two requests of its have
/// waited, and the timer is dropped with the connection: one whose handlers never wait has none,
/// nor has one a single request of whose has waited, many requests make no more, and connections
/// that close (their client gone between requests or while a handler waits, or at shutdown) leave
/// none behind.
#[tokio::test]
async fn a_connections_timer_is_made_once_and_dropped_with_the_connection() {
    use tokio::io::AsyncWriteExt;
    const OPEN: usize = 40;
    let routes = Table::new()
        .route("/quick", get(|| async { "quick" }))
        .route(
            "/wait",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(2)).await;
                "done"
            }),
        )
        .route("/never", get(std::future::pending::<&'static str>));
    let (addr, stop, server) = listening(App::new(Routes::from(routes)).deadline(LIMIT)).await;
    let mut conns = Vec::new();
    for _ in 0..OPEN {
        let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
        assert_eq!(asked(&mut conn, "GET /quick").await.1, "quick");
        conns.push(conn);
    }
    assert_eq!(timers(), 0, "a connection whose handlers have not waited has none");
    for conn in &mut conns {
        assert_eq!(asked(conn, "GET /wait").await.1, "done");
        assert_eq!(asked(conn, "GET /quick").await.1, "quick");
    }
    assert_eq!(timers(), 0, "nor has one a single request of whose has waited");
    for waited in 2..6 {
        for conn in &mut conns {
            assert_eq!(asked(conn, "GET /wait").await.1, "done");
        }
        assert_eq!(timers(), OPEN as isize, "one a connection after {waited} requests that waited");
    }
    for conn in &mut conns[..4] {
        late(conn, "GET /never").await;
        assert_eq!(asked(conn, "GET /wait").await.1, "done");
    }
    assert_eq!(timers(), OPEN as isize, "also once a deadline has fired");
    // Clients that leave between requests.
    conns.truncate(15);
    timers_reach(15).await;
    // Connections that come, wait once, twice (which makes the timer) or three times (which uses
    // it), and go.
    for n in 0..300 {
        let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
        for _ in 0..1 + n % 3 {
            assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
        }
    }
    timers_reach(15).await;
    // Clients that leave while their handler waits on the connection's timer.
    for mut conn in conns.drain(..5) {
        conn.write_all(b"GET /never HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    timers_reach(10).await;
    // Shutdown closes the rest, idle.
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
    assert_eq!(timers(), 0);
}

/// A runtime that ends with connections open drops their timers, and the thread that ran it ends
/// without a panic.
#[test]
fn a_runtime_that_ends_drops_its_connections_timers() {
    let thread = std::thread::spawn(|| {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let open = runtime.block_on(async {
            let (told, heard) = tokio::sync::mpsc::unbounded_channel();
            let (addr, stop, server) = listening(waiting(told)).await;
            let mut conns = Vec::new();
            for _ in 0..8 {
                let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
                for _ in 0..3 {
                    assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
                }
                conns.push(conn);
            }
            (conns, stop, server, heard)
        });
        let before = timers();
        drop(runtime);
        let after = timers();
        drop(open);
        (before, after)
    });
    assert_eq!(thread.join().expect("the thread ends"), (8, 0));
}

/// A connection's first deadline to wait makes its own timer and leaves the connection none; the
/// second makes its own too and has the connection make one; each deadline after them waits on
/// that one, a second deadline in the same request on its own, and the connection has its timer
/// back, set, when the deadline is dropped.
#[tokio::test(start_paused = true)]
async fn a_deadline_waits_on_its_connections_timer_from_the_third_that_waits() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    let limit = Duration::from_secs(30);
    let mut kept = Vec::new();
    {
        let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
            let mut first = pin!(Timer::Unset);
            assert!(first.as_mut().poll(limit, cx).is_pending());
            let mut second = pin!(Timer::Unset);
            assert!(second.as_mut().poll(limit, cx).is_pending());
            kept.push((first.is_kept(), second.is_kept()));
            Poll::<()>::Pending
        })));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(conn.as_mut().poll(&mut cx).is_pending());
        assert_eq!((timers(), conn.kept_until()), (0, None), "one deadline has waited: no timer");
        assert!(conn.as_mut().poll(&mut cx).is_pending());
        assert_eq!(timers(), 1);
        assert!(conn.kept_until().is_some_and(|until| until > tokio::time::Instant::now() + limit), "made, not set yet");
        for _ in 0..3 {
            tokio::time::advance(Duration::from_secs(1)).await;
            assert!(conn.as_mut().poll(&mut cx).is_pending());
            assert_eq!((timers(), conn.kept_until()), (1, Some(tokio::time::Instant::now() + limit)));
        }
    }
    assert_eq!(kept, [(false, false), (false, false), (true, false), (true, false), (true, false)]);
    assert_eq!(timers(), 0, "dropped with the connection");
}

/// A connection one of whose deadlines has waited, polled again with no deadline waiting for the
/// first time (its handler is still waiting, or its later requests do not wait), stays as it is:
/// it makes its timer only when a second deadline waits.
#[tokio::test(start_paused = true)]
async fn a_connection_makes_its_timer_only_when_a_second_deadline_waits() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    let limit = Duration::from_secs(30);
    let mut polls = 0;
    let mut kept = Vec::new();
    {
        let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
            polls += 1;
            // Deadlines wait in the first, the sixth and the seventh poll.
            if matches!(polls, 1 | 6 | 7) {
                let mut timer = pin!(Timer::Unset);
                assert!(timer.as_mut().poll(limit, cx).is_pending());
                kept.push(timer.is_kept());
            }
            Poll::<()>::Pending
        })));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        for _ in 0..5 {
            assert!(conn.as_mut().poll(&mut cx).is_pending());
            assert_eq!((timers(), conn.kept_until()), (0, None));
        }
        for _ in 0..2 {
            assert!(conn.as_mut().poll(&mut cx).is_pending());
            assert_eq!(timers(), 1);
        }
    }
    assert_eq!(kept, [false, false, true]);
}

/// The first number a connection is given is none of the values that say how many of a
/// connection's deadlines have waited. A connection numbered as one of those would be taken for
/// one that has made no timer, lend none, and make another timer at each later poll in which a
/// deadline waits. Whichever test's connection took the process's first number, this one reads
/// what that number was, after a connection of its own has taken one.
#[tokio::test(start_paused = true)]
async fn the_first_number_a_connection_is_given_is_none_of_the_states() {
    use crate::deadline::{first_number_is_no_state, Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
        let mut timer = pin!(Timer::Unset);
        assert!(timer.as_mut().poll(Duration::from_secs(30), cx).is_pending());
        Poll::<()>::Pending
    })));
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    for _ in 0..2 {
        assert!(conn.as_mut().poll(&mut cx).is_pending());
    }
    assert!(conn.kept_until().is_some(), "the connection has made its timer, so a number has been given");
    assert_eq!(first_number_is_no_state(), Some(true));
}

/// A connection that is done in the poll its second deadline waited in makes no timer on its way
/// out.
#[tokio::test(start_paused = true)]
async fn a_connection_done_where_its_second_deadline_waited_makes_no_timer() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    let mut polls = 0;
    let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
        let mut timer = pin!(Timer::Unset);
        assert!(timer.as_mut().poll(Duration::from_secs(30), cx).is_pending());
        polls += 1;
        if polls == 2 {
            Poll::Ready(timer.is_kept())
        } else {
            Poll::Pending
        }
    })));
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(conn.as_mut().poll(&mut cx).is_pending());
    assert_eq!(conn.as_mut().poll(&mut cx), Poll::Ready(false));
    assert_eq!((timers(), conn.kept_until()), (0, None));
}

/// A deadline dropped anywhere but in its connection's poll drops the timer it had, and the
/// connection, which makes its timer once, has none from then on: its deadlines make their own.
#[tokio::test]
async fn a_timer_whose_deadline_is_dropped_away_from_its_connection_is_dropped() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    let limit = Duration::from_secs(30);
    let away = std::cell::RefCell::new(None);
    let mut kept = Vec::new();
    {
        let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
            let mut timer = Box::pin(Timer::Unset);
            assert!(timer.as_mut().poll(limit, cx).is_pending());
            kept.push(timer.is_kept());
            if timer.is_kept() {
                // As a layer that moves its call to another task does.
                *away.borrow_mut() = Some(timer);
            }
            Poll::<()>::Pending
        })));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        for _ in 0..3 {
            assert!(conn.as_mut().poll(&mut cx).is_pending());
        }
        assert_eq!((timers(), conn.kept_until()), (1, None), "the deadline has it");
        drop(away.borrow_mut().take());
        assert_eq!(timers(), 0, "dropped, not kept on the thread");
        for _ in 0..2 {
            assert!(conn.as_mut().poll(&mut cx).is_pending());
        }
        assert_eq!((timers(), conn.kept_until()), (0, None));
    }
    assert_eq!(kept, [false, false, true, false, false]);
}

/// A connection polled inside another's poll (a handler that blocks on a runtime of its own that
/// serves one) has its own timer and gives the thread back the outer connection's: each has its
/// own again afterwards, set by its own deadline.
#[tokio::test(start_paused = true)]
async fn a_connection_polled_inside_anothers_poll_keeps_its_own_timer() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    let (short, long) = (Duration::from_secs(10), Duration::from_secs(20));
    let mut kept = Vec::new();
    let inners = std::cell::Cell::new(false);
    let mut inner = pin!(Keeps::new(std::future::poll_fn(|cx| {
        let mut timer = pin!(Timer::Unset);
        assert!(timer.as_mut().poll(long, cx).is_pending());
        inners.set(timer.is_kept());
        Poll::<()>::Pending
    })));
    {
        let mut outer = pin!(Keeps::new(std::future::poll_fn(|cx| {
            let mut timer = pin!(Timer::Unset);
            assert!(timer.as_mut().poll(short, cx).is_pending());
            assert!(inner.as_mut().poll(cx).is_pending());
            let inner = inners.get();
            // A deadline after the inner connection's poll finds the outer's timer taken, not
            // the inner's.
            let mut after = pin!(Timer::Unset);
            assert!(after.as_mut().poll(long, cx).is_pending());
            kept.push((timer.is_kept(), inner, after.is_kept()));
            Poll::<()>::Pending
        })));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        for _ in 0..4 {
            assert!(outer.as_mut().poll(&mut cx).is_pending());
        }
        assert_eq!(outer.kept_until(), Some(tokio::time::Instant::now() + short));
        assert_eq!(timers(), 2);
    }
    assert_eq!(inner.kept_until(), Some(tokio::time::Instant::now() + long));
    assert_eq!(kept, [(false, false, false), (false, false, false), (true, true, false), (true, true, false)]);
    assert_eq!(timers(), 1, "the inner connection's, still");
}

/// How many deadlines have taken a connection's timer on this thread (`crate::deadline`).
fn taken() -> usize {
    crate::deadline::TAKEN.get()
}

/// The requests a connection is served wait on its timer once two of them have waited: the first
/// two to wait make their own, each after them takes the connection's, the one whose deadline
/// fires and the one after that too; a handler that does not wait takes none, and another
/// connection starts with its own first.
#[tokio::test]
async fn a_served_request_waits_on_its_connections_timer() {
    let (told, _heard) = tokio::sync::mpsc::unbounded_channel();
    let (addr, stop, server) = listening(waiting(told)).await;
    let before = taken();
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
    assert_eq!((taken() - before, timers()), (0, 0), "the connection's first to wait makes its own");
    assert_eq!(asked(&mut conn, "GET /quick").await.1, "quick");
    assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
    assert_eq!((taken() - before, timers()), (0, 1), "and its second, at which the connection makes its timer");
    for waited in 1..=4 {
        assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
        assert_eq!(taken() - before, waited);
    }
    assert_eq!(asked(&mut conn, "GET /quick").await.1, "quick");
    assert_eq!(taken() - before, 4, "a handler that does not wait takes none");
    late(&mut conn, "GET /never").await;
    assert_eq!(asked(&mut conn, "GET /wait").await.1, "done");
    assert_eq!(taken() - before, 6, "the deadline that fired, and the request after it");
    let mut other = tokio::net::TcpStream::connect(addr).await.unwrap();
    assert_eq!(asked(&mut other, "GET /wait").await.1, "done");
    assert_eq!(taken() - before, 6, "another connection's first makes its own");
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// A connection is polled with what it keeps for its deadlines while it drains at shutdown too: a
/// request whose head was still arriving when shutdown began, the connection's first and its
/// last, has the connection make its timer once a second deadline of its has waited, as it would
/// have before. One request has two deadlines here: its own, and that of a request its handler
/// serves through the app's router once it has waited itself.
#[tokio::test]
async fn a_connection_draining_at_shutdown_makes_its_timer_as_before() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (told, mut heard) = tokio::sync::mpsc::unbounded_channel();
    let inner = waiting(told.clone()).router();
    let twice = get(move || {
        let (inner, told) = (inner.clone(), told.clone());
        async move {
            let _ = told.send(Told::Began);
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = told.send(Told::Began);
            let res = inner.oneshot(Request::get("/wait").body(Body::empty()).unwrap()).await.unwrap();
            res.status().as_u16().to_string()
        }
    });
    let routes = Table::new().route("/quick", get(|| async { "quick" })).route("/twice", twice);
    let (addr, stop, server) = listening(App::new(Routes::from(routes))).await;
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    conn.write_all(b"GET /twice HTTP/1.1\r\n").await.unwrap();
    // A connection made after it has been answered, so the server has taken the first.
    let mut after = tokio::net::TcpStream::connect(addr).await.unwrap();
    assert_eq!(asked(&mut after, "GET /quick").await.1, "quick");
    stop.send(()).unwrap();
    // The rest of the head once shutdown has begun, which closes the listener.
    let closed = tokio::time::timeout(Duration::from_secs(10), async {
        while tokio::net::TcpStream::connect(addr).await.is_ok() {
            tokio::task::yield_now().await;
        }
    });
    closed.await.expect("shutdown closes the listener");
    assert_eq!(timers(), 0);
    conn.write_all(b"host: localhost\r\n\r\n").await.unwrap();
    // The handler says it began in the poll it first waits in, and this task runs after that poll.
    assert_eq!(heard.recv().await, Some(Told::Began));
    assert_eq!(timers(), 0, "one deadline of the connection's has waited");
    // And again in the poll the request it serves first waits in.
    assert_eq!(heard.recv().await, Some(Told::Began));
    assert_eq!(timers(), 1, "made in the poll its second deadline first waited in");
    let mut answer = String::new();
    conn.read_to_string(&mut answer).await.unwrap();
    assert!(answer.ends_with("200"), "{answer}");
    tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
    assert_eq!(timers(), 0);
}

/// On a runtime with no clock a handler that waits is answered 500, as it was when every deadline
/// made its own timer (making one panics, inside the handler's catch), and the connection goes on
/// serving: it makes no timer of its own, which nothing would catch.
#[test]
fn a_runtime_with_no_clock_answers_500_and_goes_on_serving_the_connection() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_io().build().unwrap();
    runtime.block_on(async {
        let (told, _heard) = tokio::sync::mpsc::unbounded_channel();
        let (addr, _stop, server) = listening(waiting(told)).await;
        let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
        for _ in 0..3 {
            let (status, body, _) = answered(&mut conn, "GET /never").await;
            assert_eq!(status, 500, "{body}");
        }
        assert_eq!(answered(&mut conn, "GET /quick").await.1, "quick");
        assert_eq!(timers(), 0);
        assert!(!server.is_finished());
    });
}

/// A connection polled where there is no clock, whose handler made its deadline's timer on a
/// runtime it had entered: the connection makes no timer (making one, at its second deadline to
/// wait, panics, and its poll catches that), and its deadlines go on making their own.
#[test]
fn a_connection_polled_where_there_is_no_clock_makes_no_timer() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    let entered = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
    let mut kept = Vec::new();
    {
        let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
            let _entered = entered.enter();
            let mut timer = pin!(Timer::Unset);
            assert!(timer.as_mut().poll(Duration::from_secs(30), cx).is_pending());
            kept.push(timer.is_kept());
            Poll::<()>::Pending
        })));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        for _ in 0..4 {
            assert!(conn.as_mut().poll(&mut cx).is_pending());
            assert_eq!((timers(), conn.kept_until()), (0, None));
        }
    }
    assert_eq!(kept, [false, false, false, false]);
}

/// A connection whose poll panics while a deadline has its timer has the timer back, and the
/// thread is as it was before the poll: a deadline polled next, where no connection is, makes its
/// own, and the connection's next deadline takes the connection's.
#[tokio::test(start_paused = true)]
async fn a_connection_whose_poll_panics_has_its_timer_back() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, panic::AssertUnwindSafe, pin::pin, task::Poll};
    let limit = Duration::from_secs(30);
    let mut kept = Vec::new();
    {
        let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
            let mut timer = pin!(Timer::Unset);
            assert!(timer.as_mut().poll(limit, cx).is_pending());
            kept.push(timer.is_kept());
            assert_ne!(kept.len(), 3, "the third poll panics, as a handler no catch is around");
            Poll::<()>::Pending
        })));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        // Two deadlines that make their own, after which the connection has its timer.
        for _ in 0..2 {
            assert!(conn.as_mut().poll(&mut cx).is_pending());
        }
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| conn.as_mut().poll(&mut cx).is_pending())).is_err());
        let set = Some(tokio::time::Instant::now() + limit);
        assert_eq!((timers(), conn.kept_until()), (1, set), "back, as the deadline that panicked set it");
        let mut outside = pin!(Timer::Unset);
        assert!(outside.as_mut().poll(limit, &mut cx).is_pending());
        assert!(!outside.is_kept(), "no connection is being polled");
        assert!(conn.as_mut().poll(&mut cx).is_pending());
        assert_eq!((timers(), conn.kept_until()), (1, set));
    }
    assert_eq!(kept, [false, false, true, true]);
}

/// A deadline with one connection's timer, dropped inside another connection's poll, drops the
/// timer: it goes back only to the connection that made it, also where the connection being
/// polled has a number and its own timer is out with a deadline.
#[tokio::test(start_paused = true)]
async fn a_timer_dropped_in_another_connections_poll_is_not_given_to_that_connection() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    let limit = Duration::from_secs(30);
    // The first connection's deadline with its timer, and the second's.
    let (away, held) = (std::cell::RefCell::new(None), std::cell::RefCell::new(None));
    let mut first = pin!(Keeps::new(std::future::poll_fn(|cx| {
        let mut timer = Box::pin(Timer::Unset);
        assert!(timer.as_mut().poll(limit, cx).is_pending());
        if timer.is_kept() {
            *away.borrow_mut() = Some(timer);
        }
        Poll::<()>::Pending
    })));
    let mut second = pin!(Keeps::new(std::future::poll_fn(|cx| {
        let mut timer = Box::pin(Timer::Unset);
        assert!(timer.as_mut().poll(limit * 2, cx).is_pending());
        if timer.is_kept() {
            *held.borrow_mut() = Some(timer);
        } else if held.borrow().is_some() {
            // The second connection's timer is out with its deadline; the first's is dropped here.
            drop(away.borrow_mut().take());
        }
        Poll::<()>::Pending
    })));
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    for _ in 0..3 {
        assert!(first.as_mut().poll(&mut cx).is_pending());
        assert!(second.as_mut().poll(&mut cx).is_pending());
    }
    assert!(away.borrow().is_some() && held.borrow().is_some());
    assert_eq!((timers(), first.kept_until(), second.kept_until()), (2, None, None), "each deadline has its connection's");
    assert!(second.as_mut().poll(&mut cx).is_pending());
    assert!(away.borrow().is_none());
    assert_eq!((timers(), second.kept_until()), (1, None), "dropped, not given to the connection being polled");
    drop(held.borrow_mut().take());
    assert_eq!(timers(), 0);
}

/// A connection that has made no timer, polled inside the poll of one that has: its first two
/// deadlines make their own and do not take the outer connection's timer, which is the thread's
/// while the outer connection is polled.
#[tokio::test(start_paused = true)]
async fn a_new_connection_polled_inside_anothers_poll_does_not_take_its_timer() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    let (short, long) = (Duration::from_secs(10), Duration::from_secs(20));
    let inners = std::cell::Cell::new(None);
    let mut inner = pin!(Keeps::new(std::future::poll_fn(|cx| {
        let mut timer = pin!(Timer::Unset);
        assert!(timer.as_mut().poll(long, cx).is_pending());
        inners.set(Some(timer.is_kept()));
        Poll::<()>::Pending
    })));
    {
        let mut polls = 0;
        let mut outer = pin!(Keeps::new(std::future::poll_fn(|cx| {
            polls += 1;
            if polls <= 2 {
                // The outer connection's first two deadlines, the second of which has it make its
                // timer.
                let mut timer = pin!(Timer::Unset);
                assert!(timer.as_mut().poll(short, cx).is_pending());
            } else {
                assert!(inner.as_mut().poll(cx).is_pending());
            }
            Poll::<()>::Pending
        })));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        for _ in 0..2 {
            assert!(outer.as_mut().poll(&mut cx).is_pending());
        }
        let unset = outer.kept_until();
        assert!(unset.is_some_and(|until| until > tokio::time::Instant::now() + long), "made, not set");
        assert!(outer.as_mut().poll(&mut cx).is_pending());
        assert_eq!(inners.get(), Some(false), "the inner connection's first deadline makes its own");
        assert_eq!((timers(), outer.kept_until()), (1, unset), "the outer connection's timer is as it was");
        assert!(outer.as_mut().poll(&mut cx).is_pending());
        assert_eq!(inners.get(), Some(false), "and so does its second, at which it makes its timer");
        assert_eq!((timers(), outer.kept_until()), (2, unset), "the outer connection's timer is as it was");
        assert!(outer.as_mut().poll(&mut cx).is_pending());
        assert_eq!(inners.get(), Some(true), "the inner connection's third takes the inner's");
        assert_eq!(outer.kept_until(), unset);
    }
    assert_eq!(inner.kept_until(), Some(tokio::time::Instant::now() + long));
    assert_eq!(timers(), 1, "the inner connection's");
}

/// Two deadlines that first wait in one poll of such a connection (a handler that joins two
/// calls), inside the poll of a connection that has made its timer: the second finds the thread
/// told that a deadline has waited in this poll, and makes its own as the first did. Neither
/// takes the outer connection's timer.
#[tokio::test(start_paused = true)]
async fn two_deadlines_in_one_poll_of_a_new_connection_do_not_take_another_connections_timer() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    let (short, long) = (Duration::from_secs(10), Duration::from_secs(20));
    let inners = std::cell::Cell::new(None);
    let mut inner = pin!(Keeps::new(std::future::poll_fn(|cx| {
        let (mut first, mut second) = (pin!(Timer::Unset), pin!(Timer::Unset));
        assert!(first.as_mut().poll(long, cx).is_pending());
        assert!(second.as_mut().poll(long, cx).is_pending());
        inners.set(Some((first.is_kept(), second.is_kept())));
        Poll::<()>::Pending
    })));
    {
        let mut polls = 0;
        let mut outer = pin!(Keeps::new(std::future::poll_fn(|cx| {
            polls += 1;
            if polls <= 2 {
                let mut timer = pin!(Timer::Unset);
                assert!(timer.as_mut().poll(short, cx).is_pending());
            } else {
                assert!(inner.as_mut().poll(cx).is_pending());
            }
            Poll::<()>::Pending
        })));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        for _ in 0..2 {
            assert!(outer.as_mut().poll(&mut cx).is_pending());
        }
        let unset = outer.kept_until();
        assert!(unset.is_some_and(|until| until > tokio::time::Instant::now() + long), "made, not set");
        assert!(outer.as_mut().poll(&mut cx).is_pending());
        assert_eq!(inners.get(), Some((false, false)), "both make their own in the inner connection's first poll");
        assert_eq!((timers(), outer.kept_until()), (1, unset), "the outer connection's timer is as it was");
        assert!(outer.as_mut().poll(&mut cx).is_pending());
        assert_eq!(inners.get(), Some((false, false)), "and in its second, at which it makes its timer");
        assert_eq!((timers(), outer.kept_until()), (2, unset), "the outer connection's timer is as it was");
        assert!(outer.as_mut().poll(&mut cx).is_pending());
        assert_eq!(inners.get(), Some((true, false)), "then one takes the inner connection's and the other makes its own");
        assert_eq!(outer.kept_until(), unset);
    }
    assert_eq!(inner.kept_until(), Some(tokio::time::Instant::now() + long));
    assert_eq!(timers(), 1, "the inner connection's");
}

/// A deadline of the longest `Duration` there is sets its connection's timer 30 years off, as far
/// as tokio's own `sleep` waits, where that length added to the time would overflow and panic.
#[tokio::test(start_paused = true)]
async fn a_deadline_of_the_longest_duration_sets_the_connections_timer_30_years_off() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    let mut kept = Vec::new();
    {
        let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
            let mut timer = pin!(Timer::Unset);
            assert!(timer.as_mut().poll(Duration::MAX, cx).is_pending());
            kept.push(timer.is_kept());
            Poll::<()>::Pending
        })));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        for _ in 0..2 {
            assert!(conn.as_mut().poll(&mut cx).is_pending());
        }
        // So that the time the third deadline sets is not the one the timer was made with.
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(conn.as_mut().poll(&mut cx).is_pending());
        let set = tokio::time::Instant::now() + Duration::from_secs(86400 * 365 * 30);
        assert_eq!((timers(), conn.kept_until()), (1, Some(set)));
    }
    assert_eq!(kept, [false, false, true]);
}

/// A deadline that has its connection's timer and is then polled somewhere else (a layer moved its
/// call to another task) is woken there when the timer fires: the timer keeps the waker of its
/// last poll, not the connection's.
#[tokio::test(start_paused = true)]
async fn a_kept_timer_wakes_what_polled_it_last() {
    use crate::deadline::{Keeps, Timer};
    use std::{
        future::Future,
        pin::pin,
        sync::atomic::{AtomicUsize, Ordering::Relaxed},
        task::Poll,
    };
    struct Woken(AtomicUsize);
    impl std::task::Wake for Woken {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Relaxed);
        }
    }
    let limit = Duration::from_secs(30);
    let (conns, elsewhere) = (Arc::new(Woken(AtomicUsize::new(0))), Arc::new(Woken(AtomicUsize::new(0))));
    let away = std::cell::RefCell::new(None);
    let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
        let mut timer = Box::pin(Timer::Unset);
        assert!(timer.as_mut().poll(limit, cx).is_pending());
        if timer.is_kept() {
            *away.borrow_mut() = Some(timer);
        }
        Poll::<()>::Pending
    })));
    let waker = std::task::Waker::from(conns.clone());
    let mut cx = std::task::Context::from_waker(&waker);
    for _ in 0..3 {
        assert!(conn.as_mut().poll(&mut cx).is_pending());
    }
    let mut moved = away.borrow_mut().take().expect("the third deadline has the connection's timer");
    let waker = std::task::Waker::from(elsewhere.clone());
    let mut cx = std::task::Context::from_waker(&waker);
    assert!(moved.as_mut().poll(limit, &mut cx).is_pending());
    tokio::time::advance(limit + Duration::from_millis(1)).await;
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
    assert_eq!((conns.0.load(Relaxed), elsewhere.0.load(Relaxed)), (0, 1), "woken where it was polled last");
    assert!(moved.as_mut().poll(limit, &mut cx).is_ready());
}

/// A connection's timer that is left set, with no deadline having it (the connection sits idle,
/// or serves requests that do not wait), wakes the connection once when its time comes, not
/// before and not again, and the next deadline to wait sets it from then.
#[tokio::test(start_paused = true)]
async fn a_timer_left_set_wakes_its_connection_once_when_its_time_comes() {
    use crate::deadline::{Keeps, Timer};
    use std::{
        future::Future,
        pin::pin,
        sync::atomic::{AtomicUsize, Ordering::Relaxed},
        task::Poll,
    };
    struct Woken(AtomicUsize);
    impl std::task::Wake for Woken {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Relaxed);
        }
    }
    async fn settled() {
        for _ in 0..3 {
            tokio::task::yield_now().await;
        }
    }
    let limit = Duration::from_secs(30);
    let woken = Arc::new(Woken(AtomicUsize::new(0)));
    let waits = std::cell::Cell::new(3);
    let mut conn = pin!(Keeps::new(std::future::poll_fn(|cx| {
        if waits.get() > 0 {
            waits.set(waits.get() - 1);
            let mut timer = pin!(Timer::Unset);
            assert!(timer.as_mut().poll(limit, cx).is_pending());
        }
        Poll::<()>::Pending
    })));
    let waker = std::task::Waker::from(woken.clone());
    let mut cx = std::task::Context::from_waker(&waker);
    for _ in 0..3 {
        assert!(conn.as_mut().poll(&mut cx).is_pending());
    }
    assert_eq!(conn.kept_until(), Some(tokio::time::Instant::now() + limit), "set by the third deadline");
    tokio::time::advance(limit - Duration::from_millis(2)).await;
    settled().await;
    assert_eq!(woken.0.load(Relaxed), 0, "not before its time");
    tokio::time::advance(Duration::from_millis(4)).await;
    settled().await;
    assert_eq!(woken.0.load(Relaxed), 1, "once, at its time");
    // Polls in which no deadline waits, then three deadlines' length of time.
    for _ in 0..5 {
        assert!(conn.as_mut().poll(&mut cx).is_pending());
    }
    tokio::time::advance(limit * 3).await;
    settled().await;
    assert_eq!(woken.0.load(Relaxed), 1, "and not again");
    waits.set(1);
    assert!(conn.as_mut().poll(&mut cx).is_pending());
    assert_eq!(conn.kept_until(), Some(tokio::time::Instant::now() + limit));
}

/// Deadlines on four threads: 64 connections, each a task that serves 40 requests one after
/// another, half with a handler that finishes first under a long limit and half with one that
/// never does under a short one; some deadlines are moved to another task after their first poll
/// and some connections are polled inside another's. Then 64 more that serve 80 requests each
/// under one limit a connection (4 to 7 ms), three with a handler that finishes 1 to 2 ms before
/// the limit and then one whose handler never does: each of those deadlines moves a timer that is
/// still set to a later time, which takes no lock and races with the timer driver reaching the
/// old time. No deadline fires before its limit, and every deadline whose handler never finishes
/// fires. (That a handler which finishes under its limit is answered is not held here: a thread
/// stalled for the limit between the handler's poll and the timer's has the timer fire, with a
/// timer a request too.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deadlines_on_four_threads_fire_and_none_before_its_limit() {
    use crate::deadline::{Keeps, Timer};
    use std::{future::Future, pin::pin, task::Poll};
    /// A request: how long it took when its deadline fired, `None` when its handler finished.
    async fn request(limit: Duration, work: Option<Duration>) -> Option<Duration> {
        let began = tokio::time::Instant::now();
        let mut handler = pin!(async move {
            match work {
                Some(work) => tokio::time::sleep(work).await,
                None => std::future::pending().await,
            }
        });
        let mut timer = pin!(Timer::Unset);
        std::future::poll_fn(|cx| {
            if handler.as_mut().poll(cx).is_ready() {
                return Poll::Ready(None);
            }
            timer.as_mut().poll(limit, cx).map(|()| Some(began.elapsed()))
        })
        .await
    }
    /// A connection's request `n`: odd ones finish first, even ones never finish.
    async fn one(conn: usize, n: usize) {
        if n % 2 == 1 {
            let fired = request(Duration::from_secs(600), Some(Duration::from_millis(1))).await;
            assert_eq!(fired, None, "connection {conn}, request {n}: before its limit");
            return;
        }
        let limit = Duration::from_millis(1 + ((conn + n) % 4) as u64);
        let mut never = Box::pin(request(limit, None));
        let first = std::future::poll_fn(|cx| Poll::Ready(never.as_mut().poll(cx))).await;
        let fired = match first {
            Poll::Ready(fired) => fired,
            // Moved to another task after its first poll here, as a layer may move its call.
            Poll::Pending if conn % 8 == 2 && n == 20 => tokio::spawn(never).await.unwrap(),
            Poll::Pending => never.await,
        };
        assert!(fired.is_some_and(|took| took >= limit), "connection {conn}, request {n}: {fired:?} of {limit:?}");
    }
    async fn served(conn: usize) {
        for n in 0..40 {
            one(conn, n).await;
            // A connection polled inside this one's poll.
            if conn % 8 == 1 && n % 10 == 4 {
                Keeps::new(async move {
                    for n in 0..4 {
                        one(conn, n).await;
                    }
                })
                .await;
            }
        }
    }
    /// A connection all of whose requests have one limit: three handlers that finish just under
    /// it, then one that never does.
    async fn steady(conn: usize) {
        let limit = Duration::from_millis(4 + (conn % 4) as u64);
        for n in 0..80 {
            let work = (n % 4 != 3).then(|| limit - Duration::from_micros(1000 + ((conn * 7 + n * 131) % 1000) as u64));
            let fired = request(limit, work).await;
            assert!(fired.is_none_or(|took| took >= limit), "connection {conn}, request {n}: {fired:?} of {limit:?}");
            assert!(work.is_some() || fired.is_some(), "connection {conn}, request {n}: its deadline fires");
        }
    }
    let conns: Vec<_> = (0..64).map(|conn| tokio::spawn(Keeps::new(served(conn)))).collect();
    let all = async {
        for conn in conns {
            conn.await.unwrap();
        }
    };
    tokio::time::timeout(Duration::from_secs(60), all).await.expect("every deadline fired");
    let conns: Vec<_> = (0..64).map(|conn| tokio::spawn(Keeps::new(steady(conn)))).collect();
    let all = async {
        for conn in conns {
            conn.await.unwrap();
        }
    };
    tokio::time::timeout(Duration::from_secs(60), all).await.expect("every deadline under one limit fired");
}

/// An inner request on a handler's own runtime can borrow the connection's timer, which belongs
/// to the runtime that polls the connection. If that runtime shuts down while the deadline waits
/// on the timer, its next poll panics inside the handler's catch. The inner request is answered
/// 500, not the 503 it would get if its deadline fired (`docs/design.md#choice-deadline-timer`, cost 6).
#[test]
fn a_request_on_a_handlers_own_runtime_is_answered_500_once_the_connections_runtime_has_shut_down() {
    use std::{
        future::{poll_fn, Future},
        pin::pin,
        time::Instant,
    };
    use tokio::io::AsyncWriteExt;
    const WAIT: Duration = Duration::from_secs(10);
    const DEADLINE: Duration = Duration::from_secs(60);
    let outer = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let (armed, mut arming) = tokio::sync::mpsc::unbounded_channel();
    // The inner answer cannot be sent to the client once the outer runtime is gone.
    let (saw, seen) = std::sync::mpsc::channel();
    let inner_routes = Table::new().route("/never", get(std::future::pending::<&'static str>));
    let inner = App::new(Routes::from(inner_routes)).deadline(DEADLINE).dev(true).router();
    let relay = get(move || {
        let (inner, armed, saw) = (inner.clone(), armed.clone(), saw.clone());
        async move {
            tokio::task::block_in_place(move || {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                let (status, body) = runtime.block_on(async {
                    let request = Request::get("/never").header("accept", "text/html").body(Body::empty()).unwrap();
                    let mut answer = pin!(inner.oneshot(request));
                    let began = Instant::now();
                    let before = taken();
                    let mut armed = Some(armed);
                    let res = poll_fn(|cx| {
                        let polled = answer.as_mut().poll(cx);
                        if let Some(armed) = armed.take() {
                            assert!(polled.is_pending(), "the inner request waits on its deadline");
                            assert_eq!(taken() - before, 1, "the inner deadline borrowed the connection's timer");
                            // Counted at reset, and the request's pending poll has now armed it.
                            let _ = armed.send(began);
                        }
                        polled
                    })
                    .await
                    .unwrap();
                    let status = res.status().as_u16();
                    let body = res.into_body().collect().await.unwrap().to_bytes();
                    (status, body)
                });
                let _ = saw.send((status, body));
                status.to_string()
            })
        }
    });
    let warm_up = get(|| async {
        let (counted, waited) = tokio::sync::oneshot::channel();
        crate::deadline::WAITED_POLL.set(Some(counted));
        waited.await.expect("the connection counted this deadline in a pending poll");
        "done"
    });
    let routes = Table::new().route("/wait", warm_up).route("/inner/never", relay);
    let (open, borrowed) = outer.block_on(async {
        let (addr, stop, server) = listening(App::new(Routes::from(routes))).await;
        let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
        // Each answer is held until its deadline's wait counts. Only then send the next request.
        for _ in 0..2 {
            let (status, body, _) = asked(&mut conn, "GET /wait").await;
            assert_eq!((status, body.as_str()), (200, "done"));
        }
        conn.write_all(b"GET /inner/never HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
        let borrowed = tokio::time::timeout(WAIT, arming.recv()).await;
        ((conn, stop, server), borrowed)
    });
    outer.shutdown_background();
    let began =
        borrowed.expect("the inner request armed the connection's timer in time").expect("the inner request reports arming");
    let (status, body) = seen.recv_timeout(WAIT).expect("the inner request answered after the connection's runtime shut down");
    assert!(began.elapsed() < DEADLINE, "the inner request answered before its deadline");
    assert_eq!(status, 500, "answered 500 once the connection's runtime has shut down");
    let body = String::from_utf8_lossy(&body);
    // Tokio can notice shutdown at the timer entry's check or when it reads the entry's result.
    assert!(
        body.contains("the handler panicked: A Tokio 1.x context was found, but it is being shutdown.")
            || body.contains("the handler panicked: timer error: the timer is shutdown"),
        "{body}"
    );
    drop(open);
}

/// A deadline polled while its thread ends, after the thread's place for a connection's timer is
/// gone (a connection kept in a thread-local and polled by that thread-local's destructor), makes
/// its own timer, as one does wherever its connection's is not to be had.
#[test]
fn a_deadline_polled_while_its_thread_ends_makes_its_own_timer() {
    use crate::deadline::{Keeps, Timer};
    use std::{cell::RefCell, future::Future, pin::pin, task::Poll};
    struct AtEnd(RefCell<Option<Box<dyn FnOnce()>>>);
    impl Drop for AtEnd {
        fn drop(&mut self) {
            if let Some(run) = self.0.get_mut().take() {
                run();
            }
        }
    }
    thread_local!(static AT_END: AtEnd = const { AtEnd(RefCell::new(None)) });
    let (said, heard) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        // A thread's locals are destroyed last made first: tokio's is made here, then this
        // test's, and the one a connection's timer is lent to at the connection's third poll
        // below, so that one is gone when this test's destructor runs and tokio's is not.
        drop(runtime.enter());
        AT_END.with(|_| ());
        let kept = said.clone();
        let mut conn = Box::pin(Keeps::new(std::future::poll_fn(move |cx| {
            let mut timer = pin!(Timer::Unset);
            assert!(timer.as_mut().poll(Duration::from_secs(30), cx).is_pending());
            let _ = kept.send(timer.is_kept());
            Poll::<()>::Pending
        })));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        {
            let _entered = runtime.enter();
            for _ in 0..3 {
                assert!(conn.as_mut().poll(&mut cx).is_pending());
            }
        }
        AT_END.with(|at_end| {
            *at_end.0.borrow_mut() = Some(Box::new(move || {
                let _entered = runtime.enter();
                let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
                let polled = conn.as_mut().poll(&mut cx).is_pending();
                let _ = said.send(polled);
                drop(conn);
            }));
        });
    });
    thread.join().expect("the thread ends without a panic");
    let all: Vec<bool> = heard.try_iter().collect();
    // Its own, its own, the connection's, and its own while the thread ends; then that the
    // connection's poll came back.
    assert_eq!(all, [false, false, true, false, true]);
}

/// A deadline that has its connection's timer and is dropped in the connection's poll while the
/// thread ends, after the thread's place for that timer is gone, drops the timer: there is
/// nowhere left to give it back to.
#[test]
fn a_deadline_dropped_while_its_thread_ends_drops_its_connections_timer() {
    use crate::deadline::{Keeps, Timer};
    use std::{
        cell::{Cell, RefCell},
        future::Future,
        rc::Rc,
        task::Poll,
    };
    struct AtEnd(RefCell<Option<Box<dyn FnOnce()>>>);
    impl Drop for AtEnd {
        fn drop(&mut self) {
            if let Some(run) = self.0.get_mut().take() {
                run();
            }
        }
    }
    thread_local!(static AT_END: AtEnd = const { AtEnd(RefCell::new(None)) });
    let (said, heard) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        // tokio's local, then this test's, then (at the connection's third poll) the one its timer
        // is lent to, which is therefore gone when this test's destructor runs.
        drop(runtime.enter());
        AT_END.with(|_| ());
        // The deadline that has the connection's timer, and whether the thread is ending.
        let (away, ending) = (Rc::new(RefCell::new(None)), Rc::new(Cell::new(false)));
        let (held, ends) = (away.clone(), ending.clone());
        let mut conn = Box::pin(Keeps::new(std::future::poll_fn(move |cx| {
            if ends.get() {
                drop(held.borrow_mut().take());
                return Poll::<()>::Pending;
            }
            let mut timer = Box::pin(Timer::Unset);
            assert!(timer.as_mut().poll(Duration::from_secs(30), cx).is_pending());
            if timer.is_kept() {
                *held.borrow_mut() = Some(timer);
            }
            Poll::Pending
        })));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        {
            let _entered = runtime.enter();
            for _ in 0..3 {
                assert!(conn.as_mut().poll(&mut cx).is_pending());
            }
        }
        let _ = said.send((away.borrow().is_some(), timers()));
        AT_END.with(|at_end| {
            *at_end.0.borrow_mut() = Some(Box::new(move || {
                let _entered = runtime.enter();
                ending.set(true);
                let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
                assert!(conn.as_mut().poll(&mut cx).is_pending());
                let _ = said.send((away.borrow().is_some(), timers()));
                drop(conn);
            }));
        });
    });
    thread.join().expect("the thread ends without a panic");
    let all: Vec<(bool, isize)> = heard.try_iter().collect();
    // The deadline has the connection's one timer; dropped while the thread ends, so is the timer.
    assert_eq!(all, [(true, 1), (false, 0)]);
}

/// How late a deadline's answer is, for a comparison of two builds: 200 requests whose handler
/// never answers, one after another on one kept-alive connection, each answered at the deadline
/// (50 ms); prints the least, the median and the most its answer took past that. `cargo test
/// --release -p corten-run --lib -- --ignored --exact --nocapture
/// tests::server::how_late_a_deadlines_answer_is`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn how_late_a_deadlines_answer_is() {
    const EACH: Duration = Duration::from_millis(50);
    let routes = Table::new()
        .route(
            "/wait",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(1)).await;
                "done"
            }),
        )
        .route("/never", get(std::future::pending::<&'static str>));
    let (addr, stop, server) = listening(App::new(Routes::from(routes)).deadline(EACH)).await;
    let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut past = Vec::new();
    for _ in 0..200 {
        asked(&mut conn, "GET /wait").await;
        let (status, _, took) = asked(&mut conn, "GET /never").await;
        assert_eq!(status, 503);
        past.push(took.checked_sub(EACH).expect("not before the deadline"));
    }
    past.sort();
    println!("past the deadline: least {:?}, median {:?}, most {:?}", past[0], past[past.len() / 2], past[past.len() - 1]);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}
