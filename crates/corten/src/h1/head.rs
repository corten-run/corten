//! A request's head read from the bytes a client sent, and an answer's head written.
//!
//! The head is read by `httparse`, the parser hyper reads requests with, with the settings hyper's
//! server gives it (its defaults, at most 100 headers), and what it found is made into the same
//! `http` types by the same constructors (`proto/h1/role.rs`, `Server::parse`, in hyper 1.12). So
//! what is refused is what hyper refuses, at the same byte: a folded header line, whitespace
//! before a header's colon, a bare CR, NUL and other control bytes, a method that is not a token,
//! a version that is not `HTTP/1.0` or `HTTP/1.1`, more than 100 headers, a target or a header
//! name longer than `http` has a type for; and what is accepted is what it accepts (empty lines
//! before the request line, a bare LF for a line end).
//!
//! **What a head says about its body** ([`Framing`]) is read as hyper reads it, line for line in
//! the head's order (`Server::parse` again), so the same heads are refused with the same status
//! and the app is given the same headers. RFC 9112, section 6.3, is the rule, and where hyper is
//! stricter than it, so is this:
//! 1. A `Transfer-Encoding` frames the body in chunks, whatever a `Content-Length` says: the
//!    length is taken out of the headers the app is given (a line before it is removed, one behind
//!    it is not added), and the connection is closed behind the answer, since a client or a proxy
//!    that sent both may not agree with this server about where the request ends.
//! 2. One whose last coding is not `chunked`, read as hyper reads it (the last item of the line's
//!    list, in any case, with spaces around it and nothing else: not `chunked;q=1`, not an empty
//!    item behind a comma, not a value with a byte outside visible ASCII), is a 400; and so is
//!    any `Transfer-Encoding` on an HTTP/1.0 request. The last line of several decides.
//! 3. A `Content-Length` is decimal digits and nothing else: a sign, a space inside it, a comma
//!    (a list, even of equal numbers), `0x`, a fraction, an empty value and a number that does
//!    not fit 64 bits are each a 400. Two lines that say the same number are one, and the app is
//!    given the first; two that differ are a 400. The two largest numbers 64 bits hold are a 431,
//!    as with hyper, which keeps them for meanings of its own.
//! 4. With neither, there is no body: the message ends where its head does.
//!
//! No method changes any of this: a `GET`, a `HEAD` or a `DELETE` with a body has the body its
//! head frames, read as any other, so the bytes behind it are never taken for a request.
//!
//! `Expect: 100-continue`, the whole value in any case, on the last such line, says the client
//! waits to be told to send its body ([`Said::expects`]).
//!
//! A `CONNECT`, a request with an `Upgrade` line, whatever the line says, and an HTTP/1.0 request
//! that asks to keep its connection ([`keeps`]) are not this connection's to answer
//! ([`Scanned::hypers`]): the connection is hyper's from that request on ([`super::handoff`]),
//! with its body if it has one. So an HTTP/1.0 request answered here is always its connection's
//! last.
//!
//! The answer's head is written as hyper 1.12 writes it (`proto/h1/role.rs`, `Server::encode`,
//! and `proto/h1/conn.rs`, `enforce_version`): names in lower case in the order the map gives
//! them, `connection`, `content-length`, `transfer-encoding` and `date` chosen the same way.
//! Two things hyper writes are not: a `Trailer` line, since the trailers it announces are not
//! sent, and a reason phrase other than the status's own (`hyper::ext::ReasonPhrase`).

use std::{
    cell::RefCell,
    mem::MaybeUninit,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Version};

/// The most headers a request may have, as hyper's (`DEFAULT_MAX_HEADERS`).
const MAX_HEADERS: usize = 100;
/// The longest request target, as hyper's (`MAX_URI_LEN`): what `http::Uri` can hold.
const MAX_URI: usize = (u16::MAX - 1) as usize;
/// The longest header name, as hyper's (`record_header_indices` refuses one of 64 KiB): what
/// `http::HeaderName` can hold.
const MAX_NAME: usize = u16::MAX as usize;
/// What a client opens an HTTP/2 connection with: refused without an answer, as hyper does.
const H2_PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

/// Why a head is refused, and so its connection closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// 400.
    Bad,
    /// 431: the head, or its number of headers, is over the limit.
    TooLarge,
    /// 414.
    UriTooLong,
}

