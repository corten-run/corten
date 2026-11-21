//! The pages the app keeps to send again.
//!
//! A page whose route says its answer is the same for everyone ([`crate::Public`]) is one every
//! shared cache may keep for the lifetime it names. The app is the first of them: it keeps the
//! whole document its handler made for a `GET` that tells nothing about who is asking, and for
//! that lifetime (`s-maxage` where the answer has one, else `max-age`, RFC 9111 section 4.2.1)
//! gives it to the next such request in the handler's place, with an `Age`.
//!
//! While the store has room every such answer is kept. Once it is full, keeping an answer may
//! drop another page, so an answer is kept then only when its URL was asked for before, as far
//! back as the marks that say so go ([`Store::asked`]): a crawler's first walk over more URLs
//! than the bound has room for, or searches no one repeats, are answered by the handler without
//! a copy into the store, and all but the few whose mark is another's take no room from the
//! pages that are asked for again.
//!
//! It stands where the handler does, after the app's middleware, so every stage still runs for
//! every request: a middleware sees the `200` with the whole body, the security headers and
//! `Cache-Control` are written as for any answer, and a request that names the page's tag is
//! answered `304`. What a kept page saves is the handler, the render, the hash of its body for the
//! tag and its compression: the hash and each coding's bytes are made once and stay with it
//! ([`Kept`], which [`crate::cache::tag`] and `compress::finish` read), and its brotli is made
//! once more at a higher level, queued on its second compressed answer to a client that ranks
//! brotli first, by no request (`Coded`).
//!
//! What makes this safe is checked when the app compiles: a `Public` handler takes only inputs
//! that cannot tell who is asking ([`crate::answer::Anonymous`]), and a page is kept only when
//! each of them is one of Corten's own whose reading of a page's request the key covers
//! (`Anonymous::KEYED`). An extractor of the app's own may read another header and still not
//! tell who asks, so a page whose handler takes one is made for every request. The request must
//! show nothing else the page could differ by: no cookie but the time zone's (a `Public` page is
//! written in UTC), no `Authorization`, no caller read by a middleware, no `corten` header, JSON
//! not asked for first, no notice sent back, no body, and the URL the router matched (a
//! middleware that changed it since leaves the request to the handler). The key is the `Host`,
//! the path and query, and `Accept-Language` when the page's `Vary` names it or a message was
//! read in the language it asks for: a page for `/items?page=2` is not the one for `/items`. The
//! headers are compared as they were sent, so `fr` and `fr-FR` each have a copy. An answer is
//! kept only when it is a `200` of a known size with a lifetime, sets no cookie, drew no nonce
//! and no value made for this request alone, and varies on nothing but what the key covers.
//!
//! A write drops what is kept at its path, whatever the query (a named post is `?do=name` at its
//! page's path) and however the path is escaped, whatever it is answered: a handler or a
//! middleware that refused it, failed, passed its deadline or lost its client may have written
//! first, and a status does not say. Work that outlives its request
//! ([`crate::Signal::finish`]) counts again when it ends. So a client can have a kept page made
//! again by sending a write to its path: each copy is made when it is next asked for, at what the
//! page cost before the app kept pages and the copy into the store. A write that does not reach
//! the app's middleware (another site's, one for another host) is not counted.
//! A write that went through also drops what is kept at the place on this site its
//! answer names (`Location`, `Content-Location`; RFC 9111 section 4.4). A page whose handler
//! was reading while a write went through is not kept. Nothing else drops a page before its
//! lifetime ends: the lifetime is how stale the app said the page may be. Off under `corten dev`. The
//! bound is [`crate::App::kept_answers`], and counts each page's bytes, its headers, its key and
//! the compressed forms made for it, with an allowance for what holds them; the body, the key
//! and each compressed form are held in allocations of their own size
//! (`tests/kept_memory.rs` holds the count to what the allocator is asked for).
//!
//! A write is counted when it is answered or dropped, so what it changes must be there for a
//! reader by then, or be made under `Signal::finish`. One that lands later (a task the handler
//! started and did not wait for, a store whose readers lag its writers) can leave the page as
//! it was until its lifetime ends.

use std::collections::HashMap;
use std::hash::{BuildHasher, BuildHasherDefault, DefaultHasher, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
#[cfg(feature = "compress")]
use std::sync::Weak;
use std::sync::{Arc, OnceLock, PoisonError, RwLock};
use std::time::Instant;

use bytes::Bytes;
use http::{header, HeaderMap, HeaderValue, StatusCode};

use crate::body::Body;
#[cfg(feature = "compress")]
use crate::compress::{Accepts, Coding, Level};
use crate::handler::Request;
use crate::page::Mode;
use crate::response::Response;

/// [`crate::App::kept_answers`] unless set: 32 MiB.
pub(crate) const BOUND: usize = 32 << 20;

/// The share of the bound one answer may take: a larger one is not kept.
const SHARE: usize = 8;

/// The copies kept for one URL, one for each `Host` and `Accept-Language` it was asked with: a
/// new one past this takes the place of the oldest.
const COPIES: usize = 8;

/// What an entry counts for beside its key, its headers and its bytes: itself, its header map
/// and its places in the maps.
const OVERHEAD: usize = 1024;

/// What a header counts for beside its name and value: its place in the header map.
const HEADER: usize = 112;

/// What a compressed form counts for beside its bytes: the record its `Bytes` makes to share
/// them once they are cloned (three words).
#[cfg(feature = "compress")]
const FORM: usize = 24;

/// An entry's size once it is no longer kept: nothing made for it counts from then on.
const GONE: usize = usize::MAX;

/// Room for the names the stages after the handler add to a kept answer's head, so it does not
/// grow as they are written: `Age`, the tag, the security headers, the reporting endpoints and
/// what compression writes are twelve at most. A middleware of the app that adds more grows it as
/// it would any other.
const ADDED: usize = 12;

/// The most names a kept answer's head is given that room beside. One with more is copied as it
/// is, so no head is too large for the map the room asks for.
const ROOMY: usize = 64;

/// `Last-Event-ID`, held once: a comparison with a name that is not the `http` crate's own
/// would make the name each time.
static LAST_EVENT_ID: header::HeaderName = header::HeaderName::from_static("last-event-id");
/// [`crate::page::NOTICE_HEADER`], held once for the same reason.
static NOTICE: header::HeaderName = crate::page::NOTICE_HEADER;

/// A copy of a kept answer's `head`, each line where it was, with room for [`ADDED`] more
/// names: a copy made by `clone` holds its lines in a vector as long as they are, which grows on
/// the first name a stage adds. (A head with more than four lines beyond the first of their
/// names pays for this copy once more than for a `clone`, as the map's room for those is not
/// asked for.)
fn with_room(head: &HeaderMap) -> HeaderMap {
    if head.keys_len() > ROOMY {
        return head.clone();
    }
    let mut copy = HeaderMap::with_capacity(head.keys_len() + ADDED);
    for (name, value) in head {
        copy.append(name.clone(), value.clone());
    }
    copy
}

/// The counts of writes, one for the paths whose hash names it: enough of them (256 KiB, made
/// when the first page is asked for) that an app's writes seldom share a count with a kept page.
const WRITES: usize = 1 << 16;

/// How many words of marks ([`Store::asked`]) a store of `bound` bytes has, made when it first
/// fills: a mark is one bit, and there is one for every 32 bytes of the bound, rounded up to a
/// power of two of words. That is 1,048,576 marks in 128 KiB for the 32 MiB an app keeps unless
/// it says otherwise, a hundred and more for each page of a few thousand bytes it has room for.
fn marks_for(bound: usize) -> usize {
    (bound / 2048).max(1).next_power_of_two()
}

/// The app's kept answers, at most `bound` bytes of them.
pub(crate) struct Answers(Arc<Store>);

struct Store {
    bound: usize,
    /// The bytes kept: every entry's size, with what was made for it since it was kept.
    bytes: AtomicUsize,
    /// The writes, counted by path ([`Written`]): a page stands only while the count is the one
    /// its request found before its handler ran. So a write drops every page at its path,
    /// whatever its query, and a page whose handler was reading while the write was made is not
    /// kept, without a lock or a search.
    written: OnceLock<Box<[AtomicU32]>>,
    /// One bit for each mark of a URL asked for since the store filled ([`Store::asked`]).
    marks: OnceLock<Box<[AtomicU64]>>,
    /// How many of the marks are set.
    marked: AtomicUsize,
    inner: RwLock<Inner>,
}

/// Which of the store's counts is a path's: by a hash of the path with its escapes decoded
/// ([`crate::page::path_hash`]), so `/a%7Eb` and `/a~b` are one page's. Two paths may share a
/// count, and then a write to either drops the other's pages early.
fn count_of(path: &[u8]) -> usize {
    (crate::page::path_hash(path) >> 32) as usize % WRITES
}

/// A path's count of writes, as a request found it.
#[derive(Clone, Copy)]
struct Written {
    count: usize,
    was: u32,
}

impl Written {
    /// The count for `at` (a path, with or without a query) as it is now.
    /// The counts are made here, before the first page's handler runs: a write answered before
    /// then found none to count in, and what it wrote is there for that handler to read.
    fn of(store: &Store, at: &str) -> Self {
        let count = count_of(at.split(['?', '#']).next().unwrap_or(at).as_bytes());
        let counts = store.written.get_or_init(|| (0..WRITES).map(|_| AtomicU32::new(0)).collect());
        Written { count, was: counts[count].load(Ordering::Acquire) }
    }

    /// No write to the path since. The counts are there, since [`Written::of`] made them.
    fn stands(self, store: &Store) -> bool {
        store.written.get().is_some_and(|counts| counts[self.count].load(Ordering::Acquire) == self.was)
    }
}

/// A request that may change what its path shows (a method that is not safe), from before its
/// handler can start until it is answered or dropped: its path's count goes up either way.
pub(crate) struct Writing<'a> {
    answers: &'a Answers,
    count: usize,
    host: Option<HeaderValue>,
    answered: bool,
}

