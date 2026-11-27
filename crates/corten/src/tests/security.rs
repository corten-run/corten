use super::api::api_module;
use super::*;

/// A DNS-rebound page names a host the app is not: every route, in every mode, answers 421 and
/// runs nothing of the app's, not even its error page.
#[tokio::test]
async fn a_request_for_another_host_is_misdirected_in_every_mode() {
    let routes = Table::new().route("/", get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) }));
    let router = App::new(Routes::from(routes))
        .error_page(test_error_page, ())
        .api::<ApiRoot>(|api| api.route::<ApiRates>(crate::Methods::reads(get(|| async { "rates" }))))
        .router();
    let rebound = "rebound.attacker.example:3917";
    for (uri, extra) in [
        ("/", &[][..]),
        ("/", &[("corten", "nav")][..]),
        ("/", &[("accept", "application/json")][..]),
        ("/missing", &[("accept", "text/html")][..]),
        ("/api/rates", &[][..]),
        ("/health/live", &[][..]),
    ] {
        let (status, body) = for_host(&router, uri, rebound, extra).await;
        assert_eq!((status, body.as_str()), (StatusCode::MISDIRECTED_REQUEST, "Misdirected request."), "{uri} {extra:?}");
    }
    for host in ["localhost:3917", "127.0.0.1:3917", "[::1]:3917", ""] {
        assert_eq!(for_host(&router, "/", host, &[]).await.0, StatusCode::OK, "{host:?}");
    }
    // A `Host` that is no host, or a second one, is not a request HTTP allows: a 400 the same
    // way, an app that answers to any host included. (A request the server read off a
    // connection is the test below.)
    let named = App::new(Routes::from(Table::new().route("/", get(|| async { "home" }))))
        .policy(crate::security::Policy::new().host("shop.example"))
        .router();
    assert_eq!(for_host(&named, "/", "shop.example", &[]).await.0, StatusCode::OK);
    assert_eq!(for_host(&named, "/", "www.shop.example", &[]).await.0, StatusCode::MISDIRECTED_REQUEST);
    let any = App::new(Routes::from(Table::new().route("/", get(|| async { "home" }))))
        .policy(crate::security::Policy::new().any_host())
        .router();
    assert_eq!(for_host(&any, "/", rebound, &[]).await.0, StatusCode::OK);
    for uri in ["/", "/missing", "/api/rates", "/health/live"] {
        for (host, extra) in [
            ("localhost:3917/path", &[][..]),
            ("user@localhost", &[][..]),
            ("localhost, rebound.attacker.example", &[][..]),
            ("localhost", &[("host", "localhost")][..]),
            ("shop.example", &[("host", "shop.example"), ("accept", "text/html")][..]),
        ] {
            for router in [&router, &named, &any] {
                let (status, body) = for_host(router, uri, host, extra).await;
                assert_eq!((status, body.as_str()), (StatusCode::BAD_REQUEST, "Bad request."), "{uri} {host:?} {extra:?}");
            }
        }
    }
}

/// A route through the stages that takes any one segment, as a path with a byte outside ASCII
/// would be, and one outside the stages.
#[crate::routes]
mod wire_url {
    #[route("/{word}", get = wire_word)]
    pub struct Word<'a> {
        pub word: &'a str,
    }

    #[route("/lane/{word}", get = wire_lane, unstaged)]
    pub struct Lane<'a> {
        pub word: &'a str,
    }
}

/// How many requests reached a handler of `wire_url`.
static WIRE_RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

async fn wire_word(at: crate::Params<wire_url::Word<'_>>) -> String {
    WIRE_RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("word {}", at.word)
}

async fn wire_lane(at: crate::Params<wire_url::Lane<'_>>) -> String {
    WIRE_RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("lane {}", at.word)
}

/// A connection to a server, for requests written out byte by byte.
struct Wire {
    stream: tokio::net::TcpStream,
    unread: Vec<u8>,
}

impl Wire {
    async fn to(addr: std::net::SocketAddr) -> Wire {
        Wire { stream: tokio::net::TcpStream::connect(addr).await.unwrap(), unread: Vec::new() }
    }

    /// More of what the server sent, or `false` once it has closed the connection.
    async fn more(&mut self) -> bool {
        use tokio::io::AsyncReadExt;
        let mut piece = [0; 4096];
        let read = tokio::time::timeout(Duration::from_secs(10), self.stream.read(&mut piece));
        let n = read.await.expect("the server neither answers nor closes").unwrap();
        self.unread.extend_from_slice(&piece[..n]);
        n > 0
    }

    /// Sends `request` as written and reads one answer on the same connection: its status, its
    /// head, and the body its `Content-Length` says.
    async fn ask(&mut self, request: &[u8]) -> (u16, String, String) {
        use tokio::io::AsyncWriteExt;
        let asked = String::from_utf8_lossy(request).into_owned();
        self.stream.write_all(request).await.unwrap();
        let end = loop {
            match self.unread.windows(4).position(|window| window == b"\r\n\r\n") {
                Some(at) => break at + 4,
                None => assert!(self.more().await, "the connection closed with no answer to {asked:?}"),
            }
        };
        let head = String::from_utf8(self.unread.drain(..end).collect()).unwrap();
        let length = head.lines().find_map(|line| line.strip_prefix("content-length: ")).map_or(0, |n| n.parse().unwrap());
        while self.unread.len() < length {
            assert!(self.more().await, "the connection closed in the answer to {asked:?}");
        }
        let body = String::from_utf8_lossy(&self.unread.drain(..length).collect::<Vec<_>>()).into_owned();
        (head[9..12].parse().unwrap(), head, body)
    }
}

/// `app` served on a free port of `127.0.0.1` until its sender is used.
async fn on_the_wire<M: crate::Middleware>(
    app: App<M>,
) -> (std::net::SocketAddr, tokio::sync::oneshot::Sender<()>, tokio::task::JoinHandle<std::io::Result<()>>) {
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
    let addr = listeners[0].local_addr().unwrap();
    let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
        let _ = stopped.await;
    }));
    (addr, stop, server)
}

/// What RFC 9112 3.2 has a server answer `400`, sent over a connection byte for byte: an
/// HTTP/1.1 request with no `Host` line, any with more than one, or with one that is not a host
/// and maybe a port. Each is refused before anything of the app runs, at a route through the
/// stages and at one outside them, and the connection answers the next request: the server
/// read the whole message, so nothing asks it to close (9.3); where the message's body has not
/// arrived, the connection ends after the answer. A request-target that names its own host is
/// held to the same, by Corten's choice: its host and port are read where `Host` would be, and
/// one with a user, a port that is no number or an address in brackets that is not IPv6 is
/// refused. The rest of a request-target is let through as it was: one with a byte outside
/// ASCII, and `*` with a method that is not `OPTIONS`, are answered by the routes.
#[tokio::test]
async fn a_request_http_does_not_allow_is_a_400_and_its_connection_goes_on() {
    use std::sync::atomic::Ordering::Relaxed;
    const GOOD: &[u8] = b"GET /spec HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n";
    let app = App::new(wire_url::router()).error_page(test_error_page, ());
    let (addr, stop, server) = on_the_wire(app).await;
    let refused: &[&[u8]] = &[
        // No `Host` line; two that differ; two the same.
        b"GET /spec HTTP/1.1\r\n\r\n",
        b"GET /spec HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nHost: other.example.com\r\n\r\n",
        b"GET /spec HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nHost: 127.0.0.1:8080\r\n\r\n",
        // Not a host and maybe a port: a user, a path, nothing, a list.
        b"GET /spec HTTP/1.1\r\nHost: user@127.0.0.1:8080\r\n\r\n",
        b"GET /spec HTTP/1.1\r\nHost: 127.0.0.1:8080/path\r\n\r\n",
        b"GET /spec HTTP/1.1\r\nHost: \r\n\r\n",
        b"GET /spec HTTP/1.1\r\nHost: 127.0.0.1:8080, other.example.com\r\n\r\n",
        // The same at a route outside the stages.
        b"GET /lane/spec HTTP/1.1\r\n\r\n",
        b"GET /lane/spec HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nHost: other.example.com\r\n\r\n",
        b"GET /lane/spec HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nHost: 127.0.0.1:8080\r\n\r\n",
        b"GET /lane/spec HTTP/1.1\r\nHost: user@127.0.0.1:8080\r\n\r\n",
        b"GET /lane/spec HTTP/1.1\r\nHost: 127.0.0.1:8080/path\r\n\r\n",
        b"GET /lane/spec HTTP/1.1\r\nHost: \r\n\r\n",
        b"GET /lane/spec HTTP/1.1\r\nHost: 127.0.0.1:8080, other.example.com\r\n\r\n",
        // More of each kind: a third line, a port that is no number, a second colon, an address
        // that is not IPv6 in brackets, a second `Host` beside a target of its own kind, and a
        // target that names the host with no `Host` line beside it, or with one that is no host.
        b"GET /spec HTTP/1.1\r\nHost: localhost\r\nAccept: */*\r\nhost: localhost\r\nHOST: localhost\r\n\r\n",
        b"GET /spec HTTP/1.1\r\nHost: localhost:http\r\n\r\n",
        b"GET /spec HTTP/1.1\r\nHost: localhost:80:80\r\n\r\n",
        b"GET /spec HTTP/1.1\r\nHost: [localhost]\r\n\r\n",
        b"GET /spec HTTP/1.1\r\nHost: [::1\r\n\r\n",
        b"GET /caf\xC3\xA9 HTTP/1.1\r\nHost: localhost\r\nHost: localhost\r\n\r\n",
        b"DELETE * HTTP/1.1\r\n\r\n",
        b"GET http://localhost/spec HTTP/1.1\r\n\r\n",
        b"GET http://localhost/spec HTTP/1.1\r\nHost: localhost/spec\r\n\r\n",
        b"GET http://user@localhost/spec HTTP/1.1\r\nHost: localhost\r\n\r\n",
        // A target's own host and port are held to what a `Host` is, beside a `Host` that is
        // one: a port that is no number, an address in brackets that is not IPv6, one with a
        // zone, and a host alone that is none, at a route through the stages and outside them.
        b"GET http://localhost:abc/spec HTTP/1.1\r\nHost: localhost\r\n\r\n",
        b"GET http://[v1.x]/spec HTTP/1.1\r\nHost: localhost\r\n\r\n",
        b"GET http://[fe80::1%25eth0]/spec HTTP/1.1\r\nHost: localhost\r\n\r\n",
        b"GET http://localhost:abc/lane/spec HTTP/1.1\r\nHost: localhost\r\n\r\n",
        b"GET http://[v1.x]/lane/spec HTTP/1.1\r\nHost: localhost\r\n\r\n",
        b"GET localhost:abc HTTP/1.1\r\nHost: localhost\r\n\r\n",
        // No `Host` among other lines, where the first line is not the place to look.
        b"GET /spec HTTP/1.1\r\nAccept: */*\r\nUser-Agent: probe\r\n\r\n",
        b"GET /lane/spec HTTP/1.1\r\nAccept: */*\r\n\r\n",
        // A body the server has read is left behind with its request.
        b"GET /spec HTTP/1.1\r\nHost: a, b\r\nContent-Length: 5\r\n\r\nhello",
    ];
    let mut wire = Wire::to(addr).await;
    for request in refused {
        let asked = String::from_utf8_lossy(request);
        let (status, head, body) = wire.ask(request).await;
        assert_eq!((status, body.as_str()), (400, "Bad request."), "{asked:?}: {head}");
        assert!(head.contains("\r\ncontent-type: text/plain; charset=utf-8\r\n"), "{asked:?}: {head}");
        assert!(head.contains("\r\nx-content-type-options: nosniff\r\n"), "{asked:?}: {head}");
        assert!(head.contains("\r\ncache-control: private, no-cache\r\n"), "{asked:?}: {head}");
        assert!(!head.contains("\r\nconnection:"), "{asked:?}: {head}");
        assert_eq!(WIRE_RUNS.load(Relaxed), 0, "{asked:?} reached a handler");
        // The connection is open: the next request on it is answered, by its handler.
        let (status, _, body) = wire.ask(GOOD).await;
        assert_eq!((status, body.as_str()), (200, "word spec"), "after {asked:?}");
        assert_eq!(WIRE_RUNS.swap(0, Relaxed), 1);
    }
    // HTTP/1.0 may leave `Host` out, but not send a wrong one or two; the server closes after an
    // HTTP/1.0 answer, so each has a connection of its own.
    for request in [
        &b"GET /spec HTTP/1.0\r\nHost: 127.0.0.1:8080, other.example.com\r\n\r\n"[..],
        b"GET /lane/spec HTTP/1.0\r\nHost: localhost\r\nHost: localhost\r\n\r\n",
    ] {
        let (status, head, body) = Wire::to(addr).await.ask(request).await;
        assert_eq!((status, body.as_str()), (400, "Bad request."), "{head}");
    }
    assert_eq!(WIRE_RUNS.load(Relaxed), 0);
    // A target that is not UTF-8 does not reach the app: hyper cannot parse the line, answers a
    // `400` of its own and closes the connection, as before.
    let mut unparsed = Wire::to(addr).await;
    let (status, head, body) = unparsed.ask(b"GET /caf\xE9 HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n").await;
    assert_eq!((status, body.as_str()), (400, ""), "{head}");
    assert!(!unparsed.more().await, "open after a request-line that does not parse");

    // What does not change. Each on the one connection, with the answer it had before.
    let answered: &[(&[u8], u16, &str)] = &[
        (GOOD, 200, "word spec"),
        // `Host` after other lines, as some clients write it.
        (b"GET /spec HTTP/1.1\r\nAccept: */*\r\nUser-Agent: probe\r\nHost: localhost\r\n\r\n", 200, "word spec"),
        (b"GET /lane/spec HTTP/1.1\r\nAccept: */*\r\nHost: localhost\r\n\r\n", 200, "lane spec"),
        // And there it is held to the app's names as on the first line.
        (b"GET /spec HTTP/1.1\r\nAccept: */*\r\nHost: other.example\r\n\r\n", 421, "Misdirected request."),
        (
            b"GET /lane/spec HTTP/1.1\r\nAccept: */*\r\nUser-Agent: probe\r\nHost: other.example\r\n\r\n",
            421,
            "Misdirected request.",
        ),
        (b"GET /lane/spec HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n", 200, "lane spec"),
        // The header's name in any case, the host's too; a port, none, or an empty one.
        (b"GET /spec HTTP/1.1\r\nhOsT: LocalHost:8080\r\n\r\n", 200, "word spec"),
        (b"GET /lane/spec HTTP/1.1\r\nHOST: LOCALHOST\r\n\r\n", 200, "lane spec"),
        (b"GET /spec HTTP/1.1\r\nHost: localhost\r\n\r\n", 200, "word spec"),
        (b"GET /spec HTTP/1.1\r\nHost: localhost:\r\n\r\n", 200, "word spec"),
        (b"GET /spec HTTP/1.1\r\nHost: app.localhost:8080\r\n\r\n", 200, "word spec"),
        (b"GET /spec HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", 200, "word spec"),
        // An IPv6 address, in brackets.
        (b"GET /spec HTTP/1.1\r\nHost: [::1]:8080\r\n\r\n", 200, "word spec"),
        (b"GET /lane/spec HTTP/1.1\r\nHost: [::1]\r\n\r\n", 200, "lane spec"),
        (b"GET /spec HTTP/1.1\r\nHost: [2001:db8::7]:8080\r\n\r\n", 200, "word spec"),
        // A target that names the host: it is the one asked for, whatever `Host` names.
        (b"GET http://127.0.0.1:8080/spec HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n", 200, "word spec"),
        (b"GET http://localhost/lane/spec HTTP/1.1\r\nHost: other.example.com\r\n\r\n", 200, "lane spec"),
        (b"GET http://other.example.com/ HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n", 421, "Misdirected request."),
        // A host that is one, and not the app's, is still the 421.
        (b"GET /spec HTTP/1.1\r\nHost: rebound.attacker.example:8080\r\n\r\n", 421, "Misdirected request."),
        (b"GET /lane/spec HTTP/1.1\r\nHost: rebound.attacker.example\r\n\r\n", 421, "Misdirected request."),
        (b"GET /spec HTTP/1.1\r\nHost: a.example,b.example\r\n\r\n", 421, "Misdirected request."),
        // A path percent-encoded, as a browser sends one.
        (b"GET /caf%C3%A9 HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n", 200, "word caf\u{e9}"),
        // And with its bytes as they are, in a path or a query: let through to the routes, as
        // before, though no URI holds them.
        (b"GET /caf\xC3\xA9 HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n", 200, "word caf\u{e9}"),
        (b"GET /lane/caf\xC3\xA9 HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n", 200, "lane caf\u{e9}"),
        (b"GET /spec?q=caf\xC3\xA9 HTTP/1.1\r\nHost: localhost\r\n\r\n", 200, "word spec"),
        // `*` with any method, and `CONNECT`, are answered as they were: no route is at either.
        (b"GET * HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n", 404, ""),
        (b"DELETE * HTTP/1.1\r\nHost: localhost\r\n\r\n", 404, ""),
        (b"OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n", 404, ""),
        (b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n", 421, "Misdirected request."),
    ];
    let mut runs = 0;
    for (request, status, body) in answered {
        let asked = String::from_utf8_lossy(request);
        let (answered, head, text) = wire.ask(request).await;
        assert_eq!(answered, *status, "{asked:?}: {head}{text}");
        if !body.is_empty() {
            assert_eq!(text, *body, "{asked:?}");
        }
        runs += usize::from(*status == 200);
        assert_eq!(WIRE_RUNS.load(Relaxed), runs, "{asked:?}");
    }
    // HTTP/1.0 has no `Host` to send, and is answered as before, at both routes.
    for (request, body) in [(&b"GET /spec HTTP/1.0\r\n\r\n"[..], "word spec"), (b"GET /lane/spec HTTP/1.0\r\n\r\n", "lane spec")]
    {
        let (status, head, text) = Wire::to(addr).await.ask(request).await;
        assert_eq!((status, text.as_str()), (200, body), "{head}");
    }
    // A refused request whose body has not arrived: the server cannot tell where the next
    // request starts, so after the `400` the connection ends, at both routes.
    WIRE_RUNS.store(0, Relaxed);
    for request in [
        &b"GET /spec HTTP/1.1\r\nHost: a, b\r\nContent-Length: 5\r\n\r\n"[..],
        b"POST /lane/spec HTTP/1.1\r\nContent-Length: 5\r\n\r\n",
    ] {
        let mut unread = Wire::to(addr).await;
        let (status, head, body) = unread.ask(request).await;
        assert_eq!((status, body.as_str()), (400, "Bad request."), "{head}");
        assert!(!unread.more().await, "open after a refused request whose body did not arrive: {head}");
    }
    assert_eq!(WIRE_RUNS.load(Relaxed), 0);
    drop(wire);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    // An app that answers to any host reads the same rules: what it gives up is the names.
    WIRE_RUNS.store(0, Relaxed);
    let any = App::new(wire_url::router()).policy(crate::security::Policy::new().any_host());
    let (addr, stop, server) = on_the_wire(any).await;
    let mut wire = Wire::to(addr).await;
    for request in [
        &b"GET /spec HTTP/1.1\r\n\r\n"[..],
        b"GET /lane/spec HTTP/1.1\r\n\r\n",
        b"GET /spec HTTP/1.1\r\nHost: shop.example\r\nHost: shop.example\r\n\r\n",
        b"GET /lane/spec HTTP/1.1\r\nHost: user@shop.example\r\n\r\n",
        b"GET /lane/spec HTTP/1.1\r\nAccept: */*\r\nHost: shop.example/x\r\n\r\n",
        b"GET http://shop.example:abc/spec HTTP/1.1\r\nHost: shop.example\r\n\r\n",
        b"GET http://[v1.x]/lane/spec HTTP/1.1\r\nHost: shop.example\r\n\r\n",
    ] {
        let (status, head, body) = wire.ask(request).await;
        assert_eq!((status, body.as_str()), (400, "Bad request."), "{head}");
    }
    assert_eq!(WIRE_RUNS.load(Relaxed), 0);
    for (request, body) in [
        (&b"GET /spec HTTP/1.1\r\nHost: shop.example:8443\r\n\r\n"[..], "word spec"),
        (b"GET /lane/spec HTTP/1.1\r\nHost: rebound.attacker.example\r\n\r\n", "lane spec"),
        (b"GET /lane/spec HTTP/1.1\r\nAccept: */*\r\nHost: other.example\r\n\r\n", "lane spec"),
        (b"GET /lane/caf\xC3\xA9 HTTP/1.1\r\nHost: shop.example\r\n\r\n", "lane caf\u{e9}"),
    ] {
        let (status, head, text) = wire.ask(request).await;
        assert_eq!((status, text.as_str()), (200, body), "{head}");
    }
    drop(wire);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();

    // A layer of the app's that gives each request another body and runs it on a task of its
    // own takes nothing from this: the server marked the request it read, and the mark goes
    // where the request goes.
    WIRE_RUNS.store(0, Relaxed);
    let layered = App::new(wire_url::router()).layer(OuterFn(|req: crate::http::Request, next: crate::Router| async move {
        let req = req.map(|body| Body::new(http_body_util::Limited::new(body, 1 << 20)));
        tokio::spawn(next.oneshot(req)).await.unwrap().unwrap()
    }));
    let (addr, stop, server) = on_the_wire(layered).await;
    let mut wire = Wire::to(addr).await;
    for request in [&b"GET /spec HTTP/1.1\r\n\r\n"[..], b"GET /lane/spec HTTP/1.1\r\nAccept: */*\r\n\r\n"] {
        let (status, head, body) = wire.ask(request).await;
        assert_eq!((status, body.as_str()), (400, "Bad request."), "{head}");
    }
    assert_eq!(WIRE_RUNS.load(Relaxed), 0);
    let (status, head, body) = wire.ask(GOOD).await;
    assert_eq!((status, body.as_str()), (200, "word spec"), "{head}");
    let (status, head, body) = Wire::to(addr).await.ask(b"GET /lane/spec HTTP/1.0\r\n\r\n").await;
    assert_eq!((status, body.as_str()), (200, "lane spec"), "{head}");
    drop(wire);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

/// A layout with an inline script of its own, which takes the request's nonce.
#[crate::component]
fn Inline<'a>(req: &'a Req) -> impl Document + 'a {
    html! {
        <html>
            <head>
                <title>"Inline"</title>
                <Corten />
                <script nonce={req.nonce()}>"1"</script>
            </head>
            <body><main></main></body>
        </html>
    }
}