impl Refusal {
    pub fn status(self) -> StatusCode {
        match self {
            Refusal::Bad => StatusCode::BAD_REQUEST,
            Refusal::TooLarge => StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
            Refusal::UriTooLong => StatusCode::URI_TOO_LONG,
        }
    }
}

/// How a request's body is framed, as its head says (the module's comment).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Framing {
    /// No body: the message ends where its head does.
    None,
    /// This many bytes, and more than none.
    Length(u64),
    Chunked,
}

/// The largest `Content-Length` hyper takes (`DecodedLength::MAX_LEN`): the two numbers above it
/// stand for a chunked body and for one that ends with its connection there.
const MAX_LENGTH: u64 = u64::MAX - 2;

/// A request's head, of a request this connection answers. What it says of a body is not here
/// ([`Said`]): a head is what every request has, and is moved as it was before bodies were read.
pub(crate) struct Head {
    pub parts: http::request::Parts,
    /// The connection may go on to another request after this one.
    pub keep_alive: bool,
}

/// What a head says of its request's body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Said {
    pub framing: Framing,
    /// The client waits to be told to send the body (`Expect: 100-continue`, on HTTP/1.1: an
    /// HTTP/1.0 client is told nothing before its answer, as with hyper).
    pub expects: bool,
}

impl Said {
    /// What a head that frames no body says.
    pub(crate) const NOTHING: Said = Said { framing: Framing::None, expects: false };
}

/// Where a header's name and value are in the head's bytes.
pub(crate) type Indices = (usize, usize, usize, usize);

/// What `httparse` found in a head.
pub(crate) struct Scanned {
    /// How long the head is.
    pub len: usize,
    pub method: Method,
    /// Where the target is in the head's bytes.
    pub target: (usize, usize),
    pub http11: bool,
    /// The request is hyper's to answer: it is a `CONNECT`, its head has a line that says the
    /// connection may switch ([`hypers`]), or it is an HTTP/1.0 request that asks to keep its
    /// connection ([`keeps`]).
    pub hypers: bool,
}

/// A fast look for the end of a head in bytes that did not hold one when only `had` of them had
/// arrived, so a head sent a few bytes at a time is not parsed again for each piece (hyper's
/// `is_complete_fast`).
pub(crate) fn may_be_whole(bytes: &[u8], had: usize) -> bool {
    let bytes = &bytes[had.saturating_sub(3)..];
    bytes.iter().enumerate().any(|(at, byte)| match byte {
        b'\r' => bytes[at + 1..].starts_with(b"\n\r\n"),
        b'\n' => bytes[at + 1..].starts_with(b"\n") || bytes[at + 1..].starts_with(b"\r\n"),
        _ => false,
    })
}

/// Whether `bytes`, without the line ends before them, begin with all of what a client opens an
/// HTTP/2 connection with (hyper's `consume_leading_lines` and `has_h2_prefix`): a refusal is not
/// answered when what is unread begins so.
pub(crate) fn speaks_h2(bytes: &[u8]) -> bool {
    let lines = bytes.iter().take_while(|byte| matches!(byte, b'\r' | b'\n')).count();
    bytes[lines..].starts_with(H2_PREFACE)
}

/// Whether a header of this name makes its request hyper's: `Upgrade`, which asks to switch
/// protocols. By the name alone, in any case, whatever its value and however many times it
/// comes: this connection does not read its value, so it cannot read it differently from hyper.
fn hypers(name: &[u8]) -> bool {
    name.len() == 7 && name.eq_ignore_ascii_case(b"upgrade")
}

