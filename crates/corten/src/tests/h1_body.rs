//! Request bodies on Corten's own HTTP/1.1 connection ([`crate::h1::body`], [`App::own_http1`]):
//! every test here sends the same bytes to one app served by hyper's connection and by Corten's
//! own, over pipes in memory with tokio's time paused, says what each must answer, and, but for
//! the one rule on which the two are meant to differ, holds them to the same bytes. `h1_fuzz`
//! sends bodies made at random to both.

use super::h1::{dateless, find};
use super::h1_fuzz::{answers, exchange, serve_app, Outcome, Piped, Stream, QUIET, WIDE};
use super::*;
use bytes::Bytes;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

type Connect = tokio::sync::mpsc::UnboundedSender<DuplexStream>;

/// What a task that outlives its handler read of a body.
type Log = Arc<Mutex<Vec<String>>>;

/// The limit on a request's head these tests give an app, unless they say another: it is the
/// limit on a body's trailers too, on both connections.
const HEAD: usize = 32 * 1024;

/// A body read to its end a frame at a time, as text, and whether it failed. `hints`: what the
/// body says of its length and of its end before each frame, and each frame's length.
async fn frames(mut body: Body, hints: bool) -> (String, bool) {
    use std::fmt::Write;
    let (mut said, mut bytes, mut trailers) = (String::new(), 0, Vec::new());
    loop {
        if hints {
            let hint = http_body::Body::size_hint(&body);
            let _ = write!(said, "[{}..{:?} {}]", hint.lower(), hint.upper(), http_body::Body::is_end_stream(&body));
        }
        match body.frame().await {
            None => return (format!("{said}body={bytes} trailers={trailers:?}"), false),
            Some(Err(error)) => return (format!("{said}failed after {bytes}: {error}"), true),
            Some(Ok(frame)) => match frame.into_data() {
                Ok(data) => {
                    bytes += data.len();
                    if hints {
                        let _ = write!(said, "{} ", data.len());
                    }
                }
                Err(frame) => {
                    let map = frame.into_trailers().unwrap_or_default();
                    trailers.extend(map.iter().map(|(name, value)| format!("{name}={}", String::from_utf8_lossy(value.as_bytes()))));
                }
            },
        }
    }
}

/// What the app is given of a request's framing: its `Content-Length` and `Transfer-Encoding`
/// lines, its body's length and its trailers; a 400 where the body fails.
async fn framing(req: Request<Body>) -> (StatusCode, String) {
    let (parts, body) = req.into_parts();
    let values = |name: &str| {
        let values = parts.headers.get_all(name).iter();
        values.map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned()).collect::<Vec<_>>()
    };
    let (read, failed) = frames(body, false).await;
    let status = if failed { StatusCode::BAD_REQUEST } else { StatusCode::OK };
    (status, format!("cl={:?} te={:?} {read}", values("content-length"), values("transfer-encoding")))
}

async fn hints(req: Request<Body>) -> String {
    frames(req.into_body(), true).await.0
}

/// The first frame of the body, and no more of it.
async fn first(body: &mut Body) -> String {
    match body.frame().await {
        Some(Ok(frame)) => format!("first {}", frame.data_ref().map_or(0, Bytes::len)),
        Some(Err(error)) => format!("first failed: {error}"),
        None => "first none".to_owned(),
    }
}

/// An app whose routes do with a body each thing a handler does with one.
fn app(log: &Log) -> App {
    use crate::router::any;
    let moment = || tokio::time::sleep(Duration::from_millis(3));
    let long = || tokio::time::sleep(Duration::from_secs(10));
    let late = {
        let log = log.clone();
        move |req: Request<Body>| {
            let log = log.clone();
            async move {
                tokio::spawn(async move {
                    let read = frames(req.into_body(), false).await.0;
                    log.lock().unwrap().push(read);
                });
                StatusCode::ACCEPTED
            }
        }
    };
    let panics = |req: Request<Body>| async move {
        let mut body = req.into_body();
        let read = body.frame().await.is_some();
        assert!(!read, "the handler panics with its body half read");
        "no body"
    };
    let table = Table::new()
        .route("/", get(|| async { "hi" }))
        .route("/seen", get(|| async { "seen" }))
        .route("/read", any(|body: Bytes| async move { format!("read {}", body.len()) }))
        .route("/unread", any(|| async { "unread" }))
        .route("/framing", any(framing))
        .route("/hints", any(hints))
        .route("/first", any(|req: Request<Body>| async move { first(&mut req.into_body()).await }))
        // The first piece, then a moment with the body held, and then the answer.
        .route(
            "/first-held",
            any(move |req: Request<Body>| async move {
                let mut body = req.into_body();
                let read = first(&mut body).await;
                moment().await;
                drop(body);
                read
            }),
        )
        // The first piece, the body dropped, and the answer a moment later.
        .route(
            "/first-wait",
            any(move |req: Request<Body>| async move {
                let read = first(&mut req.into_body()).await;
                moment().await;
                read
            }),
        )
        // The first piece, and then no answer for a long time, with the body held.
        .route(
            "/first-long",
            any(move |req: Request<Body>| async move {
                let mut body = req.into_body();
                let read = first(&mut body).await;
                long().await;
                drop(body);
                read
            }),
        )
        .route(
            "/drop-wait",
            any(move |req: Request<Body>| async move {
                drop(req);
                moment().await;
                "dropped"
            }),
        )
        // No answer for a long time, with the body held and never asked for a piece.
        .route(
            "/hold",
            any(move |req: Request<Body>| async move {
                long().await;
                drop(req);
                "held"
            }),
        )
        .route("/echo", any(|req: Request<Body>| async move { Body::from_stream(req.into_body().into_data_stream()) }))
        .route("/late", any(late))
        .route("/panic", any(panics))
        .route(
            "/read-wait",
            any(move |body: Bytes| async move {
                long().await;
                format!("read {}", body.len())
            }),
        )
        .route(
            "/wait",
            any(move || async move {
                long().await;
                "waited"
            }),
        );
    App::new(Routes::from(table))
}

/// hyper's connection and Corten's own for one app, each with a log of its own.
struct Pair {
    hyper: Connect,
    own: Connect,
    logs: [Log; 2],
}

fn pair_of(change: impl Fn(App) -> App, head: usize) -> Pair {
    let logs = [Log::default(), Log::default()];
    Pair {
        hyper: serve_app(change(app(&logs[0])), false, head),
        own: serve_app(change(app(&logs[1])), true, head),
        logs,
    }
}

fn pair() -> Pair {
    pair_of(|app| app, HEAD)
}

impl Pair {
    /// What each does with `writes`, sent a millisecond apart, and then with one more request if
    /// it has not closed: hyper's, then Corten's own.
    async fn send(&self, writes: &[&str], closes: bool) -> (Outcome, Outcome) {
        let stream = Stream { index: 0, writes: writes.iter().map(|write| write.as_bytes().to_vec()).collect(), closes, pipe: WIDE };
        (exchange(&self.hyper, &stream).await, exchange(&self.own, &stream).await)
    }

    /// [`dialogue`] with each: hyper's, then Corten's own.
    async fn talk(&self, writes: &[&str]) -> (Told, Told) {
        (dialogue(&self.hyper, writes).await, dialogue(&self.own, writes).await)
    }
}