/// A page in the `Inline` layout, marked for shared caches.
pub(super) async fn inline_page(req: Req) -> Public<HtmlResult> {
    Public::new(std::time::Duration::from_secs(60), req.page(Inline { req: &req }))
}

/// The same page with the default caching.
pub(super) async fn inline_default_page(req: Req) -> HtmlResult {
    req.page(Inline { req: &req })
}

#[tokio::test]
async fn the_csp_allows_the_import_map_by_hash_and_a_nonce_only_when_the_shell_asks() {
    let (_, headers, body) = call(app(routes(), None), "GET", None).await;
    let csp = headers["content-security-policy"].to_str().unwrap();
    let import_map = crate::security::hash_source(&crate::import_map(None, None, &[]));
    assert!(csp.contains(&format!("script-src 'self' {import_map};")) && !csp.contains("nonce"), "{csp}");
    assert!(body.contains(&format!(r#"<script type="importmap">{}</script>"#, crate::import_map(None, None, &[]))));
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["cross-origin-opener-policy"], "same-origin");
    let (_, again, same) = call(app(routes(), None), "GET", None).await;
    assert_eq!(
        (again["content-security-policy"].clone(), same),
        (headers["content-security-policy"].clone(), body),
        "the same bytes"
    );

    let inline = || App::new(Routes::from(Table::new().route("/", get(inline_page)))).router();
    let (_, headers, body) = call(inline(), "GET", None).await;
    let csp = headers["content-security-policy"].to_str().unwrap();
    let nonce = csp.split("'nonce-").nth(1).unwrap().split('\'').next().unwrap();
    assert!(body.contains(&format!(r#"<script nonce="{nonce}">1</script>"#)), "{body}");
    let (_, again, _) = call(inline(), "GET", None).await;
    assert_ne!(again["content-security-policy"], headers["content-security-policy"], "a fresh nonce per request");
    let popups = App::new(Routes::from(routes())).policy(crate::security::Policy::new().allow_popups()).router();
    let (_, popups, _) = call(popups, "GET", None).await;
    assert_eq!(popups["cross-origin-opener-policy"], "same-origin-allow-popups");
}

#[tokio::test]
async fn the_app_refuses_cross_site_writes() {
    let router = app(routes(), None);
    let req = |site: &'static str| {
        Request::post("/").header("sec-fetch-site", site).header("corten", "action").body(Body::empty()).unwrap()
    };
    assert_eq!(router.clone().oneshot(req("cross-site")).await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_eq!(router.oneshot(req("same-origin")).await.unwrap().status(), StatusCode::OK);
}

/// A proxy may forward the whole target. The port is part of its authority, rather than
/// the port of the connection to the proxy or the value of the separate Host line.
#[tokio::test]
async fn absolute_target_names_the_origin_of_a_write() {
    use crate::security::Policy;
    for (policy, path_status) in
        [(Policy::new(), StatusCode::MISDIRECTED_REQUEST), (Policy::new().any_host(), StatusCode::NO_CONTENT)]
    {
        let routes = Table::new().route("/", crate::router::post(|| async { StatusCode::NO_CONTENT }));
        let router = App::new(Routes::from(routes)).policy(policy).router();
        // The in-process router did not read an HTTP/1.1 message from a connection. No Host
        // line is required here, but the authority is still available to the origin check.
        let no_line = Request::post("http://localhost/").header("origin", "http://localhost").body(Body::empty()).unwrap();
        assert_eq!(router.clone().oneshot(no_line).await.unwrap().status(), StatusCode::NO_CONTENT);
        let path = Request::post("/").header("host", "proxy.example").body(Body::empty()).unwrap();
        assert_eq!(router.clone().oneshot(path).await.unwrap().status(), path_status);
        for (target, origin, site, expected) in [
            ("http://localhost/", "http://localhost", None, StatusCode::NO_CONTENT),
            ("http://localhost/", "http://proxy.example", None, StatusCode::FORBIDDEN),
            ("http://localhost:8000/", "http://localhost:8000", None, StatusCode::NO_CONTENT),
            ("http://localhost:8000/", "http://localhost", None, StatusCode::FORBIDDEN),
            ("http://localhost:80/", "http://localhost", None, StatusCode::NO_CONTENT),
            ("https://localhost/", "https://localhost:443", None, StatusCode::NO_CONTENT),
            ("http://localhost/", "http://localhost", Some("cross-site"), StatusCode::FORBIDDEN),
            ("http://localhost/", "http://localhost", Some("same-origin"), StatusCode::NO_CONTENT),
        ] {
            let mut req = Request::post(target).header("host", "proxy.example").header("origin", origin);
            if let Some(site) = site {
                req = req.header("sec-fetch-site", site);
            }
            let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(res.status(), expected, "{target} {origin} {site:?}");
        }
    }
}

#[tokio::test]
async fn an_absolute_form_write_over_a_connection_reaches_the_named_route() {
    let routes = Table::new().route("/", crate::router::post(|| async { StatusCode::NO_CONTENT }));
    let (addr, stop, server) = on_the_wire(App::new(Routes::from(routes))).await;
    let mut wire = Wire::to(addr).await;
    let (status, _, _) = wire
        .ask(b"POST http://localhost/ HTTP/1.1\r\nHost: proxy.example\r\nOrigin: http://localhost\r\nContent-Length: 0\r\n\r\n")
        .await;
    assert_eq!(status, 204);
    let (status, _, _) = wire
        .ask(b"POST http://localhost/ HTTP/1.1\r\nHost: proxy.example\r\nOrigin: http://other.example\r\nContent-Length: 0\r\n\r\n")
        .await;
    assert_eq!(status, 403);
    drop(wire);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

#[test]
fn an_authority_form_target_supplies_the_origin_comparisons_port() {
    let policy = crate::security::Policy::new();
    let req = Request::builder()
        .method(http::Method::CONNECT)
        .uri("shop.example:8443")
        .header("origin", "https://shop.example:8443")
        .header("host", "shop.example")
        .body(())
        .unwrap();
    assert!(policy.same_origin(req.method(), req.uri(), req.headers()));
}

#[test]
fn an_https_only_policy_checks_the_origin_against_the_supplied_target() {
    let policy = crate::security::Policy::new().hsts();
    let uri = http::Uri::from_static("https://shop.example/");
    for (origin, allowed) in [("https://shop.example", true), ("http://shop.example", false)] {
        let req = Request::post(uri.clone()).header("origin", origin).header("host", "proxy.example").body(()).unwrap();
        assert_eq!(policy.same_origin(req.method(), req.uri(), req.headers()), allowed, "{origin}");
    }
}

/// A write redirected to an origin the form's page does not allow in `form-action` is an error in
/// a debug build, as the browser stops it there; one the policy allows, a path, a page's own
/// host and a `GET` are not, and an area's policy or the sending page's counts.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_write_redirected_outside_form_action_is_an_error_in_debug_builds() {
    use crate::security::Policy;
    let to = |uri: &'static str| {
        crate::router::post(move |req: Req| async move {
            let uri: http::Uri = uri.parse().unwrap();
            req.redirect::<()>(&uri)
        })
    };
    let routes = Table::new()
        .route("/sibling", to("http://localhost:9999/account"))
        .route("/pay", to("https://pay.example/checkout?o=1"))
        .route("/sub", to("https://id.shop.example/login"))
        .route("/own", to("http://app.localhost/done"))
        .route("/path", to("/done"))
        .route("/public", to("https://app.localhost/done"))
        .route("/else", to("https://else.example/x"))
        .route(
            "/relay",
            crate::router::post(|| async {
                let mut headers = http::HeaderMap::new();
                headers.insert(http::header::LOCATION, http::HeaderValue::from_static("https://upstream.example/x"));
                crate::Relay::new(StatusCode::FOUND, headers, Body::empty())
            }),
        )
        .route(
            "/read",
            get(|req: Req| async move { req.redirect::<()>(&"https://else.example/".parse::<http::Uri>().unwrap()) }),
        );
    let policy = Policy::new()
        .form_action("https://pay.example")
        .form_action("https://*.shop.example")
        .allow_origin("https://idp.example");
    let router = App::new(Routes::from(routes))
        .policy(policy)
        .area(|area| checkout_url::area(area).policy(|p| p.form_action("http://localhost:9999")))
        .router();
    let send = |path: &'static str, method: &'static str, headers: &'static [(&'static str, &'static str)]| {
        let router = router.clone();
        async move {
            let mut req = Request::builder().method(method).uri(path).header("accept", "text/html");
            for (name, value) in headers {
                req = req.header(*name, *value);
            }
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let status = res.status();
            let body = crate::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
            (status, String::from_utf8(body.to_vec()).unwrap())
        }
    };
    for mode in [&[][..], &[("corten", "action")][..], &[("corten", "action"), ("sec-fetch-mode", "cors")][..]] {
        let (status, _) = send("/else", "POST", mode).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{mode:?}");
    }
    let (status, _) = send("http://app.localhost/own", "POST", &[("host", "proxy.example")]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "a redirect to the target's own host is 'self'");
    // Without a Referer the form may be on any of the app's pages: the checkout area allows this.
    let (status, _) = send("/sibling", "POST", &[]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "some page of the app allows it");
    // A script's own fetch is held to connect-src, not form-action.
    let (status, _) = send("/sibling", "POST", &[("sec-fetch-mode", "cors"), ("sec-fetch-site", "same-origin")]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "a fetch");
    // A relayed answer is passed on as it came.
    let (status, _) = send("/relay", "POST", &[]).await;
    assert_eq!(status, StatusCode::FOUND, "a relay");
    // Behind a proxy that rewrites Host, the page's origin is the browser's Origin.
    const PROXIED: &[(&str, &str)] =
        &[("host", "127.0.0.1:3000"), ("origin", "https://app.localhost"), ("sec-fetch-site", "same-origin")];
    let (status, _) = send("/public", "POST", PROXIED).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "the page's own origin");
    const PLAIN: &[(&str, &str)] =
        &[("host", "app.localhost"), ("origin", "http://app.localhost"), ("sec-fetch-site", "same-origin")];
    let (status, _) = send("/public", "POST", PLAIN).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "an http page may go to its https origin");
    const SECURE: &[(&str, &str)] =
        &[("host", "app.localhost"), ("origin", "https://app.localhost"), ("sec-fetch-site", "same-origin")];
    let (status, _) = send("/own", "POST", SECURE).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "an https page's form may not go to http");
    for path in ["/pay", "/sub", "/path"] {
        let (status, _) = send(path, "POST", &[]).await;
        assert!(status == StatusCode::SEE_OTHER, "{path}: {status}");
    }
    let (status, _) = send("/own", "POST", &[("host", "app.localhost")]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "the request's own host is 'self'");
    let (status, _) = send("/own", "POST", &[]).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "with no Host, an address is another origin");
    let (status, _) = send("/read", "GET", &[]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "a GET is not held to form-action");
    // An area's policy holds a write at its path, and the page the form was on counts too.
    let (status, _) = send("/checkout/go", "POST", &[]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "the area allows it");
    const FROM_AREA: &[(&str, &str)] = &[("host", "app.localhost"), ("referer", "http://app.localhost/checkout?step=2")];
    let (status, _) = send("/sibling", "POST", FROM_AREA).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "the form's page, in the area, allows it");
    // A post from another site's page (an identity provider's form_post) is that page's policy's.
    const IDP: &[(&str, &str)] =
        &[("host", "app.localhost"), ("origin", "https://idp.example"), ("sec-fetch-site", "cross-site")];
    assert_eq!(send("/else", "POST", IDP).await.0, StatusCode::SEE_OTHER, "cross-site");
    const IDP_OLD: &[(&str, &str)] = &[("host", "app.localhost"), ("origin", "https://idp.example")];
    assert_eq!(send("/else", "POST", IDP_OLD).await.0, StatusCode::SEE_OTHER, "another origin, no Sec-Fetch-Site");
    // A test that names no host and sends the form's page is held to that page's policy.
    let (status, _) = send("/sibling", "POST", &[("referer", "http://app.localhost/news")]).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "the Referer alone says the page");
    const FROM_NEWS: &[(&str, &str)] = &[("host", "app.localhost"), ("referer", "http://app.localhost/news")];
    let (status, _) = send("/sibling", "POST", FROM_NEWS).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "the news page does not allow it");
    // A Referer of `/` is what any page under a referrer policy that sends only the origin sends
    // (one the page set itself included): it names no page.
    const ROOT: &[(&str, &str)] = &[("host", "app.localhost"), ("referer", "http://app.localhost/")];
    let (status, _) = send("/sibling", "POST", ROOT).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "a Referer of / may be any page");
    // Other ways a browser says the page is not one of the app's, and the bodies a form sends.
    for site in ["same-site", "none"] {
        let headers: &'static [(&'static str, &'static str)] = match site {
            // Allowed by `allow_origin`, else the write is refused before the check.
            "same-site" => &[("host", "app.localhost"), ("origin", "https://idp.example"), ("sec-fetch-site", "same-site")],
            _ => &[("host", "app.localhost"), ("origin", "http://app.localhost"), ("sec-fetch-site", "none")],
        };
        assert_eq!(send("/else", "POST", headers).await.0, StatusCode::SEE_OTHER, "{site}");
    }
    for body in ["multipart/form-data; boundary=x", "text/plain"] {
        let headers: &'static [(&'static str, &'static str)] = match body {
            "text/plain" => &[("content-type", "text/plain")],
            _ => &[("content-type", "multipart/form-data; boundary=x")],
        };
        assert_eq!(send("/else", "POST", headers).await.0, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    }
    // An https page's Origin and a Host that writes its default port are the same origin.
    const PORT: &[(&str, &str)] =
        &[("host", "app.localhost:443"), ("origin", "https://app.localhost"), ("sec-fetch-site", "same-origin")];
    assert_eq!(send("/public", "POST", PORT).await.0, StatusCode::SEE_OTHER, "Host with :443");
    // A browser that does not say the page's origin is not checked.
    const NULL: &[(&str, &str)] = &[("host", "127.0.0.1:3000"), ("origin", "null"), ("sec-fetch-site", "same-origin")];
    let (status, _) = send("/else", "POST", NULL).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "Origin: null");
    // A Host with its scheme's default port is the same host.
    let (status, _) = send("/own", "POST", &[("host", "app.localhost:80")]).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "Host with :80");
    // Only the form's page's policy counts, not the one at the path it posts to.
    const FROM_HOME: &[(&str, &str)] = &[
        ("host", "app.localhost"),
        ("origin", "http://app.localhost"),
        ("sec-fetch-site", "same-origin"),
        ("referer", "http://app.localhost/news"),
    ];
    let (status, _) = send("/checkout/go", "POST", FROM_HOME).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "the news page does not allow it");
    // A browser that sends no page (no-referrer) may be on any of the app's pages.
    const NO_PAGE: &[(&str, &str)] =
        &[("host", "app.localhost"), ("origin", "http://app.localhost"), ("sec-fetch-site", "same-origin")];
    let (status, _) = send("/sibling", "POST", NO_PAGE).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "some page of the app allows it");
    let (status, _) = send("/pay", "POST", NO_PAGE).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
}

