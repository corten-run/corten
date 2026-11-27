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
//! `corten dev` logs the first three. Such an answer, and a `Public` answer to a request with
//! credentials, is personal: whatever its `Cache-Control` says (none, `private`, `no-store`), it
//! also loses the caching headers a CDN reads first, by name ([`CDN_CACHING`]:
//! `CDN-Cache-Control`, `Surrogate-Control`, ...), and a `no-store` on it goes out
//! `private, no-store`, for a CDN that ignores a bare one. A `NoStore` answer says
//! `private, no-store` itself, and goes out so whatever a middleware made of its header since (the
//! error page that replaces a failure it returns too); it and a `Public` one sent as the browser's
//! alone (below, `private, no-store` where its header names `no-store`) lose those headers as
//! well, and so does the error page for a failure no handler answered (a request refused before
//! the handler ran, a panic, the deadline, the router's own `404`, `405` or `501`), which is
//! private whatever it said, as is such a refusal in any other form it goes out in (a redirect, a
//! relayed failure, a sign-in, the failure as it is or as JSON), and a [`crate::Refused`] in every
//! form, whoever returned it. A [`crate::live`] stream's fragments are text rendered after its
//! headers went out, so they carry no such mark.
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

    fn header(self) -> HeaderValue {
        let (max_age, shared, stale, if_error) = match self.kind {
            Kind::Public { max_age, shared, stale, if_error } => (max_age, shared, stale, if_error),
            // `private` too: some CDNs keep an answer that says only `no-store`.
            Kind::NoStore => return PRIVATE_NO_STORE,
            Kind::Immutable => return crate::assets::IMMUTABLE,
        };
        // Written here and copied into a value of its own length: one allocation, where a vector
        // with room is two (its bytes, and what shares them), and a kept answer holds the room
        // for as long as it is kept (docs/design.md#choice-kept-pages).
        let mut text = [0; LONGEST];
        let mut at = 0;
        let mut push = |name: &str, n: u64| {
            for part in [name.as_bytes(), crate::ascii::digits(n, &mut [0; 20])] {
                text[at..at + part.len()].copy_from_slice(part);
                at += part.len();
            }
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
        HeaderValue::from_bytes(&text[..at]).expect("digits are a valid header")
    }
}

/// The longest `Cache-Control` a [`Cache`] writes: each of its four names with a number of
/// twenty digits, the most a `u64` has.
const LONGEST: usize = "public, max-age=, s-maxage=, stale-while-revalidate=, stale-if-error=".len() + 4 * 20;

impl Cache {
    /// Sets the response's `Cache-Control` to this, as [`settle`] reads it.
    pub(crate) fn apply(self, res: &mut Response) {
        res.headers_mut().insert(header::CACHE_CONTROL, self.header());
        res.extensions_mut().insert(Typed {
            named: self.kind == Kind::Immutable,
            no_store: self.kind == Kind::NoStore,
            lifetime: self.lifetime(),
        });
    }
}

impl IntoResponseParts for Cache {
    type Error = std::convert::Infallible;

    fn into_response_parts(self, mut res: ResponseParts) -> Result<ResponseParts, Self::Error> {
        res.headers_mut().insert(header::CACHE_CONTROL, self.header());
        res.extensions_mut().insert(Typed { named: false, no_store: self.kind == Kind::NoStore, lifetime: self.lifetime() });
        Ok(res)
    }
}

/// Marks a `Cache-Control` that came from [`Cache`], which [`settle`] checks against the request.
/// One extension, not two, since each costs a lookup.
#[derive(Clone, Copy)]
pub(crate) struct Typed {
    /// A [`Cache::immutable`] answer: its URL names it, so the request's cookies do not change it.
    named: bool,
    /// A [`Cache::no_store`] answer: no cache, and so no CDN, may keep it.
    no_store: bool,
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

