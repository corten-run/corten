//! HTTP caching of what the app renders.
//!
//! Static files and the runtime are content-addressed and cached forever ([`crate::assets`]).
//! Every other response [`crate::App`] serves that does not say otherwise gets
//! `Cache-Control: private, no-cache`: the browser may keep it but asks the server before reusing
//! it, and no shared cache (a CDN, a proxy) stores it, since a page may carry the signed-in
//! user's data.
//!
//! A route whose answer is the same for everyone says so in its type, [`crate::Public`], whose
//! handler cannot read who is asking (that does not compile), and one that nothing may keep, a
//! statement or a one-time code, says [`crate::NoStore`] (or `no_store` on its route, in a routes
//! module, or `no_store(post)` for only some of its methods):
//!
//! ```ignore
//! async fn home(req: Req) -> Public<HtmlResult> {
//!     Public::new(Duration::from_secs(60), req.page(html! { <Layout req={&req} title="Home">{view}</Layout> }))
//! }
//! ```
//!
//! `App` lets shared caches keep it only when nothing about the request could make it differ
//! between users:
//!
//! - when the request carried credentials (`Cookie`, other than the time zone of
//!   [`crate::App::client_zone`], or `Authorization`), or anything read a
//!   [`crate::Caller`] for it (an API key in a header of the app's own included), the response is
//!   `private, no-cache`;
//! - when it is not the full document (a client navigation, a form answer, a data client's JSON
//!   from the same URL as the page), or is the document as the runtime fetches it after a write
//!   (`corten: page`, whose redirect to a place differs), only the browser keeps it (`private`,
//!   same lifetime), so a cache that ignores `Vary` cannot hand one form to another client. An
//!   [`crate::App::api`] route has one form only, so it may be shared;
//! - a response that keeps a lifetime also varies on `cookie`: after the user signs in or out,
//!   the browser fetches the page again instead of reusing the other one.
//!
//! Some things are never shared, whoever set the header (`Public`, or a `Cache-Control` written by
//! hand, by a middleware or on an [`crate::HtmlResponse`]): a response that sets a cookie, HTML
//! with this request's CSP nonce (`req.nonce()` in the layout, or a handler that takes
//! [`crate::security::Nonce`]), a page that draws a form's new submit key
//! ([`crate::SubmitKey::field`]: each visitor needs a key of their own), and an answer to a request
//! whose handler or middleware read a [`crate::Caller`]. They get `private, no-cache`, and
//! `corten dev` logs the first three. A page that draws a submit key also loses the caching headers
//! a CDN reads first, by name ([`CDN_CACHING`]: `CDN-Cache-Control`, `Surrogate-Control`, ...),
//! and its `no-store` goes out `private, no-store`, for a CDN that ignores a bare one. A
//! [`crate::live`] stream's fragments are text rendered after its headers went out, so they carry
//! no such mark.
//!
//! The app is the first shared cache of its own `Public` pages, JSON, text and files: the whole document
//! or body one made for a request without credentials is kept for its shared lifetime and given
//! again in the handler's place ([`crate::App::kept_answers`], `docs/design.md#choice-kept-pages`), and goes out through
//! the same checks as the handler's own answer.
//!
//! A `Public` handler cannot read a cookie or a header through an extractor of the app's own unless
//! the app marks it [`crate::answer::Anonymous`]. A `Cache-Control` written by hand is the app's
//! own choice apart from the rules above. A cache in front must key on `Vary` (`corten`, `accept`,
//! `accept-encoding`, `cookie` on an answer to a request without one, and `accept-language` with
//! [`crate::App::messages`] unless the handler took the locale from the URL,
//! [`crate::Req::set_locale`]); the deploy guide names the setting for nginx, Cloudflare and CloudFront.

use std::time::Duration;

use crate::body::Body;
use crate::response::IntoResponseParts;
use crate::response::Response;
use crate::response::ResponseParts;
use http::header;
use http::HeaderMap;
use http::HeaderValue;
use http::StatusCode;

/// What caches may do with a response, as [`crate::Public`] and [`crate::NoStore`] set it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Cache {
    kind: Kind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// `shared` is `s-maxage` (a shared cache's own lifetime) when it is not `max_age`;
    /// `stale` is `stale-while-revalidate` and `if_error` `stale-if-error`, each left out at 0.
    Public {
        max_age: u64,
        shared: Option<u64>,
        stale: u64,
        if_error: u64,
    },
    NoStore,
    /// At a URL that names its content: a year, and the browser does not ask again.
    Immutable,
}

impl Cache {
    /// Any cache may keep the response for `max_age` (whole seconds) and give it to anyone, when
    /// nothing about the request makes it personal.
    pub(crate) fn public(max_age: Duration) -> Self {
        Cache { kind: Kind::Public { max_age: max_age.as_secs(), shared: None, stale: 0, if_error: 0 } }
    }

    /// A shared cache (a CDN, a proxy) keeps the response for `shared` instead (`s-maxage`), while
    /// the browser keeps `max_age`.
    pub(crate) fn shared(self, shared: Duration) -> Self {
        match self.kind {
            Kind::Public { max_age, stale, if_error, .. } => {
                Cache { kind: Kind::Public { max_age, shared: Some(shared.as_secs()), stale, if_error } }
            }
            Kind::NoStore | Kind::Immutable => self,
        }
    }

    /// After `max_age`, a cache may still serve the response for up to `stale` while it fetches
    /// a fresh one in the background.
    pub(crate) fn stale_while_revalidate(self, stale: Duration) -> Self {
        match self.kind {
            Kind::Public { max_age, shared, if_error, .. } => {
                Cache { kind: Kind::Public { max_age, shared, stale: stale.as_secs(), if_error } }
            }
            Kind::NoStore | Kind::Immutable => self,
        }
    }

    /// After `max_age`, a cache that cannot get a fresh answer (the server is down, or answers
    /// 500, 502, 503 or 504) may serve the response for up to `if_error` instead (RFC 5861).
    pub(crate) fn stale_if_error(self, if_error: Duration) -> Self {
        match self.kind {
            Kind::Public { max_age, shared, stale, .. } => {
                Cache { kind: Kind::Public { max_age, shared, stale, if_error: if_error.as_secs() } }
            }
            Kind::NoStore | Kind::Immutable => self,
        }
    }

    /// Nothing keeps the response, not even the browser's own cache (a statement, a one-time
    /// code). The browser's back/forward cache may not restore such a page either.
    pub(crate) fn no_store() -> Self {
        Cache { kind: Kind::NoStore }
    }

    /// At a URL that names its content, so the answer there never changes: any cache keeps it
    /// for a year, whatever cookies the request carried.
    pub(crate) fn immutable() -> Self {
        Cache { kind: Kind::Immutable }
    }

    /// How long a shared cache may keep it, in seconds: `s-maxage` where it has one, else
    /// `max-age` (RFC 9111 section 4.2.1). 0 for one nothing keeps, or that its URL names.
    fn lifetime(self) -> u64 {
        match self.kind {
            Kind::Public { max_age, shared, .. } => shared.unwrap_or(max_age),
            Kind::NoStore | Kind::Immutable => 0,
        }
    }

    /// The header, held by the thread where an answer's header can be ([`Cache::held_header`]), and made
    /// for the answer alone while the thread runs an unstaged route's handler ([`Unstaged`]).
    #[inline]
    fn value(self) -> HeaderValue {
        if UNSTAGED.get() {
            self.header()
        } else {
            self.held_header()
        }
    }

