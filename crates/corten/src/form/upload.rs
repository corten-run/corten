//! Reading a form posted as `multipart/form-data`: its files one at a time as they arrive, and
//! its text fields by [`Form`](super::Form)'s rules. See [`Upload`].

use std::{borrow::Cow, marker::PhantomData, time::Duration};

use crate::body::BodyDataStream;
use crate::extract::{FromRequest, Request};
use crate::response::IntoResponse;
use crate::response::Response;
use bytes::Bytes;
use bytes::BytesMut;
use http::header;
use http::StatusCode;
use serde::de::DeserializeOwned;

use super::FieldName;
use crate::{
    extract::{Idle, IDLE},
    Error,
};

/// How much of a body past its limit is read past (not kept) before the answer, so the browser,
/// still sending, reads the answer instead of a broken connection. Past this the connection is
/// closed.
pub(crate) const READ_PAST: usize = 64 * 1024 * 1024;

/// The room a body's pieces are joined in, when a piece arrives with some of the last one held.
const JOIN_ROOM: usize = 64 * 1024;

/// A piece smaller than this is joined in that room.
pub(crate) const SMALL_PIECE: usize = 1024;
/// A file that came in one piece at least this long is kept as it came; a shorter one is copied
/// out of the buffer it was cut from (hyper's read buffer is up to about 408 KiB).
pub(crate) const KEPT_AS_IT_CAME: usize = 64 << 10;

/// The first room a request takes, before it has used one up.
const FIRST_ROOM: usize = 4 * SMALL_PIECE;

type Result<T, E = UploadError> = std::result::Result<T, E>;

/// Why an [`Upload`] could not be read. `?` turns it into an [`Error`] with its status (the
/// error page, or under an [`Api`](crate::Api) the API's failure). Any read can find the body over
/// its limit, so a handler that answers that with the form reads in one block and matches
/// [`UploadError::TooLarge`] once:
///
/// ```
/// use corten::prelude::*;
///
/// #[derive(Fields)]
/// struct NewListing {
///     title: String,
///     photos: Files,
/// }
///
/// async fn create(mut upload: Upload<NewListing>) -> corten::Result<String> {
///     upload.limit(60 << 20);
///     let read = async {
///         let mut photos = Vec::new();
///         while let Some(mut file) = upload.next_file().await? {
///             photos.push(file.bytes_up_to(10 << 20).await?);
///         }
///         Ok::<_, UploadError>((upload.fields().await?, photos))
///     };
///     match read.await {
///         Ok((listing, photos)) => Ok(format!("{}: {} photos", listing.title, photos.len())),
///         Err(UploadError::TooLarge { .. }) => Ok("The photos are over 60 MB together.".into()),
///         Err(other) => Err(other.into()),
///     }
/// }
/// # let _: Methods = post(create);
/// ```
#[derive(Debug)]
pub enum UploadError {
    /// The request took more of the body than [`Upload::limit`] (413): fields, files it read or
    /// passed on with `chunk`, and the parts' headers, not what it read past. What the form sent
    /// is not read; the rest of the body is read past, up to 64 MiB, so the browser receives the
    /// answer. Also a body read 64 MiB past its limit, what was read past included, however little
    /// the request kept: nothing more is read, and the connection is closed.
    TooLarge { limit: usize },
    /// The body breaks the multipart format, or could not be read to its end (400).
    Malformed(String),
    /// The text fields do not fit the form struct (422).
    Fields(String),
    /// The client sent nothing for [`Upload::idle`], or sent the body so slowly it fell that far
    /// behind 240 bytes a second (408), while the request read a file, its fields or what it
    /// passes over. The connection is closed after the answer.
    Stalled,
}

impl std::fmt::Display for UploadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UploadError::TooLarge { limit } => write!(f, "the upload is larger than its limit of {limit} bytes"),
            UploadError::Malformed(what) => write!(f, "the multipart body is malformed: {what}"),
            UploadError::Fields(what) => write!(f, "Failed to deserialize form body: {what}"),
            UploadError::Stalled => f.write_str("the client stopped sending the upload"),
        }
    }
}