impl Writing<'_> {
    /// The write was answered: counts it for its path and for the places on this site its answer
    /// names (RFC 9111 section 4.4), so nothing kept there stands. Its path counts whatever the
    /// answer: a handler that answered `4xx` or `5xx`, or passed its deadline (a `503`, or a
    /// `408` while it waited for the body), may have written first, and its status does not say
    /// (work it left under `Signal::finish` counts again when it ends). That holds for the
    /// router's own `404`, `405` and `501` too: a middleware met the request before the
    /// router answered it, and nothing here knows it wrote nothing. The places an answer names
    /// count only for a write that did not fail.
    pub(crate) fn answered(mut self, res: &Response) {
        self.answered = true;
        self.answers.count(self.count);
        if res.status().is_client_error() || res.status().is_server_error() {
            return;
        }
        for name in [header::LOCATION, header::CONTENT_LOCATION, crate::page::LOCATION_HEADER] {
            let to = res.headers().get(name).and_then(|to| on_site(to.as_bytes(), self.host.as_ref()));
            if let Some(path) = to {
                self.answers.count(count_of(path));
            }
        }
    }
}

impl Drop for Writing<'_> {
    /// Dropped before its answer (the client left): what its handler wrote by then is written.
    fn drop(&mut self) {
        if !self.answered {
            self.answers.count(self.count);
        }
    }
}

/// The path of a place on this site that `to` (a `Location`) names: one that starts at the
/// root, or a whole URL with the request's `Host`. Another site's page is not kept here, and a
/// reference relative to the request's path is not followed.
fn on_site<'a>(to: &'a [u8], host: Option<&HeaderValue>) -> Option<&'a [u8]> {
    let path = |rest: &'a [u8]| rest.split(|byte| matches!(byte, b'?' | b'#')).next().unwrap_or(rest);
    let schemes: [&[u8]; 3] = [b"https://", b"http://", b"//"];
    let named = schemes.iter().find_map(|scheme| {
        let start = to.get(..scheme.len()).filter(|start| start.eq_ignore_ascii_case(scheme))?;
        Some(&to[start.len()..])
    });
    match named {
        Some(rest) => {
            let end = rest.iter().position(|byte| matches!(byte, b'/' | b'?' | b'#')).unwrap_or(rest.len());
            let (authority, rest) = rest.split_at(end);
            host.filter(|host| host.as_bytes().eq_ignore_ascii_case(authority)).map(|_| match rest.first() {
                Some(b'/') => path(rest),
                _ => &b"/"[..],
            })
        }
        None => to.starts_with(b"/").then(|| path(to)),
    }
}

/// Where an entry is kept.
struct Place {
    /// In the clock's slots.
    slot: usize,
    /// The store, to count what is made for the entry later and make room for that.
    #[cfg(feature = "compress")]
    store: Weak<Store>,
}

#[derive(Default)]
struct Inner {
    /// By path and query, the copies for each `Host` and `Accept-Language`.
    at: HashMap<Box<str>, Vec<Arc<Entry>>>,
    /// Every entry, in the place the clock's hand finds it: one not used since the hand last
    /// passed is the next to go when the bound is passed.
    slots: Vec<Option<Arc<Entry>>>,
    free: Vec<usize>,
    hand: usize,
}

/// One kept answer, as its handler gave it.
pub(crate) struct Entry {
    at: Box<str>,
    place: Place,
    written: Written,
    host: Option<HeaderValue>,
    /// The `Accept-Language` it was asked with, when its `Vary` names the header.
    language: Option<Option<HeaderValue>>,
    made: Instant,
    /// Its lifetime, in seconds.
    lifetime: u64,
    head: HeaderMap,
    cache: crate::cache::Typed,
    style: Option<crate::security::StyleBlock>,
    body: Bytes,
    /// The tag's hasher once it has read the body ([`crate::cache::tag`]).
    hashed: OnceLock<DefaultHasher>,
    /// The body compressed, as requests asked for it.
    #[cfg(feature = "compress")]
    coded: Coded,
    used: AtomicBool,
    /// What it counts for in the store's bytes, or [`GONE`].
    size: AtomicUsize,
}

/// A kept answer's body compressed: in each coding at the per-request level, made by the first
/// request that asks for that coding, and in brotli at [`Level::Kept`], queued on the second
/// answer to a client that ranks brotli as high as any coding and made on the thread that
/// compresses held values, so no request waits for it. From then on such a client gets it.
#[cfg(feature = "compress")]
#[derive(Default)]
struct Coded {
    now: [OnceLock<Bytes>; 3],
    brotli: OnceLock<Bytes>,
    /// The answers to a client that ranks brotli as high as any coding before `brotli` was made:
    /// the second queues it, and a later one again when the queue was full.
    asked: AtomicU32,
    started: AtomicBool,
}

/// On a response whose body is a kept answer's: the stages after the handler find the body's
/// hash and its compressed forms here while the body is still those bytes, as a held value's are
/// found (`compress::Stored`). A middleware that replaced the body keeps the extension, not the
/// bytes it stood for.
#[derive(Clone)]
pub(crate) struct Kept(Arc<Entry>);

impl Kept {
    fn of<'a>(extensions: &'a http::Extensions, body: &Bytes) -> Option<&'a Arc<Entry>> {
        let Kept(entry) = extensions.get::<Kept>()?;
        (entry.body.as_ptr() == body.as_ptr() && entry.body.len() == body.len()).then_some(entry)
    }

    /// The tag's hasher with `body` read, which `start` makes: kept with the answer `body` is
    /// from, so only its first tag reads the body.
    pub(crate) fn hashed<S: BuildHasher<Hasher = DefaultHasher>>(
        extensions: &http::Extensions,
        body: &Bytes,
        key: &S,
    ) -> DefaultHasher {
        let start = || {
            let mut hasher = key.build_hasher();
            // Its length first, so no body and headers read as another body and fewer headers.
            hasher.write_usize(body.len());
            hasher.write(body);
            hasher
        };
        match Kept::of(extensions, body) {
            Some(entry) => entry.hashed.get_or_init(start).clone(),
            None => start(),
        }
    }

    /// `body` compressed for a request that `accepts` it and prefers `coding` now, which
    /// `encode` makes, and the coding it is in. Kept with the answer `body` is from ([`Coded`]):
    /// only the first request for a coding compresses it, and a client that ranks brotli as high
    /// as any coding gets its [`Level::Kept`] form once that is made.
    #[cfg(feature = "compress")]
    pub(crate) fn coded(
        extensions: &http::Extensions,
        body: &Bytes,
        accepts: Accepts,
        coding: Coding,
        encode: impl FnOnce() -> Bytes,
    ) -> (Bytes, Coding) {
        let Some(entry) = Kept::of(extensions, body) else { return (encode(), coding) };
        if accepts.stored() == Some(Coding::Brotli) {
            let coded = &entry.coded;
            if let Some(brotli) = coded.brotli.get() {
                return (brotli.clone(), Coding::Brotli);
            }
            // Not on the first such answer (usually the one that made the page): a page asked
            // for once is compressed once. The job holds the page weakly while it waits its
            // turn, so its bytes are not held for it, and one that no longer stands by then is
            // skipped (`Entry::make_brotli`).
            if coded.asked.fetch_add(1, Ordering::Relaxed) >= 1 && !coded.started.swap(true, Ordering::AcqRel) {
                let page = Arc::downgrade(entry);
                let made = crate::compress::later(Box::new(move || {
                    if let Some(entry) = page.upgrade() {
                        entry.make_brotli();
                    }
                }));
                if !made {
                    // Full, or no thread to be had: a later answer asks again.
                    coded.started.store(false, Ordering::Release);
                }
            }
        }
        let slot = &entry.coded.now[coding as usize];
        if let Some(coded) = slot.get() {
            return (coded.clone(), coding);
        }
        // Made outside the cell: two first requests each compress it, and neither waits.
        // A copy of its own length: an encoder's buffer is sized for the worst case, and the
        // bytes made from it hold all of that for as long as they are kept.
        let coded = Bytes::copy_from_slice(&encode());
        if slot.set(coded.clone()).is_ok() {
            entry.grew(coded.len() + FORM);
        }
        (coded, coding)
    }
}