    /// The header, held: a route answers with the same numbers each time, so its header is made
    /// once on a thread and each answer after shares its bytes (a clone counts a reference), while
    /// it is one of the last `HELD` sets of numbers that thread made one for. A held header is
    /// how [`settle`] knows the line it finds is one `Cache` made ([`held_alone`]).
    #[inline(never)]
    fn held_header(self) -> HeaderValue {
        let Kind::Public { max_age, shared, stale, if_error } = self.kind else {
            return self.header();
        };
        MADE.try_with(|made| {
            let mut made = made.borrow_mut();
            if let Some((_, value)) = made.headers.iter().flatten().find(|(kind, _)| *kind == self.kind) {
                return value.clone();
            }
            let value = public(max_age, shared, stale, if_error);
            let at = made.next;
            made.headers[at] = Some((self.kind, value.clone()));
            made.next = (at + 1) % made.headers.len();
            value
        })
        .unwrap_or_else(|_| public(max_age, shared, stale, if_error))
    }

    /// The header made for this answer alone, from a `Vec`: an unstaged route's answer's, which no
    /// [`settle`] reads, so holding it would cost such an answer more and save it nothing.
    fn header(self) -> HeaderValue {
        let (max_age, shared, stale, if_error) = match self.kind {
            Kind::Public { max_age, shared, stale, if_error } => (max_age, shared, stale, if_error),
            Kind::NoStore => return NO_STORE,
            Kind::Immutable => return crate::assets::IMMUTABLE,
        };
        let mut text = Vec::with_capacity(96);
        let mut push = |name: &str, n: u64| {
            text.extend_from_slice(name.as_bytes());
            text.extend_from_slice(crate::ascii::digits(n, &mut [0; 20]));
        };
        push("public, max-age=", max_age);
        if let Some(shared) = shared {
            push(", s-maxage=", shared);
        }
        if stale > 0 {
            push(", stale-while-revalidate=", stale);
        }
        if if_error > 0 {
            push(", stale-if-error=", if_error);
        }
        HeaderValue::from_maybe_shared(bytes::Bytes::from(text)).expect("digits are a valid header")
    }
}

thread_local! {
    /// Whether this thread is running an unstaged route's handler ([`Unstaged`]).
    static UNSTAGED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Held while a thread runs an unstaged route's handler ([`crate::route::Lane`]), whose answer no
/// [`settle`] reads: [`Cache`] makes its header for it alone ([`Cache::header`]), and the thread
/// holds none of its bytes. A request the handler has an app's router answer meanwhile is settled
/// as one with a header written by hand is: read, line by line.
pub(crate) struct Unstaged(bool);

impl Unstaged {
    pub(crate) fn enter() -> Self {
        Unstaged(UNSTAGED.replace(true))
    }
}

impl Drop for Unstaged {
    fn drop(&mut self) {
        UNSTAGED.set(self.0);
    }
}

thread_local! {
    /// The `public` headers this thread made last, by their numbers ([`Cache::held_header`]).
    static MADE: std::cell::RefCell<Made> = const { std::cell::RefCell::new(Made { headers: [const { None }; HELD], next: 0 }) };
}

/// How many `public` headers a thread holds ([`MADE`]): one made for numbers past these is made
/// again when they come back.
const HELD: usize = 4;

struct Made {
    headers: [Option<(Kind, HeaderValue)>; HELD],
    /// Where the next one goes, in place of the oldest.
    next: usize,
}

#[cfg(test)]
impl Made {
    /// How many headers this thread holds.
    fn held() -> usize {
        MADE.with(|made| made.borrow().headers.iter().flatten().count())
    }
}

/// Whether this thread holds a header for `cache`'s numbers ([`MADE`]).
#[cfg(test)]
pub(crate) fn held(cache: Cache) -> bool {
    MADE.with(|made| made.borrow().headers.iter().flatten().any(|(kind, _)| *kind == cache.kind))
}

/// Whether `lines` are one line whose bytes this thread holds ([`MADE`]): a `public` header
/// [`Cache`] made, which says nothing [`settle`] reads a line for. The line and the thread each
/// hold those bytes, so no other value can have their address while both do; a line a middleware
/// or a handler wrote, even with the same text, has bytes of its own and is read.
fn held_alone(lines: &header::OccupiedEntry<'_, HeaderValue>) -> bool {
    let mut lines = lines.iter();
    let Some(line) = lines.next() else { return false };
    lines.next().is_none()
        && MADE
            .try_with(|made| {
                made.borrow().headers.iter().flatten().any(|(_, value)| std::ptr::eq(value.as_bytes(), line.as_bytes()))
            })
            .unwrap_or(false)
}

/// A `public` header with these numbers, made anew: its text and the count of its references in
/// one allocation, so holding it in [`MADE`] and in the answer allocates nothing more. (Made from
/// a `Vec`, `Bytes` allocates that count beside the text, or on the first clone when the text
/// fills the `Vec`.)
fn public(max_age: u64, shared: Option<u64>, stale: u64, if_error: u64) -> HeaderValue {
    let mut text = Text { len: 0, bytes: [0; Text::LONGEST] };
    let mut push = |name: &str, n: u64| {
        text.push(name.as_bytes());
        text.push(crate::ascii::digits(n, &mut [0; 20]));
    };
    push("public, max-age=", max_age);
    if let Some(shared) = shared {
        push(", s-maxage=", shared);
    }
    if stale > 0 {
        push(", stale-while-revalidate=", stale);
    }
    if if_error > 0 {
        push(", stale-if-error=", if_error);
    }
    HeaderValue::from_maybe_shared(bytes::Bytes::from_owner(text)).expect("digits are a valid header")
}

/// A `public` header's text ([`public`]).
struct Text {
    len: usize,
    bytes: [u8; Text::LONGEST],
}

impl Text {
    /// Every directive [`public`] writes, each with a `u64`'s 20 digits.
    const LONGEST: usize =
        "public, max-age=".len() + ", s-maxage=".len() + ", stale-while-revalidate=".len() + ", stale-if-error=".len() + 4 * 20;

    fn push(&mut self, part: &[u8]) {
        self.bytes[self.len..self.len + part.len()].copy_from_slice(part);
        self.len += part.len();
    }
}

impl AsRef<[u8]> for Text {
    fn as_ref(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

impl Cache {
    /// Sets the response's `Cache-Control` to this, as [`settle`] reads it.
    pub(crate) fn apply(self, res: &mut Response) {
        res.headers_mut().insert(header::CACHE_CONTROL, self.value());
        res.extensions_mut().insert(Typed { named: self.kind == Kind::Immutable, lifetime: self.lifetime() });
    }
}

impl IntoResponseParts for Cache {
    type Error = std::convert::Infallible;

    fn into_response_parts(self, mut res: ResponseParts) -> Result<ResponseParts, Self::Error> {
        res.headers_mut().insert(header::CACHE_CONTROL, self.value());
        res.extensions_mut().insert(Typed { named: false, lifetime: self.lifetime() });
        Ok(res)
    }
}

/// Marks a `Cache-Control` that came from [`Cache`], which [`settle`] checks against the request.
/// One extension, not two, since each costs a lookup.
#[derive(Clone, Copy)]
pub(crate) struct Typed {
    /// A [`Cache::immutable`] answer: its URL names it, so the request's cookies do not change it.
    named: bool,
    /// [`Cache::lifetime`], for the app's own keeping of the answer ([`crate::kept`]).
    lifetime: u64,
}

impl Typed {
    /// `res`'s mark and its lifetime in seconds, when it is an answer a shared cache may keep for
    /// one: what the app itself keeps ([`crate::kept`]).
    pub(crate) fn shared(res: &Response) -> Option<(Typed, u64)> {
        let typed = *res.extensions().get::<Typed>()?;
        (!typed.named && typed.lifetime > 0).then_some((typed, typed.lifetime))
    }

    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Typed { named: false, lifetime: 60 }
    }
}

/// The default for what the app renders.
pub(crate) const PRIVATE: HeaderValue = HeaderValue::from_static("private, no-cache");

/// A page that draws a submit key and says `no-store`: some CDNs keep an answer that says only
/// `no-store` (Fastly), and none keeps one that says `private`.
pub(crate) const PRIVATE_NO_STORE: HeaderValue = HeaderValue::from_static("private, no-store");

/// The caching headers a CDN or proxy reads before `Cache-Control`, by exact name: RFC 9213's
/// `CDN-Cache-Control`, Cloudflare's and Vercel's own, `Surrogate-Control`, Akamai's `Edge-Control`
/// and nginx's `X-Accel-Expires`. [`settle`] removes them from a page that draws a submit key, an
/// unstaged route's answer that sets a cookie loses them and any other `*cache-control`, and a
/// [`crate::Public`] answer may not set one. A name a deployment configures for itself (RFC 9213
/// allows one) is the deployment's.
pub(crate) const CDN_CACHING: [&str; 6] = [
    "cdn-cache-control",
    "cloudflare-cdn-cache-control",
    "vercel-cdn-cache-control",
    "surrogate-control",
    "edge-control",
    "x-accel-expires",
];

/// [`CDN_CACHING`] as header names, made once.
static CDN_HEADERS: [header::HeaderName; CDN_CACHING.len()] = {
    let [a, b, c, d, e, f] = CDN_CACHING;
    [
        header::HeaderName::from_static(a),
        header::HeaderName::from_static(b),
        header::HeaderName::from_static(c),
        header::HeaderName::from_static(d),
        header::HeaderName::from_static(e),
        header::HeaderName::from_static(f),
    ]
};

/// What the layer knows about a request, for [`settle`].
pub(crate) struct Seen {
    /// A `Cookie` or `Authorization` header.
    pub credentials: bool,
    /// Something read a [`crate::Caller`]: the answer is that caller's, whoever set the header.
    pub caller: bool,
    /// Not the full document of a page route (a navigation, a form answer, JSON for a data client).
    pub partial: bool,
    /// The response's HTML has this request's nonce.
    pub nonce: bool,
    pub dev: bool,
}

/// The staged request's credentials. Keep the cookie iterator so inspecting more than one line
/// (for the zone-only exception or the visitor's zone) needs no second lookup.
pub(crate) struct Credentials<'a> {
    cookies: header::GetAll<'a, HeaderValue>,
}

impl<'a> Credentials<'a> {
    pub(crate) fn read(headers: &'a HeaderMap) -> Self {
        Self { cookies: headers.get_all(header::COOKIE) }
    }

    pub(crate) fn cookies(&self) -> header::ValueIter<'a, HeaderValue> {
        self.cookies.iter()
    }

    pub(crate) fn has_cookie(&self) -> bool {
        self.cookies().next().is_some()
    }

    /// The zone cookie by itself says nothing about who is asking.
    pub(crate) fn personal(&self, authorized: impl FnOnce() -> bool) -> bool {
        let mut cookies = self.cookies();
        cookies.next().is_some_and(|cookie| !zone_only(cookie) || cookies.next().is_some()) || authorized()
    }

    pub(crate) fn for_error_page(&self, headers: &HeaderMap) -> crate::page::Credentials {
        crate::page::Credentials {
            cookie: self.cookies().next().cloned(),
            authorization: headers.get(header::AUTHORIZATION).cloned(),
        }
    }
}