impl From<UploadError> for Error {
    fn from(error: UploadError) -> Self {
        let status = match error {
            UploadError::TooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
            UploadError::Malformed(_) => StatusCode::BAD_REQUEST,
            UploadError::Fields(_) => StatusCode::UNPROCESSABLE_ENTITY,
            UploadError::Stalled => StatusCode::REQUEST_TIMEOUT,
        };
        Error::new(error.to_string()).with_status(status)
    }
}

/// The most a part's headers may take.
const HEAD_LIMIT: usize = 8 * 1024;

/// A form posted as `multipart/form-data` (`<form enctype="multipart/form-data">` with an
/// `<input type="file">`): its files one at a time as they arrive, then its text fields read into
/// `T` as [`Form`](super::Form) reads them. A file input is named by a [`Files`] field of `T`, so
/// markup, the files and [`Errors`](super::Errors) take its [`FieldName`]:
///
/// ```
/// use corten::prelude::*;
///
/// #[derive(Fields)]
/// struct NewListing {
///     title: String,
///     photos: Files,
/// }
///
/// async fn create(mut upload: Upload<NewListing>) -> corten::Result<String> {
///     let f = NewListing::FIELDS;
///     upload.limit(60 << 20);
///     let (mut photos, mut errors) = (Vec::new(), Errors::new());
///     while let Some(mut file) = upload.next_file().await? {
///         if !file.is(f.photos) {
///             continue;
///         }
///         match file.bytes_up_to(10 << 20).await? {
///             Some(bytes) => photos.push((file.filename().to_string(), bytes)),
///             None => errors.add(f.photos, "Each photo can be up to 10 MB."),
///         }
///     }
///     let listing = upload.fields().await?;
///     Ok(format!("{}: {} photos", listing.title, photos.len()))
/// }
/// # let _: Methods = post(create);
/// ```
///
/// The body is read as the handler asks for it, and nothing it skips is kept: a file the loop
/// passes over is read past, not stored, and [`File::chunk`] hands a file on piece by piece (to an
/// object store, say) without holding it. Text fields are kept for [`Upload::fields`], which reads
/// what is left. A file input left empty is no file: the browser sends a part with an empty file
/// name and no bytes (which `FormData` keeps as an empty `File`), and [`Upload::next_file`] passes
/// over it (design.md, Limits). A part with bytes is a file, with an empty name if it came with
/// none. The request may take the route's body limit (fields, and files it reads or passes on;
/// [`crate::App::body_limit`], 2 MiB unless set) unless the handler sets [`Upload::limit`]
/// before reading; past it the request is a 413. A file it passes
/// over does not count, and one over its [`File::bytes_up_to`] needs room for that `max` as it
/// goes over, then counts nothing (the rest is read past). A client that sends nothing for a
/// minute ([`Upload::idle`]), or trickles the body in until it is that minute behind 240 bytes a
/// second, is a 408. A body that is
/// not multipart is a 415, one that breaks the format a 400, and fields that do not fit `T` a 422. Under an [`Api`](crate::Api) each is the API's
/// failure, in its JSON shape.
///
/// A route with no text fields still names its file input with a `Files` field, so it takes the
/// file by its typed name ([`File::is`]), never by comparing [`File::field`] with a string.
pub struct Upload<T> {
    parts: Parts,
    fields: Vec<(String, String)>,
    form: PhantomData<fn() -> T>,
}

/// A file input of a form struct: `photos: Files` names the input (`name={f.photos}`) and its
/// errors (`errors.add(f.photos, ..)`); its files come from [`Upload::next_file`], so it holds
/// nothing itself.
///
/// Nothing reads a `Files` field, and `#[derive(Fields)]` marks it read, so it is not dead code:
///
/// ```
/// #![deny(dead_code)]
/// use corten::prelude::*;
///
/// #[derive(Fields)]
/// struct Export {
///     file: Files,
/// }
///
/// fn main() {
///     let _ = Export::FIELDS.file;
/// }
/// ```
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Files;

impl<'de> serde::Deserialize<'de> for Files {
    /// Missing (as it always is: files are not text fields) or anything else, it is the marker.
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Marker;
        impl<'de> serde::de::Visitor<'de> for Marker {
            type Value = Files;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a file input")
            }
            fn visit_none<E>(self) -> Result<Files, E> {
                Ok(Files)
            }
            fn visit_some<D: serde::Deserializer<'de>>(self, d: D) -> Result<Files, D::Error> {
                <serde::de::IgnoredAny as serde::Deserialize>::deserialize(d).map(|_| Files)
            }
        }
        deserializer.deserialize_option(Marker)
    }
}

