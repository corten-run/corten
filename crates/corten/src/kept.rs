//! The pages the app keeps to send again.
//!
//! A page whose route says its answer is the same for everyone ([`crate::Public`]) is one every
//! shared cache may keep for the lifetime it names. The app is the first of them: it keeps the
//! whole document its handler made for a `GET` that tells nothing about who is asking, and for
//! that lifetime (`s-maxage` where the answer has one, else `max-age`, RFC 9111 section 4.2.1)
//! gives it to the next such request in the handler's place, with an `Age`.
//!
//! It stands where the handler does, after the app's middleware, so every stage still runs for
//! every request: a middleware sees the `200` with the whole body, the security headers and
//! `Cache-Control` are written as for any answer, and a request that names the page's tag is
//! answered `304`. What a kept page saves is the handler, the render, the hash of its body for the
//! tag and its compression: the hash and each coding's bytes are made once and stay with it
//! ([`Kept`], which [`crate::cache::tag`] and `compress::finish` read).
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
//! page's path) and however the path is escaped, unless its answer says it was refused (a
//! `4xx`): one that failed later, passed its deadline or lost its client may have written
//! first, and work that outlives its request ([`crate::Signal::finish`]) counts again when it
//! ends. A write that went through also drops what is kept at the place on this site its answer
//! names (`Location`, `Content-Location`; RFC 9111 section 4.4). A page whose handler was
//! reading while a write went through is not kept. Nothing else drops a page before its lifetime
//! ends: the lifetime is how stale the app said the page may be. Off under `corten dev`. The
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
use std::hash::{BuildHasher, DefaultHasher, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
#[cfg(feature = "compress")]
use std::sync::Weak;
use std::sync::{Arc, OnceLock, PoisonError, RwLock};
use std::time::Instant;

use bytes::Bytes;
use http::{header, HeaderMap, HeaderValue, StatusCode};

use crate::body::Body;
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

/// An entry's size once it is no longer kept: nothing made for it counts from then on.
const GONE: usize = usize::MAX;

/// The counts of writes, one for the paths whose hash names it: enough of them (256 KiB, made
/// when the first page is asked for) that an app's writes seldom share a count with a kept page.
const WRITES: usize = 1 << 16;

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

    /// No write to the path since.
    fn stands(self, store: &Store) -> bool {
        store.written.get().is_none_or(|counts| counts[self.count].load(Ordering::Acquire) == self.was)
    }
}

/// A request that may change what its path shows (a method that is not safe), from before its
/// handler can start until it is answered or dropped: its path's count goes up either way, unless
/// the answer says the request was refused.
pub(crate) struct Writing<'a> {
    answers: &'a Answers,
    count: usize,
    host: Option<HeaderValue>,
    answered: bool,
}

impl Writing<'_> {
    /// The write was answered: counts it for its path and for the places on this site its answer
    /// names (RFC 9111 section 4.4), so nothing kept there stands. Not for a `4xx`, which says
    /// the request was refused for what it asked, nor for a `501`, which says no handler has
    /// its method. Any other `5xx` counts for its path: the handler may have written before it
    /// failed or passed its deadline (work it left under `Signal::finish` counts again when it
    /// ends).
    pub(crate) fn answered(mut self, res: &Response) {
        self.answered = true;
        if res.status().is_client_error() || res.status() == StatusCode::NOT_IMPLEMENTED {
            return;
        }
        self.answers.count(self.count);
        if res.status().is_server_error() {
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
    /// The body in each coding, once a request asked for it.
    #[cfg(feature = "compress")]
    coded: [OnceLock<Bytes>; 3],
    used: AtomicBool,
    /// What it counts for in the store's bytes, or [`GONE`].
    size: AtomicUsize,
}

/// On a response whose body is a kept answer's: the stages after the handler find the body's
/// hash and its compressed forms here while the body is still those bytes, as a held value's are
/// found (`compress::Stored`). A middleware that replaced the body keeps the extension, not the
/// bytes it stood for.
#[derive(Clone)]
pub(crate) struct Kept(Arc<Entry>);

impl Kept {
    fn of<'a>(extensions: &'a http::Extensions, body: &Bytes) -> Option<&'a Entry> {
        let Kept(entry) = extensions.get::<Kept>()?;
        (entry.body.as_ptr() == body.as_ptr() && entry.body.len() == body.len()).then_some(&**entry)
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

    /// `body` in `coding`, which `encode` makes: kept with the answer `body` is from, so only the
    /// first request for a coding compresses it.
    #[cfg(feature = "compress")]
    pub(crate) fn coded(
        extensions: &http::Extensions,
        body: &Bytes,
        coding: crate::compress::Coding,
        encode: impl FnOnce() -> Bytes,
    ) -> Bytes {
        let Some(entry) = Kept::of(extensions, body) else { return encode() };
        let slot = &entry.coded[coding as usize];
        if let Some(coded) = slot.get() {
            return coded.clone();
        }
        // Made outside the cell: two first requests each compress it, and neither waits.
        // A copy of its own length: an encoder's buffer is sized for the worst case, and the
        // bytes made from it hold all of that for as long as they are kept.
        let coded = Bytes::copy_from_slice(&encode());
        if slot.set(coded.clone()).is_ok() {
            entry.grew(coded.len());
        }
        coded
    }
}