    /// Whether `res` is a [`crate::NoStore`] answer: the error page that replaces it is marked
    /// again ([`Cache::apply`]), so [`settle`] still holds it to that.
    pub(crate) fn is_no_store(res: &Response) -> bool {
        res.extensions().get::<Typed>().is_some_and(|typed| typed.no_store)
    }

    /// Whether `res` carries a [`Cache`] mark, its own or a kept answer's: [`settle`] holds it to
    /// the mark (a `NoStore` one goes out `private, no-store`, a `Public` one to a request with
    /// credentials is one visitor's) even when a middleware took its header out, so the one pass
    /// ([`crate::security::Applied::ready`]) leaves it to the stages.
    pub(crate) fn marked(res: &Response) -> bool {
        res.extensions().get::<Typed>().is_some() || crate::kept::Kept::typed(res.extensions()).is_some()
    }

    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Typed { named: false, no_store: false, lifetime: 60 }
    }
}

/// The default for what the app renders.
pub(crate) const PRIVATE: HeaderValue = HeaderValue::from_static("private, no-cache");

/// A personal answer that says `no-store`: some CDNs keep an answer that says only `no-store`
/// (Fastly), and none keeps one that says `private`.
pub(crate) const PRIVATE_NO_STORE: HeaderValue = HeaderValue::from_static("private, no-store");

/// The caching headers a CDN or proxy reads before `Cache-Control`, by exact name: RFC 9213's
/// `CDN-Cache-Control`, Cloudflare's and Vercel's own, `Surrogate-Control`, Akamai's `Edge-Control`
/// and nginx's `X-Accel-Expires`. [`settle`] removes them from a personal answer, a `NoStore` one
/// and a `Public` one it sends as the browser's alone, a refused write's page and the error page
/// for a failure no handler answered lose them, an unstaged route's answer that sets a cookie or is
/// `NoStore` loses them and any other `*cache-control`, and a
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

/// Whether `headers` set a cookie other than Corten's removal of a redirect's notice. The first
/// line settles it unless it is that removal: only then are the others read.
fn sets_cookie(headers: &HeaderMap) -> bool {
    let set = |cookie: &HeaderValue| !NOTICE_GONE.iter().any(|gone| cookie.as_bytes().starts_with(gone));
    match headers.get(header::SET_COOKIE) {
        None => false,
        Some(first) if set(first) => true,
        Some(_) => headers.get_all(header::SET_COOKIE).iter().skip(1).any(set),
    }
}

