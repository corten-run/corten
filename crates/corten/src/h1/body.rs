//! A request's body, read from the bytes its client sent: where it ends ([`Decoder`]), and the
//! body the app is given ([`Coming`]) with the connection's end of it ([`Feed`]).
//!
//! **Where a body ends** is said by its head ([`super::head::Framing`]) and found here as hyper
//! 1.12 finds it (`proto/h1/decode.rs`), state for state: a `Content-Length` is that many bytes; a
//! chunked body is chunks, each a size in hexadecimal on a line of its own, that many bytes and a
//! CRLF, to a chunk of size zero, the trailers and an empty line. What is refused there is refused
//! here at the same byte: a size line that does not begin with a hexadecimal digit (a sign, a
//! space, `0x`), a size that does not fit 64 bits, any byte behind the size but a space, a tab, a
//! `;` or the line's CR, a line end that is not CR and then LF (after a size, after an extension,
//! after a chunk's bytes, after a trailer), an LF in an extension, extensions of 16 KiB together
//! in one body, trailers as long together as the app lets a head be
//! ([`crate::App::max_request_head`]) or more than 100 of them, and a trailer `httparse` does
//! not take for a header line.
//!
//! One thing is refused here that hyper takes: **an LF with no CR before it among the trailers**.
//! hyper reads a trailer to the next CR, so an LF in one is a byte of it, and hands what it
//! gathered to `httparse`, which takes a bare LF for a line end. So `0\r\na: b\n\r\n` is not a
//! whole body to hyper: it reads on, through whatever the client sends next, to the next empty
//! line that ends in CRLF, and gives the app the first trailer alone. A proxy in front that takes
//! a bare LF for a line end, as many parsers do, has the body end at that `\n\r\n` and sends the
//! next client's request behind it; hyper would read that request as trailers of this one and
//! answer the one after it in its place. Here the body fails at the LF, and its connection ends
//! with the answer.
//!
//! What hyper does not refuse is not refused here either, each because no reader could take the
//! body to end somewhere else by it: spaces and tabs between a size and its line's end or `;`,
//! any byte but CR and LF in an extension, a size with any number of zeros before it, and a
//! trailer of any name (trailers are a frame of their own behind the body's bytes and are never
//! made headers of the request, so `Content-Length` there frames nothing). So a size line has no
//! limit of its own on either, beyond its extensions' and a size that fits 64 bits: the zeros
//! before a size and the spaces and tabs behind it are not counted. They are not kept either, so
//! they make the server hold nothing; a client that sends them without end is sending a body
//! that does not end, and is cut where that one is: by the app's deadline
//! ([`crate::App::deadline`]), where it has one.
//!
//! **Nothing is read ahead of the app.** The connection reads the socket for a body only when the
//! app has asked the body for a piece and there is none ([`Coming`]'s `poll_frame`), and gives it
//! one piece: the bytes the read brought, up to where the body or its chunk ends. So what the
//! server holds of a body its handler is not reading is one read ([`super::Inbox`]) and one piece
//! given and not taken, which is a part of a read. hyper reads one piece further: it keeps a
//! piece ready beyond what the app has taken. A body the app drops unfinished is the one case in
//! which the connection reads with nobody asking, to find whether the body ends within what its
//! client has already sent (`super::Conn::pass`): at most two pieces and 24 KiB, never waiting.

use std::{
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard},
    task::{Context, Poll, Waker},
};

use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue};
use http_body::{Frame, SizeHint};

use super::Inbox;

/// How many bytes of chunk extensions a body may have in all, as hyper's
/// (`CHUNKED_EXTENSIONS_LIMIT`): they are counted and not kept.
pub(crate) const EXTENSIONS: u32 = 16 * 1024;
/// How many trailers a body may have, as hyper's (`DEFAULT_MAX_HEADERS`). How many bytes they may
/// be is the app's limit on a head ([`crate::App::max_request_head`]), as it is hyper's on a
/// server of Corten's, which gives hyper that limit for both: they are kept until the body's
/// end, so that is what a body's trailers can make the connection hold.
const TRAILER_LINES: u8 = 100;

