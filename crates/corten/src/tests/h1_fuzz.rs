//! The differential gate for Corten's own HTTP/1.1 connection ([`App::own_http1`]): the same
//! bytes are sent to one app served by hyper's connection and by Corten's own, and what each
//! sends back is compared (`docs/design.md#choice-own-http1`).
//!
//! A stream is one to four requests made from a grammar of what clients and attackers send
//! (methods, targets, versions, `Host` lines, every way to frame a body and to get one wrong,
//! header lines the grammar does not have, line ends). In half the streams every request is one
//! a client that follows HTTP sends, so the answers of the two are compared and not only their
//! refusals; in the other half each request is as likely to be made from the whole grammar. A
//! stream is then changed at random three times in
//! ten (a byte flipped, dropped or added, a line doubled, dropped or moved, the stream cut), cut
//! into several writes one time in three, and its client's side closed behind it one time in
//! twelve. The streams before those are fixed: each of a few requests cut in two writes at every
//! byte, and ended at every byte. The same number makes the same stream on every run.
//!
//! After a stream, if the server has not closed, one more request is sent that every server
//! answers: where a server took the stream's last message to end shows in whether, and how, that
//! request is answered.
//!
//! **What fails the gate**, for any stream:
//! 1. Corten's own connection is laxer than hyper's: it answers more requests than hyper does, or
//!    the app answers a request there that hyper refuses or does not answer.
//! 2. The two differ in any other way that is not on the list below: a byte of an answer other
//!    than its `Date`, an answer more or fewer, a connection closed by one and kept by the other.
//! 3. A connection's task panics.
//!
//! A server that never stops working on a stream never lets the test end (time here is tokio's
//! own, which passes only when every task waits), so a hang fails it too.
//!
//! **The differences on the list**, which is the whole of it ([`Verdict::Listed`]):
//! 1. A head that reaches the app's limit unfinished and is malformed further on is refused by
//!    both, with 400 by one and 431 by the other, and nothing else differs. Which of the two hyper
//!    answers depends on where its reads ended: 400 if the malformed bytes had arrived with the
//!    ones before the limit, 431 if they had not. Corten's own connection reads a head no further
//!    than the limit, and other bytes in reads of other sizes, so the same stream can be cut
//!    differently for it.
//!
//! The servers run in the test's own thread, over pipes in memory, with tokio's time paused: a
//! client that waits for the server to go quiet waits until every task is idle, not for a guess
//! at how long a loaded machine needs, so the same stream has the same outcome on every run.

use super::h1::{dateless, Dice};
use super::*;
use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

/// The seed of the run the pull request reports, and of the smaller one in the suite.
const SEED: u64 = 20_261_124;

/// How many streams made at random the suite's run sends, after the fixed ones.
const IN_SUITE: usize = 3_000;

/// How long a client waits with nothing arriving before it takes the server to be waiting, in
/// tokio's paused time: well under the header timeout, which would close the connection.
const QUIET: Duration = Duration::from_secs(2);

/// Listens on a channel: a connection is one end of a pipe the test made.
struct Piped(tokio::sync::mpsc::UnboundedReceiver<DuplexStream>);

impl crate::Listener for Piped {
    type Io = DuplexStream;
    type Addr = ();