/// A `Cookie` header with only [`crate::App::client_zone`]'s cookie in it.
fn zone_only(cookie: &HeaderValue) -> bool {
    let cookie = cookie.as_bytes();
    cookie.starts_with(b"corten-zone=") && !cookie.contains(&b';')
}

/// Capture the client's validators before middleware. A GET with no named tag or accepted coding
/// skips the hash; a HEAD still gets a validator (RFC 9111 section 4.3.5).
pub(crate) fn request_tags(method: &http::Method, headers: &HeaderMap, accepts_coding: bool) -> Option<Vec<HeaderValue>> {
    if !matches!(*method, http::Method::GET | http::Method::HEAD) {
        return None;
    }
    let tags = headers.get_all(header::IF_NONE_MATCH);
    let lines = tags.iter();
    (*method == http::Method::HEAD || accepts_coding || tags.iter().next().is_some()).then(|| lines.cloned().collect())
}

/// Corten's removal of a redirect's notice, on the page it was for (either cookie it rides in): that
/// page is private, by the request's cookie, but not the app's mistake.
const NOTICE_GONE: [&[u8]; 2] = [b"__Host-corten-notice=;", b"corten-notice=;"];

/// Sets the response's `Cache-Control`: the default when it has none, and a private one instead
/// of a shared one when the response may differ between users.
pub(crate) fn settle(res: &mut Response, seen: Seen, path: &str) {
    // A page that drew a submit key ([`Unrepeatable`]) is the browser's alone, whatever its
    // `Cache-Control` says: a CDN reads its own header first, so none of those Corten names stays.
    let drew_key = res.extensions().get::<Unrepeatable>().is_some();
    if drew_key {
        drop_cdn_caching(res.headers_mut());
    }
    // One lookup for the usual response, which says nothing.
    match res.headers_mut().entry(header::CACHE_CONTROL) {
        header::Entry::Vacant(entry) => {
            entry.insert(PRIVATE);
            return;
        }
        // `public` and its ages as [`Cache`] made them say nothing read for below.
        header::Entry::Occupied(entry) if held_alone(&entry) => {}
        header::Entry::Occupied(mut entry) => {
            // The directives of every line count, as HTTP joins them (a second line is rare: only
            // a header written by hand has one). Only a plain `private` makes the answer private:
            // `private="set-cookie"` still lets a shared cache keep the rest. A `no-store` or
            // `private` is trusted as written only when every reader sees it alike: one line of
            // plain text with no quoted value. Otherwise a `no-store` goes out as one line of
            // plain text (the lines joined, or `no-store` alone beside a quoted value or a byte
            // that is not text), and such a `private` is not trusted (an answer that sets a cookie
            // or read a caller is still made private below). With `must-understand`, a cache that
            // knows the status may ignore `no-store` (RFC 9111 5.2.2.3), `must-understand` with
            // or without a value: the header is left as written unless the answer is personal, and a `private`
            // beside them is not trusted.
            let (mut no_store, mut private, mut must_understand) = (false, false, false);
            let (mut lines, mut quoted, mut text) = (0, false, true);
            for line in entry.iter() {
                let says = says(line.as_bytes());
                no_store |= says.no_store;
                private |= says.private;
                must_understand |= says.must_understand;
                lines += 1;
                quoted |= line.as_bytes().contains(&b'"');
                text &= line.to_str().is_ok();
            }
            let plain = lines == 1 && !quoted && text;
            if no_store && !must_understand {
                // A page that drew a submit key says `private` too, for a CDN that ignores
                // `no-store`.
                if drew_key && !(private && plain) {
                    entry.insert(PRIVATE_NO_STORE);
                } else if quoted || !text {
                    entry.insert(NO_STORE);
                } else if lines > 1 {
                    let mut joined = Vec::new();
                    for line in entry.iter() {
                        if !joined.is_empty() {
                            joined.extend_from_slice(b", ");
                        }
                        joined.extend_from_slice(line.as_bytes());
                    }
                    entry.insert(HeaderValue::from_bytes(&joined).unwrap_or(NO_STORE));
                }
                return;
            }
            // With `must-understand`, a `no-store` any reader could find (`no-store=1` too) is one
            // a cache that knows the status may ignore: `private` alone does not keep the browser
            // out.
            if private && plain && !(must_understand && entry.iter().any(|line| mentions_no_store(line.as_bytes()))) {
                return;
            }
        }
    }
    // A personal answer whose header is replaced below gets `no-store` if any reader could find
    // one in it (`no-store=1`, inside a quoted value, with `must-understand`): stricter than
    // `private, no-cache` for every reading. Read only when the header is replaced.
    let personal = |headers: &HeaderMap| {
        if headers.get_all(header::CACHE_CONTROL).iter().any(|line| mentions_no_store(line.as_bytes())) {
            if drew_key {
                PRIVATE_NO_STORE
            } else {
                NO_STORE
            }
        } else {
            PRIVATE
        }
    };
    // A kept answer given again carries its mark with what was kept, not as an extension.
    let typed = res.extensions().get::<Typed>().copied().or_else(|| crate::kept::Kept::typed(res.extensions()));
    let bug = if seen.nonce {
        Some("its HTML has this request's CSP nonce (req.nonce() in the layout, or a handler that takes Nonce)")
    } else if res
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .any(|cookie| !NOTICE_GONE.iter().any(|gone| cookie.as_bytes().starts_with(gone)))
    {
        Some("it sets a cookie")
    } else if drew_key {
        // The mark that keeps its tag off and the app from keeping it: each visitor needs a key
        // of their own, and the browser one it has not sent.
        Some("it draws a form's new submit key (SubmitKey::field), and each visitor needs a key of their own")
    } else {
        None
    };
    let headers = res.headers_mut();
    if let Some(bug) = bug {
        if seen.dev {
            tracing::warn!("corten: {path} is marked for shared caches, but {bug}, so it was sent private, no-cache (or no-store, if its header names it)");
        }
        headers.insert(header::CACHE_CONTROL, personal(headers));
        return;
    }
    if seen.caller || typed.is_some_and(|typed| seen.credentials && !typed.named) {
        headers.insert(header::CACHE_CONTROL, personal(headers));
        return;
    }
    let Some(typed) = typed else { return };
    if seen.partial {
        let browser = private(headers.get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()).unwrap_or(""));
        headers.insert(header::CACHE_CONTROL, browser);
    }
    if !typed.named {
        headers.append(header::VARY, HeaderValue::from_static("cookie"));
    }
}