impl<T> Upload<T> {
    /// The most the request takes of the body, fields and the files it reads or passes on with
    /// [`File::chunk`] together, in place of the route's limit ([`crate::App::body_limit`],
    /// 2 MiB unless the app, an area or an API sets another); set it before reading. A file the handler
    /// passes over is read past and does not count, and one over its [`File::bytes_up_to`] (the
    /// limit for one file, the handler's) needs room for that `max` as it goes over, then counts
    /// nothing: the rest is read past and what was read of it is let go. A body is
    /// read no further than 64 MiB past the limit, what is read past included, where the
    /// connection is closed.
    pub fn limit(&mut self, bytes: usize) -> &mut Self {
        self.parts.limit = bytes;
        self
    }

    /// How long the client may go without sending a piece of the body, while the request reads a
    /// file, its fields or what it passes over: a minute unless set (nginx's
    /// `client_body_timeout`, as [`Pieces::idle`](crate::extract::Pieces::idle)), and past it a
    /// read is [`UploadError::Stalled`]. The idle time is also the body's allowance against a
    /// trickle: the reads may wait for the client that long, plus a second for every 240 bytes
    /// that came (Kestrel's minimum rate), in all, so a client that sends a byte now and then is
    /// given up on too, while one sending at any real speed is never cut off for taking long in
    /// all, and a large upload's route needs only a deadline that leaves time for it. Time the
    /// handler spends between reads is not counted, and a read dropped and begun again (inside a
    /// `timeout` or `select!`) does not start the idle time again. That assumes it asks for the
    /// next piece promptly: one that spends a fixed time on each piece lets a client that sends
    /// one in that time go on. While a body over its limit is read past, a client that stops for
    /// the idle time ends that read, and the answer is still the 413.
    /// `None` leaves only the route's deadline, for the idle time and the rate both.
    pub fn idle(&mut self, idle: impl Into<Option<Duration>>) -> &mut Self {
        self.parts.idle.set(idle.into());
        self
    }

    /// The next file, reading the text fields before it (kept for [`Upload::fields`]); `None`
    /// once the body has no more. What is left of the file before is read past.
    pub async fn next_file(&mut self) -> Result<Option<File<'_>>> {
        loop {
            let Some(head) = self.parts.head().await? else { return Ok(None) };
            match head.filename {
                None => {
                    let value = self.parts.text().await?;
                    self.fields.push((head.name, value));
                }
                Some(filename) => {
                    // A file input left empty sends a part with no file name and nothing in it: no
                    // file. A part with bytes is a file whatever its name (a client may send none,
                    // or a path that ends in a separator), so it is handed out with an empty name.
                    if filename.is_empty() && self.parts.part_is_empty().await? {
                        continue;
                    }
                    let content_type = head.content_type.unwrap_or_else(|| "application/octet-stream".into());
                    return Ok(Some(File { parts: &mut self.parts, field: head.name, filename, content_type }));
                }
            }
        }
    }

    /// The text fields read into `T` as [`Form`](super::Form) reads them, after reading the rest
    /// of the body (files it reaches are read past).
    pub async fn fields(mut self) -> Result<T>
    where
        T: DeserializeOwned,
    {
        while self.next_file().await?.is_some() {}
        let pairs = self.fields.iter().map(|(k, v)| (Cow::Borrowed(k.as_str()), Cow::Borrowed(v.as_str()))).collect();
        super::de::from_pairs(pairs).map_err(|error| UploadError::Fields(error.to_string()))
    }
}

impl<T, S: Send + Sync> FromRequest<S> for Upload<T> {
    type Rejection = Response;