/// The 500 says which origin and what allows it, under `corten dev`; a sign-in on another origin
/// is checked as a redirect is.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_redirect_outside_form_action_names_the_origin_and_a_sign_in_is_checked() {
    let routes = Table::new()
        .route(
            "/go",
            crate::router::post(|req: Req| async move {
                req.redirect::<()>(&"https://else.example/x?y=1".parse::<http::Uri>().unwrap())
            }),
        )
        .route("/account", crate::router::post(|_: Caller<Elsewhere>| async { "saved" }))
        .route(
            "/cookie",
            crate::router::post(|| async {
                use crate::http::header;
                use crate::http::HeaderValue;
                use crate::response::IntoResponse;
                let mut res = StatusCode::SEE_OTHER.into_response();
                let headers = res.headers_mut();
                headers.insert(header::LOCATION, HeaderValue::from_static("//user:pw@else.example/secret?token=abc"));
                headers.append(header::SET_COOKIE, HeaderValue::from_static("a=1"));
                headers.append(header::SET_COOKIE, HeaderValue::from_static("b=2"));
                res
            }),
        );
    let dev = App::new(Routes::from(routes.clone())).dev(true).router();
    let (status, _, body) = call_with(dev.clone(), "POST", "/go", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body.contains("https://else.example") && body.contains("Policy::form_action"), "{body}");
    assert!(!body.contains("/x?y=1"), "the origin alone: {body}");
    assert!(body.contains("send a Host in the test"), "no host is known: {body}");
    let (status, headers, body) = call_with(dev.clone(), "POST", "/cookie", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let cookies: Vec<_> = headers.get_all("set-cookie").iter().collect();
    assert_eq!(cookies, ["a=1", "b=2"], "the handler's cookies are kept");
    assert!(!headers.contains_key("location"));
    assert!(body.contains("else.example") && !body.contains("token") && !body.contains("pw@"), "the origin alone: {body}");
    let (status, _, body) = call_with(dev, "POST", "/account", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(body.contains("https://id.example") && body.contains("Policy::form_action"), "{body}");
    let allowed = App::new(Routes::from(routes.clone())).policy(crate::security::Policy::new().form_action("https://id.example"));
    let (status, ..) = call_with(allowed.router(), "POST", "/account", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "allowed, it is the sign-in redirect");
    let (status, _, body) =
        call_with(App::new(Routes::from(routes.clone())).router(), "POST", "/go", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body.contains("https://else.example") && body.contains("Policy::form_action"), "outside dev too: {body}");
    let (status, _, body) =
        call_with(App::new(Routes::from(routes.clone())).router(), "POST", "/account", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body.contains("https://id.example"), "a sign-in's outside dev too: {body}");
    // A report-only policy stops nothing.
    let watching = App::new(Routes::from(routes)).policy(crate::security::Policy::new().report_only());
    let (status, ..) = call_with(watching.router(), "POST", "/go", None, Some("text/html")).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "report-only");
}

/// `resend_to` answers a write with a 307 to a page of the app in every mode, so the browser (or a
/// `data-patch` form's fetch, which follows it) sends the same form there with the cookie set
/// beside it; on a `GET` it is an error that says to redirect (#717).
#[tokio::test]
async fn a_write_resends_its_form_with_a_307_in_every_mode() {
    #[derive(crate::Route)]
    #[route("/items/{id}")]
    struct Item<'a> {
        id: &'a str,
    }
    async fn start(req: Req) -> HtmlResult {
        let to = crate::Local::parse("/start/again?x=1").unwrap();
        Ok(req.resend_to(&to)?.with_cookie(crate::security::cookie::SetCookie::new("guest", "g1")))
    }
    let routes = Table::new()
        .route("/start", get(start).post(start))
        .route("/item", crate::router::post(|req: Req| async move { req.resend_to::<()>(&Item { id: "7" }) }));
    let router = App::new(Routes::from(routes)).router();
    for mode in [None, Some("action")] {
        let (status, headers, _) = call_with(router.clone(), "POST", "/start", mode, None).await;
        assert_eq!(
            (status, &headers["location"]),
            (StatusCode::TEMPORARY_REDIRECT, &"/start/again?x=1".parse().unwrap()),
            "{mode:?}"
        );
        assert!(headers["set-cookie"].to_str().unwrap().starts_with("guest=g1;"), "{mode:?}");
        assert!(!headers.contains_key("corten-location"), "a fetch follows a 307 itself: {mode:?}");
        let (status, headers, _) = call_with(router.clone(), "POST", "/item", mode, None).await;
        assert_eq!(
            (status, &headers["location"]),
            (StatusCode::TEMPORARY_REDIRECT, &"/items/7".parse().unwrap()),
            "a typed route: {mode:?}"
        );
    }
    for mode in [None, Some("nav")] {
        let (status, headers, _) = call_with(router.clone(), "GET", "/start", mode, None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "a GET is redirected, not resent: {mode:?}");
        assert!(!headers.contains_key("location") && !headers.contains_key("set-cookie"), "{mode:?}");
    }
    // A catch-all value that begins with `/` stays a path on this site (`/%2F..`, #727), so the
    // form goes there. A PUT, which the debug build's form-action check does not read. An address
    // a hand-written Route writes off the site is refused: a_path_that_starts_with_a_parameter_...
    #[derive(crate::Route)]
    #[route("/{*rest}")]
    struct Rest<'a> {
        rest: &'a str,
    }
    let off = Table::new()
        .route("/off", crate::router::put(|req: Req| async move { req.resend_to::<()>(&Rest { rest: "/evil.example/x" }) }));
    let (status, headers, _) = call_with(App::new(Routes::from(off)).router(), "PUT", "/off", None, None).await;
    assert_eq!((status, &headers["location"]), (StatusCode::TEMPORARY_REDIRECT, &"/%2Fevil.example/x".parse().unwrap()));
}

/// Only a form's post is checked (a form sends nothing else), a test's request is on the app's
/// own names, and a page whose policy sends only its origin as `Referer` may be any page.
#[cfg(debug_assertions)]
#[tokio::test]
async fn only_a_form_post_is_checked_against_form_action() {
    use crate::security::{Policy, Referrer};
    let to = |uri: &'static str| {
        move |req: Req| async move {
            let uri: http::Uri = uri.parse().unwrap();
            req.redirect::<()>(&uri)
        }
    };
    let routes = Table::new()
        .route("/else", crate::router::post(to("https://else.example/x")).put(to("https://else.example/x")))
        .route("/canonical", crate::router::post(to("https://app.example/done")))
        .route("/sibling", crate::router::post(to("http://localhost:9999/account")));
    let router = App::new(Routes::from(routes))
        .policy(Policy::new().host("app.example").referrer(Referrer::StrictOrigin))
        .area(|area| checkout_url::area(area).policy(|p| p.form_action("http://localhost:9999")))
        .router();
    let send = |method: &'static str, path: &'static str, headers: &'static [(&'static str, &'static str)]| {
        let router = router.clone();
        async move {
            let mut req = Request::builder().method(method).uri(path).header("accept", "text/html");
            for (name, value) in headers {
                req = req.header(*name, *value);
            }
            router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap().status()
        }
    };
    assert_eq!(send("POST", "/else", &[]).await, StatusCode::INTERNAL_SERVER_ERROR, "a form's post");
    const FORM: &[(&str, &str)] = &[("content-type", "application/x-www-form-urlencoded; charset=utf-8")];
    assert_eq!(send("POST", "/else", FORM).await, StatusCode::INTERNAL_SERVER_ERROR, "a form's body");
    assert_eq!(send("PUT", "/else", &[]).await, StatusCode::SEE_OTHER, "no form sends a PUT");
    const JSON: &[(&str, &str)] = &[("content-type", "application/json")];
    assert_eq!(send("POST", "/else", JSON).await, StatusCode::SEE_OTHER, "no form sends JSON");
    assert_eq!(send("POST", "/canonical", &[]).await, StatusCode::SEE_OTHER, "the app's own name, with no Host");
    // Under strict-origin every page's Referer is `/`: the form may be on the checkout page.
    const ROOT: &[(&str, &str)] = &[
        ("host", "app.example"),
        ("origin", "https://app.example"),
        ("sec-fetch-site", "same-origin"),
        ("referer", "https://app.example/"),
    ];
    assert_eq!(send("POST", "/sibling", ROOT).await, StatusCode::SEE_OTHER, "a Referer of / is not the page");
}

