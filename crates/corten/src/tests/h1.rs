//! Corten's own HTTP/1.1 connection ([`crate::h1`], [`App::own_http1`]) over a socket: what it
//! refuses, when it keeps a connection, what it does with pipelined requests, where it hands a
//! connection to hyper, that every limit an app sets holds on it, and where what it answers is
//! what hyper's connection answers, byte for byte but `Date`, and where it is not (trailers, a
//! body that fails, a head refused at the limit). `h1_fuzz` compares the two on streams made at
//! random.

use super::*;
use bytes::Bytes;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// How long a client waits for a server that should answer, or close, at once.
const SOON: Duration = Duration::from_secs(5);

/// hyper's connection, then Corten's own.
const BOTH: [bool; 2] = [false, true];

/// A server for `app` on a free port, with hyper's connection or Corten's own (`own`).
struct Served {
    addr: std::net::SocketAddr,
    stop: tokio::sync::oneshot::Sender<()>,
    server: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Served {
    async fn start<M: crate::Middleware>(app: App<M>, own: bool) -> Served {
        let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
        let addr = listeners[0].local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app.own_http1(own), async {
            let _ = stopped.await;
        }));
        Served { addr, stop, server }
    }

    async fn stop(self) {
        let _ = self.stop.send(());
        tokio::time::timeout(Duration::from_secs(10), self.server).await.expect("shutdown ends").unwrap().unwrap();
    }

    /// Sends `request` on a new connection and returns all the server sends until it closes the
    /// connection, which it must.
    async fn closed(&self, request: impl AsRef<[u8]>) -> String {
        let (got, closed) = self.within(request, SOON).await;
        assert!(closed, "the server closes the connection: {got}");
        got
    }

    /// Sends `request` on a new connection and returns what the server sent within `wait`, and
    /// whether it closed the connection.
    async fn within(&self, request: impl AsRef<[u8]>, wait: Duration) -> (String, bool) {
        let mut client = TcpStream::connect(self.addr).await.unwrap();
        client.write_all(request.as_ref()).await.unwrap();
        read(&mut client, wait).await
    }
}

/// What `client` receives within `wait`, and whether the server closed the connection.
async fn read(client: &mut TcpStream, wait: Duration) -> (String, bool) {
    let mut got = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    let closed = tokio::time::timeout(wait, async {
        loop {
            match client.read(&mut buf).await {
                // A reset too: the server closed with bytes of the client's unread.
                Ok(0) | Err(_) => return,
                Ok(read) => got.extend_from_slice(&buf[..read]),
            }
        }
    });
    let closed = closed.await.is_ok();
    (String::from_utf8_lossy(&got).into_owned(), closed)
}

/// One answer that says its length, as `client` receives it.
async fn one(client: &mut TcpStream) -> String {
    several(client, 1).await
}

/// `count` answers that say their lengths, as `client` receives them: in one read or in several,
/// which is the server's to choose.
async fn several(client: &mut TcpStream, count: usize) -> String {
    let mut got = Vec::new();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let (mut at, mut whole) = (0, 0);
        while let Some(end) = got[at..].windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&got[at..at + end]);
            let length = head.lines().find_map(|line| line.strip_prefix("content-length: "));
            let length: usize = length.map_or(0, |length| length.parse().unwrap());
            if got.len() - (at + end + 4) < length {
                break;
            }
            at += end + 4 + length;
            whole += 1;
        }
        if whole >= count {
            return String::from_utf8_lossy(&got).into_owned();
        }
        let read = tokio::time::timeout(SOON, client.read(&mut buf)).await;
        let read = read.unwrap_or_else(|_| panic!("no answer after {:?}", String::from_utf8_lossy(&got))).unwrap();
        assert!(read > 0, "closed after {:?}", String::from_utf8_lossy(&got));
        got.extend_from_slice(&buf[..read]);
    }
}

/// What `client` receives until it ends with `end`.
async fn until(client: &mut TcpStream, end: &str) -> String {
    let mut got = Vec::new();
    let mut buf = [0u8; 4096];
    while !got.ends_with(end.as_bytes()) {
        let read = tokio::time::timeout(SOON, client.read(&mut buf)).await;
        let read = read.unwrap_or_else(|_| panic!("no {end:?} after {:?}", String::from_utf8_lossy(&got))).unwrap();
        assert!(read > 0, "closed after {:?}", String::from_utf8_lossy(&got));
        got.extend_from_slice(&buf[..read]);
    }
    String::from_utf8_lossy(&got).into_owned()
}

/// The status of each answer in `got`. No body in these tests has a status line in it.
pub(super) fn statuses(got: &str) -> Vec<u16> {
    got.match_indices("HTTP/1.").filter_map(|(at, _)| got.get(at + 9..at + 12)?.parse().ok()).collect()
}

/// Where `part` first is in `bytes`.
pub(super) fn find(bytes: &[u8], part: &[u8]) -> Option<usize> {
    bytes.windows(part.len()).position(|window| window == part)
}

/// `got` with the value of each answer's `Date` replaced: the one thing two servers may answer
/// differently. Only a `date` line of an answer's head whose value is a date as a server writes
/// one: the same bytes anywhere else (a body, another line's value) are left as they are, and so
/// is every other byte. No body in these tests has a status line in it.
pub(super) fn undated(got: &[u8]) -> Vec<u8> {
    const SHAPE: &[u8; 29] = b"Aaa, 00 Aaa 0000 00:00:00 GMT";
    let dated = |value: &[u8]| {
        value.len() == SHAPE.len()
            && value.iter().zip(SHAPE).all(|(byte, shape)| match shape {
                b'0' => byte.is_ascii_digit(),
                b'A' => byte.is_ascii_uppercase(),
                b'a' => byte.is_ascii_lowercase(),
                _ => byte == shape,
            })
    };
    let (mut out, mut rest) = (Vec::with_capacity(got.len()), got);
    while let Some(head) = find(rest, b"HTTP/1.") {
        out.extend_from_slice(&rest[..head]);
        rest = &rest[head..];
        // The head's lines, to the empty one or to the end of what was sent.
        while !rest.is_empty() {
            let line = find(rest, b"\r\n").map_or(rest.len(), |end| end + 2);
            let (this, behind) = rest.split_at(line);
            rest = behind;
            match this.strip_prefix(b"date: ").and_then(|value| value.strip_suffix(b"\r\n")) {
                Some(value) if dated(value) => out.extend_from_slice(b"date: -\r\n"),
                _ => out.extend_from_slice(this),
            }
            if this == b"\r\n" {
                break;
            }
        }
    }
    out.extend_from_slice(rest);
    out
}

/// [`undated`], for what a test holds as text.
pub(super) fn dateless(got: &str) -> String {
    String::from_utf8_lossy(&undated(got.as_bytes())).into_owned()
}

/// A `Date` is taken out of an answer's head and from nowhere else.
#[test]
fn only_an_answers_own_date_is_taken_out() {
    let date = "Sun, 06 Nov 1994 08:49:37 GMT";
    let answer = |body: &str| format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\ndate: {date}\r\n\r\n{body}", body.len());
    let without = |body: &str| format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\ndate: -\r\n\r\n{body}", body.len());
    assert_eq!(dateless(&(answer("hi") + &answer(""))), without("hi") + &without(""));
    // Not in a body, not in another line's value, not a value that is no date, and not a head
    // that was cut before its date's end.
    let body = format!("date: {date}\r\n");
    assert_eq!(dateless(&answer(&body)), without(&body));
    for head in [format!("x-was: date: {date}"), "date: yesterday".to_owned(), format!("date: {date} "), format!("Date: {date}")]
    {
        let kept = format!("HTTP/1.1 200 OK\r\n{head}\r\n\r\n");
        assert_eq!(dateless(&kept), kept);
    }
    let cut = format!("HTTP/1.1 200 OK\r\ndate: {}", &date[..20]);
    assert_eq!(dateless(&cut), cut);
    assert_eq!(
        undated(b"\xff\xfeHTTP/1.1 200 OK\r\n\xff: \x80\r\n\r\n\xff"),
        b"\xff\xfeHTTP/1.1 200 OK\r\n\xff: \x80\r\n\r\n\xff"
    );
}

static X: [u8; 20 * 1024] = [b'x'; 20 * 1024];