#[cfg(test)]
std::thread_local! {
    /// The most bytes of trailers a connection of this thread has held, for a test of the bound.
    pub(crate) static TRAILED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// How many bodies of this thread's connections were refused for an LF with no CR before it
    /// among their trailers, which hyper takes: the gate lists a stream that has one.
    pub(crate) static BARE_LFS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Where a chunked body's reader is, as hyper's `ChunkedState`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum State {
    /// A size line begins: its first byte is a hexadecimal digit.
    Start,
    Size,
    /// Spaces and tabs behind a size.
    SizeLws,
    Extension,
    /// The LF that ends a size line.
    SizeLf,
    /// The chunk's bytes.
    Data,
    DataCr,
    DataLf,
    /// Behind the last chunk's line, or a trailer's: the CR of the empty line, or a trailer.
    EndCr,
    Trailer,
    TrailerLf,
    EndLf,
}

/// Reads one body out of a connection's bytes.
pub(crate) enum Decoder {
    /// This many more bytes.
    Length(u64),
    Chunked {
        state: State,
        /// What is left of the chunk being read, or the size read so far of the next.
        size: u64,
        /// How many bytes of extensions the body has had.
        extensions: u32,
        /// How many trailers have ended.
        lines: u8,
        /// The trailers, as they came.
        trailers: Option<Vec<u8>>,
        /// How many bytes the trailers may be.
        limit: usize,
    },
}

/// What a [`Decoder`] found in the bytes read so far.
pub(crate) enum Step {
    /// A piece of the body.
    Piece(Bytes),
    /// The body's end, with its trailers. Nothing behind it has been taken.
    End(Option<HeaderMap>),
    /// The bytes read hold no more of the body: all of them have been taken.
    More,
    /// The body is not framed as its head said.
    Wrong,
}

impl Decoder {
    pub(crate) fn length(length: u64) -> Decoder {
        Decoder::Length(length)
    }

    /// `limit`: how many bytes its trailers may be.
    pub(crate) fn chunked(limit: usize) -> Decoder {
        Decoder::Chunked { state: State::Start, size: 0, extensions: 0, lines: 0, trailers: None, limit }
    }

    /// Whether a body of a known length has been given whole: its last piece is its end, as with
    /// hyper, where a chunked body ends at the line behind its last chunk.
    pub(crate) fn given(&self) -> bool {
        matches!(self, Decoder::Length(0))
    }

    /// Whether the piece just given ended inside its chunk, or inside a body of a known length:
    /// where what had been read ended, and not where the body said.
    pub(crate) fn partway(&self) -> bool {
        matches!(self, Decoder::Length(1..) | Decoder::Chunked { state: State::Data, .. })
    }

    /// The next of the body in what `inbox` holds: at most one piece.
    pub(crate) fn step(&mut self, inbox: &mut Inbox) -> Step {
        match self {
            Decoder::Length(0) => Step::End(None),
            Decoder::Length(left) => {
                if inbox.is_empty() {
                    return Step::More;
                }
                let count = usize::try_from(*left).unwrap_or(usize::MAX).min(inbox.len());
                *left -= count as u64;
                Step::Piece(inbox.take(count))
            }
            Decoder::Chunked { state, size, extensions, lines, trailers, limit } => {
                // How many bytes of framing have been read from the front of what is held.
                let mut at = 0;
                loop {
                    if *state == State::Data {
                        inbox.skip(at);
                        if inbox.is_empty() {
                            return Step::More;
                        }
                        let count = usize::try_from(*size).unwrap_or(usize::MAX).min(inbox.len());
                        *size -= count as u64;
                        if *size == 0 {
                            *state = State::DataCr;
                        }
                        return Step::Piece(inbox.take(count));
                    }
                    let Some(&byte) = inbox.data().get(at) else {
                        inbox.skip(at);
                        return Step::More;
                    };
                    at += 1;
                    *state = match (*state, byte) {
                        (State::Start | State::Size, _) if byte.is_ascii_hexdigit() => {
                            let digit = (byte as char).to_digit(16).map_or(0, u64::from);
                            match size.checked_mul(16).and_then(|size| size.checked_add(digit)) {
                                Some(more) => *size = more,
                                None => return Step::Wrong,
                            }
                            State::Size
                        }
                        (State::Size | State::SizeLws, b'\t' | b' ') => State::SizeLws,
                        (State::Size | State::SizeLws, b';') => State::Extension,
                        (State::Size | State::SizeLws | State::Extension, b'\r') => State::SizeLf,
                        (State::Extension, b'\n') => return Step::Wrong,
                        (State::Extension, _) => {
                            *extensions += 1;
                            if *extensions >= EXTENSIONS {
                                return Step::Wrong;
                            }
                            State::Extension
                        }
                        (State::SizeLf, b'\n') if *size == 0 => State::EndCr,
                        (State::SizeLf, b'\n') => State::Data,
                        (State::DataCr, b'\r') => State::DataLf,
                        (State::DataLf, b'\n') => State::Start,
                        // An LF with no CR before it ends no line here, and is no byte of a
                        // trailer either (the module's comment): hyper takes it for one.
                        (State::EndCr | State::Trailer, b'\n') => {
                            #[cfg(test)]
                            BARE_LFS.set(BARE_LFS.get() + 1);
                            return Step::Wrong;
                        }
                        (State::EndCr, b'\r') => {
                            if !kept(trailers, byte, false, *limit) {
                                return Step::Wrong;
                            }
                            State::EndLf
                        }
                        (State::EndCr | State::Trailer, _) => {
                            if !kept(trailers, byte, true, *limit) {
                                return Step::Wrong;
                            }
                            if byte == b'\r' {
                                State::TrailerLf
                            } else {
                                State::Trailer
                            }
                        }
                        (State::TrailerLf, b'\n') => {
                            if *lines >= TRAILER_LINES || !kept(trailers, byte, true, *limit) {
                                return Step::Wrong;
                            }
                            *lines += 1;
                            State::EndCr
                        }
                        (State::EndLf, b'\n') => {
                            if !kept(trailers, byte, false, *limit) {
                                return Step::Wrong;
                            }
                            inbox.skip(at);
                            return match trailers.take() {
                                None => Step::End(None),
                                Some(lined) => parsed(&lined, usize::from(*lines)).map_or(Step::Wrong, |map| Step::End(Some(map))),
                            };
                        }
                        _ => return Step::Wrong,
                    };
                }
            }
        }
    }
}

/// Keeps a byte of the trailers: `false` when they are at their limit with it, as hyper counts
/// (a byte is kept and then counted, so the limit is not reached). `begins`: the byte may be the
/// first of them, which hyper does not count; the CR and LF of a body's last line are kept only
/// behind trailers. The room for them grows by as much as they are long and never past `limit`,
/// so they hold no more than that.
fn kept(trailers: &mut Option<Vec<u8>>, byte: u8, begins: bool, limit: usize) -> bool {
    let Some(lined) = trailers else {
        if begins {
            let mut lined = Vec::with_capacity(64.min(limit.max(1)));
            lined.push(byte);
            *trailers = Some(lined);
        }
        return true;
    };
    if lined.len() == lined.capacity() {
        lined.reserve_exact(lined.len().min(limit.saturating_sub(lined.len())).max(1));
    }
    lined.push(byte);
    #[cfg(test)]
    TRAILED.set(TRAILED.get().max(lined.capacity()));
    lined.len() < limit
}

/// A body's trailers, `lines` of them, as hyper makes them (`decode_trailers`).
fn parsed(lined: &[u8], lines: usize) -> Option<HeaderMap> {
    let mut headers = vec![httparse::EMPTY_HEADER; lines];
    let Ok(httparse::Status::Complete((_, headers))) = httparse::parse_headers(lined, &mut headers) else { return None };
    let mut trailers = HeaderMap::new();
    for header in headers {
        let name = HeaderName::from_bytes(header.name.as_bytes()).ok()?;
        trailers.append(name, HeaderValue::from_bytes(header.value).ok()?);
    }
    Some(trailers)
}

/// Why a body could not be read to its end, in hyper's words for each (`hyper::Error`'s), since an
/// app that says why a body failed says it with them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Broken {
    /// The body is not framed as its head said, its client closed its side before the end of it,
    /// or the connection failed.
    Reading,
    /// The connection was dropped with the body unfinished (shutdown's grace ran out, or its
    /// answer could not be sent).
    Closed,
}