/// Someone signed in on another origin's sign-in page.
#[cfg(debug_assertions)]
#[derive(Clone, Hash)]
struct Elsewhere;

#[cfg(debug_assertions)]
impl<S: Sync> crate::Identify<S> for Elsewhere {
    async fn identify(_: &http::request::Parts, _: &S) -> std::result::Result<Self, crate::Refused> {
        Err(crate::Refused::sign_in(&"https://id.example/sign-in".parse::<http::Uri>().unwrap()))
    }
}

#[cfg(debug_assertions)]
#[crate::routes(area = Checkout)]
mod checkout_url {
    #[route("/checkout")]
    pub struct Checkout;

    #[route("/checkout/go", post = checkout_go)]
    pub struct Go;
}

#[cfg(debug_assertions)]
async fn checkout_go(req: Req) -> HtmlResult {
    req.redirect(&"http://localhost:9999/paid".parse::<http::Uri>().unwrap())
}

#[tokio::test]
async fn a_handler_that_takes_the_nonce_gets_the_one_in_the_csp() {
    let routes = Table::new().route(
        "/raw",
        get(|nonce: crate::security::Nonce| async move {
            ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], format!(r#"<script nonce="{}">1</script>"#, nonce.0))
        }),
    );
    let (_, headers, body) = call_with(App::new(Routes::from(routes)).router(), "GET", "/raw", None, None).await;
    let nonce = body.split(r#"nonce=""#).nth(1).unwrap().split('"').next().unwrap();
    assert!(headers["content-security-policy"].to_str().unwrap().contains(&format!("'nonce-{nonce}'")));
}

#[crate::routes]
pub(super) mod policy_url {
    #[route("/", get = policy_page)]
    pub struct Home;

    #[route("/csp-reports", post = policy_reports)]
    pub struct CspReports;
}

/// Where the tests' pages send what their CSP blocks.
async fn policy_reports(_: bytes::Bytes) -> StatusCode {
    StatusCode::NO_CONTENT
}

#[crate::routes(area = Pay)]
mod pay_url {
    #[route("/pay")]
    pub struct Pay;

    #[route("/pay/card", get = policy_page)]
    pub struct Card;
}

/// An area inside `/pay` that adds to it.
#[crate::routes(area = Charts)]
mod charts_url {
    #[route("/pay/charts")]
    pub struct Charts;

    #[route("/pay/charts/week", get = policy_page)]
    pub struct Week;
}

async fn policy_page(req: Req) -> HtmlResult {
    req.test_page("Page", html! { <p>"page"</p> })
}

fn policy_app() -> Router {
    App::new(policy_url::router())
        .policy(crate::security::Policy::new().img_src("https://img.example"))
        .area(|area| pay_url::area(area).policy(|p| p.script_src("https://js.stripe.com").frame_src("https://js.stripe.com")))
        .area(|area| charts_url::area(area).policy(|p| p.allow_style_attributes().script_src("https://js.stripe.com")))
        .router()
}

/// What a page answers: its CSP and its shell key.
async fn csp_and_shell(router: &Router, path: &str) -> (StatusCode, String, String) {
    let res = router.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
    let status = res.status();
    let csp = res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_string();
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    let shell = body.split(r#"name="corten-shell" content=""#).nth(1).map_or("", |rest| &rest[..16]).to_string();
    (status, csp, shell)
}

/// No one may frame a page by default, which it says twice (`frame-ancestors 'none'`,
/// `X-Frame-Options: DENY`). An area that lets another origin frame its pages lists it and sends
/// no `X-Frame-Options`, which cannot name one, while the app's other pages keep the denial; an
/// area inside it adds its own; `'self'` alone is `SAMEORIGIN` (#1129).
#[tokio::test]
async fn an_area_lets_the_origins_it_names_frame_its_pages() {
    let framing = |router: &Router, path: &'static str| {
        let router = router.clone();
        async move {
            let res = router.oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
            let csp = res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
            let ancestors = csp.split("; ").find_map(|d| d.strip_prefix("frame-ancestors ")).unwrap().to_string();
            (ancestors, res.headers().get(header::X_FRAME_OPTIONS).map(|v| v.to_str().unwrap().to_string()))
        }
    };
    let router = App::new(policy_url::router())
        .area(|area| pay_url::area(area).policy(|p| p.frame_ancestors("https://partner.example")))
        .area(|area| charts_url::area(area).policy(|p| p.frame_ancestors("'self'")))
        .router();
    assert_eq!(framing(&router, "/").await, ("'none'".into(), Some("DENY".into())));
    assert_eq!(framing(&router, "/pay/card").await, ("https://partner.example".into(), None));
    assert_eq!(framing(&router, "/pay/charts/week").await, ("https://partner.example 'self'".into(), None));
    // An unknown URL in the area is answered under its policy, as its pages are.
    assert_eq!(framing(&router, "/pay/nothing").await, ("https://partner.example".into(), None));
    let own = App::new(policy_url::router()).policy(crate::security::Policy::new().frame_ancestors("'self'")).router();
    assert_eq!(framing(&own, "/").await, ("'self'".into(), Some("SAMEORIGIN".into())));
}

/// Who may frame a page another origin may frame stays enforced where its CSP is not: a relayed
/// page that brings its own CSP, or a report-only policy, gets the origins as an enforced
/// `frame-ancestors` of its own. The policy decides `X-Frame-Options` whatever a handler set, and
/// a response that is never a page is framed by no one (#1129).
#[tokio::test]
async fn who_may_frame_a_page_is_enforced_whatever_else_its_answer_or_policy_does() {
    let relayed = || {
        let mut headers = http::HeaderMap::new();
        headers.insert("content-type", "text/html".parse().unwrap());
        headers.insert("content-security-policy", "frame-ancestors *".parse().unwrap());
        headers.insert("x-frame-options", "SAMEORIGIN".parse().unwrap());
        crate::Relay::new(StatusCode::OK, headers, Body::from("<p>upstream</p>"))
    };
    let app = |policy: crate::security::Policy| {
        App::new(Routes::from(
            Table::new()
                .route("/", get(|| async { ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], "<p>home</p>") }))
                .route(
                    "/own",
                    get(|| async {
                        ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::X_FRAME_OPTIONS, "DENY")], "<p>own</p>")
                    }),
                )
                .route("/relayed", get(move || async move { relayed() })),
        ))
        .policy(policy)
        .api::<ApiRoot>(|api| {
            api.route::<ApiRates>(crate::Methods::reads(get(|| async { "rates" })))
                .route::<ApiDown>(crate::Methods::reads(get(move || async move { relayed() })))
        })
        .router()
    };
    let all = |headers: &http::HeaderMap, name: http::HeaderName| -> Vec<String> {
        headers.get_all(name).iter().map(|v| v.to_str().unwrap().to_string()).collect()
    };
    let partner = || crate::security::Policy::new().frame_ancestors("https://partner.example");

    let router = app(partner());
    let (_, headers, _) = call_with(router.clone(), "GET", "/relayed", None, Some("text/html")).await;
    assert_eq!(
        all(&headers, header::CONTENT_SECURITY_POLICY),
        ["frame-ancestors *", "frame-ancestors https://partner.example"],
        "the upstream's policy, and the app's origins enforced beside it"
    );
    assert!(!headers.contains_key(header::X_FRAME_OPTIONS), "nor does the upstream's");
    let (_, headers, _) = call_with(router.clone(), "GET", "/own", None, None).await;
    assert!(!headers.contains_key(header::X_FRAME_OPTIONS), "a handler's DENY would block the partner");
    assert_eq!(all(&headers, header::CONTENT_SECURITY_POLICY).len(), 1, "an enforced policy needs no second line");
    let (_, headers, _) = call_with(router.clone(), "GET", "/api/rates", None, None).await;
    assert_eq!(headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
    assert_eq!(headers["x-frame-options"], "DENY", "an API's answer is framed by no one");
    let (_, headers, _) = call_with(router, "GET", "/api/down", None, None).await;
    assert_eq!(
        all(&headers, header::CONTENT_SECURITY_POLICY),
        ["frame-ancestors *", "frame-ancestors 'none'"],
        "nor by the sites a relayed one names"
    );

    // An upstream's policy cannot widen who frames a page no one may.
    let (_, headers, _) = call_with(app(crate::security::Policy::new()), "GET", "/relayed", None, Some("text/html")).await;
    assert_eq!(all(&headers, header::CONTENT_SECURITY_POLICY), ["frame-ancestors *", "frame-ancestors 'none'"]);
    assert_eq!(headers["x-frame-options"], "DENY");

    let router = app(partner().report_only());
    let (_, headers, _) = call_with(router.clone(), "GET", "/relayed", None, Some("text/html")).await;
    assert_eq!(all(&headers, header::CONTENT_SECURITY_POLICY), ["frame-ancestors *", "frame-ancestors https://partner.example"]);
    assert!(headers["content-security-policy-report-only"].to_str().unwrap().starts_with("default-src 'self'"));
    let (_, headers, _) = call_with(router, "GET", "/", None, None).await;
    assert!(headers["content-security-policy-report-only"]
        .to_str()
        .unwrap()
        .contains("frame-ancestors https://partner.example;"));
    assert_eq!(all(&headers, header::CONTENT_SECURITY_POLICY), ["frame-ancestors https://partner.example"]);
    assert!(!headers.contains_key(header::X_FRAME_OPTIONS));

    // Without another origin, X-Frame-Options enforces it, and the policy's value replaces a handler's.
    let (_, headers, _) = call_with(app(crate::security::Policy::new().report_only()), "GET", "/", None, None).await;
    assert!(!headers.contains_key(header::CONTENT_SECURITY_POLICY));
    assert_eq!(headers["x-frame-options"], "DENY");
    let router = app(crate::security::Policy::new().frame_ancestors("'self'"));
    let (_, headers, _) = call_with(router, "GET", "/own", None, None).await;
    assert_eq!(headers["x-frame-options"], "SAMEORIGIN");
}

/// An area's policy adds to the app's on its pages only, nested areas add up, and a page whose
/// policy differs has another shell key, so a client navigation to it loads the document in full.
#[tokio::test]
async fn an_area_adds_to_the_policy_of_its_pages_only() {
    let router = policy_app();
    let (status, home, home_shell) = csp_and_shell(&router, "/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(home.contains("img-src 'self' data: https: https://img.example;") && home.contains("frame-src 'none';"), "{home}");
    assert!(!home.contains("stripe") && !home.contains("style-src-attr"), "{home}");
    let (_, card, card_shell) = csp_and_shell(&router, "/pay/card").await;
    assert!(card.contains(" https://js.stripe.com; style-src") && card.contains("frame-src https://js.stripe.com;"), "{card}");
    assert!(card.contains("https://img.example") && !card.contains("style-src-attr"), "the app's sources stay: {card}");
    let (_, week, week_shell) = csp_and_shell(&router, "/pay/charts/week").await;
    assert!(week.contains("frame-src https://js.stripe.com;") && week.ends_with("; style-src-attr 'unsafe-inline'"), "{week}");
    assert_eq!(week.matches("https://js.stripe.com").count(), 2, "a source both areas add is listed once: {week}");
    assert!(
        home_shell != card_shell && card_shell != week_shell && home_shell != week_shell,
        "{home_shell} {card_shell} {week_shell}"
    );
    // An unknown URL in the area is answered under its policy, as its pages are.
    let res = router.clone().oneshot(Request::get("/pay/nothing").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap(), card);
    // A write another site sent to the area is refused under the area's policy too.
    let cross = Request::post("/pay/card").header("sec-fetch-site", "cross-site").body(Body::empty()).unwrap();
    let res = router.clone().oneshot(cross).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap(), card);
    // A page outside every area that adds keeps the shell key it had without any.
    let img = || crate::security::Policy::new().img_src("https://img.example");
    let plain = App::new(policy_url::router()).policy(img()).router();
    assert_eq!(csp_and_shell(&plain, "/").await, (StatusCode::OK, home.clone(), home_shell.clone()));
    // An area that adds only what the app has keeps the app's policy and shell key: a navigation
    // into it is not a full load.
    let same = App::new(policy_url::router())
        .policy(img())
        .area(|area| pay_url::area(area).policy(|p| p.img_src("https://img.example")))
        .router();
    assert_eq!(csp_and_shell(&same, "/pay/card").await, (StatusCode::OK, home, home_shell));
}

/// An area that lets a script make its own Trusted Types policy names it on its pages only, which
/// therefore have another shell key; every page requires Trusted Types and allows the runtime's.
#[tokio::test]
async fn an_area_allows_a_trusted_types_policy_on_its_pages_only() {
    let router =
        App::new(policy_url::router()).area(|area| pay_url::area(area).policy(|p| p.trusted_types_policy("stripe"))).router();
    let (_, home, home_shell) = csp_and_shell(&router, "/").await;
    assert!(home.ends_with("; require-trusted-types-for 'script'; trusted-types corten"), "{home}");
    let (_, card, card_shell) = csp_and_shell(&router, "/pay/card").await;
    assert!(card.ends_with("; require-trusted-types-for 'script'; trusted-types corten stripe"), "{card}");
    assert_ne!(home_shell, card_shell);
}

/// Every denied feature, as the app sends them on a full document.
const DENIED: &str = "accelerometer=(), bluetooth=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), \
     hid=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), \
     window-management=()";