/// Removes the caching headers a CDN reads before `Cache-Control` ([`CDN_CACHING`]) from an
/// answer no shared cache may keep.
pub(crate) fn drop_cdn_caching(headers: &mut HeaderMap) {
    // One pass comparing names first: the usual answer has none of them, and a lookup of each
    // costs more than that pass.
    if headers.keys().any(|name| CDN_CACHING.contains(&name.as_str())) {
        for name in &CDN_HEADERS {
            headers.remove(name);
        }
    }
}

/// The `Cache-Control` for a page that drew a submit key and goes out without [`settle`] (a
/// refused write's error page), with the CDN caching headers it had removed: `private, no-store`
/// where it names `no-store`, as [`settle`] gives one, and the default otherwise.
pub(crate) fn drawn_unsettled(headers: &mut HeaderMap) -> HeaderValue {
    drop_cdn_caching(headers);
    if headers.get_all(header::CACHE_CONTROL).iter().any(|line| mentions_no_store(line.as_bytes())) {
        PRIVATE_NO_STORE
    } else {
        PRIVATE
    }
}

/// In a debug build: whether an answer's headers, as sent, let a shared cache keep it: one of
/// [`CDN_CACHING`], or no line of its `Cache-Control` says a plain `private` (some CDNs keep an
/// answer that says only `no-cache` or `no-store`).
#[cfg(debug_assertions)]
pub(crate) fn sent_shared(headers: &HeaderMap) -> bool {
    CDN_HEADERS.iter().any(|name| headers.contains_key(name))
        || !headers.get_all(header::CACHE_CONTROL).iter().any(|line| says(line.as_bytes()).private)
}

/// Whether the client explicitly accepts a coding other than identity. A positive wildcard counts:
/// it allows a non-identity coding not named in the field (RFC 9110 12.5.3). An absent field is
/// not an explicit signal for tagging, even though HTTP permits any coding in that case.
#[cfg(not(feature = "compress"))]
pub(crate) fn accepts_a_coding(headers: &HeaderMap) -> bool {
    use crate::http::{is_token, list_items, weight};

    headers.get_all(header::ACCEPT_ENCODING).iter().any(|value| {
        let bytes = value.as_bytes();
        list_items(bytes).any(|range| {
            let item = &bytes[range];
            let (name, params) = match item.iter().position(|&b| b == b';') {
                Some(at) => (&item[..at], Some(&item[at + 1..])),
                None => (item, None),
            };
            let name = name.trim_ascii();
            !name.eq_ignore_ascii_case(b"identity") && is_token(name) && matches!(params.map_or(Some(1000), weight), Some(1..))
        })
    })
}

/// The key a page's tag is made with ([`tag`]): random for each process, so nobody outside it can
/// make two bodies share a tag.
static TAG_KEY: std::sync::LazyLock<std::hash::RandomState> = std::sync::LazyLock::new(std::hash::RandomState::new);

/// Marks a page whose body holds a value drawn for this request alone (a [`crate::SubmitKey`]'s
/// new key): its tag would never match, so it is not made; no cache may give it to another
/// visitor or reuse it unasked ([`settle`]), and the app does not keep it ([`crate::kept`]).
#[derive(Clone, Copy)]
pub(crate) struct Unrepeatable;