impl Entry {
    /// Makes its body's brotli at [`Level::Kept`], gives it to the answers from then on and
    /// counts it, while it is kept and stands: asked before the work, and again when the bytes are
    /// put with it under the store's lock, which an entry is taken out under. So the brotli of a
    /// page written to, past its lifetime, replaced or dropped meanwhile is not given or counted,
    /// and no page that stands makes room for it.
    #[cfg(feature = "compress")]
    fn make_brotli(&self) {
        let Some(store) = self.place.store.upgrade() else { return };
        let kept = || self.size.load(Ordering::Acquire) != GONE && self.stands(&store, Instant::now());
        if !kept() {
            return;
        }
        // A copy of its own length, as each coding's bytes are (`Kept::coded`).
        let made = Bytes::copy_from_slice(&crate::compress::encode(Coding::Brotli, &self.body, Level::Kept));
        let size = made.len() + FORM;
        let mut inner = store.inner.write().unwrap_or_else(PoisonError::into_inner);
        // Put with it as a clone, which makes the record that shares the bytes (`FORM`) here: the
        // first answer to give them would make it otherwise, and every answer would clone them by
        // the path for bytes not yet shared.
        if !kept() || self.coded.brotli.set(made.clone()).is_err() {
            return;
        }
        // Counted in the store first, as `grew` counts; under the lock it cannot go meanwhile.
        store.bytes.fetch_add(size, Ordering::AcqRel);
        self.size.fetch_add(size, Ordering::AcqRel);
        if store.bytes.load(Ordering::Acquire) > store.bound {
            store.make_room(&mut inner, self);
        }
    }

    /// Counts `more` bytes made for it, unless it is no longer kept, and makes room for them when
    /// they take the store past its bound, as keeping a page does.
    #[cfg(feature = "compress")]
    fn grew(&self, more: usize) {
        let Some(store) = self.place.store.upgrade() else { return };
        // Added first and taken back if it is gone, so the total never falls below what the
        // entries count for.
        store.bytes.fetch_add(more, Ordering::AcqRel);
        let mut now = self.size.load(Ordering::Acquire);
        loop {
            if now == GONE {
                store.bytes.fetch_sub(more, Ordering::AcqRel);
                return;
            }
            match self.size.compare_exchange_weak(now, now + more, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => break,
                Err(actual) => now = actual,
            }
        }
        if store.bytes.load(Ordering::Acquire) > store.bound {
            let mut inner = store.inner.write().unwrap_or_else(PoisonError::into_inner);
            store.make_room(&mut inner, self);
        }
    }

    /// Its age in seconds, which its lifetime is counted in.
    fn age(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.made).as_secs()
    }

    /// Within its lifetime, with no write to its path since its handler read.
    fn stands(&self, store: &Store, now: Instant) -> bool {
        self.age(now) < self.lifetime && self.written.stands(store)
    }

    fn is_for(&self, host: Option<&HeaderValue>, language: Option<&HeaderValue>) -> bool {
        self.host.as_ref() == host && self.language.as_ref().is_none_or(|kept| kept.as_ref() == language)
    }
}

impl Store {
    /// Whether keeping an answer may have to drop a page: the bytes kept are within the largest
    /// answer that is kept ([`SHARE`]) of the bound. The pages that no longer stand count too,
    /// since most stay until room is made: a store that filled once is seldom not full again,
    /// and when it is, answers are kept the first time until it fills.
    fn full(&self) -> bool {
        self.bytes.load(Ordering::Relaxed) > self.bound - self.bound / SHARE
    }

    /// Whether the URL `at` (a path and query), asked for with `host` in any language, was asked
    /// for before by a request no kept answer stood for, in a full store, since the marks were
    /// last cleared; and marks it.
    ///
    /// A mark is one bit, found by a hash of the URL, and no other URL unsets it. So a URL
    /// asked for before is known, and one not asked for before is taken for known when its
    /// bit is another's: its answer is then kept the first time, as every answer is while the
    /// store has room. Once an eighth of the marks are set they are all cleared, which holds
    /// that to one new URL in eight at most, and costs each page that is asked for again after
    /// its kept copy has gone one more run of its handler.
    ///
    /// The hash has no key of the process's. A client that chooses URLs sharing a mark gains
    /// an answer kept the first time, and one that asks for enough new URLs to clear the marks
    /// gains that one more run for each page, with requests that each ran a handler.
    fn asked(&self, host: Option<&HeaderValue>, at: &str) -> bool {
        let marks = self.marks.get_or_init(|| (0..marks_for(self.bound)).map(|_| AtomicU64::new(0)).collect());
        let hash = BuildHasherDefault::<DefaultHasher>::default().hash_one((host.map(HeaderValue::as_bytes), at));
        let (word, bit) = (&marks[(hash >> 6) as usize % marks.len()], 1 << (hash & 63));
        if word.fetch_or(bit, Ordering::Relaxed) & bit != 0 {
            return true;
        }
        // 64 marks a word, so this is an eighth of them. The URL that clears them is unmarked
        // with the rest, and requests that get here at once may each clear or count one too
        // many: a URL is then asked for once more than it had to be.
        if self.marked.fetch_add(1, Ordering::Relaxed) >= marks.len() * 8 {
            marks.iter().for_each(|word| word.store(0, Ordering::Relaxed));
            self.marked.store(0, Ordering::Relaxed);
        }
        false
    }

    /// Takes `entry` out of its slot and its URL's copies, and its size out of the bytes kept.
    fn drop_entry(&self, inner: &mut Inner, entry: &Arc<Entry>) {
        let slot = entry.place.slot;
        if inner.slots.get(slot).and_then(Option::as_ref).is_some_and(|held| Arc::ptr_eq(held, entry)) {
            inner.slots[slot] = None;
            inner.free.push(slot);
        }
        if let Some(copies) = inner.at.get_mut(&entry.at) {
            copies.retain(|copy| !Arc::ptr_eq(copy, entry));
            if copies.is_empty() {
                inner.at.remove(&entry.at);
            }
        }
        let size = entry.size.swap(GONE, Ordering::AcqRel);
        if size != GONE {
            self.bytes.fetch_sub(size, Ordering::AcqRel);
        }
    }

    /// Drops entries until the bound holds: one that no longer stands (past its lifetime, or
    /// written to since), or not used since the hand last passed it, as the hand comes to it.
    /// Never `kept`, the one room is made for.
    fn make_room(&self, inner: &mut Inner, kept: &Entry) {
        let now = Instant::now();
        // Twice around: the first pass clears every mark, so the second finds one to drop.
        let mut steps = inner.slots.len() * 2;
        while self.bytes.load(Ordering::Acquire) > self.bound && steps > 0 {
            steps -= 1;
            inner.hand = (inner.hand + 1) % inner.slots.len();
            let Some(entry) = inner.slots[inner.hand].clone() else { continue };
            if std::ptr::eq(&*entry, kept) {
                continue;
            }
            if entry.stands(self, now) && entry.used.swap(false, Ordering::Relaxed) {
                continue;
            }
            self.drop_entry(inner, &entry);
        }
    }
}

impl Answers {
    /// Room for `bound` bytes of answers; none for a bound of 0.
    pub(crate) fn new(bound: usize) -> Option<Self> {
        (bound > 0).then(|| {
            Answers(Arc::new(Store {
                bound,
                bytes: AtomicUsize::new(0),
                written: OnceLock::new(),
                marks: OnceLock::new(),
                marked: AtomicUsize::new(0),
                inner: RwLock::default(),
            }))
        })
    }

    /// The bytes kept now.
    #[cfg(test)]
    pub(crate) fn bytes(&self) -> usize {
        self.0.bytes.load(Ordering::Acquire)
    }

    /// The answer kept for a request, while it stands, with its age in seconds.
    fn find(&self, at: &str, host: Option<&HeaderValue>, language: Option<&HeaderValue>) -> Option<(Arc<Entry>, u64)> {
        let inner = self.0.inner.read().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        // The copy that stands: one that no longer does is in no other's way until it goes.
        let entry = inner.at.get(at)?.iter().find(|entry| entry.is_for(host, language) && entry.stands(&self.0, now))?;
        let age = entry.age(now);
        // Stored only when it changes: a page read often is marked once for each pass of the hand.
        if !entry.used.load(Ordering::Relaxed) {
            entry.used.store(true, Ordering::Relaxed);
        }
        Some((entry.clone(), age))
    }

    /// Keeps `entry`, in the place of the copy it stands for, and makes room for it.
    fn keep(&self, make: impl FnOnce(Place) -> Entry) -> Arc<Entry> {
        let store = &*self.0;
        let mut inner = store.inner.write().unwrap_or_else(PoisonError::into_inner);
        let slot = inner.free.pop().unwrap_or(inner.slots.len());
        let entry = Arc::new(make(Place {
            slot,
            #[cfg(feature = "compress")]
            store: Arc::downgrade(&self.0),
        }));
        let now = Instant::now();
        let copies = inner.at.get(&entry.at).map(Vec::as_slice).unwrap_or_default();
        // The copies this one takes the place of: the one asked the same way, and those that no
        // longer stand. With none of either in a full set, the oldest not read since it was kept
        // (or since the hand passed it), so a way of asking seen once does not take the place of
        // one seen often; else the oldest.
        let mut replaced: Vec<_> = copies
            .iter()
            .filter(|copy| (copy.host == entry.host && copy.language == entry.language) || !copy.stands(store, now))
            .cloned()
            .collect();
        if replaced.is_empty() && copies.len() >= COPIES {
            replaced.extend(copies.iter().find(|copy| !copy.used.load(Ordering::Relaxed)).or(copies.first()).cloned());
        }
        for replaced in &replaced {
            store.drop_entry(&mut inner, replaced);
        }
        if slot == inner.slots.len() {
            inner.slots.push(None);
        }
        inner.slots[slot] = Some(entry.clone());
        inner.at.entry(entry.at.clone()).or_default().push(entry.clone());
        store.bytes.fetch_add(entry.size.load(Ordering::Acquire), Ordering::AcqRel);
        store.make_room(&mut inner, &entry);
        entry
    }