/// The `Permissions-Policy` of `GET path`, sent in `mode` (`corten: nav`, or `accept` JSON for
/// data).
async fn features<S>(router: &S, path: &str, mode: Option<&str>) -> Option<String>
where
    S: tower::Service<Request<Body>, Response = crate::response::Response, Error = std::convert::Infallible> + Clone,
{
    let mut req = Request::get(path);
    match mode {
        Some("data") => req = req.header("accept", "application/json"),
        Some(mode) => req = req.header("corten", mode),
        None => {}
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    res.headers().get("permissions-policy").map(|value| value.to_str().unwrap().to_string())
}

/// A relayed page that brings a `Permissions-Policy` of its own.
pub(super) async fn relayed_page() -> crate::Relay {
    let mut headers = http::HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, http::HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert("permissions-policy", http::HeaderValue::from_static("camera=(self)"));
    crate::Relay::new(StatusCode::OK, headers, Body::from("<!doctype html><title>Relayed</title>"))
}

/// A relayed page with none, its type written in capitals.
async fn relayed_bare() -> crate::Relay {
    let mut headers = http::HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, http::HeaderValue::from_static("Text/HTML"));
    crate::Relay::new(StatusCode::OK, headers, Body::from("<!doctype html><title>Relayed</title>"))
}

