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
//! that cannot tell who is asking ([`crate::answer::Anonymous`]). The request must show nothing
//! else the page could differ by: no cookie but the time zone's (a `Public` page is written in
//! UTC), no `Authorization`, no caller read by a middleware, no `corten` header, JSON not asked
//! for first, no notice sent back, no body, and the URL the router matched (a middleware that
//! changed it since leaves the request to the handler). The key is the `Host`, the path and
//! query, and `Accept-Language` when the page's `Vary` names it: a page for `/items?page=2` is
//! not the one for `/items`, and a write to one does not drop the other. The headers are compared
//! as they were sent, so `fr` and `fr-FR` each have a copy. An answer is kept only when it is a `200`
//! of a known size with a lifetime, sets no cookie, drew no nonce and no value made for this
//! request alone, and varies on nothing but what the key covers.
//!
//! A successful write to a URL, or one that redirects to it, drops what is kept for it (RFC 9111
//! section 4.4). Nothing else does before the lifetime ends: the lifetime is how stale the app
//! said the page may be. Off under `corten dev`. The bound is [`crate::App::kept_answers`].

use std::collections::HashMap;
use std::hash::{BuildHasher, DefaultHasher, Hasher};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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

/// What an entry counts for beside its headers and bytes: itself and its places in the maps.
const OVERHEAD: usize = 256;

/// An entry's size once it is no longer kept: nothing made for it counts from then on.
const GONE: usize = usize::MAX;

/// The app's kept answers, at most `bound` bytes of them.
pub(crate) struct Answers {
    bound: usize,
    /// The bytes kept, shared with each entry, which adds what is made for it later.
    bytes: Arc<AtomicUsize>,
    inner: RwLock<Inner>,
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
    slot: usize,
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
    /// What it counts for in `bytes`, or [`GONE`].
    size: AtomicUsize,
    bytes: Arc<AtomicUsize>,
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
        let coded = encode();
        if slot.set(coded.clone()).is_ok() {
            entry.grew(coded.len());
        }
        coded
    }
}

impl Entry {
    /// Counts `more` bytes made for it, unless it is no longer kept.
    #[cfg(feature = "compress")]
    fn grew(&self, more: usize) {
        // Added first and taken back if it is gone, so the total never falls below what the
        // entries count for.
        self.bytes.fetch_add(more, Ordering::AcqRel);
        let mut now = self.size.load(Ordering::Acquire);
        loop {
            if now == GONE {
                self.bytes.fetch_sub(more, Ordering::AcqRel);
                return;
            }
            match self.size.compare_exchange_weak(now, now + more, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return,
                Err(actual) => now = actual,
            }
        }
    }

    /// Its age in seconds, which its lifetime is counted in.
    fn age(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.made).as_secs()
    }

    fn fresh(&self, now: Instant) -> bool {
        self.age(now) < self.lifetime
    }

    fn is_for(&self, host: Option<&HeaderValue>, language: Option<&HeaderValue>) -> bool {
        self.host.as_ref() == host && self.language.as_ref().is_none_or(|kept| kept.as_ref() == language)
    }
}

impl Inner {
    /// Takes `entry` out of its slot and its URL's copies.
    fn drop_entry(&mut self, entry: &Arc<Entry>) {
        if self.slots.get(entry.slot).and_then(Option::as_ref).is_some_and(|held| Arc::ptr_eq(held, entry)) {
            self.slots[entry.slot] = None;
            self.free.push(entry.slot);
        }
        if let Some(copies) = self.at.get_mut(&entry.at) {
            copies.retain(|copy| !Arc::ptr_eq(copy, entry));
            if copies.is_empty() {
                self.at.remove(&entry.at);
            }
        }
        let size = entry.size.swap(GONE, Ordering::AcqRel);
        if size != GONE {
            entry.bytes.fetch_sub(size, Ordering::AcqRel);
        }
    }
}

impl Answers {
    /// Room for `bound` bytes of answers; none for a bound of 0.
    pub(crate) fn new(bound: usize) -> Option<Self> {
        (bound > 0).then(|| Answers { bound, bytes: Arc::default(), inner: RwLock::default() })
    }

    /// The bytes kept now.
    #[cfg(test)]
    pub(crate) fn bytes(&self) -> usize {
        self.bytes.load(Ordering::Acquire)
    }

    /// The answer kept for a request, while its lifetime lasts, with its age in seconds.
    fn find(&self, at: &str, host: Option<&HeaderValue>, language: Option<&HeaderValue>) -> Option<(Arc<Entry>, u64)> {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        let entry = inner.at.get(at)?.iter().find(|entry| entry.is_for(host, language))?;
        let age = entry.age(Instant::now());
        if age >= entry.lifetime {
            return None;
        }
        // Written only when it changes, so a page many requests read does not pass its line
        // between their cores.
        if !entry.used.load(Ordering::Relaxed) {
            entry.used.store(true, Ordering::Relaxed);
        }
        Some((entry.clone(), age))
    }