    async fn from_request(req: Request, _: &S) -> Result<Self, Response> {
        let boundary = req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).and_then(boundary);
        let Some(boundary) = boundary else {
            return Err(Error::new("Upload requests must have Content-Type: multipart/form-data with a boundary")
                .with_status(StatusCode::UNSUPPORTED_MEDIA_TYPE)
                .into_response());
        };
        let mut delimiter = b"\r\n--".to_vec();
        delimiter.extend_from_slice(boundary.as_bytes());
        // What it keeps unless the handler sets another (`Upload::limit`): the limit of a body read
        // whole at this route (`App::body_limit`).
        let limit = crate::extract::body_limit(req.extensions());
        let parts = Parts {
            body: req.into_body().into_data_stream(),
            // The first boundary has no line break before it: one is put there, and what comes
            // before it is read as a part that is never handed out.
            buf: Bytes::from_static(b"\r\n"),
            joined: BytesMut::new(),
            joined_before: false,
            ends_part: memchr::memmem::Finder::new(&delimiter).into_owned(),
            delimiter: delimiter.into(),
            read: 0,
            limit,
            past: 0,
            idle: Idle::new(Some(IDLE)),
            refused: false,
            stalled: false,
            ended: false,
            state: State::Body,
        };
        Ok(Upload { parts, fields: Vec::new(), form: PhantomData })
    }
}

/// The `boundary` of a `multipart/form-data` content type: 1 to 70 characters (RFC 2046).
fn boundary(content_type: &str) -> Option<&str> {
    let mut params = content_type.split(';');
    if !params.next()?.trim().eq_ignore_ascii_case("multipart/form-data") {
        return None;
    }
    let value = params.find_map(|param| {
        let (key, value) = param.split_once('=')?;
        key.trim().eq_ignore_ascii_case("boundary").then_some(value.trim())
    })?;
    let value = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(value);
    (1..=70).contains(&value.len()).then_some(value)
}

/// A file of an [`Upload`], read piece by piece ([`File::chunk`]) or whole up to a size
/// ([`File::bytes_up_to`]). What is not read is read past when the next file is asked for.
pub struct File<'a> {
    parts: &'a mut Parts,
    field: String,
    filename: String,
    content_type: String,
}

impl File<'_> {
    /// Whether the file came from the input `field` names, at the form's top, in a group or in a
    /// row.
    pub fn is<P: super::Place, T>(&self, field: FieldName<T, P>) -> bool {
        field == self.field.as_str()
    }

    /// The name of the input it came from.
    pub fn field(&self) -> &str {
        &self.field
    }

    /// The file's name as the browser sent it, without a path: the user's to choose, so never a
    /// path to write to as it is. Empty when the client sent none (or only a path) with the bytes.
    pub fn filename(&self) -> &str {
        &self.filename
    }

    /// The content type the browser sent (from the file's extension, so the client's word, not a
    /// check); `application/octet-stream` when it sent none.
    pub fn content_type(&self) -> &str {
        &self.content_type
    }

    /// The file's next piece as it arrives, `None` at its end.
    pub async fn chunk(&mut self) -> Result<Option<Bytes>> {
        self.parts.data_within(usize::MAX).await
    }

    /// The whole file, or `None` when it is larger than `max` bytes. The limit
    /// ([`Upload::limit`]) needs room for `max` bytes as the file goes over it; the rest is read
    /// past and not kept, so it counts nothing: the form's other fields can still be read and the
    /// field marked, however far over the file is (up to 64 MiB past the body's limit, where the
    /// connection is closed as for any body over it). A limit without that room is
    /// [`UploadError::TooLarge`].
    pub async fn bytes_up_to(&mut self, max: usize) -> Result<Option<Bytes>> {
        // A piece of 1 KiB or more is kept as it came (usually a slice of a larger buffer, which
        // costs nothing to keep); a run of smaller ones is copied into one buffer as they arrive,
        // so a file sent a few bytes at a time holds about its size, not a piece (and the room it
        // was cut from) for each. The pieces are joined once, at the end.
        let mut pieces: Vec<Bytes> = Vec::new();
        let mut small: Vec<u8> = Vec::new();
        let mut len = 0;
        // What of each piece is past `max` is read past, so it is not counted as kept.
        while let Some(piece) = self.parts.data_within(max.saturating_sub(len)).await? {
            len += piece.len();
            if len > max {
                drop((pieces, small));
                // What was read of it is not kept either.
                self.parts.past += len;
                self.parts.skip_part().await?;
                return Ok(None);
            }
            if piece.len() >= SMALL_PIECE {
                if !small.is_empty() {
                    pieces.push(Bytes::from(std::mem::take(&mut small)));
                }
                pieces.push(piece);
            } else {
                small.extend_from_slice(&piece);
            }
        }
        Ok(Some(match (pieces.len(), small.is_empty()) {
            (0, _) => Bytes::from(small.into_boxed_slice()),
            // A large file that came in one piece is kept as it came. A small one is copied: the
            // piece can be a slice of a read buffer hundreds of KiB long, which keeping it would
            // hold whole, past the file's limit.
            (1, true) if pieces[0].len() >= KEPT_AS_IT_CAME => pieces.swap_remove(0),
            (1, true) => Bytes::copy_from_slice(&pieces[0]),
            _ => join(&pieces, &small, len),
        }))
    }
}