impl std::fmt::Display for Broken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Broken::Reading => "error reading a body from connection",
            Broken::Closed => "connection closed before message completed",
        })
    }
}

impl std::error::Error for Broken {}

/// How far a body has come.
#[derive(Clone, Copy, PartialEq, Eq)]
enum End {
    /// More may come.
    Open,
    /// All of it has been read: what is in `piece` and `trailers` is the last of it.
    Whole,
    /// It failed: said once, behind the piece given before.
    Failed(Broken),
}

/// What the body the app holds and the connection that reads it share. Each end takes the lock
/// for a few lines and never across a call into anything else.
struct Shared {
    /// A piece read and not yet taken: one at the most.
    piece: Option<Bytes>,
    trailers: Option<Box<HeaderMap>>,
    end: End,
    /// The app asked for a piece and there was none: the connection reads.
    wanted: bool,
    /// The app took a piece since the connection last looked.
    took: bool,
    /// The app dropped the body.
    dropped: bool,
    /// The task that asked for a piece, woken when there is one, or an end.
    reader: Option<Waker>,
    /// The connection's task, woken when a piece is asked for from another task, or the body is
    /// dropped.
    conn: Option<Waker>,
}

fn locked(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    // Nothing of an app's runs under the lock, so a panic never holds it.
    shared.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A request's body as the app is given it: what hyper's `Incoming` is on its connection, with
/// the same answers to the two questions a reader asks before it reads (`size_hint`: exactly what
/// is left of a `Content-Length`, nothing known of a chunked body; `is_end_stream`: a
/// `Content-Length` has been given whole, and never for a chunked body), the same frames (the
/// body's pieces, then its trailers) and an error in the same words.
pub(crate) struct Coming {
    shared: Arc<Mutex<Shared>>,
    /// What is left to give of a `Content-Length`; `None` for a chunked body.
    left: Option<u64>,
}

impl http_body::Body for Coming {
    type Data = Bytes;
    type Error = Broken;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Broken>>> {
        let mut shared = locked(&self.shared);
        if let Some(piece) = shared.piece.take() {
            shared.took = true;
            drop(shared);
            if let Some(left) = &mut self.left {
                *left = left.saturating_sub(piece.len() as u64);
            }
            return Poll::Ready(Some(Ok(Frame::data(piece))));
        }
        match shared.end {
            End::Whole => return Poll::Ready(shared.trailers.take().map(|trailers| Ok(Frame::trailers(*trailers)))),
            End::Failed(why) => {
                shared.end = End::Whole;
                return Poll::Ready(Some(Err(why)));
            }
            End::Open => {}
        }
        shared.wanted = true;
        if !shared.reader.as_ref().is_some_and(|reader| reader.will_wake(cx.waker())) {
            shared.reader = Some(cx.waker().clone());
        }
        // Asked from the connection's own task, as a handler asks, the connection looks when the
        // handler has been polled, and is not woken.
        if let Some(conn) = &shared.conn {
            if !conn.will_wake(cx.waker()) {
                conn.wake_by_ref();
            }
        }
        Poll::Pending
    }

    fn is_end_stream(&self) -> bool {
        self.left == Some(0)
    }

    fn size_hint(&self) -> SizeHint {
        self.left.map_or_else(SizeHint::default, SizeHint::with_exact)
    }
}

impl Drop for Coming {
    fn drop(&mut self) {
        let mut shared = locked(&self.shared);
        shared.dropped = true;
        // A piece given and not taken stays until the connection has seen that there was one.
        if shared.end == End::Open {
            if let Some(conn) = shared.conn.take() {
                drop(shared);
                conn.wake();
            }
        }
    }
}

/// What the app has done with its body since the connection last looked ([`Feed::looks`]).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Asks {
    /// It has a piece it has not taken.
    Ready,
    /// It has none. `wanted`: and asked for one.
    Empty { wanted: bool },
    /// It dropped the body. `ready`: with a piece given and not taken; `took`: having taken one
    /// since the connection last looked.
    Dropped { ready: bool, took: bool },
}

