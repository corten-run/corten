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
//! twelve. Three streams in ten go over a pipe that holds little (64 bytes to 20 KB each way), so
//! the server's writes are taken in parts and wait for the client, one route's handler waits
//! before it answers, so requests arrive while one is being answered, and one route's body waits
//! between its pieces, so a piece can be ready as more of the stream, or its end, arrives. A
//! stream sent over such a pipe has a body only in requests whose handler reads all of it, and is
//! not changed at random if it has one ([`stream`] says why: with a body left unread there,
//! hyper 1.12.0 itself goes wrong). The streams before those
//! are fixed: each of a few requests cut in two writes at every byte, and ended at every byte.
//! The same number makes the same stream on every run.
//!
//! A request's body is read by the connection that read its head, so the two are compared in how
//! they read one: bodies of a known length and chunked ones, with extensions and trailers, of a
//! few bytes and of a few thousand, framed as the grammar has them and in every way the list of
//! wrong ones has ([`CHUNKED`], [`framing`]), to a handler that reads all of the body, one that
//! reads none, one that takes its first piece, one that gives it back as its answer and the
//! router's own answers, which read none.
//!
//! After a stream, if the server has not closed, one more request is sent that every server
//! answers: where a server took the stream's last message to end shows in whether, and how, that
//! request is answered.
//!
//! **What fails the gate**, for any stream:
//! 1. Corten's own connection is laxer than hyper's: it answers more requests than hyper does, or
//!    the app answers a request there that hyper refuses or does not answer.
//! 2. The two differ in any other way that is not on the list below: a byte of what they send
//!    other than the value of an answer's `Date` (the bytes are compared as they were sent, and
//!    nothing else in them is passed over), an answer more or fewer, a connection closed by one
//!    and kept by the other.
//! 3. A connection's task panics.
//! 4. A server hangs: no stream of the run finishes in two minutes of real time ([`STALLED`]).
//!    Time on a run's thread is tokio's own, which passes only when every task waits, so a server
//!    that never stops working on a stream is not seen from that thread: the test's thread
//!    watches, by the clock.
//!
//! **The differences on the list**, which is the whole of it ([`Verdict::Listed`]):
//! 1. A head that reaches the app's limit unfinished and is malformed further on is refused by
//!    both, with 400 by one and 431 by the other, and nothing else differs. Which of the two hyper
//!    answers depends on where its reads ended: 400 if the malformed bytes had arrived with the
//!    ones before the limit, 431 if they had not. Corten's own connection reads a head no further
//!    than the limit, and other bytes in reads of other sizes, so the same stream can be cut
//!    differently for it. The class is of that head and not of the stream: the bytes sent from
//!    where the first request neither server answered begins are as many as the limit
//!    ([`unanswered_from`]), whatever was sent and answered before them, and no head ends in
//!    the first that many of them ([`head_ends`]), whatever was sent behind it.
//! 2. A chunked body with an LF that has no CR before it among its trailers is refused by
//!    Corten's connection, which fails the body there and closes behind that request's answer,
//!    and taken by hyper's, which reads the LF for a byte of a trailer and goes on reading
//!    trailers through whatever the client sends next, to the next empty line (`crate::h1::body`
//!    says why Corten's does not follow it). The class is of a stream in which Corten's
//!    connection refused a body for that, by its own count of them, closed the connection, and
//!    answered every request before the last it answered as hyper's did; it is never one in
//!    which Corten's connection is the laxer.
//!
//! The servers of a run are on one thread, the run's own, over pipes in memory, with tokio's time
//! paused: a client that waits for the server to go quiet waits until every task is idle, not for
//! a guess at how long a loaded machine needs, so the same stream has the same outcome on every
//! run.
//!
//! **What the gate does not send** is in `docs/design.md#choice-own-http1`, under what would make
//! the connection the default.

use super::h1::{find, undated, Dice};
use super::*;
use bytes::Bytes;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

/// The seed of the run the pull request reports, and of the smaller one in the suite.
const SEED: u64 = 20_261_124;

/// How many streams made at random the suite's run sends, after the fixed ones.
const IN_SUITE: usize = 3_000;

/// How long a client waits before it takes the server to be waiting, in tokio's paused time,
/// which passes only when every task waits: well under the header timeout, which would close the
/// connection.
pub(super) const QUIET: Duration = Duration::from_secs(2);

/// How long a run may go without finishing a stream, in real time, before it is taken to hang.
/// A stream takes milliseconds.
const STALLED: Duration = Duration::from_secs(120);

/// Listens on a channel: a connection is one end of a pipe the test made.
pub(super) struct Piped(pub(super) tokio::sync::mpsc::UnboundedReceiver<DuplexStream>);

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
    // Longer than a client leaves between two writes, so what it sends next arrives while this
    // request is being answered.
    let wait = || async {
        tokio::time::sleep(Duration::from_millis(3)).await;
        "waited"
    };
    // A body whose last piece comes a millisecond after its first, which is how long a client
    // leaves between two writes and before it closes its side: so the piece is ready in the
    // turn that brings more of what the client sent, or its end, and the connection's task is
    // woken for both at once.
    let drip = || async {
        let pieces: [(u64, &'static [u8]); 2] = [(0, b"first"), (1, &X)];
        let pieces = futures_util::StreamExt::then(futures_util::stream::iter(pieces), |(wait, piece)| async move {
            if wait > 0 {
                tokio::time::sleep(Duration::from_millis(wait)).await;
            }
            Ok::<_, std::io::Error>(Bytes::from_static(piece))
        });
        Body::from_stream(pieces)
    };
    let table = Table::new()
        .route("/", get(|| async { "hi" }))
        .route("/json", get(|| async { ([(header::CONTENT_TYPE, "application/json")], r#"{"ok":true}"#) }))
        .route("/empty", get(|| async {}))
        .route("/stream", get(stream))
        .route("/drip", get(drip))
        .route("/none", get(|| async { StatusCode::NO_CONTENT }))
        .route("/close", get(|| async { ([(header::CONNECTION, "close")], "bye") }))
        .route("/wait", get(wait))
        .route("/unread", crate::router::any(|| async { "unread" }))
        .route("/read", crate::router::any(|body: Bytes| async move { format!("read {}", body.len()) }))
        .route("/first", crate::router::any(first))
        .route("/held", crate::router::any(held))
        .route("/echo", crate::router::any(echo))
        .route("/seen", crate::router::any(seen));
    App::new(Routes::from(table))
}

/// Whether the body's first frame came, and nothing of its length (the two connections cut a
/// body into pieces where their own reads end): the rest of the body is left unread.
async fn first(req: Request<Body>) -> &'static str {
    match req.into_body().frame().await {
        Some(Ok(_)) => "first",
        Some(Err(_)) => "first failed",
        None => "first none",
    }
}

/// [`first`], with the body held for longer than a client leaves between two writes before it is
/// dropped with the answer: hyper's connection, which reads a piece ahead of the app, has by
/// then read what the client sent meanwhile, and Corten's own has read none of it.
async fn held(req: Request<Body>) -> &'static str {
    let mut body = req.into_body();
    let read = match body.frame().await {
        Some(Ok(_)) => "held",
        Some(Err(_)) => "held failed",
        None => "held none",
    };
    tokio::time::sleep(Duration::from_millis(3)).await;
    drop(body);
    read
}

/// The request's body for the answer's, read as the answer is written and given whole at its
/// end, so the answer is the same however the body was cut into pieces; one that fails ends the
/// answer there.
async fn echo(req: Request<Body>) -> Body {
    let mut body = req.into_body();
    let whole = async move {
        let mut all = Vec::new();
        while let Some(frame) = body.frame().await {
            match frame {
                Ok(frame) => all.extend_from_slice(frame.data_ref().map_or(&[][..], |data| &data[..])),
                Err(_) => return Err(std::io::Error::other("the request's body failed")),
            }
        }
        Ok(Bytes::from(all))
    };
    Body::from_stream(futures_util::stream::once(whole))
}

/// A server for [`app`] with the connection `own` says and this limit on a head, and where to
/// send it a connection.
fn serve(own: bool, head: usize) -> tokio::sync::mpsc::UnboundedSender<DuplexStream> {
    serve_app(app(), own, head)
}

/// [`serve`], for an app of a test's own.
pub(super) fn serve_app(app: App, own: bool, head: usize) -> tokio::sync::mpsc::UnboundedSender<DuplexStream> {
    let (connect, accepted) = tokio::sync::mpsc::unbounded_channel();
    let app = app.own_http1(own).max_request_head(head);
    tokio::spawn(crate::app::run(vec![Piped(accepted)], crate::app::plain, app, std::future::pending()));
    connect
}

/// Bytes a server sent, as it sent them but for the value of each answer's `Date` ([`undated`]).
/// Shown as text; compared as bytes.
#[derive(PartialEq, Eq, Clone, Default)]
pub(super) struct Sent(pub(super) Vec<u8>);

impl std::fmt::Debug for Sent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", String::from_utf8_lossy(&self.0))
    }
}

impl From<&str> for Sent {
    fn from(text: &str) -> Sent {
        Sent(text.as_bytes().to_vec())
    }
}

/// What a server did with a stream.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Outcome {
    /// What it sent before the last request.
    pub(super) before: Sent,
    /// It closed the connection before the last request was sent.
    pub(super) closed: bool,
    /// What it sent to the last request.
    pub(super) after: Sent,
    pub(super) closed_after: bool,
}