impl Entry {
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
            Answers(Arc::new(Store { bound, bytes: AtomicUsize::new(0), written: OnceLock::new(), inner: RwLock::default() }))
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
        let headers = req.headers();
        // First, since it is what most requests a page is not kept for carry.
        if crate::cache::Credentials::read(headers).personal(|| headers.contains_key(header::AUTHORIZATION)) {
            return None;
        }
        // The document a browser loads: not what the runtime asks for (`corten`, whatever it
        // says), not a data client's JSON.
        if headers.contains_key(crate::page::MODE_HEADER) || Mode::asked(headers) != (Mode::Document, false) {
            return None;
        }
        // Nothing the handler could read beside the URL: a notice the page sends back when it is
        // read again, where a stream stopped, a body.
        const READ: [header::HeaderName; 4] = [
            crate::page::NOTICE_HEADER,
            header::HeaderName::from_static("last-event-id"),
            header::CONTENT_LENGTH,
            header::TRANSFER_ENCODING,
        ];
        if READ.iter().any(|name| headers.contains_key(name)) {
            return None;
        }
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
        Some(Asked { answers, at, host: headers.get(header::HOST), language: headers.get(header::ACCEPT_LANGUAGE) })
    }

    /// The kept answer for this request, as its handler gave it, with its age.
    pub(crate) fn find(&self) -> Option<Response> {
        let (entry, age) = self.answers.find(self.at, self.host, self.language)?;
        let mut res = Response::new(Body::from(entry.body.clone()));
        let mut head = entry.head.clone();
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
    /// meanwhile is seen.
    pub(crate) fn missed(&self, req: &Request) -> Missed {
        Missed {
            asked: Instant::now(),
            written: Written::of(&self.answers.0, self.at),
            signal: req.extensions().get::<crate::Signal>().cloned(),
            nonce: req.extensions().get::<crate::security::NonceSlot>().cloned(),
            at: self.at.into(),
            // Copies of their own: a request's header values are slices of the connection's read
            // buffer, which a kept one would hold whole.
            host: self.host.and_then(|host| HeaderValue::from_bytes(host.as_bytes()).ok()),
            language: self.language.and_then(|language| HeaderValue::from_bytes(language.as_bytes()).ok()),
        }
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
    /// one it stands for. A write that was not refused drops every page at its path and at the
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
        *res.status_mut() = StatusCode::NOT_FOUND;
        write(&answers, "/p").answered(&res);
        assert!(answers.find("/p", Some(&last), None).is_some(), "a write that was refused changed nothing");
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

    /// A write counts for its path however it ends, unless its answer says it was refused: the
    /// handler may have written before the client left or before it failed. The path is the same
    /// page's however it is escaped.
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
        // A method no handler has ran nothing.
        answers.keep(entry(&answers, "/notes/a%7Eb", None, 60, 10));
        *res.status_mut() = StatusCode::NOT_IMPLEMENTED;
        write(&answers, "/notes/a~b").answered(&res);
        assert!(kept("/notes/a%7Eb"));
        // An escaped `/` is part of its segment, in either case of its digits.
        assert_eq!(count_of(b"/files/a%2Fb"), count_of(b"/files/a%2fb"));
        assert_ne!(count_of(b"/files/a%2Fb"), count_of(b"/files/a/b"));
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
            use crate::compress::Coding;
            let made = std::cell::Cell::new(0);
            let encode = || {
                made.set(made.get() + 1);
                Bytes::from_static(b"coded")
            };
            let before = answers.bytes();
            for _ in 0..3 {
                assert_eq!(Kept::coded(&extensions, &kept.body, Coding::Gzip, encode), "coded");
            }
            assert_eq!((made.get(), answers.bytes()), (1, before + 5), "made once, and counted");
            Kept::coded(&extensions, &other, Coding::Gzip, encode);
            Kept::coded(&http::Extensions::new(), &kept.body, Coding::Gzip, encode);
            assert_eq!((made.get(), answers.bytes()), (3, before + 5), "not the kept answer's");
            // Another answer takes its place.
            answers.keep(entry(&answers, "/p", None, 60, 10));
            assert_eq!(answers.bytes(), 10 + OVERHEAD);
            Kept::coded(&extensions, &kept.body, Coding::Brotli, encode);
            assert_eq!((made.get(), answers.bytes()), (4, 10 + OVERHEAD), "no longer kept: nothing is counted for it");
        }
    }

    /// The bound holds for what is made after a page is kept too: a coded form that takes the
    /// store past it makes room as a new page does, and not by dropping the page it was made for.
    #[cfg(feature = "compress")]
    #[test]
    fn a_coded_form_that_passes_the_bound_makes_room() {
        use crate::compress::Coding;
        let size = 1000 + OVERHEAD;
        let answers = Answers::new(size * 2 + 100).expect("a bound");
        let first = answers.keep(entry(&answers, "/a", None, 60, 1000));
        let second = answers.keep(entry(&answers, "/b", None, 60, 1000));
        assert_eq!(answers.bytes(), size * 2);
        let mut extensions = http::Extensions::new();
        extensions.insert(Kept(second.clone()));
        let coded = Kept::coded(&extensions, &second.body, Coding::Zstd, || Bytes::from(vec![b'z'; 400]));
        assert_eq!(coded.len(), 400);
        assert_eq!(answers.bytes(), size + 400, "the other page went, and the bound holds");
        assert!(answers.find("/a", None, None).is_none() && answers.find("/b", None, None).is_some());
        assert_eq!(first.size.load(Ordering::Acquire), GONE);
    }
}