/// The status of each answer a server sent before the last request, with whether the app made it,
/// and whether it answered the last request: it kept the connection.
fn did(outcome: &Outcome) -> (Vec<(u16, bool)>, bool) {
    let before = answers(&outcome.before.0).iter().map(|answer| (answer.status, answer.apps)).collect();
    (before, !outcome.closed && !answers(&outcome.after.0).is_empty())
}

/// What a server did, in a line: each answer's status line and body, whether it says the
/// connection closes, and whether the connection closed.
fn brief(outcome: &Outcome) -> String {
    let line = |sent: &[u8]| {
        let sent = String::from_utf8_lossy(sent).into_owned();
        let each = sent.split("HTTP/1.").skip(1).map(|answer| {
            let status = answer.get(2..5).unwrap_or("");
            let says = if answer.contains("\r\nconnection: close\r\n") { " (says close)" } else { "" };
            let body = answer.split_once("\r\n\r\n").map_or("", |(_, body)| body);
            format!("{status}{says} {body:?}")
        });
        each.collect::<Vec<_>>().join(", ")
    };
    let closed = if outcome.closed { "closed" } else { "kept" };
    format!("[{}] {closed}, then [{}]", line(&outcome.before.0), line(&outcome.after.0))
}

/// The cases of a table that came out wrong, so that one run names every one of them.
#[derive(Default)]
struct Wrong(Vec<String>);

impl Wrong {
    fn unless(&mut self, right: bool, what: impl FnOnce() -> String) {
        if !right {
            self.0.push(what());
        }
    }

    fn none(self) {
        assert!(self.0.is_empty(), "{} wrong:\n{}", self.0.len(), self.0.join("\n"));
    }
}

/// What is expected of a server for one request.
#[derive(Clone, Copy, Debug)]
enum Does {
    /// The app answers 200 and the connection goes on.
    Answers,
    /// The app answers 200 and the connection is closed.
    AnswersAndCloses,
    /// The server refuses the head with this status, and closes.
    Refuses(u16),
    /// The app answers 400, its body having failed, and the connection is closed.
    Fails,
}

impl Does {
    fn did(self) -> (Vec<(u16, bool)>, bool) {
        match self {
            Does::Answers => (vec![(200, true)], true),
            Does::AnswersAndCloses => (vec![(200, true)], false),
            Does::Refuses(status) => (vec![(status, false)], false),
            Does::Fails => (vec![(400, true)], false),
        }
    }
}

/// What a server has sent after each write of a client that waits for it to go quiet before the
/// next, without its dates, and whether it had closed the connection by the end.
type Told = (Vec<String>, bool);

async fn dialogue(connect: &Connect, writes: &[&str]) -> Told {
    let (client, server) = tokio::io::duplex(WIDE);
    connect.send(server).expect("the server is listening");
    let (mut reading, mut client) = tokio::io::split(client);
    let received = Arc::new(Mutex::new((Vec::new(), false)));
    let reader = {
        let received = received.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let read = reading.read(&mut buf).await;
                let mut received = received.lock().unwrap();
                match read {
                    Ok(0) | Err(_) => break received.1 = true,
                    Ok(read) => received.0.extend_from_slice(&buf[..read]),
                }
            }
        })
    };
    let (mut told, mut had) = (Vec::new(), 0);
    for write in writes {
        let _ = client.write_all(write.as_bytes()).await;
        tokio::time::sleep(QUIET).await;
        let received = received.lock().unwrap();
        told.push(dateless(&String::from_utf8_lossy(&received.0[had..])));
        had = received.0.len();
    }
    let closed = received.lock().unwrap().1;
    reader.abort();
    (told, closed)
}

const POST: &str = "POST /framing HTTP/1.1\r\nhost: localhost\r\n";
const CHUNKED: &str = "transfer-encoding: chunked\r\n";
const HELLO: &str = "5\r\nhello\r\n0\r\n\r\n";

/// How a request frames its body, in its head: every line a client can say it with, and get it
/// wrong with. Both connections read a head's framing by the same rules (hyper 1.12's
/// `Server::parse`), so each case is one expectation and the same bytes from both. RFC 9112,
/// section 6.3: a `Transfer-Encoding` whose last coding is `chunked` frames the body, whatever
/// `Content-Length` says, and the connection is closed behind the answer; one whose last coding
/// is not `chunked` is a 400; a `Content-Length` that is not one number, or two that differ, is a
/// 400; and on HTTP/1.0 a `Transfer-Encoding` is a 400.
#[tokio::test(start_paused = true)]
async fn a_bodys_framing_is_read_from_its_head_as_hyper_reads_it() {
    let pair = pair();
    let length = |value: &str| format!("{POST}content-length: {value}\r\n\r\nhello");
    let coded = |lines: &str| format!("{POST}{lines}\r\n{HELLO}");
    let cases: Vec<(&str, String, Does, &str)> = vec![
        ("a length", length("5"), Does::Answers, "cl=[\"5\"] te=[] body=5"),
        ("a length with zeros before it", length("005"), Does::Answers, "cl=[\"005\"] te=[] body=5"),
        // The same length twice is one length, and the app is given one line.
        ("a length twice", format!("{POST}content-length: 5\r\ncontent-length: 5\r\n\r\nhello"), Does::Answers, "cl=[\"5\"]"),
        ("a length twice, written two ways", format!("{POST}content-length: 5\r\ncontent-length: 05\r\n\r\nhello"), Does::Answers, "cl=[\"5\"]"),
        ("two lengths", format!("{POST}content-length: 5\r\ncontent-length: 6\r\n\r\nhello"), Does::Refuses(400), ""),
        ("a list of lengths", length("5, 5"), Does::Refuses(400), ""),
        ("a list of lengths without a space", length("5,5"), Does::Refuses(400), ""),
        ("a length with a plus sign", length("+5"), Does::Refuses(400), ""),
        ("a length below zero", length("-5"), Does::Refuses(400), ""),
        ("a length with a space in it", length("5 5"), Does::Refuses(400), ""),
        ("a length in hexadecimal", length("0x5"), Does::Refuses(400), ""),
        ("a length with a fraction", length("5.0"), Does::Refuses(400), ""),
        ("an empty length", length(""), Does::Refuses(400), ""),
        ("a length that is not a number", length("five"), Does::Refuses(400), ""),
        ("a length past 64 bits", length("18446744073709551616"), Does::Refuses(400), ""),
        // hyper keeps the two largest numbers for meanings of its own, and says 431 for them.
        ("the largest length of 64 bits", length("18446744073709551615"), Does::Refuses(431), ""),
        ("the largest but one", length("18446744073709551614"), Does::Refuses(431), ""),
        ("chunked", coded(CHUNKED), Does::Answers, "cl=[] te=[\"chunked\"] body=5"),
        ("chunked, in capitals", coded("Transfer-Encoding: CHUNKED\r\n"), Does::Answers, "te=[\"CHUNKED\"] body=5"),
        // Chunks frame the body, the length is not given to the app, and the connection closes.
        (
            "a length, then chunked",
            coded("content-length: 5\r\ntransfer-encoding: chunked\r\n"),
            Does::AnswersAndCloses,
            "cl=[] te=[\"chunked\"] body=5",
        ),
        (
            "chunked, then a length",
            coded("transfer-encoding: chunked\r\ncontent-length: 5\r\n"),
            Does::AnswersAndCloses,
            "cl=[] te=[\"chunked\"] body=5",
        ),
        ("chunked, then a length that is no number", coded("transfer-encoding: chunked\r\ncontent-length: x\r\n"), Does::AnswersAndCloses, "cl=[]"),
        ("a length that is no number, then chunked", coded("content-length: x\r\ntransfer-encoding: chunked\r\n"), Does::Refuses(400), ""),
        // A coding before `chunked` is not undone: the app is given the chunks' bytes as sent.
        ("gzip, then chunked", coded("transfer-encoding: gzip, chunked\r\n"), Does::Answers, "te=[\"gzip, chunked\"] body=5"),
        ("chunked twice", coded("transfer-encoding: chunked, chunked\r\n"), Does::Answers, "body=5"),
        ("gzip and chunked on two lines", coded("transfer-encoding: gzip\r\ntransfer-encoding: chunked\r\n"), Does::Answers, "body=5"),
        ("chunked and gzip on two lines", coded("transfer-encoding: chunked\r\ntransfer-encoding: gzip\r\n"), Does::Refuses(400), ""),
        ("gzip alone", coded("transfer-encoding: gzip\r\n"), Does::Refuses(400), ""),
        ("chunked, then gzip", coded("transfer-encoding: chunked, gzip\r\n"), Does::Refuses(400), ""),
        ("identity", coded("transfer-encoding: identity\r\n"), Does::Refuses(400), ""),
        ("chunked and an empty coding", coded("transfer-encoding: chunked,\r\n"), Does::Refuses(400), ""),
        ("chunked with a parameter", coded("transfer-encoding: chunked;q=1\r\n"), Does::Refuses(400), ""),
        ("a coding that ends in chunked", coded("transfer-encoding: x-chunked\r\n"), Does::Refuses(400), ""),
        ("an empty coding", coded("transfer-encoding:\r\n"), Does::Refuses(400), ""),
        (
            "chunked on HTTP/1.0",
            format!("POST /framing HTTP/1.0\r\nhost: localhost\r\n{CHUNKED}\r\n{HELLO}"),
            Does::Refuses(400),
            "",
        ),
        // A body on a method that defines none is read as on any other: the head frames it.
        ("a body on GET", length("5").replacen("POST", "GET", 1), Does::Answers, "body=5"),
        ("a body on DELETE", length("5").replacen("POST", "DELETE", 1), Does::Answers, "body=5"),
        ("a body on OPTIONS", coded(CHUNKED).replacen("POST", "OPTIONS", 1), Does::Answers, "body=5"),
        ("a body on HEAD", length("5").replacen("POST", "HEAD", 1), Does::Answers, ""),
    ];
    crate::h1::BODIES.set(0);
    let mut wrong = Wrong::default();
    for (name, request, does, says) in cases {
        let (theirs, ours) = pair.send(&[&request], false).await;
        let said = String::from_utf8_lossy(&theirs.before.0).contains(says);
        wrong.unless(did(&theirs) == does.did() && said, || format!("hyper's, {name}: {}", brief(&theirs)));
        wrong.unless(ours == theirs, || format!("{name}: {} where hyper's {}", brief(&ours), brief(&theirs)));
    }
    wrong.none();
    // The bodies were read by Corten's connection, not handed to hyper with theirs.
    assert_eq!(crate::h1::BODIES.get(), 16, "the bodies Corten's connection read: every one of a request that was answered");
}