/// What a client has received, and whether the server has closed the connection: filled by a
/// task that reads all the time, so a server is never kept waiting for its client to read.
#[derive(Default)]
struct Received {
    bytes: Vec<u8>,
    closed: bool,
}

impl Received {
    /// What the server has sent once it has gone quiet, as it sent it, and whether it has closed.
    async fn quiet(received: &Mutex<Received>) -> (Vec<u8>, bool) {
        tokio::time::sleep(QUIET).await;
        let received = received.lock().unwrap();
        (received.bytes.clone(), received.closed)
    }
}

/// The request sent behind a stream.
fn last_request(index: usize) -> String {
    format!("GET /seen?last={index} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n")
}

/// Sends a stream to a server, each write once the server has done all it will with the one
/// before, then the last request if the connection is still open and the client's side of it is.
pub(super) async fn exchange(connect: &tokio::sync::mpsc::UnboundedSender<DuplexStream>, stream: &Stream) -> Outcome {
    let (client, server) = tokio::io::duplex(stream.pipe);
    connect.send(server).expect("the server is listening");
    let (mut reading, mut client) = tokio::io::split(client);
    let received = Arc::new(Mutex::new(Received::default()));
    let reader = {
        let received = received.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let read = reading.read(&mut buf).await;
                let mut received = received.lock().unwrap();
                match read {
                    Ok(0) | Err(_) => break received.closed = true,
                    Ok(read) => received.bytes.extend_from_slice(&buf[..read]),
                }
            }
        })
    };
    for write in &stream.writes {
        if client.write_all(write).await.is_err() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    if stream.closes {
        let _ = client.shutdown().await;
    }
    let (first, closed) = Received::quiet(&received).await;
    let before = Sent(undated(&first));
    let (mut after, mut closed_after) = (Sent::default(), closed);
    if !closed && !stream.closes && client.write_all(last_request(stream.index).as_bytes()).await.is_ok() {
        let (all, closed) = Received::quiet(&received).await;
        after = Sent(behind(&first, &all));
        closed_after = closed;
    }
    reader.abort();
    Outcome { before, closed, after, closed_after }
}

/// What a server sent behind `first`, of `all` it sent, with each `Date` taken out as [`undated`]
/// takes it out. The dates are taken out of the whole, and what `first` gives without its own is
/// cut off its front, so an answer begun in `first` and ended behind it loses its date too. Where
/// `first` ends inside a `Date`'s own line the two differ from that date on, and what is behind
/// begins with what stands for it.
fn behind(first: &[u8], all: &[u8]) -> Vec<u8> {
    let (before, whole) = (undated(first), undated(all));
    let same = before.iter().zip(&whole).take_while(|(one, other)| one == other).count();
    whole[same..].to_vec()
}

/// One answer in what a server sent: its status, and whether the app made it (the server's own
/// refusals have none of the app's headers).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(super) struct Answer {
    pub(super) status: u16,
    pub(super) apps: bool,
}