/// The connection's end of a body: it reads, and gives the app's end what it read.
pub(crate) struct Feed {
    shared: Arc<Mutex<Shared>>,
    pub(crate) decoder: Decoder,
    /// The client waits to be told to send the body (`Expect: 100-continue`) and has not been.
    pub(crate) expects: bool,
}

impl Feed {
    /// A body with this framing, and the app's end of it.
    pub(crate) fn new(decoder: Decoder, expects: bool) -> (Feed, Coming) {
        let left = match decoder {
            Decoder::Length(length) => Some(length),
            Decoder::Chunked { .. } => None,
        };
        let shared = Arc::new(Mutex::new(Shared {
            piece: None,
            trailers: None,
            end: End::Open,
            wanted: false,
            took: false,
            dropped: false,
            reader: None,
            conn: None,
        }));
        (Feed { shared: shared.clone(), decoder, expects }, Coming { shared, left })
    }

    /// What the app has done with the body, for the connection's task, which is woken by `cx`
    /// from here on when the app asks from another task or drops the body.
    pub(crate) fn looks(&self, cx: &mut Context<'_>) -> Asks {
        let mut shared = locked(&self.shared);
        let took = std::mem::take(&mut shared.took);
        if shared.dropped {
            return Asks::Dropped { ready: shared.piece.take().is_some(), took };
        }
        if !shared.conn.as_ref().is_some_and(|conn| conn.will_wake(cx.waker())) {
            shared.conn = Some(cx.waker().clone());
        }
        if shared.piece.is_some() {
            Asks::Ready
        } else {
            Asks::Empty { wanted: shared.wanted }
        }
    }