    /// Keeps `entry`, in the place of the copy it stands for, and makes room for it.
    fn keep(&self, make: impl FnOnce(usize, Arc<AtomicUsize>) -> Entry) -> Arc<Entry> {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        let slot = inner.free.pop().unwrap_or(inner.slots.len());
        let entry = Arc::new(make(slot, self.bytes.clone()));
        let copies = inner.at.get(&entry.at).map(Vec::as_slice).unwrap_or_default();
        // The copy this one stands for: asked the same way. With none, the oldest of a full set.
        let replaced = copies
            .iter()
            .find(|copy| copy.host == entry.host && copy.language == entry.language)
            .or_else(|| copies.first().filter(|_| copies.len() >= COPIES))
            .cloned();
        if let Some(replaced) = replaced {
            inner.drop_entry(&replaced);
        }
        if slot == inner.slots.len() {
            inner.slots.push(None);
        }
        inner.slots[slot] = Some(entry.clone());
        inner.at.entry(entry.at.clone()).or_default().push(entry.clone());
        self.bytes.fetch_add(entry.size.load(Ordering::Acquire), Ordering::AcqRel);
        self.make_room(&mut inner, &entry);
        entry
    }

    /// Drops entries until the bound holds: one past its lifetime, or not used since the hand
    /// last passed it, as the hand comes to it. Never `kept`, the one just made.
    fn make_room(&self, inner: &mut Inner, kept: &Arc<Entry>) {
        let now = Instant::now();
        // Twice around: the first pass clears every mark, so the second finds one to drop.
        let mut steps = inner.slots.len() * 2;
        while self.bytes.load(Ordering::Acquire) > self.bound && steps > 0 {
            steps -= 1;
            inner.hand = (inner.hand + 1) % inner.slots.len();
            let Some(entry) = inner.slots[inner.hand].clone() else { continue };
            if Arc::ptr_eq(&entry, kept) {
                continue;
            }
            if entry.fresh(now) && entry.used.swap(false, Ordering::Relaxed) {
                continue;
            }
            inner.drop_entry(&entry);
        }
    }

    /// Drops what is kept for `at` (a path and query), every copy: a write changed it.
    pub(crate) fn forget(&self, at: &str) {
        if !self.inner.read().unwrap_or_else(PoisonError::into_inner).at.contains_key(at) {
            return;
        }
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        for entry in inner.at.get(at).cloned().unwrap_or_default() {
            inner.drop_entry(&entry);
        }
    }