/// Sets the response's `Cache-Control`: the default when it has none, and a private one instead
/// of a shared one when the response may differ between users. An answer Corten knows is personal
/// (it sets a cookie, has the nonce, drew a submit key, read a caller, is a [`Cache`] answer to a
/// request with credentials, or another Corten app marked it [`Personal`]), one
/// [`crate::NoStore`] keeps out of every cache, and a page route's
/// [`Cache`] answer asked for as anything but its full document also lose the caching headers a
/// CDN reads first ([`CDN_CACHING`]), whatever its `Cache-Control` says, and a `NoStore` one goes
/// out `private, no-store` whatever a middleware made of its header.
pub(crate) fn settle(res: &mut Response, seen: Seen, path: &str) {
    // An answer marked as no handler's own ([`Unshared`]): never shared, whatever it says and
    // whatever status it goes out with. The usual answer has no extensions, so this is a null check.
    if res.extensions().get::<Unshared>().is_some() {
        settle_unshared(res);
        return;
    }
    // A page that drew a submit key ([`Unrepeatable`]) is the browser's alone, whatever its
    // `Cache-Control` says: a CDN reads its own header first, so none of those Corten names stays.
    let drew_key = res.extensions().get::<Unrepeatable>().is_some();
    if drew_key {
        drop_cdn_caching(res.headers_mut());
    }
    // Another Corten app settled it as one visitor's ([`Personal`]) and a middleware here relays
    // it: it is that visitor's still, as if this request had read the caller.
    let marked = res.extensions().get::<Personal>().is_some();
    let caller = seen.caller || marked;
    // The directives of every line count, as HTTP joins them (a second line is rare: only a header
    // written by hand has one). Only a plain `private` makes the answer private:
    // `private="set-cookie"` still lets a shared cache keep the rest. A `no-store` or `private` is
    // trusted as written only when every reader sees it alike: one line of plain text with no
    // quoted value. Otherwise a `no-store` goes out as one line of plain text (the lines joined, or
    // `no-store` alone beside a quoted value or a byte that is not text), and such a `private` is
    // not trusted (an answer that sets a cookie or read a caller is still made private below).
    // With `must-understand`, a cache that knows the status may ignore `no-store` (RFC 9111
    // 5.2.2.3), `must-understand` with or without a value: the header is left as written unless the
    // answer is personal, and a `private` beside them is not trusted.
    let (mut no_store, mut is_private, mut must_understand) = (false, false, false);
    let (mut lines, mut quoted, mut text) = (0, false, true);
    // A kept answer given again carries its mark with what was kept, not as an extension.
    let typed = res.extensions().get::<Typed>().copied().or_else(|| crate::kept::Kept::typed(res.extensions()));
    // For a partial (below), whether any reader could find a `no-store` in its header
    // (`no-store=1`, beside `must-understand`), read with the rest rather than looked up again.
    let mut mentioned = false;
    match res.headers_mut().entry(header::CACHE_CONTROL) {
        header::Entry::Vacant(entry) => {
            entry.insert(PRIVATE);
            // The usual response says nothing and has no [`Cache`] mark: private already, and one
            // Corten knows is personal loses the CDN's own headers too, for two flags and one
            // lookup. A marked one whose header a middleware took out is settled below as one that
            // says `private, no-cache`.
            if typed.is_none() {
                // `caller` first: a marked answer needs no look for its cookie.
                let personal = caller || seen.nonce || sets_cookie(res.headers());
                if !drew_key && personal {
                    drop_cdn_caching(res.headers_mut());
                }
                if !marked && personal {
                    res.extensions_mut().insert(Personal);
                }
                return;
            }
            (is_private, lines) = (true, 1);
        }
        // Corten's own default alone on an answer with no [`Cache`] mark, as the error page for a
        // failure no handler answered already has it: a plain `private`, without reading its
        // directives.
        header::Entry::Occupied(entry) if typed.is_none() && entry.get() == PRIVATE && entry.iter().nth(1).is_none() => {
            (is_private, lines) = (true, 1);
        }
        header::Entry::Occupied(entry) => {
            for line in entry.iter() {
                let says = says(line.as_bytes());
                no_store |= says.no_store;
                is_private |= says.private;
                must_understand |= says.must_understand;
                lines += 1;
                quoted |= line.as_bytes().contains(&b'"');
                text &= line.to_str().is_ok();
                if seen.partial {
                    mentioned |= mentions_no_store(line.as_bytes());
                }
            }
        }
    }
    let plain = lines == 1 && !quoted && text;
    let cookie = !seen.nonce && sets_cookie(res.headers());
    let bug = if seen.nonce {
        Some("its HTML has this request's CSP nonce (req.nonce() in the layout, or a handler that takes Nonce)")
    } else if cookie {
        Some("it sets a cookie")
    } else if drew_key {
        // The mark that keeps its tag off and the app from keeping it: each visitor needs a key
        // of their own, and the browser one it has not sent.
        Some("it draws a form's new submit key (SubmitKey::field), and each visitor needs a key of their own")
    } else {
        None
    };
    // The answer is this visitor's, whoever set its header.
    let asked_by = typed.is_some_and(|typed| seen.credentials && !typed.named);
    let personal = bug.is_some() || caller || asked_by;
    // What makes it personal goes on it as a mark, for an app that relays it inline: a middleware
    // there may take its cookie off and keep the rest (a key it drew is marked already).
    if !marked && (seen.nonce || cookie || seen.caller || asked_by) {
        res.extensions_mut().insert(Personal);
    }
    // `NoStore`, whatever a middleware made of its header since.
    let kept_out = typed.is_some_and(|typed| typed.no_store);
    // A page route's answer asked for as anything but its full document is the browser's alone:
    // a CDN that read its own header would keep this form at the page's URL.
    let partial = seen.partial && typed.is_some();
    let headers = res.headers_mut();
    // A CDN reads its own caching header before `Cache-Control`, so none of those Corten names stays
    // on any of these, whatever `Cache-Control` says (a page that drew a key lost them above).
    if !drew_key && (personal || kept_out || partial) {
        drop_cdn_caching(headers);
    }
    if kept_out {
        // As `NoStore` writes it: `private` too, for a CDN that ignores a bare `no-store`.
        headers.insert(header::CACHE_CONTROL, PRIVATE_NO_STORE);
        return;
    }
    if no_store && !must_understand {
        // A personal answer, and one sent as the browser's alone, says `private` too, for a CDN
        // that ignores `no-store`.
        if (personal || partial) && !(is_private && plain) {
            headers.insert(header::CACHE_CONTROL, PRIVATE_NO_STORE);
        } else if quoted || !text {
            headers.insert(header::CACHE_CONTROL, NO_STORE);
        } else if lines > 1 {
            let mut joined = Vec::new();
            for line in headers.get_all(header::CACHE_CONTROL) {
                if !joined.is_empty() {
                    joined.extend_from_slice(b", ");
                }
                joined.extend_from_slice(line.as_bytes());
            }
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_bytes(&joined).unwrap_or(NO_STORE));
        }
        return;
    }
    // With `must-understand`, a `no-store` any reader could find (`no-store=1` too) is one a cache
    // that knows the status may ignore, and a partial keeps any such `no-store` (below): `private`
    // alone does not keep the browser out.
    if is_private
        && plain
        && !(if partial {
            mentioned
        } else {
            must_understand && headers.get_all(header::CACHE_CONTROL).iter().any(|line| mentions_no_store(line.as_bytes()))
        })
    {
        return;
    }
    if let Some(bug) = bug {
        if seen.dev {
            tracing::warn!("corten: {path} is marked for shared caches, but {bug}, so it was sent private, no-cache (or no-store, if its header names it)");
        }
    }
    if personal {
        // `private, no-store` if any reader could find a `no-store` in it (`no-store=1`, inside a
        // quoted value, with `must-understand`): stricter than `private, no-cache` for every
        // reading, and `private` for a CDN that ignores `no-store`.
        let no_store = headers.get_all(header::CACHE_CONTROL).iter().any(|line| mentions_no_store(line.as_bytes()));
        headers.insert(header::CACHE_CONTROL, if no_store { PRIVATE_NO_STORE } else { PRIVATE });
        return;
    }
    let Some(typed) = typed else { return };
    if seen.partial {
        // A `no-store` any reader could find (`no-store=1`, beside `must-understand`) is kept,
        // with `private` for a CDN that ignores a bare one; otherwise the same lifetime.
        if mentioned {
            headers.insert(header::CACHE_CONTROL, PRIVATE_NO_STORE);
            return;
        }
        // The first line's lifetime, in place of every line, through one lookup.
        if let header::Entry::Occupied(mut entry) = headers.entry(header::CACHE_CONTROL) {
            let browser = private(entry.get().to_str().unwrap_or(""));
            entry.insert(browser);
        }
    }
    if !typed.named {
        headers.append(header::VARY, HeaderValue::from_static("cookie"));
    }
}