    /// A request that may change what its path shows is about to reach its handler. `signal` is
    /// told which count is the path's, for work that outlives the request ([`crate::Signal::finish`]).
    pub(crate) fn writing(&self, req: &Request, signal: &crate::Signal) -> Writing<'_> {
        let count = count_of(req.uri().path().as_bytes());
        signal.writes(count);
        Writing { answers: self, count, host: req.headers().get(header::HOST).cloned(), answered: false }
    }

    /// Counts a write to the paths `count` is for, so no page kept for them stands: every
    /// query's (a named post is `?do=name` at its page's path) and one whose handler has yet to
    /// answer.
    pub(crate) fn count(&self, count: usize) {
        // With no page asked for yet there is none to drop.
        if let Some(counts) = self.0.written.get() {
            counts[count].fetch_add(1, Ordering::AcqRel);
        }
    }
}

/// A request a kept answer can stand for: a `GET` for the whole document that shows nothing
/// about who is asking, read as the handler would see it (after the app's middleware).
pub(crate) struct Asked<'a> {
    answers: &'a Answers,
    at: &'a str,
    host: Option<&'a HeaderValue>,
    language: Option<&'a HeaderValue>,
}

/// What a request's headers say of whether a kept answer can stand for it, and the two its key
/// is made of.
struct Sent<'a> {
    host: Option<&'a HeaderValue>,
    language: Option<&'a HeaderValue>,
}

impl<'a> Sent<'a> {
    /// `None` where the headers show something the page could differ by beside its key: a
    /// cookie but the time zone's, an `Authorization`, what the runtime asks for (`corten`,
    /// whatever it says), a data client's JSON asked for first, a notice the page sends back
    /// when it is read again, where a stream stopped, a body.
    fn read(headers: &'a HeaderMap) -> Option<Self> {
        // By their names and first, since they are what most requests a page is not kept for
        // carry: a session's cookie, and the runtime's header on a navigation inside the app.
        if crate::cache::Credentials::read(headers).personal(|| headers.contains_key(header::AUTHORIZATION))
            || headers.contains_key(crate::page::MODE_HEADER)
        {
            return None;
        }
        // The rest in one pass over the headers, where each would be a lookup by its name.
        let (mut host, mut language, mut accepted) = (None, None, false);
        // The document a browser loads and not a data client's JSON, by the rule for a request's
        // mode ([`Mode::said`]) with no `corten` header, as none was found above.
        let document = |accept: Option<&'a HeaderValue>| Mode::said(None, || accept).0 == (Mode::Document, false);
        for (name, value) in headers {
            // The first line of each, which is what a lookup gives.
            if name == header::HOST {
                host = host.or(Some(value));
            } else if name == header::ACCEPT {
                // A data client's request leaves here, as it left before the rest was read.
                if !accepted && !document(Some(value)) {
                    return None;
                }
                accepted = true;
            } else if name == header::ACCEPT_LANGUAGE {
                language = language.or(Some(value));
            } else if name == header::CONTENT_LENGTH
                || name == header::TRANSFER_ENCODING
                || *name == NOTICE
                || *name == LAST_EVENT_ID
            {
                return None;
            }
        }
        (accepted || document(None)).then_some(Sent { host, language })
    }
}

impl<'a> Asked<'a> {
    pub(crate) fn of(req: &'a Request) -> Option<Self> {
        if *req.method() != http::Method::GET {
            return None;
        }
        let signal = req.extensions().get::<crate::Signal>()?;
        let answers = signal.shared()?.kept.as_ref()?;
        // A caller a middleware read makes the answer that caller's, and the error page's request
        // is not the one the route would answer.
        if signal.is_personal() || signal.is_error_page() {
            return None;
        }
        let Sent { host, language } = Sent::read(req.headers())?;
        // In origin form: a URL that names its own host is a proxy's.
        if req.uri().authority().is_some() {
            return None;
        }
        let at = req.uri().path_and_query()?;
        // The URL the router matched: a route's parameters are read from the path as it was then
        // ([`crate::router::MatchedPath`]), so after a middleware changed the URI, the one the
        // handler sees no longer names the page it makes.
        if req.extensions().get::<crate::router::MatchedPath>().is_none_or(|matched| matched.matched() != at) {
            return None;
        }
        let at = at.as_str();
        Some(Asked { answers, at, host, language })
    }

    /// The kept answer for this request, as its handler gave it, with its age.
    pub(crate) fn find(&self) -> Option<Response> {
        let (entry, age) = self.answers.find(self.at, self.host, self.language)?;
        let mut res = Response::new(Body::from(entry.body.clone()));
        let mut head = with_room(&entry.head);
        // So a cache after this one, the browser's too, does not start the lifetime over.
        head.insert(header::AGE, HeaderValue::from(age));
        *res.headers_mut() = head;
        let extensions = res.extensions_mut();
        extensions.insert(entry.cache);
        if let Some(style) = &entry.style {
            extensions.insert(style.clone());
        }
        extensions.insert(Kept(entry));
        Some(res)
    }

    /// What keeping the handler's answer needs of the request, once no kept one stood for it:
    /// taken before the handler runs, so the answer's age counts its making and a write made
    /// meanwhile is seen. None in a full store for a URL not asked for before: keeping its
    /// answer would drop a page for one no one is known to ask for again, so the answer is the
    /// handler's and nothing here is paid for it but the mark it leaves.
    pub(crate) fn missed(&self, req: &Request) -> Option<Missed> {
        let store = &*self.answers.0;
        if store.full() && !store.asked(self.host, self.at) {
            return None;
        }
        Some(Missed {
            asked: Instant::now(),
            written: Written::of(&self.answers.0, self.at),
            signal: req.extensions().get::<crate::Signal>().cloned(),
            nonce: req.extensions().get::<crate::security::NonceSlot>().cloned(),
            at: self.at.into(),
            // Copies of their own: a request's header values are slices of the connection's read
            // buffer, which a kept one would hold whole.
            host: self.host.and_then(|host| HeaderValue::from_bytes(host.as_bytes()).ok()),
            language: self.language.and_then(|language| HeaderValue::from_bytes(language.as_bytes()).ok()),
        })
    }
}

/// A request no kept answer stood for, whose handler's answer is kept if it may be.
pub(crate) struct Missed {
    asked: Instant,
    written: Written,
    signal: Option<crate::Signal>,
    nonce: Option<crate::security::NonceSlot>,
    at: Box<str>,
    host: Option<HeaderValue>,
    language: Option<HeaderValue>,
}

impl Missed {
    /// `res`, kept when it is the same for everyone and for how long: see the module.
    pub(crate) async fn keep(self, res: Response) -> Response {
        let shared = self.signal.as_ref().and_then(crate::Signal::shared);
        let Some(answers) = shared.and_then(|shared| shared.kept.as_ref()) else { return res };
        let Some((cache, lifetime)) = crate::cache::Typed::shared(&res) else { return res };
        // Whether the page varies on `Accept-Language`, or on something the key does not cover.
        let Some(language) = varies(res.headers()) else { return res };
        // A page in the language the request asked for, in an app whose answers do not say so
        // (messages read with no `App::messages`): one copy for each `Accept-Language` too.
        let language = language || self.signal.as_ref().is_some_and(crate::Signal::asked_language);
        let style = res.extensions().get::<crate::security::StyleBlock>().cloned();
        // Only what is put back on a kept answer: a mark this does not know is not replayed.
        let known = 2 + usize::from(style.is_some());
        if res.status() != StatusCode::OK
            || res.extensions().len() != known
            || res.extensions().get::<crate::layout::SameForAll>().is_none()
            || res.headers().contains_key(header::SET_COOKIE)
            || res.headers().contains_key(header::CONTENT_ENCODING)
            || res.headers().contains_key(header::CONTENT_RANGE)
            || res.headers().contains_key(header::ETAG)
            || self.nonce.as_ref().is_some_and(|slot| slot.taken().is_some())
            || self.signal.as_ref().is_none_or(crate::Signal::is_personal)
            // A write to the path while the handler read: the page may show what was there before.
            || !self.written.stands(&answers.0)
            // Made over a time longer than it lasts: it would never be given.
            || self.asked.elapsed().as_secs() >= lifetime
        {
            return res;
        }
        let Some(length) = http_body::Body::size_hint(res.body()).exact() else { return res };
        let head: usize = res.headers().iter().map(|(name, value)| name.as_str().len() + value.len() + HEADER).sum();
        // The URL is held twice, by the entry and by the map.
        let key = self.at.len() * 2
            + self.host.as_ref().map_or(0, HeaderValue::len)
            + self.language.as_ref().filter(|_| language).map_or(0, HeaderValue::len);
        let size = key + head + OVERHEAD + length as usize;
        if length == 0 || size > answers.0.bound / SHARE {
            return res;
        }
        let (mut parts, body) = res.into_parts();
        // Exact size: one held `Bytes`.
        let Ok(body) = crate::body::to_bytes(body, usize::MAX).await else {
            // A body of an exact size that could not be read: not a page to send as it is.
            return crate::response::IntoResponse::into_response(StatusCode::INTERNAL_SERVER_ERROR);
        };
        // A copy of its own length: a page's buffer is sized for the last page rendered, and the
        // bytes made from it hold all of that for as long as they are kept.
        let body = Bytes::copy_from_slice(&body);
        let Missed { at, host, language: asked, asked: made, written, .. } = self;
        let entry = answers.keep(|place| Entry {
            at,
            place,
            written,
            host,
            language: language.then_some(asked),
            made,
            lifetime,
            head: parts.headers.clone(),
            cache,
            style,
            body: body.clone(),
            hashed: OnceLock::new(),
            #[cfg(feature = "compress")]
            coded: Default::default(),
            used: AtomicBool::new(false),
            size: AtomicUsize::new(size),
        });
        // This answer's tag and compression are the kept one's first.
        parts.extensions.insert(Kept(entry));
        Response::from_parts(parts, Body::from(body))
    }
}