/// Routes with an answer of each kind a connection writes differently.
fn routes() -> Routes {
    let stream = || async {
        let pieces: [&'static [u8]; 4] = [b"first", b"second", &X, b"last"];
        Body::from_stream(futures_util::stream::iter(pieces.map(|piece| Ok::<_, std::io::Error>(Bytes::from_static(piece)))))
    };
    let slow = || async {
        tokio::time::sleep(Duration::from_millis(700)).await;
        "slow"
    };
    Routes::from(
        Table::new()
            .route("/", get(|| async { "hi" }))
            .route("/json", get(|| async { ([(header::CONTENT_TYPE, "application/json")], r#"{"ok":true}"#) }))
            .route("/empty", get(|| async {}))
            .route("/stream", get(stream))
            .route("/slow", get(slow))
            .route("/none", get(|| async { StatusCode::NO_CONTENT }))
            .route("/not-modified", get(|| async { (StatusCode::NOT_MODIFIED, [(header::ETAG, "\"v1\"")]) }))
            .route("/fail", get(|| async { Err::<&str, _>(crate::Error::new("the handler failed")) }))
            .route("/interim", get(|| async { (StatusCode::PROCESSING, "not an answer") }))
            .route("/close", get(|| async { ([(header::CONNECTION, "close")], "bye") }))
            .route("/length", get(|| async { ([(header::CONTENT_LENGTH, "2")], "hi") }))
            .route("/length-of-a-stream", get(move || async move { ([(header::CONTENT_LENGTH, "20495")], stream().await) }))
            .route("/chunked", get(|| async { ([(header::TRANSFER_ENCODING, "chunked")], "hi") }))
            .route("/gzip-chunked", get(|| async { ([(header::TRANSFER_ENCODING, "gzip, chunked")], "hi") }))
            .route("/switch", get(|| async { (StatusCode::SWITCHING_PROTOCOLS, "not a switch") }))
            .route("/unread", crate::router::post(|| async { "unread" }))
            .route("/read", crate::router::post(|body: Bytes| async move { format!("read {}", body.len()) })),
    )
}

const HOST: &str = "host: localhost\r\n";

const GET: &str = "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";

/// A request that ends its connection: the last of a case, so the case ends when the server has
/// sent all it will.
fn last() -> String {
    format!("GET /empty HTTP/1.1\r\n{HOST}connection: close\r\n\r\n")
}

/// An answer of each kind, to a request of each kind, is the same bytes from Corten's connection
/// as from hyper's: the status line, each header's name, value and place, how the body is framed
/// and what closes the connection. Only the `Date` is left out. The requests with a body, and the
/// one that asks to switch, are answered by hyper on both, behind the answers of Corten's own.
#[tokio::test]
async fn an_answer_is_hypers_byte_for_byte() {
    let hyper = Served::start(App::new(routes()), false).await;
    let own = Served::start(App::new(routes()), true).await;
    let get = |path: &str| format!("GET {path} HTTP/1.1\r\n{HOST}\r\n");
    let head = |path: &str| format!("HEAD {path} HTTP/1.1\r\n{HOST}\r\n");
    let chunked =
        format!("POST /read HTTP/1.1\r\n{HOST}transfer-encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n");
    let cases: Vec<(&str, String, bool)> = vec![
        ("text", get("/"), false),
        ("json", get("/json"), false),
        ("an empty body", get("/empty"), false),
        ("a streamed body", get("/stream"), false),
        ("HEAD of text", head("/"), false),
        ("HEAD of json", head("/json"), false),
        ("HEAD of a stream", head("/stream"), false),
        ("204", get("/none"), false),
        ("304", get("/not-modified"), false),
        ("an error page", get("/fail"), false),
        ("404", get("/nowhere"), false),
        ("405", format!("DELETE / HTTP/1.1\r\n{HOST}\r\n"), false),
        ("a body read", format!("POST /read HTTP/1.1\r\n{HOST}content-length: 5\r\n\r\nhello"), false),
        ("a body left", format!("POST /unread HTTP/1.1\r\n{HOST}content-length: 5\r\n\r\nhello"), false),
        (
            "a body behind answers",
            get("/") + &get("/json") + &format!("POST /read HTTP/1.1\r\n{HOST}content-length: 5\r\n\r\nhello"),
            false,
        ),
        ("a chunked body read", chunked, false),
        ("a length the handler wrote", get("/length"), false),
        ("HEAD of a length the handler wrote", head("/length"), false),
        ("a length the handler wrote for a stream", get("/length-of-a-stream"), false),
        ("HEAD of a length the handler wrote for a stream", head("/length-of-a-stream"), false),
        ("a transfer coding the handler wrote", get("/chunked"), false),
        ("HEAD of a transfer coding the handler wrote", head("/chunked"), false),
        ("two transfer codings the handler wrote", get("/gzip-chunked"), false),
        ("a transfer coding the handler wrote, to HTTP/1.0", "GET /chunked HTTP/1.0\r\n\r\n".into(), true),
        ("a length the handler wrote, to HTTP/1.0", "GET /length HTTP/1.0\r\n\r\n".into(), true),
        ("101 to a request that asked for no switch", get("/switch") + GET, true),
        ("an interim status for an answer", get("/interim"), true),
        ("the handler closes", get("/close"), true),
        ("the client closes", format!("GET / HTTP/1.1\r\n{HOST}connection: close\r\n\r\n"), true),
        ("HTTP/1.0", "GET / HTTP/1.0\r\n\r\n".into(), true),
        ("HTTP/1.0 kept alive", "GET / HTTP/1.0\r\nconnection: keep-alive\r\n\r\nGET /json HTTP/1.0\r\n\r\n".into(), true),
        ("HTTP/1.0, a streamed body", "GET /stream HTTP/1.0\r\nconnection: keep-alive\r\n\r\n".into(), true),
        ("HTTP/1.0, HEAD", "HEAD / HTTP/1.0\r\n\r\n".into(), true),
        ("HTTP/1.0, 204", "GET /none HTTP/1.0\r\n\r\n".into(), true),
        (
            "a head refused after HTTP/1.0",
            "GET / HTTP/1.0\r\nconnection: keep-alive\r\n\r\nGET / HTTP/1.1\r\nx : 1\r\n\r\n".into(),
            true,
        ),
        ("the asterisk form", format!("OPTIONS * HTTP/1.1\r\n{HOST}\r\n"), false),
        ("the absolute form", format!("GET http://localhost/json HTTP/1.1\r\n{HOST}\r\n"), false),
        ("empty lines before a request", format!("\r\n\r\n{GET}"), false),
        ("a bare LF for a line end", "GET / HTTP/1.1\nhost: localhost\n\n".into(), false),
        ("two requests in one write", get("/json") + &get("/stream"), false),
        (
            "an upgrade the route does not take",
            format!("GET / HTTP/1.1\r\n{HOST}connection: upgrade\r\nupgrade: websocket\r\n\r\n"),
            false,
        ),
        (
            "a body sent with Expect",
            format!("POST /read HTTP/1.1\r\n{HOST}content-length: 5\r\nexpect: 100-continue\r\n\r\nhello"),
            false,
        ),
        ("a head that is refused", "GET / HTTP/1.1\r\nhost : localhost\r\n\r\n".to_owned(), true),
        ("a head that is refused behind answers", get("/") + "GET / HTTP/1.1\r\nhost : localhost\r\n\r\n", true),
        ("a head over the limit", format!("GET / HTTP/1.1\r\n{HOST}cookie: c={}\r\n\r\n", "x".repeat(33 * 1024)), true),
    ];
    for (name, request, closes) in cases {
        let request = if closes { request } else { request + &last() };
        let (theirs, ours) = (hyper.closed(&request).await, own.closed(&request).await);
        assert!(theirs.starts_with("HTTP/1."), "{name}: hyper answered {theirs:?}");
        assert_eq!(dateless(&ours), dateless(&theirs), "{name}");
        assert_eq!(
            ours.matches("date: ").count(),
            statuses(&ours).iter().filter(|status| **status != 100).count(),
            "{name}: a date an answer"
        );
    }
    hyper.stop().await;
    own.stop().await;
}

/// What the grammar of a head does not have is refused as hyper refuses it (400, with the same
/// bytes, and the connection closed), and what hyper takes is taken: both read a head with the
/// same parser.
#[tokio::test]
async fn a_head_that_is_not_http_is_refused_as_hyper_refuses_it() {
    let hyper = Served::start(App::new(routes()), false).await;
    let own = Served::start(App::new(routes()), true).await;
    let header = |line: &str| format!("GET / HTTP/1.1\r\n{HOST}{line}\r\n\r\n");
    let line = |line: &str| format!("{line}\r\n{HOST}\r\n");
    let refused = [
        ("a folded line", header("x-a: 1\r\n folded")),
        ("a line folded with a tab", header("x-a: 1\r\n\tfolded")),
        ("a space before the colon", header("x-a : 1")),
        ("a tab before the colon", header("x-a\t: 1")),
        ("a bare CR in a value", header("x-a: a\rb")),
        ("a bare CR in a name", header("x\ra: 1")),
        ("a CR before a line's end", header("x-a: 1\r")),
        ("a bare CR for a line end", format!("GET / HTTP/1.1\r{HOST}\r\n")),
        ("a line that is a CR", header("\r")),
        ("NUL in a value", header("x-a: a\0b")),
        ("a control byte in a value", header("x-a: a\x01b")),
        ("DEL in a value", header("x-a: a\x7fb")),
        ("NUL in a name", header("x\0a: 1")),
        ("a space in a name", header("x a: 1")),
        ("a delimiter in a name", header("x(a): 1")),
        ("a line with no colon", header("x-a")),
        ("an empty name", header(": 1")),
        ("a space before a length's colon", header("content-length : 5")),
        ("a folded transfer coding", header("x-a: 1\r\n transfer-encoding: chunked")),
        ("a method that is not a token", line("G(ET / HTTP/1.1")),
        ("a space before the method", line(" GET / HTTP/1.1")),
        ("a tab after the method", line("GET\t/ HTTP/1.1")),
        ("HTTP/2.0", line("GET / HTTP/2.0")),
        ("HTTP/1.2", line("GET / HTTP/1.2")),
        ("HTTP/0.9", line("GET /")),
        ("a version in lower case", line("GET / http/1.1")),
        ("a space in the target", line("GET /a b HTTP/1.1")),
        ("a control byte in the target", line("GET /a\x01b HTTP/1.1")),
        ("no target", line("GET  HTTP/1.1")),
        ("bytes that are no request", "\x16\x03\x01\x02\x00\x01\x00\x01\x7c\x03\x03\r\n\r\n".to_owned()),
    ];
    for (name, request) in refused {
        let (theirs, ours) = (hyper.closed(&request).await, own.closed(&request).await);
        assert_eq!(statuses(&ours), [400], "{name}: {ours}");
        assert_eq!(dateless(&ours), dateless(&theirs), "{name}");
    }
    let taken = [
        ("a tab in a value", header("x-a: a\tb")),
        ("bytes over 127 in a value", "GET / HTTP/1.1\r\nhost: localhost\r\nx-a: caf\u{e9}\r\n\r\n".to_owned()),
        ("an empty value", header("x-a:")),
        ("spaces around a value", header("x-a:    1   ")),
        ("a method of the client's own", line("PURGE / HTTP/1.1")),
    ];
    for (name, request) in taken {
        let request = request + &last();
        let (theirs, ours) = (hyper.closed(&request).await, own.closed(&request).await);
        assert_eq!(statuses(&ours).len(), 2, "{name}: {ours}");
        assert_eq!(dateless(&ours), dateless(&theirs), "{name}");
    }
    hyper.stop().await;
    own.stop().await;
}

/// What a request's `Host` gets is the app's host check's to say, and it says the same on both
/// connections: Corten's own brings no rule for `Host`, and marks an HTTP/1.1 request that has
/// none as hyper's connection's service does, for that check to answer.
#[tokio::test]
async fn a_request_s_host_is_answered_as_on_hypers_connection() {
    let hyper = Served::start(App::new(routes()), false).await;
    let own = Served::start(App::new(routes()), true).await;
    let cases = [
        ("no Host line in HTTP/1.1", "GET / HTTP/1.1\r\n\r\n".to_owned(), 400),
        ("no Host line behind an answer", format!("{GET}GET /json HTTP/1.1\r\nx-a: 1\r\n\r\n"), 200),
        ("two Host lines", format!("GET / HTTP/1.1\r\n{HOST}{HOST}\r\n"), 400),
        ("a name the app does not answer to", "GET / HTTP/1.1\r\nhost: other.example\r\n\r\n".to_owned(), 421),
        ("no Host line in HTTP/1.0", "GET / HTTP/1.0\r\n\r\n".to_owned(), 200),
    ];
    for (name, request, first) in cases {
        let request = request + &last();
        let (theirs, ours) = (hyper.closed(&request).await, own.closed(&request).await);
        assert_eq!(statuses(&ours).first(), Some(&first), "{name}: {ours}");
        assert_eq!(dateless(&ours), dateless(&theirs), "{name}");
    }
    let behind = format!("{GET}GET /json HTTP/1.1\r\nx-a: 1\r\n\r\n{}", last());
    assert_eq!(statuses(&own.closed(&behind).await)[..2], [200, 400]);
    hyper.stop().await;
    own.stop().await;
}

/// `App::max_request_head` holds on both connections: a head over it and one with more than 100
/// headers are 431, a head the client never ends is refused when it reaches the limit, and with
/// the limit raised a target longer than a URL can be is 414, each as hyper's connection answers.
#[tokio::test]
async fn a_head_over_a_limit_is_refused_as_hyper_refuses_it() {
    let mut answers = Vec::new();
    for own in BOTH {
        let mut got = Vec::new();
        let served = Served::start(App::new(routes()), own).await;
        got.push(served.closed(format!("GET / HTTP/1.1\r\n{HOST}cookie: c={}\r\n\r\n", "x".repeat(33 * 1024))).await);
        assert_eq!(statuses(&got[0]), [431], "own: {own}, a head of 33 KiB: {}", got[0]);
        let headers: String = (0..101).map(|at| format!("x-{at}: 1\r\n")).collect();
        got.push(served.closed(format!("GET / HTTP/1.1\r\n{headers}\r\n")).await);
        assert_eq!(statuses(&got[1]), [431], "own: {own}, 101 headers: {}", got[1]);
        let headers: String = (0..98).map(|at| format!("x-{at}: 1\r\n")).collect();
        got.push(served.closed(format!("GET / HTTP/1.1\r\n{HOST}{headers}connection: close\r\n\r\n")).await);
        assert_eq!(statuses(&got[2]), [200], "own: {own}, 100 headers: {}", got[2]);
        // A request line the client never ends is refused at the limit, not held.
        got.push(served.closed(format!("GET /{}", "x".repeat(32 * 1024))).await);
        assert_eq!(statuses(&got[3]), [431], "own: {own}, a request line without end: {}", got[3]);
        // A head of the limit to the byte is answered, behind an answer too.
        let start = format!("GET / HTTP/1.1\r\n{HOST}connection: close\r\ncookie: c=");
        let at_limit = format!("{start}{}\r\n\r\n", "x".repeat(32 * 1024 - start.len() - 4));
        assert_eq!(at_limit.len(), 32 * 1024);
        got.push(served.closed(format!("{GET}{at_limit}")).await);
        assert_eq!(statuses(&got[4]), [200, 200], "own: {own}, a head of the limit: {}", got[4]);
        served.stop().await;

        let served = Served::start(App::new(routes()).max_request_head(256 * 1024), own).await;
        got.push(served.closed(format!("GET /{} HTTP/1.1\r\n{HOST}\r\n", "x".repeat(70_000))).await);
        assert_eq!(statuses(&got[5]), [414], "own: {own}, a target of 70,000 bytes: {}", got[5]);
        got.push(
            served
                .closed(format!("GET / HTTP/1.1\r\n{HOST}connection: close\r\ncookie: c={}\r\n\r\n", "x".repeat(200_000)))
                .await,
        );
        assert_eq!(statuses(&got[6]), [200], "own: {own}, a head of 200,000 bytes under a raised limit");
        served.stop().await;

        let served = Served::start(App::new(routes()).max_request_head(300), own).await;
        got.push(
            served.closed(format!("GET / HTTP/1.1\r\n{HOST}connection: close\r\ncookie: c={}\r\n\r\n", "x".repeat(200))).await,
        );
        assert_eq!(statuses(&got[7]), [200], "own: {own}, a head under a lowered limit: {}", got[7]);
        got.push(served.closed(format!("GET / HTTP/1.1\r\n{HOST}cookie: c={}\r\n\r\n", "x".repeat(300))).await);
        assert_eq!(statuses(&got[8]), [431], "own: {own}, a head over a lowered limit: {}", got[8]);
        served.stop().await;
        answers.push(got.iter().map(|got| dateless(got)).collect::<Vec<_>>());
    }
    assert_eq!(answers[1], answers[0]);
}

/// An HTTP/1.0 client is answered as one (`HTTP/1.0`, never chunked) and its connection closed
/// after the answer unless it asked to keep it, which the answer then says; a streamed body ends
/// with the connection either way.
#[tokio::test]
async fn an_http_1_0_client_keeps_its_connection_only_if_it_asks() {
    let own = Served::start(App::new(routes()), true).await;
    let got = own.closed("GET / HTTP/1.0\r\n\r\nGET / HTTP/1.0\r\n\r\n").await;
    assert_eq!(statuses(&got), [200], "{got}");
    assert!(got.starts_with("HTTP/1.0 200 OK\r\n") && !got.contains("keep-alive") && got.ends_with("hi"), "{got}");

    let got = own.closed("GET / HTTP/1.0\r\nConnection: Keep-Alive\r\n\r\nGET /json HTTP/1.0\r\n\r\n").await;
    assert_eq!(statuses(&got), [200, 200], "{got}");
    assert_eq!(got.matches("connection: keep-alive\r\n").count(), 1, "{got}");

    let got = own.closed("GET /stream HTTP/1.0\r\nconnection: keep-alive\r\n\r\nGET / HTTP/1.0\r\n\r\n").await;
    assert_eq!(statuses(&got), [200], "the stream's end is the connection's: {got}");
    assert!(!got.contains("transfer-encoding") && !got.contains("content-length"), "{}", &got[..got.len().min(400)]);
    let body = got.split_once("\r\n\r\n").unwrap().1;
    assert_eq!(body.len(), "firstsecondlast".len() + X.len(), "the body as it is, not chunked");
    own.stop().await;
}

/// `Connection: close` from the client, or from the handler, ends the connection after that
/// answer, which says so; a request sent behind it is not answered.
#[tokio::test]
async fn connection_close_ends_the_connection_after_its_answer() {
    let own = Served::start(App::new(routes()), true).await;
    for request in
        [format!("GET / HTTP/1.1\r\n{HOST}Connection: Close\r\n\r\n{GET}"), format!("GET /close HTTP/1.1\r\n{HOST}\r\n{GET}")]
    {
        let got = own.closed(&request).await;
        assert_eq!(statuses(&got), [200], "{got}");
        assert_eq!(got.matches("connection: close\r\n").count(), 1, "{got}");
    }
    // Without it an HTTP/1.1 connection is kept: both are answered, and it stays open.
    let (got, closed) = own.within(format!("{GET}{GET}"), Duration::from_millis(500)).await;
    assert_eq!((statuses(&got), closed), (vec![200, 200], false), "{got}");
    own.stop().await;
}

/// A client speaking HTTP/2, and one that closes with half a head sent, get no answer: the
/// connection closes, as with hyper.
#[tokio::test]
async fn a_client_that_does_not_send_a_request_gets_no_answer() {
    for own in BOTH {
        let served = Served::start(App::new(routes()), own).await;
        let got = served.closed("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n").await;
        assert_eq!(got, "", "own: {own}");
        let got = served.closed("\r\n\r\nPRI * HTTP/2.0\r\n\r\nSM\r\n\r\n").await;
        assert_eq!(got, "", "own: {own}, behind empty lines");
        let mut client = TcpStream::connect(served.addr).await.unwrap();
        client.write_all(b"GET / HTTP/1.1\r\nhost: loc").await.unwrap();
        client.shutdown().await.unwrap();
        let (got, closed) = read(&mut client, SOON).await;
        assert_eq!((got.as_str(), closed), ("", true), "own: {own}");
        served.stop().await;
    }
}

/// Requests sent in one write (pipelined) are each answered, whole and in the order they were
/// sent, with the bytes hyper's connection answers them with: short answers, a streamed one
/// between them, one whose handler waits, and a request for a page that is not there.
#[tokio::test]
async fn requests_sent_in_one_write_are_each_answered_in_order() {
    let get = |path: &str| format!("GET {path} HTTP/1.1\r\n{HOST}\r\n");
    let mut pipeline = String::new();
    for path in ["/", "/json", "/stream", "/slow", "/nowhere", "/none", "/", "/stream", "/json"] {
        pipeline.push_str(&get(path));
    }
    pipeline.push_str(&GET.repeat(40));
    pipeline.push_str(&last());
    let mut answers = Vec::new();
    for own in BOTH {
        let served = Served::start(App::new(routes()), own).await;
        let got = served.closed(&pipeline).await;
        let mut expected = vec![200, 200, 200, 200, 404, 204, 200, 200, 200];
        expected.extend([200; 41]);
        assert_eq!(statuses(&got), expected, "own: {own}");
        answers.push(dateless(&got));
        served.stop().await;
    }
    assert_eq!(answers[1], answers[0]);
}

/// A whole request is answered at once whatever is behind it: half of the next head, or a stray
/// line end. Nothing waits for the rest to arrive, and the rest is answered when it does.
#[tokio::test]
async fn a_whole_request_is_answered_before_what_is_behind_it_arrives() {
    for own in BOTH {
        let served = Served::start(App::new(routes()), own).await;
        for behind in ["GET /json HT", "\r\n", "\r\n\r\nGET /js"] {
            let mut client = TcpStream::connect(served.addr).await.unwrap();
            client.write_all(format!("{GET}{behind}").as_bytes()).await.unwrap();
            let first = one(&mut client).await;
            assert!(first.ends_with("hi"), "own: {own}, behind it {behind:?}: {first}");
            let rest = format!("GET /json HTTP/1.1\r\n{HOST}\r\n");
            let sent = behind.trim_start_matches(['\r', '\n']).len();
            client.write_all(&rest.as_bytes()[sent..]).await.unwrap();
            let second = one(&mut client).await;
            assert!(second.ends_with(r#"{"ok":true}"#), "own: {own}, behind it {behind:?}: {second}");
        }
        served.stop().await;
    }
}

/// A stream's first bytes reach the client when the stream gives them, with a request waiting
/// behind it; the answer to that request follows the stream's end.
#[tokio::test]
async fn a_streams_early_bytes_are_sent_when_written_with_a_request_behind_it() {
    for own in BOTH {
        let release = Arc::new(tokio::sync::Notify::new());
        let stream = {
            let release = release.clone();
            move || {
                let release = release.clone();
                async move {
                    let later = async move {
                        release.notified().await;
                        Ok::<_, std::io::Error>(Bytes::from_static(b"later"))
                    };
                    let early = futures_util::stream::iter([Ok(Bytes::from_static(b"early"))]);
                    Body::from_stream(futures_util::StreamExt::chain(early, futures_util::stream::once(later)))
                }
            }
        };
        let table = Table::new().route("/", get(|| async { "hi" })).route("/events", get(stream));
        let served = Served::start(App::new(Routes::from(table)), own).await;
        let mut client = TcpStream::connect(served.addr).await.unwrap();
        client.write_all(format!("GET /events HTTP/1.1\r\n{HOST}\r\n{GET}").as_bytes()).await.unwrap();
        let early = until(&mut client, "5\r\nearly\r\n").await;
        assert_eq!(statuses(&early), [200], "own: {own}: {early}");
        release.notify_one();
        let rest = until(&mut client, "hi").await;
        assert!(rest.starts_with("5\r\nlater\r\n0\r\n\r\nHTTP/1.1 200 OK\r\n"), "own: {own}: {rest}");
        served.stop().await;
    }
}

/// A connection whose client keeps it busy does not keep the thread: with every request of a
/// long pipeline already in hand and each answered without waiting, it still lets other tasks
/// run after every sixteenth. Seen by a task on the same thread that each request wakes, and
/// that counts its turns: it is ahead of the connection's task in the queue whenever that task
/// stops, so the requests handled between two of its turns are those of one poll of the
/// connection, and are never more than sixteen.
#[tokio::test]
async fn a_connection_that_never_waits_lets_other_tasks_run() {
    const REQUESTS: usize = 200;
    let turns = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let woken = Arc::new(tokio::sync::Notify::new());
    let handler = {
        let (turns, seen, woken) = (turns.clone(), seen.clone(), woken.clone());
        move || {
            seen.lock().unwrap().push(turns.load(SeqCst));
            woken.notify_one();
            async { "hi" }
        }
    };
    let own = Served::start(App::new(Routes::from(Table::new().route("/", get(handler)))), true).await;
    let other = {
        let turns = turns.clone();
        tokio::spawn(async move {
            loop {
                woken.notified().await;
                turns.fetch_add(1, SeqCst);
            }
        })
    };
    let mut requests = GET.repeat(REQUESTS - 1);
    requests.push_str(&format!("GET / HTTP/1.1\r\n{HOST}connection: close\r\n\r\n"));
    let got = own.closed(&requests).await;
    other.abort();
    assert_eq!(statuses(&got).len(), REQUESTS, "every request is answered");
    let seen = std::mem::take(&mut *seen.lock().unwrap());
    let longest = seen.chunk_by(|a, b| a == b).map(<[usize]>::len).max().unwrap();
    assert!(longest <= 16, "{longest} requests were handled before another task ran");
    own.stop().await;
}

/// Answers to requests nobody reads the answers of are not made without end: once what is
/// written and not sent reaches the connection's bound and the socket takes no more, no further
/// request of the pipeline is read or handled until the client reads. (Over a socket, which
/// takes megabytes first, on both connections. How many handlers the bound lets run beyond what
/// the IO takes: the test below.)
#[tokio::test]
async fn answers_to_a_pipeline_nobody_reads_are_not_made_without_bound() {
    const REQUESTS: usize = 20_000;
    static PAGE: [u8; 8 * 1024] = [b'p'; 8 * 1024];
    for own in BOTH {
        let handled = Arc::new(AtomicUsize::new(0));
        let handler = {
            let handled = handled.clone();
            move || {
                handled.fetch_add(1, SeqCst);
                async { &PAGE }
            }
        };
        let served = Served::start(App::new(Routes::from(Table::new().route("/", get(handler)))), own).await;
        let mut client = TcpStream::connect(served.addr).await.unwrap();
        // 160 MiB of answers asked for, and none read.
        let sending = tokio::spawn(async move {
            let _ = client.write_all(GET.repeat(REQUESTS).as_bytes()).await;
            client
        });
        tokio::time::sleep(Duration::from_millis(700)).await;
        let handled = handled.load(SeqCst);
        assert!(handled < REQUESTS / 2, "own: {own}: {handled} requests handled with the client reading nothing");
        // The client closes, whether it had sent everything or not.
        sending.abort();
        drop(sending.await);
        served.stop().await;
    }
}

/// How many handlers run for a client that sends requests and reads nothing is bounded by the
/// bytes of their answers, and by a count of requests only while no handler waits. The
/// connection asks for no further request once 16 KiB of answers ([`crate::h1::FLUSH_AT`]) are
/// written and not taken. Its stop at sixteen requests is another task's turn: an answer whose
/// head is written after the task has waited begins that count again, so it bounds the handlers
/// only where every request was read already and none of their handlers waited.
///
/// Seen with every request of a long pipeline given in the first reads and an IO that takes a
/// few bytes of answers or none: a handler that answers at once runs 16 times, and one that
/// waits a millisecond runs once for every answer it takes to have 16 KiB unsent. That is 219
/// times for an answer of 75 bytes (the shortest there is: no body, and no header of the
/// app's), 213 for one of 77 and 25 for one of 677.
///
/// The bound is kept in two places: behind each answer, and before a piece of a body is
/// written behind 16 KiB unsent. The answer with no body meets only the first, and without it
/// its handler runs for every request sent; the others then run one handler more where the
/// last answer's head still fit.
#[tokio::test(start_paused = true)]
async fn handlers_run_for_a_client_that_reads_nothing_until_16_kib_of_answers_wait() {
    use crate::h1::FLUSH_AT;
    use std::task::{Context, Poll};
    const REQUESTS: usize = 2_000;
    /// Gives a read all it has room for, waits at the end of what its client sent, and takes
    /// `takes` bytes of what is written and then no more.
    struct Stuck {
        sent: Vec<u8>,
        read: usize,
        takes: usize,
        took: Arc<AtomicUsize>,
    }
    impl tokio::io::AsyncRead for Stuck {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _: &mut Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let this = self.get_mut();
            if this.read == this.sent.len() {
                return Poll::Pending;
            }
            let give = (this.sent.len() - this.read).min(buf.remaining());
            buf.put_slice(&this.sent[this.read..this.read + give]);
            this.read += give;
            Poll::Ready(Ok(()))
        }
    }
    impl tokio::io::AsyncWrite for Stuck {
        fn poll_write(self: std::pin::Pin<&mut Self>, _: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
            let this = self.get_mut();
            if this.takes == 0 {
                return Poll::Pending;
            }
            let wrote = this.takes.min(buf.len());
            this.takes -= wrote;
            this.took.fetch_add(wrote, SeqCst);
            Poll::Ready(Ok(wrote))
        }
        fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: std::pin::Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }
    /// Answers every request with a body of `long` bytes, at once or a millisecond later, and
    /// counts the requests.
    struct Slow {
        ran: Arc<AtomicUsize>,
        waits: bool,
        long: usize,
    }
    type Made = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Response, std::convert::Infallible>> + Send>>;
    impl tower_service::Service<Request<Body>> for Slow {
        type Response = ::http::Response<crate::watch::Answered>;
        type Error = std::convert::Infallible;
        type Future = crate::watch::Answer<Made>;

        fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, _: Request<Body>) -> Self::Future {
            self.ran.fetch_add(1, SeqCst);
            let (waits, long) = (self.waits, self.long);
            let inner: Made = Box::pin(async move {
                if waits {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                Ok(Response::new(Body::from("h".repeat(long))))
            });
            crate::watch::Answer { inner, watch: None, connect: false }
        }
    }
    /// How many handlers ran and how many bytes the IO took, for `requests` requests given at
    /// once, by the time the connection waits and nothing more can wake it.
    async fn count(requests: usize, takes: usize, waits: bool, long: usize) -> (usize, usize) {
        let (ran, took) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let io = Stuck { sent: GET.repeat(requests).into_bytes(), read: 0, takes, took: took.clone() };
        let ending = AtomicBool::new(false);
        let serving = crate::h1::serve(io, Slow { ran: ran.clone(), waits, long }, 32 * 1024, &ending);
        assert!(tokio::time::timeout(Duration::from_secs(30), serving).await.is_err(), "the connection waits");
        (ran.load(SeqCst), took.load(SeqCst))
    }
    for (long, each, most) in [(0, 75, 219), (2, 77, 213), (600, 677, 25)] {
        assert_eq!(FLUSH_AT.div_ceil(each), most, "how many answers of {each} bytes make 16 KiB");
        for waits in [false, true] {
            // One request, to an IO that takes every byte: how long an answer is.
            assert_eq!(count(1, usize::MAX, waits, long).await, (1, each), "a body of {long} bytes, waits: {waits}");
            for takes in [0, 64] {
                let (ran, took) = count(REQUESTS, takes, waits, long).await;
                let name = format!("a body of {long} bytes, waits: {waits}, an IO that takes {takes} bytes");
                assert_eq!(took, takes, "{name}");
                // Every handler but the last began with less than 16 KiB of answers unsent.
                let bound = (FLUSH_AT + takes).div_ceil(each);
                assert!(ran <= bound, "{name}: {ran} handlers ran, and {bound} answers make 16 KiB");
                assert_eq!(ran, if waits { bound } else { 16 }, "{name}");
            }
        }
    }
}

/// An answer its client has not taken stays with the connection while it waits for the next
/// request. A client sends requests one at a time and reads nothing: when the socket takes no
/// more, the connection waits for the next request with an answer unsent, and every answer
/// reaches the client whole once it reads, with one more after.
#[tokio::test]
async fn an_answer_its_client_has_not_taken_stays_with_the_connection() {
    const REQUESTS: usize = 1_500;
    static PAGE: [u8; 8 * 1024] = [b'p'; 8 * 1024];
    let handled = Arc::new(AtomicUsize::new(0));
    let handler = {
        let handled = handled.clone();
        move || {
            handled.fetch_add(1, SeqCst);
            async { &PAGE }
        }
    };
    let own = Served::start(App::new(Routes::from(Table::new().route("/", get(handler)))), true).await;
    let mut probe = TcpStream::connect(own.addr).await.unwrap();
    probe.write_all(GET.as_bytes()).await.unwrap();
    let each = one(&mut probe).await.len();
    let mut client = TcpStream::connect(own.addr).await.unwrap();
    // Each request finds the connection waiting for it, the answers before it sent as far as
    // the socket took them: 12 MiB of answers, more than the socket holds.
    for _ in 0..REQUESTS {
        client.write_all(GET.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let handled = handled.load(SeqCst) - 1;
    assert!(handled > 2 && handled < REQUESTS, "{handled} requests were answered with the client reading nothing");
    let mut got = vec![0u8; REQUESTS * each];
    tokio::time::timeout(Duration::from_secs(30), client.read_exact(&mut got)).await.expect("every answer").unwrap();
    assert!(got.chunks(each).all(|answer| answer.starts_with(b"HTTP/1.1 200") && answer.ends_with(&PAGE)));
    client.write_all(GET.as_bytes()).await.unwrap();
    let last = one(&mut client).await;
    assert!(last.len() == each && last.starts_with("HTTP/1.1 200"), "{last}");
    own.stop().await;
}

/// Answers made are sent before the connection closes: a pipeline that ends in a request the
/// server refuses, in one that closes, or with the client's side closed, has every answer before
/// that point reach the client, on both connections.
///
/// With the client's side closed, that point is the last request: it has the client's end right
/// behind it, and a request read with nothing behind it but its client's end is answered by
/// neither connection (each looks for the end before it answers: `h1_fuzz` has the rule over a
/// pipe). So of five requests sent with the client's end to a server that holds the connection
/// (it has answered a request on it and waits for the next), four are answered. On a connection
/// just accepted the fifth may be answered too, by both alike: tokio takes an accepted socket for
/// readable before its first event has come, so a first read can take the requests with nothing
/// yet said of the client's end, which each connection then learns only when its task next
/// waits. There the four are what is asserted, and that the fifth, where there is one, is whole.
#[tokio::test]
async fn answers_made_are_sent_before_the_connection_closes() {
    let mut answers = Vec::new();
    for own in BOTH {
        let served = Served::start(App::new(routes()), own).await;
        let mut got = Vec::new();
        let refused = format!("{}GET / HTTP/1.1\r\nx : 1\r\n\r\n", GET.repeat(5));
        got.push(served.closed(&refused).await);
        assert_eq!(statuses(&got[0]), [200, 200, 200, 200, 200, 400], "own: {own}");
        let closing = format!("{}GET /close HTTP/1.1\r\n{HOST}\r\n{GET}", GET.repeat(5));
        got.push(served.closed(&closing).await);
        assert_eq!(statuses(&got[1]), [200; 6], "own: {own}");
        let mut client = TcpStream::connect(served.addr).await.unwrap();
        client.write_all(GET.as_bytes()).await.unwrap();
        let each = one(&mut client).await.len();
        client.write_all(GET.repeat(5).as_bytes()).await.unwrap();
        client.shutdown().await.unwrap();
        let (left, closed) = read(&mut client, SOON).await;
        assert!(closed && statuses(&left) == [200; 4], "own: {own}, a connection the server holds: {left}");
        assert_eq!(left.len(), 4 * each, "own: {own}: four answers, whole");
        got.push(left);
        let mut client = TcpStream::connect(served.addr).await.unwrap();
        client.write_all(GET.repeat(5).as_bytes()).await.unwrap();
        client.shutdown().await.unwrap();
        let (left, closed) = read(&mut client, SOON).await;
        let answered = statuses(&left).len();
        assert!(closed && (answered == 4 || answered == 5), "own: {own}, a connection just accepted: {left}");
        assert_eq!(left.len(), answered * each, "own: {own}: {answered} answers, whole");
        got.push(left[..4 * each].to_owned());
        answers.push(got.iter().map(|got| dateless(got)).collect::<Vec<_>>());
        served.stop().await;
    }
    assert_eq!(answers[1], answers[0]);
}

/// What a handler puts in an answer cannot end a line of its head, or the head. A value or a
/// name with a CR, an LF or a NUL is refused where the handler makes it, by `http`'s own types,
/// which every byte of a head passes before it is written. What the client sent to be reflected
/// is in no line of the answer, and the answer is hyper's.
#[tokio::test]
async fn a_handler_cannot_split_an_answer() {
    static REFUSED: AtomicUsize = AtomicUsize::new(0);
    fn unescaped(text: &str) -> Vec<u8> {
        let (mut out, mut bytes) = (Vec::new(), text.bytes());
        while let Some(byte) = bytes.next() {
            if byte == b'%' {
                let hex = [bytes.next().unwrap_or(b'0'), bytes.next().unwrap_or(b'0')];
                out.push(u8::from_str_radix(std::str::from_utf8(&hex).unwrap(), 16).unwrap_or(b'?'));
            } else {
                out.push(byte);
            }
        }
        out
    }
    // Reflects the query in a header's value, and in a header's name, by each safe way to make one.
    async fn reflect(req: Request<Body>) -> Response {
        let sent = unescaped(req.uri().query().unwrap_or(""));
        let mut res = Response::new(Body::from("hi"));
        let values = [
            ::http::HeaderValue::from_bytes(&sent).ok(),
            String::from_utf8(sent.clone()).ok().and_then(|text| ::http::HeaderValue::from_str(&text).ok()),
            ::http::HeaderValue::from_maybe_shared(Bytes::from(sent.clone())).ok(),
            String::from_utf8(sent.clone()).ok().and_then(|text| ::http::HeaderValue::try_from(text).ok()),
        ];
        let names = [::http::HeaderName::from_bytes(&sent).ok(), ::http::HeaderName::try_from(sent.clone()).ok()];
        REFUSED.fetch_add(values.iter().filter(|value| value.is_none()).count(), SeqCst);
        REFUSED.fetch_add(names.iter().filter(|name| name.is_none()).count(), SeqCst);
        for value in values.into_iter().flatten() {
            res.headers_mut().append("x-reflected", value);
        }
        for name in names.into_iter().flatten() {
            res.headers_mut().append(name, ::http::HeaderValue::from_static("named"));
        }
        res
    }
    let app = || App::new(Routes::from(Table::new().route("/reflect", get(reflect))));
    let hyper = Served::start(app(), false).await;
    let own = Served::start(app(), true).await;
    for (sent, refused) in [
        ("fine", 0),
        ("a%0d%0aset-cookie:%20evil=1", 6),
        ("a%0aset-cookie:%20evil=1", 6),
        ("a%0dset-cookie:%20evil=1", 6),
        ("a%0d%0a%0d%0aHTTP/1.1%20200%20OK%0d%0aset-cookie:%20evil=1%0d%0a%0d%0a", 6),
        ("a%00b", 6),
        ("%0d%0a", 6),
        ("x-evil%0d%0aset-cookie", 6),
    ] {
        let before = REFUSED.load(SeqCst);
        let request = format!("GET /reflect?{sent} HTTP/1.1\r\n{HOST}connection: close\r\n\r\n");
        let (theirs, ours) = (hyper.closed(&request).await, own.closed(&request).await);
        // Each server's handler refused what the other's did.
        assert_eq!(REFUSED.load(SeqCst) - before, 2 * refused, "{sent}");
        assert_eq!(dateless(&ours), dateless(&theirs), "{sent}");
        assert_eq!(statuses(&ours), [200], "one answer: {ours}");
        let (head, body) = ours.split_once("\r\n\r\n").expect("a head and a body");
        assert_eq!(body, "hi", "{sent}: {ours}");
        assert!(!head.contains("evil") && !head.contains("set-cookie") && !head.contains('\0'), "{sent}: {ours}");
        // Every line of the head is a name, a colon and a value.
        for line in head.split("\r\n").skip(1) {
            let (name, _) = line.split_once(": ").unwrap_or_else(|| panic!("{line:?} in {ours}"));
            assert!(::http::HeaderName::from_bytes(name.as_bytes()).is_ok(), "{line:?}");
        }
    }
    hyper.stop().await;
    own.stop().await;
}

/// A service for a test that drives a connection itself: every request is answered `hi`, and
/// counted.
#[derive(Clone)]
struct Hi(Arc<AtomicUsize>);

impl tower_service::Service<Request<Body>> for Hi {
    type Response = ::http::Response<crate::watch::Answered>;
    type Error = std::convert::Infallible;
    type Future = crate::watch::Answer<std::future::Ready<Result<Response, std::convert::Infallible>>>;

    fn poll_ready(&mut self, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, _: Request<Body>) -> Self::Future {
        self.0.fetch_add(1, SeqCst);
        let inner = std::future::ready(Ok(Response::new(Body::from("hi"))));
        crate::watch::Answer { inner, watch: None, connect: false }
    }
}

/// The requests that are hyper's, by what makes each so: any of the four header names, in any
/// case and whatever it says, `CONNECT`, and an HTTP/1.0 request that asks to keep its connection.
fn hypers() -> Vec<String> {
    let with = |method: &str, line: &str, body: &str| format!("{method} /read HTTP/1.1\r\n{HOST}{line}\r\n\r\n{body}");
    vec![
        with("POST", "content-length: 5", "hello"),
        with("POST", "Content-Length: 0", ""),
        with("GET", "CONTENT-LENGTH: 0", ""),
        with("POST", "content-length: five", "hello"),
        with("POST", "content-length: 5\r\ncontent-length: 6", "hello"),
        with("POST", "transfer-encoding: chunked", "5\r\nhello\r\n0\r\n\r\n"),
        with("POST", "Transfer-Encoding: gzip", "hello"),
        with("POST", "transfer-encoding:", ""),
        with("POST", "content-length: 5\r\ntransfer-encoding: chunked", "0\r\n\r\n"),
        with("POST", "content-length: 5\r\nexpect: 100-continue", "hello"),
        with("GET", "Expect: nothing", ""),
        with("GET", "connection: upgrade\r\nupgrade: echo", "behind"),
        with("GET", "UPGRADE: websocket", ""),
        format!("CONNECT /tunnel HTTP/1.1\r\n{HOST}\r\nthrough"),
        format!("CONNECT localhost:443 HTTP/1.1\r\n{HOST}\r\n"),
        "POST /read HTTP/1.0\r\ncontent-length: 5\r\n\r\nhello".to_owned(),
        // An HTTP/1.0 client that asks to keep its connection, however it says so.
        "GET / HTTP/1.0\r\nconnection: keep-alive\r\n\r\n".to_owned(),
        "GET / HTTP/1.0\r\nConnection: close, Keep-Alive\r\n\r\n".to_owned(),
        "GET / HTTP/1.0\r\nconnection: close\r\nCONNECTION: x-keep-alive-y\r\n\r\n".to_owned(),
    ]
}

/// The bytes hyper is given at a handoff are the ones the client sent from the head of the first
/// request that is hyper's on, to the byte, however the client's writes were cut and however many
/// requests Corten's own connection answered before it; and those answers have all been sent by
/// then. The connection is driven here without a server around it: its IO is one end of a pipe,
/// and what it gives back is read to its end and compared with what went into the other.
#[tokio::test(start_paused = true)]
async fn the_bytes_hyper_is_given_are_the_ones_the_client_sent() {
    let mut handoffs = 0;
    for (which, theirs) in hypers().into_iter().enumerate() {
        for before in [0usize, 1, 3] {
            let mut sent = GET.repeat(before).into_bytes();
            let ours = sent.len();
            sent.extend_from_slice(theirs.as_bytes());
            // A request behind it, which is hyper's to read too.
            sent.extend_from_slice(GET.as_bytes());
            // Every place to cut the head that is hyper's in two writes, and a few before it.
            let cuts = (0..sent.len()).filter(|cut| *cut >= ours || cut % 7 == 0);
            for cut in cuts {
                let (mut client, server) = tokio::io::duplex(1 << 20);
                let (ending, handled) = (AtomicBool::new(false), Arc::new(AtomicUsize::new(0)));
                let serving = crate::h1::serve(server, Hi(handled.clone()), 32 * 1024, &ending);
                let sending = async {
                    client.write_all(&sent[..cut]).await.unwrap();
                    // The connection reads what has come, and waits for the rest.
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    client.write_all(&sent[cut..]).await.unwrap();
                    client.shutdown().await.unwrap();
                    client
                };
                let (handed, mut client) = tokio::join!(serving, sending);
                let name = format!("request {which} behind {before}, cut at {cut}");
                let (io, read, _service) = handed.unwrap_or_else(|| panic!("{name}: the connection is hyper's"));
                // The answers before it are with the client already: nothing else writes now.
                let mut answers = vec![0u8; 1 << 16];
                let count = match tokio::time::timeout(Duration::from_millis(1), client.read(&mut answers)).await {
                    Ok(read) => read.unwrap(),
                    Err(_) => 0,
                };
                let answers = String::from_utf8_lossy(&answers[..count]);
                assert_eq!(statuses(&answers), vec![200; before], "{name}: {answers}");
                assert_eq!(handled.load(SeqCst), before, "{name}: no request that is hyper's reached the service");
                // What it read and did not answer, then what it had not read.
                let mut given = Vec::new();
                crate::h1::Rewound::new(io, read).read_to_end(&mut given).await.unwrap();
                assert_eq!(String::from_utf8_lossy(&given), String::from_utf8_lossy(&sent[ours..]), "{name}");
                handoffs += 1;
            }
        }
    }
    assert!(handoffs > 2_000, "{handoffs} handoffs");
}

/// Relays what the client sends on the connection `req` switches back to it.
fn relay(req: &mut Request<Body>) {
    let on = hyper::upgrade::on(req);
    tokio::spawn(async move {
        let Ok(upgraded) = on.await else { return };
        let mut io = hyper_util::rt::TokioIo::new(upgraded);
        let mut buf = [0u8; 64];
        loop {
            match io.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(read) if io.write_all(&buf[..read]).await.is_err() => return,
                Ok(_) => {}
            }
        }
    });
}

/// A request that is hyper's (one with a body, one that asks to switch, a `CONNECT`) is not
/// answered by Corten's own connection: the answers before it go out, and the connection is
/// hyper's from that request on, with everything the client sent behind it. So a route switches
/// with hyper's `upgrade::on` on both, a body is read by hyper on both, and a client receives the
/// same bytes from both: the answers before in their order, the `101` (or a tunnel's `200`), then
/// the new protocol's bytes, those that came in one write with the request among them. A request
/// with `Upgrade` its route does not take is answered, and so are the requests behind it.
/// Shutdown closes a connection that was handed over and is idle, and lets one that was handed
/// over at a request still being answered finish it.
#[tokio::test]
async fn a_request_that_is_hypers_takes_the_rest_of_its_connection() {
    let entered = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(tokio::sync::Notify::new());
    let app = || {
        let upgrade = crate::router::any(|mut req: Request<Body>| async move {
            relay(&mut req);
            (StatusCode::SWITCHING_PROTOCOLS, [(header::CONNECTION, "upgrade"), (header::UPGRADE, "echo")])
        });
        let tunnel = crate::router::any(|mut req: Request<Body>| async move {
            relay(&mut req);
            StatusCode::OK
        });
        let held = {
            let (entered, release) = (entered.clone(), release.clone());
            crate::router::post(move |body: Bytes| {
                let (entered, release) = (entered.clone(), release.clone());
                async move {
                    entered.fetch_add(1, SeqCst);
                    release.notified().await;
                    format!("held {}", body.len())
                }
            })
        };
        let table = Table::new()
            .route("/", get(|| async { "hi" }))
            .route("/upgrade", upgrade)
            .route("/tunnel", tunnel)
            .route("/held", held)
            .route("/read", crate::router::post(|body: Bytes| async move { format!("read {}", body.len()) }));
        App::new(Routes::from(table))
    };
    let ask = |path: &str| format!("GET {path} HTTP/1.1\r\n{HOST}connection: upgrade\r\nupgrade: echo\r\n\r\n");
    let post = |path: &str, body: &str| format!("POST {path} HTTP/1.1\r\n{HOST}content-length: {}\r\n\r\n{body}", body.len());
    let mut all = Vec::new();
    for own in BOTH {
        let Served { addr, stop, server } = Served::start(app(), own).await;
        let mut got = Vec::new();

        // Two requests, one that switches and bytes of the new protocol, in one write.
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(format!("{GET}{GET}{}behind the head", ask("/upgrade")).as_bytes()).await.unwrap();
        let answers = until(&mut client, "behind the head").await;
        assert_eq!(statuses(&answers), [200, 200, 101], "own: {own}: {answers}");
        assert!(answers.contains("upgrade: echo\r\n") && answers.ends_with("\r\n\r\nbehind the head"), "own: {own}: {answers}");
        client.write_all(b"and more").await.unwrap();
        assert_eq!(until(&mut client, "and more").await, "and more", "own: {own}");
        got.push(answers);
        drop(client);

        // After a request the connection waited for, with the head that switches in two writes.
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(GET.as_bytes()).await.unwrap();
        got.push(one(&mut client).await);
        let head = ask("/upgrade");
        let (start, rest) = head.split_at(40);
        client.write_all(start.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        client.write_all(format!("{rest}tail").as_bytes()).await.unwrap();
        let answer = until(&mut client, "tail").await;
        assert_eq!(statuses(&answer), [101], "own: {own}: {answer}");
        got.push(answer);
        drop(client);

        // A tunnel, behind an answer, with its first bytes in the same write.
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(format!("{GET}CONNECT /tunnel HTTP/1.1\r\n{HOST}\r\nthrough").as_bytes()).await.unwrap();
        let answers = until(&mut client, "through").await;
        assert_eq!(statuses(&answers), [200, 200], "own: {own}: {answers}");
        assert!(!answers[answers.rfind("HTTP/1.1").unwrap()..].contains("content-length"), "own: {own}: {answers}");
        client.write_all(b"the tunnel").await.unwrap();
        assert_eq!(until(&mut client, "the tunnel").await, "the tunnel", "own: {own}");
        got.push(answers);
        drop(client);

        // An `Upgrade` the route does not take, and bodies: answered, and the connection goes on
        // through requests of every kind, hyper's from the second on.
        let mut client = TcpStream::connect(addr).await.unwrap();
        let requests = [GET.to_owned(), ask("/"), GET.to_owned(), post("/read", "hello"), GET.to_owned(), post("/read", "")];
        for request in requests {
            client.write_all(request.as_bytes()).await.unwrap();
            let answer = one(&mut client).await;
            assert!(answer.starts_with("HTTP/1.1 200"), "own: {own}: {answer}");
            got.push(answer);
        }
        // A body in pieces, behind answers that arrived with its head.
        let mut client = TcpStream::connect(addr).await.unwrap();
        let body = "b".repeat(100_000);
        client.write_all(format!("{GET}{GET}{}", &post("/read", &body)[..5_000]).as_bytes()).await.unwrap();
        got.push(several(&mut client, 2).await);
        client.write_all(&post("/read", &body).as_bytes()[5_000..]).await.unwrap();
        let answer = one(&mut client).await;
        assert!(answer.ends_with("read 100000"), "own: {own}: {answer}");
        got.push(answer);
        // hyper reads this one as chunked and closes after it, on both.
        let both = format!("POST /read HTTP/1.1\r\n{HOST}content-length: 5\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n");
        client.write_all(both.as_bytes()).await.unwrap();
        let (answer, closed) = read(&mut client, SOON).await;
        assert!(closed && statuses(&answer) == [200], "own: {own}: {answer}");
        got.push(answer);

        // Shutdown: a connection handed over and idle since is closed, and one handed over at a
        // request still being answered finishes it and says that it closes.
        let mut idle = TcpStream::connect(addr).await.unwrap();
        idle.write_all(ask("/").as_bytes()).await.unwrap();
        got.push(one(&mut idle).await);
        let mut busy = TcpStream::connect(addr).await.unwrap();
        let reached = entered.load(SeqCst);
        busy.write_all(format!("{GET}{}", post("/held", "hello")).as_bytes()).await.unwrap();
        got.push(one(&mut busy).await);
        let wait = tokio::time::timeout(SOON, async {
            while entered.load(SeqCst) == reached {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        });
        wait.await.expect("the handler is reached");
        stop.send(()).unwrap();
        assert_eq!(read(&mut idle, SOON).await, (String::new(), true), "own: {own}");
        assert!(!server.is_finished(), "own: {own}: a request is still being answered");
        release.notify_one();
        let (answer, closed) = read(&mut busy, SOON).await;
        assert!(closed && answer.contains("connection: close\r\n") && answer.ends_with("held 5"), "own: {own}: {answer}");
        got.push(answer);
        tokio::time::timeout(SOON, server).await.expect("shutdown ends").unwrap().unwrap();
        all.push(got.iter().map(|got| dateless(got)).collect::<Vec<_>>());
    }
    assert_eq!(all[1], all[0]);
}

/// hyper keeps a connection whose handler left a request's body unread only if the rest of that
/// body had arrived when the answer was written, so where its reads ended decides whether the
/// requests behind are answered. Corten's own connection reads less at a time than hyper does (a
/// head no further than the app's limit, a first read of [`crate::h1::FIRST`] bytes), so the bytes
/// it hands over can end inside a body that came whole in one write. hyper is given them with
/// what waits in the socket in the same read, and so keeps the connection where it would have
/// had it read the stream itself.
#[tokio::test]
async fn a_body_left_unread_behind_a_head_that_fills_a_read_keeps_its_connection() {
    // The app's limit on a head when it is lower than a first read, and a first read.
    for (limit, read) in [(700, 700), (crate::app::REQUEST_HEAD, crate::h1::FIRST)] {
        let mut all = Vec::new();
        for own in BOTH {
            let served = Served::start(App::new(routes()).max_request_head(limit), own).await;
            let mut got = Vec::new();
            // The head ends in the read's last bytes, so the body is cut by the read's end, at each
            // of its bytes in turn. (A chunk cut inside its data is the cut hyper closes at.)
            for ends in read - 15..=read {
                let head = |framing: &str| {
                    let padded =
                        |pad: usize| format!("POST /unread HTTP/1.1\r\n{HOST}{framing}\r\nx-pad: {}\r\n\r\n", "p".repeat(pad));
                    let head = padded(ends - padded(0).len());
                    assert_eq!(head.len(), ends);
                    head
                };
                let bodies = [("content-length: 5", "hello"), ("transfer-encoding: chunked", "5\r\nhello\r\n0\r\n\r\n")];
                for (framing, body) in bodies {
                    let answers = served.closed(format!("{}{body}{GET}{}", head(framing), last())).await;
                    assert_eq!(
                        statuses(&answers),
                        [200, 200, 200],
                        "own: {own}, limit {limit}, a head of {ends} bytes: {answers}"
                    );
                    got.push(dateless(&answers));
                }
            }
            served.stop().await;
            all.push(got);
        }
        assert_eq!(all[1], all[0], "limit {limit}");
    }
}

/// Where a client's own writes end decides the same thing on both connections, since the request
/// is hyper's on both: a chunk whose data comes in two writes behind a handler that does not read
/// it closes the connection after its answer, and the request behind it is not answered. So what
/// the test above holds is that Corten's own connection adds no such cut, not that there is none.
#[tokio::test]
async fn a_body_left_unread_that_comes_in_two_writes_closes_its_connection_on_both() {
    let mut all = Vec::new();
    for own in BOTH {
        let served = Served::start(App::new(routes()), own).await;
        let mut client = TcpStream::connect(served.addr).await.unwrap();
        let head = format!("{GET}POST /unread HTTP/1.1\r\n{HOST}transfer-encoding: chunked\r\n\r\n5\r\nhe");
        client.write_all(head.as_bytes()).await.unwrap();
        let first = several(&mut client, 2).await;
        client.write_all(format!("llo\r\n0\r\n\r\n{GET}").as_bytes()).await.unwrap();
        let (rest, closed) = read(&mut client, SOON).await;
        assert!(closed && statuses(&first) == [200, 200] && rest.is_empty(), "own: {own}: {first:?} then {rest:?}");
        all.push(dateless(&first));
        served.stop().await;
    }
    assert_eq!(all[1], all[0]);
}

/// `App::header_timeout` holds on both connections: a head the client does not finish, and a
/// connection idle after its answers, are closed when it has passed, counted from when the
/// answers were sent and not from when their requests came; a handler that takes longer is not
/// cut; and a connection handed to hyper is held to it as before.
#[tokio::test]
async fn a_connection_waits_for_a_head_only_as_long_as_the_app_allows() {
    for own in BOTH {
        let served = Served::start(App::new(routes()).header_timeout(Duration::from_millis(300)), own).await;
        let wait = Duration::from_secs(3);
        let (got, closed) = served.within(format!("GET / HTTP/1.1\r\n{HOST}"), wait).await;
        assert_eq!((got.as_str(), closed), ("", true), "own: {own}, an unfinished head");
        let (got, closed) = served.within(GET, wait).await;
        assert!(closed && statuses(&got) == [200], "own: {own}, idle after an answer: {got}");
        let (got, closed) = served.within(format!("{GET}GET / HTTP/1.1\r\nhost: lo"), wait).await;
        assert!(closed && statuses(&got) == [200], "own: {own}, half a head behind an answer: {got}");
        // A handler slower than the timeout, with a request behind it: both are answered, and the
        // connection is closed that long after them.
        let began = std::time::Instant::now();
        let (got, closed) = served.within(format!("GET /slow HTTP/1.1\r\n{HOST}\r\n{GET}"), wait).await;
        assert!(closed && statuses(&got) == [200, 200] && got.ends_with("hi"), "own: {own}, a slow handler: {got}");
        assert!(began.elapsed() >= Duration::from_millis(900), "own: {own}: closed after {:?}", began.elapsed());
        // Handed to hyper at a body, and idle since.
        let post = format!("{GET}POST /read HTTP/1.1\r\n{HOST}content-length: 5\r\n\r\nhello");
        let (got, closed) = served.within(post, wait).await;
        assert!(closed && statuses(&got) == [200, 200] && got.ends_with("read 5"), "own: {own}, after a body: {got}");
        served.stop().await;

        // Without it, an idle connection stays.
        let served = Served::start(App::new(routes()).header_timeout(None), own).await;
        let (got, closed) = served.within(GET, Duration::from_millis(700)).await;
        assert!(!closed && statuses(&got) == [200], "own: {own}, no timeout: {got}");
        served.stop().await;
    }
}

/// `App::send_timeout` holds on both connections: a client that pipelines requests and reads no
/// answer has its connection closed once a write has waited that long, with most of its requests
/// never handled.
#[tokio::test]
async fn a_client_that_pipelines_and_reads_nothing_is_closed_at_the_send_timeout() {
    const REQUESTS: usize = 20_000;
    static PAGE: [u8; 8 * 1024] = [b'p'; 8 * 1024];
    for own in BOTH {
        let handled = Arc::new(AtomicUsize::new(0));
        let handler = {
            let handled = handled.clone();
            move || {
                handled.fetch_add(1, SeqCst);
                async { &PAGE }
            }
        };
        let app = App::new(Routes::from(Table::new().route("/", get(handler)))).send_timeout(Duration::from_millis(300));
        let served = Served::start(app, own).await;
        let (mut reading, mut writing) = TcpStream::connect(served.addr).await.unwrap().into_split();
        let sending = tokio::spawn(async move {
            let _ = writing.write_all(GET.repeat(REQUESTS).as_bytes()).await;
        });
        // Nothing is read until the timeout has passed, well past it.
        tokio::time::sleep(Duration::from_secs(2)).await;
        let stopped = handled.load(SeqCst);
        let mut got = Vec::new();
        let closed = tokio::time::timeout(SOON, async {
            let mut buf = vec![0u8; 64 * 1024];
            while let Ok(read @ 1..) = reading.read(&mut buf).await {
                got.extend_from_slice(&buf[..read]);
            }
        });
        assert!(closed.await.is_ok(), "own: {own}: the connection is closed");
        assert_eq!(handled.load(SeqCst), stopped, "own: {own}: no request is handled once it is");
        assert!(stopped < REQUESTS / 2, "own: {own}: {stopped} requests handled");
        sending.abort();
        served.stop().await;
    }
}

/// A request's deadline holds on both connections: a handler past it is answered 503 with the
/// same bytes, and its connection goes on to the next request.
#[tokio::test]
async fn a_request_is_held_to_its_deadline() {
    let mut answers = Vec::new();
    for own in BOTH {
        let served = Served::start(App::new(routes()).deadline(Duration::from_millis(100)), own).await;
        let got = served.closed(format!("GET /slow HTTP/1.1\r\n{HOST}\r\n{GET}{}", last())).await;
        assert_eq!(statuses(&got), [503, 200, 200], "own: {own}: {got}");
        answers.push(dateless(&got));
        served.stop().await;
    }
    assert_eq!(answers[1], answers[0]);
}

/// A connection keeps one timer for its requests' deadlines on Corten's connection as on hyper's
/// (`docs/design.md#choice-deadline-timer`): none at its first request to wait, made at its
/// second, and taken by each that waits after it. The timer is the connection's task's, so a
/// connection handed to hyper has the one it made, and a request with a body waits on it. It is
/// dropped with the connection.
#[tokio::test]
async fn a_connection_keeps_its_deadlines_timer_and_takes_it_to_hyper() {
    use crate::deadline::{LIVE, TAKEN};
    let app = || {
        let wait = || async {
            tokio::time::sleep(Duration::from_millis(2)).await;
            "waited"
        };
        let read = |body: Bytes| async move {
            tokio::time::sleep(Duration::from_millis(2)).await;
            format!("read {}", body.len())
        };
        let table =
            Table::new().route("/", get(|| async { "hi" })).route("/wait", get(wait)).route("/read", crate::router::post(read));
        App::new(Routes::from(table)).deadline(Duration::from_secs(5))
    };
    let waits = format!("GET /wait HTTP/1.1\r\n{HOST}\r\n");
    let posts = format!("POST /read HTTP/1.1\r\n{HOST}content-length: 5\r\n\r\nhello");
    for own in BOTH {
        let served = Served::start(app(), own).await;
        let (timers, taken) = (LIVE.get(), TAKEN.get());
        let mut client = TcpStream::connect(served.addr).await.unwrap();
        let mut seen = Vec::new();
        // The two with a body are hyper's on either connection, and everything behind them.
        for request in [&waits[..], GET, &waits, &waits, &posts, &posts, GET, &waits] {
            client.write_all(request.as_bytes()).await.unwrap();
            assert_eq!(statuses(&one(&mut client).await), [200], "own: {own}: {request}");
            seen.push((LIVE.get() - timers, TAKEN.get() - taken));
        }
        // How many timers the connection has, and how many of its deadlines have taken one.
        assert_eq!(seen, [(0, 0), (0, 0), (1, 0), (1, 1), (1, 2), (1, 3), (1, 3), (1, 4)], "own: {own}");
        drop(client);
        let dropped = tokio::time::timeout(Duration::from_secs(10), async {
            while LIVE.get() != timers {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        assert!(dropped.await.is_ok(), "own: {own}: the connection's timer is dropped with it");
        served.stop().await;
    }
}

/// `App::max_connections` holds on both connections: a second connection is not served while the
/// first is open, and is once it closes, whether the first is still Corten's own or was handed to
/// hyper.
#[tokio::test]
async fn no_more_connections_are_open_than_the_app_allows() {
    for own in BOTH {
        for handed in [false, true] {
            let served = Served::start(App::new(routes()).header_timeout(None).max_connections(1), own).await;
            let mut held = TcpStream::connect(served.addr).await.unwrap();
            held.write_all(GET.as_bytes()).await.unwrap();
            assert_eq!(statuses(&one(&mut held).await), [200]);
            if handed {
                held.write_all(format!("POST /read HTTP/1.1\r\n{HOST}content-length: 5\r\n\r\nhello").as_bytes()).await.unwrap();
                assert!(one(&mut held).await.ends_with("read 5"));
            }
            let addr = served.addr;
            let second = tokio::spawn(async move {
                let mut client = TcpStream::connect(addr).await.unwrap();
                client.write_all(format!("GET / HTTP/1.1\r\n{HOST}connection: close\r\n\r\n").as_bytes()).await.unwrap();
                read(&mut client, SOON).await
            });
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(!second.is_finished(), "own: {own}, handed: {handed}: a second connection waits while the first is open");
            drop(held);
            let (got, closed) = second.await.unwrap();
            assert!(closed && statuses(&got) == [200], "own: {own}, handed: {handed}: {got}");
            served.stop().await;
        }
    }
}

/// Shutdown reaches a connection whose task has woken many times since it began to wait for it
/// (the own connection's task waits for it once): one that is idle after its requests closes, one
/// that never sent a byte closes, and one whose handler is still at work answers, says that it
/// closes, and closes, as with hyper. A server that is gone without a shutdown closes them too.
#[tokio::test]
async fn shutdown_reaches_a_connection_whose_task_waited_for_it_once() {
    let mut answers = Vec::new();
    for (own, gone) in [(false, false), (true, false), (false, true), (true, true)] {
        let (entered, release) = (Arc::new(AtomicUsize::new(0)), Arc::new(tokio::sync::Notify::new()));
        let slow = {
            let (entered, release) = (entered.clone(), release.clone());
            move || {
                let (entered, release) = (entered.clone(), release.clone());
                async move {
                    entered.fetch_add(1, SeqCst);
                    release.notified().await;
                    "late"
                }
            }
        };
        let routes = Routes::from(Table::new().route("/", get(|| async { "hi" })).route("/slow", get(slow)));
        let Served { addr, stop, server } = Served::start(App::new(routes), own).await;
        let mut idle = TcpStream::connect(addr).await.unwrap();
        let mut busy = TcpStream::connect(addr).await.unwrap();
        let mut silent = TcpStream::connect(addr).await.unwrap();
        for _ in 0..40 {
            for client in [&mut idle, &mut busy] {
                client.write_all(GET.as_bytes()).await.unwrap();
                assert_eq!(statuses(&one(client).await), [200]);
            }
        }
        // A request behind the one being answered when shutdown begins is not answered.
        busy.write_all(format!("GET /slow HTTP/1.1\r\n{HOST}\r\n{GET}").as_bytes()).await.unwrap();
        let reached = tokio::time::timeout(SOON, async {
            while entered.load(SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        });
        reached.await.expect("the handler is reached");
        if gone {
            // The server's future is dropped where it waits, and the word of shutdown with it.
            server.abort();
            for client in [&mut idle, &mut silent, &mut busy] {
                assert_eq!(read(client, SOON).await, (String::new(), true), "own: {own}");
            }
            continue;
        }
        stop.send(()).unwrap();
        for client in [&mut idle, &mut silent] {
            assert_eq!(read(client, SOON).await, (String::new(), true), "own: {own}");
        }
        assert!(!server.is_finished(), "own: {own}: a request is still being answered");
        release.notify_one();
        let (got, closed) = read(&mut busy, SOON).await;
        assert!(closed && statuses(&got) == [200] && got.ends_with("late"), "own: {own}: {got}");
        answers.push(dateless(&got));
        tokio::time::timeout(SOON, server).await.expect("shutdown ends").unwrap().unwrap();
    }
    assert!(answers[0].contains("connection: close"), "{}", answers[0]);
    assert_eq!(answers[1], answers[0]);
}

/// A connection still answering when the grace and its request's deadline have passed is closed
/// and counted, on both connections: shutdown ends then, with the handler never finished.
#[tokio::test]
async fn shutdown_closes_a_connection_still_answering_once_its_time_has_passed() {
    for own in BOTH {
        let stuck = || async {
            std::future::pending::<()>().await;
            "never"
        };
        let table = Table::new().route("/", get(|| async { "hi" })).route("/stuck", get(stuck));
        let app = App::new(Routes::from(table)).deadline(None).shutdown_grace(Duration::from_millis(200));
        let Served { addr, stop, server } = Served::start(app, own).await;
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(format!("{GET}GET /stuck HTTP/1.1\r\n{HOST}\r\n").as_bytes()).await.unwrap();
        assert_eq!(statuses(&one(&mut client).await), [200]);
        tokio::time::sleep(Duration::from_millis(50)).await;
        stop.send(()).unwrap();
        let (got, closed) = read(&mut client, SOON).await;
        assert_eq!((got.as_str(), closed), ("", true), "own: {own}");
        tokio::time::timeout(SOON, server).await.expect("shutdown ends").unwrap().unwrap();
    }
}

/// A small generator of numbers, the same on every run.
pub(super) struct Dice(pub u64);

impl Dice {
    pub(super) fn next(&mut self) -> u64 {
        // SplitMix64.
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut mixed = self.0;
        mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        mixed ^ (mixed >> 31)
    }

    /// A number under `bound`, which is not 0.
    pub(super) fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
}

/// A connection that waits for a request with nothing unread and nothing unsent holds its two
/// buffers with the room its client made them take: what a connection begins with for short
/// requests and short answers, and no more than a bound whatever was read and written before,
/// since a buffer that grew past it is freed as the connection begins to wait. So with the third
/// thing it keeps from one request to the next, the places of a head's lines: room for the few a
/// short request has, and for no more than a bound after a request with a hundred.
#[tokio::test]
async fn a_connection_that_waits_for_a_request_holds_buffers_of_a_bounded_room() {
    use crate::h1::{FIRST, HELD, IDLE, KEPT_READ, LINES_KEPT, OUT_FIRST, OUT_KEPT};
    static LONG: [u8; 40_000] = [b'v'; 40_000];
    let table = Table::new()
        .route("/", get(|| async { "hi" }))
        .route("/wide", get(|| async { ([(header::ETAG, std::str::from_utf8(&LONG).unwrap())], "wide") }));
    let own = Served::start(App::new(Routes::from(table)).max_request_head(1 << 20), true).await;
    let settle = || tokio::time::sleep(Duration::from_millis(50));
    IDLE.set((0, 0, 0));
    let mut clients = Vec::new();
    for _ in 0..8 {
        clients.push(TcpStream::connect(own.addr).await.unwrap());
    }
    // Short requests one at a time, as many as fill the read buffer several times over.
    for _ in 0..60 {
        for client in &mut clients {
            client.write_all(GET.as_bytes()).await.unwrap();
            assert_eq!(statuses(&one(client).await), [200]);
        }
    }
    settle().await;
    let (waits, most, lines) = IDLE.get();
    assert!(waits >= 480, "{waits} waits");
    assert!(most <= FIRST + OUT_FIRST, "{most} bytes of room after short requests");
    assert!((1..=4).contains(&lines), "room for the places of {lines} lines after short requests");
    // Part of a head stays where it is until the rest has come.
    let rest = format!("TP/1.1\r\n{HOST}\r\n");
    for client in &mut clients {
        client.write_all(b"GET / HT").await.unwrap();
    }
    settle().await;
    for client in &mut clients {
        client.write_all(rest.as_bytes()).await.unwrap();
    }
    for client in &mut clients {
        assert_eq!(statuses(&one(client).await), [200]);
    }
    // A read buffer that grew for a long head, and a buffer of answers that grew for one, are
    // not kept at that size.
    HELD.set(0);
    IDLE.set((0, 0, 0));
    let mut dice = Dice(9);
    for round in 0..48 {
        let cookie = "c".repeat(100_000 + dice.below(600_000));
        let long = format!("GET / HTTP/1.1\r\n{HOST}cookie: c={cookie}\r\n\r\n");
        let client = &mut clients[round % 8];
        client.write_all(long.as_bytes()).await.unwrap();
        assert_eq!(statuses(&one(client).await), [200], "round {round}");
    }
    assert!(HELD.get() > 4 * KEPT_READ, "the read buffer grew to {}", HELD.get());
    clients[0].write_all(format!("GET /wide HTTP/1.1\r\n{HOST}\r\n").as_bytes()).await.unwrap();
    let got = one(&mut clients[0]).await;
    assert!(got.len() > 40_000 && got.ends_with("wide"));
    // Nor is the room a head of a hundred lines made the connection take for their places.
    let many = format!("GET / HTTP/1.1\r\n{HOST}{}\r\n", "x-a: 1\r\n".repeat(99));
    for client in &mut clients[..2] {
        client.write_all(many.as_bytes()).await.unwrap();
        assert_eq!(statuses(&one(client).await), [200]);
    }
    settle().await;
    let (waits, most, lines) = IDLE.get();
    assert!(waits >= 51, "{waits} waits");
    assert!(most <= KEPT_READ + OUT_KEPT, "{most} bytes of room after long heads");
    assert!(lines <= LINES_KEPT, "room for the places of {lines} lines after a head of a hundred");
    own.stop().await;
}

/// A read buffer that grew is freed when its connection waits for a request, however little of
/// its room is left behind what was taken of it: a waiting connection keeps none whose
/// allocation is larger than the bound. Input of every length up to 1.3 MB, read as fast as the
/// buffer offers room, with each piece dropped as it is taken or held until the next is.
#[tokio::test]
async fn a_read_buffer_that_grew_is_not_kept_while_its_connection_waits() {
    use crate::h1::{Inbox, FIRST, KEPT_READ};
    let sent = vec![b'b'; 1_300_000];
    let (mut kept, mut grew) = (0, 0);
    for holds in [false, true] {
        for length in (1..sent.len()).step_by(1_499).chain(1..3 * FIRST) {
            let (mut inbox, mut from, mut held) = (Inbox::new(), &sent[..length], None);
            loop {
                let read = std::future::poll_fn(|cx| inbox.poll_fill(&mut from, cx, usize::MAX)).await.unwrap();
                if read == 0 {
                    break;
                }
                grew += usize::from(read > KEPT_READ);
                let piece = inbox.take(inbox.len());
                held = holds.then_some(piece);
            }
            inbox.settle();
            // What was held of it is dropped: the allocation is the buffer's alone.
            drop(held);
            assert!(!inbox.larger_than(KEPT_READ), "{length} bytes read, held: {holds}: {}", inbox.room());
            kept += usize::from(inbox.room() > 0);
        }
    }
    assert!(kept > 2_000 && grew > 1_000, "{kept} buffers kept, {grew} reads past the bound");
}

/// A head that does not end is read in a buffer that grows to the app's limit for a head and
/// not past it, whatever the limit and however fast the bytes come: a megabyte of one header
/// line is held 32 KB at most before it is refused, as hyper holds it.
#[tokio::test]
async fn a_head_that_does_not_end_is_read_in_a_buffer_no_larger_than_the_limit() {
    use crate::h1::{Inbox, HELD};
    let sent = vec![b'h'; 2_000_000];
    for limit in [1usize, 300, 2_048, 5_000, 8_192, 32 * 1024, 40_000, 512 * 1024] {
        let (mut inbox, mut from, mut reads) = (Inbox::new(), &sent[..], 0);
        while inbox.len() < limit {
            let read = std::future::poll_fn(|cx| inbox.poll_fill(&mut from, cx, limit)).await.unwrap();
            assert!(read > 0 && inbox.len() <= limit && inbox.room() <= limit, "limit {limit}: {}", inbox.room());
            reads += 1;
        }
        // Each read is offered twice what the one before filled.
        assert!(reads <= 2 + limit.ilog2(), "limit {limit}: {reads} reads");
    }
    // Over a socket, with the limit an app has unless it sets one.
    let own = Served::start(App::new(Routes::from(Table::new().route("/", get(|| async { "hi" })))), true).await;
    HELD.set(0);
    let (mut reading, mut writing) = TcpStream::connect(own.addr).await.unwrap().into_split();
    let bomb = format!("GET / HTTP/1.1\r\n{HOST}x-long: {}", "v".repeat(1 << 20));
    let sending = tokio::spawn(async move {
        let _ = writing.write_all(bomb.as_bytes()).await;
    });
    // Until the server closes, or resets with the rest of the megabyte unread.
    let mut got = Vec::new();
    let closed = tokio::time::timeout(SOON, reading.read_to_end(&mut got)).await;
    sending.abort();
    let got = String::from_utf8_lossy(&got);
    assert!(closed.is_ok() && statuses(&got) == [431], "{closed:?}: {got}");
    assert!(HELD.get() <= 32 * 1024, "the read buffer grew to {}", HELD.get());
    own.stop().await;
}

/// A head exactly as long as the app's limit, read in reads that each fill what they are
/// offered, leaves the read buffer full, and all of it is the request's. The look for the
/// client's end that follows has no room then, and is given a buffer of a read's worth at the
/// most, not one of twice the head: so while the request is answered the connection holds no
/// more of what its client sent than the limit and a read, at the limit an app has unless it
/// sets one, at one above the most a read is ever offered, and at one below a read. The head's
/// buffer is no larger than the limit and the look's no larger than a read, which at a limit
/// below a read is more than the limit: 4,096 bytes at a limit of 700, what the read behind
/// one that filled its 700 is offered. A head a byte shorter leaves the look its byte of room,
/// and no buffer is made for it.
#[tokio::test(start_paused = true)]
async fn the_look_behind_a_head_as_long_as_the_limit_is_given_a_reads_room() {
    use crate::h1::{HELD, KEPT_READ, LOOKED};
    use std::task::Poll;
    /// Gives a read all it has room for, and waits at the end of what its client sent (the
    /// client stays, and sends no more). Takes every write whole.
    struct Full {
        sent: Vec<u8>,
        read: usize,
        answered: Arc<std::sync::Mutex<Vec<u8>>>,
    }
    impl tokio::io::AsyncRead for Full {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let this = self.get_mut();
            if this.read == this.sent.len() {
                return Poll::Pending;
            }
            let give = (this.sent.len() - this.read).min(buf.remaining());
            buf.put_slice(&this.sent[this.read..this.read + give]);
            this.read += give;
            Poll::Ready(Ok(()))
        }
    }
    impl tokio::io::AsyncWrite for Full {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.answered.lock().unwrap().extend_from_slice(buf);
            Poll::Ready(Ok(buf.len()))
        }
        fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }
    for limit in [700, crate::app::REQUEST_HEAD, 512 * 1024] {
        for shorter in [0, 1] {
            let rest = format!("GET / HTTP/1.1\r\n{HOST}x-long: \r\n\r\n").len();
            let head = format!("GET / HTTP/1.1\r\n{HOST}x-long: {}\r\n\r\n", "v".repeat(limit - shorter - rest));
            assert_eq!(head.len(), limit - shorter);
            let answered = Arc::new(std::sync::Mutex::new(Vec::new()));
            let io = Full { sent: head.into_bytes(), read: 0, answered: answered.clone() };
            let (ending, handled) = (AtomicBool::new(false), Arc::new(AtomicUsize::new(0)));
            HELD.set(0);
            LOOKED.set(0);
            let serving = crate::h1::serve(io, Hi(handled.clone()), limit, &ending);
            // The connection waits for its client's next request, which does not come.
            assert!(tokio::time::timeout(Duration::from_secs(1), serving).await.is_err());
            let answered = String::from_utf8_lossy(&answered.lock().unwrap()).into_owned();
            let name = format!("a limit of {limit}, a head of {}", limit - shorter);
            assert!(handled.load(SeqCst) == 1 && statuses(&answered) == [200], "{name}: {answered}");
            // The larger of the head's buffer and the look's: the limit, or a read where the
            // limit is below one.
            assert!(HELD.get() <= limit.max(KEPT_READ), "{name}: the read buffer had room for {}", HELD.get());
            assert!(LOOKED.get() <= KEPT_READ, "{name}: a buffer of {} was made for the look", LOOKED.get());
            assert_eq!(LOOKED.get() > 0, shorter == 0, "{name}: whether a buffer was made for the look");
            if limit < KEPT_READ {
                // What a limit below a read holds: the head's 700 bytes, and behind a head that
                // filled them a look's buffer of 4,096, which is more than the limit.
                assert_eq!((HELD.get(), LOOKED.get()), if shorter == 0 { (4_096, 4_096) } else { (limit, 0) }, "{name}");
            }
        }
    }
}

/// The future a connection is served in is held by every connection from when it is accepted, so
/// its size is a connection's idle memory. A bound, so that a local held across a wait by
/// mistake shows here.
#[tokio::test]
async fn the_future_a_connection_is_served_in_is_small() {
    crate::h1::SERVE.set(0);
    let own = Served::start(App::new(routes()), true).await;
    let got = own.closed(format!("GET / HTTP/1.1\r\n{HOST}connection: close\r\n\r\n")).await;
    assert_eq!(statuses(&got), [200]);
    let size = crate::h1::SERVE.get();
    assert!((1..=1_024).contains(&size), "{size} bytes");
    own.stop().await;
}

/// A service for a test that drives a connection itself: each request is answered by a function.
struct Does<F>(F);

impl<F: FnMut(Request<Body>) -> Response> tower_service::Service<Request<Body>> for Does<F> {
    type Response = ::http::Response<crate::watch::Answered>;
    type Error = std::convert::Infallible;
    type Future = crate::watch::Answer<std::future::Ready<Result<Response, std::convert::Infallible>>>;

    fn poll_ready(&mut self, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: Request<Body>) -> Self::Future {
        let inner = std::future::ready(Ok((self.0)(req)));
        crate::watch::Answer { inner, watch: None, connect: false }
    }
}

/// Lets the other futures of the test's task run until they wait.
async fn turns() {
    for _ in 0..6 {
        tokio::task::yield_now().await;
    }
}

/// The buffer of answers holds what is unsent and no more, however long its client keeps some of
/// it unsent. A client leaves six kilobytes of answers unread, less than makes the connection
/// wait for it, and from then on takes one answer and sends one request, thousands of times: the
/// buffer is never empty, and it never holds more than a write's worth that has gone in front of
/// a write's worth that has not, with the answer being written. (Before, it was emptied only
/// once all of it had gone, so it held every byte sent since: 144 MB in a review's run of this
/// client.)
#[tokio::test]
async fn the_buffer_of_answers_holds_what_is_unsent_and_no_more() {
    use crate::h1::{FLUSH_AT, OUT};
    const ROUNDS: usize = 3_000;
    let (mut client, server) = tokio::io::duplex(512);
    let (ending, handled) = (AtomicBool::new(false), Arc::new(AtomicUsize::new(0)));
    let serving = crate::h1::serve(server, Hi(handled.clone()), 32 * 1024, &ending);
    let asking = async move {
        client.write_all(GET.as_bytes()).await.unwrap();
        let (mut first, mut buf) = (Vec::new(), [0u8; 256]);
        while !first.ends_with(b"\r\n\r\nhi") {
            let read = client.read(&mut buf).await.unwrap();
            assert!(read > 0, "closed after {:?}", String::from_utf8_lossy(&first));
            first.extend_from_slice(&buf[..read]);
        }
        let each = first.len();
        turns().await;
        OUT.set((0, 0));
        // Answers nobody reads: what the pipe holds, and six kilobytes that stay in the buffer.
        let unread = (512 + 6_000) / each;
        for _ in 0..unread {
            client.write_all(GET.as_bytes()).await.unwrap();
            turns().await;
        }
        let mut answer = vec![0u8; each];
        for _ in 0..ROUNDS {
            client.read_exact(&mut answer).await.unwrap();
            assert!(
                answer.starts_with(b"HTTP/1.1 200 OK\r\n") && answer.ends_with(b"\r\n\r\nhi"),
                "an answer, whole and in its place"
            );
            client.write_all(GET.as_bytes()).await.unwrap();
            turns().await;
        }
        (each, unread)
    };
    let both = async { tokio::join!(serving, asking) };
    let (handed, (each, unread)) = tokio::time::timeout(Duration::from_secs(60), both).await.expect("the client is done");
    assert!(handed.is_none(), "no request here is hyper's");
    assert_eq!(handled.load(SeqCst), 1 + unread + ROUNDS, "every request was answered");
    let (most, room) = OUT.get();
    assert!(most >= 4_000, "answers waited in the buffer for their client: {most} bytes at the most");
    assert!(most < 2 * FLUSH_AT + each, "the buffer held {most} bytes, of answers of {each}");
    assert!(room < 2 * (2 * FLUSH_AT + each), "the buffer had room for {room} bytes");
}

/// Shutdown that begins while an answer streams ends the connection at that answer's end, on both
/// connections: a request that waits behind it is not begun, though it arrived before shutdown
/// did. (Shutdown is asked about once more when an answer is whole, not only before its head is
/// written.)
#[tokio::test]
async fn shutdown_begun_while_an_answer_streams_ends_the_connection_at_that_answer() {
    let mut answers = Vec::new();
    for own in BOTH {
        let (release, begun) = (Arc::new(tokio::sync::Notify::new()), Arc::new(AtomicUsize::new(0)));
        let stream = {
            let release = release.clone();
            move || {
                let release = release.clone();
                async move {
                    let later = async move {
                        release.notified().await;
                        Ok::<_, std::io::Error>(Bytes::from_static(b"later"))
                    };
                    let early = futures_util::stream::iter([Ok(Bytes::from_static(b"early"))]);
                    Body::from_stream(futures_util::StreamExt::chain(early, futures_util::stream::once(later)))
                }
            }
        };
        let behind = {
            let begun = begun.clone();
            move || {
                begun.fetch_add(1, SeqCst);
                async { "hi" }
            }
        };
        let table = Table::new().route("/", get(behind)).route("/events", get(stream));
        let Served { addr, stop, server } = Served::start(App::new(Routes::from(table)), own).await;
        let mut idle = TcpStream::connect(addr).await.unwrap();
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(format!("GET /events HTTP/1.1\r\n{HOST}\r\n{GET}").as_bytes()).await.unwrap();
        let early = until(&mut client, "5\r\nearly\r\n").await;
        assert_eq!(statuses(&early), [200], "own: {own}: {early}");
        stop.send(()).unwrap();
        // Shutdown has reached the connections when the one that waits for a request is closed.
        assert_eq!(read(&mut idle, SOON).await, (String::new(), true), "own: {own}");
        tokio::time::sleep(Duration::from_millis(50)).await;
        release.notify_one();
        let (rest, closed) = read(&mut client, SOON).await;
        assert!(closed, "own: {own}: the connection is closed behind the answer: {rest}");
        assert_eq!(rest, "5\r\nlater\r\n0\r\n\r\n", "own: {own}: the answer is whole, and the last");
        assert_eq!(begun.load(SeqCst), 0, "own: {own}: the request behind it was begun after shutdown had");
        answers.push(dateless(&early) + &rest);
        tokio::time::timeout(SOON, server).await.expect("shutdown ends").unwrap().unwrap();
    }
    assert_eq!(answers[1], answers[0]);
}

/// A handler whose answer's body gives `pieces` and then fails, without waiting.
fn failing(pieces: &'static [&'static [u8]]) -> impl Fn() -> std::future::Ready<Body> + Clone {
    move || {
        let pieces = pieces.iter().map(|piece| Ok(Bytes::from_static(piece)));
        let failure = std::iter::once(Err(std::io::Error::other("the body failed")));
        std::future::ready(Body::from_stream(futures_util::stream::iter(pieces.chain(failure))))
    }
}

/// An answer whose body fails before any of it had to go is not begun, on both connections: the
/// client gets the answers before it, whole, and then the connection is closed, with no status
/// line for an answer it cannot have. So for a body that fails at once, and for one that fails
/// behind pieces that fit a write, the last of them one too large to copy: Corten's connection
/// takes the next piece from a body before it sends a piece that fills its buffer, as hyper does.
#[tokio::test]
async fn an_answer_whose_body_fails_before_any_of_it_went_is_not_begun() {
    static LARGE: [&[u8]; 1] = [&X];
    static BOTH_SIZES: [&[u8]; 2] = [b"first", &X];
    let app = || {
        let table = Table::new()
            .route("/", get(|| async { "hi" }))
            .route("/at-once", get(failing(&[])))
            .route("/behind-a-little", get(failing(&[b"first", b"second"])))
            .route("/behind-a-large-piece", get(failing(&LARGE)))
            .route("/behind-both", get(failing(&BOTH_SIZES)));
        App::new(Routes::from(table))
    };
    let hyper = Served::start(app(), false).await;
    let own = Served::start(app(), true).await;
    for path in ["/at-once", "/behind-a-little", "/behind-a-large-piece", "/behind-both"] {
        for before in [0, 1, 3] {
            let request = format!("{}GET {path} HTTP/1.1\r\n{HOST}\r\n{GET}", GET.repeat(before));
            let (theirs, ours) = (hyper.closed(&request).await, own.closed(&request).await);
            assert_eq!(statuses(&ours), vec![200; before], "{path} behind {before}: {ours:.300}");
            assert!(before == 0 || ours.ends_with("\r\n\r\nhi"), "{path} behind {before}: {ours:.300}");
            assert_eq!(dateless(&ours), dateless(&theirs), "{path} behind {before}");
        }
    }
    hyper.stop().await;
    own.stop().await;
}

/// An answer whose body fails after some of it has gone is cut short, on both connections: the
/// client has its head and the pieces that came before the failure, no end of the body, and a
/// closed connection, and the request behind it is not begun.
#[tokio::test]
async fn an_answer_whose_body_fails_after_some_of_it_went_is_cut_short() {
    let mut answers = Vec::new();
    for own in BOTH {
        let (release, begun) = (Arc::new(tokio::sync::Notify::new()), Arc::new(AtomicUsize::new(0)));
        let stream = {
            let release = release.clone();
            move || {
                let release = release.clone();
                async move {
                    let later = async move {
                        release.notified().await;
                        Err::<Bytes, _>(std::io::Error::other("the body failed"))
                    };
                    let early = futures_util::stream::iter([Ok(Bytes::from_static(b"early"))]);
                    Body::from_stream(futures_util::StreamExt::chain(early, futures_util::stream::once(later)))
                }
            }
        };
        let behind = {
            let begun = begun.clone();
            move || {
                begun.fetch_add(1, SeqCst);
                async { "hi" }
            }
        };
        let table = Table::new().route("/", get(behind)).route("/events", get(stream));
        let served = Served::start(App::new(Routes::from(table)), own).await;
        let mut client = TcpStream::connect(served.addr).await.unwrap();
        client.write_all(format!("GET /events HTTP/1.1\r\n{HOST}\r\n{GET}").as_bytes()).await.unwrap();
        let early = until(&mut client, "5\r\nearly\r\n").await;
        assert_eq!(statuses(&early), [200], "own: {own}: {early}");
        release.notify_one();
        assert_eq!(read(&mut client, SOON).await, (String::new(), true), "own: {own}");
        assert_eq!(begun.load(SeqCst), 0, "own: {own}");
        answers.push(dateless(&early));
        served.stop().await;
    }
    assert_eq!(answers[1], answers[0]);
}

/// A body that panics takes no answer before it with it, on both connections: the answers to the
/// requests that came with its request reach the client whole, and then the connection is closed.
/// (Corten's connection writes the answers to requests that arrived together into one buffer,
/// and that buffer is sent, not dropped, when a body's panic ends the connection.)
///
/// A panic where a body is asked for a piece (`poll_frame`), that is: where a stream runs, and
/// the only place this test has one. A body type of an app's own that panics where it is asked
/// its length or whether it has ended (`size_hint`, `is_end_stream`), or as it is dropped, ends
/// the connection's task on both connections, and on Corten's the answers before it that had not
/// been sent go with it: those calls are not guarded (`crate::h1`, and the guide's list of
/// differences).
#[tokio::test]
async fn a_body_that_panics_takes_no_answer_before_it() {
    let panics = || async {
        let poll = |_: &mut std::task::Context<'_>| -> std::task::Poll<Option<Result<Bytes, std::io::Error>>> {
            panic!("a body panicked, as this test has one do")
        };
        Body::from_stream(futures_util::stream::poll_fn(poll))
    };
    let mut answers = Vec::new();
    for own in BOTH {
        let table = Table::new().route("/", get(|| async { "hi" })).route("/panics", get(panics));
        let served = Served::start(App::new(Routes::from(table)), own).await;
        let got = served.closed(format!("{}GET /panics HTTP/1.1\r\n{HOST}\r\n{GET}", GET.repeat(3))).await;
        assert_eq!(statuses(&got), [200; 3], "own: {own}: {got}");
        assert!(got.ends_with("\r\n\r\nhi"), "own: {own}: {got}");
        // The server is as it was: the next connection is answered.
        let next = served.closed(format!("GET / HTTP/1.1\r\n{HOST}connection: close\r\n\r\n")).await;
        assert_eq!(statuses(&next), [200], "own: {own}");
        answers.push(dateless(&got));
        served.stop().await;
    }
    assert_eq!(answers[1], answers[0]);
}

/// A head that is wrong is refused once the wrong bytes have come, whether or not its end ever
/// does, on both connections. The head here is longer than a first read of Corten's connection
/// and shorter than one of hyper's, so the wrong line comes to Corten's in a second read, behind
/// a part that held no end, where it looks only for an end: it reads what has come before it
/// waits for more, or gives the client up, as hyper reads a head after every read.
#[tokio::test]
async fn a_head_that_is_wrong_is_refused_before_its_end_comes() {
    let hyper = Served::start(App::new(routes()), false).await;
    let own = Served::start(App::new(routes()), true).await;
    let long = format!("GET / HTTP/1.1\r\n{HOST}x-long: {}\r\n", "v".repeat(3_000));
    assert!(long.len() > crate::h1::FIRST && long.len() < 8_192);
    let cases = [
        ("a space in a name", format!("{long}bad name: x\r\n"), 0),
        ("a space in a name, and half the next line", format!("{long}bad name: x\r\nx-a: "), 0),
        ("a control byte in a value", format!("{long}x-a: a\x01b"), 0),
        ("behind an answer", format!("{GET}{long}bad name: x\r\n"), 1),
    ];
    for (name, request, before) in cases {
        for half_closed in [false, true] {
            let mut got = Vec::new();
            for served in [&hyper, &own] {
                let mut client = TcpStream::connect(served.addr).await.unwrap();
                client.write_all(request.as_bytes()).await.unwrap();
                if half_closed {
                    client.shutdown().await.unwrap();
                }
                let (answers, closed) = read(&mut client, SOON).await;
                assert!(closed, "{name}, half closed: {half_closed}: the connection is closed: {answers}");
                got.push(answers);
            }
            let mut expected = vec![200; before];
            expected.push(400);
            assert_eq!(statuses(&got[1]), expected, "{name}, half closed: {half_closed}: {}", got[1]);
            assert_eq!(dateless(&got[1]), dateless(&got[0]), "{name}, half closed: {half_closed}");
        }
    }
    // A head that is right as far as it has come is waited for, and not answered when its client
    // closes its side, on both.
    for served in [&hyper, &own] {
        let mut client = TcpStream::connect(served.addr).await.unwrap();
        client.write_all(format!("{long}x-a: 1\r\n").as_bytes()).await.unwrap();
        assert_eq!(read(&mut client, Duration::from_millis(300)).await, (String::new(), false));
        client.shutdown().await.unwrap();
        assert_eq!(read(&mut client, SOON).await, (String::new(), true));
    }
    // A wrong line that comes after a wait, behind a part that was right, is not looked at until
    // the head's end comes, on both: each looks through an unfinished head again only when its
    // end may have come, and what came later was not in hyper's first read either. (The part
    // before the wait fills a first read of Corten's connection, which alone does not make the
    // bytes behind it ones that came with it.)
    for served in [&hyper, &own] {
        let mut client = TcpStream::connect(served.addr).await.unwrap();
        client.write_all(&long.as_bytes()[..crate::h1::FIRST]).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        client.write_all(format!("{}bad name: x\r\n", &long[crate::h1::FIRST..]).as_bytes()).await.unwrap();
        assert_eq!(read(&mut client, Duration::from_millis(300)).await, (String::new(), false));
        client.write_all(b"\r\n").await.unwrap();
        let (answers, closed) = read(&mut client, SOON).await;
        assert_eq!((statuses(&answers), closed), (vec![400], true), "{answers}");
    }
    hyper.stop().await;
    own.stop().await;
}

/// An answer written after the connection waited for its client to take the one before it says
/// the time it is written at. The thread's `Date` text is brought up to date when a connection's
/// task has waited, and a write that waits for its client is a wait: here for over a second,
/// with the next request already read, behind an answer larger than the pipe.
#[tokio::test]
async fn an_answer_written_after_a_write_waited_says_the_time_it_is_written_at() {
    let (mut client, server) = tokio::io::duplex(512);
    let ending = AtomicBool::new(false);
    let service = Does(|req: Request<Body>| match req.uri().path() {
        "/large" => Response::new(Body::from(vec![b'l'; 100_000])),
        _ => Response::new(Body::from("hi")),
    });
    let serving = crate::h1::serve(server, service, 32 * 1024, &ending);
    let asking = async move {
        client.write_all(format!("GET /large HTTP/1.1\r\n{HOST}\r\n{GET}").as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        let (mut got, mut buf) = (Vec::new(), vec![0u8; 16 * 1024]);
        while !got.ends_with(b"\r\n\r\nhi") {
            let read = client.read(&mut buf).await.unwrap();
            assert!(read > 0, "closed after {} bytes", got.len());
            got.extend_from_slice(&buf[..read]);
        }
        String::from_utf8(got).unwrap()
    };
    let both = async { tokio::join!(serving, asking) };
    let (_, got) = tokio::time::timeout(Duration::from_secs(30), both).await.expect("both answers");
    let dates: Vec<&str> = got.match_indices("date: ").map(|(at, _)| &got[at + 6..at + 35]).collect();
    assert_eq!((statuses(&got), dates.len()), (vec![200, 200], 2), "{got:.300}");
    assert_ne!(dates[1], dates[0], "the second answer was written over a second after the first");
}

/// An IO that gives what the client sent a few bytes a read and takes what the server writes a
/// few bytes a write, waiting now and then, in one buffer or in several, and fails a write once
/// it has taken `fails_at` bytes. What it took is in `output`.
struct Chopped {
    input: Vec<u8>,
    at: usize,
    output: Arc<std::sync::Mutex<Vec<u8>>>,
    dice: Dice,
    /// The most a read gives and a write takes.
    most: usize,
    vectored: bool,
    fails_at: Option<usize>,
}

impl Chopped {
    fn amount(&mut self, of: usize) -> usize {
        of.min(1 + self.dice.below(self.most))
    }

    /// One time in four: not now, and the task is woken to ask again.
    fn waits(&mut self, cx: &mut std::task::Context<'_>) -> bool {
        let waits = self.dice.below(4) == 0;
        if waits {
            cx.waker().wake_by_ref();
        }
        waits
    }

    fn takes(&mut self, cx: &mut std::task::Context<'_>, bufs: &[&[u8]]) -> std::task::Poll<std::io::Result<usize>> {
        if self.waits(cx) {
            return std::task::Poll::Pending;
        }
        let mut left = self.amount(bufs.iter().map(|buf| buf.len()).sum());
        let mut output = self.output.lock().unwrap();
        if self.fails_at.is_some_and(|at| output.len() + left > at) {
            return std::task::Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()));
        }
        let took = left;
        for buf in bufs {
            let part = left.min(buf.len());
            output.extend_from_slice(&buf[..part]);
            left -= part;
        }
        std::task::Poll::Ready(Ok(took))
    }
}

impl tokio::io::AsyncRead for Chopped {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = self.get_mut();
        // At the end of what the client sent, its side is closed.
        if this.at < this.input.len() {
            if this.waits(cx) {
                return std::task::Poll::Pending;
            }
            let give = this.amount((this.input.len() - this.at).min(buf.remaining()));
            buf.put_slice(&this.input[this.at..this.at + give]);
            this.at += give;
        }
        std::task::Poll::Ready(Ok(()))
    }
}

impl tokio::io::AsyncWrite for Chopped {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        self.get_mut().takes(cx, &[buf])
    }

    fn poll_write_vectored(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let bufs: Vec<&[u8]> = bufs.iter().map(|buf| &**buf).collect();
        self.get_mut().takes(cx, &bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.vectored
    }

    fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

/// A handoff follows the answers before it however the socket takes them: a byte a write or
/// thousands, with waits between, in one buffer or in several. When the connection is given back
/// for hyper, every answer before the request that is hyper's has gone, whole, and what hyper
/// will read is that request and what came behind it, each byte once. And where a write fails,
/// at any byte of those answers, the connection is over and is not handed to hyper.
#[tokio::test]
async fn a_handoff_follows_the_answers_before_it_however_the_socket_takes_them() {
    let theirs = format!("POST /read HTTP/1.1\r\n{HOST}content-length: 5\r\n\r\nhello{GET}");
    let serve = |sent: String, most: usize, vectored: bool, fails_at: Option<usize>, seed: u64| async move {
        let output = Arc::new(std::sync::Mutex::new(Vec::new()));
        let io = Chopped { input: sent.into_bytes(), at: 0, output: output.clone(), dice: Dice(seed), most, vectored, fails_at };
        let (ending, handled) = (AtomicBool::new(false), Arc::new(AtomicUsize::new(0)));
        let serving = crate::h1::serve(io, Hi(handled.clone()), 32 * 1024, &ending);
        let handed =
            tokio::time::timeout(Duration::from_secs(30), serving).await.expect("the connection ends, or is handed over");
        let answers = String::from_utf8(output.lock().unwrap().clone()).unwrap();
        (handed, answers, handled.load(SeqCst))
    };
    let mut dice = Dice(31);
    let (mut each, mut most_sent) = (0, 0);
    for round in 0..300u64 {
        let before = dice.below(600);
        let (most, vectored) = ([1, 3, 17, 300, 5_000, 40_000][round as usize % 6], round % 2 == 0);
        let (handed, answers, handled) = serve(GET.repeat(before) + &theirs, most, vectored, None, round).await;
        let name = format!("round {round}: {before} requests before, writes of {most} at most");
        let (io, read, _service) = handed.unwrap_or_else(|| panic!("{name}: the connection is hyper's"));
        assert_eq!(handled, before, "{name}: no request that is hyper's reached the service");
        assert_eq!(statuses(&answers), vec![200; before], "{name}");
        assert!(before == 0 || answers.ends_with("\r\n\r\nhi"), "{name}: the last answer before it is whole");
        each = each.max(answers.len() / before.max(1));
        most_sent = most_sent.max(answers.len());
        let mut given = Vec::new();
        crate::h1::Rewound::new(io, read).read_to_end(&mut given).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&given), theirs, "{name}");
    }
    // Long enough runs of answers to fill the buffer, and to give other tasks a turn.
    assert!(each > 0 && most_sent > 2 * crate::h1::FLUSH_AT, "{most_sent} bytes of answers at the most");
    let before = 12;
    for fails_at in (0..before * each).step_by(7).chain([before * each - 1]) {
        for most in [1, 40, 5_000] {
            let (handed, answers, handled) =
                serve(GET.repeat(before) + &theirs, most, fails_at % 2 == 0, Some(fails_at), 5).await;
            let name = format!("a write fails at byte {fails_at}, writes of {most} at most");
            assert!(handed.is_none(), "{name}: the connection is not handed over");
            assert!(answers.len() <= fails_at && handled <= before, "{name}: {} bytes written", answers.len());
        }
    }
}

/// A head that comes a byte a read is not copied whole for each read: the buffer it is read in
/// makes room in steps that grow with what it holds, so a head of 250,000 bytes under a limit an
/// app raised to 256 KiB is moved to a larger allocation a few times, and each of its bytes
/// copied a few times at the most. (Before, room for half a read more was made once the head was
/// longer than half a read, in a new allocation of just that size, at every read from there on:
/// about 249,000 allocations and 31 GB copied for this head, which a client could have a server
/// do for the price of sending it slowly.)
#[tokio::test]
async fn a_head_that_comes_a_byte_a_read_is_copied_a_bounded_number_of_times() {
    use crate::h1::MOVED;
    let head = format!("GET / HTTP/1.1\r\n{HOST}x-long: {}\r\n\r\n", "v".repeat(250_000));
    let output = Arc::new(std::sync::Mutex::new(Vec::new()));
    // With the start of another request behind it: a request with nothing behind it but its
    // client's end is not answered.
    let (input, dice) = (format!("{head}GET ").into_bytes(), Dice(3));
    let io = Chopped { input, at: 0, output: output.clone(), dice, most: 1, vectored: true, fails_at: None };
    let (ending, handled) = (AtomicBool::new(false), Arc::new(AtomicUsize::new(0)));
    MOVED.set((0, 0));
    let serving = crate::h1::serve(io, Hi(handled.clone()), 256 * 1024, &ending);
    let handed = tokio::time::timeout(Duration::from_secs(300), serving).await.expect("the head is read and answered");
    assert!(handed.is_none(), "no request here is hyper's");
    let answers = String::from_utf8(output.lock().unwrap().clone()).unwrap();
    assert_eq!((handled.load(SeqCst), statuses(&answers)), (1, vec![200]), "{answers}");
    let (moves, copied) = MOVED.get();
    assert!(moves >= 4, "the head outgrew its buffer: {moves} moves");
    assert!(moves <= 32, "a head of {} bytes was moved {moves} times", head.len());
    assert!(copied <= 4 * head.len(), "{copied} bytes were copied for a head of {}", head.len());
}

/// Shutdown that begins while the answers before a request that is hyper's wait for their client
/// ends the connection when they have gone: the request is not handed to hyper to begin, as a
/// request found behind an answer is not begun once shutdown has.
#[tokio::test]
async fn shutdown_begun_before_a_handoff_ends_the_connection_at_the_answers_before_it() {
    const BEFORE: usize = 10;
    let (mut client, server) = tokio::io::duplex(512);
    let (ending, handled) = (AtomicBool::new(false), Arc::new(AtomicUsize::new(0)));
    let serving = crate::h1::serve(server, Hi(handled.clone()), 32 * 1024, &ending);
    let asking = async {
        let theirs = format!("POST /read HTTP/1.1\r\n{HOST}content-length: 5\r\n\r\nhello");
        client.write_all((GET.repeat(BEFORE) + &theirs).as_bytes()).await.unwrap();
        // The answers are more than the pipe holds: the connection waits for its client to take
        // them, with the request that is hyper's read behind them.
        turns().await;
        ending.store(true, SeqCst);
        let (mut got, mut buf) = (Vec::new(), [0u8; 4096]);
        loop {
            match client.read(&mut buf).await.unwrap() {
                0 => break,
                read => got.extend_from_slice(&buf[..read]),
            }
        }
        String::from_utf8(got).unwrap()
    };
    let both = async { tokio::join!(serving, asking) };
    let (handed, got) = tokio::time::timeout(Duration::from_secs(30), both).await.expect("the connection is closed");
    assert_eq!(statuses(&got), [200; BEFORE], "{got}");
    assert!(handed.is_none(), "the connection is over, and not hyper's");
    assert_eq!(handled.load(SeqCst), BEFORE);
}

/// An answer's trailers are not sent, and the `Trailer` line that would announce them is not
/// written: the two lines of the difference the guide lists, and nothing else of the answer.
/// hyper writes the line, and sends the trailers to a client that asked for them (`TE: trailers`).
#[tokio::test]
async fn an_answers_trailers_are_dropped_and_its_trailer_line_with_them() {
    struct Trailed(u8);
    impl http_body::Body for Trailed {
        type Data = Bytes;
        type Error = std::io::Error;

        fn poll_frame(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
            self.0 += 1;
            std::task::Poll::Ready(match self.0 {
                1 => Some(Ok(http_body::Frame::data(Bytes::from_static(b"body")))),
                2 => {
                    let mut trailers = ::http::HeaderMap::new();
                    trailers.insert("x-t", ::http::HeaderValue::from_static("1"));
                    Some(Ok(http_body::Frame::trailers(trailers)))
                }
                _ => None,
            })
        }
    }
    let app = || {
        let trailed = || async { ([(header::TRAILER, "x-t")], Body::new(Trailed(0))) };
        App::new(Routes::from(Table::new().route("/", get(|| async { "hi" })).route("/trailed", get(trailed))))
    };
    let hyper = Served::start(app(), false).await;
    let own = Served::start(app(), true).await;
    for asks in ["", "te: trailers\r\n"] {
        let request = format!("GET /trailed HTTP/1.1\r\n{HOST}{asks}\r\n{GET}GET / HTTP/1.1\r\n{HOST}connection: close\r\n\r\n");
        let (theirs, ours) = (hyper.closed(&request).await, own.closed(&request).await);
        assert_eq!(statuses(&ours), [200, 200, 200], "asks {asks:?}: the connection goes on: {ours}");
        assert!(!ours.contains("trailer") && !ours.contains("x-t"), "asks {asks:?}: {ours}");
        assert!(ours.contains("\r\n\r\n4\r\nbody\r\n0\r\n\r\nHTTP/1.1 200 OK\r\n"), "asks {asks:?}: {ours}");
        assert!(theirs.contains("trailer: x-t\r\n"), "asks {asks:?}: hyper announces them: {theirs}");
        assert_eq!(
            theirs.contains("0\r\nx-t: 1\r\n\r\n"),
            !asks.is_empty(),
            "asks {asks:?}: hyper sends them if asked: {theirs}"
        );
        let without = theirs.replace("trailer: x-t\r\n", "").replace("0\r\nx-t: 1\r\n\r\n", "0\r\n\r\n");
        assert_eq!(dateless(&ours), dateless(&without), "asks {asks:?}");
    }
    hyper.stop().await;
    own.stop().await;
}

/// A client that has closed its side by the time the connection comes to a request of its is not
/// answered that request, on both connections, however quick the handler: hyper looks for the
/// client's end when it has read a head with nothing behind it, before it asks the handler, and
/// Corten's connection looks there too. The requests before that one, read with it behind them,
/// are answered, and their answers reach the client. (The first request's handler waits here, so
/// the client's end has come when the last request's turn does; a client that stays is answered
/// every request. A request that comes with its client's end, and no wait, is `h1_fuzz`'s
/// `a_request_that_comes_with_its_clients_end_is_answered_by_neither`.)
#[tokio::test]
async fn a_request_whose_client_has_closed_its_side_by_its_turn_is_not_answered() {
    let slow = format!("GET /slow HTTP/1.1\r\n{HOST}\r\n");
    let mut answers = Vec::new();
    for own in BOTH {
        let begun = Arc::new(AtomicUsize::new(0));
        let quick = {
            let begun = begun.clone();
            move || {
                let begun = begun.clone();
                async move {
                    begun.fetch_add(1, SeqCst);
                    "hi"
                }
            }
        };
        let wait = || async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            "slow"
        };
        let table = Table::new().route("/", get(quick)).route("/slow", get(wait));
        let served = Served::start(App::new(Routes::from(table)), own).await;
        for behind in 1..=3 {
            begun.store(0, SeqCst);
            let mut client = TcpStream::connect(served.addr).await.unwrap();
            client.write_all(format!("{slow}{}", GET.repeat(behind)).as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            client.shutdown().await.unwrap();
            let (got, closed) = read(&mut client, SOON).await;
            assert!(closed, "own: {own}, {behind} behind: the connection is closed: {got}");
            assert_eq!(statuses(&got), vec![200; behind], "own: {own}, {behind} behind: {got}");
            assert_eq!(begun.load(SeqCst), behind - 1, "own: {own}, {behind} behind: the last handler is not asked");
            answers.push(dateless(&got));
        }
        begun.store(0, SeqCst);
        let mut client = TcpStream::connect(served.addr).await.unwrap();
        client.write_all(format!("{slow}{GET}").as_bytes()).await.unwrap();
        let got = several(&mut client, 2).await;
        assert_eq!((statuses(&got), begun.load(SeqCst)), (vec![200, 200], 1), "own: {own}, a client that stays: {got}");
        served.stop().await;
    }
    assert_eq!(answers[3..], answers[..3]);
}

/// The 500 a connection sends in place of an interim answer (a handler answered with a `1xx`,
/// which cannot be an answer) has none of that answer's headers, on both connections: hyper's
/// drops them all, and so does Corten's. So a caching header the handler or a middleware put on
/// it does not reach a failure the connection made, which nothing above the connection could
/// mark as never shared (`tests::cache::corten_makes_its_failures_through_the_constructors_that_mark_them`
/// lists it for that reason).
#[tokio::test]
async fn the_500_in_place_of_an_interim_answer_has_none_of_the_answer_s_headers() {
    let shared = || async {
        let cached = |name: &'static str| (::http::HeaderName::from_static(name), "public, max-age=60");
        (
            StatusCode::PROCESSING,
            [cached("cache-control"), cached("cdn-cache-control"), cached("surrogate-control")],
            "not an answer",
        )
    };
    let mut answers = Vec::new();
    for own in BOTH {
        let served = Served::start(App::new(Routes::from(Table::new().route("/interim", get(shared)))), own).await;
        let got = served.closed(format!("GET /interim HTTP/1.1\r\n{HOST}\r\n")).await;
        assert_eq!(statuses(&got), [500], "own: {own}: {got}");
        let lines: Vec<&str> = got.lines().skip(1).take_while(|line| !line.is_empty()).collect();
        let names: Vec<&str> = lines.iter().filter_map(|line| line.split(':').next()).collect();
        assert_eq!(names, ["content-length", "date"], "own: {own}: {got}");
        answers.push(dateless(&got));
        served.stop().await;
    }
    assert_eq!(answers[1], answers[0]);
}

/// A header name longer than `http` takes one (65,535 bytes), which a head can hold only under a
/// limit an app raised past 64 KiB, is refused by both connections as hyper refuses it: with
/// 431, as a head too long, though the head is shorter than the app's limit (hyper's
/// `record_header_indices` refuses a name of 64 KiB before it makes a `HeaderName` of it). A
/// name of the longest length is taken by both. (Corten's connection answered 400 before: it
/// refused the name where `HeaderName` did.)
#[tokio::test]
async fn a_header_name_longer_than_http_takes_is_refused_as_hyper_refuses_it() {
    let app = || App::new(routes()).max_request_head(128 * 1024);
    let hyper = Served::start(app(), false).await;
    let own = Served::start(app(), true).await;
    let named = |length: usize| format!("GET / HTTP/1.1\r\n{HOST}{}: 1\r\n\r\n", "n".repeat(length));
    for before in [0, 2] {
        let longer = GET.repeat(before) + &named(65_536);
        let (theirs, ours) = (hyper.closed(&longer).await, own.closed(&longer).await);
        let mut expected = vec![200; before];
        expected.push(431);
        assert_eq!(statuses(&theirs), expected, "hyper's, behind {before}: {theirs}");
        assert_eq!(dateless(&ours), dateless(&theirs), "behind {before}");
    }
    let longest = named(65_535) + &last();
    let (theirs, ours) = (hyper.closed(&longest).await, own.closed(&longest).await);
    assert_eq!(statuses(&ours), [200, 200], "{ours}");
    assert_eq!(dateless(&ours), dateless(&theirs));
    hyper.stop().await;
    own.stop().await;
}

/// The names `h1::head` takes by their bytes, each in the two spellings it takes them in: all
/// lower case, and the capitals a browser writes.
const USUAL_NAMES: &[(&str, &str)] = &[
    ("host", "Host"),
    ("user-agent", "User-Agent"),
    ("accept", "Accept"),
    ("accept-language", "Accept-Language"),
    ("accept-encoding", "Accept-Encoding"),
    ("connection", "Connection"),
    ("cookie", "Cookie"),
    ("referer", "Referer"),
    ("upgrade-insecure-requests", "Upgrade-Insecure-Requests"),
    ("if-none-match", "If-None-Match"),
    ("sec-fetch-site", "Sec-Fetch-Site"),
    ("sec-fetch-mode", "Sec-Fetch-Mode"),
    ("sec-fetch-dest", "Sec-Fetch-Dest"),
    ("sec-fetch-user", "Sec-Fetch-User"),
    ("sec-ch-ua", "Sec-CH-UA"),
    ("sec-ch-ua-mobile", "Sec-CH-UA-Mobile"),
    ("sec-ch-ua-platform", "Sec-CH-UA-Platform"),
    ("priority", "Priority"),
    ("corten", "Corten"),
];

/// The request Corten's connection makes of `head`, a whole head, scanned as the connection
/// scans one.
fn built(head: &str) -> Result<crate::h1::head::Head, crate::h1::head::Refusal> {
    let bytes = Bytes::copy_from_slice(head.as_bytes());
    let mut indices = Vec::new();
    let scanned = crate::h1::head::scan(&bytes, 64 * 1024, &mut indices)?.expect("a whole head");
    assert_eq!(scanned.len, bytes.len(), "{head:?} is one head");
    crate::h1::head::build(&bytes, scanned, &indices, &mut None)
}

/// A head's lines as a request's map holds them: each name's text and each value, in the map's
/// order.
fn lines(headers: &::http::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| (name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned()))
        .collect()
}

/// Every name the connection takes by its bytes, in both spellings it takes and in two it leaves
/// to `http` (upper case and mixed), and names it does not take, those close to one it does
/// included, is the `HeaderName` `http` makes of it: equal to it, with its text, and found in the
/// map by it, so a request reads as it did when `HeaderName::from_bytes` made every name.
#[test]
fn a_header_name_is_the_one_http_makes_of_it_however_it_is_spelled() {
    let mixed = |name: &str| -> String {
        name.chars().enumerate().map(|(at, c)| if at % 2 == 1 { c.to_ascii_uppercase() } else { c }).collect()
    };
    let mut names: Vec<String> = Vec::new();
    for (lower, capitals) in USUAL_NAMES {
        names.extend([lower.to_string(), capitals.to_string(), lower.to_ascii_uppercase(), mixed(lower)]);
    }
    let others = [
        "x-a",
        "X-Trace-Number",
        "origin",
        "Origin",
        "cache-control",
        "Cache-Control",
        "pragma",
        "if-modified-since",
        "content-type",
        "Content-Type",
        "Sec-Fetch-Sit",
        "sec-fetch-sites",
        "Sec-Ch-Ua",
        "sec-ch-ua-model",
        "hosts",
        "Hos",
        "corten-page",
    ];
    names.extend(others.map(str::to_owned));
    for name in names {
        let head = built(&format!("GET / HTTP/1.1\r\n{name}: v\r\n\r\n")).ok().expect(&name);
        let made = ::http::HeaderName::from_bytes(name.as_bytes()).unwrap();
        let (got, value) = head.parts.headers.iter().next().expect(&name);
        assert_eq!(got, &made, "{name}");
        assert_eq!(got.as_str(), made.as_str(), "{name}");
        assert_eq!(value, "v", "{name}");
        assert_eq!(head.parts.headers.get(&made), Some(value), "{name}");
        assert_eq!(head.parts.headers.len(), 1, "{name}");
    }
}

/// A name `http` has no `HeaderName` for is refused where the connection makes the request (400),
/// as before, those that differ from a name the connection takes by its bytes by one byte
/// included. On a socket `httparse` refuses each of these first; here the head's places are given
/// as `scan` gives them, so the refusal read is `build`'s own.
#[test]
fn a_header_name_http_refuses_is_refused() {
    use crate::h1::head::{build, Refusal, Scanned};
    let refused = [
        "",
        "x a",
        "x\0a",
        "x(a)",
        "caf\u{e9}",
        "Host ",
        " Host",
        "host\t",
        "Sec-Fetch-Site\0",
        "sec-ch-ua:",
        "Accept\r",
        "user agent",
        "Corten\u{7f}",
    ];
    for name in refused {
        assert!(::http::HeaderName::from_bytes(name.as_bytes()).is_err(), "{name:?}");
        let request = "GET / HTTP/1.1\r\n";
        let bytes = Bytes::from(format!("{request}{name}: v\r\n\r\n"));
        let (at, end) = (request.len(), request.len() + name.len());
        let scanned = Scanned { len: bytes.len(), method: ::http::Method::GET, target: (4, 5), http11: true, hypers: false };
        let made = build(&bytes, scanned, &[(at, end, end + 2, end + 3)], &mut None);
        assert!(matches!(made, Err(Refusal::Bad)), "{name:?}");
    }
}

/// The heads three browsers sent over HTTP/1.1 (Playwright 1.65.1's Chromium, Firefox and WebKit:
/// a navigation, and the fetch Corten's runtime makes for one), with a line of each sent twice,
/// once in each spelling the connection takes, are made into the request `http`'s own
/// constructors make of their lines: every line in its order, with its value, and the connection
/// kept.
#[test]
fn a_browsers_head_is_made_into_the_request_it_was_before() {
    let chromium = [
        "Host: localhost",
        "Connection: keep-alive",
        "sec-ch-ua: \"Chromium\";v=\"142\", \"Not_A Brand\";v=\"99\"",
        "sec-ch-ua-mobile: ?0",
        "sec-ch-ua-platform: \"Linux\"",
        "Upgrade-Insecure-Requests: 1",
        "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Sec-Fetch-Site: same-origin",
        "Sec-Fetch-Mode: navigate",
        "Sec-Fetch-User: ?1",
        "Sec-Fetch-Dest: document",
        "Referer: http://localhost/",
        "Accept-Encoding: gzip, deflate, br, zstd",
        "Accept-Language: en-US,en;q=0.9",
        "Cookie: a=1",
        "If-None-Match: \"v1\"",
    ];
    let firefox_fetch = [
        "Host: localhost",
        "User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
        "Accept: */*",
        "Accept-Language: en-US,en;q=0.5",
        "Accept-Encoding: gzip, deflate, br, zstd",
        "Referer: http://localhost/",
        "corten: nav",
        "Connection: keep-alive",
        "Cookie: a=1",
        "Sec-Fetch-Dest: empty",
        "Sec-Fetch-Mode: cors",
        "Sec-Fetch-Site: same-origin",
        "Priority: u=4",
    ];
    let webkit = [
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Upgrade-Insecure-Requests: 1",
        "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
        "Accept-Encoding: gzip, deflate",
        "Accept-Language: en-US,en;q=0.9",
        "Connection: keep-alive",
        "Host: localhost",
        "Sec-Fetch-Dest: document",
        "Sec-Fetch-Mode: navigate",
        "Sec-Fetch-Site: none",
    ];
    // Each line again, last, in the other spelling the connection takes, and once more as `http`
    // alone reads it, in upper case.
    let twice = |sent: &[&str]| -> Vec<String> {
        let mut all: Vec<String> = sent.iter().map(|line| line.to_string()).collect();
        for line in sent {
            let (name, value) = line.split_once(':').unwrap();
            let other = USUAL_NAMES.iter().find_map(|(lower, capitals)| match name {
                _ if name == *lower => Some(*capitals),
                _ if name == *capitals => Some(*lower),
                _ => None,
            });
            all.push(format!("{}:{value}", other.expect(name)));
            all.push(format!("{}:{value}", name.to_ascii_uppercase()));
        }
        all
    };
    for head in [twice(&chromium[..]), twice(&firefox_fetch[..]), twice(&webkit[..])] {
        let mut made = ::http::HeaderMap::new();
        for line in &head {
            let (name, value) = line.split_once(':').unwrap();
            let name = ::http::HeaderName::from_bytes(name.as_bytes()).unwrap();
            made.append(name, ::http::HeaderValue::from_str(value.trim_start()).unwrap());
        }
        let got = built(&format!("GET / HTTP/1.1\r\n{}\r\n\r\n", head.join("\r\n"))).ok().expect("taken");
        assert_eq!(lines(&got.parts.headers), lines(&made), "{head:?}");
        assert!(got.keep_alive, "{head:?}");
    }
}

/// The names that decide what becomes of a request and its connection are read in any spelling
/// as before: `Content-Length`, `Transfer-Encoding`, `Expect` and `Upgrade` make it hyper's
/// (`scan`, by the name's bytes and no `HeaderName`), and `Connection` is read for keep-alive
/// (`build`, by the `HeaderName` made of it).
#[test]
fn the_names_that_frame_a_request_or_its_connection_are_read_in_any_spelling() {
    let spell = |name: &str| [name.to_owned(), name.to_ascii_uppercase(), name[..1].to_ascii_uppercase() + &name[1..]];
    for name in ["content-length", "Content-Length", "transfer-encoding", "Transfer-Encoding", "expect", "upgrade"]
        .iter()
        .flat_map(|name| spell(name))
    {
        let bytes = format!("GET / HTTP/1.1\r\n{HOST}{name}: 0\r\n\r\n");
        let scanned = crate::h1::head::scan(bytes.as_bytes(), 64 * 1024, &mut Vec::new()).ok().flatten().expect(&name);
        assert!(scanned.hypers, "{name}");
    }
    for name in ["connection", "Connection", "CONNECTION", "cOnNeCtIoN"] {
        let closes = built(&format!("GET / HTTP/1.1\r\n{HOST}{name}: close\r\n\r\n")).ok().expect(name);
        assert!(!closes.keep_alive, "{name}");
        let keeps = built(&format!("GET / HTTP/1.0\r\n{HOST}{name}: keep-alive\r\n\r\n")).ok().expect(name);
        assert!(keeps.keep_alive, "{name}");
        let alone = built(&format!("GET / HTTP/1.0\r\n{HOST}\r\n")).ok().expect(name);
        assert!(!alone.keep_alive, "{name}");
    }
}

/// A connection over an IO of the app's own (the step `serve_wrapped` takes), one that holds what
/// it is written and gives it to the socket as it is flushed, as a TLS stream does, is handed to
/// hyper as a plain one is: requests with a body, behind requests without and in front of them,
/// are each answered once and in order, with the bytes hyper's connection answers, in one write
/// and one request at a time.
///
/// This is a stand-in and not TLS: the crate has no TLS library among its dependencies, those of
/// its tests included, so a handoff under a real TLS stream has no test here
/// (`docs/design.md#choice-own-http1` lists one among what would make the connection the default).
#[tokio::test]
async fn a_connection_over_a_wrapped_io_is_handed_to_hyper_as_a_plain_one_is() {
    let post = format!("POST /read HTTP/1.1\r\n{HOST}content-length: 5\r\n\r\nhello");
    let mut answers = Vec::new();
    for own in BOTH {
        let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
        let addr = listeners[0].local_addr().unwrap();
        let step = |tcp: TcpStream| std::future::ready(Ok::<_, std::convert::Infallible>((super::server::Held::unseen(tcp), ())));
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(crate::app::run(listeners, step, App::new(routes()).own_http1(own), async {
            let _ = stopped.await;
        }));
        let mut got = Vec::new();
        // In one write: the answers of Corten's connection are behind the stand-in's flush when
        // the connection becomes hyper's, and hyper's when it is closed.
        let mut client = TcpStream::connect(addr).await.unwrap();
        let sent = format!("{GET}GET /stream HTTP/1.1\r\n{HOST}\r\n{post}{GET}{post}{}", last());
        client.write_all(sent.as_bytes()).await.unwrap();
        let (all, closed) = read(&mut client, SOON).await;
        assert!(closed, "own: {own}: the connection is closed: {all:.300}");
        assert_eq!(statuses(&all), [200; 6], "own: {own}: {all:.300}");
        assert_eq!(all.matches("\r\n\r\nread 5").count(), 2, "own: {own}: each body was read once");
        got.push(dateless(&all));
        // One request at a time: a request without a body, the one that makes the connection
        // hyper's, and one of each behind it.
        let mut client = TcpStream::connect(addr).await.unwrap();
        for request in [GET, post.as_str(), GET, post.as_str()] {
            client.write_all(request.as_bytes()).await.unwrap();
            let answer = one(&mut client).await;
            assert_eq!(statuses(&answer), [200], "own: {own}: {answer}");
            got.push(dateless(&answer));
        }
        answers.push(got);
        let _ = stop.send(());
        tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
    }
    assert_eq!(answers[1], answers[0]);
}