/// The mark of an answer [`settle`] found to be one visitor's: it sets a cookie, read a caller,
/// has this request's nonce, or is a [`Cache`] answer to a request with credentials ([`Seen`]); an
/// unstaged route's answer that sets a cookie (`unstaged_headers` in `route.rs`); or the MCP
/// endpoint made it for a caller its check found (`personal`). A submit key it drew is
/// marked already ([`Unrepeatable`]). Put on as the answer is settled, it stays on the answer as
/// [`Unshared`] does: another Corten app whose staged middleware relays it inline, as it is or
/// changed in place (its cookie taken off included), settles it as personal too ([`settle`]),
/// though that app's own request read no caller, so a middleware there cannot give it a CDN's
/// lifetime. An answer made in its place is its own, and an answer nothing made personal is not
/// marked. Only in process: an app that relays it over HTTP sees its headers alone.
#[derive(Clone, Copy)]
pub(crate) struct Personal;

/// `res`, made for one caller (the MCP endpoint's answer to a caller its check found, or any answer
/// its endpoint-wide check let through), marked [`Personal`]: settled as one visitor's here and by
/// an app that relays it inline.
#[cfg(feature = "agent")]
pub(crate) fn personal(mut res: Response) -> Response {
    res.extensions_mut().insert(Personal);
    res
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

/// The mark of an answer that is no handler's own: every failure or refusal Corten makes itself,
/// rather than one a handler chose to answer with, and the page, redirect or plain text Corten draws
/// in the place of one. It is put on as the answer is made, by one of three constructors:
/// [`crate::Error::corten`] for a failure made as an error (an extractor's, a protocol's, a debug
/// build's error about the app's code, a body that cannot be read), [`unshared`] for one made as a
/// response (the router's `404`, `405`, `501` and named post's `400`, a typed [`crate::Refused`]
/// whoever returned it, a panic or a passed deadline, a static file the version lacks), and
/// [`unshared_in_place_of`] for one sent in the place of an answer Corten could not send (a page
/// it could not fill or keep, a debug build's diagnostic), which keeps that answer's `NoStore`. A
/// typed rejection ([`crate::extract::BodyRejection`], the form's and the path's) marks itself as
/// it becomes a response, and every extractor's rejection is marked where the handler or the error
/// page meets it too. The audit of these places is in #1890; `tests::cache` checks each one and
/// holds the crate's source to the constructors. Such an answer may be about who is asking (the
/// error page can read the request's `Cookie` and `Authorization` without reading a caller), so it
/// is never shared, in whatever form and with whatever status it goes out ([`settle`]). The mark
/// stays on the answer: a middleware that changes the answer in place (its status, headers or
/// body) keeps it, another Corten app that relays the answer inline settles it the same way, and
/// an answer a middleware builds in its place is its own. A handler's own failure (its `404`, an
/// `Error` it made) is its answer, and the error page in its place takes only its marks
/// ([`Marks`]).
#[derive(Clone, Copy)]
pub(crate) struct Unshared;

/// `res`, a failure or refusal Corten made itself, marked [`Unshared`].
#[cold]
pub(crate) fn unshared(mut res: Response) -> Response {
    res.extensions_mut().insert(Unshared);
    res
}

/// `failed`, a failure Corten sends in the place of the answer whose extensions are `answer`, which
/// it could not send as it was (a page it could not fill or keep, a debug build's diagnostic):
/// marked [`Unshared`] whatever that answer was, and a `NoStore` one's replacement is `NoStore` too
/// ([`Marks`]), whatever a middleware then makes of its headers.
#[cold]
pub(crate) fn unshared_in_place_of(answer: &http::Extensions, mut failed: Response) -> Response {
    Marks { unshared: true, ..Marks::of(answer) }.put(&mut failed);
    failed
}

/// What an answer's replacement keeps of it, read from the answer it replaces: that it is no
/// handler's own ([`Unshared`]) and that it is a [`crate::NoStore`] answer. The error page in a
/// failure's place, the plain text in a failed error page's, and a debug build's diagnostic in an
/// answer's each read them with [`Marks::of`] and put them on what they send ([`Marks::put`]), so
/// [`settle`] holds the replacement to what held the answer, whatever a middleware made of its
/// headers.
#[derive(Clone, Copy)]
#[must_use = "put the marks on the answer that replaces the one they were read from"]
pub(crate) struct Marks {
    pub(crate) unshared: bool,
    pub(crate) no_store: bool,
}

impl Marks {
    /// The marks of the answer whose extensions are `answer`.
    #[inline]
    pub(crate) fn of(answer: &http::Extensions) -> Self {
        Marks {
            unshared: answer.get::<Unshared>().is_some(),
            no_store: answer.get::<Typed>().is_some_and(|typed| typed.no_store),
        }
    }

    /// Puts the marks on `res`, the answer that replaces the one they were read from: [`Unshared`],
    /// and a `NoStore` one's `Cache-Control` and its mark ([`Cache::apply`]).
    #[inline]
    pub(crate) fn put(self, res: &mut Response) {
        if self.unshared {
            res.extensions_mut().insert(Unshared);
        }
        if self.no_store {
            Cache::no_store().apply(res);
        }
    }
}

/// Settles an [`Unshared`] answer: the default, whatever it said, and none of the CDN caching
/// headers written on it. One that names `no-store`, or is a `NoStore` answer whatever a
/// middleware made of its header, goes out `private, no-store`, as [`settle`] gives a personal one.
#[cold]
fn settle_unshared(res: &mut Response) {
    let kept_out = Typed::is_no_store(res);
    let headers = res.headers_mut();
    drop_cdn_caching(headers);
    let no_store = kept_out || headers.get_all(header::CACHE_CONTROL).iter().any(|line| mentions_no_store(line.as_bytes()));
    headers.insert(header::CACHE_CONTROL, if no_store { PRIVATE_NO_STORE } else { PRIVATE });
}

/// Marks and settles a refused write's answer, which goes out without [`settle`], as `settle` does
/// an [`Unshared`] one: an app that relays it inline settles it the same way.
pub(crate) fn settle_refused(res: &mut Response) {
    res.extensions_mut().insert(Unshared);
    settle_unshared(res);
}

/// The empty answer sent in place of one whose exact-size body failed as it was read after the
/// cache rules ran ([`settle`]): to be tagged ([`tag`]) or compressed. It is Corten's, not the
/// handler's, and nothing it says is the answer's: marked [`Unshared`] and settled here, since no
/// stage after this one settles it, `private, no-store` (an empty answer no cache may keep in place
/// of the page), with none of the caching headers a CDN reads first, and without the answer's
/// validators or length, which were about the body it does not have. Its status is the answer's.
/// It is a [`crate::NoStore`] answer too ([`Marks`]), so an app that relays it inline and rewrites
/// its `Cache-Control` still sends it `private, no-store`.
#[cold]
pub(crate) fn unread(mut parts: http::response::Parts) -> Response {
    for name in [header::ETAG, header::LAST_MODIFIED, header::CONTENT_LENGTH, header::CONTENT_ENCODING, header::CONTENT_RANGE] {
        parts.headers.remove(name);
    }
    let mut res = Response::from_parts(parts, Body::empty());
    drop_cdn_caching(res.headers_mut());
    Marks { unshared: true, no_store: true }.put(&mut res);
    res
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
///
/// `given` is what the answer's scope's lines say of themselves ([`BesideATag`]) when it was
/// given them in one pass ([`crate::security::Applied::ready`]): it brought its `Content-Type` at
/// most, and every other line it has is one of those. Where none of them leaves an answer
/// untagged or is part of a tag, its lines are not searched for one that does and its tag is made
/// from its type alone: the answer and the tag the search would give. Any other answer is
/// searched. It is handed over where the scope keeps it, not copied: with the byte itself for an
/// argument the search's lookup of `Cache-Control` was a call again and a compressed page's
/// request counted 55 instructions more (`bench/request-cost`, `page-browser`, at `dd17a6e8c`),
/// which is why [`untagged`] is kept in line.
pub(crate) async fn tag(res: Response, has: &[HeaderValue], given: Option<&BesideATag>) -> Response {
    let ready = given.is_some_and(|lines| lines.0);
    if res.status() != StatusCode::OK
        || (!ready && untagged(res.headers()))
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
        return unread(parts);
    };
    // A kept answer's body is read once, for its first tag.
    let tag = tagged(crate::kept::Kept::hashed(&parts.extensions, &bytes, &*TAG_KEY), &parts.headers, ready);
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
    tagged(crate::kept::Kept::hashed(&http::Extensions::new(), &body, &*TAG_KEY), headers, false)
}

/// Whether a header line of an answer leaves it without a tag ([`tag`]): a tag or an encoding of
/// its own, a part of a body, or a `Cache-Control` that keeps it out of every cache or says it
/// never changes. In line in [`tag`], which asks it of every answer whose lines it searches: as a
/// function `tag` called, the lookup of `Cache-Control` became a call inside it and a compressed
/// page's request (`bench/request-cost`, `page-browser`) counted more than with it in line.
#[inline(always)]
fn untagged(headers: &HeaderMap) -> bool {
    headers.contains_key(header::ETAG)
        || headers.contains_key(header::CONTENT_ENCODING)
        || headers.contains_key(header::CONTENT_RANGE)
        || headers.get_all(header::CACHE_CONTROL).iter().any(|line| {
            // The default says neither, and most answers have it: it is compared, not searched.
            // An immutable answer is never asked about again.
            *line != PRIVATE
                && (mentions_no_store(line.as_bytes())
                    || directives(line.as_bytes()).any(|d| d.trim_ascii().eq_ignore_ascii_case(b"immutable")))
        })
}

/// Whether a header line of this name is part of an answer's tag ([`tagged`]).
fn counts(name: &header::HeaderName) -> bool {
    name == header::CONTENT_TYPE || name.as_str().starts_with("corten-")
}

/// Whether a scope's lines ([`crate::security::Applied::lines`]) are beside the tag of an answer
/// they are given to: none leaves it untagged ([`untagged`]) and none is part of its tag
/// ([`counts`]). Made only by [`BesideATag::of`], from the lines it is given and by the two tests
/// [`tag`] makes of an answer's lines, once for each scope when the router is built: so it is
/// true to the lines it is given whatever a later change makes them (that they are the scope's
/// own is `Scopes::new`'s, which makes both in one closure), and it is what lets `tag` make
/// neither test of an answer whose other lines are its scope's. No line a scope has today does
/// either, so it holds of every scope; where a line comes to, its scope's answers are searched
/// as any other's.
#[derive(Clone, Copy)]
pub(crate) struct BesideATag(bool);

impl BesideATag {
    pub(crate) fn of(lines: &HeaderMap) -> Self {
        BesideATag(!untagged(lines) && !lines.keys().any(counts))
    }

    #[cfg(test)]
    pub(crate) fn holds(self) -> bool {
        self.0
    }
}

/// The tag from `hasher`, which has read the body with its length
/// ([`crate::kept::Kept::hashed`]), and the headers that count, in the order the answer has them:
/// found among all of them, or, for an answer whose other lines are beside a tag (`ready`,
/// [`tag`]), its `Content-Type` alone, the one line of such an answer that can count.
fn tagged(mut hasher: std::hash::DefaultHasher, headers: &HeaderMap, ready: bool) -> [u8; 20] {
    use std::hash::Hasher;
    let mut line = |name: &header::HeaderName, value: &HeaderValue| {
        hasher.write_usize(name.as_str().len());
        hasher.write(name.as_str().as_bytes());
        hasher.write_usize(value.len());
        hasher.write(value.as_bytes());
    };
    if ready {
        if let Some(kind) = headers.get(header::CONTENT_TYPE) {
            line(&header::CONTENT_TYPE, kind);
        }
    } else {
        for (name, value) in headers {
            if counts(name) {
                line(name, value);
            }
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
    // Only where an `n` is: most lines have few.
    memchr::memchr2_iter(b'n', b'N', line).any(|at| line.get(at..at + 8).is_some_and(|w| w.eq_ignore_ascii_case(b"no-store")))
}

/// A bare `Cache-Control: no-store`: what a hand-written header that names `no-store` goes out as
/// where a reader could take it another way (a quoted value, a byte that is not text), and what the
/// error page in place of a handler's own failure that said `no-store` carries. `NoStore` writes
/// [`PRIVATE_NO_STORE`], as a personal answer that names `no-store` goes out.
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

    /// [`tag`] compares a `Cache-Control` line with the default before it searches the line for
    /// what would leave the answer untagged: the default says neither.
    #[test]
    fn the_default_cache_control_says_nothing_that_leaves_an_answer_untagged() {
        let line = PRIVATE;
        let line = line.as_bytes();
        assert!(!mentions_no_store(line));
        assert!(!directives(line).any(|d| d.trim_ascii().eq_ignore_ascii_case(b"immutable")));
    }

    #[test]
    fn the_quick_no_store_search_agrees_with_the_plain_one() {
        for line in [
            "no-store",
            "No-Store",
            "private, no-store=1",
            "private, NO-STOREx",
            "nnno-store",
            "private, no-cache",
            "no-stor",
            "n",
            "",
            "public, max-age=60, no-cache=\"no-store\"",
        ] {
            let plain = line.as_bytes().windows(8).any(|w| w.eq_ignore_ascii_case(b"no-store"));
            assert_eq!(mentions_no_store(line.as_bytes()), plain, "{line}");
        }
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
            res.extensions_mut().insert(Typed::for_test());
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

    #[test]
    fn the_header_says_what_was_asked() {
        let minute = Duration::from_secs(60);
        assert_eq!(Cache::public(minute).header(), "public, max-age=60");
        assert_eq!(
            Cache::public(minute).stale_while_revalidate(Duration::from_secs(600)).header(),
            "public, max-age=60, stale-while-revalidate=600"
        );
        assert_eq!(Cache::public(Duration::from_millis(1500)).header(), "public, max-age=1", "whole seconds");
        assert_eq!(Cache::no_store().stale_while_revalidate(minute).header(), "private, no-store");
        let day = Duration::from_secs(86_400);
        assert_eq!(Cache::public(minute).shared(day).header(), "public, max-age=60, s-maxage=86400");
        assert_eq!(
            Cache::public(minute).stale_while_revalidate(Duration::from_secs(3600)).shared(day).header(),
            "public, max-age=60, s-maxage=86400, stale-while-revalidate=3600",
            "in either order"
        );
        assert_eq!(Cache::no_store().shared(day).header(), "private, no-store");
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
        assert_eq!(Cache::no_store().stale_if_error(day).header(), "private, no-store");
        assert_eq!(Cache::immutable().stale_if_error(day).header(), "public, max-age=31536000, immutable");
        // The longest it writes, every number twenty digits, fills what it is written in.
        let most = Duration::from_secs(u64::MAX);
        let longest = Cache::public(most).shared(most).stale_while_revalidate(most).stale_if_error(most).header();
        let n = u64::MAX;
        let text = format!("public, max-age={n}, s-maxage={n}, stale-while-revalidate={n}, stale-if-error={n}");
        assert_eq!((longest.to_str().ok(), text.len()), (Some(text.as_str()), LONGEST));
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
        assert_eq!(settled(Some("no-store"), true, Seen { caller: true, ..seen() }, true), "private, no-store");
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