/// The answers in `sent`. No body of [`app`]'s has a status line in it.
pub(super) fn answers(sent: &[u8]) -> Vec<Answer> {
    let sent = &*String::from_utf8_lossy(sent);
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

/// The first class of difference on the list.
const LIMIT_OR_GRAMMAR: &str = "a head that reaches the limit and is malformed further on: 400 from one, 431 from the other";

/// `outcome` with the status line of its last answer made the same whichever of the two it is,
/// where that answer is the server's own refusal of a head as malformed (400) or as too long
/// (431). `None` where its last answer is not one of those.
fn refusal_alike(outcome: &Outcome) -> Option<Outcome> {
    let alike = |sent: &Sent| {
        let sent = &sent.0[..];
        let at = sent.windows(7).rposition(|window| window == b"HTTP/1.")?;
        let end = at + find(&sent[at..], b"\r\n")?;
        let (version, status) = (sent.get(at..at + 8)?, sent.get(at + 8..end)?);
        let refusal = status == b" 400 Bad Request" || status == b" 431 Request Header Fields Too Large";
        let servers = answers(&sent[at..]).last().is_some_and(|answer| !answer.apps);
        (refusal && servers).then(|| Sent([&sent[..at], version, b" 4xx", &sent[end..]].concat()))
    };
    let (before, after) = (outcome.before.clone(), outcome.after.clone());
    let (before, after) = if answers(&after.0).is_empty() { (alike(&before)?, after) } else { (before, alike(&after)?) };
    Some(Outcome { before, closed: outcome.closed, after, closed_after: outcome.closed_after })
}

/// How long a chunked body at the start of `body` is, with its last chunk and its trailers:
/// `None` if it is not all there, or is not one.
fn chunked(body: &[u8]) -> Option<usize> {
    let mut at = 0;
    loop {
        let line = at + find(&body[at..], b"\n")? + 1;
        let digits = body[at..line].iter().take_while(|byte| byte.is_ascii_hexdigit()).count();
        let size = usize::from_str_radix(std::str::from_utf8(&body[at..at + digits]).ok()?, 16).ok()?;
        at = line;
        if size == 0 {
            // Its trailers, to the empty line.
            loop {
                let end = at + find(&body[at..], b"\n")? + 1;
                let empty = matches!(&body[at..end], b"\r\n" | b"\n");
                at = end;
                if empty {
                    return Some(at);
                }
            }
        }
        at = at.checked_add(size)?;
        at += body.get(at..)?.starts_with(b"\r\n").then_some(2)?;
    }
}

/// Where the first request the servers did not answer begins in `sent`, when they answered
/// `answered` requests before it: behind that many requests, each a head as the parser both
/// servers use reads it and the body its head frames (chunks, else a length, else none). `None`
/// when `sent` does not hold that many whole requests so read, and then no difference is taken
/// for a listed one.
fn unanswered_from(sent: &[u8], answered: usize) -> Option<usize> {
    let mut at = 0;
    for _ in 0..answered {
        let mut headers = [httparse::EMPTY_HEADER; 100];
        let mut request = httparse::Request::new(&mut headers);
        let httparse::Status::Complete(head) = request.parse(sent.get(at..)?).ok()? else { return None };
        let named = |name: &str| request.headers.iter().find(|header| header.name.eq_ignore_ascii_case(name));
        let body = &sent[at + head..];
        let body = if named("transfer-encoding").is_some() {
            chunked(body)?
        } else if let Some(length) = named("content-length") {
            let first = length.value.split(|byte| *byte == b',').next()?.trim_ascii();
            let length: usize = std::str::from_utf8(first).ok()?.parse().ok()?;
            (length <= body.len()).then_some(length)?
        } else {
            0
        };
        at += head + body;
    }
    Some(at)
}

/// Whether a head ends in `bytes`: an empty line behind its first line, with a CRLF or a bare LF
/// for a line end, as the parser both servers use takes one. The empty lines before a request
/// line end no head.
fn head_ends(mut bytes: &[u8]) -> bool {
    while let Some(rest) = bytes.strip_prefix(b"\r\n").or_else(|| bytes.strip_prefix(b"\n")) {
        bytes = rest;
    }
    bytes.windows(2).any(|pair| pair == b"\n\n") || bytes.windows(3).any(|three| three == b"\n\r\n")
}

/// Whether the head the servers refused reaches `limit`: the bytes sent from where the first
/// request they did not answer begins are that many, and no head ends in the first that many of
/// them (a head that ends there is whole and shorter than the limit, whatever was sent behind
/// it). `sent`: the stream, with the last request if it was sent.
fn refused_head_reaches(sent: &[u8], hyper: &Outcome, limit: usize) -> bool {
    // The refusal is the last of the answers, and the ones before it are of whole requests.
    let answered = (answers(&hyper.before.0).len() + answers(&hyper.after.0).len()).saturating_sub(1);
    unanswered_from(sent, answered).is_some_and(|from| sent.len() - from >= limit && !head_ends(&sent[from..from + limit]))
}

/// The other: Corten's connection refused a body for an LF with no CR before it among its
/// trailers, which hyper's takes for a byte of a trailer and reads on behind.
const BARE_LF: &str = "a body with a bare LF among its trailers: refused by own, read on by hyper";

/// Every answer a server sent, to the stream and to the last request.
fn all(outcome: &Outcome) -> Vec<Answer> {
    let mut all = answers(&outcome.before.0);
    all.extend(answers(&outcome.after.0));
    all
}

/// `reaches_limit`: the head the servers refused is as long as the app's limit on a head, or
/// longer ([`refused_head_reaches`]). `bare_lf`: Corten's connection refused a body of the stream
/// for an LF with no CR before it among its trailers.
fn judge(hyper: &Outcome, own: &Outcome, reaches_limit: bool, bare_lf: bool) -> Verdict {
    match differs(hyper, own, reaches_limit) {
        // The second class: never where Corten's connection is the laxer one, and only where it
        // closed the connection (at the request whose body it refused, which is so the last it
        // answered) and answered the requests before that one as hyper's did.
        Verdict::Unlisted(_)
            if bare_lf && own.closed && {
                let (theirs, ours) = (all(hyper), all(own));
                let before = ours.len().saturating_sub(1);
                theirs.len() >= before && theirs[..before] == ours[..before]
            } =>
        {
            Verdict::Listed(BARE_LF)
        }
        verdict => verdict,
    }
}

/// [`judge`], but for the second listed class.
fn differs(hyper: &Outcome, own: &Outcome, reaches_limit: bool) -> Verdict {
    if hyper == own {
        return Verdict::Same;
    }
    if reaches_limit && refusal_alike(hyper).is_some_and(|hyper| Some(hyper) == refusal_alike(own)) {
        return Verdict::Listed(LIMIT_OR_GRAMMAR);
    }
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
pub(super) struct Stream {
    pub(super) index: usize,
    /// What the client sends, in the writes it sends it in.
    pub(super) writes: Vec<Vec<u8>>,
    /// The client closes its side behind the last write.
    pub(super) closes: bool,
    /// How many bytes the pipe holds each way: what the server writes beyond that waits for the
    /// client to read, and is taken in parts.
    pub(super) pipe: usize,
}

/// A pipe that holds everything a stream sends and everything it is answered.
pub(super) const WIDE: usize = 1 << 20;

impl Stream {
    fn bytes(&self) -> Vec<u8> {
        self.writes.concat()
    }
}

/// The requests each cut in two writes at every byte, and ended at every byte: a whole request of
/// each kind the two connections treat differently, alone and behind another.
fn bases() -> Vec<Vec<u8>> {
    const CODED: &str = "transfer-encoding: chunked\r\n";
    let get = "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    let post = |path: &str, lines: &str| format!("POST {path} HTTP/1.1\r\nhost: localhost\r\n{lines}\r\n");
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
        // Bodies of both framings, read by Corten's connection: with extensions and trailers,
        // one behind another, expected, left unread, half read, framed twice, framed wrong, on
        // HTTP/1.0, and given back.
        format!("{}5;x=1\r\nhello\r\n6\r\n world\r\n0;last\r\nx-t: 1\r\n\r\n{get}", post("/seen", CODED)),
        format!("{}hello{}3\r\nabc\r\n0\r\n\r\n{get}", post("/read", "content-length: 5\r\n"), post("/seen", CODED)),
        format!("{}5\r\nhello\r\n0\r\n\r\n{get}", post("/seen", "transfer-encoding: chunked\r\nexpect: 100-continue\r\n")),
        format!("{}5\r\nhello\r\n0\r\n\r\n{get}", post("/unread", CODED)),
        format!("{}5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n{get}", post("/first", CODED)),
        format!("{}5\r\nhello\r\n0\r\n\r\n{get}", post("/seen", "content-length: 5\r\ntransfer-encoding: chunked\r\n")),
        format!("{}5\r\nhello\r\nz\r\n{get}", post("/seen", CODED)),
        "POST /seen HTTP/1.0\r\ncontent-length: 5\r\n\r\nhello".to_owned(),
        format!("{}hello world{get}", post("/echo", "content-length: 11\r\n")),
        // An answer that waits for its request's body, and a body held past its end: a client
        // gone by the body's end is written no more by either.
        format!(
            "{}5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n{get}",
            post("/echo", "transfer-encoding: chunked\r\nexpect: 100-continue\r\n")
        ),
        format!("{}5\r\nhello\r\n0\r\n\r\n{get}", post("/held", CODED)),
        format!("{}hello world{get}", post("/held", "content-length: 11\r\n")),
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
    "/wait",
    "/drip",
    "/json",
    "/empty",
    "/stream",
    "/none",
    "/close",
    "/read",
    "/unread",
    "/first",
    "/held",
    "/echo",
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
/// A chunked body, as the grammar has it (the first [`CHUNKED_PLAIN`]) and as it does not.
const CHUNKED: &[&str] = &[
    "5\r\nhello\r\n0\r\n\r\n",
    "5\r\nhello\r\n0\r\n\r\n",
    "5\r\nhello\r\n0\r\n\r\n",
    "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
    "0\r\n\r\n",
    "A\r\n0123456789\r\n0\r\n\r\n",
    "a\r\n0123456789\r\n0\r\n\r\n",
    "5;ext=1\r\nhello\r\n0\r\n\r\n",
    "5;ext=\"a b\"\r\nhello\r\n0;last\r\n\r\n",
    "5\r\nhello\r\n0\r\nx-t: 1\r\n\r\n",
    "1\r\na\r\n1\r\nb\r\n1\r\nc\r\n0\r\nx-t: 1\r\nx-u: 2\r\n\r\n",
    // Trailers named as the lines that frame a request: they frame nothing.
    "5\r\nhello\r\n0\r\ncontent-length: 9\r\ntransfer-encoding: gzip\r\nhost: other.example\r\n\r\n",
    "5\r\nhello\r\n0\r\nx-t : 1\r\n\r\n",
    "5\r\nhello\r\n0\r\nx-t: 1\r\n more\r\n\r\n",
    "5\r\nhello\r\n0\r\nx-t\r\n\r\n",
    "5\r\nhello\r\n0\r\nx-t: 1\rx-u: 2\r\n\r\n",
    // An LF with no CR before it among the trailers: the one thing in a body that Corten's
    // connection refuses and hyper's takes.
    "5\r\nhello\r\n0\r\nx-t: 1\n\r\n",
    "5\r\nhello\r\n0\r\n\n",
    "5;a\nhello\r\n0\r\n\r\n",
    "5;a\rb\r\nhello\r\n0\r\n\r\n",
    "5\t;x\r\nhello\r\n0\r\n\r\n",
    "5 5\r\nhello\r\n0\r\n\r\n",
    "5\rhello\r\n0\r\n\r\n",
    "5\r\nhello\n0\r\n\r\n",
    "5\r\nhello\r\n0\n\r\n",
    "5\r\nhello\r\n0\r\n\rX",
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

/// How many of [`CHUNKED`]'s bodies the grammar has.
const CHUNKED_PLAIN: usize = 12;

/// A body of `length` bytes that says where each of them is, so one read short, or twice, is not
/// the same to a handler.
fn payload(length: usize) -> String {
    (0..length).map(|at| char::from(b"0123456789abcdefghijklmnopqrstuvwxyz"[(at / 7 + at) % 36])).collect()
}

/// A chunked body the grammar has, made at random: up to six chunks of up to `most` bytes, some
/// with an extension, the last line with one sometimes, and up to three trailers.
fn chunks(dice: &mut Dice, most: usize) -> String {
    use std::fmt::Write;
    let mut body = String::new();
    for _ in 0..dice.below(7) {
        let data = payload(1 + dice.below(most));
        let size = if chance(dice, 50) { format!("{:x}", data.len()) } else { format!("{:X}", data.len()) };
        let extension = pick(dice, &["", "", "", ";e", ";e=1", ";e=\"a;b\"", " ;e", ";a;b=c"]);
        let _ = write!(body, "{size}{extension}\r\n{data}\r\n");
    }
    body.push_str(pick(dice, &["0", "0", "0", "00", "0;last"]));
    body.push_str("\r\n");
    for at in 0..dice.below(10).saturating_sub(6) {
        let _ = write!(body, "x-t{at}: {}\r\n", payload(dice.below(12)));
    }
    body + "\r\n"
}

/// A request's framing lines and its body. `wild`: from the whole grammar, and otherwise as a
/// client that follows HTTP frames a body. `bodied`: it may have one.
fn framing(dice: &mut Dice, wild: bool, bodied: bool) -> (Vec<String>, String) {
    if !bodied {
        return (Vec::new(), String::new());
    }
    if !wild {
        // One body in ten is longer than a read of Corten's connection, or than several.
        let most = if chance(dice, 10) { [700, 3_000, 6_000][dice.below(3)] } else { 12 };
        return match dice.below(12) {
            0..=5 => (Vec::new(), String::new()),
            6 | 7 => {
                let body = payload(dice.below(most));
                (vec![format!("content-length: {}", body.len())], body)
            }
            8 => (vec!["content-length: 5".to_owned()], "hello".to_owned()),
            9 => (vec!["transfer-encoding: chunked".to_owned()], pick(dice, &CHUNKED[..CHUNKED_PLAIN]).to_owned()),
            _ => (vec!["transfer-encoding: chunked".to_owned()], chunks(dice, most)),
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
/// follows HTTP sends, made of the first entries of each list. `bodied`: it may have a body.
fn request(dice: &mut Dice, wild: bool, bodied: bool) -> Vec<u8> {
    let of = |dice: &mut Dice, all: &[&'static str], plain: usize| pick(dice, if wild { all } else { &all[..plain] });
    let mut lines = vec![format!("{} {} {}", of(dice, METHODS, 11), of(dice, TARGETS, 15), of(dice, VERSIONS, 8))];
    let (frames, body) = framing(dice, wild, bodied);
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

/// A request with a body, framed as the grammar has it, to a route that reads all of it.
fn read_request(dice: &mut Dice) -> Vec<u8> {
    let framed = loop {
        let (lines, body) = framing(dice, false, true);
        if let Some(line) = lines.into_iter().next() {
            break format!("{line}\r\n\r\n{body}");
        }
    };
    // Not `/echo`, which answers before it has read: over a pipe that holds little, the head of
    // such an answer waits behind the answers before it on Corten's connection and has gone, in
    // part, on hyper's, when a client that has left is found at the body's end
    // (`h1_body::a_body_held_or_given_back_is_cut_where_each_connection_has_read`).
    let (method, target) = (pick(dice, &["POST", "PUT"]), pick(dice, &["/read", "/seen"]));
    format!("{method} {target} HTTP/1.1\r\nhost: localhost\r\n{framed}").into_bytes()
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
///
/// A stream that goes over a pipe that holds little has a body only in requests whose handler
/// reads all of it ([`read_request`]), and is not changed at random if it has one. With a body
/// left unread there, hyper 1.12.0 goes wrong by itself, so the gate would hold Corten's
/// connection to a fault. Where a handler leaves a chunked body unread and its answer waits for
/// the client in hyper's queue of buffers (it writes with `writev`), hyper finishes reading the
/// body after the answer is whole and before it is sent, and takes the connection for idle then.
/// It reads the next request with the answer before still queued, and from there: it does not
/// write that request's answer until something else wakes the connection (it waits on nothing of
/// its own), and a next request it refuses has its `400` written ahead of the queued rest of the
/// answer before (a debug build stops at hyper's own assertion there instead).
/// `docs/design.md#choice-own-http1` has it.
fn stream(seed: u64, index: usize, bases: &[Vec<u8>]) -> Stream {
    let mut fixed = index;
    for base in bases {
        // Cut in two writes at each byte, then ended at each byte with the client's side closed.
        if fixed < 2 * base.len() {
            let (at, closes) = (fixed % base.len(), fixed >= base.len());
            let writes = if closes { vec![base[..at].to_vec()] } else { vec![base[..at].to_vec(), base[at..].to_vec()] };
            return Stream { index, writes, closes, pipe: WIDE };
        }
        fixed -= 2 * base.len();
    }
    let mut dice = Dice(seed.wrapping_mul(1_000_003).wrapping_add(index as u64));
    let mut bytes = Vec::new();
    // Half the streams are of requests a client that follows HTTP sends, so both connections
    // answer them; in the others each request is as likely to be made from the whole grammar.
    let plain = chance(&mut dice, 50);
    let pipe = if chance(&mut dice, 30) { [64, 512, 4096, 20_000][dice.below(4)] } else { WIDE };
    let mut read = false;
    for _ in 0..1 + dice.below(4) {
        let wild = !plain && chance(&mut dice, 50);
        if pipe != WIDE && !wild && chance(&mut dice, 30) {
            bytes.extend(read_request(&mut dice));
            read = true;
        } else {
            bytes.extend(request(&mut dice, wild, pipe == WIDE));
        }
    }
    if chance(&mut dice, 30) && !read {
        bytes = mutate(&mut dice, bytes);
    }
    // And no request of such a stream asks to switch: behind one, hyper drops what it has
    // written and not flushed when the connection ends, and how much that is differs once
    // Corten's connection has answered a request with a body before it
    // (`a_refusal_behind_a_switch_is_cut_by_hyper_where_the_socket_was_full`). The line's name
    // and the method are made ones that ask for nothing.
    if read {
        for at in 0..bytes.len() {
            let line = at == 0 || bytes[at - 1] == b'\n';
            if line && bytes[at..].len() >= 8 && bytes[at..at + 8].eq_ignore_ascii_case(b"upgrade:") {
                bytes[at] = b'x';
            }
            if line && bytes[at..].starts_with(b"CONNECT ") {
                bytes[at..at + 7].copy_from_slice(b"OPTIONS");
            }
        }
    }
    // A handler that holds its body is sent its request whole, in one write no longer than
    // hyper's first read. hyper reads a piece ahead of the app, so while a body is held it has
    // read what came meanwhile, in pieces that end where its reads did, and Corten's connection
    // has read none of it: where the rest comes in several writes, or is longer than a read,
    // the two cut the body in different places and learn of its end, and of the client's
    // behind it, at different times. Those are differences `docs/design.md#choice-own-http1`
    // lists, each held by a fixed test, and not ones a stream made at random can be judged by;
    // such a stream goes to a route the app does not have, which reads no body either.
    const HELD: &[u8] = b" /held ";
    let held = find(&bytes, HELD).is_some();
    let whole = held && bytes.len() <= 8192;
    if held && !whole {
        while let Some(at) = find(&bytes, HELD) {
            bytes[at..at + HELD.len()].copy_from_slice(b" /hold ");
        }
    }
    let mut writes = Vec::new();
    if chance(&mut dice, 35) && bytes.len() > 1 && !whole {
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
    let closes = chance(&mut dice, 8);
    Stream { index, writes, closes, pipe }
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
    /// Streams whose outcomes differ by a class on the list, those of them by the second class,
    /// and the first of each.
    listed: usize,
    bare_lfs: usize,
    first_listed: Option<String>,
    first_bare_lf: Option<String>,
    failures: Vec<String>,
}

/// Sends the streams `which` gives to both connections, under each of two limits on a head (the
/// app's own unless set, and one a long line of the grammar passes), and judges each.
async fn run(seed: u64, which: impl Iterator<Item = usize>, done: &AtomicUsize) -> Found {
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
        // Both servers are on this thread, and only Corten's connection counts here.
        let bare_lfs = crate::h1::body::BARE_LFS.get();
        let (theirs, ours) = (exchange(hyper, &stream).await, exchange(own, &stream).await);
        let bare_lf = crate::h1::body::BARE_LFS.get() != bare_lfs;
        found.streams += 1;
        found.asked += usize::from(!ours.after.0.is_empty());
        let mut sent = stream.bytes();
        if !(theirs.after.0.is_empty() && ours.after.0.is_empty()) {
            sent.extend_from_slice(last_request(index).as_bytes());
        }
        let verdict = judge(&theirs, &ours, refused_head_reaches(&sent, &theirs, limits[index % 2]), bare_lf);
        let describe = |what: &str| {
            let sent = String::from_utf8_lossy(&stream.bytes()).into_owned();
            let writes: Vec<usize> = stream.writes.iter().map(Vec::len).collect();
            format!(
                "stream {index} (seed {seed}, head limit {}): {what}\n  sent {sent:?}\n  in writes of {writes:?}, closed behind: {}, over a pipe of {} bytes\n  hyper: {theirs:?}\n  own:   {ours:?}",
                limits[index % 2],
                stream.closes,
                stream.pipe
            )
        };
        match verdict {
            Verdict::Same => {
                found.same += 1;
                found.answered += usize::from(answers(&ours.before.0).iter().any(|answer| answer.apps));
            }
            Verdict::Listed(class) if class == BARE_LF => {
                found.listed += 1;
                found.bare_lfs += 1;
                found.first_bare_lf.get_or_insert_with(|| describe(class));
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
        done.fetch_add(1, SeqCst);
    }
    found
}

/// [`run`] for each of `parts`, each on a thread of its own with a runtime whose time is paused,
/// and what they found together. The caller's thread watches them by the clock: a run that
/// finishes no stream for `stalled` fails here, since a server that never stops working on a
/// stream keeps its own thread from ever seeing time pass.
fn watched<W>(seed: u64, parts: Vec<W>, stalled: Duration) -> Found
where
    W: Iterator<Item = usize> + Send + 'static,
{
    let done = Arc::new(AtomicUsize::new(0));
    let (finding, finds) = std::sync::mpsc::channel();
    let threads = parts.len();
    for part in parts {
        let (done, finding) = (done.clone(), finding.clone());
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
            let _ = finding.send(runtime.block_on(run(seed, part, &done)));
        });
    }
    drop(finding);
    let (mut all, mut seen) = (Found::default(), 0);
    for _ in 0..threads {
        let found = loop {
            match finds.recv_timeout(stalled) {
                Ok(found) => break found,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let now = done.load(SeqCst);
                    assert!(now != seen, "no stream of the run finished in {stalled:?}, after {now} had: a server hangs");
                    seen = now;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => panic!("a thread of the run panicked"),
            }
        };
        all.streams += found.streams;
        all.same += found.same;
        all.answered += found.answered;
        all.asked += found.asked;
        all.listed += found.listed;
        all.bare_lfs += found.bare_lfs;
        all.first_listed = all.first_listed.or(found.first_listed);
        all.first_bare_lf = all.first_bare_lf.or(found.first_bare_lf);
        all.failures.extend(found.failures);
    }
    all
}

fn report(seed: u64, found: &Found) {
    let Found { streams, same, answered, asked, listed, bare_lfs, first_listed, first_bare_lf, failures } = found;
    eprintln!(
        "H1 FUZZ seed={seed} streams={streams} same={same} (the app answered in {answered}) listed={listed} (a bare LF among trailers in {bare_lfs}) failed={} last_request_sent={asked}",
        failures.len()
    );
    for first in [first_listed, first_bare_lf].into_iter().flatten() {
        eprintln!("the first listed difference of its class: {first}");
    }
    for failure in failures.iter().take(20) {
        eprintln!("{failure}");
    }
}

/// The gate, at the size the suite runs every time: the fixed streams and [`IN_SUITE`] made at
/// random.
#[test]
fn own_and_hyper_answer_every_stream_alike() {
    let found = watched(SEED, std::iter::once(0..fixed(&bases()) + IN_SUITE).collect(), STALLED);
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
/// tests::h1_fuzz::own_and_hyper_answer_every_stream_of_a_long_run_alike`. With `H1_FUZZ_ONLY`
/// (stream numbers, comma separated) only those streams are sent, on one thread: a stream a run
/// names is sent again alone that way.
#[test]
#[ignore]
fn own_and_hyper_answer_every_stream_of_a_long_run_alike() {
    let number = |name: &str| std::env::var(name).ok().and_then(|number| number.parse::<u64>().ok());
    let seed = number("H1_FUZZ_SEED").unwrap_or(SEED);
    if let Ok(only) = std::env::var("H1_FUZZ_ONLY") {
        let only: Vec<usize> =
            only.split(',').map(|index| index.trim().parse().expect("H1_FUZZ_ONLY is stream numbers")).collect();
        let found = watched(seed, vec![only.into_iter()], STALLED);
        report(seed, &found);
        assert!(found.failures.is_empty(), "{} of {} streams fail the gate", found.failures.len(), found.streams);
        return;
    }
    let streams = fixed(&bases()) + number("H1_FUZZ_STREAMS").unwrap_or(250_000) as usize;
    let threads = std::thread::available_parallelism().map_or(4, usize::from);
    let all = watched(seed, (0..threads).map(|thread| (thread..streams).step_by(threads)).collect(), STALLED);
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
        before: before.into(),
        closed,
        after: after.into(),
        closed_after: true,
    };
    let (one, two) = (app(200, "hi"), app(200, "hi") + &app(200, "hi"));
    let (short, bare_lf) = (|hyper: &Outcome, own: &Outcome, reaches: bool| judge(hyper, own, reaches, false), judge);
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
    // The other class: Corten's connection refused a body for a bare LF among its trailers, said
    // so in that request's answer or sent none, and closed, where hyper's read on behind the
    // body and answered the request when the last one had come, or the one behind it too.
    let failed = app(200, "failed");
    let listed = [
        (outcome("", false, &one), outcome(&failed, true, "")),
        (outcome(&one, false, &two), outcome(&(one.clone() + &failed), true, "")),
        (outcome(&one, false, &one), outcome(&one, true, "")),
        (outcome(&one, false, &one), outcome(&(one.clone() + &app(400, "")), true, "")),
    ];
    for (hyper, own) in &listed {
        assert_eq!(bare_lf(hyper, own, false, true), Verdict::Listed(BARE_LF), "{hyper:?} against {own:?}");
        // Not of a stream in which no body was refused for one.
        assert!(matches!(bare_lf(hyper, own, false, false), Verdict::Unlisted(_)), "{hyper:?} against {own:?}");
    }
    // Not where Corten's connection is the laxer, kept its connection, or answered a request
    // before that one otherwise than hyper's; and the same is the same.
    assert!(matches!(bare_lf(&outcome(&one, true, ""), &outcome(&two, true, ""), false, true), Verdict::Laxer(_)));
    assert!(matches!(bare_lf(&outcome(&refusal, true, ""), &outcome(&one, true, ""), false, true), Verdict::Laxer(_)));
    assert!(matches!(bare_lf(&outcome(&one, false, &one), &outcome(&failed, false, ""), false, true), Verdict::Unlisted(_)));
    let other = outcome(&(app(404, "") + &failed), true, "");
    assert!(matches!(bare_lf(&outcome(&one, false, &two), &other, false, true), Verdict::Unlisted(_)));
    assert_eq!(bare_lf(&outcome(&one, true, ""), &outcome(&one, true, ""), false, true), Verdict::Same);
    // Not bytes that only read alike as text: what was sent is compared as it was sent.
    let odd = |byte: &[u8]| Outcome {
        before: Sent([one.as_bytes(), byte].concat()),
        closed: true,
        after: Sent::default(),
        closed_after: true,
    };
    assert_eq!(format!("{:?}", odd(b"\xff")), format!("{:?}", odd(b"\xfe")));
    assert!(matches!(judge(&odd(b"\xff"), &odd(b"\xfe")), Verdict::Unlisted(_)));
}

/// The listed class is of the head that was refused, not of the stream: a refusal counts as one
/// of a head that reaches the limit only when the bytes from where the first unanswered request
/// begins are as many as the limit, however long the requests answered before it were.
#[test]
fn the_listed_class_is_of_the_head_that_was_refused() {
    let get = "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    let post = "POST /read HTTP/1.1\r\nhost: localhost\r\ncontent-length: 5\r\n\r\nhello";
    let chunks =
        "POST /read HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\nA\r\n0123456789\r\n0\r\nx-t: 1\r\n\r\n";
    let long = format!("GET / HTTP/1.1\r\nhost: localhost\r\nx-long: {}\r\n", "v".repeat(700));
    let before = [get, post, chunks, "\r\n\r\nGET /none HTTP/1.1\nhost: localhost\n\n"].concat();
    // Where each request begins, by what is before it.
    for (answered, from) in [(0, 0), (1, get.len()), (2, get.len() + post.len()), (3, get.len() + post.len() + chunks.len())] {
        assert_eq!(unanswered_from(before.as_bytes(), answered), Some(from), "behind {answered} requests");
    }
    assert_eq!(unanswered_from(before.as_bytes(), 4), Some(before.len()));
    // Not behind more requests than were sent whole, and not past a body that is not all there.
    assert_eq!(unanswered_from(before.as_bytes(), 5), None);
    assert_eq!(unanswered_from(&post.as_bytes()[..post.len() - 1], 1), None);
    assert_eq!(unanswered_from(&chunks.as_bytes()[..chunks.len() - 2], 1), None);
    assert_eq!(unanswered_from(b"GET / HTTP/1.1\r\ncontent-length: five\r\n\r\n", 1), None);

    let app = "HTTP/1.1 200 OK\r\nx-content-type-options: nosniff\r\ndate: -\r\n\r\nhi";
    let refusal = "HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\ndate: -\r\n\r\n";
    let outcome = |answered: usize| Outcome {
        before: Sent::from(&*(app.repeat(answered) + refusal)),
        closed: true,
        after: Sent::default(),
        closed_after: true,
    };
    // A head of the limit's length, alone and behind answered requests: of the class.
    assert!(refused_head_reaches(long.as_bytes(), &outcome(0), 700));
    assert!(refused_head_reaches(format!("{}{long}", get.repeat(3)).as_bytes(), &outcome(3), 700));
    // A short head refused behind requests that are long together: not of it, though the stream
    // is longer than the limit. (The gate took this for a head that reaches the limit, before.)
    let short = format!("{}GET / HTTP/1.1\r\nhost : localhost\r\n\r\n", get.repeat(30));
    assert!(short.len() > 700);
    assert!(!refused_head_reaches(short.as_bytes(), &outcome(30), 700));
    // Nor a head a byte short of the limit, nor one where the requests before it cannot be told.
    assert!(!refused_head_reaches(&long.as_bytes()[..699], &outcome(0), 700));
    assert!(!refused_head_reaches(long.as_bytes(), &outcome(1), 700));
    // Nor a short head that is whole, refused with requests behind it that are long together:
    // the bytes from where it begins are as many as the limit, and it ends among the first of
    // them. (The gate took this too for a head that reaches the limit, by counting to the end of
    // everything sent.) So with a bare LF for a line end, and behind answered requests.
    let whole = format!("GET / HTTP/1.1\r\nhost : x\r\n\r\n{}", get.repeat(30));
    assert!(whole.len() > 700 + 28);
    assert!(!refused_head_reaches(whole.as_bytes(), &outcome(0), 700));
    assert!(!refused_head_reaches(whole.replace("\r\n", "\n").as_bytes(), &outcome(0), 700));
    assert!(!refused_head_reaches(format!("{get}{post}{whole}").as_bytes(), &outcome(2), 700));
    // A head that ends just past the limit reaches it, and so does one behind empty lines, which
    // end no head.
    let ends_past = format!("GET / HTTP/1.1\r\nhost: localhost\r\nx-long: {}\r\n\r\n{get}", "v".repeat(656));
    assert_eq!(find(ends_past.as_bytes(), b"\r\n\r\n"), Some(697));
    assert!(refused_head_reaches(ends_past.as_bytes(), &outcome(0), 700));
    assert!(!refused_head_reaches(ends_past.replacen('v', "", 1).as_bytes(), &outcome(0), 700));
    assert!(refused_head_reaches(format!("\r\n\r\n\n{long}").as_bytes(), &outcome(0), 700));
}

/// A run that stops finishing streams fails by the clock, though its own thread never sees time
/// pass: here a run whose next stream never comes.
#[test]
fn a_run_that_hangs_fails_by_the_clock() {
    let hangs = std::iter::repeat_with(|| -> usize {
        loop {
            std::thread::park();
        }
    });
    let watching = std::panic::catch_unwind(|| watched(SEED, vec![hangs], Duration::from_millis(300)));
    let message = watching.err().and_then(|panic| panic.downcast::<String>().ok()).expect("the run fails");
    assert!(message.contains("a server hangs"), "{message}");
}

/// What a server sent to the last request has its dates taken out wherever the bytes before it
/// ended: at an answer's end, inside an answer, and inside a `Date`'s own line.
#[test]
fn what_is_sent_behind_loses_its_dates_wherever_it_begins() {
    let answer = |date: &str| format!("HTTP/1.1 200 OK\r\ncontent-length: 2\r\ndate: {date}\r\n\r\nhi");
    let (one, other) = (answer("Thu, 26 Nov 2026 08:02:43 GMT"), answer("Thu, 26 Nov 2026 08:02:44 GMT"));
    let (all, others) = (one.repeat(3), other.repeat(3));
    for cut in 0..=all.len() {
        let (first, theirs) = (&all.as_bytes()[..cut], &others.as_bytes()[..cut]);
        let (ours, theirs) = (behind(first, all.as_bytes()), behind(theirs, others.as_bytes()));
        assert_eq!(ours, theirs, "cut at {cut}");
        assert!(find(&ours, b"2026").is_none(), "cut at {cut}: {:?}", Sent(ours));
    }
    // An answer's end: what is behind is the answers behind it, whole.
    assert_eq!(behind(one.as_bytes(), all.as_bytes()), undated(one.repeat(2).as_bytes()));
}

/// A connection whose handler left a body unread is kept by hyper only if one more read finishes
/// the body, so in a stream longer than hyper's reads, where the body ends decides whether the
/// request behind it is answered or the connection closed. hyper reads 8,192 bytes, then 16,384,
/// counted from the stream's start. Corten's connection reads a body its handler dropped as far
/// as 24,576 bytes (as many as those two reads) past what it had read when the body was dropped:
/// here the read that brought the request's head, its first, of 2,560 bytes. So where the body
/// ends past hyper's second read, by no more than Corten's first read is long, the request
/// behind it is answered with the switch on and not with it off; and where the requests before
/// it are longer than hyper's first read, hyper's connection has read further by the time it
/// meets the body (each read that fills doubles the next), and keeps a connection Corten's
/// closes. That is the one difference in what a connection with an unread body of one piece does
/// next, fixed here at its edges for the first and well inside it for the second: nothing is
/// answered twice or out of order, and the bytes before the cut are the same.
#[tokio::test(start_paused = true)]
async fn a_long_unread_body_is_cut_where_hypers_reads_end() {
    const READS: usize = 8_192 + 16_384;
    // Where Corten's connection gives up: as far past its first read.
    const PASSED: usize = crate::h1::FIRST + READS;
    let get = "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    let behind = "GET /json HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n";
    // A stream of `gets` requests, then one whose body ends `ends` bytes from where it begins,
    // then one more.
    let stream = |gets: usize, ends: usize| {
        let head = |length: usize| format!("POST /unread HTTP/1.1\r\nhost: localhost\r\ncontent-length: {length}\r\n\r\n");
        let length = ends - head(10_000).len();
        assert_eq!(head(length).len() + length, ends, "a length of five digits");
        let bytes = [get.repeat(gets).as_bytes(), head(length).as_bytes(), &vec![b'x'; length], behind.as_bytes()].concat();
        Stream { index: 0, writes: vec![bytes], closes: false, pipe: WIDE }
    };
    let (hyper, own) = (serve(false, 32 * 1024), serve(true, 32 * 1024));
    // How many requests come before the one with the body, where its body ends, and whether each
    // answers the request behind it (it kept the connection).
    let before = 10 * get.len();
    let cases = [
        (10, READS - before, true, true),
        (10, READS - before + 1, false, true),
        (10, PASSED - before, false, true),
        (10, PASSED - before + 1, false, false),
        // The head of the request with the body is cut by hyper's first read, so its own
        // connection has made a second by then and its third is of 32 KiB.
        (8_192 / get.len(), 30_000, true, true),
        (8_192 / get.len(), 40_000, true, false),
    ];
    for (gets, ends, hypers, owns) in cases {
        let stream = stream(gets, ends);
        let (theirs, ours) = (exchange(&hyper, &stream).await, exchange(&own, &stream).await);
        let statuses = |outcome: &Outcome| answers(&outcome.before.0).iter().map(|answer| answer.status).collect::<Vec<_>>();
        let what = format!("behind {gets} requests, a body that ends at {ends}");
        assert_eq!(statuses(&theirs), vec![200; gets + 1 + usize::from(hypers)], "hyper's, {what}");
        assert_eq!(statuses(&ours), vec![200; gets + 1 + usize::from(owns)], "own, {what}");
        assert!(theirs.closed && ours.closed, "{what}: {} and {}", theirs.closed, ours.closed);
        let (short, long) = if hypers { (&ours, &theirs) } else { (&theirs, &ours) };
        assert!(long.before.0.starts_with(&short.before.0), "{what}: the bytes before the cut differ");
        assert_eq!(hypers == owns, theirs == ours, "{what}");
    }
}

/// An answer that waits for its client to read it is cut when the client closes its side, on
/// both connections: hyper looks for the client's end each time its task is woken while a request
/// is being answered and nothing the client sent is unread, before it writes any more, and gives
/// up the request when it finds it; Corten's connection looks where a write of its has waited.
/// So a client that reads some of a long answer and closes its side gets what the pipe held by
/// then and no more, where a client that stays gets all of it: an answer of a known length, a
/// stream, a stream that waits for its next piece, and an answer short enough that its
/// connection has gone on to wait for the next request.
/// The same number of bytes from both, whether the client's end comes with the room it made by
/// reading (then nothing more is written) or a moment later (then that room is filled first).
/// The gate's own clients read all the time, so no stream of it has this.
#[tokio::test(start_paused = true)]
async fn an_answer_that_waits_for_its_client_is_cut_when_the_client_closes_its_side() {
    const PIPE: usize = 4_096;
    const READ: usize = 2_000;
    static PIECE: [u8; 20 * 1024] = [b'p'; 20 * 1024];
    let app = || {
        let pieces =
            |count: usize| futures_util::stream::iter((0..count).map(|_| Ok::<_, std::io::Error>(Bytes::from_static(&PIECE))));
        // Its second piece comes long after a client of this test has closed its side.
        let drip = move || async move {
            let later = async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok::<_, std::io::Error>(Bytes::from_static(&PIECE))
            };
            Body::from_stream(futures_util::StreamExt::chain(pieces(1), futures_util::stream::once(later)))
        };
        let table = Table::new()
            .route("/whole", get(|| async { vec![b'w'; 1 << 20] }))
            .route("/stream", get(move || async move { Body::from_stream(pieces(52)) }))
            .route("/drip", get(drip))
            .route("/short", get(|| async { vec![b's'; 10 * 1024] }));
        App::new(Routes::from(table))
    };
    let (hyper, own) = (serve_app(app(), false, 32 * 1024), serve_app(app(), true, 32 * 1024));
    // What a client receives that reads `READ` bytes and then, if it does not stay, closes its
    // side, at once or a moment later, and reads to the end. `asks`: its request asks for the
    // connection to be closed behind the answer, which a client that stays always does.
    type Connect = tokio::sync::mpsc::UnboundedSender<DuplexStream>;
    let receive = |connect: &Connect, path: &str, stays: bool, asks: bool, later: bool| {
        let (mut client, server) = tokio::io::duplex(PIPE);
        connect.send(server).expect("the server is listening");
        let close = if stays || asks { "connection: close\r\n" } else { "" };
        let request = format!("GET {path} HTTP/1.1\r\nhost: localhost\r\n{close}\r\n");
        async move {
            client.write_all(request.as_bytes()).await.unwrap();
            let mut first = vec![0u8; READ];
            client.read_exact(&mut first).await.unwrap();
            if later {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            if !stays {
                client.shutdown().await.unwrap();
            }
            let mut rest = Vec::new();
            client.read_to_end(&mut rest).await.unwrap();
            READ + rest.len()
        }
    };
    let paths = [("/whole", 1 << 20), ("/stream", 52 * PIECE.len()), ("/drip", 2 * PIECE.len()), ("/short", 10 * 1024)];
    for (path, least) in paths {
        let (theirs, ours) = (receive(&hyper, path, true, true, false).await, receive(&own, path, true, true, false).await);
        assert!(theirs > least && ours == theirs, "{path}, a client that stays: {ours} bytes and hyper's {theirs}");
        for (asks, later) in [(false, false), (false, true), (true, false), (true, true)] {
            let theirs = receive(&hyper, path, false, asks, later).await;
            let ours = receive(&own, path, false, asks, later).await;
            let when = if later { "a moment later" } else { "at once" };
            let name = format!("{path}, the client's end {when}, asks to close: {asks}");
            assert_eq!(ours, theirs, "{name}: bytes sent before the answer was cut");
            assert!((PIPE..=PIPE + READ).contains(&ours), "{name}: {ours} bytes");
        }
    }
}

/// A request that comes with its client's end behind it (the client sent it and closed its side
/// before the server read either) is answered by neither connection, however quick its handler:
/// hyper looks at the socket each time it has read a head with nothing behind it, and answers
/// nothing more to a client that has closed its side by then, and Corten's connection looks
/// there too, before it asks the handler. Requests with others behind them are answered: the
/// client's end is behind those. The gate's own clients close a moment after they send, so it
/// meets this only where a handler's wait ends as its client closes (eight streams of its long
/// run did, while Corten's connection looked only after a wait); here the client's end is in the
/// pipe with the request before the server is given the connection.
///
/// That is the rule where a read says all that has arrived, as a pipe's does. A socket just
/// accepted can say less: tokio takes it for readable before its first event has come, so the
/// first read can take the requests with nothing yet known of the client's end behind them, and
/// then the last request is answered as well, by both connections alike, which learn of the end
/// when their task next waits. On a connection the server already holds, a socket says what a
/// pipe does (`tests::h1::answers_made_are_sent_before_the_connection_closes` has both).
#[tokio::test(start_paused = true)]
async fn a_request_that_comes_with_its_clients_end_is_answered_by_neither() {
    let get = |path: &str| format!("GET {path} HTTP/1.1\r\nhost: localhost\r\n\r\n");
    let (hyper, own) = (serve(false, 32 * 1024), serve(true, 32 * 1024));
    // What a client sends before it closes its side, and how many of its requests are answered.
    let cases = [
        ("one request", get("/"), 0),
        ("three requests", get("/").repeat(3), 2),
        ("one whose handler waits", get("/wait"), 0),
        ("one behind one whose handler waits", format!("{}{}", get("/wait"), get("/")), 1),
    ];
    for (name, sent, answered) in cases {
        let mut got = Vec::new();
        for (which, connect) in [("hyper's", &hyper), ("own", &own)] {
            let (mut client, server) = tokio::io::duplex(WIDE);
            client.write_all(sent.as_bytes()).await.unwrap();
            client.shutdown().await.unwrap();
            connect.send(server).expect("the server is listening");
            let mut all = Vec::new();
            client.read_to_end(&mut all).await.unwrap();
            let statuses = answers(&all).iter().map(|answer| answer.status).collect::<Vec<_>>();
            assert_eq!(statuses, vec![200; answered], "{which}, {name}: {:?}", String::from_utf8_lossy(&all));
            got.push(undated(&all));
        }
        assert_eq!(got[1], got[0], "{name}");
    }
}

/// A piece of an answer's body that is ready when its connection's task is next polled is not
/// written to a client that has closed its side by then, on either connection: hyper reads
/// before it writes each time its task is woken with an answer unfinished, and Corten's
/// connection looks for the client's end before it asks a body for more, once its task has
/// waited since the answer's head was written. Here the piece and the client's end come at the
/// same moment, over a pipe wide enough that no write waits: an answer's last piece (which
/// Corten's connection wrote before it looked there, 21,166 bytes where hyper sent 673), and a
/// piece with one more to come behind it. A moment sooner the piece has not come, and the
/// answer is cut before it by both; a moment later it has gone, from both.
#[tokio::test(start_paused = true)]
async fn a_bodys_piece_that_is_ready_with_its_clients_end_is_not_sent() {
    static PIECE: [u8; 20 * 1024] = [b'p'; 20 * 1024];
    let app = || {
        let later = || async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok::<_, std::io::Error>(Bytes::from_static(&PIECE))
        };
        let first = || futures_util::stream::iter([Ok::<_, std::io::Error>(Bytes::from_static(b"first"))]);
        // `first`, and a piece 50 ms later.
        let two = move || async move {
            Body::from_stream(futures_util::StreamExt::chain(first(), futures_util::stream::once(later())))
        };
        // And one more, 50 ms after that.
        let three = move || async move {
            let second = futures_util::StreamExt::chain(first(), futures_util::stream::once(later()));
            Body::from_stream(futures_util::StreamExt::chain(second, futures_util::stream::once(later())))
        };
        App::new(Routes::from(Table::new().route("/two", get(two)).route("/three", get(three))))
    };
    let (hyper, own) = (serve_app(app(), false, 32 * 1024), serve_app(app(), true, 32 * 1024));
    // How many bytes a client receives that closes its side `wait` ms after it sent its request
    // and reads to the end.
    type Connect = tokio::sync::mpsc::UnboundedSender<DuplexStream>;
    let receive = |connect: &Connect, path: &str, wait: u64| {
        let (mut client, server) = tokio::io::duplex(WIDE);
        connect.send(server).expect("the server is listening");
        let request = format!("GET {path} HTTP/1.1\r\nhost: localhost\r\n\r\n");
        async move {
            client.write_all(request.as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(wait)).await;
            client.shutdown().await.unwrap();
            let mut all = Vec::new();
            client.read_to_end(&mut all).await.unwrap();
            all.len()
        }
    };
    // When the client closes its side, and how many of the body's 20 KiB pieces it has by then.
    let cases = [
        ("/two", 49, 0),
        ("/two", 50, 0),
        ("/two", 51, 1),
        ("/three", 50, 0),
        ("/three", 51, 1),
        ("/three", 99, 1),
        ("/three", 100, 1),
        ("/three", 101, 2),
    ];
    for (path, wait, pieces) in cases {
        let (theirs, ours) = (receive(&hyper, path, wait).await, receive(&own, path, wait).await);
        assert_eq!(ours, theirs, "{path}, the client's end at {wait} ms: bytes sent, and hyper's");
        assert_eq!(theirs / PIECE.len(), pieces, "{path}, the client's end at {wait} ms: {theirs} bytes from hyper");
    }
}

/// Shutdown that begins while an answer waits for its client to read it does not make the
/// connection finish that answer for a client that closes its side, on either connection:
/// hyper goes on looking for the client's end while it drains, and Corten's connection, which
/// sends what is unsent before it closes, looks while that waits. An answer short enough that
/// its connection has gone on to wait for the next request, and one that has not. A client that
/// stays and reads has all of it from both; one that closes its side, after shutdown began,
/// before, or in the same turn of the server (in either order), has what the pipe held.
#[tokio::test(start_paused = true)]
async fn an_answer_that_waits_when_shutdown_begins_is_cut_when_its_client_closes_its_side() {
    let app = || {
        let table = Table::new()
            .route("/short", get(|| async { vec![b's'; 3_000] }))
            .route("/long", get(|| async { vec![b'l'; 10 * 1024] }));
        App::new(Routes::from(table))
    };
    let moment = || tokio::time::sleep(Duration::from_millis(5));
    // Whether the client closes its side, whether it does before shutdown begins, and whether
    // the server's tasks run between the two.
    let sequences = [
        ("the client stays", false, false, true),
        ("shutdown, then the client's end", true, false, true),
        ("the client's end, then shutdown", true, true, true),
        ("shutdown and the client's end at once", true, false, false),
        ("the client's end and shutdown at once", true, true, false),
    ];
    for (path, pipe, whole) in [("/short", 1_024, 3_000), ("/long", 4_096, 10 * 1024)] {
        for (name, leaves, first, apart) in sequences {
            let mut got = Vec::new();
            for own in [false, true] {
                let (connect, accepted) = tokio::sync::mpsc::unbounded_channel();
                let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
                let served = app().own_http1(own).max_request_head(32 * 1024);
                let server = tokio::spawn(crate::app::run(vec![Piped(accepted)], crate::app::plain, served, async {
                    let _ = stopped.await;
                }));
                let (mut client, io) = tokio::io::duplex(pipe);
                connect.send(io).expect("the server is listening");
                client.write_all(format!("GET {path} HTTP/1.1\r\nhost: localhost\r\n\r\n").as_bytes()).await.unwrap();
                moment().await;
                if leaves && first {
                    client.shutdown().await.unwrap();
                    if apart {
                        moment().await;
                    }
                }
                stop.send(()).unwrap();
                if apart {
                    moment().await;
                }
                if leaves && !first {
                    client.shutdown().await.unwrap();
                }
                moment().await;
                let mut all = Vec::new();
                client.read_to_end(&mut all).await.unwrap();
                tokio::time::timeout(Duration::from_secs(10), server).await.expect("shutdown ends").unwrap().unwrap();
                got.push(all.len());
            }
            assert_eq!(got[1], got[0], "{path}, {name}: bytes sent, and hyper's");
            if leaves {
                assert_eq!(got[0], pipe, "{path}, {name}: hyper's connection sent what the pipe held");
            } else {
                assert!(got[0] > whole, "{path}, {name}: {} bytes from hyper's connection", got[0]);
            }
        }
    }
}

/// The answers before one that is given up are the client's, and wait for it to read them, on
/// both connections alike. A client pipelines requests whose first answer is longer than the
/// pipe holds, closes its side and reads nothing for a second. Corten's connection, where it
/// has made every answer by then, finds the client's end where its write waits, takes back the
/// last answer (none of it has gone) and goes on sending the ones before it; hyper's has begun
/// none but the first, whose flush waits with the requests behind it unread, and it looks for
/// no client's end past them. So neither drops the connection when the client's end comes: when
/// the client reads at last it has every answer but the last, whole, from both. (How long
/// either waits is the send timeout's to say, as for any write that waits:
/// `tests::h1::a_client_that_pipelines_and_reads_nothing_is_closed_at_the_send_timeout`.)
#[tokio::test(start_paused = true)]
async fn the_answers_before_one_given_up_wait_for_their_client_on_both_connections() {
    const PIPE: usize = 1_024;
    const SHORT: usize = 3_000;
    let app = || {
        let table = Table::new()
            .route("/", get(|| async { "hi" }))
            .route("/short", get(|| async { vec![b's'; SHORT] }))
            .route("/mid", get(|| async { vec![b'm'; 30 * 1024] }));
        App::new(Routes::from(table))
    };
    let (hyper, own) = (serve_app(app(), false, 32 * 1024), serve_app(app(), true, 32 * 1024));
    // The first two have Corten's connection take an answer back; in the third the answer its
    // write waits in has requests unread behind it, as hyper's always has.
    for paths in [vec!["/short", "/"], vec!["/short", "/short", "/"], vec!["/short", "/mid"], vec!["/mid", "/short", "/"]] {
        let sent: String = paths.iter().map(|path| format!("GET {path} HTTP/1.1\r\nhost: localhost\r\n\r\n")).collect();
        let mut got = Vec::new();
        for (which, connect) in [("hyper's", &hyper), ("own", &own)] {
            let (mut client, server) = tokio::io::duplex(PIPE);
            connect.send(server).expect("the server is listening");
            client.write_all(sent.as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(5)).await;
            client.shutdown().await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
            let mut all = Vec::new();
            client.read_to_end(&mut all).await.unwrap();
            let statuses = answers(&all).iter().map(|answer| answer.status).collect::<Vec<_>>();
            assert_eq!(statuses, vec![200; paths.len() - 1], "{which}, {paths:?}: {} bytes", all.len());
            assert!(all.len() > SHORT, "{which}, {paths:?}: {} bytes, where the pipe holds {PIPE}", all.len());
            got.push(undated(&all));
        }
        assert_eq!(got[1], got[0], "{paths:?}");
    }
}

/// How many handlers each connection runs for a client that sends requests and reads nothing,
/// which is where the two differ most in what an app is asked to do: hyper's flushes each
/// answer before it reads the next request, so it runs one handler beyond what the socket
/// takes; Corten's runs handlers until 16 KiB of answers are written and not taken
/// ([`crate::h1::FLUSH_AT`]). Over a pipe that holds 64 bytes, with 400 requests sent, that is
/// one handler against as many as 16 KiB and the pipe's 64 bytes hold of an app's `hi` with
/// the headers an app sends unless it says otherwise, whether the handler waits or not and
/// whether the requests come together or one every 10 ms: 24 for the answer of 697 bytes a
/// build with the crate's default features writes, and 23 for the 720 bytes of a build with
/// every feature. (`tests::h1` holds the bound for answers with no header of the app's, where
/// the same 16 KiB is 213 handlers, and 219 for an answer with no body.) A request with a body
/// is no different: Corten's connection reads its body and runs its handler as it does for
/// one without, so as many `POST`s are handled for such a client as `GET`s.
#[tokio::test(start_paused = true)]
async fn handlers_run_ahead_of_a_client_that_reads_nothing_on_cortens_connection_and_not_on_hypers() {
    const PIPE: usize = 64;
    const GET: &[u8] = b"GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    const POST: &[u8] = b"POST / HTTP/1.1\r\nhost: localhost\r\ncontent-length: 5\r\n\r\nhello";
    for (waits, sent) in [(false, GET), (true, GET), (false, POST), (true, POST)] {
        for together in [true, false] {
            let mut ahead = Vec::new();
            for own in [false, true] {
                let ran = Arc::new(AtomicUsize::new(0));
                let handler = {
                    let ran = ran.clone();
                    move |body: Bytes| {
                        let ran = ran.clone();
                        async move {
                            assert_eq!(body.is_empty(), sent == GET, "the handler has its request's body");
                            ran.fetch_add(1, SeqCst);
                            if waits {
                                tokio::time::sleep(Duration::from_millis(1)).await;
                            }
                            "hi"
                        }
                    }
                };
                let table = Table::new().route("/", crate::router::any(handler));
                let connect = serve_app(App::new(Routes::from(table)), own, 32 * 1024);
                // How long one answer is, from a connection of its own.
                let (mut alone, server) = tokio::io::duplex(1 << 20);
                connect.send(server).expect("the server is listening");
                alone.write_all(sent).await.unwrap();
                tokio::time::sleep(QUIET).await;
                let mut answer = vec![0; 8 * 1024];
                let each = alone.read(&mut answer).await.unwrap();
                drop(alone);
                ran.store(0, SeqCst);
                let (client, server) = tokio::io::duplex(PIPE);
                connect.send(server).expect("the server is listening");
                let (reads, mut writes) = tokio::io::split(client);
                let writer = tokio::spawn(async move {
                    for _ in 0..400 {
                        if writes.write_all(sent).await.is_err() {
                            break;
                        }
                        if !together {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                    }
                    // The client stays: it has not closed its side.
                    std::future::pending::<()>().await;
                });
                tokio::time::sleep(Duration::from_secs(8)).await;
                let ran = ran.load(SeqCst);
                let name = format!(
                    "own: {own}, a body: {}, the handler waits: {waits}, requests together: {together}, an answer of {each} bytes",
                    sent == POST
                );
                if own {
                    // Every handler but the last began with less than 16 KiB of answers unsent
                    // beyond what the pipe took.
                    let bound = (crate::h1::FLUSH_AT + PIPE).div_ceil(each);
                    assert_eq!(ran, bound, "{name}");
                } else {
                    assert_eq!(ran, 1, "{name}");
                }
                ahead.push((each, ran));
                writer.abort();
                drop(reads);
            }
            // The same answer from both, of a length that is the build's: its features say which
            // headers an app sends.
            let name = format!("a body: {}, the handler waits: {waits}, requests together: {together}", sent == POST);
            assert!(ahead[0].0 == ahead[1].0 && (600..=800).contains(&ahead[0].0), "{name}: {ahead:?}");
            assert!((21..=28).contains(&ahead[1].1), "{name}: {ahead:?}");
            println!(
                "{name}: an answer of {} bytes, {} handler on hyper's connection, {} on Corten's",
                ahead[0].0, ahead[0].1, ahead[1].1
            );
        }
    }
}

/// **hyper cuts a refusal short behind a request that asked to switch, and where it cuts depends
/// on what the socket had taken.** A request with an `Upgrade` line leaves hyper with a switch
/// it may be asked to make; when the connection then ends (a head behind it is refused), hyper
/// gives the connection up for that switch without sending what it has written and not yet
/// flushed (`Dispatcher::poll_inner`, which returns `Dispatched::Upgrade` before
/// `poll_shutdown`). Over a pipe that holds little, part of the refusal, or more, is lost: by
/// hyper's own connection, and by the one Corten's connection hands to hyper at the switch,
/// which is hyper's from there.
///
/// With nothing before the switch but requests that have no body, the two lose the same bytes at
/// every size of pipe tried. With requests before it that have bodies they do not: hyper's task
/// waits once for each body (it reads the body in one turn and has the handler's answer in the
/// next), its client takes what the pipe holds meanwhile, and so less waits unsent when the
/// refusal is written; Corten's connection answers both in one turn and sends them before it
/// hands over. Nothing differs but how much of what hyper wrote last was lost: what one sent is
/// the beginning of what the other sent, and both closed.
///
/// So the gate sends no request that switches in a stream that has a body over a pipe that
/// holds little ([`stream`]), and this holds both sides of it.
#[tokio::test(start_paused = true)]
async fn a_refusal_behind_a_switch_is_cut_by_hyper_where_the_socket_was_full() {
    let get = "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n";
    let switch = "HEAD /drip HTTP/1.1\r\nupgrade: websocket\r\nhost: localhost\r\n\r\n";
    let wrong = "PUT http://other.example/ \r\nhost: localhost\r\nx-a: 1\r\r\n\r\n";
    let bodies = "PUT /read HTTP/1.1\r\nhost: localhost\r\ntransfer-encoding: chunked\r\n\r\n0\r\nx-t: 1\r\n\r\n\
                  POST /read HTTP/1.1\r\nhost: localhost\r\ntransfer-encoding: chunked\r\n\r\n\
                  b;a\r\n012345689ab\r\n4\r\n0123\r\n2\r\n01\r\n6\r\n012345\r\nC\r\n012345689abc\r\nC\r\n012345689abc\r\n0\r\n\r\n";
    let (hyper, own) = (serve(false, 700), serve(true, 700));
    let whole = |outcome: &Outcome| outcome.before.0.ends_with(b"content-length: 0\r\ndate: -\r\n\r\n");
    for (name, before, alike) in [
        ("no request before", "", true),
        ("two without bodies", &*format!("{get}{get}"), true),
        ("two with bodies", bodies, false),
    ] {
        let (mut cut, mut differ) = (0, 0);
        for pipe in (64..1200).step_by(3) {
            let bytes = format!("{before}{switch}{wrong}").into_bytes();
            let stream = Stream { index: 0, writes: vec![bytes], closes: false, pipe };
            let (theirs, ours) = (exchange(&hyper, &stream).await, exchange(&own, &stream).await);
            assert!(theirs.closed && ours.closed, "{name}, a pipe of {pipe}: hyper's {theirs:?}\nown: {ours:?}");
            cut += usize::from(!whole(&theirs));
            if theirs == ours {
                continue;
            }
            differ += 1;
            assert!(!alike, "{name}, a pipe of {pipe}: hyper's {theirs:?}\nown: {ours:?}");
            // What each sent, to its end, or to its last `Date` where it ends inside that line's
            // value, which is compared nowhere.
            let sent = |outcome: &Outcome| {
                let sent = outcome.before.0.clone();
                match sent.windows(6).rposition(|part| part == b"date: ") {
                    Some(at) if !sent[at..].contains(&b'\n') => sent[..at + 6].to_vec(),
                    _ => sent,
                }
            };
            let (theirs, ours) = (sent(&theirs), sent(&ours));
            let (more, fewer) = if theirs.len() > ours.len() { (&theirs, &ours) } else { (&ours, &theirs) };
            assert!(
                more.starts_with(fewer),
                "a pipe of {pipe}: hyper's {:?}\nown: {:?}",
                Sent(theirs.clone()),
                Sent(ours.clone())
            );
            // The answers Corten's connection made itself, before the switch, went whole.
            assert!(find(&ours, b"read 47").is_some(), "a pipe of {pipe}: {:?}", Sent(ours.clone()));
        }
        println!("{name}: hyper's refusal cut short at {cut} of 379 sizes of pipe, the two differ at {differ}");
        assert!(cut > 0, "{name}: hyper's connection sent its refusal whole at every size");
        assert_eq!(differ > 0, !alike, "{name}");
    }
}