/// Whether an answer with these headers varies on `Accept-Language`; `None` when it varies on
/// something a kept answer's key does not cover (`*`, a header of the app's), so it is not kept.
/// `corten` and `accept` choose the page's form, which only the whole document is kept for.
fn varies(headers: &HeaderMap) -> Option<bool> {
    let mut language = false;
    for line in headers.get_all(header::VARY) {
        for name in line.as_bytes().split(|&b| b == b',').map(<[u8]>::trim_ascii).filter(|name| !name.is_empty()) {
            if name.eq_ignore_ascii_case(b"accept-language") {
                language = true;
            } else if !name.eq_ignore_ascii_case(b"corten") && !name.eq_ignore_ascii_case(b"accept") {
                return None;
            }
        }
    }
    Some(language)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What [`Sent::read`] reads, by a lookup of each header's name: the rule as the functions
    /// that own each part of it say it.
    fn by_name(headers: &HeaderMap) -> Option<(Option<&HeaderValue>, Option<&HeaderValue>)> {
        if crate::cache::Credentials::read(headers).personal(|| headers.contains_key(header::AUTHORIZATION)) {
            return None;
        }
        if headers.contains_key(crate::page::MODE_HEADER) || Mode::asked(headers) != (Mode::Document, false) {
            return None;
        }
        let read = [
            crate::page::NOTICE_HEADER,
            header::HeaderName::from_static("last-event-id"),
            header::CONTENT_LENGTH,
            header::TRANSFER_ENCODING,
        ];
        if read.iter().any(|name| headers.contains_key(name)) {
            return None;
        }
        Some((headers.get(header::HOST), headers.get(header::ACCEPT_LANGUAGE)))
    }

    /// Each line of `headers`, in the order a response is written in.
    fn lines(headers: &HeaderMap) -> Vec<(&header::HeaderName, &HeaderValue)> {
        headers.iter().collect()
    }

    #[test]
    fn a_kept_head_is_copied_line_for_line_with_room_for_what_the_stages_add() {
        // Made as a page's head is, with room in its table that a `clone` has as well.
        let mut head = HeaderMap::new();
        head.reserve(13);
        for (name, value) in [
            ("content-type", "text/html; charset=utf-8"),
            ("link", "</a.css>; rel=preload; as=style"),
            ("vary", "corten, accept"),
            ("corten-shell", "f2858fac99b1c5e6"),
            ("vary", "accept-language"),
        ] {
            head.append(header::HeaderName::from_static(name), HeaderValue::from_static(value));
        }
        // A name taken out and put back, so the map's own order is not the order it was filled in
        // (`http` 1.5 moves the last name into the place of one taken out).
        head.remove("link");
        head.append("link", HeaderValue::from_static("</a.css>; rel=preload; as=style"));
        head.append("link", HeaderValue::from_static("</b.js>; rel=modulepreload"));
        let mut copy = with_room(&head);
        assert_eq!(lines(&copy), lines(&head));
        // As many more names as the stages add, and the map is the size it was made, with each
        // line where it was put: the vector a `clone` holds them in grows on the first of these
        // and moves them, which the size of the map's table does not show.
        let first = |copy: &HeaderMap| std::ptr::from_ref(&copy[header::CONTENT_TYPE]);
        let (room, at) = (copy.capacity(), first(&copy));
        assert!(room >= head.keys_len() + ADDED, "{room}");
        for added in 0..ADDED {
            copy.insert(
                header::HeaderName::from_bytes(format!("x-added-{added}").as_bytes()).unwrap(),
                HeaderValue::from_static("1"),
            );
        }
        assert_eq!(copy.capacity(), room);
        assert_eq!(first(&copy), at);
        assert_eq!(lines(&copy)[..head.len()], lines(&head)[..]);

        // A head of more names than is given room, with two lines of one, is copied as it is: the
        // copy is the size of the map it was copied from, which was made larger than the room.
        let mut large = HeaderMap::with_capacity(4 * ROOMY);
        for name in 0..=ROOMY {
            large.append(header::HeaderName::from_bytes(format!("x-{name}").as_bytes()).unwrap(), HeaderValue::from(name));
        }
        large.append("x-0", HeaderValue::from_static("again"));
        let roomy = HeaderMap::<HeaderValue>::with_capacity(ROOMY + ADDED).capacity();
        assert!(large.capacity() > roomy, "{} {roomy}", large.capacity());
        let copy = with_room(&large);
        assert_eq!(lines(&copy), lines(&large));
        assert_eq!(copy.capacity(), large.capacity());
        // And the largest that is given room has that room and no more.
        large.remove("x-1");
        let copy = with_room(&large);
        assert_eq!(lines(&copy), lines(&large));
        assert_eq!(copy.capacity(), roomy);
    }

    #[test]
    fn the_headers_read_in_one_pass_are_what_a_lookup_of_each_name_reads() {
        // Each header not sent, sent, and sent on two lines, with each value that changes what is
        // read of it.
        let sent: [(header::HeaderName, &[&[&[u8]]]); 11] = [
            (
                header::COOKIE,
                &[
                    &[],
                    &[b"corten-zone=UTC"],
                    &[b"sid=1"],
                    &[b"corten-zone=UTC", b"corten-zone=UTC"],
                    &[b"corten-zone=UTC; sid=1"],
                ],
            ),
            (header::AUTHORIZATION, &[&[], &[b"Bearer x"]]),
            (crate::page::MODE_HEADER, &[&[], &[b"nav"], &[b"another"]]),
            (
                header::ACCEPT,
                &[
                    &[],
                    &[b"application/json"],
                    &[b"text/html,application/json"],
                    &[b"text/html", b"application/json"],
                    &[b"application/json", b"text/html"],
                    &[b" application/json ; q=1, text/html"],
                    &[b"\xff"],
                ],
            ),
            (crate::page::NOTICE_HEADER, &[&[], &[b"saved"]]),
            (header::HeaderName::from_static("last-event-id"), &[&[], &[b"7"]]),
            (header::CONTENT_LENGTH, &[&[], &[b"0"]]),
            (header::TRANSFER_ENCODING, &[&[], &[b"chunked"]]),
            (header::HOST, &[&[], &[b"a.example"], &[b"a.example", b"b.example"]]),
            (header::ACCEPT_LANGUAGE, &[&[], &[b"fr"], &[b"fr", b"en"]]),
            // One the rule does not read, as most of a browser's are.
            (header::USER_AGENT, &[&[], &[b"a browser"]]),
        ];
        let (mut kept, mut left) = (0, 0);
        let mut choice = [0; 11];
        loop {
            for backwards in [false, true] {
                let mut headers = HeaderMap::new();
                let mut order: Vec<usize> = (0..sent.len()).collect();
                if backwards {
                    order.reverse();
                }
                for at in order {
                    for line in sent[at].1[choice[at]] {
                        headers.append(sent[at].0.clone(), HeaderValue::from_bytes(line).unwrap());
                    }
                }
                let read = Sent::read(&headers).map(|sent| (sent.host, sent.language));
                assert_eq!(read, by_name(&headers), "{headers:?}");
                match read {
                    Some(_) => kept += 1,
                    None => left += 1,
                }
            }
            // The next choice of lines, as a number with a digit for each header.
            let Some(at) = (0..sent.len()).find(|&at| choice[at] + 1 < sent[at].1.len()) else { break };
            choice[at] += 1;
            choice[..at].fill(0);
        }
        // Both answers were met, for more than the request with no header at all.
        assert!(kept > 100 && left > 100, "{kept} {left}");
    }

    /// An answer for `at` whose request found the path's writes as they are now.
    fn entry(answers: &Answers, at: &str, host: Option<&'static str>, lifetime: u64, body: usize) -> impl FnOnce(Place) -> Entry {
        let written = Written::of(&answers.0, at);
        let at: Box<str> = at.into();
        move |place| Entry {
            at,
            place,
            written,
            host: host.map(HeaderValue::from_static),
            language: None,
            made: Instant::now(),
            lifetime,
            head: HeaderMap::new(),
            cache: crate::cache::Typed::for_test(),
            style: None,
            body: Bytes::from(vec![b'x'; body]),
            hashed: OnceLock::new(),
            #[cfg(feature = "compress")]
            coded: Default::default(),
            used: AtomicBool::new(false),
            size: AtomicUsize::new(body + OVERHEAD),
        }
    }

    /// A store with room is not full and has no marks. Full, it knows a URL asked for before,
    /// each host's apart, and clears its marks once an eighth of them are set.
    #[test]
    fn a_full_store_knows_the_urls_asked_for_before() {
        const BOUND: usize = 64 << 10;
        assert_eq!([1, 2048, BOUND, 3 << 20, 32 << 20].map(marks_for), [1, 1, 32, 2048, 16384]);
        let answers = Answers::new(BOUND).expect("a bound");
        let store = &*answers.0;
        let mut pages = 0;
        while !store.full() {
            answers.keep(entry(&answers, &format!("/kept/{pages}"), None, 60, 1000));
            pages += 1;
            assert!(pages < 100, "the store never filled");
        }
        let held = answers.bytes();
        assert!(held > BOUND - BOUND / SHARE && held <= BOUND, "{pages} pages hold {held} bytes");
        assert!(store.marks.get().is_none(), "no marks until a full store is asked");
        assert!(!store.asked(None, "/items") && store.asked(None, "/items") && store.asked(None, "/items"));
        assert!(!store.asked(None, "/items?page=2"), "another query is another URL");
        let host = HeaderValue::from_static("a.example");
        assert!(!store.asked(Some(&host), "/items") && store.asked(Some(&host), "/items"), "and so is another host's");
        assert_eq!(store.marks.get().map(|marks| marks.len() * 64), Some(2048));
        // 2,048 marks: a URL is known while no more than 256 are set, whatever was asked for since.
        let mut urls = (0..400).map(|n| format!("/catalog/{n}"));
        while store.marked.load(Ordering::Relaxed) < 256 {
            store.asked(None, &urls.next().expect("the marks were cleared early"));
        }
        assert!(store.asked(None, "/items") && store.asked(None, "/catalog/0"), "known with 256 marks set");
        // The next new URL clears them all, its own with them.
        let clearing = urls.find(|url| !store.asked(None, url)).expect("a new URL");
        assert_eq!(store.marked.load(Ordering::Relaxed), 0);
        assert!(!store.asked(None, &clearing) && store.asked(None, &clearing), "the one that cleared them is new again");
        assert!(!store.asked(None, "/items"), "and so is one asked for before");
        assert_eq!(store.marked.load(Ordering::Relaxed), 2);
    }

    /// The bound holds after every answer kept: the one not read since the hand last passed goes
    /// first, one past its lifetime before one that was read, and the bytes counted are those
    /// still kept.
    #[test]
    fn the_bound_holds_and_an_answer_not_read_goes_first() {
        let size = 1000 + OVERHEAD;
        let answers = Answers::new(size * 3).expect("a bound");
        for at in ["/a", "/b", "/c"] {
            answers.keep(entry(&answers, at, None, 60, 1000));
        }
        assert_eq!(answers.bytes(), size * 3);
        // `/a` and `/c` are read; `/b` is not.
        assert!(answers.find("/a", None, None).is_some() && answers.find("/c", None, None).is_some());
        answers.keep(entry(&answers, "/d", None, 60, 1000));
        assert_eq!(answers.bytes(), size * 3, "one went for the new one");
        assert!(answers.find("/b", None, None).is_none(), "the one not read");
        for at in ["/a", "/c", "/d"] {
            assert!(answers.find(at, None, None).is_some(), "{at}");
        }
        // One past its lifetime is never given, and goes when the hand comes to it: before one
        // that was read since.
        let answers = Answers::new(size * 2).expect("a bound");
        answers.keep(entry(&answers, "/old", None, 0, 1000));
        answers.keep(entry(&answers, "/b", None, 60, 1000));
        assert!(answers.find("/old", None, None).is_none(), "past its lifetime: never given");
        assert!(answers.find("/b", None, None).is_some());
        answers.keep(entry(&answers, "/c", None, 60, 1000));
        assert!(answers.find("/b", None, None).is_some() && answers.find("/c", None, None).is_some());
        assert_eq!(answers.bytes(), size * 2);
    }

    /// A request that may change what `at` shows, as the app's layer meets it.
    fn write<'a>(answers: &'a Answers, at: &str) -> Writing<'a> {
        let req = http::Request::builder().method("POST").uri(at).header("host", "h7.example").body(Body::empty());
        answers.writing(&req.expect("a request"), &crate::Signal::default())
    }

    /// A URL's answer is one copy for each `Host` it was asked with, a new one in the place of the
    /// one it stands for. A write drops every page at its path, and one that did not fail at the
    /// path it redirects to, whatever their queries, and one whose handler read before it.
    #[test]
    fn a_url_has_a_copy_for_each_host_and_a_write_drops_its_path_s() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let (a, b) = (HeaderValue::from_static("a.example"), HeaderValue::from_static("b.example"));
        answers.keep(entry(&answers, "/p", Some("a.example"), 60, 10));
        assert!(answers.find("/p", Some(&a), None).is_some());
        assert!(answers.find("/p", Some(&b), None).is_none() && answers.find("/p", None, None).is_none());
        answers.keep(entry(&answers, "/p", Some("b.example"), 60, 10));
        answers.keep(entry(&answers, "/p", Some("a.example"), 60, 20));
        assert_eq!(answers.bytes(), 30 + OVERHEAD * 2, "the second for a.example took the first's place");
        assert_eq!(answers.find("/p", Some(&a), None).expect("kept").0.body.len(), 20);
        // More hosts than a URL keeps copies for: the oldest not read since it was kept goes, so
        // the one read stays.
        for n in 0..COPIES {
            let host: &'static str = Box::leak(format!("h{n}.example").into_boxed_str());
            answers.keep(entry(&answers, "/p", Some(host), 60, 10));
        }
        assert!(answers.find("/p", Some(&b), None).is_none() && answers.find("/p", Some(&a), None).is_some());
        assert!(answers.find("/p", Some(&HeaderValue::from_static("h0.example")), None).is_none());
        assert_eq!(answers.bytes(), 20 + 10 * (COPIES - 1) + OVERHEAD * COPIES);
        let last = HeaderValue::from_static("h7.example");
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::SEE_OTHER;
        res.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/q?x=1#top"));
        res.headers_mut().insert(header::CONTENT_LOCATION, HeaderValue::from_static("https://H7.example/made/1"));
        answers.keep(entry(&answers, "/q?x=2", None, 60, 10));
        answers.keep(entry(&answers, "/made/1", None, 60, 10));
        answers.keep(entry(&answers, "/other", None, 60, 10));
        // A page whose handler is reading while the write is made.
        let read_before = entry(&answers, "/q", None, 60, 10);
        // A named post: `?do=save` at its page's path.
        write(&answers, "/p?do=save").answered(&res);
        assert!(answers.find("/p", Some(&last), None).is_none(), "the path written, whatever the query");
        assert!(answers.find("/q?x=2", None, None).is_none(), "and the path it redirects to");
        assert!(answers.find("/made/1", None, None).is_none(), "and the one it says it made, named with this host");
        answers.keep(read_before);
        assert!(answers.find("/q", None, None).is_none(), "what was read before the write does not stand");
        assert!(answers.find("/other", None, None).is_some());
        answers.keep(entry(&answers, "/p", Some("h7.example"), 60, 10));
        assert!(answers.find("/p", Some(&last), None).is_some(), "made after the write, it stands");
        assert!(Answers::new(0).is_none(), "no bound, none kept");
    }

    /// A write counts for its path however it ends and whatever it is answered: the handler may
    /// have written before the client left, before it failed or before it refused. The path is
    /// the same page's however it is escaped.
    #[test]
    fn a_write_that_is_dropped_or_fails_late_drops_its_path_s_however_it_is_escaped() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let kept = |at| answers.find(at, None, None).is_some();
        answers.keep(entry(&answers, "/notes/a%7Eb", None, 60, 10));
        answers.keep(entry(&answers, "/other", None, 60, 10));
        drop(write(&answers, "/notes/a~b"));
        assert!(!kept("/notes/a%7Eb"), "dropped before its answer, under another escaping");
        answers.keep(entry(&answers, "/notes/a%7Eb", None, 60, 10));
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
        res.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/other"));
        write(&answers, "/notes/a%7eb").answered(&res);
        assert!(!kept("/notes/a%7Eb"), "a handler that failed, or passed its deadline, may have written");
        assert!(kept("/other"), "and what a failure names is not a place it wrote");
        // A handler that refused the request, waited too long for its body or says it does not
        // do this may have saved first, and so may a middleware around a route with no handler
        // for the method: a status does not say.
        let refusals =
            [StatusCode::CONFLICT, StatusCode::REQUEST_TIMEOUT, StatusCode::METHOD_NOT_ALLOWED, StatusCode::NOT_IMPLEMENTED];
        for status in refusals {
            answers.keep(entry(&answers, "/notes/a%7Eb", None, 60, 10));
            assert!(kept("/notes/a%7Eb"));
            *res.status_mut() = status;
            write(&answers, "/notes/a~b").answered(&res);
            assert!(!kept("/notes/a%7Eb"), "{status}");
            assert!(kept("/other"), "{status}: and the place it names is not one it wrote");
        }
        // An escaped `/` is part of its segment, in either case of its digits.
        assert_eq!(count_of(b"/files/a%2Fb"), count_of(b"/files/a%2fb"));
        assert_ne!(count_of(b"/files/a%2Fb"), count_of(b"/files/a/b"));
    }

    /// The counts of writes are made when the first page is asked for: a write before then finds
    /// none, and what it wrote is there for that page's handler.
    #[test]
    fn the_counts_of_writes_are_made_with_the_first_page_asked_for() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let res = Response::new(Body::empty());
        write(&answers, "/p").answered(&res);
        drop(write(&answers, "/p"));
        // One that began before the counts were made and is answered after.
        let early = write(&answers, "/p");
        assert!(answers.0.written.get().is_none(), "an app that keeps no page holds no counts");
        answers.keep(entry(&answers, "/p", None, 60, 10));
        assert!(answers.0.written.get().is_some_and(|counts| counts.len() == WRITES));
        assert!(answers.find("/p", None, None).is_some());
        early.answered(&res);
        assert!(answers.find("/p", None, None).is_none(), "it counts where the counts now are");
        answers.keep(entry(&answers, "/p", None, 60, 10));
        assert!(answers.find("/p", None, None).is_some());
        write(&answers, "/p").answered(&res);
        assert!(answers.find("/p", None, None).is_none());
    }

    /// Threads that keep, read, grow and write at once leave the bytes counted equal to what the
    /// entries count for, each entry in one slot and one URL's copies, within the bound.
    #[test]
    fn the_bytes_counted_are_the_entries_whatever_threads_did_at_once() {
        const BOUND: usize = 64 << 10;
        let answers = Answers::new(BOUND).expect("a bound");
        std::thread::scope(|scope| {
            for thread in 0..4_usize {
                let answers = &answers;
                scope.spawn(move || {
                    for n in 0..4000_usize {
                        let at = format!("/p{}", (n * 7 + thread * 13) % 97);
                        match n % 4 {
                            0 | 1 => drop(answers.keep(entry(answers, &at, None, 60, 500 + n % 300))),
                            2 => {
                                if let Some((found, _)) = answers.find(&at, None, None) {
                                    #[cfg(feature = "compress")]
                                    found.grew(100);
                                    drop(found);
                                }
                            }
                            _ => answers.count(count_of(at.as_bytes())),
                        }
                    }
                });
            }
        });
        let inner = answers.0.inner.read().unwrap_or_else(PoisonError::into_inner);
        let sizes: Vec<usize> = inner.slots.iter().flatten().map(|entry| entry.size.load(Ordering::Acquire)).collect();
        assert!(!sizes.is_empty() && sizes.iter().all(|&size| size != GONE));
        assert_eq!(answers.bytes(), sizes.iter().sum::<usize>());
        assert_eq!(inner.at.values().map(Vec::len).sum::<usize>(), sizes.len());
        assert!(answers.bytes() <= BOUND, "{}", answers.bytes());
    }

    #[test]
    fn a_write_s_answer_names_a_place_on_this_site_by_its_path_or_with_its_host() {
        let host = HeaderValue::from_static("shop.example:8443");
        let on = |to: &'static str| on_site(to.as_bytes(), Some(&host)).map(|path| std::str::from_utf8(path).expect("a path"));
        assert_eq!(on("/q?x=1#top"), Some("/q"));
        assert_eq!(on("/"), Some("/"));
        assert_eq!(on("https://shop.example:8443/q/r?x"), Some("/q/r"));
        assert_eq!(on("HTTP://SHOP.example:8443"), Some("/"));
        assert_eq!(on("//shop.example:8443/q#top"), Some("/q"));
        assert_eq!(on("https://shop.example:8443?x=1"), Some("/"));
        for elsewhere in ["https://other.example/q", "//other.example/q", "https://shop.example/q", "q", "../q", "", "mailto:a@b"]
        {
            assert_eq!(on(elsewhere), None, "{elsewhere}");
        }
        assert_eq!(on_site(b"https://shop.example:8443/q", None), None, "no host to hold it to");
        assert_eq!(on_site("/caf\u{e9}".as_bytes(), None), Some("/caf\u{e9}".as_bytes()), "a path that is not ASCII");
    }

    /// A copy that no longer stands is in no other's way, and goes when its URL is kept again.
    #[test]
    fn a_copy_that_no_longer_stands_is_not_in_another_s_way() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let (fr, en) = (HeaderValue::from_static("fr"), HeaderValue::from_static("en"));
        // For every language, and past its lifetime.
        answers.keep(entry(&answers, "/p", None, 0, 10));
        let (french, asked) = (entry(&answers, "/p", None, 60, 20), fr.clone());
        answers.keep(move |place| Entry { language: Some(Some(asked)), ..french(place) });
        assert_eq!(answers.find("/p", None, Some(&fr)).expect("the one that stands").0.body.len(), 20);
        assert!(answers.find("/p", None, Some(&en)).is_none());
        assert_eq!(answers.bytes(), 20 + OVERHEAD, "the one past its lifetime went when the URL was kept again");
    }

    #[test]
    fn an_answer_is_kept_only_when_its_vary_is_covered() {
        let vary = |lines: &[&'static str]| {
            let mut headers = HeaderMap::new();
            for line in lines {
                headers.append(header::VARY, HeaderValue::from_static(line));
            }
            varies(&headers)
        };
        assert_eq!(vary(&[]), Some(false));
        assert_eq!(vary(&["corten, accept"]), Some(false));
        assert_eq!(vary(&["Corten, Accept, Accept-Language"]), Some(true));
        assert_eq!(vary(&["corten", "accept-language"]), Some(true));
        for other in [&["*"][..], &["corten, accept, corten-notice"], &["corten", "x-tenant"], &["cookie"]] {
            assert_eq!(vary(other), None, "{other:?}");
        }
    }

    /// The tag's hash of a kept body and its bytes in a coding are made once and counted, while
    /// the response still carries the kept bytes: a body put in their place is hashed and coded
    /// for itself, and nothing is counted for an answer that is no longer kept.
    #[test]
    fn a_kept_answer_s_hash_and_coded_bytes_are_made_once() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let kept = answers.keep(entry(&answers, "/p", None, 60, 2000));
        let mut extensions = http::Extensions::new();
        extensions.insert(Kept(kept.clone()));
        let key = std::hash::RandomState::new();
        let hash = |body: &Bytes| Kept::hashed(&extensions, body, &key).finish();
        let copy = Bytes::copy_from_slice(&kept.body);
        assert!(kept.hashed.get().is_none());
        assert_eq!(hash(&copy), hash(&kept.body), "the same bytes, the same hash, kept or not");
        assert!(kept.hashed.get().is_some(), "kept for the next tag");
        assert_eq!(hash(&kept.body), hash(&copy));
        let other = Bytes::from_static(b"another body");
        assert_ne!(hash(&other), hash(&kept.body), "a body a middleware put in its place");

        #[cfg(feature = "compress")]
        {
            let made = std::cell::Cell::new(0);
            let encode = || {
                made.set(made.get() + 1);
                Bytes::from_static(b"coded")
            };
            let before = answers.bytes();
            let gzip = accepts("gzip");
            for _ in 0..3 {
                assert_eq!(Kept::coded(&extensions, &kept.body, gzip, Coding::Gzip, encode), ("coded".into(), Coding::Gzip));
            }
            assert_eq!((made.get(), answers.bytes()), (1, before + 5 + FORM), "made once, and counted");
            Kept::coded(&extensions, &other, gzip, Coding::Gzip, encode);
            Kept::coded(&http::Extensions::new(), &kept.body, gzip, Coding::Gzip, encode);
            assert_eq!((made.get(), answers.bytes()), (3, before + 5 + FORM), "not the kept answer's");
            // Another answer takes its place.
            answers.keep(entry(&answers, "/p", None, 60, 10));
            assert_eq!(answers.bytes(), 10 + OVERHEAD);
            Kept::coded(&extensions, &kept.body, accepts("br"), Coding::Brotli, encode);
            assert_eq!((made.get(), answers.bytes()), (4, 10 + OVERHEAD), "no longer kept: nothing is counted for it");
        }
    }

    /// What a request with this `Accept-Encoding` takes.
    #[cfg(feature = "compress")]
    fn accepts(value: &'static str) -> Accepts {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static(value));
        crate::compress::negotiate(&headers)
    }

    /// A kept answer's brotli at `Level::Kept` is made once after its second answer to a client
    /// that takes brotli, on another thread, and counted: from then on a client that ranks brotli
    /// as high as any coding gets it with no request compressing anything, and one that prefers
    /// another coding, or does not take brotli, gets the form made for its coding. Answers to
    /// clients that do not take brotli do not start it.
    #[cfg(feature = "compress")]
    #[test]
    fn a_kept_answer_s_brotli_is_made_after_its_second_answer_and_given_from_then_on() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let page: String =
            (0..120u32).map(|n| format!(r#"<li><a href="/items/{n}">Item {n}</a> {}</li>"#, n * 7919 % 1000)).collect();
        let page = Bytes::from(page);
        let kept = answers.keep(|place| Entry { body: page.clone(), ..entry(&answers, "/p", None, 60, page.len())(place) });
        let mut extensions = http::Extensions::new();
        extensions.insert(Kept(kept.clone()));
        let fast = |coding| Bytes::from(crate::compress::encode(coding, &kept.body, Level::Fast));
        let browser = accepts("gzip, deflate, br, zstd");
        // Answers to clients that take no brotli: what they asked for, and nothing more.
        for _ in 0..3 {
            assert_eq!(
                Kept::coded(&extensions, &kept.body, accepts("zstd, gzip"), Coding::Zstd, || fast(Coding::Zstd)).1,
                Coding::Zstd
            );
        }
        let zstd = kept.coded.now[Coding::Zstd as usize].get().expect("made once").clone();
        let before = answers.bytes();
        assert!(!kept.coded.started.load(Ordering::Acquire), "no client that takes brotli has asked");
        // The first answer to a browser is zstd 1, as it was made, and starts nothing.
        let first = Kept::coded(&extensions, &kept.body, browser, Coding::Zstd, || unreachable!("made already"));
        assert_eq!(first, (zstd.clone(), Coding::Zstd));
        assert!(!kept.coded.started.load(Ordering::Acquire), "made for one request, never compressed twice");
        // The second is too, and brotli is made after it.
        let second = Kept::coded(&extensions, &kept.body, browser, Coding::Zstd, || unreachable!("made already"));
        assert_eq!(second, (zstd.clone(), Coding::Zstd), "the request does not wait for brotli");
        let started = Instant::now();
        while answers.bytes() == before {
            assert!(started.elapsed() < std::time::Duration::from_secs(10), "brotli was not made");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let brotli = kept.coded.brotli.get().expect("made").clone();
        assert_eq!(brotli, crate::compress::encode(Coding::Brotli, &kept.body, Level::Kept));
        assert_eq!(answers.bytes(), before + brotli.len() + FORM, "and counted");
        assert!(brotli.len() < zstd.len() && brotli.len() < fast(Coding::Brotli).len(), "{} {}", brotli.len(), zstd.len());
        // From then on: brotli to a client that ranks it as high as any, made by no request.
        for (asked, now) in [
            ("gzip, deflate, br, zstd", Coding::Zstd),
            ("br", Coding::Brotli),
            ("gzip;q=0.8, br;q=0.8, zstd;q=0.5", Coding::Brotli),
        ] {
            let given = Kept::coded(&extensions, &kept.body, accepts(asked), now, || unreachable!("{asked}: made already"));
            assert_eq!(given, (brotli.clone(), Coding::Brotli), "{asked}");
            assert_eq!(given.0.as_ptr(), brotli.as_ptr(), "{asked}: the bytes made once");
        }
        // A client that prefers zstd gets zstd; one that takes no brotli, its own coding.
        let given = Kept::coded(&extensions, &kept.body, accepts("zstd, br;q=0.5"), Coding::Zstd, || unreachable!());
        assert_eq!(given, (zstd, Coding::Zstd));
        let given = Kept::coded(&extensions, &kept.body, accepts("gzip"), Coding::Gzip, || fast(Coding::Gzip));
        assert_eq!(given.1, Coding::Gzip);
        assert_eq!(answers.bytes(), before + brotli.len() + given.0.len() + FORM * 2);
    }

    /// The bound holds for what is made after a page is kept too: a coded form that takes the
    /// store past it makes room as a new page does, and not by dropping the page it was made for.
    #[cfg(feature = "compress")]
    #[test]
    fn a_coded_form_that_passes_the_bound_makes_room() {
        let size = 1000 + OVERHEAD;
        let answers = Answers::new(size * 2 + 100).expect("a bound");
        let first = answers.keep(entry(&answers, "/a", None, 60, 1000));
        let second = answers.keep(entry(&answers, "/b", None, 60, 1000));
        assert_eq!(answers.bytes(), size * 2);
        let mut extensions = http::Extensions::new();
        extensions.insert(Kept(second.clone()));
        let (coded, _) = Kept::coded(&extensions, &second.body, accepts("zstd"), Coding::Zstd, || Bytes::from(vec![b'z'; 400]));
        assert_eq!(coded.len(), 400);
        assert_eq!(answers.bytes(), size + 400 + FORM, "the other page went, and the bound holds");
        assert!(answers.find("/a", None, None).is_none() && answers.find("/b", None, None).is_some());
        assert_eq!(first.size.load(Ordering::Acquire), GONE);
    }

    /// Holds the thread that compresses held values at a job of its own until the returned
    /// sender is sent to or dropped, so what is queued after it waits.
    #[cfg(feature = "compress")]
    fn hold_the_compression_thread() -> std::sync::mpsc::Sender<()> {
        let (release, held) = std::sync::mpsc::channel::<()>();
        let (running, started) = std::sync::mpsc::channel();
        let job = Box::new(move || {
            running.send(()).ok();
            held.recv().ok();
        });
        assert!(crate::compress::later(job), "the thread took the job");
        started.recv_timeout(std::time::Duration::from_secs(10)).expect("the thread reached the job");
        release
    }

    /// Hears once every job queued on that thread before it is done.
    #[cfg(feature = "compress")]
    fn queued_before_done() -> std::sync::mpsc::Receiver<()> {
        let (done, heard) = std::sync::mpsc::channel();
        let job = Box::new(move || {
            done.send(()).ok();
        });
        assert!(crate::compress::later(job), "the thread took the job");
        heard
    }

    /// A page's body that brotli makes much smaller, numbered so two are not the same.
    #[cfg(feature = "compress")]
    fn a_page(n: u32) -> Bytes {
        (0..120u32)
            .map(|i| format!(r#"<li><a href="/items/{i}">Item {i}</a> {}</li>"#, (i + n) * 7919 % 1000))
            .collect::<String>()
            .into()
    }

    /// A page's brotli queued for the compression thread is not made, counted or given once the
    /// page no longer stands (a write to its path, its lifetime over, the store gone) when the
    /// thread comes to it, though nothing looked the page up since: it takes no room from a page
    /// that stands, and the page kept in its place is made and given its own.
    #[cfg(feature = "compress")]
    #[test]
    fn a_kept_answer_s_brotli_is_not_made_once_it_no_longer_stands() {
        let bound = 64 << 10;
        for ended in ["written", "past its lifetime", "the store gone"] {
            let answers = Answers::new(bound).expect("a bound");
            let body = a_page(0);
            // One past its lifetime was made longer ago than that.
            let (made, lifetime) = match ended {
                "past its lifetime" => (Instant::now().checked_sub(std::time::Duration::from_secs(2)).expect("a time"), 1),
                _ => (Instant::now(), 60),
            };
            let stale = answers.keep(|place| Entry {
                body: body.clone(),
                made,
                ..entry(&answers, "/a", None, lifetime, body.len())(place)
            });
            let mut extensions = http::Extensions::new();
            extensions.insert(Kept(stale.clone()));
            let release = hold_the_compression_thread();
            for _ in 0..2 {
                Kept::coded(&extensions, &stale.body, accepts("br"), Coding::Brotli, || Bytes::from_static(b"fast"));
            }
            assert!(stale.coded.started.load(Ordering::Acquire), "{ended}: queued");
            let done = queued_before_done();
            // A page that stands, with less room left beside it than the brotli would take.
            let other = bound - answers.bytes() - OVERHEAD - 16;
            answers.keep(entry(&answers, "/c", None, 60, other));
            if ended == "written" {
                answers.count(count_of(b"/a"));
            }
            assert_eq!(stale.stands(&answers.0, Instant::now()), ended == "the store gone", "{ended}");
            let before = answers.bytes();
            let store = Arc::downgrade(&answers.0);
            if ended == "the store gone" {
                drop(answers);
                drop(release);
                done.recv_timeout(std::time::Duration::from_secs(10)).expect("the thread is done");
                assert!(store.upgrade().is_none());
                assert!(stale.coded.brotli.get().is_none(), "{ended}: not made for a store no one has");
                continue;
            }
            drop(release);
            done.recv_timeout(std::time::Duration::from_secs(10)).expect("the thread is done");
            assert!(stale.coded.brotli.get().is_none(), "{ended}: not made");
            assert_eq!(answers.bytes(), before, "{ended}: nor counted");
            assert!(answers.find("/c", None, None).is_some(), "{ended}: the page that stands is kept");
            // The page kept in its place, of other bytes, is made and given its own brotli.
            let body = a_page(1);
            let fresh = answers.keep(|place| Entry { body: body.clone(), ..entry(&answers, "/a", None, 60, body.len())(place) });
            assert_eq!(answers.find("/a", None, None).expect("the new page").0.body, body, "{ended}");
            let mut extensions = http::Extensions::new();
            extensions.insert(Kept(fresh.clone()));
            for _ in 0..2 {
                Kept::coded(&extensions, &fresh.body, accepts("br"), Coding::Brotli, || Bytes::from_static(b"fast"));
            }
            queued_before_done().recv_timeout(std::time::Duration::from_secs(10)).expect("the thread is done");
            let brotli = fresh.coded.brotli.get().expect("made").clone();
            assert_eq!(brotli, crate::compress::encode(Coding::Brotli, &body, Level::Kept), "{ended}");
            assert_eq!(Kept::coded(&extensions, &fresh.body, accepts("br"), Coding::Brotli, || unreachable!()).0, brotli);
        }
    }
}