    /// Gives the app a piece, and its body's end with it if `whole`. `true` (here and below) when
    /// the one that waited for it is the connection's own task (`cx`), which is not woken: the
    /// connection polls what it holds of the app's again.
    pub(crate) fn give(&self, piece: Bytes, whole: bool, cx: Option<&mut Context<'_>>) -> bool {
        self.put(cx, |shared| {
            shared.piece = Some(piece);
            if whole {
                shared.end = End::Whole;
            }
        })
    }

    /// The body's end, with its trailers.
    pub(crate) fn end(&self, trailers: Option<HeaderMap>, cx: Option<&mut Context<'_>>) -> bool {
        self.put(cx, |shared| {
            shared.trailers = trailers.map(Box::new);
            shared.end = End::Whole;
        })
    }

    /// The body cannot be read further.
    pub(crate) fn fail(&self, why: Broken, cx: Option<&mut Context<'_>>) -> bool {
        self.put(cx, |shared| shared.end = End::Failed(why))
    }

    /// Changes what the two ends share, and wakes the task that waits for it, unless it is this
    /// one (`cx`).
    fn put(&self, cx: Option<&mut Context<'_>>, change: impl FnOnce(&mut Shared)) -> bool {
        let mut shared = locked(&self.shared);
        if shared.end != End::Open {
            return false;
        }
        change(&mut shared);
        shared.wanted = false;
        let reader = shared.reader.take();
        drop(shared);
        let Some(reader) = reader else { return false };
        if cx.is_some_and(|cx| reader.will_wake(cx.waker())) {
            return true;
        }
        reader.wake();
        false
    }
}