/// A file's pieces, and the run of small ones after them, in one buffer of its size.
#[cold]
pub(crate) fn join(pieces: &[Bytes], small: &[u8], len: usize) -> Bytes {
    let mut whole = Vec::with_capacity(len);
    for piece in pieces {
        whole.extend_from_slice(piece);
    }
    whole.extend_from_slice(small);
    Bytes::from(whole)
}

/// The body, split at its boundaries as it arrives.
struct Parts {
    body: BodyDataStream,
    /// What has arrived and not been handed out.
    buf: Bytes,
    /// Room `buf` is joined into when a piece arrives with some of it still held.
    joined: BytesMut,
    /// Whether a room has been taken before, so the next is the full `JOIN_ROOM`.
    joined_before: bool,
    /// `\r\n--{boundary}`: what ends a part.
    delimiter: Box<[u8]>,
    /// The search for `delimiter`, built once for the request rather than for each piece.
    ends_part: memchr::memmem::Finder<'static>,
    read: usize,
    limit: usize,
    /// Of `read`, what was handed out and not kept: a file over its own limit
    /// ([`File::bytes_up_to`]) or one the handler passed over, which does not count toward
    /// `limit`. Each byte is counted once, as it leaves `buf` or as `bytes_up_to` gives it up.
    past: usize,
    /// How long a read waits for the next piece: [`Upload::idle`].
    idle: Idle,
    /// Found over the limit: every read after is `TooLarge`.
    refused: bool,
    /// The client stopped sending: every read after is `Stalled`.
    stalled: bool,
    ended: bool,
    state: State,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    /// In a part's content.
    Body,
    /// Just past a delimiter: another part's headers, or the end.
    After,
    /// Past the closing delimiter.
    Done,
}

/// A part's headers.
struct Head {
    name: String,
    filename: Option<String>,
    content_type: Option<String>,
}

fn malformed(what: &str) -> UploadError {
    UploadError::Malformed(what.into())
}

impl Parts {
    /// Reads one more piece of the body onto `buf`; false at its end.
    async fn more(&mut self) -> Result<bool> {
        if self.stalled {
            return Err(UploadError::Stalled);
        }
        if self.read > self.limit.saturating_add(READ_PAST) {
            return Err(UploadError::TooLarge { limit: self.limit });
        }
        if self.over(0) {
            return Err(self.refuse().await);
        }
        if self.ended {
            return Ok(false);
        }
        match self.idle.next(&mut self.body).await {
            None => {
                self.stalled = true;
                self.ended = true;
                self.buf = Bytes::new();
                Err(UploadError::Stalled)
            }
            Some(None) => {
                self.ended = true;
                Ok(false)
            }
            Some(Some(Err(error))) => Err(UploadError::Malformed(format!("it could not be read: {error}"))),
            Some(Some(Ok(piece))) => {
                self.read += piece.len();
                // However much of it is read past, a body is read no further than 64 MiB past its
                // limit: the connection is closed there.
                if self.read > self.limit.saturating_add(READ_PAST) {
                    self.ended = true;
                    self.refused = true;
                    self.buf = Bytes::new();
                    return Err(UploadError::TooLarge { limit: self.limit });
                }
                // Usually nothing is left over (see `data`), so the piece is used as it came. What is
                // (the start of a delimiter, a part's headers so far) is joined to a large piece in an
                // allocation of their size, and to a small one in `joined`'s room, so a body that
                // comes a few bytes at a time allocates once per 64 KiB joined (a head held near its
                // 8 KiB limit uses one up in about 8 pieces), not once per piece. (The room
                // measured slower for 16 KiB pieces, and growing the held bytes in place with
                // `Bytes::try_into_mut` slower for small ones.)
                if self.buf.is_empty() {
                    self.buf = piece;
                } else if piece.len() >= SMALL_PIECE {
                    self.buf = Bytes::from([&self.buf[..], &piece[..]].concat());
                } else {
                    self.join_small(&piece);
                }
                Ok(true)
            }
        }
    }