    /// After an answer to a request that may have changed what a URL shows (an unsafe method
    /// that did not fail): drops what is kept for the request's URL and for a place on this site
    /// its answer redirects to (RFC 9111 section 4.4).
    pub(crate) fn wrote(&self, at: &str, res: &Response) {
        if res.status().is_client_error() || res.status().is_server_error() {
            return;
        }
        self.forget(at);
        for name in [header::LOCATION, crate::page::LOCATION_HEADER] {
            let to = res.headers().get(name).and_then(|to| to.to_str().ok());
            // A path on this site: another site's page is not kept here.
            if let Some(to) = to.filter(|to| to.starts_with('/') && !to.starts_with("//")) {
                self.forget(to.split('#').next().unwrap_or(to));
            }
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
        if crate::cache::Credentials::read(headers).personal(|| headers.contains_key(header::AUTHORIZATION)) {
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

    /// What keeping the handler's answer needs of the request, once no kept one stood for it.
    pub(crate) fn missed(&self, req: &Request) -> Missed {
        Missed {
            shared: req.extensions().get::<crate::Signal>().and_then(crate::Signal::shared).cloned(),
            signal: req.extensions().get::<crate::Signal>().cloned(),
            nonce: req.extensions().get::<crate::security::NonceSlot>().cloned(),
            at: self.at.into(),
            host: self.host.cloned(),
            language: self.language.cloned(),
        }
    }
}

/// A request no kept answer stood for, whose handler's answer is kept if it may be.
pub(crate) struct Missed {
    shared: Option<Arc<crate::page::Shared>>,
    signal: Option<crate::Signal>,
    nonce: Option<crate::security::NonceSlot>,
    at: Box<str>,
    host: Option<HeaderValue>,
    language: Option<HeaderValue>,
}

impl Missed {
    /// `res`, kept when it is the same for everyone and for how long: see the module.
    pub(crate) async fn keep(self, res: Response) -> Response {
        let Some(answers) = self.shared.as_ref().and_then(|shared| shared.kept.as_ref()) else { return res };
        let Some((cache, lifetime)) = crate::cache::Typed::shared(&res) else { return res };
        // Whether the page varies on `Accept-Language`, or on something the key does not cover.
        let Some(language) = varies(res.headers()) else { return res };
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
        {
            return res;
        }
        let Some(length) = http_body::Body::size_hint(res.body()).exact() else { return res };
        let head: usize = res.headers().iter().map(|(name, value)| name.as_str().len() + value.len() + 32).sum();
        let size = self.at.len() + head + OVERHEAD + length as usize;
        if length == 0 || size > answers.bound / SHARE {
            return res;
        }
        let (mut parts, body) = res.into_parts();
        // Exact size: one held `Bytes`, which comes back as it is.
        let Ok(body) = crate::body::to_bytes(body, usize::MAX).await else {
            return Response::from_parts(parts, Body::empty());
        };
        let Missed { at, host, language: asked, .. } = self;
        let entry = answers.keep(|slot, bytes| Entry {
            at,
            slot,
            host,
            language: language.then_some(asked),
            made: Instant::now(),
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
            bytes,
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

    fn entry(at: &str, host: Option<&'static str>, lifetime: u64, body: usize) -> impl FnOnce(usize, Arc<AtomicUsize>) -> Entry {
        let at: Box<str> = at.into();
        move |slot, bytes| Entry {
            at,
            slot,
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
            bytes,
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
            answers.keep(entry(at, None, 60, 1000));
        }
        assert_eq!(answers.bytes(), size * 3);
        // `/a` and `/c` are read; `/b` is not.
        assert!(answers.find("/a", None, None).is_some() && answers.find("/c", None, None).is_some());
        answers.keep(entry("/d", None, 60, 1000));
        assert_eq!(answers.bytes(), size * 3, "one went for the new one");
        assert!(answers.find("/b", None, None).is_none(), "the one not read");
        for at in ["/a", "/c", "/d"] {
            assert!(answers.find(at, None, None).is_some(), "{at}");
        }
        // One past its lifetime is never given, and goes when the hand comes to it: before one
        // that was read since.
        let answers = Answers::new(size * 2).expect("a bound");
        answers.keep(entry("/old", None, 0, 1000));
        answers.keep(entry("/b", None, 60, 1000));
        assert!(answers.find("/old", None, None).is_none(), "past its lifetime: never given");
        assert!(answers.find("/b", None, None).is_some());
        answers.keep(entry("/c", None, 60, 1000));
        assert!(answers.find("/b", None, None).is_some() && answers.find("/c", None, None).is_some());
        assert_eq!(answers.bytes(), size * 2);
    }

    /// A URL's answer is one copy for each `Host` it was asked with, a new one in the place of the
    /// one it stands for, and a write drops them all.
    #[test]
    fn a_url_has_a_copy_for_each_host_and_a_write_drops_them() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let (a, b) = (HeaderValue::from_static("a.example"), HeaderValue::from_static("b.example"));
        answers.keep(entry("/p", Some("a.example"), 60, 10));
        assert!(answers.find("/p", Some(&a), None).is_some());
        assert!(answers.find("/p", Some(&b), None).is_none() && answers.find("/p", None, None).is_none());
        answers.keep(entry("/p", Some("b.example"), 60, 10));
        answers.keep(entry("/p", Some("a.example"), 60, 20));
        assert_eq!(answers.bytes(), 30 + OVERHEAD * 2, "the second for a.example took the first's place");
        assert_eq!(answers.find("/p", Some(&a), None).expect("kept").0.body.len(), 20);
        // More hosts than a URL keeps copies for: the oldest goes.
        for n in 0..COPIES {
            let host: &'static str = Box::leak(format!("h{n}.example").into_boxed_str());
            answers.keep(entry("/p", Some(host), 60, 10));
        }
        assert!(answers.find("/p", Some(&b), None).is_none() && answers.find("/p", Some(&a), None).is_none());
        assert_eq!(answers.bytes(), (10 + OVERHEAD) * COPIES);
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::NOT_FOUND;
        answers.wrote("/p", &res);
        assert_eq!(answers.bytes(), (10 + OVERHEAD) * COPIES, "a write that failed changed nothing");
        *res.status_mut() = StatusCode::SEE_OTHER;
        res.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/q?x=1#top"));
        answers.keep(entry("/q?x=1", None, 60, 10));
        answers.keep(entry("/other", None, 60, 10));
        answers.wrote("/p", &res);
        assert_eq!(answers.bytes(), 10 + OVERHEAD, "the URL written and the one it redirects to");
        assert!(answers.find("/other", None, None).is_some());
        assert!(Answers::new(0).is_none(), "no bound, none kept");
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
        let kept = answers.keep(entry("/p", None, 60, 2000));
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
            answers.forget("/p");
            assert_eq!(answers.bytes(), 0);
            Kept::coded(&extensions, &kept.body, Coding::Brotli, encode);
            assert_eq!((made.get(), answers.bytes()), (4, 0), "no longer kept: nothing is counted for it");
        }
    }
}