/// `Policy::report_to`: every page's CSP names the endpoint, an area's too, and a full document
/// and the service worker's script say where it is, beside the app's own endpoints; an answer
/// drawn into a page, plain text, a relayed page and an API do not get it, and an API's CSP,
/// which allows nothing, names none.
#[tokio::test]
async fn a_report_endpoint_is_named_by_every_page_s_csp_and_sent_with_a_document() {
    use crate::security::{Feature, Policy};
    let extra = Table::new()
        .route("/text", get(|| async { "plain" }))
        .route("/relayed", get(relayed_page))
        .route(
            "/own",
            get(|req: Req| async move {
                let mut res = req.test_page("Own", html! { <p>"own"</p> }).into_response();
                res.headers_mut().append("reporting-endpoints", http::HeaderValue::from_static(r#"default="/r""#));
                res
            }),
        )
        .route(
            "/own-csp",
            get(|req: Req| async move {
                let mut res = req.test_page("Own", html! { <p>"own"</p> }).into_response();
                res.headers_mut().append("reporting-endpoints", http::HeaderValue::from_static(r#"csp="/elsewhere""#));
                res
            }),
        );
    let mut routes = policy_url::router();
    routes.0 = routes.0.merge(extra);
    let router = App::new(routes)
        .policy(Policy::new().report_to(&policy_url::CspReports))
        .area(|area| pay_url::area(area).policy(|p| p.allow_feature(Feature::Payment)))
        .api(|routes| api_module::api(routes, 100))
        .pwa(crate::pwa::Pwa::new(crate::pwa::Manifest::new("A", "A")))
        .router();
    let ours = r#"csp="/csp-reports""#;
    let get_with = |path: &'static str, mode: Option<&'static str>| {
        let router = router.clone();
        async move {
            let mut req = Request::get(path);
            if let Some(mode) = mode {
                req = req.header("corten", mode);
            }
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let csp = res.headers().get(header::CONTENT_SECURITY_POLICY).map(|v| v.to_str().unwrap().to_string());
            let sent: Vec<String> =
                res.headers().get_all("reporting-endpoints").iter().map(|v| v.to_str().unwrap().to_string()).collect();
            (csp.unwrap_or_default(), sent)
        }
    };
    for path in ["/", "/pay/card", "/nothing", "/service-worker.js"] {
        let (csp, sent) = get_with(path, None).await;
        assert!(csp.ends_with("; report-to csp"), "{path}: {csp}");
        assert_eq!(sent, [ours], "{path}");
    }
    for (path, mode) in [("/", Some("nav")), ("/", Some("action")), ("/text", None)] {
        let (csp, sent) = get_with(path, mode).await;
        assert!(csp.ends_with("; report-to csp") && sent.is_empty(), "{path} {mode:?} keeps the page's: {sent:?}");
    }
    let (csp, sent) = get_with("/relayed", None).await;
    assert!(sent.is_empty(), "a relayed page keeps its own: {csp} {sent:?}");
    let (csp, sent) = get_with("/v1/items/7", None).await;
    assert!(!csp.contains("report-to") && sent.is_empty(), "an API: {csp} {sent:?}");
    let (_, sent) = get_with("/own", None).await;
    assert_eq!(sent, [r#"default="/r""#, ours], "beside the app's own");
    let (_, sent) = get_with("/own-csp", None).await;
    assert_eq!(sent, [r#"csp="/elsewhere""#], "an answer that names its own csp endpoint keeps it");
    // Under `report_only`, the policy tried names the endpoint, which is what a trial is for.
    let trial = App::new(policy_url::router()).policy(Policy::new().report_only().report_to(&policy_url::CspReports)).router();
    let res = trial.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    let tried = res.headers()[header::CONTENT_SECURITY_POLICY_REPORT_ONLY].to_str().unwrap();
    assert!(tried.ends_with("; report-to csp") && !res.headers().contains_key(header::CONTENT_SECURITY_POLICY), "{tried}");
    assert_eq!(res.headers().get_all("reporting-endpoints").iter().collect::<Vec<_>>(), [ours]);
    // Without it, nothing is named and nothing sent.
    let plain = App::new(policy_url::router()).router();
    let res = plain.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    assert!(!res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("report-to"));
    assert!(!res.headers().contains_key("reporting-endpoints"));
}

/// A URL a browser would send no report to is refused at startup; the app's own route is taken
/// (a route without a `post` does not compile: `Policy::report_to`'s doctest).
#[test]
fn a_report_endpoint_a_browser_would_not_use_is_refused() {
    use crate::security::Policy;
    let takes = |url: &'static str| {
        let uri: http::Uri = url.parse().expect("a URI");
        std::panic::catch_unwind(|| Policy::new().report_to(&uri)).is_ok()
    };
    assert!(std::panic::catch_unwind(|| Policy::new().report_to(&policy_url::CspReports)).is_ok());
    for url in [
        "https://reports.example.com/csp?app=1",
        "http://localhost:3000/r",
        "http://app.localhost/r",
        "http://127.0.0.1/r",
        "http://127.8.0.1/r",
        "http://[::1]:8080/r",
    ] {
        assert!(takes(url), "{url}");
    }
    for url in [
        // A path is the app's route, which is checked as one.
        "/csp-reports",
        "http://reports.example.com/csp",
        "http://127.0.0.1@evil.example/r",
        "http://127.evil.example/r",
        "https://user:pw@reports.example.com/r",
        "http://10.0.0.1/r",
        "ftp://reports.example.com/r",
        "//reports.example.com",
        // A port with no host parses, with an empty host.
        "https://:443/r",
        "csp-reports",
        // A path a Uri holds that the header's quoted string cannot.
        "https://c.example/r\"x",
        "https://c.example/a\\b",
        "https://c.example/é",
    ] {
        assert!(!takes(url), "{url}");
    }
}

/// A full document denies the powerful features, an area allows one on its pages only (with its
/// own shell key, since a document keeps the policy it loaded with), and an answer drawn into a
/// page, plain text or a relayed page's own policy is left alone.
#[tokio::test]
async fn a_full_document_denies_powerful_features_and_an_area_allows_one() {
    use crate::security::Feature;
    let router =
        App::new(policy_url::router()).area(|area| pay_url::area(area).policy(|p| p.allow_feature(Feature::Payment))).router();
    assert_eq!(features(&router, "/", None).await.as_deref(), Some(DENIED));
    assert_eq!(features(&router, "/nothing", None).await.as_deref(), Some(DENIED), "the error page is a document too");
    assert_eq!(features(&router, "/", Some("nav")).await, None, "a navigation is drawn into a page that has its own");
    assert_eq!(features(&router, "/", Some("action")).await, None, "so is a patch");
    assert_eq!(
        features(&router, "/", Some("data")).await.as_deref(),
        Some(DENIED),
        "a data client asked a page, which answers the document"
    );
    let pay = DENIED.replace("payment=(), ", "");
    assert_eq!(features(&router, "/pay/card", None).await, Some(pay.clone()));
    assert_eq!(features(&router, "/pay/nothing", None).await, Some(pay), "an unknown URL in the area");
    assert_ne!(csp_and_shell(&router, "/").await.2, csp_and_shell(&router, "/pay/card").await.2);
    // An area that allows only what the app allows keeps the app's policy and shell key.
    let same = App::new(policy_url::router())
        .policy(crate::security::Policy::new().allow_feature(Feature::Payment))
        .area(|area| pay_url::area(area).policy(|p| p.allow_feature(Feature::Payment)))
        .router();
    assert_eq!(csp_and_shell(&same, "/").await.2, csp_and_shell(&same, "/pay/card").await.2);
    assert_eq!(features(&same, "/", None).await, features(&same, "/pay/card", None).await);

    let other = App::new(Routes::from(
        Table::new()
            .route("/text", get(|| async { "plain" }))
            .route("/relayed", get(relayed_page))
            .route("/bare", get(relayed_bare))
            .route("/file.html", get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<!doctype html><title>F</title>") }))
            .route("/icon.svg", get(|| async { ([(header::CONTENT_TYPE, "image/svg+xml")], "<svg/>") }))
            .route("/feed.xml", get(|| async { ([(header::CONTENT_TYPE, "application/atom+xml")], "<feed/>") }))
            .route("/data.xml", get(|| async { ([(header::CONTENT_TYPE, "Text/XML; charset=utf-8")], "<a/>") }))
            .route("/says-swap", get(|| async { ([("content-type", "text/html"), ("corten-page", "1")], "<p>x</p>") }))
            .route(
                "/patch",
                get(|req: Req| async move {
                    let answer: HtmlResult =
                        req.action().ok_or_else(crate::Error::not_found)?.patch(html! { <p id={QtyId}>"3 left."</p> });
                    answer
                }),
            ),
    ))
    .router();
    assert_eq!(features(&other, "/text", None).await, None, "only a document has features to deny");
    assert_eq!(features(&other, "/relayed", None).await.as_deref(), Some("camera=(self)"), "a relayed page keeps its own");
    assert_eq!(features(&other, "/bare", None).await.as_deref(), Some(DENIED), "the type is read without case");
    assert_eq!(features(&other, "/file.html", None).await.as_deref(), Some(DENIED), "an HTML file the app serves");
    assert_eq!(features(&other, "/icon.svg", None).await.as_deref(), Some(DENIED), "an SVG opened on its own runs scripts");
    assert_eq!(features(&other, "/feed.xml", None).await.as_deref(), Some(DENIED), "a +xml type the browser may draw as XML");
    assert_eq!(features(&other, "/data.xml", None).await.as_deref(), Some(DENIED), "so can text/xml");
    assert_eq!(
        features(&other, "/file.html", Some("nav")).await.as_deref(),
        Some(DENIED),
        "decided by the answer: a navigation fetched an HTML file the browser may load from its cache as the page"
    );
    assert_eq!(features(&other, "/says-swap", Some("nav")).await, None, "the runtime draws it into its page");
    assert_eq!(features(&other, "/patch", Some("action")).await, None, "a patch is drawn into the page too");
    assert_eq!(features(&other, "/patch", None).await.as_deref(), Some(DENIED), "unless a browser loaded it as the page");
    assert_eq!(
        features(&other, "/says-swap", None).await.as_deref(),
        Some(DENIED),
        "a browser's own request loads whatever comes back as the page"
    );

    // Two areas whose policies differ only in a feature have different shell keys.
    let nested = App::new(policy_url::router())
        .area(|area| pay_url::area(area).policy(|p| p.allow_feature(Feature::Payment)))
        .area(|area| charts_url::area(area).policy(|p| p.allow_feature(Feature::Camera)))
        .router();
    let (_, pay_csp, pay_shell) = csp_and_shell(&nested, "/pay/card").await;
    let (_, charts_csp, charts_shell) = csp_and_shell(&nested, "/pay/charts/week").await;
    assert_eq!(pay_csp, charts_csp);
    assert_ne!(pay_shell, charts_shell);
    assert_eq!(
        features(&nested, "/pay/charts/week", None).await,
        Some(DENIED.replace("camera=(), ", "").replace("payment=(), ", ""))
    );
}

/// A header of the app's own middleware is kept, every line of it, after Corten's: it denies more
/// than `Feature` names, and the browser reads a feature's last entry.
struct DenyMore;

impl crate::Middleware for DenyMore {
    async fn call(&self, req: crate::http::Request, next: impl crate::Next) -> crate::response::Response {
        let mut res = next.run(req).await;
        res.headers_mut().append("permissions-policy", http::HeaderValue::from_static("fullscreen=()"));
        res.headers_mut().append("permissions-policy", http::HeaderValue::from_static("camera=()"));
        res
    }
}

/// A refused write's error page, saying `text`.
fn refused_page(req: &Req, text: String) -> HtmlResult {
    req.page(html! {
        <html>
            <head>
                <title>"Error"</title>
                <Corten />
            </head>
            <body><main>{text}</main></body>
        </html>
    })
}

/// A refused write's request ends as every other request's does: its signal aborts once the
/// error page is sent, so work its page started cannot outlive it; and under `App::client_zone`
/// the page reads the visitor's zone.
#[tokio::test]
async fn a_refused_write_s_signal_ends_with_its_page_and_holds_the_visitor_s_zone() {
    let (sent, ended) = tokio::sync::oneshot::channel();
    let sent = std::sync::Arc::new(std::sync::Mutex::new(Some(sent)));
    let router = App::new(policy_url::router())
        .error_page(
            move |failure: Failure, req: Req| {
                let sent = sent.clone();
                async move {
                    if let Some(sent) = sent.lock().unwrap().take() {
                        let signal = req.signal().clone();
                        tokio::spawn(async move {
                            let _ = sent.send(signal.aborted().await);
                        });
                    }
                    refused_page(&req, failure.status().as_str().to_string())
                }
            },
            (),
        )
        .router();
    let refused = || {
        Request::post("/")
            .header("origin", "https://evil.example")
            .header("sec-fetch-site", "cross-site")
            .header("accept", "text/html")
            .body(Body::empty())
            .unwrap()
    };
    let res = router.oneshot(refused()).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let _ = res.into_body().collect().await.unwrap();
    let why = tokio::time::timeout(Duration::from_secs(5), ended).await.expect("the signal ended").unwrap();
    assert_eq!(why, crate::Abort::Responded);

    #[cfg(feature = "zones")]
    {
        use crate::i18n::Zone as _;
        // 2026-03-22T15:04:05Z: Chicago is on daylight time (UTC-5) since March 8.
        let at = std::time::UNIX_EPOCH + Duration::from_secs(1_774_191_845);
        let router = App::new(policy_url::router())
            .client_zone()
            .error_page(
                move |_: Failure, req: Req| async move {
                    let offset = req.zone().offset(at).to_string();
                    refused_page(&req, offset)
                },
                (),
            )
            .router();
        let mut req = refused();
        req.headers_mut().insert("cookie", http::HeaderValue::from_static("corten-zone=America/Chicago"));
        let res = router.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        assert!(body.contains("<main>-18000</main>"), "{body}");
    }
}

/// A cross-site write a browser sent is refused with the error page, a full document; a route's
/// own document gets the header too, a page swap it says it is does not; and an app's own header is kept.
#[tokio::test]
async fn a_refused_write_the_app_s_policy_and_its_own_header_send_permissions_policy() {
    let router = App::new(policy_url::router()).router();
    let req = Request::post("/")
        .header("origin", "https://evil.example")
        .header("sec-fetch-site", "cross-site")
        .header("accept", "text/html")
        .body(Body::empty())
        .unwrap();
    let res = router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(res.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/html"));
    assert_eq!(res.headers()["permissions-policy"], DENIED);
    // The runtime's refused patch is drawn into its page: none.
    let req = Request::post("/")
        .header("origin", "https://evil.example")
        .header("sec-fetch-site", "cross-site")
        .header("corten", "action")
        .body(Body::empty())
        .unwrap();
    let res = App::new(policy_url::router()).router().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(res.headers().get("permissions-policy"), None, "a refused patch");

    let applied = App::new(Routes::from(
        Table::new()
            .route("/", get(|| async { ([("content-type", "text/html; charset=utf-8")], "<!doctype html><title>A</title>") }))
            .route("/says-swap", get(|| async { ([("content-type", "text/html"), ("corten-page", "1")], "<p>x</p>") })),
    ))
    .router();
    assert_eq!(features(&applied, "/", None).await.as_deref(), Some(DENIED));
    assert_eq!(
        features(&applied, "/", Some("nav")).await.as_deref(),
        Some(DENIED),
        "an answer that is not a corten-page swap is a document, whatever the request"
    );
    assert_eq!(features(&applied, "/says-swap", Some("nav")).await, None);
    assert_eq!(features(&applied, "/says-swap", None).await.as_deref(), Some(DENIED), "the request was the browser's own");

    let own = App::new(policy_url::router()).middleware(DenyMore).router();
    let res = own.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    let lines: Vec<_> = res.headers().get_all("permissions-policy").iter().map(|v| v.to_str().unwrap().to_string()).collect();
    assert_eq!(lines, [DENIED, "fullscreen=()", "camera=()"]);

    // A relayed page that brought no header gets Corten's first too; one that brought its own keeps it.
    let relayed = App::new(Routes::from(Table::new().route("/bare", get(relayed_bare)).route("/relayed", get(relayed_page))))
        .middleware(DenyMore)
        .router();
    for (path, first) in [("/bare", DENIED), ("/relayed", "camera=(self)")] {
        let res = relayed.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let lines: Vec<_> = res.headers().get_all("permissions-policy").iter().map(|v| v.to_str().unwrap().to_string()).collect();
        assert_eq!(lines, [first, "fullscreen=()", "camera=()"], "{path}");
    }
}

/// A page large enough to compress.
pub(super) async fn big_policy_page(req: Req) -> HtmlResult {
    let text = "x".repeat(2048);
    req.test_page("Page", html! { <p>{text}</p> })
}

/// A header of the app's own, as a request id is.
struct AddRequestId;

impl crate::Middleware for AddRequestId {
    async fn call(&self, req: crate::http::Request, next: impl crate::Next) -> crate::response::Response {
        let mut res = next.run(req).await;
        res.headers_mut().insert("x-request-id", http::HeaderValue::from_static("0123456789abcdef"));
        res
    }
}

/// An error page large enough to compress.
async fn big_error_page(_: Failure, req: Req) -> HtmlResult {
    let text = "x".repeat(2048);
    req.test_page("Error", html! { <p>{text}</p> })
}

/// A text or bytes answer's header map starts with room for the headers the app adds under the
/// default policy (`APP_HEADERS`), so the security headers, `Cache-Control`, `Vary`, its tag and a
/// compressed body's `Content-Encoding` go in without growing it, with HSTS too. A map its first
/// header made holds six and grows to the same size, so the starting capacity is what tells them
/// apart.
#[tokio::test]
async fn a_text_answer_s_header_map_holds_the_app_s_headers_without_growing() {
    let routes = Table::new()
        .route("/text", get(|| async { "text ".repeat(400) }))
        .route("/bytes", get(|| async { crate::Media::new("image/svg+xml", "<svg/>".repeat(300)) }));
    let router = App::new(Routes::from(routes)).policy(crate::security::Policy::new().hsts()).router();
    let reserved = http::HeaderMap::<http::HeaderValue>::with_capacity(crate::response::APP_HEADERS).capacity();
    assert_eq!("".into_response().headers().capacity(), reserved, "a text answer starts with room for them");
    assert_eq!(crate::Media::new("image/png", "").into_response().headers().capacity(), reserved);
    let chunks = futures_util::stream::empty::<Result<crate::http::Bytes, std::io::Error>>();
    assert_eq!(crate::Media::stream("text/csv", chunks).into_response().headers().capacity(), reserved);
    // An SVG can be a document, so it gets `Permissions-Policy` too: the most the default policy leaves.
    // Without `compress` nothing adds `Content-Encoding` or `Vary`.
    let compressed = cfg!(feature = "compress");
    let coded = if compressed { 2 } else { 0 };
    for (path, held) in [("/text", 9 + coded), ("/bytes", crate::response::APP_HEADERS - 2 + coded)] {
        let req = Request::get(path).header("accept-encoding", "br").body(Body::empty()).unwrap();
        let res = router.clone().oneshot(req).await.unwrap();
        let headers = res.headers();
        assert_eq!(headers.contains_key("content-encoding"), compressed, "{path}");
        assert!(headers.contains_key("strict-transport-security"), "{path}");
        assert_eq!((headers.keys_len(), headers.capacity()), (held, reserved), "{path}: {headers:?}");
    }
}

/// A page's header map starts at the capacity 13 slots give (24), and with HSTS and compression the
/// headers each case holds need no more: a compressed page (13 headers, with its `ETag`), the
/// default error page (12, uncompressed), a compressed app error page (13, with `X-Robots-Tag`)
/// and a page with a header of the app's own (14); none holds a `Content-Length`, which the
/// server writes into the head it sends. A map of 12 that grew once also ends at 24, so the starting
/// capacity is what tells them apart.
#[tokio::test]
async fn a_page_s_header_map_holds_permissions_policy_without_growing() {
    use crate::security::{Feature, Policy};
    async fn capacity(policy: Policy, path: &str, own: bool, big_error: bool) -> (usize, bool, usize, bool) {
        let routes = Routes::from(Table::new().route("/", get(big_policy_page)));
        let mut app = App::new(routes).policy(policy.hsts());
        if big_error {
            app = app.error_page(big_error_page, ());
        }
        let router = if own { app.middleware(AddRequestId).router() } else { app.router() };
        let req = Request::get(path).header("accept-encoding", "br").body(Body::empty()).unwrap();
        let res = router.oneshot(req).await.unwrap();
        let headers = res.headers();
        (
            headers.capacity(),
            headers.contains_key("permissions-policy"),
            headers.keys_len(),
            headers.contains_key("content-encoding"),
        )
    }
    let every = [
        Feature::Accelerometer,
        Feature::Bluetooth,
        Feature::Camera,
        Feature::DisplayCapture,
        Feature::Geolocation,
        Feature::Gyroscope,
        Feature::Hid,
        Feature::IdleDetection,
        Feature::LocalFonts,
        Feature::Magnetometer,
        Feature::Microphone,
        Feature::Midi,
        Feature::Payment,
        Feature::Serial,
        Feature::Usb,
        Feature::WindowManagement,
    ];
    let none = || every.into_iter().fold(Policy::new(), Policy::allow_feature);
    let reserved = http::HeaderMap::<http::HeaderValue>::with_capacity(13).capacity();
    // A page starts with this capacity, so ending with it means the map never grew (12 slots grown
    // once end at the same size).
    let start = crate::page::html_response(StatusCode::OK, String::new(), None, http::HeaderValue::from_static(crate::page::VARY));
    assert_eq!(start.headers().capacity(), reserved);
    // Without `compress` nothing is compressed and each sends one header fewer.
    let zipped = cfg!(feature = "compress");
    let less = usize::from(!zipped);
    for (case, path, own, big_error, names, compressed) in [
        ("a compressed page", "/", false, false, 13 - less, zipped),
        ("the default error page", "/nothing", false, false, 12, false),
        ("a compressed app error page", "/nothing", false, true, 13 - less, zipped),
        ("a page with the app's own header", "/", true, false, 14 - less, zipped),
    ] {
        let (with, sent, count, encoded) = capacity(Policy::new(), path, own, big_error).await;
        let (without, not_sent, ..) = capacity(none(), path, own, big_error).await;
        assert!(sent && !not_sent, "{case}");
        assert_eq!(count, names, "{case}");
        assert_eq!(encoded, compressed, "{case} compressed");
        assert_eq!((with, without), (reserved, reserved), "{case}");
    }
}

/// A page whose policy lets scripts load from another host allows the `default` Trusted Types
/// policy and makes it in a script at `<Corten />`, allowed by its hash, so a script can set such
/// a URL (an SDK's loader, and the SDK loading its parts); a page whose app makes `default`
/// itself, or that loads only from its own origin, a keyword or a scheme, does not. A page that
/// makes it and one that does not never share a shell key, as a document keeps the policy it
/// loaded with.
#[tokio::test]
async fn a_page_that_loads_scripts_from_another_host_makes_the_default_policy() {
    let tag = format!("<script>{}</script>", crate::security::SCRIPT_LOADS);
    let hash = crate::security::hash_source(crate::security::SCRIPT_LOADS);
    let page = |router: Router, path: &'static str| {
        let tag = tag.clone();
        async move {
            let res = router.oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
            let csp = res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_string();
            let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
            let shell = body.split(r#"name="corten-shell" content=""#).nth(1).map_or("", |rest| &rest[..16]).to_string();
            (csp, body.contains(&tag), shell)
        }
    };
    let router = policy_app();
    let (home, home_makes, home_shell) = page(router.clone(), "/").await;
    assert!(home.ends_with("trusted-types corten") && !home.contains(&hash) && !home_makes, "{home}");
    let (card, card_makes, card_shell) = page(router.clone(), "/pay/card").await;
    assert!(card.ends_with("trusted-types corten default") && card.contains(&hash) && card_makes, "{card}");
    assert_ne!(home_shell, card_shell);
    // A keyword, a nonce, a hash or a scheme alone names no host.
    for source in ["'wasm-unsafe-eval'", "data:", "https:"] {
        let router = App::new(policy_url::router()).policy(crate::security::Policy::new().script_src(source)).router();
        let (csp, makes, _) = page(router, "/").await;
        assert!(csp.ends_with("trusted-types corten") && !csp.contains(&hash) && !makes, "{source}: {csp}");
    }
    // Under 'strict-dynamic' the browser ignores the hosts listed, so nothing would hold the load.
    for keyword in ["'strict-dynamic'", "'Strict-Dynamic'"] {
        let dynamic = crate::security::Policy::new().script_src("https://js.stripe.com").script_src(keyword);
        let (csp, makes, _) = page(App::new(policy_url::router()).policy(dynamic).router(), "/").await;
        assert!(csp.ends_with("trusted-types corten") && !csp.contains(&hash) && !makes, "{keyword}: {csp}");
    }
    // An app that allows `default` by name makes it: no page of its makes it too.
    let stripe = || crate::security::Policy::new().script_src("https://js.stripe.com");
    let own = App::new(policy_url::router())
        .area(|area| pay_url::area(area).policy(|p| p.script_src("https://js.stripe.com").trusted_types_policy("default")))
        .router();
    let (csp, makes, _) = page(own, "/pay/card").await;
    assert!(csp.ends_with("trusted-types corten default") && !csp.contains(&hash) && !makes, "{csp}");
    // App-wide, every page; an area of it that makes its own has another policy and shell key.
    let app = App::new(policy_url::router())
        .policy(stripe())
        .area(|area| pay_url::area(area).policy(|p| p.trusted_types_policy("default")))
        .router();
    let (csp, makes, app_shell) = page(app.clone(), "/").await;
    assert!(csp.ends_with("trusted-types corten default") && csp.contains(&hash) && makes, "{csp}");
    let (csp, makes, own_shell) = page(app, "/pay/card").await;
    assert!(!csp.contains(&hash) && !makes && own_shell != app_shell, "{csp}");
    // And so does an inner area that makes its own, under one whose pages the runtime's covers.
    let nested = App::new(policy_url::router())
        .area(|area| pay_url::area(area).policy(|p| p.script_src("https://js.stripe.com")))
        .area(|area| charts_url::area(area).policy(|p| p.trusted_types_policy("default")))
        .router();
    let (_, outer_makes, outer_shell) = page(nested.clone(), "/pay/card").await;
    let (_, inner_makes, inner_shell) = page(nested, "/pay/charts/week").await;
    assert!(outer_makes && !inner_makes && outer_shell != inner_shell, "{outer_shell} {inner_shell}");
}

/// An area relaxes the opener policy on its pages only (Stripe's Connect embedded components
/// sign in through a popup that needs `unsafe-none`), and a page under another one has another
/// shell key, since a document keeps the opener policy it loaded with.
#[tokio::test]
async fn an_area_relaxes_the_opener_policy_of_its_pages_only() {
    async fn opener(router: &Router, path: &str) -> (StatusCode, String, String) {
        let res = router.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let opener = res.headers()["cross-origin-opener-policy"].to_str().unwrap().to_string();
        let (status, _, shell) = csp_and_shell(router, path).await;
        (status, opener, shell)
    }
    let router =
        App::new(policy_url::router()).area(|area| pay_url::area(area).policy(|p| p.allow_cross_origin_opener())).router();
    let (_, home, home_shell) = opener(&router, "/").await;
    assert_eq!(home, "same-origin");
    let (_, card, card_shell) = opener(&router, "/pay/card").await;
    assert_eq!(card, "unsafe-none");
    assert_ne!(home_shell, card_shell, "a navigation into the area loads the document in full");
    assert_eq!(csp_and_shell(&router, "/").await.1, csp_and_shell(&router, "/pay/card").await.1, "the CSP is the app's");
    // An unknown URL in the area is answered under its policy, as its pages are.
    assert_eq!(opener(&router, "/pay/nothing").await.1, "unsafe-none");
    // Only relaxing: an area's allow_popups under an app that allows any opener changes nothing,
    // and one the app already has keeps the app's shell key.
    let open = App::new(policy_url::router())
        .policy(crate::security::Policy::new().allow_cross_origin_opener())
        .area(|area| pay_url::area(area).policy(|p| p.allow_popups()))
        .router();
    let (_, open_home, open_shell) = opener(&open, "/").await;
    assert_eq!(
        (open_home.as_str(), opener(&open, "/pay/card").await),
        ("unsafe-none", (StatusCode::OK, "unsafe-none".into(), open_shell))
    );
    // Nested areas add up: one inside an area that loosens it keeps the looser value, and a
    // write another site sent there is refused under it too.
    let nested = App::new(policy_url::router())
        .area(|area| pay_url::area(area).policy(|p| p.allow_cross_origin_opener()))
        .area(|area| charts_url::area(area).policy(|p| p.allow_popups().script_src("https://js.stripe.com")))
        .router();
    assert_eq!(opener(&nested, "/pay/charts/week").await.1, "unsafe-none");
    let cross = Request::post("/pay/charts/week").header("sec-fetch-site", "cross-site").body(Body::empty()).unwrap();
    let refused = nested.clone().oneshot(cross).await.unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(refused.headers()["cross-origin-opener-policy"], "unsafe-none");
    let popups = App::new(policy_url::router())
        .policy(crate::security::Policy::new().allow_popups())
        .area(|area| pay_url::area(area).policy(|p| p.allow_popups()))
        .router();
    let (_, popups_home, popups_shell) = opener(&popups, "/").await;
    assert_eq!(popups_home, "same-origin-allow-popups");
    assert_eq!(opener(&popups, "/pay/card").await.2, popups_shell);
}

#[crate::routes]
mod referrer_url {
    #[route("/relayed/{policy}", get = relayed)]
    pub struct Relayed<'a> {
        pub policy: &'a str,
    }
}

/// An answer that brings a policy of its own, as a relayed service's does.
async fn relayed(Params(at): Params<referrer_url::Relayed<'_>>) -> crate::Result<crate::Relay> {
    let mut headers = http::HeaderMap::new();
    // `|` between lines of their own.
    for line in at.policy.split('|') {
        headers.append(header::REFERRER_POLICY, http::HeaderValue::from_str(line).unwrap());
    }
    headers.insert(header::LOCATION, http::HeaderValue::from_static("https://elsewhere.example/cb?code=1"));
    Ok(crate::Relay::new(StatusCode::FOUND, headers, Body::empty()))
}

/// An area or the app makes `Referrer-Policy` stricter, never looser; an area that changes it has
/// its own shell key (a document keeps the policy it loaded with); and an answer that brings a
/// stricter one keeps it, while a looser one is replaced.
#[tokio::test]
async fn an_area_or_an_answer_makes_the_referrer_policy_stricter_only() {
    use crate::security::{Policy, Referrer};
    async fn referrer(router: &Router, path: &str) -> String {
        let res = router.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        res.headers()[header::REFERRER_POLICY].to_str().unwrap().to_string()
    }
    let router =
        App::new(policy_url::router()).area(|area| pay_url::area(area).policy(|p| p.referrer(Referrer::NoReferrer))).router();
    assert_eq!(referrer(&router, "/").await, "strict-origin-when-cross-origin");
    assert_eq!(referrer(&router, "/pay/card").await, "no-referrer");
    assert_eq!(referrer(&router, "/pay/nothing").await, "no-referrer", "an unknown URL in the area too");
    assert_ne!(csp_and_shell(&router, "/").await.2, csp_and_shell(&router, "/pay/card").await.2);
    // An API inside the area keeps its own CSP and sends the area's referrer policy, an unknown URL
    // in it too.
    let api = App::new(policy_url::router())
        .area(|area| pay_url::area(area).policy(|p| p.referrer(Referrer::NoReferrer)))
        .api::<PayApi>(|api| api.route::<PayApiGo>(crate::Methods::reads(get(|| async { "go" }))))
        .router();
    assert_eq!(referrer(&api, "/pay/api/go").await, "no-referrer");
    assert_eq!(referrer(&api, "/pay/api/nope").await, "no-referrer");
    assert_eq!(referrer(&api, "/").await, "strict-origin-when-cross-origin");
    // Two that each send less somewhere send the least of both: strict-origin to this site and
    // nothing to others has no name, so it is nothing.
    let nested = App::new(policy_url::router())
        .policy(Policy::new().referrer(Referrer::StrictOrigin))
        .area(|area| pay_url::area(area).policy(|p| p.referrer(Referrer::SameOrigin)))
        .router();
    assert_eq!(referrer(&nested, "/").await, "strict-origin");
    assert_eq!(referrer(&nested, "/pay/card").await, "no-referrer");
    // Two policies that both send nothing are one: the area keeps the app's shell key.
    let nothing = App::new(policy_url::router())
        .policy(Policy::new().referrer(Referrer::StrictOrigin).referrer(Referrer::SameOrigin))
        .area(|area| pay_url::area(area).policy(|p| p.referrer(Referrer::NoReferrer)))
        .router();
    assert_eq!(referrer(&nothing, "/").await, "no-referrer");
    assert_eq!(csp_and_shell(&nothing, "/").await.2, csp_and_shell(&nothing, "/pay/card").await.2);
    // The same value the app has is no change, and keeps the app's shell key.
    let same = App::new(policy_url::router())
        .policy(Policy::new().referrer(Referrer::SameOrigin))
        .area(|area| pay_url::area(area).policy(|p| p.referrer(Referrer::SameOrigin)))
        .router();
    assert_eq!(csp_and_shell(&same, "/").await.2, csp_and_shell(&same, "/pay/card").await.2);
    // An answer's own policy is kept when it is stricter, and the stricter of both otherwise.
    let relay = App::new(referrer_url::router()).router();
    for (brought, sent) in [
        ("no-referrer", "no-referrer"),
        ("same-origin", "same-origin"),
        ("unsafe-url", "strict-origin-when-cross-origin"),
        ("x-unknown", "strict-origin-when-cross-origin"),
        // `origin` sends only the origin to this site too.
        ("origin", "strict-origin"),
        ("unsafe-url, strict-origin", "strict-origin"),
        // The browser skips a token it does not know and uses the last one it does.
        ("no-referrer, x-future-policy", "no-referrer"),
        // Several lines are one list.
        ("unsafe-url|no-referrer", "no-referrer"),
        ("same-origin|unsafe-url", "strict-origin-when-cross-origin"),
    ] {
        let path = referrer_url::Relayed { policy: brought }.href();
        assert_eq!(referrer(&relay, &path).await, sent, "{brought}");
    }
    let strict = App::new(referrer_url::router()).policy(Policy::new().referrer(Referrer::StrictOrigin)).router();
    let path = referrer_url::Relayed { policy: "same-origin" }.href();
    assert_eq!(referrer(&strict, &path).await, "no-referrer", "the least of the app's and the answer's");
}

// ---- A scope's lines given to an answer in one pass, against each line inserted into it ----

paths! {
    LinesClosed = "/closed",
    LinesOpen = "/open",
    LinesArea = "/walled",
    LinesWalled = "/walled/api",
}

/// The answer `kind` names ([`lines_answer`]) in an API.
#[derive(crate::Route)]
#[route("/closed/{kind}")]
struct ClosedAnswer<'a> {
    kind: &'a str,
}

/// The same in an API another origin may read.
#[derive(crate::Route)]
#[route("/open/{kind}")]
struct OpenAnswer<'a> {
    kind: &'a str,
}

/// The same in an area with a policy of its own.
#[derive(crate::Route)]
#[route("/walled/{kind}")]
struct AreaAnswer<'a> {
    kind: &'a str,
}

/// The same in an API inside that area, which sends the area's referrer policy and not the app's.
#[derive(crate::Route)]
#[route("/walled/api/{kind}")]
struct WalledAnswer<'a> {
    kind: &'a str,
}

/// Every answer [`lines_answer`] makes.
const LINES_KINDS: [&str; 49] = [
    "text",
    "created",
    "missing",
    "failed",
    "long",
    "json",
    "png",
    "svg",
    "html",
    "nothing",
    "no-content",
    "teapot",
    "two",
    "no-store",
    "shared",
    "no-transform",
    "typed",
    "vary",
    "vary-coding",
    "vary-all",
    "policy",
    "report-only-policy",
    "no-referrer",
    "every-referrer",
    "framed",
    "opener",
    "sniffed",
    "transport",
    "features",
    "endpoints",
    "cdn",
    "cookie",
    "encoded",
    "ranged",
    "tagged",
    "relayed",
    "relayed-bare",
    "relayed-page",
    "stream",
    "events",
    "style",
    "keyed",
    "keyed-cdn",
    "worker",
    "xml",
    "alone",
    "empty-text",
    "bare-no-store",
    "bare-public",
];

/// An answer by name: what a handler, a middleware or an upstream can leave on one that the
/// stages read when they give it the scope's lines.
fn lines_answer(kind: &str) -> Response {
    let own = |name: &'static str, value: &'static str| ([(name, value)], "own").into_response();
    let relayed = |lines: &[(&'static str, &'static str)]| {
        let mut headers = http::HeaderMap::new();
        for (name, value) in lines {
            headers.append(*name, http::HeaderValue::from_static(value));
        }
        crate::Relay::new(StatusCode::OK, headers, Body::from("<!doctype html><title>Relayed</title>")).into_response()
    };
    let chunks = || futures_util::stream::iter([Ok::<_, std::io::Error>(crate::http::Bytes::from_static(b"a,b\n1,2\n"))]);
    match kind {
        "text" => "ok".into_response(),
        // A short text with another status, which a stage may come to read.
        "created" => (StatusCode::CREATED, "made").into_response(),
        "missing" => (StatusCode::NOT_FOUND, "none").into_response(),
        "failed" => (StatusCode::INTERNAL_SERVER_ERROR, "down").into_response(),
        "long" => "long ".repeat(400).into_response(),
        // What a handler's `Json` is, where the build has it.
        #[cfg(feature = "json")]
        "json" => crate::Json(vec![7_u32; 800]).into_response(),
        #[cfg(not(feature = "json"))]
        "json" => ([("content-type", "application/json")], r#"{"a":1}"#.repeat(200)).into_response(),
        "png" => crate::Media::new("image/png", "png").into_response(),
        "svg" => crate::Media::new("image/svg+xml", "<svg/>".repeat(300)).into_response(),
        "html" => ([("content-type", "text/html; charset=utf-8")], "<!doctype html><title>A</title>").into_response(),
        "nothing" => ().into_response(),
        "no-content" => StatusCode::NO_CONTENT.into_response(),
        "teapot" => (StatusCode::IM_A_TEAPOT, "short and stout").into_response(),
        "two" => own("x-own", "1"),
        "no-store" => own("cache-control", "no-store"),
        "shared" => own("cache-control", "public, max-age=60"),
        "no-transform" => own("cache-control", "no-transform"),
        "typed" => {
            let mut res = "typed ".repeat(400).into_response();
            Cache::public(Duration::from_secs(60)).apply(&mut res);
            res
        }
        "vary" => own("vary", "origin"),
        "vary-coding" => own("vary", "Accept-Encoding"),
        "vary-all" => own("vary", "*"),
        "policy" => own("content-security-policy", "sandbox"),
        "report-only-policy" => own("content-security-policy-report-only", "default-src 'self'"),
        "no-referrer" => own("referrer-policy", "no-referrer"),
        "every-referrer" => own("referrer-policy", "unsafe-url"),
        "framed" => own("x-frame-options", "SAMEORIGIN"),
        "opener" => own("cross-origin-opener-policy", "unsafe-none"),
        "sniffed" => own("x-content-type-options", "sniff"),
        "transport" => own("strict-transport-security", "max-age=1"),
        "features" => ([("content-type", "text/html"), ("permissions-policy", "fullscreen=()")], "<p>own</p>").into_response(),
        "endpoints" => ([("content-type", "text/html"), ("reporting-endpoints", r#"app="https://r.example/a""#)], "<p>own</p>")
            .into_response(),
        "cdn" => own("cdn-cache-control", "max-age=60"),
        "cookie" => own("set-cookie", "a=b"),
        "encoded" => own("content-encoding", "gzip"),
        "ranged" => (StatusCode::PARTIAL_CONTENT, [("content-range", "bytes 0-2/9")], "own").into_response(),
        "tagged" => own("etag", "\"mine\""),
        "relayed" => relayed(&[("content-type", "text/html"), ("content-security-policy", "script-src 'nonce-upstream'")]),
        "relayed-bare" => relayed(&[("content-type", "text/plain; charset=utf-8")]),
        "relayed-page" => relayed(&[("content-type", "text/html"), ("permissions-policy", "camera=(self)"), ("vary", "cookie")]),
        "stream" => crate::Media::stream("text/csv", chunks()).into_response(),
        "events" => ([("content-type", "text/event-stream")], Body::from_stream(chunks())).into_response(),
        // What `Req::page` leaves on a page with a style block, and on one that drew a submit key.
        "style" => {
            let mut res =
                ([("content-type", "text/html; charset=utf-8")], "<!doctype html><title>Styled</title>").into_response();
            res.extensions_mut().insert(crate::security::StyleBlock("'sha256-c3R5bGU='".to_string()));
            res
        }
        "keyed" | "keyed-cdn" => {
            let mut res = "keyed".into_response();
            if kind == "keyed-cdn" {
                res.headers_mut().insert("surrogate-control", http::HeaderValue::from_static("max-age=60"));
            }
            res.extensions_mut().insert(crate::cache::Unrepeatable);
            res
        }
        // The service worker's script, as its route marks it, and a document that is not HTML.
        "worker" => {
            let mut res = ([("content-type", "text/javascript; charset=utf-8")], "self.skipWaiting()").into_response();
            res.extensions_mut().insert(crate::pwa::WorkerScript);
            res
        }
        "xml" => ([("content-type", "Application/Atom+XML ; charset=utf-8")], "<feed/>").into_response(),
        // One line that is not its type, and a type on an answer with no body to compress.
        "alone" => {
            let mut res = ().into_response();
            res.headers_mut().insert("cache-control", http::HeaderValue::from_static("no-store"));
            res
        }
        "empty-text" => (StatusCode::NO_CONTENT, "").into_response(),
        // A `Cache` answer whose header a middleware took out: settled by its mark.
        "bare-no-store" | "bare-public" => {
            let mut res = "bare".into_response();
            let cache = if kind == "bare-no-store" { Cache::no_store() } else { Cache::public(Duration::from_secs(60)) };
            cache.apply(&mut res);
            res.headers_mut().remove("cache-control");
            res
        }
        other => panic!("no answer named {other}"),
    }
}

async fn lines_named(Num(kind): Num<String>) -> Response {
    lines_answer(&kind)
}

async fn lines_shared_page(req: Req) -> Public<HtmlResult> {
    Public::new(
        Duration::from_secs(60),
        req.page(Shell { req: &req, title: "Shared", head: "", children: html! { <p>"all"</p> } }),
    )
}

async fn lines_keyed_page(req: Req) -> HtmlResult {
    req.test_page("Keyed", html! { <form method="post">{crate::SubmitKey::field(KeyedWrite::FIELDS.submit)}</form> })
}

async fn lines_moved(req: Req) -> HtmlResult {
    req.redirect(&Done)
}

/// Gives the answer to a request that asks for it (`x-each`, which nothing else reads) a line no
/// stage reads, as a request id is given: with it an answer has more than its type, so each of
/// its scope's lines is inserted.
struct OneMore;

impl crate::Middleware for OneMore {
    async fn call(&self, req: crate::http::Request, next: impl crate::Next) -> Response {
        let asked = req.headers().contains_key("x-each");
        let mut res = next.run(req).await;
        if asked {
            res.headers_mut().insert("x-one-more", http::HeaderValue::from_static("1"));
        }
        res
    }
}

/// What the area of a [`lines_app`] adds to the app's policy: its referrer policy among it, the
/// one line an API inside the area takes from it.
fn lines_area_policy(sources: crate::security::Sources) -> crate::security::Sources {
    let sources = sources.script_src("https://js.example").frame_ancestors("https://frames.example");
    sources.referrer(crate::security::Referrer::NoReferrer)
}

/// Pages, an API, an API another origin may read, an area with its own policy and an API inside
/// that area, each with every answer [`lines_answer`] makes.
fn lines_app(policy: crate::security::Policy, dev: bool) -> App {
    let pages = Table::new()
        .route("/", get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) }))
        .route("/big", get(big_policy_page))
        .route("/inline", get(inline_page))
        .route("/keyed", get(lines_keyed_page))
        .route("/shared", get(lines_shared_page))
        .route("/moved", get(lines_moved))
        .route("/fails", get(|| async { Err::<Response, _>(Error::new("down")) }))
        // An answer with its type alone whose handler took the request's nonce.
        .route(
            "/nonced",
            get(|nonce: crate::security::Nonce| async move {
                ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], format!("nonce {}", nonce.0))
            }),
        )
        .route("/a/{kind}", get(lines_named).post(lines_named));
    App::new(Routes::from(pages))
        .policy(policy)
        .dev(dev)
        .error_page(test_error_page, ())
        .api::<LinesClosed>(|api| api.route::<ClosedAnswer>(crate::Methods::reads(get(lines_named))))
        .api::<LinesOpen>(|api| {
            api.route::<OpenAnswer>(crate::Methods::reads(get(lines_named))).allow_origin("https://partner.example")
        })
        .area::<LinesArea>(|area| area.route::<AreaAnswer>(crate::Methods::reads(get(lines_named))).policy(lines_area_policy))
        .api::<LinesWalled>(|api| api.route::<WalledAnswer>(crate::Methods::reads(get(lines_named))))
}

/// Each policy the answers are compared under: what it is, the policy, and whether its app runs
/// under `corten dev`.
fn lines_policies() -> Vec<(&'static str, crate::security::Policy, bool)> {
    use crate::security::{Feature, Policy, Referrer};
    let every = [
        Feature::Accelerometer,
        Feature::Bluetooth,
        Feature::Camera,
        Feature::DisplayCapture,
        Feature::Geolocation,
        Feature::Gyroscope,
        Feature::Hid,
        Feature::IdleDetection,
        Feature::LocalFonts,
        Feature::Magnetometer,
        Feature::Microphone,
        Feature::Midi,
        Feature::Payment,
        Feature::Serial,
        Feature::Usb,
        Feature::WindowManagement,
    ];
    let reports = crate::http::Uri::from_static("https://reports.example/csp");
    let allowed = || every.into_iter().fold(Policy::new(), Policy::allow_feature);
    vec![
        ("the default policy", Policy::new(), false),
        ("under corten dev", Policy::new(), true),
        ("HSTS", Policy::new().hsts(), false),
        ("report-only", Policy::new().report_only(), false),
        ("framed by another origin", Policy::new().frame_ancestors("https://frames.example"), false),
        (
            "framed by another origin, report-only",
            Policy::new().frame_ancestors("https://frames.example").report_only().hsts(),
            false,
        ),
        ("framed by itself", Policy::new().frame_ancestors("'self'"), false),
        ("every feature allowed", allowed(), false),
        ("a report endpoint", Policy::new().report_to(&reports), false),
        // No feature to deny, and still a line of a document's own.
        ("every feature allowed, and a report endpoint", allowed().report_to(&reports), false),
        ("a referrer policy and popups", Policy::new().referrer(Referrer::SameOrigin).allow_popups(), false),
    ]
}

/// An answer's header lines in the order they are sent.
fn lines_of(headers: &http::HeaderMap) -> Vec<(String, Vec<u8>)> {
    headers.iter().map(|(name, value)| (name.as_str().to_string(), value.as_bytes().to_vec())).collect()
}

/// [`Applied::ready`](crate::security::Applied::ready) gives an answer exactly what the stages it
/// stands in for would: under each policy, for an API's answers, a page scope's, an area's with a
/// policy of its own and those of an API inside that area, every answer [`lines_answer`] makes is
/// either left untouched, or has the same lines in the same order as the same answer given to
/// `Applied::headers`, `Applied::document` and `cache::settle`, whatever the request was (its
/// nonce taken or not, the runtime's or not, whoever asked).
#[test]
fn an_answer_s_lines_given_in_one_pass_are_the_ones_the_stages_insert() {
    use crate::cache::Seen;
    use crate::security::{Applied, NonceSlot, Sources};
    let anyone = || Seen { credentials: false, caller: false, partial: false, nonce: false, dev: false };
    let (mut given, mut left) = (0, 0);
    for (name, policy, _) in lines_policies() {
        let area = lines_area_policy(Sources::default());
        let applied = Applied::new(policy, "", &[("/walled", &area)]);
        let (walled, _) = applied.csp_for("/walled/text");
        assert!(!Arc::ptr_eq(&walled, &applied.csp), "{name}: the area has a policy of its own");
        let scopes = [
            ("an API", &*applied.csp, false),
            ("pages", &*applied.csp, true),
            ("an area", &*walled, true),
            ("an API in the area", &*walled, false),
        ];
        for (scope, csp, page) in scopes {
            let lines = applied.lines(csp, page);
            // One case of one answer: whether it was given the lines.
            let mut ready = |kind: &str, taken: bool, swap: bool, seen: Seen| {
                let slot = page.then(|| NonceSlot::new(7, false));
                if let (Some(slot), true) = (&slot, taken) {
                    slot.get();
                }
                let (mut one, mut each) = (lines_answer(kind), lines_answer(kind));
                let said = format!("{name}, {scope}: {kind}, nonce taken {taken}, the runtime's {swap}");
                if !applied.ready(&mut one, &lines, slot.as_ref(), csp, seen.caller) {
                    assert_eq!(lines_of(one.headers()), lines_of(each.headers()), "{said}: left as it was");
                    left += 1;
                    return false;
                }
                // As the app reads it: a nonce taken from the request's slot (an API's has none).
                let seen = Seen { nonce: slot.as_ref().is_some_and(|slot| slot.taken().is_some()), ..seen };
                applied.headers(&mut each, slot.as_ref(), csp, false);
                if page {
                    applied.document(&mut each, csp, swap);
                }
                crate::cache::settle(&mut each, seen, "/a/path");
                assert_eq!(lines_of(one.headers()), lines_of(each.headers()), "{said}");
                assert_eq!(one.extensions().len(), each.extensions().len(), "{said}: what is left on it");
                // Room is left for one more line (`Vary`, where the answer is compressed), as the
                // stages leave it, so the map does not grow again for it.
                assert!(one.headers().capacity() > one.headers().len(), "{said}: room for one more line");
                given += 1;
                true
            };
            for kind in LINES_KINDS {
                for (taken, swap) in [(false, false), (false, true), (true, false), (true, true)] {
                    let personal = Seen { credentials: true, caller: true, partial: true, nonce: false, dev: true };
                    let was = ready(kind, taken, swap, anyone());
                    assert_eq!(ready(kind, taken, swap, personal), was, "{name}, {scope}: {kind}, whoever asked");
                }
            }
            // The answers the pass is for are given their lines, so it cannot quietly stop.
            for kind in ["text", "created", "missing", "failed", "long", "json", "png", "nothing", "teapot", "keyed"] {
                assert!(ready(kind, false, false, anyone()), "{name}, {scope}: {kind}");
                // A page's request that took its nonce names it in the policy.
                assert_eq!(ready(kind, true, false, anyone()), !page, "{name}, {scope}: {kind}, its nonce taken");
            }
            for kind in ["two", "no-store", "vary", "policy", "cookie", "alone", "relayed", "bare-no-store", "bare-public"] {
                assert!(!ready(kind, false, false, anyone()), "{name}, {scope}: {kind}");
            }
            // A document gets lines of its own after the policy's, unless the policy has none for it.
            let plain = name == "every feature allowed";
            assert_eq!(ready("html", false, false, anyone()), !page || plain, "{name}, {scope}: a document");
            assert_eq!(ready("style", false, false, anyone()), !page, "{name}, {scope}: a style block");
        }
    }
    assert!(given > 1000 && left > 1000, "{given} given their lines, {left} left to the stages");
}

/// A document says where its CSP's reports go when its policy has no feature to deny, too. The
/// line is the document stage's own (`Applied::document`), and the one pass leaves a document to
/// that stage, so it is held here by what is sent, not by which answers the pass takes: a page, a
/// handler's document with its type alone, and the same in an area have it; a text and an API's
/// answer do not.
#[tokio::test]
async fn a_document_whose_policy_denies_no_feature_still_says_where_its_reports_go() {
    let named = "every feature allowed, and a report endpoint";
    let (_, policy, dev) = lines_policies().into_iter().find(|(name, ..)| *name == named).expect(named);
    let router = lines_app(policy, dev).router();
    let asked = [("/", true), ("/a/html", true), ("/walled/html", true), ("/a/text", false), ("/closed/html", false)];
    for (path, document) in asked {
        let (status, lines, _) = lines_sent(&router, "GET", path, &[]).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        let of = |asked: &str| -> Vec<String> {
            let found = lines.iter().filter(|(name, _)| name == asked);
            found.map(|(_, value)| String::from_utf8_lossy(value).into_owned()).collect()
        };
        let ours = if document { vec![r#"csp="https://reports.example/csp""#] } else { Vec::new() };
        assert_eq!(of("reporting-endpoints"), ours, "{path}");
        assert!(of("permissions-policy").is_empty(), "{path}: the policy has no feature to deny");
    }
}

/// An answer as it leaves the app: its status, its header lines in the order they are sent, and
/// its body. The request's nonce, where one was taken, is blanked in both.
type LinesSent = (StatusCode, Vec<(String, Vec<u8>)>, Vec<u8>);

async fn lines_sent(router: &Router, method: &str, path: &str, headers: &[(&str, &str)]) -> LinesSent {
    let mut req = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let (parts, body) = res.into_parts();
    let mut body = body.collect().await.unwrap().to_bytes().to_vec();
    let mut lines = lines_of(&parts.headers);
    let nonce = lines.iter().find_map(|(_, value)| {
        let at = value.windows(7).position(|window| window == b"'nonce-")? + 7;
        Some(value.get(at..at + 32)?.to_vec())
    });
    if let Some(nonce) = nonce {
        let blank = |bytes: &mut Vec<u8>| {
            let mut from = 0;
            while let Some(at) = bytes[from..].windows(32).position(|window| window == nonce) {
                bytes[from + at..from + at + 32].fill(b'-');
                from += at + 32;
            }
        };
        blank(&mut body);
        lines.iter_mut().for_each(|(_, value)| blank(value));
    }
    (parts.status, lines, body)
}

/// The requests each path of a [`lines_app`] is asked with: a method and header lines.
const LINES_REQUESTS: [(&str, &[(&str, &str)]); 14] = [
    ("GET", &[]),
    (
        "GET",
        &[
            ("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
            ("accept-language", "fr-FR,fr;q=0.5"),
            ("accept-encoding", "gzip, deflate, br, zstd"),
            ("sec-fetch-site", "none"),
        ],
    ),
    ("GET", &[("accept-encoding", "gzip")]),
    ("GET", &[("if-none-match", "*")]),
    ("HEAD", &[]),
    ("GET", &[("corten", "nav"), ("accept-encoding", "br")]),
    ("GET", &[("accept", "application/json")]),
    ("GET", &[("cookie", "viewer=ann")]),
    ("GET", &[("authorization", "Bearer t"), ("accept-encoding", "zstd")]),
    ("GET", &[("origin", "https://partner.example"), ("accept-encoding", "br")]),
    ("OPTIONS", &[("origin", "https://partner.example"), ("access-control-request-method", "GET")]),
    ("POST", &[("origin", "https://evil.example"), ("sec-fetch-site", "cross-site"), ("accept", "text/html")]),
    ("POST", &[("sec-fetch-site", "same-origin")]),
    ("GET", &[("host", "rebound.attacker.example:3917")]),
];

/// The app sends an answer given its scope's lines in one pass as it sends the same answer with
/// each line inserted. Every answer of a [`lines_app`], under each policy and in each scope, to
/// each request, is compared with the same app's to the same request when its middleware gives
/// the answer one more line ([`OneMore`]), which no stage reads and which leaves each of the
/// scope's lines to be inserted: the status, the lines in the order they are sent but for that
/// one, and the body are the same, and so is the answer to the same request asked again with
/// its tag.
#[tokio::test]
async fn an_answer_given_its_scope_s_lines_in_one_pass_is_sent_as_one_each_line_is_inserted_into() {
    let mut paths: Vec<String> = [
        "/",
        "/big",
        "/inline",
        "/keyed",
        "/shared",
        "/moved",
        "/fails",
        "/nonced",
        "/unknown",
        "/closed/unknown/url",
        "/health/live",
    ]
    .map(String::from)
    .to_vec();
    for scope in ["/a", "/closed", "/open", "/walled", "/walled/api"] {
        paths.extend(LINES_KINDS.iter().map(|kind| format!("{scope}/{kind}")));
    }
    let less = |mut sent: LinesSent| {
        let had = sent.1.len();
        sent.1.retain(|(name, _)| name != "x-one-more");
        (had - sent.1.len(), sent)
    };
    let (mut compared, mut marked) = (0, 0);
    for (policy, made, dev) in lines_policies() {
        let app = lines_app(made, dev).middleware(OneMore).router();
        for path in &paths {
            for (method, headers) in LINES_REQUESTS {
                let said = format!("{policy}: {method} {path} {headers:?}");
                let mut asks = headers.to_vec();
                asks.push(("x-each", "1"));
                let (none, one_sent) = less(lines_sent(&app, method, path, headers).await);
                let (more, each_sent) = less(lines_sent(&app, method, path, &asks).await);
                assert_eq!(none, 0, "{said}");
                marked += more;
                // A submit key is drawn for each request: its page is as long either way.
                let drawn = path == "/keyed";
                let body = |sent: &LinesSent| if drawn { sent.2.len().to_string().into_bytes() } else { sent.2.clone() };
                assert_eq!(body(&one_sent), body(&each_sent), "{said}");
                assert_eq!((one_sent.0, &one_sent.1), (each_sent.0, &each_sent.1), "{said}");
                compared += 1;
                // The same request again, by the tag it was given.
                let Some((_, tag)) = one_sent.1.iter().find(|(name, _)| name == "etag") else { continue };
                let tag = std::str::from_utf8(tag).unwrap();
                let mut again = headers.to_vec();
                again.push(("if-none-match", tag));
                let (_, one_again) = less(lines_sent(&app, method, path, &again).await);
                again.push(("x-each", "1"));
                let (_, each_again) = less(lines_sent(&app, method, path, &again).await);
                assert_eq!(one_again, each_again, "{said}, asked again with its tag");
                compared += 1;
            }
        }
    }
    // The middleware ran for most answers, so most were compared with each line inserted.
    assert!(marked * 2 > compared && compared > 20_000, "{marked} of {compared} answers had the one more line");
}