    /// `buf` and a small piece after it, in `joined`'s room.
    #[cold]
    fn join_small(&mut self, piece: &[u8]) {
        let need = self.buf.len() + piece.len();
        if self.joined.capacity() < need {
            // A request that joins only once (a last piece with the closing boundary) takes a
            // small room; one that has used a room up, the full one.
            let room = if self.joined_before { JOIN_ROOM } else { FIRST_ROOM };
            self.joined = BytesMut::with_capacity(need.max(room));
            self.joined_before = true;
        }
        self.joined.extend_from_slice(&self.buf);
        self.joined.extend_from_slice(piece);
        self.buf = self.joined.split().freeze();
    }

    /// The body is over its limit: the rest is read past, up to 64 MiB past the limit, since a
    /// browser still sending when the answer comes takes the closed connection for a network
    /// error and never shows the answer.
    async fn too_large(&mut self) -> UploadError {
        // Refused first, so a read given up on here is not read past again.
        self.refused = true;
        self.buf = Bytes::new();
        let mut past = self.read.saturating_sub(self.limit);
        // A client that stops sending here ends the read past; the answer is still the 413.
        while past <= READ_PAST && !self.ended {
            let next = self.idle.next(&mut self.body);
            match crate::extract::reading_past(crate::extract::Over::Upload(self.limit), next).await {
                Some(Some(Ok(piece))) => past += piece.len(),
                _ => break,
            }
        }
        self.ended = true;
        UploadError::TooLarge { limit: self.limit }
    }

    /// The rest of the current part, read past and not kept: the bytes it hands out do not count
    /// toward `limit`, which each piece is still checked against (what was kept before it, and the
    /// 64 MiB read past).
    async fn skip_part(&mut self) -> Result<()> {
        // No room: each piece is read past as it is handed out, so it is not counted.
        while let Some(piece) = self.data_within(0).await? {
            self.past += piece.len();
        }
        if self.over(0) {
            return Err(self.refuse().await);
        }
        Ok(())
    }

    /// What the request has taken of the body and kept: not what it read past, nor what it has
    /// read and not yet handed out (at most a piece).
    fn kept(&self) -> usize {
        self.read.saturating_sub(self.past + self.buf.len())
    }

    /// Whether the request is refused, or keeps more than `limit` allows (checked as each piece is
    /// handed out and before each read). `passing` bytes of what was just taken are to be read
    /// past, so they do not count (the part of a piece past a file's [`File::bytes_up_to`] `max`).
    /// A plain test, not an `async fn`, since it runs for every piece: awaiting one there cost a
    /// fifth more instructions on a body sent a byte at a time (measured, callgrind).
    #[inline]
    fn over(&self, passing: usize) -> bool {
        self.refused || self.kept().saturating_sub(passing) > self.limit
    }

    /// `TooLarge` once [`Parts::over`]: the first time, the rest of the body is read past.
    async fn refuse(&mut self) -> UploadError {
        if self.refused {
            return UploadError::TooLarge { limit: self.limit };
        }
        self.too_large().await
    }

    /// Where the delimiter first begins in `buf`.
    fn part_end(&self) -> Option<usize> {
        // A piece of a few bytes is shorter than the delimiter: nothing to search.
        if self.buf.len() < self.delimiter.len() {
            return None;
        }
        self.ends_part.find(&self.buf)
    }

    /// The current part's next piece, `None` at its end (or when not in a part).
    async fn data(&mut self) -> Result<Option<Bytes>> {
        self.data_within(usize::MAX).await
    }