    async fn accept(&mut self) -> (DuplexStream, ()) {
        match self.0.recv().await {
            Some(io) => (io, ()),
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A hash of `bytes` in `state`, for an answer that says what its handler was given without
/// repeating it (FNV-1a).
fn mix(state: &mut u64, bytes: &[u8]) {
    for byte in bytes.iter().chain(&[0xff]) {
        *state = (*state ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3);
    }
}

/// Everything a handler is given of a request, as a number: its method, target, version, each
/// header's name and value in their order, and its body.
async fn seen(req: Request<Body>) -> String {
    let (parts, body) = req.into_parts();
    let mut state = 0xcbf2_9ce4_8422_2325;
    mix(&mut state, parts.method.as_str().as_bytes());
    mix(&mut state, parts.uri.to_string().as_bytes());
    mix(&mut state, format!("{:?}", parts.version).as_bytes());
    for (name, value) in &parts.headers {
        mix(&mut state, name.as_str().as_bytes());
        mix(&mut state, value.as_bytes());
    }
    let body = match crate::body::to_bytes(body, 1 << 20).await {
        Ok(body) => {
            mix(&mut state, &body);
            body.len().to_string()
        }
        Err(_) => "failed".to_owned(),
    };
    format!("seen {state:016x} body {body}")
}

/// An app with an answer of each kind a connection writes differently, and a route that says what
/// it was given.
fn app() -> App {
    static X: [u8; 20 * 1024] = [b'x'; 20 * 1024];
    let stream = || async {
        let pieces: [&'static [u8]; 4] = [b"first", b"second", &X, b"last"];
        Body::from_stream(futures_util::stream::iter(pieces.map(|piece| Ok::<_, std::io::Error>(Bytes::from_static(piece)))))
    };
    let table = Table::new()
        .route("/", get(|| async { "hi" }))
        .route("/json", get(|| async { ([(header::CONTENT_TYPE, "application/json")], r#"{"ok":true}"#) }))
        .route("/empty", get(|| async {}))
        .route("/stream", get(stream))
        .route("/none", get(|| async { StatusCode::NO_CONTENT }))
        .route("/close", get(|| async { ([(header::CONNECTION, "close")], "bye") }))
        .route("/unread", crate::router::any(|| async { "unread" }))
        .route("/read", crate::router::any(|body: Bytes| async move { format!("read {}", body.len()) }))
        .route("/seen", crate::router::any(seen));
    App::new(Routes::from(table))
}

/// A server for [`app`] with the connection `own` says and this limit on a head, and where to
/// send it a connection.
fn serve(own: bool, head: usize) -> tokio::sync::mpsc::UnboundedSender<DuplexStream> {
    let (connect, accepted) = tokio::sync::mpsc::unbounded_channel();
    let app = app().own_http1(own).max_request_head(head);
    tokio::spawn(crate::app::run(vec![Piped(accepted)], crate::app::plain, app, std::future::pending()));
    connect
}

/// What a server did with a stream.
#[derive(Debug, PartialEq, Eq)]
struct Outcome {
    /// What it sent before the last request, without each `Date`.
    before: String,
    /// It closed the connection before the last request was sent.
    closed: bool,
    /// What it sent to the last request.
    after: String,
    closed_after: bool,
}

/// Everything `client` receives until the server closes or goes quiet, and whether it closed.
async fn receive(client: &mut DuplexStream) -> (String, bool) {
    let (mut got, mut buf) = (Vec::new(), vec![0u8; 64 * 1024]);
    loop {
        match tokio::time::timeout(QUIET, client.read(&mut buf)).await {
            Ok(Ok(0) | Err(_)) => return (dateless(&String::from_utf8_lossy(&got)), true),
            Ok(Ok(read)) => got.extend_from_slice(&buf[..read]),
            Err(_) => return (dateless(&String::from_utf8_lossy(&got)), false),
        }
    }
}

/// The request sent behind a stream.
fn last_request(index: usize) -> String {
    format!("GET /seen?last={index} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n")
}

/// Sends a stream to a server, each write once the server has done all it will with the one
/// before, then the last request if the connection is still open and the client's side of it is.
async fn exchange(connect: &tokio::sync::mpsc::UnboundedSender<DuplexStream>, stream: &Stream) -> Outcome {
    let (mut client, server) = tokio::io::duplex(1 << 20);
    connect.send(server).expect("the server is listening");
    for write in &stream.writes {
        if client.write_all(write).await.is_err() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    if stream.closes {
        let _ = client.shutdown().await;
    }
    let (before, closed) = receive(&mut client).await;
    let (mut after, mut closed_after) = (String::new(), closed);
    if !closed && !stream.closes && client.write_all(last_request(stream.index).as_bytes()).await.is_ok() {
        (after, closed_after) = receive(&mut client).await;
    }
    Outcome { before, closed, after, closed_after }
}

/// One answer in what a server sent: its status, and whether the app made it (the server's own
/// refusals have none of the app's headers).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
struct Answer {
    status: u16,
    apps: bool,
}

/// The answers in `sent`. No body of [`app`]'s has a status line in it.
fn answers(sent: &str) -> Vec<Answer> {
    let starts: Vec<usize> = sent.match_indices("HTTP/1.").map(|(at, _)| at).collect();
    let mut found = Vec::new();
    for (which, start) in starts.iter().enumerate() {
        let answer = &sent[*start..starts.get(which + 1).copied().unwrap_or(sent.len())];
        let Some(status) = answer.get(9..12).and_then(|status| status.parse().ok()) else { continue };
        let head = answer.split_once("\r\n\r\n").map_or(answer, |(head, _)| head);
        // An interim answer is not the answer to a request.
        if status != 100 {
            found.push(Answer { status, apps: head.contains("\r\nx-content-type-options: nosniff") });
        }
    }
    found
}

/// How the two connections' outcomes for one stream compare.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Same,
    /// Corten's own connection is laxer than hyper's.
    Laxer(&'static str),
    /// A difference on the list the gate keeps (this file's comment, and
    /// `docs/design.md#choice-own-http1`).
    Listed(&'static str),
    /// Any other difference.
    Unlisted(&'static str),
}

/// The one class of difference on the list.
const LIMIT_OR_GRAMMAR: &str = "a head that reaches the limit and is malformed further on: 400 from one, 431 from the other";

/// `outcome` with the status line of its last answer made the same whichever of the two it is,
/// where that answer is the server's own refusal of a head as malformed (400) or as too long
/// (431). `None` where its last answer is not one of those.
fn refusal_alike(outcome: &Outcome) -> Option<Outcome> {
    let alike = |sent: &str| {
        let at = sent.rfind("HTTP/1.")?;
        let end = at + sent[at..].find("\r\n")?;
        let (version, status) = (sent.get(at..at + 8)?, sent.get(at + 8..end)?);
        let refusal = matches!(status, " 400 Bad Request" | " 431 Request Header Fields Too Large");
        let servers = answers(&sent[at..]).last().is_some_and(|answer| !answer.apps);
        (refusal && servers).then(|| format!("{}{version} 4xx{}", &sent[..at], &sent[end..]))
    };
    let (before, after) = (outcome.before.clone(), outcome.after.clone());
    let (before, after) = if answers(&after).is_empty() { (alike(&before)?, after) } else { (before, alike(&after)?) };
    Some(Outcome { before, closed: outcome.closed, after, closed_after: outcome.closed_after })
}

/// `reaches_limit`: the client sent as many bytes as the app's limit on a head, or more.
fn judge(hyper: &Outcome, own: &Outcome, reaches_limit: bool) -> Verdict {
    if hyper == own {
        return Verdict::Same;
    }
    if reaches_limit && refusal_alike(hyper).is_some_and(|hyper| Some(hyper) == refusal_alike(own)) {
        return Verdict::Listed(LIMIT_OR_GRAMMAR);
    }
    let all = |outcome: &Outcome| {
        let mut all = answers(&outcome.before);
        all.extend(answers(&outcome.after));
        all
    };
    let (theirs, ours) = (all(hyper), all(own));
    if ours.len() > theirs.len() {
        return Verdict::Laxer("own answers more requests than hyper");
    }
    for (at, ours) in ours.iter().enumerate() {
        if *ours != theirs[at] {
            return match (ours.apps, theirs[at].apps) {
                (true, false) => Verdict::Laxer("the app answers on own a request hyper refuses"),
                (false, true) => Verdict::Unlisted("own refuses a request the app answers on hyper"),
                _ => Verdict::Unlisted("an answer's status differs"),
            };
        }
    }
    if ours.len() < theirs.len() {
        return Verdict::Unlisted("own answers fewer requests than hyper");
    }
    if (hyper.closed, hyper.closed_after) != (own.closed, own.closed_after) {
        return Verdict::Unlisted("one closes the connection where the other keeps it");
    }
    Verdict::Unlisted("the same answers, with different bytes")
}

/// One stream of the run.
struct Stream {
    index: usize,
    /// What the client sends, in the writes it sends it in.
    writes: Vec<Vec<u8>>,
    /// The client closes its side behind the last write.
    closes: bool,
}

impl Stream {
    fn bytes(&self) -> Vec<u8> {
        self.writes.concat()
    }
}

/// The requests each cut in two writes at every byte, and ended at every byte: a whole request of
/// each kind the two connections treat differently, alone and behind another.
fn bases() -> Vec<Vec<u8>> {
    let get = "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    let texts = [
        get.to_owned(),
        format!("{get}GET /json HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n"),
        "HEAD /stream HTTP/1.1\r\nhost: localhost\r\n\r\n".to_owned(),
        "GET /seen?a=1 HTTP/1.0\r\nconnection: keep-alive\r\n\r\n".to_owned(),
        format!("{get}POST /read HTTP/1.1\r\nhost: localhost\r\ncontent-length: 5\r\n\r\nhello{get}"),
        format!("{get}POST /seen HTTP/1.1\r\nhost: localhost\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n{get}"),
        format!("{get}POST /read HTTP/1.1\r\nhost: localhost\r\ncontent-length: 5\r\nexpect: 100-continue\r\n\r\nhello"),
        format!("{get}GET / HTTP/1.1\r\nhost: localhost\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n{get}"),
        format!("{get}CONNECT localhost:443 HTTP/1.1\r\nhost: localhost\r\n\r\n{get}"),
        "GET / HTTP/1.0\r\nconnection: keep-alive\r\n\r\nPOST /read HTTP/1.1\r\ncontent-length: x\r\n\r\n".to_owned(),
        "GET / HTTP/1.0\r\nconnection: keep-alive\r\n\r\nGET / HTTP/1.1\r\nhost : a\r\n\r\n".to_owned(),
        "\r\n\r\nGET /none HTTP/1.1\nhost: localhost\n\nGET /close HTTP/1.1\r\nhost: localhost\r\n\r\n".to_owned(),
        format!("GET /unread HTTP/1.1\r\nhost: localhost\r\ncontent-length: 3\r\n\r\nabc{get}"),
    ];
    texts.into_iter().map(String::into_bytes).collect()
}

fn pick<'a, T: ?Sized>(dice: &mut Dice, of: &[&'a T]) -> &'a T {
    of[dice.below(of.len())]
}

// Each list begins with what a client that follows HTTP sends: [`request`] says how many of its
// entries those are.

/// True `in_hundred` times in a hundred.
fn chance(dice: &mut Dice, in_hundred: usize) -> bool {
    dice.below(100) < in_hundred
}

const METHODS: &[&str] = &[
    "GET", "GET", "GET", "GET", "GET", "HEAD", "POST", "POST", "PUT", "DELETE", "OPTIONS", "CONNECT", "PURGE", "get", "G(ET", "",
];
const TARGETS: &[&str] = &[
    "/",
    "/",
    "/json",
    "/empty",
    "/stream",
    "/none",
    "/close",
    "/read",
    "/unread",
    "/seen",
    "/seen?a=1&b=2",
    "/nowhere",
    "*",
    "http://localhost/json",
    "http://other.example/",
    "localhost:443",
    "/a b",
    "/caf\u{e9}",
    "/%00",
    "//",
    "",
];
const VERSIONS: &[&str] = &[
    "HTTP/1.1",
    "HTTP/1.1",
    "HTTP/1.1",
    "HTTP/1.1",
    "HTTP/1.1",
    "HTTP/1.1",
    "HTTP/1.1",
    "HTTP/1.0",
    "HTTP/1.0",
    "HTTP/2.0",
    "HTTP/1.2",
    "HTTP/0.9",
    "http/1.1",
    "HTTP/1.10",
    "",
];
const HOSTS: &[&str] = &[
    "host: localhost",
    "host: localhost",
    "host: localhost",
    "host: localhost",
    "Host: localhost",
    "HOST: LOCALHOST:80",
    "host:localhost",
    "host: other.example",
    "host : localhost",
    "host: localhost\r\nhost: localhost",
    "host: localhost\r\nhost: other.example",
    "host:",
    "",
];
const CONNECTIONS: &[&str] = &[
    "",
    "",
    "",
    "",
    "",
    "connection: close",
    "Connection: Close",
    "connection: keep-alive",
    "connection: Keep-Alive, close",
    "connection: close\r\nconnection: keep-alive",
    "connection: upgrade",
    "connection: close, upgrade",
    "connection: te",
    "connection:",
    "connection: x-a",
];
/// Lines that ask for more than an answer.
const ASKS: &[&str] = &[
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "expect: 100-continue",
    "Expect: 100-Continue",
    "expect: nonsense",
    "expect:",
    "upgrade: websocket",
    "Upgrade: echo",
    "upgrade:",
    "upgrade: h2c\r\nhttp2-settings: AAMAAABkAAQAoAAAAAIAAAAA",
    "te: trailers",
    "trailer: x-t",
];
/// Header lines of no meaning to a server, those the grammar has and those it does not.
const LINES: &[&str] = &[
    "x-a: 1",
    "x-a: 1",
    "accept: */*",
    "user-agent: fuzz/1",
    "cookie: a=b; c=d",
    "X-UPPER: Y",
    "x-a:1",
    "x-a:",
    "x-a:    1   ",
    "x-a: a\tb",
    "x-a: caf\u{e9}",
    "x-a : 1",
    "x-a\t: 1",
    "x-a",
    ": 1",
    " x-folded: 1",
    "\tx-folded: 1",
    "x-a: a\rb",
    "x-a: a\0b",
    "x-a: a\x01b",
    "x-a: a\x7fb",
    "x a: 1",
    "x(a): 1",
    "x-a: 1\r",
    "content-type: text/plain",
    "accept-encoding: gzip",
    "if-none-match: \"v1\"",
    "origin: http://other.example",
    "sec-fetch-site: cross-site",
];
/// A chunked body, as the grammar has it and as it does not.
const CHUNKED: &[&str] = &[
    "5\r\nhello\r\n0\r\n\r\n",
    "5\r\nhello\r\n0\r\n\r\n",
    "5\r\nhello\r\n0\r\n\r\n",
    "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
    "0\r\n\r\n",
    "A\r\n0123456789\r\n0\r\n\r\n",
    "a\r\n0123456789\r\n0\r\n\r\n",
    "5;ext=1\r\nhello\r\n0\r\n\r\n",
    "5;ext=\"a b\"\r\nhello\r\n0\r\n\r\n",
    "5\r\nhello\r\n0\r\nx-t: 1\r\n\r\n",
    "5\r\nhello\r\n0\r\nx-t : 1\r\n\r\n",
    "5\nhello\n0\n\n",
    "5\r\nhello\r\n0\r\n",
    "5\r\nhello\r\n",
    "5\r\nhel",
    "z\r\nhello\r\n0\r\n\r\n",
    "5 \r\nhello\r\n0\r\n\r\n",
    " 5\r\nhello\r\n0\r\n\r\n",
    "+5\r\nhello\r\n0\r\n\r\n",
    "0x5\r\nhello\r\n0\r\n\r\n",
    "-5\r\nhello\r\n0\r\n\r\n",
    "5\r\nhelloXX0\r\n\r\n",
    "5\r\nhello\r0\r\n\r\n",
    "FFFFFFFFFFFFFFFFF\r\nhello\r\n0\r\n\r\n",
    "00000000000000005\r\nhello\r\n0\r\n\r\n",
    "5\r\nhello\r\n00\r\n\r\n",
    "",
];
/// Values of `Transfer-Encoding`.
const CODINGS: &[&str] = &[
    "chunked",
    "chunked",
    "chunked",
    "Chunked",
    "CHUNKED",
    "chunked ",
    " chunked",
    "\tchunked",
    "chunked, chunked",
    "gzip, chunked",
    "chunked, gzip",
    "identity",
    "gzip",
    "",
    "chunked;q=1",
    "x-chunked",
    "chunke",
    "chunked\x0b",
    "chunked,",
    ",chunked",
];
/// Values of `Content-Length`, for a body of five bytes.
const LENGTHS: &[&str] = &[
    "5",
    "5",
    "5",
    "0",
    "3",
    "10",
    "+5",
    "-5",
    "5, 5",
    "5,5",
    "5, 6",
    " 5",
    "5 ",
    "5\t",
    "05",
    "0x5",
    "5.0",
    "abc",
    "",
    "18446744073709551616",
    "9999999999999999999",
    "5;q=1",
    "\u{665}",
    "5 5",
];
/// Names a server may or may not take for `Content-Length` and `Transfer-Encoding`.
const LENGTH_NAMES: &[&str] = &[
    "content-length",
    "content-length",
    "content-length",
    "Content-Length",
    "CONTENT-LENGTH",
    "content-length ",
    "content-length\t",
    "content_length",
    "x-content-length",
    " content-length",
    "content-lengt",
    "content-length\0",
];
const CODING_NAMES: &[&str] = &[
    "transfer-encoding",
    "transfer-encoding",
    "transfer-encoding",
    "Transfer-Encoding",
    "TRANSFER-ENCODING",
    "transfer-encoding ",
    "transfer-encoding\t",
    "transfer_encoding",
    "x-transfer-encoding",
    " transfer-encoding",
    "transfer-encodin",
    "transfer-encoding\0",
];

/// A request's framing lines and its body. `wild`: from the whole grammar, and otherwise as a
/// client that follows HTTP frames a body.
fn framing(dice: &mut Dice, wild: bool) -> (Vec<String>, String) {
    if !wild {
        return match dice.below(10) {
            0..=5 => (Vec::new(), String::new()),
            6 | 7 => (vec!["content-length: 5".to_owned()], "hello".to_owned()),
            _ => (vec!["transfer-encoding: chunked".to_owned()], pick(dice, &CHUNKED[..5]).to_owned()),
        };
    }
    let length = |dice: &mut Dice| format!("{}: {}", pick(dice, LENGTH_NAMES), pick(dice, LENGTHS));
    let coding = |dice: &mut Dice| format!("{}: {}", pick(dice, CODING_NAMES), pick(dice, CODINGS));
    match dice.below(20) {
        // Most requests have no body.
        0..=9 => (Vec::new(), String::new()),
        10..=12 => (vec![length(dice)], "hello".to_owned()),
        13..=15 => (vec![coding(dice)], pick(dice, CHUNKED).to_owned()),
        // Both, in each order, with the body of either.
        16 => (vec![length(dice), coding(dice)], pick(dice, &["hello", CHUNKED[0], CHUNKED[4]]).to_owned()),
        17 => (vec![coding(dice), length(dice)], pick(dice, &["hello", CHUNKED[0], CHUNKED[4]]).to_owned()),
        // One of them twice.
        18 => (vec![length(dice), length(dice)], "hello".to_owned()),
        _ => (vec![coding(dice), coding(dice)], pick(dice, CHUNKED).to_owned()),
    }
}

/// One request from the grammar. `wild`: from the whole of it, and otherwise one a client that
/// follows HTTP sends, made of the first entries of each list.
fn request(dice: &mut Dice, wild: bool) -> Vec<u8> {
    let of = |dice: &mut Dice, all: &[&'static str], plain: usize| pick(dice, if wild { all } else { &all[..plain] });
    let mut lines = vec![format!("{} {} {}", of(dice, METHODS, 11), of(dice, TARGETS, 12), of(dice, VERSIONS, 8))];
    let (frames, body) = framing(dice, wild);
    let mut headers: Vec<String> = Vec::new();
    let asks = [of(dice, HOSTS, 8), of(dice, CONNECTIONS, 6), of(dice, ASKS, ASKS.len())];
    headers.extend(asks.into_iter().filter(|line| !line.is_empty()).map(str::to_owned));
    for _ in 0..dice.below(4) {
        headers.push(of(dice, LINES, 11).to_owned());
    }
    // A long line, of a length around the lower of the two limits on a head.
    if chance(dice, 6) {
        headers.push(format!("x-long: {}", "v".repeat(dice.below(1_500))));
    }
    // More headers than a head may have, once in a while.
    if wild && chance(dice, 3) {
        headers.extend((0..90 + dice.below(20)).map(|at| format!("x-{at}: 1")));
    }
    headers.extend(frames);
    // In any order: a server reads a head whatever the order of its lines.
    for at in (1..headers.len()).rev() {
        headers.swap(at, dice.below(at + 1));
    }
    lines.extend(headers);
    let end = match dice.below(40) {
        _ if !wild => "\r\n",
        0..=35 => "\r\n",
        36 | 37 => "\n",
        38 => "\r",
        _ => "\n\r",
    };
    let mut bytes = Vec::new();
    if wild && chance(dice, 8) {
        bytes.extend_from_slice(pick(dice, &["\r\n", "\r\n\r\n", "\n", " ", "\r"]).as_bytes());
    }
    for line in lines {
        // Latin-1, as a client that sends a byte over 127 sends it.
        bytes.extend(line.chars().map(|byte| if (byte as u32) < 256 { byte as u8 } else { b'?' }));
        bytes.extend_from_slice(end.as_bytes());
    }
    bytes.extend_from_slice(end.as_bytes());
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

/// `bytes` changed in one way a broken or hostile client changes a stream.
fn mutate(dice: &mut Dice, mut bytes: Vec<u8>) -> Vec<u8> {
    const ODD: &[u8] = b"\r\n \t:\0\x80,;=/";
    if bytes.is_empty() {
        return bytes;
    }
    let at = dice.below(bytes.len());
    match dice.below(7) {
        0 => bytes[at] = dice.below(256) as u8,
        1 => drop(bytes.remove(at)),
        2 => bytes.insert(at, ODD[dice.below(ODD.len())]),
        3 => bytes.truncate(at),
        how => {
            let mut lines: Vec<&[u8]> = bytes.split_inclusive(|byte| *byte == b'\n').collect();
            let (one, other) = (dice.below(lines.len()), dice.below(lines.len()));
            match how {
                4 => lines.insert(one, lines[one]),
                5 => lines.swap(one, other),
                _ => drop(lines.remove(one)),
            }
            bytes = lines.concat();
        }
    }
    bytes
}

/// The stream numbered `index` of the run with this seed: the fixed ones first.
fn stream(seed: u64, index: usize, bases: &[Vec<u8>]) -> Stream {
    let mut fixed = index;
    for base in bases {
        // Cut in two writes at each byte, then ended at each byte with the client's side closed.
        if fixed < 2 * base.len() {
            let (at, closes) = (fixed % base.len(), fixed >= base.len());
            let writes = if closes { vec![base[..at].to_vec()] } else { vec![base[..at].to_vec(), base[at..].to_vec()] };
            return Stream { index, writes, closes };
        }
        fixed -= 2 * base.len();
    }
    let mut dice = Dice(seed.wrapping_mul(1_000_003).wrapping_add(index as u64));
    let mut bytes = Vec::new();
    // Half the streams are of requests a client that follows HTTP sends, so both connections
    // answer them; in the others each request is as likely to be made from the whole grammar.
    let plain = chance(&mut dice, 50);
    for _ in 0..1 + dice.below(4) {
        let wild = !plain && chance(&mut dice, 50);
        bytes.extend(request(&mut dice, wild));
    }
    if chance(&mut dice, 30) {
        bytes = mutate(&mut dice, bytes);
    }
    let mut writes = Vec::new();
    if chance(&mut dice, 35) && bytes.len() > 1 {
        let mut cuts: Vec<usize> = (0..1 + dice.below(4)).map(|_| dice.below(bytes.len())).collect();
        cuts.sort_unstable();
        let mut from = 0;
        for cut in cuts {
            writes.push(bytes[from..cut].to_vec());
            from = cut;
        }
        writes.push(bytes[from..].to_vec());
        writes.retain(|write| !write.is_empty());
    } else {
        writes.push(bytes);
    }
    Stream { index, writes, closes: chance(&mut dice, 8) }
}

/// How many streams of a run are fixed.
fn fixed(bases: &[Vec<u8>]) -> usize {
    bases.iter().map(|base| 2 * base.len()).sum()
}

std::thread_local! {
    /// How many panics this thread has seen: a connection's task runs on the test's thread.
    static PANICS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Counts panics by thread, and leaves them reported as they were.
fn count_panics() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let reported = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic| {
            PANICS.set(PANICS.get() + 1);
            reported(panic);
        }));
    });
}

/// What a run found.
#[derive(Default)]
struct Found {
    streams: usize,
    /// Streams both connections answered the same, of which those with an answer of the app's.
    same: usize,
    answered: usize,
    /// Streams the last request was sent on, and those where it found the connection closed.
    asked: usize,
    /// Streams whose outcomes differ by a class on the list, and the first of them.
    listed: usize,
    first_listed: Option<String>,
    failures: Vec<String>,
}

/// Sends the streams `which` gives to both connections, under each of two limits on a head (the
/// app's own unless set, and one a long line of the grammar passes), and judges each.
async fn run(seed: u64, which: impl Iterator<Item = usize>) -> Found {
    count_panics();
    let bases = bases();
    // Hyper's connection and Corten's own, for each limit.
    let limits = [32 * 1024, 700];
    let servers = limits.map(|limit| (serve(false, limit), serve(true, limit)));
    let mut found = Found::default();
    let panics = PANICS.get();
    for index in which {
        let stream = stream(seed, index, &bases);
        let (hyper, own) = &servers[index % 2];
        let (theirs, ours) = (exchange(hyper, &stream).await, exchange(own, &stream).await);
        found.streams += 1;
        found.asked += usize::from(!ours.after.is_empty());
        let asked = if theirs.after.is_empty() && ours.after.is_empty() { 0 } else { last_request(index).len() };
        let verdict = judge(&theirs, &ours, stream.bytes().len() + asked >= limits[index % 2]);
        let describe = |what: &str| {
            let sent = String::from_utf8_lossy(&stream.bytes()).into_owned();
            let writes: Vec<usize> = stream.writes.iter().map(Vec::len).collect();
            format!(
                "stream {index} (seed {seed}, head limit {}): {what}\n  sent {sent:?}\n  in writes of {writes:?}, closed behind: {}\n  hyper: {theirs:?}\n  own:   {ours:?}",
                limits[index % 2],
                stream.closes
            )
        };
        match verdict {
            Verdict::Same => {
                found.same += 1;
                found.answered += usize::from(answers(&ours.before).iter().any(|answer| answer.apps));
            }
            Verdict::Listed(class) => {
                found.listed += 1;
                found.first_listed.get_or_insert_with(|| describe(class));
            }
            Verdict::Unlisted(class) => found.failures.push(describe(class)),
            Verdict::Laxer(class) => found.failures.push(describe(&format!("OWN IS LAXER: {class}"))),
        }
        if PANICS.get() != panics && found.failures.len() < 20 {
            found.failures.push(describe("a task panicked"));
            break;
        }
    }
    found
}

fn report(seed: u64, found: &Found) {
    let Found { streams, same, answered, asked, listed, first_listed, failures } = found;
    eprintln!(
        "H1 FUZZ seed={seed} streams={streams} same={same} (the app answered in {answered}) listed={listed} failed={} last_request_sent={asked}",
        failures.len()
    );
    if let Some(first) = first_listed {
        eprintln!("the first listed difference: {first}");
    }
    for failure in failures.iter().take(20) {
        eprintln!("{failure}");
    }
}

/// The gate, at the size the suite runs every time: the fixed streams and [`IN_SUITE`] made at
/// random.
#[tokio::test(start_paused = true)]
async fn own_and_hyper_answer_every_stream_alike() {
    let found = run(SEED, 0..fixed(&bases()) + IN_SUITE).await;
    report(SEED, &found);
    assert!(
        found.failures.is_empty(),
        "{} of {} streams fail the gate; the first:\n{}",
        found.failures.len(),
        found.streams,
        found.failures[0]
    );
    // The list lets through a few streams, not the run.
    assert!(found.listed * 100 < found.streams, "{} of {} streams differ by a listed class", found.listed, found.streams);
    // The run is of streams that reach the app, and that reach the end of what was sent.
    assert!(found.answered * 2 > found.streams, "the app answered in {} of {} streams", found.answered, found.streams);
    assert!(found.asked * 4 > found.streams, "the last request was sent on {} of {} streams", found.asked, found.streams);
}

/// The gate at the size a pull request reports: `H1_FUZZ_STREAMS` streams made at random (250,000
/// unless set) with the seed `H1_FUZZ_SEED` (this file's unless set), on as many threads as the
/// machine has. `cargo test --release -p corten-run --lib -- --ignored --nocapture
/// tests::h1_fuzz::own_and_hyper_answer_every_stream_of_a_long_run_alike`.
#[test]
#[ignore]
fn own_and_hyper_answer_every_stream_of_a_long_run_alike() {
    let number = |name: &str| std::env::var(name).ok().and_then(|number| number.parse::<u64>().ok());
    let seed = number("H1_FUZZ_SEED").unwrap_or(SEED);
    let streams = fixed(&bases()) + number("H1_FUZZ_STREAMS").unwrap_or(250_000) as usize;
    let threads = std::thread::available_parallelism().map_or(4, usize::from);
    let handles: Vec<_> = (0..threads)
        .map(|thread| {
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
                runtime.block_on(run(seed, (thread..streams).step_by(threads)))
            })
        })
        .collect();
    let mut all = Found::default();
    for handle in handles {
        let found = handle.join().expect("a thread of the run");
        all.streams += found.streams;
        all.same += found.same;
        all.answered += found.answered;
        all.asked += found.asked;
        all.listed += found.listed;
        all.first_listed = all.first_listed.or(found.first_listed);
        all.failures.extend(found.failures);
    }
    report(seed, &all);
    assert_eq!(all.streams, streams, "every stream was sent");
    assert!(all.failures.is_empty(), "{} of {} streams fail the gate", all.failures.len(), all.streams);
    assert!(all.listed * 100 < all.streams, "{} of {} streams differ by a listed class", all.listed, all.streams);
}

/// The judge fails what the gate says it fails: a difference is never taken for none, and a
/// laxer connection is named as one.
#[test]
fn the_judge_names_each_kind_of_difference() {
    let app =
        |status: u16, body: &str| format!("HTTP/1.1 {status} X\r\nx-content-type-options: nosniff\r\ndate: -\r\n\r\n{body}");
    let refusal = "HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\ndate: -\r\n\r\n".to_owned();
    let outcome = |before: &str, closed: bool, after: &str| Outcome {
        before: before.to_owned(),
        closed,
        after: after.to_owned(),
        closed_after: true,
    };
    let (one, two) = (app(200, "hi"), app(200, "hi") + &app(200, "hi"));
    let short = judge;
    let judge = |hyper: &Outcome, own: &Outcome| short(hyper, own, true);
    assert_eq!(judge(&outcome(&one, false, &one), &outcome(&one, false, &one)), Verdict::Same);
    let laxer = [
        (outcome(&one, true, ""), outcome(&two, true, "")),
        (outcome(&one, true, ""), outcome(&one, false, &one)),
        (outcome(&refusal, true, ""), outcome(&one, true, "")),
        (outcome("", true, ""), outcome(&one, true, "")),
        (outcome(&(one.clone() + &refusal), true, ""), outcome(&two, true, "")),
    ];
    for (hyper, own) in laxer {
        assert!(matches!(judge(&hyper, &own), Verdict::Laxer(_)), "{hyper:?} against {own:?}");
    }
    let unlisted = [
        (outcome(&two, true, ""), outcome(&one, true, "")),
        (outcome(&one, true, ""), outcome(&refusal, true, "")),
        (outcome(&one, true, ""), outcome(&app(200, "ho"), true, "")),
        (outcome(&one, true, ""), outcome(&app(404, "hi"), true, "")),
        (outcome(&one, false, ""), outcome(&one, true, "")),
        (outcome(&refusal, true, ""), outcome(&refusal.replace("HTTP/1.1", "HTTP/1.0"), true, "")),
    ];
    for (hyper, own) in unlisted {
        assert!(matches!(judge(&hyper, &own), Verdict::Unlisted(_)), "{hyper:?} against {own:?}");
    }
    // The one class on the list: the server's own refusal, as malformed by one and as too long by
    // the other, of a stream as long as the limit, and nothing else different.
    let long = refusal.replace("400 Bad Request", "431 Request Header Fields Too Large");
    let behind = |refusal: &str| outcome(&(one.clone() + refusal), true, "");
    for (hyper, own) in [(&refusal, &long), (&long, &refusal)] {
        assert_eq!(judge(&outcome(hyper, true, ""), &outcome(own, true, "")), Verdict::Listed(LIMIT_OR_GRAMMAR));
        assert_eq!(judge(&behind(hyper), &behind(own)), Verdict::Listed(LIMIT_OR_GRAMMAR));
        assert_eq!(judge(&outcome(&one, false, hyper), &outcome(&one, false, own)), Verdict::Listed(LIMIT_OR_GRAMMAR));
        // Not of a stream shorter than the limit.
        assert!(matches!(short(&outcome(hyper, true, ""), &outcome(own, true, ""), false), Verdict::Unlisted(_)));
        // Not with anything else different: an answer before it, or what closes.
        assert!(matches!(judge(&behind(hyper), &outcome(own, true, "")), Verdict::Unlisted(_)));
        assert!(matches!(judge(&outcome(hyper, true, ""), &behind(own)), Verdict::Laxer(_)));
        assert!(matches!(judge(&outcome(&one, false, hyper), &outcome(&one, true, own)), Verdict::Unlisted(_)));
    }
    // Not an answer of the app's with either status.
    let (bad, large) = (app(400, ""), app(431, ""));
    assert!(matches!(judge(&outcome(&bad, true, ""), &outcome(&large, true, "")), Verdict::Unlisted(_)));
}