/// An HTTP/1.0 request with a body is read as any other, and its connection ends with it.
#[tokio::test(start_paused = true)]
async fn an_http_1_0_request_with_a_body_is_read_and_ends_its_connection() {
    let pair = pair();
    let (theirs, ours) = pair.send(&["POST /framing HTTP/1.0\r\ncontent-length: 5\r\n\r\nhello"], false).await;
    assert!(find(&theirs.before.0, b"HTTP/1.0 200 OK").is_some() && theirs.closed, "{theirs:?}");
    assert!(find(&theirs.before.0, b"body=5").is_some(), "{theirs:?}");
    assert_eq!(ours, theirs);
}

/// A chunked body is read by both connections to the same end, and what is wrong in one fails
/// its body at the same place: the app's read of it fails (a 400 here), and the connection is
/// closed behind the answer. RFC 9112, section 7.1: a chunk's size is hexadecimal digits and
/// nothing else, and each line ends in CRLF. What hyper takes that the grammar does not is taken
/// here too (the first cases): none of them moves the body's end for any reader.
#[tokio::test(start_paused = true)]
async fn a_chunked_body_is_read_and_refused_as_hyper_does() {
    let pair = pair();
    let sent = |body: &str| format!("{POST}{CHUNKED}\r\n{body}");
    let extended = |bytes: usize| format!("1;{}\r\nx\r\n0\r\n\r\n", "e".repeat(bytes));
    let trailed = |bytes: usize| format!("0\r\na: {}\r\n\r\n", "v".repeat(bytes));
    let lined = |lines: usize| format!("0\r\n{}\r\n", "a: b\r\n".repeat(lines));
    let cases: Vec<(&str, String, Does, &str)> = vec![
        ("one chunk", HELLO.to_owned(), Does::Answers, "body=5 trailers=[]"),
        ("two chunks", "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n".to_owned(), Does::Answers, "body=11"),
        ("no chunk", "0\r\n\r\n".to_owned(), Does::Answers, "body=0"),
        ("sizes in both cases", "A\r\n0123456789\r\na\r\n0123456789\r\n0\r\n\r\n".to_owned(), Does::Answers, "body=20"),
        ("an extension", "5;ext=1\r\nhello\r\n0;last\r\n\r\n".to_owned(), Does::Answers, "body=5"),
        ("an extension with a quoted value", "5;ext=\"a b\"\r\nhello\r\n0\r\n\r\n".to_owned(), Does::Answers, "body=5"),
        ("a space behind a size", "5 \r\nhello\r\n0\r\n\r\n".to_owned(), Does::Answers, "body=5"),
        ("a tab and an extension behind a size", "5\t;x\r\nhello\r\n0\r\n\r\n".to_owned(), Does::Answers, "body=5"),
        ("zeros before a size", "00000000000000000005\r\nhello\r\n00\r\n\r\n".to_owned(), Does::Answers, "body=5"),
        // A size line has no limit of its own on either: neither counts these, and neither keeps
        // them (`what_a_body_makes_the_connection_hold_is_bounded`).
        ("more zeros before a size than extensions may be", format!("{}5\r\nhello\r\n0\r\n\r\n", "0".repeat(20_000)), Does::Answers, "body=5"),
        ("more spaces behind a size than extensions may be", format!("5{}\r\nhello\r\n0\r\n\r\n", " ".repeat(20_000)), Does::Answers, "body=5"),
        ("a trailer","5\r\nhello\r\n0\r\nx-t: 1\r\n\r\n".to_owned(), Does::Answers, "body=5 trailers=[\"x-t=1\"]"),
        // A trailer is not a header of the request: one named as a framing line frames nothing.
        (
            "trailers named as headers that frame",
            "5\r\nhello\r\n0\r\ncontent-length: 9\r\ntransfer-encoding: gzip\r\nhost: other\r\n\r\n".to_owned(),
            Does::Answers,
            "cl=[] te=[\"chunked\"] body=5 trailers=[\"content-length=9\", \"transfer-encoding=gzip\", \"host=other\"]",
        ),
        ("extensions of a byte under the limit", extended(16 * 1024 - 1), Does::Answers, "body=1"),
        ("trailers of a byte under the limit", trailed(HEAD - 8), Does::Answers, "body=0"),
        ("a hundred trailers", lined(100), Does::Answers, "body=0"),
        ("a size with a plus sign", "+5\r\nhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("a size below zero", "-5\r\nhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("a size behind a space", " 5\r\nhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("a size with 0x", "0x5\r\nhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("a size that is no digit", "z\r\nhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("no size", "\r\nhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("a size and a second number", "5 5\r\nhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("a size past 64 bits", "10000000000000000\r\nhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("a bare LF behind a size", "5\nhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("a bare CR behind a size", "5\rhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("a bare LF in an extension", "5;a\nhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("a bare CR in an extension", "5;a\rb\r\nhello\r\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 0"),
        ("a bare LF behind a chunk", "5\r\nhello\n0\r\n\r\n".to_owned(), Does::Fails, "failed after 5"),
        ("a bare CR behind a chunk", "5\r\nhello\r0\r\n\r\n".to_owned(), Does::Fails, "failed after 5"),
        ("a chunk longer than its size", "5\r\nhelloXX0\r\n\r\n".to_owned(), Does::Fails, "failed after 5"),
        ("a bare LF behind the last chunk's size", "5\r\nhello\r\n0\n\r\n".to_owned(), Does::Fails, "failed after 5"),
        ("a bare CR for the last line", "5\r\nhello\r\n0\r\n\rX".to_owned(), Does::Fails, "failed after 5"),
        ("a bare CR in a trailer", "5\r\nhello\r\n0\r\na: b\rc: d\r\n\r\n".to_owned(), Does::Fails, "failed after 5"),
        ("a trailer with a space before its colon", "5\r\nhello\r\n0\r\nx-t : 1\r\n\r\n".to_owned(), Does::Fails, "failed after 5"),
        ("a trailer that is folded", "5\r\nhello\r\n0\r\nx-t: 1\r\n more\r\n\r\n".to_owned(), Does::Fails, "failed after 5"),
        ("a trailer with no colon", "5\r\nhello\r\n0\r\nx-t\r\n\r\n".to_owned(), Does::Fails, "failed after 5"),
        ("extensions at the limit", extended(16 * 1024), Does::Fails, "failed after 0"),
        ("trailers at the limit", trailed(HEAD - 7), Does::Fails, "failed after 0"),
        ("a hundred and one trailers", lined(101), Does::Fails, "failed after 0"),
    ];
    let mut wrong = Wrong::default();
    for (name, body, does, says) in cases {
        let (theirs, ours) = pair.send(&[&sent(&body)], false).await;
        let said = String::from_utf8_lossy(&theirs.before.0).contains(says);
        wrong.unless(did(&theirs) == does.did() && said, || format!("hyper's, {name}: {}", brief(&theirs)));
        wrong.unless(ours == theirs, || format!("{name}: {} where hyper's {}", brief(&ours), brief(&theirs)));
        // A body that fails says so in hyper's words on both.
        if matches!(does, Does::Fails) {
            let words = find(&ours.before.0, b": error reading a body from connection").is_some();
            wrong.unless(words, || format!("{name}: {}", brief(&ours)));
        }
    }
    wrong.none();
}

/// The one rule on which the two differ: an LF with no CR before it among a body's trailers.
/// hyper reads a trailer to the next CR and hands what it gathered to `httparse`, which takes a
/// bare LF for a line end; so to hyper `0\r\na: b\n\r\n` is not a whole body, and it reads on
/// through the next request, to that request's empty line, and gives the app the first trailer
/// alone. The request behind the body is never answered: it was read as trailers. A proxy in
/// front that takes a bare LF for a line end, as many parsers do, takes the body to end at that
/// `\n\r\n` and sends the next client's request behind it; hyper would answer the one after that
/// in its place. Corten's connection fails the body at the LF: the app's read fails, and the
/// connection is closed behind its answer, with nothing behind the body read.
#[tokio::test(start_paused = true)]
async fn a_bare_lf_among_the_trailers_fails_the_body_where_hyper_reads_on() {
    let pair = pair();
    let get = "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    for trailers in ["a: b\n\r\n", "\n", "a: b\nc: d\r\n\r\n", "a: b\r\n\n"] {
        let request = format!("{POST}{CHUNKED}\r\n5\r\nhello\r\n0\r\n{trailers}{get}");
        let (theirs, ours) = pair.send(&[&request], false).await;
        // Corten's: the body fails, nothing behind it is answered, and the connection closes.
        assert_eq!(did(&ours), Does::Fails.did(), "{trailers:?}: {ours:?}");
        assert!(find(&ours.before.0, b"failed after 5").is_some(), "{trailers:?}: {ours:?}");
        // hyper's: no answer to the `GET`, which it read as trailers: of the two requests sent,
        // one is answered at the most.
        let all = [&theirs.before.0[..], &theirs.after.0[..]].concat();
        assert!(find(&all, b"\r\n\r\nhi").is_none(), "hyper's, {trailers:?}: {theirs:?}");
        assert!(answers(&theirs.before.0).len() <= 1, "hyper's, {trailers:?}: {theirs:?}");
    }
    // What hyper makes of the first: one request, with one trailer, where two were sent.
    let request = format!("{POST}{CHUNKED}\r\n5\r\nhello\r\n0\r\na: b\n\r\n{get}");
    let (theirs, _) = pair.send(&[&request], false).await;
    assert!(find(&theirs.before.0, b"body=5 trailers=[\"a=b\"]").is_some(), "{theirs:?}");
    assert_eq!(did(&theirs), Does::Answers.did(), "{theirs:?}");
}

/// `Expect: 100-continue` (RFC 9110, section 10.1.1), as hyper's server does it: the client is
/// told to go on when the app first asks for the body, and only then, and never once the answer
/// has begun; an app that answers without reading tells it nothing but its answer, and the
/// connection closes unless the body was sent anyway. An expectation of anything else is not one.
#[tokio::test(start_paused = true)]
async fn a_client_that_expects_to_be_told_is_told_when_the_app_asks_for_the_body() {
    let pair = pair();
    let head = |path: &str, lines: &str| format!("POST {path} HTTP/1.1\r\nhost: localhost\r\n{lines}expect: 100-continue\r\n\r\n");
    let get = "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    const GO_ON: &str = "HTTP/1.1 100 Continue\r\n\r\n";

    // The app reads: told to go on, and answered when the body has come. The connection goes on.
    let (theirs, ours) = pair.talk(&[&head("/read", "content-length: 5\r\n"), "hello", get]).await;
    assert_eq!(theirs.0[0], GO_ON, "hyper's");
    assert!(theirs.0[1].starts_with("HTTP/1.1 200 OK") && theirs.0[1].ends_with("read 5"), "hyper's: {theirs:?}");
    assert!(theirs.0[2].ends_with("hi") && !theirs.1, "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);

    // A chunked body, the same.
    let (theirs, ours) = pair.talk(&[&head("/read", CHUNKED), HELLO, get]).await;
    assert_eq!(theirs.0[0], GO_ON, "hyper's");
    assert!(theirs.0[1].ends_with("read 5") && theirs.0[2].ends_with("hi"), "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);

    // The app does not read: its answer and nothing else, and the connection is closed, since
    // the body that was not sent cannot be told from the next request.
    let (theirs, ours) = pair.talk(&[&head("/unread", "content-length: 5\r\n"), "hello"]).await;
    assert!(theirs.0[0].starts_with("HTTP/1.1 200 OK") && theirs.0[0].ends_with("unread"), "hyper's: {theirs:?}");
    assert!(!theirs.0[0].contains("100 Continue") && theirs.0[1].is_empty() && theirs.1, "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);

    // The body came with the head, and the app reads: told all the same, then answered.
    let whole = head("/read", "content-length: 5\r\n") + "hello";
    let (theirs, ours) = pair.talk(&[&whole, get]).await;
    assert!(theirs.0[0].starts_with(GO_ON) && theirs.0[0].ends_with("read 5"), "hyper's: {theirs:?}");
    assert!(theirs.0[1].ends_with("hi"), "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);

    // The body came with the head, and the app does not read: not told, and the connection goes
    // on where the body ends in the one piece read past (a length), and not where it does not
    // (chunks, whose last line is a piece of its own).
    let (theirs, ours) = pair.talk(&[&(head("/unread", "content-length: 5\r\n") + "hello"), get]).await;
    assert!(!theirs.0[0].contains("100 Continue") && theirs.0[1].ends_with("hi"), "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);
    let (theirs, ours) = pair.talk(&[&(head("/unread", CHUNKED) + HELLO), get]).await;
    assert!(!theirs.0[0].contains("100 Continue") && theirs.0[1].is_empty() && theirs.1, "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);

    // No body to wait for: not told.
    let (theirs, ours) = pair.talk(&[&head("/read", "content-length: 0\r\n"), get]).await;
    assert!(theirs.0[0].starts_with("HTTP/1.1 200 OK") && theirs.0[0].ends_with("read 0"), "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);
    let (theirs, ours) = pair.talk(&[&head("/read", ""), get]).await;
    assert!(theirs.0[0].starts_with("HTTP/1.1 200 OK"), "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);

    // An HTTP/1.0 client is not told: an interim answer is HTTP/1.1's.
    let old = "POST /read HTTP/1.0\r\ncontent-length: 5\r\nexpect: 100-continue\r\n\r\n";
    let (theirs, ours) = pair.talk(&[old, "hello"]).await;
    assert!(theirs.0[0].is_empty() && theirs.0[1].starts_with("HTTP/1.0 200 OK"), "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);

    // An expectation of something else is not this one, and the body is read without a word.
    let other = "POST /read HTTP/1.1\r\nhost: localhost\r\ncontent-length: 5\r\nexpect: nonsense\r\n\r\n";
    let (theirs, ours) = pair.talk(&[other, "hello"]).await;
    assert!(theirs.0[0].is_empty() && theirs.0[1].ends_with("read 5"), "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);

    // An answer that has begun before the app asks for the body is not interrupted to tell the
    // client to go on: here the answer's body is the request's, read as it is written.
    let (theirs, ours) = pair.talk(&[&head("/echo", "content-length: 5\r\n"), "hello", get]).await;
    assert!(theirs.0[0].starts_with("HTTP/1.1 200 OK") && !theirs.0[0].contains("100 Continue"), "hyper's: {theirs:?}");
    assert!(theirs.0[1].contains("hello"), "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);
}

/// A body the handler dropped before its end. hyper's rule, which is Corten's too: the
/// connection goes on only if the body ends in the next piece, read without a wait, behind the
/// one hyper has ready for the app (it reads a piece ahead whenever it runs with none ready);
/// otherwise it is closed behind the answer, and the rest of the body is not read. A piece is
/// what one read brought of the body, to its end or its chunk's; a chunked body's last line is a
/// piece of its own. An answer made in the turn its handler dropped the body does not say
/// `connection: close`; one made later does.
#[tokio::test(start_paused = true)]
async fn a_body_left_unread_keeps_its_connection_only_where_its_next_piece_ends_it() {
    let pair = pair();
    let post = |path: &str, lines: &str| format!("POST {path} HTTP/1.1\r\nhost: localhost\r\n{lines}\r\n");
    const TWO: &str = "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
    const THREE: &str = "1\r\na\r\n1\r\nb\r\n1\r\nc\r\n0\r\n\r\n";
    // What is sent, in its writes; whether the connection goes on; whether the answer says it
    // closes.
    let cases: Vec<(&str, Vec<String>, bool, bool)> = vec![
        ("a length, all of it there", vec![post("/unread", "content-length: 5\r\n") + "hello"], true, false),
        ("a length, some of it there", vec![post("/unread", "content-length: 10\r\n") + "hello"], false, false),
        ("a length, none of it there", vec![post("/unread", "content-length: 5\r\n")], false, false),
        ("a length, the rest a moment later", vec![post("/unread", "content-length: 10\r\n") + "hello", "world".to_owned()], false, false),
        ("one chunk, all there", vec![post("/unread", CHUNKED) + HELLO], true, false),
        ("one chunk, its last line not there", vec![post("/unread", CHUNKED) + "5\r\nhello\r\n"], false, false),
        ("two chunks, all there", vec![post("/unread", CHUNKED) + TWO], false, false),
        ("no chunk", vec![post("/unread", CHUNKED) + "0\r\n\r\n"], true, false),
        // The handler took one piece and answered in the same turn.
        ("a length, its first piece taken", vec![post("/first", "content-length: 5\r\n") + "hello"], true, false),
        ("one chunk, taken", vec![post("/first", CHUNKED) + HELLO], true, false),
        ("two chunks, one taken", vec![post("/first", CHUNKED) + TWO], false, false),
        // It took one piece, held the body for a moment, and answered: by then hyper had read the
        // second for it.
        ("two chunks, one taken and the body held a moment", vec![post("/first-held", CHUNKED) + TWO], true, false),
        ("three chunks, one taken and the body held a moment", vec![post("/first-held", CHUNKED) + THREE], false, false),
        // It took one piece, dropped the body, and answered a moment later.
        ("one chunk, taken a moment before", vec![post("/first-wait", CHUNKED) + HELLO], true, false),
        ("two chunks, one taken a moment before", vec![post("/first-wait", CHUNKED) + TWO], false, true),
        ("a length, half of it taken a moment before", vec![post("/first-wait", "content-length: 10\r\n") + "hello"], false, true),
        // It dropped the body and answered a moment later.
        ("a length, all there, dropped a moment before", vec![post("/drop-wait", "content-length: 5\r\n") + "hello"], true, false),
        ("a length, some there, dropped a moment before", vec![post("/drop-wait", "content-length: 10\r\n") + "hello"], false, true),
        ("two chunks, dropped a moment before", vec![post("/drop-wait", CHUNKED) + TWO], false, true),
        // No route: the app answers 404 without a look at the body.
        ("a length, to no route", vec![post("/nowhere", "content-length: 5\r\n") + "hello"], true, false),
    ];
    let mut wrong = Wrong::default();
    for (name, writes, kept, says) in cases {
        let writes: Vec<&str> = writes.iter().map(String::as_str).collect();
        let (theirs, ours) = pair.send(&writes, false).await;
        let said = find(&theirs.before.0, b"\r\nconnection: close\r\n").is_some();
        let as_expected = did(&theirs).1 == kept && answers(&theirs.before.0).len() == 1 && said == says;
        wrong.unless(as_expected, || format!("hyper's, {name}: {}", brief(&theirs)));
        wrong.unless(ours == theirs, || format!("{name}: {} where hyper's {}", brief(&ours), brief(&theirs)));
    }
    wrong.none();
}

/// What a body says of itself to the reader before each frame (`size_hint`, `is_end_stream`),
/// and the frames it comes in, are hyper's: every extractor's limit reads them (a declared length
/// over a limit is refused before a byte is read, a body at its end is not asked again).
#[tokio::test(start_paused = true)]
async fn a_body_says_of_its_length_and_its_end_what_hypers_says() {
    let pair = pair();
    let post = |lines: &str| format!("POST /hints HTTP/1.1\r\nhost: localhost\r\n{lines}\r\n");
    let cases: Vec<(&str, Vec<String>, &str)> = vec![
        ("a length", vec![post("content-length: 5\r\n") + "hello"], "[5..Some(5) false]5 [0..Some(0) true]body=5"),
        (
            "a length in two writes",
            vec![post("content-length: 10\r\n") + "hello", "world".to_owned()],
            "[10..Some(10) false]5 [5..Some(5) false]5 [0..Some(0) true]body=10",
        ),
        ("chunks", vec![post(CHUNKED) + HELLO], "[0..None false]5 [0..None false]body=5"),
        (
            "chunks and a trailer, in two writes",
            vec![post(CHUNKED) + "5\r\nhello\r\n", "6\r\n world\r\n0\r\nx-t: 1\r\n\r\n".to_owned()],
            "[0..None false]5 [0..None false]6 [0..None false][0..None false]body=11 trailers=[\"x-t=1\"]",
        ),
        ("a length of nothing", vec![post("content-length: 0\r\n")], "[0..Some(0) true]body=0"),
        ("no body", vec![post("")], "[0..Some(0) true]body=0"),
    ];
    for (name, writes, says) in cases {
        let writes: Vec<&str> = writes.iter().map(String::as_str).collect();
        let (theirs, ours) = pair.send(&writes, false).await;
        assert!(find(&theirs.before.0, says.as_bytes()).is_some(), "hyper's, {name}: {theirs:?}");
        assert_eq!(ours, theirs, "{name}");
    }
}

/// An app's limit on a body holds as it does with hyper: a length over it is a 413 before the
/// body is read, a chunked body is a 413 where it passes it, a body under it is read, and one
/// whose client closes its side before its end is a 400.
#[tokio::test(start_paused = true)]
async fn a_limit_on_a_body_holds_as_it_does_with_hyper() {
    let pair = pair_of(|app| app.body_limit(8), 32 * 1024);
    let post = |lines: &str| format!("POST /read HTTP/1.1\r\nhost: localhost\r\n{lines}\r\n");
    let long = "14\r\n01234567890123456789\r\n0\r\n\r\n";
    let cases: Vec<(&str, String, bool, u16)> = vec![
        ("a length under the limit", post("content-length: 5\r\n") + "hello", false, 200),
        ("a length at the limit", post("content-length: 8\r\n") + "12345678", false, 200),
        ("a length over the limit", post("content-length: 20\r\n") + "01234567890123456789", false, 413),
        ("a length over the limit, none of it sent", post("content-length: 20\r\n"), false, 413),
        ("chunks under the limit", post(CHUNKED) + HELLO, false, 200),
        ("chunks over the limit", post(CHUNKED) + long, false, 413),
        ("a length cut short by its client's end", post("content-length: 8\r\n") + "123", true, 400),
        ("chunks cut short by their client's end", post(CHUNKED) + "5\r\nhel", true, 400),
        ("chunks whose last line never comes", post(CHUNKED) + "5\r\nhello\r\n", true, 400),
    ];
    for (name, request, closes, status) in cases {
        let (theirs, ours) = pair.send(&[&request], closes).await;
        let statuses: Vec<u16> = answers(&theirs.before.0).iter().map(|answer| answer.status).collect();
        assert_eq!(statuses, [status], "hyper's, {name}: {theirs:?}");
        assert_eq!(ours, theirs, "{name}");
    }
}

/// A deadline that passes while the handler waits for more of the body is the client's 408, and
/// one that passes while it waits for anything else is the server's 503, on both connections
/// (design Choice 30): the body Corten's connection gives marks a read that waits as hyper's
/// does, and the deadline's timer is the connection's on both.
#[tokio::test(start_paused = true)]
async fn a_deadline_while_the_body_is_awaited_is_the_clients_408() {
    let pair = pair_of(|app| app.deadline(Duration::from_millis(300)), 32 * 1024);
    let post = |path: &str, lines: &str| format!("POST {path} HTTP/1.1\r\nhost: localhost\r\n{lines}\r\n");
    let cases: Vec<(&str, String, u16)> = vec![
        ("a length that stops coming", post("/read", "content-length: 10\r\n") + "abc", 408),
        ("a length none of which comes", post("/read", "content-length: 10\r\n"), 408),
        ("chunks that stop coming", post("/read", CHUNKED) + "5\r\nhel", 408),
        ("chunks whose last line does not come", post("/read", CHUNKED) + "5\r\nhello\r\n", 408),
        ("a body read whole by a handler that then waits", post("/read-wait", "content-length: 5\r\n") + "hello", 503),
        ("a body a handler that waits never reads", post("/wait", "content-length: 10\r\n") + "abc", 503),
        ("a handler that waits with no body", post("/wait", ""), 503),
    ];
    for (name, request, status) in cases {
        let (theirs, ours) = pair.talk(&[&request]).await;
        assert!(theirs.0[0].starts_with(&format!("HTTP/1.1 {status} ")), "hyper's, {name}: {theirs:?}");
        assert_eq!(ours, theirs, "{name}");
    }
}

/// The bytes behind a body are the next request, read by the same reader of heads under the same
/// limit: requests with bodies of both framings and without, sent in one write and a byte at a
/// time, are each answered in order; and a head behind a body that is longer than the app allows
/// is refused as one behind any other request is.
#[tokio::test(start_paused = true)]
async fn the_bytes_behind_a_body_are_the_next_request() {
    let pair = pair_of(|app| app, 700);
    let get = "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    let length = "POST /read HTTP/1.1\r\nhost: localhost\r\ncontent-length: 5\r\n\r\nhello";
    let chunks = format!("POST /read HTTP/1.1\r\nhost: localhost\r\n{CHUNKED}\r\n5;x\r\nhello\r\n1\r\n!\r\n0\r\nx-t: 1\r\n\r\n");
    let all = format!("{length}{chunks}{get}{length}{chunks}");
    let (theirs, ours) = pair.send(&[&all], false).await;
    assert_eq!(did(&theirs), (vec![(200, true); 5], true), "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);
    let bytes: Vec<String> = all.bytes().map(|byte| (byte as char).to_string()).collect();
    let bytes: Vec<&str> = bytes.iter().map(String::as_str).collect();
    let (theirs, ours) = pair.send(&bytes, false).await;
    assert_eq!(did(&theirs), (vec![(200, true); 5], true), "hyper's, a byte at a time: {theirs:?}");
    assert_eq!(ours, theirs, "a byte at a time");
    // A head over the limit, behind each framing.
    let long = format!("GET / HTTP/1.1\r\nhost: localhost\r\nx-long: {}\r\n\r\n", "v".repeat(800));
    for body in [length, &chunks] {
        let (theirs, ours) = pair.send(&[&format!("{body}{long}")], false).await;
        assert_eq!(did(&theirs), (vec![(200, true), (431, false)], false), "hyper's: {theirs:?}");
        assert_eq!(ours, theirs);
    }
}

/// A client that closes its side with a body unfinished: the app's read fails, its answer is
/// sent (the client can still read), and the connection is closed, as with hyper; a handler that
/// did not read answers as it would have. At every byte of a body of each framing.
#[tokio::test(start_paused = true)]
async fn a_client_that_leaves_with_a_body_unfinished_is_answered_as_hyper_answers_it() {
    let pair = pair();
    let post = |path: &str, lines: &str, body: &str| format!("POST {path} HTTP/1.1\r\nhost: localhost\r\n{lines}\r\n{body}");
    for path in ["/framing", "/unread", "/first"] {
        for (lines, body) in [("content-length: 11\r\n", "hello world"), (CHUNKED, "5;x\r\nhello\r\n6\r\n world\r\n0\r\nx-t: 1\r\n\r\n")] {
            let head = post(path, lines, "").len();
            let whole = post(path, lines, body);
            for cut in head..whole.len() {
                let (theirs, ours) = pair.send(&[&whole[..cut]], true).await;
                assert_eq!(answers(&theirs.before.0).len(), 1, "hyper's, {path} cut at {cut}: {theirs:?}");
                assert_eq!(ours, theirs, "{path}, {lines:?} cut at {cut} of {}", whole.len());
                if path == "/framing" {
                    assert!(find(&ours.before.0, b"HTTP/1.1 400 ").is_some(), "{lines:?} cut at {cut}: {ours:?}");
                }
            }
        }
    }
}

/// A body read by a task that outlives its handler, behind the handler's answer: the connection
/// goes on reading for it, as hyper's does, and takes the next request when the body has ended.
#[tokio::test(start_paused = true)]
async fn a_body_is_read_behind_its_answer_by_a_task_that_holds_it() {
    let pair = pair();
    let get = "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    let head = "POST /late HTTP/1.1\r\nhost: localhost\r\ncontent-length: 10\r\n\r\nabc";
    let (theirs, ours) = pair.talk(&[head, "defg", &format!("hij{get}")]).await;
    assert!(theirs.0[0].starts_with("HTTP/1.1 202 "), "hyper's: {theirs:?}");
    assert!(theirs.0[1].is_empty() && theirs.0[2].ends_with("hi") && !theirs.1, "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);
    let chunks = format!("POST /late HTTP/1.1\r\nhost: localhost\r\n{CHUNKED}\r\n5\r\nhello\r\n");
    let (theirs, ours) = pair.talk(&[&chunks, "6\r\n world\r\n", &format!("0\r\nx-t: 1\r\n\r\n{get}")]).await;
    assert!(theirs.0[0].starts_with("HTTP/1.1 202 ") && theirs.0[2].ends_with("hi"), "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);
    // And where the body fails behind the answer, the task is told, and the connection closes.
    let (theirs, ours) = pair.talk(&[&chunks, "z\r\n", get]).await;
    assert!(theirs.0[2].is_empty() && theirs.1, "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);
    let read = |log: &Log| log.lock().unwrap().clone();
    let expected = ["body=10 trailers=[]", "body=11 trailers=[\"x-t=1\"]", "failed after 5: error reading a body from connection"];
    assert_eq!(read(&pair.logs[0]), expected, "hyper's");
    assert_eq!(read(&pair.logs[1]), expected);
}

/// An answer whose body is the request's body, read as the answer is written: each piece the
/// client sends comes back before the next is sent, on both connections.
#[tokio::test(start_paused = true)]
async fn a_body_is_read_while_its_answer_is_written() {
    let pair = pair();
    let head = format!("POST /echo HTTP/1.1\r\nhost: localhost\r\n{CHUNKED}\r\n5\r\nhello\r\n");
    let get = "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    let (theirs, ours) = pair.talk(&[&head, "6\r\n world\r\n", "0\r\n\r\n", get]).await;
    assert!(theirs.0[0].ends_with("5\r\nhello\r\n"), "hyper's: {theirs:?}");
    assert_eq!(theirs.0[1], "6\r\n world\r\n", "hyper's");
    assert_eq!(theirs.0[2], "0\r\n\r\n", "hyper's");
    assert!(theirs.0[3].ends_with("hi") && !theirs.1, "hyper's: {theirs:?}");
    assert_eq!(ours, theirs);
}

/// A handler that panics with its body half read is answered for by the app (a 500), and the
/// connection does with the rest of the body what it does with any body left unread.
#[tokio::test(start_paused = true)]
async fn a_handler_that_panics_with_its_body_half_read_is_answered_as_hyper_answers_it() {
    let pair = pair();
    let post = |lines: &str, body: &str| format!("POST /panic HTTP/1.1\r\nhost: localhost\r\n{lines}\r\n{body}");
    for (name, request) in [
        ("all of a length there", post("content-length: 5\r\n", "hello")),
        ("some of a length there", post("content-length: 10\r\n", "hello")),
        ("two chunks there", post(CHUNKED, "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n")),
    ] {
        let (theirs, ours) = pair.send(&[&request], false).await;
        assert_eq!(did(&theirs).0, [(500, true)], "hyper's, {name}: {theirs:?}");
        assert_eq!(ours, theirs, "{name}");
    }
}

/// A server for [`app`] that stops when told, with a second of grace.
fn stoppable(own: bool, log: &Log) -> (Connect, tokio::sync::oneshot::Sender<()>, tokio::task::JoinHandle<std::io::Result<()>>) {
    let (connect, accepted) = tokio::sync::mpsc::unbounded_channel();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let served = app(log).own_http1(own).shutdown_grace(Duration::from_secs(1));
    let server = tokio::spawn(crate::app::run(vec![Piped(accepted)], crate::app::plain, served, async {
        let _ = stopped.await;
    }));
    (connect, stop, server)
}

/// Shutdown that begins while a body is arriving lets the request finish, as with hyper: the
/// rest of the body is read, the answer says the connection closes, and the server ends. A body
/// that has not ended when the grace runs out is cut: whoever holds it is told so.
#[tokio::test(start_paused = true)]
async fn shutdown_lets_a_body_that_is_arriving_finish_and_cuts_one_that_does_not() {
    let moment = || tokio::time::sleep(Duration::from_millis(5));
    let mut got = Vec::new();
    for own in [false, true] {
        let log = Log::default();
        // The rest of the body comes within the grace.
        let (connect, stop, server) = stoppable(own, &log);
        let (mut client, io) = tokio::io::duplex(WIDE);
        connect.send(io).expect("the server is listening");
        client.write_all(b"POST /read HTTP/1.1\r\nhost: localhost\r\ncontent-length: 10\r\n\r\nhello").await.unwrap();
        moment().await;
        stop.send(()).unwrap();
        moment().await;
        client.write_all(b"world").await.unwrap();
        let mut all = Vec::new();
        client.read_to_end(&mut all).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
        let finished = dateless(&String::from_utf8_lossy(&all));
        assert!(finished.starts_with("HTTP/1.1 200 OK") && finished.ends_with("read 10"), "own: {own}: {finished}");
        assert!(finished.contains("\r\nconnection: close\r\n"), "own: {own}: {finished}");

        // It never comes: a task that holds the body learns that it was cut.
        let (connect, stop, server) = stoppable(own, &log);
        let (mut client, io) = tokio::io::duplex(WIDE);
        connect.send(io).expect("the server is listening");
        client.write_all(b"POST /late HTTP/1.1\r\nhost: localhost\r\ncontent-length: 10\r\n\r\nhello").await.unwrap();
        moment().await;
        stop.send(()).unwrap();
        let mut all = Vec::new();
        client.read_to_end(&mut all).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
        moment().await;
        let cut = dateless(&String::from_utf8_lossy(&all));
        assert!(cut.starts_with("HTTP/1.1 202 "), "own: {own}: {cut}");
        let told = log.lock().unwrap().clone();
        assert_eq!(told.len(), 1, "own: {own}: {told:?}");
        assert!(told[0].starts_with("failed after 5: "), "own: {own}: {told:?}");
        got.push((finished, cut, told));
    }
    assert_eq!(got[1], got[0]);
}

/// How many bytes of a body a server takes from a client whose handler never reads it: what the
/// client could write beyond the head, less what the pipe holds.
async fn taken_unread(connect: &Connect, head: &str, pipe: usize) -> usize {
    let (mut client, server) = tokio::io::duplex(pipe);
    connect.send(server).expect("the server is listening");
    client.write_all(head.as_bytes()).await.unwrap();
    let mut sent = 0usize;
    while sent < 4 << 20 {
        match tokio::time::timeout(QUIET, client.write_all(&[b'x'; 64])).await {
            Ok(Ok(())) => sent += 64,
            _ => break,
        }
    }
    sent.saturating_sub(pipe)
}

/// **Nothing is read ahead of the app.** A handler that holds its body and never reads it makes
/// Corten's connection hold what its first read brought and no more, however much the client
/// sends and however long it waits: the rest stays in the socket, and the client is held back
/// by it. The first read is of [`crate::h1::FIRST`] bytes at the most. hyper's connection reads
/// 8 KiB at first and keeps a piece ready for the app, so it takes more. With
/// `Expect: 100-continue` the same. One read more, of 4 KiB at the most, is made for a handler
/// that asked for one piece and stopped (where the first read brought the head alone). For one
/// that dropped the body, the connection reads on to learn whether the body ends in what has
/// arrived, and gives up when it has read 24 KiB past: that and its last read, of 16 KiB at the
/// most, is what a client can make it take for a body nobody reads.
#[tokio::test(start_paused = true)]
async fn a_body_its_handler_does_not_read_stays_in_the_socket() {
    // More than either connection reads at once, so a read is as long as the connection asks.
    const PIPE: usize = 64 * 1024;
    let pair = pair();
    let head = |path: &str, lines: &str| format!("POST {path} HTTP/1.1\r\nhost: localhost\r\ncontent-length: 4000000\r\n{lines}\r\n");
    const FIRST: usize = crate::h1::FIRST;
    // The most Corten's connection may take, and the most room its read buffer may have had.
    for (name, head, most, room) in [
        ("a handler that holds the body", head("/hold", ""), FIRST, FIRST),
        ("a handler that holds the body, and a client that expects to be told", head("/hold", "expect: 100-continue\r\n"), FIRST, FIRST),
        ("a handler that took one piece and waits", head("/first-long", ""), FIRST + 4096, 4096),
        ("a handler that dropped the body and waits", head("/wait", ""), FIRST + 24 * 1024 + 16 * 1024, 16 * 1024),
    ] {
        crate::h1::HELD.set(0);
        let ours = taken_unread(&pair.own, &head, PIPE).await;
        let held = crate::h1::HELD.get();
        let theirs = taken_unread(&pair.hyper, &head, PIPE).await;
        assert!(ours <= most, "{name}: Corten's connection took {ours} bytes");
        assert!(held <= room, "{name}: its read buffer had room for {held} bytes");
        // What a count misses: the last write, which the pipe took a part of.
        assert!(theirs + 64 >= 8192 - head.len(), "{name}: hyper's connection took {theirs} bytes");
        // A body that is held is where the two differ: hyper's has read ahead of the app.
        if most <= FIRST + 4096 {
            assert!(theirs > ours, "{name}: {theirs} bytes taken by hyper's, {ours} by Corten's");
        }
    }
}

/// What a body can make Corten's connection hold while it is read: one read of the socket, of
/// 256 KiB at the most however fast the client sends, and of 8 KiB while the pieces a body comes
/// in are small; no byte of a chunk's extensions or of what else a size line is made long with;
/// and trailers of the app's limit on a head at the most.
#[tokio::test(start_paused = true)]
async fn what_a_body_makes_the_connection_hold_is_bounded() {
    let pair = pair();
    let post = |lines: &str| format!("POST /framing HTTP/1.1\r\nhost: localhost\r\n{lines}\r\n");
    // What is sent, the most room the read buffer may have had, and the most trailers held.
    let fast = post("content-length: 8388608\r\n") + &"x".repeat(8 << 20);
    let tiny = post(CHUNKED) + &"1\r\nx\r\n".repeat(100_000) + "0\r\n\r\n";
    let extended = post(CHUNKED) + &format!("1;{}\r\nx\r\n", "e".repeat(16 * 1024 - 2)) + &"1\r\nx\r\n".repeat(1000) + "0\r\n\r\n";
    let trailed = post(CHUNKED) + "1\r\nx\r\n0\r\n" + &"a: b\r\n".repeat(99) + &format!("c: {}\r\n\r\n", "v".repeat(30_000));
    let over = post(CHUNKED) + "1\r\nx\r\n0\r\n" + &format!("c: {}\r\n\r\n", "v".repeat(64 * 1024));
    // A size line of 4 MiB: zeros before the size and spaces behind it, which nothing counts.
    let padded = post(CHUNKED) + &"0".repeat(2 << 20) + "1" + &" ".repeat(2 << 20) + "\r\nx\r\n0\r\n\r\n";
    let cases: Vec<(&str, String, &str, usize, usize)> = vec![
        ("a size line of 4 MiB", padded, "body=1", 256 * 1024, 0),
        ("8 MiB sent as fast as the pipe takes it", fast, "body=8388608", 256 * 1024, 0),
        ("100,000 chunks of a byte", tiny, "body=100000", 8192, 0),
        ("extensions at their limit", extended, "body=1001", 8192 + 16 * 1024, 0),
        ("trailers near their limit", trailed, "body=1 trailers=", 8192 + HEAD, HEAD),
        ("trailers past their limit", over, "failed after 1", 256 * 1024, HEAD),
    ];
    for (name, sent, says, room, trailers) in cases {
        crate::h1::HELD.set(0);
        crate::h1::body::TRAILED.set(0);
        let (mut client, server) = tokio::io::duplex(WIDE);
        pair.own.send(server).expect("the server is listening");
        let (mut reading, mut writing) = tokio::io::split(client_of(&mut client));
        let sending = tokio::spawn(async move {
            let _ = writing.write_all(sent.as_bytes()).await;
            writing
        });
        let mut got = vec![0u8; 4096];
        let read = tokio::time::timeout(Duration::from_secs(60), reading.read(&mut got)).await.expect("an answer").unwrap();
        let got = String::from_utf8_lossy(&got[..read]).into_owned();
        assert!(got.contains(says), "{name}: {got}");
        let (held, trailed) = (crate::h1::HELD.get(), crate::h1::body::TRAILED.get());
        assert!(held <= room, "{name}: the read buffer had room for {held} bytes");
        assert!(trailed <= trailers, "{name}: {trailed} bytes of trailers were held");
        sending.abort();
    }
}

/// The pipe's client end, moved out of where it was made.
fn client_of(client: &mut DuplexStream) -> DuplexStream {
    std::mem::replace(client, tokio::io::duplex(1).0)
}