impl Drop for Feed {
    /// A connection that ends with a body unfinished: whoever still holds the body is told.
    fn drop(&mut self) {
        self.put(None, |shared| shared.end = End::Failed(Broken::Closed));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The limit on trailers these tests give a body.
    const LIMIT: usize = 16 * 1024;

    /// The pieces of a body sent whole, and whether it was read to its end: `None` where it is
    /// refused.
    fn read(mut decoder: Decoder, sent: &[u8]) -> Option<(Vec<u8>, Option<HeaderMap>, usize)> {
        let mut inbox = Inbox::holding(sent);
        let mut body = Vec::new();
        loop {
            match decoder.step(&mut inbox) {
                Step::Piece(piece) => body.extend_from_slice(&piece),
                Step::End(trailers) => return Some((body, trailers, inbox.len())),
                Step::More | Step::Wrong => return None,
            }
        }
    }

    fn chunks(sent: &str) -> Option<(String, usize)> {
        read(Decoder::chunked(LIMIT), sent.as_bytes()).map(|(body, _, left)| (String::from_utf8(body).unwrap(), left))
    }

    #[test]
    fn a_chunked_body_ends_at_its_empty_line_and_takes_nothing_behind_it() {
        assert_eq!(chunks("5\r\nhello\r\n0\r\n\r\nGET /"), Some(("hello".to_owned(), 5)));
        assert_eq!(chunks("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"), Some(("hello world".to_owned(), 0)));
        assert_eq!(chunks("0\r\n\r\n"), Some((String::new(), 0)));
        assert_eq!(chunks("A\r\n0123456789\r\na\r\n0123456789\r\n00\r\n\r\n"), Some(("01234567890123456789".to_owned(), 0)));
        // What hyper takes and the grammar does not: spaces behind a size, any byte in an
        // extension, zeros before a size.
        assert_eq!(chunks("5 \t\r\nhello\r\n0\r\n\r\n"), Some(("hello".to_owned(), 0)));
        assert_eq!(chunks("5 ;a=\"b c\"\x01\r\nhello\r\n0;x\r\n\r\n"), Some(("hello".to_owned(), 0)));
        assert_eq!(chunks(&format!("{}5\r\nhello\r\n0\r\n\r\n", "0".repeat(40))), Some(("hello".to_owned(), 0)));
    }

    #[test]
    fn a_chunked_body_that_is_not_framed_as_the_grammar_has_it_is_refused() {
        let wrong = [
            // A size that does not begin with a digit, or is not one.
            "\r\nhello\r\n0\r\n\r\n",
            " 5\r\nhello\r\n0\r\n\r\n",
            "+5\r\nhello\r\n0\r\n\r\n",
            "-5\r\nhello\r\n0\r\n\r\n",
            "0x5\r\nhello\r\n0\r\n\r\n",
            "5g\r\nhello\r\n0\r\n\r\n",
            "5 5\r\nhello\r\n0\r\n\r\n",
            // One that does not fit 64 bits, where one that just does is a chunk that has not come.
            "10000000000000000\r\nhello\r\n0\r\n\r\n",
            // A line end that is not CRLF: behind a size, an extension, a chunk and the last chunk.
            "5\nhello\r\n0\r\n\r\n",
            "5\rhello\r\n0\r\n\r\n",
            "5;a\nhello\r\n0\r\n\r\n",
            "5;a\rhello\r\n0\r\n\r\n",
            "5\r\nhello\n0\r\n\r\n",
            "5\r\nhello\r0\r\n\r\n",
            "5\r\nhelloXX0\r\n\r\n",
            "0\n\r\n",
            "0\r\n\r\r",
            // And among the trailers, where hyper reads on: an LF with no CR before it.
            "0\r\n\n",
            "0\r\na: b\n\r\n",
            "0\r\na: b\nc: d\r\n\r\n",
            "0\r\na: b\r\n\n",
            // A CR with no LF behind it.
            "0\r\na: b\rc: d\r\n\r\n",
            // A trailer that is no header line.
            "0\r\na : b\r\n\r\n",
            "0\r\n a: b\r\n\r\n",
            "0\r\nab\r\n\r\n",
            "0\r\na: b\r\n c\r\n\r\n",
        ];
        for sent in wrong {
            assert_eq!(chunks(sent), None, "{sent:?}");
        }
        assert!(matches!(Decoder::chunked(LIMIT).step(&mut Inbox::holding(b"FFFFFFFFFFFFFFFF\r\nhello")), Step::Piece(_)));
    }

    #[test]
    fn trailers_are_a_map_of_their_own_whatever_their_names() {
        let (body, trailers, left) =
            read(Decoder::chunked(LIMIT), b"1\r\nx\r\n0\r\nx-t: 1\r\nContent-Length: 9\r\nx-t: 2\r\n\r\nrest").unwrap();
        let trailers = trailers.unwrap();
        assert_eq!((body, left), (b"x".to_vec(), 4));
        assert_eq!(trailers.get_all("x-t").iter().collect::<Vec<_>>(), ["1", "2"]);
        assert_eq!(trailers["content-length"], "9");
    }

    /// The limits are hyper's, to the byte: 16,383 bytes of extensions in a body and no more;
    /// trailers of a byte less than their limit with their line ends and no more; 100 trailers
    /// and no more.
    #[test]
    fn extensions_and_trailers_are_held_to_hypers_limits() {
        let extended = |bytes: usize| format!("1;{}\r\nx\r\n0\r\n\r\n", "e".repeat(bytes));
        assert!(chunks(&extended(EXTENSIONS as usize - 1)).is_some());
        assert!(chunks(&extended(EXTENSIONS as usize)).is_none());
        // Counted through the body, not a chunk at a time.
        let spread = |chunks: usize| format!("{}0\r\n\r\n", "1;eeeeeee\r\nx\r\n".repeat(chunks));
        assert!(chunks(&spread(EXTENSIONS as usize / 7)).is_some());
        assert!(chunks(&spread(EXTENSIONS as usize / 7 + 1)).is_none());
        // `a: ` and the two line ends are 7 bytes.
        let trailed = |bytes: usize| format!("0\r\na: {}\r\n\r\n", "v".repeat(bytes));
        assert!(chunks(&trailed(LIMIT - 8)).is_some());
        assert!(chunks(&trailed(LIMIT - 7)).is_none());
        // The limit is the one the body was given, and what is held for them is no more.
        let short = |bytes: usize| read(Decoder::chunked(700), trailed(bytes).as_bytes());
        TRAILED.set(0);
        assert!(short(700 - 8).is_some() && short(700 - 7).is_none() && short(5000).is_none());
        assert!(TRAILED.get() <= 700, "{} bytes were held for trailers", TRAILED.get());
        let lined = |lines: usize| format!("0\r\n{}\r\n", "a: b\r\n".repeat(lines));
        assert!(chunks(&lined(100)).is_some());
        assert!(chunks(&lined(101)).is_none());
    }

    /// A body is found the same however its bytes are cut: here every body above that is whole,
    /// given a byte at a time.
    #[test]
    fn a_body_is_read_the_same_a_byte_at_a_time() {
        let bodies = ["5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n", "5 ;a=b\r\nhello\r\n0\r\nx-t: 1\r\ny: 2\r\n\r\n", "0\r\n\r\n"];
        for sent in bodies {
            let (whole, trailers, _) = read(Decoder::chunked(LIMIT), sent.as_bytes()).unwrap();
            let (mut decoder, mut body, mut ended) = (Decoder::chunked(LIMIT), Vec::new(), None);
            for byte in sent.bytes() {
                assert!(ended.is_none(), "{sent:?} ended before its last byte");
                let mut inbox = Inbox::holding(&[byte]);
                loop {
                    match decoder.step(&mut inbox) {
                        Step::Piece(piece) => body.extend_from_slice(&piece),
                        Step::End(trailers) => break ended = Some(trailers),
                        Step::More => break,
                        Step::Wrong => panic!("{sent:?} refused"),
                    }
                }
                assert_eq!(inbox.len(), 0);
            }
            assert_eq!((body, ended), (whole, Some(trailers)), "{sent:?}");
        }
        let mut decoder = Decoder::length(3);
        let mut inbox = Inbox::holding(b"abcd");
        assert!(matches!(decoder.step(&mut inbox), Step::Piece(piece) if piece == "abc"));
        assert!(decoder.given() && inbox.len() == 1);
        assert!(matches!(decoder.step(&mut inbox), Step::End(None)));
    }
}