/// What `httparse` found in `bytes`, with each header's place in `indices`. `None` when the head
/// has not all arrived. In hyper's order: the head's length against `limit`, the target's against
/// what a `Uri` holds, then the method.
pub(crate) fn scan(bytes: &[u8], limit: usize, indices: &mut Vec<Indices>) -> Result<Option<Scanned>, Refusal> {
    // Not written before `httparse` fills them, as hyper's are not: clearing 100 headers for each
    // head costs more than reading a short one.
    let mut headers = [MaybeUninit::<httparse::Header<'_>>::uninit(); MAX_HEADERS];
    let mut req = httparse::Request::new(&mut []);
    let len = match httparse::ParserConfig::default().parse_request_with_uninit_headers(&mut req, bytes, &mut headers) {
        Ok(httparse::Status::Complete(len)) => len,
        Ok(httparse::Status::Partial) => return Ok(None),
        Err(httparse::Error::TooManyHeaders) => return Err(Refusal::TooLarge),
        Err(_) => return Err(Refusal::Bad),
    };
    if len > limit {
        return Err(Refusal::TooLarge);
    }
    let (Some(method), Some(target), Some(version)) = (req.method, req.path, req.version) else {
        return Err(Refusal::Bad);
    };
    if target.len() > MAX_URI {
        return Err(Refusal::UriTooLong);
    }
    let method = Method::from_bytes(method.as_bytes()).map_err(|_| Refusal::Bad)?;
    // Where `part`, a piece of `bytes` that `httparse` handed back, is in it.
    let base = bytes.as_ptr() as usize;
    let place = |part: &[u8]| {
        let start = (part.as_ptr() as usize).checked_sub(base).filter(|start| start + part.len() <= len);
        start.map(|start| (start, start + part.len())).ok_or(Refusal::Bad)
    };
    let target = place(target.as_bytes())?;
    let http11 = version == 1;
    let mut hyper = method == Method::CONNECT;
    indices.clear();
    for header in req.headers.iter() {
        // As hyper, where it notes each line's place (`record_header_indices`): a name `http`
        // has no `HeaderName` for is a head too long, whatever the app's limit.
        if header.name.len() > MAX_NAME {
            return Err(Refusal::TooLarge);
        }
        hyper |= hypers(header.name.as_bytes()) || (!http11 && keeps(header.name.as_bytes(), header.value));
        let (name, value) = (place(header.name.as_bytes())?, place(header.value)?);
        indices.push((name.0, name.1, value.0, value.1));
    }
    Ok(Some(Scanned { len, method, target, http11, hypers: hyper }))
}

/// Whether a header of an HTTP/1.0 request may ask to keep its connection: a `Connection` line
/// with `keep-alive` anywhere in it, in any case. Such a request is hyper's too. hyper answers a
/// head it refuses in the version of the request before it, so a connection that had answered an
/// HTTP/1.0 request here and went on would be answered differently there; one that does not go
/// on has no request after it.
fn keeps(name: &[u8], value: &[u8]) -> bool {
    name.eq_ignore_ascii_case(b"connection") && value.windows(10).any(|part| part.eq_ignore_ascii_case(b"keep-alive"))
}

/// The request whose head is `bytes` (all of it, and no more), scanned by [`scan`], which found
/// no line that makes it hyper's. `cached` is a header map to fill, emptied by the answer before.
/// `said`: written only where the head frames a body.
pub(crate) fn build(
    bytes: &Bytes,
    scanned: Scanned,
    indices: &[Indices],
    cached: &mut Option<HeaderMap>,
    said: &mut Said,
) -> Result<Head, Refusal> {
    let Scanned { method, target, http11, .. } = scanned;
    let uri = http::Uri::from_maybe_shared(bytes.slice(target.0..target.1)).map_err(|_| Refusal::Bad)?;
    let mut headers = cached.take().unwrap_or_default();
    headers.reserve(indices.len());
    let mut keep_alive = http11;
    let mut closes = false;
    // The body's framing, as hyper's `Server::parse` finds it, in its order and with its names:
    // the length the lines so far give, whether any line was a `Content-Length` or a
    // `Transfer-Encoding`, and whether the last of those ended in `chunked`.
    let mut length: Option<u64> = None;
    let (mut is_cl, mut is_te, mut is_te_chunked, mut expects) = (false, false, false, false);
    for &(name, name_end, value, value_end) in indices {
        let name = HeaderName::from_bytes(&bytes[name..name_end]).map_err(|_| Refusal::Bad)?;
        // `httparse` let the same bytes through as `HeaderValue` does, which checks them again:
        // skipping that needs `unsafe` (hyper's `from_maybe_shared_unchecked`).
        let value = HeaderValue::from_maybe_shared(bytes.slice(value..value_end)).map_err(|_| Refusal::Bad)?;
        match name {
            header::TRANSFER_ENCODING => {
                if !http11 {
                    return Err(Refusal::Bad);
                }
                is_te = true;
                // The length a line before this one gave frames nothing, and is not the app's.
                if is_cl && length.take().is_some() {
                    headers.remove(header::CONTENT_LENGTH);
                }
                is_te_chunked = ends_chunked(&value);
            }
            header::CONTENT_LENGTH => {
                is_cl = true;
                // Behind a `Transfer-Encoding` it is not read at all, and not the app's.
                if is_te {
                    continue;
                }
                let said = digits(value.as_bytes()).ok_or(Refusal::Bad)?;
                if let Some(first) = length {
                    if first != said {
                        return Err(Refusal::Bad);
                    }
                    // The same length again: the app is given the first line alone.
                    continue;
                }
                if said > MAX_LENGTH {
                    return Err(Refusal::TooLarge);
                }
                length = Some(said);
            }
            header::CONNECTION => {
                // Once any `Connection` line asks to close, a later `keep-alive` does not undo it.
                if closes || has_token(&value, "close") {
                    closes = true;
                    keep_alive = false;
                } else if !keep_alive {
                    keep_alive = has_token(&value, "keep-alive");
                }
            }
            header::EXPECT => expects = value.as_bytes().eq_ignore_ascii_case(b"100-continue"),
            _ => {}
        }
        headers.append(name, value);
    }
    if is_te && !is_te_chunked {
        return Err(Refusal::Bad);
    }
    // Both were sent: the chunks frame the body, and the connection ends with this request.
    if is_te && is_cl {
        keep_alive = false;
    }
    if is_te || is_cl {
        let framing = match length {
            _ if is_te => Framing::Chunked,
            Some(length) if length > 0 => Framing::Length(length),
            _ => Framing::None,
        };
        // A client that expects to be told, with no body to send, is told nothing.
        if framing != Framing::None {
            *said = Said { framing, expects: expects && http11 };
        }
    }
    let (mut parts, ()) = http::Request::new(()).into_parts();
    parts.method = method;
    parts.uri = uri;
    parts.version = if http11 { Version::HTTP_11 } else { Version::HTTP_10 };
    parts.headers = headers;
    Ok(Head { parts, keep_alive })
}

/// Whether a `Transfer-Encoding` line's last coding is `chunked`, as hyper reads it
/// (`headers::is_chunked_`): the text behind the line's last comma, without the spaces around
/// it, in any case. A value that is not visible ASCII is not.
fn ends_chunked(value: &HeaderValue) -> bool {
    value.to_str().is_ok_and(|list| list.rsplit(',').next().is_some_and(|last| last.trim().eq_ignore_ascii_case("chunked")))
}

/// Whether `value`, a comma-separated list, has `token` (in any case).
pub(crate) fn has_token(value: &HeaderValue, token: &str) -> bool {
    value.to_str().is_ok_and(|list| list.split(',').any(|each| each.trim().eq_ignore_ascii_case(token)))
}

/// How long an answer's body says it is before it is read, as hyper's `BodyLength`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Known {
    /// The body is at its end already.
    Nothing,
    Exactly(u64),
    Unknown,
}