    /// [`Parts::data`], where all but `room` bytes of the piece are to be read past (the rest of
    /// a file over [`File::bytes_up_to`]'s `max`), so they are not counted as kept.
    async fn data_within(&mut self, room: usize) -> Result<Option<Bytes>> {
        loop {
            if self.state != State::Body {
                return Ok(None);
            }
            if let Some(at) = self.part_end() {
                if at > 0 {
                    let piece = self.buf.split_to(at);
                    // A piece past `room` gives the file up: what is past `room` is read past, so
                    // only the file's `max` counts, however the body was split.
                    if self.over(piece.len().saturating_sub(room)) {
                        return Err(self.refuse().await);
                    }
                    return Ok(Some(piece));
                }
                self.buf = self.buf.slice(self.delimiter.len()..);
                self.state = State::After;
                return Ok(None);
            }
            // Everything but an end that could begin the delimiter is the part's.
            let held = partial(&self.buf, &self.delimiter);
            if self.buf.len() > held {
                let piece = self.buf.split_to(self.buf.len() - held);
                // A piece past `room` gives the file up: what is past `room` is read past, so
                // only the file's `max` counts, however the body was split.
                if self.over(piece.len().saturating_sub(room)) {
                    return Err(self.refuse().await);
                }
                return Ok(Some(piece));
            }
            if !self.more().await? {
                return Err(malformed("it ended inside a part"));
            }
        }
    }

    /// Whether the current part ends where it begins, reading only as far as it takes to know and
    /// handing nothing out.
    async fn part_is_empty(&mut self) -> Result<bool> {
        debug_assert!(self.state == State::Body, "called right after a part's headers");
        loop {
            let n = self.buf.len().min(self.delimiter.len());
            if self.buf[..n] != self.delimiter[..n] {
                return Ok(false);
            }
            if n == self.delimiter.len() {
                return Ok(true);
            }
            if !self.more().await? {
                return Err(malformed("it ended inside a part"));
            }
        }
    }

    /// The current part's content as text.
    async fn text(&mut self) -> Result<String> {
        let mut bytes = Vec::new();
        while let Some(piece) = self.data().await? {
            bytes.extend_from_slice(&piece);
        }
        String::from_utf8(bytes).map_err(|_| malformed("a field is not UTF-8"))
    }

    /// The next part's headers, reading past the rest of the current part; `None` at the end.
    async fn head(&mut self) -> Result<Option<Head>> {
        // A file the handler passed over, or the rest of one: not kept.
        self.skip_part().await?;
        if self.state == State::Done {
            return Ok(None);
        }
        // The delimiter's line: `--` closes the body, else (past any spaces) a line break.
        // `searched`: how far the headers' end has been looked for, so headers that come a few
        // bytes at a time are searched once rather than from the start each time.
        let mut searched = 0;
        let end = loop {
            if self.buf.starts_with(b"--") {
                self.state = State::Done;
                return Ok(None);
            }
            let found = find(&self.buf[searched..], b"\r\n\r\n").map(|at| searched + at);
            // Headers past the limit are refused however the body was split.
            if let Some(end) = found.filter(|&end| end <= HEAD_LIMIT) {
                break end;
            }
            // Headers that end at the limit: the buffer may hold three bytes past it before the
            // end's last byte arrives.
            if found.is_some() || self.buf.len() > HEAD_LIMIT + 3 {
                return Err(malformed("a part's headers are too long"));
            }
            // The end may begin in the last three bytes and finish in the next piece.
            searched = self.buf.len().saturating_sub(3);
            if !self.more().await? {
                return Err(malformed("it ended before its closing boundary"));
            }
        };
        let line = find(&self.buf, b"\r\n").unwrap_or(end);
        if !self.buf[..line].iter().all(|b| *b == b' ' || *b == b'\t') {
            return Err(malformed("a boundary is followed by text"));
        }
        let headers = if end > line { &self.buf[line + 2..end] } else { &[][..] };
        let head = parse_head(headers)?;
        self.buf = self.buf.slice(end + 4..);
        self.state = State::Body;
        Ok(Some(head))
    }
}