/// A page's `200` to a `GET` or `HEAD` with a weak `ETag` from its body and its `corten-*`
/// headers, or `304 Not Modified` in its place when the request's `If-None-Match` (`has`, each
/// line) names that tag. The tag is made from the answer this request would be sent (rendered
/// for it, or the kept answer given in its place, `crate::kept`), so a `304` says the
/// client's copy is what it would get now, whoever is asking. The runtime's headers count because
/// a cache keeps a stored header the `304` does not send (RFC 9111 4.3.4): a copy that came with a
/// notice or a place to go must not be reused for an answer without one. Weak, since the body is
/// compressed per request. Only an answer the client may keep, revalidates and is all there (an
/// exact size: never a stream) is tagged, and one that has a tag or an encoding of its own, or a
/// value drawn for this request ([`Unrepeatable`]), is left as it is. An answer compression sends
/// as it is (an image, a PDF, `no-transform`) is tagged too: its `304` saves no compression but the
/// whole body, which costs the client far more to receive than the hash costs here.
pub(crate) async fn tag(res: Response, has: &[HeaderValue]) -> Response {
    let headers = res.headers();
    if res.status() != StatusCode::OK
        || headers.contains_key(header::ETAG)
        || headers.contains_key(header::CONTENT_ENCODING)
        || headers.contains_key(header::CONTENT_RANGE)
        || headers.get_all(header::CACHE_CONTROL).iter().any(|line| {
            // An immutable answer is never asked about again.
            mentions_no_store(line.as_bytes())
                || directives(line.as_bytes()).any(|d| d.trim_ascii().eq_ignore_ascii_case(b"immutable"))
        })
        || res.extensions().get::<crate::answer::Relayed>().is_some()
        || res.extensions().get::<Unrepeatable>().is_some()
        || http_body::Body::size_hint(res.body()).exact().is_none()
    {
        return res;
    }
    let (mut parts, body) = res.into_parts();
    // Exact size: one held `Bytes`, which comes back as it is (compression then sends a held
    // value's stored form, which it finds by this pointer).
    let Ok(bytes) = crate::body::to_bytes(body, usize::MAX).await else {
        return Response::from_parts(parts, Body::empty());
    };
    // A kept answer's body is read once, for its first tag.
    let tag = tagged(crate::kept::Kept::hashed(&parts.extensions, &bytes, &*TAG_KEY), &parts.headers);
    if has.iter().any(|line| names(line.as_bytes(), &tag[2..])) {
        parts.status = StatusCode::NOT_MODIFIED;
        // What a cache updates its copy with (RFC 9110 15.4.5): not the body's type or length, and
        // the `Vary` compression would have given the `200`.
        #[cfg(feature = "compress")]
        if crate::compress::varies(
            parts.headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or(""),
            &parts.headers,
        ) {
            crate::compress::vary(&mut parts.headers);
        }
        parts.headers.remove(header::CONTENT_TYPE);
        parts.headers.remove(header::CONTENT_LENGTH);
        parts.headers.insert(header::ETAG, HeaderValue::from_bytes(&tag).expect("hex is a header value"));
        return Response::from_parts(parts, Body::new(Unsized));
    }
    parts.headers.insert(header::ETAG, HeaderValue::from_bytes(&tag).expect("hex is a header value"));
    Response::from_parts(parts, Body::from(bytes))
}

/// A `304`'s empty body, of no stated size: a `304`'s `Content-Length` may only be the `200`'s
/// (RFC 9110 8.6), which compression has not decided, so nothing after this reads a length of
/// zero from the body and says it.
struct Unsized;

impl http_body::Body for Unsized {
    type Data = bytes::Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        std::task::Poll::Ready(None)
    }

    fn is_end_stream(&self) -> bool {
        true
    }
}

/// `W/"..."`: 64 bits of the hash of the body (with its length), its `Content-Type` (a `304` leaves the stored one)
/// and the `corten-*` headers (each name and value, with their lengths) under [`TAG_KEY`], in hex.
#[cfg(test)]
fn weak_tag(body: &[u8], headers: &HeaderMap) -> [u8; 20] {
    let body = bytes::Bytes::copy_from_slice(body);
    tagged(crate::kept::Kept::hashed(&http::Extensions::new(), &body, &*TAG_KEY), headers)
}

/// The tag from `hasher`, which has read the body with its length
/// ([`crate::kept::Kept::hashed`]), and the headers that count.
fn tagged(mut hasher: std::hash::DefaultHasher, headers: &HeaderMap) -> [u8; 20] {
    use std::hash::Hasher;
    for (name, value) in headers {
        if name == header::CONTENT_TYPE || name.as_str().starts_with("corten-") {
            hasher.write_usize(name.as_str().len());
            hasher.write(name.as_str().as_bytes());
            hasher.write_usize(value.len());
            hasher.write(value.as_bytes());
        }
    }
    let hash = hasher.finish();
    let mut tag = *b"W/\"0000000000000000\"";
    crate::ascii::hex(hash, (&mut tag[3..19]).try_into().expect("16 bytes"));
    tag
}

/// Whether an `If-None-Match` line names `opaque` (a tag with its quotes, `W/` aside), compared
/// weakly (RFC 9110 8.8.3.2), or is `*`. A line that does not parse names nothing.
pub(crate) fn names(line: &[u8], opaque: &[u8]) -> bool {
    if line.trim_ascii() == b"*" {
        return true;
    }
    let mut rest = line;
    loop {
        rest = rest.trim_ascii_start();
        while let [b',', tail @ ..] = rest {
            rest = tail.trim_ascii_start();
        }
        if rest.is_empty() {
            return false;
        }
        rest = rest.strip_prefix(b"W/").unwrap_or(rest);
        let [b'"', inner @ ..] = rest else { return false };
        let Some(end) = inner.iter().position(|&b| b == b'"') else { return false };
        let (tag, after) = (&rest[..end + 2], inner[end + 1..].trim_ascii_start());
        // A tag ends at a comma or the end of the line.
        if !(after.is_empty() || after[0] == b',') {
            return false;
        }
        if tag == opaque {
            return true;
        }
        rest = after;
    }
}

/// Whether a `Cache-Control` line has `no-store` anywhere in it, as a reader that matches text
/// would find it (case aside).
pub(crate) fn mentions_no_store(line: &[u8]) -> bool {
    line.windows(8).any(|w| w.eq_ignore_ascii_case(b"no-store"))
}

/// `Cache-Control: no-store`, as `NoStore` writes it.
pub(crate) const NO_STORE: HeaderValue = HeaderValue::from_static("no-store");

/// Whether a `Cache-Control` line says `no-store` and `private`, each as a directive without a
/// value (`no-store=1` is not one, and `private="set-cookie"` still lets a shared cache keep the
/// rest). Bytes, not text: the whitespace HTTP allows around a directive is ASCII.
pub(crate) fn says(line: &[u8]) -> Says {
    let mut says = Says::default();
    for d in directives(line) {
        let d = d.trim_ascii();
        says.no_store |= d.eq_ignore_ascii_case(b"no-store");
        says.private |= d.eq_ignore_ascii_case(b"private");
        // By name, whatever its value: a reader that ignores the value still sees it.
        let name = d.split(|&b| b == b'=').next().unwrap_or(d).trim_ascii();
        says.must_understand |= name.eq_ignore_ascii_case(b"must-understand");
    }
    says
}

/// What a `Cache-Control` line plainly says, of what decides whether an answer may be kept.
#[derive(Default)]
pub(crate) struct Says {
    pub(crate) no_store: bool,
    pub(crate) private: bool,
    pub(crate) must_understand: bool,
}

/// A `Cache-Control` line's directives, split at the commas outside a quoted value
/// (`no-cache="a, b"` is one directive, RFC 9110 5.6.4).
fn directives(line: &[u8]) -> impl Iterator<Item = &[u8]> {
    split_unquoted(line, b',')
}

/// `line` split at each `at` outside a quoted string, a backslash escaping the byte after it
/// inside one (RFC 9110 5.6.4): a list's elements at `,`, an element's parameters at `;`.
pub(crate) fn split_unquoted(line: &[u8], at: u8) -> impl Iterator<Item = &[u8]> {
    let mut quoted = false;
    let mut escaped = false;
    line.split(move |&b| {
        if escaped {
            escaped = false;
        } else if quoted && b == b'\\' {
            escaped = true;
        } else if b == b'"' {
            quoted = !quoted;
        } else if b == at && !quoted {
            return true;
        }
        false
    })
}