/// How an answer's body is written after its head.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Coding {
    /// This many more bytes, and no more.
    Length(u64),
    Chunked,
    /// Until the connection closes (an HTTP/1.0 client, a body of unknown length).
    Close,
}

/// What the answer's head needs of its request.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Asked {
    pub head: bool,
    pub http11: bool,
    /// The connection goes on after this answer, unless the answer says otherwise.
    pub keep_alive: bool,
}

/// A head that cannot be sent (a `Content-Length` that is not a number, a version HTTP/1.1 cannot
/// say): nothing of it is written and the connection closes, as with hyper.
#[derive(Debug)]
pub(crate) struct Unsendable;

/// Writes the head of an answer to `out`, emptying `headers`, and returns how its body is
/// written and whether the connection closes after it.
///
/// Every byte written is the status's own text, a constant here, or the bytes of a `HeaderName`
/// or a `HeaderValue`, neither of which can hold a CR or an LF: what a handler puts in an answer
/// cannot end a line of its head, or the head.
pub(crate) fn write(
    out: &mut Vec<u8>,
    status: StatusCode,
    version: Version,
    headers: &mut HeaderMap,
    body: Known,
    asked: Asked,
) -> Result<(Coding, bool), Unsendable> {
    // hyper writes HTTP/1.1 for an answer that says HTTP/2 and panics for any other.
    if !matches!(version, Version::HTTP_10 | Version::HTTP_11 | Version::HTTP_2) {
        return Err(Unsendable);
    }
    let start = out.len();
    let mut keep_alive = asked.keep_alive;
    let mut version = version;
    // What hyper's `enforce_version` does to the head before it is written.
    if !asked.http11 {
        // An HTTP/1.0 client keeps the connection only if the answer says `keep-alive`.
        let says = headers.get_all(header::CONNECTION).iter().any(|value| has_token(value, "keep-alive"));
        if !says {
            match version {
                Version::HTTP_10 => keep_alive = false,
                Version::HTTP_11 if keep_alive => {
                    headers.append(header::CONNECTION, HeaderValue::from_static("keep-alive"));
                }
                _ => {}
            }
        }
        version = Version::HTTP_10;
    } else if !keep_alive && !headers.get_all(header::CONNECTION).iter().any(|value| has_token(value, "close")) {
        headers.append(header::CONNECTION, HeaderValue::from_static("close"));
    }
    let mut body = body;
    let mut wrote_len = false;
    let mut failed = false;
    let mut last = !keep_alive;
    if status == StatusCode::SWITCHING_PROTOCOLS {
        // To a request that did not ask to switch (one that asks is hyper's): sent, and closed.
        last = true;
    } else if status.is_informational() {
        // An interim answer cannot be the handler's answer: a 500 in its place, then close.
        headers.clear();
        body = Known::Nothing;
        version = Version::HTTP_11;
        failed = true;
        last = true;
    }
    let status = if failed { StatusCode::INTERNAL_SERVER_ERROR } else { status };
    out.reserve(30 + headers.len() * 30);
    if version != Version::HTTP_10 && status == StatusCode::OK {
        out.extend_from_slice(b"HTTP/1.1 200 OK\r\n");
    } else {
        out.extend_from_slice(if version == Version::HTTP_10 { b"HTTP/1.0 " } else { b"HTTP/1.1 " });
        out.extend_from_slice(status.as_str().as_bytes());
        out.push(b' ');
        out.extend_from_slice(status.canonical_reason().unwrap_or("<none>").as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    let chunks = version != Version::HTTP_10 && can_chunk(status, asked);
    let mut coding = Coding::Length(0);
    let mut wrote_date = false;
    // A header with several values that is written as one line: `name: a, b`.
    let mut joined = false;
    let mut adds_chunked = false;
    let mut current: Option<HeaderName> = None;
    let mut first_length = None;
    macro_rules! end_joined {
        () => {
            if joined {
                out.extend_from_slice(if adds_chunked { b", chunked\r\n".as_slice() } else { b"\r\n" });
            }
        };
    }
    for (name, value) in headers.drain() {
        if let Some(name) = name {
            end_joined!();
            joined = false;
            current = Some(name);
        }
        let name = current.as_ref().expect("the first entry has a name");
        match *name {
            header::CONTENT_LENGTH => {
                if wrote_len && !joined {
                    out.truncate(start);
                    return Err(Unsendable);
                }
                match body {
                    Known::Exactly(known) => {
                        // The header is trusted to say what the body does, as hyper trusts it.
                        if !joined {
                            coding = Coding::Length(known);
                            out.extend_from_slice(b"content-length: ");
                            out.extend_from_slice(value.as_bytes());
                            wrote_len = true;
                            joined = true;
                        }
                        continue;
                    }
                    Known::Unknown => {
                        let Some(length) = digits(value.as_bytes()) else {
                            out.truncate(start);
                            return Err(Unsendable);
                        };
                        match first_length {
                            Some(first) if first != length => {
                                out.truncate(start);
                                return Err(Unsendable);
                            }
                            Some(_) => {}
                            None => {
                                coding = Coding::Length(length);
                                out.extend_from_slice(b"content-length: ");
                                out.extend_from_slice(value.as_bytes());
                                wrote_len = true;
                                joined = true;
                                first_length = Some(length);
                            }
                        }
                        continue;
                    }
                    // No body: the header stands only on the answer to a `HEAD`.
                    Known::Nothing if !asked.head => continue,
                    Known::Nothing => {}
                }
                wrote_len = true;
            }
            header::TRANSFER_ENCODING => {
                if wrote_len && !joined {
                    out.truncate(start);
                    return Err(Unsendable);
                }
                if !chunks {
                    continue;
                }
                wrote_len = true;
                // `chunked` is the last coding, or is added. (hyper leaves this set once a
                // `transfer-encoding` line has needed it, and so ends a joined line after it, a
                // `connection`'s, with `, chunked` too.)
                adds_chunked = !value
                    .to_str()
                    .is_ok_and(|list| list.rsplit(',').next().is_some_and(|last| last.trim().eq_ignore_ascii_case("chunked")));
                if joined {
                    out.extend_from_slice(b", ");
                } else {
                    coding = Coding::Chunked;
                    joined = true;
                    out.extend_from_slice(b"transfer-encoding: ");
                }
                out.extend_from_slice(value.as_bytes());
                continue;
            }
            header::CONNECTION => {
                if !last && has_token(&value, "close") {
                    last = true;
                }
                if joined {
                    out.extend_from_slice(b", ");
                } else {
                    joined = true;
                    out.extend_from_slice(b"connection: ");
                }
                out.extend_from_slice(value.as_bytes());
                continue;
            }
            header::DATE => wrote_date = true,
            // Trailers are not sent (the module's comment), so none are announced.
            header::TRAILER => continue,
            _ => {}
        }
        out.extend_from_slice(name.as_str().as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    end_joined!();
    if !wrote_len {
        coding = match body {
            Known::Unknown if chunks => {
                out.extend_from_slice(b"transfer-encoding: chunked\r\n");
                Coding::Chunked
            }
            Known::Unknown => Coding::Close,
            Known::Nothing | Known::Exactly(0) => {
                if has_length(status) && !asked.head {
                    out.extend_from_slice(b"content-length: 0\r\n");
                }
                Coding::Length(0)
            }
            Known::Exactly(length) if has_length(status) => {
                out.extend_from_slice(b"content-length: ");
                number(out, length);
                out.extend_from_slice(b"\r\n");
                Coding::Length(length)
            }
            Known::Exactly(_) => Coding::Length(0),
        };
    }
    // No body after a `HEAD`, a 1xx, a 204 or a 304.
    if !can_chunk(status, asked) {
        coding = Coding::Length(0);
    }
    if wrote_date {
        out.extend_from_slice(b"\r\n");
    } else {
        out.extend_from_slice(b"date: ");
        date(out);
        out.extend_from_slice(b"\r\n\r\n");
    }
    if failed {
        return Ok((Coding::Length(0), true));
    }
    Ok((coding, last))
}

/// Whether an answer may have a body (hyper's `can_chunked`, without its `CONNECT`, which is
/// never this connection's to answer).
fn can_chunk(status: StatusCode, asked: Asked) -> bool {
    !(asked.head || status.is_informational()) && !matches!(status, StatusCode::NO_CONTENT | StatusCode::NOT_MODIFIED)
}

/// Whether an answer may say a length (hyper's `can_have_content_length`).
fn has_length(status: StatusCode) -> bool {
    !status.is_informational() && !matches!(status, StatusCode::NO_CONTENT | StatusCode::NOT_MODIFIED)
}

fn digits(value: &[u8]) -> Option<u64> {
    if value.is_empty() {
        return None;
    }
    value.iter().try_fold(0u64, |length, digit| {
        digit.is_ascii_digit().then_some(())?;
        length.checked_mul(10)?.checked_add(u64::from(digit - b'0'))
    })
}

/// `number` in decimal.
fn number(out: &mut Vec<u8>, mut number: u64) {
    let mut text = [0u8; 20];
    let mut at = text.len();
    loop {
        at -= 1;
        text[at] = b'0' + (number % 10) as u8;
        number /= 10;
        if number == 0 {
            break;
        }
    }
    out.extend_from_slice(&text[at..]);
}

/// The head of the answer the server gives a request it refuses, with nothing of the app's: the
/// status, `connection: close`, an empty body and the date, as hyper writes it. (To a client
/// whose request before was HTTP/1.0 hyper writes it as `HTTP/1.0`, with no `connection` line;
/// no connection here goes on after such a request, [`keeps`].)
pub(crate) fn refuse(out: &mut Vec<u8>, status: StatusCode) {
    let mut headers = HeaderMap::new();
    let asked = Asked { head: false, http11: true, keep_alive: false };
    let _ = write(out, status, Version::HTTP_11, &mut headers, Known::Nothing, asked);
}

/// A body piece's size line when the body is chunked: its length in hexadecimal, as hyper
/// writes it (upper case).
pub(crate) fn chunk_size(out: &mut Vec<u8>, length: usize) {
    let mut text = [0u8; 16];
    let mut at = text.len();
    let mut rest = length;
    loop {
        at -= 1;
        text[at] = b"0123456789ABCDEF"[rest & 15];
        rest >>= 4;
        if rest == 0 {
            break;
        }
    }
    out.extend_from_slice(&text[at..]);
    out.extend_from_slice(b"\r\n");
}

/// The time as `Date` gives it, written once a second for each thread.
struct Dated {
    text: [u8; 29],
    /// When the text is next out of date.
    until: SystemTime,
}

thread_local! {
    static DATED: RefCell<Dated> = RefCell::new(Dated::at(SystemTime::now()));
}

impl Dated {
    /// Written by `httpdate`, as hyper writes its own: an IMF-fixdate (RFC 9110, 5.6.7), always
    /// 29 bytes. That crate takes no time before 1970 or from the year 10000, so a clock that
    /// says one is read as the nearest time it takes.
    fn at(now: SystemTime) -> Dated {
        const LAST: u64 = 253_402_300_799;
        let since = now.duration_since(UNIX_EPOCH).unwrap_or_default();
        let until = now + Duration::new(1, 0) - Duration::from_nanos(u64::from(since.subsec_nanos()));
        let whole = UNIX_EPOCH + Duration::from_secs(since.as_secs().min(LAST));
        let mut text = [b' '; 29];
        let written = std::io::Write::write_fmt(&mut &mut text[..], format_args!("{}", httpdate::HttpDate::from(whole)));
        debug_assert!(written.is_ok(), "a date is 29 bytes");
        Dated { text, until }
    }
}

/// Brings the thread's `Date` text up to date: called when the connection's task has waited, so
/// answers written in one go share it.
#[inline]
pub(crate) fn tick() {
    let now = SystemTime::now();
    DATED.with(|dated| {
        let mut dated = dated.borrow_mut();
        if now > dated.until {
            *dated = Dated::at(now);
        }
    });
}

fn date(out: &mut Vec<u8>) {
    DATED.with(|dated| out.extend_from_slice(&dated.borrow().text));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_date_is_written_as_rfc_9110_gives_it() {
        let text = |at: SystemTime| String::from_utf8(Dated::at(at).text.to_vec()).unwrap();
        let since = |seconds: u64, nanos: u32| UNIX_EPOCH + Duration::new(seconds, nanos);
        assert_eq!(text(since(0, 0)), "Thu, 01 Jan 1970 00:00:00 GMT");
        // RFC 9110's own example, and the same second at its end.
        assert_eq!(text(since(784_111_777, 0)), "Sun, 06 Nov 1994 08:49:37 GMT");
        assert_eq!(text(since(784_111_777, 999_999_999)), "Sun, 06 Nov 1994 08:49:37 GMT");
        // A leap day, and the last second of a year.
        assert_eq!(text(since(1_709_164_800, 0)), "Thu, 29 Feb 2024 00:00:00 GMT");
        assert_eq!(text(since(1_798_761_599, 0)), "Thu, 31 Dec 2026 23:59:59 GMT");
        // A clock outside what the formatter takes: the nearest time it does.
        assert_eq!(text(UNIX_EPOCH - Duration::from_secs(5)), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(text(since(300_000_000_000, 0)), "Fri, 31 Dec 9999 23:59:59 GMT");
        // The text is good until the next whole second.
        assert_eq!(Dated::at(since(784_111_777, 250_000_000)).until, since(784_111_778, 0));
    }

    #[test]
    fn a_chunks_size_is_upper_case_hexadecimal() {
        let size = |length| {
            let mut out = Vec::new();
            chunk_size(&mut out, length);
            String::from_utf8(out).unwrap()
        };
        assert_eq!(size(1), "1\r\n");
        assert_eq!(size(255), "FF\r\n");
        assert_eq!(size(65536), "10000\r\n");
    }

    #[test]
    fn the_end_of_a_head_is_seen_across_pieces() {
        assert!(may_be_whole(b"GET / HTTP/1.1\r\n\r\n", 0));
        assert!(may_be_whole(b"GET / HTTP/1.1\r\n\r\n", 17));
        assert!(may_be_whole(b"GET / HTTP/1.1\n\n", 15));
        assert!(!may_be_whole(b"GET / HTTP/1.1\r\nhost: a\r\n", 3));
    }

    /// The one name, in any case, and nothing near it: the lines that frame a body are read here.
    #[test]
    fn a_request_is_hypers_by_the_name_of_its_upgrade_line_alone() {
        for name in ["upgrade", "Upgrade", "uPgRaDe", "UPGRADE"] {
            assert!(hypers(name.as_bytes()), "{name}");
        }
        for name in ["upgrad", "upgrade2", "x-upgrade", "upgrade-insecure-requests", "connection", "te"] {
            assert!(!hypers(name.as_bytes()), "{name}");
        }
        for name in ["content-length", "Content-Length", "transfer-encoding", "Transfer-Encoding", "expect", "Expect"] {
            assert!(!hypers(name.as_bytes()), "{name}");
        }
    }

    /// What a head says of its body, for each way to say it; the refusals are held to hyper's
    /// in `tests/h1_body.rs`, over a connection of each.
    #[test]
    fn a_heads_framing_is_its_last_word_on_it() {
        let read = |lines: &str| {
            let head = Bytes::from(format!("POST / HTTP/1.1\r\n{lines}\r\n"));
            let mut indices = Vec::new();
            let scanned = scan(&head, 1 << 16, &mut indices).unwrap().unwrap();
            let mut said = Said::NOTHING;
            build(&head, scanned, &indices, &mut None, &mut said).map(|head| {
                let lengths = head.parts.headers.get_all(header::CONTENT_LENGTH).iter().count();
                (said.framing, head.keep_alive, said.expects, lengths)
            })
        };
        assert_eq!(read("").unwrap(), (Framing::None, true, false, 0));
        assert_eq!(read("content-length: 0\r\n").unwrap(), (Framing::None, true, false, 1));
        assert_eq!(read("content-length: 5\r\n").unwrap(), (Framing::Length(5), true, false, 1));
        assert_eq!(read("content-length: 5\r\nContent-Length: 05\r\n").unwrap(), (Framing::Length(5), true, false, 1));
        assert_eq!(read("transfer-encoding: gzip, Chunked \r\n").unwrap(), (Framing::Chunked, true, false, 0));
        // Both: the chunks frame it, the length is not the app's, and the connection ends.
        assert_eq!(read("content-length: 5\r\ntransfer-encoding: chunked\r\n").unwrap(), (Framing::Chunked, false, false, 0));
        assert_eq!(read("transfer-encoding: chunked\r\ncontent-length: x\r\n").unwrap(), (Framing::Chunked, false, false, 0));
        assert_eq!(read("content-length: 5\r\nexpect: 100-Continue\r\n").unwrap(), (Framing::Length(5), true, true, 1));
        assert!(!read("content-length: 5\r\nexpect: 100-continue\r\nexpect: x\r\n").unwrap().2);
        let length = |value: u64| format!("content-length: {value}\r\n");
        assert_eq!(read(&length(MAX_LENGTH)).unwrap().0, Framing::Length(MAX_LENGTH));
        assert_eq!(read(&length(MAX_LENGTH + 1)).err(), Some(Refusal::TooLarge));
        for bad in [
            "content-length: 5\r\ncontent-length: 6\r\n",
            "content-length: 5, 5\r\n",
            "content-length: +5\r\n",
            "content-length:\r\n",
            "content-length: 18446744073709551616\r\n",
            "content-length: x\r\ntransfer-encoding: chunked\r\n",
            "transfer-encoding: chunked\r\ntransfer-encoding: gzip\r\n",
            "transfer-encoding: chunked, gzip\r\n",
            "transfer-encoding: chunked,\r\n",
            "transfer-encoding: chunked;q=1\r\n",
            "transfer-encoding:\r\n",
        ] {
            assert_eq!(read(bad).err(), Some(Refusal::Bad), "{bad:?}");
        }
    }
}