/// A part's `Content-Disposition: form-data; name=".."` (with `filename=".."` for a file) and
/// `Content-Type`.
fn parse_head(bytes: &[u8]) -> Result<Head> {
    let text = std::str::from_utf8(bytes).map_err(|_| malformed("a part's headers are not UTF-8"))?;
    let (mut disposition, mut content_type) = (None, None);
    for line in text.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else { return Err(malformed("a part's header has no name")) };
        if name.trim().eq_ignore_ascii_case("content-disposition") {
            disposition = Some(value.trim());
        } else if name.trim().eq_ignore_ascii_case("content-type") {
            content_type = Some(value.trim().to_string());
        }
    }
    let disposition = disposition.ok_or_else(|| malformed("a part has no Content-Disposition"))?;
    let mut params = Params(disposition);
    if !params.next_token().is_some_and(|kind| kind.eq_ignore_ascii_case("form-data")) {
        return Err(malformed("a part is not form-data"));
    }
    let (mut name, mut filename) = (None, None);
    while let Some((key, value)) = params.next_param()? {
        if key.eq_ignore_ascii_case("name") {
            name = Some(value);
        } else if key.eq_ignore_ascii_case("filename") {
            filename = Some(value);
        }
    }
    let name = name.ok_or_else(|| malformed("a part has no name"))?;
    // A path some browsers once sent, and some clients still do: the file's own name is the last part.
    let filename = filename.map(|f| f.rsplit(['/', '\\']).next().unwrap_or_default().to_string());
    Ok(Head { name, filename, content_type })
}

/// The parameters of a header value: `form-data; name="photo"; filename="a b.png"`.
struct Params<'a>(&'a str);

impl<'a> Params<'a> {
    /// The value's first token, before any `;`.
    fn next_token(&mut self) -> Option<&'a str> {
        let (token, rest) = self.0.split_once(';').unwrap_or((self.0, ""));
        self.0 = rest;
        Some(token.trim()).filter(|t| !t.is_empty())
    }

    /// The next `key=value` or `key="value"`. A quoted value is read as browsers write it (a
    /// quote, CR and LF as `%22`, `%0D`, `%0A`, a backslash as itself, so an old browser's
    /// `C:\path\name` stays a path) and as other clients write a quote (`\"`).
    fn next_param(&mut self) -> Result<Option<(&'a str, String)>> {
        let rest = self.0.trim_start_matches([' ', '\t', ';']);
        if rest.is_empty() {
            return Ok(None);
        }
        let (key, rest) = rest.split_once('=').ok_or_else(|| malformed("a header parameter has no value"))?;
        let key = key.trim();
        let rest = rest.trim_start();
        let (value, rest) = if let Some(quoted) = rest.strip_prefix('"') {
            let mut value = String::new();
            let mut chars = quoted.char_indices();
            let end = loop {
                match chars.next() {
                    Some((i, '"')) => break i + 1,
                    // `\"` is a quote, unless no quote follows to end the value (`"C:\dir\"`).
                    Some((i, '\\')) if quoted[i + 1..].starts_with('"') && quoted[i + 2..].contains('"') => {
                        value.push('"');
                        chars.next();
                    }
                    Some((_, c)) => value.push(c),
                    None => return Err(malformed("a quoted header parameter does not end")),
                }
            };
            let value = value.replace("%22", "\"").replace("%0D", "\r").replace("%0A", "\n");
            (value, &quoted[end..])
        } else {
            let (value, rest) = rest.split_once(';').unwrap_or((rest, ""));
            (value.trim().to_string(), rest)
        };
        self.0 = rest;
        Ok(Some((key, value)))
    }
}

/// Where `needle` first begins in `hay` (`memchr`'s substring search). A client picks both the
/// boundary and the bytes searched, and a byte-by-byte search was 2.3 to 35 times slower,
/// slowest on a body of `\r` (`docs/design.md#limit-multipart-overread`).
fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if hay.len() < needle.len() {
        return None;
    }
    memchr::memmem::find(hay, needle)
}

/// How long the end of `hay` is that could be the start of `needle` (shorter than all of it).
fn partial(hay: &[u8], needle: &[u8]) -> usize {
    let start = hay.len().saturating_sub(needle.len() - 1);
    (start..hay.len()).find(|&at| needle.starts_with(&hay[at..])).map_or(0, |at| hay.len() - at)
}

#[cfg(test)]
mod tests;