/// The same lifetime for the browser alone: `public` and `s-maxage` become `private`.
fn private(text: &str) -> HeaderValue {
    let mut out = String::from("private");
    for directive in text.split(',').map(str::trim).filter(|d| !d.is_empty()) {
        let name = directive.split('=').next().unwrap_or("").trim();
        if !name.eq_ignore_ascii_case("public") && !name.eq_ignore_ascii_case("s-maxage") {
            out.push_str(", ");
            out.push_str(directive);
        }
    }
    HeaderValue::try_from(out).unwrap_or(PRIVATE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::response::IntoResponse;

    #[test]
    fn a_session_cookie_settles_the_cache_decision_without_authorization() {
        let mut headers = HeaderMap::new();
        assert!(!Credentials::read(&headers).personal(|| false));
        assert!(Credentials::read(&headers).personal(|| true));
        headers.insert(header::COOKIE, HeaderValue::from_static("corten-zone=America/Chicago"));
        assert!(!Credentials::read(&headers).personal(|| false));
        assert!(Credentials::read(&headers).personal(|| true));
        headers.append(header::COOKIE, HeaderValue::from_static("session=abc"));
        assert!(Credentials::read(&headers).personal(|| panic!("the extra cookie settles it")));
        headers.insert(header::COOKIE, HeaderValue::from_static("session=abc"));
        assert!(Credentials::read(&headers).personal(|| panic!("the session cookie settles it")));
    }

    fn seen() -> Seen {
        Seen { credentials: false, caller: false, partial: false, nonce: false, dev: false }
    }

    #[test]
    fn if_none_match_names_a_tag_weakly_in_a_list_that_parses() {
        let ours = br#""0123456789abcdef""#;
        for line in [r#""0123456789abcdef""#, r#"W/"0123456789abcdef""#, r#" "a" ,, W/"b",  "0123456789abcdef" "#, "*", " * "] {
            assert!(names(line.as_bytes(), ours), "{line}");
        }
        for line in [
            "",
            ",",
            r#""a""#,
            r#""0123456789abcdef"x"#,
            r#""a" "0123456789abcdef""#,
            r#"w/"0123456789abcdef""#,
            r#""0123456789abcdef"#,
            "0123456789abcdef",
            r#"*, "a""#,
        ] {
            assert!(!names(line.as_bytes(), ours), "{line}");
        }
        let tag = weak_tag(b"body", &HeaderMap::new());
        assert_eq!((&tag[..3], tag[19]), (&b"W/\""[..], b'"'));
        assert_eq!(tag, weak_tag(b"body", &HeaderMap::new()), "one key per process");
        assert_ne!(tag, weak_tag(b"bodz", &HeaderMap::new()));
        // The body's type and the runtime's headers count, each name with its value; others do not.
        let with = |pairs: &[(&'static str, &'static str)]| {
            let mut headers = HeaderMap::new();
            for (name, value) in pairs {
                headers.append(*name, HeaderValue::from_static(value));
            }
            weak_tag(b"body", &headers)
        };
        assert_eq!(with(&[("x-request-id", "1")]), tag);
        assert_ne!(with(&[("content-type", "text/html")]), with(&[("content-type", "text/csv")]));
        assert_ne!(with(&[("corten-notice", "m=Saved")]), tag);
        assert_ne!(with(&[("corten-location", "/a")]), with(&[("corten-location", "/b")]));
        assert_ne!(with(&[("corten-page", "1")]), with(&[("corten-patch", "1")]));
    }

    /// The `Cache-Control` sent for a response with `cache` (from a [`Cache`] when `typed`).
    fn settled(cache: Option<&'static str>, typed: bool, seen: Seen, cookie: bool) -> String {
        let mut res = "x".into_response();
        if let Some(cache) = cache {
            res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
        }
        if typed {
            res.extensions_mut().insert(Typed { named: false, lifetime: 60 });
        }
        if cookie {
            res.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_static("a=b"));
        }
        settle(&mut res, seen, "/x");
        res.headers()[header::CACHE_CONTROL].to_str().unwrap().to_string()
    }

    /// An answer at a URL that names it keeps its year with a request's cookies, but not with a
    /// caller read, a cookie it sets or the request's nonce, and a client navigation is the
    /// browser's alone.
    #[test]
    fn a_named_answer_ignores_only_the_requests_credentials() {
        let named = |seen: Seen, cookie: bool| {
            let mut res = "x".into_response();
            Cache::immutable().apply(&mut res);
            if cookie {
                res.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_static("a=b"));
            }
            settle(&mut res, seen, "/x");
            let vary = res.headers().get(header::VARY).map(|v| v.to_str().unwrap().to_string());
            (res.headers()[header::CACHE_CONTROL].to_str().unwrap().to_string(), vary)
        };
        let year = "public, max-age=31536000, immutable".to_string();
        assert_eq!(named(seen(), false), (year.clone(), None));
        assert_eq!(named(Seen { credentials: true, ..seen() }, false), (year, None), "the URL says what it is");
        assert_eq!(named(Seen { caller: true, credentials: true, ..seen() }, false).0, "private, no-cache");
        assert_eq!(named(seen(), true).0, "private, no-cache", "it sets a cookie");
        assert_eq!(named(Seen { nonce: true, ..seen() }, false).0, "private, no-cache");
        assert_eq!(named(Seen { partial: true, ..seen() }, false).0, "private, max-age=31536000, immutable");
    }

    /// A route's numbers make its header once on a thread: each answer after shares its bytes, and
    /// other numbers still get their own, more of them than are held at once too.
    #[test]
    fn a_header_with_the_same_numbers_is_made_once() {
        let minute = Cache::public(Duration::from_secs(60));
        let (first, again) = (minute.held_header(), minute.held_header());
        assert!(std::ptr::eq(first.as_bytes(), again.as_bytes()), "made once");
        let other = minute.shared(Duration::from_secs(3600)).held_header();
        assert_eq!(first, "public, max-age=60");
        assert_eq!(other, "public, max-age=60, s-maxage=3600");
        for round in 0..3 {
            for n in 1..=9 {
                let cache = Cache::public(Duration::from_secs(n)).stale_if_error(Duration::from_secs(n * 10));
                assert_eq!(cache.held_header(), format!("public, max-age={n}, stale-if-error={}", n * 10), "round {round}");
            }
        }
        assert!(std::ptr::eq(minute.held_header().as_bytes(), minute.held_header().as_bytes()), "made once again");
    }

    /// A thread holds `HELD` headers: one for numbers past the last `HELD` it made is made again,
    /// and then shared again. `first` is alive throughout, so a header made again cannot reuse its
    /// bytes' address.
    #[test]
    fn a_thread_holds_its_last_headers_and_makes_an_older_one_again() {
        // Numbers no other test asks for, so each below is new to the thread whatever ran on it.
        let numbers = |n: u64| Cache::public(Duration::from_secs(1_000_000 + n)).stale_while_revalidate(Duration::from_secs(7));
        let first = numbers(0).held_header();
        assert!(Made::held() >= 1 && Made::held() <= HELD);
        for n in 1..=HELD as u64 {
            assert_eq!(numbers(n).held_header(), format!("public, max-age={}, stale-while-revalidate=7", 1_000_000 + n));
            assert!(Made::held() <= HELD, "held {} after {n}", Made::held());
        }
        assert_eq!(Made::held(), HELD, "full, and no more");
        let again = numbers(0).held_header();
        assert_eq!(again, first);
        assert!(!std::ptr::eq(first.as_bytes(), again.as_bytes()), "made again: the oldest went for the last");
        assert!(std::ptr::eq(again.as_bytes(), numbers(0).held_header().as_bytes()), "then held again");
        assert_eq!(Made::held(), HELD);
    }

    /// While a thread runs an unstaged route's handler, an answer's header has the same text but is
    /// made for that answer alone: the thread holds none for its numbers. After, the thread holds
    /// it again.
    #[test]
    fn an_unstaged_answer_s_header_is_made_for_it_alone() {
        let numbers =
            Cache::public(Duration::from_secs(2_000_000)).shared(Duration::from_secs(9)).stale_if_error(Duration::from_secs(3));
        let text = "public, max-age=2000000, s-maxage=9, stale-if-error=3";
        {
            let _unstaged = Unstaged::enter();
            let (value, again) = (numbers.value(), numbers.value());
            assert_eq!((value.to_str().unwrap(), again.to_str().unwrap()), (text, text));
            assert!(!held(numbers), "nothing holds it");
            assert!(!std::ptr::eq(value.as_bytes(), again.as_bytes()), "each made for its answer");
            drop(Unstaged::enter());
            assert!(UNSTAGED.get(), "a guard within leaves it as it found it");
        }
        assert!(!UNSTAGED.get());
        let value = numbers.value();
        assert_eq!(value, text);
        assert!(held(numbers) && std::ptr::eq(value.as_bytes(), numbers.value().as_bytes()));
        let minute = Duration::from_secs(60);
        for cache in
            [Cache::no_store(), Cache::immutable(), Cache::public(minute), Cache::public(minute).stale_while_revalidate(minute)]
        {
            assert_eq!(cache.held_header(), cache.header());
        }
    }

    /// `settle` skips its read of a `Cache-Control` only when it is one line whose bytes this
    /// thread holds: not the same text made apart, not beside a second line, and not a header the
    /// thread no longer holds.
    #[test]
    fn only_a_held_header_alone_is_not_read() {
        let numbers = |n: u64| Cache::public(Duration::from_secs(4_000_000 + n));
        let held = numbers(0).held_header();
        assert!(alone(std::slice::from_ref(&held)), "the held header, alone");
        assert!(!alone(&[numbers(0).header()]), "the same text, made apart");
        assert!(!alone(&[HeaderValue::from_static("public, max-age=4000000")]), "the same text, written");
        assert!(!alone(&[held.clone(), HeaderValue::from_static("no-store")]), "beside a second line");
        assert!(!alone(&[HeaderValue::from_static("no-store"), held.clone()]), "after a first line");
        for n in 1..=HELD as u64 {
            numbers(n).held_header();
        }
        assert!(!alone(&[held]), "no longer held, though still alive");
    }

    /// Whether `settle` would skip its read of these `Cache-Control` lines on this thread.
    fn alone(lines: &[HeaderValue]) -> bool {
        let mut headers = HeaderMap::new();
        for line in lines {
            headers.append(header::CACHE_CONTROL, line.clone());
        }
        match headers.entry(header::CACHE_CONTROL) {
            header::Entry::Occupied(entry) => held_alone(&entry),
            header::Entry::Vacant(_) => unreachable!("a line was added"),
        }
    }

    /// A header another thread made and still holds is read on this one, though this thread holds
    /// a header of the same text for the same numbers: a kept answer given on a worker other than
    /// the one that made it. Each thread knows only its own.
    #[test]
    fn a_header_another_thread_holds_is_read() {
        let numbers = Cache::public(Duration::from_secs(5_000_000)).stale_if_error(Duration::from_secs(11));
        let (made, foreign) = std::sync::mpsc::channel();
        let (checked, done) = std::sync::mpsc::channel::<()>();
        let producer = std::thread::spawn(move || {
            let header = numbers.held_header();
            assert!(held(numbers) && alone(std::slice::from_ref(&header)), "the producer's own, alone");
            made.send(header).unwrap();
            // Held until this thread has looked, so both threads hold their own bytes meanwhile.
            done.recv().unwrap();
            assert!(held(numbers), "still the producer's");
        });
        let foreign = foreign.recv().unwrap();
        let own = numbers.held_header();
        assert_eq!(foreign, own, "the same text");
        assert!(!std::ptr::eq(foreign.as_bytes(), own.as_bytes()), "each thread made its own");
        assert!(alone(std::slice::from_ref(&own)), "this thread's own, alone");
        assert!(!alone(std::slice::from_ref(&foreign)), "another thread's, while it holds it");
        checked.send(()).unwrap();
        producer.join().unwrap();
        assert!(!alone(&[foreign]), "another thread's, after it has gone");
    }

    /// `immutable`'s and `no_store`'s headers are constants no thread holds: each is read
    /// however often it is sent, and sending it puts none of the thread's held headers out.
    #[test]
    fn an_immutable_or_no_store_header_is_read() {
        let numbers = |n: u64| Cache::public(Duration::from_secs(6_000_000 + n));
        let made: Vec<_> = (0..HELD as u64).map(|n| numbers(n).held_header()).collect();
        assert!(alone(std::slice::from_ref(&made[0])), "a held one, alone");
        for cache in [Cache::immutable(), Cache::no_store()] {
            for _ in 0..=HELD {
                let value = cache.value();
                assert!(!alone(std::slice::from_ref(&value)), "{cache:?}: {value:?}");
            }
            assert!(!held(cache), "{cache:?}");
        }
        assert_eq!(Cache::immutable().value(), "public, max-age=31536000, immutable");
        assert_eq!(Cache::no_store().value(), "no-store");
        for (n, value) in made.iter().enumerate() {
            assert!(held(numbers(n as u64)) && alone(std::slice::from_ref(value)), "{n} still held");
        }
    }

    #[test]
    fn the_header_says_what_was_asked() {
        let minute = Duration::from_secs(60);
        assert_eq!(Cache::public(minute).header(), "public, max-age=60");
        assert_eq!(
            Cache::public(minute).stale_while_revalidate(Duration::from_secs(600)).header(),
            "public, max-age=60, stale-while-revalidate=600"
        );
        assert_eq!(Cache::public(Duration::from_millis(1500)).header(), "public, max-age=1", "whole seconds");
        assert_eq!(Cache::no_store().stale_while_revalidate(minute).header(), "no-store");
        let day = Duration::from_secs(86_400);
        assert_eq!(Cache::public(minute).shared(day).header(), "public, max-age=60, s-maxage=86400");
        assert_eq!(
            Cache::public(minute).stale_while_revalidate(Duration::from_secs(3600)).shared(day).header(),
            "public, max-age=60, s-maxage=86400, stale-while-revalidate=3600",
            "in either order"
        );
        assert_eq!(Cache::no_store().shared(day).header(), "no-store");
        assert_eq!(
            Cache::public(minute).stale_if_error(day).stale_while_revalidate(minute).header(),
            "public, max-age=60, stale-while-revalidate=60, stale-if-error=86400",
            "in either order"
        );
        assert_eq!(
            Cache::public(minute).stale_while_revalidate(minute).stale_if_error(day).shared(day).header(),
            "public, max-age=60, s-maxage=86400, stale-while-revalidate=60, stale-if-error=86400",
            "each keeps the others"
        );
        assert_eq!(
            Cache::public(minute).stale_if_error(day).shared(day).header(),
            "public, max-age=60, s-maxage=86400, stale-if-error=86400"
        );
        assert_eq!(
            Cache::public(minute).shared(day).stale_while_revalidate(minute).stale_if_error(day).header(),
            "public, max-age=60, s-maxage=86400, stale-while-revalidate=60, stale-if-error=86400",
            "neither stale window drops a shared age set before it"
        );
        assert_eq!(Cache::public(minute).stale_if_error(Duration::ZERO).header(), "public, max-age=60", "0 is left out");
        assert_eq!(Cache::no_store().stale_if_error(day).header(), "no-store");
        assert_eq!(Cache::immutable().stale_if_error(day).header(), "public, max-age=31536000, immutable");
    }

    #[test]
    fn a_response_is_shared_only_when_nothing_makes_it_personal() {
        const PUBLIC: &str = "public, max-age=60, s-maxage=600, stale-while-revalidate=30";
        let public = Some(PUBLIC);
        assert_eq!(settled(None, false, seen(), false), "private, no-cache", "the default");
        assert_eq!(settled(public, true, seen(), false), PUBLIC);
        let partial = Seen { partial: true, ..seen() };
        assert_eq!(settled(public, true, partial, false), "private, max-age=60, stale-while-revalidate=30");
        assert_eq!(settled(Some("max-age=60"), true, Seen { partial: true, ..seen() }, false), "private, max-age=60");
        assert_eq!(settled(public, true, Seen { credentials: true, ..seen() }, false), "private, no-cache");
        for seen in [Seen { credentials: true, ..seen() }, Seen { partial: true, ..seen() }] {
            assert_eq!(settled(public, false, seen, false), PUBLIC, "Corten's own header (a file's) is its choice");
        }
        for typed in [true, false] {
            assert_eq!(settled(public, typed, Seen { caller: true, ..seen() }, false), "private, no-cache", "it read a caller");
        }
        for typed in [true, false] {
            assert_eq!(settled(public, typed, Seen { nonce: true, ..seen() }, false), "private, no-cache");
            assert_eq!(settled(public, typed, Seen { nonce: true, dev: true, ..seen() }, false), "private, no-cache");
            assert_eq!(settled(public, typed, seen(), true), "private, no-cache", "it sets a cookie");
        }
        assert_eq!(settled(Some("Private, max-age=60"), true, Seen { nonce: true, ..seen() }, true), "Private, max-age=60");
        assert_eq!(settled(Some("no-store"), true, Seen { caller: true, ..seen() }, true), "no-store");
    }

    /// A page that drew a submit key for this request ([`Unrepeatable`]) is the browser's alone
    /// and asked about again, whoever set its header; a plain `private` stands, and a `no-store`
    /// goes out `private, no-store`, since some CDNs keep an answer that says only `no-store`.
    #[test]
    fn an_answer_that_drew_a_submit_key_is_not_shared() {
        let drawn = |cache: Option<Cache>, lines: &[&'static str], seen: Seen| {
            let mut res = "x".into_response();
            res.extensions_mut().insert(Unrepeatable);
            if let Some(cache) = cache {
                cache.apply(&mut res);
            }
            for line in lines {
                res.headers_mut().append(header::CACHE_CONTROL, HeaderValue::from_static(line));
            }
            settle(&mut res, seen, "/x");
            let lines: Vec<_> =
                res.headers().get_all(header::CACHE_CONTROL).iter().map(|v| v.to_str().unwrap().to_string()).collect();
            lines.join(" | ")
        };
        let minute = Duration::from_secs(60);
        for (partial, dev) in [(false, false), (true, false), (false, true)] {
            let asked = || Seen { partial, dev, ..seen() };
            assert_eq!(drawn(Some(Cache::public(minute).shared(minute * 60)), &[], asked()), "private, no-cache");
            assert_eq!(drawn(Some(Cache::immutable()), &[], asked()), "private, no-cache", "its URL does not name a new key");
            assert_eq!(drawn(None, &["public, max-age=60"], asked()), "private, no-cache", "a header written by hand");
        }
        assert_eq!(drawn(None, &[], seen()), "private, no-cache", "the default");
        assert_eq!(drawn(None, &["private, max-age=60"], seen()), "private, max-age=60", "the app's own choice");
        assert_eq!(drawn(None, &["private, no-store"], seen()), "private, no-store", "already private");
        // Every way a `no-store` goes out keeps the browser out and says `private` to a CDN.
        assert_eq!(drawn(Some(Cache::no_store()), &[], seen()), "private, no-store", "NoStore");
        assert_eq!(drawn(None, &["no-store"], seen()), "private, no-store", "written by hand");
        assert_eq!(drawn(None, &["no-store", "max-age=0"], seen()), "private, no-store", "on two lines");
        assert_eq!(drawn(None, &["no-store, community=\"x\""], seen()), "private, no-store", "beside a quoted value");
        assert_eq!(drawn(None, &["no-store, must-understand"], seen()), "private, no-store", "beside must-understand");
        assert_eq!(drawn(None, &["public, no-store"], seen()), "private, no-store", "beside public");
        assert_eq!(drawn(None, &["no-store"], Seen { caller: true, ..seen() }), "private, no-store", "and a caller read");
    }

    #[test]
    fn a_shared_lifetime_is_only_for_shared_caches() {
        let send = |seen: Seen| {
            let cache = Cache::public(Duration::from_secs(60)).shared(Duration::from_secs(86_400));
            let mut res = (cache, "x").into_response();
            settle(&mut res, seen, "/x");
            res.headers()[header::CACHE_CONTROL].to_str().unwrap().to_string()
        };
        assert_eq!(send(seen()), "public, max-age=60, s-maxage=86400");
        assert_eq!(send(Seen { partial: true, ..seen() }), "private, max-age=60", "the browser's lifetime only");
        let stale =
            Cache::public(Duration::from_secs(60)).shared(Duration::from_secs(600)).stale_if_error(Duration::from_secs(3600));
        let mut res = (stale, "x").into_response();
        settle(&mut res, Seen { partial: true, ..seen() }, "/x");
        assert_eq!(
            res.headers()[header::CACHE_CONTROL],
            "private, max-age=60, stale-if-error=3600",
            "the browser's cache may use it too"
        );
        for seen in [Seen { credentials: true, ..seen() }, Seen { caller: true, ..seen() }, Seen { nonce: true, ..seen() }] {
            assert_eq!(send(seen), "private, no-cache");
        }
    }

    #[test]
    fn a_response_that_keeps_a_lifetime_varies_on_the_cookie() {
        let vary = |seen: Seen| {
            let mut res = (Cache::public(Duration::from_secs(60)), "x").into_response();
            settle(&mut res, seen, "/x");
            res.headers().get_all(header::VARY).iter().any(|v| v == "cookie")
        };
        assert!(vary(seen()) && vary(Seen { partial: true, ..seen() }));
        assert!(!vary(Seen { credentials: true, ..seen() }), "no-cache: nothing to reuse");
    }
}
